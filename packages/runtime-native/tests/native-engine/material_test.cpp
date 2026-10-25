#include "check.h"
#include "engine/shader/standard.h"
#include "engine/shader/wgsl.h"
#include "engine/shader/package.h"
#include "engine/shader/graph/post_effects.h"

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
        stagesAgree(p.fragment, vs.wgsl.code, fs.wgsl.code);
    }
    const auto depth = buildDepth(variant);
    const auto vs = buildStage(depth.vertex, 0), fs = buildStage(depth.fragment, 1);
    CHECK(vs.wgsl.ok() && fs.wgsl.ok());
    CHECK(fs.wgsl.code.find("@builtin(frag_depth)") != std::string::npos);
    CHECK(fs.wgsl.code.find("textureSample(") != std::string::npos);
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
}

void emissiveOutput() { albedoOutput(); }

void nodes() {
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
    // Both GGX and copy passes must address all extra tiles, including negative mips.
    for (uint32_t lodMax : {4u, 8u}) {
        for (int lod = 1; lod <= int(lodMax) + 2; ++lod) {
            CHECK(pmremMip(lodMax, lod - 1) == float(int(lodMax) - lod + 1));
            CHECK(pmremMip(lodMax, lod) == float(int(lodMax) - lod));
        }
        // Last copy (mip -2): filterInt = 6, so it reads the sixth extra tile at x = 288.
        CHECK((4.0f - pmremMip(lodMax, int(lodMax) + 2)) * 48.0f == 288.0f);
    }
    const StandardPrograms programs = buildStandard(StandardMaterial{});
    for (const std::string& d : programs.diagnostics) std::fprintf(stderr, "%s\n", d.c_str());
    CHECK(programs.diagnostics.empty());
    CHECK(WgslEmitter::emit(programs.vertex, 0).ok());
    CHECK(WgslEmitter::emit(programs.fragment, 1).ok());
    // The environment variant must emit explicit cubeUV taps and keep derivatives before branches.
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
        CHECK(fragment.code.find("f_envMapIntensity") != std::string::npos);
        CHECK(fragment.code.rfind("dpdx") < fragment.code.find("if ("));
        // EnvironmentNode's pow4 is ((r*r)*r)*r, not (r*r)*(r*r): f32 rounding is observable.
        bool reflectionMix = false;
        unsigned rotatedFlips = 0;
        bool mipDenominators = false;
        for (ExprId id = 1; id <= lit.fragment.exprCount(); ++id) {
            const Expr& mix = lit.fragment.expr(id);
            // r185 PMREMNode rotates vec3(x, -y, z), for diffuse and reflection.
            if (mix.op == Op::Mul && lit.fragment.expr(mix.args[0]).op == Op::Uniform &&
                lit.fragment.expr(mix.args[0]).type == Type::mat(4, 4)) {
                const Expr& vector = lit.fragment.expr(mix.args[1]);
                if (vector.op == Op::Construct && vector.argc == 2) {
                    const Expr& direction = lit.fragment.expr(vector.args[0]);
                    if (direction.op == Op::Construct && direction.argc == 3 &&
                        lit.fragment.expr(direction.args[1]).op == Op::Neg) ++rotatedFlips;
                }
            }
            // three's unsuffixed WGSL breakpoint subtraction folds in abstract-float precision.
            if (mix.op == Op::Div) {
                const Expr& numerator = lit.fragment.expr(mix.args[0]);
                if (numerator.op == Op::Mul) {
                    const Expr& delta = lit.fragment.expr(numerator.args[0]);
                    if (delta.op == Op::Sub && lit.fragment.expr(delta.args[0]).op == Op::Constant &&
                        lit.fragment.expr(delta.args[1]).op == Op::LoadVar) {
                        const float high = std::bit_cast<float>(uint32_t(lit.fragment.expr(delta.args[0]).immediate));
                        const float expected = high == 1.0f ? 0.2f : high == 0.8f ? 0.4f : 0.095f;
                        const Expr& denominator = lit.fragment.expr(mix.args[1]);
                        CHECK(denominator.op == Op::Constant && denominator.immediate == std::bit_cast<uint32_t>(expected));
                        mipDenominators = true;
                    }
                }
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
        CHECK(rotatedFlips == 2);
        CHECK(reflectionMix);
        CHECK(mipDenominators);
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

}  // namespace

TN_TEST_MAIN({"alpha_hash", alphaHash}, {"ssr_passes", ssrPasses}, {"denoise_reads_raw_normals", denoiseReadsRawNormals}, {"ssr_rejects_inputs", ssrRejectsInputs}, {"depth_texture_lowering", depthTextureLowering}, {"depth_node_writes_frag_depth", depthNodeWritesFragDepth}, {"unsupported", unsupported}, {"emissive_output", emissiveOutput}, {"builds", builds}, {"fog", fog}, {"rough_diffuse", roughDiffuse}, {"fog_node_mixes_color", fogNodeMixesColor}, {"node_key", nodeKey}, {"bloom_passes", bloomPasses}, {"slots_share_one_lowering", slotsShareOneLowering})
