#pragma once

// Matrix3 and Matrix4, ported from three@0.185.1 src/math/Matrix{3,4}.js. `elements` is a
// column-major std::array, exactly like three's plain array, because the fixture protocol reads it
// by path and the GPU upload path reads it by layout. The operation order inside every product,
// determinant and inverse is three's, including `invert()`'s `det === 0` early return, which is the
// only reason a singular matrix has a defined answer.
//
// Not ported: Matrix4's projection and coordinate-system arguments come from three's constants
// (CoordinateSystem in MathUtils.h) rather than a renderer; `lookAt` keeps all three vectors.
// Nothing else is skipped: every other public method takes only math types in this directory.

#include "engine/foundation/math/MathUtils.h"

#include <array>

namespace tn::engine {

class Euler;
class Quaternion;
class Vector3;

class Matrix3 {
public:
    std::array<double, 9> elements{1, 0, 0, 0, 1, 0, 0, 0, 1};

    Matrix3() = default;
    /** The nine arguments are the row-major reading order; `set` is what stores them. */
    Matrix3(double n11, double n12, double n13, double n21, double n22, double n23, double n31,
            double n32, double n33);

    Matrix3& set(double n11, double n12, double n13, double n21, double n22, double n23, double n31,
                 double n32, double n33);
    Matrix3& identity();
    Matrix3& copy(const Matrix3& m);
    Matrix3& extractBasis(Vector3& xAxis, Vector3& yAxis, Vector3& zAxis);
    Matrix3& setFromMatrix4(const class Matrix4& m);
    Matrix3& multiply(const Matrix3& m);
    Matrix3& premultiply(const Matrix3& m);
    Matrix3& multiplyMatrices(const Matrix3& a, const Matrix3& b);
    Matrix3& multiplyScalar(double s);
    [[nodiscard]] double determinant() const;
    /** A singular matrix becomes the zero matrix, not an infinity: three's `det === 0` branch. */
    Matrix3& invert();
    Matrix3& transpose();
    Matrix3& getNormalMatrix(const class Matrix4& matrix4);
    Matrix3& setUvTransform(double tx, double ty, double sx, double sy, double rotation, double cx,
                            double cy);
    Matrix3& scale(double sx, double sy);
    Matrix3& rotate(double theta);
    Matrix3& translate(double tx, double ty);
    Matrix3& makeTranslation(double x, double y);
    Matrix3& makeRotation(double theta);
    Matrix3& makeScale(double x, double y);
    [[nodiscard]] bool equals(const Matrix3& matrix) const;
    Matrix3& fromArray(const double* array, int offset = 0);
    [[nodiscard]] std::array<double, 9> toArray() const { return elements; }
    [[nodiscard]] Matrix3 clone() const { return *this; }
};

class Matrix4 {
public:
    std::array<double, 16> elements{1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};

    Matrix4() = default;
    /** The sixteen arguments are the row-major reading order; `set` is what stores them. */
    Matrix4(double n11, double n12, double n13, double n14, double n21, double n22, double n23,
            double n24, double n31, double n32, double n33, double n34, double n41, double n42,
            double n43, double n44);

    Matrix4& set(double n11, double n12, double n13, double n14, double n21, double n22, double n23,
                 double n24, double n31, double n32, double n33, double n34, double n41, double n42,
                 double n43, double n44);
    Matrix4& identity();
    [[nodiscard]] Matrix4 clone() const { return *this; }
    Matrix4& copy(const Matrix4& m);
    Matrix4& copyPosition(const Matrix4& m);
    Matrix4& setFromMatrix3(const Matrix3& m);
    Matrix4& extractBasis(Vector3& xAxis, Vector3& yAxis, Vector3& zAxis);
    Matrix4& makeBasis(const Vector3& xAxis, const Vector3& yAxis, const Vector3& zAxis);
    /** A singular `m` answers the identity: three's `determinantAffine() === 0` branch. */
    Matrix4& extractRotation(const Matrix4& m);
    Matrix4& makeRotationFromEuler(const Euler& euler);
    Matrix4& makeRotationFromQuaternion(const Quaternion& q);
    Matrix4& lookAt(const Vector3& eye, const Vector3& target, const Vector3& up);
    Matrix4& multiply(const Matrix4& m);
    Matrix4& premultiply(const Matrix4& m);
    Matrix4& multiplyMatrices(const Matrix4& a, const Matrix4& b);
    Matrix4& multiplyScalar(double s);
    [[nodiscard]] double determinant() const;
    [[nodiscard]] double determinantAffine() const;
    Matrix4& transpose();
    Matrix4& setPosition(const Vector3& position);
    /** A singular matrix becomes the zero matrix, not an infinity: three's `det === 0` branch. */
    Matrix4& invert();
    Matrix4& scale(const Vector3& v);
    [[nodiscard]] double getMaxScaleOnAxis() const;
    Matrix4& makeTranslation(double x, double y, double z);
    Matrix4& makeRotationX(double theta);
    Matrix4& makeRotationY(double theta);
    Matrix4& makeRotationZ(double theta);
    Matrix4& makeRotationAxis(const Vector3& axis, double angle);
    Matrix4& makeScale(double x, double y, double z);
    Matrix4& makeShear(double xy, double xz, double yx, double yz, double zx, double zy);
    Matrix4& compose(const Vector3& position, const Quaternion& quaternion, const Vector3& scale);
    /** A singular matrix answers scale (1,1,1) and the identity quaternion: three's branch. */
    Matrix4& decompose(Vector3& position, Quaternion& quaternion, Vector3& scale);
    Matrix4& makePerspective(double left, double right, double top, double bottom, double near,
                             double far, CoordinateSystem coordinateSystem = CoordinateSystem::WebGL,
                             bool reversedDepth = false);
    Matrix4& makeOrthographic(double left, double right, double top, double bottom, double near,
                              double far, CoordinateSystem coordinateSystem = CoordinateSystem::WebGL,
                              bool reversedDepth = false);
    [[nodiscard]] bool equals(const Matrix4& matrix) const;
    Matrix4& fromArray(const double* array, int offset = 0);
    [[nodiscard]] std::array<double, 16> toArray() const { return elements; }
};

}  // namespace tn::engine
