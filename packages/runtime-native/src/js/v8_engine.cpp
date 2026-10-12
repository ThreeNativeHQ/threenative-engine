/**
 * V8 JavaScript Engine Implementation
 *
 * Uses Google's V8 engine for high-performance JavaScript execution.
 * V8 has JIT compilation, making it much faster than interpreter-only engines.
 *
 * Prebuilts from: https://github.com/kuoruan/libv8/releases
 * See docs/V8_PREBUILTS.md for fork/update information.
 */

#include "mystral/js/engine.h"
#include "mystral/cold_start.h"
#include "mystral/js/module_system.h"
#include <deque>
#include <cstdio>
#include <fstream>
#include <iostream>
#include <optional>
#if defined(__ANDROID__)
#include <android/log.h>
#endif
#include <unordered_map>
#include <unordered_set>
#include <chrono>

#if defined(MYSTRAL_JS_V8)

#include "v8.h"
#include "libplatform/libplatform.h"
#if TN_JS_PROFILE || TN_ANDROID_JS_PROFILE
#include "v8-profiler.h"
#include <algorithm>
#include <cstdlib>
#endif

namespace mystral {
namespace js {

// V8 platform (shared across all isolates)
static std::unique_ptr<v8::Platform> g_platform;
static bool g_initialized = false;

// Store native function callbacks
static std::unordered_map<void*, NativeFunction> g_nativeFunctions;

/**
 * Initialize V8 (call once at startup)
 */
namespace {
/**
 * The startup snapshot, when the platform's V8 keeps it outside the library.
 *
 * The desktop build links a monolith with the snapshot embedded, so an empty
 * `InitializeExternalStartupData("")` is all it needs. Android's prebuilt V8 ships
 * `snapshot_blob.bin` beside the library instead, and without it `Isolate::New` fails and the
 * runtime reports "Failed to create JavaScript engine" with nothing else to go on. The bytes have
 * to outlive V8, so they are held here rather than by the caller.
 */
std::string g_snapshotBytes;
v8::StartupData g_snapshot{nullptr, 0};
}  // namespace

void mystralSetV8SnapshotBlob(const char* data, size_t size) {
    if (data == nullptr || size == 0) return;
    g_snapshotBytes.assign(data, size);
    g_snapshot.data = g_snapshotBytes.data();
    g_snapshot.raw_size = static_cast<int>(g_snapshotBytes.size());
}

// Diagnostic-only V8 flag channel. PRD-222 needed --trace-deopt/--trace-ic to explain why identical
// JavaScript costs more here than in a browser, and the host set no flags at all. Off unless the
// environment asks; never read in a shipping run.
static void applyDiagnosticV8Flags() {
    if (const char* flags = std::getenv("TN_V8_FLAGS")) {
        if (flags[0] != '\0') {
            v8::V8::SetFlagsFromString(flags);
            std::cout << "[V8] diagnostic flags: " << flags << std::endl;
        }
    }
}

static bool initializeV8() {
    applyDiagnosticV8Flags();
    if (g_initialized) {
        return true;
    }

    std::cout << "[V8] Initializing V8 JavaScript engine..." << std::endl;

    // Initialize V8
    v8::V8::InitializeICUDefaultLocation("");
    if (g_snapshot.data != nullptr) {
        std::cout << "[V8] Using external startup snapshot (" << g_snapshot.raw_size << " bytes)"
                  << std::endl;
        v8::V8::SetSnapshotDataBlob(&g_snapshot);
    } else {
        v8::V8::InitializeExternalStartupData("");
    }

    g_platform = v8::platform::NewDefaultPlatform();
    v8::V8::InitializePlatform(g_platform.get());
    v8::V8::Initialize();

    g_initialized = true;
    std::cout << "[V8] V8 initialized successfully" << std::endl;
    std::cout << "[V8] Version: " << v8::V8::GetVersion() << std::endl;

    return true;
}

#if TN_JS_PROFILE || TN_ANDROID_JS_PROFILE
// V8's `CpuProfile::Serialize` writes function names and script URLs unescaped, so a real game's
// `RegExp: ^((?:[^\[\]\.:\/]+…` frame name, or a quote in a `sourceURL`, turns the file into
// JSON that DevTools refuses. The embedder writes the same DevTools shape and escapes every string.
static void writeJsonString(std::ostream& out, const char* text) {
    out << '"';
    for (const unsigned char* c = reinterpret_cast<const unsigned char*>(text); *c; ++c) {
        if (*c == '"' || *c == '\\') {
            out << '\\' << *c;
        } else if (*c < 0x20) {
            char escaped[8];
            std::snprintf(escaped, sizeof escaped, "\\u%04x", *c);
            out << escaped;
        } else {
            out << *c;
        }
    }
    out << '"';
}

static bool writeCpuProfile(v8::Isolate* isolate, const v8::CpuProfile* profile, const std::string& path) {
    std::ofstream out(path, std::ios::binary);
    if (!out) return false;
    out << "{\"nodes\":[";
    std::vector<const v8::CpuProfileNode*> stack{profile->GetTopDownRoot()};
    for (bool first = true; !stack.empty(); first = false) {
        const v8::CpuProfileNode* node = stack.back();
        stack.pop_back();
        v8::String::Utf8Value name(isolate, node->GetFunctionName());
        v8::String::Utf8Value url(isolate, node->GetScriptResourceName());
        out << (first ? "" : ",") << "{\"id\":" << node->GetNodeId() << ",\"callFrame\":{\"functionName\":";
        writeJsonString(out, *name ? *name : "");
        out << ",\"scriptId\":" << node->GetScriptId() << ",\"url\":";
        writeJsonString(out, *url ? *url : "");
        // DevTools positions are 0-based; V8's are 1-based with 0 meaning unknown, which maps to -1.
        out << ",\"lineNumber\":" << node->GetLineNumber() - 1 << ",\"columnNumber\":"
            << node->GetColumnNumber() - 1 << "},\"hitCount\":" << node->GetHitCount() << ",\"children\":[";
        for (int i = 0; i < node->GetChildrenCount(); i++) {
            out << (i ? "," : "") << node->GetChild(i)->GetNodeId();
            stack.push_back(node->GetChild(i));
        }
        out << "]}";
    }
    const int samples = profile->GetSamplesCount();
    out << "],\"startTime\":" << profile->GetStartTime() << ",\"endTime\":" << profile->GetEndTime()
        << ",\"samples\":[";
    for (int i = 0; i < samples; i++) out << (i ? "," : "") << profile->GetSample(i)->GetNodeId();
    out << "],\"timeDeltas\":[";
    int64_t previous = profile->GetStartTime();
    for (int i = 0; i < samples; i++) {
        out << (i ? "," : "") << profile->GetSampleTimestamp(i) - previous;
        previous = profile->GetSampleTimestamp(i);
    }
    out << "]}\n";
    out.flush();
    return out.good();
}
#endif

class V8EntryScope {
public:
    explicit V8EntryScope(v8::Isolate* isolate)
        : isolate_(isolate), isolateScope_(isolate), handleScope_(isolate) {}

    void enterContext(v8::Local<v8::Context> context) {
        if (isolate_->GetCurrentContext() != context) contextScope_.emplace(context);
    }

private:
    class ConditionalIsolateScope {
    public:
        explicit ConditionalIsolateScope(v8::Isolate* isolate) {
            if (v8::Isolate::GetCurrent() != isolate) scope_.emplace(isolate);
        }

    private:
        std::optional<v8::Isolate::Scope> scope_;
    };

    v8::Isolate* isolate_;
    ConditionalIsolateScope isolateScope_;
    v8::HandleScope handleScope_;
    std::optional<v8::Context::Scope> contextScope_;
};

class V8WakeTask final : public v8::Task {
public:
    void Run() override {}
};

class V8Engine : public Engine {
public:
    struct NativeFunctionRef {
        v8::Global<v8::Function> persistent;
        NativeFunction* function = nullptr;
        // Set instead of function for receiver-aware methods (Engine::newMethod). The GC
        // lifetime is identical: both pointers die with the JS function.
        NativeMethod* method = nullptr;
        V8Engine* owner = nullptr;
    };

