#include "math_bridge.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>
#include <mutex>

#include "engine/abi/abi_internal.h"
#include "engine/abi/bindings.h"
#include "engine/foundation/math/Color.h"
#include "engine/foundation/math/Euler.h"
#include "engine/foundation/math/Matrix.h"
#include "engine/foundation/math/Primitives.h"
#include "engine/foundation/math/Quaternion.h"
#include "engine/foundation/math/Vector.h"
#include "engine/scene/object3d.h"

#ifdef TN_JS_MATH_EMBEDDED
#include "tn_math_script.h"
#endif

extern "C" uint16_t tn_type_id(const char* name);

namespace tn::adapters::v8adapter {

namespace {

enum Prop { kX, kY, kZ, kW, kR, kG, kB, kElements, kMin, kMax, kCenter, kRadius, kOrder, kSet, kTag, kKeyCount };
constexpr const char* kKeyNames[kKeyCount] = {"x", "y", "z", "w", "r", "g", "b", "elements", "min", "max",
                                              "center", "radius", "order", "set", "$tn"};
constexpr const char* kNames[kMathKinds] = {"Vector2", "Vector3", "Vector4", "Quaternion", "Euler",
                                            "Matrix3", "Matrix4", "Color", "Box3", "Sphere"};

// V8 may free a view's ArrayBuffer on any thread, so its deleter only queues the claim; drain() returns it.
std::mutex& releasedMutex() {
    static std::mutex mutex;
    return mutex;
}
std::vector<tn::abi::ViewClaim*>& released() {
    static std::vector<tn::abi::ViewClaim*> claims;
    return claims;
}
void queueClaim(void*, std::size_t, void* claim) {
    const std::lock_guard<std::mutex> lock(releasedMutex());
    released().push_back(static_cast<tn::abi::ViewClaim*>(claim));
}

v8::Local<v8::String> literal(v8::Isolate* isolate, const char* text) {
    return v8::String::NewFromUtf8(isolate, text, v8::NewStringType::kInternalized).ToLocalChecked();
}

}  // namespace

struct MathBridge::Entry {
    MathBridge* bridge;
    Key key;
    v8::Global<v8::Object> view;
};

MathBridge::MathBridge(v8::Isolate* isolate, tn_context_t* context) : isolate_(isolate), context_(context) {
    for (std::size_t k = 0; k < kMathKinds; ++k) types_[k] = tn_type_id(kNames[k]);
}

MathBridge::~MathBridge() {
    for (auto& [key, entry] : cache_) {
        entry->view.Reset();
        delete entry;
    }
    cache_.clear();
    drain();
}

v8::Local<v8::String> MathBridge::key(int which) const { return keys_[which].Get(isolate_); }

bool MathBridge::install(v8::Local<v8::Context> context, v8::Local<v8::Object> target, std::string& error) {
#ifndef TN_JS_MATH_EMBEDDED
    (void)context;
    (void)target;
    error = "TN_NATIVE_JS_MATH_UNAVAILABLE: this build embeds no math script (esbuild was not found when it was configured)";
    return false;
#else
    const auto script = mystral::runtime_scripts::find("tn_math");
    v8::HandleScope scope(isolate_);
    jsContext_.Reset(isolate_, context);
    keys_.clear();
    for (const char* name : kKeyNames) keys_.emplace_back(isolate_, literal(isolate_, name));
    used_.fill(0);
    // Views of an earlier install belong to that context's classes.
    for (auto& [view, entry] : cache_) {
        entry->view.Reset();
        delete entry;
    }
    cache_.clear();
    v8::TryCatch tryCatch(isolate_);
    const auto fail = [&](const char* what) {
        v8::String::Utf8Value message(isolate_, tryCatch.Exception());
        error = std::string("TN_NATIVE_JS_MATH_INSTALL: ") + what + (*message ? std::string(": ") + *message : "");
        return false;
    };
    v8::Local<v8::String> source;
    v8::Local<v8::Script> compiled;
    v8::Local<v8::Value> ignored;
    if (!v8::String::NewFromUtf8(isolate_, script.data, v8::NewStringType::kNormal, static_cast<int>(script.size)).ToLocal(&source) ||
        !v8::Script::Compile(context, source).ToLocal(&compiled) || !compiled->Run(context).ToLocal(&ignored))
        return fail("the embedded script did not run");
    const v8::Local<v8::Object> global = context->Global();
    v8::Local<v8::Value> installer;
    if (!global->Get(context, literal(isolate_, "__tnMathInstall")).ToLocal(&installer) || !installer->IsFunction())
        return fail("the script defines no installer");
    global->Delete(context, literal(isolate_, "__tnMathInstall")).Check();
    v8::Local<v8::Value> arguments[2] = {
        target, v8::String::NewFromUtf8(isolate_, tn::binding::viewLayoutJson().c_str()).ToLocalChecked()};
    v8::Local<v8::Value> result;
    if (!installer.As<v8::Function>()->Call(context, v8::Undefined(isolate_), 2, arguments).ToLocal(&result) || !result->IsObject())
        return fail("the installer failed");
    const v8::Local<v8::Object> bridge = result.As<v8::Object>();
    v8::Local<v8::Value> kinds, views, link, bytes;
    if (!bridge->Get(context, literal(isolate_, "kinds")).ToLocal(&kinds) || !kinds->IsArray() ||
        !bridge->Get(context, literal(isolate_, "views")).ToLocal(&views) || !views->IsObject() ||
        !bridge->Get(context, literal(isolate_, "link")).ToLocal(&link) || !link->IsFunction() ||
        !bridge->Get(context, literal(isolate_, "bytes")).ToLocal(&bytes) || !bytes->IsObject())
        return fail("the installer answered no views");
    link_.Reset(isolate_, link.As<v8::Function>());
    tags_.fill(-1);
    const v8::Local<v8::Array> names = kinds.As<v8::Array>();
    for (uint32_t tag = 0; tag < names->Length() && tag < tags_.size(); ++tag) {
        v8::Local<v8::Value> name, maker, size;
        if (!names->Get(context, tag).ToLocal(&name)) return fail("kinds");
        v8::String::Utf8Value text(isolate_, name);
        for (std::size_t k = 0; k < kMathKinds; ++k) {
            if (std::strcmp(*text, kNames[k]) != 0) continue;
            tags_[tag] = static_cast<int>(k);
            if (!views.As<v8::Object>()->Get(context, name).ToLocal(&maker) || !maker->IsFunction() ||
                !bytes.As<v8::Object>()->Get(context, name).ToLocal(&size) || !size->IsNumber())
                return fail("a view maker is missing");
            makers_[k].Reset(isolate_, maker.As<v8::Function>());
            bytes_[k] = static_cast<uint32_t>(size.As<v8::Number>()->Value());
        }
    }
    installed_ = true;
    return true;
#endif
}

bool MathBridge::kindOf(v8::Local<v8::Value> value, MathKind& kind) {
    if (!installed_ || !value->IsObject() || value->IsFunction() || value->IsArray() || value->IsTypedArray()) return false;
    const v8::Local<v8::Object> object = value.As<v8::Object>();
    if (object->InternalFieldCount() != 0) return false;
    v8::Local<v8::Value> tag;
    if (!object->Get(isolate_->GetCurrentContext(), key(kTag)).ToLocal(&tag) || !tag->IsInt32()) return false;
    const int32_t index = tag.As<v8::Int32>()->Value();
    if (index < 0 || index >= static_cast<int32_t>(tags_.size()) || tags_[index] < 0) return false;
    kind = static_cast<MathKind>(tags_[index]);
    return true;
}

// ----------------------------------------------------------------------------------------- views

v8::Local<v8::Value> MathBridge::build(MathKind kind, const void* address, tn::abi::ViewClaim* claim) {
    v8::EscapableHandleScope scope(isolate_);
    auto backing = v8::ArrayBuffer::NewBackingStore(const_cast<void*>(address), bytes_[static_cast<std::size_t>(kind)],
                                                    queueClaim, claim);
    v8::Local<v8::ArrayBuffer> buffer = v8::ArrayBuffer::New(isolate_, std::move(backing));
    v8::Local<v8::Value> metadata = v8::Undefined(isolate_);
    if (auto* flags = engine::Object3D::transformTrackingAddress(address); flags && kind != MathKind::Matrix4) {
        auto* metadataClaim = tn::abi::claimColumn(address);
        auto storage = v8::ArrayBuffer::NewBackingStore(flags, 3, queueClaim, metadataClaim);
        metadata = v8::ArrayBuffer::New(isolate_, std::move(storage));
    }
    v8::Local<v8::Value> arguments[3] = {buffer, v8::Integer::New(isolate_, 0), metadata};
    v8::Local<v8::Context> context = jsContext_.Get(isolate_);
    v8::Local<v8::Value> made;
    if (!makers_[static_cast<std::size_t>(kind)].Get(isolate_)->Call(context, v8::Undefined(isolate_), 3, arguments).ToLocal(&made))
        return {};
    return scope.Escape(made);
}

v8::Local<v8::Value> MathBridge::cached(MathKind kind, const void* address) {
    const auto found = cache_.find(Key{address, kind});
    if (found == cache_.end() || found->second->view.IsEmpty()) return {};
    return found->second->view.Get(isolate_);
}

void MathBridge::remember(MathKind kind, const void* address, v8::Local<v8::Value> view) {
    auto* entry = new Entry{this, Key{address, kind}, {}};
    entry->view.Reset(isolate_, view.As<v8::Object>());
    entry->view.SetWeak(entry, [](const v8::WeakCallbackInfo<Entry>& info) {
        Entry* gone = info.GetParameter();
        gone->view.Reset();
        gone->bridge->cache_.erase(gone->key);
        delete gone;
    }, v8::WeakCallbackType::kParameter);
    cache_[entry->key] = entry;
}

// An Object3D's rotation and quaternion are one orientation in two forms: both views exist as soon as
// either does, and JS keeps them in step through three's own `_onChange` hooks.
void MathBridge::pair(v8::Local<v8::Value> view, int column, const void* address) {
    const bool euler = column == 2;
    const MathKind mateKind = euler ? MathKind::Quaternion : MathKind::Euler;
    const void* mateAddress = engine::Object3D::transformColumnAddress(address, euler ? 3 : 2);
    if (mateAddress == nullptr) return;
    v8::Local<v8::Value> mate = cached(mateKind, mateAddress);
    if (mate.IsEmpty()) {
        tn::abi::ViewClaim* claim = tn::abi::claimColumn(mateAddress);
        if (claim == nullptr) return;
        mate = build(mateKind, mateAddress, claim);
        if (mate.IsEmpty()) return;
        remember(mateKind, mateAddress, mate);
    }
    v8::Local<v8::Value> arguments[2] = {euler ? view : mate, euler ? mate : view};
    v8::Local<v8::Value> ignored;
    (void)link_.Get(isolate_)->Call(jsContext_.Get(isolate_), v8::Undefined(isolate_), 2, arguments).ToLocal(&ignored);
}

v8::MaybeLocal<v8::Value> MathBridge::view(tn_handle_t handle) {
    if (!installed_) return {};
    std::size_t k = 0;
    while (k < kMathKinds && types_[k] != handle.type) ++k;
    if (k == kMathKinds) return {};
    const auto kind = static_cast<MathKind>(k);
    if (isStandIn(handle)) return {};  // the pool's own, only ever answered as the JS argument it stands for
    tn::binding::Object* object = tn::abi::objectOf(handle);
    if (object == nullptr) return {};
    const void* address = object->ptr.get();
    engine::Object3D::prepareTransformView(address);
    if (v8::Local<v8::Value> known = cached(kind, address); !known.IsEmpty()) {
        tn::abi::dropHandle(handle);
        return known;
    }
    const void* claimed = nullptr;
    int column = -1;
    tn::abi::ViewClaim* claim = tn::abi::claimView(handle, claimed, column);
    if (claim == nullptr) return {};
    v8::Local<v8::Value> made = build(kind, address, claim);
    if (made.IsEmpty()) return {};
    remember(kind, address, made);
    if (column == 2 || column == 3) pair(made, column, address);
    tn::abi::dropHandle(handle);
    return made;
}

void MathBridge::drain() {
    std::vector<tn::abi::ViewClaim*> claims;
    {
        const std::lock_guard<std::mutex> lock(releasedMutex());
        claims.swap(released());
    }
    for (tn::abi::ViewClaim* claim : claims) tn::abi::releaseViewClaim(claim);
}

// ------------------------------------------------------------------------------------- stand-ins

double MathBridge::read(v8::Local<v8::Object> object, int which) {
    v8::Local<v8::Context> context = isolate_->GetCurrentContext();
    v8::Local<v8::Value> value;
    if (!object->Get(context, key(which)).ToLocal(&value)) return std::numeric_limits<double>::quiet_NaN();
    return value->NumberValue(context).FromMaybe(std::numeric_limits<double>::quiet_NaN());
}

namespace {
template <typename T>
T& as(void* object) {
    return *static_cast<T*>(object);
}
template <typename T>
const T& as(const void* object) {
    return *static_cast<const T*>(object);
}
}  // namespace

void MathBridge::flatten(MathKind kind, const void* object, std::array<double, 16>& flat) const {
    using namespace tn::engine;
    switch (kind) {
        case MathKind::Vector2: flat[0] = as<Vector2>(object).x; flat[1] = as<Vector2>(object).y; break;
        case MathKind::Vector3: flat[0] = as<Vector3>(object).x; flat[1] = as<Vector3>(object).y; flat[2] = as<Vector3>(object).z; break;
        case MathKind::Vector4:
            flat[0] = as<Vector4>(object).x; flat[1] = as<Vector4>(object).y; flat[2] = as<Vector4>(object).z; flat[3] = as<Vector4>(object).w;
            break;
        case MathKind::Quaternion:
            flat[0] = as<Quaternion>(object).x; flat[1] = as<Quaternion>(object).y; flat[2] = as<Quaternion>(object).z;
            flat[3] = as<Quaternion>(object).w;
            break;
        case MathKind::Euler:
            flat[0] = as<Euler>(object).x; flat[1] = as<Euler>(object).y; flat[2] = as<Euler>(object).z;
            flat[3] = static_cast<double>(static_cast<int>(as<Euler>(object).order));
            break;
        case MathKind::Matrix3: std::copy(as<Matrix3>(object).elements.begin(), as<Matrix3>(object).elements.end(), flat.begin()); break;
        case MathKind::Matrix4: std::copy(as<Matrix4>(object).elements.begin(), as<Matrix4>(object).elements.end(), flat.begin()); break;
        case MathKind::Color: flat[0] = as<Color>(object).r; flat[1] = as<Color>(object).g; flat[2] = as<Color>(object).b; break;
        case MathKind::Box3:
            flat[0] = as<Box3>(object).min.x; flat[1] = as<Box3>(object).min.y; flat[2] = as<Box3>(object).min.z;
            flat[3] = as<Box3>(object).max.x; flat[4] = as<Box3>(object).max.y; flat[5] = as<Box3>(object).max.z;
            break;
        case MathKind::Sphere:
            flat[0] = as<Sphere>(object).center.x; flat[1] = as<Sphere>(object).center.y; flat[2] = as<Sphere>(object).center.z;
            flat[3] = as<Sphere>(object).radius;
            break;
    }
}

bool MathBridge::fill(MathKind kind, void* object, v8::Local<v8::Object> js, std::array<double, 16>& flat) {
    using namespace tn::engine;
    v8::Local<v8::Context> context = isolate_->GetCurrentContext();
    const auto elements = [&](double* out, std::size_t count) {
        v8::Local<v8::Value> value;
        if (!js->Get(context, key(kElements)).ToLocal(&value) || !value->IsObject()) return false;
        if (value->IsFloat64Array()) {
            const auto typed = value.As<v8::Float64Array>();
            return typed->Length() >= count && typed->CopyContents(out, count * sizeof(double)) == count * sizeof(double);
        }
        for (std::size_t i = 0; i < count; ++i) {
            v8::Local<v8::Value> element;
            if (!value.As<v8::Object>()->Get(context, static_cast<uint32_t>(i)).ToLocal(&element)) return false;
            out[i] = element->NumberValue(context).FromMaybe(std::numeric_limits<double>::quiet_NaN());
        }
        return true;
    };
    const auto nested = [&](int part, double* out) {
        v8::Local<v8::Value> value;
        if (!js->Get(context, key(part)).ToLocal(&value) || !value->IsObject()) return false;
        const auto vector = value.As<v8::Object>();
        out[0] = read(vector, kX); out[1] = read(vector, kY); out[2] = read(vector, kZ);
        return true;
    };
    switch (kind) {
        case MathKind::Vector2: as<Vector2>(object).x = read(js, kX); as<Vector2>(object).y = read(js, kY); break;
        case MathKind::Vector3:
            as<Vector3>(object).x = read(js, kX); as<Vector3>(object).y = read(js, kY); as<Vector3>(object).z = read(js, kZ);
            break;
        case MathKind::Vector4:
            as<Vector4>(object).x = read(js, kX); as<Vector4>(object).y = read(js, kY);
            as<Vector4>(object).z = read(js, kZ); as<Vector4>(object).w = read(js, kW);
            break;
        case MathKind::Quaternion:
            as<Quaternion>(object).x = read(js, kX); as<Quaternion>(object).y = read(js, kY);
            as<Quaternion>(object).z = read(js, kZ); as<Quaternion>(object).w = read(js, kW);
            break;
        case MathKind::Euler: {
            Euler& euler = as<Euler>(object);
            euler.x = read(js, kX); euler.y = read(js, kY); euler.z = read(js, kZ);
            v8::Local<v8::Value> order;
            if (!js->Get(context, key(kOrder)).ToLocal(&order) || !order->IsString()) return false;
            v8::String::Utf8Value text(isolate_, order);
            int found = -1;
            for (int i = 0; i < 6; ++i)
                if (std::strcmp(*text, tn::binding::kEulerOrderNames[i]) == 0) found = i;
            if (found < 0) return false;
            euler.order = static_cast<EulerOrder>(found);
            break;
        }
        case MathKind::Matrix3: if (!elements(as<Matrix3>(object).elements.data(), 9)) return false; break;
        case MathKind::Matrix4: if (!elements(as<Matrix4>(object).elements.data(), 16)) return false; break;
        case MathKind::Color: as<Color>(object).r = read(js, kR); as<Color>(object).g = read(js, kG); as<Color>(object).b = read(js, kB); break;
        case MathKind::Box3: {
            double min[3], max[3];
            if (!nested(kMin, min) || !nested(kMax, max)) return false;
            as<Box3>(object).min.set(min[0], min[1], min[2]);
            as<Box3>(object).max.set(max[0], max[1], max[2]);
            break;
        }
        case MathKind::Sphere: {
            double center[3];
            if (!nested(kCenter, center)) return false;
            as<Sphere>(object).center.set(center[0], center[1], center[2]);
            as<Sphere>(object).radius = read(js, kRadius);
            break;
        }
    }
    flatten(kind, object, flat);
    return true;
}

MathBridge::Slot& MathBridge::acquire(MathKind kind, Stand& stand, v8::Local<v8::Object> js) {
    const auto k = static_cast<std::size_t>(kind);
    const std::size_t index = used_[k]++;
    auto& pool = pools_[k];
    if (pool.size() <= index || !pool[index].object) {
        using namespace tn::engine;
        std::shared_ptr<void> object;
        switch (kind) {
            case MathKind::Vector2: object = std::make_shared<Vector2>(); break;
            case MathKind::Vector3: object = std::make_shared<Vector3>(); break;
            case MathKind::Vector4: object = std::make_shared<Vector4>(); break;
            case MathKind::Quaternion: object = std::make_shared<Quaternion>(); break;
            case MathKind::Euler: object = std::make_shared<Euler>(); break;
            case MathKind::Matrix3: object = std::make_shared<Matrix3>(); break;
            case MathKind::Matrix4: object = std::make_shared<Matrix4>(); break;
            case MathKind::Color: object = std::make_shared<Color>(); break;
            case MathKind::Box3: object = std::make_shared<Box3>(); break;
            case MathKind::Sphere: object = std::make_shared<Sphere>(); break;
        }
        const tn_handle_t handle = tn::abi::shareObject(context_, kNames[k], object);
        Slot slot{handle, std::move(object), 0};
        slot.baseline = slot.object.use_count();
        if (pool.size() <= index) pool.push_back(std::move(slot));
        else pool[index] = std::move(slot);
    }
    stand.uses_.push_back(Stand::Use{kind, index, js, {}});
    return pool[index];
}

bool MathBridge::standIn(v8::Local<v8::Value> value, Stand& stand, tn_value_t& out) {
    MathKind kind;
    if (!kindOf(value, kind)) return false;
    Slot& slot = acquire(kind, stand, value.As<v8::Object>());
    if (!fill(kind, slot.object.get(), value.As<v8::Object>(), stand.uses_.back().before)) {
        --used_[static_cast<std::size_t>(kind)];
        stand.uses_.pop_back();
        return false;
    }
    out = tn_value_t{};
    out.kind = TN_VALUE_HANDLE;
    out.handle = slot.handle;
    return true;
}

// A native object may keep an argument instead of copying it (a curve's points, a Raycaster's ray): that
// stand-in is then the object's own, so the pool gives it up and makes a fresh one for the next call.
MathBridge::Stand::~Stand() {
    for (const Use& use : uses_) {
        const auto k = static_cast<std::size_t>(use.kind);
        --bridge_->used_[k];
        Slot& slot = bridge_->pools_[k][use.index];
        if (slot.object && slot.object.use_count() > slot.baseline) {
            tn::abi::dropHandle(slot.handle);
            slot.object.reset();
        }
    }
}

bool MathBridge::isStandIn(tn_handle_t handle) const {
    for (const auto& pool : pools_)
        for (const Slot& slot : pool)
            if (slot.object && slot.handle.index == handle.index && slot.handle.generation == handle.generation &&
                slot.handle.type == handle.type)
                return true;
    return false;
}

v8::Local<v8::Value> MathBridge::Stand::jsFor(tn_handle_t handle) const {
    for (const Use& use : uses_) {
        const tn_handle_t& own = bridge_->pools_[static_cast<std::size_t>(use.kind)][use.index].handle;
        if (own.index == handle.index && own.generation == handle.generation && own.type == handle.type && own.context == handle.context)
            return use.js;
    }
    return {};
}

void MathBridge::Stand::copyBack() {
    for (Use& use : uses_) {
        std::array<double, 16> now{};
        bridge_->flatten(use.kind, bridge_->pools_[static_cast<std::size_t>(use.kind)][use.index].object.get(), now);
        if (std::memcmp(now.data(), use.before.data(), sizeof(double) * 16) == 0) continue;
        use.before = now;
        bridge_->write(use.kind, now, use.js);
    }
}

// Writes through three's own methods, so a view fires its `_onChange` hooks once, as a JS `set` would.
void MathBridge::write(MathKind kind, const std::array<double, 16>& flat, v8::Local<v8::Object> js) {
    v8::Local<v8::Context> context = isolate_->GetCurrentContext();
    const auto number = [&](double v) { return v8::Number::New(isolate_, v).As<v8::Value>(); };
    const auto set = [&](v8::Local<v8::Object> target, std::initializer_list<v8::Local<v8::Value>> values) {
        v8::Local<v8::Value> fn, ignored;
        std::array<v8::Local<v8::Value>, 4> args{};
        if (values.size() > args.size()) {
            isolate_->ThrowException(v8::Exception::RangeError(literal(isolate_, "TN_NATIVE_MATH_ARGUMENTS: more than four components")));
            return;
        }
        std::copy(values.begin(), values.end(), args.begin());
        if (target->Get(context, key(kSet)).ToLocal(&fn) && fn->IsFunction())
            (void)fn.As<v8::Function>()->Call(context, target, static_cast<int>(values.size()), args.data()).ToLocal(&ignored);
    };
    const auto part = [&](int which) {
        v8::Local<v8::Value> value;
        return js->Get(context, key(which)).ToLocal(&value) && value->IsObject() ? value.As<v8::Object>() : v8::Local<v8::Object>();
    };
    switch (kind) {
        case MathKind::Vector2: set(js, {number(flat[0]), number(flat[1])}); break;
        case MathKind::Vector3: set(js, {number(flat[0]), number(flat[1]), number(flat[2])}); break;
        case MathKind::Vector4:
        case MathKind::Quaternion: set(js, {number(flat[0]), number(flat[1]), number(flat[2]), number(flat[3])}); break;
        case MathKind::Euler:
            set(js, {number(flat[0]), number(flat[1]), number(flat[2]), literal(isolate_, tn::binding::kEulerOrderNames[static_cast<int>(flat[3])])});
            break;
        case MathKind::Color:
            js->Set(context, key(kR), number(flat[0])).Check();
            js->Set(context, key(kG), number(flat[1])).Check();
            js->Set(context, key(kB), number(flat[2])).Check();
            break;
        case MathKind::Matrix3:
        case MathKind::Matrix4: {
            const std::size_t count = kind == MathKind::Matrix3 ? 9 : 16;
            v8::Local<v8::Value> value;
            if (!js->Get(context, key(kElements)).ToLocal(&value) || !value->IsObject()) return;
            if (value->IsFloat64Array()) {
                const auto typed = value.As<v8::Float64Array>();
                auto* data = static_cast<char*>(typed->Buffer()->GetBackingStore()->Data()) + typed->ByteOffset();
                std::memcpy(data, flat.data(), count * sizeof(double));
            } else {
                for (std::size_t i = 0; i < count; ++i) value.As<v8::Object>()->Set(context, static_cast<uint32_t>(i), number(flat[i])).Check();
            }
            break;
        }
        case MathKind::Box3:
            if (const auto min = part(kMin); !min.IsEmpty()) set(min, {number(flat[0]), number(flat[1]), number(flat[2])});
            if (const auto max = part(kMax); !max.IsEmpty()) set(max, {number(flat[3]), number(flat[4]), number(flat[5])});
            break;
        case MathKind::Sphere:
            if (const auto center = part(kCenter); !center.IsEmpty()) set(center, {number(flat[0]), number(flat[1]), number(flat[2])});
            js->Set(context, key(kRadius), number(flat[3])).Check();
            break;
    }
}

}  // namespace tn::adapters::v8adapter
