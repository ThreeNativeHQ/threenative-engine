#pragma once

#include <chrono>
#include <cstdint>

struct WGPUSurfaceImpl;
struct WGPUSurfaceConfiguration;
struct WGPUSurfaceTexture;

namespace mystral::webgpu {

enum class PresentationPacingPath {
    Uncapped,
    Display,
    SoftwareDeadline,
    DisplayTimeoutFallback,
};

bool setPresentationCapHz(uint32_t hz);
uint32_t getPresentationCapHz();
void notePresentationFramesStarted();
void notePresentationFramesStopped();
void notePresentationFrame(int64_t frameTimeNs);
PresentationPacingPath paceToPresentationCap();
// Zero restores the production display wait (two intervals plus 50 ms).
void setPresentationPacingTimeoutForTest(std::chrono::milliseconds timeout);

// Shared by the legacy bindings and JS-free player, including resize/recovery.
void configurePresentationSurface(WGPUSurfaceImpl* surface, const WGPUSurfaceConfiguration* config);
// Android's synchronous driver call is guarded by a two-second fatal deadline. A blocked
// acquire cannot be cancelled safely; never release/reconfigure a surface still inside it.
void acquirePresentationSurface(WGPUSurfaceImpl* surface, WGPUSurfaceTexture* texture);

}  // namespace mystral::webgpu
