#include "check.h"
#include "engine/shader/ir.h"
#include "engine/shader/wgsl.h"

#include <cstdio>
#include <string>

using namespace tn::engine::shader;

// The builder API always writes a variable before it can be read. This hands a test the statement
// lists, to build the order it cannot: a variable's one write moved after its reads.
namespace tn::engine::shader {
struct ProgramTestAccess {
    static void writeLast(Program& p, VarId v) {
        for (auto& block : p.blocks_) {
            for (std::size_t i = 0; i < block.size(); ++i) {
                if (block[i].kind != Program::StmtKind::Assign || block[i].a != v) continue;
                const Program::Stmt write = block[i];
                block.erase(block.begin() + static_cast<std::ptrdiff_t>(i));
                block.push_back(write);
                return;
            }
        }
    }
};
}  // namespace tn::engine::shader

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
    CHECK(p.load(v) == p.load(v));                       // no write between two reads: one read
    const ExprId stale = p.load(v);
    p.assign(v, p.constant(0.0f));
    CHECK(p.load(v) != stale);                           // a write makes the next read fresh

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
        "v0 = 0f\n"
        "%6 = load v0\n";
    const std::string got = p.dump();
    CHECK(got == want);
    if (got != want) std::fprintf(stderr, "--- dump ---\n%s", got.c_str());
    CHECK(p.ok());
}

// PRD-617: the shape of the WGSL the emitter writes for variables.
std::size_t count(const std::string& code, const std::string& needle) {
    std::size_t n = 0;
    for (std::size_t at = code.find(needle); at != std::string::npos; at = code.find(needle, at + 1)) ++n;
    return n;
}

std::string wgsl(const Program& p) {
    const WgslModule module = WgslEmitter::emit(p);
    CHECK(module.ok());
    return module.code;
}

#define CHECK_SHAPE(code, condition) \
    do { CHECK(condition); if (!(condition)) std::fprintf(stderr, "--- WGSL ---\n%s", (code).c_str()); } while (0)

// A variable written once is a `let` at its definition, and reading it twice reloads nothing.
void singleAssignIsLet() {
    Program p(Stage::Fragment);
    const ExprId x = p.uniform("x", Type::f32());
    const VarId v = p.var(Type::f32(), p.mul(x, x));
    const ExprId a = p.load(v);
    p.output("color", p.construct(Type::vec(4), {a, p.load(v), p.add(p.load(v), a), p.constant(1.0f)}));
    const std::string code = wgsl(p);
    CHECK_SHAPE(code, count(code, "var v0") == 0);
    CHECK_SHAPE(code, count(code, "let v0 = ") == 1);
    CHECK_SHAPE(code, count(code, "= v0;") == 0);  // no `let lN = v0;` reload
}

// Two reads with no write between are one read; a write in between makes the next read fresh.
void loadsSurviveUntilWritten() {
    Program p(Stage::Fragment);
    const ExprId x = p.uniform("x", Type::f32());
    const VarId v = p.var(Type::f32(), x);
    p.assign(v, p.add(p.load(v), p.constant(1.0f)));  // v is written twice: it stays a var
    const ExprId first = p.load(v);
    CHECK(p.load(v) == first);                         // nothing wrote v since
    CHECK(p.add(first, p.constant(2.0f)) == p.add(p.load(v), p.constant(2.0f)));
    p.assign(v, p.mul(first, first));
    const ExprId after = p.load(v);
    CHECK(after != first);                             // the write made the old read stale
    p.output("color", p.construct(Type::vec(4), {first, after, p.load(v), p.constant(1.0f)}));
    const std::string code = wgsl(p);
    CHECK_SHAPE(code, count(code, "var v0: f32;") == 1);
    // reads: one for the first assign's operand, one before the second write, one after it
    CHECK_SHAPE(code, count(code, "= v0;") == 3);
}

// A variable a loop writes stays a var, and a read from before the loop is not reused inside it.
void loopCarriedStaysVar() {
    Program p(Stage::Fragment);
    const ExprId x = p.uniform("x", Type::f32());
    const VarId v = p.var(Type::f32(), x);
    const ExprId before = p.load(v);
    ExprId inside = kInvalid;
    p.Loop(p.constant(4), [&](ExprId) {
        inside = p.load(v);
        p.assign(v, p.add(inside, p.constant(1.0f)));
    });
    CHECK(inside != before);                           // the body sees the previous iteration's write
    const ExprId after = p.load(v);
    CHECK(after != before && after != inside);         // the loop wrote v
    p.output("color", p.construct(Type::vec(4), {before, after, p.constant(0.0f), p.constant(1.0f)}));
    const std::string code = wgsl(p);
    CHECK_SHAPE(code, count(code, "var v0: f32;") == 1);
    CHECK_SHAPE(code, count(code, "let v0 = ") == 0);
    CHECK_SHAPE(code, count(code, "v0 = ") == 2);      // the initial value and the body
    const std::size_t loop = code.find("for (");
    const std::size_t reload = code.find("= v0;", loop);
    CHECK_SHAPE(code, loop != std::string::npos && reload != std::string::npos && reload < code.find('}', loop));
}

