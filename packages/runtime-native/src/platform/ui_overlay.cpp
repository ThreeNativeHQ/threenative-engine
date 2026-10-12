#include "mystral/platform/ui_overlay.h"

#include "mystral/cold_start.h"

#include <atomic>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <charconv>
#include <deque>
#include <iostream>
#include <limits>
#include <memory>
#include <mutex>
#include <sstream>
#include <string_view>

#include <cstdio>

#if defined(__APPLE__)
#include <TargetConditionals.h>
#endif

#if TN_ENABLE_UI_OVERLAY
extern "C" {
int tn_ui_overlay_attach(unsigned long parent, const char* url, uint32_t width, uint32_t height);
int tn_ui_overlay_post(const char* frame);
char* tn_ui_overlay_take();
void tn_ui_overlay_free(char* frame);
int tn_ui_overlay_set_bounds(int32_t x, int32_t y, uint32_t width, uint32_t height);
int tn_ui_overlay_set_hit_regions(const float* regions, uint32_t count);
int tn_ui_overlay_hit_test(float nx, float ny);
int tn_ui_overlay_inject_pointer(const char* type, float nx, float ny, int buttons,
                                 int pointer_id);
#if defined(__linux__) && !defined(__ANDROID__)
int tn_ui_overlay_inject_key(uint32_t keycode, uint32_t modifiers, uint32_t group,
                             uint32_t time, int down);
int tn_ui_overlay_keyboard_captured();
#endif
void tn_ui_overlay_detach();
#if defined(_WIN32) || defined(__APPLE__)
int tn_ui_overlay_pump();
#endif
}

#if defined(__linux__) && !defined(__ANDROID__)
/**
 * The frame mailbox, on the Linux backend only.
 *
 * Windows and macOS composite a child web view themselves and have no frame to hand over, so the
 * declarations and the implementations below are gated rather than stubbed: a stub returning a
 * frame would be a lie the compositor could act on.
 */
extern "C" {
struct TnUiFrameLayout {
    const uint8_t* pixels;
    size_t length;
    uint32_t width;
    uint32_t height;
    uint32_t stride;
    uint64_t counter;
};
int tn_ui_overlay_frame(TnUiFrameLayout* out);
uint64_t tn_ui_overlay_frames_published();
}
#endif
#include "mystral/platform/window.h"
#include <SDL3/SDL.h>
#endif

#if TN_ENABLE_CSS_UI
/**
 * The CSS UI backend's C ABI: the game's UI laid out and rasterised on the CPU.
 *
 * Declared rather than included, because the crate is a Rust staticlib that ships no header — the
 * same arrangement as the overlay above, and the same discipline: every entry point is
 * `catch_unwind`-wrapped on the other side, so a failure here is a code plus a message from
 * `tn_css_ui_last_error`, never an unwind across the FFI boundary.
 *
 * Gated separately from `TN_ENABLE_UI_OVERLAY` on purpose. This path has no WebView, no GTK and no
 * webkit2gtk anywhere, so a build that wants a HUD and no browser links only this.
 */
#include "mystral/platform/window.h"
#include <SDL3/SDL.h>
extern "C" {
struct TnCssFrame {
    const uint8_t* pixels;
    size_t length;
    uint32_t width;
    uint32_t height;
    uint32_t stride;
    uint64_t counter;
};
int tn_css_ui_attach(const char* ui_root, uint32_t width, uint32_t height);
int tn_css_ui_post(const char* json);
const char* tn_css_ui_last_error();
char* tn_css_ui_take();
void tn_css_ui_free(char* text);
int tn_css_ui_frame(TnCssFrame* out);
int tn_css_ui_set_size(uint32_t width, uint32_t height);
int tn_css_ui_pointer(const char* type, float nx, float ny, int buttons);
int tn_css_ui_hit_test(float nx, float ny);
int tn_css_ui_key(const char* key, int down, int shift);
int tn_css_ui_wheel(float nx, float ny, float dx, float dy);
int tn_css_ui_set_time(double ms);
int tn_css_ui_set_env(int dark, int reduced_motion);
int tn_css_ui_set_pointer_kind(int touch);
int tn_css_ui_focused_id();
int tn_css_ui_scroll_offset(uint32_t id, double* x, double* y);
size_t tn_css_ui_scrolled_ids(uint32_t* out, size_t capacity);
void tn_css_ui_detach();
const char* tn_css_ui_backend();
}
#endif

#if defined(__ANDROID__)
#include <SDL3/SDL.h>
#include <SDL3/SDL_system.h>
#include <android/log.h>
#include <jni.h>
#endif

