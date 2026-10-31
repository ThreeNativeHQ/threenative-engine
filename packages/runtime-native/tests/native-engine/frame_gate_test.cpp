#include "check.h"
#include "engine/foundation/waste_counters.h"
#include "engine/renderer/frame_gate.h"

#include <cstddef>
#include <cstdint>
#include <deque>
#include <utility>

// The web host's frame gate. On the RTS kit (2026-10-28, Chrome, RTX 2080 shared with other jobs) a 3 ms GPU
// frame's work-done promise resolved at p90 24 ms and p99 39 ms. A gate that counted two unfinished frames
// declined 7.5 % of frames the GPU had already drawn, and every declined frame showed as a stutter.

namespace {

using tn::engine::FrameGate;

// A 60 Hz loop whose GPU keeps up, but whose done signal arrives two frames late: no frame is declined.
void lateSignalDrawsEveryFrame() {
    FrameGate gate;
    const double interval = 1000.0 / 60.0;
    uint64_t submitted = 0;
    int declined = 0;
    for (int frame = 0; frame < 600; ++frame) {
        const double now = frame * interval;
        const uint64_t done = submitted >= 2 ? submitted - 2 : 0;  // the signal for the frame two back arrives
        if (gate.decline(done, now)) {
            ++declined;
            continue;
        }
        gate.submitted(++submitted, now);
    }
    CHECK(declined == 0);
}

// A GPU that keeps up whose done signal is a steady 80 ms behind: a loaded host, where Chrome's promise resolved
// 73 ms (p50) after the submit while the GPU frame itself cost 2.6 ms. A constant delay is not a backlog, so after
// the warm-up that lets the gate learn the delay, no frame is declined.
void steadyLateSignalDrawsEveryFrame() {
    FrameGate gate;
    const double interval = 1000.0 / 60.0;
    const double signalDelay = 80.0;
    const int warmUp = 60;
    int declinedAfterWarmUp = 0;
    int declinedInWarmUp = 0;
    uint64_t submitted = 0;
    uint64_t done = 0;
    std::deque<std::pair<uint64_t, double>> drawn;  // serial and submit time of each frame this test drew
    for (int frame = 0; frame < 600; ++frame) {
        const double now = frame * interval;
        // Each frame's signal arrives a constant 80 ms after its submit, so the newest finished frame is the newest
        // one submitted at least 80 ms ago.
        while (!drawn.empty() && drawn.front().second <= now - signalDelay) {
            done = drawn.front().first;
            drawn.pop_front();
        }
        if (gate.decline(done, now)) {
            if (frame >= warmUp) ++declinedAfterWarmUp;
            else ++declinedInWarmUp;
            continue;
        }
        gate.submitted(++submitted, now);
        drawn.emplace_back(submitted, now);
    }
    std::fprintf(stderr, "steady late signal: declined %d in the warm-up, %d of the %d frames after it\n",
                 declinedInWarmUp, declinedAfterWarmUp, 600 - warmUp);
    CHECK(declinedAfterWarmUp * 100 <= 600 - warmUp);  // under 1 % of the frames after the warm-up
}

// A GPU that falls further behind every frame (one completion per 25 ms against a 16.7 ms loop): the queue must stay
// bounded rather than growing until Chromium's queue loses the device, and the drawn frames must not be starved.
//
// Here `kMaxFrames` is the only rule that trips, by design. The gate holds the queue at 6 frames, 100 ms old, and
// this steadily slow GPU teaches the learned signal delay the age of its own completions (~100 ms), so the oldest
// unfinished frame is never `kBehindIntervals` (67 ms) older than that: measured 0 of 195 declines on age, 6 frames
// at worst. The age rule keeps its teeth where it is needed — an unladen signal that then stops, `gpu_behindIsDeclined`
// below declines over 100 of 120 frames on ages before capacity — and a GPU that is simply too slow is bounded by
// `kMaxFrames`, which is the hard safety bound and does not depend on the ages at all.
void growingBacklogIsDeclined() {
    namespace waste = tn::engine::waste;
    auto& counts = waste::counters();
    waste::setDebugEnabled(true);
    const auto ageBefore = counts.gateDeclinedAge.load();
    FrameGate gate;
    const double interval = 1000.0 / 60.0;
    const double gpuFrame = 25.0;  // the GPU completes one frame every 25 ms; the loop submits every 16.7 ms
    uint64_t submitted = 0;
    std::size_t worst = 0;
    int declined = 0;
    for (int frame = 0; frame < 600; ++frame) {
        const double now = frame * interval;
        const uint64_t finished = static_cast<uint64_t>(now / gpuFrame);
        const uint64_t done = finished < submitted ? finished : submitted;
        if (gate.decline(done, now)) ++declined;
        else gate.submitted(++submitted, now);
        worst = gate.unfinished() > worst ? gate.unfinished() : worst;
    }
    const auto ageDeclines = counts.gateDeclinedAge.load() - ageBefore;
    waste::setDebugEnabled(false);
    std::fprintf(stderr, "growing backlog: %d declined, %llu of them on age, %zu unfinished at worst, %llu drawn\n",
                 declined, static_cast<unsigned long long>(ageDeclines), worst,
                 static_cast<unsigned long long>(submitted));
    CHECK(worst <= FrameGate::kMaxFrames);
    CHECK(declined > 0);
    CHECK(submitted >= 200);  // about one frame per GPU frame still gets drawn (measured 405 of 600)
}

// A GPU that never reports done (it fell behind): the gate declines once the oldest frame is old, and keeps the
// queue short.
void gpuBehindIsDeclined() {
    FrameGate gate;
    const double interval = 1000.0 / 60.0;
    uint64_t submitted = 0;
    int declined = 0;
    for (int frame = 0; frame < 120; ++frame) {
        const double now = frame * interval;
        if (gate.decline(0, now)) {
            ++declined;
            continue;
        }
        gate.submitted(++submitted, now);
    }
    CHECK(declined > 100);
    CHECK(gate.unfinished() <= 6);
}

// An unthrottled loop (rAF far faster than the display) whose GPU is slower than the loop: the gate follows the
// loop's own interval, so the queue stays bounded.
void unthrottledLoopStaysBounded() {
    FrameGate gate;
    const double interval = 1.0;  // a 1000 Hz loop
    const double gpuFrame = 10.0;  // each frame takes the GPU 10 ms
    uint64_t submitted = 0;
    uint64_t done = 0;
    std::size_t worst = 0;
    for (int frame = 0; frame < 2000; ++frame) {
        const double now = frame * interval;
        done = static_cast<uint64_t>(now / gpuFrame) < submitted ? static_cast<uint64_t>(now / gpuFrame) : submitted;
        if (!gate.decline(done, now)) gate.submitted(++submitted, now);
        worst = gate.unfinished() > worst ? gate.unfinished() : worst;
    }
    CHECK(worst <= 6);
    CHECK(submitted >= 150);  // about one frame per GPU frame still gets through
}

void debugReasonsFollowGate() {
    namespace waste = tn::engine::waste;
    auto& counts = waste::counters();
    waste::setDebugEnabled(false);
    const auto before = counts.gateAttempts.load();
    FrameGate off;
    off.decline(0, 0);
    CHECK(counts.gateAttempts.load() == before);
    waste::setDebugEnabled(true);
    FrameGate age;
    age.submitted(1, 0);
    age.submitted(2, 0);
    CHECK(age.decline(0, 100));
    CHECK(counts.gateDeclinedAge.load() == 1);
    FrameGate capacity;
    for (uint64_t i = 1; i <= FrameGate::kMaxFrames; ++i) capacity.submitted(i, 0);
    CHECK(capacity.decline(0, 1));
    CHECK(counts.gateDeclinedCapacity.load() == 1);
    CHECK(counts.gateAttempts.load() == before + 2);
    waste::setDebugEnabled(false);
}

}  // namespace

TN_TEST_MAIN({"debug_reasons_follow_gate", debugReasonsFollowGate},
             {"late_signal_draws_every_frame", lateSignalDrawsEveryFrame},
             {"steady_late_signal_draws_every_frame", steadyLateSignalDrawsEveryFrame},
             {"growing_backlog_is_declined", growingBacklogIsDeclined},
             {"gpu_behind_is_declined", gpuBehindIsDeclined},
             {"unthrottled_loop_stays_bounded", unthrottledLoopStaysBounded})
