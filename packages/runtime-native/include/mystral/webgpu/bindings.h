#pragma once

#include "mystral/webgpu/presentation.h"

#include <cstddef>
#include <cstdint>
#include <memory>

#include "mystral/host/frame_capture.h"

namespace mystral {
namespace js {
class Engine;
}

namespace webgpu {

struct BindingsState;

BindingsState* createBindingsState();
// Takes ownership of the caller's state pointer and sets it to nullptr before cleanup. Callers
// may safely invoke this function again with the same pointer variable; retained raw pointer
// aliases are not valid after the first call.
void destroyBindingsState(BindingsState*& state);

// PRD-327. Pipeline compiles run on a host pool; their promises settle on the game thread, in
// `pollEvents()`'s `kIo` segment. Declared here rather than in `webgpu/bindings_pipelines.h` so
// `runtime.cpp` reaches it through the header it already includes.
void drainAsyncPipelineCompiles(BindingsState* state);
void shutdownAsyncPipelineCompiles(BindingsState* state);

// Buffer maps use the same main-thread settlement boundary. The backend callback may arrive from
// a device thread, but only `pollEvents()` is allowed to enter the JavaScript engine.
void drainAsyncBufferMaps(BindingsState* state);
void shutdownAsyncBufferMaps(BindingsState* state);

bool initBindings(
    BindingsState* state,
    js::Engine* engine,
    void* wgpuInstance,
    void* wgpuDevice,
    void* wgpuQueue,
    void* wgpuSurface,
    uint32_t surfaceFormat,
    uint32_t presentMode,
    uint32_t width,
    uint32_t height,
    bool debug,
    void* wgpuAdapter = nullptr,
    void* surfaceNativeHandle = nullptr);

// Drops every reference to the live presentation surface, ahead of a rebuild. Android replaces
// the `ANativeWindow` behind a backgrounded app rather than reconfiguring it, and wgpu-native
// aborts the process if a surface is torn down with a swapchain image still outstanding.
void detachSurfaceForRebuild(BindingsState* state);

// Publishes a rebuilt surface to the bindings, which is where every present reads it from.
void republishSurface(BindingsState* state, void* wgpuSurface, uint32_t surfaceFormat,
                      uint32_t presentMode, uint32_t width, uint32_t height,
                      void* surfaceNativeHandle = nullptr);

void setOffscreenTexture(BindingsState* state, void* texture, void* textureView);
void beginDawnFrame(BindingsState* state);
void endDawnFrame(BindingsState* state);

void* getCurrentRenderedTexture(BindingsState* state);
uint32_t getCurrentTextureWidth(BindingsState* state);
uint32_t getCurrentTextureHeight(BindingsState* state);
void* getCurrentSurfaceTexture(BindingsState* state);
void* getScreenshotBuffer(BindingsState* state);
size_t getScreenshotBufferSize(BindingsState* state);
uint32_t getScreenshotBytesPerRow(BindingsState* state);
uint32_t getScreenshotFormat(BindingsState* state);
uint64_t presentCount(BindingsState* state);
bool isScreenshotReady(BindingsState* state);
void clearScreenshotReady(BindingsState* state);
void requestFrameScreenshot(BindingsState* state);
/** The bindings as the GPU context's frame-capture source; the caller owns it and drops it before the state. */
std::unique_ptr<host::IFrameCaptureSource> makeFrameCaptureSource(BindingsState* state);

void compositeCanvas2DToWebGPU(BindingsState* state);

/**
 * Draw the attached native UI layer over this frame's colour target. Returns true when a quad was
 * drawn; false when there is no overlay, nothing has been painted yet, or the frame has no target.
 *
 * PRD-393. Called after the frame's own passes and before `presentPendingSurface()`, so the UI is
 * carried by the same present as the world.
 */
bool compositeUiOverlayToWebGPU(BindingsState* state);

using VideoCaptureCallback = void (*)(void* texture, uint32_t width, uint32_t height, void* userData);
void setVideoCaptureCallback(BindingsState* state, VideoCaptureCallback callback, void* userData);
void clearVideoCaptureCallback(BindingsState* state);

// Roll back a resource that was registered before its JavaScript wrapper finished installing.
// Each helper removes exactly one matching registry entry and releases its native ownership.
void releaseTextureRegistryEntry(BindingsState* state, uint64_t textureId);
void releaseBufferRegistryEntry(BindingsState* state, uint64_t bufferId);
void releaseComputePipelineRegistryEntry(BindingsState* state, uint64_t pipelineId);
void releaseRenderPipelineRegistryEntry(BindingsState* state, uint64_t pipelineId);

}  // namespace webgpu
}  // namespace mystral
