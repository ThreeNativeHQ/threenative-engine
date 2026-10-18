#include "adapters/v8/adapter.h"
#include "check.h"
#include "engine/abi/abi_internal.h"
#include "engine/abi/bindings.h"
#include "engine/abi/tsl_call.h"
#include "engine/animation/mixer.h"
#include "engine/animation/skinning/skeleton.h"
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
#include <functional>
#include <map>
#include <limits>
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
std::string run(Runtime& rt, Adapter& adapter, const char* source,
                const std::function<void(v8::Local<v8::Value>)>& observe = {}) {
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
    if (observe) observe(result);
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
    // Scalar accessor functions currently allow construction; CFunction requires kThrow instead.
    CHECK(run(rt, adapter, "const setter = Object.getOwnPropertyDescriptor(Vector3.prototype, 'x').set;"
                           "new setter(1) instanceof setter") == "true");
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
    // An engine object as an argument (`matrix.copy(other)`, `v.add(w)`, `mesh.add(child)`) crosses on the same
    // stack array: the scene walk makes tens of thousands of these a frame.
    const std::string objectSetup = R"JS(
        const a = new Matrix4(), b = new Matrix4(), v = new Vector3(), w = new Vector3(1, 2, 3);
        const parent = new Object3D(), child = new Object3D();
    )JS";
    const uint64_t setupStart = adapter.genericArguments();
    run(rt, adapter, objectSetup.c_str());
    const uint64_t setupArguments = adapter.genericArguments() - setupStart;
    const uint64_t beforeObjects = adapter.genericArguments();
    const std::string objects = run(rt, adapter, (objectSetup + R"JS(
        for (let i = 0; i < 2000; ++i) { a.copy(b); v.add(w); }
        parent.add(child);
        [a.elements[0] === 1, v.x === 2000, child.parent === parent, parent.children.length === 1]
            .map(Number).join("")
    )JS").c_str());
    CHECK(objects == "1111");
    CHECK(adapter.genericArguments() - beforeObjects == setupArguments);  // 4000 handle-argument calls added none
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

// The stamp core's projection-stability proof asks for: one call hashes what the proof would read
// object by object. It must stay put for what the proof ignores (a move) and change for everything
// it reads, and it must cost a constant number of crossings however large the scene is.
void structureStamp() {
    Runtime& rt = runtime();
    v8::Isolate::Scope isolateScope(rt.isolate);
    Adapter adapter(rt.isolate, rt.context);
    const std::string result = run(rt, adapter, R"JS(
        const scene = new Scene(), geometry = new BoxGeometry(1, 1, 1);
        const a = new MeshBasicMaterial(), b = new MeshBasicMaterial();
        const meshes = [];
        for (let i = 0; i < 64; ++i) { const m = new Mesh(geometry, a); meshes.push(m); scene.add(m); }
        globalThis.stampScene = scene;
        const stamp = () => scene.__tnStructureStamp();
        const base = stamp();
        const out = [];
        const changes = (edit, undo) => { edit(); const moved = stamp() !== base; undo(); return moved && stamp() === base; };
        out.push(stamp() === base);                                          // stable
        meshes[5].position.x = 9; meshes[5].rotation.y = 1; meshes[5].updateMatrixWorld(true);
        out.push(stamp() === base);                                          // a move is not a structure change
        out.push(changes(() => { meshes[7].visible = false; }, () => { meshes[7].visible = true; }));
        out.push(changes(() => { meshes[8].material = b; }, () => { meshes[8].material = a; }));
        out.push(changes(() => { meshes[9].castShadow = true; }, () => { meshes[9].castShadow = false; }));
        out.push(changes(() => { meshes[10].receiveShadow = true; }, () => { meshes[10].receiveShadow = false; }));
        out.push(changes(() => { meshes[11].frustumCulled = false; }, () => { meshes[11].frustumCulled = true; }));
        out.push(changes(() => { meshes[12].renderOrder = 3; }, () => { meshes[12].renderOrder = 0; }));
        out.push(changes(() => { meshes[13].layers.mask = 2; }, () => { meshes[13].layers.mask = 1; }));
        out.push(changes(() => { meshes[14].geometry = new BoxGeometry(2, 2, 2); }, () => { meshes[14].geometry = geometry; }));
        out.push(changes(() => { scene.remove(meshes[15]); }, () => { scene.add(meshes[15]); }) === false); // re-add reorders: the walk order changed
        const group = new Group(), inner = new Mesh(geometry, a); group.add(inner); scene.add(group);
        const grouped = stamp();
        inner.visible = false;
        out.push(stamp() !== grouped);                                       // a child of a plain group is walked
        inner.visible = true;
        const lod = new LOD(), level = new Mesh(geometry, a); lod.addLevel(level, 0); scene.add(lod);
        const withLod = stamp();
        level.visible = false;
        out.push(stamp() === withLod);                                       // the proof does not walk into a LOD
        out.map(Number).join("")
    )JS");
    CHECK(result == "1111111111111");
    if (result != "1111111111111") std::fprintf(stderr, "stamp %s\n", result.c_str());
    // Ancestor visibility in one call: false under any hidden ancestor, and after it is shown again true.
    const std::string visible = run(rt, adapter, R"JS(
        const root = new Group(), mid = new Group(), leaf = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
        root.add(mid); mid.add(leaf);
        const out = [leaf.__tnVisibleInWorld()];
        mid.visible = false; out.push(leaf.__tnVisibleInWorld(), mid.__tnVisibleInWorld());
        mid.visible = true; root.visible = false; out.push(leaf.__tnVisibleInWorld());
        root.visible = true; leaf.visible = false; out.push(leaf.__tnVisibleInWorld(), mid.__tnVisibleInWorld());
        out.map(Number).join("")
    )JS");
    CHECK(visible == "1000" "01");
    // One call, however many meshes it covers.
    const uint64_t before = tn::abi::crossings();
    run(rt, adapter, "globalThis.stampScene.__tnStructureStamp()");
    CHECK(tn::abi::crossings() - before <= 2);
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
    // Supported TSL functions live on the TSL module, rather than the class/constant globals.
    const std::set<std::string> tslFunctions = {"atomicAdd", "atomicStore", "lightShadowMatrix", "rtt"};
    v8::Local<v8::Value> tsl;
    CHECK(global->Get(ctx, key("tsl")).ToLocal(&tsl) && tsl->IsObject());
    for (const auto& name : tslFunctions) {
        v8::Local<v8::Value> value;
        CHECK(tsl.As<v8::Object>()->Get(ctx, key(name)).ToLocal(&value) && value->IsFunction());
    }
    CHECK(installed.size() + tableConstants.size() + recordTypes.size() + enums.size() + tslFunctions.size() ==
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
        // Object3D.raycast is the adapter's own JavaScript over Raycaster.intersectObject (it pushes onto the
        // caller's array), so no registry method stands behind it.
        if (binding.methods.count("worldToLocal")) expected.insert("raycast");
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
    std::vector<std::vector<double>> before;
    for (const auto& [name, lanes] : values) before.push_back(lanes);
    CHECK((before == std::vector<std::vector<double>>{{0}, {1, 2}}) || (before == std::vector<std::vector<double>>{{1, 2}, {0}}));
    evaluate("tsl.setUniform(clock, 0.5); tsl.setUniform(origin, 3, 4); 0");
    std::vector<std::vector<double>> after;
    for (const auto& [name, lanes] : g::uniforms(graph)) after.push_back(lanes);
    CHECK((after == std::vector<std::vector<double>>{{0.5f}, {3, 4}}) || (after == std::vector<std::vector<double>>{{3, 4}, {0.5f}}));
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
            // Fn builds per call, not at definition: nothing runs until it is called, and each call is its own graph.
            const checks = [calls === 0, fn() !== fn(), calls === 2];
            const bad = (body) => {
                try { body(); return false; } catch (e) { return e instanceof TypeError && e.message.startsWith('TN_TSL'); }
            };
            checks.push(bad(() => float({})), bad(() => float(NaN)), bad(() => uint(-1)),
                bad(() => uniform(vec3(1)).setName('')), bad(() => instancedArray(0, 'vec4')),
                bad(() => float(0).toVar()), bad(() => float(0).assign(1)),
                bad(() => Fn(() => Loop(1.5, () => {}))()),
                bad(() => Fn(() => If(float(0).equal(0), 7))()));
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
            checks.push(nested() !== nested(), bad(() => float(1).add.call(new Vector3(), 2)));
            return checks.map(Number).join('');
        })()
    )JS");
    CHECK(got == "111111111111111111");
    if (got != "111111111111111111") std::fprintf(stderr, "TSL API got %s\n", got.c_str());

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
    const std::string post = run(rt, adapter, R"JS(
        (() => {
            const Pair = tsl.struct('Pair', 'first', 'float', 'second', 'float');
            const value = tsl.Fn(() => {
                const local = tsl.float(0).toVar();
                local.addAssign(1);
                return Pair.newStruct(local, local);
            })();
            const first = value.get('first'), second = value.get('second');
            const output = tsl.renderOutput(tsl.vec4(first, second, first, second), 4, 'srgb');
            const linear = output.renderOutput(0, 'srgb-linear');
            return linear !== output && tsl.pipelineOutput(linear, 0) !== linear;
        })()
    )JS");
    CHECK(post == "true");
    if (post != "true") std::fprintf(stderr, "Post API got %s\n", post.c_str());

}