// A variable a branch writes stays a var, and the join reads it again.
void branchWriteStaysVar() {
    Program p(Stage::Fragment);
    const ExprId x = p.uniform("x", Type::f32());
    const VarId v = p.var(Type::f32(), p.constant(0.0f));
    const ExprId before = p.load(v);
    p.If(p.less(x, p.constant(1.0f)), [&] { p.assign(v, x); });
    const ExprId after = p.load(v);
    CHECK(after != before);
    p.output("color", p.construct(Type::vec(4), {before, after, p.constant(0.0f), p.constant(1.0f)}));
    const std::string code = wgsl(p);
    CHECK_SHAPE(code, count(code, "var v0: f32;") == 1);
    CHECK_SHAPE(code, count(code, "= v0;") == 2);
}

// A variable first written inside a branch and read outside it has no `let` scope to live in: it stays a var.
void branchLocalReadOutsideStaysVar() {
    Program p(Stage::Fragment);
    const ExprId x = p.uniform("x", Type::f32());
    VarId v = 0;
    p.If(p.less(x, p.constant(1.0f)), [&] { v = p.var(Type::f32(), x); });
    p.output("color", p.construct(Type::vec(4), {p.load(v), p.constant(0.0f), p.constant(0.0f), p.constant(1.0f)}));
    const std::string code = wgsl(p);
    CHECK_SHAPE(code, count(code, "var v0: f32;") == 1);
}

// A variable's one write that comes after a read of it cannot be a `let`: the read would name it before it exists.
void readBeforeSingleWriteStaysVar() {
    {  // the read opens a loop body and the one write ends it: the read is loop-carried
        Program p(Stage::Fragment);
        const ExprId x = p.uniform("x", Type::f32());
        VarId v = 0;
        p.Loop(p.constant(4), [&](ExprId) {
            v = p.var(Type::f32(), x);
            p.output("color", p.construct(Type::vec(4), {p.load(v), p.constant(0.0f), p.constant(0.0f), p.constant(1.0f)}));
        });
        ProgramTestAccess::writeLast(p, v);
        const std::string code = wgsl(p);
        CHECK_SHAPE(code, count(code, "let v" + std::to_string(v) + " = ") == 0);
        CHECK_SHAPE(code, count(code, "var v" + std::to_string(v) + ": f32;") == 1);
    }
    {  // the read sits in a branch that precedes the write in the defining block
        Program p(Stage::Fragment);
        const ExprId x = p.uniform("x", Type::f32());
        const VarId v = p.var(Type::f32(), x);
        p.If(p.less(x, p.constant(1.0f)), [&] {
            p.output("color", p.construct(Type::vec(4), {p.load(v), p.constant(0.0f), p.constant(0.0f), p.constant(1.0f)}));
        });
        ProgramTestAccess::writeLast(p, v);
        const std::string code = wgsl(p);
        CHECK_SHAPE(code, count(code, "let v0 = ") == 0);
        CHECK_SHAPE(code, count(code, "var v0: f32;") == 1);
    }
}

// A read made in a branch is out of scope at the join, and a read before it is still good there.
void readsKeepTheirScope() {
    Program p(Stage::Fragment);
    const ExprId x = p.uniform("x", Type::f32());
    const VarId v = p.var(Type::f32(), x);
    p.assign(v, p.add(p.load(v), x));  // two writes: a var
    const ExprId outer = p.load(v);
    ExprId inner = kInvalid;
    p.If(p.less(x, p.constant(1.0f)), [&] {
        CHECK(p.load(v) == outer);     // reused: no write since, and `outer` is in scope
    });
    p.If(p.less(x, p.constant(2.0f)), [&] { p.assign(v, x); inner = p.load(v); });
    const ExprId join = p.load(v);
    CHECK(join != inner && join != outer);
    p.output("color", p.construct(Type::vec(4), {outer, join, p.constant(0.0f), p.constant(1.0f)}));
    CHECK(!wgsl(p).empty());
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

}  // namespace

TN_TEST_MAIN({"order", order}, {"types", types}, {"unsupported", unsupported},
            {"single_assign_is_let", singleAssignIsLet}, {"loads_survive_until_written", loadsSurviveUntilWritten},
            {"loop_carried_stays_var", loopCarriedStaysVar}, {"branch_write_stays_var", branchWriteStaysVar},
            {"branch_local_read_outside_stays_var", branchLocalReadOutsideStaysVar}, {"reads_keep_their_scope", readsKeepTheirScope},
            {"read_before_single_write_stays_var", readBeforeSingleWriteStaysVar})
