#pragma once
// The render projection's decisions for one frame (PRD-519 phase 1, PRD-518 phase 2), ported from
// packages/core/src/projection-plan.ts (scanProjection), projection-apply.ts (the member verdicts)
// and projection-skinned.ts (isSimilarityTransform): whether the frame projects at all or why not,
// which objects batch on which lane, and why every other object keeps a draw of its own.
//
// A fresh decision, as a projection's first reconcile makes it: the streamed-geometry watch and
// the material-drift checks of later frames are not carried. The native scene has no sprites,
// points, lines, LODs, BatchedMeshes, multi-materials, custom depth materials, draw ranges,
// indirect geometries or vertex-displacing materials, so those reasons never arise here.
#include <bit>
#include <cmath>
#include <cstdint>
#include <map>
#include <string>
#include <vector>
#include <unordered_map>
#include <atomic>

#include "engine/animation/skinning/palette.h"
#include "engine/animation/skinning/skeleton.h"
#include "engine/scene/geometry.h"
#include "engine/scene/lights.h"
#include "engine/scene/material.h"
#include "engine/scene/nodes.h"

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
    // Per object: the lane that batched it ("instanced", "uniform", "material", "skinned") or the
    // reason it keeps its own draw. Declined frames record nothing here.
    std::map<const Object3D*, std::string> verdict;
};

// isSimilarityTransform comes from the skinned palette (engine/animation/skinning/palette.h).
using tn::engine::isSimilarityTransform;

namespace detail {

inline bool isLight(const Object3D& o) { return dynamic_cast<const Light*>(&o) != nullptr; }

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

// batchFlagsOf: layers, castShadow, receiveShadow, frustumCulled in one key.
inline double batchFlags(const Mesh& m) {
    return double(m.layers().mask) * 8 + (m.castShadow() ? 4 : 0) + (m.receiveShadow() ? 2 : 0) + (m.frustumCulled ? 1 : 0);
}

// uniformSignatureOf, as equality: two materials share a uniform group when every property but the
// base colour (and name/id/version, which the signature skips) is the same.
inline bool sameUniforms(const Material& a, const Material& b) {
    const auto eq = [](const Color& x, const Color& y) { return (x.r == y.r) & (x.g == y.g) & (x.b == y.b); };
    return a.type == b.type && a.transparent == b.transparent &&
           a.depthTest == b.depthTest && a.depthWrite == b.depthWrite && a.forceSinglePass == b.forceSinglePass &&
           a.polygonOffset == b.polygonOffset && a.polygonOffsetFactor == b.polygonOffsetFactor &&
           a.polygonOffsetUnits == b.polygonOffsetUnits &&
           a.side == b.side && a.visible == b.visible &&
           a.toneMapped == b.toneMapped && a.fog == b.fog &&
           ((a.opacity == b.opacity) & (a.alphaTest == b.alphaTest) & eq(a.emissive, b.emissive) &
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
           a.vertexColors == b.vertexColors && a.flatShading == b.flatShading &&
           a.maps == b.maps;
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
                     double(m.depthTest),
                     double(m.depthWrite),
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

} // namespace detail

/** One frame's projection decision for `scene`, as a fresh SceneRenderProjection reconcile makes it. */
inline Decision decide(Object3D& scene, int minMeshes = 200) {
    using namespace detail;
    Decision d;
    std::string blocked;
    std::vector<Mesh*> eligible;
    std::vector<SkinnedMesh*> skinned;
    std::vector<std::pair<const Object3D*, std::string>> exactLane;
    // walkProjection: depth first, children in order; a light's children are not visited.
    std::vector<Object3D*> stack(scene.children.rbegin(), scene.children.rend());
    while (!stack.empty()) {
        Object3D* object = stack.back();
        stack.pop_back();
        auto* mesh = dynamic_cast<Mesh*>(object);
        if (blocked.empty() && mesh && mesh->onBeforeRender) blocked = "renderHook";
        if (isLight(*object)) continue;
        if (mesh) {
            ++d.sourceRenderables;
            if (auto* rig = dynamic_cast<SkinnedMesh*>(mesh)) {
                if (const char* reason = skinnedLaneReason(*rig)) exactLane.emplace_back(rig, reason);
                else skinned.push_back(rig);
            } else if (const char* reason = meshLaneReason(*mesh)) {
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

    // groupEligibleMeshes: by geometry, material and flags (rigs also by bone count); the members of
    // groups below the floor then try a uniform group (same geometry, uniforms but colour), and what
    // no uniform group claims tries a material group (same material, any geometry of one layout).
    using Key = std::tuple<const void*, const void*, double>;
    std::vector<Key> groupOrder, skinnedOrder;
    std::map<Key, Group> groups, skinnedGroups;
    for (Mesh* mesh : eligible) {
        const Key key{mesh->geometry.get(), mesh->material.get(), batchFlags(*mesh)};
        if (!groups.count(key)) groupOrder.push_back(key);
        groups[key].members.push_back(mesh);
    }
    for (SkinnedMesh* rig : skinned) {
        const Key key{rig->geometry.get(), rig->material.get(), batchFlags(*rig) * 65536 + double(rig->skeleton->bones.size())};
        if (!skinnedGroups.count(key)) skinnedOrder.push_back(key);
        skinnedGroups[key].members.push_back(rig);
    }
    struct UniformGroup {
        const BufferGeometry* geometry;
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
        for (Mesh* mesh : group.members) {
            std::size_t found = uniformGroups.size();
            const auto hash = uniformHash(*mesh->material) ^ std::hash<const void*>{}(mesh->geometry.get()) ^
                              std::hash<double>{}(batchFlags(*mesh));
            auto& candidates = uniformCandidates[hash];
            for (std::size_t i : candidates) {
                const UniformGroup& u = uniformGroups[i];
                if (u.geometry == mesh->geometry.get() && u.flags == batchFlags(*mesh) && sameUniforms(*u.material, *mesh->material)) {
                    found = i;
                    break;
                }
            }
            if (found == uniformGroups.size()) {
                candidates.push_back(found);
                uniformGroups.push_back({mesh->geometry.get(), mesh->material.get(), batchFlags(*mesh), {}});
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
        d.verdict[object] = lane;
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
        d.verdict[object] = reason;
    }
    return d;
}

} // namespace tn::engine::projection