void fogNode() {
    Runtime& rt = runtime();
    v8::Isolate::Scope isolateScope(rt.isolate);
    Adapter adapter(rt.isolate, rt.context);
    const std::string got = run(rt, adapter, R"JS(
        const scene = new Scene();
        const node = tsl.vec4(tsl.uniform(new Color(0.1, 0.2, 0.3)), tsl.float(0.5));
        try { scene.fogNode = node; } catch (e) { throw new Error('fog assignment: ' + e.message); }
        if (scene.fogNode !== node) throw new Error('fog getter');
        let refused = false;
        try { scene.fogNode = new Color(); } catch (e) { refused = e instanceof TypeError; }
        if (!refused || scene.fogNode !== node) throw new Error('fog validation');
        scene.fogNode = null;
        if (scene.fogNode !== null) throw new Error('fog clear');
        scene.fogNode = node;
        scene
    )JS", [&](v8::Local<v8::Value> result) {
        tn_handle_t handle{};
        CHECK(adapter.unwrap(result, handle));
        const auto* object = tn::abi::objectOf(handle);
        CHECK(object && static_cast<tn::engine::Scene*>(object->ptr.get())->fogNode);
    });
    std::printf("fog_node: %s\n", got.c_str());
    CHECK(got == "[object Object]");
}

void nodeMaterialFragment() {
    Runtime& rt = runtime();
    v8::Isolate::Scope isolateScope(rt.isolate);
    Adapter adapter(rt.isolate, rt.context);
    const std::string got = run(rt, adapter, R"JS(
        (() => {
            for (const C of [NodeMaterial, MeshBasicNodeMaterial, MeshStandardNodeMaterial, SpriteNodeMaterial]) {
                const material = new C();
                const node = tsl.vec4(1, 0, 0, 1);
                try { material.fragmentNode = node; }
                catch (e) { throw new Error(C.name + ' fragment assignment: ' + e.message); }
                if (material.fragmentNode !== node) throw new Error(C.name + ' fragment getter');
                let refused = false;
                try { material.fragmentNode = new Color(); } catch (e) { refused = e instanceof TypeError; }
                if (!refused || material.fragmentNode !== node) throw new Error(C.name + ' fragment validation');
                const mesh = new Mesh(new PlaneGeometry(), material);
                if (mesh.material !== material) throw new Error(C.name + ' mesh material');
                material.fragmentNode = null;
                if (material.fragmentNode !== null) throw new Error(C.name + ' fragment clear');
            }
            return 'ok';
        })()
    )JS");
    std::printf("node_material_fragment: %s\n", got.c_str());
    CHECK(got == "ok");
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

// PRD-573 v1.11 step 1: a safe point decides only for wrappers made or held by a call since the last one,
// unless the engine's ownership moved. A steady frame (numbers written, matrices updated, objects read) over
// 25,000 held wrappers looks at none; a change of who owns what still reaches the wrapper it concerns.
void collectVisits() {
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
    CHECK(js(R"JS(
        globalThis.scene = new Group();
        for (let i = 0; i < 25000; ++i) { const o = new Object3D(); o.hp = i; scene.add(o); }
        'ok'
    )JS") == "ok");
    adapter.collect();
    CHECK(adapter.liveWrappers() >= 25000);
    // Warm the member wrappers a frame touches, then settle.
    const char* frame = R"JS((() => {
        const kids = scene.children;
        for (let i = 0; i < kids.length; i += 7) { const k = kids[i]; k.position.x = i; k.position.y = 1; k.rotation.z = 0.5; k.visible = true; }
        scene.updateMatrixWorld(true);
        return kids.length;
    })())JS";
    CHECK(js(frame) == "25000");
    adapter.collect();
    adapter.collect();
    // The steady frame.
    const uint64_t before = adapter.collectVisits();
    const std::string steadyResult = js(frame);
    if (steadyResult != "25000") std::fprintf(stderr, "steady frame: %s\n", steadyResult.c_str());
    CHECK(steadyResult == "25000");
    adapter.collect();
    const uint64_t steady = adapter.collectVisits() - before;
    if (steady != 0) std::fprintf(stderr, "a steady frame visited %llu wrappers\n", (unsigned long long)steady);
    CHECK(steady == 0);

    // A change of ownership is not missed. Removed with the object as the argument:
    CHECK(js("globalThis.child = scene.children[10]; child.hp = 5; scene.remove(child); globalThis.child = null; 'ok'") == "ok");
    const size_t held = adapter.liveWrappers();
    adapter.collect();
    gc();
    adapter.collect();
    CHECK(adapter.liveWrappers() < held);  // the removed child's wrapper went weak and was collected
    // ... and cleared with no argument at all: every child lets go.
    CHECK(js("scene.clear(); 'ok'") == "ok");
    adapter.collect();
    gc();
    adapter.collect();
    if (adapter.liveWrappers() > 200) std::fprintf(stderr, "live wrappers after clear: %zu\n", adapter.liveWrappers());
    CHECK(adapter.liveWrappers() < 200);
    // An object the engine holds keeps its JS state through collections that follow a change elsewhere.
    CHECK(js(R"JS(
        (() => { const keep = new Object3D(); keep.name = 'keep'; keep.hp = 9; scene.add(keep); })();
        'ok'
    )JS") == "ok");
    adapter.collect();
    gc();
    adapter.collect();
    CHECK(js("(() => { const k = scene.getObjectByName('keep'); return k.hp; })()") == "9");
}

