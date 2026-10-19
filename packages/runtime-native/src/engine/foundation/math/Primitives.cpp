#include "engine/foundation/math/Primitives.h"

#include "engine/foundation/math/MathUtils.h"
#include "engine/foundation/math/Matrix.h"
#include "engine/foundation/math/Vector.h"

#include <cmath>

namespace tn::engine {

// Three's module-level scratch values become function-local statics: same reentrancy contract as
// the reference, and the engine is single-threaded by contract (see handles.h).

Box3& Box3::set(const Vector3& min, const Vector3& max) {
    this->min.copy(min);
    this->max.copy(max);
    return *this;
}

Box3& Box3::setFromArray(const double* array, size_t count) {
    makeEmpty();
    static Vector3 vector;
    for (size_t i = 0; i < count; i += 3) this->expandByPoint(vector.fromArray(array, static_cast<int>(i)));
    return *this;
}

Box3& Box3::setFromPoints(const std::vector<Vector3>& points) {
    makeEmpty();
    for (const Vector3& point : points) this->expandByPoint(point);
    return *this;
}

Box3& Box3::setFromCenterAndSize(const Vector3& center, const Vector3& size) {
    static Vector3 halfSize;
    halfSize.copy(size).multiplyScalar(0.5);
    min.copy(center).sub(halfSize);
    max.copy(center).add(halfSize);
    return *this;
}

Box3& Box3::copy(const Box3& box) {
    min.copy(box.min);
    max.copy(box.max);
    return *this;
}

Box3& Box3::makeEmpty() {
    min.x = min.y = min.z = std::numeric_limits<double>::infinity();
    max.x = max.y = max.z = -std::numeric_limits<double>::infinity();
    return *this;
}

bool Box3::isEmpty() const {
    // more robust than a volume test: a volume can come back positive with two negative axes
    return (max.x < min.x) || (max.y < min.y) || (max.z < min.z);
}

Vector3& Box3::getCenter(Vector3& target) const {
    if (isEmpty()) return target.set(0, 0, 0);
    return target.addVectors(min, max).multiplyScalar(0.5);
}

Vector3& Box3::getSize(Vector3& target) const {
    if (isEmpty()) return target.set(0, 0, 0);
    return target.subVectors(max, min);
}

Box3& Box3::expandByPoint(const Vector3& point) {
    min.min(point);
    max.max(point);
    return *this;
}

Box3& Box3::expandByVector(const Vector3& vector) {
    min.sub(vector);
    max.add(vector);
    return *this;
}

Box3& Box3::expandByScalar(double scalar) {
    min.addScalar(-scalar);
    max.addScalar(scalar);
    return *this;
}

bool Box3::containsPoint(const Vector3& point) const {
    return point.x >= min.x && point.x <= max.x && point.y >= min.y && point.y <= max.y &&
           point.z >= min.z && point.z <= max.z;
}

bool Box3::containsBox(const Box3& box) const {
    return min.x <= box.min.x && box.max.x <= max.x && min.y <= box.min.y && box.max.y <= max.y &&
           min.z <= box.min.z && box.max.z <= max.z;
}

Vector3& Box3::getParameter(const Vector3& point, Vector3& target) const {
    // this can divide by zero when the box has a size of zero on an axis
    return target.set((point.x - min.x) / (max.x - min.x), (point.y - min.y) / (max.y - min.y),
                      (point.z - min.z) / (max.z - min.z));
}

bool Box3::intersectsBox(const Box3& box) const {
    // using 6 splitting planes to rule out intersections
    return box.max.x >= min.x && box.min.x <= max.x && box.max.y >= min.y && box.min.y <= max.y &&
           box.max.z >= min.z && box.min.z <= max.z;
}

bool Box3::intersectsSphere(const Sphere& sphere) const {
    // the closest point on the AABB decides; if it is inside the sphere, they intersect
    static Vector3 vector;
    clampPoint(sphere.center, vector);
    return vector.distanceToSquared(sphere.center) <= (sphere.radius * sphere.radius);
}

bool Box3::intersectsPlane(const Plane& plane) const {
    // the minimum and maximum dot products; on the same side of the plane means no intersection
    double min = 0, max = 0;
    if (plane.normal.x > 0) {
        min = plane.normal.x * this->min.x;
        max = plane.normal.x * this->max.x;
    } else {
        min = plane.normal.x * this->max.x;
        max = plane.normal.x * this->min.x;
    }
    if (plane.normal.y > 0) {
        min += plane.normal.y * this->min.y;
        max += plane.normal.y * this->max.y;
    } else {
        min += plane.normal.y * this->max.y;
        max += plane.normal.y * this->min.y;
    }
    if (plane.normal.z > 0) {
        min += plane.normal.z * this->min.z;
        max += plane.normal.z * this->max.z;
    } else {
        min += plane.normal.z * this->max.z;
        max += plane.normal.z * this->min.z;
    }
    return (min <= -plane.constant && max >= -plane.constant);
}

Vector3& Box3::clampPoint(const Vector3& point, Vector3& target) const {
    return target.copy(point).clamp(min, max);
}

double Box3::distanceToPoint(const Vector3& point) const {
    static Vector3 vector;
    clampPoint(point, vector);
    return vector.distanceTo(point);
}

Sphere Box3::getBoundingSphere() const {
    Sphere target;
    if (isEmpty()) {
        target.makeEmpty();
        return target;
    }
    getCenter(target.center);
    static Vector3 size;
    target.radius = getSize(size).length() * 0.5;
    return target;
}

Box3& Box3::intersect(const Box3& box) {
    min.max(box.min);
    max.min(box.max);
    // ensure that a no-overlap result is fully empty, not slightly empty with finite bounds
    if (isEmpty()) makeEmpty();
    return *this;
}

Box3& Box3::unionWith(const Box3& box) {
    min.min(box.min);
    max.max(box.max);
    return *this;
}

Box3& Box3::applyMatrix4(const Matrix4& matrix) {
    // the transform of an empty box is an empty box
    if (isEmpty()) return *this;
    // every one of the 2^3 corner combinations, in the binary pattern of three's comment
    Vector3 points[8];
    points[0].set(min.x, min.y, min.z).applyMatrix4(matrix);  // 000
    points[1].set(min.x, min.y, max.z).applyMatrix4(matrix);  // 001
    points[2].set(min.x, max.y, min.z).applyMatrix4(matrix);  // 010
    points[3].set(min.x, max.y, max.z).applyMatrix4(matrix);  // 011
    points[4].set(max.x, min.y, min.z).applyMatrix4(matrix);  // 100
    points[5].set(max.x, min.y, max.z).applyMatrix4(matrix);  // 101
    points[6].set(max.x, max.y, min.z).applyMatrix4(matrix);  // 110
    points[7].set(max.x, max.y, max.z).applyMatrix4(matrix);  // 111
    return setFromPoints({points[0], points[1], points[2], points[3], points[4], points[5],
                          points[6], points[7]});
}

Box3& Box3::translate(const Vector3& offset) {
    min.add(offset);
    max.add(offset);
    return *this;
}

bool Box3::equals(const Box3& box) const {
    return box.min.equals(min) && box.max.equals(max);
}

Sphere& Sphere::set(const Vector3& center, double radius) {
    this->center.copy(center);
    this->radius = radius;
    return *this;
}

Sphere& Sphere::setFromPoints(const std::vector<Vector3>& points, const Vector3* optionalCenter) {
    if (optionalCenter != nullptr) {
        center.copy(*optionalCenter);
    } else {
        Box3 box;
        box.setFromPoints(points).getCenter(center);
    }
    double maxRadiusSq = 0;
    for (const Vector3& point : points)
        maxRadiusSq = jsMax(maxRadiusSq, center.distanceToSquared(point));
    radius = std::sqrt(maxRadiusSq);
    return *this;
}

Sphere& Sphere::copy(const Sphere& sphere) {
    center.copy(sphere.center);
    radius = sphere.radius;
    return *this;
}

bool Sphere::isEmpty() const { return radius < 0; }

Sphere& Sphere::makeEmpty() {
    center.set(0, 0, 0);
    radius = -1;
    return *this;
}

bool Sphere::containsPoint(const Vector3& point) const {
    return point.distanceToSquared(center) <= (radius * radius);
}

double Sphere::distanceToPoint(const Vector3& point) const {
    return point.distanceTo(center) - radius;
}

bool Sphere::intersectsSphere(const Sphere& sphere) const {
    const double radiusSum = radius + sphere.radius;
    return sphere.center.distanceToSquared(center) <= (radiusSum * radiusSum);
}

bool Sphere::intersectsBox(const Box3& box) const { return box.intersectsSphere(*this); }

bool Sphere::intersectsPlane(const Plane& plane) const {
    return std::fabs(plane.distanceToPoint(center)) <= radius;
}

Vector3& Sphere::clampPoint(const Vector3& point, Vector3& target) const {
    const double deltaLengthSq = center.distanceToSquared(point);
    target.copy(point);
    if (deltaLengthSq > (radius * radius)) {
        target.sub(center).normalize();
        target.multiplyScalar(radius).add(center);
    }
    return target;
}

Box3 Sphere::getBoundingBox() const {
    Box3 target;
    if (isEmpty()) {
        // an empty sphere produces an empty bounding box
        target.makeEmpty();
        return target;
    }
    target.set(center, center);
    target.expandByScalar(radius);
    return target;
}

Sphere& Sphere::applyMatrix4(const Matrix4& matrix) {
    center.applyMatrix4(matrix);
    radius = radius * matrix.getMaxScaleOnAxis();
    return *this;
}

Sphere& Sphere::translate(const Vector3& offset) {
    center.add(offset);
    return *this;
}

Sphere& Sphere::expandByPoint(const Vector3& point) {
    if (isEmpty()) {
        center.copy(point);
        radius = 0;
        return *this;
    }
    static Vector3 delta;
    delta.subVectors(point, center);
    const double lengthSq = delta.lengthSq();
    if (lengthSq > (radius * radius)) {
        // the minimal sphere that still contains the point
        const double length = std::sqrt(lengthSq);
        const double grown = (length - radius) * 0.5;
        center.addScaledVector(delta, grown / length);
        radius += grown;
    }
    return *this;
}

Sphere& Sphere::unionWith(const Sphere& sphere) {
    if (sphere.isEmpty()) return *this;
    if (isEmpty()) return copy(sphere);
    if (center.equals(sphere.center)) {
        radius = jsMax(radius, sphere.radius);
    } else {
        static Vector3 offset;
        offset.subVectors(sphere.center, center).setLength(sphere.radius);
        static Vector3 point;
        expandByPoint(point.copy(sphere.center).add(offset));
        expandByPoint(point.copy(sphere.center).sub(offset));
    }
    return *this;
}

bool Sphere::equals(const Sphere& sphere) const {
    return sphere.center.equals(center) && (sphere.radius == radius);
}

Plane& Plane::set(const Vector3& normal, double constant) {
    this->normal.copy(normal);
    this->constant = constant;
    return *this;
}

Plane& Plane::setComponents(double x, double y, double z, double w) {
    normal.set(x, y, z);
    constant = w;
    return *this;
}

Plane& Plane::setFromNormalAndCoplanarPoint(const Vector3& normal, const Vector3& point) {
    this->normal.copy(normal);
    constant = -point.dot(this->normal);
    return *this;
}

Plane& Plane::setFromCoplanarPoints(const Vector3& a, const Vector3& b, const Vector3& c) {
    static Vector3 first, second;
    const Vector3 normal = first.subVectors(c, b).cross(second.subVectors(a, b)).normalize();
    return setFromNormalAndCoplanarPoint(normal, a);
}

Plane& Plane::copy(const Plane& plane) {
    normal.copy(plane.normal);
    constant = plane.constant;
    return *this;
}

Plane& Plane::normalize() {
    // will divide by zero if the plane is invalid
    const double inverseNormalLength = 1.0 / normal.length();
    normal.multiplyScalar(inverseNormalLength);
    constant *= inverseNormalLength;
    return *this;
}

Plane& Plane::negate() {
    constant *= -1;
    normal.negate();
    return *this;
}

double Plane::distanceToPoint(const Vector3& point) const { return normal.dot(point) + constant; }

double Plane::distanceToSphere(const Sphere& sphere) const {
    return distanceToPoint(sphere.center) - sphere.radius;
}

Vector3& Plane::projectPoint(const Vector3& point, Vector3& target) const {
    return target.copy(point).addScaledVector(normal, -distanceToPoint(point));
}

bool Plane::intersectsBox(const Box3& box) const { return box.intersectsPlane(*this); }

bool Plane::intersectsSphere(const Sphere& sphere) const { return sphere.intersectsPlane(*this); }

Vector3& Plane::coplanarPoint(Vector3& target) const {
    return target.copy(normal).multiplyScalar(-constant);
}

Plane& Plane::applyMatrix4(const Matrix4& matrix) {
    static Matrix3 normalMatrix;
    normalMatrix.getNormalMatrix(matrix);
    static Vector3 referencePoint;
    coplanarPoint(referencePoint).applyMatrix4(matrix);
    const Vector3 normal = this->normal.applyMatrix3(normalMatrix).normalize();
    constant = -referencePoint.dot(normal);
    return *this;
}

Plane& Plane::translate(const Vector3& offset) {
    constant -= offset.dot(normal);
    return *this;
}

bool Plane::equals(const Plane& plane) const {
    return plane.normal.equals(normal) && (plane.constant == constant);
}

Ray& Ray::set(const Vector3& origin, const Vector3& direction) {
    this->origin.copy(origin);
    this->direction.copy(direction);
    return *this;
}

Ray& Ray::copy(const Ray& ray) {
    origin.copy(ray.origin);
    direction.copy(ray.direction);
    return *this;
}

Vector3& Ray::at(double t, Vector3& target) const {
    return target.copy(origin).addScaledVector(direction, t);
}

Ray& Ray::lookAt(const Vector3& v) {
    direction.copy(v).sub(origin).normalize();
    return *this;
}

Ray& Ray::recast(double t) {
    static Vector3 vector;
    origin.copy(at(t, vector));
    return *this;
}

Vector3& Ray::closestPointToPoint(const Vector3& point, Vector3& target) const {
    target.subVectors(point, origin);
    const double directionDistance = target.dot(direction);
    if (directionDistance < 0) return target.copy(origin);
    return target.copy(origin).addScaledVector(direction, directionDistance);
}

double Ray::distanceToPoint(const Vector3& point) const {
    return std::sqrt(distanceSqToPoint(point));
}

double Ray::distanceSqToPoint(const Vector3& point) const {
    static Vector3 vector;
    const double directionDistance = vector.subVectors(point, origin).dot(direction);
    // the point is behind the ray
    if (directionDistance < 0) return origin.distanceToSquared(point);
    vector.copy(origin).addScaledVector(direction, directionDistance);
    return vector.distanceToSquared(point);
}

double Ray::distanceSqToSegment(const Vector3& v0, const Vector3& v1, Vector3* pointOnRay,
                                Vector3* pointOnSegment) const {
    // from https://github.com/pmjoniak/GeometricTools GteDistRaySegment.h
    static Vector3 segCenter, segDir, diff;
    segCenter.copy(v0).add(v1).multiplyScalar(0.5);
    segDir.copy(v1).sub(v0).normalize();
    diff.copy(origin).sub(segCenter);
    const double segExtent = v0.distanceTo(v1) * 0.5;
    const double a01 = -direction.dot(segDir);
    const double b0 = diff.dot(direction);
    const double b1 = -diff.dot(segDir);
    const double c = diff.lengthSq();
    const double det = std::fabs(1 - a01 * a01);
    double s0, s1, sqrDist;
    if (det > 0) {
        // the ray and the segment are not parallel
        s0 = a01 * b1 - b0;
        s1 = a01 * b0 - b1;
        const double extDet = segExtent * det;
        if (s0 >= 0) {
            if (s1 >= -extDet) {
                if (s1 <= extDet) {
                    // region 0: the minimum is interior to both the ray and the segment
                    const double invDet = 1 / det;
                    s0 *= invDet;
                    s1 *= invDet;
                    sqrDist = s0 * (s0 + a01 * s1 + 2 * b0) + s1 * (a01 * s0 + s1 + 2 * b1) + c;
                } else {
                    // region 1
                    s1 = segExtent;
                    s0 = jsMax(0, -(a01 * s1 + b0));
                    sqrDist = -s0 * s0 + s1 * (s1 + 2 * b1) + c;
                }
            } else {
                // region 5
                s1 = -segExtent;
                s0 = jsMax(0, -(a01 * s1 + b0));
                sqrDist = -s0 * s0 + s1 * (s1 + 2 * b1) + c;
            }
        } else {
            if (s1 <= -extDet) {
                // region 4
                s0 = jsMax(0, -(-a01 * segExtent + b0));
                s1 = (s0 > 0) ? -segExtent : jsMin(jsMax(-segExtent, -b1), segExtent);
                sqrDist = -s0 * s0 + s1 * (s1 + 2 * b1) + c;
            } else if (s1 <= extDet) {
                // region 3
                s0 = 0;
                s1 = jsMin(jsMax(-segExtent, -b1), segExtent);
                sqrDist = s1 * (s1 + 2 * b1) + c;
            } else {
                // region 2
                s0 = jsMax(0, -(a01 * segExtent + b0));
                s1 = (s0 > 0) ? segExtent : jsMin(jsMax(-segExtent, -b1), segExtent);
                sqrDist = -s0 * s0 + s1 * (s1 + 2 * b1) + c;
            }
        }
    } else {
        // the ray and the segment are parallel
        s1 = (a01 > 0) ? -segExtent : segExtent;
        s0 = jsMax(0, -(a01 * s1 + b0));
        sqrDist = -s0 * s0 + s1 * (s1 + 2 * b1) + c;
    }
    if (pointOnRay != nullptr) pointOnRay->copy(origin).addScaledVector(direction, s0);
    if (pointOnSegment != nullptr) pointOnSegment->copy(segCenter).addScaledVector(segDir, s1);
    return sqrDist;
}

bool Ray::intersectSphere(const Sphere& sphere, Vector3& target) const {
    static Vector3 vector;
    vector.subVectors(sphere.center, origin);
    const double tca = vector.dot(direction);
    const double d2 = vector.dot(vector) - tca * tca;
    const double radius2 = sphere.radius * sphere.radius;
    if (d2 > radius2) return false;
    const double thc = std::sqrt(radius2 - d2);
    // t0 is the entrance on the front of the sphere, t1 the exit on the back
    const double t0 = tca - thc;
    const double t1 = tca + thc;
    // t1 behind the ray is a miss
    if (t1 < 0) return false;
    // t0 behind the ray means the origin is inside, so answer the exit point
    if (t0 < 0) {
        at(t1, target);
        return true;
    }
    at(t0, target);
    return true;
}

bool Ray::intersectsSphere(const Sphere& sphere) const {
    if (sphere.radius < 0) return false;  // an empty sphere never intersects, see three #31187
    return distanceSqToPoint(sphere.center) <= (sphere.radius * sphere.radius);
}

bool Ray::distanceToPlane(const Plane& plane, double& distance) const {
    const double denominator = plane.normal.dot(direction);
    if (denominator == 0) {
        // the ray is coplanar, so the origin is the answer
        if (plane.distanceToPoint(origin) == 0) {
            distance = 0;
            return true;
        }
        return false;
    }
    const double t = -(origin.dot(plane.normal) + plane.constant) / denominator;
    // no intersection when the ray never reaches the plane
    if (t < 0) return false;
    distance = t;
    return true;
}

bool Ray::intersectPlane(const Plane& plane, Vector3& target) const {
    double distance = 0;
    if (!distanceToPlane(plane, distance)) return false;
    at(distance, target);
    return true;
}

bool Ray::intersectsPlane(const Plane& plane) const {
    // check whether the ray lies on the plane first
    const double distToPoint = plane.distanceToPoint(origin);
    if (distToPoint == 0) return true;
    const double denominator = plane.normal.dot(direction);
    if (denominator * distToPoint < 0) return true;
    // the origin is behind the plane and pointing away from it
    return false;
}

bool Ray::intersectBox(const Box3& box, Vector3& target) const {
    double tmin, tmax, tymin, tymax, tzmin, tzmax;
    const double invdirx = 1 / direction.x,
                 invdiry = 1 / direction.y,
                 invdirz = 1 / direction.z;
    const Vector3& start = origin;
    if (invdirx >= 0) {
        tmin = (box.min.x - start.x) * invdirx;
        tmax = (box.max.x - start.x) * invdirx;
    } else {
        tmin = (box.max.x - start.x) * invdirx;
        tmax = (box.min.x - start.x) * invdirx;
    }
    if (invdiry >= 0) {
        tymin = (box.min.y - start.y) * invdiry;
        tymax = (box.max.y - start.y) * invdiry;
    } else {
        tymin = (box.max.y - start.y) * invdiry;
        tymax = (box.min.y - start.y) * invdiry;
    }
    if ((tmin > tymax) || (tymin > tmax)) return false;
    if (tymin > tmin || std::isnan(tmin)) tmin = tymin;
    if (tymax < tmax || std::isnan(tmax)) tmax = tymax;
    if (invdirz >= 0) {
        tzmin = (box.min.z - start.z) * invdirz;
        tzmax = (box.max.z - start.z) * invdirz;
    } else {
        tzmin = (box.max.z - start.z) * invdirz;
        tzmax = (box.min.z - start.z) * invdirz;
    }
    if ((tmin > tzmax) || (tzmin > tmax)) return false;
    if (tzmin > tmin || tmin != tmin) tmin = tzmin;
    if (tzmax < tmax || tmax != tmax) tmax = tzmax;
    // the point closest to the ray, on its positive side
    if (tmax < 0) return false;
    at(tmin >= 0 ? tmin : tmax, target);
    return true;
}

bool Ray::intersectsBox(const Box3& box) const {
    static Vector3 vector;
    return intersectBox(box, vector);
}

bool Ray::intersectTriangle(const Vector3& a, const Vector3& b, const Vector3& c, bool backfaceCulling,
                            Vector3& target) const {
    // from https://github.com/pmjoniak/GeometricTools GteIntrRay3Triangle3.h
    static Vector3 edge1, edge2, normal;
    edge1.subVectors(b, a);
    edge2.subVectors(c, a);
    normal.crossVectors(edge1, edge2);
    double DdN = direction.dot(normal);
    double sign = 0;
    if (DdN > 0) {
        if (backfaceCulling) return false;
        sign = 1;
    } else if (DdN < 0) {
        sign = -1;
        DdN = -DdN;
    } else {
        return false;
    }
    static Vector3 diff;
    diff.subVectors(origin, a);
    const double DdQxE2 = sign * direction.dot(edge2.crossVectors(diff, edge2));
    // b1 < 0: no intersection
    if (DdQxE2 < 0) return false;
    const double DdE1xQ = sign * direction.dot(edge1.cross(diff));
    // b2 < 0: no intersection
    if (DdE1xQ < 0) return false;
    // b1 + b2 > 1: no intersection
    if (DdQxE2 + DdE1xQ > DdN) return false;
    const double QdN = -sign * diff.dot(normal);
    // t < 0: no intersection
    if (QdN < 0) return false;
    at(QdN / DdN, target);
    return true;
}

Ray& Ray::applyMatrix4(const Matrix4& matrix4) {
    origin.applyMatrix4(matrix4);
    direction.transformDirection(matrix4);
    return *this;
}

bool Ray::equals(const Ray& ray) const {
    return ray.origin.equals(origin) && ray.direction.equals(direction);
}

Frustum& Frustum::set(const Plane& p0, const Plane& p1, const Plane& p2, const Plane& p3,
                      const Plane& p4, const Plane& p5) {
    planes[0].copy(p0);
    planes[1].copy(p1);
    planes[2].copy(p2);
    planes[3].copy(p3);
    planes[4].copy(p4);
    planes[5].copy(p5);
    return *this;
}

Frustum& Frustum::copy(const Frustum& frustum) {
    for (size_t i = 0; i < 6; i++) planes[i].copy(frustum.planes[i]);
    return *this;
}

Frustum& Frustum::setFromProjectionMatrix(const Matrix4& m, CoordinateSystem coordinateSystem,
                                         bool reversedDepth) {
    const double* me = m.elements.data();
    const double me0 = me[0], me1 = me[1], me2 = me[2], me3 = me[3];
    const double me4 = me[4], me5 = me[5], me6 = me[6], me7 = me[7];
    const double me8 = me[8], me9 = me[9], me10 = me[10], me11 = me[11];
    const double me12 = me[12], me13 = me[13], me14 = me[14], me15 = me[15];
    planes[0].setComponents(me3 - me0, me7 - me4, me11 - me8, me15 - me12).normalize();
    planes[1].setComponents(me3 + me0, me7 + me4, me11 + me8, me15 + me12).normalize();
    planes[2].setComponents(me3 + me1, me7 + me5, me11 + me9, me15 + me13).normalize();
    planes[3].setComponents(me3 - me1, me7 - me5, me11 - me9, me15 - me13).normalize();
    if (reversedDepth) {
        planes[4].setComponents(me2, me6, me10, me14).normalize();  // far
        planes[5].setComponents(me3 - me2, me7 - me6, me11 - me10, me15 - me14).normalize();  // near
    } else {
        planes[4].setComponents(me3 - me2, me7 - me6, me11 - me10, me15 - me14).normalize();  // far
        if (coordinateSystem == CoordinateSystem::WebGL) {
            planes[5].setComponents(me3 + me2, me7 + me6, me11 + me10, me15 + me14).normalize();  // near
        } else {
            planes[5].setComponents(me2, me6, me10, me14).normalize();  // near
        }
    }
    return *this;
}

bool Frustum::intersectsSphere(const Sphere& sphere) const {
    const Vector3& center = sphere.center;
    const double negRadius = -sphere.radius;
    for (const Plane& plane : planes)
        if (plane.distanceToPoint(center) < negRadius) return false;
    return true;
}

bool Frustum::intersectsBox(const Box3& box) const {
    static Vector3 corner;
    for (const Plane& plane : planes) {
        // the corner at the maximum distance from this plane
        corner.x = plane.normal.x > 0 ? box.max.x : box.min.x;
        corner.y = plane.normal.y > 0 ? box.max.y : box.min.y;
        corner.z = plane.normal.z > 0 ? box.max.z : box.min.z;
        if (plane.distanceToPoint(corner) < 0) return false;
    }
    return true;
}

bool Frustum::containsPoint(const Vector3& point) const {
    for (const Plane& plane : planes)
        if (plane.distanceToPoint(point) < 0) return false;
    return true;
}

}  // namespace tn::engine
