#include "engine/shader/graph/graph.h"
#include "engine/scene/texture.h"

#include "engine/shader/tsl/tsl.h"
#include "engine/shader/cube_uv.h"
#include "engine/shader/output.h"

#include <algorithm>
#include <bit>
#include <cmath>
#include <functional>
#include <limits>
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
    explicit Lowerer(Program& program, const std::unordered_map<std::string, ExprId>& inputs,
                     std::optional<ToneMapping> toneMapping, bool srgb, Node custom)
        : custom_(custom), program_(program), inputs_(inputs), toneMapping_(toneMapping), srgb_(srgb) {}

    void analyze(Node node);
    ExprId expression(Node node);
    void statements(const std::vector<Node>& list);

private:
    void statement(Node node);
    VarId ensureVar(Node var);
    uint32_t ensureStorage(const NodeData& element);
    ExprId emit(Node node);
    std::vector<ExprId> aggregate(Node node);
    std::vector<VarId> aggregateReturns_;
    ExprId convert(ExprId value, Type target);
    /** A storage element's index: a float (the JS number 0) is the whole number it holds, as three builds it as uint. */
    ExprId index(const Node& element);

    Node custom_;
    Program& program_;
    const std::unordered_map<std::string, ExprId>& inputs_;
    std::unordered_map<const NodeData*, ExprId> exprs_, effects_;
    std::unordered_map<const NodeData*, uint32_t> uses_;
    std::unordered_map<const NodeData*, std::pair<uint32_t, ExprId>> temps_;
    std::unordered_map<const NodeData*, std::vector<ExprId>> aggregates_;
    std::unordered_map<const NodeData*, VarId> vars_;
    std::unordered_map<const NodeData*, ExprId> loopIndex_;
    // A Fn result that ran statements is one Body node read at every use. Its statements lower once per
    // lexical scope: `scopes_` is the open If/Loop blocks, `bodyScope_` where each Body already lowered.
    std::vector<uint32_t> scopes_{0};
    uint32_t scopeCount_ = 0;
    bool returned_ = false;
    std::unordered_map<const NodeData*, uint32_t> bodyScope_;
    std::function<void()> inScope(std::function<void()> body) {
        return [this, body = std::move(body)] { scopes_.push_back(++scopeCount_); body(); scopes_.pop_back(); };
    }
    static constexpr VarId noVar = UINT32_MAX;
    VarId returnVar_ = noVar, doneVar_ = noVar;
    Type returnType_;
    std::optional<ToneMapping> toneMapping_;
    bool srgb_;
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

ExprId Lowerer::index(const Node& element) {
    const ExprId value = expression(element->args[0]);
    return value != kInvalid && program_.expr(value).type == Type::f32() ? convert(value, Type::u32()) : value;
}

// Node.analyze r185 counts each incoming use, descending into children only on the first.
void Lowerer::analyze(Node node) {
    if (!node || ++uses_[node.get()] != 1) return;
    if (node->kind == Kind::Call) return; // each invocation owns its analysis and early returns
    for (const auto& arg : node->args) analyze(arg);
    for (const auto& child : node->body) analyze(child);
    for (const auto& child : node->otherwise) analyze(child);
}

ExprId Lowerer::expression(Node node) {
    if (!node) return kInvalid;
    if (const auto effect = effects_.find(node.get()); effect != effects_.end()) return effect->second;
    const auto temp = temps_.find(node.get());
    if (temp != temps_.end() && std::find(scopes_.begin(), scopes_.end(), temp->second.first) != scopes_.end())
        return temp->second.second;
    const auto found = exprs_.find(node.get());
    if (found != exprs_.end()) return found->second;
    ExprId id = emit(node);
    // The scene's two scalar MRT outputs share a packed target; three splats each to RGBA.
    if (id != kInvalid && (node->kind == Kind::Texture || node->kind == Kind::TextureLoad)) {
        if (node->name == "metalness") id = program_.swizzle(id, "xxxx");
        if (node->name == "roughness") id = program_.swizzle(id, "yyyy");
    }
    // TempNode subclasses snapshot shared values; Var/Split/Convert remain live expressions.
    const auto kind = node->kind;
    const bool shared = uses_[node.get()] > 1 && (kind == Kind::Unary || kind == Kind::Binary ||
        kind == Kind::Math || kind == Kind::Join || kind == Kind::Pmrem ||
        kind == Kind::RenderOutput || kind == Kind::WgslCall);
    // TextureNode generates a sampled temporary even for a single use.
    const bool sampled = kind == Kind::Texture || kind == Kind::TextureLoad || kind == Kind::RenderTexture ||
        kind == Kind::Reflector || kind == Kind::ViewportDepth;
    if (id != kInvalid && (shared || sampled)) {
        id = program_.load(program_.var(program_.expr(id).type, id));
        temps_[node.get()] = {scopes_.back(), id};
    }
    exprs_.emplace(node.get(), id);
    if (node->kind == Kind::AtomicAdd) effects_.emplace(node.get(), id);
    return id;
}

