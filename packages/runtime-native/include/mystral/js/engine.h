/**
 * JavaScript Engine Abstraction
 *
 * This header defines a common interface for JavaScript engines.
 * Implementations exist for QuickJS, V8, and JavaScriptCore.
 */

#pragma once

#include <memory>
#include <string>
#include <functional>
#include <vector>
#include <unordered_map>
#include <csignal>
#include <ctime>
#include <cstdint>
#include <cstddef>

namespace mystral {
namespace js {

/**
 * JavaScript value handle
 * Opaque handle to a JS value in the engine
 */
struct JSValueHandle {
    void* ptr = nullptr;
    void* ctx = nullptr;  // Context needed for some operations
    bool borrowed = false;  // Callback-local value; valid only for the synchronous call.
};

// PRD-222 attribution probe: totals for every JS -> native callback crossing, incremented only
// under TN_ANDROID_JS_PROFILE. g_bridgeNs counts top-level callbacks only, so nested callbacks are
// not double counted; the difference between render-thread work and g_bridgeNs is time JavaScript
// spent outside the native bridge.
inline uint64_t g_bridgeCalls = 0;
inline uint64_t g_bridgeNs = 0;
inline uint64_t g_bridgeArgs = 0;
// Trampoline-only cost: entry scope, argument Persistent promotion, protected-handle lookups and
// release, excluding the native callee body itself.
inline uint64_t g_bridgeOverheadNs = 0;
// Wall time spent inside the JavaScript requestAnimationFrame dispatch (bridge time nests inside).
inline uint64_t g_jsFrameNs = 0;
// Screenshot mode leaves through _exit(), which runs no destructor, so the sampled JavaScript
// profile has to be flushed explicitly from the exit path.
inline std::function<void()> g_dumpCpuProfile;
// Started on demand at the first eligible frame so shader compilation and asset decode during
// startup do not contaminate the steady-state sample.
inline std::function<void()> g_startCpuProfile;
// Where `--cpu-prof <path>` wants the DevTools `.cpuprofile` written. Empty means the printed
// self-time summary is the whole output, which is what TN_JS_CPU_PROFILE alone has always done.
inline std::string g_cpuProfilePath;
// Set when a requested profile could not be written, so the host exits non-zero instead of
// reporting a green run whose artifact is missing.
inline bool g_cpuProfileFailed = false;
// Set from a SIGTERM handler, which may only touch a signal-safe flag: the render loop notices it
// on the next frame and flushes the profile from a normal context, where calling V8 is safe.
inline volatile std::sig_atomic_t g_cpuProfileStopRequested = 0;
// Render-thread CPU clock, matching the threadCpuNs field the frame marker reports, so JS/bridge
// shares are comparable with the frame's work figure instead of mixing wall and CPU time.
inline uint64_t threadCpuNs() {
#if defined(CLOCK_THREAD_CPUTIME_ID)
    timespec ts{};
    if (clock_gettime(CLOCK_THREAD_CPUTIME_ID, &ts) == 0) {
        return static_cast<uint64_t>(ts.tv_sec) * 1000000000ull + static_cast<uint64_t>(ts.tv_nsec);
    }
#endif
    return 0;
}
// Per-callback attribution: NativeFunction* -> display name, and NativeFunction* -> (calls, ns).
inline std::unordered_map<const void*, std::string>& bridgeNames() {
    static std::unordered_map<const void*, std::string> m;
    return m;
}
struct BridgeStat { uint64_t calls = 0; uint64_t ns = 0; };
inline std::unordered_map<const void*, BridgeStat>& bridgeStats() {
    static std::unordered_map<const void*, BridgeStat> m;
    return m;
}

enum class JSPropertyKind {
    Missing,
    Data,
    Accessor,
};

/**
 * A property description resolved from an object through its prototype chain without invoking
 * accessors. Proxy descriptor and getPrototypeOf traps may run and may have side effects. A data
 * value is an owned snapshot that remains valid until releasePropertyInfo() is called.
 */
struct JSPropertyInfo {
    JSPropertyKind kind = JSPropertyKind::Missing;
    bool own = false;
    bool writable = false;
    bool enumerable = false;
    bool configurable = false;
    JSValueHandle value;
};

/**
 * Native function signature
 * Called from JavaScript with arguments, returns a value
 */
using NativeFunction = std::function<JSValueHandle(void* ctx, const std::vector<JSValueHandle>& args)>;

/**
 * Native method signature: like NativeFunction, plus the receiver.
 *
 * `receiverPrivate` is the private data previously set on the receiver object with
 * setPrivateData(), or nullptr when the receiver carries none or is not an object. A class's
 * binding table installs once on a shared prototype and resolves its native handle from the
 * receiver at call time, instead of capturing one wrapper's handle per instance.
 */
class Engine;
using NativeMethod = std::function<JSValueHandle(Engine& engine, void* receiverPrivate, const std::vector<JSValueHandle>& args)>;

/**
 * Engine type enumeration
 */
enum class EngineType {
    QuickJS,
    V8,
    JavaScriptCore,
    Unknown
};

/**
 * Abstract JavaScript engine interface
 */
class Engine {
public:
    virtual ~Engine() = default;

