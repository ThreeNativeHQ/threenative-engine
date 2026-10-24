#include "check.h"
#include "engine/shader/tonemap.h"
#include "engine/shader/output.h"
#include "engine/shader/wgsl.h"
#include "engine/shader/graph/serialized.h"
#include "engine/shader/graph/post_effects.h"
#include "engine/shader/graph/render_texture_pass.h"

#include <cstdio>
#include <algorithm>
#include <stdexcept>
#include <string>

using namespace tn::engine::shader;

namespace {

// Every operator builds well-typed IR and emits WGSL; the GPU validates it in the shader suites.
void operators() {
    bool refused = false;
    try { buildOutput(ToneMapping::Custom, true); }
    catch (const std::runtime_error& error) { refused = std::string(error.what()).find("TN_NATIVE_CUSTOM_TONEMAPPING_MISSING") != std::string::npos; }
    CHECK(refused);
    namespace g = tn::engine::shader::graph;
    const auto input = g::varying("tnToneMappingColor", Type::vec(3));
    const auto exposure = g::uniform("toneMappingExposure", Type::f32());
    const auto gain = g::uniform("customGain", Type::f32(), {0.5});
    const auto curve = g::mul(gain, g::clamp(g::log2(g::add(g::mul(input, exposure), g::float_(1))), g::float_(0), g::float_(1)));
    for (bool srgb : {false, true}) {
        const auto custom = buildOutput(ToneMapping::Custom, srgb, nullptr, true, curve);
        const auto emitted = WgslEmitter::emit(custom.fragment);
        CHECK(custom.fragment.ok() && emitted.ok());
        CHECK(emitted.code.find("log2(") != std::string::npos);
        CHECK(emitted.code.find("tnToneMappingColor") == std::string::npos);
        CHECK(emitted.code.find("toneMappingExposure") != std::string::npos);
        CHECK((emitted.code.find("pow(") != std::string::npos) == srgb);
        if (srgb) CHECK(emitted.code.find("log2(") < emitted.code.find("pow("));
        // Explicit renderOutput(color, 5) in a post graph gets the same registered curve.
        auto authored = std::make_shared<g::NodeData>();
        authored->kind = g::Kind::RenderOutput; authored->bits = 6;
        authored->args = {g::texture("scene", g::uv())};
        const auto post = g::serializedPost(authored, ToneMapping::Custom, srgb, curve);
        const auto programs = buildOutput(ToneMapping::Custom, srgb, &post, false, curve);
        CHECK(programs.fragment.ok() && WgslEmitter::emit(programs.fragment).ok());
        auto rtt = std::make_shared<g::NodeData>();
        rtt->kind = g::Kind::RenderTexture; rtt->name = "customRtt";
        rtt->args = {authored, g::uv()};
        const auto intermediate = g::renderTexturePass(rtt, ToneMapping::Custom, srgb, curve);
        CHECK(intermediate.uniforms.at("customGain").at(0) == 0.5);
        CHECK(std::find(intermediate.live.begin(), intermediate.live.end(), gain) != intermediate.live.end());
        const auto smaa = g::effectNode(g::smaaEffect(authored));
        const auto passes = g::postPasses(smaa, ToneMapping::Custom, srgb, curve);
        CHECK(passes.front().uniforms.at("customGain").at(0) == 0.5);
    }

    // RenderOutputNode must transform straight RGB and then premultiply in output space.
    for (bool srgb : {false, true}) {
        const auto output = buildOutput(ToneMapping::ACESFilmic, srgb);
        const Program& p = output.fragment;
        CHECK(p.ok() && WgslEmitter::emit(p).ok());
        const Expr& color = p.expr(p.exprCount());
        CHECK(color.op == Op::Construct && color.argc == 2);
        const Expr& rgb = p.expr(color.args[0]);
        CHECK(rgb.op == Op::Mul && rgb.args[1] == color.args[1]);
        const Expr& alpha = p.expr(color.args[1]);
        CHECK(alpha.op == Op::Call); // clamp alpha to [0, 1]
        bool unpremultiplied = false;
        for (ExprId id = 1; id <= p.exprCount(); ++id)
            unpremultiplied |= p.expr(id).op == Op::Div && p.expr(id).args[1] == color.args[1];
        CHECK(unpremultiplied);
    }
    for (ToneMapping m : {ToneMapping::Linear, ToneMapping::Reinhard, ToneMapping::Cineon, ToneMapping::ACESFilmic,
                          ToneMapping::AgX, ToneMapping::Neutral}) {
        Program p(Stage::Fragment);
        const ExprId color = p.swizzle(p.varying("hdr", Type::vec(4)), "rgb");
        const ExprId mapped = toneMap(p, m, color, p.uniform("toneMappingExposure", Type::f32()));
        CHECK(p.expr(mapped).type == Type::vec(3));
        p.output("color", p.construct(Type::vec(4), {mapped, p.constant(1.0f)}));
        for (const Diagnostic& d : p.diagnostics()) std::fprintf(stderr, "%s %s %s:%u\n", d.node.c_str(), d.reason.c_str(), d.file.c_str(), d.line);
        CHECK(p.ok());
        CHECK(WgslEmitter::emit(p).ok());
    }
}

}  // namespace

TN_TEST_MAIN({"operators", operators})
