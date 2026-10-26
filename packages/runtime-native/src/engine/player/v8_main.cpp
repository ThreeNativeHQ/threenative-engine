#include "engine/renderer/probes/capture.h"
// tn-native-engine-player-v8 (PRD-531 phase 3): the native-engine desktop player with a game on V8.
// It links the V8 adapter, so it is a JS artifact and never an engine target; the JS-free player
// stays tn-native-engine-player. The window, loop, mailbox, render and screenshot path are the same
// `player::run`, so both players differ only in what builds the scene.
//
//   tn-native-engine-player-v8 <game.js>
//
// The host object a game bundle talks to (the minimal shape; the adapter installs the engine's
// classes as globals, so `THREE` is just the global object):
//
//   const THREE = globalThis;              // new THREE.Scene() is new Scene()
//   const scene = new THREE.Scene();
//   const camera = new THREE.PerspectiveCamera(50, 1280 / 720, 0.1, 200);
//   const player = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.4, 1.4), new THREE.MeshStandardMaterial());
//   player.name = "player"; scene.add(player);
//   THREE.tn.scene = scene;                // the world the renderer draws and the endpoint samples
//   THREE.tn.camera = camera;              // the camera it draws it with
//   THREE.tn.onUpdate((dt) => {            // once per fixed tick; dt is the step in seconds
//     if (THREE.tn.input.isDown("w")) player.position.z -= 6 * dt;
//   });
//
// `tn.input.isDown(key)` is true while `key` is held; `key` is a DOM key ("w", "ArrowLeft", ...),
// the names the endpoint's injected input carries.
#include <libplatform/libplatform.h>
#include "engine/abi/binding.h"
#include "engine/renderer/render_target_pass.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <deque>
#include <fstream>
#include <cmath>
#include <map>
#include <optional>
#include <filesystem>
#include <cstdlib>
#include <memory>
#include <set>
#include <sstream>
#include <string>
#include <vector>

#include "adapters/v8/adapter.h"
#include "engine/abi/abi_internal.h"
#include "engine/inspect/endpoint.h"
#include "engine/player/run.h"
#include "mystral/platform/input.h"
#include "mystral/platform/ui_overlay.h"
#include <SDL3/SDL.h>
#include "engine/scene/camera.h"
#include "engine/scene/nodes.h"
#include "engine/scene/material.h"
#include "engine/scene/texture.h"
#include "engine/assets/package.h"
#include "engine/assets/gltf/loader.h"
#include "engine/assets/gltf/image_decode.h"
#include "engine/renderer/renderer.h"
#include "engine/renderer/render_database.h"
#include "mystral/webgpu_compat.h"
#include "adapters/v8/tsl.h"
#include "engine/shader/graph/serialized.h"
#include "mystral/audio/audio_bindings.h"
#include "mystral/js/engine.h"
#include "mystral/physics/native_bindings.h"

namespace mystral::js { std::unique_ptr<Engine> createV8Engine(); }
#if TN_PLAYER_CANVAS2D
#include "mystral/canvas/canvas2d.h"
namespace mystral::canvas {
js::JSValueHandle createCanvas2DContext(js::Engine* engine, int width, int height,
                                        std::vector<std::unique_ptr<Canvas2DContext>>& ownedContexts);
}
#endif

using namespace tn::engine;

namespace {

v8::Local<v8::String> v8str(v8::Isolate* isolate, const std::string& s) {
    return v8::String::NewFromUtf8(isolate, s.c_str(), v8::NewStringType::kNormal, static_cast<int>(s.size()))
        .ToLocalChecked();
}

// The host object, defined before the bundle so the bundle imports nothing. `isDown` reads the
// held-key set; `onUpdate`, `scene` and `camera` are plain JS properties the host reads.
constexpr const char* kPrelude = R"JS(
globalThis.tn = {
  __update: null,
  onUpdate(fn) { globalThis.tn.__update = fn; },
  // Called once per presented frame with the frame clock in ms (requestAnimationFrame's timestamp).
  __frame: null,
  onFrame(fn) { globalThis.tn.__frame = fn; },
  input: { isDown(key) { return __tnIsDown(String(key)); } },
};
)JS";

// `__tnHeldCodes()`: every held key by code, so the host shim raises keydown/keyup for any key a game
// binds (Midway's KeyW throttle), not only the arrows.
void heldCodesCallback(const v8::FunctionCallbackInfo<v8::Value>& info) {
    auto* codes = static_cast<std::set<std::string>*>(info.Data().As<v8::External>()->Value());
    v8::Isolate* isolate = info.GetIsolate();
    v8::Local<v8::Array> list = v8::Array::New(isolate, int(codes->size()));
    uint32_t index = 0;
    for (const std::string& code : *codes)
        list->Set(isolate->GetCurrentContext(), index++, v8str(isolate, code)).Check();
    info.GetReturnValue().Set(list);
}

void isDownCallback(const v8::FunctionCallbackInfo<v8::Value>& info) {
    auto* held = static_cast<std::set<std::string>*>(info.Data().As<v8::External>()->Value());
    v8::String::Utf8Value key(info.GetIsolate(), info[0]);
    const std::string name = *key ? *key : "";
    info.GetReturnValue().Set(held->count(name) != 0);
}

// Core's ui-bridge on native (PRD-554), as the legacy host installs it (runtime.cpp setupUiBridge):
// `__tnUiPost(frame)` sends a frame to the page, `__tnUiOverlayAttached()` says whether one listens.
void uiPostCallback(const v8::FunctionCallbackInfo<v8::Value>& info) {
    if (info.Length() < 1) return info.GetReturnValue().Set(false);
    v8::String::Utf8Value frame(info.GetIsolate(), info[0]);
    info.GetReturnValue().Set(mystral::platform::postUiMessage(*frame ? *frame : ""));
}

void uiAttachedCallback(const v8::FunctionCallbackInfo<v8::Value>& info) {
    info.GetReturnValue().Set(mystral::platform::uiOverlayAttached());
}

// `__tnPointerCapture(on)`: pointer lock as the legacy host gives it (runtime.cpp requestPointerLock),
// SDL relative mouse mode on the player's window; a refusal throws by name, as a browser's would.
void pointerCaptureCallback(const v8::FunctionCallbackInfo<v8::Value>& info) {
    const bool on = info.Length() > 0 && info[0]->BooleanValue(info.GetIsolate());
    int count = 0;
    SDL_Window** windows = SDL_GetWindows(&count);
    SDL_Window* window = windows != nullptr && count > 0 ? windows[0] : nullptr;
    SDL_free(windows);
    if (window == nullptr || !SDL_SetWindowRelativeMouseMode(window, on)) {
        const std::string message = std::string(on ? "Pointer capture failed" : "Pointer capture release failed") +
                                    (window == nullptr ? ": the player has no window" : std::string(": ") + SDL_GetError());
        info.GetIsolate()->ThrowException(v8::Exception::Error(v8str(info.GetIsolate(), message)));
    }
}

// The UI composite's cost for the frame budget's `ui` phase; 0 until the player composites (PRD-554 phase 2).
void uiCompositeMsCallback(const v8::FunctionCallbackInfo<v8::Value>& info) {
    info.GetReturnValue().Set(0.0);
}

void logCallback(const v8::FunctionCallbackInfo<v8::Value>& info) {
    for (int i = 0; i < info.Length(); ++i) {
        v8::String::Utf8Value message(info.GetIsolate(), info[i]);
        std::printf("%s%s", i == 0 ? "" : " ", *message ? *message : "?");
    }
    std::printf("\n");
}

/** A game bundle on V8: the isolate, the adapter, the `tn` host object and the native world it built. */
class V8Game {
  public:
    explicit V8Game(bool hasGpu = true) : hasGpu_(hasGpu) {}
    bool start(const std::string& path, std::string& error);
    ~V8Game();

    void attach(inspect::Endpoint& endpoint) { endpoint_ = &endpoint; }
    void tick(double dt);
    void safePoint();
    void initialize(Renderer& renderer);
    bool observe(const std::string& method, const json::Value* argument, json::Value& result, std::string& error);
    json::Value resource(const std::string& id, uint64_t tick) const;

    /** Binds the scene and camera the game last published (`tn.scene`/`tn.camera`): 1 bound, 0 not
     *  published yet (an async boot still loading), -1 a startup error or a value of the wrong kind. */
    int view(std::string& error);
    Object3D* scene() const { return scene_; }
    Camera* camera() const { return camera_; }
    bool shadowMapEnabled() const { return shadowMap_; }
    int shadowMapType() const { return shadowMapType_; }
    /** The renderer's clear colour and alpha (setClearColor), each frame's and each render target's. */
    std::array<double, 4> clearColor() const { return clear_; }
    /** Wrappers the adapter's safe points have looked at, and how many are alive (TN_PLAYER_CROSSINGS reports both). */
    uint64_t collectVisits() const { return adapter_ ? adapter_->collectVisits() : 0; }
    uint64_t liveWrappers() const { return adapter_ ? adapter_->liveWrappers() : 0; }

  private:
#if TN_PLAYER_CANVAS2D
    // Declared before services_ so the contexts outlive the JS objects that point at them.
    std::vector<std::unique_ptr<mystral::canvas::Canvas2DContext>> canvases_;
#endif
    std::unique_ptr<mystral::js::Engine> services_;
    v8::Isolate* isolate_ = nullptr;
    tn_context_t* context_ = nullptr;  // the engine's context (engine objects), not the JS one
    std::unique_ptr<tn::adapters::v8adapter::Adapter> adapter_;
    v8::Global<v8::Context> js_;
    v8::Global<v8::Function> update_;
    // A bridge answer that was a pending promise, and the request it answers: checked again on the
    // next poll instead of calling the bridge twice (describe() releases a held start once).
    v8::Global<v8::Promise> settling_;
    std::string settlingKey_;
    Object3D* scene_ = nullptr;
    Camera* camera_ = nullptr;
    // The host co-owns the world: the JS `tn.scene`/`tn.camera` is garbage after start(), and a
    // collected wrapper releases its handle, which must not free the scene under the frame loop.
    std::shared_ptr<void> sceneHold_, cameraHold_;
    std::set<std::string> held_;  // keys the game sees as held, by DOM key and by code, filled each tick
    std::set<std::string> heldCodes_;  // the same keys by code alone (`KeyW`), for the keydown events core reads
    /** A person's input from the window (platform/input.cpp's DOM-shaped events), queued until the tick that delivers it. */
    struct WindowInput {
        std::string type, code, key, pointerType;
        double x = 0, y = 0, movementX = 0, movementY = 0, deltaX = 0, deltaY = 0;
        int button = 0, buttons = 0, pointerId = 1;
        bool pointer = false;
    };
    std::deque<WindowInput> windowInput_;
    double pointerX_ = 0, pointerY_ = 0;  // the playtest mouse's last position, for movementX/Y
    bool pointerSeen_ = false;
    int pointerButtons_ = 0;
    void installWindowInput();
    void deliverWindowInput(v8::Local<v8::Context> ctx);
    inspect::Endpoint* endpoint_ = nullptr;
    std::string assetPath_;
    std::vector<uint8_t> assetBytes_;
    assets::Package assets_;
    shader::graph::Node post_;
    Renderer* renderer_ = nullptr;
    bool hasGpu_;
    // three's renderer settings the game last set (WebGPURenderer's defaults until it does).
    OutputState output_{std::nullopt, 1, true};
    // The GPU adapter's `info` fields, read before the bundle boots; empty without a GPU (a check).
    std::vector<std::pair<std::string, std::string>> adapterInfo_;
    // The last frame the player drew: three's `renderer.info.render` draw calls and triangles.
    uint32_t drawCalls_ = 0;
    uint64_t triangles_ = 0;
    uint64_t pipelineCompiles_ = 0;  // pipelines the renderer has compiled so far, cumulative
    // The newest resolved GPU time, as the Wasm engine reports it (tnw_web_frame 7..9, 19..23). Timing is off until a
    // reader asks (`tn.setGpuTimer`), since a timed frame resolves and reads back a query set every frame.
    bool gpuTimerWanted_ = false, gpuTimerRuns_ = false;
    uint64_t gpuSamples_ = 0, gpuSource_ = 0;
    uint64_t sourceFrame_ = 0;  // the game's `info.frame` at its last render(): the id the next drawn frame's GPU time reports
    double gpuMs_ = -1;
    std::array<double, kGpuSegments> gpuSegments_{};
    bool shadowMap_ = false;  // three's WebGPURenderer defaults: shadowMap off, PCFShadowMap
    int shadowMapType_ = 1;
    uint32_t samples_ = 1;
    std::array<double, 4> clear_{0, 0, 0, 1};  // three's WebGPURenderer clear colour: black, opaque
    bool outputChanged_ = true;
    static void loadAsset(const v8::FunctionCallbackInfo<v8::Value>& info);
    static void setRendererState(const v8::FunctionCallbackInfo<v8::Value>& info);
    static void requestAdapter(const v8::FunctionCallbackInfo<v8::Value>& info);
    static void renderInfo(const v8::FunctionCallbackInfo<v8::Value>& info);
    static void setGpuTimer(const v8::FunctionCallbackInfo<v8::Value>& info);
    static void surfaceSize(const v8::FunctionCallbackInfo<v8::Value>& info);
    v8::Local<v8::Value> adapterValue();
  public:
    void setAdapter(std::vector<std::pair<std::string, std::string>> info) { adapterInfo_ = std::move(info); }
    void frameDrawn(const Renderer& renderer) {
        // three's renderer.info.render counts every pass of a render(): the shadow pass's draws and
        // triangles are in it, so a scene is counted the same on both backends.
        drawCalls_ = renderer.lastFrame().draws + renderer.lastFrame().shadowDraws;
        triangles_ = renderer.lastFrame().triangles + renderer.lastFrame().shadowTriangles;
        pipelineCompiles_ = renderer.pipelines().compiles();
        gpuTimerRuns_ = renderer.gpuTimerEnabled();
        gpuSamples_ = renderer.gpuSamples();
        gpuSource_ = renderer.gpuSourceFrame();
        gpuMs_ = renderer.lastGpuMs();
        gpuSegments_ = renderer.lastGpuSegments();
        frameClockMs_ += std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - frameStartedAt_).count();
        profileFrame();
    }
    /** The page's queued frames, on the thread that owns JavaScript (legacy runtime.cpp drainUiMessages):
     *  hit regions stay with the host, everything else goes to core's `__tnUiGameReceive`. */
    void uiFrame();
    /** A frame with nothing to draw yet: the game's frame callbacks still run (run.h frameWithoutView). */
    void frameWithoutView() { presentFrame(); flushCompute(); profileFrame(false); }
    /** PRD-613: the loop's wait for the frame its render thread has in flight; absent without that thread. */
    void setRenderBarrier(std::function<void()> barrier) { renderBarrier_ = std::move(barrier); }
    void beforeRender(Renderer& renderer, RenderDatabase& database) {
        presentFrame();  // the game's frame callbacks may change the renderer state applied below
        idleRenderer();  // the settings below are the renderer's own, so the frame in flight ends first
        flushCompute();  // PRD-620: kernels queued this frame run ahead of its passes
        if (outputChanged_) renderer.setOutput(output_);
        outputChanged_ = false;
        renderer.setSampleCount(samples_);
        renderer.setGpuTimerSourceFrame(sourceFrame_);
        database.shadowMapEnabled = shadowMap_;
        database.shadowMapType = shadowMapType_;
    }
    /** run.h overlay: 0 for no overlay this frame, 1 over the world frame, 2 alone (a held loader frame drew no world). */
    int overlay() const { return !overlaySceneHold_ ? 0 : overlayAlone_ ? 2 : 1; }
    /** run.h drawOverlay: this frame's overlay over the renderer's output frame, as web_host.cpp draws it over the canvas. */
    void drawOverlay(Renderer& renderer) {
        const auto scene = std::exchange(overlaySceneHold_, nullptr);
        const auto camera = std::exchange(overlayCameraHold_, nullptr);
        if (!scene || !renderer.outputColorView()) return;
        Renderer& target = renderer.overlayRenderer();
        Renderer::PresentScope present(target, renderer.outputColorView(), WGPUTextureFormat_RGBA8Unorm);
        overlayDatabase_.render(target, *static_cast<Object3D*>(scene.get()), *static_cast<Camera*>(camera.get()), {0, 0, 0, 0});
        for (const std::string& diagnostic : overlayDatabase_.diagnostics()) std::printf("[Playtest] %s\n", diagnostic.c_str());
    }
  private:
    // three's overlay render of this frame (tn.renderOverlay), drawn by the loop after the world frame.
    std::shared_ptr<void> overlaySceneHold_, overlayCameraHold_;
    bool overlayAlone_ = false;
    RenderDatabase overlayDatabase_;
    static void renderOverlay(const v8::FunctionCallbackInfo<v8::Value>& info);
    // Everything this game does to the renderer outside the loop's own handoff calls this first.
    void idleRenderer() { if (renderBarrier_) renderBarrier_(); }
    std::function<void()> renderBarrier_;
    void presentFrame();
    void profileFrame(bool drawn = true);
