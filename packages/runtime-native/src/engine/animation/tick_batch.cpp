// PRD-828 Phase 2: the per-frame animation loop, on the C++ side of the bridge.

#include "engine/animation/tick_batch.h"

#include <algorithm>
#include <cmath>
#include <limits>

#include "engine/scene/object3d.h"

namespace tn::engine::animation {

namespace {

double clampRate(double rate, const TickPolicy& policy) {
    return std::min(policy.rateMax, std::max(policy.rateMin, rate));
}

}  // namespace

void TickBatch::run(const std::vector<TickRig>& rigs, std::vector<TickStatus>& status,
                    const TickPolicy& policy) {
    status.resize(rigs.size());
    frame_ += 1;
    Vector3 world;
    for (std::size_t i = 0; i < rigs.size(); i++) {
        const TickRig& rig = rigs[i];
        TickStatus& out = status[i];
        out = TickStatus{};
        if (rig.mixer == nullptr) continue;
        AnimationAction* action = rig.action;
        if (action == nullptr) {
            // Nothing playing: the mixer still steps, so a scheduled binding keeps three's time.
            if (rig.stepMixer) {
                const double before = rig.mixer->time;
                rig.mixer->update(rig.elapsed);
                out.changed = rig.mixer->time != before;
            }
            continue;
        }
        RigState& state = states_[action];
        state.lastFrame = frame_;
        if (rig.reset) {
            state.pending = 0;
            state.elapsed = 0;
        }
        // The rate in force *before* this tick's measurement owns this tick, exactly what the JS loop
        // banked per action (`#pendingActionTimes`). Banked here, the read is never a stale mirror.
        const double scaleBeforeStep = action->timeScale;
        state.pending += rig.elapsed * scaleBeforeStep;
        state.elapsed += rig.elapsed;

        // 1. The stride rule: how fast this clip must play to cover the ground the body covered. It
        //    chooses the rate for the *next* interval.
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
        const bool measured = rig.dt > 0;
        const bool locomotion = rig.clipGroundSpeed >= policy.clipGroundFloor;
        double rate = state.reportedRate;
        if (measured) {
            rate = locomotion ? (groundSpeed < policy.speedFloor
                                     ? policy.rateMin
                                     : clampRate(groundSpeed / rig.clipGroundSpeed, policy))
                              : 1;
            state.reportedRate = rate;
        }
        const bool applies = measured && locomotion && rig.strideSync;

        // 2. The mixer step, by the time the increments banked. A grouped advance lands exactly on a
        //    loop seam: a rounding error past it would hold the last pose for the whole interval instead
        //    of looping, which is the seam adjustment the JS loop makes for the same reason.
        if (rig.stepMixer) {
            double advance = state.pending;
            const double duration = action->getClip().duration;
            if (action->loop == Loop::Repeat && duration > 0) {
                const double end = action->time + advance;
                const double seam = std::round(end / duration) * duration;
                if (std::abs(end - seam) <=
                    std::numeric_limits<double>::epsilon() * 16 *
                        std::max(duration, std::abs(end)))
                    advance = seam - action->time;
            }
            const double scale = state.elapsed > 0 ? advance / state.elapsed : scaleBeforeStep;
            if (scale != scaleBeforeStep) action->setEffectiveTimeScale(scale);
            const double before = rig.mixer->time;
            const double actionBefore = action->time;
            const bool wasScheduled = action->isScheduled();
            rig.mixer->update(state.elapsed);
            // `#advancedFrames` counts a frame the mixer's own clock moved, exactly what the JS loop
            // reads after its `mixer.update`: an action can land back on its own playhead, the clock
            // cannot.
            out.changed = rig.mixer->time != before || wasScheduled != action->isScheduled();
            // A once-clip that has reached its end on this tick is the frame `finished` fires: three
            // stops it at the last key and clamps the pose there.
            out.finished = action->loop == Loop::Once &&
                           (!action->isScheduled() ||
                            (action->time >= action->getClip().duration && action->time > actionBefore));
            state.pending = 0;
            state.elapsed = 0;
        }

        // 3. Hand the action to the next interval: the measured rate, or the rate this rule set before,
        //    taken back to none when the clip stops being locomotion. A scale the game chose is its own,
        //    and the grouped step's scale never outlives the step.
        double target = scaleBeforeStep;
        if (applies) {
            target = rate;
            state.lastRate = rate;
            state.rateApplied = true;
        } else if (measured && state.rateApplied && scaleBeforeStep == state.lastRate) {
            target = 1;
            state.lastRate = 1;
            state.rateApplied = false;
        }
        if (action->timeScale != target) action->setEffectiveTimeScale(target);
        out.strideRate = rate;
    }
    if (frame_ % 512 == 0 && states_.size() > 256) prune();
}

/** Drops the state of rigs nothing has ticked for 512 frames (about eight seconds at 60 Hz). */
void TickBatch::prune() {
    const std::uint64_t oldest = frame_ > 512 ? frame_ - 512 : 0;
    std::erase_if(states_, [&](const auto& entry) { return entry.second.lastFrame < oldest; });
}

}  // namespace tn::engine::animation