// The world-matrix walk core's MatrixWorldPass asks for: one call walks the whole tree, so its crossings do not grow
// with the node count, it answers the nodes it covered, and the matrices are the ones updateMatrixWorld gives.
void nativeMatrixWorld() {
    Runtime& rt = runtime();
    v8::Isolate::Scope isolateScope(rt.isolate);
    Adapter adapter(rt.isolate, rt.context);
    uint64_t crossed[2] = {};
    int slot = 0;
    for (const int groups : {500, 2000}) {  // 1,001 and 4,001 nodes: a scene, then a group and a mesh in it for each
        const std::string build = "const scene = new Scene(), geometry = new BoxGeometry(1, 1, 1), material = new MeshBasicMaterial();"
            "for (let i = 0; i < " + std::to_string(groups) + "; ++i) { const g = new Group(); g.position.set(i, 1, 2);"
            " const m = new Mesh(geometry, material); m.position.x = 5; g.add(m); scene.add(g); }"
            "const last = scene.children[scene.children.length - 1].children[0];"
            "const where = () => { const e = last.matrixWorld.elements; return [e[12], e[13], e[14]].join(); };";
        // Each run is a fresh context, so the walk's cost is the difference between a run with it and one without.
        const uint64_t base = tn::abi::crossings();
        run(rt, adapter, (build + "where()").c_str());
        const uint64_t built = tn::abi::crossings() - base;
        const uint64_t before = tn::abi::crossings();
        // The walk covers every node, and leaves the matrices where the plain walk puts them: x = group index + 5.
        const std::string answer = run(rt, adapter, (build + "const n = scene.__tnUpdateMatrixWorld(true); const native = where();"
            "scene.updateMatrixWorld(true); n + '|' + native + '|' + where()").c_str());
        crossed[slot] = (tn::abi::crossings() - before) - built;
        const std::string expected = std::to_string(groups - 1 + 5) + ",1,2";
        CHECK(answer == std::to_string(2 * groups + 1) + "|" + expected + "|" + expected);
        if (answer != std::to_string(2 * groups + 1) + "|" + expected + "|" + expected) std::fprintf(stderr, "walk answered %s\n", answer.c_str());
        ++slot;
    }
    std::printf("native matrix walk: %llu extra crossings at 1,001 nodes, %llu at 4,001 (answer, two reads, a plain walk)\n",
                (unsigned long long)crossed[0], (unsigned long long)crossed[1]);
    CHECK(crossed[0] == crossed[1]);  // the same crossings for 1,001 and 4,001 nodes
    CHECK(crossed[0] <= 16);          // the walk, two reads of three numbers and a plain walk: no more
}

// The host projection seam core's SceneRenderProjection asks for (PRD-573 v1.11 step 3): one call answers what the
// renderer's own batching makes of the scene, so a frame's crossings do not grow with the cube count, and the
// verdict is the one projection::decide gives (tests/native-engine/projection/plan_test.cpp holds it to core's).
void nativeProjectionReport() {
    Runtime& rt = runtime();
    v8::Isolate::Scope isolateScope(rt.isolate);
    Adapter adapter(rt.isolate, rt.context);
    uint64_t crossed[2] = {};
    int slot = 0;
    for (const int cubes : {1000, 4000}) {
        const std::string build = "const scene = new Scene(), geometry = new BoxGeometry(1, 1, 1), material = new MeshStandardMaterial();"
            "for (let i = 0; i < " + std::to_string(cubes) + "; ++i) { const m = new Mesh(geometry, material); m.position.x = i; scene.add(m); }";
        // Each run is a fresh context, so the call's cost is the difference between a run with it and one without.
        const uint64_t base = tn::abi::crossings();
        run(rt, adapter, (build + "'built'").c_str());
        const uint64_t built = tn::abi::crossings() - base;
        const uint64_t before = tn::abi::crossings();
        // Three frames: the first decides, the others answer from the structure stamp. Every frame reads the record's fields.
        const std::string answer = run(rt, adapter, (build +
            "let r; for (let f = 0; f < 3; ++f) r = scene.__tnProjectionReport(200);"
            "[r.projecting, r.reasonCode, r.sourceRenderables, r.projectedObjects, r.instancedBatches, r.exactObjects].join()").c_str());
        crossed[slot] = (tn::abi::crossings() - before) - built;
        const std::string expected = "true,projected," + std::to_string(cubes) + "," + std::to_string(cubes) + ",1,0";
        if (answer != expected) std::fprintf(stderr, "report answered %s, wanted %s\n", answer.c_str(), expected.c_str());
        CHECK(answer == expected);
        ++slot;
    }
    std::printf("projection report: %llu extra crossings for three frames at 1,000 cubes, %llu at 4,000\n",
                (unsigned long long)crossed[0], (unsigned long long)crossed[1]);
    CHECK(crossed[0] == crossed[1]);  // the same crossings for 1,000 and 4,000 cubes
    CHECK(crossed[0] <= 3);           // one call a frame
    // A scene under the floor answers its decline, and a mixed one counts what the native scene holds.
    const std::string declined = run(rt, adapter, "const s = new Scene(); for (let i = 0; i < 10; ++i) s.add(new Mesh(new BoxGeometry(), new MeshBasicMaterial()));"
        "const r = s.__tnProjectionReport(200); [r.projecting, r.reasonCode, r.sourceRenderables, r.projectedObjects].join()");
    CHECK(declined == "false,belowMeshFloor,10,0");
    // Moving a cube is not a structure change; adding one is, and the next call counts it.
    const std::string grown = run(rt, adapter, "const s = new Scene(), g = new BoxGeometry(), m = new MeshBasicMaterial();"
        "for (let i = 0; i < 300; ++i) s.add(new Mesh(g, m));"
        "const a = s.__tnProjectionReport(200).sourceRenderables; s.children[0].position.x = 4;"
        "const b = s.__tnProjectionReport(200).sourceRenderables; s.add(new Mesh(g, m));"
        "const c = s.__tnProjectionReport(200).sourceRenderables; [a, b, c].join()");
    CHECK(grown == "300,300,301");
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
        // core's projection stand-in (projection-apply copySpecializedState): a fresh SkinnedMesh is handed the
        // game's skeleton and bind matrices by assignment. A dropped assignment draws an unskinned rig.
        const stand = new SkinnedMesh(mesh.geometry, mesh.material);
        stand.skeleton = mesh.skeleton; stand.bindMatrix = new Matrix4().makeTranslation(1, 2, 3); stand.bindMode = mesh.bindMode;
        check(stand.skeleton !== null && stand.skeleton.bones[0] === hip, 'assigned skeleton');
        check(stand.bindMatrix.elements[12] === 1 && stand.bindMatrix.elements[13] === 2, 'assigned bind matrix');
        stand.skeleton = null; check(stand.skeleton === null, 'cleared skeleton');
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
        const stats = mixer.stats; const actionStats = stats.actions;
        check(mixer.stats===stats && mixer.stats.actions===actionStats, 'mixer stats identity');
        check(action.loop===LoopOnce && action.isScheduled() && action.getEffectiveWeight()===1, 'action state');
        const events = [];
        const onFinished = (event) => events.push(event);
        mixer.addEventListener('finished', onFinished);
        check(mixer.hasEventListener('finished', onFinished), 'listener registered');
        mixer.update(0.5); check(events.length===0 && Math.abs(hip.position.x-0.5)<1e-6, 'no event mid-clip');
        mixer.update(1);
        check(events.length===1 && events[0].type==='finished' && events[0].action===action && events[0].direction===1, 'finished event');
        action.stop(); check(stats.actions.inUse===0, 'live mixer stats after stop');
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
    // Diagnostic observation must never suppress a setter or its material version increment.
    auto& stats = tn::engine::Material::diagnostics();
    const auto saved = stats;
    stats = {};
    tn_handle_t handle{};
    tn_diagnostic_t diagnostic{nullptr, 0};
    CHECK(tn_construct(rt.context, "MeshStandardMaterial", nullptr, 0, &handle, &diagnostic) == TN_OK);
    auto& material = *static_cast<tn::engine::Material*>(tn::abi::objectOf(handle)->ptr.get());
    tn_value_t value{}; value.kind = TN_VALUE_NUMBER; value.number = 1;
    const auto initial = material.version();
    CHECK(tn_set(handle, "opacity", &value, &diagnostic) == TN_OK);
    CHECK(stats.writes == 0 && material.version() == initial + 1);
    stats.enabled = true;
    const auto before = material.version();
    for (double number : {1., .5, .5, 0., -0., std::numeric_limits<double>::quiet_NaN(), std::numeric_limits<double>::quiet_NaN()}) {
        value.number = number;
        CHECK(tn_set(handle, "opacity", &value, &diagnostic) == TN_OK);
    }
    CHECK(stats.writes == 7 && stats.unchanged == 2 && stats.changed == 2 && stats.signedZero == 1 && stats.nan == 2);
    CHECK(material.version() == before + 7);
    value.kind = TN_VALUE_BOOL; value.boolean = 1;
    CHECK(tn_set(handle, "needsUpdate", &value, &diagnostic) == TN_OK);
    CHECK(stats.writes == 7 && material.version() == before + 8);
    stats = saved;

}

