/** Canvas2D-to-WebGPU compositing. */

#include "bindings_state.h"
#include "mystral/webgpu/bindings.h"
#include "mystral/webgpu/checked_handle.h"

#include <iostream>
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

// Canvas 2D compositing resources live in BindingsState.
void compositeCanvas2DToWebGPU(BindingsState* state) {
    if (!state->canvas2D.mainCanvas2DContext || !state->device || !state->queue || !state->surface) {
        return;
    }

    // Get Canvas 2D pixel data
    const uint8_t* pixelData = state->canvas2D.mainCanvas2DContext->getPixelData();
    size_t pixelDataSize = state->canvas2D.mainCanvas2DContext->getPixelDataSize();
    int width = state->canvas2D.mainCanvas2DContext->getWidth();
    int height = state->canvas2D.mainCanvas2DContext->getHeight();

    if (!pixelData || pixelDataSize == 0) {
        return;
    }

    // Create or resize texture if needed
    if (!state->canvas2D.canvas2DTexture || state->canvas2D.canvas2DTextureWidth != (uint32_t)width ||
        state->canvas2D.canvas2DTextureHeight != (uint32_t)height) {
        if (state->canvas2D.canvas2DTexture) {
            wgpuTextureDestroy(state->canvas2D.canvas2DTexture);
            wgpuTextureRelease(state->canvas2D.canvas2DTexture);
        }
        if (state->canvas2D.canvas2DBindGroup) {
            wgpuBindGroupRelease(state->canvas2D.canvas2DBindGroup);
            state->canvas2D.canvas2DBindGroup = nullptr;
        }

        WGPUTextureDescriptor texDesc = {};
        texDesc.size = {(uint32_t)width, (uint32_t)height, 1};
        texDesc.mipLevelCount = 1;
        texDesc.sampleCount = 1;
        texDesc.dimension = WGPUTextureDimension_2D;
        texDesc.format = WGPUTextureFormat_RGBA8Unorm;
        texDesc.usage = WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst;

        state->canvas2D.canvas2DTexture = wgpuDeviceCreateTexture(state->device, &texDesc);
        // Host-side path: there is no JS frame to throw into, so skip the composite rather than
        // write pixels through a NULL texture. The next frame retries.
        if (!requireHandleHostSide(state->canvas2D.canvas2DTexture, "canvas2D.createTexture",
                                   std::to_string(width) + "x" + std::to_string(height)))
            return;
        state->canvas2D.canvas2DTextureWidth = width;
        state->canvas2D.canvas2DTextureHeight = height;
    }

    // Upload pixel data to texture — but only when the canvas has drawn since the last
    // upload. The fullscreen quad below still renders every frame (the surface texture is
    // new each frame); skipping is only the width x height x 4 buffer copy, which for an
    // unchanged canvas is the same pixels byte for byte.
    if (state->canvas2D.mainCanvas2DContext->hasDirtyPixels()) {
        WGPUImageCopyTexture_Compat destTexture = {};
        destTexture.texture = state->canvas2D.canvas2DTexture;
        destTexture.mipLevel = 0;
        destTexture.origin = {0, 0, 0};
        destTexture.aspect = WGPUTextureAspect_All;

        WGPUTextureDataLayout_Compat dataLayout = {};
        dataLayout.offset = 0;
        dataLayout.bytesPerRow = width * 4;
        dataLayout.rowsPerImage = height;

        WGPUExtent3D writeSize = {(uint32_t)width, (uint32_t)height, 1};
        wgpuQueueWriteTexture(state->queue, &destTexture, pixelData, pixelDataSize, &dataLayout, &writeSize);
        state->canvas2D.mainCanvas2DContext->consumeDirtyPixels();
    }

    // Create pipeline if needed
    if (!state->canvas2D.canvas2DPipeline) {
        // Simple fullscreen quad shader
        const char* shaderCode = R"(
            @group(0) @binding(0) var texSampler: sampler;
            @group(0) @binding(1) var tex: texture_2d<f32>;

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

            @fragment
            fn fs_main(input: VertexOutput) -> @location(0) vec4f {
                return textureSample(tex, texSampler, input.uv);
            }
        )";

        WGPUShaderModuleWGSLDescriptor_Compat wgslDesc = {};
        WGPUShaderModuleDescriptor shaderDesc = {};
        setupShaderModuleWGSL(&shaderDesc, &wgslDesc, shaderCode);

        WGPUShaderModule shaderModule = wgpuDeviceCreateShaderModule(state->device, &shaderDesc);

        // Create sampler
        WGPUSamplerDescriptor samplerDesc = {};
        samplerDesc.magFilter = WGPUFilterMode_Linear;
        samplerDesc.minFilter = WGPUFilterMode_Linear;
        samplerDesc.mipmapFilter = WGPUMipmapFilterMode_Linear;
        samplerDesc.addressModeU = WGPUAddressMode_ClampToEdge;
        samplerDesc.addressModeV = WGPUAddressMode_ClampToEdge;
        samplerDesc.addressModeW = WGPUAddressMode_ClampToEdge;
        samplerDesc.maxAnisotropy = 1;
        samplerDesc.lodMinClamp = 0.0f;
        samplerDesc.lodMaxClamp = 1.0f;
        state->canvas2D.canvas2DSampler = wgpuDeviceCreateSampler(state->device, &samplerDesc);

        // Create bind group layout
        WGPUBindGroupLayoutEntry bgLayoutEntries[2] = {};
        bgLayoutEntries[0].binding = 0;
        bgLayoutEntries[0].visibility = WGPUShaderStage_Fragment;
        bgLayoutEntries[0].sampler.type = WGPUSamplerBindingType_Filtering;
        bgLayoutEntries[1].binding = 1;
        bgLayoutEntries[1].visibility = WGPUShaderStage_Fragment;
        bgLayoutEntries[1].texture.sampleType = WGPUTextureSampleType_Float;
        bgLayoutEntries[1].texture.viewDimension = WGPUTextureViewDimension_2D;

        WGPUBindGroupLayoutDescriptor bgLayoutDesc = {};
        bgLayoutDesc.entryCount = 2;
        bgLayoutDesc.entries = bgLayoutEntries;
        WGPUBindGroupLayout bgLayout = wgpuDeviceCreateBindGroupLayout(state->device, &bgLayoutDesc);

        // Create pipeline layout
        WGPUPipelineLayoutDescriptor pipelineLayoutDesc = {};
        pipelineLayoutDesc.bindGroupLayoutCount = 1;
        pipelineLayoutDesc.bindGroupLayouts = &bgLayout;
        WGPUPipelineLayout pipelineLayout = wgpuDeviceCreatePipelineLayout(state->device, &pipelineLayoutDesc);

        // Create pipeline
        WGPURenderPipelineDescriptor pipelineDesc = {};
        pipelineDesc.layout = pipelineLayout;
        pipelineDesc.vertex.module = shaderModule;
        WGPU_SET_ENTRY_POINT(pipelineDesc.vertex, "vs_main");

        WGPUFragmentState fragmentState = {};
        fragmentState.module = shaderModule;
        WGPU_SET_ENTRY_POINT(fragmentState, "fs_main");
        fragmentState.targetCount = 1;

        WGPUColorTargetState colorTarget = {};
        colorTarget.format = state->presentation.nativeSurfaceFormat;
        colorTarget.writeMask = WGPUColorWriteMask_All;
        fragmentState.targets = &colorTarget;

        pipelineDesc.fragment = &fragmentState;
        pipelineDesc.primitive.topology = WGPUPrimitiveTopology_TriangleList;
        pipelineDesc.multisample.count = 1;
        pipelineDesc.multisample.mask = 0xFFFFFFFF;

        state->canvas2D.canvas2DPipeline = wgpuDeviceCreateRenderPipeline(state->device, &pipelineDesc);

        wgpuShaderModuleRelease(shaderModule);
        wgpuPipelineLayoutRelease(pipelineLayout);
        wgpuBindGroupLayoutRelease(bgLayout);

        if (!state->canvas2D.canvas2DPipeline) {
            std::cerr << "[Canvas2D] Failed to create compositing pipeline" << std::endl;
            return;
        }
    }

    // Create bind group (recreate if texture changed)
    if (!state->canvas2D.canvas2DBindGroup) {
        if (!state->canvas2D.canvas2DSampler || !state->canvas2D.canvas2DTexture) {
            return;
        }

        WGPUTextureViewDescriptor viewDesc = {};
        viewDesc.format = WGPUTextureFormat_RGBA8Unorm;
        viewDesc.dimension = WGPUTextureViewDimension_2D;
        viewDesc.baseMipLevel = 0;
        viewDesc.mipLevelCount = 1;
        viewDesc.baseArrayLayer = 0;
        viewDesc.arrayLayerCount = 1;
        WGPUTextureView texView = wgpuTextureCreateView(state->canvas2D.canvas2DTexture, &viewDesc);

        if (!texView) {
            return;
        }

        WGPUBindGroupEntry bgEntries[2] = {};
        bgEntries[0].binding = 0;
        bgEntries[0].sampler = state->canvas2D.canvas2DSampler;
        bgEntries[1].binding = 1;
        bgEntries[1].textureView = texView;

        WGPUBindGroupLayout layout = wgpuRenderPipelineGetBindGroupLayout(state->canvas2D.canvas2DPipeline, 0);
        if (!layout) {
            wgpuTextureViewRelease(texView);
            return;
        }

        WGPUBindGroupDescriptor bgDesc = {};
        bgDesc.layout = layout;
        bgDesc.entryCount = 2;
        bgDesc.entries = bgEntries;
        state->canvas2D.canvas2DBindGroup = wgpuDeviceCreateBindGroup(state->device, &bgDesc);

        wgpuBindGroupLayoutRelease(layout);
        wgpuTextureViewRelease(texView);

        if (!state->canvas2D.canvas2DBindGroup) {
            return;
        }
    }

    // Get surface texture
    WGPUSurfaceTexture surfaceTexture;
    acquirePresentationSurface(state->surface, &surfaceTexture);
    if (!wgpuSurfaceTextureStatusIsSuccess(surfaceTexture.status)) {
        return;
    }

    WGPUTextureViewDescriptor surfaceViewDesc = {};
    surfaceViewDesc.format = state->presentation.nativeSurfaceFormat;
    surfaceViewDesc.dimension = WGPUTextureViewDimension_2D;
    surfaceViewDesc.baseMipLevel = 0;
    surfaceViewDesc.mipLevelCount = 1;
    surfaceViewDesc.baseArrayLayer = 0;
    surfaceViewDesc.arrayLayerCount = 1;
    WGPUTextureView surfaceView = wgpuTextureCreateView(surfaceTexture.texture, &surfaceViewDesc);
    // A surface whose window was released underneath us hands back NULL here. Compositing on
    // through it is the "present into a released window" fault this pass exists to remove.
    if (!requireHandleHostSide(surfaceView, "canvas2DComposite.surfaceView")) return;

    // Create command encoder and render pass
    WGPUCommandEncoderDescriptor encDesc = {};
    WGPUCommandEncoder encoder = wgpuDeviceCreateCommandEncoder(state->device, &encDesc);
    if (!requireHandleHostSide(encoder, "canvas2DComposite.createCommandEncoder")) {
        wgpuTextureViewRelease(surfaceView);
        return;
    }

    WGPURenderPassColorAttachment colorAttachment = {};
    colorAttachment.view = surfaceView;
    colorAttachment.loadOp = WGPULoadOp_Clear;
    colorAttachment.storeOp = WGPUStoreOp_Store;
    colorAttachment.clearValue = {0.0, 0.0, 0.0, 1.0};
