#pragma once

// Automatic discrete LOD selection, ported from packages/core/src/model-lod.ts (PRD-519). This owns
// only the selection math and the per-frame discrete decision a `TN_discrete_lod` chain makes: it
// loads no asset, clones nothing, and touches no three LOD object or mesh geometry. Asset loading,
// chain construction and the join rung stay in the TypeScript loader.
//
// The selection is the reference's, operation for operation, because the differential fixtures
// compare binary64 bits. Engine code never throws: where the reference throws, these return false
// with one of the named `TN_LOD_*` codes below.

#include <string>
#include <string_view>
#include <vector>

#include "engine/foundation/math/Matrix.h"
#include "engine/foundation/math/Primitives.h"
#include "engine/foundation/math/Vector.h"
#include "engine/scene/camera.h"

namespace tn::engine::lod {

/** DISCRETE_LOD_DEFAULT_HYSTERESIS: how far inside the budget a candidate must sit before coarsening. */
inline constexpr double kDiscreteLodDefaultHysteresis = 0.15;

/** A non-positive viewport height is refused by this name. */
inline constexpr std::string_view kLodViewportCode = "TN_LOD_VIEWPORT";
/** An orthographic frustum without a positive height is refused by this name. */
inline constexpr std::string_view kLodOrthoCode = "TN_LOD_ORTHO";
/** A camera that is neither perspective nor orthographic is refused by this name. */
inline constexpr std::string_view kLodCameraCode = "TN_LOD_CAMERA";

/** The multiplier every LOD selection path scales camera distance by (module state, as in the TS). */
double lodBias();

/** Sets the adaptive LOD bias, clamped to `>= 1`; a non-finite value resets it to 1. */
void setLodBias(double bias);

/** The camera distance an LOD switch is compared against: the measured distance times the bias. */
double biasedLodDistance(double distance);

/**
 * Pixels a one-world-unit error at `depth` covers for this camera and viewport.
 *
 * Perspective divides the projected scale by the depth and answers +Infinity for a non-positive
 * depth; orthographic has no depth term and uses the frustum height. A bad viewport, frustum or
 * camera returns false with the matching code instead of the reference's throw.
 */
bool lodPixelScale(const Camera& camera, double viewportHeight, double depth, double& out, std::string& error);

/** The projected geometric error of `worldError` at `depth`, in pixels. */
bool projectedLodError(double worldError, const Camera& camera, double viewportHeight, double depth, double& out,
                       std::string& error);

/**
 * The conservative nearest view-space depth of a world-space bounding sphere: the distance along the
 * view axis to the centre minus the radius, which can be at or inside the near plane.
 */
void conservativeViewDepth(const Camera& camera, const Vector3& center, double radius, double nearPlane, double& depth,
                           bool& degenerate);

/** The world-space bounding sphere of a cached local sphere under a matrix. */
Sphere worldSphere(const Sphere& local, const Matrix4& matrix);

/** One view's selection inputs, mirroring `ILodView`. `depth` is already bias-scaled. */
struct LodView {
    const Camera* camera = nullptr;
    bool degenerate = false;
    double depth = 0;
    double viewportHeight = 0;
    bool finest = false;
};

/**
 * The coarsest level whose projected error fits the budget in every supplied view, stabilized
 * against `current`. Refines immediately and coarsens only inside `(1 - hysteresis) * budget`.
 */
bool selectLodLevel(const std::vector<double>& absoluteErrors, int current, double budgetPixels, double hysteresis,
                    const std::vector<LodView>& views, int& out, std::string& error);

/** The active camera's near plane, or 0 for a camera that carries none (the reference's `?? 0`). */
double cameraNear(const Camera& camera);

/**
 * One mesh's discrete selection state: the chain's absolute errors, the policy, and the level kept
 * between frames that hysteresis needs. One instance per mesh, exactly like `ModelLod`.
 */
class DiscreteLod {
  public:
    DiscreteLod(std::vector<double> absoluteErrors, double maxPixelError, double hysteresis);

    /** The level currently shown. */
    [[nodiscard]] int index() const { return current_; }
    /** The chain's absolute errors, LOD0 first. */
    [[nodiscard]] const std::vector<double>& errors() const { return errors_; }

    /**
     * One frame's decision for `object`. Updates the kept level and answers it in `out`. A projection
     * refusal leaves the level unchanged, returns false and sets `error`.
     */
    bool update(const Camera& camera, double viewportHeight, const Sphere& localSphere, const Object3D& object,
                int& out, std::string& error);

  private:
    std::vector<double> errors_;
    double maxPixelError_;
    double hysteresis_;
    int current_ = 0;
};

} // namespace tn::engine::lod
