/**
 * The native UI layer, composited into the game's own frame.
 *
 * PRD-393. On Linux the UI is a web view rendered offscreen (`native/ui-overlay`); this is the other
 * half of that seam — it uploads the completed frame and draws it as one premultiplied-alpha quad
 * over whatever the frame already holds, before `presentPendingSurface()` puts the frame on screen.
 *
 * Three things make this correct rather than merely working:
 *
 * - **One swapchain.** The quad goes onto the same texture the world rendered into, so the UI is
 *   presented by the same present as the world. It cannot be half a frame ahead of the scene, and
 *   no compositing manager can decide to hide it.
 * - **Linear, in both presentation modes.** The target is the *frame's* colour texture, which is the
 *   swapchain image on a direct surface and a linear offscreen texture when the sRGB presentation
 *   bridge is on. The fragment shader therefore always decodes the page's sRGB bytes and always
 *   writes linear premultiplied, which the hardware encodes on a `*-Srgb` target and the bridge
 *   encodes on a linear one. One shader, both modes, no mode check here.
 * - **Skipped when nothing changed.** The page publishes a counter that only moves when its pixels
 *   changed, so a still HUD re-uses the texture it already has and only pays for the draw.
 *
 * The page's bytes are cairo `ARGB32` premultiplied, which on a little-endian host is `B,G,R,A` —
 * exactly `BGRA8Unorm`, so the upload is a straight copy with no swizzle.
 */

#include "bindings_state.h"
#include "bindings_presentation.h"
#include "mystral/cold_start.h"
#include "mystral/platform/ui_overlay.h"
#include "mystral/webgpu/bindings.h"
#include "mystral/webgpu/checked_handle.h"

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <sstream>
#include <string>

#if defined(MYSTRAL_WEBGPU_WGPU) || defined(MYSTRAL_WEBGPU_DAWN)
#include <webgpu/webgpu.h>

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

namespace mystral {
namespace webgpu {

#if defined(MYSTRAL_WEBGPU_WGPU) || defined(MYSTRAL_WEBGPU_DAWN)
namespace {

/** The quad's sampler: linear, clamped, because the UI texture is not exactly the target size. */
WGPUSampler createUiSampler(BindingsState* state) {
    WGPUSamplerDescriptor descriptor = {};
    descriptor.magFilter = WGPUFilterMode_Linear;
    descriptor.minFilter = WGPUFilterMode_Linear;
    descriptor.mipmapFilter = WGPUMipmapFilterMode_Nearest;
    descriptor.addressModeU = WGPUAddressMode_ClampToEdge;
    descriptor.addressModeV = WGPUAddressMode_ClampToEdge;
    descriptor.addressModeW = WGPUAddressMode_ClampToEdge;
    descriptor.maxAnisotropy = 1;
    descriptor.lodMinClamp = 0.0f;
    descriptor.lodMaxClamp = 1.0f;
    return wgpuDeviceCreateSampler(state->device, &descriptor);
}

/**
 * Build the pipeline and bind group layout, targeting `format`.
 *
 * `format` is the frame's own colour format, not the surface's, and the ONE thing that differs
 * between presentation modes is whether anything downstream encodes. It is not simply "does the
 * target format name sRGB":
 *
 * - `bgra8unorm-srgb` surface, no bridge: the hardware encodes on write, so the shader writes
 *   **linear**. (Measured on this host: the surface is `bgra8unorm`, so this is the other case.)
 * - plain `bgra8unorm` surface, no bridge: nothing encodes, and the renderer's own shader is what
 *   makes the frame sRGB — so the UI shader must encode too, or the UI renders darker than the
 *   scene beside it. Measured exactly that before this branch existed: the page's `#eceddf` ink
 *   arrived on screen as `#d6d8bc`, which is `srgb_to_linear(#eceddf)` to the byte.
 * - sRGB presentation bridge on: the frame target is a **linear** intermediate that the bridge
 *   converts afterwards, so the shader writes linear and the bridge does the encoding.
 *
 * The branch is chosen when the pipeline is built, not per fragment: it is a property of where the
 * frame is going, and a shader that tested it every pixel would be a uniform read to decide what
 * the hardware already knew.
 */
bool ensureUiPipeline(BindingsState* state, WGPUTextureFormat format) {
    if (state->ui.pipeline != nullptr && state->ui.pipelineFormat == format) return true;
    if (state->ui.pipeline != nullptr) {
        // A reconfigured surface changed what we compose onto. Rebuild rather than draw the UI
        // through a pipeline whose target format no longer matches the attachment.
        wgpuRenderPipelineRelease(state->ui.pipeline);
        state->ui.pipeline = nullptr;
        if (state->ui.bindGroup != nullptr) {
            wgpuBindGroupRelease(state->ui.bindGroup);
            state->ui.bindGroup = nullptr;
        }
    }

    const bool targetEncodes = state->presentation.requiresSrgbPresentationBridge ||
                               isSrgbSurfaceFormat(format);
    const std::string encodeBody =
        targetEncodes ? "    return linear;\n" : "    return srgb_encode(linear);\n";

    const std::string shaderSource = std::string(R"(
        @group(0) @binding(0) var uiSampler: sampler;
        @group(0) @binding(1) var uiTexture: texture_2d<f32>;

        struct VertexOutput {
            @builtin(position) position: vec4f,
            @location(0) uv: vec2f,
        }

        @vertex
        fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
            var positions = array<vec2f, 6>(
                vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
                vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0)
            );
            var uvs = array<vec2f, 6>(
                vec2f(0.0, 1.0), vec2f(1.0, 1.0), vec2f(0.0, 0.0),
                vec2f(0.0, 0.0), vec2f(1.0, 1.0), vec2f(1.0, 0.0)
            );
            var output: VertexOutput;
            output.position = vec4f(positions[vertexIndex], 0.0, 1.0);
            output.uv = uvs[vertexIndex];
            return output;
        }

