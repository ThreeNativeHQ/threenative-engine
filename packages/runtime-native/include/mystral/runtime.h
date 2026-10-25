#pragma once

#include "mystral/platform/lifecycle.h"

#include <memory>
#include <string>
#include <functional>
#include <vector>
#include <cstdint>

namespace mystral {

/**
 * Runtime configuration options
 */
struct RuntimeConfig {
    int width = 800;
    int height = 600;
    const char* title = "ThreeNative Game";
    bool fullscreen = false;
    // Start maximized when windowed; fullscreen remains authoritative when both are configured.
    bool maximized = false;
    bool vsync = true;
    bool resizable = true;
    bool noSdl = false;  // Run without SDL (headless GPU mode, no window)
    bool watch = false;  // Watch mode: reload script on file changes
    bool debug = false;  // Enable verbose debug logging
    // Maximum native presentation rate. 0 is the explicit uncapped override.
    uint32_t maxFps = 60;
    // Test-only seam: install timers after JS engine creation. Production callers leave this false.
    bool testEngineFirstTimers = false;
    // Native host inputs, not game options. Packaged entrypoints hash the complete bundled source
    // before device creation. Empty means unqualified (memory-only), never guess from a shim eval.
    std::string pipelineCacheAppIdentity;
    std::string pipelineCacheSourceIdentity;
    // The game entry path (or another stable game identity). Namespaces saved progress so two
    // games whose directories share a basename never read or overwrite each other's saves.
    std::string storageIdentity;
    // `display.backgroundMode`. Default pauses the loop off-screen; "continue" is the named
    // override, and it turns pausing off without turning the lifecycle markers off.
    platform::BackgroundMode backgroundMode = platform::BackgroundMode::Pause;
};

/**
 * Mystral Native Runtime
 *
 * A lightweight runtime for JavaScript/TypeScript games using WebGPU.
 * Combines SDL3 for windowing/input, wgpu/Dawn for WebGPU, and V8/JSC/QuickJS for JS.
 *
 * Example usage:
 *   auto runtime = mystral::Runtime::create({.width = 1280, .height = 720});
 *   runtime->loadScript("game.js");
 *   runtime->run();
 */
class Runtime {
public:
    /**
     * Create a new runtime instance
     * @param config Runtime configuration
     * @return Unique pointer to the runtime, or nullptr on failure
     */
    static std::unique_ptr<Runtime> create(const RuntimeConfig& config = {});

    virtual ~Runtime() = default;

    // ========================================================================
    // Script Loading
    // ========================================================================

    /**
     * Load and execute a JavaScript file
     * @param path Path to the JavaScript file
     * @return true on success
     */
    virtual bool loadScript(const std::string& path) = 0;

    /**
     * Evaluate JavaScript code directly
     * @param code JavaScript code to evaluate
     * @param filename Virtual filename for error messages
     * @return true on success
     */
    virtual bool evalScript(const std::string& code, const std::string& filename = "<eval>") = 0;

    /**
     * Reload the currently loaded script (for hot reload)
     * Clears timers and requestAnimationFrame callbacks, then re-evaluates the script.
     * @return true on success
     */
    virtual bool reloadScript() = 0;

    // ========================================================================
    // Main Loop
    // ========================================================================

    /**
     * Run the main loop (blocking)
     * Processes events and calls requestAnimationFrame callbacks until quit
     */
    virtual void run() = 0;

    /**
     * Process a single frame (non-blocking)
     * @return false if the runtime should quit
     */
    virtual bool pollEvents() = 0;

    /**
     * Request the runtime to quit
     */
    virtual void quit() = 0;

    /**
     * Get the exit code set by process.exit()
     * @return Exit code (0 by default, or value passed to process.exit())
     */
    virtual int getExitCode() const = 0;

    // ========================================================================
    // Window Management
    // ========================================================================

    /**
     * Resize the window
     */
    virtual void resize(int width, int height) = 0;

    /**
     * Set fullscreen mode
     */
    virtual void setFullscreen(bool fullscreen) = 0;

    /**
     * Get current window width
     */
    virtual int getWidth() const = 0;

    /**
     * Get current window height
     */
    virtual int getHeight() const = 0;

    // ========================================================================
    // Access to Internals (for advanced use)
    // ========================================================================

