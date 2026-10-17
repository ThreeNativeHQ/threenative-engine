#include "engine/renderer/lod/model_lod.h"

#include <cmath>
#include <limits>

#include "engine/foundation/math/MathUtils.h"
#include "engine/foundation/math/ieee754.h"

namespace tn::engine::lod {

namespace {

// The bias model-lod.ts keeps in its module-level `lodBiasValue`.
double gLodBias = 1;

// The reference's `pixelsPerUnit` from clustered-mesh.ts, for the perspective branch only: the
// orthographic branch of lodPixelScale never reaches it.
double pixelsPerUnit(const PerspectiveCamera& camera, double viewportHeight) {
    return viewportHeight / (2.0 * ieee754::tan((camera.fov * PI) / 360.0));
}

} // namespace

double lodBias() { return gLodBias; }

void setLodBias(double bias) { gLodBias = std::isfinite(bias) && bias >= 1 ? bias : 1; }

double biasedLodDistance(double distance) { return distance * gLodBias; }

bool lodPixelScale(const Camera& camera, double viewportHeight, double depth, double& out, std::string& error) {
    if (!(viewportHeight > 0)) {
        error.assign(kLodViewportCode);
        return false;
    }
    if (const auto* ortho = dynamic_cast<const OrthographicCamera*>(&camera)) {
        const double height = ortho->top - ortho->bottom;
        if (!(height > 0)) {
            error.assign(kLodOrthoCode);
            return false;
        }
        out = (viewportHeight * ortho->zoom) / height;
        return true;
    }
    // The reference checks the depth before it asks the camera for a perspective scale, so any
    // non-orthographic camera answers +Infinity at a non-positive depth.
    if (!(depth > 0)) {
        out = std::numeric_limits<double>::infinity();
        return true;
    }
    const auto* perspective = dynamic_cast<const PerspectiveCamera*>(&camera);
    if (perspective == nullptr) {
        error.assign(kLodCameraCode);
        return false;
    }
    out = (pixelsPerUnit(*perspective, viewportHeight) * perspective->zoom) / depth;
    return true;
}

bool projectedLodError(double worldError, const Camera& camera, double viewportHeight, double depth, double& out,
                       std::string& error) {
    if (worldError <= 0) {
        out = 0;
        return true;
    }
    double scale = 0;
    if (!lodPixelScale(camera, viewportHeight, depth, scale, error))
        return false;
    out = worldError * scale;
    return true;
}

void conservativeViewDepth(const Camera& camera, const Vector3& center, double radius, double nearPlane, double& depth,
                           bool& degenerate) {
    Vector3 nearest = center;
    nearest.applyMatrix4(camera.matrixWorldInverse);
    depth = -nearest.z - jsMax(0.0, radius);
    degenerate = depth <= nearPlane;
}

Sphere worldSphere(const Sphere& local, const Matrix4& matrix) {
    Sphere out;
    out.center.copy(local.center);
    out.center.applyMatrix4(matrix);
    out.radius = local.radius * matrix.getMaxScaleOnAxis();
    return out;
}

bool selectLodLevel(const std::vector<double>& absoluteErrors, int current, double budgetPixels, double hysteresis,
                    const std::vector<LodView>& views, int& out, std::string& error) {
    if (absoluteErrors.empty()) {
        out = 0;
        return true;
    }
    const int last = static_cast<int>(absoluteErrors.size()) - 1;
    if (!(budgetPixels > 0) || views.empty()) {
        out = 0;
        return true;
    }
    // The reference truncates `current`; a C++ level is already an integer, so this clamps only.
    const int clampedCurrent =
        static_cast<int>(jsMin(jsMax(static_cast<double>(current), 0.0), static_cast<double>(last)));

    int target = 0;
    for (int index = last; index >= 1; index -= 1) {
        const double levelError = absoluteErrors[static_cast<std::size_t>(index)];
        bool skip = false;
        for (const LodView& view : views) {
            if (view.degenerate || view.finest) {
                skip = true;
                break;
            }
            double projected = 0;
            if (!projectedLodError(levelError, *view.camera, view.viewportHeight, view.depth, projected, error))
                return false;
            if (projected > budgetPixels) {
                skip = true;
                break;
            }
        }
        if (skip)
            continue;
        target = index;
        break;
    }

    if (target <= clampedCurrent) {
        out = target;
        return true;
    }

    // Coarsening: reject it unless the candidate is under the hysteresis-adjusted budget in every view.
    const double threshold = (1 - hysteresis) * budgetPixels;
    for (const LodView& view : views) {
        if (view.degenerate || view.finest) {
            out = clampedCurrent;
            return true;
        }
        double projected = 0;
        if (!projectedLodError(absoluteErrors[static_cast<std::size_t>(target)], *view.camera, view.viewportHeight,
                               view.depth, projected, error))
            return false;
        if (projected >= threshold) {
            out = clampedCurrent;
            return true;
        }
    }
    out = target;
    return true;
}

double cameraNear(const Camera& camera) {
    if (const auto* perspective = dynamic_cast<const PerspectiveCamera*>(&camera))
        return perspective->near;
    if (const auto* ortho = dynamic_cast<const OrthographicCamera*>(&camera))
        return ortho->near;
    return 0;
}

DiscreteLod::DiscreteLod(std::vector<double> absoluteErrors, double maxPixelError, double hysteresis)
    : errors_(std::move(absoluteErrors)), maxPixelError_(maxPixelError), hysteresis_(hysteresis) {}

bool DiscreteLod::update(const Camera& camera, double viewportHeight, const Sphere& localSphere, const Object3D& object,
                         int& out, std::string& error) {
    const Sphere world = worldSphere(localSphere, object.matrixWorld);
    double depth = 0;
    bool degenerate = false;
    conservativeViewDepth(camera, world.center, world.radius, cameraNear(camera), depth, degenerate);
    const LodView view{&camera, degenerate, biasedLodDistance(depth), viewportHeight, false};
    int index = 0;
    if (!selectLodLevel(errors_, current_, maxPixelError_, hysteresis_, {view}, index, error)) {
        out = current_;
        return false;
    }
    current_ = index;
    out = index;
    return true;
}

} // namespace tn::engine::lod
