#pragma once

// PRD-888: the masked depth prepass. A discarding fragment defeats early depth writes, so the scene inside and behind
// alpha-tested foliage is shaded many times. With TN_PREPASS, each eligible draw is drawn depth-only first, masked
// exactly as its colour fragment masks, then shaded by its shipped program at depth Equal, in the same render pass.

#include "engine/renderer/pipeline_cache.h"
#include "engine/renderer/renderer.h"
#include "engine/shader/ir.h"

namespace tn::engine {

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