namespace mystral {
namespace platform {
namespace {

std::mutex g_mutex;
std::deque<std::string> g_inbound;
std::atomic<uint64_t> g_dropped{0};
std::atomic<bool> g_attached{false};
std::atomic<bool> g_uiReadyIntentReceived{false};
// The window a desktop overlay attaches to and measures (setUiOverlayWindow); null before one exists.
SDL_Window* g_uiWindow = nullptr;
void (*g_resetKeyboard)() = nullptr;

/** How many interactive rectangles the page last published, for the OS press verdict line. */
std::atomic<size_t> g_hitRegionCount{0};

/**
 * A HUD publishes its rectangles on layout change and its intents on a tap, so a healthy run
 * queues single-digit frames per tick. A backlog past this means the game stopped draining —
 * paused, or wedged — and the newest frames are the ones worth keeping.
 */
constexpr size_t kMaxQueuedUiMessages = 256;

/**
 * How many rejected CSS batches are named on stderr before the rest are counted only.
 *
 * A rejected batch applies none of its ops, so a game whose markup names one unsupported tag
 * posts the same failure every frame. One line says why; twenty thousand lines bury the run's
 * real output.
 */
constexpr unsigned kMaxCssPostRejections = 20;

#if defined(__ANDROID__)
/**
 * The latest page frame, published by the in-frame producer in `TnUiOverlay`.
 *
 * Android's default lane is wgpu-native, which has no external-texture import, so the producer's
 * buffer is read back to CPU pixels here and uploaded by the existing compose path
 * (`compositeUiOverlayToWebGPU` -> `uploadUiFrame`). Latest-wins: a frame that arrives while the
 * game is not looking replaces the one before it, so the composite never shows a stale page.
 *
 * A `shared_ptr` rather than a plain vector because the compositor holds the pointer across the
 * upload while the UI thread may publish the next frame. `uiOverlayFrame` retains the current
 * buffer until the following call, so a publish can never free a buffer mid-read.
 */
std::mutex g_androidFrameMutex;
std::shared_ptr<const std::vector<uint8_t>> g_androidFrame;
std::shared_ptr<const std::vector<uint8_t>> g_androidFrameRetained;
uint32_t g_androidFrameWidth = 0;
uint32_t g_androidFrameHeight = 0;
uint32_t g_androidFrameStride = 0;
uint64_t g_androidFrameCounter = 0;
std::atomic<uint64_t> g_androidFramesPublished{0};
std::atomic<bool> g_androidFrameRgba{false};
#endif

bool isUiReadyIntent(const std::string& frame) {
    // UI_READY_INTENT is sent through sendUiIntent, whose JSON.stringify wire shape is canonical.
    // The UI layer includes its published hit-region count as the payload. Match that complete
    // shape so nested or user-supplied fields cannot impersonate readiness.
    constexpr std::string_view prefix = R"({"type":"tn:intent","intent":"tn:ready","payload":)";
    if (frame == R"({"type":"tn:intent","intent":"tn:ready"})") return true;
    if (frame.size() <= prefix.size() + 1 || frame.back() != '}' ||
        frame.compare(0, prefix.size(), prefix) != 0) return false;
    const char* first = frame.data() + prefix.size();
    const char* last = frame.data() + frame.size() - 1;
    uint32_t regions = 0;
    const auto parsed = std::from_chars(first, last, regions);
    return first != last && parsed.ec == std::errc{} && parsed.ptr == last &&
           std::to_string(regions) == std::string(first, last);
}

/**
 * Which overlay backend this run brought up: the CSS UI's CPU rasteriser, or the web view.
 *
 * One file-local selector rather than a second overlay object, because every public function below
 * already has one seam to route through (`uiOverlayAttached()` plus the web ABI) and a backend
 * choice is a boolean, not an interface: there are exactly two, they answer the same nine calls,
 * and a third would be speculative. Set once, by `attachDesktopCssUi`, before the frame loop runs.
 */
bool g_cssBackend = false;

#if TN_ENABLE_CSS_UI

/** The last frame counter handed out, and how many distinct frames it has advanced through. */
uint64_t g_cssCounter = 0;
uint64_t g_cssFramesPublished = 0;

/** The frame counter at the first accepted post, and whether there has been one yet. */
bool g_cssReadyArmed = false;
uint64_t g_cssPostCounter = 0;

/** Why an entry point failed, in the words a reader can act on. The crate's own code table. */
const char* cssFailure(int code) {
    switch (code) {
        case -1: return "wrong state: already attached, or not attached";
        case -2: return "internal failure inside the CSS UI";
        case -5: return "invalid argument";
        case -6: return "the mutation batch was rejected";
        case -7: return "the ui root exists but holds no .css stylesheet";
        default: return "invalid argument";
    }
}

/** Whatever the ABI last recorded, or an empty string. Valid until the next call into the crate. */
std::string cssLastError() {
    const char* text = tn_css_ui_last_error();
    return text == nullptr ? std::string() : std::string(text);
}

/**
 * Hand the UI's outbound events to the game's message queue, one entry per queued message.
 *
 * Split rather than forwarded whole: `tn_css_ui_take` returns the whole drain newline separated,
 * and `__tnUiGameReceive` is the game's per-event callback — a batched string would hand it N
 * events inside one call and every consumer would have to re-split it.
 */
void cssTakeEventsIntoQueue() {
    char* text = tn_css_ui_take();
    if (text == nullptr) return;
    const std::string_view lines(text);
    size_t start = 0;
    while (start < lines.size()) {
        const size_t end = lines.find('\n', start);
        const size_t stop = end == std::string_view::npos ? lines.size() : end;
        if (stop > start) queueUiMessage(std::string(lines.substr(start, stop - start)));
        start = stop + 1;
    }
    tn_css_ui_free(text);
}

/**
 * The document's focus and scroll offsets, one line per composite that changed either of them.
 *
 * Off unless `TN_CSS_UI_STATE_TRACE` is set. Two facts a screenshot cannot carry live here: which
 * element holds focus when nothing about it looks different (a pointer focus is not a
 * `:focus-visible` one, so a clicked button paints exactly what an unfocused one does), and where
 * a scroller has moved to (the pixels moved; the offset did not stay 0). Both are what
 * `tn_css_ui_focused_id` and `tn_css_ui_scroll_offset` already answer, and this is those answers
 * written where a run's captured log keeps them — the same arrangement `TN_UI_COMPOSITE_TRACE` and
 * `TN_UI_LATENCY_TRACE` have for the frame and the post.
 *
 * A line only when the state differs from the last one, because a transition keeps every composite
 * a candidate and the runs that read these lines care about when they changed. The element ids are
 * the ids the game created its UI with, which are the ids the corpus numbers its elements by, so a
 * reader pairs an offset with the element it asked about without a second mapping.
 */
void traceCssState() {
    static const bool enabled = std::getenv("TN_CSS_UI_STATE_TRACE") != nullptr;
    if (!enabled) return;
    // The scrolled ids first: a document holds thousands of elements and a handful of scrollers, so
    // the crate answers which of them moved instead of the host sweeping every id it has seen.
    // How many moved, then the list itself: a null buffer is a count-only query.
    const size_t count = tn_css_ui_scrolled_ids(nullptr, 0);
    std::vector<uint32_t> ids(count);
    if (count > 0) tn_css_ui_scrolled_ids(ids.data(), count);
    std::ostringstream line;
    line.precision(std::numeric_limits<double>::max_digits10);
    line << "TN_CSS_UI_STATE focused=" << tn_css_ui_focused_id();
    bool first = true;
    for (size_t i = 0; i < count; i += 1) {
        double x = 0.0;
        double y = 0.0;
        if (tn_css_ui_scroll_offset(ids[i], &x, &y) != 1) continue;
        if (x == 0.0 && y == 0.0) continue;
        line << (first ? " " : ";") << "scroll=" << ids[i] << ':' << x << ',' << y;
        first = false;
    }
    static std::string last;
    const std::string state = line.str();
    if (state == last) return;
    last = state;
    std::cout << state << std::endl;
}

/**
 * The UI's newest frame, or false until it has painted once.
 *
 * `pixels` is the crate's own premultiplied RGBA8 raster, valid until the next call, and reported
 * as `isRgba` because that is literally what it is — no cairo `ARGB32` byte order to reinterpret.
 * The counter advances only when the document repainted, so the composite's unchanged-frame skip
 * works exactly as it does for the web view.
 */
bool cssTakeFrame(UiOverlayFrame& frame) {
    TnCssFrame layout{};
    if (tn_css_ui_frame(&layout) != 1) return false;
    // Every composite, not only a republished frame: focus that matches no `:focus-visible` rule
    // changes nothing to look at and repaints nothing, and that is exactly the state a reader here
    // cannot see any other way.
    traceCssState();
    frame.pixels = layout.pixels;
    frame.length = layout.length;
    frame.width = layout.width;
    frame.height = layout.height;
    frame.stride = layout.stride;
    frame.counter = layout.counter;
    frame.isRgba = true;
    if (layout.counter != g_cssCounter) {
        g_cssCounter = layout.counter;
        g_cssFramesPublished += 1;
        // The CSS UI has no page and so no `tn:ready` intent to wait for, but the CLI still has a
        // 15-second deadline on readiness, so something has to open it. The first painted frame
        // cannot: that is the empty document, painted before the game has posted anything, and
        // calling it readiness is what made a HUD whose every batch was rejected look alive. The
        // first repaint *after* an accepted post is the same fact the web view's `tn:ready` intent
        // states, learned from this side: the game's own markup is on the screen.
        if (g_cssReadyArmed && layout.counter > g_cssPostCounter) {
            g_uiReadyIntentReceived.store(true, std::memory_order_release);
        }
    }
    return frame.pixels != nullptr && frame.length > 0;
}

/** Tell the document how big the surface it is painted onto now is, in CSS pixels. */
void cssSetSize(int width, int height) {
    tn_css_ui_set_size(static_cast<uint32_t>(width), static_cast<uint32_t>(height));
}

/**
 * Deliver one pointer action.
 *
 * DOM event names in, the crate's `move`/`down`/`up`/`leave` out. A point outside the viewport is
 * `leave`: the host forwards `-1,-1` when the pointer leaves the game window precisely to clear the
 * hover the UI is showing, and `leave` is the only action that means "not over anything".
 *
 * Returns whether the action was delivered, not whether the UI consumed it — the caller asks that
 * separately through `uiOverlayHitTest`, and the gesture latch is what owns a drag.
 */
bool cssInjectPointer(const char* type, float nx, float ny, int buttons) {
    const std::string_view name = type == nullptr ? std::string_view() : std::string_view(type);
    const char* kind = "move";
    if (name == "pointerdown") kind = "down";
    else if (name == "pointerup") kind = "up";
    else if (name == "pointercancel" || nx < 0.0f || ny < 0.0f) kind = "leave";
    return tn_css_ui_pointer(kind, nx, ny, buttons) >= 0;
}

/**
 * Deliver one key, and report whether the UI consumed it.
 *
 * The same three answers the document has for every key, and the host needs no more: the UI moved
 * focus, the UI activated something, or the key was none of its business and belongs to the game.
 * A negative code is an error, which is not consumption: a failed call leaves the key with the game
 * rather than swallowing it, because a lost key reads as a HUD that ignored the player.
 */
bool cssRouteKey(const char* key, bool down, bool shift) {
    return tn_css_ui_key(key, down ? 1 : 0, shift ? 1 : 0) == 1;
}

/** Deliver a wheel scroll, and report whether a scroller took it. */
bool cssRouteWheel(float nx, float ny, float dx, float dy) {
    return tn_css_ui_wheel(nx, ny, dx, dy) == 1;
}

/** The moment the document was attached, so the clock below counts from there. */
std::chrono::steady_clock::time_point g_cssAttachedAt{};

/**
 * The opt-in test clock: `TN_CSS_UI_FIXED_STEP_MS` milliseconds per playtest tick, or 0 for real time.
 * When set, `uiOverlayAdvanceClock` is the only thing that moves the clock, so a frame sampled N ticks
 * after a hover shows exactly N*step of its transition however long the run took to get there.
 */
double g_cssFixedStepMs = 0.0;
double g_cssFixedClockMs = 0.0;

/** The environment the document is styled for, kept so one override can leave the other alone. */
int g_cssDark = 0;
int g_cssReducedMotion = 0;

/**
 * The CSS document's slice of a frame: the animation clock, then the events that frame queued.
 *
 * The clock is real time rather than a frame count because that is what a CSS duration resolves
 * against — a transition moves on every frame it is alive and arrives when the wall clock says so,
 * not after N of them. It is fed here rather than in `tn_css_ui_frame` because the document only
 * resolves against it when the host asks for a frame, and this runs once per pump on either side of
 * the `TN_ENABLE_UI_OVERLAY` split. The fixed test clock is the one exception, and it is opt-in.
 */
void cssPump() {
    const auto elapsed = std::chrono::steady_clock::now() - g_cssAttachedAt;
    tn_css_ui_set_time(g_cssFixedStepMs > 0.0
                           ? g_cssFixedClockMs
                           : std::chrono::duration<double, std::milli>(elapsed).count());
    cssTakeEventsIntoQueue();
}

#endif  // TN_ENABLE_CSS_UI

}  // namespace

void setUiOverlayWindow(SDL_Window* window) { g_uiWindow = window; }
void setUiOverlayKeyboardReset(void (*reset)()) { g_resetKeyboard = reset; }

/**
 * Applies a `tn:hit-regions` frame the page published, or reports that it was not one (moved from the
 * legacy host so the native-engine player applies them the same way, PRD-554). Fail closed: a
 * malformed publication keeps the previous rectangles, and the TN_UI_HIT_REGIONS line names them.
 */
bool applyUiHitRegionsFrame(const std::string& frame) {
    if (frame.find("\"tn:hit-regions\"") == std::string::npos) return false;
    // The registry emits each rectangle as x, y, width, height and nothing else lives in this
    // frame, so reading the four keys in order is the whole parse. Named keys rather than
    // "every number after a colon": a payload that grows a field would otherwise silently
    // shift every rectangle by one.
    static constexpr const char* kKeys[] = {"\"x\":", "\"y\":", "\"width\":", "\"height\":"};
    std::vector<float> regions;
    size_t cursor = 0;
    while (true) {
        float rectangle[4];
        size_t next = cursor;
        bool complete = true;
        for (size_t index = 0; index < 4; ++index) {
            const size_t found = frame.find(kKeys[index], next);
            if (found == std::string::npos) {
                complete = false;
                break;
            }
            const size_t value = found + std::strlen(kKeys[index]);
            char* end = nullptr;
            rectangle[index] = std::strtof(frame.c_str() + value, &end);
            if (end == frame.c_str() + value) {
                complete = false;
                break;
            }
            next = static_cast<size_t>(end - frame.c_str());
        }
        if (!complete) break;
        regions.insert(regions.end(), std::begin(rectangle), std::end(rectangle));
        cursor = next;
    }
    setUiHitRegions(regions);
    // The rectangles themselves, not just the count: a hit that lands in the wrong place is a
    // layout or coordinate question, and only the published rectangles can answer it.
    std::cout << "TN_UI_HIT_REGIONS:{\"count\":" << regions.size() / 4 << ",\"regions\":[";
    for (size_t index = 0; index < regions.size(); ++index) {
        if (index > 0) std::cout << ",";
        std::cout << regions[index];
    }
    std::cout << "]}" << std::endl;
    return true;
}


#if defined(__ANDROID__)
/**
 * Publish one produced page frame, copied out of the producer's direct buffer.
 *
 * Called on Android's UI thread from the `TnUiOverlay` JNI callback; the copy is the CPU-readback
 * cost the wgpu lane pays instead of an external-texture import. Measured by the on-device probe
 * at ~1.1 ms for a full 1080x2400 `RGBA_8888` plane.
 */
void publishAndroidUiFrame(const void* pixels, size_t length, uint32_t width, uint32_t height,
                           uint32_t stride) {
    if (pixels == nullptr || length == 0 || width == 0 || height == 0 || stride == 0) return;
    auto owned = std::make_shared<std::vector<uint8_t>>(length);
    std::memcpy(owned->data(), pixels, length);
    std::lock_guard<std::mutex> lock(g_androidFrameMutex);
    g_androidFrame = std::move(owned);
    g_androidFrameWidth = width;
    g_androidFrameHeight = height;
    g_androidFrameStride = stride;
    g_androidFrameCounter += 1;
    g_androidFrameRgba.store(true, std::memory_order_relaxed);
    g_androidFramesPublished.store(g_androidFrameCounter, std::memory_order_relaxed);
}

/**
 * Hand back the latest produced page frame, retaining it until the following call.
 *
 * Defined outside `TN_ENABLE_UI_OVERLAY` because Android ships that flag off — its overlay is the
 * child WebView's own compositor, not the desktop offscreen host — so the frame seam must be
 * reachable on the disabled-overlay path too.
 */
bool takeAndroidUiOverlayFrame(UiOverlayFrame& frame) {
    std::lock_guard<std::mutex> lock(g_androidFrameMutex);
    if (!g_androidFrame || g_androidFrame->empty()) return false;
    g_androidFrameRetained = g_androidFrame;
    frame.pixels = g_androidFrameRetained->data();
    frame.length = g_androidFrameRetained->size();
    frame.width = g_androidFrameWidth;
    frame.height = g_androidFrameHeight;
    frame.stride = g_androidFrameStride;
    frame.counter = g_androidFrameCounter;
    frame.isRgba = g_androidFrameRgba.load(std::memory_order_relaxed);
    return true;
}
#endif

void queueUiMessage(std::string frame) {
    if (isUiReadyIntent(frame)) g_uiReadyIntentReceived.store(true, std::memory_order_release);
    std::lock_guard<std::mutex> lock(g_mutex);
    while (g_inbound.size() >= kMaxQueuedUiMessages) {
        g_inbound.pop_front();
        g_dropped.fetch_add(1, std::memory_order_relaxed);
    }
    g_inbound.push_back(std::move(frame));
}

bool takeUiMessage(std::string& frame) {
    std::lock_guard<std::mutex> lock(g_mutex);
    if (g_inbound.empty()) return false;
    frame = std::move(g_inbound.front());
    g_inbound.pop_front();
    return true;
}

uint64_t droppedUiMessages() { return g_dropped.load(std::memory_order_relaxed); }

bool uiReadyIntentReceived() { return g_uiReadyIntentReceived.load(std::memory_order_acquire); }

bool uiOverlayAttached() { return g_attached.load(std::memory_order_relaxed); }

void setUiOverlayAttached(bool attached) {
    const bool was = g_attached.exchange(attached, std::memory_order_relaxed);
    // Stamped on the cold-start clock, on every platform, because "the overlay never came up" and
    // "the overlay came up and the game could not talk to it" look identical in a screenshot and
    // are different bugs. PRD-218 needed to tell a 12-second HUD freeze caused by a late WebView
    // apart from one caused by a main loop too busy to drain its messages; only this timestamp,
    // against the frame markers on the same clock, separates them.
    if (was == attached) return;
    if (attached) mystral::coldStartMark("ui_overlay_attached");
    else mystral::coldStartMark("ui_overlay_detached");
}

size_t uiOverlayHitRegionCount() { return g_hitRegionCount.load(std::memory_order_relaxed); }

/**
 * One line per state posted to the UI and per pointer action routed to it, on the launch clock.
 *
 * PRD-398 asks for two ages that no screenshot can see: how long a state the game published takes to
 * reach the screen, and how long a pointer action takes to produce the response the player is owed.
 * Both start on this side of the bridge — the game thread posts state here, and every pointer action,
 * real or synthetic, enters at `uiOverlayRoutePointer` — and both end at a composited frame the game
 * thread also stamps (`TN_UI_COMPOSITE_TRACE`). One clock, one ordinal each, so a reader subtracts
 * two numbers from the same origin and pairs the *n*-th post with the *n*-th new page frame instead
 * of guessing from wall-clock timestamps.
 *
 * Off unless `TN_UI_LATENCY_TRACE` is set: a line per posted frame is noise in every other run.
 * Outside the overlay-only branch because both backends post and both are measured the same way.
 */
void traceUiLatency(const char* event, unsigned long long ordinal, const char* detail) {
    static const bool enabled = std::getenv("TN_UI_LATENCY_TRACE") != nullptr;
    if (!enabled) return;
    std::printf("TN_UI_LATENCY_TRACE:{\"event\":\"%s\",\"n\":%llu,\"detail\":\"%s\",\"atMs\":%.3f}\n",
                event, ordinal, detail, mystral::coldStartNowMs());
    std::fflush(stdout);
}

/**
 * Which side owns the pointer gesture in progress, and where it last was.
 *
 * Lives here rather than in either caller because there are two callers — the OS event loop on
 * Linux and the playtest bridge's synthetic input — and they must not be able to disagree. Nothing
 * else in this file is stateful, and the latch itself is backend-blind: it asks
 * `uiOverlayHitTest` and `uiOverlayInjectPointer`, which is how the CSS UI gets the same drag
 * behaviour the web view has without a second copy of these rules.
 */
struct UiPointerGesture {
    bool uiOwned = false;
    bool gameOwned = false;
    float lastX = 0.0f;
    float lastY = 0.0f;

