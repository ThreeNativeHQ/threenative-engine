// PRD-540: the product browser host. `WebGPURenderer` on the Wasm engine
// (packages/three-native/src/browser-renderer.ts) drives it: init on the game's canvas, resize, and
// one presented frame per render() call. Rendering is the same RenderDatabase and Renderer as
// desktop; this file owns only device bring-up and the canvas surface. The test host
// (tests/native-engine/wasm/browser.cpp) keeps its fixed-canvas bench and package proofs.
#include "engine/abi/abi_internal.h"
#include "engine/foundation/waste_counters.h"
#include "engine/foundation/job_pool.h"
#include "engine/renderer/render_database.h"
#include "engine/renderer/frame_gate.h"
#include "engine/abi/binding.h"
#include "engine/renderer/render_target_pass.h"
#include "engine/renderer/post/traa.h"
#include "engine/renderer/probes/capture.h"
#include "engine/renderer/compute.h"
#include "engine/scene/geometry.h"
#include "engine/shader/graph/graph.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <vector>
#include <map>
#include <set>
#if TN_WEB_GLTF
#include "engine/assets/gltf/loader.h"
#endif

#include <emscripten/emscripten.h>

#include <map>
#include <memory>
#include <optional>
#include <string>

using namespace tn::engine;

namespace {
// The tnw_* contract with the facade (browser-renderer.ts `WEB_HOST_ABI`). Bump both on every tnw_*
// signature change: web-host-abi.spec.ts pins the signatures per number, and a mismatch fails init.
// 2 = tnw_web_render's overlay argument (39295d1f3).
// 3 = startup compilation. 4 = compilation plus temporal input scale in renderer state.
// 5 = tnw_web_threads (PRD-752). 6 = timestamp sampling in renderer state.
// 7 = tnw_web_prepare_environment: the startup bake presents no surface frame.
// 8 = tnw_web_set_presentation_hold, and the startup's world submission and shadow inputs as frame fields 71, 72.
constexpr uint32_t kWebHostAbi = 8;

enum WebState : int { Pending = 0, Ready = 1, Failed = 2 };

WebState state = Pending;
bool started = false;
std::string failure;
std::string adapterFacts[3];  // vendor, architecture, description
uint32_t width = 1, height = 1;
WGPUInstance instance = nullptr;
WGPUDevice device = nullptr;
WGPUQueue queue = nullptr;
WGPUSurface surface = nullptr;
WGPUTextureFormat surfaceFormat = WGPUTextureFormat_Undefined;
EventQueue events;
std::unique_ptr<Renderer> renderer;
RenderDatabase database;
RenderDatabase overlayDatabase;  // three's overlay render (core's canvas layer), drawn by renderer->overlayRenderer()
// The startup environment bake's own records: preparation runs beside the frame loop and must not overwrite the
// draws the frame database keeps for the frame it plans next.
RenderDatabase environmentDatabase;
Renderer* lastDrawn = nullptr;  // the renderer of the last tnw_web_render: its draws are that call's renderer.info
tn::engine::shader::graph::Node customToneMapping;
tn::engine::shader::graph::Node pendingPost;  // a RenderPipeline set before the device was ready
ComputeQueue computeQueue;  // PRD-620: renderer.compute kernels and storage reads, run in call order
// three's renderer settings the game last set (WebGPURenderer's defaults until it does), applied
// before the next frame, as the V8 player's setRendererState does.
OutputState output{std::nullopt, 1, true};
bool outputChanged = true;
bool postChanged = false;
bool shadowMap = false;
bool timestampTracking = true;
int shadowMapType = 1;  // PCFShadowMap
float renderScale = 1;
uint32_t sampleCount = 1;  // three's samples: 1 or 4x MSAA
// The drawn frames whose GPU work is unfinished. Chromium queues submitted frames without bound, so a page
// whose rAF outruns the GPU blocks until the GPU drains and the GPU process is killed (the device is lost:
// "A valid external Instance reference no longer exists"); the gate declines a frame once the GPU is
// really behind (tnw_web_frame field 11, rule in frame_gate.h).
tn::engine::FrameGate frameGate;
// Startup's first real frame (ABI 8). While the facade holds presentation every ordinary render still draws its
// scene, shadow, post and temporal passes but takes no canvas texture, so a startup frame whose inputs are not
// ready yet never reaches the display. `worldSubmissions` is field 71, `shadowInputsReady` field 72, and 72 is
// recomputed only while the hold is up: it walks every active atlas, and nothing reads it once the cover is gone.
bool presentationHeld = false;
uint64_t worldSubmissions = 0;
bool shadowInputsReady = false;

std::string text(WGPUStringView value) {
    if (value.data == nullptr) return {};
    return value.length == WGPU_STRLEN ? std::string(value.data) : std::string(value.data, value.length);
}

int fail(const std::string& message) {
    if (state != Failed) failure = message;
    state = Failed;
    return 1;
}

/**
 * A refusal that fails one call and leaves the host running (a render target's draw): tnw_web_error names it, once,
 * and tnw_web_poll still answers Ready, so the renderer keeps drawing. A Failed host keeps its first message.
 */
int refuse(const std::string& message) {
    if (state != Failed) failure = message;
    // Once per distinct refusal, on the console as a frame's refused program is: the throw each call raises
    // reaches the page's caller, which may catch it.
    static std::set<std::string> reported;
    if (reported.insert(message).second) std::fprintf(stderr, "TN_RENDERER: %s\n", message.c_str());
    return 1;
}

/**
 * PRD-771: running wall ms of the main view's tnw_web_render, the queued kernels' flush inside it, and the batched queue
 * submit that ends it (tnw_web_frame 75 to 77). The page differences two reads per frame; with the renderer's CPU meters
 * off (Renderer::setCpuMeters) a scope reads no clock and adds nothing.
 */
double hostRenderMs = 0, hostComputeMs = 0, hostSubmitMs = 0, hostPollMs = 0, hostTailMs = 0, hostDatabaseMs = 0, hostTargetMs = 0;
/**
 * The page reads the stage totals in place instead of by ten host calls a frame (the renderer's ABI census is pinned):
 * tnw_web_frame 78 answers this array's address, and every main-view render ends by writing the totals into it, in
 * the order of three-native's CPU_STAGE_FIELDS, then three work counts (dirty transforms, moving casters, queue bytes).
 */
double stageTotals[18] = {};
void publishStageTotals() {
    if (!renderer) return;
    const Renderer::CpuStage stages[] = {Renderer::CpuVirtualPages, Renderer::CpuPlan, Renderer::CpuShadowBuild,
                                         Renderer::CpuPrepare, Renderer::CpuEncode, Renderer::CpuPost};
    for (size_t i = 0; i < 6; ++i) stageTotals[i] = renderer->cpuStageMs(stages[i]);
    stageTotals[6] = database.sceneMs();
    stageTotals[7] = hostRenderMs;
    stageTotals[8] = hostComputeMs;
    stageTotals[9] = hostSubmitMs;
    stageTotals[10] = hostPollMs;
    stageTotals[11] = hostTailMs;
    // The work counts beside the times (PRD-771): transforms moved, casters judged moving, bytes the queue took.
    stageTotals[12] = database.rendererMs();
    stageTotals[13] = hostDatabaseMs;
    stageTotals[14] = hostTargetMs;
    stageTotals[15] = double(waste::counters().dirtyTransforms.load(std::memory_order_relaxed));
    stageTotals[16] = double(waste::counters().castersMoving.load(std::memory_order_relaxed));
    stageTotals[17] = double(renderer->gpu().queueWriteBytes());
}
struct HostMeter {
    double& total;
    double started = -1;
    HostMeter(double& total, bool counted) : total(total) {
        if (counted && Renderer::cpuMeters()) started = emscripten_get_now();
    }
    ~HostMeter() {
        if (started >= 0) total += emscripten_get_now() - started;
    }
};

/** Writes the totals into `stageTotals` when it goes out of scope; declare it before the HostMeter it follows. */
struct StagePublisher {
    bool counted;
    ~StagePublisher() {
        if (counted && Renderer::cpuMeters()) publishStageTotals();
    }
};

/** Runs the queued kernels and readbacks ahead of whatever draws or reads next; a refusal prints by name. */
void flushCompute() {
    if (state != Ready || !renderer || computeQueue.empty()) return;
    computeQueue.flush(*renderer, [](const std::string& reason) { std::fprintf(stderr, "%s\n", reason.c_str()); });
}

void configureWebSurface() {
    WGPUSurfaceConfiguration config = {};
    config.device = device;
    config.format = surfaceFormat;
    config.usage = WGPUTextureUsage_RenderAttachment;
    config.width = width;
    config.height = height;
    config.presentMode = WGPUPresentMode_Fifo;
    config.alphaMode = WGPUCompositeAlphaMode_Opaque;
    wgpuSurfaceConfigure(surface, &config);
    renderer->setSize(width, height);
}

void onDevice(WGPURequestDeviceStatus status, WGPUDevice result, WGPUStringView message, void*, void*) {
    if (status != WGPURequestDeviceStatus_Success) return static_cast<void>(fail("TN_WASM_DEVICE: " + text(message)));
    device = result;
    queue = wgpuDeviceGetQueue(device);
    setenv("TN_GPU_PASSES", EM_ASM_INT({ return globalThis.TN_GPU_PASSES === true; }) ? "1" : "0", 1);
    renderer = std::make_unique<Renderer>(instance, device, queue, events);
    renderer->setGpuTimer(timestampTracking);
    configureWebSurface();
    renderer->setOutput(output);
    outputChanged = false;
    if (pendingPost) renderer->setPostGraph(pendingPost);
    state = Ready;
}

void onAdapter(WGPURequestAdapterStatus status, WGPUAdapter adapter, WGPUStringView message, void*, void*) {
    if (status != WGPURequestAdapterStatus_Success) return static_cast<void>(fail("TN_WASM_ADAPTER: " + text(message)));
    WGPUAdapterInfo info = {};
    wgpuAdapterGetInfo(adapter, &info);
    adapterFacts[0] = text(info.vendor);
    adapterFacts[1] = text(info.architecture);
    adapterFacts[2] = text(info.description);
    wgpuAdapterInfoFreeMembers(info);
    WGPUSurfaceCapabilities caps = {};
    if (wgpuSurfaceGetCapabilities(surface, adapter, &caps) != WGPUStatus_Success || caps.formatCount == 0) {
        wgpuAdapterRelease(adapter);
        return static_cast<void>(fail("TN_WASM_SURFACE: no supported format"));
    }
    surfaceFormat = caps.formats[0];
    wgpuSurfaceCapabilitiesFreeMembers(caps);
    WGPURequestDeviceCallbackInfo callback = {};
    callback.mode = WGPUCallbackMode_AllowProcessEvents;
    callback.callback = onDevice;
    // The features the desktop host asks for (webgpu/context.cpp buildRequiredFeatures), each when
    // the adapter has it: without float32-filterable a linear-filtered FloatType texture is refused.
    std::vector<WGPUFeatureName> features;
    for (WGPUFeatureName feature : {WGPUFeatureName_TimestampQuery, WGPUFeatureName_Float32Filterable, WGPUFeatureName_Float32Blendable,
                                    WGPUFeatureName_RG11B10UfloatRenderable, WGPUFeatureName_TextureCompressionBC,
                                    WGPUFeatureName_TextureCompressionETC2, WGPUFeatureName_TextureCompressionASTC})
        if (wgpuAdapterHasFeature(adapter, feature)) features.push_back(feature);
    WGPUDeviceDescriptor desc = {};
    desc.requiredFeatureCount = features.size();
    desc.requiredFeatures = features.data();
    desc.uncapturedErrorCallbackInfo.callback = [](WGPUDevice const*, WGPUErrorType, WGPUStringView message, void*, void*) {
        events.post([message = text(message)] { fail("TN_WASM_DEVICE_ERROR: " + message); });
    };
    desc.deviceLostCallbackInfo.mode = WGPUCallbackMode_AllowProcessEvents;
    desc.deviceLostCallbackInfo.callback = [](WGPUDevice const*, WGPUDeviceLostReason, WGPUStringView message, void*, void*) {
        events.post([message = text(message)] { fail("TN_WASM_DEVICE_LOST: " + message); });
    };
    wgpuAdapterRequestDevice(adapter, &desc, callback);
    wgpuAdapterRelease(adapter);
}

bool validSize(uint32_t w, uint32_t h) { return w >= 1 && h >= 1 && w <= 8192 && h <= 8192; }

template <class T>
T* objectAs(const tn_handle_t* handle, const char* cls) {
    auto* object = handle == nullptr ? nullptr : tn::abi::objectOf(*handle);
    if (object == nullptr || object->cls != cls) return nullptr;
    return static_cast<T*>(object->ptr.get());
}

/** three renders any Object3D as the root (a QuadMesh is a Mesh), not only a Scene. */
Object3D* rootOf(const tn_handle_t* handle) {
    auto* object = handle == nullptr ? nullptr : tn::abi::objectOf(*handle);
    if (object == nullptr || !tn::binding::isObject3DClass(object->cls)) return nullptr;
    return static_cast<Object3D*>(object->ptr.get());
}

Camera* cameraOf(const tn_handle_t* handle) {
    if (auto* camera = objectAs<PerspectiveCamera>(handle, "PerspectiveCamera")) return camera;
    return objectAs<OrthographicCamera>(handle, "OrthographicCamera");
}
} // namespace