    /**
     * Get the engine type
     */
    virtual EngineType getType() const = 0;

    /**
     * Get the engine name as a string
     */
    virtual const char* getName() const = 0;

    // ========================================================================
    // Script Evaluation
    // ========================================================================

    /**
     * Evaluate JavaScript code
     * @param code The JavaScript source code
     * @param filename Filename for error messages
     * @return true on success, false on error
     */
    virtual bool eval(const char* code, const char* filename = "<eval>") = 0;

    /**
     * Evaluate JavaScript and return the result
     * @param code The JavaScript source code
     * @param filename Filename for error messages
     * @return The result value handle
     */
    virtual JSValueHandle evalWithResult(const char* code, const char* filename = "<eval>") = 0;

    /**
     * Evaluate JavaScript as a classic script (non-module).
     * Useful for CommonJS wrappers or JSON modules.
     */
    virtual bool evalScript(const char* code, const char* filename = "<eval>") = 0;

    /**
     * Evaluate a classic script and return the result.
     */
    virtual JSValueHandle evalScriptWithResult(const char* code, const char* filename = "<eval>") = 0;

    // ========================================================================
    // Global Object Access
    // ========================================================================

    /**
     * Get the global object
     */
    virtual JSValueHandle getGlobal() = 0;

    /**
     * Set a property on the global object
     */
    virtual bool setGlobalProperty(const char* name, JSValueHandle value) = 0;

    /**
     * Get a property from the global object
     */
    virtual JSValueHandle getGlobalProperty(const char* name) = 0;

    // ========================================================================
    // Value Creation
    // ========================================================================

    virtual JSValueHandle newUndefined() = 0;
    virtual JSValueHandle newNull() = 0;
    virtual JSValueHandle newBoolean(bool value) = 0;
    virtual JSValueHandle newNumber(double value) = 0;
    virtual JSValueHandle newString(const char* value) = 0;
    virtual JSValueHandle newObject() = 0;

    /**
     * True when this engine can instantiate native wrappers from one cached class template.
     * V8 uses an ObjectTemplate with an internal field; engines without that capability keep
     * the legacy ordinary-object/private-data path behind this explicit gate.
     */
    virtual bool supportsNativeObjectTemplates() const { return false; }

    /**
     * Instantiate a fixed-shape native wrapper for className and store nativeData without a
     * JavaScript property lookup. Call only when supportsNativeObjectTemplates() is true.
     */
    virtual JSValueHandle newNativeObject(const char* className, void* nativeData) {
        (void)className;
        (void)nativeData;
        return {};
    }

    virtual JSValueHandle newArray(size_t length = 0) = 0;

    /**
     * Create an ArrayBuffer from raw bytes
     * @param data Pointer to the data (will be copied)
     * @param length Size in bytes
     * @return ArrayBuffer handle
     */
    virtual JSValueHandle newArrayBuffer(const uint8_t* data, size_t length) = 0;

