/** WebGPU presentation, acquisition, and surface lifecycle. */

#include "ablation.h"
#include "bindings_frame_stream.h"
#include "bindings_pipelines.h"
#include "bindings_presentation.h"
#include "bindings_state.h"
#include "mystral/platform/window.h"
#include "mystral/cold_start.h"
#include "mystral/pump_silence.h"
#include "mystral/js/engine.h"
#include "mystral/stall_budget.h"
#include "mystral/webgpu/bindings.h"
#include "bindings_resources.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <iostream>
#include <limits>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#if defined(__APPLE__)
#include <os/log.h>
#endif

#if defined(__ANDROID__)
#include <android/log.h>
#include <jni.h>
#endif

#if defined(MYSTRAL_WEBGPU_WGPU) || defined(MYSTRAL_WEBGPU_DAWN)
#include <webgpu/webgpu.h>

#if defined(MYSTRAL_WEBGPU_WGPU)
#if __has_include(<webgpu/wgpu.h>)
#include <webgpu/wgpu.h>
#else
#include <wgpu/wgpu.h>
#endif
#endif
#include "mystral/webgpu_compat.h"
#endif

namespace mystral {
namespace webgpu {
bool isSrgbSurfaceFormat(WGPUTextureFormat format) {
    return format == WGPUTextureFormat_RGBA8UnormSrgb ||
           format == WGPUTextureFormat_BGRA8UnormSrgb;
}

WGPUTextureFormat linearSurfaceFormat(WGPUTextureFormat format) {
    if (format == WGPUTextureFormat_RGBA8UnormSrgb) return WGPUTextureFormat_RGBA8Unorm;
    if (format == WGPUTextureFormat_BGRA8UnormSrgb) return WGPUTextureFormat_BGRA8Unorm;
    return format;
}

static const char* presentModeName(WGPUPresentMode mode) {
    switch (mode) {
        case WGPUPresentMode_Immediate: return "immediate";
        case WGPUPresentMode_Mailbox: return "mailbox";
        case WGPUPresentMode_Fifo: return "fifo";
        default: return "unknown";
    }
}

void reportSurfaceFormatMarker(WGPUTextureFormat nativeFormat,
                               WGPUTextureFormat renderFormat,
                               bool usesSrgbBridge,
                               WGPUPresentMode presentMode) {
    std::cout << "TN_SURFACE_FORMAT:{\"native\":\"" << formatToString(nativeFormat)
              << "\",\"render\":\"" << formatToString(renderFormat)
              << "\",\"bridge\":" << (usesSrgbBridge ? "true" : "false")
              << ",\"present\":\"" << presentModeName(presentMode) << "\"}" << std::endl;
}

static bool readCanvasDimension(
    BindingsState* state,
    js::JSValueHandle canvas,
    const char* propertyName,
    uint32_t& dimension
) {
    if (!state->engine || state->engine->isNull(canvas) || state->engine->isUndefined(canvas)) return false;

    const double value = state->engine->toNumber(state->engine->getProperty(canvas, propertyName));
    if (!std::isfinite(value) || value <= 0 || std::floor(value) != value ||
        value > static_cast<double>(std::numeric_limits<uint32_t>::max())) {
        return false;
    }

    dimension = static_cast<uint32_t>(value);
    return true;
}

/** Synchronize render resolution separately from the physical presentation extent. */
bool syncSurfaceSizeToCanvas(BindingsState* state, js::JSValueHandle canvas) {
    if (!state->surface) return true;

    uint32_t width = 0;
    uint32_t height = 0;
    if (!readCanvasDimension(state, canvas, "width", width) ||
        !readCanvasDimension(state, canvas, "height", height)) {
        return false;
    }
    int drawableWidth = 0;
    int drawableHeight = 0;
    if (!platform::getWindowDrawableSize(state->presentation.surfaceNativeHandle,
                                         &drawableWidth, &drawableHeight)) {
        state->engine->throwException("Native drawable dimensions are unavailable");
        return false;
    }
    const uint32_t surfaceWidth = static_cast<uint32_t>(drawableWidth);
    const uint32_t surfaceHeight = static_cast<uint32_t>(drawableHeight);
    const bool surfaceChanged = surfaceWidth != state->presentation.surfaceWidth ||
                                surfaceHeight != state->presentation.surfaceHeight;
    if (!surfaceChanged && width == state->presentation.canvasWidth &&
        height == state->presentation.canvasHeight) return true;

    // A canvas change invalidates an offscreen frame just as it invalidates a direct frame.
    // Replay first: deferred commands still name these view IDs. Drop the old SurfaceOutput
    // before configuring a real window resize, without adding an extra present.
    if (state->presentation.currentTexture != nullptr) {
        if (!flushRecordedFrameOps(state)) return false;
        state->presentation.framePresentPending = false;
        releaseCurrentSurfaceTextureViews(state);
        if (state->presentation.currentSurfaceTextureId != 0) {
            state->registries.textureRegistry.erase(state->presentation.currentSurfaceTextureId);
            state->presentation.currentSurfaceTextureId = 0;
        }
        wgpuTextureRelease(state->presentation.currentTexture);
        state->presentation.currentTexture = nullptr;
        state->presentation.surfaceRenderEncoder = nullptr;
        state->presentation.surfaceRenderPassEnded = false;
    }

    if (surfaceChanged) {
        WGPUSurfaceConfiguration config = {};
        config.device = state->device;
        config.format = state->presentation.nativeSurfaceFormat;
        config.usage = WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_CopySrc;
        config.alphaMode = WGPUCompositeAlphaMode_Auto;
        config.width = surfaceWidth;
        config.height = surfaceHeight;
        config.presentMode = state->presentation.presentMode;
        configurePresentationSurface(state->surface, &config);
        state->presentation.surfaceWidth = surfaceWidth;
        state->presentation.surfaceHeight = surfaceHeight;
    }
    state->presentation.canvasWidth = width;
    state->presentation.canvasHeight = height;
    if (state->verboseLogging) {
        std::cout << "[WebGPU] Canvas " << width << "x" << height << ", drawable "
                  << surfaceWidth << "x" << surfaceHeight << std::endl;
    }
    return true;
}

bool requiresPresentationBridge(const BindingsState* state) {
    return state->presentation.requiresSrgbPresentationBridge ||
           state->presentation.canvasWidth != state->presentation.surfaceWidth ||
           state->presentation.canvasHeight != state->presentation.surfaceHeight;
}

/** Recover a genuinely stale swapchain without touching the canvas being presented. */
static bool reconfigureSurfaceForAcquire(BindingsState* state) {
    if (!state || !state->surface || state->presentation.surfaceWidth == 0 ||
        state->presentation.surfaceHeight == 0) return false;
    // Direct acquisition normally has no held output; refuse to reconfigure if it does.
    // Bridge presentation instead holds an offscreen canvas. Its source view has already
    // been passed to the blit, so releasing its aliases here would use a freed view.
    if (state->presentation.currentTexture && !requiresPresentationBridge(state)) return false;

    WGPUSurfaceConfiguration config = {};
    config.device = state->device;
    config.format = state->presentation.nativeSurfaceFormat;
    config.usage = WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_CopySrc;
    config.alphaMode = WGPUCompositeAlphaMode_Auto;
    config.width = state->presentation.surfaceWidth;
    config.height = state->presentation.surfaceHeight;
    config.presentMode = state->presentation.presentMode;
    configurePresentationSurface(state->surface, &config);
    return true;
}

/**
 * Acquires the current surface image, rebuilding the swapchain once when it reports itself stale.
 * Ownership of the returned texture is the caller's, exactly as the raw call's is.
 */
static void acquireSurfaceImage(BindingsState* state, WGPUSurfaceTexture* surfaceTexture) {
    acquirePresentationSurface(state->surface, surfaceTexture);
    if (!wgpuSurfaceTextureStatusNeedsReconfigure(surfaceTexture->status)) return;
    if (surfaceTexture->texture) wgpuTextureRelease(surfaceTexture->texture);
    surfaceTexture->texture = nullptr;
    if (!reconfigureSurfaceForAcquire(state)) return;
    acquirePresentationSurface(state->surface, surfaceTexture);
}

void trackCurrentSurfaceTextureView(BindingsState* state, uint64_t viewId, WGPUTextureView view) {
    if (!state || !view) return;
    state->presentation.currentSurfaceTextureViews[viewId] = view;
    state->presentation.currentTextureView = view;
    state->presentation.currentViewSourceTexture = state->presentation.currentTexture;
}

void untrackCurrentSurfaceTextureView(BindingsState* state, uint64_t viewId) {
    if (!state) return;
    const auto found = state->presentation.currentSurfaceTextureViews.find(viewId);
    if (found == state->presentation.currentSurfaceTextureViews.end()) return;
    const WGPUTextureView removed = found->second;
    state->presentation.currentSurfaceTextureViews.erase(found);
    if (state->presentation.currentTextureView == removed) {
        state->presentation.currentTextureView = state->presentation.currentSurfaceTextureViews.empty()
                                                     ? nullptr
                                                     : state->presentation.currentSurfaceTextureViews.begin()->second;
    }
}

bool isCurrentSurfaceTextureView(const BindingsState* state, WGPUTextureView view) {
    if (!state || !view) return false;
    for (const auto& [id, tracked] : state->presentation.currentSurfaceTextureViews) {
        (void)id;
        if (tracked == view) return true;
    }
    return false;
}

void releaseCurrentSurfaceTextureViews(BindingsState* state) {
    if (!state) return;
    for (const auto& [viewId, view] : state->presentation.currentSurfaceTextureViews) {
        if (state->registries.textureViewRegistry.erase(viewId) != 0 && view)
            wgpuTextureViewRelease(view);
    }
    state->presentation.currentSurfaceTextureViews.clear();
    state->presentation.currentTextureView = nullptr;
    state->presentation.currentViewSourceTexture = nullptr;
}

static WGPUTexture createLinearPresentationTexture(BindingsState* state) {
    WGPUTextureDescriptor descriptor = {};
    descriptor.size = {state->presentation.canvasWidth, state->presentation.canvasHeight, 1};
    descriptor.mipLevelCount = 1;
    descriptor.sampleCount = 1;
    descriptor.dimension = WGPUTextureDimension_2D;
    descriptor.format = state->presentation.surfaceFormat;
    descriptor.usage = WGPUTextureUsage_RenderAttachment |
                       WGPUTextureUsage_TextureBinding |
                       WGPUTextureUsage_CopySrc;
    return wgpuDeviceCreateTexture(state->device, &descriptor);
}

static bool ensureSrgbPresentationPipeline(BindingsState* state) {
    if (state->presentation.srgbPresentationPipeline)
        return true;

    const std::string shaderCode = std::string("const decodeSrgb = ") +
        (state->presentation.requiresSrgbPresentationBridge ? "true;\n" : "false;\n") + R"(
        @group(0) @binding(0) var sourceTexture: texture_2d<f32>;
        struct VertexOutput {
            @builtin(position) position: vec4f,
            @location(0) uv: vec2f,
        };

        @vertex
        fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
            var positions = array<vec2f, 3>(
                vec2f(-1.0, -1.0),
                vec2f(3.0, -1.0),
                vec2f(-1.0, 3.0)
            );
            let position = positions[vertexIndex];
            var output: VertexOutput;
            output.position = vec4f(position, 0.0, 1.0);
            output.uv = position * vec2f(0.5, -0.5) + vec2f(0.5);
            return output;
        }

