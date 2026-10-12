#pragma once

// Vector2, Vector3 and Vector4, ported from three@0.185.1 src/math/Vector{2,3,4}.js. Every method
// that mutates returns `*this`, and the arithmetic keeps three's operation order, because the
// differential fixtures compare binary64 bits against the reference.
//
// Camera projection is implemented in the scene layer.
// Not ported: `fromBufferAttribute` (a BufferAttribute, PRD-504),
// `setFromSpherical`/`setFromCylindrical` (the Spherical and Cylindrical classes are
// outside this port; the `*Coords` forms take plain numbers and are here), `random` and
// `randomDirection` (Math.random is not reproducible, so a fixture could never match it), and the
// `Symbol.iterator` generator.

#include <array>

namespace tn::engine {

class Euler;

class Vector2 {
public:
    double x = 0;
    double y = 0;

    Vector2() = default;
    Vector2(double x, double y) : x(x), y(y) {}

    /** three aliases width onto x for 2D sizes. */
    [[nodiscard]] double width() const { return x; }
    [[nodiscard]] double height() const { return y; }

    Vector2& set(double x, double y);
    Vector2& setScalar(double scalar);
    Vector2& setX(double x);
    Vector2& setY(double y);
    /** `index` outside 0..1 is a caller error: three throws there and engine code does not throw. */
    Vector2& setComponent(int index, double value);
    [[nodiscard]] double getComponent(int index) const;
    [[nodiscard]] Vector2 clone() const { return *this; }
    Vector2& copy(const Vector2& v);

    Vector2& add(const Vector2& v);
    Vector2& addScalar(double s);
    Vector2& addVectors(const Vector2& a, const Vector2& b);
    Vector2& addScaledVector(const Vector2& v, double s);
    Vector2& sub(const Vector2& v);
    Vector2& subScalar(double s);
    Vector2& subVectors(const Vector2& a, const Vector2& b);
    Vector2& multiply(const Vector2& v);
    Vector2& multiplyScalar(double scalar);
    Vector2& divide(const Vector2& v);
    Vector2& divideScalar(double scalar);
    Vector2& applyMatrix3(const class Matrix3& m);
    Vector2& min(const Vector2& v);
    Vector2& max(const Vector2& v);
    Vector2& clamp(const Vector2& lo, const Vector2& hi);
    Vector2& clampScalar(double lo, double hi);
    Vector2& clampLength(double lo, double hi);
    Vector2& floor();
    Vector2& ceil();
    Vector2& round();
    Vector2& roundToZero();
    Vector2& negate();

    [[nodiscard]] double dot(const Vector2& v) const;
    [[nodiscard]] double cross(const Vector2& v) const;
    [[nodiscard]] double lengthSq() const;
    [[nodiscard]] double length() const;
    [[nodiscard]] double manhattanLength() const;
    Vector2& normalize();
    [[nodiscard]] double angle() const;
    [[nodiscard]] double angleTo(const Vector2& v) const;
    [[nodiscard]] double distanceTo(const Vector2& v) const;
    [[nodiscard]] double distanceToSquared(const Vector2& v) const;
    [[nodiscard]] double manhattanDistanceTo(const Vector2& v) const;
    Vector2& setLength(double length);
    Vector2& lerp(const Vector2& v, double alpha);
    Vector2& lerpVectors(const Vector2& v1, const Vector2& v2, double alpha);
    [[nodiscard]] bool equals(const Vector2& v) const;
    Vector2& fromArray(const double* array, int offset = 0);
    [[nodiscard]] std::array<double, 2> toArray() const { return {x, y}; }
    Vector2& rotateAround(const Vector2& center, double angle);
};

class Vector3 {
public:
    double x = 0;
    double y = 0;
    double z = 0;

    Vector3() = default;
    Vector3(double x, double y, double z) : x(x), y(y), z(z) {}

    /** three's two-argument `set` keeps z, for the sprite-scale call shape. */
    Vector3& set(double x, double y);
    Vector3& set(double x, double y, double z);
    Vector3& setScalar(double scalar);
    Vector3& setX(double x);
    Vector3& setY(double y);
    Vector3& setZ(double z);
    /** `index` outside 0..2 is a caller error: three throws there and engine code does not throw. */
    Vector3& setComponent(int index, double value);
    [[nodiscard]] double getComponent(int index) const;
    [[nodiscard]] Vector3 clone() const { return *this; }
    Vector3& copy(const Vector3& v);

    Vector3& add(const Vector3& v);
    Vector3& addScalar(double s);
    Vector3& addVectors(const Vector3& a, const Vector3& b);
    Vector3& addScaledVector(const Vector3& v, double s);
    Vector3& sub(const Vector3& v);
    Vector3& subScalar(double s);
    Vector3& subVectors(const Vector3& a, const Vector3& b);
    Vector3& multiply(const Vector3& v);
    Vector3& multiplyScalar(double scalar);
    Vector3& multiplyVectors(const Vector3& a, const Vector3& b);
    Vector3& applyEuler(const Euler& euler);
    Vector3& applyAxisAngle(const Vector3& axis, double angle);
    Vector3& applyMatrix3(const class Matrix3& m);
    Vector3& applyNormalMatrix(const class Matrix3& m);
    Vector3& applyMatrix4(const class Matrix4& m);
    Vector3& project(const class Camera& camera);
    Vector3& unproject(const class Camera& camera);
    Vector3& applyQuaternion(const class Quaternion& q);
    Vector3& transformDirection(const class Matrix4& m);
    Vector3& divide(const Vector3& v);
    Vector3& divideScalar(double scalar);
    Vector3& min(const Vector3& v);
    Vector3& max(const Vector3& v);
    Vector3& clamp(const Vector3& lo, const Vector3& hi);
    Vector3& clampScalar(double lo, double hi);
    Vector3& clampLength(double lo, double hi);
    Vector3& floor();
    Vector3& ceil();
    Vector3& round();
    Vector3& roundToZero();
    Vector3& negate();