        fn srgb_to_linear(channel: vec3f) -> vec3f {
            let low = channel / 12.92;
            let high = pow((channel + vec3f(0.055)) / 1.055, vec3f(2.4));
            return select(high, low, channel <= vec3f(0.04045));
        }

        fn srgb_encode(linear: vec3f) -> vec3f {
            let low = linear * 12.92;
            let high = 1.055 * pow(linear, vec3f(0.4166666666)) - vec3f(0.055);
            return select(high, low, linear <= vec3f(0.0031308));
        }

        fn encode_for_target(linear: vec3f) -> vec3f {
)") + encodeBody + R"(        }

        @fragment
        fn fs_main(input: VertexOutput) -> @location(0) vec4f {
            // Premultiplied sRGB, which is what cairo hands over and what the page composites in.
            let sample = textureSample(uiTexture, uiSampler, input.uv);
            let alpha = sample.a;
            // Unpremultiply, decode, re-premultiply. Compositing sRGB numbers directly is what
            // makes antialiased text too dark; premultiplying before decoding is what makes it
            // wrong in a way that depends on coverage.
            let straight = select(sample.rgb / alpha, vec3f(0.0), alpha <= 0.0);
            let linear = srgb_to_linear(straight);
            return vec4f(encode_for_target(linear) * alpha, alpha);
        }
    )";

    WGPUShaderModuleWGSLDescriptor_Compat wgslDescriptor = {};
    WGPUShaderModuleDescriptor shaderDescriptor = {};
    setupShaderModuleWGSL(&shaderDescriptor, &wgslDescriptor, shaderSource.c_str());
    WGPUShaderModule shaderModule = wgpuDeviceCreateShaderModule(state->device, &shaderDescriptor);
    if (!requireHandleHostSide(shaderModule, "uiComposite.createShaderModule")) return false;

    WGPUBindGroupLayoutEntry layoutEntries[2] = {};
    layoutEntries[0].binding = 0;
    layoutEntries[0].visibility = WGPUShaderStage_Fragment;
    layoutEntries[0].sampler.type = WGPUSamplerBindingType_Filtering;
    layoutEntries[1].binding = 1;
    layoutEntries[1].visibility = WGPUShaderStage_Fragment;
    layoutEntries[1].texture.sampleType = WGPUTextureSampleType_Float;
    layoutEntries[1].texture.viewDimension = WGPUTextureViewDimension_2D;

