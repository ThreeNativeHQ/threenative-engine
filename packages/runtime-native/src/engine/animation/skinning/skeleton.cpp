// Bone and Skeleton (PRD-518 phase 1): three@0.185.1 src/objects/Bone.js and Skeleton.js, method
// for method, over the ported Object3D and Matrix4. Skeleton never throws; a null bone slot is
// three's `undefined`, skipped by pose and replaced by the identity in update.

#include "engine/animation/skinning/skeleton.h"

#include <cstddef>
#include <cmath>
#include <functional>
#include <unordered_map>
#include <utility>
#include <stdexcept>

namespace tn::engine {

Skeleton::Skeleton(std::vector<std::shared_ptr<Bone>> bones, std::vector<Matrix4> boneInverses)
    : bones(bones.begin(), bones.end()), boneInverses(std::move(boneInverses)) {
    init();
}

void Skeleton::init() {
    boneMatrices.assign(bones.size() * 16, 0.0f);

    if (boneInverses.empty()) {
        calculateInverses();
    } else if (bones.size() != boneInverses.size()) {
        // three warns and rebuilds one identity per bone.
        boneInverses.assign(bones.size(), Matrix4{});
    }
}

void Skeleton::calculateInverses() {
    boneInverses.clear();
    for (std::size_t i = 0; i < bones.size(); ++i) {
        Matrix4 inverse;
        if (Bone* b = bone(i)) inverse.copy(b->matrixWorld).invert();
        boneInverses.push_back(inverse);
    }
}

void Skeleton::pose() {
    // Recover the bind-time world matrices.
    for (std::size_t i = 0; i < bones.size(); ++i) {
        if (Bone* b = bone(i)) b->matrixWorld.copy(boneInverses[i]).invert();
    }

    // Compute the local matrices, positions, rotations and scales.
    for (std::size_t i = 0; i < bones.size(); ++i) {
        Bone* bone = this->bone(i);
        if (bone == nullptr) continue;
        if (bone->parent != nullptr && dynamic_cast<Bone*>(bone->parent) != nullptr) {
            bone->matrix.copy(bone->parent->matrixWorld).invert();
            bone->matrix.multiply(bone->matrixWorld);
        } else {
            bone->matrix.copy(bone->matrixWorld);
        }
        bone->matrix.decompose(bone->position, bone->quaternion, bone->scale);
    }
}

void Skeleton::update() {
    static const Matrix4 identity{};
    Matrix4 offset;
    for (std::size_t i = 0; i < bones.size(); ++i) {
        const Bone* b = bone(i);
        const Matrix4& matrix = b ? b->matrixWorld : identity;
        offset.multiplyMatrices(matrix, boneInverses[i]);
        for (std::size_t k = 0; k < 16; ++k)
            boneMatrices[i * 16 + k] = static_cast<float>(offset.elements[k]);
    }
}

Bone* Skeleton::getBoneByName(std::string_view name) const {
    for (std::size_t i = 0; i < bones.size(); ++i) {
        if (Bone* b = bone(i); b && b->name == name) return b;
    }
    return nullptr;
}

void SkinnedMesh::bind(std::shared_ptr<Skeleton> next, const Matrix4* matrix) {
    skeleton = std::move(next);
    if (matrix == nullptr) {
        updateMatrixWorld(true);
        if (skeleton) skeleton->calculateInverses();
        matrix = &matrixWorld;
    }
    bindMatrix.copy(*matrix);
    bindMatrixInverse.copy(*matrix).invert();
}

void SkinnedMesh::updateMatrixWorld(bool force) {
    Mesh::updateMatrixWorld(force);
    if (attached) bindMatrixInverse.copy(matrixWorld).invert();
    else bindMatrixInverse.copy(bindMatrix).invert();
}

Vector3& SkinnedMesh::getVertexPosition(uint64_t index, Vector3& target) const {
    Mesh::getVertexPosition(index, target);
    return applyBoneTransform(index, target);
}

Vector3& SkinnedMesh::applyBoneTransform(uint64_t index, Vector3& target) const {
    const auto indices = geometry->attributes.at("skinIndex");
    const auto weights = geometry->attributes.at("skinWeight");
    Vector4 base(target.x, target.y, target.z, 1), vertex;
    base.applyMatrix4(bindMatrix);
    target.set(0, 0, 0);
    Matrix4 matrix;
    Vector3 xyz;
    for (int i = 0; i < 4; ++i) {
        const double weight = weights->getComponent(index, i);
        if (weight == 0) continue;
        const double boneIndex = indices->getComponent(index, i);
        if (!skeleton || !std::isfinite(boneIndex) || boneIndex < 0 ||
            boneIndex != std::floor(boneIndex) || boneIndex >= skeleton->bones.size() ||
            boneIndex >= skeleton->boneInverses.size() || !skeleton->bone(size_t(boneIndex)))
            throw std::out_of_range("SkinnedMesh.applyBoneTransform needs a valid bone index");
        const auto j = size_t(boneIndex);
        matrix.multiplyMatrices(skeleton->bone(j)->matrixWorld, skeleton->boneInverses[j]);
        vertex.copy(base).applyMatrix4(matrix);
        target.addScaledVector(xyz.set(vertex.x, vertex.y, vertex.z), weight);
    }
    return target.applyMatrix4(bindMatrixInverse);
}

void SkinnedMesh::computeBoundingBox() {
    if (!boundingBox) boundingBox = std::make_shared<Box3>();
    boundingBox->makeEmpty();
    const auto position = geometry->attributes.at("position");
    Vector3 vertex;
    for (uint64_t i = 0; i < position->count(); ++i)
        boundingBox->expandByPoint(getVertexPosition(i, vertex));
}

const Box3& SkinnedMesh::cachedBounds() {
    if (!boundingBox) computeBoundingBox();
    return *boundingBox;
}

std::shared_ptr<Object3D> cloneObject(const Object3D& source, bool recursive, std::string& error) {
    error.clear();
    const std::function<std::shared_ptr<Object3D>(const Object3D&)> clone = [&](const Object3D& from) -> std::shared_ptr<Object3D> {
        std::shared_ptr<Object3D> to;
        const auto kind = from.type();
        if (kind == "Scene") {
            auto scene = std::make_shared<Scene>();
            scene->copy(static_cast<const Scene&>(from));
            to = std::move(scene);
        } else {
            if (kind == "Object3D") to = std::make_shared<Object3D>();
            else if (kind == "Group") to = std::make_shared<Group>();
            else if (kind == "Bone") to = std::make_shared<Bone>();
            else if (kind == "Mesh") {
                const auto& mesh = static_cast<const Mesh&>(from);
                auto next = std::make_shared<Mesh>(mesh.geometry, mesh.material);
                next->morphTargetInfluences = mesh.morphTargetInfluences;
                to = std::move(next);
            } else if (kind == "Line" || kind == "LineSegments") {
                // three's Line.copy: the same geometry and material.
                const auto& line = static_cast<const Line&>(from);
                if (kind == "Line") to = std::make_shared<Line>(line.geometry, line.material);
                else to = std::make_shared<LineSegments>(line.geometry, line.material);
            } else if (kind == "SkinnedMesh") {
                // three's SkinnedMesh.copy: bindMode, both bind matrices and the same skeleton.
                const auto& mesh = static_cast<const SkinnedMesh&>(from);
                auto next = std::make_shared<SkinnedMesh>(mesh.geometry, mesh.material);
                next->morphTargetInfluences = mesh.morphTargetInfluences;
                next->attached = mesh.attached;
                next->bindMatrix.copy(mesh.bindMatrix);
                next->bindMatrixInverse.copy(mesh.bindMatrixInverse);
                next->skeleton = mesh.skeleton;
                if (mesh.boundingBox) next->boundingBox = std::make_shared<Box3>(*mesh.boundingBox);
                to = std::move(next);
            } else {
                error = "TN_NATIVE_CLONE_UNSUPPORTED: " + std::string(kind);
                return nullptr;
            }
            to->copy(from);
        }
        if (recursive)
            for (const auto* child : from.children) {
                auto next = clone(*child);
                if (!next) return nullptr;
                to->add(*next);
            }
        return to;
    };
    return clone(source);
}

std::shared_ptr<Object3D> cloneSkeleton(const Object3D& source, std::string& error) {
    error.clear();
    std::unordered_map<const Object3D*, std::shared_ptr<Object3D>> copies;
    const std::function<std::shared_ptr<Object3D>(const Object3D&)> clone = [&](const Object3D& from) -> std::shared_ptr<Object3D> {
        std::shared_ptr<Object3D> to;
        const auto kind = from.type();
        if (kind == "Object3D") to = std::make_shared<Object3D>();
        else if (kind == "Group") to = std::make_shared<Group>();
        else if (kind == "Bone") to = std::make_shared<Bone>();
        else if (kind == "Mesh" || kind == "SkinnedMesh") {
            const auto& mesh = static_cast<const Mesh&>(from);
            std::shared_ptr<Mesh> next = kind == "Mesh"
                ? std::make_shared<Mesh>(mesh.geometry, mesh.material)
                : std::static_pointer_cast<Mesh>(std::make_shared<SkinnedMesh>(mesh.geometry, mesh.material));
            next->morphTargetInfluences = mesh.morphTargetInfluences;
            to = std::move(next);
        } else {
            error = "TN_NATIVE_SKELETON_CLONE_UNSUPPORTED: " + std::string(kind);
            return nullptr;
        }
        to->copy(from);
        copies.emplace(&from, to);
        for (const auto* child : from.children) {
            auto next = clone(*child);
            if (!next) return nullptr;
            to->add(*next);
        }
        return to;
    };
    auto root = clone(source);
    if (!root) return nullptr;
    for (const auto& [from, to] : copies) {
        if (from->type() != "SkinnedMesh") continue;
        const auto& mesh = static_cast<const SkinnedMesh&>(*from);
        auto& next = static_cast<SkinnedMesh&>(*to);
        next.attached = mesh.attached;
        next.bindMatrix.copy(mesh.bindMatrix);
        next.bindMatrixInverse.copy(mesh.bindMatrixInverse);
        if (mesh.boundingBox) next.boundingBox = std::make_shared<Box3>(*mesh.boundingBox);
        if (!mesh.skeleton) continue;
        std::vector<std::shared_ptr<Bone>> bones;
        for (size_t i = 0; i < mesh.skeleton->bones.size(); ++i) {
            const auto* bone = mesh.skeleton->bone(i);
            if (bone == nullptr) { bones.push_back(nullptr); continue; }
            const auto found = copies.find(bone);
            if (found == copies.end() || found->second->type() != "Bone") {
                error = "TN_NATIVE_SKELETON_CLONE_EXTERNAL_BONE: " + bone->name;
                return nullptr;
            }
            bones.push_back(std::static_pointer_cast<Bone>(found->second));
        }
        next.bind(std::make_shared<Skeleton>(std::move(bones), mesh.skeleton->boneInverses), &mesh.bindMatrix);
    }
    return root;
}

} // namespace tn::engine