        fn srgbToLinear(value: vec3f) -> vec3f {
            let low = value / 12.92;
            let high = pow((value + 0.055) / 1.055, vec3f(2.4));
            return select(high, low, value <= vec3f(0.04045));
        }

        @fragment
        fn fs_main(input: VertexOutput) -> @location(0) vec4f {
            let size = textureDimensions(sourceTexture);
            let pixel = clamp(vec2i(input.uv * vec2f(size)), vec2i(0), vec2i(size) - vec2i(1));
            let encoded = textureLoad(sourceTexture, pixel, 0);
            if (decodeSrgb) { return vec4f(srgbToLinear(encoded.rgb), encoded.a); }
            return encoded;
        }
    )";

    WGPUShaderModuleWGSLDescriptor_Compat wgslDescriptor = {};
    WGPUShaderModuleDescriptor shaderDescriptor = {};
    setupShaderModuleWGSL(&shaderDescriptor, &wgslDescriptor, shaderCode.c_str());
    WGPUShaderModule shaderModule = wgpuDeviceCreateShaderModule(state->device, &shaderDescriptor);
    if (!shaderModule) return false;

    WGPUBindGroupLayoutEntry bindGroupEntry = {};
    bindGroupEntry.binding = 0;
    bindGroupEntry.visibility = WGPUShaderStage_Fragment;
    bindGroupEntry.texture.sampleType = WGPUTextureSampleType_Float;
    bindGroupEntry.texture.viewDimension = WGPUTextureViewDimension_2D;
    bindGroupEntry.texture.multisampled = false;

