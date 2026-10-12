/**
 * The UI overlay seam — the native half of the message bridge in `@threenative/core/ui-layer`.
 *
 * The UI runs in the platform's own browser-class renderer, composited over the game surface;
 * the game runs in this runtime beside it. Two realms, usually two processes, so everything
 * that crosses is one JSON string.
 *
 * Threading is the whole reason this file exists. The host delivers a page message on the
 * platform's UI thread (Android's main thread, not SDL's), while JavaScript may only be
 * touched from the thread that owns the engine. So inbound frames are queued here and drained
 * once per frame by the runtime, exactly like the lifecycle markers beside them.
 */
#pragma once

#include <cstdint>
#include <string>
#include <vector>

struct SDL_Window;

namespace mystral {
namespace platform {

/**
 * Queue one frame the UI layer sent. Thread-safe; called from the platform's UI thread.
 *
 * The queue is bounded: a UI that posts faster than the game drains must lose its oldest
 * frames rather than grow without limit, and the drop is counted so a run can report it
 * instead of presenting as mysterious latency.
 */
void queueUiMessage(std::string frame);

/** Pop the oldest queued frame. Returns false when the queue is empty. */
bool takeUiMessage(std::string& frame);

/** How many inbound frames have been dropped for queue pressure across this run. */
uint64_t droppedUiMessages();

/** Whether the UI layer has sent its first-render `tn:ready` intent. */
bool uiReadyIntentReceived();

/**
 * Send one frame to the UI layer. Returns false when no overlay is attached, which is the
 * normal state for a game whose UI renderer is `native` and on any platform with no overlay
 * implementation yet.
 */
bool postUiMessage(const std::string& frame);

/** Whether an overlay attached itself on this run. Reported, never assumed. */
bool uiOverlayAttached();

/** Called by the platform host once its overlay is up, or has failed to come up. */
void setUiOverlayAttached(bool attached);

/**
 * Bring up the desktop overlay over the game window, serving the built UI from `uiRoot`.
 *
 * The page is served over a custom protocol rather than `file://`, which is the desktop
 * counterpart of Android's `WebViewAssetLoader`: a real origin, so `fetch`, module imports and
 * same-origin rules behave as they do on the web build.
 *
 * Android and iOS attach from their own hosts, in Java and Swift, before the runtime starts; only
 * desktop attaches from here, because only here does the runtime own the window. Returns false and
 * logs a named reason when it cannot — no compositor, no GTK, no container — rather than leaving a
 * game that asked for the web renderer with an opaque rectangle over its scene.
 */
bool attachDesktopUiOverlay(const std::string& uiRoot);

/**
 * The game window a desktop overlay attaches to and measures: the legacy host's window module and
 * the native-engine player (PRD-554) each name their own, so this seam links without either.
 */
void setUiOverlayWindow(SDL_Window* window);
/** Releases the keys the UI owns when an overlay detaches; the host that routes keys installs it. */
void setUiOverlayKeyboardReset(void (*reset)());
/** Applies a page's `tn:hit-regions` frame (true), or returns false for any other frame. */
bool applyUiHitRegionsFrame(const std::string& frame);

/**
 * Bring up the CSS UI backend over the game window, serving the built UI from `uiRoot`.
 *
 * The other backend, and the only one with no browser in it: the same `src/ui/` tree is laid out
 * and rasterised on the CPU by the `native/css-ui` crate, and its premultiplied RGBA8 frames reach
 * the compositor through the seam below exactly as the web view's reach it. Selected by
 * `ui.renderer: "native-css"` rather than by the overlay being present, because a Linux session
 * with no WebKitGTK must still be able to have a HUD.
 *
 * Returns false and names the reason when the document could not be created. A game that asked for
 * this renderer must never get no UI in silence: the two look identical from a screenshot and only
 * one of them is a bug. Sets the same `uiOverlayAttached()` the web path does, so the composite,
 * the pointer route and the ready gate read one flag whichever backend is up.
 *
 * Compiled in by `TN_ENABLE_CSS_UI`; a build without it refuses rather than pretending.
 */
bool attachDesktopCssUi(const std::string& uiRoot);

/** Give the desktop overlay its slice of the frame. A no-op where nothing is attached. */
void pumpUiOverlay();

/**
 * One completed UI frame, as the renderer needs it.
 *
 * `pixels` is valid until the next call to `uiOverlayFrame`, and it is the web view's own buffer —
 * nothing is copied on this side. `stride` is bytes per row and is not necessarily `width * 4`.
 * The bytes are premultiplied `B,G,R,A`, which is cairo's `ARGB32` on a little-endian host.
 */
struct UiOverlayFrame {
    const uint8_t* pixels = nullptr;
    size_t length = 0;
    uint32_t width = 0;
    uint32_t height = 0;
    uint32_t stride = 0;
    /// Advances only when the page's pixels changed, so an unchanged frame needs no upload.
    uint64_t counter = 0;
    /**
     * True when the bytes are `R,G,B,A` rather than the desktop's `B,G,R,A`.
     *
     * Android's `ImageReader` hands back `RGBA_8888`; cairo's `ARGB32` on a little-endian host is
     * already `BGRA8Unorm`. The compositor picks its texture format from this rather than guessing,
     * because a wrong pick renders the page with red and blue swapped.
     *
     * The CSS UI backend always sets it: premultiplied `RGBA8` is what its CPU rasteriser produces,
     * on every platform.
     */
    bool isRgba = false;
};

/**
 * The newest completed UI frame. Returns false until the page has painted once, and false on
 * Windows and macOS, whose web views draw themselves and never pass through here.
 *
 * Android returns the in-frame producer's latest frame when `TN_UI_INFRAME` selected that path;
 * with the flag off its child WebView still draws itself and this returns false, the pre-existing
 * behavior.
 *
 * Call once per frame, before drawing the UI quad: the pointer it hands back belongs to the frame
 * it was asked about.
 */
bool uiOverlayFrame(UiOverlayFrame& frame);

/** How many frames the web view has published. Monotonic; reported in the composite marker. */
uint64_t uiOverlayFramesPublished();

/**
 * Tell the offscreen UI how many pixels the game window has now, so the page re-lays out.
 *
 * The web view has no window of its own to follow, so without this it keeps the viewport it was
 * attached at and the composite stretches that layout across the swapchain. A no-op where nothing is
 * attached and on every platform whose web view is a real window the OS resizes for it.
 */
void uiOverlaySetSize(int width, int height);

/** Publish the interactive rectangles, normalized to the viewport, as x, y, width, height. */
void setUiHitRegions(const std::vector<float>& regions);

/**
 * Whether a normalized point is inside a published interactive rectangle.
 *
 * The playtest input bridge asks this before dispatching a synthetic pointer, and so does the
 * runtime before it forwards a real OS press, so both routes are decided by one list. False when
 * nothing is attached.
 */
bool uiOverlayHitTest(float nx, float ny);

/** How many interactive rectangles the page last published, for the OS press verdict line. */
size_t uiOverlayHitRegionCount();

/**
 * Dispatch one synthetic pointer event into the page, at a point normalized to the viewport.
 *
 * `type` is a DOM pointer event type (`pointerdown`, `pointermove`, `pointerup`). Returns false
 * when nothing is attached. Used by the playtest input bridge and, on Linux, by the runtime's own
 * forwarding of OS pointer input: with no overlay window there is nothing for the OS to route a
 * press into, so every press the player makes arrives here or goes to the game.
 */
bool uiOverlayInjectPointer(const char* type, float nx, float ny, int buttons, int pointerId);

/** Forward an X11 key event to WebKit's native input handling. Linux only. */
bool uiOverlayInjectKey(uint32_t keycode, uint32_t modifiers, uint32_t group,
                        uint32_t time, bool down);

/**
 * Whether the page holds the keyboard, so the host knows where a key belongs.
 *
 * True while the page has a focused input, textarea, select or open list, and — for the CSS backend —
 * while a control in the document has focus, which is the same question asked of a document with no
 * text editing behind it. A published rectangle says where a press landed and says nothing about who
 * should receive `ArrowUp`, so the page's own focus is the only honest authority; without this the host
 * could only guess, and guessing wrong either swallows a game's keys or leaves a focused control deaf.
 * False when nothing is attached and on every platform whose web view is a real window and gets keys
 * from the OS itself.
 */
bool uiOverlayKeyboardCaptured();

/**
 * Deliver one key press or release to the UI, and report whether it consumed it. Returns true when
 * the UI owns the key and the game must not also act on it.
 *
 * `key` is a `KeyboardEvent.key` value. Only the CSS backend answers here: its document is CPU-side
 * with no OS key window to be handed a key, so the host asks it directly and drops what it consumed —
 * which is a Tab that moved focus, an Enter or the space key on a focused control, and an Escape while
 * the UI holds focus. Every other key, and every key at all when the document has nothing focusable,
 * stays with the game, because a UI that swallowed keys it did not use is worse than one that ignored
 * them. The web overlay reads real keys through the platform's own filter and is not routed here.
 */
bool uiOverlayRouteKey(const char* key, bool down, bool shift);

/**
 * Deliver one wheel scroll to the UI, and report whether it consumed it: `true` when a scroller under
 * the point took the delta, in CSS pixels, at a position normalized to the viewport. A false return
 * leaves the scroll for the game, which is what keeps a wheel over a list from also zooming the camera.
 *
 * The CSS backend answers this; the web overlay's page scrolls itself and the host never routes one.
 */
bool uiOverlayRouteWheel(float nx, float ny, float dx, float dy);

/**
 * Tell the UI whether the pointer driving it is a finger or a mouse.
 *
 * One pointer for the whole document: a finger does not hover, so the UI reports `(hover: none)` and
 * `(pointer: coarse)` and a tap leaves no hover behind — which is what makes a `hover:` rule guarded
 * by `@media (hover:hover)` disappear on a touchscreen. A host with both a mouse and a touchscreen
 * declares which one the game is being driven by as its events arrive. A no-op on the web overlay,
 * which is a real browser window with its own media queries.
 */
void uiOverlaySetPointerKind(bool touch);

/** The modifier keys a synthetic key sequence is holding, as the DOM names them. */
struct UiKeyModifiers {
    bool shift = false;
    bool ctrl = false;
    bool alt = false;
    bool meta = false;
};

/**
 * Track a synthetic modifier: true when `key` is `Shift`, `Control`, `Alt` or `Meta`, which then
 * sets or clears that flag in `mods`. A playtest presses a chord as a held set (`["Shift","Tab"]`),
 * so the host has to remember the modifier the way SDL's mod state does for a real keyboard.
 */
bool uiOverlayTrackModifier(const std::string& key, bool down, UiKeyModifiers& mods);

/**
 * Override `prefers-color-scheme` and `prefers-reduced-motion` for the CSS document: 1 sets, 0
 * clears, -1 keeps. The host reads the colour scheme from the OS once at attach; this is the
 * playtest's channel to state a different environment. False when no CSS backend is attached.
 */
bool uiOverlaySetEnvironment(int dark, int reducedMotion);

/**
 * Advance the CSS animation clock by `ticks` fixed steps. Only with `TN_CSS_UI_FIXED_STEP_MS=<ms>`
 * set at attach, which makes the clock move here and nowhere else, so a mid-transition frame is
 * reproducible by tick count. False (and nothing moves) when the clock is real time, the default.
 */
bool uiOverlayAdvanceClock(int ticks);

/**
 * Decide which side a pointer event belongs to, and remember that answer for the rest of the
 * gesture. Returns true when the page owns the event and the game must not see it.
 *
 * One authority for both callers, because they must not be able to disagree: a real pointer event
 * arrives from the OS on Linux, and a synthetic one arrives from the playtest bridge, and both are
 * routed by the same published rectangles.
 *
 * `type` is a DOM pointer event type. `nx`/`ny` are normalized to the viewport; on a release they
 * are ignored, because a gesture is completed by the control that received its press and not by
 * wherever the pointer happened to be when it let go — a real system delivers the release to the
 * same target, and a synthetic release that carries no position at all must not be dropped for
 * failing a hit test it was never meant to face.
 *
 * The gesture latch is what makes a drag behave. A press inside a UI island keeps going to the page
 * even when the pointer leaves the island, or a drag out of a button becomes a game input halfway
 * through; a press on the game keeps going to the game, or a camera drag that crosses a HUD button
 * is stolen mid-move — the single most common way an overlay like this feels broken.
 */
bool uiOverlayRoutePointer(const char* type, float nx, float ny, int buttons, int pointerId);

/** Tear the desktop overlay down. Safe when nothing is attached. */
void detachDesktopUiOverlay();

#if defined(__APPLE__)
/**
 * The iOS overlay, in `ios/ui_overlay_ios.mm`.
 *
 * **UNPROVEN WebUI execution.** Native-only simulator smoke does not qualify the overlay;
 * the packaged React pixel proof and device input/presentation checks remain separate gates.
 */
bool attachIosUiOverlay(const std::string& uiRoot);
void detachIosUiOverlay();
bool postIosUiMessage(const std::string& frame);
#endif

}  // namespace platform
}  // namespace mystral