    V8Engine() {
        std::cout << "[V8] Creating engine..." << std::endl;

        if (!g_initialized) {
            initializeV8();
        }

        // Create isolate
        v8::Isolate::CreateParams create_params;
        create_params.array_buffer_allocator =
            v8::ArrayBuffer::Allocator::NewDefaultAllocator();
        isolate_ = v8::Isolate::New(create_params);
        allocator_ = create_params.array_buffer_allocator;
        isolate_->SetData(0, this);

        // Create context
        V8EntryScope entry_scope(isolate_);

        v8::Local<v8::Context> context = v8::Context::New(isolate_);
        context_.Reset(isolate_, context);

        // Cache the private key string to avoid allocation on every getPrivateData/setPrivateData call
        v8::Local<v8::Private> privateKey = v8::Private::ForApi(isolate_,
            v8::String::NewFromUtf8(isolate_, "__mystral_private__").ToLocalChecked());
        privateKey_.Reset(isolate_, privateKey);
        bindingDestinationKey_.Reset(isolate_, v8::Private::New(isolate_));

        // Set up globals
        {
            v8::Context::Scope context_scope(context);
            v8::Local<v8::Object> ordinaryObject = v8::Object::New(isolate_);
#if V8_MAJOR_VERSION >= 12
            bindingDestinationPrototype_.Reset(
                isolate_, ordinaryObject->GetPrototypeV2());
#else
            bindingDestinationPrototype_.Reset(
                isolate_, ordinaryObject->GetPrototype());
#endif
            cacheIntrinsics(context);
            setupGlobals();
        }

#if TN_JS_PROFILE || TN_ANDROID_JS_PROFILE
        // PRD-222 / PRD-444: name the JavaScript half of the frame. `--cpu-prof <path>` writes a
        // loadable DevTools file; TN_JS_CPU_PROFILE=1 is the env equivalent with the printed
        // summary only. Opt-in because the profiler perturbs the frame, and started on demand at
        // the first eligible frame so startup's compiles do not contaminate the sample.
        const char* enabled = std::getenv("TN_JS_CPU_PROFILE");
        if ((enabled != nullptr && enabled[0] == '1') || !g_cpuProfilePath.empty()) {
            g_startCpuProfile = [this]() {
                if (cpuProfiler_) return;
                V8EntryScope entryScope(isolate_);
                const auto context = context_.Get(isolate_);
                entryScope.enterContext(context);
                cpuProfiler_ = v8::CpuProfiler::New(isolate_);
                cpuProfiler_->SetSamplingInterval(200);
                v8::HandleScope profileScope(isolate_);
                cpuProfiler_->StartProfiling(
                    v8::String::NewFromUtf8(isolate_, "tn-frame").ToLocalChecked(), true);
                std::cout << "[V8] CPU profiler started" << std::endl;
            };
            g_dumpCpuProfile = [this]() { dumpCpuProfile(); };
            // `--cpu-prof` asks for the whole run, so it starts now rather than at the Android
            // probe's frame 226 — a short playtest run must still profile. The env var keeps the
            // steady-state start so an A/B on Android is unchanged.
            if (!g_cpuProfilePath.empty()) g_startCpuProfile();
        }
#endif
        std::cout << "[V8] Engine created successfully" << std::endl;
    }

#if TN_JS_PROFILE || TN_ANDROID_JS_PROFILE
    // Flatten the sampled tree into self-time per (function, script:line) and print the heaviest
    // entries. Self time is the node's own hit count, so a shared helper is not credited to its
    // callers and the totals stay additive. When `--cpu-prof` named a path, the same profile is
    // serialized to a DevTools `.cpuprofile` beside the summary.
    void dumpCpuProfile() {
        if (!cpuProfiler_) return;
        V8EntryScope entryScope(isolate_);
        v8::Local<v8::Context> context = context_.Get(isolate_);
        entryScope.enterContext(context);
        v8::HandleScope scope(isolate_);
        v8::Context::Scope contextScope(context);
        v8::CpuProfile* profile = cpuProfiler_->StopProfiling(
            v8::String::NewFromUtf8(isolate_, "tn-frame").ToLocalChecked());
        if (!profile) return;

        struct Entry { unsigned hits = 0; std::string location; };
        std::unordered_map<std::string, Entry> self;
        unsigned total = 0;
        // Walk with the caller in hand: a C++ binding has no name of its own in a V8 profile, so
        // the only way to say *which* binding ate the time is to name the JS frame that called it.
        // Without this, 62% of a startup stall read as "(anonymous) @ (native)" and named nothing.
        struct Frame { const v8::CpuProfileNode* node; std::string caller; };
        auto label = [&](const v8::CpuProfileNode* node, std::string& name, std::string& file) {
            // `file` stays bare so the native test below can recognise "(native)"; callers carry
            // the line, because "which binding" is answered by "which line called it".
            v8::String::Utf8Value fn(isolate_, node->GetFunctionName());
            v8::String::Utf8Value url(isolate_, node->GetScriptResourceName());
            name = *fn && **fn ? *fn : "(anonymous)";
            file = *url && **url ? *url : "(native)";
            const size_t slash = file.find_last_of('/');
            if (slash != std::string::npos) file = file.substr(slash + 1);
        };
        std::vector<Frame> stack{{profile->GetTopDownRoot(), "(root)"}};
        while (!stack.empty()) {
            Frame frame = stack.back();
            stack.pop_back();
            const v8::CpuProfileNode* node = frame.node;
            const unsigned hits = node->GetHitCount();
            total += hits;
            std::string name;
            std::string file;
            label(node, name, file);
            if (hits > 0) {
                const bool native = file == "(native)";
                const std::string key = native ? "native <- " + frame.caller : name + " @ " + file;
                auto& entry = self[key];
                entry.hits += hits;
                entry.location = native ? frame.caller : file + ":" + std::to_string(node->GetLineNumber());
            }
            const std::string caller = file == "(native)"
                ? frame.caller
                : name + " @ " + file + ":" + std::to_string(node->GetLineNumber());
            for (int i = 0; i < node->GetChildrenCount(); i++) stack.push_back({node->GetChild(i), caller});
        }
        std::vector<std::pair<std::string, Entry>> rows(self.begin(), self.end());
        std::sort(rows.begin(), rows.end(),
                  [](const auto& a, const auto& b) { return a.second.hits > b.second.hits; });
        std::cout << "TN_JS_CPU_PROFILE_TOTAL:" << total << std::endl;
        for (size_t i = 0; i < rows.size() && i < 60; i++) {
            std::cout << "TN_JS_CPU_PROFILE:" << rows[i].second.hits << "\t"
                      << (total ? 100.0 * rows[i].second.hits / total : 0.0) << "\t"
                      << rows[i].first << "\t" << rows[i].second.location << std::endl;
        }
        if (!g_cpuProfilePath.empty()) {
            // Write beside the target and rename, so a kill mid-write cannot leave a truncated
            // `.cpuprofile` that still looks like a profile.
            const std::string temporaryPath = g_cpuProfilePath + ".tmp";
            if (!writeCpuProfile(isolate_, profile, temporaryPath) ||
                std::rename(temporaryPath.c_str(), g_cpuProfilePath.c_str()) != 0) {
                std::cerr << "TN_CPU_PROFILE_WRITE_FAILED: write failed for " << g_cpuProfilePath
                          << std::endl;
                g_cpuProfileFailed = true;
            } else {
                std::cout << "TN_CPU_PROFILE_WRITTEN:" << g_cpuProfilePath << std::endl;
            }
        }
        profile->Delete();
        cpuProfiler_->Dispose();
        cpuProfiler_ = nullptr;
    }
#endif

    ~V8Engine() override {
        std::cout << "[V8] Destroying engine..." << std::endl;
#if TN_JS_PROFILE || TN_ANDROID_JS_PROFILE
        dumpCpuProfile();
#endif
        // Clean up any remaining frame handles
        for (auto* handle : frameHandles_) {
            releasePersistent(handle);
        }
        frameHandles_.clear();
        protectedHandles_.clear();
        for (auto* pooled : persistentPool_) delete pooled;
        persistentPool_.clear();
        for (auto* ref : nativeFunctionRefs_) {
            ref->persistent.Reset();
            delete ref->function;
            delete ref->method;
            delete ref;
        }
        nativeFunctionRefs_.clear();
        for (auto* ref : weakRefs_) {
            ref->persistent.Reset();
            delete ref;
        }
        weakRefs_.clear();
        for (auto& entry : moduleCache_) {
            entry.second.Reset();
        }
        moduleCache_.clear();
        for (auto& entry : nativeObjectTemplates_) entry.second.Reset();
        nativeObjectTemplates_.clear();
        reflectSet_.Reset();
        reflectGetPrototypeOf_.Reset();
        bindingDestinationPrototype_.Reset();
        bindingDestinationKey_.Reset();
        privateKey_.Reset();
        // Interned keys are Globals too: they must be dropped before the isolate is disposed,
        // because these members outlive this destructor body.
        for (auto& entry : internedKeys_) {
            entry.second.Reset();
        }
        internedKeys_.clear();
        // Remove the foreground task runner before releasing its isolate. Worker isolates are
        // created and destroyed rapidly, and V8's default platform keeps runners keyed by the
        // raw isolate pointer; leaving one behind can route a later wake into stale runner state.
        v8::platform::NotifyIsolateShutdown(g_platform.get(), isolate_);
        context_.Reset();
        isolate_->Dispose();
        delete allocator_;
    }

    EngineType getType() const override { return EngineType::V8; }
    const char* getName() const override { return "V8"; }

    // ========================================================================
    // Script Evaluation
    // ========================================================================

    bool eval(const char* code, const char* filename) override {
        V8EntryScope entry_scope(isolate_);
        v8::Local<v8::Context> context = context_.Get(isolate_);
        entry_scope.enterContext(context);

        v8::Local<v8::String> source =
            v8::String::NewFromUtf8(isolate_, code).ToLocalChecked();

        // Use module mode to support import.meta
        v8::ScriptOrigin origin(
#if V8_MAJOR_VERSION < 12
            // `ScriptOrigin` took the isolate until V8 12 and dropped it after. The Android
            // prebuilt is 11.0 and the desktop archive is 13.1, so both spellings have to build.
            isolate_,
#endif
            v8::String::NewFromUtf8(isolate_, filename).ToLocalChecked(),
            0,                      // line offset
            0,                      // column offset
            false,                  // is shared cross-origin
            -1,                     // script id
            v8::Local<v8::Value>(), // source map URL
            false,                  // is opaque
            false,                  // is WASM
            true                    // is module
        );

        v8::TryCatch try_catch(isolate_);

        // The desktop entry takes this member: `ModuleSystem::loadEntry` sends an ESM entry to
        // `loadEsmEntry`, which calls `eval`. Instantiation is part of the compile segment because
        // it links — and therefore compiles — the imported graph.
        mystral::ColdStartEvalScope coldStart;

        v8::ScriptCompiler::Source script_source(source, origin);
        v8::Local<v8::Module> module;
        if (!v8::ScriptCompiler::CompileModule(isolate_, &script_source).ToLocal(&module)) {
            reportException(try_catch);
            return false;
        }

        // Register the entry module for reverse lookup (needed when this module imports others)
        moduleIdToPath_[module->GetIdentityHash()] = filename;

        auto resolveCallback = &V8Engine::moduleResolveCallback;

        // Instantiate the module
        if (!module->InstantiateModule(context, resolveCallback).FromMaybe(false)) {
            reportException(try_catch);
            return false;
        }
        coldStart.compiled();

        // Evaluate the module
        coldStart.executing();
        v8::Local<v8::Value> result;
        if (!module->Evaluate(context).ToLocal(&result)) {
            reportException(try_catch);
            return false;
        }
        coldStart.executed();

        return true;
    }

    JSValueHandle evalWithResult(const char* code, const char* filename) override {
        V8EntryScope entry_scope(isolate_);
        v8::Local<v8::Context> context = context_.Get(isolate_);
        entry_scope.enterContext(context);

        v8::Local<v8::String> source =
            v8::String::NewFromUtf8(isolate_, code).ToLocalChecked();

        // Use module mode to support import.meta
        v8::ScriptOrigin origin(
#if V8_MAJOR_VERSION < 12
            // `ScriptOrigin` took the isolate until V8 12 and dropped it after. The Android
            // prebuilt is 11.0 and the desktop archive is 13.1, so both spellings have to build.
            isolate_,
#endif
            v8::String::NewFromUtf8(isolate_, filename).ToLocalChecked(),
            0, 0, false, -1, v8::Local<v8::Value>(), false, false, true);

        v8::TryCatch try_catch(isolate_);

        mystral::ColdStartEvalScope coldStart;

        v8::ScriptCompiler::Source script_source(source, origin);
        v8::Local<v8::Module> module;
        if (!v8::ScriptCompiler::CompileModule(isolate_, &script_source).ToLocal(&module)) {
            reportException(try_catch);
            return {nullptr, isolate_};
        }

        // Register the entry module for reverse lookup (needed when this module imports others)
        moduleIdToPath_[module->GetIdentityHash()] = filename;

        auto resolveCallback = &V8Engine::moduleResolveCallback;

        if (!module->InstantiateModule(context, resolveCallback).FromMaybe(false)) {
            reportException(try_catch);
            return {nullptr, isolate_};
        }
        coldStart.compiled();

        coldStart.executing();
        v8::Local<v8::Value> result;
        if (!module->Evaluate(context).ToLocal(&result)) {
            reportException(try_catch);
            return {nullptr, isolate_};
        }
        coldStart.executed();

        // Store persistent handle
        v8::Persistent<v8::Value>* persistent = acquirePersistent(isolate_, result);
        frameHandles_.insert(persistent);
        return {persistent, isolate_};
    }

