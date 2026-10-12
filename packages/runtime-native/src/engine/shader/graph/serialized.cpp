#include "serialized.h"
#include "serialized_functions.h"
#include "engine/shader/tsl/tsl.h"
#include "post_effects.h"

#include "engine/foundation/json.h"

#include <bit>
#include <cmath>
#include <limits>
#include <unordered_set>

namespace tn::engine::shader::graph {
namespace {
using json::Value;

const Value empty;
const Value& field(const Value& v, const char* key) {
    const auto* result = v.find(key);
    return result ? *result : empty;
}

bool index(const Value& v, size_t size, size_t& out) {
    if (!v.isNumber() || !std::isfinite(v.number()) || v.number() < 0 ||
        v.number() != std::floor(v.number()) || v.number() >= static_cast<double>(size)) return false;
    out = static_cast<size_t>(v.number());
    return true;
}

Node boolNode(bool value) { auto n = std::make_shared<NodeData>(); n->type = Type::boolean(); n->bits = value; return n; }

Type type(const std::string& name) {
    if (name == "float") return Type::f32();
    if (name == "int") return Type::i32();
    if (name == "uint") return Type::u32();
    if (name == "bool") return Type::boolean();
    if (name == "color") return Type::vec(3);
    for (uint8_t n = 2; n <= 4; ++n) {
        const auto count = std::to_string(n);
        if (name == "vec" + count) return Type::vec(n);
        if (name == "ivec" + count) return Type::vec(n, Type::Scalar::I32);
        if (name == "uvec" + count) return Type::vec(n, Type::Scalar::U32);
        if (name == "bvec" + count) return Type::vec(n, Type::Scalar::Bool);
        if (name == "mat" + count) return Type::mat(n, n);
    }
    return {};
}

class Importer {
public:
    Importer(const std::vector<Value>& nodes, std::vector<std::string>& errors)
        : records_(nodes), errors_(errors), nodes_(nodes.size()), state_(nodes.size()) {}

