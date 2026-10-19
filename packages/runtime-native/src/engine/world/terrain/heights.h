#pragma once

#include <cstdint>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace tn::engine::world {

/** A raw heightmap whose sample count does not match columns * rows is refused by this name. */
inline constexpr std::string_view kHeightmapSizeCode = "TN_WORLD_HEIGHTMAP_SIZE";

/**
 * The sampler behind `heightSamplerFromHeightmap` in packages/core/src/world-heightmap.ts
 * (PRD-521 phase 3). Bilinear in world units, clamped to the map edges, binary64 and the same
 * clamps, floor, mixes and operation order, so a recorded sample reproduces bit for bit. The game
 * owns the heightmap data; this only reads it. The data is copied, so the caller's buffer may die.
 */
class HeightSampler {
  public:
    /**
     * Builds the sampler. When `data` is not exactly `columns * rows` long, returns nullopt and
     * sets `error` to kHeightmapSizeCode instead of throwing.
     */
    static std::optional<HeightSampler> create(uint32_t columns, uint32_t rows, double spacing, double heightMin,
                                               double heightMax, double minX, double minZ,
                                               std::span<const uint16_t> data, std::string& error);

    /** The world height at `(x, z)`, clamped to the map edges. */
    double sample(double x, double z) const;

  private:
    HeightSampler() = default;

    uint32_t columns_ = 0;
    uint32_t rows_ = 0;
    double spacing_ = 0.0;
    double heightMin_ = 0.0;
    double range_ = 0.0;
    double minX_ = 0.0;
    double minZ_ = 0.0;
    std::vector<uint16_t> data_;
};

/** A rectangular window plus its replacement samples, mirroring IHeightfieldRegion. */
struct HeightfieldRegion {
    uint32_t column = 0;
    uint32_t columns = 0;
    uint32_t row = 0;
    uint32_t rows = 0;
    std::span<const float> heights;
};

/** A region axis that is not inside the field is refused by this name. */
inline constexpr std::string_view kHeightfieldRegionCode = "TN_WORLD_HEIGHTFIELD_REGION";
/** A region whose sample count does not match columns * rows is refused by this name. */
inline constexpr std::string_view kHeightfieldSizeCode = "TN_WORLD_HEIGHTFIELD_SIZE";
/** A non-finite region sample is refused by this name. */
inline constexpr std::string_view kHeightfieldSampleCode = "TN_WORLD_HEIGHTFIELD_SAMPLE";
/** A query outside the field's resident region is refused by this name. */
inline constexpr std::string_view kHeightfieldQueryCode = "TN_WORLD_HEIGHTFIELD_QUERY";

/**
 * One height buffer behind world queries (PRD-521 phase 3): the storage, `heightAt` and its sample
 * version from packages/core/src/world.ts's `Heightfield`. `updateHeights` validates the whole
 * window before any sample changes, so a malformed call leaves the field untouched, and a success
 * bumps the version by exactly one. Collider and normal storage are not ported: `heightAt` needs
 * neither.
 */
class Heightfield {
  public:
    Heightfield(uint32_t columns, uint32_t rows, double width, double depth, double originX, double originZ,
                std::span<const float> heights);

    /** Monotonic sample version; incremented by exactly one on every successful `updateHeights`. */
    uint64_t version() const { return version_; }

    /** Bilinear height at `(x, z)`; outside the region returns false and sets kHeightfieldQueryCode. */
    bool heightAt(double x, double z, double& out, std::string& error) const;

    /** Overwrite one window; on any defect returns false with a named code and writes nothing. */
    bool updateHeights(const HeightfieldRegion& region, std::string& error);

  private:
    double interpolate(double column, double row) const;

    uint32_t columns_ = 0;
    uint32_t rows_ = 0;
    double cellWidth_ = 0.0;
    double cellDepth_ = 0.0;
    double minimumX_ = 0.0;
    double minimumZ_ = 0.0;
    std::vector<float> heights_;
    uint64_t version_ = 0;
};

} // namespace tn::engine::world
