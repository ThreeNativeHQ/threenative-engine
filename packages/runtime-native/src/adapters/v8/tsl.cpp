#include "tsl.h"
#include "engine/abi/abi_internal.h"
#include "engine/abi/tsl_call.h"

#include <cmath>
#include <functional>
#include <limits>
#include <stdexcept>
#include <utility>

namespace tn::adapters::v8adapter {
namespace g = engine::shader::graph;
using engine::shader::Type;

struct Tsl::Wrapper {
    Tsl* owner;
    g::Node node;
    g::Storage storage;
    abi::TslArg attribute;  // storage(attribute, ...): the engine BufferAttribute it reads
    std::string elementType;  // and the element type it was declared with
    v8::Global<v8::Object> object;
};
struct Tsl::Call {
    Tsl* owner;
    std::string name;
    bool method;
};

namespace {
struct JsFailure {}; // A callback/property getter already threw; preserve its JS exception.

v8::Local<v8::String> str(v8::Isolate* isolate, const std::string& text) {
    return v8::String::NewFromUtf8(isolate, text.c_str()).ToLocalChecked();
}
std::string text(v8::Isolate* isolate, v8::Local<v8::Value> value) {
    if (!value->IsString())
        throw std::runtime_error("expected a string");
    v8::String::Utf8Value utf8(isolate, value);
    return std::string(*utf8, utf8.length());
}
double number(v8::Local<v8::Value> value) {
    if (!value->IsNumber() || !std::isfinite(value.As<v8::Number>()->Value()))
        throw std::runtime_error("expected a finite number");
    return value.As<v8::Number>()->Value();
}
int32_t count(v8::Local<v8::Value> value) {
    const double n = number(value);
    if (n < 0 || n > std::numeric_limits<int32_t>::max() || n != std::floor(n))
        throw std::runtime_error("expected a nonnegative i32 count");
    return static_cast<int32_t>(n);
}
Type type(const std::string& name) {
    if (name == "float")
        return Type::f32();
    if (name == "int")
        return Type::i32();
    if (name == "uint")
        return Type::u32();
    if (name == "vec2")
        return Type::vec(2);
    if (name == "vec3")
        return Type::vec(3);
    if (name == "vec4")
        return Type::vec(4);
    if (name == "mat3")
        return Type::mat(3, 3);
    if (name == "mat4")
        return Type::mat(4, 4);
    throw std::runtime_error("unsupported TSL type: " + name);
}
v8::Local<v8::Function> callback(v8::Local<v8::Value> value) {
    if (!value->IsFunction())
        throw std::runtime_error("expected a callback");
    return value.As<v8::Function>();
}
} // namespace

Tsl::Tsl(v8::Isolate* isolate) : isolate_(isolate) {}

Tsl::~Tsl() {
    v8::HandleScope scope(isolate_);
    for (Wrapper* w : wrappers_) {
        w->object.Get(isolate_)->SetInternalField(1, v8::External::New(isolate_, nullptr));
        w->object.Reset();
        delete w;
    }
}

Tsl::Wrapper* Tsl::wrapper(v8::Local<v8::Value> value) const {
    if (!value->IsObject())
        return nullptr;
    const auto object = value.As<v8::Object>();
    if (object->InternalFieldCount() != 2)
        return nullptr;
    const auto tag = object->GetInternalField(0);
    const auto handle = object->GetInternalField(1);
    if (!tag->IsValue() || !tag.As<v8::Value>()->IsExternal() || tag.As<v8::External>()->Value() != this ||
        !handle->IsValue() || !handle.As<v8::Value>()->IsExternal())
        return nullptr;
    return static_cast<Wrapper*>(handle.As<v8::External>()->Value());
}

bool Tsl::unwrap(v8::Local<v8::Value> value, g::Node& node) const {
    Wrapper* w = wrapper(value);
    if (!w || !w->node)
        return false;
    node = w->node;
    return true;
}

g::Node Tsl::input(v8::Local<v8::Value> value) const {
    if (value->IsNumber())
        return g::float_(number(value));
    Wrapper* w = wrapper(value);
    if (!w || !w->node)
        throw std::runtime_error("expected a TSL node or number");
    return w->node->kind == g::Kind::Var ? g::Var{w->node, w->node->type}.read() : w->node;
}

abi::TslArg Tsl::argument(const std::string& name, int index, int count, v8::Local<v8::Value> value) const {
    const auto ctx = isolate_->GetCurrentContext();
    Wrapper* w = wrapper(value);
    // A texture names its map by the object's `name`; textureLoad also takes a texture node.
    const bool texture = index == 0 && name == "texture";
    const bool textureLoad = index == 0 && name == "textureLoad";
    if (w && !texture && (w->node || !textureLoad)) return abi::TslArg::of(w->node);
    // pmremTexture prefilters the texture object itself and texture3D samples it, and storage reads the attribute's buffer, not a map the material
    // names; reflector takes its target and virtual camera.
    if ((index == 0 && (name == "pmremTexture" || name == "texture3D" || name == "storage")) || (index < 2 && name == "reflector")) {
        tn_handle_t handle{};
        const binding::Object* object = engineObject && engineObject(value, handle) ? abi::objectOf(handle) : nullptr;
        if (object == nullptr) throw std::runtime_error(name + " needs an engine object as argument " + std::to_string(index));
        return abi::TslArg::objectOf(object->cls, object->ptr);
    }
    if (value->IsNumber()) return abi::TslArg::of(value.As<v8::Number>()->Value());
    if (value->IsString()) return abi::TslArg::of(text(isolate_, value));
    if (!value->IsObject()) return abi::TslArg::other();
    const auto object = value.As<v8::Object>();
    // texture(engineTexture, uv) samples that texture itself; a plain object names a material map.
    if (texture) {
        tn_handle_t handle{};
        const binding::Object* object = engineObject && engineObject(value, handle) ? abi::objectOf(handle) : nullptr;
        if (object != nullptr) return abi::TslArg::objectOf(object->cls, object->ptr);
    }
    if (texture || textureLoad) {
        v8::Local<v8::Value> label;
        if (!object->Get(ctx, str(isolate_, "name")).ToLocal(&label)) throw JsFailure{};
        return abi::TslArg::named(text(isolate_, label));
    }
    if (name == "color" && count == 1) {
        double components[3];
        for (int i = 0; i < 3; ++i) {
            v8::Local<v8::Value> component;
            if (!object->Get(ctx, str(isolate_, std::string(1, "rgb"[i]))).ToLocal(&component)) throw JsFailure{};
            components[i] = number(component);
        }
        return abi::TslArg::rgbOf(components[0], components[1], components[2]);
    }
    // A three VectorN or Color as an operand is its constant, as TSL's nodeObject makes of it.
    const auto lane = [&](const char* key, double& out) {
        v8::Local<v8::Value> component;
        if (!object->Get(ctx, str(isolate_, key)).ToLocal(&component)) throw JsFailure{};
        if (!component->IsNumber()) return false;
        out = component.As<v8::Number>()->Value();
        return true;
    };
    double lanes[4];
    if (lane("x", lanes[0]) && lane("y", lanes[1])) {
        uint8_t count = 2;
        if (lane("z", lanes[2])) count = lane("w", lanes[3]) ? 4 : 3;
        return abi::TslArg::vectorOf(count, lanes);
    }
    if (lane("r", lanes[0]) && lane("g", lanes[1]) && lane("b", lanes[2]))
        return abi::TslArg::rgbOf(lanes[0], lanes[1], lanes[2]);
    return abi::TslArg::other();
}

v8::Local<v8::Object> Tsl::wrap(g::Node node) {
    if (node) for (const auto* w : wrappers_) if (w->node == node) return w->object.Get(isolate_);
    const auto object = nodeTemplate_.Get(isolate_)->NewInstance(isolate_->GetCurrentContext()).ToLocalChecked();
    auto* w = new Wrapper{this, std::move(node), {}, {}};
    object->SetInternalField(0, v8::External::New(isolate_, this));
    object->SetInternalField(1, v8::External::New(isolate_, w));
    w->object.Reset(isolate_, object);
    wrappers_.insert(w);
    w->object.SetWeak(
        w,
        [](const v8::WeakCallbackInfo<Wrapper>& info) {
            Wrapper* w = info.GetParameter();
            w->owner->wrappers_.erase(w);
            w->object.Reset();
            delete w;
        },
        v8::WeakCallbackType::kParameter);
    return object;
}

g::Node Tsl::capture(v8::Local<v8::Function> callback, v8::Local<v8::Value> argument) {
    g::Node node;
    scopes_.call("scope:open", nullptr, {}, node);
    v8::Local<v8::Value> result;
    const auto ctx = isolate_->GetCurrentContext();
    const bool ok =
        callback
            ->Call(ctx, v8::Undefined(isolate_), argument.IsEmpty() ? 0 : 1, argument.IsEmpty() ? nullptr : &argument)
            .ToLocal(&result);
    std::vector<abi::TslArg> returned;
    if (ok && !result->IsUndefined()) returned.push_back(this->argument("scope:close", 0, 1, result));
    scopes_.call("scope:close", nullptr, returned, node);
    if (!ok)
        throw JsFailure{};
    return node;
}

v8::Local<v8::FunctionTemplate> Tsl::function(v8::Local<v8::Context> context, const char* name, bool method) {
    auto data = std::make_unique<Call>(Call{this, name, method});
    const auto fn = v8::FunctionTemplate::New(isolate_, dispatch, v8::External::New(isolate_, data.get()));
    fn->SetClassName(str(isolate_, name));
    calls_.push_back(std::move(data));
    return fn;
}

void Tsl::dispatch(const v8::FunctionCallbackInfo<v8::Value>& info) {
    const auto* call = static_cast<Call*>(info.Data().As<v8::External>()->Value());
    try {
        call->owner->call(*call, info);
    } catch (const JsFailure&) {
        // The original JS exception is still pending.
    } catch (const std::exception& error) {
        info.GetIsolate()->ThrowException(
            v8::Exception::TypeError(str(info.GetIsolate(), "TN_TSL " + call->name + ": " + error.what())));
    }
}

void Tsl::call(const Call& call, const v8::FunctionCallbackInfo<v8::Value>& info) {
    const std::string& name = call.name;
    const auto ctx = isolate_->GetCurrentContext();
    const auto arity = [&](int n) {
        if (info.Length() != n)
            throw std::runtime_error("expected " + std::to_string(n) + " arguments");
    };
    Wrapper* self = call.method ? wrapper(info.This()) : nullptr;
    if (call.method && !self)
        throw std::runtime_error("invalid TSL receiver");
    const auto arg = [&](int i) { return input(info[i]); };
    const auto lhs = [&] { return call.method ? input(info.This()) : arg(0); };
    const auto rhs = [&] { return arg(call.method ? 0 : 1); };
    const auto result = [&](g::Node node) { info.GetReturnValue().Set(wrap(std::move(node))); };

    if (name == "setName") {
        arity(1);
        const std::string label = text(isolate_, info[0]);
        if (label.empty())
            throw std::runtime_error("empty name");
        if (!self->node)
            self->storage.name = label;
        else if (self->node->kind == g::Kind::Uniform)
            self->node = g::uniform(label, self->node->type, self->node->values);
        else
            throw std::runtime_error("setName requires a uniform or storage buffer");
        info.GetReturnValue().Set(info.This());
        return;
    }
    if (name == "element") {
        arity(1);
        if (self->node)
            throw std::runtime_error("element requires a storage buffer");
        if (self->attribute.kind == abi::TslArg::Kind::Object) {
            return result(abi::tslCall("storage:object", nullptr,
                {self->attribute, abi::TslArg::of(self->elementType), abi::TslArg::of(self->storage.name),
                 abi::TslArg::of(arg(0))}, serial_));
        }
        if (self->storage.name.empty())
            throw std::runtime_error("storage buffer needs setName");
        return result(self->storage.element(arg(0)));
    }
    // r185's toReadOnly()/toReadWrite() pick the buffer's access; the engine reads what a stage reads.
    if (name == "toReadOnly" || name == "toReadWrite") {
        arity(0);
        if (self->node)
            throw std::runtime_error(name + " requires a storage buffer");
        info.GetReturnValue().Set(info.This());
        return;
    }
    // The statement forms run against the shared open bodies (abi::TslScopes).
    const auto scoped = [&](const char* form, const abi::TslArg* receiver, std::vector<abi::TslArg> args) {
        g::Node node;
        scopes_.call(form, receiver, args, node);
        return node;
    };
    const auto statement = [&] {
        if (scopes_.depth() == 0)
            throw std::runtime_error("statement outside Fn");
    };
    const abi::TslArg receiver = call.method ? abi::TslArg::of(self->node) : abi::TslArg{};
    if (name == "toVar") {
        arity(0);
        return result(scoped("toVar", &receiver, {}));
    }
    if (name == "assign" || name == "addAssign" || name == "subAssign" || name == "mulAssign" || name == "divAssign") {
        arity(1);
        scoped(name.c_str(), &receiver, {abi::TslArg::of(arg(0))});
        info.GetReturnValue().Set(info.This());
        return;
    }
    if (name == "Else") {
        arity(1);
        statement();
        self->node = scoped("Else", &receiver, {abi::TslArg::of(capture(callback(info[0])))});
        info.GetReturnValue().Set(info.This());
        return;
    }
    if (name == "Fn") {
        arity(1);
        const auto graph = wrap(capture(callback(info[0])));
        // Fn builds once at definition. Calling the returned function only returns that graph.
        const auto fn =
            v8::Function::New(
                ctx, [](const v8::FunctionCallbackInfo<v8::Value>& call) { call.GetReturnValue().Set(call.Data()); },
                graph)
                .ToLocalChecked();
        info.GetReturnValue().Set(fn);
        return;
    }
    if (name == "If") {
        arity(2);
        statement();
        const auto condition = arg(0);
        return result(scoped("If", nullptr, {abi::TslArg::of(condition), abi::TslArg::of(capture(callback(info[1])))}));
    }
    if (name == "Loop") {
        arity(2);
        statement();
        const abi::TslArg n = abi::TslArg::of(static_cast<double>(count(info[0])));
        const auto body = callback(info[1]);
        const auto index = scoped("Loop:index", nullptr, {});
        const auto inputs = v8::Object::New(isolate_);
        inputs->Set(ctx, str(isolate_, "i"), wrap(index)).Check();
        return result(scoped("Loop", nullptr, {n, abi::TslArg::of(index), abi::TslArg::of(capture(body, inputs))}));
    }
    // TSL storage(attribute, type, count): a storage buffer over the engine BufferAttribute's data.
    if (name == "storage") {
        if (info.Length() < 2 || info.Length() > 3)
            throw std::runtime_error("expected an attribute, a type and an optional count");
        abi::TslArg attribute = argument(name, 0, info.Length(), info[0]);
        if (attribute.kind != abi::TslArg::Kind::Object)
            throw std::runtime_error("storage needs an engine BufferAttribute");
        const std::string elementType = text(isolate_, info[1]);
        const auto object = wrap({});
        Wrapper* buffer = wrapper(object);
        buffer->storage = g::storage("", type(elementType));
        buffer->attribute = std::move(attribute);
        buffer->elementType = elementType;
        info.GetReturnValue().Set(object);
        return;
    }
    if (name == "instancedArray") {
        arity(2);
        if (count(info[0]) == 0)
            throw std::runtime_error("storage count must be positive");
        const auto object = wrap({});
        wrapper(object)->storage = g::storage("", type(text(isolate_, info[1])));
        info.GetReturnValue().Set(object);
        return;
    }
    if (name == "setResolutionScale") {
        arity(1);
        const auto source = lhs();
        const double scale = number(info[0]);
        if (source->kind != g::Kind::RenderTexture || scale <= 0)
            throw std::runtime_error("resolution scale requires a render texture and positive scale");
        auto target = std::make_shared<g::NodeData>(*source);
        target->scale = scale;
        self->node = target;
        info.GetReturnValue().Set(info.This());
        return;
    }
    // `effect.__effect(name[, value])`: a live effect's scalar uniform, which the facade publishes as
    // three's `effect.radius.value` (engine/abi/tsl_call.h tslEffectParameter).
    if (name == "__effect") {
        if (info.Length() < 1 || info.Length() > 2) throw std::runtime_error("expected a parameter name and an optional value");
        const double value = info.Length() == 2 ? number(info[1]) : 0;
        info.GetReturnValue().Set(v8::Number::New(isolate_,
            abi::tslEffectParameter(lhs(), text(isolate_, info[0]), info.Length() == 2 ? &value : nullptr)));
        return;
    }
    if (name == "setUniform") {
        // three's `uniform.value = x` (tsl-uniforms.ts): the node, then one value per lane.
        Wrapper* target = info.Length() > 0 ? wrapper(info[0]) : nullptr;
        if (!target || !target->node) throw std::runtime_error("setUniform needs a uniform node");
        std::vector<double> values;
        for (int i = 1; i < info.Length(); ++i) values.push_back(number(info[i]));
        abi::tslSetUniform(target->node, values.data(), values.size());
        return;
    }
    // Everything else is the shared table (engine/abi/tsl_call.cpp), which the Wasm back end calls too.
    std::vector<abi::TslArg> args;
    for (int i = 0; i < info.Length(); ++i) args.push_back(argument(name, i, info.Length(), info[i]));
    g::Node node = abi::tslCall(name, call.method ? &receiver : nullptr, args, serial_);
    if (!node) throw std::runtime_error("unsupported operation");
    return result(std::move(node));
}

void Tsl::install(v8::Local<v8::Context> context, v8::Local<v8::Object> target) {
    const auto node = v8::ObjectTemplate::New(isolate_);
    node->SetInternalFieldCount(2);
    for (const char* name : {"add", "sub", "mul", "div", "negate", "lessThan", "greaterThan", "equal", "setName",
                             "toVar", "assign", "element", "toReadOnly", "toReadWrite", "Else", "abs", "sin", "cos", "floor", "fract",
                             "sqrt", "exp", "exp2", "log2", "normalize", "length", "min", "max", "pow",
                             "step", "dot", "distance", "cross", "reflect", "mix", "clamp", "smoothstep", "select",
                             "sample", "setResolutionScale", "__effect", "oneMinus", "dispose",
                             "flipX", "flipY", "flipZ", "flipW", "addAssign", "subAssign", "mulAssign",
                             "divAssign", "dFdx", "dFdy", "sign", "cbrt", "atan", "mod", "fwidth", "transformDirection",
                             "level", "lengthSq", "setGroup"})
        node->Set(str(isolate_, name), function(context, name, true));
    // three's swizzles: every 1-4 lane combination of xyzw, rgba or stpq, read as xyzw lanes.
    const std::function<void(const char*, const std::string&, const std::string&)> swizzles =
        [&](const char* set, const std::string& alias, const std::string& lanes) {
            if (!alias.empty()) {
                auto data = std::make_unique<Call>(Call{this, "swizzle:" + lanes, true});
                node->SetAccessorProperty(str(isolate_, alias),
                    v8::FunctionTemplate::New(isolate_, dispatch, v8::External::New(isolate_, data.get())));
                calls_.push_back(std::move(data));
            }
            if (alias.size() < 4)
                for (int i = 0; i < 4; ++i) swizzles(set, alias + set[i], lanes + "xyzw"[i]);
        };
    for (const char* set : {"xyzw", "rgba", "stpq"}) swizzles(set, "", "");
    nodeTemplate_.Reset(isolate_, node);
    const auto module = v8::Object::New(isolate_);
    for (const char* name : {"float",      "int",   "uint",    "vec2",      "vec3",   "vec4",     "uniform",
                             "attribute",  "uv",    "texture", "Fn",        "If",     "Loop",     "instancedArray", "storage",
                             "add",        "sub",   "mul",     "div",       "negate", "lessThan", "greaterThan",
                             "equal",      "abs",   "sin",     "cos",       "floor",  "fract",    "sqrt",
                             "exp",        "exp2",  "log2",    "normalize", "length", "atan",     "min",      "max",
                             "mod", "fwidth", "saturation", "mat2", "hash",
                             "pow",        "step",  "dot",     "distance",  "cross",  "mix",      "clamp",
                             "smoothstep", "select", "nodeObject", "color", "ivec2", "textureLoad", "reflect", "convertToTexture",
                             "dFdx", "dFdy", "lengthSq", "viewportSharedTexture", "viewportDepthTexture", "linearDepth",
                             "ao", "denoise", "smaa", "bloom", "oneMinus", "varying", "setUniform",
                             "mx_noise_float", "mx_worley_noise_vec2", "pmremTexture", "reflector", "transformDirection",
                             "texture3D", "getViewPosition", "transformNormalToView", "property"})
        module->Set(context, str(isolate_, name), function(context, name, false)->GetFunction(context).ToLocalChecked())
            .Check();
    for (auto& [name, node] : abi::tslConstants())
        module->Set(context, str(isolate_, name), wrap(std::move(node))).Check();
    // The existing V8 hosts execute bundled scripts with globals; they have no ES module resolver.
    target->Set(context, str(isolate_, "tsl"), module).Check();
}

} // namespace tn::adapters::v8adapter
