#include "gpu_pages.h"

#include <algorithm>
#include <array>
#include <cstring>

#include "engine/renderer/gpu_resources.h"
#include "mystral/webgpu_compat.h"

namespace tn::engine::shadows {

namespace {

// One instance per page slot, six vertices per slot, reading the slot rect the renderer uploaded. The clip
// position's z is 1, so the page's depth clears to the far plane where the page is drawn.
constexpr char kPageClearWgsl[] = R"WGSL(
@group(0) @binding(0) var<storage, read> vsmGpuPages: array<vec4<f32>>;

@vertex
fn vs(@builtin(vertex_index) vertexIndex: u32, @builtin(instance_index) instanceIndex: u32) -> @builtin(position) vec4<f32> {
    let rect = vsmGpuPages[instanceIndex * 8u + 4u];
    let x = select(0.0, 1.0, vertexIndex == 1u || vertexIndex == 3u || vertexIndex == 4u);
    let y = select(0.0, 1.0, vertexIndex == 2u || vertexIndex == 4u || vertexIndex == 5u);
    let pixel = rect.xy + vec2<f32>(x, y) * rect.z;
    let ndc = vec2<f32>(pixel.x * rect.w * 2.0 - 1.0, 1.0 - pixel.y * rect.w * 2.0);
    return vec4<f32>(ndc, 1.0, 1.0);
}
)WGSL";

// One thread per candidate instance: a binary search picks its caster row, the row's level grid turns the
// instance's world box into a page range, and every overlapping page appends an (instance, page) record and
// bumps the row's indirect instance count. A non-affine or non-finite transform keeps every page of the level.
constexpr char kCullWgsl[] = R"WGSL(
struct VsmGpuPage {
    viewProj: mat4x4<f32>,
    slotRect: vec4<f32>,
    pageScaleBias: vec4<f32>,
    boundsUV: vec4<f32>,
    identity: vec4<u32>,
};
struct VsmLevelGridGpu {
    axisU: vec4<f32>,
    axisV: vec4<f32>,
    bounds: vec4<f32>,
    params: vec4<f32>,
    counts: vec4<u32>,
};
struct VsmCullDrawDesc {
    model: mat4x4<f32>,
    localMin: vec4<f32>,
    localMax: vec4<f32>,
    drawMeta: vec4<u32>,
    dispatch: vec4<u32>,
};
struct VsmCullUniforms {
    totalDraws: u32,
    totalInstances: u32,
    totalPages: u32,
    levelCount: u32,
};

@group(0) @binding(0) var<storage, read> instances: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read> descs: array<VsmCullDrawDesc>;
@group(0) @binding(2) var<uniform> u: VsmCullUniforms;
@group(0) @binding(3) var<storage, read> levels: array<VsmLevelGridGpu>;
@group(0) @binding(4) var<storage, read> tileLookup: array<u32>;
@group(0) @binding(5) var<storage, read> pages: array<VsmGpuPage>;
@group(0) @binding(6) var<storage, read_write> pageRecords: array<u32>;
@group(0) @binding(7) var<storage, read_write> args: array<atomic<u32>>;

fn emitRecord(desc: VsmCullDrawDesc, instIdx: u32, pageIdx: u32) {
    let slot = atomicAdd(&args[desc.drawMeta.w * 5u + 1u], 1u);
    if (slot < desc.dispatch.z) {
        pageRecords[(desc.drawMeta.z + slot) * 2u + 0u] = instIdx;
        pageRecords[(desc.drawMeta.z + slot) * 2u + 1u] = pageIdx;
    }
}

fn emitAllPages(desc: VsmCullDrawDesc, instIdx: u32, level: VsmLevelGridGpu) {
    for (var k = 0u; k < level.counts.y; k = k + 1u) {
        emitRecord(desc, instIdx, level.counts.x + k);
    }
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let tid = gid.x;
    if (tid >= u.totalInstances) {
        return;
    }
    var lo = 0u;
    var hi = u.totalDraws;
    while (lo < hi) {
        let mid = (lo + hi) / 2u;
        if (descs[mid].dispatch.x <= tid) {
            lo = mid + 1u;
        } else {
            hi = mid;
        }
    }
    if (lo == 0u) {
        return;
    }
    let desc = descs[lo - 1u];
    let levelIdx = desc.dispatch.y;
    if (levelIdx >= u.levelCount) {
        return;
    }
    let level = levels[levelIdx];
    let instIdx = tid - desc.dispatch.x;
    let flags = desc.dispatch.w;
    if ((flags & 2u) != 0u) {
        emitAllPages(desc, instIdx, level);
        return;
    }
    var worldMin = desc.localMin.xyz;
    var worldMax = desc.localMax.xyz;
    if ((flags & 1u) != 0u) {
        let base = desc.drawMeta.x + instIdx * 5u;
        let instMat = mat4x4<f32>(instances[base + 0u], instances[base + 1u], instances[base + 2u], instances[base + 3u]);
        let worldMat = desc.model * instMat;
        let affine = worldMat[0].w == 0.0 && worldMat[1].w == 0.0 && worldMat[2].w == 0.0 && worldMat[3].w == 1.0;
        if (!affine) {
            emitAllPages(desc, instIdx, level);
            return;
        }
        var boxMin = vec3<f32>(1e30, 1e30, 1e30);
        var boxMax = vec3<f32>(-1e30, -1e30, -1e30);
        for (var corner = 0u; corner < 8u; corner = corner + 1u) {
            let local = vec3<f32>(
                select(desc.localMin.x, desc.localMax.x, (corner & 1u) != 0u),
                select(desc.localMin.y, desc.localMax.y, (corner & 2u) != 0u),
                select(desc.localMin.z, desc.localMax.z, (corner & 4u) != 0u));
            let moved = (worldMat * vec4<f32>(local, 1.0)).xyz;
            boxMin = min(boxMin, moved);
            boxMax = max(boxMax, moved);
        }
        if (!(all(boxMin == boxMin) && all(boxMax == boxMax))) {
            emitAllPages(desc, instIdx, level);
            return;
        }
        let sx = dot(worldMat[0].xyz, worldMat[0].xyz);
        let sy = dot(worldMat[1].xyz, worldMat[1].xyz);
        let sz = dot(worldMat[2].xyz, worldMat[2].xyz);
        let grow = vec3<f32>(desc.localMin.w * sqrt(max(sx, max(sy, sz))));
        worldMin = boxMin - grow;
        worldMax = boxMax + grow;
    }
    let centre = (worldMin + worldMax) * 0.5;
    let half = (worldMax - worldMin) * 0.5;
    let axisU = level.axisU.xyz;
    let axisV = level.axisV.xyz;
    let reachU = dot(abs(axisU), half);
    let middleU = dot(axisU, centre);
    let reachV = dot(abs(axisV), half);
    let middleV = dot(axisV, centre);
    let slopU = level.params.x;
    let slopV = level.params.y;
    let tiles = i32(round(level.params.z));
    if (!(middleU == middleU) || !(middleV == middleV) || !(reachU == reachU) || !(reachV == reachV)) {
        emitAllPages(desc, instIdx, level);
        return;
    }
    var x0 = i32(ceil((middleU - reachU - slopU - level.bounds.y) * level.axisU.w));
    var x1 = i32(floor((middleU + reachU + slopU - level.bounds.x) * level.axisU.w));
    var y0 = i32(ceil((middleV - reachV - slopV - level.bounds.w) * level.axisV.w));
    var y1 = i32(floor((middleV + reachV + slopV - level.bounds.z) * level.axisV.w));
    x0 = max(x0, 0);
    x1 = min(x1, tiles - 1);
    y0 = max(y0, 0);
    y1 = min(y1, tiles - 1);
    if (x1 < x0 || y1 < y0) {
        return;
    }
    let uMin = middleU - reachU - slopU;
    let uMax = middleU + reachU + slopU;
    let vMin = middleV - reachV - slopV;
    let vMax = middleV + reachV + slopV;
    let lookup = u32(level.params.w);
    for (var y = y0; y <= y1; y = y + 1) {
        for (var x = x0; x <= x1; x = x + 1) {
            let pageIdx = tileLookup[lookup + u32(y * tiles + x)];
            if (pageIdx == 0xFFFFFFFFu || pageIdx >= u.totalPages) {
                continue;
            }
            let page = pages[pageIdx];
            if (uMin <= page.boundsUV.y && uMax >= page.boundsUV.x && vMin <= page.boundsUV.w && vMax >= page.boundsUV.z) {
                emitRecord(desc, instIdx, pageIdx);
            }
        }
    }
}
)WGSL";

