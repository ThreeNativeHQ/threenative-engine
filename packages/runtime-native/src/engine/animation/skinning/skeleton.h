#pragma once

// Bone and Skeleton, ported from three@0.185.1 src/objects/Bone.js and src/objects/Skeleton.js
// (PRD-518 phase 1). A Bone is an Object3D marked for the rig; a Skeleton folds each bone's current
// world matrix against its inverse bind matrix into a flat float32 palette.
//
// The palette math is three's, bit for bit: each slot is `bone.matrixWorld * boneInverse`, and a
// missing bone (three's `undefined` in the bones array) contributes the identity instead. The
// matrices come from the existing Matrix4, so the fold is the same product three computes.
//
// Not ported, and why:
//   - `computeBoneTexture`, `dispose`, `boneTexture`: the GPU data texture is a renderer concern
//     (PRD-514/519), not the object model.
//   - `clone`, `fromJSON`, `toJSON`, `uuid`: serialization and cloning are out of scope, as in
//     Object3D.
//   - `warn` on a bone/inverse length mismatch: the native init rebuilds the identity list three's
//     warn accompanies, without the console line.
//   - `Skeleton` is neither copyable nor movable, matching its per-instance palette buffer.

#include <atomic>
#include <cstddef>
#include <memory>
#include <string_view>
#include <vector>

#include "engine/foundation/math/Matrix.h"
#include "engine/scene/nodes.h"
#include "engine/scene/object3d.h"

namespace tn::engine {

/** three's Bone: an Object3D whose `type` is "Bone" and whose `isBone` flag is true. */
class Bone : public Object3D {
  public:
    Bone() = default;
    ~Bone() override { localTransformWritten(); prepareLocalTransformWrite(); if (publication_) --publicationCount_; }
    /** Bumps the pose version of every skeleton that holds this bone (PRD-878). */
    void localTransformWritten() override {
        for (const auto& version : poseVersions_) version->fetch_add(1, std::memory_order_relaxed);
    }
    // Internal admission only: no production caller until a GPU consumer owns the scene plan.
    bool enableDeferredTransform();
    // The scene plan allocates once and uploads this whole stream; relocation revokes admission.
    bool enableDeferredTransform(std::shared_ptr<std::vector<float>> stream, std::size_t offset,
                                 std::shared_ptr<bool> valid);

    bool deferTransformValue(int component, const double* values);
    void materializeLocalTransform() override;
    void materializeWorldTransformIfPending();
    [[nodiscard]] bool hasDeferredTransformPublication() const override { return publication_; }
    void prepareLocalTransformWrite() override;
    void exposeLocalTransform() override;
    [[nodiscard]] const std::array<double, 10>& deferredTransformValues() const {
        if (poseObservationEnabled) { poseObservationEscapedValues = true; if (poseObserver) poseObserver(*this, 5); }
        return deferredTRS_;
    }
    mutable bool poseObservationEscapedValues = false; // A retained native reference can read any later interval.
    [[nodiscard]] bool hasDeferredTransform() const { return pending_; }

    Bone(const Bone&) = delete;
    Bone& operator=(const Bone&) = delete;

    [[nodiscard]] std::string_view type() const override { return "Bone"; }

    /** three's `isBone`, the flag `Skeleton.pose` reads on a parent. */
    bool isBone = true;
  private:
    friend class Skeleton;
    std::vector<std::shared_ptr<std::atomic<uint64_t>>> poseVersions_;  // one per skeleton that holds this bone
    std::array<double, 10> deferredTRS_{}; // position, quaternion, scale; original mixer doubles
    inline static std::size_t publicationCount_ = 0;
    bool deferred_ = false, pending_ = false, publication_ = false;
    std::shared_ptr<std::vector<float>> stream_;
    std::shared_ptr<bool> streamValid_;
    float* streamData_ = nullptr;
    std::size_t streamOffset_ = 0;


};

/**
 * three's Skeleton. `bones` holds one shared Bone per slot; a null slot is three's `undefined`
 * entry, which `calculateInverses`, `pose` and `update` all skip or fill with the identity.
 */
class Skeleton {
  public:
    Skeleton() = default;
    std::weak_ptr<bool> gpuSkinValidity;
    void revokeGpuSkinning() { if (const auto valid = gpuSkinValidity.lock()) *valid = false; }

