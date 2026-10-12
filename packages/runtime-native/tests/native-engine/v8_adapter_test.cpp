#include "adapters/v8/adapter.h"
#include "check.h"
#include "engine/abi/abi_internal.h"
#include "engine/abi/bindings.h"
#include "engine/abi/tsl_call.h"
#include "engine/animation/mixer.h"
#include "engine/foundation/ThreeConstants.h"
#include "engine/foundation/math/Color.h"
#include "engine/shader/standard.h"
#include "engine/shader/tsl/tsl.h"
#include "engine/shader/wgsl.h"
#include "engine/scene/material.h"
#include "engine/scene/nodes.h"
#include "engine/scene/object3d.h"

#include <libplatform/libplatform.h>

#include <algorithm>
#include <cstdio>
#include <map>
#include <memory>
#include <set>
#include <string>

using tn::adapters::v8adapter::Adapter;

namespace {

struct Runtime {
    std::unique_ptr<v8::Platform> platform;
    v8::Isolate* isolate = nullptr;
    v8::ArrayBuffer::Allocator* allocator = nullptr;
    tn_context_t* context = nullptr;
    Runtime() {
        v8::V8::SetFlagsFromString("--expose-gc");
        platform = v8::platform::NewDefaultPlatform();
        v8::V8::InitializePlatform(platform.get());
        v8::V8::Initialize();
        allocator = v8::ArrayBuffer::Allocator::NewDefaultAllocator();
        v8::Isolate::CreateParams params;
        params.array_buffer_allocator = allocator;
        isolate = v8::Isolate::New(params);
        const tn_version_info_t own = tn_engine_version();
        tn_diagnostic_t d{nullptr, 0};
        tn_context_create(&context, &own, &d);
    }
    ~Runtime() {
        isolate->Dispose();
        tn_diagnostic_t d{nullptr, 0};
        tn_context_destroy(context, &d);
        delete allocator;
        v8::V8::Dispose();
        v8::V8::DisposePlatform();
    }
};

// Runs a script in a fresh context with the engine installed; returns the script's string result.
std::string run(Runtime& rt, Adapter& adapter, const char* source) {
    v8::HandleScope scope(rt.isolate);
    v8::Local<v8::Context> ctx = v8::Context::New(rt.isolate);
    v8::Context::Scope contextScope(ctx);
    adapter.install(ctx, ctx->Global());
    v8::TryCatch tryCatch(rt.isolate);
    v8::Local<v8::String> code = v8::String::NewFromUtf8(rt.isolate, source).ToLocalChecked();
    v8::Local<v8::Script> script;
    v8::Local<v8::Value> result;
    if (!v8::Script::Compile(ctx, code).ToLocal(&script) || !script->Run(ctx).ToLocal(&result)) {
        v8::String::Utf8Value error(rt.isolate, tryCatch.Exception());
        return std::string("THROWN ") + (*error ? *error : "?");
    }
    v8::String::Utf8Value text(rt.isolate, result);
    return *text ? *text : "";
}

Runtime& runtime() {
    static Runtime rt;
    return rt;
}

// Hot calls cross as plain numbers on a stack array (no argument containers) and a chaining call
// answers its own wrapper. Anything else takes the general converter, which counts itself.
void fastPaths() {
    Runtime& rt = runtime();
    v8::Isolate::Scope isolateScope(rt.isolate);
    Adapter adapter(rt.isolate, rt.context);
    const char* setup = "const m = new Mesh(); const p = m.position; const r = m.rotation;";
    const uint64_t start = adapter.genericArguments();
    CHECK(run(rt, adapter, setup) == "undefined");
    const uint64_t baseline = adapter.genericArguments() - start;
    const uint64_t before = adapter.genericArguments();
    const std::string got = run(rt, adapter, (std::string(setup) + R"JS(
        let ok = 1;
        for (let i = 0; i < 2000; ++i) {
            if (p.set(i, i + 1, i + 2) !== p) ok = 0;   // chaining answers the wrapper it was called on
            p.y = i * 0.5;                              // one-number setter
            r.x = i * 0.001; r.y = -i * 0.002;
            r.set(i * 0.01, 0.25, 0);
        }
        const checks = [ok === 1, p.x === 1999 && p.y === 999.5 && p.z === 2001,
                        r.x === 1999 * 0.01 && r.y === 0.25 && r.z === 0,
                        m.quaternion.w !== 1, p.clone() !== p && p.clone().x === 1999];
        checks.map(Number).join("")
    )JS").c_str());
    CHECK(got == "11111");
    if (got != "11111") std::fprintf(stderr, "got %s\n", got.c_str());
    CHECK(adapter.genericArguments() - before == baseline);  // 2000 x 5 numeric calls added none
    // A fixed member is the same wrapper on every read, owned by its object: slot-cached per wrapper,
    // never shared between two objects or two members, and a plain object inheriting from a wrapper
    // gets no cache (and no crash).
    const std::string members = run(rt, adapter, R"JS(
        const a = new Mesh(), b = new Mesh();
        const names = ["position", "rotation", "quaternion", "scale", "matrix", "matrixWorld", "layers", "up"];
        const seen = new Set();
        let ok = 1;
        for (const n of names) {
            const first = a[n];
            if (first === undefined || first !== a[n] || first === b[n] || seen.has(first)) ok = 0;
            seen.add(first);
        }
        const mine = a.position; mine.set(4, 5, 6);
        const heir = Object.create(a);
        // A read member is an own data property, as three defines it: an object inheriting from the wrapper sees the wrapper's.
        const inherited = heir.position === a.position;
        const fresh = Object.create(new Mesh());           // before any read there is no own property, and the accessor finds no engine object
        const inheritedFresh = fresh.position === undefined;
        const own = Object.getOwnPropertyDescriptor(a, "position");
        const readOnly = own !== undefined && own.value === a.position && own.writable === false;
        // A getter borrowed onto another class's object never answers from that object's slots: it
        // returns the right member for the name (a fixed member is one wrapper) or something that is
        // none of the cached members of that object under a different name.
        let borrowed = 1;
        const bodies = [new Mesh(), new DirectionalLight(), new PerspectiveCamera(), new Scene()];
        for (const from of bodies) for (const to of bodies) {
            const proto = Object.getPrototypeOf(from);
            const cachedOfTo = names.filter((m) => m in to).map((m) => [m, to[m]]);
            for (const n of Object.getOwnPropertyNames(proto)) {
                const d = Object.getOwnPropertyDescriptor(proto, n);
                if (!d || !d.get) continue;
                let got, threw = false;
                try { got = d.get.call(to); } catch (e) { threw = true; }
                if (threw || got === undefined || typeof got !== "object" || got === null) continue;
                for (const [m, member] of cachedOfTo) if (got === member && m !== n) borrowed = 0;
                if (names.includes(n) && n in to && got !== to[n]) borrowed = 0;
            }
        }
        [ok, b.position.x === 0, a.position.x === 4 && a.position === mine, inherited && inheritedFresh, borrowed, readOnly].map(Number).join("")
    )JS");
    CHECK(members == "111111");
    if (members != "111111") std::fprintf(stderr, "members %s\n", members.c_str());
    // A numeric setter remembers the class it last wrote. Borrowed onto another class's object it must
    // look the member up again, and write that object, never the first one.
    const std::string borrowedWrites = run(rt, adapter, R"JS(
        const v = new Vector3(), e = new Euler();
        const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(v), "x");
        d.set.call(v, 7); d.set.call(e, 8); d.set.call(v, 9); d.set.call(e, 10);
        let refused = false;
        try { d.set.call(new Mesh(), 5); } catch { refused = true; }   // a Mesh has no x: refused, not written through Vector3's setter
        d.set.call(v, 11);
        [v.x === 11, e.x === 10, refused].map(Number).join("")
    )JS");
    CHECK(borrowedWrites == "111");
    if (borrowedWrites != "111") std::fprintf(stderr, "borrowed writes %s\n", borrowedWrites.c_str());
    // Non-numeric arguments still take the general converter: a handle, a string, an array, a boolean.
    const uint64_t general = adapter.genericArguments();
    const std::string mixed = run(rt, adapter, (std::string(setup) + R"JS(
        const q = new Vector3(1, 2, 3);
        let kinds = [p.copy(q) === p, p.x === 1];
        let threw = 0;
        try { p.x = "no"; } catch (e) { threw = 1; }
        try { p.set(1, 2, "no"); } catch (e) { threw += 1; }
        kinds.map(Number).join("") + threw
    )JS").c_str());
    CHECK(mixed == "112");
    if (mixed != "112") std::fprintf(stderr, "mixed %s\n", mixed.c_str());
    CHECK(adapter.genericArguments() > general + baseline);
}

void handles() {
    Runtime& rt = runtime();
    v8::Isolate::Scope isolateScope(rt.isolate);
    Adapter adapter(rt.isolate, rt.context);
    const std::string got = run(rt, adapter, R"JS(
        const v = new Vector3(1, 2, 3);
        const m = new Matrix4();
        const checks = [
            m.makeTranslation(10, 0, -5) === m,       // chaining returns the same wrapper
            v.applyMatrix4(m) === v,
            v.x === 11 && v.y === 2 && v.z === -2,
            m.elements[12] === 10 && m.elements.length === 16,
            v.clone() !== v && v.clone().x === 11,
            (v.y = 7, v.y === 7),
            v instanceof Vector3,
        ];
        checks.map(Number).join("")
    )JS");
    CHECK(got == "1111111");
    if (got != "1111111") std::fprintf(stderr, "got %s\n", got.c_str());

    // Handles cross into JS and back with every bit, through the wrapper, never as a JS number.
    v8::HandleScope scope(rt.isolate);
    v8::Local<v8::Context> ctx = v8::Context::New(rt.isolate);
    v8::Context::Scope contextScope(ctx);
    adapter.install(ctx, ctx->Global());
    for (int i = 0; i < 2000; ++i) {
        tn_handle_t h{};
        tn_diagnostic_t d{nullptr, 0};
        CHECK(tn_construct(rt.context, "Quaternion", nullptr, 0, &h, &d) == TN_OK);
        if (i % 3 == 0) {  // churn the slots so generations climb
            tn_object_release(h, &d);
            CHECK(tn_construct(rt.context, "Quaternion", nullptr, 0, &h, &d) == TN_OK);
        }
        v8::Local<v8::Value> wrapped = adapter.wrap(h);
        ctx->Global()->Set(ctx, v8::String::NewFromUtf8Literal(rt.isolate, "held"), wrapped).Check();
        v8::Local<v8::Value> back = ctx->Global()->Get(ctx, v8::String::NewFromUtf8Literal(rt.isolate, "held")).ToLocalChecked();
        tn_handle_t out{};
        CHECK(adapter.unwrap(back, out));
        CHECK(out.type == h.type && out.context == h.context && out.index == h.index && out.generation == h.generation);
        CHECK(adapter.wrap(h) == wrapped);  // one wrapper per handle
    }
}

void unsupported() {
    Runtime& rt = runtime();
    v8::Isolate::Scope isolateScope(rt.isolate);
    Adapter adapter(rt.isolate, rt.context);
    CHECK(run(rt, adapter, "typeof new Vector3().teleport") == "undefined");
    const std::string thrown = run(rt, adapter, "const v = new Vector3(); v.applyMatrix4(v)");
    CHECK(thrown.rfind("THROWN TypeError: TN_NATIVE_UNSUPPORTED", 0) == 0);
    if (thrown.rfind("THROWN TypeError: TN_NATIVE_UNSUPPORTED", 0) != 0) std::fprintf(stderr, "%s\n", thrown.c_str());
    CHECK(run(rt, adapter, "Vector3(1,2,3)").rfind("THROWN TypeError", 0) == 0);  // not a construct call
    // A class the engine only hands out is a global (for instanceof), but `new` on it is refused by name.
    CHECK(run(rt, adapter, "typeof AnimationAction") == "function");
    const std::string handedOut = run(rt, adapter, "new AnimationAction()");
    CHECK(handedOut.rfind("THROWN", 0) == 0 && handedOut.find("TN_NATIVE_UNSUPPORTED class AnimationAction") != std::string::npos);
    if (handedOut.find("TN_NATIVE_UNSUPPORTED class AnimationAction") == std::string::npos) std::fprintf(stderr, "%s\n", handedOut.c_str());
    // A JS subclass constructs its nearest engine ancestor, whatever its own (or a bundler's) name.
    const std::string subclass = run(rt, adapter, R"JS(
        class Voice2 extends Object3D { constructor() { super(); this.cue = 7; } }
        class Loud extends Voice2 {}
        const parent = new Object3D(), voice = new Loud();
        parent.add(voice);
        voice.position.x = 2;
        [voice instanceof Voice2, voice.parent === parent, voice.cue, voice.position.x].join()
    )JS");
    CHECK(subclass == "true,true,7,2");
    if (subclass != "true,true,7,2") std::fprintf(stderr, "subclass: %s\n", subclass.c_str());
}

void gcRelease() {
    Runtime& rt = runtime();
    v8::Isolate::Scope isolateScope(rt.isolate);
    Adapter adapter(rt.isolate, rt.context);
    tn_handle_t first{};
    {
        v8::HandleScope scope(rt.isolate);
        v8::Local<v8::Context> ctx = v8::Context::New(rt.isolate);
        v8::Context::Scope contextScope(ctx);
        adapter.install(ctx, ctx->Global());
        v8::Local<v8::Value> v =
            v8::Script::Compile(ctx, v8::String::NewFromUtf8Literal(rt.isolate,
                "for (let i = 0; i < 5000; i++) new Vector3(i, i, i); new Vector3(1, 2, 3)"))
                .ToLocalChecked()->Run(ctx).ToLocalChecked();
        CHECK(adapter.unwrap(v, first));
        CHECK(adapter.liveWrappers() > 0);
    }
    for (int i = 0; i < 4; ++i) rt.isolate->LowMemoryNotification();
    // Unreachable wrappers were collected, and each released its native object.
    CHECK(adapter.liveWrappers() < 100);
    tn_value_t result{};
    tn_diagnostic_t d{nullptr, 0};
    CHECK(tn_get(first, "x", &result, &d) == TN_ERROR_INVALID_HANDLE);
    tn_diagnostic_release(&d);
}

long residentKb() {
    std::FILE* f = std::fopen("/proc/self/statm", "r");
    long pages = 0, resident = 0;
    if (f) {
        if (std::fscanf(f, "%ld %ld", &pages, &resident) != 2) resident = 0;
        std::fclose(f);
    }
    return resident * 4;
}

// Whole runtimes created and destroyed repeatedly leave no native objects and no memory growth.
void runtimeChurn() {
    Runtime& rt = runtime();  // V8 is initialized once per process; isolates come and go below
    long afterWarmup = 0;
    for (int cycle = 0; cycle < 50; ++cycle) {
        v8::Isolate::CreateParams params;
        params.array_buffer_allocator = rt.allocator;
        v8::Isolate* isolate = v8::Isolate::New(params);
        tn_context_t* context = nullptr;
        const tn_version_info_t own = tn_engine_version();
        tn_diagnostic_t d{nullptr, 0};
        CHECK(tn_context_create(&context, &own, &d) == TN_OK);
        tn_handle_t probe{};
        {
            v8::Isolate::Scope isolateScope(isolate);
            Adapter adapter(isolate, context);
            v8::HandleScope scope(isolate);
            v8::Local<v8::Context> ctx = v8::Context::New(isolate);
            v8::Context::Scope contextScope(ctx);
            adapter.install(ctx, ctx->Global());
            v8::Script::Compile(ctx, v8::String::NewFromUtf8Literal(isolate,
                "const keep = []; for (let i = 0; i < 10000; i++) keep.push(new Vector3(i, 0, 0).clone()); keep.length"))
                .ToLocalChecked()->Run(ctx).ToLocalChecked();
            CHECK(tn_construct(context, "Vector3", nullptr, 0, &probe, &d) == TN_OK);
        }
        isolate->Dispose();
        CHECK(tn_context_destroy(context, &d) == TN_OK);
        // The context is gone and took every object with it: its handles resolve to nothing.
        tn_value_t result{};
        CHECK(tn_get(probe, "x", &result, &d) == TN_ERROR_INVALID_HANDLE);
        tn_diagnostic_release(&d);
        if (cycle == 9) afterWarmup = residentKb();
    }
    const long growthKb = residentKb() - afterWarmup;
    std::printf("runtime churn: 40 cycles after warm-up, resident growth %ld KiB\n", growthKb);
    CHECK(growthKb < 16 * 1024);  // 40 cycles x 20,000 objects; a per-cycle leak would show here
}

// Reports the per-call cost of one property write and one method call through the adapter
// (PRD-531 phase 3). CP1 reads these to decide whether bulk paths are needed (decision 9).
void crossingBench() {
    Runtime& rt = runtime();
    v8::Isolate::Scope isolateScope(rt.isolate);
    Adapter adapter(rt.isolate, rt.context);
    const std::string got = run(rt, adapter, R"JS(
        const v = new Vector3(), w = new Vector3(1, 2, 3);
        const N = 1000000;
        for (let i = 0; i < 100000; i++) { v.x = i; v.add(w); }      // warm-up: let the JIT settle
        let t0 = Date.now();
        for (let i = 0; i < N; i++) v.x = i;
        const write = (Date.now() - t0) * 1e6 / N;
        t0 = Date.now();
        for (let i = 0; i < N; i++) v.add(w);
        const call = (Date.now() - t0) * 1e6 / N;
        t0 = Date.now();
        let s = 0;
        for (let i = 0; i < N; i++) s += v.x;
        const read = (Date.now() - t0) * 1e6 / N;
        `write ${write.toFixed(1)} ns, call ${call.toFixed(1)} ns, read ${read.toFixed(1)} ns`
    )JS");
    std::printf("TN_V8_CROSSING %s (V8 13.1 -> C ABI -> binding registry)\n", got.c_str());
    CHECK(got.rfind("write ", 0) == 0);
}

// The scene graph through V8: member objects are properties, `mesh.position` is the same wrapper on
// every read, writes through it reach the native object, and the transform matches three's.
void scene() {
    Runtime& rt = runtime();
    v8::Isolate::Scope isolateScope(rt.isolate);
    Adapter adapter(rt.isolate, rt.context);
    const std::string got = run(rt, adapter, R"JS(
        const parent = new Object3D(), child = new Object3D();
        parent.add(child);
        const p = child.position;
        p.x = 2;
        parent.position.y = 3;
        parent.updateMatrixWorld(true);
        const e = child.matrixWorld.elements;
        const worldPosition = new Vector3(), worldScale = new Vector3();
        const worldQuaternion = new Quaternion(), worldDirection = new Vector3();
        const checks = [
            child.position === p,
            child.position.x === 2,
            e[12] === 2 && e[13] === 3 && e[14] === 0,
            child.matrixWorld === child.matrixWorld,
            child.getWorldPosition(worldPosition) === worldPosition && worldPosition.x === 2 && worldPosition.y === 3,
            child.getWorldScale(worldScale) === worldScale && worldScale.x === 1,
            child.getWorldQuaternion(worldQuaternion) === worldQuaternion && worldQuaternion.w === 1,
            child.getWorldDirection(worldDirection) === worldDirection && worldDirection.z === 1,
        ];
        checks.map(Number).join("")
    )JS");
    CHECK(got == "11111111");
    if (got != "11111111") std::fprintf(stderr, "got %s\n", got.c_str());
}

// PRD-531 phase 1: the adapter exposes exactly the catalog's supported set. The catalog's supported
// classes are the registry's classes (the Python-free ctest above is checked by the snapshot), so
// this case installs the adapter and compares its globals and prototype members with the registry.
void catalogCoverage() {
    Runtime& rt = runtime();
    v8::Isolate::Scope isolateScope(rt.isolate);
    Adapter adapter(rt.isolate, rt.context);
    tn::binding::Registry registry;
    tn::binding::registerAll(registry);

    std::set<std::string> expectedClasses;
    for (const auto& [name, binding] : registry) {
        if (tn_type_id(name.c_str()) != 0) expectedClasses.insert(name); // constructible or only handed out
    }

    v8::HandleScope scope(rt.isolate);
    v8::Local<v8::Context> ctx = v8::Context::New(rt.isolate);
    v8::Context::Scope contextScope(ctx);
    adapter.install(ctx, ctx->Global());
    v8::Local<v8::Object> global = ctx->Global();
    const auto text = [&rt](v8::Local<v8::Value> value) {
        v8::String::Utf8Value utf8(rt.isolate, value);
        return std::string(*utf8 ? *utf8 : "");
    };
    const auto key = [&rt](const std::string& name) {
        return v8::String::NewFromUtf8(rt.isolate, name.c_str()).ToLocalChecked();
    };

    // The installed classes: global functions whose name the catalog publishes a type id for.
    std::set<std::string> installed;
    v8::Local<v8::Array> globals = global->GetOwnPropertyNames(ctx).ToLocalChecked();
    for (uint32_t i = 0; i < globals->Length(); ++i) {
        v8::Local<v8::Value> name;
        v8::Local<v8::Value> value;
        if (!globals->Get(ctx, i).ToLocal(&name)) continue;
        if (!global->Get(ctx, name).ToLocal(&value) || !value->IsFunction()) continue;
        const std::string symbol = text(name);
        if (tn_type_id(symbol.c_str()) != 0) installed.insert(symbol);
    }
    CHECK(installed == expectedClasses);
    // three's scalar constants the minimal template imports (PRD-531 small bindings): globals beside
    // the classes. Their bit-exactness against three is the mathutils reference test's; this proves
    // the wiring: present, of the right kind, with the header's value.
    const std::map<std::string, double> numbers = {
        {"ACESFilmicToneMapping", tn::engine::ACESFilmicToneMapping},
        {"AgXToneMapping", tn::engine::AgXToneMapping},
        {"NeutralToneMapping", tn::engine::NeutralToneMapping},
        {"PCFSoftShadowMap", tn::engine::PCFSoftShadowMap},
        {"LoopOnce", 2200}, {"LoopRepeat", 2201}, {"LoopPingPong", 2202},
        {"PCFShadowMap", 1},
        {"FrontSide", static_cast<double>(tn::engine::Side::Front)},
        {"BackSide", static_cast<double>(tn::engine::Side::Back)},
        {"DoubleSide", static_cast<double>(tn::engine::Side::Double)},
        {"StaticDrawUsage", 35044},
        {"DynamicDrawUsage", 35048},
        {"NoBlending", static_cast<double>(tn::engine::Blending::None)},
        {"NormalBlending", static_cast<double>(tn::engine::Blending::Normal)},
        {"AdditiveBlending", static_cast<double>(tn::engine::Blending::Additive)},
    };
    // A published enum is its member constants, each installed above; the enum itself has no global.
    const std::set<std::string> enums = {"AnimationActionLoopStyles"};
    for (const auto& name : enums) CHECK(!global->HasOwnProperty(ctx, key(name)).FromMaybe(true));
    const std::map<std::string, std::string> strings = {
        {"NoColorSpace", tn::engine::NoColorSpace},
        {"LinearSRGBColorSpace", tn::engine::LinearSRGBColorSpace},
    };
    for (const auto& [name, want] : numbers) {
        v8::Local<v8::Value> value;
        CHECK(global->Get(ctx, key(name)).ToLocal(&value) && value->IsNumber() &&
              value.As<v8::Number>()->Value() == want);
    }
    for (const auto& [name, want] : strings) {
        v8::Local<v8::Value> value;
        CHECK(global->Get(ctx, key(name)).ToLocal(&value) && value->IsString() && text(value) == want);
    }
    // Published intersection record types have no constructor or JavaScript global.
    const std::set<std::string> recordTypes = {"Face", "Intersection"};
    for (const auto& name : recordTypes) {
        CHECK(tn_type_id(name.c_str()) == 0);
        CHECK(!global->HasOwnProperty(ctx, key(name)).FromMaybe(true));
    }
    // Every constant of the engine's table is installed with its value; the spot values above are
    // in it. The catalog publishes exactly the table's constants (sync-native-status).
    std::set<std::string> tableConstants;
    for (const auto& constant : tn::engine::kThreeConstants) {
        v8::Local<v8::Value> value;
        CHECK(global->Get(ctx, key(constant.name)).ToLocal(&value));
        if (constant.text) CHECK(value->IsString() && text(value) == constant.text);
        else CHECK(value->IsNumber() && value.As<v8::Number>()->Value() == constant.number);
        tableConstants.insert(constant.name);
    }
    for (const auto& [name, want] : numbers) CHECK(tableConstants.count(name) == 1);
    for (const auto& [name, want] : strings) CHECK(tableConstants.count(name) == 1);
    CHECK(installed.size() + tableConstants.size() + recordTypes.size() + enums.size() ==
          tn_engine_version().capability_count);

    // Every class's prototype exposes exactly its registry members: methods, top-level getters and
    // member objects. A dotted key is a protocol path, skipped on both sides.
    for (const std::string& name : installed) {
        std::set<std::string> expected;
        const tn::binding::ClassBinding& binding = registry.at(name);
        for (const auto& [member, fn] : binding.methods) { (void)fn; expected.insert(member); }
        for (const auto& [member, fn] : binding.getters) {
            (void)fn;
            if (member.find('.') == std::string::npos) expected.insert(member);
        }
        for (const auto& [member, fn] : binding.members) {
            (void)fn;
            if (member.find('.') == std::string::npos) expected.insert(member);
        }
        for (const auto& [callback, set] : binding.callbacks) {
            (void)set;
            expected.insert(callback);
        }
        // A dotted setter whose head is no member or getter (`layers.mask`, `morphAttributes.position`)
        // exposes its head as a holder object.
        for (const auto& [path, fn] : binding.setters) {
            (void)fn;
            const std::size_t dot = path.find('.');
            // A write-only setter (`needsUpdate`) is a property of its own, or the write never lands.
            if (dot == std::string::npos) {
                expected.insert(path);
                continue;
            }
            const std::string head = path.substr(0, dot);
            if (binding.members.count(head) == 0 && binding.getters.count(head) == 0) expected.insert(head);
        }
        v8::Local<v8::Value> ctor;
        v8::Local<v8::Value> prototype;
        if (!global->Get(ctx, key(name)).ToLocal(&ctor) || !ctor->IsObject() ||
            !ctor.As<v8::Object>()->Get(ctx, key("prototype")).ToLocal(&prototype) ||
            !prototype->IsObject()) {
            CHECK(false);
            continue;
        }
        std::set<std::string> exposed;
        v8::Local<v8::Array> members = prototype.As<v8::Object>()->GetOwnPropertyNames(ctx).ToLocalChecked();
        for (uint32_t i = 0; i < members->Length(); ++i) {
            v8::Local<v8::Value> member;
            if (!members->Get(ctx, i).ToLocal(&member)) continue;
            const std::string symbol = text(member);
            if (symbol == "constructor" || symbol.find('.') != std::string::npos) continue;
            exposed.insert(symbol);
        }
        CHECK(exposed == expected);
        if (exposed != expected) std::fprintf(stderr, "%s: adapter/registry member mismatch\n", name.c_str());
    }
}

// TSL authoring validates its JS boundary and restores the statement stack after callbacks throw.
// PRD-540: three's `uniform.value = x` through the shared table's tslSetUniform. The value reaches the
// material graph's data and leaves its program key alone; a three VectorN makes a vector uniform.
void uniformValue() {
    Runtime& rt = runtime();
    v8::Isolate::Scope isolateScope(rt.isolate);
    Adapter adapter(rt.isolate, rt.context);
    namespace g = tn::engine::shader::graph;
    v8::HandleScope scope(rt.isolate);
    const auto ctx = v8::Context::New(rt.isolate);
    v8::Context::Scope contextScope(ctx);
    adapter.install(ctx, ctx->Global());
    const auto evaluate = [&](const char* source) {
        v8::TryCatch caught(rt.isolate);
        v8::Local<v8::Script> script;
        v8::Local<v8::Value> result;
        const bool ran = v8::Script::Compile(ctx, v8::String::NewFromUtf8(rt.isolate, source).ToLocalChecked()).ToLocal(&script) &&
                         script->Run(ctx).ToLocal(&result);
        if (!ran) {
            v8::String::Utf8Value message(rt.isolate, caught.Exception());
            std::fprintf(stderr, "uniform_value: %s\n", *message ? *message : "?");
        }
        CHECK(ran);
        return result;
    };
    const auto material = evaluate(R"JS(
        globalThis.clock = tsl.uniform(0);
        globalThis.origin = tsl.uniform({ x: 1, y: 2 });
        const m = new MeshBasicNodeMaterial();
        m.colorNode = tsl.vec4(origin, clock, 1);
        m
    )JS");
    tn_handle_t handle{};
    CHECK(adapter.unwrap(material, handle));
    const auto graph = tn::abi::shaderNode(handle, "colorNode");
    const std::string key = g::key(graph);
    auto values = g::uniforms(graph);
    CHECK(values.size() == 2);
    std::vector<std::vector<float>> before;
    for (const auto& [name, lanes] : values) before.push_back(lanes);
    CHECK((before == std::vector<std::vector<float>>{{0}, {1, 2}}) || (before == std::vector<std::vector<float>>{{1, 2}, {0}}));
    evaluate("tsl.setUniform(clock, 0.5); tsl.setUniform(origin, 3, 4); 0");
    std::vector<std::vector<float>> after;
    for (const auto& [name, lanes] : g::uniforms(graph)) after.push_back(lanes);
    CHECK((after == std::vector<std::vector<float>>{{0.5f}, {3, 4}}) || (after == std::vector<std::vector<float>>{{3, 4}, {0.5f}}));
    CHECK(g::key(graph) == key);
    const auto refused = evaluate(R"JS(
        (() => { try { tsl.setUniform(clock, 1, 2); return false; } catch (e) { return e.message.includes('TN_TSL_UNIFORM_VALUE'); } })()
    )JS");
    CHECK(refused->IsTrue());
}

void tslApi() {
    Runtime& rt = runtime();
    v8::Isolate::Scope isolateScope(rt.isolate);
    Adapter adapter(rt.isolate, rt.context);
    const std::string got = run(rt, adapter, R"JS(
        (() => {
            const { Fn, If, Loop, float, uint, vec3, uniform, instancedArray } = tsl;
            let calls = 0;
            const fn = Fn(() => { calls++; float(0).toVar(); });
            const checks = [calls === 1, fn() === fn(), calls === 1];
            const bad = (body) => {
                try { body(); return false; } catch (e) { return e instanceof TypeError && e.message.startsWith('TN_TSL'); }
            };
            checks.push(bad(() => float({})), bad(() => float(NaN)), bad(() => uint(-1)),
                bad(() => uniform(vec3(1)).setName('')), bad(() => instancedArray(0, 'vec4')),
                bad(() => float(0).toVar()), bad(() => float(0).assign(1)),
                bad(() => Fn(() => Loop(1.5, () => {}))),
                bad(() => Fn(() => If(float(0).equal(0), 7))));
            let branch;
            const nested = Fn(() => {
                try { If(float(0).equal(0), () => { throw new Error('original'); }); }
                catch (e) { checks.push(e.message === 'original'); }
                const acc = float(0).toVar();
                Loop(2, ({ i }) => {
                    branch = If(i.lessThan(1), () => acc.assign(1)).Else(() => acc.assign(2));
                });
                checks.push(bad(() => branch.Else(() => {})));
            });
            checks.push(nested() === nested(), bad(() => float(1).add.call(new Vector3(), 2)));
            return checks.map(Number).join('');
        })()
    )JS");
    CHECK(got == "1111111111111111");
    if (got != "1111111111111111") std::fprintf(stderr, "TSL API got %s\n", got.c_str());

    // Compare the actual native DAG, not just the presence of fluent methods. r185's
    // stepElement/mixElement/smoothstepElement reorder the fluent receiver to the last argument.
    namespace g = tn::engine::shader::graph;
    v8::HandleScope scope(rt.isolate);
    const auto ctx = v8::Context::New(rt.isolate);
    v8::Context::Scope contextScope(ctx);
    adapter.install(ctx, ctx->Global());
    tn::engine::Color gray; gray.setHex(0x808080);
    auto reflected = std::make_shared<g::NodeData>();
    reflected->kind = g::Kind::Math; reflected->name = "reflect";
    reflected->type = tn::engine::shader::Type::vec(3);
    reflected->args = {g::vec3({g::float_(1), g::float_(-1), g::float_(0)}),
                      g::vec3({g::float_(0), g::float_(1), g::float_(0)})};
    auto coordinate = std::make_shared<g::NodeData>();
    coordinate->kind = g::Kind::Convert; coordinate->type = tn::engine::shader::Type::vec(2, tn::engine::shader::Type::Scalar::I32);
    coordinate->args = {g::vec2({g::float_(0)})};
    auto load = std::make_shared<g::NodeData>();
    load->kind = g::Kind::TextureLoad; load->name = "input"; load->type = tn::engine::shader::Type::vec(4);
    load->args = {coordinate};
    for (const auto& [expression, expected] : std::vector<std::pair<std::string, g::Node>>{
        {"tsl.color('#808080')", g::vec3({g::float_(gray.r), g::float_(gray.g), g::float_(gray.b)})},
        {"tsl.color(new Color(0.1,0.2,0.3))", g::vec3({g::float_(0.1), g::float_(0.2), g::float_(0.3)})},
        {"tsl.nodeObject(tsl.color(0.1,0.2,0.3))", g::vec3({g::float_(0.1), g::float_(0.2), g::float_(0.3)})},
        {"tsl.reflect(tsl.vec3(1,-1,0),tsl.vec3(0,1,0))", reflected},
        {"tsl.textureLoad(tsl.texture({name:'input'},tsl.uv()),tsl.ivec2(0))", load},
        {"tsl.cameraViewMatrix", g::uniform("viewMatrix", tn::engine::shader::Type::mat(4,4))},
        {"tsl.float(0.25).step(0.5)", g::step(g::float_(0.5), g::float_(0.25))},
        {"tsl.float(0.25).mix(1,2)", g::mix(g::float_(1), g::float_(2), g::float_(0.25))},
        {"tsl.float(0.25).smoothstep(0,1)", g::smoothstep(g::float_(0), g::float_(1), g::float_(0.25))},
        {"tsl.float(0.25).clamp(0,1)", g::clamp(g::float_(0.25), g::float_(0), g::float_(1))},
        {"tsl.screenUV", g::screenUV()},
        {"tsl.materialColor", g::swizzle(g::uniform("diffuse", tn::engine::shader::Type::vec(4)), "xyz")},
        {"tsl.materialEmissive", g::uniform("emissive", tn::engine::shader::Type::vec(3))},
        {"tsl.materialMetalness", g::uniform("metalness", tn::engine::shader::Type::f32())},
        {"tsl.materialRoughness", g::uniform("roughness", tn::engine::shader::Type::f32())},
        {"tsl.vec4(1,0.5,0.25,1).rgb", g::swizzle(g::vec4({g::float_(1),g::float_(0.5),g::float_(0.25),g::float_(1)}), "xyz")},
    }) {
        const std::string source = "(() => {const m=new MeshBasicNodeMaterial();m.colorNode=" + expression + ";return m;})()";
        v8::TryCatch caught(rt.isolate);
        v8::Local<v8::Script> script;
        v8::Local<v8::Value> result;
        const bool ran = v8::Script::Compile(ctx, v8::String::NewFromUtf8(rt.isolate, source.c_str()).ToLocalChecked()).ToLocal(&script) && script->Run(ctx).ToLocal(&result);
        CHECK(ran);
        if (!ran) continue;
        tn_handle_t material{};
        CHECK(adapter.unwrap(result, material));
        const auto actual = tn::abi::shaderNode(material, "colorNode");
        CHECK(g::key(actual) == g::key(expected));
        tn::engine::shader::Program program(tn::engine::shader::Stage::Fragment);
        tn::engine::shader::tsl::Build build(program);
        CHECK(g::lower(actual, program) != tn::engine::shader::kInvalid);
        CHECK(program.diagnostics().empty());
    }

    // Midway's node set through a basic material: varying(node) and normalWorld are written by the
    // vertex stage it links, never read as vertex attributes; the camera accessors are uniforms.
    v8::Local<v8::Value> made;
    const bool ran = v8::Script::Compile(ctx, v8::String::NewFromUtf8Literal(rt.isolate, R"JS((() => {
        const m = new MeshBasicNodeMaterial();
        const world = tsl.varying(tsl.positionGeometry.mul(2), 'world');
        m.colorNode = tsl.vec4(world.add(tsl.normalWorld).add(tsl.cameraPosition),
            tsl.cameraWorldMatrix.mul(tsl.cameraProjectionMatrix.mul(tsl.vec4(world, 1))).x);
        return m;
    })())JS")).ToLocalChecked()->Run(ctx).ToLocal(&made);
    CHECK(ran);
    tn_handle_t basic{};
    if (ran && adapter.unwrap(made, basic)) {
        namespace s = tn::engine::shader;
        s::VertexVariant variant;
        variant.nodes.colorNode = tn::abi::shaderNode(basic, "colorNode");
        const auto programs = s::buildBasic(variant);
        CHECK(programs.diagnostics.empty() && programs.vertex.ok() && programs.fragment.ok());
        const std::string vertex = programs.vertex.dump(true), fragment = programs.fragment.dump(true);
        for (const char* name : {"world", "normalView"}) {
            CHECK(vertex.find(std::string("output ") + name + " =") != std::string::npos);
            CHECK(vertex.find(std::string("attribute:") + name) == std::string::npos);
        }
        CHECK(vertex.find("mul(attribute:position:vec3<f32>, 2f:f32)") != std::string::npos);
        for (const char* uniform : {"cameraPosition:vec3", "cameraWorldMatrix:mat4x4", "cameraProjectionMatrix:mat4x4", "viewMatrix:mat4x4"})
            CHECK(fragment.find(std::string("uniform:") + uniform) != std::string::npos);
        CHECK(s::WgslEmitter::emit(programs.vertex).ok() && s::WgslEmitter::emit(programs.fragment, 1).ok());
        if (vertex.find("attribute:world") != std::string::npos || vertex.find("output world =") == std::string::npos)
            std::fprintf(stderr, "TSL basic vertex:\n%s\n", vertex.c_str());
    } else CHECK(false);

    // The templates' rim light (render/backlightMaterial.ts): normalView and positionViewDirection are
    // nodes, and cameraViewMatrix.transformDirection(direction) is three's normalize((M * vec4(d, 0)).xyz).
    v8::Local<v8::Value> rim;
    const bool rimRan = v8::Script::Compile(ctx, v8::String::NewFromUtf8Literal(rt.isolate, R"JS((() => {
        const m = new MeshStandardNodeMaterial();
        const N = tsl.normalView.normalize(), V = tsl.positionViewDirection.normalize();
        const L = tsl.cameraViewMatrix.transformDirection(tsl.uniform(new Vector3(0, 1, 0)));
        const T = tsl.transformDirection(tsl.vec3(1, 0, 0), tsl.cameraViewMatrix);
        // materialColor is three's vec3 colour: the rim tints by it and mixes it as reflectance.
        const reflectance = tsl.mix(tsl.vec3(0.04), tsl.materialColor, tsl.materialMetalness);
        m.emissiveNode = tsl.vec3(tsl.dot(N, V)).mul(tsl.dot(L, N)).add(T)
            .mul(tsl.clamp(tsl.materialColor, 0, 1)).add(reflectance).add(tsl.materialEmissive);
        return m;
    })())JS")).ToLocalChecked()->Run(ctx).ToLocal(&rim);
    CHECK(rimRan);
    tn_handle_t rimMaterial{};
    if (rimRan && adapter.unwrap(rim, rimMaterial)) {
        namespace s = tn::engine::shader;
        s::VertexVariant variant;
        variant.nodes.emissiveNode = tn::abi::shaderNode(rimMaterial, "emissiveNode");
        const auto programs = s::buildStandard(s::StandardMaterial{}, variant);
        CHECK(programs.diagnostics.empty() && programs.vertex.ok() && programs.fragment.ok());
        const std::string fragment = programs.fragment.dump(true);
        CHECK(fragment.find("varying:normalView") != std::string::npos);
        CHECK(fragment.find("varying:positionView") != std::string::npos);
        CHECK(s::WgslEmitter::emit(programs.vertex).ok() && s::WgslEmitter::emit(programs.fragment, 1).ok());
    } else CHECK(false);

