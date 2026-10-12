#include <atomic>
#include "wgsl.h"
#include "materialx_noise.h"

#include <bit>
#include <charconv>
#include <cmath>
#include <set>

namespace tn::engine::shader {

namespace {

struct BuiltinName {
    const char* ir;
    const char* wgsl;
};

constexpr BuiltinName kBuiltinNames[] = {
    {"vertexIndex", "vertex_index"},     {"instanceIndex", "instance_index"},
    {"position", "position"},            {"frontFacing", "front_facing"},
    {"globalInvocationId", "global_invocation_id"}, {"localInvocationIndex", "local_invocation_index"},
};

const char* wgslBuiltin(const std::string& ir) {
    for (const BuiltinName& b : kBuiltinNames) {
        if (ir == b.ir) return b.wgsl;
    }
    return nullptr;
}

// r185's mod (WGSLNodeBuilder.js mod_float, mod_vec2..4): WGSL's % truncates, so the floored form is a helper.
constexpr const char* kTslMod =
    "fn tsl_mod_float(x : f32, y : f32) -> f32 { return x - y * floor(x / y); }\n"
    "fn tsl_mod_vec2(x : vec2<f32>, y : vec2<f32>) -> vec2<f32> { return x - y * floor(x / y); }\n"
    "fn tsl_mod_vec3(x : vec3<f32>, y : vec3<f32>) -> vec3<f32> { return x - y * floor(x / y); }\n"
    "fn tsl_mod_vec4(x : vec4<f32>, y : vec4<f32>) -> vec4<f32> { return x - y * floor(x / y); }\n";

const char* binaryOperator(Op op) {
    switch (op) {
        case Op::Add: return " + ";
        case Op::Sub: return " - ";
        case Op::Mul: return " * ";
        case Op::Div: return " / ";
        case Op::ShiftRight: return " >> ";
        case Op::BitXor: return " ^ ";
        case Op::Less: return " < ";
        case Op::Equal: return " == ";
        default: return nullptr;
    }
}

}  // namespace

std::string WgslEmitter::type(const Type& t) const {
    const char* scalar = t.scalar == Type::Scalar::F32   ? "f32"
                         : t.scalar == Type::Scalar::I32 ? "i32"
                         : t.scalar == Type::Scalar::U32 ? "u32"
                         : t.scalar == Type::Scalar::Bool ? "bool"
                                                          : "void";
    if (t.isScalar()) return scalar;
    if (t.isVector()) return "vec" + std::to_string(t.rows) + "<" + scalar + ">";
    return "mat" + std::to_string(t.cols) + "x" + std::to_string(t.rows) + "<" + scalar + ">";
}

WgslEmitter::WgslEmitter(const Program& program)
    : p_(program), uses_(program.exprs_.size()), bound_(program.exprs_.size()) {
    // Counted from the statements down, so an expression a dead branch alone shares stays inline.
    std::vector<bool> seen(program.exprs_.size());
    const auto visit = [&](auto& self, ExprId id) -> void {
        ++uses_[id];
        if (seen[id]) return;
        seen[id] = true;
        const Expr& e = program.exprs_[id];
        for (uint8_t i = 0; i < e.argc; ++i) self(self, e.args[i]);
    };
    using Kind = Program::StmtKind;
    for (const auto& b : program.blocks_) {
        for (const auto& s : b) {
            if (s.kind == Kind::Eval || s.kind == Kind::Assign || s.kind == Kind::Output) visit(visit, s.b);
            else if (s.kind == Kind::Store) visit(visit, s.b), visit(visit, s.c);
            else if (s.kind == Kind::If || s.kind == Kind::Loop) visit(visit, s.a);
        }
    }
}

std::string WgslEmitter::expr(ExprId id) const {
    if (bound_[id]) return "e" + std::to_string(id);
    std::string text = inlined(id);
    switch (p_.exprs_[id].op) {
        case Op::Constant: case Op::Uniform: case Op::Attribute: case Op::Builtin: case Op::Varying:
        case Op::LoadVar: case Op::LoadStorage: case Op::AtomicAdd: return text;  // already a name
        default: break;
    }
    if (uses_[id] < 2 || out_ == nullptr) return text;
    *out_ += std::string(static_cast<size_t>(depth_) * 2, ' ') + "let e" + std::to_string(id) + " = " + text + ";\n";
    bound_[id] = true;
    boundStack_.push_back(id);
    return "e" + std::to_string(id);
}

std::string WgslEmitter::inlined(ExprId id) const {
    const Expr& e = p_.exprs_[id];
    switch (e.op) {
        case Op::Constant: {
            if (e.type == Type::boolean()) return e.immediate ? "true" : "false";
            if (e.type == Type::i32()) return std::to_string(static_cast<int32_t>(e.immediate)) + "i";
            if (e.type == Type::u32()) return std::to_string(static_cast<uint32_t>(e.immediate)) + "u";
            const float value = std::bit_cast<float>(static_cast<uint32_t>(e.immediate));
            if (!std::isfinite(value)) {
                errors_.push_back("TN_SHADER_PACKAGE_INVALID: constant e" + std::to_string(id) + " is not finite");
                return "0f";
            }
            char buffer[32];
            const auto end = std::to_chars(buffer, buffer + sizeof buffer, value).ptr;  // shortest round trip
            return std::string(buffer, end) + "f";
        }
        case Op::Uniform: return "u.f_" + p_.names_[e.immediate];
        case Op::Attribute: return "a_" + p_.names_[e.immediate];
        case Op::Builtin: return "b_" + p_.names_[e.immediate];
        case Op::Varying: return "i_" + p_.names_[e.immediate];
        case Op::LoadVar:
        case Op::LoadStorage:
        case Op::AtomicAdd: return "l" + std::to_string(id);
        case Op::TextureSize:
            return "textureDimensions(t_" + p_.textures_[e.immediate] + ", " + expr(e.args[0]) + ")";
        case Op::TextureLoad:
            return "textureLoad(t_" + p_.textures_[e.immediate] + ", " + expr(e.args[0]) + ", " + expr(e.args[1]) + ")";
        case Op::SampleLevel: {
            const std::string& name = p_.textures_[e.immediate];
            return "textureSampleLevel(t_" + name + ", smp_" + name + ", " + expr(e.args[0]) + ", " + expr(e.args[1]) + ")";
        }
        case Op::Sample: {
            if (e.argc == 2 && e.type == Type::vec(4)) {  // three's gather().compare(), a whole-texel offset
                const std::string& gathered = p_.textures_[gatherTexture(e.immediate)];
                return "textureGatherCompare(t_" + gathered + ", smp_" + gathered + ", " + expr(e.args[0]) + ", " +
                       expr(e.args[1]) + ", vec2<i32>(" + std::to_string(gatherOffsetX(e.immediate)) + ", " +
                       std::to_string(gatherOffsetY(e.immediate)) + "))";
            }
            const std::string& name = p_.textures_[e.immediate];
            if (e.argc == 2)  // three's generateTextureCompare
                return (p_.stage_ == Stage::Fragment ? "textureSampleCompare(t_" : "textureSampleCompareLevel(t_") + name +
                       ", smp_" + name + ", " + expr(e.args[0]) + ", " + expr(e.args[1]) + ")";
            return p_.stage_ == Stage::Fragment
                       ? "textureSample(t_" + name + ", smp_" + name + ", " + expr(e.args[0]) + ")"
                       : "textureSampleLevel(t_" + name + ", smp_" + name + ", " + expr(e.args[0]) + ", 0.0)";
        }
        case Op::Neg: return "(-" + expr(e.args[0]) + ")";
        case Op::Select:
            return "select(" + expr(e.args[2]) + ", " + expr(e.args[1]) + ", " + expr(e.args[0]) + ")";
        case Op::Swizzle: {
            std::string lanes;
            const unsigned n = static_cast<unsigned>(e.immediate >> 8);
            for (unsigned i = 0; i < n; ++i) lanes += "xyzw"[(e.immediate >> (i * 2)) & 3];
            return "(" + expr(e.args[0]) + ")." + lanes;
        }
        case Op::Construct:
        case Op::Call: {
            if (e.op == Op::Call) {
                const std::string& fn = p_.names_[e.immediate];
                if (fn == "greaterEqual") return "(" + expr(e.args[0]) + " >= " + expr(e.args[1]) + ")";
                if (fn == "lessEqual") return "(" + expr(e.args[0]) + " <= " + expr(e.args[1]) + ")";
            }
            std::string out = e.op == Op::Call ? p_.names_[e.immediate] : type(e.type);
            if (out == "dFdx") out = "dpdx";
            if (out == "mod") out = "tsl_mod_" + (e.type.isVector() ? "vec" + std::to_string(e.type.rows) : std::string("float"));
            // WGSL's dpdy grows downward the framebuffer; three emits `- dpdy` so dFdy grows upward.
            if (out == "dFdy") out = "-dpdy";
            // TSL lets clamp and smoothstep take scalar bounds on a vector; WGSL has no such overload.
            const bool splat = e.op == Op::Call && e.type.isVector() &&
                               (p_.names_[e.immediate] == "clamp" || p_.names_[e.immediate] == "smoothstep");
            out += "(";
            for (uint8_t i = 0; i < e.argc; ++i) {
                if (i) out += ", ";
                const bool scalar = p_.exprs_[e.args[i]].type.isScalar();
                out += splat && scalar ? type(e.type) + "(" + expr(e.args[i]) + ")" : expr(e.args[i]);
            }
            return out + ")";
        }
        default: break;
    }
    if (const char* op = binaryOperator(e.op)) return "(" + expr(e.args[0]) + op + expr(e.args[1]) + ")";
    errors_.push_back("TN_SHADER_PACKAGE_INVALID: no WGSL for expression e" + std::to_string(id));
    return "0";
}

void WgslEmitter::block(uint32_t index, int depth, std::string& out) const {
    const std::string indent(static_cast<size_t>(depth) * 2, ' ');
    using Kind = Program::StmtKind;
    // A shared value's `let` is appended to `out` while its statement's text is built, so it lands
    // before that statement; it goes out of scope with this block.
    const size_t scope = boundStack_.size();
    for (const Program::Stmt& s : p_.blocks_[index]) {
        out_ = &out;
        depth_ = depth;
        switch (s.kind) {
            case Kind::Eval: {
                const Expr& e = p_.exprs_[s.b];
                if (e.op == Op::LoadVar) {
                    out += indent + "let l" + std::to_string(s.b) + " = v" + std::to_string(e.immediate) + ";\n";
                } else if (e.op == Op::LoadStorage) {
                    const auto& storage = p_.storage_[e.immediate];
                    const std::string at = "s_" + storage.name + "[" + expr(e.args[0]) + "]";
                    out += indent + "let l" + std::to_string(s.b) + " = " +
                           (storage.atomic ? "atomicLoad(&" + at + ")" : at) + ";\n";
                } else if (e.op == Op::AtomicAdd) {
                    out += indent + "let l" + std::to_string(s.b) + " = atomicAdd(&s_" + p_.storage_[e.immediate].name +
                           "[" + expr(e.args[0]) + "], " + expr(e.args[1]) + ");\n";
                }
                break;
            }
            case Kind::Assign:
                out += indent + "v" + std::to_string(s.a) + " = " + expr(s.b) + ";\n";
                break;
            case Kind::Store:
                if (p_.storage_[s.a].atomic)
                    out += indent + "atomicStore(&s_" + p_.storage_[s.a].name + "[" + expr(s.b) + "], " + expr(s.c) + ");\n";
                else
                    out += indent + "s_" + p_.storage_[s.a].name + "[" + expr(s.b) + "] = " + expr(s.c) + ";\n";
                break;
            case Kind::Discard: out += indent + "discard;\n"; break;
            case Kind::Break: out += indent + "break;\n"; break;
            case Kind::Continue: out += indent + "continue;\n"; break;
            case Kind::Output: {
                const std::string& name = p_.names_[p_.outputs_[s.a].name];
                out += indent + "out." + (name == "position" || name == "color" ? name : "o_" + name) + " = " +
                       expr(s.b) + ";\n";
                break;
            }
            case Kind::If:
                out += indent + "if (" + expr(s.a) + ") {\n";
                block(s.body, depth + 1, out);
                if (s.otherwise) {
                    out += indent + "} else {\n";
                    block(s.otherwise, depth + 1, out);
                }
                out += indent + "}\n";
                break;
            case Kind::Loop: {
                const std::string v = "v" + std::to_string(s.b);
                out += indent + "for (var " + v + ": i32 = 0i; " + v + " < " + expr(s.a) + "; " + v + " = " + v +
                       " + 1i) {\n";
                block(s.body, depth + 1, out);
                out += indent + "}\n";
                break;
            }
        }
    }
    for (size_t i = scope; i < boundStack_.size(); ++i) bound_[boundStack_[i]] = false;
    boundStack_.resize(scope);
}

WgslModule WgslEmitter::emit(const Program& program, uint32_t group) {
    WgslEmitter e(program);
    WgslModule module;
    if (!program.ok()) {
        module.errors.push_back("TN_SHADER_PACKAGE_INVALID: the program has construction diagnostics");
        return module;
    }
    static std::atomic<uint64_t> nextId{1};
    module.id = nextId.fetch_add(1, std::memory_order_relaxed);
    std::string& out = module.code;
    // WGSLNodeBuilder's header outside Firefox: a texture sampled inside a branch (a TSL If, as core's
    // WaterSurface3D refraction is) is legal, as it is in three's shaders.
    if (program.stage() == Stage::Fragment) out += "diagnostic(off, derivative_uniformity);\n";

    // Resources in first-use order: uniforms in one block at binding 0, then storage buffers.
    std::vector<ExprId> uniforms, attributes, builtins, varyings;
    for (ExprId id = 1; id < program.exprs_.size(); ++id) {
        const Op op = program.exprs_[id].op;
        if (op == Op::Uniform) uniforms.push_back(id);
        else if (op == Op::Attribute) attributes.push_back(id);
        else if (op == Op::Builtin) builtins.push_back(id);
        else if (op == Op::Varying) varyings.push_back(id);
    }
    uint32_t binding = 0;
    if (!uniforms.empty()) {
        out += "struct Uniforms {\n";
        for (ExprId id : uniforms) {
            out += "  f_" + program.names_[program.exprs_[id].immediate] + ": " + e.type(program.exprs_[id].type) + ",\n";
        }
        out += "}\n@group(" + std::to_string(group) + ") @binding(" + std::to_string(binding++) +
               ") var<uniform> u: Uniforms;\n";
    }
    // A buffer the program never stores to is read-only, which is also the only storage a vertex
    // stage may declare.
    std::set<uint32_t> written;
    for (const auto& b : program.blocks_) {
        for (const auto& s : b) {
            if (s.kind == Program::StmtKind::Store) written.insert(s.a);
        }
    }
    for (uint32_t i = 0; i < program.storage_.size(); ++i) {
        const auto& storage = program.storage_[i];
        out += "@group(" + std::to_string(group) + ") @binding(" + std::to_string(binding++) + ") var<storage, " +
               (written.count(i) || storage.atomic ? "read_write" : "read") + "> s_" + storage.name + ": array<" +
               (storage.atomic ? "atomic<" + e.type(storage.element) + ">" : e.type(storage.element)) + ">;\n";
    }

    for (std::size_t i = 0; i < program.textures_.size(); ++i) {
        const std::string& name = program.textures_[i];
        const auto kind = program.textureKinds_[i];
        const bool depth = kind == Program::TextureKind::Depth2d || kind == Program::TextureKind::DepthCube;
        out += "@group(" + std::to_string(group) + ") @binding(" + std::to_string(binding++) + ") var t_" + name +
               (kind == Program::TextureKind::DepthCube ? ": texture_depth_cube;\n"
                : kind == Program::TextureKind::Float3d ? ": texture_3d<f32>;\n"
                : kind == Program::TextureKind::FloatCube ? ": texture_cube<f32>;\n"
                : depth                                 ? ": texture_depth_2d;\n"
                                                        : ": texture_2d<f32>;\n");
        out += "@group(" + std::to_string(group) + ") @binding(" + std::to_string(binding++) + ") var smp_" + name +
               (depth ? ": sampler_comparison;\n" : ": sampler;\n");
    }

    const Stage stage = program.stage_;
    const bool hasOutputs = stage != Stage::Compute;
    if (hasOutputs) {
        out += "struct Out {\n";
        uint32_t location = 0;
        for (const auto& slot : program.outputs_) {
            const std::string& name = program.names_[slot.name];
            // @invariant only when asked (Program::setInvariantPosition): see there.
            if (name == "position") out += std::string("  ") + (program.invariantPosition_ ? "@invariant " : "") + "@builtin(position) position: vec4<f32>,\n";
            else if (name == "color") out += "  @location(0) color: vec4<f32>,\n";
            else out += "  @location(" + std::to_string(location++) + ") o_" + name + ": " + e.type(slot.type) + ",\n";
        }
        if (program.outputs_.empty()) {
            module.errors.push_back("TN_SHADER_PACKAGE_INVALID: a render stage writes no output");
        }
        out += "}\n";
    }

    // A call into the MaterialX noise library brings the library, once.
    for (ExprId id = 1; id < program.exprs_.size(); ++id) {
        const Expr& x = program.exprs_[id];
        if (x.op == Op::Call && program.names_[x.immediate].rfind("mx_", 0) == 0) {
            out += kMaterialXNoise;
            break;
        }
    }
    // A call to mod brings its floored helpers, once.
    for (ExprId id = 1; id < program.exprs_.size(); ++id) {
        const Expr& x = program.exprs_[id];
        if (x.op == Op::Call && program.names_[x.immediate] == "mod") {
            out += kTslMod;
            break;
        }
    }
    out += stage == Stage::Compute ? "@compute @workgroup_size(64)\n" : stage == Stage::Vertex ? "@vertex\n" : "@fragment\n";
    out += "fn main(";
    bool first = true;
    uint32_t location = 0;
    for (ExprId id : attributes) {
        out += std::string(first ? "" : ", ") + "@location(" + std::to_string(location++) + ") a_" +
               program.names_[program.exprs_[id].immediate] + ": " + e.type(program.exprs_[id].type);
        first = false;
    }
    // ponytail: varyings take locations in first-use order, which matches a vertex stage that
    // outputs them in the same order; a package-level link step replaces this when stages differ.
    for (ExprId id : varyings) {
        out += std::string(first ? "" : ", ") + "@location(" + std::to_string(location++) + ") i_" +
               program.names_[program.exprs_[id].immediate] + ": " + e.type(program.exprs_[id].type);
        first = false;
    }
    for (ExprId id : builtins) {
        const std::string& name = program.names_[program.exprs_[id].immediate];
        out += std::string(first ? "" : ", ") + "@builtin(" + wgslBuiltin(name) + ") b_" + name + ": " +
               e.type(program.exprs_[id].type);
        first = false;
    }
    out += hasOutputs ? ") -> Out {\n" : ") {\n";
    if (hasOutputs) out += "  var out: Out;\n";

    // Loop counters are declared by their for statement; every other variable at the top.
    std::set<uint32_t> loopVars;
    for (const auto& b : program.blocks_) {
        for (const auto& s : b) {
            if (s.kind == Program::StmtKind::Loop) loopVars.insert(s.b);
        }
    }
    for (uint32_t v = 0; v < program.vars_.size(); ++v) {
        if (!loopVars.count(v)) out += "  var v" + std::to_string(v) + ": " + e.type(program.vars_[v].type) + ";\n";
    }
    e.block(0, 1, out);
    if (hasOutputs) out += "  return out;\n";
    out += "}\n";
    module.errors.insert(module.errors.end(), e.errors_.begin(), e.errors_.end());
    return module;
}

}  // namespace tn::engine::shader
