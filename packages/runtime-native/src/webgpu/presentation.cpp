#include "mystral/webgpu/presentation.h"

#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <mutex>
#include <thread>

#if defined(MYSTRAL_WEBGPU_WGPU) || defined(MYSTRAL_WEBGPU_DAWN)
#include <webgpu/webgpu.h>
#if defined(MYSTRAL_WEBGPU_WGPU)
#if __has_include(<webgpu/wgpu.h>)
#include <webgpu/wgpu.h>
#else
#include <wgpu/wgpu.h>
#endif
#endif
#endif

#if defined(__ANDROID__)
#include <android/log.h>
#endif

namespace mystral::webgpu {

// ---------------------------------------------------------------------------
// Presentation ceiling (PRD-218)
// ---------------------------------------------------------------------------
//
// A convention that ships on: a game presents at most `g_presentationCapHz` frames a second, and
// runs uncapped only when it asks to.
//
// The measurement that bought this: on a Pixel 8, a build whose whole scene was a static dark
// screen with three textures held **119.8 presents per second, indefinitely**. `fifo` vsync was
// the only ceiling in the runtime, so on a 120 Hz panel a loading screen, a pause menu or a game
// that has finished drawing burns the SoC at the panel's rate for no visible benefit -- the phone
// warms and the battery drains to present the same pixels twice. Nothing in the frame was
// expensive; that was exactly the problem.
//
// 60 Hz is the default because it is the rate every game in this repository was authored against
// and half of the common high-refresh panel, so a frame is presented on every second vsync
// interval rather than at an unrelated period that would judder against it.
//
// Honesty when overridden is part of the convention, not a nicety: the effective cap rides along
// in every `TN_PRESENTS_TICK`, so a probe that reads 120 presents a second can tell "the game
// opted out" from "the cap is broken" without reading the game's source.
static uint32_t g_presentationCapHz = 60;

/** The pacing deadline for the next present. Zero until the first paced frame. */
static std::chrono::steady_clock::time_point g_nextPresentDeadline{};

// ---------------------------------------------------------------------------
// Display-synchronized pacing (PRD-399)
// ---------------------------------------------------------------------------
//
// The Android activity feeds its `Choreographer.FrameCallback` here. While those callbacks are
// live the cap is a target in the display's own timestamp domain -- nanoseconds, never compared
// with `steady_clock`: the next present is scheduled `1/cap` after the previous target and the
// render thread waits until a display frame reaches it. The measured cadence, not an assumed
// 60 Hz, decides, and advancing from the target rather than the frame seen keeps a fractional
// cap's remainder. A first frame or an already-past target schedules forward, so a slow frame
// never draws a catch-up burst. With no callbacks -- startup, paused, or signal lost -- the wait
// is bounded and the pre-existing `steady_clock` deadline below takes over; `maxFps == 0` returns
// before either path. No new scheduler: the signal is only a better deadline for the existing
// `paceToPresentationCap()` owner.
namespace {

struct PresentationPacing {
    std::mutex mutex;
    std::condition_variable ready;
    bool running = false;           // set on resume, cleared on pause; frames require it
    bool haveFrame = false;         // at least one display frame timestamp has been seen
    int64_t frameTimeNs = 0;        // latest display frame timestamp, in the display's own domain
    int64_t nextPresentTargetNs = 0;  // schedule target, in that same domain
};

PresentationPacing g_presentationPacing;

// Test-only, PRD-399. A display-release test parks the render thread and unblocks it with a
// synthetic display frame; on a loaded runner that synthetic frame can arrive after the production
// bounded timeout, so the waiter falls back to the wrong path. Non-zero replaces the bounded
// allowance with a value the test chooses. Production never calls the setter, and the lifecycle
// reset clears it, so the production formula below is what ships.
std::chrono::nanoseconds g_presentationPacingTimeoutOverride{0};

// Reports the effective pacing path once per transition, never per frame. A run can then tell
// "display-aligned" from "deadline-fallback" without reading the source, and a packaged `.so` can
// be grepped for the marker to prove the APK actually carries this change.
void reportPacingPath(const char* path) {
#if defined(__ANDROID__)
    __android_log_print(ANDROID_LOG_INFO, "MystralRuntime",
                        "TN_PRESENTATION_PACING:{\"path\":\"%s\"}", path);
#else
    (void)path;
#endif
}

// Waits for the display target and reports why the caller may need its software deadline.
PresentationPacingPath paceToDisplayFrame(std::chrono::nanoseconds interval) {
    std::unique_lock<std::mutex> lock(g_presentationPacing.mutex);
    if (!g_presentationPacing.running || !g_presentationPacing.haveFrame)
        return PresentationPacingPath::SoftwareDeadline;

    const int64_t intervalNs = interval.count();
    if (g_presentationPacing.nextPresentTargetNs == 0) {
        // First paced frame: schedule forward from the frame just observed.
        g_presentationPacing.nextPresentTargetNs = g_presentationPacing.frameTimeNs + intervalNs;
        return PresentationPacingPath::Display;
    }

    // One absolute bounded wait tolerates a late callback without extending on spurious wakes.
    // Only a deadline with no qualifying frame drops the display schedule until a fresh callback.
    // The production allowance is two intervals plus 50 ms; the test seam only ever widens it.
    const std::chrono::nanoseconds boundedWait =
        g_presentationPacingTimeoutOverride.count() > 0
            ? g_presentationPacingTimeoutOverride
            : interval * 2 + std::chrono::milliseconds(50);
    const auto deadline = std::chrono::steady_clock::now() + boundedWait;
    while (g_presentationPacing.running &&
           g_presentationPacing.frameTimeNs < g_presentationPacing.nextPresentTargetNs) {
        if (g_presentationPacing.ready.wait_until(lock, deadline) == std::cv_status::timeout) {
            // A notified frame can be ready even when the waiting thread runs after the deadline.
            if (!g_presentationPacing.running) return PresentationPacingPath::SoftwareDeadline;
            if (g_presentationPacing.frameTimeNs < g_presentationPacing.nextPresentTargetNs) {
                g_presentationPacing.haveFrame = false;
                g_presentationPacing.nextPresentTargetNs = 0;
                return PresentationPacingPath::DisplayTimeoutFallback;
            }
        }
    }
    if (!g_presentationPacing.running) return PresentationPacingPath::SoftwareDeadline;

    // Advance from the target, not from the frame just seen -- for an already-arrived frame too: a
    // fractional cap keeps its remainder instead of losing it to the display period. If callbacks
    // arrived so late that the target is already behind, reschedule from now rather than firing a
    // burst to catch up.
    g_presentationPacing.nextPresentTargetNs += intervalNs;
    if (g_presentationPacing.nextPresentTargetNs <= g_presentationPacing.frameTimeNs) {
        g_presentationPacing.nextPresentTargetNs = g_presentationPacing.frameTimeNs + intervalNs;
    }
    return PresentationPacingPath::Display;
}

}  // namespace

// Fed from the activity's Choreographer callback. `started`/`stopped` bracket its registration:
// started on resume, stopped on pause *before* the callback is removed, so a render thread inside
// paceToPresentationCap() is woken and falls back instead of waiting out its timeout. A frame
// update is ignored unless the frames are running, so a late callback cannot resurrect a stopped
// schedule.
void notePresentationFramesStarted() {
    std::lock_guard<std::mutex> lock(g_presentationPacing.mutex);
    g_presentationPacing.running = true;
    g_presentationPacing.nextPresentTargetNs = 0;
    g_presentationPacing.ready.notify_all();
}

void notePresentationFramesStopped() {
    std::lock_guard<std::mutex> lock(g_presentationPacing.mutex);
    g_presentationPacing.running = false;
    g_presentationPacing.haveFrame = false;
    g_presentationPacing.frameTimeNs = 0;
    g_presentationPacing.nextPresentTargetNs = 0;
    g_presentationPacingTimeoutOverride = std::chrono::nanoseconds{0};
    g_presentationPacing.ready.notify_all();
}

void notePresentationFrame(int64_t frameTimeNs) {
    std::lock_guard<std::mutex> lock(g_presentationPacing.mutex);
    if (!g_presentationPacing.running) return;
    g_presentationPacing.frameTimeNs = frameTimeNs;
    g_presentationPacing.haveFrame = true;
    g_presentationPacing.ready.notify_all();
}

void setPresentationPacingTimeoutForTest(std::chrono::milliseconds timeout) {
    std::lock_guard<std::mutex> lock(g_presentationPacing.mutex);
    g_presentationPacingTimeoutOverride = std::chrono::duration_cast<std::chrono::nanoseconds>(timeout);
}

bool setPresentationCapHz(uint32_t hz) {
    if (hz > 1000) return false;
    g_presentationCapHz = hz;
    g_nextPresentDeadline = std::chrono::steady_clock::time_point{};
    std::lock_guard<std::mutex> lock(g_presentationPacing.mutex);
    g_presentationPacing.nextPresentTargetNs = 0;
    return true;
}

/**
 * Holds the loop back to the presentation ceiling, after a frame that actually presented.
 *
 * Only after a present, and never during startup: the launch stall this same PRD measures has no
 * presents in it at all, and pacing an unpresented loop would add sleep to the twelve seconds a
 * player already waits. A frame that misses its deadline resets the schedule instead of trying to
 * catch up, because a game running below the cap must not then be asked to present a burst.
 */
PresentationPacingPath paceToPresentationCap() {
    if (g_presentationCapHz == 0) return PresentationPacingPath::Uncapped;
    const auto interval = std::chrono::nanoseconds(1000000000ull / g_presentationCapHz);

    static bool reportedDisplay = false;
    static bool reportedFallback = false;
    const auto path = paceToDisplayFrame(interval);
    if (path == PresentationPacingPath::Display) {
        if (!reportedDisplay) {
            reportedDisplay = true;
            reportedFallback = false;
            reportPacingPath("display-aligned");
        }
        return path;
    }
    if (!reportedFallback) {
        reportedFallback = true;
        reportedDisplay = false;
        reportPacingPath("deadline-fallback");
    }

    using clock = std::chrono::steady_clock;
    const auto now = clock::now();
    if (g_nextPresentDeadline == clock::time_point{} || now > g_nextPresentDeadline + interval) {
        // First paced frame, or the loop fell far enough behind that the old schedule is stale.
        g_nextPresentDeadline = now + interval;
        return path;
    }
    if (now < g_nextPresentDeadline) std::this_thread::sleep_until(g_nextPresentDeadline);
    g_nextPresentDeadline += interval;
    return path;
}

uint32_t getPresentationCapHz() { return g_presentationCapHz; }

#if defined(MYSTRAL_WEBGPU_WGPU) || defined(MYSTRAL_WEBGPU_DAWN)
void configurePresentationSurface(WGPUSurface surface, const WGPUSurfaceConfiguration* configuration) {
    auto config = *configuration;
    config.alphaMode = WGPUCompositeAlphaMode_Auto;
#if defined(MYSTRAL_WEBGPU_WGPU)
    WGPUSurfaceConfigurationExtras latency = {};
    latency.chain.sType = static_cast<WGPUSType>(WGPUSType_SurfaceConfigurationExtras);
    latency.chain.next = config.nextInChain;
    latency.desiredMaximumFrameLatency = TN_WEBGPU_DESIRED_FRAME_LATENCY;
#if defined(__ANDROID__)
    // Preserve wgpu-native's two-frame default explicitly on both Android hosts.
    if (latency.desiredMaximumFrameLatency == 0) latency.desiredMaximumFrameLatency = 2;
#endif
    if (latency.desiredMaximumFrameLatency > 0) config.nextInChain = &latency.chain;
#endif
    wgpuSurfaceConfigure(surface, &config);
#if defined(__ANDROID__)
    __android_log_print(ANDROID_LOG_INFO, "MystralRuntime",
        "TN_SURFACE_CONFIG:{\"presentMode\":%u,\"alphaMode\":%u,\"frameLatency\":%u}",
        static_cast<unsigned>(config.presentMode), static_cast<unsigned>(config.alphaMode),
#if defined(MYSTRAL_WEBGPU_WGPU)
        latency.desiredMaximumFrameLatency
#else
        0u // Dawn owns image count; its C API exposes no frame-latency setting.
#endif
    );
#endif
}

#if defined(__ANDROID__)
namespace {
// One sleeping watchdog per host, not a new acquire worker every frame. Surface ownership stays
// on the render thread. A wedged synchronous driver cannot be cancelled or safely torn down.
class AcquireDeadline {
public:
    AcquireDeadline() : worker_([this] {
        std::unique_lock lock(mutex_);
        while (!stopped_) {
            if (!armed_) {
                ready_.wait(lock, [this] { return stopped_ || armed_; });
                continue;
            }
            if (ready_.wait_until(lock, deadline_) == std::cv_status::timeout && armed_ &&
                std::chrono::steady_clock::now() >= deadline_) {
                __android_log_print(ANDROID_LOG_ERROR, "TN_Player",
                    "TN_SURFACE_ACQUIRE_TIMEOUT: driver did not return within 2000 ms; exiting without GPU teardown");
                std::_Exit(2);
            }
        }
    }) {}
    ~AcquireDeadline() {
        {
            std::lock_guard lock(mutex_);
            stopped_ = true;
            ready_.notify_all();
        }
        worker_.join();
    }
    void arm() {
        std::lock_guard lock(mutex_);
        deadline_ = std::chrono::steady_clock::now() + std::chrono::seconds(2);
        armed_ = true;
        ready_.notify_all();
    }
    void disarm() {
        std::lock_guard lock(mutex_);
        armed_ = false;
        ready_.notify_all();
    }
private:
    std::mutex mutex_;
    std::condition_variable ready_;
    bool stopped_ = false;
    bool armed_ = false;
    std::chrono::steady_clock::time_point deadline_{};
    std::thread worker_;
};
}  // namespace
#endif

void acquirePresentationSurface(WGPUSurface surface, WGPUSurfaceTexture* texture) {
#if defined(__ANDROID__)
    static AcquireDeadline deadline;
    deadline.arm();
#endif
    wgpuSurfaceGetCurrentTexture(surface, texture);
#if defined(__ANDROID__)
    deadline.disarm();
#endif
}
#endif

}  // namespace mystral::webgpu
