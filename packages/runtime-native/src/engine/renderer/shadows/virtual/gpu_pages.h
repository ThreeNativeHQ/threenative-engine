#pragma once

#include <array>
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
 * PRD-775 Phase 3: one physical page slot as the page manager keeps it. `flags` 0 is an empty slot; `pageIdLo`/`pageIdHi`
 * are the packed `pageId` of the virtual page it holds, and `lastUsedFrame` is the frame that page was last requested.
 * Sixteen bytes, so the GPU reads an array of vec4.
 */
struct VsmPhysicalPageMeta {
    uint32_t pageIdLo = 0;
    uint32_t pageIdHi = 0;
    uint32_t flags = 0;
    float lastUsedFrame = 0;
};
static_assert(sizeof(VsmPhysicalPageMeta) == 16, "a VSM physical page is four u32");

/** One virtual page a frame requests. `gpuPageIndex` is its index in the frame's `vsmGpuPages` entries, or ~0u. */
struct VsmPageRequest {
    uint32_t pageIdLo = 0;
    uint32_t pageIdHi = 0;
    uint32_t tableVec4Offset = 0;
    uint32_t gpuPageIndex = 0xFFFFFFFFu;
    /** Bit 0: granted this frame; bit 1: a kept panning page (no redraw on a hit); bit 2: invalidated (force redraw). */
    uint32_t requestFlags = 0;
    uint32_t missOrder = 0;
    uint32_t pad0 = 0;
    uint32_t pad1 = 0;
};
static_assert(sizeof(VsmPageRequest) == 32, "a VSM page request is eight u32");

/** The sorted `(pageIdLo, pageIdHi, requestIdx)` array the per-slot binary search walks. */
struct VsmPageLookup {
    uint32_t pageIdLo = 0;
    uint32_t pageIdHi = 0;
    uint32_t requestIdx = 0;
    uint32_t pad = 0;
};
static_assert(sizeof(VsmPageLookup) == 16, "a VSM page lookup is four u32");

/** The page manager's per-frame constants: the pool size, the request count and the atlas geometry. */
struct VsmPoolUniforms {
    uint32_t capacity = 0;
    uint32_t numRequests = 0;
    uint32_t vsmPageOffset = 0;
    uint32_t slotsPerAxis = 0;
    uint32_t stride = 0;
    float invEdge = 0;
    float receiverPlaneBias = 0;
    float frameNumber = 0;
    uint32_t hasVsmGpuPages = 0;
    uint32_t resetPool = 0;
    uint32_t pad0 = 0;
    uint32_t pad1 = 0;
};
static_assert(sizeof(VsmPoolUniforms) == 48, "VSM pool uniforms are twelve u32");

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
    std::array<WGPUBuffer, 8> cullCachedBuffers_{};
    WGPUBindGroup cullCachedGroup_ = nullptr;
    WGPUBuffer pageClearCachedBuffer_ = nullptr;
    WGPUBindGroup pageClearCachedGroup_ = nullptr;
    Handle descs_{}, uniforms_{}, levels_{}, tileLookup_{}, args_{};
    uint64_t descsCap_ = 0, uniformsCap_ = 0, levelsCap_ = 0, tileLookupCap_ = 0, argsCap_ = 0;
    WGPUBuffer pagesBuffer_ = nullptr;       // the renderer's `vsmGpuPages` storage, borrowed each prepare
    WGPUBuffer pageRecordsBuffer_ = nullptr; // the renderer's `vsmPageRecords` storage, borrowed each prepare
    VsmCullUniforms cullUniforms_{};
    uint32_t argsSlots_ = 0;
};

/**
 * The GPU half of PRD-775 Phase 3: Unreal's four-list physical page manager
 * (UE 5.8.3: Engine/Shaders/Private/VirtualShadowMaps/VirtualShadowMapPhysicalPageManagement.usf). It keeps the
 * `capacity` physical slots, the LRU, available, empty and requested lists, and writes every mapped page's slot into
 * the renderer's `vsmTable` and `vsmGpuPages` storages. Three compute kernels run per frame:
 *
 *  1. `UpdatePhysicalPages` binary-searches each resident slot in the frame's sorted request list and appends it to
 *     requested, LRU or empty.
 *  2. `PackAvailablePages` packs available as empty slots ascending, then LRU by `(lastUsedFrame, slot)` ascending —
 *     exactly `PhysicalPagePool::allocate`'s order — and assigns each miss its rank.
 *  3. `AllocateNewPageMappings` maps hits and misses, writes the page table entry, and patches the GPU page's slot
 *     rect, scale/bias, bounds and identity before the cull and clear passes read them.
 *
 * The class owns its pipelines, buffers and bind groups. `prepare` uploads a frame's requests and per-frame
 * sentinels; `dispatch` records the three passes. `capacity` is the atlas' `pageCount`, as the CPU pool is.
 */
