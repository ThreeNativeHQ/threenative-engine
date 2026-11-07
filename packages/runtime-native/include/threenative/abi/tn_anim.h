#pragma once
#include "threenative/abi/tn_abi.h"
#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif
/* PRD-828: one call a frame advances a batch of animation rigs.
 *
 * An animation rig on the web engine is a JS loop that reads and writes engine state per rig and
 * per action: the stress lab measured 1,323 crossings a frame with eight of the ten busiest classes
 * in that loop. This entry point takes the loop's decisions as data (which clip, which weight, how
 * long the transition takes, how far the body moved) and runs the ramp, the stride rule and one
 * `AnimationMixer::update` per rig without a crossing per rig.
 *
 * `handles` is three `tn_handle_t` per rig: the mixer, the action, and the body the stride is measured
 * from. `rigs` is five doubles per rig: the stride interval (seconds the body's movement is divided by),
 * this tick's own time, the clip's own ground speed in metres per clip-second, the rate this rule last
 * applied (0 for none, which is how the caller says the action's scale is the game's), and a flags word.
 * The flags say: bit 0 the game's stride convention applies, bit 1 the action handle is real, bit 2 the
 * stride body handle is real, bit 3 this tick poses the rig (a held tick only measures), bit 4 the player
 * ran ticks this batch did not, so the rig's banked advance and its last measured position are stale. A
 * slot that is not real repeats the mixer's handle, because a zeroed handle aliases the first context.
 * `status` is three doubles per rig: the stride rate the rule chose (1 for a zero interval, which the
 * caller ignores), the ground speed it measured, and a flags word (bit 0: a once-clip finished on this
 * tick; bit 1: the mixer's clock moved or a rate changed).
 *
 * The rig keeps the frame state, on its own mixer: the last ground position of the body and the advance
 * banked on held ticks. One mixer is one rig, so a clip change measures the same body continuously, and
 * the call itself is stateless.
 *
 * The engine banks each tick's own time at the rate in force, so an interval the mixer poses once comes
 * out at the same time as one it poses every frame: a rate that changed inside the interval is
 * integrated instead of the last rate owning the whole of it. That is also why the caller passes no
 * scale and reads none back — a scale read after a call would be a stale JS mirror of engine state.
 *
 * Rigs are advanced in the order given. The batch keeps one ramp and one last position per action;
 * a null action still steps its mixer. Nothing here allocates an engine object: the caller owns every
 * handle's lifetime. */
#define TN_ANIM_MIXER 0u
#define TN_ANIM_ACTION 1u
#define TN_ANIM_STRIDE_ROOT 2u
#define TN_ANIM_RIG_STRIDE_SYNC (1u << 0)
#define TN_ANIM_RIG_ACTION (1u << 1)
#define TN_ANIM_RIG_BODY (1u << 2)
#define TN_ANIM_RIG_STEP (1u << 3)
#define TN_ANIM_RIG_RESET (1u << 4)
#define TN_ANIM_RIG_VALUES 5u
#define TN_ANIM_STATUS_FINISHED (1u << 0)
#define TN_ANIM_STATUS_CHANGED (1u << 1)
TN_EXPORT tn_status_t tn_anim_tick(tn_context_t *context, const tn_handle_t *handles,
                                   const double *rigs, uint32_t count, double *status,
                                   tn_diagnostic_t *diagnostic);
#ifdef __cplusplus
}
#endif
