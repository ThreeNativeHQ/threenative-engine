/**
 * WebGPU JavaScript Bindings
 *
 * This file exposes the WebGPU API to JavaScript via the JS engine abstraction.
 * Both Dawn and wgpu-native implement the same webgpu.h C API, so the bindings
 * work with either backend.
 *
 * Key APIs exposed:
 * - canvas (global) - represents the window
 * - canvas.getContext('webgpu') -> GPUCanvasContext
 * - navigator.gpu
 * - navigator.gpu.requestAdapter() -> GPUAdapter
 * - GPUAdapter.requestDevice() -> GPUDevice
 * - GPUDevice.createBuffer()
 * - GPUDevice.createShaderModule()
 * - GPUDevice.createRenderPipeline()
 * - GPUDevice.createCommandEncoder()
 * - GPUQueue.submit()
 */

#include "mystral/js/engine.h"
#include "mystral/webgpu/bindings.h"
#include "mystral/platform/window.h"
#include "mystral/webgpu/registration_table.h"
#include "mystral/webgpu/wrapper_factories.h"
#include "mystral/cold_start.h"
#include "mystral/stall_budget.h"
#include "runtime_scripts.h"
#include "mystral/webgpu/checked_handle.h"
#include "mystral/webgpu/async_image_decode.h"
#include "bindings_presentation.h"
#include <ctime>
#include <iostream>
#include <vector>
#include <unordered_map>
#include <string>
#include <fstream>
#include <thread>
#include <chrono>
#include <cstdlib>
#include <atomic>
#include <cstdlib>
#include <cstring>
#include <cmath>
#include <limits>
#include <sstream>
#include <algorithm>
#include <string_view>

#if defined(__APPLE__)
#include <os/log.h>
#endif

#if defined(__ANDROID__)
#include <android/log.h>
#endif

// stb_image for image loading (implementation in stb_impl.cpp)
#include "stb_image.h"

// libwebp for WebP image decoding (optional - for GLTF EXT_texture_webp extension)
#ifdef MYSTRAL_HAS_WEBP
#include <webp/decode.h>
#endif

// Canvas 2D context (Skia-backed)
#include "mystral/canvas/canvas2d.h"
#include "bindings_state.h"
#include "bindings_handler_helpers.h"
#include "bindings_commands.h"
#include "bindings_frame_stream.h"
#include "bindings_resources.h"
#include "bindings_pipelines.h"
#include "bindings_presentation.h"
#include "surface_texture_transaction.h"

// Forward declaration for Canvas2D bindings
namespace mystral {
namespace canvas {
    js::JSValueHandle createCanvas2DContext(
        js::Engine* engine,
        int width,
        int height,
        std::vector<std::unique_ptr<Canvas2DContext>>& ownedContexts);
}
}

#if defined(MYSTRAL_WEBGPU_WGPU) || defined(MYSTRAL_WEBGPU_DAWN)
#include <webgpu/webgpu.h>

// PRD-226 ablation arms — no-ops the hot backend entry points when TN_ABLATE_BACKEND is defined.
// Must follow every webgpu declaration (it rewrites those names) and precede every handler body.
#include "ablation.h"
#if defined(MYSTRAL_WEBGPU_WGPU)
#if __has_include(<webgpu/wgpu.h>)
#include <webgpu/wgpu.h>
#else
#include <wgpu/wgpu.h>
#endif
#endif
#include "mystral/webgpu_compat.h"
#endif

// wgpu-native specific extension functions (not in standard webgpu.h)
#if defined(MYSTRAL_WEBGPU_WGPU) && !defined(MYSTRAL_WEBGPU_WGPU_MODERN)
extern "C" {
// Device poll - blocks until GPU work is done
// From wgpu/wgpu.h but declared here to avoid include path issues
typedef struct WGPUWrappedSubmissionIndex WGPUWrappedSubmissionIndex;
WGPUBool wgpuDevicePoll(WGPUDevice device, WGPUBool wait, WGPUWrappedSubmissionIndex const* wrappedSubmissionIndex);
}
#endif