    // Two different nodes under one explicit varying name are refused, not silently merged.
    v8::Local<v8::Value> clash;
    CHECK(v8::Script::Compile(ctx, v8::String::NewFromUtf8Literal(rt.isolate, R"JS((() => {
        const m = new MeshBasicNodeMaterial();
        m.colorNode = tsl.vec4(tsl.varying(tsl.positionGeometry, 'dup').add(tsl.varying(tsl.positionGeometry.mul(2), 'dup')), 1);
        return m;
    })())JS")).ToLocalChecked()->Run(ctx).ToLocal(&clash));
    tn_handle_t clashing{};
    CHECK(adapter.unwrap(clash, clashing));
    namespace s = tn::engine::shader;
    s::VertexVariant clashVariant;
    clashVariant.nodes.colorNode = tn::abi::shaderNode(clashing, "colorNode");
    std::string refused;
    try { s::buildBasic(clashVariant); } catch (const std::runtime_error& error) { refused = error.what(); }
    CHECK(refused == "TN_TSL_VARYING_CONFLICT: dup");

    // An instanced basic material's normalView goes through the instance matrix, as a lit one's does.
    s::VertexVariant instanced;
    instanced.instanced = true;
    uint64_t serial = 0;
    instanced.nodes.colorNode = g::vec4({tn::abi::tslCall("normalWorld", nullptr, {}, serial), g::float_(1)});
    const auto instancedPrograms = s::buildBasic(instanced);
    const std::string instancedVertex = instancedPrograms.vertex.dump(true);
    const auto normalOutput = instancedVertex.find("output normalView =");
    CHECK(normalOutput != std::string::npos &&
          instancedVertex.find("instanceMatrix0", normalOutput) != std::string::npos);
    CHECK(instancedPrograms.vertex.ok() && s::WgslEmitter::emit(instancedPrograms.vertex).ok());
}