    /**
     * Create an ArrayBuffer backed by external memory (no copy)
     * WARNING: The memory must remain valid for the lifetime of the ArrayBuffer
     * @param data Pointer to external memory
     * @param length Size in bytes
     * @return ArrayBuffer handle that directly references the external memory
     */
    virtual JSValueHandle newArrayBufferExternal(void* data, size_t length) = 0;

    /**
     * Get the raw data pointer from an ArrayBuffer or TypedArray
     * @param value The ArrayBuffer or TypedArray handle
     * @param size Output: size in bytes (optional, can be nullptr)
     * @return Pointer to the data, or nullptr if not an ArrayBuffer/TypedArray
     */
    virtual void* getArrayBufferData(JSValueHandle value, size_t* size) = 0;

    /**
     * Create a Float32Array from raw data
     * @param data Pointer to the float data (will be copied)
     * @param count Number of floats
     * @return Float32Array handle
     */
    virtual JSValueHandle createFloat32Array(const float* data, size_t count) = 0;

    /**
     * Create a Float32Array view into external memory (no copy)
     * @param data Pointer to the float data (NOT copied - caller must ensure lifetime)
     * @param count Number of floats
     * @return Float32Array handle backed by the external memory
     */
    virtual JSValueHandle createFloat32ArrayView(float* data, size_t count) = 0;

    /**
     * Create a Uint32Array from raw data
     * @param data Pointer to the uint32 data (will be copied)
     * @param count Number of uint32s
     * @return Uint32Array handle
     */
    virtual JSValueHandle createUint32Array(const uint32_t* data, size_t count) = 0;

    /**
     * Create a Uint8Array from raw data
     * @param data Pointer to the uint8 data (will be copied)
     * @param count Number of bytes
     * @return Uint8Array handle
     */
    virtual JSValueHandle createUint8Array(const uint8_t* data, size_t count) = 0;

    /**
     * Create a function from a native callback
     */
    virtual JSValueHandle newFunction(const char* name, NativeFunction fn) = 0;

    /**
     * True when newMethod() returns usable functions on this engine build. Callers gate the
     * per-class binding-table install on it and fall back to the per-instance install.
     */
    virtual bool supportsNativeMethods() const { return false; }

    /**
     * Create a function whose callback receives the call's receiver. A shared class prototype
     * uses this so one binding table serves every wrapper instance instead of an install per
     * call. Engines without a receiver-aware trampoline return a null handle; gate on
     * supportsNativeMethods().
     */
    virtual JSValueHandle newMethod(const char* name, NativeMethod fn) {
        (void)name;
        (void)fn;
        return {};
    }

    /**
     * Re-point an ordinary object at another object as its prototype. Used to share one class
     * binding table across all instances created from it. Returns false where unsupported or
     * when the operation threw.
     */
    virtual bool setPrototypeOf(JSValueHandle object, JSValueHandle prototype) {
        (void)object;
        (void)prototype;
        return false;
    }

    // ========================================================================
    // Value Conversion
    // ========================================================================

    virtual bool toBoolean(JSValueHandle value) = 0;
    virtual double toNumber(JSValueHandle value) = 0;
    virtual std::string toString(JSValueHandle value) = 0;

    virtual bool isUndefined(JSValueHandle value) = 0;
    virtual bool isNull(JSValueHandle value) = 0;
    virtual bool isBoolean(JSValueHandle value) = 0;
    virtual bool isNumber(JSValueHandle value) = 0;
    virtual bool isString(JSValueHandle value) = 0;
    virtual bool isObject(JSValueHandle value) = 0;
    virtual bool isArray(JSValueHandle value) = 0;
    virtual bool isFunction(JSValueHandle value) = 0;

    /**
     * Return true only for a side-effect-free binding destination owned by this engine.
     * Implementations accept ordinary objects created by newObject(), and reject global objects,
     * proxies, other exotic objects, foreign-engine handles, and mutated prototype chains.
     */
    virtual bool isBindingDestination(JSValueHandle value) = 0;

