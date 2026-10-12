#include "engine/renderer/visibility/camera_cull.h"

#include "engine/foundation/math/MathUtils.h"
#include "engine/foundation/math/ieee754.h"
#include "engine/scene/geometry.h"
#include "engine/scene/nodes.h"

#include <algorithm>
#include <cmath>

namespace tn::engine::visibility {

std::optional<CameraCull> CameraCull::create(const CameraCullOptions& options, std::string& error) {
    if (options.enabled && (!std::isfinite(options.minimumPixels) || options.minimumPixels <= 0)) {
        error.assign(kMinimumPixelsCode);
        return std::nullopt;
    }
    CameraCull cull;
    cull.enabled_ = options.enabled;
    // A disabled gate still reports the default threshold, as the reference leaves it.
    cull.minimumPixels_ = options.enabled ? options.minimumPixels : kDefaultMinimumProjectedPixels;
    cull.report_.enabled = options.enabled;
    cull.report_.thresholdPixels = cull.minimumPixels_;
    return cull;
}

void CameraCull::alwaysRender(Object3D& object, bool enabled) {
    if (enabled) {
        alwaysRender_[&object] = true;
    } else {
        alwaysRender_.erase(&object);
    }
}

void CameraCull::apply(Object3D& root, Camera& camera, double viewportHeight) {
    restore();
    report_ = CameraCullReport{};
    report_.enabled = enabled_;
    report_.thresholdPixels = minimumPixels_;
    camera_ = nullptr;
    auto* perspective = dynamic_cast<PerspectiveCamera*>(&camera);
    if (!std::isfinite(viewportHeight) || viewportHeight <= 0) {
        report_.cameraResolved = false;
    } else if (perspective == nullptr || !(perspective->fov > 0 && perspective->fov < 180)) {
        // An orthographic camera has no distance term, so a projected size has no meaning.
        report_.cameraResolved = false;
    } else {
        if (camera.matrixWorldAutoUpdate)
            camera.updateMatrixWorld();
        camera_ = &camera;
        scale_ = viewportHeight / (2 * ieee754::tan((perspective->fov * PI) / 360));
        const double* elements = camera.matrixWorld.elements.data();
        cameraX_ = elements[12];
        cameraY_ = elements[13];
        cameraZ_ = elements[14];
        projectionScreen_.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        frustum_.setFromProjectionMatrix(projectionScreen_);
    }
    cameraResolved_ = report_.cameraResolved;
    // The walk runs whether or not the gate is enabled: turning the convention off must not turn its
    // measurement off. Only the hide below is gated by `enabled_`.
    root.traverseVisible(&CameraCull::visitTrampoline, this);
}

void CameraCull::restore() {
    for (Object3D* object : hidden_)
        object->setVisible(true);
    hidden_.clear();
}

void CameraCull::visitTrampoline(Object3D& object, void* context) { static_cast<CameraCull*>(context)->visit(object); }

void CameraCull::visit(Object3D& object) {
    if (dynamic_cast<Mesh*>(&object) == nullptr)
        return;
    report_.considered += 1;
    if (isCameraAttached(object)) {
        report_.exemptCameraAttached += 1;
        return;
    }
    const auto marked = alwaysRender_.find(&object);
    if (marked != alwaysRender_.end() && marked->second) {
        report_.exemptMarked += 1;
        return;
    }
    // `frustumCulled = false` is the game's standing instruction that its bounds cannot be trusted;
    // a second, stricter cull does not get to override the opt-out.
    if (!object.frustumCulled) {
        report_.exemptFrustumCulled += 1;
        return;
    }
    Sphere sphere;
    const BoundKind kind = boundsOf(object, sphere);
    if (kind == BoundKind::Dynamic) {
        report_.exemptDynamicBounds += 1;
        return;
    }
    // A zero or non-finite radius is not a size: keep the object, never read it as "infinitely small".
    if (kind == BoundKind::None || !(std::isfinite(sphere.radius) && sphere.radius > 0)) {
        report_.exemptWithoutBounds += 1;
        return;
    }
    center_.copy(sphere.center).applyMatrix4(object.matrixWorld);
    // A shadow can be cast from far outside the main view, so a caster off the main camera is kept.
    if (object.castShadow() && (!cameraResolved_ || !frustum_.containsPoint(center_))) {
        report_.exemptShadowCasters += 1;
        return;
    }
    if (!enabled_ || !cameraResolved_)
        return;
    const double dx = center_.x - cameraX_;
    const double dy = center_.y - cameraY_;
    const double dz = center_.z - cameraZ_;
    const double distance = std::sqrt(dx * dx + dy * dy + dz * dz);
    const double worldRadius = sphere.radius * object.matrixWorld.getMaxScaleOnAxis();
    const double projectedDiameter = (2 * worldRadius * scale_) / std::max(distance - worldRadius, kMinimumDistance);
    if (projectedDiameter >= minimumPixels_)
        return;
    object.setVisible(false);
    hidden_.push_back(&object);
    report_.culled += 1;
}

bool CameraCull::isCameraAttached(const Object3D& object) const {
    if (camera_ == nullptr)
        return false;
    for (Object3D* node = object.parent; node != nullptr; node = node->parent) {
        if (node == camera_)
            return true;
    }
    return false;
}

CameraCull::BoundKind CameraCull::boundsOf(Object3D& object, Sphere& out) {
    auto* mesh = dynamic_cast<Mesh*>(&object);
    if (mesh == nullptr || mesh->geometry == nullptr)
        return BoundKind::None;
    BufferGeometry& geometry = *mesh->geometry;
    const std::shared_ptr<BufferAttribute> position = geometry.getAttribute("position");
    const bool versioned = position != nullptr;
    const uint32_t version = versioned ? position->version() : 0u;
    if (geometry.boundingSphere == nullptr) {
        geometry.computeBoundingSphere();
        if (versioned)
            positionVersions_[&geometry] = PositionVersion{version, false, false};
        if (geometry.boundingSphere == nullptr)
            return BoundKind::None;
        out.copy(*geometry.boundingSphere);
        return BoundKind::Sphere;
    }
    if (!versioned) {
        out.copy(*geometry.boundingSphere);
        return BoundKind::Sphere;
    }
    const auto found = positionVersions_.find(&geometry);
    if (found == positionVersions_.end()) {
        positionVersions_[&geometry] = PositionVersion{version, false, false};
        out.copy(*geometry.boundingSphere);
        return BoundKind::Sphere;
    }
    PositionVersion& known = found->second;
    if (known.version == version) {
        // A buffer that settled after a per-frame rewrite has knowable extents again: scan it once.
        if (known.stale)
            geometry.computeBoundingSphere();
        known.changedLastConsult = false;
        known.stale = false;
        out.copy(*geometry.boundingSphere);
        return BoundKind::Sphere;
    }
    known.version = version;
    if (known.changedLastConsult) {
        // The buffer moved again on the very next consult: it is rewritten every frame. Treat the
        // bound like `frustumCulled = false` and keep drawing rather than scan every frame.
        known.stale = true;
        return BoundKind::Dynamic;
    }
    // The buffer was rewritten under a cached sphere, which is now a stale size that looks valid.
    geometry.computeBoundingSphere();
    known.changedLastConsult = true;
    out.copy(*geometry.boundingSphere);
    return BoundKind::Sphere;
}

} // namespace tn::engine::visibility