// PRD-531 slice 3: the real V8 material setter owns a graph after its JS wrapper is gone.
void nodeMaterials() {
    Runtime& rt = runtime();
    v8::Isolate::Scope isolateScope(rt.isolate);
    Adapter adapter(rt.isolate, rt.context);
    const std::string got = run(rt, adapter, R"JS(
        (() => {
            for (const C of [MeshBasicNodeMaterial, MeshStandardNodeMaterial]) {
                const m = new C();
                if (m.type !== C.name || m.colorNode !== null) return 'defaults';
                const geometry = new PlaneGeometry();
                for (const M of [Mesh, InstancedMesh, SkinnedMesh]) {
                    const mesh = new M(geometry, m, 1);
                    if (mesh.material !== m) return 'mesh material identity';
                    const replacement = new MeshStandardNodeMaterial();
                    mesh.material = replacement;
                    if (mesh.material !== replacement) return 'mesh material replacement';
                    let refused = false;
                    try { mesh.material = geometry; } catch (e) { refused = e instanceof TypeError; }
                    if (!refused || mesh.material !== replacement) return 'mesh material validation';
                    try { new M(geometry, geometry, 1); return 'constructor validation'; }
                    catch (e) { if (!(e instanceof TypeError)) return 'constructor error type'; }
                }
                const n = tsl.vec4(tsl.uv(), tsl.uniform(0.35).setName('tint'), 1);
                m.colorNode = n;
                if (m.colorNode !== n) return 'identity';
                m.positionNode = tsl.positionLocal.add(tsl.vec3(0, 0, 0.2));
                m.normalNode = tsl.vec3(0, 0, 1);
                m.opacityNode = tsl.float(0.4);
                if (C === MeshStandardNodeMaterial) {
                    m.roughnessNode = tsl.uv().x;
                    m.metalnessNode = tsl.uv().y;
                    m.emissiveNode = tsl.vec3(0.1);
                }
                let refused = false;
                try { m.colorNode = new Vector3(); } catch (e) { refused = e instanceof TypeError; }
                if (!refused || m.colorNode !== n) return 'validation';
                m.colorNode = null;
                if (m.colorNode !== null) return 'clear';
            }
            // three's Material.copy: a node material takes a plain material's values, keeping its class and id.
            const source = new MeshStandardMaterial({ color: 0x336699, roughness: 0.25, metalness: 0.75, transparent: true, side: DoubleSide });
            source.map = new DataTexture(new Uint8Array(4), 1, 1);
            source.name = 'hull';
            const target = new MeshStandardNodeMaterial();
            const targetId = target.id;
            // three's Material.dispose(): callable on every material, and the material stays usable after it.
            source.dispose();
            if (source.roughness !== 0.25) return 'dispose keeps the material';
            if (target.copy(source) !== target) return 'copy chains';
            if (target.type !== 'MeshStandardNodeMaterial' || target.id !== targetId) return 'copy identity';
            if (target.color.getHex() !== 0x336699 || target.roughness !== 0.25 || target.metalness !== 0.75 ||
                !target.transparent || target.side !== DoubleSide || target.map !== source.map || target.name !== 'hull')
                return 'copy values';
            const held = new MeshBasicNodeMaterial();
            (() => { held.colorNode = tsl.vec4(tsl.uv(), tsl.uniform(0.35), 1); })();
            gc(); gc();
            if (!held.colorNode || !held.colorNode.xyz) return 'graph lifetime';
            return 'ok';
        })()
    )JS");
    CHECK(got == "ok");
    if (got != "ok") std::fprintf(stderr, "NodeMaterials got %s\n", got.c_str());
}

