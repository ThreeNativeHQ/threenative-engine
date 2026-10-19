// Exercise the production presentation draw against a real GPU destination, including its
// bottom/right edges. Canvas readback alone cannot catch a cropped or black native presentation.
#include "mystral/runtime.h"
#include "mystral/webgpu/bindings.h"
#include "../src/webgpu/bindings_presentation.h"
#include "../src/webgpu/bindings_state.h"

#include <array>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <vector>

namespace {
using namespace mystral::webgpu;

struct Texture {
    WGPUTexture texture = nullptr;
    WGPUTextureView view = nullptr;
    Texture(WGPUDevice device, uint32_t width, uint32_t height, WGPUTextureFormat format) {
        WGPUTextureDescriptor descriptor = {};
        descriptor.dimension = WGPUTextureDimension_2D;
        descriptor.size = {width, height, 1};
        descriptor.format = format;
        descriptor.mipLevelCount = 1;
        descriptor.sampleCount = 1;
        descriptor.usage = WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_TextureBinding |
                           WGPUTextureUsage_CopySrc | WGPUTextureUsage_CopyDst;
        texture = wgpuDeviceCreateTexture(device, &descriptor);
        if (texture) view = wgpuTextureCreateView(texture, nullptr);
    }
    ~Texture() {
        if (view) wgpuTextureViewRelease(view);
        if (texture) wgpuTextureRelease(texture);
    }
};

bool verifyDestination(mystral::Runtime& runtime, WGPUTextureFormat format,
                       uint32_t width, uint32_t height) {
    auto* state = static_cast<BindingsState*>(runtime.getWebGPUBindingsState());
    // Source and destination differ in size and contain asymmetric, non-primary colors.
    // This catches wrong UV orientation, out-of-bounds loads and an unwanted sRGB conversion.
    constexpr uint32_t sourceWidth = 4, sourceHeight = 2;
    constexpr std::array<uint8_t, sourceWidth * sourceHeight * 4> source = {
        32, 64, 128, 255,  64, 96, 160, 255,  96, 128, 192, 255,  128, 160, 224, 255,
        224, 160, 128, 255,  192, 128, 96, 255,  160, 96, 64, 255,  128, 64, 32, 255,
    };
    // Re-publication invalidates a cached pipeline when the destination format changes.
    republishSurface(state, nullptr, static_cast<uint32_t>(format),
                     static_cast<uint32_t>(WGPUPresentMode_Fifo), width, height);
    state->presentation.requiresSrgbPresentationBridge = isSrgbSurfaceFormat(format);
    state->presentation.canvasWidth = sourceWidth;
    state->presentation.canvasHeight = sourceHeight;
    Texture sourceTexture(state->device, sourceWidth, sourceHeight, WGPUTextureFormat_RGBA8Unorm);
    Texture destination(state->device, width, height, format);
    if (!sourceTexture.view || !destination.view) return false;
    WGPUImageCopyTexture_Compat copy = {};
    copy.texture = sourceTexture.texture;
    copy.aspect = WGPUTextureAspect_All;
    WGPUTextureDataLayout_Compat layout = {};
    layout.bytesPerRow = sourceWidth * 4;
    layout.rowsPerImage = sourceHeight;
    WGPUExtent3D extent = {sourceWidth, sourceHeight, 1};
    wgpuQueueWriteTexture(state->queue, &copy, source.data(), source.size(), &layout, &extent);
    if (!blitPresentationTexture(state, sourceTexture.view, destination.view)) return false;

    // Reuse the runtime's actual GPU readback, pointed at the bridge's destination texture.
    // No frame is presented here; real swapchain acquisition is covered by the hosted fog run.
    state->presentation.canvasWidth = width;
    state->presentation.canvasHeight = height;
    state->presentation.surfaceFormat = format;
    state->presentation.currentTexture = destination.texture;
    state->presentation.currentViewSourceTexture = nullptr;
    state->presentation.surfaceRenderPassEnded = true;
    state->screenshot.screenshotCapturedThisFrame = false;
    requestFrameScreenshot(state);
    captureFrameScreenshot(state);
    std::vector<uint8_t> pixels;
    uint32_t capturedWidth = 0, capturedHeight = 0;
    const bool captured = runtime.captureFrame(pixels, capturedWidth, capturedHeight);
    state->presentation.currentTexture = nullptr;
    state->presentation.surfaceRenderPassEnded = false;
    if (!captured || capturedWidth != width || capturedHeight != height ||
        pixels.size() != width * height * 4) return false;
    for (uint32_t y = 0; y < height; ++y) {
        for (uint32_t x = 0; x < width; ++x) {
            const uint32_t sx = ((2 * x + 1) * sourceWidth) / (2 * width);
            const uint32_t sy = ((2 * y + 1) * sourceHeight) / (2 * height);
            for (uint32_t channel = 0; channel < 4; ++channel) {
                const int actual = pixels[(y * width + x) * 4 + channel];
                const int expected = source[(sy * sourceWidth + sx) * 4 + channel];
                // sRGB encode/decode may round one UNORM byte; linear copies are exact.
                const int tolerance = isSrgbSurfaceFormat(format) && channel != 3 ? 1 : 0;
                if (std::abs(actual - expected) > tolerance) {
                    std::cerr << "presentation pixel mismatch at " << x << "," << y
                              << " channel=" << channel << " actual=" << actual
                              << " expected=" << expected << " format=" << format << '\n';
                    return false;
                }
            }
        }
    }
    return true;
}
}  // namespace

int main() {
    mystral::RuntimeConfig config;
    config.noSdl = true;
    config.width = 4;
    config.height = 2;
    auto runtime = mystral::Runtime::create(config);
    if (!runtime) return 1;
    auto* state = static_cast<BindingsState*>(runtime->getWebGPUBindingsState());
    state->presentation.requiresSrgbPresentationBridge = false;
    state->presentation.surfaceWidth = state->presentation.canvasWidth;
    state->presentation.surfaceHeight = state->presentation.canvasHeight;
    if (requiresPresentationBridge(state)) return 2;
    state->presentation.surfaceWidth *= 2;
    if (!requiresPresentationBridge(state)) return 3;
    for (const auto format : {WGPUTextureFormat_RGBA8Unorm, WGPUTextureFormat_RGBA8UnormSrgb}) {
        for (const auto size : {std::array<uint32_t, 2>{12, 8}, {4, 2}, {2, 1}}) {
            if (!verifyDestination(*runtime, format, size[0], size[1])) return 4;
        }
    }
    std::cout << "native canvas presentation pixels passed\n";
    return 0;
}
