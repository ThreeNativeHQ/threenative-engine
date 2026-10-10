#include "engine/shader/graph/graph.h"

#include "engine/shader/tsl/tsl.h"
#include "engine/shader/cube_uv.h"

#include <bit>
#include <unordered_map>
#include <utility>
#include <stdexcept>
#include <unordered_set>

namespace tn::engine::shader::graph {

namespace {

using tsl::program;

std::shared_ptr<NodeData> makeNode(Kind kind, Type type) {
    auto data = std::make_shared<NodeData>();
    data->kind = kind;
    data->type = type;
    return data;
}

std::shared_ptr<NodeData> makeConstant(double value) {
    auto data = std::make_shared<NodeData>();
    data->kind = Kind::Constant;
    data->type = Type::f32();
    data->bits = std::bit_cast<uint32_t>(static_cast<float>(value));
    return data;
}

std::shared_ptr<NodeData> makeBinary(BinOp op, Node a, Node b) {
    auto data = std::make_shared<NodeData>();
    data->kind = Kind::Binary;
    data->binary = op;
    data->args = {std::move(a), std::move(b)};
    return data;
}

std::shared_ptr<NodeData> makeMath(std::string_view name, std::initializer_list<Node> args) {
    auto data = std::make_shared<NodeData>();
    data->kind = Kind::Math;
    data->name = std::string(name);
    data->args.assign(args.begin(), args.end());
    return data;
}

std::shared_ptr<NodeData> makeJoin(uint8_t lanes, std::initializer_list<Node> parts) {
    auto data = std::make_shared<NodeData>();
    data->kind = Kind::Join;
    data->type = Type::vec(lanes);
    data->args.assign(parts.begin(), parts.end());
    return data;
}

/** Walks a graph and lowers each node once, preserving statement order. */
class Lowerer {
public:
    explicit Lowerer(Program& program, const std::unordered_map<std::string, ExprId>& inputs)
        : program_(program), inputs_(inputs) {}

    ExprId expression(Node node);
    void statements(const std::vector<Node>& list);

private:
    void statement(Node node);
    VarId ensureVar(Node var);
    uint32_t ensureStorage(const NodeData& element);
    ExprId emit(Node node);
    ExprId convert(ExprId value, Type target);