// PRD-531 box 41: a JS-to-native cycle through a captured callback is reclaimed at a safe point.
// The closure set as mesh.onBeforeRender captures the mesh's own wrapper; while the mesh is in the
// scene the safe point holds the wrapper so the engine can still call it, and once the mesh leaves
// the scene the wrapper, the closure and the native mesh are all reclaimed.
void callbackCycle() {
    Runtime& rt = runtime();
    v8::Isolate::Scope isolateScope(rt.isolate);
    Adapter adapter(rt.isolate, rt.context);
    v8::HandleScope scope(rt.isolate);
    v8::Local<v8::Context> ctx = v8::Context::New(rt.isolate);
    v8::Context::Scope contextScope(ctx);
    adapter.install(ctx, ctx->Global());
    const auto js = [&](const char* source) {
        v8::TryCatch tryCatch(rt.isolate);
        v8::Local<v8::Value> result;
        if (!v8::Script::Compile(ctx, v8::String::NewFromUtf8(rt.isolate, source).ToLocalChecked())
                 .ToLocalChecked()
                 ->Run(ctx)
                 .ToLocal(&result)) {
            v8::String::Utf8Value error(rt.isolate, tryCatch.Exception());
            return std::string("THROWN ") + (*error ? *error : "?");
        }
        v8::String::Utf8Value text(rt.isolate, result);
        return std::string(*text ? *text : "");
    };
    tn_handle_t mesh{}, scene{}, camera{};
    {
        v8::HandleScope inner(rt.isolate);
        v8::Local<v8::Value> made = v8::Script::Compile(ctx, v8::String::NewFromUtf8Literal(rt.isolate, R"JS(
            globalThis.scene = new Scene();
            globalThis.camera = new PerspectiveCamera();
            globalThis.calls = 0;
            (function () {
                const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
                mesh.onBeforeRender = function (renderer, scene, camera, geometry, material, group) {
                    calls++;
                    globalThis.seen = [renderer === null, scene === globalThis.scene, camera === globalThis.camera,
                                       geometry === mesh.geometry, material === mesh.material, group === null, this === mesh].join();
                    if (globalThis.fail) throw new Error("boom");
                };
                scene.add(mesh);
                return mesh;
            })();
        )JS")).ToLocalChecked()->Run(ctx).ToLocalChecked();
        CHECK(adapter.unwrap(made, mesh));
        CHECK(adapter.unwrap(ctx->Global()->Get(ctx, v8::String::NewFromUtf8Literal(rt.isolate, "scene")).ToLocalChecked(), scene));
        CHECK(adapter.unwrap(ctx->Global()->Get(ctx, v8::String::NewFromUtf8Literal(rt.isolate, "camera")).ToLocalChecked(), camera));
    }
    // The engine's call, as RenderDatabase makes it before the mesh is drawn.
    const auto render = [&](std::string& error) {
        auto* object = static_cast<tn::engine::Object3D*>(tn::abi::objectOf(mesh)->ptr.get());
        auto* meshNode = static_cast<tn::engine::Mesh*>(object);
        const tn::engine::RenderCallbackArgs args{static_cast<tn::engine::Object3D*>(tn::abi::objectOf(scene)->ptr.get()),
                                                  static_cast<tn::engine::Object3D*>(tn::abi::objectOf(camera)->ptr.get()),
                                                  meshNode->geometry, meshNode->material};
        return object->onBeforeRender && (*object->onBeforeRender)(args, error);
    };

    // In the scene, with no JS reference but its own closure: held across a safe point and GCs.
    adapter.collect();
    for (int i = 0; i < 4; ++i) rt.isolate->LowMemoryNotification();
    std::string error;
    CHECK(tn::abi::objectOf(mesh) != nullptr);
    CHECK(render(error));
    CHECK(js("calls") == "1");
    CHECK(js("seen") == "true,true,true,true,true,true,true");
    js("globalThis.fail = true");
    CHECK(!render(error) && error.find("boom") != std::string::npos);  // a throw is a status
    js("globalThis.fail = false");

    // Out of the scene: the cycle is garbage, and reclaiming it releases the native mesh.
    CHECK(js("scene.clear(); 'ok'") == "ok");
    const size_t before = adapter.liveWrappers();
    adapter.collect();
    for (int i = 0; i < 4; ++i) rt.isolate->LowMemoryNotification();
    CHECK(adapter.liveWrappers() < before);
    CHECK(tn::abi::objectOf(mesh) == nullptr);
    tn_value_t result{};
    tn_diagnostic_t d{nullptr, 0};
    CHECK(tn_get(mesh, "visible", &result, &d) == TN_ERROR_INVALID_HANDLE);
    tn_diagnostic_release(&d);
}

// A wrapper the engine still references keeps its JS state through full collections: a parent, a
// material slot or a mesh's geometry reaches it, the JS reference is gone, and the next access
// returns the same object. Without the engine's reference it is collected and releases its object.
void wrapperLifetime() {
    Runtime& rt = runtime();
    v8::Isolate::Scope isolateScope(rt.isolate);
    Adapter adapter(rt.isolate, rt.context);
    v8::HandleScope scope(rt.isolate);
    v8::Local<v8::Context> ctx = v8::Context::New(rt.isolate);
    v8::Context::Scope contextScope(ctx);
    adapter.install(ctx, ctx->Global());
    const auto js = [&](const char* source) {
        v8::TryCatch tryCatch(rt.isolate);
        v8::Local<v8::Value> result;
        if (!v8::Script::Compile(ctx, v8::String::NewFromUtf8(rt.isolate, source).ToLocalChecked())
                 .ToLocalChecked()
                 ->Run(ctx)
                 .ToLocal(&result)) {
            v8::String::Utf8Value error(rt.isolate, tryCatch.Exception());
            return std::string("THROWN ") + (*error ? *error : "?");
        }
        v8::String::Utf8Value text(rt.isolate, result);
        return std::string(*text ? *text : "");
    };
    const auto gc = [&] { for (int i = 0; i < 4; ++i) rt.isolate->LowMemoryNotification(); };
    // The WeakMap stands in for core-three's userData bags and authored attribute names and for the
    // texture sources: each is keyed by the wrapper, so a new wrapper finds nothing.
    const std::string setup = js(R"JS(
        globalThis.bags = new WeakMap();
        globalThis.scene = new Group();
        class Voice extends Object3D { constructor() { super(); this.cue = 7; } }
        globalThis.Voice = Voice;
        (() => {
            const child = new Object3D(); child.name = 'child'; child.hp = 3; bags.set(child, { hp: 3 });
            scene.add(child);
            const voice = new Voice(); voice.name = 'voice'; scene.add(voice);
            const map = new Texture(); map.label = 'albedo'; bags.set(map, 'sources');
            const geometry = new BoxGeometry(1, 1, 1); bags.set(geometry, 'authored');
            const material = new MeshBasicMaterial(); material.map = map;
            const mesh = new Mesh(geometry, material); mesh.name = 'mesh';
            scene.add(mesh);
        })();
        'ok'
    )JS");
    if (setup != "ok") std::fprintf(stderr, "setup: %s\n", setup.c_str());
    CHECK(setup == "ok");
    adapter.collect();
    gc();
    const std::string kept = js(R"JS((() => {
        const child = scene.getObjectByName('child'), voice = scene.getObjectByName('voice');
        const mesh = scene.getObjectByName('mesh');
        return [child.hp, bags.get(child)?.hp, voice instanceof Voice, voice.cue,
                mesh.material.map.label, bags.get(mesh.material.map), bags.get(mesh.geometry)].join();
    })())JS");
    if (kept != "3,3,true,7,albedo,sources,authored") std::fprintf(stderr, "kept: %s\n", kept.c_str());
    CHECK(kept == "3,3,true,7,albedo,sources,authored");

    // Added and dropped in one tick, with no safe point before the collection: the GC prologue holds it.
    CHECK(js("(() => { const v = new Voice(); v.name = 'late'; v.cue = 9; scene.add(v); })(); 'ok'") == "ok");
    gc();
    CHECK(js("(() => { const late = scene.getObjectByName('late'); return [late instanceof Voice, late.cue].join(); })()") == "true,9");

    // Detached and unreachable from JS: the subtree is collected, and each wrapper releases its object.
    tn_handle_t root{};
    {
        v8::HandleScope inner(rt.isolate);
        CHECK(adapter.unwrap(ctx->Global()->Get(ctx, v8::String::NewFromUtf8Literal(rt.isolate, "scene")).ToLocalChecked(), root));
    }
    CHECK(js("globalThis.scene = null; 'ok'") == "ok");
    for (int i = 0; i < 4; ++i) {
        adapter.collect();
        gc();
    }
    CHECK(tn::abi::objectOf(root) == nullptr);
    if (adapter.liveWrappers() > 2) std::fprintf(stderr, "live wrappers: %zu\n", adapter.liveWrappers());
    CHECK(adapter.liveWrappers() <= 2);
}

