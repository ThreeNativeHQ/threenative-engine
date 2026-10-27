#pragma once
// The render projection's decisions for one frame (PRD-519 phase 1, PRD-518 phase 2), ported from
// packages/core/src/projection-plan.ts (scanProjection), projection-apply.ts (the member verdicts)
// and projection-skinned.ts (isSimilarityTransform): whether the frame projects at all or why not,
// which objects batch on which lane, and why every other object keeps a draw of its own.
//
// A fresh decision, as a projection's first reconcile makes it: the streamed-geometry watch and
// the material-drift checks of later frames are not carried. The native scene has no sprites,
// points, lines, LODs, BatchedMeshes, custom depth materials, draw ranges,
// indirect geometries or vertex-displacing materials, so those reasons never arise here.
#include <algorithm>
#include <bit>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <map>
#include <memory>
#include <string>
#include <vector>
#include <unordered_map>
#include <atomic>
#include <typeinfo>

#include "engine/animation/skinning/palette.h"
#include "engine/animation/skinning/skeleton.h"
#include "engine/scene/geometry.h"
#include "engine/scene/lights.h"
#include "engine/scene/material.h"
#include "engine/scene/nodes.h"

namespace tn::engine {

/**
 * Geometries whose layout and bytes are equal (projection::contentClassOf). Agents build a geometry per
 * copy, so the instanced lanes key on this class rather than on the geometry, and `canonical` is the
 * member every batch of the class draws. Held by its members; the registry keeps it weakly.
 */
struct GeometryContentClass {
    std::weak_ptr<BufferGeometry> canonical;
    const BufferGeometry* drawn = nullptr;  // canonical's address while it lives, for identity compares
};

} // namespace tn::engine

