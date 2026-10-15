#pragma once

#include <cstdint>
#include <vector>

#include "mystral/host/frame_capture.h"

// Forward declare WebGPU types to avoid header dependency
typedef struct WGPUInstanceImpl* WGPUInstance;
typedef struct WGPUSurfaceImpl* WGPUSurface;
typedef struct WGPUTextureViewImpl* WGPUTextureView;
typedef struct WGPUTextureImpl* WGPUTexture;
typedef struct WGPUAdapterImpl* WGPUAdapter;
typedef struct WGPUDeviceImpl* WGPUDevice;
typedef struct WGPUQueueImpl* WGPUQueue;

namespace mystral {
namespace webgpu {

/**
 * WebGPU Context
 *
 * Manages WebGPU initialization and provides access to the device/queue.
 * Works with both wgpu-native and Dawn backends (they share webgpu.h API).
 */
class Context {
public:
    Context();
    ~Context();

    /**
     * Initialize WebGPU - create instance only
     * @return true on success
     */
    bool initialize();

    /**
     * Initialize WebGPU in headless mode (no SDL/window required)
     * Creates instance, adapter, and device without a surface.
     * Use createOffscreenTarget() for rendering to textures.
     * @return true on success
     */
    bool initializeHeadless();

    /**
     * Create an offscreen render target for headless rendering
     * @param width Texture width
     * @param height Texture height
     * @return true on success
     */
    bool createOffscreenTarget(uint32_t width, uint32_t height);

    /**
     * Get the offscreen texture (for no-SDL mode)
     */
    void* getOffscreenTexture() { return offscreenTexture_; }

    /**
     * Get the offscreen texture view (for no-SDL mode)
     */
    void* getOffscreenTextureView() { return offscreenTextureView_; }

    /**
     * Check if running in headless (no-sdl) mode
     */
    bool isHeadless() const { return headless_; }

    /**
     * Create a surface from a native window handle
     * @param metalLayer On macOS/iOS: CAMetalLayer*
     * @param hwnd On Windows: HWND
     * @param display On Linux/Wayland: display pointer
     * @param surface On Linux/Wayland: surface pointer
     * @return true on success
     */
    bool createSurface(void* nativeHandle, int platformType);

    /**
     * Create a surface from a native window handle with display pointer (for X11/Wayland)
     * @param display X11 Display* or Wayland display
     * @param window X11 Window or Wayland surface
     * @param platformType PLATFORM_XLIB or PLATFORM_WAYLAND
     * @return true on success
     */
    bool createSurfaceWithDisplay(void* display, void* window, int platformType);

    /**
     * Configure the surface for rendering
     * @param width Window width
     * @param height Window height
     * @return true on success
     */
    bool configureSurface(uint32_t width, uint32_t height, bool vsync);
    // Recovery callers that omit a mode must preserve the current Android presentation path.
    bool configureSurface(uint32_t width, uint32_t height) {
        return configureSurface(width, height, vsync_);
    }

    /**
     * Resize the surface
     */
    void resizeSurface(uint32_t width, uint32_t height);

    /**
     * Rebuild the surface against a new native window, keeping the adapter, device and queue.
     *
     * Android destroys the `ANativeWindow` behind a backgrounded app and hands back a new one on
     * resume; the surface built at startup then points at nothing and every present after resume
     * goes nowhere. The device and everything the game allocated on it are unaffected, so this
     * swaps the surface alone and leaves the caller to `configureSurface` at the current size.
     * Returns false rather than leaving the old, dead surface in place silently.
     */
    bool rebuildSurface(void* nativeHandle, int platformType);
    /** Release only window-bound objects before Android destroys its native window. */
    void releaseSurface();
    /** How many devices and surfaces this context has built: a lifecycle check can tell a rebuild from a reuse. */
    uint32_t deviceCreations() const { return deviceCreations_; }
    uint32_t surfaceCreations() const { return surfaceCreations_; }

    /** The native window the live surface was built from, or nullptr. */
    void* getSurfaceNativeHandle() const { return surfaceNativeHandle_; }
    int getSurfacePlatformType() const { return surfacePlatformType_; }

    /**
     * Get the current texture to render to
     * @return WGPUTextureView owned by this context until present/reconfigure, or nullptr if failed
     */
    void* getCurrentTextureView();

    /**
     * Present the current frame
     */
    bool present(); // true only when the surface present API reports success

    /**
     * Capture a screenshot of the current surface
     * @param filename Path to save the PNG file
     * @return true on success
     */
    bool saveScreenshot(const char* filename);

    /**
     * Ask for the next presented frame to be captured into the screenshot buffer. Without this,
     * the frame copy and its completion wait are skipped entirely.
     */
    void requestFrameScreenshot();

    /**
     * True once a requested capture has landed in the screenshot buffer.
     */
    bool isFrameScreenshotReady();