    /**
     * Compare two values using ECMAScript SameValue (Object.is) semantics.
     *
     * Native DOM shims use this for browser-style callback identity, where two
     * handles for the same JavaScript function must compare equal. Unlike strict
     * equality, NaN equals NaN and negative zero differs from positive zero.
     */
    virtual bool isSameValue(JSValueHandle left, JSValueHandle right) = 0;

    // ========================================================================
    // Object Operations
    // ========================================================================

    virtual bool setProperty(JSValueHandle obj, const char* name, JSValueHandle value) = 0;
    virtual JSValueHandle getProperty(JSValueHandle obj, const char* name) = 0;
    /**
     * Inspect the first descriptor in the object/prototype chain without invoking accessors.
     * Proxy descriptor and getPrototypeOf traps are observable and exceptions are latched.
     */
    virtual bool getPropertyInfo(JSValueHandle obj, const char* name, JSPropertyInfo& info) = 0;
    /** Release the owned data snapshot populated by getPropertyInfo(). */
    virtual void releasePropertyInfo(JSPropertyInfo& info) = 0;
    /** Check whether a property is present on an object or its prototype chain. */
    virtual bool hasProperty(JSValueHandle obj, const char* name) = 0;
    /** Delete a property, returning false for a non-configurable property or exception. */
    virtual bool deleteProperty(JSValueHandle obj, const char* name) = 0;
    virtual bool setPropertyIndex(JSValueHandle arr, uint32_t index, JSValueHandle value) = 0;
    virtual JSValueHandle getPropertyIndex(JSValueHandle arr, uint32_t index) = 0;

    /**
     * Call a function
     * @param func The function to call
     * @param thisArg The 'this' value (can be undefined)
     * @param args Arguments to pass
     * @return The return value
     */
    virtual JSValueHandle call(JSValueHandle func, JSValueHandle thisArg, const std::vector<JSValueHandle>& args) = 0;

    // ========================================================================
    // Memory Management
    // ========================================================================

    /**
     * Keep a value alive beyond the current frame.
     */
    virtual void freezeHandle(JSValueHandle value) = 0;

    /** Return an owned handle that remains valid after the current native callback returns. */
    virtual JSValueHandle retainHandle(JSValueHandle value) {
        freezeHandle(value);
        return value;
    }

    /**
     * Release one handle owned by this Engine.
     */
    virtual void freeHandle(JSValueHandle value) = 0;

    /** Return the number of live handles owned by this Engine. */
    virtual size_t outstandingHandleCount() const = 0;

    // Compatibility names for embedders that still use the old vocabulary. New code should use
    // freezeHandle/freeHandle so ownership is explicit at the call site.
    virtual void protect(JSValueHandle value) { freezeHandle(value); }
    virtual void unprotect(JSValueHandle value) { freeHandle(value); }

    /**
     * Run garbage collection (if supported)
     */
    virtual void gc() = 0;

    /**
     * Run pending Promise jobs for engines whose embedders must explicitly
     * checkpoint the microtask queue.
     */
    virtual void processMicrotasks() {}

    /** True when the engine owns a foreground task queue that can block without polling. */
    virtual bool supportsBlockingTaskWait() const { return false; }

    /** Run one foreground task, blocking until engine work or an embedder wake arrives. */
    virtual void waitForTask() {}

    /** Wake waitForTask() from another thread. Implementations must be thread-safe. */
    virtual void wakeTaskWait() {}

    /**
     * Signal the start of a new animation frame.
     * Enables per-frame allocation tracking (e.g., NativeFunction objects).
     * Must be called before executeAnimationFrameCallbacks().
     */
    virtual void beginFrame() {}

    /**
     * Clear non-protected handles created during the current frame.
     * Called at the end of each animation frame to free intermediate
     * Persistent handles and per-frame native allocations.
     * Default implementation is a no-op for engines that don't need it.
     */
    virtual void clearFrameHandles() {}