WGPUShaderModule shaderModule(WGPUDevice device, const char* code) {
    WGPUShaderModuleWGSLDescriptor_Compat wgsl = {};
    WGPUShaderModuleDescriptor desc = {};
    setupShaderModuleWGSL(&desc, &wgsl, code);
    return wgpuDeviceCreateShaderModule(device, &desc);
}

}  // namespace

GpuVsmResources::~GpuVsmResources() { release(); }

WGPUBuffer GpuVsmResources::argsBuffer() const {
    return gpu_ && args_.type != 0 ? gpu_->buffer(args_) : nullptr;
}

void GpuVsmResources::clearBindGroups() {
    pageClearGroups_.clear();
    cullGroups_.clear();
}

void GpuVsmResources::release() {
    clearBindGroups();
    if (pageClearPipeline_) wgpuRenderPipelineRelease(pageClearPipeline_);
    if (pageClearLayout_) wgpuBindGroupLayoutRelease(pageClearLayout_);
    if (pageClearPipelineLayout_) wgpuPipelineLayoutRelease(pageClearPipelineLayout_);
    if (cullPipeline_) wgpuComputePipelineRelease(cullPipeline_);
    if (cullLayout_) wgpuBindGroupLayoutRelease(cullLayout_);
    if (cullPipelineLayout_) wgpuPipelineLayoutRelease(cullPipelineLayout_);
    pageClearPipeline_ = nullptr;
    pageClearLayout_ = nullptr;
    pageClearPipelineLayout_ = nullptr;
    cullPipeline_ = nullptr;
    cullLayout_ = nullptr;
    cullPipelineLayout_ = nullptr;
    if (gpu_) {
        for (Handle* handle : {&descs_, &uniforms_, &levels_, &tileLookup_, &args_})
            if (handle->type != 0) gpu_->destroy(*handle);
    }
    descs_ = uniforms_ = levels_ = tileLookup_ = args_ = Handle{};
    descsCap_ = uniformsCap_ = levelsCap_ = tileLookupCap_ = argsCap_ = 0;
    pagesBuffer_ = nullptr;
    pageRecordsBuffer_ = nullptr;
    cullUniforms_ = {};
    argsSlots_ = 0;
    device_ = nullptr;
    gpu_ = nullptr;
}

