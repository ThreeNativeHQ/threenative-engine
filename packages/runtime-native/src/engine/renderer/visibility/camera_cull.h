#pragma once

// The projected-size gate, ported from packages/core/src/render-camera-cull.ts (PRD-519). It walks
// the visible scene graph, keeps anything a multi-camera frame still needs (a camera-attached
// object, a marked object, a shadow caster off the main camera, an untrustworthy or degenerate
// bound, an object that already opted out of frustum culling) and hides the renderables whose world
// bounding sphere projects to fewer than `minimumPixels` in the camera about to draw.
//
// Native differences from the reference, both because the native object model has no `userData`:
//   - `alwaysRender` is a side table on this instance (`alwaysRender(object)`), not a `userData` key.
//     The marker keeps a small object drawn however far the camera resolves it.
//   - three's `InstancedMesh.boundingSphere` has no native member, so the bound is always the
//     geometry's `boundingSphere`; the instance-aware bound is not consulted.
//
// Engine code never throws. `create` refuses an invalid threshold by returning nullopt and a named
// code.

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include "engine/foundation/math/Matrix.h"
#include "engine/foundation/math/Primitives.h"
#include "engine/foundation/math/Vector.h"
#include "engine/scene/camera.h"
#include "engine/scene/object3d.h"

namespace tn::engine {
class BufferGeometry;
}

namespace tn::engine::visibility {

/** The projected diameter, in raster pixels, below which an object is not submitted. */
inline constexpr double kDefaultMinimumProjectedPixels = 0.5;

/** A threshold that is not a positive finite number is refused by this name. */
inline constexpr std::string_view kMinimumPixelsCode = "TN_VISIBILITY_MINIMUM_PIXELS";

/** A sphere nearer than this to the camera would divide by zero; treat it as this far away. */
inline constexpr double kMinimumDistance = 1e-4;

/** The gate configuration. `enabled: false` is the reference's `minimumPixels: false`. */
struct CameraCullOptions {
    bool enabled = true;
    double minimumPixels = kDefaultMinimumProjectedPixels;
};

/** What the gate did on the last frame, in the reference report's shape. */
struct CameraCullReport {
    bool enabled = true;
    /** False when the camera is orthographic or the viewport has no projectable height. */
    bool cameraResolved = true;
    double thresholdPixels = kDefaultMinimumProjectedPixels;
    uint32_t considered = 0;
    uint32_t culled = 0;
    uint32_t exemptCameraAttached = 0;
    uint32_t exemptMarked = 0;
    uint32_t exemptShadowCasters = 0;
    uint32_t exemptWithoutBounds = 0;
    uint32_t exemptDynamicBounds = 0;
    uint32_t exemptFrustumCulled = 0;
};

class CameraCull {
  public:
    /** Builds the gate, or refuses an enabled threshold that is not positive and finite. */
    static std::optional<CameraCull> create(const CameraCullOptions& options, std::string& error);

    /**
     * Keeps `object` drawn regardless of how small the render camera resolves it. The per-object
     * override the reference spells `alwaysRender`, kept in a side table because the native object
     * model has no `userData`.
     */
    void alwaysRender(Object3D& object, bool enabled = true);

    /** Hides this frame's sub-threshold objects under `root`, then reports what it did. */
    void apply(Object3D& root, Camera& camera, double viewportHeight);

    /** Undoes every hide this gate made, leaving the authored scene as the game left it. */
    void restore();

    [[nodiscard]] const CameraCullReport& report() const { return report_; }

  private:
    struct PositionVersion {
        uint32_t version = 0;
        bool changedLastConsult = false;
        bool stale = false;
    };
    enum class BoundKind { None, Dynamic, Sphere };

    CameraCull() = default;

    static void visitTrampoline(Object3D& object, void* context);
    void visit(Object3D& object);
    [[nodiscard]] bool isCameraAttached(const Object3D& object) const;
    BoundKind boundsOf(Object3D& object, Sphere& out);

    bool enabled_ = true;
    double minimumPixels_ = kDefaultMinimumProjectedPixels;
    Vector3 center_;
    Frustum frustum_;
    Matrix4 projectionScreen_;
    std::vector<Object3D*> hidden_;
    // ponytail: keyed by address; an object destroyed while marked leaves a stale entry a new object at
    // that address would inherit. Upgrade: a flag on Object3D, or weak_ptr keys.
    std::unordered_map<const Object3D*, bool> alwaysRender_;
    std::unordered_map<const BufferGeometry*, PositionVersion> positionVersions_;
    Camera* camera_ = nullptr;
    double cameraX_ = 0;
    double cameraY_ = 0;
    double cameraZ_ = 0;
    double scale_ = 0;
    bool cameraResolved_ = true;
    CameraCullReport report_;
};

} // namespace tn::engine::visibility
