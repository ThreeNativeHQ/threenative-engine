// PRD-525: every recorded ProbeVolume placement, atlas slot and bounded update schedule reproduces
// natively. The table is generated from packages/core/src/render/probe-volume.ts
// (packages/runtime-native/tests/native-engine/probes/probes-reference.ts): each volume description
// is replayed through `place` and `ProbeScheduler`, and the probe world positions, atlas slices, the
// per-frame work-item order and the per-frame budget are compared against what the real module
// produced. Every double is stored as its binary64 bit pattern and compares bit for bit, except that
// any two NaNs are equal.
//
// The reference reads time from an injected clock and the fake renderer's per-work-item costs; the
// native scheduler takes those costs as data, so both sides measure the same schedule exactly.
#include "check.h"
#include "engine/renderer/probes/schedule.h"

#include <bit>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <iterator>
#include <string>
#include <vector>

using namespace tn::engine::probes;

namespace {

constexpr double bitsToDouble(uint64_t bits) { return std::bit_cast<double>(bits); }

// Bit-exact, except that every NaN is the same value: JavaScript cannot tell NaN payloads apart.
bool same(uint64_t got, uint64_t want) {
    return got == want || (std::isnan(bitsToDouble(got)) && std::isnan(bitsToDouble(want)));
}

struct RefProbeWork;

struct RefProbePlacement {
    uint32_t resolution[3];
    uint32_t paddedSlices;
    uint32_t atlasDepth;
    uint64_t probeCount;
    uint64_t atlasBytes;
};

struct RefProbeCosts {
    uint64_t capture;
    uint64_t project;
    uint64_t copy;
    uint64_t repack;
};

struct RefProbeVolume {
    uint64_t min[3];
    uint64_t max[3];
    uint64_t density[3];
    bool hasLimit;
    uint64_t limit;
    uint64_t budget;
    uint32_t maxItems;
    uint32_t bounces;
    RefProbeCosts costs;
    RefProbePlacement placement;
    uint64_t boundsMin[3];
    uint64_t boundsSize[3];
    const uint64_t* positions;
    const uint32_t* slots;
    const RefProbeWork* work;
    std::size_t workCount;
    const uint32_t* frameCounts;
    std::size_t frameCount;
    uint32_t requestFrame;
    bool requestCoalesced;
};

#include "probes_reference.inc"

uint64_t costOf(const RefProbeVolume& volume, const ProbeWorkItem& item) {
    switch (item.kind) {
    case ProbeWorkKind::Capture:
        return volume.costs.capture;
    case ProbeWorkKind::Project:
        return volume.costs.project;
    case ProbeWorkKind::Copy:
        return volume.costs.copy;
    case ProbeWorkKind::Repack:
        return volume.costs.repack;
    }
    return 0;
}

uint64_t costOf(const RefProbeVolume& volume, const RefProbeWork& item) {
    switch (item.kind) {
    case 0:
        return volume.costs.capture;
    case 1:
        return volume.costs.project;
    case 2:
        return volume.costs.copy;
    case 3:
        return volume.costs.repack;
    }
    return 0;
}

bool buildDescription(const RefProbeVolume& volume, ProbeVolumeDescription& description) {
    for (int axis = 0; axis < 3; ++axis) {
        description.boundsMin[axis] = bitsToDouble(volume.min[axis]);
        description.boundsMax[axis] = bitsToDouble(volume.max[axis]);
        description.density[axis] = bitsToDouble(volume.density[axis]);
    }
    description.hasMaxTextureDimension3D = volume.hasLimit;
    description.maxTextureDimension3D = bitsToDouble(volume.limit);
    return true;
}

bool createScheduler(const RefProbeVolume& volume, const ProbePlacement& placement, ProbeScheduler& scheduler,
                     std::string& error) {
    ProbeScheduleOptions options;
    options.bakeBudgetMs = bitsToDouble(volume.budget);
    options.maxWorkItemsPerFrame = volume.maxItems;
    options.bounces = volume.bounces;
    options.costs.capture = bitsToDouble(volume.costs.capture);
    options.costs.project = bitsToDouble(volume.costs.project);
    options.costs.copy = bitsToDouble(volume.costs.copy);
    options.costs.repack = bitsToDouble(volume.costs.repack);
    return ProbeScheduler::create(placement, options, scheduler, error);
}

void probeSchedule() {
    std::size_t volumes = 0;
    std::size_t frames = 0;
    std::size_t mismatched = 0;

    for (const RefProbeVolume& volume : kProbeVolumes) {
        ++volumes;
        ProbeVolumeDescription description;
        buildDescription(volume, description);
        ProbePlacement placement;
        std::string error;
        if (!place(description, placement, error)) {
            ++mismatched;
            std::fprintf(stderr, "volume %zu: place refused: %s\n", volumes - 1, error.c_str());
            continue;
        }
        const RefProbePlacement& want = volume.placement;
        bool placementOk = placement.resolution[0] == want.resolution[0] &&
                           placement.resolution[1] == want.resolution[1] &&
                           placement.resolution[2] == want.resolution[2] &&
                           placement.paddedSlices == want.paddedSlices && placement.atlasDepth == want.atlasDepth &&
                           placement.probeCount == want.probeCount && placement.atlasBytes == want.atlasBytes;
        for (int axis = 0; axis < 3 && placementOk; ++axis) {
            placementOk = same(std::bit_cast<uint64_t>(placement.boundsMin[axis]), volume.boundsMin[axis]) &&
                          same(std::bit_cast<uint64_t>(placement.boundsSize[axis]), volume.boundsSize[axis]);
        }
        if (!placementOk) {
            ++mismatched;
            std::fprintf(stderr, "volume %zu: placement differs\n", volumes - 1);
            continue;
        }
        // Every probe world position the reference placed.
        for (uint64_t probe = 0; probe < placement.probeCount; ++probe) {
            const uint32_t ix = static_cast<uint32_t>(probe % placement.resolution[0]);
            const uint32_t iy = static_cast<uint32_t>((probe / placement.resolution[0]) % placement.resolution[1]);
            const uint32_t iz = static_cast<uint32_t>(
                probe / (static_cast<uint64_t>(placement.resolution[0]) * placement.resolution[1]));
            double position[3];
            probePosition(placement, ix, iy, iz, position);
            for (int axis = 0; axis < 3; ++axis) {
                if (!same(std::bit_cast<uint64_t>(position[axis]), volume.positions[probe * 3 + axis])) {
                    if (mismatched < 8)
                        std::fprintf(stderr, "volume %zu probe %llu axis %d position differs\n", volumes - 1,
                                     static_cast<unsigned long long>(probe), axis);
                    ++mismatched;
                }
            }
        }
        // The atlas slice each probe writes into each of the seven packed sub-volumes.
        for (uint32_t subVolume = 0; subVolume < kPackedSubVolumeCount; ++subVolume) {
            for (uint32_t iz = 0; iz < placement.resolution[2]; ++iz) {
                const uint32_t got = atlasSlice(placement, subVolume, iz);
                const uint32_t expected = volume.slots[subVolume * placement.resolution[2] + iz];
                if (got != expected) {
                    ++mismatched;
                    std::fprintf(stderr, "volume %zu atlas slice %u/%u: %u/%u\n", volumes - 1, subVolume, iz, got,
                                 expected);
                }
            }
        }

        ProbeScheduler scheduler;
        if (!createScheduler(volume, placement, scheduler, error)) {
            ++mismatched;
            std::fprintf(stderr, "volume %zu: scheduler refused: %s\n", volumes - 1, error.c_str());
            continue;
        }
        if (!scheduler.requestBake()) {
            ++mismatched;
            std::fprintf(stderr, "volume %zu: first requestBake did not start\n", volumes - 1);
            continue;
        }

        // The recorded frame slice must match item for item, and the mid-run request must coalesce.
        double clock = 0;
        std::size_t offset = 0;
        std::vector<ProbeWorkItem> items;
        for (std::size_t frame = 0; frame < volume.frameCount; ++frame) {
            ++frames;
            if (frame == volume.requestFrame) {
                const bool restarted = scheduler.requestBake();
                if (restarted == volume.requestCoalesced) {
                    ++mismatched;
                    std::fprintf(stderr, "volume %zu frame %zu: requestBake restarted=%d expected coalesced=%d\n",
                                 volumes - 1, frame, restarted, volume.requestCoalesced);
                }
            }
            items.clear();
            scheduler.process(clock, items);
            if (items.size() != volume.frameCounts[frame]) {
                ++mismatched;
                std::fprintf(stderr, "volume %zu frame %zu: %zu items, expected %u\n", volumes - 1, frame, items.size(),
                             volume.frameCounts[frame]);
            }
            for (std::size_t k = 0; k < items.size() && offset + k < volume.workCount; ++k) {
                const ProbeWorkItem& got = items[k];
                const RefProbeWork& expected = volume.work[offset + k];
                const bool ok = static_cast<uint32_t>(got.kind) == expected.kind && got.pass == expected.pass &&
                                got.probe == expected.probe && got.face == expected.face &&
                                got.repack == expected.repack;
                if (!ok) {
                    if (mismatched < 8)
                        std::fprintf(stderr, "volume %zu frame %zu item %zu: {%u %u %u %u %u} != {%u %u %u %u %u}\n",
                                     volumes - 1, frame, k, static_cast<uint32_t>(got.kind), got.pass, got.probe,
                                     got.face, got.repack, expected.kind, expected.pass, expected.probe, expected.face,
                                     expected.repack);
                    ++mismatched;
                }
            }
            offset += items.size();
        }
    }

    // The refusals the real module throws on must come back as the same named codes.
    for (const RefProbeRefusal& refusal : kProbeRefusals) {
        ProbeVolumeDescription description;
        for (int axis = 0; axis < 3; ++axis) {
            description.boundsMin[axis] = bitsToDouble(refusal.min[axis]);
            description.boundsMax[axis] = bitsToDouble(refusal.max[axis]);
            description.density[axis] = bitsToDouble(refusal.density[axis]);
        }
        description.hasMaxTextureDimension3D = refusal.hasLimit;
        description.maxTextureDimension3D = bitsToDouble(refusal.limit);
        ProbePlacement placement;
        std::string error;
        const bool placed = place(description, placement, error);
        if (refusal.stage == RefProbeRefusePlace) {
            if (placed || error != refusal.code) {
                ++mismatched;
                std::fprintf(stderr, "refusal: placed=%d code=%s expected %s\n", placed, error.c_str(), refusal.code);
            }
            continue;
        }
        if (!placed) {
            ++mismatched;
            std::fprintf(stderr, "refusal: valid placement refused %s\n", error.c_str());
            continue;
        }
        ProbeScheduleOptions options;
        options.bakeBudgetMs = bitsToDouble(refusal.budget);
        options.maxWorkItemsPerFrame = refusal.maxItems;
        options.bounces = refusal.bounces;
        ProbeScheduler scheduler;
        const bool created = ProbeScheduler::create(placement, options, scheduler, error);
        if (created || error != refusal.code) {
            ++mismatched;
            std::fprintf(stderr, "refusal: created=%d code=%s expected %s\n", created, error.c_str(), refusal.code);
        }
    }

    std::printf("probes schedule: %zu volumes, %zu frames, %zu differ\n", volumes, frames, mismatched);
    CHECK(volumes > 0 && frames > 0 && mismatched == 0);
}

void probeBudget() {
    std::size_t volumes = 0;
    std::size_t frames = 0;
    std::size_t mismatched = 0;

    for (const RefProbeVolume& volume : kProbeVolumes) {
        ++volumes;
        ProbeVolumeDescription description;
        buildDescription(volume, description);
        ProbePlacement placement;
        std::string error;
        if (!place(description, placement, error)) {
            ++mismatched;
            continue;
        }
        ProbeScheduler scheduler;
        if (!createScheduler(volume, placement, scheduler, error) || !scheduler.requestBake()) {
            ++mismatched;
            continue;
        }
        const double budget = bitsToDouble(volume.budget);
        double clock = 0;
        std::size_t offset = 0;
        std::vector<ProbeWorkItem> items;
        for (std::size_t frame = 0; frame < volume.frameCount; ++frame) {
            ++frames;
            items.clear();
            scheduler.process(clock, items);
            // Native: never more work items than the count budget, and never more measured cost than
            // the time budget.
            if (items.size() > volume.maxItems) {
                ++mismatched;
                std::fprintf(stderr, "volume %zu frame %zu: %zu items exceed maxItems %u\n", volumes - 1, frame,
                             items.size(), volume.maxItems);
            }
            double nativeCost = 0;
            for (const ProbeWorkItem& item : items)
                nativeCost += bitsToDouble(costOf(volume, item));
            if (nativeCost > budget) {
                ++mismatched;
                std::fprintf(stderr, "volume %zu frame %zu: native cost %.17g exceeds budget %.17g\n", volumes - 1,
                             frame, nativeCost, budget);
            }
            // The recorded reference table must obey the same budget.
            if (volume.frameCounts[frame] > volume.maxItems) {
                ++mismatched;
                std::fprintf(stderr, "volume %zu frame %zu: table %u items exceed maxItems %u\n", volumes - 1, frame,
                             volume.frameCounts[frame], volume.maxItems);
            }
            double tableCost = 0;
            for (uint32_t k = 0; k < volume.frameCounts[frame] && offset + k < volume.workCount; ++k)
                tableCost += bitsToDouble(costOf(volume, volume.work[offset + k]));
            if (tableCost > budget) {
                ++mismatched;
                std::fprintf(stderr, "volume %zu frame %zu: table cost %.17g exceeds budget %.17g\n", volumes - 1,
                             frame, tableCost, budget);
            }
            offset += volume.frameCounts[frame];
        }
    }

    std::printf("probes budget: %zu volumes, %zu frames, %zu differ\n", volumes, frames, mismatched);
    CHECK(volumes > 0 && frames > 0 && mismatched == 0);
}

} // namespace

TN_TEST_MAIN({"schedule", probeSchedule}, {"budget", probeBudget})