/** The web host ABI this module speaks; the facade refuses a module whose number differs. */
extern "C" uint32_t tnw_web_host_abi() { return kWebHostAbi; }

/** The job pool's workers (PRD-752 phase 4), started on the first job: 0 in the single-thread build. */
extern "C" uint32_t tnw_web_threads() { return tn::engine::JobPool::defaultWorkers(); }

/**
 * Starts adapter and device requests on the canvas `selector` names; poll until Ready or Failed.
 * `facadeAbi` is the facade's WEB_HOST_ABI: a facade older than the number passes none (0), and
 * would otherwise call every later export with the arguments of another ABI.
 */
extern "C" int tnw_web_init(const char* selector, uint32_t w, uint32_t h, uint32_t facadeAbi) {
    if (facadeAbi != kWebHostAbi)
        return fail("TN_WASM_ABI_MISMATCH: the facade speaks web host ABI " + std::to_string(facadeAbi) +
                    ", this engine " + std::to_string(kWebHostAbi) +
                    ": install create-threenative and @threenative/runtime-native from one build");
    if (started) return fail("TN_WASM_INIT: already initialized");
    started = true;
    // A fresh page presents from its first ready frame; only a startup's own hold may defer that.
    presentationHeld = false;
    worldSubmissions = 0;
    shadowInputsReady = false;
    if (selector == nullptr || !validSize(w, h)) return fail("TN_WASM_INIT: canvas selector or size invalid");
    width = w;
    height = h;
    instance = wgpuCreateInstance(nullptr);
    if (instance == nullptr) return fail("TN_WASM_INIT: no WebGPU instance");
    WGPUEmscriptenSurfaceSourceCanvasHTMLSelector canvas = {};
    canvas.chain.sType = WGPUSType_EmscriptenSurfaceSourceCanvasHTMLSelector;
    canvas.selector = {selector, WGPU_STRLEN};
    WGPUSurfaceDescriptor desc = {};
    desc.nextInChain = &canvas.chain;
    surface = wgpuInstanceCreateSurface(instance, &desc);
    if (surface == nullptr) return fail("TN_WASM_SURFACE: canvas missing");
    WGPURequestAdapterOptions options = {};
    options.compatibleSurface = surface;
    WGPURequestAdapterCallbackInfo callback = {};
    callback.mode = WGPUCallbackMode_AllowProcessEvents;
    callback.callback = onAdapter;
    wgpuInstanceRequestAdapter(instance, &options, callback);
    return 0;
}

