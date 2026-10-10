#include "check.h"
#include "engine/abi/abi_internal.h"
#include "engine/abi/tsl_call.h"
#include "engine/shader/graph/serialized.h"
#include "threenative/abi/tn_tsl.h"
#include <cstring>

namespace {
// The enabled minimal-template chain, through the same TSL table Perry calls.
void template_chain() {
    using A = tn::abi::TslArg;
    uint64_t serial = 0;
    const auto f = [&](const char* name, std::vector<A> args = {}) {
        auto result = tn::abi::tslCall(name, nullptr, args, serial);
        CHECK(result != nullptr);
        return result;
    };
    const auto method = [&](const char* name, auto node, std::vector<A> args = {}) {
        const auto self = A::of(node);
        auto result = tn::abi::tslCall(name, &self, args, serial);
        CHECK(result != nullptr);
        return result;
    };
    const auto uv = f("uv");
    const auto texture = [&](const char* name) { return f("texture", {A::named(name), A::of(uv)}); };
    const auto base = f("convertToTexture", {A::of(texture("scene"))});
    const auto depth = texture("depth"), normal = texture("normal");
    const auto ao = f("ao", {A::of(depth), A::of(normal), A::other()});
    const auto denoise = f("denoise", {A::of(ao), A::of(depth), A::of(normal), A::other()});
    const auto exposed = method("mul", base, {A::of(0.62)});
    const auto lit = method("mul", exposed, {A::of(method("swizzle:x", denoise))});
    const auto glow = f("bloom", {A::of(f("convertToTexture", {A::of(lit)})), A::of(0.22), A::of(0.6), A::of(1.0)});
    const auto centred = method("sub", f("screenUV"), {A::of(f("vec2", {A::of(0.5), A::of(0.5)}))});
    const auto radius = method("mul", method("length", method("mul", centred,
        {A::of(f("vec2", {A::of(1.78), A::of(1.0)}))})), {A::of(1.04)});
    const auto fall = method("mul", f("smoothstep", {A::of(f("float", {A::of(0.55)})),
        A::of(f("float", {A::of(1.02)})), A::of(radius)}), {A::of(0.22)});
    const auto colour = method("mul", method("add", lit, {A::of(glow)}), {A::of(method("oneMinus", fall))});
    const auto peak = [&](auto node) {
        const auto lane = [&](const char* name) { return method((std::string("swizzle:") + name).c_str(), node); };
        return f("max", {A::of(lane("x")), A::of(f("max", {A::of(lane("y")), A::of(lane("z"))}))});
    };
    const auto squeezed = method("div", colour, {A::of(method("add", peak(colour), {A::of(1.0)}))});
    const auto filtered = f("smaa", {A::of(squeezed)});
    const auto denominator = method("max", method("sub", f("float", {A::of(1.0)}), {A::of(peak(filtered))}), {A::of(1e-4)});
    CHECK(!tn::engine::shader::graph::serializedPost(method("div", filtered, {A::of(denominator)})).passes.empty());
}
tn_context_t* context() {
    tn_context_t* result = nullptr;
    const auto version = tn_engine_version();
    tn_diagnostic_t diagnostic{};
    CHECK(tn_context_create(&result, &version, &diagnostic) == TN_OK);
    tn_diagnostic_release(&diagnostic);
    return result;
}
uint64_t node(tn_context_t* ctx) {
    uint64_t result = 0;
    tn_diagnostic_t diagnostic{};
    CHECK(tn_tsl_call(ctx, "uv", nullptr, nullptr, 0, &result, &diagnostic) == TN_OK);
    tn_diagnostic_release(&diagnostic);
    return result;
}
void graph() {
    const auto ctx = context();
    auto id = node(ctx);
    const auto expected = tn::abi::tslNode(ctx, id);
    CHECK(js_tnp_set_post(reinterpret_cast<int64_t>(ctx), reinterpret_cast<int64_t>(&id)) == 0);
    CHECK(tn::abi::perryPostGraph() == expected); // pending before any renderer exists
    CHECK(js_tnp_set_post(reinterpret_cast<int64_t>(ctx), reinterpret_cast<int64_t>(&id)) == 0);
    CHECK(tn::abi::perryPostGraph() == expected); // unchanged graph keeps its identity
    tn_diagnostic_t diagnostic{};
    CHECK(tn_tsl_release(ctx, id, &diagnostic) == TN_OK);
    CHECK(tn::abi::perryPostGraph() == expected); // the post graph owns its lifetime
    tn_diagnostic_release(&diagnostic);
    CHECK(js_tnp_set_post(0, 0) == 0);
    CHECK(!tn::abi::perryPostGraph());
    CHECK(tn_context_destroy(ctx, nullptr) == TN_OK);
}
void rejects() {
    const auto a = context(), b = context();
    auto id = node(a);
    CHECK(js_tnp_set_post(reinterpret_cast<int64_t>(a), reinterpret_cast<int64_t>(&id)) == 0);
    const auto kept = tn::abi::perryPostGraph();
    for (const auto ctx : {b, static_cast<tn_context_t*>(nullptr)}) {
        const auto error = js_tnp_set_post(reinterpret_cast<int64_t>(ctx), reinterpret_cast<int64_t>(&id));
        CHECK(error != 0);
        if (error) CHECK(std::strcmp(reinterpret_cast<const char*>(error),
            "TN_PERRY_POST: not a TSL node of this context") == 0);
        CHECK(tn::abi::perryPostGraph() == kept);
    }
    id = 999999;
    CHECK(js_tnp_set_post(reinterpret_cast<int64_t>(a), reinterpret_cast<int64_t>(&id)) != 0);
    CHECK(tn::abi::perryPostGraph() == kept);
    CHECK(js_tnp_set_post(0, 0) == 0);
    CHECK(tn_context_destroy(a, nullptr) == TN_OK);
    CHECK(tn_context_destroy(b, nullptr) == TN_OK);
}
}
TN_TEST_MAIN({"graph", graph}, {"rejects", rejects}, {"template_chain", template_chain})
