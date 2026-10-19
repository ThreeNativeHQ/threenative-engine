#pragma once

#include <array>
#include <filesystem>
#include <memory>
#include <optional>
#include <set>

#include "engine/player/run.h"
#include "engine/scene/camera.h"
#include "engine/scene/nodes.h"
#include "engine/world/admission/package_loads.h"
#include "engine/world/cells/world_cells.h"
#include "engine/world/terrain/heights.h"

namespace tn::engine::player {

/** PRD-522's bounded four-cell cooked world. Recovery::Skip holds a bad cell absent until unload.
 * CPU samples are allocator bytes, GPU bytes are streamed buffers/textures plus the fixture's
 * attribute/index stores (fixed renderer targets/programs excluded); handle samples cover the whole
 * renderer's GpuResources. Eight rendered settling ticks and no pending destroys precede samples.
 * Noise band: CPU ±64 KiB/cycle and ≤512 KiB range; GPU bytes and handles have zero tolerance.
 */
class WorldWalk {
  public:
    explicit WorldWalk(std::string mode, std::filesystem::path fixture);
    Game game();
    json::Value snapshot() const;

  private:
    struct Cell {
        std::string asset, key, file;
        std::array<double, 2> origin{};
        uint64_t request = 0, generation = 0;
        uint64_t bufferBytes = 0, textureBytes = 0;
        bool ready = false;
        std::vector<LoadedEntry> entries;
        std::shared_ptr<BufferGeometry> geometry;
        std::shared_ptr<Mesh> mesh;
    };
    struct Sample { double cpu, buffers, textures, handles, geometry; };
    void begin();
    void update();
    void frameComplete(Renderer& renderer, const std::vector<std::string>& diagnostics);
    void release(Cell& cell);
    void unload();
    void error(world::LoadError failure);
    static double slope(const std::vector<Sample>& samples, double Sample::*field);
    std::array<uint64_t, 2> gpuBytes() const;

    std::string mode_, phase_ = "ready";
    std::filesystem::path fixture_;
    Scene scene_;
    PerspectiveCamera camera_{50, 16.0 / 9, 0.1, 100};
    std::shared_ptr<Material> material_;
    std::shared_ptr<Material> rockMaterial_;
    std::shared_ptr<BufferGeometry> rockGeometry_;
    std::optional<world::HeightSampler> heights_;
    json::Value manifest_;
    std::vector<uint8_t> placements_;
    std::vector<Cell> cells_;
    std::optional<world::WorldCells> world_;
    std::unique_ptr<world::CompletionQueue> completions_;
    std::unique_ptr<world::PackageLoads> loads_;
    Renderer* renderer_ = nullptr;
    std::set<std::string> skipped_, visited_, rendererDiagnostics_;
    std::vector<world::LoadError> errors_;
    std::vector<Sample> samples_;
    uint32_t cycles_ = 0, walkTick_ = 0, settleTicks_ = 0, waitingTicks_ = 0;
    uint32_t completedLoads_ = 0, attempts_ = 0, evictions_ = 0, renderedWorldFrames_ = 0;
    uint64_t frameBytes_ = 0, maxBytes_ = 0, geometryUploaded_ = 0, frames_ = 0;
    uint32_t budgetViolations_ = 0, peakResident_ = 0, peakHandles_ = 0;
    double frameMs_ = 0, maxMs_ = 0, walked_ = 0, maxCameraX_ = 2;
    bool updated_ = false;
};

} // namespace tn::engine::player
