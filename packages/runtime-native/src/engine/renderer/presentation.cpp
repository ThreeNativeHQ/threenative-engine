#include "presentation.h"

#include "mystral/webgpu/context.h"

namespace tn::engine {

Presenter::Presenter(mystral::webgpu::Context& context)
    : context_(context), width_(context.getSurfaceWidth()), height_(context.getSurfaceHeight()) {
    rebuildDepth();
}

Presenter::~Presenter() { releaseDepth(); }

void Presenter::releaseDepth() {
    if (depthView_) wgpuTextureViewRelease(depthView_);
    if (depth_) {
        wgpuTextureDestroy(depth_);
        wgpuTextureRelease(depth_);
    }
    depthView_ = nullptr;
    depth_ = nullptr;
}

bool Presenter::rebuildDepth() {
    releaseDepth();
    if (width_ == 0 || height_ == 0) return false;
    WGPUTextureDescriptor desc = {};
    desc.dimension = WGPUTextureDimension_2D;
    desc.size = {width_, height_, 1};
    desc.format = kDepthFormat;
    desc.usage = WGPUTextureUsage_RenderAttachment;
    desc.mipLevelCount = 1;
    desc.sampleCount = 1;
    depth_ = wgpuDeviceCreateTexture(context_.getDevice(), &desc);
    if (!depth_) return false;
    depthView_ = wgpuTextureCreateView(depth_, nullptr);
    ++depthRebuilds_;
    return depthView_ != nullptr;
}

bool Presenter::resize(uint32_t width, uint32_t height) {
    if (width == 0 || height == 0) return false;  // minimized: keep the old targets until a real size
    if (width == width_ && height == height_) return true;
    width_ = width;
    height_ = height;
    context_.resizeSurface(width, height);
    return rebuildDepth();
}

bool Presenter::begin(Frame& frame) {
    for (int attempt = 0; attempt < 2; ++attempt) {
        auto* view = static_cast<WGPUTextureView>(context_.getCurrentTextureView());
        if (view) {
            frame = Frame{view, depthView_, width_, height_};
            return true;
        }
        // Outdated or lost surface: reconfigure at the current size, then try once more.
        context_.configureSurface(width_, height_);
    }
    return false;
}

void Presenter::present() { context_.present(); }

}  // namespace tn::engine
