#pragma once

// Quaternion, ported from three@0.185.1 src/math/Quaternion.js. The convention is three's:
// (x, y, z, w), unit length expected, right-handed, and `setFromRotationMatrix` picks its branch in
// the reference's order, because the branch decides which square roots run.
//
// Not ported: `fromBufferAttribute` (a BufferAttribute, PRD-504), `toJSON`/`random` (JSON text and
// Math.random are not reproducible), and the `Symbol.iterator`.
//
// Deviation: three keeps `_x` private and fires `_onChangeCallback` from the public `x`/`y`/`z`/`w`
// setters. Here the components are plain public doubles (the fixture protocol reads them by path),
// so the callback fires from the methods below and a direct component write is not observed.

#include <array>
#include <cstddef>

namespace tn::engine {

class Euler;
class Matrix4;
class Vector3;

/**
 * `Quaternion.slerpFlat` over four consecutive doubles: the flat-array form the instanced and
 * storage paths use, so it takes and returns raw doubles instead of Quaternion objects.
 */
void slerpFlat(double* dst, std::size_t dstOffset, const double* src0, std::size_t srcOffset0,
               const double* src1, std::size_t srcOffset1, double t);

/** `Quaternion.multiplyQuaternionsFlat`: the same product, over four consecutive doubles. */
double* multiplyQuaternionsFlat(double* dst, std::size_t dstOffset, const double* src0,
                                std::size_t srcOffset0, const double* src1, std::size_t srcOffset1);

class Quaternion {
public:
    /** three's `_onChangeCallback`: one function and its context, so a Quaternion costs nothing. */
    using OnChange = void (*)(void* context);

    double x = 0;
    double y = 0;
    double z = 0;
    double w = 1;

    Quaternion() = default;
    Quaternion(double x, double y, double z, double w) : x(x), y(y), z(z), w(w) {}
    /** three's `clone()`: values only, and the new value carries no change callback. */
    Quaternion(const Quaternion& other) : x(other.x), y(other.y), z(other.z), w(other.w) {}
    /** three's `copy(other)`: values plus the target's own callback, which then fires. */
    Quaternion& operator=(const Quaternion& other) { return copy(other); }

    Quaternion& set(double x, double y, double z, double w);
    [[nodiscard]] Quaternion clone() const { return *this; }
    /** Overwrites the values, keeps this object's callback, and notifies, as three's `copy` does. */
    Quaternion& copy(const Quaternion& q);
    /** `update` is three's own flag: false suppresses the notification Object3D's sync relies on. */
    Quaternion& setFromEuler(const Euler& euler, bool update = true);
    Quaternion& setFromAxisAngle(const Vector3& axis, double angle);
    /** `matrix` is read through its upper 3x3 only, and must be a pure rotation matrix. */
    Quaternion& setFromRotationMatrix(const Matrix4& m);
    /** Both arguments are assumed to be direction vectors (normalized). */
    Quaternion& setFromUnitVectors(const Vector3& vFrom, const Vector3& vTo);
    /** Registers the change notification three's `_onChange` takes; a null callback clears it. */
    void onChange(OnChange callback, void* context) {
        onChange_ = callback;
        onChangeContext_ = context;
    }
    [[nodiscard]] double angleTo(const Quaternion& q) const;
    Quaternion& rotateTowards(const Quaternion& q, double step);
    Quaternion& identity();
    Quaternion& invert();
    Quaternion& conjugate();
    [[nodiscard]] double dot(const Quaternion& v) const;
    [[nodiscard]] double lengthSq() const;
    [[nodiscard]] double length() const;
    Quaternion& normalize();
    Quaternion& multiply(const Quaternion& q);
    Quaternion& premultiply(const Quaternion& q);
    Quaternion& multiplyQuaternions(const Quaternion& a, const Quaternion& b);
    Quaternion& slerp(const Quaternion& qb, double t);
    Quaternion& slerpQuaternions(const Quaternion& qa, const Quaternion& qb, double t);
    [[nodiscard]] bool equals(const Quaternion& q) const;
    Quaternion& fromArray(const double* array, int offset = 0);
    [[nodiscard]] std::array<double, 4> toArray() const { return {x, y, z, w}; }

    /**
     * three's `_onChangeCallback()`: what its public component setters fire. A caller that writes a
     * component field directly (a binding's `x` setter) calls this, so the other rotation form syncs.
     */
    void notify() const {
        if (onChange_ != nullptr) onChange_(onChangeContext_);
    }

private:

    OnChange onChange_ = nullptr;
    void* onChangeContext_ = nullptr;
};

}  // namespace tn::engine
