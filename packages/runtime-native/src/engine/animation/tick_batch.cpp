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
    Vector3 world;
    for (std::size_t i = 0; i < rigs.size(); i++) {
        const TickRig& rig = rigs[i];
        TickStatus& out = status[i];
        out = TickStatus{};
        AnimationMixer* mixer = rig.mixer;
        if (mixer == nullptr) continue;
        if (rig.reset) {
            mixer->strideHasLast = false;
            mixer->stridePending = 0;
            mixer->strideElapsed = 0;
        }
        AnimationAction* action = rig.action;
        if (action == nullptr) {
            // Nothing playing: the mixer still steps, so a scheduled binding keeps three's time.
            if (rig.stepMixer) {
                const double before = mixer->time;
                mixer->update(rig.elapsed);
                out.changed = mixer->time != before;
            }
            continue;
        }
        // The rate in force *before* this tick's measurement owns this tick, exactly what the JS loop
        // banked per action (`#pendingActionTimes`). Banked here, the read is never a stale mirror.
        const double scaleBeforeStep = action->timeScale;
        mixer->stridePending += rig.elapsed * scaleBeforeStep;
        mixer->strideElapsed += rig.elapsed;

        // 1. The stride rule: how fast this clip must play to cover the ground the body covered. It
        //    chooses the rate for the *next* interval. The body belongs to the rig, not to the clip, so
        //    its last position survives a clip change and is only dropped by `reset`.
        double moved = 0;
        if (rig.strideRoot != nullptr) {
            rig.strideRoot->getWorldPosition(world);
            if (mixer->strideHasLast)
                moved = std::hypot(world.x - mixer->strideLastX, world.z - mixer->strideLastZ);
            mixer->strideLastX = world.x;
            mixer->strideLastZ = world.z;
            mixer->strideHasLast = true;
        }
        const double groundSpeed = rig.dt > 0 ? moved / rig.dt : 0;
        out.groundSpeed = groundSpeed;
        const bool measured = rig.dt > 0;
        const bool locomotion = rig.clipGroundSpeed >= policy.clipGroundFloor;
        const double rate =
            !measured ? 1.0
                      : locomotion ? (groundSpeed < policy.speedFloor
                                          ? policy.rateMin
                                          : clampRate(groundSpeed / rig.clipGroundSpeed, policy))
                                   : 1.0;
        const bool applies = measured && locomotion && rig.strideSync;

        // 2. The mixer step, by the time the increments banked. A grouped advance lands exactly on a
        //    loop seam: a rounding error past it would hold the last pose for the whole interval instead
        //    of looping, which is the seam adjustment the JS loop makes for the same reason.
        if (rig.stepMixer) {
            double advance = mixer->stridePending;
            const double duration = action->getClip().duration;
            if (action->loop == Loop::Repeat && duration > 0) {
                const double end = action->time + advance;
                const double seam = std::round(end / duration) * duration;
                if (std::abs(end - seam) <=
                    std::numeric_limits<double>::epsilon() * 16 *
                        std::max(duration, std::abs(end)))
                    advance = seam - action->time;
            }
            const double scale = mixer->strideElapsed > 0 ? advance / mixer->strideElapsed
                                                          : scaleBeforeStep;
            if (scale != scaleBeforeStep) action->setEffectiveTimeScale(scale);
            const double before = mixer->time;
            const double actionBefore = action->time;
            const bool wasScheduled = action->isScheduled();
            mixer->update(mixer->strideElapsed);
            // `#advancedFrames` counts a frame the mixer's own clock moved, exactly what the JS loop
            // reads after its `mixer.update`: an action can land back on its own playhead, the clock
            // cannot.
            out.changed = mixer->time != before || wasScheduled != action->isScheduled();
            // A once-clip that has reached its end on this tick is the frame `finished` fires: three
            // stops it at the last key and clamps the pose there.
            out.finished = action->loop == Loop::Once &&
                           (!action->isScheduled() ||
                            (action->time >= action->getClip().duration && action->time > actionBefore));
            mixer->stridePending = 0;
            mixer->strideElapsed = 0;
        }

        // 3. Hand the action to the next interval: the measured rate, or the rate this rule set before,
        //    taken back to none when the clip stops being locomotion. A scale the game chose is its own
        //    (`lastRate` is 0 then), and the grouped step's scale never outlives the step.
        double target = scaleBeforeStep;
        if (applies) target = rate;
        else if (measured && rig.lastRate != 0 && scaleBeforeStep == rig.lastRate) target = 1;
        if (action->timeScale != target) action->setEffectiveTimeScale(target);
        out.strideRate = rate;
    }
}

}  // namespace tn::engine::animation
