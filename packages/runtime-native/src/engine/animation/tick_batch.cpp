// PRD-828 Phase 2: the per-frame animation loop, on the C++ side of the bridge.

#include "engine/animation/tick_batch.h"

#include <algorithm>
#include <cmath>
#include <limits>

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
                rig.mixer->update(rig.mixerElapsed);
                out.changed = rig.mixerElapsed > 0;
            }
            continue;
        }
        RigState& state = states_[action];
        state.lastFrame = frame_;

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

        // 2. The stride rule: how fast this clip must play to cover the ground the body covered. It
        //    chooses the rate for the *next* interval, so it reads the scale the step is about to
        //    use before the step touches it.
        const double scaleBeforeStep = action->timeScale;
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

        // 3. The mixer step. The player banks a held tick's action time, so the interval's advance is
        //    the sum of the rates it ran under: scale the action to that sum over this interval, and
        //    land a grouped advance exactly on a loop seam rather than a rounding error past it, which
        //    would hold the last pose for the whole interval instead of looping.
        if (rig.stepMixer) {
            double advance = rig.actionPending;
            const double duration = action->getClip().duration;
            if (action->loop == Loop::Repeat && duration > 0) {
                const double end = action->time + advance;
                const double seam = std::round(end / duration) * duration;
                if (std::abs(end - seam) <=
                    std::numeric_limits<double>::epsilon() * 16 *
                        std::max(duration, std::abs(end)))
                    advance = seam - action->time;
            }
            const double scale =
                rig.mixerElapsed > 0 ? advance / rig.mixerElapsed : scaleBeforeStep;
            if (scale != scaleBeforeStep) action->setEffectiveTimeScale(scale);
            const double before = rig.mixer->time;
            const bool wasScheduled = action->isScheduled();
            rig.mixer->update(rig.mixerElapsed);
            // `#advancedFrames` counts a frame the mixer's own clock moved, exactly what the JS loop
            // reads after its `mixer.update`: an action can land back on its own playhead, the clock
            // cannot.
            out.changed = rig.mixer->time != before || wasScheduled != action->isScheduled();
            // A once-clip that has reached its end on this tick is the frame `finished` fires: three
            // stops it at the last key and clamps the pose there.
            out.finished = action->loop == Loop::Once &&
                           (!action->isScheduled() ||
                            (action->time >= action->getClip().duration && action->time > before));
        }

        // 4. Hand the action to the next interval: the measured rate, or the authored one when this
        //    clip is not locomotion — but only the rate this rule set is ever taken back. A time scale
        //    the game chose is the game's, and the report says `overridden` rather than clobbering it.
        if (applies) {
            if (action->timeScale != rate) action->setEffectiveTimeScale(rate);
            state.lastRate = rate;
            state.rateApplied = true;
        } else if (measured && state.rateApplied && scaleBeforeStep == state.lastRate) {
            action->setEffectiveTimeScale(1);
            state.lastRate = 1;
            state.rateApplied = false;
        }
        out.strideRate = rate;
    }
    if (frame_ % 512 == 0 && states_.size() > 256) prune();
}

/** Drops the state of rigs nothing has ticked for 512 frames (about eight seconds at 60 Hz). */
void TickBatch::prune() {
    const std::uint64_t oldest = frame_ > 512 ? frame_ - 512 : 0;
    std::erase_if(states_, [&](const auto& entry) { return entry.second.lastFrame < oldest; });
}

void TickBatch::forget(const AnimationAction* action) { states_.erase(action); }

void TickBatch::clear() { states_.clear(); }

}  // namespace tn::engine::animation
