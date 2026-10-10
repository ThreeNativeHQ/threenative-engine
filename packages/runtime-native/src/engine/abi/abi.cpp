// The N03 C ABI (PRD-500 phase 2): version handshake, contexts and generational object handles.
// Nothing here throws across the boundary and nothing here holds an STL type in a signature; every
// failure is a status code plus an owned diagnostic the caller releases.

#include "threenative/abi/tn_tsl.h"

#include <cstdio>
#include <cmath>
#include <fstream>
#include "engine/shader/standard.h"
#include "engine/shader/wgsl.h"
#include <cstdlib>
#include <cstring>
#include <atomic>
#include <deque>
#include <map>
#include <memory>
#include <new>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <vector>

#include "engine/abi/abi_internal.h"
#include "engine/scene/geometry.h"
#include "engine/abi/tsl_call.h"
#include "engine/scene/material.h"
#include "engine/abi/bindings.h"
#include "engine/foundation/handles.h"

#include <exception>
#include <string>

extern "C" uint16_t tn_type_id(const char* name);

// A context is also the binding Store of the generic calls: Ref values name handles, objects live
// in the slot their handle indexes.
struct tn_context : tn::binding::Store {
    explicit tn_context(uint16_t id) : objects(id) {}
    tn::engine::HandleTable objects;
    std::unordered_map<uint64_t, tn::engine::shader::graph::Node> tslNodes;
    uint64_t nextTslNode = 0;
    uint64_t tslSerial = 0;  // names the uniforms and render textures tn_tsl_call makes
    tn::abi::TslScopes tslScopes;  // the bodies open while the game's TSL callbacks run
    std::vector<tn::binding::Object> values;  // by handle index
    // (address, class) -> the one handle naming it: member aliases and shared objects. The class is
    // part of the key because a first member shares its owner's address (Box3::min).
    // address -> (class, handle) pairs: almost always one; the class tells a first member from its owner.
    std::unordered_map<const void*, std::vector<std::pair<std::string, tn_handle_t>>> identities_;
    std::unordered_map<const void*, tn_handle_t> primary_;  // an object's own handle, by address
    std::unordered_map<const void*, std::shared_ptr<void>> owners_;  // an object pointer -> its record
    // The shared_ptr copies the context itself holds (handle slots and owners_), by control block: an
    // object's use count minus these is what other engine objects hold (engineReferences).
    std::map<std::weak_ptr<void>, uint32_t, std::owner_less<>> ownCopies_;
    void ownCopy(const std::shared_ptr<void>& ptr, int delta) {
        if (!ptr) return;
        const auto it = ownCopies_.try_emplace(ptr, 0).first;
        it->second += delta;
        if (it->second == 0) ownCopies_.erase(it);
    }
    void setOwner(const void* address, std::shared_ptr<void> ptr) {
        auto& owner = owners_[address];
        ownCopy(owner, -1);
        ownCopy(ptr, +1);
        owner = std::move(ptr);
    }
    void dropOwner(const void* address) {
        const auto it = owners_.find(address);
        if (it == owners_.end()) return;
        ownCopy(it->second, -1);
        owners_.erase(it);
    }
    std::string scratchText;                  // a returned string, valid until the next call
    std::deque<std::vector<tn_value_t>> scratchValues;
    std::deque<std::string> scratchStrings;
    std::deque<std::vector<double>> scratchArrays;
    std::vector<double> scratchNumbers;       // a returned array, valid until the next call

