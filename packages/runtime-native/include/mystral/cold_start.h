#pragma once

// Cold-start segment markers.
//
// PRD-070 opens on a hole rather than a regression: nothing in this repository measured launch
// time, so a 4x change in it could ship unnoticed the way a 50x frame-rate change already had.
// Every marker below is one boundary in the launch, stamped from a single monotonic clock so a
// reader subtracts two numbers rather than two log timestamps from two different clocks.
//
// The shape is deliberately dull and greppable:
//
//     TN_COLD_START:{"segment":"compile_begin","atMs":1234.567}
//
// `measure-cold-start.mjs` requires every segment it knows about and fails closed on a missing
// one. Adding a marker here without teaching that script about it is harmless; removing or
// renaming one fails the instrument, which is the intent.

#include "mystral/console_markers.h"

#include <chrono>
#include <cstdio>
#include <thread>

#ifdef __ANDROID__
#include <android/log.h>
#endif

namespace mystral {

/** Milliseconds from an arbitrary but process-stable origin. */
inline double coldStartNowMs() {
    static const std::chrono::steady_clock::time_point origin = std::chrono::steady_clock::now();
    return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - origin)
        .count();
}

/**
 * The thread that emitted the first marker, which is the launch thread on every host.
 *
 * `process` is the first marker on both entry points (`SDL_main` on Android, `main` on desktop),
 * so the first call pins the launch thread before any worker exists. Worker threads run their own
 * engine and evaluate their own bootstrap through the same code path; without this they would
 * interleave a second launch's worth of compile markers into the one the reader is parsing.
 */
inline const std::thread::id& coldStartLaunchThread() {
    static const std::thread::id launchThread = std::this_thread::get_id();
    return launchThread;
}

/** Emits one launch-boundary marker. Cheap enough to leave compiled in on every build. */
inline void coldStartMark(const char* segment) {
    coldStartLaunchThread();
    const double atMs = coldStartNowMs();
#ifdef __ANDROID__
    __android_log_print(ANDROID_LOG_INFO, "MystralColdStart",
                        "TN_COLD_START:{\"segment\":\"%s\",\"atMs\":%.3f}", segment, atMs);
#else
    std::printf("TN_COLD_START:{\"segment\":\"%s\",\"atMs\":%.3f}\n", segment, atMs);
    std::fflush(stdout);
#endif
}

/**
 * Brackets one JavaScript evaluation with the four launch segments the reader needs.
 *
 * PRD-328 opens on an instrument that could not run on the engine that ships: the compile and
 * execute markers existed only in `quickjs_engine.cpp`, which has not been the shipped engine on
 * any platform since 2026-08-16, so `measure-cold-start.mjs` failed closed with
 * `TN_COLD_START_MARKER_MISSING:compile_begin` on every real configuration and the desktop CLI
 * emitted no launch markers at all.
 *
 * Every engine reaches its entry bundle through a different member — V8 takes `eval` for an ESM
 * entry on desktop and `evalScript` for the Android bundle, JavaScriptCore folds both into
 * `evalWithResult` — and each of those members is also how nested CommonJS requires and worker
 * bootstrap run. Marking them all unconditionally would emit one set of segments per *module*.
 * So this counts nesting depth and marks only the outermost evaluation on the launch thread,
 * which is the bundle. Bootstrap scripts evaluated before the game are outermost too and emit
 * their own set; `game_eval_begin` is what tells the reader which set is the game's.
 *
 * Usage mirrors the shape `quickjs_engine.cpp` already writes by hand:
 *
 *     ColdStartEvalScope scope;              // compile_begin
 *     ... compile ...  scope.compiled();     // compile_complete
 *     scope.executing();                     // execute_begin
 *     ... run ...      scope.executed();     // execute_complete
 *
 * A failed compile or a thrown top-level simply stops marking, so a launch that did not finish
 * reports a missing marker rather than a total that never happened.
 */
class ColdStartEvalScope {
  public:
    ColdStartEvalScope() : outermost_(std::this_thread::get_id() == coldStartLaunchThread() &&
                                      depth() == 0) {
        depth() += 1;
        if (outermost_) coldStartMark("compile_begin");
    }