    WGPUBindGroupLayoutDescriptor bindGroupLayoutDescriptor = {};
    bindGroupLayoutDescriptor.entryCount = 1;
    bindGroupLayoutDescriptor.entries = &bindGroupEntry;
    state->presentation.srgbPresentationBindGroupLayout =
        wgpuDeviceCreateBindGroupLayout(state->device, &bindGroupLayoutDescriptor);
    if (!state->presentation.srgbPresentationBindGroupLayout) {
        wgpuShaderModuleRelease(shaderModule);
        return false;
    }

    WGPUPipelineLayoutDescriptor pipelineLayoutDescriptor = {};
    pipelineLayoutDescriptor.bindGroupLayoutCount = 1;
    pipelineLayoutDescriptor.bindGroupLayouts = &state->presentation.srgbPresentationBindGroupLayout;
    WGPUPipelineLayout pipelineLayout =
        wgpuDeviceCreatePipelineLayout(state->device, &pipelineLayoutDescriptor);
    if (!pipelineLayout) {
        wgpuBindGroupLayoutRelease(state->presentation.srgbPresentationBindGroupLayout);
        state->presentation.srgbPresentationBindGroupLayout = nullptr;
        wgpuShaderModuleRelease(shaderModule);
        return false;
    }

    WGPUColorTargetState colorTarget = {};
    colorTarget.format = state->presentation.nativeSurfaceFormat;
    colorTarget.writeMask = WGPUColorWriteMask_All;

    WGPUFragmentState fragmentState = {};
    fragmentState.module = shaderModule;
    WGPU_SET_ENTRY_POINT(fragmentState, "fs_main");
    fragmentState.targetCount = 1;
    fragmentState.targets = &colorTarget;

    WGPURenderPipelineDescriptor pipelineDescriptor = {};
    pipelineDescriptor.layout = pipelineLayout;
    pipelineDescriptor.vertex.module = shaderModule;
    WGPU_SET_ENTRY_POINT(pipelineDescriptor.vertex, "vs_main");
    pipelineDescriptor.fragment = &fragmentState;
    pipelineDescriptor.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    pipelineDescriptor.multisample.count = 1;
    pipelineDescriptor.multisample.mask = 0xffffffff;
    state->presentation.srgbPresentationPipeline = wgpuDeviceCreateRenderPipeline(state->device, &pipelineDescriptor);

    wgpuPipelineLayoutRelease(pipelineLayout);
    wgpuShaderModuleRelease(shaderModule);
    if (!state->presentation.srgbPresentationPipeline) {
        wgpuBindGroupLayoutRelease(state->presentation.srgbPresentationBindGroupLayout);
        state->presentation.srgbPresentationBindGroupLayout = nullptr;
        return false;
    }
    return true;
}