    /**
     * `bones` is copied, as three's `bones.slice(0)`; `boneInverses` empty means "compute them",
     * exactly three's `boneInverses.length === 0` branch.
     */
    explicit Skeleton(std::vector<std::shared_ptr<Bone>> bones, std::vector<Matrix4> boneInverses = {});
    Skeleton(const Skeleton&) = delete;
    Skeleton& operator=(const Skeleton&) = delete;

    /** Rebuilds the flat palette buffer, then computes or validates the inverses, as three's `init`. */
    void init();
    /** Fills `boneInverses` from each bone's current `matrixWorld`; a null bone gets the identity. */
    void calculateInverses();
    /** Restores the bind pose into every bone's `matrixWorld`, local `matrix` and decomposed TRS. */
    void pose();
    /** Folds each bone's `matrixWorld` with its inverse into `boneMatrices`, as float32. */
    void update();
    // Internal renderer path, immediately after its world walk and before authored callbacks.
    void updateAfterWorldWalk(uint64_t firstEvaluation);
    /** Moves whenever a bone's local transform is written or the inverses or a bind change, and never on a world move
     *  alone: a rig that keeps it keeps its root-relative palette and its mesh-space box (PRD-878; UE 5.8.3:
     *  Engine/Source/Runtime/Engine/Private/Components/SkinnedMeshComponent.cpp:1514 sends bones only when marked). */
    [[nodiscard]] uint64_t poseVersion() const { return poseVersion_->load(std::memory_order_relaxed); }
    void markPoseChanged() { poseVersion_->fetch_add(1, std::memory_order_relaxed); }
    /** The first bone whose name matches, or null. A null slot is skipped, never dereferenced. */
    [[nodiscard]] Bone* getBoneByName(std::string_view name) const;

    // Weak: the scene graph owns bones. A SkinnedMesh often sits under its own bones, so a strong
    // reference would make mesh -> skeleton -> bone -> ... -> mesh a cycle that never frees (three's
    // GC collects it). A bone nothing else holds reads as three's `undefined` slot.
    std::vector<std::weak_ptr<Bone>> bones;
    // A lock is two atomic writes, on every bone of every rig every frame: the slot stays weak, its address is kept.
    [[nodiscard]] Bone* bone(std::size_t i) const { return i < bones.size() && !bones[i].expired() ? boneAddresses_[i] : nullptr; }
    std::vector<Matrix4> boneInverses;
    /** `bones.size() * 16` floats, column-major per slot, three's flat `boneMatrices`. */
    std::vector<float> boneMatrices;

    /** A bone's posed world position and the largest stretch of its world matrix; stretch -1 is a null slot. */
    struct PlanPose { Vector3 position; double stretch = -1; };
    /** Every bone's PlanPose, read once per `stamp` and shared by each mesh bound to this skeleton: the stress
     * lab's mannequin binds two meshes to one skeleton, and each read all 65 bones every frame (PRD-871). */
    const std::vector<PlanPose>& planPoses(uint64_t stamp);
    /** A fresh stamp for one planning pass. A pass that does not share one passes 0 and reads the bones itself. */
    static uint64_t nextPlanStamp();
    uint64_t planPoseBuilds = 0;
    /** Every bone's world position in the space `inverse` takes it to, once per `stamp` and `inverse`: the two meshes a
     *  mannequin binds share one skeleton and one bind space, so the plan transforms its bones once (PRD-872). */
    const std::vector<Vector3>& planCenters(uint64_t stamp, const Matrix4& inverse);

