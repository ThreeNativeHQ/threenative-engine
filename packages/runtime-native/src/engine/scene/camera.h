#pragma once

// Camera, PerspectiveCamera and OrthographicCamera, ported from three@0.185.1
// src/cameras/{Camera,PerspectiveCamera,OrthographicCamera}.js. The projection is the reference's,
// including the view-offset branches and the glTF-conform scale exclusion in the view matrix.
//
// Not ported: `toJSON` (JSON text) and `clone` (which copies, and `copy` arrives with the object
// model). `focus` is a parameter carrier with no effect on the projection here, as in the
// reference, where only StereoCamera reads it.

#include <optional>
#include <string_view>

#include "engine/foundation/math/MathUtils.h"
#include "engine/foundation/math/Matrix.h"
#include "engine/foundation/math/Vector.h"
#include "engine/scene/object3d.h"

namespace tn::engine {

/** three's frustum window specification, shared by both projection cameras. */
struct ViewOffset {
    bool enabled = true;
    double fullWidth = 1;
    double fullHeight = 1;
    double offsetX = 0;
    double offsetY = 0;
    double width = 1;
    double height = 1;
};

/** three's abstract Camera base: the view and projection matrices and the coordinate system. */
class Camera : public Object3D {
public:
    [[nodiscard]] std::string_view type() const override { return "Camera"; }
    [[nodiscard]] bool isCamera() const override { return true; }

    Matrix4 matrixWorldInverse;
    Matrix4 projectionMatrix;
    Matrix4 projectionMatrixInverse;
    CoordinateSystem coordinateSystem = CoordinateSystem::WebGL;
    [[nodiscard]] bool reversedDepth() const { return reversedDepth_; }
    void setReversedDepth(bool value) { reversedDepth_ = value; }

    /** A camera looks down its local negative z-axis, so the reference negates the base answer. */
    Vector3& getWorldDirection(Vector3& target) override;
    void updateMatrixWorld(bool force = false) override;
    void updateWorldMatrix(bool updateParents, bool updateChildren, bool force = false) override;
    Camera& copy(const Camera& source);

private:
    /** The shared tail of both overrides: the view matrix, with scale excluded. */
    void updateViewMatrix();

    bool reversedDepth_ = false;
};

/** three's PerspectiveCamera: fov/zoom/near/far/aspect, film gauge and the view offset. */
class PerspectiveCamera : public Camera {
public:
    PerspectiveCamera(double fov = 50, double aspect = 1, double near = 0.1, double far = 2000);

    [[nodiscard]] std::string_view type() const override { return "PerspectiveCamera"; }

    double fov = 50;
    double zoom = 1;
    double near = 0.1;
    double far = 2000;
    double focus = 10;
    double aspect = 1;
    std::optional<ViewOffset> view;
    double filmGauge = 35;
    double filmOffset = 0;

    PerspectiveCamera& copy(const PerspectiveCamera& source);
    void setFocalLength(double focalLength);
    [[nodiscard]] double getFocalLength() const;
    [[nodiscard]] double getEffectiveFOV() const;
    [[nodiscard]] double getFilmWidth() const;
    [[nodiscard]] double getFilmHeight() const;
    void getViewBounds(double distance, Vector2& minTarget, Vector2& maxTarget) const;
    Vector2& getViewSize(double distance, Vector2& target) const;
    void setViewOffset(double fullWidth, double fullHeight, double x, double y, double width,
                       double height);
    void clearViewOffset();
    void updateProjectionMatrix();
};

/** three's OrthographicCamera: the six frustum planes, zoom and the view offset. */
class OrthographicCamera : public Camera {
public:
    OrthographicCamera(double left = -1, double right = 1, double top = 1, double bottom = -1,
                       double near = 0.1, double far = 2000);

    [[nodiscard]] std::string_view type() const override { return "OrthographicCamera"; }

    double zoom = 1;
    std::optional<ViewOffset> view;
    double left = -1;
    double right = 1;
    double top = 1;
    double bottom = -1;
    double near = 0.1;
    double far = 2000;

    OrthographicCamera& copy(const OrthographicCamera& source);
    void setViewOffset(double fullWidth, double fullHeight, double x, double y, double width,
                       double height);
    void clearViewOffset();
    void updateProjectionMatrix();
};

}  // namespace tn::engine