// PRD-828 Phase 2: one call a frame advances every rig — the weight ramp, the stride rule and the
// mixer step, with no crossing per rig. These cases pin the three rules the JS loop used to hold.
#include "check.h"

#include <cmath>
#include <memory>
#include <vector>

#include "engine/animation/tick_batch.h"
#include "engine/scene/object3d.h"

using namespace tn::engine;
using namespace tn::engine::animation;

namespace {

/** A rig with one looping clip that moves a child 10 m in one second: ground speed 10 m/s. */
struct Rig {
    std::shared_ptr<Object3D> root = std::make_shared<Object3D>();
    std::shared_ptr<Object3D> body = std::make_shared<Object3D>();
    std::shared_ptr<AnimationMixer> mixer;
    AnimationAction* action = nullptr;

    explicit Rig(double clipGroundSpeed = 10) {
        body->name = "body";
        root->add(*body);
        auto clip = std::make_shared<AnimationClip>(
            "walk", 1,
            std::vector<KeyframeTrack>{KeyframeTrack(".position", TrackType::Vector, {0, 1}, {0, 0, 0, 10, 0, 0})});
        mixer = std::make_shared<AnimationMixer>(body);
        action = mixer->clipAction(clip);
        action->play();
        groundSpeed = clipGroundSpeed;
    }
    [[nodiscard]] TickRig tick(double dt) const {
        TickRig rig;
        rig.mixer = mixer.get();
        rig.action = action;
        rig.strideRoot = root.get();
        rig.targetWeight = 1;
        rig.transition = 0;
        rig.dt = dt;
        rig.clipGroundSpeed = groundSpeed;
        return rig;
    }
    double groundSpeed = 10;
};

/** A body that moved `metres` this frame, in x, with no rotation: the stride rule's only input. */
void place(const Rig& rig, double metres) { rig.root->position.x = metres; }

// The mixer steps once per rig, the stride rule reads the moved body, and no per-rig call happens.
void tick_batch() {
    Rig rig(10);
    TickBatch batch;
    std::vector<TickStatus> status;
    // The first tick has no previous position to measure from, so the body reads as standing still and
    // the rate floors — the same first frame the JS rule pays (`#hasLastRootPosition`).
    place(rig, 0);
    batch.run({rig.tick(0.1)}, status);
    CHECK(std::abs(status[0].groundSpeed) < 1e-9);
    CHECK(std::abs(status[0].strideRate - TickPolicy{}.rateMin) < 1e-9);
    const double primed = rig.action->time;
    // Two frames of 0.1 s with the body 1 m further each frame: 10 m/s against a 10 m/s clip is rate 1.
    for (int frame = 1; frame <= 2; frame++) {
        place(rig, 1.0 * frame);
        batch.run({rig.tick(0.1)}, status);
    }
    CHECK(status.size() == 1);
    CHECK(std::abs(status[0].groundSpeed - 10) < 1e-9);
    CHECK(std::abs(status[0].strideRate - 1) < 1e-9);
    CHECK(std::abs(rig.action->getEffectiveTimeScale() - 1) < 1e-9);
    CHECK(status[0].changed);
    // The mixer advanced the clip by both full-rate steps.
    CHECK(std::abs(rig.action->time - primed - 0.2) < 1e-9);
}

// Half the ground covered bends the clip down; twice the ground bends it up, inside the clamps.
void stride_rate() {
    Rig slow(10), fast(10);
    TickBatch batch;
    std::vector<TickStatus> status;
    for (int frame = 0; frame < 3; frame++) {
        place(slow, 0.5 * (frame + 1));
        place(fast, 2.0 * (frame + 1));
        batch.run({slow.tick(0.1), fast.tick(0.1)}, status);
    }
    CHECK(std::abs(status[0].strideRate - 0.5) < 1e-9);
    CHECK(std::abs(status[1].strideRate - 2) < 1e-9);
    CHECK(std::abs(slow.action->getEffectiveTimeScale() - 0.5) < 1e-9);
    CHECK(std::abs(fast.action->getEffectiveTimeScale() - 2) < 1e-9);
    // A still body is not a zero rate: the floor keeps the pose alive.
    Rig still(10);
    batch.run({still.tick(0.1)}, status);
    CHECK(std::abs(status[0].strideRate - TickPolicy{}.rateMin) < 1e-9);
    // A clip that is not locomotion (an idle, a death) plays at its authored rate whatever the body does.
    Rig authored(0);
    for (int frame = 0; frame < 2; frame++) {
        place(authored, 4.0 * (frame + 1));
        batch.run({authored.tick(0.1)}, status);
    }
    CHECK(std::abs(status[0].strideRate - 1) < 1e-9);
    CHECK(std::abs(authored.action->getEffectiveTimeScale() - 1) < 1e-9);
}

// The weight ramp is linear in real time and lands exactly on the target.
void weight_ramp() {
    Rig rig;
    TickBatch batch;
    std::vector<TickStatus> status;
    rig.action->setEffectiveWeight(0);
    const auto ramp = [&](double dt) {
        TickRig spec = rig.tick(dt);
        spec.targetWeight = 1;
        spec.transition = 0.2;
        batch.run({spec}, status);
        return rig.action->getEffectiveWeight();
    };
    CHECK(std::abs(ramp(0.1) - 0.5) < 1e-9);
    CHECK(std::abs(ramp(0.05) - 0.75) < 1e-9);
    CHECK(std::abs(ramp(0.05) - 1) < 1e-9);
    // A zero transition is "now", and a second request does not restart a ramp that is already done.
    TickRig instant = rig.tick(0.016);
    instant.targetWeight = 0.25;
    batch.run({instant}, status);
    CHECK(std::abs(rig.action->getEffectiveWeight() - 0.25) < 1e-9);
}

// The batch keeps one state per action, and forgets one on request: a rig that switches clips ramps
// from where its pose is, not from the dead clip's last position.
void forget_state() {
    Rig rig;
    TickBatch batch;
    std::vector<TickStatus> status;
    place(rig, 1.0);
    batch.run({rig.tick(0.1)}, status);
    CHECK(batch.size() == 1);
    batch.forget(rig.action);
    CHECK(batch.size() == 0);
    // With the state gone the next tick records a position instead of reporting a jump.
    place(rig, 100.0);
    batch.run({rig.tick(0.1)}, status);
    CHECK(status[0].groundSpeed == 0);
    batch.clear();
    CHECK(batch.size() == 0);
}

}  // namespace

TN_TEST_MAIN({"tick_batch", tick_batch}, {"stride_rate", stride_rate}, {"weight_ramp", weight_ramp},
             {"forget_state", forget_state})
