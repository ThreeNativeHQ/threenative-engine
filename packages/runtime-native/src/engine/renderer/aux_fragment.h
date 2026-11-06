#pragma once

// Which fragment the aux pass draws a pipeline with (Renderer::renderPrepared's planAux). The small normal-only
// fragment declares one colour output, so it fits a pass that holds one colour target: the normal target alone, with
// no custom MRT slot. A pass with a custom slot holds a further attachment every pipeline must write, so the merged
// aux fragment (one output per target) draws there. WebGPU refuses a pipeline whose declared target has no fragment
// output, which is what named this rule: TN_NATIVE_PIPELINE_REFUSED, "targets[1] ... is not zero".

namespace tn::engine {

/**
 * Whether the aux pass can draw a pipeline with the small normal-only fragment: the pass holds exactly the normal
 * target. `anyCustomSlot` is false when the frame's MRT names no custom slot.
 */
inline bool smallNormalFragmentFits(bool normalTargetOnly, bool anyCustomSlot) {
    return normalTargetOnly && !anyCustomSlot;
}

}  // namespace tn::engine