    ColdStartEvalScope(const ColdStartEvalScope&) = delete;
    ColdStartEvalScope& operator=(const ColdStartEvalScope&) = delete;

    ~ColdStartEvalScope() { depth() -= 1; }

    void compiled() { if (outermost_) coldStartMark("compile_complete"); }
    void executing() { if (outermost_) coldStartMark("execute_begin"); }
    void executed() { if (outermost_) coldStartMark("execute_complete"); }

  private:
    /** Per-thread so a worker's own evaluations can never be mistaken for the launch thread's. */
    static int& depth() {
        static thread_local int nesting = 0;
        return nesting;
    }

    const bool outermost_;
};

/**
 * Records the first frames after the first present and reports the distribution once.
 *
 * A hitch is a distribution claim, never a mean: the cost this exists to catch is one 400 ms
 * frame at second three, and an average over the same window hides it completely. So the report
 * carries the maximum and the frame it landed on, plus p50 and p99 for context.
 *
 * The window is fixed and allocated once. Nothing here allocates or logs per frame — the whole
 * point is an instrument that can stay compiled in without becoming the hitch it measures.
 */
class FrameHitchRecorder {
  public:
    static constexpr int kWindow = 300;

    /**
     * Call once per presented frame. Emits the summary on the frame that closes the window.
     *
     * `pipelineCompileMs` / `pipelineCompileCalls` are what the caller drained from
     * `stallBudget().takePostPresentPipelineCompile()` for this frame (PRD-327 Phase 4): the
     * window summary carries the window's totals, so a material that appears mid-game and
     * compiles synchronously is a named hitch, not an anonymous spike.
     */
    void record(double pipelineCompileMs = 0.0, unsigned long long pipelineCompileCalls = 0) {
        const double now = coldStartNowMs();
        if (previousMs_ < 0.0) {
            previousMs_ = now;
            return;
        }
        const double frameMs = now - previousMs_;
        previousMs_ = now;
        if (count_ >= kWindow) return;
        samples_[count_] = frameMs;
        windowPipelineCompileMs_ += pipelineCompileMs;
        windowPipelineCompileCalls_ += pipelineCompileCalls;
        count_ += 1;
        if (count_ == kWindow) report();
    }

  private:
    void report() {
        double sorted[kWindow];
        for (int index = 0; index < kWindow; index += 1) sorted[index] = samples_[index];
        // Insertion sort: 300 elements, once per launch, and it keeps the header dependency-free.
        for (int index = 1; index < kWindow; index += 1) {
            const double value = sorted[index];
            int slot = index - 1;
            while (slot >= 0 && sorted[slot] > value) {
                sorted[slot + 1] = sorted[slot];
                slot -= 1;
            }
            sorted[slot + 1] = value;
        }
        double worst = 0.0;
        int worstAt = -1;
        for (int index = 0; index < kWindow; index += 1) {
            if (samples_[index] > worst) {
                worst = samples_[index];
                worstAt = index;
            }
        }
        const double p50 = sorted[kWindow / 2];
        const double p99 = sorted[(kWindow * 99) / 100];
        const char* format =
            TN_MARKER_FRAME_HITCH ":{\"window\":%d,\"maxMs\":%.3f,\"maxAtFrame\":%d,\"p99Ms\":%.3f,"
            "\"p50Ms\":%.3f,\"pipelineCompileMs\":%.3f,\"pipelineCompileCalls\":%llu}";
#ifdef __ANDROID__
        __android_log_print(ANDROID_LOG_INFO, "MystralColdStart", format, kWindow, worst, worstAt,
                            p99, p50, windowPipelineCompileMs_, windowPipelineCompileCalls_);
#else
        std::printf(format, kWindow, worst, worstAt, p99, p50, windowPipelineCompileMs_,
                    windowPipelineCompileCalls_);
        std::printf("\n");
        std::fflush(stdout);
#endif
    }

    double samples_[kWindow] = {};
    double windowPipelineCompileMs_ = 0.0;
    unsigned long long windowPipelineCompileCalls_ = 0;
    double previousMs_ = -1.0;
    int count_ = 0;
};

/** The process-wide recorder. One launch, one window, one report. */
inline FrameHitchRecorder& frameHitches() {
    static FrameHitchRecorder recorder;
    return recorder;
}

}  // namespace mystral