void raycasterLOD() {
    Runtime& rt = runtime();
    v8::Isolate::Scope isolateScope(rt.isolate);
    Adapter adapter(rt.isolate, rt.context);
    const std::string result = run(rt, adapter, R"JS(
      (() => {
        let checks = 0; const assert = (v) => { checks++; if (!v) throw Error('raycaster/LOD binding differs at check ' + checks); };
        const g = new BoxGeometry();
        const m = new MeshBasicMaterial(); m.side = 2;
        const mesh = new Mesh(g, m);
        const root = new Group(); const inner = new Group(); root.add(inner); inner.add(mesh);
        root.updateMatrixWorld(true);
        const r = new Raycaster(new Vector3(0.2, -0.3, 5), new Vector3(0,0,-1));
        const hits = r.intersectObject(root);
        assert(hits.length === 2 && hits[0].object === mesh && hits[0].distance === 4.5);
        assert(hits[0].point instanceof Vector3 && hits[0].uv instanceof Vector2);
        assert(hits[0].normal instanceof Vector3 && hits[0].face.normal instanceof Vector3);
        assert(hits[0].faceIndex >= 0 && hits[0].barycoord instanceof Vector3);
        assert(r.ray instanceof Ray && r.ray === r.ray && r.ray.origin.z === 5);
        assert(r.intersectObjects([root]).length === 2 && r.intersectObjects([]).length === 0);
        const target = [hits[1]];
        assert(r.intersectObject(root, true, target) === target && target.length === 3 && target[0].distance === 4.5);
        assert(r.intersectObject(root, false).length === 0);
        r.near = 5; assert(r.intersectObject(root).length === 1);
        r.far = 5.1; assert(r.intersectObject(root).length === 0);
        r.near = 0; r.far = Infinity; r.layers.set(2);
        assert(r.intersectObject(root).length === 0);
        mesh.layers.enable(2); assert(r.intersectObject(root).length === 2);
        assert(r.layers.test(mesh.layers));
        r.layers.enableAll(); assert(r.layers.mask===-1);
        r.layers.set(31); assert(r.layers.mask===2147483648);
        r.layers.enable(0); assert(r.layers.mask===-2147483647);
        r.layers.mask=Infinity; assert(r.layers.mask===Infinity && !r.layers.isEnabled(0));
        const bone = new Bone(); const inverse = new Matrix4().makeTranslation(1,2,3);
        const skeleton = new Skeleton([bone],[inverse]); skeleton.update();
        assert(skeleton.boneMatrices.length===16 && skeleton.boneMatrices[12]===1);
        assert(new Skeleton([]).boneMatrices.length===0);
        let frozenRejected=false;
        try { r.layers.set(2); r.intersectObject(root,true,Object.freeze([])); } catch { frozenRejected=true; }
        assert(frozenRejected);
        let getterRejected=false;
        const throwing = [{get distance() {throw Error('distance failed');}}];
        try { r.intersectObject(root,true,throwing); } catch { getterRejected=true; }
        assert(getterRejected);
        let prototypeSafe = false;
        Object.defineProperty(Array.prototype, '0', {set() {throw Error('array prototype setter');}, configurable:true});
        try { prototypeSafe = r.intersectObject(root).length===2; }
        finally { delete Array.prototype[0]; }
        assert(prototypeSafe);
        const miss = new Ray(new Vector3(5,5,5),new Vector3(0,0,1));
        assert(miss.intersectBox(new Box3(new Vector3(-1,-1,-1),new Vector3(1,1,1)),new Vector3())===null);
        const inst = new InstancedMesh(g,m,2); const matrix = new Matrix4();
        inst.setMatrixAt(1,matrix.makeTranslation(3,0,0)); inst.updateMatrixWorld(true);
        r.layers.set(0); r.set(new Vector3(3.2,-0.3,5),new Vector3(0,0,-1));
        const instanceHits = r.intersectObject(inst);
        assert(instanceHits.length===2 && instanceHits[0].instanceId===1 && instanceHits[0].object===inst);
        const lod = new LOD(); const a = new Mesh(g,m); const b = new Mesh(g,m);
        assert(lod.addLevel(b,10,0.2) === lod); lod.addLevel(a,0,0);
        lod.updateMatrixWorld(true);
        const camera = new PerspectiveCamera(); camera.position.z = 20; camera.updateMatrixWorld(true);
        lod.autoUpdate = false; lod.update(camera);
        assert(lod.getCurrentLevel()===1 && !a.visible && b.visible && lod.autoUpdate===false);
        assert(lod.levels[0].object===a && lod.levels[1].distance===10 && lod.levels[1].hysteresis===0.2);
        assert(lod.getObjectForDistance(8) === b && lod.getObjectForDistance(7.99)===a);
        r.set(new Vector3(0.2,-0.3,9),new Vector3(0,0,-1));
        assert(r.intersectObject(lod,false)[0].object===b);
        assert(lod.removeLevel(10) && !lod.removeLevel(10));
        // Malformed arrays fail at the shared binding boundary, rather than returning no hits.
        let rejected=false; try { r.intersectObjects([new Vector3()]); } catch { rejected=true; }
        assert(rejected);
        return 'PASS raycaster/LOD records, vectors, identity, arrays, target, layers, near/far, instances, hysteresis';
      })()
    )JS");
    std::printf("%s\n", result.c_str());
    CHECK(result == "PASS raycaster/LOD records, vectors, identity, arrays, target, layers, near/far, instances, hysteresis");
}

