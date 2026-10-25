#include "engine/renderer/frame_gpu_timer.h"
#include "traa.h"
#include "engine/renderer/pipeline_cache.h"
#include "engine/foundation/math/Matrix.h"
#include "mystral/webgpu_compat.h"
#include <algorithm>
#include <cstring>
#include <cmath>
#include <stdexcept>
#include <iomanip>
#include <sstream>

namespace tn::engine {
namespace {
TraaPass::Matrix inverse(const TraaPass::Matrix& a) {
    Matrix4 x; x.elements = a; x.invert(); return x.elements;
}
WGPUTextureView view(WGPUTexture texture) { return wgpuTextureCreateView(texture, nullptr); }
}

void TraaPass::enableDebugDump() {
    debugDump_ = std::make_unique<DebugDump>();
}

void TraaPass::stageDebugTexture(WGPUCommandEncoder encoder, WGPUTexture texture, const char* name) {
    if (!debugDump_ || history_.frame() < 18 || history_.frame() > 23) return;
    if (wgpuTextureGetFormat(texture) != WGPUTextureFormat_RGBA16Float)
        throw std::runtime_error("TN_TRAA_DUMP_FORMAT_INVALID");
    const auto width = wgpuTextureGetWidth(texture), height = wgpuTextureGetHeight(texture);
    const uint32_t pitch = (width * 8 + 255u) & ~255u;
    const uint64_t size = uint64_t(pitch) * height;
    WGPUBufferDescriptor desc{};
    desc.size = size; desc.usage = WGPUBufferUsage_CopyDst | WGPUBufferUsage_MapRead;
    auto buffer = wgpuDeviceCreateBuffer(device_, &desc);
    if (!buffer) throw std::runtime_error("TN_TRAA_DUMP_BUFFER_FAILED");
    debugDump_->pending.push_back({buffer, name, pitch, size, width, height});
    WGPUImageCopyTexture_Compat source{}; source.texture = texture; source.aspect = WGPUTextureAspect_All;
    WGPUImageCopyBuffer_Compat destination{}; destination.buffer = buffer;
    destination.layout.bytesPerRow = pitch; destination.layout.rowsPerImage = height;
    const WGPUExtent3D extent{width, height, 1};
    wgpuCommandEncoderCopyTextureToBuffer(encoder, &source, &destination, &extent);
}

shader::OutputPrograms traaVelocityPrograms() {
    shader::OutputPrograms out;
    using shader::Type;
    auto& v = out.vertex;
    const auto p = v.construct(Type::vec(4), {v.attribute("position", Type::vec(3)), v.constant(1.f)});
    const auto model = v.uniform("modelMatrix", Type::mat(4, 4));
    const auto view = v.uniform("viewMatrix", Type::mat(4, 4));
    const auto local = v.mul(view, v.mul(model, p));
    v.output("position", v.mul(v.uniform("projectionMatrix", Type::mat(4, 4)), local));
    v.output("currentClip", v.mul(v.mul(v.uniform("unjitteredProjection", Type::mat(4, 4)), v.mul(view, model)), p));
    const auto previousModelView = v.mul(v.uniform("previousView", Type::mat(4, 4)),
                                         v.uniform("previousModel", Type::mat(4, 4)));
    v.output("previousClip", v.mul(v.mul(v.uniform("previousProjection", Type::mat(4, 4)), previousModelView), p));
    auto& f = out.fragment;
    const auto current = f.varying("currentClip", Type::vec(4));
    const auto previous = f.varying("previousClip", Type::vec(4));
    f.output("color", f.construct(Type::vec(4), {
        f.sub(f.div(f.swizzle(current, "xy"), f.swizzle(current, "w")),
              f.div(f.swizzle(previous, "xy"), f.swizzle(previous, "w"))), f.constant(0.f), f.constant(1.f)}));
    return out;
}

// Direct operation-for-operation translation of TRAANode.setup(), default WebGPU depth (0..1).
// Out-of-image loads: depth reads zero, as upstream; a beauty neighbour reads (0, 0, 0, 1), which
// is what the browser returns there (WGSL leaves it implementation-defined; measured with TN_TRAA_DUMP).
const char* traaResolveWgsl() { return R"WGSL(
struct Params {
    inverseProjection: mat4x4<f32>, previousInverseProjection: mat4x4<f32>,
    previousWorld: mat4x4<f32>, view: mat4x4<f32>, projection: mat4x4<f32>,
    size: vec2<f32>, depthThreshold: f32, edgeDepthDiff: f32,
    maxVelocityLength: f32, subpixel: f32, count: f32, historyValid: f32,
    jitter: vec2<f32>, previousJitter: vec2<f32>,
}
@group(0) @binding(0) var<uniform> u: Params;
@group(0) @binding(1) var beauty: texture_2d<f32>;
@group(0) @binding(2) var depth: texture_depth_2d;
@group(0) @binding(3) var velocity: texture_2d<f32>;
@group(0) @binding(4) var history: texture_2d<f32>;
@group(0) @binding(5) var previousDepth: texture_depth_2d;
@group(0) @binding(6) var linearSampler: sampler;
// On a counted frame (`u.count`): [0] the pixels whose history was discarded, [1] the pixels whose history was pulled into
// the colour neighbourhood. Other frames never touch it.
@group(0) @binding(7) var<storage, read_write> stats: array<atomic<u32>, 2>;
struct Vertex { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32> }
@vertex fn vs(@builtin(vertex_index) index: u32) -> Vertex {
    var positions = array<vec2<f32>, 3>(vec2(-1, -1), vec2(3, -1), vec2(-1, 3));
    let p = positions[index];
    return Vertex(vec4(p, 0, 1), p * vec2(0.5, -0.5) + 0.5);
}
fn clipAABB(current: vec4<f32>, old: vec4<f32>, low: vec4<f32>, high: vec4<f32>) -> vec4<f32> {
    let center = (high.rgb + low.rgb) * 0.5;
    let extent = (high.rgb - low.rgb) * 0.5 + 1e-7;
    let delta = old - vec4(center, current.a);
    let unit = abs(delta.rgb / extent);
    let largest = max(max(unit.x, unit.y), unit.z);
    if (largest > 1) { return vec4(center, current.a) + delta / largest; }
    return old;
}
@fragment fn fs(input: Vertex) -> @location(0) vec4<f32> {
    let outputSize = vec2<f32>(textureDimensions(history));
    let upsampling = any(outputSize != u.size);
    // Our projection moves the raster by -jitter pixels (UE's TemporalJitterPixels has the opposite sign).
    let currentUV = input.uv - select(vec2<f32>(0), u.jitter / u.size, upsampling);
    let texel = clamp(vec2<i32>(floor(currentUV * u.size)), vec2<i32>(0), vec2<i32>(u.size) - 1);
    var closest = 2.0;
    var farthest = -1.0;
    var closestPosition = vec2<f32>(0);
    for (var x = -1; x <= 1; x++) {
        for (var y = -1; y <= 1; y++) {
            // Upstream adds to the floating pixel centre before converting to integer.
            let neighbor = currentUV * u.size + vec2<f32>(f32(x), f32(y));
            let d = textureLoad(depth, vec2<i32>(neighbor), 0);
            if (d < closest) { closest = d; closestPosition = neighbor; }
            if (d > farthest) { farthest = d; }
        }
    }
    let offset = textureLoad(velocity, vec2<i32>(closestPosition), 0).xy * vec2(0.5, -0.5);
    let historyUV = input.uv - offset;
    // DepthTexture defaults to nearest filtering; the colour history uses bilinear sampling.
    let previousDepthUV = historyUV - select(vec2<f32>(0), u.previousJitter / u.size, upsampling);
    let previousTexel = clamp(vec2<i32>(floor(previousDepthUV * u.size)), vec2<i32>(0), vec2<i32>(u.size) - 1);
    let d = textureLoad(previousDepth, previousTexel, 0);
    let previousClip = vec4(previousDepthUV * vec2(2, -2) + vec2(-1, 1), d, 1);
    let previousPosition = u.previousInverseProjection * previousClip;
    let positionWorld = u.previousWorld * vec4(previousPosition.xyz / previousPosition.w, 1);
    let positionView = u.view * positionWorld;
    // Equivalent to viewZToPerspectiveDepth / viewZToOrthographicDepth for this projection.
    let projected = u.projection * vec4(0, 0, positionView.z, 1);
    let oldDepth = projected.z / projected.w;
    let validUV = all(historyUV >= vec2(0)) && all(historyUV <= vec2(1));
    let edge = farthest - closest > u.edgeDepthDiff;
    let disocclusion = closest - oldDepth > u.depthThreshold;
    let valid = u.historyValid != 0 && validUV && (edge || !disocclusion);
    let counting = u.count != 0;
    if (counting && !valid) { atomicAdd(&stats[0], 1u); }
    var current = textureSampleLevel(beauty, linearSampler, input.uv, 0.0);
    if (upsampling) {
        // UE 5.8.3 TemporalAA.usf:1463-1478: filter nearby input samples in output-pixel units.
        let centre = floor(currentUV * u.size);
        let upscale = outputSize / u.size;
        var sum = vec4<f32>(0);
        var weights = 0.0;
        for (var y = -1; y <= 1; y++) {
            for (var x = -1; x <= 1; x++) {
                let samplePosition = centre + vec2<f32>(f32(x), f32(y));
                let delta = (samplePosition + 0.5 - currentUV * u.size) * upscale;
                let x2 = clamp(dot(delta, delta), 0.0, 1.0);
                let weight = (0.905 * x2 - 1.9) * x2 + 1.0;
                let pixel = clamp(vec2<i32>(samplePosition), vec2<i32>(0), vec2<i32>(u.size) - 1);
                sum += textureLoad(beauty, pixel, 0) * weight;
                weights += weight;
            }
        }
        current = sum / weights;
    }
    let old = textureSampleLevel(history, linearSampler, historyUV, 0.0);
    let motion = clamp(length((input.uv - historyUV) * u.size) / u.maxVelocityLength, 0.0, 1.0);
    var currentWeight = 0.05;
    if (u.subpixel != 0) {
        let phase = abs(fract(offset * u.size));
        let weight = max(phase, 1 - phase);
        currentWeight += (1 - weight.x * weight.y) / 0.75 * 0.25;
    }
    currentWeight = select(1.0, clamp(currentWeight + motion, 0.0, 1.0), valid);
    let gamma = mix(0.5, 1.0, (1 - motion) * (1 - motion));
    var offsets = array<vec2<i32>, 8>(vec2(-1,-1), vec2(-1,1), vec2(1,-1), vec2(1,1),
        vec2(1,0), vec2(0,-1), vec2(0,1), vec2(-1,0));
    let centreSample = select(current, textureLoad(beauty, texel, 0), upsampling);
    var moment1 = centreSample;
    var moment2 = centreSample * centreSample;
    for (var i = 0u; i < 8u; i++) {
        let neighbor = max(select(vec4(0.0, 0.0, 0.0, 1.0), textureLoad(beauty, texel + offsets[i], 0), all(texel + offsets[i] >= vec2<i32>(0)) && all(texel + offsets[i] < vec2<i32>(u.size))), vec4(0.0));
        moment1 += neighbor; moment2 += neighbor * neighbor;
    }
    let mean = moment1 / 9;
    let variance = sqrt(max(moment2 / 9 - mean * mean, vec4(0.0))) * gamma;
    let low = mean - variance;
    let high = mean + variance;
    let clipped = clipAABB(clamp(mean, low, high), old, low, high);
    if (counting && valid && any(clipped.rgb != old.rgb)) { atomicAdd(&stats[1], 1u); }
    let compressedCurrent = current / (max(max(current.r, current.g), current.b) + 1);
    let compressedHistory = clipped / (max(max(clipped.r, clipped.g), clipped.b) + 1);
    let luminance = vec3(0.2126, 0.7152, 0.0722);
    let historyWeight = (1 - currentWeight) / (dot(compressedHistory.rgb, luminance) + 1);
    currentWeight /= dot(compressedCurrent.rgb, luminance) + 1;
    return (current * currentWeight + clipped * historyWeight) / max(currentWeight + historyWeight, 0.00001);
}
)WGSL"; }

// The camera's motion at each pixel: the point the depth buffer holds, in the jittered frame it was rasterised in, seen
// through the unjittered current and previous cameras. The same NDC difference the rigid velocity pass writes, so a
// rigid draw overwriting this target changes nothing but its own pixels. Alpha 1 marks a written velocity.
const char* traaFillWgsl() { return R"WGSL(
struct Fill {
    inverseProjection: mat4x4<f32>, world: mat4x4<f32>, projection: mat4x4<f32>, view: mat4x4<f32>,
    previousView: mat4x4<f32>, previousProjection: mat4x4<f32>, size: vec2<f32>,
}
@group(0) @binding(0) var<uniform> u: Fill;
@group(0) @binding(1) var depth: texture_depth_2d;
struct Vertex { @builtin(position) position: vec4<f32> }
@vertex fn vs(@builtin(vertex_index) index: u32) -> Vertex {
    var positions = array<vec2<f32>, 3>(vec2(-1, -1), vec2(3, -1), vec2(-1, 3));
    return Vertex(vec4(positions[index], 0, 1));
}
@fragment fn fs(input: Vertex) -> @location(0) vec4<f32> {
    let uv = input.position.xy / u.size;
    let clip = vec4(uv.x * 2 - 1, 1 - uv.y * 2, textureLoad(depth, vec2<i32>(input.position.xy), 0), 1);
    let viewPoint = u.inverseProjection * clip;
    let worldPoint = u.world * vec4(viewPoint.xyz / viewPoint.w, 1);
    let current = u.projection * (u.view * worldPoint);
    let previous = u.previousProjection * (u.previousView * worldPoint);
    return vec4(current.xy / current.w - previous.xy / previous.w, 0, 1);
}
)WGSL"; }

TraaPass::TraaPass(WGPUDevice device, WGPUQueue queue, TraaOptions options)
    : device_(device), queue_(queue), options_(options) {
    if (!(options.maxVelocityLength > 0) || !std::isfinite(options.maxVelocityLength) ||
        !std::isfinite(options.depthThreshold) || !std::isfinite(options.edgeDepthDiff))
        throw std::runtime_error("TN_TRAA_OPTIONS_INVALID");
    WGPUBufferDescriptor buffer{};
    buffer.size = 368; buffer.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
    uniforms_ = wgpuDeviceCreateBuffer(device_, &buffer);
    // The counts of a counted frame. A pass whose owner reads them takes `setStatsBuffer`; the rest keep this one.
    buffer.size = 8; buffer.usage = WGPUBufferUsage_Storage | WGPUBufferUsage_CopyDst | WGPUBufferUsage_CopySrc;
    ownStats_ = stats_ = wgpuDeviceCreateBuffer(device_, &buffer);
    buffer.size = 352; buffer.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
    WGPUSamplerDescriptor sampler{};
    sampler.maxAnisotropy = 1;
    sampler.magFilter = sampler.minFilter = WGPUFilterMode_Linear;
    sampler.addressModeU = sampler.addressModeV = sampler.addressModeW = WGPUAddressMode_ClampToEdge;
    sampler_ = wgpuDeviceCreateSampler(device_, &sampler);
    WGPUShaderModuleWGSLDescriptor_Compat wgsl{};
    WGPUShaderModuleDescriptor moduleDesc{};
    setupShaderModuleWGSL(&moduleDesc, &wgsl, traaResolveWgsl());
    auto module = wgpuDeviceCreateShaderModule(device_, &moduleDesc);
    WGPUColorTargetState color{}; color.format = WGPUTextureFormat_RGBA16Float; color.writeMask = WGPUColorWriteMask_All;
    WGPUFragmentState fragment{}; fragment.module = module; WGPU_SET_ENTRY_POINT(fragment, "fs");
    fragment.targetCount = 1; fragment.targets = &color;
    WGPURenderPipelineDescriptor pipeline{};
    pipeline.vertex.module = module; WGPU_SET_ENTRY_POINT(pipeline.vertex, "vs");
    pipeline.fragment = &fragment; pipeline.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    pipeline.multisample.count = 1; pipeline.multisample.mask = 0xffffffffu;
    pipeline_ = wgpuDeviceCreateRenderPipeline(device_, &pipeline);
    wgpuShaderModuleRelease(module);
    if (!pipeline_) throw std::runtime_error("TN_TRAA_PIPELINE_REFUSED");
    buffer.size = 384 + 16;  // six matrices and the frame size, padded to the next 16 bytes
    fillUniforms_ = wgpuDeviceCreateBuffer(device_, &buffer);
    WGPUShaderModuleWGSLDescriptor_Compat fillWgsl{};
    WGPUShaderModuleDescriptor fillDesc{};
    setupShaderModuleWGSL(&fillDesc, &fillWgsl, traaFillWgsl());
    auto fillModule = wgpuDeviceCreateShaderModule(device_, &fillDesc);
    WGPUFragmentState fillFragment{}; fillFragment.module = fillModule; WGPU_SET_ENTRY_POINT(fillFragment, "fs");
    fillFragment.targetCount = 1; fillFragment.targets = &color;
    WGPURenderPipelineDescriptor fillPipeline{};
    fillPipeline.vertex.module = fillModule; WGPU_SET_ENTRY_POINT(fillPipeline.vertex, "vs");
    fillPipeline.fragment = &fillFragment; fillPipeline.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    fillPipeline.multisample.count = 1; fillPipeline.multisample.mask = 0xffffffffu;
    fillPipeline_ = wgpuDeviceCreateRenderPipeline(device_, &fillPipeline);
    wgpuShaderModuleRelease(fillModule);
    if (!fillPipeline_) throw std::runtime_error("TN_TRAA_PIPELINE_REFUSED: camera velocity");
}
TraaPass::~TraaPass() {
    releaseTargets();
    wgpuRenderPipelineRelease(pipeline_); wgpuRenderPipelineRelease(fillPipeline_);
    wgpuBufferRelease(uniforms_); wgpuBufferRelease(fillUniforms_); wgpuBufferRelease(ownStats_);
    wgpuSamplerRelease(sampler_);
}
void TraaPass::releaseTargets() {
    for (auto v : {historyView_, historyDepthView_, resolveView_, velocityView_}) if (v) wgpuTextureViewRelease(v);
    for (auto t : {historyColor_, historyDepth_, resolve_, velocity_}) if (t) wgpuTextureRelease(t);
    historyView_ = historyDepthView_ = resolveView_ = velocityView_ = nullptr;
    historyColor_ = historyDepth_ = resolve_ = velocity_ = nullptr;
}
void TraaPass::resize(uint32_t width, uint32_t height) {
    resize(width, height, width, height);
}
void TraaPass::resize(uint32_t width, uint32_t height, uint32_t outputWidth, uint32_t outputHeight) {
    if (!width || !height || !outputWidth || !outputHeight || width > outputWidth || height > outputHeight ||
        uint64_t(width) * 4 < outputWidth || uint64_t(height) * 4 < outputHeight)
        throw std::runtime_error("TN_TRAA_SIZE_INVALID: expected input/output fractions in [0.25, 1]");
    if (width == width_ && height == height_ && outputWidth == outputWidth_ && outputHeight == outputHeight_) return;
    releaseTargets(); width_ = width; height_ = height;
    outputWidth_ = outputWidth; outputHeight_ = outputHeight;
    history_.resize(0, width, height);
    history_.cameraCut(0); // an output-only resize invalidates colour history too
    // UE 5.8.3 SceneVisibility.cpp:5268-5295; keep r185's 31 samples until density needs more.
    const double upscale = std::max(double(outputWidth) / width, double(outputHeight) / height);
    jitterLength_ = std::max(31u, uint32_t(std::ceil(8.0 * upscale * upscale)));
    for (;;) {
        bool prime = true;
        for (uint32_t divisor = 2; divisor * divisor <= jitterLength_; ++divisor)
            if (jitterLength_ % divisor == 0) { prime = false; break; }
        if (prime) break;
        ++jitterLength_;
    }
    auto texture = [&](WGPUTextureFormat format, bool output) {
        WGPUTextureDescriptor desc{}; desc.dimension = WGPUTextureDimension_2D;
        desc.size = {output ? outputWidth : width, output ? outputHeight : height, 1};
        desc.format = format; desc.mipLevelCount = desc.sampleCount = 1;
        desc.usage = WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_TextureBinding |
                     WGPUTextureUsage_CopySrc | WGPUTextureUsage_CopyDst;
        return wgpuDeviceCreateTexture(device_, &desc);
    };
    historyColor_ = texture(WGPUTextureFormat_RGBA16Float, true); historyView_ = view(historyColor_);
    resolve_ = texture(WGPUTextureFormat_RGBA16Float, true); resolveView_ = view(resolve_);
    velocity_ = texture(WGPUTextureFormat_RGBA16Float, false); velocityView_ = view(velocity_);
    historyDepth_ = texture(WGPUTextureFormat_Depth32Float, false); historyDepthView_ = view(historyDepth_);
    graph_ = {};
    const graph::TextureDesc hdr{width, height, WGPUTextureFormat_RGBA16Float, WGPUTextureUsage_TextureBinding};
    const graph::TextureDesc outputHdr{outputWidth, outputHeight, WGPUTextureFormat_RGBA16Float, WGPUTextureUsage_TextureBinding};
    const graph::TextureDesc depth{width, height, WGPUTextureFormat_Depth32Float, WGPUTextureUsage_TextureBinding};
    const auto beauty = graph_.external("beauty", hdr), z = graph_.external("depth", depth);
    const auto motion = graph_.external("velocity", hdr), old = graph_.external("traa-history", outputHdr);
    const auto oldZ = graph_.external("traa-previous-depth", depth), result = graph_.external("traa-resolve", outputHdr);
    graph_.pass("traa-velocity", graph::PassKind::Render, {{z}}, {motion});
    graph_.pass("traa-resolve", graph::PassKind::Render, {{beauty}, {z}, {motion}, {old}, {oldZ}}, {result});
    const auto next = graph_.external("traa-next-history", outputHdr), nextZ = graph_.external("traa-next-depth", depth);
    graph_.pass("traa-store-history", graph::PassKind::Render, {{result}, {z}}, {next, nextZ});
    if (!graph_.compile().ok()) throw std::runtime_error("TN_GRAPH_INVALID: TRAA");
}
TraaPass::Matrix TraaPass::begin(const Matrix& projection, const Matrix& world, const Matrix& view,
                                 const Matrix* viewProjection) {
    history_.beginRender(0, true);
    previousProjection_ = started_ ? projection_ : projection;
    previousWorld_ = started_ ? world_ : world;
    previousView_ = started_ ? view_ : view;
    previousInverseProjection_ = started_ ? inverseProjection_ : inverse(projection);
    projection_ = projection; world_ = world; view_ = view; started_ = true;
    Matrix jittered = projection;
    const auto jitter = traaJitter(history_.frame(), jitterLength_);
    previousJitter_ = jitter_;
    jitter_ = jitter;
    // Perspective setViewOffset changes column 2; orthographic changes the translation column.
    if (projection[11] == -1) { jittered[8] += 2 * jitter[0] / width_; jittered[9] -= 2 * jitter[1] / height_; }
    else { jittered[12] -= 2 * jitter[0] / width_; jittered[13] += 2 * jitter[1] / height_; }
    if (viewProjection)
        jittered = *viewProjection;
    inverseProjection_ = inverse(jittered);
    if (debugDump_) {
        debugDump_->frame = history_.frame();
        debugDump_->width = width_; debugDump_->height = height_;
        std::ostringstream json; json << std::setprecision(17);
        json << "{\"frame\":" << history_.frame() << ",\"frameCount\":" << history_.frame() + 1
             << ",\"indexBase\":0,\"jitterIndex\":" << history_.frame() % jitterLength_
             << ",\"jitterPixels\":[" << jitter[0] << ',' << jitter[1] << "],\"projectionMatrix\":[";
        for (size_t i = 0; i < jittered.size(); ++i) json << (i ? "," : "") << jittered[i];
        json << "]}\n"; debugDump_->metadata = json.str();
    }
    return jittered;
}
TraaPass::Matrix TraaPass::previousModel(uint64_t object, const Matrix& world) {
    return history_.objectFrame(object, world, 0, 0);
}
void TraaPass::fillVelocity(WGPUCommandEncoder encoder, WGPUTextureView depthView) {
    std::array<float, 100> data{};
    const Matrix* matrices[] = {&inverseProjection_, &world_, &projection_, &view_, &previousView_, &previousProjection_};
    for (size_t i = 0; i < 6; ++i) for (size_t j = 0; j < 16; ++j) data[i * 16 + j] = float((*matrices[i])[j]);
    data[96] = float(width_); data[97] = float(height_);
    wgpuQueueWriteBuffer(queue_, fillUniforms_, 0, data.data(), sizeof data);
    auto layout = wgpuRenderPipelineGetBindGroupLayout(fillPipeline_, 0);
    WGPUBindGroupEntry entries[2]{};
    entries[0].binding = 0; entries[0].buffer = fillUniforms_; entries[0].size = sizeof data;
    entries[1].binding = 1; entries[1].textureView = depthView;
    WGPUBindGroupDescriptor groupDesc{}; groupDesc.layout = layout; groupDesc.entryCount = 2; groupDesc.entries = entries;
    auto group = createBindGroup(device_, &groupDesc);
    WGPURenderPassColorAttachment color{}; color.view = velocityView_;
    color.loadOp = WGPULoadOp_Clear; color.storeOp = WGPUStoreOp_Store;
#if defined(MYSTRAL_WEBGPU_DAWN)
    color.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
#endif
    WGPURenderPassDescriptor desc{}; desc.colorAttachmentCount = 1; desc.colorAttachments = &color;
    auto pass = beginTimedRenderPass(encoder, &desc);
    wgpuRenderPassEncoderSetPipeline(pass, fillPipeline_); wgpuRenderPassEncoderSetBindGroup(pass, 0, group, 0, nullptr);
    wgpuRenderPassEncoderDraw(pass, 3, 1, 0, 0); wgpuRenderPassEncoderEnd(pass); wgpuRenderPassEncoderRelease(pass);
    wgpuBindGroupRelease(group); wgpuBindGroupLayoutRelease(layout);
}
void TraaPass::seedHistory(WGPUCommandEncoder encoder, WGPUTexture beauty) {
    if (!needsSeed()) return;
    // A low-resolution image cannot seed a display-size history; the cold resolve uses current only.
    if (width_ != outputWidth_ || height_ != outputHeight_) return;
    // TRAANode.updateBefore copies the beauty target before the resolve quad updates its scene pass.
    WGPUImageCopyTexture_Compat src{}, dst{};
    src.texture = beauty; dst.texture = historyColor_;
    src.aspect = dst.aspect = WGPUTextureAspect_All;
    const WGPUExtent3D extent{width_, height_, 1};
    wgpuCommandEncoderCopyTextureToTexture(encoder, &src, &dst, &extent);
}
void TraaPass::resolve(WGPUCommandEncoder encoder, WGPUTexture beauty, WGPUTextureView beautyView,
                        WGPUTexture depth, WGPUTextureView depthView, WGPUTexture output, WGPUTextureView outputView) {
    const WGPUTexture resolved = output ? output : resolve_;
    auto copy = [&](WGPUTexture from, WGPUTexture to, bool isDepth) {
        WGPUImageCopyTexture_Compat src{}, dst{};
        src.texture = from; dst.texture = to;
        src.aspect = dst.aspect = isDepth ? WGPUTextureAspect_DepthOnly : WGPUTextureAspect_All;
        const WGPUExtent3D extent{isDepth ? width_ : outputWidth_, isDepth ? height_ : outputHeight_, 1};
        wgpuCommandEncoderCopyTextureToTexture(encoder, &src, &dst, &extent);
    };
    // On the initial render/resize there is no previous depth allocation to sample.
    if (history_.frame() == 0 || history_.generation(0) > depthGeneration_) {
        copy(depth, historyDepth_, true);
        previousWorld_ = world_; previousInverseProjection_ = inverseProjection_;
    }
    depthGeneration_ = history_.generation(0);
    if (debugDump_) {
        stageDebugTexture(encoder, beauty, "beauty");
        stageDebugTexture(encoder, velocity_, "velocity");
        stageDebugTexture(encoder, historyColor_, "history");
    }
    std::array<float, 92> data{};
    const Matrix* matrices[] = {&inverseProjection_, &previousInverseProjection_, &previousWorld_, &view_, &projection_};
    for (size_t i = 0; i < 5; ++i) for (size_t j = 0; j < 16; ++j) data[i * 16 + j] = float((*matrices[i])[j]);
    data[80] = float(width_); data[81] = float(height_); data[82] = options_.depthThreshold;
    data[83] = options_.edgeDepthDiff; data[84] = options_.maxVelocityLength; data[85] = options_.useSubpixelCorrection;
    // One frame in kMeasureEvery counts. The first frame has no history to judge, so it never counts.
    measured_ = history_.historyValid(0) && history_.frame() % kMeasureEvery == 0;
    data[86] = measured_ ? 1.f : 0.f;
    data[87] = (width_ == outputWidth_ && height_ == outputHeight_) || history_.historyValid(0) ? 1.f : 0.f;
    data[88] = float(jitter_[0]); data[89] = float(jitter_[1]);
    data[90] = float(previousJitter_[0]); data[91] = float(previousJitter_[1]);
    if (measured_) {
        const uint32_t zero[2] = {0, 0};
        wgpuQueueWriteBuffer(queue_, stats_, 0, zero, sizeof zero);
        measuredFrame_ = history_.frame();
    }
    wgpuQueueWriteBuffer(queue_, uniforms_, 0, data.data(), sizeof data);
    auto layout = wgpuRenderPipelineGetBindGroupLayout(pipeline_, 0);
    WGPUBindGroupEntry entries[8]{};
    for (uint32_t i = 0; i < 8; ++i) entries[i].binding = i;
    entries[0].buffer = uniforms_; entries[0].size = sizeof data;
    entries[1].textureView = beautyView; entries[2].textureView = depthView;
    entries[3].textureView = velocityView_; entries[4].textureView = historyView_;
    entries[5].textureView = historyDepthView_; entries[6].sampler = sampler_;
    entries[7].buffer = stats_; entries[7].size = 8;
    WGPUBindGroupDescriptor groupDesc{}; groupDesc.layout = layout; groupDesc.entryCount = 8; groupDesc.entries = entries;
    auto group = createBindGroup(device_, &groupDesc);
    WGPURenderPassColorAttachment color{}; color.view = outputView ? outputView : resolveView_;
    color.loadOp = WGPULoadOp_Clear; color.storeOp = WGPUStoreOp_Store;
#if defined(MYSTRAL_WEBGPU_DAWN)
    color.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
#endif
    WGPURenderPassDescriptor desc{}; desc.colorAttachmentCount = 1; desc.colorAttachments = &color;
    auto pass = beginTimedRenderPass(encoder, &desc);
    wgpuRenderPassEncoderSetPipeline(pass, pipeline_); wgpuRenderPassEncoderSetBindGroup(pass, 0, group, 0, nullptr);
    wgpuRenderPassEncoderDraw(pass, 3, 1, 0, 0); wgpuRenderPassEncoderEnd(pass); wgpuRenderPassEncoderRelease(pass);
    wgpuBindGroupRelease(group); wgpuBindGroupLayoutRelease(layout);
    if (debugDump_) stageDebugTexture(encoder, resolved, "resolved");
    copy(resolved, historyColor_, false); copy(depth, historyDepth_, true);
    history_.endFrame();
}
} // namespace tn::engine
