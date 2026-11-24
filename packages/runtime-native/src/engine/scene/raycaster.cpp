#include "engine/scene/raycaster.h"
#include "engine/scene/nodes.h"
#include "engine/scene/material.h"
#include <algorithm>
#include <array>
#include <bit>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <string_view>
#include <utility>

namespace tn::engine {
struct TriangleBVH {
    struct AttributeState {
        std::shared_ptr<BufferAttribute> attribute;
        std::shared_ptr<BufferStore> store;
        uint64_t count = 0, writes = 0;
        uint32_t version = 0;
        int itemSize = 0;
        bool normalized = false;
        explicit AttributeState(const std::shared_ptr<BufferAttribute>& a) : attribute(a) {
            if (!a) return;
            store = a->store; count = a->count(); writes = store->writes(); version = a->version();
            itemSize = a->itemSize; normalized = a->normalized;
        }
        bool matches(const std::shared_ptr<BufferAttribute>& a) const {
            return attribute == a && (!a || (store == a->store && count == a->count() &&
                writes == store->writes() && version == a->version() &&
                itemSize == a->itemSize && normalized == a->normalized));
        }
    };
    struct Node {
        Box3 bounds;
        size_t begin = 0, count = 0, left = 0, right = 0;
    };
    AttributeState position, index;
    DrawRange drawRange;
    std::vector<Node> nodes;
    std::vector<double> starts;

