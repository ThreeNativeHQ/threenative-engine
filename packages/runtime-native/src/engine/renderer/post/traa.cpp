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

std::array<float, 8> TraaPass::historyDepthRows(const Matrix& projection, const Matrix& view,
                                                const Matrix& previousWorld,
                                                const Matrix& previousInverseProjection) {
    Matrix4 composed;
    composed.elements = view;
    Matrix4 world, inverseProjection;
    world.elements = previousWorld;
    inverseProjection.elements = previousInverseProjection;
    composed.multiply(world).multiply(inverseProjection);
    std::array<float, 8> rows{};
    for (size_t column = 0; column < 4; ++column) {
        const double z = composed.elements[column * 4 + 2];
        const double w = previousInverseProjection[column * 4 + 3];
        rows[column] = float(projection[10] * z + projection[14] * w);
        rows[4 + column] = float(projection[11] * z + projection[15] * w);
    }
    return rows;
}

// TRAANode.setup() with the previous-depth camera transform composed on the host, WebGPU depth (0..1).
// The host composes previousWorld, view and previousInverseProjection into the two rows above, so the
// shader's previous depth is two dot products against the same clip position, not a camera chain.
// Out-of-image loads: depth reads zero, as upstream; a beauty neighbour reads (0, 0, 0, 1), which
// is what the browser returns there (WGSL leaves it implementation-defined; measured with TN_TRAA_DUMP).
// Counted frames record rejection/clipping only. Projection jitter has the opposite sign to UE's;
// depth uses nearest sampling and CPU-composed reprojection rows. The current radial filter shares
// its nine texels with the UE High clamp; incomplete motion uses responsive history.
// UE 5.8.3 TemporalAA.usf:2175-2190,2334-2343 rejects departed dynamic history; here only where the depth shows the
// surface left, so a mover that stops keeps its history instead of showing the input grid while it refills;
// a separate R8 target keeps the authored colour alpha intact.
// UE 5.8.3 TemporalAA.usf:1463-1478,1772-1808,1961-1990,2278: responsive history for incomplete motion.
const char* traaResolveWgsl() { return R"WGSL(
struct Params {
    depthNumerator: vec4<f32>, depthDenominator: vec4<f32>,
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
@group(0) @binding(7) var<storage, read_write> stats: array<atomic<u32>, 2>;
@group(0) @binding(8) var previousDynamic: texture_2d<f32>;
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
const rgbToNeighborhood = mat3x3<f32>(vec3<f32>(1,2,-1), vec3<f32>(2,0,2), vec3<f32>(1,-2,-1));
const neighborhoodToRgb = mat3x3<f32>(vec3<f32>(.25), vec3<f32>(.25,0,-.25), vec3<f32>(-.25,.25,-.25));
struct Resolved { @location(0) color: vec4<f32>, @location(1) dynamic: vec2<f32> }
// UE 5.8.3's five-tap Catmull-Rom history fetch (TextureSampling.ush:120-157, TemporalAA.usf:1868-1877): a bilinear fetch
// blurs the history at every fractional offset, so a fast pan softens it until the raw input wins.
fn catmullRomHistory(uv: vec2<f32>, size: vec2<f32>) -> vec4<f32> {
    let pixel = uv * size;
    let iuv = floor(pixel - 0.5) + 1.0;
    let f = pixel - iuv;
    let f2 = f * f;
    let s = (1.25 - f2) * f + 0.5;
    let t0 = (0.25 * f2 - 0.0625) * (1.125 - 0.5 * f2.yx);
    let w0 = t0 - 2.0 * f * t0;
    let w3 = t0 + 2.0 * f * t0;
    let inv = 1.0 / size;
    let c = (iuv - 0.5) * inv;
    let o = s * inv;
    return textureSampleLevel(history, linearSampler, c + vec2(-inv.x, o.y), 0.0) * w0.x +
           textureSampleLevel(history, linearSampler, c + vec2(2.0 * inv.x, o.y), 0.0) * w3.x +
           textureSampleLevel(history, linearSampler, c + o, 0.0) * (1.0 - w0.x - w3.x - w0.y - w3.y) +
           textureSampleLevel(history, linearSampler, c + vec2(o.x, -inv.y), 0.0) * w0.y +
           textureSampleLevel(history, linearSampler, c + vec2(o.x, 2.0 * inv.y), 0.0) * w3.y;
}
@fragment fn fs(input: Vertex) -> Resolved {
    let outputSize = vec2<f32>(textureDimensions(history));
    let upsampling = any(outputSize != u.size);
    let currentUV = input.uv - select(vec2<f32>(0), u.jitter / u.size, upsampling);
    let texel = clamp(vec2<i32>(floor(currentUV * u.size)), vec2<i32>(0), vec2<i32>(u.size) - 1);
    var closest = 2.0;
    var farthest = -1.0;
    var closestPosition = vec2<f32>(0);
    for (var x = -1; x <= 1; x++) {
        for (var y = -1; y <= 1; y++) {
            let neighbor = currentUV * u.size + vec2<f32>(f32(x), f32(y));
            let d = textureLoad(depth, vec2<i32>(neighbor), 0);
            if (d < closest) { closest = d; closestPosition = neighbor; }
            if (d > farthest) { farthest = d; }
        }
    }
    let motionSample = textureLoad(velocity, vec2<i32>(closestPosition), 0);
    let offset = motionSample.xy * vec2(0.5, -0.5);
    let historyUV = input.uv - offset;
    let previousDepthUV = historyUV - select(vec2<f32>(0), u.previousJitter / u.size, upsampling);
    let previousTexel = clamp(vec2<i32>(floor(previousDepthUV * u.size)), vec2<i32>(0), vec2<i32>(u.size) - 1);
    let d = textureLoad(previousDepth, previousTexel, 0);
    let previousClip = vec4(previousDepthUV * vec2(2, -2) + vec2(-1, 1), d, 1);
    let oldDepth = dot(u.depthNumerator, previousClip) / dot(u.depthDenominator, previousClip);
    let validUV = all(historyUV >= vec2(0)) && all(historyUV <= vec2(1));
    let edge = farthest - closest > u.edgeDepthDiff;
    // The depth test reprojects the previous depth through the camera only, so a mover driving away reads as disoccluded on
    // every pixel. Upsampled, a pixel with its own complete motion keeps its history and the neighbourhood clip rejects a
    // wrong one (UE 5.8.3 TemporalAA.usf:1715-1770 has no depth test).
    let disocclusion = closest - oldDepth > u.depthThreshold && !(upsampling && motionSample.z == 3);
    let dynamic = motionSample.z != 1;
    var dynamicNeighborhood = dynamic;
    var completeMotion = motionSample.z > 0.5;
    if (upsampling) {
        // A gather at integer + .25 covers integer - 1 through integer. The four
        // overlapping quads cover the same clamped 3x3 footprint as the loads.
        if (completeMotion) {
            let origin = vec2<f32>(texel) + 0.25;
            let g00 = textureGather(2, velocity, linearSampler, origin / u.size);
            let g10 = textureGather(2, velocity, linearSampler, (origin + vec2(1,0)) / u.size);
            let g01 = textureGather(2, velocity, linearSampler, (origin + vec2(0,1)) / u.size);
            let g11 = textureGather(2, velocity, linearSampler, (origin + vec2(1,1)) / u.size);
            completeMotion = completeMotion && all(g00 > vec4(0.5)) && all(g10 > vec4(0.5)) &&
                             all(g01 > vec4(0.5)) && all(g11 > vec4(0.5));
        }
        if (!dynamicNeighborhood) {
            let nearestOrigin = vec2<f32>(vec2<i32>(closestPosition)) + 0.25;
            let nearest00 = textureGather(2, velocity, linearSampler, nearestOrigin / u.size);
            let nearest11 = textureGather(2, velocity, linearSampler, (nearestOrigin + vec2(1,1)) / u.size);
            // Gather x/z are left/up in the first quad and down/right in the second.
            dynamicNeighborhood = dynamicNeighborhood || any(nearest00.xz != vec2(1)) ||
                                  any(nearest11.xz != vec2(1));
        }
    }
    let highClamp = upsampling;
    // UE 5.8.3 Responsive AA (TemporalAA.usf:2277-2278), FSR2's reactive mask: a transparent draw has no motion of its
    // own and marks the motion alpha instead. Under it the resolve takes a quarter of the new frame. Its glow stays in
    // the history after it moves on, and the static clamp, wide on textured ground, keeps it: the mark decays in the
    // history mask over eight frames, and marked pixels clip like pixels near a mover.
    var responsive = false;
    var overlay = 0.0;
    if (upsampling) {
        // The 3x3 footprint, as the complete-motion test reads it: a transparent rim spans the closest texel's neighbours.
        let origin = vec2<f32>(texel) + 0.25;
        let a00 = textureGather(3, velocity, linearSampler, origin / u.size);
        let a10 = textureGather(3, velocity, linearSampler, (origin + vec2(1,0)) / u.size);
        let a01 = textureGather(3, velocity, linearSampler, (origin + vec2(0,1)) / u.size);
        let a11 = textureGather(3, velocity, linearSampler, (origin + vec2(1,1)) / u.size);
        responsive = any(min(min(a00, a10), min(a01, a11)) < vec4(0.5));
        overlay = select(max(textureSampleLevel(previousDynamic, linearSampler, historyUV, 0).g - 0.125, 0.0), 1.0, responsive);
        dynamicNeighborhood = dynamicNeighborhood || overlay > 0;
    }
    let oldDynamic = upsampling && textureSampleLevel(previousDynamic, linearSampler, historyUV, 0).r > 0;
    let departed = !dynamicNeighborhood && oldDynamic && disocclusion;
    let valid = u.historyValid != 0 && validUV && (edge || !disocclusion) && !departed;
    let counting = u.count != 0;
    if (counting && !valid) { atomicAdd(&stats[0], 1u); }
    var current: vec4<f32>;
    var moment1 = vec4<f32>(0);
    var moment2 = vec4<f32>(0);
    var low = vec4(1e30);
    var high = vec4(-1e30);
    var rgbLow = vec4(1e30);
    var rgbHigh = vec4(-1e30);
    var pixelWeight = 1.0;
    if (upsampling) {
        let centre = floor(currentUV * u.size);
        let upscale = outputSize / u.size;
        let radius = 1.51 - 0.21 * (max(upscale.x, upscale.y) - 1);
        // UE 5.8.3 adaptive filtering (TemporalAA.usf:2203-2224, 1463-1478): the current frame's kernel widens to a whole
        // input pixel where history is ignored and as the pixel moves, so a rejected or fast pixel shows the jittered
        // input averaged, not its raw noise (grass behind a walking enemy speckled).
        var filterScale = select(0.0, 1.0, valid) - length((input.uv - historyUV) * outputSize) * max(upscale.x, upscale.y) * 0.1;
        filterScale = max(filterScale, 1 / max(upscale.x, upscale.y));
        // UE 5.8.3 ComputePixelWeigth (TemporalAA.usf:1492-1523, 1687-1688, 2255): the output pixel takes the new frame in
        // proportion to its nearest input sample's kernel weight, u^2 r(u^2 |dKO|^2), so it accumulates the samples that land
        // on it, as full resolution does. A fixed weight blends the interpolated frame into every pixel: a purple enemy over
        // green grass smeared into a grey, speckled rim two pixels wide.
        let dKO = currentUV * u.size - (centre + 0.5);
        let u2 = max(upscale.x, upscale.y) * max(upscale.x, upscale.y) * filterScale * filterScale;
        let k2 = clamp(u2 * dot(dKO, dKO), 0.0, 1.0);
        pixelWeight = u2 * ((0.905 * k2 - 1.9) * k2 + 1.0);
        var sum = vec4<f32>(0);
        var weights = 0.0;
        var spread1 = vec4<f32>(0);
        var spread2 = vec4<f32>(0);
        var motionLow = vec2(1e30);
        var motionHigh = vec2(-1e30);
        var hueLow = vec2(1e30);
        var hueHigh = vec2(-1e30);
        for (var y = -1; y <= 1; y++) {
            for (var x = -1; x <= 1; x++) {
                let samplePosition = centre + vec2<f32>(f32(x), f32(y));
                let distance = samplePosition + 0.5 - currentUV * u.size;
                let delta = distance * upscale * filterScale;
                let x2 = clamp(dot(delta, delta), 0.0, 1.0);
                let weight = (0.905 * x2 - 1.9) * x2 + 1.0;
                let sourcePixel = vec2<i32>(samplePosition);
                let pixel = clamp(sourcePixel, vec2<i32>(0), vec2<i32>(u.size) - 1);
                let color = textureLoad(beauty, pixel, 0);
                sum += color * weight;
                weights += weight;
                let neighborhood = vec4(rgbToNeighborhood * color.rgb, color.a);
                spread1 += neighborhood; spread2 += neighborhood * neighborhood;
                let sampleMotion = textureLoad(velocity, pixel, 0).xy;
                motionLow = min(motionLow, sampleMotion); motionHigh = max(motionHigh, sampleMotion);
                let hue = neighborhood.yz / max(neighborhood.x, 0.02);
                hueLow = min(hueLow, hue); hueHigh = max(hueHigh, hue);
                if (highClamp && ((x == 0 && y == 0) || dot(distance, distance) < radius * radius)) {
                    low = min(low, neighborhood);
                    rgbLow = min(rgbLow, color); rgbHigh = max(rgbHigh, color);
                    high = max(high, neighborhood);
                }
            }
        }
        current = sum / weights;
        // UE 5.8.3 TemporalAA.usf:1715-1770 variance box (mean +/- 1.25 sigma, widened to the filtered sample) on a
        // still pixel that takes a mover's dilated motion: the sample-distance box spans both sides of the moving rim
        // and keeps the colour it uncovered. A moving surface itself (wind grass, a coin face) keeps the
        // sample-distance box, so its 0.72 detail is rebuilt from history.
        if (dynamicNeighborhood && textureLoad(velocity, texel, 0).z == 1) {
            let mean = spread1 / 9;
            let sigma = sqrt(abs(spread2 / 9 - mean * mean)) * 1.25;
            let filtered = vec4(rgbToNeighborhood * current.rgb, current.a);
            low = min(mean - sigma, filtered);
            high = max(mean + sigma, filtered);
        }
        // Where surfaces moving apart meet (a grass blade across a walking enemy, the enemy's rim), the box holds the
        // colours the input shows within half an output pixel: bilinear taps at the pixel's corners. Taps blend across
        // a real edge, so its antialiased mix stays inside; a pixel whose taps all land on the body clips the grey that
        // history diffused from a crossing blade. Nearest samples within one output pixel are too few at 0.72 and
        // stair-step edges; grass swaying as one keeps the sample-distance box and the detail it rebuilds.
        let motionEdge = length((motionHigh - motionLow) * vec2(0.5, -0.5) * outputSize) > 0.5 && length(hueHigh - hueLow) > 0.8;
        let filtered = vec4(rgbToNeighborhood * current.rgb, current.a);
        var tapLow = filtered;
        var tapHigh = filtered;
        var tapRgbLow = current;
        var tapRgbHigh = current;
        for (var k = 0; k < 4; k++) {
            let corner = vec2(f32(k & 1) - 0.5, f32(k >> 1) - 0.5) / outputSize;
            let color = textureSampleLevel(beauty, linearSampler, currentUV + corner, 0.0);
            let neighborhood = vec4(rgbToNeighborhood * color.rgb, color.a);
            tapLow = min(tapLow, neighborhood); tapHigh = max(tapHigh, neighborhood);
            tapRgbLow = min(tapRgbLow, color); tapRgbHigh = max(tapRgbHigh, color);
        }
        if (dynamicNeighborhood && motionEdge) { low = tapLow; high = tapHigh; rgbLow = tapRgbLow; rgbHigh = tapRgbHigh; }
    } else {
        current = textureSampleLevel(beauty, linearSampler, input.uv, 0.0);
    }
    var old = textureSampleLevel(history, linearSampler, historyUV, 0.0);
    if (upsampling) { old = max(catmullRomHistory(historyUV, outputSize), vec4(0)); }
    let motion = clamp(length((input.uv - historyUV) * u.size) / u.maxVelocityLength, 0.0, 1.0);
    var currentWeight = 0.05;
    if (u.subpixel != 0) {
        let phase = abs(fract(offset * u.size));
        let weight = max(phase, 1 - phase);
        currentWeight += (1 - weight.x * weight.y) / 0.75 * 0.25;
    }
    if (upsampling) { currentWeight *= pixelWeight; }
    if (upsampling && !completeMotion) { currentWeight = max(currentWeight, 0.25); }
    if (responsive) { currentWeight = max(currentWeight, 0.25); }
    currentWeight = select(1.0, clamp(currentWeight + motion, 0.0, 1.0), valid);
    let gamma = mix(0.5, 1.0, (1 - motion) * (1 - motion));
    var offsets = array<vec2<i32>, 8>(vec2(-1,-1), vec2(-1,1), vec2(1,-1), vec2(1,1),
        vec2(1,0), vec2(0,-1), vec2(0,1), vec2(-1,0));
    if (!highClamp) {
        let centreSample = select(current, textureLoad(beauty, texel, 0), upsampling);
        moment1 = centreSample;
        moment2 = centreSample * centreSample;
        for (var i = 0u; i < 8u; i++) {
            let neighbor = max(select(vec4(0.0, 0.0, 0.0, 1.0), textureLoad(beauty, texel + offsets[i], 0), all(texel + offsets[i] >= vec2<i32>(0)) && all(texel + offsets[i] < vec2<i32>(u.size))), vec4(0.0));
            moment1 += neighbor; moment2 += neighbor * neighbor;
        }
    }
    var clipped = old;
    if (highClamp) {
        let historyColor = vec4(rgbToNeighborhood * old.rgb, old.a);
        // Near a mover, clip toward the box centre so history keeps its hue; elsewhere UE's per-channel clamp, which
        // leaves in-range channels alone and so keeps static edges resolved.
        let bounded = clipAABB(vec4(0, 0, 0, clamp(old.a, low.a, high.a)), historyColor, low, high);
        if (dynamicNeighborhood && any(bounded != historyColor)) { clipped = vec4(neighborhoodToRgb * bounded.rgb, bounded.a); }
        // Static history: UE's per-channel clamp (in-range channels stay, so static edges stay resolved), first in RGB,
        // then in YCoCg. YCoCg alone turns a white rim over red and dark grey or orange (the kart start lamps); RGB alone
        // keeps purple history over a grey wall, whose luma range spans every RGB channel.
        if (!dynamicNeighborhood) {
            let rgbBounded = clamp(old, rgbLow, rgbHigh);
            let rgbColor = vec4(rgbToNeighborhood * rgbBounded.rgb, rgbBounded.a);
            let both = clamp(rgbColor, low, high);
            clipped = select(rgbBounded, vec4(neighborhoodToRgb * both.rgb, both.a), any(both != rgbColor));
        }
    } else {
        let mean = moment1 / 9;
        let variance = sqrt(max(moment2 / 9 - mean * mean, vec4(0.0))) * gamma;
        low = mean - variance;
        high = mean + variance;
        clipped = clipAABB(clamp(mean, low, high), old, low, high);
    }
    if (counting && valid && any(clipped.rgb != old.rgb)) { atomicAdd(&stats[1], 1u); }
    let compressedCurrent = current / (max(max(current.r, current.g), current.b) + 1);
    let compressedHistory = clipped / (max(max(clipped.r, clipped.g), clipped.b) + 1);
    let luminance = vec3(0.2126, 0.7152, 0.0722);
    let historyWeight = (1 - currentWeight) / (dot(compressedHistory.rgb, luminance) + 1);
    currentWeight /= dot(compressedCurrent.rgb, luminance) + 1;
    return Resolved((current * currentWeight + clipped * historyWeight) / max(currentWeight + historyWeight, 0.00001), vec2(select(0.f, 1.f, dynamic || (valid && oldDynamic)), overlay));
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
    return vec4(current.xy / current.w - previous.xy / previous.w, select(0.f, 1.f, clip.z == 1), 1);
}
)WGSL"; }

TraaPass::TraaPass(WGPUDevice device, WGPUQueue queue, TraaOptions options)
    : device_(device), queue_(queue), options_(options) {
    if (!(options.maxVelocityLength > 0) || !std::isfinite(options.maxVelocityLength) ||
        !std::isfinite(options.depthThreshold) || !std::isfinite(options.edgeDepthDiff))
        throw std::runtime_error("TN_TRAA_OPTIONS_INVALID");
    WGPUBufferDescriptor buffer{};
    buffer.size = 80; buffer.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
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
    WGPUColorTargetState colors[2] = {color, color}; colors[1].format = WGPUTextureFormat_RG8Unorm;
    WGPUFragmentState fragment{}; fragment.module = module; WGPU_SET_ENTRY_POINT(fragment, "fs");
    fragment.targetCount = 2; fragment.targets = colors;
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
    if (layout_) wgpuBindGroupLayoutRelease(layout_);
    if (fillLayout_) wgpuBindGroupLayoutRelease(fillLayout_);
    wgpuRenderPipelineRelease(pipeline_); wgpuRenderPipelineRelease(fillPipeline_);
    wgpuBufferRelease(uniforms_); wgpuBufferRelease(fillUniforms_); wgpuBufferRelease(ownStats_);
    wgpuSamplerRelease(sampler_);
}
void TraaPass::releaseTargets() {
    fillGroups_.clear(); resolveGroups_.clear();  // they hold the views released here
    for (auto v : {historyView_, historyDepthView_, resolveView_, velocityView_, dynamicView_, historyDynamicView_}) if (v) wgpuTextureViewRelease(v);
    for (auto t : {historyColor_, historyDepth_, resolve_, velocity_, dynamic_, historyDynamic_}) if (t) wgpuTextureRelease(t);
    historyView_ = historyDepthView_ = resolveView_ = velocityView_ = nullptr;
    historyColor_ = historyDepth_ = resolve_ = velocity_ = dynamic_ = historyDynamic_ = nullptr;
    dynamicView_ = historyDynamicView_ = nullptr;
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
    dynamic_ = texture(WGPUTextureFormat_RG8Unorm, true); dynamicView_ = view(dynamic_);
    historyDynamic_ = texture(WGPUTextureFormat_RG8Unorm, true); historyDynamicView_ = view(historyDynamic_);
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
    const graph::TextureDesc mask{outputWidth, outputHeight, WGPUTextureFormat_RG8Unorm, WGPUTextureUsage_TextureBinding};
    const auto oldMask = graph_.external("traa-history-dynamic", mask), currentMask = graph_.external("traa-dynamic", mask);
    graph_.pass("traa-velocity", graph::PassKind::Render, {{z}}, {motion});
    graph_.pass("traa-resolve", graph::PassKind::Render, {{beauty}, {z}, {motion}, {old}, {oldZ}, {oldMask}}, {result, currentMask});
    const auto next = graph_.external("traa-next-history", outputHdr), nextZ = graph_.external("traa-next-depth", depth);
    const auto nextMask = graph_.external("traa-next-dynamic", mask);
    graph_.pass("traa-store-history", graph::PassKind::Render, {{result}, {z}, {currentMask}}, {next, nextZ, nextMask});
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
    if (viewProjection) {
        // The game jittered its own camera (three's TRAANode setViewOffset): it drew with its sample offset, so the
        // resolve places its kernel with that one, read back from the projection, not with this pass's sequence.
        jittered = *viewProjection;
        if (projection[11] == -1)
            jitter_ = {(jittered[8] - projection[8]) * width_ / 2, (projection[9] - jittered[9]) * height_ / 2};
        else jitter_ = {(projection[12] - jittered[12]) * width_ / 2, (jittered[13] - projection[13]) * height_ / 2};
    }
    inverseProjection_ = inverse(jittered);
    if (debugDump_) {
        debugDump_->frame = history_.frame();
        debugDump_->width = width_; debugDump_->height = height_;
        std::ostringstream json; json << std::setprecision(17);
        json << "{\"frame\":" << history_.frame() << ",\"frameCount\":" << history_.frame() + 1
             << ",\"indexBase\":0,\"jitterIndex\":" << history_.frame() % jitterLength_
             << ",\"jitterPixels\":[" << jitter_[0] << ',' << jitter_[1] << "],\"projectionMatrix\":[";
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
    if (!fillLayout_) fillLayout_ = wgpuRenderPipelineGetBindGroupLayout(fillPipeline_, 0);
    std::vector<WGPUBindGroupEntry> entries(2);
    entries[0].binding = 0; entries[0].buffer = fillUniforms_; entries[0].size = sizeof data;
    entries[1].binding = 1; entries[1].textureView = depthView;
    auto group = fillGroups_.get(device_, fillLayout_, entries);  // the same views each frame: no new group
    WGPURenderPassColorAttachment color{}; color.view = velocityView_;
    color.loadOp = WGPULoadOp_Clear; color.storeOp = WGPUStoreOp_Store;
#if defined(MYSTRAL_WEBGPU_DAWN)
    color.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
#endif
    WGPURenderPassDescriptor desc{}; desc.colorAttachmentCount = 1; desc.colorAttachments = &color;
    auto pass = beginTimedRenderPass(encoder, &desc, 2, {"traaVelocity", width_, height_});
    wgpuRenderPassEncoderSetPipeline(pass, fillPipeline_); wgpuRenderPassEncoderSetBindGroup(pass, 0, group, 0, nullptr);
    wgpuRenderPassEncoderDraw(pass, 3, 1, 0, 0); wgpuRenderPassEncoderEnd(pass); wgpuRenderPassEncoderRelease(pass);
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
    std::array<float, 20> data{};
    const auto rows = historyDepthRows(projection_, view_, previousWorld_, previousInverseProjection_);
    for (size_t i = 0; i < rows.size(); ++i) data[i] = rows[i];
    data[8] = float(width_); data[9] = float(height_); data[10] = options_.depthThreshold;
    data[11] = options_.edgeDepthDiff; data[12] = options_.maxVelocityLength; data[13] = options_.useSubpixelCorrection;
    // One frame in kMeasureEvery counts. The first frame has no history to judge, so it never counts.
    measured_ = history_.historyValid(0) && history_.frame() % kMeasureEvery == 0;
    data[14] = measured_ ? 1.f : 0.f;
    data[15] = (width_ == outputWidth_ && height_ == outputHeight_) || history_.historyValid(0) ? 1.f : 0.f;
    data[16] = float(jitter_[0]); data[17] = float(jitter_[1]);
    data[18] = float(previousJitter_[0]); data[19] = float(previousJitter_[1]);
    if (measured_) {
        const uint32_t zero[2] = {0, 0};
        wgpuQueueWriteBuffer(queue_, stats_, 0, zero, sizeof zero);
        measuredFrame_ = history_.frame();
    }
    wgpuQueueWriteBuffer(queue_, uniforms_, 0, data.data(), sizeof data);
    if (!layout_) layout_ = wgpuRenderPipelineGetBindGroupLayout(pipeline_, 0);
    std::vector<WGPUBindGroupEntry> entries(9);
    for (uint32_t i = 0; i < 9; ++i) entries[i].binding = i;
    entries[0].buffer = uniforms_; entries[0].size = sizeof data;
    entries[1].textureView = beautyView; entries[2].textureView = depthView;
    entries[3].textureView = velocityView_; entries[4].textureView = historyView_;
    entries[5].textureView = historyDepthView_; entries[6].sampler = sampler_;
    entries[7].buffer = stats_; entries[7].size = 8;
    entries[8].textureView = historyDynamicView_;
    auto group = resolveGroups_.get(device_, layout_, entries);
    WGPURenderPassColorAttachment color{}; color.view = outputView ? outputView : resolveView_;
    color.loadOp = WGPULoadOp_Clear; color.storeOp = WGPUStoreOp_Store;
#if defined(MYSTRAL_WEBGPU_DAWN)
    color.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
#endif
    WGPURenderPassColorAttachment colors[2] = {color, color}; colors[1].view = dynamicView_;
    WGPURenderPassDescriptor desc{}; desc.colorAttachmentCount = 2; desc.colorAttachments = colors;
    auto pass = beginTimedRenderPass(encoder, &desc, 2, {"traaResolve", outputWidth_, outputHeight_});
    wgpuRenderPassEncoderSetPipeline(pass, pipeline_); wgpuRenderPassEncoderSetBindGroup(pass, 0, group, 0, nullptr);
    wgpuRenderPassEncoderDraw(pass, 3, 1, 0, 0); wgpuRenderPassEncoderEnd(pass); wgpuRenderPassEncoderRelease(pass);
    if (debugDump_) stageDebugTexture(encoder, resolved, "resolved");
    copy(resolved, historyColor_, false); copy(depth, historyDepth_, true);
    copy(dynamic_, historyDynamic_, false);
    history_.endFrame();
}
} // namespace tn::engine
