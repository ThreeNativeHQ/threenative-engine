#include "check.h"
#include "engine/shader/tonemap.h"
#include "engine/shader/output.h"
#include "engine/shader/wgsl.h"

#include <cstdio>

using namespace tn::engine::shader;

namespace {

// Every operator builds well-typed IR and emits WGSL; the GPU validates it in the shader suites.
void operators() {
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