#if TN_JS_PROFILE || TN_ANDROID_JS_PROFILE
    uint64_t profileFrames_ = 0;
#endif
    // The frame clock tn.onFrame reads: it moves only by each presented frame's own duration, from
    // the game's frame callbacks through present (the TN_FRAME_BUDGET quantity, owner 2026-10-08),
    // so a runner's tick batches and idle waits between frames are never counted as frame time.
    std::chrono::steady_clock::time_point frameStartedAt_ = std::chrono::steady_clock::now();
    double frameClockMs_ = 0;
    static void setPost(const v8::FunctionCallbackInfo<v8::Value>& info);
    static void renderTarget(const v8::FunctionCallbackInfo<v8::Value>& info);
    static void hasRenderer(const v8::FunctionCallbackInfo<v8::Value>& info);
    static void captureFace(const v8::FunctionCallbackInfo<v8::Value>& info);
    static void readTarget(const v8::FunctionCallbackInfo<v8::Value>& info);
    static void readFrame(const v8::FunctionCallbackInfo<v8::Value>& info);
    /** PRD-620: `tn.compute(node | [node])`, `tn.readStorage(attribute)` and `tn.deleteStorage(attribute)`. */
    static void compute(const v8::FunctionCallbackInfo<v8::Value>& info);
    static void readStorage(const v8::FunctionCallbackInfo<v8::Value>& info);
    static void deleteStorage(const v8::FunctionCallbackInfo<v8::Value>& info);
    /** Submits the queued kernels and readbacks in call order; the frame in flight ends first. */
    void flushCompute();
    ComputeQueue computeQueue_;
    /** Settles a read promise from the GPU event drain: bytes as a Uint8Array (an ArrayBuffer for a storage read), or a rejection. */
    void settleRead(v8::Global<v8::Promise::Resolver>& pending, GpuStatus status, const std::vector<uint8_t>& bytes, bool asBuffer = false);
    static void compileAsync(const v8::FunctionCallbackInfo<v8::Value>& info);
    static void prepareEnvironment(const v8::FunctionCallbackInfo<v8::Value>& info);
    struct Compilation {
        std::shared_ptr<void> root, camera, scene;
        OutputState output;
        bool shadows;
        int shadowType;
        uint32_t samples;
        v8::Global<v8::Promise::Resolver> resolver;
        std::optional<std::vector<std::shared_ptr<PipelineCompilation>>> pipelines;
    };
    std::vector<Compilation> compilations_;
    void pollCompilations();
    /** The engine object a JS wrapper stands for, when it is one of `cls` (or any Object3D for "Object3D"). */
    tn::binding::Object* engineObject(v8::Local<v8::Value> value, std::string_view cls);
    static void decodeImage(const v8::FunctionCallbackInfo<v8::Value>& info);
    void installDocument(v8::Local<v8::Context> ctx);
};

// `document.createElement("canvas")` for a game's procedural textures, over the legacy host's Skia 2D
// context. The element's size is read when getContext("2d") runs, as a game sets width and height first.
// A build without Skia answers getContext with null and says so once, never a context that draws nothing.
constexpr const char* kDocumentShim = R"JS(
(() => {
  if (typeof globalThis.document !== "undefined") return;
  const create2d = globalThis.__tnCreateCanvas2D;
  let warned = false;
  const canvas = () => {
    const el = { tagName: "CANVAS", width: 300, height: 150, style: {}, __ctx: null, __size: "" };
    el.getContext = (type) => {
      if (type !== "2d") return null;
      if (!create2d) {
        if (!warned) {
          warned = true;
          console.warn("TN_PLAYER_CANVAS2D_UNAVAILABLE: this player build has no 2D canvas; canvas.getContext('2d') answers null");
        }
        return null;
      }
      const size = el.width + "x" + el.height;
      if (el.__ctx === null || el.__size !== size) {
        el.__ctx = create2d(el.width, el.height);
        el.__ctx.canvas = el;
        el.__size = size;
      }
      return el.__ctx;
    };
    // ctx.drawImage(otherCanvas, ...) finds the source's context here, as the legacy host's elements expose it.
    Object.defineProperty(el, "_context2d", { get: () => el.getContext("2d") });
    el.toDataURL = () => { throw new Error("TN_PLAYER_CANVAS_TODATAURL: canvas.toDataURL is not available in the engine player"); };
    return el;
  };
  globalThis.document = {
    createElement: (tag) => {
      if (String(tag).toLowerCase() === "canvas") return canvas();
      throw new Error("TN_PLAYER_DOCUMENT: document.createElement('" + tag + "') is not available in the engine player");
    },
  };
  globalThis.document.createElementNS = (_ns, tag) => globalThis.document.createElement(tag);
})();
)JS";

void V8Game::installDocument(v8::Local<v8::Context> ctx) {
#if TN_PLAYER_CANVAS2D
    mystral::js::Engine* engine = services_.get();
    engine->setGlobalProperty("__tnCreateCanvas2D",
        engine->newFunction("__tnCreateCanvas2D", [this, engine](void*, const std::vector<mystral::js::JSValueHandle>& args) {
            const int width = args.size() > 0 ? static_cast<int>(engine->toNumber(args[0])) : 300;
            const int height = args.size() > 1 ? static_cast<int>(engine->toNumber(args[1])) : 150;
            if (width <= 0 || height <= 0 || width > 16384 || height > 16384) {
                engine->throwException("TN_PLAYER_CANVAS2D_SIZE: canvas size must be 1..16384 pixels");
                return engine->newUndefined();
            }
            return mystral::canvas::createCanvas2DContext(engine, width, height, canvases_);
        }));
#endif
    v8::Local<v8::Script> shim;
    v8::Local<v8::Value> ignored;
    if (!v8::Script::Compile(ctx, v8str(isolate_, kDocumentShim)).ToLocal(&shim) || !shim->Run(ctx).ToLocal(&ignored))
        std::cerr << "TN_PLAYER_DOCUMENT: the document shim failed to install\n";
}

void V8Game::loadAsset(const v8::FunctionCallbackInfo<v8::Value>& info) {
    auto& game = *static_cast<V8Game*>(info.Data().As<v8::External>()->Value());
    auto* isolate = info.GetIsolate();
    auto ctx = isolate->GetCurrentContext();
    const auto refuse = [&](const std::string& reason) {
        isolate->ThrowException(v8::Exception::Error(v8str(isolate, reason)));
    };
    if (info.Length() != 2 || !info[0]->IsString() || !info[1]->IsString())
        return refuse("TN_NATIVE_ASSET_INVALID: expected kind and logical path strings");
    v8::String::Utf8Value kindValue(isolate, info[0]), pathValue(isolate, info[1]);
    const std::string kind(*kindValue, kindValue.length()), path(*pathValue, pathValue.length());
    if (kind != "model" && kind != "texture" && kind != "audio" && kind != "buffer")
        return refuse("TN_NATIVE_ASSET_KIND_UNSUPPORTED: " + kind);
    if (game.assetBytes_.empty()) {
        std::ifstream file(game.assetPath_, std::ios::binary | std::ios::ate);
        const auto size = file.tellg();
        if (!file || size <= 0 || size > 512 * 1024 * 1024)
            return refuse("TN_NATIVE_ASSET_PACKAGE_MISSING: " + game.assetPath_);
        std::vector<uint8_t> bytes(static_cast<size_t>(size));
        file.seekg(0);
        if (!file.read(reinterpret_cast<char*>(bytes.data()), size))
            return refuse("TN_NATIVE_ASSET_PACKAGE_READ: " + game.assetPath_);
        assets::Package package;
        assets::PackageError error;
        if (!assets::parsePackage(bytes, package, error) ||
            !assets::verifyPackage(package, assets::targetDecoders(), error))
            return refuse(error.code + ": " + error.detail);
        game.assetBytes_ = std::move(bytes);
        game.assets_ = std::move(package);
        game.assets_.bytes = game.assetBytes_;
    }
    const assets::PackageEntry* entry = nullptr;
    for (const auto& candidate : game.assets_.entries)
        if (candidate.name == path) { entry = &candidate; break; }
    // As on the web, a relative path the cook does not name is a web-root URL: the package names
    // hand-placed web-root files `/` plus their path there (packages/assets nativePackageEntries).
    for (const auto& candidate : game.assets_.entries)
        if (!entry && !path.empty() && path[0] != '/' && candidate.name == "/" + path) entry = &candidate;
    if (!entry) return refuse("TN_NATIVE_ASSET_MISSING: " + path + " in " + game.assetPath_);
    auto data = game.assets_.data(*entry);
    v8::Local<v8::Value> value;
    if (kind == "model") {
#if TN_PLAYER_NATIVE_GLTF
        if (entry->kind != static_cast<uint16_t>(assets::EntryKind::Scene))
            return refuse("TN_NATIVE_ASSET_KIND_MISMATCH: model requires a Scene entry: " + path);
        // An image the model names by relative uri is another entry of the package, beside the model.
        gltf::LoadOptions options;
        options.readUri = [&](const std::string& uri) -> std::span<const uint8_t> {
            const std::string directory = path.substr(0, path.find_last_of('/') == std::string::npos ? 0 : path.find_last_of('/') + 1);
            for (const auto& candidate : game.assets_.entries)
                if (candidate.name == directory + uri || candidate.name == "/" + directory + uri)
                    return game.assets_.data(candidate);
            return {};
        };
        auto loaded = gltf::load(data, options);
        if (!loaded.error.empty()) return refuse(loaded.error);
        bool undecoded = false;
        loaded.scene->traverse([](Object3D& object, void* result) {
            auto* mesh = dynamic_cast<Mesh*>(&object);
            if (!mesh || !mesh->material) return;
            for (const auto& [slot, map] : mesh->material->maps)
                if (map && !map->hasImage()) *static_cast<bool*>(result) = true;
        }, &undecoded);
        if (undecoded) return refuse("TN_NATIVE_GLTF_IMAGE_UNSUPPORTED: model has undecoded images: " + path);
        auto model = v8::Object::New(isolate);
        model->Set(ctx, v8str(isolate, "scene"), game.adapter_->wrap(
            tn::abi::shareObject(game.context_, "Group", loaded.scene))).Check();
        auto clips = v8::Array::New(isolate, static_cast<int>(loaded.animations.size()));
        for (uint32_t i = 0; i < loaded.animations.size(); ++i)
            clips->Set(ctx, i, game.adapter_->wrap(tn::abi::shareObject(
                game.context_, "AnimationClip", loaded.animations[i]))).Check();
        model->Set(ctx, v8str(isolate, "animations"), clips).Check();
        value = model;
#else
        return refuse("TN_NATIVE_GLTF_UNAVAILABLE: this player was built without cgltf");
#endif
    } else if (kind == "audio") {
        // The cooked package carries audio as its encoded bytes; WebAudio's decodeAudioData decodes them.
        if (entry->kind != static_cast<uint16_t>(assets::EntryKind::Buffer))
            return refuse("TN_NATIVE_ASSET_KIND_MISMATCH: audio requires a Buffer entry: " + path);
        auto bytes = v8::ArrayBuffer::New(isolate, data.size());
        std::copy(data.begin(), data.end(), static_cast<uint8_t*>(bytes->Data()));
        value = bytes;
    } else if (kind == "buffer") {
        // Raw bytes a JS decoder parses (an HDRLoader's .hdr), copied out of the package.
        if (entry->kind != static_cast<uint16_t>(assets::EntryKind::Buffer))
            return refuse("TN_NATIVE_ASSET_KIND_MISMATCH: buffer requires a Buffer entry: " + path);
        auto buffer = v8::ArrayBuffer::New(isolate, data.size());
        if (!data.empty()) std::memcpy(buffer->Data(), data.data(), data.size());
        value = buffer;
    } else {
        if (entry->kind != static_cast<uint16_t>(assets::EntryKind::Texture) || data.size() < 12)
            return refuse("TN_NATIVE_ASSET_KIND_MISMATCH: texture requires an RGBA8 Texture entry: " + path);
        const auto u32 = [&](size_t at) { return uint32_t(data[at]) | (uint32_t(data[at+1]) << 8) |
            (uint32_t(data[at+2]) << 16) | (uint32_t(data[at+3]) << 24); };
        const uint32_t width = u32(0), height = u32(4), format = u32(8);
        if (!width || !height || uint64_t(width) * height > (data.size() - 12) / 4 ||
            uint64_t(width) * height * 4 != data.size() - 12 ||
            (format != 18 && format != 19 && format != 22 && format != 23))
            return refuse("TN_NATIVE_ASSET_TEXTURE_INVALID: " + path);
        auto texture = std::make_shared<Texture>();
        texture->name = path;
        texture->width = width; texture->height = height;
        texture->colorSpace = format == 19 || format == 23 ? TextureColorSpace::SRGB : TextureColorSpace::None;
        texture->data.assign(data.begin() + 12, data.end());
        texture->needsUpdate();
        value = game.adapter_->wrap(tn::abi::shareObject(game.context_, "Texture", texture));
    }
    auto record = v8::Object::New(isolate);
    record->Set(ctx, v8str(isolate, "value"), value).Check();
    record->Set(ctx, v8str(isolate, "bytes"), v8::Number::New(isolate, static_cast<double>(entry->size))).Check();
    record->Set(ctx, v8str(isolate, "url"), v8str(isolate, game.assetPath_ + "#" + path)).Check();
    info.GetReturnValue().Set(record);
}