void skeletal() {
    Runtime& rt = runtime();
    v8::Isolate::Scope isolateScope(rt.isolate);
    Adapter adapter(rt.isolate, rt.context);
    v8::HandleScope scope(rt.isolate);
    const auto ctx = v8::Context::New(rt.isolate);
    v8::Context::Scope contextScope(ctx);
    adapter.install(ctx, ctx->Global());
    namespace a = tn::engine::animation;
    const auto clip = std::make_shared<a::AnimationClip>("walk", -1,
        std::vector<a::KeyframeTrack>{a::KeyframeTrack("hip.position", a::TrackType::Vector, {0, 1}, {0,0,0, 1,2,3})});
    const auto handle = tn::abi::shareObject(rt.context, "AnimationClip", clip);
    ctx->Global()->Set(ctx, v8::String::NewFromUtf8Literal(rt.isolate, "nativeClip"), adapter.wrap(handle)).Check();
    v8::TryCatch caught(rt.isolate);
    const char* source = R"JS(
      (() => {
        const check = (ok, name) => { if (!ok) throw Error(name); };
        const root = new Group(); root.name='root';
        const hip = new Bone(); hip.name='hip'; hip.position.y=2; root.add(hip);
        const mesh = new SkinnedMesh(new BoxGeometry(), new MeshStandardMaterial());
        mesh.name='skin'; root.add(mesh); root.updateMatrixWorld(true);
        mesh.bind(new Skeleton([hip])); mesh.bindMode='detached';
        const copy = new SkeletonUtils().clone(root);
        const copyHip = copy.getObjectByName('hip');
        const copyMesh = copy.getObjectByName('skin');
        check(copy instanceof Group && copy !== root, 'clone root');
        check(copyHip instanceof Bone && copyHip !== hip, 'cloned bone');
        check(copyMesh instanceof SkinnedMesh && copyMesh !== mesh, 'cloned mesh');
        check(copyMesh.geometry === mesh.geometry && copyMesh.material === mesh.material, 'shared resources');
        check(copyMesh.skeleton !== mesh.skeleton && copyMesh.skeleton.bones[0] === copyHip, 'skeleton remapping');
        check(mesh.skeleton.bones[0] === hip && copyMesh.bindMode === 'detached', 'source and bind mode');
        check(copyMesh.bindMatrix !== mesh.bindMatrix && copyMesh.bindMatrix.elements.join() === mesh.bindMatrix.elements.join(), 'bind matrices');
        copyHip.position.x=3; copy.updateMatrixWorld(true); copyMesh.skeleton.update();
        mesh.skeleton.update();
        check(hip.position.x===0 && copyMesh.skeleton.boneMatrices[12]===3 && mesh.skeleton.boneMatrices[12]===0, 'independent palette');
        // The engine surface of PropertyBinding; three's statics, targetObject property and console
        // function are the shared facade's, checked through the player in player-imports.mjs.
        const helper = new PropertyBinding();
        check(helper.parseTrackName('hip.position[x]').propertyIndex==='x', 'native track parsing');
        check(helper.findNode(root, 'hip')===hip && helper.findNode(root, undefined)===root, 'native node search');
        const binding=new PropertyBinding(root, 'hip.position');
        check(binding.bind()==='' && binding.targetObject()===hip, 'native track target');
        hip.name='renamed'; binding.bind(); check(binding.targetObject()===hip, 'cached target');
        binding.unbind();
        check(binding.bind().includes('No target node found') && binding.targetObject()===null, 'native rebind diagnostic');
        hip.name='hip';
        const materialBinding=new PropertyBinding(root, 'skin.material.roughness'); materialBinding.bind();
        check(materialBinding.targetObject()===mesh.material, 'native material target');
        const unsupportedBinding=new PropertyBinding(root, 'hip.noSuchProperty');
        check(unsupportedBinding.bind().includes('TN_NATIVE_ANIMATION_PATH_UNSUPPORTED') && unsupportedBinding.targetObject()===null, 'unsupported path diagnostic');
        const external = new Bone(); external.name='external'; mesh.bind(new Skeleton([external]));
        let refused=false; try { new SkeletonUtils().clone(root); } catch(e) { refused=e.message.includes('TN_NATIVE_SKELETON_CLONE_EXTERNAL_BONE: external'); }
        check(refused, 'external bone refusal');
        refused=false; try { new SkeletonUtils().clone(tsl.float(1)); } catch(e) { refused=e instanceof TypeError; }
        check(refused, 'non-scene wrapper refusal');
        check(nativeClip.name==='walk' && nativeClip.duration===1, 'native clip');
        const track=nativeClip.tracks[0];
        check(track.name==='hip.position' && track.ValueTypeName==='vector' && track.times.join()==='0,1' && track.values.join()==='0,0,0,1,2,3', 'clip track reflection');
        // AnimationAction's members and the mixer's EventDispatcher, as core's AnimationPlayer drives them.
        const mixer = new AnimationMixer(root);
        const action = mixer.clipAction(nativeClip);
        check(mixer.getRoot()===root && action.getClip()===nativeClip, 'mixer root and action clip');
        action.setLoop(LoopOnce, 1); action.clampWhenFinished = true; action.play();
        check(action.loop===LoopOnce && action.isScheduled() && action.getEffectiveWeight()===1, 'action state');
        const events = [];
        const onFinished = (event) => events.push(event);
        mixer.addEventListener('finished', onFinished);
        check(mixer.hasEventListener('finished', onFinished), 'listener registered');
        mixer.update(0.5); check(events.length===0 && Math.abs(hip.position.x-0.5)<1e-6, 'no event mid-clip');
        mixer.update(1);
        check(events.length===1 && events[0].type==='finished' && events[0].action===action && events[0].direction===1, 'finished event');
        check(!action.isRunning() && action.time===1, 'clamped at the end');
        mixer.removeEventListener('finished', onFinished);
        check(!mixer.hasEventListener('finished', onFinished), 'listener removed');
        const loops = [];
        mixer.addEventListener('loop', (event) => loops.push(event.loopDelta));
        action.reset(); action.setLoop(LoopRepeat, Infinity); action.play(); mixer.update(1.25);
        check(loops.length===1 && loops[0]===1, 'loop event');
        mixer.addEventListener('loop', () => { throw new Error('listener boom'); });
        let thrown=false; try { mixer.update(1); } catch (e) { thrown=e.message.includes('listener boom'); }
        check(thrown, 'a throwing listener throws from update');
        let custom=null; mixer.addEventListener('custom', (e) => { custom=e.target; }); mixer.dispatchEvent({ type: 'custom' });
        check(custom===mixer, 'dispatchEvent');
        // three's graph events on Object3D (PRD-553): core tracks LOD and clustered meshes with them.
        const graph = []; const parentNode = new Object3D(); const childNode = new Object3D();
        const tag = (o) => o===parentNode ? 'parent' : o===childNode ? 'child' : '?';
        for (const node of [parentNode, childNode]) for (const type of ['added', 'removed', 'childadded', 'childremoved'])
            node.addEventListener(type, (e) => graph.push(e.type + ':' + tag(e.target) + (e.child ? '>' + tag(e.child) : '')));
        parentNode.add(childNode); parentNode.remove(childNode);
        check(graph.join(' ')==='added:child childadded:parent>child removed:child childremoved:parent>child', 'graph events ' + graph.join(' '));
        // A "finished" listener that uncaches its action runs after the update's loops, so the
        // other active action still advances and the loop never reads past the shrunk list.
        const mixer2 = new AnimationMixer(root);
        const once = mixer2.clipAction(nativeClip); once.setLoop(LoopOnce, 1); once.play();
        const clip2 = new AnimationClip('walk2', 1, [new VectorKeyframeTrack('hip.position', [0, 1], [0, 0, 0, 1, 2, 3])]);
        const looping = mixer2.clipAction(clip2); looping.setLoop(LoopRepeat, Infinity); looping.play();
        mixer2.addEventListener('finished', () => mixer2.uncacheAction(nativeClip));
        mixer2.update(1.5);
        check(mixer2.existingAction(nativeClip) === null && Math.abs(looping.time - 0.5) < 1e-9, 'uncache on finished');
        return 'ok';
      })()
    )JS";
    v8::Local<v8::Script> script; v8::Local<v8::Value> result;
    const bool ran = v8::Script::Compile(ctx, v8::String::NewFromUtf8(rt.isolate, source).ToLocalChecked()).ToLocal(&script)
        && script->Run(ctx).ToLocal(&result);
    CHECK(ran);
    if (!ran) { v8::String::Utf8Value error(rt.isolate, caught.Exception()); std::fprintf(stderr, "skeletal: %s\n", *error); }
}

