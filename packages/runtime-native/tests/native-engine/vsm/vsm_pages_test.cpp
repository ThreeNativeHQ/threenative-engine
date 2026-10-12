// PRD-524 phase 1: the virtual-shadow page logic reproduces over the native port. The table is
// generated from packages/core/src/render/virtual-shadow-pages.ts
// (packages/runtime-native/tests/native-engine/vsm/vsm-reference.ts): a camera walking over a
// clipmap with a recorded receiver-demand feedback buffer per frame, and casters whose bounds move
// across pages. Every double is stored as its binary64 bit pattern and compares bit for bit, except
// that any two NaNs are equal.
#include "check.h"
#include "engine/renderer/shadows/virtual/pages.h"

#include <bit>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <iterator>
#include <set>
#include <string>
#include <vector>

using namespace tn::engine;
using namespace tn::engine::shadows;

namespace {

#include "vsm_reference.inc"

constexpr double fromBits(uint64_t bits) { return std::bit_cast<double>(bits); }

// Bit-exact, except that every NaN is the same value: the reference is JavaScript, whose NaN
// payloads are not distinguishable (and x86 sets the sign bit on an arithmetic NaN, ARM does not).
bool sameDouble(double got, double want) {
    return std::bit_cast<uint64_t>(got) == std::bit_cast<uint64_t>(want) || (std::isnan(got) && std::isnan(want));
}

Vector3 vectorFromBits(uint64_t x, uint64_t y, uint64_t z) { return {fromBits(x), fromBits(y), fromBits(z)}; }

Box3 boxFromBits(uint64_t minX, uint64_t minY, uint64_t minZ, uint64_t maxX, uint64_t maxY, uint64_t maxZ) {
    Box3 box;
    box.min = vectorFromBits(minX, minY, minZ);
    box.max = vectorFromBits(maxX, maxY, maxZ);
    return box;
}

Box3 boxFromRef(const RefBounds& ref) {
    return boxFromBits(ref.minX, ref.minY, ref.minZ, ref.maxX, ref.maxY, ref.maxZ);
}

std::optional<DirectionalClipmap> referenceClipmap(std::string& error) {
    DirectionalClipmapOptions options;
    options.direction = vectorFromBits(kPagesDirection[0], kPagesDirection[1], kPagesDirection[2]);
    for (const uint64_t extent : kPagesExtents)
        options.clipExtents.push_back(fromBits(extent));
    options.pagesPerAxis = kPagesPerAxis;
    options.selectionGuard = {fromBits(kPagesGuards[0])};
    options.refreshStep = {fromBits(kPagesSteps[0])};
    return DirectionalClipmap::create(options, error);
}

void checkKeyCases(std::size_t& mismatched) {
    for (const RefKeyCase& want : kPageKeyCases) {
        PageAddress address;
        const bool got = parsePageKey(want.key, address);
        const bool ok = got == want.valid &&
                        (!want.valid || (address.level == want.level && address.x == want.x && address.y == want.y));
        if (!ok) {
            ++mismatched;
            std::fprintf(stderr, "key %s: got valid %d\n", want.key, got);
        }
    }
}

void vsmPages() {
    std::string error;
    std::optional<DirectionalClipmap> clipmap = referenceClipmap(error);
    std::optional<PhysicalPagePool> pool = PhysicalPagePool::create(kPagesCapacity, error);
    std::optional<ReceiverDemandPass> pass = ReceiverDemandPass::create(kPagesGuardBand, error);
    if (!clipmap || !pool || !pass) {
        std::fprintf(stderr, "setup refused: %s\n", error.c_str());
        CHECK(false);
        return;
    }

    std::size_t mismatched = 0;
    const std::size_t frames = std::size(kPagesFrames);
    for (std::size_t frameIndex = 0; frameIndex < frames; ++frameIndex) {
        const RefPagesFrame& frame = kPagesFrames[frameIndex];
        const Vector3 camera = vectorFromBits(frame.cameraX, frame.cameraY, frame.cameraZ);
        clipmap->updateCenter(camera);

        ReceiverDemandInput input;
        input.cameraPosition = camera;
        for (std::size_t i = 0; i < frame.receiverCount; ++i)
            input.receiverPoints.push_back(
                vectorFromBits(frame.receiverPoints[i].x, frame.receiverPoints[i].y, frame.receiverPoints[i].z));
        for (std::size_t i = 0; i < frame.visibleBoundCount; ++i)
            input.visibleBounds.push_back(boxFromRef(frame.visibleBounds[i]));

        const std::vector<PageRequest> requests = pass->collect(input, *clipmap);
        bool frameOk = requests.size() == frame.requestCount;
        if (!frameOk)
            std::fprintf(stderr, "frame %zu: got %zu requests, want %zu\n", frameIndex, requests.size(),
                         frame.requestCount);
        for (std::size_t i = 0; frameOk && i < requests.size(); ++i) {
            const RefRequest& want = frame.requests[i];
            const PageRequest& got = requests[i];
            if (got.address.key != want.key || got.address.level != want.level || got.address.x != want.x ||
                got.address.y != want.y || got.pinned != want.pinned ||
                !sameDouble(got.priority, fromBits(want.priority))) {
                frameOk = false;
                std::fprintf(stderr, "frame %zu request %zu: got %s (%d,%d,%d) pinned %d pri %.17g\n", frameIndex, i,
                             got.address.key.c_str(), got.address.level, got.address.x, got.address.y, got.pinned,
                             got.priority);
                std::fprintf(stderr, "                        want %s (%d,%d,%d) pinned %d pri %.17g\n", want.key,
                             want.level, want.x, want.y, want.pinned, fromBits(want.priority));
            }
        }

        std::set<std::string> protectedKeys;
        for (const PageRequest& request : requests)
            protectedKeys.insert(request.address.key);

        for (std::size_t i = 0; frameOk && i < requests.size(); ++i) {
            const RefAllocation& want = frame.allocations[i];
            const std::optional<PhysicalPageAllocation> allocation =
                pool->allocate(requests[i].address.key, fromBits(frame.frame), requests[i].pinned, protectedKeys);
            if (allocation.has_value() == want.overflow) {
                frameOk = false;
                std::fprintf(stderr, "frame %zu allocation %zu: overflow got %d want %d\n", frameIndex, i,
                             !allocation.has_value(), want.overflow);
                continue;
            }
            if (!allocation.has_value())
                continue;
            const PhysicalPageAllocation& got = *allocation;
            const std::string evicted = got.hasEvicted ? got.evictedKey : std::string();
            const std::string wantEvicted = want.hasEvicted ? std::string(want.evictedKey) : std::string();
            if (got.reused != want.reused || got.entry.slot != want.slot || got.hasEvicted != want.hasEvicted ||
                evicted != wantEvicted) {
                frameOk = false;
                std::fprintf(stderr, "frame %zu allocation %zu: got reused %d slot %d evicted %s\n", frameIndex, i,
                             got.reused, got.entry.slot, evicted.c_str());
                std::fprintf(stderr, "                        want reused %d slot %d evicted %s\n", want.reused,
                             want.slot, wantEvicted.c_str());
            }
        }

        const std::vector<PhysicalPageEntry> entries = pool->entries();
        if (entries.size() != frame.poolEntryCount) {
            frameOk = false;
            std::fprintf(stderr, "frame %zu pool: got %zu entries, want %zu\n", frameIndex, entries.size(),
                         frame.poolEntryCount);
        }
        for (std::size_t i = 0; frameOk && i < entries.size(); ++i) {
            const RefPoolEntry& want = frame.poolEntries[i];
            const PhysicalPageEntry& got = entries[i];
            if (got.key != want.key || got.slot != want.slot || got.pinned != want.pinned || got.dirty != want.dirty ||
                got.generation != want.generation || !sameDouble(got.lastUsedFrame, fromBits(want.lastUsedFrame))) {
                frameOk = false;
                std::fprintf(stderr,
                             "frame %zu pool entry %zu: got %s slot %d pinned %d dirty %d gen %llu used %.17g\n",
                             frameIndex, i, got.key.c_str(), got.slot, got.pinned, got.dirty,
                             static_cast<unsigned long long>(got.generation), got.lastUsedFrame);
                std::fprintf(stderr, "                        want %s slot %d pinned %d dirty %d gen %llu used %.17g\n",
                             want.key, want.slot, want.pinned, want.dirty,
                             static_cast<unsigned long long>(want.generation), fromBits(want.lastUsedFrame));
            }
        }
        if (pool->evictions() != frame.evictions || pool->overflow() != frame.overflow ||
            pool->size() != frame.poolSize) {
            frameOk = false;
            std::fprintf(stderr, "frame %zu pool counters: got evictions %u overflow %u size %zu\n", frameIndex,
                         pool->evictions(), pool->overflow(), pool->size());
        }
        if (!frameOk)
            ++mismatched;
    }

    checkKeyCases(mismatched);
    std::printf("vsm pages: %zu frames, %zu differ\n", frames, mismatched);
    CHECK(frames > 0 && mismatched == 0);
}

void vsmInvalidation() {
    std::string error;
    std::optional<DirectionalClipmap> clipmap = referenceClipmap(error);
    if (!clipmap) {
        std::fprintf(stderr, "setup refused: %s\n", error.c_str());
        CHECK(false);
        return;
    }
    ShadowInvalidationTracker tracker(*clipmap);

    std::size_t mismatched = 0;
    const std::size_t moves = std::size(kInvMoves);
    for (std::size_t i = 0; i < moves; ++i) {
        const RefInvMove& want = kInvMoves[i];
        const bool changed = want.op == 1 ? tracker.remove(want.id) : tracker.update(want.id, boxFromRef(want.bounds));
        const std::vector<std::string> keys = tracker.consumeInvalidatedKeys();
        bool moveOk = changed == want.changed && keys.size() == want.invalidatedCount &&
                      tracker.trackedCount() == want.trackedCount;
        if (keys.size() == want.invalidatedCount) {
            for (std::size_t keyIndex = 0; moveOk && keyIndex < keys.size(); ++keyIndex) {
                if (keys[keyIndex] != want.invalidated[keyIndex])
                    moveOk = false;
            }
        }
        if (!moveOk) {
            ++mismatched;
            std::fprintf(stderr, "move %zu (%s): got changed %d tracked %zu, keys:", i, want.id, changed,
                         tracker.trackedCount());
            for (const std::string& key : keys)
                std::fprintf(stderr, " %s", key.c_str());
            std::fprintf(stderr, "\n                want changed %d tracked %u, keys:", want.changed,
                         want.trackedCount);
            for (std::size_t keyIndex = 0; keyIndex < want.invalidatedCount; ++keyIndex)
                std::fprintf(stderr, " %s", want.invalidated[keyIndex]);
            std::fprintf(stderr, "\n");
        }
    }

    for (const RefProjectBounds& want : kProjectBoundsCases) {
        const ProjectedRange got =
            projectBounds(boxFromRef(want.bounds), vectorFromBits(want.axisX, want.axisY, want.axisZ));
        if (!sameDouble(got.low, fromBits(want.range.low)) || !sameDouble(got.high, fromBits(want.range.high))) {
            ++mismatched;
            std::fprintf(stderr, "projectBounds: got %.17g..%.17g want %.17g..%.17g\n", got.low, got.high,
                         fromBits(want.range.low), fromBits(want.range.high));
        }
    }

    std::printf("vsm invalidation: %zu moves, %zu differ\n", moves, mismatched);
    CHECK(moves > 0 && mismatched == 0);
}

} // namespace

TN_TEST_MAIN({"pages", vsmPages}, {"invalidation", vsmInvalidation})