// `tn.setRendererState({toneMapping, toneMappingExposure, outputColorSpace, shadowMap: {enabled, type}})`:
// the facade's WebGPURenderer settings, applied before the next frame. A value the native renderer
// does not implement is refused by name, never mapped to a neighbour.
void V8Game::setRendererState(const v8::FunctionCallbackInfo<v8::Value>& info) {
    auto& game = *static_cast<V8Game*>(info.Data().As<v8::External>()->Value());
    auto* isolate = info.GetIsolate();
    const auto ctx = isolate->GetCurrentContext();
    const auto refuse = [&](const std::string& reason) {
        isolate->ThrowException(v8::Exception::TypeError(v8str(isolate, "TN_NATIVE_RENDERER_STATE: " + reason)));
    };
    if (info.Length() != 1 || !info[0]->IsObject()) return refuse("expected one settings object");
    const auto settings = info[0].As<v8::Object>();
    v8::Local<v8::Value> mapping, exposure, colorSpace, shadowMap, enabled, type;
    if (!settings->Get(ctx, v8str(isolate, "toneMapping")).ToLocal(&mapping) ||
        !settings->Get(ctx, v8str(isolate, "toneMappingExposure")).ToLocal(&exposure) ||
        !settings->Get(ctx, v8str(isolate, "outputColorSpace")).ToLocal(&colorSpace) ||
        !settings->Get(ctx, v8str(isolate, "shadowMap")).ToLocal(&shadowMap))
        return;
    if (!mapping->IsNumber() || !exposure->IsNumber() || !std::isfinite(exposure.As<v8::Number>()->Value()) ||
        !colorSpace->IsString() || !shadowMap->IsObject())
        return refuse("toneMapping, toneMappingExposure, outputColorSpace and shadowMap are required");
    if (!shadowMap.As<v8::Object>()->Get(ctx, v8str(isolate, "enabled")).ToLocal(&enabled) ||
        !shadowMap.As<v8::Object>()->Get(ctx, v8str(isolate, "type")).ToLocal(&type))
        return;
    v8::String::Utf8Value space(isolate, colorSpace);
    std::string refusal;
    shader::graph::Node custom;
    v8::Local<v8::Value> customValue;
    if (!settings->Get(ctx, v8str(isolate, "__customToneMapping")).ToLocal(&customValue)) return;
    if (!customValue->IsNullOrUndefined() && !game.adapter_->tsl().unwrap(customValue, custom))
        return refuse("TN_NATIVE_CUSTOM_TONEMAPPING_TYPE: expected a TSL node");
    const auto state = outputStateOf(mapping.As<v8::Number>()->Value(), exposure.As<v8::Number>()->Value(),
                                     std::string(*space, space.length()), refusal, custom);
    if (!state) return refuse(refusal);
    // PCFShadowMap and PCFSoftShadowMap are the filters the engine draws (PCFShadowFilter, PCFSoftShadowFilter).
    if (!enabled->IsBoolean() || !type->IsNumber() || (type.As<v8::Number>()->Value() != 1 && type.As<v8::Number>()->Value() != 2))
        return refuse("shadowMap.enabled must be a boolean and shadowMap.type PCFShadowMap or PCFSoftShadowMap");
    const OutputState output = *state;
    if (output.toneMapping != game.output_.toneMapping || output.toneMappingExposure != game.output_.toneMappingExposure ||
        output.srgb != game.output_.srgb || output.customToneMapping != game.output_.customToneMapping) {
        game.output_ = output;
        game.outputChanged_ = true;
    }
    game.shadowMap_ = enabled->IsTrue();
    game.shadowMapType_ = static_cast<int>(type.As<v8::Number>()->Value());
    v8::Local<v8::Value> samples;
    if (settings->Get(ctx, v8str(isolate, "samples")).ToLocal(&samples) && samples->IsNumber()) {
        const double s = samples.As<v8::Number>()->Value();
        game.samples_ = s == 4 ? 4 : 1;
    }
    // The frame id core counts presented frames with (`info.frame`), so a GPU time says which frame it belongs to.
    v8::Local<v8::Value> frameInfo, frameId;
    if (settings->Get(ctx, v8str(isolate, "info")).ToLocal(&frameInfo) && frameInfo->IsObject() &&
        frameInfo.As<v8::Object>()->Get(ctx, v8str(isolate, "frame")).ToLocal(&frameId) && frameId->IsNumber() &&
        frameId.As<v8::Number>()->Value() >= 0)
        game.sourceFrame_ = static_cast<uint64_t>(frameId.As<v8::Number>()->Value());
    // The facade's clear colour and alpha (setClearColor), linear, as `__clearColor: [r, g, b, a]`.
    v8::Local<v8::Value> clear;
    if (settings->Get(ctx, v8str(isolate, "__clearColor")).ToLocal(&clear) && clear->IsArray()) {
        const auto lanes = clear.As<v8::Array>();
        std::array<double, 4> value{};
        for (uint32_t i = 0; i < 4; ++i) {
            v8::Local<v8::Value> lane;
            if (!lanes->Get(ctx, i).ToLocal(&lane) || !lane->IsNumber() || !std::isfinite(lane.As<v8::Number>()->Value()))
                return refuse("__clearColor must be four finite numbers");
            value[i] = lane.As<v8::Number>()->Value();
        }
        game.clear_ = value;
    }
}

// three's `adapter` as the facade backend hands it out: `{ info: { architecture, ... }, limits: {} }`,
// or null when this run has no GPU.
v8::Local<v8::Value> V8Game::adapterValue() {
    if (adapterInfo_.empty()) return v8::Null(isolate_);
    auto ctx = isolate_->GetCurrentContext();
    auto info = v8::Object::New(isolate_);
    for (const auto& [name, value] : adapterInfo_) info->Set(ctx, v8str(isolate_, name), v8str(isolate_, value)).Check();
    auto adapter = v8::Object::New(isolate_);
    adapter->Set(ctx, v8str(isolate_, "info"), info).Check();
    adapter->Set(ctx, v8str(isolate_, "limits"), v8::Object::New(isolate_)).Check();
    return adapter;
}

// `tn.renderInfo()`: { drawCalls, triangles } of the last frame the player drew, and the renderer's
// cumulative pipelineCompiles (a window's compiles are the difference between two reads), the samples the scene draws
// with, and the temporal pass as the last planned frame left it: { active, frame, historyValid, jitter: [x, y], rejected,
// clamped, pixels, countedFrame } (the last four are the newest counted frame, one in 16).
// `gpuTiming` is the newest resolved GPU time once `tn.setGpuTimer(true)` asked for it: { enabled, samples, source, ms, segments }
// (segments: shadow, scene, other, output passes, then the stages a post pass is labelled with, frame_gpu_timer.h).
void V8Game::renderInfo(const v8::FunctionCallbackInfo<v8::Value>& info) {
    auto& game = *static_cast<V8Game*>(info.Data().As<v8::External>()->Value());
    auto* isolate = info.GetIsolate();
    auto ctx = isolate->GetCurrentContext();
    auto record = v8::Object::New(isolate);
    record->Set(ctx, v8str(isolate, "drawCalls"), v8::Number::New(isolate, game.drawCalls_)).Check();
    record->Set(ctx, v8str(isolate, "triangles"), v8::Number::New(isolate, static_cast<double>(game.triangles_))).Check();
    record->Set(ctx, v8str(isolate, "pipelineCompiles"), v8::Number::New(isolate, static_cast<double>(game.pipelineCompiles_))).Check();
    const Renderer::TemporalStatus temporal = game.renderer_ ? game.renderer_->temporalStatus() : Renderer::TemporalStatus{};
    record->Set(ctx, v8str(isolate, "samples"), v8::Number::New(isolate, game.renderer_ ? game.renderer_->sampleCount() : 1)).Check();
    auto status = v8::Object::New(isolate);
    status->Set(ctx, v8str(isolate, "active"), v8::Boolean::New(isolate, temporal.active)).Check();
    status->Set(ctx, v8str(isolate, "frame"), v8::Number::New(isolate, static_cast<double>(temporal.frame))).Check();
    status->Set(ctx, v8str(isolate, "historyValid"), v8::Boolean::New(isolate, temporal.historyValid)).Check();
    status->Set(ctx, v8str(isolate, "rejected"), v8::Number::New(isolate, temporal.rejected)).Check();
    status->Set(ctx, v8str(isolate, "clamped"), v8::Number::New(isolate, temporal.clamped)).Check();
    status->Set(ctx, v8str(isolate, "pixels"), v8::Number::New(isolate, temporal.pixels)).Check();
    status->Set(ctx, v8str(isolate, "countedFrame"), v8::Number::New(isolate, static_cast<double>(temporal.countedFrame))).Check();
    v8::Local<v8::Value> jitter[] = {v8::Number::New(isolate, temporal.jitterX), v8::Number::New(isolate, temporal.jitterY)};
    status->Set(ctx, v8str(isolate, "jitter"), v8::Array::New(isolate, jitter, 2)).Check();
    record->Set(ctx, v8str(isolate, "temporal"), status).Check();
    auto timing = v8::Object::New(isolate);
    timing->Set(ctx, v8str(isolate, "enabled"), v8::Boolean::New(isolate, game.gpuTimerRuns_)).Check();
    timing->Set(ctx, v8str(isolate, "samples"), v8::Number::New(isolate, static_cast<double>(game.gpuSamples_))).Check();
    timing->Set(ctx, v8str(isolate, "source"), v8::Number::New(isolate, static_cast<double>(game.gpuSource_))).Check();
    timing->Set(ctx, v8str(isolate, "ms"), v8::Number::New(isolate, game.gpuMs_)).Check();
    v8::Local<v8::Value> segments[kGpuSegments];
    for (size_t i = 0; i < kGpuSegments; ++i) segments[i] = v8::Number::New(isolate, game.gpuSegments_[i]);
    timing->Set(ctx, v8str(isolate, "segments"), v8::Array::New(isolate, segments, kGpuSegments)).Check();
    record->Set(ctx, v8str(isolate, "gpuTiming"), timing).Check();
    info.GetReturnValue().Set(record);
}

// `tn.setGpuTimer(on)`: the first reader of GPU times turns frame timing on; a game that never reads them pays nothing.
void V8Game::setGpuTimer(const v8::FunctionCallbackInfo<v8::Value>& info) {
    auto& game = *static_cast<V8Game*>(info.Data().As<v8::External>()->Value());
    game.gpuTimerWanted_ = info.Length() > 0 && info[0]->BooleanValue(info.GetIsolate());
    if (game.renderer_) game.renderer_->setGpuTimer(game.gpuTimerWanted_);
}

// `tn.surfaceSize()`: { width, height } of the drawing buffer. The player owns the window, so a game's
// setSize cannot change it; the facade's getDrawingBufferSize reports this rather than the size it was asked for.
void V8Game::surfaceSize(const v8::FunctionCallbackInfo<v8::Value>& info) {
    auto& game = *static_cast<V8Game*>(info.Data().As<v8::External>()->Value());
    auto* isolate = info.GetIsolate();
    auto ctx = isolate->GetCurrentContext();
    const player::SurfaceSize size = game.renderer_ ? player::SurfaceSize{game.renderer_->width(), game.renderer_->height()}
                                                    : player::configuredSurface();
    auto record = v8::Object::New(isolate);
    record->Set(ctx, v8str(isolate, "width"), v8::Number::New(isolate, size.width)).Check();
    record->Set(ctx, v8str(isolate, "height"), v8::Number::New(isolate, size.height)).Check();
    info.GetReturnValue().Set(record);
}

