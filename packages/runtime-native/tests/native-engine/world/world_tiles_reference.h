#pragma once
// The recorded world-tiles table (world_tiles_reference.inc, written by world-tiles-reference.ts):
// one scene's options, the grids its tiles read, its follow steps, and every recorded decision for
// each. The builders below turn its bit patterns into port inputs.

#include "engine/world/tiles/terrain_tiles.h"

#include <bit>
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace {

using namespace tn::engine::world;

constexpr double doubleFromBits(uint64_t bits) { return std::bit_cast<double>(bits); }
constexpr float floatFromBits(uint32_t bits) { return std::bit_cast<float>(bits); }

/** One tile's field, as the game authored it: the canonical row-major grid of f32 samples. */
struct RefGrid {
    int32_t tileX;
    int32_t tileZ;
    uint32_t columns;
    uint32_t rows;
    const uint32_t* samples;
};

struct RefOptions {
    uint64_t tileSize;
    uint32_t tileResolution;
    uint32_t residentTileBudget;
    uint64_t residentByteBudget;
    uint64_t skirtDepth;
    uint32_t streamRadius;
    uint32_t colliderRadius;
    uint32_t factorCount;
    uint32_t distanceCount;
    const uint32_t* factors;
    const uint64_t* distances;
    uint32_t recordColliders;
    uint32_t colliderThrows;
    uint32_t hasTopology;
    uint32_t topologyColumns;
    uint32_t topologyRows;
    uint64_t topologyWidth;
    uint64_t topologyDepth;
};

struct RefTile {
    int32_t tileX;
    int32_t tileZ;
    uint64_t bytes;
    uint32_t lodLevel;
    uint32_t hasCollider;
    uint32_t resolutions[3];
    uint32_t resolutionCount;
    uint32_t colliderCount;
    const uint32_t* colliderHeights;
};

struct RefEvent {
    const char* key;
    uint32_t created;
};

struct RefStep {
    uint32_t outcome;
    uint32_t deferredAdmissions;
    uint32_t units;
    uint64_t x;
    uint64_t z;
    uint32_t processes;
    const char* const* resident;
    uint32_t residentCount;
    const char* const* insertion;
    uint32_t insertionCount;
    const char* const* colliders;
    uint32_t colliderCount;
    const RefTile* tiles;
    uint32_t tileCount;
    const RefEvent* events;
    uint32_t eventCount;
    uint64_t residentBytes;
    uint64_t stitchBytes;
    uint32_t bridges;
    uint64_t peakBytes;
    uint32_t peakTiles;
    uint32_t lodTransitions;
    uint32_t blendingTiles;
};

struct RefScene {
    const char* name;
    RefOptions options;
    const RefGrid* grids;
    uint32_t gridCount;
    const RefStep* steps;
    uint32_t stepCount;
    uint32_t refusal;
};

#include "world_tiles_reference.inc"

/** The recorded fields of one scene, served to the port as the game's own `sampleHeight` output. */
class RecordedHeights : public IHeightGridSource {
  public:
    explicit RecordedHeights(const RefGrid* grids, uint32_t count) : grids_(grids), count_(count) {}

    bool tileGrid(int32_t tileX, int32_t tileZ, std::vector<float>& heights) override {
        for (uint32_t index = 0; index < count_; index += 1) {
            const RefGrid& grid = grids_[index];
            if (grid.tileX != tileX || grid.tileZ != tileZ) continue;
            heights.resize(static_cast<std::size_t>(grid.columns) * grid.rows);
            for (std::size_t sample = 0; sample < heights.size(); sample += 1)
                heights[sample] = floatFromBits(grid.samples[sample]);
            return true;
        }
        return false;
    }

  private:
    const RefGrid* grids_ = nullptr;
    uint32_t count_ = 0;
};

/** The recorded scene's options as the port's own, with every default the core resolved spelled out. */
ITerrainTilesOptions buildOptions(const RefOptions& ref) {
    ITerrainTilesOptions options;
    options.tileSize = doubleFromBits(ref.tileSize);
    options.tileResolution = ref.tileResolution;
    options.residentTileBudget = ref.residentTileBudget;
    options.residentByteBudget = ref.residentByteBudget;
    options.skirtDepth = doubleFromBits(ref.skirtDepth);
    options.streamRadius = ref.streamRadius;
    options.colliderRadius = ref.colliderRadius;
    // The recorded value is the core's own resolved default, so the port must not re-resolve it.
    options.colliderRadiusSet = true;
    options.lodFactors.assign(ref.factors, ref.factors + ref.factorCount);
    for (uint32_t index = 0; index < ref.distanceCount; index += 1)
        options.lodDistances.push_back(doubleFromBits(ref.distances[index]));
    options.createCollider = ref.recordColliders != 0 || ref.colliderThrows != 0;
    options.colliderFactoryThrows = ref.colliderThrows != 0;
    if (ref.hasTopology != 0)
        options.topologyObservation = TerrainTileTopologyObservation{
            ref.topologyColumns, ref.topologyRows, doubleFromBits(ref.topologyWidth),
            doubleFromBits(ref.topologyDepth)};
    return options;
}

} // namespace