    WGPUBindGroupLayoutDescriptor bindGroupLayoutDescriptor = {};
    bindGroupLayoutDescriptor.entryCount = 2;
    bindGroupLayoutDescriptor.entries = layoutEntries;
    WGPUBindGroupLayout bindGroupLayout =
        wgpuDeviceCreateBindGroupLayout(state->device, &bindGroupLayoutDescriptor);
    if (!requireHandleHostSide(bindGroupLayout, "uiComposite.createBindGroupLayout")) {
        wgpuShaderModuleRelease(shaderModule);
        return false;
    }

    WGPUPipelineLayoutDescriptor pipelineLayoutDescriptor = {};
    pipelineLayoutDescriptor.bindGroupLayoutCount = 1;
    pipelineLayoutDescriptor.bindGroupLayouts = &bindGroupLayout;
    WGPUPipelineLayout pipelineLayout =
        wgpuDeviceCreatePipelineLayout(state->device, &pipelineLayoutDescriptor);
    if (!requireHandleHostSide(pipelineLayout, "uiComposite.createPipelineLayout")) {
        wgpuBindGroupLayoutRelease(bindGroupLayout);
        wgpuShaderModuleRelease(shaderModule);
        return false;
    }

    // Premultiplied source over the frame. `One` for the source colour is what premultiplied means;
    // `SrcAlpha` here would apply the coverage twice and darken every soft edge.
    WGPUBlendState blend = {};
    blend.color.srcFactor = WGPUBlendFactor_One;
    blend.color.dstFactor = WGPUBlendFactor_OneMinusSrcAlpha;
    blend.color.operation = WGPUBlendOperation_Add;
    blend.alpha.srcFactor = WGPUBlendFactor_One;
    blend.alpha.dstFactor = WGPUBlendFactor_OneMinusSrcAlpha;
    blend.alpha.operation = WGPUBlendOperation_Add;

    WGPUColorTargetState colorTarget = {};
    colorTarget.format = format;
    colorTarget.blend = &blend;
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
    pipelineDescriptor.primitive.cullMode = WGPUCullMode_None;
    pipelineDescriptor.multisample.count = 1;
    pipelineDescriptor.multisample.mask = 0xFFFFFFFF;