bool blitPresentationTexture(BindingsState* state, WGPUTextureView sourceView,
                             WGPUTextureView surfaceView) {
    if (!sourceView || !surfaceView || !ensureSrgbPresentationPipeline(state)) return false;
    WGPUBindGroupEntry bindGroupEntry = {};
    bindGroupEntry.binding = 0;
    bindGroupEntry.textureView = sourceView;
    WGPUBindGroupDescriptor bindGroupDescriptor = {};
    bindGroupDescriptor.layout = state->presentation.srgbPresentationBindGroupLayout;
    bindGroupDescriptor.entryCount = 1;
    bindGroupDescriptor.entries = &bindGroupEntry;
    WGPUBindGroup bindGroup = wgpuDeviceCreateBindGroup(state->device, &bindGroupDescriptor);
    if (!bindGroup) {
        return false;
    }

    WGPUCommandEncoderDescriptor encoderDescriptor = {};
    WGPUCommandEncoder encoder = wgpuDeviceCreateCommandEncoder(state->device, &encoderDescriptor);
    if (!encoder) {
        wgpuBindGroupRelease(bindGroup);
        return false;
    }
    WGPURenderPassColorAttachment colorAttachment = {};
    colorAttachment.view = surfaceView;
    colorAttachment.loadOp = WGPULoadOp_Clear;
    colorAttachment.storeOp = WGPUStoreOp_Store;
    colorAttachment.clearValue = {0.0, 0.0, 0.0, 1.0};
#if defined(MYSTRAL_WEBGPU_DAWN)
    colorAttachment.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
#endif
    WGPURenderPassDescriptor renderPassDescriptor = {};
    renderPassDescriptor.colorAttachmentCount = 1;
    renderPassDescriptor.colorAttachments = &colorAttachment;
    WGPURenderPassEncoder renderPass =
        wgpuCommandEncoderBeginRenderPass(encoder, &renderPassDescriptor);
    if (!renderPass) {
        wgpuCommandEncoderRelease(encoder);
        wgpuBindGroupRelease(bindGroup);
        return false;
    }
    wgpuRenderPassEncoderSetPipeline(renderPass, state->presentation.srgbPresentationPipeline);
    wgpuRenderPassEncoderSetBindGroup(renderPass, 0, bindGroup, 0, nullptr);
    wgpuRenderPassEncoderDraw(renderPass, 3, 1, 0, 0);
    wgpuRenderPassEncoderEnd(renderPass);
    wgpuRenderPassEncoderRelease(renderPass);

    WGPUCommandBufferDescriptor commandBufferDescriptor = {};
    WGPUCommandBuffer commandBuffer =
        wgpuCommandEncoderFinish(encoder, &commandBufferDescriptor);
    const bool encoded = commandBuffer != nullptr;
    if (encoded) {
        flushUploadStaging(state);
        wgpuQueueSubmit(state->queue, 1, &commandBuffer);
    }

    if (commandBuffer) wgpuCommandBufferRelease(commandBuffer);
    wgpuCommandEncoderRelease(encoder);
    wgpuBindGroupRelease(bindGroup);
    return encoded;
}

static void reportSurfaceAcquireFailure(uint32_t status);

static bool presentLinearTextureToSrgbSurface(BindingsState* state, WGPUTextureView sourceView) {
    if (!sourceView) return false;
    WGPUSurfaceTexture surfaceTexture = {};
    acquireSurfaceImage(state, &surfaceTexture);
    if (!wgpuSurfaceTextureStatusIsSuccess(surfaceTexture.status) || !surfaceTexture.texture) {
        if (surfaceTexture.texture) wgpuTextureRelease(surfaceTexture.texture);
        reportSurfaceAcquireFailure(static_cast<uint32_t>(surfaceTexture.status));
        return false;
    }
    WGPUTextureViewDescriptor surfaceViewDescriptor = {};
    surfaceViewDescriptor.format = state->presentation.nativeSurfaceFormat;
    surfaceViewDescriptor.dimension = WGPUTextureViewDimension_2D;
    surfaceViewDescriptor.mipLevelCount = 1;
    surfaceViewDescriptor.arrayLayerCount = 1;
    surfaceViewDescriptor.aspect = WGPUTextureAspect_All;
    WGPUTextureView surfaceView = wgpuTextureCreateView(surfaceTexture.texture, &surfaceViewDescriptor);
    const bool encoded = blitPresentationTexture(state, sourceView, surfaceView);
    if (encoded) wgpuSurfacePresent(state->surface);
    if (surfaceView) wgpuTextureViewRelease(surfaceView);
    wgpuTextureRelease(surfaceTexture.texture);
    return encoded;
}

/**
 * Names a frame the loop rendered and never presented, at most once a second.
 *
 * A present is suppressed silently by three separate conditions - no surface, no acquired
 * swapchain texture, and a frame whose replay never ended a render pass on the surface - and none
 * of them said anything. A real game hit the third one at the moment its first world frame
 * replaced the loading screen: the JavaScript side went on rendering at 59 fps with a `render`
 * phase of 16.5 ms per frame, presents stopped dead at 137, and the window showed the same
 * five-second-old picture for the rest of the run with nothing in the log. Say which condition it
 * is, once a second, so the next one is a grep and not an afternoon.
 */