// PRD-573 v1.11 step 0: the per-name histogram counts every crossing by the name it crossed with, and its sum
// is the crossings() delta. Off, it counts nothing.
void crossingHistogram() {
    Runtime& rt = runtime();
    v8::Isolate::Scope isolateScope(rt.isolate);
    Adapter adapter(rt.isolate, rt.context);
    // The wrapper is made before the counted loop; each run() is its own context.
    const char* work = "const p = new Mesh().position; let sink = 0; for (let i = 0; i < 100; ++i) { p.x = i; p.y = i; sink += p.z; p.set(1, 2, 3); } 0";
    tn::abi::crossingHistogramEnable(false);
    run(rt, adapter, work);
    CHECK(tn::abi::crossingHistogram().empty());  // off: nothing recorded
    tn::abi::crossingHistogramEnable(true);
    const uint64_t before = tn::abi::crossings();
    run(rt, adapter, work);
    const uint64_t crossed = tn::abi::crossings() - before;
    uint64_t sum = 0;
    std::map<std::string, uint64_t> byName;
    for (const auto& [name, count] : tn::abi::crossingHistogram()) { sum += count; byName[name] = count; }
    tn::abi::crossingHistogramEnable(false);
    CHECK(crossed > 0 && sum == crossed);
    CHECK(byName["x"] == 100 && byName["y"] == 100 && byName["z"] == 100 && byName["set"] == 100);
    if (sum != crossed) std::fprintf(stderr, "histogram sum %llu, crossings %llu\n", (unsigned long long)sum, (unsigned long long)crossed);
}

