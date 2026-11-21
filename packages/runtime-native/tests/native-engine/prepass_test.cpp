#include "check.h"
#include "engine/renderer/prepass.h"
#include "engine/shader/package.h"
#include "engine/shader/standard.h"

// PRD-888's masked depth prepass (prepass.h): which draws take it, the two pipelines they take, and the prepass fragment.
// The prepass fragment keeps the colour fragment's discards and nothing it shades, on the colour fragment's layout, so
// one draw's bind groups serve both pipelines; the shading draw is the shipped program at depth Equal.

namespace {

using namespace tn::engine;

struct Leaf {
    shader::StandardMaterial material;
    DrawItem item;
    Leaf() {
        material.alphaTest = 0.5;
        item.material = &material;
    }
};

void eligibleDraws() {
    Leaf leaf;
    CHECK(prepassEligible(leaf.item));
    CHECK(prepassMaskedEligible(leaf.item));
    CHECK(!prepassSolidEligible(leaf.item));
    Leaf transparent;  // blended over what is behind it: refused
    transparent.item.transparent = true;
    CHECK(!prepassEligible(transparent.item));
    Leaf additive;  // an opaque AdditiveBlending material still blends
    additive.item.blending = 2;
    CHECK(!prepassEligible(additive.item));
    Leaf noDepthWrite;
    noDepthWrite.item.depthWrite = false;
    CHECK(!prepassEligible(noDepthWrite.item));
    Leaf noDepthTest;
    noDepthTest.item.depthTest = false;
    CHECK(!prepassEligible(noDepthTest.item));
    Leaf hashed;
    hashed.material.alphaHash = true;
    CHECK(!prepassEligible(hashed.item));
    Leaf solid;  // plain untextured single solid skips prepass to avoid double pipeline compiles and draws
    solid.item.kind = MaterialKind::Standard;
    solid.material.alphaTest = 0;
    CHECK(!prepassSolidEligible(solid.item));
    CHECK(!prepassEligible(solid.item));
    Leaf heavySolid;  // textured / node-shaded / instanced lit solid runs first in prepass so terrain/rocks cull foliage
    heavySolid.item.kind = MaterialKind::Standard;
    heavySolid.material.alphaTest = 0;
    shader::MaterialNodes solidNodes;
    solidNodes.colorNode = shader::graph::vec4({shader::graph::float_(1), shader::graph::float_(1),
                                              shader::graph::float_(1), shader::graph::float_(1)});
    heavySolid.item.nodes = &solidNodes;
    CHECK(prepassEligible(heavySolid.item));
    CHECK(prepassSolidEligible(heavySolid.item));
    CHECK(!prepassMaskedEligible(heavySolid.item));
    Leaf basicSolid;
    basicSolid.item.kind = MaterialKind::Basic;
    basicSolid.material.alphaTest = 0;
    CHECK(!prepassSolidEligible(basicSolid.item));
    CHECK(!prepassEligible(basicSolid.item));
    Leaf customFragment;
    customFragment.item.kind = MaterialKind::Standard;
    customFragment.material.alphaTest = 0;
    shader::MaterialNodes customNodes;
    customNodes.fragmentNode = shader::graph::vec4({shader::graph::float_(1), shader::graph::float_(0),
                                                    shader::graph::float_(0), shader::graph::float_(1)});
    customFragment.item.nodes = &customNodes;
    CHECK(!prepassSolidEligible(customFragment.item));
    CHECK(!prepassEligible(customFragment.item));
    Leaf line;
    line.item.topology = WGPUPrimitiveTopology_LineList;
    CHECK(!prepassEligible(line.item));
}

void pipelineTargets() {
    PipelineTarget shipped;
    shipped.cull = WGPUCullMode_Front;
    shipped.frontFace = WGPUFrontFace_CW;
    shipped.depthBias = 3;
    shipped.depthBiasSlopeScale = 1.5f;
    shipped.sampleCount = 4;
    PipelineTarget colour = shipped;
    const PipelineTarget depthOnly = prepassTargets(colour);
    // (a) the prepass: every colour channel masked, depth written as shipped, the same raster state.
    CHECK(!depthOnly.colorWrite && !depthOnly.materialColorWrite);
    CHECK(depthOnly.depthWrite && depthOnly.depthCompare == WGPUCompareFunction_LessEqual);
    // (b) the shading draw: Equal, no depth write, its colour written.
    CHECK(colour.depthCompare == WGPUCompareFunction_Equal && !colour.depthWrite);
    CHECK(colour.colorWrite && colour.materialColorWrite);
    for (const PipelineTarget* t : {&depthOnly, static_cast<const PipelineTarget*>(&colour)}) {
        CHECK(t->cull == shipped.cull && t->frontFace == shipped.frontFace);
        CHECK(t->depthBias == shipped.depthBias && t->depthBiasSlopeScale == shipped.depthBiasSlopeScale);
        CHECK(t->sampleCount == shipped.sampleCount && t->blend == shipped.blend);
    }
}

bool sameLayout(const shader::StageModule& a, const shader::StageModule& b) {
    if (a.uniforms.size() != b.uniforms.size() || a.bindings.size() != b.bindings.size() ||
        a.uniformBlockSize != b.uniformBlockSize)
        return false;
    for (std::size_t i = 0; i < a.uniforms.size(); ++i)
        if (a.uniforms[i].name != b.uniforms[i].name || a.uniforms[i].offset != b.uniforms[i].offset) return false;
    return true;
}

void fragments() {
    shader::VertexVariant cut;
    cut.alphaTest = true;
    cut.map = true;
    cut.alphaToCoverage = true;
    const shader::LightLayout lights{"D"};  // a shadowed sun: the lighting the prepass must not keep
    const auto shipped = shader::buildStandard(shader::StandardMaterial{}, cut, lights);
    auto prepass = shader::buildStandard(shader::StandardMaterial{}, cut, lights);
    CHECK(prepass.alpha != shader::kInvalid);
    keepDiscardsOnly(prepass.fragment, prepass.alpha);
    const auto shippedFragment = shader::buildStage(shipped.fragment, 1);
    const auto prepassFragment = shader::buildStage(prepass.fragment, 1);
    CHECK(shippedFragment.wgsl.ok() && prepassFragment.wgsl.ok());
    // The prepass cuts where the colour fragment cuts...
    CHECK(shippedFragment.wgsl.code.find("discard") != std::string::npos);
    CHECK(prepassFragment.wgsl.code.find("discard") != std::string::npos);
    // ...and keeps the faded coverage alpha without any lighting or shadow reads.
    CHECK(prepassFragment.wgsl.code.find("smoothstep") != std::string::npos);
    CHECK(prepassFragment.wgsl.code.find("fwidth") != std::string::npos);
    CHECK(shippedFragment.wgsl.code.find("textureSampleCompare") != std::string::npos);
    CHECK(prepassFragment.wgsl.code.find("textureSampleCompare") == std::string::npos);
    CHECK(prepassFragment.wgsl.code.size() * 2 < shippedFragment.wgsl.code.size());
    // One layout: the draw's bind groups and uniform offsets serve both pipelines.
    CHECK(sameLayout(prepassFragment, shippedFragment));

    // Non-alphaToCoverage cutout keeps zero colour alpha cleanly.
    cut.alphaToCoverage = false;
    auto shippedCutout = shader::buildStandard(shader::StandardMaterial{}, cut, lights);
    auto cutoutOnly = shader::buildStandard(shader::StandardMaterial{}, cut, lights);
    keepDiscardsOnly(cutoutOnly.fragment);
    const auto shippedCutoutFragment = shader::buildStage(shippedCutout.fragment, 1);
    const auto cutoutFragment = shader::buildStage(cutoutOnly.fragment, 1);
    CHECK(shippedCutoutFragment.wgsl.ok() && cutoutFragment.wgsl.ok());
    CHECK(cutoutFragment.wgsl.code.find("discard") != std::string::npos);
    CHECK(cutoutFragment.wgsl.code.find("textureSampleCompare") == std::string::npos);
    CHECK(cutoutFragment.wgsl.code.size() * 3 < shippedCutoutFragment.wgsl.code.size());

    // Solid opaque draw prepass compiles a minimal constant-zero fragment with identical layout.
    shader::VertexVariant solidVar;
    solidVar.map = true;
    auto shippedSolid = shader::buildStandard(shader::StandardMaterial{}, solidVar, lights);
    auto solidPrepass = shader::buildStandard(shader::StandardMaterial{}, solidVar, lights);
    keepDiscardsOnly(solidPrepass.fragment);
    const auto shippedSolidFrag = shader::buildStage(shippedSolid.fragment, 1);
    const auto solidPrepassFrag = shader::buildStage(solidPrepass.fragment, 1);
    CHECK(shippedSolidFrag.wgsl.ok() && solidPrepassFrag.wgsl.ok());
    CHECK(solidPrepassFrag.wgsl.code.find("discard") == std::string::npos);
    CHECK(solidPrepassFrag.wgsl.code.find("textureSampleCompare") == std::string::npos);
    CHECK(solidPrepassFrag.wgsl.code.size() * 3 < shippedSolidFrag.wgsl.code.size());
    CHECK(sameLayout(solidPrepassFrag, shippedSolidFrag));
}

void modes() {
    // TN_PREPASS defaults on when unset; `0` opts out and `split` gives depth rows their own pass.
    setenv("TN_PREPASS", "0", 1);
    CHECK(!prepassEnabled() && !prepassSplit());
    unsetenv("TN_PREPASS");
    CHECK(prepassEnabled() && !prepassSplit());
    setenv("TN_PREPASS", "1", 1);
    CHECK(prepassEnabled() && !prepassSplit());
    setenv("TN_PREPASS", "split", 1);
    CHECK(prepassEnabled() && prepassSplit());
    unsetenv("TN_PREPASS");
}

void virtualShadowEarlyOut() {
    shader::VertexVariant cut;
    cut.map = true;
    // '9' = 1-level VSM directional sun with sourceAngleShadowFilter active.
    const shader::LightLayout lights{"9"};
    const auto program = shader::buildStandard(shader::StandardMaterial{}, cut, lights);
    const auto fragment = shader::buildStage(program.fragment, 1);
    CHECK(fragment.wgsl.ok());
    const std::string& code = fragment.wgsl.code;
    const auto comparePos = code.find("textureSampleCompare");
    const auto guardPos = code.find("if ((0f < ");
    CHECK(comparePos != std::string::npos);
    CHECK(guardPos != std::string::npos);
    CHECK(guardPos < comparePos);
    const auto dpdxPos = code.find("dpdx(");
    CHECK(dpdxPos != std::string::npos);
    CHECK(dpdxPos < guardPos);
    CHECK(code.find("dpdx(", guardPos) == std::string::npos);
}

}  // namespace

TN_TEST_MAIN({"eligible", eligibleDraws}, {"targets", pipelineTargets}, {"fragments", fragments},
             {"modes", modes}, {"virtual_shadow_early_out", virtualShadowEarlyOut})
