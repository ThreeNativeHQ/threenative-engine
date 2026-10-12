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

// projection-plan.ts isRenderable: three's isMesh, isSprite, isPoints and isLine classes.
bool renderable(std::string_view type) {
    return type == "Mesh" || type == "InstancedMesh" || type == "SkinnedMesh" || type == "BatchedMesh" ||
           type == "Sprite" || type == "Line" || type == "LineSegments";
}

}  // namespace

ProjectedCull::Report ProjectedCull::apply(Object3D& root, const Camera& camera, bool cameraResolved, double scale,
                                           double minimumPixels, bool enabled) {
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
    const auto boundsOf = [this](const Object3D& object, const Sphere*& sphere) -> Bound {
        sphere = nullptr;
        if (object.type() == "InstancedMesh") {
            const auto& own = static_cast<const InstancedMesh&>(object).boundingSphere;
            if (own) return sphere = own.get(), Bound::Sphere;
        }
        const auto* mesh = dynamic_cast<const Mesh*>(&object);
        const BufferGeometry* geometry = mesh ? mesh->geometry.get() : nullptr;
        if (geometry == nullptr) return Bound::None;
        auto& mutableGeometry = const_cast<BufferGeometry&>(*geometry);
        const auto position = geometry->attributes.find("position");
        const bool versioned = position != geometry->attributes.end() && position->second != nullptr;
        const uint32_t version = versioned ? position->second->version() : 0;
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
    const auto visit = [&](Object3D& object) {
        if (!renderable(object.type())) return;
        ++report.considered;
        if (cameraResolved)
            for (const Object3D* node = object.parent; node != nullptr; node = node->parent)
                if (node == &camera) {
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
        const Bound bound = boundsOf(object, sphere);
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
    // three's traverseVisible: a node is checked, then visited, then its children walked, so a node
    // the visit hides still has its children visited.
    const auto walk = [&](auto& self, Object3D& object) -> void {
        if (!object.visible()) return;
        visit(object);
        for (Object3D* child : object.children) self(self, *child);
    };
    walk(walk, root);
    return report;
}

void ProjectedCull::restore() {
    for (const auto& weak : hidden_)
        if (const auto object = weak.lock()) object->setVisible(true);
    hidden_.clear();
}

}  // namespace tn::engine