/** Delivers pending WebGPU callbacks at this boundary; returns Pending, Ready or Failed. */
extern "C" int tnw_web_poll() {
    if (renderer) renderer->poll();
    else if (instance) wgpuInstanceProcessEvents(instance);
    events.drain();
    return state;
}

extern "C" const char* tnw_web_error() { return failure.c_str(); }

extern "C" const char* tnw_web_adapter(int field) {
    return field >= 0 && field < 3 ? adapterFacts[field].c_str() : "";
}

extern "C" int tnw_web_resize(uint32_t w, uint32_t h) {
    if (!validSize(w, h)) return fail("TN_WASM_RESIZE: size invalid");
    width = w;
    height = h;
    if (renderer) configureWebSurface();
    return 0;
}

/**
 * Holds the canvas at its current picture while a startup's first world frame is still cold (ABI 8): every ordinary
 * render keeps drawing, but takes no surface texture, so the frame lands in the renderer's own output target and the
 * player keeps seeing the cover. An overlay still presents over what is already on the canvas. Core releases the hold
 * on the first frame whose inputs are ready (frame fields 71 and 72) and the next world frame is presented.
 */
extern "C" void tnw_web_set_presentation_hold(int held) { presentationHeld = held != 0; }

/**
 * Draws `scene` from `camera` into the canvas; the browser presents it at its animation boundary. A nonzero `overlay`
 * is three's overlay render (core's canvas layer): drawn over the frame already on the canvas, with no post and no
 * temporal step (Renderer::overlayRenderer). The canvas texture is taken only by a frame that draws: a frame the
 * renderer skips while an environment bakes leaves the last presented frame on screen.
 */
