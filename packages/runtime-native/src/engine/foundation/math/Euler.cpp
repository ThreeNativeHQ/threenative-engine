#include "engine/foundation/math/Euler.h"

#include "engine/foundation/math/MathUtils.h"
#include "engine/foundation/math/Matrix.h"
#include "engine/foundation/math/Quaternion.h"
#include "engine/foundation/math/Vector.h"
#include "engine/foundation/math/ieee754.h"

#include <cmath>

namespace tn::engine {

Euler& Euler::set(double x, double y, double z, EulerOrder order) {
    this->x = x;
    this->y = y;
    this->z = z;
    this->order = order;
    notify();
    return *this;
}

Euler& Euler::copy(const Euler& euler) {
    x = euler.x;
    y = euler.y;
    z = euler.z;
    order = euler.order;
    notify();
    return *this;
}

Euler& Euler::setFromRotationMatrix(const Matrix4& m, EulerOrder order, bool update) {
    const double* te = m.elements.data();
    const double m11 = te[0], m12 = te[4], m13 = te[8];
    const double m21 = te[1], m22 = te[5], m23 = te[9];
    const double m31 = te[2], m32 = te[6], m33 = te[10];
    switch (order) {
        case EulerOrder::XYZ:
            y = ieee754::asin(clamp(m13, -1, 1));
            if (std::fabs(m13) < 0.9999999) {
                x = ieee754::atan2(-m23, m33);
                z = ieee754::atan2(-m12, m11);
            } else {
                x = ieee754::atan2(m32, m22);
                z = 0;
            }
            break;
        case EulerOrder::YXZ:
            x = ieee754::asin(-clamp(m23, -1, 1));
            if (std::fabs(m23) < 0.9999999) {
                y = ieee754::atan2(m13, m33);
                z = ieee754::atan2(m21, m22);
            } else {
                y = ieee754::atan2(-m31, m11);
                z = 0;
            }
            break;
        case EulerOrder::ZXY:
            x = ieee754::asin(clamp(m32, -1, 1));
            if (std::fabs(m32) < 0.9999999) {
                y = ieee754::atan2(-m31, m33);
                z = ieee754::atan2(-m12, m22);
            } else {
                y = 0;
                z = ieee754::atan2(m21, m11);
            }
            break;
        case EulerOrder::ZYX:
            y = ieee754::asin(-clamp(m31, -1, 1));
            if (std::fabs(m31) < 0.9999999) {
                x = ieee754::atan2(m32, m33);
                z = ieee754::atan2(m21, m11);
            } else {
                x = 0;
                z = ieee754::atan2(-m12, m22);
            }
            break;
        case EulerOrder::YZX:
            z = ieee754::asin(clamp(m21, -1, 1));
            if (std::fabs(m21) < 0.9999999) {
                x = ieee754::atan2(-m23, m22);
                y = ieee754::atan2(-m31, m11);
            } else {
                x = 0;
                y = ieee754::atan2(m13, m33);
            }
            break;
        case EulerOrder::XZY:
            z = ieee754::asin(-clamp(m12, -1, 1));
            if (std::fabs(m12) < 0.9999999) {
                x = ieee754::atan2(m32, m22);
                y = ieee754::atan2(m13, m11);
            } else {
                x = ieee754::atan2(-m23, m33);
                y = 0;
            }
            break;
    }
    this->order = order;
    if (update) notify();
    return *this;
}

Euler& Euler::setFromQuaternion(const Quaternion& q, EulerOrder order, bool update) {
    static Matrix4 matrix;
    matrix.makeRotationFromQuaternion(q);
    return setFromRotationMatrix(matrix, order, update);
}

Euler& Euler::setFromVector3(const Vector3& v, EulerOrder order) { return set(v.x, v.y, v.z, order); }

Euler& Euler::reorder(EulerOrder newOrder) {
    static Quaternion quaternion;
    quaternion.setFromEuler(*this);
    return setFromQuaternion(quaternion, newOrder, false);
}

bool Euler::equals(const Euler& euler) const {
    return euler.x == x && euler.y == y && euler.z == z && euler.order == order;
}

Euler& Euler::fromArray(const double* xyz) {
    x = xyz[0];
    y = xyz[1];
    z = xyz[2];
    notify();
    return *this;
}

}  // namespace tn::engine
