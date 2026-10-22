#include "check.h"
#include "engine/shader/ir.h"
#include "engine/shader/wgsl.h"

#include <cstdio>
#include <string>

using namespace tn::engine::shader;

namespace {

void order() {
    Program p(Stage::Compute);
    const uint32_t out = p.storageBuffer("out", Type::f32());
    CHECK(p.storageBuffer("out", Type::f32()) == out);
    const ExprId time = p.uniform("time", Type::f32());
    const ExprId two = p.constant(2.0f);
    CHECK(p.add(time, two) == p.add(time, two));        // pure: one node
    CHECK(p.constant(2.0f) == two);
    const size_t before = p.exprCount();
    p.mul(time, p.add(time, two));
    p.mul(time, p.add(time, two));
    CHECK(p.exprCount() == before + 1);                  // the repeat added nothing

    const VarId v = p.var(Type::f32(), p.constant(0.0f));
    p.If(p.less(time, two), [&] {
        p.assign(v, p.add(p.load(v), p.constant(1.0f)));
        p.store(out, p.constant(0), p.load(v));
    }, [&] {
        p.store(out, p.constant(0), time);
    });
    p.Loop(p.constant(4), [&](ExprId i) {
        p.assign(v, p.mul(p.load(v), two));
        p.If(p.less(i, p.constant(2)), [&] { p.store(out, i, p.load(v)); });
    });
    p.store(out, p.constant(1), p.load(v));
    CHECK(p.load(v) != p.load(v));                       // ordered reads are never merged

    const std::string want =
        "v0 = 0f\n"
        "if less(uniform:time, 2f) {\n"
        "  %0 = load v0\n"
        "  v0 = add(%0, 1f)\n"
        "  %1 = load v0\n"
        "  store out[0i] = %1\n"
        "} else {\n"
        "  store out[0i] = uniform:time\n"
        "}\n"
        "loop v1 < 4i {\n"
        "  %2 = load v1\n"
        "  %3 = load v0\n"
        "  v0 = mul(%3, 2f)\n"
        "  if less(%2, 2i) {\n"
        "    %4 = load v0\n"
        "    store out[%2] = %4\n"
        "  }\n"
        "}\n"
        "%5 = load v0\n"
        "store out[1i] = %5\n"
        "%6 = load v0\n"
        "%7 = load v0\n";
    const std::string got = p.dump();
    CHECK(got == want);
    if (got != want) std::fprintf(stderr, "--- dump ---\n%s", got.c_str());
    CHECK(p.ok());
}

// Each case must raise TN_TSL_TYPE at the line that authored it.
void types() {
    struct Case {
        const char* name;
        Stage stage;
        void (*build)(Program&, uint32_t& line);
    };
    const Case cases[] = {
        {"vec3 + vec2", Stage::Fragment, [](Program& p, uint32_t& line) {
             const ExprId a = p.uniform("a", Type::vec(3));
             const ExprId b = p.uniform("b", Type::vec(2));
             line = __LINE__ + 1;
             p.add(a, b);
         }},
        {"swizzle past arity", Stage::Fragment, [](Program& p, uint32_t& line) {
             const ExprId v = p.uniform("v", Type::vec(2));
             line = __LINE__ + 1;
             p.swizzle(v, "xyz");
         }},
        {"mixed lane sets", Stage::Fragment, [](Program& p, uint32_t& line) {
             const ExprId v = p.uniform("v", Type::vec(4));
             line = __LINE__ + 1;
             p.swizzle(v, "xg");
         }},
        {"conflicting storage type", Stage::Compute, [](Program& p, uint32_t& line) {
             p.storageBuffer("shared", Type::f32());
             line = __LINE__ + 1;
             p.storageBuffer("shared", Type::vec(3));
         }},
        {"conflicting storage atomic access", Stage::Compute, [](Program& p, uint32_t& line) {
             p.storageBuffer("shared", Type::u32());
             line = __LINE__ + 1;
             p.storageBuffer("shared", Type::u32(), true);
         }},
        {"storage write in vertex", Stage::Vertex, [](Program& p, uint32_t& line) {
             const uint32_t b = p.storageBuffer("b", Type::f32());
             line = __LINE__ + 1;
             p.store(b, p.constant(0), p.constant(1.0f));
         }},
        {"assign mismatch", Stage::Fragment, [](Program& p, uint32_t& line) {
             const VarId v = p.var(Type::vec(3), p.uniform("c", Type::vec(3)));
             line = __LINE__ + 1;
             p.assign(v, p.constant(1.0f));
         }},
        {"non-bool condition", Stage::Fragment, [](Program& p, uint32_t& line) {
             line = __LINE__ + 1;
             p.If(p.constant(1.0f), [] {});
         }},
        {"fragment builtin in vertex", Stage::Vertex, [](Program& p, uint32_t& line) {
             line = __LINE__ + 1;
             p.builtin("frontFacing");
         }},
        {"discard outside fragment", Stage::Compute, [](Program& p, uint32_t& line) {
             line = __LINE__ + 1;
             p.discard();
         }},
        {"mat4 * vec3", Stage::Vertex, [](Program& p, uint32_t& line) {
             const ExprId m = p.uniform("m", Type::mat(4, 4));
             const ExprId v = p.uniform("v", Type::vec(3));
             line = __LINE__ + 1;
             p.mul(m, v);
         }},
        {"construct short", Stage::Fragment, [](Program& p, uint32_t& line) {
             const ExprId x = p.constant(1.0f);
             line = __LINE__ + 1;
             p.construct(Type::vec(4), {x, x});
         }},
        {"sampleLevel integer level", Stage::Fragment, [](Program& p, uint32_t& line) {
             const auto texture = p.texture2d("env");
             const auto uv = p.construct(Type::vec(2), {p.constant(0.5f)});
             line = __LINE__ + 1;
             p.sampleLevel(texture, uv, p.constant(int32_t(0)));
         }},
        {"dot of scalars", Stage::Fragment, [](Program& p, uint32_t& line) {
             const ExprId x = p.constant(1.0f);
             line = __LINE__ + 1;
             p.call("dot", {x, x});
         }},
    };
    for (const Case& c : cases) {
        Program p(c.stage);
        uint32_t line = 0;
        c.build(p, line);
        const bool one = p.diagnostics().size() == 1;
        const bool typed = one && p.diagnostics()[0].code == "TN_TSL_TYPE";
        const bool located = one && p.diagnostics()[0].line == line &&
                             std::string(p.diagnostics()[0].file).find("shader_ir_test.cpp") != std::string::npos;
        if (!typed || !located) std::fprintf(stderr, "case '%s' wrong diagnostic\n", c.name);
        CHECK(typed);
        CHECK(located);
    }

    // An invalid node poisons what is built on it without a cascade of diagnostics.
    Program p(Stage::Fragment);
    const ExprId bad = p.add(p.uniform("a", Type::vec(3)), p.uniform("b", Type::vec(2)));
    p.mul(p.add(bad, bad), p.constant(2.0f));
    CHECK(p.diagnostics().size() == 1);

    // Valid shapes stay valid: broadcasting, mat * vec, splats, mix with a scalar t.
    Program ok(Stage::Vertex);
    const ExprId m = ok.uniform("m", Type::mat(4, 4));
    const ExprId v4 = ok.construct(Type::vec(4), {ok.attribute("position", Type::vec(3)), ok.constant(1.0f)});
    ok.mul(m, v4);
    ok.mul(ok.uniform("v", Type::vec(3)), ok.constant(2.0f));
    ok.construct(Type::vec(3), {ok.constant(1.0f)});
    ok.call("mix", {ok.uniform("a", Type::vec(3)), ok.uniform("b", Type::vec(3)), ok.constant(0.5f)});
    ok.swizzle(v4, "zyx");
    CHECK(ok.ok());
}

void unsupported() {
    Program p(Stage::Fragment);
    p.call("mx_noise_float", {p.constant(1.0f)});
    p.builtin("sampleMask");
    CHECK(p.diagnostics().size() == 2);
    CHECK(p.diagnostics()[0].code == "TN_TSL_UNSUPPORTED" && p.diagnostics()[0].node == "mx_noise_float");
    CHECK(p.diagnostics()[1].code == "TN_TSL_UNSUPPORTED" && p.diagnostics()[1].node == "sampleMask");
}


void storageTextures() {
    for (const std::string format : {"rgba16float", "rgba32float", "rgba8unorm"}) {
        Program p(Stage::Compute);
        const auto target = p.storageTexture2d("output", format);
        CHECK(p.storageTexture2d("output", format) == target);
        const auto coordinate = p.construct(Type::vec(2, Type::Scalar::U32), {p.construct(Type::u32(), {p.constant(int32_t(3))})});
        const auto value = p.construct(Type::vec(4), {p.constant(0.5f)});
        p.textureStore(target, coordinate, value);
        CHECK(p.ok());
        CHECK(p.dump().find("textureStore output[") != std::string::npos);
        const auto module = WgslEmitter::emit(p);
        CHECK(module.ok());
        CHECK(module.code.find("texture_storage_2d<" + format + ", write>") != std::string::npos);
        CHECK(module.code.find("textureStore(st_output,") != std::string::npos);
    }
    for (int bad = 0; bad < 5; ++bad) {
        Program p(bad == 0 ? Stage::Fragment : Stage::Compute);
        const auto target = p.storageTexture2d("output", "rgba16float");
        const auto coordinate = p.construct(Type::vec(2, bad == 2 ? Type::Scalar::F32 : Type::Scalar::I32), {bad == 2 ? p.constant(0.0f) : p.constant(int32_t(0))});
        const auto value = p.construct(bad == 3 ? Type::vec(3) : Type::vec(4), {p.constant(1.0f)});
        p.textureStore(bad == 1 ? target + 1 : target, bad == 4 ? kInvalid : coordinate, value);
        CHECK(!p.ok() && p.diagnostics().size() == 1);
        if (!p.diagnostics().empty()) CHECK(p.diagnostics()[0].node == "textureStore");
        CHECK(p.dump().find("textureStore output[") == std::string::npos);
    }
    Program p(Stage::Compute);
    CHECK(p.storageTexture2d("bad", "r32float") == kInvalid);
    CHECK(!p.ok() && p.diagnostics()[0].node == "storageTexture2d");
}

}  // namespace

TN_TEST_MAIN({"storage_textures", storageTextures}, {"order", order}, {"types", types}, {"unsupported", unsupported})