void V8Game::requestAdapter(const v8::FunctionCallbackInfo<v8::Value>& info) {
    auto& game = *static_cast<V8Game*>(info.Data().As<v8::External>()->Value());
    auto ctx = info.GetIsolate()->GetCurrentContext();
    auto resolver = v8::Promise::Resolver::New(ctx).ToLocalChecked();
    resolver->Resolve(ctx, game.adapterValue()).Check();
    info.GetReturnValue().Set(resolver->GetPromise());
}

// createImageBitmap's decode: PNG or JPEG bytes through the engine's image decoder (PRD-515) into
// an RGBA8 Texture, rows as stored. `{ texture, width, height }`, or a TN_NATIVE_IMAGE_DECODE refusal.
void V8Game::decodeImage(const v8::FunctionCallbackInfo<v8::Value>& info) {
    auto& game = *static_cast<V8Game*>(info.Data().As<v8::External>()->Value());
    auto* isolate = info.GetIsolate();
    auto ctx = isolate->GetCurrentContext();
    std::vector<uint8_t> bytes;
    if (info.Length() == 1 && info[0]->IsArrayBufferView()) {
        auto view = info[0].As<v8::ArrayBufferView>();
        bytes.resize(view->ByteLength());
        view->CopyContents(bytes.data(), bytes.size());
    } else if (info.Length() == 1 && info[0]->IsArrayBuffer()) {
        auto buffer = info[0].As<v8::ArrayBuffer>();
        const auto* data = static_cast<const uint8_t*>(buffer->Data());
        bytes.assign(data, data + buffer->ByteLength());
    } else {
        isolate->ThrowException(v8::Exception::TypeError(v8str(isolate,
            "TN_NATIVE_IMAGE_DECODE: expected the encoded image as an ArrayBuffer or typed array")));
        return;
    }
#if TN_PLAYER_NATIVE_GLTF
    auto texture = std::make_shared<Texture>();
    if (gltf::imageFormat(bytes.data(), bytes.size()) == gltf::ImageFormat::Unknown ||
        !gltf::decodeImage(bytes.data(), bytes.size(), texture->width, texture->height, texture->data)) {
        isolate->ThrowException(v8::Exception::Error(v8str(isolate,
            "TN_NATIVE_IMAGE_DECODE: the bytes are not a PNG, JPEG or WebP this decoder reads, or the image is damaged or larger than 8192")));
        return;
    }
    texture->needsUpdate();
    const uint32_t width = texture->width, height = texture->height;
    auto record = v8::Object::New(isolate);
    record->Set(ctx, v8str(isolate, "texture"), game.adapter_->wrap(
        tn::abi::shareObject(game.context_, "Texture", std::move(texture)))).Check();
    record->Set(ctx, v8str(isolate, "width"), v8::Number::New(isolate, width)).Check();
    record->Set(ctx, v8str(isolate, "height"), v8::Number::New(isolate, height)).Check();
    info.GetReturnValue().Set(record);
#else
    (void)game; (void)ctx;
    isolate->ThrowException(v8::Exception::Error(v8str(isolate,
        "TN_NATIVE_IMAGE_DECODE: this player was built without the engine image decoder")));
#endif
}

tn::binding::Object* V8Game::engineObject(v8::Local<v8::Value> value, std::string_view cls) {
    tn_handle_t handle{};
    if (!adapter_->unwrap(value, handle)) return nullptr;
    auto* object = tn::abi::objectOf(handle);
    if (object == nullptr) return nullptr;
    const bool matches = cls == "Object3D" ? tn::binding::isObject3DClass(object->cls)
                         : cls == "Camera" ? object->cls == "PerspectiveCamera" || object->cls == "OrthographicCamera"
                                           : object->cls == cls;
    return matches ? object : nullptr;
}

// `tn.renderTarget(target, root, camera)`: three's render() while a render target is set (PRD-551),
// drawn at the call (the next statement may sample the target), into the target's own renderer.
void V8Game::renderTarget(const v8::FunctionCallbackInfo<v8::Value>& info) {
    auto& game = *static_cast<V8Game*>(info.Data().As<v8::External>()->Value());
    auto* isolate = info.GetIsolate();
    const auto refuse = [&](const std::string& reason) {
        isolate->ThrowException(v8::Exception::Error(v8str(isolate, reason)));
    };
    if (game.renderer_ == nullptr) return refuse("TN_NATIVE_RENDER_TARGET: the player has no renderer before its first frame");
    // The optional fourth argument defers the draw to the frame that samples the target (an offscreen PassNode).
    const bool shaped = info.Length() == 3 || (info.Length() == 4 && info[3]->IsBoolean());
    auto* target = shaped ? game.engineObject(info[0], "RenderTarget") : nullptr;
    auto* root = shaped ? game.engineObject(info[1], "Object3D") : nullptr;
    auto* camera = shaped ? game.engineObject(info[2], "Camera") : nullptr;
    if (target == nullptr || root == nullptr || camera == nullptr)
        return refuse("TN_NATIVE_RENDER_TARGET: expected a RenderTarget, an Object3D and a camera");
    game.idleRenderer();
    game.flushCompute();  // a material in the target may read what a queued kernel writes
    // three's WebGPURenderer clears a target to its clear colour (setClearColor), black and opaque by default.
    const auto refused = renderToTarget(*game.renderer_, *static_cast<RenderTarget*>(target->ptr.get()),
                                        *static_cast<Object3D*>(root->ptr.get()), *static_cast<Camera*>(camera->ptr.get()),
                                        game.clear_, game.shadowMap_, info.Length() == 4 && info[3]->BooleanValue(isolate));
    if (!refused.empty()) refuse(refused.front());
}

// `tn.hasRenderer()`: whether the player has opened its renderer. The game's startup runs before it,
// so a render() then only publishes the scene, and a draw into a render target has nothing to draw with.
void V8Game::hasRenderer(const v8::FunctionCallbackInfo<v8::Value>& info) {
    auto& game = *static_cast<V8Game*>(info.Data().As<v8::External>()->Value());
    info.GetReturnValue().Set(game.renderer_ != nullptr);
}

void V8Game::settleRead(v8::Global<v8::Promise::Resolver>& pending, GpuStatus status, const std::vector<uint8_t>& bytes, bool asBuffer) {
    // The GPU event drain calls this outside every frame callback, and settling the promise runs
    // the game's continuation: with the isolate not entered, a hot loop there crashes V8 on a
    // null current isolate the first time it asks for on-stack replacement.
    v8::Isolate::Scope isolateScope(isolate_);
    v8::HandleScope scope(isolate_);
    auto context = js_.Get(isolate_);
    v8::Context::Scope contextScope(context);
    auto settle = pending.Get(isolate_);
    if (status != GpuStatus::Ok) {
        settle->Reject(context, v8::Exception::Error(v8str(isolate_, asBuffer ? "TN_NATIVE_READ_STORAGE: the read failed"
                                                                              : "TN_NATIVE_READ_TARGET: the read failed"))).Check();
        return;
    }
    auto buffer = v8::ArrayBuffer::New(isolate_, bytes.size());
    std::memcpy(buffer->Data(), bytes.data(), bytes.size());
    if (asBuffer) settle->Resolve(context, buffer).Check();
    else settle->Resolve(context, v8::Uint8Array::New(buffer, 0, bytes.size())).Check();
}

void V8Game::flushCompute() {
    if (computeQueue_.empty() || renderer_ == nullptr) return;
    idleRenderer();
    computeQueue_.flush(*renderer_, [](const std::string& reason) { std::fprintf(stderr, "%s\n", reason.c_str()); });
}

// `tn.compute(node)` / `tn.compute([node, ...])`: three's renderer.compute, queued in call order and
// run before the frame's passes. A node the engine cannot lower refuses here, by name.
void V8Game::compute(const v8::FunctionCallbackInfo<v8::Value>& info) {
    auto& game = *static_cast<V8Game*>(info.Data().As<v8::External>()->Value());
    auto* isolate = info.GetIsolate();
    auto ctx = isolate->GetCurrentContext();
    try {
        std::vector<shader::graph::Node> nodes;
        const auto add = [&](v8::Local<v8::Value> value) {
            shader::graph::Node node;
            if (!game.adapter_->tsl().unwrap(value, node))
                throw std::runtime_error("TN_COMPUTE_NODE: renderer.compute takes the node Fn(() => { ... })().compute(count) makes");
            nodes.push_back(std::move(node));
        };
        if (info.Length() == 1 && info[0]->IsArray()) {
            auto list = info[0].As<v8::Array>();
            for (uint32_t i = 0; i < list->Length(); ++i) add(list->Get(ctx, i).ToLocalChecked());
        } else if (info.Length() == 1) {
            add(info[0]);
        } else {
            throw std::runtime_error("TN_COMPUTE_NODE: renderer.compute takes one compute node or an array of them");
        }
        for (const auto& node : nodes) game.computeQueue_.dispatch(node);
    } catch (const std::exception& error) {
        isolate->ThrowException(v8::Exception::Error(v8str(isolate, error.what())));
    }
}

// `tn.readStorage(attribute)`: a Promise of the attribute's GPU buffer as an ArrayBuffer, copied after
// every kernel queued before this call.
void V8Game::readStorage(const v8::FunctionCallbackInfo<v8::Value>& info) {
    auto& game = *static_cast<V8Game*>(info.Data().As<v8::External>()->Value());
    auto* isolate = info.GetIsolate();
    auto ctx = isolate->GetCurrentContext();
    auto resolver = v8::Promise::Resolver::New(ctx).ToLocalChecked();
    info.GetReturnValue().Set(resolver->GetPromise());
    auto* attribute = info.Length() == 1 ? game.engineObject(info[0], "BufferAttribute") : nullptr;
    if (attribute == nullptr) {
        resolver->Reject(ctx, v8::Exception::Error(v8str(isolate, "TN_NATIVE_READ_STORAGE: expected the BufferAttribute of a storage buffer"))).Check();
        return;
    }
    auto pending = std::make_shared<v8::Global<v8::Promise::Resolver>>(isolate, resolver);
    game.computeQueue_.readback(std::static_pointer_cast<BufferAttribute>(attribute->ptr),
        [&game, pending](GpuStatus status, std::vector<uint8_t> bytes) { game.settleRead(*pending, status, bytes, true); });
}

// `tn.deleteStorage(attribute)`: drops the attribute's GPU copy once the kernels queued so far have run.
void V8Game::deleteStorage(const v8::FunctionCallbackInfo<v8::Value>& info) {
    auto& game = *static_cast<V8Game*>(info.Data().As<v8::External>()->Value());
    auto* attribute = info.Length() == 1 ? game.engineObject(info[0], "BufferAttribute") : nullptr;
    if (attribute == nullptr) {
        info.GetIsolate()->ThrowException(v8::Exception::TypeError(v8str(info.GetIsolate(),
            "TN_NATIVE_DELETE_ATTRIBUTE: expected a BufferAttribute")));
        return;
    }
    game.computeQueue_.release(std::static_pointer_cast<BufferAttribute>(attribute->ptr));
}

// `tn.readFrame()`: a Promise of the last frame the player drew, RGBA8 rows (top row first) as a Uint8Array,
// post chain included. three has no such call: its render() into a render target carries a pipeline's output
// there, which this player's post pass does not, so a probe of a post frame reads the frame itself.
void V8Game::readFrame(const v8::FunctionCallbackInfo<v8::Value>& info) {
    auto& game = *static_cast<V8Game*>(info.Data().As<v8::External>()->Value());
    auto* isolate = info.GetIsolate();
    auto ctx = isolate->GetCurrentContext();
    auto resolver = v8::Promise::Resolver::New(ctx).ToLocalChecked();
    info.GetReturnValue().Set(resolver->GetPromise());
    if (game.renderer_ == nullptr) {
        resolver->Reject(ctx, v8::Exception::Error(v8str(isolate, "TN_NATIVE_READ_FRAME: the player has no renderer before its first frame"))).Check();
        return;
    }
    auto pending = std::make_shared<v8::Global<v8::Promise::Resolver>>(isolate, resolver);
    game.idleRenderer();
    const GpuStatus started = game.renderer_->readPixels([&game, pending](GpuStatus status, std::vector<uint8_t> bytes) {
        game.settleRead(*pending, status, bytes);
    });
    if (started != GpuStatus::Ok)
        resolver->Reject(ctx, v8::Exception::Error(v8str(isolate, "TN_NATIVE_READ_FRAME: no frame has been drawn yet"))).Check();
}

// `tn.readTarget(target, x, y, width, height)`: a Promise of the region's RGBA16Float rows (top row
// first) as a Uint8Array, resolved from the player's poll once the GPU copy lands.
void V8Game::readTarget(const v8::FunctionCallbackInfo<v8::Value>& info) {
    auto& game = *static_cast<V8Game*>(info.Data().As<v8::External>()->Value());
    auto* isolate = info.GetIsolate();
    auto ctx = isolate->GetCurrentContext();
    auto resolver = v8::Promise::Resolver::New(ctx).ToLocalChecked();
    info.GetReturnValue().Set(resolver->GetPromise());
    const auto reject = [&](const std::string& reason) {
        resolver->Reject(ctx, v8::Exception::Error(v8str(isolate, reason))).Check();
    };
    auto* target = info.Length() == 5 ? game.engineObject(info[0], "RenderTarget") : nullptr;
    if (target == nullptr) return reject("TN_NATIVE_READ_TARGET: expected a RenderTarget and a region");
    uint32_t region[4];
    for (int i = 0; i < 4; ++i) {
        const double value = info[i + 1]->IsNumber() ? info[i + 1].As<v8::Number>()->Value() : -1;
        if (!(value >= 0) || value > 16384) return reject("TN_NATIVE_READ_TARGET: the region must be whole pixels");
        region[i] = static_cast<uint32_t>(value);
    }
    auto pending = std::make_shared<v8::Global<v8::Promise::Resolver>>(isolate, resolver);
    game.idleRenderer();
    game.flushCompute();
    const GpuStatus started = readRenderTarget(*static_cast<RenderTarget*>(target->ptr.get()), region[0], region[1],
        region[2], region[3], [&game, pending](GpuStatus status, std::vector<uint8_t> bytes) {
            game.settleRead(*pending, status, bytes);
        });
    if (started == GpuStatus::InvalidHandle) reject("TN_NATIVE_READ_TARGET: the target never rendered");
    else if (started != GpuStatus::Ok) reject("TN_NATIVE_READ_TARGET: region outside the target");
}

