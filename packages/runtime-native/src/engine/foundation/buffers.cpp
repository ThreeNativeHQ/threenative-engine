#include "buffers.h"

#include <algorithm>
#include <cstring>
#include <limits>

namespace tn::engine {

uint32_t scalarSize(Scalar scalar) {
    switch (scalar) {
        case Scalar::I8:
        case Scalar::U8: return 1;
        case Scalar::I16:
        case Scalar::U16: return 2;
        case Scalar::F32:
        case Scalar::I32:
        case Scalar::U32: return 4;
        case Scalar::F64: return 8;
    }
    return 1;
}

BufferStore::BufferStore(Scalar scalar, uint64_t count) : scalar_(scalar) {
    const uint64_t size = scalarSize(scalar);
    // A count whose byte size overflows is clamped to empty rather than wrapped to a small buffer.
    bytes_.resize(count <= std::numeric_limits<uint64_t>::max() / size ? count * size : 0);
}

BufferError BufferStore::validate(uint64_t byteOffset, uint64_t byteLength, uint64_t byteStride) const {
    const uint64_t capacity = bytes_.size();
    // Subtraction, not addition: offset + length can wrap, capacity - offset cannot once offset fits.
    if (byteOffset > capacity || byteLength > capacity - byteOffset) return BufferError::Range;
    const uint32_t size = scalarSize(scalar_);
    if (byteOffset % size != 0 || byteLength % size != 0) return BufferError::Layout;
    if (byteStride != 0 && (byteStride % size != 0 || byteStride > capacity)) return BufferError::Layout;
    return BufferError::None;
}

BufferError BufferStore::write(uint64_t byteOffset, const void* source, uint64_t byteLength) {
    const BufferError error = validate(byteOffset, byteLength);
    if (error != BufferError::None) return error;
    pull();
    ++writes_;
    if (byteLength > 0) std::memcpy(bytes_.data() + byteOffset, source, byteLength);
    return BufferError::None;
}

BufferError BufferStore::read(uint64_t byteOffset, void* destination, uint64_t byteLength) const {
    const BufferError error = validate(byteOffset, byteLength);
    if (error != BufferError::None) return error;
    pull();
    if (byteLength > 0) std::memcpy(destination, bytes_.data() + byteOffset, byteLength);
    return BufferError::None;
}

bool BufferStore::resize(uint64_t count) {
    if (leases_ > 0) {
        pendingCount_ = count;
        resizePending_ = true;
        return false;
    }
    const uint64_t size = scalarSize(scalar_);
    const uint64_t bytes = count <= std::numeric_limits<uint64_t>::max() / size ? count * size : 0;
    if (bytes == bytes_.size()) return true;
    pull();
    // A fresh allocation every time, so the storage really moves and stale readers are caught.
    decltype(bytes_) next(bytes);
    // memcpy with a null pointer is undefined even for zero bytes, and empty storage has none.
    const uint64_t kept = std::min<uint64_t>(bytes, bytes_.size());
    if (kept > 0) std::memcpy(next.data(), bytes_.data(), kept);
    if (bytes > kept) std::memset(next.data() + kept, 0, bytes - kept);
    bytes_.swap(next);
    ++epoch_;
    ++writes_;
    return true;
}

void BufferStore::fill() const {
    auto* data = const_cast<std::byte*>(bytes_.data());
    uint64_t written = 0;
    if (deferred_) {
        deferred_ = false;
        const uint64_t size = scalarSize(scalar_);
        written = std::min<uint64_t>(pullHook(*this, data), bytes_.size() / size) * size;
    }
    if (unfilled_ && bytes_.size() > written) std::memset(data + written, 0, bytes_.size() - written);
    unfilled_ = false;
}

void BufferStore::releaseLease() {
    if (leases_ == 0) return;
    if (--leases_ == 0 && resizePending_) {
        resizePending_ = false;
        resize(pendingCount_);
    }
}

}  // namespace tn::engine
