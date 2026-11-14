// The renderer: renderPrepared: one frame's plan, uniforms, shadow pages and passes. PRD-840 split renderer.cpp by concern; renderer_internal.h holds what they share.
#include "engine/renderer/renderer_internal.h"

namespace tn::engine {

uint64_t Renderer::renderPrepared(std::span<const DrawItem> items, const CameraState& inputCamera,
                                  const LightState& lights, std::array<double, 4> clear,
                                  std::vector<std::shared_ptr<PipelineCompilation>>* compilation,
                                  WGPUTextureFormat outputFormat, bool defer) {
    const double prepareStarted = meterStart(cpuMetered_);
    FrameGpuTimer::Scope timerScope(compilation ? nullptr : passTimer_.get());
    // One frame in flight per renderer: the game thread may not plan while the encode half is pending or running.
    if (!compilation && (pendingEncode_ || encoding_))
        throw std::logic_error("TN_RENDER_THREAD_BATON: a frame was planned before the previous one was encoded");
    // Target draws the post graph does not sample (a sky the world material reads) are recorded ahead of the scene pass.
    if (!compilation) recordDeferred(false);
    const uint64_t id = compilation ? renderId_ : ++renderId_;
    // Taken at once: a frame that throws must not leave a borrowed view armed for the next one.
    WGPUTextureView presentTarget = compilation ? nullptr : std::exchange(presentTarget_, nullptr);
    if (!compilation && !presentTarget && presentAcquire_) presentTarget = std::exchange(presentAcquire_, nullptr)();
    const WGPUTextureFormat presentFormat = presentFormat_;
    for (const auto& target : rttTargets_) {
        auto& state = *target.state;
        state.material = state.quad->material;
        if (!state.material || !state.material->nodeMaterial)
            throw std::runtime_error("RTT quad needs a node material");
        state.material->nodes.fragmentNode = state.source;
    }
    if (!compilation && std::any_of(rttTargets_.begin(), rttTargets_.end(), [](const auto& target) {
            return target.state->material && (target.materialVersion != target.state->material->version() ||
                                              target.material != target.state->material.get());
        }))
        setPostGraph(postGraph_);
    CameraState unjitteredCamera = inputCamera;
    const bool manualView = liveTraa_ && liveTraa_->viewOffset;
    if (manualView)
        unjitteredCamera.projectionMatrix = liveTraa_->originalProjection;
    CameraState camera = unjitteredCamera;
    if (liveTraa_ && traa_ && !compilation) {
        const auto parameter = [&](const char* name) { return static_cast<float>(liveTraa_->parameters.at(name).at(0)); };
        traa_->setOptions({parameter("depthThreshold"), parameter("edgeDepthDiff"),
                           parameter("maxVelocityLength"), parameter("useSubpixelCorrection") != 0});
    }
    if (traa_ && !compilation)
        camera.projectionMatrix = traa_->begin(camera.projectionMatrix, camera.matrixWorld, camera.matrixWorldInverse,
                                               manualView ? &inputCamera.projectionMatrix : nullptr);
    if (!compilation) {
        readTraaCounts();
        const auto status = traa_ ? traa_->status() : TraaPass::Status{};
        if (traa_) {
            waste::debugAdd(waste::counters().temporalActiveFrames);
            if (!status.historyValid) waste::debugAdd(waste::counters().temporalInvalidFrames);
        }
        temporalStatus_ = {traa_ != nullptr, status.historyValid, status.frame, status.jitterX, status.jitterY,
                           traaCounts_->rejected, traaCounts_->clamped, traaCounts_->pixels, traaCounts_->frame};
    }
    const Matrix& view = camera.matrixWorldInverse;
    ++planSerial_;  // FM2: a program's frame slab is one plan old at most
    geometry_->cache.sweep();  // GPU copies of attributes released since the last frame
    sweepTextures();    // ...and of textures that no longer exist
    // A sibling replaced or released a shared map texture: this renderer's groups may bind its old view.
    // Seeing the change is not making one: bumping the count here made the siblings hand it back and
    // forth, and every renderer dropped its groups and bundles on every frame.
    if (texturesSeen_ != textures_->generation) {
        dropMapGroups();
        texturesSeen_ = textures_->generation;
    }
    diagnostics_.clear();
    if (!compilation) {  // a compile is no frame: three's deltaTime spans presented frames only
        const float now = std::chrono::duration<float>(std::chrono::steady_clock::now() - start_).count();
        frameDelta_ = frameTime_ == 0 ? 1.0f / 60.0f : std::max(0.0f, now - frameTime_);
        frameTime_ = now;
    }
    // storage(attribute) reads: each attribute's data is the storage buffer its name binds, synced
    // like a vertex buffer. A new or regrown buffer rebinds the programs' groups before any draw.
    bool storagesMoved = false;
    for (const DrawItem& item : items) {
        if (!item.nodeStorages) continue;
        for (const auto& [name, attribute] : *item.nodeStorages) {
            const Handle buffer = geometry_->cache.sync(*attribute->store, WGPUBufferUsage_Storage | WGPUBufferUsage_CopySrc);
            const std::pair<Handle, uint64_t> bound{buffer, attribute->store->byteLength()};
            if (const auto found = externalStorage_.find(name); found != externalStorage_.end()) {
                const Handle& was = found->second.first;
                if (was.type == buffer.type && was.context == buffer.context && was.index == buffer.index &&
                    was.generation == buffer.generation && found->second.second == bound.second)
                    continue;
            }
            setStorage(name, bound.first, bound.second);
            storagesMoved = true;
        }
    }
    if (storagesMoved && uniformCapacity_ != 0) rebuildGroups();

    WGPUCommandEncoderDescriptor encoderDesc = {};
    WGPUCommandEncoder encoder = compilation ? nullptr : wgpuDeviceCreateCommandEncoder(device_, &encoderDesc);
    WGPURenderPassColorAttachment color = {};
    if (sampleCount_ == 4) {
        color.view = msaaColorView_;
        color.resolveTarget = sceneView_;
    } else {
        color.view = sceneView_;
    }
    color.loadOp = keepColor_ ? WGPULoadOp_Load : WGPULoadOp_Clear;
    color.storeOp = WGPUStoreOp_Store;
    color.clearValue = {clear[0], clear[1], clear[2], clear[3]};
#if defined(MYSTRAL_WEBGPU_DAWN)
    color.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
#endif
    WGPURenderPassDepthStencilAttachment depth = {};
    depth.view = sampleCount_ == 4 ? msaaDepthView_ : depthView_;
    depth.depthLoadOp = keepDepth_ ? WGPULoadOp_Load : WGPULoadOp_Clear;
    depth.depthStoreOp = WGPUStoreOp_Store;
    depth.depthClearValue = 1.0f;
    const bool timed = ownsPassTimer_ && passTimer_->active();

    const auto opaque = sortDraws(items, camera, features().stablePasses && features().stableRows);

    double stageStarted = meterStart(cpuMetered_);
    // The light layout every lit program this frame is specialized for, in three's light order.
    // Upper case: the light casts a shadow, which a receiving mesh's program reads; a mesh that does
    // not receive shadows takes the lower-case layout, as three keys a program on receiveShadow.
    DrawCache uncachedBounds;
    std::map<std::size_t, std::vector<shadows::AtlasPage>> virtualPages;
    // One stamp per pass: rigs that share a skeleton read its bones once (PRD-871).
    const uint64_t planStamp = virtualShadows_.empty() ? 0 : Skeleton::nextPlanStamp();    for (auto& [i, shadow] : virtualShadows_) {
        if (compilation) continue;
        if (i >= lights.direct.size() || lights.direct[i].kind != DirectLight::Kind::Directional || !lights.direct[i].shadow)
            throw std::runtime_error("TN_VIRTUAL_SHADOW_UNSUPPORTED: requires a shadow-casting directional light");
        const uint32_t mask = lights.direct[i].shadow->layersMask;
        // FS11: one record per draw list position, sized to the frozen list and kept between frames. The two maps
        // this replaced were rebuilt from scratch every frame: a tree node allocated per caster, an insert per
        // caster into each, and two descents per draw to rebuild the states.
        auto& record = casterRecords_[i];
        record.assign(items.size(), {});
        // A caster whose inputs did not move keeps last frame's bounds and state (PRD-872). `play` re-derives 1,145
        // casters every frame otherwise, and 902 of them are static: the plan is a comparison for those, not a rebuild.
        auto& plan = casterPlan_[i];
        plan.begin(items.size());
        const auto& planControl = *shadow.atlas.options().control;
        const uint64_t controlEpoch = controlStamp(planControl);
        std::vector<Box3> depthCasters, receivers;
        std::vector<uint64_t> emptied;
        std::vector<shadows::CasterState> states;
        std::vector<Box3> rungChanged;
        for (const DrawItem& item : items) {
            if ((!item.castShadow && !item.receiveShadow) || !item.positions || (item.layers & (mask | (1u << 29) | (1u << 28))) == 0) continue;
            if (item.instanceCount == 0) {
                if (item.castShadow) emptied.push_back(item.key);
                continue;
            }
            // Bind-pose bounds cannot fit a GPU-displaced caster without clipping its shadow.
            if (item.castShadow && shadow.atlas.options().autoDepth && !displacedByGeometryBox(item) &&
                (item.positionNode || item.nodes->shadowPositionNode() || item.gpuJoints))
                throw std::runtime_error("TN_VIRTUAL_SHADOW_UNSUPPORTED: automatic depth for GPU-deformed casters; supply lightDistance and depthRange");
            const auto index = std::size_t(&item - items.data());
            shadows::CasterInputs inputs;
            inputs.positions = item.positions;
            inputs.positionsVersion = item.positions->version();
            inputs.instances = item.instanceMatrices;
            inputs.instanceVersion = item.instanceMatrices ? item.instanceMatrices->version() : 0;
            inputs.instanceCount = item.instanceCount;
            inputs.layers = item.layers;
            inputs.cache = item.cache;
            inputs.casts = item.castShadow;
            inputs.controlEpoch = controlEpoch;
            inputs.nodeDeformed = item.positionNode || item.nodes->shadowPositionNode() || item.morphGeometry;
            inputs.skinned = item.boneMatrices != nullptr;
            // One rig's own skeleton; a batch of rigs has no single version to read.
            if (item.skinnedRig && item.skinnedRig->skeleton && !item.instanceMatrices)
                inputs.pose = item.skinnedRig->skeleton->poseVersion();
            bool stale = false;
            shadows::PlannedCaster& caster = plan.slot(index, item.matrixWorld, inputs, stale);
            if (stale) {
                const auto& [bounds, diameter] = (item.cache ? *item.cache : uncachedBounds).virtualShadowBounds(item, planStamp);
                caster.bounds = bounds;
                caster.diameter = diameter;
                caster.casts = item.castShadow;
                // FG1: an uncached draw shares `uncachedBounds`, so it has no per-instance boxes to keep.
                caster.instanceBoxes = item.cache && item.cache->shadowInstanceBoxes.size() == item.instanceCount ? &item.cache->shadowInstanceBoxes : nullptr;
                shadows::CasterState& state = caster.state;
                state.key = item.key; state.bounds = bounds;
                state.signature = shadows::CasterSignature{item.positions->version(), inputs.instanceVersion, item.instanceCount};
                state.tracked = (item.layers & (1u << 29)) != 0;
                state.automatic = (item.layers & 1u) != 0;
                state.pinned = false;
                // The parent chain is only walked when a control set says something about casters at all.
                if (!planControl.tracked.empty() || !planControl.pinned.empty())
                    for (auto* object = item.shadowObject; object; object = object->parent) {
                        state.tracked |= planControl.tracked.count(object->id()) != 0;
                        state.pinned |= planControl.pinned.count(object->id()) != 0;
                    }
            }
            if (caster.casts) {
                record[index] = CasterRecord{caster.bounds, caster.diameter, true, caster.instanceBoxes};
                const auto& lodChanged = planControl.lodChanged;
                if (!lodChanged.empty() && item.shadowObject && lodChanged.count(item.shadowObject->id()))
                    rungChanged.push_back(caster.bounds);
                states.push_back(caster.state);
            }
            depthCasters.push_back(caster.bounds);
            if (item.receiveShadow) receivers.push_back(caster.bounds);
        }
        const auto& direction = lights.direct[i].direction;
        const Vector3 towards(direction[0], direction[1], direction[2]);
        if (!std::isfinite(towards.lengthSq()) || towards.lengthSq() == 0)
            throw std::runtime_error("TN_VIRTUAL_SHADOW_INVALID: light direction");
        const double radius = lights.direct[i].shadow->radius;
        if (!std::isfinite(radius) || radius < 0 ||
            (!lights.direct[i].shadow->sourceAngleFilter && radius + 0.5 > shadow.atlas.options().border))
            throw std::runtime_error("TN_VIRTUAL_SHADOW_UNSUPPORTED: PCF radius exceeds page guard texels");
        auto& control = *shadow.atlas.options().control;
        if (control.invalidateAll) { shadow.atlas.invalidateAll(); control.invalidateAll = false; }
        for (const auto& region : control.regions) shadow.atlas.invalidate(region);
        control.regions.clear();
        // A caster that left the scene with its chain is invalidated by updateCasters' removal pass.
        for (const Box3& bounds : rungChanged) shadow.atlas.invalidate(bounds);
        control.lodChanged.clear();
        // A frame where no caster arrived, left or moved has nothing to hand the atlas: its state is last frame's.
        if (plan.changed()) shadow.atlas.updateCasters(states, emptied);
        {
            std::lock_guard lock(shadow.costs->mutex);
            for (const auto& [level, reading] : shadow.costs->levels) {
                if (shadow.consumedCosts[level] == reading.second) continue;
                shadow.atlas.recordCost(level, reading.first, frameDelta_);
                shadow.consumedCosts[level] = reading.second;
            }
        }

        Vector3 focus(camera.matrixWorld[12], camera.matrixWorld[13], camera.matrixWorld[14]);
        if (shadow.atlas.options().followViewFocus && !control.focus) {
            Vector3 forward(-camera.matrixWorld[8], -camera.matrixWorld[9], -camera.matrixWorld[10]); forward.normalize();
            focus = shadows::PageAtlas::viewFocus(focus, forward, camera.far, shadow.atlas.options().clipExtents.front(), receivers);
        }
        virtualPages[i] = shadow.atlas.update(focus, towards, virtualCut_, depthCasters, frameDelta_);
        shadow.atlas.appendMoverPages(virtualPages[i]);
    }

    if (!compilation) virtualCut_ = false;

    addCpuStage(CpuVirtualPages, stageStarted);
    // PRD-650: a lamp's map is as fine as the finest pixel footprint over the visible receivers it
    // lights (shadows/lamp_resolution.h). A shadow.mapSize other than three's 512² is the game's override.
    std::map<std::size_t, uint32_t> lampSizes;
    if (!compilation) {
        std::vector<std::size_t> autoLamps;
        std::vector<shadows::LampDemand> demands;
        // The unjittered view: a pixel's footprint does not move with the TRAA subpixel offset, and a jittered
        // frustum flips a receiver on the view's edge in and out, which reallocated the map every frame (PRD-539).
        Matrix4 view; view.elements = unjitteredCamera.matrixWorldInverse;
        Matrix4 viewProjection; viewProjection.elements = unjitteredCamera.projectionMatrix; viewProjection.multiply(view);
        const auto& p = unjitteredCamera.projectionMatrix;
        const double screenRadius = std::min(1 / (inputWidth_ * std::abs(p[0])), 1 / (inputHeight_ * std::abs(p[5])));
        const WGPULimits& limits = deviceLimits();
        for (std::size_t i = 0; i < lights.direct.size(); ++i) {
            const DirectLight& l = lights.direct[i];
            if (!l.shadow || l.kind == DirectLight::Kind::Directional || virtualShadows_.count(i)) continue;
            const DirectLight::Shadow& s = *l.shadow;
            if (s.width != 512 || s.height != 512) {
                const std::string note = "TN_LAMP_SHADOW_MAPSIZE_OVERRIDE: light " + std::to_string(l.id) + " keeps shadow.mapSize " +
                    std::to_string(s.width) + "x" + std::to_string(s.height) + " instead of its footprint size";
                if (std::find(diagnostics_.begin(), diagnostics_.end(), note) == diagnostics_.end()) diagnostics_.push_back(note);
                continue;
            }
            // A pose seen for the first time is still: a still lamp draws its first map at its still size.
            uint64_t pose = 0xcbf29ce484222325ull;
            for (double e : l.position) pose = (pose ^ std::bit_cast<uint64_t>(e)) * 0x100000001b3ull;
            for (double e : l.direction) pose = (pose ^ std::bit_cast<uint64_t>(e)) * 0x100000001b3ull;
            auto [state, seen] = lampMotion_.try_emplace(i, LampMotion{pose, int64_t(id) - shadows::kLampActiveFrames});
            if (state->second.pose != pose) state->second = {pose, int64_t(id)};
            shadows::LampDemand demand;
            demand.mobility = shadows::lampMobility(int64_t(id) - state->second.movedAt);
            demand.cube = s.cube;
            while (shadows::lampMipSize(demand.minMip) > limits.maxTextureDimension2D && demand.minMip < shadows::kLampMaxMip) ++demand.minMip;
            const Vector3 at(l.position[0], l.position[1], l.position[2]);
            const Vector3 axis = Vector3(-l.direction[0], -l.direction[1], -l.direction[2]).normalize();
            Matrix4 shadowView; shadowView.elements = s.view;
            double footprint = INFINITY;
            const auto visit = [&](const Vector3& point) {
                Vector4 clip(point.x, point.y, point.z, 1); clip.applyMatrix4(viewProjection);
                if (!(clip.w > 0) || std::abs(clip.x) > clip.w || std::abs(clip.y) > clip.w || clip.z < 0 || clip.z > clip.w) return;
                const Vector3 offset = Vector3(point).sub(at);
                const double reach = offset.length();
                if ((l.distance > 0 && reach > l.distance) || reach == 0) return;
                if (l.kind == DirectLight::Kind::Spot && offset.dot(axis) < l.coneCos * reach) return;
                const double shadowDepth = s.cube ? std::max({std::abs(offset.x), std::abs(offset.y), std::abs(offset.z)})
                                                  : -Vector3(point).applyMatrix4(shadowView).z;
                if (!(shadowDepth > s.near)) return;
                const double sceneDepth = -Vector3(point).applyMatrix4(view).z;
                footprint = std::min(footprint, shadows::lampFootprint(sceneDepth * -p[11] + p[15], screenRadius, std::abs(s.projection[0]), shadowDepth));
            };
            // ponytail: a 5³ grid and the camera's nearest point per receiver box; a depth-buffer reduction
            // (Unreal's page marking) when a big receiver's grid misses the pixels nearest the camera.
            const Vector3 eye(camera.matrixWorld[12], camera.matrixWorld[13], camera.matrixWorld[14]);
            for (const DrawItem& item : items) {
                if (!item.mainPass || !item.receiveShadow || (item.layers & s.layersMask) == 0) continue;
                const auto* mesh = dynamic_cast<const Mesh*>(item.shadowObject);
                if (!mesh || !mesh->geometry) continue;
                std::shared_ptr<Box3> local = mesh->geometry->boundingBox;
                if (const auto* instanced = dynamic_cast<const InstancedMesh*>(mesh)) {
                    if (!instanced->boundingBox) const_cast<InstancedMesh*>(instanced)->computeBoundingBox();
                    local = instanced->boundingBox;
                } else if (!local) {
                    mesh->geometry->computeBoundingBox();
                    local = mesh->geometry->boundingBox;
                }
                if (!local || local->isEmpty()) continue;
                Matrix4 model; model.elements = item.matrixWorld;
                Box3 box = *local; box.applyMatrix4(model);
                if (l.distance > 0 && box.distanceToPoint(at) > l.distance) continue;
                for (int x = 0; x < 5; ++x) for (int y = 0; y < 5; ++y) for (int z = 0; z < 5; ++z)
                    visit(Vector3(box.min.x + (box.max.x - box.min.x) * x / 4, box.min.y + (box.max.y - box.min.y) * y / 4,
                                  box.min.z + (box.max.z - box.min.z) * z / 4));
                Vector3 nearest; box.clampPoint(eye, nearest);
                visit(nearest);
            }
            demand.footprint = std::isfinite(footprint) ? footprint : 0;
            autoLamps.push_back(i);
            demands.push_back(demand);
        }
        const auto sizes = shadows::lampMapSizes(demands);
        for (std::size_t k = 0; k < autoLamps.size(); ++k) lampSizes[autoLamps[k]] = sizes[k];
    }
    const auto mapExtent = [&](std::size_t i) {
        const auto found = lampSizes.find(i);
        return found != lampSizes.end() ? std::array<uint32_t, 2>{found->second, found->second}
                                        : std::array<uint32_t, 2>{lights.direct[i].shadow->width, lights.direct[i].shadow->height};
    };
    std::string lightKinds, unshadowedKinds;
    for (std::size_t i = 0; i < lights.direct.size(); ++i) {
        const DirectLight& l = lights.direct[i];
        if (l.shadow)
            if (const char* refusal = sourceAngleFilterRefusal(*l.shadow)) throw std::runtime_error(refusal);
        const char kind = l.kind == DirectLight::Kind::Directional ? 'd' : l.kind == DirectLight::Kind::Point ? 'p' : 's';
        unshadowedKinds += kind;
        // A lamp with sourceRadiusShadowFilter reads the soft filter: 'Q' a point light, 'R' a spot light.
        const char shadowed = l.shadow && l.shadow->sourceRadiusFilter ? (kind == 'p' ? 'Q' : 'R') : static_cast<char>(kind - 'a' + 'A');
        // A virtual shadow's kind counts its levels from '0', or from '8' when its source-angle filter is compiled in.
        lightKinds += virtualShadows_.count(i) ? char((l.shadow->sourceAngleFilter ? '8' : '0') + virtualShadows_.at(i).atlas.options().clipExtents.size())
                                               : l.shadow ? shadowed : kind;
        if (virtualShadows_.count(i)) {
            ensureVirtualShadowMap(i);
            continue;
        }
        if (!l.shadow) continue;
        std::vector<ShadowMap>& maps = l.shadow->cube ? cubeShadowMaps_ : shadowMaps_;
        if (maps.size() <= i) maps.resize(i + 1);
        ShadowMap& map = maps[i];
        const auto [mapWidth, mapHeight] = mapExtent(i);
        if (map.width == mapWidth && map.height == mapHeight) continue;
        if (map.view) wgpuTextureViewRelease(map.view);
        for (WGPUTextureView& face : map.faces) {
            if (face) wgpuTextureViewRelease(face);
            face = nullptr;
        }
        if (map.texture) wgpuTextureRelease(map.texture);
        WGPUTextureDescriptor desc = {};
        desc.dimension = WGPUTextureDimension_2D;
        desc.size = {mapWidth, mapHeight, l.shadow->cube ? 6u : 1u};
        desc.format = WGPUTextureFormat_Depth24Plus;
        desc.usage = WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_TextureBinding;
        desc.mipLevelCount = 1;
        desc.sampleCount = 1;
        map.texture = wgpuDeviceCreateTexture(device_, &desc);
        map.cube = l.shadow->cube;
        if (map.cube) {
            WGPUTextureViewDescriptor view = {};
            view.format = WGPUTextureFormat_Depth24Plus;
            view.mipLevelCount = 1;
            view.dimension = WGPUTextureViewDimension_Cube;
            view.arrayLayerCount = 6;
            map.view = wgpuTextureCreateView(map.texture, &view);
            view.dimension = WGPUTextureViewDimension_2D;
            view.arrayLayerCount = 1;
            for (uint32_t face = 0; face < 6; ++face) {
                view.baseArrayLayer = face;
                map.faces[face] = wgpuTextureCreateView(map.texture, &view);
            }
        } else {
            map.view = view2d(map.texture, WGPUTextureFormat_Depth24Plus);
        }
        map.width = mapWidth;
        map.height = mapHeight;
        mapSignatures_.erase(i);  // a new texture holds no depth: its first frame draws
        shadowMapsChanged_ = true;
    }

    // Each skinned draw's palette, appended once to the frame's bone buffer; its draws (main and shadow)
    // read it from `boneBase`. three's skeleton.update() ran in the render database.
    // Each morphed draw's targets and influences likewise (three's morph texture, as vec4 per vertex
    // and target, the normal after the position), and its base influence: 1 for relative targets,
    // else 1 minus the influences' sum, summed in double as JS reduces them.
    for (auto& [name, storage] : storages_)
        if (name.rfind("probe_", 0) != 0 && name != "instances") storage.data.clear();
    for (const auto& [i, shadow] : virtualShadows_) {
        auto& table = storages_["vsmTable" + std::to_string(i)].data;
        table = shadow.atlas.table();
        const auto& filter = lights.direct[i].shadow->sourceAngleFilter;
        table.insert(table.end(), {filter ? float(std::tan((*filter)[0])) : 0.0f,
            filter ? float((*filter)[1]) : 0.0f, filter ? float((*filter)[2]) : 0.0f,
            filter ? 1.0f + float((*filter)[3]) : 0.0f});  // w > 0 is the filter; w - 1 its minimum penumbra, in pixels
        // The shadow-ray test: samples per ray (0 is off) and the ray length over the view distance.
        table.insert(table.end(), {filter ? float((*filter)[4]) : 0.0f, filter ? float((*filter)[5]) : 0.0f, 0.0f, 0.0f});
    }
    const uint64_t jointPrefix = gpuJoints_ && gpuJoints_->current() ? gpuJoints_->parents.size() * 64 : 0;
    std::vector<float>& bones = storages_["boneMatrices"].data;
    std::vector<float>& morphData = storages_["morphData"].data;
    std::vector<float>& morphInfluences = storages_["morphInfluences"].data;
    std::vector<float>& instances = storages_["instances"].data;
    std::unordered_map<const DrawItem*, double> instanceBases;
    // Twenty floats per instance: its matrix, then its colour and a pad. TR1: a draw keeps its place from plan to
    // plan (instanceSlots_), so a depth reorder or a draw that leaves the view moves no other draw's bytes, and the
    // upload below sends only the bytes that changed. The storage keeps its elements between plans, so a steady
    // crowd overwrites memory it owns; the shadow rows append past instanceTop_ and the next plan cuts them off.
    if (planSerial_ % 256 == 0) {  // a place unasked for in a long time goes; when the gaps outweigh the live places, start over
        uint64_t live = 0;
        for (auto slot = instanceSlots_.begin(); slot != instanceSlots_.end();) {
            if (planSerial_ - slot->second.seen > kInstanceSlotPlans) slot = instanceSlots_.erase(slot);
            else live += (slot++)->second.count;
        }
        if (instanceTop_ > 2 * live + 20 * 1024) { instanceSlots_.clear(); instanceTop_ = 0; }
    }
    instancePlanned_.clear();
    instanceDirty_.clear();
    uint32_t instanceCopies = 0;
    for (const auto& [depth, drawn] : opaque) {
        if (!drawn->instanceMatrices) continue;
        if (drawn->indirect) {  // read in place as a vertex buffer; nothing to pack
            instanceBases[drawn] = 0.0;
            continue;
        }
        const uint64_t floats = uint64_t{drawn->instanceCount} * 20;
        const BufferStore& matrixStore = *drawn->instanceMatrices;
        const BufferStore* colorStore = drawn->instanceColors;
        InstanceSlot& slot = instanceSlots_[{matrixStore.id(), colorStore ? colorStore->id() : 0}];
        bool placed = false;
        if (slot.count < floats) {  // new, or grown past its place: the last place grows in place, any other takes the end
            if (slot.count != 0 && slot.offset + slot.count == instanceTop_) {
                instanceTop_ += floats - slot.count;
            } else {
                slot.offset = instanceTop_;
                instanceTop_ += floats;
            }
            slot.count = floats;
            placed = true;
        }
        slot.seen = planSerial_;
        instanceBases[drawn] = double(slot.offset / 4);
        // Three's rule: a store whose epoch, write count and version did not move has the bytes it had. A place that
        // moved or grew has nothing on the GPU yet, so it copies whatever its stamp says.
        const InstanceStamp stamp{matrixStore.epoch(), matrixStore.writes(), matrixStore.version(),
                                  colorStore ? colorStore->epoch() : 0, colorStore ? colorStore->writes() : 0,
                                  colorStore ? colorStore->version() : 0, drawn->instanceCount};
        instancePlanned_.emplace_back(&slot, stamp);
        if (!placed && slot.stamped && slot.stamp == stamp) continue;
        const auto* matrices = reinterpret_cast<const float*>(matrixStore.data());
        const auto* colors = colorStore ? reinterpret_cast<const float*>(colorStore->data()) : nullptr;
        if (instances.size() < instanceTop_) instances.resize(instanceTop_);
        float* out = instances.data() + slot.offset;
        for (uint32_t i = 0; i < drawn->instanceCount; ++i, out += 20) {
            std::memcpy(out, matrices + i * 16, 16 * sizeof(float));
            out[16] = colors ? colors[i * 3] : 1;
            out[17] = colors ? colors[i * 3 + 1] : 1;
            out[18] = colors ? colors[i * 3 + 2] : 1;
            out[19] = 0;
        }
        slot.stamped = false;  // until the upload below has gone through
        ++instanceCopies;
        instanceDirty_.emplace_back(slot.offset, floats);
    }
    instances.resize(instanceTop_);
    struct Deform {
        double boneBase = 0, morphBase = 0, morphInfluenceBase = 0, morphVertexCount = 0, morphBaseInfluence = 1;
    };
    // FrameStats::paletteWrites: the palettes copied below. Bytes decide, not pointers: SkeletonUtils.clone gives each
    // primitive its own Skeleton over the same bones, and a palette batch holds a copy of each rig's matrices, so one
    // rig reaches this list four times (two primitives, main batch and shadow draw) with the same bytes. Each palette's
    // rig starts are keyed by their first matrix, so a draw reuses a batch's slot. A batch reads contiguous rigs, so
    // batches go first and only draws with the same bytes in the same order share one.
    uint32_t paletteWrites = 0;
    std::unordered_map<const DrawItem*, Deform> deforms;
    std::unordered_multimap<uint64_t, uint32_t> paletteStarts;
    const auto firstMatrixKey = [](const float* matrix) {
        uint64_t key = 14695981039346656037ull;
        for (int i = 0; i < 16; ++i) key = (key ^ std::bit_cast<uint32_t>(matrix[i])) * 1099511628211ull;
        return key;
    };
    std::unordered_map<const std::vector<float>*, double> placedPalettes;  // a palette two draws read is compared once
    const auto placePalette = [&](const std::vector<float>& matrices, uint32_t stride) {
        const auto baseOf = [&](std::size_t at) { return double(jointPrefix / 64 + at / 16); };
        if (matrices.size() < 16) return baseOf(bones.size());
        if (const auto placed = placedPalettes.find(&matrices); placed != placedPalettes.end()) return placed->second;
        const auto remember = [&](double base) { placedPalettes.emplace(&matrices, base); return base; };
        const auto [from, to] = paletteStarts.equal_range(firstMatrixKey(matrices.data()));
        for (auto start = from; start != to; ++start) {
            if (start->second + matrices.size() <= bones.size() &&
                std::memcmp(bones.data() + start->second, matrices.data(), matrices.size() * sizeof(float)) == 0)
                return remember(baseOf(start->second));
        }
        const std::size_t at = bones.size();
        const std::size_t step = stride ? std::size_t{stride} * 16 : matrices.size();
        for (std::size_t o = 0; o + 16 <= matrices.size(); o += step)
            paletteStarts.emplace(firstMatrixKey(matrices.data() + o), uint32_t(at + o));
        bones.insert(bones.end(), matrices.begin(), matrices.end());
        ++paletteWrites;
        return remember(baseOf(at));
    };
    for (const auto& [depthKey, drawn] : opaque) {
        if (drawn->boneMatrices && drawn->boneStride && !drawn->gpuJoints)
            deforms[drawn].boneBase = placePalette(*drawn->boneMatrices, drawn->boneStride);
    }
    std::vector<uint32_t> jointOutputs(jointPrefix ? gpuJoints_->rigs.size() : 0, UINT32_MAX);
    uint32_t jointWritten = 0;
    for (const auto& [depthKey, drawn] : opaque) {
        if (!drawn->boneMatrices && !drawn->morphGeometry) continue;
        Deform& d = deforms[drawn];
        if (drawn->boneMatrices) {
            if (drawn->gpuJoints) {
                if (drawn->gpuJoints != gpuJoints_ || !jointPrefix) throw std::runtime_error("TN_GPU_JOINTS: invalidated before submission");
                d.boneBase = jointWritten;
                auto place = [&](uint32_t rig) {
                    if (rig >= jointOutputs.size() || jointOutputs[rig] != UINT32_MAX)
                        throw std::runtime_error("TN_GPU_JOINTS: duplicate or invalid batch rig");
                    jointOutputs[rig] = jointWritten;
                    jointWritten += gpuJoints_->topology[rig].count;
                };
                if (drawn->gpuJointRigs.empty()) place(drawn->gpuJointRig);
                else for (uint32_t rig : drawn->gpuJointRigs) place(rig);
                paletteWrites += drawn->gpuJointRigs.empty() ? 1u : uint32_t(drawn->gpuJointRigs.size());
            } else if (!drawn->boneStride) {
                d.boneBase = placePalette(*drawn->boneMatrices, 0) + drawn->boneOffset;
            }
        }
        if (const BufferGeometry* g = drawn->morphGeometry) {
            const bool normals = !g->morphNormals.empty();
            const std::size_t vertices = g->morphPositions.front()->count();
            d.morphBase = double(morphData.size() / 4);
            d.morphVertexCount = double(vertices);
            // three packs a geometry's morph texture once and reuses it (three r187 src/nodes/accessors/Morph.js:93-199
            // getEntry, a WeakMap per geometry); repacking every component every frame cost each morphed draw a
            // pass over all its targets. The pack moves with the geometry's revision and each target's writes.
            bool packed = g->morphPackedRevision_ == g->revision() &&
                          g->morphPackedAt_.size() == g->morphPositions.size() + g->morphNormals.size();
            for (std::size_t i = 0; packed && i < g->morphPositions.size(); ++i)
                packed = g->morphPackedAt_[i] == std::pair<const BufferAttribute*, uint32_t>{g->morphPositions[i].get(), g->morphPositions[i]->version()};
            for (std::size_t i = 0; packed && i < g->morphNormals.size(); ++i)
                packed = g->morphPackedAt_[g->morphPositions.size() + i] ==
                         std::pair<const BufferAttribute*, uint32_t>{g->morphNormals[i].get(), g->morphNormals[i]->version()};
            if (!packed) {
                std::vector<float>& pack = g->morphPacked_;
                pack.clear();
                pack.reserve(g->morphPositions.size() * vertices * (normals ? 8 : 4));
                for (std::size_t i = 0; i < g->morphPositions.size(); ++i) {
                    for (std::size_t j = 0; j < vertices; ++j) {
                        const BufferAttribute& p = *g->morphPositions[i];
                        pack.insert(pack.end(), {float(p.getComponent(j, 0)), float(p.getComponent(j, 1)),
                                                 float(p.getComponent(j, 2)), 0.0f});
                        if (normals) {
                            const BufferAttribute& n = *g->morphNormals.at(i);
                            pack.insert(pack.end(), {float(n.getComponent(j, 0)), float(n.getComponent(j, 1)),
                                                     float(n.getComponent(j, 2)), 0.0f});
                        }
                    }
                }
                g->morphPackedRevision_ = g->revision();
                g->morphPackedAt_.clear();
                for (const auto& target : g->morphPositions) g->morphPackedAt_.emplace_back(target.get(), target->version());
                for (const auto& target : g->morphNormals) g->morphPackedAt_.emplace_back(target.get(), target->version());
                ++morphPacks_;
            }
            morphData.insert(morphData.end(), g->morphPacked_.begin(), g->morphPacked_.end());
            d.morphInfluenceBase = double(morphInfluences.size());
            double sum = 0;
            for (const double influence : *drawn->morphInfluences) {
                morphInfluences.push_back(float(influence));
                sum += influence;
            }
            // One influence per target the program reads; a shorter array reads as zeros.
            for (std::size_t i = drawn->morphInfluences->size(); i < g->morphPositions.size(); ++i)
                morphInfluences.push_back(0.0f);
            d.morphBaseInfluence = g->morphTargetsRelative ? 1 : 1 - sum;
        }
    }
    auto putSkin = [&](uint64_t v, const shader::UniformField* const* vs, const DrawItem& item) {
        const auto found = deforms.find(&item);
        if (found == deforms.end()) return;
        const Deform& d = found->second;
        if (item.boneMatrices) {
            put(frameUniforms_, v, vs[kBoneStride], std::array<double, 1>{double(item.boneStride)});
            put(frameUniforms_, v, vs[kBoneBase], std::array<double, 1>{d.boneBase});
            put(frameUniforms_, v, vs[kBindMatrix], item.bindMatrix);
            put(frameUniforms_, v, vs[kBindMatrixInverse], item.bindMatrixInverse);
        }
        put(frameUniforms_, v, vs[kMorphBase], std::array<double, 1>{d.morphBase});
        put(frameUniforms_, v, vs[kMorphInfluenceBase], std::array<double, 1>{d.morphInfluenceBase});
        put(frameUniforms_, v, vs[kMorphVertexCount], std::array<double, 1>{d.morphVertexCount});
        put(frameUniforms_, v, vs[kMorphBaseInfluence], std::array<double, 1>{d.morphBaseInfluence});
    };
    // Only a frame that draws a second pipeline depth-Equal against the colour pass asks for @invariant
    // positions: the normal pass (it shares the colour vertex stage) and TRAA's velocity pass (its own
    // vertex stage, flagged the same way below). Every other frame is compiled as three's is.
    const bool invariantPosition = (postEffects_ && (postEffects_->reads("normal") || postEffects_->reads("albedo") ||
        postEffects_->reads("emissive") || postEffects_->reads("indirectDiffuse") || postEffects_->reads("metalness") ||
        postEffects_->reads("roughness"))) || traa_;
    // variantOf's inputs that refresh()'s material half does not own (see DepthRowKey).
    const auto depthRowKey = [invariantPosition](const DrawItem& item) {
        DepthRowKey k;
        k.material = item.material; k.nodes = item.nodes; k.fogNode = item.nodes->fogNode.get(); k.morph = item.morphGeometry;
        k.side = item.side; k.colorSize = item.colorSize; k.map = item.map != nullptr;
        if (item.morphGeometry) {
            k.morphTargets = uint32_t(item.morphGeometry->morphPositions.size());
            k.morphNormals = !item.morphGeometry->morphNormals.empty();
        }
        k.fog = item.fog ? item.fog->exponential() ? 2 : 1 : 0;
        k.invariantPosition = invariantPosition; k.background = item.background; k.sprite = item.sprite;
        k.receiveShadow = item.receiveShadow; k.envMap = item.envMap != nullptr;
        k.instanced = item.instanceMatrices != nullptr; k.instanceColor = item.instanceColors != nullptr;
        k.indirect = item.indirect != nullptr; k.skinned = item.boneMatrices != nullptr; k.palette = item.boneStride != 0;
        k.shadowGroup = item.shadowGroup;
        return k;
    };
    auto variantOf = [invariantPosition](const DrawItem& item) {
        shader::VertexVariant v;
        v.invariantPosition = invariantPosition;
        v.alphaHash = item.material && item.material->alphaHash;
        v.alphaTest = item.material && item.material->alphaTest > 0;
        v.background = item.background;
        v.fog = item.fog ? item.fog->exponential() ? 2 : 1 : 0;
        v.sprite = item.sprite;
        v.backSide = item.side == 1;
        v.doubleSide = item.side == 2;
        v.leafReceiver = item.receiveShadow && item.twoSidedFoliage;
        v.twoSidedFoliage = item.twoSidedFoliage;
        v.roughDiffuse = item.roughDiffuse;
        v.flatShading = item.flatShading;
        v.premultipliedAlpha = (item.blendFactors >> 54) & 1;  // Material::blendFactors: premultipliedAlpha
        v.vertexColors = item.colors ? item.colorSize : 0;
        v.instanced = item.instanceMatrices != nullptr;
        v.instanceColor = item.instanceColors != nullptr;
        v.vertexColors = item.colorSize;
        // An indirect draw's instances live where the GPU wrote them (core's cull kernel, PRD-857): bound as an
        // instance-step vertex buffer, as three binds a StorageInstancedBufferAttribute, `firstInstance` from the
        // record offsets the fetch. The packed frame copy reads the CPU store, which the GPU never writes back.
        v.instanceStorage = v.instanced && !item.indirect;
        v.skinned = item.boneMatrices != nullptr;
        v.skinnedPalette = item.boneStride != 0;
        v.skinInstanceValues = item.shadowGroup && item.boneMatrices != nullptr;
        if (item.morphGeometry) {
            v.morphTargets = static_cast<uint8_t>(item.morphGeometry->morphPositions.size());
            v.morphNormals = !item.morphGeometry->morphNormals.empty();
        }
        v.positionNode = item.positionNode;
        v.nodes = *item.nodes;
        v.environment = item.envMap != nullptr;
        v.map = item.map != nullptr;
        v.normalMap = item.normalMap != nullptr;
        for (int k = 0; k < shader::kPbrMapCount; ++k)
            if (item.pbrMaps[k]) v.pbrMaps |= static_cast<uint16_t>(1u << k);
        // three's useClearcoat: a physical material with clearcoat > 0 builds the clearcoat layer.
        v.clearcoat = item.kind == MaterialKind::Physical && item.material && item.material->clearcoat > 0;
        v.mapSRGB = false;  // WGSLNodeBuilder uses GPU sRGB formats; no shader colour conversion.
        return v;
    };

    // The program invalidators (PRD-...): a draw whose VertexVariant, kind and light layout are
    // unchanged reuses its record's cached Program*, exactly as three keys a material's program cache.
    const auto hashBytes = [](const void* data, std::size_t size) {
        uint64_t h = 0xcbf29ce484222325ull;  // FNV-1a: stable across runs and targets
        for (const unsigned char* p = static_cast<const unsigned char*>(data), *end = p + size; p != end; ++p)
            h = (h ^ *p) * 0x100000001b3ull;
        return h;
    };
    const uint64_t lightKindsKey = hashBytes(lightKinds.data(), lightKinds.size());
    const uint64_t unshadowedKindsKey = hashBytes(unshadowedKinds.data(), unshadowedKinds.size());
    const uint64_t basicLightsKey = hashBytes("", 0) ^ 0x5bf03635ull;
    // NodeMaterial.lightsNode: the kinds with every light it does not list marked excluded, then `#` and the ids it
    // lists. The ids key the program, whose frame slab then holds only their ambient and hemisphere terms.
    // ponytail: rebuilt per draw each frame; cache it on the draw when many materials carry a lightsNode.
    const auto selectiveLights = [&](const DrawItem& item) {
        const shader::graph::Node& node = item.nodes ? item.nodes->lightsNode : shader::graph::Node{};
        std::string out;
        if (!node || item.kind == MaterialKind::Basic) return out;
        std::vector<uint64_t> ids;
        for (const auto& entry : node->args)
            ids.push_back(static_cast<const Light*>(entry->object.get())->id());
        std::sort(ids.begin(), ids.end());
        ids.erase(std::unique(ids.begin(), ids.end()), ids.end());
        const auto listed = [&](uint64_t id) { return std::binary_search(ids.begin(), ids.end(), id); };
        out = item.receiveShadow ? lightKinds : unshadowedKinds;
        for (std::size_t i = 0; i < lights.direct.size(); ++i)
            if (!listed(lights.direct[i].id)) out[i] = shader::LightLayout::kExcluded;
        out += '#';
        for (const uint64_t id : ids) out += std::to_string(id) + ',';
        return out;
    };
    const auto drawLightsKey = [&](const DrawItem& item, const std::string& selective) {
        // A receiving mesh reads its lights' shadow maps, any other the unshadowed kinds: three keys a program on
        // receiveShadow, and r187 has one shadow filter, so the map type no longer enters the key.
        return !selective.empty()                 ? hashBytes(selective.data(), selective.size())
               : item.kind == MaterialKind::Basic ? basicLightsKey
               : item.receiveShadow               ? lightKindsKey
                                                  : unshadowedKindsKey;
    };
    // The pipeline target inputs not already in the VertexVariant: side, blending, depth state and
    // the vertex layout. Equal keys mean the same pipeline, so the cached handle can be reused.
    const auto drawTargetKey = [&](const DrawItem& item, const shader::StageModule& vertex) {
        uint64_t h = 0xcbf29ce484222325ull;
        const auto mix = [&h](uint64_t v) { h = (h ^ v) * 0x100000001b3ull; };
        mix(item.side); mix(item.shadowSide); mix(item.blending); mix(item.blendFactors); mix(item.transparent); mix(item.depthWrite); mix(item.depthTest); mix(item.colorWrite);
        mix(item.depthBias); mix(std::bit_cast<uint32_t>(item.depthBiasSlopeScale));
        mix(item.background); mix(item.frontFace() == WGPUFrontFace_CW);
        mix(static_cast<uint64_t>(item.topology));
        mix(item.indices ? item.indices->scalar() == Scalar::U32 : 0);
        mix(static_cast<uint64_t>(skinIndexFormat(item)));
        mix(instanceStepMask(vertex, item));
        mix(sampleCount_);
        return h;
    };

    stageStarted = meterStart(cpuMetered_);
    // Plan: each draw's program, pipeline and uniform slices, all uniforms into one CPU block.
    FrameJob compileJob;  // a compile plans pipelines only: it never touches a pending frame's job
    if (!compilation && !job_) job_ = std::make_unique<FrameJob>();
    FrameJob& job = compilation ? compileJob : *job_;
    job.plan.clear(); job.velocityPlan.clear(); job.auxPlan.clear(); job.translucentPlan.clear();
    job.shadowPasses.clear(); job.shadowLodItems.clear();
    job.shadowGroupItems.clear(); job.shadowGroups.clear();
    job.previousBytes = {}; job.previousSeed = false; job.keptShadowMaps = 0; job.shadowGroupRows = 0; job.paletteWrites = paletteWrites; job.instanceCopies = instanceCopies;
    job.deformationFrames.clear();
    std::vector<Planned>& plan = job.plan;
    std::vector<Planned>& velocityPlan = job.velocityPlan;
    plan.reserve(opaque.size());
    const auto colourTarget = [&](const DrawItem& item, const Program& program) {
        // material.side: FrontSide culls back faces, BackSide front faces, DoubleSide none.
        const WGPUCullMode cull = item.side == 2 ? WGPUCullMode_None : item.side == 1 ? WGPUCullMode_Front : WGPUCullMode_Back;
        // three blends unless NoBlending, or NormalBlending on a material that is not transparent.
        uint32_t blendState = 0;
        const uint8_t blend = materialBlend(item.blending, item.transparent, item.blendFactors, blendState);
        PipelineTarget target{sceneFormat_, WGPUTextureFormat_Depth32Float, cull, blend,
                              item.depthWrite};
        target.blendState = blendState;
        target.colorWrite = item.colorWrite;
        target.sampleCount = sampleCount_;
        target.layout = program.pipelineLayout;
        if (item.background || !item.depthTest) target.depthCompare = WGPUCompareFunction_Always;
        target.depthBias = item.depthBias;
        target.depthBiasSlopeScale = item.depthBiasSlopeScale;
        target.frontFace = item.frontFace();
        target.skinIndex = skinIndexFormat(item);
        target.instanceStepMask = instanceStepMask(program.vertex, item);
        lineTopology(target, item);
        return target;
    };
    // The main draws' blocks: a stable slot per draw (PRD-754), or appended in plan order with the knob off.
    // A new slot takes a freed block of its size, else grows the arena; returns false when this frame's appended blocks
    // already sit where the arena would grow.
    const auto addSlot = [&](uint64_t slotKey, uint64_t bytes) {
        auto& free = freeSlots_[bytes];
        uint64_t at = slotArena_;
        if (!free.empty()) { at = free.back(); free.pop_back(); }
        else if (frameUniforms_.size() > slotArena_) return false;
        else slotArena_ += bytes;
        uniformSlots_.emplace(slotKey, UniformSlot{at, bytes, 0});
        if (frameUniforms_.size() < slotArena_) frameUniforms_.resize(slotArena_, 0);
        return true;
    };
    if (features().stablePasses && !compilation) {
        frameUniforms_.resize(slotArena_);
        ++slotFrame_;
        slotUses_.clear();
        // The slots asked for after last frame's appended blocks (a velocity block after the transparent draws') are
        // made first, before this frame appends any.
        for (const auto& [slotKey, bytes] : lateSlots_)
            if (!uniformSlots_.contains(slotKey)) addSlot(slotKey, bytes);
        lateSlots_.clear();
    } else {
        frameUniforms_.clear();
    }
    const auto uniformBlocks = [&](uint64_t slotKey, uint64_t bytes, bool zero = true) -> uint64_t {
        const auto append = [&] {
            const uint64_t at = frameUniforms_.size();
            frameUniforms_.resize(at + bytes, 0);
            return at;
        };
        if (slotKey == 0) return append();
        auto slot = uniformSlots_.find(slotKey);
        if (slot != uniformSlots_.end() && slot->second.bytes != bytes) {
            freeSlots_[slot->second.bytes].push_back(slot->second.offset);
            uniformSlots_.erase(slot);
            slot = uniformSlots_.end();
        }
        if (slot == uniformSlots_.end()) {
            if (!addSlot(slotKey, bytes)) {  // appended this frame, a slot from the next
                lateSlots_.emplace_back(slotKey, bytes);
                return append();
            }
            slot = uniformSlots_.find(slotKey);
        }
        slot->second.seen = slotFrame_;
        if (zero) std::memset(frameUniforms_.data() + slot->second.offset, 0, bytes);
        return slot->second.offset;
    };
    // FM2: the fields every draw of a frame writes the same bytes for — the light slab, the camera slots, the
    // shadow noise term, hemisphere and ambient — in a slot's own layout (v then f). A draw used to evaluate
    // them into its own slot: roughly two thirds of a lit draw's slot writes, and the reason a whole arena was
    // re-uploaded every frame. They are frame-constant, so this writes them where the caller says: once into a
    // program's slab, and no longer once per draw. `fog` stays per draw: `item.fog` is the draw's own pointer, so a
    // slab would need every draw of the program to share one.
    const std::array<double, 3> cameraPosition{camera.matrixWorld[12], camera.matrixWorld[13], camera.matrixWorld[14]};
    const auto putFrameConstants = [&](std::vector<uint8_t>& block, uint64_t v, uint64_t f, Program& program) {
        waste::count(waste::counters().uniformFrameConstantEvaluations);
        const auto* vs = program.vertexSlots;
        const auto* fs = program.fragmentSlots;
        put(block, v, vs[kViewMatrix], view);
        put(block, v, vs[kProjectionMatrix], camera.projectionMatrix);
        put(block, f, fs[kViewMatrix], view);  // normalWorld is derived in the fragment, as three does
        for (const auto [base, slots] : {std::pair{v, vs}, std::pair{f, fs}}) {
            put(block, base, slots[kCameraPosition], cameraPosition);  // TSL's camera accessors, either stage
            put(block, base, slots[kCameraProjectionMatrix], camera.projectionMatrix);
            put(block, base, slots[kCameraWorldMatrix], camera.matrixWorld);
            put(block, base, slots[kCameraNear], std::array<double, 1>{camera.near});
            put(block, base, slots[kCameraFar], std::array<double, 1>{camera.far});
            put(block, base, slots[kScreenSize], std::array<double, 2>{double(inputWidth_), double(inputHeight_)});  // a vertex stage projects by hand
        }
        for (std::size_t i = 0; i < lights.direct.size() && i < program.lightSlots.size(); ++i) {
            const DirectLight& l = lights.direct[i];
            const auto& slot = program.lightSlots[i];
            put(block, f, slot[kLightColor], l.color);
            put(block, f, slot[kLightDirection], rotate(view, l.direction));
            put(block, f, slot[kLightAxis], rotate(view, l.direction));
            put(block, f, slot[kLightPosition], transformPoint(view, l.position));
            put(block, f, slot[kLightDistance], std::array<double, 1>{l.distance});
            put(block, f, slot[kLightDecay], std::array<double, 1>{l.decay});
            put(block, f, slot[kLightSourceRadius], std::array<double, 1>{l.sourceRadius});
            put(block, f, slot[kLightConeCos], std::array<double, 1>{l.coneCos});
            put(block, f, slot[kLightPenumbraCos], std::array<double, 1>{l.penumbraCos});
            if (l.shadow) {
                put(block, f, slot[kLightShadowMatrix], l.shadow->matrix);
                put(block, f, slot[kLightShadowBias], std::array<double, 1>{l.shadow->bias});
                put(block, f, slot[kLightShadowNormalBias], std::array<double, 1>{l.shadow->normalBias});
                put(block, f, slot[kLightShadowRadius], std::array<double, 1>{l.shadow->radius});
                put(block, f, slot[kLightShadowMapSize],
                    std::array<double, 2>{double(mapExtent(i)[0]), double(mapExtent(i)[1])});
                put(block, f, slot[kLightShadowIntensity], std::array<double, 1>{l.shadow->intensity});
                put(block, f, slot[kLightShadowNear], std::array<double, 1>{l.shadow->near});
                put(block, f, slot[kLightShadowFar], std::array<double, 1>{l.shadow->far});
                if (const auto& soft = l.shadow->sourceRadiusFilter) {
                    put(block, f, slot[kLightShadowSourceRadius],
                        std::array<double, 4>{(*soft)[0], l.shadow->tanHalfFov, (*soft)[1], (*soft)[2]});
                    put(block, f, slot[kLightShadowPenumbraScale], std::array<double, 1>{(*soft)[3]});
                }
            }
        }
        put(block, f, fs[kShadowNoiseFrame], std::array<double, 1>{shadowNoiseFrame()});
        put(block, f, fs[kViewMipBias], std::array<double, 1>{viewMipBias()});
        put(block, f, fs[kHemisphereDirection], lights.hemisphereUp);  // world space: it meets normalWorld
        if (!program.selective) {
            put(block, f, fs[kHemisphereSky], lights.hemisphereSky);
            put(block, f, fs[kHemisphereGround], lights.hemisphereGround);
            put(block, f, fs[kAmbient], lights.ambient);
            return;
        }
        // A lightsNode program: only the ambient and hemisphere lights it lists (the slab starts zeroed).
        const auto& ids = program.lightSelection;
        const auto listed = [&](uint64_t id) { return std::find(ids.begin(), ids.end(), id) != ids.end(); };
        std::array<double, 3> ambient{0, 0, 0};
        for (const auto& [id, term] : lights.ambients)
            if (listed(id)) for (int c = 0; c < 3; ++c) ambient[c] += term[c];
        put(block, f, fs[kAmbient], ambient);
        if (lights.hemisphereId != 0 && listed(lights.hemisphereId)) {
            put(block, f, fs[kHemisphereSky], lights.hemisphereSky);
            put(block, f, fs[kHemisphereGround], lights.hemisphereGround);
        }
    };
    for (const auto& [depthKey, drawn] : opaque) {
        const DrawItem& item = *drawn;
        if (!item.mainPass) continue;
        shader::VertexVariant variant = variantOf(item);
        const std::string selective = selectiveLights(item);
        const uint64_t lightsKey = drawLightsKey(item, selective);
        DrawCache* cache = item.cache;
        Program* built = nullptr;
        if (cache && cache->program && cache->kind == item.kind && cache->lightsKey == lightsKey &&
            cache->variant == variant) {
            built = static_cast<Program*>(cache->program);
        } else {
            built = this->program(item.kind, variant,
                                  !selective.empty()               ? selective
                                  : item.kind == MaterialKind::Basic ? ""
                                  : item.receiveShadow            ? lightKinds
                                                                  : unshadowedKinds);
            if (!built) continue;
            if (cache) {
                cache->kind = item.kind; cache->variant = variant; cache->lightsKey = lightsKey;
                cache->program = built; cache->pipeline = nullptr; cache->targetKey = 0;
                cache->depthProgram = nullptr; cache->depthPipeline = nullptr;
            }
        }
        Program& program = *built;
        if (item.instanceCount == 0) continue;  // three draws nothing for count 0
        const bool lit = item.kind != MaterialKind::Basic;
        if (!item.positions || (lit && !item.normals && !item.flatShading) || !item.material) continue;
        const PipelineTarget target = colourTarget(item, program);
        if (compilation) {
            compilation->push_back(pipelines_->getAsync(program.vertex, &program.fragment, target));
            plan.push_back({&item, &program, nullptr, 0, 0});
            continue;
        }
        const uint64_t targetKey = drawTargetKey(item, program.vertex);
        WGPURenderPipeline pipeline;
        if (cache && cache->pipeline && cache->targetKey == targetKey) {
            pipeline = static_cast<WGPURenderPipeline>(cache->pipeline);
        } else {
            bool deferred = false;
            pipeline = deferUncompiled_ ? pipelines_->getOrDefer(program.vertex, &program.fragment, target, deferred)
                                        : pipelines_->get(program.vertex, &program.fragment, target);
            if (deferred) continue;  // drawn, with its post targets, the frame its pipeline lands
            if (!pipeline) throw std::runtime_error("TN_NATIVE_PIPELINE_REFUSED: material program");
            if (cache) { cache->targetKey = targetKey; cache->pipeline = pipeline; }
        }
        // A transparent draw records in the tail bundle, which re-records on change anyway: its blocks are appended, so the
        // slots of draws out of view (a batch and its unbatched members) do not grow every frame's upload.
        const uint64_t slotKey = features().stablePasses && item.key && !item.transparent
                                     ? item.key * 0x9e3779b97f4a7c15ull + slotUses_[item.key]++
                                     : 0;
        const uint64_t slotBytes = aligned(program.vertex.uniformBlockSize) + aligned(program.fragment.uniformBlockSize);
        if (program.frameSlabSerial != planSerial_) {  // once per program per frame, not once per draw
            program.frameSlab.assign(slotBytes, 0);
            putFrameConstants(program.frameSlab, 0, aligned(program.vertex.uniformBlockSize), program);
            program.frameSlabSerial = planSerial_;
        }
        const uint64_t v = uniformBlocks(slotKey, slotBytes, false);  // the copy below writes every byte
        const uint64_t f = v + aligned(program.vertex.uniformBlockSize);
        const auto* vs = program.vertexSlots;
        const auto* fs = program.fragmentSlots;
        std::memcpy(frameUniforms_.data() + v, program.frameSlab.data(), slotBytes);
        put(frameUniforms_, v, vs[kModelMatrix], item.matrixWorld);
        if (item.instanceMatrices) put(frameUniforms_, v, vs[kInstanceBase], std::array<double, 1>{instanceBases.at(&item)});
        put(frameUniforms_, v, vs[kNormalMatrix], normalMatrix(multiply(view, item.matrixWorld)));
        putSkin(v, vs, item);
        const shader::StandardMaterial& m = *item.material;
        put(frameUniforms_, f, fs[kDiffuse], std::array<double, 4>{m.color[0], m.color[1], m.color[2], m.opacity});
        put(frameUniforms_, f, fs[kModelMatrix], item.matrixWorld);
        // three's modelNormalMatrix (transformNormalToView), only for a program that reads it.
        const bool modelNormal = vs[kModelNormalMatrix] || fs[kModelNormalMatrix];
        const std::array<double, 9> modelNormalMatrix = modelNormal ? normalMatrix(item.matrixWorld) : std::array<double, 9>{};
        if (modelNormal) {
            put(frameUniforms_, v, vs[kModelNormalMatrix], modelNormalMatrix);
            put(frameUniforms_, f, fs[kModelNormalMatrix], modelNormalMatrix);
        }
        put(frameUniforms_, f, fs[kAlphaTest], std::array<double, 1>{m.alphaTest});
        // NodeMaterial forces alpha to 1 only on an opaque NormalBlending material.
        put(frameUniforms_, f, fs[kOpaque], std::array<double, 1>{!item.transparent && item.blending == 1 ? 1.0 : 0.0});
        put(frameUniforms_, f, fs[kRoughness], std::array<double, 1>{m.roughness});
        put(frameUniforms_, f, fs[kMetalness], std::array<double, 1>{m.metalness});
        put(frameUniforms_, f, fs[kEmissive],
            std::array<double, 3>{m.emissive[0] * m.emissiveIntensity, m.emissive[1] * m.emissiveIntensity,
                                  m.emissive[2] * m.emissiveIntensity});
        put(frameUniforms_, f, fs[kSpecular], std::array<double, 3>{m.specular[0], m.specular[1], m.specular[2]});
        put(frameUniforms_, f, fs[kShininess], std::array<double, 1>{m.shininess});
        put(frameUniforms_, f, fs[kIor], std::array<double, 1>{m.ior});
        put(frameUniforms_, f, fs[kSpecularIntensity], std::array<double, 1>{m.specularIntensity});
        put(frameUniforms_, f, fs[kSpecularColor], std::array<double, 3>{m.specularColor[0], m.specularColor[1], m.specularColor[2]});
        put(frameUniforms_, f, fs[kSubsurfaceColor], std::array<double, 3>{m.subsurfaceColor[0], m.subsurfaceColor[1], m.subsurfaceColor[2]});
        put(frameUniforms_, f, fs[kClearcoat], std::array<double, 1>{m.clearcoat});
        put(frameUniforms_, f, fs[kClearcoatRoughness], std::array<double, 1>{m.clearcoatRoughness});
        put(frameUniforms_, f, fs[kClearcoatNormalScale], std::array<double, 2>{m.clearcoatNormalScale[0], m.clearcoatNormalScale[1]});
        put(frameUniforms_, f, fs[kBumpScale], std::array<double, 1>{m.bumpScale});
        if (item.background) put(frameUniforms_, f, fs[kBackgroundRotation], item.backgroundRotation);
        if (item.fog) {
            const auto& fog = *item.fog;
            put(frameUniforms_, f, fs[kFogColor], std::array<double, 3>{fog.color.r, fog.color.g, fog.color.b});
            put(frameUniforms_, f, fs[kFogNear], std::array<double, 1>{fog.near});
            put(frameUniforms_, f, fs[kFogFar], std::array<double, 1>{fog.far});
            put(frameUniforms_, f, fs[kFogDensity], std::array<double, 1>{fog.density});
        }
        if (item.map) put(frameUniforms_, f, fs[kUvTransform], uvTransformOf(*item.map));
        for (int k = 0; k < shader::kPbrMapCount; ++k)
            if (item.pbrMaps[k]) put(frameUniforms_, f, fs[kRoughnessMapUvTransform + k], uvTransformOf(*item.pbrMaps[k]));
        if (item.pbrMaps[shader::kAoMap]) put(frameUniforms_, f, fs[kAoMapIntensity], std::array<double, 1>{item.aoMapIntensity});
        if (item.normalMap) {
            put(frameUniforms_, f, fs[kNormalScale], std::array<double, 2>{item.normalScaleX, item.normalScaleY});
            put(frameUniforms_, f, fs[kNormalUvTransform], uvTransformOf(*item.normalMap));
        }
        if (item.envMap) {
            const EnvironmentGpu& env = environment(*item.envMap);
            put(frameUniforms_, f, fs[kEnvRotation], item.envRotation);
            put(frameUniforms_, f, fs[kEnvMapMaxMip], std::array<double, 1>{double(env.maxLod)});
        }
        // three's materialEnvIntensity (MaterialProperties.js:23) is material.envMapIntensity when the material
        // carries an envMap, else scene.environmentIntensity, and a plain MaterialNode.envNode's radiance scales
        // by that same number. The program reads the factor only where it lowers an environment, and the render
        // database resolves the factor for every draw, so it is written whenever a program reads it: keyed on the
        // envMap alone, a material lit by envNode alone (the Strata ocean) read 0 and drew black.
        put(frameUniforms_, f, fs[kEnvMapIntensity], std::array<double, 1>{item.envMapIntensity});
        if (item.pmremMap) {
            const EnvironmentGpu& pmrem = environment(*item.pmremMap);
            put(frameUniforms_, f, fs[kPmremRotation], item.pmremRotation);
            put(frameUniforms_, f, fs[kPmremMaxMip], std::array<double, 1>{double(pmrem.maxLod)});
        }
        if (item.sprite) for (const auto& field : program.vertex.uniforms) {
            if (field.name == "spriteCenter") put(frameUniforms_, v, &field, item.spriteCenter);
            if (field.name == "spriteRotation") put(frameUniforms_, v, &field, std::array<double, 1>{item.spriteRotation});
            if (field.name == "spriteNoAttenuation") put(frameUniforms_, v, &field,
                std::array<double, 1>{!item.spriteSizeAttenuation && camera.projectionMatrix[11] == -1 ? 1.0 : 0.0});
        }
        putNodes(frameUniforms_, v, program.vertex, *item.nodes, frameTime_, frameDelta_, lights);
        putNodes(frameUniforms_, f, program.fragment, *item.nodes, frameTime_, frameDelta_, lights);
        plan.push_back({&item, &program, pipeline, static_cast<uint32_t>(v), static_cast<uint32_t>(f)});
        plan.back().slot = slotKey;
    }

    if (features().stablePasses && !compilation)
        for (auto slot = uniformSlots_.begin(); slot != uniformSlots_.end();) {
            if (slotFrame_ - slot->second.seen <= kSlotFrames) { ++slot; continue; }
            freeSlots_[slot->second.bytes].push_back(slot->second.offset);
            slot = uniformSlots_.erase(slot);
        }

    addCpuStage(CpuPlan, stageStarted);
    stageStarted = meterStart(cpuMetered_);
    // Each shadow-casting light's depth pass: every caster through the shadow camera, back faces for
    // front-sided materials (three's _shadowSide), depth only. Order is free: depth keeps the nearest.
    std::vector<ShadowPass>& shadowPasses = job.shadowPasses;
    for (std::size_t i = 0; i < lights.direct.size(); ++i) {
        if (!lights.direct[i].shadow) continue;
        const DirectLight::Shadow& shadow = *lights.direct[i].shadow;
        const auto virtualIt = virtualShadows_.find(i);
        const bool virtualMap = virtualIt != virtualShadows_.end();
        const int passCount = compilation ? 1 : virtualMap ? int(virtualPages[i].size()) : shadow.cube ? 6 : 1;
        const std::size_t firstPass = shadowPasses.size();
        const bool lampMap = lights.direct[i].kind != DirectLight::Kind::Directional && !virtualMap;
        const bool lamp = lampMap && !compilation;
        // Every page selects its casters from the same frozen draw list with the same read-only reducer, so the
        // pages are independent: each one collects its own list, and a light worth splitting hands the pages to
        // the pool. Only the selection moves — the programs, pipelines, LOD copies and uniform slices below stay
        // on the caller, in page and render-list order.
        //
        // FS9: that reducer is the same for every page of a level, so a granted level is indexed once — a caster's
        // bounds project to a range of that level's page cells (PageAtlas::pageRange) and it is appended to each of
        // them in draw-list order. A page then reads its own few casters instead of the whole list: on a granting
        // frame in the stress lab the scan judged 259 pages x 1316 casters and 0.47% of them became a draw.
        const auto mayCast = [&](const DrawItem* drawn) {
            if (!drawn->castShadow || drawn->instanceCount == 0 || !drawn->positions) return false;
            if ((drawn->layers & (shadow.layersMask | (virtualMap ? (1u << 29) | (1u << 28) : 0u))) == 0) return false;
            // A caster wholly beyond the lamp camera's far plane writes no depth: skip it, so it moving there
            // neither costs a draw nor invalidates the lamp's cached map (PRD-650).
            if (!lamp || shadow.far <= 0 || !drawn->shadowObject || drawn->positionNode || drawn->nodes->shadowPositionNode() ||
                drawn->boneMatrices || drawn->morphGeometry) return true;
            const Sphere* local = drawn->shadowObject->type() == "InstancedMesh"
                ? static_cast<const InstancedMesh*>(drawn->shadowObject)->boundingSphere.get()
                : drawn->shadowObject->type() == "Mesh" && static_cast<const Mesh*>(drawn->shadowObject)->geometry
                    ? static_cast<const Mesh*>(drawn->shadowObject)->geometry->boundingSphere.get() : nullptr;
            if (!local) return true;
            Sphere world = *local;
            Matrix4 model; model.elements = drawn->matrixWorld;
            world.applyMatrix4(model);
            const auto& at = lights.direct[i].position;
            return !(world.center.distanceTo(Vector3(at[0], at[1], at[2])) - world.radius > shadow.far);
        };
        // A caster whose bounds move with its node graph, its skin or its morph targets is on every page, as the
        // scan admitted it: there is no rectangle to index it by.
        // A positionNode caster is placed by its boxes grown by the material's maxPositionOffset (see virtualShadowBounds).
        const auto displaced = [](const DrawItem* const drawn) { return drawn->positionNode || drawn->nodes->shadowPositionNode(); };
        const auto bounded = [&](const DrawItem* const drawn) {
            return (!displaced(drawn) || (drawn->material && drawn->material->maxPositionOffset > 0) ||
                    displacedByGeometryBox(*drawn)) && !drawn->boneMatrices && !drawn->morphGeometry;
        };
        // FG1: an instanced caster's instances by page cell of one level, counting-sorted: cell c is reached by the
        // instances list[first[c] .. first[c + 1]), ascending.
        struct InstanceCells {
            std::vector<uint32_t> first, list;
        };
        struct LevelPages {
            int level = 0;
            std::vector<std::vector<const DrawItem*>> cell;  // tiles(level)^2 lists, each in draw-list order
            std::unordered_map<const DrawItem*, InstanceCells> instances;
        };
        const bool pageIndex = virtualMap && !compilation && passCount > 0 && !flatShadowSelection();
        // FS11: a draw's position in the frame's frozen list is its caster record. `opaque` holds pointers into the
        // same span (`sortDraws` pushes `&item`), so the subtraction is exact, not a lookup.
        const std::vector<CasterRecord>* const record = virtualMap ? &casterRecords_[i] : nullptr;
        const auto casterOf = [&](const DrawItem* drawn) -> const CasterRecord& {
            const std::size_t index = std::size_t(drawn - items.data());
            assert(record != nullptr && index < items.size() && drawn == &items[index]);
            return (*record)[index];
        };
        // FG1: Unreal culls a virtual shadow page's instances one by one (UE 5.8.3: Engine/Shaders/Private/
        // VirtualShadowMaps/VirtualShadowMapBuildPerPageDrawCommands.usf:206-215 reads each instance's own bounds, :307
        // turns them into a rect of pages, :350-352 adds the instance to every page of that rect; dispatched by
        // Engine/Source/Runtime/Renderer/Private/VirtualShadowMaps/VirtualShadowMapArray.cpp:3765 FCullPerPageDrawCommandsCs),
        // where one InstancedMesh row spans the union of its instances and so reached every page of a level. An
        // instanced caster with a box per instance is placed instance by instance: a page draws only the instances
        // whose own box can reach it. The same product of the same float32 values reaches the vertex stage, so the
        // depth a page writes is unchanged and only the instances its scissor clipped are gone.
        const bool cullInstances = virtualMap && shadowInstanceCullEnabled();
        const auto instanceBoxes = [&](const DrawItem* drawn) -> const std::vector<Box3>* {
            // An indirect caster's instances are the GPU's: its record already chose them.
            if (!cullInstances || !drawn->instanceMatrices || drawn->indirect || !bounded(drawn) || drawn->gpuJoints) return nullptr;
            return casterOf(drawn).instances;
        };
        // The cells a box reaches. A box with no finite extent (a NaN matrix) cannot be placed: it reaches every cell,
        // as the whole-caster row did.
        const auto instanceRange = [](const shadows::PageAtlas& atlas, int level, const Box3& box,
                                      int& x0, int& x1, int& y0, int& y1) {
            if (std::isfinite(box.min.x + box.min.y + box.min.z + box.max.x + box.max.y + box.max.z)) {
                atlas.pageRange(level, box, x0, x1, y0, y1);
            } else {
                x0 = y0 = 0;
                x1 = y1 = atlas.tiles(level) - 1;
            }
        };
        // Once per granted level: O(instances x cells an instance reaches), never instances x pages. The caster joins
        // the cells some instance reaches, in draw-list order like any other.
        const auto indexInstances = [&](LevelPages& level, const shadows::PageAtlas& atlas, const DrawItem* drawn,
                                        const std::vector<Box3>& boxes) {
            const std::size_t side = std::size_t(atlas.tiles(level.level));
            InstanceCells& cells = level.instances[drawn];
            cells.first.assign(side * side + 1, 0);
            std::vector<std::array<int, 4>> reach(boxes.size());
            for (std::size_t j = 0; j < boxes.size(); ++j) {
                auto& [x0, x1, y0, y1] = reach[j];
                instanceRange(atlas, level.level, boxes[j], x0, x1, y0, y1);
                for (int y = y0; y <= y1; ++y)
                    for (int x = x0; x <= x1; ++x) ++cells.first[std::size_t(y) * side + std::size_t(x) + 1];
            }
            for (std::size_t c = 0; c < side * side; ++c) cells.first[c + 1] += cells.first[c];
            cells.list.resize(cells.first.back());
            std::vector<uint32_t> next(cells.first.begin(), cells.first.end() - 1);
            for (std::size_t j = 0; j < boxes.size(); ++j) {
                const auto& [x0, x1, y0, y1] = reach[j];
                for (int y = y0; y <= y1; ++y)
                    for (int x = x0; x <= x1; ++x) cells.list[next[std::size_t(y) * side + std::size_t(x)]++] = uint32_t(j);
            }
            for (std::size_t c = 0; c < side * side; ++c)
                if (cells.first[c + 1] > cells.first[c]) level.cell[c].push_back(drawn);
        };
        std::vector<LevelPages> levelPages;
        std::vector<const DrawItem*> moverCasters;
        std::map<int, std::size_t> levelSlot;
        if (pageIndex) {
            const auto& atlas = virtualIt->second.atlas;
            bool anyMover = false;
            for (const shadows::AtlasPage& page : virtualPages[i]) {
                if (page.mover) { anyMover = true; continue; }
                if (!levelSlot.emplace(page.level, levelPages.size()).second) continue;
                const std::size_t side = std::size_t(atlas.tiles(page.level));
                LevelPages& added = levelPages.emplace_back();
                added.level = page.level;
                added.cell.resize(side * side);
            }
            // A mover page draws every moving caster wherever it is (the scan tests no bounds for it), and a caster
            // settling between moving and still is on the static pages and the mover page at once.
            if (anyMover)
                for (const auto& [depthKey, drawn] : opaque)
                    if (mayCast(drawn) && atlas.isMover(drawn->key)) moverCasters.push_back(drawn);
            for (LevelPages& level : levelPages) {
                const std::size_t side = std::size_t(atlas.tiles(level.level));
                const double gate = atlas.casterGate(level.level);
                for (const auto& [depthKey, drawn] : opaque) {
                    if (!mayCast(drawn) || !atlas.drawsStatic(drawn->key)) continue;
                    // The gate the scan applied to a caster with fixed bounds, and then the bounds themselves: a
                    // GPU-displaced one has none to index by, so it stays on every page.
                    if (bounded(drawn)) {
                        if (casterOf(drawn).diameter < gate) continue;
                        if (drawn->gpuJoints) {
                            for (auto& cell : level.cell) cell.push_back(drawn);
                            continue;
                        }
                        if (const std::vector<Box3>* boxes = instanceBoxes(drawn)) {
                            indexInstances(level, atlas, drawn, *boxes);
                            continue;
                        }
                        int x0, x1, y0, y1;
                        atlas.pageRange(level.level, casterOf(drawn).bounds, x0, x1, y0, y1);
                        for (int y = y0; y <= y1; ++y)
                            for (int x = x0; x <= x1; ++x)
                                level.cell[std::size_t(y) * side + std::size_t(x)].push_back(drawn);
                        continue;
                    }
                    // An instanced caster the engine cannot place draws all its instances on every page: say which, once.
                    if (displaced(drawn) && drawn->instanceMatrices && !drawn->boneMatrices && !drawn->morphGeometry && !drawn->gpuJoints &&
                        unboundedNoted_.insert(drawn->key).second) {
                        const std::string note = "TN_SHADOW_UNBOUNDED_CASTER: " + std::to_string(drawn->instanceCount) +
                            " instances of a positionNode caster" + (drawn->shadowObject && !drawn->shadowObject->name.empty() ? " '" + drawn->shadowObject->name + "'" : std::string()) +
                            " draw on every virtual shadow page; set its material's maxPositionOffset to the farthest the positionNode moves a vertex, in metres";
                        diagnostics_.push_back(note);
                    }
                    for (auto& cell : level.cell) cell.push_back(drawn);
                }
            }
        }
        std::vector<std::vector<const DrawItem*>> selectedCasters(static_cast<std::size_t>(passCount));
        std::vector<std::exception_ptr> failedFace(selectedCasters.size());
        // Every mover page of a light draws the same moving casters wherever they are: only its camera differs, and
        // that is a per-pass uniform. The first plans the rows, and the others draw them: their instance and skin
        // floats would be the same bytes, once per level, every frame.
        int firstMoverFace = passCount;
        if (virtualMap && !compilation)
            for (int face = passCount - 1; face >= 0 && virtualPages[i][std::size_t(face)].mover; --face) firstMoverFace = face;
        std::size_t firstMoverPass = 0;
        const auto selectFace = [&](std::size_t face) {
            if (int(face) > firstMoverFace) return;
            try {
                const shadows::AtlasPage* page = virtualMap && !compilation ? &virtualPages[i][face] : nullptr;
                std::vector<const DrawItem*>& selected = selectedCasters[face];
                const std::vector<const DrawItem*>* candidates = nullptr;
                if (pageIndex) {
                    const auto& atlas = virtualIt->second.atlas;
                    candidates = page->mover ? &moverCasters
                        : &levelPages[levelSlot.at(page->level)].cell[std::size_t(page->y) * std::size_t(atlas.tiles(page->level)) + std::size_t(page->x)];
                    // The index is conservative, so the bounds test still decides — as it did for every caster of
                    // the flat scan — and a caster on a page's edge is on every cell it reaches.
                    for (const DrawItem* drawn : *candidates) {
                        if (!page->mover && bounded(drawn) && !drawn->gpuJoints &&
                            !atlas.overlaps(*page, casterOf(drawn).bounds)) continue;
                        selected.push_back(drawn);
                    }
                } else {
                    const auto& atlas = virtualIt->second.atlas;
                    for (const auto& [depthKey, drawn] : opaque) {
                        if (!mayCast(drawn)) continue;
                        if (page) {
                            if (page->mover ? !atlas.isMover(drawn->key) : !atlas.drawsStatic(drawn->key)) continue;
                            if (!page->mover && bounded(drawn) &&
                                casterOf(drawn).diameter < atlas.casterGate(page->level)) continue;
                            if (!page->mover && bounded(drawn) && !drawn->gpuJoints &&
                                !atlas.overlaps(*page, casterOf(drawn).bounds)) continue;
                        }
                        selected.push_back(drawn);
                    }
                }
                waste::debugAdd(waste::counters().shadowPageSelectionProbes,
                                candidates ? candidates->size() : opaque.size());
            } catch (...) {
                failedFace[face] = std::current_exception();  // rethrown on the caller, in page order
            }
        };
        // The gate is a proposed one, not a measured crossover: a whole light's page x caster pairs below it
        // cost less than a dispatch. The pool starts here, on the caller, never inside a job.
        const bool split = !compilation && passCount >= 2 && !JobPool::inJob() &&
            uint64_t(passCount) * opaque.size() >= kShadowPageJobPairs;
        JobPool* pool = split && JobPool::shared().workers() > 0 ? &JobPool::shared() : nullptr;
        if (pool) pool->forEach(uint32_t(selectedCasters.size()), [&](uint32_t face) { selectFace(face); });
        else for (std::size_t face = 0; face < selectedCasters.size(); ++face) selectFace(face);
        for (const std::exception_ptr& failure : failedFace) if (failure) std::rethrow_exception(failure);
        for (int face = 0; face < passCount; ++face) {
        const shadows::AtlasPage* page = virtualMap && !compilation ? &virtualPages[i][face] : nullptr;
        const Matrix& view = page ? page->view.elements : shadow.cube ? shadow.faceViews[face] : shadow.view;
        ShadowPass& pass = shadowPasses.emplace_back();
        pass.lamp = lamp; pass.virtualLight = i;
        pass.view = view;
        pass.projection = page ? page->projection.elements : shadow.projection;
        pass.target = compilation ? nullptr : virtualMap ? virtualIt->second.map.view : shadow.cube ? cubeShadowMaps_[i].faces[face] : shadowMaps_[i].view;
        if (page) {
            const auto& atlas = virtualIt->second.atlas;
            const auto [x, y] = page->mover ? atlas.moverOrigin(page->level) : atlas.origin(page->slot);
            pass.x = x; pass.y = y; pass.size = page->mover ? atlas.options().moverMapSize + 2 * atlas.options().border : atlas.stride();
            pass.mover = page->mover;
            if (!page->mover) { pass.virtualLight = i; pass.virtualLevel = page->level; }
        }
        if (face == firstMoverFace) firstMoverPass = shadowPasses.size() - 1;
        if (face > firstMoverFace) {
            pass.draws = shadowPasses[firstMoverPass].draws;
            continue;
        }
        // The error a coarser rung may have on this page: its texels in world units, along the window's
        // wider axis (see PageAtlas::update), times the budget the node allows.
        const double lodBudget = page && !page->mover
            ? (page->highU - page->lowU) / double(virtualIt->second.atlas.options().pageTexels + 2 * virtualIt->second.atlas.options().border) *
                  virtualIt->second.atlas.options().shadowLodTexels : 0;
        // FM8: the page's casters as this loop resolves them, before they become rows.
        struct PageCaster {
            const DrawItem* item = nullptr;
            Program* program = nullptr;
            WGPURenderPipeline pipeline = nullptr;
            double instanceBase = 0;
        };
        std::vector<PageCaster> pageCasters;
        pageCasters.reserve(selectedCasters[std::size_t(face)].size());
        std::vector<uint32_t> flatInstances;  // FG1: the flat scan's instances of one caster on this page
        for (const DrawItem* drawn : selectedCasters[std::size_t(face)]) {
            const DrawItem* selected = drawn;
            // FG1: an instanced caster draws, on a static page, only the instances that can reach it: the page's cell
            // of the level index, or - in the diagnostic flat scan, which keeps no index - the same range test run
            // over every instance. A caster none of whose instances reaches the page has no row.
            std::span<const uint32_t> pageInstances;
            bool trimmed = false;  // pageInstances names this caster's instances on the page
            if (page && !page->mover && instanceBoxes(drawn) != nullptr) {
                const auto& atlas = virtualIt->second.atlas;
                if (pageIndex) {
                    const LevelPages& level = levelPages[levelSlot.at(page->level)];
                    const auto cells = level.instances.find(drawn);
                    if (cells != level.instances.end()) {
                        const std::size_t cell = std::size_t(page->y) * std::size_t(atlas.tiles(page->level)) + std::size_t(page->x);
                        pageInstances = std::span<const uint32_t>(cells->second.list).subspan(
                            cells->second.first[cell], cells->second.first[cell + 1] - cells->second.first[cell]);
                        trimmed = true;
                    }
                } else {
                    flatInstances.clear();
                    const std::vector<Box3>& boxes = *instanceBoxes(drawn);
                    for (std::size_t j = 0; j < boxes.size(); ++j) {
                        int x0, x1, y0, y1;
                        instanceRange(atlas, page->level, boxes[j], x0, x1, y0, y1);
                        if (page->x >= x0 && page->x <= x1 && page->y >= y0 && page->y <= y1) flatInstances.push_back(uint32_t(j));
                    }
                    pageInstances = flatInstances;
                    trimmed = true;
                }
                if (trimmed && pageInstances.empty()) continue;
            }
            if (page && !page->mover && page->level > 0 && virtualIt->second.atlas.options().shadowLodBias && drawn->shadowObject) {
                const auto& lods = virtualIt->second.atlas.options().control->lods;
                const auto lod = lods.find(drawn->shadowObject->id());
                if (lod != lods.end()) {
                    // The coarsest rung whose error this page's budget allows, and never finer
                    // than the rung the main pass draws (its index buffer is one of the chain's).
                    const auto& chain = lod->second;
                    int shown = 0;
                    for (std::size_t r = 0; r < chain.rungs.size(); ++r)
                        if (chain.rungs[r]->index && chain.rungs[r]->index->store.get() == drawn->indices) shown = int(r) + 1;
                    Matrix4 model; model.elements = drawn->matrixWorld;
                    const int rung = shadows::shadowLodRung(chain.errors, shown, lodBudget, model.getMaxScaleOnAxis());
                    if (rung > 0 && std::size_t(rung) <= chain.rungs.size() && chain.rungs[std::size_t(rung - 1)]->index) {
                        auto& copy = job.shadowLodItems.emplace_back(*drawn);
                        copy.indices = chain.rungs[std::size_t(rung - 1)]->index->store.get();
                        copy.cache = nullptr;
                        selected = &copy;
                    }
                }
            }
            const DrawItem& item = *selected;
            DrawCache* cache = item.cache;
            Program* cachedDepth = nullptr;
            bool masked = false, alphaHash = false;
            const DepthRowKey rowKey = depthRowKey(item);
            if (cache && cache->depthProgram && item.variantStamp != 0 && cache->depthStamp == item.variantStamp &&
                cache->depthKey == rowKey) {
                // Nothing the variant reads has moved since this draw last resolved it: no variant to build.
                cachedDepth = static_cast<Program*>(cache->depthProgram);
                masked = cache->depthMasked;
                alphaHash = cache->variant.alphaHash;
            } else {
                shader::VertexVariant variant = variantOf(item);
                // shortcut: shadow coverage reads opacity/map; lower node and vertex alpha before admitting those casters.
                if (variant.alphaHash && (item.nodes->colorNode || item.nodes->opacityNode || variant.vertexColors == 4))
                    throw std::runtime_error("TN_NATIVE_SHADOW_ALPHA_UNSUPPORTED: alphaHash shadow supports material opacity and diffuse-map alpha only");
                masked = shadowMasked(*item.material, *item.nodes);
                alphaHash = variant.alphaHash;
                if (cache && cache->depthProgram && cache->variant == variant && cache->depthMasked == masked)
                    cachedDepth = static_cast<Program*>(cache->depthProgram);
                else {
                    cachedDepth = &depthProgram(variant, masked);
                    if (cache) {
                        cache->variant = variant;  // a shadow-only draw has no main program to set it
                        cache->depthProgram = cachedDepth; cache->depthPipeline = nullptr; cache->depthTargetKey = 0;
                        cache->depthMasked = masked;
                    }
                }
                if (cache) { cache->depthStamp = item.variantStamp; cache->depthKey = rowKey; }
            }
            const shader::StageModule* depthFragment = (masked || alphaHash) ? &cachedDepth->fragment : nullptr;
            Program& program = *cachedDepth;
            // material.shadowSide names the faces drawn; when null, three's _shadowSide: a front-sided
            // caster draws its back faces, a back-sided one its front faces, a double-sided one both.
            // A virtual page draws the front faces of a front-sided caster too, as Unreal's sun does:
            // the back face of a wall box is the room's own inner surface, and its depth leaks the sun
            // along every seam.
            const uint8_t derived = item.side == 2 ? 2 : item.side == 1 || virtualMap ? 0 : 1;
            const uint8_t faces = item.shadowSide != 255 ? item.shadowSide : derived;
            const WGPUCullMode cull =
                faces == 2 ? WGPUCullMode_None : faces == 0 ? WGPUCullMode_Back : WGPUCullMode_Front;
            PipelineTarget target{WGPUTextureFormat_Undefined, WGPUTextureFormat_Depth24Plus, cull};
            target.layout = program.pipelineLayout;
            target.frontFace = item.frontFace();
            target.skinIndex = skinIndexFormat(item);
            target.instanceStepMask = instanceStepMask(program.vertex, item);
            const bool lampBackFace = lampMap && faces == 1;  // a front-face or double-sided map holds the receiver's own surface: no bias
            if (lampBackFace) target.depthBias = -kLampBackFaceBias;
            if (compilation) {
                compilation->push_back(pipelines_->getAsync(program.vertex, depthFragment, target));
                continue;
            }
            const uint64_t depthTargetKey = drawTargetKey(item, program.vertex) * 6 + (faces == 2 ? 0 : faces == 0 ? 1 : 2) + (lampBackFace ? 3 : 0);  // a virtual page and a lamp cull one caster differently
            WGPURenderPipeline pipeline;
            if (cache && cache->depthPipeline && cache->depthTargetKey == depthTargetKey) {
                pipeline = static_cast<WGPURenderPipeline>(cache->depthPipeline);
            } else {
                pipeline = pipelines_->get(program.vertex, depthFragment, target);
                if (!pipeline) throw std::runtime_error("TN_NATIVE_PIPELINE_REFUSED: shadow depth program");
                if (cache) { cache->depthTargetKey = depthTargetKey; cache->depthPipeline = pipeline; }
            }
            // packed below, after the lamp cache decides which passes run
            const DrawItem* rowItem = &item;
            double rowBase = item.instanceMatrices ? instanceBases.at(drawn) : 0.0;
            if (trimmed && pageInstances.size() < item.instanceCount) {
                // FG1: the page's instances as a compacted copy of their 20 floats each at the end of the frame's
                // instance storage (as FM8's grouped rows put theirs), drawn by a row of that many instances. The
                // matrix, the colour and the item's own world matrix are the bytes the whole-caster row read.
                DrawItem& cut = job.shadowGroupItems.emplace_back(item);
                cut.instanceCount = uint32_t(pageInstances.size());
                const std::size_t from = std::size_t(rowBase) * 4, at = instances.size();
                rowBase = double(at / 4);
                instances.resize(at + pageInstances.size() * 20);
                for (std::size_t n = 0; n < pageInstances.size(); ++n)
                    std::memcpy(&instances[at + n * 20], &instances[from + std::size_t(pageInstances[n]) * 20], 20 * sizeof(float));
                rowItem = &cut;
            }
            if (page && !page->mover) {
                waste::debugAdd(waste::counters().shadowPageRows);
                waste::debugAdd(waste::counters().shadowPageInstances, rowItem->instanceMatrices ? rowItem->instanceCount : 0);
            }
            pageCasters.push_back({rowItem, &program, pipeline, rowBase});
        }
        // FM8: a page drew one row per caster, so a crowd's 240 casters cost 720 rows under a three-level sun.
        // The casters this page selected that share a depth program, a material and their vertex buffers draw
        // as one instanced row. The members are exactly this page's selection — never a superset, because a
        // caster whose bounds miss the page's window must not write depth into it. A page that selects one
        // caster, or a caster a row cannot reproduce (a morph target, a node-graph position, a GPU-deformed
        // rig, a mirrored winding, an already instanced draw), keeps the plain row it had: no work is added.
        struct CasterGroup {
            Program* program = nullptr;
            WGPURenderPipeline pipeline = nullptr;
            const void* positions = nullptr; const void* indices = nullptr; const void* uvs = nullptr;
            const void* normals = nullptr; const void* colors = nullptr;
            const void* skinIndices = nullptr; const void* skinWeights = nullptr;
            const std::vector<DrawItem::CustomAttribute>* attributes = nullptr;
            // What a depth stage reads of the material: a masked or hashed caster's cut, its opacity and its
            // map's transform. The record copies the material, so two casters' pointers never match.
            const void* map = nullptr;
            float alphaTest = 0, opacity = 1, color[3] = {1, 1, 1};
            uint8_t side = 0, shadowSide = 255;
            bool skinned = false;
            std::vector<const DrawItem*> members;
        };
        // The other attributes a program reads are the record's, one list per object: equal contents mean the
        // same vertex sources (a caster with its own TSL attribute keeps its own row).
        const auto sameAttributes = [](const std::vector<DrawItem::CustomAttribute>& a,
                                       const std::vector<DrawItem::CustomAttribute>& b) {
            if (a.size() != b.size()) return false;
            for (std::size_t i = 0; i < a.size(); ++i)
                if (a[i].name != b[i].name || a[i].store != b[i].store || a[i].perInstance != b[i].perInstance)
                    return false;
            return true;
        };
        constexpr std::size_t kNoGroup = std::size_t(-1);
        std::vector<CasterGroup> groups;
        std::vector<std::size_t> groupOf(pageCasters.size(), kNoGroup);
        if (page != nullptr && pageCasters.size() > 1 && shadowGroupsEnabled()) {
            // ponytail: a page with more groups than this is not a crowd, and the search below is linear in
            // them; past the bound every caster keeps its own row (no regression, bounded work).
            constexpr std::size_t kMaxGroupsPerPage = 64;
            const auto reproducible = [&](const PageCaster& caster) {
                const DrawItem& item = *caster.item;
                if (item.morphGeometry || item.morphInfluences || item.positionNode) return false;
                if (item.nodes->shadowPositionNode() || item.nodes->vertexNode) return false;
                if (item.instanceMatrices || item.gpuJoints || item.sprite || item.background) return false;
                if (item.nodeTextures || item.nodeStorages || item.reflectors) return false;
                if (item.boneStride || item.positions == nullptr) return false;
                if (item.boneMatrices && (item.skinnedRig == nullptr || item.skinnedRig->skeleton == nullptr ||
                                          item.skinnedRig->skeleton->bones.empty())) return false;
                // A rig with no palette this frame (an AutoLOD rung's copy) keeps its own row.
                if (item.boneMatrices && deforms.find(&item) == deforms.end()) return false;
                // A mirrored caster's front face is its own row's pipeline state, not its instance's.
                return item.frontFace() == WGPUFrontFace_CCW;
            };
            for (std::size_t c = 0; c < pageCasters.size(); ++c) {
                const PageCaster& caster = pageCasters[c];
                if (groups.size() >= kMaxGroupsPerPage || !reproducible(caster)) continue;
                const DrawItem& item = *caster.item;
                std::size_t at = kNoGroup;
                for (std::size_t g = 0; g < groups.size() && at == kNoGroup; ++g) {
                    const CasterGroup& group = groups[g];
                    if (group.program == caster.program && group.pipeline == caster.pipeline &&
                        group.positions == item.positions && group.indices == item.indices && group.uvs == item.uvs &&
                        group.normals == item.normals && group.colors == item.colors &&
                        group.skinIndices == item.skinIndices && group.skinWeights == item.skinWeights &&
                        sameAttributes(*group.attributes, *item.attributes) && group.map == item.map &&
                        group.alphaTest == item.material->alphaTest && group.opacity == item.material->opacity &&
                        group.color[0] == item.material->color[0] && group.color[1] == item.material->color[1] &&
                        group.color[2] == item.material->color[2] && group.side == item.side &&
                        group.shadowSide == item.shadowSide && group.skinned == (item.boneMatrices != nullptr)) at = g;
                }
                if (at == kNoGroup) {
                    at = groups.size();
                    CasterGroup group;
                    group.program = caster.program; group.pipeline = caster.pipeline;
                    group.positions = item.positions; group.indices = item.indices; group.uvs = item.uvs;
                    group.normals = item.normals; group.colors = item.colors;
                    group.skinIndices = item.skinIndices; group.skinWeights = item.skinWeights;
                    group.attributes = item.attributes; group.map = item.map;
                    group.alphaTest = item.material->alphaTest; group.opacity = item.material->opacity;
                    for (int k = 0; k < 3; ++k) group.color[k] = item.material->color[k];
                    group.side = item.side; group.shadowSide = item.shadowSide;
                    group.skinned = item.boneMatrices != nullptr;
                    groups.push_back(std::move(group));
                }
                groups[at].members.push_back(caster.item);
                groupOf[c] = at;
            }
            // A group of one adds a row and saves none.
            for (std::size_t c = 0; c < pageCasters.size(); ++c)
                if (groupOf[c] != kNoGroup && groups[groupOf[c]].members.size() < 2) groupOf[c] = kNoGroup;
        }
        std::vector<bool> emitted(groups.size(), false);
        for (std::size_t c = 0; c < pageCasters.size(); ++c) {
            const PageCaster& caster = pageCasters[c];
            if (groupOf[c] == kNoGroup) {
                pass.draws.push_back({caster.item, caster.program, caster.pipeline, 0, 0, caster.instanceBase});
                continue;
            }
            const std::size_t at = groupOf[c];
            if (emitted[at]) continue;
            emitted[at] = true;
            // One instanced row draws the group: the members' placements in the frame's `instances` storage,
            // and, for a skinned group, each member's own palette base and bind pair in `shadowSkin`. The
            // frame's bone palette holds one copy per rig, so every page that draws that rig reads it rather
            // than writing it again.
            std::vector<const DrawItem*>& recorded = job.shadowGroups.emplace_back(groups[at].members);
            DrawItem& row = job.shadowGroupItems.emplace_back(*recorded.front());
            ++job.shadowGroupRows;
            row.matrixWorld = Matrix4{}.elements;
            row.shadowGroup = true;
            row.instanceColors = nullptr;
            row.instanceCount = uint32_t(recorded.size());
            row.instanceMatrices = &shadowGroupInstances();
            row.bindMatrix = row.bindMatrixInverse = Matrix4{}.elements;
            row.boneStride = 0;
            const double instanceBase = double(instances.size() / 4);  // the storage indexes in vec4s
            if (row.boneMatrices) {
                std::vector<float>& skin = storages_["shadowSkin"].data;
                const double skinBase = double(skin.size() / 4);
                for (const DrawItem* member : recorded) {
                    const auto deform = deforms.find(member);
                    if (deform == deforms.end())
                        throw std::runtime_error("TN_SHADOW_GROUP_PALETTE: a grouped caster has no palette this frame");
                    skin.insert(skin.end(), {float(deform->second.boneBase), 0.0f, 0.0f, 0.0f});
                    for (double e : member->bindMatrix) skin.push_back(float(e));
                    for (double e : member->bindMatrixInverse) skin.push_back(float(e));
                }
                deforms[&row].boneBase = skinBase;
            }
            for (const DrawItem* member : recorded) {
                for (double e : member->matrixWorld) instances.push_back(float(e));
                instances.insert(instances.end(), {1.0f, 1.0f, 1.0f, 0.0f});  // no instance colour: a depth pass reads none
            }
            const bool masked = shadowMasked(*row.material, *row.nodes);
            const shader::VertexVariant variant = variantOf(row);
            Program& program = depthProgram(variant, masked);
            const shader::StageModule* depthFragment = (masked || variant.alphaHash) ? &program.fragment : nullptr;
            const uint8_t derivedFaces = row.side == 2 ? 2 : row.side == 1 || virtualMap ? 0 : 1;
            const uint8_t faces = row.shadowSide != 255 ? row.shadowSide : derivedFaces;
            const WGPUCullMode cull =
                faces == 2 ? WGPUCullMode_None : faces == 0 ? WGPUCullMode_Back : WGPUCullMode_Front;
            PipelineTarget target{WGPUTextureFormat_Undefined, WGPUTextureFormat_Depth24Plus, cull};
            target.layout = program.pipelineLayout;
            target.frontFace = row.frontFace();
            target.skinIndex = skinIndexFormat(row);
            target.instanceStepMask = instanceStepMask(program.vertex, row);
            if (lampMap && faces == 1) target.depthBias = -kLampBackFaceBias;
            WGPURenderPipeline pipeline = pipelines_->get(program.vertex, depthFragment, target);
            if (!pipeline) throw std::runtime_error("TN_NATIVE_PIPELINE_REFUSED: shadow depth program");
            Planned& planned = pass.draws.emplace_back(Planned{&row, &program, pipeline, 0, 0, instanceBase});
            planned.members = recorded.data();
            planned.memberCount = uint32_t(recorded.size());
        }
        }
        // PRD-650: a lamp keeps last frame's map while nothing it draws changed: its cameras, its map
        // and each caster's matrix, geometry and cut. A GPU-deformed caster changes every frame. An
        // ordinary sun map keeps it too, as Unreal's cached whole-scene shadows do: valid while the
        // light's projection holds (UE 5.8.3: Engine/Source/Runtime/Engine/Public/SceneManagement.h:1011-1022,
        // Engine/Source/Runtime/Renderer/Private/ShadowSetup.cpp:3867-3882), dropped when a caster changes
        // (Engine/Source/Runtime/Renderer/Private/SceneCore.cpp:369-385). A virtual map caches its own pages.
        if (!virtualMap && !compilation) {
            uint64_t h = 0xcbf29ce484222325ull;
            // Each word goes through murmur3's finalizer first: FNV over whole words carries a sign or exponent bit only
            // upward, so two sign flips (a light or caster moved to its mirror image) cancelled and the stale map was kept.
            const auto mix = [&h](uint64_t v) {
                v ^= v >> 33; v *= 0xff51afd7ed558ccdull; v ^= v >> 33; v *= 0xc4ceb9fe1a85ec53ull; v ^= v >> 33;
                h = (h ^ v) * 0x100000001b3ull;
            };
            const auto mixMatrix = [&](const Matrix& m) { for (double e : m) mix(std::bit_cast<uint64_t>(e)); };
            const auto mixStore = [&](const BufferStore* b) { mix(reinterpret_cast<uintptr_t>(b)); if (b) { mix(b->version()); mix(b->epoch()); } };  // three uploads on needsUpdate, not on a write
            bool animated = false;
            mixMatrix(shadow.projection);
            if (shadow.cube) for (const Matrix& m : shadow.faceViews) mixMatrix(m); else mixMatrix(shadow.view);
            mix(mapExtent(i)[0]); mix(mapExtent(i)[1]);
            for (std::size_t k = firstPass; k < shadowPasses.size(); ++k) {
                mix(reinterpret_cast<uintptr_t>(shadowPasses[k].target));
                for (const Planned& p : shadowPasses[k].draws) {
                    const DrawItem& item = *p.item;
                    animated |= item.positionNode || item.nodes->shadowPositionNode() || item.boneMatrices || item.morphGeometry || item.gpuJoints;
                    mix(item.key); mixMatrix(item.matrixWorld); mix(item.instanceCount);
                    mixStore(item.positions); mixStore(item.indices); mixStore(item.instanceMatrices); mixStore(item.uvs);
                    mix(reinterpret_cast<uintptr_t>(p.pipeline)); mix(reinterpret_cast<uintptr_t>(item.map)); mix(item.map ? item.map->version() : 0);
                    mix(std::bit_cast<uint32_t>(item.material->alphaTest)); mix(std::bit_cast<uint32_t>(item.material->opacity));
                    // A cutoff that samples the node's own textures casts what they hold (PRD-858).
                    if (item.nodeTextures)
                        for (const auto& [label, texture] : *item.nodeTextures) {
                            mix(reinterpret_cast<uintptr_t>(texture)); mix(texture ? texture->version() : 0);
                        }
                }
            }
            uint64_t& last = mapSignatures_[i];
            if (!animated && last == h) {
                shadowPasses.erase(shadowPasses.begin() + std::ptrdiff_t(firstPass), shadowPasses.end());
                ++job.keptShadowMaps;
                continue;  // a cache hit packs and uploads nothing for this map
            }
            last = animated ? 0 : h;
        }
        // Pack only the passes that run: a kept map's casters never allocate, fill or upload a slice.
        for (std::size_t k = firstPass; k < shadowPasses.size(); ++k) {
            ShadowPass& kept = shadowPasses[k];
            // r185 draws a caster through the shadow camera, so TSL's camera accessors (a billboard's
            // positionNode) read that camera here: its world matrix is the view's inverse.
            Matrix4 shadowCamera;
            shadowCamera.elements = kept.view;
            shadowCamera.invert();
            const std::array<double, 3> shadowPosition{shadowCamera.elements[12], shadowCamera.elements[13], shadowCamera.elements[14]};
            for (Planned& planned : kept.draws) {
                const DrawItem& item = *planned.item;
                Program& program = *planned.program;
                const bool masked = shadowMasked(*item.material, *item.nodes);
                const bool fragmentBlock = masked || variantOf(item).alphaHash;
                const uint64_t v = frameUniforms_.size();
                const uint64_t f = v + aligned(program.vertex.uniformBlockSize);
                frameUniforms_.resize(f + aligned(program.fragment.uniformBlockSize), 0);
                if (fragmentBlock) {
                    const shader::StandardMaterial& m = *item.material;
                    const auto* fs = program.fragmentSlots;
                    put(frameUniforms_, f, fs[kDiffuse], std::array<double, 4>{m.color[0], m.color[1], m.color[2], m.opacity});
                    put(frameUniforms_, f, fs[kAlphaTest], std::array<double, 1>{m.alphaTest});
                    put(frameUniforms_, f, fs[kOpaque], std::array<double, 1>{0.0});
                    if (item.map) put(frameUniforms_, f, fs[kUvTransform], uvTransformOf(*item.map));
                    putNodes(frameUniforms_, f, program.fragment, *item.nodes, frameTime_, frameDelta_, lights);  // alphaTestNode's uniforms
                }
                put(frameUniforms_, v, program.vertexSlots[kModelMatrix], item.matrixWorld);
                if (item.instanceMatrices) put(frameUniforms_, v, program.vertexSlots[kInstanceBase], std::array<double, 1>{planned.instanceBase});
                put(frameUniforms_, v, program.vertexSlots[kViewMatrix], kept.view);
                put(frameUniforms_, v, program.vertexSlots[kProjectionMatrix], kept.projection);
                put(frameUniforms_, v, program.vertexSlots[kCameraWorldMatrix], shadowCamera.elements);
                put(frameUniforms_, v, program.vertexSlots[kCameraPosition], shadowPosition);
                put(frameUniforms_, v, program.vertexSlots[kCameraProjectionMatrix], kept.projection);
                putSkin(v, program.vertexSlots, item);
                putNodes(frameUniforms_, v, program.vertex, *item.nodes, frameTime_, frameDelta_, lights);
                planned.vertexOffset = static_cast<uint32_t>(v);
                planned.fragmentOffset = static_cast<uint32_t>(fragmentBlock ? f : 0);
            }
        }
    }

    addCpuStage(CpuShadowBuild, stageStarted);
    // One buffer for the frame's uniforms, grown (and its bind groups rebuilt) when it is too small,
    // written once: a queue write, so it lands before this frame's commands and after the last's.
    // Transparent draws replayed into the motion target, appended once their bind groups are chosen.
    std::vector<std::pair<size_t, WGPURenderPipeline>> responsiveDraws;
    if (traa_) {
        for (const Planned& draw : plan) {
            if (!compilation) waste::debugAdd(waste::counters().velocityCandidates);
            const DrawItem& item = *draw.item;
            const auto& variant = draw.program->variant;
            // Alpha-tested and alpha-hashed draws need no coverage test here: the equal depth test keeps only the
            // fragments the main pass kept (UE 5.8.3 writes velocity for masked materials).
            const bool unsupported = item.morphGeometry || item.sprite || item.background ||
                item.positionNode || item.nodes->vertexNode || item.transparent;
            const auto skip = [&](const char* reason) {
                if (!compilation) waste::debugAdd(waste::counters().velocitySkipped);
                const std::string note = std::string("TN_TRAA_VELOCITY_SKIPPED: ") + reason +
                    "; camera motion only";
                if (std::find(diagnostics_.begin(), diagnostics_.end(), note) == diagnostics_.end()) diagnostics_.push_back(note);
            };
            // UE 5.8.3 Responsive AA (TemporalAA.usf:2277-2278): a transparent draw carries no motion of its own, so
            // upsampled history under it keeps the glow it leaves (a firefly over a hero). Its own program, replayed
            // into the motion target, scales the motion alpha by 1 - alpha: the resolve marks covered pixels
            // responsive. Full resolution reads no mark.
            if (item.transparent && item.colorWrite && inputWidth_ != width_ && draw.pipeline) {
                PipelineTarget target = colourTarget(item, *draw.program);
                target.color = WGPUTextureFormat_RGBA16Float;
                target.blend = 4;
                target.depthWrite = false;
                const auto pipeline = pipelines_->get(draw.program->vertex, &draw.program->fragment, target);
                if (!pipeline) throw std::runtime_error("TN_TRAA_RESPONSIVE_PIPELINE_REFUSED");
                responsiveDraws.emplace_back(size_t(&draw - plan.data()), pipeline);
                if (!compilation) waste::debugAdd(waste::counters().velocitySkipped);
                continue;
            }
            if (unsupported) { skip("unsupported vertex/coverage"); continue; }
            const std::string key = "traa-velocity|" + variant.key();
            if (!programs_.count(key)) {
                auto source = shader::velocityPrograms(variant);
                source.vertex.setInvariantPosition(true);
                add(key, shader::buildStage(source.vertex, 0), shader::buildStage(source.fragment, 1));
            }
            Program& velocity = *programs_.at(key);
            // GPU-written storage and sampled displacement have no retained previous contents.
            if (std::any_of(velocity.vertex.bindings.begin(), velocity.vertex.bindings.end(), [](const auto& binding) {
                return binding.kind != shader::BindingKind::Uniform &&
                    !(binding.kind == shader::BindingKind::Storage && (binding.name == "s_instances" ||
                        binding.name == "s_boneMatrices" || binding.name == "s_traaPrevious_instances" ||
                        binding.name == "s_traaPrevious_boneMatrices"));
            })) { skip("storage/texture history"); continue; }
            PipelineTarget target{WGPUTextureFormat_RGBA16Float, WGPUTextureFormat_Depth32Float,
                item.side == 2 ? WGPUCullMode_None : item.side == 1 ? WGPUCullMode_Front : WGPUCullMode_Back};
            target.layout = velocity.pipelineLayout; target.depthWrite = false;
            target.sampleCount = sampleCount_;
            target.instanceStepMask = instanceStepMask(velocity.vertex, item);
            lineTopology(target, item);
            target.depthCompare = WGPUCompareFunction_Equal; target.frontFace = item.frontFace();
            target.skinIndex = skinIndexFormat(item);
            target.instanceStepMask = instanceStepMask(velocity.vertex, item);
            if (compilation) {
                compilation->push_back(pipelines_->getAsync(velocity.vertex, &velocity.fragment, target));
                continue;
            }
            DeformationFrame current;
            current.program = &velocity;
            current.buffers.push_back(item.instanceCount);
            const auto remember = [&](BufferStore* store) {
                current.buffers.insert(current.buffers.end(), {reinterpret_cast<uintptr_t>(store),
                    store ? store->epoch() : 0, store ? store->writes() : 0,
                    store ? store->version() : 0, store ? store->count() : 0});
            };
            // Instance matrices move freely: the previous frame's copy places them. Only a changed count or store changes data.
            current.buffers.insert(current.buffers.end(), {reinterpret_cast<uintptr_t>(item.instanceMatrices),
                item.instanceMatrices ? item.instanceMatrices->count() : 0});
            // A store rewritten with the same matrices did not move: compare the contents, not the writes.
            if (item.instanceMatrices && !item.indirect)  // ponytail: GPU-placed instances count as still for TRAA
                current.instanceHash = std::hash<std::string_view>{}(std::string_view(
                    reinterpret_cast<const char*>(static_cast<const BufferStore&>(*item.instanceMatrices).data()),
                    std::size_t{item.instanceCount} * 64));
            for (const auto& attribute : velocity.vertex.attributes) remember(vertexSourceOf(item, attribute));
            const auto prior = deformationFrames_.find(item.key);
            const DeformationFrame* previous = !traa_->needsSeed() && prior != deformationFrames_.end() &&
                prior->second.program == &velocity ? &prior->second : nullptr;
            // PRD-754: a slot of its own beside the draw's colour blocks, else appended in plan order.
            const uint64_t velocitySlot = features().stablePasses && draw.slot ? draw.slot * 0x9e3779b97f4a7c15ull + 0x5654u : 0;
            const auto offset = static_cast<uint32_t>(uniformBlocks(velocitySlot, aligned(velocity.vertex.uniformBlockSize)));
            // Copy by field name: the colour and velocity stages have different uniform layouts.
            for (const auto& field : velocity.vertex.uniforms) {
                const auto from = std::ranges::find(draw.program->vertex.uniforms, field.name, &shader::UniformField::name);
                if (from != draw.program->vertex.uniforms.end() && from->type == field.type && from->size == field.size)
                    std::memcpy(frameUniforms_.data() + offset + field.offset,
                        frameUniforms_.data() + draw.vertexOffset + from->offset, field.size);
            }
            putNodes(frameUniforms_, offset, velocity.vertex, *item.nodes, frameTime_, frameDelta_, lights);
            const auto previousModel = traa_->previousModel(item.key, item.matrixWorld);
            const bool instancesMoved = item.instanceMatrices && (!previous || previous->instanceHash != current.instanceHash);
            const std::array<double, 1> dynamic{
                previousModel != item.matrixWorld || item.nodes->positionNode || item.boneMatrices || instancesMoved ? 1.0 : 0.0};
            for (const auto& field : velocity.vertex.uniforms) {
                if (field.name == "unjitteredProjection") put(frameUniforms_, offset, &field, unjitteredCamera.projectionMatrix);
                if (field.name == "previousModel") put(frameUniforms_, offset, &field, previousModel);
                if (field.name == "velocityDynamic") put(frameUniforms_, offset, &field, dynamic);
                if (field.name == "previousProjection") put(frameUniforms_, offset, &field, traa_->previousProjection());
                if (field.name == "previousView") put(frameUniforms_, offset, &field, traa_->previousView());
                const std::string_view prefix = shader::previousDeformationUniformPrefix;
                if (!field.name.starts_with(prefix)) continue;
                const std::string_view name = std::string_view(field.name).substr(prefix.size());
                const auto from = std::ranges::find(velocity.vertex.uniforms, name, &shader::UniformField::name);
                if (from == velocity.vertex.uniforms.end() || from->type != field.type || from->size != field.size)
                    throw std::runtime_error("TN_TRAA_PREVIOUS_UNIFORM: " + field.name);
                const auto* retained = previous && previous->uniforms.size() == velocity.vertex.uniformBlockSize
                    ? previous->uniforms.data() : frameUniforms_.data() + offset;
                std::memcpy(frameUniforms_.data() + offset + field.offset, retained + from->offset, field.size);
            }
            if (item.nodes->positionNode || item.boneMatrices || item.instanceMatrices)  // previous boneBase, instanceBase
                current.uniforms.assign(frameUniforms_.begin() + offset,
                    frameUniforms_.begin() + offset + velocity.vertex.uniformBlockSize);
            const bool changedBuffers = previous && previous->buffers != current.buffers;
            job.deformationFrames[item.key] = std::move(current);
            if (changedBuffers) { skip("changed vertex data"); continue; }
            // The previous palette and instances hold last frame's layout. A seeded frame copies this frame's there first, so
            // both positions match (and a copy that grows loses nothing). A draw new to an unseeded frame has no previous base,
            // and storage that outgrew its previous copy replaces it: both draw no velocity for one frame.
            const std::array<bool, 2> reads{item.boneMatrices != nullptr, item.instanceMatrices != nullptr};
            const std::array<uint64_t, 2> bytes{jointPrefix + bones.size() * 4, instances.size() * 4};
            bool outgrew = false;
            for (std::size_t k = 0; k < reads.size(); ++k) {
                if (!reads[k]) continue;
                job.previousBytes[k] = std::max(job.previousBytes[k], bytes[k]);
                outgrew = outgrew || bytes[k] > storages_[std::string("traaPrevious_") + kPreviousStorages[k]].capacity;
            }
            if (outgrew && !traa_->needsSeed()) { skip("previous-frame storage outgrew its copy"); continue; }
            if (reads[0] || reads[1]) {
                if (!previous && !traa_->needsSeed()) { skip("draw without a previous frame"); continue; }
                job.previousSeed = job.previousSeed || !previous;
            }
            const auto pipeline = pipelines_->get(velocity.vertex, &velocity.fragment, target);
            if (!pipeline) throw std::runtime_error("TN_TRAA_VELOCITY_PIPELINE_REFUSED");
            velocityPlan.push_back({&item, &velocity, pipeline, offset, 0});
            velocityPlan.back().slot = velocitySlot;
        }
        // A post pass that reads "velocity" (motion blur) samples the target the temporal pass draws.
        if (!compilation && postEffects_ && postEffects_->reads("velocity")) postEffects_->input("velocity", traa_->velocityView());
    }
    // The post targets besides colour and velocity: three's MRT `normal` (GTAO, denoise, SSR), metalness/roughness
    // (SSR), `diffuseColor` albedo (GTAO's indirect occlusion) and emissive (SSGI). Like Unreal's base pass writing its
    // GBuffer (PRD-740), one pass over the opaque lit draws writes every target the post graph reads, each at its own
    // colour attachment: each draw's own vertex stage (skinning, morphs, instancing and position nodes included, so
    // the depth matches the colour pass exactly) with a fragment of one output per target, depth-tested Equal against
    // the colour pass's depth. A draw the pass cannot write (unlit, transparent, sprite) leaves every target cleared
    // there: the effects read a depth-derived normal, no surface, no albedo and no emission. An alpha-tested draw writes
    // its targets where its fragment survives, as three's MRT and Unreal's masked base pass do: its own fragment
    // discards, so the cut holds at 4x too, where the depth test alone would let it through.
    const bool normalPass = postEffects_ && postEffects_->reads("normal");
    const bool materialPass = postEffects_ && (postEffects_->reads("metalness") || postEffects_->reads("roughness"));
    const bool albedoPass = postEffects_ && postEffects_->reads("albedo");
    const bool emissivePass = postEffects_ && postEffects_->reads("emissive");
    const bool indirectPass = postEffects_ && postEffects_->reads("indirectDiffuse");
    // The target feeds a post pass: with no post graph there is nothing to bind it to, and the frame keeps its own
    // colour alone. The graph asks for it by name (collectPostSources), in a pass or in the output program.
    const bool translucentPass =
        postEffects_ && (translucentRequested_ || postEffects_->reads("translucent"));
    const uint8_t auxMask = uint8_t((normalPass ? kAuxNormal : 0) | (materialPass ? kAuxMaterial : 0) |
                                    (albedoPass ? kAuxAlbedo : 0) | (emissivePass ? kAuxEmissive : 0) |
                                    (indirectPass ? kAuxIndirect : 0));
    // A material's own mrt() slots (three's custom MRT outputs): the frame's union, in name order so the pass's
    // attachments and every fragment's outputs agree from one frame to the next. A slot the material names is a
    // further colour target; one it does not name is zero there, which keeps every pipeline of the pass equal.
    std::vector<std::string> mrtSlots;
    for (const Planned& draw : plan) {
        const DrawItem& item = *draw.item;
        if (!item.nodes) continue;
        for (const auto& slot : item.nodes->mrt) {
            const shader::Type type = slot.node ? slot.node->type : shader::Type{};
            if (!slot.node || type.scalar != shader::Type::Scalar::F32 || type.isMatrix() || type.rows > 4)
                throw std::runtime_error("TN_NATIVE_MRT_UNSUPPORTED: slot '" + slot.name + "' writes " +
                                         type.name() + ", not a float or float vector");
            if (std::find(mrtSlots.begin(), mrtSlots.end(), slot.name) == mrtSlots.end()) mrtSlots.push_back(slot.name);
        }
    }
    std::sort(mrtSlots.begin(), mrtSlots.end());
    job.auxMrt = mrtSlots;
    // A normal-only frame keeps the small normal fragment: the merged one is the whole lit program.
    const auto normalFragment = [&](const Planned& draw) -> const shader::StageModule* {
        const DrawItem& item = *draw.item;
        // Standard and Physical programs lead their fragment block with metalness and roughness.
        // A material node that replaces either one has no such field: the draw writes no surface (alpha 0).
        const bool surface = (item.kind == MaterialKind::Standard || item.kind == MaterialKind::Physical) &&
                             !item.nodes->metalnessNode && !item.nodes->roughnessNode;
        auto& fragment = (surface ? surfaceFragments_ : normalFragments_)[item.flatShading ? 2 : size_t(item.side == 2)];
        if (fragment.wgsl.code.empty()) {
            shader::Program f{shader::Stage::Fragment};
            f.output("color", normalTarget(f, item.flatShading, item.side == 2, surface));
            fragment = shader::buildStage(f, 1);
            if (!fragment.wgsl.ok())
                throw std::runtime_error(surface ? "TN_NATIVE_SHADER_INVALID: post surface program" : "TN_NATIVE_SHADER_INVALID: post normal program");
        }
        // The normal fragment reads `normalView` at location 0, which the program's vertex stage must write there.
        if (draw.program->vertex.wgsl.code.find("@location(0) o_normalView") == std::string::npos)
            throw std::runtime_error("TN_POST_NORMAL_LAYOUT: normalView is not the vertex stage's first varying");
        if (item.flatShading && draw.program->vertex.wgsl.code.find("@location(1) o_positionView") == std::string::npos)
            throw std::runtime_error("TN_POST_NORMAL_LAYOUT: positionView is not the vertex stage's second varying");
        return &fragment;
    };
    const auto planAux = [&] {
        if (!auxMask && mrtSlots.empty() && !translucentPass) return;
        // The pass holds one attachment per named target the post graph reads, then one per custom MRT slot, and
        // writes no `color` of its own: they are the pass's whole colour-attachment list (aux_targets.h).
        const std::size_t namedTargets = std::size_t(std::popcount(auxMask));
        if (!auxTargetsFit(namedTargets, mrtSlots.size()))
            throw std::runtime_error("TN_NATIVE_MRT_UNSUPPORTED: " + std::to_string(namedTargets + mrtSlots.size()) +
                                     " colour attachments exceed the device limit " + std::to_string(kMaxColourTargets));
        for (const Planned& draw : plan) {
            const DrawItem& item = *draw.item;
            // A translucent draw composites its own colour over the frame, lit or not: the waterfall's sheet, a
            // glass dome, the sky dome's fade. The occlusion a screen-space effect gathers at that pixel belongs to the
            // opaque surface behind it, so the draw goes to its own target and the post graph restores it after the
            // occlusion (Unreal applies AO to the opaque lighting, before translucency). Its own program draws it,
            // unchanged, so the target holds exactly what the colour target took from it.
            if (item.transparent && translucentPass && item.colorWrite) {
                PipelineTarget target = colourTarget(item, *draw.program);
                target.color = WGPUTextureFormat_RGBA16Float;
                target.sampleCount = 1;  // drawn single-sampled against the colour pass's resolved depth, as the aux pass
                target.depthWrite = false;
                // It blends over what is behind it, so the depth it must beat is the opaque surface's: equal passes, and
                // at 4x the bias pulls it nearer by the half-pixel depth slope the aux pass already corrects for.
                target.depthCompare = item.depthTest ? WGPUCompareFunction_LessEqual : WGPUCompareFunction_Always;
                if (sampleCount_ == 4 && item.depthTest) {
                    target.depthBias = -4; target.depthBiasSlopeScale = -1.5f;
                }
                if (compilation) {
                    compilation->push_back(pipelines_->getAsync(draw.program->vertex, &draw.program->fragment, target));
                } else {
                    const auto pipeline = pipelines_->get(draw.program->vertex, &draw.program->fragment, target);
                    if (!pipeline) throw std::runtime_error("TN_POST_TRANSLUCENT_PIPELINE_REFUSED");
                    Planned sheet = draw;
                    sheet.pipeline = pipeline;
                    job.translucentPlan.push_back(sheet);
                }
            }
            // A draw writes a custom MRT slot when it names one: three draws a transparent sea's or an unlit
            // quad's own output with the same fragment, and leaves the named targets as the opaque draws left them.
            const bool custom = !mrtSlots.empty() && item.nodes &&
                std::any_of(item.nodes->mrt.begin(), item.nodes->mrt.end(), [&](const shader::MrtOutput& slot) {
                    return std::binary_search(mrtSlots.begin(), mrtSlots.end(), slot.name);
                });
            // The sky and unlit materials write no view-space normal (their programs have no normalView).
            if (item.background || (item.kind == MaterialKind::Basic && !custom)) continue;
            // A draw that writes only custom slots leaves the named targets alone: a transparent sea or an unlit
            // quad has no surface for them. Named once a frame, not thrown: a transparent particle costs no frame.
            const bool customOnly = item.transparent || item.sprite || item.kind == MaterialKind::Basic;
            if (customOnly && !custom) {
                if (!normalPass) continue;
                const std::string reason = item.transparent ? "transparent" : "sprite";
                const std::string note = "TN_POST_NORMAL_SKIPPED: " + reason + " draws write no normal (depth-derived there)";
                if (std::find(diagnostics_.begin(), diagnostics_.end(), note) == diagnostics_.end()) diagnostics_.push_back(note);
                continue;
            }
            // three's normal target holds the material's own normal: three's setupNormal returns vec3(normalNode) for
            // a material that authors one, so that draw writes the target from its own lit fragment. The shared
            // geometry-normal pass covers every other draw. Only Standard and Physical read the authored node and
            // export `out.normal`; buildLit (Lambert, Phong) ignores it, so routing those through their own aux
            // fragment would pay for a program that writes the geometry normal anyway.
            const bool authoredNormal = item.nodes->normalNode != nullptr &&
                (item.kind == MaterialKind::Standard || item.kind == MaterialKind::Physical);
            const bool cut = alphaTested(*item.material, *item.nodes) || item.material->alphaHash;
            // The small normal-only fragment writes one colour output, so it fits a pass holding one target only
            // (aux_fragment.h): a frame with a custom MRT slot takes the merged fragment, which writes every target.
            const bool smallFits = smallNormalFragmentFits(auxMask == kAuxNormal, !mrtSlots.empty());
            const shader::StageModule* fragment = !customOnly && smallFits && !cut && !authoredNormal
                ? normalFragment(draw)
                : auxFragment(*draw.program, auxMask, mrtSlots, customOnly);
            if (!fragment && authoredNormal && smallFits && !cut) {
                // The builder could not re-run on this layout: the draw writes its geometric normal, named once a frame.
                const std::string note = "TN_POST_NORMAL_GEOMETRIC: a material normalNode reaches the post normal target as its geometric normal";
                if (std::find(diagnostics_.begin(), diagnostics_.end(), note) == diagnostics_.end()) diagnostics_.push_back(note);
                fragment = normalFragment(draw);
            }
            if (!fragment) {
                const std::string note = "TN_POST_AUX_SKIPPED: a draw's program has no post-target fragment on its own layout";
                if (std::find(diagnostics_.begin(), diagnostics_.end(), note) == diagnostics_.end()) diagnostics_.push_back(note);
                continue;
            }
            PipelineTarget target{WGPUTextureFormat_RGBA16Float, WGPUTextureFormat_Depth32Float,
                item.side == 2 ? WGPUCullMode_None : item.side == 1 ? WGPUCullMode_Front : WGPUCullMode_Back};
            // The first output takes location 0 (the first attachment); the rest are this pipeline's further targets.
            for (std::size_t i = 0; i + 1 < namedTargets + mrtSlots.size(); ++i) target.moreColors[i] = WGPUTextureFormat_RGBA16Float;
            target.layout = draw.program->pipelineLayout; target.depthWrite = false;
            target.colorWrite = item.colorWrite;
            target.materialColorWrite = item.colorWrite;
            // A transparent draw leaves the named targets untouched: it writes only the custom slots (three's
            // transparent fragment writes its own MRT outputs, not another material's surface targets). After the
            // material's own mask, so a game that masks its sea keeps the named targets' values.
            if (customOnly) {
                if (namedTargets > 0) target.colorWrite = false;
                if (namedTargets > 1) target.moreWrites = uint8_t(0xffu << (namedTargets - 1));
            }
            target.depthCompare = auxDepthLessEqual(item.depthWrite, sampleCount_) ? WGPUCompareFunction_LessEqual
                                                                                  : WGPUCompareFunction_Equal;
            target.frontFace = item.frontFace();
            // At 4x the pass draws single-sampled against the colour pass's resolved depth, one sample taken at a
            // sample position, while this pass interpolates at the pixel centre: they differ by up to half a pixel of
            // depth slope, so Equal fails on every surface that is not square to the camera. Test LessEqual (aux_depth.h)
            // with the bias pulling this pass nearer by that slope instead: the nearest surface passes, a surface behind it does not.
            if (sampleCount_ == 4) {
                target.depthBias = -4; target.depthBiasSlopeScale = -1.5f;
            }
            // ponytail: one depth bias for every aux draw, a transparent MRT draw included; a custom slot behind an
            // opaque silhouette can win by that slope. Split the bias by transparency if a proof ever shows it.
            target.skinIndex = skinIndexFormat(item);
            target.instanceStepMask = instanceStepMask(draw.program->vertex, item);
            lineTopology(target, item);
            if (compilation) {
                compilation->push_back(pipelines_->getAsync(draw.program->vertex, fragment, target));
                continue;
            }
            bool deferred = false;
            const auto pipeline = deferUncompiled_ ? pipelines_->getOrDefer(draw.program->vertex, fragment, target, deferred)
                                                   : pipelines_->get(draw.program->vertex, fragment, target);
            if (deferred) continue;  // its colour draws; the post pass derives its normal from depth there, as for a transparent draw
            if (!pipeline) throw std::runtime_error("TN_POST_AUX_PIPELINE_REFUSED");
            Planned aux = draw;
            aux.pipeline = pipeline;
            job.auxPlan.push_back(aux);
        }
        if (compilation) return;
        const auto target = [&](bool read, WGPUTexture& texture, WGPUTextureView& view, std::initializer_list<const char*> inputs) {
            if (!read) return;
            if (!texture) {
                WGPUTextureDescriptor desc = {};
                desc.dimension = WGPUTextureDimension_2D; desc.size = {inputWidth_, inputHeight_, 1};
                desc.format = WGPUTextureFormat_RGBA16Float; desc.mipLevelCount = 1; desc.sampleCount = 1;
                desc.usage = WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopySrc;
                texture = wgpuDeviceCreateTexture(device_, &desc);
                view = view2d(texture, WGPUTextureFormat_RGBA16Float);
            }
            for (const char* input : inputs) postEffects_->input(input, view);
        };
        target(normalPass, normalTexture_, normalView_, {"normal"});
        target(materialPass, materialTexture_, materialView_, {"metalness", "roughness"});
        target(albedoPass, albedoTexture_, albedoView_, {"albedo"});
        target(emissivePass, emissiveTexture_, emissiveView_, {"emissive"});
        target(indirectPass, indirectTexture_, indirectView_, {"indirectDiffuse"});
        target(translucentPass, translucentTexture_, translucentView_, {"translucent"});
        // A custom MRT slot's target, allocated on first use at the scene's size and readable by the post graph under
        // the slot's own name (three's PassNode.getTextureNode(slot)).
        for (const auto& name : mrtSlots) {
            WGPUTextureView view = mrtViews_.count(name) ? mrtViews_.at(name) : nullptr;
            if (!view) {
                WGPUTextureDescriptor desc = {};
                desc.dimension = WGPUTextureDimension_2D; desc.size = {inputWidth_, inputHeight_, 1};
                desc.format = WGPUTextureFormat_RGBA16Float; desc.mipLevelCount = 1; desc.sampleCount = 1;
                desc.usage = WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopySrc;
                WGPUTexture texture = wgpuDeviceCreateTexture(device_, &desc);
                view = view2d(texture, WGPUTextureFormat_RGBA16Float);
                mrtTextures_[name] = texture;
                mrtViews_[name] = view;
            }
            if (postEffects_) postEffects_->input(name, view);
        }
    };
    WGPURenderPipeline pageClear = nullptr;
    if (!virtualShadows_.empty()) {
        shader::Program clear(shader::Stage::Vertex);
        const auto i = clear.builtin("vertexIndex");
        const auto zero = clear.construct(shader::Type::u32(), {clear.constant(int32_t(0))}), one = clear.construct(shader::Type::u32(), {clear.constant(int32_t(1))});
        const auto x = clear.select(clear.equal(i, one), clear.constant(3.0f), clear.constant(-1.0f));
        const auto y = clear.select(clear.equal(i, zero), clear.constant(3.0f), clear.constant(-1.0f));
        clear.output("position", clear.construct(shader::Type::vec(4), {x, y, clear.constant(1.0f), clear.constant(1.0f)}));
        const auto vertex = shader::buildStage(clear, 0);
        PipelineTarget target{WGPUTextureFormat_Undefined, WGPUTextureFormat_Depth24Plus, WGPUCullMode_None};
        target.depthCompare = WGPUCompareFunction_Always;
        if (compilation) compilation->push_back(pipelines_->getAsync(vertex, nullptr, target));
        else {
            pageClear = pipelines_->get(vertex, nullptr, target);
            if (!pageClear) throw std::runtime_error("TN_NATIVE_PIPELINE_REFUSED: virtual page clear");
        }
    }
    if (compilation) {
        planAux();
        PipelineTarget target{outputFormat, WGPUTextureFormat_Undefined, WGPUCullMode_None};
        target.layout = outputPipelineLayout_;
        compilation->push_back(pipelines_->getAsync(outputVertex_, &outputFragment_, target));
        const auto texture = [&](const Texture* map) {
            if (map && !map->volume && map->hasImage() && map->generateMipmaps && map->bytesPerTexel() == 4 &&
                std::max(map->width, map->height) > 1)
                copyPipeline(textureFormat(*map), 0, compilation);
        };
        for (const DrawItem& item : items) {
            texture(item.map); texture(item.normalMap); texture(item.envMap); texture(item.pmremMap);
            for (const Texture* map : item.pbrMaps) texture(map);
            if (item.nodeTextures) for (const auto& [name, map] : *item.nodeTextures) texture(map);
            if (item.background && item.map) {
                const auto conversion = shader::buildEquirectangularCube();
                const auto vs = shader::buildStage(conversion.vertex, 0), fs = shader::buildStage(conversion.fragment, 0);
                PipelineTarget cube{textureFormat(*item.map), WGPUTextureFormat_Undefined, WGPUCullMode_None};
                compilation->push_back(pipelines_->getAsync(vs, &fs, cube));
            }
        }
        return id;
    }

    if (frameUniforms_.size() > uniformCapacity_) {
        if (uniformCapacity_ != 0) gpu_.destroy(uniformBuffer_);
        uniformCapacity_ = std::max<uint64_t>(frameUniforms_.size() * 2, 64 * 1024);
        uniformBuffer_ = gpu_.createBuffer(uniformCapacity_, WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst);
        uploadedUniforms_.clear();  // a new buffer has nothing of the old arena in it
        rebuildGroups();
    } else if (shadowMapsChanged_) {
        rebuildGroups();
    }
    shadowMapsChanged_ = false;
    // FM2: only the bytes that changed since the last upload cross to the GPU, so a frame whose slots did not move —
    // a still camera over still objects — sends nothing instead of the whole arena. A moving camera still rewrites
    // every slot, because each draw's block carries the view and the view-space light slab: only a second binding
    // for the frame's own slab takes that share out of every draw's block. The scan is per uniform block (a slot is
    // 256-byte aligned, so a slot that moved re-sends whole), and a mostly-dirty arena still makes one write, so
    // this never costs more calls than the single write it replaced.
    const uint64_t uniformBytes = frameUniforms_.size();
    if (uniformBytes != 0 && uploadedUniforms_.size() != uniformBytes) {
        gpu_.writeBuffer(uniformBuffer_, 0, frameUniforms_.data(), uniformBytes);  // a grown arena: all of it once
        uploadedUniforms_.assign(frameUniforms_.begin(), frameUniforms_.end());
        waste::debugAdd(waste::counters().uniformUploadBytes, uniformBytes);
    } else if (uniformBytes != 0 && std::memcmp(uploadedUniforms_.data(), frameUniforms_.data(), uniformBytes) != 0) {
        constexpr uint64_t kUniformBlock = kUniformAlign;  // one block's granularity
        // Every block is kUniformAlign bytes, so a run's length is a multiple of 4, as writeBuffer requires.
        static_assert(kUniformAlign % 4 == 0);
        uniformDirtyRanges_.clear();
        uint64_t runStart = 0, runEnd = 0;
        const auto closeRun = [&] {
            if (runEnd != runStart) uniformDirtyRanges_.emplace_back(runStart, runEnd - runStart);
            runStart = runEnd = 0;
        };
        for (uint64_t at = 0; at < uniformBytes; at += kUniformBlock) {
            const uint64_t end = std::min(at + kUniformBlock, uniformBytes);
            if (std::memcmp(frameUniforms_.data() + at, uploadedUniforms_.data() + at, end - at) != 0) {
                if (runEnd == runStart) runStart = at;
                runEnd = end;
            } else {
                closeRun();
            }
        }
        closeRun();
        uint64_t dirty = 0;
        for (const auto& range : uniformDirtyRanges_) dirty += range.second;
        if (dirty * 2 >= uniformBytes) {  // mostly dirty: one write is cheaper than the calls
            gpu_.writeBuffer(uniformBuffer_, 0, frameUniforms_.data(), uniformBytes);
            uploadedUniforms_.assign(frameUniforms_.begin(), frameUniforms_.end());
            dirty = uniformBytes;
        } else {
            for (const auto& [offset, length] : uniformDirtyRanges_) {
                gpu_.writeBuffer(uniformBuffer_, offset, frameUniforms_.data() + offset, length);
                std::memcpy(uploadedUniforms_.data() + offset, frameUniforms_.data() + offset, length);
            }
        }
        waste::debugAdd(waste::counters().uniformUploadBytes, dirty);
    }
    job.uniformBytes = frameUniforms_.size();
    bool jointBufferMoved = false;
    bool instancesUploaded = false;
    for (auto& [name, storage] : storages_) {
        const uint64_t prefix = name == "boneMatrices" ? jointPrefix : 0;
        if (prefix + storage.data.size() * 4 > storage.capacity) {
            gpu_.destroy(storage.buffer);
            storage.capacity = std::max<uint64_t>((prefix + storage.data.size() * 4) * 2, 64 * 1024);
            jointBufferMoved = jointBufferMoved || (name == "boneMatrices" && jointPrefix);
            storage.buffer = gpu_.createBuffer(storage.capacity, WGPUBufferUsage_Storage | WGPUBufferUsage_CopyDst | WGPUBufferUsage_CopySrc);
            storage.uploaded.clear();
            storage.uploadedBuffer = Handle{};
            rebuildGroups();
        }
        if (storage.data.empty()) continue;
        const uint64_t bytes = storage.data.size() * 4;
        const auto* source = reinterpret_cast<const uint8_t*>(storage.data.data());
        const Handle& target = storage.buffer;
        const bool sameBuffer = storage.uploadedBuffer.type == target.type &&
                                storage.uploadedBuffer.context == target.context &&
                                storage.uploadedBuffer.index == target.index &&
                                storage.uploadedBuffer.generation == target.generation;
        // TR1: of the bytes the GPU already holds at this offset only the blocks that differ cross to it, and the bytes
        // past the old end are new; a buffer or offset that moved starts over with all of it. A draw whose bytes did not
        // change (a still crowd, a draw that kept its place in `instances`) sends nothing, whatever its neighbours do.
        const uint64_t held = sameBuffer && storage.uploadedPrefix == prefix ? std::min<uint64_t>(storage.uploaded.size(), bytes) : 0;
        constexpr uint64_t kStorageBlock = 256;  // a multiple of 4: writeBuffer takes whole words
        constexpr std::size_t kMaxWrites = 32, kMaxPaletteWrites = 256;
        auto& ranges = uniformDirtyRanges_;  // the uniform upload above is done with it
        ranges.clear();
        const auto dirty = [&](uint64_t at, uint64_t end) {
            if (!ranges.empty() && ranges.back().first + ranges.back().second == at) ranges.back().second = end - ranges.back().first;
            else ranges.emplace_back(at, end - at);
        };
        // `instances` scans only what this plan copied (a place whose stores did not move was left alone and already
        // matches the GPU) and the shadow rows past the places. A palette scans all it holds, one 4x4 at a time: a
        // crowd slot whose pose held kept its bytes, so only the moved slots cross (PRD-878).
        const bool instances = name == "instances";
        const uint64_t block = instances ? kStorageBlock : 16 * sizeof(float);
        auto& spans = instanceScan_;
        spans.clear();
        if (instances) {
            std::sort(instanceDirty_.begin(), instanceDirty_.end());
            for (const auto& [offset, count] : instanceDirty_) {
                const uint64_t at = offset * 4, end = std::min((offset + count) * 4, held);
                if (at >= end) continue;
                if (!spans.empty() && at <= spans.back().second) spans.back().second = std::max(spans.back().second, end);
                else spans.emplace_back(at, end);
            }
        }
        const uint64_t tail = instances ? std::min(instanceTop_ * 4, held) : 0;
        if (tail < held) spans.emplace_back(tail, held);
        for (const auto& [from, to] : spans) {
            for (uint64_t at = from; at < to; at += block) {
                const uint64_t end = std::min(at + block, to);
                if (!sameBytes(source + at, storage.uploaded.data() + at, end - at)) dirty(at, end);
            }
        }
        if (bytes > held) dirty(held, bytes);
        if (ranges.empty()) {
            storage.uploaded.resize(bytes);  // it shrank: the bytes that remain are the ones the GPU holds
            instancesUploaded = instancesUploaded || instances;
            continue;
        }
        const uint64_t first = ranges.front().first, last = ranges.back().first + ranges.back().second;
        uint64_t dirtyBytes = 0;
        for (const auto& range : ranges) dirtyBytes += range.second;
        // Mostly dirty, or many runs: one write over them all. A crowd palette has one run per moved rig, so it may take
        // one write per rig (PRD-878: 240 walkers, about 76 moved slots a frame on ?stress).
        if (ranges.size() > (instances ? kMaxWrites : kMaxPaletteWrites) || dirtyBytes * 2 >= last - first) {
            ranges.assign(1, {first, last - first});
        }
        storage.uploaded.resize(bytes);
        bool written = true;
        for (const auto& [offset, length] : ranges) {
            if (gpu_.writeBuffer(target, prefix + offset, source + offset, length) != GpuStatus::Ok) { written = false; break; }
            std::memcpy(storage.uploaded.data() + offset, source + offset, length);
        }
        if (written) {
            storage.uploadedBuffer = target;
            storage.uploadedPrefix = prefix;
            instancesUploaded = instancesUploaded || instances;
        } else {  // the copy no longer says what the GPU holds: the next frame sends all of it
            storage.uploaded.clear();
            storage.uploadedBuffer = Handle{};
        }
    }

    if (instancesUploaded)  // the GPU holds what these places hold: the next plan may leave a place with this stamp alone
        for (auto& [slot, stamp] : instancePlanned_) slot->stamp = stamp, slot->stamped = true;
    if (jointPrefix && !compilation) {
        if (jointBufferMoved && !bindGpuJoints(gpuJoints_)) throw std::runtime_error("TN_GPU_JOINTS: output resize refused");
        // Culled rigs keep disjoint trailing slots; no Bone data is inspected or repacked.
        for (uint32_t rig = 0; rig < jointOutputs.size(); ++rig) if (jointOutputs[rig] == UINT32_MAX) {
            jointOutputs[rig] = jointWritten;
            jointWritten += gpuJoints_->topology[rig].count;
        }
        if (!gpuJointPass_ || !gpuJointPass_->remapOutputs(jointOutputs) ||
            gpu_.writeBuffer(gpuJointLocals_, 0, gpuJoints_->locals->data(), gpuJoints_->locals->size() * 4) != GpuStatus::Ok ||
            !gpuJointPass_->dispatch(encoder)) {
            gpuJoints_->revoke();
            throw std::runtime_error("TN_GPU_JOINTS: dispatch refused before submission");
        }
    }
    // Storage that outgrew its previous copy: the copy grows now, its draws skipped velocity this frame, and the copy after
    // the velocity pass fills it for the next.
    for (std::size_t k = 0; k < kPreviousStorages.size(); ++k) {
        FrameStorage& previous = storages_.at(std::string("traaPrevious_") + kPreviousStorages[k]);
        if (job.previousBytes[k] <= previous.capacity) continue;
        gpu_.destroy(previous.buffer);
        previous.capacity = std::max<uint64_t>(job.previousBytes[k] * 2, 64 * 1024);
        previous.buffer = gpu_.createBuffer(previous.capacity,
            WGPUBufferUsage_Storage | WGPUBufferUsage_CopyDst | WGPUBufferUsage_CopySrc);
        rebuildGroups();
    }

    // A vertex stage that samples graph textures (a positionNode's displacement map) binds them per
    // draw, in the main pass and the shadow passes alike; `graphKey` names the draw's textures.
    const auto vertexGroupOf = [&](const Planned& p, const std::string& graphKey) -> WGPUBindGroup {
        if (!probesOf(*p.program).vertexPerDraw) return nullptr;
        const std::string vertexKey = "vertex|" + std::to_string(reinterpret_cast<uintptr_t>(p.program)) + graphKey;
        const auto found = mapGroups_.find(vertexKey);
        if (found != mapGroups_.end()) return found->second;
        return mapGroups_.emplace(vertexKey, bindGroup(p.program->layouts[0], p.program->vertex, uniformBuffer_,
                                  lutView_, lutSampler_, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr,
                                  nullptr, nullptr, nullptr, p.item->nodeTextures)).first->second;
    };
    const auto graphKeyOf = [&](const DrawItem& item) {
        std::string key;
        if (item.nodeTextures)
            for (const auto& [label, texture] : *item.nodeTextures) {
                const MaterialTexture* gpu = materialTexture(*texture);
                key += "|" + label + "," + std::to_string(reinterpret_cast<uintptr_t>(gpu->view)) + "," +
                       std::to_string(reinterpret_cast<uintptr_t>(gpu->sampler));
            }
        return key;
    };

    // A draw's fragment group depends on its program, its textures (identity and version, which the
    // descriptor derives from) and the group epoch (a rebuilt uniform buffer or dropped groups). Equal
    // keys mean the record's cached group can be bound without rebuilding it or its key string.
    const auto textureToken = [](const Texture* t) -> uint64_t {
        if (!t) return 0;
        uint64_t h = reinterpret_cast<uintptr_t>(t);
        return h ^ (uint64_t(t->version()) + 0x9e3779b97f4a7c15ull + (h << 6) + (h >> 2));
    };
    uint64_t postStamp = 0;  // postViewsStamp(), read once after the views refresh below, not per draw
    const auto drawGroupKey = [&](const Planned& p) {
        const DrawItem& item = *p.item;
        uint64_t h = 0xcbf29ce484222325ull;
        const auto mix = [&h](uint64_t v) { h = (h ^ v) * 0x100000001b3ull; };
        mix(reinterpret_cast<uintptr_t>(p.program));
        mix(textureToken(item.map)); mix(textureToken(item.normalMap));
        for (const Texture* t : item.pbrMaps) mix(textureToken(t));
        mix(textureToken(item.envMap)); mix(textureToken(item.pmremMap));
        if (item.reflectors)
            for (const GraphReflector& mirror : *item.reflectors) {
                mix(hashBytes(mirror.name.data(), mirror.name.size()));
                mix(reinterpret_cast<uintptr_t>(mirror.view));
                mix(reinterpret_cast<uintptr_t>(mirror.sampler));
            }
        mix(postStamp);  // a node may sample a post texture
        if (item.nodeTextures)
            for (const auto& [label, texture] : *item.nodeTextures) {
                mix(hashBytes(label.data(), label.size()));
                mix(textureToken(texture));
            }
        mix(reinterpret_cast<uintptr_t>(viewportColorView_));
        mix(reinterpret_cast<uintptr_t>(viewportDepthView_));
        mix(groupEpoch_);
        return h;
    };

    // Refresh every view before selecting groups: a later upload invalidates groups of earlier draws.
    for (const Planned& p : plan) {
        if (p.item->normalMap) materialTexture(*p.item->normalMap);
        for (const Texture* texture : p.item->pbrMaps) if (texture) materialTexture(*texture);
        if (p.item->map) {
            if (p.item->background) backgroundCube(*p.item->map);
            else materialTexture(*p.item->map);
        }
        if (p.item->envMap) environment(*p.item->envMap);
        if (p.item->pmremMap) environment(*p.item->pmremMap);
        if (p.item->nodeTextures)
            for (const auto& [label, texture] : *p.item->nodeTextures) if (texture) materialTexture(*texture);
    }
    // The post graph's textures are read after the plan; a render target's view that moves there would drop
    // the groups chosen below, so it moves here. A shadow draw's vertex group follows for the same reason.
    for (size_t i = 0; i < postTextureNodes_.size(); ++i) {
        const auto* source = static_cast<const Texture*>(postTextureNodes_[i]->textureObject().get());
        if (source != postTextures_[i].second) releaseOutputGroup();
        postTextures_[i].second = source;
    }
    for (const auto& texture : postTextures_) materialTexture(*texture.second);
    for (const ShadowPass& pass : shadowPasses)
        for (const Planned& draw : pass.draws)
            if (draw.item->material->alphaHash && draw.item->map) materialTexture(*draw.item->map);
    for (Planned& draw : velocityPlan) draw.vertexGroup = vertexGroupOf(draw, graphKeyOf(*draw.item));
    for (ShadowPass& pass : shadowPasses)
        for (Planned& draw : pass.draws) {
            draw.vertexGroup = vertexGroupOf(draw, graphKeyOf(*draw.item));
            if (!draw.item->material->alphaHash || !draw.item->map) continue;
            const MaterialTexture* map = materialTexture(*draw.item->map);
            const std::string key = "shadow|" + std::to_string(reinterpret_cast<uintptr_t>(draw.program)) + "|" +
                std::to_string(reinterpret_cast<uintptr_t>(map->view)) + "|" + std::to_string(reinterpret_cast<uintptr_t>(map->sampler));
            const auto found = mapGroups_.find(key);
            draw.mapGroup = found != mapGroups_.end() ? found->second :
                mapGroups_.emplace(key, bindGroup(draw.program->layouts[1], draw.program->fragment, uniformBuffer_,
                    lutView_, lutSampler_, map->view, map->sampler)).first->second;
        }

    postStamp = postViewsStamp();
    // A mapped draw's fragment group binds its own texture and sampler beside the frame's uniforms.
    // Created here, after the uniform buffer exists; cached per program and texture.
    for (Planned& p : plan) {
        const bool readsPbr = std::any_of(p.item->pbrMaps.begin(), p.item->pbrMaps.end(), [](const Texture* t) { return t; });
        const GraphTextures* graphTextures = p.item->nodeTextures;
        std::string graphKey = graphKeyOf(*p.item);
        p.vertexGroup = vertexGroupOf(p, graphKey);
        const DrawProbes probes = probesOf(*p.program);
        const bool viewport = probes.viewport;
        const bool postTexture = probes.postTexture;
        if (!p.item->map && !p.item->envMap && !p.item->normalMap && !readsPbr && !p.item->pmremMap &&
            !p.item->reflectors && !graphTextures && !viewport && !postTexture) continue;
        DrawCache* cache = p.item->cache;
        const uint64_t groupKey = drawGroupKey(p);
        if (cache && cache->mapGroup && cache->mapGroupKey == groupKey) {
            p.mapGroup = static_cast<WGPUBindGroup>(cache->mapGroup);
            continue;
        }
        if (postTexture)
            graphKey += "|post," + std::to_string(postStamp);
        if (viewport)
            graphKey += "|viewport," + std::to_string(reinterpret_cast<uintptr_t>(viewportColorView_)) + "," +
                        std::to_string(reinterpret_cast<uintptr_t>(viewportDepthView_));
        const MaterialTexture* normal = p.item->normalMap ? materialTexture(*p.item->normalMap) : nullptr;
        std::array<const MaterialTexture*, shader::kPbrMapCount> pbrTextures{};
        for (int k = 0; k < shader::kPbrMapCount; ++k)
            if (p.item->pbrMaps[k]) pbrTextures[k] = materialTexture(*p.item->pbrMaps[k]);
        const MaterialTexture* map = p.item->map && !p.item->background ? materialTexture(*p.item->map) : nullptr;
        const BackgroundCube* cube = p.item->background && p.item->map ? &backgroundCube(*p.item->map) : nullptr;
        const EnvironmentGpu* env = p.item->envMap ? &environment(*p.item->envMap) : nullptr;
        const EnvironmentGpu* pmrem = p.item->pmremMap ? &environment(*p.item->pmremMap) : nullptr;
        const WGPUTextureView mapView = cube ? cube->view : map ? map->view : nullptr, envView = env ? env->view : nullptr;
        const WGPUSampler mapSampler = cube ? cube->sampler : map ? map->sampler : nullptr, envSampler = env ? env->sampler : nullptr;
        const std::string key = std::to_string(reinterpret_cast<uintptr_t>(p.program)) + "|" +
                                std::to_string(reinterpret_cast<uintptr_t>(mapView)) + "|" +
                                std::to_string(reinterpret_cast<uintptr_t>(mapSampler)) + "|" +
                                std::to_string(reinterpret_cast<uintptr_t>(envView)) + "|" +
                                std::to_string(reinterpret_cast<uintptr_t>(normal ? normal->view : nullptr)) + "|" +
                                std::to_string(reinterpret_cast<uintptr_t>(normal ? normal->sampler : nullptr)) + "|" +
                                std::to_string(reinterpret_cast<uintptr_t>(pmrem ? pmrem->view : nullptr)) + "|";
        std::string pbrKey;
        for (const MaterialTexture* texture : pbrTextures)
            pbrKey += "|" + std::to_string(reinterpret_cast<uintptr_t>(texture ? texture->view : nullptr)) + "," +
                      std::to_string(reinterpret_cast<uintptr_t>(texture ? texture->sampler : nullptr));
        pbrKey += graphKey;
        // Each mirror pass the draw samples is its own binding: its view and sampler pick the group.
        if (p.item->reflectors)
            for (const GraphReflector& mirror : *p.item->reflectors)
                pbrKey += "|" + mirror.name + "," + std::to_string(reinterpret_cast<uintptr_t>(mirror.view)) + "," +
                          std::to_string(reinterpret_cast<uintptr_t>(mirror.sampler));
        const auto found = mapGroups_.find(key + pbrKey);
        p.mapGroup = found != mapGroups_.end()
                         ? found->second
                         : mapGroups_.emplace(key + pbrKey, bindGroup(p.program->layouts[1], p.program->fragment, uniformBuffer_,
                                                             lutView_, lutSampler_, mapView, mapSampler, envView, envSampler,
                                                         normal ? normal->view : nullptr, normal ? normal->sampler : nullptr, &pbrTextures,
                                                         pmrem ? pmrem->view : nullptr, pmrem ? pmrem->sampler : nullptr,
                                                         p.item->reflectors, graphTextures))
                               .first->second;
        if (cache) { cache->mapGroupKey = groupKey; cache->mapGroup = p.mapGroup; }
    }
    // A masked caster's depth program samples the caster's map (PRD-651) and its node's own textures (an impostor's
    // atlas, PRD-858): its group binds them.
    for (ShadowPass& pass : shadowPasses)
        for (Planned& draw : pass.draws) {
            if ((!draw.item->map && !draw.item->nodeTextures) || !probesOf(*draw.program).fragmentPerDraw) continue;
            const MaterialTexture* map = draw.item->map ? materialTexture(*draw.item->map) : nullptr;
            const WGPUTextureView mapView = map ? map->view : nullptr;
            const WGPUSampler mapSampler = map ? map->sampler : nullptr;
            const std::string key = "depth|" + std::to_string(reinterpret_cast<uintptr_t>(draw.program)) + "|" +
                                    std::to_string(reinterpret_cast<uintptr_t>(mapView)) + "|" +
                                    std::to_string(reinterpret_cast<uintptr_t>(mapSampler)) + graphKeyOf(*draw.item);
            const auto found = mapGroups_.find(key);
            draw.mapGroup = found != mapGroups_.end() ? found->second
                : mapGroups_.emplace(key, bindGroup(draw.program->layouts[1], draw.program->fragment, uniformBuffer_,
                                                    lutView_, lutSampler_, mapView, mapSampler, nullptr, nullptr, nullptr,
                                                    nullptr, nullptr, nullptr, nullptr, nullptr, draw.item->nodeTextures))
                      .first->second;
        }
    const uint64_t groupsChosenAt = groupEpoch_;
    for (const auto& [index, pipeline] : responsiveDraws) {
        Planned responsive = plan[index];
        responsive.pipeline = pipeline;
        velocityPlan.push_back(responsive);
    }

    planAux();

    if (!compilation && gpuJoints_ && (!gpuJoints_->drawUse.empty() || Object3D::poseObserver)) {
        const auto mark = [](const Planned& p) {
            const auto& item = *p.item;
            if (!item.gpuJoints || !item.instanceCount) return;
            auto& use = item.gpuJoints->drawUse;
            const auto markRig = [&](uint32_t rig) {
                if (!use.empty()) use.at(rig) = 1;
                if (Object3D::poseObserver) {
                    const auto& topology = item.gpuJoints->topology.at(rig);
                    for (uint32_t i = 0; i < topology.count; ++i)
                        if (const auto bone = item.gpuJoints->bones.at(topology.inputBase + i).lock()) Object3D::poseObserver(*bone, 2);
                }
            };
            if (item.gpuJointRigs.empty()) markRig(item.gpuJointRig);
            else for (const auto rig : item.gpuJointRigs) markRig(rig);
        };
        for (const auto& p : plan) mark(p);
        for (const auto& pass : shadowPasses) for (const auto& p : pass.draws) mark(p);
    }

    // The draws' stores are synced here, with the game thread's view of them: encodeFrame resolves
    // handles from the cache and never reads a store, which JavaScript may write meanwhile (PRD-613).
    // The main plan's six stores sync below, with the bundle key; the shadow draws' sync here, and any
    // store beyond the six only when the draw's program names it, so nothing unused is uploaded.
    const auto syncSix = [&](const DrawItem& item) {
        for (BufferStore* store : {item.positions, item.normals, item.uvs, item.indices, item.skinIndices, item.skinWeights})
            if (store) geometry_->cache.sync(*store, store == item.indices ? WGPUBufferUsage_Index : WGPUBufferUsage_Vertex);
    };
    const auto syncNamed = [&](const Planned& p) {
        const DrawItem& item = *p.item;
        // A GPU-filled indirect record (PRD-857) is a storage buffer the draw also reads as indirect args.
        if (item.indirect) geometry_->cache.sync(*item.indirect, WGPUBufferUsage_Indirect);
        if (!item.colors && !item.instanceMatrices && !item.instanceColors && item.attributes->empty()) return;
        for (const shader::VertexAttribute& a : p.program->vertex.attributes)
            if (BufferStore* source = vertexSourceOf(item, a)) geometry_->cache.sync(*source, WGPUBufferUsage_Vertex);
    };
    for (const Planned& p : plan) syncNamed(p);
    for (const ShadowPass& pass : shadowPasses)
        for (const Planned& p : pass.draws) {
            syncSix(*p.item);
            syncNamed(p);
        }
    // A bundle references buffers and offsets, not their contents. Matrix, colour, camera and
    // light writes therefore leave it valid; changed draw order, resources or counts rebuild it.
    // The aux and velocity passes replay their draws the same way, each from its own key.
    const auto bundleKeyOf = [&](const std::vector<Planned>& draws, std::vector<uint64_t>& key, std::vector<uint32_t>* rows = nullptr) {
        key.clear();
        if (rows) rows->clear();
        for (const Planned& p : draws) {
            if (rows) rows->push_back(static_cast<uint32_t>(key.size()));
            const DrawItem& item = *p.item;
            key.insert(key.end(), {reinterpret_cast<uintptr_t>(p.pipeline),
                reinterpret_cast<uintptr_t>(p.vertexGroup ? p.vertexGroup : p.program->groups[0]),
                reinterpret_cast<uintptr_t>(p.mapGroup ? p.mapGroup : p.program->groups[1]),
                p.vertexOffset, p.fragmentOffset, item.instanceCount});
            const auto appendStore = [&](BufferStore* store) {
                const Handle handle = store ? geometry_->cache.sync(*store,
                    store == item.indices ? WGPUBufferUsage_Index : WGPUBufferUsage_Vertex) : Handle{};
                key.insert(key.end(), {handle.type, handle.context, handle.index, handle.generation,
                    store ? store->byteLength() : 0, store ? static_cast<uintptr_t>(store->scalar()) : 0});
            };
            appendStore(item.indices);
            for (const auto& attribute : p.program->vertex.attributes) appendStore(vertexSourceOf(item, attribute));
            if (item.indirect) {
                const Handle handle = geometry_->cache.sync(*item.indirect, WGPUBufferUsage_Indirect);
                key.insert(key.end(), {handle.type, handle.context, handle.index, handle.generation, item.indirectOffset});
            }
        }
    };
    bundleKeyOf(plan, job.bundleKey, &job.bundleRows);
    std::vector<uint32_t> auxKeyRows, velocityKeyRows;
    bundleKeyOf(job.auxPlan, job.auxKey, &auxKeyRows);
    bundleKeyOf(velocityPlan, job.velocityKey, &velocityKeyRows);
    job.velocityKey.push_back(0);  // a trailing word, as the main (split) and aux (mask and slots) keys have
    job.shadowKeys.resize(features().stablePasses ? shadowPasses.size() : 0);
    for (std::size_t k = 0; k < job.shadowKeys.size(); ++k) bundleKeyOf(shadowPasses[k].draws, job.shadowKeys[k]);
    // The pass's own layout: its named targets and its custom MRT slots, so a frame that adds a slot records
    // a bundle for the wider pass even when no row changed (aux_bundle_key.h).
    appendAuxBundleKey(job.auxKey, auxMask, mrtSlots.size());
    job.bundleKey.push_back(static_cast<std::size_t>(
        std::find_if(plan.begin(), plan.end(), [&](const Planned& p) { return probesOf(*p.program).viewport; }) -
        plan.begin()));
    // PRD-754: a pass as retained rows (UE 5.8.3: Engine/Source/Runtime/Renderer/Private/MeshDrawCommands.cpp keeps
    // cached draw commands across frames; only the visible set and instance counts change). A draw out of view keeps its
    // row with no instances, drawn through an indirect record, so the bundle holds while the visible set changes. Used
    // while every opaque draw is order-free; `split` ends the rows (the main pass's viewport copy).
    // `keyTail` is how many words of `key` the pass itself appends after the last draw's (the main key's split
    // index, the aux key's mask and custom-slot count, the velocity key's zero): a row's words are its draw's,
    // never the pass layout's, or a layout word shifts every row's span and the rows churn on a static scene.
    const auto retainRows = [&](MainRows& retained, const std::vector<Planned>& draws, std::vector<uint64_t>& key,
                                std::vector<uint32_t>& keyRows, std::size_t split, std::size_t keyTail, PassRows& out) {
        out = PassRows{};
        out.on = true;
        const double rowsStarted = meterMs();  // the rows are recording work: the meter counts them
        const uint64_t destroys = GpuResources::destroyRequests.load(std::memory_order_relaxed);
        const bool destroyed = destroys != retained.destroys;
        retained.destroys = destroys;
        // The same per-draw key word for word, instance counts too: no row, record or indirect count moves. The row
        // clock stands still, so a frame that changes nothing ages no row either.
        if (!destroyed && retained.ordered && key == retained.planKey && keyRows == retained.planRows) {
            out = retained.last;
            key = {retained.generation, reinterpret_cast<uintptr_t>(out.indirect)};
            keyRows = {0};
            out.ms = meterMs() - rowsStarted;
            return;
        }
        ++retained.frame;
        // A draw resolves its row only when its key row changed (instances aside); the bundle's rows are rebuilt,
        // and the bundle re-recorded, only when a row changed, came or went.
        const auto words = [&](std::size_t k) {
            const auto end = k + 1 < draws.size() ? keyRows[k + 1] : key.size() - keyTail;
            return std::span<const uint64_t>(key.data() + keyRows[k], end - keyRows[k]);
        };
        const auto same = [](const std::vector<uint64_t>& was, std::span<const uint64_t> now) {
            if (was.size() != now.size()) return false;
            for (std::size_t w = 0; w < now.size(); ++w)
                if (w != 5 && was[w] != now[w]) return false;  // word 5 is the instance count: the indirect record's
            return true;
        };
        const auto countOf = [&](const DrawItem& item) {
            if (!item.indices) return static_cast<uint32_t>(geometry_->cache.resolved(*item.positions).bytes / 12);
            const auto indices = geometry_->cache.resolved(*item.indices);
            return static_cast<uint32_t>(indices.bytes / (indices.scalar == Scalar::U32 ? 4 : 2));
        };
        const auto fill = [&](MainRow& row, const Planned& p) {
            const DrawItem& item = *p.item;
            row.pipeline = p.pipeline;
            row.vertexGroup = p.vertexGroup ? p.vertexGroup : p.program->groups[0];
            if (row.vertexGroup == nullptr && !p.program->vertex.bindings.empty())
                throw std::runtime_error("TN_NATIVE_BINDING_NULL: active draw has no vertex bind group");
            row.mapGroup = p.mapGroup ? p.mapGroup : p.program->groups[1];
            if (row.mapGroup == nullptr && !p.program->fragment.bindings.empty())
                throw std::runtime_error("TN_NATIVE_BINDING_NULL: active draw has no fragment bind group");
            row.vertexOffset = p.vertexOffset; row.fragmentOffset = p.fragmentOffset;
            row.fragmentBlock = p.program->fragment.uniformBlockSize != 0;
            row.vertex.clear();
            // Slots as the encode loop counts them: the mat4's four columns share one.
            uint32_t slot = 0;
            const auto& vertexAttributes = p.program->vertex.attributes;
            for (size_t i = 0; i < vertexAttributes.size(); ++i) {
                const shader::VertexAttribute& a = vertexAttributes[i];
                if (shader::sharesMatrixSlot(vertexAttributes, i)) continue;
                BufferStore* source = vertexSourceOf(item, a);
                if (!source) throw std::runtime_error("TN_NATIVE_ATTRIBUTE_MISSING: " + a.name);
                const auto resolved = geometry_->cache.resolved(*source);
                row.vertex.push_back({slot++, geometry_->gpu.buffer(resolved.buffer), 0, resolved.bytes});
            }
            row.indirect = item.indirect ? geometry_->gpu.buffer(geometry_->cache.resolved(*item.indirect).buffer) : nullptr;
            row.indirectOffset = item.indirectOffset;
            row.index = nullptr;
            if (item.indices) {
                const auto indices = geometry_->cache.resolved(*item.indices);
                const bool wide = indices.scalar == Scalar::U32;
                row.index = geometry_->gpu.buffer(indices.buffer);
                row.indexFormat = wide ? WGPUIndexFormat_Uint32 : WGPUIndexFormat_Uint16;
                row.indexSize = (indices.bytes + 3) & ~uint64_t{3};
                row.count = static_cast<uint32_t>(indices.bytes / (wide ? 4 : 2));
            } else {
                row.count = static_cast<uint32_t>(geometry_->cache.resolved(*item.positions).bytes / 12);
            }
        };
        bool changed = false;
        const auto sameDraws = [&] {
            const auto& was = retained.planKey;
            if (!retained.ordered || was.size() != key.size() || retained.planRows != keyRows) return false;
            for (std::size_t k = 0; k < keyRows.size(); ++k) {
                const std::size_t from = keyRows[k], to = k + 1 < keyRows.size() ? keyRows[k + 1] : key.size() - keyTail;
                if (!std::equal(key.begin() + from, key.begin() + from + 5, was.begin() + from) ||
                    !std::equal(key.begin() + from + 6, key.begin() + to, was.begin() + from + 6)) return false;
            }
            return true;
        };
        const bool quiet = !destroyed && sameDraws();
        std::size_t looseAt = 0, afterAt = 0;
        const std::size_t rowsBefore = retained.rows.size();
        bool appended = true;  // the only change is rows first seen this frame
        if (quiet) for (std::size_t k = 0; k < draws.size(); ++k) {
            const DrawItem& item = *draws[k].item;
            MainRow& row = retained.at(retained.planSource[k]);
            row.instances = item.instanceCount;
            row.seen = retained.frame;
            ++out.draws;
            out.triangles += uint64_t{item.instanceCount} * (row.count / 3);
            if (item.boneMatrices) {
                ++out.skinned.draws;
                if (item.boneStride) { ++out.skinned.batches; out.skinned.instances += item.instanceCount; }
                else ++out.skinned.exactDraws;
            }
        }
        if (!quiet) {
            retained.lastSource.swap(retained.planSource);
            retained.planSource.assign(draws.size(), 0);
        }
        if (!quiet) for (std::size_t k = 0; k < draws.size(); ++k) {
            const Planned& p = draws[k];
            const DrawItem& item = *p.item;
            MainRow* row = nullptr;
            bool fresh = false;
            const bool tail = k >= split;
            if (tail) {  // counted here, recorded by the tail or viewport bundle
                if (afterAt == retained.after.size()) { retained.after.emplace_back(); fresh = true; }
                retained.planSource[k] = MainRows::kAfter | uint32_t(afterAt);
                row = &retained.after[afterAt++];
            } else if (p.slot) {
                // Last frame's row for this plan place when it is this draw's, else the slot's row.
                const uint32_t last = k < retained.lastSource.size() ? retained.lastSource[k] : MainRows::kLoose;
                uint32_t at = last;
                bool added = false;
                if (last & (MainRows::kLoose | MainRows::kAfter) || last >= retained.rows.size() ||
                    retained.rows[last].slot != p.slot) {
                    const auto found = retained.index.try_emplace(p.slot, uint32_t(retained.rows.size()));
                    added = found.second;
                    if (added) retained.rows.emplace_back();
                    at = found.first->second;
                }
                retained.planSource[k] = at;
                row = &retained.rows[at];
                fresh = added;
            } else {
                if (looseAt == retained.loose.size()) { retained.loose.emplace_back(); fresh = true; appended = false; }
                retained.planSource[k] = MainRows::kLoose | uint32_t(looseAt);
                row = &retained.loose[looseAt++];
            }
            const auto own = words(k);
            if (fresh || !same(row->words, own)) {
                if (tail) row->count = countOf(item);  // its bundle has its own key: only three's Info reads the row
                else fill(*row, p);
                row->words.assign(own.begin(), own.end());
                changed |= !tail;
                appended &= tail || (fresh && p.slot);
            }
            if (!tail) {
                const auto before = row->order();
                row->background = item.background; row->transparent = item.transparent; row->renderOrder = item.renderOrder;
                row->kind = item.kind; row->side = item.side; row->material = reinterpret_cast<uintptr_t>(item.material);
                row->positions = reinterpret_cast<uintptr_t>(item.positions); row->indices = reinterpret_cast<uintptr_t>(item.indices);
                row->id = item.key; row->slot = p.slot;
                if (row->order() != before) {
                    changed = true;
                    appended &= fresh && p.slot != 0;
                }
            }
            row->instances = item.instanceCount;
            row->seen = retained.frame;
            // three's Info.update, as encode counts a recorded draw
            ++out.draws;
            out.triangles += uint64_t{item.instanceCount} * (row->count / 3);
            if (item.boneMatrices) {
                ++out.skinned.draws;
                if (item.boneStride) { ++out.skinned.batches; out.skinned.instances += item.instanceCount; }
                else ++out.skinned.exactDraws;
            }
        }
        if (!quiet) {
            if (looseAt != retained.loose.size()) { retained.loose.resize(looseAt); changed = true; appended = false; }
            retained.after.resize(afterAt);
        }
        retained.planKey = key;
        retained.planRows = keyRows;
        // A row out of view keeps its place with no instances, until it ages out or any GPU resource is destroyed.
        bool moved = false;
        if (!quiet) for (uint32_t i = 0; i < retained.rows.size();) {
            MainRow& row = retained.rows[i];
            if (row.seen == retained.frame) { ++i; continue; }
            if (destroyed || retained.frame - row.seen > kSlotFrames) {
                const uint64_t gone = row.slot;
                if (i + 1 != retained.rows.size()) {
                    row = std::move(retained.rows.back());
                    retained.index[row.slot] = i;
                    moved = true;
                }
                retained.rows.pop_back();
                retained.index.erase(gone);
                changed = true;
                appended = false;
                continue;
            }
            row.instances = 0;
            ++i;
        }
        if (moved)  // a kept row took an evicted row's place
            for (std::size_t k = 0; k < split; ++k)
                if (!(retained.planSource[k] & (MainRows::kLoose | MainRows::kAfter)))
                    retained.planSource[k] = retained.index.at(draws[k].slot);
        const std::size_t recordedRows = retained.ordered ? retained.ordered->size() : 0;
        const auto snapshot = [&](MainRow& row, std::vector<MainRow>& to) {
            auto words = std::move(row.words);  // the snapshot only records commands
            to.push_back(row);
            row.words = std::move(words);
        };
        // Rows first seen this frame follow the kept ones, so the kept rows' bundle records nothing (UE 5.8.3 caches a
        // mesh draw command when its primitive is added). A full sort waits until they outgrow a quarter of the rows.
        const std::size_t fresh = retained.rows.size() - rowsBefore;
        if (changed && appended && retained.ordered && fresh &&
            recordedRows + fresh - retained.sorted <= std::max<std::size_t>(8, retained.sorted / 4)) {
            const auto first = retained.source.size();
            for (uint32_t i = uint32_t(rowsBefore); i < retained.rows.size(); ++i) retained.source.push_back(i);
            std::sort(retained.source.begin() + std::ptrdiff_t(first), retained.source.end(),
                      [&](uint32_t a, uint32_t b) { return retained.rows[a].order() < retained.rows[b].order(); });
            auto ordered = std::make_shared<std::vector<MainRow>>(*retained.ordered);
            for (std::size_t at = first; at < retained.source.size(); ++at) snapshot(retained.rows[retained.source[at]], *ordered);
            retained.ordered = std::move(ordered);
            out.cause = RecordCount;
        } else if (changed || !retained.ordered) {
            std::vector<uint32_t>& source = retained.source;
            source.clear();
            for (uint32_t i = 0; i < retained.rows.size(); ++i) source.push_back(i);
            for (uint32_t i = 0; i < retained.loose.size(); ++i) source.push_back(MainRows::kLoose | i);
            const auto rowOf = [&](uint32_t at) -> const MainRow& {
                return at & MainRows::kLoose ? retained.loose[at & ~MainRows::kLoose] : retained.rows[at];
            };
            std::sort(source.begin(), source.end(), [&](uint32_t a, uint32_t b) { return rowOf(a).order() < rowOf(b).order(); });
            auto ordered = std::make_shared<std::vector<MainRow>>();
            ordered->reserve(source.size());
            for (uint32_t at : source) snapshot(retained.at(at), *ordered);
            retained.ordered = std::move(ordered);
            retained.sorted = source.size();
            ++retained.generation;
            out.cause = retained.ordered->size() != recordedRows ? RecordCount : RecordOther;
        } else {
            out.cause = RecordNone;
        }
        out.rows = retained.ordered;
        // One indirect record per row: count, instances, then zero first index, base vertex and first instance.
        std::vector<uint32_t>& args = retained.args;
        bool uploaded = args.size() == retained.source.size() * 5;  // the GPU copy already holds these records
        if (!uploaded) args.assign(retained.source.size() * 5, 0);
        for (std::size_t at = 0; at < retained.source.size(); ++at) {
            const uint32_t from = retained.source[at];
            const MainRow& row = from & MainRows::kLoose ? retained.loose[from & ~MainRows::kLoose] : retained.rows[from];
            uploaded = uploaded && args[at * 5] == row.count && args[at * 5 + 1] == row.instances;
            args[at * 5] = row.count;
            args[at * 5 + 1] = row.instances;
        }
        const uint64_t bytes = std::max<uint64_t>(args.size() * 4, 20);
        if (bytes > retained.capacity) {
            if (retained.capacity) gpu_.destroy(retained.indirect);
            retained.capacity = std::max<uint64_t>(bytes * 2, 4096);
            retained.indirect = gpu_.createBuffer(retained.capacity, WGPUBufferUsage_Indirect | WGPUBufferUsage_CopyDst);
            uploaded = false;
        }
        out.indirect = gpu_.buffer(retained.indirect);
        if (!args.empty() && !uploaded) gpu_.writeBuffer(retained.indirect, 0, args.data(), args.size() * 4);
        // The key: which rows the bundle draws, and the indirect buffer it reads their counts from.
        key = {retained.generation, reinterpret_cast<uintptr_t>(out.indirect)};
        keyRows = {0};
        out.sorted = retained.sorted;
        out.deltaKey = {retained.generation, retained.ordered->size(), reinterpret_cast<uintptr_t>(out.indirect)};
        retained.last = out;
        retained.last.cause = RecordNone;
        out.ms = meterMs() - rowsStarted;
    };
    if (features().stableRows)
        for (auto* rows : {&mainRows_, &auxRows_, &velocityRows_})
            if (!*rows) *rows = std::make_unique<MainRows>();
    job.mainRows = job.auxRows = job.velocityRows = PassRows{};
    if (features().stablePasses && features().stableRows && !compilation &&
        std::all_of(plan.begin(), plan.end(), [](const Planned& p) {
            const DrawItem& i = *p.item;
            return i.transparent || i.background || (i.depthWrite && i.depthTest && i.colorWrite);
        })) {
        // The draws after the viewport copy record their own bundle, keyed by their rows of the per-draw key.
        // The transparent draws record their own bundle too: their depth order moves with every camera turn, and keeping them
        // as rows cost more than recording them (608 of the web shooter's 717 draws).
        const std::size_t split = job.bundleKey.back();
        job.tail = std::min<std::size_t>(split, std::find_if(plan.begin(), plan.end(), [](const Planned& p) {
                                                   return p.item->transparent;
                                               }) - plan.begin());
        const auto rowOf = [&](std::size_t k) { return k < plan.size() ? job.bundleRows[k] : job.bundleKey.size() - 1; };
        job.viewportKey.assign(job.bundleKey.begin() + rowOf(split), job.bundleKey.end() - 1);
        job.tailKey.assign(job.bundleKey.begin() + rowOf(job.tail), job.bundleKey.begin() + rowOf(split));
        retainRows(*mainRows_, plan, job.bundleKey, job.bundleRows, job.tail, 1, job.mainRows);
        const std::size_t auxKeyTail = kAuxBundleKeyWords;  // the aux key's mask and custom-slot count
        // The aux and velocity passes' transparent draws record their own bundle too, as the main pass's do.
        const auto retainTail = [&](MainRows& retained, const std::vector<Planned>& draws, std::vector<uint64_t>& key,
                                    std::vector<uint32_t>& keyRows, std::size_t keyTail, PassRows& out) {
            const std::size_t tail = std::find_if(draws.begin(), draws.end(), [](const Planned& p) {
                return p.item->transparent;
            }) - draws.begin();
            std::vector<uint64_t> tailKey(key.begin() + (tail < draws.size() ? keyRows[tail] : key.size() - keyTail),
                                          key.end() - keyTail);
            retainRows(retained, draws, key, keyRows, tail, keyTail, out);
            out.tail = tail;
            out.tailKey = std::move(tailKey);
        };
        retainTail(*auxRows_, job.auxPlan, job.auxKey, auxKeyRows, auxKeyTail, job.auxRows);
        retainTail(*velocityRows_, velocityPlan, job.velocityKey, velocityKeyRows, 1, job.velocityRows);
    } else if (features().stableRows) {
        for (auto* rows : {&mainRows_, &auxRows_, &velocityRows_})
            if (*rows) (*rows)->clear();  // the next record may release what they hold
    }
    // A post pass's resolution scale and uniform nodes are the game's to write: read them now, encode uses the copy.
    if (postEffects_ && postEffects_->syncScales()) releaseOutputGroup();
    for (const auto& target : rttTargets_) {
        auto& state = *target.state;
        if (postEffects_->target(target.name, renderTargetView(*this, *state.target)))
            releaseOutputGroup();
    }

    if (postEffects_) postEffects_->captureUniforms();
    // Upload authored LUT textures while the game thread is idle, as for live uniforms.
    const bool newTextures = postTextureVersions_.size() != postTextures_.size();
    postTextureVersions_.resize(postTextures_.size());
    postTextureViews_.resize(postTextures_.size());
    for (size_t i = 0; i < postTextures_.size(); ++i) {
        const auto& [name, source] = postTextures_[i];
        const auto* texture = materialTexture(*source);
        if (newTextures || postTextureVersions_[i] != source->version() || postTextureViews_[i] != texture->view) releaseOutputGroup();
        postTextureVersions_[i] = source->version();
        postTextureViews_[i] = texture->view;
        if (postEffects_) postEffects_->input(name, texture->view, texture->sampler);
    }
    if (!postTextures_.empty() && !outputGroup_)
        outputGroup_ = bindGroup(outputLayout_, outputFragment_, outputUniforms_, postScene(), outputSampler_,
            nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, &postTextures_, &outputGroups_);
    if (post_)
        for (const auto& node : post_->live) postUniforms_[node->name] = node->values;
    for (const auto& node : shader::graph::uniformNodes(output_.customToneMapping)) postUniforms_[node->name] = node->values;
    for (const auto& field : outputFragment_.uniforms) {
        constexpr std::string_view prefix = "authoredLightShadowMatrix";
        if (field.name.starts_with(prefix)) {
            const auto& matrix = lights.shadowMatrix(std::stoull(field.name.substr(prefix.size())));
            postUniforms_[field.name] = std::vector<double>(matrix.begin(), matrix.end());
        }
    }
    postUniforms_["cameraNear"] = {static_cast<float>(camera.near)};
    postUniforms_["cameraFar"] = {static_cast<float>(camera.far)};
    job.encoder = encoder;
    job.color = color;
    job.depth = depth;
    job.timed = timed;
    job.debugTimestampRequested = debugTimestampRequested_;
    job.source = sourceFrame_;
    job.groupEpoch = groupsChosenAt;
    job.auxMask = auxMask;
    job.translucentActive = translucentPass;
    // At 4x the velocity pass draws into a multisampled attachment and resolves it; allocated on first
    // use, so a frame without it pays nothing.
    if (sampleCount_ == 4 && traa_ && !msaaAuxColor_) {
        WGPUTextureDescriptor desc = {};
        desc.dimension = WGPUTextureDimension_2D; desc.size = {inputWidth_, inputHeight_, 1};
        desc.format = WGPUTextureFormat_RGBA16Float; desc.mipLevelCount = 1; desc.sampleCount = 4;
        desc.usage = WGPUTextureUsage_RenderAttachment;
        msaaAuxColor_ = wgpuDeviceCreateTexture(device_, &desc);
        msaaAuxColorView_ = view2d(msaaAuxColor_, WGPUTextureFormat_RGBA16Float);
    }
    job.camera = camera; job.lights = lights;
    job.pageClear = pageClear;
    job.presentTarget = presentTarget;
    job.presentFormat = presentFormat;
    pendingEncode_ = true;
    addCpuStage(CpuPrepare, prepareStarted);
    if (defer) return id;
    encodePending();
    return id;
}

}  // namespace tn::engine