std::vector<ExprId> Lowerer::aggregate(Node node) {
    if (const auto found = aggregates_.find(node.get()); found != aggregates_.end()) return found->second;
    std::vector<ExprId> values;
    if (node->kind == Kind::Call) {
        Lowerer invocation(program_, inputs_, toneMapping_, srgb_, custom_);
        invocation.vars_ = vars_; invocation.loopIndex_ = loopIndex_;
        invocation.analyze(node->args.at(0));
        values = invocation.aggregate(node->args.at(0));
    } else if (node->kind == Kind::Struct) {
        for (const auto& member : node->args) {
            const auto value = expression(member);
            if (value == kInvalid) throw std::runtime_error("TN_TSL_STRUCT_MEMBER: invalid struct member");
            values.push_back(program_.load(program_.var(program_.expr(value).type, value)));
        }
    } else if (node->kind == Kind::Body && node->args.size() == 1) {
        auto schema = node->args[0];
        while (schema && (schema->kind == Kind::Call || schema->kind == Kind::Body) && schema->args.size() == 1)
            schema = schema->args[0];
        if (!schema || schema->kind != Kind::Struct) throw std::runtime_error("TN_TSL_STRUCT_RETURN_TYPE: expected a struct result");
        const auto previousReturns = std::move(aggregateReturns_);
        const VarId previousDone = doneVar_, previousReturn = returnVar_;
        const bool previousReturned = returned_;
        returned_ = false;
        aggregateReturns_.clear(); returnVar_ = noVar;
        doneVar_ = program_.var(Type::boolean(), program_.constant(false));
        for (const auto& [name, type] : schema->members)
            aggregateReturns_.push_back(program_.var(type, convert(program_.constant(0.0f), type)));
        statements(node->body);
        program_.If(program_.equal(program_.load(doneVar_), program_.constant(false)), [&] {
            exprs_.clear();
            const auto final = aggregate(node->args[0]);
            for (size_t i = 0; i < final.size(); ++i) program_.assign(aggregateReturns_.at(i), final[i]);
        });
        for (const auto slot : aggregateReturns_) values.push_back(program_.load(slot));
        aggregateReturns_ = previousReturns; doneVar_ = previousDone; returnVar_ = previousReturn;
        returned_ = previousReturned;
    } else {
        throw std::runtime_error("TN_TSL_STRUCT_RETURN_TYPE: expected a struct result");
    }
    if (node->kind != Kind::Struct) aggregates_[node.get()] = values;
    return values;
}