extern "C" int tnw_web_render(const tn_handle_t* sceneHandle, const tn_handle_t* cameraHandle, double r, double g,
                              double b, double a, int overlay, uint32_t sourceFrame) {
    const StagePublisher publisher{!overlay};  // declared first, so it runs after the meter below has closed
    const HostMeter renderMeter(hostRenderMs, !overlay);
    {
        const HostMeter pollMeter(hostPollMs, !overlay);  // delivers the queue's callbacks: readbacks, work-done
        tnw_web_poll();
    }
    if (state != Ready) return fail(state == Pending ? "TN_WASM_RENDER: device not ready" : failure);
    auto* scene = rootOf(sceneHandle);
    auto* camera = cameraOf(cameraHandle);
    if (scene == nullptr || camera == nullptr) return fail("TN_WASM_RENDER: scene or camera handle invalid");
    WGPUSurfaceTexture frame = {};
    WGPUTextureView view = nullptr;
    const auto acquire = [&]() -> WGPUTextureView {
        wgpuSurfaceGetCurrentTexture(surface, &frame);
        if (frame.texture == nullptr) throw std::runtime_error("TN_WASM_SURFACE: no canvas texture");
        return view = wgpuTextureCreateView(frame.texture, nullptr);
    };
    {
        const HostMeter computeMeter(hostComputeMs, !overlay);
        flushCompute();
    }
    if (outputChanged) renderer->setOutput(output);
    outputChanged = false;
    // RenderPipeline installs its graph before the facade submits renderer settings. Compile only
    // now, when an explicit renderOutput(..., 5) can see the registered curve on its first frame.
    // A refusal the renderer throws (an unported feature, a refused binding, a post graph it cannot build) is this
    // frame's named failure, never a bare WebAssembly.Exception in the page.
    std::string refused;
    try {
        if (postChanged) renderer->setPostGraph(pendingPost);
    } catch (const std::exception& error) {
        refused = error.what();
    }
    postChanged = false;
    database.shadowMapEnabled = shadowMap;
    database.shadowMapType = shadowMapType;
    try {
        if (!refused.empty()) throw std::runtime_error(refused);
        if (overlay) {
            Renderer& target = renderer->overlayRenderer();
            lastDrawn = &target;
            Renderer::PresentScope present(target, acquire, surfaceFormat);
            overlayDatabase.render(target, *scene, *camera, {0, 0, 0, 0});
        } else {
            lastDrawn = renderer.get();
            renderer->setSampleCount(sampleCount);
            renderer->setRenderScale(renderScale);
            renderer->setGpuTimerSourceFrame(sourceFrame);  // the sample resolves under the caller's frame id, not the readback's
            // Held, a startup frame draws its scene, shadow, post and temporal passes into the renderer's own output
            // target and takes no canvas texture, so nothing whose inputs are still cold is presented. It is the same
            // frame either way: the acquire is only left unasked, and the submission and the frame gate are unchanged.
            // The view is asked for by the encode, never here: a frame that draws nothing (an environment still
            // baking) or throws after the hold released took no canvas texture, and presented nothing over the last
            // real picture. `renderPrepared` draws into the renderer's own output for a null view.
            Renderer::PresentScope present(
                *renderer, [&]() -> WGPUTextureView { return presentationHeld ? nullptr : acquire(); },
                surfaceFormat);
            uint64_t submission;
            {
                const HostMeter databaseMeter(hostDatabaseMs, true);
                submission = database.render(*renderer, *scene, *camera, {r, g, b, a});
            }
            // A frame the environment bake gated (0) drew nothing, so it is not one of the startup's world submissions.
            if (submission != 0) {
                ++worldSubmissions;
                // Every active atlas walked, so only a held frame asks: nothing reads this field once the cover is gone.
                if (presentationHeld) shadowInputsReady = renderer->virtualShadowsInitialized();
            }
        }
    } catch (const std::exception& error) {
        refused = error.what();
    }
    {
        const HostMeter tailMeter(hostTailMs, !overlay);
        if (view) wgpuTextureViewRelease(view);
        if (frame.texture) wgpuTextureRelease(frame.texture);
    }
    // A render target draw batches its submit until the next one that does not batch, so a target drawn last would
    // leave the frame's serial off the queue: no work-done ever arrives, the gate declines every later frame, and
    // nothing submits again (a timestamp readback each frame used to flush it). The frame's work goes now.
    {
        const HostMeter submitMeter(hostSubmitMs, !overlay);
        GpuResources::flushSubmits();
    }
    const HostMeter diagnosticsMeter(hostTailMs, !overlay);  // the gate's note and the diagnostics below, to the return
    frameGate.submitted(renderer->gpu().submittedSerial(), emscripten_get_now());
    // A refused program or skipped draw, as the V8 player prints it: once each, as a console error,
    // so a page that draws less than its scene says why. TN_POST_NORMAL_SKIPPED is a note, not a fault (the
    // post pass reads a depth-derived normal there), and so is TN_TRAA_VELOCITY_SKIPPED (the draw moves with
    // the camera) and TN_TRAA_MSAA_OFF (the temporal pass replaces the multisampling), so they go to the console log, which a
    // playtest's no-console-errors policy does not fail on.
    static std::set<std::string> reported;
    for (const std::string& diagnostic : (lastDrawn ? *lastDrawn : *renderer).diagnostics())
        if (reported.insert(diagnostic).second) {
            const bool note = diagnostic.rfind("TN_POST_NORMAL_SKIPPED", 0) == 0 || diagnostic.rfind("TN_TRAA_VELOCITY_SKIPPED", 0) == 0 ||
                              diagnostic.rfind("TN_TRAA_MSAA_OFF", 0) == 0;
            std::fprintf(note ? stdout : stderr, "TN_RENDERER: %s\n", diagnostic.c_str());
        }
    if (!refused.empty()) return fail(refused);
    const RenderDatabase& drawn = overlay ? overlayDatabase : database;
    if (!drawn.diagnostics().empty()) return fail(drawn.diagnostics().front());
    return 0;
}

/**
 * Startup warm-up's environment bake, three's PMREM preparer (core's prepareSceneEnvironment): prepares the scene's
 * environment inputs and advances the retained bake, with no surface frame, no shadow pass, no post and no temporal
 * step. 1 once every environment the scene samples is baked, 0 while it still bakes, -1 when refused (tnw_web_error
 * names it). The bake used to draw through tnw_web_render, so its last draw presented an unfinished world (bright,
 * without cast shadows) as the page's first picture until the next frame replaced it.
 */
extern "C" int tnw_web_prepare_environment(const tn_handle_t* sceneHandle, const tn_handle_t* cameraHandle) {
    tnw_web_poll();
    if (state != Ready) {
        fail(state == Pending ? "TN_WASM_PREPARE: device not ready" : failure);
        return -1;
    }
    auto* scene = rootOf(sceneHandle);
    auto* camera = cameraOf(cameraHandle);
    if (scene == nullptr || camera == nullptr) {
        fail("TN_WASM_PREPARE: scene or camera handle invalid");
        return -1;
    }
    flushCompute();  // an environment source a queued kernel writes must exist before it is baked
    try {
        environmentDatabase.shadowMapEnabled = shadowMap;
        environmentDatabase.shadowMapType = shadowMapType;
        const bool ready = environmentDatabase.prepareEnvironments(*renderer, *scene, *camera);
        // A batched target draw would leave the bake's submission waiting: its work-done never arrives and no later
        // step can observe the packet completing.
        GpuResources::flushSubmits();
        return ready ? 1 : 0;
    } catch (const std::exception& error) {
        fail(std::string("TN_WASM_PREPARE: ") + error.what());
        return -1;  // fail() answers 1, which is this call's "baked"
    }
}

namespace {
// three's compileAsync, by the id tnw_web_compile_async returned: the pipelines still compiling.
std::map<uint32_t, std::vector<std::shared_ptr<PipelineCompilation>>> compilations;
uint32_t nextCompilation = 1;
} // namespace

/**
 * three's compileAsync(root, camera, targetScene), as the V8 player's: builds every pipeline the first draw of `root`
 * will take, with the renderer settings that draw will use, through createRenderPipelineAsync, so the browser compiles
 * them off the queue instead of stalling the first frames behind each one. Returns the id tnw_web_compile_status
 * polls, or 0 when it refused (tnw_web_error names it; the host keeps drawing, and the first draw compiles instead).
 */
