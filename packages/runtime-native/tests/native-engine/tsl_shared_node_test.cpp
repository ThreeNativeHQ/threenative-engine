#include "check.h"
#include "engine/shader/graph/graph.h"
#include "engine/shader/standard.h"
#include "engine/shader/tsl/tsl.h"
#include "engine/shader/wgsl.h"
#include <cstdio>
#include <cstdlib>
#include <string>

using namespace tn::engine::shader;
namespace g = tn::engine::shader::graph;
namespace {
size_t occurrences(const std::string& text, const std::string& needle) {
    size_t count = 0, at = 0;
    while ((at = text.find(needle, at)) != std::string::npos) { ++count; at += needle.size(); }
    return count;
}
void shared() {
    g::Block block;
    const auto x = block.var(g::uniform("x", Type::f32()));
    const auto n = g::mul(x, g::float_(2));
    const auto out = g::storage("out", Type::f32());
    block.assign(out.element(g::int_(0)), n);
    block.assign(x, g::float_(0.2));
    block.assign(out.element(g::int_(1)), n);
    // A bare var read must still observe the assignment.
    block.assign(out.element(g::int_(2)), x);
    Program p(Stage::Compute); tsl::Build build(p);
    g::lower(block.node(), p);
    const auto dump = p.dump();
    CHECK(p.ok());
    CHECK(occurrences(dump, "mul(") == 1);
    const auto first = dump.find("store out[0i] = ");
    const auto second = dump.find("store out[1i] = ");
    CHECK(first != std::string::npos && second != std::string::npos);
    if (first != std::string::npos && second != std::string::npos) {
        const auto value = [&](size_t at) { at = dump.find(" = ", at) + 3; return dump.substr(at, dump.find('\n', at) - at); };
        CHECK(value(first) == value(second));
    }
    CHECK(occurrences(dump, "load v0") == 2);
    CHECK(WgslEmitter::emit(p).ok());
}
void probe() {
    for (int mode = 0; mode < 3; ++mode) {
        g::Block block;
        const auto a = block.var(g::float_(0.8));
        const auto half = g::mul(a, g::float_(0.5));
        block.assign(a, g::sub(a, half));
        const auto c = block.var(g::float_(0));
        block.assign(c, half);
        auto body = std::make_shared<g::NodeData>(*block.node());
        body->args = {g::vec4({c, a, g::float_(0), g::float_(1)})};
        if (mode == 2) {
            auto early = std::make_shared<g::NodeData>(); early->kind = g::Kind::Return;
            auto branch = std::make_shared<g::NodeData>(); branch->kind = g::Kind::If;
            branch->args = {g::greaterThan(a, g::float_(1))}; branch->body = {early};
            body->body.insert(body->body.begin() + 1, branch);
        }
        g::Node graph = body;
        if (mode != 0) {
            auto invocation = std::make_shared<g::NodeData>();
            invocation->kind = g::Kind::Call; invocation->type = Type::vec(4);
            invocation->args = {body}; graph = invocation;
        }
        Program p(Stage::Compute); tsl::Build build(p);
        CHECK(g::lower(graph, p) != kInvalid);
        CHECK(occurrences(p.dump(), "mul(") == 1);
        CHECK(WgslEmitter::emit(p).ok());
    }
}
void scopes() {
    // Branch/loop first use cannot supply an ordered temporary outside that block;
    // parent first use can be reused by its children.
    for (int mode = 0; mode < 3; ++mode) {
        g::Block block;
        const auto x = block.var(g::uniform("x", Type::f32()));
        const auto n = g::mul(x, g::float_(2));
        const auto out = g::storage("out", Type::f32());
        auto reads = [&] {
            block.assign(out.element(g::int_(0)), n);
            block.assign(x, g::float_(0.2));
            block.assign(out.element(g::int_(1)), n);
        };
        if (mode == 2) block.assign(out.element(g::int_(3)), n);
        if (mode == 1) block.Loop(2, [&](g::Node) { reads(); });
        else block.IfElse(g::greaterThan(x, g::float_(0)), reads, reads);
        block.assign(out.element(g::int_(2)), n);
        Program p(Stage::Compute); tsl::Build build(p);
        g::lower(block.node(), p);
        CHECK(p.ok());
        CHECK(occurrences(p.dump(), "mul(") == (mode == 2 ? 1 : mode == 1 ? 2 : 3));
        CHECK(WgslEmitter::emit(p).ok());
    }
}
}
// One Fn call read by two statements lowers once, as three caches a call's output for the build. A call is
// statements (loops, samples), so re-lowering it per read repeats them: the world impostor's ray march read
// by colour, normal and coverage ran twice a fragment, 46 ms against three's 10 ms (PRD-858).
void callOnce() {
    g::Block inner;
    const auto acc = inner.var(g::float_(0));
    inner.Loop(4, [&](g::Node) { inner.assign(acc, g::add(acc, g::mul(g::uniform("x", Type::f32()), g::float_(2)))); });
    auto body = std::make_shared<g::NodeData>(*inner.node());
    body->args = {acc};
    auto invocation = std::make_shared<g::NodeData>();
    invocation->kind = g::Kind::Call; invocation->type = Type::f32(); invocation->args = {body};
    g::Block block;
    const auto out = g::storage("out", Type::f32());
    block.assign(out.element(g::int_(0)), invocation);
    block.assign(out.element(g::int_(1)), g::add(invocation, g::float_(1)));
    Program p(Stage::Compute); tsl::Build build(p);
    g::lower(block.node(), p);
    CHECK(p.ok());
    CHECK(occurrences(p.dump(), "mul(") == 1);
    CHECK(WgslEmitter::emit(p).ok());
}
// A Fn body the normalNode shares with the colorNode lowers its loop once in the material's fragment. The normal
// lowered apart from the other slots, so the world impostor's march ran once for the normal and again for colour
// and coverage (PRD-858).
void normalSharesSlots() {
    g::Block inner;
    const auto acc = inner.var(g::float_(0));
    inner.Loop(4, [&](g::Node) { inner.assign(acc, g::add(acc, g::mul(g::uniform("x", Type::f32()), g::float_(2)))); });
    auto march = std::make_shared<g::NodeData>(*inner.node());
    march->args = {g::vec4({acc, acc, g::float_(1), g::float_(1)})};
    VertexVariant variant;
    variant.nodes.normalNode = g::swizzle(march, "xyz");
    variant.nodes.colorNode = march;
    const auto programs = buildStandard(StandardMaterial{}, variant);
    CHECK(programs.diagnostics.empty());
    const auto wgsl = WgslEmitter::emit(programs.fragment, 1);
    CHECK(wgsl.ok());
    CHECK(occurrences(wgsl.code, "for (") == 1);
}
// A variable made outside any Fn is declared at the top of the program, its inputs first: a hoisted variable that
// lowers a loop which reads another hoisted variable must not declare that one inside the loop. The world impostor's
// march mip level (derivatives included) was evaluated on each of 33 steps instead of once (PRD-858).
void hoistedInputsFirst() {
    const auto hoist = [](g::Node value) {
        g::Block scratch;
        auto declared = std::make_shared<g::NodeData>(*scratch.var(value).declaration);
        declared->bits = 1;
        return g::Node(declared);
    };
    const auto level = hoist(g::mul(g::uniform("x", Type::f32()), g::float_(2)));
    g::Block inner;
    const auto acc = inner.var(g::float_(0));
    inner.Loop(4, [&](g::Node) { inner.assign(acc, g::add(acc, level)); });
    auto march = std::make_shared<g::NodeData>(*inner.node());
    march->args = {acc};
    const auto result = hoist(march);
    Program p(Stage::Compute); tsl::Build build(p);
    g::lower(g::add(result, g::float_(1)), p);
    CHECK(p.ok());
    const auto dump = p.dump();
    if (std::getenv("TN_TEST_DUMP")) std::fprintf(stderr, "%s\n", dump.c_str());
    CHECK(dump.find("mul(") != std::string::npos && dump.find("mul(") < dump.find("loop"));
    CHECK(WgslEmitter::emit(p).ok());
}
// Live TSL compares like r185 OperatorNode: a uint index against a float uniform is promoted, not
// refused (PRD-857: the GPU world scene's `instanceIndex.greaterThanEqual(counts.w)`).
void mixedCompare() {
    for (int op = 0; op < 4; ++op) {
        g::Block block;
        const auto limit = g::uniform("limit", Type::f32(), {4});
        const auto index = g::instanceIndex();
        const g::Node test = op == 0 ? g::greaterThanEqual(index, limit) : op == 1 ? g::lessThanEqual(index, limit)
                           : op == 2 ? g::lessThan(index, limit) : g::greaterThan(limit, index);
        const auto out = g::storage("out", Type::u32());
        block.If(test, [&] { block.assign(out.element(g::int_(0)), g::uint_(1u)); });
        Program p(Stage::Compute); tsl::Build build(p);
        g::lower(block.node(), p);
        if (!p.ok()) std::fprintf(stderr, "mixedCompare op %d: %s\n", op, (p.diagnostics().front().node + ": " + p.diagnostics().front().reason).c_str());
        CHECK(p.ok());
        CHECK(WgslEmitter::emit(p).ok());
    }
    // Arithmetic: f32 + i32 is an f32 on three, whichever side the integer is on.
    for (int side = 0; side < 2; ++side) {
        g::Block block;
        const auto f = g::uniform("f", Type::f32(), {0.5f});
        const auto i = g::storage("ints", Type::i32()).element(g::int_(0));
        const auto out = g::storage("out", Type::f32());
        block.assign(out.element(g::int_(0)), side == 0 ? g::add(f, i) : g::add(i, f));
        Program p(Stage::Compute); tsl::Build build(p);
        g::lower(block.node(), p);
        if (!p.ok()) std::fprintf(stderr, "mixedAdd side %d: %s\n", side, (p.diagnostics().front().node + ": " + p.diagnostics().front().reason).c_str());
        CHECK(p.ok());
        CHECK(WgslEmitter::emit(p).ok());
    }
}
TN_TEST_MAIN({"shared", [] { shared(); probe(); mixedCompare(); callOnce(); normalSharesSlots(); hoistedInputsFirst(); }}, {"scopes", scopes})
