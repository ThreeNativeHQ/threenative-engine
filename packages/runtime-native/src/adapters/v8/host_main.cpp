// tn-native-engine-host: a game script on the native engine, measured (PRD-534, CP1). The script
// runs on V8 through the adapter — the shipping shape (arm `native-v8`) — or, with --cpp, a C++ twin
// of the same workload drives the engine directly (arm `native-cpp`, the control that isolates the
// crossing cost). Both draw through renderer.render(scene, camera)'s native path into an offscreen
// target; GPU time is the renderer's timestamp queries (scene pass start to output pass end), null on a
// device without timestamp-query. Presentation arrives with the desktop/Pixel verdict runs.
//
//   tn-native-engine-host <workload.js> [--objects N] [--frames N] [--warmup N] [--size WxH]
//                         [--report out.json] [--cpp | --crowd] [--identity manifest]
//                         [--v8-snapshot snapshot_blob.bin]
//
// `--v8-snapshot` is for Android, whose prebuilt V8 keeps the startup snapshot beside the library
// (the desktop monolith embeds it); the Pixel lane of CP1 (scripts/engine-load-test/cp1-android.ts)
// pushes this executable, libv8android.so and that file to /data/local/tmp and runs it from `adb shell`.
//
// `--crowd` drives the C++ skinned crowd (player::SkinnedCrowd without its refusal cases: 64
// identical animated rigs) instead of the L4 twin; the report's workload is `skinned-crowd`.
//
// The script defines `workload = { setup(objectCount, width, height) -> {scene, camera},
// update(frameIndex) }`. Per measured frame the host records the update time (the game's work),
// the submit time (renderer.render: world matrices, records, encoding, submission), the frame time
// (both plus the wait for the GPU), the C ABI crossings and the draws/triangles submitted.

#include <libplatform/libplatform.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <fstream>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

#include "adapters/v8/adapter.h"
#include "engine/abi/abi_internal.h"
#include "engine/abi/identity.h"
#include "engine/foundation/math/ieee754.h"
#include "engine/player/skinned_crowd.h"
#include "engine/renderer/render_database.h"
#include "engine/scene/geometries.h"
#include "mystral/webgpu/context.h"

using namespace tn::engine;
using Clock = std::chrono::steady_clock;

namespace {

struct Options {
    std::string script;
    uint32_t objects = 4096, frames = 600, warmup = 120, width = 1280, height = 720;
    std::string report;
    bool cpp = false;
    bool crowd = false;
    bool gpuTimer = true;  // --no-gpu-timer: skip the per-frame timestamp resolve and readback (gpuMs is then null)
    std::string identity;  // the artifact identity manifest checked at startup (PRD-530)
    std::string snapshot;  // V8's startup snapshot, where the platform's V8 keeps it outside the library
};

double ms(Clock::time_point a, Clock::time_point b) { return std::chrono::duration<double, std::milli>(b - a).count(); }

// workload.ts's percentile: the sorted sample at rank ceil(f * n) - 1.
double percentile(std::vector<double> samples, double fraction) {
    if (samples.empty()) return 0;
    std::sort(samples.begin(), samples.end());
    const double rank = std::ceil(fraction * double(samples.size())) - 1;
    return samples[size_t(std::clamp(rank, 0.0, double(samples.size() - 1)))];
}

// --------------------------------------------------------------------- the C++ twin (native-cpp)
// workload.ts line for line: the LCG lattice, the per-cube L4 colour, the bob and the rotations,
// the camera orbit. Math.sin/cos are V8's fdlibm (ieee754), so every pose is bit-identical to JS.
constexpr double kSpacing = 2.5;

struct CppWorkload {
    std::shared_ptr<Scene> scene = std::make_shared<Scene>();
    std::shared_ptr<PerspectiveCamera> camera = std::make_shared<PerspectiveCamera>();
    std::vector<std::shared_ptr<Mesh>> cubes;
    std::vector<std::array<double, 3>> placements;
    uint32_t objects = 0;