    // A Ref's text is the handle itself: a marker byte and its type, index and generation, 11 bytes
    // that fit a std::string's inline buffer, so a crossing formats and parses nothing.
    static std::string refText(tn_handle_t h) {
        char bytes[11];
        bytes[0] = '\x06';
        std::memcpy(bytes + 1, &h.type, 2);
        std::memcpy(bytes + 3, &h.index, 4);
        std::memcpy(bytes + 7, &h.generation, 4);
        return std::string(bytes, sizeof bytes);
    }
    bool decode(const std::string& text, tn_handle_t& out) const {
        if (text.size() != 11 || text[0] != '\x06') return false;
        out = tn_handle_t{0, objects.context(), 0, 0};
        std::memcpy(&out.type, text.data() + 1, 2);
        std::memcpy(&out.index, text.data() + 3, 4);
        std::memcpy(&out.generation, text.data() + 7, 4);
        return true;
    }
    tn::binding::Object* object(tn_handle_t h) {
        if (objects.check(h.type, h.context, h.index, h.generation) != tn::engine::HandleError::None || h.index >= values.size()) return nullptr;
        tn::binding::Object& o = values[h.index];
        return o.ptr ? &o : nullptr;
    }
    tn::binding::Object* find(const tn::binding::Value& arg) override {
        tn_handle_t h{};
        return arg.kind == tn::binding::Value::Kind::Ref && decode(arg.text, h) ? object(h) : nullptr;
    }
    tn::binding::Value adopt(std::string cls, std::shared_ptr<void> ptr) override {
        tn_handle_t h{};
        if (!hold(std::move(cls), std::move(ptr), h)) throw tn::binding::Unsupported{"the catalog publishes no such class"};
        return tn::binding::Value{tn::binding::Value::Kind::Ref, 0, refText(h)};
    }
    tn::binding::Value adoptAlias(std::string cls, void* member, void* owner) override {
        const auto held = owners_.find(owner);
        if (held == owners_.end()) throw tn::binding::Unsupported{"this object is not one the caller owns"};
        // One handle per member address, so `object.position` is the same handle on every call. The
        // aliasing shared_ptr keeps the owner alive, so releasing the owner's handle first is safe.
        return identity(std::move(cls), std::shared_ptr<void>(held->second, member), false);
    }
    tn::binding::Value share(std::string cls, std::shared_ptr<void> shared) override {
        if (!shared) return tn::binding::Value{};
        // An object the caller already holds answers its own handle (`mesh.geometry` is the
        // BoxGeometry it was built from), whatever class name the asking binding knows it by.
        if (const auto known = primary_.find(shared.get()); known != primary_.end() && object(known->second) != nullptr) {
            return tn::binding::Value{tn::binding::Value::Kind::Ref, 0, refText(known->second)};
        }
        return identity(std::move(cls), std::move(shared), true);
    }
    // The cached handle while its object lives; a released handle is replaced, never reused.
    tn::binding::Value identity(std::string cls, std::shared_ptr<void> ptr, bool primary) {
        auto& known = identities_[ptr.get()];
        for (auto& [knownCls, handle] : known) {
            if (knownCls != cls) continue;
            if (object(handle) != nullptr) return tn::binding::Value{tn::binding::Value::Kind::Ref, 0, refText(handle)};
            tn_handle_t h{};
            if (!hold(cls, std::move(ptr), h, primary)) throw tn::binding::Unsupported{"the catalog publishes no such class"};
            handle = h;
            return tn::binding::Value{tn::binding::Value::Kind::Ref, 0, refText(h)};
        }
        tn_handle_t h{};
        if (!hold(cls, std::move(ptr), h, primary)) throw tn::binding::Unsupported{"the catalog publishes no such class"};
        known.emplace_back(std::move(cls), h);
        return tn::binding::Value{tn::binding::Value::Kind::Ref, 0, refText(h)};
    }
    // A callback argument as share() answers it: the object's live handle, minted again if the
    // caller released it; null for nothing or for an object the catalog cannot name.
    tn_value_t valueOf(std::string cls, std::shared_ptr<const void> ptr) {
        tn_value_t v{};
        if (!ptr) return v;
        try {
            tn_handle_t h{};
            if (decode(share(std::move(cls), std::const_pointer_cast<void>(ptr)).text, h)) {
                v.kind = TN_VALUE_HANDLE;
                v.handle = h;
            }
        } catch (const tn::binding::Unsupported&) {
        }
        return v;
    }
    tn_value_t valueOf(const tn::engine::Object3D* object) {
        if (object == nullptr) return {};
        // A borrowed object (no shared owner) has no handle to give.
        std::shared_ptr<const tn::engine::Object3D> shared = object->weak_from_this().lock();
        return shared ? valueOf(std::string(object->type()), shared) : tn_value_t{};
    }
    std::vector<double> numbers(const tn::binding::Value& arg) override {
        return tn::binding::numbersOf(arg);
    }
    // `primary`: the handle names the object itself, not a member alias at the same address.
    bool hold(std::string cls, std::shared_ptr<void> ptr, tn_handle_t& out, bool primary = true) {
        const uint16_t type = tn_type_id(cls.c_str());
        if (type == 0) return false;
        const tn::engine::Handle h = objects.allocate(type);
        if (values.size() <= h.index) values.resize(h.index + 1);
        setOwner(ptr.get(), ptr);
        ownCopy(ptr, +1);
        values[h.index] = tn::binding::Object{std::move(cls), std::move(ptr)};
        out = tn_handle_t{h.type, h.context, h.index, h.generation};
        if (primary) primary_[values[h.index].ptr.get()] = out;
        return true;
    }
};

namespace {

struct TypeEntry {
    std::string_view name;
    uint16_t id;
};

constexpr TypeEntry kTypes[] = {
#define TN_CATALOG_TYPE(name, id) {name, id},
#include "catalog_types.inc"
#undef TN_CATALOG_TYPE
};
constexpr uint16_t kTypeCount = sizeof(kTypes) / sizeof(kTypes[0]);

// Context ids are the handle's `context` field: slot i holds context id i + 1; 0 is never valid.
// ponytail: single-threaded registry, as the engine thread owns the ABI; lock it when a second
// thread is allowed to call in.
std::vector<std::unique_ptr<tn_context>>& registry() {
    static std::vector<std::unique_ptr<tn_context>> contexts;
    return contexts;
}

tn_status_t report(tn_diagnostic_t* diagnostic, tn_status_t status, uint32_t code, const char* message) {
    if (diagnostic) {
        tn_diagnostic_release(diagnostic);  // a reused diagnostic never leaks its previous message
        diagnostic->code = code;
        const size_t length = std::strlen(message);
        diagnostic->message = static_cast<char*>(std::malloc(length + 1));
        if (diagnostic->message) std::memcpy(diagnostic->message, message, length + 1);
    }
    return status;
}

tn_status_t ok(tn_diagnostic_t* diagnostic) {
    tn_diagnostic_release(diagnostic);
    return TN_OK;
}

tn_context* contextFor(uint16_t id) {
    auto& contexts = registry();
    return id == 0 || id > contexts.size() ? nullptr : contexts[id - 1].get();
}

}  // namespace

