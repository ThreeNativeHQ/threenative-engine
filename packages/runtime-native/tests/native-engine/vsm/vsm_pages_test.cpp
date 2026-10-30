// PRD-524 phase 1: the virtual-shadow page logic reproduces over the native port. The table is
// generated from packages/core/src/render/virtual-shadow-pages.ts
// (packages/runtime-native/tests/native-engine/vsm/vsm-reference.ts): a camera walking over a
// clipmap with a recorded receiver-demand feedback buffer per frame, and casters whose bounds move
// across pages. Every double is stored as its binary64 bit pattern and compares bit for bit, except
// that any two NaNs are equal.
#include "check.h"
#include "engine/renderer/shadows/virtual/pages.h"
#include "engine/foundation/waste_counters.h"

#include <bit>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <iterator>
#include <new>
#include <string>
#include <unordered_set>
#include <vector>

using namespace tn::engine;
using namespace tn::engine::shadows;

namespace {
bool trackAllocation = false;
std::size_t largestAllocation = 0;
}

void* operator new(std::size_t bytes) {
    if (trackAllocation && bytes > largestAllocation) largestAllocation = bytes;
    if (void* memory = std::malloc(bytes ? bytes : 1)) return memory;
    throw std::bad_alloc();
}
void operator delete(void* memory) noexcept { std::free(memory); }
void operator delete(void* memory, std::size_t) noexcept { std::free(memory); }

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

        std::unordered_set<uint64_t> protectedIds;
        for (const PageRequest& request : requests)
            protectedIds.insert(pageId(request.address.level, request.address.x, request.address.y));

        for (std::size_t i = 0; frameOk && i < requests.size(); ++i) {
            const RefAllocation& want = frame.allocations[i];
            const std::optional<PhysicalPageAllocation> allocation =
                pool->allocate(pageId(requests[i].address.level, requests[i].address.x, requests[i].address.y),
                               fromBits(frame.frame), requests[i].pinned, protectedIds);
            if (allocation.has_value() == want.overflow) {
                frameOk = false;
                std::fprintf(stderr, "frame %zu allocation %zu: overflow got %d want %d\n", frameIndex, i,
                             !allocation.has_value(), want.overflow);
                continue;
            }
            if (!allocation.has_value())
                continue;
            const PhysicalPageAllocation& got = *allocation;
            // The identity is numeric; the reference's keys are formatted, so the comparison reads one back.
            const std::string evicted = got.hasEvicted ? pageKeyOf(got.evictedId) : std::string();
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
            const std::string key = pageKeyOf(got.id);
            if (key != want.key || got.slot != want.slot || got.pinned != want.pinned || got.dirty != want.dirty ||
                got.generation != want.generation || !sameDouble(got.lastUsedFrame, fromBits(want.lastUsedFrame))) {
                frameOk = false;
                std::fprintf(stderr,
                             "frame %zu pool entry %zu: got %s slot %d pinned %d dirty %d gen %llu used %.17g\n",
                             frameIndex, i, key.c_str(), got.slot, got.pinned, got.dirty,
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
    // A page's numeric identity and its key name the same page, signs and the packing's edges included.
    for (const PageAddress& address : {PageAddress{0, 0, 0, {}}, PageAddress{3, -kPageAxisLimit, kPageAxisLimit, {}},
                                       PageAddress{2, -7, -9, {}}})
        CHECK(pageKeyOf(pageId(address.level, address.x, address.y)) ==
              makePageKey(address.level, address.x, address.y));
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

void evictionAllocation() {
    std::string error;
    constexpr int capacity = 128;
    auto pool = PhysicalPagePool::create(capacity, error);
    CHECK(pool.has_value());
    if (!pool) return;
    // Level 0's first 128 pages, by identity: a page is three integers, never a formatted key.
    const auto page = [](int x) { return pageId(0, x, 0); };
    for (int i = 0; i < capacity; ++i) CHECK(pool->allocate(page(i), 1).has_value());
    CHECK(pool->allocate(page(0), 1, true).has_value());
    const std::unordered_set<uint64_t> protectedIds{page(1)};
    largestAllocation = 0;
    trackAllocation = true;
    waste::setDebugEnabled(true);
    const uint64_t candidatesBefore = waste::counters().shadowPageEvictionCandidates.load();
    const auto allocation = pool->allocate(page(capacity), 2, false, protectedIds);
    const uint64_t candidates = waste::counters().shadowPageEvictionCandidates.load() - candidatesBefore;
    waste::setDebugEnabled(false);
    trackAllocation = false;
    CHECK(allocation && allocation->hasEvicted && allocation->evictedId == page(2) && allocation->entry.slot == 2);
    // FS12's F3 shape: one eviction judges at most the pool's capacity, so a scan that grew past it (or one per
    // page of a grant) fails here rather than showing up as frame time.
    std::printf("eviction largest allocation: %zu bytes, pool snapshot: %zu bytes, %llu candidate(s) for one eviction\n",
                largestAllocation, capacity * sizeof(PhysicalPageEntry), (unsigned long long)candidates);
    CHECK(candidates > 0 && candidates <= std::uint64_t(2 * capacity));
    CHECK(largestAllocation < capacity * sizeof(PhysicalPageEntry));
}

} // namespace

TN_TEST_MAIN({"pages", vsmPages}, {"invalidation", vsmInvalidation}, {"eviction_allocation", evictionAllocation})