    bool evalScript(const char* code, const char* filename) override {
        V8EntryScope entry_scope(isolate_);
        v8::Local<v8::Context> context = context_.Get(isolate_);
        entry_scope.enterContext(context);

        v8::Local<v8::String> source =
            v8::String::NewFromUtf8(isolate_, code).ToLocalChecked();

        v8::ScriptOrigin origin(
#if V8_MAJOR_VERSION < 12
            // `ScriptOrigin` took the isolate until V8 12 and dropped it after. The Android
            // prebuilt is 11.0 and the desktop archive is 13.1, so both spellings have to build.
            isolate_,
#endif
            v8::String::NewFromUtf8(isolate_, filename).ToLocalChecked(),
            0, 0, false, -1, v8::Local<v8::Value>(), false, false, false);

        v8::TryCatch try_catch(isolate_);
        // The Android entry takes this member: `android_main.cpp` reads the bundle out of the APK
        // and hands it to `runtime->evalScript`, which reaches here.
        mystral::ColdStartEvalScope coldStart;
        v8::Local<v8::Script> script;
        if (!v8::Script::Compile(context, source, &origin).ToLocal(&script)) {
            reportException(try_catch);
            return false;
        }
        coldStart.compiled();

        coldStart.executing();
        v8::Local<v8::Value> result;
        if (!script->Run(context).ToLocal(&result)) {
            reportException(try_catch);
            return false;
        }
        coldStart.executed();

        return true;
    }

    JSValueHandle evalScriptWithResult(const char* code, const char* filename) override {
        V8EntryScope entry_scope(isolate_);
        v8::Local<v8::Context> context = context_.Get(isolate_);
        entry_scope.enterContext(context);

        v8::Local<v8::String> source =
            v8::String::NewFromUtf8(isolate_, code).ToLocalChecked();

        v8::ScriptOrigin origin(
#if V8_MAJOR_VERSION < 12
            // `ScriptOrigin` took the isolate until V8 12 and dropped it after. The Android
            // prebuilt is 11.0 and the desktop archive is 13.1, so both spellings have to build.
            isolate_,
#endif
            v8::String::NewFromUtf8(isolate_, filename).ToLocalChecked(),
            0, 0, false, -1, v8::Local<v8::Value>(), false, false, false);

        v8::TryCatch try_catch(isolate_);
        // CommonJS modules reach here through `ModuleSystem::executeCjsModule`, nested inside the
        // entry's own evaluation, so the scope's depth guard leaves them unmarked.
        mystral::ColdStartEvalScope coldStart;
        v8::Local<v8::Script> script;
        if (!v8::Script::Compile(context, source, &origin).ToLocal(&script)) {
            reportException(try_catch);
            return {nullptr, isolate_};
        }
        coldStart.compiled();

        coldStart.executing();
        v8::Local<v8::Value> result;
        if (!script->Run(context).ToLocal(&result)) {
            reportException(try_catch);
            return {nullptr, isolate_};
        }
        coldStart.executed();

        v8::Persistent<v8::Value>* persistent = acquirePersistent(isolate_, result);
        frameHandles_.insert(persistent);
        return {persistent, isolate_};
    }

    // ========================================================================
    // Global Object Access
    // ========================================================================

    JSValueHandle getGlobal() override {
        V8EntryScope entry_scope(isolate_);
        v8::Local<v8::Context> context = context_.Get(isolate_);
        v8::Local<v8::Object> global = context->Global();
        v8::Persistent<v8::Value>* persistent = acquirePersistent(isolate_, global);
        frameHandles_.insert(persistent);
        return {persistent, isolate_};
    }

    bool setGlobalProperty(const char* name, JSValueHandle value) override {
        V8EntryScope entry_scope(isolate_);
        v8::Local<v8::Context> context = context_.Get(isolate_);
        entry_scope.enterContext(context);

        v8::Local<v8::Object> global = context->Global();
        v8::Local<v8::Value> val = localValue(value);

        return setPropertyWithReflect(
            context,
            global,
            v8::String::NewFromUtf8(isolate_, name).ToLocalChecked(),
            val);
    }

    JSValueHandle getGlobalProperty(const char* name) override {
        V8EntryScope entry_scope(isolate_);
        v8::Local<v8::Context> context = context_.Get(isolate_);
        entry_scope.enterContext(context);

        v8::Local<v8::Object> global = context->Global();
        v8::Local<v8::Value> result;
        global->Get(context, v8::String::NewFromUtf8(isolate_, name).ToLocalChecked()).ToLocal(&result);

        v8::Persistent<v8::Value>* persistent = acquirePersistent(isolate_, result);
        frameHandles_.insert(persistent);
        return {persistent, isolate_};
    }

    // ========================================================================
    // Value Creation
    // ========================================================================

    JSValueHandle newUndefined() override {
        V8EntryScope entry_scope(isolate_);
        // One persistent, not one per call. Every binding that returns nothing used to take a
        // pooled Persistent, `Reset` it, insert it into `frameHandles_` and have the trampoline
        // erase and release it again — a canvas `fillRect` is exactly that, and a page painting
        // procedurally calls it a million times at startup. A protected handle is skipped by the
        // trampoline's release path, so this one outlives every call and is never pooled.
        if (undefinedHandle_ == nullptr) {
            undefinedHandle_ = acquirePersistent(isolate_, v8::Undefined(isolate_));
            protectedHandles_.insert(undefinedHandle_);
        }
        return {undefinedHandle_, isolate_};
    }

    JSValueHandle newNull() override {
        V8EntryScope entry_scope(isolate_);
        v8::Persistent<v8::Value>* persistent = acquirePersistent(isolate_, v8::Null(isolate_));
        frameHandles_.insert(persistent);
        return {persistent, isolate_};
    }

    JSValueHandle newBoolean(bool value) override {
        V8EntryScope entry_scope(isolate_);
        v8::Persistent<v8::Value>* persistent = acquirePersistent(isolate_, v8::Boolean::New(isolate_, value));
        frameHandles_.insert(persistent);
        return {persistent, isolate_};
    }

    JSValueHandle newNumber(double value) override {
        V8EntryScope entry_scope(isolate_);
        v8::Persistent<v8::Value>* persistent = acquirePersistent(isolate_, v8::Number::New(isolate_, value));
        frameHandles_.insert(persistent);
        return {persistent, isolate_};
    }

    JSValueHandle newString(const char* value) override {
        V8EntryScope entry_scope(isolate_);
        v8::Persistent<v8::Value>* persistent = acquirePersistent(isolate_, v8::String::NewFromUtf8(isolate_, value).ToLocalChecked());
        frameHandles_.insert(persistent);
        return {persistent, isolate_};
    }

    JSValueHandle newObject() override {
        V8EntryScope entry_scope(isolate_);
        v8::Local<v8::Context> context = context_.Get(isolate_);
        entry_scope.enterContext(context);
        v8::Local<v8::Object> object = v8::Object::New(isolate_);
        object->SetPrivate(
            context,
            bindingDestinationKey_.Get(isolate_),
            v8::True(isolate_)).Check();
        v8::Persistent<v8::Value>* persistent =
            acquirePersistent(isolate_, object);
        frameHandles_.insert(persistent);
        return {persistent, isolate_};
    }

    bool supportsNativeObjectTemplates() const override { return true; }

    JSValueHandle newNativeObject(const char* className, void* nativeData) override {
        V8EntryScope entryScope(isolate_);
        const auto context = context_.Get(isolate_);
        entryScope.enterContext(context);
        if (!className || className[0] == '\0') {
            throwException("native object class name must not be empty");
            return {};
        }

        auto [it, inserted] = nativeObjectTemplates_.try_emplace(className);
        if (inserted) {
            const auto objectTemplate = v8::ObjectTemplate::New(isolate_);
            objectTemplate->SetInternalFieldCount(1);
            it->second.Reset(isolate_, objectTemplate);
        }

        v8::Local<v8::Object> object;
        if (!it->second.Get(isolate_)->NewInstance(context).ToLocal(&object)) return {};
        if (!object->SetPrototype(
                context, bindingDestinationPrototype_.Get(isolate_)).FromMaybe(false)) {
            return {};
        }
        object->SetAlignedPointerInInternalField(0, nativeData);
        object->SetPrivate(
            context,
            bindingDestinationKey_.Get(isolate_),
            v8::True(isolate_)).Check();
        auto* persistent = acquirePersistent(isolate_, object);
        frameHandles_.insert(persistent);
        return {persistent, isolate_};
    }

    JSValueHandle newArray(size_t length) override {
        V8EntryScope entry_scope(isolate_);
        v8::Local<v8::Context> context = context_.Get(isolate_);
        entry_scope.enterContext(context);
        v8::Persistent<v8::Value>* persistent = acquirePersistent(isolate_, v8::Array::New(isolate_, (int)length));
        frameHandles_.insert(persistent);
        return {persistent, isolate_};
    }

    JSValueHandle newArrayBuffer(const uint8_t* data, size_t length) override {
        V8EntryScope entry_scope(isolate_);
        v8::Local<v8::Context> context = context_.Get(isolate_);
        entry_scope.enterContext(context);

        // Create a backing store with a copy of the data
        std::unique_ptr<v8::BackingStore> backingStore = v8::ArrayBuffer::NewBackingStore(
            isolate_, length);

        // Copy the data into the backing store
        if (data && length > 0) {
            memcpy(backingStore->Data(), data, length);
        }

        // Create the ArrayBuffer with the backing store
        v8::Local<v8::ArrayBuffer> arrayBuffer = v8::ArrayBuffer::New(
            isolate_, std::move(backingStore));

        v8::Persistent<v8::Value>* persistent = acquirePersistent(isolate_, arrayBuffer);
        frameHandles_.insert(persistent);
        return {persistent, isolate_};
    }

    JSValueHandle newArrayBufferExternal(void* data, size_t length) override {
        V8EntryScope entry_scope(isolate_);
        v8::Local<v8::Context> context = context_.Get(isolate_);
        entry_scope.enterContext(context);

        // Create a backing store that references external memory without copying
        // Pass empty deleter since WebGPU manages this memory
        std::unique_ptr<v8::BackingStore> backingStore = v8::ArrayBuffer::NewBackingStore(
            data, length,
            [](void*, size_t, void*) {}, // Empty deleter - don't free GPU memory
            nullptr);

        // Create the ArrayBuffer with the backing store
        v8::Local<v8::ArrayBuffer> arrayBuffer = v8::ArrayBuffer::New(
            isolate_, std::move(backingStore));

        v8::Persistent<v8::Value>* persistent = acquirePersistent(isolate_, arrayBuffer);
        frameHandles_.insert(persistent);
        return {persistent, isolate_};
    }

