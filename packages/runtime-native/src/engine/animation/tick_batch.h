#pragma once

// PRD-828 Phase 2: one call a frame advances every rig.
//
// The stress lab spends 1,323 crossings a frame on animation, and eight of the ten busiest crossing
// classes are animation: `setEffectiveTimeScale` 525, `getWorldPosition` 360, `isScheduled` 339,
// `set AnimationMixer.timeScale` 172, `Mixer.update` 107, then three `#evaluate` reads at 86 each.
// Each of those is a JS property read or write that crosses into Wasm to touch state that already
// lives here, so the loop that walks 120 rigs costs more than the animation does.
//
// This is the other side of that loop: the stride rule and the mixer step run over a batch of rigs
// with no crossing per rig. JS keeps what is genuinely a decision — which clip, how fast the body
// really moved, which tick poses the rig — and passes it in one span.

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
    /** The interval the body's movement is divided by; the player folds in the time it stopped measuring. */
    double dt = 0;
    /** This tick's own time. The batch banks it at the rate in force, so a grouped step integrates. */
    double elapsed = 0;
    /** True on the tick that poses the rig; a held tick measures the stride and advances nothing. */
    bool stepMixer = true;
    /** The player ran ticks the batch did not, and already spent them: drop the banked advance. */
    bool reset = false;
    /** Metres of ground the clip covers per clip-second, measured when the clip was analysed (JS side). */
    double clipGroundSpeed = 0;
    /** The game's stride convention: false measures and reports the rate but does not apply it. */
    bool strideSync = true;
};

/** What the batch did with one rig, in the order the rigs were passed. */
struct TickStatus {
    /** A once-clip reached its end on this tick: the one frame `finished` fires. */
    bool finished = false;
    /** The mixer's clock moved, or a weight or rate changed. */
    bool changed = false;
    /** The rate the stride rule chose (1 when the clip is not locomotion). */
    double strideRate = 1;
    /** Metres a second the body covered, as measured. */
    double groundSpeed = 0;
};

/**
 * The state the batch keeps between frames for one action: the advanced time it has banked but not
 * yet spent, the last measured world position and the rate this rule owns.
 */
class TickBatch {
  public:
    /**
     * Advance `rigs` one frame: hold each stride rate against the ground the body covered, then step
     * each mixer at most once. Writes one status per rig.
     *
     * The player decides *when* a rig poses and what time to spend on it — a rig in a small screen band
     * poses one frame in four, and the three frames it skips still measure the ground it covered. So a
     * tick with `stepMixer` false only measures; a tick with it true advances the mixer by the elapsed
     * time it has banked, with the action scaled to its own banked advance, so a rate that changed
     * inside the interval is integrated rather than the last rate owning the whole of it.
     *
     * ponytail: the stride position is kept per action, and a rig that changes clip pays one frame at the
     * rate floor before it measures its new clip. Keeping it on the mixer instead makes a clip change
     * exact; nothing on the stress lab changes clip mid-run, so it waits for the caller that needs it.
     */
    void run(const std::vector<TickRig>& rigs, std::vector<TickStatus>& status, const TickPolicy& policy = {});

    [[nodiscard]] std::size_t size() const { return states_.size(); }

  private:
    struct RigState {
        bool hasLast = false;
        double lastX = 0;
        double lastZ = 0;
        /** The rate this rule last applied, and whether it applied one: the game's own rate stays the game's. */
        double lastRate = 1;
        bool rateApplied = false;
        /** The rate this rule reports for a tick too short to measure, so a held tick reports a stable number. */
        double reportedRate = 1;
        /** The time this rig has banked and not yet posed: the action's own advance, and the interval it covers. */
        double pending = 0;
        double elapsed = 0;
        /** The last tick this action was seen on, so state whose action is gone can be dropped. */
        std::uint64_t lastFrame = 0;
    };
    /**
     * A state is only alive while its action ticks. An action that has not been seen for a while has
     * been destroyed — a despawned rig, a scene change — and its address may belong to a new action by
     * now, so dropping it keeps both the map and the pointer reuse bounded without the caller having to
     * report every teardown across the bridge.
     */
    void prune();
    std::uint64_t frame_ = 0;
    std::unordered_map<const AnimationAction*, RigState> states_;
};

}  // namespace tn::engine::animation