namespace tn::engine::projection {

inline constexpr int kMinBatchMembers = 4;        // MIN_BATCH_MEMBERS
inline constexpr int kSkinnedFloorWeight = 26;     // SKINNED_FLOOR_WEIGHT
inline constexpr double kWorthwhileDrawRatio = 0.75;
inline constexpr double kBatchGrowth = 1.5;
inline constexpr int kBatchMinSlots = 16;
inline constexpr double kPaletteBindingBytes = 134217728;

struct Decision {
    bool projecting = false;
    std::string reasonCode;          // "projected", or why the frame declined
    int sourceRenderables = 0;
    int projectedObjects = 0;
    int instancedBatches = 0;        // instanced and uniform groups: one InstancedMesh each
    int materialBatches = 0;         // differing geometries under one material: one BatchedMesh each
    int skinnedBatches = 0;
    int exactObjects = 0;
    std::map<std::string, int> exact; // reason -> objects keeping their own draw for it
    // A notWorthwhile decline's cause, as core's declineCause names it: "uniqueGeometry" or
    // "uniqueMaterial", and the meshes left drawing alone for it. Empty otherwise.
    std::string cause;
    int causeMeshes = 0;
    // Per object: the lane that batched it ("instanced", "uniform", "material", "skinned") or the
    // reason it keeps its own draw. Declined frames record nothing here.
    std::map<const Object3D*, std::string> verdict;
};

// isSimilarityTransform comes from the skinned palette (engine/animation/skinning/palette.h).
using tn::engine::isSimilarityTransform;

namespace detail {

// geometryLaneReason: the reasons a native geometry can carry.
inline const char* geometryLaneReason(const BufferGeometry& g) {
    if (!g.attributes.count("position")) return "unsupportedGeometry";
    if (!g.morphPositions.empty() || !g.morphNormals.empty()) return "morph";
    return nullptr;
}

inline int itemSize(const BufferGeometry& g, const char* name) {
    const auto found = g.attributes.find(name);
    return found == g.attributes.end() ? 0 : found->second->itemSize;
}

// laneReasonOf for a mesh that is not skinned.
inline const char* meshLaneReason(const Mesh& mesh) {
    if (dynamic_cast<const InstancedMesh*>(&mesh)) return "instanced";
    if (!mesh.geometry) return "unsupportedGeometry";
    if (const char* reason = geometryLaneReason(*mesh.geometry)) return reason;
    if (mesh.renderOrder() != 0) return "renderOrder";
    if (!mesh.materials.empty()) return "multiMaterial";
    if (!mesh.material) return "unsupportedGeometry";
    if (mesh.material->transparent) return "transparent";
    return nullptr;
}

// skinnedLaneReason: a material-owned position node keeps the authored skinning draw.
inline const char* skinnedLaneReason(const SkinnedMesh& rig) {
    if (!rig.geometry) return "unsupportedGeometry";
    if (const char* reason = geometryLaneReason(*rig.geometry)) return reason;
    if (rig.renderOrder() != 0) return "renderOrder";
    if (!rig.material) return "unsupportedGeometry";
    if (rig.material->positionNode || rig.material->nodes.positionNode)
        return "skinnedMaterialBlocked";
    if (rig.material->transparent) return "transparent";
    if (!rig.skeleton || rig.skeleton->bones.empty() || itemSize(*rig.geometry, "normal") != 3 ||
        itemSize(*rig.geometry, "skinIndex") != 4 || itemSize(*rig.geometry, "skinWeight") != 4)
        return "skinned";
    return nullptr;
}

// What decide reads off a rig on every frame, outside the structure stamp (PRD-613): its lane reason (material
// nodes, transparency, render order, skeleton) and whether its world matrix is a similarity and not mirrored.
// A held decision is judged again the frame this changes for any of its rigs.
inline uintptr_t rigLaneKey(const SkinnedMesh& rig) {
    const double* e = rig.matrixWorld.elements.data();
    return reinterpret_cast<uintptr_t>(skinnedLaneReason(rig)) * 4 + (isSimilarityTransform(e) ? 2 : 0) +
           (rig.matrixWorld.determinant() > 0 ? 1 : 0);
}

// batchFlagsOf: layers, castShadow, receiveShadow, frustumCulled in one key.
inline double batchFlags(const Mesh& m) {
    return double(m.layers().mask) * 8 + (m.castShadow() ? 4 : 0) + (m.receiveShadow() ? 2 : 0) + (m.frustumCulled ? 1 : 0);
}

// uniformSignatureOf, as equality: two materials share a uniform group when every property but the
// base colour (and name/id/version, which the signature skips) is the same.
inline bool sameUniforms(const Material& a, const Material& b) {
    const auto eq = [](const Color& x, const Color& y) { return (x.r == y.r) & (x.g == y.g) & (x.b == y.b); };
    return a.type == b.type && a.transparent == b.transparent &&
           a.depthTest == b.depthTest && a.depthWrite == b.depthWrite && a.colorWrite == b.colorWrite && a.forceSinglePass == b.forceSinglePass &&
           a.polygonOffset == b.polygonOffset && a.polygonOffsetFactor == b.polygonOffsetFactor &&
           a.polygonOffsetUnits == b.polygonOffsetUnits &&
           a.side == b.side && a.visible == b.visible &&
           a.toneMapped == b.toneMapped && a.fog == b.fog &&
           ((a.opacity == b.opacity) & (a.alphaTest == b.alphaTest) & (a.alphaHash == b.alphaHash) & eq(a.emissive, b.emissive) &
            (a.emissiveIntensity == b.emissiveIntensity) & (a.roughness == b.roughness) &
            (a.metalness == b.metalness) & eq(a.specular, b.specular) & (a.shininess == b.shininess) &
            (a.ior == b.ior) & (a.specularIntensity == b.specularIntensity) & eq(a.specularColor, b.specularColor) &
            (a.clearcoat == b.clearcoat) & (a.clearcoatRoughness == b.clearcoatRoughness) &
            (a.clearcoatNormalScale.x == b.clearcoatNormalScale.x) & (a.clearcoatNormalScale.y == b.clearcoatNormalScale.y) &
            (a.sheen == b.sheen) & (a.transmission == b.transmission) &
            (a.iridescence == b.iridescence) & (a.anisotropy == b.anisotropy) & (a.dispersion == b.dispersion) &
            (a.envMapIntensity == b.envMapIntensity) & (a.normalScale.x == b.normalScale.x) &
            (a.normalScale.y == b.normalScale.y) & (a.aoMapIntensity == b.aoMapIntensity) & (a.bumpScale == b.bumpScale)) &&
           a.positionNode == b.positionNode && a.nodes == b.nodes &&
           a.vertexColors == b.vertexColors && a.flatShading == b.flatShading && a.twoSidedFoliage == b.twoSidedFoliage &&
           a.roughDiffuse == b.roughDiffuse && a.maps == b.maps;
}

// Bumped at the start of every prepare. No material changes while one runs, so a hash computed in it
// holds until it ends; a version alone would miss three's plain writes (roughness = x) that bump none.
inline uint64_t& uniformEpoch() {
    static uint64_t epoch = 1;
    return epoch;
}

inline std::atomic<uint64_t>& uniformHashCount() {
    static std::atomic<uint64_t> count{0};
    return count;
}

// Base colour travels per instance. Hash every other equality input; equality still resolves collisions.
inline std::size_t uniformHash(const Material& m) {
    if (m.uniformHashEpoch_ == uniformEpoch()) return m.cachedUniformHash_;
    uniformHashCount().fetch_add(1, std::memory_order_relaxed);
    std::size_t h = 0;
    const auto mix = [&](uint64_t v) { h = (h ^ v) * 0x9e3779b1u; };
    for (double v : {double(m.type),
                     double(m.transparent),
                     m.opacity,
                     m.alphaTest,
                     double(m.alphaHash),
                     double(m.depthTest),
                     double(m.depthWrite),
                     double(m.colorWrite),
                     double(m.forceSinglePass),
                     double(m.polygonOffset),
                     m.polygonOffsetFactor,
                     m.polygonOffsetUnits,
                     double(m.side),
                     double(m.visible),
                     double(m.toneMapped),
                     m.emissive.r,
                     m.emissive.g,
                     m.emissive.b,
                     m.emissiveIntensity,
                     m.roughness,
                     m.metalness,
                     m.specular.r,
                     m.specular.g,
                     m.specular.b,
                     m.shininess,
                     m.ior,
                     m.specularIntensity,
                     m.specularColor.r,
                     m.specularColor.g,
                     m.specularColor.b,
                     m.clearcoat,
                     m.clearcoatRoughness,
                     m.clearcoatNormalScale.x,
                     m.clearcoatNormalScale.y,
                     m.sheen,
                     m.transmission,
                     m.iridescence,
                     m.anisotropy,
                     m.dispersion,
                     m.envMapIntensity,
                     double(m.fog),
                     double(m.vertexColors),
                     double(m.flatShading),
                     double(m.twoSidedFoliage),
                     double(m.roughDiffuse),
                     m.normalScale.x,
                     m.normalScale.y,
                     m.aoMapIntensity,
                     m.bumpScale}) {
        const auto bits = std::bit_cast<uint64_t>(v == 0 ? 0.0 : v); // +0 and -0 compare equal
        mix(bits ^ (bits >> 32));                                    // both halves matter on wasm32
    }
    mix(reinterpret_cast<std::uintptr_t>(m.positionNode.get()));
    for (const auto* node : m.nodes.pointers())
        mix(reinterpret_cast<std::uintptr_t>(node));
    for (const auto& [name, texture] : m.maps) {
        mix(std::hash<std::string>{}(name));
        mix(reinterpret_cast<std::uintptr_t>(texture.get()));
    }
    m.cachedUniformHash_ = h;
    m.uniformHashEpoch_ = uniformEpoch();
    return h;
}

// geometrySignatureOf: indexed or not, then each attribute's name, item size and normalized flag.
inline std::string geometrySignature(const BufferGeometry& g) {
    std::string signature = g.index ? "i" : "n";
    for (const auto& [name, attribute] : g.attributes) // std::map: sorted by name, as the TS sorts
        signature += " " + name + ":" + std::to_string(attribute->itemSize) + ":" + (attribute->normalized ? "1" : "0");
    return signature;
}

struct Group {
    std::vector<Mesh*> members;
};

inline constexpr uint64_t kFnvBasis = 0xcbf29ce484222325ull;
inline constexpr uint64_t kFnvPrime = 0x100000001b3ull;

// What a change to a geometry's data moves: its revision, and each attribute's store, version and length.
inline uint64_t contentVersionKey(const BufferGeometry& g) {
    uint64_t h = kFnvBasis ^ g.revision();
    const auto mix = [&](uint64_t v) { h = (h ^ v) * kFnvPrime; };
    const auto attribute = [&](const BufferAttribute* a) {
        if (!a) return mix(0);
        mix(reinterpret_cast<std::uintptr_t>(a->store.get()));
        mix(a->version());
        mix(a->store->byteLength());
    };
    for (const auto& [name, a] : g.attributes) attribute(a.get());
    attribute(g.index.get());
    return h;
}

// An instanced geometry's draw count, a per-instance attribute and a draw range are not in the bytes
// compared, and a morph target is not drawn by the instanced lanes: each keeps a class of its own.
inline bool contentMergeable(const BufferGeometry& g) {
    if (g.instanced || !g.morphPositions.empty() || !g.morphNormals.empty() || g.drawRange.start != 0 ||
        std::isfinite(g.drawRange.count))
        return false;
    return std::all_of(g.attributes.begin(), g.attributes.end(),
                       [](const auto& entry) { return entry.second && !entry.second->perInstance; });
}

inline uint64_t hashStore(uint64_t h, const BufferStore& store) {
    const uint64_t n = store.byteLength();
    if (n == 0) return h;
    const std::byte* p = store.data();
    uint64_t i = 0;
    for (; i + 8 <= n; i += 8) {
        uint64_t word;
        std::memcpy(&word, p + i, 8);
        h = (h ^ word) * kFnvPrime;
    }
    for (; i < n; ++i) h = (h ^ uint64_t(p[i])) * kFnvPrime;
    return h;
}

// FNV-1a over the layout (index, then each attribute's name, scalar, item size and normalization) and bytes.
inline uint64_t contentHash(const BufferGeometry& g) {
    uint64_t h = kFnvBasis;
    const auto mix = [&](uint64_t v) { h = (h ^ v) * kFnvPrime; };
    const auto attribute = [&](const BufferAttribute& a) {
        mix(uint64_t(a.store->scalar()));
        mix(uint64_t(a.itemSize));
        mix(a.normalized ? 1 : 0);
        mix(a.store->byteLength());
        h = hashStore(h, *a.store);
    };
    mix(g.index ? 1 : 0);
    if (g.index) attribute(*g.index);
    for (const auto& [name, a] : g.attributes) {
        mix(std::hash<std::string>{}(name));
        attribute(*a);
    }
    return h;
}

// The full byte compare behind an equal hash: no false merge.
inline bool sameContent(const BufferGeometry& a, const BufferGeometry& b) {
    const auto same = [](const BufferAttribute& x, const BufferAttribute& y) {
        const uint64_t n = x.store->byteLength();
        return x.itemSize == y.itemSize && x.normalized == y.normalized && x.store->scalar() == y.store->scalar() &&
               n == y.store->byteLength() && (n == 0 || std::memcmp(x.store->data(), y.store->data(), n) == 0);
    };
    if (bool(a.index) != bool(b.index) || a.attributes.size() != b.attributes.size()) return false;
    if (a.index && !same(*a.index, *b.index)) return false;
    for (auto x = a.attributes.begin(), y = b.attributes.begin(); x != a.attributes.end(); ++x, ++y)
        if (x->first != y->first || !same(*x->second, *y->second)) return false;
    return true;
}

// Whether a class's canonical geometry is alive, still in it and unchanged since it was classed.
inline bool canonicalHolds(const GeometryContentClass& cls, uint64_t epoch) {
    const auto canonical = cls.canonical.lock();
    return canonical && canonical->contentClass_.get() == &cls &&
           (canonical->contentEpoch_ == epoch || contentVersionKey(*canonical) == canonical->contentKey_);
}

// Content hash -> the classes of that hash. Weak: a class lives while a member geometry holds it.
inline std::unordered_map<uint64_t, std::vector<std::weak_ptr<GeometryContentClass>>>& contentClasses() {
    static std::unordered_map<uint64_t, std::vector<std::weak_ptr<GeometryContentClass>>> classes;
    return classes;
}

// The class whose bytes equal this geometry's, or a new one it is canonical for.
inline std::shared_ptr<GeometryContentClass> classify(const std::shared_ptr<BufferGeometry>& geometry, uint64_t epoch) {
    auto& classes = contentClasses();
    // Unique content (a streamed terrain tile) would leave a dead entry per hash: sweep when the table doubles.
    static std::size_t sweepAt = 64;
    if (classes.size() > sweepAt) {
        for (auto it = classes.begin(); it != classes.end();) {
            std::erase_if(it->second, [](const auto& weak) { return weak.expired(); });
            it = it->second.empty() ? classes.erase(it) : std::next(it);
        }
        sweepAt = std::max<std::size_t>(64, classes.size() * 2);
    }
    auto& bucket = classes[contentHash(*geometry)];
    std::erase_if(bucket, [](const auto& weak) { return weak.expired(); });
    for (const auto& weak : bucket) {
        auto cls = weak.lock();
        if (canonicalHolds(*cls, epoch) && sameContent(*cls->canonical.lock(), *geometry)) return cls;
    }
    auto cls = std::make_shared<GeometryContentClass>();
    cls->canonical = geometry;
    cls->drawn = geometry.get();
    bucket.push_back(cls);
    return cls;
}

} // namespace detail

/**
 * The content class of `geometry`, port of core's resolveGeometryContent (projection-plan.ts). Resolved
 * once per prepare (uniformEpoch): a geometry whose revision, stores and versions hold keeps its class;
 * one whose data moved leaves for a class of its own and is never hashed again; a new one is hashed and
 * byte-compared against the classes of its hash. A class whose canonical geometry died or moved is
 * drawn from the first unchanged member that resolves to it.
 */
inline const GeometryContentClass& contentClassOf(const std::shared_ptr<BufferGeometry>& geometry) {
    BufferGeometry& g = *geometry;
    const uint64_t epoch = detail::uniformEpoch();
    if (g.contentEpoch_ == epoch && g.contentClass_) return *g.contentClass_;
    g.contentEpoch_ = epoch;
    const uint64_t key = detail::contentVersionKey(g);
    if (!g.contentClass_ || key != g.contentKey_) {
        if (g.contentStreamed_) {
        } else if (g.contentClass_ || !detail::contentMergeable(g)) {
            g.contentClass_ = std::make_shared<GeometryContentClass>();
            g.contentStreamed_ = true;
        } else {
            g.contentClass_ = detail::classify(geometry, epoch);
        }
        g.contentKey_ = key;
    }
    GeometryContentClass& cls = *g.contentClass_;
    if (cls.drawn != &g && !detail::canonicalHolds(cls, epoch)) {
        cls.canonical = geometry;
        cls.drawn = &g;
    }
    return cls;
}

/** The geometry a batch draws for every member whose geometry has `geometry`'s bytes. */
inline std::shared_ptr<BufferGeometry> canonicalGeometry(const std::shared_ptr<BufferGeometry>& geometry) {
    return contentClassOf(geometry).canonical.lock();
}

// One number that changes whenever anything the projection's stability proof reads off the engine
// changes (projection-stability.ts): the walk order, each node's visibility, and for a mesh its
// geometry, material, flags, render order and layer mask. It walks the way that proof walks, so a
// light or LOD hides its children. A hash, so a match is a claim at 2^-53 and a mismatch only sends
// the caller to its own exact walk.
inline double structureStamp(Object3D& root) {
    uint64_t h = 0xcbf29ce484222325ULL;
    const auto mix = [&h](uint64_t v) {
        h = (h ^ v) * 0x100000001b3ULL;
        h ^= h >> 29;
    };
    std::vector<const Object3D*> stack(root.children.rbegin(), root.children.rend());
    while (!stack.empty()) {
        const Object3D* object = stack.back();
        stack.pop_back();
        const auto* mesh = dynamic_cast<const Mesh*>(object);
        mix(object->id() * 2 + (object->visible() ? 1 : 0));
        if (mesh != nullptr) {
            mix(reinterpret_cast<uintptr_t>(mesh->geometry.get()));
            mix(reinterpret_cast<uintptr_t>(mesh->material.get()));
            mix(static_cast<uint64_t>(mesh->castShadow()) | static_cast<uint64_t>(mesh->receiveShadow()) << 1 |
                static_cast<uint64_t>(mesh->frustumCulled) << 2);
            mix(static_cast<uint64_t>(static_cast<int64_t>(mesh->renderOrder())));
            mix(std::bit_cast<uint64_t>(mesh->layers().mask));
        }
        mix(object->children.size());
        if (object->isLight() || object->type() == "LOD") continue;
        for (auto it = object->children.rbegin(); it != object->children.rend(); ++it) stack.push_back(*it);
    }
    return static_cast<double>(h & ((1ULL << 53) - 1));
}

/**
 * One frame's projection decision for `scene`, as a fresh SceneRenderProjection reconcile makes it.
 * `skinnedVerdictsOnly` records a per-object verdict for rigs alone: the renderer asks no other object, and
 * a verdict per cube costs a map node apiece. Every count and reason is the same either way.
 */
inline Decision decide(Object3D& scene, int minMeshes = 200, bool skinnedVerdictsOnly = false) {
    using namespace detail;
    Decision d;
    std::string blocked;
    std::vector<Mesh*> eligible;
    std::vector<SkinnedMesh*> skinned;
    std::vector<std::pair<const Object3D*, std::string>> exactLane;
    // meshLaneReason for a plain Mesh, with the geometry's own verdict kept for the run of meshes sharing it.
    const BufferGeometry* laneGeometry = nullptr;
    const char* laneGeometryReason = nullptr;
    const auto plainReason = [&](const Mesh& m) -> const char* {
        if (!m.geometry) return "unsupportedGeometry";
        if (m.geometry.get() != laneGeometry) {
            laneGeometry = m.geometry.get();
            laneGeometryReason = geometryLaneReason(*laneGeometry);
        }
        if (laneGeometryReason) return laneGeometryReason;
        if (m.renderOrder() != 0) return "renderOrder";
        if (!m.materials.empty()) return "multiMaterial";
        if (!m.material) return "unsupportedGeometry";
        return m.material->transparent ? "transparent" : nullptr;
    };
    // walkProjection: depth first, children in order; a light's children are not visited.
    std::vector<Object3D*> stack(scene.children.rbegin(), scene.children.rend());
    const std::type_info* classType = nullptr;
    bool classMesh = false, classRig = false;
    while (!stack.empty()) {
        Object3D* object = stack.back();
        stack.pop_back();
        if (skinnedVerdictsOnly && object->skipsGpuJointSubtree()) {
            ++Object3D::gpuProjectionVisits_;
            continue;
        }
        // A plain Mesh is neither a light, a rig nor an instanced mesh: one type check replaces the casts.
        // Any other node (a bone, a group, a rig) is one of a few classes that arrive in runs, so the
        // casts run once per change of class and the run reuses their answer.
        const std::type_info& type = typeid(*object);
        const bool plain = type == typeid(Mesh);
        if (!plain && &type != classType) {
            classType = &type;
            classMesh = dynamic_cast<Mesh*>(object) != nullptr;
            classRig = dynamic_cast<SkinnedMesh*>(object) != nullptr;
        }
        auto* mesh = plain || classMesh ? static_cast<Mesh*>(object) : nullptr;
        if (blocked.empty() && mesh && mesh->onBeforeRender) blocked = "renderHook";
        if (!plain && object->isLight()) continue;
        if (mesh) {
            ++d.sourceRenderables;
            if (auto* rig = classRig && !plain ? static_cast<SkinnedMesh*>(mesh) : nullptr) {
                const auto gpu = rig->gpuSkinValidity.lock();
                if (skinnedVerdictsOnly && gpu && *gpu) skinned.push_back(rig);
                else if (const char* reason = skinnedLaneReason(*rig)) exactLane.emplace_back(rig, reason);
                else skinned.push_back(rig);
            } else if (const char* reason = plain ? plainReason(*mesh) : meshLaneReason(*mesh)) {
                exactLane.emplace_back(mesh, reason);
            } else {
                eligible.push_back(mesh);
            }
        }
        for (auto it = object->children.rbegin(); it != object->children.rend(); ++it) stack.push_back(*it);
    }
    if (!blocked.empty()) {
        d.reasonCode = blocked;
        return d;
    }
    if (int(eligible.size()) + int(skinned.size()) * kSkinnedFloorWeight < minMeshes) {
        d.reasonCode = "belowMeshFloor";
        return d;
    }

    // groupEligibleMeshes: by geometry content class, material and flags (rigs by their geometry and
    // bone count); the members of groups below the floor then try a uniform group (same content,
    // uniforms but colour), and what no uniform group claims tries a material group (same material,
    // any geometry of one layout).
    using Key = std::tuple<const void*, const void*, double>;
    std::vector<Key> groupOrder, skinnedOrder;
    std::map<Key, Group> groups, skinnedGroups;
    const Key* runKey = nullptr;  // the previous mesh's key and group: a run of one key skips the map
    Group* runGroup = nullptr;
    for (Mesh* mesh : eligible) {
        const Key key{&contentClassOf(mesh->geometry), mesh->material.get(), batchFlags(*mesh)};
        if (runGroup && key == *runKey) {
            runGroup->members.push_back(mesh);
            continue;
        }
        const auto [at, added] = groups.try_emplace(key);
        if (added) groupOrder.push_back(key);
        at->second.members.push_back(mesh);
        runKey = &at->first;  // std::map nodes keep their address
        runGroup = &at->second;
    }
    for (SkinnedMesh* rig : skinned) {
        const Key key{rig->geometry.get(), rig->material.get(), batchFlags(*rig) * 65536 + double(rig->skeleton->bones.size())};
        if (!skinnedGroups.count(key)) skinnedOrder.push_back(key);
        skinnedGroups[key].members.push_back(rig);
    }
    struct UniformGroup {
        const void* content;
        const Material* material; // the first member's: the signature it shares
        double flags;
        std::vector<Mesh*> members;
    };
    std::vector<UniformGroup> uniformGroups;
    std::unordered_map<std::size_t, std::vector<std::size_t>> uniformCandidates;
    std::map<const Mesh*, std::size_t> uniformOf;
    for (const Key& key : groupOrder) {
        Group& group = groups[key];
        if (int(group.members.size()) >= kMinBatchMembers) continue;
        const void* content = std::get<0>(key);
        for (Mesh* mesh : group.members) {
            std::size_t found = uniformGroups.size();
            const auto hash = uniformHash(*mesh->material) ^ std::hash<const void*>{}(content) ^
                              std::hash<double>{}(batchFlags(*mesh));
            auto& candidates = uniformCandidates[hash];
            for (std::size_t i : candidates) {
                const UniformGroup& u = uniformGroups[i];
                if (u.content == content && u.flags == batchFlags(*mesh) && sameUniforms(*u.material, *mesh->material)) {
                    found = i;
                    break;
                }
            }
            if (found == uniformGroups.size()) {
                candidates.push_back(found);
                uniformGroups.push_back({content, mesh->material.get(), batchFlags(*mesh), {}});
            }
            uniformGroups[found].members.push_back(mesh);
            uniformOf[mesh] = found;
        }
    }
    const auto uniformClaimed = [&](const Mesh* mesh) {
        const auto found = uniformOf.find(mesh);
        return found != uniformOf.end() && int(uniformGroups[found->second].members.size()) >= kMinBatchMembers;
    };
    using MaterialKey = std::tuple<const void*, double, std::string>;
    std::vector<MaterialKey> materialOrder;
    std::map<MaterialKey, Group> materialGroups;
    for (const Key& key : groupOrder) {
        Group& group = groups[key];
        if (int(group.members.size()) >= kMinBatchMembers) continue;
        for (Mesh* mesh : group.members) {
            if (uniformClaimed(mesh)) continue;
            const MaterialKey mk{mesh->material.get(), batchFlags(*mesh), geometrySignature(*mesh->geometry)};
            if (!materialGroups.count(mk)) materialOrder.push_back(mk);
            materialGroups[mk].members.push_back(mesh);
        }
    }

    // predictDraws, and the draw-ratio rule.
    int predicted = int(exactLane.size());
    std::map<const Mesh*, bool> materialClaimed;
    for (const UniformGroup& u : uniformGroups)
        if (int(u.members.size()) >= kMinBatchMembers) predicted += 1;
    for (const MaterialKey& mk : materialOrder) {
        const Group& group = materialGroups[mk];
        if (int(group.members.size()) < kMinBatchMembers) continue;
        for (Mesh* mesh : group.members) materialClaimed[mesh] = true;
        predicted += int(group.members.size());
    }
    for (const Key& key : skinnedOrder) {
        const Group& group = skinnedGroups[key];
        predicted += int(group.members.size()) < kMinBatchMembers ? int(group.members.size()) : 1;
    }
    for (const Key& key : groupOrder) {
        const Group& group = groups[key];
        if (int(group.members.size()) >= kMinBatchMembers) {
            predicted += 1;
            continue;
        }
        for (Mesh* mesh : group.members)
            if (!materialClaimed.count(mesh) && !uniformClaimed(mesh)) predicted += 1;
    }
    if (predicted > d.sourceRenderables * kWorthwhileDrawRatio) {
        d.reasonCode = "notWorthwhile";
        // declineCause: a mesh drawing alone whose content class has too few meshes in the scene is
        // held back by its geometry, one whose class has enough by its material or flags.
        std::unordered_map<const void*, int> sizes;
        for (Mesh* mesh : eligible) ++sizes[&contentClassOf(mesh->geometry)];
        int geometry = 0, material = 0;
        for (const Key& key : groupOrder) {
            const Group& group = groups[key];
            if (int(group.members.size()) >= kMinBatchMembers) continue;
            for (Mesh* mesh : group.members) {
                if (uniformClaimed(mesh)) continue;
                ++(sizes[std::get<0>(key)] >= kMinBatchMembers ? material : geometry);
            }
        }
        if (geometry + material > 0) {
            d.cause = geometry >= material ? "uniqueGeometry" : "uniqueMaterial";
            d.causeMeshes = std::max(geometry, material);
        }
        return d;
    }

    // apply: below-floor members keep their draws; each lane's members batch or name their refusal.
    d.projecting = true;
    d.reasonCode = "projected";
    const auto keep = [&](const Object3D* object, const std::string& reason) {
        exactLane.emplace_back(object, reason);
    };
    for (const Key& key : skinnedOrder)
        if (int(skinnedGroups[key].members.size()) < kMinBatchMembers)
            for (Mesh* rig : skinnedGroups[key].members) keep(rig, "tooFewToBatch");
    for (const Key& key : groupOrder) {
        const Group& group = groups[key];
        if (int(group.members.size()) >= kMinBatchMembers) continue;
        for (Mesh* mesh : group.members)
            if (!materialClaimed.count(mesh) && !uniformClaimed(mesh)) keep(mesh, "tooFewToBatch");
    }
    const auto project = [&](const Object3D* object, const char* lane) {
        if (!skinnedVerdictsOnly || (lane[0] == 's' && lane[1] == 'k')) d.verdict[object] = lane;
        ++d.projectedObjects;
    };
    for (const UniformGroup& u : uniformGroups) {
        if (int(u.members.size()) < kMinBatchMembers) continue;
        ++d.instancedBatches;
        for (Mesh* mesh : u.members) project(mesh, "uniform");
    }
    for (const Key& key : groupOrder) {
        const Group& group = groups[key];
        if (int(group.members.size()) < kMinBatchMembers) continue;
        ++d.instancedBatches;
        for (Mesh* mesh : group.members) project(mesh, "instanced");
    }
    for (const MaterialKey& mk : materialOrder) {
        const Group& group = materialGroups[mk];
        if (int(group.members.size()) < kMinBatchMembers) continue;
        int viable = 0;
        for (Mesh* mesh : group.members) viable += mesh->matrixWorld.determinant() > 0 ? 1 : 0;
        const bool attempted = viable >= kMinBatchMembers;
        if (attempted) ++d.materialBatches;
        for (Mesh* mesh : group.members) {
            const bool mirrored = mesh->matrixWorld.determinant() <= 0;
            if (attempted && !mirrored) project(mesh, "material");
            else keep(mesh, mirrored ? "negativeScale" : "tooFewToBatch");
        }
    }
    for (const Key& key : skinnedOrder) {
        const Group& group = skinnedGroups[key];
        if (int(group.members.size()) < kMinBatchMembers) continue;
        ++d.skinnedBatches;
        const auto* first = static_cast<const SkinnedMesh*>(group.members.front());
        const double rigBytes = double(first->skeleton->bones.size()) * 64;
        const int capacity = int(std::min(std::max(double(kBatchMinSlots), std::ceil(double(group.members.size()) * kBatchGrowth)),
                                          std::floor(kPaletteBindingBytes / rigBytes)));
        int used = 0;
        for (Mesh* rig : group.members) {
            const double* e = rig->matrixWorld.elements.data();
            if (!isSimilarityTransform(e)) {
                keep(rig, rig->matrixWorld.determinant() <= 0 ? "negativeScale" : "nonUniformScale");
                continue;
            }
            if (used >= capacity) {
                keep(rig, "batchOverflow");
                continue;
            }
            ++used;
            project(rig, "skinned");
        }
    }
    d.exactObjects = int(exactLane.size());
    for (const auto& [object, reason] : exactLane) {
        ++d.exact[reason];
        if (!skinnedVerdictsOnly || dynamic_cast<const SkinnedMesh*>(object)) d.verdict[object] = reason;
    }
    return d;
}

} // namespace tn::engine::projection
