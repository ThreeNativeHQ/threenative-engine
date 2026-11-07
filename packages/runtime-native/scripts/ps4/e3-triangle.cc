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

extern "C" int sceKernelUsleep(unsigned int microseconds);

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

// TN_E3_GUEST_CS=1 (TN_PS4_E3_GUEST=e3cs in run-experiment.mjs) turns this guest into the compute
// repro: the same device and the same triangle, but the draw's colour comes from a buffer a compute
// pipeline wrote. One compute pipeline (workgroup 8x1x1), a bind group of two storage buffers and
// one uniform -- the shape of the engine kernel that loses the host device in E5 -- dispatched
// 512x1x1 groups = 4096 threads, then the triangle's fragment reads storage buffer 0. The frame
// the guest PRESENTS is the verdict, because a guest readback is stale under shadPS4.
#ifndef TN_E3_GUEST_CS
#define TN_E3_GUEST_CS 0
#endif

// TN_E3_GUEST_TEX=1 (TN_PS4_E3_GUEST=e3tex in run-experiment.mjs) turns this guest into the
// texture repro, the one path E3 and E3CS never touch: pass A renders the same triangle into an
// offscreen colour target, pass B is a fullscreen triangle that SAMPLES that target into the
// swapchain. A T# image descriptor, an S# sampler and the render-target -> sampled-image
// hand-off are what a black E5 frame is made of, and none of the other guests exercise them.
// TN_E3_TEX_RGBA8=1 renders the scene target as R8G8B8A8_UNORM instead of the float16 format
// E5's scene pass uses (a float16 encode error and a broken hand-off look the same on screen).
// TN_E3_TEX_MSAA=1 makes the scene target 4x multisampled with a resolve target pass B samples,
// because the engine's scene pass may be multisampled too.
#ifndef TN_E3_GUEST_TEX
#define TN_E3_GUEST_TEX 0
#endif
#ifndef TN_E3_TEX_RGBA8
#define TN_E3_TEX_RGBA8 0
#endif
#ifndef TN_E3_TEX_MSAA
#define TN_E3_TEX_MSAA 0
#endif

// Every marker carries which build printed it, so a log says which guest it came from and the
// harness's two verdicts never read each other's lines.
#if TN_E3_GUEST_TEX
#define TN_E3_TAG "TN_PS4_E3TEX"
#elif TN_E3_GUEST_CS
#define TN_E3_TAG "TN_PS4_E3CS"
#else
#define TN_E3_TAG "TN_PS4_E3"
#endif

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
#if TN_E3_GUEST_CS
// 4096 u32 elements = 512 groups of 8 threads, exactly the dispatch E5's kernel makes. Params ride
// in a uniform (vec4u, so the uniform block layout is legal as it stands): x = the value element 0
// gets, y = the stride each thread adds.
static const char kComputeShader[] =
    "@group(0) @binding(0) var<storage, read_write> outv: array<u32>;\n"
    "@group(0) @binding(1) var<storage, read_write> scratch: array<u32>;\n"
    "@group(0) @binding(2) var<uniform> params: vec4u;\n"
    "@compute @workgroup_size(8, 1, 1)\n"
    "fn main(@builtin(global_invocation_id) gid: vec3u) {\n"
    "  let v = params.x + gid.x * params.y;\n"
    "  outv[gid.x] = v;\n"
    "  scratch[gid.x] = v + 1u;\n"
    "}\n";
// The drawn colour IS the compute result: 0.251, 0.255, 0 for the params the guest writes, and
// black-ish if the dispatch wrote nothing. A blank or wrong-coloured triangle is the red.
static const char kFragmentShader[] =
    "@group(0) @binding(0) var<storage, read> outv: array<u32>;\n"
    "@fragment\n"
    "fn main() -> @location(0) vec4f {\n"
    "  return vec4f(f32(outv[0] & 255u) / 255.0, f32(outv[1] & 255u) / 255.0, 0.0, 1.0);\n"
    "}\n";
