// PRD-540: the product browser host. `WebGPURenderer` on the Wasm engine
// (packages/three-native/src/browser-renderer.ts) drives it: init on the game's canvas, resize, and
// one presented frame per render() call. Rendering is the same RenderDatabase and Renderer as
// desktop; this file owns only device bring-up and the canvas surface. The test host
// (tests/native-engine/wasm/browser.cpp) keeps its fixed-canvas bench and package proofs.
#include "engine/abi/abi_internal.h"
#include "engine/renderer/render_database.h"
#include "engine/abi/binding.h"
#include "engine/renderer/render_target_pass.h"
#include "engine/shader/graph/graph.h"

#include <cstdio>
#include <cstring>
#include <map>
#include <set>
#if TN_WEB_GLTF
#include "engine/assets/gltf/loader.h"
#endif

#include <emscripten/emscripten.h>

#include <memory>
#include <optional>
#include <string>

using namespace tn::engine;

namespace {
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
tn::engine::shader::graph::Node pendingPost;  // a RenderPipeline set before the device was ready
// three's renderer settings the game last set (WebGPURenderer's defaults until it does), applied
// before the next frame, as the V8 player's setRendererState does.
OutputState output{std::nullopt, 1, true};
bool outputChanged = true;
bool shadowMap = false;
int shadowMapType = 1;  // PCFShadowMap

std::string text(WGPUStringView value) {
    if (value.data == nullptr) return {};
    return value.length == WGPU_STRLEN ? std::string(value.data) : std::string(value.data, value.length);
}

int fail(const std::string& message) {
    if (state != Failed) failure = message;
    state = Failed;
    return 1;
}

void configureSurface() {
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
    renderer = std::make_unique<Renderer>(instance, device, queue, events);
    configureSurface();
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
    WGPUDeviceDescriptor desc = {};
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

/** Starts adapter and device requests on the canvas `selector` names; poll until Ready or Failed. */
extern "C" int tnw_web_init(const char* selector, uint32_t w, uint32_t h) {
    if (started) return fail("TN_WASM_INIT: already initialized");
    started = true;
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
    if (renderer) configureSurface();
    return 0;
}

/** Draws `scene` from `camera` into the canvas; the browser presents it at its animation boundary. */
extern "C" int tnw_web_render(const tn_handle_t* sceneHandle, const tn_handle_t* cameraHandle, double r, double g,
                              double b, double a) {
    tnw_web_poll();
    if (state != Ready) return fail(state == Pending ? "TN_WASM_RENDER: device not ready" : failure);
    auto* scene = rootOf(sceneHandle);
    auto* camera = cameraOf(cameraHandle);
    if (scene == nullptr || camera == nullptr) return fail("TN_WASM_RENDER: scene or camera handle invalid");
    WGPUSurfaceTexture frame = {};
    wgpuSurfaceGetCurrentTexture(surface, &frame);
    if (frame.texture == nullptr) return fail("TN_WASM_SURFACE: no canvas texture");
    WGPUTextureView view = wgpuTextureCreateView(frame.texture, nullptr);
    if (outputChanged) renderer->setOutput(output);
    outputChanged = false;
    database.shadowMapEnabled = shadowMap;
    database.shadowMapType = shadowMapType;
    // A refusal the renderer throws (an unported feature, a refused binding) is this frame's named
    // failure, never a bare WebAssembly.Exception in the page.
    std::string refused;
    try {
        Renderer::PresentScope present(*renderer, view, surfaceFormat);
        database.render(*renderer, *scene, *camera, {r, g, b, a});
    } catch (const std::exception& error) {
        refused = error.what();
    }
    wgpuTextureViewRelease(view);
    wgpuTextureRelease(frame.texture);
    // A refused program or skipped draw, as the V8 player prints it: once each, as a console error,
    // so a page that draws less than its scene says why.
    static std::set<std::string> reported;
    for (const std::string& diagnostic : renderer->diagnostics())
        if (reported.insert(diagnostic).second) std::fprintf(stderr, "TN_RENDERER: %s\n", diagnostic.c_str());
    if (!refused.empty()) return fail(refused);
    if (!database.diagnostics().empty()) return fail(database.diagnostics().front());
    return 0;
}

/**
 * three's render() while a render target is set (PRD-551): draws `root` through `camera` into the
 * target, the linear scene colour, as r185 writes a target. Fails, naming the first refusal, when the
 * target's render refused or skipped anything.
 */
extern "C" int tnw_web_render_target(const tn_handle_t* targetHandle, const tn_handle_t* rootHandle,
                                     const tn_handle_t* cameraHandle, double r, double g, double b, double a) {
    tnw_web_poll();
    if (state != Ready) return fail(state == Pending ? "TN_WASM_RENDER: device not ready" : failure);
    auto* target = objectAs<RenderTarget>(targetHandle, "RenderTarget");
    auto* root = rootOf(rootHandle);
    auto* camera = cameraOf(cameraHandle);
    if (target == nullptr || root == nullptr || camera == nullptr)
        return fail("TN_WASM_RENDER_TARGET: target, root or camera handle invalid");
    const auto refused = renderToTarget(*renderer, *target, *root, *camera, {r, g, b, a}, shadowMap);
    if (!refused.empty()) return fail(refused.front());
    return 0;
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
 * three's `toneMapping`, `toneMappingExposure`, `outputColorSpace` and `shadowMap.{enabled,type}`,
 * applied before the next frame. A value the engine does not implement is refused by name; a refusal
 * leaves the renderer running.
 */
extern "C" int tnw_web_renderer_state(double toneMapping, double exposure, const char* colorSpace, int shadowEnabled,
                                      double shadowType) {
    std::string refusal;
    const auto next = outputStateOf(toneMapping, exposure, colorSpace, refusal);
    // PCFShadowMap and PCFSoftShadowMap are the filters the engine draws (PCFShadowFilter, PCFSoftShadowFilter).
    if (next && shadowType != 1 && shadowType != 2) refusal = "shadowMap.type must be PCFShadowMap or PCFSoftShadowMap";
    if (!refusal.empty()) {
        if (state != Failed) failure = "TN_NATIVE_RENDERER_STATE: " + refusal;
        return 1;
    }
    if (next->toneMapping != output.toneMapping || next->toneMappingExposure != output.toneMappingExposure ||
        next->srgb != output.srgb) {
        output = *next;
        outputChanged = true;
    }
    shadowMap = shadowEnabled != 0;
    shadowMapType = static_cast<int>(shadowType);
    return 0;
}

/**
 * three's RenderPipeline: the TSL graph between the scene and the output, by its tn_tsl_* id in
 * `context`, or none (null). The same graph again is a no-op, as RenderPipeline.render() hands it
 * every frame (PRD-540; the V8 player's setPostGraph).
 */
extern "C" int tnw_web_set_post(tn_context_t* context, const uint64_t* node) {
    static shader::graph::Node current;
    shader::graph::Node graph;
    if (node != nullptr) {
        graph = tn::abi::tslNode(context, *node);
        if (!graph) return fail("TN_WASM_POST: not a TSL node of this context");
    }
    if (graph == current) return 0;
    current = graph;
    if (state == Ready && renderer) renderer->setPostGraph(graph);
    else pendingPost = graph;
    return 0;
}

namespace {
std::string loadFailure;  // why the last tnw_web_load_gltf refused; never fails the host itself
}

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
    auto loaded = gltf::load(std::span<const uint8_t>(bytes, size));
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
 * text-key lookups (3), bind groups created (4), graph keys serialized (5) and programs built (6).
 */
extern "C" double tnw_web_frame(int field) {
    if (!renderer) return 0;
    switch (field) {
        case 0: return double(renderer->lastFrame().draws);
        case 1: return double(renderer->lastFrame().triangles);
        case 2: return double(renderer->pipelines().compiles());
        case 3: return double(renderer->pipelines().textLookups());
        case 4: return double(bindGroupsCreated());
        case 5: return double(shader::graph::keyBuilds());
        case 6: return double(renderer->programCount());
        default: return 0;
    }
}