// With JS math on (PRD-573 v1.11 step 4a), Vector3 and the rest are three's own classes: a hot loop of
// value ops crosses nothing, and a JS value passed into a native call is read by it.
void jsMath() {
    Runtime& rt = runtime();
    v8::Isolate::Scope isolateScope(rt.isolate);
    const char* loop = R"JS(
        const w = new Vector3(1, 2, 3), v = new Vector3();
        for (let i = 0; i < 10000; i++) v.add(w);
        `${v.x} ${v.y} ${v.z}`
    )JS";
    {
        Adapter adapter(rt.isolate, rt.context);
        const uint64_t before = tn::abi::crossings();
        CHECK(run(rt, adapter, loop) == "10000 20000 30000");
        CHECK(tn::abi::crossings() - before >= 10000);  // native math: one crossing per op
    }
    Adapter adapter(rt.isolate, rt.context);
    adapter.setJsMath(true);
    const uint64_t before = tn::abi::crossings();
    CHECK(run(rt, adapter, loop) == "10000 20000 30000");
    CHECK(tn::abi::crossings() - before == 0);
    // A JS value is the argument of a native call, and the call may change it.
    CHECK(run(rt, adapter, R"JS(
        const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
        const w = new Vector3(4, 5, 6);
        mesh.position.copy(w);
        const p = mesh.position;
        mesh.position.set(7, 8, 9);
        `${p.x} ${p.y} ${p.z} ${w.x} ${w.y} ${w.z} ${new Color(0.25, 0.5, 1).r}`
    )JS") == "7 8 9 4 5 6 0.25");
    // A native object may keep its argument (a curve's points, a Raycaster's ray) instead of copying it: that
    // stand-in leaves the pool, so the next call's arguments neither overwrite it nor find the pool's handle dead.
    CHECK(run(rt, adapter, R"JS(
        const curve = new CatmullRomCurve3([0, 1, 2, 3].map((i) => new Vector3(i, i * i, 0)));
        const kept = curve.points.map((p) => p.y).join();
        const ray = new Raycaster(new Vector3(0.2, -0.3, 5), new Vector3(0, 0, -1));
        const other = new Raycaster(new Vector3(7, 0, 0), new Vector3(0, 1, 0));
        const again = new CatmullRomCurve3([4, 5, 6, 7].map((i) => new Vector3(i, i, i)));
        `${kept} ${curve.points.map((p) => p.x).join()} ${ray.ray.origin.x} ${ray.ray.direction.z} ${other.ray.origin.x} ${again.points[3].x}`
    )JS") == "0,1,4,9 0,1,2,3 0.2 -1 7 7");
}

// A transform member is a view over the object's own memory (PRD-573 v1.11 step 4b): component writes
// cross nothing, the next updateMatrix sees them, and the matrix it writes is the one three composes.
// three's Object3D.raycast(raycaster, intersects): core's picking calls it for every object it has no
// tree for (a Group, a skinned mesh). A Mesh pushes its own hits, a Group none, and nothing recurses.
void objectRaycast() {
    Runtime& rt = runtime();
    v8::Isolate::Scope isolateScope(rt.isolate);
    Adapter adapter(rt.isolate, rt.context);
    const std::string result = run(rt, adapter, R"JS(
      (() => {
        let checks = 0; const assert = (v) => { checks++; if (!v) throw Error('Object3D.raycast differs at check ' + checks); };
        const m = new MeshBasicMaterial(); m.side = 2;
        const mesh = new Mesh(new BoxGeometry(), m);
        const root = new Group(); root.add(mesh);
        root.updateMatrixWorld(true);
        const r = new Raycaster(new Vector3(0.2, -0.3, 5), new Vector3(0, 0, -1));
        const into = [];
        mesh.raycast(r, into);
        assert(into.length === 2 && into[0].object === mesh);
        const none = [];
        root.raycast(r, none);
        assert(none.length === 0);
        return 'PASS Object3D.raycast';
      })()
    )JS");
    CHECK(result == "PASS Object3D.raycast");
}

void jsMathViews() {
    Runtime& rt = runtime();
    v8::Isolate::Scope isolateScope(rt.isolate);
    {
        Adapter nativeAdapter(rt.isolate, rt.context);
        v8::HandleScope nativeScope(rt.isolate);
        auto nativeContext = v8::Context::New(rt.isolate);
        v8::Context::Scope nativeContextScope(nativeContext);
        nativeAdapter.install(nativeContext, nativeContext->Global());
        auto script = v8::Script::Compile(nativeContext, v8::String::NewFromUtf8Literal(rt.isolate,
            "const o = new Object3D(); o.position.x = 7; o.updateMatrix(); o")).ToLocalChecked();
        tn_handle_t h{};
        CHECK(nativeAdapter.unwrap(script->Run(nativeContext).ToLocalChecked(), h));
        auto* object = static_cast<tn::engine::Object3D*>(tn::abi::objectOf(h)->ptr.get());
        auto* flags = tn::engine::Object3D::transformTrackingAddress(&object->position);
        CHECK(flags[0] == 0 && flags[2] == 1 && object->matrix.elements[12] == 7);
    }

    Adapter adapter(rt.isolate, rt.context);
    adapter.setJsMath(true);
    v8::HandleScope scope(rt.isolate);
    v8::Local<v8::Context> ctx = v8::Context::New(rt.isolate);
    v8::Context::Scope contextScope(ctx);
    adapter.install(ctx, ctx->Global());
    ctx->Global()->Set(ctx, v8::String::NewFromUtf8Literal(rt.isolate, "__crossings"),
        v8::Function::New(ctx, [](const v8::FunctionCallbackInfo<v8::Value>& info) {
            info.GetReturnValue().Set(static_cast<double>(tn::abi::crossings()));
        }).ToLocalChecked()).Check();
    ctx->Global()->Set(ctx, v8::String::NewFromUtf8Literal(rt.isolate, "__tracking"),
        v8::Function::New(ctx, [](const v8::FunctionCallbackInfo<v8::Value>& info) {
            auto* a = static_cast<Adapter*>(info.Data().As<v8::External>()->Value());
            tn_handle_t h{};
            CHECK(a->unwrap(info[0], h));
            auto* o = static_cast<tn::engine::Object3D*>(tn::abi::objectOf(h)->ptr.get());
            auto* flags = tn::engine::Object3D::transformTrackingAddress(&o->position);
            if (info.Length() > 1) flags[1] = 0;
            info.GetReturnValue().Set(flags[0] * 100 + flags[1] * 10 + flags[2]);
        }, v8::External::New(rt.isolate, &adapter)).ToLocalChecked()).Check();
    ctx->Global()->Set(ctx, v8::String::NewFromUtf8Literal(rt.isolate, "__deferBone"),
        v8::Function::New(ctx, [](const v8::FunctionCallbackInfo<v8::Value>& info) {
            auto* a = static_cast<Adapter*>(info.Data().As<v8::External>()->Value());
            tn_handle_t h{}; CHECK(a->unwrap(info[0], h));
            auto* bone = static_cast<tn::engine::Bone*>(tn::abi::objectOf(h)->ptr.get());
            const double values[] = {7, 8, 9};
            const bool enabled = bone->enableDeferredTransform();
            tn::engine::animation::PropertyBinding binding(bone->shared_from_this(), ".position");
            binding.setValue(values, 0);
            CHECK(enabled ? bone->hasDeferredTransform() : bone->position.x == 7);
            info.GetReturnValue().Set(enabled);
        }, v8::External::New(rt.isolate, &adapter)).ToLocalChecked()).Check();
    {
        const auto source = v8::String::NewFromUtf8Literal(rt.isolate, R"JS(
            (() => {
                const owner = new Group();
                const before = __tracking(owner, true);
                const scratch = new Matrix4();
                const beforeCopy = __tracking(owner, true);
                scratch.copy(owner.matrixWorld);
                const afterCopy = __tracking(owner, true);
                const y = scratch.elements[5];
                const afterRead = __tracking(owner, true);
                const getterOwner = new Group(), beforeGetter = __tracking(getterOwner, true);
                void getterOwner.matrixWorld;
                return `${before} ${beforeCopy} ${afterCopy} ${afterRead} ${y} ${beforeGetter} ${__tracking(getterOwner, true)}`;
            })()
        )JS");
        const auto result = v8::Script::Compile(ctx, source).ToLocalChecked()->Run(ctx).ToLocalChecked();
        v8::String::Utf8Value text(rt.isolate, result);
        std::printf("fresh tracked Group scratch-copy probe: before/beforeCopy/afterCopy/afterRead/y/beforeGetter/afterGetter = %s\n", *text);
        CHECK(std::string(*text) == "100 100 101 101 1 100 101");
    }
    const char* tracking = R"JS(
        (() => {
            const check = (ok) => { if (!ok) throw Error('tracking assertion'); };
            const boundsRoot = new Group(), boundsMesh = new Mesh(new BoxGeometry(2, 4, 6), new MeshBasicMaterial());
            boundsRoot.position.set(10, 0, 0); boundsMesh.position.set(2, 3, 4); boundsRoot.add(boundsMesh);
            boundsRoot.updateMatrixWorld(true);
            check(__tracking(boundsRoot, true) === 100 && __tracking(boundsMesh, true) === 100);
            const observedBounds = new Box3().setFromObject(boundsRoot);
            check(observedBounds.min.equals(new Vector3(11, 1, 1)) && observedBounds.max.equals(new Vector3(13, 5, 7)));
            if (__tracking(boundsRoot, true) !== 100 || __tracking(boundsMesh, true) !== 100)
                throw Error(`bounds escaped ${__tracking(boundsRoot)} ${__tracking(boundsMesh)} native=${boundsRoot instanceof Object3D}`);

            boundsMesh.visible = false;
            check(new Box3().setFromObject(boundsRoot, true).equals(observedBounds));
            const expanded = new Box3(new Vector3(-20, -20, -20), new Vector3(-19, -19, -19));
            const minIdentity = expanded.min, maxIdentity = expanded.max;
            check(expanded.expandByObject(boundsRoot) === expanded && expanded.min === minIdentity && expanded.max === maxIdentity);
            check(expanded.min.x === -20 && expanded.max.equals(observedBounds.max));
            const instancedBounds = new InstancedMesh(new BoxGeometry(2, 4, 6), new MeshBasicMaterial(), 2);
            instancedBounds.setMatrixAt(0, new Matrix4()); instancedBounds.setMatrixAt(1, new Matrix4().makeTranslation(3, 0, 0));
            const instancesBox = new Box3().setFromObject(instancedBounds, true);
            check(instancesBox.min.equals(new Vector3(-1, -2, -3)) && instancesBox.max.equals(new Vector3(4, 2, 3)));
            check(__tracking(instancedBounds, true) === 100);
            const skinGeometry = new BufferGeometry();
            skinGeometry.setAttribute('position', new Float32BufferAttribute([1, 2, 3], 3));
            skinGeometry.setAttribute('skinIndex', new Float32BufferAttribute([0, 0, 0, 0], 4));
            skinGeometry.setAttribute('skinWeight', new Float32BufferAttribute([1, 0, 0, 0], 4));
            const boundsBone = new Bone(); boundsBone.position.x = 4; boundsBone.updateMatrixWorld(true);
            const boundsSkin = new SkinnedMesh(skinGeometry, new MeshBasicMaterial());
            boundsSkin.bind(new Skeleton([boundsBone], [new Matrix4()]), new Matrix4());
            const skinFlags = __tracking(boundsSkin, true), boneFlags = __tracking(boundsBone, true);
            for (const precise of [false, true]) {
                const box = new Box3().setFromObject(boundsSkin, precise);
                check(box.min.equals(new Vector3(5, 2, 3)) && box.max.equals(box.min));
            }
            check(__tracking(boundsSkin, true) === skinFlags && __tracking(boundsBone, true) === boneFlags);
            const morphGeometry = new BufferGeometry();
            morphGeometry.setAttribute('position', new Float32BufferAttribute([1, 2, 3], 3));
            morphGeometry.morphAttributes.position = [new Float32BufferAttribute([7, 8, 9], 3)];
            const morphMesh = new Mesh(morphGeometry, new MeshBasicMaterial());
            check(new Box3().setFromObject(morphMesh).max.equals(new Vector3(7, 8, 9)));
            check(new Box3().setFromObject(morphMesh, true).max.equals(new Vector3(1, 2, 3)));
            const portableObject = { geometry: boundsMesh.geometry, children: [], matrixWorld: new Matrix4().makeTranslation(2, 0, 0), updateWorldMatrix() {} };
            const portableBox = new Box3().setFromObject(portableObject);
            check(portableBox.min.equals(new Vector3(1, -2, -3)) && portableBox.max.equals(new Vector3(3, 2, 3)));
            const snapshotParent = new Group(), snapshotOwner = new Group(), snapshot = new Matrix4();
            snapshotParent.add(snapshotOwner);
            check(__tracking(snapshotOwner, true) === 100);
            snapshotOwner.__tnCopyMatrixWorld(snapshot);
            check(__tracking(snapshotOwner, true) === 100 && snapshot.elements.every((v, i) => v === (i % 5 === 0 ? 1 : 0)));
            for (let frame = 0; frame < 2; frame++) {
                snapshotParent.position.set(2 + frame, -3, 4);
                snapshotParent.scale.set(-2, 3, 4);
                snapshotParent.rotation.set(.1, .2, -.3);
                snapshotOwner.position.set(1, 2 + frame, -3);
                snapshotOwner.rotation.set(.4, -.2, .3);
                snapshotOwner.updateWorldMatrix(true, false);
                snapshotOwner.__tnCopyMatrixWorld(snapshot);
                const expected = new Matrix4().compose(snapshotParent.position, snapshotParent.quaternion, snapshotParent.scale)
                    .multiply(new Matrix4().compose(snapshotOwner.position, snapshotOwner.quaternion, snapshotOwner.scale));
                check(snapshot.elements.every((v, i) => Math.abs(v - expected.elements[i]) < 1e-12));
                check(__tracking(snapshotOwner, true) === 100 && __tracking(snapshotParent, true) === 100);
            }
            for (const bad of [null, 1, {}, new Vector3()]) {
                let refused = false;
                try { snapshotOwner.__tnCopyMatrixWorld(bad); } catch { refused = true; }
                check(refused && __tracking(snapshotOwner, true) === 100);
            }
            const liveTarget = snapshotParent.matrixWorld;
            snapshotOwner.__tnCopyMatrixWorld(liveTarget);
            check(liveTarget.elements.every((v, i) => v === snapshot.elements[i]));
            check(__tracking(snapshotOwner, true) === 100);
            const snapshotBone = new Bone(); check(__deferBone(snapshotBone));
            snapshotBone.__tnCopyMatrixWorld(snapshot);
            check(snapshot.elements[12] === 7 && snapshot.elements[13] === 8 && snapshot.elements[14] === 9);
            check(__tracking(snapshotBone, true) === 100);
            const live = snapshotOwner.matrixWorld;
            check(__tracking(snapshotOwner, true) === 101);
            live.elements[12] = 123;
            snapshotOwner.__tnCopyMatrixWorld(snapshot);
            check(snapshot.elements[12] === 123 && __tracking(snapshotOwner, true) === 101);
            const deferred = new Bone(); check(__deferBone(deferred));
            const keptBonePosition = deferred.position;
            check(keptBonePosition.x === 7 && __tracking(deferred) === 111);
            keptBonePosition.x = 100;
            check(!__deferBone(deferred) && keptBonePosition.x === 7);
            const retained = new Bone(), preexisting = retained.quaternion;
            check(!__deferBone(retained) && retained.position.y === 8 && preexisting.w === 1);
            const worldBone = new Bone(); check(__deferBone(worldBone));
            check(worldBone.matrixWorld.elements[12] === 7 && !__deferBone(worldBone));
            const ancestorBone = new Bone(), band = new Object3D();
            band.position.set(1,0,0); ancestorBone.add(band); check(__deferBone(ancestorBone));
            check(band.matrixWorld.elements[12] === 8);
            const localBone = new Bone(); check(__deferBone(localBone));
            void localBone.matrix; check(!__deferBone(localBone) && localBone.position.z === 9);
            const tree = new Group(); tree.add(new Object3D());
            for (const clone of [tree.clone(true), new SkeletonUtils().clone(tree)]) {
                check(__tracking(clone, true) === 100 && __tracking(clone.children[0], true) === 100);
                const child = clone.children[0]; child.position.x = 8;
                check(__tracking(child) === 110);
                const alias = child.position._a.buffer; check(__tracking(child, true) === 101);
                check(new Float64Array(alias)[0] === 8);
                void clone.matrixWorld; check(__tracking(clone, true) === 101);
            }
            const o = new Object3D(), p = o.position;
            check(__tracking(o, true) === 100);
            for (const write of [() => p.x = 2, () => p.set(3,4,5), () => p.fromArray([6,7,8]),
                () => o.scale.multiplyScalar(2), () => o.rotation.y = .5,
                () => o.rotation.order = 'ZYX', () => o.quaternion.w = .8,
                () => o.translateX(1), () => o.rotateY(.2), () => o.lookAt(1,2,3),
                () => o.applyMatrix4(new Matrix4()), () => o.copy(new Object3D())]) {
                __tracking(o, true); write(); check(__tracking(o) === 110);
            }
            p.fromArray([6,7,8]);
            check(p instanceof Vector3 && Object.keys(p).join() === '_a');
            check(!p.hasOwnProperty('x') && !Object.getOwnPropertyDescriptor(Object.getPrototypeOf(p), 'x').enumerable);
            const backingDescriptor = Object.getOwnPropertyDescriptor(p, '_a');
            check(backingDescriptor.enumerable && !backingDescriptor.configurable && !!backingDescriptor.set);
            check(Object.keys(o.rotation).join() === 'isEuler,_a,_o,_q');
            check(Object.keys(o.quaternion).join() === 'isQuaternion,_a,_e');
            check(!('_o' in p) && !('_o' in o.quaternion) && '_o' in o.rotation);
            check(!Reflect.ownKeys(Object.getPrototypeOf(p)).includes('_o'));
            check(!Reflect.ownKeys(Object.getPrototypeOf(o.quaternion)).includes('_o'));
            check(Reflect.ownKeys(Object.getPrototypeOf(o.rotation)).includes('_o'));
            const protectedOwner = new Object3D(); protectedOwner.position.x = 19;
            for (const [view, key] of [[protectedOwner.position, '_a'], [protectedOwner.quaternion, '_a'],
                [protectedOwner.rotation, '_a'], [protectedOwner.rotation, '_o']]) {
                let refused = false;
                try { Object.defineProperty(view, key, { value: [] }); } catch (error) { refused = error instanceof TypeError; }
                check(refused && !Reflect.deleteProperty(view, key));
                refused = false;
                try { (function () { 'use strict'; delete view[key]; })(); } catch (error) { refused = error instanceof TypeError; }
                check(refused);
            }
            check(__tracking(protectedOwner, true) === 100 && protectedOwner.position.x === 19);
            protectedOwner.position.x = 20; protectedOwner.updateMatrix();
            check(protectedOwner.matrix.elements[12] === 20);

            check(p.clone() instanceof Vector3 && p.clone().x === 6);
            p.copy(new Vector3(9,8,7)); check(p.x === 9);
            const a = p._a; check(__tracking(o, true) === 101);
            check(a === p._a && a.buffer === p._a.buffer);
            a[0] = 42; check(p.x === 42 && __tracking(o) === 101);
            p.y = 43; check(__tracking(o) === 111);
            const replacement = new Object3D(), replacementP = replacement.position;
            replacementP._a = new Float64Array([31,32,33]);
            check(__tracking(replacement, true) === 101 && replacementP.x === 31);
            const e = new Object3D(); const order = e.rotation._o;
            check(__tracking(e, true) === 101 && order === e.rotation._o);
            e.rotation._o = new Int32Array([0]); check(e.rotation.order === 'XYZ');
            for (const key of ['matrix', 'matrixWorld']) {
                const m = new Object3D(); check(__tracking(m, true) === 100);
                void m[key]; check(__tracking(m) === 101);
            }
            let gone = new Object3D(); const kept = gone.position; kept.set(12,13,14);
            gone = null; gc();
            for (let i = 0; i < 600; i++) new Object3D();
            gc(); check(kept.x === 12 && kept.y === 13 && kept.z === 14);
            kept.set(15,16,17); check(kept.z === 17);
            return 'tracked';
        })()
    )JS";
    {
        v8::TryCatch caught(rt.isolate);
        v8::Local<v8::Value> result;
        auto script = v8::Script::Compile(ctx, v8::String::NewFromUtf8(rt.isolate, tracking).ToLocalChecked()).ToLocalChecked();
        const bool ok = script->Run(ctx).ToLocal(&result);
        if (!ok) {
            v8::String::Utf8Value error(rt.isolate, caught.Exception());
            std::fprintf(stderr, "%s\n", *error);
            v8::Local<v8::Value> stack;
            if (caught.StackTrace(ctx).ToLocal(&stack)) {
                v8::String::Utf8Value trace(rt.isolate, stack);
                std::fprintf(stderr, "%s\n", *trace);
            }
        }
        CHECK(ok);
    }
    tn_handle_t collected{};
    {
        v8::HandleScope ownerScope(rt.isolate);
        auto source = v8::String::NewFromUtf8Literal(rt.isolate,
            "globalThis.__owner = new Object3D(); globalThis.__kept = __owner.position; __kept.set(21,22,23); "
            "globalThis.__rawOwner = new Object3D(); __rawOwner.position.set(41,42,43); "
            "globalThis.__rawBuffer = __rawOwner.position._a.buffer; delete globalThis.__rawOwner; __owner");
        auto owner = v8::Script::Compile(ctx, source).ToLocalChecked()->Run(ctx).ToLocalChecked();
        CHECK(adapter.unwrap(owner, collected));
        ctx->Global()->Delete(ctx, v8::String::NewFromUtf8Literal(rt.isolate, "__owner")).Check();
    }
    for (int i = 0; i < 4; ++i) rt.isolate->LowMemoryNotification();
    tn_value_t stale{};
    tn_diagnostic_t diagnostic{nullptr, 0};
    CHECK(tn_get(collected, "name", &stale, &diagnostic) == TN_ERROR_INVALID_HANDLE);
    tn_diagnostic_release(&diagnostic);
    auto retainedCheck = v8::String::NewFromUtf8Literal(rt.isolate,
        "for (let i = 0; i < 600; i++) new Object3D(); "
        "__kept.z === 23 && (__kept.x = 24) === 24 && new Float64Array(__rawBuffer)[0] === 41");
    CHECK(v8::Script::Compile(ctx, retainedCheck).ToLocalChecked()->Run(ctx).ToLocalChecked()->IsTrue());
    tn::engine::Object3D eager;
    auto* flags = tn::engine::Object3D::transformTrackingAddress(&eager.position);
    CHECK(flags[0] == 0 && flags[2] == 1);
    std::string cloneError;
    auto nativeClone = tn::engine::cloneObject(eager, true, cloneError);
    CHECK(nativeClone && cloneError.empty());
    CHECK(tn::engine::Object3D::transformTrackingAddress(&nativeClone->position)[0] == 0);
    eager.enableTrackedTransform();
    flags[2] = 1;
    eager.enableTrackedTransform();
    CHECK(flags[2] == 1);  // Admission cannot undo an earlier escape.
    flags[1] = 0;
    eager.rotation.x = .2;
    CHECK(flags[1] == 1);
    flags[1] = 0;
    eager.quaternion.w = .9;
    CHECK(flags[1] == 1);
    eager.position.x = 5; eager.updateMatrix();
    CHECK(eager.matrix.elements[12] == 5);
    eager.position.x = 6; eager.updateMatrix();
    CHECK(eager.matrix.elements[12] == 6);
    const char* source = R"JS(
        const make = () => new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
        const meshes = []; for (let i = 0; i < 100; i++) meshes.push(make());
        const views = meshes.map((m) => [m.position, m.quaternion, m.scale, m.rotation]);   // one read each
        const mesh = meshes[0], [p, q, s, r] = views[0];
        const rev0 = mesh.revision;
        const c0 = __crossings();
        for (let i = 0; i < 100; i++) {
            const [vp, vq, vs] = views[i];
            vp.x = i; vp.y = i * 2; vp.z = i * 3;
            vs.x = 1 + i; vs.y = 2; vs.z = 3;
            vq.x = 0.1; vq.y = 0.2; vq.z = 0.3; vq.w = 0.9;
        }
        r.set(0, 0.5, 0);                           // the pair follows: rotation writes the quaternion
        const writes = __crossings() - c0;
        const paired = Math.abs(q.y - Math.sin(0.25)) < 1e-12 && Math.abs(q.w - Math.cos(0.25)) < 1e-12;
        p.set(1, 2, 3); s.set(2, 3, 4); q.set(0.1, 0.2, 0.3, 0.9);   // the pair settles on this quaternion
        mesh.updateMatrix();
        const expected = new Matrix4().compose(p, q, s);
        const same = expected.elements.every((v, i) => Object.is(v, mesh.matrix.elements[i]));
        `${writes} ${paired} ${mesh.revision - rev0} ${same} ${p.x} ${mesh.position === p} ${mesh.rotation === r}`
    )JS";
    v8::Local<v8::Script> script = v8::Script::Compile(ctx, v8::String::NewFromUtf8(rt.isolate, source).ToLocalChecked()).ToLocalChecked();
    v8::TryCatch tryCatch(rt.isolate);
    v8::Local<v8::Value> result;
    if (!script->Run(ctx).ToLocal(&result)) {
        v8::String::Utf8Value error(rt.isolate, tryCatch.Exception());
        std::printf("THROWN %s\n", *error ? *error : "?");
        CHECK(false);
        return;
    }
    v8::String::Utf8Value text(rt.isolate, result);
    if (std::string(*text) != "0 true 1 true 1 true true") std::printf("got: %s\n", *text);  // the failure's whole story
    CHECK(std::string(*text) == "0 true 1 true 1 true true");
}

