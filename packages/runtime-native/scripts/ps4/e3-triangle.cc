// e3-triangle.cc — PRD-784 / E3: the smallest Dawn (WebGPU) guest that proves the
// PS4 port end to end, in two stages sharing one pipeline:
//
//   2a  no surface: instance -> adapter -> device -> render pipeline -> one frame
//       into an offscreen 256x256 texture.
//   2b  with a surface: wgpuInstanceCreateSurface over the PS4 patch (Surface.cpp
//       accepts the Xlib chain source as an opaque carrier; the Vulkan backend's
//       CreateVulkanSurface returns VK_NULL_HANDLE and vulkan-ps4's swapchain is
//       the VideoOut flip), configure, draw ~600 frames, present every one.
//
// The shader takes positions from vertex_index: no vertex buffers, no bind groups,
// so a black frame isolates the pipeline, not the vertex-input layout.
//
// Built and linked by e3-build.sh (E1/E2 guest recipe: OpenOrbis crt + libc/libkernel
// + libvulkan_ps4/libpsbc/libopengnm). Markers: TN_PS4_E3 adapter=..., limits ...,
// pipeline=ok, frame=<n> every 60, frames=600 presented.

#include <dawn/webgpu.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define TN_LOG(...)                     \
    do {                                \
        printf(__VA_ARGS__);            \
        printf("\n");                   \
        fflush(stdout);                 \
    } while (0)

// 2b geometry. 1920x1080 is what vulkan-ps4's VideoOut swapchain is set up for.
#define TN_SURFACE_W 1920u
#define TN_SURFACE_H 1080u
#define TN_FRAMES 600
#define TN_OFFSCREEN 256u

// 2a only: the offscreen render must be observable after the queue submits.
#define TN_READBACK (getenv("TN_E3_READBACK") != nullptr)

// Vertex positions from vertex_index, constant orange fragment -- in TWO modules, both with the
// entry point named main. vulkan-ps4 compiles only a shader module whose entry point is literally
// "main": vk_ps4_compile_shader_module sets PsbcCompileOptions::entrypoint = "main"
// (vulkan-ps4 src/vk_ps4_shader.c:166) and ignores VkPipelineShaderStageCreateInfo::pName, so a
// WebGPU pipeline with vs_main/fs_main fails in libpsbc with
// "Entry point not found for vertex shader \"main\"". WGSL forbids two entry points of one name in
// one module, but the pipeline descriptor takes the vertex and fragment modules separately, so one
// stage-named module each is enough. The same draw is used by the offscreen and surface passes.
// ponytail: this is the guest working around an ICD defect, not the fix for it -- the ICD must use
// pName (vulkan-ps4 lane, e2-build.sh), and then this can go back to one module with real names.
static const char kVertexShader[] =
    "@vertex\n"
    "fn main(@builtin(vertex_index) idx: u32) -> @builtin(position) vec4f {\n"
    "  var pos = array<vec2f, 3>(vec2f(0.0, 0.5), vec2f(-0.5, -0.5), vec2f(0.5, -0.5));\n"
    "  return vec4f(pos[idx], 0.0, 1.0);\n"
    "}\n";
static const char kFragmentShader[] =
    "@fragment\n"
    "fn main() -> @location(0) vec4f {\n"
    "  return vec4f(1.0, 0.55, 0.0, 1.0);\n"
    "}\n";

static int g_adapterDone = 0;
static int g_deviceDone = 0;
static WGPUAdapter g_adapter = nullptr;
static WGPUDevice g_device = nullptr;
static int g_errors = 0;

static void OnAdapter(WGPURequestAdapterStatus status,
                      WGPUAdapter adapter,
                      WGPUStringView message,
                      void* userdata1,
                      void* userdata2) {
    (void)userdata1;
    (void)userdata2;
    if (status != WGPURequestAdapterStatus_Success) {
        TN_LOG("TN_PS4_E3 adapter_failed status=%d msg=%s", (int)status,
               message.data ? message.data : "");
    }
    g_adapter = adapter;
    g_adapterDone = 1;
}