static void reportUnpresentedFrame(BindingsState* state, bool pending) {
    static uint64_t suppressed = 0;
    static std::chrono::steady_clock::time_point lastReport{};
    // Consecutive one-second reports, and whether this run's title currently carries the stall.
    static uint64_t stalledSeconds = 0;
    static bool titleCarriesStall = false;
    // A stall this long is not a hitch: say it where a developer is already looking, because a
    // marker in stdout is invisible to anyone watching the window, and a frozen picture with no
    // explanation is the failure this escalation exists to end.
    static constexpr uint64_t kStallSeconds = 3;
    if (pending && state->presentation.currentTexture && state->surface) {
        suppressed = 0;
        stalledSeconds = 0;
        if (titleCarriesStall) {
            mystral::platform::setWindowTitle(nullptr);
            titleCarriesStall = false;
        }
        return;
    }
    const auto now = std::chrono::steady_clock::now();
    const bool first = lastReport.time_since_epoch().count() == 0;
    if (!first && now - lastReport < std::chrono::seconds(1)) {
        suppressed += 1;
        return;
    }
    lastReport = now;
    std::cout << "TN_FRAME_NOT_PRESENTED:{\"pending\":" << (pending ? "true" : "false")
              << ",\"texture\":" << (state->presentation.currentTexture ? "true" : "false")
              << ",\"surface\":" << (state->surface ? "true" : "false")
              << ",\"renderPassEnded\":"
              << (state->presentation.surfaceRenderPassEnded ? "true" : "false")
              << ",\"suppressed\":" << suppressed << "}" << std::endl;
    suppressed = 0;
    stalledSeconds += 1;
    if (stalledSeconds < kStallSeconds) return;
    // Name the condition in the title, not just "stalled": the three conditions are different bugs.
    const char* condition = !state->surface                 ? "no surface"
                            : !state->presentation.currentTexture ? "no swapchain texture"
                                                                  : "a render pass never ended";
    std::string title = std::string("ThreeNative - no frames presented: ") + condition;
    mystral::platform::setWindowTitle(title.c_str());
    titleCarriesStall = true;
}

/**
 * Names a failed swapchain acquire, at most once a second and always the first one.
 *
 * `TN_SURFACE_ACQUIRE_FAILED` is the marker a logcat filter finds when a device shows a black
 * screen; the status is wgpu's own `WGPUSurfaceGetCurrentTextureStatus`, so an outdated or lost
 * surface is distinguishable from a device that simply has no window.
 */
static void reportSurfaceAcquireFailure(uint32_t status) {
    static uint64_t suppressed = 0;
    static std::chrono::steady_clock::time_point lastReport{};
    const auto now = std::chrono::steady_clock::now();
    const bool first = lastReport.time_since_epoch().count() == 0;
    if (!first && now - lastReport < std::chrono::seconds(1)) {
        suppressed += 1;
        return;
    }
    lastReport = now;
    std::ostringstream out;
    out << "TN_SURFACE_ACQUIRE_FAILED:{\"status\":" << status << ",\"suppressed\":" << suppressed
        << "}";
    suppressed = 0;
    const std::string marker = out.str();
    std::cerr << "[WebGPU] " << marker << " the surface handed out no texture, so this frame "
                 "presents nothing" << std::endl;
#if defined(__ANDROID__)
    __android_log_print(ANDROID_LOG_ERROR, "MystralRuntime", "%s", marker.c_str());
#endif
}

/**
 * Get the current swapchain texture (or offscreen texture in no-SDL mode)
 */
WGPUTexture getCurrentSwapchainTexture(BindingsState* state) {
#if defined(MYSTRAL_WEBGPU_WGPU) || defined(MYSTRAL_WEBGPU_DAWN)
    // In no-SDL mode, use the offscreen texture
    if (!state->surface) {
        if (state->presentation.offscreenTexture) {
            return state->presentation.offscreenTexture;
        }
        std::cerr << "[WebGPU] No surface and no offscreen texture available" << std::endl;
        return nullptr;
    }

    if (requiresPresentationBridge(state)) {
        return createLinearPresentationTexture(state);
    }

    WGPUSurfaceTexture surfaceTexture = {};
    acquireSurfaceImage(state, &surfaceTexture);

    if (!wgpuSurfaceTextureStatusIsSuccess(surfaceTexture.status) || !surfaceTexture.texture) {
        // The API returns texture ownership even when the caller cannot use the result.
        // Never strand an acquired image on a rejected status; null remains a named failure.
        if (surfaceTexture.texture) wgpuTextureRelease(surfaceTexture.texture);
        // Fail by name. A surface that stops handing out images presents nothing, and the loop is
        // no longer paced by presenting, so this fires hundreds of times a second, which is
        // precisely how the resume defect looked from the outside: frames running away, presents
        // frozen, a black screen, and no line in the log that said why. Rate-limited so the marker
        // stays readable instead of becoming a flood.
        reportSurfaceAcquireFailure(static_cast<uint32_t>(surfaceTexture.status));
        return nullptr;
    }

    return surfaceTexture.texture;
#else
    return nullptr;
#endif
}

uint64_t presentCount(BindingsState* state) { return state->profiling.presentCount; }

/**
 * Drops every reference to the live presentation surface, ahead of a rebuild.
 *
 * Android destroys the `ANativeWindow` behind a backgrounded app, so on resume the surface is
 * replaced rather than reconfigured. Any swapchain image acquired and not yet presented has to be
 * released first: wgpu-native refuses to tear a surface down with an outstanding `SurfaceOutput`
 * ("`SurfaceOutput` must be dropped before a new `Surface` is made") and that panic aborts the
 * process, which is how PRD-183's silent SIGABRT happened on the resize path.
 */