extern "C" uint32_t tnw_web_compile_async(const tn_handle_t* rootHandle, const tn_handle_t* cameraHandle,
                                          const tn_handle_t* sceneHandle) {
    tnw_web_poll();
    if (state != Ready) {
        if (state == Pending) refuse("TN_WASM_COMPILE: device not ready");  // a Failed host keeps its message
        return 0;
    }
    auto* root = rootOf(rootHandle);
    auto* camera = cameraOf(cameraHandle);
    auto* scene = sceneHandle ? rootOf(sceneHandle) : nullptr;
    if (!root || !camera || (sceneHandle && !scene)) {
        refuse("TN_WASM_COMPILE: root, camera or target scene invalid");
        return 0;
    }
    try {
        if (outputChanged) renderer->setOutput(output);
        outputChanged = false;
        if (postChanged) renderer->setPostGraph(pendingPost);
        postChanged = false;
        renderer->setSampleCount(sampleCount);
        RenderDatabase compiling;  // the frame's own database keeps its records for the draws
        compiling.shadowMapEnabled = shadowMap;
        compiling.shadowMapType = shadowMapType;
        compilations[nextCompilation] = compiling.compileAsync(*renderer, *root, *camera, scene, surfaceFormat);
    } catch (const std::exception& error) {
        refuse(std::string("TN_WASM_COMPILE: ") + error.what());
        return 0;
    }
    return nextCompilation++;
}

/** 0 while a pipeline of compilation `id` still compiles, 1 once every one is built, -1 when one was refused (named by tnw_web_error). */
extern "C" int tnw_web_compile_status(uint32_t id) {
    tnw_web_poll();
    const auto found = compilations.find(id);
    if (state == Failed && found != compilations.end()) {
        compilations.erase(found);  // a lost device may never complete the pipelines; its failure names why
        return -1;
    }
    if (found == compilations.end()) {
        refuse("TN_WASM_COMPILE: no compilation " + std::to_string(id));
        return -1;
    }
    for (const auto& pipeline : found->second)
        if (!pipeline->ready()) return 0;
    std::string refused;
    for (const auto& pipeline : found->second) {
        try { pipeline->get(); } catch (const std::exception& error) { refused = error.what(); break; }
    }
    compilations.erase(found);
    if (!refused.empty()) {
        refuse("TN_WASM_PIPELINE_REFUSED: " + refused);
        return -1;
    }
    return 1;
}

/**
 * three's render() while a render target is set (PRD-551): draws `root` through `camera` into the
 * target, the linear scene colour, as r185 writes a target. Fails, naming the first refusal, when the
 * target's render refused or skipped anything. A nonzero `deferred` plans the draw now and records it in the frame that
 * samples the target (Renderer::deferTarget).
 */
extern "C" int tnw_web_render_target(const tn_handle_t* targetHandle, const tn_handle_t* rootHandle,
                                     const tn_handle_t* cameraHandle, double r, double g, double b, double a,
                                     int deferred) {
    // A render target's draw is renderer work inside the page's render() call too (a post graph's offscreen passes), so it
    // counts toward the same host total; the totals publish when it ends so a draw after the main view is not left behind.
    const StagePublisher publisher{true};
    const HostMeter renderMeter(hostRenderMs, true);
    tnw_web_poll();
    if (state != Ready) return fail(state == Pending ? "TN_WASM_RENDER: device not ready" : failure);
    auto* target = objectAs<RenderTarget>(targetHandle, "RenderTarget");
    auto* root = rootOf(rootHandle);
    auto* camera = cameraOf(cameraHandle);
    if (target == nullptr || root == nullptr || camera == nullptr)
        return fail("TN_WASM_RENDER_TARGET: target, root or camera handle invalid");
    flushCompute();  // a material in the target may read what a queued kernel writes
    try {
        std::vector<std::string> refused;
        {
            const HostMeter targetMeter(hostTargetMs, true);
            refused = renderToTarget(*renderer, *target, *root, *camera, {r, g, b, a}, shadowMap, deferred != 0);
        }
        if (!refused.empty()) return refuse(refused.front());
        return 0;
    } catch (const std::exception& error) {
        return refuse(error.what());  // preserve backgroundNode's named compile refusal across the Wasm boundary
    }
}

namespace {
/** readRenderTargetPixelsAsync's pending reads by id: RGBA16Float rows once delivered. */
struct TargetRead {
    int status = 0;  // 0 pending, 1 delivered, -1 failed
    std::vector<uint8_t> bytes;
};
std::map<uint32_t, TargetRead> targetReads;
uint32_t nextTargetRead = 0;
}  // namespace

/** Starts reading [x, y, w, h] of the target's last render; returns its id, or 0 (tnw_web_error says why). */
extern "C" uint32_t tnw_web_read_target(const tn_handle_t* targetHandle, uint32_t x, uint32_t y, uint32_t w, uint32_t h) {
    auto* target = objectAs<RenderTarget>(targetHandle, "RenderTarget");
    if (target == nullptr) return fail("TN_WASM_READ_TARGET: not a RenderTarget"), 0;
    flushCompute();
    const uint32_t id = ++nextTargetRead;
    targetReads[id] = {};
    const GpuStatus started = readRenderTarget(*target, x, y, w, h, [id](GpuStatus status, std::vector<uint8_t> bytes) {
        auto found = targetReads.find(id);
        if (found == targetReads.end()) return;
        found->second.status = status == GpuStatus::Ok ? 1 : -1;
        found->second.bytes = std::move(bytes);
    });
    if (started != GpuStatus::Ok) {
        targetReads.erase(id);
        return fail(started == GpuStatus::InvalidHandle ? "TN_WASM_READ_TARGET: the target never rendered"
                                                        : "TN_WASM_READ_TARGET: region outside the target"), 0;
    }
    return id;
}