// One real-scene HDR reflection face, using the probe renderer on the player's device.
void V8Game::captureFace(const v8::FunctionCallbackInfo<v8::Value>& info) {
    auto& game = *static_cast<V8Game*>(info.Data().As<v8::External>()->Value());
    auto* isolate = info.GetIsolate();
    auto ctx = isolate->GetCurrentContext();
    auto resolver = v8::Promise::Resolver::New(ctx).ToLocalChecked();
    info.GetReturnValue().Set(resolver->GetPromise());
    const auto reject = [&](const std::string& message) {
        resolver->Reject(ctx, v8::Exception::Error(v8str(isolate, message))).Check();
    };
    auto* root = info.Length() == 6 ? game.engineObject(info[0], "Object3D") : nullptr;
    if (!root || !game.renderer_) return reject("TN_REFLECTION_CAPTURE_SCENE");
    double values[5];
    for (int i = 0; i < 5; ++i) {
        if (!info[i + 1]->IsNumber()) return reject("TN_REFLECTION_CAPTURE_INPUT");
        values[i] = info[i + 1].As<v8::Number>()->Value();
        if (!std::isfinite(values[i])) return reject("TN_REFLECTION_CAPTURE_INPUT");
    }
    if (values[3] < 1 || values[3] > 1024 || std::floor(values[3]) != values[3] ||
        values[4] < 0 || values[4] >= 6 || std::floor(values[4]) != values[4])
        return reject("TN_REFLECTION_CAPTURE_INPUT");
    auto pending = std::make_shared<v8::Global<v8::Promise::Resolver>>(isolate, resolver);
    game.idleRenderer();
    game.flushCompute();
    try {
        const auto started = probes::captureFace(*game.renderer_, *static_cast<Object3D*>(root->ptr.get()),
            Vector3{values[0], values[1], values[2]}, uint32_t(values[3]), uint32_t(values[4]), 0.01, 2000,
            [&game, pending](GpuStatus status, std::vector<float> rgb) {
                std::vector<uint8_t> bytes(rgb.size() * sizeof(float));
                std::memcpy(bytes.data(), rgb.data(), bytes.size());
                game.settleRead(*pending, status, bytes);
            });
        if (started == GpuStatus::Pending) resolver->Resolve(ctx, v8::Null(isolate)).Check();
        else if (started != GpuStatus::Ok) reject("TN_REFLECTION_CAPTURE_FACE");
    } catch (const std::exception& error) { reject(error.what()); }
}

// The scene walk stays on the isolate's thread; only owned pipeline descriptors reach workers.
void V8Game::compileAsync(const v8::FunctionCallbackInfo<v8::Value>& info) {
    auto& game = *static_cast<V8Game*>(info.Data().As<v8::External>()->Value());
    auto* isolate = info.GetIsolate();
    auto ctx = isolate->GetCurrentContext();
    auto resolver = v8::Promise::Resolver::New(ctx).ToLocalChecked();
    info.GetReturnValue().Set(resolver->GetPromise());
    if (!game.hasGpu_) {
        resolver->Reject(ctx, v8::Exception::Error(v8str(isolate, "TN_NATIVE_COMPILE: --check-game has no GPU; pipeline compilation requires a renderer"))).Check();
        return;
    }
    auto* root = info.Length() > 0 ? game.engineObject(info[0], "Object3D") : nullptr;
    const bool hasCamera = info.Length() > 1 && !info[1]->IsUndefined();
    const bool hasScene = info.Length() > 2 && !info[2]->IsNullOrUndefined();
    auto* camera = hasCamera ? game.engineObject(info[1], "Camera") : nullptr;
    auto* scene = hasScene ? game.engineObject(info[2], "Object3D") : nullptr;
    if (!root || (hasCamera && !camera) || (hasScene && !scene)) {
        resolver->Reject(ctx, v8::Exception::Error(v8str(isolate, "TN_NATIVE_COMPILE: root, camera or target scene invalid"))).Check();
        return;
    }
    game.compilations_.push_back({root->ptr, camera ? camera->ptr : std::make_shared<Camera>(),
        scene ? scene->ptr : nullptr, game.output_, game.shadowMap_, game.shadowMapType_, game.samples_,
        v8::Global<v8::Promise::Resolver>(isolate, resolver), std::nullopt});
    game.pollCompilations();
}

// `tn.prepareEnvironment(scene, camera)`: one step of the PMREM bake that render() gates every frame
// on, drawn or not, so startup warm-up can wait for it as three's PMREM preparer does on the web.
// True once every environment the scene samples is baked; false while it bakes or before the renderer opens.
void V8Game::prepareEnvironment(const v8::FunctionCallbackInfo<v8::Value>& info) {
    auto& game = *static_cast<V8Game*>(info.Data().As<v8::External>()->Value());
    auto* isolate = info.GetIsolate();
    if (!game.hasGpu_) { info.GetReturnValue().Set(true); return; }  // --check-game: nothing will be drawn
    if (!game.renderer_) { info.GetReturnValue().Set(false); return; }
    auto* scene = info.Length() > 0 ? game.engineObject(info[0], "Object3D") : nullptr;
    auto* camera = info.Length() > 1 ? game.engineObject(info[1], "Camera") : nullptr;
    if (!scene || !camera) {
        isolate->ThrowException(v8::Exception::TypeError(v8str(isolate, "TN_NATIVE_ENVIRONMENT: scene or camera invalid")));
        return;
    }
    try {
        game.idleRenderer();
        game.renderer_->poll();  // the bake advances only after its previous submission completes
        RenderDatabase database;
        database.shadowMapEnabled = game.shadowMap_;
        database.shadowMapType = game.shadowMapType_;
        info.GetReturnValue().Set(database.prepareEnvironments(*game.renderer_, *static_cast<Object3D*>(scene->ptr.get()),
            *static_cast<Camera*>(camera->ptr.get())));
    } catch (const std::exception& error) {
        isolate->ThrowException(v8::Exception::Error(v8str(isolate, error.what())));
    }
}

// `tn.renderOverlay(scene, camera, worldDrawn)`: three's overlay render (core's canvas layer: a loading screen, a
// canvas HUD) for this frame. The loop draws it over the world frame with Renderer::overlayRenderer, with no post and
// no temporal step: published as tn.scene, it replaced the world frame and moved the world's temporal history and
// metered exposure. `worldDrawn` false is a held loader frame: the overlay is drawn alone, over no new world frame.
void V8Game::renderOverlay(const v8::FunctionCallbackInfo<v8::Value>& info) {
    auto& game = *static_cast<V8Game*>(info.Data().As<v8::External>()->Value());
    auto* isolate = info.GetIsolate();
    auto* scene = info.Length() > 0 ? game.engineObject(info[0], "Object3D") : nullptr;
    auto* camera = info.Length() > 1 ? game.engineObject(info[1], "Camera") : nullptr;
    if (!scene || !camera) {
        isolate->ThrowException(v8::Exception::TypeError(v8str(isolate, "TN_NATIVE_OVERLAY: scene or camera invalid")));
        return;
    }
    game.overlaySceneHold_ = scene->ptr;
    game.overlayCameraHold_ = camera->ptr;
    game.overlayAlone_ = info.Length() > 2 && info[2]->IsFalse();
}

void V8Game::pollCompilations() {
    if (!renderer_ || compilations_.empty()) return;  // boot can call before the device is initialized
    idleRenderer();
    v8::Isolate::Scope isolateScope(isolate_);
    v8::HandleScope scope(isolate_);
    auto ctx = js_.Get(isolate_);
    v8::Context::Scope contextScope(ctx);
    // Promises settle after the list is final: V8 runs a continuation as the resolving call returns, and a
    // continuation that calls compileAsync again grows (and moves) the list under a live iterator.
    struct Settled {
        v8::Global<v8::Promise::Resolver> resolver;
        std::optional<std::string> error;
    };
    std::vector<Settled> settled;
    for (auto it = compilations_.begin(); it != compilations_.end();) {
        std::optional<std::string> error;
        try {
            if (!it->pipelines) {
                renderer_->setOutput(it->output);
                renderer_->setSampleCount(it->samples);
                outputChanged_ = true;  // the next frame reapplies the game's current settings
                RenderDatabase database;
                database.shadowMapEnabled = it->shadows;
                database.shadowMapType = it->shadowType;
                it->pipelines = database.compileAsync(*renderer_, *static_cast<Object3D*>(it->root.get()),
                    *static_cast<Camera*>(it->camera.get()), static_cast<Object3D*>(it->scene.get()));
            }
            bool pending = false;
            for (const auto& pipeline : *it->pipelines) {
                if (!pipeline->ready()) pending = true;
                else if (!pipeline->get()) throw std::runtime_error("TN_NATIVE_PIPELINE_REFUSED: async creation returned null");
            }
            if (pending) { ++it; continue; }
        } catch (const std::exception& failure) {
            error = failure.what();
        }
        settled.push_back({std::move(it->resolver), std::move(error)});
        it = compilations_.erase(it);
    }
    for (Settled& done : settled) {
        const auto resolver = done.resolver.Get(isolate_);
        if (done.error) resolver->Reject(ctx, v8::Exception::Error(v8str(isolate_, *done.error))).Check();
        else resolver->Resolve(ctx, v8::Undefined(isolate_)).Check();
    }
}

void V8Game::setPost(const v8::FunctionCallbackInfo<v8::Value>& info) {
    try {
    auto& game = *static_cast<V8Game*>(info.Data().As<v8::External>()->Value());
    shader::graph::Node graph;
    const auto apply = [&](shader::graph::Node value) {
        if (value == game.post_) return;  // RenderPipeline.render() hands the same graph every frame
        game.idleRenderer();
        if (game.renderer_) {
            if (game.outputChanged_) game.renderer_->setOutput(game.output_);
            game.outputChanged_ = false;
            game.renderer_->setPostGraph(value);
        }
        game.post_ = std::move(value);
    };
    if (info.Length() == 1 && info[0]->IsNull()) { apply({}); return; }
    if (info.Length() == 1 && game.adapter_->tsl().unwrap(info[0], graph)) { apply(graph); return; }
    if (info.Length() == 1 && info[0]->IsString()) {
        v8::String::Utf8Value source(info.GetIsolate(), info[0]);
        std::vector<std::string> errors;
        auto imported = shader::graph::importSerialized(std::string_view(*source, source.length()), errors);
        if (errors.empty() && imported) { apply(imported); return; }
        std::string reason = "TN_NATIVE_POST_INVALID";
        for (const auto& error : errors) reason += ": " + error;
        info.GetIsolate()->ThrowException(v8::Exception::Error(v8str(info.GetIsolate(), reason)));
        return;
    }
    info.GetIsolate()->ThrowException(v8::Exception::TypeError(v8str(info.GetIsolate(),
        "TN_NATIVE_POST_INVALID: expected a native TSL node or exported post graph")));
    } catch (const std::exception& error) {
        info.GetIsolate()->ThrowException(v8::Exception::Error(v8str(info.GetIsolate(),
            std::string("TN_NATIVE_POST_REFUSED: ") + error.what())));
    }
}

void V8Game::initialize(Renderer& renderer) {
    renderer_ = &renderer;
    if (gpuTimerWanted_) renderer.setGpuTimer(true);
    renderer.setOutput(output_);
    outputChanged_ = false;
    if (post_) renderer.setPostGraph(post_);
    pollCompilations();
}

bool V8Game::observe(const std::string& method, const json::Value* argument, json::Value& result, std::string& error) {
    v8::Isolate::Scope isolateScope(isolate_);
    v8::HandleScope scope(isolate_);
    auto ctx = js_.Get(isolate_);
    v8::Context::Scope contextScope(ctx);
    v8::TryCatch caught(isolate_);
    const auto fail = [&](const std::string& reason) { error = "TN_INSPECT_GAME_BRIDGE: " + reason; return false; };
    v8::Local<v8::Value> bridge;
    if (!ctx->Global()->Get(ctx, v8str(isolate_, "__THREENATIVE_PLAYTEST_BRIDGE__")).ToLocal(&bridge))
        return fail("cannot read installed bridge");
    if (bridge->IsUndefined()) return false;
    if (!bridge->IsObject()) return fail("installed bridge must be an object");
    v8::Local<v8::Value> fn, input, output;
    const std::string key = method + "\n" + (argument ? json::stringify(*argument) : "");
    if (!settling_.IsEmpty()) {
        if (key != settlingKey_) return fail(method + " asked while " + settlingKey_.substr(0, settlingKey_.find('\n')) + " is settling");
        output = settling_.Get(isolate_);
        settling_.Reset();
        settlingKey_.clear();
    } else {
        if (!bridge.As<v8::Object>()->Get(ctx, v8str(isolate_, method)).ToLocal(&fn) || !fn->IsFunction())
            return fail("missing method " + method);
        if (!v8::JSON::Parse(ctx, v8str(isolate_, argument ? json::stringify(*argument) : method == "sample" ? "{}" : "null")).ToLocal(&input))
            return fail("invalid request argument");
        if (!fn.As<v8::Function>()->Call(ctx, bridge, argument || method == "sample" ? 1 : 0, &input).ToLocal(&output)) {
            v8::String::Utf8Value message(isolate_, caught.Exception());
            return fail(*message ? *message : "bridge call failed");
        }
    }
    isolate_->PerformMicrotaskCheckpoint();
    if (output->IsPromise()) {
        auto promise = output.As<v8::Promise>();
        // Settles on a later frame (describe() waits for the scene the game enters): ask again then.
        if (promise->State() == v8::Promise::kPending) {
            settling_.Reset(isolate_, promise);
            settlingKey_ = key;
            error = inspect::kStillSettling;
            return false;
        }
        if (promise->State() == v8::Promise::kRejected) {
            v8::String::Utf8Value reason(isolate_, promise->Result());
            return fail(*reason ? *reason : "observation rejected");
        }
        output = promise->Result();
    }
    // A bridge method that answers nothing (applySetup may) reads in a page as no result: null here.
    if (output->IsUndefined()) output = v8::Null(isolate_);
    v8::Local<v8::String> encoded;
    if (!v8::JSON::Stringify(ctx, output).ToLocal(&encoded)) return fail("observation is not JSON");
    v8::String::Utf8Value text(isolate_, encoded);
    json::Error parseError;
    if (!json::parse(std::string_view(*text, text.length()), result, parseError))
        return fail("invalid JSON observation from " + method + ": " + parseError.code + " at byte " +
                    std::to_string(parseError.offset) + " (" + parseError.detail + "): " +
                    std::string(*text, std::min<std::size_t>(text.length(), 120)));
    return true;
}