extern "C" {

tn_version_info_t tn_engine_version(void) {
    return tn_version_info_t{TN_CAPABILITY_DIGEST,       TN_ENGINE_ABI_VERSION, TN_COMPATIBILITY_CONTRACT_VERSION,
                             TN_SCENE_VERSION,          TN_SHADER_PACKAGE_VERSION, TN_CAPABILITY_COUNT, 0};
}

tn_status_t tn_version_handshake(const tn_version_info_t* module, tn_version_info_t* engine,
                                 tn_diagnostic_t* diagnostic) {
    const tn_version_info_t own = tn_engine_version();
    if (engine) *engine = own;
    if (!module) return report(diagnostic, TN_ERROR_INVALID_ARGUMENT, 0, "TN_ABI_NULL: no module version info");
    if (module->engine_abi != own.engine_abi) {
        return report(diagnostic, TN_ERROR_VERSION_MISMATCH, TN_DIAG_ENGINE_ABI_MISMATCH,
                      "TN_DIAG_ENGINE_ABI_MISMATCH: the module was built against another engine ABI");
    }
    if (module->compatibility_contract != own.compatibility_contract) {
        return report(diagnostic, TN_ERROR_VERSION_MISMATCH, TN_DIAG_CONTRACT_MISMATCH,
                      "TN_DIAG_CONTRACT_MISMATCH: the module expects another compatibility contract");
    }
    if (module->scene != own.scene) {
        return report(diagnostic, TN_ERROR_VERSION_MISMATCH, TN_DIAG_SCENE_MISMATCH,
                      "TN_DIAG_SCENE_MISMATCH: the module's serialized scene version differs");
    }
    if (module->shader_package != own.shader_package) {
        return report(diagnostic, TN_ERROR_VERSION_MISMATCH, TN_DIAG_SHADER_PACKAGE_MISMATCH,
                      "TN_DIAG_SHADER_PACKAGE_MISMATCH: the module's shader packages are another version");
    }
    if (module->capability_count != own.capability_count || module->capability_digest != own.capability_digest) {
        return report(diagnostic, TN_ERROR_VERSION_MISMATCH, TN_DIAG_CAPABILITY_MISMATCH,
                      "TN_DIAG_CAPABILITY_MISMATCH: the module was built against another capability set");
    }
    return ok(diagnostic);
}

tn_status_t tn_context_create(tn_context_t** out_context, const tn_version_info_t* module,
                              tn_diagnostic_t* diagnostic) {
    if (!out_context) return report(diagnostic, TN_ERROR_INVALID_ARGUMENT, 0, "TN_ABI_NULL: no out_context");
    *out_context = nullptr;
    const tn_status_t handshake = tn_version_handshake(module, nullptr, diagnostic);
    if (handshake != TN_OK) return handshake;
    auto& contexts = registry();
    size_t slot = 0;
    while (slot < contexts.size() && contexts[slot]) ++slot;
    if (slot >= 0xffff) return report(diagnostic, TN_ERROR_OUT_OF_MEMORY, 0, "TN_ABI_CONTEXTS: no free context id");
    // Plain new under a catch, not nothrow new: clang 23's libFuzzer runtime pairs nothrow new with
    // free and reports a false alloc-dealloc mismatch (reproduced with no engine code, 2026-10-04).
    std::unique_ptr<tn_context> context;
    try {
        context = std::make_unique<tn_context>(static_cast<uint16_t>(slot + 1));
        if (slot == contexts.size()) contexts.emplace_back();
    } catch (const std::bad_alloc&) {
        return report(diagnostic, TN_ERROR_OUT_OF_MEMORY, 0, "TN_ABI_OOM: context");
    }
    *out_context = context.get();
    contexts[slot] = std::move(context);
    return ok(diagnostic);
}

tn_status_t tn_context_destroy(tn_context_t* context, tn_diagnostic_t* diagnostic) {
    auto& contexts = registry();
    if (!context) return report(diagnostic, TN_ERROR_INVALID_ARGUMENT, 0, "TN_ABI_NULL: no context");
    // Found by address, never dereferenced first: a destroyed or foreign pointer is refused.
    for (auto& slot : contexts) {
        if (slot.get() != context) continue;
        slot.reset();
        return ok(diagnostic);
    }
    return report(diagnostic, TN_ERROR_INVALID_STATE, 0, "TN_ABI_CONTEXT: not a live context");
}

uint16_t tn_type_id(const char* name) {
    if (!name) return 0;
    const std::string_view wanted(name);
    for (const TypeEntry& entry : kTypes) {
        if (entry.name == wanted) return entry.id;
    }
    return 0;
}

tn_status_t tn_object_create(tn_context_t* context, uint16_t type, tn_handle_t* out_object,
                             tn_diagnostic_t* diagnostic) {
    if (!context || !out_object) return report(diagnostic, TN_ERROR_INVALID_ARGUMENT, 0, "TN_ABI_NULL: context or out_object");
    *out_object = tn_handle_t{0, 0, 0, 0};
    bool live = false;
    for (const auto& slot : registry()) live = live || slot.get() == context;
    if (!live) return report(diagnostic, TN_ERROR_INVALID_STATE, 0, "TN_ABI_CONTEXT: not a live context");
    if (type == 0 || type > kTypeCount) {
        return report(diagnostic, TN_ERROR_WRONG_TYPE, 0, "TN_ABI_TYPE: the catalog publishes no such type");
    }
    const tn::engine::Handle handle = context->objects.allocate(type);
    *out_object = tn_handle_t{handle.type, handle.context, handle.index, handle.generation};
    return ok(diagnostic);
}

void tn_object_engine_references(const tn_handle_t* objects, uint32_t count, uint32_t* out_counts) {
    if (!objects || !out_counts) return;
    for (uint32_t i = 0; i < count; ++i) out_counts[i] = tn::abi::engineReferences(objects[i]);
}

tn_status_t tn_object_release(tn_handle_t object, tn_diagnostic_t* diagnostic) {
    tn_context* context = contextFor(object.context);
    if (!context) return report(diagnostic, TN_ERROR_INVALID_HANDLE, 0, "TN_HANDLE_CONTEXT: no live context owns this handle");
    const tn::engine::Handle handle{object.type, object.context, object.index, object.generation};
    switch (context->objects.release(handle)) {
        case tn::engine::HandleError::None:
            if (object.index < context->values.size()) {
                tn::binding::Object& slot = context->values[object.index];
                // An alias of one of its members still holds the object, so the record outlives the
                // handle that named it; the aliasing shared_ptr is what keeps it alive.
                if (slot.ptr) context->dropOwner(slot.ptr.get());
                context->ownCopy(slot.ptr, -1);
                slot = tn::binding::Object{};
            }
            return ok(diagnostic);
        case tn::engine::HandleError::Stale:
            return report(diagnostic, TN_ERROR_STALE_HANDLE, 0, "TN_HANDLE_STALE: the slot was reclaimed");
        case tn::engine::HandleError::Type:
            return report(diagnostic, TN_ERROR_WRONG_TYPE, 0, "TN_HANDLE_TYPE: the handle names another type");
        case tn::engine::HandleError::Context:
        case tn::engine::HandleError::Invalid: break;
    }
    return report(diagnostic, TN_ERROR_INVALID_HANDLE, 0, "TN_HANDLE_INVALID: no such object");
}

}  // extern "C"

