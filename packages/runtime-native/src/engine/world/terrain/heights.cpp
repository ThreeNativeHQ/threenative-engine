#include "engine/world/terrain/heights.h"

#include <cmath>
#include <limits>

namespace tn::engine::world {

namespace {
// heightSamplerFromHeightmap's HEIGHTMAP_MAX: the uint16 span a raw heightmap encodes.
constexpr double kHeightmapMax = 65535.0;
// heightAt's out-of-region tolerance.
constexpr double kRegionEpsilon = 1e-9;

/** regionAxis: both bounds are non-negative integers and the window lies inside the field. */
bool validAxis(uint32_t start, uint32_t size, uint32_t total, std::string& error) {
    if (size < 1 || start > total || size > total - start) {
        error.assign(kHeightfieldRegionCode);
        return false;
    }
    return true;
}
} // namespace

std::optional<HeightSampler> HeightSampler::create(uint32_t columns, uint32_t rows, double spacing, double heightMin,
                                                   double heightMax, double minX, double minZ,
                                                   std::span<const uint16_t> data, std::string& error) {
    if (data.size() != static_cast<std::size_t>(columns) * static_cast<std::size_t>(rows)) {
        error.assign(kHeightmapSizeCode);
        return std::nullopt;
    }
    HeightSampler sampler;
    sampler.columns_ = columns;
    sampler.rows_ = rows;
    sampler.spacing_ = spacing;
    sampler.heightMin_ = heightMin;
    sampler.range_ = heightMax - heightMin;
    sampler.minX_ = minX;
    sampler.minZ_ = minZ;
    sampler.data_.assign(data.begin(), data.end());
    return sampler;
}

// heightSamplerFromHeightmap's returned function, operation for operation.
double HeightSampler::sample(double x, double z) const {
    // Math.max(0, NaN) is NaN and the JavaScript sampler answers NaN; std::max would clamp it to an
    // edge instead (and a NaN index is no index at all).
    if (std::isnan(x) || std::isnan(z))
        return std::numeric_limits<double>::quiet_NaN();
    const double lastColumn = static_cast<double>(columns_ - 1);
    const double lastRow = static_cast<double>(rows_ - 1);
    const double column = std::min(lastColumn, std::max(0.0, (x - minX_) / spacing_));
    const double row = std::min(lastRow, std::max(0.0, (z - minZ_) / spacing_));
    const double column0 = std::floor(column);
    const double row0 = std::floor(row);
    const double column1 = std::min(lastColumn, column0 + 1.0);
    const double row1 = std::min(lastRow, row0 + 1.0);
    const double mixX = column - column0;
    const double mixZ = row - row0;
    const auto vertex = [&](double r, double c) {
        const std::size_t index = static_cast<std::size_t>(r) * columns_ + static_cast<std::size_t>(c);
        return heightMin_ + (static_cast<double>(data_[index]) / kHeightmapMax) * range_;
    };
    const double upperLeft = vertex(row0, column0);
    const double upperRight = vertex(row0, column1);
    const double lowerLeft = vertex(row1, column0);
    const double lowerRight = vertex(row1, column1);
    const double upper = upperLeft + (upperRight - upperLeft) * mixX;
    const double lower = lowerLeft + (lowerRight - lowerLeft) * mixX;
    return upper + (lower - upper) * mixZ;
}

Heightfield::Heightfield(uint32_t columns, uint32_t rows, double width, double depth, double originX, double originZ,
                         std::span<const float> heights)
    : columns_(columns), rows_(rows) {
    cellWidth_ = width / static_cast<double>(columns - 1);
    cellDepth_ = depth / static_cast<double>(rows - 1);
    minimumX_ = originX - width / 2.0;
    minimumZ_ = originZ - depth / 2.0;
    heights_.assign(heights.begin(), heights.end());
}

bool Heightfield::heightAt(double x, double z, double& out, std::string& error) const {
    if (!std::isfinite(x) || !std::isfinite(z)) {
        error.assign(kHeightfieldQueryCode);
        return false;
    }
    const double column = (x - minimumX_) / cellWidth_;
    const double row = (z - minimumZ_) / cellDepth_;
    const double lastColumn = static_cast<double>(columns_ - 1);
    const double lastRow = static_cast<double>(rows_ - 1);
    if (column < -kRegionEpsilon || row < -kRegionEpsilon || column > lastColumn + kRegionEpsilon ||
        row > lastRow + kRegionEpsilon) {
        error.assign(kHeightfieldQueryCode);
        return false;
    }
    out = interpolate(std::min(lastColumn, std::max(0.0, column)), std::min(lastRow, std::max(0.0, row)));
    return true;
}

bool Heightfield::updateHeights(const HeightfieldRegion& region, std::string& error) {
    if (!validAxis(region.column, region.columns, columns_, error))
        return false;
    if (!validAxis(region.row, region.rows, rows_, error))
        return false;
    const std::size_t expected = static_cast<std::size_t>(region.columns) * static_cast<std::size_t>(region.rows);
    if (region.heights.size() != expected) {
        error.assign(kHeightfieldSizeCode);
        return false;
    }
    for (const float value : region.heights) {
        if (!std::isfinite(value)) {
            error.assign(kHeightfieldSampleCode);
            return false;
        }
    }
    for (uint32_t index = 0; index < region.rows; ++index) {
        for (uint32_t offset = 0; offset < region.columns; ++offset) {
            const std::size_t target = region.row + index;
            const std::size_t source = region.column + offset;
            heights_[target * columns_ + source] =
                region.heights[static_cast<std::size_t>(index) * region.columns + offset];
        }
    }
    version_ += 1;
    return true;
}

// Heightfield's #interpolate, operation for operation; samples promote from float32.
double Heightfield::interpolate(double column, double row) const {
    const double lastColumn = static_cast<double>(columns_ - 1);
    const double lastRow = static_cast<double>(rows_ - 1);
    const double column0 = std::floor(column);
    const double row0 = std::floor(row);
    const double column1 = std::min(lastColumn, column0 + 1.0);
    const double row1 = std::min(lastRow, row0 + 1.0);
    const double columnMix = column - column0;
    const double rowMix = row - row0;
    const auto sample = [&](double r, double c) {
        return static_cast<double>(heights_[static_cast<std::size_t>(r) * columns_ + static_cast<std::size_t>(c)]);
    };
    const double upperLeft = sample(row0, column0);
    const double upperRight = sample(row0, column1);
    const double lowerLeft = sample(row1, column0);
    const double lowerRight = sample(row1, column1);
    const double upper = upperLeft + (upperRight - upperLeft) * columnMix;
    const double lower = lowerLeft + (lowerRight - lowerLeft) * columnMix;
    return upper + (lower - upper) * rowMix;
}

} // namespace tn::engine::world
