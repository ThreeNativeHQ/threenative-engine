/**
 * QuickJS JavaScript Engine Implementation
 *
 * QuickJS is a tiny (~600KB) JavaScript engine with no JIT,
 * making it ideal for consoles, embedded systems, and fallback on all platforms.
 */

#include "mystral/js/engine.h"
#include "mystral/cold_start.h"
#include "mystral/js/module_system.h"
#include <iostream>
#include <unordered_map>
#include <unordered_set>
#include <chrono>
#include <cstring>
#include <sstream>
#include <algorithm>
#include <utility>

#ifdef __ANDROID__
#include <android/log.h>
#include <pthread.h>
#define ANDROID_LOG_TAG "MystralJS"
#define LOGD(...) __android_log_print(ANDROID_LOG_DEBUG, ANDROID_LOG_TAG, __VA_ARGS__)
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, ANDROID_LOG_TAG, __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN, ANDROID_LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, ANDROID_LOG_TAG, __VA_ARGS__)
#else
#define LOGD(...) do { } while(0)
#define LOGI(...) do { } while(0)
#define LOGW(...) do { } while(0)
#define LOGE(...) do { } while(0)
#endif

#if defined(MYSTRAL_JS_QUICKJS)
#include "quickjs.h"

namespace mystral {
namespace js {

struct QuickJSNativeCallbackData {
    NativeFunction* function = nullptr;
    // Set instead of function for receiver-aware methods (Engine::newMethod).
    NativeMethod* method = nullptr;
};

static void quickjsNativeCallbackFinalizer(JSRuntime*, JSValueConst value) {
    JSClassID classId = JS_GetClassID(value);
    auto* data = static_cast<QuickJSNativeCallbackData*>(JS_GetOpaque(value, classId));
    if (!data) return;
    delete data->function;
    delete data->method;
    delete data;
}

static JSValue duplicateProtectedNativeCallbackResult(JSContext* ctx, JSValueHandle result) {
    if (result.ptr) {
        auto* val = static_cast<JSValue*>(result.ptr);
        return JS_DupValue(ctx, *val);
    }
    return JS_UNDEFINED;
}

static char* quickjsModuleNormalize(JSContext* ctx,
                                    const char* module_base_name,
                                    const char* module_name,
                                    void* opaque) {
    (void)opaque;
    auto* moduleSystem = getModuleSystem();
    if (!moduleSystem) {
        return js_strdup(ctx, module_name);
    }

    ResolvedModule resolved;
    std::string error;
    std::string referrer = module_base_name ? module_base_name : "";
    if (!moduleSystem->resolveForImport(module_name, referrer, resolved, error)) {
        JS_ThrowReferenceError(ctx, "%s", error.c_str());
        return nullptr;
    }
    return js_strdup(ctx, resolved.resolved.path.c_str());
}

static JSModuleDef* quickjsModuleLoader(JSContext* ctx,
                                        const char* module_name,
                                        void* opaque) {
    (void)opaque;
    auto* moduleSystem = getModuleSystem();
    if (!moduleSystem) {
        JS_ThrowReferenceError(ctx, "Module system not initialized");
        return nullptr;
    }

    ResolvedModule resolved;
    std::string error;
    if (!moduleSystem->resolver().resolveResolvedPath(module_name, resolved, error)) {
        JS_ThrowReferenceError(ctx, "%s", error.c_str());
        return nullptr;
    }

    std::string source;
    std::string filename;
    if (!moduleSystem->getEsmSource(resolved, module_name, source, filename, error)) {
        JS_ThrowReferenceError(ctx, "%s", error.c_str());
        return nullptr;
    }

    JSValue result = JS_Eval(ctx, source.c_str(), source.size(),
        filename.c_str(), JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
    if (JS_IsException(result)) {
        return nullptr;
    }

    JSModuleDef* module = (JSModuleDef*)JS_VALUE_GET_PTR(result);
    JS_FreeValue(ctx, result);
    return module;
}

class QuickJSEngine : public Engine {
public:
    QuickJSEngine() {
        std::cout << "[QuickJS] Creating engine..." << std::endl;

        runtime_ = JS_NewRuntime();
        if (!runtime_) {
            std::cerr << "[QuickJS] Failed to create runtime" << std::endl;
            return;
        }

        // Keep the effective defaults explicit and observable. A zero memory
        // limit means allocations are bounded by the host process. The native
        // stack guard is set explicitly below for each host platform.
        JS_SetMemoryLimit(runtime_, 0);
        size_t quickJsStackLimit = JS_DEFAULT_STACK_SIZE;
#ifdef __ANDROID__
        // SDL_main runs on a Java-created Android thread whose native stack is
        // commonly only 1 MiB. Reserving that entire amount for QuickJS leaves
        // no room for C++ browser/WebGPU callbacks and turns deep Three.js work
        // into an uncatchable native SIGSEGV. ThreeNative's SDL Java glue asks
        // Android for an 8 MiB stack; cap QuickJS at half the measured stack so
        // deep shader graphs and native WebGPU callbacks both have headroom.
        pthread_attr_t threadAttributes;
        void* threadStackAddress = nullptr;
        size_t threadStackSize = 0;
        if (pthread_getattr_np(pthread_self(), &threadAttributes) == 0) {
            pthread_attr_getstack(&threadAttributes, &threadStackAddress, &threadStackSize);
            pthread_attr_destroy(&threadAttributes);
        }
        if (threadStackSize > 0) {
            constexpr size_t androidQuickJsStackLimit = 4 * 1024 * 1024;
            quickJsStackLimit = std::min(androidQuickJsStackLimit, threadStackSize / 2);
        } else {
            quickJsStackLimit = JS_DEFAULT_STACK_SIZE;
        }
        LOGI("Host thread stack: address=%p size=%zu bytes", threadStackAddress, threadStackSize);
#endif
        JS_SetMaxStackSize(runtime_, quickJsStackLimit);
        LOGI("Runtime limits: memory=unlimited stack=%zu bytes", quickJsStackLimit);

        context_ = JS_NewContext(runtime_);
        if (!context_) {
            std::cerr << "[QuickJS] Failed to create context" << std::endl;
            return;
        }
        JS_SetContextOpaque(context_, this);

        JS_NewClassID(runtime_, &nativeCallbackDataClassId_);
        JSClassDef nativeCallbackDataDefinition = {};
        nativeCallbackDataDefinition.class_name = "ThreeNativeCallbackData";
        nativeCallbackDataDefinition.finalizer = &quickjsNativeCallbackFinalizer;
        if (JS_NewClass(runtime_, nativeCallbackDataClassId_, &nativeCallbackDataDefinition) < 0) {
            std::cerr << "[QuickJS] Failed to register native callback data class" << std::endl;
            return;
        }

        JS_NewClassID(runtime_, &bindingDestinationClassId_);
        JSClassDef bindingDestinationDefinition = {};
        bindingDestinationDefinition.class_name = "ThreeNativeOrdinaryObject";
        if (JS_NewClass(
                runtime_, bindingDestinationClassId_,
                &bindingDestinationDefinition) < 0) {
            std::cerr << "[QuickJS] Failed to register binding destination class" << std::endl;
            return;
        }
        JSValue ordinaryObject = JS_NewObject(context_);
        bindingDestinationPrototype_ = JS_GetPrototype(context_, ordinaryObject);
        JS_FreeValue(context_, ordinaryObject);

        JS_SetModuleLoaderFunc(runtime_, quickjsModuleNormalize, quickjsModuleLoader, nullptr);

        // Set up standard globals
        setupGlobals();

        std::cout << "[QuickJS] Engine created successfully" << std::endl;
    }

    ~QuickJSEngine() override {
        std::cout << "[QuickJS] Destroying engine..." << std::endl;

        if (context_) clearLastException();

        if (context_ && runtime_) {
            // Runtime-owned native binding state is already gone at this point. Do not execute
            // queued jobs here; JS_FreeRuntime discards them with the remaining JS graph.
            // Release protected handles before the unprotected frame handles. Both sets contain
            // the heap wrappers for values returned through Engine; each wrapper owns one QuickJS
            // reference and is released exactly once here.
            for (void* ptr : protectedHandles_) {
                JSValue* val = (JSValue*)ptr;
                JS_FreeValue(context_, *val);
                delete val;
                frameHandles_.erase(ptr);
            }
            protectedHandles_.clear();

            for (void* ptr : frameHandles_) {
                JSValue* val = static_cast<JSValue*>(ptr);
                JS_FreeValue(context_, *val);
                delete val;
            }
            frameHandles_.clear();

            // Clear private data map
            privateDataMap_.clear();

            JS_FreeValue(context_, bindingDestinationPrototype_);
            bindingDestinationPrototype_ = JS_UNDEFINED;

            // Run garbage collection multiple times to clean up cycles
            JS_RunGC(runtime_);
            JS_RunGC(runtime_);
            JS_RunGC(runtime_);
        }

        if (context_) {
            JS_FreeContext(context_);
        }
        if (runtime_) {
            JS_FreeRuntime(runtime_);
        }

    }

    EngineType getType() const override { return EngineType::QuickJS; }
    const char* getName() const override { return "QuickJS"; }

    // ========================================================================
    // Script Evaluation
    // ========================================================================

    bool eval(const char* code, const char* filename) override {
        // Use JS_EVAL_TYPE_MODULE to support import.meta
        JSValue result = JS_Eval(context_, code, strlen(code), filename, JS_EVAL_TYPE_MODULE);

        if (JS_IsException(result)) {
            JSValue exception = JS_GetException(context_);
            reportException(exception);
            JS_FreeValue(context_, exception);
            JS_FreeValue(context_, result);
            return false;
        }

        JS_FreeValue(context_, result);

        // Execute any pending Promise jobs (microtasks)
        executePendingJobs();

        return true;
    }

    // Execute pending Promise jobs (microtasks)
    bool executePendingJobs() {
        JSContext* ctx;
        int ret;
        int executed = 0;
        while ((ret = JS_ExecutePendingJob(runtime_, &ctx)) > 0) {
            ++executed;
        }
        if (ret < 0) {
            // An exception occurred during job execution
            LOGE("Pending job failed after %d completed job(s)", executed);
            JSValue exception = JS_GetException(ctx);
            reportException(exception);
            JS_FreeValue(ctx, exception);
            return false;
        }
        return true;
    }

    // The runtime pumps microtasks once a frame (`runtime.cpp`), and this engine did not
    // implement that pump — the base class default is an empty body, so on QuickJS the per-frame
    // checkpoint did nothing. Promise jobs still ran, but only as a side effect of `evalScript`,
    // `evalScriptWithResult` and `call`, so anything resolved from a native callback outside a JS
    // call waited for the next one. A settled Promise handed back from a binding — which is what
    // `decodeAudioData` now returns — is exactly that shape.
    //
    // QuickJS is the documented Android rollback, so this was a silent one-engine difference.
    void processMicrotasks() override { executePendingJobs(); }

    JSValueHandle evalWithResult(const char* code, const char* filename) override {
        // Use JS_EVAL_TYPE_MODULE to support import.meta
        JSValue result = JS_Eval(context_, code, strlen(code), filename, JS_EVAL_TYPE_MODULE);

        if (JS_IsException(result)) {
            JSValue exception = JS_GetException(context_);
            reportException(exception);
            replaceLastException(exception);
            JS_FreeValue(context_, result);
            return {nullptr, context_};
        }

        // Store the result (caller must free)
        return storeHandle(result);
    }

    bool evalScript(const char* code, const char* filename) override {
        const size_t codeLength = strlen(code);
        LOGI("evalScript compile begin: file=%s bytes=%zu", filename, codeLength);
        mystral::coldStartMark("compile_begin");
        JSValue compiled = JS_Eval(context_, code, codeLength, filename,
                                   JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_COMPILE_ONLY);

        if (JS_IsException(compiled)) {
            LOGE("evalScript compile failed: file=%s", filename);
            JSValue exception = JS_GetException(context_);
            reportException(exception);
            JS_FreeValue(context_, exception);
            JS_FreeValue(context_, compiled);
            return false;
        }

        JSMemoryUsage usage{};
        JS_ComputeMemoryUsage(runtime_, &usage);
        mystral::coldStartMark("compile_complete");
        LOGI("evalScript compile complete: memory_used=%lld malloc_size=%lld",
             static_cast<long long>(usage.memory_used_size),
             static_cast<long long>(usage.malloc_size));

        mystral::coldStartMark("execute_begin");
        LOGI("evalScript execute begin: file=%s", filename);
        // JS_EvalFunction consumes the compiled function value.
        JSValue result = JS_EvalFunction(context_, compiled);
        if (JS_IsException(result)) {
            LOGE("evalScript execute failed: file=%s", filename);
            JSValue exception = JS_GetException(context_);
            reportException(exception);
            JS_FreeValue(context_, exception);
            JS_FreeValue(context_, result);
            return false;
        }
        JS_FreeValue(context_, result);
        LOGI("evalScript execute complete: file=%s", filename);
        mystral::coldStartMark("execute_complete");

        LOGI("evalScript pending jobs begin: file=%s", filename);
        const bool jobsSucceeded = executePendingJobs();
        LOGI("evalScript pending jobs complete: file=%s success=%s",
             filename, jobsSucceeded ? "true" : "false");
        return jobsSucceeded;
    }

    JSValueHandle evalScriptWithResult(const char* code, const char* filename) override {
        JSValue result = JS_Eval(context_, code, strlen(code), filename, JS_EVAL_TYPE_GLOBAL);

        if (JS_IsException(result)) {
            JSValue exception = JS_GetException(context_);
            reportException(exception);
            replaceLastException(exception);
            JS_FreeValue(context_, result);
            return {nullptr, context_};
        }

        executePendingJobs();
        return storeHandle(result);
    }

    // ========================================================================
    // Global Object Access
    // ========================================================================

    JSValueHandle getGlobal() override {
        JSValue global = JS_GetGlobalObject(context_);
        return storeHandle(global);
    }

    bool setGlobalProperty(const char* name, JSValueHandle value) override {
        JSValue global = JS_GetGlobalObject(context_);
        JSValue* val = (JSValue*)value.ptr;
        JS_SetPropertyStr(context_, global, name, JS_DupValue(context_, *val));
        JS_FreeValue(context_, global);
        return true;
    }

    JSValueHandle getGlobalProperty(const char* name) override {
        JSValue global = JS_GetGlobalObject(context_);
        JSValue result = JS_GetPropertyStr(context_, global, name);
        JS_FreeValue(context_, global);
        return storeHandle(result);
    }

    // ========================================================================
    // Value Creation
    // ========================================================================

    JSValueHandle newUndefined() override {
        return storeHandle(JS_UNDEFINED);
    }

    JSValueHandle newNull() override {
        return storeHandle(JS_NULL);
    }

    JSValueHandle newBoolean(bool value) override {
        return storeHandle(JS_NewBool(context_, value));
    }

    JSValueHandle newNumber(double value) override {
        return storeHandle(JS_NewFloat64(context_, value));
    }

    JSValueHandle newString(const char* value) override {
        return storeHandle(JS_NewString(context_, value));
    }

    JSValueHandle newObject() override {
        JSValue object = JS_NewObjectProtoClass(
            context_, bindingDestinationPrototype_, bindingDestinationClassId_);
        return storeHandle(object);
    }

    JSValueHandle newArray(size_t length) override {
        (void)length;
        return storeHandle(JS_NewArray(context_));
    }

    JSValueHandle newArrayBuffer(const uint8_t* data, size_t length) override {
        return storeHandle(JS_NewArrayBufferCopy(context_, data, length));
    }

    JSValueHandle newArrayBufferExternal(void* data, size_t length) override {
        // Create an ArrayBuffer that directly references external memory (no copy)
        // Pass nullptr for free_func since we don't own this memory (GPU manages it)
        return storeHandle(JS_NewArrayBuffer(context_, (uint8_t*)data, length, nullptr, nullptr, false));
    }

    void* getArrayBufferData(JSValueHandle value, size_t* size) override {
        JSValue* val = (JSValue*)value.ptr;
        if (!val) return nullptr;

        size_t len = 0;
        uint8_t* data = JS_GetArrayBuffer(context_, &len, *val);

        if (!data) {
            // Try getting from TypedArray
            // Note: JS_GetTypedArrayBuffer returns byte_offset and byte_length, NOT element count!
            size_t byteOffset = 0;
            size_t byteLength = 0;
            size_t bytesPerElement = 0;
            JSValue buffer = JS_GetTypedArrayBuffer(context_, *val, &byteOffset, &byteLength, &bytesPerElement);
            if (!JS_IsException(buffer)) {
                size_t bufferLen = 0;
                data = JS_GetArrayBuffer(context_, &bufferLen, buffer);
                JS_FreeValue(context_, buffer);
                if (data) {
                    data += byteOffset;
                    len = byteLength;  // byteLength is already the byte count, don't multiply!
                }
            }
        }

        if (size) *size = len;
        return data;
    }

    JSValueHandle createFloat32Array(const float* data, size_t count) override {
        // Create ArrayBuffer with the data
        size_t byteLength = count * sizeof(float);
        JSValue buffer = JS_NewArrayBufferCopy(context_, (const uint8_t*)data, byteLength);

        // Create Float32Array from the buffer using JS_NewTypedArray
        // Signature: JS_NewTypedArray(ctx, count, buffer, byte_offset, buffer_provided)
        // We need to get the Float32Array constructor and call it manually
        JSValue global = JS_GetGlobalObject(context_);
        JSValue float32ArrayCtor = JS_GetPropertyStr(context_, global, "Float32Array");
        JS_FreeValue(context_, global);

        JSValue args[1] = { buffer };
        JSValue typedArray = JS_CallConstructor(context_, float32ArrayCtor, 1, args);

        JS_FreeValue(context_, float32ArrayCtor);
        JS_FreeValue(context_, buffer);

        return storeHandle(typedArray);
    }

    JSValueHandle createFloat32ArrayView(float* data, size_t count) override {
        // Create ArrayBuffer backed by external memory (no copy)
        // Pass NULL for free_func since the caller (AudioBuffer) manages lifetime
        size_t byteLength = count * sizeof(float);
        JSValue buffer = JS_NewArrayBuffer(context_, (uint8_t*)data, byteLength, nullptr, nullptr, 0);

        JSValue global = JS_GetGlobalObject(context_);
        JSValue float32ArrayCtor = JS_GetPropertyStr(context_, global, "Float32Array");
        JS_FreeValue(context_, global);

        JSValue args[1] = { buffer };
        JSValue typedArray = JS_CallConstructor(context_, float32ArrayCtor, 1, args);

        JS_FreeValue(context_, float32ArrayCtor);
        JS_FreeValue(context_, buffer);

        return storeHandle(typedArray);
    }

    JSValueHandle createUint32Array(const uint32_t* data, size_t count) override {
        size_t byteLength = count * sizeof(uint32_t);
        JSValue buffer = JS_NewArrayBufferCopy(context_, (const uint8_t*)data, byteLength);

        JSValue global = JS_GetGlobalObject(context_);
        JSValue uint32ArrayCtor = JS_GetPropertyStr(context_, global, "Uint32Array");
        JS_FreeValue(context_, global);

        JSValue args[1] = { buffer };
        JSValue typedArray = JS_CallConstructor(context_, uint32ArrayCtor, 1, args);

        JS_FreeValue(context_, uint32ArrayCtor);
        JS_FreeValue(context_, buffer);

        return storeHandle(typedArray);
    }

    JSValueHandle createUint8Array(const uint8_t* data, size_t count) override {
        JSValue buffer = JS_NewArrayBufferCopy(context_, data, count);

        JSValue global = JS_GetGlobalObject(context_);
        JSValue uint8ArrayCtor = JS_GetPropertyStr(context_, global, "Uint8Array");
        JS_FreeValue(context_, global);

        JSValue args[1] = { buffer };
        JSValue typedArray = JS_CallConstructor(context_, uint8ArrayCtor, 1, args);

        JS_FreeValue(context_, uint8ArrayCtor);
        JS_FreeValue(context_, buffer);

        return storeHandle(typedArray);
    }

    JSValueHandle newFunction(const char* name, NativeFunction fn) override {
        auto* callbackData = new QuickJSNativeCallbackData{new NativeFunction(std::move(fn)), nullptr};
        JSValue dataObject = JS_NewObjectClass(context_, nativeCallbackDataClassId_);
        if (JS_IsException(dataObject)) {
            delete callbackData->function;
            delete callbackData;
            return {nullptr, context_};
        }
        JS_SetOpaque(dataObject, callbackData);

        JSValue func = JS_NewCFunctionData(context_, &nativeCallback, 0, 0, 1, &dataObject);
        JS_FreeValue(context_, dataObject);
        if (JS_IsException(func)) return {nullptr, context_};
        (void)name;
        return storeHandle(func);
    }

    bool supportsNativeMethods() const override { return true; }

    JSValueHandle newMethod(const char* name, NativeMethod fn) override {
        auto* callbackData = new QuickJSNativeCallbackData{nullptr, new NativeMethod(std::move(fn))};
        JSValue dataObject = JS_NewObjectClass(context_, nativeCallbackDataClassId_);
        if (JS_IsException(dataObject)) {
            delete callbackData->method;
            delete callbackData;
            return {nullptr, context_};
        }
        JS_SetOpaque(dataObject, callbackData);

        // Same JS_NewCFunctionData plumbing as newFunction: the method's func_data[0] carries
        // the callback holder, and the trampoline resolves the receiver at call time.
        JSValue func = JS_NewCFunctionData(context_, &nativeMethodCallback, 0, 0, 1, &dataObject);
        JS_FreeValue(context_, dataObject);
        if (JS_IsException(func)) return {nullptr, context_};
        (void)name;
        return storeHandle(func);
    }

    // ========================================================================
    // Value Conversion
    // ========================================================================

    bool toBoolean(JSValueHandle value) override {
        JSValue* val = (JSValue*)value.ptr;
        return JS_ToBool(context_, *val);
    }

    double toNumber(JSValueHandle value) override {
        JSValue* val = (JSValue*)value.ptr;
        double result;
        JS_ToFloat64(context_, &result, *val);
        return result;
    }

    std::string toString(JSValueHandle value) override {
        JSValue* val = (JSValue*)value.ptr;
        const char* str = JS_ToCString(context_, *val);
        if (!str) return "";
        std::string result(str);
        JS_FreeCString(context_, str);
        return result;
    }

    bool isUndefined(JSValueHandle value) override {
        JSValue* val = (JSValue*)value.ptr;
        return JS_IsUndefined(*val);
    }

    bool isNull(JSValueHandle value) override {
        JSValue* val = (JSValue*)value.ptr;
        return JS_IsNull(*val);
    }

    bool isBoolean(JSValueHandle value) override {
        JSValue* val = (JSValue*)value.ptr;
        return JS_IsBool(*val);
    }

    bool isNumber(JSValueHandle value) override {
        JSValue* val = (JSValue*)value.ptr;
        return JS_IsNumber(*val);
    }

    bool isString(JSValueHandle value) override {
        JSValue* val = (JSValue*)value.ptr;
        return JS_IsString(*val);
    }

    bool isObject(JSValueHandle value) override {
        JSValue* val = (JSValue*)value.ptr;
        return JS_IsObject(*val);
    }

    bool isArray(JSValueHandle value) override {
        JSValue* val = (JSValue*)value.ptr;
        return JS_IsArray(*val);  // quickjs-ng: only takes value, not context
    }

    bool isFunction(JSValueHandle value) override {
        JSValue* val = (JSValue*)value.ptr;
        return JS_IsFunction(context_, *val);
    }

    bool isBindingDestination(JSValueHandle value) override {
        if (!value.ptr || value.ctx != context_) return false;
        JSValue object = *static_cast<JSValue*>(value.ptr);
        if (!JS_IsObject(object) || JS_IsProxy(object)) return false;
        if (JS_GetClassID(object) != bindingDestinationClassId_) return false;

        JSValue prototype = JS_GetPrototype(context_, object);
        const bool hasExpectedPrototype = !JS_IsException(prototype) &&
            JS_IsSameValue(context_, prototype, bindingDestinationPrototype_);
        JS_FreeValue(context_, prototype);
        return hasExpectedPrototype;
    }

    bool isSameValue(JSValueHandle left, JSValueHandle right) override {
        if (!left.ptr || !right.ptr) return left.ptr == right.ptr;
        return JS_IsSameValue(context_, *(JSValue*)left.ptr, *(JSValue*)right.ptr);
    }

    // ========================================================================
    // Object Operations
    // ========================================================================

    bool setProperty(JSValueHandle obj, const char* name, JSValueHandle value) override {
        JSValue* objVal = (JSValue*)obj.ptr;
        JSValue* val = (JSValue*)value.ptr;
        const int result = JS_DefinePropertyValueStr(
            context_, *objVal, name, JS_DupValue(context_, *val),
            JS_PROP_C_W_E | JS_PROP_THROW);
        if (result < 0) return capturePendingException();
        return true;
    }

    JSValueHandle getProperty(JSValueHandle obj, const char* name) override {
        JSValue* objVal = (JSValue*)obj.ptr;
        JSValue result = JS_GetPropertyStr(context_, *objVal, name);
        if (JS_IsException(result)) {
            capturePendingException();
            return newUndefined();
        }
        return storeHandle(result);
    }

    bool getPropertyInfo(JSValueHandle obj, const char* name, JSPropertyInfo& info) override {
        JSValue* objVal = (JSValue*)obj.ptr;
        JSAtom atom = JS_NewAtom(context_, name);
        if (atom == JS_ATOM_NULL) return capturePendingException();

        JSValue current = JS_DupValue(context_, *objVal);
        bool own = true;
        std::vector<JSValue> visited;
        const auto releaseVisited = [&]() {
            for (const auto& value : visited) JS_FreeValue(context_, value);
            visited.clear();
        };
        while (JS_IsObject(current)) {
            for (const auto& seen : visited) {
                if (JS_IsSameValue(context_, current, seen)) {
                    JS_FreeValue(context_, current);
                    JS_FreeAtom(context_, atom);
                    releaseVisited();
                    throwException(
                        "JavaScript property prototype traversal detected a cycle");
                    return false;
                }
            }
            visited.push_back(JS_DupValue(context_, current));

            JSPropertyDescriptor descriptor = {
                0, JS_UNDEFINED, JS_UNDEFINED, JS_UNDEFINED};
            const int result = JS_GetOwnProperty(context_, &descriptor, current, atom);
            if (result < 0) {
                JS_FreeValue(context_, current);
                JS_FreeAtom(context_, atom);
                releaseVisited();
                return capturePendingException();
            }
            if (result > 0) {
                info.own = own;
                info.enumerable = (descriptor.flags & JS_PROP_ENUMERABLE) != 0;
                info.configurable = (descriptor.flags & JS_PROP_CONFIGURABLE) != 0;
                const bool accessor = (descriptor.flags & JS_PROP_TMASK) == JS_PROP_GETSET;
                if (accessor) {
                    info.kind = JSPropertyKind::Accessor;
                    info.writable = false;
                    info.value = {};
                } else {
                    auto* stored = new JSValue(JS_DupValue(context_, descriptor.value));
                    info.kind = JSPropertyKind::Data;
                    info.writable = (descriptor.flags & JS_PROP_WRITABLE) != 0;
                    info.value = {stored, context_};
                }
                JS_FreeValue(context_, descriptor.value);
                JS_FreeValue(context_, descriptor.getter);
                JS_FreeValue(context_, descriptor.setter);
                JS_FreeValue(context_, current);
                JS_FreeAtom(context_, atom);
                releaseVisited();
                return true;
            }

            JSValue prototype = JS_GetPrototype(context_, current);
            JS_FreeValue(context_, current);
            if (JS_IsException(prototype)) {
                JS_FreeAtom(context_, atom);
                releaseVisited();
                return capturePendingException();
            }
            current = prototype;
            own = false;
        }

        JS_FreeValue(context_, current);
        JS_FreeAtom(context_, atom);
        releaseVisited();
        info = {};
        return true;
    }

    void releasePropertyInfo(JSPropertyInfo& info) override {
        if (info.kind == JSPropertyKind::Data && info.value.ptr) {
            auto* value = static_cast<JSValue*>(info.value.ptr);
            JS_FreeValue(context_, *value);
            delete value;
        }
        info = {};
    }

    bool hasProperty(JSValueHandle obj, const char* name) override {
        JSValue* objVal = (JSValue*)obj.ptr;
        JSAtom atom = JS_NewAtom(context_, name);
        if (atom == JS_ATOM_NULL) return capturePendingException();
        const int result = JS_HasProperty(context_, *objVal, atom);
        JS_FreeAtom(context_, atom);
        if (result < 0) return capturePendingException();
        return result > 0;
    }

    bool deleteProperty(JSValueHandle obj, const char* name) override {
        JSValue* objVal = (JSValue*)obj.ptr;
        JSAtom atom = JS_NewAtom(context_, name);
        if (atom == JS_ATOM_NULL) return capturePendingException();
        const int result = JS_DeleteProperty(context_, *objVal, atom, 0);
        JS_FreeAtom(context_, atom);
        if (result < 0) return capturePendingException();
        return result > 0;
    }

    bool setPropertyIndex(JSValueHandle arr, uint32_t index, JSValueHandle value) override {
        JSValue* arrVal = (JSValue*)arr.ptr;
        JSValue* val = (JSValue*)value.ptr;
        return JS_SetPropertyUint32(context_, *arrVal, index, JS_DupValue(context_, *val)) >= 0;
    }

    JSValueHandle getPropertyIndex(JSValueHandle arr, uint32_t index) override {
        JSValue* arrVal = (JSValue*)arr.ptr;
        JSValue result = JS_GetPropertyUint32(context_, *arrVal, index);
        return storeHandle(result);
    }

    JSValueHandle call(JSValueHandle func, JSValueHandle thisArg, const std::vector<JSValueHandle>& args) override {
        JSValue* funcVal = (JSValue*)func.ptr;
        JSValue* thisVal = thisArg.ptr ? (JSValue*)thisArg.ptr : nullptr;

        std::vector<JSValue> jsArgs;
        jsArgs.reserve(args.size());
        for (const auto& arg : args) {
            jsArgs.push_back(*(JSValue*)arg.ptr);
        }

        JSValue result = JS_Call(context_, *funcVal,
            thisVal ? *thisVal : JS_UNDEFINED,
            (int)jsArgs.size(), jsArgs.data());

        if (JS_IsException(result)) {
            JSValue exception = JS_GetException(context_);
            reportException(exception);
            replaceLastException(exception);
            return {nullptr, context_};
        }

        // Execute any pending Promise jobs (microtasks)
        executePendingJobs();

        return storeHandle(result);
    }

    // ========================================================================
    // Memory Management
    // ========================================================================

    void freezeHandle(JSValueHandle value) override {
        if (!value.ptr) return;
        protectedHandles_.insert(value.ptr);
        frameHandles_.insert(value.ptr);
    }

    void freeHandle(JSValueHandle value) override {
        if (!value.ptr) return;
        const auto frameIt = frameHandles_.find(value.ptr);
        if (frameIt == frameHandles_.end()) return;
        auto* val = static_cast<JSValue*>(value.ptr);
        protectedHandles_.erase(value.ptr);
        frameHandles_.erase(value.ptr);
        JS_FreeValue(context_, *val);
        delete val;
    }

    void protect(JSValueHandle value) override { freezeHandle(value); }
    void unprotect(JSValueHandle value) override { freeHandle(value); }

    size_t outstandingHandleCount() const override { return frameHandles_.size(); }

    void beginFrame() override {}

    void clearFrameHandles() override {
        for (auto it = frameHandles_.begin(); it != frameHandles_.end();) {
            void* ptr = *it;
            if (protectedHandles_.find(ptr) != protectedHandles_.end()) {
                ++it;
                continue;
            }
            auto* value = static_cast<JSValue*>(ptr);
            JS_FreeValue(context_, *value);
            delete value;
            it = frameHandles_.erase(it);
        }
    }

    // QuickJS tracks every Engine-returned handle, including values created while a native
    // wrapper is being installed. The JS object may retain the value; releasing this C++ handle
    // at the frame boundary then leaves the JavaScript property as the sole owner, matching V8.
    void suspendFrameTracking() override {}
    void resumeFrameTracking() override {}

    void gc() override {
        JS_RunGC(runtime_);
    }

    // ========================================================================
    // Error Handling
    // ========================================================================

    bool hasException() override {
        return !JS_IsNull(lastException_) && !JS_IsUndefined(lastException_);
    }

    std::string getException() override {
        if (JS_IsNull(lastException_) || JS_IsUndefined(lastException_)) {
            return "";
        }

        const char* str = JS_ToCString(context_, lastException_);
        std::string result = str ? str : "";
        if (str) JS_FreeCString(context_, str);

        clearLastException();
        exceptionFromNativeCallback_ = false;
        return result;
    }

    void throwTypeError(const char* message) override {
        JS_ThrowTypeError(context_, "%s", message);
        replaceLastException(JS_GetException(context_));
        if (nativeCallbackDepth_ > 0) exceptionFromNativeCallback_ = true;
    }

    void throwException(const char* message) override {
        JS_ThrowInternalError(context_, "%s", message);
        replaceLastException(JS_GetException(context_));
        if (nativeCallbackDepth_ > 0) exceptionFromNativeCallback_ = true;
    }

    // ========================================================================
    // Private Data
    // ========================================================================

    void setPrivateData(JSValueHandle obj, void* data) override {
        JSValue* val = (JSValue*)obj.ptr;
        // Use JS_VALUE_GET_PTR to get the actual object pointer as a unique key
        void* objPtr = JS_VALUE_GET_PTR(*val);
        privateDataMap_[objPtr] = data;
    }

    void* getPrivateData(JSValueHandle obj) override {
        JSValue* val = (JSValue*)obj.ptr;
        void* objPtr = JS_VALUE_GET_PTR(*val);
        auto it = privateDataMap_.find(objPtr);
        return it != privateDataMap_.end() ? it->second : nullptr;
    }

    bool setPrototypeOf(JSValueHandle object, JSValueHandle prototype) override {
        // 1 sets the prototype, 0 refuses an exotic target, -1 latches a pending exception.
        return JS_SetPrototype(
                   context_,
                   *static_cast<JSValue*>(object.ptr),
                   *static_cast<JSValue*>(prototype.ptr)) == 1;
    }

    // ========================================================================
    // Raw Context Access
    // ========================================================================

    void* getRawContext() override {
        return context_;
    }

private:
    JSValueHandle storeHandle(JSValue value) {
        auto* stored = new JSValue(value);
        frameHandles_.insert(stored);
        return {stored, context_};
    }

    void clearLastException() {
        if (!JS_IsNull(lastException_) && !JS_IsUndefined(lastException_)) {
            JS_FreeValue(context_, lastException_);
        }
        lastException_ = JS_UNDEFINED;
    }

    void replaceLastException(JSValue exception) {
        clearLastException();
        lastException_ = exception;
    }

    JSValue takeNativeCallbackException() {
        JSValue exception = lastException_;
        lastException_ = JS_UNDEFINED;
        exceptionFromNativeCallback_ = false;
        return exception;
    }

    void setupGlobals() {
        JSValue global = JS_GetGlobalObject(context_);

        // console object
        JSValue console = JS_NewObject(context_);
        JS_SetPropertyStr(context_, console, "log",
            JS_NewCFunction(context_, js_console_log, "log", 1));
        JS_SetPropertyStr(context_, console, "warn",
            JS_NewCFunction(context_, js_console_warn, "warn", 1));
        JS_SetPropertyStr(context_, console, "error",
            JS_NewCFunction(context_, js_console_error, "error", 1));
        JS_SetPropertyStr(context_, console, "info",
            JS_NewCFunction(context_, js_console_log, "info", 1));
        JS_SetPropertyStr(context_, console, "debug",
            JS_NewCFunction(context_, js_console_log, "debug", 1));
        JS_SetPropertyStr(context_, global, "console", console);

        // performance.now()
        startTime_ = std::chrono::high_resolution_clock::now();
        JSValue performance = JS_NewObject(context_);

        JS_SetPropertyStr(context_, performance, "now",
            JS_NewCFunction(context_, js_performance_now, "now", 0));
        JS_SetPropertyStr(context_, global, "performance", performance);

        JS_FreeValue(context_, global);
    }

    void reportException(JSValue exception) {
        const char* str = JS_ToCString(context_, exception);
        std::cerr << "[QuickJS] Error: " << (str ? str : "unknown") << std::endl;
        if (str) JS_FreeCString(context_, str);

        // Also try to get stack trace
        JSValue stack = JS_GetPropertyStr(context_, exception, "stack");
        if (!JS_IsUndefined(stack)) {
            const char* stackStr = JS_ToCString(context_, stack);
            if (stackStr) {
                std::cerr << "[QuickJS] Stack:\n" << stackStr << std::endl;
                JS_FreeCString(context_, stackStr);
            }
            JS_FreeValue(context_, stack);
        }
    }

    bool capturePendingException() {
        JSValue exception = JS_GetException(context_);
        reportException(exception);
        replaceLastException(exception);
        return false;
    }

    static JSValue nativeCallback(JSContext* ctx, JSValueConst this_val,
                                  int argc, JSValueConst* argv, int magic, JSValue* func_data) {
        (void)this_val;
        (void)magic;
        auto* engine = static_cast<QuickJSEngine*>(JS_GetContextOpaque(ctx));
        // A native callback may have thrown an exception that JavaScript caught. Keep the
        // host-side exception latch aligned with the next callback boundary.
        if (engine && engine->nativeCallbackDepth_ == 0 &&
            engine->exceptionFromNativeCallback_ && engine->hasException()) {
            engine->getException();
        }
        auto* callbackData = engine
            ? static_cast<QuickJSNativeCallbackData*>(
                JS_GetOpaque(func_data[0], engine->nativeCallbackDataClassId_))
            : nullptr;
        if (!callbackData || !callbackData->function) return JS_UNDEFINED;
        NativeFunction* fn = callbackData->function;

        if (engine) engine->nativeCallbackDepth_ += 1;

        // Convert arguments
        std::vector<JSValueHandle> args;
        args.reserve(argc);
        for (int i = 0; i < argc; i++) {
            JSValue* stored = new JSValue(JS_DupValue(ctx, argv[i]));
            args.push_back({stored, ctx});
        }

        // Call the native function
        JSValueHandle result = (*fn)(ctx, args);

        JSValue* returnedHandle = result.ptr ? static_cast<JSValue*>(result.ptr) : nullptr;
        const bool resultIsProtected = returnedHandle && engine &&
            engine->protectedHandles_.find(result.ptr) != engine->protectedHandles_.end();

        // QuickJS requires the native callback to return JS_EXCEPTION. The Engine abstraction
        // stores throwException()'s value so host-side code can inspect it; transfer that value
        // back to QuickJS here instead of returning the callback's ordinary undefined result.
        const bool callbackException = engine && engine->exceptionFromNativeCallback_ &&
            engine->hasException();
        if (callbackException) {
            if (returnedHandle && !resultIsProtected) {
                engine->frameHandles_.erase(result.ptr);
                JS_FreeValue(ctx, *returnedHandle);
                delete returnedHandle;
            }
            for (auto& arg : args) {
                if (engine->protectedHandles_.find(arg.ptr) != engine->protectedHandles_.end() ||
                    arg.ptr == result.ptr) {
                    continue;
                }
                JSValue* val = (JSValue*)arg.ptr;
                JS_FreeValue(ctx, *val);
                delete val;
            }
            engine->nativeCallbackDepth_ -= 1;
            return JS_Throw(ctx, engine->takeNativeCallbackException());
        }

        JSValue returned = JS_UNDEFINED;
        if (returnedHandle) {
            if (resultIsProtected) {
                // The native owner keeps its protected reference; the JS call receives its own.
                returned = duplicateProtectedNativeCallbackResult(ctx, result);
            } else {
                // Transfer the Engine handle's one reference directly to QuickJS. Removing it
                // from frame tracking prevents clearFrameHandles() from freeing the returned
                // value a second time.
                returned = *returnedHandle;
                if (engine) engine->frameHandles_.erase(result.ptr);
                delete returnedHandle;
            }
        }

        // Clean up argument copies. A protected argument remains owned by the native callback;
        // the returned argument handle is transferred or duplicated above.
        for (auto& arg : args) {
            if (engine && engine->protectedHandles_.find(arg.ptr) != engine->protectedHandles_.end()) {
                continue;
            }
            if (arg.ptr == result.ptr) continue;
            JSValue* val = (JSValue*)arg.ptr;
            JS_FreeValue(ctx, *val);
            delete val;
        }
        if (engine) engine->nativeCallbackDepth_ -= 1;
        return returned;
    }

    // Receiver-aware twin of nativeCallback: resolves the NativeMethod and the receiver's
    // private data and mirrors the same argument-copying, exception transfer and ownership
    // skeleton. A detached call passes receiverPrivate = nullptr; the callee reports it.
    static JSValue nativeMethodCallback(JSContext* ctx, JSValueConst this_val,
                                        int argc, JSValueConst* argv, int magic, JSValue* func_data) {
        (void)magic;
        auto* engine = static_cast<QuickJSEngine*>(JS_GetContextOpaque(ctx));
        if (engine && engine->nativeCallbackDepth_ == 0 &&
            engine->exceptionFromNativeCallback_ && engine->hasException()) {
            engine->getException();
        }
        auto* callbackData = engine
            ? static_cast<QuickJSNativeCallbackData*>(
                JS_GetOpaque(func_data[0], engine->nativeCallbackDataClassId_))
            : nullptr;
        if (!callbackData || !callbackData->method) return JS_UNDEFINED;

        void* receiverPrivate = nullptr;
        if (!JS_IsObject(this_val)) {
            // Detached call: keep going so the callee can report the missing receiver.
        } else {
            const auto it = engine->privateDataMap_.find(JS_VALUE_GET_PTR(this_val));
            if (it != engine->privateDataMap_.end()) receiverPrivate = it->second;
        }

        NativeMethod* fn = callbackData->method;

        if (engine) engine->nativeCallbackDepth_ += 1;

        std::vector<JSValueHandle> args;
        args.reserve(argc);
        for (int i = 0; i < argc; i++) {
            JSValue* stored = new JSValue(JS_DupValue(ctx, argv[i]));
            args.push_back({stored, ctx});
        }

        JSValueHandle result = (*fn)(*engine, receiverPrivate, args);

        JSValue* returnedHandle = result.ptr ? static_cast<JSValue*>(result.ptr) : nullptr;
        const bool resultIsProtected = returnedHandle && engine &&
            engine->protectedHandles_.find(result.ptr) != engine->protectedHandles_.end();

        const bool callbackException = engine && engine->exceptionFromNativeCallback_ &&
            engine->hasException();
        if (callbackException) {
            if (returnedHandle && !resultIsProtected) {
                engine->frameHandles_.erase(result.ptr);
                JS_FreeValue(ctx, *returnedHandle);
                delete returnedHandle;
            }
            for (auto& arg : args) {
                if (engine->protectedHandles_.find(arg.ptr) != engine->protectedHandles_.end() ||
                    arg.ptr == result.ptr) {
                    continue;
                }
                JSValue* val = (JSValue*)arg.ptr;
                JS_FreeValue(ctx, *val);
                delete val;
            }
            engine->nativeCallbackDepth_ -= 1;
            return JS_Throw(ctx, engine->takeNativeCallbackException());
        }

        JSValue returned = JS_UNDEFINED;
        if (returnedHandle) {
            if (resultIsProtected) {
                returned = duplicateProtectedNativeCallbackResult(ctx, result);
            } else {
                returned = *returnedHandle;
                if (engine) engine->frameHandles_.erase(result.ptr);
                delete returnedHandle;
            }
        }

        for (auto& arg : args) {
            if (engine && engine->protectedHandles_.find(arg.ptr) != engine->protectedHandles_.end()) {
                continue;
            }
            if (arg.ptr == result.ptr) continue;
            JSValue* val = (JSValue*)arg.ptr;
            JS_FreeValue(ctx, *val);
            delete val;
        }
        if (engine) engine->nativeCallbackDepth_ -= 1;
        return returned;
    }

    // Console functions - helper to build message string
    static std::string buildConsoleMessage(JSContext* ctx, int argc, JSValueConst* argv) {
        std::ostringstream oss;
        for (int i = 0; i < argc; i++) {
            const char* str = JS_ToCString(ctx, argv[i]);
            if (str) {
                oss << str;
                if (i < argc - 1) oss << " ";
                JS_FreeCString(ctx, str);
            }
        }
        return oss.str();
    }

    static JSValue js_console_log(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
        std::string msg = buildConsoleMessage(ctx, argc, argv);
        std::cout << "[log] " << msg << std::endl;
#ifdef __ANDROID__
        // __android_log_write, not LOGI/__android_log_print: the print formatter caps at
        // LOG_BUF_SIZE 1024 (1023 bytes), which truncated TN_FRAME_BUDGET windows.
        const std::string full = "[log] " + msg;
        __android_log_write(ANDROID_LOG_INFO, ANDROID_LOG_TAG, full.c_str());
#endif
        return JS_UNDEFINED;
    }

    static JSValue js_console_warn(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
        std::string msg = buildConsoleMessage(ctx, argc, argv);
        std::cout << "[warn] " << msg << std::endl;
#ifdef __ANDROID__
        const std::string full = "[warn] " + msg;
        __android_log_write(ANDROID_LOG_WARN, ANDROID_LOG_TAG, full.c_str());
#endif
        return JS_UNDEFINED;
    }

    static JSValue js_console_error(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
        std::string msg = buildConsoleMessage(ctx, argc, argv);
        std::cerr << "[error] " << msg << std::endl;
#ifdef __ANDROID__
        const std::string full = "[error] " + msg;
        __android_log_write(ANDROID_LOG_ERROR, ANDROID_LOG_TAG, full.c_str());
#endif
        return JS_UNDEFINED;
    }

    static JSValue js_performance_now(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
        auto* engine = static_cast<QuickJSEngine*>(JS_GetContextOpaque(ctx));
        if (!engine) return JS_NewFloat64(ctx, 0);
        auto now = std::chrono::high_resolution_clock::now();
        double ms = std::chrono::duration<double, std::milli>(now - engine->startTime_).count();
        return JS_NewFloat64(ctx, ms);
    }

    JSRuntime* runtime_ = nullptr;
    JSContext* context_ = nullptr;
    JSValue lastException_ = JS_UNDEFINED;
    std::chrono::high_resolution_clock::time_point startTime_;
    JSClassID nativeCallbackDataClassId_ = JS_INVALID_CLASS_ID;
    JSClassID bindingDestinationClassId_ = JS_INVALID_CLASS_ID;
    JSValue bindingDestinationPrototype_ = JS_UNDEFINED;
    std::unordered_map<void*, void*> privateDataMap_;  // Map JS object ptr to native data
    std::unordered_set<void*> frameHandles_;
    std::unordered_set<void*> protectedHandles_;
    int nativeCallbackDepth_ = 0;
    bool exceptionFromNativeCallback_ = false;

};

// Factory function
std::unique_ptr<Engine> createQuickJSEngine() {
    return std::make_unique<QuickJSEngine>();
}

}  // namespace js
}  // namespace mystral

#endif  // MYSTRAL_JS_QUICKJS
