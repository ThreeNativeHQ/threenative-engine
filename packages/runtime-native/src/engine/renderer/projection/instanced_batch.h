#pragma once

// InstancedBatch's decisions, ported from packages/core/src/instanced-batch.ts (`InstancedBatch`,
// 274 lines) and packages/core/src/instanced-batch-lod.ts (`attachInstancedLod`, `spatialPartitions`)
// by PRD-519: which placements a batch holds, the matrix each one composes, the mesh it builds or
// refuses to build, the render partition and LOD level every placement draws at, and every refusal
// with its reason code. Nothing here decides how a prop looks: the shape, the surface and every
// transform are the game's.
//
// CPU only. The meshes it builds are scene nodes with instance buffers, like the reference's
// InstancedMesh; no GPU object is created and no draw is issued. Selection reuses the ported
// `lod::selectLodLevel` and its view math, so a level chosen here is three's, bit for bit.
//
// Where the reference throws, this answers a refused `Verdict` carrying one of the `TN_BATCH_*`
// codes: engine code never throws. A refusal happens in the reference's order, so one bad placement
// never shifts a later instance index.
//
// Not ported, and why:
//   - `pooledMesh`'s reuse (packages/core/src/render/mesh-pool.ts): the pool exists because WebGPU
//     keys an instanced mesh's compiled program by its own uuid, so a reused buffer keeps a shader a
//     fresh one rebuilds. What a decision can read of it is the minted capacity, which is ported
//     (`kMeshPoolMinCapacity` rounded up to a power of two); the reuse is a renderer concern.
//   - `console.warn`: the two `TN_INSTANCED_LOD_*` reports come back as `Build::warnings`, since the
//     engine has no console and a warning nobody can read is not a report.
//   - `mesh.raycast` and the carrier swap around it: InstancedMesh raycasting is not ported
//     (see engine/scene/object3d.h), and an instance query is not a batching decision.
//   - `lodChainOf(geometry)`: the baked chain is an input here (`LodChain`), because the native
//     loader that reads `TN_discrete_lod` out of a glTF primitive is PRD-515's work.
//   - `release`, the `dispose` listener: nothing here owns a GPU resource, so there is nothing to
//     release. The partitions live as long as the batch.

#include <cstdint>
#include <memory>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

#include "engine/foundation/math/Euler.h"
#include "engine/foundation/math/Matrix.h"
#include "engine/foundation/math/Primitives.h"
#include "engine/foundation/math/Quaternion.h"
#include "engine/foundation/math/Vector.h"
#include "engine/renderer/lod/model_lod.h"
#include "engine/scene/camera.h"
#include "engine/scene/geometry.h"
#include "engine/scene/material.h"
#include "engine/scene/nodes.h"