    bool route(const char* type, float nx, float ny, int buttons, int pointerId) {
        const std::string kind(type);
        if (kind == "pointercancel") {
            const bool owned = uiOwned;
            uiOverlayInjectPointer(type, lastX, lastY, 0, pointerId);
            uiOwned = false;
            gameOwned = false;
            return owned;
        }
        if (kind == "pointerdown" && !uiOwned && !gameOwned) {
            if (!uiOverlayHitTest(nx, ny)) {
                uiOverlayInjectPointer("pointercancel", nx, ny, 0, pointerId);
                gameOwned = true;
                return false;
            }
            uiOwned = true;
            lastX = nx;
            lastY = ny;
            uiOverlayInjectPointer(type, nx, ny, buttons, pointerId);
            return true;
        }
        if (kind == "pointerup") {
            if (!uiOwned) {
                if (buttons == 0) gameOwned = false;
                return false;
            }
            // Where the press landed, not where the release was reported. A synthetic release can
            // arrive with no position at all, and gating it on a hit test dropped the press the
            // page was already holding — measured as a loadout button that never activated.
            uiOverlayInjectPointer(nx < 0 || nx > 1 || ny < 0 || ny > 1 ? "pointercancel" : type,
                                   lastX, lastY, buttons, pointerId);
            if (buttons == 0) uiOwned = false;
            return true;
        }
        if (kind == "pointermove") {
            // The UI observes every move, inside an island or not: an offscreen view has no
            // cursor, so hover is only ever what the host forwards. This is a side effect, not a
            // claim — the ownership rules below still decide whether the game also sees the move,
            // so motion is never stolen from it.
            uiOverlayInjectPointer(type, nx, ny, buttons, pointerId);
            if (uiOwned) {
                lastX = nx;
                lastY = ny;
                return true;
            }
            if (gameOwned) return false;
            if (!uiOverlayHitTest(nx, ny)) return false;
            lastX = nx;
            lastY = ny;
            return true;
        }
        if (uiOwned) {
            lastX = nx;
            lastY = ny;
            uiOverlayInjectPointer(type, nx, ny, buttons, pointerId);
            return true;
        }
        if (gameOwned) return false;
        if (!uiOverlayHitTest(nx, ny)) return false;
        lastX = nx;
        lastY = ny;
        uiOverlayInjectPointer(type, nx, ny, buttons, pointerId);
        return true;
    }
};
UiPointerGesture g_uiGesture;

#if TN_ENABLE_UI_OVERLAY
namespace {

/** The reason an attach failed, in the words a reader can act on. */
const char* attachFailure(int code) {
    switch (code) {
        case -5: return "invalid argument";
#if defined(__linux__) && !defined(__ANDROID__)
        // The offscreen backend has no window and no compositor to need, so the only failures left
        // are "the web engine never came up" and "the game window is not an X11 window" (reported
        // above, before the call, because SDL is what knows it).
        case -1: return "no display, or GTK could not start";
        case -4: return "the web view could not be built";
#else
        case -1: return "the overlay is not attached";
        case -2: return "the web view could not be built";
        case -3: return "the game window's native view could not be reached";
#endif
        default: return "invalid argument";
    }
}

}  // namespace

bool attachDesktopUiOverlay(const std::string& uiRoot) {
    auto* window = g_uiWindow;
    if (window == nullptr) return false;
    const auto properties = SDL_GetWindowProperties(window);
    // Each desktop hands `wry` the window it already owns, in that window system's own type: an
    // HWND on Windows, an NSWindow on macOS. Linux cannot attach to its X11 client the same way —
    // a child window occludes rather than blends — so there the overlay is an input-shaped
    // top-level, and a session without an X11 window says exactly that rather than "unsupported".
#if defined(_WIN32)
    const auto parent = reinterpret_cast<unsigned long>(
        SDL_GetPointerProperty(properties, SDL_PROP_WINDOW_WIN32_HWND_POINTER, nullptr));
    const char* missing = "the game window is not a Win32 window";
#elif defined(__APPLE__)
    const auto parent = reinterpret_cast<unsigned long>(
        SDL_GetPointerProperty(properties, SDL_PROP_WINDOW_COCOA_WINDOW_POINTER, nullptr));
    const char* missing = "the game window is not a Cocoa window";
#else
    const auto parent = static_cast<unsigned long>(
        SDL_GetNumberProperty(properties, SDL_PROP_WINDOW_X11_WINDOW_NUMBER, 0));
    const char* missing =
        "the game window is not an X11 window; run SDL under X11 (SDL_VIDEODRIVER=x11)";
#endif
    if (parent == 0) {
        std::cout << "TN_UI_OVERLAY:{\"attached\":false,\"reason\":\"" << missing << "\"}"
                  << std::endl;
        return false;
    }
    int width = 0;
    int height = 0;
    SDL_GetWindowSizeInPixels(window, &width, &height);
    const int code = tn_ui_overlay_attach(parent, uiRoot.c_str(), static_cast<uint32_t>(width),
                                          static_cast<uint32_t>(height));
    const bool attached = code == 0;
    setUiOverlayAttached(attached);
    if (attached) {
        std::cout << "TN_UI_OVERLAY:{\"attached\":true}" << std::endl;
    } else {
        std::cout << "TN_UI_OVERLAY:{\"attached\":false,\"reason\":\"" << attachFailure(code)
                  << "\"}" << std::endl;
    }
    return attached;
}

void pumpUiOverlay() {
    if (!uiOverlayAttached()) return;
#if TN_ENABLE_CSS_UI
    if (g_cssBackend) {
        cssPump();
        return;
    }
#endif
#if defined(_WIN32) || defined(__APPLE__)
    // Windows and macOS still attach a child web view to the window SDL owns, and both still need
    // their service point here. Windows re-cuts its container's input region when a resize changes
    // its pixels; both notice through this that the game window has gone away. Linux has neither a
    // window to follow nor work to do: the offscreen web view runs on its own thread and the only
    // thing left on this one is the queue below.
    if (tn_ui_overlay_pump() != 0) {
        std::cout << "TN_UI_OVERLAY:{\"attached\":false,\"reason\":\"the game window went away\"}"
                  << std::endl;
        detachDesktopUiOverlay();
        return;
    }
#endif
    // Handing the page's frames to the game's own message queue. JavaScript may only be touched
    // from this thread, so this is the one crossing and the queue is the only thing it needs.
    while (char* frame = tn_ui_overlay_take()) {
        queueUiMessage(std::string(frame));
        tn_ui_overlay_free(frame);
    }
}

bool uiOverlayFrame(UiOverlayFrame& frame) {
#if TN_ENABLE_CSS_UI
    if (g_cssBackend) return cssTakeFrame(frame);
#endif
#if defined(__linux__) && !defined(__ANDROID__)
    if (!uiOverlayAttached()) return false;
    TnUiFrameLayout layout{};
    if (tn_ui_overlay_frame(&layout) != 1) return false;
    frame.pixels = layout.pixels;
    frame.length = layout.length;
    frame.width = layout.width;
    frame.height = layout.height;
    frame.stride = layout.stride;
    frame.counter = layout.counter;
    return frame.pixels != nullptr && frame.length > 0;
#elif defined(__ANDROID__)
    return takeAndroidUiOverlayFrame(frame);
#else
    (void)frame;
    return false;
#endif
}

uint64_t uiOverlayFramesPublished() {
#if TN_ENABLE_CSS_UI
    if (g_cssBackend) return g_cssFramesPublished;
#endif
#if defined(__linux__) && !defined(__ANDROID__)
    if (!uiOverlayAttached()) return 0;
    return tn_ui_overlay_frames_published();
#elif defined(__ANDROID__)
    return g_androidFramesPublished.load(std::memory_order_relaxed);
#else
    return 0;
#endif
}

void uiOverlaySetSize(int width, int height) {
    if (!uiOverlayAttached() || width <= 0 || height <= 0) return;
#if TN_ENABLE_CSS_UI
    if (g_cssBackend) {
        cssSetSize(width, height);
        return;
    }
#endif
    // The offscreen view is placed by its own size, not by a position: there is no window, so x and
    // y have nothing to move.
    tn_ui_overlay_set_bounds(0, 0, static_cast<uint32_t>(width), static_cast<uint32_t>(height));
}

void setUiHitRegions(const std::vector<float>& regions) {
    g_hitRegionCount.store(regions.size() / 4, std::memory_order_relaxed);
    if (!uiOverlayAttached()) return;
    tn_ui_overlay_set_hit_regions(regions.empty() ? nullptr : regions.data(),
                                  static_cast<uint32_t>(regions.size() / 4));
}

void detachDesktopUiOverlay() {
    if (!uiOverlayAttached()) return;
    uiOverlayRoutePointer("pointercancel", 0, 0, 0, 1);
    if (g_resetKeyboard) g_resetKeyboard();
#if TN_ENABLE_CSS_UI
    if (g_cssBackend) {
        tn_css_ui_detach();
        g_cssBackend = false;
        setUiOverlayAttached(false);
        return;
    }
#endif
    tn_ui_overlay_detach();
    setUiOverlayAttached(false);
}

bool uiOverlayHitTest(float nx, float ny) {
    if (!uiOverlayAttached()) return false;
#if TN_ENABLE_CSS_UI
    if (g_cssBackend) return tn_css_ui_hit_test(nx, ny) == 1;
#endif
    return tn_ui_overlay_hit_test(nx, ny) == 1;
}

bool uiOverlayInjectPointer(const char* type, float nx, float ny, int buttons, int pointerId) {
    if (!uiOverlayAttached()) return false;
#if TN_ENABLE_CSS_UI
    if (g_cssBackend) return cssInjectPointer(type, nx, ny, buttons);
#endif
    return tn_ui_overlay_inject_pointer(type, nx, ny, buttons, pointerId) == 0;
}

bool uiOverlayInjectKey(uint32_t keycode, uint32_t modifiers, uint32_t group,
                        uint32_t time, bool down) {
#if TN_ENABLE_UI_OVERLAY && defined(__linux__) && !defined(__ANDROID__)
    if (!uiOverlayAttached()) return false;
    return tn_ui_overlay_inject_key(keycode, modifiers, group, time, down ? 1 : 0) == 0;
#else
    (void)keycode; (void)modifiers; (void)group; (void)time; (void)down;
    return false;
#endif
}

/**
 * Whether the page holds the keyboard. The web view's own focus is the authority; the CSS UI answers
 * the same question from the focused element its document reports, which is the only place a Tab, an
 * Enter or a wheel can have gone.
 */
bool uiOverlayKeyboardCaptured() {
#if TN_ENABLE_CSS_UI
    if (g_cssBackend) return tn_css_ui_focused_id() != 0;
#endif
#if defined(__linux__) && !defined(__ANDROID__)
    if (!uiOverlayAttached()) return false;
    return tn_ui_overlay_keyboard_captured() == 1;
#else
    return false;
#endif
}

bool uiOverlayRouteKey(const char* key, bool down, bool shift) {
#if TN_ENABLE_CSS_UI
    if (g_cssBackend && key != nullptr) return cssRouteKey(key, down, shift);
#else
    (void)key;
    (void)down;
    (void)shift;
#endif
    // The web overlay reads real X11 keys through its own filter, and the synthetic ones the playtest
    // bridge injects have always gone to the game. This route is the CSS backend's.
    return false;
}

bool uiOverlayRouteWheel(float nx, float ny, float dx, float dy) {
#if TN_ENABLE_CSS_UI
    if (g_cssBackend) return cssRouteWheel(nx, ny, dx, dy);
#else
    (void)nx;
    (void)ny;
    (void)dx;
    (void)dy;
#endif
    return false;
}
void uiOverlaySetPointerKind(bool touch) {
#if TN_ENABLE_CSS_UI
    if (g_cssBackend) tn_css_ui_set_pointer_kind(touch ? 1 : 0);
#else
    (void)touch;
#endif
}

bool uiOverlayRoutePointer(const char* type, float nx, float ny, int buttons, int pointerId) {
    if (!uiOverlayAttached() || type == nullptr) return false;
    // The arrival of a pointer action, before ownership is decided: this is the one function both
    // the OS event loop and the playtest bridge's synthetic input come through, so an action's age
    // is measured from here rather than from whichever side later claimed it.
    static unsigned long long routed = 0;
    traceUiLatency("pointer", ++routed, type);
    return g_uiGesture.route(type, nx, ny, buttons, pointerId);
}
#else
// No web view in this build, which is the whole point of the CSS UI: a Linux session with no
// WebKitGTK, or a host that never wanted a browser, still has a HUD. Every function below is the
// stub it always was, plus the CSS path when that is the backend that came up.
bool attachDesktopUiOverlay(const std::string& uiRoot) {
    (void)uiRoot;
    return false;
}
void pumpUiOverlay() {
#if TN_ENABLE_CSS_UI
    if (g_cssBackend) cssPump();
#endif
}
bool uiOverlayFrame(UiOverlayFrame& frame) {
#if TN_ENABLE_CSS_UI
    if (g_cssBackend) return cssTakeFrame(frame);
#endif
#if defined(__ANDROID__)
    // The in-frame producer publishes here even though `TN_ENABLE_UI_OVERLAY` is off on Android:
    // this is the CPU-readback seam, not the desktop offscreen host.
    return takeAndroidUiOverlayFrame(frame);
#else
    (void)frame;
    return false;
#endif
}
uint64_t uiOverlayFramesPublished() {
#if TN_ENABLE_CSS_UI
    if (g_cssBackend) return g_cssFramesPublished;
#endif
#if defined(__ANDROID__)
    return g_androidFramesPublished.load(std::memory_order_relaxed);
#else
    return 0;
#endif
}
void uiOverlaySetSize(int width, int height) {
#if TN_ENABLE_CSS_UI
    if (g_cssBackend && width > 0 && height > 0) cssSetSize(width, height);
#else
    (void)width;
    (void)height;
#endif
}
void setUiHitRegions(const std::vector<float>& regions) {
    // The CSS UI hit-tests its own tree, so there is no published-rectangle list to keep and no
    // second authority to disagree with the hit test `uiOverlayHitTest` already does.
    (void)regions;
}
void detachDesktopUiOverlay() {
#if TN_ENABLE_CSS_UI
    if (!g_cssBackend) return;
    uiOverlayRoutePointer("pointercancel", 0, 0, 0, 1);
    tn_css_ui_detach();
    g_cssBackend = false;
    setUiOverlayAttached(false);
#endif
}
bool uiOverlayHitTest(float nx, float ny) {
#if TN_ENABLE_CSS_UI
    if (g_cssBackend) return tn_css_ui_hit_test(nx, ny) == 1;
#endif
    (void)nx;
    (void)ny;
    return false;
}
bool uiOverlayInjectPointer(const char* type, float nx, float ny, int buttons, int pointerId) {
#if TN_ENABLE_CSS_UI
    if (g_cssBackend) return cssInjectPointer(type, nx, ny, buttons);
#endif
    (void)type;
    (void)nx;
    (void)ny;
    (void)buttons;
    (void)pointerId;
    return false;
}
bool uiOverlayInjectKey(uint32_t keycode, uint32_t modifiers, uint32_t group,
                        uint32_t time, bool down) {
#if TN_ENABLE_UI_OVERLAY && defined(__linux__) && !defined(__ANDROID__)
    if (!uiOverlayAttached()) return false;
    return tn_ui_overlay_inject_key(keycode, modifiers, group, time, down ? 1 : 0) == 0;
#else
    (void)keycode; (void)modifiers; (void)group; (void)time; (void)down;
    return false;
#endif
}
bool uiOverlayKeyboardCaptured() {
#if TN_ENABLE_CSS_UI
    // The CSS backend's own answer: a focused element is the only thing that can hold a key.
    if (g_cssBackend) return tn_css_ui_focused_id() != 0;
#endif
    return false;
}
bool uiOverlayRouteKey(const char* key, bool down, bool shift) {
#if TN_ENABLE_CSS_UI
    if (g_cssBackend && key != nullptr) return cssRouteKey(key, down, shift);
#else
    (void)key;
    (void)down;
    (void)shift;
#endif
    return false;
}
bool uiOverlayRouteWheel(float nx, float ny, float dx, float dy) {
#if TN_ENABLE_CSS_UI
    if (g_cssBackend) return cssRouteWheel(nx, ny, dx, dy);
#else
    (void)nx;
    (void)ny;
    (void)dx;
    (void)dy;
#endif
    return false;
}
void uiOverlaySetPointerKind(bool touch) {
#if TN_ENABLE_CSS_UI
    if (g_cssBackend) tn_css_ui_set_pointer_kind(touch ? 1 : 0);
#else
    (void)touch;
#endif
}
bool uiOverlayRoutePointer(const char* type, float nx, float ny, int buttons, int pointerId) {
#if TN_ENABLE_CSS_UI
    if (!g_cssBackend || !uiOverlayAttached() || type == nullptr) return false;
    static unsigned long long routed = 0;
    traceUiLatency("pointer", ++routed, type);
    return g_uiGesture.route(type, nx, ny, buttons, pointerId);
#else
    (void)type;
    (void)nx;
    (void)ny;
    (void)buttons;
    (void)pointerId;
    return false;
#endif
}
#endif

/**
 * Bring up the CSS UI backend over the game window: the game's `src/ui/` laid out and rasterised on
 * the CPU, with no web view anywhere on this path. Selected by `ui.renderer: "native-css"`, which
 * is what makes it a different backend rather than a different failure mode — the web view stays
 * the default and its own attach is untouched.
 *
 * Returns false and names the reason when the document could not be created. A game that asked for
 * this renderer and got a silent empty HUD would look exactly like a HUD with nothing to show, and
 * only one of those is a bug. `uiOverlayAttached()` follows the ABI the same way the web path's
 * does, so the composite, the pointer route, the resize and the CLI's ready gate all read one flag
 * whichever backend came up.
 */
bool attachDesktopCssUi(const std::string& uiRoot) {
#if TN_ENABLE_CSS_UI
    // Device pixels, like the web path: the document is laid out in the pixels of the surface its
    // frames are stretched over, and `uiOverlaySetSize` keeps up from there. The default is the
    // host's own default window size, used when there is no window to measure — a headless capture
    // run still gets a real document, because the UI layer's bridge is worth having even where
    // nothing is presented.
    int width = 1280;
    int height = 720;
    if (auto* window = g_uiWindow) SDL_GetWindowSizeInPixels(window, &width, &height);
    // The test clock is read before anything attaches, so a malformed value refuses the backend by
    // name rather than quietly running on real time under a run that asked for a fixed one.
    g_cssFixedStepMs = 0.0;
    g_cssFixedClockMs = 0.0;
    if (const char* step = std::getenv("TN_CSS_UI_FIXED_STEP_MS"); step != nullptr && *step != '\0') {
        char* end = nullptr;
        const double parsed = std::strtod(step, &end);
        if (end == step || *end != '\0' || !(parsed > 0.0) || parsed > 1000.0) {
            std::cout << "ui overlay: native-css refused TN_CSS_UI_FIXED_STEP_MS=" << step
                      << " (a fixed clock step is a number of milliseconds in (0, 1000])" << std::endl;
            std::cout << "TN_UI_OVERLAY:{\"attached\":false,\"renderer\":\"native-css\",\"reason\":"
                         "\"TN_CSS_UI_FIXED_STEP_MS is malformed\"}" << std::endl;
            return false;
        }
        g_cssFixedStepMs = parsed;
    }
    const int code = tn_css_ui_attach(uiRoot.c_str(), static_cast<uint32_t>(width),
                                      static_cast<uint32_t>(height));
    const bool attached = code == 0;
    g_cssBackend = attached;
    setUiOverlayAttached(attached);
    if (attached) {
        // The device it is styled for, read once because it does not change under a running game.
        // `dark` is the system's own answer (SDL reads the desktop setting). Reduced motion has no
        // such source here — SDL exposes none, and the desktop setting behind it lives in a settings
        // daemon this host must not shell out to — so it stays off, which is the setting the CSS
        // default is written against rather than a claim about the player's preferences.
        g_cssDark = SDL_GetSystemTheme() == SDL_SYSTEM_THEME_DARK ? 1 : 0;
        g_cssReducedMotion = 0;
        tn_css_ui_set_env(g_cssDark, g_cssReducedMotion);
        // The animation clock counts from here, and is fed from `cssPump` once per frame.
        g_cssAttachedAt = std::chrono::steady_clock::now();
        if (g_cssFixedStepMs > 0.0) {
            std::cout << "TN_CSS_UI_CLOCK:{\"mode\":\"fixed\",\"stepMs\":" << g_cssFixedStepMs << "}"
                      << std::endl;
        }
        std::cout << "ui overlay: native-css backend=" << tn_css_ui_backend() << " (no WebView)"
                  << std::endl;
        std::cout << "TN_UI_OVERLAY:{\"attached\":true,\"renderer\":\"native-css\"}" << std::endl;
    } else {
        std::cout << "ui overlay: native-css attach failed with code " << code << " ("
                  << cssFailure(code) << "): " << cssLastError() << std::endl;
        std::cout << "TN_UI_OVERLAY:{\"attached\":false,\"renderer\":\"native-css\",\"reason\":\""
                  << cssFailure(code) << "\"}" << std::endl;
    }
    return attached;
#else
    (void)uiRoot;
    // Named, not silent: a build without the backend asked for one, and saying so is the whole
    // value of a named reason.
    std::cout << "ui overlay: native-css is not in this build; configure with TN_ENABLE_CSS_UI=ON"
              << std::endl;
    std::cout << "TN_UI_OVERLAY:{\"attached\":false,\"renderer\":\"native-css\",\"reason\":"
                 "\"this build has no native-css backend\"}" << std::endl;
    return false;
#endif
}

bool uiOverlayTrackModifier(const std::string& key, bool down, UiKeyModifiers& mods) {
    bool* flag = key == "Shift"     ? &mods.shift
                 : key == "Control" ? &mods.ctrl
                 : key == "Alt"     ? &mods.alt
                 : key == "Meta"    ? &mods.meta
                                    : nullptr;
    if (flag == nullptr) return false;
    *flag = down;
    return true;
}

bool uiOverlaySetEnvironment(int dark, int reducedMotion) {
#if TN_ENABLE_CSS_UI
    if (!g_cssBackend || !uiOverlayAttached()) return false;
    if (dark >= 0) g_cssDark = dark != 0 ? 1 : 0;
    if (reducedMotion >= 0) g_cssReducedMotion = reducedMotion != 0 ? 1 : 0;
    std::cout << "TN_CSS_UI_ENV:{\"dark\":" << g_cssDark << ",\"reducedMotion\":" << g_cssReducedMotion
              << "}" << std::endl;
    return tn_css_ui_set_env(g_cssDark, g_cssReducedMotion) == 0;
#else
    (void)dark;
    (void)reducedMotion;
    return false;
#endif
}

bool uiOverlayAdvanceClock(int ticks) {
#if TN_ENABLE_CSS_UI
    if (!g_cssBackend || !uiOverlayAttached() || g_cssFixedStepMs <= 0.0 || ticks <= 0) return false;
    g_cssFixedClockMs += g_cssFixedStepMs * ticks;
    return tn_css_ui_set_time(g_cssFixedClockMs) == 0;
#else
    (void)ticks;
    return false;
#endif
}

bool postUiMessage(const std::string& frame) {
#if TN_ENABLE_CSS_UI
    if (g_cssBackend) {
        static unsigned long long posted = 0;
        traceUiLatency("post", ++posted, "");
        // Unmodified: the UI layer's transport for this backend is the frame itself, so a
        // `{"type":"tn:css","ops":[...]}` batch reaches the document exactly as it was written.
        const int code = tn_css_ui_post(frame.c_str());
        if (code != 0) {
            // A rejected batch applies none of its ops, so the HUD keeps whatever it last had —
            // which, if it is the first one, is an empty screen. Silent, that is a game with
            // nothing to show and nothing to read. Named, once per run at most
            // `kMaxCssPostRejections` times, because a cause in the markup repeats every frame.
            static unsigned rejected = 0;
            if (rejected < kMaxCssPostRejections) {
                ++rejected;
                std::fprintf(stderr, "TN_CSS_UI_POST_REJECTED: %d %s\n", code,
                             cssLastError().c_str());
                std::fflush(stderr);
            }
            return false;
        }
        // Readiness is armed here rather than at the first paint: the frames before this one show
        // an empty document, whatever the host does with them.
        //
        // Only for a frame the engine acts on. The bridge also carries the game's own state frames
        // (`{"type":"tn:state",...}`), which the engine accepts and ignores: counting one as the
        // HUD's first post would open the gate on the empty document it is meant to wait past.
        const bool foreign = frame.rfind("{\"type\":\"", 0) == 0 &&
                             frame.rfind("{\"type\":\"tn:css\"", 0) != 0;
        if (!foreign && !g_cssReadyArmed) {
            g_cssReadyArmed = true;
            g_cssPostCounter = g_cssCounter;
        }
        return true;
    }
#endif
#if TN_ENABLE_UI_OVERLAY
    if (uiOverlayAttached()) {
        static unsigned long long posted = 0;
        traceUiLatency("post", ++posted, "");
        return tn_ui_overlay_post(frame.c_str()) == 0;
    }
#endif
#if defined(__APPLE__) && TARGET_OS_IPHONE
    if (uiOverlayAttached()) return postIosUiMessage(frame);
#endif
#if defined(__ANDROID__)
    if (!uiOverlayAttached()) return false;
    auto* environment = static_cast<JNIEnv*>(SDL_GetAndroidJNIEnv());
    auto activity = static_cast<jobject>(SDL_GetAndroidActivity());
    if (environment == nullptr || activity == nullptr) return false;
    jclass activityClass = environment->GetObjectClass(activity);
    if (activityClass == nullptr) {
        environment->DeleteLocalRef(activity);
        return false;
    }
    jmethodID method =
        environment->GetMethodID(activityClass, "postUiOverlayMessage", "(Ljava/lang/String;)V");
    bool sent = false;
    if (method != nullptr) {
        jstring value = environment->NewStringUTF(frame.c_str());
        if (value != nullptr) {
            environment->CallVoidMethod(activity, method, value);
            sent = environment->ExceptionCheck() == JNI_FALSE;
            environment->DeleteLocalRef(value);
        }
    }
    if (environment->ExceptionCheck() != JNI_FALSE) environment->ExceptionClear();
    environment->DeleteLocalRef(activityClass);
    environment->DeleteLocalRef(activity);
    return sent;
#else
    (void)frame;
    return false;
#endif
}

}  // namespace platform
}  // namespace mystral

