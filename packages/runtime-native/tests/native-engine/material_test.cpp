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

}

void builds() {
    nodes();
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

}  // namespace

TN_TEST_MAIN({"unsupported", unsupported}, {"builds", builds}, {"fog", fog}, {"node_key", nodeKey}, {"bloom_passes", bloomPasses})
