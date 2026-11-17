#pragma once

// PRD-898 J3: an instanced batch's per-frame LOD sort, shared by the engine's own InstancedBatch
// (renderer/projection/instanced_batch.cpp) and core's `attachInstancedLod`, which reaches it in one
// call (`__tnInstancedLodUpdate`, abi/bindings_scene.cpp) instead of three crossings per instance.
//
// The selection is packages/core/src/instanced-batch-lod.ts `controller.update`, operation for
// operation. One addition: a frame whose levels, source matrices and mesh transform all match the
// previous frame leaves the partitions as they are, so a settled batch re-uploads nothing.

#include <array>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <optional>
#include <vector>

#include "engine/foundation/math/Matrix.h"
#include "engine/foundation/math/Primitives.h"
#include "engine/scene/camera.h"
#include "engine/scene/nodes.h"

namespace tn::engine::lod {

/** What an instanced batch's selection keeps between frames. */
struct InstancedLodState {
    /** partition * levelCount + level, as the reference mints them. */
    std::vector<std::shared_ptr<InstancedMesh>> children;
    std::size_t levelCount = 0;
    /** Authored switch distances, first 0; empty when the baked chain selects. */
    std::vector<double> distances;
    /** The baked chain's absolute errors when no authored levels exist. */
    std::optional<std::vector<double>> chainErrors;
    double budget = 4;
    double hysteresis = 0.15;
    std::vector<uint32_t> partitionOf;
    std::vector<int> states;
    Sphere local;

    // The settled check: what the last sort read. The source bytes are compared, not a version, because
    // a game may write the attribute's array in place without raising `needsUpdate`.
    bool sorted = false;
    uint32_t sourceCount = 0;
    std::vector<std::byte> sourceBytes;
    std::vector<std::byte> colorBytes;
    std::array<double, 16> meshWorld{};
    std::vector<int> scratch;
};

/**
 * Sorts every drawn instance of `mesh` into its partition's child at this frame's level and answers
 * the triangles the children will submit. Returns false, leaving every count as it was, when the
 * chain's selection refuses (the reference throws there).
 */
bool selectInstancedLods(InstancedMesh& mesh, InstancedLodState& state, Camera& camera, double viewportHeight,
                         double& triangles);

} // namespace tn::engine::lod