    void setup(uint32_t count, uint32_t width, uint32_t height) {
        objects = count;
        camera->fov = 60;
        camera->aspect = double(width) / double(height);
        camera->near = 0.1;
        camera->far = 4000;
        camera->updateProjectionMatrix();
        auto base = std::make_shared<Material>(MaterialType::Standard);
        base->color.setHex(0xb8c4cc);
        base->metalness = 0;
        base->roughness = 0.75;
        auto ground = std::make_shared<Mesh>(makePlaneGeometry(200, 200), base);
        ground->rotation.set(-3.141592653589793 / 2, 0, 0);
        ground->matrixAutoUpdate = false;
        ground->updateMatrix();
        scene->add(*ground);
        auto light = std::make_shared<DirectionalLight>(Color().setHex(0xffffff), 2.4);
        light->position.set(40, 80, 25);
        scene->add(*light);
        // createPlacements: state = (state * 1664525 + 1013904223) mod 2^32 from seed 1337.
        double state = 1337;
        auto random = [&] {
            state = std::fmod(state * 1664525 + 1013904223, 4294967296.0);
            return state / 4294967296.0;
        };
        const double side = std::max(1.0, std::ceil(std::sqrt(double(count))));
        const double half = (side - 1) / 2;
        const auto box = makeBoxGeometry(1, 1, 1);
        for (uint32_t i = 0; i < count; ++i) {
            const double gridX = std::fmod(double(i), side), gridZ = std::floor(double(i) / side);
            const double jx = random(), jz = random(), jy = random();
            placements.push_back({(gridX - half) * kSpacing + (jx - 0.5) * kSpacing * 0.6, 0.5 + jy * 3,
                                  (gridZ - half) * kSpacing + (jz - 0.5) * kSpacing * 0.6});
            auto material = std::make_shared<Material>(MaterialType::Standard);  // L4: a clone per cube
            material->metalness = 0;
            material->roughness = 0.75;
            material->color.setHex(double(0xff0000 | (i & 0x00ffff)));      // uniqueMaterialColor
            auto cube = std::make_shared<Mesh>(box, material);
            cube->position.set(placements.back()[0], placements.back()[1], placements.back()[2]);
            scene->add(*cube);
            cubes.push_back(cube);
        }
        // The scene owns what it draws; the twin keeps its handles for update().
        keep.push_back(ground);
        keep.push_back(light);
    }

    void update(uint32_t frame) {
        const double extent = std::max(1.0, std::ceil(std::sqrt(double(objects)))) * kSpacing;
        const double angle = frame * 0.0045, radius = extent * 0.34;
        camera->position.set(ieee754::cos(angle) * radius, extent * 0.09 + 4, ieee754::sin(angle) * radius);
        camera->lookAt(ieee754::cos(angle + 3.141592653589793) * extent * 0.12, 1.5,
                       ieee754::sin(angle + 3.141592653589793) * extent * 0.12);
        for (uint32_t i = 0; i < cubes.size(); ++i) {
            Mesh& cube = *cubes[i];
            cube.position.y = placements[i][1] + ieee754::sin(frame * 0.05 + i * 0.3) * 0.5;
            cube.rotation.set(i * 0.011 + frame * 0.013, i * 0.017 + frame * 0.02, cube.rotation.z, cube.rotation.order);
        }
    }

    std::vector<std::shared_ptr<Object3D>> keep;
};

// ------------------------------------------------------------------------------ the V8 game side

// The bytes have to outlive V8, so they are held for the process.
std::string g_snapshotBytes;
v8::StartupData g_snapshot{nullptr, 0};

struct V8Game {
    std::unique_ptr<v8::Platform> platform;
    std::unique_ptr<v8::ArrayBuffer::Allocator> allocator;
    v8::Isolate* isolate = nullptr;
    tn_context_t* context = nullptr;
    std::unique_ptr<tn::adapters::v8adapter::Adapter> adapter;
    v8::Global<v8::Context> js;
    v8::Global<v8::Function> update;
    Scene* scene = nullptr;
    Camera* camera = nullptr;
    // The host co-owns what it renders: the JS {scene, camera} is garbage after setup(), and a
    // collected wrapper releases its handle, which must not free the scene under the frame loop.
    std::shared_ptr<void> sceneHold, cameraHold;

