#pragma once

#include <array>
#include <cstdint>
#include <memory>
#include <span>
#include <vector>

#include "atlas.h"
#include "engine/renderer/compute.h"

namespace tn::engine::shadows {

/**
 * PRD-775: one frame's static virtual pages as data for the GPU, as Unreal builds its per-page draw commands
 * (UE 5.8.3: Engine/Shaders/Private/VirtualShadowMaps/VirtualShadowMapBuildPerPageDrawCommands.usf:155, :307). The CPU
 * writes the pages to draw and one row per caster into the frame storage `vsmPlan` (vec4<f32>); `pageCullProgram`
 * turns each row's instance boxes into (instance, page) records in `vsmRecords` and counts them into the row's
 * indirect arguments in `vsmArgs` (five words a row). One depth pass then draws all pages of a level.
 *
 * `vsmPlan`, in vec4s; every field below 2^24, so a float holds it exactly:
 *   page  (2): [slot scale, x offset, y offset, 0], [slot rect min x, min y, max x, max y], all in atlas clip space
 *   level (4): [axisU, lowU], [axisV, lowV], [highU, highV, cellU, cellV], [tiles, lookup at, 0, 0]
 *   lookup (tiles x tiles): x is the vec4 offset of the cell's drawn page plus one, zero when the cell draws nothing
 *   row   (7): [box centre, cull], [box half size, instance base], the four model columns,
 *              [record base, record capacity, instanceCount word in vsmArgs, level at]
 *   chunk (1): [row at, first instance, instance count, 0]
 */
class GpuPagePlan {
public:
    struct Level {
        uint32_t levelAt = 0, firstPage = 0, pageCount = 0, tiles = 0;
    };
    enum class Cull : uint8_t {
        OwnBox = 0,        // the world box `box` places every instance of the row
        EachInstance = 1,  // `box` is local: model * instance matrix places each instance
        Everywhere = 2,    // no bounds to place it by: every drawn page of the level
    };
    struct Row {
        Cull cull = Cull::OwnBox;
        Box3 box;
        const std::array<double, 16>* model = nullptr;  // null: identity
        Vector3 largest;                // the largest instance box, in world units, per axis; sizes the records
        uint32_t instances = 0;
        double instanceBase = 0;
        uint32_t drawCount = 0;  // the row's index or vertex count
    };

    /** Both vectors are the frame storages' own (`vsmPlan`, `vsmArgs`), emptied by the plan. */
    GpuPagePlan(std::vector<float>& plan, std::vector<float>& args) : plan_(plan), args_(args) {}
    /** `drawn` holds the level's pages to draw; `stand` is the one whose projection the rows' uniforms carry. */
    Level addLevel(const PageAtlas& atlas, int level, std::span<const AtlasPage> drawn, const AtlasPage& stand);
    /** The row's record base, for its per-draw uniform. Its indirect record is `rowCount() - 1`, five words long. */
    uint32_t addRow(const PageAtlas& atlas, int level, const Level& at, const Row& row);
    /** Appends the chunks. Throws TN_VIRTUAL_SHADOW_RECORDS past what a float record base can hold. */
    void finish();
    uint32_t rowCount() const { return rows_; }
    uint32_t chunkBase() const { return chunkBase_; }
    uint32_t chunkCount() const { return chunkCount_; }
    uint64_t recordBytes() const { return records_ * 8; }

private:
    std::vector<float>& plan_;
    std::vector<float>& args_;
    std::vector<float> chunks_;
    uint64_t records_ = 0;
    uint32_t rows_ = 0, chunkBase_ = 0, chunkCount_ = 0;
};

/** The cull kernel: storage buffers vsmPlan, instances, vsmRecords, vsmArgs; uniforms pageChunkBase, pageChunkCount. */
shader::Program pageCullProgram();
/** The vertex stage of the instanced quads that reset the drawn slots to the far plane; instance = plan offset / 2. */
shader::Program pageClearProgram();

}  // namespace tn::engine::shadows