#else
static const char kFragmentShader[] =
    "@fragment\n"
    "fn main() -> @location(0) vec4f {\n"
    "  return vec4f(1.0, 0.55, 0.0, 1.0);\n"
    "}\n";
#endif

#if TN_E3_GUEST_TEX
// Pass B. The uv comes from the clip position the vertex stage computes, so the fullscreen
// triangle needs no vertex buffer: the left half of the frame samples through a linear sampler and
// the right half loads texels with textureLoad, which is one presented frame that separates the
// two GNM texture paths.
static const char kFullscreenVertexShader[] =
    "struct Varyings {\n"
    "  @builtin(position) pos: vec4f,\n"
    "  @location(0) uv: vec2f,\n"
    "};\n"
    "@vertex\n"
    "fn main(@builtin(vertex_index) idx: u32) -> Varyings {\n"
    // A quad as one triangle strip: idx 0..3 -> (0,0) (1,0) (0,1) (1,1) in [0,1]^2. Derived from
    // vertex_index ARITHMETICALLY, never from an indexed `array<vec2f, 3>`: an indexed array makes
    // ACO place its elements in a constant pool at the END of the shader code, and shadPS4's GCN
    // decoder has no upper bound (GcnCodeSlice::atEnd() is a pointer equality, frontend/decode.h:47
    // with recompiler.cpp:77 at v.0.21.0), so a tail word that decodes as a literal-taking
    // instruction (0x40400000 = 3.0f decodes as V_MADAK_F32) walks off the end of the span and
    // aborts on an illegal encoding -- the bininfo's own hash word. Without a pool the last words
    // are the S_ENDPGM terminators and the walk lands exactly on the span end.
    "  let f = vec2f(f32(idx & 1u), f32(idx >> 1u));\n"
    "  var out: Varyings;\n"
    "  out.pos = vec4f(f * 2.0 - 1.0, 0.0, 1.0);\n"
    "  out.uv = vec2f(f.x, 1.0 - f.y);\n"
    "  return out;\n"
    "}\n";
static const char kSampleFragmentShader[] =
    "struct Varyings {\n"
    "  @builtin(position) pos: vec4f,\n"
    "  @location(0) uv: vec2f,\n"
    "};\n"
    "@group(0) @binding(0) var scene: texture_2d<f32>;\n"
    "@group(0) @binding(1) var sceneSampler: sampler;\n"
    "@fragment\n"
    "fn main(in: Varyings) -> @location(0) vec4f {\n"
    // Both paths are evaluated unconditionally and one selected: Tint rejects textureSample inside
    // non-uniform control flow ("must only be called from uniform control flow"), and a branch on
    // the fragment position is exactly that.
    "  let sampled = textureSample(scene, sceneSampler, in.uv);\n"
    "  let dims = textureDimensions(scene);\n"
    "  let xy = min(vec2u(clamp(in.uv, vec2f(0.0), vec2f(1.0)) * vec2f(f32(dims.x), f32(dims.y))),\n"
    "               dims - vec2u(1u));\n"
    "  let loaded = textureLoad(scene, vec2i(xy), 0);\n"
    "  return select(loaded, sampled, in.pos.x < 960.0);\n"
    "}\n";

