#include "check.h"
#include "engine/shader/standard.h"
#include "engine/shader/wgsl.h"
#include "engine/shader/package.h"
#include "engine/shader/graph/post_effects.h"
#include "engine/shader/tsl/tsl.h"

#include <bit>
#include <cmath>
#include <algorithm>
#include <cstdio>
#include <set>
#include <string>
#include <stdexcept>

using namespace tn::engine::shader;

namespace {

float scalar(const Program& p, ExprId id) {
    const Expr& e = p.expr(id);
    const auto arg = [&](int i) { return scalar(p, e.args[i]); };
    switch (e.op) {
        case Op::Constant: return std::bit_cast<float>(static_cast<uint32_t>(e.immediate));
        case Op::Mul: return arg(0) * arg(1);
        case Op::Sub: return arg(0) - arg(1);
        case Op::Neg: return -arg(0);
        case Op::Call:
            if (e.argc == 1) return std::exp(arg(0));
            if (e.argc == 3) { const float t = std::clamp((arg(2) - arg(0)) / (arg(1) - arg(0)), 0.0f, 1.0f); return t * t * (3 - 2 * t); }
            break;
        default: break;
    }
    CHECK(false); return NAN;
}

// Every varying the fragment reads sits at the location the vertex stage writes it, as WebGPU's
// inter-stage interface requires.
void stagesAgree(const Program& fragment, const std::string& vertex, const std::string& code) {
    for (const auto& [name, type] : fragment.varyings()) {
        const auto at = code.find("i_" + name + ":");
        const auto location = code.rfind("@location(", at);
        const auto end = code.find(')', location);
        const bool linked = vertex.find(code.substr(location, end - location + 1) + " o_" + name + ":") != std::string::npos;
        if (!linked) std::fprintf(stderr, "varying %s: fragment %s, vertex elsewhere\n", name.c_str(), code.substr(location, end - location + 1).c_str());
        CHECK(linked);
    }
}

// three r187 builds the flat alphaTest cutoff only when alphaTest > 0 (NodeMaterial.setupDiffuseColor). A discard the
// program always carries turns early depth testing off for every opaque draw: the forest spawn view's terrain, rocks
// and trunks paid it on the engine and not on three (PRD-858). An alphaTestNode still tests always.
void alphaTestCompiled() {
    for (int material = 0; material < 5; ++material)
        for (int mode = 0; mode < 3; ++mode) {
            VertexVariant variant;
            variant.alphaTest = mode == 1;
            if (mode == 2) variant.nodes.alphaTestNode = tn::engine::shader::graph::float_(0.5);
            const auto p = material == 0 ? buildBasic(variant) : material == 1 ? buildLambert(variant) :
                material == 2 ? buildPhong(variant) : material == 3 ? buildStandard({}, variant) : buildPhysical({}, variant);
            const auto fs = buildStage(p.fragment, 1);
            CHECK(fs.wgsl.ok());
            CHECK((fs.wgsl.code.find("discard") != std::string::npos) == (mode != 0));
        }
    VertexVariant opaque, cut;
    cut.alphaTest = true;
    CHECK(opaque.key() != cut.key());
}
void alphaHash() {
    VertexVariant variant;
    variant.alphaHash = true;
    variant.map = true;
    for (int material = 0; material < 5; ++material) {
        const auto p = material == 0 ? buildBasic(variant) : material == 1 ? buildLambert(variant) :
            material == 2 ? buildPhong(variant) : material == 3 ? buildStandard({}, variant) : buildPhysical({}, variant);
        const auto vs = buildStage(p.vertex, 0), fs = buildStage(p.fragment, 1);
        for (const auto& e : fs.wgsl.errors) std::fprintf(stderr, "%s\n", e.c_str());
        CHECK(vs.wgsl.ok() && fs.wgsl.ok());
        if (!vs.wgsl.ok() || !fs.wgsl.ok()) continue;
        CHECK(fs.wgsl.code.find("dpdx(") != std::string::npos);
        CHECK(fs.wgsl.code.find("i_positionLocal") != std::string::npos);
        // PRD-539 lever 7: the map reads at the renderer's view mip bias, Unreal's upscaled-view rule.
        CHECK(fs.wgsl.code.find("textureSampleBias(t_map, smp_map,") != std::string::npos);
        CHECK(fs.wgsl.code.find("u.f_viewMipBias") != std::string::npos);
        stagesAgree(p.fragment, vs.wgsl.code, fs.wgsl.code);
    }
    const auto depth = buildDepth(variant);
    const auto vs = buildStage(depth.vertex, 0), fs = buildStage(depth.fragment, 1);
    CHECK(vs.wgsl.ok() && fs.wgsl.ok());
    CHECK(fs.wgsl.code.find("@builtin(frag_depth)") != std::string::npos);
    // The shadow pass leaves viewMipBias zero-filled: Unreal's shadow views sample at bias 0.
    CHECK(fs.wgsl.code.find("textureSampleBias(t_map") != std::string::npos);
    CHECK(fs.wgsl.code.find("dpdx(") != std::string::npos);
    stagesAgree(depth.fragment, vs.wgsl.code, fs.wgsl.code);
    CHECK(variant.key() != VertexVariant{}.key());
}

void fog() {
    for (float z : {0.0f, 2.0f, 6.0f, 10.0f, 25.0f}) {
        Program p(Stage::Fragment);
        const auto range = fogFactor(p, 1, p.constant(z), p.constant(2.0f), p.constant(10.0f));
        const float t = std::clamp((z - 2) / 8, 0.0f, 1.0f);
        CHECK(scalar(p, range) == t * t * (3 - 2 * t));
        const auto density = fogFactor(p, 2, p.constant(z), p.constant(0.12f), kInvalid);
        CHECK(std::abs(scalar(p, density) - (1 - std::exp(-0.12f * 0.12f * z * z))) < 1e-7);
        p.output("color", p.construct(Type::vec(4), {p.construct(Type::vec(3), {p.load(p.var(Type::f32(), density))}), p.constant(1.0f)}));
        CHECK(p.ok()); CHECK(WgslEmitter::emit(p).ok());
    }
    for (uint8_t kind : {1, 2}) for (int material = 0; material < 5; ++material) {
        VertexVariant variant; variant.fog = kind;
        const auto p = material == 0 ? buildBasic(variant) : material == 1 ? buildLambert(variant) :
            material == 2 ? buildPhong(variant) : material == 3 ? buildStandard({}, variant) : buildPhysical({}, variant);
        CHECK(p.vertex.ok() && p.fragment.ok());
        const auto code = WgslEmitter::emit(p.fragment);
        CHECK(code.ok()); CHECK(code.code.find(kind == 1 ? "smoothstep(" : "exp(") != std::string::npos);
        CHECK(code.code.find("fogColor") != std::string::npos);
        CHECK(code.code.find("positionView") != std::string::npos);
        variant.map = true;
        const auto mapped = buildBasic(variant);
        const auto vs = buildStage(mapped.vertex, 0), fs = buildStage(mapped.fragment, 1);
        CHECK(vs.wgsl.ok() && fs.wgsl.ok());
        CHECK(vs.wgsl.code.find("@location(0) o_uv") != std::string::npos);
        CHECK(fs.wgsl.code.find("@location(0) i_uv") != std::string::npos);
        CHECK(vs.wgsl.code.find("@location(1) o_positionView") != std::string::npos);
        CHECK(fs.wgsl.code.find("@location(1) i_positionView") != std::string::npos);
    }
    const auto cube = buildEquirectangularCube();
    CHECK(cube.vertex.ok() && cube.fragment.ok());
    CHECK(WgslEmitter::emit(cube.vertex).ok() && WgslEmitter::emit(cube.fragment).ok());
    VertexVariant sky; sky.background = sky.map = true;
    const auto p = buildBasic(sky);
    CHECK(p.vertex.ok() && p.fragment.ok());
    const auto code = WgslEmitter::emit(p.fragment);
    CHECK(code.ok() && code.code.find("texture_cube<f32>") != std::string::npos);
    CHECK(code.code.find("fogColor") == std::string::npos);
    // Background.js always writes alpha 1, independent of texture alpha or material opacity.
    CHECK(code.code.find("f_opaque") == std::string::npos);
    CHECK(code.code.find("f_alphaTest") == std::string::npos);
    const auto output = code.code.find("out.color = ");
    CHECK(output != std::string::npos);
    // NodeMaterial.setup's max(0) clamp wraps it; the alpha lane is still the literal 1.
    CHECK(code.code.substr(output, code.code.find('\n', output) - output).ends_with(", 1f), vec4<f32>(0f));"));
}

// scene.fogNode (a vec4(color, factor) on the draw item's nodes) is mixed into the finished colour of every
// mesh material, in place of the built-in scene.fog uniforms: NodeMaterial.setupFog before tone mapping.
void fogNodeMixesColor() {
    for (int material = 0; material < 5; ++material) {
        VertexVariant variant;
        variant.nodes.fogNode = graph::vec4({graph::uniform("hazeColor", Type::vec(3), {0.1, 0.2, 0.3}), graph::float_(0.3125)});
        const auto p = material == 0 ? buildBasic(variant) : material == 1 ? buildLambert(variant) :
            material == 2 ? buildPhong(variant) : material == 3 ? buildStandard({}, variant) : buildPhysical({}, variant);
        CHECK(p.vertex.ok() && p.fragment.ok());
        const auto code = WgslEmitter::emit(p.fragment);
        CHECK(code.ok());
        CHECK(code.code.find("0.3125f") != std::string::npos);
        CHECK(code.code.find("fogColor") == std::string::npos);
    }
}

// NodeMaterial.depthNode becomes @builtin(frag_depth) in every mesh material's fragment stage.
void depthNodeWritesFragDepth() {
    for (int material = 0; material < 5; ++material) {
        VertexVariant variant;
        variant.nodes.depthNode = graph::float_(0.25);
        const auto p = material == 0 ? buildBasic(variant) : material == 1 ? buildLambert(variant) :
            material == 2 ? buildPhong(variant) : material == 3 ? buildStandard({}, variant) : buildPhysical({}, variant);
        const auto fs = buildStage(p.fragment, 1);
        CHECK(fs.wgsl.ok());
        if (fs.wgsl.code.find("@builtin(frag_depth)") == std::string::npos) std::fprintf(stderr, "material %d: no frag_depth\n", material);
        CHECK(fs.wgsl.code.find("@builtin(frag_depth)") != std::string::npos);
        VertexVariant plain;
        const auto q = material == 0 ? buildBasic(plain) : buildLambert(plain);
        CHECK(buildStage(q.fragment, 1).wgsl.code.find("frag_depth") == std::string::npos);
    }
}

// A node two slots read lowers once, as three builds a material once: the rain coast quad's one
// 148-step raymarch feeds both its colour and its depth, and a lowering per slot compiled it twice and
// ran it twice on every pixel. Every mesh program's slots (colour, depth, emissive) share one lowering.
void slotsShareOneLowering() {
    graph::Block block;
    const auto sum = block.var(graph::float_(0));
    block.Loop(4, [&](graph::Node index) { block.assign(sum, graph::add(sum.read(), graph::float_(index))); });
    auto march = std::make_shared<graph::NodeData>(*block.node());
    march->args = {sum.read()};
    const graph::Node shared = march;
    const auto loops = [](const std::string& code) {
        std::size_t count = 0;
        for (auto at = code.find("for ("); at != std::string::npos; at = code.find("for (", at + 1)) ++count;
        return count;
    };
    // The fragmentNode path (Basic only) and the colorNode path (all five programs).
    for (int material = -1; material < 5; ++material) {
        VertexVariant variant;
        if (material < 0) variant.nodes.fragmentNode = graph::vec3({shared, shared, shared});
        else variant.nodes.colorNode = graph::vec4({shared, shared, shared, graph::float_(1)});
        variant.nodes.depthNode = shared;
        const int kind = material < 0 ? 0 : material;
        const auto p = kind == 0 ? buildBasic(variant) : kind == 1 ? buildLambert(variant) :
            kind == 2 ? buildPhong(variant) : kind == 3 ? buildStandard({}, variant) : buildPhysical({}, variant);
        const auto fs = buildStage(p.fragment, 1);
        CHECK(fs.wgsl.ok());
        const std::size_t n = loops(fs.wgsl.code);
        if (n != 1) std::fprintf(stderr, "material %d (%s): shared march lowered %zu times\n", kind, material < 0 ? "fragmentNode" : "colorNode", n);
        CHECK(n == 1);
    }
}

void unsupported() {
    // Defaults are the pinned MeshStandardMaterial constructor's.
    const StandardMaterial defaults;
    CHECK(defaults.color[0] == 1 && defaults.roughness == 1 && defaults.metalness == 0 && defaults.opacity == 1);
    CHECK(unsupportedFeatures(defaults).empty());

    struct Case {
        const char* feature;
        float StandardMaterial::*field;
    };
    const Case cases[] = {{"sheen", &StandardMaterial::sheen},             {"transmission", &StandardMaterial::transmission},
                          {"iridescence", &StandardMaterial::iridescence}, {"anisotropy", &StandardMaterial::anisotropy},
                          {"dispersion", &StandardMaterial::dispersion}};
    for (const Case& c : cases) {
        StandardMaterial m;
        m.*c.field = 0.5f;
        const StandardPrograms programs = buildStandard(m);
        CHECK(programs.diagnostics.size() == 1);
        CHECK(!programs.diagnostics.empty() &&
              programs.diagnostics[0] == std::string("TN_MATERIAL_UNSUPPORTED ") + c.feature);
    }
    // Never a silent fallback: a refused material produces no shader at all.
    StandardMaterial sheen;
    sheen.sheen = 1;
    CHECK(buildStandard(sheen).fragment.exprCount() == 0);
    // Clearcoat is ported: the physical program builds its layer (the materials-physical-clearcoat* goldens).
    StandardMaterial coated;
    coated.clearcoat = 1;
    VertexVariant coatedVariant;
    coatedVariant.clearcoat = true;
    const StandardPrograms coatedPrograms = buildPhysical(coated, coatedVariant);
    CHECK(coatedPrograms.diagnostics.empty());
    CHECK(coatedPrograms.fragment.exprCount() > buildPhysical(coated).fragment.exprCount());
}

// The post surface pass reads metalness and roughness at offsets 0 and 4 of every standard fragment block,
// for any lighting layout and for physical materials; a node that replaces either removes the pair.
void surfacePrefix() {
    namespace g = tn::engine::shader::graph;
    for (const bool physical : {false, true}) {
        VertexVariant plain;
        const auto programs = physical ? buildPhysical({}, plain) : buildStandard({}, plain);
        const auto fragment = buildStage(programs.fragment, 1);
        CHECK(fragment.wgsl.ok() && fragment.uniforms.size() > 2);
        CHECK(fragment.uniforms[0].name == "metalness" && fragment.uniforms[0].offset == 0);
        CHECK(fragment.uniforms[1].name == "roughness" && fragment.uniforms[1].offset == 4);
    }
    VertexVariant replaced;
    replaced.nodes.roughnessNode = g::swizzle(g::uv(), "x");
    const auto fragment = buildStage(buildStandard({}, replaced).fragment, 1);
    CHECK(fragment.wgsl.ok());
    CHECK(fragment.uniforms.empty() || fragment.uniforms[0].name != "metalness");
}

// NodeMaterial.aoNode darkens indirect light: the node's uniform enters the standard fragment, the slot is part of the
// program key, and a material without it compiles to a program that never mentions it.
void aoNode() {
    namespace g = tn::engine::shader::graph;
    VertexVariant plain;
    VertexVariant occluded;
    occluded.nodes.aoNode = g::uniform("nodeAo", Type::f32(), {0.25f});
    CHECK(plain.key() != occluded.key());
    const auto without = WgslEmitter::emit(buildStandard(StandardMaterial{}, plain).fragment, 1);
    const auto with = WgslEmitter::emit(buildStandard(StandardMaterial{}, occluded).fragment, 1);
    CHECK(without.ok() && with.ok());
    CHECK(without.code.find("f_nodeAo") == std::string::npos);
    CHECK(with.code.find("f_nodeAo") != std::string::npos);
}

// NodeMaterial.maskNode (three r187 setupDiffuseColor): a false mask discards the colour-pass fragment. The binding
// had no maskNode setter, so a game's mask stayed a JS expando and every pixel drew: a near-camera tree fade did
// nothing on the default engine. The slot is part of the program key, and each colour builder adds one discard.
void maskNode() {
    namespace g = tn::engine::shader::graph;
    VertexVariant plain;
    VertexVariant masked;
    masked.nodes.maskNode = g::lessThan(g::uniform("nodeFade", Type::f32(), {0.5f}), g::float_(0.25));
    CHECK(plain.key() != masked.key());
    const auto discards = [](const std::string& code) {
        std::size_t count = 0;
        for (std::size_t at = code.find("discard"); at != std::string::npos; at = code.find("discard", at + 1)) ++count;
        return count;
    };
    const std::pair<Program, Program> pairs[] = {
        {buildStandard(StandardMaterial{}, plain).fragment, buildStandard(StandardMaterial{}, masked).fragment},
        {buildLambert(plain).fragment, buildLambert(masked).fragment},
        {buildBasic(plain).fragment, buildBasic(masked).fragment},
    };
    for (const auto& [without, with] : pairs) {
        const auto a = WgslEmitter::emit(without, 1), b = WgslEmitter::emit(with, 1);
        CHECK(a.ok() && b.ok());
        CHECK(a.code.find("f_nodeFade") == std::string::npos);
        CHECK(b.code.find("f_nodeFade") != std::string::npos);
        CHECK(discards(b.code) == discards(a.code) + 1);
    }
}

// The masked shadow depth fragment as three r187's shadow pass builds it (Renderer._getShadowNodes): the caster's
// shadow mask (`maskShadowNode || maskNode`, which the renderer hands in the maskNode slot) discards, and the alpha
// takes the colorNode's alpha. Without both, an impostor quad (no map, alpha 1, coverage only in colorNode.a and
// maskShadowNode) cast a solid square from every far tree on the default engine.
void maskedDepthMasksAndReadsColorAlpha() {
    namespace g = tn::engine::shader::graph;
    VertexVariant plain;
    plain.nodes.alphaTestNode = g::uniform("nodeCut", Type::f32(), {0.2f});
    VertexVariant masked = plain;
    masked.nodes.maskNode = g::lessThan(g::uniform("nodeCoverage", Type::f32(), {0.5f}), g::float_(0.25));
    VertexVariant coloured = plain;
    coloured.nodes.colorNode = g::uniform("nodeTint", Type::vec(4), {1.0f, 1.0f, 1.0f, 0.5f});
    const auto discards = [](const std::string& code) {
        std::size_t count = 0;
        for (std::size_t at = code.find("discard"); at != std::string::npos; at = code.find("discard", at + 1)) ++count;
        return count;
    };
    const auto a = WgslEmitter::emit(buildMaskedDepth(plain).fragment, 1);
    const auto b = WgslEmitter::emit(buildMaskedDepth(masked).fragment, 1);
    const auto c = WgslEmitter::emit(buildMaskedDepth(coloured).fragment, 1);
    CHECK(a.ok() && b.ok() && c.ok());
    CHECK(b.code.find("f_nodeCoverage") != std::string::npos);
    CHECK(discards(b.code) == discards(a.code) + 1);
    CHECK(a.code.find("f_nodeTint") == std::string::npos);
    CHECK(c.code.find("f_nodeTint") != std::string::npos);
    // The bound setter: a game's maskShadowNode reaches the engine instead of staying a JS expando.
    VertexVariant shadowOnly;
    shadowOnly.nodes.maskShadowNode = masked.nodes.maskNode;
    CHECK(shadowOnly.key() != VertexVariant{}.key());
}

// three r187 setupDiffuseColor with alphaToCoverage: a tested cutoff fades diffuseColor's alpha over one pixel,
// `smoothstep(cutoff, cutoff + fwidth(a), a)`, and discards `a <= 0`. The impostor bake captures diffuseColor's alpha as
// the atlas coverage; without the fade it took the raw mip-thinned leaf alpha and every far tree drew as specks.
void alphaToCoverageFadesDiffuseColor() {
    namespace g = tn::engine::shader::graph;
    VertexVariant hard;
    hard.nodes.alphaTestNode = g::uniform("nodeCut", Type::f32(), {0.3f});
    hard.nodes.colorNode = g::uniform("nodeTint", Type::vec(4), {1.0f, 1.0f, 1.0f, 0.5f});
    hard.nodes.mrt = {{"output", g::materialInput("diffuseColor", Type::vec(4))}};
    VertexVariant faded = hard;
    faded.alphaToCoverage = true;
    CHECK(hard.key() != faded.key());
    VertexVariant flat;  // the flat cutoff fades too: material.alphaTest > 0 with no node
    flat.alphaTest = flat.alphaToCoverage = true;
    VertexVariant untested;  // no cutoff at all: three fades nothing
    untested.alphaToCoverage = true;
    const auto fades = [](const Program& program) {
        const auto code = WgslEmitter::emit(program, 1);
        CHECK(code.ok());
        return code.code.find("fwidth(") != std::string::npos && code.code.find("smoothstep(") != std::string::npos;
    };
    CHECK(!fades(buildBasic(hard).fragment) && fades(buildBasic(faded).fragment));
    CHECK(!fades(buildLambert(hard).fragment) && fades(buildLambert(faded).fragment));
    CHECK(!fades(buildStandard(StandardMaterial{}, hard).fragment) && fades(buildStandard(StandardMaterial{}, faded).fragment));
    CHECK(fades(buildBasic(flat).fragment) && !fades(buildBasic(untested).fragment));
    // A map-only cutout (no colorNode, no opacityNode) whose MRT slot reads diffuseColor, as the impostor bake's
    // capture does: that slot reads the faded alpha too, a second smoothstep beside the colour output's own.
    VertexVariant mapped;
    mapped.map = mapped.alphaToCoverage = true;
    mapped.nodes.alphaTestNode = g::uniform("nodeCut", Type::f32(), {0.3f});
    mapped.nodes.mrt = {{"output", g::materialInput("diffuseColor", Type::vec(4))}};
    const auto smoothsteps = [](const Program& program) {
        const auto code = WgslEmitter::emit(program, 1);
        CHECK(code.ok());
        std::size_t count = 0;
        for (auto at = code.code.find("smoothstep("); at != std::string::npos; at = code.code.find("smoothstep(", at + 1)) ++count;
        return count;
    };
    CHECK(smoothsteps(buildBasic(mapped).fragment) >= 2);
    CHECK(smoothsteps(buildStandard(StandardMaterial{}, mapped).fragment) >= 2);
}

// NodeMaterial.alphaTestNode (three r187 setupDiffuseColor): the node replaces alphaTest as the cutoff in every colour
// builder and in the masked shadow depth fragment, and a set node tests without the alphaTest > 0 gate.
void alphaTestNodeProgram() {
    namespace g = tn::engine::shader::graph;
    VertexVariant plain;
    plain.alphaTest = true;  // the flat cutoff path: material.alphaTest > 0
    VertexVariant cut;
    cut.nodes.alphaTestNode = g::uniform("nodeCut", Type::f32(), {0.2f});
    CHECK(plain.key() != cut.key());
    const auto gated = [](const std::string& code) { return code.find("(0f < u.f_alphaTest)") != std::string::npos; };
    const Program programs[][2] = {
        {buildStandard(StandardMaterial{}, plain).fragment, buildStandard(StandardMaterial{}, cut).fragment},
        {buildLambert(plain).fragment, buildLambert(cut).fragment},
        {buildBasic(plain).fragment, buildBasic(cut).fragment},
        {buildMaskedDepth(plain).fragment, buildMaskedDepth(cut).fragment},
    };
    for (const auto& pair : programs) {
        const auto without = WgslEmitter::emit(pair[0], 1), with = WgslEmitter::emit(pair[1], 1);
        CHECK(without.ok() && with.ok());
        CHECK(without.code.find("f_nodeCut") == std::string::npos);
        CHECK(with.code.find("f_nodeCut") != std::string::npos);
        CHECK(gated(without.code) && !gated(with.code));
    }
}

// PRD-653: material.roughDiffuse shades direct light with the EON model. The variant key changes, a lamp's Source
// Radius enters the fragment only for the marked material (a sun has none), and the EON constants appear only there.
void roughDiffuse() {
    VertexVariant plain;
    VertexVariant rough;
    rough.roughDiffuse = true;
    CHECK(plain.key() != rough.key());
    const LightLayout layout{"dp"};  // a sun, then a point lamp
    const auto without = WgslEmitter::emit(buildStandard(StandardMaterial{}, plain, layout).fragment, 1);
    const auto with = WgslEmitter::emit(buildStandard(StandardMaterial{}, rough, layout).fragment, 1);
    CHECK(without.ok() && with.ok());
    CHECK(without.code.find("light1SourceRadius") == std::string::npos);
    CHECK(with.code.find("f_light1SourceRadius") != std::string::npos);
    CHECK(with.code.find("light0SourceRadius") == std::string::npos);
    CHECK(with.code.find("0.189468") != std::string::npos);
    CHECK(without.code.find("0.189468") == std::string::npos);
}

// A lamp with a range shades only the fragments it reaches: each unshadowed point or spot light's BRDF sits in one
// branch on its distance attenuation. A sun and a lamp that reads a shadow map keep the straight path.
void lampRangeBranch() {
    const auto branches = [](const char* kinds, bool physical, const VertexVariant& variant = {}) {
        const auto programs = physical ? buildPhysical(StandardMaterial{}, variant, LightLayout{kinds})
                                       : buildStandard(StandardMaterial{}, variant, LightLayout{kinds});
        CHECK(programs.diagnostics.empty());
        const auto fragment = WgslEmitter::emit(programs.fragment, 1);
        CHECK(fragment.ok());
        size_t count = 0;
        for (size_t at = fragment.code.find("if ("); at != std::string::npos; at = fragment.code.find("if (", at + 1)) ++count;
        return count;
    };
    for (bool phong : {false, true}) {
        const auto lit = [&](const char* kinds) {
            const auto programs = phong ? buildPhong(VertexVariant{}, LightLayout{kinds}) : buildLambert(VertexVariant{}, LightLayout{kinds});
            CHECK(programs.diagnostics.empty());
            const auto fragment = WgslEmitter::emit(programs.fragment, 1);
            CHECK(fragment.ok());
            size_t count = 0;
            for (size_t at = fragment.code.find("if ("); at != std::string::npos; at = fragment.code.find("if (", at + 1)) ++count;
            return count;
        };
        CHECK(lit("dps") == lit("d") + 2);
        CHECK(lit("dP") == lit("d"));
    }
    VertexVariant rough; rough.roughDiffuse = true;
    VertexVariant mapped; mapped.environment = true;
    for (bool physical : {false, true}) {
        const size_t sun = branches("d", physical);
        CHECK(branches("dps", physical) == sun + 2);
        CHECK(branches("dp-p", physical) == sun + 2);
        CHECK(branches("dP", physical) == sun);  // its shadow taps need uniform control flow
        CHECK(branches("dps", physical, rough) == branches("d", physical, rough) + 2);
        CHECK(branches("dpp", physical, mapped) == branches("d", physical, mapped) + 2);
    }
}

// NodeMaterial.irradianceNode replaces the environment's diffuse irradiance: its uniform enters the fragment of a
// material that is lit by an environment, or is the whole indirect diffuse without one, and the slot is part of
// the program key.
void irradianceNode() {
    namespace g = tn::engine::shader::graph;
    VertexVariant plain;
    plain.environment = true;
    VertexVariant lit = plain;
    lit.nodes.irradianceNode = g::uniform("nodeIrradiance", Type::vec(3), {0.5f, 0.25f, 0.125f});
    CHECK(plain.key() != lit.key());
    const auto without = WgslEmitter::emit(buildStandard(StandardMaterial{}, plain).fragment, 1);
    const auto with = WgslEmitter::emit(buildStandard(StandardMaterial{}, lit).fragment, 1);
    CHECK(without.ok() && with.ok());
    CHECK(without.code.find("f_nodeIrradiance") == std::string::npos);
    CHECK(with.code.find("f_nodeIrradiance") != std::string::npos);
    // With no environment (a closed room, no sky) the node is still the material's indirect diffuse: a baked GI
    // cache must not vanish because scene.environment is null.
    VertexVariant dark = lit;
    dark.environment = false;
    const auto unlitByEnvironment = WgslEmitter::emit(buildStandard(StandardMaterial{}, dark).fragment, 1);
    CHECK(unlitByEnvironment.ok());
    CHECK(unlitByEnvironment.code.find("f_nodeIrradiance") != std::string::npos);
}

// The merged post-target pass (Renderer::auxFragment) draws a lit draw's diffuse colour and emitted radiance through
// the draw's own bind groups, as further colour outputs (MRT) of the lit fragment: adding them must keep the lit
// fragment's layout exactly (every uniform at the same offset, every texture at the same binding), put them at
// @location(1) and (2) after `color`, and leave both unfogged.
void albedoOutput() {
    for (int kind = 1; kind < 5; ++kind) {
        for (int shape = 0; shape < 5; ++shape) {
            VertexVariant lit;
            lit.map = shape >= 1;
            lit.fog = shape == 2 ? 1 : 0;
            lit.instanceColor = shape == 2;
            lit.environment = kind >= 3;
            if (shape == 3 && kind >= 3) lit.pbrMaps |= 1u << kEmissiveMap;
            if (shape == 4) lit.nodes.emissiveNode = graph::vec3({graph::float_(4), graph::float_(2), graph::float_(0)});
            const auto build = [&](const VertexVariant& v) {
                return kind == 1 ? buildLambert(v) : kind == 2 ? buildPhong(v) : kind == 3 ? buildStandard({}, v) : buildPhysical({}, v);
            };
            auto targets = build(lit);
            CHECK(targets.albedo != kInvalid && targets.emissive != kInvalid);
            auto& f = targets.fragment;
            f.output("aux1", f.construct(Type::vec(4), {targets.albedo, f.constant(1.f)}));
            f.output("aux2", f.construct(Type::vec(4), {targets.emissive, f.constant(1.f)}));
            const auto litFragment = buildStage(build(lit).fragment, 1), auxFragment = buildStage(f, 1);
            CHECK(litFragment.wgsl.ok() && auxFragment.wgsl.ok());
            CHECK(auxFragment.uniforms.size() == litFragment.uniforms.size());
            CHECK(auxFragment.uniformBlockSize == litFragment.uniformBlockSize);
            CHECK(auxFragment.bindings.size() == litFragment.bindings.size());
            for (std::size_t i = 0; i < litFragment.uniforms.size(); ++i) {
                CHECK(auxFragment.uniforms[i].name == litFragment.uniforms[i].name);
                CHECK(auxFragment.uniforms[i].offset == litFragment.uniforms[i].offset);
            }
            CHECK(auxFragment.wgsl.code.find("@location(1) o_aux1") != std::string::npos);
            CHECK(auxFragment.wgsl.code.find("@location(2) o_aux2") != std::string::npos);
            // Unfogged: neither target mixes toward the fog colour (the fogged colour is written before them).
            if (shape == 2) {
                CHECK(litFragment.wgsl.code.find("f_fogColor") != std::string::npos);
                const auto output = auxFragment.wgsl.code.rfind("out.o_aux1");
                CHECK(output != std::string::npos);
                CHECK(auxFragment.wgsl.code.find("mix(", output) == std::string::npos);
            }
        }
    }
    // A normalNode's shading normal is a further output of the lit fragment (the post normal target, PRD-762): it
    // exists for Standard and Physical, and writing it keeps the fragment's layout.
    for (int kind = 3; kind < 5; ++kind) {
        VertexVariant lit;
        lit.nodes.normalNode = graph::normalize(graph::add(graph::varying("normalViewGeometry", Type::vec(3)),
                                                         graph::vec3({graph::float_(0.3), graph::float_(0), graph::float_(0)})));
        const auto build = [&] { return kind == 3 ? buildStandard({}, lit) : buildPhysical({}, lit); };
        auto targets = build();
        CHECK(targets.normal != kInvalid);
        auto& f = targets.fragment;
        f.output("aux1", f.construct(Type::vec(4), {targets.normal, f.constant(0.f)}));
        const auto litFragment = buildStage(build().fragment, 1), auxFragment = buildStage(f, 1);
        CHECK(litFragment.wgsl.ok() && auxFragment.wgsl.ok());
        CHECK(auxFragment.uniforms.size() == litFragment.uniforms.size());
        CHECK(auxFragment.bindings.size() == litFragment.bindings.size());
        CHECK(auxFragment.uniformBlockSize == litFragment.uniformBlockSize);
        CHECK(auxFragment.wgsl.code.find("@location(1) o_aux1") != std::string::npos);
    }
}

void emissiveOutput() { albedoOutput(); }

void velocityDeformation() {
    namespace g = tn::engine::shader::graph;
    VertexVariant variant;
    variant.instanced = true;
    const auto time = g::uniform("time", Type::f32());
    const auto delta = g::uniform("deltaTime", Type::f32());
    const auto strength = g::uniform("windStrength", Type::f32(), {0.4});
    const auto scale = g::materialInput("windScale", Type::f32());
    variant.nodes.positionNode = g::add(g::positionLocal(), g::mul(g::attribute("normal", Type::vec(3)),
        g::mul(g::sin(g::add(time, delta)), g::mul(strength, scale))));
    const auto key = g::key(variant.nodes.positionNode);
    const auto values = g::uniforms(variant.nodes.positionNode);
    const auto originalStrength = strength->values;
    const auto velocity = velocityPrograms(variant);
    const auto colour = buildBasic(variant);
    const auto vs = buildStage(velocity.vertex, 0), fs = buildStage(velocity.fragment, 1);
    CHECK(vs.wgsl.ok() && fs.wgsl.ok());
    stagesAgree(velocity.fragment, vs.wgsl.code, fs.wgsl.code);
    const auto output = [](const Program& p, const std::string& name) {
        const auto text = p.dump();
        const auto start = text.find("output " + name + " = ");
        return start == std::string::npos ? std::string{} : text.substr(start, text.find('\n', start) - start);
    };
    CHECK(output(velocity.vertex, "position") == output(colour.vertex, "position"));
    const auto current = output(velocity.vertex, "currentClip");
    const auto previous = output(velocity.vertex, "previousClip");
    CHECK(current.find("uniform:unjitteredProjection") != std::string::npos);
    CHECK(previous.find("uniform:previousProjection") != std::string::npos);
    for (const auto* name : {"time", "deltaTime", "windStrength", "windScale"}) {
        CHECK(current.find(std::string("uniform:") + name) != std::string::npos);
        CHECK(current.find(std::string(previousDeformationUniformPrefix) + name) == std::string::npos);
        CHECK(previous.find(std::string("uniform:") + previousDeformationUniformPrefix + name) != std::string::npos);
        CHECK(previous.find(std::string("uniform:") + name) == std::string::npos);
    }
    for (int column = 0; column < 4; ++column)
        CHECK(vs.wgsl.code.find("a_instanceMatrix" + std::to_string(column)) != std::string::npos);
    CHECK(vs.wgsl.code.find("a_normal") != std::string::npos);
    CHECK(fs.wgsl.code.find("currentClip") != std::string::npos &&
          fs.wgsl.code.find("previousClip") != std::string::npos);
    CHECK(g::key(variant.nodes.positionNode) == key && g::uniforms(variant.nodes.positionNode) == values);
    CHECK(strength->values == originalStrength);
    const auto rigid = velocityPrograms(VertexVariant{});
    CHECK(rigid.vertex.ok());
    const auto rigidStage = buildStage(rigid.vertex, 0);
    CHECK(rigidStage.attributes.size() == 1 && rigidStage.attributes[0].name == "position");
    // Only the explicit namespace replaces a graph uniform; material overrides keep their existing fallback.
    Program controls(Stage::Vertex);
    tn::engine::shader::tsl::Build scope(controls);
    const auto one = controls.constant(1.f), two = controls.constant(2.f);
    CHECK(g::lower(time, controls, {{"time", two}}) != two);
    CHECK(g::lower(time, controls, {{"uniform:time", two}}) == two);
    CHECK(g::lower(scale, controls, {{"material:windScale", one}}) == one);
    CHECK(g::lower(scale, controls, {{"material:windScale", one}, {"uniform:windScale", two}}) == two);
}

void nodes() {
    velocityDeformation();
    namespace g = tn::engine::shader::graph;
    VertexVariant variant;
    variant.map = true;
    variant.nodes.colorNode = g::vec4({g::uv(), g::uniform("nodeTint", Type::f32(), {0.35f}), g::float_(0.8)});
    const auto basic = buildBasic(variant);
    const auto fragment = WgslEmitter::emit(basic.fragment, 1);
    const auto vertex = WgslEmitter::emit(basic.vertex, 0);
    CHECK(fragment.ok() && vertex.ok());
    // NodeMaterial.setupDiffuseColor picks colorNode instead of materialColor (color * map).
    CHECK(fragment.code.find("t_map") == std::string::npos);
    CHECK(fragment.code.find("f_nodeTint") != std::string::npos);
    CHECK(fragment.code.find("f_diffuse).xyz") == std::string::npos);
    CHECK(fragment.code.find("f_diffuse).w") != std::string::npos); // material opacity still multiplies node alpha
    CHECK(vertex.code.find("o_uv = a_uv") != std::string::npos);
    VertexVariant mapped;
    mapped.map = true;
    CHECK(WgslEmitter::emit(buildBasic(mapped).fragment, 1).code.find("t_map") != std::string::npos);
    const auto same = variant.nodes.colorNode;
    const auto copy = g::vec4({g::uv(), g::uniform("nodeTint", Type::f32(), {0.9f}), g::float_(0.8)});
    CHECK(g::key(same) == g::key(copy)); // uniform data does not change the shader
    CHECK(g::uniforms(same).at("nodeTint")[0] == 0.35f);
    CHECK(g::key(g::add(g::float_(1), g::float_(2))) != g::key(g::sub(g::float_(1), g::float_(2))));
    const std::string colorKey = variant.key();
    variant.nodes.opacityNode = g::float_(0.4);
    CHECK(variant.key() != colorKey);
    const auto opacity = WgslEmitter::emit(buildBasic(variant).fragment, 1);
    CHECK(opacity.ok());
    // opacityNode replaces the scalar material opacity, without replacing colorNode's alpha.
    CHECK(opacity.code.find("f_diffuse).w") == std::string::npos);
    variant.nodes.normalNode = g::normalize(g::add(g::varying("normalViewGeometry", Type::vec(3)),
                                                g::vec3({g::float_(0.3), g::float_(0), g::float_(0)})));
    variant.nodes.roughnessNode = g::swizzle(g::uv(), "x");
    variant.nodes.metalnessNode = g::swizzle(g::varying("positionWorld", Type::vec(3)), "y");
    variant.nodes.emissiveNode = g::vec3({g::sin(g::swizzle(g::uv(), "x")), g::float_(0), g::float_(0)});
    variant.nodes.positionNode = g::add(g::positionLocal(), g::vec3({g::float_(0), g::float_(0), g::float_(0.2)}));
    const auto standard = buildStandard(StandardMaterial{}, variant);
    CHECK(standard.diagnostics.empty());
    const auto sv = WgslEmitter::emit(standard.vertex, 0), sf = WgslEmitter::emit(standard.fragment, 1);
    CHECK(sv.ok() && sf.ok());
    CHECK(sv.code.find("o_positionWorld") != std::string::npos);
    CHECK(sf.code.find("dpdx") != std::string::npos); // geometry roughness remains
    CHECK(sf.code.find("sin(") != std::string::npos);
    CHECK(sf.code.find("f_emissive") == std::string::npos); // emissiveNode replaces emissive * intensity
    CHECK(sf.code.find("f_roughness") == std::string::npos);
    CHECK(sf.code.find("f_metalness") == std::string::npos);
    // Varyings match by name despite roughness, metalness and normal using different graph orders.
    stagesAgree(standard.fragment, sv.code, sf.code);
    CHECK(sv.code.find("out.position =") != std::string::npos);
    VertexVariant invalid;
    invalid.nodes.colorNode = g::Block{}.node();
    CHECK(!buildBasic(invalid).fragment.ok());
    invalid.nodes = {};
    invalid.nodes.positionNode = g::Block{}.node();
    CHECK(!buildBasic(invalid).vertex.ok());
    variant.nodes.positionNode = g::vec4({g::positionLocal(), g::float_(1)});
    CHECK(buildBasic(variant).vertex.ok()); // setupPosition subBuild requests vec3
    // attribute("color") read in a fragment rides a varying, which must not take the colour output's name.
    VertexVariant painted;
    painted.nodes.colorNode = g::vec4({g::attribute("color", Type::vec(3)), g::float_(1)});
    for (const auto& built : {buildBasic(painted), buildStandard(StandardMaterial{}, painted)}) {
        CHECK(built.vertex.ok() && built.fragment.ok());
        const auto pv = WgslEmitter::emit(built.vertex, 0), pf = WgslEmitter::emit(built.fragment, 1);
        CHECK(pv.ok() && pf.ok());
        CHECK(pv.code.find("a_color") != std::string::npos);
        stagesAgree(built.fragment, pv.code, pf.code);
    }
}

void builds() {
    // A procedural background reads a world direction and a live sun uniform, without a cube map.
    VertexVariant background; background.background = true;
    background.nodes.colorNode = graph::mul(graph::normalize(graph::varying("positionWorldDirection", Type::vec(3))),
        graph::uniform("sun", Type::f32(), {0.5}));
    const auto sky = buildBasic(background);
    CHECK(sky.vertex.ok() && sky.fragment.ok());
    const auto skyVs = buildStage(sky.vertex, 0), skyFs = buildStage(sky.fragment, 1);
    CHECK(skyVs.wgsl.ok() && skyFs.wgsl.ok());
    CHECK(skyFs.wgsl.code.find("texture_cube") == std::string::npos);
    CHECK(skyFs.wgsl.code.find("f_sun") != std::string::npos);
    CHECK(skyFs.wgsl.code.find("f_diffuse") != std::string::npos); // backgroundIntensity
    for (const auto& attribute : skyVs.attributes)
        CHECK(attribute.name == "position" || attribute.name == "normal");

    nodes();
    surfacePrefix();
    aoNode();
    maskNode();
    maskedDepthMasksAndReadsColorAlpha();
    alphaToCoverageFadesDiffuseColor();
    alphaTestNodeProgram();
    irradianceNode();
    albedoOutput();
    VertexVariant storage; storage.instanced = storage.instanceStorage = storage.instanceColor = true;
    CHECK(storage.key() != VertexVariant{}.key());
    for (int kind = 0; kind < 5; ++kind) {
        const auto p = kind == 0 ? buildBasic(storage) : kind == 1 ? buildLambert(storage) :
            kind == 2 ? buildPhong(storage) : kind == 3 ? buildStandard({}, storage) : buildPhysical({}, storage);
        const auto vertex = buildStage(p.vertex, 0), fragment = buildStage(p.fragment, 1);
        CHECK(vertex.wgsl.ok() && fragment.wgsl.ok());
        CHECK(vertex.wgsl.code.find("s_instances") != std::string::npos);
        CHECK(vertex.wgsl.code.find("instanceBase") != std::string::npos);
        CHECK(vertex.attributes.size() == (kind == 0 ? 1 : 2));
        CHECK(fragment.wgsl.code.find("i_instanceColor") != std::string::npos);
    }
    // r185 Normal.js leaves derivative face normals unflipped, including DoubleSide back faces.
    for (bool physical : {false, true}) for (bool flat : {false, true}) {
        VertexVariant variant;
        variant.doubleSide = true;
        variant.flatShading = flat;
        const auto p = physical ? buildPhysical({}, variant) : buildStandard({}, variant);
        const auto fragment = buildStage(p.fragment, 1);
        CHECK(fragment.wgsl.ok());
        CHECK((fragment.wgsl.code.find("@builtin(front_facing)") == std::string::npos) == flat);
    }
    // Midway's instanced, mapped, fogged meshes: no builder may leave the stages' varyings in
    // declaration order when the fragment reads them in another.
    for (int kind = 0; kind < 5; ++kind) {
        for (int bits = 0; bits < 16; ++bits) {
            VertexVariant variant;
            variant.instanced = variant.instanceColor = bits & 1;
            variant.map = bits & 2;
            variant.fog = (bits & 4) ? 1 : 0;
            variant.vertexColors = (bits & 8) ? 4 : 0;
            const auto p = kind == 0 ? buildBasic(variant) : kind == 1 ? buildLambert(variant) :
                kind == 2 ? buildPhong(variant) : kind == 3 ? buildStandard({}, variant) : buildPhysical({}, variant);
            const auto vertex = buildStage(p.vertex, 0), fragment = buildStage(p.fragment, 1);
            CHECK(vertex.wgsl.ok() && fragment.wgsl.ok());
            stagesAgree(p.fragment, vertex.wgsl.code, fragment.wgsl.code);
        }
    }
    const StandardPrograms programs = buildStandard(StandardMaterial{});
    for (const std::string& d : programs.diagnostics) std::fprintf(stderr, "%s\n", d.c_str());
    CHECK(programs.diagnostics.empty());
    CHECK(WgslEmitter::emit(programs.vertex, 0).ok());
    CHECK(WgslEmitter::emit(programs.fragment, 1).ok());
    // A light a material's lightsNode leaves out keeps its index but the program declares and reads nothing of it.
    for (bool physical : {false, true}) {
        const auto chosen = physical ? buildPhysical(StandardMaterial{}, VertexVariant{}, LightLayout{"D-p"})
                                     : buildStandard(StandardMaterial{}, VertexVariant{}, LightLayout{"D-p"});
        CHECK(chosen.diagnostics.empty());
        const auto fragment = WgslEmitter::emit(chosen.fragment, 1);
        CHECK(fragment.ok());
        CHECK(fragment.code.find("light0Color") != std::string::npos && fragment.code.find("light2Color") != std::string::npos);
        CHECK(fragment.code.find("light1") == std::string::npos);
    }
    for (bool phong : {false, true}) {
        const auto chosen = phong ? buildPhong(VertexVariant{}, LightLayout{"-d"}) : buildLambert(VertexVariant{}, LightLayout{"-d"});
        const auto fragment = WgslEmitter::emit(chosen.fragment, 1);
        CHECK(fragment.ok() && fragment.code.find("light1Color") != std::string::npos && fragment.code.find("light0") == std::string::npos);
    }
    // The environment variant samples the PMREM as a cube (r187 PMREMNode.setup), at
    // roughnessToMip = maxLod * r * (2 - r), and keeps its derivatives before any branch.
    VertexVariant environment;
    environment.environment = true;
    CHECK(environment.key() != VertexVariant{}.key());
    for (bool physical : {false, true}) {
        const auto lit = physical ? buildPhysical(StandardMaterial{}, environment, LightLayout{"d"})
                                  : buildStandard(StandardMaterial{}, environment, LightLayout{"d"});
        CHECK(lit.diagnostics.empty());
        const auto fragment = WgslEmitter::emit(lit.fragment, 1);
        CHECK(fragment.ok());
        CHECK(fragment.code.find("textureSampleLevel(t_env") != std::string::npos);
        CHECK(fragment.code.find("var t_env: texture_cube<f32>") != std::string::npos);
        CHECK(fragment.code.find("f_envMapIntensity") != std::string::npos);
        CHECK(fragment.code.rfind("dpdx") < fragment.code.find("if ("));
        // EnvironmentNode's pow4 is ((r*r)*r)*r, not (r*r)*(r*r): f32 rounding is observable.
        bool reflectionMix = false;
        unsigned cubeFlips = 0, roughnessRamps = 0;
        for (ExprId id = 1; id <= lit.fragment.exprCount(); ++id) {
            const Expr& mix = lit.fragment.expr(id);
            // Every PMREM read is a cube sample of the rotated direction with its x negated for
            // WebGPU's cube face order (CubeTextureNode.setupUV), one per irradiance, radiance and
            // clearcoat lobe, and none goes through a cubeUV atlas.
            if (mix.op == Op::SampleLevel) {
                const Expr& direction = lit.fragment.expr(mix.args[0]);
                CHECK(direction.op == Op::Construct && direction.argc == 2);
                const Expr& flip = lit.fragment.expr(direction.args[0]);
                CHECK(flip.op == Op::Neg);
                // materialEnvRotation is applied before the flip: PMREMNode.setup rotates, then samples.
                const Expr& rotated = lit.fragment.expr(flip.args[0]);
                CHECK(rotated.op == Op::Swizzle);
                ExprId source = rotated.args[0];
                while (lit.fragment.expr(source).op == Op::Swizzle) source = lit.fragment.expr(source).args[0];
                const Expr& rotation = lit.fragment.expr(source);
                CHECK(rotation.op == Op::Mul && lit.fragment.expr(rotation.args[0]).op == Op::Uniform &&
                      lit.fragment.expr(rotation.args[0]).type == Type::mat(4, 4));
                ++cubeFlips;
                // roughnessToMip (:19): maxLod * clamp(r) * (2 - clamp(r)).
                const Expr& level = lit.fragment.expr(mix.args[1]);
                CHECK(level.op == Op::Mul);
                const Expr& maxLod = lit.fragment.expr(level.args[0]);
                CHECK(maxLod.op == Op::Uniform && maxLod.type == Type::f32());
                const Expr& ramp = lit.fragment.expr(level.args[1]);
                CHECK(ramp.op == Op::Mul);
                const Expr& clamped = lit.fragment.expr(ramp.args[0]);
                CHECK(clamped.op == Op::Call && clamped.argc == 3);
                const Expr& twoMinus = lit.fragment.expr(ramp.args[1]);
                CHECK(twoMinus.op == Op::Sub && lit.fragment.expr(twoMinus.args[1]).op == Op::Call);
                ++roughnessRamps;
            }
            if (mix.op != Op::Call || mix.argc != 3) continue;
            const Expr& reflection = lit.fragment.expr(mix.args[0]);
            if (reflection.op != Op::Call || reflection.argc != 2) continue;
            const Expr& incident = lit.fragment.expr(reflection.args[0]);
            if (incident.op != Op::Neg) continue;
            const Expr& fourth = lit.fragment.expr(mix.args[2]);
            CHECK(fourth.op == Op::Mul);
            const Expr& third = lit.fragment.expr(fourth.args[0]);
            CHECK(third.op == Op::Mul && third.args[1] == fourth.args[1]);
            const Expr& second = lit.fragment.expr(third.args[0]);
            CHECK(second.op == Op::Mul && second.args[0] == fourth.args[1] && second.args[1] == fourth.args[1]);
            reflectionMix = true;
        }
        CHECK(cubeFlips == 2);
        CHECK(roughnessRamps == 2);  // irradiance and radiance; the clearcoat lobe is opt-in
        CHECK(reflectionMix);
    }
}

// The program key of a material's node slots is what caches its programs: the empty-slot shortcut
// must give exactly the text the general serializer gives, for empty and for filled slots.
void nodeKey() {
    // The program key names each graph by its interned structure: equal structures built apart share
    // it, a different structure or an emptied slot changes it, and its length does not grow with the
    // graph (the renderer builds it for every draw of every frame).
    MaterialNodes empty;
    CHECK(graph::key(nullptr) == "null;" && graph::keyId(nullptr) == 0);
    CHECK(!empty.key().empty() && empty.key() == MaterialNodes{}.key());
    const auto build = [](int terms) {
        graph::Node n = graph::float_(1);
        for (int i = 0; i < terms; ++i) n = graph::add(n, graph::float_(double(i)));
        return n;
    };
    MaterialNodes filled;
    filled.roughnessNode = build(3);
    filled.colorNode = build(2);
    MaterialNodes twin;
    twin.roughnessNode = build(3);
    twin.colorNode = build(2);
    CHECK(filled.key() == twin.key() && filled.key() != empty.key());
    MaterialNodes other = filled;
    other.colorNode.reset();
    CHECK(other.key() != filled.key());
    MaterialNodes changed = filled;
    changed.colorNode = build(4);
    CHECK(changed.key() != filled.key());
    MaterialNodes large = filled;
    large.colorNode = build(2000);
    CHECK(large.key().size() < filled.key().size() + 8 && graph::key(large.colorNode).size() > 10000);
    // A copied node, then edited, never answers its source's interned key.
    auto copy = std::make_shared<graph::NodeData>(*filled.colorNode);
    copy->args.push_back(graph::float_(9));
    CHECK(graph::keyId(copy) != graph::keyId(filled.colorNode));
}

// A render target is one pass, however many times the graph samples it: the bloom chain is its
// high-pass, two blur directions for each of five mips and the composite, 12 passes. Each blur tap
// samples its source through a copy of the target node; counting copies once rendered the 22-tap
// mip's source 43 times a direction, 283 passes a frame for the template's chain.
void bloomPasses() {
    const auto colour = graph::texture("scene", graph::uv());
    const auto passes = graph::postPasses(graph::add(colour, graph::bloom(colour, 0.7, 0.5, 0.2)));
    std::set<std::string> outputs;
    for (const auto& pass : passes) outputs.insert(pass.output);
    std::fprintf(stderr, "bloom: %zu passes, %zu distinct outputs\n", passes.size(), outputs.size());
    CHECK(passes.size() == 12);
    CHECK(outputs.size() == passes.size());
}


// The denoise filters 17 taps a pixel. sampleNormal's depth-derived fallback (nine depth loads) inlined there cost
// the filter about 1 ms of 2.4 at 2560x1440 by register pressure, taken or not; the pass reads raw normals instead.
void denoiseReadsRawNormals() {
    namespace g = graph;
    const auto effect = g::denoiseEffect(g::texture("scene", g::uv()), g::texture("depth", g::uv()), g::texture("normal", g::uv()), 1);
    const auto passes = g::postPasses(g::effectNode(effect));
    CHECK(passes.size() == 1);
    if (passes.size() != 1) return;
    CHECK(passes[0].package.ok() && !passes[0].package.variants.empty());
    if (passes[0].package.variants.empty()) return;
    std::string code;
    for (const auto& stage : passes[0].package.variants[0].stages) code += stage.wgsl.code;
    const auto calls = [&](const std::string& name) {
        std::size_t n = 0;
        for (auto at = code.find(name); at != std::string::npos; at = code.find(name, at + 1)) ++n;
        return n;
    };
    std::fprintf(stderr, "denoise: sampleNormal( %zu, sampleNormalRaw( %zu\n", calls("sampleNormal("), calls("sampleNormalRaw("));
    CHECK(calls("sampleNormal(") == 1);  // its definition, called by no line of the filter
    CHECK(calls("sampleNormalRaw(") >= 3);
}

void ssrPasses() {
    namespace g = graph;
    const auto color = g::texture("scene", g::uv());
    const auto depth = g::texture("depth", g::uv());
    const auto normal = g::texture("normal", g::uv());
    const auto metal = g::swizzle(g::texture("metalness", g::uv()), "x");
    const auto rough = g::swizzle(g::texture("roughness", g::uv()), "y");
    const auto effect = g::ssrEffect(color, depth, normal, metal, rough);
    effect->resolutionScale = 0.5f;
    CHECK(effect->kind == "SSRNode" && effect->normal && effect->roughness);
    CHECK(effect->inputs == std::vector<g::Node>({color, depth, normal, metal, rough}));
    CHECK(effect->parameters.at("quality")[0] == 0.5);
    CHECK(effect->parameters.count("maxSteps") && effect->parameters.at("maxSteps")[0] == 1e6);
    const auto passes = g::postPasses(g::effectNode(effect));
    CHECK(passes.size() == 6);
    if (passes.size() != 6) return;
    CHECK((passes[0].reads == std::map<std::string, std::string>{{"input", "scene"}, {"depth", "depth"},
        {"normal", "normal"}, {"metalness", "metalness"}}));
    CHECK(passes[0].output == effect->output + "_ray");
    CHECK(passes[0].effect == effect && passes[0].resolutionScale == 0.5f);
    for (uint32_t level = 1; level < 5; ++level) {
        CHECK(passes[level].mipLevel == level);
        CHECK(passes[level].reads.at("input") == passes[0].output);
        CHECK(passes.back().reads.at("mip" + std::to_string(level)) == passes[level].output);
    }
    CHECK(passes.back().reads.at("mip0") == passes[0].output);
    CHECK(passes.back().reads.at("roughness") == "roughness");
    CHECK(passes.back().output == effect->output && passes.back().resolutionScale == 1);
    for (const auto& pass : passes) {
        std::string error;
        CHECK(acceptPackage(pass.package, error));
        for (const auto& stage : pass.package.variants.at(0).stages) CHECK(stage.wgsl.ok());
    }
    CHECK(passes[0].package.variants[0].stages.back().wgsl.code.find("t_metalness,smp_metalness,coord,0.0).x") != std::string::npos);
    const auto& ray = passes[0].package.variants[0].stages.back().wgsl.code;
    CHECK(ray.find("maxSteps: f32") != std::string::npos && ray.find(",u.maxSteps)") != std::string::npos);
    CHECK(passes.back().package.variants[0].stages.back().wgsl.code.find("t_roughness,smp_roughness,coord,0.0).y") != std::string::npos);

    // Scalar expressions get their own render pass rather than losing their uniforms or UVs.
    const auto scalar = g::uniform("authoredMetalness", Type::f32(), {0.25});
    const auto fallback = g::ssrEffect(color, depth, normal, scalar, g::float_(0.7));
    const auto materialized = g::postPasses(g::effectNode(fallback));
    CHECK(materialized.size() == 8);
    if (materialized.size() != 8) return;
    CHECK(materialized[0].output == fallback->output + "_metalness");
    CHECK(materialized[0].uniforms.at("authoredMetalness")[0] == 0.25);
    CHECK(materialized[1].reads.at("metalness") == materialized[0].output);
    CHECK(materialized[6].output == fallback->output + "_roughness");
    CHECK(materialized[7].reads.at("roughness") == materialized[6].output);
    for (const auto& pass : materialized) CHECK(pass.package.ok());

    const auto defaults = g::ssrEffect(color, depth, normal, nullptr, nullptr);
    CHECK(!defaults->roughness && defaults->inputs.size() == 5);
    const auto simple = g::postPasses(g::effectNode(defaults));
    CHECK(simple.size() == 2);
    CHECK(simple.back().output == defaults->output);
    CHECK(simple.back().reads.count("roughness") == 0);
}

void ssrRejectsInputs() {
    namespace g = graph;
    const auto texture = g::texture("scene", g::uv());
    const char* names[]{"SSR color", "SSR depth", "SSR normal"};
    for (size_t i = 0; i < 3; ++i) for (const auto& bad : {g::Node{}, g::float_(1), g::mul(texture, g::float_(0.5))}) {
        std::vector<g::Node> inputs{texture, texture, texture};
        inputs[i] = bad;
        bool refused = false;
        try { g::ssrEffect(inputs[0], inputs[1], inputs[2], nullptr, nullptr); }
        catch (const std::runtime_error& e) {
            refused = std::string(e.what()) == std::string("TN_TSL_POST_INPUT: ") + names[i] + " must be a texture node";
        }
        CHECK(refused);
    }
}

// A material's custom MRT slot (three's mrtNode output, e.g. the Strata water proof's "diagnostic"): the colour
// program lowers the node without writing it, so the aux pass's fragment declares the same uniforms, textures and
// varyings, writes the slot at the next colour location after `color`, and keeps the lit fragment's layout exactly.
void mrtSlot() {
    namespace g = tn::engine::shader::graph;
    const auto value = g::mul(g::uniform("diagnosticScale", Type::f32(), {1.0}),
                              g::vec4({g::float_(0.25), g::float_(0), g::float_(0), g::float_(1)}));
    for (int kind = 1; kind < 5; ++kind) {
        VertexVariant variant;
        variant.nodes.mrt = {{"diagnostic", value}};
        const auto build = [&] {
            return kind == 1 ? buildLambert(variant) : kind == 2 ? buildPhong(variant)
                 : kind == 3 ? buildStandard({}, variant) : buildPhysical({}, variant);
        };
        auto lit = build();
        CHECK(lit.diagnostics.empty());
        CHECK(lit.mrt.size() == 1 && lit.mrt[0] != kInvalid);
        // The colour program declares the slot's graph and writes only `color`.
        const auto litFragment = buildStage(build().fragment, 1);
        CHECK(litFragment.wgsl.ok());
        CHECK(litFragment.wgsl.code.find("diagnosticScale") != std::string::npos);
        CHECK(litFragment.wgsl.code.find("o_mrt") == std::string::npos);
        // The aux pass's fragment writes it at @location(1), after `color`, and keeps the lit layout.
        auto aux = build();
        auto& f = aux.fragment;
        f.output("color", f.construct(Type::vec(4), {f.constant(0.f), f.constant(0.f), f.constant(0.f), f.constant(0.f)}));
        f.output("mrt1", aux.mrt[0]);
        f.pruneDeadStatements();
        const auto auxFragment = buildStage(f, 1);
        CHECK(auxFragment.wgsl.ok());
        CHECK(auxFragment.wgsl.code.find("@location(1) o_mrt1: vec4<f32>") != std::string::npos);
        CHECK(auxFragment.uniforms.size() == litFragment.uniforms.size());
        CHECK(auxFragment.uniformBlockSize == litFragment.uniformBlockSize);
        CHECK(auxFragment.bindings.size() == litFragment.bindings.size());
        for (std::size_t i = 0; i < litFragment.uniforms.size(); ++i) {
            CHECK(auxFragment.uniforms[i].name == litFragment.uniforms[i].name);
            CHECK(auxFragment.uniforms[i].offset == litFragment.uniforms[i].offset);
        }
    }
    // The slot's name and node are part of the program key: two materials never share a program across slots, and a
    // material with a slot never shares an empty one's.
    VertexVariant a, b, c;
    a.nodes.mrt = {{"diagnostic", value}};
    b.nodes.mrt = {{"coverage", value}};
    c.nodes.mrt = {{"diagnostic", g::vec4({g::float_(1), g::float_(0), g::float_(0), g::float_(1)})}};
    const MaterialNodes none;
    CHECK(a.nodes.key() != b.nodes.key());
    CHECK(a.nodes.key() != c.nodes.key());
    CHECK(a.nodes.key() != none.key());
    // The slot's graph is walked with the material's own, so its uniform is collected for the draw.
    bool found = false;
    a.nodes.forEachGraph([&](const g::Node& graph) {
        for (const auto& [name, values] : g::uniforms(graph))
            if (name == "diagnosticScale") found = true;
    });
    CHECK(found);
}

// MaterialNode.envNode (three's NodeMaterial.envNode, the Strata ocean's sky radiance): with no environment map, the
// node is the environment's radiance, and its irradiance is that radiance times pi (EnvironmentNode.setup), so the
// standard material's indirect light comes from the author's own sky. Without the slot the ocean renders unlit.
void envNode() {
    namespace g = tn::engine::shader::graph;
    const auto radiance = g::mul(g::uniform("authoredRadiance", Type::vec(3), {0.8, 0.9, 1.0}),
                                 g::vec3({g::float_(1), g::float_(1), g::float_(1)}));
    VertexVariant lit;
    lit.nodes.envNode = radiance;
    const auto withNode = buildStandard({}, lit);
    CHECK(withNode.diagnostics.empty());
    const auto fs = buildStage(buildStandard({}, lit).fragment, 1);
    for (const auto& e : fs.wgsl.errors) std::fprintf(stderr, "%s\n", e.c_str());
    CHECK(fs.wgsl.ok());
    // The author's graph reaches the fragment, so its uniform is collected for the draw.
    CHECK(fs.wgsl.code.find("authoredRadiance") != std::string::npos);
    // No environment map is sampled: the node replaces it, so the fragment binds no extra texture.
    VertexVariant plain;
    const auto without = buildStage(buildStandard({}, plain).fragment, 1);
    CHECK(without.wgsl.ok());
    CHECK(fs.bindings.size() == without.bindings.size());
    CHECK(without.wgsl.code.find("authoredRadiance") == std::string::npos);
    CHECK(lit.nodes.key() != plain.nodes.key());
    bool collected = false;
    lit.nodes.forEachGraph([&](const g::Node& graph) {
        for (const auto& [name, values] : g::uniforms(graph))
            if (name == "authoredRadiance") collected = true;
    });
    CHECK(collected);
}

void depthTextureLowering() {
    namespace g = graph;
    for (bool namedDepth : {false, true}) for (bool load : {false, true}) {
        const std::string name = namedDepth ? "depth" : "authoredDepth";
        auto node = std::make_shared<g::NodeData>(*g::texture(name, g::vec2({g::float_(-0.5), g::float_(1.5)})));
        node->bits = namedDepth ? 0 : 1;
        if (load) {
            node->kind = g::Kind::TextureLoad;
            auto coord = std::make_shared<g::NodeData>();
            coord->kind = g::Kind::Join; coord->type = Type::vec(2, Type::Scalar::I32);
            coord->args = {g::int_(0)};
            node->args = {coord};
        }
        Program p(Stage::Fragment);
        const auto value = g::lower(node, p);
        CHECK(p.ok());
        CHECK(p.expr(value).type == (namedDepth ? Type::vec(4) : Type::f32()));
        p.output("color", p.construct(Type::vec(4), {value}));
        const auto stage = buildStage(p);
        CHECK(stage.wgsl.ok());
        CHECK(stage.wgsl.code.find("t_" + name + ": texture_depth_2d") != std::string::npos);
        CHECK(stage.wgsl.code.find("textureLoad(t_" + name) != std::string::npos);
        CHECK(stage.wgsl.code.find("textureSample(") == std::string::npos);
        if (!load) {
            CHECK(stage.wgsl.code.find("clamp(") != std::string::npos);
            CHECK(stage.wgsl.code.find("textureDimensions(t_" + name) != std::string::npos);
        }
        bool bound = false;
        for (const auto& binding : stage.bindings) if (binding.name == "t_" + name) bound = binding.depth;
        CHECK(bound);
    }
}

// An unlit (Basic) graph that reads the normalView varying gets the vertex stage's normal output.
void basicNormalView() {
    namespace g = tn::engine::shader::graph;
    VertexVariant variant;
    variant.nodes.colorNode = g::vec4({g::swizzle(g::varying("normalView", Type::vec(3)), "x"), g::float_(0), g::float_(0), g::float_(1)});
    const auto p = buildBasic(variant);
    CHECK(p.diagnostics.empty());
    CHECK(p.vertex.dump().find("output normalView = ") != std::string::npos);
}

// three's TangentUtils: a zero det (uv constant across the pixel) scales the frame to 0. Without the
// guard the frame is 0 * inf = NaN, and post spreads it over the whole image (PRD-784 P4-3, PS4).
void normalMapZeroDet() {
    VertexVariant variant;
    variant.normalMap = true;
    const std::string code = WgslEmitter::emit(buildStandard({}, variant).fragment, 1).code;
    const size_t at = code.find("(1f / sqrt(");
    CHECK(at != std::string::npos);
    const size_t start = code.rfind('\n', at), end = code.find('\n', at);
    const std::string line = code.substr(start, end - start);
    const bool guarded = line.find("select((1f / sqrt(") != std::string::npos && line.find(" == 0f)") != std::string::npos;
    if (!guarded) std::fprintf(stderr, "perturbNormal2Arb divides by sqrt(det) unguarded:%s\n", line.c_str());
    CHECK(guarded);
}

}  // namespace

