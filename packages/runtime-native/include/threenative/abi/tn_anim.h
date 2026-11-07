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
 * from. `rigs` is five doubles per rig: target weight, transition seconds (0 = now), dt, the clip's own
 * ground speed in metres per clip-second, and a flags word — bit 0 the game's stride convention
 * applies, bit 1 the action handle is real, bit 2 the stride body handle is real. A slot that is not
 * real repeats the mixer's handle, because a zeroed handle aliases the first context. `status` is three
 * doubles per rig: the stride rate the rule chose, the ground speed it measured, and a flags word
 * (bit 0: a once-clip finished on this tick; bit 1: the pose, weight or rate changed).
 *
 * Rigs are advanced in the order given. The batch keeps one ramp and one last position per action;
 * a null action still steps its mixer. Nothing here allocates an engine object: the caller owns every
 * handle's lifetime. */
#define TN_ANIM_MIXER 0u
#define TN_ANIM_ACTION 1u
#define TN_ANIM_STRIDE_ROOT 2u
#define TN_ANIM_STATUS_FINISHED (1u << 0)
#define TN_ANIM_STATUS_CHANGED (1u << 1)
TN_EXPORT tn_status_t tn_anim_tick(tn_context_t *context, const tn_handle_t *handles,
                                   const double *rigs, uint32_t count, double *status,
                                   tn_diagnostic_t *diagnostic);
#ifdef __cplusplus
}
#endif
