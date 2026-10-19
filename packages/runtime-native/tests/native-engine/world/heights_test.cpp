// PRD-521 phase 3: every recorded height sample and heightfield update reproduces
// packages/core/src/world-heightmap.ts and packages/core/src/world.ts exactly. The table is
// generated from those modules (packages/runtime-native/tests/native-engine/world/
// heights-reference.ts): the sampler case replays ~200 points over a 33x17 heightmap and the
// heightfield case replays updateHeights calls, comparing the throw, the sample version and
// heightAt at fixed points after each call.
#include "check.h"
#include "engine/world/terrain/heights.h"

#include <bit>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <iterator>
#include <optional>
#include <string>
#include <vector>

using namespace tn::engine::world;

namespace {

struct HeightFieldStep {
    uint32_t column;
    uint32_t columns;
    uint32_t row;
    uint32_t rows;
    const uint64_t* region;
    std::size_t regionLength;
    bool threw;
    uint64_t version;
    const uint64_t* probes;
};

constexpr double bitsToDouble(uint64_t bits) { return std::bit_cast<double>(bits); }

// Bit-exact, except that every NaN is the same value: JavaScript cannot tell NaN payloads apart,
// and an arithmetic NaN's sign bit is the hardware's (x86 sets it, ARM does not).
bool same(uint64_t got, uint64_t want) {
    return got == want || (std::isnan(bitsToDouble(got)) && std::isnan(bitsToDouble(want)));
}

#include "heights_reference.inc"

std::vector<float> floatsFromBits(const uint64_t* samples, std::size_t count) {
    std::vector<float> values;
    values.reserve(count);
    for (std::size_t i = 0; i < count; ++i)
        values.push_back(static_cast<float>(bitsToDouble(samples[i])));
    return values;
}

void heights() {
    std::size_t compared = 0;
    std::size_t mismatched = 0;

    std::string error;
    const std::vector<uint16_t> data(kHeightSamplerData,
                                     kHeightSamplerData + kHeightSamplerColumns * kHeightSamplerRows);
    const std::optional<HeightSampler> sampler =
        HeightSampler::create(kHeightSamplerColumns, kHeightSamplerRows, bitsToDouble(kHeightSamplerSpacing),
                              bitsToDouble(kHeightSamplerHeightMin), bitsToDouble(kHeightSamplerHeightMax),
                              bitsToDouble(kHeightSamplerMinX), bitsToDouble(kHeightSamplerMinZ), data, error);
    if (!sampler) {
        ++mismatched;
        std::fprintf(stderr, "sampler refused: %s\n", error.c_str());
    } else {
        for (uint32_t i = 0; i < kHeightSamplerSamples; ++i) {
            const double x = bitsToDouble(kHeightSamplerPoints[i * 2]);
            const double z = bitsToDouble(kHeightSamplerPoints[i * 2 + 1]);
            const uint64_t got = std::bit_cast<uint64_t>(sampler->sample(x, z));
            if (!same(got, kHeightSamplerExpected[i])) {
                if (mismatched < 8)
                    std::fprintf(stderr, "sampler point %u (%.17g, %.17g): 0x%016llx/0x%016llx\n", i, x, z,
                                 (unsigned long long)got, (unsigned long long)kHeightSamplerExpected[i]);
                ++mismatched;
            }
            ++compared;
        }
    }

    const std::vector<float> initial = floatsFromBits(kHeightFieldInitial, kHeightFieldInitialCount);
    Heightfield field(kHeightFieldColumns, kHeightFieldRows, bitsToDouble(kHeightFieldWidth),
                      bitsToDouble(kHeightFieldDepth), bitsToDouble(kHeightFieldOriginX),
                      bitsToDouble(kHeightFieldOriginZ), initial);

    for (const HeightFieldStep& step : kHeightFieldSteps) {
        const std::vector<float> region = floatsFromBits(step.region, step.regionLength);
        std::string stepError;
        const HeightfieldRegion window{step.column, step.columns, step.row, step.rows, region};
        const bool ok = field.updateHeights(window, stepError);
        const bool threw = !ok;
        ++compared;
        if (threw != step.threw || field.version() != step.version) {
            ++mismatched;
            std::fprintf(stderr, "update step threw %d/%d version %llu/%llu (%s)\n", threw, step.threw,
                         (unsigned long long)field.version(), (unsigned long long)step.version, stepError.c_str());
        }
        for (uint32_t p = 0; p < kHeightFieldProbeCount; ++p) {
            const double x = bitsToDouble(kHeightFieldPoints[p * 2]);
            const double z = bitsToDouble(kHeightFieldPoints[p * 2 + 1]);
            double value = 0.0;
            std::string probeError;
            const bool inside = field.heightAt(x, z, value, probeError);
            const uint64_t got = inside ? std::bit_cast<uint64_t>(value) : 0ull;
            if (!inside || !same(got, step.probes[p])) {
                if (mismatched < 8)
                    std::fprintf(stderr, "probe (%.17g, %.17g): 0x%016llx/0x%016llx (%s)\n", x, z,
                                 (unsigned long long)got, (unsigned long long)step.probes[p], probeError.c_str());
                ++mismatched;
            }
            ++compared;
        }
    }

    std::printf("heights: %zu samples, %zu differ\n", compared, mismatched);
    CHECK(compared > 0 && mismatched == 0);
}

} // namespace

TN_TEST_MAIN({"heights", heights})
