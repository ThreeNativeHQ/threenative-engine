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
// Test-only. How many times the pacing owner has blocked so far: one display-frame wait, or one
// software-deadline sleep. A test proves "returns without waiting" by reading it around the call,
// instead of measuring a wall clock a loaded runner overruns.
uint32_t presentationPacingWaitCountForTest();

// Shared by the legacy bindings and JS-free player, including resize/recovery.
void configurePresentationSurface(WGPUSurfaceImpl* surface, const WGPUSurfaceConfiguration* config);
// Android's synchronous driver call is guarded by a two-second fatal deadline. A blocked
// acquire cannot be cancelled safely; never release/reconfigure a surface still inside it.
void acquirePresentationSurface(WGPUSurfaceImpl* surface, WGPUSurfaceTexture* texture);

}  // namespace mystral::webgpu