// The other native-backed members are views too, and a write through one reaches the object: `clone()`
// copies the native state, so what its members read back is what the first object holds.
void jsMathMembers() {
    Runtime& rt = runtime();
    v8::Isolate::Scope isolateScope(rt.isolate);
    Adapter adapter(rt.isolate, rt.context);
    adapter.setJsMath(true);
    const std::string got = run(rt, adapter, R"JS(
        const material = new MeshStandardMaterial();
        material.color.r = 0.25; material.color.set(0.25, 0.5, 0.75);
        const copy = material.clone();
        const color = `${copy.color.r} ${copy.color.g} ${copy.color.b} ${copy.color.isColor} ${material.color === material.color}`;
        material.color = new Color(1, 0, 0);                     // assigning a JS colour copies it into the material's
        const assigned = `${material.clone().color.r} ${material.clone().color.g}`;
        const mesh = new Mesh(new BoxGeometry(2, 4, 6), material);
        mesh.up.set(0, 0, 1);
        const up = `${mesh.clone().up.z}`;
        mesh.geometry.computeBoundingBox();
        const box = mesh.geometry.boundingBox;
        const bounds = `${box.min.x} ${box.max.z} ${box.isBox3} ${box.getSize(new Vector3()).y}`;
        mesh.geometry.computeBoundingSphere();
        const sphere = `${mesh.geometry.boundingSphere.radius.toFixed(4)} ${mesh.geometry.boundingSphere.isSphere}`;
        const camera = new PerspectiveCamera(60, 2, 0.1, 100);
        camera.updateProjectionMatrix();
        const e = camera.projectionMatrix.elements;
        const matrix = `${e.length} ${e[0].toFixed(6)} ${e[5].toFixed(6)} ${camera.projectionMatrix.isMatrix4}`;
        [color, assigned, up, bounds, sphere, matrix].join(" | ")
    )JS");
    const char* want = "0.25 0.5 0.75 true true | 1 0 | 1 | -1 3 true 4 | 3.7417 true | 16 0.866025 1.732051 true";
    if (got != want) std::printf("got: %s\n", got.c_str());
    CHECK(got == want);
}

