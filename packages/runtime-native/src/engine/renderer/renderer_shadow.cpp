// The renderer: probe volumes, virtual shadow maps and the shadow plan. PRD-840 split renderer.cpp by concern; renderer_internal.h holds what they share.
#include "engine/renderer/renderer_internal.h"

namespace tn::engine {

void Renderer::setProbeVolume(const std::string& name, const probes::ProbeVolume& volume, bool capture) {
    if (!wgpuDeviceHasFeature(device_, WGPUFeatureName_Float32Filterable))
        throw std::runtime_error("TN_PROBES_TEXTURE_UNSUPPORTED: requires float32-filterable");
    auto& atlas = probeTextures_[shader::probeStorageName(name)];
    const auto& p = volume.placement();
    const WGPUExtent3D size{p.resolution[0], p.resolution[1], p.atlasDepth};
    const bool resized = atlas.texture && (atlas.size.width != size.width || atlas.size.height != size.height ||
                                            atlas.size.depthOrArrayLayers != size.depthOrArrayLayers);
    if (resized) {
        wgpuTextureViewRelease(atlas.view);
        wgpuSamplerRelease(atlas.sampler);
        wgpuTextureRelease(atlas.texture);
        atlas = {};
    }
    if (!atlas.texture) {
        WGPUTextureDescriptor descriptor{};
        descriptor.dimension = WGPUTextureDimension_3D;
        descriptor.size = size;
        descriptor.format = WGPUTextureFormat_RGBA32Float;
        descriptor.usage = WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst;
        descriptor.mipLevelCount = descriptor.sampleCount = 1;
        atlas.texture = wgpuDeviceCreateTexture(device_, &descriptor);
        atlas.view = wgpuTextureCreateView(atlas.texture, nullptr);
        WGPUSamplerDescriptor sampler{};
        sampler.addressModeU = sampler.addressModeV = sampler.addressModeW = WGPUAddressMode_ClampToEdge;
        sampler.magFilter = sampler.minFilter = WGPUFilterMode_Linear;
        sampler.maxAnisotropy = 1;
        atlas.sampler = wgpuDeviceCreateSampler(device_, &sampler);
        atlas.size = size;
    }
    const auto data = capture ? volume.samplingAtlas() : volume.displayAtlas();
    WGPUImageCopyTexture_Compat destination{};
    destination.texture = atlas.texture;
    destination.aspect = WGPUTextureAspect_All;
    WGPUTextureDataLayout_Compat layout{};
    layout.bytesPerRow = size.width * 4 * sizeof(float);
    layout.rowsPerImage = size.height;
    gpu_.sync();  // ordered after any submit still on the GPU thread
    wgpuQueueWriteTexture(queue_, &destination, data.data(), data.size_bytes(), &layout, &size);
    if (resized && uniformCapacity_) rebuildGroups();
}

void Renderer::setVirtualShadow(std::size_t light, const shadows::AtlasOptions& options) {
    if (virtualShadows_.count(light)) throw std::runtime_error("TN_VIRTUAL_SHADOW_UNSUPPORTED: reconfiguration of an active light");
    std::string error;
    auto atlas = shadows::PageAtlas::create(options, error);
    if (!atlas) throw std::runtime_error(error);
    virtualShadows_.emplace(light, VirtualShadow{std::move(*atlas), {}, {}});
    if (options.adaptiveRefresh || options.adaptiveCasterGate) passTimer_->enabled = true;
    // The table and the depth map must exist before a cached material's bind groups can name them: a new scene
    // rebuilds every cached program's groups before its first shadow pass draws the atlas, and a texture binding
    // with no view is an invalid descriptor (the browser port aborts the module on one).
    auto& table = storages_["vsmTable" + std::to_string(light)];
    table.capacity = uint64_t(options.clipExtents.size() * 10 + 1 + virtualShadows_.at(light).atlas.pageCount()) * 16;
    table.buffer = gpu_.createBuffer(table.capacity, WGPUBufferUsage_Storage | WGPUBufferUsage_CopyDst);
    ensureVirtualShadowMap(light);
}

bool Renderer::ensureVirtualShadowMap(std::size_t light) {
    auto found = virtualShadows_.find(light);
    if (found == virtualShadows_.end()) return false;
    auto& shadow = found->second;
    if (shadow.map.texture) return false;
    WGPUTextureDescriptor desc = {};
    desc.dimension = WGPUTextureDimension_2D;
    desc.size = {uint32_t(shadow.atlas.edge()), uint32_t(shadow.atlas.edge()), 1};
    const WGPULimits& limits = deviceLimits();
    if (desc.size.width > limits.maxTextureDimension2D)
        throw std::runtime_error("TN_VIRTUAL_SHADOW_UNSUPPORTED: atlas exceeds device texture limit");
    desc.format = WGPUTextureFormat_Depth24Plus;
    desc.usage = WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_TextureBinding;
    desc.mipLevelCount = desc.sampleCount = 1;
    shadow.map.texture = wgpuDeviceCreateTexture(device_, &desc);
    shadow.map.view = view2d(shadow.map.texture, desc.format);
    shadow.map.width = shadow.map.height = desc.size.width;
    shadowMapsChanged_ = true;
    return true;
}

void Renderer::syncVirtualShadows(const LightState& lights, double tanHalfFov) {
    // Unreal's texel rule on this view: a size change rebuilds that light's atlas.
    const WGPULimits limits = tanHalfFov > 0 && width_ > 0 ? deviceLimits() : WGPULimits{};
    const auto measured = [&](const shadows::AtlasOptions& options, const auto& shadow) {
        auto resolved = options;
        if (options.autoMapSize && tanHalfFov > 0 && width_ > 0)
            resolved.levelMapSizes = shadows::clipmapMapSizes(options, tanHalfFov, width_, int(limits.maxTextureDimension2D));
        // The page border holds the PCF footprint: a wider shadow.radius widens it (radius 1.7 needs 3 texels).
        if (!shadow.sourceAngleFilter && std::isfinite(shadow.radius) && shadow.radius >= 0)
            resolved.border = std::max(options.border, int(std::ceil(shadow.radius + 0.5)));
        return resolved;
    };
    // Facade configurations follow their light, not its sorted slot; remove stale GPU bindings.
    for (auto it = virtualShadows_.begin(); it != virtualShadows_.end();) {
        const auto i = it->first;
        const auto source = i < lights.direct.size() && lights.direct[i].shadow
            ? lights.direct[i].shadow->virtualShadow : nullptr;
        bool resized = false;
        if (source && it->second.source == source) {
            const auto now = measured(*source, *lights.direct[i].shadow);
            const auto& built = it->second.atlas.options();
            resized = now.border != built.border ||
                (source->autoMapSize && tanHalfFov > 0 && now.levelMapSizes != built.levelMapSizes);
        }
        if (!it->second.source || (it->second.source == source && !resized)) { ++it; continue; }
        auto& map = it->second.map;
        if (map.view) wgpuTextureViewRelease(map.view);
        if (map.texture) wgpuTextureRelease(map.texture);
        auto storage = storages_.find("vsmTable" + std::to_string(i));
        if (storage != storages_.end()) {
            gpu_.destroy(storage->second.buffer);
            storages_.erase(storage);
        }
        it = virtualShadows_.erase(it);
        shadowMapsChanged_ = true;
    }
    for (std::size_t i = 0; i < lights.direct.size(); ++i) {
        const auto& light = lights.direct[i];
        if (!light.shadow || !light.shadow->virtualShadow || virtualShadows_.count(i)) continue;
        setVirtualShadow(i, measured(*light.shadow->virtualShadow, *light.shadow));
        virtualShadows_.at(i).source = light.shadow->virtualShadow;
    }
}

std::vector<Renderer::ShadowPlanRow> Renderer::shadowPlan() const {
    std::vector<ShadowPlanRow> rows;
    if (!job_) return rows;
    const std::vector<ShadowPass>& passes = job_->shadowPasses;
    for (std::size_t p = 0; p < passes.size(); ++p) {
        const ShadowPass& pass = passes[p];
        for (const Planned& draw : pass.draws) {
            const DrawItem& item = *draw.item;
            ShadowPlanRow row;
            row.pass = p;
            row.virtualLight = pass.virtualLight; row.virtualLevel = pass.virtualLevel;
            row.lamp = pass.lamp; row.mover = pass.mover;
            row.x = pass.x; row.y = pass.y; row.size = pass.size;
            std::copy(std::begin(pass.view), std::end(pass.view), row.view.begin());
            std::copy(std::begin(pass.projection), std::end(pass.projection), row.projection.begin());
            row.key = item.key;
            row.indices = item.indices;
            row.instanceCount = item.instanceCount;
            row.instanceBase = draw.instanceBase;
            std::copy(std::begin(item.matrixWorld), std::end(item.matrixWorld), row.matrixWorld.begin());
            row.vertexOffset = draw.vertexOffset; row.fragmentOffset = draw.fragmentOffset;
            row.vertexBytes = uint32_t(aligned(draw.program->vertex.uniformBlockSize));
            row.fragmentBytes = draw.fragmentOffset ? uint32_t(aligned(draw.program->fragment.uniformBlockSize)) : 0;
            if (draw.members != nullptr) {
                row.members.reserve(draw.memberCount);
                for (uint32_t m = 0; m < draw.memberCount; ++m) {
                    ShadowPlanRow::Member member;
                    member.key = draw.members[m]->key;
                    std::copy(std::begin(draw.members[m]->matrixWorld), std::end(draw.members[m]->matrixWorld),
                              member.matrixWorld.begin());
                    row.members.push_back(member);
                }
            } else {
                row.members.push_back({row.key, row.matrixWorld});
            }
            rows.push_back(std::move(row));
        }
    }
    return rows;
}

}  // namespace tn::engine
