// PRD-828 Phase 2: the per-frame animation loop, on the C++ side of the bridge.

#include "engine/animation/tick_batch.h"

#include <algorithm>
#include <cmath>

#include "engine/scene/object3d.h"

namespace tn::engine::animation {

namespace {

/** A moved body smaller than this on the ground plane is a jitter, not a stride. */
constexpr double kStill = 1e-9;

double clampRate(double rate, const TickPolicy& policy) {
    return std::min(policy.rateMax, std::max(policy.rateMin, rate));
}

}  // namespace

void TickBatch::run(const std::vector<TickRig>& rigs, std::vector<TickStatus>& status,
                    const TickPolicy& policy) {
    status.resize(rigs.size());
    Vector3 world;
    for (std::size_t i = 0; i < rigs.size(); i++) {
        const TickRig& rig = rigs[i];
        TickStatus& out = status[i];
        out = TickStatus{};
        if (rig.mixer == nullptr) continue;
        AnimationAction* action = rig.action;
        if (action == nullptr) {
            // Nothing playing: the mixer still steps, so a scheduled binding keeps three's time.
            rig.mixer->update(rig.dt);
            out.changed = rig.dt > 0;
            continue;
        }
        RigState& state = states_[action];

        // 1. The weight ramp: linear in real time towards the caller's target, exactly what
        //    `#advanceBlend` does for a single contributing clip.
        state.rampTarget = rig.targetWeight;
        if (rig.transition <= 0) {
            state.rampFrom = rig.targetWeight;
            state.rampElapsed = 0;
            state.rampDuration = 0;
            if (action->getEffectiveWeight() != rig.targetWeight)
                action->setEffectiveWeight(rig.targetWeight);
        } else {
            if (state.rampDuration != rig.transition) {
                // A new transition starts where the pose is, not where the last one ended.
                state.rampFrom = action->getEffectiveWeight();
                state.rampElapsed = 0;
                state.rampDuration = rig.transition;
            }
            state.rampElapsed = std::min(state.rampDuration, state.rampElapsed + rig.dt);
            const double progress =
                state.rampDuration > 0 ? state.rampElapsed / state.rampDuration : 1.0;
            const double next =
                progress >= 1 ? state.rampTarget
                              : state.rampFrom + (state.rampTarget - state.rampFrom) * progress;
            if (action->getEffectiveWeight() != next) action->setEffectiveWeight(next);
        }

        // 2. The stride rule: how fast this clip must play to cover the ground the body covered.
        double moved = 0;
        if (rig.strideRoot != nullptr) {
            rig.strideRoot->getWorldPosition(world);
            if (state.hasLast) moved = std::hypot(world.x - state.lastX, world.z - state.lastZ);
            state.lastX = world.x;
            state.lastZ = world.z;
            state.hasLast = true;
        }
        const double groundSpeed = rig.dt > 0 ? moved / rig.dt : 0;
        out.groundSpeed = groundSpeed;
        double rate = 1;
        if (rig.clipGroundSpeed >= policy.clipGroundFloor && rig.dt > 0) {
            rate = groundSpeed < policy.speedFloor
                       ? policy.rateMin
                       : clampRate(groundSpeed / rig.clipGroundSpeed, policy);
            if (rig.strideSync && action->timeScale != rate) {
                action->setEffectiveTimeScale(rate);
            } else if (!rig.strideSync && action->timeScale != 1) {
                // Not locomotion-synced: the clip plays at its authored rate, and the report says so.
                action->setEffectiveTimeScale(1);
                rate = 1;
            }
        } else if (action->timeScale != 1) {
            // A non-locomotion clip is authored at its own rate; the stride never bends it.
            action->setEffectiveTimeScale(1);
        }
        out.strideRate = rate;

        // 3. The mixer step, once per rig.
        const double before = action->time;
        const bool wasScheduled = action->isScheduled();
        rig.mixer->update(rig.dt);
        out.changed = action->time != before || wasScheduled != action->isScheduled();
        // A once-clip that has reached its end on this tick is the frame `finished` fires: three
        // stops it at the last key and clamps the pose there.
        out.finished = action->loop == Loop::Once &&
                       (!action->isScheduled() ||
                        (action->time >= action->getClip().duration && action->time > before));
    }
}

void TickBatch::forget(const AnimationAction* action) { states_.erase(action); }

void TickBatch::clear() { states_.clear(); }

}  // namespace tn::engine::animation
