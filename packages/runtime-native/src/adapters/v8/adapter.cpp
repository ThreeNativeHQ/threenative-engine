#include "adapter.h"
#include "tsl.h"

#include <algorithm>
#include <deque>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

#include "engine/abi/bindings.h"
#include "engine/abi/abi_internal.h"
#include "engine/foundation/ThreeConstants.h"
#include "engine/scene/material.h"
#include "engine/scene/texture.h"
#include "engine/animation/skinning/skeleton.h"
#include "engine/animation/property_binding.h"
#include "engine/foundation/buffers.h"
#include "engine/scene/geometry.h"

namespace tn::adapters::v8adapter {

// An engine wrapper's internal fields: 0 is its Wrapper record, 1.. cache the wrappers of its fixed
// members (`position`, `rotation`, ...) so a read is a slot load, not a property lookup. A
// PropertyBinding has two fields, so the count also tells the two kinds apart.
constexpr int kWrapperFields = 8;

struct Adapter::Wrapper {
    Adapter* adapter;
    tn_handle_t handle;
    v8::Global<v8::Object> object;
    std::set<std::string> callbacks;  // JS callbacks set on the object, by name
    bool held = false;                // strong: another engine object references this one
};


// What the engine holds for one JS callback: which wrapper's function to call. Deleted by the
// engine's release, once, when it drops the callback.
struct Adapter::CallbackData {
    Adapter* adapter;
    uint64_t wrapper;
    std::string name;
};

namespace {

// The class registry is read once for names only; every call still goes through the C ABI.
const tn::binding::Registry& registry() {
    static const tn::binding::Registry classes = [] {
        tn::binding::Registry r;
        tn::binding::registerAll(r);
        return r;
    }();
    return classes;
}

v8::Local<v8::String> str(v8::Isolate* isolate, const std::string& s) {
    return v8::String::NewFromUtf8(isolate, s.c_str(), v8::NewStringType::kNormal, static_cast<int>(s.size()))
        .ToLocalChecked();
}

Adapter* adapterOf(const v8::FunctionCallbackInfo<v8::Value>& info) {
    return static_cast<Adapter*>(info.Data().As<v8::External>()->Value());
}

// The shape of nearly every hot call (`position.set(x, y, z)`, `rotation.x = v`): up to eight plain
// numbers. They cross as a stack array, with none of the containers the general converter builds.
constexpr int kFastArguments = 8;
bool numericArguments(const v8::FunctionCallbackInfo<v8::Value>& info, tn_value_t (&out)[kFastArguments]) {
    const int count = info.Length();
    if (count > kFastArguments) return false;
    for (int i = 0; i < count; ++i) {
        if (!info[i]->IsNumber()) return false;
        out[i] = tn_value_t{};
        out[i].kind = TN_VALUE_NUMBER;
        out[i].number = info[i].As<v8::Number>()->Value();
    }
    return true;
}

void throwStatus(v8::Isolate* isolate, tn_diagnostic_t& diagnostic) {
    const std::string message = diagnostic.message ? diagnostic.message : "TN_ABI error";
    tn_diagnostic_release(&diagnostic);
    isolate->ThrowException(v8::Exception::TypeError(str(isolate, message)));
}

/**
 * three's Material.setValues: a Color member takes `set(value)`, every other member is assigned.
 * Upstream warns and skips a key the material does not have; here an unbound member reads
 * undefined, so the key is refused by name rather than dropped.
 */
void setValues(Adapter& a, v8::Isolate* isolate, const char* cls, v8::Local<v8::Object> material, v8::Local<v8::Object> values) {
    const auto ctx = isolate->GetCurrentContext();
    v8::Local<v8::Array> keys;
    if (!values->GetOwnPropertyNames(ctx).ToLocal(&keys)) return;
    for (uint32_t i = 0; i < keys->Length(); ++i) {
        v8::Local<v8::Value> name, value, current;
        if (!keys->Get(ctx, i).ToLocal(&name) || !values->Get(ctx, name).ToLocal(&value)) return;
        if (value->IsUndefined()) continue;
        if (!material->Get(ctx, name).ToLocal(&current)) return;
        if (current->IsUndefined()) {
            v8::String::Utf8Value key(isolate, name);
            isolate->ThrowException(v8::Exception::TypeError(str(isolate,
                std::string("TN_NATIVE_MATERIAL_PARAMETER: ") + cls + "." + *key + " is not a bound material property")));
            return;
        }
        tn_handle_t member{};
        if (a.unwrap(current, member) && member.type == tn_type_id("Color")) {
            v8::Local<v8::Value> set, ignored;
            if (!current.As<v8::Object>()->Get(ctx, str(isolate, "set")).ToLocal(&set) || !set->IsFunction() ||
                !set.As<v8::Function>()->Call(ctx, current, 1, &value).ToLocal(&ignored))
                return;
        } else if (material->Set(ctx, name, value).IsNothing()) {
            return;
        }
    }
}

// A typed array's values read from its bytes by element type: a Get() per element costs ~60 ns,
// 9 ms for one 192x192 RGBA texture re-sent each frame. False for a type this does not list.
bool typedNumbers(v8::Local<v8::TypedArray> array, std::vector<double>& out) {
    std::vector<uint8_t> bytes(array->ByteLength());
    if (array->CopyContents(bytes.data(), bytes.size()) != bytes.size()) return false;
    const auto read = [&]<typename T>() {
        for (std::size_t k = 0; k < out.size(); ++k) {
            T value;
            std::memcpy(&value, bytes.data() + k * sizeof(T), sizeof(T));
            out[k] = static_cast<double>(value);
        }
        return true;
    };
    if (array->IsFloat32Array()) return read.template operator()<float>();
    if (array->IsFloat64Array()) return read.template operator()<double>();
    if (array->IsUint8Array() || array->IsUint8ClampedArray()) return read.template operator()<uint8_t>();
    if (array->IsInt8Array()) return read.template operator()<int8_t>();
    if (array->IsUint16Array()) return read.template operator()<uint16_t>();
    if (array->IsInt16Array()) return read.template operator()<int16_t>();
    if (array->IsUint32Array()) return read.template operator()<uint32_t>();
    if (array->IsInt32Array()) return read.template operator()<int32_t>();
    return false;
}

// JS -> ABI values. Arrays become number arrays (fromArray), engine wrappers become handles.
bool toValues(Adapter& a, const v8::FunctionCallbackInfo<v8::Value>& info, std::vector<tn_value_t>& out,
              std::deque<std::string>& texts, std::vector<std::vector<double>>& arrays,
              std::deque<std::vector<tn_value_t>>& values, int limit = -1) {
    a.noteGenericArguments();
    v8::Isolate* isolate = info.GetIsolate();
    v8::Local<v8::Context> ctx = isolate->GetCurrentContext();
    arrays.reserve(info.Length());
    for (int i = 0; i < info.Length() && (limit < 0 || i < limit); ++i) {
        v8::Local<v8::Value> arg = info[i];
        tn_value_t v{};
        tn_handle_t h{};
        if (arg->IsNumber()) {
            v.kind = TN_VALUE_NUMBER;
            v.number = arg.As<v8::Number>()->Value();
        } else if (arg->IsBoolean()) {
            v.kind = TN_VALUE_BOOL;
            v.boolean = arg->IsTrue() ? 1 : 0;
        } else if (arg->IsString()) {
            v8::String::Utf8Value utf8(isolate, arg);
            texts.emplace_back(*utf8 ? *utf8 : "");
            v.kind = TN_VALUE_STRING;
            v.text = texts.back().c_str();
            v.count = texts.back().size();
        } else if (a.unwrap(arg, h)) {
            v.kind = TN_VALUE_HANDLE;
            v.handle = h;
            a.holdIfCallback(h);
        } else if (arg->IsArray()) {
            v8::Local<v8::Array> array = arg.As<v8::Array>();
            // Object arrays (intersectObjects, Skeleton) use the same handle values as scalar args.
            values.emplace_back(array->Length());
            auto& elements = values.back();
            for (uint32_t k = 0; k < array->Length(); ++k) {
                v8::Local<v8::Value> e;
                if (!array->Get(ctx, k).ToLocal(&e)) return false;
                if (e->IsNumber()) { elements[k].kind = TN_VALUE_NUMBER; elements[k].number = e.As<v8::Number>()->Value(); }
                else if (a.unwrap(e, h)) { elements[k].kind = TN_VALUE_HANDLE; elements[k].handle = h; a.holdIfCallback(h); }
                else if (e->IsString()) {
                    // Euler.toArray()'s order slot, handed back to a fromArray.
                    v8::String::Utf8Value utf8(isolate, e);
                    texts.emplace_back(*utf8 ? *utf8 : "");
                    elements[k].kind = TN_VALUE_STRING;
                    elements[k].text = texts.back().c_str();
                    elements[k].count = texts.back().size();
                }
                else return false;
            }
            if (std::all_of(elements.begin(), elements.end(), [](const auto& e) { return e.kind == TN_VALUE_NUMBER; })) {
                std::vector<double> numbers; for (const auto& e : elements) numbers.push_back(e.number);
                arrays.push_back(std::move(numbers)); v.kind = TN_VALUE_NUMBERS;
                v.numbers = arrays.back().data(); v.count = arrays.back().size();
            } else { v.kind = TN_VALUE_ARRAY; v.values = elements.data(); v.count = elements.size(); }
        } else if (arg->IsTypedArray()) {
            // The template builds attributes from real typed arrays (`new Float32Array(...)`), so a
            // typed array crosses as its binary64 values, exactly as a plain array of them would.
            v8::Local<v8::TypedArray> array = arg.As<v8::TypedArray>();
            std::vector<double> numbers(array->Length());
            if (!typedNumbers(array, numbers)) {
                for (uint32_t k = 0; k < array->Length(); ++k) {
                    v8::Local<v8::Value> e;
                    if (!array->Get(ctx, k).ToLocal(&e) || !e->IsNumber()) return false;
                    numbers[k] = e.As<v8::Number>()->Value();
                }
            }
            arrays.push_back(std::move(numbers));
            v.kind = TN_VALUE_NUMBERS;
            v.numbers = arrays.back().data();
            v.count = arrays.back().size();
            // The array's type crosses with it, so `new BufferAttribute(new Uint32Array(...))` keeps
            // three's storage (a binding that has no use for it ignores it).
            v.text = array->IsFloat32Array() ? "Float32Array" : array->IsUint16Array() ? "Uint16Array"
                : array->IsUint32Array() ? "Uint32Array" : array->IsUint8Array() ? "Uint8Array"
                : array->IsInt8Array() ? "Int8Array" : array->IsInt16Array() ? "Int16Array"
                : array->IsInt32Array() ? "Int32Array" : array->IsFloat64Array() ? "Float64Array" : nullptr;
        } else if (arg->IsObject() && !arg->IsFunction() && arg.As<v8::Object>()->InternalFieldCount() == 0) {
            // A plain options object (`{ depth, bevelEnabled }`): own enumerable keys whose values are
            // numbers, booleans, strings or native objects. An undefined value is left out, as three
            // reads `options.x !== undefined`; anything else is refused.
            v8::Local<v8::Object> object = arg.As<v8::Object>();
            v8::Local<v8::Array> keys;
            if (!object->GetOwnPropertyNames(ctx).ToLocal(&keys)) return false;
            values.emplace_back();
            auto& pairs = values.back();
            pairs.reserve(keys->Length() * 2);
            for (uint32_t k = 0; k < keys->Length(); ++k) {
                v8::Local<v8::Value> key, e;
                if (!keys->Get(ctx, k).ToLocal(&key) || !object->Get(ctx, key).ToLocal(&e)) return false;
                if (e->IsUndefined()) continue;
                tn_value_t field{};
                if (e->IsNumber()) { field.kind = TN_VALUE_NUMBER; field.number = e.As<v8::Number>()->Value(); }
                else if (e->IsBoolean()) { field.kind = TN_VALUE_BOOL; field.boolean = e->IsTrue() ? 1 : 0; }
                else if (e->IsString()) {
                    v8::String::Utf8Value utf8(isolate, e);
                    texts.emplace_back(*utf8 ? *utf8 : "");
                    field.kind = TN_VALUE_STRING; field.text = texts.back().c_str(); field.count = texts.back().size();
                } else if (a.unwrap(e, h)) { field.kind = TN_VALUE_HANDLE; field.handle = h; a.holdIfCallback(h); }
                else return false;
                v8::String::Utf8Value name(isolate, key);
                texts.emplace_back(*name ? *name : "");
                tn_value_t keyValue{};
                keyValue.kind = TN_VALUE_STRING; keyValue.text = texts.back().c_str(); keyValue.count = texts.back().size();
                pairs.push_back(keyValue);
                pairs.push_back(field);
            }
            v.kind = TN_VALUE_RECORD; v.values = pairs.data(); v.count = pairs.size() / 2;
        } else if (!arg->IsUndefined() && !arg->IsNull()) {
            return false;
        }
        out.push_back(v);
    }
    return true;
}

v8::Local<v8::Value> fromValue(Adapter& a, const tn_value_t& v) {
    v8::Isolate* isolate = a.isolate();
    switch (v.kind) {
        case TN_VALUE_NULL: return v8::Null(isolate);
        case TN_VALUE_UNDEFINED: return v8::Undefined(isolate);
        case TN_VALUE_NUMBER: return v8::Number::New(isolate, v.number);
        case TN_VALUE_BOOL: return v8::Boolean::New(isolate, v.boolean != 0);
        case TN_VALUE_STRING: return str(isolate, std::string(v.text, v.count));
        case TN_VALUE_HANDLE: return a.wrap(v.handle);
        case TN_VALUE_ARRAY: {
            auto array = v8::Array::New(isolate, int(v.count));
            for (uint32_t i = 0; i < v.count; ++i) {
                const auto written = array->CreateDataProperty(isolate->GetCurrentContext(), i, fromValue(a, v.values[i]));
                if (written.IsNothing() || !written.FromJust()) return v8::Undefined(isolate);
            }
            return array;
        }
        case TN_VALUE_RECORD: {
            auto record = v8::Object::New(isolate);
            for (uint64_t i = 0; i < v.count; ++i) {
                const auto& key = v.values[i * 2];
                record->CreateDataProperty(isolate->GetCurrentContext(), str(isolate, std::string(key.text, key.count)),
                    fromValue(a, v.values[i * 2 + 1])).Check();
            }
            return record;
        }
        case TN_VALUE_NUMBERS: {
            // three exposes `elements` and `toArray()` as plain arrays, so JS gets a plain array.
            v8::Local<v8::Array> array = v8::Array::New(isolate, static_cast<int>(v.count));
            v8::Local<v8::Context> ctx = isolate->GetCurrentContext();
            for (uint64_t k = 0; k < v.count; ++k) {
                const auto written = array->CreateDataProperty(ctx, static_cast<uint32_t>(k), v8::Number::New(isolate, v.numbers[k]));
                if (written.IsNothing() || !written.FromJust()) return v8::Undefined(isolate);
            }
            return array;
        }
        default: return v8::Undefined(isolate);
    }
}

struct MethodData {
    Adapter* adapter;
    std::string name;
    // A fixed member's wrapper, kept on the owner's JS object under this private key: the member
    // names the same native object for the owner's life, so later reads cross nothing.
    v8::Global<v8::Private> cache;
    bool intersections = false;  // intersectObject(s): the only methods whose third argument is a target array
    int slot = 0;                // a fixed member's internal-field cache slot; 0: none left, use the private key
    tn::abi::SetterSlot setter;  // the numeric write's setter for the class last written
    bool own = false;            // a read-only fixed member: once read, it becomes an own data property of the wrapper, as three defines it
    uint16_t type = 0;           // the catalog type whose wrappers own that slot: a getter borrowed by another class must not read it
    std::string cls;             // the registry class, for a method that reads its binding
    bool readable = false;       // a holder tail the binding also reads (`morphAttributes.position`)
};

// three defines position, rotation, quaternion and scale as read-only own data properties. Once a
// wrapper has handed out its fixed member, the member becomes one here too, so later reads are
// property loads that never enter the accessor.
void adopt(v8::Isolate* isolate, v8::Local<v8::Context> ctx, v8::Local<v8::Object> self, const std::string& name,
           v8::Local<v8::Value> value) {
    if (!value->IsObject()) return;
    self->DefineOwnProperty(ctx, str(isolate, name), value, v8::ReadOnly).FromMaybe(false);
}

// three's `attribute.array` is the attribute's own typed array, so `array[i] = v` is a write to the
// attribute. Here it is a typed array over the engine's storage: the store is leased while the view
// lives, so it cannot reallocate under it, and the lease is returned at the next safe point, because
// V8 may run a backing store's deleter on any thread.
struct ArrayViewHold {
    std::shared_ptr<engine::BufferStore> store;
};
std::mutex& releasedViewsMutex() {
    static std::mutex mutex;
    return mutex;
}
std::vector<ArrayViewHold*>& releasedViews() {
    static std::vector<ArrayViewHold*> views;
    return views;
}
void releaseArrayView(void*, size_t, void* hold) {
    std::lock_guard<std::mutex> lock(releasedViewsMutex());
    releasedViews().push_back(static_cast<ArrayViewHold*>(hold));
}
void drainArrayViews() {
    std::vector<ArrayViewHold*> released;
    {
        std::lock_guard<std::mutex> lock(releasedViewsMutex());
        released.swap(releasedViews());
    }
    for (ArrayViewHold* hold : released) {
        hold->store->releaseLease();
        delete hold;
    }
}
bool isAttributeClass(const std::string& cls) {
    return cls == "BufferAttribute" || cls == "Float32BufferAttribute" || cls == "Uint16BufferAttribute" ||
           cls == "Uint32BufferAttribute" || cls == "InstancedBufferAttribute";
}
v8::Local<v8::Value> arrayView(v8::Isolate* isolate, const std::shared_ptr<engine::BufferStore>& store) {
    store->acquireLease();
    auto* hold = new ArrayViewHold{store};
    auto backing = v8::ArrayBuffer::NewBackingStore(store->data(), store->byteLength(), releaseArrayView, hold);
    v8::Local<v8::ArrayBuffer> buffer = v8::ArrayBuffer::New(isolate, std::move(backing));
    const size_t n = store->count();
    switch (store->scalar()) {
        case engine::Scalar::F32: return v8::Float32Array::New(buffer, 0, n);
        case engine::Scalar::F64: return v8::Float64Array::New(buffer, 0, n);
        case engine::Scalar::I8: return v8::Int8Array::New(buffer, 0, n);
        case engine::Scalar::U8: return v8::Uint8Array::New(buffer, 0, n);
        case engine::Scalar::I16: return v8::Int16Array::New(buffer, 0, n);
        case engine::Scalar::U16: return v8::Uint16Array::New(buffer, 0, n);
        case engine::Scalar::I32: return v8::Int32Array::New(buffer, 0, n);
        case engine::Scalar::U32: return v8::Uint32Array::New(buffer, 0, n);
    }
    return v8::Undefined(isolate);
}

// `new` on a JS subclass (`class Voice extends Object3D`) constructs its nearest engine ancestor:
// new.target's constructor chain is walked to the first function this adapter installed, so the
// subclass's own name (or a bundler's rename of it) never reaches tn_construct.
v8::Local<v8::Function> engineConstructor(v8::Isolate* isolate, v8::Local<v8::Value> target,
    const std::unordered_map<uint16_t, v8::Global<v8::FunctionTemplate>>& classes) {
    const v8::Local<v8::Value> newTarget = target;
    v8::Local<v8::Context> ctx = isolate->GetCurrentContext();
    while (target->IsFunction()) {
        v8::String::Utf8Value name(isolate, target.As<v8::Function>()->GetName());
        const auto cls = classes.find(*name ? tn_type_id(*name) : 0);
        v8::Local<v8::Function> installed;
        if (cls != classes.end() && cls->second.Get(isolate)->GetFunction(ctx).ToLocal(&installed) &&
            installed->StrictEquals(target))
            return installed;
        target = target.As<v8::Object>()->GetPrototype();
    }
    return newTarget.As<v8::Function>();
}

}  // namespace

Adapter::Adapter(v8::Isolate* isolate, tn_context_t* context) : tsl_(std::make_unique<Tsl>(isolate)), isolate_(isolate), context_(context) {
    v8::HandleScope scope(isolate_);
    v8::Local<v8::ObjectTemplate> instance = v8::ObjectTemplate::New(isolate_);
    instance->SetInternalFieldCount(kWrapperFields);
    instanceTemplate_.Reset(isolate_, instance);
    isolate_->AddGCPrologueCallback(promote, this);
    tsl_->engineObject = [this](v8::Local<v8::Value> value, tn_handle_t& handle) { return unwrap(value, handle); };
}

Adapter::~Adapter() {
    isolate_->RemoveGCPrologueCallback(promote, this);
    // The isolate may outlive this adapter: wrappers left alive stop pointing at it, and the engine
    // stops calling into it.
    for (auto& [k, w] : wrappers_) {
        for (const std::string& name : w->callbacks) {
            tn_diagnostic_t diagnostic{nullptr, 0};
            tn_set_callback(w->handle, name.c_str(), nullptr, nullptr, nullptr, &diagnostic);
            tn_diagnostic_release(&diagnostic);
        }
        w->object.Reset();
        delete w;
    }
}

void Adapter::forget(uint64_t k) {
    const auto it = wrappers_.find(k);
    if (it == wrappers_.end()) return;
    tn_diagnostic_t diagnostic{nullptr, 0};
    // The engine must not call a function whose wrapper is gone.
    for (const std::string& name : it->second->callbacks) {
        tn_set_callback(it->second->handle, name.c_str(), nullptr, nullptr, nullptr, &diagnostic);
        tn_diagnostic_release(&diagnostic);
    }
    tn_object_release(it->second->handle, &diagnostic);
    tn_diagnostic_release(&diagnostic);
    delete it->second;
    wrappers_.erase(it);
}

v8::Local<v8::Value> Adapter::wrap(tn_handle_t handle) {
    v8::EscapableHandleScope scope(isolate_);
    const uint64_t k = key(handle);
    if (const auto it = wrappers_.find(k); it != wrappers_.end()) {
        return scope.Escape(it->second->object.Get(isolate_));
    }
    v8::Local<v8::Context> ctx = isolate_->GetCurrentContext();
    v8::Local<v8::Object> object;
    const auto cls = classes_.find(handle.type);
    if (cls != classes_.end()) {
        object = cls->second.Get(isolate_)->InstanceTemplate()->NewInstance(ctx).ToLocalChecked();
    } else {
        object = instanceTemplate_.Get(isolate_)->NewInstance(ctx).ToLocalChecked();
    }
    auto* w = new Wrapper{this, handle, {}};
    track(w, object);
    wrappers_[k] = w;
    return scope.Escape(object);
}

bool Adapter::unwrap(v8::Local<v8::Value> value, tn_handle_t& out) const {
    if (!value->IsObject()) return false;
    v8::Local<v8::Object> object = value.As<v8::Object>();
    if (object->InternalFieldCount() != kWrapperFields) return false;
    auto* w = static_cast<Wrapper*>(object->GetAlignedPointerFromInternalField(0));
    if (!w || w->adapter != this) return false;
    out = w->handle;
    return true;
}

void Adapter::track(Wrapper* w, v8::Local<v8::Object> object) {
    object->SetAlignedPointerInInternalField(0, w);
    w->object.Reset(isolate_, object);
    weak(w);
}

void Adapter::weak(Wrapper* w) {
    w->held = false;
    w->object.SetWeak(w, [](const v8::WeakCallbackInfo<Wrapper>& info) {
        Wrapper* wrapper = info.GetParameter();
        wrapper->object.Reset();
        wrapper->adapter->forget(key(wrapper->handle));
    }, v8::WeakCallbackType::kParameter);
}

void Adapter::strong(Wrapper* w) {
    if (w->held) return;
    w->held = true;
    w->object.ClearWeak();
}

void Adapter::holdIfCallback(tn_handle_t handle) {
    const auto it = wrappers_.find(key(handle));
    if (it != wrappers_.end() && !it->second->callbacks.empty()) strong(it->second);
}

// ponytail: both passes visit every wrapper; keep a dirty set if wrapper counts make this show in a profile.
void Adapter::collect() {
    drainArrayViews();
    for (auto& [k, w] : wrappers_) {
        if (tn::abi::engineReferences(w->handle) > 0) strong(w);
        else if (w->held) weak(w);
    }
}

void Adapter::promote(v8::Isolate*, v8::GCType, v8::GCCallbackFlags, void* data) {
    // Only up: a wrapper the engine took since the last safe point survives this collection. Down
    // waits for collect(), which also ends holdIfCallback's hold.
    auto* a = static_cast<Adapter*>(data);
    for (auto& [k, w] : a->wrappers_) {
        if (!w->held && tn::abi::engineReferences(w->handle) > 0) a->strong(w);
    }
}

tn_status_t Adapter::invokeCallback(void* context, const tn_value_t* args, uint32_t count, char* error, uint32_t capacity) {
    const auto* data = static_cast<CallbackData*>(context);
    Adapter& a = *data->adapter;
    v8::Isolate* isolate = a.isolate_;
    v8::Isolate::Scope isolateScope(isolate);  // the engine calls from outside any JS frame
    v8::HandleScope scope(isolate);
    v8::Local<v8::Context> ctx = a.context_v8_.Get(isolate);
    v8::Context::Scope contextScope(ctx);
    const auto it = a.wrappers_.find(data->wrapper);
    if (it == a.wrappers_.end()) {
        std::snprintf(error, capacity, "TN_V8_CALLBACK_GONE %s", data->name.c_str());
        return TN_ERROR_INVALID_STATE;
    }
    v8::Local<v8::Object> self = it->second->object.Get(isolate);
    v8::Local<v8::Value> fn;
    if (!self->GetPrivate(ctx, a.callbackKeys_.at(data->name).Get(isolate)).ToLocal(&fn) || !fn->IsFunction()) return TN_OK;
    std::vector<v8::Local<v8::Value>> argv;
    argv.reserve(count);
    for (uint32_t i = 0; i < count; ++i) argv.push_back(args[i].kind == TN_VALUE_NULL ? v8::Null(isolate).As<v8::Value>() : fromValue(a, args[i]));
    v8::TryCatch tryCatch(isolate);
    if (fn.As<v8::Function>()->Call(ctx, self, static_cast<int>(argv.size()), argv.data()).IsEmpty()) {
        v8::String::Utf8Value message(isolate, tryCatch.Exception());
        std::snprintf(error, capacity, "%s", *message ? *message : "the callback threw");
        return TN_ERROR_INVALID_STATE;
    }
    return TN_OK;
}

// The listener arrays by type, created on demand.
static v8::Local<v8::Object> listenerTable(v8::Isolate* isolate, v8::Local<v8::Object> self, v8::Local<v8::Private> key,
                                           bool create) {
    const auto ctx = isolate->GetCurrentContext();
    v8::Local<v8::Value> table;
    if (self->GetPrivate(ctx, key).ToLocal(&table) && table->IsObject()) return table.As<v8::Object>();
    if (!create) return {};
    auto made = v8::Object::New(isolate, v8::Null(isolate), nullptr, nullptr, 0);
    self->SetPrivate(ctx, key, made).Check();
    return made;
}

bool Adapter::callListeners(Adapter& a, v8::Local<v8::Object> self, v8::Local<v8::Object> event) {
    v8::Isolate* isolate = a.isolate_;
    const auto ctx = isolate->GetCurrentContext();
    v8::Local<v8::Value> type;
    if (!event->Get(ctx, str(isolate, "type")).ToLocal(&type)) return false;
    const auto table = listenerTable(isolate, self, a.listenersKey_.Get(isolate), false);
    v8::Local<v8::Value> list;
    if (table.IsEmpty() || !table->Get(ctx, type).ToLocal(&list) || !list->IsArray()) return true;
    // three dispatches over a copy, with `target` set while the listeners run.
    const auto copy = list.As<v8::Array>();
    std::vector<v8::Local<v8::Value>> listeners(copy->Length());
    for (uint32_t i = 0; i < copy->Length(); ++i)
        if (!copy->Get(ctx, i).ToLocal(&listeners[i])) return false;
    if (event->Set(ctx, str(isolate, "target"), self).IsNothing()) return false;
    for (const auto& listener : listeners) {
        v8::Local<v8::Value> argument = event, ignored;
        if (!listener.As<v8::Function>()->Call(ctx, self, 1, &argument).ToLocal(&ignored)) return false;
    }
    return !event->Set(ctx, str(isolate, "target"), v8::Null(isolate)).IsNothing();
}

tn_status_t Adapter::invokeEvent(void* context, const tn_value_t* args, uint32_t count, char* error, uint32_t capacity) {
    const auto* data = static_cast<CallbackData*>(context);
    Adapter& a = *data->adapter;
    v8::Isolate* isolate = a.isolate_;
    v8::Isolate::Scope isolateScope(isolate);
    v8::HandleScope scope(isolate);
    v8::Local<v8::Context> ctx = a.context_v8_.Get(isolate);
    v8::Context::Scope contextScope(ctx);
    const auto it = a.wrappers_.find(data->wrapper);
    if (it == a.wrappers_.end()) return TN_OK;  // the wrapper and its listeners are gone
    v8::Local<v8::Value> event = count == 1 ? fromValue(a, args[0]) : v8::Local<v8::Value>();
    if (event.IsEmpty() || !event->IsObject()) {
        std::snprintf(error, capacity, "TN_V8_EVENT_INVALID %s", data->name.c_str());
        return TN_ERROR_INVALID_STATE;
    }
    v8::TryCatch tryCatch(isolate);
    if (!callListeners(a, it->second->object.Get(isolate), event.As<v8::Object>())) {
        v8::String::Utf8Value message(isolate, tryCatch.Exception());
        std::snprintf(error, capacity, "%s", *message ? *message : "the listener threw");
        return TN_ERROR_INVALID_STATE;
    }
    return TN_OK;
}

// addEventListener / removeEventListener / hasEventListener / dispatchEvent, by `d->name`.
void Adapter::eventListener(const v8::FunctionCallbackInfo<v8::Value>& info) {
    auto* d = static_cast<MethodData*>(info.Data().As<v8::External>()->Value());
    Adapter& a = *d->adapter;
    v8::Isolate* isolate = info.GetIsolate();
    v8::Local<v8::Context> ctx = isolate->GetCurrentContext();
    tn_handle_t h{};
    if (!a.unwrap(info.This(), h)) {
        isolate->ThrowException(v8::Exception::TypeError(str(isolate, "not an engine object")));
        return;
    }
    const v8::Local<v8::Private> listeners = a.listenersKey_.Get(isolate);
    if (d->name == "dispatchEvent") {
        if (!info[0]->IsObject()) {
            isolate->ThrowException(v8::Exception::TypeError(str(isolate, "dispatchEvent needs an event object")));
            return;
        }
        callListeners(a, info.This(), info[0].As<v8::Object>());
        return;
    }
    if (!info[0]->IsString() || !info[1]->IsFunction()) {
        isolate->ThrowException(v8::Exception::TypeError(str(isolate, d->name + " needs a type and a function")));
        return;
    }
    v8::String::Utf8Value typeText(isolate, info[0]);
    const std::string type(*typeText, typeText.length());
    const auto table = listenerTable(isolate, info.This(), listeners, d->name == "addEventListener");
    v8::Local<v8::Value> found;
    v8::Local<v8::Array> list;
    if (!table.IsEmpty() && table->Get(ctx, info[0]).ToLocal(&found) && found->IsArray()) list = found.As<v8::Array>();
    int at = -1;
    for (uint32_t i = 0; !list.IsEmpty() && i < list->Length(); ++i) {
        v8::Local<v8::Value> item;
        if (list->Get(ctx, i).ToLocal(&item) && item->StrictEquals(info[1])) at = static_cast<int>(i);
    }
    if (d->name == "hasEventListener") {
        info.GetReturnValue().Set(at >= 0);
        return;
    }
    const auto& native = registry().at(d->cls).events;
    tn_diagnostic_t diagnostic{nullptr, 0};
    if (d->name == "addEventListener") {
        if (at >= 0) return;
        if (list.IsEmpty()) {
            list = v8::Array::New(isolate);
            // The engine calls back for a native event type only once something listens to it.
            if (native.contains(type)) {
                auto* data = new CallbackData{&a, key(h), type};
                if (tn_set_callback(h, type.c_str(), &Adapter::invokeEvent, data,
                                    [](void* c) { delete static_cast<CallbackData*>(c); }, &diagnostic) != TN_OK) {
                    delete data;
                    throwStatus(isolate, diagnostic);
                    return;
                }
            }
            table->Set(ctx, info[0], list).Check();
        }
        list->Set(ctx, list->Length(), info[1]).Check();
        return;
    }
    if (at < 0) return;  // removeEventListener of a listener that is not there
    auto rest = v8::Array::New(isolate);
    for (uint32_t i = 0; i < list->Length(); ++i)
        if (static_cast<int>(i) != at) rest->Set(ctx, rest->Length(), list->Get(ctx, i).ToLocalChecked()).Check();
    if (rest->Length() > 0) {
        table->Set(ctx, info[0], rest).Check();
        return;
    }
    table->Delete(ctx, info[0]).Check();
    if (native.contains(type) && tn_set_callback(h, type.c_str(), nullptr, nullptr, nullptr, &diagnostic) != TN_OK)
        throwStatus(isolate, diagnostic);
}

void Adapter::getCallback(const v8::FunctionCallbackInfo<v8::Value>& info) {
    auto* d = static_cast<MethodData*>(info.Data().As<v8::External>()->Value());
    v8::Isolate* isolate = info.GetIsolate();
    v8::Local<v8::Value> fn;
    if (info.This()->GetPrivate(isolate->GetCurrentContext(), d->adapter->callbackKeys_.at(d->name).Get(isolate)).ToLocal(&fn) &&
        fn->IsFunction()) {
        info.GetReturnValue().Set(fn);
    } else {
        info.GetReturnValue().SetNull();
    }
}

void Adapter::setCallback(const v8::FunctionCallbackInfo<v8::Value>& info) {
    auto* d = static_cast<MethodData*>(info.Data().As<v8::External>()->Value());
    Adapter& a = *d->adapter;
    v8::Isolate* isolate = info.GetIsolate();
    v8::Local<v8::Context> ctx = isolate->GetCurrentContext();
    tn_handle_t h{};
    if (!a.unwrap(info.This(), h)) return;
    Wrapper* w = a.wrappers_.at(key(h));
    v8::Local<v8::Private> slot = a.callbackKeys_.at(d->name).Get(isolate);
    v8::Local<v8::Value> value = info[0];
    tn_diagnostic_t diagnostic{nullptr, 0};
    if (value->IsNullOrUndefined()) {
        info.This()->DeletePrivate(ctx, slot).Check();
        w->callbacks.erase(d->name);
        if (tn_set_callback(h, d->name.c_str(), nullptr, nullptr, nullptr, &diagnostic) != TN_OK) throwStatus(isolate, diagnostic);
        return;
    }
    if (!value->IsFunction()) {
        isolate->ThrowException(v8::Exception::TypeError(str(isolate, d->name + " must be a function or null")));
        return;
    }
    auto* data = new CallbackData{&a, key(h), d->name};
    if (tn_set_callback(h, d->name.c_str(), &Adapter::invokeCallback, data,
                        [](void* c) { delete static_cast<CallbackData*>(c); }, &diagnostic) != TN_OK) {
        delete data;  // a refused callback was never taken
        throwStatus(isolate, diagnostic);
        return;
    }
    // The function lives on the wrapper: wrapper -> closure is a JS edge the collector sees.
    info.This()->SetPrivate(ctx, slot, value).Check();
    w->callbacks.insert(d->name);
    a.strong(w);  // until the next safe point finds the object referenced or not
}

void Adapter::install(v8::Local<v8::Context> context, v8::Local<v8::Object> target) {
    tsl_->install(context, target);
    v8::HandleScope scope(isolate_);
    context_v8_.Reset(isolate_, context);
    v8::Local<v8::External> self = v8::External::New(isolate_, this);
    for (const auto& [name, binding] : registry()) {
        const uint16_t type = tn_type_id(name.c_str());
        // Every supported class is a global, constructible or not: a class the engine only hands out
        // (an AnimationAction from clipAction) still needs its prototype for `instanceof` and
        // members, and `new` on it is refused by tn_construct with a diagnostic naming it.
        if (type == 0) continue;
        v8::Local<v8::FunctionTemplate> ctor = v8::FunctionTemplate::New(
            isolate_,
            [](const v8::FunctionCallbackInfo<v8::Value>& info) {
                v8::Isolate* isolate = info.GetIsolate();
                if (!info.IsConstructCall()) {
                    isolate->ThrowException(v8::Exception::TypeError(str(isolate, "use new")));
                    return;
                }
                Adapter& a = *adapterOf(info);
                v8::String::Utf8Value cls(isolate, engineConstructor(isolate, info.NewTarget(), a.classes_)->GetName());
                // three's Material(parameters): construct, then setValues. Every other class takes
                // its constructor arguments through the ABI.
                tn_handle_t argument{};
                const bool parameters = tn::binding::isMaterialClass(*cls) && info.Length() == 1 && info[0]->IsObject() &&
                                        !info[0]->IsArray() && !info[0]->IsTypedArray() && !a.unwrap(info[0], argument);
                std::vector<tn_value_t> args;
                std::deque<std::string> texts;
                               std::deque<std::vector<tn_value_t>> values;
                std::vector<std::vector<double>> arrays;
                if (!parameters && !toValues(a, info, args, texts, arrays, values)) {
                    isolate->ThrowException(v8::Exception::TypeError(str(isolate, "TN_ABI_VALUE: unsupported argument")));
                    return;
                }
                tn_handle_t h{};
                tn_diagnostic_t diagnostic{nullptr, 0};
                if (tn_construct(a.context(), *cls, args.data(), static_cast<uint32_t>(args.size()), &h, &diagnostic) != TN_OK) {
                    throwStatus(isolate, diagnostic);
                    return;
                }
                // The construct call's own receiver becomes the wrapper: `new` returns it.
                v8::Local<v8::Object> object = info.This();
                auto* w = new Wrapper{&a, h, {}};
                a.track(w, object);
                a.wrappers_[key(h)] = w;
                if (parameters) setValues(a, isolate, *cls, object, info[0].As<v8::Object>());
            },
            self);
        ctor->SetClassName(str(isolate_, name));
        ctor->InstanceTemplate()->SetInternalFieldCount(kWrapperFields);
        v8::Local<v8::ObjectTemplate> proto = ctor->PrototypeTemplate();
        for (const auto& [method, fn] : binding.methods) {
            (void)fn;
            // EventDispatcher's methods keep JS listeners; the adapter installs them below.
            if (!binding.events.empty() && (method == "addEventListener" || method == "removeEventListener" ||
                                            method == "hasEventListener" || method == "dispatchEvent"))
                continue;
            auto* data = keep(new MethodData{this, method});
            data->intersections = method == "intersectObject" || method == "intersectObjects";
            proto->Set(str(isolate_, method),
                       v8::FunctionTemplate::New(
                           isolate_,
                           [](const v8::FunctionCallbackInfo<v8::Value>& info) {
                               auto* d = static_cast<MethodData*>(info.Data().As<v8::External>()->Value());
                               v8::Isolate* isolate = info.GetIsolate();
                               tn_handle_t h{};
                               if (!d->adapter->unwrap(info.This(), h)) {
                                   isolate->ThrowException(v8::Exception::TypeError(str(isolate, "not an engine object")));
                                   return;
                               }
                               tn_value_t fast[kFastArguments];
                               if (!d->intersections && numericArguments(info, fast)) {
                                   tn_value_t result{};
                                   tn_diagnostic_t diagnostic{nullptr, 0};
                                   if (tn_invoke(h, d->name.c_str(), fast, static_cast<uint32_t>(info.Length()), &result,
                                                 &diagnostic) != TN_OK) {
                                       throwStatus(isolate, diagnostic);
                                       return;
                                   }
                                   // A chaining call answers the object it was called on: that is this wrapper.
                                   if (result.kind == TN_VALUE_HANDLE && result.handle.index == h.index &&
                                       result.handle.generation == h.generation && result.handle.type == h.type &&
                                       result.handle.context == h.context)
                                       info.GetReturnValue().Set(info.This());
                                   else
                                       info.GetReturnValue().Set(fromValue(*d->adapter, result));
                                   return;
                               }
                               std::vector<tn_value_t> args;
                               std::deque<std::string> texts;
                               std::deque<std::vector<tn_value_t>> values;
                               std::vector<std::vector<double>> arrays;
                               const bool intersections = d->intersections;
                               if (!toValues(*d->adapter, info, args, texts, arrays, values, intersections ? 2 : -1)) {
                                   isolate->ThrowException(v8::Exception::TypeError(str(isolate, "TN_ABI_VALUE: unsupported argument")));
                                   return;
                               }
                               tn_value_t result{};
                               tn_diagnostic_t diagnostic{nullptr, 0};
                               if (tn_invoke(h, d->name.c_str(), args.data(), static_cast<uint32_t>(args.size()), &result,
                                             &diagnostic) != TN_OK) {
                                   throwStatus(isolate, diagnostic);
                                   return;
                               }
                               auto converted = fromValue(*d->adapter, result);
                               if (intersections && info.Length() > 2 && !info[2]->IsUndefined()) {
                                   if (!info[2]->IsArray() || !converted->IsArray()) {
                                       isolate->ThrowException(v8::Exception::TypeError(str(isolate, "intersection target must be an array"))); return;
                                   }
                                   const auto target = info[2].As<v8::Array>();
                                   const auto hits = converted.As<v8::Array>();
                                   const auto ctx = isolate->GetCurrentContext();
                                   for (uint32_t i = 0; i < hits->Length(); ++i) {
                                       v8::Local<v8::Value> hit, push;
                                       if (!hits->Get(ctx, i).ToLocal(&hit) || !target->Get(ctx, str(isolate, "push")).ToLocal(&push)) return;
                                       if (!push->IsFunction()) {
                                           isolate->ThrowException(v8::Exception::TypeError(str(isolate, "intersection target.push is not callable"))); return;
                                       }
                                       if (push.As<v8::Function>()->Call(ctx, target, 1, &hit).IsEmpty()) return;
                                   }
                                   // Sort the caller's target, preserving exceptions from getters and sort overrides.
                                   v8::Local<v8::Function> compare;
                                   if (!v8::Function::New(ctx, [](const v8::FunctionCallbackInfo<v8::Value>& args) {
                                       const auto context = args.GetIsolate()->GetCurrentContext();
                                       const auto key = str(args.GetIsolate(), "distance");
                                       v8::Local<v8::Object> left, right;
                                       v8::Local<v8::Value> a, b;
                                       if (!args[0]->ToObject(context).ToLocal(&left) || !args[1]->ToObject(context).ToLocal(&right) ||
                                           !left->Get(context, key).ToLocal(&a) || !right->Get(context, key).ToLocal(&b)) return;
                                       const auto av = a->NumberValue(context), bv = b->NumberValue(context);
                                       if (av.IsNothing() || bv.IsNothing()) return;
                                       args.GetReturnValue().Set(av.FromJust() - bv.FromJust());
                                   }).ToLocal(&compare)) return;
                                   v8::Local<v8::Value> sorter;
                                   if (!target->Get(ctx, str(isolate, "sort")).ToLocal(&sorter)) return;
                                   if (!sorter->IsFunction()) {
                                       isolate->ThrowException(v8::Exception::TypeError(str(isolate, "intersection target.sort is not callable"))); return;
                                   }
                                   v8::Local<v8::Value> argument = compare;
                                   if (sorter.As<v8::Function>()->Call(ctx, target, 1, &argument).IsEmpty()) return;
                                   converted = target;
                               }
                               info.GetReturnValue().Set(converted);
                           },
                           v8::External::New(isolate_, data)));
        }
        struct Property {
            std::string path;
            bool settable;
            bool fixed;
        };
        std::vector<Property> properties;
        // A list getter with indexed setters (`morphTargetInfluences.0`) reads as a live array below.
        const auto indexed = [&binding](const std::string& head) {
            return std::any_of(binding.setters.begin(), binding.setters.end(), [&head](const auto& entry) {
                const std::string& path = entry.first;
                return path.size() > head.size() + 1 && path.compare(0, head.size() + 1, head + ".") == 0 &&
                       std::all_of(path.begin() + head.size() + 1, path.end(), [](char c) { return c >= '0' && c <= '9'; });
            });
        };
        std::vector<MethodData*> liveArrays;
        for (const auto& [path, getter] : binding.getters) {
            // A dotted path (`position.x`) is reached through the member object, not as a property.
            if (path.find('.') != std::string::npos) continue;
            if (indexed(path)) liveArrays.push_back(keep(new MethodData{this, path, {}}));
            else properties.push_back({path, binding.setters.count(path) > 0, false});
        }
        // `mesh.morphTargetInfluences[0] = 0.5` must reach the engine, as it reaches three's plain
        // array: the getter's list comes back as a Proxy whose set trap forwards `<head>.<index>`.
        for (MethodData* live : liveArrays) {
            proto->SetAccessorProperty(str(isolate_, live->name), v8::FunctionTemplate::New(isolate_,
                [](const v8::FunctionCallbackInfo<v8::Value>& info) {
                    auto* d = static_cast<MethodData*>(info.Data().As<v8::External>()->Value());
                    v8::Isolate* isolate = info.GetIsolate();
                    v8::Local<v8::Context> ctx = isolate->GetCurrentContext();
                    tn_handle_t h{};
                    if (!d->adapter->unwrap(info.This(), h)) return;
                    tn_value_t result{};
                    tn_diagnostic_t diagnostic{nullptr, 0};
                    if (tn_get(h, d->name.c_str(), &result, &diagnostic) != TN_OK) {
                        throwStatus(isolate, diagnostic);
                        return;
                    }
                    v8::Local<v8::Value> list = fromValue(*d->adapter, result);
                    if (!list->IsObject()) {
                        info.GetReturnValue().Set(list);
                        return;
                    }
                    v8::Local<v8::Object> handler = v8::Object::New(isolate);
                    handler->SetPrivate(ctx, v8::Private::ForApi(isolate, str(isolate, "tn:holder-owner")), info.This()).Check();
                    v8::Local<v8::Function> set = v8::Function::New(ctx,
                        [](const v8::FunctionCallbackInfo<v8::Value>& info) {
                            auto* d = static_cast<MethodData*>(info.Data().As<v8::External>()->Value());
                            v8::Isolate* isolate = info.GetIsolate();
                            v8::Local<v8::Context> ctx = isolate->GetCurrentContext();
                            v8::Local<v8::Object> target = info[0].As<v8::Object>();
                            if (!target->Set(ctx, info[1], info[2]).FromMaybe(false)) return;
                            info.GetReturnValue().Set(true);
                            v8::String::Utf8Value key(isolate, info[1]);
                            const std::string index = *key ? *key : "";
                            if (index.empty() || !std::all_of(index.begin(), index.end(), [](char c) { return c >= '0' && c <= '9'; }))
                                return; // `length` and other keys stay on the JS array, as on three's
                            if (!info[2]->IsNumber()) {
                                isolate->ThrowException(v8::Exception::TypeError(str(isolate, "TN_ABI: " + d->name + " takes numbers")));
                                return;
                            }
                            v8::Local<v8::Value> owner;
                            tn_handle_t h{};
                            if (!info.This()->GetPrivate(ctx, v8::Private::ForApi(isolate, str(isolate, "tn:holder-owner"))).ToLocal(&owner) ||
                                !owner->IsObject() || !d->adapter->unwrap(owner.As<v8::Object>(), h)) return;
                            tn_value_t value{};
                            value.kind = TN_VALUE_NUMBER;
                            value.number = info[2].As<v8::Number>()->Value();
                            tn_diagnostic_t diagnostic{nullptr, 0};
                            if (tn_set(h, (d->name + "." + index).c_str(), &value, &diagnostic) != TN_OK)
                                throwStatus(isolate, diagnostic);
                        }, v8::External::New(isolate, d)).ToLocalChecked();
                    handler->Set(ctx, str(isolate, "set"), set).Check();
                    v8::Local<v8::Proxy> proxy;
                    if (v8::Proxy::New(ctx, list.As<v8::Object>(), handler).ToLocal(&proxy)) info.GetReturnValue().Set(proxy);
                }, v8::External::New(isolate_, live)));
        }
        // Member objects read as properties too; tn_get answers them with the one alias Ref.
        for (const auto& [path, member] : binding.members) {
            properties.push_back({path, binding.setters.count(path) > 0, binding.fixedMembers.count(path) > 0});
        }
        // Internal-field slots for this class's fixed members: the hot ones every setter chain reads
        // first, then the rest in registry order, while slots last.
        std::map<std::string, int> slots;
        for (const char* hot : {"position", "rotation", "quaternion", "scale"})
            if (binding.fixedMembers.count(hot) && int(slots.size()) + 1 < kWrapperFields) slots[hot] = int(slots.size()) + 1;
        for (const auto& [path, settable, fixed] : properties)
            if (fixed && !slots.count(path) && int(slots.size()) + 1 < kWrapperFields) slots[path] = int(slots.size()) + 1;
        // three keeps a material's slots as own fields, and games find textures with
        // Object.values(material): a material instance carries its accessors as own ones too.
        std::vector<v8::Local<v8::ObjectTemplate>> slotTemplates{proto};
        if (name.ends_with("Material")) slotTemplates.push_back(ctor->InstanceTemplate());
        for (const auto& [path, settable, fixed] : properties) {
            if ((name == "MeshBasicNodeMaterial" || name == "MeshStandardNodeMaterial") && path.ends_with("Node")) {
                auto* data = keep(new MethodData{this, path, {}});
                proto->SetAccessorProperty(str(isolate_, path),
                    v8::FunctionTemplate::New(isolate_, [](const v8::FunctionCallbackInfo<v8::Value>& info) {
                        auto* d = static_cast<MethodData*>(info.Data().As<v8::External>()->Value());
                        tn_handle_t h{};
                        if (!d->adapter->unwrap(info.This(), h)) return;
                        try {
                            const auto node = tn::abi::shaderNode(h, d->name);
                            info.GetReturnValue().Set(node ? v8::Local<v8::Value>(d->adapter->tsl().wrap(node))
                                                          : v8::Local<v8::Value>(v8::Null(info.GetIsolate())));
                        } catch (const std::exception& e) {
                            info.GetIsolate()->ThrowException(v8::Exception::TypeError(str(info.GetIsolate(), e.what())));
                        }
                    }, v8::External::New(isolate_, data)),
                    v8::FunctionTemplate::New(isolate_, [](const v8::FunctionCallbackInfo<v8::Value>& info) {
                        auto* d = static_cast<MethodData*>(info.Data().As<v8::External>()->Value());
                        tn_handle_t h{};
                        if (!d->adapter->unwrap(info.This(), h)) return;
                        engine::shader::graph::Node node;
                        if (info.Length() != 1 || (!info[0]->IsNull() && !d->adapter->tsl().unwrap(info[0], node))) {
                            info.GetIsolate()->ThrowException(v8::Exception::TypeError(str(info.GetIsolate(), "TN_TSL_PROPERTY: expected a node or null")));
                            return;
                        }
                        try { tn::abi::setShaderNode(h, d->name, std::move(node)); }
                        catch (const tn::binding::Unsupported& e) {
                            info.GetIsolate()->ThrowException(v8::Exception::TypeError(str(info.GetIsolate(), e.reason)));
                        } catch (const std::exception& e) {
                            info.GetIsolate()->ThrowException(v8::Exception::TypeError(str(info.GetIsolate(), e.what())));
                        }
                    }, v8::External::New(isolate_, data)));
                continue;
            }
            auto* data = keep(new MethodData{this, path, {}});
            data->own = fixed && !settable;
            if (fixed && slots.count(path)) { data->slot = slots[path]; data->type = type; }
            else if (fixed) data->cache.Reset(isolate_, v8::Private::New(isolate_, str(isolate_, "tn:" + path)));
            for (v8::Local<v8::ObjectTemplate> on : slotTemplates)
            on->SetAccessorProperty(
                str(isolate_, path),
                v8::FunctionTemplate::New(
                    isolate_,
                    [](const v8::FunctionCallbackInfo<v8::Value>& info) {
                        auto* d = static_cast<MethodData*>(info.Data().As<v8::External>()->Value());
                        v8::Isolate* isolate = info.GetIsolate();
                        v8::Local<v8::Context> ctx = isolate->GetCurrentContext();
                        v8::Local<v8::Object> self = info.This();
                        // The slot belongs to this class's wrappers only: a getter borrowed onto another
                        // class's object (or a plain object inheriting from one) never reads or writes it.
                        tn_handle_t h{};
                        const bool owner = d->slot > 0 && d->adapter->unwrap(self, h) && h.type == d->type;
                        if (owner) {
                            v8::Local<v8::Data> cached = self->GetInternalField(d->slot);
                            if (cached->IsValue() && !cached.As<v8::Value>()->IsUndefined()) {
                                if (d->own) adopt(isolate, ctx, self, d->name, cached.As<v8::Value>());
                                info.GetReturnValue().Set(cached.As<v8::Value>());
                                return;
                            }
                        } else if (!d->cache.IsEmpty()) {
                            v8::Local<v8::Value> cached;
                            if (self->GetPrivate(ctx, d->cache.Get(isolate)).ToLocal(&cached) && !cached->IsUndefined()) {
                                info.GetReturnValue().Set(cached);
                                return;
                            }
                        }
                        if (!owner && !d->adapter->unwrap(self, h)) return;
                        tn_value_t result{};
                        tn_diagnostic_t diagnostic{nullptr, 0};
                        if (tn_get(h, d->name.c_str(), &result, &diagnostic) != TN_OK) {
                            throwStatus(isolate, diagnostic);
                            return;
                        }
                        v8::Local<v8::Value> value = fromValue(*d->adapter, result);
                        if (owner) {
                            self->SetInternalField(d->slot, value);
                            if (d->own) adopt(isolate, ctx, self, d->name, value);
                        } else if (d->slot == 0 && !d->cache.IsEmpty()) self->SetPrivate(ctx, d->cache.Get(isolate), value).Check();
                        info.GetReturnValue().Set(value);
                    },
                    v8::External::New(isolate_, data)),
                settable ? v8::FunctionTemplate::New(
                               isolate_,
                               [](const v8::FunctionCallbackInfo<v8::Value>& info) {
                                   auto* d = static_cast<MethodData*>(info.Data().As<v8::External>()->Value());
                                   tn_handle_t h{};
                                   if (!d->adapter->unwrap(info.This(), h)) return;
                                   tn_diagnostic_t diagnostic{nullptr, 0};
                                   if (info.Length() == 1 && info[0]->IsNumber()) {
                                       tn_value_t number{};
                                       number.kind = TN_VALUE_NUMBER;
                                       number.number = info[0].As<v8::Number>()->Value();
                                       if (tn::abi::setNumber(h, d->setter, d->name, number.number, &diagnostic) != TN_OK) throwStatus(info.GetIsolate(), diagnostic);
                                       return;
                                   }
                                   std::vector<tn_value_t> args;
                                   std::deque<std::string> texts;
                               std::deque<std::vector<tn_value_t>> values;
                                   std::vector<std::vector<double>> arrays;
                                   if (!toValues(*d->adapter, info, args, texts, arrays, values) || args.size() != 1 ||
                                       tn_set(h, d->name.c_str(), &args[0], &diagnostic) != TN_OK) {
                                       throwStatus(info.GetIsolate(), diagnostic);
                                   }
                               },
                               v8::External::New(isolate_, data))
                         : v8::Local<v8::FunctionTemplate>());
        }
        // A dotted setter whose head is no member object, as three's plain `morphAttributes` holder:
        // `geometry.morphAttributes.position = [...]` writes through a holder object made per read,
        // which keeps its owner privately and forwards each tail to tn_set with the full path.
        std::map<std::string, std::vector<MethodData*>> holders;
        for (const auto& [path, setter] : binding.setters) {
            (void)setter;
            const std::size_t dot = path.find('.');
            if (dot == std::string::npos) continue;
            const std::string head = path.substr(0, dot);
            if (binding.members.count(head) > 0 || binding.getters.count(head) > 0) continue;
            holders[head].push_back(keep(new MethodData{this, path, {}}));
            holders[head].back()->readable = binding.getters.count(path) > 0 || binding.members.count(path) > 0;
        }
        for (const auto& [head, paths] : holders) {
            auto* tails = keep(new std::vector<MethodData*>(paths));
            proto->SetAccessorProperty(str(isolate_, head), v8::FunctionTemplate::New(isolate_,
                [](const v8::FunctionCallbackInfo<v8::Value>& info) {
                    v8::Isolate* isolate = info.GetIsolate();
                    v8::Local<v8::Context> ctx = isolate->GetCurrentContext();
                    const auto* tails = static_cast<std::vector<MethodData*>*>(info.Data().As<v8::External>()->Value());
                    v8::Local<v8::Object> holder = v8::Object::New(isolate);
                    holder->SetPrivate(ctx, v8::Private::ForApi(isolate, str(isolate, "tn:holder-owner")), info.This()).Check();
                    for (MethodData* tail : *tails) {
                        const std::string name = tail->name.substr(tail->name.find('.') + 1);
                        v8::Local<v8::Function> set = v8::Function::New(ctx,
                            [](const v8::FunctionCallbackInfo<v8::Value>& info) {
                                auto* d = static_cast<MethodData*>(info.Data().As<v8::External>()->Value());
                                v8::Isolate* isolate = info.GetIsolate();
                                v8::Local<v8::Value> owner;
                                tn_handle_t h{};
                                if (!info.This()->GetPrivate(isolate->GetCurrentContext(),
                                        v8::Private::ForApi(isolate, str(isolate, "tn:holder-owner"))).ToLocal(&owner) ||
                                    !owner->IsObject() || !d->adapter->unwrap(owner.As<v8::Object>(), h)) return;
                                std::vector<tn_value_t> args;
                                std::deque<std::string> texts;
                                std::deque<std::vector<tn_value_t>> values;
                                std::vector<std::vector<double>> arrays;
                                tn_diagnostic_t diagnostic{nullptr, 0};
                                if (!toValues(*d->adapter, info, args, texts, arrays, values) || args.size() != 1 ||
                                    tn_set(h, d->name.c_str(), &args[0], &diagnostic) != TN_OK)
                                    throwStatus(isolate, diagnostic);
                            }, v8::External::New(isolate, tail)).ToLocalChecked();
                        // A tail the binding also reads (`morphAttributes.position`) reads back through the
                        // holder too, so the holder is three's whole plain object.
                        v8::Local<v8::Function> get;
                        if (tail->readable)
                            get = v8::Function::New(ctx,
                                [](const v8::FunctionCallbackInfo<v8::Value>& info) {
                                    auto* d = static_cast<MethodData*>(info.Data().As<v8::External>()->Value());
                                    v8::Isolate* isolate = info.GetIsolate();
                                    v8::Local<v8::Value> owner;
                                    tn_handle_t h{};
                                    if (!info.This()->GetPrivate(isolate->GetCurrentContext(),
                                            v8::Private::ForApi(isolate, str(isolate, "tn:holder-owner"))).ToLocal(&owner) ||
                                        !owner->IsObject() || !d->adapter->unwrap(owner.As<v8::Object>(), h)) return;
                                    tn_value_t result{};
                                    tn_diagnostic_t diagnostic{nullptr, 0};
                                    if (tn_get(h, d->name.c_str(), &result, &diagnostic) != TN_OK) {
                                        throwStatus(isolate, diagnostic);
                                        return;
                                    }
                                    info.GetReturnValue().Set(fromValue(*d->adapter, result));
                                }, v8::External::New(isolate, tail)).ToLocalChecked();
                        holder->SetAccessorProperty(str(isolate, name), get, set);
                    }
                    info.GetReturnValue().Set(holder);
                }, v8::External::New(isolate_, tails)));
        }
        if (!binding.events.empty()) {
            if (listenersKey_.IsEmpty()) listenersKey_.Reset(isolate_, v8::Private::New(isolate_, str(isolate_, "tn:listeners")));
            for (const char* method : {"addEventListener", "removeEventListener", "hasEventListener", "dispatchEvent"}) {
                auto* data = keep(new MethodData{this, method, {}});
                data->cls = name;
                proto->Set(str(isolate_, method), v8::FunctionTemplate::New(isolate_, &Adapter::eventListener,
                                                                            v8::External::New(isolate_, data)));
            }
        }
        // A setter with no getter (three's write-only `texture.needsUpdate`) is still a property:
        // without an accessor the write lands on a plain JS property and never reaches the engine.
        for (const auto& [path, setter] : binding.setters) {
            (void)setter;
            if (path.find('.') != std::string::npos || binding.getters.count(path) > 0 || binding.members.count(path) > 0)
                continue;
            proto->SetAccessorProperty(str(isolate_, path), v8::Local<v8::FunctionTemplate>(), v8::FunctionTemplate::New(isolate_,
                [](const v8::FunctionCallbackInfo<v8::Value>& info) {
                    auto* d = static_cast<MethodData*>(info.Data().As<v8::External>()->Value());
                    tn_handle_t h{};
                    if (!d->adapter->unwrap(info.This(), h)) return;
                    std::vector<tn_value_t> args;
                    std::deque<std::string> texts;
                    std::deque<std::vector<tn_value_t>> values;
                    std::vector<std::vector<double>> arrays;
                    tn_diagnostic_t diagnostic{nullptr, 0};
                    if (!toValues(*d->adapter, info, args, texts, arrays, values) || args.size() != 1 ||
                        tn_set(h, d->name.c_str(), &args[0], &diagnostic) != TN_OK)
                        throwStatus(info.GetIsolate(), diagnostic);
                }, v8::External::New(isolate_, keep(new MethodData{this, path, {}}))));
        }
        for (const auto& [name, set] : binding.callbacks) {
            (void)set;
            if (callbackKeys_.find(name) == callbackKeys_.end())
                callbackKeys_[name].Reset(isolate_, v8::Private::New(isolate_, str(isolate_, "tn:callback:" + name)));
            auto* data = keep(new MethodData{this, name, {}});
            proto->SetAccessorProperty(str(isolate_, name),
                                       v8::FunctionTemplate::New(isolate_, &Adapter::getCallback, v8::External::New(isolate_, data)),
                                       v8::FunctionTemplate::New(isolate_, &Adapter::setCallback, v8::External::New(isolate_, data)));
        }
        classes_[type].Reset(isolate_, ctor);
        target->Set(context, str(isolate_, name), ctor->GetFunction(context).ToLocalChecked()).Check();
    }
    // three's scalar constants the engine binds: plain values
    // beside the classes, read as globals the way the classes are. The values are three r185's
    // (ThreeConstants.h, proven bit-exact by the mathutils reference test); this only wires them.
    for (const auto& c : tn::engine::kThreeConstants) {
        v8::Local<v8::Value> val = c.text != nullptr
            ? v8::Local<v8::Value>(str(isolate_, c.text))
            : v8::Local<v8::Value>(v8::Number::New(isolate_, c.number));
        target->Set(context, str(isolate_, c.name), val).Check();
    }
    // PropertyBinding is a registry class; its statics and three's console function are the shared
    // facade (three-native/src/property-binding.ts), as on the Wasm back end.
    // Every attribute class answers `array` with its typed array view (see arrayView), one per
    // attribute while the wrapper lives, so `attribute.array === attribute.array` as in three.
    for (const auto& [name, binding] : registry()) {
        if (!isAttributeClass(name)) continue;
        const auto cls = classes_.find(tn_type_id(name.c_str()));
        if (cls == classes_.end()) continue;
        v8::Local<v8::Value> prototype;
        if (!cls->second.Get(isolate_)->GetFunction(context).ToLocalChecked()->Get(context, str(isolate_, "prototype")).ToLocal(&prototype) ||
            !prototype->IsObject())
            continue;
        prototype.As<v8::Object>()->SetAccessorProperty(str(isolate_, "array"),
            v8::Function::New(context, [](const v8::FunctionCallbackInfo<v8::Value>& info) {
                v8::Isolate* isolate = info.GetIsolate();
                Adapter& a = *static_cast<Adapter*>(info.Data().As<v8::External>()->Value());
                tn_handle_t h{};
                tn::binding::Object* object = a.unwrap(info.This(), h) ? tn::abi::objectOf(h) : nullptr;
                if (object == nullptr || !isAttributeClass(object->cls)) {
                    isolate->ThrowException(v8::Exception::TypeError(str(isolate, "TN_NATIVE_UNSUPPORTED array: not an attribute")));
                    return;
                }
                const auto& store = static_cast<engine::BufferAttribute*>(object->ptr.get())->store;
                v8::Local<v8::Context> ctx = isolate->GetCurrentContext();
                v8::Local<v8::Private> viewKey = v8::Private::ForApi(isolate, str(isolate, "tn:array-view"));
                v8::Local<v8::Private> storeKey = v8::Private::ForApi(isolate, str(isolate, "tn:array-store"));
                v8::Local<v8::Value> cached, cachedStore;
                if (info.This()->GetPrivate(ctx, viewKey).ToLocal(&cached) && cached->IsTypedArray() &&
                    info.This()->GetPrivate(ctx, storeKey).ToLocal(&cachedStore) && cachedStore->IsExternal() &&
                    cachedStore.As<v8::External>()->Value() == store.get()) {
                    info.GetReturnValue().Set(cached);
                    return;
                }
                v8::Local<v8::Value> view = arrayView(isolate, store);
                info.This()->SetPrivate(ctx, viewKey, view).Check();
                info.This()->SetPrivate(ctx, storeKey, v8::External::New(isolate, store.get())).Check();
                info.GetReturnValue().Set(view);
            }, v8::External::New(isolate_, this)).ToLocalChecked());
    }
}

}  // namespace tn::adapters::v8adapter
