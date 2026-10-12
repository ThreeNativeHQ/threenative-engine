#include "engine/renderer/render_target_pass.h"

#include "engine/renderer/render_database.h"

#include <cstring>
#include <memory>
#include <utility>

namespace tn::engine {

namespace {

struct TargetGpu {
    std::unique_ptr<Renderer> renderer;
    std::unique_ptr<RenderDatabase> database;
    bool rendered = false;  // the target's colour holds a render (else it is drawn empty before a read)
};

TargetGpu& gpuOf(Renderer& main, RenderTarget& target) {
    if (!target.gpu) {
        auto gpu = std::make_shared<TargetGpu>();
        gpu->renderer = main.sibling();
        gpu->database = std::make_unique<RenderDatabase>();
        target.gpu = std::move(gpu);
    }
    auto& gpu = *static_cast<TargetGpu*>(target.gpu.get());
    gpu.renderer->setSize(target.width, target.height);  // a no-op at the same extent
    return gpu;
}

}  // namespace

std::vector<std::string> renderToTarget(Renderer& main, RenderTarget& target, Object3D& root, Camera& camera,
                                        std::array<double, 4> clear, bool shadowMap) {
    TargetGpu& gpu = gpuOf(main, target);
    gpu.database->shadowMapEnabled = shadowMap;
    gpu.database->render(*gpu.renderer, root, camera, clear);
    gpu.rendered = true;
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
    return gpu.renderer->readProbePixels(
        [x, y, width, height, full, done = std::move(done)](GpuStatus status, std::vector<uint8_t> bytes) {
            if (status != GpuStatus::Ok) {
                done(status, {});
                return;
            }
            constexpr uint32_t texel = 8;  // RGBA16Float
            std::vector<uint8_t> region(std::size_t(width) * height * texel);
            for (uint32_t row = 0; row < height; ++row)
                std::memcpy(region.data() + std::size_t(row) * width * texel,
                            bytes.data() + (std::size_t(y + row) * full + x) * texel, std::size_t(width) * texel);
            done(GpuStatus::Ok, std::move(region));
        });
}

}  // namespace tn::engine
