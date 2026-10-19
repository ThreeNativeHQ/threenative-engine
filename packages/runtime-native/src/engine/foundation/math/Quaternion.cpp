#include "engine/foundation/math/Quaternion.h"

#include "engine/foundation/math/Euler.h"
#include "engine/foundation/math/MathUtils.h"
#include "engine/foundation/math/Matrix.h"
#include "engine/foundation/math/Vector.h"
#include "engine/foundation/math/ieee754.h"

#include <cmath>

namespace tn::engine {

void slerpFlat(double* dst, std::size_t dstOffset, const double* src0, std::size_t srcOffset0,
               const double* src1, std::size_t srcOffset1, double t) {
    double x0 = src0[srcOffset0 + 0], y0 = src0[srcOffset0 + 1],
        z0 = src0[srcOffset0 + 2], w0 = src0[srcOffset0 + 3];
    double x1 = src1[srcOffset1 + 0], y1 = src1[srcOffset1 + 1],
        z1 = src1[srcOffset1 + 2], w1 = src1[srcOffset1 + 3];
    if (w0 != w1 || x0 != x1 || y0 != y1 || z0 != z1) {
        double dot = x0 * x1 + y0 * y1 + z0 * z1 + w0 * w1;
        if (dot < 0) {
            x1 = -x1;
            y1 = -y1;
            z1 = -z1;
            w1 = -w1;
            dot = -dot;
        }
        double s = 1 - t;
        if (dot < 0.9995) {
            // slerp
            const double theta = ieee754::acos(dot);
            const double sin = ieee754::sin(theta);
            s = ieee754::sin(s * theta) / sin;
            t = ieee754::sin(t * theta) / sin;
            x0 = x0 * s + x1 * t;
            y0 = y0 * s + y1 * t;
            z0 = z0 * s + z1 * t;
            w0 = w0 * s + w1 * t;
        } else {
            // for small angles, lerp then normalize
            x0 = x0 * s + x1 * t;
            y0 = y0 * s + y1 * t;
            z0 = z0 * s + z1 * t;
            w0 = w0 * s + w1 * t;
            const double f = 1 / std::sqrt(x0 * x0 + y0 * y0 + z0 * z0 + w0 * w0);
            x0 *= f;
            y0 *= f;
            z0 *= f;
            w0 *= f;
        }
    }
    dst[dstOffset] = x0;
    dst[dstOffset + 1] = y0;
    dst[dstOffset + 2] = z0;
    dst[dstOffset + 3] = w0;
}

double* multiplyQuaternionsFlat(double* dst, std::size_t dstOffset, const double* src0,
                                std::size_t srcOffset0, const double* src1, std::size_t srcOffset1) {
    const double x0 = src0[srcOffset0];
    const double y0 = src0[srcOffset0 + 1];
    const double z0 = src0[srcOffset0 + 2];
    const double w0 = src0[srcOffset0 + 3];
    const double x1 = src1[srcOffset1];
    const double y1 = src1[srcOffset1 + 1];
    const double z1 = src1[srcOffset1 + 2];
    const double w1 = src1[srcOffset1 + 3];
    dst[dstOffset] = x0 * w1 + w0 * x1 + y0 * z1 - z0 * y1;
    dst[dstOffset + 1] = y0 * w1 + w0 * y1 + z0 * x1 - x0 * z1;
    dst[dstOffset + 2] = z0 * w1 + w0 * z1 + x0 * y1 - y0 * x1;
    dst[dstOffset + 3] = w0 * w1 - x0 * x1 - y0 * y1 - z0 * z1;
    return dst;
}

Quaternion& Quaternion::set(double x, double y, double z, double w) {
    this->x = x;
    this->y = y;
    this->z = z;
    this->w = w;
    notify();
    return *this;
}

Quaternion& Quaternion::copy(const Quaternion& q) {
    x = q.x;
    y = q.y;
    z = q.z;
    w = q.w;
    notify();
    return *this;
}

Quaternion& Quaternion::setFromEuler(const Euler& euler, bool update) {
    const double ex = euler.x, ey = euler.y, ez = euler.z;
    double c1, c2, c3, s1, s2, s3;
    ieee754::sincos(ex / 2, s1, c1);
    ieee754::sincos(ey / 2, s2, c2);
    ieee754::sincos(ez / 2, s3, c3);
    switch (euler.order) {
        case EulerOrder::XYZ:
            x = s1 * c2 * c3 + c1 * s2 * s3;
            y = c1 * s2 * c3 - s1 * c2 * s3;
            z = c1 * c2 * s3 + s1 * s2 * c3;
            w = c1 * c2 * c3 - s1 * s2 * s3;
            break;
        case EulerOrder::YXZ:
            x = s1 * c2 * c3 + c1 * s2 * s3;
            y = c1 * s2 * c3 - s1 * c2 * s3;
            z = c1 * c2 * s3 - s1 * s2 * c3;
            w = c1 * c2 * c3 + s1 * s2 * s3;
            break;
        case EulerOrder::ZXY:
            x = s1 * c2 * c3 - c1 * s2 * s3;
            y = c1 * s2 * c3 + s1 * c2 * s3;
            z = c1 * c2 * s3 + s1 * s2 * c3;
            w = c1 * c2 * c3 - s1 * s2 * s3;
            break;
        case EulerOrder::ZYX:
            x = s1 * c2 * c3 - c1 * s2 * s3;
            y = c1 * s2 * c3 + s1 * c2 * s3;
            z = c1 * c2 * s3 - s1 * s2 * c3;
            w = c1 * c2 * c3 + s1 * s2 * s3;
            break;
        case EulerOrder::YZX:
            x = s1 * c2 * c3 + c1 * s2 * s3;
            y = c1 * s2 * c3 + s1 * c2 * s3;
            z = c1 * c2 * s3 - s1 * s2 * c3;
            w = c1 * c2 * c3 - s1 * s2 * s3;
            break;
        case EulerOrder::XZY:
            x = s1 * c2 * c3 - c1 * s2 * s3;
            y = c1 * s2 * c3 - s1 * c2 * s3;
            z = c1 * c2 * s3 + s1 * s2 * c3;
            w = c1 * c2 * c3 + s1 * s2 * s3;
            break;
    }
    if (update) notify();
    return *this;
}

Quaternion& Quaternion::setFromAxisAngle(const Vector3& axis, double angle) {
    const double halfAngle = angle / 2, s = ieee754::sin(halfAngle);
    x = axis.x * s;
    y = axis.y * s;
    z = axis.z * s;
    w = ieee754::cos(halfAngle);
    notify();
    return *this;
}

Quaternion& Quaternion::setFromRotationMatrix(const Matrix4& m) {
    // assumes the upper 3x3 of m is a pure rotation matrix (i.e, unscaled)
    const double* te = m.elements.data();
    const double m11 = te[0], m12 = te[4], m13 = te[8],
                m21 = te[1], m22 = te[5], m23 = te[9],
                m31 = te[2], m32 = te[6], m33 = te[10],
                trace = m11 + m22 + m33;
    if (trace > 0) {
        const double s = 0.5 / std::sqrt(trace + 1.0);
        w = 0.25 / s;
        x = (m32 - m23) * s;
        y = (m13 - m31) * s;
        z = (m21 - m12) * s;
    } else if (m11 > m22 && m11 > m33) {
        const double s = 2.0 * std::sqrt(1.0 + m11 - m22 - m33);
        w = (m32 - m23) / s;
        x = 0.25 * s;
        y = (m12 + m21) / s;
        z = (m13 + m31) / s;
    } else if (m22 > m33) {
        const double s = 2.0 * std::sqrt(1.0 + m22 - m11 - m33);
        w = (m13 - m31) / s;
        x = (m12 + m21) / s;
        y = 0.25 * s;
        z = (m23 + m32) / s;
    } else {
        const double s = 2.0 * std::sqrt(1.0 + m33 - m11 - m22);
        w = (m21 - m12) / s;
        x = (m13 + m31) / s;
        y = (m23 + m32) / s;
        z = 0.25 * s;
    }
    notify();
    return *this;
}

Quaternion& Quaternion::setFromUnitVectors(const Vector3& vFrom, const Vector3& vTo) {
    // assumes direction vectors vFrom and vTo are normalized
    double r = vFrom.dot(vTo) + 1;
    if (r < 1e-8) {
        // vFrom and vTo point in opposite directions
        r = 0;
        if (std::fabs(vFrom.x) > std::fabs(vFrom.z)) {
            x = -vFrom.y;
            y = vFrom.x;
            z = 0;
            w = r;
        } else {
            x = 0;
            y = -vFrom.z;
            z = vFrom.y;
            w = r;
        }
    } else {
        // crossVectors( vFrom, vTo ), inlined to avoid the Vector3 dependency
        x = vFrom.y * vTo.z - vFrom.z * vTo.y;
        y = vFrom.z * vTo.x - vFrom.x * vTo.z;
        z = vFrom.x * vTo.y - vFrom.y * vTo.x;
        w = r;
    }
    return normalize();
}

double Quaternion::angleTo(const Quaternion& q) const {
    return 2 * ieee754::acos(std::fabs(clamp(dot(q), -1, 1)));
}

Quaternion& Quaternion::rotateTowards(const Quaternion& q, double step) {
    const double angle = angleTo(q);
    if (angle == 0) return *this;
    const double t = jsMin(1, step / angle);
    slerp(q, t);
    return *this;
}

Quaternion& Quaternion::identity() { return set(0, 0, 0, 1); }

Quaternion& Quaternion::invert() { return conjugate(); }

Quaternion& Quaternion::conjugate() {
    x *= -1;
    y *= -1;
    z *= -1;
    notify();
    return *this;
}

double Quaternion::dot(const Quaternion& v) const { return x * v.x + y * v.y + z * v.z + w * v.w; }

double Quaternion::lengthSq() const { return x * x + y * y + z * z + w * w; }

double Quaternion::length() const { return std::sqrt(x * x + y * y + z * z + w * w); }

Quaternion& Quaternion::normalize() {
    double l = length();
    if (l == 0) {
        x = 0;
        y = 0;
        z = 0;
        w = 1;
    } else {
        l = 1 / l;
        x = x * l;
        y = y * l;
        z = z * l;
        w = w * l;
    }
    notify();
    return *this;
}

Quaternion& Quaternion::multiply(const Quaternion& q) { return multiplyQuaternions(*this, q); }

Quaternion& Quaternion::premultiply(const Quaternion& q) { return multiplyQuaternions(q, *this); }

Quaternion& Quaternion::multiplyQuaternions(const Quaternion& a, const Quaternion& b) {
    // from http://www.euclideanspace.com/maths/algebra/realNormedAlgebra/quaternions/code/index.htm
    const double qax = a.x, qay = a.y, qaz = a.z, qaw = a.w;
    const double qbx = b.x, qby = b.y, qbz = b.z, qbw = b.w;
    x = qax * qbw + qaw * qbx + qay * qbz - qaz * qby;
    y = qay * qbw + qaw * qby + qaz * qbx - qax * qbz;
    z = qaz * qbw + qaw * qbz + qax * qby - qay * qbx;
    w = qaw * qbw - qax * qbx - qay * qby - qaz * qbz;
    notify();
    return *this;
}

Quaternion& Quaternion::slerp(const Quaternion& qb, double t) {
    double bx = qb.x, by = qb.y, bz = qb.z, bw = qb.w;
    double dot = this->dot(qb);
    if (dot < 0) {
        bx = -bx;
        by = -by;
        bz = -bz;
        bw = -bw;
        dot = -dot;
    }
    double s = 1 - t;
    if (dot < 0.9995) {
        // slerp
        const double theta = ieee754::acos(dot);
        const double sin = ieee754::sin(theta);
        s = ieee754::sin(s * theta) / sin;
        t = ieee754::sin(t * theta) / sin;
        x = x * s + bx * t;
        y = y * s + by * t;
        z = z * s + bz * t;
        w = w * s + bw * t;
        notify();
    } else {
        // for small angles, lerp then normalize
        x = x * s + bx * t;
        y = y * s + by * t;
        z = z * s + bz * t;
        w = w * s + bw * t;
        normalize();  // normalize notifies, as it does in the reference
    }
    return *this;
}

Quaternion& Quaternion::slerpQuaternions(const Quaternion& qa, const Quaternion& qb, double t) {
    return copy(qa).slerp(qb, t);
}

bool Quaternion::equals(const Quaternion& q) const {
    return q.x == x && q.y == y && q.z == z && q.w == w;
}

Quaternion& Quaternion::fromArray(const double* array, int offset) {
    x = array[offset];
    y = array[offset + 1];
    z = array[offset + 2];
    w = array[offset + 3];
    notify();
    return *this;
}

}  // namespace tn::engine
