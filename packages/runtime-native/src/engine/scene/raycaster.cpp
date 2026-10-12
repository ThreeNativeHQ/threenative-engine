#include "engine/scene/raycaster.h"
#include "engine/scene/nodes.h"
#include "engine/scene/material.h"
#include <algorithm>
#include <cmath>

namespace tn::engine {
namespace {
void intersect(Object3D& object, const Raycaster& caster, std::vector<Intersection>& hits, bool recursive) {
    bool propagate = true;
    if (object.layers().test(caster.layers)) propagate = object.raycast(caster, hits);
    if (propagate && recursive)
        for (auto* child : object.children) intersect(*child, caster, hits, true);
}
void sort(std::vector<Intersection>& hits) {
    std::stable_sort(hits.begin(), hits.end(), [](const auto& a, const auto& b) { return a.distance < b.distance; });
}
Vector3 attribute(const BufferAttribute& a, uint64_t i) { return {a.getX(i), a.getY(i), a.getZ(i)}; }
// Triangle.getBarycoord, preserving every binary64 expression and operation order.
Vector3 barycoord(const Vector3& point, const Vector3& a, const Vector3& b, const Vector3& c) {
    Vector3 v0, v1, v2;
    v0.subVectors(c, a); v1.subVectors(b, a); v2.subVectors(point, a);
    const double dot00 = v0.dot(v0), dot01 = v0.dot(v1), dot02 = v0.dot(v2), dot11 = v1.dot(v1), dot12 = v1.dot(v2);
    const double denom = dot00 * dot11 - dot01 * dot01;
    if (denom == 0) return {};
    const double invDenom = 1 / denom;
    const double u = (dot11 * dot02 - dot01 * dot12) * invDenom;
    const double v = (dot00 * dot12 - dot01 * dot02) * invDenom;
    return {1 - u - v, v, u};
}
template<class V> V interpolate(const BufferAttribute& attr, uint64_t a, uint64_t b, uint64_t c, const Vector3& bary) {
    V target;
    const auto value = [&](uint64_t i) {
        V v;
        v.x = attr.getX(i); v.y = attr.getY(i);
        if constexpr (std::is_same_v<V, Vector3>) v.z = attr.getZ(i);
        return v;
    };
    target.setScalar(0);
    target.addScaledVector(value(a), bary.x).addScaledVector(value(b), bary.y).addScaledVector(value(c), bary.z);
    return target;
}
}
bool Raycaster::setFromCamera(const Vector2& coords, Camera& source) {
    if (dynamic_cast<PerspectiveCamera*>(&source)) {
        ray.origin.setFromMatrixPosition(source.matrixWorld);
        ray.direction.set(coords.x, coords.y, 0.5).applyMatrix4(source.projectionMatrixInverse)
            .applyMatrix4(source.matrixWorld).sub(ray.origin).normalize();
    } else if (dynamic_cast<OrthographicCamera*>(&source)) {
        ray.origin.set(coords.x, coords.y, source.projectionMatrix.elements[14])
            .applyMatrix4(source.projectionMatrixInverse).applyMatrix4(source.matrixWorld);
        ray.direction.set(0, 0, -1).transformDirection(source.matrixWorld);
    } else return false;
    camera = &source;
    cameraOwner = source.weak_from_this().lock();
    return true;
}
Raycaster& Raycaster::setFromXRController(const Object3D& controller) {
    Matrix4 matrix;
    matrix.identity().extractRotation(controller.matrixWorld);
    ray.origin.setFromMatrixPosition(controller.matrixWorld);
    ray.direction.set(0, 0, -1).applyMatrix4(matrix);
    return *this;
}
std::vector<Intersection>& Raycaster::intersectObject(Object3D& object, bool recursive, std::vector<Intersection>& target) const {
    intersect(object, *this, target, recursive); sort(target); return target;
}
std::vector<Intersection> Raycaster::intersectObject(Object3D& object, bool recursive) const {
    std::vector<Intersection> target; intersectObject(object, recursive, target); return target;
}
std::vector<Intersection>& Raycaster::intersectObjects(const std::vector<Object3D*>& objects, bool recursive,
                                                      std::vector<Intersection>& target) const {
    for (auto* object : objects) intersect(*object, *this, target, recursive);
    sort(target); return target;
}
std::vector<Intersection> Raycaster::intersectObjects(const std::vector<Object3D*>& objects, bool recursive) const {
    std::vector<Intersection> target; intersectObjects(objects, recursive, target); return target;
}
Vector3& Mesh::getVertexPosition(uint64_t index, Vector3& target) const {
    target.copy(attribute(*geometry->attributes.at("position"), index));
    Vector3 morph, temp;
    for (size_t i = 0; i < geometry->morphPositions.size(); ++i) {
        const double influence = i < morphTargetInfluences.size() ? morphTargetInfluences[i] : 0;
        if (influence == 0) continue;
        temp.copy(attribute(*geometry->morphPositions[i], index));
        if (!geometry->morphTargetsRelative) temp.sub(target);
        morph.addScaledVector(temp, influence);
    }
    return target.add(morph);
}
bool Mesh::raycast(const Raycaster& caster, std::vector<Intersection>& hits) {
    if (!material || !geometry) return true;
    if (!geometry->boundingSphere) geometry->computeBoundingSphere();
    Sphere sphere;
    sphere.copy(*geometry->boundingSphere).applyMatrix4(matrixWorld);
    Ray local;
    local.copy(caster.ray).recast(caster.near);
    Vector3 sphereHit;
    if (!sphere.containsPoint(local.origin)) {
        if (!local.intersectSphere(sphere, sphereHit)) return true;
        const double range = caster.far - caster.near;
        if (local.origin.distanceToSquared(sphereHit) > range * range) return true;
    }
    Matrix4 inverse;
    inverse.copy(matrixWorld).invert();
    local.copy(caster.ray).applyMatrix4(inverse);
    if (geometry->boundingBox && !local.intersectsBox(*geometry->boundingBox)) return true;
    const auto position = geometry->getAttribute("position");
    if (!position) return true;
    const auto uv = geometry->getAttribute("uv"), uv1 = geometry->getAttribute("uv1"), normal = geometry->getAttribute("normal");
    const auto index = geometry->index;
    const double start = jsMax(0, geometry->drawRange.start);
    const double end = jsMin(double(index ? index->count() : position->count()), geometry->drawRange.start + geometry->drawRange.count);
    for (double i = start; i < end; i += 3) {
        const auto a = uint64_t(index ? index->getX(uint64_t(i)) : i);
        const auto b = uint64_t(index ? index->getX(uint64_t(i + 1)) : i + 1);
        const auto c = uint64_t(index ? index->getX(uint64_t(i + 2)) : i + 2);
        Vector3 vA, vB, vC, point;
        getVertexPosition(a, vA); getVertexPosition(b, vB); getVertexPosition(c, vC);
        const bool found = material->side == Side::Back
            ? local.intersectTriangle(vC, vB, vA, true, point)
            : local.intersectTriangle(vA, vB, vC, material->side == Side::Front, point);
        if (!found) continue;
        Intersection hit;
        hit.point.copy(point).applyMatrix4(matrixWorld);
        hit.distance = caster.ray.origin.distanceTo(hit.point);
        if (hit.distance < caster.near || hit.distance > caster.far) continue;
        hit.object = this;
        hit.barycoord = barycoord(point, vA, vB, vC);
        if (uv) hit.uv = interpolate<Vector2>(*uv, a, b, c, hit.barycoord);
        if (uv1) hit.uv1 = interpolate<Vector2>(*uv1, a, b, c, hit.barycoord);
        if (normal) {
            hit.normal = interpolate<Vector3>(*normal, a, b, c, hit.barycoord);
            if (hit.normal->dot(local.direction) > 0) hit.normal->multiplyScalar(-1);
        }
        hit.face = {a, b, c, {}, 0};
        Vector3 v0;
        hit.face.normal.subVectors(vC, vB); v0.subVectors(vA, vB); hit.face.normal.cross(v0);
        const double lengthSq = hit.face.normal.lengthSq();
        if (lengthSq > 0) hit.face.normal.multiplyScalar(1 / std::sqrt(lengthSq));
        else hit.face.normal.set(0, 0, 0);
        hit.faceIndex = uint64_t(std::floor(i / 3));
        hits.push_back(hit);
    }
    return true;
}
// three r185 Line.raycast and its checkIntersection: the bounding sphere grown by the threshold, then
// every segment (LineSegments steps by two) within the threshold scaled to the line's local space.
bool Line::raycast(const Raycaster& caster, std::vector<Intersection>& hits) {
    if (!geometry) return true;
    const auto position = geometry->getAttribute("position");
    if (!position) return true;
    if (!geometry->boundingSphere) geometry->computeBoundingSphere();
    Sphere sphere;
    sphere.copy(*geometry->boundingSphere).applyMatrix4(matrixWorld);
    sphere.radius += caster.lineThreshold;
    if (!caster.ray.intersectsSphere(sphere)) return true;
    Matrix4 inverse;
    inverse.copy(matrixWorld).invert();
    Ray local;
    local.copy(caster.ray).applyMatrix4(inverse);
    const double localThreshold = caster.lineThreshold / ((scale.x + scale.y + scale.z) / 3);
    const double localThresholdSq = localThreshold * localThreshold;
    const auto check = [&](uint64_t a, uint64_t b, uint64_t i) {
        const Vector3 start = attribute(*position, a), end = attribute(*position, b);
        Vector3 onRay, onSegment;
        if (local.distanceSqToSegment(start, end, &onRay, &onSegment) > localThresholdSq) return;
        onRay.applyMatrix4(matrixWorld);  // back to world space for the distance
        const double distance = caster.ray.origin.distanceTo(onRay);
        if (distance < caster.near || distance > caster.far) return;
        Intersection hit;
        hit.distance = distance;
        hit.point.copy(onSegment).applyMatrix4(matrixWorld);
        hit.index = i;
        hit.object = this;
        hits.push_back(hit);
    };
    const double step = segments() ? 2 : 1;
    const auto index = geometry->index;
    const double start = jsMax(0, geometry->drawRange.start);
    const double end = jsMin(double(index ? index->count() : position->count()), geometry->drawRange.start + geometry->drawRange.count);
    for (double i = start; i < end - 1; i += step) {
        if (index) check(uint64_t(index->getX(uint64_t(i))), uint64_t(index->getX(uint64_t(i + 1))), uint64_t(i));
        else check(uint64_t(i), uint64_t(i + 1), uint64_t(i));
    }
    return true;
}

bool InstancedMesh::raycast(const Raycaster& caster, std::vector<Intersection>& hits) {
    if (!material || !geometry) return true;
    if (!boundingSphere) computeBoundingSphere();
    Sphere sphere;
    sphere.copy(*boundingSphere).applyMatrix4(matrixWorld);
    if (!caster.ray.intersectsSphere(sphere)) return true;
    Mesh mesh(geometry, material);
    Matrix4 instance;
    for (uint32_t id = 0; id < count; ++id) {
        getMatrixAt(id, instance);
        mesh.matrixWorld.multiplyMatrices(matrixWorld, instance);
        std::vector<Intersection> instanceHits;
        mesh.raycast(caster, instanceHits);
        for (auto& hit : instanceHits) {
            hit.instanceId = id; hit.object = this; hits.push_back(hit);
        }
    }
    return true;
}
LOD& LOD::addLevel(Object3D& object, double distance, double hysteresis) {
    distance = std::fabs(distance);
    auto at = levels.begin();
    for (; at != levels.end(); ++at) if (distance < at->distance) break;
    levels.insert(at, {&object, distance, hysteresis, object.weak_from_this().lock()});
    add(object);
    return *this;
}
bool LOD::removeLevel(double distance) {
    for (auto at = levels.begin(); at != levels.end(); ++at) if (at->distance == distance) {
        remove(*at->object); levels.erase(at); return true;
    }
    return false;
}
Object3D* LOD::getObjectForDistance(double distance) const {
    if (levels.empty()) return nullptr;
    size_t i = 1;
    for (; i < levels.size(); ++i) {
        double levelDistance = levels[i].distance;
        if (levels[i].object->visible()) levelDistance -= levelDistance * levels[i].hysteresis;
        if (distance < levelDistance) break;
    }
    return levels[i - 1].object;
}
void LOD::update(const Camera& camera) {
    if (levels.size() <= 1) return;
    Vector3 v1, v2;
    v1.setFromMatrixPosition(camera.matrixWorld); v2.setFromMatrixPosition(matrixWorld);
    const auto* perspective = dynamic_cast<const PerspectiveCamera*>(&camera);
    const auto* ortho = dynamic_cast<const OrthographicCamera*>(&camera);
    const double zoom = perspective ? perspective->zoom : ortho ? ortho->zoom : std::numeric_limits<double>::quiet_NaN();
    const double distance = v1.distanceTo(v2) / zoom;
    levels[0].object->setVisible(true);
    size_t i = 1;
    for (; i < levels.size(); ++i) {
        double levelDistance = levels[i].distance;
        if (levels[i].object->visible()) levelDistance -= levelDistance * levels[i].hysteresis;
        if (distance >= levelDistance) {
            levels[i - 1].object->setVisible(false); levels[i].object->setVisible(true);
        } else break;
    }
    currentLevel_ = int(i) - 1;
    for (; i < levels.size(); ++i) levels[i].object->setVisible(false);
}
bool LOD::raycast(const Raycaster& caster, std::vector<Intersection>& hits) {
    if (!levels.empty()) {
        Vector3 position;
        position.setFromMatrixPosition(matrixWorld);
        getObjectForDistance(caster.ray.origin.distanceTo(position))->raycast(caster, hits);
    }
    return true;
}
} // namespace tn::engine