    bool start(const Options& o, std::string& error) {
        if (!o.snapshot.empty()) {
            std::ifstream blob(o.snapshot, std::ios::binary);
            std::stringstream bytes;
            bytes << blob.rdbuf();
            g_snapshotBytes = bytes.str();
            if (!blob || g_snapshotBytes.empty()) return error = "cannot read the V8 snapshot " + o.snapshot, false;
            g_snapshot = {g_snapshotBytes.data(), int(g_snapshotBytes.size())};
            v8::V8::SetSnapshotDataBlob(&g_snapshot);
        }
        platform = v8::platform::NewDefaultPlatform();
        v8::V8::InitializePlatform(platform.get());
        v8::V8::Initialize();
        allocator.reset(v8::ArrayBuffer::Allocator::NewDefaultAllocator());
        v8::Isolate::CreateParams params;
        params.array_buffer_allocator = allocator.get();
        isolate = v8::Isolate::New(params);
        const tn_version_info_t own = tn_engine_version();
        tn_diagnostic_t d{nullptr, 0};
        if (tn_context_create(&context, &own, &d) != TN_OK) return error = "no engine context", false;
        v8::Isolate::Scope isolateScope(isolate);
        v8::HandleScope scope(isolate);
        adapter = std::make_unique<tn::adapters::v8adapter::Adapter>(isolate, context);
        v8::Local<v8::Context> ctx = v8::Context::New(isolate);
        js.Reset(isolate, ctx);
        v8::Context::Scope contextScope(ctx);
        adapter->install(ctx, ctx->Global());
        std::ifstream file(o.script);
        if (!file) return error = "cannot read " + o.script, false;
        std::stringstream source;
        source << file.rdbuf();
        v8::TryCatch tryCatch(isolate);
        auto str = [&](const std::string& s) { return v8::String::NewFromUtf8(isolate, s.c_str()).ToLocalChecked(); };
        v8::Local<v8::Script> script;
        v8::Local<v8::Value> ignored;
        if (!v8::Script::Compile(ctx, str(source.str())).ToLocal(&script) || !script->Run(ctx).ToLocal(&ignored)) {
            v8::String::Utf8Value message(isolate, tryCatch.Exception());
            return error = std::string("script failed: ") + (*message ? *message : "?"), false;
        }
        v8::Local<v8::Value> workloadValue;
        if (!ctx->Global()->Get(ctx, str("workload")).ToLocal(&workloadValue) || !workloadValue->IsObject())
            return error = "the script defines no `workload` object", false;
        auto workload = workloadValue.As<v8::Object>();
        v8::Local<v8::Value> setupValue, updateValue;
        if (!workload->Get(ctx, str("setup")).ToLocal(&setupValue) || !setupValue->IsFunction() ||
            !workload->Get(ctx, str("update")).ToLocal(&updateValue) || !updateValue->IsFunction())
            return error = "workload needs setup() and update()", false;
        update.Reset(isolate, updateValue.As<v8::Function>());
        v8::Local<v8::Value> args[3] = {v8::Number::New(isolate, o.objects), v8::Number::New(isolate, o.width),
                                        v8::Number::New(isolate, o.height)};
        v8::Local<v8::Value> built;
        if (!setupValue.As<v8::Function>()->Call(ctx, workload, 3, args).ToLocal(&built) || !built->IsObject()) {
            v8::String::Utf8Value message(isolate, tryCatch.Exception());
            return error = std::string("setup failed: ") + (*message ? *message : "it returned no {scene, camera}"), false;
        }
        auto field = [&](const char* name) -> tn::binding::Object* {
            v8::Local<v8::Value> v;
            tn_handle_t h{};
            if (!built.As<v8::Object>()->Get(ctx, str(name)).ToLocal(&v) || !adapter->unwrap(v, h)) return nullptr;
            return tn::abi::objectOf(h);
        };
        tn::binding::Object* s = field("scene");
        tn::binding::Object* c = field("camera");
        if (!s || s->cls != "Scene") return error = "setup's scene is not a Scene", false;
        if (!c || (c->cls != "PerspectiveCamera" && c->cls != "OrthographicCamera")) return error = "setup's camera is not a camera", false;
        sceneHold = s->ptr;
        cameraHold = c->ptr;
        scene = static_cast<Scene*>(s->ptr.get());
        camera = c->cls == "PerspectiveCamera" ? static_cast<Camera*>(static_cast<PerspectiveCamera*>(c->ptr.get()))
                                               : static_cast<Camera*>(static_cast<OrthographicCamera*>(c->ptr.get()));
        return true;
    }

