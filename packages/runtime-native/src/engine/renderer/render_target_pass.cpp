#include "engine/renderer/render_target_pass.h"

#include "engine/renderer/frame_gpu_timer.h"
#include "engine/renderer/render_database.h"

#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <string>
#include <cstdio>
#include <cstring>
#include <functional>
#include <memory>
#include <utility>

namespace tn::engine {

namespace {

struct TargetGpu {
    std::unique_ptr<Renderer> renderer;
    std::unique_ptr<RenderDatabase> database;
    bool rendered = false;  // the target's colour holds a render (else it is drawn empty before a read)
    // A layered or MRT target's textures, one 2D array each, built at the first draw or sample.
    std::vector<Renderer::TargetLayers> attachments;
    ~TargetGpu() {
        for (const auto& each : attachments) {
            if (each.view) wgpuTextureViewRelease(each.view);
            if (each.texture) wgpuTextureRelease(each.texture);
        }
    }
};

/** The GPU format a layered target's texture stores, as three's WebGPUTextureUtils picks it for the texture's type. */
WGPUTextureFormat layerFormat(const Texture& texture) {
    if (texture.isFloat()) return WGPUTextureFormat_RGBA32Float;
    if (texture.isHalfFloat()) return WGPUTextureFormat_RGBA16Float;
    return texture.isSRGB() ? WGPUTextureFormat_RGBA8UnormSrgb : WGPUTextureFormat_RGBA8Unorm;
}

/** A layered target's arrays: one per texture, `depth` layers, a full mip chain when the texture asks for mipmaps. */
void ensureAttachments(TargetGpu& gpu, RenderTarget& target) {
    if (!target.layered() || gpu.attachments.size() == target.textures.size()) return;
    for (const auto& texture : target.textures) {
        const uint32_t levels =
            texture->generateMipmaps ? uint32_t(std::floor(std::log2(double(std::max(target.width, target.height))))) + 1 : 1;
        gpu.attachments.push_back(
            gpu.renderer->createTargetLayers(target.width, target.height, target.depth, levels, layerFormat(*texture)));
    }
}

float halfToFloat(uint16_t bits) {
    const int exponent = (bits >> 10) & 31;
    const int mantissa = bits & 1023;
    const float magnitude = exponent == 0 ? std::ldexp(float(mantissa), -24)
                          : exponent == 31 ? (mantissa ? std::nanf("") : INFINITY)
                                           : std::ldexp(float(mantissa | 1024), exponent - 25);
    return bits & 0x8000 ? -magnitude : magnitude;
}

TargetGpu& gpuOf(Renderer& main, RenderTarget& target) {
    if (!target.gpu) {
        auto gpu = std::make_shared<TargetGpu>();
        gpu->renderer = main.sibling(true);
        gpu->renderer->skipOutputPass();
        gpu->renderer->gpu().batchSubmits();  // its draw reaches the queue with the frame's next submit
        // A FloatType target keeps float32: a half float rounds a value fed back each frame (auto exposure).
        // Without float32-blendable a blended draw into RGBA32Float fails validation, so it falls back to half.
        const bool float32 = target.texture->isFloat() && main.float32Blendable();
        if (target.texture->isFloat() && !float32) {
            target.halfPrecision = true;
            std::fprintf(stderr, "TN_NATIVE_FLOAT_TARGET_HALF: a FloatType render target is stored as half float "
                                 "because the device lacks float32-blendable\n");
        }
        gpu->renderer->setSceneFormat(float32 ? WGPUTextureFormat_RGBA32Float : WGPUTextureFormat_RGBA16Float);
        gpu->database = std::make_unique<RenderDatabase>();
        target.gpu = std::move(gpu);
    }
    auto& gpu = *static_cast<TargetGpu*>(target.gpu.get());
    gpu.renderer->setSize(target.width, target.height);  // a no-op at the same extent
    ensureAttachments(gpu, target);
    return gpu;
}

}  // namespace

std::vector<std::string> renderToTarget(Renderer& main, RenderTarget& target, Object3D& root, Camera& camera,
                                        std::array<double, 4> clear, bool shadowMap, bool deferred, uint32_t layer,
                                        uint32_t attachment) {
    if (deferred && target.depthTexture)
        return {"TN_NATIVE_DEFERRED_TARGET_DEPTH: a deferred render target cannot carry a depth texture"};
    if (layer >= target.depth || attachment >= target.textures.size())
        return {"TN_NATIVE_RENDER_TARGET_LAYER: layer " + std::to_string(layer) + " or attachment " +
                std::to_string(attachment) + " is outside the target"};
    if (target.layered() && (deferred || target.depthTexture))
        return {"TN_NATIVE_RENDER_TARGET_LAYER: a layered or MRT target is drawn at the call, without a depth texture"};
    main.flushDeferred(&target);  // an earlier plan for this target is recorded first, never dropped or drawn twice
    TargetGpu& gpu = gpuOf(main, target);
    gpu.database->shadowMapEnabled = shadowMap;
    gpu.renderer->setSourceAttachments(main.sceneColorView(), main.sceneDepthView());
    gpu.renderer->setPostSource(&main);
    if (deferred) {
        std::vector<std::function<void()>> jobs;
        struct Reset {
            RenderDatabase& database;
            ~Reset() { database.encodeJobs = nullptr; }
        } reset{*gpu.database};
        gpu.database->encodeJobs = &jobs;
        gpu.database->render(*gpu.renderer, root, camera, clear);
        main.deferTarget(&target, target.gpu, std::move(jobs));
    } else {
        gpu.database->render(*gpu.renderer, root, camera, clear);
    }
    gpu.rendered = true;
    if (target.depthTexture) gpu.renderer->copyDepthToTexture(*target.depthTexture);
    // A layered or MRT target keeps the scene colour in the drawn texture's layer; three's finishRender regenerates
    // that texture's mips when it asks for them.
    if (target.layered())
        gpu.renderer->copySceneToLayer(gpu.attachments[attachment], layer, target.textures[attachment]->generateMipmaps);
    std::vector<std::string> diagnostics = gpu.database->diagnostics();
    for (const std::string& message : gpu.renderer->diagnostics()) diagnostics.push_back(message);
    return diagnostics;
}

WGPUTextureView renderTargetView(Renderer& main, RenderTarget& target, int attachment) {
    TargetGpu& gpu = gpuOf(main, target);
    // A layered target's texture is its own array; one never drawn holds the cleared layers it was made with.
    if (target.layered()) return gpu.attachments.at(std::size_t(std::max(attachment, 0))).view;
    if (!gpu.rendered) {
        gpu.renderer->render({}, CameraState{}, LightState{}, {0, 0, 0, 0});
        gpu.rendered = true;
    }
    return gpu.renderer->sceneColorView();
}

Renderer::TargetLayers Renderer::createTargetLayers(uint32_t width, uint32_t height, uint32_t layers, uint32_t levels,
                                                   WGPUTextureFormat format) {
    TargetLayers out;
    out.format = format;
    out.levels = levels;
    out.layers = layers;
    WGPUTextureDescriptor desc = {};
    desc.dimension = WGPUTextureDimension_2D;
    desc.size = {width, height, layers};
    desc.format = format;
    desc.mipLevelCount = levels;
    desc.sampleCount = 1;
    desc.usage = WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopySrc;
    out.texture = wgpuDeviceCreateTexture(device_, &desc);
    WGPUTextureViewDescriptor view = {};
    view.dimension = WGPUTextureViewDimension_2DArray;
    view.format = format;
    view.mipLevelCount = levels;
    view.arrayLayerCount = layers;
    out.view = wgpuTextureCreateView(out.texture, &view);
    texturesChanged();  // a new view's address may be one a released view had
    return out;
}

void Renderer::copySceneToLayer(const TargetLayers& into, uint32_t layer, bool mipmaps) {
    WGPURenderPipeline pipeline = copyPipeline(into.format, 0);
    if (!pipeline || !sceneView_) throw std::runtime_error("TN_NATIVE_RENDER_TARGET_LAYER: no copy pipeline");
    WGPUBindGroupLayout layout = wgpuRenderPipelineGetBindGroupLayout(pipeline, 0);
    WGPUBindGroup group = bindGroup(layout, blitFragment_, outputUniforms_, sceneView_, linearClampSampler());
    wgpuBindGroupLayoutRelease(layout);
    if (!group) throw std::runtime_error("TN_NATIVE_RENDER_TARGET_LAYER: no bind group");
    WGPUTextureViewDescriptor desc = {};
    desc.dimension = WGPUTextureViewDimension_2D;
    desc.format = into.format;
    desc.mipLevelCount = 1;
    desc.baseArrayLayer = layer;
    desc.arrayLayerCount = 1;
    WGPUTextureView view = wgpuTextureCreateView(into.texture, &desc);
    if (!mipEncoder_) {
        WGPUCommandEncoderDescriptor encoderDesc = {};
        mipEncoder_ = wgpuDeviceCreateCommandEncoder(device_, &encoderDesc);
    }
    WGPURenderPassColorAttachment color = {};
    color.view = view;
    color.loadOp = WGPULoadOp_Clear;
    color.storeOp = WGPUStoreOp_Store;
#if defined(MYSTRAL_WEBGPU_DAWN)
    color.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
#endif
    WGPURenderPassDescriptor passDesc = {};
    passDesc.colorAttachmentCount = 1;
    passDesc.colorAttachments = &color;
    WGPURenderPassEncoder pass = beginTimedRenderPass(mipEncoder_, &passDesc);
    wgpuRenderPassEncoderSetPipeline(pass, pipeline);
    wgpuRenderPassEncoderSetBindGroup(pass, 0, group, 0, nullptr);
    wgpuRenderPassEncoderSetVertexBuffer(pass, blitVertex_.attributes.at(0).location, gpu_.buffer(outputTriangle_), 0, 24);
    wgpuRenderPassEncoderDraw(pass, 3, 1, 0, 0);
    wgpuRenderPassEncoderEnd(pass);
    wgpuRenderPassEncoderRelease(pass);
    mipGroups_.push_back(group);
    mipViews_.push_back(view);
    if (mipmaps && into.levels > 1) generateMipmaps(into.texture, into.format, into.levels, into.layers);
    flushMipmaps();  // after this renderer's draws of the layer, before its next draw replaces the scene colour
}

GpuStatus readRenderTarget(RenderTarget& target, uint32_t x, uint32_t y, uint32_t width, uint32_t height,
                           ReadbackCallback done) {
    if (!done) return GpuStatus::OutOfRange;
    if (!target.gpu) return GpuStatus::InvalidHandle;
    if (width == 0 || height == 0 || uint64_t(x) + width > target.width || uint64_t(y) + height > target.height)
        return GpuStatus::OutOfRange;
    auto& gpu = *static_cast<TargetGpu*>(target.gpu.get());
    const uint32_t full = target.width;
    const bool floatType = target.texture->isFloat();
    const bool stored32 = floatType && !target.halfPrecision;  // what the GPU texture holds
    return gpu.renderer->readProbePixels(
        [x, y, width, height, full, floatType, stored32, done = std::move(done)](GpuStatus status,
                                                                                std::vector<uint8_t> bytes) {
            if (status != GpuStatus::Ok) {
                done(status, {});
                return;
            }
            const uint32_t stored = stored32 ? 16 : 8, out = floatType ? 16 : 8;  // a FloatType read is always float32 rows
            std::vector<uint8_t> region(std::size_t(width) * height * out);
            for (uint32_t row = 0; row < height; ++row) {
                const uint8_t* source = bytes.data() + (std::size_t(y + row) * full + x) * stored;
                uint8_t* destination = region.data() + std::size_t(row) * width * out;
                if (stored == out) {
                    std::memcpy(destination, source, std::size_t(width) * out);
                    continue;
                }
                for (std::size_t i = 0; i < std::size_t(width) * 4; ++i) {  // half float rows widened for a FloatType read
                    uint16_t bits;
                    std::memcpy(&bits, source + i * 2, 2);
                    const float value = halfToFloat(bits);
                    std::memcpy(destination + i * 4, &value, 4);
                }
            }
            done(GpuStatus::Ok, std::move(region));
        });
}

}  // namespace tn::engine