static void OnDevice(WGPURequestDeviceStatus status,
                     WGPUDevice device,
                     WGPUStringView message,
                     void* userdata1,
                     void* userdata2) {
    (void)userdata1;
    (void)userdata2;
    if (status != WGPURequestDeviceStatus_Success) {
        TN_LOG("TN_PS4_E3 device_failed status=%d msg=%s", (int)status,
               message.data ? message.data : "");
    }
    g_device = device;
    g_deviceDone = 1;
}

static void OnError(WGPUDevice const* device,
                    WGPUErrorType type,
                    WGPUStringView message,
                    void* userdata1,
                    void* userdata2) {
    (void)device;
    (void)userdata1;
    (void)userdata2;
    g_errors++;
    TN_LOG("TN_PS4_E3 error type=%d msg=%s", (int)type, message.data ? message.data : "");
}

// Both requests are driven by instance.ProcessEvents() (CallbackMode::AllowProcessEvents),
// so no Dawn thread has to call back into us and no std::future/pthread is needed.
static WGPUAdapter RequestAdapter(WGPUInstance instance) {
    WGPURequestAdapterOptions options = WGPU_REQUEST_ADAPTER_OPTIONS_INIT;
    options.backendType = WGPUBackendType_Vulkan;
    // Compatibility, not Core, and that is the honest level for this driver: vulkan-ps4 reports
    // maxFramebuffer{Width,Height} and maxViewportDimensions = 4096 (vk_ps4_instance.c), below
    // WebGPU core's 8192 minimum, so Dawn filters the adapter out of a Core request and the
    // callback lands on "No supported adapters". The limits this prints are then the ones the
    // ICD really reports; a Core adapter needs those four values raised in the ICD first.
    options.featureLevel = WGPUFeatureLevel_Compatibility;

    WGPURequestAdapterCallbackInfo callback = WGPU_REQUEST_ADAPTER_CALLBACK_INFO_INIT;
    callback.mode = WGPUCallbackMode_AllowProcessEvents;
    callback.callback = OnAdapter;
    wgpuInstanceRequestAdapter(instance, &options, callback);

    while (!g_adapterDone) {
        wgpuInstanceProcessEvents(instance);
    }
    return g_adapter;
}

static WGPUDevice RequestDevice(WGPUInstance instance, WGPUAdapter adapter) {
    WGPUDeviceDescriptor descriptor = WGPU_DEVICE_DESCRIPTOR_INIT;
    descriptor.uncapturedErrorCallbackInfo.callback = OnError;

    WGPURequestDeviceCallbackInfo callback = WGPU_REQUEST_DEVICE_CALLBACK_INFO_INIT;
    callback.mode = WGPUCallbackMode_AllowProcessEvents;
    callback.callback = OnDevice;
    wgpuAdapterRequestDevice(adapter, &descriptor, callback);

    while (!g_deviceDone) {
        wgpuInstanceProcessEvents(instance);
    }
    return g_device;
}

static void LogAdapterInfo(WGPUAdapter adapter) {
    WGPUAdapterInfo info = WGPU_ADAPTER_INFO_INIT;
    if (wgpuAdapterGetInfo(adapter, &info) != WGPUStatus_Success) {
        TN_LOG("TN_PS4_E3 adapter=<unknown> backend=0 info_failed");
        return;
    }
    // The name is whatever vulkan-ps4 reports; deviceID/vendorID pin it down otherwise.
    // backend is the raw WGPUBackendType value (6 = Vulkan) so a log line is not a claim.
    // A WGPUStringView is a (data,length) pair, not a C string: its bytes are not NUL-terminated
    // (printing %s ran into the next string of the adapter-info block), so the length is what is
    // printed, and it decides the end of the name.
    int nameLength = info.device.data ? (int)(info.device.length < 120 ? info.device.length : 120) : 0;
    TN_LOG("TN_PS4_E3 adapter=%.*s backend=%d vendor=0x%04x device=0x%04x", nameLength,
           info.device.data ? info.device.data : "(unnamed)", (int)info.backendType,
           info.vendorID, info.deviceID);

    WGPULimits limits = WGPU_LIMITS_INIT;
    if (wgpuAdapterGetLimits(adapter, &limits) != WGPUStatus_Success) {
        TN_LOG("TN_PS4_E3 limits=<unknown>");
        return;
    }
    TN_LOG("TN_PS4_E3 limits maxTextureDimension2D=%u maxBindGroups=%u "
           "maxStorageBuffersPerShaderStage=%u maxComputeWorkgroupSizeX=%u maxBufferSize=%llu",
           limits.maxTextureDimension2D, limits.maxBindGroups,
           limits.maxStorageBuffersPerShaderStage, limits.maxComputeWorkgroupSizeX,
           (unsigned long long)limits.maxBufferSize);
}

