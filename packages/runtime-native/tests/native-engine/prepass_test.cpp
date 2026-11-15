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
    Leaf solid;  // nothing cuts it: early depth already works
    solid.material.alphaTest = 0;
    CHECK(!prepassEligible(solid.item));
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
    keepDiscardsOnly(prepass.fragment);
    const auto shippedFragment = shader::buildStage(shipped.fragment, 1);
    const auto prepassFragment = shader::buildStage(prepass.fragment, 1);
    CHECK(shippedFragment.wgsl.ok() && prepassFragment.wgsl.ok());
    // The prepass cuts where the colour fragment cuts...
    CHECK(shippedFragment.wgsl.code.find("discard") != std::string::npos);
    CHECK(prepassFragment.wgsl.code.find("discard") != std::string::npos);
    // ...and shades nothing: no shadow map read (its bindings stay declared, for the layout), far less text.
    CHECK(shippedFragment.wgsl.code.find("textureSampleCompare") != std::string::npos);
    CHECK(prepassFragment.wgsl.code.find("textureSampleCompare") == std::string::npos);
    CHECK(prepassFragment.wgsl.code.size() * 3 < shippedFragment.wgsl.code.size());
    // One layout: the draw's bind groups and uniform offsets serve both pipelines.
    CHECK(sameLayout(prepassFragment, shippedFragment));
}

}  // namespace

TN_TEST_MAIN({"eligible", eligibleDraws}, {"targets", pipelineTargets}, {"fragments", fragments})
