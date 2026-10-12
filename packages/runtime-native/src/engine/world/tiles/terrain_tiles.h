#pragma once

#include <cstdint>
#include <functional>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <vector>

namespace tn::engine::world {

/** Every constructor or `follow` refusal in this file is one of these names. */
inline constexpr std::string_view kTerrainTileFiniteCode = "TN_TERRAIN_TILES_FINITE";
inline constexpr std::string_view kTerrainTilePositiveCode = "TN_TERRAIN_TILES_POSITIVE";
inline constexpr std::string_view kTerrainTileIntegerCode = "TN_TERRAIN_TILES_INTEGER";
inline constexpr std::string_view kTerrainTileFactorCode = "TN_TERRAIN_TILES_FACTOR";
inline constexpr std::string_view kTerrainTileThresholdCode = "TN_TERRAIN_TILES_THRESHOLD";
inline constexpr std::string_view kTerrainTileTopologyCode = "TN_TERRAIN_TILES_TOPOLOGY";
inline constexpr std::string_view kTerrainTileBudgetCode = "TN_TERRAIN_TILES_BUDGET";
inline constexpr std::string_view kTerrainTileFieldCode = "TN_TERRAIN_TILES_FIELD";
inline constexpr std::string_view kTerrainTileColliderCode = "TN_TERRAIN_TILES_COLLIDER";
inline constexpr std::string_view kTerrainTileReleasedCode = "TN_TERRAIN_TILES_RELEASED";

/** A per-frame allowance: run one unit and charge the frame, or report that there was no room. */
using TerrainTileAdmission = std::function<bool(const std::function<void()>&)>;

/**
 * The game's own heightfield samples, one tile at a time. `TerrainTiles` never authors a height:
 * the game supplies the field's canonical row-major grid, exactly as `sampleHeight` supplies it to
 * `Heightfield.fromSampler`, and every decision here reads that grid.
 */
class IHeightGridSource {
  public:
    virtual ~IHeightGridSource() = default;

    /** `columns * rows` row-major canonical samples for `(tileX, tileZ)`, or false when absent. */
    virtual bool tileGrid(int32_t tileX, int32_t tileZ, std::vector<float>& heights) = 0;
};

/** The measured region the topology evaluator owns; its retained samples count against the cap. */
struct TerrainTileTopologyObservation {
    uint32_t columns = 0;
    uint32_t rows = 0;
    double width = 0.0;
    double depth = 0.0;
};

/** One tile's decisions: its bytes, its levels, and the collider body it holds or does not. */
struct ITerrainTileInfo {
    std::string key;
    int32_t tileX = 0;
    int32_t tileZ = 0;
    double originX = 0.0;
    double originZ = 0.0;
    double width = 0.0;
    double depth = 0.0;
    uint64_t bytes = 0;
    uint32_t lodLevel = 0;
    uint32_t maxLodLevel = 0;
    uint32_t columns = 0;
    uint32_t rows = 0;
    std::vector<uint32_t> resolutions;
    /** False for a resident tile outside `colliderRadius`; no body exists without one. */
    bool hasCollider = false;
    /** The field's collider-order copy, held only while the tile carries a body. */
    std::vector<float> colliderHeights;
};

/** One body created or handed back, in the order the residency walk did it. */
struct ITerrainColliderEvent {
    std::string key;
    int32_t tileX = 0;
    int32_t tileZ = 0;
    bool created = false;
};

/** One mixed-LOD neighbour pair that needs a stitch bridge, and what that bridge costs. */
struct ITerrainStitchInfo {
    std::string firstKey;
    std::string secondKey;
    uint32_t resolution = 0;
    uint64_t bytes = 0;
};

/** Why a hard cap was hit; the core module's three budget messages name these three. */
enum class TerrainTileBudgetReason : uint32_t {
    kNone = 0,
    kTopology = 1,
    kTile = 2,
    kStitch = 3,
};

/** One residency owner's options, with the core module's own defaults spelled out. */
struct ITerrainTilesOptions {
    double tileSize = 0.0;
    uint32_t tileResolution = 0;
    uint32_t residentTileBudget = 0;
    uint64_t residentByteBudget = 0;
    double skirtDepth = 0.0;
    uint32_t streamRadius = 1;
    uint32_t colliderRadius = 0;
    bool colliderRadiusSet = false;
    std::vector<uint32_t> lodFactors{1, 2, 4};
    std::vector<double> lodDistances;
    bool lodDistancesSet = false;
    bool createCollider = false;
    /** The game's `createCollider` throws, so the half-built tile is released instead of resident. */
    bool colliderFactoryThrows = false;
    /** Merge settled same-LOD tiles into super-tiles; one block rebuild is charged per follow. */
    bool mergeTiles = true;
    bool validate = false;
    std::optional<TerrainTileTopologyObservation> topologyObservation;
};

/**
 * Tile admission, LOD levels and collider placement, ported from
 * packages/core/src/world-tiles.ts (PRD-521 box 38).
 *
 * What is ported is the set of decisions: which tiles a `follow` wants and in what order under the
 * caps, which of those it defers or evicts, the level each resident tile may show, which tiles carry
 * a collider body and where its samples sit, and what every tile, bridge and measured region costs
 * against the byte cap. Rendering is not ported: no mesh, no bridge geometry, no material, and the
 * seam's geometry state with it. The LOD pop bound is level arithmetic over the field's own grid, so
 * the coarsest level a tile may show comes with it.
 *
 * Every height comes from the game's own field through `IHeightGridSource`, so the recorded table and
 * this port read the same samples rather than two samplers that might disagree.
 */
class TerrainTiles {
  public:
    /**
     * Builds one residency owner. On any refused option returns nullopt and sets `error` to a
     * `kTerrainTile*` code, so a malformed configuration fails closed instead of streaming.
     */
    static std::optional<TerrainTiles> create(const ITerrainTilesOptions& options,
                                              IHeightGridSource& heights, std::string& error);