// PRD-617: exercise the same native bindings that templates call.
void templateMaterial() {
    Runtime& rt = runtime();
    v8::Isolate::Scope isolateScope(rt.isolate);
    Adapter adapter(rt.isolate, rt.context);
    const std::string got = run(rt, adapter, R"JS(
        const m = new MeshStandardMaterial({ flatShading: true });
        const initial = m.flatShading;
        const copy = m.clone();
        m.flatShading = false;
        if (!initial || !copy.flatShading || m.flatShading !== false) throw new Error('flatShading state');
        copy
    )JS", [&](v8::Local<v8::Value> result) {
        tn_handle_t handle{};
        CHECK(adapter.unwrap(result, handle));
        const auto* object = tn::abi::objectOf(handle);
        if (!object) { CHECK(false); return; }
        const auto& material = *static_cast<tn::engine::Material*>(object->ptr.get());
        CHECK(material.flatShading);
        tn::engine::shader::VertexVariant variant;
        variant.flatShading = material.flatShading;
        const auto program = tn::engine::shader::buildStandard({}, variant);
        const auto wgsl = tn::engine::shader::WgslEmitter::emit(program.fragment);
        CHECK(wgsl.ok());
        CHECK(wgsl.code.find("dpdx(") != std::string::npos);
        CHECK(wgsl.code.find("dpdy(") != std::string::npos);
    });
    std::printf("template material: %s\n", got.c_str());
    CHECK(got == "[object Object]");
}