bool GpuVsmResources::ensurePipelines() {
    if (pageClearPipeline_ != nullptr && cullPipeline_ != nullptr) return true;
    if (device_ == nullptr) return false;
    if (pageClearPipeline_ == nullptr) {
        WGPUShaderModule module = shaderModule(device_, kPageClearWgsl);
        if (module == nullptr) return false;
        WGPUBindGroupLayoutEntry entry = {};
        entry.binding = 0;
        entry.visibility = WGPUShaderStage_Vertex;
        entry.buffer.type = WGPUBufferBindingType_ReadOnlyStorage;
        WGPUBindGroupLayoutDescriptor layoutDesc = {};
        layoutDesc.entryCount = 1;
        layoutDesc.entries = &entry;
        pageClearLayout_ = wgpuDeviceCreateBindGroupLayout(device_, &layoutDesc);
        WGPUPipelineLayoutDescriptor pipelineLayoutDesc = {};
        pipelineLayoutDesc.bindGroupLayoutCount = pageClearLayout_ ? 1 : 0;
        pipelineLayoutDesc.bindGroupLayouts = &pageClearLayout_;
        pageClearPipelineLayout_ =
            pageClearLayout_ ? wgpuDeviceCreatePipelineLayout(device_, &pipelineLayoutDesc) : nullptr;
        WGPUDepthStencilState depth = {};
        depth.format = WGPUTextureFormat_Depth24Plus;
        depth.depthWriteEnabled = WGPU_OPTIONAL_BOOL_TRUE;
        depth.depthCompare = WGPUCompareFunction_Always;
        WGPURenderPipelineDescriptor desc = {};
        desc.layout = pageClearPipelineLayout_;
        desc.vertex.module = module;
        WGPU_SET_ENTRY_POINT(desc.vertex, "vs");
        desc.primitive.topology = WGPUPrimitiveTopology_TriangleList;
        desc.primitive.cullMode = WGPUCullMode_None;
        desc.primitive.frontFace = WGPUFrontFace_CCW;
        desc.multisample.count = 1;
        desc.multisample.mask = 0xffffffffu;
        desc.depthStencil = &depth;
        if (pageClearPipelineLayout_) pageClearPipeline_ = wgpuDeviceCreateRenderPipeline(device_, &desc);
        wgpuShaderModuleRelease(module);
        if (pageClearPipeline_ == nullptr) return false;
    }
    if (cullPipeline_ == nullptr) {
        WGPUShaderModule module = shaderModule(device_, kCullWgsl);
        if (module == nullptr) return false;
        std::array<WGPUBindGroupLayoutEntry, 8> entries = {};
        for (std::size_t i = 0; i < entries.size(); ++i) {
            entries[i].binding = uint32_t(i);
            entries[i].visibility = WGPUShaderStage_Compute;
            entries[i].buffer.type = i == 2 ? WGPUBufferBindingType_Uniform
                                      : i >= 6 ? WGPUBufferBindingType_Storage
                                               : WGPUBufferBindingType_ReadOnlyStorage;
        }
        WGPUBindGroupLayoutDescriptor layoutDesc = {};
        layoutDesc.entryCount = entries.size();
        layoutDesc.entries = entries.data();
        cullLayout_ = wgpuDeviceCreateBindGroupLayout(device_, &layoutDesc);
        WGPUPipelineLayoutDescriptor pipelineLayoutDesc = {};
        pipelineLayoutDesc.bindGroupLayoutCount = cullLayout_ ? 1 : 0;
        pipelineLayoutDesc.bindGroupLayouts = &cullLayout_;
        cullPipelineLayout_ = cullLayout_ ? wgpuDeviceCreatePipelineLayout(device_, &pipelineLayoutDesc) : nullptr;
        WGPUComputePipelineDescriptor desc = {};
        desc.layout = cullPipelineLayout_;
        desc.compute.module = module;
        WGPU_SET_ENTRY_POINT(desc.compute, "main");
        if (cullPipelineLayout_) cullPipeline_ = wgpuDeviceCreateComputePipeline(device_, &desc);
        wgpuShaderModuleRelease(module);
        if (cullPipeline_ == nullptr) return false;
    }
    return true;
}

