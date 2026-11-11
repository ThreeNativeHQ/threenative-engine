// SkinnedPalette (PRD-518 phases 2-3): the CPU state of `SkinnedBatch` from
// packages/core/src/projection-skinned.ts, method for method, over the ported Skeleton and
// SkinnedMesh. The multiply order is the TS one, -ffp-contract=off keeps it from being fused, and
// every store rounds exactly where the TS store rounds: the palette is float32, the bind scratch
// float64. No path owns a GPU buffer or a draw, and no path throws.

#include "engine/animation/skinning/palette.h"
#include "engine/scene/material.h"
#include "engine/shader/graph/graph.h"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>

namespace tn::engine {
namespace {

template <typename A, typename B, typename O>
void multiplyImpl(const A* a, std::size_t ao, const B* b, std::size_t bo, O* out, std::size_t o) {
    const double a00 = a[ao];
    const double a10 = a[ao + 1];
    const double a20 = a[ao + 2];
    const double a01 = a[ao + 4];
    const double a11 = a[ao + 5];
    const double a21 = a[ao + 6];
    const double a02 = a[ao + 8];
    const double a12 = a[ao + 9];
    const double a22 = a[ao + 10];
    const double a03 = a[ao + 12];
    const double a13 = a[ao + 13];
    const double a23 = a[ao + 14];
    // Affine only: the bottom row of every matrix here is (0, 0, 0, 1), which three guarantees for
    // bone and world matrices built from position/quaternion/scale.
    for (int column = 0; column < 4; column += 1) {
        const double b0 = b[bo + static_cast<std::size_t>(column) * 4];
        const double b1 = b[bo + static_cast<std::size_t>(column) * 4 + 1];
        const double b2 = b[bo + static_cast<std::size_t>(column) * 4 + 2];
        const double b3 = b[bo + static_cast<std::size_t>(column) * 4 + 3];
        const std::size_t at = o + static_cast<std::size_t>(column) * 4;
        out[at] = static_cast<O>(a00 * b0 + a01 * b1 + a02 * b2 + a03 * b3);
        out[at + 1] = static_cast<O>(a10 * b0 + a11 * b1 + a12 * b2 + a13 * b3);
        out[at + 2] = static_cast<O>(a20 * b0 + a21 * b1 + a22 * b2 + a23 * b3);
        out[at + 3] = static_cast<O>(b3);
    }
}

bool isIdentity(const double* elements) {
    for (int index = 0; index < 16; index += 1) {
        if (elements[index] != (index % 5 == 0 ? 1.0 : 0.0)) return false;
    }
    return true;
}

}  // namespace

bool isSimilarityTransform(const double* elements) {
    const double x0 = elements[0];
    const double x1 = elements[1];
    const double x2 = elements[2];
    const double y0 = elements[4];
    const double y1 = elements[5];
    const double y2 = elements[6];
    const double z0 = elements[8];
    const double z1 = elements[9];
    const double z2 = elements[10];
    const double xx = x0 * x0 + x1 * x1 + x2 * x2;
    const double yy = y0 * y0 + y1 * y1 + y2 * y2;
    const double zz = z0 * z0 + z1 * z1 + z2 * z2;
    if (!(xx > 1e-16)) return false;
    const double tolerance = xx * 1e-5;
    if (std::abs(yy - xx) > tolerance || std::abs(zz - xx) > tolerance) return false;
    if (std::abs(x0 * y0 + x1 * y1 + x2 * y2) > tolerance) return false;
    if (std::abs(x0 * z0 + x1 * z1 + x2 * z2) > tolerance) return false;
    if (std::abs(y0 * z0 + y1 * z1 + y2 * z2) > tolerance) return false;
    // Positive determinant: a mirrored rig would draw inside-out under the source's face culling.
    const double determinant =
        x0 * (y1 * z2 - y2 * z1) - y0 * (x1 * z2 - x2 * z1) + z0 * (x1 * y2 - x2 * y1);
    return determinant > 0 && elements[3] == 0 && elements[7] == 0 && elements[11] == 0;
}

void multiplyAffine(const float* a, std::size_t ao, const double* b, std::size_t bo, float* out,
                    std::size_t o) {
    multiplyImpl(a, ao, b, bo, out, o);
}
void multiplyAffine(const double* a, std::size_t ao, const float* b, std::size_t bo, float* out,
                    std::size_t o) {
    multiplyImpl(a, ao, b, bo, out, o);
}
void multiplyAffine(const double* a, std::size_t ao, const double* b, std::size_t bo, double* out,
                    std::size_t o) {
    multiplyImpl(a, ao, b, bo, out, o);
}

SkinnedPalette::SkinnedPalette(std::uint32_t bones, std::uint32_t capacity, bool velocity)
    : bones_(bones), capacity_(capacity), velocity_(velocity) {
    const std::size_t floats = static_cast<std::size_t>(capacity) * bones * 16;
    current_.assign(floats, 0.0f);
    if (velocity) previous_.assign(floats, 0.0f);
}

std::optional<std::uint32_t> SkinnedPalette::claim(const Object3D* rig) {
    const auto found = instances_.find(rig);
    if (found != instances_.end()) return found->second;
    std::uint32_t slot;
    if (!free_.empty()) {
        slot = free_.back();
        free_.pop_back();
    } else {
        if (used_ >= capacity_) return std::nullopt;
        slot = used_;
        used_ += 1;
    }
    instances_[rig] = slot;
    fresh_.push_back(slot);
    return slot;
}

void SkinnedPalette::release(const Object3D* rig) {
    const auto found = instances_.find(rig);
    if (found == instances_.end()) return;
    const std::uint32_t slot = found->second;
    instances_.erase(found);
    hide(slot);
    free_.push_back(slot);
}

void SkinnedPalette::hide(std::uint32_t slot) {
    const std::size_t stride = static_cast<std::size_t>(bones_) * 16;
    const std::size_t begin = static_cast<std::size_t>(slot) * stride;
    std::fill(current_.begin() + static_cast<std::ptrdiff_t>(begin),
              current_.begin() + static_cast<std::ptrdiff_t>(begin + stride), 0.0f);
    if (velocity_)
        std::fill(previous_.begin() + static_cast<std::ptrdiff_t>(begin),
                  previous_.begin() + static_cast<std::ptrdiff_t>(begin + stride), 0.0f);
}

void SkinnedPalette::restart(std::uint32_t slot) { fresh_.push_back(slot); }

void SkinnedPalette::write(std::uint32_t slot, SkinnedMesh& rig, bool updateSkeleton) {
    Skeleton* skeleton = rig.skeleton.get();
    if (skeleton == nullptr) return;
    // `#updated.get(skeleton) !== this.#frame`: a skeleton never seen is not "updated at frame 0".
    if (const auto seen = updated_.find(skeleton);
        updateSkeleton && (seen == updated_.end() || seen->second != frame_)) {
        skeleton->update();
        updated_[skeleton] = frame_;
        skeletonUpdates_ += 1;
    }
    writes_ += 1;

    const std::vector<float>& bones = skeleton->boneMatrices;
    const double* bind = rig.bindMatrix.elements.data();
    const bool bindIsIdentity = isIdentity(bind);
    const bool detached = !rig.attached;
    double* prefix = bindScratch_.data();
    if (detached)
        multiplyAffine(rig.matrixWorld.elements.data(), 0, rig.bindMatrixInverse.elements.data(), 0,
                       prefix, 0);

    const std::size_t offset = static_cast<std::size_t>(slot) * bones_ * 16;
    // The common case is one contiguous copy: `skeleton.update` has already written this rig's bone
    // matrices in palette order, and an identity bind matrix leaves them unchanged.
    if (bindIsIdentity) {
        std::copy(bones.begin(), bones.end(), current_.begin() + static_cast<std::ptrdiff_t>(offset));
    } else {
        for (std::uint32_t bone = 0; bone < bones_; bone += 1) {
            multiplyAffine(bones.data(), static_cast<std::size_t>(bone) * 16, bind, 0,
                           current_.data(), offset + static_cast<std::size_t>(bone) * 16);
        }
    }
    if (detached) {
        for (std::uint32_t bone = 0; bone < bones_; bone += 1) {
            const std::size_t at = offset + static_cast<std::size_t>(bone) * 16;
            // In place is safe: each right-hand column is read before it is written.
            multiplyAffine(prefix, 0, current_.data(), at, current_.data(), at);
        }
    }
}

namespace {
// True unless every node of a material graph is known to read the same through a relative slot and its placement as
// through a world palette: view, world, clip and screen values, the camera, time, constants, math, textures and control
// flow. It fails closed: a local position, a per-object matrix, and any kind, input, uniform or varying not listed here refuse
// (PRD-878: the stress walkers' emissive sheen reads normalView and the view direction).
bool readsLocalSpace(const shader::graph::NodeData* node, std::vector<const void*>& seen) {
    using shader::graph::Kind;
    if (!node || std::find(seen.begin(), seen.end(), node) != seen.end()) return false;
    seen.push_back(node);
    const auto named = [&](std::initializer_list<std::string_view> names) {
        return std::find(names.begin(), names.end(), node->name) != names.end();
    };
    bool safe = false;
    switch (node->kind) {
        // A game's `uniform(value)` is "nodeUniform<n>" and carries its own data. Of the engine's uniforms (the
        // renderer's slot table) only the camera, the screen and the clock are listed: a per-object one (model, normal,
        // bind matrices) or one added later refuses, and so does a game uniform renamed onto any other name.
        case Kind::Uniform:
            safe = node->name.starts_with("nodeUniform") ||
                named({"viewMatrix", "projectionMatrix", "cameraPosition", "cameraProjectionMatrix", "cameraWorldMatrix",
                       "cameraNear", "cameraFar", "screenSize", "time", "deltaTime"});
            break;
        case Kind::Attribute: safe = node->name.starts_with("uv") || node->name == "color"; break;
        case Kind::Builtin: safe = named({"frontFacing", "position", "vertexIndex"}); break;
        // A varying with a value is the game's own (its value is walked below); a named one is the engine's input.
        case Kind::Varying:
            safe = !node->args.empty() ||
                named({"positionView", "normalView", "positionWorld", "positionWorldDirection", "positionViewDirection",
                       "normalViewGeometry", "normalWorldGeometry", "uv", "vertexColor", "ndc", "currentClip"});
            break;
        case Kind::Constant: case Kind::Unary: case Kind::Binary: case Kind::Math: case Kind::Swizzle: case Kind::Join:
        case Kind::Convert: case Kind::Select: case Kind::Texture: case Kind::TextureSize: case Kind::TextureLoad:
        case Kind::RenderTexture: case Kind::Pmrem: case Kind::ScreenUv: case Kind::ViewportDepth: case Kind::Body:
        case Kind::Var: case Kind::VarRead: case Kind::Assign: case Kind::If: case Kind::Loop: case Kind::LoopIndex:
        case Kind::Call: case Kind::Return: case Kind::Break: case Kind::Continue: case Kind::Discard:
        case Kind::WgslFunction: case Kind::WgslCall: case Kind::StructType: case Kind::Struct: case Kind::StructMember:
            safe = true;
            break;
        default: break;
    }
    if (!safe) return true;
    for (const auto* list : {&node->args, &node->body, &node->otherwise})
        for (const auto& next : *list)
            if (readsLocalSpace(next.get(), seen)) return true;
    return false;
}

// The lowest ancestor that holds the mesh and every bone, short of the Scene, or null. A bone chain with a render
// callback refuses: the callback could move it after the slot is written.
const Object3D* placementOf(const SkinnedMesh& rig) {
    const Object3D* root = &rig;
    for (; root && root->type() != "Scene"; root = root->parent) {
        bool containsBones = root->type() != "Bone";
        for (std::size_t i = 0; containsBones && i < rig.skeleton->bones.size(); ++i) {
            const Object3D* bone = rig.skeleton->bone(i);
            if (!bone) return nullptr;
            for (; bone && bone != root; bone = bone->parent)
                if (bone->onBeforeRender) return nullptr;
            containsBones = bone == root;
        }
        if (containsBones) return root->type() == "Scene" ? nullptr : root;
    }
    return nullptr;
}
}  // namespace

const Object3D* SkinnedPalette::writeRelative(std::uint32_t slot, SkinnedMesh& rig) {
    const auto refuse = [&]() -> const Object3D* {
        write(slot, rig, false);  // The render database already updated the skeleton this frame.
        return nullptr;
    };
    // A node material compiles its plain class's program around its nodes, so only a node that reads local space
    // refuses (the stress crowd's MeshStandardNodeMaterial kept every walker on the world palette, PRD-872).
    if (velocity_ || !rig.attached || !rig.skeleton || rig.skeleton->bones.empty() ||
        !isSimilarityTransform(rig.matrixWorld.elements.data()) || !rig.material || rig.material->positionNode)
        return refuse();
    // A graph is walked once per set of node objects: they are immutable, and the cache holds them, so a frame
    // compares addresses that cannot be reused.
    auto& cache = rig.relativeSlot;
    const auto& set = rig.material->nodes;
    std::size_t at = 0;
    bool same = true;
    set.forEachGraph([&](const auto& node) {
        same = same && at < cache.nodes.size() && cache.nodes[at].get() == node.get();
        ++at;
    });
    if (!same || at != cache.nodes.size()) {
        cache.nodes.clear();
        set.forEachGraph([&](const auto& node) { cache.nodes.push_back(node); });
        std::vector<const void*> seen;  // a node whose output is a local or clip position refuses outright
        cache.nodesHold = !set.positionNode && !set.vertexNode && !set.castShadowPositionNode &&
            std::none_of(cache.nodes.begin(), cache.nodes.end(), [&](const auto& node) {
                return readsLocalSpace(static_cast<const shader::graph::NodeData*>(node.get()), seen);
            });
    }
    if (!cache.nodesHold)
        return refuse();
    // Attached skinning cancels meshWorld against bindMatrixInverse. Refuse stale/custom binds.
    Matrix4 cancellation;
    cancellation.multiplyMatrices(rig.matrixWorld, rig.bindMatrixInverse);
    for (int k = 0; k < 16; ++k)
        if (!std::isfinite(cancellation.elements[k]) ||
            std::abs(cancellation.elements[k] - (k % 5 == 0 ? 1.0 : 0.0)) > 1e-8)
            return refuse();
    for (const Object3D* ancestor = &rig; ancestor; ancestor = ancestor->parent)
        if (ancestor->onBeforeRender)
            return refuse();
    // The placement depends only on the hierarchy: found once per hierarchy change, not per frame. Any transform the
    // walk composes eagerly is exact here (the web engine tracks none), because the slot and the placement below are
    // read from the same world matrices this frame (PRD-878).
    if (const uint64_t hierarchy = Object3D::hierarchyVersion(); cache.hierarchy != hierarchy || !cache.root) {
        cache.root = placementOf(rig);
        cache.hierarchy = hierarchy;
        cache.matrices.clear();
    }
    const Object3D* root = cache.root;
    if (!root || !isSimilarityTransform(root->matrixWorld.elements.data()))
        return refuse();
    for (double element : root->matrixWorld.elements)
        if (!std::isfinite(element))
            return refuse();
    if (root->matrixWorld.elements[15] != 1)
        return refuse();
    Matrix4 inverse;
    inverse.copy(root->matrixWorld).invert();
    // The slot is R^-1 * boneWorld * inverseBind * bind: the local pose (its version), the nodes between the root and
    // the bones (the first bone's place under the root) and the bind (in the version). A frame where all three held
    // keeps the slot the last write made, however the root moved (UE 5.8.3:
    // Engine/Source/Runtime/Engine/Private/Components/SkinnedMeshComponent.cpp:1514 sends bones only when marked).
    const Bone* first = nullptr;
    for (std::size_t i = 0; i < rig.skeleton->bones.size() && !first; ++i) first = rig.skeleton->bone(i);
    std::array<double, 16> anchor{};
    multiplyAffine(inverse.elements.data(), 0, first->matrixWorld.elements.data(), 0, anchor.data(), 0);
    const std::size_t begin = static_cast<std::size_t>(slot) * bones_ * 16, count = std::size_t{bones_} * 16;
    const uint64_t pose = rig.skeleton->poseVersion();
    const auto near = [&] {
        for (int k = 0; k < 16; ++k)
            if (std::abs(anchor[k] - cache.anchor[k]) > 1e-9 * (1 + std::abs(anchor[k]))) return false;
        return true;
    };
    if (cache.pose == pose && cache.matrices.size() == count && near()) {
        std::copy(cache.matrices.begin(), cache.matrices.end(), current_.begin() + static_cast<std::ptrdiff_t>(begin));
        return root;
    }
    write(slot, rig, false);
    // W = boneWorld * inverseBind * bind. Store R^-1 * W; the instance supplies R.
    for (std::uint32_t bone = 0; bone < bones_; ++bone) {
        const std::size_t at = begin + static_cast<std::size_t>(bone) * 16;
        multiplyAffine(inverse.elements.data(), 0, current_.data(), at, current_.data(), at);
    }
    cache.pose = pose;
    cache.anchor = anchor;
    cache.matrices.assign(current_.begin() + static_cast<std::ptrdiff_t>(begin),
                          current_.begin() + static_cast<std::ptrdiff_t>(begin + count));
    return root;
}

void SkinnedPalette::begin() {
    frame_ += 1;
    if (velocity_) previous_ = current_;
}

void SkinnedPalette::end() {
    if (velocity_) {
        const std::size_t stride = static_cast<std::size_t>(bones_) * 16;
        for (const std::uint32_t slot : fresh_) {
            const std::size_t at = static_cast<std::size_t>(slot) * stride;
            std::copy(current_.begin() + static_cast<std::ptrdiff_t>(at),
                      current_.begin() + static_cast<std::ptrdiff_t>(at + stride),
                      previous_.begin() + static_cast<std::ptrdiff_t>(at));
        }
    }
    fresh_.clear();
}

}  // namespace tn::engine
