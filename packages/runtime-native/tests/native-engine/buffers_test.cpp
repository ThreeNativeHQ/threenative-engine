#include "check.h"
#include "engine/foundation/buffers.h"

#include <cstdint>
#include <limits>

using namespace tn::engine;

namespace {

constexpr uint64_t kMax = std::numeric_limits<uint64_t>::max();

void range() {
    BufferStore store(Scalar::F32, 16);  // 64 bytes
    float value = 1.5f;
    CHECK(store.validate(0, 64) == BufferError::None);
    CHECK(store.validate(60, 4) == BufferError::None);
    CHECK(store.validate(64, 0) == BufferError::None);
    CHECK(store.validate(64, 4) == BufferError::Range);
    CHECK(store.validate(65, 0) == BufferError::Range);
    CHECK(store.validate(4, kMax - 2) == BufferError::Range);    // offset + length wraps
    CHECK(store.validate(kMax, 8) == BufferError::Range);
    CHECK(store.validate(2, 4) == BufferError::Layout);          // misaligned for f32
    CHECK(store.validate(0, 64, 6) == BufferError::Layout);
    CHECK(store.write(62, &value, 4) == BufferError::Range);
    CHECK(store.read(kMax - 3, &value, 4) == BufferError::Range);
    CHECK(store.write(8, &value, 4) == BufferError::None);
    float back = 0;
    CHECK(store.read(8, &back, 4) == BufferError::None);
    CHECK(back == 1.5f);
    CHECK(BufferStore(Scalar::F64, kMax / 4).byteLength() == 0);  // an overflowing count is empty, not wrapped

    // Found by the instrumented fuzzer: resizing to or from empty storage must not hand memcpy null.
    BufferStore empty(Scalar::F32, 0);
    CHECK(empty.resize(4));
    CHECK(empty.resize(0));
    CHECK(empty.byteLength() == 0);
}

void lease() {
    BufferStore store(Scalar::U32, 4);
    const uint32_t first = 7;
    CHECK(store.write(0, &first, 4) == BufferError::None);
    std::byte* pinned = store.data();
    store.acquireLease();
    CHECK(!store.resize(1024));
    CHECK(store.data() == pinned);    // the storage under a live lease does not move
    CHECK(store.count() == 4);
    store.releaseLease();
    CHECK(store.count() == 1024);     // the resize applies after the last release
    uint32_t back = 0;
    CHECK(store.read(0, &back, 4) == BufferError::None);
    CHECK(back == 7);

    // BufferAttribute: needsUpdate bumps the version; update ranges accumulate until cleared.
    CHECK(store.version() == 0);
    store.needsUpdate();
    store.needsUpdate();
    CHECK(store.version() == 2);
    store.addUpdateRange(0, 3);
    store.addUpdateRange(10, 2);
    CHECK(store.updateRanges().size() == 2);
    CHECK(store.updateRanges()[1].start == 10 && store.updateRanges()[1].count == 2);
    store.clearUpdateRanges();
    CHECK(store.updateRanges().empty());
}

void views() {
    // A Matrix4's `.elements`: 16 binary64 values, one storage, no copy.
    BufferStore elements(Scalar::F64, 16);
    BufferView retained(elements);
    const double written = 42.25;
    CHECK(elements.write(5 * 8, &written, 8) == BufferError::None);
    const auto* seen = reinterpret_cast<const double*>(retained.bytes().data());
    CHECK(seen[5] == 42.25);
    CHECK(retained.bytes().data() == elements.data());
}

void viewRegrowth() {
    BufferStore store(Scalar::F32, 4);
    BufferView view(store);
    const float marker = 3.0f;
    CHECK(store.write(4, &marker, 4) == BufferError::None);
    std::span<std::byte> before = view.bytes();
    CHECK(!view.stale());
    CHECK(store.resize(1 << 16));     // memory growth: the storage moves
    CHECK(view.stale());              // the old span is known dead; ASan would flag a read of it
    std::span<std::byte> after = view.bytes();
    CHECK(!view.stale());
    CHECK(after.size() == (1u << 16) * 4);
    CHECK(reinterpret_cast<const float*>(after.data())[1] == 3.0f);
    (void)before;
}

// A JS mirror of an attribute copies the bytes again only when this count moved: a write, a
// mutable data() or a resize moves it, a read does not.
void writes() {
    BufferStore store(Scalar::F32, 4);
    const BufferStore& readOnly = store;
    const uint64_t start = store.writes();
    float value = 2;
    CHECK(store.read(0, &value, 4) == BufferError::None);
    CHECK(readOnly.data() != nullptr);
    CHECK(store.writes() == start);
    CHECK(store.write(0, &value, 4) == BufferError::None);
    CHECK(store.writes() == start + 1);
    CHECK(store.data() != nullptr);
    CHECK(store.writes() == start + 2);
    CHECK(store.resize(8));
    CHECK(store.writes() > start + 2);
}

}  // namespace

TN_TEST_MAIN({"range", range}, {"lease", lease}, {"views", views}, {"view_regrowth", viewRegrowth}, {"writes", writes})
