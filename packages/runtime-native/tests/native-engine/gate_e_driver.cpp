// Gate E (PRD-499): a native application that clears and presents frames with no JS engine,
// no engine bundle and no web view. It links only the host services; the frame readback runs
// through the same IFrameCaptureSource seam the scripting bindings use.

#include "mystral/host/frame_capture.h"
#include "mystral/webgpu/context.h"

#include <webgpu/webgpu.h>
#include "mystral/webgpu_compat.h"

#include <cstdio>
#include <cstdlib>
#include <vector>

namespace {

constexpr uint32_t kWidth = 64;
constexpr uint32_t kHeight = 64;
constexpr int kFrames = 300;

int fail(const char* what) {
    std::fprintf(stderr, "GATE_E_FAIL %s\n", what);
    return 1;
}

uint8_t redFor(int frame) { return static_cast<uint8_t>(frame % 256); }

// Owns the readback buffer for the offscreen target, as the bindings own theirs for the surface.
class OffscreenCapture final : public mystral::host::IFrameCaptureSource {
public:
    OffscreenCapture(WGPUDevice device, WGPUTexture texture) : device_(device), texture_(texture) {
        WGPUBufferDescriptor desc = {};
        desc.size = size_;
        desc.usage = WGPUBufferUsage_CopyDst | WGPUBufferUsage_MapRead;
        buffer_ = wgpuDeviceCreateBuffer(device_, &desc);
    }
    ~OffscreenCapture() override {
        if (buffer_) wgpuBufferRelease(buffer_);
    }

    void request() override { requested_ = true; }
    bool ready() const override { return ready_; }
    void clearReady() override { ready_ = false; }
    mystral::host::FrameCaptureView view() const override {
        return {buffer_, size_, kWidth, kHeight, kBytesPerRow, WGPUTextureFormat_BGRA8Unorm};
    }

    // Records the copy into the frame's encoder when a capture was requested.
    void record(WGPUCommandEncoder encoder) {
        if (!requested_ || !buffer_) return;
        WGPUImageCopyTexture_Compat src = {};
        src.texture = texture_;
        src.aspect = WGPUTextureAspect_All;
        WGPUImageCopyBuffer_Compat dst = {};
        dst.buffer = buffer_;
        dst.layout.bytesPerRow = kBytesPerRow;
        dst.layout.rowsPerImage = kHeight;
        WGPUExtent3D extent = {kWidth, kHeight, 1};
        wgpuCommandEncoderCopyTextureToBuffer(encoder, &src, &dst, &extent);
        requested_ = false;
        ready_ = true;
    }

private:
    static constexpr uint32_t kBytesPerRow = 256;  // kWidth * 4, already 256-aligned
    WGPUDevice device_;
    WGPUTexture texture_;
    WGPUBuffer buffer_ = nullptr;
    size_t size_ = static_cast<size_t>(kBytesPerRow) * kHeight;
    bool requested_ = false;
    bool ready_ = false;
};

}  // namespace

int main() {
    mystral::webgpu::Context context;
    if (!context.initializeHeadless()) return fail("initializeHeadless");
    if (!context.createOffscreenTarget(kWidth, kHeight)) return fail("createOffscreenTarget");

    WGPUDevice device = context.getDevice();
    WGPUQueue queue = context.getQueue();
    auto* view = static_cast<WGPUTextureView>(context.getOffscreenTextureView());
    OffscreenCapture capture(device, static_cast<WGPUTexture>(context.getOffscreenTexture()));
    context.setFrameCaptureSource(&capture);

    for (int frame = 0; frame < kFrames; ++frame) {
        if (frame == kFrames - 1) context.requestFrameScreenshot();

        WGPUCommandEncoderDescriptor encoderDesc = {};
        WGPUCommandEncoder encoder = wgpuDeviceCreateCommandEncoder(device, &encoderDesc);
        if (!encoder) return fail("createCommandEncoder");

        WGPURenderPassColorAttachment color = {};
        color.view = view;
        color.loadOp = WGPULoadOp_Clear;
        color.storeOp = WGPUStoreOp_Store;
        color.clearValue = {redFor(frame) / 255.0, 0.0, 1.0, 1.0};
#if defined(MYSTRAL_WEBGPU_DAWN)
        color.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
#endif
        WGPURenderPassDescriptor passDesc = {};
        passDesc.colorAttachmentCount = 1;
        passDesc.colorAttachments = &color;
        WGPURenderPassEncoder pass = wgpuCommandEncoderBeginRenderPass(encoder, &passDesc);
        wgpuRenderPassEncoderEnd(pass);
        wgpuRenderPassEncoderRelease(pass);

        capture.record(encoder);

        WGPUCommandBufferDescriptor commandDesc = {};
        WGPUCommandBuffer commands = wgpuCommandEncoderFinish(encoder, &commandDesc);
        wgpuCommandEncoderRelease(encoder);
        if (!commands) return fail("finish");
        wgpuQueueSubmit(queue, 1, &commands);
        wgpuCommandBufferRelease(commands);
    }

    if (!context.isFrameScreenshotReady()) return fail("capture not ready after the last frame");
    std::vector<uint8_t> rgba;
    uint32_t width = 0;
    uint32_t height = 0;
    if (!context.captureFrame(rgba, width, height)) return fail("captureFrame");
    context.setFrameCaptureSource(nullptr);
    if (width != kWidth || height != kHeight || rgba.size() != size_t{kWidth} * kHeight * 4) {
        return fail("capture size");
    }

    // Every pixel holds the last frame's clear, so the readback proves all frames ran in order.
    const int wantRed = redFor(kFrames - 1);
    for (size_t i = 0; i < rgba.size(); i += 4) {
        if (std::abs(rgba[i] - wantRed) > 1 || rgba[i + 1] != 0 || rgba[i + 2] != 255 || rgba[i + 3] != 255) {
            std::fprintf(stderr, "GATE_E_FAIL pixel %zu = %u,%u,%u,%u want %d,0,255,255\n", i / 4, rgba[i],
                         rgba[i + 1], rgba[i + 2], rgba[i + 3], wantRed);
            return 1;
        }
    }
    std::printf("GATE_E_OK frames=%d size=%ux%u\n", kFrames, width, height);
    return 0;
}