    state->ui.pipeline = wgpuDeviceCreateRenderPipeline(state->device, &pipelineDescriptor);
    wgpuPipelineLayoutRelease(pipelineLayout);
    wgpuBindGroupLayoutRelease(bindGroupLayout);
    wgpuShaderModuleRelease(shaderModule);
    if (!requireHandleHostSide(state->ui.pipeline, "uiComposite.createRenderPipeline")) {
        state->ui.pipeline = nullptr;
        return false;
    }
    state->ui.pipelineFormat = format;
    return true;
}

/**
 * Create or resize the UI texture, dropping any bind group that named the old view.
 *
 * `format` follows the source's channel order: cairo hands over `B,G,R,A` on a little-endian host
 * (`BGRA8Unorm`), Android's `ImageReader` hands over `R,G,B,A` (`RGBA8Unorm`). The shader decodes
 * whichever was uploaded; only the storage layout differs, so the same pipeline serves both.
 */
bool ensureUiTexture(BindingsState* state, uint32_t width, uint32_t height,
                     WGPUTextureFormat format) {
    if (state->ui.texture != nullptr && state->ui.textureWidth == width &&
        state->ui.textureHeight == height && state->ui.textureFormat == format)
        return true;
    if (state->ui.bindGroup != nullptr) {
        wgpuBindGroupRelease(state->ui.bindGroup);
        state->ui.bindGroup = nullptr;
    }
    if (state->ui.textureView != nullptr) {
        wgpuTextureViewRelease(state->ui.textureView);
        state->ui.textureView = nullptr;
    }
    if (state->ui.texture != nullptr) {
        wgpuTextureDestroy(state->ui.texture);
        wgpuTextureRelease(state->ui.texture);
        state->ui.texture = nullptr;
    }

    WGPUTextureDescriptor descriptor = {};
    descriptor.size = {width, height, 1};
    descriptor.mipLevelCount = 1;
    descriptor.sampleCount = 1;
    descriptor.dimension = WGPUTextureDimension_2D;
    // Not `*-Srgb`: the shader does the decode, because the same shader has to serve a linear
    // target and an sRGB one.
    descriptor.format = format;
    descriptor.usage = WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst;
    state->ui.texture = wgpuDeviceCreateTexture(state->device, &descriptor);
    if (!requireHandleHostSide(state->ui.texture, "uiComposite.createTexture")) {
        state->ui.texture = nullptr;
        return false;
    }

    WGPUTextureViewDescriptor viewDescriptor = {};
    viewDescriptor.format = format;
    viewDescriptor.dimension = WGPUTextureViewDimension_2D;
    viewDescriptor.baseMipLevel = 0;
    viewDescriptor.mipLevelCount = 1;
    viewDescriptor.baseArrayLayer = 0;
    viewDescriptor.arrayLayerCount = 1;
    state->ui.textureView = wgpuTextureCreateView(state->ui.texture, &viewDescriptor);
    if (!requireHandleHostSide(state->ui.textureView, "uiComposite.createTextureView")) {
        state->ui.textureView = nullptr;
        return false;
    }
    state->ui.textureWidth = width;
    state->ui.textureHeight = height;
    state->ui.textureFormat = format;
    // The new texture holds nothing, so the next frame uploads whatever the page already has
    // rather than waiting for it to change again.
    state->ui.uploadedCounter = 0;
    return true;
}

/**
 * Write one whole marker line under a single stdio lock. The web thread's `TN_UI_SNAPSHOT` lines
 * arrive through `puts` on the same `stdout`, and a marker chained through `std::cout <<` takes the
 * lock once per fragment, so a snapshot line landed inside a composite marker and made it
 * unparseable (release run 39247695392).
 */
void writeMarkerLine(const std::string& line) {
    std::fputs(line.c_str(), stdout);
    std::fflush(stdout);
}

/**
 * One line per composited frame, only when `TN_UI_COMPOSITE_TRACE` is set.
 *
 * `TN_UI_COMPOSITE` aggregates a second, which is enough for a rate and useless for a gap: a
 * second with forty uploads and a 300 ms hole in it reads the same as one without. AC-2 and AC-4 of
 * PRD-398 ask for update-gap percentiles and display latency, which need the per-frame timeline —
 * every frame the compositor reached, the page counter it saw, and whether that frame uploaded. Off
 * unless the variable is set, because a line per frame is noise in every other run.
 *
 * The clock is the same launch clock `TN_UI_COMPOSITE` uses, so these frames and the once-a-second
 * summaries can be lined up without subtracting two unrelated origins.
 */
void traceUiComposite(uint64_t counter, bool uploaded) {
    static const bool enabled = std::getenv("TN_UI_COMPOSITE_TRACE") != nullptr;
    if (!enabled) return;
    std::ostringstream line;
    line << "TN_UI_COMPOSITE_TRACE:{\"atMs\":" << coldStartNowMs()
         << ",\"counter\":" << counter
         << ",\"uploaded\":" << (uploaded ? "true" : "false") << "}\n";
    writeMarkerLine(line.str());
}

/** Upload the page's frame, or skip it because the page has not changed since the last one. */
bool uploadUiFrame(BindingsState* state, const platform::UiOverlayFrame& frame) {
    if (state->ui.uploadedCounter == frame.counter) {
        state->ui.skippedUploads += 1;
        traceUiComposite(frame.counter, false);
        return true;
    }
    const WGPUTextureFormat sourceFormat =
        frame.isRgba ? WGPUTextureFormat_RGBA8Unorm : WGPUTextureFormat_BGRA8Unorm;
    if (!ensureUiTexture(state, frame.width, frame.height, sourceFormat)) return false;

    WGPUImageCopyTexture_Compat destination = {};
    destination.texture = state->ui.texture;
    destination.mipLevel = 0;
    destination.origin = {0, 0, 0};
    destination.aspect = WGPUTextureAspect_All;

    WGPUTextureDataLayout_Compat layout = {};
    layout.offset = 0;
    layout.bytesPerRow = frame.stride;
    layout.rowsPerImage = frame.height;

    WGPUExtent3D writeSize = {frame.width, frame.height, 1};
    wgpuQueueWriteTexture(state->queue, &destination, frame.pixels, frame.length, &layout,
                          &writeSize);
    state->ui.uploadedCounter = frame.counter;
    state->ui.uploads += 1;
    traceUiComposite(frame.counter, true);
    return true;
}
}  // namespace
#endif