/** Starts one HDR cube face. -2 means environment pending, -1 refusal, otherwise a read id. */
extern "C" int32_t tnw_web_capture_face(const tn_handle_t* rootHandle, double x, double y, double z,
                                        uint32_t size, uint32_t face) {
    tnw_web_poll();
    auto* root = rootOf(rootHandle);
    if (state != Ready || !root) return refuse("TN_REFLECTION_CAPTURE_SCENE"), -1;
    flushCompute();
    const uint32_t id = ++nextTargetRead;
    targetReads[id] = {};
    try {
        const auto started = probes::captureFace(*renderer, *root, Vector3{x, y, z}, size, face, 0.01, 2000,
            [id](GpuStatus status, std::vector<float> rgb) {
                auto& read = targetReads.at(id);
                read.status = status == GpuStatus::Ok ? 1 : -1;
                read.bytes.resize(rgb.size() * sizeof(float));
                std::memcpy(read.bytes.data(), rgb.data(), read.bytes.size());
            });
        if (started == GpuStatus::Ok) return int32_t(id);
        targetReads.erase(id);
        if (started == GpuStatus::Pending) return -2;
        return refuse("TN_REFLECTION_CAPTURE_FACE"), -1;
    } catch (const std::exception& error) {
        targetReads.erase(id);
        return refuse(error.what()), -1;
    }
}

/** The read's state (0 pending, 1 delivered, -1 failed); delivered bytes are copied to `out` and the read ends. */
extern "C" int tnw_web_read_target_take(uint32_t id, uint8_t* out, uint32_t capacity) {
    auto found = targetReads.find(id);
    if (found == targetReads.end()) return -1;
    const int status = found->second.status;
    if (status == 1 && (out == nullptr || capacity < found->second.bytes.size())) return -1;
    if (status == 1) std::memcpy(out, found->second.bytes.data(), found->second.bytes.size());
    if (status != 0) targetReads.erase(found);
    return status;
}

/**
 * PRD-620, three's renderer.compute(node): queues the kernel with its uniform values as of now. A kernel the
 * engine cannot hold refuses here, by name, and leaves the renderer running (tnw_web_error says why).
 */
extern "C" int tnw_web_compute(tn_context_t* context, const uint64_t* node) {
    auto graph = node == nullptr ? shader::graph::Node{} : tn::abi::tslNode(context, *node);
    try {
        if (!graph) throw std::runtime_error("TN_COMPUTE_NODE: renderer.compute takes the node Fn(() => { ... })().compute(count) makes");
        computeQueue.dispatch(graph);
    } catch (const std::exception& error) {
        failure = error.what();
        return 1;
    }
    return 0;
}

/** Runs everything queued so far; a read waits for it. */
extern "C" void tnw_web_compute_flush() {
    tnw_web_poll();
    flushCompute();
}

namespace {
/** getArrayBufferAsync's pending reads by id: the storage buffer's bytes once delivered. */
std::map<uint32_t, TargetRead> storageReads;
uint32_t nextStorageRead = 0;

std::shared_ptr<BufferAttribute> attributeOf(const tn_handle_t* handle) {
    auto* object = handle == nullptr ? nullptr : tn::abi::objectOf(*handle);
    if (object == nullptr || object->cls != "BufferAttribute") return nullptr;
    return std::static_pointer_cast<BufferAttribute>(object->ptr);
}
}  // namespace

/** Queues a copy of the attribute's GPU buffer after every kernel queued before; returns its id, or 0. */
extern "C" uint32_t tnw_web_read_storage(const tn_handle_t* attributeHandle) {
    const auto attribute = attributeOf(attributeHandle);
    if (!attribute) {
        failure = "TN_NATIVE_READ_STORAGE: expected the BufferAttribute of a storage buffer";
        return 0;
    }
    const uint32_t id = ++nextStorageRead;
    storageReads[id] = {};
    computeQueue.readback(attribute, [id](GpuStatus status, std::vector<uint8_t> bytes) {
        auto found = storageReads.find(id);
        if (found == storageReads.end()) return;
        found->second.status = status == GpuStatus::Ok ? 1 : -1;
        found->second.bytes = std::move(bytes);
    });
    return id;
}

/** The delivered read's byte length, or 0 while it is pending or failed. */
extern "C" uint32_t tnw_web_read_storage_size(uint32_t id) {
    const auto found = storageReads.find(id);
    return found == storageReads.end() || found->second.status != 1 ? 0 : static_cast<uint32_t>(found->second.bytes.size());
}

/** The read's state (0 pending, 1 delivered, -1 failed); delivered bytes are copied to `out` and the read ends. */
extern "C" int tnw_web_read_storage_take(uint32_t id, uint8_t* out, uint32_t capacity) {
    auto found = storageReads.find(id);
    if (found == storageReads.end()) return -1;
    const int status = found->second.status;
    if (status == 1 && (out == nullptr || capacity < found->second.bytes.size())) return -1;
    if (status == 1) std::memcpy(out, found->second.bytes.data(), found->second.bytes.size());
    if (status != 0) storageReads.erase(found);
    return status;
}

/** three's renderer.deleteAttribute: drops the attribute's GPU copy once the kernels queued so far have run. */
extern "C" int tnw_web_delete_storage(const tn_handle_t* attributeHandle) {
    const auto attribute = attributeOf(attributeHandle);
    if (!attribute) {
        failure = "TN_NATIVE_DELETE_ATTRIBUTE: expected a BufferAttribute";
        return 1;
    }
    computeQueue.release(attribute);
    return 0;
}

/**
 * three's `toneMapping`, `toneMappingExposure`, `outputColorSpace` and `shadowMap.{enabled,type}`,
 * applied before the next frame. A value the engine does not implement is refused by name; a refusal
 * leaves the renderer running.
 */
extern "C" int tnw_web_renderer_state(double toneMapping, double exposure, const char* colorSpace, int shadowEnabled,
                                      double shadowType, double samples, double scale, int trackTimestamp) {
    std::string refusal;
    const auto next = outputStateOf(toneMapping, exposure, colorSpace, refusal, customToneMapping);
    // PCFShadowMap and PCFSoftShadowMap are the filters the engine draws (PCFShadowFilter, PCFSoftShadowFilter).
    if (next && shadowType != 1 && shadowType != 2) refusal = "shadowMap.type must be PCFShadowMap or PCFSoftShadowMap";
    if (samples != 1 && samples != 4) refusal = "samples must be 1 or 4";
    if (!std::isfinite(scale) || scale < 0.25 || scale > 1) refusal = "renderScale must be between 0.25 and 1";
    if (!refusal.empty()) {
        if (state != Failed) failure = "TN_NATIVE_RENDERER_STATE: " + refusal;
        return 1;
    }
    if (next->toneMapping != output.toneMapping || next->toneMappingExposure != output.toneMappingExposure ||
        next->srgb != output.srgb || next->customToneMapping != output.customToneMapping) {
        output = *next;
        outputChanged = true;
    }
    shadowMap = shadowEnabled != 0;
    shadowMapType = static_cast<int>(shadowType);
    sampleCount = static_cast<uint32_t>(samples);
    renderScale = static_cast<float>(scale);
    timestampTracking = trackTimestamp != 0;
    if (renderer) renderer->setGpuTimer(timestampTracking);
    return 0;
}