ExprId Lowerer::emit(Node node) {
    const NodeData& d = *node;
    if (d.kind == Kind::PositionLocal || d.kind == Kind::Varying || d.kind == Kind::Attribute) {
        const auto input = inputs_.find(d.kind == Kind::PositionLocal ? "positionLocal" : d.name);
        if (input != inputs_.end())
            return convert(input->second, d.type);
    }
    switch (d.kind) {
        case Kind::AtomicAdd: {
            const auto& target = *d.args[0];
            return program_.atomicAdd(ensureStorage(target), index(d.args[0]), convert(expression(d.args[1]), target.type));
        }
        case Kind::AtomicStore: throw std::runtime_error("atomicStore has no return value");
        case Kind::WgslFunction: throw std::runtime_error("wgslFn must be called before use");
        case Kind::WgslCall: {
            const auto& function = *d.args[0];
            std::vector<Type> inputs; std::vector<ExprId> arguments;
            for (const auto& [name, type] : function.members) inputs.push_back(type);
            for (size_t i = 1; i < d.args.size(); ++i) arguments.push_back(convert(expression(d.args[i]), inputs.at(i - 1)));
            return program_.authoredCall(function.name, function.lanes, function.type, inputs, arguments);
        }
        case Kind::StructMember: return aggregate(d.args[0]).at(d.bits);
        case Kind::PipelineOutput: return expression(d.args[0]);
        case Kind::RenderOutput: {
            auto tone = toneMapping_;
            if (d.bits) {
                static const std::map<uint64_t, std::optional<ToneMapping>> mappings{
                    {1, std::nullopt}, {2, ToneMapping::Linear}, {3, ToneMapping::Reinhard},
                    {4, ToneMapping::Cineon}, {5, ToneMapping::ACESFilmic}, {6, ToneMapping::Custom}, {7, ToneMapping::AgX}, {8, ToneMapping::Neutral}};
                tone = mappings.at(d.bits);
            }
            return renderOutput(program_, expression(d.args[0]), tone, d.name.empty() ? srgb_ : d.name == "srgb", custom_);
        }
        case Kind::Body: {
            const auto lowered = bodyScope_.find(node.get());
            if (lowered == bodyScope_.end() || std::find(scopes_.begin(), scopes_.end(), lowered->second) == scopes_.end()) {
                statements(d.body);
                bodyScope_[node.get()] = scopes_.back();
            }
            exprs_.clear();
            if (d.args.empty()) return kInvalid;
            if (returnVar_ == noVar) return expression(d.args[0]);
            program_.If(program_.equal(program_.load(doneVar_), program_.constant(false)), inScope([this, &d] {
                exprs_.clear(); const ExprId result = expression(d.args[0]);
                program_.assign(returnVar_, result == kInvalid || returnType_.scalar == Type::Scalar::Void || program_.expr(result).type == returnType_
                    ? result : convert(result, returnType_));
            }));
            return program_.load(returnVar_);
        }
        case Kind::Call: {
            Lowerer invocation(program_, inputs_, toneMapping_, srgb_, custom_);
            invocation.vars_ = vars_; invocation.loopIndex_ = loopIndex_;
            invocation.analyze(d.args.at(0));
            invocation.returnType_ = d.type;
            invocation.doneVar_ = program_.var(Type::boolean(), program_.constant(false));
            const ExprId result = invocation.expression(d.args.at(0));
            const ExprId value = invocation.returnVar_ == noVar ? result : program_.load(invocation.returnVar_);
            return value != kInvalid && d.type.scalar != Type::Scalar::Void ? convert(value, d.type) : value;
        }
        case Kind::Var: { const auto variable = ensureVar(node); return variable == noVar ? kInvalid : program_.load(variable); }
        case Kind::RenderTexture:
            // A third argument is an explicit level (`.level(n)`), so the read is legal under divergent control flow.
            return d.args.size() > 2
                       ? program_.sampleLevel(program_.texture2d(d.name), expression(d.args[1]), expression(d.args[2]))
                       : program_.sample(program_.texture2d(d.name), expression(d.args[1]));
        case Kind::TextureSize:
            return program_.textureSize(d.name == "depth" ? program_.textureDepth(d.name) : program_.texture2d(d.name), d.args.empty() ? program_.constant(int32_t(0)) : expression(d.args[0]));
        case Kind::StorageTexture:
            if (d.args.empty()) throw std::runtime_error("storageTexture requires coordinates when read");
            return program_.textureLoad(program_.texture2d(d.name), convert(expression(d.args[0]), Type::vec(2, Type::Scalar::I32)), program_.constant(int32_t(0)));
        case Kind::TextureLoad: {
            const auto loaded = program_.textureLoad(d.bits == 1 || d.name == "depth" ? program_.textureDepth(d.name) : program_.texture2d(d.name), expression(d.args[0]), d.args.size() < 2 ? program_.constant(int32_t(0)) : expression(d.args[1]));
            return d.name == "depth" ? convert(loaded, d.type == Type{} ? Type::vec(4) : d.type) : loaded;
        }
        case Kind::Constant:
            if (d.type.scalar == Type::Scalar::F32)
                return program_.constant(std::bit_cast<float>(static_cast<uint32_t>(d.bits)));
            if (d.type.scalar == Type::Scalar::I32) return program_.constant(static_cast<int32_t>(d.bits));
            if (d.type.scalar == Type::Scalar::Bool) return program_.constant(d.bits != 0);
            return kInvalid;
        case Kind::Uniform: {
            if (d.bits == 1)
                if (const auto input = inputs_.find("material:" + d.name); input != inputs_.end())
                    return convert(input->second, d.type);
            return program_.uniform(d.name, d.type);
        }
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
            // IndexNode carries vertex-only indices to fragments through a flat varying.
            if (program_.stage() == Stage::Fragment && (d.name == "instanceIndex" || d.name == "vertexIndex"))
                return program_.varying(d.name, Type::u32());
            return d.name == "instanceIndex" ? tsl::instanceIndex().id : program_.builtin(d.name);
        case Kind::PositionLocal: return tsl::positionLocal().id;
        case Kind::Unary: return d.unary == UnOp::Negate ? program_.neg(expression(d.args[0])) : kInvalid;
        case Kind::Binary: {
            ExprId a = expression(d.args[0]);
            ExprId b = expression(d.args[1]);
            if (a == kInvalid || b == kInvalid) return kInvalid;
            {
                // r185 types a JS number from the other operand: `uint.mul(1000)` is a uint. A scalar float constant
                // with a whole value beside an integer scalar takes that integer type.
                const auto literal = [&](ExprId id, Type other) {
                    const auto& e = program_.expr(id);
                    const bool whole = e.op == Op::Constant && e.type == Type::f32() &&
                                       std::bit_cast<float>(static_cast<uint32_t>(e.immediate)) == std::floor(std::bit_cast<float>(static_cast<uint32_t>(e.immediate)));
                    return whole && other.isScalar() && (other.scalar == Type::Scalar::U32 || other.scalar == Type::Scalar::I32);
                };
                const auto at = program_.expr(a).type, bt = program_.expr(b).type;
                if (d.args[1]->kind == Kind::Constant && literal(b, at)) b = program_.construct(at, {b});
                else if (d.args[0]->kind == Kind::Constant && literal(a, bt)) a = program_.construct(bt, {a});
            }
            if (d.bits == 1) {
                auto at = program_.expr(a).type, bt = program_.expr(b).type;
                if (at.numeric() && bt.numeric() && !at.isMatrix() && !bt.isMatrix() && at.scalar != bt.scalar) {
                    const bool compare = d.binary == BinOp::Less || d.binary == BinOp::Greater || d.binary == BinOp::Equal ||
                                         d.binary == BinOp::LessEqual || d.binary == BinOp::GreaterEqual;
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
                case BinOp::LessEqual: return program_.call("lessEqual", {a, b});
                case BinOp::GreaterEqual: return program_.call("greaterEqual", {a, b});
                case BinOp::ShiftRight: return program_.shiftRight(a, b);
                case BinOp::BitXor: return program_.bitXor(a, b);
            }
            return kInvalid;
        }
        case Kind::Math: {
            std::vector<ExprId> ids;
            for (const Node& arg : d.args) ids.push_back(expression(arg));
            const bool pairwise = d.name == "min" || d.name == "max" || d.name == "pow" || d.name == "step" || d.name == "mod";
            if (ids.size() == 2 && pairwise) {
                if (ids[0] == kInvalid || ids[1] == kInvalid) return kInvalid;
                // r185 types a whole JS divisor from the integer index, as the binary operators do.
                if (d.name == "mod" && d.args[1]->kind == Kind::Constant) {
                    const auto& divisor = program_.expr(ids[1]);
                    const Type index = program_.expr(ids[0]).type;
                    const float value = std::bit_cast<float>(static_cast<uint32_t>(divisor.immediate));
                    if (divisor.op == Op::Constant && divisor.type == Type::f32() && value == std::floor(value) &&
                        index.isScalar() && (index.scalar == Type::Scalar::U32 || index.scalar == Type::Scalar::I32))
                        ids[1] = program_.construct(index, {ids[1]});
                }
                const auto a = program_.expr(ids[0]).type, b = program_.expr(ids[1]).type;
                // A serialized graph converts any mismatch; an authored one only widens a float scalar to the other
                // operand's lanes (TSL's mod(vec2, float)), so a real type error still reports.
                const bool widen = a.scalar == Type::Scalar::F32 && b.scalar == Type::Scalar::F32 && !a.isMatrix() && !b.isMatrix() &&
                                   (a.isScalar() || b.isScalar());
                if (d.bits == 1 || widen) {
                    const auto target = a.rows >= b.rows ? a : b;
                    for (auto& id : ids) if (program_.expr(id).type != target) id = convert(id, target);
                }
            }
            return program_.call(d.name, ids);
        }
        case Kind::Swizzle: return program_.swizzle(expression(d.args[0]), d.lanes);
        case Kind::Join: {
            std::vector<ExprId> ids;
            for (const Node& part : d.args) {
                const auto value = expression(part);
                ids.push_back(d.type.scalar == Type::Scalar::U32 && value != kInvalid
                    ? convert(value, Type::vec(program_.expr(value).type.rows, Type::Scalar::U32)) : value);
            }
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
            if (input != inputs_.end())
                return convert(input->second, d.type);
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
            // A depth texture, or the scene pass's own depth (a texture named "depth" with no object
            // behind it), has no filtered sample: read the texel under the uv.
            if (d.bits == 1 || (d.name == "depth" && !d.textureBinding)) {
                const auto texture = program_.textureDepth(d.name);
                const auto size = program_.textureSize(texture, program_.constant(int32_t(0)));
                const auto extent = program_.construct(Type::vec(2), {size});
                const auto clamped = program_.call("clamp", {program_.mul(coordinate, extent), program_.constant(0.0f),
                    program_.sub(extent, program_.construct(Type::vec(2), {program_.constant(1.0f)}))});
                const auto texel = program_.construct(Type::vec(2, Type::Scalar::I32), {clamped});
                const auto loaded = program_.textureLoad(texture, texel, program_.constant(int32_t(0)));
                return d.bits == 1 ? loaded : convert(loaded, d.type == Type{} ? Type::vec(4) : d.type);
            }
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
            return program_.loadStorage(ensureStorage(d), index(node));
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
    if (initial == kInvalid) {
        // A var over a void call (a TSL function body with no result) has no value, but the call's statements are emitted:
        // remember that, or the next use of the var lowers the call again.
        vars_.emplace(var.get(), noVar);
        return noVar;
    }
    const VarId id = program_.var(var->type.scalar == Type::Scalar::Void ? program_.expr(initial).type : var->type, initial);
    vars_.emplace(var.get(), id);
    return id;
}

uint32_t Lowerer::ensureStorage(const NodeData& element) {
    return program_.storageBuffer(element.name, element.type, element.atomic ? *element.atomic : element.bits == 1);
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
        case Kind::Call: case Kind::AtomicAdd: (void)expression(node); return;
        case Kind::TextureStore: {
            const auto* texture = static_cast<const tn::engine::Texture*>(s.object.get());
            program_.textureStore(program_.storageTexture2d(s.name, texture->storageFormat()),
                                  convert(expression(s.args[0]), Type::vec(2, Type::Scalar::U32)),
                                  convert(expression(s.args[1]), Type::vec(4)));
            return;
        }
        case Kind::AtomicStore: {
            const auto& target = *s.args[0];
            program_.store(ensureStorage(target), index(s.args[0]), convert(expression(s.args[1]), target.type));
            return;
        }
        case Kind::Return: {
            returned_ = true;
            if (s.args.empty()) {
                if (doneVar_ != noVar) program_.assign(doneVar_, program_.constant(true));
                else program_.returnEarly();  // the kernel's own body: this invocation stops
                return;
            }
            if (!aggregateReturns_.empty()) {
                const auto values = aggregate(s.args[0]);
                if (values.size() != aggregateReturns_.size()) throw std::runtime_error("TN_TSL_STRUCT_RETURN_TYPE: incompatible early return");
                for (size_t i = 0; i < values.size(); ++i) program_.assign(aggregateReturns_[i], values[i]);
                program_.assign(doneVar_, program_.constant(true)); return;
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
                program_.store(buffer, index(target), convert(expression(s.args[1]), target->type));
            }
            return;
        }
        case Kind::If: {
            const ExprId condition = expression(s.args[0]);
            const auto previousAggregates = aggregates_;
            if (s.otherwise.empty()) {
                program_.If(condition, inScope([this, &s] { statements(s.body); }));
            } else {
                program_.If(condition, inScope([this, &s] { statements(s.body); }),
                            inScope([this, &s, &previousAggregates] { aggregates_ = previousAggregates; statements(s.otherwise); }));
            }
            aggregates_ = previousAggregates;
            return;
        }
        case Kind::Loop: {
            const ExprId count = expression(s.args[0]);
            const auto previousAggregates = aggregates_;
            const Node indexNode = s.args[1];
            program_.Loop(count, [this, &s, &indexNode](ExprId index) {
                scopes_.push_back(++scopeCount_);
                // start + index * step, in i32 (the count above already divided the range by the step).
                ExprId value = index;
                if (s.args.size() > 3) value = program_.mul(value, expression(s.args[3]));
                if (s.args.size() > 2) value = program_.add(value, expression(s.args[2]));
                if (indexNode->type != Type::i32()) value = convert(value, indexNode->type);  // Loop({ type: "uint" })
                loopIndex_[indexNode.get()] = value;
                statements(s.body);
                scopes_.pop_back();
            });
            aggregates_ = previousAggregates;
            return;
        }
        default: return;
    }
}

void Lowerer::statements(const std::vector<Node>& list) {
    for (size_t i = 0; i < list.size(); ++i) {
        if (doneVar_ != noVar && returned_) {
            // One guarded tail keeps consecutive statements in the same lexical scope.
            returned_ = false;
            program_.If(program_.equal(program_.load(doneVar_), program_.constant(false)), inScope([this, &list, i] {
                statements(std::vector<Node>(list.begin() + i, list.end()));
            }));
            returned_ = true;
            return;
        }
        exprs_.clear(); // live reads observe assignments; shared temporaries survive in temps_
        statement(list[i]);
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
Node lessThanEqual(Node a, Node b) { return makeBinary(BinOp::LessEqual, std::move(a), std::move(b)); }
Node greaterThanEqual(Node a, Node b) { return makeBinary(BinOp::GreaterEqual, std::move(a), std::move(b)); }

Node logicalAnd(Node a, Node b) { return makeMath("and", {std::move(a), std::move(b)}); }
Node logicalOr(Node a, Node b) { return makeMath("or", {std::move(a), std::move(b)}); }
Node logicalNot(Node a) { return makeMath("not", {std::move(a)}); }

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
    data->bits = std::static_pointer_cast<const tn::engine::Texture>(texture)->depthTexture ? 1 : 0;
    data->textureBinding = std::make_shared<TextureBinding>(TextureBinding{std::move(texture)});
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

Node uniform(std::string_view name, Type type, std::vector<double> values) {
    auto data = makeNode(Kind::Uniform, type);
    data->name = std::string(name);
    data->values = std::move(values);
    if (type.scalar == Type::Scalar::I32 || type.scalar == Type::Scalar::U32) {
        if (!data->values.empty()) setUniformValues(data, data->values);
    } else for (double& value : data->values) value = static_cast<float>(value);
    return data;
}
Node materialInput(std::string_view name, Type type) {
    auto data = makeNode(Kind::Uniform, type);
    data->name = std::string(name);
    data->bits = 1;  // marks the accessor; part of the structural key, so no authored uniform shares its program
    return data;
}
std::vector<std::string> materialInputs(const Node& graph) {
    std::vector<std::string> names;
    if (!graph) return names;
    for (const Node& n : uniformList(graph))
        if (n->bits == 1 && std::find(names.begin(), names.end(), n->name) == names.end()) names.push_back(n->name);
    return names;
}
void setUniformValues(const Node& uniform, std::vector<double> values) {
    if (!uniform || uniform->kind != Kind::Uniform) throw std::runtime_error("TN_TSL_UNIFORM_VALUE: not a uniform node");
    // A uniform built without a value (cameraViewMatrix, materialColor) is the engine's to fill.
    if (uniform->values.empty()) throw std::runtime_error("TN_TSL_UNIFORM_VALUE: " + uniform->name + " is engine-provided");
    const Type type = uniform->type;
    if (type.isMatrix() || type.scalar == Type::Scalar::Bool || values.size() != type.rows)
        throw std::runtime_error("TN_TSL_UNIFORM_VALUE: " + uniform->name + " takes " +
                                 std::to_string(type.rows) + " " + type.name() + " value(s)");
    for (double& value : values) {
        if (type.scalar == Type::Scalar::F32) value = static_cast<float>(value);
        else {
            const bool unsignedType = type.scalar == Type::Scalar::U32;
            const double minimum = unsignedType ? 0 : std::numeric_limits<int32_t>::min();
            const double maximum = unsignedType ? double(std::numeric_limits<uint32_t>::max()) : std::numeric_limits<int32_t>::max();
            if (!std::isfinite(value) || value != std::floor(value) || value < minimum || value > maximum)
                throw std::runtime_error("TN_TSL_UNIFORM_VALUE: " + uniform->name + " needs a whole number in " + type.name() + " range");
        }
    }
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
TN_GRAPH_UNARY(log)
TN_GRAPH_UNARY(normalize)
TN_GRAPH_UNARY(length)
TN_GRAPH_UNARY(dFdx)
TN_GRAPH_UNARY(dFdy)
TN_GRAPH_UNARY(sign)
TN_GRAPH_UNARY(atan)
TN_GRAPH_UNARY(fwidth)
TN_GRAPH_UNARY(all)
TN_GRAPH_UNARY(any)
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
    data->atomic = atomic;
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

Node computeNode(Node body, uint32_t count, uint32_t workgroupSize, std::string label) {
    if (!body || body->kind != Kind::Body)
        throw std::runtime_error("compute needs a function that makes statements: Fn(() => { ... })().compute(count)");
    if (count == 0) throw std::runtime_error("compute count must be positive");
    if (workgroupSize == 0 || workgroupSize > 256) throw std::runtime_error("compute workgroup size must be in [1, 256]");
    auto data = std::make_shared<NodeData>();
    data->kind = Kind::Compute;
    data->bits = count;
    data->width = workgroupSize;
    data->name = std::move(label);
    data->args = {std::move(body)};
    return data;
}

Node Block::node() const {
    auto data = std::make_shared<NodeData>();
    data->kind = Kind::Body;
    data->body = *blocks_.front();
    return data;
}

ExprId lower(const Graph& graph, Program& program, const std::unordered_map<std::string, ExprId>& inputs,
             std::optional<ToneMapping> toneMapping, bool srgb, Node custom) {
    if (!graph) return kInvalid;
    Lowerer lowerer(program, inputs, toneMapping, srgb, custom);
    lowerer.analyze(graph);
    return lowerer.expression(graph);
}

struct Lowering::Impl {
    std::unordered_map<std::string, ExprId> inputs;
    Lowerer lowerer;
    Impl(Program& program, std::unordered_map<std::string, ExprId> in, std::optional<ToneMapping> tone, bool srgb, Node custom)
        : inputs(std::move(in)), lowerer(program, inputs, tone, srgb, custom) {}
};

Lowering::Lowering(Program& program, std::unordered_map<std::string, ExprId> inputs,
                   std::optional<ToneMapping> toneMapping, bool srgb, Node custom)
    : impl_(std::make_unique<Impl>(program, std::move(inputs), toneMapping, srgb, custom)) {}
Lowering::~Lowering() = default;
ExprId Lowering::lower(const Graph& graph) {
    impl_->lowerer.analyze(graph);
    return graph ? impl_->lowerer.expression(graph) : kInvalid;
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
        out += n->atomic && *n->atomic ? "atomic;" : "plain;";
        for (const auto& [name, type] : n->members) { text(name); text(type.name()); }
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

std::map<std::string, std::vector<double>> uniforms(const Graph& graph) {
    std::map<std::string, std::vector<double>> result;
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
