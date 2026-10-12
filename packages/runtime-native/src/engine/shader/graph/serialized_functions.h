#pragma once
#include "engine/shader/graph/graph.h"
#include "engine/foundation/json.h"
#include <cmath>

namespace tn::engine::shader::graph {
// Kept separate from the concurrent screen-space effect dispatcher.
inline Node importFunctionNode(const json::Value& record, const std::vector<Node>& args,
                              const std::function<std::vector<Node>(const char*)>& list,
                              std::vector<std::string>& errors) {
    const auto field = [&](const char* key) -> const json::Value& {
        static const json::Value empty;
        const auto* value = record.find(key); return value ? *value : empty;
    };
    const std::string kind = field("kind").string();
    auto node = std::make_shared<NodeData>(); node->args = args;
    if (kind == "ShaderCall" && args.size() == 1) node->kind = Kind::Call;
    else if (kind == "StackNode" && args.size() <= 1) { node->kind = Kind::Body; node->body = list("body"); }
    else if (kind == "VarNode" && args.size() == 1) node->kind = Kind::Var;
    else if (kind == "AssignNode" && args.size() == 2) {
        const auto target = args[0];
        if (target->kind != Kind::Var && target->kind != Kind::StorageElement &&
            !(target->kind == Kind::Swizzle && !target->args.empty() && target->args[0]->kind == Kind::Var)) {
            errors.push_back("TN_TSL_EXPORT_INVALID: assignment target"); return {};
        }
        node->kind = Kind::Assign;
    }
    else if (kind == "LoopIndex" && args.empty()) { node->kind = Kind::LoopIndex; node->type = Type::i32(); }
    else if (kind == "LoopIndexReference" && args.size() == 1) return args[0];
    else if (kind == "LoopNode" && args.size() == 3) {
        node->kind = Kind::Loop; node->args = {sub(args[1], args[0]), args[2], args[0]};
        for (auto child : list("body")) {
            while (child && (child->kind == Kind::Call || child->kind == Kind::Var)) child = child->args[0];
            if (child && child->kind == Kind::Body) {
                node->body.insert(node->body.end(), child->body.begin(), child->body.end());
                if (!child->args.empty()) { auto ret = std::make_shared<NodeData>(); ret->kind = Kind::Return; ret->args = child->args; node->body.push_back(ret); }
            } else node->body.push_back(child);
        }
    } else if (kind == "ConditionalNode" && args.size() >= 2 && args.size() <= 3) {
        if (args[1]->kind != Kind::Call && args[1]->kind != Kind::Body && args.size() == 3)
            return select(args[0], args[1], args[2]);
        node->kind = Kind::If; node->args = {args[0]};
        const auto branch = [](Node n) {
            if (n->kind == Kind::Call) n = n->args[0];
            if (n->kind != Kind::Body) return std::vector<Node>{n};
            auto body = n->body;
            if (!n->args.empty()) {
                auto ret = std::make_shared<NodeData>(); ret->kind = Kind::Return; ret->args = n->args; body.push_back(ret);
            }
            return body;
        };
        node->body = branch(args[1]); if (args.size() == 3) node->otherwise = branch(args[2]);
    } else if ((kind == "RTTNode" || (kind == "PassNode" && field("operation").string() == "post-material")) && args.size() == 2) {
        const auto& scale = field("scale");
        if (!scale.isNumber() || !std::isfinite(scale.number()) || scale.number() <= 0 || scale.number() > 16) {
            errors.push_back("TN_TSL_EXPORT_INVALID: RTT scale"); return {};
        }
        node->kind = Kind::RenderTexture; node->name = field("name").string(); node->scale = scale.number();
        for (const char* dimension : {"width", "height"}) {
            const auto& value = field(dimension);
            if (value.isNull()) continue;
            if (!value.isNumber() || value.number() < 1 || value.number() > 16384 || value.number() != std::floor(value.number())) {
                errors.push_back("TN_TSL_EXPORT_INVALID: RTT dimensions"); return {};
            }
            (std::string(dimension) == "width" ? node->width : node->height) = static_cast<uint32_t>(value.number());
        }
        if (node->name.empty() || ((node->width == 0) != (node->height == 0))) {
            errors.push_back("TN_TSL_EXPORT_INVALID: RTT name/size"); return {};
        }
        node->bits = kind == "PassNode" ? 2 : field("operation").string() == "static" ? 1 : 0;
    } else if (kind == "ScreenNode" && field("operation").string() == "coordinate") return swizzle(builtin("position"), "xy");
    else if (kind == "ViewportDepthNode" && field("operation").string() == "depth") return swizzle(builtin("position"), "z");
    else if (kind == "TextureSizeNode" && args.size() >= 1 && args.size() <= 2) {
        if (args[0]->kind != Kind::Texture && args[0]->kind != Kind::TextureLoad && args[0]->kind != Kind::RenderTexture) {
            errors.push_back("TN_TSL_EXPORT_INVALID: textureSize input"); return {};
        }
        node->kind = Kind::TextureSize; node->name = args[0]->name;
        node->body = {args[0]}; node->args.clear(); if (args.size() == 2) node->args = {args[1]};
    } else if (kind == "ExpressionNode") {
        const auto operation = field("operation").string();
        if (operation == "continue") node->kind = Kind::Continue;
        else if (operation == "break") node->kind = Kind::Break;
        else if (operation == "return") node->kind = Kind::Return;
        else if (operation == "discard") node->kind = Kind::Discard;
        else return {};
    } else return {};
    return node;
}
} // namespace tn::engine::shader::graph