    Node read(size_t id, size_t depth = 0) {
        if (state_[id] == 2) return nodes_[id];
        if (depth > 256) return fail("TN_TSL_EXPORT_INVALID: graph depth exceeds 256");
        const Value& record = records_[id];
        const std::string kind = field(record, "kind").string();
        if (kind == "TRAANode") {
            state_[id] = 2;
            return fail("TN_TEMPLATE_POST_PENDING: TRAANode (concurrent native port)");
        }
        // PassNode <-> its own texture is an intentional dependency cycle, not a shader DAG
        // cycle. A scene pass supplies inputs; it does not lower the scene into the post shader.
        if (kind == "PassNode" && field(record, "operation").isNull()) {
            state_[id] = 2; nodes_[id] = texture("scene", uv()); return nodes_[id];
        }
        if (kind == "UniformGroupNode") {
            state_[id] = 2; return {};
        }
        if (state_[id] == 1) return fail("TN_TSL_EXPORT_INVALID: cyclic " + kind);
        state_[id] = 1;
        std::vector<Node> args;
        const Value& argList = field(record, "args");
        const Value& dependencies = field(record, "dependencies");
        if (!record.isObject() || kind.empty() || !argList.isArray() || !dependencies.isArray())
            return fail("TN_TSL_EXPORT_INVALID: node " + std::to_string(id));
        for (const Value& arg : argList.items()) {
            size_t child = 0;
            if (!index(arg, records_.size(), child)) return fail("TN_TSL_EXPORT_INVALID: argument index");
            args.push_back(read(child, depth + 1));
        }
        for (const Value& arg : dependencies.items()) {
            size_t child = 0;
            if (!index(arg, records_.size(), child)) return fail("TN_TSL_EXPORT_INVALID: dependency index");
            read(child, depth + 1);
        }
        // A refused child poisons its parents. Name the missing child, not every ordinary
        // operator/VarNode above it in the graph.
        for (const Node& arg : args) {
            if (!arg) { state_[id] = 2; return {}; }
        }
        const std::string operation = field(record, "operation").string();
        auto list = [&](const char* key) {
            std::vector<Node> result;
            const auto& values = field(record, key);
            if (!values.isNull() && !values.isArray()) { fail("TN_TSL_EXPORT_INVALID: statement list"); return result; }
            for (const auto& value : values.items()) {
                size_t child = 0;
                if (!index(value, records_.size(), child)) { fail("TN_TSL_EXPORT_INVALID: statement index"); break; }
                const auto statement = read(child, depth + 1);
                if (!statement) { fail("TN_TSL_EXPORT_INVALID: missing shader statement"); break; }
                result.push_back(statement);
            }
            return result;
        };
        Node result;
        auto arity = [&](size_t count) { return args.size() == count; };
        if (kind == "GTAONode" || kind == "DenoiseNode" || kind == "SMAANode")
            result = importPostEffect(record, args, errors_);
        else if ((result = importFunctionNode(record, args, list, errors_))) {}
        else if (kind == "ConstNode" || kind == "UniformNode") {
            const auto t = type(field(record, "type").string());
            const Value& value = field(record, "value");
            if (t.scalar == Type::Scalar::Void) return fail("TN_TSL_UNSUPPORTED: " + kind + " type");
            auto scalar = [&](const Value& v) -> Node {
                if (t.scalar == Type::Scalar::Bool && v.isBool()) {
                    auto n = std::make_shared<NodeData>(); n->type = Type::boolean(); n->bits = v.boolean(); return n;
                }
                if (!v.isNumber() || !std::isfinite(v.number())) return fail("TN_TSL_EXPORT_INVALID: constant");
                const double x = v.number();
                if (t.scalar == Type::Scalar::I32 || t.scalar == Type::Scalar::U32) {
                    const double lo = t.scalar == Type::Scalar::I32 ? std::numeric_limits<int32_t>::min() : 0;
                    const double hi = t.scalar == Type::Scalar::I32 ? std::numeric_limits<int32_t>::max() : std::numeric_limits<uint32_t>::max();
                    if (x != std::floor(x) || x < lo || x > hi) return fail("TN_TSL_EXPORT_INVALID: integer constant");
                    return t.scalar == Type::Scalar::I32 ? int_(static_cast<int32_t>(x)) : uint_(static_cast<uint32_t>(x));
                }
                if (!std::isfinite(static_cast<float>(x))) return fail("TN_TSL_EXPORT_INVALID: float constant");
                return float_(x);
            };
            if (kind == "UniformNode") {
                const std::string name = field(record, "name").string();
                if (name.empty()) return fail("TN_TSL_EXPORT_INVALID: uniform name");
                std::vector<float> values;
                const std::vector<Value> data = value.isArray() ? value.items() : std::vector<Value>{value};
                for (const auto& v : data) {
                    if (!scalar(v)) return {};
                    values.push_back(v.isBool() ? float(v.boolean()) : static_cast<float>(v.number()));
                }
                result = uniform(name, t, std::move(values));
            } else if (value.isArray()) {
                auto n = std::make_shared<NodeData>(); n->kind = Kind::Join; n->type = t;
                for (const auto& v : value.items()) n->args.push_back(scalar(v));
                result = n;
            } else result = scalar(value);
        } else if (kind == "OperatorNode" && arity(2)) {
            if (operation == "+") result = add(args[0], args[1]);
            else if (operation == "-") result = sub(args[0], args[1]);
            else if (operation == "*") result = mul(args[0], args[1]);
            else if (operation == "/") result = div(args[0], args[1]);
            else if (operation == "<") result = lessThan(args[0], args[1]);
            else if (operation == ">") result = greaterThan(args[0], args[1]);
            else if (operation == "==") result = equal(args[0], args[1]);
            else if (operation == "!=") result = equal(equal(args[0], args[1]), boolNode(false));
            else if (operation == "&&") result = select(args[0], args[1], boolNode(false));
            else if (operation == "||") result = select(args[0], boolNode(true), args[1]);
            else if (operation == ">=" || operation == "<=") {
                auto n = std::make_shared<NodeData>(); n->kind = Kind::Math; n->name = operation == ">=" ? "greaterEqual" : "lessEqual"; n->args = args; result = n;
            }
        } else if (kind == "OperatorNode" && arity(1) && operation == "!") result = equal(args[0], boolNode(false));
        else if (kind == "MathNode" && !args.empty()) {
            if ((operation == "mix" || operation == "clamp" || operation == "smoothstep") && !arity(3))
                return fail("TN_TSL_EXPORT_INVALID: MathNode/" + operation + " requires three operands");
            if (operation == "negate" && arity(1)) result = negate(args[0]);
            else if (operation == "oneMinus" && arity(1)) result = sub(float_(1), args[0]);
            else if (operation == "saturate" && arity(1)) result = clamp(args[0], float_(0), float_(1));
            else {
                auto n = std::make_shared<NodeData>(); n->kind = Kind::Math; n->name = operation; n->args = args; result = n;
            }
        } else if (kind == "SplitNode" && arity(1)) result = swizzle(args[0], field(record, "lanes").string());
        else if ((kind == "JoinNode" && !args.empty()) || (kind == "ConvertNode" && arity(1))) {
            auto n = std::make_shared<NodeData>(); n->kind = kind == "JoinNode" ? Kind::Join : Kind::Convert;
            n->type = type(field(record, "type").string()); n->args = args; result = n;
        } else if (((kind == "VarNode" && (operation == "intent" || operation == "readOnly")) || (kind == "ContextNode" && operation.empty()) || kind == "SubBuildNode") && arity(1)) result = args[0];
        else if (kind == "AttributeNode" && args.empty()) {
            const auto name = field(record, "name").string();
            const auto t = type(field(record, "type").string());
            if (name.empty() || t.scalar == Type::Scalar::Void) return fail("TN_TSL_EXPORT_INVALID: attribute");
            result = attribute(name, t);
        }
        else if (kind == "UVNode" && field(record, "name").string() == "0") result = uv();
        else if (kind == "ScreenNode" && operation == "uv") result = uv();
        else if ((kind == "TextureNode" || kind == "PassTextureNode" || kind == "PassMultipleTextureNode") && ((args.size() <= 1 && operation.empty()) || (args.size() <= 2 && operation == "load"))) {
            const std::string name = field(record, "name").string();
            if (name.empty()) return fail("TN_TSL_EXPORT_INVALID: texture name");
            std::string resource = name == "output" ? "scene" : name;
            for (const auto& dependency : dependencies.items()) {
                size_t child = 0;
                if (index(dependency, records_.size(), child) && nodes_[child] && (nodes_[child]->kind == Kind::PostEffect || nodes_[child]->kind == Kind::RenderTexture)) resource = nodes_[child]->name;
            }
            auto sample = std::const_pointer_cast<NodeData>(texture(resource, args.empty() ? uv() : args[0]));
            if (operation == "load") {
                sample->kind = Kind::TextureLoad;
                if (args.empty()) {
                    auto coordinate = std::make_shared<NodeData>(); coordinate->kind = Kind::Join;
                    coordinate->type = Type::vec(2, Type::Scalar::I32); coordinate->args = {int_(0), int_(0)};
                    sample->args = {coordinate};
                } else sample->args = args;
            }
            for (const auto& dependency : dependencies.items()) {
                size_t child = 0;
                if (index(dependency, records_.size(), child) && nodes_[child] && nodes_[child]->kind == Kind::PostEffect) sample->args.push_back(nodes_[child]);
            }
            for (const auto& dependency : dependencies.items()) {
                size_t child = 0;
                if (index(dependency, records_.size(), child) && nodes_[child] && nodes_[child]->kind != Kind::PostEffect) sample->body.push_back(nodes_[child]);
            }
            result = sample;
        }
        if (!result) fail("TN_TSL_UNSUPPORTED: " + kind + (operation.empty() ? "" : "/" + operation));
        if (result && (kind == "OperatorNode" || kind == "MathNode")) {
            auto upstream = std::make_shared<NodeData>(*result); upstream->bits = 1; result = upstream;
        }
        if (result && kind == "PassNode" && operation == "post-material" && !field(record, "vertex").isNull()) {
            size_t vertex = 0;
            if (!index(field(record, "vertex"), records_.size(), vertex)) return fail("TN_TSL_EXPORT_INVALID: post vertex");
            auto authored = std::make_shared<NodeData>(*result); authored->otherwise = {read(vertex, depth + 1)}; result = authored;
        }
        if (result && (kind == "StackNode" || kind == "ShaderCall")) {
            auto typed = std::make_shared<NodeData>(*result);
            typed->type = kind == "StackNode" ? type(field(record, "type").string()) : args[0]->type;
            result = typed;
        }
        nodes_[id] = result;
        state_[id] = 2;
        return result;
    }
private:
    Node fail(std::string message) {
        if (seen_.insert(message).second) errors_.push_back(std::move(message));
        return {};
    }
    const std::vector<Value>& records_;
    std::vector<std::string>& errors_;
    std::vector<Node> nodes_;
    std::vector<uint8_t> state_;
    std::unordered_set<std::string> seen_;
};
} // namespace

PostNode serializedPost(Node root) {
    return {key(root), [root](Program& p, uint32_t, ExprId coordinate) {
        tsl::Build scope(p); return lower(root, p, {{"uv", coordinate}});
    }, postPasses(root), uniforms(root), uniformNodes(root)};
}

Graph importSerialized(std::string_view source, std::vector<std::string>& errors) {
    Value document;
    json::Error error;
    if (!json::parse(source, document, error)) {
        errors.push_back(error.code + ": " + error.detail); return {};
    }
    const auto& version = field(document, "version");
    const auto& nodes = field(document, "nodes");
    size_t root = 0;
    if (!version.isNumber() || version.number() != 1 || !nodes.isArray() || nodes.items().empty() ||
        nodes.items().size() > 100000 || !index(field(document, "root"), nodes.items().size(), root)) {
        errors.push_back("TN_TSL_EXPORT_INVALID: version, nodes or root"); return {};
    }
    Importer importer(nodes.items(), errors);
    const auto result = importer.read(root);
    if (!result && errors.empty()) errors.push_back("TN_TSL_UNSUPPORTED: " + field(nodes.items()[root], "kind").string());
    return errors.empty() ? result : Graph{};
}
} // namespace tn::engine::shader::graph