    /**
     * Drop the ready flag so the next request waits for a fresh capture instead of reading a
     * consumed one.
     */
    void clearFrameScreenshotReady();

    void setFrameCaptureSource(host::IFrameCaptureSource* source) { captureSource_ = source; }

    /**
     * A device-loss observer (the native engine's device lifecycle). Installed, it hears every
     * loss, the context's own destroy included, and the loss is no longer fatal. It may run on any
     * thread the backend chooses, so it must only record the loss. Unset (the legacy host), a loss
     * stays fatal exactly as before.
     */
    using DeviceLostHandler = void (*)(void* user, uint32_t reason, const char* message);
    void setDeviceLostHandler(DeviceLostHandler handler, void* user) {
        lostHandler_ = handler;
        lostHandlerUser_ = user;
    }
    bool notifyDeviceLost(uint32_t reason, const char* message) {
        if (!lostHandler_) return false;
        lostHandler_(lostHandlerUser_, reason, message);
        return true;
    }

    /**
     * Capture the current frame as RGBA pixel data
     * @param outData Output vector to receive RGBA data (width * height * 4 bytes)
     * @param outWidth Output parameter for frame width
     * @param outHeight Output parameter for frame height
     * @return true on success
     */
    bool captureFrame(std::vector<uint8_t>& outData, uint32_t& outWidth, uint32_t& outHeight);

    /**
     * Get surface dimensions
     */
    uint32_t getSurfaceWidth() const { return surfaceWidth_; }
    uint32_t getSurfaceHeight() const { return surfaceHeight_; }

    // Accessors
    WGPUInstance getInstance() const { return instance_; }
    WGPUSurface getSurface() const { return surface_; }
    WGPUAdapter getAdapter() const { return adapter_; }
    WGPUDevice getDevice() const { return device_; }
    WGPUQueue getQueue() const { return queue_; }
    uint32_t getPreferredFormat() const { return preferredFormat_; }
    uint32_t getPresentMode() const { return presentMode_; }

    // Check if initialized
    bool isInitialized() const { return initialized_; }

    // Check if IndirectFirstInstance feature is available
    // This affects whether instance_index in shaders includes firstInstance offset
    bool hasIndirectFirstInstance() const { return hasIndirectFirstInstance_; }
    /**
     * Whether this device was granted `timestamp-query`.
     *
     * The only way to price one pass stage rather than infer it from a blocking device poll:
     * every GPU number in the perf record before this was wall-clock algebra around an ablated
     * scene, which gives a total per object and can never give a cost per pass. Requested as an
     * ordinary optional feature, so an adapter without it degrades to that older behaviour with
     * a reported reason rather than failing to start.
     */
    bool hasTimestampQuery() const { return hasTimestampQuery_; }

    // Platform types for createSurface
    enum PlatformType {
        PLATFORM_METAL = 0,
        PLATFORM_WINDOWS = 1,
        PLATFORM_WAYLAND = 2,
        PLATFORM_XCB = 3,
        PLATFORM_XLIB = 4,
        PLATFORM_ANDROID = 5
    };

private:
    void releaseSurfaceView();
    /** Builds a surface handle for a native window without touching any member state. */
    WGPUSurface makeSurface(void* nativeHandle, int platformType);

    uint32_t deviceCreations_ = 0, surfaceCreations_ = 0;
    WGPUInstance instance_ = nullptr;
    WGPUSurface surface_ = nullptr;
    WGPUTexture surfaceTexture_ = nullptr;
    WGPUTextureView surfaceView_ = nullptr;
    void* surfaceNativeHandle_ = nullptr;
    int surfacePlatformType_ = -1;
    WGPUAdapter adapter_ = nullptr;
    WGPUDevice device_ = nullptr;
    WGPUQueue queue_ = nullptr;

    uint32_t surfaceWidth_ = 0;
    uint32_t surfaceHeight_ = 0;
    uint32_t preferredFormat_ = 0;  // WGPUTextureFormat
    uint32_t presentMode_ = 0;  // WGPUPresentMode
    bool vsync_ = true;

    bool initialized_ = false;
    bool hasIndirectFirstInstance_ = false;  // Whether INDIRECT_FIRST_INSTANCE feature is available
    bool hasTimestampQuery_ = false;         // Whether TIMESTAMP_QUERY was advertised and granted
    bool headless_ = false;  // Running without SDL/window

    // Offscreen rendering (for headless mode)
    void* offscreenTexture_ = nullptr;  // WGPUTexture
    void* offscreenTextureView_ = nullptr;  // WGPUTextureView
    host::IFrameCaptureSource* captureSource_ = nullptr;
    DeviceLostHandler lostHandler_ = nullptr;
    void* lostHandlerUser_ = nullptr;
};

}  // namespace webgpu
}  // namespace mystral
