#include "engine/foundation/math/Vector.h"

#include "engine/foundation/math/Euler.h"
#include "engine/foundation/math/MathUtils.h"
#include "engine/foundation/math/Matrix.h"
#include "engine/foundation/math/Quaternion.h"
#include "engine/foundation/math/Color.h"
#include "engine/foundation/math/ieee754.h"

#include <cmath>

namespace tn::engine {

// Three's module-level scratch vectors become function-local statics here: same reentrancy
// contract as the reference, and the engine is single-threaded by contract (see handles.h).
// ponytail: one scratch per function, not a pool; a caller that nests these calls is not a caller.

Vector2& Vector2::set(double x, double y) {
    this->x = x;
    this->y = y;
    return *this;
}

Vector2& Vector2::setScalar(double scalar) {
    this->x = scalar;
    this->y = scalar;
    return *this;
}

Vector2& Vector2::setX(double x) {
    this->x = x;
    return *this;
}

Vector2& Vector2::setY(double y) {
    this->y = y;
    return *this;
}

Vector2& Vector2::setComponent(int index, double value) {
    switch (index) {
        case 0: x = value; break;
        case 1: y = value; break;
        default: break;
    }
    return *this;
}

double Vector2::getComponent(int index) const {
    switch (index) {
        case 0: return x;
        case 1: return y;
        default: return 0;
    }
}

Vector2& Vector2::copy(const Vector2& v) {
    x = v.x;
    y = v.y;
    return *this;
}

Vector2& Vector2::add(const Vector2& v) {
    x += v.x;
    y += v.y;
    return *this;
}

Vector2& Vector2::addScalar(double s) {
    x += s;
    y += s;
    return *this;
}

Vector2& Vector2::addVectors(const Vector2& a, const Vector2& b) {
    x = a.x + b.x;
    y = a.y + b.y;
    return *this;
}

Vector2& Vector2::addScaledVector(const Vector2& v, double s) {
    x += v.x * s;
    y += v.y * s;
    return *this;
}

Vector2& Vector2::sub(const Vector2& v) {
    x -= v.x;
    y -= v.y;
    return *this;
}

Vector2& Vector2::subScalar(double s) {
    x -= s;
    y -= s;
    return *this;
}

Vector2& Vector2::subVectors(const Vector2& a, const Vector2& b) {
    x = a.x - b.x;
    y = a.y - b.y;
    return *this;
}

Vector2& Vector2::multiply(const Vector2& v) {
    x *= v.x;
    y *= v.y;
    return *this;
}

Vector2& Vector2::multiplyScalar(double scalar) {
    x *= scalar;
    y *= scalar;
    return *this;
}

Vector2& Vector2::divide(const Vector2& v) {
    x /= v.x;
    y /= v.y;
    return *this;
}

Vector2& Vector2::divideScalar(double scalar) { return multiplyScalar(1 / scalar); }

Vector2& Vector2::applyMatrix3(const Matrix3& m) {
    const double vx = x, vy = y;
    const double* e = m.elements.data();
    x = e[0] * vx + e[3] * vy + e[6];
    y = e[1] * vx + e[4] * vy + e[7];
    return *this;
}

Vector2& Vector2::min(const Vector2& v) {
    x = jsMin(x, v.x);
    y = jsMin(y, v.y);
    return *this;
}

Vector2& Vector2::max(const Vector2& v) {
    x = jsMax(x, v.x);
    y = jsMax(y, v.y);
    return *this;
}

Vector2& Vector2::clamp(const Vector2& lo, const Vector2& hi) {
    x = tn::engine::clamp(x, lo.x, hi.x);
    y = tn::engine::clamp(y, lo.y, hi.y);
    return *this;
}

Vector2& Vector2::clampScalar(double lo, double hi) {
    x = tn::engine::clamp(x, lo, hi);
    y = tn::engine::clamp(y, lo, hi);
    return *this;
}

Vector2& Vector2::clampLength(double lo, double hi) {
    const double length = this->length();
    return divideScalar(orOne(length)).multiplyScalar(tn::engine::clamp(length, lo, hi));
}

Vector2& Vector2::floor() {
    x = std::floor(x);
    y = std::floor(y);
    return *this;
}

Vector2& Vector2::ceil() {
    x = std::ceil(x);
    y = std::ceil(y);
    return *this;
}

Vector2& Vector2::round() {
    x = jsRound(x);
    y = jsRound(y);
    return *this;
}

Vector2& Vector2::roundToZero() {
    x = std::trunc(x);
    y = std::trunc(y);
    return *this;
}

Vector2& Vector2::negate() {
    x = -x;
    y = -y;
    return *this;
}

double Vector2::dot(const Vector2& v) const { return x * v.x + y * v.y; }

double Vector2::cross(const Vector2& v) const { return x * v.y - y * v.x; }

double Vector2::lengthSq() const { return x * x + y * y; }

double Vector2::length() const { return std::sqrt(x * x + y * y); }

double Vector2::manhattanLength() const { return std::fabs(x) + std::fabs(y); }

Vector2& Vector2::normalize() { return divideScalar(orOne(length())); }

double Vector2::angle() const {
    const double angle = ieee754::atan2(-y, -x) + PI;
    return angle;
}

double Vector2::angleTo(const Vector2& v) const {
    const double denominator = std::sqrt(lengthSq() * v.lengthSq());
    if (denominator == 0) return PI / 2;
    const double theta = dot(v) / denominator;
    // clamp, to handle numerical problems
    return ieee754::acos(tn::engine::clamp(theta, -1, 1));
}

double Vector2::distanceTo(const Vector2& v) const { return std::sqrt(distanceToSquared(v)); }

double Vector2::distanceToSquared(const Vector2& v) const {
    const double dx = x - v.x, dy = y - v.y;
    return dx * dx + dy * dy;
}

double Vector2::manhattanDistanceTo(const Vector2& v) const { return std::fabs(x - v.x) + std::fabs(y - v.y); }

Vector2& Vector2::setLength(double length) { return normalize().multiplyScalar(length); }

Vector2& Vector2::lerp(const Vector2& v, double alpha) {
    x += (v.x - x) * alpha;
    y += (v.y - y) * alpha;
    return *this;
}

Vector2& Vector2::lerpVectors(const Vector2& v1, const Vector2& v2, double alpha) {
    x = v1.x + (v2.x - v1.x) * alpha;
    y = v1.y + (v2.y - v1.y) * alpha;
    return *this;
}

bool Vector2::equals(const Vector2& v) const { return v.x == x && v.y == y; }

Vector2& Vector2::fromArray(const double* array, int offset) {
    x = array[offset];
    y = array[offset + 1];
    return *this;
}

Vector2& Vector2::rotateAround(const Vector2& center, double angle) {
    const double c = ieee754::cos(angle), s = ieee754::sin(angle);
    const double vx = x - center.x;
    const double vy = y - center.y;
    x = vx * c - vy * s + center.x;
    y = vx * s + vy * c + center.y;
    return *this;
}

Vector3& Vector3::set(double x, double y) {
    this->x = x;
    this->y = y;
    return *this;
}

Vector3& Vector3::set(double x, double y, double z) {
    this->x = x;
    this->y = y;
    this->z = z;
    return *this;
}

Vector3& Vector3::setScalar(double scalar) {
    x = scalar;
    y = scalar;
    z = scalar;
    return *this;
}

Vector3& Vector3::setX(double v) {
    x = v;
    return *this;
}

Vector3& Vector3::setY(double v) {
    y = v;
    return *this;
}

Vector3& Vector3::setZ(double v) {
    z = v;
    return *this;
}

Vector3& Vector3::setComponent(int index, double value) {
    switch (index) {
        case 0: x = value; break;
        case 1: y = value; break;
        case 2: z = value; break;
        default: break;
    }
    return *this;
}

double Vector3::getComponent(int index) const {
    switch (index) {
        case 0: return x;
        case 1: return y;
        case 2: return z;
        default: return 0;
    }
}

Vector3& Vector3::copy(const Vector3& v) {
    x = v.x;
    y = v.y;
    z = v.z;
    return *this;
}

Vector3& Vector3::add(const Vector3& v) {
    x += v.x;
    y += v.y;
    z += v.z;
    return *this;
}

Vector3& Vector3::addScalar(double s) {
    x += s;
    y += s;
    z += s;
    return *this;
}

Vector3& Vector3::addVectors(const Vector3& a, const Vector3& b) {
    x = a.x + b.x;
    y = a.y + b.y;
    z = a.z + b.z;
    return *this;
}

Vector3& Vector3::addScaledVector(const Vector3& v, double s) {
    x += v.x * s;
    y += v.y * s;
    z += v.z * s;
    return *this;
}

Vector3& Vector3::sub(const Vector3& v) {
    x -= v.x;
    y -= v.y;
    z -= v.z;
    return *this;
}

Vector3& Vector3::subScalar(double s) {
    x -= s;
    y -= s;
    z -= s;
    return *this;
}

Vector3& Vector3::subVectors(const Vector3& a, const Vector3& b) {
    x = a.x - b.x;
    y = a.y - b.y;
    z = a.z - b.z;
    return *this;
}

Vector3& Vector3::multiply(const Vector3& v) {
    x *= v.x;
    y *= v.y;
    z *= v.z;
    return *this;
}

Vector3& Vector3::multiplyScalar(double scalar) {
    x *= scalar;
    y *= scalar;
    z *= scalar;
    return *this;
}

Vector3& Vector3::multiplyVectors(const Vector3& a, const Vector3& b) {
    x = a.x * b.x;
    y = a.y * b.y;
    z = a.z * b.z;
    return *this;
}

Vector3& Vector3::applyEuler(const Euler& euler) {
    static Quaternion scratch;
    return applyQuaternion(scratch.setFromEuler(euler));
}

Vector3& Vector3::applyAxisAngle(const Vector3& axis, double angle) {
    static Quaternion scratch;
    return applyQuaternion(scratch.setFromAxisAngle(axis, angle));
}

Vector3& Vector3::applyMatrix3(const Matrix3& m) {
    const double vx = x, vy = y, vz = z;
    const double* e = m.elements.data();
    x = e[0] * vx + e[3] * vy + e[6] * vz;
    y = e[1] * vx + e[4] * vy + e[7] * vz;
    z = e[2] * vx + e[5] * vy + e[8] * vz;
    return *this;
}

Vector3& Vector3::applyNormalMatrix(const Matrix3& m) { return applyMatrix3(m).normalize(); }

Vector3& Vector3::applyMatrix4(const Matrix4& m) {
    const double vx = x, vy = y, vz = z;
    const double* e = m.elements.data();
    const double w = 1 / (e[3] * vx + e[7] * vy + e[11] * vz + e[15]);
    x = (e[0] * vx + e[4] * vy + e[8] * vz + e[12]) * w;
    y = (e[1] * vx + e[5] * vy + e[9] * vz + e[13]) * w;
    z = (e[2] * vx + e[6] * vy + e[10] * vz + e[14]) * w;
    return *this;
}

Vector3& Vector3::applyQuaternion(const Quaternion& q) {
    // quaternion q is assumed to have unit length
    const double vx = x, vy = y, vz = z;
    const double qx = q.x, qy = q.y, qz = q.z, qw = q.w;
    // t = 2 * cross( q.xyz, v );
    const double tx = 2 * (qy * vz - qz * vy);
    const double ty = 2 * (qz * vx - qx * vz);
    const double tz = 2 * (qx * vy - qy * vx);
    // v + q.w * t + cross( q.xyz, t );
    x = vx + qw * tx + qy * tz - qz * ty;
    y = vy + qw * ty + qz * tx - qx * tz;
    z = vz + qw * tz + qx * ty - qy * tx;
    return *this;
}

Vector3& Vector3::transformDirection(const Matrix4& m) {
    // input: a Matrix4 affine matrix, and this vector read as a direction
    const double vx = x, vy = y, vz = z;
    const double* e = m.elements.data();
    x = e[0] * vx + e[4] * vy + e[8] * vz;
    y = e[1] * vx + e[5] * vy + e[9] * vz;
    z = e[2] * vx + e[6] * vy + e[10] * vz;
    return normalize();
}

Vector3& Vector3::divide(const Vector3& v) {
    x /= v.x;
    y /= v.y;
    z /= v.z;
    return *this;
}

Vector3& Vector3::divideScalar(double scalar) { return multiplyScalar(1 / scalar); }

Vector3& Vector3::min(const Vector3& v) {
    x = jsMin(x, v.x);
    y = jsMin(y, v.y);
    z = jsMin(z, v.z);
    return *this;
}

Vector3& Vector3::max(const Vector3& v) {
    x = jsMax(x, v.x);
    y = jsMax(y, v.y);
    z = jsMax(z, v.z);
    return *this;
}

Vector3& Vector3::clamp(const Vector3& lo, const Vector3& hi) {
    x = tn::engine::clamp(x, lo.x, hi.x);
    y = tn::engine::clamp(y, lo.y, hi.y);
    z = tn::engine::clamp(z, lo.z, hi.z);
    return *this;
}

Vector3& Vector3::clampScalar(double lo, double hi) {
    x = tn::engine::clamp(x, lo, hi);
    y = tn::engine::clamp(y, lo, hi);
    z = tn::engine::clamp(z, lo, hi);
    return *this;
}

Vector3& Vector3::clampLength(double lo, double hi) {
    const double length = this->length();
    return divideScalar(orOne(length)).multiplyScalar(tn::engine::clamp(length, lo, hi));
}

Vector3& Vector3::floor() {
    x = std::floor(x);
    y = std::floor(y);
    z = std::floor(z);
    return *this;
}

Vector3& Vector3::ceil() {
    x = std::ceil(x);
    y = std::ceil(y);
    z = std::ceil(z);
    return *this;
}

Vector3& Vector3::round() {
    x = jsRound(x);
    y = jsRound(y);
    z = jsRound(z);
    return *this;
}

Vector3& Vector3::roundToZero() {
    x = std::trunc(x);
    y = std::trunc(y);
    z = std::trunc(z);
    return *this;
}

Vector3& Vector3::negate() {
    x = -x;
    y = -y;
    z = -z;
    return *this;
}

double Vector3::dot(const Vector3& v) const { return x * v.x + y * v.y + z * v.z; }

double Vector3::lengthSq() const { return x * x + y * y + z * z; }

double Vector3::length() const { return std::sqrt(x * x + y * y + z * z); }

double Vector3::manhattanLength() const { return std::fabs(x) + std::fabs(y) + std::fabs(z); }

Vector3& Vector3::normalize() { return divideScalar(orOne(length())); }

Vector3& Vector3::setLength(double length) { return normalize().multiplyScalar(length); }

Vector3& Vector3::lerp(const Vector3& v, double alpha) {
    x += (v.x - x) * alpha;
    y += (v.y - y) * alpha;
    z += (v.z - z) * alpha;
    return *this;
}

Vector3& Vector3::lerpVectors(const Vector3& v1, const Vector3& v2, double alpha) {
    x = v1.x + (v2.x - v1.x) * alpha;
    y = v1.y + (v2.y - v1.y) * alpha;
    z = v1.z + (v2.z - v1.z) * alpha;
    return *this;
}

Vector3& Vector3::cross(const Vector3& v) { return crossVectors(*this, v); }

Vector3& Vector3::crossVectors(const Vector3& a, const Vector3& b) {
    const double ax = a.x, ay = a.y, az = a.z;
    const double bx = b.x, by = b.y, bz = b.z;
    x = ay * bz - az * by;
    y = az * bx - ax * bz;
    z = ax * by - ay * bx;
    return *this;
}

Vector3& Vector3::projectOnVector(const Vector3& v) {
    const double denominator = v.lengthSq();
    if (denominator == 0) return set(0, 0, 0);
    const double scalar = v.dot(*this) / denominator;
    return copy(v).multiplyScalar(scalar);
}

Vector3& Vector3::projectOnPlane(const Vector3& planeNormal) {
    static Vector3 scratch;
    scratch.copy(*this).projectOnVector(planeNormal);
    return sub(scratch);
}

Vector3& Vector3::reflect(const Vector3& normal) {
    static Vector3 scratch;
    return sub(scratch.copy(normal).multiplyScalar(2 * dot(normal)));
}

double Vector3::angleTo(const Vector3& v) const {
    const double denominator = std::sqrt(lengthSq() * v.lengthSq());
    if (denominator == 0) return PI / 2;
    const double theta = dot(v) / denominator;
    // clamp, to handle numerical problems
    return ieee754::acos(tn::engine::clamp(theta, -1, 1));
}

double Vector3::distanceTo(const Vector3& v) const { return std::sqrt(distanceToSquared(v)); }

double Vector3::distanceToSquared(const Vector3& v) const {
    const double dx = x - v.x, dy = y - v.y, dz = z - v.z;
    return dx * dx + dy * dy + dz * dz;
}

double Vector3::manhattanDistanceTo(const Vector3& v) const {
    return std::fabs(x - v.x) + std::fabs(y - v.y) + std::fabs(z - v.z);
}

Vector3& Vector3::setFromSphericalCoords(double radius, double phi, double theta) {
    const double sinPhiRadius = ieee754::sin(phi) * radius;
    x = sinPhiRadius * ieee754::sin(theta);
    y = ieee754::cos(phi) * radius;
    z = sinPhiRadius * ieee754::cos(theta);
    return *this;
}

Vector3& Vector3::setFromCylindricalCoords(double radius, double theta, double y) {
    x = radius * ieee754::sin(theta);
    this->y = y;
    z = radius * ieee754::cos(theta);
    return *this;
}

Vector3& Vector3::setFromMatrixPosition(const Matrix4& m) {
    const double* e = m.elements.data();
    x = e[12];
    y = e[13];
    z = e[14];
    return *this;
}

Vector3& Vector3::setFromMatrixScale(const Matrix4& m) {
    const double sx = setFromMatrixColumn(m, 0).length();
    const double sy = setFromMatrixColumn(m, 1).length();
    const double sz = setFromMatrixColumn(m, 2).length();
    x = sx;
    y = sy;
    z = sz;
    return *this;
}

Vector3& Vector3::setFromMatrixColumn(const Matrix4& m, int index) {
    return fromArray(m.elements.data(), index * 4);
}

Vector3& Vector3::setFromMatrix3Column(const Matrix3& m, int index) {
    return fromArray(m.elements.data(), index * 3);
}

Vector3& Vector3::setFromEuler(const Euler& e) {
    x = e.x;
    y = e.y;
    z = e.z;
    return *this;
}

Vector3& Vector3::setFromColor(const Color& c) {
    x = c.r;
    y = c.g;
    z = c.b;
    return *this;
}

bool Vector3::equals(const Vector3& v) const { return v.x == x && v.y == y && v.z == z; }

Vector3& Vector3::fromArray(const double* array, int offset) {
    x = array[offset];
    y = array[offset + 1];
    z = array[offset + 2];
    return *this;
}

Vector4& Vector4::set(double x, double y, double z, double w) {
    this->x = x;
    this->y = y;
    this->z = z;
    this->w = w;
    return *this;
}

Vector4& Vector4::setScalar(double scalar) {
    x = scalar;
    y = scalar;
    z = scalar;
    w = scalar;
    return *this;
}

Vector4& Vector4::setX(double v) {
    x = v;
    return *this;
}

Vector4& Vector4::setY(double v) {
    y = v;
    return *this;
}

Vector4& Vector4::setZ(double v) {
    z = v;
    return *this;
}

Vector4& Vector4::setW(double v) {
    w = v;
    return *this;
}

Vector4& Vector4::setComponent(int index, double value) {
    switch (index) {
        case 0: x = value; break;
        case 1: y = value; break;
        case 2: z = value; break;
        case 3: w = value; break;
        default: break;
    }
    return *this;
}

double Vector4::getComponent(int index) const {
    switch (index) {
        case 0: return x;
        case 1: return y;
        case 2: return z;
        case 3: return w;
        default: return 0;
    }
}

Vector4& Vector4::copy(const Vector4& v) {
    x = v.x;
    y = v.y;
    z = v.z;
    w = v.w;
    return *this;
}

Vector4& Vector4::add(const Vector4& v) {
    x += v.x;
    y += v.y;
    z += v.z;
    w += v.w;
    return *this;
}

Vector4& Vector4::addScalar(double s) {
    x += s;
    y += s;
    z += s;
    w += s;
    return *this;
}

Vector4& Vector4::addVectors(const Vector4& a, const Vector4& b) {
    x = a.x + b.x;
    y = a.y + b.y;
    z = a.z + b.z;
    w = a.w + b.w;
    return *this;
}

Vector4& Vector4::addScaledVector(const Vector4& v, double s) {
    x += v.x * s;
    y += v.y * s;
    z += v.z * s;
    w += v.w * s;
    return *this;
}

Vector4& Vector4::sub(const Vector4& v) {
    x -= v.x;
    y -= v.y;
    z -= v.z;
    w -= v.w;
    return *this;
}

Vector4& Vector4::subScalar(double s) {
    x -= s;
    y -= s;
    z -= s;
    w -= s;
    return *this;
}

Vector4& Vector4::subVectors(const Vector4& a, const Vector4& b) {
    x = a.x - b.x;
    y = a.y - b.y;
    z = a.z - b.z;
    w = a.w - b.w;
    return *this;
}

Vector4& Vector4::multiply(const Vector4& v) {
    x *= v.x;
    y *= v.y;
    z *= v.z;
    w *= v.w;
    return *this;
}

Vector4& Vector4::multiplyScalar(double scalar) {
    x *= scalar;
    y *= scalar;
    z *= scalar;
    w *= scalar;
    return *this;
}

Vector4& Vector4::applyMatrix4(const Matrix4& m) {
    const double vx = x, vy = y, vz = z, vw = w;
    const double* e = m.elements.data();
    x = e[0] * vx + e[4] * vy + e[8] * vz + e[12] * vw;
    y = e[1] * vx + e[5] * vy + e[9] * vz + e[13] * vw;
    z = e[2] * vx + e[6] * vy + e[10] * vz + e[14] * vw;
    w = e[3] * vx + e[7] * vy + e[11] * vz + e[15] * vw;
    return *this;
}

Vector4& Vector4::divide(const Vector4& v) {
    x /= v.x;
    y /= v.y;
    z /= v.z;
    w /= v.w;
    return *this;
}

Vector4& Vector4::divideScalar(double scalar) { return multiplyScalar(1 / scalar); }

Vector4& Vector4::setAxisAngleFromQuaternion(const Quaternion& q) {
    // q is assumed to be normalized
    w = 2 * ieee754::acos(q.w);
    const double s = std::sqrt(1 - q.w * q.w);
    if (s < 0.0001) {
        x = 1;
        y = 0;
        z = 0;
    } else {
        x = q.x / s;
        y = q.y / s;
        z = q.z / s;
    }
    return *this;
}

Vector4& Vector4::setAxisAngleFromRotationMatrix(const Matrix4& m) {
    // assumes the upper 3x3 of m is a pure rotation matrix (i.e, unscaled)
    double angle = 0, x = 0, y = 0, z = 0;
    const double epsilon = 0.01;   // margin to allow for rounding errors
    const double epsilon2 = 0.1;   // margin to distinguish between 0 and 180 degrees
    const double* te = m.elements.data();
    const double m11 = te[0], m12 = te[4], m13 = te[8];
    const double m21 = te[1], m22 = te[5], m23 = te[9];
    const double m31 = te[2], m32 = te[6], m33 = te[10];
    if ((std::fabs(m12 - m21) < epsilon) && (std::fabs(m13 - m31) < epsilon) &&
        (std::fabs(m23 - m32) < epsilon)) {
        // singularity found
        // first check for identity matrix, which must have +1 for every leading-diagonal term
        if ((std::fabs(m12 + m21) < epsilon2) && (std::fabs(m13 + m31) < epsilon2) &&
            (std::fabs(m23 + m32) < epsilon2) && (std::fabs(m11 + m22 + m33 - 3) < epsilon2)) {
            // this singularity is identity, so the angle is 0 and the axis arbitrary
            return set(1, 0, 0, 0);
        }
        // otherwise this singularity is an angle of 180
        angle = PI;
        const double xx = (m11 + 1) / 2;
        const double yy = (m22 + 1) / 2;
        const double zz = (m33 + 1) / 2;
        const double xy = (m12 + m21) / 4;
        const double xz = (m13 + m31) / 4;
        const double yz = (m23 + m32) / 4;
        if ((xx > yy) && (xx > zz)) {
            // m11 is the largest diagonal term
            if (xx < epsilon) {
                x = 0;
                y = 0.707106781;
                z = 0.707106781;
            } else {
                x = std::sqrt(xx);
                y = xy / x;
                z = xz / x;
            }
        } else if (yy > zz) {
            // m22 is the largest diagonal term
            if (yy < epsilon) {
                x = 0.707106781;
                y = 0;
                z = 0.707106781;
            } else {
                y = std::sqrt(yy);
                x = xy / y;
                z = yz / y;
            }
        } else {
            // m33 is the largest diagonal term, so the result is based on this
            if (zz < epsilon) {
                x = 0.707106781;
                y = 0.707106781;
                z = 0;
            } else {
                z = std::sqrt(zz);
                x = xz / z;
                y = yz / z;
            }
        }
        return set(x, y, z, angle);
    }
    // there are no singularities here, so the normal case applies
    double s = std::sqrt((m32 - m23) * (m32 - m23) + (m13 - m31) * (m13 - m31) +
                         (m21 - m12) * (m21 - m12));  // used to normalize
    if (std::fabs(s) < 0.001) s = 1;
    // prevent divide by zero; the singularity test above should already have caught this.
    // The members are written, not the locals the 180-degree branch above uses.
    this->x = (m32 - m23) / s;
    this->y = (m13 - m31) / s;
    this->z = (m21 - m12) / s;
    this->w = ieee754::acos((m11 + m22 + m33 - 1) / 2);
    return *this;
}

Vector4& Vector4::setFromMatrixPosition(const Matrix4& m) {
    const double* e = m.elements.data();
    x = e[12];
    y = e[13];
    z = e[14];
    w = e[15];
    return *this;
}

Vector4& Vector4::min(const Vector4& v) {
    x = jsMin(x, v.x);
    y = jsMin(y, v.y);
    z = jsMin(z, v.z);
    w = jsMin(w, v.w);
    return *this;
}

Vector4& Vector4::max(const Vector4& v) {
    x = jsMax(x, v.x);
    y = jsMax(y, v.y);
    z = jsMax(z, v.z);
    w = jsMax(w, v.w);
    return *this;
}

Vector4& Vector4::clamp(const Vector4& lo, const Vector4& hi) {
    x = tn::engine::clamp(x, lo.x, hi.x);
    y = tn::engine::clamp(y, lo.y, hi.y);
    z = tn::engine::clamp(z, lo.z, hi.z);
    w = tn::engine::clamp(w, lo.w, hi.w);
    return *this;
}

Vector4& Vector4::clampScalar(double lo, double hi) {
    x = tn::engine::clamp(x, lo, hi);
    y = tn::engine::clamp(y, lo, hi);
    z = tn::engine::clamp(z, lo, hi);
    w = tn::engine::clamp(w, lo, hi);
    return *this;
}

Vector4& Vector4::clampLength(double lo, double hi) {
    const double length = this->length();
    return divideScalar(orOne(length)).multiplyScalar(tn::engine::clamp(length, lo, hi));
}

Vector4& Vector4::floor() {
    x = std::floor(x);
    y = std::floor(y);
    z = std::floor(z);
    w = std::floor(w);
    return *this;
}

Vector4& Vector4::ceil() {
    x = std::ceil(x);
    y = std::ceil(y);
    z = std::ceil(z);
    w = std::ceil(w);
    return *this;
}

Vector4& Vector4::round() {
    x = jsRound(x);
    y = jsRound(y);
    z = jsRound(z);
    w = jsRound(w);
    return *this;
}

Vector4& Vector4::roundToZero() {
    x = std::trunc(x);
    y = std::trunc(y);
    z = std::trunc(z);
    w = std::trunc(w);
    return *this;
}

Vector4& Vector4::negate() {
    x = -x;
    y = -y;
    z = -z;
    w = -w;
    return *this;
}

double Vector4::dot(const Vector4& v) const { return x * v.x + y * v.y + z * v.z + w * v.w; }

double Vector4::lengthSq() const { return x * x + y * y + z * z + w * w; }

double Vector4::length() const { return std::sqrt(x * x + y * y + z * z + w * w); }

double Vector4::manhattanLength() const {
    return std::fabs(x) + std::fabs(y) + std::fabs(z) + std::fabs(w);
}

Vector4& Vector4::normalize() { return divideScalar(orOne(length())); }

Vector4& Vector4::setLength(double length) { return normalize().multiplyScalar(length); }

Vector4& Vector4::lerp(const Vector4& v, double alpha) {
    x += (v.x - x) * alpha;
    y += (v.y - y) * alpha;
    z += (v.z - z) * alpha;
    w += (v.w - w) * alpha;
    return *this;
}

Vector4& Vector4::lerpVectors(const Vector4& v1, const Vector4& v2, double alpha) {
    x = v1.x + (v2.x - v1.x) * alpha;
    y = v1.y + (v2.y - v1.y) * alpha;
    z = v1.z + (v2.z - v1.z) * alpha;
    w = v1.w + (v2.w - v1.w) * alpha;
    return *this;
}

bool Vector4::equals(const Vector4& v) const {
    return v.x == x && v.y == y && v.z == z && v.w == w;
}

Vector4& Vector4::fromArray(const double* array, int offset) {
    x = array[offset];
    y = array[offset + 1];
    z = array[offset + 2];
    w = array[offset + 3];
    return *this;
}

}  // namespace tn::engine