class GpuPhysicalPagePool {
public:
    /** The four lists, in `listCounts` order: lruCount, availableCount, emptyCount, requestedCount. */
    enum class PageList : uint32_t { Lru = 0, Available = 1, Empty = 2, Requested = 3 };

    explicit GpuPhysicalPagePool(uint32_t capacity = 0);
    ~GpuPhysicalPagePool();
    GpuPhysicalPagePool(const GpuPhysicalPagePool&) = delete;
    GpuPhysicalPagePool& operator=(const GpuPhysicalPagePool&) = delete;

    /** Drops every cached bind group, so the next dispatch rebuilds against the current buffers. */
    void clearBindGroups();
    /** Releases the pipelines, layouts and buffers. Call before the device and its GpuResources go away. */
    void release();

    /** Zeroes the pool's resident state and the table's page region on the next `prepare`. */
    void requestReset();

    /**
     * Uploads one frame's requests, sorted lookup, miss sentinels and uniforms; on a reset (or the first frame) it
     * also zeroes `physicalMeta` and writes zeroes over the table's page region
     * `[tableStartByte, tableEndByte)`, so the GPU manager is the page region's only writer. `vsmTable` may be null
     * when no table is owned yet; the reset then only clears the resident state. False when a pipeline or buffer is
     * unavailable.
     */
    bool prepare(GpuResources& gpu, WGPUDevice device, const std::vector<VsmPageRequest>& requests,
                 const VsmPoolUniforms& uniforms, Handle vsmTable = {}, uint64_t tableStartByte = 0,
                 uint64_t tableEndByte = 0);

    /** Records the three page-management compute passes, before any shadow draw reads the table or page entries. */
    void dispatch(WGPUCommandEncoder encoder, WGPUBuffer vsmTable, WGPUBuffer vsmGpuPages);

    bool ready() const { return updatePipeline_ != nullptr && packPipeline_ != nullptr && allocatePipeline_ != nullptr; }
    uint32_t capacity() const { return capacity_; }
    uint32_t numRequests() const { return numRequests_; }
    bool resetPending() const { return resetPending_; }

    /** The buffers a test reads back; null until `prepare` created them. */
    WGPUBuffer metaBuffer() const;
    WGPUBuffer listBuffer(PageList list) const;
    WGPUBuffer countsBuffer() const;
    WGPUBuffer requestsBuffer() const;
    WGPUBuffer lookupBuffer() const;
    Handle metaHandle() const { return meta_; }
    Handle listHandle(PageList list) const;
    Handle countsHandle() const { return counts_; }
    Handle requestsHandle() const { return requests_; }
    Handle lookupHandle() const { return lookup_; }

private:
    bool ensurePipelines();
    bool ensureBuffer(Handle& handle, uint64_t& capacity, uint64_t bytes, WGPUBufferUsage usage);
    WGPUBuffer buffer(const Handle& handle) const;

    WGPUDevice device_ = nullptr;
    GpuResources* gpu_ = nullptr;
    WGPUComputePipeline updatePipeline_ = nullptr, packPipeline_ = nullptr, allocatePipeline_ = nullptr;
    WGPUBindGroupLayout updateLayout_ = nullptr, packLayout_ = nullptr, allocateLayout_ = nullptr;
    WGPUPipelineLayout updatePipelineLayout_ = nullptr, packPipelineLayout_ = nullptr, allocatePipelineLayout_ = nullptr;
    RecentBindGroups updateGroups_{2}, packGroups_{2}, allocateGroups_{2};
    std::array<WGPUBuffer, 8> updateCachedBuffers_{};
    WGPUBindGroup updateCachedGroup_ = nullptr;
    std::array<WGPUBuffer, 5> packCachedBuffers_{};
    WGPUBindGroup packCachedGroup_ = nullptr;
    std::array<WGPUBuffer, 7> allocateCachedBuffers_{};
    WGPUBindGroup allocateCachedGroup_ = nullptr;
    std::vector<uint32_t> sentinelAvailable_;
    std::vector<uint32_t> sentinelMatch_;
    std::vector<VsmPageLookup> lookupScratch_;
    Handle requests_{}, lookup_{}, uniforms_{}, meta_{}, lru_{}, available_{}, empty_{}, requested_{}, counts_{}, match_{};
    uint64_t requestsCap_ = 0, lookupCap_ = 0, uniformCap_ = 0, metaCap_ = 0, listCap_ = 0, countsCap_ = 0,
             matchCap_ = 0;
    uint32_t capacity_ = 0;
    uint32_t numRequests_ = 0;
    bool resetPending_ = true;
};

}  // namespace tn::engine::shadows
