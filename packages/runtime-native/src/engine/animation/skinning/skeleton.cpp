// Bone and Skeleton (PRD-518 phase 1): three@0.185.1 src/objects/Bone.js and Skeleton.js, method
// for method, over the ported Object3D and Matrix4. Skeleton never throws; a null bone slot is
// three's `undefined`, skipped by pose and replaced by the identity in update.

#include "engine/animation/skinning/skeleton.h"
#include "engine/scene/lights.h"

#include <algorithm>
#include <cstddef>
#include <cmath>
#include <functional>
#include <unordered_map>
#include <utility>
#include <stdexcept>

namespace tn::engine {

bool Bone::enableDeferredTransform() {
    if (deferred_) return true;
    const auto* flags = ownTransformTracking();
    if (!flags || !flags[0] || flags[2] || !matrixAutoUpdate || !matrixWorldAutoUpdate || pivot) return false;
    deferredTRS_ = {position.x, position.y, position.z, quaternion.x, quaternion.y, quaternion.z,
                    quaternion.w, scale.x, scale.y, scale.z};
    deferred_ = true;
    if (!publication_) { publication_ = true; ++publicationCount_; }
    return true;
}

bool Bone::enableDeferredTransform(std::shared_ptr<std::vector<float>> stream, std::size_t offset,
                                   std::shared_ptr<bool> valid) {
    if (!stream || !valid || !*valid || offset > stream->size() || stream->size() - offset < 12) return false;
    if (stream_ && (stream_ != stream || streamOffset_ != offset || streamValid_ != valid)) return false;
    if (!enableDeferredTransform()) return false;
    stream_ = std::move(stream);
    streamValid_ = std::move(valid);
    streamOffset_ = offset;
    streamData_ = stream_->data();
    auto* packed = streamData_ + offset;
    std::fill_n(packed, 12, 0.0f);
    for (int i = 0; i < 3; ++i) packed[i] = float(deferredTRS_[i]);
    for (int i = 0; i < 4; ++i) packed[4 + i] = float(deferredTRS_[3 + i]);
    for (int i = 0; i < 3; ++i) packed[8 + i] = float(deferredTRS_[7 + i]);
    return true;
}

bool Bone::deferTransformValue(int component, const double* values) {
    if (!deferred_) return false;
    const auto* flags = ownTransformTracking();
    if (flags[2] || !matrixAutoUpdate || !matrixWorldAutoUpdate || pivot) return false;
    if (component != 0 && component != 3 && component != 7) return false;
    if (stream_ && (!*streamValid_ || stream_->data() != streamData_ ||
                    streamOffset_ > stream_->size() || stream_->size() - streamOffset_ < 12)) {
        prepareLocalTransformWrite();
        return false;
    }
    const int count = component == 3 ? 4 : 3;
    std::copy_n(values, count, deferredTRS_.begin() + component);
    if (stream_) {
        const int packedOffset = component == 0 ? 0 : component == 3 ? 4 : 8;
        for (int i = 0; i < count; ++i) streamData_[streamOffset_ + packedOffset + i] = float(values[i]);
    }
    pending_ = true;
    markLocalTransformDirty();
    matrixWorldNeedsUpdate = true;
    return true;
}

void Bone::materializeLocalTransform() {
    if (poseObserver) poseObserver(*this, 1);
    if (!pending_) return;
    pending_ = false;
    position.fromArray(deferredTRS_.data());
    quaternion.fromArray(deferredTRS_.data(), 3);
    scale.fromArray(deferredTRS_.data(), 7);
}

void Bone::prepareLocalTransformWrite() {
    materializeLocalTransform();
    deferred_ = false;
    if (streamValid_) *streamValid_ = false;
    stream_.reset();
    streamValid_.reset();
    streamData_ = nullptr;
}

void Bone::exposeLocalTransform() {
    prepareLocalTransformWrite();
    ownTransformTracking()[2] = 1;
}

void Bone::materializeWorldTransformIfPending() {
    if (publicationCount_ == 0) return;
    joinDeferredWorldTransform();
}

Skeleton::Skeleton(std::vector<std::shared_ptr<Bone>> bones, std::vector<Matrix4> boneInverses)
    : bones(bones.begin(), bones.end()), boneInverses(std::move(boneInverses)) {
    init();
}

void Skeleton::init() {
    revokeGpuSkinning();
    boneMatrices.assign(bones.size() * 16, 0.0f);

    if (boneInverses.empty()) {
        calculateInverses();
    } else if (bones.size() != boneInverses.size()) {
        // three warns and rebuilds one identity per bone.
        boneInverses.assign(bones.size(), Matrix4{});
    }
}

void Skeleton::calculateInverses() {
    revokeGpuSkinning();
    boneInverses.clear();
    for (std::size_t i = 0; i < bones.size(); ++i) {
        Matrix4 inverse;
        if (Bone* b = bone(i)) { b->materializeWorldTransformIfPending(); inverse.copy(b->matrixWorld).invert(); }
        boneInverses.push_back(inverse);
    }
}

void Skeleton::pose() {
    revokeGpuSkinning();
    // Recover the bind-time world matrices.
    for (std::size_t i = 0; i < bones.size(); ++i) {
        if (Bone* b = bone(i)) { b->prepareLocalTransformWrite(); b->matrixWorld.copy(boneInverses[i]).invert(); }
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
        bone->markLocalTransformDirty();
    }
}

void Skeleton::update() {
    updateAfterWorldWalk(0);
}

void Skeleton::updateAfterWorldWalk(uint64_t firstEvaluation) {
    revokeGpuSkinning();
    static const Matrix4 identity{};
    Matrix4 offset;
    for (std::size_t i = 0; i < bones.size(); ++i) {
        Bone* b = bone(i);
        if (b && (!firstEvaluation || b->lastWorldEvaluation() < firstEvaluation)) b->materializeWorldTransformIfPending();
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
    revokeGpuSkinning();
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
    afterMatrixWorld();
}

void SkinnedMesh::afterMatrixWorld() {
    if (attached) bindMatrixInverse.copy(matrixWorld).invert();
    else bindMatrixInverse.copy(bindMatrix).invert();
}

Vector3& SkinnedMesh::getVertexPosition(uint64_t index, Vector3& target) const {
    Mesh::getVertexPosition(index, target);
    return applyBoneTransform(index, target);
}

bool SkinnedMesh::boneReachBounds(Box3& target) const {
    if (!skeleton || !geometry || !geometry->attributes.count("position") || !geometry->attributes.count("skinIndex") ||
        !geometry->attributes.count("skinWeight") || skeleton->boneInverses.size() < skeleton->bones.size())
        return false;
    const std::size_t bones = skeleton->bones.size();
    if (boneReachGeometry_ != geometry.get() || boneReachRevision_ != geometry->revision() ||
        boneReachSkeleton_ != skeleton.get() || boneReach_.size() != bones) {
        boneReachGeometry_ = geometry.get();
        boneReachRevision_ = geometry->revision();
        boneReachSkeleton_ = skeleton.get();
        boneReach_.assign(bones, -1);
        boneReachHolds_ = true;
        // Each bone's bind-pose position: the translation of its inverse bind matrix's inverse.
        std::vector<Vector3> centers(bones);
        for (std::size_t j = 0; j < bones; ++j) {
            Matrix4 bind = skeleton->boneInverses[j];
            centers[j].setFromMatrixPosition(bind.invert());
        }
        const auto indices = geometry->attributes.at("skinIndex");
        const auto weights = geometry->attributes.at("skinWeight");
        const uint64_t count = geometry->attributes.at("position")->count();
        Vector3 vertex;
        for (uint64_t index = 0; boneReachHolds_ && index < count; ++index) {
            Mesh::getVertexPosition(index, vertex).applyMatrix4(bindMatrix);
            double sum = 0;
            for (int i = 0; i < 4; ++i) {
                const double weight = weights->getComponent(index, i);
                if (weight == 0) continue;
                const double boneIndex = indices->getComponent(index, i);
                if (!std::isfinite(boneIndex) || boneIndex < 0 || boneIndex != std::floor(boneIndex) || boneIndex >= double(bones)) {
                    boneReachHolds_ = false;
                    break;
                }
                sum += weight;
                auto& reach = boneReach_[std::size_t(boneIndex)];
                reach = std::max(reach, vertex.distanceTo(centers[std::size_t(boneIndex)]));
            }
            if (std::abs(sum - 1) > 1e-3) boneReachHolds_ = false;
        }
    }
    if (!boneReachHolds_) return false;
    // A skinned vertex is a weighted mean of its bones' rigid images, and each image lies within the
    // bone's reach (times the bone's scale) of the bone's posed position: the spheres' box holds it.
    // The largest stretch of a matrix's linear part: the longest axis when the axes are orthogonal,
    // else the Frobenius norm (a sheared bone chain can stretch past its longest axis).
    const auto stretch = [](const Matrix4& m) {
        const auto& e = m.elements;
        const double axes[3][3] = {{e[0], e[1], e[2]}, {e[4], e[5], e[6]}, {e[8], e[9], e[10]}};
        double lengths[3], frobenius = 0;
        for (int a = 0; a < 3; ++a) {
            lengths[a] = std::sqrt(axes[a][0] * axes[a][0] + axes[a][1] * axes[a][1] + axes[a][2] * axes[a][2]);
            frobenius += lengths[a] * lengths[a];
        }
        for (int a = 0; a < 3; ++a)
            for (int b = a + 1; b < 3; ++b) {
                const double dot = axes[a][0] * axes[b][0] + axes[a][1] * axes[b][1] + axes[a][2] * axes[b][2];
                if (std::abs(dot) > 1e-6 * lengths[a] * lengths[b]) return std::sqrt(frobenius);
            }
        return std::max({lengths[0], lengths[1], lengths[2]});
    };
    target.makeEmpty();
    const double meshScale = stretch(bindMatrixInverse);
    Matrix4 matrix;
    Vector3 center;
    for (std::size_t j = 0; j < bones; ++j) {
        if (boneReach_[j] < 0) continue;
        Bone* bone = skeleton->bone(j);
        if (!bone) return false;
        bone->materializeWorldTransformIfPending();
        matrix.multiplyMatrices(bone->matrixWorld, skeleton->boneInverses[j]);
        center.setFromMatrixPosition(bone->matrixWorld).applyMatrix4(bindMatrixInverse);
        const double radius = boneReach_[j] * stretch(matrix) * meshScale;
        target.expandByPoint(Vector3(center.x - radius, center.y - radius, center.z - radius));
        target.expandByPoint(Vector3(center.x + radius, center.y + radius, center.z + radius));
    }
    return !target.isEmpty();
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
        skeleton->bone(j)->materializeWorldTransformIfPending();
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

namespace {

// three's LightShadow.copy: the receiver-side settings and the shadow camera's own frustum, which is
// what a mirrored light needs to cast the shadow the game's light casts.
void copyShadow(LightShadow& to, const LightShadow& from) {
    to.intensity = from.intensity;
    to.bias = from.bias;
    to.normalBias = from.normalBias;
    to.radius = from.radius;
    to.mapSize = from.mapSize;
    to.focus = from.focus;
    to.aspect = from.aspect;
    if (from.camera->type() == "OrthographicCamera")
        static_cast<OrthographicCamera&>(*to.camera).copy(static_cast<const OrthographicCamera&>(*from.camera));
    else if (from.camera->type() == "PerspectiveCamera")
        static_cast<PerspectiveCamera&>(*to.camera).copy(static_cast<const PerspectiveCamera&>(*from.camera));
}

// three's Light.copy for the lights the renderer draws; an unknown kind returns null.
std::shared_ptr<Object3D> cloneLight(const Object3D& from, std::string_view kind) {
    if (kind == "AmbientLight") {
        const auto& light = static_cast<const AmbientLight&>(from);
        return std::make_shared<AmbientLight>(light.color, light.intensity);
    }
    if (kind == "HemisphereLight") {
        const auto& light = static_cast<const HemisphereLight&>(from);
        return std::make_shared<HemisphereLight>(light.color, light.groundColor, light.intensity);
    }
    if (kind == "DirectionalLight") {
        const auto& light = static_cast<const DirectionalLight&>(from);
        auto next = std::make_shared<DirectionalLight>(light.color, light.intensity);
        next->target = std::make_shared<Object3D>();
        next->target->copy(*light.target);
        copyShadow(next->shadow, light.shadow);
        return next;
    }
    if (kind == "PointLight") {
        const auto& light = static_cast<const PointLight&>(from);
        auto next = std::make_shared<PointLight>(light.color, light.intensity, light.distance, light.decay);
        copyShadow(next->shadow, light.shadow);
        return next;
    }
    if (kind == "SpotLight") {
        const auto& light = static_cast<const SpotLight&>(from);
        auto next = std::make_shared<SpotLight>(light.color, light.intensity, light.distance, light.angle,
                                                light.penumbra, light.decay);
        next->target->copy(*light.target);
        copyShadow(next->shadow, light.shadow);
        return next;
    }
    return nullptr;
}

}  // namespace

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
                next->materials = mesh.materials;
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
            } else if (from.isLight()) {
                to = cloneLight(from, kind);
                if (!to) {
                    error = "TN_NATIVE_CLONE_UNSUPPORTED: " + std::string(kind);
                    return nullptr;
                }
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
            next->materials = mesh.materials;
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
