#include "check.h"
#include "engine/player/run.h"

#include <chrono>
#include <thread>

namespace player = tn::engine::player;

// frameTiming emits the thread CPU fields only when the clock produced a value, and always the tick pair.
void frameTimingFields() {
    const auto bare = player::frameTiming(0.5, 0.6, 1.1, 28.5, 42, 61, 1);
    CHECK(bare.find("tick")->number() == 61 && bare.find("updates")->number() == 1);
    CHECK(bare.find("gameJsCpuMs") == nullptr && bare.find("cpuFrameCpuMs") == nullptr);
    const auto timed = player::frameTiming(0.5, 0.6, 1.1, 28.5, 42, 61, 1, 0.4, 0.9);
    CHECK(timed.find("gameJsCpuMs")->number() == 0.4);
    CHECK(timed.find("cpuFrameCpuMs")->number() == 0.9);
    CHECK(timed.find("presentCpuMs") == nullptr);  // the swap call's CPU is its own field, and only when measured
    const auto swapped = player::frameTiming(0.5, 0.6, 1.1, 28.5, 42, 61, 1, 0.4, 0.9, 3.25);
    CHECK(swapped.find("presentCpuMs")->number() == 3.25);
    CHECK(swapped.find("renderCpuMs") == nullptr);  // the database render's CPU is its own field too, only when measured
    const auto rendered = player::frameTiming(0.5, 0.6, 1.1, 28.5, 42, 61, 1, 0.4, 0.9, 3.25, 1.75);
    CHECK(rendered.find("renderCpuMs")->number() == 1.75);
}

// Thread CPU time counts a busy loop and not a sleep: the property that makes it load-proof.
void threadCpuIgnoresSleep() {
#if defined(__linux__)
    const double begin = player::threadCpuMs();
    CHECK(begin >= 0);
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
    CHECK(player::threadCpuMs() - begin < 20);
    volatile double sink = 0;
    for (int i = 0; i < 20000000; ++i) sink = sink + i;
    CHECK(player::threadCpuMs() - begin > 1);
#else
    CHECK(player::threadCpuMs() == -1);
#endif
}

// performance.now's clock moves between calls (no tick needed) and never runs backwards.
void wallClockMoves() {
    const double a = player::wallMs();
    double b = a;
    for (int spin = 0; spin < 1000000 && b <= a; ++spin) b = player::wallMs();
    CHECK(b > a && a >= 0 && player::gameSpan(-2, 0) >= b);
}

TN_TEST_MAIN({"frame_timing_fields", frameTimingFields}, {"thread_cpu_ignores_sleep", threadCpuIgnoresSleep},
             {"wall_clock_moves", wallClockMoves})