bool V8Game::start(const std::string& path, std::string& error) {
    const char* configuredAssets = std::getenv("TN_NATIVE_ASSET_PACKAGE");
    assetPath_ = configuredAssets ? configuredAssets :
        (std::filesystem::path(path).parent_path() / "native/assets.tnpk").string();
    services_ = mystral::js::createV8Engine();
    if (!services_) return error = "TN_PLAYER_V8_SERVICES: no V8 engine", false;
#if TN_JS_PROFILE || TN_ANDROID_JS_PROFILE
    // The desktop runner terminates the player with SIGTERM; V8 must flush on its owning thread.
    if (mystral::js::g_startCpuProfile)
        std::signal(SIGTERM, [](int) { mystral::js::g_cpuProfileStopRequested = 1; });
#endif
    isolate_ = static_cast<v8::Isolate*>(services_->getRawContext());

    const tn_version_info_t own = tn_engine_version();
    tn_diagnostic_t diagnostic{nullptr, 0};
    if (tn_context_create(&context_, &own, &diagnostic) != TN_OK)
        return error = "no engine context", false;

    v8::Isolate::Scope isolateScope(isolate_);
    v8::HandleScope scope(isolate_);
    adapter_ = std::make_unique<tn::adapters::v8adapter::Adapter>(isolate_, context_);
    // three's own math as JS (PRD-573 v1.11 step 4a); TN_NATIVE_JS_MATH=0 is the A/B arm with native math.
    if (const char* mathMode = std::getenv("TN_NATIVE_JS_MATH"); mathMode == nullptr || std::string(mathMode) != "0")
        adapter_->setJsMath(true);
    mystral::js::JSValueGuard global(*services_, services_->getGlobal());
    auto object = static_cast<v8::Persistent<v8::Value>*>(global.get().ptr)->Get(isolate_).As<v8::Object>();
    v8::Local<v8::Context> ctx = object->GetCreationContext().ToLocalChecked();
    js_.Reset(isolate_, ctx);
    v8::Context::Scope contextScope(ctx);
    adapter_->install(ctx, ctx->Global());
    // WebAudio is the legacy host's (SDL output, worker decode); the three audio classes sit on it.
    mystral::audio::initializeAudioBindings(services_.get());
    installDocument(ctx);
#if TN_PLAYER_NATIVE_PHYSICS
    if (!mystral::physics::initializeNativePhysicsBindings(services_.get()))
        return error = "TN_NATIVE_PHYSICS_MISSING: resident installation failed", false;
#endif

    installWindowInput();
    v8::Local<v8::External> held = v8::External::New(isolate_, &held_);
    ctx->Global()
        ->Set(ctx, v8str(isolate_, "__tnHeldCodes"),
              v8::Function::New(ctx, &heldCodesCallback, v8::External::New(isolate_, &heldCodes_)).ToLocalChecked())
        .Check();
    ctx->Global()
        ->Set(ctx, v8str(isolate_, "__tnIsDown"), v8::Function::New(ctx, &isDownCallback, held).ToLocalChecked())
        .Check();
    for (const auto& [name, callback] : {std::pair{"__tnUiPost", &uiPostCallback},
                                         std::pair{"__tnUiOverlayAttached", &uiAttachedCallback},
                                         std::pair{"__tnUiCompositeMs", &uiCompositeMsCallback},
                                         std::pair{"__tnPointerCapture", &pointerCaptureCallback}})
        ctx->Global()->Set(ctx, v8str(isolate_, name), v8::Function::New(ctx, callback).ToLocalChecked()).Check();

    ctx->Global()->Set(ctx, v8str(isolate_, "__tnWallMs"), v8::Function::New(ctx,
        [](const v8::FunctionCallbackInfo<v8::Value>& info) { info.GetReturnValue().Set(player::wallMs()); }).ToLocalChecked()).Check();
    // The bench's phase clock: thread CPU ms, the clock presentCpuMs uses; the legacy host installs the same name.
    ctx->Global()->Set(ctx, v8str(isolate_, "__tnThreadCpuMs"), v8::Function::New(ctx,
        [](const v8::FunctionCallbackInfo<v8::Value>& info) { info.GetReturnValue().Set(player::threadCpuMs()); }).ToLocalChecked()).Check();
    // TN_PLAYER_CROSSINGS=1: the live per-name crossing counts as JSON, so the bench can diff them per rung.
    if (std::getenv("TN_PLAYER_CROSSINGS") != nullptr)
        ctx->Global()->Set(ctx, v8str(isolate_, "__tnCrossingHistogram"), v8::Function::New(ctx,
            [](const v8::FunctionCallbackInfo<v8::Value>& info) {
                std::vector<std::pair<std::string, json::Value>> names;
                for (const auto& [name, count] : tn::abi::crossingHistogram()) names.emplace_back(name, json::Value::makeNumber(double(count)));
                info.GetReturnValue().Set(v8str(info.GetIsolate(), json::stringify(json::Value::makeObject(std::move(names)))));
            }).ToLocalChecked()).Check();
    // Core reads TN_FRAME_SPANS from process.env (Perry has one); this host has none, so it sets the
    // flag core's spansRequested() also accepts and both arms emit the same render-window spans.
    if (const char* frameSpans = std::getenv("TN_FRAME_SPANS");
        frameSpans != nullptr && frameSpans[0] != '\0' && std::strcmp(frameSpans, "0") != 0 &&
        std::strcmp(frameSpans, "false") != 0)
        ctx->Global()->Set(ctx, v8str(isolate_, "__tnFrameSpans"), v8::True(isolate_)).Check();
    if (player::gameSpan(-1, 0) == 1) {
        ctx->Global()->Set(ctx, v8str(isolate_, "__tnGameSpan"), v8::Function::New(ctx,
            [](const v8::FunctionCallbackInfo<v8::Value>& info) {
                auto* isolate = info.GetIsolate();
                if (info.Length() != 2 || !info[0]->IsInt32() || !info[1]->IsInt32()) {
                    isolate->ThrowException(v8::Exception::TypeError(v8str(isolate, "TN_GAME_SPANS_ARGUMENT")));
                    return;
                }
                const double value = player::gameSpan(info[0].As<v8::Int32>()->Value(), info[1].As<v8::Int32>()->Value());
                if (value < 0) isolate->ThrowException(v8::Exception::Error(v8str(isolate, "TN_GAME_SPANS_INVALID")));
                else info.GetReturnValue().Set(value);
            }).ToLocalChecked()).Check();
    }

    std::ifstream file(path);
    if (!file)
        return error = "cannot read " + path, false;
    std::stringstream source;
    source << file.rdbuf();

    v8::TryCatch tryCatch(isolate_);
    v8::Local<v8::Script> prelude;
    v8::Local<v8::Value> ignored;
    if (!v8::Script::Compile(ctx, v8str(isolate_, kPrelude)).ToLocal(&prelude) || !prelude->Run(ctx).ToLocal(&ignored))
        return error = "host prelude failed", false;
    // A playtest runner announces itself as on the legacy desktop host, so core's playtest plugin
    // collects the per-frame render samples the runner's performance assertions read.
    if (const char* root = std::getenv("TN_PLAYTEST_MAILBOX_ROOT"); root != nullptr && root[0] != '\0')
        ctx->Global()->Set(ctx, v8str(isolate_, "TN_PLAYTEST_ENDPOINT"), v8str(isolate_, "native://desktop-mailbox")).Check();
    const auto host = ctx->Global()->Get(ctx, v8str(isolate_, "tn")).ToLocalChecked().As<v8::Object>();
    auto platform = v8::Object::New(isolate_);
    platform->Set(ctx, v8str(isolate_, "runtime"), v8str(isolate_, "native")).Check();
#if defined(_WIN32)
    const char* os = "windows";
#elif defined(__APPLE__)
    const char* os = "macos";
#else
    const char* os = "linux";
#endif
    platform->Set(ctx, v8str(isolate_, "os"), v8str(isolate_, os)).Check();
    platform->Set(ctx, v8str(isolate_, "formFactor"), v8str(isolate_, "desktop")).Check();
    platform->Set(ctx, v8str(isolate_, "maxTouchPoints"), v8::Integer::New(isolate_, 0)).Check();
    host->Set(ctx, v8str(isolate_, "platform"), platform).Check();
    host->Set(ctx, v8str(isolate_, "log"), v8::Function::New(ctx, &logCallback).ToLocalChecked()).Check();
    auto self = v8::External::New(isolate_, this);
    host->Set(ctx, v8str(isolate_, "loadAsset"), v8::Function::New(ctx, &loadAsset, self).ToLocalChecked()).Check();
#if TN_PLAYER_NATIVE_GLTF
    // Only a player with the decoder answers createImageBitmap; without it the facade installs none.
    host->Set(ctx, v8str(isolate_, "decodeImage"), v8::Function::New(ctx, &decodeImage, self).ToLocalChecked()).Check();
#endif
    host->Set(ctx, v8str(isolate_, "setPostGraph"), v8::Function::New(ctx, &setPost, self).ToLocalChecked()).Check();
    host->Set(ctx, v8str(isolate_, "renderTarget"), v8::Function::New(ctx, &renderTarget, self).ToLocalChecked()).Check();
    host->Set(ctx, v8str(isolate_, "hasRenderer"), v8::Function::New(ctx, &hasRenderer, self).ToLocalChecked()).Check();
    host->Set(ctx, v8str(isolate_, "compileAsync"), v8::Function::New(ctx, &compileAsync, self).ToLocalChecked()).Check();
    host->Set(ctx, v8str(isolate_, "prepareEnvironment"), v8::Function::New(ctx, &prepareEnvironment, self).ToLocalChecked()).Check();
    host->Set(ctx, v8str(isolate_, "renderOverlay"), v8::Function::New(ctx, &renderOverlay, self).ToLocalChecked()).Check();
    host->Set(ctx, v8str(isolate_, "captureFace"), v8::Function::New(ctx, &captureFace, self).ToLocalChecked()).Check();
    host->Set(ctx, v8str(isolate_, "readTarget"), v8::Function::New(ctx, &readTarget, self).ToLocalChecked()).Check();
    host->Set(ctx, v8str(isolate_, "readFrame"), v8::Function::New(ctx, &readFrame, self).ToLocalChecked()).Check();
    host->Set(ctx, v8str(isolate_, "compute"), v8::Function::New(ctx, &compute, self).ToLocalChecked()).Check();
    host->Set(ctx, v8str(isolate_, "readStorage"), v8::Function::New(ctx, &readStorage, self).ToLocalChecked()).Check();
    host->Set(ctx, v8str(isolate_, "deleteStorage"), v8::Function::New(ctx, &deleteStorage, self).ToLocalChecked()).Check();
    host->Set(ctx, v8str(isolate_, "setRendererState"), v8::Function::New(ctx, &setRendererState, self).ToLocalChecked()).Check();
    host->Set(ctx, v8str(isolate_, "requestAdapter"), v8::Function::New(ctx, &requestAdapter, self).ToLocalChecked()).Check();
    host->Set(ctx, v8str(isolate_, "renderInfo"), v8::Function::New(ctx, &renderInfo, self).ToLocalChecked()).Check();
    host->Set(ctx, v8str(isolate_, "setGpuTimer"), v8::Function::New(ctx, &setGpuTimer, self).ToLocalChecked()).Check();
    host->Set(ctx, v8str(isolate_, "surfaceSize"), v8::Function::New(ctx, &surfaceSize, self).ToLocalChecked()).Check();
    host->Set(ctx, v8str(isolate_, "presentMode"), v8str(isolate_, player::presentModeName())).Check();
    v8::Local<v8::Script> script;
    v8::ScriptOrigin origin(
#if V8_MAJOR_VERSION < 12
        isolate_,
#endif
        v8str(isolate_, path));
    if (!v8::Script::Compile(ctx, v8str(isolate_, source.str()), &origin).ToLocal(&script) || !script->Run(ctx).ToLocal(&ignored)) {
        v8::String::Utf8Value message(isolate_, tryCatch.Exception());
        v8::Local<v8::Value> stackValue;
        v8::String::Utf8Value stack(isolate_, tryCatch.StackTrace(ctx).ToLocal(&stackValue) ? stackValue : v8::Local<v8::Value>());
        return error = std::string("the game bundle failed: ") + (*message ? *message : "?") +
                       (*stack && std::string_view(*stack) != std::string_view(*message ? *message : "") ? std::string("\n") + *stack : std::string()),
               false;
    }
    isolate_->PerformMicrotaskCheckpoint();
    const auto failed = [&] {
        v8::Local<v8::Value> startupError;
        if (!host->Get(ctx, v8str(isolate_, "__startupError")).ToLocal(&startupError) || startupError->IsUndefined())
            return false;
        v8::String::Utf8Value message(isolate_, startupError);
        error = std::string("core startup failed: ") + (*message ? *message : "?");
        return true;
    };
    if (failed()) return false;

    v8::Local<v8::Value> tnValue;
    if (!ctx->Global()->Get(ctx, v8str(isolate_, "tn")).ToLocal(&tnValue) || !tnValue->IsObject())
        return error = "the game bundle left no `tn` host object", false;
    v8::Local<v8::Object> tn = tnValue.As<v8::Object>();
    v8::Local<v8::Value> update;
    if (!tn->Get(ctx, v8str(isolate_, "__update")).ToLocal(&update) || !update->IsFunction())
        return error = "the game bundle registered no tn.onUpdate(fn)", false;
    update_.Reset(isolate_, update.As<v8::Function>());
    return view(error) >= 0;
}

