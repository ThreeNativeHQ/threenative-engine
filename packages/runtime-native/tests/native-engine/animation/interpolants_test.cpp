// PRD-516 phase 1: every interpolant reproduces the pinned three exactly. The table is generated
// from three's own keyframe tracks (packages/three-native/tests/animation/animation-reference.ts):
// each case evaluates the same sample sequence, seeking forward and back, past both ends and
// through NaN and the infinities, and every result must have three's float32 bits.
#include "check.h"
#include "engine/animation/interpolant.h"

#include <bit>
#include <cstdint>
#include <cstdio>
#include <iterator>
#include <memory>
#include <vector>

using namespace tn::engine::animation;

namespace {

struct InterpolantCase {
    const char* name;
    Interpolation kind;
    Ending endingStart, endingEnd;
    std::size_t valueSize;
    const uint32_t* times;
    std::size_t timeCount;
    const uint32_t* values;
    std::size_t valueCount;
    const uint32_t* results;
};

#include "interpolants_reference.inc"

// A track's Float32Array, as the doubles JavaScript reads out of it.
std::vector<double> floats(const uint32_t* bits, std::size_t count) {
    std::vector<double> out(count);
    for (std::size_t i = 0; i < count; ++i)
        out[i] = std::bit_cast<float>(bits[i]);
    return out;
}

void interpolants() {
    std::size_t compared = 0, mismatched = 0;
    for (const InterpolantCase& c : kCases) {
        const std::vector<double> times = floats(c.times, c.timeCount), values = floats(c.values, c.valueCount);
        Interpolant interpolant(c.kind, times, values, c.valueSize);
        interpolant.settings = std::make_shared<InterpolantSettings>(InterpolantSettings{c.endingStart, c.endingEnd});
        for (std::size_t s = 0; s < std::size(kSamples); ++s) {
            const double t = std::bit_cast<double>(kSamples[s]);
            const auto result = interpolant.evaluate(t);
            for (std::size_t i = 0; i < c.valueSize; ++i, ++compared) {
                const uint32_t got = std::bit_cast<uint32_t>(static_cast<float>(result[i])),
                               want = c.results[s * c.valueSize + i];
                if (got != want && mismatched++ < 8)
                    std::fprintf(stderr, "%s t=%.17g [%zu]: got 0x%08x, three has 0x%08x\n", c.name, t, i, got, want);
            }
        }
    }
    std::printf("interpolants: %zu cases, %zu values compared, %zu differ\n", std::size(kCases), compared, mismatched);
    CHECK(compared > 0 && mismatched == 0);
}

} // namespace

TN_TEST_MAIN({"interpolants", interpolants})
