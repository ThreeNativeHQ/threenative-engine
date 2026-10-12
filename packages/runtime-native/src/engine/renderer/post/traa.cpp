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
    const uint32_t pitch = (width_ * 8 + 255u) & ~255u;
    const uint64_t size = uint64_t(pitch) * height_;
    WGPUBufferDescriptor desc{};
    desc.size = size; desc.usage = WGPUBufferUsage_CopyDst | WGPUBufferUsage_MapRead;
    auto buffer = wgpuDeviceCreateBuffer(device_, &desc);
    if (!buffer) throw std::runtime_error("TN_TRAA_DUMP_BUFFER_FAILED");
    debugDump_->pending.push_back({buffer, name, pitch, size});
    WGPUImageCopyTexture_Compat source{}; source.texture = texture; source.aspect = WGPUTextureAspect_All;
    WGPUImageCopyBuffer_Compat destination{}; destination.buffer = buffer;
    destination.layout.bytesPerRow = pitch; destination.layout.rowsPerImage = height_;
    const WGPUExtent3D extent{width_, height_, 1};
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
    maxVelocityLength: f32, subpixel: f32,
}
@group(0) @binding(0) var<uniform> u: Params;
@group(0) @binding(1) var beauty: texture_2d<f32>;
@group(0) @binding(2) var depth: texture_depth_2d;
@group(0) @binding(3) var velocity: texture_2d<f32>;
@group(0) @binding(4) var history: texture_2d<f32>;
@group(0) @binding(5) var previousDepth: texture_depth_2d;
@group(0) @binding(6) var linearSampler: sampler;
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
    let texel = vec2<i32>(input.uv * u.size);
    var closest = 2.0;
    var farthest = -1.0;
    var closestPosition = vec2<f32>(0);
    for (var x = -1; x <= 1; x++) {
        for (var y = -1; y <= 1; y++) {
            // Upstream adds to the floating pixel centre before converting to integer.
            let neighbor = input.uv * u.size + vec2<f32>(f32(x), f32(y));
            let d = textureLoad(depth, vec2<i32>(neighbor), 0);
            if (d < closest) { closest = d; closestPosition = neighbor; }
            if (d > farthest) { farthest = d; }
        }
    }
    let offset = textureLoad(velocity, vec2<i32>(closestPosition), 0).xy * vec2(0.5, -0.5);
    let historyUV = input.uv - offset;
    // DepthTexture defaults to nearest filtering; the colour history uses bilinear sampling.
    let previousTexel = clamp(vec2<i32>(floor(historyUV * u.size)), vec2<i32>(0), vec2<i32>(u.size) - 1);
    let d = textureLoad(previousDepth, previousTexel, 0);
    let previousClip = vec4(historyUV * vec2(2, -2) + vec2(-1, 1), d, 1);
    let previousPosition = u.previousInverseProjection * previousClip;
    let positionWorld = u.previousWorld * vec4(previousPosition.xyz / previousPosition.w, 1);
    let positionView = u.view * positionWorld;
    // Equivalent to viewZToPerspectiveDepth / viewZToOrthographicDepth for this projection.
    let projected = u.projection * vec4(0, 0, positionView.z, 1);
    let oldDepth = projected.z / projected.w;
    let validUV = all(historyUV >= vec2(0)) && all(historyUV <= vec2(1));
    let edge = farthest - closest > u.edgeDepthDiff;
    let disocclusion = closest - oldDepth > u.depthThreshold;
    let valid = validUV && (edge || !disocclusion);
    let current = textureSampleLevel(beauty, linearSampler, input.uv, 0.0);
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
    var moment1 = current;
    var moment2 = current * current;
    for (var i = 0u; i < 8u; i++) {
        let neighbor = max(select(vec4(0.0, 0.0, 0.0, 1.0), textureLoad(beauty, texel + offsets[i], 0), all(texel + offsets[i] >= vec2<i32>(0)) && all(texel + offsets[i] < vec2<i32>(u.size))), vec4(0.0));
        moment1 += neighbor; moment2 += neighbor * neighbor;
    }
    let mean = moment1 / 9;
    let variance = sqrt(max(moment2 / 9 - mean * mean, vec4(0.0))) * gamma;
    let low = mean - variance;
    let high = mean + variance;
    let clipped = clipAABB(clamp(mean, low, high), old, low, high);
    let compressedCurrent = current / (max(max(current.r, current.g), current.b) + 1);
    let compressedHistory = clipped / (max(max(clipped.r, clipped.g), clipped.b) + 1);
    let luminance = vec3(0.2126, 0.7152, 0.0722);
    let historyWeight = (1 - currentWeight) / (dot(compressedHistory.rgb, luminance) + 1);
    currentWeight /= dot(compressedCurrent.rgb, luminance) + 1;
    return (current * currentWeight + clipped * historyWeight) / max(currentWeight + historyWeight, 0.00001);
}
)WGSL"; }