/**
 * One line a second naming what the compositor did with the UI.
 *
 * The upload counters are the point: "the page has not changed, so nothing was uploaded" and "the
 * page changed every frame and everything was uploaded" look identical in a screenshot and are the
 * difference between the AC-6 budget being met and not. `frame` is the page's own size, which is not
 * always the window's — a HiDPI session hands back a larger surface.
 */
void reportUiComposite(BindingsState* state, const platform::UiOverlayFrame& frame) {
    using clock = std::chrono::steady_clock;
    static clock::time_point last{};
    static uint64_t uploads = 0;
    static uint64_t skipped = 0;
    const clock::time_point now = clock::now();
    if (last != clock::time_point{} && now - last < std::chrono::seconds(1)) return;
    const uint64_t deltaUploads = state->ui.uploads - uploads;
    const uint64_t deltaSkipped = state->ui.skippedUploads - skipped;
    uploads = state->ui.uploads;
    skipped = state->ui.skippedUploads;
    // The very first line has no interval behind it; report it anyway, with the totals, so a run
    // that lasts under a second still says the UI composited at all.
    last = now;
    std::ostringstream line;
    line << "TN_UI_COMPOSITE:{\"atMs\":" << coldStartNowMs()
         << ",\"uploads\":" << uploads << ",\"skipped\":" << skipped
         << ",\"uploadsPerSecond\":" << deltaUploads << ",\"skippedPerSecond\":" << deltaSkipped
         // Quoted, because every other field here is JSON and this one used to be the only
         // thing making the whole payload unparseable: `"frame":1280x720` is not a value.
         << ",\"frame\":\"" << frame.width << "x" << frame.height << "\""
         << ",\"counter\":" << frame.counter
         << ",\"uploadedCounter\":" << state->ui.uploadedCounter
         << ",\"format\":" << static_cast<int>(state->ui.pipelineFormat)
         << ",\"target\":" << static_cast<int>(state->presentation.surfaceFormat) << "}\n";
    writeMarkerLine(line.str());
}

/**
 * Draw the UI over this frame's colour target, uploading first when the page has changed.
 *
 * Called from `endDawnFrame` after the world's passes are submitted and before the present. A no-op
 * on every platform without an attached overlay, which is what keeps `ui: { renderer: "native" }`
 * and the web and mobile targets on exactly the path they had.
 *
 * Returns true when a quad was drawn. The caller measures the phase either way, because "the UI
 * costs nothing because it never drew" and "the UI costs nothing because it is cheap" are different
 * facts and only the numbers separate them.
 */
