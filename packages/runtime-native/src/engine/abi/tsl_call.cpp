// The TSL name table both language back ends call (PRD-540). Moved from the V8 adapter's
// Tsl::call unchanged: each case builds the graph node the upstream TSL call means.
#include "engine/abi/tsl_call.h"
#include "engine/scene/render_target.h"
#include "engine/scene/material.h"
#include "engine/scene/nodes.h"
#include "engine/renderer/reflector.h"
#include "engine/scene/texture.h"
#include "engine/scene/lights.h"

#include "engine/foundation/math/Color.h"
#include "engine/shader/graph/post_effects.h"

#include <algorithm>
#include <bit>
#include <cmath>
#include <functional>
#include <limits>
#include <stdexcept>

namespace tn::abi {
namespace g = engine::shader::graph;
using engine::shader::Type;

namespace {
double number(const TslArg& value) {
    if (value.kind != TslArg::Kind::Number || !std::isfinite(value.number))
        throw std::runtime_error("expected a finite number");
    return value.number;
}

const std::string& text(const TslArg& value) {
    if (value.kind != TslArg::Kind::String) throw std::runtime_error("expected a string");
    return value.text;
}

Type type(const std::string& name) {
    if (name == "bool") return Type::boolean();
    if (name == "float") return Type::f32();
    if (name == "int") return Type::i32();
    if (name == "uint") return Type::u32();
    if (name == "vec2") return Type::vec(2);
    if (name == "vec3") return Type::vec(3);
    if (name == "vec4") return Type::vec(4);
    for (int lanes = 2; lanes <= 4; ++lanes) {
        if (name == "uvec" + std::to_string(lanes)) return Type::vec(lanes, Type::Scalar::U32);
        if (name == "ivec" + std::to_string(lanes)) return Type::vec(lanes, Type::Scalar::I32);
    }
    if (name == "mat3") return Type::mat(3, 3);
    if (name == "mat4") return Type::mat(4, 4);
    throw std::runtime_error("unsupported TSL type: " + name);
}

/** A TSL operand: a node (a variable reads its value), a number as a float constant, or a three
 * Color or VectorN as its vector constant, as TSL's nodeObject makes of it. */
g::Node input(const TslArg& value) {
    if (value.kind == TslArg::Kind::Number) return g::float_(number(value));
    if (value.kind == TslArg::Kind::Rgb || value.kind == TslArg::Kind::Vector) {
        std::vector<g::Node> lanes;
        for (uint8_t i = 0; i < value.lanes; ++i) {
            if (!std::isfinite(value.numbers[i])) throw std::runtime_error("expected a finite number");
            lanes.push_back(g::float_(value.numbers[i]));
        }
        if (lanes.size() == 2) return g::vec2({lanes[0], lanes[1]});
        if (lanes.size() == 3) return g::vec3({lanes[0], lanes[1], lanes[2]});
        if (lanes.size() == 4) return g::vec4({lanes[0], lanes[1], lanes[2], lanes[3]});
        throw std::runtime_error("a vector has 2, 3 or 4 lanes");
    }
    if (value.kind != TslArg::Kind::Node || !value.node) throw std::runtime_error("expected a TSL node or number");
    return value.node->kind == g::Kind::Var ? g::Var{value.node, value.node->type}.read() : value.node;
}
}  // namespace

g::Node tslCall(const std::string& name, const TslArg* receiver, const std::vector<TslArg>& args, uint64_t& serial) {
    const bool method = receiver != nullptr;
    const auto arity = [&](size_t n) {
        if (args.size() != n) throw std::runtime_error("expected " + std::to_string(n) + " arguments");
    };
    const auto arg = [&](size_t i) { return input(args.at(i)); };
    const auto lhs = [&] { return method ? input(*receiver) : arg(0); };
    const auto rhs = [&] { return arg(method ? 0 : 1); };
    // three's convertToTexture: a texture stays as it is; any other node renders to a texture of its own.
    const auto toTexture = [&](const g::Node& source) -> g::Node {
        if (source->kind == g::Kind::Texture || source->kind == g::Kind::RenderTexture) return source;
        auto target = std::make_shared<g::NodeData>();
        target->kind = g::Kind::RenderTexture;
        target->name = "native_rtt_" + std::to_string(++serial);
        target->type = Type::vec(4);
        target->args = {source, g::uv()};
        return target;
    };

    if (!method && name == "toneMappingColor") {
        arity(0);
        return g::varying("tnToneMappingColor", Type::vec(3));
    }
    if (!method && name == "lightShadowMatrix") {
        arity(1);
        if (args[0].kind != TslArg::Kind::Object || !args[0].object ||
            (args[0].cls != "DirectionalLight" && args[0].cls != "SpotLight" && args[0].cls != "PointLight"))
            throw std::runtime_error("lightShadowMatrix requires a shadow-casting light");
        const auto light = std::static_pointer_cast<const engine::Light>(args[0].object);
        auto node = std::make_shared<g::NodeData>(); node->kind = g::Kind::Uniform;
        node->type = Type::mat(4, 4); node->object = light;
        node->name = "authoredLightShadowMatrix" + std::to_string(light->id());
        return node;
    }
    if (!method && name == "wgslFunction") {
        if (args.size() < 3 || args.size() > 7) throw std::runtime_error("wgslFn requires source, name, result type and up to four input types");
        auto function = std::make_shared<g::NodeData>();
        function->kind = g::Kind::WgslFunction;
        function->lanes = text(args[0]); function->name = text(args[1]); function->type = type(text(args[2]));
        if (function->name.empty() || function->name.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_") != std::string::npos ||
            function->name[0] >= '0' && function->name[0] <= '9') throw std::runtime_error("invalid WGSL function name");
        for (size_t i = 3; i < args.size(); ++i) function->members.emplace_back(std::to_string(i - 3), type(text(args[i])));
        return function;
    }
    if (method && name == "invoke") {
        const auto function = receiver->node;
        if (!function || function->kind != g::Kind::WgslFunction || args.size() != function->members.size())
            throw std::runtime_error("wgslFn arguments do not match its declaration");
        auto call = std::make_shared<g::NodeData>(); call->kind = g::Kind::WgslCall; call->type = function->type;
        call->args = {function};
        for (size_t i = 0; i < args.size(); ++i) call->args.push_back(arg(i));
        return call;
    }
    if (!method && name == "struct") {
        if (args.size() < 3 || args.size() % 2 != 1)
            throw std::runtime_error("struct needs a name and member/type pairs");
        auto schema = std::make_shared<g::NodeData>();
        schema->kind = g::Kind::StructType;
        schema->name = text(args[0]);
        for (size_t i = 1; i < args.size(); i += 2) {
            const auto& member = text(args[i]);
            if (member.empty() || member.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_") != std::string::npos ||
                (member[0] >= '0' && member[0] <= '9'))
                throw std::runtime_error("struct: invalid member name");
            for (const auto& existing : schema->members)
                if (existing.first == member) throw std::runtime_error("struct: duplicate member " + member);
            schema->members.emplace_back(member, type(text(args[i + 1])));
        }
        return schema;
    }
    if (method && (name == "struct:new" || name == "newStruct")) {
        const auto& schema = receiver->node;
        if (!schema || schema->kind != g::Kind::StructType)
            throw std::runtime_error("struct:new needs a struct type");
        if (!args.empty() && args.size() != schema->members.size())
            throw std::runtime_error("struct:new needs one value per member");
        auto value = std::make_shared<g::NodeData>(*schema);
        value->kind = g::Kind::Struct;
        for (size_t i = 0; i < schema->members.size(); ++i) {
            auto converted = std::make_shared<g::NodeData>();
            converted->kind = g::Kind::Convert;
            converted->type = schema->members[i].second;
            converted->args = {args.empty() ? g::float_(0) : arg(i)};
            value->args.push_back(converted);
        }
        return value;
    }
    if (method && (name == "struct:get" || name == "get")) {
        arity(1);
        const auto& value = receiver->node;
        auto schema = value;
        while (schema && (schema->kind == g::Kind::Body || schema->kind == g::Kind::Call) && schema->args.size() == 1)
            schema = schema->args[0];
        if (!schema || schema->kind != g::Kind::Struct)
            throw std::runtime_error("TN_NATIVE_STRUCT_AGGREGATE_UNBOUND: get requires a direct struct or final Body value; callable and early aggregate returns need member return slots");
        for (size_t i = 0; i < schema->members.size(); ++i) {
            if (schema->members[i].first != text(args[0])) continue;
            if (value->kind == g::Kind::Struct) return value->args.at(i);
            auto selected = std::make_shared<g::NodeData>();
            selected->kind = g::Kind::StructMember;
            selected->type = schema->members[i].second;
            selected->bits = i;
            selected->args = {value};
            return selected;
        }
        throw std::runtime_error("struct:get: unknown member " + text(args[0]));
    }

    if (method && name == "element") {
        arity(1);
        const auto matrix = lhs();
        if (matrix->type != Type::mat(4, 4)) throw std::runtime_error("element needs a mat4 node");
        if (args[0].kind == TslArg::Kind::Number &&
            (number(args[0]) < 0 || number(args[0]) > 3 || number(args[0]) != std::floor(number(args[0]))))
            throw std::runtime_error("mat4 element index must be an integer in [0, 3]");
        const auto index = g::uint_(arg(0));
        const auto lane = [&](uint32_t column) {
            return g::select(g::equal(index, g::uint_(column)), g::float_(1), g::float_(0));
        };
        return g::mul(matrix, g::vec4({lane(0), lane(1), lane(2), lane(3)}));
    }

    // PRD-540 (Wasm wrappers): the calls a back end without native wrappers makes by name.
    if (!method && name.rfind("constant:", 0) == 0) {
        arity(0);
        for (auto& [label, node] : tslConstants())
            if (label == name.substr(9)) return node;
        return {};
    }
    // TSL storage(attribute, type, count).element(index): the attribute's own data, bound under the
    // label setName gave it or, unnamed, one derived from the attribute (StorageBufferNode r185).
    if (!method && name == "storage:object") {
        if (args.size() != 4 && args.size() != 5) throw std::runtime_error("storage needs an attribute, type, label, index and an optional atomic flag");
        if (args[0].kind != TslArg::Kind::Object || args[0].cls.find("BufferAttribute") == std::string::npos ||
            !args[0].object)
            throw std::runtime_error("storage needs an engine BufferAttribute");
        std::string label = text(args[2]);
        if (label.empty()) label = "nodeStorage" + std::to_string(reinterpret_cast<uintptr_t>(args[0].object.get()));
        g::Storage buffer = g::storage(label, type(text(args[1])));
        buffer.object = args[0].object;
        if (args.size() == 5) *buffer.atomic = number(args[4]) != 0;
        return buffer.element(arg(3));
    }
    // r185's atomicLoad(element): the element of a toAtomic buffer; a read of one lowers to WGSL's atomicLoad.
    if (!method && name == "atomicLoad") {
        arity(1);
        const auto target = arg(0);
        if (!target || target->kind != g::Kind::StorageElement || !target->atomic || !*target->atomic ||
            (target->type != Type::u32() && target->type != Type::i32()))
            throw std::runtime_error("atomicLoad requires an integer element of a toAtomic storage buffer");
        return target;
    }
    if (method && name == "storage:atomic") {
        arity(0); const auto node = receiver->node;
        if (!node || node->kind != g::Kind::StorageElement || !node->atomic ||
            (node->type != Type::u32() && node->type != Type::i32())) throw std::runtime_error("toAtomic requires int or uint storage");
        *node->atomic = true; return node;
    }
    if (!method && name == "storage:element") {  // instancedArray(n, type).setName(name).element(index)
        if (args.size() != 3 && args.size() != 4) throw std::runtime_error("storage element needs name, type, index and optional atomic flag");
        if (text(args[0]).empty()) throw std::runtime_error("storage buffer needs setName");
        auto storage = g::storage(text(args[0]), type(text(args[1])));
        if (args.size() == 4) *storage.atomic = number(args[3]) != 0;
        return storage.element(arg(2));
    }
    if (method && name == "setName") {  // a uniform under the name a material binds; the data stays
        arity(1);
        const auto& self = receiver->node;
        if (text(args[0]).empty()) throw std::runtime_error("empty name");
        if (self && self->kind == g::Kind::Compute)  // a compute node's label names it in a refusal
            return g::computeNode(self->args[0], self->bits, self->width, text(args[0]));
        if (!self || self->kind != g::Kind::Uniform) throw std::runtime_error("setName requires a uniform, a compute node or a storage buffer");
        return g::uniform(text(args[0]), self->type, self->values);
    }
    if (name == "nodeObject") {
        arity(1);
        return arg(0);
    }
    // r185's uniform(...).setGroup(group) and texture(...).setGroup(group): how often three uploads the
    // node. The engine reads every graph uniform and texture each frame, so the node is unchanged;
    // frameGroup, renderGroup and objectGroup are the markers it takes.
    if (method && name == "setGroup") {
        arity(1);
        if (!receiver->node || (receiver->node->kind != g::Kind::Uniform && receiver->node->kind != g::Kind::Texture))
            throw std::runtime_error("setGroup requires a uniform or a texture");
        return receiver->node;
    }
    // r185's property(type, name): a declared variable with no value of its own, which WGSL starts at
    // zero; `.toVar()` then names it. A float or float vector only.
    if (!method && name == "property") {
        if (args.empty() || args.size() > 2) throw std::runtime_error("property takes a type and an optional name");
        const Type wanted = type(text(args[0]));
        const auto zero = g::float_(0);
        if (wanted == Type::f32()) return zero;
        if (wanted == Type::vec(2)) return g::vec2({zero});
        if (wanted == Type::vec(3)) return g::vec3({zero});
        if (wanted == Type::vec(4)) return g::vec4({zero});
        throw std::runtime_error("property: unsupported type " + text(args[0]));
    }
    // r185's transformNormalToView(normal) outside a material's normal setup:
    // transformNormalByViewMatrix(modelNormalMatrix * normal, cameraViewMatrix).
    if (!method && name == "transformNormalToView") {
        arity(1);
        const auto transformed = g::mul(g::uniform("modelNormalMatrix", Type::mat(3, 3)), arg(0));
        return g::normalize(g::swizzle(g::mul(g::uniform("viewMatrix", Type::mat(4, 4)), g::vec4({transformed, g::float_(0)})), "xyz"));
    }
    // r185's getViewPosition(screenPosition, depth, projectionMatrixInverse), WebGPU's branch:
    // vec4(vec3(vec2(uv.x, uv.y.oneMinus()).mul(2).sub(1), depth), 1), then view.xyz / view.w.
    if (!method && name == "getViewPosition") {
        arity(3);
        const auto uv = arg(0);
        const auto screen = g::sub(g::mul(g::vec2({g::swizzle(uv, "x"), g::sub(g::float_(1), g::swizzle(uv, "y"))}),
                                          g::float_(2)), g::float_(1));
        const auto view = g::mul(arg(2), g::vec4({g::vec3({screen, arg(1)}), g::float_(1)}));
        return g::div(g::swizzle(view, "xyz"), g::swizzle(view, "w"));
    }
    // three r185's post addons, built live as the engine's effects (PRD-531 slice 4): ao(depth, normal,
    // camera), denoise(input, depth, normal, camera), smaa(input), bloom(input, strength, radius,
    // threshold). The camera three takes is the render camera here: a pass reads its matrices each
    // frame. A missing normal (null) derives normals from depth, as three does.
    if (name == "ssr") {
        arity(5);
        const auto optional = [&](size_t i) { return args[i].kind == TslArg::Kind::Other ? g::Node{} : arg(i); };
        return g::effectNode(g::ssrEffect(arg(0), arg(1), arg(2), optional(3), optional(4)));
    }
    if (name == "ao" || name == "denoise") {
        const bool denoise = name == "denoise";
        if (args.size() < (denoise ? 3u : 2u)) throw std::runtime_error("expected the effect's texture inputs");
        const auto optional = [&](size_t i) { return args[i].kind == TslArg::Kind::Node ? arg(i) : g::Node{}; };
        // three's denoise converts its input itself (DenoiseNode.js: convertToTexture(node)).
        const auto effect = denoise ? g::denoiseEffect(toTexture(arg(0)), arg(1), optional(2), static_cast<uint32_t>(++serial))
                                    : g::gtaoEffect(arg(0), optional(1));
        return g::effectNode(effect);
    }
    if (name == "pipelineOutput") {
        arity(2);
        auto node = std::make_shared<g::NodeData>();
        node->kind = g::Kind::PipelineOutput;
        node->args = {arg(0)};
        const double enabled = number(args[1]);
        if (enabled != 0 && enabled != 1) throw std::runtime_error("pipelineOutput requires a boolean flag");
        node->bits = static_cast<uint64_t>(enabled);
        return node;
    }
    if (name == "renderOutput") {
        const size_t count = args.size() + (method ? 1 : 0);
        if (count < 1 || count > 3) throw std::runtime_error("renderOutput takes color, optional tone mapping and output color space");
        auto node = std::make_shared<g::NodeData>();
        node->kind = g::Kind::RenderOutput;
        node->args = {lhs()};
        const size_t offset = method ? 0 : 1;
        if (args.size() > offset && args[offset].kind != TslArg::Kind::Other) {
            const double tone = number(args[offset]);
            if (tone != 0 && tone != 1 && tone != 2 && tone != 3 && tone != 4 && tone != 5 && tone != 6 && tone != 7)
                throw std::runtime_error("renderOutput: unsupported toneMapping " + std::to_string(tone));
            node->bits = static_cast<uint64_t>(tone) + 1;
        }
        if (args.size() > offset + 1 && args[offset + 1].kind != TslArg::Kind::Other) {
            node->name = text(args[offset + 1]);
            if (node->name.empty()) node->name = "srgb-linear";
            if (node->name != "srgb" && node->name != "srgb-linear")
                throw std::runtime_error("renderOutput: unsupported outputColorSpace " + node->name);
        }
        return node;
    }
    if (name == "luminance") {
        if (args.empty() || args.size() > 2) throw std::runtime_error("luminance takes color and optional coefficients");
        const auto coefficients = args.size() == 2 ? arg(1) : g::vec3({g::float_(0.2126), g::float_(0.7152), g::float_(0.0722)});
        return g::dot(arg(0), coefficients);
    }
    if (name == "viewZToOrthographicDepth" || name == "viewZToPerspectiveDepth" || name == "logarithmicDepthToViewZ") {
        arity(3);
        const auto value = arg(0), near = arg(1), far = arg(2);
        if (name == "viewZToOrthographicDepth") return g::div(g::add(value, near), g::sub(near, far));
        if (name == "viewZToPerspectiveDepth") return g::div(g::mul(g::add(near, value), far), g::mul(g::sub(far, near), value));
        const auto exponent = g::mul(value, g::div(g::log2(g::div(far, near)), g::float_(std::log2(std::exp(1.0)))));
        return g::negate(g::mul(g::pow(g::float_(std::exp(1.0)), exponent), near));
    }
    if (name == "film") {
        if (args.empty() || args.size() > 3) throw std::runtime_error("film takes input, optional intensity and uv");
        const auto input = arg(0), base = g::swizzle(input, "rgb");
        const auto uv = args.size() > 2 && args[2].kind != TslArg::Kind::Other ? arg(2) : g::uv();
        const auto animated = g::fract(g::add(uv, g::uniform("time", Type::f32())));
        const auto angle = g::mod(g::dot(animated, g::vec2({g::float_(12.9898), g::float_(78.233)})),
                                  g::float_(3.141592653589793));
        const auto noise = g::fract(g::mul(g::sin(angle), g::float_(43758.5453)));
        auto color = g::add(base, g::mul(base, g::clamp(g::add(noise, g::float_(0.1)), g::float_(0), g::float_(1))));
        if (args.size() > 1 && args[1].kind != TslArg::Kind::Other) color = g::mix(base, color, arg(1));
        return g::vec4({color, g::swizzle(input, "a")});
    }
    if (name == "lut3D") {
        arity(4);
        const auto input = arg(0), lut = arg(1);
        if (lut->kind != g::Kind::Texture || !lut->textureObject())
            throw std::runtime_error("lut3D requires texture3D(engineTexture)");
        const double size = number(args[2]);
        if (size < 2 || size != std::floor(size)) throw std::runtime_error("lut3D size must be an integer >= 2");
        const auto label = "native_lut_" + std::to_string(++serial);
        const auto sizeNode = g::uniform(label + "_size", Type::f32(), {static_cast<float>(size)});
        const auto half = g::div(g::float_(0.5), sizeNode);
        const auto coordinate = g::add(g::vec3({half}), g::mul(g::swizzle(input, "rgb"),
                                      g::sub(g::float_(1), g::div(g::float_(1), sizeNode))));
        auto sample = std::make_shared<g::NodeData>(*lut);
        sample->args[0] = coordinate;
        const auto graded = g::vec4({g::swizzle(sample, "rgb"), g::swizzle(input, "a")});
        auto result = std::make_shared<g::NodeData>(*g::vec4({g::mix(input, graded, arg(3))}));
        result->name = label;
        return result;
    }
    if (name == "traa") {
        arity(4);
        // The colour is the scene's own (resolved right after the scene pass, ahead of every effect) or a texture the
        // graph drew (convertToTexture of the frame after its effects, resolved where that texture is ready). Depth and
        // velocity are always the scene's attachments.
        const auto beauty = arg(0);
        const bool sceneColour = beauty->kind == g::Kind::Texture && beauty->name == "scene";
        if ((!sceneColour && beauty->kind != g::Kind::RenderTexture) ||
            arg(1)->kind != g::Kind::Texture || arg(1)->name != "depth" ||
            arg(2)->kind != g::Kind::Texture || arg(2)->name != "velocity")
            throw std::runtime_error("TN_NATIVE_TRAA_INPUT: traa requires the scene color or a texture the graph drew, with the scene depth and velocity attachments");
        auto effect = std::make_shared<g::PostEffect>();
        effect->kind = "TRAANode";
        effect->output = sceneColour ? "scene" : "native_traa_" + std::to_string(++serial);
        effect->inputs = {beauty, arg(1), arg(2)};
        effect->parameters = {{"depthThreshold", {0.0005f}}, {"edgeDepthDiff", {0.001f}},
                              {"maxVelocityLength", {128}}, {"useSubpixelCorrection", {1}}};
        return g::effectNode(effect);
    }
    if (name == "smaa") {
        arity(1);
        return g::effectNode(g::smaaEffect(arg(0)));
    }
    if (name == "bloom") {
        if (args.empty() || args.size() > 4) throw std::runtime_error("expected input, strength, radius, threshold");
        const auto scalar = [&](size_t i, double fallback) {
            return args.size() <= i || args[i].kind == TslArg::Kind::Other ? fallback : number(args[i]);
        };
        return g::bloom(arg(0), scalar(1, 1), scalar(2, 0), scalar(3, 0));
    }
    if (name == "oneMinus") {
        arity(method ? 0 : 1);
        return g::sub(g::float_(1), lhs());
    }
    // A graph node is a value: `dispose()` releases nothing (the renderer owns what it builds from one).
    if (name == "dispose" && method) {
        arity(0);
        return lhs();
    }
    // PRD-620: `Fn(...)().compute(count, workgroupSize)`, the dispatch renderer.compute runs. A number
    // count and workgroup size only; three's array forms (a 3D dispatch) refuse by name.
    if (name == "compute" && method) {
        if (args.empty() || args.size() > 2 || args[0].kind != TslArg::Kind::Number ||
            (args.size() == 2 && args[1].kind != TslArg::Kind::Number))
            throw std::runtime_error("compute takes a whole-number count and an optional whole-number workgroup size; a 2D or 3D dispatch is not supported");
        const auto whole = [&](double value, const char* what) {
            if (!(value >= 1) || value > std::numeric_limits<int32_t>::max() || value != std::floor(value))
                throw std::runtime_error(std::string("compute ") + what + " must be a whole number of at least 1");
            return static_cast<uint32_t>(value);
        };
        return g::computeNode(receiver->node, whole(args[0].number, "count"), args.size() == 2 ? whole(args[1].number, "workgroup size") : 64);
    }
    if (name == "color") {
        engine::Color value;
        if (args.size() == 3) value.setRGB(number(args[0]), number(args[1]), number(args[2]));
        else if (args.size() == 1) {
            if (args[0].kind == TslArg::Kind::Node) {
                auto node = std::make_shared<g::NodeData>();
                node->kind = g::Kind::Convert; node->type = Type::vec(3); node->args = {arg(0)};
                return node;
            }
            if (args[0].kind == TslArg::Kind::Number) value.setHex(number(args[0]));
            else if (args[0].kind == TslArg::Kind::String) value.setStyle(args[0].text.c_str());
            else if (args[0].kind == TslArg::Kind::Rgb) value.setRGB(args[0].numbers[0], args[0].numbers[1], args[0].numbers[2]);
            else throw std::runtime_error("color needs a Color, CSS string, hex or RGB components");
        } else if (!args.empty()) throw std::runtime_error("invalid color argument count");
        return g::vec3({g::float_(value.r), g::float_(value.g), g::float_(value.b)});
    }
    if (name == "uvec2") {
        if (args.size() > 2) throw std::runtime_error("invalid uvec2 argument count");
        auto node = std::make_shared<g::NodeData>();
        node->kind = g::Kind::Join; node->type = Type::vec(2, Type::Scalar::U32);
        if (args.empty()) node->args = {g::float_(0)};
        else for (size_t i = 0; i < args.size(); ++i) node->args.push_back(arg(i));
        return node;
    }
    if (name == "ivec2") {
        if (args.size() > 2) throw std::runtime_error("invalid ivec2 argument count");
        auto node = std::make_shared<g::NodeData>();
        node->kind = g::Kind::Convert; node->type = Type::vec(2, Type::Scalar::I32);
        node->args = {args.size() == 2 ? g::vec2({arg(0), arg(1)})
            : g::vec2({args.size() == 1 ? arg(0) : g::float_(0)})};
        return node;
    }
    // lengthSq(v) is dot(v, v).
    if (name == "lengthSq") {
        arity(method ? 0 : 1);
        const auto value = lhs();
        return g::dot(value, value);
    }
    if (name == "reflect") {
        arity(method ? 1 : 2);
        auto node = std::make_shared<g::NodeData>();
        node->kind = g::Kind::Math; node->name = "reflect"; node->args = {lhs(), rhs()};
        node->type = node->args[0]->type;
        return node;
    }
    // reflector(target, camera, resolutionScale, bounces, generateMipmaps, depth, samples): the
    // texture node of three's ReflectorNode, sampled at screenUV.flipX(). The language back ends
    // build target (an Object3D) and the virtual camera (a PerspectiveCamera) and pass them in.
    // ponytail: bounces is accepted and not modelled; a reflection pass hides every reflecting
    // surface, where three draws other mirrors into it. Model it if a scene needs mirrors in mirrors.
    if (!method && name == "reflector") {
        arity(7);
        const auto object = [&](size_t i, const char* cls) {
            if (args[i].kind != TslArg::Kind::Object || args[i].cls != cls || !args[i].object)
                throw std::runtime_error(std::string("reflector needs an engine ") + cls + " as argument " + std::to_string(i));
            return args[i].object;
        };
        auto state = std::make_shared<engine::Reflector>();
        state->target = std::static_pointer_cast<engine::Object3D>(object(0, "Object3D"));
        state->camera = std::static_pointer_cast<engine::PerspectiveCamera>(object(1, "PerspectiveCamera"));
        state->resolutionScale = number(args[2]);
        if (!(state->resolutionScale > 0)) throw std::runtime_error("reflector resolutionScale must be positive");
        (void)number(args[3]);
        if (number(args[4]) != 0)
            throw std::runtime_error("TN_NATIVE_REFLECTOR_UNSUPPORTED: generateMipmaps");
        if (number(args[5]) != 0)
            throw std::runtime_error("TN_NATIVE_REFLECTOR_UNSUPPORTED: depth");
        if (number(args[6]) != 0)
            throw std::runtime_error("TN_NATIVE_REFLECTOR_UNSUPPORTED: samples");
        const auto screen = g::screenUV();
        return g::reflectorTexture(state, g::vec2({g::sub(g::float_(1), g::swizzle(screen, "x")), g::swizzle(screen, "y")}));
    }
    // FlipNode: node.flipX() is the node with x replaced by 1 - x (likewise y, z, w).
    if (method && name.size() == 5 && name.rfind("flip", 0) == 0) {
        arity(0);
        const auto source = lhs();
        const auto flipped = std::string("XYZW").find(name[4]);
        const uint32_t size = source->type.isVector() ? source->type.rows : 0;
        if (flipped == std::string::npos || flipped >= size || size < 2 || size > 4)
            throw std::runtime_error(name + " needs a vector with that component");
        std::vector<g::Node> lanes;
        for (uint32_t i = 0; i < size; ++i) {
            const auto lane = g::swizzle(source, std::string(1, "xyzw"[i]));
            lanes.push_back(i == flipped ? g::sub(g::float_(1), lane) : lane);
        }
        if (size == 2) return g::vec2({lanes[0], lanes[1]});
        if (size == 3) return g::vec3({lanes[0], lanes[1], lanes[2]});
        return g::vec4({lanes[0], lanes[1], lanes[2], lanes[3]});
    }
    if (!method && name == "screenUV") {
        arity(0);
        return g::screenUV();
    }
    // pmremTexture(texture, direction, level): three's PMREMNode over an equirectangular texture.
    // Outside an environment there is no context to supply the direction or the level, so both are
    // required (three reads builder.context.getUV / getTextureLevel, which a material lacks).
    if (!method && name == "pmremTexture") {
        arity(3);
        if (args[0].kind != TslArg::Kind::Object || (args[0].cls != "Texture" && args[0].cls != "DataTexture" && args[0].cls != "CanvasTexture") || !args[0].object)
            throw std::runtime_error("pmremTexture needs an engine Texture");
        return g::pmremTexture(args[0].object, arg(1), arg(2));
    }
    // MaterialX noise (three's MaterialXNodes.js over mx_noise.js; the WGSL is materialx_noise.h).
    // mx_noise_float(texcoord = uv(), amplitude = 1, pivot = 0) is perlin * amplitude + pivot, and
    // mx_worley_noise_float/vec2(texcoord = uv(), jitter = 1) uses metric 1, as three's wrapper does.
    if (!method && (name == "mx_noise_float" || name == "mx_worley_noise_float" || name == "mx_worley_noise_vec2")) {
        const bool worley = name != "mx_noise_float";
        if (args.size() > (worley ? 2u : 3u)) throw std::runtime_error("too many arguments");
        auto node = std::make_shared<g::NodeData>();
        node->kind = g::Kind::Math;
        node->name = worley ? std::string(name) : "mx_perlin_noise_float";
        node->args = {args.empty() ? g::uv() : arg(0)};
        node->type = name == "mx_worley_noise_vec2" ? Type::vec(2) : Type::f32();
        if (worley) {
            node->args.push_back(args.size() > 1 ? g::float_(arg(1)) : g::float_(1));
            node->args.push_back(g::int_(1));
            return node;
        }
        return g::add(g::mul(node, args.size() > 1 ? arg(1) : g::float_(1)), args.size() > 2 ? arg(2) : g::float_(0));
    }
    if (name == "textureLoad") {
        if (args.size() < 2 || args.size() > 3) throw std::runtime_error("expected texture, coordinates and optional level");
        std::string label;
        if (args[0].kind == TslArg::Kind::Node && args[0].node) {
            const auto& texture = args[0].node;
            if (texture->kind != g::Kind::Texture && texture->kind != g::Kind::RenderTexture)
                throw std::runtime_error("textureLoad needs a texture node");
            label = texture->name;
        } else if (args[0].kind == TslArg::Kind::Named) {
            label = args[0].text;
        }
        if (label.empty()) throw std::runtime_error("textureLoad needs a named texture");
        auto node = std::make_shared<g::NodeData>();
        node->kind = g::Kind::TextureLoad; node->name = label; node->type = Type::vec(4);
        if (args[0].kind == TslArg::Kind::Node && args[0].node) {
            node->textureBinding = args[0].node->textureBinding; node->object = args[0].node->object; node->bits = args[0].node->bits;
            // Retain the target producer and the texture owner as graph dependencies.
            if (node->textureObject() || args[0].node->kind == g::Kind::RenderTexture) node->otherwise = {args[0].node};
        }
        node->args = {arg(1)};
        if (args.size() == 3) node->args.push_back(arg(2));
        return node;
    }
    if (name == "uniform") {
        // uniform(value) or three's uniform(value, type): a whole number takes "uint" or "int", anything else its own type.
        if (args.size() == 2 && args[0].kind == TslArg::Kind::Number) {
            const Type wanted = type(text(args[1]));
            if (wanted.isScalar() && wanted.scalar != Type::Scalar::F32 && wanted.scalar != Type::Scalar::Bool) {
                if (args[0].number != std::floor(args[0].number)) throw std::runtime_error("a " + wanted.name() + " uniform holds a whole number");
                return g::uniform("nodeUniform" + std::to_string(++serial), wanted, {args[0].number});
            }
        }
        if (args.size() == 2) {
            const Type wanted = type(text(args[1]));
            if (wanted != arg(0)->type && !(wanted == Type::f32() && arg(0)->type == Type::f32()))
                throw std::runtime_error("uniform type " + wanted.name() + " does not match its value");
        } else {
            arity(1);
        }
        const auto value = arg(0);
        if (value->type == Type{})
            throw std::runtime_error("uniform value needs a concrete type");
        std::vector<double> values;
        const std::function<void(g::Node)> constant = [&](g::Node n) {
            if (n->kind == g::Kind::Constant && n->type == Type::f32()) {
                values.push_back(std::bit_cast<float>(static_cast<uint32_t>(n->bits)));
            } else if (n->kind == g::Kind::Join) {
                const size_t start = values.size();
                for (const auto& part : n->args) constant(part);
                if (values.size() - start == 1) values.resize(start + n->type.rows, values.back());
            } else throw std::runtime_error("uniform needs a constant float or vector value");
        };
        constant(value);
        return g::uniform("nodeUniform" + std::to_string(++serial), value->type, std::move(values));
    }
    if (name == "attribute") {
        arity(2);
        return g::attribute(text(args[0]), type(text(args[1])));
    }
    if (name == "textureValue") {
        arity(1);
        if (!method || !receiver->node || receiver->node->kind != g::Kind::Texture || !receiver->node->textureBinding)
            throw std::runtime_error("TN_NATIVE_TEXTURE_VALUE_TYPE: expected an object texture node");
        if (args[0].kind != TslArg::Kind::Object || !args[0].object || args[0].cls.find("Texture") == std::string::npos)
            throw std::runtime_error("TN_NATIVE_TEXTURE_VALUE_TYPE: expected an engine Texture");
        const auto next = std::static_pointer_cast<const engine::Texture>(args[0].object);
        const auto previous = std::static_pointer_cast<const engine::Texture>(receiver->node->textureObject());
        if (next->depthTexture != previous->depthTexture || next->volume != previous->volume)
            throw std::runtime_error("TN_NATIVE_TEXTURE_VALUE_TYPE: replacement must preserve texture dimension and sample type");
        receiver->node->textureBinding->object = args[0].object;
        return receiver->node;
    }
    if (!method && name == "storageTexture") {
        if (args.empty() || args.size() > 3 || args[0].kind != TslArg::Kind::Object || !args[0].object || args[0].cls != "StorageTexture")
            throw std::runtime_error("storageTexture needs an engine StorageTexture and optional coordinates and value");
        const auto* texture = static_cast<const engine::Texture*>(args[0].object.get());
        auto node = std::make_shared<g::NodeData>();
        node->kind = g::Kind::StorageTexture; node->type = Type::vec(4);
        node->object = args[0].object; node->name = "nodeMap" + std::to_string(texture->ident.value());
        node->lanes = texture->storageFormat();
        for (size_t i = 1; i < args.size(); ++i) node->args.push_back(arg(i));
        return node;
    }
    if (name == "texture") {
        // three's texture(value, uvNode = uv()): the uv is optional.
        if (args.size() != 1) arity(2);
        const auto uvInput = [&] { return args.size() == 1 ? g::uv() : arg(1); };
        // An engine Texture with texels, or a render target's texture, samples itself under a binding
        // named by its cache identity. An imageless texture with no name is three's placeholder
        // (`texture(new Texture())`, later `.value = target.texture`): it binds as an object texture
        // so `textureValue` can swap the real one in. ponytail: a named imageless one keeps naming a
        // map, as before; a texture whose texels arrive after the graph is built is not followed.
        if (args[0].kind == TslArg::Kind::Object) {
            if (args[0].cls.find("Texture") == std::string::npos || !args[0].object)
                throw std::runtime_error("texture needs an engine Texture");
            const auto* source = static_cast<const engine::Texture*>(args[0].object.get());
            if (source->sampleable() || source->name.empty())
                return g::objectTexture(args[0].object, "nodeMap" + std::to_string(++serial), uvInput());
            return g::texture(source->name, uvInput());
        }
        if (args[0].kind != TslArg::Kind::Named)
            throw std::runtime_error("expected a texture with a name");
        if (args[0].text.empty())
            throw std::runtime_error("texture needs a name");
        return g::texture(args[0].text, uvInput());
    }
    // r185's texture3D(value, uvw, level) (accessors/Texture3DNode.js): a Data3DTexture sampled at a vec3,
    // vec3(0.5) by default; `level` is an explicit mip.
    if (name == "texture3D") {
        if (args.empty() || args.size() > 3) throw std::runtime_error("texture3D takes 1 to 3 arguments");
        if (args[0].kind != TslArg::Kind::Object || !args[0].object || args[0].cls != "Data3DTexture")
            throw std::runtime_error("texture3D needs an engine Data3DTexture");
        const auto* source = static_cast<const engine::Texture*>(args[0].object.get());
        if (!source->sampleable()) throw std::runtime_error("texture3D needs a Data3DTexture with texels");
        const auto half = [] { return g::float_(0.5); };
        auto node = g::objectTexture(args[0].object, "nodeMap" + std::to_string(++serial),
                                     args.size() > 1 ? arg(1) : g::vec3({half(), half(), half()}));
        if (args.size() == 3) {
            auto level = std::make_shared<g::NodeData>(*node);
            level->args.push_back(arg(2));
            return level;
        }
        return node;
    }
    if (name == "uv") {
        arity(0);
        return g::uv();
    }
    // TextureNode.level(n): the same texture read at an explicit mip level.
    if (method && name == "level") {
        arity(1);
        const auto source = lhs();
        // A render texture (convertToTexture of a graph) reads at a level too: the level is the third argument.
        const bool rendered = source->kind == g::Kind::RenderTexture && source->args.size() == 2;
        if (!rendered && (source->kind != g::Kind::Texture || source->args.size() != 1))
            throw std::runtime_error("level needs a texture node");
        auto node = std::make_shared<g::NodeData>(*source);
        node->args = rendered ? std::vector<g::Node>{source->args[0], source->args[1], arg(0)}
                              : std::vector<g::Node>{source->args[0], arg(0)};
        return node;
    }
    // r185's camera accessors (accessors/Camera.js) for a single camera: render-group uniforms by
    // their upstream names, which the renderer fills per draw (kSlotNames).
    // r185's viewport textures: the frame's colour and depth as drawn before this draw, read at uv
    // (screenUV when omitted). The renderer copies them at the first draw that reads one.
    if (!method && (name == "viewportSharedTexture" || name == "viewportDepthTexture")) {
        if (args.size() > 1) throw std::runtime_error(name + " takes at most a uv");
        const auto uv = args.empty() ? g::screenUV() : arg(0);
        return name == "viewportDepthTexture" ? g::viewportDepth(uv) : g::texture("viewportColor", uv);
    }
    // linearDepth(depth): ViewportDepthNode.LINEAR_DEPTH for a perspective camera,
    // viewZToOrthographicDepth(perspectiveDepthToViewZ(depth, near, far), near, far).
    // ponytail: perspective cameras only; an orthographic camera's depth is already linear.
    // linearDepth() with no depth is this fragment's own: viewZToOrthographicDepth(positionView.z, ...).
    if (!method && name == "linearDepth") {
        if (args.size() > 1) throw std::runtime_error("linearDepth takes at most a depth");
        const auto near = g::uniform("cameraNear", Type::f32()), far = g::uniform("cameraFar", Type::f32());
        const auto viewZ = args.empty() ? g::swizzle(g::varying("positionView", Type::vec(3)), "z")
                                        : g::div(g::mul(near, far), g::sub(g::mul(g::sub(far, near), arg(0)), far));
        return g::div(g::add(viewZ, near), g::sub(near, far));
    }
    if (name == "cameraNear" || name == "cameraFar") {
        arity(0);
        return g::uniform(name, Type::f32());
    }
    if (name == "screenSize") {
        arity(0);
        return g::uniform("screenSize", Type::vec(2));
    }
    // r185's depth (ViewportDepthNode): viewZToPerspectiveDepth(positionView.z, cameraNear, cameraFar)
    // = (cameraNear + positionView.z) * cameraFar / ((cameraFar - cameraNear) * positionView.z).
    if (name == "depth") {
        arity(0);
        const auto near = g::uniform("cameraNear", Type::f32()), far = g::uniform("cameraFar", Type::f32());
        const auto viewZ = g::swizzle(g::varying("positionView", Type::vec(3)), "z");
        return g::div(g::mul(g::add(near, viewZ), far), g::mul(g::sub(far, near), viewZ));
    }
    // normalWorldGeometry: the interpolated world-space normal before normalNode or normalMap.
    if (name == "normalWorldGeometry") {
        arity(0);
        return g::normalize(g::varying("normalWorldGeometry", Type::vec(3)));
    }
    if (name == "cameraPosition" || name == "cameraProjectionMatrix" || name == "cameraWorldMatrix") {
        arity(0);
        return g::uniform(name, name == "cameraPosition" ? Type::vec(3) : Type::mat(4, 4));
    }
    // positionGeometry = attribute('position', 'vec3'): the geometry's position before positionNode.
    if (name == "positionGeometry") {
        arity(0);
        return g::attribute("position", Type::vec(3));
    }
    // r185's local accessors as they read: normalLocal = normalGeometry.toVar('normalLocal'),
    // tangentLocal = tangentGeometry.xyz.toVar('tangentLocal') and positionPrevious =
    // positionGeometry.toVarying('positionPrevious'). Assigning one (core's projection-skinned
    // writes them in a positionNode) is refused by name: the standard program does not read it back.
    if (name == "normalLocal") {
        arity(0);
        return g::attribute("normal", Type::vec(3));
    }
    if (name == "tangentLocal") {
        arity(0);
        return g::swizzle(g::attribute("tangent", Type::vec(4)), "xyz");
    }
    if (name == "positionPrevious") {
        arity(0);
        return g::varying(g::attribute("position", Type::vec(3)), "positionPrevious");
    }
    // normalWorld = normalView.transformNormalByInverseViewMatrix(cameraViewMatrix):
    // normalize((vec4(normalView, 0) * viewMatrix).xyz). In a material slot the material supplies
    // normalView (standard.cpp nodeValue: back-face flip, normalNode, normal map).
    if (name == "normalWorld") {
        arity(0);
        const auto normalView = g::normalize(g::varying("normalView", Type::vec(3)));
        return g::normalize(g::swizzle(g::mul(g::vec4({normalView, g::float_(0)}),
                                              g::uniform("viewMatrix", Type::mat(4, 4))), "xyz"));
    }
    // normalView: the material's view-space normal in a material slot (standard.cpp nodeValue), else the
    // interpolated normal the vertex stage writes. ponytail: a vertex-stage read is the unflipped geometry normal.
    if (name == "normalView") {
        arity(0);
        return g::normalize(g::varying("normalView", Type::vec(3)));
    }
    // r185: positionLocal.transformDirection(modelWorldMatrix), interpolated then normalized.
    if (name == "positionWorldDirection") {
        arity(0);
        return g::normalize(g::varying("positionWorldDirection", Type::vec(3)));
    }
    // positionViewDirection = positionView.negate().toVarying().normalize().
    if (name == "positionViewDirection") {
        arity(0);
        return g::normalize(g::varying("positionViewDirection", Type::vec(3)));
    }
    // ScreenNode's coordinate (the fragment's pixel position) and the geometry's own attributes.
    if (name == "screenCoordinate") {
        arity(0);
        return g::swizzle(g::builtin("position"), "xy");
    }
    if (name == "normalGeometry" || name == "tangentGeometry") {
        arity(0);
        return name == "normalGeometry" ? g::attribute("normal", Type::vec(3)) : g::attribute("tangent", Type::vec(4));
    }
    // varying(node, name?): `node` computed in the vertex stage and interpolated to the fragment.
    if (name == "varying") {
        if (args.empty() || args.size() > 2) throw std::runtime_error("expected a node and an optional name");
        return g::varying(arg(0), args.size() == 2 ? text(args[1]) : "nodeVarying" + std::to_string(++serial));
    }
    if (name == "__rtt" && method) {
        arity(2);
        const auto node = receiver->node;
        if (!node || !node->rtt || args[0].kind != TslArg::Kind::Object || args[0].cls != "RenderTarget" ||
            !args[0].object || args[1].kind != TslArg::Kind::Object || !args[1].object || args[1].cls != "Mesh")
            throw std::runtime_error("RTT needs a RenderTarget and a QuadMesh");
        node->rtt->target = std::static_pointer_cast<engine::RenderTarget>(args[0].object);
        node->rtt->quad = std::static_pointer_cast<engine::Mesh>(args[1].object);
        node->rtt->material = node->rtt->quad->material;
        node->rtt->source = node->args[0];
        if (!node->rtt->material || !node->rtt->material->nodeMaterial)
            throw std::runtime_error("RTT quad needs a node material");
        return node;
    }
    if (name == "rtt") {
        arity(5);
        auto target = std::make_shared<g::NodeData>();
        target->kind = g::Kind::RenderTexture;
        target->name = "native_rtt_" + std::to_string(++serial);
        target->type = Type::vec(4);
        target->args = {arg(0), g::uv()};
        target->rtt = std::make_shared<g::RttState>();
        for (size_t i = 1; i <= 2; ++i) {
            const double n = number(args[i]);
            if (n < 0 || n > 16384 || n != std::floor(n)) throw std::runtime_error("rtt extent must be an integer in [0, 16384]");
            (i == 1 ? target->rtt->width : target->rtt->height) = uint32_t(n);
        }
        for (size_t i = 3; i <= 4; ++i) {
            const double n = number(args[i]);
            if (n != 1003 && n != 1006) throw std::runtime_error("rtt filter must be NearestFilter or LinearFilter");
            (i == 3 ? target->rtt->minFilter : target->rtt->magFilter) = uint16_t(n);
        }
        return target;
    }
    if (name == "convertToTexture") {
        arity(1);
        return toTexture(arg(0));
    }
    if (name == "sample") {
        arity(1);
        const auto source = lhs();
        if (source->kind != g::Kind::Texture && source->kind != g::Kind::RenderTexture && source->kind != g::Kind::Reflector)
            throw std::runtime_error("sample requires a texture node");
        auto sampled = std::make_shared<g::NodeData>(*source);
        if (source->kind == g::Kind::RenderTexture) sampled->args[1] = arg(0);
        else sampled->args[0] = arg(0);
        return sampled;
    }
    if (name == "float" || name == "int" || name == "uint") {
        arity(1);
        if (args[0].kind == TslArg::Kind::Number) {
            const double n = number(args[0]);
            if (name == "float")
                return g::float_(n);
            const double minimum = name == "uint" ? 0 : std::numeric_limits<int32_t>::min();
            const double maximum =
                name == "uint" ? std::numeric_limits<uint32_t>::max() : std::numeric_limits<int32_t>::max();
            if (n < minimum || n > maximum || n != std::floor(n))
                throw std::runtime_error("integer out of range");
            return name == "int" ? g::int_(static_cast<int32_t>(n)) : g::uint_(static_cast<uint32_t>(n));
        }
        if (name == "float")
            return g::float_(arg(0));
        if (name == "uint")
            return g::uint_(arg(0));
        auto node = std::make_shared<g::NodeData>();
        node->kind = g::Kind::Convert;
        node->type = Type::i32();
        node->args = {arg(0)};
        return node;
    }
    // r185's mat2 (ConvertType): two column vectors; four plain numbers build a Matrix2, whose constructor is
    // row-major, so the columns are (a, c) and (b, d); four scalars with any node in them are WGSL's
    // column-major constructor.
    if (!method && (name == "mat3" || name == "mat4")) {
        const uint8_t n = name == "mat3" ? 3 : 4;
        auto matrix = std::make_shared<g::NodeData>();
        matrix->kind = g::Kind::Join; matrix->type = Type::mat(n, n);
        if (args.empty()) {
            for (size_t c = 0; c < n; ++c) {
                auto column = std::make_shared<g::NodeData>(); column->kind = g::Kind::Join; column->type = Type::vec(n);
                for (size_t r = 0; r < n; ++r) column->args.push_back(g::float_(r == c ? 1 : 0));
                matrix->args.push_back(column);
            }
        } else if (args.size() == 1) {
            auto converted = std::make_shared<g::NodeData>(); converted->kind = g::Kind::Convert;
            converted->type = matrix->type; converted->args = {arg(0)};
            return converted;
        } else if (args.size() == n) { for (size_t i = 0; i < n; ++i) matrix->args.push_back(arg(i)); }
        else if (args.size() == n * n) {
            const bool numbers = std::all_of(args.begin(), args.end(), [](const TslArg& a) { return a.kind == TslArg::Kind::Number; });
            for (size_t c = 0; c < n; ++c) {
                auto column = std::make_shared<g::NodeData>(); column->kind = g::Kind::Join; column->type = Type::vec(n);
                for (size_t r = 0; r < n; ++r) column->args.push_back(arg(numbers ? r * n + c : c * n + r));
                matrix->args.push_back(column);
            }
        } else throw std::runtime_error("TN_NATIVE_TSL_TYPE: " + name + " requires columns or scalar components");
        return matrix;
    }
    if (name == "mat2") {
        if (args.size() != 2 && args.size() != 4) throw std::runtime_error("mat2 takes two columns or four scalars");
        if (args.size() == 2) return g::mat2({arg(0), arg(1)});
        const bool constants = std::all_of(args.begin(), args.end(), [](const TslArg& a) { return a.kind == TslArg::Kind::Number; });
        return constants ? g::mat2({arg(0), arg(2), arg(1), arg(3)}) : g::mat2({arg(0), arg(1), arg(2), arg(3)});
    }
    if (name == "vec2" || name == "vec3" || name == "vec4") {
        const size_t lanes = static_cast<size_t>(name.back() - '0');
        if (args.empty() || args.size() > lanes)
            throw std::runtime_error("invalid vector argument count");
        std::vector<g::Node> parts;
        for (size_t i = 0; i < args.size(); ++i)
            parts.push_back(arg(i));
        // graph.h's fixed initializer-list API: the vector's lane count is still checked by lower().
        const auto join = [&](std::initializer_list<g::Node> list) {
            return lanes == 2 ? g::vec2(list) : lanes == 3 ? g::vec3(list) : g::vec4(list);
        };
        if (parts.size() == 1)
            return join({parts[0]});
        if (parts.size() == 2)
            return join({parts[0], parts[1]});
        if (parts.size() == 3)
            return join({parts[0], parts[1], parts[2]});
        return join({parts[0], parts[1], parts[2], parts[3]});
    }
    if (name.rfind("swizzle:", 0) == 0) {
        arity(0);
        return g::swizzle(lhs(), name.substr(8));
    }
    // r185's fluent step places the receiver last (MathNode.stepElement).
    if (method && name == "step") {
        arity(1);
        return g::step(arg(0), lhs());
    }
    // MathNode / OperatorNode names share one typed IR on Wasm, V8 and serialized graphs.
    const auto math = [&](const std::string& operation, size_t operands) -> g::Node {
        arity(operands - (method ? 1 : 0));
        auto node = std::make_shared<g::NodeData>();
        node->kind = g::Kind::Math;
        node->name = operation;
        if (method) node->args.push_back(lhs());
        for (size_t i = 0; i < args.size(); ++i) node->args.push_back(arg(i));
        return node;
    };
    for (const char* op : {"acos", "asin", "tan", "ceil", "round", "trunc", "inverseSqrt", "inversesqrt", "reciprocal", "radians", "degrees", "sinh", "cosh", "tanh", "asinh", "acosh", "atanh", "saturate", "pow2", "pow3", "pow4", "transpose", "determinant", "inverse", "rand", "bitNot"})
        if (name == op) return math(name, 1);
    for (const char* op : {"difference", "transformDirection", "transformNormalByViewMatrix", "transformNormalByInverseViewMatrix", "xor", "bitAnd", "bitOr", "bitXor", "shiftLeft", "shiftRight", "stepElement"})
        if (name == op) return math(name, 2);
    for (const char* op : {"refract", "faceForward", "faceforward", "mixElement", "smoothstepElement"})
        if (name == op) return math(name, 3);
    if ((name == "add" || name == "sub" || name == "mul" || name == "div" || name == "min" || name == "max" ||
         name == "and" || name == "or") && args.size() > (method ? 1u : 2u)) {
        g::Node result = lhs();
        for (size_t i = method ? 0 : 1; i < args.size(); ++i) {
            const TslArg previous = TslArg::of(result);
            result = tslCall(name, &previous, {args[i]}, serial);
        }
        return result;
    }
#define BINARY(symbol)                                                                                                 \
    if (name == #symbol) {                                                                                             \
        arity(method ? 1 : 2);                                                                                         \
        return g::symbol(lhs(), rhs());                                                                                \
    }
    BINARY(add)
    BINARY(sub)
    BINARY(mul) BINARY(div) BINARY(lessThan) BINARY(greaterThan) BINARY(equal) BINARY(min) BINARY(max) BINARY(pow)
        BINARY(step) BINARY(dot) BINARY(distance) BINARY(cross) BINARY(mod)
        BINARY(lessThanEqual) BINARY(greaterThanEqual)
#undef BINARY
    // r185's notEqual: the graph has no inequality operator, so it is the negated equality.
    if (name == "notEqual") {
        arity(method ? 1 : 2);
        return g::logicalNot(g::equal(lhs(), rhs()));
    }
    // `and` / `or` / `not` are C++ operator names, so the graph calls them logical*.
    if (name == "and" || name == "or") {
        arity(method ? 1 : 2);
        return name == "and" ? g::logicalAnd(lhs(), rhs()) : g::logicalOr(lhs(), rhs());
    }
    if (name == "not") {
        arity(method ? 0 : 1);
        return g::logicalNot(lhs());
    }
    // r185's toFloat, toInt and toUint (ConvertNode): the receiver converted, as float(x), int(x) and uint(x).
    if (method && (name == "toFloat" || name == "toInt" || name == "toUint")) {
        arity(0);
        return tslCall(name == "toFloat" ? "float" : name == "toInt" ? "int" : "uint", nullptr, {*receiver}, serial);
    }
#define UNARY(symbol)                                                                                                  \
    if (name == #symbol) {                                                                                             \
        arity(method ? 0 : 1);                                                                                         \
        return g::symbol(lhs());                                                                                       \
    }
            UNARY(negate) UNARY(abs) UNARY(sin) UNARY(cos) UNARY(floor) UNARY(fract) UNARY(sqrt) UNARY(exp) UNARY(exp2)
                UNARY(log2) UNARY(log) UNARY(normalize) UNARY(length) UNARY(dFdx) UNARY(dFdy) UNARY(sign) UNARY(fwidth) UNARY(all) UNARY(any)
#undef UNARY
    // r185's cbrt (MathNode.js): sign(a) * pow(abs(a), 1 / 3).
    if (name == "cbrt") {
        arity(method ? 0 : 1);
        const g::Node a = lhs();
        const TslArg magnitude = TslArg::of(g::abs(a));
        return g::mul(g::sign(a), tslCall("pow", &magnitude, {TslArg::of(1.0 / 3.0)}, serial));
    }
    // r185's atan(y, x) (MathNode.js): one operand is atan(y); two are WebGPU's atan2(y, x).
    if (name == "atan") {
        const size_t operands = args.size() + (method ? 1 : 0);
        if (operands == 0 || operands > 2) throw std::runtime_error("expected 1 or 2 arguments");
        return operands == 1 ? g::atan(lhs()) : g::atan2(lhs(), rhs());
    }
    // r185's saturation(color, adjustment = 1) (ColorAdjustment.js): mix(luminance, color.rgb, adjustment),
    // then max(_, 0). The luminance is dot(color.rgb, the linear working space's coefficients).
    if (!method && name == "saturation") {
        if (args.empty() || args.size() > 2) throw std::runtime_error("expected a color and an optional adjustment");
        const g::Node rgb = g::swizzle(arg(0), "xyz");
        const g::Node luminance = g::dot(rgb, g::vec3({g::float_(0.2126), g::float_(0.7152), g::float_(0.0722)}));
        const g::Node adjustment = args.size() == 2 ? arg(1) : g::float_(1);
        return g::max(g::mix(g::splat(luminance, 3), rgb, adjustment), g::splat(g::float_(0), 3));
    }
    // r185's hash(seed) (math/Hash.js): integer mixing of seed.toUint(), converted to [0, 1). Each
    // number is a u32, as OperatorNode.generate converts a constant to its operand's integer type.
    if (!method && name == "hash") {
        arity(1);
        const auto u = [](uint32_t n) { return g::uint_(n); };
        const g::Node state = g::add(g::mul(g::uint_(arg(0)), u(747796405u)), u(2891336453u));
        const g::Node shifted = g::shiftRight(state, g::add(g::shiftRight(state, u(28u)), u(4u)));
        const g::Node word = g::mul(g::bitXor(shifted, state), u(277803737u));
        return g::mul(g::float_(g::bitXor(g::shiftRight(word, u(22u)), word)), g::float_(1.0 / 4294967296.0));
    }
    // r185's fluent mix/smoothstep also place the receiver last.
    if (method && (name == "mix" || name == "smoothstep")) {
        arity(2);
        return name == "mix" ? g::mix(arg(0), arg(1), lhs()) : g::smoothstep(arg(0), arg(1), lhs());
    }
    // r185's clamp(value, low = 0, high = 1) (MathNode.js): the bounds are optional.
    if (name == "clamp" && args.size() < (method ? 2u : 3u)) {
        const size_t first = method ? 0 : 1;
        if (!method && args.empty()) throw std::runtime_error("expected a value to clamp");
        return g::clamp(lhs(), args.size() > first ? arg(first) : g::float_(0), g::float_(1));
    }
#define TERNARY(symbol)                                                                                                \
    if (name == #symbol) {                                                                                             \
        arity(method ? 2 : 3);                                                                                         \
        return g::symbol(lhs(), arg(method ? 0 : 1), arg(method ? 1 : 2));                                             \
    }
                    TERNARY(select) TERNARY(mix) TERNARY(clamp) TERNARY(smoothstep)
#undef TERNARY
                        return {};
}

namespace {
/** The stage a pass labels itself with (post_effects.h kStage*): a name the renderer times under its own segment. */
uint8_t stageOf(double value) {
    if (value != g::kStageNone && value != g::kStageScreenSpaceGi) throw std::runtime_error("unknown GPU stage " + std::to_string(value));
    return uint8_t(value);
}
}  // namespace

double tslEffectParameter(const g::Node& node, const std::string& name, const double* value) {
    if (node && node->rtt) {
        auto& r = *node->rtt;
        if (value && !std::isfinite(*value)) throw std::runtime_error("rtt parameter must be finite");
        if (name == "stage") {
            if (value) r.stage = stageOf(*value);
            return r.stage;
        }
        if (name == "resolutionScale") {
            if (value) {
                if (*value <= 0 || *value > 8) throw std::runtime_error("rtt scale must be in (0, 8]");
                r.scale = *value; ++r.revision; r.textureNeedsUpdate = true;
            }
            return r.scale;
        }
        if (name == "width" || name == "height") {
            auto& extent = name == "width" ? r.width : r.height;
            if (value) {
                if (*value < 0 || *value > 16384 || *value != std::floor(*value)) throw std::runtime_error("rtt extent must be an integer in [0, 16384]");
                extent = uint32_t(*value); ++r.revision; r.textureNeedsUpdate = true;
            }
            return extent;
        }
        if (name == "actualWidth" || name == "actualHeight") {
            if (value) throw std::runtime_error("rtt actual extent is read-only");
            if (r.target)
                return name == "actualWidth" ? r.target->width : r.target->height;
            const auto extent = name == "actualWidth" ? r.width : r.height;
            return extent ? std::max(1.0, std::floor(extent * r.scale)) : name == "actualWidth" ? r.actualWidth : r.actualHeight;
        }
        if (name == "minFilter" || name == "magFilter") {
            auto& filter = name == "minFilter" ? r.minFilter : r.magFilter;
            if (value) {
                if (*value != 1003 && *value != 1006) throw std::runtime_error("rtt filter must be NearestFilter or LinearFilter");
                filter = uint16_t(*value);
            }
            return filter;
        }
        if (name == "autoUpdate") {
            if (value) r.autoUpdate = *value != 0;
            return r.autoUpdate;
        }
        if (name == "textureNeedsUpdate") {
            if (value) { r.textureNeedsUpdate = *value != 0; if (r.textureNeedsUpdate) ++r.revision; }
            return r.textureNeedsUpdate;
        }
        if (name == "dispose") {
            if (value) { ++r.disposal; ++r.revision; r.textureNeedsUpdate = true; }
            return r.disposal;
        }
        throw std::runtime_error("unknown rtt parameter " + name);
    }
    g::Node parameter = g::bloomParameter(node, name);
    if (!parameter && node && node->name.starts_with("native_lut_") && name == "size")
        for (const auto& uniform : g::uniformNodes(node))
            if (uniform->name == node->name + "_size") parameter = uniform;
    if (const g::Node uniform = parameter) {
        if (value) {
            if (!std::isfinite(*value)) throw std::runtime_error("expected a finite number");
            if (name == "size" && (*value < 2 || *value != std::floor(*value)))
                throw std::runtime_error("lut3D size must be an integer >= 2");
            g::setUniformValues(uniform, {static_cast<float>(*value)});
        }
        return uniform->values.at(0);
    }
    if (!node || node->kind != g::Kind::PostEffect || !node->post) throw std::runtime_error("not a live post effect");
    auto& effect = const_cast<g::PostEffect&>(*node->post);  // ponytail: live effects are built mutable
    if (effect.kind == "TRAANode") {
        if (value && !std::isfinite(*value))
            throw std::runtime_error("expected a finite number");
        if (name == "viewOffset") {
            if (value)
                effect.viewOffset = *value != 0;
            return effect.viewOffset;
        }
        for (size_t i = 0; i < effect.originalProjection.size(); ++i)
            if (name == "projection" + std::to_string(i)) {
                if (value)
                    effect.originalProjection[i] = *value;
                return effect.originalProjection[i];
            }
    }
    if (name == "resolutionScale") {
        if (value) {
            const double maximum = effect.kind == "SSRNode" ? 1 : 8;
            if (!std::isfinite(*value) || !(*value > 0 && *value <= maximum))
                throw std::runtime_error("resolutionScale must be in (0, " + std::to_string(maximum) + "]");
            effect.resolutionScale = static_cast<float>(*value);
        }
        return effect.resolutionScale;
    }
    if (name == "stage") {
        if (value) effect.stage = stageOf(*value);
        return effect.stage;
    }
    const auto found = effect.parameters.find(name);
    if (found == effect.parameters.end() || found->second.size() != 1 || name.front() == '_')
        throw std::runtime_error(effect.kind + " has no scalar uniform " + name);
    if (value) {
        if (!std::isfinite(*value)) throw std::runtime_error("expected a finite number");
        if (effect.kind == "SSRNode") {
            if (!std::isfinite(static_cast<float>(*value))) throw std::runtime_error("TN_NATIVE_SSR_PARAMETER: " + name);
            if ((name == "maxDistance" && *value <= 0) ||
                ((name == "thickness" || name == "opacity" || name == "intensity" || name == "maxLuminance") && *value < 0) ||
                (name == "quality" && (*value < 0 || *value > 1)) ||
                (name == "blurQuality" && (*value < 1 || *value > 3 || *value != std::floor(*value))) ||
                ((name == "reflectNonMetals" || name == "binaryRefine") && *value != 0 && *value != 1))
                throw std::runtime_error("TN_NATIVE_SSR_PARAMETER: " + name);
        }
        found->second[0] = static_cast<float>(*value);
    }
    return found->second[0];
}

std::vector<std::pair<std::string, g::Node>> tslConstants() {
    std::vector<std::pair<std::string, g::Node>> constants{{"EPSILON", g::float_(1e-6)}, {"INFINITY", g::float_(1e6)},
            {"PI", g::float_(3.141592653589793)}, {"PI2", g::float_(6.283185307179586)},
            {"TWO_PI", g::float_(6.283185307179586)}, {"HALF_PI", g::float_(1.5707963267948966)},
            {"positionLocal", g::positionLocal()},
            {"positionWorld", g::varying("positionWorld", Type::vec(3))},
            {"normalViewGeometry", g::varying("normalViewGeometry", Type::vec(3))},
            {"cameraViewMatrix", g::uniform("viewMatrix", Type::mat(4, 4))},
            {"modelWorldMatrix", g::uniform("modelMatrix", Type::mat(4, 4))},
            {"instanceIndex", g::instanceIndex()},
            {"vertexIndex", g::builtin("vertexIndex")},
            {"screenUV", g::screenUV()},
            // three's materialColor is the material's colour, a vec3 (MaterialNode COLOR, type 'color').
            // Each is the material's uniform times its map, as MaterialNode builds it: the program that lowers the
            // node supplies the map (standard.cpp materialInputs); with none the bare uniform stays.
            {"materialColor", g::swizzle(g::materialInput("diffuse", Type::vec(4)), "xyz")},
            {"materialEmissive", g::materialInput("emissive", Type::vec(3))},
            {"materialMetalness", g::materialInput("metalness", Type::f32())},
            {"materialRoughness", g::materialInput("roughness", Type::f32())},
            // three's time (utils/Timer.js): the frame's elapsed seconds, a uniform the renderer fills.
            {"time", g::uniform("time", Type::f32())},
            // three's deltaTime: seconds since the frame before, filled the same way.
            {"deltaTime", g::uniform("deltaTime", Type::f32())}};
    // The node constants tslCall also answers by name; neither takes a serial.
    uint64_t serial = 0;
    for (const char* name : {"cameraPosition", "cameraProjectionMatrix", "cameraWorldMatrix", "cameraNear", "cameraFar", "screenSize", "depth",
                             "positionGeometry", "normalWorld", "normalView", "positionWorldDirection", "positionViewDirection", "screenCoordinate",
                             "normalGeometry", "tangentGeometry", "normalLocal", "tangentLocal", "positionPrevious",
                             "normalWorldGeometry"})
        constants.emplace_back(name, tslCall(name, nullptr, {}, serial));
    // setGroup's markers (UniformGroupNode r185): a uniform takes one and stays as it is.
    for (const char* name : {"frameGroup", "renderGroup", "objectGroup"})
        constants.emplace_back(name, g::uniform(name, Type::f32()));
    // viewportLinearDepth = linearDepth(viewportDepthTexture()).
    constants.emplace_back("viewportLinearDepth",
                           tslCall("linearDepth", nullptr, {TslArg::of(g::viewportDepth(g::screenUV()))}, serial));
    return constants;
}

void tslSetUniform(const g::Node& uniform, const double* values, size_t count) {
    std::vector<double> lanes;
    for (size_t i = 0; i < count; ++i) {
        if (!std::isfinite(values[i])) throw std::runtime_error("TN_TSL_UNIFORM_VALUE: values must be finite");
        lanes.push_back(values[i]);
    }
    g::setUniformValues(uniform, std::move(lanes));
}

std::vector<TslScopes::Body>& TslScopes::open() {
    if (open_.empty()) throw std::runtime_error("statement outside Fn");
    return open_;
}

bool TslScopes::call(const std::string& name, const TslArg* receiver, const std::vector<TslArg>& args, g::Node& out) {
    const auto arity = [&](size_t n) {
        if (args.size() != n) throw std::runtime_error("expected " + std::to_string(n) + " arguments");
    };
    const auto self = [&] {
        if (!receiver || receiver->kind != TslArg::Kind::Node || !receiver->node)
            throw std::runtime_error("invalid TSL receiver");
        return receiver->node;
    };
    const auto body = [&](size_t i, const char* form) {
        const auto& value = args.at(i);
        if (value.kind != TslArg::Kind::Node || !value.node || value.node->kind != g::Kind::Body)
            throw std::runtime_error(std::string(form) + " callback must contain statements");
        return value.node->body;
    };
    out = {};
    if (name == "scope:open") {
        arity(0);
        open_.push_back({++nextBody_, {}});
        return true;
    }
    if (name == "scope:close") {
        if (args.size() > 1) throw std::runtime_error("expected at most 1 argument");
        Body closed = std::move(open().back());
        open_.pop_back();
        for (auto it = ifs_.begin(); it != ifs_.end();) it = it->second.body == closed.id ? ifs_.erase(it) : std::next(it);
        if (closed.statements.empty() && !args.empty()) {
            out = input(args[0]);
            return true;
        }
        auto node = std::make_shared<g::NodeData>();
        node->kind = g::Kind::Body;
        node->body = std::move(closed.statements);
        // A callback that runs statements and returns a value (Fn(() => { a.addAssign(b); return a; }))
        // keeps the value: the Body lowers its statements, then yields args[0].
        if (!args.empty()) node->args = {input(args[0])};
        out = node;
        return true;
    }
    if (name == "textureStore") {
        arity(3);
        auto& statements = open().back().statements;
        g::Node target;
        if (args[0].kind == TslArg::Kind::Object) {
            uint64_t serial = 0;
            target = tslCall("storageTexture", nullptr, {args[0]}, serial);
        } else target = input(args[0]);
        if (!target || target->kind != g::Kind::StorageTexture || !target->object)
            throw std::runtime_error("textureStore needs a StorageTexture or storageTexture node");
        auto node = std::make_shared<g::NodeData>(*target);
        node->kind = g::Kind::TextureStore; node->type = Type{};
        node->args = {input(args[1]), input(args[2])};
        statements.push_back(node); out = target;
        return true;
    }
    if (name == "atomicAdd" || name == "atomicStore") {
        arity(2);
        auto& statements = open().back().statements;
        const auto target = input(args[0]);
        if (target->kind != g::Kind::StorageElement ||
            !(target->atomic ? *target->atomic : target->bits == 1) ||
            (target->type != Type::u32() && target->type != Type::i32()))
            throw std::runtime_error(name + " requires an integer element of a toAtomic storage buffer");
        auto node = std::make_shared<g::NodeData>();
        node->kind = name == "atomicAdd" ? g::Kind::AtomicAdd : g::Kind::AtomicStore;
        node->type = name == "atomicAdd" ? target->type : Type{};
        node->args = {target, input(args[1])}; statements.push_back(node); out = node;
        return true;
    }
    if (name == "increment" || name == "decrement" || name == "incrementBefore" || name == "decrementBefore") {
        if (receiver) arity(0); else arity(1);
        const TslArg target = receiver ? *receiver : args[0];
        if (target.kind != TslArg::Kind::Node || !target.node ||
            (target.node->kind != g::Kind::Var && target.node->kind != g::Kind::StorageElement))
            throw std::runtime_error("TN_NATIVE_TSL_TYPE: " + name + " requires a variable or storage element");
        const bool before = name.ends_with("Before");
        g::Node previous;
        if (!before) {
            uint64_t serial = 0;
            const TslArg snapshot = TslArg::of(tslCall("int", nullptr, {target}, serial));
            call("toVar", &snapshot, {}, previous);
        }
        uint64_t serial = 0;
        const TslArg value = TslArg::of(tslCall(name.starts_with("increment") ? "add" : "sub", &target, {TslArg::of(1.0)}, serial));
        call("assign", &target, {value}, out);
        if (!before) out = previous;
        return true;
    }
    if (name == "toVar") {
        arity(0);
        auto& statements = open().back().statements;
        g::Block block;
        out = block.var(input(*receiver)).declaration;
        statements.push_back(out);
        return true;
    }
    // r185's `<op>Assign` (TSLCore.js): assign(this, op(this, value)).
    if (name == "addAssign" || name == "subAssign" || name == "mulAssign" || name == "divAssign") {
        arity(1);
        uint64_t serial = 0;  // the arithmetic names no uniform or render texture
        const TslArg value = TslArg::of(tslCall(name.substr(0, 3), receiver, args, serial));
        return call("assign", receiver, {value}, out);
    }
    if (name == "assign") {
        arity(1);
        auto& statements = open().back().statements;
        const auto target = self();
        // three's `v.y.assign(x)` / `v.xz.assign(w)`: the swizzle of a variable. A read of the variable is the
        // swizzle's argument here; lowering takes the variable itself and keeps the other lanes.
        if (target->kind == g::Kind::Swizzle && target->args.size() == 1 && target->args[0]->kind == g::Kind::VarRead &&
            target->args[0]->args[0]->kind == g::Kind::Var) {
            g::Block block;
            block.assign(g::swizzle(target->args[0]->args[0], target->lanes), input(args[0]));
            statements.push_back(block.node()->body[0]);
            out = target;
            return true;
        }
        if (target->kind != g::Kind::Var && target->kind != g::Kind::StorageElement)
            throw std::runtime_error(target->kind == g::Kind::Attribute || target->kind == g::Kind::Varying
                ? name + " requires a variable or storage element: " + target->name +
                      " is a read here (normalLocal, tangentLocal and positionPrevious are not written back)"
                : name + " requires a variable or storage element");
        const g::Node value = input(args[0]);
        g::Block block;
        block.assign(target, value);
        statements.push_back(block.node()->body[0]);
        out = target;
        return true;
    }
    // r185's Break(), Continue() and Return(): a loop or kernel ends early. `Return(value)` belongs to a Fn that
    // returns one, which the live graph does not build yet, so it refuses by name.
    if (name == "Break" || name == "Continue" || name == "Return") {
        if (name == "Return" && !args.empty()) throw std::runtime_error("Return(value) is not supported; Return() ends a compute kernel");
        arity(0);
        auto node = std::make_shared<g::NodeData>();
        node->kind = name == "Break" ? g::Kind::Break : name == "Continue" ? g::Kind::Continue : g::Kind::Return;
        open().back().statements.push_back(node);
        out = node;
        return true;
    }
    if (name == "If") {
        arity(2);
        auto& current = open().back();
        auto node = std::make_shared<g::NodeData>();
        node->kind = g::Kind::If;
        node->args = {input(args[0])};
        node->body = body(1, "If");
        ifs_[node.get()] = {current.id, current.statements.size(), node, 0};
        current.statements.push_back(node);
        out = node;
        return true;
    }
    if (name == "Else" || name == "ElseIf") {
        const bool chained = name == "ElseIf";
        arity(chained ? 2 : 1);
        auto& current = open().back();
        const auto branch = self();
        const auto at = ifs_.find(branch.get());
        if (branch->kind != g::Kind::If || at == ifs_.end() || at->second.body != current.id ||
            at->second.index >= current.statements.size() || current.statements[at->second.index] != at->second.root ||
            !branch->otherwise.empty())
            throw std::runtime_error(name + " requires an If in this stack");
        // A chain is copied along its else-branches, so a node already handed out is never changed.
        const std::function<g::Node(const g::Node&, size_t, std::vector<g::Node>)> withTip =
            [&](const g::Node& node, size_t depth, std::vector<g::Node> tail) {
                auto copy = std::make_shared<g::NodeData>(*node);
                copy->otherwise = depth == 0 ? std::move(tail) : std::vector<g::Node>{withTip(node->otherwise[0], depth - 1, std::move(tail))};
                return g::Node(copy);
            };
        g::Node inner;
        if (chained) {
            auto made = std::make_shared<g::NodeData>();
            made->kind = g::Kind::If;
            made->args = {input(args[0])};
            made->body = body(1, "ElseIf");
            inner = made;
        }
        const IfSlot slot = at->second;
        const g::Node root = withTip(slot.root, slot.depth, chained ? std::vector<g::Node>{inner} : body(0, "Else"));
        current.statements[slot.index] = root;
        ifs_.erase(at);
        if (chained) ifs_[inner.get()] = {current.id, slot.index, root, slot.depth + 1};
        out = chained ? inner : root;
        return true;
    }
    if (name == "Loop:index") {
        if (args.size() > 1) throw std::runtime_error("expected at most 1 argument");
        // three's Loop({ type }): the index is an int (default) or a uint; the engine counts in i32 and converts.
        const std::string kind = args.empty() ? "int" : args[0].kind == TslArg::Kind::String ? args[0].text : "";
        if (kind != "int" && kind != "uint") throw std::runtime_error("Loop type must be int or uint");
        auto index = std::make_shared<g::NodeData>();
        index->kind = g::Kind::LoopIndex;
        index->type = kind == "uint" ? Type::u32() : Type::i32();
        out = index;
        return true;
    }
    if (name == "Loop") {
        // Loop(end, index, body [, start [, step]]): the index runs start, start + step, ... while below `end`.
        // `end` and `start` are whole numbers or integer nodes, `step` a positive whole number.
        if (args.size() < 3 || args.size() > 5) throw std::runtime_error("expected 3 to 5 arguments");
        auto& statements = open().back().statements;
        const auto whole = [](double n) { return n >= 0 && n <= std::numeric_limits<int32_t>::max() && n == std::floor(n); };
        const auto integer = [&](const TslArg& a, const char* what) -> g::Node {
            if (a.kind == TslArg::Kind::Number) {
                if (!whole(a.number)) throw std::runtime_error(std::string("expected a nonnegative i32 ") + what);
                return g::int_(static_cast<int32_t>(a.number));
            }
            if (a.kind != TslArg::Kind::Node || !a.node) throw std::runtime_error(std::string("expected a nonnegative i32 ") + what);
            if (a.node->type == Type::i32()) return a.node;
            auto convert = std::make_shared<g::NodeData>();
            convert->kind = g::Kind::Convert;
            convert->type = Type::i32();
            convert->args = {a.node};
            return convert;
        };
        const g::Node end = integer(args[0], "count");
        const g::Node start = args.size() > 3 ? integer(args[3], "start") : g::int_(0);
        const double step = args.size() > 4 && args[4].kind == TslArg::Kind::Number ? args[4].number : 1;
        if (args.size() > 4 && args[4].kind != TslArg::Kind::Number) throw std::runtime_error("Loop step must be a whole number");
        if (step < 1 || !whole(step)) throw std::runtime_error("Loop step must be a positive whole number");
        const auto constant = [](const g::Node& n) { return n->kind == g::Kind::Constant; };
        g::Node count = end;
        const bool startZero = constant(start) && start->bits == 0;
        if (!startZero) count = g::sub(end, start);
        if (step > 1) count = g::div(g::add(count, g::int_(static_cast<int32_t>(step) - 1)), g::int_(static_cast<int32_t>(step)));
        if (args[1].kind != TslArg::Kind::Node || !args[1].node || args[1].node->kind != g::Kind::LoopIndex)
            throw std::runtime_error("Loop needs the index Loop:index made");
        auto node = std::make_shared<g::NodeData>();
        node->kind = g::Kind::Loop;
        node->args = {count, args[1].node};
        if (!startZero || step > 1) {
            node->args.push_back(start);
            node->args.push_back(g::int_(static_cast<int32_t>(step)));
        }
        node->body = body(2, "Loop");
        statements.push_back(node);
        out = node;
        return true;
    }
    return false;
}

}  // namespace tn::abi
