#pragma once

#include <cstdint>
#include <chrono>
#include <memory>
#include <set>
#include <string>
#include <vector>
#include <unordered_map>

#include <v8.h>

#include "threenative/abi/tn_abi.h"

namespace tn::adapters::v8adapter {

class Tsl;
class MathBridge;

/**
 * The V8 game-runtime adapter (PRD-531): JS sees the engine's classes as ordinary constructors
 * (`new Vector3(1, 2, 3)`), built at install time from the engine's binding registry, and every
 * call goes through the C ABI. A JS wrapper holds its handle in an internal field — handles never
 * cross as JS numbers — and one wrapper exists per live handle, so `m.makeTranslation(...) === m`.
 * A collected wrapper releases its handle.
 */
class Adapter {
public:
    Adapter(v8::Isolate* isolate, tn_context_t* context);
    ~Adapter();
    Adapter(const Adapter&) = delete;
    Adapter& operator=(const Adapter&) = delete;

    /**
     * Runs the value classes as three's own JS (PRD-573 v1.11 step 4a): `Vector3`, `Matrix4`, `Color` and the rest
     * of the math are the bundled upstream sources, native objects hand JS views over their own memory, and a JS
     * value passed to a native call is copied across. Call before install; off by default. install throws
     * std::runtime_error when the build embeds no math script.
     */
    void enableGcTelemetry();
    void setJsMath(bool on) { jsMath_ = on; }
    bool jsMath() const { return jsMath_; }
    /** The JS math bridge, or null while JS math is off. */
    MathBridge* math() const { return math_.get(); }

    /** Defines one constructor per registered class on `target` (a namespace object or global). */
    void install(v8::Local<v8::Context> context, v8::Local<v8::Object> target);

    /**
     * A safe point (PRD-531): a wrapper is held strongly while other engine objects reference its
     * object (a parent, a material slot, a mixer), so its JS state (userData, expandos, a subclass)
     * survives while only the engine reaches it, and weakly otherwise. The JS -> engine reference
     * does not count, so a detached object, its closures and its wrapper are a plain JS cycle the
     * collector reclaims, and the reclaimed wrapper releases the object. The host calls this
     * between frames; a GC prologue also promotes wrappers the engine took since the last one.
     * It decides only for wrappers made or held by a call since the last safe point, unless the
     * engine's ownership epoch moved (tn::abi::ownershipEpoch), when it decides for every wrapper.
     */
    void collect();
    /** An engine object passed into a call is held until the next safe point decides. */
    void holdIfCallback(tn_handle_t handle);

    /** The one wrapper for a handle, created on first sight. */
    v8::Local<v8::Value> wrap(tn_handle_t handle);
    /** The handle a wrapper holds; false for anything that is not an engine object. */
    bool unwrap(v8::Local<v8::Value> value, tn_handle_t& out) const;
    /** unwrap, then what holdIfCallback does for the handle, without a second lookup of the wrapper. */
    bool unwrapForCall(v8::Local<v8::Value> value, tn_handle_t& out);

    Tsl& tsl() const { return *tsl_; }

    tn_context_t* context() const { return context_; }
    v8::Isolate* isolate() const { return isolate_; }
    size_t liveWrappers() const { return wrappers_.size(); }
    /** Wrappers collect() has looked at, ever: a safe point with nothing new and no ownership change adds none. */
    uint64_t collectVisits() const { return collectVisits_; }
    /** Calls whose arguments needed the general converter (strings, arrays, objects): the numeric fast path leaves it at rest. */
    uint64_t genericArguments() const { return genericArguments_; }
    void noteGenericArguments() { ++genericArguments_; }

private:
    // What install() allocates as its functions' data (method and accessor records): owned here and
    // freed with the adapter, whose installed functions JS no longer calls once it is gone, as for its
    // wrappers. One install per isolate leaked them before, so a process that made isolates grew.
    std::vector<std::shared_ptr<void>> installed_;
    template <typename T> T* keep(T* made) {
        installed_.emplace_back(std::shared_ptr<T>(made));
        return made;
    }
    struct Wrapper;
    struct CallbackData;
    static uint64_t key(tn_handle_t h) { return (uint64_t{h.index} << 32) | h.generation; }
    void forget(uint64_t key);
    void visit(Wrapper* wrapper);
    void decideAtNextSafePoint(Wrapper* wrapper);
    void track(Wrapper* wrapper, v8::Local<v8::Object> object);
    void strong(Wrapper* wrapper);
    void weak(Wrapper* wrapper);
    static void promote(v8::Isolate* isolate, v8::GCType type, v8::GCCallbackFlags flags, void* data);
    static void gcStarted(v8::Isolate*, v8::GCType, v8::GCCallbackFlags, void* data);
    static void gcFinished(v8::Isolate*, v8::GCType, v8::GCCallbackFlags, void* data);
    bool gcTelemetry_ = false;
    std::chrono::steady_clock::time_point gcStarted_{};
    static tn_status_t invokeCallback(void* context, const tn_value_t* args, uint32_t count, char* error,
                                      uint32_t capacity);
    static void setCallback(const v8::FunctionCallbackInfo<v8::Value>& info);
    static void getCallback(const v8::FunctionCallbackInfo<v8::Value>& info);
    // three's EventDispatcher over a class's native events: the listeners are JS functions kept on
    // the wrapper, and the engine calls back once per dispatched event of a type with a listener.
    static void eventListener(const v8::FunctionCallbackInfo<v8::Value>& info);
    static tn_status_t invokeEvent(void* context, const tn_value_t* args, uint32_t count, char* error, uint32_t capacity);
    static bool callListeners(Adapter& a, v8::Local<v8::Object> self, v8::Local<v8::Object> event);

    bool jsMath_ = false;
    std::unique_ptr<MathBridge> math_;
    uint64_t genericArguments_ = 0;
    uint64_t collectVisits_ = 0;
    uint64_t ownershipSeen_ = 0;          // tn::abi::ownershipEpoch() at the last full decision
    unsigned safePointsSinceFull_ = 0;
    std::vector<uint64_t> undecided_;     // wrappers new or held by a call since the last safe point, by key
    std::unique_ptr<Tsl> tsl_;
    v8::Isolate* isolate_;
    tn_context_t* context_;
    v8::Global<v8::ObjectTemplate> instanceTemplate_;
    std::unordered_map<uint16_t, v8::Global<v8::FunctionTemplate>> classes_;  // by catalog type id
    std::unordered_map<uint64_t, Wrapper*> wrappers_;
    v8::Global<v8::Context> context_v8_;  // where callbacks run; set by install
    std::unordered_map<std::string, v8::Global<v8::Private>> callbackKeys_;  // by callback name
    v8::Global<v8::Private> listenersKey_;  // a wrapper's EventDispatcher listeners: {type: [fn, ...]}
};

}  // namespace tn::adapters::v8adapter
