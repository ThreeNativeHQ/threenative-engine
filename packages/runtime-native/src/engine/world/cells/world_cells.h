#pragma once

#include "engine/world/package/world_package.h"
#include "engine/world/tiles/terrain_tiles.h"

#include <array>
#include <functional>
#include <map>
#include <limits>
#include <optional>
#include <span>
#include <string>
#include <vector>

namespace tn::engine::world {

struct IWorldCellsOptions {
    double ring = 1;
    double residentCells = 25;
    double instances = 20000;
    double bytes = 8000000;
    double admissionBudgetMs = 2;
    double rebuildsPerUpdate = 16;
    double concurrency = 12;
    double chunkMergeMaxTriangles = 43690;
    double prefetchSeconds = 1.5;
    double fovY = 60;
    double viewportHeight = 1080;
    double maxPixelError = 4;
};

/** A loader's CPU observation, not a mesh: each part's baked errors and triangles per shape. */
struct IWorldCellPart {
    std::vector<double> errors;
    std::vector<uint32_t> triangles;
    bool alpha = false;
};
using WorldCellModel = std::vector<IWorldCellPart>;

struct IWorldCellDraw {
    std::string key;
    uint32_t triangles = 0;
    /** Placement roots in the original f32 representation; order is not a shared-buffer slot. */
    std::vector<std::array<float, 3>> roots;
};

/** CPU decisions ported from WorldCells. Terrain is the existing TerrainTiles owner; clocks and
 * completed model observations come from the caller. This owns no renderer, geometry or GPU object.
 * Call completeAsset on the game thread after a load completes, update once per frame, and take the
 * resulting draws to build the renderer's batches. Queued replacements leave the old draws intact.
 */
class WorldCells {
  public:
    static std::optional<WorldCells> create(const json::Value& manifest,
        std::span<const std::byte> placements, const IWorldCellsOptions& options,
        TerrainTiles* terrain, std::string& error);
    void update(double x, double z, const std::function<double()>& now, bool companionPending = false);
    /** False for a completion whose asset has left residency; callers discard its model. */
    bool completeAsset(const std::string& id, const std::vector<WorldCellModel>& models);
    void dispose();

    std::vector<std::string> residentKeys() const;
    std::vector<std::string> residentKeysInOrder() const;
    std::vector<std::pair<std::string, uint32_t>> assetRefCounts() const;
    std::vector<IWorldCellDraw> draws() const;
    std::map<std::string, std::vector<double>> reportedChainDistances() const;
    uint64_t instances() const { return instances_; }
    uint64_t residentBytes() const { return bytes_; }
    uint32_t evictions() const { return evictions_; }
    uint32_t refilters() const { return refilters_; }
    uint32_t refilterEntries() const { return refilterEntries_; }
    uint32_t rebuilds() const { return rebuilds_; }
    uint32_t deferred() const { return static_cast<uint32_t>(jobs_.size()); }
    uint32_t backlog() const;
    double spentMs() const { return spentMs_; }
    double terrainSpentMs() const { return terrainSpentMs_; }
    const std::array<uint32_t, 3>& pressure() const { return pressure_; }

  private:
    struct Run { std::string asset; std::vector<float> records; };
    struct Cell { double x = 0, z = 0; std::vector<Run> runs; uint64_t instances = 0; };
    struct Asset {
        std::string id;
        uint32_t refs = 0;
        std::optional<double> maxDistance;
        std::vector<double> distances, gates;
        std::vector<WorldCellModel> levels;
        std::optional<double> threshold;
        bool authored = false;
        bool chained = false;
    };
    struct Batch {
        std::size_t run = 0;
        double x = 0, z = 0;
        std::vector<int32_t> levels;
    };
    struct Resident {
        std::size_t cell = 0;
        double near = std::numeric_limits<double>::infinity(), far = -std::numeric_limits<double>::infinity();
        std::vector<Batch> batches;
    };
    struct Job {
        std::size_t cell = 0, run = 0, next = 0, published = 0;
        double x = 0, z = 0;
        std::vector<int32_t> levels;
    };
    Asset* asset(const std::string& id);
    Resident* resident(std::size_t cell);
    void queue(std::size_t cell, std::size_t run, bool replace = false);
    void evict(std::size_t cell);
    std::array<double, 2> span(std::size_t cell, double x, double z) const;
    std::array<double, 2> ahead(double x, double z, const std::function<double()>& now);
    void residency(double x, double z, double leadX, double leadZ);
    void refilter(double x, double z);
    bool step(Job& job);
    void noteGates(const Asset& asset);

    IWorldCellsOptions options_;
    TerrainTiles* terrain_ = nullptr;
    double cellSize_ = 0, minX_ = 0, minZ_ = 0;
    double x_ = 0, z_ = 0;
    double residencyX_ = std::numeric_limits<double>::infinity(), residencyZ_ = std::numeric_limits<double>::infinity();
    double refilterX_ = std::numeric_limits<double>::infinity(), refilterZ_ = std::numeric_limits<double>::infinity();
    std::optional<std::array<double, 3>> lastSample_;
    std::optional<std::array<double, 2>> lastCell_;
    double velocityX_ = 0, velocityZ_ = 0;
    uint64_t epoch_ = 0, filterEpoch_ = 0, instances_ = 0, bytes_ = 0;
    bool owed_ = false, released_ = false;
    uint32_t evictions_ = 0, refilters_ = 0, refilterEntries_ = 0, rebuilds_ = 0;
    double spentMs_ = 0, terrainSpentMs_ = 0;
    std::array<uint32_t, 3> pressure_{};
    std::vector<Cell> cells_;
    std::vector<Asset> definitions_, assets_;
    std::vector<Resident> residents_;
    std::vector<Job> jobs_;
    std::vector<double> gates_;
};

/** Counts and discriminators observed on each chunk mesh before the merge. Material identity is
 * game data. `vertices` counts the indexed shape, `indices` zero means non-indexed. */
struct IWorldChunkPart {
    uint32_t id = 0, material = 0, vertices = 0, indices = 0;
    uint32_t copies = 1;
    bool instanced = false, chain = false, morph = false, skinned = false, multiMaterial = false;
    bool normal = true, uv = true;
};
struct IWorldChunkGroup {
    uint32_t material = 0, vertices = 0, indices = 0, indexBytes = 0;
    uint64_t bytes = 0;
    /** (source id, instance) in traversal/expansion order. Ordinary meshes use instance zero. */
    std::vector<std::array<uint32_t, 2>> parts;
};
struct IWorldChunkMerge {
    bool refused = false;
    uint32_t expanded = 0, keptInstanced = 0;
    uint64_t bytes = 0;
    std::vector<uint32_t> kept;
    std::vector<IWorldChunkGroup> groups;
};
/** The 4 MiB limit is the TS vertex allowance, not a cap including index bytes. A single large
 * authored part is not split. These two deliberate TS semantics are reproduced by the fixture. */
IWorldChunkMerge mergeWorldChunk(std::span<const IWorldChunkPart> parts,
    uint32_t maxTriangles = 43690);

} // namespace tn::engine::world
