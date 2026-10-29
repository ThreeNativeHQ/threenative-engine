#include "check.h"
#include "engine/foundation/waste_counters.h"
#include "engine/renderer/frame_gate.h"

#include <cstdint>

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
             {"gpu_behind_is_declined", gpuBehindIsDeclined},
             {"unthrottled_loop_stays_bounded", unthrottledLoopStaysBounded})