/**
 * three's RenderPipeline: the TSL graph between the scene and the output, by its tn_tsl_* id in
 * `context`, or none (null). The same graph again is a no-op, as RenderPipeline.render() hands it
 * every frame (PRD-540; the V8 player's setPostGraph).
 */
extern "C" int tnw_web_set_post(tn_context_t* context, const uint64_t* node, int toneMapping) {
    static shader::graph::Node current;
    shader::graph::Node graph;
    if (node != nullptr) {
        graph = tn::abi::tslNode(context, *node);
        if (!graph) return fail("TN_WASM_POST: not a TSL node of this context");
    }
    if (toneMapping) { customToneMapping = graph; return 0; }
    if (graph == current) return 0;
    current = graph;
    pendingPost = graph;
    postChanged = true;
    return 0;
}

namespace {
std::string loadFailure;  // why the last tnw_web_load_gltf refused; never fails the host itself
// The files a model names by relative uri (shared images the cook writes beside it), put there by the
// page before the load, since the host reads no files of its own.
std::map<std::string, std::vector<uint8_t>> modelFiles;
}

/** Keeps one file for the next tnw_web_load_gltf calls, by the uri the model names it with. */
extern "C" int tnw_web_gltf_file(const char* uri, const uint8_t* bytes, uint32_t size) {
    if (!uri || (!bytes && size)) return 1;
    modelFiles[uri].assign(bytes, bytes + size);
    return 0;
}

/** Drops every file tnw_web_gltf_file kept. */
extern "C" void tnw_web_gltf_files_clear() { modelFiles.clear(); }

/** Why the last tnw_web_load_gltf call refused, or empty. */
extern "C" const char* tnw_web_load_error() { return loadFailure.c_str(); }

/**
 * A GLB through the engine's own glTF loader (PRD-540), the same C++ the V8 player's loadAsset runs:
 * the default scene, then each animation clip, as handles in `context`. `out` holds `capacity`
 * handles; `count` answers how many there are (scene + clips), so a short buffer can be retried.
 * Returns 0, or 1 with tnw_web_load_error set. A model whose images did not decode is refused by
 * name, as on V8, rather than drawn without its textures.
 */
extern "C" int tnw_web_load_gltf(tn_context_t* context, const uint8_t* bytes, uint32_t size, tn_handle_t* out,
                                 uint32_t capacity, uint32_t* count) {
    loadFailure.clear();
#if TN_WEB_GLTF
    if (!context || !bytes || !size || !count) return loadFailure = "TN_WASM_GLTF: invalid arguments", 1;
    gltf::LoadOptions options;
    options.readUri = [](const std::string& uri) -> std::span<const uint8_t> {
        const auto found = modelFiles.find(uri);
        return found == modelFiles.end() ? std::span<const uint8_t>{} : std::span<const uint8_t>(found->second);
    };
    auto loaded = gltf::load(std::span<const uint8_t>(bytes, size), options);
    if (!loaded.error.empty()) return loadFailure = loaded.error, 1;
    if (!loaded.scene) return loadFailure = "TN_WASM_GLTF: the file has no scene", 1;
    bool undecoded = false;
    loaded.scene->traverse([](Object3D& object, void* result) {
        auto* mesh = dynamic_cast<Mesh*>(&object);
        if (!mesh || !mesh->material) return;
        for (const auto& [slot, map] : mesh->material->maps)
            if (map && !map->hasImage()) *static_cast<bool*>(result) = true;
    }, &undecoded);
    if (undecoded) return loadFailure = "TN_NATIVE_GLTF_IMAGE_UNSUPPORTED: the model has undecoded images", 1;
    *count = 1 + static_cast<uint32_t>(loaded.animations.size());
    if (!out || capacity < *count) return loadFailure = "TN_WASM_GLTF_CAPACITY", 1;
    out[0] = tn::abi::shareObject(context, "Group", loaded.scene);
    for (uint32_t i = 0; i < loaded.animations.size(); ++i)
        out[1 + i] = tn::abi::shareObject(context, "AnimationClip", loaded.animations[i]);
    return 0;
#else
    (void)context; (void)bytes; (void)size; (void)out; (void)capacity; (void)count;
    loadFailure = "TN_WASM_GLTF_UNAVAILABLE: this web engine was built without cgltf";
    return 1;
#endif
}

/**
 * The last frame's draws (0) and triangles (1), as three's `renderer.info.render` reports them, then
 * the setup work done so far, which a steady frame must not add to: pipeline compiles (2), pipeline
 * text-key lookups (3), bind groups created (4), graph keys serialized (5), programs built (6),
 * the last resolved GPU frame time in ms (7), how many GPU times have resolved (8), the caller
 * frame id that sample was submitted under (9), whether frames are timed at all (10), and 1 while
 * two drawn frames are still on the GPU, so the caller draws none (11), and 1 while the last render skipped
 * its frame for an environment that is not baked yet (12). The temporal pass follows: 1 while a traa() effect is in
 * the post graph (13), the frames it has begun (14), 1 when the next resolve has history (15), and the last
 * sub-pixel jitter in pixels, x (16) and y (17). Then the samples the scene draws with (18): 1 while the temporal pass
 * replaces the multisampling the renderer asked for.
 * The temporal pass's counted frame follows the lamp fields, 30 to 33. The kept shadow maps and the uniform bytes are 40 and 41.
 */