// PRD-539 lever 7: every implicit-LOD material texture reads at the view mip bias (UE 5.8.3:
// SceneVisibility.cpp:5337-5351 sets MaterialTextureMipBias for all material samplers), including a
// node material's texture() node, which Unreal compiles as a TextureSample of the material.
void viewMipBiasSamples() {
    namespace g = tn::engine::shader::graph;
    VertexVariant variant;
    variant.normalMap = true;
    variant.pbrMaps = static_cast<uint16_t>(1u << kRoughnessMap);
    VertexVariant bumped;  // three's BumpMapNode runs only without a normalMap
    bumped.pbrMaps = static_cast<uint16_t>(1u << kBumpMap);
    const std::string lit = WgslEmitter::emit(buildStandard({}, variant).fragment, 1).code +
                            WgslEmitter::emit(buildStandard({}, bumped).fragment, 1).code;
    for (const char* map : {"t_normalMap", "t_roughnessMap", "t_bumpMap"}) {
        const bool biased = lit.find(std::string("textureSampleBias(") + map) != std::string::npos;
        if (!biased) std::fprintf(stderr, "%s reads without the view mip bias\n", map);
        CHECK(biased);
    }
    VertexVariant node;
    node.nodes.colorNode = g::texture("detail", g::uv());
    const auto colored = WgslEmitter::emit(buildBasic(node).fragment, 1);
    CHECK(colored.ok());
    CHECK(colored.code.find("textureSampleBias(t_detail") != std::string::npos);
    CHECK(colored.code.find("u.f_viewMipBias") != std::string::npos);
}

TN_TEST_MAIN({"alpha_hash", [] { alphaHash(); alphaTestCompiled(); }}, {"view_mip_bias_samples", viewMipBiasSamples}, {"ssr_passes", ssrPasses}, {"denoise_reads_raw_normals", denoiseReadsRawNormals}, {"ssr_rejects_inputs", ssrRejectsInputs}, {"depth_texture_lowering", depthTextureLowering}, {"depth_node_writes_frag_depth", depthNodeWritesFragDepth}, {"unsupported", unsupported}, {"emissive_output", emissiveOutput}, {"builds", builds}, {"fog", fog}, {"rough_diffuse", roughDiffuse}, {"lamp_range_branch", lampRangeBranch}, {"fog_node_mixes_color", fogNodeMixesColor}, {"node_key", nodeKey}, {"bloom_passes", bloomPasses}, {"slots_share_one_lowering", slotsShareOneLowering}, {"mrt_slot", mrtSlot}, {"env_node", envNode}, {"basic_normal_view", basicNormalView}, {"normal_map_zero_det", normalMapZeroDet});
