#pragma once

// PRD-888: the masked depth prepass. A discarding fragment defeats early depth writes, so the scene inside and behind
// alpha-tested foliage is shaded many times. With TN_PREPASS, each eligible draw is drawn depth-only first, masked
// exactly as its colour fragment masks, then shaded by its shipped program at depth Equal, in the same render pass.

#include "engine/foundation/flags.h"
#include "engine/renderer/pipeline_cache.h"
#include "engine/renderer/renderer.h"
#include "engine/shader/ir.h"
#include <cstring>

namespace tn::engine {

// TN_PREPASS=1 draws the masked opaque draws depth-only first, then shades them depth-Equal with no discard. Off
// (unset or 0) is the shipped path. Read per frame, so a page toggles both arms in one load.
inline bool prepassEnabled() {
    const char* flag = flags::read<flags::Prepass>();
    return flag != nullptr && std::strcmp(flag, "0") != 0;
}

// Lever 0: TN_PREPASS=split draws the prepass rows in their own render pass, so the timer prices the depth half apart
// from the shade half (the trace names the pass `prepass`). An instrument arm: the extra MSAA depth store and load
// costs ~0.2 ms and both bundles are recorded every frame, so it is never the shipped path.
inline bool prepassSplit() {
    const char* flag = flags::read<flags::Prepass>();
    return flag != nullptr && std::strcmp(flag, "split") == 0;
}

/** An opaque, unblended, depth-tested and depth-writing triangle draw that cuts (alphaTest, alphaTestNode or
 *  maskNode), with no alphaHash and no depthNode. Every other draw keeps the shipped path. */
inline bool prepassEligible(const DrawItem& item) {
    if (!item.material || item.transparent || item.background || item.sprite || !item.depthWrite || !item.depthTest ||
        !item.colorWrite || item.topology != WGPUPrimitiveTopology_TriangleList || item.material->alphaHash ||
        item.nodes->depthNode)
        return false;
    uint32_t state = 0;
    return materialBlend(item.blending, item.transparent, item.blendFactors, state) == 0 &&
           (item.material->alphaTest > 0 || bool(item.nodes->alphaTestNode) || bool(item.nodes->maskNode));
}

/** The prepass pipeline from the draw's shipped colour target: every colour channel masked, cull, face, bias and
 *  samples unchanged. `colour` becomes the shading pipeline's: depth Equal, no depth write. */
inline PipelineTarget prepassTargets(PipelineTarget& colour) {
    PipelineTarget depthOnly = colour;
    depthOnly.colorWrite = false;
    depthOnly.materialColorWrite = false;
    colour.depthCompare = WGPUCompareFunction_Equal;
    colour.depthWrite = false;
    return depthOnly;
}

/** The prepass fragment from a colour fragment built with its discards: a zero colour (the pipeline masks every
 *  channel), then every statement no discard reads pruned, so the mask, the cutoff and the alpha they read stay exactly
 *  as the colour fragment evaluates them and the lighting goes. Its uniform layout is the colour fragment's. */
inline void keepDiscardsOnly(shader::Program& fragment) {
    fragment.output("color", fragment.construct(shader::Type::vec(4), {fragment.constant(0.f), fragment.constant(0.f),
                                                                      fragment.constant(0.f), fragment.constant(0.f)}));
    fragment.pruneDeadStatements();
}

}  // namespace tn::engine
