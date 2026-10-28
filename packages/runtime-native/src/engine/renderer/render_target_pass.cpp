#include "engine/renderer/render_target_pass.h"

#include "engine/renderer/render_database.h"

#include <cmath>
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
};

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
    return gpu;
}

}  // namespace

std::vector<std::string> renderToTarget(Renderer& main, RenderTarget& target, Object3D& root, Camera& camera,
                                        std::array<double, 4> clear, bool shadowMap, bool deferred) {
    if (deferred && target.depthTexture)
        return {"TN_NATIVE_DEFERRED_TARGET_DEPTH: a deferred render target cannot carry a depth texture"};
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
    std::vector<std::string> diagnostics = gpu.database->diagnostics();
    for (const std::string& message : gpu.renderer->diagnostics()) diagnostics.push_back(message);
    return diagnostics;
}

WGPUTextureView renderTargetView(Renderer& main, RenderTarget& target) {
    TargetGpu& gpu = gpuOf(main, target);
    if (!gpu.rendered) {
        gpu.renderer->render({}, CameraState{}, LightState{}, {0, 0, 0, 0});
        gpu.rendered = true;
    }
    return gpu.renderer->sceneColorView();
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