bool GpuVsmResources::ensureBuffer(Handle& handle, uint64_t& capacity, uint64_t bytes, WGPUBufferUsage usage,
                                   bool& grew) {
    if (gpu_ == nullptr) return false;
    if (bytes == 0) bytes = 4;
    if (handle.type != 0 && capacity >= bytes) return true;
    uint64_t grown = 64 * 1024;
    while (grown < bytes) grown *= 2;
    if (handle.type != 0) {
        gpu_->destroy(handle);
        handle = Handle{};
        capacity = 0;
    }
    handle = gpu_->createBuffer(grown, usage);
    if (handle.type == 0) {
        capacity = 0;
        return false;
    }
    capacity = grown;
    grew = true;
    clearBindGroups();
    return true;
}

bool GpuVsmResources::prepareBuffers(GpuResources& gpu, WGPUDevice device, const std::vector<VsmCullDrawDesc>& draws,
                                     const VsmCullUniforms& uniforms, const std::vector<VsmLevelGridGpu>& levels,
                                     const std::vector<uint32_t>& tileLookup, const std::vector<VsmGpuPage>& pages,
                                     const std::vector<uint32_t>& initialArgs, uint32_t argsSlots,
                                     uint32_t pageRecordCount, Handle& pagesBuffer, uint64_t& pagesCap,
                                     Handle& pageRecordsBuffer, uint64_t& pageRecordsCap, bool& groupsGrew) {
    if (device == nullptr) return false;
    if (device_ != nullptr && device_ != device) {
        clearBindGroups();
        device_ = nullptr;
    }
    gpu_ = &gpu;
    device_ = device;
    groupsGrew = false;
    if (!ensurePipelines()) return false;
    const auto storage = WGPUBufferUsage_Storage | WGPUBufferUsage_CopyDst;
    const auto rendererStorage = WGPUBufferUsage_Storage | WGPUBufferUsage_CopyDst | WGPUBufferUsage_CopySrc;
    const uint64_t descBytes = std::max<uint64_t>(1, draws.size()) * sizeof(VsmCullDrawDesc);
    const uint64_t levelBytes = std::max<uint64_t>(1, levels.size()) * sizeof(VsmLevelGridGpu);
    const uint64_t lookupBytes = std::max<uint64_t>(1, tileLookup.size()) * sizeof(uint32_t);
    const uint64_t pageBytes = std::max<uint64_t>(1, pages.size()) * sizeof(VsmGpuPage);
    const uint64_t recordBytes = std::max<uint64_t>(4, uint64_t(pageRecordCount) * 2 * sizeof(uint32_t));
    const uint64_t argWords = std::max<uint64_t>(uint64_t(argsSlots) * 5, initialArgs.size());
    const uint64_t argsBytes = std::max<uint64_t>(20, argWords * sizeof(uint32_t));
    bool grew = false;
    const auto ensure = [&](Handle& handle, uint64_t& capacity, uint64_t bytes, WGPUBufferUsage usage) {
        bool more = false;
        if (!ensureBuffer(handle, capacity, bytes, usage, more)) return false;
        grew = grew || more;
        return true;
    };
    if (!ensure(descs_, descsCap_, descBytes, storage) ||
        !ensure(uniforms_, uniformsCap_, sizeof(VsmCullUniforms),
                WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst) ||
        !ensure(levels_, levelsCap_, levelBytes, storage) ||
        !ensure(tileLookup_, tileLookupCap_, lookupBytes, storage) ||
        !ensure(args_, argsCap_, argsBytes,
                storage | WGPUBufferUsage_Indirect | WGPUBufferUsage_CopySrc))
        return false;
    // The page and record storages belong to the renderer: a grow reallocates its handle, and the caller rebuilds
    // every bind group around it. `grew` from the buffers above already asks for that rebuild.
    if (!ensureBuffer(pagesBuffer, pagesCap, pageBytes, rendererStorage, grew) ||
        !ensureBuffer(pageRecordsBuffer, pageRecordsCap, recordBytes, rendererStorage, grew))
        return false;
    groupsGrew = grew;
    if (!draws.empty()) gpu.writeBuffer(descs_, 0, draws.data(), draws.size() * sizeof(VsmCullDrawDesc));
    gpu.writeBuffer(uniforms_, 0, &uniforms, sizeof uniforms);
    if (!levels.empty()) gpu.writeBuffer(levels_, 0, levels.data(), levels.size() * sizeof(VsmLevelGridGpu));
    if (!tileLookup.empty()) gpu.writeBuffer(tileLookup_, 0, tileLookup.data(), tileLookup.size() * sizeof(uint32_t));
    if (!pages.empty()) gpu.writeBuffer(pagesBuffer, 0, pages.data(), pages.size() * sizeof(VsmGpuPage));
    cullUniforms_ = uniforms;
    argsSlots_ = argsSlots;
    if (!initialArgs.empty()) gpu.writeBuffer(args_, 0, initialArgs.data(), initialArgs.size() * sizeof(uint32_t));
    pagesBuffer_ = gpu.buffer(pagesBuffer);
    pageRecordsBuffer_ = gpu.buffer(pageRecordsBuffer);
    return pagesBuffer_ != nullptr && pageRecordsBuffer_ != nullptr;
}