static WGPUBindGroup g_sampleGroup = nullptr;  // pass B's scene-target view + sampler
#endif

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
        TN_LOG(TN_E3_TAG " adapter_failed status=%d msg=%s", (int)status,
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
        TN_LOG(TN_E3_TAG " device_failed status=%d msg=%s", (int)status,
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
    TN_LOG(TN_E3_TAG " error type=%d msg=%s", (int)type, message.data ? message.data : "");
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
        TN_LOG(TN_E3_TAG " adapter=<unknown> backend=0 info_failed");
        return;
    }
    // The name is whatever vulkan-ps4 reports; deviceID/vendorID pin it down otherwise.
    // backend is the raw WGPUBackendType value (6 = Vulkan) so a log line is not a claim.
    // A WGPUStringView is a (data,length) pair, not a C string: its bytes are not NUL-terminated
    // (printing %s ran into the next string of the adapter-info block), so the length is what is
    // printed, and it decides the end of the name.
    int nameLength = info.device.data ? (int)(info.device.length < 120 ? info.device.length : 120) : 0;
    TN_LOG(TN_E3_TAG " adapter=%.*s backend=%d vendor=0x%04x device=0x%04x", nameLength,
           info.device.data ? info.device.data : "(unnamed)", (int)info.backendType,
           info.vendorID, info.deviceID);

    WGPULimits limits = WGPU_LIMITS_INIT;
    if (wgpuAdapterGetLimits(adapter, &limits) != WGPUStatus_Success) {
        TN_LOG(TN_E3_TAG " limits=<unknown>");
        return;
    }
    TN_LOG(TN_E3_TAG " limits maxTextureDimension2D=%u maxBindGroups=%u "
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

#if TN_E3_GUEST_CS
// The fragment reads the compute result, so the draw needs a bind group of its own: a compute
// layout (COMPUTE visibility, writable storage) is not a legal render-pipeline layout, and a
// fragment stage may only be handed read-only storage.
static WGPUBindGroup g_fragmentGroup = nullptr;
static WGPUBuffer g_storage[2];  // 0 = what the fragment reads, 1 = the kernel's second buffer

static WGPUBindGroupLayout MakeFragmentLayout(WGPUDevice device) {
    WGPUBindGroupLayoutEntry entry = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
    entry.binding = 0;
    entry.visibility = WGPUShaderStage_Fragment;
    entry.buffer.type = WGPUBufferBindingType_ReadOnlyStorage;

    WGPUBindGroupLayoutDescriptor desc = WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
    desc.entryCount = 1;
    desc.entries = &entry;
    return wgpuDeviceCreateBindGroupLayout(device, &desc);
}
#endif

static WGPURenderPipeline MakePipeline(WGPUDevice device, WGPUTextureFormat format, uint32_t samples) {
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
    WGPUPipelineLayout pipelineLayout = nullptr;
#if TN_E3_GUEST_CS
    WGPUBindGroupLayout fragmentLayout = MakeFragmentLayout(device);
    WGPUPipelineLayoutDescriptor layoutDesc = WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;
    layoutDesc.bindGroupLayoutCount = 1;
    layoutDesc.bindGroupLayouts = &fragmentLayout;
    pipelineLayout = wgpuDeviceCreatePipelineLayout(device, &layoutDesc);
    desc.layout = pipelineLayout;
#else
    desc.layout = nullptr;  // auto
#endif
    desc.vertex.module = vertexModule;
    desc.vertex.entryPoint = WGPU_STRING_VIEW_INIT;
    desc.vertex.entryPoint.data = "main";
    desc.vertex.bufferCount = 0;  // positions come from vertex_index
    desc.vertex.buffers = nullptr;
    desc.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    desc.multisample.count = samples;
    desc.fragment = &fragment;

    WGPURenderPipeline pipeline = wgpuDeviceCreateRenderPipeline(device, &desc);
    wgpuShaderModuleRelease(vertexModule);
    wgpuShaderModuleRelease(fragmentModule);
#if TN_E3_GUEST_CS
    WGPUBindGroupEntry groupEntry = WGPU_BIND_GROUP_ENTRY_INIT;
    groupEntry.binding = 0;
    groupEntry.buffer = g_storage[0];
    groupEntry.offset = 0;
    groupEntry.size = WGPU_WHOLE_SIZE;
    WGPUBindGroupDescriptor groupDesc = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    groupDesc.layout = fragmentLayout;
    groupDesc.entryCount = 1;
    groupDesc.entries = &groupEntry;
    g_fragmentGroup = wgpuDeviceCreateBindGroup(device, &groupDesc);
    wgpuPipelineLayoutRelease(pipelineLayout);
    wgpuBindGroupLayoutRelease(fragmentLayout);
#endif
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
#if TN_E3_GUEST_CS
    // Frame 1 draws straight after the compute submit, so a stale read here is the missing
    // read-to-write barrier, not a compute failure: the frame colour tells the two apart.
    if (g_fragmentGroup != nullptr) wgpuRenderPassEncoderSetBindGroup(pass, 0, g_fragmentGroup, 0, nullptr);
#endif
#if TN_E3_GUEST_TEX
    // This pipeline IS pass B: the fullscreen quad that reads the scene target, 4 strip vertices.
    if (g_sampleGroup != nullptr) wgpuRenderPassEncoderSetBindGroup(pass, 0, g_sampleGroup, 0, nullptr);
#endif
    wgpuRenderPassEncoderDraw(pass, TN_E3_GUEST_TEX ? 4 : 3, 1, 0, 0);
    wgpuRenderPassEncoderEnd(pass);
    wgpuRenderPassEncoderRelease(pass);

    WGPUCommandBuffer commands = wgpuCommandEncoderFinish(encoder, nullptr);
    wgpuCommandEncoderRelease(encoder);
    wgpuQueueSubmit(wgpuDeviceGetQueue(device), 1, &commands);
    wgpuCommandBufferRelease(commands);
}

// === the compute repro: dispatch, then present what it wrote ==========================
#if TN_E3_GUEST_CS
// One dispatch of 512 groups x 8 threads over two 4096-element storage buffers and one uniform --
// the bind-group shape of the engine kernel that loses the host device in E5. Every step logs a
// marker, so a lost device is attributed to the step that was running.
static void RunCompute(WGPUInstance instance, WGPUDevice device) {
    const uint64_t kBytes = 4096u * 4u;
    // Storage buffers are not uniform buffers: WebGPU refuses one buffer with both usages, and
    // Dawn says so ("usage (Uniform|Storage(read-write)) includes writable usage and another
    // usage"), which invalidated the whole command buffer on the first try.
    WGPUBufferDescriptor bufferDesc = WGPU_BUFFER_DESCRIPTOR_INIT;
    bufferDesc.usage = WGPUBufferUsage_Storage | WGPUBufferUsage_CopyDst;
    bufferDesc.size = kBytes;
    for (int i = 0; i < 2; ++i) g_storage[i] = wgpuDeviceCreateBuffer(device, &bufferDesc);
    WGPUBufferDescriptor uniformDesc = WGPU_BUFFER_DESCRIPTOR_INIT;
    uniformDesc.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
    uniformDesc.size = 16;
    WGPUBuffer uniformBuffer = wgpuDeviceCreateBuffer(device, &uniformDesc);

    WGPUShaderModule csModule = MakeModule(device, kComputeShader);
    WGPUComputePipelineDescriptor pipelineDesc = WGPU_COMPUTE_PIPELINE_DESCRIPTOR_INIT;
    pipelineDesc.layout = nullptr;  // auto
    pipelineDesc.compute.module = csModule;
    pipelineDesc.compute.entryPoint = WGPU_STRING_VIEW_INIT;
    pipelineDesc.compute.entryPoint.data = "main";
    WGPUComputePipeline computePipeline = wgpuDeviceCreateComputePipeline(device, &pipelineDesc);
    wgpuShaderModuleRelease(csModule);
    if (computePipeline == nullptr) {
        TN_LOG("TN_PS4_E3CS cs_pipeline=create_failed");
        return;
    }
    WGPUBindGroupLayout layout = wgpuComputePipelineGetBindGroupLayout(computePipeline, 0);

    // x = the value element 0 gets, y = the per-thread stride: 64 + i * 1 -> outv[0] = 64,
    // outv[1] = 65, so the fragment's red/green are 0.251 and 0.255 and ANY other colour on screen
    // is a dispatch that did not reach the buffer.
    const uint32_t params[4] = {64u, 1u, 0u, 0u};
    WGPUQueue queue = wgpuDeviceGetQueue(device);
    wgpuQueueWriteBuffer(queue, uniformBuffer, 0, params, sizeof(params));

    WGPUBindGroupEntry entries[3] = {WGPU_BIND_GROUP_ENTRY_INIT, WGPU_BIND_GROUP_ENTRY_INIT,
                                     WGPU_BIND_GROUP_ENTRY_INIT};
    for (int i = 0; i < 2; ++i) {
        entries[i].binding = (uint32_t)i;
        entries[i].buffer = g_storage[i];
        entries[i].offset = 0;
        entries[i].size = WGPU_WHOLE_SIZE;
    }
    entries[2].binding = 2;
    entries[2].buffer = uniformBuffer;
    entries[2].offset = 0;
    entries[2].size = 16;
    WGPUBindGroupDescriptor groupDesc = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    groupDesc.layout = layout;
    groupDesc.entryCount = 3;
    groupDesc.entries = entries;
    WGPUBindGroup group = wgpuDeviceCreateBindGroup(device, &groupDesc);
    TN_LOG("TN_PS4_E3CS cs=bound set=%s buffers=2 uniform=1", group ? "ok" : "null");

    WGPUCommandEncoder encoder = wgpuDeviceCreateCommandEncoder(device, nullptr);
    WGPUComputePassEncoder pass = wgpuCommandEncoderBeginComputePass(encoder, nullptr);
    wgpuComputePassEncoderSetPipeline(pass, computePipeline);
    wgpuComputePassEncoderSetBindGroup(pass, 0, group, 0, nullptr);
    wgpuComputePassEncoderDispatchWorkgroups(pass, 512, 1, 1);
    wgpuComputePassEncoderEnd(pass);
    wgpuComputePassEncoderRelease(pass);
    WGPUCommandBuffer commands = wgpuCommandEncoderFinish(encoder, nullptr);
    wgpuCommandEncoderRelease(encoder);
    wgpuQueueSubmit(queue, 1, &commands);
    wgpuCommandBufferRelease(commands);
    TN_LOG("TN_PS4_E3CS cs=submitted groups=512 threads=8");
    wgpuDeviceTick(device);
    wgpuInstanceProcessEvents(instance);
    TN_LOG("TN_PS4_E3CS cs=done");
    wgpuBindGroupRelease(group);
    wgpuBufferRelease(uniformBuffer);
    wgpuComputePipelineRelease(computePipeline);
}
#endif

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

    WGPURenderPipeline pipeline = MakePipeline(device, format, 1);
    if (pipeline == nullptr) {
        TN_LOG(TN_E3_TAG " pipeline=create_failed");
        return nullptr;
    }

    DrawInto(device, pipeline, view);
    wgpuDeviceTick(device);
    wgpuInstanceProcessEvents(instance);
    wgpuTextureViewRelease(view);
    wgpuTextureRelease(texture);

    TN_LOG(TN_E3_TAG " offscreen=%ux%u", TN_OFFSCREEN, TN_OFFSCREEN);
    return pipeline;
}

// === the texture repro: two passes, one sampled render target ========================
#if TN_E3_GUEST_TEX
// Pass A renders the plain triangle into an offscreen colour target; pass B is a fullscreen
// triangle that samples it into whatever it is handed (the swapchain, every frame). Both stages the
// engine's own frame needs and neither E3 nor E3CS runs: a render target that a LATER pass reads.
static WGPURenderPipeline RunTexturePass(WGPUInstance instance, WGPUDevice device) {
    // The scene target keeps the format E5's scene pass uses (GNM fmt 97, a float16 colour target);
    // TN_E3_TEX_RGBA8 swaps in the UNORM format the swapchain already takes.
    const WGPUTextureFormat sceneFormat =
        TN_E3_TEX_RGBA8 ? WGPUTextureFormat_RGBA8Unorm : WGPUTextureFormat_RGBA16Float;
    const uint32_t samples = TN_E3_TEX_MSAA ? 4u : 1u;

    // What pass B samples. Multisampled colour cannot be sampled directly in GNM, so the MSAA arm
    // resolves into this one and pass B reads the resolve, as the engine's scene pass does.
    WGPUTextureDescriptor resolvedDesc = WGPU_TEXTURE_DESCRIPTOR_INIT;
    resolvedDesc.usage = WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_TextureBinding;
    resolvedDesc.dimension = WGPUTextureDimension_2D;
    resolvedDesc.size = {TN_OFFSCREEN, TN_OFFSCREEN, 1};
    resolvedDesc.format = sceneFormat;
    resolvedDesc.mipLevelCount = 1;
    resolvedDesc.sampleCount = 1;
    WGPUTexture resolved = wgpuDeviceCreateTexture(device, &resolvedDesc);
    WGPUTextureView resolvedView = wgpuTextureCreateView(resolved, nullptr);

    WGPUTextureView drawView = resolvedView;
    WGPUTexture msaa = nullptr;
    if (samples > 1) {
        WGPUTextureDescriptor msaaDesc = resolvedDesc;
        msaaDesc.usage = WGPUTextureUsage_RenderAttachment;
        msaaDesc.sampleCount = samples;
        msaa = wgpuDeviceCreateTexture(device, &msaaDesc);
        drawView = wgpuTextureCreateView(msaa, nullptr);
    }

    WGPURenderPipeline scenePipeline = MakePipeline(device, sceneFormat, samples);
    if (scenePipeline == nullptr) {
        TN_LOG(TN_E3_TAG " pipeline=create_failed");
        return nullptr;
    }

    // Pass A: the same triangle, the same clear as DrawInto, into the scene target (and, when the
    // target is multisampled, resolved into the texture pass B reads).
    WGPURenderPassColorAttachment attachment = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
    attachment.view = drawView;
    attachment.resolveTarget = samples > 1 ? resolvedView : nullptr;
    attachment.loadOp = WGPULoadOp_Clear;
    attachment.storeOp = samples > 1 ? WGPUStoreOp_Discard : WGPUStoreOp_Store;
    attachment.clearValue = {0.0, 0.0, 0.25, 1.0};

    WGPURenderPassDescriptor passDesc = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
    passDesc.colorAttachmentCount = 1;
    passDesc.colorAttachments = &attachment;

    WGPUCommandEncoder encoder = wgpuDeviceCreateCommandEncoder(device, nullptr);
    WGPURenderPassEncoder pass = wgpuCommandEncoderBeginRenderPass(encoder, &passDesc);
    wgpuRenderPassEncoderSetPipeline(pass, scenePipeline);
    wgpuRenderPassEncoderDraw(pass, 3, 1, 0, 0);
    wgpuRenderPassEncoderEnd(pass);
    wgpuRenderPassEncoderRelease(pass);
    WGPUCommandBuffer commands = wgpuCommandEncoderFinish(encoder, nullptr);
    wgpuCommandEncoderRelease(encoder);
    wgpuQueueSubmit(wgpuDeviceGetQueue(device), 1, &commands);
    wgpuCommandBufferRelease(commands);
    wgpuDeviceTick(device);
    wgpuInstanceProcessEvents(instance);
    wgpuRenderPipelineRelease(scenePipeline);
    if (msaa != nullptr) {
        // The resolve has completed, so the multisampled image is no longer needed: only the
        // resolved texture is sampled from here on.
        wgpuTextureViewRelease(drawView);
        wgpuTextureRelease(msaa);
    }

    // Pass B: fullscreen triangle over a linear sampler and the scene target's view.
    WGPUSamplerDescriptor samplerDesc = WGPU_SAMPLER_DESCRIPTOR_INIT;
    samplerDesc.magFilter = WGPUFilterMode_Linear;
    samplerDesc.minFilter = WGPUFilterMode_Linear;
    samplerDesc.mipmapFilter = WGPUMipmapFilterMode_Nearest;
    samplerDesc.addressModeU = WGPUAddressMode_ClampToEdge;
    samplerDesc.addressModeV = WGPUAddressMode_ClampToEdge;
    samplerDesc.addressModeW = WGPUAddressMode_ClampToEdge;
    WGPUSampler sampler = wgpuDeviceCreateSampler(device, &samplerDesc);

    WGPUBindGroupLayoutEntry layoutEntries[2] = {WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT,
                                                 WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT};
    layoutEntries[0].binding = 0;
    layoutEntries[0].visibility = WGPUShaderStage_Fragment;
    layoutEntries[0].texture.sampleType = WGPUTextureSampleType_Float;
    layoutEntries[0].texture.viewDimension = WGPUTextureViewDimension_2D;
    layoutEntries[1].binding = 1;
    layoutEntries[1].visibility = WGPUShaderStage_Fragment;
    layoutEntries[1].sampler.type = WGPUSamplerBindingType_Filtering;
    WGPUBindGroupLayoutDescriptor layoutDesc = WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
    layoutDesc.entryCount = 2;
    layoutDesc.entries = layoutEntries;
    WGPUBindGroupLayout layout = wgpuDeviceCreateBindGroupLayout(device, &layoutDesc);

    WGPUShaderModule vertexModule = MakeModule(device, kFullscreenVertexShader);
    WGPUShaderModule fragmentModule = MakeModule(device, kSampleFragmentShader);
    WGPUColorTargetState target = WGPU_COLOR_TARGET_STATE_INIT;
    // Pass B draws into the swapchain, whose only format is R8G8B8A8_UNORM.
    target.format = WGPUTextureFormat_RGBA8Unorm;
    target.writeMask = WGPUColorWriteMask_All;
    WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
    fragment.module = fragmentModule;
    fragment.entryPoint = WGPU_STRING_VIEW_INIT;
    fragment.entryPoint.data = "main";
    fragment.targetCount = 1;
    fragment.targets = &target;
    WGPUPipelineLayoutDescriptor pipelineLayoutDesc = WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;
    pipelineLayoutDesc.bindGroupLayoutCount = 1;
    pipelineLayoutDesc.bindGroupLayouts = &layout;
    WGPUPipelineLayout pipelineLayout = wgpuDeviceCreatePipelineLayout(device, &pipelineLayoutDesc);
    WGPURenderPipelineDescriptor pipelineDesc = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    pipelineDesc.layout = pipelineLayout;
    pipelineDesc.vertex.module = vertexModule;
    pipelineDesc.vertex.entryPoint = WGPU_STRING_VIEW_INIT;
    pipelineDesc.vertex.entryPoint.data = "main";
    pipelineDesc.vertex.bufferCount = 0;
    // Pass B draws a 4-vertex strip (the fullscreen quad); the scene pass draws a triangle.
    pipelineDesc.primitive.topology = WGPUPrimitiveTopology_TriangleStrip;
    pipelineDesc.multisample.count = 1;
    pipelineDesc.fragment = &fragment;
    WGPURenderPipeline samplePipeline = wgpuDeviceCreateRenderPipeline(device, &pipelineDesc);
    wgpuShaderModuleRelease(vertexModule);
    wgpuShaderModuleRelease(fragmentModule);
    wgpuPipelineLayoutRelease(pipelineLayout);

    WGPUBindGroupEntry groupEntries[2] = {WGPU_BIND_GROUP_ENTRY_INIT, WGPU_BIND_GROUP_ENTRY_INIT};
    groupEntries[0].binding = 0;
    groupEntries[0].textureView = resolvedView;
    groupEntries[1].binding = 1;
    groupEntries[1].sampler = sampler;
    WGPUBindGroupDescriptor groupDesc = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    groupDesc.layout = layout;
    groupDesc.entryCount = 2;
    groupDesc.entries = groupEntries;
    g_sampleGroup = wgpuDeviceCreateBindGroup(device, &groupDesc);
    wgpuBindGroupLayoutRelease(layout);
    // The resolved texture's view stays referenced by the bind group for every presented frame.

    TN_LOG(TN_E3_TAG " sampled=%ux%u format=%s samples=%u half=sample|load group=%s", TN_OFFSCREEN,
           TN_OFFSCREEN, TN_E3_TEX_RGBA8 ? "rgba8unorm" : "rgba16float", samples,
           g_sampleGroup ? "ok" : "null");
    return samplePipeline;
}
#endif

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
        TN_LOG(TN_E3_TAG " surface=create_failed");
        return;
    }
    TN_LOG(TN_E3_TAG " surface=created");

    WGPUSurfaceConfiguration config = WGPU_SURFACE_CONFIGURATION_INIT;
    config.device = device;
    config.format = WGPUTextureFormat_RGBA8Unorm;
    config.usage = WGPUTextureUsage_RenderAttachment;
    config.width = TN_SURFACE_W;
    config.height = TN_SURFACE_H;
    config.alphaMode = WGPUCompositeAlphaMode_Auto;
    config.presentMode = WGPUPresentMode_Fifo;
    wgpuSurfaceConfigure(surface, &config);
    TN_LOG(TN_E3_TAG " surface=configured");

    for (int frame = 1; frame <= TN_FRAMES; ++frame) {
        WGPUSurfaceTexture surfaceTexture = WGPU_SURFACE_TEXTURE_INIT;
        wgpuSurfaceGetCurrentTexture(surface, &surfaceTexture);
        if (surfaceTexture.status != WGPUSurfaceGetCurrentTextureStatus_SuccessOptimal &&
            surfaceTexture.status != WGPUSurfaceGetCurrentTextureStatus_SuccessSuboptimal) {
            TN_LOG(TN_E3_TAG " frame=%d get_current_texture status=%d", frame,
                   (int)surfaceTexture.status);
            return;
        }

        if (frame == 1) {
            TN_LOG(TN_E3_TAG " surface=frame1");
        }
        WGPUTextureView view = wgpuTextureCreateView(surfaceTexture.texture, nullptr);
        DrawInto(device, pipeline, view);
        wgpuTextureViewRelease(view);
        wgpuTextureRelease(surfaceTexture.texture);

        if (wgpuSurfacePresent(surface) != WGPUStatus_Success) {
            TN_LOG(TN_E3_TAG " frame=%d present_failed", frame);
            return;
        }
        wgpuInstanceProcessEvents(instance);

        if (frame % 60 == 0) {
            TN_LOG(TN_E3_TAG " frame=%d", frame);
        }
    }
    TN_LOG(TN_E3_TAG " frames=%d presented", TN_FRAMES);
}