    void* getArrayBufferData(JSValueHandle value, size_t* size) override {
        V8EntryScope entry_scope(isolate_);

        if (!value.ptr) return nullptr;
        v8::Local<v8::Value> val = localValue(value);

        // Check if it's an ArrayBuffer
        if (val->IsArrayBuffer()) {
            v8::Local<v8::ArrayBuffer> arrayBuffer = val.As<v8::ArrayBuffer>();
            std::shared_ptr<v8::BackingStore> backingStore = arrayBuffer->GetBackingStore();
            if (size) *size = backingStore->ByteLength();
            return backingStore->Data();
        }

        // Check if it's a TypedArray
        if (val->IsTypedArray()) {
            v8::Local<v8::TypedArray> typedArray = val.As<v8::TypedArray>();
            v8::Local<v8::ArrayBuffer> arrayBuffer = typedArray->Buffer();
            std::shared_ptr<v8::BackingStore> backingStore = arrayBuffer->GetBackingStore();
            if (size) *size = typedArray->ByteLength();
            return static_cast<uint8_t*>(backingStore->Data()) + typedArray->ByteOffset();
        }

        if (size) *size = 0;
        return nullptr;
    }

    JSValueHandle createFloat32Array(const float* data, size_t count) override {
        V8EntryScope entry_scope(isolate_);
        v8::Local<v8::Context> context = context_.Get(isolate_);
        entry_scope.enterContext(context);

        size_t byteLength = count * sizeof(float);
        std::unique_ptr<v8::BackingStore> backingStore = v8::ArrayBuffer::NewBackingStore(isolate_, byteLength);
        if (data && byteLength > 0) {
            memcpy(backingStore->Data(), data, byteLength);
        }
        v8::Local<v8::ArrayBuffer> arrayBuffer = v8::ArrayBuffer::New(isolate_, std::move(backingStore));
        v8::Local<v8::Float32Array> typedArray = v8::Float32Array::New(arrayBuffer, 0, count);

        v8::Persistent<v8::Value>* persistent = acquirePersistent(isolate_, typedArray);
        frameHandles_.insert(persistent);
        return {persistent, isolate_};
    }

    JSValueHandle createFloat32ArrayView(float* data, size_t count) override {
        V8EntryScope entry_scope(isolate_);
        v8::Local<v8::Context> context = context_.Get(isolate_);
        entry_scope.enterContext(context);

        size_t byteLength = count * sizeof(float);
        // Create external backing store (no copy, caller manages lifetime)
        std::unique_ptr<v8::BackingStore> backingStore = v8::ArrayBuffer::NewBackingStore(
            data, byteLength,
            [](void*, size_t, void*) {}, // No-op deleter - caller manages memory
            nullptr
        );
        v8::Local<v8::ArrayBuffer> arrayBuffer = v8::ArrayBuffer::New(isolate_, std::move(backingStore));
        v8::Local<v8::Float32Array> typedArray = v8::Float32Array::New(arrayBuffer, 0, count);

        v8::Persistent<v8::Value>* persistent = acquirePersistent(isolate_, typedArray);
        frameHandles_.insert(persistent);
        return {persistent, isolate_};
    }

    JSValueHandle createUint32Array(const uint32_t* data, size_t count) override {
        V8EntryScope entry_scope(isolate_);
        v8::Local<v8::Context> context = context_.Get(isolate_);
        entry_scope.enterContext(context);

        size_t byteLength = count * sizeof(uint32_t);
        std::unique_ptr<v8::BackingStore> backingStore = v8::ArrayBuffer::NewBackingStore(isolate_, byteLength);
        if (data && byteLength > 0) {
            memcpy(backingStore->Data(), data, byteLength);
        }
        v8::Local<v8::ArrayBuffer> arrayBuffer = v8::ArrayBuffer::New(isolate_, std::move(backingStore));
        v8::Local<v8::Uint32Array> typedArray = v8::Uint32Array::New(arrayBuffer, 0, count);

        v8::Persistent<v8::Value>* persistent = acquirePersistent(isolate_, typedArray);
        frameHandles_.insert(persistent);
        return {persistent, isolate_};
    }

    JSValueHandle createUint8Array(const uint8_t* data, size_t count) override {
        V8EntryScope entry_scope(isolate_);
        // A context must be entered for typed-array creation: this method can be
        // called outside of a JS call stack (e.g. from WebTransport event
        // dispatch), where no context is current. Matches newArrayBuffer().
        v8::Local<v8::Context> context = context_.Get(isolate_);
        entry_scope.enterContext(context);

        std::unique_ptr<v8::BackingStore> backingStore = v8::ArrayBuffer::NewBackingStore(isolate_, count);
        if (data && count > 0) {
            memcpy(backingStore->Data(), data, count);
        }
        v8::Local<v8::ArrayBuffer> arrayBuffer = v8::ArrayBuffer::New(isolate_, std::move(backingStore));
        v8::Local<v8::Uint8Array> typedArray = v8::Uint8Array::New(arrayBuffer, 0, count);

        v8::Persistent<v8::Value>* persistent = acquirePersistent(isolate_, typedArray);
        frameHandles_.insert(persistent);
        return {persistent, isolate_};
    }

    JSValueHandle newFunction(const char* name, NativeFunction fn) override {
        V8EntryScope entry_scope(isolate_);
        v8::Local<v8::Context> context = context_.Get(isolate_);
        entry_scope.enterContext(context);

        // Store the callback
        auto* fnPtr = new NativeFunction(fn);
#if TN_ANDROID_JS_PROFILE
        bridgeNames()[fnPtr] = name ? name : "<anon>";
#endif
        v8::Local<v8::External> external = v8::External::New(isolate_, fnPtr);

        // Use Function::New instead of FunctionTemplate::New — lighter weight,
        // avoids SharedFunctionInfo/FeedbackVector accumulation that prevents GC
        v8::Local<v8::Function> func = v8::Function::New(context, nativeCallback, external).ToLocalChecked();

        // The External points at fnPtr for as long as JavaScript can retain the
        // function. Tie that allocation to the JS function's GC lifetime; frame
        // cleanup is too early for cached WebGPU wrapper methods.
        auto* functionRef = new NativeFunctionRef();
        functionRef->persistent.Reset(isolate_, func);
        functionRef->function = fnPtr;
        functionRef->owner = this;
        nativeFunctionRefs_.insert(functionRef);
        functionRef->persistent.SetWeak(functionRef, [](const v8::WeakCallbackInfo<NativeFunctionRef>& data) {
            NativeFunctionRef* ref = data.GetParameter();
            if (ref->owner) ref->owner->nativeFunctionRefs_.erase(ref);
            ref->persistent.Reset();
            delete ref->function;
            delete ref;
        }, v8::WeakCallbackType::kParameter);

        v8::Persistent<v8::Value>* persistent = acquirePersistent(isolate_, func);
        frameHandles_.insert(persistent);
        return {persistent, isolate_};
    }

    bool supportsNativeMethods() const override { return true; }

    JSValueHandle newMethod(const char* name, NativeMethod fn) override {
        V8EntryScope entry_scope(isolate_);
        v8::Local<v8::Context> context = context_.Get(isolate_);
        entry_scope.enterContext(context);

        // Same lifecycle as newFunction: store the callback, hand it to the trampoline through
        // an External, and tie both to the JS function's GC lifetime.
        auto* fnPtr = new NativeMethod(std::move(fn));
#if TN_ANDROID_JS_PROFILE
        bridgeNames()[fnPtr] = (name ? name : "<anon>") + std::string("#method");
#endif
        v8::Local<v8::External> external = v8::External::New(isolate_, fnPtr);

        v8::Local<v8::Function> func = v8::Function::New(context, nativeMethodCallback, external).ToLocalChecked();

        auto* functionRef = new NativeFunctionRef();
        functionRef->persistent.Reset(isolate_, func);
        functionRef->method = fnPtr;
        functionRef->owner = this;
        nativeFunctionRefs_.insert(functionRef);
        functionRef->persistent.SetWeak(functionRef, [](const v8::WeakCallbackInfo<NativeFunctionRef>& data) {
            NativeFunctionRef* ref = data.GetParameter();
            if (ref->owner) ref->owner->nativeFunctionRefs_.erase(ref);
            ref->persistent.Reset();
            delete ref->function;
            delete ref->method;
            delete ref;
        }, v8::WeakCallbackType::kParameter);

        v8::Persistent<v8::Value>* persistent = acquirePersistent(isolate_, func);
        frameHandles_.insert(persistent);
        return {persistent, isolate_};
    }

    // ========================================================================
    // Value Conversion
    // ========================================================================

    bool toBoolean(JSValueHandle value) override {
        V8EntryScope entry_scope(isolate_);
        return localValue(value)->BooleanValue(isolate_);
    }

    double toNumber(JSValueHandle value) override {
        V8EntryScope entry_scope(isolate_);
        v8::Local<v8::Context> context = context_.Get(isolate_);
        return localValue(value)->NumberValue(context).FromMaybe(0);
    }

    std::string toString(JSValueHandle value) override {
        V8EntryScope entry_scope(isolate_);
        v8::Local<v8::Context> context = context_.Get(isolate_);
        v8::Local<v8::String> str;
        if (!localValue(value)->ToString(context).ToLocal(&str)) {
            return "";
        }
        v8::String::Utf8Value utf8(isolate_, str);
        return *utf8 ? *utf8 : "";
    }

    bool isUndefined(JSValueHandle value) override {
        V8EntryScope entry_scope(isolate_);
        return localValue(value)->IsUndefined();
    }

    bool isNull(JSValueHandle value) override {
        V8EntryScope entry_scope(isolate_);
        return localValue(value)->IsNull();
    }

    bool isBoolean(JSValueHandle value) override {
        V8EntryScope entry_scope(isolate_);
        return localValue(value)->IsBoolean();
    }

    bool isNumber(JSValueHandle value) override {
        V8EntryScope entry_scope(isolate_);
        return localValue(value)->IsNumber();
    }

    bool isString(JSValueHandle value) override {
        V8EntryScope entry_scope(isolate_);
        return localValue(value)->IsString();
    }

    bool isObject(JSValueHandle value) override {
        V8EntryScope entry_scope(isolate_);
        return localValue(value)->IsObject();
    }

    bool isArray(JSValueHandle value) override {
        V8EntryScope entry_scope(isolate_);
        return localValue(value)->IsArray();
    }