namespace {

const tn::binding::Registry& classRegistry() {
    static const tn::binding::Registry classes = [] {
        tn::binding::Registry r;
        tn::binding::registerAll(r);
        return r;
    }();
    return classes;
}

// The registry entry of an object's class: looked up by name once, then read from the object.
const tn::binding::ClassBinding& bindingOf(const tn::binding::Object& object) {
    if (!object.binding) object.binding = &classRegistry().at(object.cls);
    return *object.binding;
}

// keepBytes: a typed array stays its bytes (Value::bytes) for a constructor that keeps them, top level only.
bool toBinding(tn_context* context, const tn_value_t* in, uint32_t count, tn::binding::Args& out, unsigned depth = 0,
               bool keepBytes = false) {
    if (depth > 64 || (count && !in)) return false;
    out.reserve(out.size() + count);  // one allocation, not a growth step per argument
    using Kind = tn::binding::Value::Kind;
    for (uint32_t i = 0; i < count; ++i) {
        const tn_value_t& v = in[i];
        switch (v.kind) {
            case TN_VALUE_NULL:
            case TN_VALUE_UNDEFINED: out.push_back({}); break;
            case TN_VALUE_NUMBER: out.push_back(tn::binding::Value::of(v.number)); break;
            case TN_VALUE_BOOL: out.push_back(tn::binding::Value::of(v.boolean != 0)); break;
            case TN_VALUE_STRING:
                out.push_back(tn::binding::Value{Kind::String, 0, std::string(v.text ? v.text : "", v.text ? v.count : 0)});
                break;
            case TN_VALUE_HANDLE:
                // A handle from another context is not resolvable here; it arrives as an unknown ref.
                out.push_back(tn::binding::Value{Kind::Ref, 0,
                                                 v.handle.context == context->objects.context() ? tn_context::refText(v.handle) : "x"});
                break;
            case TN_VALUE_NUMBERS:
                if (!v.numbers && v.count) return false;
                out.push_back(tn::binding::Value::list(v.count ? std::vector<double>(v.numbers, v.numbers + v.count) : std::vector<double>{}));
                // A typed array names its type in `text` (null-terminated), as `a:Uint16Array:` does.
                if (v.text) out.back().text = v.text;
                break;
            case TN_VALUE_BYTES: {
                const std::string_view type = v.text ? v.text : "";
                const size_t size = tn::binding::typedArrayElementBytes(type);
                if (!size || v.count > SIZE_MAX / size || (!v.bytes && v.count)) return false;
                const std::string_view bytes(static_cast<const char*>(v.bytes), size_t(v.count) * size);
                out.push_back(tn::binding::Value{Kind::Numbers, 0, std::string(type)});
                if (keepBytes) out.back().bytes = bytes;
                else out.back().numbers = tn::binding::typedArrayNumbers(type, bytes);
                break;
            }
            case TN_VALUE_ARRAY: {
                if (v.count > UINT32_MAX) return false;
                tn::binding::Args items;
                if (!toBinding(context, v.values, uint32_t(v.count), items, depth + 1)) return false;
                out.push_back(tn::binding::Value::array(std::move(items)));
                break;
            }
            case TN_VALUE_RECORD: {
                // count alternating string-key/value pairs, as a record is returned (an options object).
                if (v.count > UINT32_MAX / 2 || (v.count && !v.values)) return false;
                std::vector<std::pair<std::string, tn::binding::Value>> fields;
                for (uint64_t k = 0; k < v.count; ++k) {
                    const tn_value_t& key = v.values[k * 2];
                    if (key.kind != TN_VALUE_STRING || (!key.text && key.count)) return false;
                    tn::binding::Args value;
                    if (!toBinding(context, &v.values[k * 2 + 1], 1, value, depth + 1)) return false;
                    fields.emplace_back(std::string(key.text ? key.text : "", key.count), std::move(value[0]));
                }
                out.push_back(tn::binding::Value::record(std::move(fields)));
                break;
            }
            default: return false;
        }
    }
    return true;
}

void fromBinding(tn_context* context, tn_handle_t self, const tn::binding::Value& in, tn_value_t* out, bool root = true) {
    if (root) { context->scratchValues.clear(); context->scratchStrings.clear(); context->scratchArrays.clear(); }
    using Kind = tn::binding::Value::Kind;
    *out = tn_value_t{};
    switch (in.kind) {
        case Kind::Undefined: out->kind = TN_VALUE_UNDEFINED; break;
        case Kind::Null: break;
        case Kind::Number: out->kind = TN_VALUE_NUMBER; out->number = in.number; break;
        case Kind::Bool: out->kind = TN_VALUE_BOOL; out->boolean = in.flag ? 1 : 0; break;
        case Kind::String:
            context->scratchStrings.push_back(in.text);
            out->kind = TN_VALUE_STRING;
            out->text = context->scratchStrings.back().c_str();
            out->count = in.text.size();
            break;
        case Kind::Numbers:
            context->scratchArrays.push_back(in.numbers);
            out->kind = TN_VALUE_NUMBERS;
            out->numbers = context->scratchArrays.back().data();
            out->count = in.numbers.size();
            break;
        case Kind::Ref:
            out->kind = TN_VALUE_HANDLE;
            if (in.text == "\x01self") out->handle = self;
            else context->decode(in.text, out->handle);
            break;
        case Kind::Array:
        case Kind::Record: {
            const bool record = in.kind == Kind::Record;
            const size_t count = record ? in.fields.size() : in.items.size();
            context->scratchValues.emplace_back(count * (record ? 2 : 1));
            auto& values = context->scratchValues.back();
            out->kind = record ? TN_VALUE_RECORD : TN_VALUE_ARRAY;
            out->count = count;
            out->values = values.data();
            for (size_t i = 0; i < count; ++i) {
                if (record) {
                    fromBinding(context, self, tn::binding::Value{Kind::String, 0, in.fields[i].first}, &values[i * 2], false);
                    fromBinding(context, self, in.fields[i].second, &values[i * 2 + 1], false);
                } else fromBinding(context, self, in.items[i], &values[i], false);
            }
            break;
        }
        case Kind::ShaderNode: break; // graph values use the in-process node bridge
        case Kind::Refs: break; // an argument shape only; no binding returns one
    }
}

// Every binding throw stops here: Unsupported becomes TN_ERROR_UNSUPPORTED with its reason,
// anything else (a missing argument) TN_ERROR_INVALID_ARGUMENT. Nothing unwinds into C.
template <typename Call>
tn_status_t guarded(tn_diagnostic_t* diagnostic, Call call) {
    // A graph listener that threw during this call fails this call, as three's would, and no later one.
    std::string& listener = tn::binding::pendingListenerError();
    listener.clear();
    try {
        const tn_status_t status = call();
        if (listener.empty()) return status;
        return report(diagnostic, TN_ERROR_UNSUPPORTED, 0, ("TN_NATIVE_UNSUPPORTED " + std::exchange(listener, {})).c_str());
    } catch (const tn::binding::Unsupported& u) {
        listener.clear();
        return report(diagnostic, TN_ERROR_UNSUPPORTED, 0, ("TN_NATIVE_UNSUPPORTED " + u.reason).c_str());
    } catch (const std::exception& e) {
        listener.clear();
        return report(diagnostic, TN_ERROR_INVALID_ARGUMENT, 0, (std::string("TN_ABI_ARGUMENT ") + e.what()).c_str());
    }
}

std::atomic<uint64_t> gCrossings{0};  // relaxed: a meter, not a synchronisation point

tn_status_t selfObject(tn_handle_t self, tn_context*& context, tn::binding::Object*& object, tn_diagnostic_t* diagnostic) {
    context = contextFor(self.context);
    object = context ? context->object(self) : nullptr;
    if (!object) return report(diagnostic, TN_ERROR_INVALID_HANDLE, 0, "TN_HANDLE_INVALID: no live object");
    return TN_OK;
}

}  // namespace