    Program& program_;
    const std::unordered_map<std::string, ExprId>& inputs_;
    std::unordered_map<const NodeData*, ExprId> exprs_;
    std::unordered_map<const NodeData*, VarId> vars_;
    std::unordered_map<std::string, uint32_t> buffers_;
    std::unordered_map<const NodeData*, ExprId> loopIndex_;
    static constexpr VarId noVar = UINT32_MAX;
    VarId returnVar_ = noVar, doneVar_ = noVar;
    Type returnType_;
};

ExprId Lowerer::convert(ExprId value, Type target) {
    if (value == kInvalid) return kInvalid;
    const auto source = program_.expr(value).type;
    if (source == target) return value;
    // NodeBuilder.format r185: truncate vectors, pad vec2 with z=0 and vec3 with w=1.
    if (!source.isMatrix() && !target.isMatrix() && source.rows > target.rows)
        return convert(program_.swizzle(value, std::string("xyzw").substr(0, target.rows)), target);
    if (source.isVector() && target.isVector() && source.rows < target.rows) {
        auto part = convert(value, Type::vec(source.rows));
        if (source.rows == 2) part = program_.construct(Type::vec(3), {part, program_.constant(0.0f)});
        if (target.rows == 4) part = program_.construct(Type::vec(4), {part, program_.constant(1.0f)});
        return convert(part, target);
    }
    return program_.construct(target, {value});
}

ExprId Lowerer::expression(Node node) {
    if (!node) return kInvalid;
    const auto found = exprs_.find(node.get());
    if (found != exprs_.end()) return found->second;
    const ExprId id = emit(node);
    exprs_.emplace(node.get(), id);
    return id;
}

ExprId Lowerer::emit(Node node) {
    const NodeData& d = *node;
    if (d.kind == Kind::PositionLocal || d.kind == Kind::Varying || d.kind == Kind::Attribute) {
        const auto input = inputs_.find(d.kind == Kind::PositionLocal ? "positionLocal" : d.name);
        if (input != inputs_.end()) return input->second;
    }
    switch (d.kind) {
        case Kind::Body: {
            statements(d.body);
            exprs_.clear();
            if (d.args.empty()) return kInvalid;
            if (returnVar_ == noVar) return expression(d.args[0]);
            program_.If(program_.equal(program_.load(doneVar_), program_.constant(false)), [this, &d] {
                exprs_.clear(); const ExprId result = expression(d.args[0]);
                program_.assign(returnVar_, result == kInvalid || returnType_.scalar == Type::Scalar::Void || program_.expr(result).type == returnType_
                    ? result : convert(result, returnType_));
            });
            return program_.load(returnVar_);
        }
        case Kind::Call: {
            // Each invocation gets its own return slot; callbacks are inlined, like upstream
            // ShaderCallNodeInternal without a layout. A return inside If remains local.
            const VarId previousReturn = returnVar_, previousDone = doneVar_;
            const Type previousType = returnType_; returnType_ = d.type;
            returnVar_ = noVar; doneVar_ = program_.var(Type::boolean(), program_.constant(false));
            const ExprId result = expression(d.args[0]);
            ExprId value = returnVar_ == noVar ? result : program_.load(returnVar_);
            if (value != kInvalid && returnType_.scalar != Type::Scalar::Void && program_.expr(value).type != returnType_)
                value = convert(value, returnType_);
            returnType_ = previousType;
            returnVar_ = previousReturn; doneVar_ = previousDone;
            return value;
        }
        case Kind::Var: { const auto variable = ensureVar(node); return variable == noVar ? kInvalid : program_.load(variable); }
        case Kind::RenderTexture:
            return program_.sample(program_.texture2d(d.name), expression(d.args[1]));
        case Kind::TextureSize:
            return program_.textureSize(program_.texture2d(d.name), d.args.empty() ? program_.constant(int32_t(0)) : expression(d.args[0]));
        case Kind::TextureLoad:
            return program_.textureLoad(program_.texture2d(d.name), expression(d.args[0]), d.args.size() < 2 ? program_.constant(int32_t(0)) : expression(d.args[1]));
        case Kind::Constant:
            if (d.type.scalar == Type::Scalar::F32)
                return program_.constant(std::bit_cast<float>(static_cast<uint32_t>(d.bits)));
            if (d.type.scalar == Type::Scalar::I32) return program_.constant(static_cast<int32_t>(d.bits));
            if (d.type.scalar == Type::Scalar::Bool) return program_.constant(d.bits != 0);
            return kInvalid;
        case Kind::Uniform: return program_.uniform(d.name, d.type);
        case Kind::Attribute:
            // The fragment's `position` would collide with the clip-position output's name.
            if (d.name == "position" && program_.stage() == Stage::Fragment)
                return program_.varying("positionGeometry", d.type);
            return tsl::attribute(d.name, d.type).id;
        case Kind::Varying:
            // varying(node): a vertex stage computes what it carries; a fragment stage reads it.
            if (!d.args.empty() && program_.stage() != Stage::Fragment) return expression(d.args[0]);
            if (!d.args.empty() && d.type == Type{}) {
                // A graph node's type is known once lowered: type the varying by a vertex lowering.
                Program vertex(Stage::Vertex);
                tsl::Build build(vertex);
                const ExprId carried = lower(d.args[0], vertex);
                if (carried == kInvalid) return kInvalid;
                return program_.varying(d.name, vertex.expr(carried).type);
            }
            return program_.varying(d.name, d.type);
        case Kind::Builtin:
            return d.name == "instanceIndex" ? tsl::instanceIndex().id : program_.builtin(d.name);
        case Kind::PositionLocal: return tsl::positionLocal().id;
        case Kind::Unary: return d.unary == UnOp::Negate ? program_.neg(expression(d.args[0])) : kInvalid;
        case Kind::Binary: {
            ExprId a = expression(d.args[0]);
            ExprId b = expression(d.args[1]);
            if (a == kInvalid || b == kInvalid) return kInvalid;
            if (d.bits == 1) {
                auto at = program_.expr(a).type, bt = program_.expr(b).type;
                if (at.numeric() && bt.numeric() && !at.isMatrix() && !bt.isMatrix() && at.scalar != bt.scalar) {
                    const bool compare = d.binary == BinOp::Less || d.binary == BinOp::Greater || d.binary == BinOp::Equal;
                    const auto scalar = compare && at.isScalar() && bt.isScalar() ? Type::Scalar::F32 : at.rows >= bt.rows ? at.scalar : bt.scalar;
                    if (at.scalar != scalar) a = program_.construct(Type::vec(at.rows, scalar), {a});
                    if (bt.scalar != scalar) b = program_.construct(Type::vec(bt.rows, scalar), {b});
                }
            }
            switch (d.binary) {
                case BinOp::Add: return program_.add(a, b);
                case BinOp::Sub: return program_.sub(a, b);
                case BinOp::Mul: return program_.mul(a, b);
                case BinOp::Div: return program_.div(a, b);
                case BinOp::Less: return program_.less(a, b);
                case BinOp::Greater: return program_.less(b, a);
                case BinOp::Equal: return program_.equal(a, b);
                case BinOp::ShiftRight: return program_.shiftRight(a, b);
                case BinOp::BitXor: return program_.bitXor(a, b);
            }
            return kInvalid;
        }
        case Kind::Math: {
            std::vector<ExprId> ids;
            for (const Node& arg : d.args) ids.push_back(expression(arg));
            if (d.bits == 1 && ids.size() == 2 && (d.name == "min" || d.name == "max" || d.name == "pow" || d.name == "step")) {
                if (ids[0] == kInvalid || ids[1] == kInvalid) return kInvalid;
                const auto a = program_.expr(ids[0]).type, b = program_.expr(ids[1]).type;
                const auto target = a.rows >= b.rows ? a : b;
                for (auto& id : ids) if (program_.expr(id).type != target) id = program_.construct(target, {id});
            }
            return program_.call(d.name, ids);
        }
        case Kind::Swizzle: return program_.swizzle(expression(d.args[0]), d.lanes);
        case Kind::Join: {
            std::vector<ExprId> ids;
            for (const Node& part : d.args) ids.push_back(expression(part));
            // `vec3(0.5)` splats a constant, as the builder's join does.
            if (ids.size() == 1 && ids[0] != kInvalid && program_.expr(ids[0]).op == Op::Constant)
                ids.assign(d.type.rows, ExprId{ids[0]});  // a copy: assign's value must not alias the vector
            return program_.construct(d.type, ids);
        }
        case Kind::Convert: return convert(expression(d.args[0]), d.type);
        case Kind::Select:
            return program_.select(expression(d.args[0]), expression(d.args[1]), expression(d.args[2]));
        case Kind::Reflector:
            return program_.sample(program_.texture2d("reflector"), expression(d.args[0]));
        case Kind::ScreenUv: {
            // ScreenNode.UV: screenCoordinate / screenSize, the render target's size when drawing into one.
            const auto input = inputs_.find("screenUV");
            if (input != inputs_.end()) return input->second;
            return program_.div(program_.swizzle(program_.builtin("position"), "xy"),
                                program_.uniform("screenSize", Type::vec(2)));
        }
        case Kind::ViewportDepth: {
            // The texel under uv * screenSize of the depth copy the renderer takes before this draw.
            const ExprId at = expression(d.args[0]);
            if (at == kInvalid) return kInvalid;
            const ExprId size = program_.uniform("screenSize", Type::vec(2));
            const ExprId texel = program_.call("min", {program_.call("floor", {program_.mul(at, size)}),
                                                       program_.sub(size, program_.constant(1.0f))});
            return program_.textureLoad(program_.textureDepth("viewportDepth"),
                                        program_.construct(Type::vec(2, Type::Scalar::I32), {texel}),
                                        program_.constant(int32_t(0)));
        }
        case Kind::Pmrem: {
            // PMREMNode.setup: a render-target PMREM flips y, then materialEnvRotation turns it.
            const ExprId direction = expression(d.args[0]), level = expression(d.args[1]);
            if (direction == kInvalid || level == kInvalid) return kInvalid;
            const ExprId flipped = program_.construct(Type::vec(3), {program_.swizzle(direction, "x"),
                program_.neg(program_.swizzle(direction, "y")), program_.swizzle(direction, "z")});
            const ExprId rotated = program_.swizzle(program_.mul(program_.uniform("pmremRotation", Type::mat(4, 4)),
                program_.construct(Type::vec(4), {flipped, program_.constant(0.0f)})), "xyz");
            return pmremSample(program_, program_.texture2d("pmrem"), rotated, level);
        }
        case Kind::PostEffect: {
            const auto sample = program_.sample(program_.texture2d(d.name), expression(uv()));
            return d.type == Type::f32() ? program_.swizzle(sample,"x") : sample;
        }
        case Kind::Texture: {
            const ExprId coordinate = expression(d.args[0]);
            if (coordinate == kInvalid) return kInvalid;
            // TextureNode.level(n): an explicit mip, which a vertex stage needs.
            if (d.args.size() == 2) {
                const ExprId level = expression(d.args[1]);
                if (level == kInvalid) return kInvalid;
                return program_.sampleLevel(program_.expr(coordinate).type == Type::vec(3)
                                                ? program_.texture3d(d.name) : program_.texture2d(d.name),
                                            coordinate, level);
            }
            return program_.sample(program_.expr(coordinate).type == Type::vec(3)
                                       ? program_.texture3d(d.name) : program_.texture2d(d.name), coordinate);
        }
        case Kind::StorageElement:
            return program_.loadStorage(ensureStorage(d), expression(d.args[0]));
        case Kind::VarRead: { const auto variable = ensureVar(d.args[0]); return variable == noVar ? kInvalid : program_.load(variable); }
        case Kind::LoopIndex: {
            const auto found = loopIndex_.find(&d);
            return found == loopIndex_.end() ? kInvalid : found->second;
        }
        case Kind::StructType: case Kind::Struct:
            throw std::runtime_error("TN_TSL_STRUCT_AGGREGATE_UNSUPPORTED: select a struct member before lowering");
        default: return kInvalid;
    }
}

VarId Lowerer::ensureVar(Node var) {
    const auto found = vars_.find(var.get());
    if (found != vars_.end()) return found->second;
    const ExprId initial = expression(var->args[0]);
    if (initial == kInvalid) return noVar;
    const VarId id = program_.var(var->type.scalar == Type::Scalar::Void ? program_.expr(initial).type : var->type, initial);
    vars_.emplace(var.get(), id);
    return id;
}

uint32_t Lowerer::ensureStorage(const NodeData& element) {
    const auto found = buffers_.find(element.name);
    if (found != buffers_.end()) return found->second;
    const uint32_t buffer = program_.storageBuffer(element.name, element.type);
    buffers_.emplace(element.name, buffer);
    return buffer;
}

void Lowerer::statement(Node node) {
    const NodeData& s = *node;
    switch (s.kind) {
        case Kind::Break: program_.breakLoop(); return;
        case Kind::Continue: program_.continueLoop(); return;
        case Kind::Discard: program_.discard(); return;
        case Kind::Body:
            statements(s.body);
            if (!s.args.empty()) statement(s.args[0]);
            return;
        case Kind::Call: (void)expression(node); return;
        case Kind::Return: {
            if (s.args.empty()) {
                if (doneVar_ != noVar) program_.assign(doneVar_, program_.constant(true));
                return;
            }
            ExprId value = expression(s.args[0]);
            if (value == kInvalid) return;
            if (returnType_.scalar != Type::Scalar::Void && program_.expr(value).type != returnType_)
                value = convert(value, returnType_);
            if (returnVar_ == noVar) returnVar_ = program_.var(program_.expr(value).type, value);
            else program_.assign(returnVar_, value);
            if (doneVar_ == noVar) doneVar_ = program_.var(Type::boolean(), program_.constant(false));
            program_.assign(doneVar_, program_.constant(true));
            return;
        }
        case Kind::Var: (void)ensureVar(node); return;
        case Kind::Assign: {
            const Node& target = s.args[0];
            if (target->kind == Kind::Var) {
                program_.assign(ensureVar(target), expression(s.args[1]));
            } else if (target->kind == Kind::Swizzle && target->args[0]->kind == Kind::Var) {
                const VarId variable = ensureVar(target->args[0]);
                const ExprId old = program_.load(variable), source = expression(s.args[1]);
                const Type type = program_.expr(old).type;
                std::vector<ExprId> parts;
                const std::string lanes = "xyzw";
                for (uint8_t i = 0; i < type.rows; ++i) {
                    const auto lane = target->lanes.find(lanes[i]);
                    parts.push_back(lane == std::string::npos ? program_.swizzle(old, lanes.substr(i, 1))
                        : target->lanes.size() == 1 ? source : program_.swizzle(source, lanes.substr(lane, 1)));
                }
                program_.assign(variable, program_.construct(type, parts));
            } else if (target->kind == Kind::StorageElement) {
                const uint32_t buffer = ensureStorage(*target);
                const ExprId index = expression(target->args[0]);
                program_.store(buffer, index, expression(s.args[1]));
            }
            return;
        }
        case Kind::If: {
            const ExprId condition = expression(s.args[0]);
            if (s.otherwise.empty()) {
                program_.If(condition, [this, &s] { statements(s.body); });
            } else {
                program_.If(condition, [this, &s] { statements(s.body); },
                            [this, &s] { statements(s.otherwise); });
            }
            return;
        }
        case Kind::Loop: {
            const ExprId count = expression(s.args[0]);
            const Node indexNode = s.args[1];
            program_.Loop(count, [this, &s, &indexNode](ExprId index) {
                loopIndex_[indexNode.get()] = s.args.size() > 2 ? program_.add(index, expression(s.args[2])) : index;
                statements(s.body);
            });
            return;
        }
        default: return;
    }
}

void Lowerer::statements(const std::vector<Node>& list) {
    for (const Node& node : list) {
        exprs_.clear(); // ordered loads must observe assignments and stay in their lexical block
        if (doneVar_ == noVar) statement(node);
        else program_.If(program_.equal(program_.load(doneVar_), program_.constant(false)), [this, &node] { statement(node); });
    }
}

}  // namespace

Node float_(double value) { return makeConstant(value); }
Node float_(Node value) {
    auto data = makeNode(Kind::Convert, Type::f32());
    data->args = {std::move(value)};
    return data;
}
Node int_(int32_t value) {
    auto data = std::make_shared<NodeData>();
    data->kind = Kind::Constant;
    data->type = Type::i32();
    data->bits = static_cast<uint32_t>(value);
    return data;
}
Node uint_(uint32_t value) {
    auto data = makeNode(Kind::Convert, Type::u32());
    data->args = {int_(static_cast<int32_t>(value))};
    return data;
}
Node uint_(Node value) {
    auto data = makeNode(Kind::Convert, Type::u32());
    data->args = {std::move(value)};
    return data;
}

Node add(Node a, Node b) { return makeBinary(BinOp::Add, std::move(a), std::move(b)); }
Node sub(Node a, Node b) { return makeBinary(BinOp::Sub, std::move(a), std::move(b)); }
Node mul(Node a, Node b) { return makeBinary(BinOp::Mul, std::move(a), std::move(b)); }
Node div(Node a, Node b) { return makeBinary(BinOp::Div, std::move(a), std::move(b)); }
Node shiftRight(Node a, Node b) { return makeBinary(BinOp::ShiftRight, std::move(a), std::move(b)); }
Node bitXor(Node a, Node b) { return makeBinary(BinOp::BitXor, std::move(a), std::move(b)); }
Node lessThan(Node a, Node b) { return makeBinary(BinOp::Less, std::move(a), std::move(b)); }
Node greaterThan(Node a, Node b) { return makeBinary(BinOp::Greater, std::move(a), std::move(b)); }
Node equal(Node a, Node b) { return makeBinary(BinOp::Equal, std::move(a), std::move(b)); }

Node negate(Node a) {
    auto data = std::make_shared<NodeData>();
    data->kind = Kind::Unary;
    data->unary = UnOp::Negate;
    data->args = {std::move(a)};
    return data;
}

Node select(Node condition, Node whenTrue, Node whenFalse) {
    auto data = std::make_shared<NodeData>();
    data->kind = Kind::Select;
    data->args = {std::move(condition), std::move(whenTrue), std::move(whenFalse)};
    return data;
}

Node swizzle(Node value, std::string_view lanes) {
    auto data = std::make_shared<NodeData>();
    data->kind = Kind::Swizzle;
    data->lanes = std::string(lanes);
    data->args = {std::move(value)};
    return data;
}

Node texture(std::string_view map, Node uvs) {
    auto data = std::make_shared<NodeData>();
    data->kind = Kind::Texture;
    data->name = std::string(map);
    data->args = {std::move(uvs)};
    return data;
}

Node objectTexture(std::shared_ptr<const void> texture, std::string name, Node uvs) {
    auto data = std::make_shared<NodeData>();
    data->kind = Kind::Texture;
    data->name = std::move(name);
    data->object = std::move(texture);
    data->args = {std::move(uvs)};
    return data;
}

Node pmremTexture(std::shared_ptr<const void> texture, Node direction, Node level) {
    auto data = makeNode(Kind::Pmrem, Type::vec(3));
    data->object = std::move(texture);
    data->args = {std::move(direction), std::move(level)};
    return data;
}

Node reflectorTexture(std::shared_ptr<const void> reflector, Node uvs) {
    auto data = makeNode(Kind::Reflector, Type::vec(4));
    data->object = std::move(reflector);
    data->args = {std::move(uvs)};
    return data;
}

Node uniform(std::string_view name, Type type, std::vector<float> values) {
    auto data = makeNode(Kind::Uniform, type);
    data->name = std::string(name);
    data->values = std::move(values);
    return data;
}
void setUniformValues(const Node& uniform, std::vector<float> values) {
    if (!uniform || uniform->kind != Kind::Uniform) throw std::runtime_error("TN_TSL_UNIFORM_VALUE: not a uniform node");
    // A uniform built without a value (cameraViewMatrix, materialColor) is the engine's to fill.
    if (uniform->values.empty()) throw std::runtime_error("TN_TSL_UNIFORM_VALUE: " + uniform->name + " is engine-provided");
    if (uniform->type.isMatrix() || uniform->type.scalar != Type::Scalar::F32 || values.size() != uniform->type.rows)
        throw std::runtime_error("TN_TSL_UNIFORM_VALUE: " + uniform->name + " takes " +
                                 std::to_string(uniform->type.rows) + " float value(s)");
    uniform->values = std::move(values);
}
Node attribute(std::string_view name, Type type) {
    auto data = makeNode(Kind::Attribute, type);
    data->name = std::string(name);
    return data;
}
Node varying(Node value, std::string_view name) {
    auto data = makeNode(Kind::Varying, value->type);
    data->name = std::string(name);
    data->args = {std::move(value)};
    return data;
}
Node varying(std::string_view name, Type type) {
    auto data = makeNode(Kind::Varying, type);
    data->name = std::string(name);
    return data;
}
Node builtin(std::string_view name) {
    auto data = makeNode(Kind::Builtin, Type{});
    data->name = std::string(name);
    return data;
}
Node positionLocal() { return makeNode(Kind::PositionLocal, Type::vec(3)); }
Node uv() { return attribute("uv", Type::vec(2)); }
Node screenUV() { return makeNode(Kind::ScreenUv, Type::vec(2)); }
Node viewportDepth(Node uv) {
    auto data = makeNode(Kind::ViewportDepth, Type::f32());
    data->args = {std::move(uv)};
    return data;
}
Node instanceIndex() { return builtin("instanceIndex"); }

Node vec2(std::initializer_list<Node> parts) { return makeJoin(2, parts); }
Node vec3(std::initializer_list<Node> parts) { return makeJoin(3, parts); }
Node splat(Node scalar, uint8_t lanes) {
    auto data = makeNode(Kind::Convert, Type::vec(lanes));
    data->args = {std::move(scalar)};
    return data;
}
Node mat2(std::initializer_list<Node> parts) {
    auto data = makeJoin(2, parts);
    data->type = Type::mat(2, 2);
    return data;
}
Node vec4(std::initializer_list<Node> parts) { return makeJoin(4, parts); }

#define TN_GRAPH_UNARY(name) Node name(Node a) { return makeMath(#name, {std::move(a)}); }
#define TN_GRAPH_BINARY(name) Node name(Node a, Node b) { return makeMath(#name, {std::move(a), std::move(b)}); }
#define TN_GRAPH_TERNARY(name) \
    Node name(Node a, Node b, Node c) { return makeMath(#name, {std::move(a), std::move(b), std::move(c)}); }
TN_GRAPH_UNARY(abs)
TN_GRAPH_UNARY(sin)
TN_GRAPH_UNARY(cos)
TN_GRAPH_UNARY(floor)
TN_GRAPH_UNARY(fract)
TN_GRAPH_UNARY(sqrt)
TN_GRAPH_UNARY(exp)
TN_GRAPH_UNARY(exp2)
TN_GRAPH_UNARY(log2)
TN_GRAPH_UNARY(normalize)
TN_GRAPH_UNARY(length)
TN_GRAPH_UNARY(dFdx)
TN_GRAPH_UNARY(dFdy)
TN_GRAPH_UNARY(sign)
TN_GRAPH_UNARY(atan)
TN_GRAPH_UNARY(fwidth)
TN_GRAPH_BINARY(min)
TN_GRAPH_BINARY(max)
TN_GRAPH_BINARY(pow)
TN_GRAPH_BINARY(step)
TN_GRAPH_BINARY(dot)
TN_GRAPH_BINARY(distance)
TN_GRAPH_BINARY(cross)
TN_GRAPH_BINARY(atan2)
TN_GRAPH_BINARY(mod)
TN_GRAPH_TERNARY(mix)
TN_GRAPH_TERNARY(clamp)
TN_GRAPH_TERNARY(smoothstep)
#undef TN_GRAPH_UNARY
#undef TN_GRAPH_BINARY
#undef TN_GRAPH_TERNARY

Node Var::read() const {
    auto data = std::make_shared<NodeData>();
    data->kind = Kind::VarRead;
    data->args = {declaration};
    return data;
}

Node Storage::element(Node index) const {
    auto data = std::make_shared<NodeData>();
    data->kind = Kind::StorageElement;
    data->name = name;
    data->type = elementType;
    data->object = object;
    data->args = {std::move(index)};
    return data;
}

Var Block::var(Node initial) {
    auto data = std::make_shared<NodeData>();
    data->kind = Kind::Var;
    data->type = initial->type;
    data->args = {std::move(initial)};
    const Node declaration = data;
    append(declaration);
    return Var{declaration, data->type};
}

void Block::assign(Node target, Node value) {
    auto data = std::make_shared<NodeData>();
    data->kind = Kind::Assign;
    data->args = {std::move(target), std::move(value)};
    append(data);
}

void Block::If(Node condition, const std::function<void()>& then) {
    auto body = std::make_shared<std::vector<Node>>();
    blocks_.push_back(body);
    if (then) then();
    blocks_.pop_back();
    auto data = std::make_shared<NodeData>();
    data->kind = Kind::If;
    data->args = {std::move(condition)};
    data->body = *body;
    append(data);
}

void Block::IfElse(Node condition, const std::function<void()>& then, const std::function<void()>& otherwise) {
    auto body = std::make_shared<std::vector<Node>>();
    blocks_.push_back(body);
    if (then) then();
    blocks_.pop_back();
    auto alt = std::make_shared<std::vector<Node>>();
    blocks_.push_back(alt);
    if (otherwise) otherwise();
    blocks_.pop_back();
    auto data = std::make_shared<NodeData>();
    data->kind = Kind::If;
    data->args = {std::move(condition)};
    data->body = *body;
    data->otherwise = *alt;
    append(data);
}

void Block::Loop(int32_t count, const std::function<void(Node)>& body) {
    const Node index = makeNode(Kind::LoopIndex, Type::i32());
    auto statements = std::make_shared<std::vector<Node>>();
    blocks_.push_back(statements);
    if (body) body(index);
    blocks_.pop_back();
    auto data = std::make_shared<NodeData>();
    data->kind = Kind::Loop;
    data->args = {int_(count), index};
    data->body = *statements;
    append(data);
}

void Block::append(Node statement) { blocks_.back()->push_back(std::move(statement)); }

Node Block::node() const {
    auto data = std::make_shared<NodeData>();
    data->kind = Kind::Body;
    data->body = *blocks_.front();
    return data;
}

ExprId lower(const Graph& graph, Program& program, const std::unordered_map<std::string, ExprId>& inputs) {
    if (!graph) return kInvalid;
    Lowerer lowerer(program, inputs);
    return lowerer.expression(graph);
}

namespace {
uint64_t keySerializations = 0;
}

uint64_t keyBuilds() { return keySerializations; }

std::string key(const Graph& graph) {
    ++keySerializations;
    std::unordered_map<const NodeData*, size_t> ids;
    std::string out;
    const auto text = [&](const std::string& s) { out += std::to_string(s.size()) + ":" + s; };
    const std::function<void(Node)> visit = [&](Node n) {
        if (!n) { out += "null;"; return; }
        const auto [it, fresh] = ids.emplace(n.get(), ids.size());
        out += std::to_string(it->second) + ";";
        if (!fresh) return;
        out += "{" + std::to_string(int(n->kind)) + "," + n->type.name() + "," +
               std::to_string(n->bits) + "," + std::to_string(n->scale) + "," + std::to_string(n->width) + "," + std::to_string(n->height) + "," + std::to_string(int(n->unary)) + "," +
               std::to_string(int(n->binary)) + ";";
        text(n->name); text(n->lanes);
        for (const auto* list : {&n->args, &n->body, &n->otherwise}) {
            out += "[";
            for (const auto& child : *list) visit(child);
            out += "]";
        }
        out += "}";
    };
    visit(graph);
    return out;
}

uint64_t keyId(const Graph& graph) {
    if (!graph) return 0;
    if (graph->memo.keyId == 0) {
        // ponytail: one process-wide table, never pruned; it holds one entry per distinct structure.
        static std::unordered_map<std::string, uint64_t> interned;
        graph->memo.keyId = interned.emplace(key(graph), interned.size() + 1).first->second;
    }
    return graph->memo.keyId;
}

namespace {
uint64_t uniformMaps = 0;
}  // namespace

uint64_t uniformMapBuilds() { return uniformMaps; }

const std::vector<Node>& uniformList(const Graph& graph) {
    if (!graph->memo.uniforms) {
        auto list = std::make_shared<std::vector<Node>>();
        std::unordered_set<const NodeData*> seen;
        const std::function<void(Node)> visit = [&](Node n) {
            if (!n || !seen.insert(n.get()).second) return;
            if (n->kind == Kind::Uniform) list->push_back(n);
            for (const auto* children : {&n->args, &n->body, &n->otherwise})
                for (const auto& child : *children) visit(child);
        };
        visit(graph);
        graph->memo.uniforms = std::move(list);
    }
    return *graph->memo.uniforms;
}

std::vector<Node> uniformNodes(const Graph& graph) {
    std::vector<Node> result;
    if (!graph) return result;
    for (const Node& n : uniformList(graph))
        if (!n->values.empty()) result.push_back(n);
    return result;
}

std::map<std::string, std::vector<float>> uniforms(const Graph& graph) {
    std::map<std::string, std::vector<float>> result;
    if (!graph) return result;
    ++uniformMaps;
    for (const Node& n : uniformList(graph)) {
        if (n->values.empty()) continue;
        const auto [it, fresh] = result.emplace(n->name, n->values);
        if (!fresh && it->second != n->values) throw std::runtime_error("TN_TSL_UNIFORM_CONFLICT: " + n->name);
    }
    return result;
}

}  // namespace tn::engine::shader::graph
