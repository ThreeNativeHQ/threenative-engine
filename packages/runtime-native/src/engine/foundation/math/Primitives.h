#pragma once

// The geometry primitives, ported from three@0.185.1 src/math/{Box3,Sphere,Plane,Ray,Frustum}.js.
// The classes take each other by reference and by out-parameter where three takes a target, and the
// intersections answer three's `null` as a bool: false means three would have returned null.
//
// Not ported: Box3's `intersectsTriangle` (a Triangle) and the JSON forms. Object and buffer bounds
// are implemented in the scene layer.
// Plane's `intersectLine`/`intersectsLine` (a Line3). Frustum's `intersectsObject`/`intersectsSprite`
// (an Object3D and a Sprite). Sphere's JSON forms.

#include "engine/foundation/math/MathUtils.h"
#include "engine/foundation/math/Vector.h"

#include <array>
#include <limits>
#include <vector>

namespace tn::engine {

class Matrix4;
class Sphere;
class Plane;
class Object3D;
class BufferAttribute;

/** An axis-aligned bounding box. The default is empty: +Infinity at min, -Infinity at max. */
class Box3 {
public:
    Vector3 min{std::numeric_limits<double>::infinity(), std::numeric_limits<double>::infinity(),
                std::numeric_limits<double>::infinity()};
    Vector3 max{-std::numeric_limits<double>::infinity(), -std::numeric_limits<double>::infinity(),
                -std::numeric_limits<double>::infinity()};

    Box3() = default;

    Box3& set(const Vector3& min, const Vector3& max);
    Box3& setFromArray(const double* array, size_t count);
    Box3& setFromPoints(const std::vector<Vector3>& points);
    Box3& setFromCenterAndSize(const Vector3& center, const Vector3& size);
    Box3& setFromObject(Object3D& object, bool precise = false);
    Box3& setFromBufferAttribute(const BufferAttribute& attribute);
    Box3& expandByObject(Object3D& object, bool precise = false);
    [[nodiscard]] Box3 clone() const { return *this; }
    Box3& copy(const Box3& box);
    Box3& makeEmpty();
    [[nodiscard]] bool isEmpty() const;
    Vector3& getCenter(Vector3& target) const;
    Vector3& getSize(Vector3& target) const;
    Box3& expandByPoint(const Vector3& point);
    Box3& expandByVector(const Vector3& vector);
    Box3& expandByScalar(double scalar);
    [[nodiscard]] bool containsPoint(const Vector3& point) const;
    [[nodiscard]] bool containsBox(const Box3& box) const;
    Vector3& getParameter(const Vector3& point, Vector3& target) const;
    [[nodiscard]] bool intersectsBox(const Box3& box) const;
    [[nodiscard]] bool intersectsSphere(const Sphere& sphere) const;
    [[nodiscard]] bool intersectsPlane(const Plane& plane) const;
    Vector3& clampPoint(const Vector3& point, Vector3& target) const;
    [[nodiscard]] double distanceToPoint(const Vector3& point) const;
    [[nodiscard]] Sphere getBoundingSphere() const;
    Box3& intersect(const Box3& box);
    Box3& unionWith(const Box3& box);
    Box3& applyMatrix4(const Matrix4& matrix);
    Box3& translate(const Vector3& offset);
    [[nodiscard]] bool equals(const Box3& box) const;
};

class Sphere {
public:
    Vector3 center;
    double radius = -1;

    Sphere() = default;
    Sphere(const Vector3& center, double radius) : center(center), radius(radius) {}

    Sphere& set(const Vector3& center, double radius);
    /** Without `optionalCenter` the centre is the centroid of `points`, as three does. */
    Sphere& setFromPoints(const std::vector<Vector3>& points, const Vector3* optionalCenter = nullptr);
    Sphere& copy(const Sphere& sphere);
    [[nodiscard]] bool isEmpty() const;
    Sphere& makeEmpty();
    [[nodiscard]] bool containsPoint(const Vector3& point) const;
    [[nodiscard]] double distanceToPoint(const Vector3& point) const;
    [[nodiscard]] bool intersectsSphere(const Sphere& sphere) const;
    [[nodiscard]] bool intersectsBox(const Box3& box) const;
    [[nodiscard]] bool intersectsPlane(const Plane& plane) const;
    Vector3& clampPoint(const Vector3& point, Vector3& target) const;
    [[nodiscard]] Box3 getBoundingBox() const;
    Sphere& applyMatrix4(const Matrix4& matrix);
    Sphere& translate(const Vector3& offset);
    Sphere& expandByPoint(const Vector3& point);
    Sphere& unionWith(const Sphere& sphere);
    [[nodiscard]] bool equals(const Sphere& sphere) const;
    [[nodiscard]] Sphere clone() const { return *this; }
};

class Plane {
public:
    Vector3 normal{1, 0, 0};
    double constant = 0;