extern "C" double tnw_web_frame(int field) {
    // -3 and -4: the CPU stage meters on and off (PRD-771); a static switch, so it answers before the renderer exists.
    // On until a page asks otherwise.
    if (field == -3 || field == -4) {
        Renderer::setCpuMeters(field == -3);
        return 0;
    }
    if (!renderer) return 0;
    if (!lastDrawn) lastDrawn = renderer.get();
    switch (field) {
        case -1: renderer->setDebugTimestampRequested(true); return 0;
        case -2: renderer->setDebugTimestampRequested(false); return 0;
        // three's renderer.info.render counts every pass of a render(), the shadow pass's included, as the
        // V8 player's frameDrawn does: one scene is counted the same on every backend.
        case 0: return double(lastDrawn->lastFrame().draws + lastDrawn->lastFrame().shadowDraws);
        case 1: return double(lastDrawn->lastFrame().triangles + lastDrawn->lastFrame().shadowTriangles);
        case 2: return double(renderer->pipelines().compiles());
        case 3: return double(renderer->pipelines().textLookups());
        case 4: return double(bindGroupsCreated());
        case 5: return double(shader::graph::keyBuilds());
        case 6: return double(renderer->programCount());
        case 7: return renderer->lastGpuMs();
        case 8: return double(renderer->gpuSamples());
        case 9: return double(renderer->gpuSourceFrame());
        case 10: return renderer->gpuTimerAvailable() ? 1 : 0;
        case 11:
            tnw_web_poll();  // delivers the work-done callbacks that advance completedSerial
            return frameGate.decline(renderer->gpu().completedSerial(), emscripten_get_now()) ? 1 : 0;
        case 12: return renderer->environmentPending() ? 1 : 0;
        case 13: return renderer->temporalStatus().active ? 1 : 0;
        case 14: return double(renderer->temporalStatus().frame);
        case 15: return renderer->temporalStatus().historyValid ? 1 : 0;
        case 16: return renderer->temporalStatus().jitterX;
        case 17: return renderer->temporalStatus().jitterY;
        case 18: return double(renderer->sampleCount());
        // The sample field 7 reports, by what drew it: 19 shadow passes, 20 the scene pass, 21 other passes, 22 the
        // output pass, 23 the screen-space gather (frame_gpu_timer.h). They sum to field 7.
        case 19: case 20: case 21: case 22: case 23: return renderer->lastGpuSegments()[size_t(field - 19)];
        // PRD-650: the lamp maps apart from the sun's. 24 their GPU time (a part of field 7, beside 19), 25 the
        // lamp maps the last frame redrew, 26 their draws, and 27 every shadow draw, so 27 - 26 is the sun's.
        case 24: return renderer->lastGpuSegments()[kGpuLampShadowSegment];
        case 25: return double(renderer->lastFrame().lampRedraws);
        case 26: return double(renderer->lastFrame().lampShadowDraws);
        case 27: return double(renderer->lastFrame().shadowDraws);
        // 28 and 29: the smallest and largest edge of the lamp maps the footprint sized (0 without one).
        case 28: return double(renderer->lampShadowExtent()[0]);
        case 29: return double(renderer->lampShadowExtent()[1]);
        // 30 to 33: the temporal resolve's newest counted frame (one in 16): the pixels whose history it discarded, the
        // pixels whose history it pulled into the colour neighbourhood, the pixel count of that frame and its frame number.
        case 30: return double(renderer->temporalStatus().rejected);
        case 31: return double(renderer->temporalStatus().clamped);
        case 32: return double(renderer->temporalStatus().pixels);
        case 33: return double(renderer->temporalStatus().countedFrame);
        case 34: return renderer->temporalUpscale() ? 1 : 0;
        case 35: return renderer->inputWidth();
        case 36: return renderer->inputHeight();
        case 37: return renderer->traaDebugPass() ? renderer->traaDebugPass()->status().jitterLength : 0;
        case 38: return renderer->width();
        case 39: return renderer->height();
        // PRD-754, 60 to 65: the draws the main pass recorded into its bundle,
        // why its key moved (Renderer::RecordCause), the draws the aux and velocity passes recorded, the ms spent
        // recording bundles, and the ms spent encoding the shadow passes directly. Zero while every bundle holds.
        case 60: return double(renderer->lastFrame().mainRecorded);
        case 61: return double(renderer->lastFrame().recordCause);
        case 62: return double(renderer->lastFrame().auxRecorded);
        case 63: return renderer->lastFrame().recordMs;
        case 64: return renderer->lastFrame().shadowEncodeMs;
        case 65: return double(renderer->lastFrame().shadowRecorded);  // the shadow passes' draws recorded into bundles
        // 66 to 70: running CPU ms of the renderer's costly stages, every render summed (Renderer::CpuStage): the virtual
        // shadow pages and caster bounds, the draw plan, the shadow passes' draw lists, the whole prepare half, the encode half.
        case 66: case 67: case 68: case 69: case 70: return renderer->cpuStageMs(Renderer::CpuStage(field - 66));
        // 71 and 72: the startup's first real frame (ABI 8). 71 counts the ordinary world submissions that encoded since
        // the page started drawing: a bake step, a compile, an overlay, a declined frame or a failed one never advances it,
        // and core compares it with the generation it saw when it engaged the hold. 72 is 1 once the shadow inputs those
        // frames sample exist: every active virtual shadow has mapped its clip levels, and a scene with none, or with only
        // the ordinary maps a successful encode already drew, is ready. A shadow draw count is not this answer, and only a
        // held frame recomputes it.
        case 71: return double(worldSubmissions);
        case 72: return shadowInputsReady ? 1 : 0;
        // 40: the shadow maps the last frame kept because nothing they draw changed (sun or lamp, not virtual);
        // 41: the bytes of per-draw uniforms it uploaded.
        // 85 (PRD-770): the shadow passes' triangles, which field 1 adds in. With 27 (every shadow draw) it splits fields
        // 0 and 1 into the main pass and the shadow passes, as three counts a nested shadow render apart from the main one.
        case 85: return double(lastDrawn->lastFrame().shadowTriangles);
        case 40: return double(renderer->lastFrame().keptShadowMaps);
        case 41: return double(renderer->lastFrame().uniformBytes);
        // PRD-771, 73 to 77: running ms, every render summed, like 66 to 70. 73 the post effects' and output pass's share of
        // the encode half (inside 70); 74 the scene half of RenderDatabase::render (joints, scene walk, shadow sync);
        // 75 the whole main-view tnw_web_render, of which 76 is the queued kernels' flush and 77 the batched queue submit.
        case 73: return renderer->cpuStageMs(Renderer::CpuPost);
        case 74: return database.sceneMs();
        case 75: return hostRenderMs;
        case 76: return hostComputeMs;
        case 77: return hostSubmitMs;
        // 79 and 80: the tnw_web_poll that opens a render, and the render's tail (surface texture release, frame gate, diagnostics).
        case 79: return hostPollMs;
        case 80: return hostTailMs;
        case 81: return database.rendererMs();
        case 82: return hostDatabaseMs;
        case 83: return hostTargetMs;
        case 84: return Renderer::cpuMeters() ? 1 : 0;  // the stage meters on (the page lists the totals only while they run)
        // 78: the address of the array above, as a number; the page reads 18 doubles from it after each render.
        case 78: return double(reinterpret_cast<uintptr_t>(stageTotals));
        default: return 0;
    }
}