// Compile one WGSL source at run time (Dawn's WGSL reader -> Tint -> SPIR-V, then the ICD's
// libpsbc SPIR-V-to-GNM compiler at pipeline creation).
static WGPUShaderModule MakeModule(WGPUDevice device, const char* code) {
    WGPUShaderSourceWGSL wgsl = WGPU_SHADER_SOURCE_WGSL_INIT;
    wgsl.code = WGPU_STRING_VIEW_INIT;
    wgsl.code.data = code;
    wgsl.code.length = WGPU_STRLEN;

    WGPUShaderModuleDescriptor moduleDesc = WGPU_SHADER_MODULE_DESCRIPTOR_INIT;
    moduleDesc.nextInChain = &wgsl.chain;
    return wgpuDeviceCreateShaderModule(device, &moduleDesc);
}

static WGPURenderPipeline MakePipeline(WGPUDevice device, WGPUTextureFormat format) {
    WGPUShaderModule vertexModule = MakeModule(device, kVertexShader);
    WGPUShaderModule fragmentModule = MakeModule(device, kFragmentShader);

    WGPUColorTargetState target = WGPU_COLOR_TARGET_STATE_INIT;
    target.format = format;
    target.writeMask = WGPUColorWriteMask_All;

    WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
    fragment.module = fragmentModule;
    fragment.entryPoint = WGPU_STRING_VIEW_INIT;
    fragment.entryPoint.data = "main";
    fragment.targetCount = 1;
    fragment.targets = &target;

    WGPURenderPipelineDescriptor desc = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    desc.layout = nullptr;  // auto
    desc.vertex.module = vertexModule;
    desc.vertex.entryPoint = WGPU_STRING_VIEW_INIT;
    desc.vertex.entryPoint.data = "main";
    desc.vertex.bufferCount = 0;  // positions come from vertex_index
    desc.vertex.buffers = nullptr;
    desc.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    desc.multisample.count = 1;
    desc.fragment = &fragment;

    WGPURenderPipeline pipeline = wgpuDeviceCreateRenderPipeline(device, &desc);
    wgpuShaderModuleRelease(vertexModule);
    wgpuShaderModuleRelease(fragmentModule);
    return pipeline;
}

// One draw of the triangle into `view`, clearing to dark blue so an untouched target
// is visibly different from a rendered one.
static void DrawInto(WGPUDevice device, WGPURenderPipeline pipeline, WGPUTextureView view) {
    WGPURenderPassColorAttachment attachment = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
    attachment.view = view;
    attachment.loadOp = WGPULoadOp_Clear;
    attachment.storeOp = WGPUStoreOp_Store;
    attachment.clearValue = {0.0, 0.0, 0.25, 1.0};

    WGPURenderPassDescriptor passDesc = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
    passDesc.colorAttachmentCount = 1;
    passDesc.colorAttachments = &attachment;

    WGPUCommandEncoder encoder = wgpuDeviceCreateCommandEncoder(device, nullptr);
    WGPURenderPassEncoder pass = wgpuCommandEncoderBeginRenderPass(encoder, &passDesc);
    wgpuRenderPassEncoderSetPipeline(pass, pipeline);
    wgpuRenderPassEncoderDraw(pass, 3, 1, 0, 0);
    wgpuRenderPassEncoderEnd(pass);
    wgpuRenderPassEncoderRelease(pass);

    WGPUCommandBuffer commands = wgpuCommandEncoderFinish(encoder, nullptr);
    wgpuCommandEncoderRelease(encoder);
    wgpuQueueSubmit(wgpuDeviceGetQueue(device), 1, &commands);
    wgpuCommandBufferRelease(commands);
}