#if defined(MYSTRAL_WEBGPU_DAWN)
    colorAttachment.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
#endif

    WGPURenderPassDescriptor renderPassDesc = {};
    renderPassDesc.colorAttachmentCount = 1;
    renderPassDesc.colorAttachments = &colorAttachment;

    WGPURenderPassEncoder renderPass = wgpuCommandEncoderBeginRenderPass(encoder, &renderPassDesc);
    if (!requireHandleHostSide(renderPass, "canvas2DComposite.beginRenderPass")) {
        wgpuCommandEncoderRelease(encoder);
        wgpuTextureViewRelease(surfaceView);
        return;
    }
    wgpuRenderPassEncoderSetPipeline(renderPass, state->canvas2D.canvas2DPipeline);
    wgpuRenderPassEncoderSetBindGroup(renderPass, 0, state->canvas2D.canvas2DBindGroup, 0, nullptr);
    wgpuRenderPassEncoderDraw(renderPass, 6, 1, 0, 0);
    wgpuRenderPassEncoderEnd(renderPass);
    wgpuRenderPassEncoderRelease(renderPass);

    // Copy rendered texture to screenshot buffer
    uint32_t bytesPerRow = ((state->presentation.canvasWidth * 4 + 255) / 256) * 256; // Align to 256
    size_t requiredSize = bytesPerRow * state->presentation.canvasHeight;

    if (!state->screenshot.screenshotBuffer || state->screenshot.screenshotBufferSize < requiredSize) {
        if (state->screenshot.screenshotBuffer) {
            wgpuBufferDestroy(state->screenshot.screenshotBuffer);
            wgpuBufferRelease(state->screenshot.screenshotBuffer);
        }

        WGPUBufferDescriptor bufferDesc = {};
        bufferDesc.size = requiredSize;
        bufferDesc.usage = WGPUBufferUsage_CopyDst | WGPUBufferUsage_MapRead;
        bufferDesc.mappedAtCreation = false;

        state->screenshot.screenshotBuffer = wgpuDeviceCreateBuffer(state->device, &bufferDesc);
        state->screenshot.screenshotBufferSize = requiredSize;
        state->screenshot.screenshotBytesPerRow = bytesPerRow;
    }

    // Copy surface texture to screenshot buffer
    WGPUImageCopyTexture_Compat srcCopy = {};
    srcCopy.texture = surfaceTexture.texture;
    srcCopy.mipLevel = 0;
    srcCopy.origin = {0, 0, 0};
    srcCopy.aspect = WGPUTextureAspect_All;

    WGPUImageCopyBuffer_Compat dstCopy = {};
    dstCopy.buffer = state->screenshot.screenshotBuffer;
    dstCopy.layout.offset = 0;
    dstCopy.layout.bytesPerRow = bytesPerRow;
    dstCopy.layout.rowsPerImage = state->presentation.canvasHeight;

    WGPUExtent3D copySize = {state->presentation.canvasWidth, state->presentation.canvasHeight, 1};
    wgpuCommandEncoderCopyTextureToBuffer_Compat(encoder, &srcCopy, &dstCopy, &copySize);

    WGPUCommandBufferDescriptor cmdDesc = {};
    WGPUCommandBuffer cmdBuffer = wgpuCommandEncoderFinish(encoder, &cmdDesc);
    if (!requireHandleHostSide(cmdBuffer, "canvas2DComposite.finish")) {
        wgpuCommandEncoderRelease(encoder);
        wgpuTextureViewRelease(surfaceView);
        return;
    }
    wgpuQueueSubmit(state->queue, 1, &cmdBuffer);

    wgpuCommandBufferRelease(cmdBuffer);
    wgpuCommandEncoderRelease(encoder);
    wgpuTextureViewRelease(surfaceView);

    // Present
    wgpuSurfacePresent(state->surface);

    // Track for screenshot
    state->presentation.currentTexture = surfaceTexture.texture;
    state->screenshot.screenshotReady = true;
}

}  // namespace webgpu
}  // namespace mystral