void detachSurfaceForRebuild(BindingsState* state) {
#if defined(MYSTRAL_WEBGPU_WGPU) || defined(MYSTRAL_WEBGPU_DAWN)
    if (!state) return;
    state->presentation.framePresentPending = false;
    releaseCurrentSurfaceTextureViews(state);
    if (state->presentation.currentSurfaceTextureId != 0) {
        state->registries.textureRegistry.erase(state->presentation.currentSurfaceTextureId);
        state->presentation.currentSurfaceTextureId = 0;
    }
    if (state->presentation.currentTexture != nullptr) {
        wgpuTextureRelease(state->presentation.currentTexture);
        state->presentation.currentTexture = nullptr;
    }
    state->presentation.currentViewSourceTexture = nullptr;
    state->presentation.surfaceRenderEncoder = nullptr;
    state->presentation.surfaceRenderPassEnded = false;
    state->screenshot.screenshotCapturedThisFrame = false;
    state->surface = nullptr;
    state->presentation.surfaceNativeHandle = nullptr;
#else
    (void)state;
#endif
}

/**
 * Publishes a rebuilt surface to the bindings, which is where every present reads it from.
 *
 * Without this the host would hold a fresh surface and JavaScript would keep presenting to the
 * dead one: the resume defect again, one indirection later.
 */
void republishSurface(BindingsState* state, void* wgpuSurface, uint32_t surfaceFormat,
                      uint32_t presentMode, uint32_t width, uint32_t height,
                      void* surfaceNativeHandle) {
#if defined(MYSTRAL_WEBGPU_WGPU) || defined(MYSTRAL_WEBGPU_DAWN)
    if (!state) return;
    if (state->presentation.nativeSurfaceFormat != static_cast<WGPUTextureFormat>(surfaceFormat)) {
        if (state->presentation.srgbPresentationPipeline)
            wgpuRenderPipelineRelease(state->presentation.srgbPresentationPipeline);
        if (state->presentation.srgbPresentationBindGroupLayout)
            wgpuBindGroupLayoutRelease(state->presentation.srgbPresentationBindGroupLayout);
        state->presentation.srgbPresentationPipeline = nullptr;
        state->presentation.srgbPresentationBindGroupLayout = nullptr;
    }
    state->surface = (WGPUSurface)wgpuSurface;
    state->presentation.surfaceNativeHandle = surfaceNativeHandle;
    state->presentation.presentMode = static_cast<WGPUPresentMode>(presentMode);
    state->presentation.nativeSurfaceFormat = (WGPUTextureFormat)surfaceFormat;
    state->presentation.requiresSrgbPresentationBridge =
        state->surface != nullptr && isSrgbSurfaceFormat(state->presentation.nativeSurfaceFormat);
    state->presentation.surfaceFormat = state->presentation.requiresSrgbPresentationBridge
                                            ? linearSurfaceFormat(state->presentation.nativeSurfaceFormat)
                                            : state->presentation.nativeSurfaceFormat;
    // A rebuilt drawable does not change the renderer's canvas backing resolution.
    state->presentation.surfaceWidth = width;
    state->presentation.surfaceHeight = height;
    reportSurfaceFormatMarker(state->presentation.nativeSurfaceFormat,
                              state->presentation.surfaceFormat,
                              state->presentation.requiresSrgbPresentationBridge,
                              state->presentation.presentMode);
    std::cout << "[WebGPU] Surface republished to bindings: " << wgpuSurface << " " << width << "x" << height
              << " (format=" << state->presentation.surfaceFormat << ")" << std::endl;
#else
    (void)state; (void)wgpuSurface; (void)surfaceFormat; (void)presentMode; (void)width; (void)height;
    (void)surfaceNativeHandle;
#endif
}

void setOffscreenTexture(BindingsState* state, void* texture, void* textureView) {
    state->presentation.offscreenTexture = (WGPUTexture)texture;
    state->presentation.offscreenTextureView = (WGPUTextureView)textureView;
    if (state->verboseLogging) std::cout << "[WebGPU] Offscreen texture set for headless rendering" << std::endl;
}

/**
 * Presents the frame, once, after every rAF callback has returned.
 *
 * The surface used to be presented from inside `queue.submit`. That is wrong for any frame that
 * submits more than once — three.js renders the world and then the framework renders the canvas
 * layer as a second pass — because each submit acquired and presented its own swapchain image.
 * Only the first reached the display, so overlays drew into an image nobody ever saw. Acquisition
 * is idempotent within a frame (see the canvas `getCurrentTexture` binding) and the present
 * happens here, so both passes land on one image and that image is presented once.
 */