#if defined(__ANDROID__)
extern "C" {

/**
 * The page posted a message. Called on Android's UI thread from the `androidx.webkit` message
 * listener, so it may only enqueue — the runtime drains on the thread that owns JavaScript.
 */
JNIEXPORT void JNICALL Java_com_threenative_runtime_TnUiOverlay_nativeUiMessage(
    JNIEnv* environment, jclass, jstring frame) {
    if (frame == nullptr) return;
    const char* text = environment->GetStringUTFChars(frame, nullptr);
    if (text == nullptr) return;
    mystral::platform::queueUiMessage(std::string(text));
    environment->ReleaseStringUTFChars(frame, text);
}

/** The overlay reports whether it came up. A failure to attach is never inferred from silence. */
JNIEXPORT void JNICALL Java_com_threenative_runtime_TnUiOverlay_nativeUiOverlayAttached(
    JNIEnv*, jclass, jboolean attached) {
    mystral::platform::setUiOverlayAttached(attached == JNI_TRUE);
    __android_log_print(ANDROID_LOG_INFO, "Mystral", "TN_UI_OVERLAY:{\"attached\":%s}",
                        attached == JNI_TRUE ? "true" : "false");
}

/**
 * The in-frame producer published one page frame.
 *
 * `pixels` is the producer's direct `ImageReader` plane buffer, valid only for this call; the
 * copy into the latest-wins mailbox happens here, on Android's UI thread.
 */
JNIEXPORT void JNICALL Java_com_threenative_runtime_TnUiOverlay_nativeUiFrame(
    JNIEnv* environment, jclass, jobject pixels, jint width, jint height, jint stride) {
    if (pixels == nullptr) return;
    void* data = environment->GetDirectBufferAddress(pixels);
    const jlong capacity = environment->GetDirectBufferCapacity(pixels);
    if (data == nullptr || capacity <= 0) return;
    mystral::platform::publishAndroidUiFrame(data, static_cast<size_t>(capacity),
                                             static_cast<uint32_t>(width),
                                             static_cast<uint32_t>(height),
                                             static_cast<uint32_t>(stride));
}

/**
 * The host names which composite path it took, so a run reports it rather than inferring it.
 *
 * `in-frame-cpu` is the wgpu Android lane (no external-texture import, CPU readback upload);
 * `child-window` is today's transparent child WebView. Never silently downgrade.
 */
JNIEXPORT void JNICALL Java_com_threenative_runtime_TnUiOverlay_nativeUiCompositePath(
    JNIEnv* environment, jclass, jstring path) {
    if (path == nullptr) return;
    const char* text = environment->GetStringUTFChars(path, nullptr);
    if (text == nullptr) return;
    __android_log_print(ANDROID_LOG_INFO, "Mystral", "TN_UI_COMPOSITE_PATH:{\"path\":\"%s\"}",
                        text);
    environment->ReleaseStringUTFChars(path, text);
}

}  // extern "C"
#endif