void GpuVsmResources::dispatchCull(WGPUCommandEncoder encoder, WGPUBuffer instances) {
    if (!ready() || gpu_ == nullptr || encoder == nullptr || instances == nullptr) return;
    const std::array<WGPUBuffer, 8> buffers = {instances,
                                               gpu_->buffer(descs_),
                                               gpu_->buffer(uniforms_),
                                               gpu_->buffer(levels_),
                                               gpu_->buffer(tileLookup_),
                                               pagesBuffer_,
                                               pageRecordsBuffer_,
                                               gpu_->buffer(args_)};
    std::array<WGPUBindGroupEntry, 8> entries = {};
    for (std::size_t i = 0; i < entries.size(); ++i) {
        if (buffers[i] == nullptr) return;
        entries[i].binding = uint32_t(i);
        entries[i].buffer = buffers[i];
        entries[i].size = wgpuBufferGetSize(buffers[i]);
    }
    const WGPUBindGroup group =
        cullGroups_.get(device_, cullLayout_, std::vector<WGPUBindGroupEntry>(entries.begin(), entries.end()));
    if (group == nullptr) return;
    WGPUComputePassDescriptor desc = {};
    WGPUComputePassEncoder pass = wgpuCommandEncoderBeginComputePass(encoder, &desc);
    wgpuComputePassEncoderSetPipeline(pass, cullPipeline_);
    wgpuComputePassEncoderSetBindGroup(pass, 0, group, 0, nullptr);
    wgpuComputePassEncoderDispatchWorkgroups(pass, (cullUniforms_.totalInstances + 63u) / 64u, 1, 1);
    wgpuComputePassEncoderEnd(pass);
    wgpuComputePassEncoderRelease(pass);
}

void GpuVsmResources::encodePageClears(WGPURenderPassEncoder pass, WGPUBuffer pageBuffer, uint32_t pageCount,
                                       uint32_t firstPage) {
    if (pageClearPipeline_ == nullptr || gpu_ == nullptr || pass == nullptr || pageBuffer == nullptr ||
        pageCount == 0)
        return;
    WGPUBindGroupEntry entry = {};
    entry.binding = 0;
    entry.buffer = pageBuffer;
    entry.size = wgpuBufferGetSize(pageBuffer);
    const WGPUBindGroup group = pageClearGroups_.get(device_, pageClearLayout_, {entry});
    if (group == nullptr) return;
    wgpuRenderPassEncoderSetPipeline(pass, pageClearPipeline_);
    wgpuRenderPassEncoderSetBindGroup(pass, 0, group, 0, nullptr);
    wgpuRenderPassEncoderDraw(pass, 6, pageCount, 0, firstPage);
}

}  // namespace tn::engine::shadows