void presentPendingSurface(BindingsState* state) {
    // Exactly one acquire and one release per frame, whether or not anything was presented.
    // Returning early without releasing would strand the acquired swapchain image, and because
    // acquisition is idempotent within a frame every later frame would reuse that stranded image
    // and never present again — a black screen from the first frame that renders nothing.
    // Capture before presenting: the surface texture is still alive and now carries every pass.
    captureFrameScreenshot(state);
    const bool pending = state->presentation.framePresentPending;
    state->presentation.framePresentPending = false;
    reportUnpresentedFrame(state, pending);
    if (!state->presentation.currentTexture)
        return;

    if (pending && state->surface) {
        if (state->verboseLogging)
            std::cout << "[WebGPU] Presenting surface" << std::endl;
        const auto presentStart = std::chrono::steady_clock::now();
        const uint64_t presentThreadCpuStart = readRenderThreadCpuNs();
        const bool presented = requiresPresentationBridge(state)
                                   ? presentLinearTextureToSrgbSurface(state, state->presentation.currentTextureView)
                                   : (wgpuSurfacePresent(state->surface), true);
        const uint64_t presentThreadCpuEnd = readRenderThreadCpuNs();
        state->profiling.lastPresentThreadCpuNs =
            presentThreadCpuEnd > presentThreadCpuStart ? presentThreadCpuEnd - presentThreadCpuStart : 0;
        state->profiling.lastPresentNs = static_cast<uint64_t>(
            std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now() - presentStart)
                .count());
#if TN_ANDROID_JS_PROFILE
        state->profiling.presentReportedSinceLastPresent = false;
#endif

        if (presented) {
            state->profiling.presentCount += 1;
            const bool hasSurfaceView = state->presentation.currentTextureView != nullptr;
            std::cout << "TN_SURFACE_FRAME:{\"view\":" << (hasSurfaceView ? "true" : "false")
                      << ",\"present\":" << state->profiling.presentCount << "}" << std::endl;
#if defined(__ANDROID__)
            __android_log_print(ANDROID_LOG_INFO, "MystralRuntime",
                                "TN_SURFACE_FRAME:{\"view\":%s,\"present\":%llu}",
                                hasSurfaceView ? "true" : "false",
                                static_cast<unsigned long long>(state->profiling.presentCount));
#endif
            // The last cold-start segment. Emitted from the present that actually reached the
            // display, so "first frame" means the player saw something rather than the loop merely ran.
            if (!state->profiling.firstPresentReported) {
                state->profiling.firstPresentReported = true;
                reportPipelineFirstPresent();
                mystral::coldStartMark("first_frame");
                // PRD-360 bounded endpoint: the trailing pump interval is
                // measured here, beside first_frame on the same clock.
                mystral::pumpSilence().flush(mystral::coldStartNowMs());
                // Same clock, same instant: the attribution for everything that happened before this
                // present, reported against the gap the player just sat through. PRD-218.
                mystral::stallBudget().report(mystral::coldStartNowMs());
            }
            // Hitches are what the player feels after launch, and they are invisible to a mean.
            // This frame's drain of the late-compile accumulator rides along, so a synchronous
            // pipeline compile mid-game is a named hitch, not an anonymous spike (PRD-327 Phase 4).
            const mystral::StallBudget::PostPresentCompile lateCompile =
                mystral::stallBudget().takePostPresentPipelineCompile();
            mystral::frameHitches().record(lateCompile.ms, lateCompile.calls);
            // The pipeline capture's live boundary, taken from a frame that reached the display so
            // the counts are read at an instant a reader can name. Prints only when they changed,
            // and says nothing about whether the game is playable — see reportPipelineCheckpoint.
            reportPipelineCheckpoint(state, state->profiling.presentCount);
            pollPipelineCachePersistence(state);
        } else {
            std::cerr << "[WebGPU] Canvas presentation bridge failed" << std::endl;
        }
    }

    // Reset surface render tracking for the next frame.
    state->presentation.surfaceRenderEncoder = nullptr;
    state->presentation.surfaceRenderPassEnded = false;
    state->screenshot.screenshotCapturedThisFrame = false;

    releaseCurrentSurfaceTextureViews(state);

    // Drop every alias so screenshot capture cannot dereference the just-presented surface
    // texture or the consumed linear bridge texture.
    if (state->presentation.currentSurfaceTextureId != 0) {
        state->registries.textureRegistry.erase(state->presentation.currentSurfaceTextureId);
        state->presentation.currentSurfaceTextureId = 0;
    }
    wgpuTextureRelease(state->presentation.currentTexture);
    state->presentation.currentTexture = nullptr;
    state->presentation.currentViewSourceTexture = nullptr;
}

/**
 * Reports frames and presents together, periodically, on every platform.
 *
 * The desktop CLI prints `TN_PRESENTS:<n>` once, at the end of a fixed-frame screenshot run. A
 * device run has no end: the app launches and keeps rendering, so a gate on Android or iOS has
 * nothing to read. Frames and presents are emitted as a pair because the number alone proves
 * nothing — the defect this guards was presents outrunning frames, and only the ratio shows it.
 * On Android `std::cout` goes nowhere, so this also writes to logcat.
 */
