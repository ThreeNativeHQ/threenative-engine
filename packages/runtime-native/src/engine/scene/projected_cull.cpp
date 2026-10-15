#include "engine/scene/projected_cull.h"

#include <algorithm>
#include <cmath>
#include <string_view>

#include "engine/foundation/math/Primitives.h"
#include "engine/scene/camera.h"
#include "engine/scene/geometry.h"
#include "engine/scene/nodes.h"
#include "engine/scene/object3d.h"

namespace tn::engine {
namespace {

constexpr double kMinDistance = 1e-4;  // render-camera-cull.ts MIN_DISTANCE

bool gHold = false;
std::vector<std::weak_ptr<Object3D>> gHeld;  // hides a held restoreAfterDraw() still owes

// projection-plan.ts isRenderable: three's isMesh, isSprite, isPoints and isLine classes.
bool renderable(std::string_view type) {
    return type == "Mesh" || type == "InstancedMesh" || type == "SkinnedMesh" || type == "BatchedMesh" ||
           type == "Sprite" || type == "Line" || type == "LineSegments";
}

}  // namespace

ProjectedCull::CpuTiming ProjectedCull::cpuTiming;

ProjectedCull::Report ProjectedCull::apply(Object3D& root, const Camera& camera, bool cameraResolved, double scale,
                                           double minimumPixels, bool enabled) {
    const double cpuBegin = cpuTiming.clock ? cpuTiming.clock() : -1;
    restore();
    Report report;
    Frustum frustum;
    const auto& e = camera.matrixWorld.elements;
    const double cameraX = e[12], cameraY = e[13], cameraZ = e[14];
    if (cameraResolved) {
        Matrix4 projectionScreen;
        projectionScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        frustum.setFromProjectionMatrix(projectionScreen);
    }
    // boundsOf: an InstancedMesh's own bound, else its geometry's, recomputed when the position
    // buffer moved and given up on when it moves on consecutive consults (rewritten every frame).
    enum class Bound { Sphere, Dynamic, None };
    const auto boundsOf = [this](Node& node, const Sphere*& sphere) -> Bound {
        sphere = nullptr;
        const Mesh* mesh = node.mesh;
        if (node.instanced) {
            const auto& own = static_cast<const InstancedMesh*>(mesh)->boundingSphere;
            if (own) return sphere = own.get(), Bound::Sphere;
        }
        const BufferGeometry* geometry = mesh->geometry.get();
        if (geometry == nullptr) return Bound::None;
        auto& mutableGeometry = const_cast<BufferGeometry&>(*geometry);
        if (node.geometry != geometry || node.geometryRevision != geometry->revision()) {
            const auto found = geometry->attributes.find("position");
            node.position = found != geometry->attributes.end() ? found->second.get() : nullptr;
            node.geometry = geometry;
            node.geometryRevision = geometry->revision();
        }
        const bool versioned = node.position != nullptr;
        const uint32_t version = versioned ? node.position->version() : 0;
        const auto answer = [&]() -> Bound {
            sphere = geometry->boundingSphere.get();
            return sphere ? Bound::Sphere : Bound::None;
        };
        auto known = versions_.find(geometry);
        if (known != versions_.end() && known->second.geometry.expired()) {  // a freed geometry's address reused
            versions_.erase(known);
            known = versions_.end();
        }
        const auto remember = [&] {
            versions_[geometry] = {std::static_pointer_cast<const BufferGeometry>(mesh->geometry), version, false, false};
        };
        if (!geometry->boundingSphere) {
            mutableGeometry.computeBoundingSphere();
            if (versioned) remember();
            return answer();
        }
        if (!versioned) return answer();
        if (known == versions_.end()) {
            remember();
            return answer();
        }
        Version& v = known->second;
        if (v.version == version) {
            if (v.stale) mutableGeometry.computeBoundingSphere();
            v.changedLastConsult = false;
            v.stale = false;
            return answer();
        }
        v.version = version;
        if (v.changedLastConsult) {
            v.stale = true;
            return Bound::Dynamic;
        }
        mutableGeometry.computeBoundingSphere();
        v.changedLastConsult = true;
        return answer();
    };
    const auto visit = [&](Node& node) {
        Object3D& object = *node.object;
        ++report.considered;
        if (cameraResolved && node.cameraAttached) {
            ++report.cameraAttached;
            return;
        }
        if (object.alwaysRender) {
            ++report.marked;
            return;
        }
        if (!object.frustumCulled) {
            ++report.frustumCulled;
            return;
        }
        const Sphere* sphere = nullptr;
        const Bound bound = boundsOf(node, sphere);
        if (bound == Bound::Dynamic) {
            ++report.dynamicBounds;
            return;
        }
        if (bound == Bound::None || !(std::isfinite(sphere->radius) && sphere->radius > 0)) {
            ++report.withoutBounds;
            return;
        }
        Vector3 center = sphere->center;
        center.applyMatrix4(object.matrixWorld);
        if (object.castShadow() && (!cameraResolved || !frustum.containsPoint(center))) {
            ++report.shadowCasters;
            return;
        }
        if (!enabled || !cameraResolved) return;
        const double dx = center.x - cameraX, dy = center.y - cameraY, dz = center.z - cameraZ;
        const double distance = std::sqrt(dx * dx + dy * dy + dz * dz);
        const double worldRadius = sphere->radius * object.matrixWorld.getMaxScaleOnAxis();
        const double projected = (2 * worldRadius * scale) / std::max(distance - worldRadius, kMinDistance);
        if (projected >= minimumPixels) return;
        object.setVisible(false);
        hidden_.push_back(object.weak_from_this());
        ++report.culled;
    };
    if (nodesRoot_ != &root || nodesCamera_ != &camera || nodesVersion_ != Object3D::hierarchyVersion())
        rebuild(root, camera);
    // three's traverseVisible: a node is checked, then visited, then its children walked, so a node
    // the visit hides still has its children visited. A hidden node skips its whole subtree.
    for (uint32_t i = 0; i < nodes_.size();) {
        Node& node = nodes_[i];
        if (!node.object->visible()) {
            i = node.end;
            continue;
        }
        if (node.mesh != nullptr) visit(node);
        ++i;
    }
    if (cpuTiming.clock) {
        const double cpuEnd = cpuTiming.clock();
        ++cpuTiming.calls;
        if (cpuBegin < 0 || cpuEnd < cpuBegin || !std::isfinite(cpuBegin) || !std::isfinite(cpuEnd)) cpuTiming.available = false;
        else cpuTiming.ms += cpuEnd - cpuBegin;
    }
    return report;
}

void ProjectedCull::rebuild(Object3D& root, const Camera& camera) {
    ++rebuilds_;
    nodes_.clear();
    const auto add = [&](auto& self, Object3D& object, bool underCamera) -> void {
        const auto index = uint32_t(nodes_.size());
        const std::string_view type = object.type();
        const Mesh* mesh = renderable(type) ? static_cast<const Mesh*>(&object) : nullptr;
        nodes_.push_back({&object, mesh, 0, underCamera, type == "InstancedMesh"});
        const bool childrenUnderCamera = underCamera || &object == &camera;
        for (Object3D* child : object.children) self(self, *child, childrenUnderCamera);
        nodes_[index].end = uint32_t(nodes_.size());
    };
    bool rootUnderCamera = false;
    for (const Object3D* node = root.parent; node != nullptr; node = node->parent)
        if (node == &camera) rootUnderCamera = true;
    add(add, root, rootUnderCamera);
    nodesRoot_ = &root;
    nodesCamera_ = &camera;
    nodesVersion_ = Object3D::hierarchyVersion();
}

void ProjectedCull::restore() {
    for (const auto& weak : hidden_)
        if (const auto object = weak.lock()) object->setVisible(true);
    hidden_.clear();
}

void ProjectedCull::restoreAfterDraw() {
    if (!gHold) return restore();
    gHeld.insert(gHeld.end(), hidden_.begin(), hidden_.end());
    hidden_.clear();
}

void ProjectedCull::holdRestores(bool hold) { gHold = hold; }

void ProjectedCull::releaseHeld() {
    for (const auto& weak : gHeld)
        if (const auto object = weak.lock()) object->setVisible(true);
    gHeld.clear();
}

}  // namespace tn::engine
