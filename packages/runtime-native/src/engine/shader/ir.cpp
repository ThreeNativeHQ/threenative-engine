#include "ir.h"

#include <bit>
#include <cstdio>
#include <algorithm>

namespace tn::engine::shader {

namespace {

const char* scalarName(Type::Scalar s) {
    switch (s) {
        case Type::Scalar::Void: return "void";
        case Type::Scalar::Bool: return "bool";
        case Type::Scalar::I32: return "i32";
        case Type::Scalar::U32: return "u32";
        case Type::Scalar::F32: return "f32";
    }
    return "?";
}

struct BuiltinInfo {
    const char* name;
    Type type;
    uint8_t stages;  // bit per Stage
};

constexpr uint8_t bit(Stage s) { return static_cast<uint8_t>(1u << static_cast<unsigned>(s)); }

const BuiltinInfo kBuiltins[] = {
    {"vertexIndex", Type::u32(), bit(Stage::Vertex)},
    {"instanceIndex", Type::u32(), bit(Stage::Vertex)},
    {"position", Type::vec(4), bit(Stage::Fragment)},
    {"frontFacing", Type::boolean(), bit(Stage::Fragment)},
    {"globalInvocationId", Type::vec(3, Type::Scalar::U32), bit(Stage::Compute)},
    {"localInvocationIndex", Type::u32(), bit(Stage::Compute)},
};

const char* opName(Op op) {
    switch (op) {
        case Op::Add: return "add";
        case Op::Sub: return "sub";
        case Op::Mul: return "mul";
        case Op::Div: return "div";
        case Op::Neg: return "neg";
        case Op::Less: return "less";
        case Op::Equal: return "equal";
        case Op::Select: return "select";
        case Op::Construct: return "construct";
        case Op::ShiftRight: return "shiftRight";
        case Op::BitXor: return "bitXor";
        default: return "?";
    }
}

}  // namespace

std::string Type::name() const {
    if (isScalar() || scalar == Scalar::Void) return scalarName(scalar);
    if (isVector()) return "vec" + std::to_string(rows) + "<" + scalarName(scalar) + ">";
    return "mat" + std::to_string(cols) + "x" + std::to_string(rows) + "<" + scalarName(scalar) + ">";
}

Program::Program(Stage stage) : stage_(stage) {
    exprs_.push_back(Expr{Op::Constant, Type{}});  // id 0 is kInvalid
    blocks_.emplace_back();                          // block 0 is the entry block
}

ExprId Program::fail(std::string_view node, std::string reason, const Where& where) {
    diagnostics_.push_back(Diagnostic{"TN_TSL_TYPE", std::string(node), std::move(reason), where.file_name(), where.line()});
    return kInvalid;
}

uint64_t Program::intern(std::string_view name) {
    const auto [it, inserted] = nameIndex_.emplace(std::string(name), names_.size());
    if (inserted) names_.emplace_back(name);
    return it->second;
}

ExprId Program::pure(Expr expr) {
    std::string key;
    key.reserve(48);
    key += static_cast<char>(expr.op);
    key += static_cast<char>(expr.type.scalar);
    key += static_cast<char>(expr.type.rows);
    key += static_cast<char>(expr.type.cols);
    key.append(reinterpret_cast<const char*>(expr.args.data()), sizeof(ExprId) * expr.argc);
    key.append(reinterpret_cast<const char*>(&expr.immediate), sizeof(expr.immediate));
    const auto found = pureIndex_.find(key);
    if (found != pureIndex_.end()) return found->second;
    const auto id = static_cast<ExprId>(exprs_.size());
    exprs_.push_back(expr);
    pureIndex_.emplace(std::move(key), id);
    return id;
}

ExprId Program::ordered(Expr expr) {
    const auto id = static_cast<ExprId>(exprs_.size());
    exprs_.push_back(expr);
    emit(Stmt{StmtKind::Eval, 0, id});
    return id;
}

ExprId Program::constant(float value, Where) {
    return pure(Expr{Op::Constant, Type::f32(), {}, 0, std::bit_cast<uint32_t>(value)});
}
ExprId Program::constant(int32_t value, Where) {
    return pure(Expr{Op::Constant, Type::i32(), {}, 0, static_cast<uint32_t>(value)});
}
ExprId Program::constant(bool value, Where) {
    return pure(Expr{Op::Constant, Type::boolean(), {}, 0, value ? 1u : 0u});
}
ExprId Program::uniform(std::string_view name, Type type, Where) {
    return pure(Expr{Op::Uniform, type, {}, 0, intern(name)});
}
ExprId Program::attribute(std::string_view name, Type type, Where where) {
    if (stage_ != Stage::Vertex) return fail("attribute", "vertex attributes exist only in the vertex stage", where);
    return pure(Expr{Op::Attribute, type, {}, 0, intern(name)});
}

ExprId Program::varying(std::string_view name, Type type, Where where) {
    if (stage_ != Stage::Fragment) return fail("varying", "varyings are fragment inputs", where);
    return pure(Expr{Op::Varying, type, {}, 0, intern(name)});
}

ExprId Program::builtin(std::string_view name, Where where) {
    for (const BuiltinInfo& info : kBuiltins) {
        if (name != info.name) continue;
        if ((info.stages & bit(stage_)) == 0) {
            return fail(std::string("builtin ") + info.name, "not available in this stage", where);
        }
        return pure(Expr{Op::Builtin, info.type, {}, 0, intern(name)});
    }
    diagnostics_.push_back(Diagnostic{"TN_TSL_UNSUPPORTED", std::string(name), "uncatalogued builtin",
                                      where.file_name(), where.line()});
    return kInvalid;
}

ExprId Program::arithmetic(Op op, std::string_view node, ExprId a, ExprId b, const Where& where) {
    if (a == kInvalid || b == kInvalid) return kInvalid;
    const Type ta = exprs_[a].type;
    const Type tb = exprs_[b].type;
    if (!ta.numeric() || !tb.numeric()) {
        return fail(node, "operands " + ta.name() + " and " + tb.name() + " are not numeric", where);
    }
    Type result{};
    if (ta == tb) {
        result = ta;
    } else if (ta.scalar == tb.scalar && ta.isScalar() && tb.isVector()) {
        result = tb;
    } else if (ta.scalar == tb.scalar && ta.isVector() && tb.isScalar()) {
        result = ta;
    } else if (op == Op::Mul && ta.isMatrix() && tb.isVector() && ta.cols == tb.rows) {
        result = Type::vec(ta.rows);
    } else if (op == Op::Mul && ta.isVector() && tb.isMatrix() && ta.rows == tb.rows) {
        result = Type::vec(tb.cols);  // a row vector times a matrix: TSL's vec.mul(mat), WGSL's v * M
    } else if (op == Op::Mul && ta.isMatrix() && tb.isMatrix() && ta.cols == tb.rows) {
        result = Type::mat(tb.cols, ta.rows);
    } else if (op == Op::Mul && ta.isMatrix() && tb == Type::f32()) {
        result = ta;  // WGSL's mat * f32: skinning weighs a bone matrix
    } else if (op == Op::Mul && ta == Type::f32() && tb.isMatrix()) {
        result = tb;
    } else {
        return fail(node, "operands " + ta.name() + " and " + tb.name() + " do not combine", where);
    }
    if (ta == tb && ta.isMatrix() && op != Op::Add && op != Op::Sub && op != Op::Mul) {
        return fail(node, "matrices only add, subtract and multiply", where);
    }
    Expr e{op, result, {a, b}, 2};
    return pure(e);
}

ExprId Program::add(ExprId a, ExprId b, Where where) { return arithmetic(Op::Add, "add", a, b, where); }
ExprId Program::sub(ExprId a, ExprId b, Where where) { return arithmetic(Op::Sub, "sub", a, b, where); }
ExprId Program::mul(ExprId a, ExprId b, Where where) { return arithmetic(Op::Mul, "mul", a, b, where); }
ExprId Program::div(ExprId a, ExprId b, Where where) { return arithmetic(Op::Div, "div", a, b, where); }

// Both operands are one integer type, as WGSL's >> and ^ require.
ExprId Program::shiftRight(ExprId a, ExprId b, Where where) {
    if (a == kInvalid || b == kInvalid) return kInvalid;
    const Type ta = exprs_[a].type;
    const Type tb = exprs_[b].type;
    const auto integral = [](Type t) { return (t.scalar == Type::Scalar::U32 || t.scalar == Type::Scalar::I32) && !t.isMatrix(); };
    if (!integral(ta) || ta != tb) return fail("shiftRight", "operands " + ta.name() + " and " + tb.name() + " are not one integer type", where);
    return pure(Expr{Op::ShiftRight, ta, {a, b}, 2});
}

ExprId Program::bitXor(ExprId a, ExprId b, Where where) {
    if (a == kInvalid || b == kInvalid) return kInvalid;
    const Type ta = exprs_[a].type;
    const Type tb = exprs_[b].type;
    const auto integral = [](Type t) { return (t.scalar == Type::Scalar::U32 || t.scalar == Type::Scalar::I32) && !t.isMatrix(); };
    if (!integral(ta) || ta != tb) return fail("bitXor", "operands " + ta.name() + " and " + tb.name() + " are not one integer type", where);
    return pure(Expr{Op::BitXor, ta, {a, b}, 2});
}

ExprId Program::neg(ExprId a, Where where) {
    if (a == kInvalid) return kInvalid;
    const Type t = exprs_[a].type;
    if (!t.numeric() || t.scalar == Type::Scalar::U32) return fail("neg", t.name() + " has no negation", where);
    return pure(Expr{Op::Neg, t, {a}, 1});
}

ExprId Program::less(ExprId a, ExprId b, Where where) {
    if (a == kInvalid || b == kInvalid) return kInvalid;
    const Type ta = exprs_[a].type;
    const Type tb = exprs_[b].type;
    if (ta != tb || !ta.numeric() || ta.isMatrix()) {
        return fail("less", "operands " + ta.name() + " and " + tb.name() + " do not compare", where);
    }
    return pure(Expr{Op::Less, Type::vec(ta.rows, Type::Scalar::Bool), {a, b}, 2});
}

ExprId Program::equal(ExprId a, ExprId b, Where where) {
    if (a == kInvalid || b == kInvalid) return kInvalid;
    const Type ta = exprs_[a].type;
    const Type tb = exprs_[b].type;
    if (ta != tb || ta.isMatrix()) {
        return fail("equal", "operands " + ta.name() + " and " + tb.name() + " do not compare", where);
    }
    return pure(Expr{Op::Equal, Type::vec(ta.rows, Type::Scalar::Bool), {a, b}, 2});
}

ExprId Program::select(ExprId condition, ExprId whenTrue, ExprId whenFalse, Where where) {
    if (condition == kInvalid || whenTrue == kInvalid || whenFalse == kInvalid) return kInvalid;
    if (exprs_[condition].type != Type::boolean()) {
        return fail("select", "condition is " + exprs_[condition].type.name() + ", not bool", where);
    }
    if (exprs_[whenTrue].type != exprs_[whenFalse].type) {
        return fail("select", "branches are " + exprs_[whenTrue].type.name() + " and " +
                                  exprs_[whenFalse].type.name(), where);
    }
    return pure(Expr{Op::Select, exprs_[whenTrue].type, {condition, whenTrue, whenFalse}, 3});
}

ExprId Program::swizzle(ExprId value, std::string_view lanes, Where where) {
    if (value == kInvalid) return kInvalid;
    const Type t = exprs_[value].type;
    if (t.isMatrix() || t.scalar == Type::Scalar::Void) return fail("swizzle", t.name() + " has no lanes", where);
    if (lanes.empty() || lanes.size() > 4) return fail("swizzle", "takes 1 to 4 lanes", where);
    const std::string_view xyzw = "xyzw";
    const std::string_view rgba = "rgba";
    const std::string_view set = xyzw.find(lanes[0]) != std::string_view::npos ? xyzw : rgba;
    uint64_t encoded = 0;
    for (size_t i = 0; i < lanes.size(); ++i) {
        const size_t lane = set.find(lanes[i]);
        if (lane == std::string_view::npos) return fail("swizzle ." + std::string(lanes), "mixes or misnames lanes", where);
        if (lane >= t.rows) {
            return fail("swizzle ." + std::string(lanes), "lane " + std::string(1, lanes[i]) + " is past " + t.name(), where);
        }
        encoded |= static_cast<uint64_t>(lane) << (i * 2);
    }
    encoded |= static_cast<uint64_t>(lanes.size()) << 8;
    const auto n = static_cast<uint8_t>(lanes.size());
    return pure(Expr{Op::Swizzle, n == 1 ? Type{t.scalar, 1, 1} : Type::vec(n, t.scalar), {value}, 1, encoded});
}

ExprId Program::construct(Type type, const std::vector<ExprId>& parts, Where where) {
    if (parts.empty() || parts.size() > 4) return fail("construct " + type.name(), "takes 1 to 4 parts", where);
    unsigned components = 0;
    Expr e{Op::Construct, type, {}, static_cast<uint8_t>(parts.size())};
    for (size_t i = 0; i < parts.size(); ++i) {
        if (parts[i] == kInvalid) return kInvalid;
        const Type part = exprs_[parts[i]].type;
        // One numeric part of the same shape converts, as WGSL's u32(x) and vec3<f32>(v) do.
        const auto numeric = [](Type t) { return t.scalar != Type::Scalar::Bool && !t.isMatrix(); };
        const bool conversion = parts.size() == 1 && numeric(part) && numeric(type) && part.rows == type.rows;
        if ((part.scalar != type.scalar && !conversion) || part.isMatrix()) {
            return fail("construct " + type.name(), "part " + std::to_string(i) + " is " + part.name(), where);
        }
        components += part.rows;
        e.args[i] = parts[i];
    }
    const unsigned want = static_cast<unsigned>(type.rows) * type.cols;
    // A single scalar splats, as vec3(1.0) does.
    if (components != want && !(parts.size() == 1 && components == 1)) {
        return fail("construct " + type.name(), std::to_string(components) + " components for " + std::to_string(want), where);
    }
    return pure(e);
}

ExprId Program::call(std::string_view function, const std::vector<ExprId>& args, Where where) {
    for (ExprId a : args) {
        if (a == kInvalid) return kInvalid;
    }
    auto type = [&](size_t i) { return exprs_[args[i]].type; };
    auto floating = [&](size_t i) { return type(i).scalar == Type::Scalar::F32 && !type(i).isMatrix(); };
    Type result{};
    std::string error;
    const std::string_view unary[] = {"abs", "sin", "cos", "asin", "floor", "fract", "sqrt", "exp", "exp2", "log2", "normalize", "dFdx", "dFdy", "sign", "atan", "fwidth"};
    const std::string_view binary[] = {"min", "max", "pow", "step", "atan2", "mod"};
    bool known = false;
    for (std::string_view name : unary) {
        if (function != name) continue;
        known = true;
        if (args.size() != 1 || !floating(0)) error = "takes one floating value";
        else result = type(0);
    }
    for (std::string_view name : binary) {
        if (function != name) continue;
        known = true;
        if (args.size() != 2 || !floating(0) || type(0) != type(1)) error = "takes two floating values of one type";
        else result = type(0);
    }
    if (function == "dot" || function == "distance") {
        known = true;
        if (args.size() != 2 || !floating(0) || !type(0).isVector() || type(0) != type(1)) error = "takes two equal float vectors";
        else result = Type::f32();
    } else if (function == "length") {
        known = true;
        if (args.size() != 1 || !floating(0)) error = "takes one floating value";
        else result = Type::f32();
    } else if (function == "cross") {
        known = true;
        if (args.size() != 2 || type(0) != Type::vec(3) || type(1) != Type::vec(3)) error = "takes two vec3<f32>";
        else result = Type::vec(3);
    } else if (function == "reflect") {
        known = true;
        if (args.size() != 2 || !floating(0) || !type(0).isVector() || type(0) != type(1)) error = "takes two equal float vectors";
        else result = type(0);
    } else if (function == "greaterEqual" || function == "lessEqual") {
        known = true;
        if (args.size() != 2 || !type(0).numeric() || type(0).isMatrix() || type(0) != type(1))
            error = "takes two equal numeric values";
        else result = Type::vec(type(0).rows, Type::Scalar::Bool);
    } else if (function == "mix" || function == "clamp" || function == "smoothstep") {
        known = true;
        // mix(a, b, t) and clamp(x, lo, hi) follow their first operand; smoothstep(e0, e1, x) its last.
        // The other operands match that type or are a scalar of its kind.
        const bool three = args.size() == 3 && floating(0) && floating(1) && floating(2);
        const Type value = three ? (function == "smoothstep" ? type(2) : type(0)) : Type{};
        auto fits = [&](size_t i) { return type(i) == value || (type(i).isScalar() && type(i).scalar == value.scalar); };
        const bool shapes = function == "mix"      ? type(1) == value && fits(2)
                            : function == "clamp"  ? fits(1) && fits(2)
                                                   : type(0) == type(1) && fits(0);
        if (!three || !shapes) error = "operand types do not match";
        else result = value;
    }
    // MaterialX noise (materialx_noise.h): three's overload is chosen by the coordinate, vec2 (`_0`)
    // or vec3 (`_1`), and the WGSL function carries that number.
    std::string library;
    if (function == "mx_perlin_noise_float" || function == "mx_worley_noise_vec2") {
        known = true;
        const bool worley = function == "mx_worley_noise_vec2";
        const bool coordinate = !args.empty() && (type(0) == Type::vec(2) || type(0) == Type::vec(3));
        if (args.size() != (worley ? 3u : 1u) || !coordinate)
            error = worley ? "takes a vec2 or vec3, a float jitter and an int metric" : "takes a vec2 or vec3";
        else if (worley && (type(1) != Type::f32() || type(2) != Type::i32()))
            error = "takes a vec2 or vec3, a float jitter and an int metric";
        else {
            result = worley ? Type::vec(2) : Type::f32();
            library = std::string(function) + (type(0) == Type::vec(2) ? "_0" : "_1");
        }
    }
    if (!known) {
        diagnostics_.push_back(Diagnostic{"TN_TSL_UNSUPPORTED", std::string(function), "uncatalogued function",
                                          where.file_name(), where.line()});
        return kInvalid;
    }
    if (error.empty() && (function == "dFdx" || function == "dFdy" || function == "fwidth") && stage_ != Stage::Fragment) {
        error = "screen-space derivatives exist only in the fragment stage";
    }
    if (!error.empty()) return fail(function, error, where);
    Expr e{Op::Call, result, {}, static_cast<uint8_t>(args.size()), intern(library.empty() ? function : library)};
    for (size_t i = 0; i < args.size(); ++i) e.args[i] = args[i];
    return pure(e);
}

VarId Program::var(Type type, ExprId initial, Where where) {
    const auto id = static_cast<VarId>(vars_.size());
    vars_.push_back(Var{type});
    assign(id, initial, where);
    return id;
}

ExprId Program::load(VarId var, Where where) {
    if (var >= vars_.size()) return fail("load", "no such variable", where);
    return ordered(Expr{Op::LoadVar, vars_[var].type, {}, 0, var});
}

void Program::assign(VarId var, ExprId value, Where where) {
    if (var >= vars_.size()) {
        fail("assign", "no such variable", where);
        return;
    }
    if (value == kInvalid) return;
    if (exprs_[value].type != vars_[var].type) {
        fail("assign", "a " + exprs_[value].type.name() + " into a " + vars_[var].type.name() + " variable", where);
        return;
    }
    emit(Stmt{StmtKind::Assign, var, value});
}

uint32_t Program::storageBuffer(std::string_view name, Type element, bool atomic, Where where) {
    if (atomic && element != Type::i32() && element != Type::u32())
        fail("storageBuffer " + std::string(name), "atomic elements are i32 or u32, not " + element.name(), where);
    storage_.push_back(Storage{std::string(name), element, atomic});
    return static_cast<uint32_t>(storage_.size() - 1);
}

ExprId Program::loadStorage(uint32_t buffer, ExprId index, Where where) {
    if (index == kInvalid) return kInvalid;
    if (buffer >= storage_.size()) return fail("loadStorage", "no such storage buffer", where);
    const Type t = exprs_[index].type;
    if (t != Type::i32() && t != Type::u32()) return fail("loadStorage", "index is " + t.name(), where);
    Expr e{Op::LoadStorage, storage_[buffer].element, {index}, 1, buffer};
    return ordered(e);
}

ExprId Program::atomicAdd(uint32_t buffer, ExprId index, ExprId value, Where where) {
    if (index == kInvalid || value == kInvalid) return kInvalid;
    if (buffer >= storage_.size()) return fail("atomicAdd", "no such storage buffer", where);
    const Storage& storage = storage_[buffer];
    if (!storage.atomic) return fail("atomicAdd " + storage.name, "the buffer is not atomic", where);
    if (stage_ == Stage::Vertex)
        return fail("atomicAdd " + storage.name, "storage writes are not allowed in the vertex stage", where);
    const Type t = exprs_[index].type;
    if (t != Type::i32() && t != Type::u32()) return fail("atomicAdd " + storage.name, "index is " + t.name(), where);
    if (exprs_[value].type != storage.element)
        return fail("atomicAdd " + storage.name,
                    "a " + exprs_[value].type.name() + " into " + storage.element.name() + " elements", where);
    return ordered(Expr{Op::AtomicAdd, storage.element, {index, value}, 2, buffer});
}

void Program::store(uint32_t buffer, ExprId index, ExprId value, Where where) {
    if (buffer >= storage_.size()) {
        fail("store", "no such storage buffer", where);
        return;
    }
    if (stage_ == Stage::Vertex) {
        fail("store " + storage_[buffer].name, "storage writes are not allowed in the vertex stage", where);
        return;
    }
    if (index == kInvalid || value == kInvalid) return;
    const Type t = exprs_[index].type;
    if (t != Type::i32() && t != Type::u32()) {
        fail("store " + storage_[buffer].name, "index is " + t.name(), where);
        return;
    }
    if (exprs_[value].type != storage_[buffer].element) {
        fail("store " + storage_[buffer].name,
             "a " + exprs_[value].type.name() + " into " + storage_[buffer].element.name() + " elements", where);
        return;
    }
    emit(Stmt{StmtKind::Store, buffer, index, value});
}

uint32_t Program::texture2d(std::string_view name) {
    // One texture is one binding however often it is sampled, as upstream binds a TextureNode once.
    for (std::size_t i = 0; i < textures_.size(); ++i)
        if (textures_[i] == name && textureKinds_[i] == TextureKind::Float2d) return static_cast<uint32_t>(i);
    textures_.emplace_back(name);
    textureKinds_.push_back(TextureKind::Float2d);
    return static_cast<uint32_t>(textures_.size() - 1);
}

uint32_t Program::texture3d(std::string_view name) {
    for (std::size_t i = 0; i < textures_.size(); ++i)
        if (textures_[i] == name && textureKinds_[i] == TextureKind::Float3d) return static_cast<uint32_t>(i);
    textures_.emplace_back(name);
    textureKinds_.push_back(TextureKind::Float3d);
    return static_cast<uint32_t>(textures_.size() - 1);
}

uint32_t Program::textureCube(std::string_view name) {
    for (std::size_t i = 0; i < textures_.size(); ++i)
        if (textures_[i] == name && textureKinds_[i] == TextureKind::FloatCube) return static_cast<uint32_t>(i);
    textures_.emplace_back(name);
    textureKinds_.push_back(TextureKind::FloatCube);
    return static_cast<uint32_t>(textures_.size() - 1);
}

uint32_t Program::textureDepth(std::string_view name, bool cube) {
    // One depth texture is one binding however often it is read (two viewport depth reads share it).
    const TextureKind kind = cube ? TextureKind::DepthCube : TextureKind::Depth2d;
    for (std::size_t i = 0; i < textures_.size(); ++i)
        if (textures_[i] == name && textureKinds_[i] == kind) return static_cast<uint32_t>(i);
    textures_.emplace_back(name);
    textureKinds_.push_back(cube ? TextureKind::DepthCube : TextureKind::Depth2d);
    return static_cast<uint32_t>(textures_.size() - 1);
}

ExprId Program::sampleCompare(uint32_t texture, ExprId uv, ExprId reference, Where where) {
    if (uv == kInvalid || reference == kInvalid) return kInvalid;
    if (texture >= textures_.size() || (textureKinds_[texture] == TextureKind::Float2d || textureKinds_[texture] == TextureKind::Float3d || textureKinds_[texture] == TextureKind::FloatCube))
        return fail("sampleCompare", "no such depth texture", where);
    const Type coordinate = textureKinds_[texture] == TextureKind::DepthCube ? Type::vec(3) : Type::vec(2);
    if (exprs_[uv].type != coordinate)
        return fail("sampleCompare " + textures_[texture], "uv is " + exprs_[uv].type.name(), where);
    if (exprs_[reference].type != Type::f32())
        return fail("sampleCompare " + textures_[texture], "reference is " + exprs_[reference].type.name(), where);
    return pure(Expr{Op::Sample, Type::f32(), {uv, reference}, 2, texture});
}

ExprId Program::gatherCompare(uint32_t texture, ExprId uv, ExprId reference, int8_t offsetX, int8_t offsetY,
                              Where where) {
    if (uv == kInvalid || reference == kInvalid) return kInvalid;
    if (texture >= textures_.size() || textureKinds_[texture] != TextureKind::Depth2d)
        return fail("gatherCompare", "no such 2D depth texture", where);
    if (exprs_[uv].type != Type::vec(2))
        return fail("gatherCompare " + textures_[texture], "uv is " + exprs_[uv].type.name(), where);
    if (exprs_[reference].type != Type::f32())
        return fail("gatherCompare " + textures_[texture], "reference is " + exprs_[reference].type.name(), where);
    // A compare read answering vec4 is a gather; the whole-texel offset rides in the immediate.
    return pure(Expr{Op::Sample, Type::vec(4), {uv, reference}, 2, gatherImmediate(texture, offsetX, offsetY)});
}

ExprId Program::sample(uint32_t texture, ExprId uv, Where where) {
    if (uv == kInvalid) return kInvalid;
    if (texture >= textures_.size() || (textureKinds_[texture] != TextureKind::Float2d && textureKinds_[texture] != TextureKind::Float3d && textureKinds_[texture] != TextureKind::FloatCube))
        return fail("sample", "no such texture", where);
    if (exprs_[uv].type != ((textureKinds_[texture] == TextureKind::Float3d || textureKinds_[texture] == TextureKind::FloatCube) ? Type::vec(3) : Type::vec(2))) return fail("sample " + textures_[texture], "uv is " + exprs_[uv].type.name(), where);
    return pure(Expr{Op::Sample, Type::vec(4), {uv}, 1, texture});
}

ExprId Program::sampleLevel(uint32_t texture, ExprId uv, ExprId level, Where where) {
    if (uv == kInvalid || level == kInvalid) return kInvalid;
    if (texture >= textures_.size() || (textureKinds_[texture] != TextureKind::Float2d && textureKinds_[texture] != TextureKind::Float3d && textureKinds_[texture] != TextureKind::FloatCube))
        return fail("sampleLevel", "no such texture", where);
    if (exprs_[uv].type != ((textureKinds_[texture] == TextureKind::Float3d || textureKinds_[texture] == TextureKind::FloatCube) ? Type::vec(3) : Type::vec(2)))
        return fail("sampleLevel " + textures_[texture], "uv is " + exprs_[uv].type.name(), where);
    if (exprs_[level].type != Type::f32())
        return fail("sampleLevel " + textures_[texture], "level is " + exprs_[level].type.name(), where);
    return pure(Expr{Op::SampleLevel, Type::vec(4), {uv, level}, 2, texture});
}

ExprId Program::textureSize(uint32_t texture, ExprId level, Where where) {
    if (level == kInvalid) return kInvalid;
    if (texture >= textures_.size() || textureKinds_[texture] != TextureKind::Float2d)
        return fail("textureSize", "requires a 2D float texture", where);
    if (exprs_[level].type != Type::i32()) return fail("textureSize", "mip must be i32", where);
    return pure(Expr{Op::TextureSize, Type::vec(2, Type::Scalar::U32), {level}, 1, texture});
}

ExprId Program::textureLoad(uint32_t texture, ExprId coordinate, ExprId level, Where where) {
    if (coordinate == kInvalid || level == kInvalid) return kInvalid;
    // A 2D float texture loads a vec4; a 2D depth texture (texture_depth_2d) loads its f32 depth.
    if (texture >= textures_.size() ||
        (textureKinds_[texture] != TextureKind::Float2d && textureKinds_[texture] != TextureKind::Depth2d))
        return fail("textureLoad", "requires a 2D float or depth texture", where);
    if (exprs_[coordinate].type != Type::vec(2, Type::Scalar::I32) || exprs_[level].type != Type::i32())
        return fail("textureLoad", "coordinates must be ivec2 and mip i32", where);
    const Type loaded = textureKinds_[texture] == TextureKind::Depth2d ? Type::f32() : Type::vec(4);
    return pure(Expr{Op::TextureLoad, loaded, {coordinate, level}, 2, texture});
}

void Program::breakLoop(Where where) {
    if (!loopDepth_) { fail("Break", "outside a loop", where); return; }
    emit(Stmt{StmtKind::Break});
}
void Program::continueLoop(Where where) {
    if (!loopDepth_) { fail("Continue", "outside a loop", where); return; }
    emit(Stmt{StmtKind::Continue});
}

void Program::discard(Where where) {
    if (stage_ != Stage::Fragment) {
        fail("discard", "only fragment shaders discard", where);
        return;
    }
    emit(Stmt{StmtKind::Discard});
}

void Program::output(std::string_view name, ExprId value, Where where) {
    if (value == kInvalid) return;
    const Type type = exprs_[value].type;
    const bool position = name == "position";
    const bool color = name == "color";
    if (position && (stage_ != Stage::Vertex || type != Type::vec(4))) {
        fail("output position", "a vertex stage writes position as vec4<f32>", where);
        return;
    }
    if (color && (stage_ != Stage::Fragment || type != Type::vec(4))) {
        fail("output color", "a fragment stage writes color as vec4<f32>", where);
        return;
    }
    if (stage_ == Stage::Compute) {
        fail("output " + std::string(name), "compute stages write storage, not outputs", where);
        return;
    }
    const uint64_t id = intern(name);
    uint32_t slot = 0;
    while (slot < outputs_.size() && outputs_[slot].name != id) ++slot;
    if (slot == outputs_.size()) {
        outputs_.push_back(OutputSlot{id, type});
    } else if (outputs_[slot].type != type) {
        fail("output " + std::string(name), "written as " + outputs_[slot].type.name() + " and " + type.name(), where);
        return;
    }
    emit(Stmt{StmtKind::Output, slot, value});
}

uint32_t Program::openBlock() {
    blocks_.emplace_back();
    return static_cast<uint32_t>(blocks_.size() - 1);
}

void Program::If(ExprId condition, const std::function<void()>& then, const std::function<void()>& otherwise,
                 Where where) {
    if (condition != kInvalid && exprs_[condition].type != Type::boolean()) {
        fail("If", "condition is " + exprs_[condition].type.name() + ", not bool", where);
        condition = kInvalid;
    }
    const uint32_t parent = current_;
    const uint32_t body = openBlock();
    current_ = body;
    then();
    uint32_t elseBlock = 0;
    if (otherwise) {
        elseBlock = openBlock();
        current_ = elseBlock;
        otherwise();
    }
    current_ = parent;
    if (condition != kInvalid) emit(Stmt{StmtKind::If, condition, kInvalid, kInvalid, body, elseBlock});
}

void Program::Loop(ExprId count, const std::function<void(ExprId)>& body, Where where) {
    if (count != kInvalid && exprs_[count].type != Type::i32()) {
        fail("Loop", "count is " + exprs_[count].type.name() + ", not i32", where);
        count = kInvalid;
    }
    const uint32_t parent = current_;
    const VarId index = static_cast<VarId>(vars_.size());
    vars_.push_back(Var{Type::i32()});
    const uint32_t block = openBlock();
    current_ = block;
    ++loopDepth_;
    body(ordered(Expr{Op::LoadVar, Type::i32(), {}, 0, index}));
    --loopDepth_;
    current_ = parent;
    if (count != kInvalid) emit(Stmt{StmtKind::Loop, count, index, kInvalid, block});
}

std::string Program::describe(ExprId id, std::vector<int>& numbering) const {
    std::string out = describeUntyped(id, numbering);
    if (typed_ && id != kInvalid && numbering[id] < 0) out += ":" + exprs_[id].type.name();
    return out;
}

std::string Program::describeUntyped(ExprId id, std::vector<int>& numbering) const {
    if (id == kInvalid) return "<invalid>";
    const Expr& e = exprs_[id];
    if (numbering[id] >= 0) return "%" + std::to_string(numbering[id]);
    char buffer[64];
    switch (e.op) {
        case Op::Constant:
            if (e.type == Type::f32()) {
                std::snprintf(buffer, sizeof buffer, "%gf", std::bit_cast<float>(static_cast<uint32_t>(e.immediate)));
            } else if (e.type == Type::boolean()) {
                return e.immediate ? "true" : "false";
            } else {
                std::snprintf(buffer, sizeof buffer, "%di", static_cast<int32_t>(e.immediate));
            }
            return buffer;
        case Op::Uniform: return "uniform:" + names_[e.immediate];
        case Op::Attribute: return "attribute:" + names_[e.immediate];
        case Op::Builtin: return "builtin:" + names_[e.immediate];
        case Op::Varying: return "varying:" + names_[e.immediate];
        case Op::Sample:
            if (e.argc == 2 && e.type == Type::vec(4))
                return "gatherCompare:" + textures_[gatherTexture(e.immediate)] + "(" + describe(e.args[0], numbering) +
                       ", " + describe(e.args[1], numbering) + ", " + std::to_string(gatherOffsetX(e.immediate)) + ", " +
                       std::to_string(gatherOffsetY(e.immediate)) + ")";
            if (e.argc == 2)
                return "sampleCompare:" + textures_[e.immediate] + "(" + describe(e.args[0], numbering) + ", " +
                       describe(e.args[1], numbering) + ")";
            return "sample:" + textures_[e.immediate] + "(" + describe(e.args[0], numbering) + ")";
        case Op::SampleLevel:
            return "sampleLevel:" + textures_[e.immediate] + "(" + describe(e.args[0], numbering) + ", " +
                   describe(e.args[1], numbering) + ")";
        case Op::Swizzle: {
            std::string lanes;
            const unsigned n = static_cast<unsigned>(e.immediate >> 8);
            for (unsigned i = 0; i < n; ++i) lanes += "xyzw"[(e.immediate >> (i * 2)) & 3];
            return describe(e.args[0], numbering) + "." + lanes;
        }
        default: break;
    }
    std::string out = e.op == Op::Call ? names_[e.immediate] : opName(e.op);
    if (e.op == Op::Construct) out += "<" + e.type.name() + ">";
    out += "(";
    for (uint8_t i = 0; i < e.argc; ++i) {
        if (i) out += ", ";
        out += describe(e.args[i], numbering);
    }
    return out + ")";
}

void Program::dumpBlock(uint32_t block, int depth, std::string& out, std::vector<int>& numbering, int& next) const {
    const std::string indent(static_cast<size_t>(depth) * 2, ' ');
    for (const Stmt& s : blocks_[block]) {
        switch (s.kind) {
            case StmtKind::Eval: {
                const Expr& e = exprs_[s.b];
                std::string read = e.op == Op::LoadVar ? "load v" + std::to_string(e.immediate)
                                   : e.op == Op::AtomicAdd
                                       ? "atomicAdd " + storage_[e.immediate].name + "[" +
                                             describe(e.args[0], numbering) + "], " + describe(e.args[1], numbering)
                                       : "load " + storage_[e.immediate].name + "[" + describe(e.args[0], numbering) + "]";
                const int n = next++;
                numbering[s.b] = n;
                out += indent + "%" + std::to_string(n) + " = " + read + "\n";
                break;
            }
            case StmtKind::Assign:
                out += indent + "v" + std::to_string(s.a) + " = " + describe(s.b, numbering) + "\n";
                break;
            case StmtKind::Store:
                out += indent + "store " + storage_[s.a].name + "[" + describe(s.b, numbering) + "] = " +
                       describe(s.c, numbering) + "\n";
                break;
            case StmtKind::Discard: out += indent + "discard\n"; break;
            case StmtKind::Output:
                out += indent + "output " + names_[outputs_[s.a].name] + " = " + describe(s.b, numbering) + "\n";
                break;
            case StmtKind::If:
                out += indent + "if " + describe(s.a, numbering) + " {\n";
                dumpBlock(s.body, depth + 1, out, numbering, next);
                if (s.otherwise) {
                    out += indent + "} else {\n";
                    dumpBlock(s.otherwise, depth + 1, out, numbering, next);
                }
                out += indent + "}\n";
                break;
            case StmtKind::Loop:
                out += indent + "loop v" + std::to_string(s.b) + " < " + describe(s.a, numbering) + " {\n";
                dumpBlock(s.body, depth + 1, out, numbering, next);
                out += indent + "}\n";
                break;
        }
    }
}

std::string Program::dump(bool typed) const {
    typed_ = typed;
    std::string out;
    std::vector<int> numbering(exprs_.size(), -1);
    int next = 0;
    dumpBlock(0, 0, out, numbering, next);
    typed_ = false;
    return out;
}

std::vector<std::pair<std::string, Type>> Program::varyings() const {
    std::vector<std::pair<std::string, Type>> result;
    for (const auto& e : exprs_) if (e.op == Op::Varying) result.emplace_back(names_[e.immediate], e.type);
    return result;
}

bool Program::hasOutput(std::string_view name) const {
    return std::any_of(outputs_.begin(), outputs_.end(), [&](const OutputSlot& o) { return names_[o.name] == name; });
}

void Program::linkVaryings(const Program& fragment) {
    const auto inputs = fragment.varyings();
    const auto previous = outputs_;
    const auto rank = [&](const OutputSlot& o) {
        for (size_t i = 0; i < inputs.size(); ++i) if (inputs[i].first == names_[o.name]) return i;
        return inputs.size();
    };
    std::stable_sort(outputs_.begin(), outputs_.end(), [&](const auto& a, const auto& b) { return rank(a) < rank(b); });
    for (auto& block : blocks_) for (auto& stmt : block) {
        if (stmt.kind != StmtKind::Output) continue;
        const auto name = previous[stmt.a].name;
        for (size_t i = 0; i < outputs_.size(); ++i) if (outputs_[i].name == name) { stmt.a = i; break; }
    }
}

}  // namespace tn::engine::shader
