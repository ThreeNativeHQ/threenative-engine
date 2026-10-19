#pragma once

// Forward declare SDL types
struct SDL_Window;

namespace mystral {
namespace platform {

/**
 * Initialize SDL and create window. A packaged .threenative/app-icon.png is applied to the live
 * SDL window after creation; raw executables report the compositor fallback when it is unavailable.
 */
bool createWindow(
    const char* title,
    int width,
    int height,
    bool fullscreen,
    bool resizable,
    bool maximized = false
);

/**
 * Destroy window and cleanup SDL
 */
void destroyWindow();

/** Release keys owned by the desktop UI before it loses focus or detaches. */
void resetUiOverlayKeyboard();

/**
 * Poll SDL events
 * @return false if quit event received
 */
bool pollEvents();

/**
 * Check if window should quit
 */
bool shouldQuit();

/**
 * Get native SDL window handle
 */
SDL_Window* getSDLWindow();

/**
 * Physical pixels per logical (CSS) pixel for the live window.
 *
 * The number `window.devicePixelRatio` is supposed to carry, and the reason it may not be
 * invented: the runtime reported a hardcoded `1.0` while handing three.js the *physical* surface
 * as though those were CSS pixels, so on a Pixel 8 a layout written against a 2400-pixel-wide
 * "CSS pixel" canvas rendered at a third of its intended size.
 *
 * Returns 1.0 when there is no window — a headless run has no display to have a density of.
 */
float displayPixelDensity();

/**
 * Get Metal view (macOS/iOS only)
 */
void* getMetalView();

/**
 * Get Metal layer from view (macOS/iOS only)
 * Note: Use getMetalLayerFromView() for WebGPU surface creation
 */
void* getMetalLayer();

/**
 * Get CAMetalLayer from SDL Metal view (macOS/iOS only)
 * This is what WebGPU needs for surface creation
 */
void* getMetalLayerFromView(void* metalView);

/**
 * Get drawable size of Metal layer (accounts for Retina)
 */
void getMetalLayerDrawableSize(void* metalLayer, int* width, int* height);

/**
 * Set drawable size of Metal layer
 */
void setMetalLayerDrawableSize(void* metalLayer, int width, int height);

/**
 * Get window dimensions
 */
void getWindowSize(int* width, int* height);

// Actual drawable pixels, independent of the canvas/input-coordinate cache. Android uses
// the native handle owned by the live WebGPU surface, not a replacement SDL window.
// Called on the SDL/main thread. False means no valid drawable is currently available.
bool getWindowDrawableSize(void* surfaceNativeHandle, int* width, int* height);

/**
 * Set fullscreen mode
 */
void setFullscreen(bool fullscreen);

/**
 * Resize window
 */
void setWindowSize(int width, int height);

/**
 * Record a size the platform already applied, without asking SDL to resize again.
 *
 * getWindowSize() is what scales SDL's normalized touch coordinates back into canvas pixels,
 * so a surface change that reaches the runtime without going through setWindowSize() would
 * otherwise leave pointers scaled by a stale size.
 */
void syncWindowSize(int width, int height);

/**
 * Set window title
 */
void setWindowTitle(const char* title);

}  // namespace platform
}  // namespace mystral