namespace tn::abi {

tn::binding::Object* objectOf(tn_handle_t handle) {
    tn_context* context = contextFor(handle.context);
    return context ? context->object(handle) : nullptr;
}

uint32_t engineReferences(tn_handle_t handle) {
    tn_context* context = contextFor(handle.context);
    tn::binding::Object* object = context ? context->object(handle) : nullptr;
    if (!object) return 0;
    const auto own = context->ownCopies_.find(object->ptr);
    const long others = object->ptr.use_count() - (own == context->ownCopies_.end() ? 0 : own->second);
    return others > 0 ? static_cast<uint32_t>(others) : 0;
}

tn_handle_t shareObject(tn_context_t* context, std::string cls, std::shared_ptr<void> object) {
    const auto value = context->share(std::move(cls), std::move(object));
    tn_handle_t handle{};
    if (!context->decode(value.text, handle)) throw binding::Unsupported{"TN_NATIVE_OBJECT_SHARE_FAILED"};
    return handle;
}

tn_status_t setNumber(tn_handle_t handle, SetterSlot& slot, const std::string& name, double value, tn_diagnostic_t* diagnostic) {
    gCrossings.fetch_add(1, std::memory_order_relaxed);
    tn_context* context = nullptr;
    tn::binding::Object* object = nullptr;
    if (const tn_status_t s = selfObject(handle, context, object, diagnostic); s != TN_OK) return s;
    const auto& binding = bindingOf(*object);
    if (slot.binding != &binding) {
        const auto found = binding.setters.find(name);
        if (found == binding.setters.end())
            return report(diagnostic, TN_ERROR_UNSUPPORTED, 0, ("TN_NATIVE_UNSUPPORTED " + object->cls + "." + name + " is not settable").c_str());
        slot = {&binding, &found->second};
    }
    return guarded(diagnostic, [&]() -> tn_status_t {
        (*slot.setter)(object->ptr.get(), tn::binding::Value::of(value), *context);
        return ok(diagnostic);
    });
}

engine::shader::graph::Node shaderNode(tn_handle_t handle, const std::string& path) {
    auto* object = objectOf(handle);
    if (!object) throw std::runtime_error("TN_HANDLE_INVALID: shader node owner");
    const auto& getters = classRegistry().at(object->cls).getters;
    const auto found = getters.find(path);
    if (found == getters.end()) throw std::runtime_error("TN_NATIVE_UNSUPPORTED: " + path);
    const auto value = found->second(object->ptr.get());
    if (value.kind != binding::Value::Kind::Null && value.kind != binding::Value::Kind::ShaderNode)
        throw std::runtime_error("TN_TSL_PROPERTY: " + path);
    return value.node;
}

void setShaderNode(tn_handle_t handle, const std::string& path, engine::shader::graph::Node node) {
    auto* context = contextFor(handle.context);
    auto* object = context ? context->object(handle) : nullptr;
    if (!object) throw std::runtime_error("TN_HANDLE_INVALID: shader node owner");
    const auto& setters = classRegistry().at(object->cls).setters;
    const auto found = setters.find(path);
    if (found == setters.end()) throw std::runtime_error("TN_NATIVE_UNSUPPORTED: " + path);
    found->second(object->ptr.get(), binding::Value::shaderNode(std::move(node)), *context);
}

engine::shader::graph::Node tslNode(tn_context_t* context, uint64_t id) {
    if (!context) return nullptr;
    const auto found = context->tslNodes.find(id);
    return found == context->tslNodes.end() ? nullptr : found->second;
}

uint64_t crossings() { return gCrossings.load(std::memory_order_relaxed); }

}  // namespace tn::abi

