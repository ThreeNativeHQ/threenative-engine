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
    Bone(const Bone&) = delete;
    Bone& operator=(const Bone&) = delete;

    [[nodiscard]] std::string_view type() const override { return "Bone"; }

    /** three's `isBone`, the flag `Skeleton.pose` reads on a parent. */
    bool isBone = true;
};

/**
 * three's Skeleton. `bones` holds one shared Bone per slot; a null slot is three's `undefined`
 * entry, which `calculateInverses`, `pose` and `update` all skip or fill with the identity.
 */
class Skeleton {
  public:
    Skeleton() = default;
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
    /** The first bone whose name matches, or null. A null slot is skipped, never dereferenced. */
    [[nodiscard]] Bone* getBoneByName(std::string_view name) const;

    // Weak: the scene graph owns bones. A SkinnedMesh often sits under its own bones, so a strong
    // reference would make mesh -> skeleton -> bone -> ... -> mesh a cycle that never frees (three's
    // GC collects it). A bone nothing else holds reads as three's `undefined` slot.
    std::vector<std::weak_ptr<Bone>> bones;
    [[nodiscard]] Bone* bone(std::size_t i) const { return i < bones.size() ? bones[i].lock().get() : nullptr; }
    std::vector<Matrix4> boneInverses;
    /** `bones.size() * 16` floats, column-major per slot, three's flat `boneMatrices`. */
    std::vector<float> boneMatrices;
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
    Vector3& getVertexPosition(uint64_t index, Vector3& target) const override;
    Vector3& applyBoneTransform(uint64_t index, Vector3& target) const;
    void computeBoundingBox();
    std::shared_ptr<Box3> boundingBox;
    std::shared_ptr<Skeleton> skeleton;
    bool attached = true; // bindMode: "attached" (true) or "detached"
    Matrix4 bindMatrix;
    Matrix4 bindMatrixInverse;

  protected:
    const Box3& cachedBounds() override;
};

/** SkeletonUtils.clone: copy the hierarchy, share mesh resources, remap each skin to cloned bones.
 * Unsupported node kinds and bones outside the supplied root fail by name. */
std::shared_ptr<Object3D> cloneSkeleton(const Object3D& source, std::string& error);
/** Object3D.clone(recursive): three's `new this.constructor().copy(this, recursive)`. Meshes share
 *  their geometry and material, and a SkinnedMesh keeps its source's skeleton (only SkeletonUtils
 *  remaps bones). Null, with `error` naming the kind, for a class whose copy is not ported. */
std::shared_ptr<Object3D> cloneObject(const Object3D& source, bool recursive, std::string& error);

} // namespace tn::engine