    Plane() = default;
    Plane(const Vector3& normal, double constant) : normal(normal), constant(constant) {}

    Plane& set(const Vector3& normal, double constant);
    Plane& setComponents(double x, double y, double z, double w);
    Plane& setFromNormalAndCoplanarPoint(const Vector3& normal, const Vector3& point);
    Plane& setFromCoplanarPoints(const Vector3& a, const Vector3& b, const Vector3& c);
    Plane& copy(const Plane& plane);
    /** An invalid plane divides by zero here, exactly as three does. */
    Plane& normalize();
    Plane& negate();
    [[nodiscard]] double distanceToPoint(const Vector3& point) const;
    [[nodiscard]] double distanceToSphere(const Sphere& sphere) const;
    Vector3& projectPoint(const Vector3& point, Vector3& target) const;
    [[nodiscard]] bool intersectsBox(const Box3& box) const;
    [[nodiscard]] bool intersectsSphere(const Sphere& sphere) const;
    Vector3& coplanarPoint(Vector3& target) const;
    Plane& applyMatrix4(const Matrix4& matrix);
    Plane& translate(const Vector3& offset);
    [[nodiscard]] bool equals(const Plane& plane) const;
    [[nodiscard]] Plane clone() const { return *this; }
};

class Ray {
public:
    Vector3 origin;
    Vector3 direction{0, 0, -1};

    Ray() = default;
    Ray(const Vector3& origin, const Vector3& direction) : origin(origin), direction(direction) {}

    Ray& set(const Vector3& origin, const Vector3& direction);
    Ray& copy(const Ray& ray);
    Vector3& at(double t, Vector3& target) const;
    Ray& lookAt(const Vector3& v);
    Ray& recast(double t);
    Vector3& closestPointToPoint(const Vector3& point, Vector3& target) const;
    [[nodiscard]] double distanceToPoint(const Vector3& point) const;
    [[nodiscard]] double distanceSqToPoint(const Vector3& point) const;
    /** The minimum distance between the ray and the segment v0..v1, optionally with the two points. */
    double distanceSqToSegment(const Vector3& v0, const Vector3& v1, Vector3* pointOnRay = nullptr,
                               Vector3* pointOnSegment = nullptr) const;
    bool intersectSphere(const Sphere& sphere, Vector3& target) const;
    [[nodiscard]] bool intersectsSphere(const Sphere& sphere) const;
    /** False is three's `null`: a coplanar ray, or one pointing away from the plane. */
    [[nodiscard]] bool distanceToPlane(const Plane& plane, double& distance) const;
    bool intersectPlane(const Plane& plane, Vector3& target) const;
    [[nodiscard]] bool intersectsPlane(const Plane& plane) const;
    bool intersectBox(const Box3& box, Vector3& target) const;
    [[nodiscard]] bool intersectsBox(const Box3& box) const;
    bool intersectTriangle(const Vector3& a, const Vector3& b, const Vector3& c, bool backfaceCulling,
                           Vector3& target) const;
    Ray& applyMatrix4(const Matrix4& matrix4);
    [[nodiscard]] bool equals(const Ray& ray) const;
    [[nodiscard]] Ray clone() const { return *this; }
};

/** Six planes, left, right, bottom, top, near, far, in three's order. */
class Frustum {
public:
    std::array<Plane, 6> planes;

    Frustum() = default;

    Frustum& set(const Plane& p0, const Plane& p1, const Plane& p2, const Plane& p3, const Plane& p4,
                 const Plane& p5);
    Frustum& copy(const Frustum& frustum);
    Frustum& setFromProjectionMatrix(const Matrix4& m,
                                     CoordinateSystem coordinateSystem = CoordinateSystem::WebGL,
                                     bool reversedDepth = false);
    [[nodiscard]] bool intersectsSphere(const Sphere& sphere) const;
    [[nodiscard]] bool intersectsBox(const Box3& box) const;
    [[nodiscard]] bool containsPoint(const Vector3& point) const;
    [[nodiscard]] Frustum clone() const { return *this; }
};

}  // namespace tn::engine