    /**
     * Get the underlying JS context (type depends on engine)
     * - QuickJS: JSContext*
     * - V8: v8::Isolate*
     * - JSC: JSGlobalContextRef
     */
    virtual void* getJSContext() = 0;

    /**
     * Get the WebGPU device (WGPUDevice)
     */
    virtual void* getWGPUDevice() = 0;

    /**
     * Get the WebGPU queue (WGPUQueue)
     */
    virtual void* getWGPUQueue() = 0;

    /**
     * Get the WebGPU instance (WGPUInstance)
     */
    virtual void* getWGPUInstance() = 0;

    /**
     * Get the current render texture (WGPUTexture)
     * For async video capture - returns the texture being rendered to
     */
    virtual void* getCurrentTexture() = 0;

    /**
     * Get the SDL window (SDL_Window*)
     */
    virtual void* getSDLWindow() = 0;

    // ========================================================================
    // Screenshot
    // ========================================================================

    /**
     * Capture a screenshot of the current window
     * @param filename Path to save the screenshot (PNG format)
     * @return true on success
     */
    virtual bool saveScreenshot(const std::string& filename) = 0;

    /**
     * Join native pipeline workers and emit the bounded capture completion marker without
     * tearing down the rest of the host. Screenshot mode uses this before its platform-safe
     * immediate exit path.
     */
    virtual void finalizePipelineCapture() = 0;

    /**
     * Ask for the next presented frame to be captured into the screenshot buffer. Frames nobody
     * requested skip the framebuffer copy and its completion wait entirely, so callers must
     * raise this before waiting on saveScreenshot/captureFrame.
     */
    virtual void requestFrameScreenshot() = 0;

    /**
     * Capture the current frame as RGBA pixel data (for video recording)
     * @param outData Output vector to receive RGBA data (width * height * 4 bytes)
     * @param outWidth Output parameter for frame width
     * @param outHeight Output parameter for frame height
     * @return true on success
     */
    virtual bool captureFrame(std::vector<uint8_t>& outData, uint32_t& outWidth, uint32_t& outHeight) = 0;

    /**
     * Return the number of frames presented by this runtime's WebGPU binding state.
     */
    virtual uint64_t getPresentCount() const = 0;

    /**
     * True once the game's startup gate has resolved and the world is on screen.
     *
     * A frame count cannot express this. `StartupReadiness` resolves on five consecutive in-budget
     * frames or, for a host that never produces one — every software rasteriser — only after its
     * bounded window expires. A fast `--frames` run therefore finishes while the loading state is
     * still up, and the capture holds a world that was never shown.
     */
    virtual bool isStartupReady() const = 0;

    /**
     * True once a rendered frame is sitting in the capture buffer.
     *
     * `saveScreenshot` refuses without one, and a run whose requested frames all elapsed while the
     * world was still loading has none — the lane sees `TN_NATIVE_STARTER_EXIT_1` and a runtime that
     * printed no frame count at all.
     */
    virtual bool hasCapturedFrame() const = 0;

    /**
     * Drop whatever frame sits in the capture buffer, so the next request captures fresh.
     *
     * A frame captured before the startup gate opened is the loading state, not the world. A
     * screenshot run that wants the world therefore clears after readiness and captures again
     * rather than saving whatever the buffer already held.
     */
    virtual void clearCapturedFrame() = 0;

    virtual void* getWebGPUBindingsState() const = 0;

protected:
    Runtime() = default;
};

// Version info - uses CMake-defined MYSTRAL_VERSION
#ifndef MYSTRAL_VERSION
#define MYSTRAL_VERSION "0.1.13"
#endif

inline const char* getVersion() {
    return MYSTRAL_VERSION;
}

// Build configuration - uses CMake-defined values
#ifndef MYSTRAL_JS_ENGINE
#define MYSTRAL_JS_ENGINE "quickjs"
#endif

#ifndef MYSTRAL_WEBGPU_BACKEND
#define MYSTRAL_WEBGPU_BACKEND "wgpu-native"
#endif

inline const char* getJSEngine() {
    return MYSTRAL_JS_ENGINE;
}

inline const char* getWebGPUBackend() {
    return MYSTRAL_WEBGPU_BACKEND;
}

}  // namespace mystral
