#include "engine/world/gpu_scene/gpu_scene.h"

#include "engine/renderer/lod/model_lod.h"

#include <algorithm>
#include <cmath>

namespace tn::engine::world {

namespace {

/** One step past a gate, `g * (1 + 2^-22)`: two f32 ULPs at `g`'s exponent, as the reference. */
constexpr double kGateStep = 0x1p-22;

double strictlyAfterGate(double gate) { return gate + std::fabs(gate) * kGateStep; }

// JavaScript's `Math.max`: NaN wins, and +0 beats -0. `std::max` does neither.
double jsMax(double one, double other) {
    if (std::isnan(one) || std::isnan(other))
        return one + other;
    if (one == other)
        return std::signbit(one) ? other : one;
    return one > other ? one : other;
}

// JavaScript's `Math.min`: NaN wins, and -0 beats +0.
double jsMin(double one, double other) {
    if (std::isnan(one) || std::isnan(other))
        return one + other;
    if (one == other)
        return std::signbit(one) ? one : other;
    return one < other ? one : other;
}

// V8's two-argument `Math.hypot`, not `std::hypot`: `max * sqrt(1 + r*r)`with `r = min/max`.
// Verified bit-identical to node's `Math.hypot` over 400000 pairs, including f32-widened inputs.
double jsHypot(double one, double other) {
    const double x = std::fabs(one);
    const double y = std::fabs(other);
    if (!std::isfinite(x) || !std::isfinite(y))
        return (std::isinf(x) || std::isinf(y)) ? std::numeric_limits<double>::infinity()
                                                : std::numeric_limits<double>::quiet_NaN();
    const double max = jsMax(x, y);
    const double min = jsMin(x, y);
    if (max == 0)
        return 0;
    const double r = min / max;
    return max * std::sqrt(1 + r * r);
}

// `out * into` at `at`, column-major: the reference's `compose`, with every read widened to double
// and the store narrowed once, which is what reading a Float32Array and writing one does in JS.
void compose(const float* out, const float* into, float* target, std::size_t at) {
    for (int column = 0; column < 4; column += 1)
        for (int row = 0; row < 4; row += 1) {
            double sum = 0;
            for (int k = 0; k < 4; k += 1)
                sum += static_cast<double>(out[k * 4 + row]) * static_cast<double>(into[column * 4 + k]);
            target[at + static_cast<std::size_t>(column) * 4 + static_cast<std::size_t>(row)] =
                static_cast<float>(sum);
        }
}

// The one loop `cullAndSelect` and `cullAndSelectShadow` share. `shadow` null is the main camera's
// planes, eye, no gate and no base, exactly the reference's `shadow === undefined` case.
GpuSceneResult select(const GpuSceneInput& input, const GpuSceneShadowLevel* shadow) {
    const float* planes = shadow != nullptr ? shadow->planes.data() : input.camera.planes.data();
    const double eyeX = shadow != nullptr ? shadow->centreX : input.camera.x;
    const double eyeZ = shadow != nullptr ? shadow->centreZ : input.camera.z;
    const double metres = shadow != nullptr ? shadow->gate : 0;
    const int32_t base = shadow != nullptr ? shadow->base : 0;

    const std::size_t regionCount = input.regionCount;
    GpuSceneResult result;
    result.counts.assign(regionCount, 0);
    result.args.assign(regionCount * kGpuSceneDrawArgsWords, 0);
    // The drawn buffer is the regions' own, so the reference allocates exactly what the GPU holds.
    std::size_t capacity = 0;
    for (const GpuSceneRegion& region : input.regions)
        capacity = std::max(capacity, static_cast<std::size_t>(region.start) + region.capacity);
    result.drawn.assign(capacity * kGpuSceneLocalWords, 0.0f);

    for (const GpuSceneRegion& region : input.regions) {
        const std::size_t at = static_cast<std::size_t>(region.argsIndex) * kGpuSceneDrawArgsWords + 4;
        if (at < result.args.size())
            result.args[at] = region.start;
    }

    for (uint32_t index = 0; index < input.count; index += 1) {
        if (index >= input.placements.size())
            continue;
        const GpuScenePlacement& placement = input.placements[index];
        if (placement.slot < 0 || static_cast<std::size_t>(placement.slot) >= input.slots.size())
            continue;
        const GpuSceneSlot& slot = input.slots[static_cast<std::size_t>(placement.slot)];
        const float* at = placement.centre.data();
        const double radius = at[3];
        bool visible = true;
        for (int plane = 0; plane < 6; plane += 1) {
            const std::size_t offset = static_cast<std::size_t>(plane) * 4;
            const double signedDistance = static_cast<double>(planes[offset]) * at[0] +
                                          static_cast<double>(planes[offset + 1]) * at[1] +
                                          static_cast<double>(planes[offset + 2]) * at[2] + planes[offset + 3];
            if (signedDistance < -radius) {
                visible = false;
                break;
            }
        }
        if (!visible)
            continue;
        // Sub-texel, exactly as `#probe` decides it for a mesh.
        if (radius * 2 < metres)
            continue;
        const double distance = jsHypot(static_cast<double>(at[0]) - eyeX, static_cast<double>(at[2]) - eyeZ);
        if (slot.hasCull && distance > slot.cull)
            continue;
        // Cull above is the authored distance; the level below is the biased one for the main pass.
        const double lodDistance = shadow == nullptr ? lod::biasedLodDistance(distance) : distance;
        const int32_t selected = levelAtGates(slot, lodDistance, placement.scale);
        const double lastLevel = static_cast<double>(slot.levels.size()) - 1;
        const int32_t level = drawableLevel(slot, static_cast<int32_t>(jsMax(selected, jsMin(base, lastLevel))));
        if (level < 0 || static_cast<std::size_t>(level) >= slot.levels.size())
            continue;
        const GpuSceneLevel& gate = slot.levels[static_cast<std::size_t>(level)];
        for (uint32_t part = 0; part < gate.parts; part += 1) {
            const std::size_t key = static_cast<std::size_t>(gate.firstKey) + part;
            if (key >= input.regions.size())
                continue;
            const GpuSceneRegion& region = input.regions[key];
            const std::size_t argAt = static_cast<std::size_t>(region.argsIndex) * kGpuSceneDrawArgsWords + 1;
            if (key >= regionCount) {
                // The reference reads `counts[key]` as undefined there: the count store is dropped,
                // `undefined + 1` stores NaN, which a Uint32Array writes as 0, and the matrix offset
                // is NaN, so nothing is drawn. No committed step has fewer counts than regions.
                if (argAt < result.args.size())
                    result.args[argAt] = 0;
                continue;
            }
            const uint32_t taken = result.counts[key];
            if (taken >= region.capacity)
                continue;
            result.counts[key] = taken + 1;
            if (argAt < result.args.size())
                result.args[argAt] = taken + 1;
            compose(placement.matrix.data(), region.local.data(), result.drawn.data(),
                    (static_cast<std::size_t>(region.start) + taken) * kGpuSceneLocalWords);
        }
    }
    return result;
}

// The gate rule itself, over an asset's distances and impostor flag: what `levelAtGates` exposes
// for a slot table and what `liveKeyInstances` reads from the owner's live asset.
int32_t levelAtGatesCore(const std::vector<double>& distances, bool impostor, double distance, double scale) {
    const int32_t last = static_cast<int32_t>(distances.size()) - 1;
    const double magnitude = std::isfinite(scale) ? std::fabs(scale) : 1;
    int32_t level = 0;
    for (int32_t index = 1; index < static_cast<int32_t>(distances.size()); index += 1) {
        const double gate = distances[static_cast<std::size_t>(index)];
        const double threshold =
            impostor && index == last && last >= 1
                ? jsMax(strictlyAfterGate(distances[static_cast<std::size_t>(last - 1)]), gate * magnitude)
                : gate;
        if (distance > threshold)
            level = index;
    }
    return level;
}

} // namespace

int32_t levelAtGates(const GpuSceneSlot& slot, double distance, double scale) {
    return levelAtGatesCore(slot.distances, slot.impostor, distance, scale);
}

int32_t drawableLevel(const GpuSceneSlot& slot, int32_t level) {
    for (int32_t at = level; at > 0; at -= 1) {
        const uint32_t parts =
            static_cast<std::size_t>(at) < slot.levels.size() ? slot.levels[static_cast<std::size_t>(at)].parts : 0;
        if (parts > 0)
            return at;
    }
    return 0;
}

GpuSceneResult cullAndSelect(const GpuSceneInput& input) { return select(input, nullptr); }

GpuSceneResult cullAndSelectShadow(const GpuSceneInput& input, const GpuSceneShadowLevel& level) {
    return select(input, &level);
}

std::vector<GpuSceneLiveRun> liveKeyInstances(const std::vector<GpuScenePlacement>& placements,
                                              const std::vector<GpuSceneLiveAsset>& assets,
                                              const GpuSceneCamera& camera) {
    std::vector<GpuSceneLiveRun> runs;
    for (const GpuScenePlacement& placement : placements) {
        if (placement.slot < 0 || static_cast<std::size_t>(placement.slot) >= assets.size())
            continue;
        const GpuSceneLiveAsset& held = assets[static_cast<std::size_t>(placement.slot)];
        const float* at = placement.centre.data();
        const double radius = at[3];
        bool visible = true;
        for (int plane = 0; plane < 6; plane += 1) {
            const std::size_t offset = static_cast<std::size_t>(plane) * 4;
            const double signedDistance = static_cast<double>(camera.planes[offset]) * at[0] +
                                          static_cast<double>(camera.planes[offset + 1]) * at[1] +
                                          static_cast<double>(camera.planes[offset + 2]) * at[2] +
                                          camera.planes[offset + 3];
            if (signedDistance < -radius) {
                visible = false;
                break;
            }
        }
        if (!visible)
            continue;
        const double distance =
            jsHypot(static_cast<double>(at[0]) - camera.x, static_cast<double>(at[2]) - camera.z);
        if (held.hasCull && distance > held.cull)
            continue;
        const int32_t level =
            levelAtGatesCore(held.distances, held.impostor, lod::biasedLodDistance(distance), placement.scale);
        if (level < 0 || static_cast<std::size_t>(level) >= held.locals.size())
            continue;
        const std::vector<std::array<float, kGpuSceneLocalWords>>& parts = held.locals[static_cast<std::size_t>(level)];
        for (std::size_t part = 0; part < parts.size(); part += 1) {
            const std::string key = std::string(held.id) + ":" + std::to_string(level) + ":" + std::to_string(part);
            std::size_t run = runs.size();
            for (std::size_t candidate = 0; candidate < runs.size(); candidate += 1)
                if (runs[candidate].key == key) {
                    run = candidate;
                    break;
                }
            if (run == runs.size()) {
                GpuSceneLiveRun created;
                created.key = key;
                runs.push_back(std::move(created));
                run = runs.size() - 1;
            }
            std::array<float, kGpuSceneLocalWords> matrix{};
            compose(placement.matrix.data(), parts[part].data(), matrix.data(), 0);
            runs[run].words.insert(runs[run].words.end(), matrix.begin(), matrix.end());
        }
    }
    return runs;
}

} // namespace tn::engine::world