int main(void) {
    TN_LOG("=== Dawn PS4 (PRD-784 E3) ===");

    WGPUInstanceDescriptor instanceDesc = WGPU_INSTANCE_DESCRIPTOR_INIT;
    WGPUInstance instance = wgpuCreateInstance(&instanceDesc);
    if (instance == nullptr) {
        TN_LOG(TN_E3_TAG " instance=create_failed");
        return 1;
    }

    WGPUAdapter adapter = RequestAdapter(instance);
    if (adapter == nullptr) {
        TN_LOG(TN_E3_TAG " adapter=null");
        return 1;
    }
    LogAdapterInfo(adapter);

    WGPUDevice device = RequestDevice(instance, adapter);
    if (device == nullptr) {
        TN_LOG(TN_E3_TAG " device=null");
        return 1;
    }

#if TN_E3_GUEST_CS
    RunCompute(instance, device);
#endif
#if TN_E3_GUEST_TEX
    // Pass B's pipeline is what the surface loop draws with: the scene target was rendered once,
    // and every presented frame samples it.
    WGPURenderPipeline pipeline = RunTexturePass(instance, device);
#else
    WGPURenderPipeline pipeline = RunOffscreen(instance, device);
#endif
    if (pipeline != nullptr) {
        TN_LOG(TN_E3_TAG " pipeline=ok");
        if (TN_READBACK) wgpuDeviceTick(device);
        RunSurface(instance, adapter, device, pipeline);
    }

    TN_LOG(TN_E3_TAG " errors=%d", g_errors);
    // Hold the last presented frame until the harness stops the run (see e2-triangle.c): an exiting
    // guest blanks the window before a late host capture.
    if (g_errors == 0 && pipeline != nullptr) {
        TN_LOG(TN_E3_TAG " holding the last frame");
        for (;;) sceKernelUsleep(1000000);
    }
    wgpuRenderPipelineRelease(pipeline);
    wgpuDeviceRelease(device);
    wgpuAdapterRelease(adapter);
    wgpuInstanceRelease(instance);
    TN_LOG(TN_E3_TAG " done");
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