    TriangleBVH(const std::shared_ptr<BufferAttribute>& p, const std::shared_ptr<BufferAttribute>& ix,
                const DrawRange& range, double start, double end) : position(p), index(ix), drawRange(range) {
        struct Triangle { double start; Box3 bounds; };
        std::vector<Triangle> triangles;
        for (double i = start; i < end; i += 3) {
            Triangle triangle{i, {}};
            for (int j = 0; j < 3; ++j) {
                const auto at = uint64_t(ix ? ix->getX(uint64_t(i + j)) : i + j);
                const Vector3 v{p->getX(at), p->getY(at), p->getZ(at)};
                if (!std::isfinite(v.x) || !std::isfinite(v.y) || !std::isfinite(v.z)) {
                    triangle.bounds.min.setScalar(-std::numeric_limits<double>::infinity());
                    triangle.bounds.max.setScalar(std::numeric_limits<double>::infinity());
                    break; // Malformed triangles retain the original hit math instead of being culled.
                }
                triangle.bounds.expandByPoint(v);
            }
            triangles.push_back(triangle);
        }
        const auto component = [](const Vector3& v, int axis) { return axis == 0 ? v.x : axis == 1 ? v.y : v.z; };
        const auto build = [&](auto&& self, size_t begin, size_t end) -> size_t {
            const size_t node = nodes.size();
            nodes.emplace_back();
            Box3 bounds;
            for (size_t i = begin; i < end; ++i) bounds.unionWith(triangles[i].bounds);
            nodes[node].bounds = bounds;
            if (end - begin <= 8) {
                nodes[node].begin = begin; nodes[node].count = end - begin;
            } else {
                Vector3 extent; bounds.getSize(extent);
                const int axis = extent.x >= extent.y && extent.x >= extent.z ? 0 : extent.y >= extent.z ? 1 : 2;
                const size_t middle = begin + (end - begin) / 2;
                const auto center = [&](const Triangle& t) {
                    const double value = component(t.bounds.min, axis) * 0.5 + component(t.bounds.max, axis) * 0.5;
                    return std::isnan(value) ? 0 : value;
                };
                std::nth_element(triangles.begin() + begin, triangles.begin() + middle, triangles.begin() + end,
                    [&](const Triangle& a, const Triangle& b) { return center(a) < center(b); });
                const size_t left = self(self, begin, middle), right = self(self, middle, end);
                nodes[node].left = left; nodes[node].right = right;
            }
            return node;
        };
        if (!triangles.empty()) build(build, 0, triangles.size());
        starts.reserve(triangles.size());
        for (const auto& triangle : triangles) starts.push_back(triangle.start);
        // A deferred store may have filled its bytes while the bounds were read.
        position = AttributeState(p); index = AttributeState(ix);
    }
};
namespace {
thread_local uint64_t trianglesTested = 0;
thread_local uint64_t meshesTested = 0;
// One ulp step in place of std::nextafter(x, +/-inf): the slab test runs per axis per node per ray and
// the library call does not inline. Bit-identical for finite values, both zeros, subnormals and the
// infinities; a NaN passes through with its payload.
constexpr uint64_t kSignBit = 0x8000000000000000ull;
constexpr uint64_t kPositiveInfinity = 0x7ff0000000000000ull;
constexpr uint64_t kNegativeInfinity = 0xfff0000000000000ull;
inline double nextUp(double x) {
    const uint64_t bits = std::bit_cast<uint64_t>(x);
    if (std::isnan(x) || bits == kPositiveInfinity) return x;
    if (bits == kSignBit) return std::bit_cast<double>(uint64_t{1});  // -0 and +0 share one next value
    return std::bit_cast<double>((bits & kSignBit) != 0 ? bits - 1 : bits + 1);
}
inline double nextDown(double x) {
    const uint64_t bits = std::bit_cast<uint64_t>(x);
    if (std::isnan(x) || bits == kNegativeInfinity) return x;
    if (bits == 0) return std::bit_cast<double>(kSignBit | 1);  // +0 and -0 share one previous value
    return std::bit_cast<double>((bits & kSignBit) != 0 ? bits + 1 : bits - 1);
}
bool intersectsBounds(const Ray& ray, const Box3& bounds, double near, double far) {
    const double origins[] = {ray.origin.x, ray.origin.y, ray.origin.z};
    const double directions[] = {ray.direction.x, ray.direction.y, ray.direction.z};
    const double minima[] = {bounds.min.x, bounds.min.y, bounds.min.z};
    const double maxima[] = {bounds.max.x, bounds.max.y, bounds.max.z};
    for (int axis = 0; axis < 3; ++axis) {
        // Pad both the bounds and slab distances: edge, vertex and zero-thickness hits must survive rounding.
        const double padding = 64 * std::numeric_limits<double>::epsilon() *
            std::max({1.0, std::abs(origins[axis]), std::abs(minima[axis]), std::abs(maxima[axis])});
        const double low = minima[axis] - padding, high = maxima[axis] + padding;
        if (directions[axis] == 0) {
            if (origins[axis] < low || origins[axis] > high) return false;
            continue;
        }
        double a = (low - origins[axis]) / directions[axis], b = (high - origins[axis]) / directions[axis];
        if (a > b) std::swap(a, b);
        near = std::max(near, nextDown(a));
        far = std::min(far, nextUp(b));
        if (near > far) return false;
    }
    return true;
}
void intersect(Object3D& object, const Raycaster& caster, std::vector<Intersection>& hits, bool recursive) {
    bool propagate = true;
    if (object.layers().test(caster.layers)) propagate = object.raycast(caster, hits);
    if (propagate && recursive)
        for (auto* child : object.children) intersect(*child, caster, hits, true);
}
void sort(std::vector<Intersection>& hits) {
    std::stable_sort(hits.begin(), hits.end(), [](const auto& a, const auto& b) { return a.distance < b.distance; });
}
// Object-level subtree BVH: one box per mesh, so a recursive pick skips untouched branches before any
// per-mesh work. A box is the world sphere `Mesh::raycast` itself gates on, so a mesh it would accept is
// never skipped. `Object3D`/`Group`/`Scene` carry no raycast of their own and a plain `Mesh` runs its own;
// every other node (`LOD`, `InstancedMesh`, `SkinnedMesh`, `Line`, custom) keeps the verbatim `intersect`
// walk through `always`, which owns its whole subtree, so nothing is visited twice. Layer masks are a query
// -time test, never baked in: `intersect` tests them but still recurses.
struct SubtreeBVH {
    struct Leaf {
        Mesh* mesh = nullptr;
        std::weak_ptr<Object3D> owner;
        uint64_t preOrder = 0, revision = 0;
        const BufferGeometry* geometry = nullptr;
        std::array<double, 16> world{};
        Sphere local;  // The geometry sphere the box was built from.
        Box3 worldBox;
    };
    struct Always {  // `intersect(*object, ..., true)` runs this node's raycast and propagate semantics.
        Object3D* object = nullptr;
        std::weak_ptr<Object3D> owner;
        uint64_t preOrder = 0;
    };
    struct Node { Box3 bounds; uint32_t begin = 0, count = 0, left = 0, right = 0; };
    struct Candidate { uint64_t preOrder; Object3D* object; bool always; };
    std::weak_ptr<Object3D> rootWeak;
    uint64_t hierarchy = 0;
    bool built = false, small = false;
    std::vector<Leaf> leaves;
    std::vector<Always> always;
    std::vector<Node> nodes;
    std::vector<uint32_t> order;
};
void buildSubtree(SubtreeBVH& bvh, Object3D& root) {
    bvh.leaves.clear(); bvh.always.clear(); bvh.nodes.clear(); bvh.order.clear();
    bvh.built = false; bvh.small = false;
    uint64_t preOrder = 0;
    const auto add = [&](auto&& self, Object3D& object) -> void {
        const uint64_t at = preOrder++;
        const std::string_view type = object.type();
        bool recurse = false;
        if (type == "Mesh") {
            auto& mesh = static_cast<Mesh&>(object);
            bool bounded = false;
            if (mesh.geometry) {
                auto& geometry = *mesh.geometry;
                if (!geometry.boundingSphere) geometry.computeBoundingSphere();
                if (geometry.boundingSphere) {
                    Sphere world;
                    world.copy(*geometry.boundingSphere).applyMatrix4(mesh.matrixWorld);
                    const double eps = 1e-6 * std::max({1.0, std::abs(world.center.x), std::abs(world.center.y),
                        std::abs(world.center.z), std::abs(world.radius)});
                    const double radius = std::abs(world.radius) + eps;
                    if (std::isfinite(world.center.x) && std::isfinite(world.center.y) &&
                        std::isfinite(world.center.z) && std::isfinite(radius)) {
                        SubtreeBVH::Leaf leaf;
                        leaf.mesh = &mesh; leaf.owner = object.weak_from_this(); leaf.preOrder = at;
                        leaf.revision = mesh.revision(); leaf.geometry = mesh.geometry.get();
                        leaf.world = mesh.matrixWorld.elements; leaf.local = *geometry.boundingSphere;
                        leaf.worldBox.set({world.center.x - radius, world.center.y - radius, world.center.z - radius},
                                          {world.center.x + radius, world.center.y + radius, world.center.z + radius});
                        bvh.leaves.push_back(leaf);
                        bounded = recurse = true;
                    }
                }
            }
            // A mesh without finite bounds keeps its own walk (malformed geometry must reach the hit code).
            if (!bounded) bvh.always.push_back({&object, object.weak_from_this(), at});
        } else if (type == "Object3D" || type == "Group" || type == "Scene") recurse = true;
        else bvh.always.push_back({&object, object.weak_from_this(), at});
        if (recurse) for (auto* child : object.children) self(self, *child);
    };
    add(add, root);
    bvh.small = bvh.leaves.size() < 16;
    if (!bvh.small) {
        bvh.order.resize(bvh.leaves.size());
        for (size_t i = 0; i < bvh.order.size(); ++i) bvh.order[i] = uint32_t(i);
        const auto centroid = [](const Box3& box, int axis) {
            const double value = (axis == 0 ? box.min.x : axis == 1 ? box.min.y : box.min.z) * 0.5 +
                                 (axis == 0 ? box.max.x : axis == 1 ? box.max.y : box.max.z) * 0.5;
            return std::isnan(value) ? 0 : value;
        };
        const auto build = [&](auto&& self, size_t begin, size_t end) -> size_t {
            const size_t node = bvh.nodes.size();
            bvh.nodes.emplace_back();
            Box3 bounds;
            for (size_t i = begin; i < end; ++i) bounds.unionWith(bvh.leaves[bvh.order[i]].worldBox);
            bvh.nodes[node].bounds = bounds;
            if (end - begin <= 4) {
                bvh.nodes[node].begin = uint32_t(begin); bvh.nodes[node].count = uint32_t(end - begin);
            } else {
                Vector3 extent; bounds.getSize(extent);
                const int axis = extent.x >= extent.y && extent.x >= extent.z ? 0 : extent.y >= extent.z ? 1 : 2;
                const size_t middle = begin + (end - begin) / 2;
                std::nth_element(bvh.order.begin() + begin, bvh.order.begin() + middle, bvh.order.begin() + end,
                    [&](uint32_t a, uint32_t b) {
                        return centroid(bvh.leaves[a].worldBox, axis) < centroid(bvh.leaves[b].worldBox, axis);
                    });
                const size_t left = self(self, begin, middle), right = self(self, middle, end);
                bvh.nodes[node].left = uint32_t(left); bvh.nodes[node].right = uint32_t(right);
            }
            return node;
        };
        build(build, 0, bvh.leaves.size());
    }
    bvh.hierarchy = Object3D::hierarchyVersion();
    bvh.built = true;
}
bool subtreeValid(const SubtreeBVH& bvh) {
    if (bvh.hierarchy != Object3D::hierarchyVersion()) return false;
    for (const auto& leaf : bvh.leaves) {
        // A group's move shows up in its children's world matrices, so validating the leaves is enough.
        // `expired()` is the same test as `lock().get() != mesh` without the atomic refcount traffic, and
        // it must come before the deref: a dead leaf's `mesh` is already dangling.
        if (leaf.owner.expired()) return false;
        const Mesh& mesh = *leaf.mesh;
        if (mesh.revision() != leaf.revision || mesh.geometry.get() != leaf.geometry) return false;
        if (std::memcmp(mesh.matrixWorld.elements.data(), leaf.world.data(), sizeof(double) * 16) != 0) return false;
        const auto& sphere = mesh.geometry->boundingSphere;
        if (!sphere || sphere->radius != leaf.local.radius || sphere->center.x != leaf.local.center.x ||
            sphere->center.y != leaf.local.center.y || sphere->center.z != leaf.local.center.z) return false;
    }
    for (const auto& entry : bvh.always) if (entry.owner.expired()) return false;
    return true;
}
bool subtreeIntersect(Object3D& root, const Raycaster& caster, std::vector<Intersection>& target) {
    const auto owner = root.weak_from_this().lock();
    if (!owner) return false;  // A stack object's address is not a stable cache key.
    thread_local std::vector<std::pair<const Object3D*, SubtreeBVH>> cache;
    SubtreeBVH* entry = nullptr;
    for (size_t i = 0; i < cache.size();) {
        if (cache[i].second.rootWeak.expired()) {
            cache[i] = std::move(cache.back());
            cache.pop_back();
            continue;
        }
        if (cache[i].first == &root) entry = &cache[i].second;
        ++i;
    }
    if (!entry) {
        cache.emplace_back(&root, SubtreeBVH{});
        entry = &cache.back().second;
    }
    SubtreeBVH& bvh = *entry;
    if (!bvh.built || bvh.rootWeak.lock() != owner || !subtreeValid(bvh)) {
        buildSubtree(bvh, root);
        bvh.rootWeak = owner;
    }
    if (bvh.small) return false;  // Below 16 meshes the plain walk is cheaper than the tree.
    thread_local std::vector<SubtreeBVH::Candidate> candidates;
    candidates.clear();
    const auto visit = [&](auto&& self, size_t at) -> void {
        const auto& node = bvh.nodes[at];
        if (!intersectsBounds(caster.ray, node.bounds, caster.near, caster.far)) return;
        if (node.count) {
            for (uint32_t i = 0; i < node.count; ++i) {
                const auto& leaf = bvh.leaves[bvh.order[node.begin + i]];
                candidates.push_back({leaf.preOrder, leaf.mesh, false});
            }
        } else { self(self, node.left); self(self, node.right); }
    };
    if (!bvh.nodes.empty()) visit(visit, 0);
    for (const auto& entry : bvh.always) candidates.push_back({entry.preOrder, entry.object, true});
    // Pre-order is the visit order `intersect` uses, and `sort` is stable: equal distances tie the same way.
    std::sort(candidates.begin(), candidates.end(),
        [](const auto& a, const auto& b) { return a.preOrder < b.preOrder; });
    for (const auto& candidate : candidates) {
        if (candidate.always) intersect(*candidate.object, caster, target, true);
        else if (candidate.object->layers().test(caster.layers)) candidate.object->raycast(caster, target);
    }
    return true;
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
uint64_t raycastTrianglesTested() { return trianglesTested; }
void resetRaycastTrianglesTested() { trianglesTested = 0; }
uint64_t raycastMeshesTested() { return meshesTested; }
void resetRaycastMeshesTested() { meshesTested = 0; }
// Unit-test hook for the slab padding's bit-stepping; declared by the raycast suite, as the counters are.
void raycastNextAfterForTesting(double x, double& up, double& down) { up = nextUp(x); down = nextDown(x); }

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
    if (!(recursive && !meshBruteForceForTesting && subtreeIntersect(object, *this, target)))
        intersect(object, *this, target, recursive);
    sort(target); return target;
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
    ++meshesTested;
    if (!material || !geometry) return true;
    if (!geometry->boundingSphere) geometry->computeBoundingSphere();
    const Sphere& localSphere = *geometry->boundingSphere;
    const bool sameWorld = raycastSphereValid_ && raycastWorld_ == matrixWorld.elements;
    if (!sameWorld) {
        raycastWorld_ = matrixWorld.elements;
        raycastSphereValid_ = false;
        raycastInvValid_ = false;
    }
    Sphere sphere;
    if (sameWorld && raycastGeo_ == geometry.get() &&
        raycastLocalCenter_.x == localSphere.center.x && raycastLocalCenter_.y == localSphere.center.y &&
        raycastLocalCenter_.z == localSphere.center.z && raycastLocalRadius_ == localSphere.radius) {
        sphere = raycastWorldSphere_;
    } else {
        sphere.copy(localSphere).applyMatrix4(matrixWorld);
        raycastGeo_ = geometry.get();
        raycastLocalCenter_ = localSphere.center;
        raycastLocalRadius_ = localSphere.radius;
        raycastWorldSphere_ = sphere;
        raycastSphereValid_ = true;
    }
    Ray local;
    local.copy(caster.ray).recast(caster.near);
    Vector3 sphereHit;
    if (!sphere.containsPoint(local.origin)) {
        if (!local.intersectSphere(sphere, sphereHit)) return true;
        const double range = caster.far - caster.near;
        if (local.origin.distanceToSquared(sphereHit) > range * range) return true;
    }
    if (!raycastInvValid_) {
        raycastWorldInv_.copy(matrixWorld).invert();
        raycastInvValid_ = true;
    }
    const Matrix4& inverse = raycastWorldInv_;
    local.copy(caster.ray).applyMatrix4(inverse);
    if (geometry->boundingBox && !local.intersectsBox(*geometry->boundingBox)) return true;
    const auto position = geometry->getAttribute("position");
    if (!position) return true;
    const auto index = geometry->index;
    const double start = jsMax(0, geometry->drawRange.start);
    const double end = jsMin(double(index ? index->count() : position->count()), geometry->drawRange.start + geometry->drawRange.count);
    const bool accelerated = !caster.meshBruteForceForTesting && !posesVertices() &&
        std::none_of(morphTargetInfluences.begin(), morphTargetInfluences.end(), [](double v) { return v != 0; });
    static thread_local std::vector<double> candidates;
    candidates.clear();
    if (accelerated) {
        auto& tree = geometry->raycastBVH;
        if (!tree || !tree->position.matches(position) || !tree->index.matches(index) ||
            tree->drawRange.start != geometry->drawRange.start || tree->drawRange.count != geometry->drawRange.count)
            tree = std::make_shared<TriangleBVH>(position, index, geometry->drawRange, start, end);
        // The inverse linear transform's Frobenius norm overestimates every local/world distance ratio.
        // Zero is a conservative lower bound for near; the unchanged hit code enforces the exact interval.
        const auto& e = inverse.elements;
        const double localScale = std::hypot(std::hypot(e[0], e[1], e[2]),
            std::hypot(e[4], e[5], e[6]), std::hypot(e[8], e[9], e[10]));
        const auto& world = matrixWorld.elements;
        const double rounding = 64 * std::numeric_limits<double>::epsilon() * std::max({1.0,
            std::abs(caster.ray.origin.x), std::abs(caster.ray.origin.y), std::abs(caster.ray.origin.z),
            std::abs(world[12]), std::abs(world[13]), std::abs(world[14])});
        const double localFar = std::isfinite(caster.far) && caster.far >= 0 && std::isfinite(localScale) && localScale > 0
            ? std::nextafter((caster.far + rounding) * localScale, std::numeric_limits<double>::infinity())
            : std::numeric_limits<double>::infinity();
        const auto visit = [&](auto&& self, size_t at) -> void {
            const auto& node = tree->nodes[at];
            if (!intersectsBounds(local, node.bounds, 0, localFar)) return;
            if (node.count) candidates.insert(candidates.end(), tree->starts.begin() + node.begin,
                tree->starts.begin() + node.begin + node.count);
            else { self(self, node.left); self(self, node.right); }
        };
        if (!tree->nodes.empty()) visit(visit, 0);
        if (candidates.size() > 1) std::sort(candidates.begin(), candidates.end());
    }
    std::shared_ptr<BufferAttribute> uv, uv1, normal;
    bool fetchedHitAttrs = false;
    size_t candidate = 0;
    for (double i = accelerated ? (candidates.empty() ? end : candidates[0]) : start; i < end;
         i = accelerated ? (++candidate < candidates.size() ? candidates[candidate] : end) : i + 3) {
        ++trianglesTested;
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
        if (!fetchedHitAttrs) {
            uv = geometry->getAttribute("uv");
            uv1 = geometry->getAttribute("uv1");
            normal = geometry->getAttribute("normal");
            fetchedHitAttrs = true;
        }
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
