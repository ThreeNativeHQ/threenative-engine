// PRD-877 phase 2: the engine blends and restores a body's poses without leaving C++.
//
// The gate this feature exists for was measured at 1.05 ms a frame in JavaScript; these cases prove
// the replacement is the same picture. Every expectation is three's own arithmetic, written out here
// independently of PoseHistory so a bug in the blend cannot define its own expectation: a `lerp` per
// position component, one `slerp` for the orientation, the Euler derived from that quaternion, and
// the solved pose back bit for bit after `restore`.
//
// The phases are the PRD's Solution table, not an interpretation of it: `tick(0)` copies each pose to
// previous, `tick(1)` copies it to current, `blend` writes between them, `restore` puts back what
// `blend` saved.
#include "check.h"
#include "engine/scene/pose_history.h"

#include <cmath>
#include <cstdio>
#include <limits>
#include <memory>
#include <stdexcept>
#include <tuple>
#include <vector>

using namespace tn::engine;

namespace {

bool near(double a, double b, double tolerance = 1e-12) { return std::fabs(a - b) <= tolerance; }

std::shared_ptr<Object3D> body(double x, double y, double z) {
    auto object = std::make_shared<Object3D>();
    object->position.set(x, y, z);
    return object;
}

struct Expected {
    double x, y, z;
    Quaternion quaternion;
};

// Takes poses, not objects: `blend` overwrites the objects it blends, so an expectation read from a
// live object would be measuring the result against itself.
Expected between(const PoseHistory::Pose& from, const PoseHistory::Pose& to, double alpha) {
    Quaternion a{from.quaternion[0], from.quaternion[1], from.quaternion[2], from.quaternion[3]};
    Quaternion b{to.quaternion[0], to.quaternion[1], to.quaternion[2], to.quaternion[3]};
    Quaternion out;
    out.slerpQuaternions(a, b, alpha);
    return {from.position[0] + (to.position[0] - from.position[0]) * alpha,
            from.position[1] + (to.position[1] - from.position[1]) * alpha,
            from.position[2] + (to.position[2] - from.position[2]) * alpha, out};
}

PoseHistory::Pose poseOfValues(double x, double y, double z, double qx, double qy, double qz, double qw) {
    PoseHistory::Pose pose;
    pose.position[0] = x;
    pose.position[1] = y;
    pose.position[2] = z;
    pose.quaternion[0] = qx;
    pose.quaternion[1] = qy;
    pose.quaternion[2] = qz;
    pose.quaternion[3] = qw;
    return pose;
}

void blendingThreeBodiesOverTwoTicks() {
    auto a = body(0, 0, 0);
    auto b = body(1, 0, 0);
    auto c = body(0, 2, 0);
    std::vector<Object3D*> watched{a.get(), b.get(), c.get()};

    PoseHistory history;
    CHECK(history.watch(watched) == 3);
    CHECK(history.size() == 3);

    // Phase 0 records what the bodies held when the tick began; phase 1 records where the physics
    // step put them. A frame blends across that pair.
    history.tick(0.0);

    a->position.set(3, 0, 0);
    b->position.set(1, 5, 0);
    c->position.set(-4, 2, 2);
    a->quaternion.set(0, 0, 0.3826834323650898, 0.9238795325112867); // 45 degrees about z
    b->quaternion.set(0, 0.7071067811865476, 0, 0.7071067811865476); // 90 degrees about y
    c->quaternion.set(0.25881904510252074, 0, 0, 0.9659258262890683); // 30 degrees about x
    history.tick(1.0);

    const PoseHistory::Pose solvedA = PoseHistory::poseOf(*a);
    const PoseHistory::Pose solvedB = PoseHistory::poseOf(*b);
    const PoseHistory::Pose solvedC = PoseHistory::poseOf(*c);

    // What each body held before the step. Taken now, because `blend` overwrites the objects.
    const PoseHistory::Pose wasA = poseOfValues(0, 0, 0, 0, 0, 0, 1);
    const PoseHistory::Pose wasB = poseOfValues(1, 0, 0, 0, 0, 0, 1);
    const PoseHistory::Pose wasC = poseOfValues(0, 2, 0, 0, 0, 0, 1);

    history.blend(0.25);

    for (const auto& [object, from, to] : {std::tuple{a.get(), wasA, solvedA}, std::tuple{b.get(), wasB, solvedB},
                                           std::tuple{c.get(), wasC, solvedC}}) {
        const Expected want = between(from, to, 0.25);
        CHECK(near(object->position.x, want.x, 1e-12));
        CHECK(near(object->position.y, want.y, 1e-12));
        CHECK(near(object->position.z, want.z, 1e-12));
        CHECK(near(object->quaternion.x, want.quaternion.x, 1e-12));
        CHECK(near(object->quaternion.y, want.quaternion.y, 1e-12));
        CHECK(near(object->quaternion.z, want.quaternion.z, 1e-12));
        CHECK(near(object->quaternion.w, want.quaternion.w, 1e-12));
        // The Euler follows the quaternion, as three's synced pair does.
        Euler expected;
        expected.setFromQuaternion(want.quaternion);
        CHECK(near(object->rotation.x, expected.x, 1e-12));
        CHECK(near(object->rotation.y, expected.y, 1e-12));
        CHECK(near(object->rotation.z, expected.z, 1e-12));
        // The write reached the local transform rather than only the math members.
        object->updateMatrix();
        CHECK(near(object->matrix.elements[12], want.x, 1e-12));
        CHECK(near(object->matrix.elements[13], want.y, 1e-12));
        CHECK(near(object->matrix.elements[14], want.z, 1e-12));
    }

    // `restore` puts the solved pose back exactly, so the next physics step reads the body and not
    // the picture of the body.
    history.restore();
    CHECK(PoseHistory::poseOf(*a) == solvedA);
    CHECK(PoseHistory::poseOf(*b) == solvedB);
    CHECK(PoseHistory::poseOf(*c) == solvedC);

    // A second frame keeps working after a restore.
    history.tick(0.0);
    a->position.set(6, 0, 0);
    history.tick(1.0);
    history.blend(0.5);
    CHECK(near(a->position.x, 4.5, 1e-12)); // between the restored 3 and the new 6
    history.restore();
    CHECK(near(a->position.x, 6, 1e-12));
}

void aPoseChangedBetweenTickAndBlendResetsThatBody() {
    auto a = body(0, 0, 0);
    auto b = body(0, 0, 0);
    std::vector<Object3D*> watched{a.get(), b.get()};

    PoseHistory history;
    history.watch(watched);
    history.tick(0.0);
    a->position.set(2, 0, 0);
    b->position.set(2, 0, 0);
    history.tick(1.0);

    // Something outside the history moves `a` after the tick: a teleport, a kinematic driver, a game
    // writing the transform. Blending it would draw it where the simulation never put it.
    a->position.set(99, 0, 0);
    history.blend(0.5);

    CHECK(near(a->position.x, 99, 0)); // left where the game put it
    CHECK(near(b->position.x, 1.0));   // its neighbour still blends between 0 and 2

    // The frame after a discontinuity is exact, and the next one blends from where the body now is.
    a->position.set(99, 0, 0);
    history.tick(0.0);
    a->position.set(120, 0, 0);
    history.tick(1.0);
    history.blend(0.5);
    CHECK(near(a->position.x, 109.5, 1e-12));
}

void watchingKeepsTheBodiesThatStay() {
    auto a = body(0, 0, 0);
    auto b = body(0, 0, 0);
    auto c = body(0, 0, 0);

    PoseHistory history;
    history.watch({a.get(), b.get()});
    history.tick(0.0);
    a->position.set(10, 0, 0);
    b->position.set(10, 0, 0);
    history.tick(1.0);

    // Adding a third body must not forget the two already watched, or the frame a game spawns
    // something every body beside it snaps.
    CHECK(history.watch({a.get(), b.get(), c.get()}) == 3);
    history.blend(0.5);
    CHECK(near(a->position.x, 5, 1e-12));
    CHECK(near(b->position.x, 5, 1e-12));
    CHECK(near(c->position.x, 0, 0)); // the newcomer has no earlier pose to blend from
}

void aDestroyedBodyIsSkipped() {
    auto a = body(0, 0, 0);
    auto doomed = body(0, 0, 0);

    PoseHistory history;
    history.watch({a.get(), doomed.get()});
    history.tick(0.0);
    a->position.set(4, 0, 0);
    doomed->position.set(4, 0, 0);
    history.tick(1.0);

    history.blend(0.25);
    doomed.reset(); // freed between the blend and the restore, as a despawn does

    history.restore(); // must not touch the dead weak_ptr
    CHECK(near(a->position.x, 4, 1e-12));

    history.tick(0.0);
    a->position.set(8, 0, 0);
    history.tick(1.0);
    history.blend(0.5);
    CHECK(near(a->position.x, 6, 1e-12)); // blended from the restored 4
}

void blendRejectsAnAlphaItCannotUse() {
    auto a = body(0, 0, 0);
    PoseHistory history;
    history.watch({a.get()});
    history.tick(0.0);

    for (const double bad : {1.5, -0.5, std::nan(""), std::numeric_limits<double>::infinity()}) {
        bool threw = false;
        try {
            history.blend(bad);
        } catch (const std::invalid_argument&) {
            threw = true;
        }
        CHECK(threw);
    }
    // A good alpha still works after the rejections.
    a->position.set(2, 0, 0);
    history.tick(1.0);
    history.blend(0.5);
    CHECK(near(a->position.x, 1, 1e-12));
}

void resetForgetsTheDiscontinuity() {
    // What a teleport does: the game calls reset, so the next blend does not cross the gap.
    auto a = body(0, 0, 0);
    PoseHistory history;
    history.watch({a.get()});
    history.tick(0.0);
    a->position.set(10, 0, 0);
    history.tick(1.0);

    a->position.set(500, 0, 0); // teleported, and announced
    history.reset({a.get()});
    history.blend(0.5);
    CHECK(near(a->position.x, 500, 0));
}

void aSettledBodyIsNotWritten() {
    // A body whose two ticks hold one pose blends onto the pose it already has. Writing it anyway marks
    // its local transform dirty every frame and the walk recomposes a matrix that did not move; the
    // JavaScript path never did, because three's vector writes flag nothing.
    auto settled = body(4, 2, 1);
    auto moving = body(0, 0, 0);
    PoseHistory history;
    history.watch({settled.get(), moving.get()});
    history.tick(0.0);
    moving->position.set(2, 0, 0);
    history.tick(1.0);
    settled->ownTransformTracking()[1] = 0;
    moving->ownTransformTracking()[1] = 0;
    history.blend(0.5);
    CHECK(settled->ownTransformTracking()[1] == 0);
    CHECK(moving->ownTransformTracking()[1] == 1);
    CHECK(near(settled->position.x, 4, 0));
    moving->ownTransformTracking()[1] = 0;
    history.restore();
    CHECK(settled->ownTransformTracking()[1] == 0);
    CHECK(moving->ownTransformTracking()[1] == 1);
    CHECK(near(moving->position.x, 2, 0));
}

} // namespace

TN_TEST_MAIN({"pose_history", [] {
                  blendingThreeBodiesOverTwoTicks();
                  aPoseChangedBetweenTickAndBlendResetsThatBody();
                  watchingKeepsTheBodiesThatStay();
                  aDestroyedBodyIsSkipped();
                  blendRejectsAnAlphaItCannotUse();
                  resetForgetsTheDiscontinuity();
                  aSettledBodyIsNotWritten();
                  std::printf("pose history: 7 cases\n");
              }})
