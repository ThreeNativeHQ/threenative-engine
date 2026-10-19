#include "engine/foundation/math/Matrix.h"

#include "engine/foundation/math/Euler.h"
#include "engine/foundation/math/Quaternion.h"
#include "engine/foundation/math/Vector.h"
#include "engine/foundation/math/ieee754.h"

#include <cmath>

namespace tn::engine {

Matrix3::Matrix3(double n11, double n12, double n13, double n21, double n22, double n23, double n31,
                 double n32, double n33) {
    set(n11, n12, n13, n21, n22, n23, n31, n32, n33);
}

Matrix3& Matrix3::set(double n11, double n12, double n13, double n21, double n22, double n23,
                      double n31, double n32, double n33) {
    double* te = elements.data();
    te[0] = n11; te[1] = n21; te[2] = n31;
    te[3] = n12; te[4] = n22; te[5] = n32;
    te[6] = n13; te[7] = n23; te[8] = n33;
    return *this;
}

Matrix3& Matrix3::identity() {
    return set(1, 0, 0, 0, 1, 0, 0, 0, 1);
}

Matrix3& Matrix3::copy(const Matrix3& m) {
    elements = m.elements;
    return *this;
}

Matrix3& Matrix3::extractBasis(Vector3& xAxis, Vector3& yAxis, Vector3& zAxis) {
    xAxis.setFromMatrix3Column(*this, 0);
    yAxis.setFromMatrix3Column(*this, 1);
    zAxis.setFromMatrix3Column(*this, 2);
    return *this;
}

Matrix3& Matrix3::setFromMatrix4(const Matrix4& m) {
    const double* me = m.elements.data();
    return set(me[0], me[4], me[8], me[1], me[5], me[9], me[2], me[6], me[10]);
}

Matrix3& Matrix3::multiply(const Matrix3& m) { return multiplyMatrices(*this, m); }

Matrix3& Matrix3::premultiply(const Matrix3& m) { return multiplyMatrices(m, *this); }

Matrix3& Matrix3::multiplyMatrices(const Matrix3& a, const Matrix3& b) {
    const double* ae = a.elements.data();
    const double* be = b.elements.data();
    double* te = elements.data();
    const double a11 = ae[0], a12 = ae[3], a13 = ae[6];
    const double a21 = ae[1], a22 = ae[4], a23 = ae[7];
    const double a31 = ae[2], a32 = ae[5], a33 = ae[8];
    const double b11 = be[0], b12 = be[3], b13 = be[6];
    const double b21 = be[1], b22 = be[4], b23 = be[7];
    const double b31 = be[2], b32 = be[5], b33 = be[8];
    te[0] = a11 * b11 + a12 * b21 + a13 * b31;
    te[3] = a11 * b12 + a12 * b22 + a13 * b32;
    te[6] = a11 * b13 + a12 * b23 + a13 * b33;
    te[1] = a21 * b11 + a22 * b21 + a23 * b31;
    te[4] = a21 * b12 + a22 * b22 + a23 * b32;
    te[7] = a21 * b13 + a22 * b23 + a23 * b33;
    te[2] = a31 * b11 + a32 * b21 + a33 * b31;
    te[5] = a31 * b12 + a32 * b22 + a33 * b32;
    te[8] = a31 * b13 + a32 * b23 + a33 * b33;
    return *this;
}

Matrix3& Matrix3::multiplyScalar(double s) {
    double* te = elements.data();
    te[0] *= s; te[3] *= s; te[6] *= s;
    te[1] *= s; te[4] *= s; te[7] *= s;
    te[2] *= s; te[5] *= s; te[8] *= s;
    return *this;
}

double Matrix3::determinant() const {
    const double* te = elements.data();
    const double a = te[0], b = te[1], c = te[2],
                d = te[3], e = te[4], f = te[5],
                g = te[6], h = te[7], i = te[8];
    return a * e * i - a * f * h - b * d * i + b * f * g + c * d * h - c * e * g;
}

Matrix3& Matrix3::invert() {
    double* te = elements.data();
    const double n11 = te[0], n21 = te[1], n31 = te[2],
                n12 = te[3], n22 = te[4], n32 = te[5],
                n13 = te[6], n23 = te[7], n33 = te[8],
                t11 = n33 * n22 - n32 * n23,
                t12 = n32 * n13 - n33 * n12,
                t13 = n23 * n12 - n22 * n13,
                det = n11 * t11 + n21 * t12 + n31 * t13;
    if (det == 0) return set(0, 0, 0, 0, 0, 0, 0, 0, 0);
    const double detInv = 1 / det;
    te[0] = t11 * detInv;
    te[1] = (n31 * n23 - n33 * n21) * detInv;
    te[2] = (n32 * n21 - n31 * n22) * detInv;
    te[3] = t12 * detInv;
    te[4] = (n33 * n11 - n31 * n13) * detInv;
    te[5] = (n31 * n12 - n32 * n11) * detInv;
    te[6] = t13 * detInv;
    te[7] = (n21 * n13 - n23 * n11) * detInv;
    te[8] = (n22 * n11 - n21 * n12) * detInv;
    return *this;
}

Matrix3& Matrix3::transpose() {
    double* m = elements.data();
    double tmp;
    tmp = m[1]; m[1] = m[3]; m[3] = tmp;
    tmp = m[2]; m[2] = m[6]; m[6] = tmp;
    tmp = m[5]; m[5] = m[7]; m[7] = tmp;
    return *this;
}

Matrix3& Matrix3::getNormalMatrix(const Matrix4& matrix4) {
    return setFromMatrix4(matrix4).invert().transpose();
}

Matrix3& Matrix3::setUvTransform(double tx, double ty, double sx, double sy, double rotation,
                                double cx, double cy) {
    const double c = ieee754::cos(rotation);
    const double s = ieee754::sin(rotation);
    return set(sx * c, sx * s, -sx * (c * cx + s * cy) + cx + tx,
               -sy * s, sy * c, -sy * (-s * cx + c * cy) + cy + ty,
               0, 0, 1);
}

Matrix3& Matrix3::scale(double sx, double sy) { return premultiply(Matrix3().makeScale(sx, sy)); }

Matrix3& Matrix3::rotate(double theta) { return premultiply(Matrix3().makeRotation(-theta)); }

Matrix3& Matrix3::translate(double tx, double ty) {
    return premultiply(Matrix3().makeTranslation(tx, ty));
}

Matrix3& Matrix3::makeTranslation(double x, double y) {
    return set(1, 0, x, 0, 1, y, 0, 0, 1);
}

Matrix3& Matrix3::makeRotation(double theta) {
    // counterclockwise
    const double c = ieee754::cos(theta);
    const double s = ieee754::sin(theta);
    return set(c, -s, 0, s, c, 0, 0, 0, 1);
}

Matrix3& Matrix3::makeScale(double x, double y) { return set(x, 0, 0, 0, y, 0, 0, 0, 1); }

bool Matrix3::equals(const Matrix3& matrix) const {
    for (size_t i = 0; i < 9; i++)
        if (elements[i] != matrix.elements[i]) return false;
    return true;
}

Matrix3& Matrix3::fromArray(const double* array, int offset) {
    for (size_t i = 0; i < 9; i++) elements[i] = array[i + offset];
    return *this;
}

Matrix4::Matrix4(double n11, double n12, double n13, double n14, double n21, double n22, double n23,
                 double n24, double n31, double n32, double n33, double n34, double n41, double n42,
                 double n43, double n44) {
    set(n11, n12, n13, n14, n21, n22, n23, n24, n31, n32, n33, n34, n41, n42, n43, n44);
}

Matrix4& Matrix4::set(double n11, double n12, double n13, double n14, double n21, double n22,
                      double n23, double n24, double n31, double n32, double n33, double n34,
                      double n41, double n42, double n43, double n44) {
    double* te = elements.data();
    te[0] = n11; te[4] = n12; te[8] = n13; te[12] = n14;
    te[1] = n21; te[5] = n22; te[9] = n23; te[13] = n24;
    te[2] = n31; te[6] = n32; te[10] = n33; te[14] = n34;
    te[3] = n41; te[7] = n42; te[11] = n43; te[15] = n44;
    return *this;
}

Matrix4& Matrix4::identity() {
    return set(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
}

Matrix4& Matrix4::copy(const Matrix4& m) {
    elements = m.elements;
    return *this;
}

Matrix4& Matrix4::copyPosition(const Matrix4& m) {
    double* te = elements.data();
    const double* me = m.elements.data();
    te[12] = me[12];
    te[13] = me[13];
    te[14] = me[14];
    return *this;
}

Matrix4& Matrix4::setFromMatrix3(const Matrix3& m) {
    const double* me = m.elements.data();
    return set(me[0], me[3], me[6], 0, me[1], me[4], me[7], 0, me[2], me[5], me[8], 0, 0, 0, 0, 1);
}

Matrix4& Matrix4::extractBasis(Vector3& xAxis, Vector3& yAxis, Vector3& zAxis) {
    if (determinantAffine() == 0) {
        xAxis.set(1, 0, 0);
        yAxis.set(0, 1, 0);
        zAxis.set(0, 0, 1);
        return *this;
    }
    xAxis.setFromMatrixColumn(*this, 0);
    yAxis.setFromMatrixColumn(*this, 1);
    zAxis.setFromMatrixColumn(*this, 2);
    return *this;
}

Matrix4& Matrix4::makeBasis(const Vector3& xAxis, const Vector3& yAxis, const Vector3& zAxis) {
    return set(xAxis.x, yAxis.x, zAxis.x, 0, xAxis.y, yAxis.y, zAxis.y, 0, xAxis.z, yAxis.z, zAxis.z,
               0, 0, 0, 0, 1);
}

Matrix4& Matrix4::extractRotation(const Matrix4& m) {
    if (m.determinantAffine() == 0) return identity();
    double* te = elements.data();
    const double* me = m.elements.data();
    static Vector3 scratch;
    const double scaleX = 1 / scratch.setFromMatrixColumn(m, 0).length();
    const double scaleY = 1 / scratch.setFromMatrixColumn(m, 1).length();
    const double scaleZ = 1 / scratch.setFromMatrixColumn(m, 2).length();
    te[0] = me[0] * scaleX;
    te[1] = me[1] * scaleX;
    te[2] = me[2] * scaleX;
    te[3] = 0;
    te[4] = me[4] * scaleY;
    te[5] = me[5] * scaleY;
    te[6] = me[6] * scaleY;
    te[7] = 0;
    te[8] = me[8] * scaleZ;
    te[9] = me[9] * scaleZ;
    te[10] = me[10] * scaleZ;
    te[11] = 0;
    te[12] = 0;
    te[13] = 0;
    te[14] = 0;
    te[15] = 1;
    return *this;
}

Matrix4& Matrix4::makeRotationFromEuler(const Euler& euler) {
    double* te = elements.data();
    const double x = euler.x, y = euler.y, z = euler.z;
    const double a = ieee754::cos(x), b = ieee754::sin(x);
    const double c = ieee754::cos(y), d = ieee754::sin(y);
    const double e = ieee754::cos(z), f = ieee754::sin(z);
    if (euler.order == EulerOrder::XYZ) {
        const double ae = a * e, af = a * f, be = b * e, bf = b * f;
        te[0] = c * e;
        te[4] = -c * f;
        te[8] = d;
        te[1] = af + be * d;
        te[5] = ae - bf * d;
        te[9] = -b * c;
        te[2] = bf - ae * d;
        te[6] = be + af * d;
        te[10] = a * c;
    } else if (euler.order == EulerOrder::YXZ) {
        const double ce = c * e, cf = c * f, de = d * e, df = d * f;
        te[0] = ce + df * b;
        te[4] = de * b - cf;
        te[8] = a * d;
        te[1] = a * f;
        te[5] = a * e;
        te[9] = -b;
        te[2] = cf * b - de;
        te[6] = df + ce * b;
        te[10] = a * c;
    } else if (euler.order == EulerOrder::ZXY) {
        const double ce = c * e, cf = c * f, de = d * e, df = d * f;
        te[0] = ce - df * b;
        te[4] = -a * f;
        te[8] = de + cf * b;
        te[1] = cf + de * b;
        te[5] = a * e;
        te[9] = df - ce * b;
        te[2] = -a * d;
        te[6] = b;
        te[10] = a * c;
    } else if (euler.order == EulerOrder::ZYX) {
        const double ae = a * e, af = a * f, be = b * e, bf = b * f;
        te[0] = c * e;
        te[4] = be * d - af;
        te[8] = ae * d + bf;
        te[1] = c * f;
        te[5] = bf * d + ae;
        te[9] = af * d - be;
        te[2] = -d;
        te[6] = b * c;
        te[10] = a * c;
    } else if (euler.order == EulerOrder::YZX) {
        const double ac = a * c, ad = a * d, bc = b * c, bd = b * d;
        te[0] = c * e;
        te[4] = bd - ac * f;
        te[8] = bc * f + ad;
        te[1] = f;
        te[5] = a * e;
        te[9] = -b * e;
        te[2] = -d * e;
        te[6] = ad * f + bc;
        te[10] = ac - bd * f;
    } else if (euler.order == EulerOrder::XZY) {
        const double ac = a * c, ad = a * d, bc = b * c, bd = b * d;
        te[0] = c * e;
        te[4] = -f;
        te[8] = d * e;
        te[1] = ac * f + bd;
        te[5] = a * e;
        te[9] = ad * f - bc;
        te[2] = bc * f - ad;
        te[6] = b * e;
        te[10] = bd * f + ac;
    }
    // bottom row
    te[3] = 0;
    te[7] = 0;
    te[11] = 0;
    // last column
    te[12] = 0;
    te[13] = 0;
    te[14] = 0;
    te[15] = 1;
    return *this;
}

Matrix4& Matrix4::makeRotationFromQuaternion(const Quaternion& q) {
    return compose(Vector3(0, 0, 0), q, Vector3(1, 1, 1));
}

Matrix4& Matrix4::lookAt(const Vector3& eye, const Vector3& target, const Vector3& up) {
    double* te = elements.data();
    static Vector3 x, y, z;
    z.subVectors(eye, target);
    if (z.lengthSq() == 0) {
        // eye and target are in the same position
        z.z = 1;
    }
    z.normalize();
    x.crossVectors(up, z);
    if (x.lengthSq() == 0) {
        // up and z are parallel
        if (std::fabs(up.z) == 1) {
            z.x += 0.0001;
        } else {
            z.z += 0.0001;
        }
        z.normalize();
        x.crossVectors(up, z);
    }
    x.normalize();
    y.crossVectors(z, x);
    te[0] = x.x; te[4] = y.x; te[8] = z.x;
    te[1] = x.y; te[5] = y.y; te[9] = z.y;
    te[2] = x.z; te[6] = y.z; te[10] = z.z;
    return *this;
}

Matrix4& Matrix4::multiply(const Matrix4& m) { return multiplyMatrices(*this, m); }

Matrix4& Matrix4::premultiply(const Matrix4& m) { return multiplyMatrices(m, *this); }

Matrix4& Matrix4::multiplyMatrices(const Matrix4& a, const Matrix4& b) {
    const double* ae = a.elements.data();
    const double* be = b.elements.data();
    double* te = elements.data();
    const double a11 = ae[0], a12 = ae[4], a13 = ae[8], a14 = ae[12];
    const double a21 = ae[1], a22 = ae[5], a23 = ae[9], a24 = ae[13];
    const double a31 = ae[2], a32 = ae[6], a33 = ae[10], a34 = ae[14];
    const double a41 = ae[3], a42 = ae[7], a43 = ae[11], a44 = ae[15];
    const double b11 = be[0], b12 = be[4], b13 = be[8], b14 = be[12];
    const double b21 = be[1], b22 = be[5], b23 = be[9], b24 = be[13];
    const double b31 = be[2], b32 = be[6], b33 = be[10], b34 = be[14];
    const double b41 = be[3], b42 = be[7], b43 = be[11], b44 = be[15];
    te[0] = a11 * b11 + a12 * b21 + a13 * b31 + a14 * b41;
    te[4] = a11 * b12 + a12 * b22 + a13 * b32 + a14 * b42;
    te[8] = a11 * b13 + a12 * b23 + a13 * b33 + a14 * b43;
    te[12] = a11 * b14 + a12 * b24 + a13 * b34 + a14 * b44;
    te[1] = a21 * b11 + a22 * b21 + a23 * b31 + a24 * b41;
    te[5] = a21 * b12 + a22 * b22 + a23 * b32 + a24 * b42;
    te[9] = a21 * b13 + a22 * b23 + a23 * b33 + a24 * b43;
    te[13] = a21 * b14 + a22 * b24 + a23 * b34 + a24 * b44;
    te[2] = a31 * b11 + a32 * b21 + a33 * b31 + a34 * b41;
    te[6] = a31 * b12 + a32 * b22 + a33 * b32 + a34 * b42;
    te[10] = a31 * b13 + a32 * b23 + a33 * b33 + a34 * b43;
    te[14] = a31 * b14 + a32 * b24 + a33 * b34 + a34 * b44;
    te[3] = a41 * b11 + a42 * b21 + a43 * b31 + a44 * b41;
    te[7] = a41 * b12 + a42 * b22 + a43 * b32 + a44 * b42;
    te[11] = a41 * b13 + a42 * b23 + a43 * b33 + a44 * b43;
    te[15] = a41 * b14 + a42 * b24 + a43 * b34 + a44 * b44;
    return *this;
}

Matrix4& Matrix4::multiplyScalar(double s) {
    double* te = elements.data();
    te[0] *= s; te[4] *= s; te[8] *= s; te[12] *= s;
    te[1] *= s; te[5] *= s; te[9] *= s; te[13] *= s;
    te[2] *= s; te[6] *= s; te[10] *= s; te[14] *= s;
    te[3] *= s; te[7] *= s; te[11] *= s; te[15] *= s;
    return *this;
}

double Matrix4::determinant() const {
    const double* te = elements.data();
    const double n11 = te[0], n12 = te[4], n13 = te[8], n14 = te[12];
    const double n21 = te[1], n22 = te[5], n23 = te[9], n24 = te[13];
    const double n31 = te[2], n32 = te[6], n33 = te[10], n34 = te[14];
    const double n41 = te[3], n42 = te[7], n43 = te[11], n44 = te[15];
    const double t11 = n23 * n34 - n24 * n33;
    const double t12 = n22 * n34 - n24 * n32;
    const double t13 = n22 * n33 - n23 * n32;
    const double t21 = n21 * n34 - n24 * n31;
    const double t22 = n21 * n33 - n23 * n31;
    const double t23 = n21 * n32 - n22 * n31;
    return n11 * (n42 * t11 - n43 * t12 + n44 * t13) -
           n12 * (n41 * t11 - n43 * t21 + n44 * t22) +
           n13 * (n41 * t12 - n42 * t21 + n44 * t23) -
           n14 * (n41 * t13 - n42 * t22 + n43 * t23);
}

double Matrix4::determinantAffine() const {
    const double* te = elements.data();
    const double n11 = te[0], n12 = te[4], n13 = te[8];
    const double n21 = te[1], n22 = te[5], n23 = te[9];
    const double n31 = te[2], n32 = te[6], n33 = te[10];
    return n11 * (n22 * n33 - n23 * n32) -
           n12 * (n21 * n33 - n23 * n31) +
           n13 * (n21 * n32 - n22 * n31);
}

Matrix4& Matrix4::transpose() {
    double* te = elements.data();
    double tmp;
    tmp = te[1]; te[1] = te[4]; te[4] = tmp;
    tmp = te[2]; te[2] = te[8]; te[8] = tmp;
    tmp = te[6]; te[6] = te[9]; te[9] = tmp;
    tmp = te[3]; te[3] = te[12]; te[12] = tmp;
    tmp = te[7]; te[7] = te[13]; te[13] = tmp;
    tmp = te[11]; te[11] = te[14]; te[14] = tmp;
    return *this;
}

Matrix4& Matrix4::setPosition(const Vector3& position) {
    double* te = elements.data();
    te[12] = position.x;
    te[13] = position.y;
    te[14] = position.z;
    return *this;
}

Matrix4& Matrix4::invert() {
    // based on https://github.com/toji/gl-matrix
    double* te = elements.data();
    const double n11 = te[0], n21 = te[1], n31 = te[2], n41 = te[3],
                n12 = te[4], n22 = te[5], n32 = te[6], n42 = te[7],
                n13 = te[8], n23 = te[9], n33 = te[10], n43 = te[11],
                n14 = te[12], n24 = te[13], n34 = te[14], n44 = te[15],
                t1 = n11 * n22 - n21 * n12,
                t2 = n11 * n32 - n31 * n12,
                t3 = n11 * n42 - n41 * n12,
                t4 = n21 * n32 - n31 * n22,
                t5 = n21 * n42 - n41 * n22,
                t6 = n31 * n42 - n41 * n32,
                t7 = n13 * n24 - n23 * n14,
                t8 = n13 * n34 - n33 * n14,
                t9 = n13 * n44 - n43 * n14,
                t10 = n23 * n34 - n33 * n24,
                t11 = n23 * n44 - n43 * n24,
                t12 = n33 * n44 - n43 * n34;
    const double det = t1 * t12 - t2 * t11 + t3 * t10 + t4 * t9 - t5 * t8 + t6 * t7;
    if (det == 0) return set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    const double detInv = 1 / det;
    te[0] = (n22 * t12 - n32 * t11 + n42 * t10) * detInv;
    te[1] = (n31 * t11 - n21 * t12 - n41 * t10) * detInv;
    te[2] = (n24 * t6 - n34 * t5 + n44 * t4) * detInv;
    te[3] = (n33 * t5 - n23 * t6 - n43 * t4) * detInv;
    te[4] = (n32 * t9 - n12 * t12 - n42 * t8) * detInv;
    te[5] = (n11 * t12 - n31 * t9 + n41 * t8) * detInv;
    te[6] = (n34 * t3 - n14 * t6 - n44 * t2) * detInv;
    te[7] = (n13 * t6 - n33 * t3 + n43 * t2) * detInv;
    te[8] = (n12 * t11 - n22 * t9 + n42 * t7) * detInv;
    te[9] = (n21 * t9 - n11 * t11 - n41 * t7) * detInv;
    te[10] = (n14 * t5 - n24 * t3 + n44 * t1) * detInv;
    te[11] = (n23 * t3 - n13 * t5 - n43 * t1) * detInv;
    te[12] = (n22 * t8 - n12 * t10 - n32 * t7) * detInv;
    te[13] = (n11 * t10 - n21 * t8 + n31 * t7) * detInv;
    te[14] = (n24 * t2 - n14 * t4 - n34 * t1) * detInv;
    te[15] = (n13 * t4 - n23 * t2 + n33 * t1) * detInv;
    return *this;
}

Matrix4& Matrix4::scale(const Vector3& v) {
    double* te = elements.data();
    const double x = v.x, y = v.y, z = v.z;
    te[0] *= x; te[4] *= y; te[8] *= z;
    te[1] *= x; te[5] *= y; te[9] *= z;
    te[2] *= x; te[6] *= y; te[10] *= z;
    te[3] *= x; te[7] *= y; te[11] *= z;
    return *this;
}

double Matrix4::getMaxScaleOnAxis() const {
    const double* te = elements.data();
    const double scaleXSq = te[0] * te[0] + te[1] * te[1] + te[2] * te[2];
    const double scaleYSq = te[4] * te[4] + te[5] * te[5] + te[6] * te[6];
    const double scaleZSq = te[8] * te[8] + te[9] * te[9] + te[10] * te[10];
    return std::sqrt(jsMax(scaleXSq, jsMax(scaleYSq, scaleZSq)));
}

Matrix4& Matrix4::makeTranslation(double x, double y, double z) {
    return set(1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1);
}

Matrix4& Matrix4::makeRotationX(double theta) {
    const double c = ieee754::cos(theta), s = ieee754::sin(theta);
    return set(1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1);
}

Matrix4& Matrix4::makeRotationY(double theta) {
    const double c = ieee754::cos(theta), s = ieee754::sin(theta);
    return set(c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1);
}

Matrix4& Matrix4::makeRotationZ(double theta) {
    const double c = ieee754::cos(theta), s = ieee754::sin(theta);
    return set(c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
}

Matrix4& Matrix4::makeRotationAxis(const Vector3& axis, double angle) {
    // Based on http://www.gamedev.net/reference/articles/article1199.asp
    const double c = ieee754::cos(angle);
    const double s = ieee754::sin(angle);
    const double t = 1 - c;
    const double x = axis.x, y = axis.y, z = axis.z;
    const double tx = t * x, ty = t * y;
    return set(tx * x + c, tx * y - s * z, tx * z + s * y, 0,
               tx * y + s * z, ty * y + c, ty * z - s * x, 0,
               tx * z - s * y, ty * z + s * x, t * z * z + c, 0,
               0, 0, 0, 1);
}

Matrix4& Matrix4::makeScale(double x, double y, double z) {
    return set(x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1);
}

Matrix4& Matrix4::makeShear(double xy, double xz, double yx, double yz, double zx, double zy) {
    return set(1, yx, zx, 0, xy, 1, zy, 0, xz, yz, 1, 0, 0, 0, 0, 1);
}

Matrix4& Matrix4::compose(const Vector3& position, const Quaternion& quaternion,
                          const Vector3& scale) {
    double* te = elements.data();
    const double x = quaternion.x, y = quaternion.y, z = quaternion.z, w = quaternion.w;
    const double x2 = x + x, y2 = y + y, z2 = z + z;
    const double xx = x * x2, xy = x * y2, xz = x * z2;
    const double yy = y * y2, yz = y * z2, zz = z * z2;
    const double wx = w * x2, wy = w * y2, wz = w * z2;
    const double sx = scale.x, sy = scale.y, sz = scale.z;
    te[0] = (1 - (yy + zz)) * sx;
    te[1] = (xy + wz) * sx;
    te[2] = (xz - wy) * sx;
    te[3] = 0;
    te[4] = (xy - wz) * sy;
    te[5] = (1 - (xx + zz)) * sy;
    te[6] = (yz + wx) * sy;
    te[7] = 0;
    te[8] = (xz + wy) * sz;
    te[9] = (yz - wx) * sz;
    te[10] = (1 - (xx + yy)) * sz;
    te[11] = 0;
    te[12] = position.x;
    te[13] = position.y;
    te[14] = position.z;
    te[15] = 1;
    return *this;
}

Matrix4& Matrix4::decompose(Vector3& position, Quaternion& quaternion, Vector3& scale) {
    double* te = elements.data();
    position.x = te[12];
    position.y = te[13];
    position.z = te[14];
    const double det = determinantAffine();
    if (det == 0) {
        scale.set(1, 1, 1);
        quaternion.identity();
        return *this;
    }
    static Vector3 scratch;
    double sx = scratch.set(te[0], te[1], te[2]).length();
    const double sy = scratch.set(te[4], te[5], te[6]).length();
    const double sz = scratch.set(te[8], te[9], te[10]).length();
    // if the determinant is negative, one scale has to be inverted
    if (det < 0) sx = -sx;
    // scale the rotation part
    static Matrix4 normalized;
    normalized.copy(*this);
    const double invSX = 1 / sx;
    const double invSY = 1 / sy;
    const double invSZ = 1 / sz;
    normalized.elements[0] *= invSX;
    normalized.elements[1] *= invSX;
    normalized.elements[2] *= invSX;
    normalized.elements[4] *= invSY;
    normalized.elements[5] *= invSY;
    normalized.elements[6] *= invSY;
    normalized.elements[8] *= invSZ;
    normalized.elements[9] *= invSZ;
    normalized.elements[10] *= invSZ;
    quaternion.setFromRotationMatrix(normalized);
    scale.x = sx;
    scale.y = sy;
    scale.z = sz;
    return *this;
}

Matrix4& Matrix4::makePerspective(double left, double right, double top, double bottom, double near,
                                  double far, CoordinateSystem coordinateSystem,
                                  bool reversedDepth) {
    double* te = elements.data();
    const double x = 2 * near / (right - left);
    const double y = 2 * near / (top - bottom);
    const double a = (right + left) / (right - left);
    const double b = (top + bottom) / (top - bottom);
    double c, d;
    if (reversedDepth) {
        c = near / (far - near);
        d = (far * near) / (far - near);
    } else if (coordinateSystem == CoordinateSystem::WebGL) {
        c = -(far + near) / (far - near);
        d = (-2 * far * near) / (far - near);
    } else {
        c = -far / (far - near);
        d = (-far * near) / (far - near);
    }
    te[0] = x;  te[4] = 0; te[8] = a;  te[12] = 0;
    te[1] = 0;  te[5] = y; te[9] = b;  te[13] = 0;
    te[2] = 0;  te[6] = 0; te[10] = c; te[14] = d;
    te[3] = 0;  te[7] = 0; te[11] = -1; te[15] = 0;
    return *this;
}

Matrix4& Matrix4::makeOrthographic(double left, double right, double top, double bottom, double near,
                                   double far, CoordinateSystem coordinateSystem,
                                   bool reversedDepth) {
    double* te = elements.data();
    const double x = 2 / (right - left);
    const double y = 2 / (top - bottom);
    const double a = -(right + left) / (right - left);
    const double b = -(top + bottom) / (top - bottom);
    double c, d;
    if (reversedDepth) {
        c = 1 / (far - near);
        d = far / (far - near);
    } else if (coordinateSystem == CoordinateSystem::WebGL) {
        c = -2 / (far - near);
        d = -(far + near) / (far - near);
    } else {
        c = -1 / (far - near);
        d = -near / (far - near);
    }
    te[0] = x;  te[4] = 0; te[8] = 0;  te[12] = a;
    te[1] = 0;  te[5] = y; te[9] = 0;  te[13] = b;
    te[2] = 0;  te[6] = 0; te[10] = c; te[14] = d;
    te[3] = 0;  te[7] = 0; te[11] = 0; te[15] = 1;
    return *this;
}

bool Matrix4::equals(const Matrix4& matrix) const {
    for (size_t i = 0; i < 16; i++)
        if (elements[i] != matrix.elements[i]) return false;
    return true;
}

Matrix4& Matrix4::fromArray(const double* array, int offset) {
    for (size_t i = 0; i < 16; i++) elements[i] = array[i + offset];
    return *this;
}

}  // namespace tn::engine