    bool isFunction(JSValueHandle value) override {
        V8EntryScope entry_scope(isolate_);
        return localValue(value)->IsFunction();
    }

    bool isBindingDestination(JSValueHandle value) override {
        if (!value.ptr || value.ctx != isolate_) return false;
        V8EntryScope entry_scope(isolate_);
        v8::Local<v8::Context> context = context_.Get(isolate_);
        entry_scope.enterContext(context);
        v8::Local<v8::Value> local = localValue(value);
        if (!local->IsObject()) return false;
        if (local->IsProxy()) return false;
        v8::Local<v8::Object> object = local.As<v8::Object>();
        if (!object->HasPrivate(
                context, bindingDestinationKey_.Get(isolate_)).FromMaybe(false)) {
            return false;
        }
#if V8_MAJOR_VERSION >= 12
        v8::Local<v8::Value> prototype = object->GetPrototypeV2();
#else
        v8::Local<v8::Value> prototype = object->GetPrototype();
#endif
        return prototype->StrictEquals(bindingDestinationPrototype_.Get(isolate_));
    }

    bool isSameValue(JSValueHandle left, JSValueHandle right) override {
        if (!left.ptr || !right.ptr) return left.ptr == right.ptr;
        V8EntryScope entry_scope(isolate_);
        return localValue(left)->SameValue(localValue(right));
    }

    // ========================================================================
    // Object Operations
    // ========================================================================

    bool setProperty(JSValueHandle obj, const char* name, JSValueHandle value) override {
        V8EntryScope entry_scope(isolate_);
        v8::Local<v8::Context> context = context_.Get(isolate_);
        entry_scope.enterContext(context);

        v8::Local<v8::Object> objLocal = localValue(obj).As<v8::Object>();
        v8::TryCatch try_catch(isolate_);
        const auto result = objLocal->CreateDataProperty(
            context, internedKey(isolate_, name), localValue(value));
        if (result.IsNothing()) {
            reportException(try_catch);
            return false;
        }
        return result.FromJust();
    }

    JSValueHandle getProperty(JSValueHandle obj, const char* name) override {
        V8EntryScope entry_scope(isolate_);
        v8::Local<v8::Context> context = context_.Get(isolate_);
        entry_scope.enterContext(context);

        v8::Local<v8::Object> objLocal = localValue(obj).As<v8::Object>();

        v8::TryCatch try_catch(isolate_);
        v8::Local<v8::Value> result;
        if (!objLocal->Get(context, internedKey(isolate_, name)).ToLocal(&result)) {
            reportException(try_catch);
            result = v8::Undefined(isolate_);
        }

        v8::Persistent<v8::Value>* persistent = acquirePersistent(isolate_, result);
        frameHandles_.insert(persistent);
        return {persistent, isolate_};
    }

    bool getPropertyInfo(JSValueHandle obj, const char* name, JSPropertyInfo& info) override {
        V8EntryScope entry_scope(isolate_);
        v8::Local<v8::Context> context = context_.Get(isolate_);
        entry_scope.enterContext(context);
        v8::TryCatch try_catch(isolate_);

        v8::Local<v8::Object> current = localValue(obj).As<v8::Object>();
        v8::Local<v8::String> key = internedKey(isolate_, name);
        bool own = true;
        std::vector<v8::Local<v8::Object>> visited;

        while (!current.IsEmpty()) {
            for (const auto& seen : visited) {
                if (current->StrictEquals(seen)) {
                    throwException(
                        "JavaScript property prototype traversal detected a cycle");
                    return false;
                }
            }
            visited.push_back(current);

            v8::Local<v8::Value> descriptor;
            if (!current->GetOwnPropertyDescriptor(context, key).ToLocal(&descriptor)) {
                reportException(try_catch);
                return false;
            }
            if (!descriptor->IsUndefined()) {
                v8::Local<v8::Object> descriptorObject = descriptor.As<v8::Object>();
                const auto hasValue = descriptorObject->HasOwnProperty(
                    context,
                    v8::String::NewFromUtf8(isolate_, "value").ToLocalChecked());
                if (hasValue.IsNothing()) {
                    reportException(try_catch);
                    return false;
                }

                info.own = own;
                const auto readBoolean = [&](const char* field, bool& output) {
                    v8::Local<v8::Value> value;
                    if (!descriptorObject->Get(
                            context,
                            v8::String::NewFromUtf8(isolate_, field).ToLocalChecked())
                             .ToLocal(&value)) {
                        reportException(try_catch);
                        return false;
                    }
                    output = value->BooleanValue(isolate_);
                    return true;
                };
                if (!readBoolean("enumerable", info.enumerable) ||
                    !readBoolean("configurable", info.configurable)) {
                    return false;
                }
                if (!hasValue.FromJust()) {
                    info.kind = JSPropertyKind::Accessor;
                    info.writable = false;
                    info.value = {};
                    return true;
                }

                v8::Local<v8::Value> value;
                if (!descriptorObject->Get(
                        context,
                        v8::String::NewFromUtf8(isolate_, "value").ToLocalChecked())
                         .ToLocal(&value)) {
                    reportException(try_catch);
                    return false;
                }
                if (!readBoolean("writable", info.writable)) return false;
                auto* persistent = acquirePersistent(isolate_, value);
                frameHandles_.insert(persistent);
                info.kind = JSPropertyKind::Data;
                info.value = {persistent, isolate_};
                return true;
            }

            if (reflectGetPrototypeOf_.IsEmpty()) {
                throwException("V8 Reflect.getPrototypeOf intrinsic is unavailable");
                return false;
            }
            v8::Local<v8::Function> getPrototypeOf =
                reflectGetPrototypeOf_.Get(isolate_);
            v8::Local<v8::Value> args[] = {current};
            v8::Local<v8::Value> prototype;
            if (!getPrototypeOf->Call(
                    context, v8::Undefined(isolate_), 1, args)
                     .ToLocal(&prototype)) {
                reportException(try_catch);
                return false;
            }
            if (!prototype->IsObject()) break;
            current = prototype.As<v8::Object>();
            own = false;
        }

        info = {};
        return true;
    }

    void releasePropertyInfo(JSPropertyInfo& info) override {
        if (info.kind == JSPropertyKind::Data && info.value.ptr) {
            auto* persistent =
                static_cast<v8::Persistent<v8::Value>*>(info.value.ptr);
            frameHandles_.erase(persistent);
            releasePersistent(persistent);
        }
        info = {};
    }

    bool hasProperty(JSValueHandle obj, const char* name) override {
        V8EntryScope entry_scope(isolate_);
        v8::Local<v8::Context> context = context_.Get(isolate_);
        entry_scope.enterContext(context);

        v8::Local<v8::Object> objLocal = localValue(obj).As<v8::Object>();
        v8::TryCatch try_catch(isolate_);
        const auto result = objLocal->Has(
            context,
            v8::String::NewFromUtf8(isolate_, name).ToLocalChecked());
        if (result.IsNothing()) {
            reportException(try_catch);
            return false;
        }
        return result.FromJust();
    }

    bool deleteProperty(JSValueHandle obj, const char* name) override {
        V8EntryScope entry_scope(isolate_);
        v8::Local<v8::Context> context = context_.Get(isolate_);
        entry_scope.enterContext(context);

        v8::Local<v8::Object> objLocal = localValue(obj).As<v8::Object>();
        v8::TryCatch try_catch(isolate_);
        const auto result = objLocal->Delete(
            context,
            v8::String::NewFromUtf8(isolate_, name).ToLocalChecked());
        if (result.IsNothing()) {
            reportException(try_catch);
            return false;
        }
        return result.FromJust();
    }

    bool setPropertyIndex(JSValueHandle arr, uint32_t index, JSValueHandle value) override {
        V8EntryScope entry_scope(isolate_);
        v8::Local<v8::Context> context = context_.Get(isolate_);
        entry_scope.enterContext(context);

        v8::Local<v8::Object> objLocal = localValue(arr).As<v8::Object>();
        return objLocal->Set(context, index, localValue(value)).FromMaybe(false);
    }

    JSValueHandle getPropertyIndex(JSValueHandle arr, uint32_t index) override {
        V8EntryScope entry_scope(isolate_);
        v8::Local<v8::Context> context = context_.Get(isolate_);
        entry_scope.enterContext(context);

        v8::Local<v8::Object> objLocal = localValue(arr).As<v8::Object>();

        v8::Local<v8::Value> result;
        objLocal->Get(context, index).ToLocal(&result);

        v8::Persistent<v8::Value>* persistent = acquirePersistent(isolate_, result);
        frameHandles_.insert(persistent);
        return {persistent, isolate_};
    }

    JSValueHandle call(JSValueHandle func, JSValueHandle thisArg, const std::vector<JSValueHandle>& args) override {
        V8EntryScope entry_scope(isolate_);
        v8::Local<v8::Context> context = context_.Get(isolate_);
        entry_scope.enterContext(context);

        v8::Local<v8::Function> funcLocal = localValue(func).As<v8::Function>();

        v8::Local<v8::Value> thisLocal;
        if (thisArg.ptr) {
            thisLocal = localValue(thisArg);
        } else {
            thisLocal = v8::Undefined(isolate_);
        }

        std::vector<v8::Local<v8::Value>> v8Args;
        v8Args.reserve(args.size());
        for (const auto& arg : args) {
            v8Args.push_back(localValue(arg));
        }

        v8::TryCatch try_catch(isolate_);
        v8::Local<v8::Value> result;
        if (!funcLocal->Call(context, thisLocal, (int)v8Args.size(), v8Args.data()).ToLocal(&result)) {
            reportException(try_catch);
            if (nativeCallbackDepth_ > 0) try_catch.ReThrow();
            return {nullptr, isolate_};
        }

        v8::Persistent<v8::Value>* persistent = acquirePersistent(isolate_, result);
        frameHandles_.insert(persistent);
        return {persistent, isolate_};
    }

    // ========================================================================
    // Memory Management
    // ========================================================================

    void freezeHandle(JSValueHandle value) override {
        if (!value.ptr) return;
        if (value.borrowed) {
            throwException("borrowed callback handle must be retained before it can be frozen");
            return;
        }
        // Mark this handle as protected in this engine's set. nativeCallback will check it
        // and skip deletion for protected handles.
        protectedHandles_.insert(value.ptr);
        frameHandles_.insert(static_cast<v8::Persistent<v8::Value>*>(value.ptr));
    }

    JSValueHandle retainHandle(JSValueHandle value) override {
        if (!value.ptr || !value.borrowed) {
            freezeHandle(value);
            return value;
        }
        auto* persistent = acquirePersistent(isolate_, localValue(value));
        frameHandles_.insert(persistent);
        protectedHandles_.insert(persistent);
        return {persistent, isolate_};
    }

