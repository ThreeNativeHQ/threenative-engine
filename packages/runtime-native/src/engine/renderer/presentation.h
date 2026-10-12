#pragma once

#include <cstdint>

#include <webgpu/webgpu.h>

namespace mystral::webgpu {
class Context;
}

namespace tn::engine {

/**
 * The one presentation owner (PRD-509 phase 2). A resize or a lost surface reconfigures the surface
 * and recreates the size-dependent targets it owns (depth); the device and every other resource
 * are untouched, so a resize never enters the device-loss path.
 */
class Presenter {
public:
    explicit Presenter(mystral::webgpu::Context& context);
    ~Presenter();
    Presenter(const Presenter&) = delete;
    Presenter& operator=(const Presenter&) = delete;

    bool resize(uint32_t width, uint32_t height);

    struct Frame {
        WGPUTextureView color = nullptr;  // owned by the context until present
        WGPUTextureView depth = nullptr;
        uint32_t width = 0;
        uint32_t height = 0;
    };
    /** Acquires the next surface image; an outdated surface is reconfigured once and retried. */
    bool begin(Frame& frame);
    void present();

    uint32_t width() const { return width_; }
    uint32_t height() const { return height_; }
    uint32_t depthRebuilds() const { return depthRebuilds_; }
    static constexpr WGPUTextureFormat kDepthFormat = WGPUTextureFormat_Depth32Float;

private:
    bool rebuildDepth();
    void releaseDepth();

    mystral::webgpu::Context& context_;
    WGPUTexture depth_ = nullptr;
    WGPUTextureView depthView_ = nullptr;
    uint32_t width_ = 0;
    uint32_t height_ = 0;
    uint32_t depthRebuilds_ = 0;
};

}  // namespace tn::engine