extern "C" {

tn_status_t tn_construct(tn_context_t* context, const char* class_name, const tn_value_t* args, uint32_t arg_count,
                         tn_handle_t* out_object, tn_diagnostic_t* diagnostic) {
    gCrossings.fetch_add(1, std::memory_order_relaxed);
    if (!context || !class_name || !out_object || (arg_count && !args)) {
        return report(diagnostic, TN_ERROR_INVALID_ARGUMENT, 0, "TN_ABI_NULL: context, class, args or out_object");
    }
    *out_object = tn_handle_t{};
    const auto cls = classRegistry().find(class_name);
    if (cls == classRegistry().end() || !cls->second.ctor) {
        return report(diagnostic, TN_ERROR_UNSUPPORTED, 0, (std::string("TN_NATIVE_UNSUPPORTED class ") + class_name).c_str());
    }
    return guarded(diagnostic, [&]() -> tn_status_t {
        tn::binding::Args in;
        if (!toBinding(context, args, arg_count, in, 0, cls->second.ctorTakesBytes)) return report(diagnostic, TN_ERROR_INVALID_ARGUMENT, 0, "TN_ABI_VALUE: bad value kind");
        if (!context->hold(class_name, cls->second.ctor(in, *context), *out_object)) {
            return report(diagnostic, TN_ERROR_UNSUPPORTED, 0, (std::string("TN_NATIVE_UNSUPPORTED catalog class ") + class_name).c_str());
        }
        return ok(diagnostic);
    });
}

tn_status_t tn_invoke(tn_handle_t self, const char* method, const tn_value_t* args, uint32_t arg_count, tn_value_t* result,
                      tn_diagnostic_t* diagnostic) {
    gCrossings.fetch_add(1, std::memory_order_relaxed);
    tn_context* context = nullptr;
    tn::binding::Object* object = nullptr;
    if (!method || !result || (arg_count && !args)) return report(diagnostic, TN_ERROR_INVALID_ARGUMENT, 0, "TN_ABI_NULL: method, args or result");
    if (const tn_status_t s = selfObject(self, context, object, diagnostic); s != TN_OK) return s;
    const auto& methods = bindingOf(*object).methods;
    const auto m = methods.find(method);
    if (m == methods.end()) {
        return report(diagnostic, TN_ERROR_UNSUPPORTED, 0, ("TN_NATIVE_UNSUPPORTED " + object->cls + "." + method + "()").c_str());
    }
    return guarded(diagnostic, [&]() -> tn_status_t {
        tn::binding::Args in;
        if (!toBinding(context, args, arg_count, in)) return report(diagnostic, TN_ERROR_INVALID_ARGUMENT, 0, "TN_ABI_VALUE: bad value kind");
        void* target = object->ptr.get();
        fromBinding(context, self, m->second(target, in, *context), result);
        return ok(diagnostic);
    });
}

tn_status_t tn_get(tn_handle_t self, const char* path, tn_value_t* result, tn_diagnostic_t* diagnostic) {
    gCrossings.fetch_add(1, std::memory_order_relaxed);
    tn_context* context = nullptr;
    tn::binding::Object* object = nullptr;
    if (!path || !result) return report(diagnostic, TN_ERROR_INVALID_ARGUMENT, 0, "TN_ABI_NULL: path or result");
    if (const tn_status_t s = selfObject(self, context, object, diagnostic); s != TN_OK) return s;
    const tn::binding::ClassBinding& binding = bindingOf(*object);
    const auto g = binding.getters.find(path);
    const auto m = binding.members.find(path);
    if (g == binding.getters.end() && m == binding.members.end())
        return report(diagnostic, TN_ERROR_UNSUPPORTED, 0, ("TN_NATIVE_UNSUPPORTED " + object->cls + "." + path).c_str());
    return guarded(diagnostic, [&]() -> tn_status_t {
        void* ptr = object->ptr.get();
        const auto value = g != binding.getters.end() ? g->second(ptr) : m->second(ptr, {}, *context);
        if (value.kind == tn::binding::Value::Kind::ShaderNode)
            return report(diagnostic, TN_ERROR_UNSUPPORTED, 0, "TN_TSL_NATIVE_BRIDGE: shader graph requires the node adapter");
        fromBinding(context, self, value, result);
        return ok(diagnostic);
    });
}

tn_status_t tn_set(tn_handle_t self, const char* path, const tn_value_t* value, tn_diagnostic_t* diagnostic) {
    gCrossings.fetch_add(1, std::memory_order_relaxed);
    tn_context* context = nullptr;
    tn::binding::Object* object = nullptr;
    if (!path || !value) return report(diagnostic, TN_ERROR_INVALID_ARGUMENT, 0, "TN_ABI_NULL: path or value");
    if (const tn_status_t s = selfObject(self, context, object, diagnostic); s != TN_OK) return s;
    const auto& setters = bindingOf(*object).setters;
    const auto st = setters.find(path);
    if (st == setters.end()) return report(diagnostic, TN_ERROR_UNSUPPORTED, 0, ("TN_NATIVE_UNSUPPORTED " + object->cls + "." + path + " is not settable").c_str());
    return guarded(diagnostic, [&]() -> tn_status_t {
        if (value->kind == TN_VALUE_NUMBER) {  // the hot write: one Value on the stack, not an argument vector
            const auto number = tn::binding::Value::of(value->number);
            st->second(object->ptr.get(), number, *context);
            return ok(diagnostic);
        }
        tn::binding::Args in;
        if (!toBinding(context, value, 1, in)) return report(diagnostic, TN_ERROR_INVALID_ARGUMENT, 0, "TN_ABI_VALUE: bad value kind");
        st->second(object->ptr.get(), in[0], *context);
        return ok(diagnostic);
    });
}

tn_status_t tn_set_callback(tn_handle_t self, const char* name, tn_object_callback_t invoke, void* callback_context,
                            tn_release_t release, tn_diagnostic_t* diagnostic) {
    gCrossings.fetch_add(1, std::memory_order_relaxed);
    tn_context* context = nullptr;
    tn::binding::Object* object = nullptr;
    if (!name) return report(diagnostic, TN_ERROR_INVALID_ARGUMENT, 0, "TN_ABI_NULL: name");
    if (const tn_status_t s = selfObject(self, context, object, diagnostic); s != TN_OK) return s;
    const auto& binding = classRegistry().at(object->cls);
    if (const auto event = binding.events.find(name); event != binding.events.end()) {
        if (!invoke) {
            event->second(object->ptr.get(), nullptr, *context);
            return ok(diagnostic);
        }
        std::shared_ptr<void> owner(callback_context, [release](void* c) {
            if (release) release(c);
        });
        auto callback = std::make_shared<const std::function<bool(const tn::binding::Value&, std::string&)>>(
            [invoke, owner, context, self](const tn::binding::Value& value, std::string& error) {
                tn_value_t arg{};
                fromBinding(context, self, value, &arg);
                char message[512] = {};
                if (invoke(owner.get(), &arg, 1, message, sizeof message) == TN_OK) return true;
                message[sizeof message - 1] = '\0';
                error = message[0] ? message : "the listener failed";
                return false;
            });
        event->second(object->ptr.get(), std::move(callback), *context);
        return ok(diagnostic);
    }
    const auto& callbacks = binding.callbacks;
    const auto set = callbacks.find(name);
    if (set == callbacks.end())
        return report(diagnostic, TN_ERROR_UNSUPPORTED, 0, ("TN_NATIVE_UNSUPPORTED " + object->cls + "." + name + " callback").c_str());
    if (!invoke) {
        set->second(object->ptr.get(), nullptr);  // the replaced pair is released by its owner below
        return ok(diagnostic);
    }
    // Owns the language's context: its deleter is `release`, so the pair is released exactly once,
    // whenever the last reference to the callback goes (replaced, cleared or its object destroyed).
    std::shared_ptr<void> owner(callback_context, [release](void* c) {
        if (release) release(c);
    });
    auto callback = std::make_shared<const std::function<bool(const tn::engine::RenderCallbackArgs&, std::string&)>>(
        [invoke, owner, context](const tn::engine::RenderCallbackArgs& a, std::string& error) {
            const tn_value_t args[6] = {{},
                                        context->valueOf(a.scene),
                                        context->valueOf(a.camera),
                                        context->valueOf("BufferGeometry", a.geometry),
                                        a.material ? context->valueOf(std::string(a.material->typeName()), a.material) : tn_value_t{},
                                        {}};
            char message[512] = {};
            if (invoke(owner.get(), args, 6, message, sizeof message) == TN_OK) return true;
            message[sizeof message - 1] = '\0';
            error = message[0] ? message : "the callback failed";
            return false;
        });
    set->second(object->ptr.get(), std::move(callback));
    return ok(diagnostic);
}

void tn_diagnostic_release(tn_diagnostic_t* diagnostic) {
    if (!diagnostic) return;
    std::free(diagnostic->message);
    diagnostic->message = nullptr;
    diagnostic->code = 0;
}

}  // extern "C"

