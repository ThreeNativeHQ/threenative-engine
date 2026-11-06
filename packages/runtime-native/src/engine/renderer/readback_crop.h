#pragma once

// Cropping a readback region out of a full-width RGBA16Float row buffer. A GPU read returns the whole
// attachment (one padded staging copy), and every caller that asked for a region — readRenderTarget,
// a custom MRT slot — hands back those rows, top row first. The arithmetic is identical for both, so it
// lives here once and is tested without a device.

#include <cstdint>
#include <cstring>
#include <span>
#include <vector>

namespace tn::engine {

/** Bytes per texel of the RGBA16Float attachments the post pass and every MRT slot hold. */
constexpr uint32_t kRgba16BytesPerTexel = 8;

/**
 * The region [x, y, width, height] of `rows` (fullWidth texels per row, top row first). Returns an
 * empty vector when the region leaves the rows, so a caller fails closed instead of reading past them.
 */
inline std::vector<uint8_t> cropRgba16Rows(std::span<const uint8_t> rows, uint32_t fullWidth, uint32_t x,
                                           uint32_t y, uint32_t width, uint32_t height) {
    if (width == 0 || height == 0 || fullWidth == 0) return {};
    if (uint64_t(x) + width > fullWidth) return {};
    const uint64_t fullHeight = uint64_t(rows.size()) / (uint64_t(fullWidth) * kRgba16BytesPerTexel);
    if (uint64_t(y) + height > fullHeight) return {};
    const uint64_t rowBytes = uint64_t(width) * kRgba16BytesPerTexel;
    std::vector<uint8_t> region(rowBytes * height);
    for (uint32_t row = 0; row < height; ++row) {
        const uint8_t* source = rows.data() + (uint64_t(y + row) * fullWidth + x) * kRgba16BytesPerTexel;
        std::memcpy(region.data() + uint64_t(row) * rowBytes, source, rowBytes);
    }
    return region;
}

}  // namespace tn::engine