    /**
     * Temporarily suspend frame allocation tracking.
     * Functions created while suspended won't be deleted at frame end.
     * Use for creating cached wrapper objects that should persist across frames.
     * Call resumeFrameTracking() to re-enable tracking.
     */
    virtual void suspendFrameTracking() {}

    /**
     * Resume frame allocation tracking after a suspend.
     */
    virtual void resumeFrameTracking() {}

    /**
     * Register a release callback on a JS object wrapper.
     * When the JS object is garbage collected (no more JS references),
     * the callback fires to release the associated native resource.
     * Used for Dawn/WebGPU resource cleanup (texture views, bind groups, etc.).
     */
    virtual void registerRelease(JSValueHandle obj, std::function<void()> callback) {}

    // ========================================================================
    // Error Handling
    // ========================================================================

    /**
     * Check if the last operation threw an exception
     */
    virtual bool hasException() = 0;

    /**
     * Get and clear the current exception
     */
    virtual std::string getException() = 0;

    /**
     * Throw a JavaScript exception
     */
    virtual void throwException(const char* message) = 0;

    /**
     * Throw a JavaScript TypeError. WebGPU argument validation throws this on the web, so a binding that
     * refuses an argument by name uses it. An engine without a native TypeError (JSC here) falls back
     * to a thrown message that starts with "TypeError: ".
     */
    virtual void throwTypeError(const char* message) {
        throwException((std::string("TypeError: ") + message).c_str());
    }

    // ========================================================================
    // Private Data
    // ========================================================================

    /**
     * Set private C++ data on a JS object
     * Used to associate native objects with JS objects
     */
    virtual void setPrivateData(JSValueHandle obj, void* data) = 0;

    /**
     * Get private C++ data from a JS object
     */
    virtual void* getPrivateData(JSValueHandle obj) = 0;

    // ========================================================================
    // Raw Context Access
    // ========================================================================

    /**
     * Get the raw engine-specific context
     * - QuickJS: JSContext*
     * - V8: v8::Isolate*
     * - JSC: JSGlobalContextRef
     */
    virtual void* getRawContext() = 0;
};

/**
 * Move-only owner for one Engine handle.
 *
 * A guard releases its value at scope exit. Use release() only when ownership is intentionally
 * transferred to another owner or to a JavaScript API that takes the handle lifetime over.
 */
class JSValueGuard {
public:
    JSValueGuard(Engine& engine, JSValueHandle value) noexcept
        : engine_(&engine), value_(value) {}

    ~JSValueGuard() { reset(); }

    JSValueGuard(const JSValueGuard&) = delete;
    JSValueGuard& operator=(const JSValueGuard&) = delete;

    JSValueGuard(JSValueGuard&& other) noexcept
        : engine_(other.engine_), value_(other.value_) {
        other.engine_ = nullptr;
        other.value_ = {};
    }

    JSValueGuard& operator=(JSValueGuard&& other) noexcept {
        if (this == &other) return *this;
        reset();
        engine_ = other.engine_;
        value_ = other.value_;
        other.engine_ = nullptr;
        other.value_ = {};
        return *this;
    }

    JSValueHandle get() const noexcept { return value_; }
    operator bool() const noexcept { return value_.ptr != nullptr; }

    JSValueHandle release() noexcept {
        const JSValueHandle released = value_;
        engine_ = nullptr;
        value_ = {};
        return released;
    }

    void reset(JSValueHandle value = {}) noexcept {
        if (value_.ptr == value.ptr) return;
        if (engine_ && value_.ptr) engine_->freeHandle(value_);
        value_ = value;
    }

private:
    Engine* engine_ = nullptr;
    JSValueHandle value_;
};

/**
 * Create the default engine for the platform
 * - macOS/iOS: JavaScriptCore
 * - Other with MYSTRAL_USE_V8: V8
 * - Fallback: QuickJS
 */
std::unique_ptr<Engine> createEngine();

/**
 * Create a specific engine type
 * Returns nullptr if that engine is not compiled in
 */
std::unique_ptr<Engine> createEngine(EngineType type);

}  // namespace js
}  // namespace mystral
