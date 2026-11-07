#pragma once

// PRD-828 Phase 2: one call a frame advances every rig.
//
// The stress lab spends 1,323 crossings a frame on animation, and eight of the ten busiest crossing
// classes are animation: `setEffectiveTimeScale` 525, `getWorldPosition` 360, `isScheduled` 339,
// `set AnimationMixer.timeScale` 172, `Mixer.update` 107, then three `#evaluate` reads at 86 each.
// Each of those is a JS property read or write that crosses into Wasm to touch state that already
// lives here, so the loop that walks 120 rigs costs more than the animation does.
//
// This is the other side of that loop: the weight ramp, the stride rule and the mixer step run over a
// batch of rigs with no crossing per rig. JS keeps what is genuinely a decision — which clip, which
// weight, which transition, which body moved — and passes it in one span.

#include <cstddef>
#include <cstdint>
#include <unordered_map>
#include <vector>

#include "engine/animation/mixer.h"
#include "engine/foundation/math/Vector.h"

namespace tn::engine {
class Object3D;
}

namespace tn::engine::animation {

/**
 * three's rates and floors, mirrored from `packages/core/src/animation.ts` (`STRIDE_RATE_MIN`,
 * `STRIDE_RATE_MAX`, `STRIDE_SPEED_FLOOR`, `CLIP_GROUND_FLOOR`). A game changes them through the
 * player's options, not through this file; they are the defaults the batch runs when nothing overrides.
 */
struct TickPolicy {
    double rateMin = 0.15;
    double rateMax = 3;
    /** Below this a body is standing still: the stride rule clamps to `rateMin` instead of dividing. */
    double speedFloor = 1e-4;
    /** A clip whose own ground speed is under this is not locomotion (an idle, a reload, a death). */
    double clipGroundFloor = 1e-3;
};

/** What one rig asks of the batch. Pointers are engine objects; the caller owns their lifetime. */
struct TickRig {
    AnimationMixer* mixer = nullptr;
    /** The rig's current action, or null for a rig with nothing playing (its mixer still steps). */
    AnimationAction* action = nullptr;
    /** The body the game moves, whose world position the stride is measured from; null records no movement. */
    Object3D* strideRoot = nullptr;
    /** Where the weight ramp is heading, and how long it takes; a zero transition is "now". */
    double targetWeight = 1;
    double transition = 0;
    double dt = 0;
    /** Metres of ground the clip covers per clip-second, measured when the clip was analysed (JS side). */
    double clipGroundSpeed = 0;
    /** The game's stride convention: false measures and reports the rate but does not apply it. */
    bool strideSync = true;
};

/** What the batch did with one rig, in the order the rigs were passed. */
struct TickStatus {
    /** A once-clip reached its end on this tick: the one frame `finished` fires. */
    bool finished = false;
    /** The pose advanced, or a weight or rate changed. */
    bool changed = false;
    /** The rate the stride rule chose (1 when the clip is not locomotion). */
    double strideRate = 1;
    /** Metres a second the body covered, as measured. */
    double groundSpeed = 0;
};

/**
 * The per-rig state the batch keeps between frames: the last measured world position, and the ramp it
 * is in the middle of. Keyed by action, so a rig that switches clips starts a clean ramp.
 */
class TickBatch {
  public:
    /**
     * Advance `rigs` one frame: ramp each weight towards its target, hold each stride rate against the
     * ground the body covered, then step each mixer once. Writes one status per rig.
     *
     * ponytail: one ramp per action, linear in real time, which is what a blend of one clip needs.
     * A rig with several contributing clips keeps its ramp in JS until the blend path moves here too.
     */
    void run(const std::vector<TickRig>& rigs, std::vector<TickStatus>& status, const TickPolicy& policy = {});

    /** Drops the state of rigs whose actions are gone; the batch never owns an engine object. */
    void forget(const AnimationAction* action);
    void clear();

    [[nodiscard]] std::size_t size() const { return states_.size(); }

  private:
    struct RigState {
        bool hasLast = false;
        double lastX = 0;
        double lastZ = 0;
        double rampFrom = 1;
        double rampElapsed = 0;
        double rampDuration = 0;
        double rampTarget = 1;
    };
    std::unordered_map<const AnimationAction*, RigState> states_;
};

}  // namespace tn::engine::animation