TraaPass::TraaPass(WGPUDevice device, WGPUQueue queue, TraaOptions options)
    : device_(device), queue_(queue), options_(options) {
    if (!(options.maxVelocityLength > 0) || !std::isfinite(options.maxVelocityLength) ||
        !std::isfinite(options.depthThreshold) || !std::isfinite(options.edgeDepthDiff))
        throw std::runtime_error("TN_TRAA_OPTIONS_INVALID");
    WGPUBufferDescriptor buffer{};
    buffer.size = 352; buffer.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
    uniforms_ = wgpuDeviceCreateBuffer(device_, &buffer);
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
}
TraaPass::~TraaPass() {
    releaseTargets();
    wgpuRenderPipelineRelease(pipeline_); wgpuBufferRelease(uniforms_); wgpuSamplerRelease(sampler_);
}
void TraaPass::releaseTargets() {
    for (auto v : {historyView_, historyDepthView_, resolveView_, velocityView_}) if (v) wgpuTextureViewRelease(v);
    for (auto t : {historyColor_, historyDepth_, resolve_, velocity_}) if (t) wgpuTextureRelease(t);
    historyView_ = historyDepthView_ = resolveView_ = velocityView_ = nullptr;
    historyColor_ = historyDepth_ = resolve_ = velocity_ = nullptr;
}
void TraaPass::resize(uint32_t width, uint32_t height) {
    if (width == width_ && height == height_) return;
    releaseTargets(); width_ = width; height_ = height;
    history_.resize(0, width, height);
    auto texture = [&](WGPUTextureFormat format) {
        WGPUTextureDescriptor desc{}; desc.dimension = WGPUTextureDimension_2D; desc.size = {width, height, 1};
        desc.format = format; desc.mipLevelCount = desc.sampleCount = 1;
        desc.usage = WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_TextureBinding |
                     WGPUTextureUsage_CopySrc | WGPUTextureUsage_CopyDst;
        return wgpuDeviceCreateTexture(device_, &desc);
    };
    historyColor_ = texture(WGPUTextureFormat_RGBA16Float); historyView_ = view(historyColor_);
    resolve_ = texture(WGPUTextureFormat_RGBA16Float); resolveView_ = view(resolve_);
    velocity_ = texture(WGPUTextureFormat_RGBA16Float); velocityView_ = view(velocity_);
    historyDepth_ = texture(WGPUTextureFormat_Depth32Float); historyDepthView_ = view(historyDepth_);
    graph_ = {};
    const graph::TextureDesc hdr{width, height, WGPUTextureFormat_RGBA16Float, WGPUTextureUsage_TextureBinding};
    const graph::TextureDesc depth{width, height, WGPUTextureFormat_Depth32Float, WGPUTextureUsage_TextureBinding};
    const auto beauty = graph_.external("beauty", hdr), z = graph_.external("depth", depth);
    const auto motion = graph_.external("velocity", hdr), old = graph_.external("traa-history", hdr);
    const auto oldZ = graph_.external("traa-previous-depth", depth), result = graph_.external("traa-resolve", hdr);
    graph_.pass("traa-velocity", graph::PassKind::Render, {{z}}, {motion});
    graph_.pass("traa-resolve", graph::PassKind::Render, {{beauty}, {z}, {motion}, {old}, {oldZ}}, {result});
    const auto next = graph_.external("traa-next-history", hdr), nextZ = graph_.external("traa-next-depth", depth);
    graph_.pass("traa-store-history", graph::PassKind::Render, {{result}, {z}}, {next, nextZ});
    if (!graph_.compile().ok()) throw std::runtime_error("TN_GRAPH_INVALID: TRAA");
}
TraaPass::Matrix TraaPass::begin(const Matrix& projection, const Matrix& world, const Matrix& view) {
    history_.beginRender(0, true);
    previousProjection_ = started_ ? projection_ : projection;
    previousWorld_ = started_ ? world_ : world;
    previousView_ = started_ ? view_ : view;
    previousInverseProjection_ = started_ ? inverseProjection_ : inverse(projection);
    projection_ = projection; world_ = world; view_ = view; started_ = true;
    Matrix jittered = projection;
    const auto jitter = traaJitter(history_.frame());
    // Perspective setViewOffset changes column 2; orthographic changes the translation column.
    if (projection[11] == -1) { jittered[8] += 2 * jitter[0] / width_; jittered[9] -= 2 * jitter[1] / height_; }
    else { jittered[12] -= 2 * jitter[0] / width_; jittered[13] += 2 * jitter[1] / height_; }
    inverseProjection_ = inverse(jittered);
    if (debugDump_) {
        debugDump_->frame = history_.frame();
        debugDump_->width = width_; debugDump_->height = height_;
        std::ostringstream json; json << std::setprecision(17);
        json << "{\"frame\":" << history_.frame() << ",\"frameCount\":" << history_.frame() + 1
             << ",\"indexBase\":0,\"jitterIndex\":" << history_.frame() % 31
             << ",\"jitterPixels\":[" << jitter[0] << ',' << jitter[1] << "],\"projectionMatrix\":[";
        for (size_t i = 0; i < jittered.size(); ++i) json << (i ? "," : "") << jittered[i];
        json << "]}\n"; debugDump_->metadata = json.str();
    }
    return jittered;
}
TraaPass::Matrix TraaPass::previousModel(uint64_t object, const Matrix& world) {
    return history_.objectFrame(object, world, 0, 0);
}
void TraaPass::seedHistory(WGPUCommandEncoder encoder, WGPUTexture beauty) {
    if (!needsSeed()) return;
    // TRAANode.updateBefore copies the beauty target before the resolve quad updates its scene pass.
    WGPUImageCopyTexture_Compat src{}, dst{};
    src.texture = beauty; dst.texture = historyColor_;
    src.aspect = dst.aspect = WGPUTextureAspect_All;
    const WGPUExtent3D extent{width_, height_, 1};
    wgpuCommandEncoderCopyTextureToTexture(encoder, &src, &dst, &extent);
}
void TraaPass::resolve(WGPUCommandEncoder encoder, WGPUTexture beauty, WGPUTextureView beautyView,
                        WGPUTexture depth, WGPUTextureView depthView) {
    auto copy = [&](WGPUTexture from, WGPUTexture to, bool isDepth) {
        WGPUImageCopyTexture_Compat src{}, dst{};
        src.texture = from; dst.texture = to;
        src.aspect = dst.aspect = isDepth ? WGPUTextureAspect_DepthOnly : WGPUTextureAspect_All;
        const WGPUExtent3D extent{width_, height_, 1};
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
    std::array<float, 88> data{};
    const Matrix* matrices[] = {&inverseProjection_, &previousInverseProjection_, &previousWorld_, &view_, &projection_};
    for (size_t i = 0; i < 5; ++i) for (size_t j = 0; j < 16; ++j) data[i * 16 + j] = float((*matrices[i])[j]);
    data[80] = float(width_); data[81] = float(height_); data[82] = options_.depthThreshold;
    data[83] = options_.edgeDepthDiff; data[84] = options_.maxVelocityLength; data[85] = options_.useSubpixelCorrection;
    wgpuQueueWriteBuffer(queue_, uniforms_, 0, data.data(), sizeof data);
    auto layout = wgpuRenderPipelineGetBindGroupLayout(pipeline_, 0);
    WGPUBindGroupEntry entries[7]{};
    for (uint32_t i = 0; i < 7; ++i) entries[i].binding = i;
    entries[0].buffer = uniforms_; entries[0].size = sizeof data;
    entries[1].textureView = beautyView; entries[2].textureView = depthView;
    entries[3].textureView = velocityView_; entries[4].textureView = historyView_;
    entries[5].textureView = historyDepthView_; entries[6].sampler = sampler_;
    WGPUBindGroupDescriptor groupDesc{}; groupDesc.layout = layout; groupDesc.entryCount = 7; groupDesc.entries = entries;
    auto group = createBindGroup(device_, &groupDesc);
    WGPURenderPassColorAttachment color{}; color.view = resolveView_;
    color.loadOp = WGPULoadOp_Clear; color.storeOp = WGPUStoreOp_Store;
#if defined(MYSTRAL_WEBGPU_DAWN)
    color.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
#endif
    WGPURenderPassDescriptor desc{}; desc.colorAttachmentCount = 1; desc.colorAttachments = &color;
    auto pass = wgpuCommandEncoderBeginRenderPass(encoder, &desc);
    wgpuRenderPassEncoderSetPipeline(pass, pipeline_); wgpuRenderPassEncoderSetBindGroup(pass, 0, group, 0, nullptr);
    wgpuRenderPassEncoderDraw(pass, 3, 1, 0, 0); wgpuRenderPassEncoderEnd(pass); wgpuRenderPassEncoderRelease(pass);
    wgpuBindGroupRelease(group); wgpuBindGroupLayoutRelease(layout);
    if (debugDump_) stageDebugTexture(encoder, resolve_, "resolved");
    copy(resolve_, historyColor_, false); copy(depth, historyDepth_, true);
    history_.endFrame();
}
} // namespace tn::engine
