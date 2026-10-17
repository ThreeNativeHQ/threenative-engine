#include "engine/world/tiles/terrain_tiles.h"

#include <algorithm>
#include <cmath>
#include <iterator>
#include <string>
#include <utility>

namespace tn::engine::world {

namespace {
// LOD_POP_THRESHOLD: a level whose height error against every finer level exceeds this is not
// selectable, which is what keeps a game-authored cliff at a finer level instead of throwing.
constexpr double kLodPopThreshold = 16.0;
// LOD_TRANSITION_FRAMES: a blend walks a third of the way between two levels per process().
constexpr uint32_t kLodTransitionFrames = 3;
// BRIDGE_STRIP_INDEX_PATTERN's length: one quad per fine vertex, twelve indices each.
constexpr uint64_t kBridgeIndicesPerSegment = 12;
// Heightfield.memoryBytes with no world passes: the canonical grid and its collider-order copy.
constexpr uint32_t kFieldSampleCopies = 2;
// TERRAIN_MERGE_BLOCK: the KxK tile block one super-tile covers.
constexpr int32_t kTerrainMergeBlock = 4;
} // namespace

namespace {
std::string keyFor(int32_t tileX, int32_t tileZ) {
    return std::to_string(tileX) + ":" + std::to_string(tileZ);
}

/** blockKeyFor: the super-tile a tile's level at `(lod, tileX, tileZ)` belongs to. */
std::string blockKeyFor(uint32_t lod, int32_t tileX, int32_t tileZ) {
    return std::to_string(lod) + ":" + std::to_string(static_cast<int32_t>(std::floor(static_cast<double>(tileX) / kTerrainMergeBlock))) + "," +
           std::to_string(static_cast<int32_t>(std::floor(static_cast<double>(tileZ) / kTerrainMergeBlock)));
}

bool finiteNumber(double value) { return !std::isnan(value) && !std::isinf(value); }

bool validResolution(uint32_t tileResolution, uint32_t factor) {
    return factor >= 1 && tileResolution >= 3 && (tileResolution - 1) % factor == 0;
}

/** interpolatedSamplesHeight / interpolatedLevelHeight: bilinear in normalized tile coordinates. */
double interpolatedHeight(const std::vector<float>& samples, uint32_t resolution, double x, double z) {
    const double column = std::clamp(x, 0.0, 1.0) * static_cast<double>(resolution - 1);
    const double row = std::clamp(z, 0.0, 1.0) * static_cast<double>(resolution - 1);
    const double column0 = std::floor(column);
    const double row0 = std::floor(row);
    const double column1 = std::min(static_cast<double>(resolution - 1), column0 + 1.0);
    const double row1 = std::min(static_cast<double>(resolution - 1), row0 + 1.0);
    const double columnMix = column - column0;
    const double rowMix = row - row0;
    const auto at = [&](double r, double c) {
        return static_cast<double>(samples[static_cast<std::size_t>(r) * resolution +
                                       static_cast<std::size_t>(c)]);
    };
    const double upper = at(row0, column0) + (at(row0, column1) - at(row0, column0)) * columnMix;
    const double lower = at(row1, column0) + (at(row1, column1) - at(row1, column0)) * columnMix;
    return upper + (lower - upper) * rowMix;
}

/** surfaceDeltaFromSamples: the largest visible disagreement between two levels of one tile. */
double surfaceDelta(const std::vector<float>& samples, uint32_t samplesResolution,
                    const std::vector<float>& level, uint32_t levelResolution) {
    const uint32_t total = std::max(samplesResolution, levelResolution);
    double maximum = 0.0;
    for (uint32_t row = 0; row < total; row += 1)
        for (uint32_t column = 0; column < total; column += 1) {
            const double x = static_cast<double>(column) / static_cast<double>(total - 1);
            const double z = static_cast<double>(row) / static_cast<double>(total - 1);
            maximum = std::max(maximum, std::abs(interpolatedHeight(samples, samplesResolution, x, z) -
                                                 interpolatedHeight(level, levelResolution, x, z)));
        }
    return maximum;
}

/** toColliderHeights: the canonical grid transposed into the collider's column-major order. */
std::vector<float> colliderOrder(const std::vector<float>& heights, uint32_t columns, uint32_t rows) {
    std::vector<float> transposed(columns * rows);
    for (uint32_t column = 0; column < columns; column += 1)
        for (uint32_t row = 0; row < rows; row += 1)
            transposed[column * rows + row] = heights[row * columns + column];
    return transposed;
}
} // namespace

std::optional<TerrainTiles> TerrainTiles::create(const ITerrainTilesOptions& options,
                                                 IHeightGridSource& heights, std::string& error) {
    if (!finiteNumber(options.tileSize)) {
        error.assign(kTerrainTileFiniteCode);
        return std::nullopt;
    }
    if (options.tileSize <= 0.0) {
        error.assign(kTerrainTilePositiveCode);
        return std::nullopt;
    }
    if (options.tileResolution < 3 || options.residentTileBudget < 1 || options.residentByteBudget < 1) {
        error.assign(kTerrainTileIntegerCode);
        return std::nullopt;
    }
    if (!finiteNumber(options.skirtDepth) || options.skirtDepth <= 0.0) {
        error.assign(kTerrainTilePositiveCode);
        return std::nullopt;
    }
    if (options.lodFactors.empty()) {
        error.assign(kTerrainTileFactorCode);
        return std::nullopt;
    }
    for (const uint32_t factor : options.lodFactors)
        if (!validResolution(options.tileResolution, factor)) {
            error.assign(kTerrainTileFactorCode);
            return std::nullopt;
        }
    if (options.lodDistances.size() + 1 != options.lodFactors.size()) {
        error.assign(kTerrainTileThresholdCode);
        return std::nullopt;
    }
    for (std::size_t index = 0; index < options.lodDistances.size(); index += 1) {
        const double distance = options.lodDistances[index];
        if (!finiteNumber(distance) || distance <= 0.0) {
            error.assign(kTerrainTilePositiveCode);
            return std::nullopt;
        }
        if (index > 0 && distance <= options.lodDistances[index - 1]) {
            error.assign(kTerrainTileThresholdCode);
            return std::nullopt;
        }
    }

    TerrainTiles tiles;
    tiles.options_ = options;
    tiles.heights_ = &heights;
    if (!options.colliderRadiusSet) tiles.options_.colliderRadius = options.streamRadius;

    if (options.topologyObservation.has_value()) {
        // tiledObservationResolution: the measured region must cover a whole number of rendered tiles,
        // and its grid must be the one those tiles render at.
        const TerrainTileTopologyObservation& observation = *options.topologyObservation;
        if (!finiteNumber(observation.width) || !finiteNumber(observation.depth) ||
            observation.width <= 0.0 || observation.depth <= 0.0) {
            error.assign(kTerrainTilePositiveCode);
            return std::nullopt;
        }
        const double widthTiles = observation.width / options.tileSize;
        const double depthTiles = observation.depth / options.tileSize;
        if (widthTiles < 1.0 || widthTiles != std::floor(widthTiles) || depthTiles < 1.0 ||
            depthTiles != std::floor(depthTiles)) {
            error.assign(kTerrainTileTopologyCode);
            return std::nullopt;
        }
        const uint64_t columns =
            static_cast<uint64_t>(widthTiles) * (options.tileResolution - 1) + 1;
        const uint64_t rows = static_cast<uint64_t>(depthTiles) * (options.tileResolution - 1) + 1;
        if (observation.columns != columns || observation.rows != rows) {
            error.assign(kTerrainTileTopologyCode);
            return std::nullopt;
        }
        tiles.topologyBytes_ =
            columns * rows * sizeof(float) * kFieldSampleCopies;
        if (tiles.topologyBytes_ > options.residentByteBudget) {
            error.assign(kTerrainTileBudgetCode);
            return std::nullopt;
        }
    }
    tiles.recordPeaks();
    return tiles;
}

uint32_t TerrainTiles::resolutionFor(uint32_t factor) const {
    return (options_.tileResolution - 1) / factor + 1;
}

uint64_t TerrainTiles::estimatedLevelBytes(uint32_t resolution) const {
    const uint64_t vertices = static_cast<uint64_t>(resolution) * resolution + resolution * 4;
    const uint64_t triangles =
        static_cast<uint64_t>(resolution - 1) * (resolution - 1) + static_cast<uint64_t>(resolution - 1) * 4;
    const uint64_t edgeSampleBytes = resolution * 4 * sizeof(float);
    return vertices * 3 * sizeof(float) * 2 + triangles * 6 * sizeof(uint32_t) + edgeSampleBytes;
}

uint64_t TerrainTiles::estimatedFieldBytes() const {
    return static_cast<uint64_t>(options_.tileResolution) * options_.tileResolution * sizeof(float) *
           kFieldSampleCopies;
}

uint64_t TerrainTiles::estimatedTileBytes() const {
    uint64_t total = estimatedFieldBytes();
    for (const uint32_t factor : options_.lodFactors) total += estimatedLevelBytes(resolutionFor(factor));
    return total;
}

uint64_t TerrainTiles::residentBytes() const {
    uint64_t total = topologyBytes_ + stitchBytes_;
    for (const ITile& tile : tiles_) total += tile.info.bytes;
    return total;
}

uint32_t TerrainTiles::coarsestSelectableLevel(const std::vector<std::vector<float>>& levels) const {
    uint32_t coarsest = 0;
    for (std::size_t index = 1; index < levels.size(); index += 1) {
        double error = 0.0;
        for (std::size_t finer = 0; finer < index; finer += 1)
            error = std::max(error, surfaceDelta(levels[finer], resolutionFor(options_.lodFactors[finer]),
                                                levels[index], resolutionFor(options_.lodFactors[index])));
        if (error > kLodPopThreshold) break;
        coarsest = static_cast<uint32_t>(index);
    }
    return coarsest;
}

bool TerrainTiles::wantsCollider(int32_t tileX, int32_t tileZ, int32_t centerX, int32_t centerZ) const {
    return std::max(std::abs(tileX - centerX), std::abs(tileZ - centerZ)) <=
           static_cast<int32_t>(options_.colliderRadius);
}

uint32_t TerrainTiles::lodLevelForDistance(double distance) const {
    uint32_t level = 0;
    for (const double threshold : options_.lodDistances) {
        if (distance < threshold) break;
        level += 1;
    }
    return level;
}

uint32_t TerrainTiles::renderedLevel(const ITile& tile) const {
    // A blend shows its finer level; a settled tile shows its own, whether its own mesh is drawn or
    // the merge has hidden it inside a block.
    if (!tile.hasTransition) return tile.info.lodLevel;
    return std::min(tile.lodTransition.from, tile.lodTransition.to);
}

TerrainTiles::ITile* TerrainTiles::findTile(const std::string& key) {
    for (ITile& tile : tiles_)
        if (tile.info.key == key) return &tile;
    return nullptr;
}

const ITerrainTileInfo* TerrainTiles::find(const std::string& key) const {
    for (const ITile& tile : tiles_)
        if (tile.info.key == key) return &tile.info;
    return nullptr;
}

const ITerrainTileInfo* TerrainTiles::tile(const std::string& key) const { return find(key); }

TerrainTiles::ITile* TerrainTiles::buildTile(int32_t tileX, int32_t tileZ, double distance,
                                             bool withCollider, std::string& error) {
    const uint32_t columns = options_.tileResolution;
    const uint32_t rows = options_.tileResolution;
    std::vector<float> grid;
    if (!heights_->tileGrid(tileX, tileZ, grid) || grid.size() != static_cast<std::size_t>(columns) * rows) {
        error.assign(kTerrainTileFieldCode);
        return nullptr;
    }

    ITile tile;
    tile.info.key = keyFor(tileX, tileZ);
    tile.info.tileX = tileX;
    tile.info.tileZ = tileZ;
    tile.info.originX = static_cast<double>(tileX) * options_.tileSize;
    tile.info.originZ = static_cast<double>(tileZ) * options_.tileSize;
    tile.info.width = options_.tileSize;
    tile.info.depth = options_.tileSize;
    tile.info.columns = columns;
    tile.info.rows = rows;
    for (const uint32_t factor : options_.lodFactors)
        tile.info.resolutions.push_back(resolutionFor(factor));

    // buildLevel reads the field's own grid one `step` apart per level, so every level is a strided
    // view of the same samples and no level holds a height the field does not.
    for (const uint32_t resolution : tile.info.resolutions) {
        const uint32_t step = (columns - 1) / (resolution - 1);
        std::vector<float> heights(static_cast<std::size_t>(resolution) * resolution);
        for (uint32_t row = 0; row < resolution; row += 1)
            for (uint32_t column = 0; column < resolution; column += 1)
                heights[row * resolution + column] = grid[(row * step) * columns + column * step];
        tile.levelHeights.push_back(std::move(heights));
    }

    tile.info.maxLodLevel = coarsestSelectableLevel(tile.levelHeights);
    tile.info.bytes = estimatedFieldBytes();
    for (const uint32_t resolution : tile.info.resolutions) tile.info.bytes += estimatedLevelBytes(resolution);

    // A tile always carries a collider object, but only one inside `colliderRadius` is a real body:
    // without a factory the core hands out an empty one, so every tile reports as carrying a collider
    // and only the field's own collider-order copy comes with it.
    tile.info.hasCollider = !options_.createCollider;
    if (options_.createCollider) {
        if (options_.colliderFactoryThrows) {
            // The factory threw: the core releases the half-built tile, so nothing is resident.
            error.assign(kTerrainTileColliderCode);
            return nullptr;
        }
        if (withCollider) {
            tile.hasBody = true;
            tile.info.hasCollider = true;
        }
    }
    if (tile.info.hasCollider) tile.info.colliderHeights = colliderOrder(grid, columns, rows);
    tile.info.lodLevel = std::min(lodLevelForDistance(distance), tile.info.maxLodLevel);
    tiles_.push_back(std::move(tile));
    return &tiles_.back();
}

void TerrainTiles::giveBackBody(ITile& tile) {
    // The body and the collider-order copy that made it go back together; a tile with no factory keeps
    // its empty collider, so it never had either to give back.
    if (!tile.hasBody) return;
    colliderEvents_.push_back({tile.info.key, tile.info.tileX, tile.info.tileZ, false});
    tile.hasBody = false;
    tile.info.hasCollider = !options_.createCollider;
    tile.info.colliderHeights.clear();
}

void TerrainTiles::evict(ITile& tile) {
    if (tile.hasBody) giveBackBody(tile);
    // Every bridge that named this tile goes with it, as #removeStitchesForTile does.
    markBlockDirty(tile.info.lodLevel, tile.info.tileX, tile.info.tileZ);
    stitches_.erase(std::remove_if(stitches_.begin(), stitches_.end(),
                                   [&key = tile.info.key](const ITerrainStitchInfo& stitch) {
                                       return stitch.firstKey == key || stitch.secondKey == key;
                                   }),
                    stitches_.end());
    stitchBytes_ = 0;
    for (const ITerrainStitchInfo& stitch : stitches_) stitchBytes_ += stitch.bytes;
    tiles_.erase(std::remove_if(tiles_.begin(), tiles_.end(),
                                [&key = tile.info.key](const ITile& one) { return one.info.key == key; }),
                 tiles_.end());
}

void TerrainTiles::setLodLevel(ITile& tile, uint32_t level, bool countTransition) {
    const uint32_t selectable = std::min(level, tile.info.maxLodLevel);
    if (selectable == tile.info.lodLevel) return;
    const uint32_t previous = tile.info.lodLevel;
    // The tile leaves its old level's block and joins the new level's: the old one is now holding
    // ground this tile is no longer at.
    markBlockDirty(previous, tile.info.tileX, tile.info.tileZ);
    tile.info.lodLevel = selectable;
    markBlockDirty(selectable, tile.info.tileX, tile.info.tileZ);
    ringEpoch_ += 1;
    if (!countTransition) {
        tile.hasTransition = false;
        return;
    }
    lodTransitions_ += 1;
    tile.hasTransition = true;
    tile.lodTransition = {previous, selectable, 0, kLodTransitionFrames};
}

bool TerrainTiles::hasPendingTarget(const std::map<std::string, uint32_t>& targets) const {
    for (const auto& [key, target] : targets) {
        const ITerrainTileInfo* found = find(key);
        if (found != nullptr && std::min(target, found->maxLodLevel) != found->lodLevel) return true;
    }
    return false;
}

void TerrainTiles::applyLodTargets(const std::map<std::string, uint32_t>& targets) {
    // A ring already holding every level it asks for has no target to reshape, so the neighbour
    // fixpoint is skipped and a still follow point stays off the pair walk entirely.
    if (!hasPendingTarget(targets)) return;
    std::map<std::string, uint32_t> levels;
    for (const ITile& tile : tiles_) {
        const auto target = targets.find(tile.info.key);
        levels[tile.info.key] =
            std::min(target == targets.end() ? tile.info.lodLevel : target->second, tile.info.maxLodLevel);
    }
    // coordinatedLevels: a coarser neighbour moves to one level past the finer, until no pair of
    // resident neighbours is two levels apart.
    bool changed = true;
    while (changed) {
        changed = false;
        for (const ITile& a : tiles_) {
            for (const auto [dx, dz] : {std::pair{1, 0}, std::pair{0, 1}}) {
                const ITile* b = findTile(keyFor(a.info.tileX + dx, a.info.tileZ + dz));
                if (b == nullptr) continue;
                const uint32_t aLevel = levels[a.info.key];
                const uint32_t bLevel = levels[b->info.key];
                if (std::abs(static_cast<int>(aLevel) - static_cast<int>(bLevel)) <= 1) continue;
                if (aLevel > bLevel) levels[a.info.key] = bLevel + 1;
                else levels[b->info.key] = aLevel + 1;
                changed = true;
            }
        }
    }
    for (const auto& [key, level] : levels) {
        if (targets.find(key) == targets.end()) continue;
        if (ITile* found = findTile(key)) setLodLevel(*found, level, true);
    }
}

void TerrainTiles::coordinateNeighborLods(bool countTransitions) {
    // neighborLodCorrection's rule at the levels the ring holds now, to a fixpoint.
    bool changed = true;
    while (changed) {
        changed = false;
        for (ITile& a : tiles_) {
            for (const auto [dx, dz] : {std::pair{1, 0}, std::pair{0, 1}}) {
                ITile* b = findTile(keyFor(a.info.tileX + dx, a.info.tileZ + dz));
                if (b == nullptr) continue;
                if (std::abs(static_cast<int>(a.info.lodLevel) - static_cast<int>(b->info.lodLevel)) <= 1)
                    continue;
                ITile* finer = a.info.lodLevel < b->info.lodLevel ? &a : b;
                ITile* coarser = finer == &a ? b : &a;
                const uint32_t before = coarser->info.lodLevel;
                setLodLevel(*coarser, finer->info.lodLevel + 1, countTransitions);
                if (coarser->info.lodLevel != before) changed = true;
            }
        }
    }
}

void TerrainTiles::updateColliders(int32_t centerX, int32_t centerZ,
                                   const TerrainTileAdmission& admission) {
    if (!options_.createCollider) return;
    for (ITile& tile : tiles_) {
        const bool wanted = wantsCollider(tile.info.tileX, tile.info.tileZ, centerX, centerZ);
        if (wanted == tile.hasBody) continue;
        if (!wanted) {
            giveBackBody(tile);
            ringEpoch_ += 1;
            continue;
        }
        std::vector<float> grid;
        if (options_.colliderFactoryThrows || !heights_->tileGrid(tile.info.tileX, tile.info.tileZ, grid)) {
            deferredAdmissions_ = 1;
            continue;
        }
        // The 3x3 ring around the followed point is never refused: a probe under the walk point asks
        // the physics world for ground that is not there yet. Every other tile keeps its deferral.
        const bool near =
            std::max(std::abs(tile.info.tileX - centerX), std::abs(tile.info.tileZ - centerZ)) <= 1;
        const auto created = [&] {
            tile.hasBody = true;
            tile.info.hasCollider = true;
            tile.info.colliderHeights = colliderOrder(grid, tile.info.columns, tile.info.rows);
            colliderEvents_.push_back({tile.info.key, tile.info.tileX, tile.info.tileZ, true});
        };
        if (!admission || near) {
            created();
            ringEpoch_ += 1;
        } else if (!admission(created)) {
            deferredAdmissions_ = 1;
        }
    }
}

void TerrainTiles::seamPass() {
    // The shipped frame's change detector: every writer of residency, LOD or bodies bumped the epoch,
    // so a settled ring is decided by this integer and the pair walk is skipped. Under validation the
    // whole ring is still compared, because that is the only detector left for a writer that reached
    // past this class's own bookkeeping.
    if (!options_.validate && ringEpoch_ == static_cast<uint64_t>(seamEpoch_)) return;
    // Every facing pair whose two rendered levels differ in resolution needs a bridge; a pair at one
    // resolution loses its bridge. What a bridge costs follows from the finer level alone.
    std::vector<ITerrainStitchInfo> wanted;
    for (const ITile& a : tiles_) {
        for (const auto [dx, dz] : {std::pair{1, 0}, std::pair{0, 1}}) {
            const ITile* b = findTile(keyFor(a.info.tileX + dx, a.info.tileZ + dz));
            if (b == nullptr) continue;
            const uint32_t aResolution = a.info.resolutions[renderedLevel(a)];
            const uint32_t bResolution = b->info.resolutions[renderedLevel(*b)];
            if (aResolution == bResolution) continue;
            const uint32_t finer = std::max(aResolution, bResolution);
            wanted.push_back({std::min(a.info.key, b->info.key), std::max(a.info.key, b->info.key), finer,
                              static_cast<uint64_t>(finer) * 6 * sizeof(float) * 2 +
                                  static_cast<uint64_t>(finer - 1) * kBridgeIndicesPerSegment *
                                      sizeof(uint32_t)});
        }
    }
    stitches_ = std::move(wanted);
    stitchBytes_ = 0;
    for (const ITerrainStitchInfo& stitch : stitches_) stitchBytes_ += stitch.bytes;
    ringEpoch_ += 1;
    seamEpoch_ = static_cast<int64_t>(ringEpoch_);
}

void TerrainTiles::markBlockDirty(uint32_t lod, int32_t tileX, int32_t tileZ) {
    if (!options_.mergeTiles) return;
    dirtyBlocks_.insert(blockKeyFor(lod, tileX, tileZ));
}

void TerrainTiles::rebuildDirtyBlock(const TerrainTileAdmission& admission) {
    if (!options_.mergeTiles || dirtyBlocks_.empty()) return;
    // One rebuild a frame whatever the allowance still holds, always the lowest waiting key, so the
    // same ring dirties the same block first every time. A refused rebuild stays dirty and the next
    // follow runs it.
    const std::string block = *dirtyBlocks_.begin();
    if (admission && !admission([&] { dirtyBlocks_.erase(block); })) {
        deferredAdmissions_ = 1;
        return;
    }
    dirtyBlocks_.erase(block);
}

bool TerrainTiles::follow(double x, double z, const TerrainTileAdmission& admission, std::string& error,
                          TerrainTileBudgetReason& reason) {
    reason = TerrainTileBudgetReason::kNone;
    if (released_) {
        error.assign(kTerrainTileReleasedCode);
        return false;
    }
    if (!finiteNumber(x) || !finiteNumber(z)) {
        error.assign(kTerrainTileFiniteCode);
        return false;
    }
    // This pass starts owing nothing; a refusal below sets the flag that owes the next one.
    deferredAdmissions_ = 0;
    // The first follow of an owner's life has no settled ring to coordinate against, so the neighbour
    // rule shapes its levels without counting them as transitions.
    const bool hadFocus = hasFocus_;
    hasFocus_ = true;

    const int32_t centerX =
        static_cast<int32_t>(std::floor((x + options_.tileSize / 2.0) / options_.tileSize));
    const int32_t centerZ =
        static_cast<int32_t>(std::floor((z + options_.tileSize / 2.0) / options_.tileSize));
    const int32_t reach = static_cast<int32_t>(options_.streamRadius);

    struct IWanted {
        double distance;
        int32_t tileX;
        int32_t tileZ;
    };
    std::vector<IWanted> wanted;
    for (int32_t tileZ = centerZ - reach; tileZ <= centerZ + reach; tileZ += 1)
        for (int32_t tileX = centerX - reach; tileX <= centerX + reach; tileX += 1) {
            const double dx = x - static_cast<double>(tileX) * options_.tileSize;
            const double dz = z - static_cast<double>(tileZ) * options_.tileSize;
            wanted.push_back({std::hypot(dx, dz), tileX, tileZ});
        }
    // Nearest first, then a total order, so two tiles at the same distance always break the same way.
    std::sort(wanted.begin(), wanted.end(), [](const IWanted& a, const IWanted& b) {
        if (a.distance != b.distance) return a.distance < b.distance;
        if (a.tileZ != b.tileZ) return a.tileZ < b.tileZ;
        return a.tileX < b.tileX;
    });
    if (wanted.size() > options_.residentTileBudget) wanted.resize(options_.residentTileBudget);

    std::vector<std::string> selectedKeys;
    selectedKeys.reserve(wanted.size());
    for (const IWanted& candidate : wanted) selectedKeys.push_back(keyFor(candidate.tileX, candidate.tileZ));

    // Anything this pass did not select leaves the ring whole, so a tile the next `follow` wants
    // again is admitted from nothing rather than half released.
    std::vector<std::string> leaving;
    for (const ITile& tile : tiles_)
        if (std::find(selectedKeys.begin(), selectedKeys.end(), tile.info.key) == selectedKeys.end())
            leaving.push_back(tile.info.key);
    for (const std::string& key : leaving) {
        if (ITile* found = findTile(key)) evict(*found);
        ringEpoch_ += 1;
    }

    std::map<std::string, uint32_t> targets;
    const uint64_t estimate = estimatedTileBytes();
    uint32_t built = 0;
    for (const IWanted& candidate : wanted) {
        const std::string key = keyFor(candidate.tileX, candidate.tileZ);
        if (findTile(key) != nullptr) {
            targets[key] = lodLevelForDistance(candidate.distance);
            continue;
        }
        // The estimate the admission is judged on: every level plus the field, as one whole unit.
        if (residentBytes() + estimate > options_.residentByteBudget) {
            if (candidate.tileX == centerX && candidate.tileZ == centerZ) {
                reason = TerrainTileBudgetReason::kTile;
                error.assign(kTerrainTileBudgetCode);
                return false;
            }
            continue;
        }
        // One tile is one unit: every level is built and the body made inside it. A budget may not
        // refuse the pass's first tile, because a ring that never converges is a hole that never
        // closes, so the forced one is the nearest tile still missing.
        const bool withCollider = wantsCollider(candidate.tileX, candidate.tileZ, centerX, centerZ);
        ITile* admitted = nullptr;
        std::string tileError;
        const auto created = [&] {
            admitted = buildTile(candidate.tileX, candidate.tileZ, candidate.distance, withCollider,
                                 tileError);
        };
        if (!admission || built == 0) created();
        else if (!admission(created)) {
            deferredAdmissions_ = 1;
            continue;
        }
        if (admitted == nullptr) {
            error = tileError;
            return false;
        }
        built += 1;
        if (residentBytes() > options_.residentByteBudget) {
            // The built tile overran, so it is released whole rather than left half in the ring.
            if (admitted->hasBody) giveBackBody(*admitted);
            tiles_.pop_back();
            if (candidate.tileX == centerX && candidate.tileZ == centerZ) {
                reason = TerrainTileBudgetReason::kTile;
                error.assign(kTerrainTileBudgetCode);
                return false;
            }
            continue;
        }
        if (admitted->hasBody)
            colliderEvents_.push_back({admitted->info.key, admitted->info.tileX, admitted->info.tileZ, true});
        markBlockDirty(admitted->info.lodLevel, admitted->info.tileX, admitted->info.tileZ);
        ringEpoch_ += 1;
        recordPeaks();
    }
    recordPeaks();

    updateColliders(centerX, centerZ, admission);
    applyLodTargets(targets);
    // Retargeting already coordinates the resident ring; only newly admitted tiles can owe it.
    if (built > 0) coordinateNeighborLods(hadFocus);
    seamPass();
    // After every LOD target is settled, so a block is built from the levels this pass left behind.
    rebuildDirtyBlock(admission);
    if (residentBytes() > options_.residentByteBudget) {
        reason = TerrainTileBudgetReason::kStitch;
        error.assign(kTerrainTileBudgetCode);
        return false;
    }
    recordPeaks();
    return true;
}

void TerrainTiles::process() {
    if (released_) return;
    for (ITile& tile : tiles_) {
        if (!tile.hasTransition) continue;
        tile.lodTransition.elapsedFrames += 1;
        tile.lodTransition.remainingFrames -= 1;
        ringEpoch_ += 1;
        if (tile.lodTransition.remainingFrames > 0) continue;
        maxLodTransitionFrames_ = std::max(maxLodTransitionFrames_, tile.lodTransition.elapsedFrames);
        tile.hasTransition = false;
        markBlockDirty(tile.info.lodLevel, tile.info.tileX, tile.info.tileZ);
    }
    seamPass();
}

void TerrainTiles::dispose() {
    if (released_) return;
    released_ = true;
    for (ITile& tile : tiles_)
        if (tile.hasBody) giveBackBody(tile);
    tiles_.clear();
    stitches_.clear();
    dirtyBlocks_.clear();
    stitchBytes_ = 0;
}

void TerrainTiles::recordPeaks() {
    peakTiles_ = std::max(peakTiles_, residentTileCount());
    peakBytes_ = std::max(peakBytes_, residentBytes());
}

std::vector<std::string> TerrainTiles::residentKeys() const {
    std::vector<std::string> keys;
    keys.reserve(tiles_.size());
    for (const ITile& tile : tiles_) keys.push_back(tile.info.key);
    std::sort(keys.begin(), keys.end());
    return keys;
}

std::vector<std::string> TerrainTiles::residentKeysInOrder() const {
    std::vector<std::string> keys;
    keys.reserve(tiles_.size());
    for (const ITile& tile : tiles_) keys.push_back(tile.info.key);
    return keys;
}

std::vector<std::string> TerrainTiles::residentColliderKeys() const {
    std::vector<std::string> keys;
    for (const ITile& tile : tiles_)
        if (tile.info.hasCollider) keys.push_back(tile.info.key);
    std::sort(keys.begin(), keys.end());
    return keys;
}

std::vector<ITerrainStitchInfo> TerrainTiles::stitches() const { return stitches_; }

uint32_t TerrainTiles::blendingTiles() const {
    uint32_t count = 0;
    for (const ITile& tile : tiles_)
        if (tile.hasTransition) count += 1;
    return count;
}

} // namespace tn::engine::world