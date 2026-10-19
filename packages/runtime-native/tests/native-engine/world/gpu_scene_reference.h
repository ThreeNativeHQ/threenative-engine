#pragma once
// The recorded world-gpu-scene table (gpu_scene_reference.inc, written by gpu-scene-reference.ts) and
// the builders that turn its bit patterns into oracle inputs; shared by the oracle and kernel tests.

#include "engine/world/gpu_scene/gpu_scene.h"

#include <bit>
#include <cmath>
#include <cstddef>
#include <cstdint>

using namespace tn::engine::world;

namespace {

struct RefLevel {
    uint32_t firstKey;
    uint32_t parts;
};
struct RefSlot {
    const uint64_t* distances;
    std::size_t distanceCount;
    bool hasCull;
    uint64_t cull;
    const RefLevel* levels;
    std::size_t levelCount;
    bool impostor;
};
struct RefRegion {
    uint32_t start;
    uint32_t capacity;
    uint32_t argsIndex;
    uint32_t local[16];
    uint32_t indexCount;
};
struct RefPlacement {
    uint32_t matrix[16];
    uint32_t centre[4];
    int32_t slot;
    uint64_t scale;
};
struct RefCamera {
    uint32_t planes[24];
    uint64_t x, y, z;
};
struct RefShadow {
    uint32_t planes[24];
    uint64_t centreX, centreZ, gate;
    int32_t base;
};
struct RefRun {
    uint32_t count;
    const uint32_t* words;
};
struct RefStep {
    RefCamera camera;
    bool shadow;
    RefShadow shadowLevel;
    const uint32_t* args;
    const uint32_t* counts;
    const RefRun* runs;
    uint64_t bias;
};
struct RefScene {
    const RefPlacement* placements;
    std::size_t placementCount;
    uint32_t count;
    const RefSlot* slots;
    std::size_t slotCount;
    const RefRegion* regions;
    std::size_t regionCount;
    const RefStep* steps;
    std::size_t stepCount;
};
struct RefLiveLevel {
    const uint32_t* words;
    std::size_t partCount;
};
struct RefLiveAsset {
    const char* id;
    const uint64_t* distances;
    std::size_t distanceCount;
    bool hasCull;
    uint64_t cull;
    bool impostor;
    const RefLiveLevel* levels;
    std::size_t levelCount;
};
struct RefLiveRun {
    const char* key;
    const uint32_t* words;
    std::size_t wordCount;
};
struct RefLiveCase {
    const RefPlacement* placements;
    std::size_t placementCount;
    const RefLiveAsset* assets;
    std::size_t assetCount;
    RefCamera camera;
    const RefLiveRun* runs;
    std::size_t runCount;
};

#include "gpu_scene_reference.inc"

constexpr double doubleFromBits(uint64_t bits) { return std::bit_cast<double>(bits); }
constexpr float floatFromBits(uint32_t bits) { return std::bit_cast<float>(bits); }

// Bit-exact, except that every NaN is the same value: the reference is JavaScript, whose NaN
// payloads are not distinguishable, and an arithmetic NaN's sign bit is the hardware's.
bool sameFloat(float got, float want) {
    return std::bit_cast<uint32_t>(got) == std::bit_cast<uint32_t>(want) ||
           (std::isnan(got) && std::isnan(want));
}

GpuSceneSlot buildSlot(const RefSlot& ref) {
    GpuSceneSlot slot;
    slot.distances.reserve(ref.distanceCount);
    for (std::size_t i = 0; i < ref.distanceCount; ++i)
        slot.distances.push_back(doubleFromBits(ref.distances[i]));
    slot.hasCull = ref.hasCull;
    slot.cull = doubleFromBits(ref.cull);
    slot.levels.reserve(ref.levelCount);
    for (std::size_t i = 0; i < ref.levelCount; ++i)
        slot.levels.push_back(GpuSceneLevel{ref.levels[i].firstKey, ref.levels[i].parts});
    slot.impostor = ref.impostor;
    return slot;
}

GpuSceneRegion buildRegion(const RefRegion& ref) {
    GpuSceneRegion region;
    region.start = ref.start;
    region.capacity = ref.capacity;
    region.argsIndex = ref.argsIndex;
    for (std::size_t i = 0; i < 16; ++i)
        region.local[i] = floatFromBits(ref.local[i]);
    region.indexCount = ref.indexCount;
    return region;
}

GpuScenePlacement buildPlacement(const RefPlacement& ref) {
    GpuScenePlacement placement;
    for (std::size_t i = 0; i < 16; ++i)
        placement.matrix[i] = floatFromBits(ref.matrix[i]);
    for (std::size_t i = 0; i < 4; ++i)
        placement.centre[i] = floatFromBits(ref.centre[i]);
    placement.slot = ref.slot;
    placement.scale = doubleFromBits(ref.scale);
    return placement;
}

GpuSceneCamera buildCamera(const RefCamera& ref) {
    GpuSceneCamera camera;
    for (std::size_t i = 0; i < 24; ++i)
        camera.planes[i] = floatFromBits(ref.planes[i]);
    camera.x = doubleFromBits(ref.x);
    camera.y = doubleFromBits(ref.y);
    camera.z = doubleFromBits(ref.z);
    return camera;
}

GpuSceneShadowLevel buildShadow(const RefShadow& ref) {
    GpuSceneShadowLevel level;
    for (std::size_t i = 0; i < 24; ++i)
        level.planes[i] = floatFromBits(ref.planes[i]);
    level.centreX = doubleFromBits(ref.centreX);
    level.centreZ = doubleFromBits(ref.centreZ);
    level.gate = doubleFromBits(ref.gate);
    level.base = ref.base;
    return level;
}

} // namespace
