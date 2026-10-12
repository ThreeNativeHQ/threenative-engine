#pragma once

#include "engine/shader/ir.h"
#include "engine/world/gpu_scene/gpu_scene.h"

#include <cstdint>
#include <vector>

namespace tn::engine::world {

/**
 * The GPU-driven main and shadow passes' cull and LOD kernel (PRD-519 phase 3), ported from
 * WorldGpuScene's `#buildKernel` and `#buildShadowKernel` in packages/core/src/world-gpu-scene.ts.
 * `cullAndSelect` and `cullAndSelectShadow` (gpu_scene.h) are its oracle.
 *
 * Three dispatches, in order: clear (one thread per key zeroes its instance count), cull (one
 * thread per placement appends its matrix to each part of its level), clamp (one thread per key).
 * The clamp is native-only: the TS kernel leaves a count that outran its region's capacity, which
 * the draw then reads past the region; the oracle never counts past capacity, and neither does this.
 *
 * Storage, in binding order: params, matrices, centres, info, gates, levels, keys, locals, args,
 * drawn. `params[0]` = (placements, slots, keys, lod bias); `params[1]` = (eye x, eye z, shadow
 * texel gate, shadow base); `params[2..7]` = the six frustum planes.
 */
struct GpuSceneTables {
    std::vector<float> params;
    std::vector<float> matrices;
    std::vector<float> centres;
    std::vector<float> info;    // (slot, scale, 0, 0) per placement
    std::vector<float> gates;   // (first level row, levels, cull distance, has cull) per slot
    std::vector<float> levels;  // (gate distance, first key, parts, terminal impostor mark) per level
    std::vector<float> keys;    // (drawn start, capacity, args index, 0) per key
    std::vector<float> locals;  // the part's local matrix per key
    std::vector<uint32_t> args; // five words per draw; word 4 is the region's start, as the oracle has it
    uint32_t drawnCapacity = 0; // matrices
    uint32_t placements = 0;
    uint32_t keyCount = 0;
};

/** The kernel's tables for one dispatch; `shadow` null is the main pass, which reads `bias`. */
GpuSceneTables packGpuScene(const GpuSceneInput& input, const GpuSceneShadowLevel* shadow, double bias);

shader::Program gpuSceneClearKernel();
shader::Program gpuSceneCullKernel(bool shadow);
shader::Program gpuSceneClampKernel();

} // namespace tn::engine::world