void reportPresentTick(BindingsState* state, uint64_t frames) {
    std::ostringstream output;
    output << "TN_PRESENTS_TICK:{\"frames\":" << frames << ",\"presents\":" << state->profiling.presentCount
           << ",\"textureMB\":" << (state->profiling.textureBytesLive / 1048576)
           << ",\"textures\":" << state->profiling.textureCountLive
           << ",\"bufferMB\":" << (state->profiling.bufferBytesLive / 1048576) << ",\"capHz\":" << getPresentationCapHz()
           << "}";
    const std::string marker = output.str();
    std::cout << marker << std::endl;
#if defined(__ANDROID__)
    __android_log_print(ANDROID_LOG_INFO, "MystralRuntime", "%s", marker.c_str());
#endif
    // The per-bucket breakdown is the part that names a cause, so it goes out periodically rather
    // than every tick: the running total above is enough to watch growth, and this answers "which
    // allocation" once a run has settled.
    if ((state->profiling.reportTickIndex++ % 5) == 0 && !state->profiling.textureBuckets.empty()) {
        std::vector<std::pair<std::string, std::pair<uint64_t, uint64_t>>> sorted(
            state->profiling.textureBuckets.begin(), state->profiling.textureBuckets.end());
        std::sort(sorted.begin(), sorted.end(), [](const auto& a, const auto& b) {
            return a.second.second > b.second.second;
        });
        std::ostringstream buckets;
        buckets << "TN_GPU_TEXTURES:{\"totalMB\":" << (state->profiling.textureBytesLive / 1048576)
                << ",\"count\":" << state->profiling.textureCountLive << ",\"buckets\":[";
        const size_t limit = sorted.size() < 12 ? sorted.size() : 12;
        for (size_t i = 0; i < limit; i += 1) {
            if (i > 0) buckets << ",";
            buckets << "{\"k\":\"" << sorted[i].first << "\",\"n\":" << sorted[i].second.first
                    << ",\"mb\":" << (sorted[i].second.second / 1048576) << "}";
        }
        buckets << "],\"bucketsTotal\":" << sorted.size() << "}";
        const std::string bucketMarker = buckets.str();
        std::cout << bucketMarker << std::endl;
#if defined(__ANDROID__)
        __android_log_print(ANDROID_LOG_INFO, "MystralRuntime", "%s", bucketMarker.c_str());
#endif
        std::vector<std::pair<std::string, std::pair<uint64_t, uint64_t>>> bufferSorted(
            state->profiling.bufferBuckets.begin(), state->profiling.bufferBuckets.end());
        std::sort(bufferSorted.begin(), bufferSorted.end(), [](const auto& a, const auto& b) {
            return a.second.second > b.second.second;
        });
        std::ostringstream buffers;
        buffers << "TN_GPU_BUFFERS:{\"totalMB\":" << (state->profiling.bufferBytesLive / 1048576)
                << ",\"count\":" << state->profiling.bufferCountLive << ",\"buckets\":[";
        const size_t bufferLimit = bufferSorted.size() < 10 ? bufferSorted.size() : 10;
        for (size_t i = 0; i < bufferLimit; i += 1) {
            if (i > 0) buffers << ",";
            buffers << "{\"k\":\"" << bufferSorted[i].first << "\",\"n\":"
                    << bufferSorted[i].second.first << ",\"mb\":"
                    << (bufferSorted[i].second.second / 1048576) << "}";
        }
        buffers << "]}";
        const std::string bufferMarker = buffers.str();
        std::cout << bufferMarker << std::endl;
#if defined(__ANDROID__)
        __android_log_print(ANDROID_LOG_INFO, "MystralRuntime", "%s", bufferMarker.c_str());
#endif
    }
#if defined(__APPLE__)
    // The iOS gate reads the unified log, which `std::cout` does not reach -- the JSC console
    // calls NSLog beside its cout for the same reason. os_log is the C entry point to the same
    // place, so this stays in a .cpp.
    os_log(OS_LOG_DEFAULT, "%{public}s", marker.c_str());
#endif
}

js::JSValueHandle handleWebGpuPresentedCount(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args) {
    // Read-only count of the frames that reached the display. The JavaScript frame budget needs it
    // because its callback runs once per raf dispatch while `paceToPresentationCap` paces the
    // **present**, never the loop: a window that counted dispatches reported 2631 fps beside a host
    // that presented 133 frames in 1740. A private diagnostic seam, like `__tnPresentationCap`.
    (void)bindingDestination;
    (void)args;
    return state->engine->newNumber(static_cast<double>(state->profiling.presentCount));
}

js::JSValueHandle handleWebGpuPresentationCap(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args) {
    // Read with no argument, set with one. Hz, where 0 means uncapped and is the only way a game
    // presents above the ceiling. This global is a private diagnostic seam; the supported
    // game-facing override is static `display.maxFps` config, applied before the runtime starts.
    //
    // Fail closed on a rate the runtime cannot honour: a game that asks for -1 or 5000 has a bug,
    // and silently clamping it would make the next frame-rate measurement a fiction.
    if (args.empty()) return state->engine->newNumber(static_cast<double>(getPresentationCapHz()));
    const double requested = state->engine->toNumber(args[0]);
    const int32_t hz = static_cast<int32_t>(requested);
    if (!(requested >= 0.0) || requested > 1000.0 || static_cast<double>(hz) != requested) {
        state->engine->throwException(
            "TN_PRESENTATION_CAP_INVALID: the presentation cap is a whole number of frames "
            "per second between 0 (uncapped) and 1000.");
        return state->engine->newUndefined();
    }
    setPresentationCapHz(static_cast<uint32_t>(hz));
    return state->engine->newNumber(static_cast<double>(getPresentationCapHz()));
}
}  // namespace webgpu
}  // namespace mystral

#if defined(__ANDROID__)
// The activity's display signal, PRD-399. These touch only process-lifetime pacing state and no
// Java object, so a callback that is removed before the activity is destroyed cannot outlive
// anything it references.
extern "C" JNIEXPORT void JNICALL
Java_com_threenative_runtime_MystralActivity_nativeOnPresentationFrame(JNIEnv*, jclass, jlong at) {
    mystral::webgpu::notePresentationFrame(static_cast<int64_t>(at));
}

extern "C" JNIEXPORT void JNICALL
Java_com_threenative_runtime_MystralActivity_nativeOnPresentationFramesStarted(JNIEnv*, jclass) {
    mystral::webgpu::notePresentationFramesStarted();
}

extern "C" JNIEXPORT void JNICALL
Java_com_threenative_runtime_MystralActivity_nativeOnPresentationFramesStopped(JNIEnv*, jclass) {
    mystral::webgpu::notePresentationFramesStopped();
}
#endif
