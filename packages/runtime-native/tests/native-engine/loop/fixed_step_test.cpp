// PRD-528 phase 1: every recorded run reproduces loop.ts's fixed-step answers exactly. The table
// is generated from `FixedStepLoop` itself (packages/runtime-native/tests/native-engine/loop/
// loop-reference.ts): each case drives the same frame times and compares the per-frame update
// count, tick and interpolation alpha bits. The held and frozen branches are out of scope.
#include "check.h"
#include "engine/world/loop/fixed_step.h"

#include <bit>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <iterator>
#include <limits>

using namespace tn::engine::world;

namespace {

struct LoopCase {
    const char* name;
    uint64_t stepBits;
    uint32_t maxSteps;
    const uint64_t* times;
    const uint64_t* updates;
    const uint64_t* ticks;
    const uint64_t* alphas;
    std::size_t frameCount;
};

#include "loop_reference.inc"

void fixed_step() {
    std::size_t compared = 0, mismatched = 0;
    for (const LoopCase& c : kCases) {
        FixedStepClock clock(std::bit_cast<double>(c.stepBits), c.maxSteps);
        clock.start(std::bit_cast<double>(c.times[0]));
        for (std::size_t i = 0; i < c.frameCount; ++i) {
            const double now = std::bit_cast<double>(c.times[i]);
            const uint32_t updates = clock.advance(now);
            const uint64_t tick = clock.tick();
            const double observedAlpha = clock.interpolationAlpha();
            CHECK(std::isfinite(observedAlpha));
            CHECK(std::isfinite(std::bit_cast<double>(c.alphas[i])));
            const uint64_t alpha = std::bit_cast<uint64_t>(observedAlpha);
            if (updates != c.updates[i] || tick != c.ticks[i] || alpha != c.alphas[i]) {
                if (mismatched++ < 8)
                    std::fprintf(
                        stderr, "%s frame %zu t=%.17g: updates %u/%llu tick %llu/%llu alpha 0x%016llx/0x%016llx\n",
                        c.name, i, now, updates, (unsigned long long)c.updates[i], (unsigned long long)tick,
                        (unsigned long long)c.ticks[i], (unsigned long long)alpha, (unsigned long long)c.alphas[i]);
            }
            ++compared;
        }
    }
    std::printf("fixed step: %zu cases, %zu frames, %zu differ\n", std::size(kCases), compared, mismatched);
    CHECK(compared > 0 && mismatched == 0);

    FixedStepClock clock(1.0 / 60, 5);
    clock.start(0);
    clock.advance(std::numeric_limits<double>::quiet_NaN());
    CHECK(std::isnan(clock.interpolationAlpha()));
}

} // namespace

TN_TEST_MAIN({"fixed_step", fixed_step})