extern "C" tn_status_t tn_tsl_build(tn_context_t* context, const char* operation,
                                     uint64_t a, uint64_t b, uint64_t c, double value,
                                     uint64_t* out_node, tn_diagnostic_t* diagnostic) {
    if (!context || !operation || !out_node || !std::isfinite(value))
        return report(diagnostic, TN_ERROR_INVALID_ARGUMENT, 0, "TN_TSL_ARGUMENT");
    *out_node = 0;
    return guarded(diagnostic, [&]() -> tn_status_t {
        namespace g = tn::engine::shader::graph;
        const auto node = [&](uint64_t id) -> g::Node {
            const auto it = context->tslNodes.find(id);
            if (it == context->tslNodes.end()) throw std::runtime_error("TN_TSL_NODE_INVALID");
            return it->second;
        };
        const std::string_view op(operation);
        g::Node result;
        if (op == "float") result = g::float_(value);
        else if (op == "uv") result = g::uv();
        else if (op == "x") result = g::swizzle(node(a), "x");
        else if (op == "add") result = g::add(node(a), node(b));
        else if (op == "mul") result = g::mul(node(a), node(b));
        else if (op == "sin") result = g::sin(node(a));
        else if (op == "vec3") result = g::vec3({node(a), node(b), node(c)});
        else return report(diagnostic, TN_ERROR_UNSUPPORTED, 0,
                           ("TN_TSL_DYNAMIC_UNSUPPORTED " + std::string(op)).c_str());
        const uint64_t id = ++context->nextTslNode;
        context->tslNodes.emplace(id, std::move(result));
        *out_node = id;
        return ok(diagnostic);
    });
}

namespace {
/** tn_tsl_arg_t values as the shared table takes them; a node id must belong to this context. */
tn_status_t tslArgs(tn_context_t* context, const tn_tsl_arg_t* args, uint32_t arg_count,
                    std::vector<tn::abi::TslArg>& converted, tn_diagnostic_t* diagnostic) {
    const auto node = [&](uint64_t id) {
        const auto it = context->tslNodes.find(id);
        if (it == context->tslNodes.end()) throw std::runtime_error("TN_TSL_NODE_INVALID");
        return it->second;
    };
    converted.reserve(arg_count);
    for (uint32_t i = 0; i < arg_count; ++i) {
        const tn_tsl_arg_t& a = args[i];
        switch (a.kind) {
            case TN_TSL_ARG_NODE: converted.push_back(tn::abi::TslArg::of(node(a.node))); break;
            case TN_TSL_ARG_NUMBER: converted.push_back(tn::abi::TslArg::of(a.number)); break;
            case TN_TSL_ARG_STRING: converted.push_back(tn::abi::TslArg::of(std::string(a.text ? a.text : ""))); break;
            case TN_TSL_ARG_NAMED: converted.push_back(tn::abi::TslArg::named(a.text ? a.text : "")); break;
            case TN_TSL_ARG_RGB: converted.push_back(tn::abi::TslArg::rgbOf(a.numbers[0], a.numbers[1], a.numbers[2])); break;
            case TN_TSL_ARG_VECTOR:
                if (a.reserved < 2 || a.reserved > 4) return report(diagnostic, TN_ERROR_INVALID_ARGUMENT, 0, "TN_TSL_ARGUMENT lanes");
                converted.push_back(tn::abi::TslArg::vectorOf(static_cast<uint8_t>(a.reserved), a.numbers));
                break;
            case TN_TSL_ARG_OTHER: converted.push_back(tn::abi::TslArg::other()); break;
            case TN_TSL_ARG_HANDLE: {
                tn_handle_t h{};
                std::memcpy(&h, &a.reserved, 4);
                std::memcpy(reinterpret_cast<char*>(&h) + 4, &a.node, 8);
                const tn::binding::Object* o = context->object(h);
                if (!o) return report(diagnostic, TN_ERROR_INVALID_ARGUMENT, 0, "TN_TSL_ARGUMENT handle");
                converted.push_back(tn::abi::TslArg::objectOf(o->cls, o->ptr));
                break;
            }
            default: return report(diagnostic, TN_ERROR_INVALID_ARGUMENT, 0, "TN_TSL_ARGUMENT kind");
        }
    }
    return TN_OK;
}
}  // namespace

