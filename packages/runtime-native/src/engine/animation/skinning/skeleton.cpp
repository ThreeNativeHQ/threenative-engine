// Bone and Skeleton (PRD-518 phase 1): three@0.185.1 src/objects/Bone.js and Skeleton.js, method
// for method, over the ported Object3D and Matrix4. Skeleton never throws; a null bone slot is
// three's `undefined`, skipped by pose and replaced by the identity in update.

#include "engine/animation/skinning/skeleton.h"
#include "engine/scene/lights.h"

#include <algorithm>
#include <atomic>
#include <bit>
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
    boneAddresses_.reserve(bones.size());
    for (const auto& bone : bones) {
        boneAddresses_.push_back(bone.get());
        if (!bone) continue;
        // A counter only its bone still holds belongs to a skeleton that is gone.
        std::erase_if(bone->poseVersions_, [](const auto& version) { return version.use_count() == 1; });
        bone->poseVersions_.push_back(poseVersion_);
    }
    init();
}

void Skeleton::init() {
    revokeGpuSkinning();
    markPoseChanged();
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
    markPoseChanged();
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

void Skeleton::deferWorldPalette(uint64_t firstEvaluation) {
    if (Bone::publicationCount_ != 0) return updateAfterWorldWalk(firstEvaluation);
    revokeGpuSkinning();
    paletteDue_ = true;
    paletteFirstEvaluation_ = firstEvaluation;
}

void Skeleton::updateAfterWorldWalk(uint64_t firstEvaluation) {
    revokeGpuSkinning();
    paletteDue_ = false;
    ++worldPaletteUpdates;
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
    if (skeleton) skeleton->markPoseChanged();  // the bind is part of every palette slot
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

// The largest stretch of a matrix's linear part: the longest axis when the axes are orthogonal,
// else the Frobenius norm (a sheared bone chain can stretch past its longest axis).
static double linearStretch(const Matrix4& m) {
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
}

// A rigid move re-derives `inv(mesh world) * root world` through its own floating point, so the same pose lands a few
// ulps away: compare in the noise floor, which is far below the float32 geometry the box holds.
static bool nearRoot(const std::array<double, 16>& a, const std::array<double, 16>& b) {
    for (std::size_t i = 0; i < 16; ++i)
        if (std::abs(a[i] - b[i]) > 1e-12 * (1 + std::abs(a[i]) + std::abs(b[i]))) return false;
    return true;
}
static bool nearScale(double a, double b) { return std::abs(a - b) <= 1e-12 * (1 + std::abs(a) + std::abs(b)); }

const std::vector<Vector3>& Skeleton::planCenters(uint64_t stamp, const Matrix4& inverse) {
    if (stamp != 0 && stamp == centerStamp_ && centerInverse_ == inverse.elements && centers_.size() == bones.size())
        return centers_;
    const auto& poses = planPoses(stamp);
    centers_.resize(poses.size());
    for (std::size_t j = 0; j < poses.size(); ++j) centers_[j].copy(poses[j].position).applyMatrix4(inverse);
    centerStamp_ = stamp;
    centerInverse_ = inverse.elements;
    return centers_;
}

uint64_t Skeleton::nextPlanStamp() {
    static std::atomic<uint64_t> stamp{0};
    return ++stamp;
}

const std::vector<Skeleton::PlanPose>& Skeleton::planPoses(uint64_t stamp) {
    if (stamp != 0 && stamp == planStamp_ && planPoses_.size() == bones.size()) return planPoses_;
    planStamp_ = stamp;
    ++planPoseBuilds;
    planPoses_.resize(bones.size());
    // A bone chain whose local scales are all unit stretches its world linear part exactly as its root does: one
    // `linearStretch` for the skeleton, not one per bone (PRD-872: the stress lab's 120 rigs read 7,800 bones a frame).
    bool unitScales = true;
    for (std::size_t j = 0; j < bones.size() && unitScales; ++j) {
        const Bone* bone = this->bone(j);
        if (bone == nullptr) continue;
        unitScales = bone->scale.x == 1 && bone->scale.y == 1 && bone->scale.z == 1;
    }
    double shared = 0;
    for (std::size_t j = 0; j < bones.size(); ++j) {
        PlanPose& pose = planPoses_[j];
        Bone* bone = this->bone(j);
        if (!bone) { pose.stretch = -1; continue; }
        bone->materializeWorldTransformIfPending();
        pose.position.setFromMatrixPosition(bone->matrixWorld);
        if (!unitScales) { pose.stretch = linearStretch(bone->matrixWorld); continue; }
        if (shared == 0) shared = linearStretch(bone->matrixWorld);
        pose.stretch = shared;
    }
    if (!unitScales) shared = 0;
    return planPoses_;
}

bool SkinnedMesh::boneReachBounds(Box3& target, uint64_t planStamp) const {
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
        // Each reach carries its inverse bind matrix's stretch, so a frame reads only the bone's own: the
        // product bounds the stretch of bone x inverse, exactly for a rotation with uniform scale, and spares
        // a 4x4 multiply per bone per frame (PRD-871: 0.87 ms a frame for the stress lab's 120-rig crowd).
        for (std::size_t j = 0; j < bones; ++j)
            if (boneReach_[j] >= 0) boneReach_[j] *= linearStretch(skeleton->boneInverses[j]);
    }
    if (!boneReachHolds_) return false;
    // A skinned vertex is a weighted mean of its bones' rigid images, and each image lies within the
    // bone's reach (times the bone's scale) of the bone's posed position: the spheres' box holds it.
    // The box is `inv(mesh world) * bone position` over the bones, so it is fixed by three things: the local pose,
    // the rig-relative root (`inv(mesh world) * root world`), and the mesh scale. A rig that translates and turns
    // with the same pose reads the same three, and keeps the box it built (PRD-872: 0.64 ms a frame for 242 meshes).
    const double meshScale = linearStretch(bindMatrixInverse);
    const uint64_t pose = skeleton->poseVersion();  // a stamp, not a fold of 65 bones (PRD-878)
    const Bone* root = nullptr;
    for (std::size_t j = 0; j < bones && root == nullptr; ++j) root = skeleton->bone(j);
    Matrix4 relative;
    if (root != nullptr) { relative.copy(bindMatrixInverse); relative.multiply(root->matrixWorld); }
    if (boneReachBoxStamp_ != 0 && boneReachBoxPose_ == pose && nearScale(boneReachBoxScale_, meshScale) &&
        nearRoot(boneReachBoxRoot_, relative.elements)) {
        target = boneReachBox_;
        return !target.isEmpty();
    }
    ++boneReachBoxBuilds;
    target.makeEmpty();
    const auto& poses = skeleton->planPoses(planStamp);
    const auto& centers = skeleton->planCenters(planStamp, bindMatrixInverse);
    for (std::size_t j = 0; j < bones; ++j) {
        if (boneReach_[j] < 0) continue;
        if (poses[j].stretch < 0) return false;
        const Vector3& center = centers[j];
        const double radius = boneReach_[j] * poses[j].stretch * meshScale;
        target.min.x = std::min(target.min.x, center.x - radius);
        target.min.y = std::min(target.min.y, center.y - radius);
        target.min.z = std::min(target.min.z, center.z - radius);
        target.max.x = std::max(target.max.x, center.x + radius);
        target.max.y = std::max(target.max.y, center.y + radius);
        target.max.z = std::max(target.max.z, center.z + radius);
    }
    boneReachBox_ = target;
    boneReachBoxPose_ = pose;
    boneReachBoxScale_ = meshScale;
    boneReachBoxRoot_ = relative.elements;
    boneReachBoxStamp_ = 1;
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
    // A source's primitives that share a Skeleton keep sharing one. A Skeleton per primitive walks the same bones again for
    // each primitive, every frame; three's clone makes one per mesh, and three's loader shares them, as this does.
    std::unordered_map<const Skeleton*, std::shared_ptr<Skeleton>> skeletons;
    for (const auto& [from, to] : copies) {
        if (from->type() != "SkinnedMesh") continue;
        const auto& mesh = static_cast<const SkinnedMesh&>(*from);
        auto& next = static_cast<SkinnedMesh&>(*to);
        next.attached = mesh.attached;
        next.bindMatrix.copy(mesh.bindMatrix);
        next.bindMatrixInverse.copy(mesh.bindMatrixInverse);
        if (mesh.boundingBox) next.boundingBox = std::make_shared<Box3>(*mesh.boundingBox);
        if (!mesh.skeleton) continue;
        if (const auto shared = skeletons.find(mesh.skeleton.get()); shared != skeletons.end()) {
            next.bind(shared->second, &mesh.bindMatrix);
            continue;
        }
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
        auto copy = std::make_shared<Skeleton>(std::move(bones), mesh.skeleton->boneInverses);
        skeletons.emplace(mesh.skeleton.get(), copy);
        next.bind(std::move(copy), &mesh.bindMatrix);
    }
    return root;
}

} // namespace tn::engine
