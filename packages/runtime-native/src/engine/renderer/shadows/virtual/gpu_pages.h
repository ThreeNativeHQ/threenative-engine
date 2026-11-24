#pragma once

#include <cstdint>
#include <vector>

#include <webgpu/webgpu.h>

#include "engine/foundation/handles.h"
#include "engine/renderer/pipeline_cache.h"

namespace tn::engine {
class GpuResources;
}

namespace tn::engine::shadows {

/**
 * One physical shadow page as the GPU reads it (PRD-775). Eight vec4s: the page's world-to-page clip matrix, its
 * atlas slot rect, the slot's clip scale and bias, the page's light-space bounds and its (level, x, y, slot) identity.
 */
struct VsmGpuPage {
    float viewProj[16];
    float slotRect[4];       // originX, originY, stride, invAtlasEdge
    float pageScaleBias[4];  // stride * invEdge, 2 * (originX + 0.5 * stride) * invEdge - 1, 1 - 2 * (originY + 0.5 * stride) * invEdge, 0
    float boundsUV[4];       // lowU, highU, lowV, highV
    uint32_t meta[4];        // level, x, y, slot
};
static_assert(sizeof(VsmGpuPage) == 128, "a VSM page is eight vec4s");

/** One clip level's caster-to-page grid as the cull kernel reads it: five vec4s. */
struct VsmLevelGridGpu {
    float axisU[4];    // ux, uy, uz, invCellU
    float axisV[4];    // vx, vy, vz, invCellV
    float bounds[4];   // lowU, highU, lowV, highV
    float params[4];   // slopU, slopV, f32(tiles), f32(tileLookupOffset)
    uint32_t counts[4];  // levelPageStart, levelPageCount, tiles, tileLookupOffset
};
static_assert(sizeof(VsmLevelGridGpu) == 80, "a VSM level is five vec4s");

/** One caster row the cull kernel walks: its model, local box, meta and dispatch window (four vec4s each). */
struct VsmCullDrawDesc {
    float model[16];
    float localMin[4];  // xyz box min, w maxPosOffset
    float localMax[4];  // xyz box max, w unused
    uint32_t drawMeta[4];  // x instanceBaseVec4, y instanceCount, z recordBase, w argsSlot
    uint32_t dispatch[4];  // x dispatchBase, y levelIdx, z maxRecords, w flag bits: bit0 instanced, bit1 unbounded
};
static_assert(sizeof(VsmCullDrawDesc) == 128, "a VSM cull row is eight vec4s");

struct VsmCullUniforms {
    uint32_t totalDraws = 0;
    uint32_t totalInstances = 0;
    uint32_t totalPages = 0;
    uint32_t levelCount = 0;
};
static_assert(sizeof(VsmCullUniforms) == 16, "VSM cull uniforms are four u32");

/**
 * The GPU half of PRD-775 Phase 1: one instanced page clear and one compute dispatch that turns caster rows into
 * (instance, page) records and indirect instance counts. It owns its pipelines, buffers and bind groups; the
 * renderer uploads a frame's inputs with prepareBuffers, then records dispatchCull and encodePageClears.
 */
class GpuVsmResources {
public:
    GpuVsmResources() = default;
    ~GpuVsmResources();
    GpuVsmResources(const GpuVsmResources&) = delete;
    GpuVsmResources& operator=(const GpuVsmResources&) = delete;

    /** Drops every cached bind group, so the next dispatch and clear rebuild against the current buffers. */
    void clearBindGroups();
    /** Releases the pipelines, layouts and buffers. Call before the device and its GpuResources go away. */
    void release();

    /**
     * Uploads one frame's cull inputs, growing each buffer by doubling, and writes every indirect record's
     * initial count. `argsSlots` is one past the highest record index used; `pageRecordCount` sizes the
     * (instance, page) output. `pagesBuffer` and `pageRecordsBuffer` are the renderer's own storages, so the
     * draws it binds read exactly the pages and records this prepares; `groupsGrew` tells the caller that any
     * buffer was reallocated and its bind groups must be rebuilt. False when the pipelines or a buffer are
     * unavailable.
     */
    bool prepareBuffers(GpuResources& gpu, WGPUDevice device, const std::vector<VsmCullDrawDesc>& draws,
                        const VsmCullUniforms& uniforms, const std::vector<VsmLevelGridGpu>& levels,
                        const std::vector<uint32_t>& tileLookup, const std::vector<VsmGpuPage>& pages,
                        const std::vector<uint32_t>& initialArgs, uint32_t argsSlots, uint32_t pageRecordCount,
                        Handle& pagesBuffer, uint64_t& pagesCap, Handle& pageRecordsBuffer,
                        uint64_t& pageRecordsCap, bool& groupsGrew);

    /** One thread per candidate instance: writes its surviving (instance, page) records and indirect counts. */
    void dispatchCull(WGPUCommandEncoder encoder, WGPUBuffer instances);

    /**
     * One instanced six-vertex draw clearing `pageCount` slots from `firstPage` to depth 1.0, inside the caller's
     * pass. `pageBuffer` is the renderer's `vsmGpuPages` storage, the same buffer the cull kernel wrote.
     */
    void encodePageClears(WGPURenderPassEncoder pass, WGPUBuffer pageBuffer, uint32_t pageCount,
                          uint32_t firstPage = 0);

    bool ready() const { return cullPipeline_ != nullptr && descs_.type != 0 && args_.type != 0; }
    uint32_t cullInvocations() const { return cullUniforms_.totalInstances; }
    /** The indirect records the batched VSM draws read, five u32 per slot. */
    WGPUBuffer argsBuffer() const;
    Handle argsHandle() const { return args_; }

private:
    bool ensurePipelines();
    bool ensureBuffer(Handle& handle, uint64_t& capacity, uint64_t bytes, WGPUBufferUsage usage, bool& grew);

    WGPUDevice device_ = nullptr;
    GpuResources* gpu_ = nullptr;
    WGPURenderPipeline pageClearPipeline_ = nullptr;
    WGPUBindGroupLayout pageClearLayout_ = nullptr;
    WGPUPipelineLayout pageClearPipelineLayout_ = nullptr;
    WGPUComputePipeline cullPipeline_ = nullptr;
    WGPUBindGroupLayout cullLayout_ = nullptr;
    WGPUPipelineLayout cullPipelineLayout_ = nullptr;
    RecentBindGroups pageClearGroups_{2};
    RecentBindGroups cullGroups_{4};
    Handle descs_{}, uniforms_{}, levels_{}, tileLookup_{}, args_{};
    uint64_t descsCap_ = 0, uniformsCap_ = 0, levelsCap_ = 0, tileLookupCap_ = 0, argsCap_ = 0;
    WGPUBuffer pagesBuffer_ = nullptr;       // the renderer's `vsmGpuPages` storage, borrowed each prepare
    WGPUBuffer pageRecordsBuffer_ = nullptr; // the renderer's `vsmPageRecords` storage, borrowed each prepare
    VsmCullUniforms cullUniforms_{};
    uint32_t argsSlots_ = 0;
};

}  // namespace tn::engine::shadows
