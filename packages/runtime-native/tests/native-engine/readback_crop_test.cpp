#include "check.h"
#include "engine/renderer/readback_crop.h"

#include <cstdint>
#include <cstdio>
#include <span>
#include <vector>

// The ROI crop every attachment read hands back (readback_crop.h). A GPU read returns the whole
// attachment, padded to 256-byte rows, and the caller asked for a region: the water proof reads
// 280x100 of a 1280-wide MRT slot, top row first. The arithmetic is the part a device cannot show,
// so it is checked here without one.

namespace {

using tn::engine::cropRgba16Rows;
using tn::engine::kRgba16BytesPerTexel;

/** A full-width RGBA16Float image whose texel (x, y) holds its own coordinates in its first two lanes. */
std::vector<std::uint8_t> image(std::uint32_t width, std::uint32_t height) {
    std::vector<std::uint8_t> rows(std::size_t(width) * height * kRgba16BytesPerTexel, 0);
    for (std::uint32_t y = 0; y < height; ++y)
        for (std::uint32_t x = 0; x < width; ++x) {
            std::uint8_t* texel = rows.data() + (std::size_t(y) * width + x) * kRgba16BytesPerTexel;
            const std::uint16_t lane[2] = {std::uint16_t(x), std::uint16_t(y)};
            std::memcpy(texel, lane, sizeof(lane));
        }
    return rows;
}

std::uint16_t laneAt(const std::vector<std::uint8_t>& region, std::uint32_t width, std::uint32_t x,
                     std::uint32_t y, std::uint32_t lane) {
    const std::size_t offset = (std::size_t(y) * width + x) * kRgba16BytesPerTexel + lane * 2;
    std::uint16_t value = 0;
    std::memcpy(&value, region.data() + offset, sizeof(value));
    return value;
}

void cropsTheRegion() {
    const std::uint32_t fullWidth = 1280, fullHeight = 720;
    const auto rows = image(fullWidth, fullHeight);
    // The sheltered pool's ROI: x 940, y 600, 280 wide, 100 tall, as verify-ocean.mjs authors it.
    const auto region = cropRgba16Rows(rows, fullWidth, 940, 600, 280, 100);
    CHECK(region.size() == std::size_t(280) * 100 * kRgba16BytesPerTexel);
    CHECK(laneAt(region, 280, 0, 0, 0) == 940);
    CHECK(laneAt(region, 280, 0, 0, 1) == 600);
    CHECK(laneAt(region, 280, 279, 99, 0) == 1219);
    CHECK(laneAt(region, 280, 279, 99, 1) == 699);
    // The last row of the region is the image's last row, not a padded one.
    CHECK(laneAt(region, 280, 10, 99, 1) == 699);
    // A whole-image region copies every texel in place.
    const auto whole = cropRgba16Rows(rows, fullWidth, 0, 0, fullWidth, fullHeight);
    CHECK(whole == rows);
}

void refusesWhatLeavesTheRows() {
    const auto rows = image(8, 4);
    CHECK(cropRgba16Rows(rows, 8, 7, 0, 2, 1).empty());   // past the right edge
    CHECK(cropRgba16Rows(rows, 8, 0, 3, 1, 2).empty());   // past the bottom edge
    CHECK(cropRgba16Rows(rows, 8, 0, 0, 0, 1).empty());   // a zero-width ask
    CHECK(cropRgba16Rows(rows, 8, 0, 0, 1, 0).empty());   // a zero-height ask
    CHECK(cropRgba16Rows({}, 8, 0, 0, 1, 1).empty());     // no rows at all
    CHECK(cropRgba16Rows(rows, 0, 0, 0, 1, 1).empty());   // a row of no width
    // Rows the caller padded past the image still crop the image, not the padding.
    std::vector<std::uint8_t> padded = rows;
    padded.resize(padded.size() + std::size_t(8) * kRgba16BytesPerTexel);
    const auto region = cropRgba16Rows(padded, 8, 1, 1, 2, 2);
    CHECK(laneAt(region, 2, 0, 0, 0) == 1 && laneAt(region, 2, 0, 0, 1) == 1);
    CHECK(laneAt(region, 2, 1, 1, 0) == 2 && laneAt(region, 2, 1, 1, 1) == 2);
}

}  // namespace

TN_TEST_MAIN({"crops_region", cropsTheRegion}, {"refuses_outside", refusesWhatLeavesTheRows})