    [[nodiscard]] double dot(const Vector3& v) const;
    [[nodiscard]] double lengthSq() const;
    [[nodiscard]] double length() const;
    [[nodiscard]] double manhattanLength() const;
    Vector3& normalize();
    Vector3& setLength(double length);
    Vector3& lerp(const Vector3& v, double alpha);
    Vector3& lerpVectors(const Vector3& v1, const Vector3& v2, double alpha);
    Vector3& cross(const Vector3& v);
    Vector3& crossVectors(const Vector3& a, const Vector3& b);
    Vector3& projectOnVector(const Vector3& v);
    Vector3& projectOnPlane(const Vector3& planeNormal);
    Vector3& reflect(const Vector3& normal);
    [[nodiscard]] double angleTo(const Vector3& v) const;
    [[nodiscard]] double distanceTo(const Vector3& v) const;
    [[nodiscard]] double distanceToSquared(const Vector3& v) const;
    [[nodiscard]] double manhattanDistanceTo(const Vector3& v) const;
    Vector3& setFromSphericalCoords(double radius, double phi, double theta);
    Vector3& setFromCylindricalCoords(double radius, double theta, double y);
    Vector3& setFromMatrixPosition(const class Matrix4& m);
    Vector3& setFromMatrixScale(const class Matrix4& m);
    Vector3& setFromMatrixColumn(const class Matrix4& m, int index);
    Vector3& setFromMatrix3Column(const class Matrix3& m, int index);
    Vector3& setFromEuler(const Euler& e);
    Vector3& setFromColor(const class Color& c);
    [[nodiscard]] bool equals(const Vector3& v) const;
    Vector3& fromArray(const double* array, int offset = 0);
    [[nodiscard]] std::array<double, 3> toArray() const { return {x, y, z}; }
};

class Vector4 {
public:
    double x = 0;
    double y = 0;
    double z = 0;
    double w = 1;

    Vector4() = default;
    Vector4(double x, double y, double z, double w) : x(x), y(y), z(z), w(w) {}

    /** three aliases width onto z and height onto w for 2D sizes. */
    [[nodiscard]] double width() const { return z; }
    [[nodiscard]] double height() const { return w; }

    Vector4& set(double x, double y, double z, double w);
    Vector4& setScalar(double scalar);
    Vector4& setX(double x);
    Vector4& setY(double y);
    Vector4& setZ(double z);
    Vector4& setW(double w);
    /** `index` outside 0..3 is a caller error: three throws there and engine code does not throw. */
    Vector4& setComponent(int index, double value);
    [[nodiscard]] double getComponent(int index) const;
    [[nodiscard]] Vector4 clone() const { return *this; }
    Vector4& copy(const Vector4& v);

    Vector4& add(const Vector4& v);
    Vector4& addScalar(double s);
    Vector4& addVectors(const Vector4& a, const Vector4& b);
    Vector4& addScaledVector(const Vector4& v, double s);
    Vector4& sub(const Vector4& v);
    Vector4& subScalar(double s);
    Vector4& subVectors(const Vector4& a, const Vector4& b);
    Vector4& multiply(const Vector4& v);
    Vector4& multiplyScalar(double scalar);
    Vector4& applyMatrix4(const class Matrix4& m);
    Vector4& divide(const Vector4& v);
    Vector4& divideScalar(double scalar);
    Vector4& setAxisAngleFromQuaternion(const class Quaternion& q);
    Vector4& setAxisAngleFromRotationMatrix(const class Matrix4& m);
    Vector4& setFromMatrixPosition(const class Matrix4& m);
    Vector4& min(const Vector4& v);
    Vector4& max(const Vector4& v);
    Vector4& clamp(const Vector4& lo, const Vector4& hi);
    Vector4& clampScalar(double lo, double hi);
    Vector4& clampLength(double lo, double hi);
    Vector4& floor();
    Vector4& ceil();
    Vector4& round();
    Vector4& roundToZero();
    Vector4& negate();

    [[nodiscard]] double dot(const Vector4& v) const;
    [[nodiscard]] double lengthSq() const;
    [[nodiscard]] double length() const;
    [[nodiscard]] double manhattanLength() const;
    Vector4& normalize();
    Vector4& setLength(double length);
    Vector4& lerp(const Vector4& v, double alpha);
    Vector4& lerpVectors(const Vector4& v1, const Vector4& v2, double alpha);
    [[nodiscard]] bool equals(const Vector4& v) const;
    Vector4& fromArray(const double* array, int offset = 0);
    [[nodiscard]] std::array<double, 4> toArray() const { return {x, y, z, w}; }
};

}  // namespace tn::engine