    void freeHandle(JSValueHandle value) override {
        if (!value.ptr || value.borrowed) return;
        v8::Persistent<v8::Value>* persistent = (v8::Persistent<v8::Value>*)value.ptr;
        const auto it = frameHandles_.find(persistent);
        if (it == frameHandles_.end()) return;
        protectedHandles_.erase(value.ptr);
        frameHandles_.erase(it);
        releasePersistent(persistent);
    }

    void protect(JSValueHandle value) override { freezeHandle(value); }
    void unprotect(JSValueHandle value) override { freeHandle(value); }

    size_t outstandingHandleCount() const override { return frameHandles_.size(); }

    void gc() override {
        isolate_->LowMemoryNotification();
    }

    void processMicrotasks() override {
        V8EntryScope entry_scope(isolate_);
        v8::Local<v8::Context> context = context_.Get(isolate_);
        entry_scope.enterContext(context);
        while (v8::platform::PumpMessageLoop(g_platform.get(), isolate_)) {
        }
        isolate_->PerformMicrotaskCheckpoint();
    }

    bool supportsBlockingTaskWait() const override { return true; }

    void waitForTask() override {
        V8EntryScope entry_scope(isolate_);
        v8::Local<v8::Context> context = context_.Get(isolate_);
        entry_scope.enterContext(context);
        v8::platform::PumpMessageLoop(
            g_platform.get(), isolate_, v8::platform::MessageLoopBehavior::kWaitForWork);
        isolate_->PerformMicrotaskCheckpoint();
    }

    void wakeTaskWait() override {
        g_platform->GetForegroundTaskRunner(isolate_)->PostTask(
            std::make_unique<V8WakeTask>());
    }

    void beginFrame() override {
        inFrame_ = true;
        isolate_->SetIdle(false);
    }

    void clearFrameHandles() override {
        for (auto it = frameHandles_.begin(); it != frameHandles_.end();) {
            auto* handle = *it;
            if (protectedHandles_.find(handle) == protectedHandles_.end()) {
                releasePersistent(handle);
                it = frameHandles_.erase(it);
            } else {
                ++it;
            }
        }

        inFrame_ = false;

        // Tell V8 we're idle between frames so it can do deferred GC work
        // (incremental marking, sweeping, weak callback processing).
        // beginFrame() sets this back to false.
        isolate_->SetIdle(true);
    }

    void suspendFrameTracking() override {
        frameTrackingSuspended_ = true;
    }

    void resumeFrameTracking() override {
        frameTrackingSuspended_ = false;
    }

    void registerRelease(JSValueHandle obj, std::function<void()> callback) override {
        V8EntryScope entry_scope(isolate_);

        v8::Local<v8::Value> local = localValue(obj);

        // Create a separate weak persistent for GC tracking
        auto* weakData = new WeakRef();
        weakData->persistent.Reset(isolate_, local);
        weakData->callback = std::move(callback);
        weakData->isolate = isolate_;
        weakData->owner = this;
        weakRefs_.insert(weakData);

        // Tell V8 about external (Dawn) memory so it triggers major GC
        // when native resources accumulate. 16KB is an overestimate per
        // resource, but it ensures V8's own GC heuristics trigger major
        // collections frequently enough to fire weak callbacks and release
        // Dawn resources before they accumulate significantly.
        static constexpr int64_t kExternalResourceSize = 16384;
        isolate_->AdjustAmountOfExternalAllocatedMemory(kExternalResourceSize);

        weakData->persistent.SetWeak(weakData, [](const v8::WeakCallbackInfo<WeakRef>& data) {
            WeakRef* ref = data.GetParameter();
            ref->callback();  // Release the Dawn resource
            ref->isolate->AdjustAmountOfExternalAllocatedMemory(-kExternalResourceSize);
            ref->persistent.Reset();
            ref->owner->weakRefs_.erase(ref);
            delete ref;
        }, v8::WeakCallbackType::kParameter);
    }

    // ========================================================================
    // Error Handling
    // ========================================================================

    bool hasException() override {
        return !lastException_.empty();
    }

    std::string getException() override {
        std::string result = lastException_;
        lastException_.clear();
        exceptionFromNativeCallback_ = false;
        return result;
    }

    void throwTypeError(const char* message) override {
        V8EntryScope entry_scope(isolate_);
        v8::Local<v8::Context> context = context_.Get(isolate_);
        entry_scope.enterContext(context);
        isolate_->ThrowException(v8::Exception::TypeError(
            v8::String::NewFromUtf8(isolate_, message).ToLocalChecked()));
        lastException_ = std::string("TypeError: ") + message;
        if (nativeCallbackDepth_ > 0) exceptionFromNativeCallback_ = true;
    }

    void throwException(const char* message) override {
        V8EntryScope entry_scope(isolate_);
        v8::Local<v8::Context> context = context_.Get(isolate_);
        entry_scope.enterContext(context);
        isolate_->ThrowException(
            v8::String::NewFromUtf8(isolate_, message).ToLocalChecked());
        lastException_ = message;
        if (nativeCallbackDepth_ > 0) exceptionFromNativeCallback_ = true;
    }

    // ========================================================================
    // Private Data
    // ========================================================================

    void setPrivateData(JSValueHandle obj, void* data) override {
        V8EntryScope entry_scope(isolate_);
        v8::Local<v8::Context> context = context_.Get(isolate_);
        entry_scope.enterContext(context);

        v8::Local<v8::Object> objLocal = localValue(obj).As<v8::Object>();

        if (objLocal->InternalFieldCount() > 0) {
            objLocal->SetAlignedPointerInInternalField(0, data);
            return;
        }

        // Use cached private key to avoid string allocation
        v8::Local<v8::Private> key = privateKey_.Get(isolate_);
        objLocal->SetPrivate(context, key, v8::External::New(isolate_, data));
    }

    void* getPrivateData(JSValueHandle obj) override {
        V8EntryScope entry_scope(isolate_);
        v8::Local<v8::Context> context = context_.Get(isolate_);
        entry_scope.enterContext(context);

        v8::Local<v8::Object> objLocal = localValue(obj).As<v8::Object>();

        if (objLocal->InternalFieldCount() > 0) {
            return objLocal->GetAlignedPointerFromInternalField(0);
        }

        // Use cached private key to avoid string allocation
        v8::Local<v8::Private> key = privateKey_.Get(isolate_);

        v8::Local<v8::Value> result;
        if (!objLocal->GetPrivate(context, key).ToLocal(&result) || !result->IsExternal()) {
            return nullptr;
        }
        return result.As<v8::External>()->Value();
    }

    bool setPrototypeOf(JSValueHandle object, JSValueHandle prototype) override {
        V8EntryScope entry_scope(isolate_);
        v8::Local<v8::Context> context = context_.Get(isolate_);
        entry_scope.enterContext(context);

        v8::Local<v8::Object> objLocal = localValue(object).As<v8::Object>();

        v8::TryCatch try_catch(isolate_);
#if V8_MAJOR_VERSION >= 12
        const auto result = objLocal->SetPrototypeV2(context, localValue(prototype));
#else
        const auto result = objLocal->SetPrototype(context, localValue(prototype));
#endif
        if (result.IsNothing()) {
            reportException(try_catch);
            return false;
        }
        return result.FromJust();
    }

    // ========================================================================
    // Raw Context Access
    // ========================================================================

    void* getRawContext() override {
        return isolate_;
    }

private:
    void cacheIntrinsics(v8::Local<v8::Context> context) {
        v8::Local<v8::Value> reflectValue;
        if (!context->Global()
                 ->Get(
                     context,
                     v8::String::NewFromUtf8(isolate_, "Reflect").ToLocalChecked())
                 .ToLocal(&reflectValue) ||
            !reflectValue->IsObject()) {
            return;
        }
        v8::Local<v8::Object> reflect = reflectValue.As<v8::Object>();
        v8::Local<v8::Value> getPrototypeOf;
        if (reflect
                ->Get(
                    context,
                    v8::String::NewFromUtf8(isolate_, "getPrototypeOf").ToLocalChecked())
                .ToLocal(&getPrototypeOf) &&
            getPrototypeOf->IsFunction()) {
            reflectGetPrototypeOf_.Reset(isolate_, getPrototypeOf.As<v8::Function>());
        }
        v8::Local<v8::Value> set;
        if (reflect
                ->Get(
                    context,
                    v8::String::NewFromUtf8(isolate_, "set").ToLocalChecked())
                .ToLocal(&set) &&
            set->IsFunction()) {
            reflectSet_.Reset(isolate_, set.As<v8::Function>());
        }
    }

    bool setPropertyWithReflect(
        v8::Local<v8::Context> context,
        v8::Local<v8::Object> object,
        v8::Local<v8::Value> property,
        v8::Local<v8::Value> value) {
        if (reflectSet_.IsEmpty()) {
            throwException("V8 Reflect.set intrinsic is unavailable");
            return false;
        }
        v8::TryCatch try_catch(isolate_);
        v8::Local<v8::Value> args[] = {object, property, value};
        v8::Local<v8::Value> result;
        if (!reflectSet_.Get(isolate_)
                 ->Call(context, v8::Undefined(isolate_), 3, args)
                 .ToLocal(&result)) {
            reportException(try_catch);
            return false;
        }
        return result->BooleanValue(isolate_);
    }

    static std::string toStdString(v8::Isolate* isolate, v8::Local<v8::Value> value) {
        v8::String::Utf8Value utf8(isolate, value);
        if (*utf8) {
            return *utf8;
        }
        return "";
    }

