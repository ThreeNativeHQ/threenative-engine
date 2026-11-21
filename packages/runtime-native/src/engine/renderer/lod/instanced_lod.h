#pragma once

// PRD-898 J3: an instanced batch's per-frame LOD sort, shared by the engine's own InstancedBatch
// (renderer/projection/instanced_batch.cpp) and core's `attachInstancedLod`, which reaches it in one
// call (`__tnInstancedLodUpdate`, abi/bindings_scene.cpp) instead of three crossings per instance.
//
// The selection matches packages/core/src/instanced-batch-lod.ts `controller.update`, with
// per-partition dirty tracking, cached world bounding spheres, and O(1) uniform-partition skips so
// a partition whose instances keep their matrices, colours and LOD levels re-uploads nothing.

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
    /** Cached world-space bounding sphere and axis max-scale for one source instance. */
    struct CachedSphere {
        double cx = 0;
        double cy = 0;
        double cz = 0;
        double radius = 0;
        double maxScale = 1;
    };

    /** Center AABB of all source instances inside one spatial partition, for uniform-level skips. */
    struct PartitionBounds {
        double minX = 0;
        double minY = 0;
        double minZ = 0;
        double maxX = 0;
        double maxY = 0;
        double maxZ = 0;
    };

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

    // Per-partition caches populated once per topology/source change so stationary partitions skip repacking.
    std::vector<std::vector<uint32_t>> partitionIndices;
    std::vector<CachedSphere> cachedSpheres;
    std::vector<PartitionBounds> partitionBounds;
    std::vector<int> partitionUniformLevel;
    std::vector<double> childTriangles;
    std::vector<uint8_t> partitionDirty;
    std::vector<uint8_t> partitionSourceDirty;
    std::size_t cachedMatrixLen = 0;
    std::size_t cachedColorLen = 0;
    uint64_t cachedMatrixStoreId = 0;
    uint64_t cachedColorStoreId = 0;
    const void* cachedMaterialPtr = nullptr;
    double cachedLayerMask = -1;
    bool cachedCastShadow = false;
    bool cachedReceiveShadow = false;
    bool childMetaInitialized = false;
};

/**
 * Sorts every drawn instance of `mesh` into its partition's child at this frame's level and answers
 * the triangles the children will submit. Returns false, leaving every count as it was, when the
 * chain's selection refuses (the reference throws there). `bias` scales every switch distance, as
 * `biasedLodDistance` does: the engine's own `lodBias()`, or core's when core calls.
 */
bool selectInstancedLods(InstancedMesh& mesh, InstancedLodState& state, Camera& camera, double viewportHeight,
                         double bias, double& triangles);

} // namespace tn::engine::lod
