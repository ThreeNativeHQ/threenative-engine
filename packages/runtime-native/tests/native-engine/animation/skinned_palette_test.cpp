// PRD-518 phases 2-3: the native SkinnedPalette against the pinned SkinnedBatch.
// skinned-palette-reference.ts drives the real core SkinnedBatch through a scripted 12-frame
// sequence (claim, write twice as a main and shadow pass, hide, release, slot reuse, restart, growth
// and a full batch) and records, after every frame, the palette and history float bits, `used`, the
// free list, the fresh and collapsed slots, the `skeleton.update` count and the `write` count. The
// native test rebuilds the same rigs from the same table, replays the same ops in the same order and
// compares every bit. It also compares isSimilarityTransform over the recorded matrix table.
#include "check.h"
#include "engine/animation/skinning/palette.h"
#include "engine/scene/material.h"
#include "engine/scene/nodes.h"

#include <bit>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <memory>
#include <optional>
#include <span>
#include <utility>
#include <vector>

using namespace tn::engine;

namespace {

#include "skinned_palette_reference.inc"

struct Rig {
    std::shared_ptr<SkinnedMesh> mesh;
    std::vector<std::shared_ptr<Bone>> bones;
};

Rig buildRig(const PaletteRig& spec) {
    Rig rig;
    rig.bones.reserve(static_cast<std::size_t>(spec.boneCount));
    for (int i = 0; i < spec.boneCount; ++i) {
        auto bone = std::make_shared<Bone>();
        bone->position.set(spec.bones[i].t[0], spec.bones[i].t[1], spec.bones[i].t[2]);
        bone->quaternion.set(spec.bones[i].q[0], spec.bones[i].q[1], spec.bones[i].q[2],
                             spec.bones[i].q[3]);
        bone->scale.set(spec.bones[i].s[0], spec.bones[i].s[1], spec.bones[i].s[2]);
        rig.bones.push_back(std::move(bone));
    }
    for (int i = 1; i < spec.boneCount; ++i)
        rig.bones[static_cast<std::size_t>(spec.bones[i].parent)]->add(
            *rig.bones[static_cast<std::size_t>(i)]);
    std::vector<Matrix4> inverses;
    inverses.reserve(static_cast<std::size_t>(spec.boneCount));
    for (int i = 0; i < spec.boneCount; ++i) {
        Matrix4 matrix;
        for (int k = 0; k < 16; ++k) matrix.elements[k] = spec.inverses[i * 16 + k];
        inverses.push_back(matrix);
    }
    rig.mesh = std::make_shared<SkinnedMesh>();
    rig.mesh->skeleton = std::make_shared<Skeleton>(rig.bones, inverses);
    rig.mesh->attached = spec.attached != 0;
    for (int k = 0; k < 16; ++k) {
        rig.mesh->bindMatrix.elements[k] = spec.bindMatrix[k];
        rig.mesh->bindMatrixInverse.elements[k] = spec.bindMatrixInverse[k];
        rig.mesh->matrixWorld.elements[k] = spec.matrixWorld[k];
    }
    rig.mesh->add(*rig.bones[0]);
    return rig;
}

void applyPose(Rig& rig, const PaletteRig& spec, const double* pose) {
    for (int b = 0; b < spec.boneCount; ++b) {
        Bone* bone = rig.bones[static_cast<std::size_t>(b)].get();
        const double* p = pose + static_cast<std::size_t>(b) * 10;
        bone->position.set(p[0], p[1], p[2]);
        bone->quaternion.set(p[3], p[4], p[5], p[6]);
        bone->scale.set(p[7], p[8], p[9]);
    }
    rig.bones[0]->updateMatrixWorld(true);
}

struct Observed {
    std::vector<std::uint32_t> palette;
    std::vector<std::uint32_t> history;
    std::uint32_t used;
    std::vector<std::uint32_t> free;
    std::uint32_t fresh;
    std::uint32_t collapsed;
    std::uint32_t skeletonUpdates;
    std::uint32_t writes;
};

std::vector<Observed> replay() {
    std::vector<Rig> rigs;
    rigs.reserve(static_cast<std::size_t>(kRigCount));
    for (int r = 0; r < kRigCount; ++r) rigs.push_back(buildRig(kRigs[r]));
    SkinnedPalette palette(static_cast<std::uint32_t>(kPaletteBones),
                           static_cast<std::uint32_t>(kPaletteCapacity), kPaletteVelocity != 0);

    std::vector<Observed> observed;
    observed.reserve(static_cast<std::size_t>(kFrameCount));
    std::uint32_t previousUpdates = 0;
    std::uint32_t previousWrites = 0;
    for (int frame = 0; frame < kFrameCount; ++frame) {
        const PaletteFrame& script = kFrames[frame];
        palette.begin();
        for (int r = 0; r < kRigCount; ++r)
            applyPose(rigs[static_cast<std::size_t>(r)], kRigs[r],
                      script.poses + static_cast<std::size_t>(r) * kPaletteBones * 10);
        for (int index = 0; index < script.opCount; ++index) {
            const PaletteOp& op = script.ops[index];
            if (op.kind == 0) {
                const std::optional<std::uint32_t> slot = palette.claim(rigs[static_cast<std::size_t>(op.rig)].mesh.get());
                CHECK(slot.has_value() == (op.slot >= 0));
                if (slot.has_value()) CHECK(static_cast<int>(*slot) == op.slot);
            } else if (op.kind == 1) {
                palette.release(rigs[static_cast<std::size_t>(op.rig)].mesh.get());
            } else if (op.kind == 2) {
                palette.hide(static_cast<std::uint32_t>(op.slot));
            } else if (op.kind == 3) {
                palette.restart(static_cast<std::uint32_t>(op.slot));
            } else {
                palette.write(static_cast<std::uint32_t>(op.slot),
                              *rigs[static_cast<std::size_t>(op.rig)].mesh);
            }
        }
        palette.end();

        Observed frameObserved;
        for (const float value : palette.palette())
            frameObserved.palette.push_back(std::bit_cast<std::uint32_t>(value));
        for (const float value : palette.history())
            frameObserved.history.push_back(std::bit_cast<std::uint32_t>(value));
        frameObserved.used = palette.used();
        frameObserved.free = palette.free();
        frameObserved.skeletonUpdates = palette.skeletonUpdates() - previousUpdates;
        frameObserved.writes = palette.writes() - previousWrites;
        previousUpdates = palette.skeletonUpdates();
        previousWrites = palette.writes();
        observed.push_back(std::move(frameObserved));
    }
    return observed;
}

std::size_t compareBits(const std::vector<std::uint32_t>& got, const unsigned int* want,
                        std::size_t count) {
    std::size_t differ = 0;
    for (std::size_t k = 0; k < count; ++k) {
        if (got[k] != want[k]) ++differ;
    }
    return differ;
}

bool freeMatches(const std::vector<std::uint32_t>& got, int count, const int* want) {
    if (static_cast<int>(got.size()) != count) return false;
    for (int i = 0; i < count; ++i)
        if (static_cast<int>(got[static_cast<std::size_t>(i)]) != want[i]) return false;
    return true;
}

void slotReuse() {
    const std::vector<Observed> observed = replay();
    const std::size_t floats =
        static_cast<std::size_t>(kPaletteCapacity) * kPaletteBones * 16;
    const std::size_t stride = static_cast<std::size_t>(kPaletteBones) * 16;
    std::size_t differ = 0;
    for (int frame = 0; frame < kFrameCount; ++frame) {
        const PaletteFrame& expected = kFrames[frame];
        differ += compareBits(observed[frame].palette, expected.palette, floats);
        CHECK(observed[frame].used == static_cast<std::uint32_t>(expected.used));
        CHECK(freeMatches(observed[frame].free, expected.freeCount, expected.free));
        // A hidden or released slot collapses to zero matrices in both this frame's palette and its
        // history, so it draws no triangle.
        for (int c = 0; c < expected.collapsedCount; ++c) {
            const std::size_t slot = static_cast<std::size_t>(expected.collapsed[c]);
            for (std::size_t k = 0; k < stride; ++k) {
                CHECK(observed[frame].palette[slot * stride + k] == 0u);
                CHECK(observed[frame].history[slot * stride + k] == 0u);
            }
        }
    }
    // A reused slot holds no previous occupant: the whole palette equals the reference the real
    // SkinnedBatch produced for the same slots.
    std::printf("skinned palette: %d frames, %zu differ\n", kFrameCount, differ);
    CHECK(differ == 0);

    std::size_t similarityDiffer = 0;
    for (int i = 0; i < kSimilarityCount; ++i) {
        const int got = isSimilarityTransform(kSimilarityMatrices + static_cast<std::size_t>(i) * 16) ? 1 : 0;
        if (got == kSimilarityExpected[i]) continue;
        ++similarityDiffer;
        std::fprintf(stderr, "similarity %d: native %d three %d\n", i, got, kSimilarityExpected[i]);
    }
    CHECK(similarityDiffer == 0);
}

void poseHistory() {
    const std::vector<Observed> observed = replay();
    const std::size_t floats =
        static_cast<std::size_t>(kPaletteCapacity) * kPaletteBones * 16;
    const std::size_t stride = static_cast<std::size_t>(kPaletteBones) * 16;
    std::size_t differ = 0;
    std::size_t freshDiffer = 0;
    for (int frame = 0; frame < kFrameCount; ++frame) {
        const PaletteFrame& expected = kFrames[frame];
        differ += compareBits(observed[frame].history, expected.history, floats);
        // A fresh or restarted slot's history is its own current pose at end(), not a stale pose.
        for (int c = 0; c < expected.freshCount; ++c) {
            const std::size_t slot = static_cast<std::size_t>(expected.fresh[c]);
            for (std::size_t k = 0; k < stride; ++k)
                if (observed[frame].history[slot * stride + k] !=
                    observed[frame].palette[slot * stride + k])
                    ++freshDiffer;
        }
    }
    std::printf("skinned history: %d frames, %zu differ, %zu fresh differ\n", kFrameCount, differ,
                freshDiffer);
    CHECK(differ == 0);
    CHECK(freshDiffer == 0);
}

void updateFrequency() {
    const std::vector<Observed> observed = replay();
    std::size_t updatesDiffer = 0;
    std::size_t writesDiffer = 0;
    for (int frame = 0; frame < kFrameCount; ++frame) {
        if (observed[frame].skeletonUpdates !=
            static_cast<std::uint32_t>(kFrames[frame].skeletonUpdates))
            ++updatesDiffer;
        if (observed[frame].writes != static_cast<std::uint32_t>(kFrames[frame].writes))
            ++writesDiffer;
    }
    std::printf("skinned update: %d frames, %zu differ, %zu writes differ\n", kFrameCount,
                updatesDiffer, writesDiffer);
    CHECK(updatesDiffer == 0);
    CHECK(writesDiffer == 0);

    // A write before any begin() still updates the skeleton: three's WeakMap has no entry for it, and
    // `undefined !== 0`.
    auto rig = std::make_shared<SkinnedMesh>();
    auto bone = std::make_shared<Bone>();
    rig->add(*bone);
    rig->bind(std::make_shared<Skeleton>(std::vector<std::shared_ptr<Bone>>{bone}));
    SkinnedPalette fresh(1, 4, false);
    const auto slot = fresh.claim(rig.get());
    CHECK(slot.has_value());
    if (slot) fresh.write(*slot, *rig);
    CHECK(fresh.skeletonUpdates() == 1);
}

// PRD-878 Step A: a walker drawn with a node material that sets no node, on plain (untracked) transforms as the web
// engine builds every object, takes the root-relative slot; a frame whose pose version held keeps the slot it wrote
// last, whatever the walker's root did, and a bone write rewrites it. Placement times slot is the world palette.
void relativeSlotKeepsAnUnchangedPose() {
    Scene scene;
    auto geometry = std::make_shared<BufferGeometry>();
    auto material = std::make_shared<Material>(MaterialType::Standard, true);  // MeshStandardNodeMaterial, no nodes
    auto root = std::make_shared<Object3D>();
    auto rig = std::make_shared<SkinnedMesh>(geometry, material);
    auto hips = std::make_shared<Bone>(), head = std::make_shared<Bone>();
    root->add(*rig);
    root->add(*hips);
    hips->add(*head);
    head->position.y = 0.6;
    scene.add(*root);
    scene.updateMatrixWorld(true);
    rig->bind(std::make_shared<Skeleton>(std::vector<std::shared_ptr<Bone>>{hips, head}));
    hips->rotation.z = 0.3;
    const auto frame = [&](std::vector<float>& slot) {
        scene.updateMatrixWorld();
        rig->skeleton->update();
        SkinnedPalette palette(2, 1, false), eager(2, 1, false);
        palette.begin();
        const Object3D* placement = palette.writeRelative(*palette.claim(rig.get()), *rig);
        CHECK(placement == root.get());
        eager.write(*eager.claim(rig.get()), *rig, false);
        for (std::size_t bone = 0; placement && bone < 2; ++bone) {
            float world[16];
            multiplyAffine(placement->matrixWorld.elements.data(), 0, palette.matrices().data(), bone * 16, world, 0);
            for (int k = 0; k < 16; ++k) CHECK(std::abs(world[k] - eager.palette()[bone * 16 + k]) < 1e-5);
        }
        slot = palette.matrices();
        return palette.writes();
    };
    std::vector<float> first, next;
    CHECK(frame(first) == 1);
    root->position.set(4, 0, -2);  // the walker walks and turns; its pose holds
    root->rotation.y = 0.8;
    CHECK(frame(next) == 0);
    CHECK(next == first);
    head->rotation.x = 0.4;  // a bone write
    CHECK(frame(next) == 1);
    CHECK(next != first);
    // The walkers' backlit sheen is an emissive node over view space (normalView, the view direction): a relative slot
    // leaves every view and world value as it was, so it is admitted. A node that reads the skinned local position
    // would see the root's space instead of the world's: refused.
    namespace g = shader::graph;
    material->nodes.emissiveNode = g::normalize(g::varying("normalView", shader::Type::vec(3)));
    frame(next);
    // A game's own uniform and the camera's view matrix read the same through the slot: admitted.
    material->nodes.emissiveNode = g::normalize(g::mul(
        g::mul(g::uniform("viewMatrix", shader::Type::mat(4, 4)), g::uniform("nodeUniform7", shader::Type::vec(4), {0, 1, 0, 0})),
        g::uniform("nodeUniform8", shader::Type::vec(4), {1, 1, 1, 1})));
    frame(next);
    // The check fails closed: a local read, and any input or kind it does not know, refuses.
    auto unknown = std::make_shared<g::NodeData>();
    unknown->kind = g::Kind::StorageElement;
    unknown->type = shader::Type::vec(3);
    for (const g::Node& refused : {g::positionLocal(), g::varying("tnMystery", shader::Type::vec(3)),
                                   g::attribute("tnMystery", shader::Type::vec(3)), g::Node(unknown),
                                   g::swizzle(g::uniform("normalMatrix", shader::Type::mat(3, 3)), "x"),
                                   g::swizzle(g::uniform("bindMatrix", shader::Type::mat(4, 4)), "xyz"),
                                   g::swizzle(g::uniform("tnLaterEngineMatrix", shader::Type::mat(4, 4)), "xyz")}) {
        material->nodes.emissiveNode = g::normalize(refused);
        scene.updateMatrixWorld();
        rig->skeleton->update();
        SkinnedPalette local(2, 1, false);
        CHECK(local.writeRelative(*local.claim(rig.get()), *rig) == nullptr);
    }
}

}  // namespace

TN_TEST_MAIN({"slot_reuse", slotReuse}, {"pose_history", poseHistory},
             {"update_frequency", updateFrequency},
             {"relative_slot_keeps_an_unchanged_pose", relativeSlotKeepsAnUnchangedPose})