extern "C" tn_status_t tn_tsl_call(tn_context_t* context, const char* name, const uint64_t* receiver,
                                    const tn_tsl_arg_t* args, uint32_t arg_count, uint64_t* out_node,
                                    tn_diagnostic_t* diagnostic) {
    if (!context || !name || !out_node || (arg_count && !args))
        return report(diagnostic, TN_ERROR_INVALID_ARGUMENT, 0, "TN_TSL_ARGUMENT");
    *out_node = 0;
    return guarded(diagnostic, [&]() -> tn_status_t {
        const auto node = [&](uint64_t id) {
            const auto it = context->tslNodes.find(id);
            if (it == context->tslNodes.end()) throw std::runtime_error("TN_TSL_NODE_INVALID");
            return it->second;
        };
        std::vector<tn::abi::TslArg> converted;
        if (const tn_status_t s = tslArgs(context, args, arg_count, converted, diagnostic); s != TN_OK) return s;
        const tn::abi::TslArg self = receiver ? tn::abi::TslArg::of(node(*receiver)) : tn::abi::TslArg{};
        tn::engine::shader::graph::Node result;
        if (context->tslScopes.call(name, receiver ? &self : nullptr, converted, result)) {
            if (!result) return ok(diagnostic);  // scope:open makes no node
        } else if (!(result = tn::abi::tslCall(name, receiver ? &self : nullptr, converted, context->tslSerial)))
            return report(diagnostic, TN_ERROR_UNSUPPORTED, 0, ("TN_TSL_DYNAMIC_UNSUPPORTED " + std::string(name)).c_str());
        const uint64_t id = ++context->nextTslNode;
        context->tslNodes.emplace(id, std::move(result));
        *out_node = id;
        return ok(diagnostic);
    });
}

extern "C" tn_status_t tn_tsl_effect_parameter(tn_context_t* context, const uint64_t* node, const char* name,
                                               const double* value, double* out, tn_diagnostic_t* diagnostic) {
    if (!context || !node || !name || !out || !context->tslNodes.contains(*node))
        return report(diagnostic, TN_ERROR_INVALID_ARGUMENT, 0, "TN_TSL_ARGUMENT");
    return guarded(diagnostic, [&]() -> tn_status_t {
        *out = tn::abi::tslEffectParameter(context->tslNodes.at(*node), name, value);
        return ok(diagnostic);
    });
}


extern "C" tn_status_t tn_tsl_set_uniform(tn_context_t* context, const uint64_t* node, const double* values,
                                           uint32_t count, tn_diagnostic_t* diagnostic) {
    if (!context || !node || (count && !values) || !context->tslNodes.contains(*node))
        return report(diagnostic, TN_ERROR_INVALID_ARGUMENT, 0, "TN_TSL_ARGUMENT");
    return guarded(diagnostic, [&]() -> tn_status_t {
        tn::abi::tslSetUniform(context->tslNodes.at(*node), values, count);
        return ok(diagnostic);
    });
}

extern "C" tn_status_t tn_tsl_release(tn_context_t* context, uint64_t node, tn_diagnostic_t* diagnostic) {
    if (!context || context->tslNodes.erase(node) != 1)
        return report(diagnostic, TN_ERROR_INVALID_HANDLE, 0, "TN_TSL_NODE_INVALID");
    return ok(diagnostic);
}

extern "C" tn_status_t tn_tsl_set(tn_context_t* context, tn_handle_t material, const char* path,
                                   uint64_t node, tn_diagnostic_t* diagnostic) {
    if (!context || material.context != context->objects.context() || !path || !context->tslNodes.contains(node))
        return report(diagnostic, TN_ERROR_INVALID_ARGUMENT, 0, "TN_TSL_ARGUMENT");
    return guarded(diagnostic, [&]() -> tn_status_t {
        tn::abi::setShaderNode(material, path, context->tslNodes.at(node));
        return ok(diagnostic);
    });
}

extern "C" tn_status_t tn_tsl_compile(tn_handle_t material, const char* wgsl_path, tn_diagnostic_t* diagnostic) {
    return guarded(diagnostic, [&]() -> tn_status_t {
        namespace s = tn::engine::shader;
        s::VertexVariant variant;
        variant.nodes.colorNode = tn::abi::shaderNode(material, "colorNode");
        if (!variant.nodes.colorNode) return report(diagnostic, TN_ERROR_INVALID_STATE, 0, "TN_TSL_GRAPH_MISSING");
        const auto programs = s::buildBasic(variant);
        const auto vertex = s::WgslEmitter::emit(programs.vertex);
        const auto fragment = s::WgslEmitter::emit(programs.fragment, 1);
        if (!programs.diagnostics.empty() || !vertex.ok() || !fragment.ok())
            return report(diagnostic, TN_ERROR_UNSUPPORTED, 0, "TN_TSL_DYNAMIC_UNSUPPORTED graph lowering");
        if (wgsl_path && *wgsl_path) {
            std::ofstream file(wgsl_path);
            file << vertex.code << "\n" << fragment.code;
            file.close();
            if (!file) return report(diagnostic, TN_ERROR_INVALID_STATE, 0, "TN_TSL_WGSL_WRITE_FAILED");
        }
        return ok(diagnostic);
    });
}

// A JS back end that shares the engine's memory (the Wasm one) answers three's `attribute.array`
// with a typed array over the attribute's own storage, so an element write is a write to the
// attribute. The view leases the store, so it cannot reallocate under the view, until
// tnw_attribute_view_release. out[0] is the data address, out[1] the element count, out[2] the
// Scalar and out[3] the store's write count, which the view itself leaves: the JS side writes through
// it only the copy it keeps. The result is the lease (0: not an attribute).
extern "C" uintptr_t tnw_attribute_view(const tn_handle_t* attribute, uint64_t* out) {
    tn::binding::Object* object = attribute ? tn::abi::objectOf(*attribute) : nullptr;
    if (object == nullptr || out == nullptr) return 0;
    const std::string& cls = object->cls;
    if (cls != "BufferAttribute" && cls != "Float32BufferAttribute" && cls != "Uint16BufferAttribute" &&
        cls != "Uint32BufferAttribute" && cls != "InstancedBufferAttribute")
        return 0;
    auto store = static_cast<tn::engine::BufferAttribute*>(object->ptr.get())->store;
    store->acquireLease();
    out[0] = reinterpret_cast<uintptr_t>(std::as_const(*store).data());
    out[1] = store->count();
    out[2] = static_cast<uint64_t>(store->scalar());
    out[3] = store->writes();
    return reinterpret_cast<uintptr_t>(new std::shared_ptr<tn::engine::BufferStore>(std::move(store)));
}

extern "C" void tnw_attribute_view_release(uintptr_t lease) {
    auto* store = reinterpret_cast<std::shared_ptr<tn::engine::BufferStore>*>(lease);
    if (store == nullptr) return;
    (*store)->releaseLease();
    delete store;
}