bool compositeUiOverlayToWebGPU(BindingsState* state) {
#if defined(MYSTRAL_WEBGPU_WGPU) || defined(MYSTRAL_WEBGPU_DAWN)
    // PRD-393's ablation arm. It removes the upload and the quad and nothing else: the frame is
    // still built, submitted and presented, so the phase this build reports is what the *rest* of
    // `endDawnFrame` costs, and the delta against an unablated run is the composite's own price.
#if defined(TN_ABLATE_UI_COMPOSITE) && TN_ABLATE_UI_COMPOSITE
    (void)state;
    return false;
#endif
    if (state == nullptr || !state->device || !state->queue) return false;
    if (!platform::uiOverlayAttached()) return false;

    platform::UiOverlayFrame frame = {};
    if (!platform::uiOverlayFrame(frame)) return false;
    if (frame.pixels == nullptr || frame.width == 0 || frame.height == 0 || frame.stride == 0)
        return false;

    if (!uploadUiFrame(state, frame)) return false;

    // The frame's own colour target: the swapchain image on a direct surface, the linear texture
    // the sRGB bridge reads when that is on. Either way this is the texture the world drew into and
    // the one the present will show.
    WGPUTextureView target = state->presentation.currentTextureView;
    if (target == nullptr) return false;

    const WGPUTextureFormat format = state->presentation.surfaceFormat;
    if (!ensureUiPipeline(state, format)) return false;

    if (state->ui.bindGroup == nullptr) {
        if (state->ui.sampler == nullptr) {
            state->ui.sampler = createUiSampler(state);
            if (!requireHandleHostSide(state->ui.sampler, "uiComposite.createSampler")) {
                state->ui.sampler = nullptr;
                return false;
            }
        }
        WGPUBindGroupEntry entries[2] = {};
        entries[0].binding = 0;
        entries[0].sampler = state->ui.sampler;
        entries[1].binding = 1;
        entries[1].textureView = state->ui.textureView;

        WGPUBindGroupLayout layout =
            wgpuRenderPipelineGetBindGroupLayout(state->ui.pipeline, 0);
        if (!requireHandleHostSide(layout, "uiComposite.getBindGroupLayout")) return false;
        WGPUBindGroupDescriptor descriptor = {};
        descriptor.layout = layout;
        descriptor.entryCount = 2;
        descriptor.entries = entries;
        state->ui.bindGroup = wgpuDeviceCreateBindGroup(state->device, &descriptor);
        wgpuBindGroupLayoutRelease(layout);
        if (!requireHandleHostSide(state->ui.bindGroup, "uiComposite.createBindGroup")) {
            state->ui.bindGroup = nullptr;
            return false;
        }
    }

    WGPUCommandEncoderDescriptor encoderDescriptor = {};
    WGPUCommandEncoder encoder = wgpuDeviceCreateCommandEncoder(state->device, &encoderDescriptor);
    if (!requireHandleHostSide(encoder, "uiComposite.createCommandEncoder")) return false;

    // `Load`: the world is already in this texture and the UI goes over it. `Clear` here is the
    // bug this whole change exists to avoid — it would erase the game and show a UI on black.
    WGPURenderPassColorAttachment colorAttachment = {};
    colorAttachment.view = target;
    colorAttachment.loadOp = WGPULoadOp_Load;
    colorAttachment.storeOp = WGPUStoreOp_Store;
    colorAttachment.clearValue = {0.0, 0.0, 0.0, 0.0};
#if defined(MYSTRAL_WEBGPU_DAWN)
    colorAttachment.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
#endif

    WGPURenderPassDescriptor renderPassDescriptor = {};
    renderPassDescriptor.colorAttachmentCount = 1;
    renderPassDescriptor.colorAttachments = &colorAttachment;

    WGPURenderPassEncoder renderPass =
        wgpuCommandEncoderBeginRenderPass(encoder, &renderPassDescriptor);
    if (!requireHandleHostSide(renderPass, "uiComposite.beginRenderPass")) {
        wgpuCommandEncoderRelease(encoder);
        return false;
    }
    wgpuRenderPassEncoderSetPipeline(renderPass, state->ui.pipeline);
    wgpuRenderPassEncoderSetBindGroup(renderPass, 0, state->ui.bindGroup, 0, nullptr);
    wgpuRenderPassEncoderDraw(renderPass, 6, 1, 0, 0);
    wgpuRenderPassEncoderEnd(renderPass);
    wgpuRenderPassEncoderRelease(renderPass);

    WGPUCommandBufferDescriptor commandBufferDescriptor = {};
    WGPUCommandBuffer commandBuffer = wgpuCommandEncoderFinish(encoder, &commandBufferDescriptor);
    bool drawn = false;
    if (commandBuffer != nullptr) {
        flushUploadStaging(state);
        wgpuQueueSubmit(state->queue, 1, &commandBuffer);
        wgpuCommandBufferRelease(commandBuffer);
        drawn = true;
    } else {
        std::cerr << "[WebGPU] UI composite: command encoder finished with no command buffer"
                  << std::endl;
    }
    wgpuCommandEncoderRelease(encoder);
    reportUiComposite(state, frame);
    return drawn;
#else
    (void)state;
    return false;
#endif
}

}  // namespace webgpu
}  // namespace mystral