// three's attribute.array is the attribute's own typed array: one object per attribute, of the
// attribute's scalar type, and an element write is what the attribute (and every engine read) holds.
void attributeArrays() {
    Runtime& rt = runtime();
    v8::Isolate::Scope isolateScope(rt.isolate);
    Adapter adapter(rt.isolate, rt.context);
    const std::string got = run(rt, adapter, R"JS(
        const g = new BufferGeometry();
        g.setAttribute("position", new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
        const p = g.getAttribute("position");
        const a = p.array;
        a[3] = 5;
        g.computeBoundingBox();
        const index = new BoxGeometry().getIndex();
        const wide = new BufferAttribute(new Uint32Array([7, 8]), 1);
        wide.array[1] = 9;
        [a instanceof Float32Array, p.array === a, p.getX(1), g.boundingBox.max.x,
         index.array instanceof Uint16Array, index.array.length, wide.array instanceof Uint32Array, wide.getX(1)].join()
    )JS");
    CHECK(got == "true,true,5,5,true,36,true,9");
    if (got != "true,true,5,5,true,36,true,9") std::fprintf(stderr, "attribute arrays: %s\n", got.c_str());
}

// three's geometry.clone() is a deep copy of the same class, dispose() leaves the CPU data usable,
// and morphAttributes reads back the attributes it was given.
void geometryLifecycle() {
    Runtime& rt = runtime();
    v8::Isolate::Scope isolateScope(rt.isolate);
    Adapter adapter(rt.isolate, rt.context);
    const std::string got = run(rt, adapter, R"JS(
        const box = new BoxGeometry(2, 1, 1);
        const target = new Float32BufferAttribute(new Float32Array(72), 3);
        box.morphAttributes.position = [target];
        const copy = box.clone();
        copy.getAttribute("position").setX(0, 9);
        box.dispose();
        const morphs = box.morphAttributes;
        [copy instanceof BoxGeometry, copy.type, copy !== box, box.getAttribute("position").getX(0),
         copy.getAttribute("position").getX(0), copy.getIndex().count, morphs.position.length, morphs.position[0] === target,
         copy.morphAttributes.position.length, copy.morphAttributes.position[0] !== target, morphs.normal.length].join()
    )JS");
    CHECK(got == "true,BoxGeometry,true,1,9,36,1,true,1,true,0");
    if (got != "true,BoxGeometry,true,1,9,36,1,true,1,true,0") std::fprintf(stderr, "geometry lifecycle: %s\n", got.c_str());
}

// three keeps a material's slots as own fields; games find textures with Object.values(material).
void materialSlots() {
    Runtime& rt = runtime();
    v8::Isolate::Scope isolateScope(rt.isolate);
    Adapter adapter(rt.isolate, rt.context);
    const std::string got = run(rt, adapter, R"JS(
        const t = new Texture();
        const m = new MeshStandardMaterial({ map: t });
        [Object.keys(m).includes("map"), Object.values(m).includes(t)].join()
    )JS");
    CHECK(got == "true,true");
    if (got != "true,true") std::fprintf(stderr, "material slots: %s\n", got.c_str());
}

}  // namespace

TN_TEST_MAIN({"handles", handles}, {"fast_paths", fastPaths}, {"unsupported", unsupported}, {"gc_release", gcRelease},
             {"runtime_churn", runtimeChurn},
             {"crossing_bench", crossingBench},
             {"scene", scene}, {"raycaster_lod", raycasterLOD},
             {"catalog_coverage", catalogCoverage},
             {"callback_cycle", callbackCycle}, {"wrapper_lifetime", wrapperLifetime}, {"tsl_api", tslApi}, {"uniform_value", uniformValue}, {"node_materials", nodeMaterials}, {"skeletal", skeletal},
             {"attribute_arrays", attributeArrays}, {"geometry_lifecycle", geometryLifecycle},
             {"material_slots", materialSlots})
