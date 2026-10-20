// Camera, PerspectiveCamera and OrthographicCamera: three@0.185.1 src/cameras/Camera.js,
// PerspectiveCamera.js and OrthographicCamera.js. Every projection is the reference's expression
// order, and the trig goes through the ported fdlibm, so the matrices are bit-identical.

#include "engine/scene/camera.h"

#include "engine/foundation/math/ieee754.h"

namespace tn::engine {

Vector3& Vector3::project(const Camera& camera) {
    return applyMatrix4(camera.matrixWorldInverse).applyMatrix4(camera.projectionMatrix);
}

Vector3& Vector3::unproject(const Camera& camera) {
    return applyMatrix4(camera.projectionMatrixInverse).applyMatrix4(camera.matrixWorld);
}

namespace {

constexpr double kDeg2Rad = PI / 180.0;  // local, to avoid the MathUtils DEG2RAD name
constexpr double RAD2DEG = 180.0 / PI;

Vector3 scratchPosition;
Vector3 scratchScale;
Quaternion scratchQuaternion;
Vector3 scratchV3;
Vector2 scratchMinTarget;
Vector2 scratchMaxTarget;

/** The ViewOffset three allocates the first time `setViewOffset` runs. */
ViewOffset freshView() {
    return ViewOffset{};
}

/** The `view` branch both projections share: null or not, then `enabled`. */
bool viewEnabled(const std::optional<ViewOffset>& view) { return view.has_value() && view->enabled; }

}  // namespace

// ------------------------------------------------------------------------------ Camera

Vector3& Camera::getWorldDirection(Vector3& target) { return Object3D::getWorldDirection(target).negate(); }

void Camera::updateViewMatrix() {
    // Exclude scale from the view matrix to be glTF conform.
    matrixWorld.decompose(scratchPosition, scratchQuaternion, scratchScale);

    if (scratchScale.x == 1 && scratchScale.y == 1 && scratchScale.z == 1) {
        matrixWorldInverse.copy(matrixWorld).invert();
    } else {
        matrixWorldInverse
            .compose(scratchPosition, scratchQuaternion, scratchScale.set(1, 1, 1))
            .invert();
    }
}

void Camera::updateMatrixWorld(bool force) {
    Object3D::updateMatrixWorld(force);
    updateViewMatrix();
}

void Camera::updateWorldMatrix(bool updateParents, bool updateChildren, bool force) {
    Object3D::updateWorldMatrix(updateParents, updateChildren, force);
    updateViewMatrix();
}

Camera& Camera::copy(const Camera& source) {
    Object3D::copy(source);
    matrixWorldInverse.copy(source.matrixWorldInverse);
    projectionMatrix.copy(source.projectionMatrix);
    projectionMatrixInverse.copy(source.projectionMatrixInverse);
    coordinateSystem = source.coordinateSystem;
    reversedDepth_ = source.reversedDepth_;
    return *this;
}

// ------------------------------------------------------------------------------ PerspectiveCamera

// The member order is three's own declaration order, so the initialiser list follows it.
PerspectiveCamera::PerspectiveCamera(double fov, double aspect, double near, double far)
    : fov(fov), near(near), far(far), aspect(aspect) {
    updateProjectionMatrix();
}

PerspectiveCamera& PerspectiveCamera::copy(const PerspectiveCamera& source) {
    Camera::copy(source);
    fov = source.fov;
    zoom = source.zoom;
    near = source.near;
    far = source.far;
    focus = source.focus;
    aspect = source.aspect;
    view = source.view;
    filmGauge = source.filmGauge;
    filmOffset = source.filmOffset;
    return *this;
}

void PerspectiveCamera::setFocalLength(double focalLength) {
    // see http://www.bobatkins.com/photography/technical/field_of_view.html
    const double vExtentSlope = 0.5 * getFilmHeight() / focalLength;
    fov = RAD2DEG * 2 * ieee754::atan(vExtentSlope);
    updateProjectionMatrix();
}

double PerspectiveCamera::getFocalLength() const {
    const double vExtentSlope = ieee754::tan(kDeg2Rad * 0.5 * fov);
    return 0.5 * getFilmHeight() / vExtentSlope;
}

double PerspectiveCamera::getEffectiveFOV() const {
    return RAD2DEG * 2 * ieee754::atan(ieee754::tan(kDeg2Rad * 0.5 * fov) / zoom);
}

double PerspectiveCamera::getFilmWidth() const {
    // film not completely covered in portrait format (aspect < 1)
    return filmGauge * jsMin(aspect, 1);
}

double PerspectiveCamera::getFilmHeight() const {
    // film not completely covered in landscape format (aspect > 1)
    return filmGauge / jsMax(aspect, 1);
}

void PerspectiveCamera::getViewBounds(double distance, Vector2& minTarget, Vector2& maxTarget) const {
    scratchV3.set(-1, -1, 0.5).applyMatrix4(projectionMatrixInverse);
    minTarget.set(scratchV3.x, scratchV3.y).multiplyScalar(-distance / scratchV3.z);
    scratchV3.set(1, 1, 0.5).applyMatrix4(projectionMatrixInverse);
    maxTarget.set(scratchV3.x, scratchV3.y).multiplyScalar(-distance / scratchV3.z);
}

Vector2& PerspectiveCamera::getViewSize(double distance, Vector2& target) const {
    getViewBounds(distance, scratchMinTarget, scratchMaxTarget);
    return target.subVectors(scratchMaxTarget, scratchMinTarget);
}

void PerspectiveCamera::setViewOffset(double fullWidth, double fullHeight, double x, double y,
                                     double width, double height) {
    aspect = fullWidth / fullHeight;
    if (!view.has_value()) view = freshView();
    view->enabled = true;
    view->fullWidth = fullWidth;
    view->fullHeight = fullHeight;
    view->offsetX = x;
    view->offsetY = y;
    view->width = width;
    view->height = height;
    updateProjectionMatrix();
}

void PerspectiveCamera::clearViewOffset() {
    if (view.has_value()) view->enabled = false;
    updateProjectionMatrix();
}

void PerspectiveCamera::updateProjectionMatrix() {
    const double n = near;
    double top = n * ieee754::tan(kDeg2Rad * 0.5 * fov) / zoom;
    double height = 2 * top;
    double width = aspect * height;
    double left = -0.5 * width;

    if (viewEnabled(view)) {
        left += view->offsetX * width / view->fullWidth;
        top -= view->offsetY * height / view->fullHeight;
        width *= view->width / view->fullWidth;
        height *= view->height / view->fullHeight;
    }

    const double skew = filmOffset;
    if (skew != 0) left += n * skew / getFilmWidth();

    projectionMatrix.makePerspective(left, left + width, top, top - height, n, far, coordinateSystem,
                                     reversedDepth());
    projectionMatrixInverse.copy(projectionMatrix).invert();
}

// ------------------------------------------------------------------------------ OrthographicCamera

OrthographicCamera::OrthographicCamera(double left, double right, double top, double bottom,
                                       double near, double far)
    : left(left), right(right), top(top), bottom(bottom), near(near), far(far) {
    updateProjectionMatrix();
}

OrthographicCamera& OrthographicCamera::copy(const OrthographicCamera& source) {
    Camera::copy(source);
    left = source.left;
    right = source.right;
    top = source.top;
    bottom = source.bottom;
    near = source.near;
    far = source.far;
    zoom = source.zoom;
    view = source.view;
    return *this;
}

void OrthographicCamera::setViewOffset(double fullWidth, double fullHeight, double x, double y,
                                       double width, double height) {
    if (!view.has_value()) view = freshView();
    view->enabled = true;
    view->fullWidth = fullWidth;
    view->fullHeight = fullHeight;
    view->offsetX = x;
    view->offsetY = y;
    view->width = width;
    view->height = height;
    updateProjectionMatrix();
}

void OrthographicCamera::clearViewOffset() {
    if (view.has_value()) view->enabled = false;
    updateProjectionMatrix();
}

void OrthographicCamera::updateProjectionMatrix() {
    const double dx = (right - left) / (2 * zoom);
    const double dy = (top - bottom) / (2 * zoom);
    const double cx = (right + left) / 2;
    const double cy = (top + bottom) / 2;

    double l = cx - dx;
    double r = cx + dx;
    double t = cy + dy;
    double b = cy - dy;

    if (viewEnabled(view)) {
        const double scaleW = (right - left) / view->fullWidth / zoom;
        const double scaleH = (top - bottom) / view->fullHeight / zoom;
        l += scaleW * view->offsetX;
        r = l + scaleW * view->width;
        t -= scaleH * view->offsetY;
        b = t - scaleH * view->height;
    }

    projectionMatrix.makeOrthographic(l, r, t, b, near, far, coordinateSystem, reversedDepth());
    projectionMatrixInverse.copy(projectionMatrix).invert();
}

}  // namespace tn::engine
