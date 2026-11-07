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
//
// The batch holds no state of its own: a rig's frame state lives on its `AnimationMixer`
// (`strideHasLast`, `stridePending`, `strideElapsed`), which is one per rig, so nothing here is keyed by
// a pointer that can be freed and reused, and nothing has to be pruned.

#include <cstddef>
#include <cstdint>
#include <vector>

#include "engine/animation/mixer.h"
#include "engine/foundation/math/Vector.h"

namespace tn::engine {
class Object3D;
}

namespace tn::engine::animation {

/**
 * three's rates and floors, mirrored from `packages/core/src/animation.ts` (`STRIDE_RATE_MIN`,
 * `STRIDE_RATE_MAX`, `STRIDE_SPEED_FLOOR`, `CLIP_GROUND_FLOOR`). They are the defaults the batch runs;
 * a game changes them through the player's own options, not through this file.
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
    /** The player spent ticks the batch did not, so the rig's bank and last position are stale. */
    bool reset = false;
    /**
     * The rate this rule last applied, or 0 for none. JS owns that answer, because it is the side that
     * decides whether the stride convention applies at all; passing it keeps the action itself free of
     * bookkeeping, and the take-back rule can then put back only a rate this rule wrote.
     */
    double lastRate = 0;
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
    /** The rate the stride rule chose (1 when the clip is not locomotion; unchanged for a `dt` of 0). */
    double strideRate = 1;
    /** Metres a second the body covered, as measured. */
    double groundSpeed = 0;
};

/** The per-frame animation batch. Stateless: everything it keeps between frames lives on the rig. */
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
     */
    void run(const std::vector<TickRig>& rigs, std::vector<TickStatus>& status, const TickPolicy& policy = {});
};

}  // namespace tn::engine::animation