void templateBounds() {
    Runtime& rt = runtime();
    v8::Isolate::Scope isolateScope(rt.isolate);
    Adapter adapter(rt.isolate, rt.context);
    const std::string got = run(rt, adapter, R"JS(
        const geometry = new BoxGeometry(2, 4, 6);
        const mesh = new InstancedMesh(geometry, new MeshStandardMaterial(), 2);
        mesh.setMatrixAt(0, new Matrix4().makeTranslation(-5, 0, 0));
        mesh.setMatrixAt(1, new Matrix4().makeTranslation(5, 0, 0));
        const result = mesh.computeBoundingSphere();
        const sphere = geometry.boundingSphere;
        [result === undefined, sphere.center.x === 0, sphere.center.y === 0,
         sphere.center.z === 0, Math.abs(sphere.radius - Math.sqrt(14)) < 1e-12,
         Math.abs(mesh.boundingSphere.radius - (5 + Math.sqrt(14))) < 1e-12].join(' ')
    )JS");
    std::printf("template bounds: %s\n", got.c_str());
    CHECK(got == "true true true true true true");
}

void templateRanges() {
    Runtime& rt = runtime();
    v8::Isolate::Scope isolateScope(rt.isolate);
    Adapter adapter(rt.isolate, rt.context);
    const std::string got = run(rt, adapter, R"JS(
        const a = new BufferAttribute(new Float32Array(12), 3);
        const ranges = a.updateRanges;
        const checks = [Array.isArray(ranges), ranges === a.updateRanges];
        checks.push(ranges.push({ start: 3, count: 6 }) === 1);
        checks.push(a.updateRanges[0].start === 3 && a.updateRanges[0].count === 6);
        a.addUpdateRange(0, 3);
        checks.push(ranges.length === 2);
        a.clearUpdateRanges();
        checks.push(ranges.length === 0 && ranges === a.updateRanges);
        ranges.push({ start: 0, count: 3 });
        ranges[0].count = 6;
        a.addUpdateRange(6, 3);
        a.needsUpdate = true;
        checks.push(ranges[0].count === 6 && ranges.length === 2);
        const append = ranges.push;
        const other = [];
        append.call(other, { start: 0, count: 1 });
        checks.push(other.length === 1 && ranges.length === 2);
        let refused = false;
        try { append({ start: 0, count: 1 }); } catch (error) { refused = error instanceof TypeError; }
        checks.push(refused);
        const push = ranges.push.bind(ranges);
        a.clearUpdateRanges();
        push({ start: 9, count: 3 });
        checks.push(ranges.length === 1 && ranges[0].start === 9);
        a.clearUpdateRanges();
        ranges.push({ start: 6, count: 3 });
        const version = a.version;
        a.needsUpdate = true;
        checks.push(a.version === version + 1 && a.updateRanges.length === 1);
        const range = ranges[0]; range.count = 2;
        a.needsUpdate = true;
        if (!checks.every(Boolean)) throw new Error(checks.join(' '));
        a
    )JS", [&](v8::Local<v8::Value> result) {
        tn_handle_t handle{};
        CHECK(adapter.unwrap(result, handle));
        const auto* object = tn::abi::objectOf(handle);
        if (!object) { CHECK(false); return; }
        auto& attribute = *static_cast<tn::engine::BufferAttribute*>(object->ptr.get());
        CHECK(attribute.updateRanges().size() == 1);
        if (attribute.updateRanges().size() == 1) {
            CHECK(attribute.updateRanges()[0].start == 6);
            CHECK(attribute.updateRanges()[0].count == 2);
        }
        // The renderer clears this same store after uploading its ranges.
        attribute.clearUpdateRanges();
        auto ctx = rt.isolate->GetCurrentContext();
        v8::Local<v8::Value> cleared;
        CHECK(v8::Script::Compile(ctx, v8::String::NewFromUtf8Literal(rt.isolate,
            "ranges.length === 0 && a.updateRanges === ranges")).ToLocalChecked()->Run(ctx).ToLocal(&cleared));
        CHECK(!cleared.IsEmpty() && cleared->IsTrue());
    });
    std::printf("template ranges: %s\n", got.c_str());
    CHECK(got == "[object Object]");
}

}  // namespace

TN_TEST_MAIN({"template_material", templateMaterial}, {"template_bounds", templateBounds}, {"template_ranges", templateRanges}, {"handles", handles}, {"fast_paths", fastPaths}, {"structure_stamp", structureStamp}, {"crossing_histogram", crossingHistogram}, {"collect_visits", collectVisits}, {"native_matrix_world", nativeMatrixWorld}, {"native_projection_report", nativeProjectionReport}, {"unsupported", unsupported}, {"gc_release", gcRelease},
             {"runtime_churn", runtimeChurn}, {"fog_node", fogNode}, {"node_material_fragment", nodeMaterialFragment},
             {"crossing_bench", crossingBench},
             {"scene", scene}, {"raycaster_lod", raycasterLOD}, {"object_raycast", objectRaycast},
             {"catalog_coverage", catalogCoverage},
             {"callback_cycle", callbackCycle}, {"wrapper_lifetime", wrapperLifetime}, {"tsl_api", tslApi}, {"uniform_value", uniformValue}, {"node_materials", nodeMaterials}, {"skeletal", skeletal},
             {"attribute_arrays", attributeArrays}, {"geometry_lifecycle", geometryLifecycle},
             {"material_slots", materialSlots}, {"js_math", jsMath}, {"js_math_views", jsMathViews}, {"js_math_members", jsMathMembers})