int V8Game::view(std::string& error) {
    v8::Isolate::Scope isolateScope(isolate_);
    v8::HandleScope scope(isolate_);
    v8::Local<v8::Context> ctx = js_.Get(isolate_);
    v8::Context::Scope contextScope(ctx);
    v8::Local<v8::Value> tnValue, startupError, sceneValue, cameraValue;
    if (!ctx->Global()->Get(ctx, v8str(isolate_, "tn")).ToLocal(&tnValue) || !tnValue->IsObject())
        return error = "the game bundle left no `tn` host object", -1;
    v8::Local<v8::Object> tn = tnValue.As<v8::Object>();
    // An async boot that fails after start() returned reports through the same field.
    if (tn->Get(ctx, v8str(isolate_, "__startupError")).ToLocal(&startupError) && !startupError->IsUndefined()) {
        v8::String::Utf8Value message(isolate_, startupError);
        return error = std::string("core startup failed: ") + (*message ? *message : "?"), -1;
    }
    if (!tn->Get(ctx, v8str(isolate_, "scene")).ToLocal(&sceneValue) ||
        !tn->Get(ctx, v8str(isolate_, "camera")).ToLocal(&cameraValue))
        return error = "tn.scene or tn.camera could not be read", -1;
    // The bundle's boot holds `__booting` until start() settles: a pass node publishes the scene
    // while start() is still loading, and only a settled start is a booted game.
    v8::Local<v8::Value> booting;
    if (sceneValue->IsNullOrUndefined() || cameraValue->IsNullOrUndefined() ||
        (tn->Get(ctx, v8str(isolate_, "__booting")).ToLocal(&booting) && booting->IsTrue()))
        return 0;
    tn_handle_t handle{};
    tn::binding::Object* scene = adapter_->unwrap(sceneValue, handle) ? tn::abi::objectOf(handle) : nullptr;
    if (scene == nullptr || scene->cls != "Scene")
        return error = "tn.scene is not a Scene", -1;
    tn::binding::Object* camera = adapter_->unwrap(cameraValue, handle) ? tn::abi::objectOf(handle) : nullptr;
    if (camera == nullptr || (camera->cls != "PerspectiveCamera" && camera->cls != "OrthographicCamera"))
        return error = "tn.camera is not a camera", -1;
    sceneHold_ = scene->ptr;
    cameraHold_ = camera->ptr;
    scene_ = static_cast<Scene*>(scene->ptr.get());
    camera_ = camera->cls == "PerspectiveCamera"
                  ? static_cast<Camera*>(static_cast<PerspectiveCamera*>(camera->ptr.get()))
                  : static_cast<Camera*>(static_cast<OrthographicCamera*>(camera->ptr.get()));
    return 1;
}

V8Game::~V8Game() {
    mystral::platform::setKeyboardCallback({});
    mystral::platform::setMouseCallback({});
    mystral::platform::setPointerCallback({});
    mystral::platform::setWheelCallback({});
    if (isolate_ == nullptr)
        return;
#if TN_JS_PROFILE || TN_ANDROID_JS_PROFILE
    if (mystral::js::g_dumpCpuProfile) mystral::js::g_dumpCpuProfile();
#endif
    {
        v8::Isolate::Scope isolateScope(isolate_);
        v8::HandleScope scope(isolate_);
        // The adapter and the module-level globals die with the isolate; the engine context keeps
        // its own objects until it is released below.
        compilations_.clear();
        update_.Reset();
        js_.Reset();
        mystral::audio::cleanupAudioBindings();
        adapter_.reset();
    }
    if (context_ != nullptr) {
        tn_diagnostic_t diagnostic{nullptr, 0};
        tn_context_destroy(context_, &diagnostic);
        tn_diagnostic_release(&diagnostic);
    }
    services_.reset();
}

// The legacy host's translation puts SDL's keys, mouse and wheel in DOM shape; this queues them for the
// next tick, where core's canvas listeners see them as a page's would. Auto-repeat is dropped: a held
// key is already down.
void V8Game::installWindowInput() {
    using namespace mystral::platform;
    setKeyboardCallback([this](const KeyboardEventData& e) {
        if (e.repeat) return;
        windowInput_.push_back({.type = e.type, .code = e.code, .key = e.key});
    });
    setMouseCallback([this](const MouseEventData& e) {
        windowInput_.push_back({.type = e.type, .x = e.clientX, .y = e.clientY, .movementX = e.movementX,
                                .movementY = e.movementY, .button = e.button, .buttons = e.buttons});
    });
    setPointerCallback([this](const PointerEventData& e) {
        windowInput_.push_back({.type = e.type, .pointerType = e.pointerType, .x = e.clientX, .y = e.clientY,
                                .movementX = e.movementX, .movementY = e.movementY, .button = e.button,
                                .buttons = e.buttons, .pointerId = e.pointerId, .pointer = true});
    });
    setWheelCallback([this](const WheelEventData& e) {
        windowInput_.push_back({.type = e.type, .x = e.clientX, .y = e.clientY, .deltaX = e.deltaX, .deltaY = e.deltaY});
    });
}

void V8Game::deliverWindowInput(v8::Local<v8::Context> ctx) {
    if (windowInput_.empty()) return;
    v8::Local<v8::Value> dispatch;
    const bool ready = ctx->Global()->Get(ctx, v8str(isolate_, "__tnDispatchInput")).ToLocal(&dispatch) && dispatch->IsFunction();
    for (const WindowInput& input : windowInput_) {
        if (input.type == "keydown") {
            held_.insert(input.key);
            held_.insert(input.code);
            heldCodes_.insert(input.code);
        } else if (input.type == "keyup") {
            held_.erase(input.key);
            held_.erase(input.code);
            heldCodes_.erase(input.code);
        }
        if (!ready) continue;
        v8::Local<v8::Object> event = v8::Object::New(isolate_);
        const auto number = [&](const char* name, double value) {
            event->Set(ctx, v8str(isolate_, name), v8::Number::New(isolate_, value)).Check();
        };
        event->Set(ctx, v8str(isolate_, "type"), v8str(isolate_, input.type)).Check();
        if (!input.code.empty()) {
            event->Set(ctx, v8str(isolate_, "code"), v8str(isolate_, input.code)).Check();
            event->Set(ctx, v8str(isolate_, "key"), v8str(isolate_, input.key)).Check();
        }
        number("clientX", input.x);
        number("clientY", input.y);
        number("movementX", input.movementX);
        number("movementY", input.movementY);
        number("deltaX", input.deltaX);
        number("deltaY", input.deltaY);
        number("deltaMode", 0);
        number("button", input.button);
        number("buttons", input.buttons);
        if (input.pointer) {
            number("pointerId", input.pointerId);
            event->Set(ctx, v8str(isolate_, "pointerType"), v8str(isolate_, input.pointerType)).Check();
        }
        v8::TryCatch tryCatch(isolate_);
        v8::Local<v8::Value> argument = event, ignored;
        if (!dispatch.As<v8::Function>()->Call(ctx, ctx->Global(), 1, &argument).ToLocal(&ignored)) {
            v8::String::Utf8Value message(isolate_, tryCatch.Exception());
            std::printf("[Playtest] TN_V8_INPUT_FAILED: %s\n", *message ? *message : "an input listener threw");
        }
    }
    windowInput_.clear();
}

void V8Game::tick(double dt) {
    v8::Isolate::Scope isolateScope(isolate_);
    v8::HandleScope scope(isolate_);
    v8::Local<v8::Context> ctx = js_.Get(isolate_);
    v8::Context::Scope contextScope(ctx);
    if (endpoint_ != nullptr) {
        // The tick boundary: input queued since the last tick is applied to the key set before the
        // game's update reads it, so input injected for tick N is seen by tick N.
        for (const inspect::InputEvent& event : endpoint_->takeInput()) {
            if (event.type == "keydown") {
                held_.insert(event.key);
                held_.insert(event.code);
                heldCodes_.insert(event.code);
            } else if (event.type == "keyup") {
                held_.erase(event.key);
                held_.erase(event.code);
                heldCodes_.erase(event.code);
            }
            // A pointer goes to the UI first, through the legacy host's hit test and gesture latch
            // (PRD-554): a press on a published UI island is the page's, any other is the game's.
            // The runner sends viewport pixels, which are the drawing buffer's; the hit test takes 0..1.
            else if (event.type.rfind("pointer", 0) == 0 || event.type == "wheel") {
                const bool mouse = event.pointerType == "mouse";
                int button = 0;
                if (mouse && event.type != "wheel") {
                    // A DOM button names the changed bit, including the bit removed on release.
                    switch (pointerButtons_ ^ int(event.buttons)) {
                        case 1: button = 0; break;
                        case 2: button = 2; break;
                        case 4: button = 1; break;
                        case 8: button = 3; break;
                        case 16: button = 4; break;
                        default: button = -1; break;
                    }
                    pointerButtons_ = int(event.buttons);
                }
                const bool sized = renderer_ && renderer_->width() > 0 && renderer_->height() > 0;
                if (sized && mystral::platform::uiOverlayAttached()) {
                    const float nx = float(event.x / renderer_->width()), ny = float(event.y / renderer_->height());
                    const bool page = event.type == "wheel"
                        ? mystral::platform::uiOverlayRouteWheel(nx, ny, float(event.deltaX), float(event.deltaY))
                        : mystral::platform::uiOverlayRoutePointer(event.type.c_str(), nx, ny, int(event.buttons),
                                                                   event.pointerId);
                    if (page) continue;
                }
                // Not the page's: the game gets it as a window's pointer does, so a scenario's click, aim
                // and look reach its canvas listeners.
                if (event.type == "wheel") {
                    windowInput_.push_back({.type = "wheel", .x = event.x, .y = event.y,
                                            .deltaX = event.deltaX, .deltaY = event.deltaY});
                    continue;
                }
                const double moveX = mouse && pointerSeen_ ? event.x - pointerX_ : 0;
                const double moveY = mouse && pointerSeen_ ? event.y - pointerY_ : 0;
                if (mouse && event.type != "pointerup" && event.type != "pointercancel") {
                    pointerX_ = event.x;
                    pointerY_ = event.y;
                    pointerSeen_ = true;
                }
                if (event.type == "pointermove" && mouse)
                    windowInput_.push_back({.type = "mousemove", .x = event.x, .y = event.y, .movementX = moveX,
                                            .movementY = moveY, .buttons = int(event.buttons)});
                windowInput_.push_back({.type = event.type, .pointerType = event.pointerType, .x = event.x,
                                        .y = event.y, .movementX = moveX, .movementY = moveY, .button = button,
                                        .buttons = int(event.buttons), .pointerId = event.pointerId, .pointer = true});
            }
        }
    }
    deliverWindowInput(ctx);
    // Finished decodes settle and ended sources fire `onended` before the game's update reads them.
    mystral::audio::processAudioEvents();
    v8::TryCatch tryCatch(isolate_);
    v8::Local<v8::Value> argument = v8::Number::New(isolate_, dt);
    v8::Local<v8::Value> ignored;
    if (!update_.Get(isolate_)->Call(ctx, ctx->Global(), 1, &argument).ToLocal(&ignored)) {
        // The stack (message first) names the game call that threw, not only what it threw.
        v8::Local<v8::Value> stack;
        const bool traced = tryCatch.StackTrace(ctx).ToLocal(&stack) && stack->IsString();
        v8::String::Utf8Value message(isolate_, traced ? stack : tryCatch.Exception());
        std::printf("[Playtest] TN_V8_UPDATE_FAILED: %s\n", *message ? *message : "the update threw");
    }
}

// `tn.onFrame(fn)`: fn(ms) once per presented frame with the frame clock, so the step between two
// frame callbacks is the wall-clock duration of a real frame (CPU frame plus present), not ticks.
void V8Game::presentFrame() {
    v8::Isolate::Scope isolateScope(isolate_);
    v8::HandleScope scope(isolate_);
    v8::Local<v8::Context> ctx = js_.Get(isolate_);
    v8::Context::Scope contextScope(ctx);
    v8::Local<v8::Value> host, frame;
    if (!ctx->Global()->Get(ctx, v8str(isolate_, "tn")).ToLocal(&host) || !host->IsObject() ||
        !host.As<v8::Object>()->Get(ctx, v8str(isolate_, "__frame")).ToLocal(&frame) || !frame->IsFunction())
        return;
    v8::TryCatch tryCatch(isolate_);
    // Decodes settle on the page's event loop, not on simulation ticks: a game held by a runner
    // (no ticks yet) still finishes loading its audio, as Midway's boot does before describe().
    mystral::audio::processAudioEvents();
    frameStartedAt_ = std::chrono::steady_clock::now();
    v8::Local<v8::Value> argument = v8::Number::New(isolate_, frameClockMs_);
    v8::Local<v8::Value> ignored;
    if (!frame.As<v8::Function>()->Call(ctx, ctx->Global(), 1, &argument).ToLocal(&ignored)) {
        v8::String::Utf8Value message(isolate_, tryCatch.Exception());
        std::printf("[Playtest] TN_V8_FRAME_FAILED: %s\n", *message ? *message : "the frame callback threw");
    }
}