namespace tn::engine::projection {

/** The geometry is the game's: a batch that draws none is refused by this name. */
inline constexpr std::string_view kBatchGeometryCode = "TN_BATCH_GEOMETRY_REQUIRED";
/** So is the surface: the batch never chooses one. */
inline constexpr std::string_view kBatchMaterialCode = "TN_BATCH_MATERIAL_REQUIRED";
/** A placement after `build`, whose instance count is now fixed. */
inline constexpr std::string_view kBatchClosedCode = "TN_BATCH_CLOSED";
/** A second `build` on one batch. */
inline constexpr std::string_view kBatchBuiltCode = "TN_BATCH_ALREADY_BUILT";
/** A position, rotation or scale that is not a [x, y, z] triple. */
inline constexpr std::string_view kBatchTripleCode = "TN_BATCH_TRIPLE";
/** A component that is not a finite number. */
inline constexpr std::string_view kBatchFiniteCode = "TN_BATCH_NOT_FINITE";
/** A span radius that is not a positive finite number. */
inline constexpr std::string_view kBatchRadiusCode = "TN_BATCH_RADIUS";
/** Span endpoints at the same point, so there is no direction to face. */
inline constexpr std::string_view kBatchSpanCode = "TN_BATCH_SPAN_POINT";
/** Automatic selection asked for a non-positive budget or a hysteresis outside [0, 1). */
inline constexpr std::string_view kBatchAutoLodCode = "TN_BATCH_AUTO_LOD";
/** Authored levels whose distances are not positive and strictly increasing. */
inline constexpr std::string_view kBatchLodDistancesCode = "TN_BATCH_LOD_DISTANCES";

/** MIN_SPAN: shorter than this, `from` and `to` are the same point. */
inline constexpr double kMinSpan = 1e-5;
/** INSTANCED_LOD_MAX_PIXEL_ERROR: an instanced prop's projected error budget, in raster pixels. */
inline constexpr double kInstancedLodMaxPixelError = 4;
/** MESH_POOL_MIN_CAPACITY: the smallest instance buffer a batch ever mints. */
inline constexpr uint32_t kMeshPoolMinCapacity = 64;

/** One placement's authored numbers, as `IInstancedPlacement`: the spans stand in for its tuples. */
struct Placement {
    /** Required: a [x, y, z] triple of finite numbers. */
    std::span<const double> position;
    /** Empty: no rotation. Otherwise a [x, y, z] triple of finite numbers, in radians. */
    std::span<const double> rotation;
    /** True when `scale` was one number for all three axes, as the reference's union allows. */
    bool uniformScale = false;
    /** The uniform scale, when `uniformScale`. */
    double scale = 1;
    /** The per-axis scale, when not `uniformScale`: a [x, y, z] triple of finite numbers. */
    std::span<const double> scaleAxes;
};

/** One baked discrete chain, as `ILodChain`: LOD0 is the base, then one level per index range. */
struct LodChain {
    std::vector<std::shared_ptr<BufferGeometry>> levels;
    /** Absolute projected errors, LOD0 first; `levels[0]` carries 0, as `selectLodLevel` requires. */
    std::vector<double> errors;
};

/** One authored rung. A null geometry is the unavailable rung the reference warns about once. */
struct AuthoredLod {
    double distance = 0;
    std::shared_ptr<BufferGeometry> geometry;
};

/** `IInstancedBatchOptions` plus `IInstancedLodOptions`, as the batch holds them. */
struct BatchOptions {
    std::shared_ptr<BufferGeometry> geometry;
    std::shared_ptr<Material> material;
    /** Unset selects automatically at `maxPixelError`; false leaves detail to the caller. */
    std::optional<bool> autoLod;
    /** Read when `autoLod` is not false. */
    double maxPixelError = kInstancedLodMaxPixelError;
    double hysteresis = lod::kDiscreteLodDefaultHysteresis;
    /** The baked chain, when this geometry carries one. Authored levels win over it. */
    std::optional<LodChain> chain;
    /** Authored distance levels. */
    std::optional<std::vector<AuthoredLod>> lods;
};

/** A call's outcome: refused, and by which name. Nothing else about the call happened. */
struct Verdict {
    bool ok = true;
    std::string reasonCode;

    static Verdict refuse(std::string_view code) { return {false, std::string(code)}; }
};

/** `IInstancedBatchBuildOptions`. Every default is three's own. */
struct BuildOptions {
    std::optional<bool> castShadow;
    std::optional<bool> receiveShadow;
    std::optional<std::string> name;
    Object3D* parent = nullptr;
    /** An existing mesh to refill instead of minting one, as the reference's `into`. */
    InstancedMesh* into = nullptr;
    /** Instance slots to mint when a new mesh is made. Default: the placement count. */
    std::optional<uint32_t> capacity;
};

/** What `build` decided: the mesh it made or refused to make, its counts, and its reports. */
struct Build {
    Verdict verdict;
    /** The mesh it built, or null when nothing was placed: the reference answers `undefined`. */
    InstancedMesh* mesh = nullptr;
    /** Non-null only when this call minted the mesh; an `into` mesh stays the caller's to own. */
    std::shared_ptr<InstancedMesh> minted;
    uint32_t count = 0;  // instances that draw
    uint32_t slots = 0;  // instanceMatrix.count: the buffer's width, minted or refilled
    std::vector<std::string> warnings;
};

/** One render partition's frame decision, as `draws(root)` reads a child of the batch mesh. */
struct Partition {
    uint32_t cell = 0;
    uint32_t level = 0;
    uint32_t count = 0;      // instances drawn; a zero partition stays visible and is still listed
    uint32_t indexCount = 0; // the level geometry's index count, or its position count
    bool visible = false;
    bool castShadow = false;
    bool receiveShadow = false;
    /** Present once a non-zero count has computed it, as `child.boundingSphere` is. */
    std::optional<Sphere> boundingSphere;
};

/** One frame's selection for one batch: the triangles, and every partition that drew. */
struct LodUpdate {
    Verdict verdict;
    double triangles = 0;
    /** In child order: spatial cells, then levels within a cell. */
    std::vector<Partition> partitions;
};

/**
 * Collapses many copies of one shape into a single draw, without knowing the count up front.
 *
 * It decides nothing about how the result looks. The shape, the surface and every transform are the
 * game's, and the built mesh is handed back so the game can keep animating instances by index.
 */
class InstancedBatch {
  public:
    /** The reference's constructor: it needs the game's geometry and material, or it refuses. */
    static std::unique_ptr<InstancedBatch> create(BatchOptions options, Verdict& verdict);
    ~InstancedBatch();
    InstancedBatch(const InstancedBatch&) = delete;
    InstancedBatch& operator=(const InstancedBatch&) = delete;