// === step 2a: offscreen 256x256 =====================================================
static WGPURenderPipeline RunOffscreen(WGPUInstance instance, WGPUDevice device) {
    // RGBA8Unorm, not the BGRA8Unorm a browser would pick: vulkan-ps4's VideoOut scanout has no
    // pixel format of its own (sceGnmVideoOutSubmitFlipAndWait takes none), so only an
    // R8G8B8A8_UNORM swapchain image reaches the screen with its channels in order. It is the
    // one format vkGetPhysicalDeviceSurfaceFormatsKHR advertises, and the pipeline below has to
    // match the surface texture it draws into anyway.
    const WGPUTextureFormat format = WGPUTextureFormat_RGBA8Unorm;

    WGPUTextureDescriptor texDesc = WGPU_TEXTURE_DESCRIPTOR_INIT;
    texDesc.usage = WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_CopySrc;
    texDesc.dimension = WGPUTextureDimension_2D;
    texDesc.size = {TN_OFFSCREEN, TN_OFFSCREEN, 1};
    texDesc.format = format;
    texDesc.mipLevelCount = 1;
    texDesc.sampleCount = 1;
    WGPUTexture texture = wgpuDeviceCreateTexture(device, &texDesc);
    WGPUTextureView view = wgpuTextureCreateView(texture, nullptr);

    WGPURenderPipeline pipeline = MakePipeline(device, format);
    if (pipeline == nullptr) {
        TN_LOG("TN_PS4_E3 pipeline=create_failed");
        return nullptr;
    }

    DrawInto(device, pipeline, view);
    wgpuDeviceTick(device);
    wgpuInstanceProcessEvents(instance);
    wgpuTextureViewRelease(view);
    wgpuTextureRelease(texture);

    TN_LOG("TN_PS4_E3 offscreen=%ux%u", TN_OFFSCREEN, TN_OFFSCREEN);
    return pipeline;
}

// === step 2b: 600 presented frames through the PS4 surface ==========================
static void RunSurface(WGPUInstance instance,
                       WGPUAdapter adapter,
                       WGPUDevice device,
                       WGPURenderPipeline pipeline) {
    // The PS4 patch (0003) makes Dawn treat this chain source as an opaque carrier:
    // vulkan-ps4 has no VK_KHR_surface and its swapchain is the VideoOut buffer, fixed at
    // TN_SURFACE_W x TN_SURFACE_H. Both fields stay null.
    WGPUSurfaceSourceXlibWindow source = WGPU_SURFACE_SOURCE_XLIB_WINDOW_INIT;
    WGPUSurfaceDescriptor surfaceDesc = WGPU_SURFACE_DESCRIPTOR_INIT;
    surfaceDesc.nextInChain = &source.chain;

    WGPUSurface surface = wgpuInstanceCreateSurface(instance, &surfaceDesc);
    if (surface == nullptr) {
        TN_LOG("TN_PS4_E3 surface=create_failed");
        return;
    }
    TN_LOG("TN_PS4_E3 surface=created");

    WGPUSurfaceConfiguration config = WGPU_SURFACE_CONFIGURATION_INIT;
    config.device = device;
    config.format = WGPUTextureFormat_RGBA8Unorm;
    config.usage = WGPUTextureUsage_RenderAttachment;
    config.width = TN_SURFACE_W;
    config.height = TN_SURFACE_H;
    config.alphaMode = WGPUCompositeAlphaMode_Auto;
    config.presentMode = WGPUPresentMode_Fifo;
    wgpuSurfaceConfigure(surface, &config);
    TN_LOG("TN_PS4_E3 surface=configured");

    for (int frame = 1; frame <= TN_FRAMES; ++frame) {
        WGPUSurfaceTexture surfaceTexture = WGPU_SURFACE_TEXTURE_INIT;
        wgpuSurfaceGetCurrentTexture(surface, &surfaceTexture);
        if (surfaceTexture.status != WGPUSurfaceGetCurrentTextureStatus_SuccessOptimal &&
            surfaceTexture.status != WGPUSurfaceGetCurrentTextureStatus_SuccessSuboptimal) {
            TN_LOG("TN_PS4_E3 frame=%d get_current_texture status=%d", frame,
                   (int)surfaceTexture.status);
            return;
        }

        if (frame == 1) {
            TN_LOG("TN_PS4_E3 surface=frame1");
        }
        WGPUTextureView view = wgpuTextureCreateView(surfaceTexture.texture, nullptr);
        DrawInto(device, pipeline, view);
        wgpuTextureViewRelease(view);
        wgpuTextureRelease(surfaceTexture.texture);

        if (wgpuSurfacePresent(surface) != WGPUStatus_Success) {
            TN_LOG("TN_PS4_E3 frame=%d present_failed", frame);
            return;
        }
        wgpuInstanceProcessEvents(instance);

        if (frame % 60 == 0) {
            TN_LOG("TN_PS4_E3 frame=%d", frame);
        }
    }
    TN_LOG("TN_PS4_E3 frames=%d presented", TN_FRAMES);
}