  private:
    std::shared_ptr<std::atomic<uint64_t>> poseVersion_ = std::make_shared<std::atomic<uint64_t>>(1);
    std::vector<Bone*> boneAddresses_;  // `bones` is set once, by the constructor
    std::vector<PlanPose> planPoses_;
    uint64_t planStamp_ = 0;
    std::vector<Vector3> centers_;
    std::array<double, 16> centerInverse_{};
    uint64_t centerStamp_ = 0;
};

/**
 * three's SkinnedMesh: a Mesh whose vertices follow `skeleton` through `skinIndex`/`skinWeight`.
 * `bindMatrix` is the mesh's world matrix when it was bound; in "attached" mode (the default)
 * `bindMatrixInverse` follows the mesh's own world matrix on every updateMatrixWorld, in
 * "detached" mode it stays the inverse of `bindMatrix`.
 */
class SkinnedMesh : public Mesh {
  public:
    using Mesh::Mesh;
    [[nodiscard]] std::string_view type() const override { return "SkinnedMesh"; }
    /** three's bind: without a matrix, the mesh's current world matrix after computing the inverses. */
    void bind(std::shared_ptr<Skeleton> skeleton, const Matrix4* bindMatrix = nullptr);
    void pose() { if (skeleton) skeleton->pose(); }
    void updateMatrixWorld(bool force = false) override;
    void afterMatrixWorld() override;
    Vector3& getVertexPosition(uint64_t index, Vector3& target) const override;
    [[nodiscard]] bool posesVertices() const override { return true; }
    Vector3& applyBoneTransform(uint64_t index, Vector3& target) const;
    void computeBoundingBox();
    /** Mesh-space box holding every skinned vertex, from each bone's posed position and the farthest
     * bind-pose vertex it weights (UE 5.8.3 fits skinned bounds to bones, not to skinned vertices).
     * The reach is measured once per geometry revision, so a call costs O(bones). False when a
     * vertex's weights do not sum to 1: the vertex then leaves the bones' hull. */
    bool boneReachBounds(Box3& target, uint64_t planStamp = 0) const;
    /** Boxes this mesh built from its bones; a rigid move under an unchanged pose adds none (PRD-872). */
    mutable uint64_t boneReachBoxBuilds = 0;
    std::shared_ptr<Box3> boundingBox;
    std::shared_ptr<Skeleton> skeleton;
    std::weak_ptr<bool> gpuSkinValidity;
    bool gpuBindExposed = false;
    void revokeGpuSkinning() { if (const auto valid = gpuSkinValidity.lock()) *valid = false; }
    void exposeGpuBind() { gpuBindExposed = true; revokeGpuSkinning(); }
    /** The renderer's root-relative palette for this mesh, kept while the pose version holds (PRD-878). */
    struct RelativeSlot {
        uint64_t pose = 0, hierarchy = 0;
        const Object3D* root = nullptr;     // the placement found at `hierarchy`; null refuses
        std::array<double, 16> anchor{};    // root^-1 * the first bone's world when `matrices` was written
        std::vector<float> matrices;        // bones x 16, root-relative
        std::vector<std::shared_ptr<const void>> nodes;  // the material graphs the verdict below was read from
        bool nodesHold = false;             // none of them reads local space
    };
    RelativeSlot relativeSlot;
    bool attached = true; // bindMode: "attached" (true) or "detached"
    Matrix4 bindMatrix;
    Matrix4 bindMatrixInverse;

  protected:
    const Box3& cachedBounds() override;

  private:
    mutable std::vector<double> boneReach_;
    mutable const void* boneReachGeometry_ = nullptr;
    mutable const void* boneReachSkeleton_ = nullptr;
    mutable uint64_t boneReachRevision_ = 0;
    mutable bool boneReachHolds_ = false;
    // The box the last call built, and what it was built from: a rig that moved rigidly builds it once. The box is
    // `inv(mesh world) * bone position` over the bones, so it is fixed by the local pose, the rig-relative root and
    // the mesh scale — the three things this key holds (PRD-872).
    mutable Box3 boneReachBox_;
    mutable std::array<double, 16> boneReachBoxRoot_{};
    mutable uint64_t boneReachBoxPose_ = 0, boneReachBoxStamp_ = 0;
    mutable double boneReachBoxScale_ = 0;
};

/** SkeletonUtils.clone: copy the hierarchy, share mesh resources, remap each skin to cloned bones.
 * Unsupported node kinds and bones outside the supplied root fail by name. */
std::shared_ptr<Object3D> cloneSkeleton(const Object3D& source, std::string& error);
/** Object3D.clone(recursive): three's `new this.constructor().copy(this, recursive)`. Meshes share
 *  their geometry and material, and a SkinnedMesh keeps its source's skeleton (only SkeletonUtils
 *  remaps bones). Null, with `error` naming the kind, for a class whose copy is not ported. */
std::shared_ptr<Object3D> cloneObject(const Object3D& source, bool recursive, std::string& error);

} // namespace tn::engine