    /** How many instances have been placed so far. */
    [[nodiscard]] uint32_t count() const { return static_cast<uint32_t>(matrices_.size()); }
    /** The built mesh, or null before `build` — never a guess. */
    [[nodiscard]] InstancedMesh* mesh() const { return mesh_; }
    /** The placed matrices, in placement order: what a caller packs into one shared buffer reads. */
    [[nodiscard]] const std::vector<Matrix4>& matrices() const { return matrices_; }
    /** The render partitions, in child order, after a build that made any. */
    [[nodiscard]] const std::vector<std::shared_ptr<InstancedMesh>>& partitions() const {
        return children_;
    }

    /** Records one instance from a matrix the game composed itself, and answers its index. */
    Verdict add(const Matrix4& matrix, uint32_t& index);
    /** Records one instance from position, scale and Euler rotation, and answers its index. */
    Verdict place(const Placement& placement, uint32_t& index);
    /**
     * Records one instance stretched between two points, and answers its index.
     *
     * Chains, tie rods, railing bars, struts and cables are all "from A to B" rather than "at P with
     * rotation R", so the orientation is derived here instead of at every call site.
     */
    Verdict span(std::span<const double> from, std::span<const double> to, double radius, uint32_t& index);
    /** True when this batch holds element for element the matrices of `other`. */
    [[nodiscard]] bool equals(const InstancedBatch* other) const;
    /**
     * Writes every placed matrix into `target` (float32, as `instanceMatrix.array` is), starting at
     * instance `offset`, and answers how many were written.
     */
    uint32_t writeMatrices(std::vector<float>& target, uint32_t offset) const;

    /** Turns everything placed so far into one instanced mesh, and attaches its LOD partitions. */
    Build build(const BuildOptions& options = {});

    /**
     * One frame's selection for this camera and viewport: which partition and level each placement
     * draws at, and the triangles that submits. A refused selection leaves the counts as they were.
     */
    LodUpdate updateLod(Camera& camera, double viewportHeight);

  private:
    explicit InstancedBatch(BatchOptions options);

    /** requireTriple, over a span. An empty span is the caller's own default, not a refusal. */
    static Verdict readTriple(std::span<const double> value, Vector3& out);
    /** #assertOpen: a placement after the build, whose instance count is now fixed. */
    Verdict open();
    /** attachInstancedLod: validates the policy, builds the levels and mints the partitions. */
    Verdict attachLod(std::vector<std::string>& warnings);
    /** spatialPartitions: split the public slots along the measured longest axis. */
    std::vector<std::vector<uint32_t>> spatialPartitions(uint32_t limit) const;
    void splitPartitions(std::vector<uint32_t>& indices, uint32_t limit,
                         std::vector<std::vector<uint32_t>>& groups) const;
    /** The reference's controller update: every public slot through this frame's selection. */
    LodUpdate selectLods(Camera& camera, double viewportHeight);

    BatchOptions options_;
    std::vector<Matrix4> matrices_;
    std::shared_ptr<InstancedMesh> minted_; // the mesh this batch owns, when it minted one
    InstancedMesh* mesh_ = nullptr;          // the mesh it draws into, minted or refilled
    bool built_ = false;

    Object3D scratch_; // the reference's #scratch, and the #direction/#midpoint/#rotation below
    Vector3 direction_;
    Vector3 midpoint_;
    Quaternion rotation_;

    // The LOD state the reference closes over in `attachInstancedLod`.
    std::shared_ptr<BufferGeometry> base_;
    std::vector<std::shared_ptr<BufferGeometry>> levels_;
    std::vector<double> distances_;
    std::shared_ptr<BufferGeometry> carrier_;
    std::vector<std::vector<uint32_t>> groups_;
    std::vector<uint32_t> partitionOf_;
    std::vector<int> states_;
    std::vector<std::shared_ptr<InstancedMesh>> children_;
    Sphere local_;
};

/**
 * updateModelLods: takes every batch under `root` through this frame's selection and answers the
 * triangles they will submit. A batch is found by the mesh it built, so a mesh that leaves the graph
 * and comes back takes part again. The answer is a JS-shaped number, as the reference's is.
 */
double updateInstancedLods(Object3D& root, Camera& camera, double viewportHeight);

} // namespace tn::engine::projection
