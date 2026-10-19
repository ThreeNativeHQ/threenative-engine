#pragma once

// The GPU scene's per-placement CPU oracle, ported from packages/core/src/world-gpu-scene.ts
// (PRD-521). This is `cullAndSelect` and its shadow form: the plain-TypeScript reference the TSL
// kernel mirrors line for line. It takes an already-built placement/slot/region table and answers
// which placements each key draws, with the `args`, `counts` and compacted `drawn` matrices a later
// GPU kernel is checked against. It loads no asset, owns no GPU resource and touches no three object.
//
// The port is operation for operation, because the differential fixture compares binary bits:
//   - Float32Array-backed values (placement matrices and centres, region locals, camera planes, the
//     `drawn` matrices) stay `float`; the reference reads an f32 and computes in double, so every
//     arithmetic step here widens to `double` and narrows once on store.
//   - Authored numbers (`distances`, `cull`, `scale`, the camera eye, a shadow gate) are JavaScript
//     numbers and stay `double`.
//   - `Math.hypot` is V8's own two-argument algorithm (`max * sqrt(1 + (min/max)^2)`), not
//     `std::hypot`: it was verified bit-identical over 400000 pairs.
//   - `Math.max`/`Math.min` propagate NaN and prefer +0 for a max and -0 for a min, unlike `std::max`.
// Engine code never throws; there is no throw, try or catch below.
//
// See packages/core/src/world-gpu-scene.ts's `cullAndSelect`, `cullAndSelectShadow`, `levelAtGates`,
// `drawableLevel` and `liveKeyInstances`. A shadow level's four numbers are `IShadowLevel`; the
// coarsest shadow base is `kCoarsestShadowLevel`.

#include <array>
#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace tn::engine::world {

/** `mat4` per drawn instance, and per region local: the placement times the part's own offset. */
inline constexpr std::size_t kGpuSceneLocalWords = 16;
/** `DrawIndexedIndirect`: indexCount, instanceCount, firstIndex, baseVertex, firstInstance. */
inline constexpr std::size_t kGpuSceneDrawArgsWords = 5;
/** The six frustum planes, four words each. */
inline constexpr std::size_t kGpuScenePlaneWords = 24;
/** A placement's asset slot is `-1` when its cell has left the ring, exactly as `SLOT_NONE`. */
inline constexpr int32_t kGpuSceneSlotNone = -1;
/** `IShadowLevel.base` past every chain: the map draws each asset's own coarsest shape. */
inline constexpr int32_t kCoarsestShadowLevel = 1 << 20;

/** One resident placement as the source buffer holds it: `mat4`, centre (xyz, radius), asset slot. */
struct GpuScenePlacement {
    std::array<float, kGpuSceneLocalWords> matrix{};
    std::array<float, 4> centre{};
    int32_t slot = kGpuSceneSlotNone;
    /** The uniform scale `info.y` carries; `levelAtGates` scales an impostor's terminal gate by it. */
    double scale = 1.0;
};

/** One level's run: the key its first part draws into and how many parts it has. */
struct GpuSceneLevel {
    uint32_t firstKey = 0;
    uint32_t parts = 0;
};

/** One asset's slots, as the kernel's gate table holds them. */
struct GpuSceneSlot {
    /** Level switch distances, ascending, `0` first. */
    std::vector<double> distances;
    /** `maxDistance` less its eighth, or absent for an asset with no cull distance. */
    bool hasCull = false;
    double cull = 0.0;
    /** Per level, index-aligned with `distances`. */
    std::vector<GpuSceneLevel> levels;
    /** Whether the last level is a whole-asset impostor whose gate the placement's scale scales. */
    bool impostor = false;
};

/** One key's region of the shared drawn buffer and the args record that counts it. */
struct GpuSceneRegion {
    uint32_t start = 0;
    uint32_t capacity = 0;
    uint32_t argsIndex = 0;
    std::array<float, kGpuSceneLocalWords> local{};
    uint32_t indexCount = 0;
};

/** The camera the kernel culls against: six planes and the eye the XZ distance is measured from. */
struct GpuSceneCamera {
    std::array<float, kGpuScenePlaneWords> planes{};
    double x = 0;
    double y = 0;
    double z = 0;
};

/** One shadow map's own four numbers, the whole of what it knows that the main camera does not. */
struct GpuSceneShadowLevel {
    std::array<float, kGpuScenePlaneWords> planes{};
    double centreX = 0;
    double centreZ = 0;
    /** The texel gate in world metres: a placement narrower than it casts nothing here. */
    double gate = 0;
    /** The chain level this map draws at, floored over the placement's own. */
    int32_t base = 0;
};

/** The whole of what a dispatch reads. */
struct GpuSceneInput {
    std::vector<GpuScenePlacement> placements;
    uint32_t count = 0;
    GpuSceneCamera camera;
    std::vector<GpuSceneSlot> slots;
    std::vector<GpuSceneRegion> regions;
    uint32_t regionCount = 0;
};

/** What one dispatch produced: the compacted survivors and the per-key instance counts. */
struct GpuSceneResult {
    /** `kGpuSceneDrawArgsWords` per region; word 1 is the instance count, word 4 the first instance. */
    std::vector<uint32_t> args;
    /** Instances drawn per region, which is what the args record's count must say. */
    std::vector<uint32_t> counts;
    /** The shared compaction buffer, `kGpuSceneLocalWords` per written instance. */
    std::vector<float> drawn;
};

/** One resident asset holding live gate and part-offset data (`ILiveAsset`). */
struct GpuSceneLiveAsset {
    std::string_view id;
    /** Index-aligned with `locals`; never a copy of a table the scene itself wrote. */
    std::vector<double> distances;
    bool hasCull = false;
    double cull = 0.0;
    /** Per level: the parts, each part's own 16-word offset matrix inside the model. */
    std::vector<std::vector<std::array<float, kGpuSceneLocalWords>>> locals;
    bool impostor = false;
};

/** One key's full run of instances, in the reference Map's insertion order. */
struct GpuSceneLiveRun {
    std::string key;
    std::vector<float> words;
};

/**
 * The level one placement draws with, from an asset's gate table and the placement's own scale.
 * A whole-asset impostor's terminal gate is `base * |scale|`, floored one representable step past
 * the last source gate.
 */
int32_t levelAtGates(const GpuSceneSlot& slot, double distance, double scale);

/** The last level at or below `level` the scene can actually draw (a level with no parts is skipped). */
int32_t drawableLevel(const GpuSceneSlot& slot, int32_t level);

/** The per-placement kernel, in plain C++. */
GpuSceneResult cullAndSelect(const GpuSceneInput& input);

/** The same kernel with a shadow map's own frustum, centre, texel gate and base in place of the camera's. */
GpuSceneResult cullAndSelectShadow(const GpuSceneInput& input, const GpuSceneShadowLevel& level);

/**
 * Every placement's own key instances from the owner's live gates, as `liveKeyInstances` answers them:
 * a key named `id:level:part` and the `placement * part offset` matrices it is owed, in insertion order.
 */
std::vector<GpuSceneLiveRun> liveKeyInstances(const std::vector<GpuScenePlacement>& placements,
                                              const std::vector<GpuSceneLiveAsset>& assets,
                                              const GpuSceneCamera& camera);

} // namespace tn::engine::world
