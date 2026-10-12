// PRD-518 phase 1: the native Bone/Skeleton against the pinned three. skeleton-reference.ts replays
// seven rigs (the glTF fixture and six synthetic ones, chains, a branch, scale, negative scale, a
// computed inverse list and a hole) through three's own Bone and Skeleton and records, after every
// pose, the float32 boneMatrices bits and every node's float64 matrixWorld bits. The native test
// rebuilds each rig from the same table, applies the same writes in the same order, calls pose()
// on the recorded pose and compares every float and double bit for bit.
#include "check.h"
#include "engine/animation/skinning/skeleton.h"

#include <bit>
#include <cinttypes>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <memory>
#include <vector>

using namespace tn::engine;
using namespace tn::engine;

namespace {

#include "skeleton_reference.inc"

std::string bits(double x) {
    char out[17];
    std::snprintf(out, sizeof out, "%016" PRIx64, std::bit_cast<uint64_t>(x));
    return out;
}

void skeletonPose() {
    std::size_t rigCount = 0, poseCount = 0, differ = 0;
    for (int r = 0; r < kRigCount; ++r) {
        const SkinnedRig& rig = kRigs[r];
        std::vector<std::shared_ptr<Object3D>> nodes;
        nodes.reserve(static_cast<std::size_t>(rig.nodeCount));
        for (int i = 0; i < rig.nodeCount; ++i) {
            const SkinnedNode& n = rig.nodes[i];
            std::shared_ptr<Object3D> object = n.isBone
                                                   ? std::static_pointer_cast<Object3D>(std::make_shared<Bone>())
                                                   : std::make_shared<Object3D>();
            object->name = n.name;
            object->position.set(n.t[0], n.t[1], n.t[2]);
            object->quaternion.set(n.q[0], n.q[1], n.q[2], n.q[3]);
            object->scale.set(n.s[0], n.s[1], n.s[2]);
            nodes.push_back(std::move(object));
        }
        for (int i = 0; i < rig.nodeCount; ++i)
            if (rig.nodes[i].parent >= 0) nodes[rig.nodes[i].parent]->add(*nodes[i]);
        Object3D& root = *nodes[rig.root];
        root.updateMatrixWorld(true);

        std::vector<std::shared_ptr<Bone>> bones;
        for (int i = 0; i < rig.boneCount; ++i) {
            const int index = rig.bones[i];
            bones.push_back(index >= 0 ? std::static_pointer_cast<Bone>(nodes[index]) : nullptr);
        }
        std::vector<Matrix4> inverses;
        for (int i = 0; i < rig.inverseCount; ++i) {
            Matrix4 m;
            for (int k = 0; k < 16; ++k) m.elements[k] = rig.inverses[i * 16 + k];
            inverses.push_back(m);
        }
        Skeleton skeleton(bones, inverses);
        ++rigCount;

        for (int p = 0; p < rig.poseCount; ++p) {
            const SkinnedPose& pose = rig.poses[p];
            if (pose.callPose) {
                skeleton.pose();
            } else {
                for (int w = 0; w < pose.writeCount; ++w) {
                    const SkinnedWrite& write = pose.writes[w];
                    Bone* b = bones[write.bone].get();
                    if (b == nullptr) continue;
                    b->position.set(write.t[0], write.t[1], write.t[2]);
                    b->quaternion.set(write.q[0], write.q[1], write.q[2], write.q[3]);
                    b->scale.set(write.s[0], write.s[1], write.s[2]);
                }
            }
            root.updateMatrixWorld(true);
            skeleton.update();
            ++poseCount;

            for (std::size_t k = 0; k < skeleton.boneMatrices.size(); ++k) {
                const uint32_t got = std::bit_cast<uint32_t>(skeleton.boneMatrices[k]);
                if (got == pose.matrices[k]) continue;
                ++differ;
                if (differ <= 5)
                    std::fprintf(stderr, "rig %d pose %d: matrix %zu native %08x three %08x\n", r, p, k, got,
                                 pose.matrices[k]);
            }
            for (int i = 0; i < rig.nodeCount; ++i) {
                for (int k = 0; k < 16; ++k) {
                    const uint64_t got = std::bit_cast<uint64_t>(nodes[i]->matrixWorld.elements[k]);
                    const uint64_t want = std::bit_cast<uint64_t>(pose.worlds[i * 16 + k]);
                    if (got == want) continue;
                    ++differ;
                    if (differ <= 5)
                        std::fprintf(stderr, "rig %d pose %d: node %d world[%d] native %s three %s\n", r, p, i, k,
                                     bits(nodes[i]->matrixWorld.elements[k]).c_str(),
                                     bits(pose.worlds[i * 16 + k]).c_str());
                }
            }
        }

        Bone* found = skeleton.getBoneByName(rig.lookupName);
        int slot = -1;
        for (int i = 0; i < rig.boneCount; ++i)
            if (bones[i].get() == found) slot = i;
        if (slot != rig.lookupResult) {
            ++differ;
            std::fprintf(stderr, "rig %d: getBoneByName(%s) slot %d, three %d\n", r, rig.lookupName, slot,
                         rig.lookupResult);
        }
        if (skeleton.getBoneByName(rig.absentName) != nullptr) {
            ++differ;
            std::fprintf(stderr, "rig %d: getBoneByName(%s) found a bone, three undefined\n", r, rig.absentName);
        }
    }
    std::printf("skeleton: %zu rigs, %zu poses, %zu differ\n", rigCount, poseCount, differ);
    CHECK(differ == 0);
}

void cloneBounds() {
    SkinnedMesh mesh;
    mesh.boundingBox = std::make_shared<Box3>();
    mesh.boundingBox->set({100, 101, 102}, {110, 111, 112});
    std::string error;
    const auto clone = std::dynamic_pointer_cast<SkinnedMesh>(cloneSkeleton(mesh, error));
    CHECK(clone && error.empty());
    CHECK(clone && clone->boundingBox && clone->boundingBox != mesh.boundingBox);
    if (!clone || !clone->boundingBox) return;
    CHECK(clone->boundingBox->equals(*mesh.boundingBox));
    clone->boundingBox->min.x = -1;
    CHECK(mesh.boundingBox->min.x == 100);
}

} // namespace

TN_TEST_MAIN({"skeleton_pose", skeletonPose}, {"clone_bounds", cloneBounds})
