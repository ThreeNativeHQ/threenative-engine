#include "check.h"
#include "engine/shader/ir.h"
#include "engine/abi/tsl_call.h"
#include "engine/shader/graph/serialized.h"
#include "engine/shader/tsl/tsl.h"
#include <cstdlib>
#include "engine/shader/wgsl.h"
#include "engine/scene/texture.h"
#include <memory>
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
// The TSL the spell port needs (PRD-777): Discard() and Discard(cond) in a fragment, a matrix uniform with live
// values, and textureLoad on an engine texture itself (three's textureLoad is texture(value).setSampler(false)).
std::string fragment(const g::Node& graph) {
    Program p(Stage::Fragment); tsl::Build build(p);
    const ExprId value = g::lower(graph, p);
    CHECK(value != kInvalid && p.ok());
    if (value == kInvalid || !p.ok()) {
        for (const auto& d : p.diagnostics()) std::fprintf(stderr, "%s %s: %s\n", d.code.c_str(), d.node.c_str(), d.reason.c_str());
        return {};
    }
    p.output("color", value);
    const auto wgsl = WgslEmitter::emit(p);
    CHECK(wgsl.ok());
    return wgsl.code;
}
void spell_port() {
    uint64_t serial = 0;
    for (const bool conditional : {false, true}) {
        tn::abi::TslScopes scopes;
        g::Node out;
        CHECK(scopes.call("scope:open", nullptr, {}, out));
        const auto alpha = g::uniform("alpha", Type::f32(), {0.5});
        std::vector<TslArg> args;
        if (conditional) args.push_back(TslArg::of(g::lessThan(alpha, g::float_(0.1))));
        bool known = false;
        try {
            known = scopes.call("Discard", nullptr, args, out);
        } catch (const std::exception& error) {
            std::fprintf(stderr, "Discard: %s\n", error.what());
        }
        CHECK(known);
        CHECK(scopes.call("scope:close", nullptr, {TslArg::of(g::vec4({alpha, alpha, alpha, alpha}))}, out));
        const auto code = fragment(out);
        CHECK(code.find("discard;") != std::string::npos);
        CHECK(!conditional || code.find("if (") != std::string::npos);
    }
    for (const int n : {3, 4}) {
        const auto made = tn::abi::tslCall("uniform", nullptr, {TslArg::of("mat" + std::to_string(n))}, serial);
        CHECK(made && made->type == Type::mat(n, n) && made->values.size() == size_t(n * n));
        if (!made) continue;
        std::vector<double> values(n * n);
        for (int i = 0; i < n * n; ++i) values[i] = i + 1;
        tn::abi::tslSetUniform(made, values.data(), values.size());
        CHECK(made->values == values);
        bool refused = false;
        try { tn::abi::tslSetUniform(made, values.data(), 3); } catch (const std::exception&) { refused = true; }
        CHECK(refused);
        const auto axis = n == 3 ? g::vec4({g::mul(made, g::vec3({g::float_(1), g::float_(0), g::float_(0)})), g::float_(1)})
                                 : g::mul(made, g::vec4({g::float_(1), g::float_(0), g::float_(0), g::float_(1)}));
        CHECK(fragment(axis).find(n == 3 ? "mat3x3<f32>" : "mat4x4<f32>") != std::string::npos);
    }
    {
        auto texture = std::make_shared<tn::engine::Texture>();
        texture->width = texture->height = 4;
        texture->data.assign(4 * 4 * 4, 255);
        g::Node loaded;
        try {
            loaded = tn::abi::tslCall("textureLoad", nullptr, {TslArg::objectOf("DataTexture", texture), TslArg::of(tn::abi::tslCall("ivec2", nullptr, {TslArg::of(1.0), TslArg::of(2.0)}, serial)), TslArg::of(g::int_(0))}, serial);
        } catch (const std::exception& error) {
            std::fprintf(stderr, "textureLoad: %s\n", error.what());
        }
        CHECK(loaded != nullptr);
        if (loaded) CHECK(fragment(loaded).find("textureLoad(") != std::string::npos);
    }
}
// A compute kernel that reads a texture only with textureLoad declares no sampler: the auto pipeline layout drops an
// unused one, and the bind group that still bound it lost the device (the particle sim's world texture, PRD-777).
void compute_texture_load() {
    for (const bool sampled : {false, true}) {
        Program c{Stage::Compute};
        const uint32_t world = c.texture2d("world");
        const ExprId at = c.construct(Type::vec(2, Type::Scalar::I32), {c.constant(int32_t(1)), c.constant(int32_t(2))});
        ExprId value = c.textureLoad(world, at, c.constant(int32_t(0)));
        if (sampled) value = c.add(value, c.sampleLevel(world, c.construct(Type::vec(2), {c.constant(0.5f), c.constant(0.5f)}), c.constant(0.0f)));
        c.load(c.var(Type::vec(4), value));
        const StageModule module = buildStage(c, 0);
        bool sampler = false;
        for (const Binding& b : module.bindings) sampler = sampler || b.kind == BindingKind::Sampler;
        std::fprintf(stderr, "compute texture (%s): sampler binding %d, smp_ in WGSL %d\n", sampled ? "sampled" : "loaded", sampler,
                     module.wgsl.code.find("smp_world") != std::string::npos);
        CHECK(sampler == sampled);
        CHECK((module.wgsl.code.find("smp_world") != std::string::npos) == sampled);
    }
}
// three's implicit integer conversions in a compute kernel (PRD-777): a JS number assigned into an int variable
// (AssignNode formats the value to the variable's type), and max/min/mod of an int with a whole JS number on
// either side, typed from the int operand as the binary operators are.
void compute_int_literals() {
    uint64_t serial = 0;
    tn::abi::TslScopes scopes;
    g::Node out, index, done;
    CHECK(scopes.call("scope:open", nullptr, {}, out));
    const TslArg zero = TslArg::of(g::int_(0));
    CHECK(scopes.call("toVar", &zero, {}, index));
    const TslArg variable = TslArg::of(index);
    std::string error;
    try {
        scopes.call("assign", &variable, {TslArg::of(3.0)}, done);
        const auto top = tn::abi::tslCall("max", &variable, {TslArg::of(2.0)}, serial);
        const auto rest = tn::abi::tslCall("mod", &variable, {TslArg::of(2.0)}, serial);
        const auto low = tn::abi::tslCall("min", nullptr, {TslArg::of(1.0), variable}, serial);
        const auto sum = g::add(g::add(top, rest), low);
        CHECK(scopes.call("scope:close", nullptr, {TslArg::of(g::float_(sum))}, out));
    } catch (const std::exception& thrown) {
        error = thrown.what();
    }
    CHECK(error.empty());
    if (!error.empty()) std::fprintf(stderr, "compute int literals: %s\n", error.c_str());
    Program p(Stage::Compute);
    tsl::Build build(p);
    const ExprId value = out ? g::lower(out, p) : kInvalid;
    for (const auto& d : p.diagnostics()) std::fprintf(stderr, "%s %s: %s\n", d.code.c_str(), d.node.c_str(), d.reason.c_str());
    CHECK(value != kInvalid && p.ok());
}
// ivec3 / ivec4 and bool() (PRD-777: the fluid port's voxel index and its flags), as ConvertType builds them.
void tsl_ivec_bool() {
    uint64_t serial = 0;
    const auto uniform = g::uniform("cell", Type::f32(), {2.5});
    std::string error;
    g::Node voxel, wide, flag;
    try {
        voxel = tn::abi::tslCall("ivec3", nullptr, {TslArg::of(1.0), TslArg::of(uniform), TslArg::of(g::int_(3))}, serial);
        wide = tn::abi::tslCall("ivec4", nullptr, {TslArg::of(uniform)}, serial);
        flag = tn::abi::tslCall("bool", nullptr, {TslArg::of(uniform)}, serial);
    } catch (const std::exception& thrown) {
        error = thrown.what();
    }
    if (!error.empty()) std::fprintf(stderr, "ivec3/bool: %s\n", error.c_str());
    CHECK(error.empty());
    CHECK(voxel && wide && flag);
    if (!voxel || !wide || !flag) return;
    CHECK(voxel->type == Type::vec(3, Type::Scalar::I32) && wide->type == Type::vec(4, Type::Scalar::I32));
    const auto sum = g::add(g::float_(g::swizzle(voxel, "z")), g::float_(g::swizzle(wide, "w")));
    const auto code = fragment(g::vec4({g::select(flag, sum, g::float_(0)), g::float_(0), g::float_(0), g::float_(1)}));
    CHECK(code.find("vec3<i32>") != std::string::npos && code.find("vec4<i32>") != std::string::npos);
}
// three's mat3(mat4) is the upper-left 3x3 (Matrix3.setFromMatrix4); transformNormal and the impostor surface build
// it from instanceMatrix. WGSL has no mat3x3(mat4x4), so the lowered columns are (m * e_c).xyz (PRD-858).
void tsl_mat3_of_mat4() {
    uint64_t serial = 0;
    const auto m = TslArg::of(g::uniform("m", Type::mat(4, 4)));
    const auto graph = tn::abi::tslCall("mat3", nullptr, {m}, serial);
    CHECK(graph != nullptr);
    if (!graph) return;
    Program p(Stage::Compute); tsl::Build build(p);
    const ExprId value = g::lower(graph, p);
    CHECK(value != kInvalid && p.expr(value).type == Type::mat(3, 3));
    emitted(p, value, "mat3x3<f32>(");
}
}  // namespace

TN_TEST_MAIN({"math", math}, {"tsl_mat3_of_mat4", tsl_mat3_of_mat4}, {"spell_port", spell_port}, {"compute_texture_load", compute_texture_load},
             {"compute_int_literals", compute_int_literals}, {"tsl_ivec_bool", tsl_ivec_bool})