    bool step(uint32_t frame, std::string& error) {
        v8::Isolate::Scope isolateScope(isolate);
        v8::HandleScope scope(isolate);
        v8::Local<v8::Context> ctx = js.Get(isolate);
        v8::Context::Scope contextScope(ctx);
        v8::TryCatch tryCatch(isolate);
        v8::Local<v8::Value> arg = v8::Number::New(isolate, frame), ignored;
        if (!update.Get(isolate)->Call(ctx, ctx->Global(), 1, &arg).ToLocal(&ignored)) {
            v8::String::Utf8Value message(isolate, tryCatch.Exception());
            return error = std::string("update failed: ") + (*message ? *message : "?"), false;
        }
        return true;
    }
    // The callback safe point (PRD-531), once a frame after the render.
    void safePoint() {
        v8::Isolate::Scope isolateScope(isolate);
        v8::HandleScope scope(isolate);
        adapter->collect();
    }
};

}  // namespace

int main(int argc, char** argv) {
    Options o;
    for (int i = 1; i < argc; ++i) {
        const std::string a = argv[i];
        auto next = [&] { return i + 1 < argc ? std::string(argv[++i]) : std::string(); };
        if (a == "--objects") o.objects = uint32_t(std::stoul(next()));
        else if (a == "--frames") o.frames = uint32_t(std::stoul(next()));
        else if (a == "--warmup") o.warmup = uint32_t(std::stoul(next()));
        else if (a == "--size") { const std::string s = next(); o.width = uint32_t(std::stoul(s)); o.height = uint32_t(std::stoul(s.substr(s.find('x') + 1))); }
        else if (a == "--report") o.report = next();
        else if (a == "--cpp") o.cpp = true;
        else if (a == "--crowd") o.crowd = true;
        else if (a == "--no-gpu-timer") o.gpuTimer = false;
        else if (a == "--identity") o.identity = next();
        else if (a == "--v8-snapshot") o.snapshot = next();
        else if (o.script.empty() && a.rfind("--", 0) != 0) o.script = a;
        else return std::fprintf(stderr, "TN_HOST_ARGS: unknown argument %s\n", a.c_str()), 2;
    }
    if (!o.cpp && !o.crowd && o.script.empty())
        return std::fprintf(stderr, "TN_HOST_ARGS: a workload script, --cpp or --crowd\n"), 2;
    if (o.cpp && o.crowd) return std::fprintf(stderr, "TN_HOST_ARGS: --cpp and --crowd are separate workloads\n"), 2;
    // PRD-530: an artifact built against another engine stops here, before any engine or game code.
    if (!o.identity.empty()) {
        std::ifstream manifest(o.identity);
        std::stringstream text;
        text << manifest.rdbuf();
        const std::string refusal = manifest ? tn::abi::checkIdentity(text.str()) : "TN_ARTIFACT_IDENTITY_MISSING: " + o.identity;
        if (!refusal.empty()) return std::fprintf(stderr, "%s\n", refusal.c_str()), 3;
    }

    mystral::webgpu::Context gpuContext;
    if (!gpuContext.initializeHeadless()) return std::fprintf(stderr, "TN_HOST_NO_GPU\n"), 1;
    EventQueue events;
    Renderer renderer(gpuContext.getInstance(), gpuContext.getDevice(), gpuContext.getQueue(), events);
    renderer.setSize(o.width, o.height);
    renderer.setGpuTimer(o.gpuTimer);
    RenderDatabase database;

    CppWorkload twin;
    tn::engine::player::SkinnedCrowd crowd(false);
    V8Game game;
    std::string error;
    Scene* scene = nullptr;
    Camera* camera = nullptr;
    if (o.crowd) {
        scene = &crowd.scene();
        camera = &crowd.camera();
    } else if (o.cpp) {
        twin.setup(o.objects, o.width, o.height);
        scene = twin.scene.get();
        camera = twin.camera.get();
    } else {
        if (!game.start(o, error)) return std::fprintf(stderr, "TN_HOST_SCRIPT: %s\n", error.c_str()), 1;
        scene = game.scene;
        camera = game.camera;
    }

    // What the scene presents, counted from the scene itself: its meshes (skinned ones apart).
    struct Census { uint64_t meshes = 0, skinned = 0, skinnedTriangles = 0; } census;
    scene->traverse(
        [](Object3D& object, void* context) {
            auto& found = *static_cast<Census*>(context);
            const std::string_view type = object.type();
            if (type == "SkinnedMesh") {
                ++found.skinned;
                const auto& mesh = static_cast<const Mesh&>(object);
                if (mesh.geometry && mesh.geometry->index) found.skinnedTriangles += mesh.geometry->index->count() / 3;
            }
            else if (type == "Mesh") ++found.meshes;
        },
        &census);
    std::vector<double> update, submit, frame, crossings, gpu;
    uint64_t gpuSeen = 0;
    Renderer::FrameStats stats;
    for (uint32_t i = 0; i < o.warmup + o.frames; ++i) {
        const uint64_t crossed = tn::abi::crossings();
        const auto t0 = Clock::now();
        if (o.crowd) {
            crowd.update(1.0 / 60);
        } else if (o.cpp) {
            twin.update(i);
        } else if (!game.step(i, error)) {
            return std::fprintf(stderr, "TN_HOST_SCRIPT: %s\n", error.c_str()), 1;
        }
        const auto t1 = Clock::now();
        database.render(renderer, *scene, *camera);
        const auto t2 = Clock::now();
        // One frame in flight, as a presented frame would be: wait for the GPU before the next.
        while (renderer.gpu().completedSerial() < renderer.gpu().submittedSerial()) {
            renderer.poll();
            events.drain();
        }
        const auto t3 = Clock::now();
        if (!o.cpp && !o.crowd) game.safePoint();
        if (!database.diagnostics().empty()) return std::fprintf(stderr, "TN_HOST_RENDER: %s\n", database.diagnostics().front().c_str()), 1;
        if (i < o.warmup) continue;
        update.push_back(ms(t0, t1));
        submit.push_back(ms(t1, t2));
        frame.push_back(ms(t0, t3));
        crossings.push_back(double(tn::abi::crossings() - crossed));
        if (renderer.gpuSamples() != gpuSeen) {  // each GPU time once, as it comes back
            gpuSeen = renderer.gpuSamples();
            gpu.push_back(renderer.lastGpuMs());
        }
        stats = renderer.lastFrame();
    }
    std::vector<double> hot(update.size());
    for (size_t k = 0; k < hot.size(); ++k) hot[k] = update[k] + submit[k];
    auto series = [](const std::vector<double>& s) {
        char buffer[128];
        std::snprintf(buffer, sizeof buffer, "{\"p50\": %.4f, \"p95\": %.4f}", percentile(s, 0.5), percentile(s, 0.95));
        return std::string(buffer);
    };
    std::ostringstream json;
    // L4 is N cubes under one ground plane; the crowd is its skinned rigs under one ground plane.
    const uint64_t presented = o.crowd ? census.skinned : census.meshes - 1;
    json << "{\n  \"arm\": \"" << (o.cpp || o.crowd ? "native-cpp" : "native-v8") << "\",\n  \"workload\": \""
         << (o.crowd ? "skinned-crowd" : "L4") << "\",\n"
         << "  \"objects\": " << (o.crowd ? census.skinned : o.objects) << ",\n  \"presentedObjects\": " << presented << ",\n"
         // The crowd's own triangles, counted from its rigs: the renderer's count differs by what each
         // engine counts (three's info includes the shadow pass, this renderer's does not).
         << "  \"sceneTriangles\": " << (o.crowd ? census.skinnedTriangles : stats.triangles) << ",\n  \"frames\": " << o.frames << ",\n  \"warmup\": " << o.warmup << ",\n"
         << "  \"size\": [" << o.width << ", " << o.height << "],\n"
         << "  \"updateMs\": " << series(update) << ",\n  \"submitMs\": " << series(submit) << ",\n"
         << "  \"hotPathMs\": " << series(hot) << ",\n  \"frameMs\": " << series(frame) << ",\n"
         << "  \"crossingsPerFrame\": " << series(crossings) << ",\n"
         << "  \"draws\": " << stats.draws << ",\n  \"triangles\": " << stats.triangles << ",\n"
         << "  \"gpuMs\": " << (gpu.empty() ? std::string("null") : series(gpu)) << ",\n  \"gpuSamples\": " << gpu.size()
         << ",\n  \"presented\": false\n}\n";
    std::fputs(json.str().c_str(), stdout);
    if (!o.report.empty()) std::ofstream(o.report) << json.str();
    return 0;
}