    /**
     * Moves residency to the followed point. Returns false and sets `error` to kTerrainTileBudgetCode
     * and `reason` to the cap that could not fit what `TerrainTileBudgetError` names in the core.
     */
    bool follow(double x, double z, const TerrainTileAdmission& admission, std::string& error,
                TerrainTileBudgetReason& reason);

    /** Advances the LOD transitions a `follow` started; a blend is three frames long. */
    void process();

    /** Releases every tile, its body and its field. Idempotent, as `dispose` is. */
    void dispose();

    bool released() const { return released_; }
    uint32_t residentTileCount() const { return static_cast<uint32_t>(tiles_.size()); }
    uint64_t residentBytes() const;
    uint64_t topologyBytes() const { return topologyBytes_; }
    uint64_t stitchBytes() const { return stitchBytes_; }
    uint32_t peakResidentTileCount() const { return peakTiles_; }
    uint64_t peakResidentBytes() const { return peakBytes_; }
    uint32_t deferredAdmissions() const { return deferredAdmissions_; }
    uint32_t lodTransitions() const { return lodTransitions_; }
    uint32_t blendingTiles() const;
    uint32_t maxLodTransitionFrames() const { return maxLodTransitionFrames_; }
    /** The change detector every writer of residency, LOD and bodies bumps; the seam pass reads it. */
    uint64_t ringEpoch() const { return ringEpoch_; }

    /** Resident keys sorted, as `residentKeys` reports them. */
    std::vector<std::string> residentKeys() const;
    /** Resident keys in insertion order, which is the order the collider walk reads them in. */
    std::vector<std::string> residentKeysInOrder() const;
    /** Resident keys that carry a body, sorted, as `residentColliderKeys` reports them. */
    std::vector<std::string> residentColliderKeys() const;
    /** One tile's decisions, or nullptr when it is not resident. */
    const ITerrainTileInfo* tile(const std::string& key) const;
    /** The bodies created and handed back since the last call, in order; the call takes them. */
    std::vector<ITerrainColliderEvent> takeColliderEvents() {
        std::vector<ITerrainColliderEvent> taken;
        taken.swap(colliderEvents_);
        return taken;
    }
    /** Mixed-LOD neighbour pairs that need a bridge, with what each one costs. */
    std::vector<ITerrainStitchInfo> stitches() const;

  private:
    struct ITransition {
        uint32_t from = 0;
        uint32_t to = 0;
        uint32_t elapsedFrames = 0;
        uint32_t remainingFrames = 0;
    };

    struct ITile {
        ITerrainTileInfo info;
        std::vector<std::vector<float>> levelHeights;
        ITransition lodTransition;
        bool hasTransition = false;
        bool hasBody = false;
    };

    uint32_t resolutionFor(uint32_t factor) const;
    uint64_t estimatedLevelBytes(uint32_t resolution) const;
    uint64_t estimatedFieldBytes() const;
    uint64_t estimatedTileBytes() const;
    uint32_t coarsestSelectableLevel(const std::vector<std::vector<float>>& levels) const;
    bool wantsCollider(int32_t tileX, int32_t tileZ, int32_t centerX, int32_t centerZ) const;
    uint32_t lodLevelForDistance(double distance) const;
    /** The level whose surface the renderer shows: the finer one while a blend is in flight. */
    uint32_t renderedLevel(const ITile& tile) const;
    ITile* findTile(const std::string& key);
    /** The tile's own record, or nullptr when it is not resident. */
    const ITerrainTileInfo* find(const std::string& key) const;
    ITile* buildTile(int32_t tileX, int32_t tileZ, double distance, bool withCollider, std::string& error);
    void giveBackBody(ITile& tile);
    void evict(ITile& tile);
    void setLodLevel(ITile& tile, uint32_t level, bool countTransition);
    bool hasFocus_ = false;
    bool hasPendingTarget(const std::map<std::string, uint32_t>& targets) const;
    void applyLodTargets(const std::map<std::string, uint32_t>& targets);
    void coordinateNeighborLods(bool countTransitions);
    void updateColliders(int32_t centerX, int32_t centerZ, const TerrainTileAdmission& admission);
    void markBlockDirty(uint32_t lod, int32_t tileX, int32_t tileZ);
    void rebuildDirtyBlock(const TerrainTileAdmission& admission);
    void seamPass();
    void recordPeaks();

    ITerrainTilesOptions options_;
    IHeightGridSource* heights_ = nullptr;
    std::vector<ITile> tiles_;
    std::vector<ITerrainColliderEvent> colliderEvents_;
    std::vector<ITerrainStitchInfo> stitches_;
    /** The super-tile blocks a residency or LOD change left waiting, as `lod:blockX:blockZ`. */
    std::set<std::string> dirtyBlocks_;
    uint64_t topologyBytes_ = 0;
    uint64_t stitchBytes_ = 0;
    uint64_t peakBytes_ = 0;
    uint32_t peakTiles_ = 0;
    uint32_t deferredAdmissions_ = 0;
    uint32_t lodTransitions_ = 0;
    uint32_t maxLodTransitionFrames_ = 0;
    uint64_t ringEpoch_ = 0;
    int64_t seamEpoch_ = -1;
    bool released_ = false;
};

} // namespace tn::engine::world