/** WebGPU screenshot capture. */

#include "bindings_state.h"
#include "mystral/webgpu/bindings.h"
#include "mystral/webgpu/checked_handle.h"

#include <iostream>

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

// Getter for current texture (used by screenshot)
void* getCurrentRenderedTexture(BindingsState* state) {
#if defined(MYSTRAL_WEBGPU_WGPU) || defined(MYSTRAL_WEBGPU_DAWN)
    return state->presentation.currentTexture;
#else
    return nullptr;
#endif
}

uint32_t getCurrentTextureWidth(BindingsState* state) { return state->presentation.canvasWidth; }

uint32_t getCurrentTextureHeight(BindingsState* state) { return state->presentation.canvasHeight; }

void* getCurrentSurfaceTexture(BindingsState* state) {
#if defined(MYSTRAL_WEBGPU_WGPU) || defined(MYSTRAL_WEBGPU_DAWN)
    // Return the texture that the current view was created from (for screenshots)
    // or the current texture if no view was created yet
    return state->presentation.currentViewSourceTexture ? state->presentation.currentViewSourceTexture
                                                        : state->presentation.currentTexture;
#else
    return nullptr;
#endif
}

// Screenshot buffer access
void* getScreenshotBuffer(BindingsState* state) {
#if defined(MYSTRAL_WEBGPU_WGPU) || defined(MYSTRAL_WEBGPU_DAWN)
    return state->screenshot.screenshotBuffer;
#else
    return nullptr;
#endif
}

size_t getScreenshotBufferSize(BindingsState* state) { return state->screenshot.screenshotBufferSize; }

uint32_t getScreenshotBytesPerRow(BindingsState* state) { return state->screenshot.screenshotBytesPerRow; }

uint32_t getScreenshotFormat(BindingsState* state) { return static_cast<uint32_t>(state->presentation.surfaceFormat); }

bool isScreenshotReady(BindingsState* state) { return state->screenshot.screenshotReady; }

void clearScreenshotReady(BindingsState* state) { state->screenshot.screenshotReady = false; }

void requestFrameScreenshot(BindingsState* state) { state->screenshot.screenshotRequested = true; }

namespace {
class BindingsFrameCapture final : public host::IFrameCaptureSource {
public:
    explicit BindingsFrameCapture(BindingsState* state) : state_(state) {}
    void request() override { requestFrameScreenshot(state_); }
    bool ready() const override { return isScreenshotReady(state_); }
    void clearReady() override { clearScreenshotReady(state_); }
    host::FrameCaptureView view() const override {
        return {getScreenshotBuffer(state_),         getScreenshotBufferSize(state_),
                getCurrentTextureWidth(state_),      getCurrentTextureHeight(state_),
                getScreenshotBytesPerRow(state_),    getScreenshotFormat(state_)};
    }

private:
    BindingsState* state_;
};
}  // namespace

std::unique_ptr<host::IFrameCaptureSource> makeFrameCaptureSource(BindingsState* state) {
    return std::make_unique<BindingsFrameCapture>(state);
}

/**
 * Copies the finished frame into the screenshot buffer.
 *
 * This used to run inside `queue.submit`, on the first submit whose surface pass had ended. A
 * frame that renders an overlay submits twice, so the capture happened after the world pass and
 * before the overlay — every native screenshot was of a half-finished frame, and any gate reading
 * one could not see an overlay at all. It now runs at the frame boundary, with everything drawn.
 */
void captureFrameScreenshot(BindingsState* state) {
    // Copy texture to screenshot buffer ONLY when about to present
    // This prevents capturing intermediate render passes (e.g., Three.js post-processing)
    // Only capture when the surface render pass has ended, matching the present condition
    // Also ensure we only capture once per frame (Three.js does multiple queue.submit() per frame)
    WGPUTexture screenshotTexture = state->presentation.currentViewSourceTexture
                                        ? state->presentation.currentViewSourceTexture
                                        : state->presentation.currentTexture;
    // Requested only: a frame nobody asked to capture performs no copy and pays none of the
    // completion wait below. Consumers raise the flag via requestFrameScreenshot() before reading.
    if (state->screenshot.screenshotRequested && state->presentation.surfaceRenderPassEnded &&
        !state->screenshot.screenshotCapturedThisFrame && screenshotTexture && state->device && state->queue) {
        // Calculate buffer requirements
        uint32_t bytesPerPixel = 4;  // BGRA8
        uint32_t unalignedBytesPerRow = state->presentation.canvasWidth * bytesPerPixel;
        uint32_t bytesPerRow = (unalignedBytesPerRow + 255) & ~255;  // Align to 256
        size_t requiredSize = bytesPerRow * state->presentation.canvasHeight;

        // Create or resize screenshot buffer if needed
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
        }
        state->screenshot.screenshotBytesPerRow = bytesPerRow;

        // Create encoder to copy texture to buffer
        WGPUCommandEncoderDescriptor encDesc = {};
        WGPUCommandEncoder copyEncoder = wgpuDeviceCreateCommandEncoder(state->device, &encDesc);
        if (!requireHandleHostSide(copyEncoder, "screenshot.createCommandEncoder")) return;

        WGPUImageCopyTexture_Compat srcCopy = {};
        srcCopy.texture = screenshotTexture;
        srcCopy.mipLevel = 0;
        srcCopy.origin = {0, 0, 0};
        srcCopy.aspect = WGPUTextureAspect_All;

        WGPUImageCopyBuffer_Compat dstCopy = {};
        dstCopy.buffer = state->screenshot.screenshotBuffer;
        dstCopy.layout.offset = 0;
        dstCopy.layout.bytesPerRow = bytesPerRow;
        dstCopy.layout.rowsPerImage = state->presentation.canvasHeight;

        WGPUExtent3D copySize = {state->presentation.canvasWidth, state->presentation.canvasHeight, 1};
        wgpuCommandEncoderCopyTextureToBuffer(copyEncoder, &srcCopy, &dstCopy, &copySize);

        if (state->verboseLogging)
            std::cout << "[Screenshot] Copying from texture " << (void*)screenshotTexture
                      << " (format=" << state->presentation.surfaceFormat
                      << ", size=" << state->presentation.canvasWidth << "x" << state->presentation.canvasHeight << ")"
                      << std::endl;

        WGPUCommandBufferDescriptor cmdDesc = {};
        WGPUCommandBuffer copyCmd = wgpuCommandEncoderFinish(copyEncoder, &cmdDesc);
        if (!requireHandleHostSide(copyCmd, "screenshot.finish")) {
            wgpuCommandEncoderRelease(copyEncoder);
            return;
        }
        wgpuQueueSubmit(state->queue, 1, &copyCmd);

        wgpuCommandBufferRelease(copyCmd);
        wgpuCommandEncoderRelease(copyEncoder);

        // Wait for GPU work to complete before present
        // This ensures the screenshot copy finishes before the texture is released
        for (int syncIter = 0; syncIter < 100; syncIter++) {
#if defined(MYSTRAL_WEBGPU_DAWN)
            wgpuDeviceTick(state->device);
#elif defined(MYSTRAL_WEBGPU_WGPU)
            wgpuDevicePoll(state->device, false, nullptr);
#endif
            if (state->instance) {
                wgpuInstanceProcessEvents(state->instance);
            }
        }

        state->screenshot.screenshotReady = true;
        state->screenshot.screenshotRequested = false;
        state->screenshot.screenshotCapturedThisFrame = true;
    }
}

}  // namespace webgpu
}  // namespace mystral