namespace mystral {
namespace webgpu {


static js::JSValueHandle evalEmbeddedRuntimeScriptWithResult(
    js::Engine& engine, std::string_view name, const char* filename) {
    const auto script = runtime_scripts::find(name);
    if (!script.data) {
        std::cerr << "[WebGPU] missing embedded runtime script: " << name << std::endl;
        return {};
    }
    const std::string source(script.data, script.size);
    return engine.evalScriptWithResult(source.c_str(), filename);
}

static bool evalEmbeddedRuntimeScript(
    js::Engine& engine, std::string_view name, const char* filename) {
    const auto script = runtime_scripts::find(name);
    if (!script.data) {
        std::cerr << "[WebGPU] missing embedded runtime script: " << name << std::endl;
        return false;
    }
    const std::string source(script.data, script.size);
    return engine.eval(source.c_str(), filename);
}

BindingsState* createBindingsState() {
    return new BindingsState();
}

#if defined(MYSTRAL_WEBGPU_WGPU) && TN_WEBGPU_UPLOAD_STAGING

struct UploadStagingMapData {
    bool completed = false;
};

#if WGPU_BUFFER_MAP_USES_CALLBACK_INFO
static void onUploadStagingMapped(WGPUMapAsyncStatus, WGPUStringView, void* userdata1, void*) {
    static_cast<UploadStagingMapData*>(userdata1)->completed = true;
}
#else
static void onUploadStagingMapped(WGPUMapAsyncStatus, void* userdata) {
    static_cast<UploadStagingMapData*>(userdata)->completed = true;
}
#endif

// Upload staging (see BindingsState::uploadStaging). One work-done callback serves every retired
// block: flushes are strictly ordered on this thread, callbacks fire in retirement order during
// poll, and each one recycles exactly the oldest retired block.
static void onUploadStagingWorkDone(WGPUQueueWorkDoneStatus, void* userdata1, void*) {
    auto* state = static_cast<BindingsState*>(userdata1);
    auto& staging = state->registries.uploadStaging;
    if (staging.retired.empty()) return;
    UploadStagingBlock recycled = staging.retired.front();
    staging.retired.erase(staging.retired.begin());
    staging.ready.push_back(recycled);
}

static void releaseUploadStagingBlock(UploadStagingBlock& block) {
    if (block.buffer) {
        if (block.mapped) wgpuBufferUnmap(block.buffer);
        wgpuBufferRelease(block.buffer);
    }
    block = {};
}

static void releaseUploadStaging(BindingsState* state) {
    auto& staging = state->registries.uploadStaging;
    releaseUploadStagingBlock(staging.current);
    for (auto& block : staging.retired) releaseUploadStagingBlock(block);
    staging.retired.clear();
    for (auto& block : staging.ready) releaseUploadStagingBlock(block);
    staging.ready.clear();
    staging.scratch.clear();
    staging.scratch.shrink_to_fit();
    staging.pendingCopies.clear();
    staging.disabled = false;
}

// Takes a completed or freshly allocated block and maps it for writing. A mapping failure is
// transient by nature (the queue drains), so it falls back to direct writes for the batch but
// leaves staging enabled; only an allocation failure disables it outright.
static bool acquireMappedUploadStagingBlock(BindingsState* state) {
    auto& staging = state->registries.uploadStaging;
    if (staging.current.buffer) return true;
    if (staging.ready.empty()) {
        WGPUBufferDescriptor descriptor = {};
        descriptor.size = UploadStaging::kBlockBytes;
        descriptor.usage = WGPUBufferUsage_MapWrite | WGPUBufferUsage_CopySrc;
        staging.current.buffer = wgpuDeviceCreateBuffer(state->device, &descriptor);
        if (!staging.current.buffer) {
            staging.disabled = true;
            std::cerr << "[WebGPU] upload staging: could not allocate a block;"
                         " falling back to direct queue writes" << std::endl;
            return false;
        }
    } else {
        staging.current = staging.ready.back();
        staging.ready.pop_back();
    }
    UploadStagingMapData mapData;
#if WGPU_BUFFER_MAP_USES_CALLBACK_INFO
    WGPUBufferMapCallbackInfo stagingMapCallbackInfo = {};
    stagingMapCallbackInfo.mode = WGPUCallbackMode_AllowSpontaneous;
    stagingMapCallbackInfo.callback = onUploadStagingMapped;
    stagingMapCallbackInfo.userdata1 = &mapData;
    stagingMapCallbackInfo.userdata2 = nullptr;
    wgpuBufferMapAsync(
        staging.current.buffer, WGPUMapMode_Write, 0, UploadStaging::kBlockBytes,
        stagingMapCallbackInfo);
#else
    wgpuBufferMapAsync(
        staging.current.buffer, WGPUMapMode_Write, 0, UploadStaging::kBlockBytes,
        onUploadStagingMapped, &mapData);
#endif
    // Non-blocking spin, then exactly one blocking poll as the safety valve. A blocking poll
    // here waits out the GPU's in-flight work and serializes the CPU against it — measured as
    // a ~2x render regression on Pixel 8 — so the common path must complete during the spin
    // (a recycled block's map finishes on the first round; a fresh buffer needs one poll).
    // Abandoning a pending map is not an option: its callback writes into this frame's
    // mapData after return, so exhaustion falls through to the blocking poll instead.
    int polls = 0;
    while (!mapData.completed && polls < 400) {
#if defined(MYSTRAL_WEBGPU_WGPU)
        wgpuDevicePoll(state->device, false, nullptr);
#endif
        std::this_thread::sleep_for(std::chrono::microseconds(50));
        polls++;
    }
#if defined(MYSTRAL_WEBGPU_WGPU)
    if (!mapData.completed) wgpuDevicePoll(state->device, true, nullptr);
#endif
    if (!mapData.completed ||
        !(staging.current.mapped =
              static_cast<uint8_t*>(wgpuBufferGetMappedRange(
                  staging.current.buffer, 0, UploadStaging::kBlockBytes)))) {
        std::cerr << "[WebGPU] upload staging: map did not complete; writing batch directly"
                  << std::endl;
        releaseUploadStagingBlock(staging.current);
        return false;
    }
    return true;
}

// Writes the scratch window through the mapped block in one bulk memcpy — staging offsets index
// both identically — then retires the block unmapped and submits the batch as one command
// buffer. Queue FIFO order makes every recorded copy land before whatever queue work follows
// this boundary.
void flushUploadStaging(BindingsState* state) {
    auto& staging = state->registries.uploadStaging;
    const size_t batchBytes = staging.scratch.size();
    if (staging.pendingCopies.empty() || batchBytes == 0 || !state->queue || !state->device) {
        return;
    }

    if (!acquireMappedUploadStagingBlock(state)) {
        for (const UploadStagingCopy& copy : staging.pendingCopies) {
            wgpuQueueWriteBuffer(
                state->queue, copy.destination, copy.destinationOffset,
                staging.scratch.data() + copy.stagingOffset, copy.size);
        }
        staging.pendingCopies.clear();
        staging.scratch.clear();
        return;
    }
    std::memcpy(staging.current.mapped, staging.scratch.data(), batchBytes);
    wgpuBufferUnmap(staging.current.buffer);
    staging.current.mapped = nullptr;

    WGPUCommandEncoderDescriptor encoderDescriptor = {};
    WGPUCommandEncoder encoder =
        wgpuDeviceCreateCommandEncoder(state->device, &encoderDescriptor);
    if (!encoder) {
        std::cerr << "[WebGPU] upload staging: encoder creation failed, dropping "
                  << staging.pendingCopies.size() << " staged writes" << std::endl;
        staging.pendingCopies.clear();
        staging.scratch.clear();
        releaseUploadStagingBlock(staging.current);
        return;
    }
    for (const UploadStagingCopy& copy : staging.pendingCopies) {
        wgpuCommandEncoderCopyBufferToBuffer(
            encoder, staging.current.buffer, copy.stagingOffset,
            copy.destination, copy.destinationOffset, copy.size);
    }
    WGPUCommandBufferDescriptor commandBufferDescriptor = {};
    WGPUCommandBuffer commandBuffer =
        wgpuCommandEncoderFinish(encoder, &commandBufferDescriptor);
    wgpuCommandEncoderRelease(encoder);
    if (!commandBuffer) {
        std::cerr << "[WebGPU] upload staging: finish failed, dropping "
                  << staging.pendingCopies.size() << " staged writes" << std::endl;
        staging.pendingCopies.clear();
        staging.scratch.clear();
        releaseUploadStagingBlock(staging.current);
        return;
    }

    staging.retired.push_back(staging.current);
    staging.current = {};
    staging.pendingCopies.clear();
    staging.scratch.clear();

    wgpuQueueSubmit(state->queue, 1, &commandBuffer);
    wgpuCommandBufferRelease(commandBuffer);

    // Distinct local name on purpose: webgpu-async-observation.test.mjs mutates the first
    // `state->queue, callbackInfo` work-done registration to prove its failure is observed;
    // this recycling registration must not shadow that one.
    WGPUQueueWorkDoneCallbackInfo stagingCallbackInfo = {};
    stagingCallbackInfo.callback = onUploadStagingWorkDone;
    stagingCallbackInfo.userdata1 = state;
    wgpuQueueOnSubmittedWorkDone(state->queue, stagingCallbackInfo);
}

#else

void flushUploadStaging(BindingsState*) {}

#endif

// Returns true when the write was absorbed into staging. A false return sends the caller down
// the direct wgpuQueueWriteBuffer path: staging disabled by build flag or allocation failure,
// or the write larger than a whole block. Any pending batch is flushed first so the direct write
// keeps its place in queue order.
bool stageWriteInUploadStaging(
    BindingsState* state, WGPUBuffer buffer, uint64_t offset,
    const uint8_t* source, size_t writeSize, size_t alignedWriteSize) {
#if defined(MYSTRAL_WEBGPU_WGPU) && TN_WEBGPU_UPLOAD_STAGING
    auto& staging = state->registries.uploadStaging;
    if (staging.disabled) return false;

    // A write bigger than a whole block can never stage; flush what precedes it so the direct
    // write keeps its place in queue order.
    if (alignedWriteSize > UploadStaging::kBlockBytes) {
        flushUploadStaging(state);
        return false;
    }
    // The batch shares one block per flush: close it when the next write would not fit.
    if (staging.scratch.size() + alignedWriteSize > UploadStaging::kBlockBytes) {
        flushUploadStaging(state);
    }

    const size_t stagingOffset = staging.scratch.size();
    staging.scratch.resize(stagingOffset + alignedWriteSize, 0);
    std::memcpy(staging.scratch.data() + stagingOffset, source, writeSize);
    staging.pendingCopies.push_back({buffer, offset, stagingOffset, alignedWriteSize});
    return true;
#else
    (void)state; (void)buffer; (void)offset;
    (void)source; (void)writeSize; (void)alignedWriteSize;
    return false;
#endif
}

void destroyBindingsState(BindingsState*& state) {
    if (!state) return;
    // Decoder workers never touch JS, but deferred completions may outlive this state. Invalidate
    // their shared owner before any engine/state teardown; a later drain becomes a no-op.
    auto imageDecodeOwner = state->imageDecodeOwner;
    if (imageDecodeOwner) imageDecodeOwner->alive.store(false, std::memory_order_release);
    // Join the compile pool before anything it touches goes away. A worker holds `state` and the
    // device; letting one run past this point is a use-after-free with a two-thread window.
    shutdownAsyncBufferMaps(state);
    shutdownAsyncPipelineCompiles(state);
    BindingsState* ownedState = state;
    state = nullptr;
    {
        BindingsState* state = ownedState;
        if (state->engine) {
            js::Engine* engine = state->engine;
            if (imageDecodeOwner) {
                for (const auto& callback : imageDecodeOwner->callbacks) {
                    if (callback && callback->live) {
                        engine->freeHandle(callback->handle);
                        callback->live = false;
                    }
                }
                imageDecodeOwner->callbacks.clear();
                imageDecodeOwner->engine = nullptr;
            }
            state->engine = nullptr;
            for (auto it = state->registries.protectedHandles.rbegin(); it != state->registries.protectedHandles.rend();
                 ++it) {
                engine->freeHandle(*it);
            }
            state->registries.protectedHandles.clear();
        }
#if defined(MYSTRAL_WEBGPU_WGPU) && TN_WEBGPU_UPLOAD_STAGING
        releaseUploadStaging(state);
#endif
        state->canvas2D.canvas2DContexts.clear();
#if defined(MYSTRAL_WEBGPU_WGPU) || defined(MYSTRAL_WEBGPU_DAWN)
        while (!state->registries.textureRegistry.empty()) {
            releaseTextureRegistryEntry(state, state->registries.textureRegistry.begin()->first);
        }
        while (!state->registries.bufferRegistry.empty()) {
            releaseBufferRegistryEntry(state, state->registries.bufferRegistry.begin()->first);
        }
        while (!state->registries.computePipelineRegistry.empty()) {
            releaseComputePipelineRegistryEntry(state, state->registries.computePipelineRegistry.begin()->first);
        }
        while (!state->registries.renderPipelineRegistry.empty()) {
            releaseRenderPipelineRegistryEntry(state, state->registries.renderPipelineRegistry.begin()->first);
        }
        for (const auto& [id, bindGroup] : state->registries.bindGroupRegistry) {
            (void)id;
            if (bindGroup) wgpuBindGroupRelease(bindGroup);
        }
        state->registries.bindGroupRegistry.clear();
        releaseCurrentSurfaceTextureViews(state);
        for (const auto& [id, textureView] : state->registries.textureViewRegistry) {
            (void)id;
            if (textureView) wgpuTextureViewRelease(textureView);
        }
        state->registries.textureViewRegistry.clear();
        for (const auto& [id, renderBundle] : state->registries.renderBundleRegistry) {
            (void)id;
            if (renderBundle) wgpuRenderBundleRelease(renderBundle);
        }
        state->registries.renderBundleRegistry.clear();
        for (const auto& [id, querySet] : state->registries.querySetRegistry) {
            (void)id;
            if (querySet) wgpuQuerySetRelease(querySet);
        }
        state->registries.querySetRegistry.clear();
        state->registries.shaderModuleMetadata->releaseAll(&wgpuShaderModuleRelease);
        state->registries.shaderModuleMetadata.reset();
        for (const auto& entry : state->registries.encoderRenderPassMap) {
            if (entry.second) {
                wgpuRenderPassEncoderEnd(entry.second);
                wgpuRenderPassEncoderRelease(entry.second);
            }
        }
        state->registries.encoderRenderPassMap.clear();
        for (const auto& entry : state->registries.encoderComputePassMap) {
            if (entry.second) {
                wgpuComputePassEncoderEnd(entry.second);
                wgpuComputePassEncoderRelease(entry.second);
            }
        }
        state->registries.encoderComputePassMap.clear();
        state->registries.jsRenderPass = nullptr;
        state->registries.jsComputePass = nullptr;
        if (state->registries.jsCommandEncoder &&
            state->registries.commandEncoderRegistry.find(state->registries.jsCommandEncoder) ==
                state->registries.commandEncoderRegistry.end()) {
            wgpuCommandEncoderRelease(state->registries.jsCommandEncoder);
        }
        for (const auto encoder : state->registries.commandEncoderRegistry) {
            if (encoder) wgpuCommandEncoderRelease(encoder);
        }
        state->registries.commandEncoderRegistry.clear();
        state->registries.jsCommandEncoder = nullptr;
        state->canvas2D.mainCanvas2DContext = nullptr;
        if (state->canvas2D.canvas2DBindGroup)
            wgpuBindGroupRelease(state->canvas2D.canvas2DBindGroup);
        if (state->canvas2D.canvas2DPipeline)
            wgpuRenderPipelineRelease(state->canvas2D.canvas2DPipeline);
        if (state->canvas2D.canvas2DSampler)
            wgpuSamplerRelease(state->canvas2D.canvas2DSampler);
        if (state->canvas2D.canvas2DTexture) {
            wgpuTextureDestroy(state->canvas2D.canvas2DTexture);
            wgpuTextureRelease(state->canvas2D.canvas2DTexture);
        }
        if (state->screenshot.screenshotBuffer) {
            wgpuBufferDestroy(state->screenshot.screenshotBuffer);
            wgpuBufferRelease(state->screenshot.screenshotBuffer);
        }
        if (state->presentation.currentTexture && state->surface) {
            wgpuTextureRelease(state->presentation.currentTexture);
        }
        if (state->presentation.srgbPresentationPipeline) {
            wgpuRenderPipelineRelease(state->presentation.srgbPresentationPipeline);
        }
        if (state->presentation.srgbPresentationBindGroupLayout) {
            wgpuBindGroupLayoutRelease(state->presentation.srgbPresentationBindGroupLayout);
        }
#endif
        delete state;
    }
}

static void protectBindingHandle(BindingsState* state, js::JSValueHandle value) {
    if (!state || !state->engine || !value.ptr) return;
    for (const auto& protectedHandle : state->registries.protectedHandles) {
        if (protectedHandle.ptr == value.ptr) return;
    }
    state->engine->freezeHandle(value);
    state->registries.protectedHandles.push_back(value);
}

static void unprotectBindingHandle(BindingsState* state, js::JSValueHandle value) {
    if (!state || !state->engine || !value.ptr) return;
    for (auto it = state->registries.protectedHandles.begin(); it != state->registries.protectedHandles.end(); ++it) {
        if (it->ptr == value.ptr) {
            state->engine->freeHandle(*it);
            state->registries.protectedHandles.erase(it);
            return;
        }
    }
}

static void rollbackOwnedCanvas2DContext(BindingsState* state, js::JSValueHandle context) {
    if (!state || !state->engine || !context.ptr) return;
    auto* nativeContext = static_cast<canvas::Canvas2DContext*>(state->engine->getPrivateData(context));
    if (nativeContext) {
        for (auto it = state->canvas2D.canvas2DContexts.begin(); it != state->canvas2D.canvas2DContexts.end(); ++it) {
            if (it->get() == nativeContext) {
                state->canvas2D.canvas2DContexts.erase(it);
                break;
            }
        }
    }
    unprotectBindingHandle(state, context);
}

static void rollbackOffscreenCanvas(BindingsState* state, int canvasId, js::JSValueHandle element) {
    if (!state || !state->engine) return;
    state->canvas2D.offscreenCanvases.erase(canvasId);
    if (state->canvas2D.nextOffscreenCanvasId == canvasId + 1)
        state->canvas2D.nextOffscreenCanvasId = canvasId;
    const std::string globalName = "__offscreenCanvas_" + std::to_string(canvasId);
    state->engine->deleteProperty(state->engine->getGlobal(), globalName.c_str());
    unprotectBindingHandle(state, element);
}

static js::JSValueHandle createOwnedCanvas2DContext(
    BindingsState* state,
    int width,
    int height) {
    auto context = canvas::createCanvas2DContext(state->engine, width, height, state->canvas2D.canvas2DContexts);
    protectBindingHandle(state, context);
    return context;
}


// Canvas context state
// The format exposed to JavaScript may differ from the native presentation format. Some
// Android surfaces expose only an sRGB attachment. Three.js already writes display-encoded
// output, so rendering it directly into that attachment applies the transfer twice. In that
// case JavaScript renders into the matching linear format and a native fullscreen pass
// linearizes once before the sRGB surface stores it.
// Render-thread CPU time, so an A/B can be judged on work done rather than on frames that a
// FIFO present has already paced. Zero where the platform has no per-thread CPU clock.
uint64_t readRenderThreadCpuNs() {
#if defined(CLOCK_THREAD_CPUTIME_ID)
    timespec ts{};
    if (clock_gettime(CLOCK_THREAD_CPUTIME_ID, &ts) == 0) {
        return static_cast<uint64_t>(ts.tv_sec) * 1000000000ull + static_cast<uint64_t>(ts.tv_nsec);
    }
#endif
    return 0;
}

#if TN_ANDROID_JS_PROFILE
static void profilingBusyLoop() {
#if TN_ANDROID_JS_PROFILE_BUSY_LOOP
    volatile uint32_t control = 0;
    for (uint32_t i = 0; i < 10000; i++) control = control * 33u + i;
    (void)control;
#endif
}

std::chrono::steady_clock::time_point beginProfiledBinding() {
    const auto start = std::chrono::steady_clock::now();
    profilingBusyLoop();
    return start;
}

ProfiledBufferUsage profiledBufferUsage(WGPUBufferUsage usage) {
    if (usage & WGPUBufferUsage_Uniform) return ProfiledBufferUsage::Uniform;
    if (usage & WGPUBufferUsage_Storage) return ProfiledBufferUsage::Storage;
    if (usage & WGPUBufferUsage_Vertex) return ProfiledBufferUsage::Vertex;
    if (usage & WGPUBufferUsage_Index) return ProfiledBufferUsage::Index;
    return ProfiledBufferUsage::Other;
}

uint64_t endProfiledBinding(
    BindingsState* state,
    ProfiledRenderCommand command,
    std::chrono::steady_clock::time_point start,
    uint64_t count
) {
    const auto elapsed = std::chrono::steady_clock::now() - start;
    const auto elapsedNs =
        static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(elapsed).count());
    const auto index = static_cast<size_t>(command);
    state->profiling.androidJsNativeProfile.counts[index] += count;
    state->profiling.androidJsNativeProfile.commandNs[index] += elapsedNs;
    state->profiling.androidJsNativeProfile.bindingNs += elapsedNs;
    return elapsedNs;
}

static void emitAndroidJsNativeProfile(BindingsState* state, uint64_t submitPollNs, uint64_t presentNs) {
    const uint64_t nowCpuNs = readRenderThreadCpuNs();
    const uint64_t renderThreadCpuNs =
        (state->profiling.lastRenderThreadCpuNs != 0 && nowCpuNs > state->profiling.lastRenderThreadCpuNs)
            ? nowCpuNs - state->profiling.lastRenderThreadCpuNs
            : 0;
    state->profiling.lastRenderThreadCpuNs = nowCpuNs;
    const auto& counts = state->profiling.androidJsNativeProfile.counts;
    const auto& commandNs = state->profiling.androidJsNativeProfile.commandNs;
    uint64_t calls = 0;
    for (size_t i = 0; i < static_cast<size_t>(ProfiledRenderCommand::Count); i++) {
        calls += counts[i];
    }
    const auto& usageCalls = state->profiling.androidJsNativeProfile.writeBufferUsageCalls;
    const auto& usageBytes = state->profiling.androidJsNativeProfile.writeBufferUsageBytes;
    const auto& usageNs = state->profiling.androidJsNativeProfile.writeBufferUsageNs;
    const auto emitUsage = [&](std::ostringstream& stream, const char* name, ProfiledBufferUsage usage) {
        const auto index = static_cast<size_t>(usage);
        stream << "\"" << name << "\":{\"calls\":" << usageCalls[index]
               << ",\"bytes\":" << usageBytes[index]
               << ",\"ns\":" << usageNs[index] << "}";
    };
    std::ostringstream uploadOutput;
    uploadOutput << "TN_ANDROID_JS_UPLOAD:{\"frame\":" << state->profiling.frameEndCount
                 << ",\"writeBufferFullCalls\":" << state->profiling.androidJsNativeProfile.writeBufferFullCalls
                 << ",\"writeBufferPartialCalls\":" << state->profiling.androidJsNativeProfile.writeBufferPartialCalls
                 << ",\"writeBufferUsage\":{";
    emitUsage(uploadOutput, "uniform", ProfiledBufferUsage::Uniform);
    uploadOutput << ",";
    emitUsage(uploadOutput, "storage", ProfiledBufferUsage::Storage);
    uploadOutput << ",";
    emitUsage(uploadOutput, "vertex", ProfiledBufferUsage::Vertex);
    uploadOutput << ",";
    emitUsage(uploadOutput, "index", ProfiledBufferUsage::Index);
    uploadOutput << ",";
    emitUsage(uploadOutput, "other", ProfiledBufferUsage::Other);
    uploadOutput << "}}";
    std::ostringstream output;
    output << "TN_ANDROID_JS_NATIVE:{\"engine\":\"" << state->engine->getName() << "\",\"calls\":" << calls
           << ",\"bindingNs\":" << state->profiling.androidJsNativeProfile.bindingNs
           << ",\"frameOpDrainNs\":" << state->profiling.androidJsNativeProfile.frameOpDrainNs
           << ",\"frameOpReplayNs\":" << state->profiling.androidJsNativeProfile.frameOpReplayNs
           << ",\"submits\":" << state->profiling.androidJsNativeProfile.submits
           << ",\"bundlesExecuted\":" << state->profiling.androidJsNativeProfile.bundlesExecuted
           << ",\"writeBufferBytes\":" << state->profiling.androidJsNativeProfile.writeBufferBytes
           << ",\"writeBufferDistinctTargets\":" << state->profiling.androidJsNativeProfile.writeBufferTargets.size()
           << ",\"writeBufferSmallCalls\":" << state->profiling.androidJsNativeProfile.writeBufferSmallCalls
           << ",\"writeBufferSmallNs\":" << state->profiling.androidJsNativeProfile.writeBufferSmallNs
           << ",\"writeBufferMediumCalls\":" << state->profiling.androidJsNativeProfile.writeBufferMediumCalls
           << ",\"writeBufferMediumNs\":" << state->profiling.androidJsNativeProfile.writeBufferMediumNs
           << ",\"writeBufferLargeCalls\":" << state->profiling.androidJsNativeProfile.writeBufferLargeCalls
           << ",\"writeBufferLargeNs\":" << state->profiling.androidJsNativeProfile.writeBufferLargeNs
           << ",\"bridgeCalls\":" << js::g_bridgeCalls << ",\"bridgeNs\":" << js::g_bridgeNs
           << ",\"bridgeArgs\":" << js::g_bridgeArgs << ",\"bridgeOverheadNs\":" << js::g_bridgeOverheadNs
           << ",\"jsFrameNs\":" << js::g_jsFrameNs << ",\"threadCpuNs\":" << renderThreadCpuNs
           << ",\"submitPollNs\":" << submitPollNs << ",\"presentNs\":" << presentNs
           << ",\"presentThreadCpuNs\":" << state->profiling.lastPresentThreadCpuNs
           << ",\"frame\":" << state->profiling.frameEndCount
           << ",\"commands\":{\"setPipeline\":" << counts[static_cast<size_t>(ProfiledRenderCommand::SetPipeline)]
           << ",\"setBindGroup\":" << counts[static_cast<size_t>(ProfiledRenderCommand::SetBindGroup)]
           << ",\"draw\":" << counts[static_cast<size_t>(ProfiledRenderCommand::Draw)]
           << ",\"drawIndexed\":" << counts[static_cast<size_t>(ProfiledRenderCommand::DrawIndexed)]
           << ",\"bundleDrawIndexed\":" << counts[static_cast<size_t>(ProfiledRenderCommand::BundleDrawIndexed)]
           << ",\"executeBundles\":" << counts[static_cast<size_t>(ProfiledRenderCommand::ExecuteBundles)]
           << ",\"setVertexBuffer\":" << counts[static_cast<size_t>(ProfiledRenderCommand::SetVertexBuffer)]
           << ",\"setIndexBuffer\":" << counts[static_cast<size_t>(ProfiledRenderCommand::SetIndexBuffer)]
           << ",\"writeBuffer\":" << counts[static_cast<size_t>(ProfiledRenderCommand::WriteBuffer)]
           << ",\"endRenderPass\":" << counts[static_cast<size_t>(ProfiledRenderCommand::EndRenderPass)]
           << ",\"beginRenderPass\":" << counts[static_cast<size_t>(ProfiledRenderCommand::BeginRenderPass)]
           << ",\"submit\":" << counts[static_cast<size_t>(ProfiledRenderCommand::Submit)]
           << ",\"devicePoll\":" << counts[static_cast<size_t>(ProfiledRenderCommand::DevicePoll)]
           << "},\"commandNs\":{\"setPipeline\":" << commandNs[static_cast<size_t>(ProfiledRenderCommand::SetPipeline)]
           << ",\"setBindGroup\":" << commandNs[static_cast<size_t>(ProfiledRenderCommand::SetBindGroup)]
           << ",\"draw\":" << commandNs[static_cast<size_t>(ProfiledRenderCommand::Draw)]
           << ",\"drawIndexed\":" << commandNs[static_cast<size_t>(ProfiledRenderCommand::DrawIndexed)]
           << ",\"bundleDrawIndexed\":" << commandNs[static_cast<size_t>(ProfiledRenderCommand::BundleDrawIndexed)]
           << ",\"executeBundles\":" << commandNs[static_cast<size_t>(ProfiledRenderCommand::ExecuteBundles)]
           << ",\"setVertexBuffer\":" << commandNs[static_cast<size_t>(ProfiledRenderCommand::SetVertexBuffer)]
           << ",\"setIndexBuffer\":" << commandNs[static_cast<size_t>(ProfiledRenderCommand::SetIndexBuffer)]
           << ",\"writeBuffer\":" << commandNs[static_cast<size_t>(ProfiledRenderCommand::WriteBuffer)]
           << ",\"endRenderPass\":" << commandNs[static_cast<size_t>(ProfiledRenderCommand::EndRenderPass)]
           << ",\"beginRenderPass\":" << commandNs[static_cast<size_t>(ProfiledRenderCommand::BeginRenderPass)]
           << ",\"submit\":" << commandNs[static_cast<size_t>(ProfiledRenderCommand::Submit)]
           << ",\"devicePoll\":" << commandNs[static_cast<size_t>(ProfiledRenderCommand::DevicePoll)] << "}}";
    {
        std::vector<std::pair<const void*, js::BridgeStat>> top(
            js::bridgeStats().begin(), js::bridgeStats().end());
        std::sort(top.begin(), top.end(), [](const auto& a, const auto& b) { return a.second.ns > b.second.ns; });
        std::ostringstream byName;
        byName << "TN_BRIDGE_BY_NAME:{\"frame\":" << state->profiling.frameEndCount << ",\"top\":[";
        for (size_t i = 0; i < top.size() && i < 25; i++) {
            const auto it = js::bridgeNames().find(top[i].first);
            const std::string label = it == js::bridgeNames().end() ? "<unnamed>" : it->second;
            if (i) byName << ",";
            byName << "{\"name\":\"" << label << "\",\"calls\":" << top[i].second.calls
                   << ",\"ns\":" << top[i].second.ns << "}";
        }
        byName << "]}";
        std::cout << byName.str() << std::endl;
        js::bridgeStats().clear();
    }
    const std::string uploadMarker = uploadOutput.str();
    const std::string marker = output.str();
    std::cout << uploadMarker << std::endl;
    std::cout << marker << std::endl;
#if defined(__ANDROID__)
    __android_log_print(ANDROID_LOG_INFO, "MystralRuntime", "%s", uploadMarker.c_str());
    __android_log_print(ANDROID_LOG_INFO, "MystralRuntime", "%s", marker.c_str());
#endif
    state->profiling.androidJsNativeProfile = {};
    js::g_bridgeCalls = 0;
    js::g_bridgeNs = 0;
    js::g_bridgeArgs = 0;
    js::g_bridgeOverheadNs = 0;
    js::g_jsFrameNs = 0;
}
#endif

// Set when a submit has put surface-targeted commands in flight; consumed once per frame by
// presentPendingSurface(). Presenting inside submit meant a frame that submits twice — three.js
// renders the world and then an overlay pass — presented twice, and only the first reached the
// display. See presentPendingSurface().
#if TN_ANDROID_JS_PROFILE
// Present happens once per frame but submits happen several times; without this flag every
// submit marker carried the same previous-frame presentNs and the profile summed it once per
// submit — on the Pixel 8 that read as a phantom ~2.6 ms/frame of native cost at 4.3
// submits/frame. Cleared by each present so the next frame's first submit reports it.
#endif
// One present per frame is the invariant the overlay pass depends on; the desktop gate asserts it.

// Set only by a consumer about to read a capture (requestFrameScreenshot). The frame copy and its
// wait are paid on requested frames only — every unrequested presented frame skips both.
// Prevent capturing multiple screenshots per frame (Three.js does multiple queue.submit() per frame)
// Main canvas 2D context and all registries are owned by BindingsState.

// Dawn resource cleanup is handled via Engine::registerRelease(), which sets up
// V8 weak callbacks. When the JS wrapper object is garbage collected (no more
// JS references), the callback fires and releases the Dawn resource.
// This is the same pattern Chrome uses for WebGPU resource lifecycle.

struct ErrorScopeData {
    std::atomic<int> callbackReferences{2};
    std::atomic<bool> completed{false};
    std::mutex waitMutex;
    std::condition_variable waitCondition;
#if WGPU_USES_CALLBACK_INFO_PATTERN
    WGPUPopErrorScopeStatus status = WGPUPopErrorScopeStatus_Force32;
#endif
    WGPUErrorType type = WGPUErrorType_Unknown;
    std::string message;
};

struct QueueWorkDoneData {
    std::atomic<int> callbackReferences{2};
    std::atomic<bool> completed{false};
    std::mutex waitMutex;
    std::condition_variable waitCondition;
    WGPUQueueWorkDoneStatus status = WGPUQueueWorkDoneStatus_Error;
    std::string message;
};

template <typename CallbackData>
static void releaseCallbackData(CallbackData* data) {
    if (data->callbackReferences.fetch_sub(1, std::memory_order_acq_rel) == 1) delete data;
}

#if WGPU_USES_CALLBACK_INFO_PATTERN
static void onErrorScopePopped(WGPUPopErrorScopeStatus status,
                               WGPUErrorType type,
                               WGPUStringView message,
                               void* userdata1,
                               void*) {
    auto* data = static_cast<ErrorScopeData*>(userdata1);
    {
        std::lock_guard<std::mutex> lock(data->waitMutex);
        data->status = status;
        data->type = type;
        data->message = WGPU_PRINT_STRING_VIEW(message);
    }
    data->completed.store(true, std::memory_order_release);
    data->waitCondition.notify_all();
    releaseCallbackData(data);
}
#else
static void onErrorScopePopped(WGPUErrorType type, const char* message, void* userdata) {
    auto* data = static_cast<ErrorScopeData*>(userdata);
    {
        std::lock_guard<std::mutex> lock(data->waitMutex);
        data->type = type;
        data->message = message ? message : "";
    }
    data->completed.store(true, std::memory_order_release);
    data->waitCondition.notify_all();
    releaseCallbackData(data);
}
#endif

#if defined(MYSTRAL_WEBGPU_DAWN)
static void onQueueWorkDone(WGPUQueueWorkDoneStatus status,
                            WGPUStringView message,
                            void* userdata1,
                            void*) {
    auto* data = static_cast<QueueWorkDoneData*>(userdata1);
    {
        std::lock_guard<std::mutex> lock(data->waitMutex);
        data->status = status;
        data->message = WGPU_PRINT_STRING_VIEW(message);
    }
    data->completed.store(true, std::memory_order_release);
    data->waitCondition.notify_all();
    releaseCallbackData(data);
}
#elif defined(MYSTRAL_WEBGPU_WGPU_MODERN)
static void onQueueWorkDone(WGPUQueueWorkDoneStatus status, void* userdata1, void*) {
    auto* data = static_cast<QueueWorkDoneData*>(userdata1);
    {
        std::lock_guard<std::mutex> lock(data->waitMutex);
        data->status = status;
    }
    data->completed.store(true, std::memory_order_release);
    data->waitCondition.notify_all();
    releaseCallbackData(data);
}
#else
static void onQueueWorkDone(WGPUQueueWorkDoneStatus status, void* userdata) {
    auto* data = static_cast<QueueWorkDoneData*>(userdata);
    {
        std::lock_guard<std::mutex> lock(data->waitMutex);
        data->status = status;
    }
    data->completed.store(true, std::memory_order_release);
    data->waitCondition.notify_all();
    releaseCallbackData(data);
}
#endif

template <typename CallbackData>
static bool waitForWebGpuCallback(BindingsState* state, CallbackData* data) {
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
    while (!data->completed.load(std::memory_order_acquire)) {
#if defined(MYSTRAL_WEBGPU_WGPU)
        if (state->device) wgpuDevicePoll(state->device, false, nullptr);
#else
        if (state->instance) wgpuInstanceProcessEvents(state->instance);
        if (state->device) wgpuDeviceTick(state->device);
#endif
        if (std::chrono::steady_clock::now() >= deadline) return false;
        std::unique_lock<std::mutex> lock(data->waitMutex);
        data->waitCondition.wait_for(lock, std::chrono::milliseconds(1), [data]() {
            return data->completed.load(std::memory_order_acquire);
        });
    }
    return true;
}

static std::string jsStringLiteral(const std::string& value) {
    static constexpr char hex[] = "0123456789abcdef";
    std::string result = "\"";
    for (const unsigned char character : value) {
        switch (character) {
            case '\\': result += "\\\\"; break;
            case '"': result += "\\\""; break;
            case '\n': result += "\\n"; break;
            case '\r': result += "\\r"; break;
            case '\t': result += "\\t"; break;
            default:
                if (character < 0x20) {
                    result += "\\u00";
                    result += hex[(character >> 4) & 0x0f];
                    result += hex[character & 0x0f];
                } else {
                    result += static_cast<char>(character);
                }
        }
    }
    result += '"';
    return result;
}

static js::JSValueHandle resolvedPromise(BindingsState* state, const std::string& expression, const char* filename) {
    const std::string source = "Promise.resolve(" + expression + ")";
    return state->engine->evalScriptWithResult(source.c_str(), filename);
}

static js::JSValueHandle rejectedPromise(BindingsState* state, const std::string& message, const char* filename) {
    const std::string source = "Promise.reject(new Error(" + jsStringLiteral(message) + "))";
    return state->engine->evalScriptWithResult(source.c_str(), filename);
}

static const char* gpuErrorName(WGPUErrorType type) {
    switch (type) {
        case WGPUErrorType_Validation: return "GPUValidationError";
        case WGPUErrorType_OutOfMemory: return "GPUOutOfMemoryError";
        case WGPUErrorType_Internal: return "GPUInternalError";
        default: return "GPUError";
    }
}

// adapter/device feature sets. Returns 0 (never a valid value) when unmapped: either a
// name this build does not model or one whose backing bindings are not implemented.
static WGPUFeatureName jsFeatureNameToWGPU(const std::string& featureName) {
    if (featureName == "depth-clip-control") return WGPUFeatureName_DepthClipControl;
    if (featureName == "depth32float-stencil8") return WGPUFeatureName_Depth32FloatStencil8;
    if (featureName == "texture-compression-bc") return WGPUFeatureName_TextureCompressionBC;
    if (featureName == "texture-compression-etc2") return WGPUFeatureName_TextureCompressionETC2;
    if (featureName == "texture-compression-astc") return WGPUFeatureName_TextureCompressionASTC;
    if (featureName == "float32-filterable") return WGPUFeatureName_Float32Filterable;
    // Implemented as of PRD-228: QuerySet, timestampWrites on render and compute passes, and
    // resolveQuerySet. Answered from the real adapter and device below, so an adapter without it
    // still reports false — the feature is advertised because it works, not because it is named.
    if (featureName == "timestamp-query") return WGPUFeatureName_TimestampQuery;
#if defined(MYSTRAL_WEBGPU_DAWN) || defined(MYSTRAL_WEBGPU_WGPU)
    // The feature behind three's SSGI target format (RGBFormat + UnsignedInt101111Type maps to
    // an rg11b10ufloat render target). Both shipped WebGPU C headers define this enum; without
    // the mapping, adapter.features.has() and device.features.has() answer false regardless of
    // what the hardware supports.
    if (featureName == "rg11b10ufloat-renderable") return WGPUFeatureName_RG11B10UfloatRenderable;
#endif
    return static_cast<WGPUFeatureName>(0);
}

static js::JSValueHandle configureCanvasContext(
    BindingsState* state,
    BindingDestination,
    const std::vector<js::JSValueHandle>& args) {
    const auto descriptor = args[0];
    const std::string format = state->engine->toString(state->engine->getProperty(descriptor, "format"));
    const WGPUTextureFormat configuredFormat = stringToFormat(format);
    if (state->presentation.requiresSrgbPresentationBridge &&
        configuredFormat != linearSurfaceFormat(state->presentation.nativeSurfaceFormat)) {
        state->engine->throwException(
            "GPUCanvasContext.configure format does not match the native presentation bridge");
        return state->engine->newUndefined();
    }
    state->presentation.surfaceFormat = configuredFormat;
    state->presentation.contextConfigured = true;
    if (state->verboseLogging) {
        std::cout << "[Canvas] Context configured with format: " << format << std::endl;
    }
    return state->engine->newUndefined();
}

static js::JSValueHandle getCurrentCanvasTexture(
    BindingsState* state,
    js::JSValueHandle canvasContext) {
    // Created HTML canvases share the host's presentation surface. They need the same
    // acquisition/view bookkeeping as the main canvas or endFrame never presents them.
    const auto canvas = state->engine->getProperty(canvasContext, "canvas");
    if (!syncSurfaceSizeToCanvas(state, canvas)) {
        if (!state->engine->hasException())
            state->engine->throwException("Canvas dimensions must be positive integer pixels");
        return state->engine->newUndefined();
    }

    return acquireSurfaceTexture(
        state,
        [](BindingsState* state) {
            WGPUTexture texture = getCurrentSwapchainTexture(state);
            return texture;
        },
        [](BindingsState* currentState,
           WGPUTexture texture,
           uint64_t textureId,
           uint32_t width,
           uint32_t height,
           const char* format,
           bool createdSurfaceTexture) {
            return createTextureWrapper(
                currentState,
                texture,
                textureId,
                width,
                height,
                format,
                createdSurfaceTexture);
        },
        [](BindingsState* currentState,
           WGPUTexture texture,
           WGPUTexture previousCurrentTexture) {
            if (currentState->surface && texture && texture != previousCurrentTexture) {
                wgpuTextureRelease(texture);
            }
        });

}

static BindingHandler makeUnconfigureCanvasContextHandler(bool offscreen) {
    return [offscreen](BindingsState* state, BindingDestination, const std::vector<js::JSValueHandle>&) {
        if (!offscreen)
            state->presentation.contextConfigured = false;
        return state->engine->newUndefined();
    };
}

static BindingHandler makeCurrentTextureCanvasContextHandler(bool offscreen) {
    return [](BindingsState* state, BindingDestination destination, const std::vector<js::JSValueHandle>&) {
        return getCurrentCanvasTexture(state, destination);
    };
}

static bool installCanvasContextBindings(
    BindingsState* state,
    js::JSValueHandle canvasContext,
    bool offscreen) {
    // getCurrentTexture reads its owning canvas on later frames. Keep the destination
    // handle alive alongside its callbacks, as for the created canvas element itself.
    protectBindingHandle(state, canvasContext);
    if (!installBindingTable(state->engine, state, bindingTable({
        {"GPUCanvasContext", "configure", 1, "configure requires a descriptor", &configureCanvasContext, canvasContext},
        {"GPUCanvasContext", "unconfigure", 0, nullptr,
         makeUnconfigureCanvasContextHandler(offscreen), canvasContext},
        {"GPUCanvasContext", "getCurrentTexture", 0, nullptr,
         makeCurrentTextureCanvasContextHandler(offscreen), canvasContext},
    }))) {
        unprotectBindingHandle(state, canvasContext);
        return false;
    }
    return true;
}


/** Install the table-driven WebGPU surfaces after state has been initialized. */
#if defined(MYSTRAL_WEBGPU_WGPU) || defined(MYSTRAL_WEBGPU_DAWN)
static bool installWebGPUBindingTables(BindingsState* state, js::Engine* engine);

static bool installWebGPUBindingSurfaces(BindingsState* state, js::Engine* engine) {
    return installWebGPUBindingTables(state, engine);
}
/** Every migrated WebGPU method is a BindingRegistration row in this table unit. */

static js::JSValueHandle handleWebGpuCreateOffscreenCanvas2d(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args) {
            int width = 800;
            int height = 600;
            if (args.size() >= 1) {
                width = static_cast<int>(state->engine->toNumber(args[0]));
            }
            if (args.size() >= 2) {
                height = static_cast<int>(state->engine->toNumber(args[1]));
            }
            if (state->verboseLogging) std::cout << "[Canvas] Creating offscreen 2D canvas (" << width << "x" << height << ")" << std::endl;
            // Create a wrapper object that mimics a canvas with a 2D context
            auto canvasWrapper = state->engine->newObject();
            state->engine->setProperty(canvasWrapper, "width", state->engine->newNumber(width));
            state->engine->setProperty(canvasWrapper, "height", state->engine->newNumber(height));
            // Create the 2D context
            auto ctx2d = createOwnedCanvas2DContext(state, width, height);
            state->engine->setProperty(canvasWrapper, "_context", ctx2d);
            // getContext('2d') returns the pre-created context. Captured rather than looked up on
            // the receiver: a binding-table handler's destination is not a live JS value to read
            // properties from, and answering null here was a stub — the same call on a canvas
            // element answered a context, and the only way through was the undocumented
            // `_context` property.
            if (!installBindingTable(state->engine, state, bindingTable({
                {"HTMLCanvasElement", "getContext", 0, nullptr,
                [ctx2d](BindingsState*, BindingDestination, const std::vector<js::JSValueHandle>&) {
                    return ctx2d;
                }
            , canvasWrapper}}))) {
                rollbackOwnedCanvas2DContext(state, ctx2d);
                return state->engine->newUndefined();
            }
            return canvasWrapper;
}

static js::JSValueHandle handleWebGpuNativeGetContext2d(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args) {
            if (args.size() < 2) {
                std::cerr << "[Canvas] __nativeGetContext2D requires contextType and canvasId" << std::endl;
                return state->engine->newNull();
            }
            std::string contextType = state->engine->toString(args[0]);
            int canvasId = static_cast<int>(state->engine->toNumber(args[1]));
            if (contextType != "2d") {
                std::cerr << "[Canvas] Unsupported context type for offscreen canvas: " << contextType << std::endl;
                return state->engine->newNull();
            }
            auto it = state->canvas2D.offscreenCanvases.find(canvasId);
            if (it == state->canvas2D.offscreenCanvases.end()) {
                std::cerr << "[Canvas] Canvas not found: " << canvasId << std::endl;
                return state->engine->newNull();
            }
            OffscreenCanvas* canvas = it->second.get();
            // Return cached context if already created
            if (canvas->hasContext2d) {
                return canvas->context2d;
            }
            // Get current dimensions from the canvas element (in case they were changed)
            std::string globalName = "__offscreenCanvas_" + std::to_string(canvasId);
            auto canvasElement = state->engine->getGlobalProperty(globalName.c_str());
            if (!state->engine->isNull(canvasElement) && !state->engine->isUndefined(canvasElement)) {
                auto widthProp = state->engine->getProperty(canvasElement, "width");
                auto heightProp = state->engine->getProperty(canvasElement, "height");
                if (!state->engine->isUndefined(widthProp)) {
                    canvas->width = static_cast<int>(state->engine->toNumber(widthProp));
                }
                if (!state->engine->isUndefined(heightProp)) {
                    canvas->height = static_cast<int>(state->engine->toNumber(heightProp));
                }
            }
            // Create Canvas 2D context with current dimensions
            if (state->verboseLogging) std::cout << "[Canvas] Creating offscreen 2D context (" << canvas->width << "x" << canvas->height << ")" << std::endl;
            canvas->context2d = createOwnedCanvas2DContext(state, canvas->width, canvas->height);
            canvas->hasContext2d = true;
            return canvas->context2d;
}
static js::JSValueHandle handleWebGpuDecodeImageData(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args) {
            // `__decodeImageDataAsync(arrayBuffer, callback)` — the decode runs on the decoder's
            // pool and the callback is invoked from `AsyncImageDecoder::drain()` on this thread,
            // as `(bitmap, error)`. It used to decode inline here, which stopped the frame loop for
            // the whole of a texture load; see async_image_decode.h.
            if (args.size() < 2) {
                state->engine->throwException("__decodeImageDataAsync requires an ArrayBuffer and a callback");
                return state->engine->newUndefined();
            }
            size_t inputSize = 0;
            void* inputData = state->engine->getArrayBufferData(args[0], &inputSize);
            if (!inputData || inputSize == 0) {
                state->engine->throwException("__decodeImageDataAsync: invalid ArrayBuffer");
                return state->engine->newUndefined();
            }
            // The bytes are copied before they are queued: the ArrayBuffer belongs to JS and may be
            // detached or collected long before a worker reaches it.
            const unsigned char* inputBytes = static_cast<const unsigned char*>(inputData);
            std::vector<uint8_t> bytes(inputBytes, inputBytes + inputSize);
            auto callback = std::make_shared<AsyncImageDecodeCallback>();
            callback->handle = state->engine->retainHandle(args[1]);
            auto owner = state->imageDecodeOwner;
            owner->engine = state->engine;
            owner->callbacks.push_back(callback);
            AsyncImageDecoder::instance().decode(
                std::move(bytes),
                [owner, callback](DecodedImage image) {
                    // Never dereference the old BindingsState: teardown can happen after queueing
                    // and before this completion is drained, including across runtime recreation.
                    if (!owner->alive.load(std::memory_order_acquire)) return;
                    auto* engine = owner->engine;
                    if (!engine || !callback->live) return;
                    js::JSValueHandle result = engine->newUndefined();
                    js::JSValueHandle error = image.error.empty()
                        ? engine->newNull()
                        : engine->newString(image.error.c_str());
                    if (image.error.empty()) {
                        // The ImageBitmap-like object the polyfill wraps: dimensions and the RGBA
                        // payload as an ArrayBuffer, built here because only this thread owns V8.
                        result = engine->newObject();
                        auto arrayBuffer = engine->newArrayBuffer(image.rgba.data(), image.rgba.size());
                        engine->setProperty(result, "width", engine->newNumber(image.width));
                        engine->setProperty(result, "height", engine->newNumber(image.height));
                        engine->setProperty(result, "_data", arrayBuffer);
                        engine->setProperty(result, "_closed", engine->newBoolean(false));
                    }
                    engine->call(callback->handle, engine->newUndefined(), {result, error});
                    // JS may synchronously destroy the runtime. Teardown then releases this handle
                    // while the engine is still valid and marks the record dead.
                    if (!owner->alive.load(std::memory_order_acquire) || !callback->live) return;
                    engine->freeHandle(callback->handle);
                    callback->live = false;
                });
            return state->engine->newUndefined();
}

static js::JSValueHandle handleGpuGetPreferredCanvasFormat(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args) {
    return state->engine->newString(formatToString(state->presentation.surfaceFormat));
}

static js::JSValueHandle handleGpuAdapterFeaturesHas(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args) {
                    if (args.empty()) return state->engine->newBoolean(false);
                    std::string featureName = state->engine->toString(args[0]);
                    // Report adapter support directly. The device may deliberately omit this
                    // feature on modern Android because of the wgpu-native emulator workaround.
                    if (featureName == "indirect-first-instance") {
                        return state->engine->newBoolean(
                            wgpuAdapterHasFeature(
                                state->adapter, WGPUFeatureName_IndirectFirstInstance) != 0);
                    }
                    // three.js reads this one feature to decide whether the whole renderer is
                    // talking to a WebGPU *compatibility* device:
                    //   this.compatibilityMode = !device.features.has("core-features-and-limits");
                    //   if (this.compatibilityMode) renderer._samples = 0;
                    // Answering it wrongly is not a missing feature, it is a silently reduced
                    // renderer — MSAA off outright, plus different depth-texture, MRT-blending and
                    // shader texture paths. It was absent here, so every native game has been
                    // drawing single-sampled with `antialias: true` accepted and ignored.
                    if (featureName == "core-features-and-limits") {
#if MYSTRAL_HAS_CORE_FEATURES_AND_LIMITS
                        if (wgpuAdapterHasFeature(state->adapter, WGPUFeatureName_CoreFeaturesAndLimits))
                            return state->engine->newBoolean(true);
#endif
                        // Answer about the device, not about the header. Compatibility mode is a
                        // feature *level* a caller opts into; this runtime never requests one, so
                        // every device it creates is a core device. wgpu-native has no such mode
                        // at all and no enum for it, and this Dawn build carries the enum without
                        // reporting it. Saying "false" because an enum went unreported told
                        // three.js the opposite of the truth.
                        return state->engine->newBoolean(true);
                    }
                    // Answered from the real adapter so feature-dependent consumers (three's
                    // KTX2Loader.detectSupport among them) request what the hardware has.
                    WGPUFeatureName feature = jsFeatureNameToWGPU(featureName);
                    if (feature == static_cast<WGPUFeatureName>(0)) return state->engine->newBoolean(false);
                    return state->engine->newBoolean(wgpuAdapterHasFeature(state->adapter, feature) != 0);
}

static js::JSValueHandle handleGpuDevicePopErrorScope(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args) {
                            if (state->verboseLogging) {
                                std::cout << "[WebGPU] popErrorScope" << std::endl;
                            }
                            auto* data = new ErrorScopeData();
#if WGPU_USES_CALLBACK_INFO_PATTERN
                            WGPUPopErrorScopeCallbackInfo callbackInfo = {};
                            callbackInfo.mode = WGPUCallbackMode_AllowSpontaneous;
                            callbackInfo.callback = onErrorScopePopped;
                            callbackInfo.userdata1 = data;
                            callbackInfo.userdata2 = nullptr;
                            (void)wgpuDevicePopErrorScope(state->device, callbackInfo);
#else
                            wgpuDevicePopErrorScope(state->device, onErrorScopePopped, data);
#endif
                            if (!waitForWebGpuCallback(state, data)) {
                                releaseCallbackData(data);
                                return rejectedPromise(state,
                                    "GPUDevice.popErrorScope timed out waiting for native observation.",
                                    "popErrorScope-timeout"
                                );
                            }
#if WGPU_USES_CALLBACK_INFO_PATTERN
                            const WGPUPopErrorScopeStatus popStatus = data->status;
                            if (popStatus != WGPUPopErrorScopeStatus_Success) {
                                releaseCallbackData(data);
                                return rejectedPromise(state,
                                    "GPUDevice.popErrorScope failed with native status "
                                        + std::to_string(static_cast<int>(popStatus)),
                                    "popErrorScope-status"
                                );
                            }
#endif
                            const WGPUErrorType errorType = data->type;
                            const std::string errorMessage = data->message;
                            releaseCallbackData(data);
                            if (errorType == WGPUErrorType_NoError) {
                            return resolvedPromise(state, "null", "popErrorScope-empty");
                            }
                            const std::string errorExpression = "{ name: "
                                + jsStringLiteral(gpuErrorName(errorType))
                                + ", message: " + jsStringLiteral(errorMessage) + " }";
                            return resolvedPromise(state, errorExpression, "popErrorScope-observed");
}

static js::JSValueHandle handleGpuDevicePushErrorScope(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args) {
                            const std::string filterName = args.empty() ? "validation" : state->engine->toString(args[0]);
                            WGPUErrorFilter filter;
                            if (filterName == "validation") filter = WGPUErrorFilter_Validation;
                            else if (filterName == "out-of-memory") filter = WGPUErrorFilter_OutOfMemory;
                            else if (filterName == "internal") filter = WGPUErrorFilter_Internal;
                            else {
                                state->engine->throwException("GPUDevice.pushErrorScope received an unknown filter");
                                return state->engine->newUndefined();
                            }
                            wgpuDevicePushErrorScope(state->device, filter);
                            if (state->verboseLogging) {
                                std::cout << "[WebGPU] pushErrorScope: " << filterName << std::endl;
                            }
                            return state->engine->newUndefined();
}

static js::JSValueHandle handleGpuDeviceFeaturesHas(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args) {
                            if (args.empty()) return state->engine->newBoolean(false);
                            std::string featureName = state->engine->toString(args[0]);
                            // Report only features actually granted to this device. Modern Android
                            // intentionally does not request indirect-first-instance.
                            if (featureName == "indirect-first-instance") {
                                return state->engine->newBoolean(
                                    wgpuDeviceHasFeature(
                                        state->device, WGPUFeatureName_IndirectFirstInstance) != 0);
                            }
                            // three.js reads this one feature to decide whether the whole renderer is
                            // talking to a WebGPU *compatibility* device:
                            //   this.compatibilityMode = !device.features.has("core-features-and-limits");
                            //   if (this.compatibilityMode) renderer._samples = 0;
                            // Answering it wrongly is not a missing feature, it is a silently reduced
                            // renderer — MSAA off outright, plus different depth-texture, MRT-blending and
                            // shader texture paths. It was absent here, so every native game has been
                            // drawing single-sampled with `antialias: true` accepted and ignored.
                            if (featureName == "core-features-and-limits") {
#if MYSTRAL_HAS_CORE_FEATURES_AND_LIMITS
                                if (wgpuDeviceHasFeature(state->device, WGPUFeatureName_CoreFeaturesAndLimits))
                                    return state->engine->newBoolean(true);
#endif
                                // Answer about the device, not about the header. Compatibility mode is a
                                // feature *level* a caller opts into; this runtime never requests one, so
                                // every device it creates is a core device. wgpu-native has no such mode
                                // at all and no enum for it, and this Dawn build carries the enum without
                                // reporting it. Saying "false" because an enum went unreported told
                                // three.js the opposite of the truth.
                                return state->engine->newBoolean(true);
                            }
                            // This Dawn has no Undefined member; 0 is outside the enum's values
                            // and never a valid feature, so it stands in as the sentinel.
                            WGPUFeatureName feature = jsFeatureNameToWGPU(featureName);
                            if (feature == static_cast<WGPUFeatureName>(0)) return state->engine->newBoolean(false);
                            return state->engine->newBoolean(wgpuDeviceHasFeature(state->device, feature) != 0);
}

static js::JSValueHandle handleGpuDeviceDestroy(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>&) {
                            std::cout << "[WebGPU] device.destroy(): teardown is owned by the host"
                                      << std::endl;
                            return state->engine->newUndefined();
}

static js::JSValueHandle handleGpuQueueOnSubmittedWorkDone(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args) {
                            // The promise must cover every write enqueued before it was created,
                            // including ones still sitting in the staging batch.
                            flushUploadStaging(state);
                            auto* data = new QueueWorkDoneData();
#if WGPU_USES_CALLBACK_INFO_PATTERN
                            WGPUQueueWorkDoneCallbackInfo callbackInfo = {};
                            callbackInfo.mode = WGPUCallbackMode_AllowSpontaneous;
                            callbackInfo.callback = onQueueWorkDone;
                            callbackInfo.userdata1 = data;
                            callbackInfo.userdata2 = nullptr;
                            (void)wgpuQueueOnSubmittedWorkDone(state->queue, callbackInfo);
#else
                            wgpuQueueOnSubmittedWorkDone(state->queue, onQueueWorkDone, data);
#endif
                            if (!waitForWebGpuCallback(state, data)) {
                                releaseCallbackData(data);
                                return rejectedPromise(state,
                                    "GPUQueue.onSubmittedWorkDone timed out waiting for native completion.",
                                    "onSubmittedWorkDone-timeout"
                                );
                            }
                            const WGPUQueueWorkDoneStatus status = data->status;
                            const std::string nativeMessage = data->message;
                            releaseCallbackData(data);
                            if (status != WGPUQueueWorkDoneStatus_Success) {
                                std::string message = "GPUQueue.onSubmittedWorkDone failed with native status "
                                    + std::to_string(static_cast<int>(status));
                                if (!nativeMessage.empty()) message += ": " + nativeMessage;
                                return rejectedPromise(state, message, "onSubmittedWorkDone-error");
                            }
                            return resolvedPromise(state, "undefined", "onSubmittedWorkDone-success");
}

/** An upload this slow is what the next present fences on. */
constexpr uint64_t kSlowTextureUploadNs = 50'000'000;



static js::JSValueHandle handleGpuQueueCopyExternalImageToTexture(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args) {
                            if (args.size() < 3) {
                                state->engine->throwException("copyExternalImageToTexture requires source, destination, and copySize");
                                return state->engine->newUndefined();
                            }
                            // Parse source (ImageBitmap-like object or canvas element)
                            auto source = args[0];
                            auto sourceObj = state->engine->getProperty(source, "source");
                            if (state->engine->isUndefined(sourceObj)) {
                                sourceObj = source; // source might be passed directly
                            }
                            // Parse flipY option (default false per WebGPU spec)
                            bool flipY = false;
                            auto flipYProp = state->engine->getProperty(source, "flipY");
                            if (!state->engine->isUndefined(flipYProp)) {
                                flipY = state->engine->toBoolean(flipYProp);
                            }
                            // Parse destination.premultipliedAlpha (default false per WebGPU spec).
                            // PixiJS sets this true so its NORMAL blend (ONE, ONE_MINUS_SRC_ALPHA)
                            // produces correct results. Our PNG decoder returns straight alpha, so
                            // when the destination requests premultiplied we must multiply RGB by
                            // A/255 on the fly. Without this, pixels with 0<a<255 and color>0 render
                            // too bright / with color halos.
                            bool premultipliedAlpha = false;
                            {
                                auto premulProp = state->engine->getProperty(args[1], "premultipliedAlpha");
                                if (!state->engine->isUndefined(premulProp)) {
                                    premultipliedAlpha = state->engine->toBoolean(premulProp);
                                }
                            }
                            int imgWidth = 0;
                            int imgHeight = 0;
                            size_t dataSize = 0;
                            void* dataPtr = nullptr;
                            // Try to get data from ImageBitmap
                            auto imageData = state->engine->getProperty(sourceObj, "_data");
                            if (!state->engine->isUndefined(imageData)) {
                                // Standard ImageBitmap with _data
                                imgWidth = (int)state->engine->toNumber(state->engine->getProperty(sourceObj, "width"));
                                imgHeight = (int)state->engine->toNumber(state->engine->getProperty(sourceObj, "height"));
                                dataPtr = state->engine->getArrayBufferData(imageData, &dataSize);
                            } else {
                                // Check if it's a canvas element
                                auto tagName = state->engine->getProperty(sourceObj, "tagName");
                                std::string tagNameStr = state->engine->isUndefined(tagName) ? "" : state->engine->toString(tagName);
                                if (tagNameStr == "CANVAS" || tagNameStr == "canvas") {
                                    // Get the canvas ID from private data or property
                                    auto canvasIdProp = state->engine->getProperty(sourceObj, "_offscreenCanvasId");
                                    if (!state->engine->isUndefined(canvasIdProp)) {
                                        int canvasId = (int)state->engine->toNumber(canvasIdProp);
                                        auto it = state->canvas2D.offscreenCanvases.find(canvasId);
                                        if (it != state->canvas2D.offscreenCanvases.end() && it->second->hasContext2d) {
                                            // Get pixel data from the 2D context
                                            auto ctx2dHandle = it->second->context2d;
                                            auto nativeCtx = static_cast<canvas::Canvas2DContext*>(state->engine->getPrivateData(ctx2dHandle));
                                            if (nativeCtx) {
                                                imgWidth = it->second->width;
                                                imgHeight = it->second->height;
                                                dataPtr = const_cast<void*>(static_cast<const void*>(nativeCtx->getPixelData()));
                                                dataSize = nativeCtx->getPixelDataSize();
                                            }
                                        }
                                    }
                                }
                                // Check if it's already a 2D context (has getImageData method or _contextType)
                                auto contextType = state->engine->getProperty(sourceObj, "_contextType");
                                if (!state->engine->isUndefined(contextType)) {
                                    std::string ctxTypeStr = state->engine->toString(contextType);
                                    if (ctxTypeStr == "2d") {
                                        // It's a 2D context, get the canvas and then get pixel data
                                        auto canvas = state->engine->getProperty(sourceObj, "canvas");
                                        if (!state->engine->isUndefined(canvas)) {
                                            auto canvasIdProp = state->engine->getProperty(canvas, "_offscreenCanvasId");
                                            if (!state->engine->isUndefined(canvasIdProp)) {
                                                int canvasId = (int)state->engine->toNumber(canvasIdProp);
                                                auto it = state->canvas2D.offscreenCanvases.find(canvasId);
                                                if (it != state->canvas2D.offscreenCanvases.end() &&
                                                    it->second->hasContext2d) {
                                                    auto nativeCtx = static_cast<canvas::Canvas2DContext*>(state->engine->getPrivateData(sourceObj));
                                                    if (nativeCtx) {
                                                        imgWidth = it->second->width;
                                                        imgHeight = it->second->height;
                                                        dataPtr = const_cast<void*>(static_cast<const void*>(nativeCtx->getPixelData()));
                                                        dataSize = nativeCtx->getPixelDataSize();
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            if (!dataPtr || dataSize == 0) {
                                // Try to get width/height anyway for better error message
                                auto widthProp = state->engine->getProperty(sourceObj, "width");
                                auto heightProp = state->engine->getProperty(sourceObj, "height");
                                if (!state->engine->isUndefined(widthProp)) imgWidth = (int)state->engine->toNumber(widthProp);
                                if (!state->engine->isUndefined(heightProp)) imgHeight = (int)state->engine->toNumber(heightProp);
                                std::cerr << "[WebGPU] copyExternalImageToTexture: unsupported source type, width=" << imgWidth << ", height=" << imgHeight << std::endl;
                                // Return silently instead of throwing - PixiJS might be able to continue
                                return state->engine->newUndefined();
                            }
                            // Parse destination
                            auto destination = args[1];
                            auto textureObj = state->engine->getProperty(destination, "texture");
                            WGPUTexture texture = (WGPUTexture)state->engine->getPrivateData(textureObj);
                            if (!texture) {
                                state->engine->throwException("copyExternalImageToTexture: invalid texture");
                                return state->engine->newUndefined();
                            }
                            // Detect the destination texture format. In a real browser,
                            // copyExternalImageToTexture converts the source's RGBA pixels into the
                            // destination's format; we upload bytes verbatim via writeTexture, so for
                            // BGRA8 destinations we must swap the R/B channels ourselves. Our
                            // ImageBitmap data is always RGBA (stb_image / WebPDecodeRGBA), but PixiJS
                            // v8's TextureSource.defaultOptions.format is "bgra8unorm", so every
                            // Texture.from(imageBitmap) lands here — without the swap, red and blue
                            // come out transposed.
                            bool swapRB = false;
                            {
                                auto fmtProp = state->engine->getProperty(textureObj, "format");
                                if (!state->engine->isUndefined(fmtProp)) {
                                    std::string fmt = state->engine->toString(fmtProp);
                                    swapRB = (fmt == "bgra8unorm" || fmt == "bgra8unorm-srgb");
                                }
                            }
                            // Optional mipLevel and origin
                            uint32_t mipLevel = 0;
                            auto mipLevelVal = state->engine->getProperty(destination, "mipLevel");
                            if (!state->engine->isUndefined(mipLevelVal)) {
                                mipLevel = (uint32_t)state->engine->toNumber(mipLevelVal);
                            }
                            uint32_t originX = 0, originY = 0, originZ = 0;
                            auto originVal = state->engine->getProperty(destination, "origin");
                            if (!state->engine->isUndefined(originVal)) {
                                if (state->engine->isArray(originVal)) {
                                    originX = (uint32_t)state->engine->toNumber(state->engine->getPropertyIndex(originVal, 0));
                                    originY = (uint32_t)state->engine->toNumber(state->engine->getPropertyIndex(originVal, 1));
                                    originZ = (uint32_t)state->engine->toNumber(state->engine->getPropertyIndex(originVal, 2));
                                }
                            }
                            // Parse copySize
                            auto sizeVal = args[2];
                            uint32_t width = imgWidth, height = imgHeight, depthOrArrayLayers = 1;
                            if (state->engine->isArray(sizeVal)) {
                                width = (uint32_t)state->engine->toNumber(state->engine->getPropertyIndex(sizeVal, 0));
                                height = (uint32_t)state->engine->toNumber(state->engine->getPropertyIndex(sizeVal, 1));
                                auto depthVal = state->engine->getPropertyIndex(sizeVal, 2);
                                if (!state->engine->isUndefined(depthVal)) {
                                    depthOrArrayLayers = (uint32_t)state->engine->toNumber(depthVal);
                                }
                            } else if (!state->engine->isUndefined(sizeVal)) {
                                auto widthVal = state->engine->getProperty(sizeVal, "width");
                                auto heightVal = state->engine->getProperty(sizeVal, "height");
                                if (!state->engine->isUndefined(widthVal)) width = (uint32_t)state->engine->toNumber(widthVal);
                                if (!state->engine->isUndefined(heightVal)) height = (uint32_t)state->engine->toNumber(heightVal);
                            }
                            // Handle flipY, premultipliedAlpha, and/or BGRA channel swap by writing
                            // into a staging copy. RGBA8 only (matches the hardcoded bytesPerRow below).
                            std::vector<uint8_t> stagingData;
                            void* uploadDataPtr = dataPtr;
                            if ((flipY || premultipliedAlpha || swapRB) && dataPtr && imgHeight > 0 && imgWidth > 0) {
                                size_t bytesPerRow = (size_t)imgWidth * 4;
                                stagingData.resize(dataSize);
                                const uint8_t* srcData = static_cast<const uint8_t*>(dataPtr);
                                for (int y = 0; y < imgHeight; y++) {
                                    const uint8_t* srcRow = srcData + (flipY ? (imgHeight - 1 - y) : y) * bytesPerRow;
                                    uint8_t* dstRow = stagingData.data() + (size_t)y * bytesPerRow;
                                    if (premultipliedAlpha || swapRB) {
                                        for (int x = 0; x < imgWidth; x++) {
                                            uint32_t r = srcRow[x * 4 + 0];
                                            uint32_t g = srcRow[x * 4 + 1];
                                            uint32_t b = srcRow[x * 4 + 2];
                                            uint32_t a = srcRow[x * 4 + 3];
                                            if (premultipliedAlpha) {
                                                // (v * a + 127) / 255 rounds correctly without a divide instruction
                                                r = (r * a + 127) / 255;
                                                g = (g * a + 127) / 255;
                                                b = (b * a + 127) / 255;
                                            }
                                            // BGRA8 destinations read byte 0 as B and byte 2 as R, so emit
                                            // the channels swapped; RGBA8 destinations get them in order.
                                            dstRow[x * 4 + 0] = (uint8_t)(swapRB ? b : r);
                                            dstRow[x * 4 + 1] = (uint8_t)g;
                                            dstRow[x * 4 + 2] = (uint8_t)(swapRB ? r : b);
                                            dstRow[x * 4 + 3] = (uint8_t)a;
                                        }
                                    } else {
                                        std::memcpy(dstRow, srcRow, bytesPerRow);
                                    }
                                }
                                uploadDataPtr = stagingData.data();
                                if (state->verboseLogging) {
                                    std::cout << "[WebGPU] copyExternalImageToTexture: "
                                              << (flipY ? "flipY " : "")
                                              << (premultipliedAlpha ? "premultiplyAlpha " : "")
                                              << (swapRB ? "swapRB" : "")
                                              << std::endl;
                                }
                            }
                            // Use writeTexture internally (same effect as copyExternalImageToTexture)
                            WGPUImageCopyTexture_Compat destCopy = {};
                            destCopy.texture = texture;
                            destCopy.mipLevel = mipLevel;
                            destCopy.origin = {originX, originY, originZ};
                            destCopy.aspect = WGPUTextureAspect_All;
                            WGPUTextureDataLayout_Compat layout = {};
                            layout.offset = 0;
                            layout.bytesPerRow = imgWidth * 4;  // RGBA
                            layout.rowsPerImage = imgHeight;
                            WGPUExtent3D copySize = {width, height, depthOrArrayLayers};
                            const auto uploadBegin = std::chrono::steady_clock::now();
                            wgpuQueueWriteTexture(state->queue, &destCopy, uploadDataPtr, dataSize, &layout, &copySize);
                            const uint64_t uploadNs = static_cast<uint64_t>(
                                std::chrono::duration_cast<std::chrono::nanoseconds>(
                                    std::chrono::steady_clock::now() - uploadBegin).count());
                            if (uploadNs >= kSlowTextureUploadNs) {
                                std::cout << "TN_SLOW_TEXTURE_UPLOAD:{\"ms\":" << static_cast<double>(uploadNs) / 1e6
                                          << ",\"mb\":" << static_cast<double>(dataSize) / 1048576.0
                                          << ",\"w\":" << width << ",\"h\":" << height << "}" << std::endl;
                            }
                            if (state->verboseLogging) std::cout << "[WebGPU] copyExternalImageToTexture: " << width << "x" << height << (flipY ? " (flipY)" : "") << std::endl;
                            return state->engine->newUndefined();
}

static js::JSValueHandle handleGpuQueueWriteTexture(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args) {
                            mystral::StallScope stall(mystral::StallSegment::TextureUpload);
                            if (args.size() < 4) {
                                state->engine->throwException("writeTexture requires destination, data, dataLayout, and size");
                                return state->engine->newUndefined();
                            }
                            // Parse destination {texture, mipLevel?, origin?, aspect?}
                            auto destination = args[0];
                            auto textureHandle = state->engine->getProperty(destination, "texture");
                            WGPUTexture texture = (WGPUTexture)state->engine->getPrivateData(textureHandle);
                            if (!texture) {
                                state->engine->throwException("writeTexture: invalid texture");
                                return state->engine->newUndefined();
                            }
                            auto mipLevelVal = state->engine->getProperty(destination, "mipLevel");
                            uint32_t mipLevel = state->engine->isUndefined(mipLevelVal) ? 0 : (uint32_t)state->engine->toNumber(mipLevelVal);
                            // Parse origin
                            auto originVal = state->engine->getProperty(destination, "origin");
                            uint32_t originX = 0, originY = 0, originZ = 0;
                            if (!state->engine->isUndefined(originVal)) {
                                auto lengthProp = state->engine->getProperty(originVal, "length");
                                if (!state->engine->isUndefined(lengthProp)) {
                                    // Array format
                                    int len = (int)state->engine->toNumber(lengthProp);
                                    if (len >= 1) originX = (uint32_t)state->engine->toNumber(state->engine->getPropertyIndex(originVal, 0));
                                    if (len >= 2) originY = (uint32_t)state->engine->toNumber(state->engine->getPropertyIndex(originVal, 1));
                                    if (len >= 3) originZ = (uint32_t)state->engine->toNumber(state->engine->getPropertyIndex(originVal, 2));
                                } else {
                                    // Object format
                                    auto x = state->engine->getProperty(originVal, "x");
                                    auto y = state->engine->getProperty(originVal, "y");
                                    auto z = state->engine->getProperty(originVal, "z");
                                    if (!state->engine->isUndefined(x)) originX = (uint32_t)state->engine->toNumber(x);
                                    if (!state->engine->isUndefined(y)) originY = (uint32_t)state->engine->toNumber(y);
                                    if (!state->engine->isUndefined(z)) originZ = (uint32_t)state->engine->toNumber(z);
                                }
                            }
                            // Get ArrayBuffer data
                            size_t dataSize = 0;
                            void* dataPtr = state->engine->getArrayBufferData(args[1], &dataSize);
                            if (!dataPtr || dataSize == 0) {
                                state->engine->throwException("writeTexture: invalid data");
                                return state->engine->newUndefined();
                            }
                            // Parse size FIRST (need height for rowsPerImage default)
                            auto sizeVal = args[3];
                            uint32_t width = 1, height = 1, depthOrArrayLayers = 1;
                            auto lengthProp = state->engine->getProperty(sizeVal, "length");
                            if (!state->engine->isUndefined(lengthProp)) {
                                int len = (int)state->engine->toNumber(lengthProp);
                                if (len >= 1) width = (uint32_t)state->engine->toNumber(state->engine->getPropertyIndex(sizeVal, 0));
                                if (len >= 2) height = (uint32_t)state->engine->toNumber(state->engine->getPropertyIndex(sizeVal, 1));
                                if (len >= 3) depthOrArrayLayers = (uint32_t)state->engine->toNumber(state->engine->getPropertyIndex(sizeVal, 2));
                            } else {
                                auto w = state->engine->getProperty(sizeVal, "width");
                                auto h = state->engine->getProperty(sizeVal, "height");
                                auto d = state->engine->getProperty(sizeVal, "depthOrArrayLayers");
                                if (!state->engine->isUndefined(w)) width = (uint32_t)state->engine->toNumber(w);
                                if (!state->engine->isUndefined(h)) height = (uint32_t)state->engine->toNumber(h);
                                if (!state->engine->isUndefined(d)) depthOrArrayLayers = (uint32_t)state->engine->toNumber(d);
                            }
                            // Parse dataLayout {offset?, bytesPerRow, rowsPerImage?}
                            auto dataLayout = args[2];
                            auto layoutOffsetVal = state->engine->getProperty(dataLayout, "offset");
                            uint64_t layoutOffset = state->engine->isUndefined(layoutOffsetVal) ? 0 : (uint64_t)state->engine->toNumber(layoutOffsetVal);
                            uint32_t bytesPerRow = (uint32_t)state->engine->toNumber(state->engine->getProperty(dataLayout, "bytesPerRow"));
                            auto rowsPerImageVal = state->engine->getProperty(dataLayout, "rowsPerImage");
                            // rowsPerImage must be >= height for 2D textures (wgpu validation requirement)
                            uint32_t rowsPerImage = state->engine->isUndefined(rowsPerImageVal) ? height : (uint32_t)state->engine->toNumber(rowsPerImageVal);
                            if (rowsPerImage == 0) rowsPerImage = height;
                            // Create copy structures
                            WGPUImageCopyTexture_Compat destCopy = {};
                            destCopy.texture = texture;
                            destCopy.mipLevel = mipLevel;
                            destCopy.origin = {originX, originY, originZ};
                            destCopy.aspect = WGPUTextureAspect_All;
                            WGPUTextureDataLayout_Compat layout = {};
                            layout.offset = layoutOffset;
                            layout.bytesPerRow = bytesPerRow;
                            layout.rowsPerImage = rowsPerImage;
                            WGPUExtent3D copySize = {width, height, depthOrArrayLayers};
                            // Write texture
                            flushUploadStaging(state);
                            wgpuQueueWriteTexture(state->queue, &destCopy, (uint8_t*)dataPtr + layoutOffset, dataSize - layoutOffset, &layout, &copySize);
                            if (state->verboseLogging) std::cout << "[WebGPU] writeTexture: " << width << "x" << height << " (" << dataSize << " bytes)" << std::endl;
                            return state->engine->newUndefined();
}

static js::JSValueHandle handleGpuQueueWriteBuffer(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args) {
                            mystral::StallScope stall(mystral::StallSegment::BufferUpload);
                            if (args.size() < 3) {
                                state->engine->throwException("writeBuffer requires buffer, offset, and data");
                                return state->engine->newUndefined();
                            }
#if TN_ANDROID_JS_PROFILE
                            const auto profileStart = beginProfiledBinding();
#endif
                            WGPUBuffer buffer = (WGPUBuffer)state->engine->getPrivateData(args[0]);
                            const double offsetValue = state->engine->toNumber(args[1]);
                            if (!std::isfinite(offsetValue) || offsetValue < 0 || std::floor(offsetValue) != offsetValue ||
                                static_cast<uint64_t>(offsetValue) % 4 != 0) {
                                state->engine->throwException("writeBuffer: buffer offset must be a non-negative multiple of 4");
                                return state->engine->newUndefined();
                            }
                            const uint64_t offset = static_cast<uint64_t>(offsetValue);
                            // Get ArrayBuffer data
                            size_t dataSize = 0;
                            void* dataPtr = state->engine->getArrayBufferData(args[2], &dataSize);
                            if (!dataPtr || dataSize == 0) {
                                state->engine->throwException("writeBuffer: invalid data");
                                return state->engine->newUndefined();
                            }
                            // WebGPU expresses dataOffset/size in elements for a TypedArray,
                            // but in bytes for ArrayBuffer and DataView inputs.
                            size_t bytesPerElement = 1;
                            auto bytesPerElementValue = state->engine->getProperty(args[2], "BYTES_PER_ELEMENT");
                            if (!state->engine->isUndefined(bytesPerElementValue)) {
                                const double value = state->engine->toNumber(bytesPerElementValue);
                                if (value > 0) bytesPerElement = static_cast<size_t>(value);
                            }
                            const double dataOffsetValue = args.size() > 3 ? state->engine->toNumber(args[3]) : 0;
                            const double sizeValue = args.size() > 4 ? state->engine->toNumber(args[4]) : -1;
                            if (!std::isfinite(dataOffsetValue) || dataOffsetValue < 0 ||
                                std::floor(dataOffsetValue) != dataOffsetValue ||
                                (args.size() > 4 && (!std::isfinite(sizeValue) || sizeValue < 0 ||
                                                    std::floor(sizeValue) != sizeValue))) {
                                state->engine->throwException("writeBuffer: data offset and size must be non-negative");
                                return state->engine->newUndefined();
                            }
                            const size_t dataOffset = static_cast<size_t>(dataOffsetValue) * bytesPerElement;
                            const size_t writeSize = args.size() > 4
                                ? static_cast<size_t>(sizeValue) * bytesPerElement
                                : (dataOffset <= dataSize ? dataSize - dataOffset : 0);
                            if (dataOffset > dataSize || writeSize > dataSize - dataOffset) {
                                state->engine->throwException("writeBuffer: source range exceeds the supplied buffer view");
                                return state->engine->newUndefined();
                            }
                            const uint8_t* source = static_cast<uint8_t*>(dataPtr) + dataOffset;
                            if (buffer && state->queue) {
                                const size_t alignedWriteSize = (writeSize + 3) & ~size_t(3);
                                bool staged = false;
#if defined(MYSTRAL_WEBGPU_WGPU) && TN_WEBGPU_UPLOAD_STAGING
                                staged = stageWriteInUploadStaging(
                                    state, buffer, offset, source, writeSize, alignedWriteSize);
#endif
                                if (!staged) {
                                    if (alignedWriteSize == writeSize) {
                                        wgpuQueueWriteBuffer(state->queue, buffer, offset, source, writeSize);
                                    } else {
                                        // Three pads destination attribute buffers to four bytes.
                                        // Mirror browser implementations by zero-padding the final
                                        // partial element before crossing the native WebGPU ABI.
                                        std::vector<uint8_t> alignedData(alignedWriteSize, 0);
                                        std::memcpy(alignedData.data(), source, writeSize);
                                        wgpuQueueWriteBuffer(state->queue, buffer, offset, alignedData.data(), alignedData.size());
                                    }
                                }
                            }
#if TN_ANDROID_JS_PROFILE
                            const auto writeBufferNs =
                                endProfiledBinding(state, ProfiledRenderCommand::WriteBuffer, profileStart);
                            if (buffer && state->queue) {
                                state->profiling.androidJsNativeProfile.writeBufferBytes += writeSize;
                                state->profiling.androidJsNativeProfile.writeBufferTargets.insert(buffer);
                                const auto bufferInfo = state->registries.androidJsProfileBufferRegistry.find(buffer);
                                if (bufferInfo != state->registries.androidJsProfileBufferRegistry.end()) {
                                    const auto usage = profiledBufferUsage(bufferInfo->second.usage);
                                    const auto usageIndex = static_cast<size_t>(usage);
                                    state->profiling.androidJsNativeProfile.writeBufferUsageCalls[usageIndex] += 1;
                                    state->profiling.androidJsNativeProfile.writeBufferUsageBytes[usageIndex] +=
                                        writeSize;
                                    state->profiling.androidJsNativeProfile.writeBufferUsageNs[usageIndex] +=
                                        writeBufferNs;
                                    if (offset == 0 && writeSize == bufferInfo->second.size) {
                                        state->profiling.androidJsNativeProfile.writeBufferFullCalls += 1;
                                    } else {
                                        state->profiling.androidJsNativeProfile.writeBufferPartialCalls += 1;
                                    }
                                }
                                if (writeSize <= 256) {
                                    state->profiling.androidJsNativeProfile.writeBufferSmallCalls += 1;
                                    state->profiling.androidJsNativeProfile.writeBufferSmallNs += writeBufferNs;
                                } else if (writeSize <= 4096) {
                                    state->profiling.androidJsNativeProfile.writeBufferMediumCalls += 1;
                                    state->profiling.androidJsNativeProfile.writeBufferMediumNs += writeBufferNs;
                                } else {
                                    state->profiling.androidJsNativeProfile.writeBufferLargeCalls += 1;
                                    state->profiling.androidJsNativeProfile.writeBufferLargeNs += writeBufferNs;
                                }
                            }
#endif
                            return state->engine->newUndefined();
}

static js::JSValueHandle handleGpuQueueSubmit(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args) {
                            mystral::StallScope stall(mystral::StallSegment::QueueSubmit);
                            if (args.empty()) {
                                return state->engine->newUndefined();
                            }
                            // Get command buffers array and submit them
                            auto cmdBuffersArray = args[0];
                            // Get array length
                            auto lengthProp = state->engine->getProperty(cmdBuffersArray, "length");
                            int length = (int)state->engine->toNumber(lengthProp);
                            // Collect command buffers
                            std::vector<WGPUCommandBuffer> cmdBuffers;
                            for (int i = 0; i < length; i++) {
                                auto cmdBufferHandle = state->engine->getPropertyIndex(cmdBuffersArray, i);
                                WGPUCommandBuffer cmdBuffer = (WGPUCommandBuffer)state->engine->getPrivateData(cmdBufferHandle);
                                // A NULL entry used to be dropped silently, which turns "the GPU never got
                                // this frame's work" into a rendering mystery instead of an error, and
                                // leaves the caller believing it submitted.
                                if (!requireHandle(state->engine, cmdBuffer, "queue.submit",
                                                   "commandBuffers[" + std::to_string(i) + "]"))
                                    return state->engine->newUndefined();
                                cmdBuffers.push_back(cmdBuffer);
                            }
                            // Submit user command buffers first
                            state->profiling.submitCount++;
#if TN_ANDROID_JS_PROFILE
                            state->profiling.androidJsNativeProfile.submits += 1;
#endif
#if TN_ANDROID_JS_PROFILE
                            uint64_t submitPollNs = 0;
                            uint64_t presentNs = 0;
#endif
                            if (!cmdBuffers.empty() && state->queue) {
#if TN_ANDROID_JS_PROFILE
                                const auto submitStart = std::chrono::steady_clock::now();
#endif
                                // Staged uniform writes must land on the GPU before the command
                                // buffers that read them; queue FIFO does the rest.
                                flushUploadStaging(state);
                                wgpuQueueSubmit(state->queue, cmdBuffers.size(), cmdBuffers.data());
#if TN_ANDROID_JS_PROFILE
                                submitPollNs = static_cast<uint64_t>(
                                    std::chrono::duration_cast<std::chrono::nanoseconds>(
                                        std::chrono::steady_clock::now() - submitStart
                                    ).count()
                                );
#endif
                                // Release command buffers after submission (they're consumed by submit)
                                for (auto cmdBuf : cmdBuffers) {
                                    wgpuCommandBufferRelease(cmdBuf);
                                }
                                // Tick to flush GPU work
#if TN_ANDROID_JS_PROFILE
                                const auto pollStart = std::chrono::steady_clock::now();
#endif
#if defined(MYSTRAL_WEBGPU_DAWN)
                                wgpuDeviceTick(state->device);
#elif defined(MYSTRAL_WEBGPU_WGPU)
                                wgpuDevicePoll(state->device, false, nullptr);
#endif
#if TN_ANDROID_JS_PROFILE
                                submitPollNs += static_cast<uint64_t>(
                                    std::chrono::duration_cast<std::chrono::nanoseconds>(
                                        std::chrono::steady_clock::now() - pollStart
                                    ).count()
                                );
#endif
                                if (state->verboseLogging)
                                    std::cout << "[WebGPU] Submit #" << state->profiling.submitCount << ": "
                                              << cmdBuffers.size() << " command buffers, currentTexture="
                                              << (void*)state->presentation.currentTexture << std::endl;
                            } else {
                                if (state->verboseLogging)
                                    std::cout << "[WebGPU] Submit #" << state->profiling.submitCount
                                              << ": EMPTY (length=" << length
                                              << "), currentTexture=" << (void*)state->presentation.currentTexture
                                              << std::endl;
                            }
                            // Mark the frame ready to present rather than presenting here.
                            //
                            // A frame can submit more than once: three.js renders the world, then
                            // the framework renders `ctx.canvasLayer` as an overlay pass, and each
                            // `renderer.render()` ends in its own submit. Presenting per submit gave
                            // each of those its own swapchain image, so only the first reached the
                            // display and every overlay was silently dropped — the framework's own
                            // loading screen and any game HUD on the canvas layer drew nothing on
                            // native while working on web. presentPendingSurface() runs once per
                            // frame from endDawnFrame(), after every rAF callback has returned.
                            if (state->surface && state->presentation.currentTexture &&
                                state->presentation.surfaceRenderPassEnded) {
                                state->presentation.framePresentPending = true;
                            }
#if TN_ANDROID_JS_PROFILE
                            // The present happens after this submit returns, from
                            // presentPendingSurface(); report the previous frame's present on this
                            // frame's first submit only, so per-frame sums count it once.
                            if (!state->profiling.presentReportedSinceLastPresent) {
                                presentNs = state->profiling.lastPresentNs;
                                state->profiling.presentReportedSinceLastPresent = true;
                            }
#endif
                            return state->engine->newUndefined();
}


// GPUSupportedLimits answered from the real adapter/device: the device is created with the
// adapter's limits (context.cpp), so a hand-written subset misreports what the GPU allows and
// hides limits (maxBufferSize, compute workgroup sizes) that games check before allocating.
#define TN_WGPU_LIMIT_FIELDS(X) \
    X(maxTextureDimension1D) X(maxTextureDimension2D) X(maxTextureDimension3D) X(maxTextureArrayLayers) \
    X(maxBindGroups) X(maxBindingsPerBindGroup) X(maxDynamicUniformBuffersPerPipelineLayout) \
    X(maxDynamicStorageBuffersPerPipelineLayout) X(maxSampledTexturesPerShaderStage) X(maxSamplersPerShaderStage) \
    X(maxStorageBuffersPerShaderStage) X(maxStorageTexturesPerShaderStage) X(maxUniformBuffersPerShaderStage) \
    X(maxUniformBufferBindingSize) X(maxStorageBufferBindingSize) X(minUniformBufferOffsetAlignment) \
    X(minStorageBufferOffsetAlignment) X(maxVertexBuffers) X(maxBufferSize) X(maxVertexAttributes) \
    X(maxVertexBufferArrayStride) X(maxColorAttachments) X(maxColorAttachmentBytesPerSample) \
    X(maxComputeWorkgroupStorageSize) X(maxComputeInvocationsPerWorkgroup) X(maxComputeWorkgroupSizeX) \
    X(maxComputeWorkgroupSizeY) X(maxComputeWorkgroupSizeZ) X(maxComputeWorkgroupsPerDimension)
template <typename Handle, typename Query>
static js::JSValueHandle realLimits(BindingsState* state, Handle handle, Query query) {
    auto out = state->engine->newObject();
#if defined(MYSTRAL_WEBGPU_DAWN) || defined(MYSTRAL_WEBGPU_WGPU_MODERN)
    WGPULimits limits = {};
    if (query(handle, &limits) != WGPUStatus_Success) return out;
#define TN_WGPU_LIMIT(name) state->engine->setProperty(out, #name, state->engine->newNumber(static_cast<double>(limits.name)));
#elif defined(MYSTRAL_WEBGPU_WGPU)
    WGPUSupportedLimits supported = {};
    if (!query(handle, &supported)) return out;
    const WGPULimits& limits = supported.limits;
#define TN_WGPU_LIMIT(name) state->engine->setProperty(out, #name, state->engine->newNumber(static_cast<double>(limits.name)));
#else
#define TN_WGPU_LIMIT(name)
    (void)handle; (void)query;
#endif
    TN_WGPU_LIMIT_FIELDS(TN_WGPU_LIMIT)
#undef TN_WGPU_LIMIT
    return out;
}

static js::JSValueHandle handleGpuAdapterRequestDevice(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args) {
                    // Return a device object wrapping our native device
                    auto device = createNativeWrapper(state, "GPUDevice", state->device);
                    // device.queue
                    auto queue = createNativeWrapper(state, "GPUQueue", state->queue);
                    // queue.submit(commandBuffers)
                    if (!installBindingTable(state->engine, state, bindingTable({
                        {"GPUQueue", "submit", 0, nullptr,
                        &handleGpuQueueSubmit
                    , queue},
                    // queue.writeBuffer(buffer, offset, data, dataOffset?, size?)
                                            {"GPUQueue", "writeBuffer", 0, nullptr,
                        &handleGpuQueueWriteBuffer
                    , queue},
                    // queue.writeTexture(destination, data, dataLayout, size)
                                            {"GPUQueue", "writeTexture", 0, nullptr,
                        &handleGpuQueueWriteTexture
                    , queue},
                    // queue.copyExternalImageToTexture(source, destination, copySize)
                    // Standard WebGPU way to upload ImageBitmap to texture
                                            {"GPUQueue", "copyExternalImageToTexture", 0, nullptr,
                        &handleGpuQueueCopyExternalImageToTexture
                    , queue},
                    // queue.onSubmittedWorkDone() - returns Promise that resolves when GPU work is done
                                            {"GPUQueue", "onSubmittedWorkDone", 0, nullptr,
                        &handleGpuQueueOnSubmittedWorkDone
                    , queue}}))) return state->engine->newUndefined();
                    state->engine->setProperty(device, "queue", queue);
                    // device.destroy() - part of the GPUDevice interface, and three.js calls it from
                    // `WebGPURenderer.dispose()`. Without it every clean teardown on a native host
                    // throws `this.device.destroy is not a function`, which reads as a crash at the
                    // end of an otherwise successful run. Releasing the wgpu device here would pull
                    // the surface out from under a host that may still be presenting, so this
                    // reports the call and lets the host own the lifetime.
                    if (!installBindingTable(state->engine, state, bindingTable({
                        {"GPUDevice", "destroy", 0, nullptr,
                        &handleGpuDeviceDestroy
                    , device}}))) return state->engine->newUndefined();
                    // device.limits - expose device limits
                    auto deviceLimits = realLimits(state, state->device, wgpuDeviceGetLimits);
                    state->engine->setProperty(device, "limits", deviceLimits);
                    // device.features - Set-like object with enabled features, answered from the
                    // real device so consumers (three's KTX2Loader.detectSupport among them)
                    // pick transcode targets from actual hardware capability.
                    auto deviceFeatures = state->engine->newArray(0);
                    auto deviceFeaturesBindingHost = state->engine->newObject();
                    if (!installBindingTable(state->engine, state, bindingTable({
                        {"GPUSupportedFeatures", "has", 0, nullptr,
                        &handleGpuDeviceFeaturesHas
                    , deviceFeaturesBindingHost}}))) return state->engine->newUndefined();
                    if (!state->engine->setProperty(
                            deviceFeatures,
                            "has",
                            state->engine->getProperty(deviceFeaturesBindingHost, "has"))) {
                        return state->engine->newUndefined();
                    }
                    state->engine->setProperty(device, "features", deviceFeatures);
                    // device.createBuffer(descriptor)
                    if (!installBindingTable(state->engine, state, bindingTable({
                        {"GPUDevice", "createBuffer", 0, nullptr,
                        &handleGpuDeviceCreateBuffer
                    , device}}))) return state->engine->newUndefined();
                    // device.createShaderModule(descriptor)
                    if (!installBindingTable(state->engine, state, bindingTable({
                        {"GPUDevice", "createShaderModule", 0, nullptr,
                        &handleGpuDeviceCreateShaderModule
                    , device},
                    // device.createRenderPipeline(descriptor)
                                            {"GPUDevice", "createRenderPipeline", 0, nullptr,
                        &handleGpuDeviceCreateRenderPipeline
                    , device},
                    // device.createComputePipeline(descriptor)
                                            {"GPUDevice", "createComputePipeline", 0, nullptr,
                        &handleGpuDeviceCreateComputePipeline
                    , device}}))) return state->engine->newUndefined();
                    // device.createRenderPipelineAsync / createComputePipelineAsync
                    //
                    // Without these, `renderer.compileAsync()` throws "not a function" and every
                    // pipeline is instead built lazily on the draw that first needs it — during
                    // play, where it is a stall the player feels. A Pixel 8 recording measured a
                    // 1,659 ms worst frame with them missing.
                    //
                    // These are the real thing as of PRD-327: the descriptor is read here on the
                    // game thread and the compile runs on a host pool, so `compileAsync` behind a
                    // loading screen no longer freezes the loop it is meant to be hiding. It was
                    // previously the synchronous create wrapped in `Promise.resolve()`, which the
                    // WebGPU specification permits and which bought nothing — the first world
                    // frame still paid 8,038 ms across 105 compiles.
                    if (!installBindingTable(state->engine, state, bindingTable({
                        {"GPUDevice", "createRenderPipelineAsync", 0, nullptr,
                        &handleGpuDeviceCreateRenderPipelineAsync
                    , device},
                                            {"GPUDevice", "createComputePipelineAsync", 0, nullptr,
                        &handleGpuDeviceCreateComputePipelineAsync
                    , device}}))) return state->engine->newUndefined();
                    // device.createCommandEncoder(descriptor?)
                    if (!installBindingTable(state->engine, state, bindingTable({
                        {"GPUDevice", "createCommandEncoder", 0, nullptr,
                        &handleGpuDeviceCreateCommandEncoder
                    , device}}))) return state->engine->newUndefined();
                    // device.createTexture(descriptor)
                    if (!installBindingTable(state->engine, state, bindingTable({
                        {"GPUDevice", "createTexture", 0, nullptr,
                        &handleGpuDeviceCreateTexture
                    , device}}))) return state->engine->newUndefined();
                    // device.createQuerySet(descriptor)
                    if (!installBindingTable(state->engine, state, bindingTable({
                        {"GPUDevice", "createQuerySet", 0, nullptr,
                        &tnWebgpuHandlerCreateQuerySet
                    , device}}))) return state->engine->newUndefined();
                    // device.createSampler(descriptor?)
                    if (!installBindingTable(state->engine, state, bindingTable({
                        {"GPUDevice", "createSampler", 0, nullptr,
                        &handleGpuDeviceCreateSampler
                    , device},
                    // device.createBindGroupLayout(descriptor)
                                            {"GPUDevice", "createBindGroupLayout", 0, nullptr,
                        &handleGpuDeviceCreateBindGroupLayout
                    , device},
                    // device.createBindGroup(descriptor)
                                            {"GPUDevice", "createBindGroup", 0, nullptr,
                        &handleGpuDeviceCreateBindGroup
                    , device},
                    // device.createPipelineLayout(descriptor)
                                            {"GPUDevice", "createPipelineLayout", 0, nullptr,
                        &handleGpuDeviceCreatePipelineLayout
                    , device},
                    // device.createTextureView(texture, descriptor?) - Non-standard helper
                    // Workaround because texture.createView() can't easily access 'this'
                                            {"GPUDevice", "createTextureView", 0, nullptr,
                        &handleGpuDeviceCreateTextureView
                    , device},
                    // device.createRenderBundleEncoder(descriptor)
                    // Used by Three.js for mipmap generation
                                            {"GPUDevice", "createRenderBundleEncoder", 0, nullptr,
                        &handleGpuDeviceCreateRenderBundleEncoder
                    , device}}))) return state->engine->newUndefined();
                    // device.pushErrorScope(filter) - Push an error scope for validation/OOM/internal errors
                    // Used by Three.js for error handling during pipeline creation
                    if (!installBindingTable(state->engine, state, bindingTable({
                        {"GPUDevice", "pushErrorScope", 0, nullptr,
                        &handleGpuDevicePushErrorScope
                    , device},
                    // device.popErrorScope() - Pop an error scope and return Promise<GPUError | null>
                    // Returns Promise<GPUError | null>
                                            {"GPUDevice", "popErrorScope", 0, nullptr,
                        &handleGpuDevicePopErrorScope
                    , device}}))) return state->engine->newUndefined();
                    // device.lost - Promise that resolves when the device is lost
                    // Required by Three.js WebGPU renderer during init
                    // We create a Promise that never resolves (device never lost in normal operation).
                    // evalWithResult evaluates a module, whose result is the module's own evaluation
                    // promise: it resolves at once, so returning it made every `device.lost` consumer
                    // see a lost device. Keep the real promise on the global and read it back.
                    state->engine->evalWithResult(
                        "globalThis.__mystral_device_lost = new Promise(function(resolve) { globalThis.__mystral_device_lost_resolve = resolve; });",
                        "device.lost"
                    );
                    auto deviceLostPromise =
                        state->engine->getProperty(state->engine->getGlobal(), "__mystral_device_lost");
                    state->engine->setProperty(device, "lost", deviceLostPromise);
                    if (!state->profiling.disableFrameOpStreamForTesting) {
                        // Install the production frame recorder after every native method exists.
                        // This ordering is deliberate: shared prototypes return early while wrappers
                        // are built, so pass-local installation was a dead path. The device/queue
                        // entry points are the stable surface that every command must cross through.
                        const auto installer = evalEmbeddedRuntimeScriptWithResult(
                            *state->engine, "frame-op-stream", "frame-op-stream.js");
                        const auto host = state->engine->newObject();
                        state->engine->setProperty(host, "device", device);
                        state->engine->setProperty(host, "queue", queue);
                        // Production leaves selection automatic: an absent property starts on
                        // direct v2 and promotes only when the recorder's bounded heuristics say a
                        // retained plan is useful. TN_FRAME_PLANS=1 is a diagnostic/reference
                        // override that forces the v3 arm; games do not need to set it.
                        if (const char* plans = std::getenv("TN_FRAME_PLANS")) {
                            if (plans[0] == '1' && plans[1] == '\0') {
                                state->engine->setProperty(host, "compiledFramePlans", state->engine->newBoolean(true));
                            }
                        }
                        const auto drain = state->engine->call(
                            installer, state->engine->newUndefined(), {host});
                        if (!drain.ptr || state->engine->isNull(drain) || state->engine->hasException()) {
                            state->engine->throwException("frame op stream: production recorder installation failed");
                            return state->engine->newUndefined();
                        }
                        state->engine->freezeHandle(drain);
                        state->profiling.frameOpStreamDrain = drain;
                    }
                    // Install lifecycle wrappers last: destroy must invalidate the JS buffer
                    // immediately while the recorder still orders backend destruction after submit.
                    {
                        js::JSValueGuard asyncInstaller(
                            *state->engine,
                            evalEmbeddedRuntimeScriptWithResult(
                                *state->engine, "install-async-pipelines",
                                "install-async-pipelines.js"));
                        js::JSValueGuard installed(*state->engine, {});
                        if (asyncInstaller) {
                            js::JSValueGuard thisArg(
                                *state->engine, state->engine->newUndefined());
                            installed.reset(
                                state->engine->call(asyncInstaller.get(), thisArg.get(), {device}));
                        }
                        if (!installed || !state->engine->toBoolean(installed.get())) {
                            state->engine->throwException("failed to install async GPU operations");
                            return state->engine->newUndefined();
                        }
                    }
                    // Return the device directly
                    // await on a non-Promise just returns the value
                    return device;
}

static js::JSValueHandle handleGpuRequestAdapter(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args) {
            // In native runtime, we already have an adapter, so just return a mock adapter object
            auto adapter = state->engine->newObject();
            // Three's renderer reads adapter.info when the engine records a pipeline census. The
            // native adapter is backed by the host's real WGPUAdapter, so expose the same identity
            // fields instead of making the diagnostic report "unavailable" on every native run.
            WGPUAdapterInfo adapterInfo = {};
            wgpuAdapterGetInfo(state->adapter, &adapterInfo);
            auto info = state->engine->newObject();
            state->engine->setProperty(
                info, "architecture", state->engine->newString(WGPU_PRINT_STRING_VIEW(adapterInfo.architecture).c_str()));
            state->engine->setProperty(
                info, "description", state->engine->newString(WGPU_PRINT_STRING_VIEW(adapterInfo.description).c_str()));
            state->engine->setProperty(
                info, "device", state->engine->newString(WGPU_PRINT_STRING_VIEW(adapterInfo.device).c_str()));
            state->engine->setProperty(
                info, "vendor", state->engine->newString(WGPU_PRINT_STRING_VIEW(adapterInfo.vendor).c_str()));
            state->engine->setProperty(adapter, "info", info);
            wgpuAdapterInfoFreeMembers(adapterInfo);
            // adapter.requestDevice()
            if (!installBindingTable(state->engine, state, bindingTable({
                {"GPUAdapter", "requestDevice", 0, nullptr,
                &handleGpuAdapterRequestDevice
            , adapter}}))) return state->engine->newUndefined();
            // adapter.features - Set-like iterable backed by the real adapter feature query
            // Dawn supports indirect-first-instance on Metal which is required for indirect draws
            // with non-zero firstInstance values
            auto features = state->engine->newArray(0);
            auto featuresBindingHost = state->engine->newObject();
            if (!installBindingTable(state->engine, state, bindingTable({
                {"GPUSupportedFeatures", "has", 0, nullptr,
                &handleGpuAdapterFeaturesHas
            , featuresBindingHost}}))) return state->engine->newUndefined();
            if (!state->engine->setProperty(
                    features,
                    "has",
                    state->engine->getProperty(featuresBindingHost, "has"))) {
                return state->engine->newUndefined();
            }
            state->engine->setProperty(features, "size", state->engine->newNumber(1));
            state->engine->setProperty(adapter, "features", features);
            // adapter.limits
            auto limits = realLimits(state, state->adapter, wgpuAdapterGetLimits);
            state->engine->setProperty(adapter, "limits", limits);
            // Return the adapter directly
            // await on a non-Promise just returns the value
            // Three.js: const adapter = await navigator.gpu.requestAdapter()
            // This works whether we return a Promise or the adapter directly
            return adapter;
}

static js::JSValueHandle handleDocumentBodyRemoveChild(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args) {
            return args.empty() ? state->engine->newUndefined() : args[0];
}

static js::JSValueHandle handleDocumentBodyAppendChild(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args) {
            return args.empty() ? state->engine->newUndefined() : args[0];
}

static js::JSValueHandle handleHtmlCanvasElementGetBoundingClientRect(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& a) {
                        // Get dimensions from the main canvas if available
                        auto rect = state->engine->newObject();
                        state->engine->setProperty(rect, "x", state->engine->newNumber(0));
                        state->engine->setProperty(rect, "y", state->engine->newNumber(0));
                        state->engine->setProperty(rect, "width",
                                                   state->engine->newNumber(state->presentation.canvasWidth));
                        state->engine->setProperty(rect, "height",
                                                   state->engine->newNumber(state->presentation.canvasHeight));
                        state->engine->setProperty(rect, "top", state->engine->newNumber(0));
                        state->engine->setProperty(rect, "left", state->engine->newNumber(0));
                        state->engine->setProperty(rect, "right",
                                                   state->engine->newNumber(state->presentation.canvasWidth));
                        state->engine->setProperty(rect, "bottom",
                                                   state->engine->newNumber(state->presentation.canvasHeight));
                        return rect;
}

static js::JSValueHandle handleHtmlCanvasElementToDataUrl(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& a) {
                        std::string mimeType = "image/png";
                        if (!a.empty()) {
                            mimeType = state->engine->toString(a[0]);
                        }
                        // Return a minimal data URI (for @loaders.gl WebP detection)
                        if (mimeType.find("webp") != std::string::npos) {
                            return state->engine->newString("data:image/webp;base64,");
                        }
                        return state->engine->newString("data:image/png;base64,");
}

static js::JSValueHandle getOffscreenCanvasContext(
    BindingsState* state,
    int canvasId,
    const std::vector<js::JSValueHandle>& contextArgs) {
                    if (contextArgs.empty()) {
                        return state->engine->newNull();
                    }
                    std::string contextType = state->engine->toString(contextArgs[0]);
                    // Use the captured canvasId to find the correct canvas
                    // This ensures each canvas element's getContext returns its own context
                    auto it = state->canvas2D.offscreenCanvases.find(canvasId);
                    if (it == state->canvas2D.offscreenCanvases.end()) {
                        std::cerr << "[Canvas] Canvas not found: " << canvasId << std::endl;
                        return state->engine->newNull();
                    }
                    OffscreenCanvas* canvas = it->second.get();
                    if (contextType == "2d") {
                        // Return cached context if already created
                        if (canvas->hasContext2d) {
                            return canvas->context2d;
                        }
                        // Get current dimensions from the canvas element (in case they were changed)
                        std::string globalName = "__offscreenCanvas_" + std::to_string(canvasId);
                        auto canvasElement = state->engine->getGlobalProperty(globalName.c_str());
                        if (!state->engine->isNull(canvasElement) && !state->engine->isUndefined(canvasElement)) {
                            auto widthProp = state->engine->getProperty(canvasElement, "width");
                            auto heightProp = state->engine->getProperty(canvasElement, "height");
                            if (!state->engine->isUndefined(widthProp)) {
                                canvas->width = static_cast<int>(state->engine->toNumber(widthProp));
                            }
                            if (!state->engine->isUndefined(heightProp)) {
                                canvas->height = static_cast<int>(state->engine->toNumber(heightProp));
                            }
                        }
                        // Create Canvas 2D context
                        if (state->verboseLogging) std::cout << "[Canvas] Creating offscreen 2D context (" << canvas->width << "x" << canvas->height << ")" << std::endl;
                        canvas->context2d = createOwnedCanvas2DContext(
                            state, canvas->width, canvas->height);
                        canvas->hasContext2d = true;
                        return canvas->context2d;
                    }
                    if (contextType == "webgpu") {
                        // Create GPUCanvasContext for offscreen canvas
                        // This shares the main surface/device for simplicity
                        if (state->verboseLogging) std::cout << "[Canvas] Creating offscreen WebGPU context" << std::endl;
                        // Suspend frame tracking - this context persists across frames
                        state->engine->suspendFrameTracking();
                        auto canvasContext = createNativeWrapper(
                            state, "GPUCanvasContext", state->surface);
                        // context.canvas - reference back to canvas element
                        std::string globalName = "__offscreenCanvas_" + std::to_string(canvasId);
                        auto canvasElement = state->engine->getGlobalProperty(globalName.c_str());
                        state->engine->setProperty(canvasContext, "canvas", canvasElement);
                        if (!installCanvasContextBindings(state, canvasContext, true)) {
                            state->engine->resumeFrameTracking();
                            return state->engine->newUndefined();
                        }
                        state->engine->resumeFrameTracking();
                        return canvasContext;
                    }
                    // Ignore webgl requests silently (PixiJS feature detection)
                    if (contextType == "webgl" || contextType == "webgl2" || contextType == "experimental-webgl") {
                        return state->engine->newNull();
                    }
                    std::cerr << "[Canvas] Unsupported context type: " << contextType << std::endl;
                    return state->engine->newNull();
}

static BindingHandler makeOffscreenCanvasGetContextHandler(int canvasId) {
    return [canvasId](BindingsState* state, BindingDestination,
                      const std::vector<js::JSValueHandle>& contextArgs) {
        return getOffscreenCanvasContext(state, canvasId, contextArgs);
    };
}

static js::JSValueHandle handleHtmlCanvasElementRequestPointerLock(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args) {
    const auto mainCanvas = state->engine->getGlobalProperty("canvas");
    const auto element = bindingDestination;
                        const auto request = state->engine->getProperty(mainCanvas, "requestPointerLock");
                        const auto result = state->engine->call(request, mainCanvas, args);
                        const auto document = state->engine->getGlobalProperty("document");
                        state->engine->setProperty(document, "pointerLockElement", element);
                        const auto event = state->engine->newObject();
                        state->engine->setProperty(event, "type", state->engine->newString("pointerlockchange"));
                        const auto dispatch = state->engine->getProperty(document, "dispatchEvent");
                        state->engine->call(dispatch, document, {event});
                        return result;
}

static js::JSValueHandle handleHtmlCanvasElementDispatchEvent(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args) {
    const auto mainCanvas = state->engine->getGlobalProperty("canvas");
                        const auto dispatch = state->engine->getProperty(mainCanvas, "dispatchEvent");
                        return state->engine->call(dispatch, mainCanvas, args);
}

static js::JSValueHandle handleHtmlCanvasElementRemoveEventListener(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args) {
    const auto mainCanvas = state->engine->getGlobalProperty("canvas");
                        const auto remove = state->engine->getProperty(mainCanvas, "removeEventListener");
                        return state->engine->call(remove, mainCanvas, args);
}

static js::JSValueHandle handleHtmlCanvasElementAddEventListener(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args) {
    const auto mainCanvas = state->engine->getGlobalProperty("canvas");
                        const auto add = state->engine->getProperty(mainCanvas, "addEventListener");
                        return state->engine->call(add, mainCanvas, args);
}

static js::JSValueHandle handleHtmlElementRemoveEventListener(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& a) {
                    return state->engine->newUndefined();
}

static js::JSValueHandle handleHtmlElementAddEventListener(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& a) {
                    // No-op in native runtime
                    return state->engine->newUndefined();
}

static js::JSValueHandle handleCreatedHtmlElementRemove(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& a) {
                    // No-op in native runtime - element is not attached to DOM
                    return state->engine->newUndefined();
}

static js::JSValueHandle handleCreatedHtmlElementRemoveChild(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& a) {
                    return a.empty() ? state->engine->newUndefined() : a[0];
}

static js::JSValueHandle handleCreatedHtmlElementAppendChild(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& a) {
                    return a.empty() ? state->engine->newUndefined() : a[0];
}

static js::JSValueHandle handleDocumentCreateElement(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args) {
            auto element = state->engine->newObject();
            // Registration rows retain this handle for callbacks after the creating frame. The
            // JavaScript object is also returned to the caller, so this protection preserves the
            // existing ownership semantics without using a later mutable row property as state.
            protectBindingHandle(state, element);
            // Get tag name if provided
            std::string tagName = "";
            if (!args.empty()) {
                tagName = state->engine->toString(args[0]);
            }
            // Add basic DOM element properties
            state->engine->setProperty(element, "style", state->engine->newObject());
            state->engine->setProperty(element, "className", state->engine->newString(""));
            state->engine->setProperty(element, "innerHTML", state->engine->newString(""));
            state->engine->setProperty(element, "textContent", state->engine->newString(""));
            state->engine->setProperty(element, "tagName", state->engine->newString(tagName.c_str()));
            if (!installBindingTable(state->engine, state, bindingTable({
                {"HTMLElement", "appendChild", 0, nullptr,
                &handleCreatedHtmlElementAppendChild
            , element},
                {"HTMLElement", "removeChild", 0, nullptr,
                &handleCreatedHtmlElementRemoveChild
            , element},
                {"HTMLElement", "remove", 0, nullptr,
                &handleCreatedHtmlElementRemove
            , element},
                {"HTMLElement", "addEventListener", 0, nullptr,
                &handleHtmlElementAddEventListener
            , element},
                {"HTMLElement", "removeEventListener", 0, nullptr,
                &handleHtmlElementRemoveEventListener
            , element}}))) {
                unprotectBindingHandle(state, element);
                return state->engine->newUndefined();
            }
            // Special handling for canvas elements - add Canvas 2D support
            if (tagName == "canvas" || tagName == "CANVAS") {
                // Three's renderer creates its surface through document.createElement('canvas'),
                // while the runtime's SDL input dispatches to the main canvas exposed by
                // document.getElementById('canvas'). Forward the event surface so a renderer
                // canvas receives the same pointer and pointer-lock events on native.
                const auto mainCanvas = state->engine->getGlobalProperty("canvas");
                if (!installBindingTable(state->engine, state, bindingTable({
                    {"HTMLCanvasElement", "addEventListener", 0, nullptr,
                    &handleHtmlCanvasElementAddEventListener
                , element},
                    {"HTMLCanvasElement", "removeEventListener", 0, nullptr,
                    &handleHtmlCanvasElementRemoveEventListener
                , element},
                    {"HTMLCanvasElement", "dispatchEvent", 0, nullptr,
                    &handleHtmlCanvasElementDispatchEvent
                , element},
                    {"HTMLCanvasElement", "requestPointerLock", 0, nullptr,
                    &handleHtmlCanvasElementRequestPointerLock
                , element}}))) {
                    unprotectBindingHandle(state, element);
                    return state->engine->newUndefined();
                }
                // Create OffscreenCanvas struct to store state
                int canvasId = state->canvas2D.nextOffscreenCanvasId++;
                auto offscreenCanvas = std::make_unique<OffscreenCanvas>();
                OffscreenCanvas* canvasPtr = offscreenCanvas.get();
                state->canvas2D.offscreenCanvases[canvasId] = std::move(offscreenCanvas);
                // Store the canvas ID as private data for getContext lookup
                state->engine->setPrivateData(element, reinterpret_cast<void*>(static_cast<intptr_t>(canvasId)));
                // Also store as property for debugging
                state->engine->setProperty(element, "_offscreenCanvasId", state->engine->newNumber(canvasId));
                // Default canvas dimensions (stored in struct)
                state->engine->setProperty(element, "width", state->engine->newNumber(canvasPtr->width));
                state->engine->setProperty(element, "height", state->engine->newNumber(canvasPtr->height));
                // Store reference to element globally so getContext can find it
                std::string globalName = "__offscreenCanvas_" + std::to_string(canvasId);
                state->engine->setGlobalProperty(globalName.c_str(), element);
                // Create getContext function
                // Capture canvasId to ensure each canvas element's getContext uses its own canvas
                // This fixes the bug where all canvases shared the same context
                if (!installBindingTable(state->engine, state, bindingTable({
                    {"HTMLCanvasElement", "getContext", 0, nullptr,
                    makeOffscreenCanvasGetContextHandler(canvasId)
                , element}}))) {
                    rollbackOffscreenCanvas(state, canvasId, element);
                    return state->engine->newUndefined();
                }
                if (state->verboseLogging) std::cout << "[Canvas] Created offscreen canvas " << canvasId << std::endl;
                // toDataURL for compatibility (returns empty data URI)
                if (!installBindingTable(state->engine, state, bindingTable({
                    {"HTMLCanvasElement", "toDataURL", 0, nullptr,
                    &handleHtmlCanvasElementToDataUrl
                , element},
                // getBoundingClientRect - return canvas dimensions
                    {"HTMLCanvasElement", "getBoundingClientRect", 0, nullptr,
                    &handleHtmlCanvasElementGetBoundingClientRect
                , element}}))) {
                    rollbackOffscreenCanvas(state, canvasId, element);
                    return state->engine->newUndefined();
                }
            }
            return element;
}

static js::JSValueHandle handleDocumentQuerySelector(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args) {
            // Check if querying for canvas
            if (!args.empty()) {
                std::string selector = state->engine->toString(args[0]);
                if (selector == "canvas" || selector.find("canvas") != std::string::npos) {
                    return state->engine->getGlobalProperty("canvas");
                }
            }
            return state->engine->newNull();
}

static js::JSValueHandle handleHtmlCanvasElementGetContext(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args) {
            if (args.empty()) {
                return state->engine->newNull();
            }
            std::string contextType = state->engine->toString(args[0]);
            // Handle Canvas 2D context
            if (contextType == "2d") {
                // One canvas answers with one context, the same rule the offscreen path follows.
                // A repeat call built a second Skia surface and a second set of method closures,
                // so a game that asked again — per frame, or twice for the same canvas — paid an
                // allocation and left the earlier context orphaned.
                auto canvas = state->engine->getGlobalProperty("canvas");
                auto cached = state->engine->getProperty(canvas, "__tnCanvas2dContext");
                if (!state->engine->isUndefined(cached) && !state->engine->isNull(cached)) {
                    return cached;
                }
                if (state->verboseLogging)
                    std::cout << "[Canvas] Creating 2D context (" << state->presentation.canvasWidth << "x"
                              << state->presentation.canvasHeight << ")" << std::endl;
                auto ctx2d = createOwnedCanvas2DContext(state, state->presentation.canvasWidth,
                                                        state->presentation.canvasHeight);
                // Set reference back to canvas
                state->engine->setProperty(ctx2d, "canvas", canvas);
                if (state->engine->hasException()) {
                    rollbackOwnedCanvas2DContext(state, ctx2d);
                    return state->engine->newUndefined();
                }
                state->engine->setProperty(canvas, "__tnCanvas2dContext", ctx2d);
                // Store the native context for Canvas 2D to WebGPU compositing
                state->canvas2D.mainCanvas2DContext =
                    static_cast<canvas::Canvas2DContext*>(state->engine->getPrivateData(ctx2d));
                if (state->verboseLogging) std::cout << "[Canvas] Main canvas using 2D context - will composite to WebGPU" << std::endl;
                return ctx2d;
            }
            if (contextType != "webgpu") {
                std::cerr << "[Canvas] Unknown context type: " << contextType << std::endl;
                return state->engine->newNull();
            }
            // Create GPUCanvasContext
            auto canvasContext = createNativeWrapper(
                state, "GPUCanvasContext", state->surface);
            // context.canvas - reference back to canvas
            auto canvas = state->engine->getGlobalProperty("canvas");
            state->engine->setProperty(canvasContext, "canvas", canvas);
            if (!installCanvasContextBindings(state, canvasContext, false)) {
                return state->engine->newUndefined();
            }
            if (state->verboseLogging) std::cout << "[Canvas] WebGPU context created" << std::endl;
            return canvasContext;
}

static js::JSValueHandle handleParentElementRemoveChild(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args) {
            return args.empty() ? state->engine->newUndefined() : args[0];
}

static js::JSValueHandle handleParentElementAppendChild(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args) {
            // No-op in native runtime
            return args.empty() ? state->engine->newUndefined() : args[0];
}
/**
 * Writes the canvas dimensions the web platform defines: `width`/`height` are the backing store in
 * physical pixels, `clientWidth`/`clientHeight` are the CSS layout box in logical ones.
 *
 * These four were all set to the physical surface here, which silently undid the logical CSS box
 * `setupDOMEvents` had just written — the DOM said one thing and the WebGPU bindings overwrote it
 * a moment later, so a layout still saw a 2400-pixel-wide "CSS pixel" viewport on a Pixel 8.
 */
static void setCanvasDimensions(js::Engine* engine, js::JSValueHandle canvasObject,
                                uint32_t physicalWidth, uint32_t physicalHeight) {
    const double ratio = static_cast<double>(platform::displayPixelDensity());
    const double density = ratio > 0.0 ? ratio : 1.0;
    engine->setProperty(canvasObject, "width", engine->newNumber(physicalWidth));
    engine->setProperty(canvasObject, "height", engine->newNumber(physicalHeight));
    engine->setProperty(canvasObject, "clientWidth",
                        engine->newNumber(std::round(physicalWidth / density)));
    engine->setProperty(canvasObject, "clientHeight",
                        engine->newNumber(std::round(physicalHeight / density)));
}

static bool installWebGPUBindingTables(BindingsState* state, js::Engine* engine) {
    const auto globalBindingHost = engine->newObject();
    engine->freezeHandle(globalBindingHost);
    struct GlobalBindingHostProtection {
        js::Engine* engine;
        js::JSValueHandle value;
        ~GlobalBindingHostProtection() {
            if (value.ptr) engine->freeHandle(value);
        }
    } globalBindingHostProtection{engine, globalBindingHost};
    const auto copyGlobalBinding = [&](js::JSValueHandle host, const char* name) {
        const auto binding = engine->getProperty(host, name);
        if (engine->hasException()) return false;
        if (!engine->isFunction(binding)) {
            const std::string message =
                std::string("WebGPU global binding was not installed: ") + name;
            engine->throwException(message.c_str());
            return false;
        }
        if (engine->setGlobalProperty(name, binding) && !engine->hasException()) {
            return true;
        }
        if (!engine->hasException()) {
            const std::string message =
                std::string("WebGPU global binding copy failed: ") + name;
            engine->throwException(message.c_str());
        }
        return false;
    };

    // ========================================================================
    // Create a mock parent element for the canvas (needed by Debugger)
    // ========================================================================
    auto parentElement = engine->newObject();
    engine->setProperty(parentElement, "style", engine->newObject());
    if (!installBindingTable(state->engine, state, bindingTable({
        {"HTMLElement", "appendChild", 0, nullptr,
        &handleParentElementAppendChild
    , parentElement},
        {"HTMLElement", "removeChild", 0, nullptr,
        &handleParentElementRemoveChild
    , parentElement}}))) return false;

    // ========================================================================
    // Get existing canvas from runtime.cpp's document.getElementById
    // The canvas was created by setupDOMEvents() with addEventListener, style, etc.
    // We just need to add WebGPU-specific methods (getContext) to it.
    // ========================================================================
    auto existingDocument = engine->getGlobalProperty("document");
    auto getElementByIdFunc = engine->getProperty(existingDocument, "getElementById");

    // Call document.getElementById('canvas') to get the existing canvas
    std::vector<js::JSValueHandle> args;
    args.push_back(engine->newString("canvas"));
    auto canvasObject = engine->call(getElementByIdFunc, existingDocument, args);

    if (engine->isNull(canvasObject) || engine->isUndefined(canvasObject)) {
        std::cerr << "[WebGPU] Warning: No existing canvas found, creating new one" << std::endl;
        canvasObject = engine->newObject();
        setCanvasDimensions(engine, canvasObject, state->presentation.canvasWidth, state->presentation.canvasHeight);
    }

    // Update canvas dimensions (in case they differ)
    setCanvasDimensions(engine, canvasObject, state->presentation.canvasWidth, state->presentation.canvasHeight);

    // canvas.parentElement - mock parent element (for Debugger compatibility)
    engine->setProperty(canvasObject, "parentElement", parentElement);

    // canvas.getContext('webgpu') -> GPUCanvasContext
    // This is the WebGPU-specific method we add to the existing canvas
    if (!installBindingTable(state->engine, state, bindingTable({
        {"HTMLCanvasElement", "getContext", 0, nullptr,
        &handleHtmlCanvasElementGetContext
    , canvasObject}}))) return false;

    // Set global canvas - this is the SAME object as document.getElementById('canvas')
    // so it now has both WebGPU getContext AND event listener support
    engine->setGlobalProperty("canvas", canvasObject);

    // ========================================================================
    // Add missing methods to the existing document (from runtime.cpp)
    // We DON'T create a new document - just augment the existing one
    // ========================================================================

    // Add querySelector to existing document (if not present)
    if (!installBindingTable(state->engine, state, bindingTable({
        {"Document", "querySelector", 0, nullptr,
        &handleDocumentQuerySelector
    , existingDocument},

    // Add createElement to existing document
    // NOTE: runtime.cpp sets up a createElement with canvas support (toDataURL) for @loaders.gl WebP detection
    // We ALWAYS override it here to add proper Canvas 2D support for offscreen canvases
        {"Document", "createElement", 0, nullptr,
        &handleDocumentCreateElement
    , existingDocument}}))) return false;

    // Add document.body if not present, or enhance existing body with required methods
    auto existingBody = engine->getProperty(existingDocument, "body");
    if (engine->isUndefined(existingBody) || engine->isNull(existingBody)) {
        existingBody = engine->newObject();
        engine->setProperty(existingDocument, "body", existingBody);
    }
    // Always add/update these methods on body
    engine->setProperty(existingBody, "style", engine->newObject());
    if (!installBindingTable(state->engine, state, bindingTable({
        {"HTMLElement", "appendChild", 0, nullptr,
        &handleDocumentBodyAppendChild
    , existingBody},
        {"HTMLElement", "removeChild", 0, nullptr,
        &handleDocumentBodyRemoveChild
    , existingBody}}))) return false;

    // ========================================================================
    // Navigator object
    // ========================================================================
    auto navigatorHandle = engine->getGlobalProperty("navigator");
    if (engine->isUndefined(navigatorHandle)) {
        navigatorHandle = engine->newObject();
        engine->setGlobalProperty("navigator", navigatorHandle);
    }

    // Add common navigator properties for browser compatibility
    // PixiJS and other libraries check these for feature detection
    engine->setProperty(navigatorHandle, "userAgent",
        engine->newString("Mozilla/5.0 (Macintosh; MystralNative/0.1) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"));
    engine->setProperty(navigatorHandle, "platform", engine->newString("MystralNative"));
    engine->setProperty(navigatorHandle, "vendor", engine->newString("Mystral Engine"));
    engine->setProperty(navigatorHandle, "language", engine->newString("en-US"));
    engine->setProperty(navigatorHandle, "languages", engine->newArray(1));  // ["en-US"]
    engine->setProperty(navigatorHandle, "onLine", engine->newBoolean(true));
    engine->setProperty(navigatorHandle, "hardwareConcurrency", engine->newNumber(8));
    engine->setProperty(navigatorHandle, "maxTouchPoints", engine->newNumber(0));

    // Create navigator.gpu object
    auto gpuObject = engine->newObject();

    // ========================================================================
    // navigator.gpu.requestAdapter()
    // ========================================================================
    if (!installBindingTable(state->engine, state, bindingTable({
        {"GPU", "requestAdapter", 0, nullptr,
        &handleGpuRequestAdapter
    , gpuObject}}))) return false;

    // navigator.gpu.getPreferredCanvasFormat()
    if (!installBindingTable(state->engine, state, bindingTable({
        {"GPU", "getPreferredCanvasFormat", 0, nullptr,
        &handleGpuGetPreferredCanvasFormat
    , gpuObject}}))) return false;

    // Set navigator.gpu
    engine->setProperty(navigatorHandle, "gpu", gpuObject);

    // ========================================================================
    // GPU Usage Constants
    // ========================================================================
    auto gpuBufferUsage = engine->newObject();
    engine->setProperty(gpuBufferUsage, "MAP_READ", engine->newNumber(0x0001));
    engine->setProperty(gpuBufferUsage, "MAP_WRITE", engine->newNumber(0x0002));
    engine->setProperty(gpuBufferUsage, "COPY_SRC", engine->newNumber(0x0004));
    engine->setProperty(gpuBufferUsage, "COPY_DST", engine->newNumber(0x0008));
    engine->setProperty(gpuBufferUsage, "INDEX", engine->newNumber(0x0010));
    engine->setProperty(gpuBufferUsage, "VERTEX", engine->newNumber(0x0020));
    engine->setProperty(gpuBufferUsage, "UNIFORM", engine->newNumber(0x0040));
    engine->setProperty(gpuBufferUsage, "STORAGE", engine->newNumber(0x0080));
    engine->setProperty(gpuBufferUsage, "INDIRECT", engine->newNumber(0x0100));
    engine->setProperty(gpuBufferUsage, "QUERY_RESOLVE", engine->newNumber(0x0200));
    engine->setGlobalProperty("GPUBufferUsage", gpuBufferUsage);

    auto gpuTextureUsage = engine->newObject();
    engine->setProperty(gpuTextureUsage, "COPY_SRC", engine->newNumber(0x01));
    engine->setProperty(gpuTextureUsage, "COPY_DST", engine->newNumber(0x02));
    engine->setProperty(gpuTextureUsage, "TEXTURE_BINDING", engine->newNumber(0x04));
    engine->setProperty(gpuTextureUsage, "STORAGE_BINDING", engine->newNumber(0x08));
    engine->setProperty(gpuTextureUsage, "RENDER_ATTACHMENT", engine->newNumber(0x10));
    engine->setGlobalProperty("GPUTextureUsage", gpuTextureUsage);

    auto gpuShaderStage = engine->newObject();
    engine->setProperty(gpuShaderStage, "VERTEX", engine->newNumber(0x1));
    engine->setProperty(gpuShaderStage, "FRAGMENT", engine->newNumber(0x2));
    engine->setProperty(gpuShaderStage, "COMPUTE", engine->newNumber(0x4));
    engine->setGlobalProperty("GPUShaderStage", gpuShaderStage);

    auto gpuMapMode = engine->newObject();
    engine->setProperty(gpuMapMode, "READ", engine->newNumber(0x1));
    engine->setProperty(gpuMapMode, "WRITE", engine->newNumber(0x2));
    engine->setGlobalProperty("GPUMapMode", gpuMapMode);

    // =========================================================================
    // createImageBitmap() - Standard Web API for image decoding
    // =========================================================================
    // createImageBitmap(source) -> Promise<ImageBitmap>
    // source can be: Blob, ArrayBuffer, or object with arrayBuffer() method
    // Returns ImageBitmap with: width, height, close(), and internal pixel data
    //
    // Note: PNG/JPEG supported via stb_image. WebP supported via libwebp (when MYSTRAL_HAS_WEBP defined).

    // The presentation ceiling's named override (PRD-218), and the count of frames that actually
    // reached the display, which the JavaScript frame budget reads so a window can report a rate the
    // display saw rather than the loop's cadence.
    if (!installBindingTable(state->engine, state, bindingTable({
        {"WebGPU", "__tnPresentationCap", 0, nullptr,
        &handleWebGpuPresentationCap
    , globalBindingHost},
        {"WebGPU", "__tnPresentedCount", 0, nullptr,
        &handleWebGpuPresentedCount
    , globalBindingHost}})) ||
        !copyGlobalBinding(globalBindingHost, "__tnPresentationCap") ||
        !copyGlobalBinding(globalBindingHost, "__tnPresentedCount")) return false;

    // Native helper that decodes image data off the frame thread
    if (!installBindingTable(state->engine, state, bindingTable({
        {"WebGPU", "__decodeImageDataAsync", 0, nullptr,
        &handleWebGpuDecodeImageData
    , globalBindingHost}})) ||
        !copyGlobalBinding(globalBindingHost, "__decodeImageDataAsync")) return false;

    // JavaScript polyfill for createImageBitmap
    if (!evalEmbeddedRuntimeScript(*engine, "image-bitmap-polyfill", "image-bitmap-polyfill.js")) {
        return false;
    }

    auto mystralNamespace = engine->newObject();

    engine->setGlobalProperty("Mystral", mystralNamespace);

    // ========================================================================
    // Native helper for offscreen canvas getContext('2d')
    // Called by the JS closure created in createElement('canvas')
    // ========================================================================
    if (!installBindingTable(state->engine, state, bindingTable({
        {"WebGPU", "__nativeGetContext2D", 0, nullptr,
        &handleWebGpuNativeGetContext2d
    , globalBindingHost},

    // ========================================================================
    // Global createOffscreenCanvas2D(width, height) helper
    // Creates an offscreen canvas with a 2D context at the specified size
    // This is easier to use than document.createElement('canvas').getContext('2d')
    // since it handles dimensions correctly
    // ========================================================================
            {"WebGPU", "createOffscreenCanvas2D", 0, nullptr,
        &handleWebGpuCreateOffscreenCanvas2d
    , globalBindingHost}})) ||
        !copyGlobalBinding(globalBindingHost, "__nativeGetContext2D") ||
        !copyGlobalBinding(globalBindingHost, "createOffscreenCanvas2D")) return false;


    if (state->verboseLogging) {
        std::cout << "[WebGPU] JavaScript bindings initialized" << std::endl;
        std::cout << "[WebGPU] createImageBitmap() available for image decoding" << std::endl;
    }

    return true;

}
#endif

/** Initialize WebGPU bindings in the JS engine. */
bool initBindings(BindingsState* state, js::Engine* engine, void* wgpuInstance, void* wgpuDevice, void* wgpuQueue, void* wgpuSurface, uint32_t surfaceFormat, uint32_t presentMode, uint32_t width, uint32_t height, bool debug, void* wgpuAdapter, void* surfaceNativeHandle) {
    if (!state || !engine) {
        std::cerr << "[WebGPU] No JS engine provided for bindings" << std::endl;
        return false;
    }

#if defined(MYSTRAL_WEBGPU_WGPU) || defined(MYSTRAL_WEBGPU_DAWN)
    // Set verbose logging based on debug flag
    state->verboseLogging = debug;

    state->engine = engine;
    state->instance = (WGPUInstance)wgpuInstance;
    state->device = (WGPUDevice)wgpuDevice;
    state->adapter = (WGPUAdapter)wgpuAdapter;
    state->queue = (WGPUQueue)wgpuQueue;
    state->surface = (WGPUSurface)wgpuSurface;
    reportPipelineCaptureMetadata(state->adapter);
    // PRD-368. Before any binding is installed, so no pipeline can be created without it.
    initPipelineCache(state);
    state->presentation.presentMode = static_cast<WGPUPresentMode>(presentMode);

    // Set canvas dimensions from window size
    state->presentation.canvasWidth = width;
    state->presentation.canvasHeight = height;
    state->presentation.surfaceWidth = width;
    state->presentation.surfaceHeight = height;
    state->presentation.surfaceNativeHandle = surfaceNativeHandle;
    state->presentation.nativeSurfaceFormat = (WGPUTextureFormat)surfaceFormat;
    state->presentation.requiresSrgbPresentationBridge =
        state->surface != nullptr && isSrgbSurfaceFormat(state->presentation.nativeSurfaceFormat);
    state->presentation.surfaceFormat = state->presentation.requiresSrgbPresentationBridge
                                            ? linearSurfaceFormat(state->presentation.nativeSurfaceFormat)
                                            : state->presentation.nativeSurfaceFormat;
    reportSurfaceFormatMarker(state->presentation.nativeSurfaceFormat,
                              state->presentation.surfaceFormat,
                              state->presentation.requiresSrgbPresentationBridge,
                              state->presentation.presentMode);

    if (state->verboseLogging) {
        std::cout << "[WebGPU] Initializing JavaScript bindings..." << std::endl;
        std::cout << "[WebGPU] Native surface format: " << surfaceFormat
                  << ", canvas format: " << state->presentation.surfaceFormat << ", sRGB presentation bridge: "
                  << (state->presentation.requiresSrgbPresentationBridge ? "enabled" : "disabled") << std::endl;
    }

    return installWebGPUBindingSurfaces(state, engine);
#else
    std::cerr << "[WebGPU] No WebGPU backend available" << std::endl;
    return true;
#endif
}


void beginDawnFrame(BindingsState* state) {
    // The launch stall is measured from here: this is the first instant the loop is inside a
    // frame rather than still loading, so everything after it and before the first present is the
    // gap the player watches a frozen loading screen through. PRD-218.
    mystral::stallBudget().markFirstFrameBegan();
    state->profiling.frameOpStreamDirectCommandCalls = 0;

    // Otherwise a no-op: Dawn resource cleanup is handled by V8 weak callbacks
    // via Engine::registerRelease() — resources are released when
    // their JS wrapper objects are garbage collected.
}


// ============================================================================
// Video capture callback support (used by GPUReadbackRecorder)
// ============================================================================

// Video capture callback - called when queue.submit happens with a surface texture
// This allows the video recorder to capture frames without modifying the render loop
void setVideoCaptureCallback(BindingsState* state, void (*callback)(void* texture, uint32_t width, uint32_t height, void* userData), void* userData) {
    state->screenshot.videoCaptureCallback = callback;
    state->screenshot.videoCaptureUserData = userData;
}

void clearVideoCaptureCallback(BindingsState* state) {
    state->screenshot.videoCaptureCallback = nullptr;
    state->screenshot.videoCaptureUserData = nullptr;
}

// Internal function to invoke video capture callback (called from queue.submit)
void invokeVideoCaptureCallback(BindingsState* state, WGPUTexture texture, uint32_t width, uint32_t height) {
    if (state->screenshot.videoCaptureCallback && texture) {
        state->screenshot.videoCaptureCallback(static_cast<void*>(texture), width, height,
                                               state->screenshot.videoCaptureUserData);
    }
}


/** An end-frame boundary this slow is the reason the loop is not iterating. */
constexpr uint64_t kSlowEndFrameNs = 250'000'000;

void endDawnFrame(BindingsState* state) {
    // The one command-submission crossing for this frame. All requestAnimationFrame callbacks
    // have returned, while descriptor objects and eager-copied upload payloads are still live.
    //
    // The wall-clock reads below feed the host-gap decomposition (TN_HOST_GAP). Unlike the
    // CPU-profile reads they replace nothing and gate nothing; four extra steady_clock reads per
    // frame is the whole cost.
    using steady = std::chrono::steady_clock;
    const steady::time_point phaseBegin = steady::now();
    state->profiling.framePhaseDrainNs = 0;
    state->profiling.framePhaseReplayNs = 0;
    state->profiling.framePhasePresentNs = 0;
    state->profiling.framePhaseGpuDrainNs = 0;
    state->profiling.framePhasePollNs = 0;
    state->profiling.framePhaseUiNs = 0;
    state->profiling.framePhaseOtherNs = 0;
    if (state->profiling.frameOpStreamDrain.ptr) {
        const steady::time_point drainBegin = steady::now();
#if TN_ANDROID_JS_PROFILE
        const uint64_t drainStartCpuNs = readRenderThreadCpuNs();
#endif
        // The frame boundary passes no `partial` and hands the recorder the retained-plan epoch:
        // it patches only while the plan it holds is still the one native has, and recaptures the
        // moment that stops being true. One number per frame is the whole recovery protocol.
        const auto frame = state->engine->call(
            state->profiling.frameOpStreamDrain, state->engine->newUndefined(),
            {state->engine->newUndefined(),
             state->engine->newNumber(static_cast<double>(state->framePlan.epoch))});
        const uint64_t drainNs = static_cast<uint64_t>(
            std::chrono::duration_cast<std::chrono::nanoseconds>(steady::now() - drainBegin)
                .count());
        state->profiling.framePhaseDrainNs = drainNs;
#if TN_ANDROID_JS_PROFILE
        const uint64_t drainEndCpuNs = readRenderThreadCpuNs();
        if (drainEndCpuNs > drainStartCpuNs) {
            state->profiling.androidJsNativeProfile.frameOpDrainNs += drainEndCpuNs - drainStartCpuNs;
        }
#endif
        if (!state->engine->isNull(frame) && !state->engine->isUndefined(frame)) {
            state->profiling.frameOpStreamReplayCrossings += 1;
            const steady::time_point replayBegin = steady::now();
#if TN_ANDROID_JS_PROFILE
            const uint64_t replayStartCpuNs = readRenderThreadCpuNs();
#endif
            const bool replayed = replayPackedFrameOpStream(state, frame);
            const uint64_t replayNs = static_cast<uint64_t>(
                std::chrono::duration_cast<std::chrono::nanoseconds>(steady::now() - replayBegin)
                    .count());
            state->profiling.framePhaseReplayNs = replayNs;
#if TN_ANDROID_JS_PROFILE
            const uint64_t replayEndCpuNs = readRenderThreadCpuNs();
            if (replayEndCpuNs > replayStartCpuNs) {
                state->profiling.androidJsNativeProfile.frameOpReplayNs += replayEndCpuNs - replayStartCpuNs;
            }
#endif
            if (replayed) {
                state->profiling.frameOpStreamPendingOps = false;
                startDeferredBufferMaps(state);
            }
            if (!replayed && !state->engine->hasException()) {
                state->engine->throwException("frame op stream: replay failed");
            }
        }
    }
#if TN_ANDROID_JS_PROFILE
    // Emission and counter reset belong to the once-per-frame replay boundary, never to an
    // individual queue.submit (a frame may contain several submits).
    emitAndroidJsNativeProfile(state, 0, state->profiling.lastPresentNs);
#endif
    // Composite Canvas 2D content to WebGPU if the main canvas uses 2D context
    compositeCanvas2DToWebGPU(state);

    // The native UI layer, over whatever the world left in the frame's colour target and before
    // the present, so one swapchain carries both. Its own phase, not the remainder: this is the
    // whole cost PRD-393 adds to a frame, and AC-6 measures it on its own.
    {
        const steady::time_point uiBegin = steady::now();
        compositeUiOverlayToWebGPU(state);
        state->profiling.framePhaseUiNs = static_cast<uint64_t>(
            std::chrono::duration_cast<std::chrono::nanoseconds>(steady::now() - uiBegin).count());
    }

    // Every pass this frame has been submitted; put the one image on screen.
    const uint64_t presentsBefore = state->profiling.presentCount;
    const steady::time_point presentBegin = steady::now();
    presentPendingSurface(state);
    const uint64_t presentNs = static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::nanoseconds>(steady::now() - presentBegin)
            .count());
    state->profiling.framePhasePresentNs = presentNs;
    // Only a frame that reached the display is paced. See paceToPresentationCap().
    if (state->profiling.presentCount != presentsBefore)
        paceToPresentationCap();

#if TN_WEBGPU_GPU_DRAIN_PROFILE && defined(MYSTRAL_WEBGPU_WGPU)
    // Diagnostic builds only: measure the GPU work still outstanding after present and pacing.
    // A blocking device poll serializes the frame and must never be enabled in a shipped build.
    if (state->device) {
        const steady::time_point gpuDrainBegin = steady::now();
        wgpuDevicePoll(state->device, true, nullptr);
        state->profiling.framePhaseGpuDrainNs = static_cast<uint64_t>(
            std::chrono::duration_cast<std::chrono::nanoseconds>(steady::now() - gpuDrainBegin).count());
    }
#endif

    // One line a second, by the clock and not by the frame count.
    //
    // `% 60` alone is one line a second only if the loop runs at 60 Hz. When a game fails to start
    // there is nothing to present and nothing to wait for, so the loop free-runs: measured at
    // ~96,000 fps on a Pixel 8, which is ~1,600 of these lines a second, ~24,000 in fifteen
    // seconds. That overruns logcat's ring buffer and **evicts the entire startup sequence** —
    // this diagnostic was destroying the evidence for the failure it exists to report, and two
    // wrong conclusions in one debugging session came from reading the buffer it had emptied.
    //
    // The first tick is unconditional so any run of at least 60 frames still emits one and the
    // desktop and device gates keep their `minTicks` guarantee; every tick after it waits a
    // second of wall clock, whatever the loop is doing.
    state->profiling.frameEndCount += 1;
#if TN_JS_PROFILE || TN_ANDROID_JS_PROFILE
    // One start hook for the desktop and Android lanes (PRD-444). 226 is the frame the Android lane
    // profiles from, which is fine for steady state and useless for a startup: a game whose first
    // seconds stall the loop reaches frame 226 long after the stall is over.
    // `TN_JS_CPU_PROFILE_START_FRAME` moves the window so the stall can be profiled at all. Read
    // once — a `getenv` per frame is not worth a measurement that is already opt-in.
    if (js::g_startCpuProfile) {
        static const uint32_t startFrame = [] {
            const char* value = std::getenv("TN_JS_CPU_PROFILE_START_FRAME");
            return value != nullptr ? static_cast<uint32_t>(std::strtoul(value, nullptr, 10)) : 226u;
        }();
        if (state->profiling.frameEndCount == startFrame) js::g_startCpuProfile();
    }
    // A SIGTERM asked for the profile to be flushed. Done here, on the render thread between
    // frames, because a signal handler may not call V8.
    if (js::g_cpuProfileStopRequested && js::g_dumpCpuProfile) {
        js::g_cpuProfileStopRequested = 0;
        js::g_dumpCpuProfile();
        std::cout.flush();
        std::_Exit(js::g_cpuProfileFailed ? 1 : 0);
    }
#endif
    if (state->profiling.frameEndCount % 60 == 0) {
        using clock = std::chrono::steady_clock;
        const clock::time_point now = clock::now();
        if (state->profiling.reportLastTick == clock::time_point{} ||
            now - state->profiling.reportLastTick >= std::chrono::seconds(1)) {
            state->profiling.reportLastTick = now;
            reportPresentTick(state, state->profiling.frameEndCount);
        }
    }

    // Tick the WebGPU device to process completed GPU work and free internal
    // resources (staging buffers, command encoder state, etc.). Without this,
    // internal objects accumulate unboundedly since completion callbacks never fire.
    if (state->device) {
        const steady::time_point pollBegin = steady::now();
#if defined(MYSTRAL_WEBGPU_DAWN)
        wgpuDeviceTick(state->device);
#elif defined(MYSTRAL_WEBGPU_WGPU)
        wgpuDevicePoll(state->device, false, nullptr);
#endif
        const uint64_t pollNs = static_cast<uint64_t>(
            std::chrono::duration_cast<std::chrono::nanoseconds>(steady::now() - pollBegin)
                .count());
        state->profiling.framePhasePollNs = pollNs;
    }
    // The remainder after the named phases: profiling emission, canvas 2D compositing and
    // the present-pacing bookkeeping. Clamped at zero against clock jitter.
    const uint64_t phaseTotalNs = static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::nanoseconds>(steady::now() - phaseBegin).count());
    const uint64_t namedNs = state->profiling.framePhaseDrainNs + state->profiling.framePhaseReplayNs +
                             state->profiling.framePhasePresentNs + state->profiling.framePhaseGpuDrainNs +
                             state->profiling.framePhasePollNs + state->profiling.framePhaseUiNs;
    state->profiling.framePhaseOtherNs = phaseTotalNs > namedNs ? phaseTotalNs - namedNs : 0;

    // A frame this slow is why the loop is not iterating, and `TN_SLOW_PHASE` only says
    // `endDawnFrame`. The split says which half of the boundary owns it — the JS call that packs
    // the stream, or the C++ replay of it — and a reader cannot get that anywhere else.
    if (phaseTotalNs >= kSlowEndFrameNs) {
        const auto ms = [](uint64_t ns) { return static_cast<double>(ns) / 1e6; };
        std::cout << "TN_SLOW_END_FRAME:{\"totalMs\":" << ms(phaseTotalNs)
                  << ",\"drainMs\":" << ms(state->profiling.framePhaseDrainNs)
                  << ",\"replayMs\":" << ms(state->profiling.framePhaseReplayNs)
                  << ",\"uiMs\":" << ms(state->profiling.framePhaseUiNs)
                  << ",\"presentMs\":" << ms(state->profiling.framePhasePresentNs)
                  << ",\"pollMs\":" << ms(state->profiling.framePhasePollNs)
                  << ",\"gpuDrainMs\":" << ms(state->profiling.framePhaseGpuDrainNs)
                  << ",\"otherMs\":" << ms(state->profiling.framePhaseOtherNs) << "}" << std::endl;
    }
}

}  // namespace webgpu
}  // namespace mystral