int main(void) {
    TN_LOG("=== Dawn PS4 (PRD-784 E3) ===");

    WGPUInstanceDescriptor instanceDesc = WGPU_INSTANCE_DESCRIPTOR_INIT;
    WGPUInstance instance = wgpuCreateInstance(&instanceDesc);
    if (instance == nullptr) {
        TN_LOG("TN_PS4_E3 instance=create_failed");
        return 1;
    }

    WGPUAdapter adapter = RequestAdapter(instance);
    if (adapter == nullptr) {
        TN_LOG("TN_PS4_E3 adapter=null");
        return 1;
    }
    LogAdapterInfo(adapter);

    WGPUDevice device = RequestDevice(instance, adapter);
    if (device == nullptr) {
        TN_LOG("TN_PS4_E3 device=null");
        return 1;
    }

    WGPURenderPipeline pipeline = RunOffscreen(instance, device);
    if (pipeline != nullptr) {
        TN_LOG("TN_PS4_E3 pipeline=ok");
        if (TN_READBACK) wgpuDeviceTick(device);
        RunSurface(instance, adapter, device, pipeline);
    }

    TN_LOG("TN_PS4_E3 errors=%d", g_errors);
    wgpuRenderPipelineRelease(pipeline);
    wgpuDeviceRelease(device);
    wgpuAdapterRelease(adapter);
    wgpuInstanceRelease(instance);
    TN_LOG("TN_PS4_E3 done");
    return g_errors == 0 ? 0 : 2;
}

// === libc++/PS4 link shims =========================================================
// Dawn links two symbols that the OpenOrbis libc++ 11 headers declare but its prebuilt
// archives do not define. Both are supplied here, by the embedder, because they are
// process-wide: nothing in Dawn may implement them twice.

#  include <stdlib.h>
#  include <time.h>

namespace std {
inline namespace __1 {

// <atomic> declares __libcpp_atomic_wait(void const volatile*, __cxx_contention_t) with a
// long contention type, but libc++.a only ships the int overloads, so
// std::atomic::wait (used by Dawn's Buffer.cpp) would not link.
// ponytail: 0.5 ms polling wait — correct (a notifier's store is always observed) and
// single-guest-friendly; swap for a futex/semaphore if waiting ever shows up in a profile.
__attribute__((visibility("default"))) void __libcpp_atomic_wait(void const volatile* address,
                                                                long old) {
    while (__atomic_load_n(reinterpret_cast<long const volatile*>(address), __ATOMIC_ACQUIRE) ==
           old) {
        struct timespec pause = {0, 500000};
        nanosleep(&pause, nullptr);
    }
}

}  // namespace __1
}  // namespace std

// libc++.a has __cxa_thread_atexit but not the _impl form libc++abi/absl register C++11
// thread_local destructors through.
// ponytail: one fixed table, run at process exit (the guest is single-threaded and
// short-lived); replace with per-thread lists if the guest grows threads.
extern "C" {

using TnThreadDtor = void (*)(void*);

static TnThreadDtor g_tnDtors[64];
static void* g_tnDtorArgs[64];
static int g_tnDtorCount = 0;

static void TnRunThreadDtors() {
    while (g_tnDtorCount > 0) {
        --g_tnDtorCount;
        g_tnDtors[g_tnDtorCount](g_tnDtorArgs[g_tnDtorCount]);
    }
}

int __cxa_thread_atexit_impl(TnThreadDtor dtor, void* object, void* dsoHandle) {
    (void)dsoHandle;
    if (g_tnDtorCount == 64) {
        return -1;
    }
    static bool registered = false;
    if (!registered) {
        registered = true;
        atexit(TnRunThreadDtors);
    }
    g_tnDtors[g_tnDtorCount] = dtor;
    g_tnDtorArgs[g_tnDtorCount] = object;
    ++g_tnDtorCount;
    return 0;
}

}  // extern "C"