    v8::MaybeLocal<v8::Module> resolveModule(v8::Local<v8::Context> context,
                                             v8::Local<v8::String> specifier,
                                             v8::Local<v8::Module> referrer) {
        auto* moduleSystem = getModuleSystem();
        if (!moduleSystem) {
            context->GetIsolate()->ThrowException(v8::Exception::Error(
                v8::String::NewFromUtf8(context->GetIsolate(), "Module system not initialized").ToLocalChecked()));
            return v8::MaybeLocal<v8::Module>();
        }

        std::string spec = toStdString(context->GetIsolate(), specifier);
        std::string referrerName;
        // v8::Module doesn't have GetScriptOrigin(), so we use a reverse lookup map
        auto pathIt = moduleIdToPath_.find(referrer->GetIdentityHash());
        if (pathIt != moduleIdToPath_.end()) {
            referrerName = pathIt->second;
        }

        ResolvedModule resolved;
        std::string error;
        if (!moduleSystem->resolveForImport(spec, referrerName, resolved, error)) {
            context->GetIsolate()->ThrowException(v8::Exception::Error(
                v8::String::NewFromUtf8(context->GetIsolate(), error.c_str()).ToLocalChecked()));
            return v8::MaybeLocal<v8::Module>();
        }

        auto it = moduleCache_.find(resolved.resolved.path);
        if (it != moduleCache_.end()) {
            return it->second.Get(context->GetIsolate());
        }

        std::string source;
        std::string filename;
        if (!moduleSystem->getEsmSource(resolved, referrerName, source, filename, error)) {
            context->GetIsolate()->ThrowException(v8::Exception::Error(
                v8::String::NewFromUtf8(context->GetIsolate(), error.c_str()).ToLocalChecked()));
            return v8::MaybeLocal<v8::Module>();
        }

        v8::ScriptOrigin origin(
#if V8_MAJOR_VERSION < 12
            // See the note above: V8 11 takes the isolate here, 12+ does not.
            context->GetIsolate(),
#endif
            v8::String::NewFromUtf8(context->GetIsolate(), filename.c_str()).ToLocalChecked(),
            0, 0, false, -1, v8::Local<v8::Value>(), false, false, true);

        v8::ScriptCompiler::Source scriptSource(
            v8::String::NewFromUtf8(context->GetIsolate(), source.c_str()).ToLocalChecked(),
            origin);

        v8::Local<v8::Module> module;
        if (!v8::ScriptCompiler::CompileModule(context->GetIsolate(), &scriptSource).ToLocal(&module)) {
            return v8::MaybeLocal<v8::Module>();
        }

        moduleCache_[resolved.resolved.path].Reset(context->GetIsolate(), module);
        moduleIdToPath_[module->GetIdentityHash()] = resolved.resolved.path;
        return module;
    }

    static v8::MaybeLocal<v8::Module> moduleResolveCallback(v8::Local<v8::Context> context,
                                                            v8::Local<v8::String> specifier,
                                                            v8::Local<v8::FixedArray> import_attributes,
                                                            v8::Local<v8::Module> referrer) {
        v8::Isolate* isolate = context->GetIsolate();
        (void)import_attributes;
        auto* engine = static_cast<V8Engine*>(isolate->GetData(0));
        if (!engine) {
            isolate->ThrowException(v8::Exception::Error(
                v8::String::NewFromUtf8(isolate, "V8 engine not available").ToLocalChecked()));
            return v8::MaybeLocal<v8::Module>();
        }
        return engine->resolveModule(context, specifier, referrer);
    }

    void setupGlobals() {
        v8::Local<v8::Context> context = context_.Get(isolate_);

        // console object
        v8::Local<v8::Object> console = v8::Object::New(isolate_);

        auto makeLogFn = [this, context](const char* prefix) {
            return v8::FunctionTemplate::New(isolate_, [](const v8::FunctionCallbackInfo<v8::Value>& info) {
                v8::Isolate* isolate = info.GetIsolate();
                v8::HandleScope handle_scope(isolate);

                // Get prefix from data
                v8::Local<v8::String> prefixStr = info.Data().As<v8::String>();
                v8::String::Utf8Value prefixUtf8(isolate, prefixStr);

                // Built once so it can go to both sinks. On Android `std::cout` is discarded, so a
                // console that only wrote there left every `console.log` invisible — a benchmark
                // could run to completion and look like a hang. QuickJS's console already does this.
                std::string line;
                for (int i = 0; i < info.Length(); i++) {
                    v8::String::Utf8Value str(isolate, info[i]);
                    line += (*str ? *str : "");
                    if (i < info.Length() - 1) line += " ";
                }
                std::cout << "[" << *prefixUtf8 << "] " << line << std::endl;
#if defined(__ANDROID__)
                // __android_log_write, not __android_log_print: the print formatter caps at
                // LOG_BUF_SIZE 1024 (1023 bytes), which truncated TN_FRAME_BUDGET windows.
                const std::string full = std::string("[") + *prefixUtf8 + "] " + line;
                __android_log_write(ANDROID_LOG_INFO, "MystralJS", full.c_str());
#endif
            }, v8::String::NewFromUtf8(isolate_, prefix).ToLocalChecked())->GetFunction(context).ToLocalChecked();
        };

        console->Set(context, v8::String::NewFromUtf8(isolate_, "log").ToLocalChecked(), makeLogFn("log")).Check();
        console->Set(context, v8::String::NewFromUtf8(isolate_, "warn").ToLocalChecked(), makeLogFn("warn")).Check();
        console->Set(context, v8::String::NewFromUtf8(isolate_, "error").ToLocalChecked(), makeLogFn("error")).Check();
        console->Set(context, v8::String::NewFromUtf8(isolate_, "info").ToLocalChecked(), makeLogFn("info")).Check();
        console->Set(context, v8::String::NewFromUtf8(isolate_, "debug").ToLocalChecked(), makeLogFn("debug")).Check();

        context->Global()->Set(context, v8::String::NewFromUtf8(isolate_, "console").ToLocalChecked(), console).Check();

        // performance object
        startTime_ = std::chrono::high_resolution_clock::now();

        v8::Local<v8::Object> performance = v8::Object::New(isolate_);
        v8::Local<v8::External> engineData = v8::External::New(isolate_, this);

        v8::Local<v8::Function> nowFn = v8::FunctionTemplate::New(isolate_, [](const v8::FunctionCallbackInfo<v8::Value>& info) {
            V8Engine* engine = static_cast<V8Engine*>(info.Data().As<v8::External>()->Value());
            auto now = std::chrono::high_resolution_clock::now();
            double ms = std::chrono::duration<double, std::milli>(now - engine->startTime_).count();
            info.GetReturnValue().Set(ms);
        }, engineData)->GetFunction(context).ToLocalChecked();

        performance->Set(context, v8::String::NewFromUtf8(isolate_, "now").ToLocalChecked(), nowFn).Check();
        context->Global()->Set(context, v8::String::NewFromUtf8(isolate_, "performance").ToLocalChecked(), performance).Check();

        // Intl stub (V8 was built without ICU, so Intl is not available)
        // Libraries like PixiJS check for Intl?.Segmenter and fall back gracefully
        v8::Local<v8::Object> intl = v8::Object::New(isolate_);
        // Add empty Intl object so typeof Intl !== 'undefined'
        // Note: Segmenter is intentionally not added so libraries fall back to alternatives
        context->Global()->Set(context, v8::String::NewFromUtf8(isolate_, "Intl").ToLocalChecked(), intl).Check();
    }

    void reportException(v8::TryCatch& try_catch) {
        v8::HandleScope handle_scope(isolate_);
        v8::String::Utf8Value exception(isolate_, try_catch.Exception());
        const char* exception_string = *exception ? *exception : "<string conversion failed>";

        v8::Local<v8::Message> message = try_catch.Message();
        if (message.IsEmpty()) {
            std::cerr << "[V8] Error: " << exception_string << std::endl;
            lastException_ = exception_string;
        } else {
            v8::String::Utf8Value filename(isolate_, message->GetScriptOrigin().ResourceName());
            int linenum = message->GetLineNumber(isolate_->GetCurrentContext()).FromMaybe(-1);

            std::cerr << "[V8] " << (*filename ? *filename : "<unknown>")
                      << ":" << linenum << ": " << exception_string << std::endl;

            v8::Local<v8::String> sourceline;
            if (message->GetSourceLine(isolate_->GetCurrentContext()).ToLocal(&sourceline)) {
                v8::String::Utf8Value sourceline_utf8(isolate_, sourceline);
                std::cerr << "[V8] " << *sourceline_utf8 << std::endl;
            }

            lastException_ = exception_string;
        }
    }

    static void nativeCallback(const v8::FunctionCallbackInfo<v8::Value>& info) {
        v8::Isolate* isolate = info.GetIsolate();
        V8EntryScope entry_scope(isolate);
        v8::Local<v8::Context> context = isolate->GetCurrentContext();
        entry_scope.enterContext(context);

        // Get engine for frame handle tracking
        auto* engine = static_cast<V8Engine*>(isolate->GetData(0));
        // A native callback may have thrown an exception that JavaScript caught. The host-side
        // latch must follow JavaScript control flow, or a later binding transaction will reject a
        // valid install even though the pending JS exception is gone.
        // HasPendingException() exists from V8 13; the Android prebuilt (V8 11) has no public
        // equivalent, so there the latch clears on the host-side record alone. The probe only
        // guards the rare finally-block-with-pending-exception call, and clearing early errs
        // toward un-rejecting valid installs, which is what the latch exists to fix.
        if (engine && engine->nativeCallbackDepth_ == 0 &&
            engine->exceptionFromNativeCallback_ && engine->hasException()
#if V8_MAJOR_VERSION >= 13
            && !isolate->HasPendingException()
#endif
        ) {
            engine->getException();
        }

        // Get the native function from external data
        v8::Local<v8::External> external = info.Data().As<v8::External>();
        NativeFunction* fn = static_cast<NativeFunction*>(external->Value());

        if (engine) engine->nativeCallbackDepth_ += 1;

#if TN_ANDROID_JS_PROFILE
        // PRD-222: count every crossing; time only top-level ones so nesting is not double counted.
        const bool tnProfileTopLevel = engine && engine->nativeCallbackDepth_ == 1;
        const auto tnProfileStart = std::chrono::steady_clock::now();
        const uint64_t tnProfileCpuStart = tnProfileTopLevel ? threadCpuNs() : 0;
        g_bridgeCalls += 1;
        g_bridgeArgs += static_cast<uint64_t>(info.Length());
#endif

        // Borrow callback-local values directly. A callee that needs one after this synchronous
        // crossing explicitly promotes it with retainHandle().
        if ((int)engine->callbackArgsPool_.size() <= engine->nativeCallbackDepth_) {
            engine->callbackArgsPool_.resize(engine->nativeCallbackDepth_ + 1);
            engine->callbackLocalsPool_.resize(engine->nativeCallbackDepth_ + 1);
        }
        std::vector<JSValueHandle>& args = engine->callbackArgsPool_[engine->nativeCallbackDepth_];
        auto& locals = engine->callbackLocalsPool_[engine->nativeCallbackDepth_];
        args.clear();
        locals.clear();
        args.reserve(info.Length());
        locals.reserve(info.Length());
        for (int i = 0; i < info.Length(); i++) {
            locals.push_back(info[i]);
        }
        for (auto& local : locals) {
            args.push_back({&local, isolate, true});
        }

#if TN_ANDROID_JS_PROFILE
        const auto tnPrologueEnd = std::chrono::steady_clock::now();
#endif
        // Call the native function
        JSValueHandle result = (*fn)(isolate, args);
#if TN_ANDROID_JS_PROFILE
        const auto tnEpilogueStart = std::chrono::steady_clock::now();
#endif

        if (result.ptr) info.GetReturnValue().Set(engine->localValue(result));

        if (result.ptr && !result.borrowed &&
            (!engine || engine->protectedHandles_.find(result.ptr) == engine->protectedHandles_.end())) {
            auto* resPersistent = static_cast<v8::Persistent<v8::Value>*>(result.ptr);
            if (engine) {
                engine->frameHandles_.erase(resPersistent);
            }
            engine->releasePersistent(resPersistent);
        }
#if TN_ANDROID_JS_PROFILE
        {
            const auto tnNow = std::chrono::steady_clock::now();
            g_bridgeOverheadNs += static_cast<uint64_t>(
                std::chrono::duration_cast<std::chrono::nanoseconds>(tnPrologueEnd - tnProfileStart).count()
                + std::chrono::duration_cast<std::chrono::nanoseconds>(tnNow - tnEpilogueStart).count());
            auto& stat = bridgeStats()[fn];
            stat.calls += 1;
            stat.ns += static_cast<uint64_t>(
                std::chrono::duration_cast<std::chrono::nanoseconds>(tnEpilogueStart - tnPrologueEnd).count());
        }
        if (tnProfileTopLevel) {
            g_bridgeNs += threadCpuNs() - tnProfileCpuStart;
        }
#endif
        if (engine) engine->nativeCallbackDepth_ -= 1;
    }