void V8Game::uiFrame() {
    mystral::platform::pumpUiOverlay();
    v8::Isolate::Scope isolateScope(isolate_);
    v8::HandleScope scope(isolate_);
    v8::Local<v8::Context> ctx = js_.Get(isolate_);
    v8::Context::Scope contextScope(ctx);
    std::string frame;
    while (mystral::platform::takeUiMessage(frame)) {
        if (mystral::platform::applyUiHitRegionsFrame(frame)) continue;
        v8::Local<v8::Value> receive;
        if (!ctx->Global()->Get(ctx, v8str(isolate_, "__tnUiGameReceive")).ToLocal(&receive) || !receive->IsFunction()) {
            // Not connected yet: dropping is right and must be visible, or an intent looks like a dead button.
            std::printf("TN_UI_BRIDGE:{\"dropped\":\"no __tnUiGameReceive\"}\n");
            continue;
        }
        v8::TryCatch tryCatch(isolate_);
        v8::Local<v8::Value> argument = v8str(isolate_, frame);
        v8::Local<v8::Value> ignored;
        if (!receive.As<v8::Function>()->Call(ctx, ctx->Global(), 1, &argument).ToLocal(&ignored)) {
            v8::String::Utf8Value message(isolate_, tryCatch.Exception());
            std::printf("[Playtest] TN_UI_RECEIVE_FAILED: %s\n", *message ? *message : "the receiver threw");
        }
    }
}

void V8Game::profileFrame(bool drawn) {
#if TN_JS_PROFILE || TN_ANDROID_JS_PROFILE
    if (!mystral::js::g_startCpuProfile) return;
    static const uint32_t startFrame = [] {
        const char* value = std::getenv("TN_JS_CPU_PROFILE_START_FRAME");
        return value != nullptr ? static_cast<uint32_t>(std::strtoul(value, nullptr, 10)) : 226u;
    }();
    if (drawn && ++profileFrames_ == startFrame) {
        mystral::js::g_startCpuProfile();
        std::printf("TN_PLAYER_CPU_PROFILE_START_FRAME:%llu\n", static_cast<unsigned long long>(profileFrames_));
    }
    if (mystral::js::g_cpuProfileStopRequested && mystral::js::g_dumpCpuProfile) {
        mystral::js::g_dumpCpuProfile();
        std::fflush(stdout);
        std::_Exit(mystral::js::g_cpuProfileFailed ? 1 : 0);
    }
#endif
}

void V8Game::safePoint() {
    v8::Isolate::Scope isolateScope(isolate_);
    v8::HandleScope scope(isolate_);
    pollCompilations();
    isolate_->PerformMicrotaskCheckpoint();
    adapter_->collect();
}

json::Value V8Game::resource(const std::string& id, uint64_t tick) const {
    if (id == "state" && scene_ != nullptr) {
        const Object3D* player = scene_->getObjectByName("player");
        if (player != nullptr) {
            const Vector3 at = player->position;
            return json::Value::makeObject({{"playerX", json::Value::makeNumber(at.x)},
                                            {"playerY", json::Value::makeNumber(at.y)},
                                            {"playerZ", json::Value::makeNumber(at.z)},
                                            {"tick", json::Value::makeNumber(double(tick))}});
        }
    }
    return json::Value::makeNull();
}

}  // namespace


int main(int argc, char** argv) {
    // The game's log is a stream tools read live; a pipe would otherwise hold it until exit, and a
    // killed player would lose it.
    std::setvbuf(stdout, nullptr, _IOLBF, 0);
    std::string gamePath;
    std::string checkRequest;
    std::string cpuProfilePath;
    bool checkGame = false;
    for (int i = 1; i < argc; ++i) {
        const std::string argument = argv[i];
        if ((argument == "--game" || argument == "--bundle") && i + 1 < argc)
            gamePath = argv[++i];
        else if (argument == "--check-game")
            checkGame = true;
        // The playtest runner sizes the window with the legacy host's flags. The player reads its surface
        // from TN_PLAYER_WIDTH and TN_PLAYER_HEIGHT (run.cpp validates them), and it always opens windowed.
        else if ((argument == "--width" || argument == "--height") && i + 1 < argc) {
            const char* name = argument == "--width" ? "TN_PLAYER_WIDTH" : "TN_PLAYER_HEIGHT";
#if defined(_WIN32)
            _putenv_s(name, argv[++i]);
#else
            setenv(name, argv[++i], 1);
#endif
        }
        else if (argument == "--windowed") {
        }
        else if (argument == "--check-request" && i + 1 < argc)
            checkRequest = argv[++i];
        else if (argument == "--cpu-prof" || argument.rfind("--cpu-prof=", 0) == 0) {
            if (argument == "--cpu-prof") {
                if (i + 1 >= argc)
                    return std::fprintf(stderr, "TN_PLAYER_V8_ARGS: --cpu-prof requires a nonempty file path\n"), 2;
                cpuProfilePath = argv[++i];
            } else {
                cpuProfilePath = argument.substr(std::string("--cpu-prof=").size());
            }
            if (cpuProfilePath.empty() || cpuProfilePath.rfind("--", 0) == 0)
                return std::fprintf(stderr, "TN_PLAYER_V8_ARGS: --cpu-prof requires a nonempty file path\n"), 2;
        }
        else if (argument.rfind("--", 0) != 0)
            gamePath = argument;
        else
            return std::fprintf(stderr, "TN_PLAYER_V8_ARGS: unknown argument %s\n", argument.c_str()), 2;
    }
    if (gamePath.empty())
        return std::fprintf(stderr, "TN_PLAYER_V8_ARGS: a game bundle path is required\n"), 2;
    if (!checkRequest.empty() && !checkGame)
        return std::fprintf(stderr, "TN_PLAYER_V8_ARGS: --check-request requires --check-game\n"), 2;

#if TN_JS_PROFILE || TN_ANDROID_JS_PROFILE
    mystral::js::g_cpuProfilePath = cpuProfilePath;
#else
    if (!cpuProfilePath.empty())
        return std::fprintf(stderr, "TN_PLAYER_V8_ARGS: --cpu-prof requires a build compiled with TN_JS_PROFILE=ON. Rebuild with -DTN_JS_PROFILE=ON.\n"), 2;
#endif
    const auto finish = [&cpuProfilePath](int status) {
#if TN_JS_PROFILE || TN_ANDROID_JS_PROFILE
        if (!cpuProfilePath.empty() && mystral::js::g_dumpCpuProfile) mystral::js::g_dumpCpuProfile();
        return mystral::js::g_cpuProfileFailed ? 1 : status;
#else
        return status;
#endif
    };

    V8Game game(!checkGame);
    // The adapter's identity, read the way core reads it (a request of its own beside the renderer's):
    // what the game's `adapter.info` and the playtest's adapter class come from. A check has no GPU.
    if (!checkGame) game.setAdapter(player::adapterIdentity());
    std::string error;
    if (!game.start(gamePath, error))
        return std::fprintf(stderr, "TN_PLAYER_V8_GAME: %s\n", error.c_str()), 1;

    // Boot the real bundle and validate its native handles without opening a GPU/window.
    // This establishes startup only; a desktop playtest still proves the journey and rendering.
    if (checkGame) {
        // An async boot (audio decodes, timers) publishes its scene ticks later. A check has no frame
        // loop, so it turns fixed ticks in real time itself, for at most two minutes.
        // ponytail: spins between ticks; the engine thread never sleeps (native_engine_no_blocking_waits).
        const auto begin = std::chrono::steady_clock::now();
        int bound = game.scene() != nullptr ? 1 : 0;
        for (uint64_t ticks = 0; bound == 0; bound = game.view(error)) {
            const double elapsed = std::chrono::duration<double>(std::chrono::steady_clock::now() - begin).count();
            if (elapsed > 120) {
                error = "the game published no scene within 120 s";
                bound = -1;
                break;
            }
            if (elapsed * 60 >= double(ticks + 1)) {
                game.tick(1.0 / 60.0);
                ++ticks;
            }
        }
        if (bound < 0)
            return std::fprintf(stderr, "TN_PLAYER_V8_GAME: %s\n", error.c_str()), 1;
        if (!checkRequest.empty()) {
            inspect::Host host;
            host.scene = game.scene(); host.gameRuntime = "v8";
            host.observe = [&game](const std::string& method, const json::Value* argument,
                                  json::Value& result, std::string& error) {
                return game.observe(method, argument, result, error);
            };
            inspect::Endpoint endpoint(host);
            const std::string response = endpoint.handle(checkRequest);
            std::printf("TN_PLAYER_V8_INSPECT_CHECK: %s\n", response.c_str());
            json::Value parsed; json::Error error;
            if (!json::parse(response, parsed, error) || parsed.find("error")) return 1;
        }
        const int status = finish(0);
        if (status != 0) return status;
        return std::printf("TN_PLAYER_V8_GAME_CHECK: engine=native gameRuntime=v8 startup=passed shadowMap=%s:%d\n",
                           game.shadowMapEnabled() ? "on" : "off", game.shadowMapType()), 0;
    }

    player::Game configured;
    configured.name = "game-v8-demo";
    configured.scene = game.scene();
    configured.camera = game.camera();
    configured.gameRuntime = "v8";
    configured.update = [&game](double dt) { game.tick(dt); };
    configured.initialize = [&game](Renderer& renderer) { game.initialize(renderer); };
    configured.beforeRender = [&game](Renderer& renderer, RenderDatabase& database) { game.beforeRender(renderer, database); };
    configured.clear = [&game] { return game.clearColor(); };
    configured.bridgeCalls = [] { return tn::abi::crossings(); };
    configured.frameComplete = [&game](Renderer& renderer, const std::vector<std::string>&) { game.frameDrawn(renderer); };
    configured.frameWithoutView = [&game] { game.frameWithoutView(); };
    configured.overlay = [&game] { return game.overlay(); };
    configured.drawOverlay = [&game](Renderer& renderer) { game.drawOverlay(renderer); };
    configured.setRenderBarrier = [&game](std::function<void()> barrier) { game.setRenderBarrier(std::move(barrier)); };
    // PRD-554: a built UI beside the game bundle (`ui/index.html`, where the packager stages it beside
    // the executable for the legacy host), through the legacy host's overlay seam; TN_UI_RENDERER=
    // native-css picks the CSS backend. The loop reaches it only through these hooks.
    const std::filesystem::path uiRoot = std::filesystem::path(gamePath).parent_path() / "ui";
    std::error_code noUi;
    if (std::filesystem::is_regular_file(uiRoot / "index.html", noUi)) {
        const char* renderer = std::getenv("TN_UI_RENDERER");
        const bool cssUi = renderer != nullptr && std::string(renderer) == "native-css";
#if defined(__linux__) && !defined(__ANDROID__)
        if (!cssUi) {
            // As the legacy host does (cli/main.cpp): the web view attaches to an X11 surface, so GTK
            // and SDL both take X11 before either starts, even inside a Wayland session.
            SDL_SetHintWithPriority(SDL_HINT_VIDEO_DRIVER, "x11", SDL_HINT_OVERRIDE);
            setenv("GDK_BACKEND", "x11", 1);
        }
#endif
        configured.uiAttach = [root = uiRoot.string(), cssUi](SDL_Window* window) {
            mystral::platform::setUiOverlayWindow(window);
            const bool attached = cssUi ? mystral::platform::attachDesktopCssUi(root)
                                        : mystral::platform::attachDesktopUiOverlay(root);
            if (!attached)
                std::printf("TN_UI_LOAD_FAILED: the %s UI in %s could not attach\n", cssUi ? "native-css" : "web",
                            root.c_str());
            return attached;
        };
        configured.uiFrame = [&game] { game.uiFrame(); };
        configured.uiDraw = [](Renderer& renderer) {
            mystral::platform::UiOverlayFrame ui;
            if (mystral::platform::uiOverlayFrame(ui))
                renderer.setOverlay(ui.pixels, ui.width, ui.height, ui.counter, ui.stride, !ui.isRgba);
        };
        configured.uiPointer = [](const char* type, float x, float y, int buttons) {
            return mystral::platform::uiOverlayAttached() && mystral::platform::uiOverlayRoutePointer(type, x, y, buttons, 1);
        };
        configured.uiResize = [](int width, int height) { mystral::platform::uiOverlaySetSize(width, height); };
        configured.uiDetach = [] {
            mystral::platform::detachDesktopUiOverlay();
            mystral::platform::setUiOverlayWindow(nullptr);
        };
    }
    configured.observe = [&game](const std::string& method, const json::Value* argument,
                                 json::Value& result, std::string& error) {
        return game.observe(method, argument, result, error);
    };
    configured.resource = [&game](const std::string& id, uint64_t tick) { return game.resource(id, tick); };
    configured.afterRender = [&game] { game.safePoint(); };
    configured.attach = [&game](inspect::Endpoint& endpoint) { game.attach(endpoint); };
    configured.view = [&game](Object3D*& scene, Camera*& camera, std::string& error) {
        const int bound = game.view(error);
        if (bound > 0) { scene = game.scene(); camera = game.camera(); }
        return bound;
    };
    // TN_PLAYER_CROSSINGS=1: after the run, the bridge crossings by name, most crossed first (the names sum to
    // the total), for finding which names a frame spends them on.
    const bool histogram = std::getenv("TN_PLAYER_CROSSINGS") != nullptr;
    if (histogram) tn::abi::crossingHistogramEnable(true);
    const int status = player::run(configured);
    if (histogram) {
        std::vector<std::pair<std::string, json::Value>> names;
        for (const auto& [name, count] : tn::abi::crossingHistogram()) names.emplace_back(name, json::Value::makeNumber(double(count)));
        std::printf("TN_PLAYER_CROSSINGS:%s\n", json::stringify(json::Value::makeObject({
            {"total", json::Value::makeNumber(double(tn::abi::crossings()))},
            {"collectVisits", json::Value::makeNumber(double(game.collectVisits()))},
            {"liveWrappers", json::Value::makeNumber(double(game.liveWrappers()))},
            {"names", json::Value::makeObject(std::move(names))}})).c_str());
        std::fflush(stdout);
    }
    return finish(status);
}
