#include "check.h"
#include "engine/shader/ir.h"
#include "engine/abi/tsl_call.h"
#include "engine/shader/graph/serialized.h"
#include "engine/shader/tsl/tsl.h"
#include <cstdlib>
#include "engine/shader/wgsl.h"
#include <string>
using namespace tn::engine::shader;
namespace {
namespace g = tn::engine::shader::graph;
using tn::abi::TslArg;
void emitted(Program& p, ExprId value, const std::string& expected) {
    CHECK(value != kInvalid);
    if (value == kInvalid) return;
    p.var(p.expr(value).type, value);
    const auto wgsl = WgslEmitter::emit(p);
    CHECK(wgsl.ok());
    CHECK(wgsl.code.find(expected) != std::string::npos);
    if (std::getenv("TN_TSL_MATH_DUMP")) std::printf("WGSL_BEGIN\n%sWGSL_END\n", wgsl.code.c_str());
}
void math() {
    const char* unary[] = {"acos", "asin", "tan", "ceil", "round", "trunc", "inverseSqrt", "reciprocal", "radians", "degrees", "sinh", "cosh", "tanh", "asinh", "acosh", "atanh", "saturate", "oneMinus", "negate", "pow2", "pow3", "pow4", "cbrt"};
    for (const char* op : unary) for (uint8_t lanes : {1, 3}) {
        Program p(Stage::Compute);
        auto a = p.uniform("a", Type::vec(lanes));
        auto value = p.call(op, {a});
        if (value == kInvalid) std::fprintf(stderr, "missing %s/%u\n", op, lanes);
        CHECK(value != kInvalid);
        if (value == kInvalid) continue;
        CHECK(p.expr(value).type == Type::vec(lanes));
        p.var(p.expr(value).type, value);
        auto wgsl = WgslEmitter::emit(p);
        CHECK(wgsl.ok());
        const std::string name = op;
        const auto expected = name == "saturate" ? "clamp(" : name == "cbrt" ? "pow(" : name == "reciprocal" ? " / " : name == "oneMinus" ? " - " : name == "negate" ? "-" : name.starts_with("pow") ? " * " : name + "(";
        CHECK(wgsl.code.find(expected) != std::string::npos);
        if (std::getenv("TN_TSL_MATH_DUMP")) std::printf("WGSL_BEGIN\n%sWGSL_END\n", wgsl.code.c_str());
        // Same operation through the shared JS ABI, in function and fluent form.
        for (bool method : {false, true}) {
            uint64_t serial = 0;
            const auto receiver = TslArg::of(g::uniform("a", Type::vec(lanes)));
            const auto graph = tn::abi::tslCall(op, method ? &receiver : nullptr, method ? std::vector<TslArg>{} : std::vector<TslArg>{receiver}, serial);
            CHECK(graph != nullptr);
            if (!graph) continue;
            Program abi(Stage::Compute); tsl::Build build(abi);
            emitted(abi, g::lower(graph, abi), expected);
        }
    }
    for (uint8_t n : {2, 3, 4}) for (const char* op : {"transpose", "determinant", "inverse"}) {
        Program p(Stage::Compute);
        auto value = p.call(op, {p.uniform("m", Type::mat(n, n))});
        CHECK(value != kInvalid);
        if (value == kInvalid) continue;
        CHECK(p.expr(value).type == (std::string(op) == "determinant" ? Type::f32() : Type::mat(n, n)));
        p.var(p.expr(value).type, value);
        auto wgsl = WgslEmitter::emit(p);
        CHECK(wgsl.ok());
        CHECK(wgsl.code.find(std::string(op) == "inverse" ? "tsl_inverse_mat" + std::to_string(n) : std::string(op) + "(") != std::string::npos);
        if (std::getenv("TN_TSL_MATH_DUMP")) std::printf("WGSL_BEGIN\n%sWGSL_END\n", wgsl.code.c_str());
        uint64_t serial = 0;
        const TslArg matrix = TslArg::of(g::uniform("m", Type::mat(n, n)));
        Program abi(Stage::Compute); tsl::Build build(abi);
        emitted(abi, g::lower(tn::abi::tslCall(op, &matrix, {}, serial), abi), op == std::string("inverse") ? "tsl_inverse_mat" : std::string(op) + "(");
    }
    for (uint8_t lanes : {1, 3}) {
        Program p(Stage::Compute);
        const auto a = p.uniform("a", Type::vec(lanes)), b = p.uniform("b", Type::vec(lanes));
        emitted(p, p.call("difference", {a, b}), "abs(");
        if (lanes == 3) {
            emitted(p, p.call("faceForward", {a, b, a}), "faceForward(");
            emitted(p, p.call("refract", {a, b, p.constant(0.5f)}), "refract(");
        }
        for (const char* op : {"bitAnd", "bitOr", "bitXor", "bitNot", "shiftLeft", "shiftRight"}) {
            const std::string name = op;
            auto value = p.call(op, name == "bitNot" ? std::vector<ExprId>{a} : std::vector<ExprId>{a, p.constant(1.0f)});
            CHECK(value != kInvalid);
            if (value != kInvalid) CHECK(p.expr(value).type == Type::vec(lanes, Type::Scalar::I32));
            emitted(p, value, name == "bitAnd" ? " & " : name == "bitOr" ? " | " : name == "bitXor" ? " ^ " : name == "bitNot" ? "~" : name == "shiftLeft" ? " << " : " >> ");
        }
    }
    for (const char* op : {"transformDirection", "transformNormalByViewMatrix", "transformNormalByInverseViewMatrix"}) {
        for (uint8_t n : {3, 4}) {
            Program p(Stage::Compute);
            const auto direction = p.uniform("d", Type::vec(3)), matrix = p.uniform("m", Type::mat(n, n));
            emitted(p, p.call(op, {direction, matrix}), "normalize(");
            if (op == std::string("transformDirection")) emitted(p, p.call(op, {matrix, direction}), "normalize(");
        }
    }
    {
        Program p(Stage::Compute);
        emitted(p, p.call("rand", {p.uniform("uv", Type::vec(2))}), "tsl_mod_float(");
        emitted(p, p.call("xor", {p.constant(true), p.constant(false)}), " != ");
    }
    // A serialized MathNode reaches exactly the same compiler (including aliases).
    for (const char* op : {"acos", "inversesqrt", "reciprocal", "difference", "atan"}) {
        std::vector<std::string> errors;
        const std::string name = op;
        const auto args = name == "difference" || name == "atan" ? "[0,0]" : "[0]";
        const auto json = "{\"version\":1,\"root\":1,\"nodes\":[{\"kind\":\"ConstNode\",\"type\":\"float\",\"value\":0.5,\"args\":[],\"dependencies\":[]},{\"kind\":\"MathNode\",\"operation\":\"" + name + "\",\"args\":" + args + ",\"dependencies\":[]}]}";
        const auto graph = g::importSerialized(json, errors);
        CHECK(errors.empty()); CHECK(graph != nullptr);
        if (graph) { Program p(Stage::Compute); tsl::Build build(p); emitted(p, g::lower(graph, p), name == "inversesqrt" ? "inverseSqrt(" : name == "reciprocal" ? " / " : name == "difference" ? "abs(" : name == "atan" ? "atan2(" : "acos("); }
    }
    // Postfix preserves the old int(a), prefix yields the updated variable.
    for (const char* op : {"increment", "decrement", "incrementBefore", "decrementBefore"}) for (uint8_t lanes : {1, 3}) {
        tn::abi::TslScopes scopes; g::Node out; uint64_t serial = 0;
        scopes.call("scope:open", nullptr, {}, out);
        const auto initial = TslArg::of(lanes == 1 ? g::float_(0.5) : g::vec3({g::float_(0.5)}));
        scopes.call("toVar", &initial, {}, out);
        const auto target = TslArg::of(out);
        CHECK(scopes.call(op, &target, {}, out));
        const auto returned = TslArg::of(out);
        scopes.call("scope:close", nullptr, {returned}, out);
        Program p(Stage::Compute); tsl::Build build(p);
        const auto value = g::lower(out, p);
        CHECK(value != kInvalid);
        if (value != kInvalid) CHECK(p.expr(value).type == (std::string(op).ends_with("Before") ? Type::vec(lanes) : Type::i32()));
        emitted(p, value, std::string(op).starts_with("increment") ? " + " : " - ");
    }
    for (uint8_t lanes : {1, 3}) {
        for (const char* op : {"difference", "stepElement", "mixElement", "smoothstepElement", "faceforward", "refract", "rand"}) {
            if ((std::string(op) == "faceforward" || std::string(op) == "refract" || std::string(op) == "rand") && lanes == 1) continue;
            uint64_t serial = 0;
            const auto a = TslArg::of(g::uniform("a", Type::vec(lanes)));
            std::vector<TslArg> args{a, a};
            const std::string name = op;
            if (name == "rand") args.resize(1);
            else if (name == "refract") args.push_back(TslArg::of(0.5));
            else if (name != "difference" && name != "stepElement") args.push_back(a);
            Program p(Stage::Compute); tsl::Build build(p);
            const auto graph = tn::abi::tslCall(op, nullptr, args, serial);
            CHECK(graph != nullptr);
            if (graph) emitted(p, g::lower(graph, p), name == "difference" ? "abs(" : name == "stepElement" ? "step(" : name == "mixElement" ? "mix(" : name == "smoothstepElement" ? "smoothstep(" : name == "faceforward" ? "faceForward(" : name == "rand" ? "fract(" : "refract(");
        }
        Program p(Stage::Compute);
        emitted(p, p.call("xor", {p.uniform("a", Type::vec(lanes)), p.constant(0.0f)}), " != ");
    }
    for (uint8_t n : {3, 4}) {
        uint64_t serial = 0;
        std::vector<TslArg> components;
        for (int i = 0; i < n * n; ++i) components.push_back(TslArg::of(double(i + 1)));
        for (const auto& args : {std::vector<TslArg>{}, components}) {
            const auto matrix = tn::abi::tslCall("mat" + std::to_string(n), nullptr, args, serial);
            Program p(Stage::Compute); tsl::Build build(p);
            emitted(p, g::lower(matrix, p), "mat" + std::to_string(n) + "x" + std::to_string(n));
        }
    }
    {
        Program p(Stage::Compute);
        const auto a = p.uniform("a", Type::vec(3)), scalar = p.constant(0.5f);
        emitted(p, p.call("faceForward", {a, scalar, scalar}), "faceForward(");
        emitted(p, p.call("refract", {a, scalar, a}), "refract(");
        emitted(p, p.call("difference", {a, scalar}), "abs(");
        emitted(p, p.call("mixElement", {a, scalar, scalar}), "mix(");
        emitted(p, p.call("pow", {a, scalar}), "pow(");
    }
    // Bad shapes fail by op at construction, rather than generating invalid WGSL.
    for (const char* op : {"inverse", "transpose", "determinant", "refract", "faceForward"}) {
        Program p(Stage::Compute);
        CHECK(p.call(op, {p.constant(0.5f)}) == kInvalid);
        CHECK(!p.diagnostics().empty());
        CHECK(p.diagnostics()[0].node == op);
    }

}
}
TN_TEST_MAIN({"math", math})