    // Receiver-aware twin of nativeCallback: resolves the NativeMethod and the receiver's
    // private data and mirrors the same argument-pooling, protected-handle skip, return-value
    // transfer and profiling skeleton, so method crossings behave exactly like function
    // crossings (PRD-222 per-class binding tables).
    static void nativeMethodCallback(const v8::FunctionCallbackInfo<v8::Value>& info) {
        v8::Isolate* isolate = info.GetIsolate();
        V8EntryScope entry_scope(isolate);
        v8::Local<v8::Context> context = isolate->GetCurrentContext();
        entry_scope.enterContext(context);

        auto* engine = static_cast<V8Engine*>(isolate->GetData(0));
        if (engine && engine->nativeCallbackDepth_ == 0 &&
            engine->exceptionFromNativeCallback_ && engine->hasException()
#if V8_MAJOR_VERSION >= 13
            && !isolate->HasPendingException()
#endif
        ) {
            engine->getException();
        }

        // Get the native method from external data
        v8::Local<v8::External> external = info.Data().As<v8::External>();
        NativeMethod* fn = static_cast<NativeMethod*>(external->Value());
        if (!engine || !fn) {
            // No engine context to dispatch through or nothing stored; fail soft.
            return;
        }

        // Resolve the receiver's private data. A detached call has no usable receiver; the
        // callee sees nullptr and reports it.
        void* receiverPrivate = nullptr;
        if (info.This()->IsObject()) {
            const auto receiver = info.This().As<v8::Object>();
            if (receiver->InternalFieldCount() > 0) {
                receiverPrivate = receiver->GetAlignedPointerFromInternalField(0);
            } else {
                v8::Local<v8::Value> stored;
                if (receiver->GetPrivate(context, engine->privateKey_.Get(isolate))
                        .ToLocal(&stored) && stored->IsExternal()) {
                    receiverPrivate = stored.As<v8::External>()->Value();
                }
            }
        }

        if (engine) engine->nativeCallbackDepth_ += 1;

#if TN_ANDROID_JS_PROFILE
        const bool tnProfileTopLevel = engine && engine->nativeCallbackDepth_ == 1;
        const auto tnProfileStart = std::chrono::steady_clock::now();
        const uint64_t tnProfileCpuStart = tnProfileTopLevel ? threadCpuNs() : 0;
        g_bridgeCalls += 1;
        g_bridgeArgs += static_cast<uint64_t>(info.Length());
#endif

        if ((int)engine->callbackArgsPool_.size() <= engine->nativeCallbackDepth_) {
            engine->callbackArgsPool_.resize(engine->nativeCallbackDepth_ + 1);
            engine->callbackLocalsPool_.resize(engine->nativeCallbackDepth_ + 1);
        }
        std::vector<JSValueHandle>& args = engine->callbackArgsPool_[engine->nativeCallbackDepth_];
        auto& locals = engine->callbackLocalsPool_[engine->nativeCallbackDepth_];
        args.clear();
        locals.clear();
        args.reserve(info.Length());
        locals.reserve(info.Length());
        for (int i = 0; i < info.Length(); i++) {
            locals.push_back(info[i]);
        }
        for (auto& local : locals) {
            args.push_back({&local, isolate, true});
        }

#if TN_ANDROID_JS_PROFILE
        const auto tnPrologueEnd = std::chrono::steady_clock::now();
#endif
        JSValueHandle result = (*fn)(*engine, receiverPrivate, args);
#if TN_ANDROID_JS_PROFILE
        const auto tnEpilogueStart = std::chrono::steady_clock::now();
#endif

        if (result.ptr) info.GetReturnValue().Set(engine->localValue(result));

        if (result.ptr && !result.borrowed &&
            (!engine || engine->protectedHandles_.find(result.ptr) == engine->protectedHandles_.end())) {
            auto* resPersistent = static_cast<v8::Persistent<v8::Value>*>(result.ptr);
            if (engine) {
                engine->frameHandles_.erase(resPersistent);
            }
            engine->releasePersistent(resPersistent);
        }
#if TN_ANDROID_JS_PROFILE
        {
            const auto tnNow = std::chrono::steady_clock::now();
            g_bridgeOverheadNs += static_cast<uint64_t>(
                std::chrono::duration_cast<std::chrono::nanoseconds>(tnPrologueEnd - tnProfileStart).count()
                + std::chrono::duration_cast<std::chrono::nanoseconds>(tnNow - tnEpilogueStart).count());
            auto& stat = bridgeStats()[fn];
            stat.calls += 1;
            stat.ns += static_cast<uint64_t>(
                std::chrono::duration_cast<std::chrono::nanoseconds>(tnEpilogueStart - tnPrologueEnd).count());
        }
        if (tnProfileTopLevel) {
            g_bridgeNs += threadCpuNs() - tnProfileCpuStart;
        }
#endif
        if (engine) engine->nativeCallbackDepth_ -= 1;
    }

    // Weak reference data for GC-triggered Dawn resource cleanup
    struct WeakRef {
        v8::Persistent<v8::Value> persistent;
        std::function<void()> callback;
        v8::Isolate* isolate = nullptr;
        V8Engine* owner = nullptr;
    };

    v8::Isolate* isolate_ = nullptr;
#if TN_JS_PROFILE || TN_ANDROID_JS_PROFILE
    v8::CpuProfiler* cpuProfiler_ = nullptr;
#endif
    v8::ArrayBuffer::Allocator* allocator_ = nullptr;
    v8::Global<v8::Context> context_;
    v8::Global<v8::Function> reflectSet_;
    v8::Global<v8::Function> reflectGetPrototypeOf_;
    v8::Global<v8::Value> bindingDestinationPrototype_;
    v8::Global<v8::Private> bindingDestinationKey_;
    v8::Global<v8::Private> privateKey_;  // Cached private key to avoid string allocation per call
    std::string lastException_;
    std::chrono::high_resolution_clock::time_point startTime_;
    std::unordered_map<std::string, v8::Global<v8::Module>> moduleCache_;
    std::unordered_map<std::string, v8::Global<v8::ObjectTemplate>> nativeObjectTemplates_;
    std::unordered_map<int, std::string> moduleIdToPath_;  // Reverse lookup: module hash -> path
    std::unordered_set<v8::Persistent<v8::Value>*> frameHandles_;  // Handles to free at end of frame
    std::unordered_set<void*> protectedHandles_;
    std::unordered_set<NativeFunctionRef*> nativeFunctionRefs_;
    std::unordered_set<WeakRef*> weakRefs_;
    // Handlers read the same few property names ("length", "offset", "data", …) thousands of
    // times per frame; interning them replaces a NewFromUtf8 allocation per read with one map
    // lookup. The set of names is tiny and bounded by the host's own call sites.
    std::unordered_map<std::string, v8::Global<v8::String>> internedKeys_;
    // Dead Persistent owners recycled across handles. The bridge creates and destroys
    // thousands of handles per frame, and every one of them was a heap allocation pair —
    // scudo allocate/deallocate owned measurable self time in the simpleperf capture.
    std::vector<v8::Persistent<v8::Value>*> persistentPool_;
    static constexpr size_t kPersistentPoolCap = 4096;
    // One arg vector per callback nesting depth, reused across callbacks on this thread.
    // A crossing used to heap-allocate its argument vector even when it had arguments.
    std::deque<std::vector<JSValueHandle>> callbackArgsPool_;
    std::deque<std::vector<v8::Local<v8::Value>>> callbackLocalsPool_;
    bool inFrame_ = false;  // True during animation frame execution
    bool frameTrackingSuspended_ = false;  // When true, skip frame tracking for new allocations
    int nativeCallbackDepth_ = 0;
    bool exceptionFromNativeCallback_ = false;

    v8::Local<v8::Value> localValue(JSValueHandle value) const {
        if (value.borrowed) {
            return *static_cast<v8::Local<v8::Value>*>(value.ptr);
        }
        return static_cast<v8::Persistent<v8::Value>*>(value.ptr)->Get(isolate_);
    }

    // Requires an active Isolate/HandleScope (every caller already holds one).
    v8::Local<v8::String> internedKey(v8::Isolate* isolate, const char* name) {
        auto it = internedKeys_.find(name);
        if (it != internedKeys_.end()) return it->second.Get(isolate);
        v8::Local<v8::String> key = v8::String::NewFromUtf8(isolate, name).ToLocalChecked();
        internedKeys_.emplace(name, v8::Global<v8::String>(isolate, key));
        return key;
    }

    /** The one `undefined` this engine hands out; protected, so no call releases it. */
    v8::Persistent<v8::Value>* undefinedHandle_ = nullptr;

    v8::Persistent<v8::Value>* acquirePersistent(v8::Isolate* isolate, v8::Local<v8::Value> value) {
        v8::Persistent<v8::Value>* persistent;
        if (!persistentPool_.empty()) {
            persistent = persistentPool_.back();
            persistentPool_.pop_back();
        } else {
            persistent = new v8::Persistent<v8::Value>();
        }
        persistent->Reset(isolate, value);
        return persistent;
    }

    void releasePersistent(v8::Persistent<v8::Value>* persistent) {
        if (!persistent) return;
        persistent->Reset();
        if (persistentPool_.size() < kPersistentPoolCap) {
            persistentPool_.push_back(persistent);
        } else {
            delete persistent;
        }
    }
};

// Factory function
std::unique_ptr<Engine> createV8Engine() {
    return std::make_unique<V8Engine>();
}

}  // namespace js
}  // namespace mystral

#endif  // MYSTRAL_JS_V8
