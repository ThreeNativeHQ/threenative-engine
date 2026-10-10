#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <span>
#include <vector>

namespace tn::engine {

enum class Scalar : uint8_t { F32, F64, I8, U8, I16, U16, I32, U32 };

uint32_t scalarSize(Scalar scalar);

enum class BufferError : uint8_t {
    None,
    Range,   // TN_BUFFER_RANGE: offset + length past the end, or an overflowing pair
    Layout,  // stride or alignment that does not fit the scalar type
};

/** Three's `BufferAttribute.updateRanges` entry, in elements. */
struct UpdateRange {
    uint64_t start;
    uint64_t count;
};

/**
 * One attribute's native storage (PRD-504). Every access is range-checked with overflow-safe
 * arithmetic before it touches memory. A lease pins the storage: a resize requested under a lease
 * waits for the last release, so a view or GPU job never reads memory that moved under it.
 */
class BufferStore : public std::enable_shared_from_this<BufferStore> {
public:
    BufferStore(Scalar scalar, uint64_t count);

    /** Accepts a byte window and element stride only if both fit the storage and the scalar type. */
    BufferError validate(uint64_t byteOffset, uint64_t byteLength, uint64_t byteStride = 0) const;
    BufferError write(uint64_t byteOffset, const void* source, uint64_t byteLength);
    BufferError read(uint64_t byteOffset, void* destination, uint64_t byteLength) const;

    /** Deferred while leased; returns true when it applied now. Contents up to the new size survive. */
    bool resize(uint64_t count);
    void acquireLease() { ++leases_; }
    void releaseLease();
    uint32_t leaseCount() const { return leases_; }

    // BufferAttribute semantics, as three@0.185.1 records them.
    void needsUpdate() { ++version_; }
    uint32_t version() const { return version_; }
    /** three's `geometry.dispose()`: the GPU copy goes now, and comes back only if the store is drawn again. */
    void releaseGpuCopy() { ++gpuReleases_; }
    uint32_t gpuReleases() const { return gpuReleases_; }
    void addUpdateRange(uint64_t start, uint64_t count) { ranges_.push_back({start, count}); }
    void clearUpdateRanges() { ranges_.clear(); }
    std::span<const UpdateRange> updateRanges() const { return ranges_; }

    Scalar scalar() const { return scalar_; }
    uint64_t count() const { return bytes_.size() / scalarSize(scalar_); }
    uint64_t byteLength() const { return bytes_.size(); }
    /** Changes whenever the storage reallocates; a view compares it to know it must re-resolve. */
    uint64_t epoch() const { return epoch_; }
    /** Moves on every `write`, resize and mutable `data()`: a JS copy of the bytes is current while it holds. */
    uint64_t writes() const { return writes_; }
    std::byte* data() {
        ++writes_;
        return bytes_.data();
    }
    const std::byte* data() const { return bytes_.data(); }

private:
    Scalar scalar_;
    std::vector<std::byte> bytes_;
    uint64_t epoch_ = 0;
    uint64_t writes_ = 0;
    uint64_t pendingCount_ = 0;
    bool resizePending_ = false;
    uint32_t leases_ = 0;
    uint32_t version_ = 0;
    uint32_t gpuReleases_ = 0;
    std::vector<UpdateRange> ranges_;
};

/**
 * A retained view of a store (an attribute array or `.elements`). It holds the store, never a raw
 * pointer, so a write on the native side is what it reads and a reallocation — Wasm memory growth
 * included — is followed rather than read after free.
 */
class BufferView {
public:
    explicit BufferView(BufferStore& store) : store_(&store), seenEpoch_(store.epoch()) {}

    std::span<std::byte> bytes() {
        seenEpoch_ = store_->epoch();
        return {store_->data(), static_cast<size_t>(store_->byteLength())};
    }
    /** True once the storage moved since the last `bytes()`: the caller's old span is invalid. */
    bool stale() const { return seenEpoch_ != store_->epoch(); }

private:
    BufferStore* store_;
    uint64_t seenEpoch_;
};

}  // namespace tn::engine
