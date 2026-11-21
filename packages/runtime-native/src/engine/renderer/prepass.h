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

// TN_PREPASS defaults to on (`1`): draws masked opaque draws depth-only first, then shades depth-Equal.
// `TN_PREPASS=0` is the named opt-out override; `TN_PREPASS=split` times the depth pass separately. Read per frame.
inline bool prepassEnabled() {
    const char* flag = flags::read<flags::Prepass>();
    return flag == nullptr || std::strcmp(flag, "0") != 0;
}

// Lever 0: TN_PREPASS=split draws the prepass rows in their own render pass, so the timer prices the depth half apart
// from the shade half (the trace names the pass `prepass`). An instrument arm: the depth half pays an extra MSAA store
// and load, measured under 1 ms, and the scene pass runs in two passes instead of one.
inline bool prepassSplit() {
    const char* flag = flags::read<flags::Prepass>();
    return flag != nullptr && std::strcmp(flag, "split") == 0;
}

/** An opaque, unblended, depth-tested and depth-writing triangle draw with no alphaHash and no depthNode. */
inline bool prepassBaseEligible(const DrawItem& item) {
    if (!item.material || item.transparent || item.background || item.sprite || !item.depthWrite || !item.depthTest ||
        !item.colorWrite || item.topology != WGPUPrimitiveTopology_TriangleList || item.material->alphaHash ||
        item.nodes->depthNode)
        return false;
    uint32_t state = 0;
    return materialBlend(item.blending, item.transparent, item.blendFactors, state) == 0;
}

/** A masked prepass draw that cuts (alphaTest, alphaTestNode, maskNode) or uses alphaToCoverage. */
inline bool prepassMaskedEligible(const DrawItem& item) {
    return prepassBaseEligible(item) &&
           (item.material->alphaTest > 0 || bool(item.nodes->alphaTestNode) || bool(item.nodes->maskNode) ||
            item.material->alphaToCoverage);
}

/** A heavy solid opaque lit draw (no cut, no custom fragmentNode that might issue an unlisted discard) that carries
 *  textures, material node overrides, instancing or indirect draws. Drawn before masked prepass draws so terrain,
 *  rocks and instanced trunks reject occluded masked foliage and avoid scene overdraw, while trivial untextured
 *  single meshes and unlit Basic draws skip prepass to avoid double pipeline compiles and draws. */
inline bool prepassSolidEligible(const DrawItem& item) {
    if (!prepassBaseEligible(item) || prepassMaskedEligible(item) || item.kind == MaterialKind::Basic ||
        item.nodes->fragmentNode) {
        return false;
    }
    for (const Texture* pbr : item.pbrMaps) {
        if (pbr != nullptr) return true;
    }
    return item.map != nullptr || item.normalMap != nullptr || bool(item.nodes->colorNode) ||
           bool(item.nodes->normalNode) || bool(item.nodes->roughnessNode) || bool(item.nodes->metalnessNode) ||
           bool(item.nodes->aoNode) || bool(item.nodes->emissiveNode) || item.instanceMatrices != nullptr ||
           item.indirect != nullptr;
}

/** An opaque draw eligible for depth-only prepass (solid first, then masked), shaded depth-Equal in the scene pass. */
inline bool prepassEligible(const DrawItem& item) {
    return prepassMaskedEligible(item) || prepassSolidEligible(item);
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
 *  channel), or `vec4(0, 0, 0, alpha)` when preserving alpha-to-coverage sample masks, then every statement no
 *  discard/alpha reads pruned, so the mask, cutoff and alpha stay exact while lighting goes. Its uniform layout is
 *  the colour fragment's. */
inline void keepDiscardsOnly(shader::Program& fragment, shader::ExprId alpha = shader::kInvalid) {
    fragment.output("color", fragment.construct(shader::Type::vec(4), {fragment.constant(0.f), fragment.constant(0.f),
                                                                      fragment.constant(0.f),
                                                                      alpha != shader::kInvalid ? alpha : fragment.constant(0.f)}));
    fragment.pruneDeadStatements();
}

}  // namespace tn::engine
