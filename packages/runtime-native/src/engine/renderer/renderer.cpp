// The renderer: construction, child renderers, GPU joints, draw order, render() and the frame's encode. PRD-840 split renderer.cpp by concern; renderer_internal.h holds what they share.
#include "engine/renderer/renderer_internal.h"

namespace tn::engine {

const std::pair<Box3, double>& DrawCache::virtualShadowBounds(const DrawItem& item) {
    // A positionNode displaces on the GPU only: this box is the bind pose either way, so it caches like a rigid
    // draw. Rebuilding it each frame walked every instance of a swaying forest (218k) for 40 ms of plan time.
    const bool cacheable = !item.boneMatrices && !item.morphGeometry && !item.gpuJoints;
    const BufferStore* instances = item.instanceMatrices;
    // A displaced caster's boxes grow by the farthest its positionNode moves a vertex (UE 5.8.3:
    // Engine/Source/Runtime/Engine/Private/InstancedStaticMesh/ISMInstanceDataManager.cpp:490 adds the material's
    // MaxWorldPositionOffsetDisplacement to every instance's bounds).
    const double margin = item.material && (item.positionNode || item.nodes->shadowPositionNode()) ? item.material->maxPositionOffset : 0;
    const bool stated = displacedByGeometryBox(item);
    const Box3 none;
    const Box3& box = stated ? *item.geometryBox : none;
    const ShadowBoundsKey key{item.positions, item.positions->version(), item.positions->epoch(), item.positions->writes(),
                             instances, instances ? instances->version() : 0, instances ? instances->epoch() : 0,
                             instances ? instances->writes() : 0, item.instanceCount, item.matrixWorld, margin,
                             stated ? std::array<double, 6>{box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z}
                                    : std::array<double, 6>{}};
    // A released store's address can be reused with the same revisions.
    if (cacheable && shadowBoundsKey == key && !shadowPositionsOwner.expired() &&
        (!instances || !shadowInstancesOwner.expired())) return shadowBounds;
    ++shadowBoundsBuilds;
    shadowInstanceBoxes.clear();
    Box3 bounds;
    // A rig's box comes from its bones (O(bones)); skinning each vertex on the CPU here cost the
    // stress lab's 120-rig crowd about 760 ms a frame.
    const auto* rig = item.boneMatrices && !item.morphGeometry && item.shadowObject && item.shadowObject->type() == "SkinnedMesh"
        ? static_cast<const SkinnedMesh*>(item.shadowObject) : nullptr;
    if (stated) {
        bounds = box;  // where the author says the positionNode puts the vertices
    } else if (rig && rig->boneReachBounds(bounds)) {
    } else if (item.morphGeometry && !item.boneMatrices) {
        // three bounds a morphed mesh by computeBoundingBox, which takes every target's reach and no influence;
        // morphing each vertex on the CPU here, every frame, cost the MCP forest about 6 % of its CPU.
        bounds = item.morphGeometry->morphReachBox();
    } else if (item.positions->scalar() == Scalar::F32) {
        for (uint64_t idx = 0; idx + 2 < item.positions->count(); idx += 3) {
            float p[3]; item.positions->read(idx * 4, p, sizeof(p));
            Vector3 vertex(p[0], p[1], p[2]);
            if ((item.boneMatrices || item.morphGeometry) && item.shadowObject) {
                const auto* mesh = dynamic_cast<const Mesh*>(item.shadowObject);
                if (mesh) mesh->getVertexPosition(idx / 3, vertex);
            }
            bounds.expandByPoint(vertex);
        }
    }
    Matrix4 model; model.elements = item.matrixWorld;
    const double localDiameter = bounds.min.distanceTo(bounds.max);
    double reach = margin * model.getMaxScaleOnAxis();
    double diameter = localDiameter * model.getMaxScaleOnAxis();
    if (item.instanceMatrices) {
        Box3 instances;
        diameter = 0;
        reach = 0;
        const auto* matrices = reinterpret_cast<const float*>(static_cast<const BufferStore&>(*item.instanceMatrices).data());
        // FG1: a geometry with no vertices has no box to place an instance by; the draw keeps one box for all.
        const bool perInstance = !bounds.isEmpty();
        if (perInstance) shadowInstanceBoxes.reserve(item.instanceCount);
        for (uint32_t instance = 0; instance < item.instanceCount; ++instance) {
            Matrix4 transform;
            for (int e = 0; e < 16; ++e) transform.elements[e] = matrices[instance * 16 + e];
            Box3 box = bounds; box.applyMatrix4(transform);
            instances.unionWith(box);
            transform.premultiply(model);
            diameter = std::max(diameter, localDiameter * transform.getMaxScaleOnAxis());
            // The offset is in the geometry's own units, so each instance's reach is the margin at its scale.
            const double instanceReach = margin * transform.getMaxScaleOnAxis();
            reach = std::max(reach, instanceReach);
            if (perInstance) shadowInstanceBoxes.push_back(Box3(bounds).applyMatrix4(transform).expandByScalar(instanceReach));
        }
        bounds = instances;
    }
    bounds.applyMatrix4(model);
    if (!bounds.isEmpty()) bounds.expandByScalar(reach);
    shadowBounds = {bounds, diameter};
    shadowBoundsKey = cacheable ? std::optional<ShadowBoundsKey>(key) : std::nullopt;
    shadowPositionsOwner = item.positions->weak_from_this();
    shadowInstancesOwner = instances ? instances->weak_from_this() : std::weak_ptr<const BufferStore>{};
    return shadowBounds;
}

Renderer::Renderer(WGPUInstance instance, WGPUDevice device, WGPUQueue queue, EventQueue& events,
                   RenderFeatures features)
    : instance_(instance), device_(device), queue_(queue), events_(events), gpu_(instance, device, queue, events, 1), geometry_(std::make_shared<GeometryCopies>(instance, device, queue, events)), pipelines_(std::make_shared<PipelineCache>(device)), layouts_(std::make_shared<PipelineLayoutCache>(device)), retired_(TextureId::watch()) {
    features_ = checkedRenderFeatures(features);
    geometry_->gpu.shareSubmissions(gpu_);
    // The block format the glTF loader transcodes KTX2 to (PRD-867): BC7 where the device samples it, else
    // ETC2, else none, and the loader keeps RGBA8 by name. ASTC waits for its transcoder tables.
    compressedTextureTarget() = wgpuDeviceHasFeature(device, WGPUFeatureName_TextureCompressionBC) ? kTextureBC7Format
                              : wgpuDeviceHasFeature(device, WGPUFeatureName_TextureCompressionETC2) ? kTextureETC2RGBAFormat
                                                                                                      : uint16_t{0};
    // The DFG lookup the standard BRDF samples: three's 16x16 RG half-float table, linear filtered.
    WGPUTextureDescriptor lutDesc = {};
    lutDesc.dimension = WGPUTextureDimension_2D;
    lutDesc.size = {shader::kDfgLutSize, shader::kDfgLutSize, 1};
    lutDesc.format = WGPUTextureFormat_RG16Float;
    lutDesc.usage = WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst;
    lutDesc.mipLevelCount = 1;
    lutDesc.sampleCount = 1;
    lut_ = wgpuDeviceCreateTexture(device, &lutDesc);
    WGPUImageCopyTexture_Compat dst = {};
    dst.texture = lut_;
    dst.aspect = WGPUTextureAspect_All;
    WGPUTextureDataLayout_Compat layout = {};
    layout.bytesPerRow = shader::kDfgLutSize * 4;
    layout.rowsPerImage = shader::kDfgLutSize;
    const WGPUExtent3D extent = {shader::kDfgLutSize, shader::kDfgLutSize, 1};
    wgpuQueueWriteTexture(queue, &dst, shader::kDfgLut, sizeof shader::kDfgLut, &layout, &extent);
    lutView_ = wgpuTextureCreateView(lut_, nullptr);
    WGPUSamplerDescriptor sampler = {};
    sampler.magFilter = WGPUFilterMode_Linear;
    sampler.minFilter = WGPUFilterMode_Linear;
    sampler.addressModeU = sampler.addressModeV = sampler.addressModeW = WGPUAddressMode_ClampToEdge;
    sampler.maxAnisotropy = 1;
    lutSampler_ = wgpuDeviceCreateSampler(device, &sampler);
    sampler.compare = WGPUCompareFunction_LessEqual;
    compareSampler_ = wgpuDeviceCreateSampler(device, &sampler);
    sampler.compare = WGPUCompareFunction_Undefined;
    sampler.magFilter = sampler.minFilter = WGPUFilterMode_Nearest;
    depthValueSampler_ = wgpuDeviceCreateSampler(device, &sampler);

    // One triangle covers the frame; the output pass samples the scene target texel for texel.
    const float triangle[6] = {-1, -1, 3, -1, -1, 3};
    outputTriangle_ = gpu_.createBuffer(sizeof triangle, WGPUBufferUsage_Vertex | WGPUBufferUsage_CopyDst);
    // traaPrevious_boneMatrices and traaPrevious_instances: the previous frame's palette and instances, copied after the
    // velocity pass.
    for (const char* name : {"boneMatrices", "morphData", "morphInfluences", "instances", "traaPrevious_boneMatrices",
                             "traaPrevious_instances"}) {
        FrameStorage& storage = storages_[name];
        storage.capacity = 64;
        storage.buffer = gpu_.createBuffer(storage.capacity,
            WGPUBufferUsage_Storage | WGPUBufferUsage_CopyDst | WGPUBufferUsage_CopySrc);
    }
    gpu_.writeBuffer(outputTriangle_, 0, triangle, sizeof triangle);
    outputUniforms_ = gpu_.createBuffer(16, WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst);
    WGPUSamplerDescriptor nearest = {};
    nearest.magFilter = WGPUFilterMode_Nearest;
    nearest.minFilter = WGPUFilterMode_Nearest;
    nearest.addressModeU = nearest.addressModeV = nearest.addressModeW = WGPUAddressMode_ClampToEdge;
    nearest.maxAnisotropy = 1;
    outputSampler_ = wgpuDeviceCreateSampler(device, &nearest);
    passTimer_ = std::make_shared<FrameGpuTimer>(device);
    setOutput(OutputState{});
    setSize(1, 1);
}

WGPUSampler Renderer::linearClampSampler() {
    if (!linearClampSampler_) {
        WGPUSamplerDescriptor linear = {};
        linear.addressModeU = linear.addressModeV = linear.addressModeW = WGPUAddressMode_ClampToEdge;
        linear.magFilter = linear.minFilter = WGPUFilterMode_Linear;
        linear.mipmapFilter = WGPUMipmapFilterMode_Nearest;
        linear.maxAnisotropy = 1;
        linear.lodMaxClamp = 32;
        linearClampSampler_ = wgpuDeviceCreateSampler(device_, &linear);
    }
    return linearClampSampler_;
}

Renderer& Renderer::probeCaptureRenderer() {
    if (!probeCapture_) {
        probeCapture_ = std::make_unique<Renderer>(instance_, device_, queue_, events_, features_);
        probeCapture_->passTimer_ = passTimer_;
        probeCapture_->ownsPassTimer_ = false;
        probeCapture_->layouts_ = layouts_;
        probeCapture_->pipelines_ = pipelines_;
    }
    return *probeCapture_;
}

Renderer& Renderer::reflectionRenderer(const std::shared_ptr<const void>& owner) {
    std::erase_if(mirrors_, [](const auto& entry) { return entry.second.first.expired(); });
    auto& mirror = mirrors_[owner.get()];
    if (!mirror.second) mirror = {owner, sibling()};
    return *mirror.second;
}

Renderer& Renderer::overlayRenderer() {
    if (!canvasLayer_) {
        canvasLayer_ = sibling();
        canvasLayer_->outputOver_ = true;
    }
    // UI composites after the tone curve: Unreal draws Slate onto the already tone-mapped back buffer
    // (UE 5.8.3: Engine/Source/Runtime/SlateRHIRenderer/Private/SlateRHIRenderer.cpp:986, :1032), so a
    // cover drawn in its CSS colour matches the page behind it. Only the output colour space stays.
    OutputState ui = output_;
    ui.toneMapping.reset();
    ui.toneMappingExposure = 1;
    ui.customToneMapping = {};
    canvasLayer_->setOutput(ui);
    canvasLayer_->setSize(width_, height_);
    return *canvasLayer_;
}

void GpuJointScene::revoke() {
    *valid = false;
    for (const auto& weak : bones) {
        ++Object3D::gpuMaintenanceVisits_;
        if (auto bone = weak.lock()) bone->prepareLocalTransformWrite();
    }
}

bool GpuJointScene::current() const {
    if (!*valid) { return false; }
    if (hierarchy != Object3D::hierarchyVersion()) { return false; }
    for (const auto& saved : rigs) {
        const auto rig = saved.mesh.lock();
        const auto placement = saved.placement.lock();
        if (rig) ++Object3D::gpuValidationVisits_;
        if (placement) ++Object3D::gpuValidationVisits_;
        if (!rig || !placement || rig->gpuBindExposed || !rig->attached ||
            rig->skeleton.get() != saved.skeleton || rig->geometry.get() != saved.geometry ||
            rig->material.get() != saved.material || rig->bindMatrix.elements != saved.bind ||
            rig->onBeforeRender) { return false; }
        if (!isSimilarityTransform(placement->matrixWorld.elements.data())) {
            return false;
        }
        if (!isSimilarityTransform(rig->matrixWorld.elements.data())) {
            return false;
        }
        if (!rig->matrixAutoUpdate || !rig->matrixWorldAutoUpdate || !rig->material ||
            rig->material->transparent || rig->material->nodeMaterial || rig->material->positionNode ||
            !rig->geometry->morphPositions.empty()) { return false; }
        for (const auto* node : rig->material->nodes.pointers()) if (node) {
            return false;
        }
        for (auto* ancestor = static_cast<Object3D*>(rig.get()); ancestor; ancestor = ancestor->parent) {
            ++Object3D::gpuValidationVisits_;
            if (!gpuJointAncestorEligible(*ancestor, *rig)) {
                return false;
            }
        }
    }
    return true;
}

bool Renderer::bindGpuJoints(const std::shared_ptr<GpuJointScene>& plan) {
    auto& output = storages_["boneMatrices"];
    const uint64_t required = plan->parents.size() * 64;
    if (output.capacity < required) {
        gpu_.destroy(output.buffer);
        output.capacity = required;
        output.buffer = gpu_.createBuffer(required, WGPUBufferUsage_Storage | WGPUBufferUsage_CopyDst | WGPUBufferUsage_CopySrc);
        if (uniformCapacity_) rebuildGroups();
    }
    if (gpuJoints_ != plan) {
        gpuJointPass_.reset();
        if (gpu_.buffer(gpuJointLocals_)) gpu_.destroy(gpuJointLocals_);
        gpuJointLocals_ = gpu_.createBuffer(plan->locals->size() * sizeof(float), WGPUBufferUsage_Storage | WGPUBufferUsage_CopyDst);
    }
    gpuJointPass_ = std::make_unique<JointComputePass>(device_, gpu_, plan->topology, plan->parents,
        plan->fixed, gpuJointLocals_, output.buffer);
    if (!gpuJointPass_->error().empty()) {
        plan->revoke(); gpuJointPass_.reset(); return false;
    }
    gpuJoints_ = plan;
    return true;
}

std::shared_ptr<GpuJointScene> Renderer::prepareGpuJoints(Object3D& scene, std::shared_ptr<GpuJointScene> shared) {
    if (shared && shared->current()) {
        if (gpuJoints_ == shared && gpuJointPass_) return shared;
        return bindGpuJoints(shared) ? shared : nullptr;
    }
    if (gpuJoints_ && gpuJointScene_ == &scene && gpuJoints_->current()) return gpuJoints_;
    if (gpuJoints_) { gpuJoints_->revoke(); gpuJoints_.reset(); gpuJointPass_.reset(); }
    const auto epoch = Object3D::hierarchyVersion();
    if (gpuJointScene_ == &scene && gpuJointScan_ == epoch) return nullptr;
    gpuJointScene_ = &scene; gpuJointScan_ = epoch;
    auto plan = std::make_shared<GpuJointScene>();
    plan->hierarchy = epoch;
    std::vector<SkinnedMesh*> candidates;
    scene.traverse([](Object3D& node, void* data) {
        ++Object3D::gpuMaintenanceVisits_;
        if (auto* rig = dynamic_cast<SkinnedMesh*>(&node)) static_cast<std::vector<SkinnedMesh*>*>(data)->push_back(rig);
    }, &candidates);
    std::unordered_map<const Skeleton*, size_t> skeletons;
    for (const auto* rig : candidates) { ++Object3D::gpuMaintenanceVisits_; ++skeletons[rig->skeleton.get()]; }
    for (auto* rig : candidates) {
        ++Object3D::gpuMaintenanceVisits_;
        auto* skeleton = rig->skeleton.get();
        if (!skeleton || skeleton->bones.empty() || skeleton->bones.size() != skeleton->boneInverses.size() ||
            rig->weak_from_this().expired() || rig->gpuBindExposed || !rig->attached || !rig->geometry ||
            !rig->geometry->morphPositions.empty() || !rig->material || rig->material->transparent ||
            rig->material->nodeMaterial || rig->material->positionNode || rig->onBeforeRender ||
            skeletons[skeleton] != 1) continue;
        bool eligible = true;
        for (const auto* node : rig->material->nodes.pointers()) if (node) eligible = false;
        for (auto* ancestor = static_cast<Object3D*>(rig); eligible && ancestor; ancestor = ancestor->parent) {
            ++Object3D::gpuMaintenanceVisits_;
            if (!gpuJointAncestorEligible(*ancestor, *rig)) {
                eligible = false;
            }
        }
        if (!eligible) continue;
        auto* placement = rig->parent;
        if (placement) ++Object3D::gpuMaintenanceVisits_;
        if (!placement || placement->type() == "Bone" || placement->type() == "Scene" ||
            placement->children.size() != 2 || placement->pivot)
            continue;
        std::unordered_map<const Bone*, uint32_t> indices;
        for (uint32_t i = 0; i < skeleton->bones.size(); ++i) {
            ++Object3D::gpuMaintenanceVisits_;
            auto* bone = skeleton->bone(i);
            if (!bone || !indices.emplace(bone, i).second) { eligible = false; break; }
        }
        std::vector<uint32_t> parents;
        uint32_t roots = 0;
        for (uint32_t i = 0; eligible && i < skeleton->bones.size(); ++i) {
            ++Object3D::gpuMaintenanceVisits_;
            auto* bone = skeleton->bone(i);
            const auto* flags = bone->ownTransformTracking();
            if (!flags || !flags[0] || flags[2] || !bone->matrixAutoUpdate || !bone->matrixWorldAutoUpdate || bone->pivot || bone->onBeforeRender)
                { eligible = false; break; }
            if (bone->parent == placement) { parents.push_back(UINT32_MAX); ++roots; }
            else {
                const auto parent = indices.find(dynamic_cast<Bone*>(bone->parent));
                if (parent == indices.end() || parent->second >= i) { eligible = false; break; }
                parents.push_back(parent->second);
            }
            for (auto* child : bone->children) {
                ++Object3D::gpuMaintenanceVisits_;
                if (!indices.count(dynamic_cast<Bone*>(child))) eligible = false;
            }
        }
        if (!eligible || roots != 1) continue;
        const uint32_t base = uint32_t(plan->parents.size());
        GpuJointScene::Rig saved;
        saved.mesh = std::static_pointer_cast<SkinnedMesh>(rig->shared_from_this());
        saved.placement = placement->weak_from_this(); saved.skeleton = skeleton;
        saved.geometry = rig->geometry.get(); saved.material = rig->material.get();
        saved.bind = rig->bindMatrix.elements; saved.outputBase = base;
        saved.instances = std::make_shared<BufferStore>(Scalar::F32, 16);
        plan->byMesh.emplace(rig, uint32_t(plan->rigs.size()));
        plan->rigs.push_back(std::move(saved));
        plan->topology.push_back({uint32_t(skeleton->bones.size()), base, base, base, base});
        plan->parents.insert(plan->parents.end(), parents.begin(), parents.end());
        for (uint32_t i = 0; i < skeleton->bones.size(); ++i) {
            ++Object3D::gpuMaintenanceVisits_;
            plan->bones.push_back(skeleton->bones[i]);
            Matrix4 folded; folded.multiplyMatrices(skeleton->boneInverses[i], rig->bindMatrix);
            std::array<float, 16> identity{}, inverseBind{};
            for (int k = 0; k < 16; ++k) { identity[k] = k % 5 == 0 ? 1 : 0; inverseBind[k] = float(folded.elements[k]); }
            plan->fixed.push_back(identity); plan->fixed.push_back(inverseBind);
        }
    }
    if (plan->rigs.empty()) return nullptr;
    plan->locals->resize(plan->parents.size() * 12);
    if (!plan->current() || !bindGpuJoints(plan)) return nullptr;
    // The successfully compiled GPU consumer exists before any hierarchy boundary is skipped.
    for (uint32_t i = 0; i < plan->bones.size(); ++i) {
        ++Object3D::gpuMaintenanceVisits_;
        auto bone = plan->bones[i].lock();
        if (!bone || !bone->enableDeferredTransform(plan->locals, i * 12, plan->valid)) { plan->revoke(); return nullptr; }
        bone->gpuJointBoundary = plan->valid; bone->gpuJointHierarchy = epoch;
    }
    for (const auto& saved : plan->rigs) if (auto rig = saved.mesh.lock()) {
        ++Object3D::gpuMaintenanceVisits_;
        rig->gpuSkinValidity = plan->valid; rig->skeleton->gpuSkinValidity = plan->valid;
    }
    return plan;
}

Renderer::~Renderer() {
    if (gpuJoints_) gpuJoints_->revoke();
    gpuJointPass_.reset();
    if (mipEncoder_) wgpuCommandEncoderRelease(mipEncoder_);
    for (WGPUBindGroup group : mipGroups_) wgpuBindGroupRelease(group);
    for (WGPUTextureView view : mipViews_) wgpuTextureViewRelease(view);
    dropBundles();
    for (auto& [key, program] : programs_) {
        if (!program) continue;  // a refused program
        for (int g = 0; g < 2; ++g) {
            if (program->groups[g]) wgpuBindGroupRelease(program->groups[g]);
            if (program->layouts[g]) wgpuBindGroupLayoutRelease(program->layouts[g]);
        }
        if (program->pipelineLayout) wgpuPipelineLayoutRelease(program->pipelineLayout);
    }
    for (auto& [name, atlas] : probeTextures_) {
        if (atlas.view) wgpuTextureViewRelease(atlas.view);
        if (atlas.sampler) wgpuSamplerRelease(atlas.sampler);
        if (atlas.texture) wgpuTextureRelease(atlas.texture);
    }
    releaseTargets();
    outputGroups_.clear();
    releaseOutputGroup();
    if (depthResolve_) wgpuRenderPipelineRelease(depthResolve_);
    if (overlayView_) wgpuTextureViewRelease(overlayView_);
    if (presentedView_) wgpuTextureViewRelease(presentedView_);
    wgpuSamplerRelease(outputSampler_);
    if (outputPipelineLayout_) wgpuPipelineLayoutRelease(outputPipelineLayout_);
    if (outputLayout_) wgpuBindGroupLayoutRelease(outputLayout_);
    wgpuSamplerRelease(lutSampler_);
    wgpuSamplerRelease(compareSampler_);
    wgpuSamplerRelease(depthValueSampler_);
    if (linearClampSampler_) wgpuSamplerRelease(linearClampSampler_);
    for (auto& [light, shadow] : virtualShadows_) shadowMaps_.push_back(shadow.map);
    shadowMaps_.insert(shadowMaps_.end(), cubeShadowMaps_.begin(), cubeShadowMaps_.end());
    for (ShadowMap& map : shadowMaps_) {
        if (map.view) wgpuTextureViewRelease(map.view);
        for (WGPUTextureView face : map.faces)
            if (face) wgpuTextureViewRelease(face);
        if (map.texture) wgpuTextureRelease(map.texture);
    }
    wgpuTextureViewRelease(lutView_);
    wgpuTextureRelease(lut_);
    releaseEnvironments();
    releaseMaterialTextures();
}

void Renderer::releaseTargets() {
    if (colorView_) {  // the color texture exists exactly while its view does
        wgpuTextureViewRelease(colorView_);
        gpu_.destroy(color_);
    }
    if (depthView_) wgpuTextureViewRelease(depthView_);
    if (depth_) wgpuTextureRelease(depth_);
    if (msaaDepthView_) wgpuTextureViewRelease(msaaDepthView_);
    if (msaaDepth_) wgpuTextureRelease(msaaDepth_);
    if (msaaColorView_) wgpuTextureViewRelease(msaaColorView_);
    if (msaaColor_) wgpuTextureRelease(msaaColor_);
    if (msaaAuxColorView_) wgpuTextureViewRelease(msaaAuxColorView_);
    if (msaaAuxColor_) wgpuTextureRelease(msaaAuxColor_);
    if (sceneView_) wgpuTextureViewRelease(sceneView_);
    if (sceneColor_) wgpuTextureRelease(sceneColor_);
    if (normalView_) wgpuTextureViewRelease(normalView_);
    if (normalTexture_) wgpuTextureRelease(normalTexture_);
    if (albedoView_) wgpuTextureViewRelease(albedoView_);
    if (albedoTexture_) wgpuTextureRelease(albedoTexture_);
    albedoView_ = nullptr; albedoTexture_ = nullptr;
    if (emissiveView_) wgpuTextureViewRelease(emissiveView_);
    if (emissiveTexture_) wgpuTextureRelease(emissiveTexture_);
    emissiveView_ = nullptr; emissiveTexture_ = nullptr;
    if (indirectView_) wgpuTextureViewRelease(indirectView_);
    if (indirectTexture_) wgpuTextureRelease(indirectTexture_);
    indirectView_ = nullptr; indirectTexture_ = nullptr;
    for (const auto& [name, view] : mrtViews_) wgpuTextureViewRelease(view);
    for (const auto& [name, texture] : mrtTextures_) wgpuTextureRelease(texture);
    mrtViews_.clear();
    mrtTextures_.clear();
    if (translucentView_) wgpuTextureViewRelease(translucentView_);
    if (translucentTexture_) wgpuTextureRelease(translucentTexture_);
    translucentView_ = nullptr; translucentTexture_ = nullptr;
    if (materialView_) wgpuTextureViewRelease(materialView_);
    if (materialTexture_) wgpuTextureRelease(materialTexture_);
    if (viewportColorView_) wgpuTextureViewRelease(viewportColorView_);
    if (viewportColor_) wgpuTextureRelease(viewportColor_);
    if (viewportDepthView_) wgpuTextureViewRelease(viewportDepthView_);
    if (viewportDepth_) wgpuTextureRelease(viewportDepth_);
    colorView_ = depthView_ = msaaColorView_ = msaaDepthView_ = sceneView_ = normalView_ = materialView_ = viewportColorView_ = viewportDepthView_ = nullptr;
    depth_ = msaaColor_ = msaaDepth_ = sceneColor_ = normalTexture_ = materialTexture_ = viewportColor_ = viewportDepth_ = nullptr;
    msaaAuxColor_ = nullptr;
    msaaAuxColorView_ = nullptr;
    outputGroups_.clear();  // they hold the scene target
    releaseOutputGroup();
}

void Renderer::releaseOutputGroup() {
    outputGroup_ = nullptr;  // outputGroups_ owns it
}

std::optional<OutputState> outputStateOf(double toneMapping, double exposure, const std::string& colorSpace,
                                         std::string& refusal, shader::graph::Node custom) {
    // three's constants: NoToneMapping 0, Linear 1, Reinhard 2, Cineon 3, ACESFilmic 4, AgX 6, Neutral 7.
    static const std::map<double, std::optional<shader::ToneMapping>> mappings{
        {0, std::nullopt}, {1, shader::ToneMapping::Linear}, {2, shader::ToneMapping::Reinhard},
        {3, shader::ToneMapping::Cineon}, {4, shader::ToneMapping::ACESFilmic}, {6, shader::ToneMapping::AgX},
        {7, shader::ToneMapping::Neutral}, {5, shader::ToneMapping::Custom}};
    if (toneMapping == 5 && !custom) {
        refusal = "TN_NATIVE_CUSTOM_TONEMAPPING_MISSING: register a TSL tone-mapping function before using mode 5";
        return std::nullopt;
    }
    const auto tone = mappings.find(toneMapping);
    if (tone == mappings.end()) {
        refusal = "toneMapping " + std::to_string(toneMapping);
        return std::nullopt;
    }
    if (!std::isfinite(exposure)) {
        refusal = "toneMappingExposure must be finite";
        return std::nullopt;
    }
    if (colorSpace != "srgb" && colorSpace != "srgb-linear") {
        refusal = "outputColorSpace " + colorSpace;
        return std::nullopt;
    }
    return OutputState{tone->second, exposure, colorSpace == "srgb", custom};
}

Renderer::RecordCause Renderer::recordCause(const std::vector<uint64_t>& was, const std::vector<uint32_t>& wasRows,
                                            const std::vector<uint64_t>& now, const std::vector<uint32_t>& nowRows,
                                            bool hashes) {
    // bundleKeyOf's row: pipeline, groups, the vertex and fragment offsets at 3 and 4, instances, then 6 words per store.
    if (was == now) return RecordNone;
    if (was.empty() || wasRows.empty()) return RecordOther;
    if (wasRows.size() != nowRows.size()) return RecordCount;
    if (!hashes) return RecordOther;  // RenderFeatures::web() skips the order and offset hashes: 4 MiB is its budget
    // Each draw's row with its offsets masked, hashed; the sum of the row hashes does not depend on their order.
    const auto hashed = [](const std::vector<uint64_t>& key, const std::vector<uint32_t>& rows) {
        std::vector<uint64_t> out(rows.size());
        for (std::size_t d = 0; d < rows.size(); ++d) {
            const std::size_t end = d + 1 < rows.size() ? rows[d + 1] : key.size() - 1;  // the main key's trailing word
            uint64_t h = 0xcbf29ce484222325ull;
            for (std::size_t w = rows[d]; w < end; ++w) {
                uint64_t v = end - rows[d] > 4 && (w - rows[d] == 3 || w - rows[d] == 4) ? 0 : key[w];
                v ^= v >> 33; v *= 0xff51afd7ed558ccdull; v ^= v >> 33;
                h = (h ^ v) * 0x100000001b3ull;
            }
            out[d] = h;
        }
        return out;
    };
    const auto a = hashed(was, wasRows), b = hashed(now, nowRows);
    if (a == b) return RecordOffset;
    uint64_t sumA = 0, sumB = 0;
    for (std::size_t d = 0; d < a.size(); ++d) { sumA += a[d]; sumB += b[d]; }
    return sumA == sumB ? RecordOrder : RecordOther;
}

std::vector<std::pair<double, const DrawItem*>> Renderer::sortDraws(std::span<const DrawItem> items,
                                                                 const CameraState& camera, bool stateFirst) {
    // RenderList: z is the geometry's bounding-sphere centre in world space (StandardDrawingPipeline.js:236-241:
    // geometry.boundingSphere.center through object.matrixWorld; a merged draw keeps its own origin instead),
    // then the projection-view matrix; painterSortStable for opaques, reversePainterSortStable for the rest.
    const Matrix projView = multiply(camera.projectionMatrix, camera.matrixWorldInverse);
    std::vector<std::pair<double, const DrawItem*>> opaque, transparent;
    for (const DrawItem& item : items) {
        const Matrix& m = item.matrixWorld;
        std::array<double, 3> key{m[12], m[13], m[14]};
        if (!item.sortOrigin && item.sortCenter) {
            const std::array<double, 3>& c = *item.sortCenter;
            key = {m[0] * c[0] + m[4] * c[1] + m[8] * c[2] + m[12], m[1] * c[0] + m[5] * c[1] + m[9] * c[2] + m[13],
                   m[2] * c[0] + m[6] * c[1] + m[10] * c[2] + m[14]};
        }
        const auto origin = item.sortOrigin.value_or(key);
        const double z = projView[2] * origin[0] + projView[6] * origin[1] + projView[10] * origin[2] + projView[14];
        const double w = projView[3] * origin[0] + projView[7] * origin[1] + projView[11] * origin[2] + projView[15];
        (item.transparent ? transparent : opaque).push_back({z / w, &item});
    }
    // UE 5.8.3: Engine/Source/Runtime/Renderer/Private/MeshDrawCommands.cpp sorts a pass's visible commands by a
    // state key (FMeshDrawCommandSortKey: pipeline, then state), never by view depth, so its cached commands hold.
    // stateFirst is RenderFeatures' stablePasses and stableRows: only the retained rows sort by state.
    stateFirst = stateFirst && std::all_of(opaque.begin(), opaque.end(), [](const auto& d) {
        return d.second->background || (d.second->depthWrite && d.second->depthTest && d.second->colorWrite);
    });
    if (stateFirst) {
        // ponytail: material and geometry order by address, so exactly coplanar draws can swap winners between runs.
        std::sort(opaque.begin(), opaque.end(), [](const auto& a, const auto& b) {
            const DrawItem& x = *a.second;
            const DrawItem& y = *b.second;
            return std::tie(y.background, x.renderOrder, x.kind, x.side, x.material, x.positions, x.indices, x.key) <
                   std::tie(x.background, y.renderOrder, y.kind, y.side, y.material, y.positions, y.indices, y.key);
        });
    } else
    std::sort(opaque.begin(), opaque.end(), [](const auto& a, const auto& b) {
        if (a.second->background != b.second->background) return a.second->background;
        if (a.second->renderOrder != b.second->renderOrder) return a.second->renderOrder < b.second->renderOrder;
        if (a.first != b.first) return a.first < b.first;
        return a.second->id < b.second->id;
    });
    // Stable: a transparent DoubleSide material's BackSide pass stays right before its FrontSide pass.
    std::stable_sort(transparent.begin(), transparent.end(), [](const auto& a, const auto& b) {
        if (a.second->renderOrder != b.second->renderOrder) return a.second->renderOrder < b.second->renderOrder;
        if (a.first != b.first) return a.first > b.first;
        return a.second->id < b.second->id;
    });
    opaque.insert(opaque.end(), transparent.begin(), transparent.end());

    return opaque;
}

uint64_t Renderer::render(std::span<const DrawItem> items, const CameraState& camera, const LightState& lights,
                          std::array<double, 4> clear) {
    return renderPrepared(items, camera, lights, clear, nullptr, WGPUTextureFormat_RGBA8Unorm);
}

uint64_t Renderer::renderDeferred(std::span<const DrawItem> items, const CameraState& camera, const LightState& lights,
                                  std::array<double, 4> clear) {
    return renderPrepared(items, camera, lights, clear, nullptr, WGPUTextureFormat_RGBA8Unorm, true);
}

void Renderer::encodePending() {
    if (!pendingEncode_ || !job_) throw std::logic_error("TN_RENDER_THREAD_BATON: encodePending without a deferred render");
    encoding_ = true;
    struct Done {
        Renderer& r;
        ~Done() { r.pendingEncode_ = false; r.encoding_ = false; }
    } done{*this};
    encodeFrame(*job_);
}

void Renderer::deferTarget(const void* key, std::weak_ptr<void> owner, std::vector<std::function<void()>> jobs) {
    flushDeferred(key);
    deferred_.push_back({key, std::move(owner), std::move(jobs)});
}

void Renderer::flushDeferred(const void* key) {
    const auto found = std::find_if(deferred_.begin(), deferred_.end(), [&](const auto& entry) { return entry.key == key; });
    if (found == deferred_.end()) return;
    DeferredTarget entry = std::move(*found);
    deferred_.erase(found);
    if (!entry.owner.expired())
        for (const auto& job : entry.jobs) job();
}

bool Renderer::postSamples(const void* key) const {
    return std::any_of(postTextureNodes_.begin(), postTextureNodes_.end(),
                       [&](const auto& node) { return static_cast<const Texture*>(node->textureObject().get())->renderTarget.lock().get() == key; });
}

void Renderer::recordDeferred(bool sampled) {
    std::vector<const void*> keys;
    for (const auto& entry : deferred_)
        if (postSamples(entry.key) == sampled) keys.push_back(entry.key);
    for (const void* key : keys) flushDeferred(key);
}

std::vector<std::shared_ptr<PipelineCompilation>> Renderer::compileAsync(std::span<const DrawItem> items,
    const CameraState& camera, const LightState& lights, WGPUTextureFormat outputFormat) {
    std::vector<std::shared_ptr<PipelineCompilation>> compilation;
    renderPrepared(items, camera, lights, {}, &compilation, outputFormat);
    return compilation;
}

void Renderer::setCpuMeters(bool enabled) {
    cpuMetersOn.store(enabled, std::memory_order_relaxed);
    waste::meterEnabled().store(enabled, std::memory_order_relaxed);
}
bool Renderer::cpuMeters() { return cpuMetersOn.load(std::memory_order_relaxed); }

void Renderer::addCpuStage(CpuStage stage, double started) {
    if (started < 0) return;
    cpuStageMs_[stage].store(cpuStageMs_[stage].load(std::memory_order_relaxed) + meterMs() - started, std::memory_order_relaxed);
}

Renderer::CpuStageMeter::CpuStageMeter(std::atomic<double>& total, bool on) : total(total), started(meterStart(on)) {}

Renderer::CpuStageMeter::~CpuStageMeter() {
    if (started < 0) return;
    total.store(total.load(std::memory_order_relaxed) + meterMs() - started, std::memory_order_relaxed);
}

void Renderer::encodeFrame(FrameJob& job) {
    const CpuStageMeter encodeMeter(cpuStageMs_[CpuEncode], cpuMetered_);
    FrameGpuTimer::Scope timerScope(passTimer_.get());
    // The encode half (PRD-613): records and submits what renderPrepared planned. It reads the job,
    // the renderer's own GPU state and the geometry cache's resolved handles, and nothing the game writes.
    // A bind group released after the plan chose it would be recorded as a recycled handle: refuse the frame.
    if (job.groupEpoch != groupEpoch_)
        throw std::logic_error("TN_NATIVE_GROUPS_STALE: bind groups were dropped after this frame's draws chose them");
    std::vector<Planned>& plan = job.plan;
    std::vector<Planned>& velocityPlan = job.velocityPlan;
    std::vector<ShadowPass>& shadowPasses = job.shadowPasses;
    WGPUCommandEncoder encoder = job.encoder;
    WGPURenderPassColorAttachment& color = job.color;
    WGPURenderPassDepthStencilAttachment& depth = job.depth;
    const bool timed = job.timed;
    const uint64_t source = job.source;
    const CameraState& camera = job.camera;
    const LightState& lights = job.lights;
    WGPURenderPipeline pageClear = job.pageClear;
    const WGPUTextureView presentTarget = job.presentTarget;
    const WGPUTextureFormat presentFormat = job.presentFormat;
    WGPURenderPassDescriptor passDesc = {};
    passDesc.colorAttachmentCount = 1;
    passDesc.colorAttachments = &color;
    passDesc.depthStencilAttachment = &depth;
    // Encode: state changes only where they change; per draw, its dynamic offsets and the draw. The
    // shadow passes first, so the main pass samples this frame's maps.
    WGPURenderPipeline bound = nullptr;
    const BufferStore* boundVertex[8] = {};  // by vertex buffer slot (attribute location)
    const BufferStore* boundIndex = nullptr;
    lastFrame_ = FrameStats{};
    // Which of three's Info counters a draw lands in. The normal and velocity passes are extra targets
    // of the one scene pass three counts once, so they tally nowhere.
    enum class Tally { Main, Shadow, Extra };
    auto encode = [&](auto pass, const Planned& p, Tally tally) {
        const bool counted = tally == Tally::Main;
        // The same commands record a direct pass or a cached bundle.
#define TN_ENCODE(name, ...) \
        if constexpr (std::is_same_v<decltype(pass), WGPURenderBundleEncoder>) \
            wgpuRenderBundleEncoder##name(pass, __VA_ARGS__); \
        else wgpuRenderPassEncoder##name(pass, __VA_ARGS__)
        const DrawItem& item = *p.item;
        if (p.pipeline != bound) {
            TN_ENCODE(SetPipeline, bound = p.pipeline);
            std::fill(std::begin(boundVertex), std::end(boundVertex), nullptr);
            boundIndex = nullptr;
        }
        for (const shader::VertexAttribute& a : p.program->vertex.attributes) {
            // instanceMatrix0..3 are the columns of one buffer of mat4s, bound at 16-byte steps.
            const bool column = a.name.rfind("instanceMatrix", 0) == 0;
            BufferStore* source = vertexSourceOf(item, a);
            if (!source) throw std::runtime_error("TN_NATIVE_ATTRIBUTE_MISSING: " + a.name);
            const BufferStore& store = *source;
            const uint64_t offset = column ? uint64_t(a.name.back() - '0') * 16 : 0;
            if (a.location < std::size(boundVertex) && boundVertex[a.location] == &store) continue;
            const auto resolved = geometry_->cache.resolved(store);
            TN_ENCODE(SetVertexBuffer, a.location, geometry_->gpu.buffer(resolved.buffer), offset, resolved.bytes - offset);
            if (a.location < std::size(boundVertex)) boundVertex[a.location] = &store;
        }
        // A required group that resolved to null means the draw's storage source is gone. A cached
        // program whose providing scene was torn down may keep a null group, but an active draw must
        // never bind it: fail closed rather than send null or silently skip the draw. A stage with no
        // bindings has a valid empty layout, so its group is not required.
        const WGPUBindGroup vertexGroup = p.vertexGroup ? p.vertexGroup : p.program->groups[0];
        if (vertexGroup == nullptr && !p.program->vertex.bindings.empty())
            throw std::runtime_error("TN_NATIVE_BINDING_NULL: active draw has no vertex bind group");
        TN_ENCODE(SetBindGroup, 0, vertexGroup, 1, &p.vertexOffset);
        // Plain depth draws have no fragment block; alpha coverage uses its own uniform slice.
        const bool fragmentBlock = p.program->fragment.uniformBlockSize != 0;
        const WGPUBindGroup fragmentGroup = p.mapGroup ? p.mapGroup : p.program->groups[1];
        if (fragmentGroup == nullptr && !p.program->fragment.bindings.empty())
            throw std::runtime_error("TN_NATIVE_BINDING_NULL: active draw has no fragment bind group");
        TN_ENCODE(SetBindGroup, 1, fragmentGroup, fragmentBlock ? 1 : 0, &p.fragmentOffset);
        if (item.indices) {
            const auto indices = geometry_->cache.resolved(*item.indices);
            const bool wide = indices.scalar == Scalar::U32;
            if (boundIndex != item.indices) {
                TN_ENCODE(SetIndexBuffer, geometry_->gpu.buffer(indices.buffer),
                          wide ? WGPUIndexFormat_Uint32 : WGPUIndexFormat_Uint16, 0,
                          (indices.bytes + 3) & ~uint64_t{3});
                boundIndex = item.indices;
            }
            const uint32_t count = static_cast<uint32_t>(indices.bytes / (wide ? 4 : 2));
            // The record's instance count is the GPU's; the tally below stays the CPU upper bound (capacity).
            if (item.indirect)
                TN_ENCODE(DrawIndexedIndirect, geometry_->gpu.buffer(geometry_->cache.resolved(*item.indirect).buffer), item.indirectOffset);
            else TN_ENCODE(DrawIndexed, count, item.instanceCount, 0, 0, 0);
            if (tally != Tally::Extra)
                (counted ? lastFrame_.triangles : lastFrame_.shadowTriangles) += uint64_t{item.instanceCount} * (count / 3);  // three's Info.update
        } else {
            const uint32_t count = static_cast<uint32_t>(geometry_->cache.resolved(*item.positions).bytes / 12);
            if (item.indirect)
                TN_ENCODE(DrawIndirect, geometry_->gpu.buffer(geometry_->cache.resolved(*item.indirect).buffer), item.indirectOffset);
            else TN_ENCODE(Draw, count, item.instanceCount, 0, 0);
            if (tally != Tally::Extra)
                (counted ? lastFrame_.triangles : lastFrame_.shadowTriangles) += uint64_t{item.instanceCount} * (count / 3);
        }
        if (tally == Tally::Main) ++lastFrame_.draws;
        else if (tally == Tally::Shadow) ++lastFrame_.shadowDraws;
        if (item.boneMatrices && tally != Tally::Extra) {
            auto& stats = counted ? lastFrame_.mainSkinned : lastFrame_.shadowSkinned;
            ++stats.draws;
            if (item.boneStride || item.shadowGroup) {
                ++stats.batches;
                stats.instances += item.instanceCount;
            } else {
                ++stats.exactDraws;
            }
        }
#undef TN_ENCODE
    };
    if (!virtualShadows_.empty()) {
        graph::RenderGraph graph;
        std::vector<graph::Read> reads;
        for (const auto& [i, shadow] : virtualShadows_) {
            const auto atlas = graph.external("vsm-atlas" + std::to_string(i),
                {uint32_t(shadow.atlas.edge()), uint32_t(shadow.atlas.edge()), WGPUTextureFormat_Depth24Plus,
                 WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_TextureBinding});
            const auto table = graph.external("vsm-page-table" + std::to_string(i), {});
            graph.pass("vsm-pages" + std::to_string(i), graph::PassKind::Render, {{table}}, {atlas});
            reads.push_back({atlas}); reads.push_back({table});
        }
        graph.pass("vsm-receivers", graph::PassKind::Render, reads, {});
        if (!graph.compile().ok()) throw std::runtime_error("TN_GRAPH_INVALID: virtual shadows");
    }
    // Keep the shadow diagnostic while timing each shadow pass separately.
    const bool shadowTimed = timed && !shadowPasses.empty();
    if (timed) timerBeganAtShadow_ = shadowTimed;
    std::map<std::pair<std::size_t, int>, double> shadowCosts;
    std::map<size_t, std::pair<std::weak_ptr<VirtualShadowCosts>, int>> shadowQueries;
    for (const ShadowPass& shadowPlan : shadowPasses) {
        const auto shadowStarted = std::chrono::steady_clock::now();
        const double shadowMeter = meterMs(), recordedBefore = lastFrame_.recordMs;
        WGPURenderPassDepthStencilAttachment shadowDepth = {};
        shadowDepth.view = shadowPlan.target;
        shadowDepth.depthLoadOp = shadowPlan.size ? WGPULoadOp_Load : WGPULoadOp_Clear;
        shadowDepth.depthStoreOp = WGPUStoreOp_Store;
        shadowDepth.depthClearValue = 1.0f;
        WGPURenderPassDescriptor shadowDesc = {};
        shadowDesc.depthStencilAttachment = &shadowDepth;
        const size_t query = passTimer_->segments.size();
        WGPURenderPassEncoder shadowPass = beginTimedRenderPass(encoder, &shadowDesc, !ownsPassTimer_ ? 2 : shadowPlan.lamp ? kGpuLampShadowSegment : 0, {"shadow", 0, 0});
        if (shadowPlan.lamp) {
            // A lamp's map is redrawn when its first face is: a cube's six passes are one redraw.
            lastFrame_.lampRedraws += &shadowPlan == shadowPasses.data() || (&shadowPlan - 1)->virtualLight != shadowPlan.virtualLight || !(&shadowPlan - 1)->lamp;
            lastFrame_.lampShadowDraws += uint32_t(shadowPlan.draws.size());
        }
        if (shadowPlan.virtualLevel >= 0 && passTimer_->segments.size() > query)
            shadowQueries[query] = {virtualShadows_.at(shadowPlan.virtualLight).costs, shadowPlan.virtualLevel};
        if (shadowPlan.size) {
            wgpuRenderPassEncoderSetViewport(shadowPass, shadowPlan.x, shadowPlan.y, shadowPlan.size, shadowPlan.size, 0, 1);
            wgpuRenderPassEncoderSetScissorRect(shadowPass, shadowPlan.x, shadowPlan.y, shadowPlan.size, shadowPlan.size);
            wgpuRenderPassEncoderSetPipeline(shadowPass, pageClear);
            wgpuRenderPassEncoderDraw(shadowPass, 3, 1, 0, 0);
        }
        // The pass replays its draws from a bundle recorded once per key (PRD-754): a caster's matrix is a uniform
        // write, so a moved caster draws from the same commands. The viewport and the page clear are pass state.
        const std::size_t index = std::size_t(&shadowPlan - shadowPasses.data());
        if (!features().stablePasses) {
            bound = nullptr;
            boundIndex = nullptr;
            for (const Planned& p : shadowPlan.draws) encode(shadowPass, p, Tally::Shadow);
        } else if (!shadowPlan.draws.empty()) {
            if (shadowBundles_.size() <= index) shadowBundles_.resize(index + 1);
            ShadowBundle& cached = shadowBundles_[index];
            if (!cached.bundle || cached.key != job.shadowKeys[index]) {
                const double recordStarted = meterMs();
                if (cached.bundle) wgpuRenderBundleRelease(cached.bundle);
                WGPURenderBundleEncoderDescriptor descriptor{};
                descriptor.depthStencilFormat = WGPUTextureFormat_Depth24Plus;
                descriptor.sampleCount = 1;
                const auto recorder = wgpuDeviceCreateRenderBundleEncoder(device_, &descriptor);
                bound = nullptr; boundIndex = nullptr;
                std::fill(std::begin(boundVertex), std::end(boundVertex), nullptr);
                const auto draws = lastFrame_.shadowDraws;
                const auto triangles = lastFrame_.shadowTriangles;
                const auto skinned = lastFrame_.shadowSkinned;
                for (const Planned& p : shadowPlan.draws) encode(recorder, p, Tally::Shadow); // three's info counts the main pass
                cached.draws = lastFrame_.shadowDraws - draws;
                cached.triangles = lastFrame_.shadowTriangles - triangles;
                cached.skinned = {lastFrame_.shadowSkinned.batches - skinned.batches, lastFrame_.shadowSkinned.draws - skinned.draws,
                                  lastFrame_.shadowSkinned.exactDraws - skinned.exactDraws,
                                  lastFrame_.shadowSkinned.instances - skinned.instances};
                lastFrame_.shadowDraws = draws; lastFrame_.shadowTriangles = triangles; lastFrame_.shadowSkinned = skinned;
                WGPURenderBundleDescriptor finish{};
                cached.bundle = wgpuRenderBundleEncoderFinish(recorder, &finish);
                wgpuRenderBundleEncoderRelease(recorder);
                cached.key = std::move(job.shadowKeys[index]);
                lastFrame_.shadowRecorded += uint32_t(shadowPlan.draws.size());
                lastFrame_.recordMs += (meterMs() - recordStarted);
            }
            lastFrame_.shadowDraws += cached.draws;
            lastFrame_.shadowTriangles += cached.triangles;
            auto& tally = lastFrame_.shadowSkinned;
            tally.batches += cached.skinned.batches; tally.draws += cached.skinned.draws;
            tally.exactDraws += cached.skinned.exactDraws; tally.instances += cached.skinned.instances;
            wgpuRenderPassEncoderExecuteBundles(shadowPass, 1, &cached.bundle);
        }
        wgpuRenderPassEncoderEnd(shadowPass);
        wgpuRenderPassEncoderRelease(shadowPass);
        const double shadowMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - shadowStarted).count();
        lastFrame_.shadowEncodeMs += meterMs() - shadowMeter - (lastFrame_.recordMs - recordedBefore);
        if (shadowPlan.virtualLevel >= 0) shadowCosts[{shadowPlan.virtualLight, shadowPlan.virtualLevel}] += shadowMs;
    }
    // Like core's CPU measurement when timestamp queries are unavailable; never mix CPU and GPU samples.
    if (!passTimer_->queries)
        for (const auto& [key, ms] : shadowCosts) virtualShadows_.at(key.first).atlas.recordCost(key.second, ms, frameDelta_);
    WGPURenderPassEncoder pass = beginTimedRenderPass(encoder, &passDesc, ownsPassTimer_ ? 1 : 2, {"scene", inputWidth_, inputHeight_});
    bound = nullptr;
    boundIndex = nullptr;
    // three's viewport textures copy the frame at the first draw that reads one: the main pass splits
    // there, the scene colour and depth are copied, and the rest draws in a second pass that loads them.
    const std::size_t viewportSplit = static_cast<std::size_t>(
        std::find_if(plan.begin(), plan.end(), [&](const Planned& p) { return probesOf(*p.program).viewport; }) -
        plan.begin());
    const std::vector<uint64_t>& bundleKey = job.bundleKey;
    // A pass's retained rows, recorded with each draw's counts read from its indirect record (firstInstance 0).
    // Rows [from, to): the sorted ones, or (delta) the ones first seen since the sort.
    const auto recordRows = [&](const WGPURenderBundleEncoderDescriptor& descriptor, const PassRows& pass, bool delta) {
        const std::vector<MainRow>& rows = *pass.rows;
        const auto bundle = wgpuDeviceCreateRenderBundleEncoder(device_, &descriptor);
        WGPURenderPipeline pipeline = nullptr;
        WGPUBuffer vertexBuffers[16] = {}, index = nullptr;
        uint64_t vertexOffsets[16] = {};
        for (std::size_t r = delta ? pass.sorted : 0; r < (delta ? rows.size() : pass.sorted); ++r) {
            const MainRow& row = rows[r];
            if (row.pipeline != pipeline) {
                wgpuRenderBundleEncoderSetPipeline(bundle, pipeline = row.pipeline);
                std::fill(std::begin(vertexBuffers), std::end(vertexBuffers), nullptr);
                index = nullptr;
            }
            for (const auto& v : row.vertex) {
                if (v.location < 16 && vertexBuffers[v.location] == v.buffer && vertexOffsets[v.location] == v.offset) continue;
                wgpuRenderBundleEncoderSetVertexBuffer(bundle, v.location, v.buffer, v.offset, v.size);
                if (v.location < 16) { vertexBuffers[v.location] = v.buffer; vertexOffsets[v.location] = v.offset; }
            }
            wgpuRenderBundleEncoderSetBindGroup(bundle, 0, row.vertexGroup, 1, &row.vertexOffset);
            wgpuRenderBundleEncoderSetBindGroup(bundle, 1, row.mapGroup, row.fragmentBlock ? 1 : 0, &row.fragmentOffset);
            if (row.index) {
                if (index != row.index) wgpuRenderBundleEncoderSetIndexBuffer(bundle, index = row.index, row.indexFormat, 0, row.indexSize);
                wgpuRenderBundleEncoderDrawIndexedIndirect(bundle, row.indirect ? row.indirect : pass.indirect,
                                                           row.indirect ? row.indirectOffset : r * 20);
            } else {
                wgpuRenderBundleEncoderDrawIndirect(bundle, row.indirect ? row.indirect : pass.indirect,
                                                    row.indirect ? row.indirectOffset : r * 20);
            }
        }
        WGPURenderBundleDescriptor finish{};
        const WGPURenderBundle recorded = wgpuRenderBundleEncoderFinish(bundle, &finish);
        wgpuRenderBundleEncoderRelease(bundle);
        return recorded;
    };
    // A pass's delta bundle: its rows first seen since the last sort, recorded again only when that set grows.
    const auto delta = [&](const WGPURenderBundleEncoderDescriptor& descriptor, const PassRows& pass, WGPURenderBundle& bundle,
                           std::array<uint64_t, 3>& key, uint32_t& recorded) {
        if (!features().stableRows || !pass.on || pass.sorted == pass.rows->size()) {
            if (bundle) wgpuRenderBundleRelease(bundle);
            bundle = nullptr;
            return;
        }
        if (bundle && key == pass.deltaKey) return;
        const double recordStarted = meterMs();
        const WGPURenderBundle made = recordRows(descriptor, pass, true);
        if (bundle) wgpuRenderBundleRelease(bundle);
        bundle = made;
        key = pass.deltaKey;
        recorded += uint32_t(pass.rows->size() - pass.sorted);
        lastFrame_.recordMs += meterMs() - recordStarted;
    };
    if (features().stableRows && job.mainRows.on) {
        WGPURenderBundleEncoderDescriptor descriptor{};
        const WGPUTextureFormat color = sceneFormat_;
        descriptor.colorFormatCount = 1; descriptor.colorFormats = &color;
        descriptor.depthStencilFormat = WGPUTextureFormat_Depth32Float; descriptor.sampleCount = sampleCount_;
        // The draws from the first transparent one to the viewport copy: a bundle keyed by their rows of the per-draw key.
        if (job.tail == viewportSplit) {
            if (tailBundle_) wgpuRenderBundleRelease(tailBundle_);
            tailBundle_ = nullptr;
        } else if (!tailBundle_ || job.tailKey != tailKey_) {
            const double recordStarted = meterMs();
            const auto bundle = wgpuDeviceCreateRenderBundleEncoder(device_, &descriptor);
            bound = nullptr;
            boundIndex = nullptr;
            std::fill(std::begin(boundVertex), std::end(boundVertex), nullptr);
            for (std::size_t k = job.tail; k < viewportSplit; ++k) encode(bundle, plan[k], Tally::Main);  // Info: below
            WGPURenderBundleDescriptor finish{};
            const WGPURenderBundle recorded = wgpuRenderBundleEncoderFinish(bundle, &finish);
            wgpuRenderBundleEncoderRelease(bundle);
            if (tailBundle_) wgpuRenderBundleRelease(tailBundle_);
            tailBundle_ = recorded;
            tailKey_ = std::move(job.tailKey);
            lastFrame_.mainRecorded += uint32_t(viewportSplit - job.tail);
            lastFrame_.recordMs += meterMs() - recordStarted;
        }
        if (viewportSplit == plan.size()) {
            if (viewportBundle_) wgpuRenderBundleRelease(viewportBundle_);
            viewportBundle_ = nullptr;
            viewportKey_.clear();
        } else if (!viewportBundle_ || job.viewportKey != viewportKey_) {
            const double recordStarted = meterMs();
            const auto bundle = wgpuDeviceCreateRenderBundleEncoder(device_, &descriptor);
            bound = nullptr;
            boundIndex = nullptr;
            std::fill(std::begin(boundVertex), std::end(boundVertex), nullptr);
            for (std::size_t k = viewportSplit; k < plan.size(); ++k) encode(bundle, plan[k], Tally::Main);  // Info: below
            WGPURenderBundleDescriptor finish{};
            const WGPURenderBundle recorded = wgpuRenderBundleEncoderFinish(bundle, &finish);
            wgpuRenderBundleEncoderRelease(bundle);
            if (viewportBundle_) wgpuRenderBundleRelease(viewportBundle_);
            viewportBundle_ = recorded;
            viewportKey_ = std::move(job.viewportKey);
            lastFrame_.mainRecorded += uint32_t(plan.size() - viewportSplit);
            lastFrame_.recordMs += meterMs() - recordStarted;
        }
        if (!mainBundle_ || bundleKey != mainBundleKey_) {
            const auto cause = mainBundleKey_.size() == 2 ? job.mainRows.cause : RecordOther;
            const double recordStarted = meterMs();
            const std::vector<MainRow>& rows = *job.mainRows.rows;
            const WGPURenderBundle recorded = recordRows(descriptor, job.mainRows, false);
            if (mainBundle_) wgpuRenderBundleRelease(mainBundle_);  // after the record: the new bundle holds the rows' objects
            mainBundle_ = recorded;
            lastFrame_.mainRecorded += uint32_t(job.mainRows.sorted);
            (void)rows;
            lastFrame_.recordCause = cause;
            lastFrame_.recordMs += meterMs() - recordStarted;
            mainBundleKey_ = std::move(job.bundleKey);
            mainBundleRows_ = std::move(job.bundleRows);
        }
        delta(descriptor, job.mainRows, mainDelta_, mainDeltaKey_, lastFrame_.mainRecorded);
        lastFrame_.recordMs += job.mainRows.ms;
        lastFrame_.draws = job.mainRows.draws;
        lastFrame_.triangles = job.mainRows.triangles;
        lastFrame_.mainSkinned = job.mainRows.skinned;
    } else if (!mainBundle_ || bundleKey != mainBundleKey_) {
        if (mainBundle_) wgpuRenderBundleRelease(mainBundle_);
        if (viewportBundle_) wgpuRenderBundleRelease(viewportBundle_);
        if (tailBundle_) wgpuRenderBundleRelease(tailBundle_);
        if (mainDelta_) wgpuRenderBundleRelease(mainDelta_);
        mainBundle_ = viewportBundle_ = tailBundle_ = mainDelta_ = nullptr;
        WGPURenderBundleEncoderDescriptor descriptor{};
        const WGPUTextureFormat color = sceneFormat_;
        descriptor.colorFormatCount = 1; descriptor.colorFormats = &color;
        descriptor.depthStencilFormat = WGPUTextureFormat_Depth32Float; descriptor.sampleCount = sampleCount_;
        const auto shadowStats = lastFrame_.shadowSkinned;
        const auto shadowDraws = lastFrame_.shadowDraws;
        const auto shadowTriangles = lastFrame_.shadowTriangles;
        const auto lampRedraws = lastFrame_.lampRedraws, lampShadowDraws = lastFrame_.lampShadowDraws;
        const double shadowEncodeMs = lastFrame_.shadowEncodeMs, shadowRecordMs = lastFrame_.recordMs;
        const uint32_t shadowRecorded = lastFrame_.shadowRecorded;
        const auto cause = recordCause(mainBundleKey_, mainBundleRows_, bundleKey, job.bundleRows, features().recordCauseHashes);
        const double recordStarted = meterMs();
        lastFrame_ = FrameStats{};
        const auto record = [&](std::size_t from, std::size_t to) {
            const auto bundle = wgpuDeviceCreateRenderBundleEncoder(device_, &descriptor);
            bound = nullptr;
            boundIndex = nullptr;
            std::fill(std::begin(boundVertex), std::end(boundVertex), nullptr);
            for (std::size_t k = from; k < to; ++k) encode(bundle, plan[k], Tally::Main);
            WGPURenderBundleDescriptor finish{};
            const WGPURenderBundle recorded = wgpuRenderBundleEncoderFinish(bundle, &finish);
            wgpuRenderBundleEncoderRelease(bundle);
            return recorded;
        };
        mainBundle_ = record(0, viewportSplit);
        if (viewportSplit < plan.size()) viewportBundle_ = record(viewportSplit, plan.size());
        viewportKey_.clear();
        mainBundleStats_ = lastFrame_;
        lastFrame_.shadowSkinned = shadowStats;
        lastFrame_.shadowDraws = shadowDraws;
        lastFrame_.shadowTriangles = shadowTriangles;
        lastFrame_.lampRedraws = lampRedraws; lastFrame_.lampShadowDraws = lampShadowDraws;
        lastFrame_.shadowEncodeMs = shadowEncodeMs;
        lastFrame_.shadowRecorded = shadowRecorded;
        lastFrame_.mainRecorded = uint32_t(plan.size());
        lastFrame_.recordCause = cause;
        lastFrame_.recordMs = shadowRecordMs + (meterMs() - recordStarted);
        mainBundleKey_ = std::move(job.bundleKey);
        mainBundleRows_ = std::move(job.bundleRows);
    } else {
        lastFrame_.draws = mainBundleStats_.draws;
        lastFrame_.triangles = mainBundleStats_.triangles;
        lastFrame_.mainSkinned = mainBundleStats_.mainSkinned;
    }
    WGPURenderBundle mainBundles[3] = {mainBundle_};
    std::size_t mainCount = 1;
    for (const WGPURenderBundle more : {mainDelta_, tailBundle_})
        if (more) mainBundles[mainCount++] = more;
    wgpuRenderPassEncoderExecuteBundles(pass, mainCount, mainBundles);
    wgpuRenderPassEncoderEnd(pass);
    wgpuRenderPassEncoderRelease(pass);
    // At 4x, the main pass draws depth into msaaDepth_. Resolve it into depth_ for the copy below.
    if (sampleCount_ == 4) resolveDepth(encoder);
    if (viewportBundle_) {
        WGPUImageCopyTexture_Compat from = {}, to = {};
        const WGPUExtent3D extent{inputWidth_, inputHeight_, 1};
        from.texture = sceneColor_; to.texture = viewportColor_;
        wgpuCommandEncoderCopyTextureToTexture(encoder, &from, &to, &extent);
        from.texture = depth_; to.texture = viewportDepth_;
        from.aspect = to.aspect = WGPUTextureAspect_DepthOnly;
        wgpuCommandEncoderCopyTextureToTexture(encoder, &from, &to, &extent);
        WGPURenderPassColorAttachment loadColor = color;
        loadColor.loadOp = WGPULoadOp_Load;
        WGPURenderPassDepthStencilAttachment loadDepth = depth;
        loadDepth.depthLoadOp = WGPULoadOp_Load;
        WGPURenderPassDescriptor viewportDesc = {};
        viewportDesc.colorAttachmentCount = 1;
        viewportDesc.colorAttachments = &loadColor;
        viewportDesc.depthStencilAttachment = &loadDepth;
        WGPURenderPassEncoder rest = beginTimedRenderPass(encoder, &viewportDesc, 2, {"viewport", inputWidth_, inputHeight_});
        wgpuRenderPassEncoderExecuteBundles(rest, 1, &viewportBundle_);
        wgpuRenderPassEncoderEnd(rest);
        wgpuRenderPassEncoderRelease(rest);
        // The rest pass draws more depth. Resolve it again for the normal, motion and post stages.
        if (sampleCount_ == 4) resolveDepth(encoder);
    }
    // The aux and velocity passes replay a bundle recorded once from their draws, recorded again only when the draws,
    // pipelines, groups, offsets or stores change (their keys, built with the plan), as the main pass does.
    const auto replay = [&](WGPURenderPassEncoder pass, WGPURenderBundle& bundle, std::vector<uint64_t>& key,
                            std::vector<uint64_t>& planned, const std::vector<Planned>& draws,
                            const WGPUTextureFormat* formats, size_t formatCount, uint32_t samples, const PassRows& rows,
                            WGPURenderBundle& deltaBundle, std::array<uint64_t, 3>& deltaKey, WGPURenderBundle& tailBundle,
                            std::vector<uint64_t>& tailKey) {
        lastFrame_.recordMs += rows.ms;
        WGPURenderBundleEncoderDescriptor descriptor{};
        descriptor.colorFormatCount = formatCount; descriptor.colorFormats = formats;
        descriptor.depthStencilFormat = WGPUTextureFormat_Depth32Float; descriptor.sampleCount = samples;
        descriptor.depthReadOnly = true;
        if (features().stableRows && rows.on && (!bundle || planned != key)) {
            const double recordStarted = meterMs();
            const WGPURenderBundle recorded = recordRows(descriptor, rows, false);
            if (bundle) wgpuRenderBundleRelease(bundle);  // after the record: the new bundle holds the rows' objects
            bundle = recorded;
            key = std::move(planned);
            lastFrame_.auxRecorded += uint32_t(rows.sorted);
            lastFrame_.recordMs += (meterMs() - recordStarted);
        } else if (!bundle || planned != key) {
            const double recordStarted = meterMs();
            if (bundle) wgpuRenderBundleRelease(bundle);
            const auto recorder = wgpuDeviceCreateRenderBundleEncoder(device_, &descriptor);
            bound = nullptr; boundIndex = nullptr;
            std::fill(std::begin(boundVertex), std::end(boundVertex), nullptr);
            for (const Planned& p : draws) encode(recorder, p, Tally::Extra);
            WGPURenderBundleDescriptor finish{};
            bundle = wgpuRenderBundleEncoderFinish(recorder, &finish);
            wgpuRenderBundleEncoderRelease(recorder);
            key = std::move(planned);
            lastFrame_.auxRecorded += uint32_t(draws.size());
            lastFrame_.recordMs += (meterMs() - recordStarted);
        }
        delta(descriptor, rows, deltaBundle, deltaKey, lastFrame_.auxRecorded);
        if (!features().stableRows || !rows.on || rows.tail == draws.size()) {
            if (tailBundle) wgpuRenderBundleRelease(tailBundle);
            tailBundle = nullptr;
        } else if (!tailBundle || rows.tailKey != tailKey) {
            const double recordStarted = meterMs();
            const auto recorder = wgpuDeviceCreateRenderBundleEncoder(device_, &descriptor);
            bound = nullptr; boundIndex = nullptr;
            std::fill(std::begin(boundVertex), std::end(boundVertex), nullptr);
            for (std::size_t k = rows.tail; k < draws.size(); ++k) encode(recorder, draws[k], Tally::Extra);
            WGPURenderBundleDescriptor finish{};
            if (tailBundle) wgpuRenderBundleRelease(tailBundle);
            tailBundle = wgpuRenderBundleEncoderFinish(recorder, &finish);
            wgpuRenderBundleEncoderRelease(recorder);
            tailKey = rows.tailKey;
            lastFrame_.auxRecorded += uint32_t(draws.size() - rows.tail);
            lastFrame_.recordMs += (meterMs() - recordStarted);
        }
        WGPURenderBundle bundles[3] = {bundle};
        uint32_t executed = 1;
        for (const WGPURenderBundle more : {deltaBundle, tailBundle})
            if (more) bundles[executed++] = more;
        wgpuRenderPassEncoderExecuteBundles(pass, executed, bundles);
    };
    if (job.auxMask || !job.auxMrt.empty()) {
        // One pass writes every post target the graph reads, one colour attachment each in AuxTarget order, then one
        // per custom MRT slot (planAux): single-sampled, against the colour pass's resolved depth, which it only reads.
        std::array<WGPURenderPassColorAttachment, 8> targets{};
        std::array<WGPUTextureFormat, 8> formats{};
        size_t count = 0;
        const auto attachView = [&](WGPUTextureView view, WGPUColor clear) {
            if (count >= targets.size() || view == nullptr) return;
            WGPURenderPassColorAttachment& target = targets[count];
            target.view = view; target.loadOp = WGPULoadOp_Clear; target.storeOp = WGPUStoreOp_Store;
            target.clearValue = clear;
#if defined(MYSTRAL_WEBGPU_DAWN)
            target.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
#endif
            formats[count++] = WGPUTextureFormat_RGBA16Float;
        };
        const auto attach = [&](uint8_t bit, WGPUTextureView view, WGPUColor clear) {
            if (!(job.auxMask & bit)) return;
            attachView(view, clear);
        };
        attach(kAuxNormal, normalView_, {0, 0, 0, 0});
        attach(kAuxMaterial, materialView_, {0, 1, 0, 1});  // no surface: metalness 0, roughness 1
        attach(kAuxAlbedo, albedoView_, {0, 0, 0, 0});
        attach(kAuxEmissive, emissiveView_, {0, 0, 0, 0});
        attach(kAuxIndirect, indirectView_, {0, 0, 0, 0});
        for (const auto& name : job.auxMrt) {
            const auto found = mrtViews_.find(name);
            attachView(found == mrtViews_.end() ? nullptr : found->second, {0, 0, 0, 0});
        }
        WGPURenderPassDepthStencilAttachment auxDepth{};
        auxDepth.view = depthView_; auxDepth.depthReadOnly = true;
        WGPURenderPassDescriptor auxDesc{};
        auxDesc.colorAttachmentCount = count; auxDesc.colorAttachments = targets.data();
        auxDesc.depthStencilAttachment = &auxDepth;
        auto auxPass = beginTimedRenderPass(encoder, &auxDesc, 2, {"aux", inputWidth_, inputHeight_});
        replay(auxPass, auxBundle_, auxBundleKey_, job.auxKey, job.auxPlan, formats.data(), count, 1, job.auxRows,
               auxDelta_, auxDeltaKey_, auxTail_, auxTailKey_);
        wgpuRenderPassEncoderEnd(auxPass); wgpuRenderPassEncoderRelease(auxPass);
        lastFrame_.auxPasses = 1;
    }
    if (job.translucentActive && translucentView_) {
        // The transparent draws again, each with its own lit program, blending over a cleared target: what they
        // composited over the frame. Drawn in one pass, in the main pass's order, so overlapping sheets accumulate
        // exactly as they did there. Recorded directly (not a retained bundle): a translucent draw's depth order moves
        // with every camera turn, and the main pass keeps those draws out of its rows for the same reason.
        WGPURenderPassColorAttachment sheet = {};
        sheet.view = translucentView_;
        sheet.loadOp = WGPULoadOp_Clear;
        sheet.storeOp = WGPUStoreOp_Store;
        sheet.clearValue = {0, 0, 0, 0};
#if defined(MYSTRAL_WEBGPU_DAWN)
        sheet.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
#endif
        WGPURenderPassDepthStencilAttachment sheetDepth{};
        sheetDepth.view = depthView_; sheetDepth.depthReadOnly = true;
        WGPURenderPassDescriptor sheetDesc = {};
        sheetDesc.colorAttachmentCount = 1; sheetDesc.colorAttachments = &sheet;
        sheetDesc.depthStencilAttachment = &sheetDepth;
        auto sheetPass = beginTimedRenderPass(encoder, &sheetDesc, 2,
            {"translucent", inputWidth_, inputHeight_, uint32_t(job.translucentPlan.size())});
        for (const Planned& p : job.translucentPlan) encode(sheetPass, p, Tally::Extra);
        wgpuRenderPassEncoderEnd(sheetPass); wgpuRenderPassEncoderRelease(sheetPass);
    }
    if (traa_) {
        traa_->fillVelocity(encoder, depthView_);
        WGPURenderPassColorAttachment motion{};
        motion.view = traa_->velocityView(); motion.loadOp = WGPULoadOp_Load; motion.storeOp = WGPUStoreOp_Store;
        if (sampleCount_ == 4) {
            motion.view = msaaAuxColorView_;
            motion.loadOp = WGPULoadOp_Clear;
            motion.resolveTarget = traa_->velocityView();
        }
#if defined(MYSTRAL_WEBGPU_DAWN)
        motion.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
#endif
        WGPURenderPassDepthStencilAttachment motionDepth{};
        motionDepth.view = sampleCount_ == 4 ? msaaDepthView_ : depthView_; motionDepth.depthReadOnly = true;
        WGPURenderPassDescriptor motionDesc{};
        motionDesc.colorAttachmentCount = 1; motionDesc.colorAttachments = &motion;
        motionDesc.depthStencilAttachment = &motionDepth;
        const auto copyPrevious = [&] {
            for (std::size_t k = 0; k < kPreviousStorages.size(); ++k)
                if (job.previousBytes[k])
                    wgpuCommandEncoderCopyBufferToBuffer(encoder, gpu_.buffer(storages_.at(kPreviousStorages[k]).buffer), 0,
                        gpu_.buffer(storages_.at(std::string("traaPrevious_") + kPreviousStorages[k]).buffer), 0,
                        job.previousBytes[k]);
        };
        if (job.previousSeed) copyPrevious();
        auto velocityPass = beginTimedRenderPass(encoder, &motionDesc, 2, {"velocityObjects", inputWidth_, inputHeight_});
        const WGPUTextureFormat motionFormat = WGPUTextureFormat_RGBA16Float;
        replay(velocityPass, velocityBundle_, velocityBundleKey_, job.velocityKey, velocityPlan, &motionFormat, 1, sampleCount_,
               job.velocityRows, velocityDelta_, velocityDeltaKey_, velocityTail_, velocityTailKey_);
        wgpuRenderPassEncoderEnd(velocityPass); wgpuRenderPassEncoderRelease(velocityPass);
        copyPrevious();
        if (!lateTraa_) traa_->resolve(encoder, sceneColor_, sceneView_, depth_, depthView_);
    }
    // A game's RenderTarget the post graph samples is drawn where the frame first reads it, after the render-to-texture
    // passes its own scene samples: what the frame has recorded so far is submitted ahead of the target's draw.
    const auto recordSampledTargets = [&](WGPUCommandEncoder current) {
        if (std::none_of(deferred_.begin(), deferred_.end(), [&](const auto& entry) { return postSamples(entry.key); }))
            return current;
        submit(wgpuCommandEncoderFinish(current, nullptr));
        wgpuCommandEncoderRelease(current);
        recordDeferred(true);
        WGPUCommandEncoderDescriptor next = {};
        return wgpuDeviceCreateCommandEncoder(device_, &next);
    };
    const double postStarted = meterStart(cpuMetered_);
    if (postEffects_) {
        // three's Info counts each fullscreen effect pass as one draw of one triangle, like the output pass below.
        postEffects_->setHost(lateTraa_ ? PostEffects::HostPass([this](WGPUCommandEncoder resolveEncoder, WGPUTexture beauty,
                                                                     WGPUTextureView beautyView, WGPUTexture output,
                                                                     WGPUTextureView outputView) {
                                  traa_->resolve(resolveEncoder, beauty, beautyView, depth_, depthView_, output, outputView);
                              })
                              : PostEffects::HostPass());
        const uint32_t effectPasses = postEffects_->render(encoder, postScene(), depthView_, gpu_.buffer(outputTriangle_), camera, renderId_, frameTime_, static_cast<float>(output_.toneMappingExposure), &lights,
            [&](const std::string& input) {
                return std::any_of(postTextures_.begin(), postTextures_.end(), [&](const auto& texture) {
                    return texture.first == input && std::any_of(deferred_.begin(), deferred_.end(), [&](const auto& entry) { return entry.key == texture.second->renderTarget.lock().get(); });
                });
            },
            recordSampledTargets);
        lastFrame_.draws += effectPasses;
        lastFrame_.triangles += effectPasses;
    }
    encoder = recordSampledTargets(encoder);
    if (!sceneOnly_ && (writesOutput_ || presentTarget)) outputPass(encoder, presentTarget, presentFormat);
    addCpuStage(CpuPost, postStarted);
    const auto segments = passTimer_->segments;
    const auto passInfo = passTimer_->passes;
    const std::array<uint32_t, 4> extent{inputWidth_, inputHeight_, width_, height_};
    const bool resolveTiming = timed && !passTimer_->failed && !segments.empty();
    if (resolveTiming) {
        if (!timestampResolve_.type)
            timestampResolve_ = gpu_.createBuffer(FrameGpuTimer::maxPasses * 16, WGPUBufferUsage_QueryResolve | WGPUBufferUsage_CopySrc);
        wgpuCommandEncoderResolveQuerySet(encoder, passTimer_->queries, 0, uint32_t(segments.size()) * 2, gpu_.buffer(timestampResolve_), 0);
        waste::debugAdd(waste::counters().timestampResolves);
        if (!job.debugTimestampRequested) waste::debugAdd(waste::counters().gpuTimestampUnrequestedSamples);
    }
    WGPUCommandBufferDescriptor commandDesc = {};
    submit(wgpuCommandEncoderFinish(encoder, &commandDesc));
    deformationFrames_.swap(job.deformationFrames);
    wgpuCommandEncoderRelease(encoder);
    if (resolveTiming) {
        passTimer_->pending = true;
        std::weak_ptr<Timing> timing = timing_;
        const auto timer = passTimer_;
        gpu_.readBuffer(timestampResolve_, 0, segments.size() * 16, [timing, timer, segments, passInfo, extent, source, shadowQueries](GpuStatus status, std::vector<uint8_t> bytes) {
            timer->pending = false;
            const auto t = timing.lock();
            if (!t || status != GpuStatus::Ok || bytes.size() != segments.size() * 16) return;
            std::array<double, kGpuSegments> sums{};
            const bool trace = !passInfo.empty() && passInfo.size() == segments.size();
            std::ostringstream profile;
            if (trace) profile << std::setprecision(12) << "TN_GPU_PASSES:{\"source\":" << source
                << ",\"input\":[" << extent[0] << ',' << extent[1] << "],\"output\":["
                << extent[2] << ',' << extent[3] << "],\"passes\":[";
            std::map<std::pair<std::shared_ptr<VirtualShadowCosts>, int>, double> levelCosts;
            // Begin offsets let a trace measure the frame's GPU span and any overlap the sum counts twice.
            uint64_t first = UINT64_MAX;
            for (size_t i = 0; i < segments.size(); ++i) {
                uint64_t begin;
                std::memcpy(&begin, bytes.data() + i * 16, sizeof begin);
                if (begin) first = std::min(first, begin);
            }
            for (size_t i = 0; i < segments.size(); ++i) {
                uint64_t ns[2];
                std::memcpy(ns, bytes.data() + i * 16, sizeof ns);
                if (!ns[0] || ns[1] < ns[0]) return;  // Missing/reset timestamps invalidate the whole frame.
                const double ms = double(ns[1] - ns[0]) / 1e6;
                sums[segments[i]] += ms;
                if (trace) profile << (i ? "," : "") << "{\"index\":" << i
                    << ",\"name\":" << std::quoted(passInfo[i].name)
                    << ",\"segment\":" << unsigned(segments[i])
                    << ",\"draws\":" << passInfo[i].draws
                    << ",\"width\":" << passInfo[i].width << ",\"height\":" << passInfo[i].height
                    << ",\"begin\":" << double(ns[0] - first) / 1e6 << ",\"ms\":" << ms << '}';
                if (const auto query = shadowQueries.find(i); query != shadowQueries.end())
                    if (const auto costs = query->second.first.lock()) levelCosts[{costs, query->second.second}] += ms;
            }
            const double total = std::accumulate(sums.begin(), sums.end(), 0.0);
            if (total <= 0) return;
            if (trace) {
                profile << "],\"ms\":" << total << "}\n";
                const auto line = profile.str();
                std::fwrite(line.data(), 1, line.size(), stdout);
            }
            for (const auto& [key, ms] : levelCosts) {
                std::lock_guard lock(key.first->mutex);
                auto& reading = key.first->levels[key.second]; reading.first = ms; ++reading.second;
            }
            t->lastMs = total;
            t->segments = sums;
            t->passes = uint32_t(segments.size());
            t->source = source;
            ++t->samples;
            waste::debugAdd(waste::counters().timestampSamplesDelivered);
        });
    }
    if (ownsPassTimer_) {
        passTimer_->segments.clear();
        passTimer_->passes.clear();
        passTimer_->failed = false;
    }
    {
        std::lock_guard lock(frameMailMutex_);
        lastFrame_.keptShadowMaps = job.keptShadowMaps;
        lastFrame_.uniformBytes = job.uniformBytes;
        lastFrame_.paletteWrites = job.paletteWrites;
        lastFrame_.shadowGroupRows = job.shadowGroupRows;
        lastFrame_.instanceCopies = job.instanceCopies;
        waste::debugAdd(waste::counters().renderFrames);
        waste::debugAdd(waste::counters().renderDraws, lastFrame_.draws);
        waste::debugAdd(waste::counters().shadowDraws, lastFrame_.shadowDraws);
        waste::debugAdd(waste::counters().auxPasses, lastFrame_.auxPasses);
        waste::debugAdd(waste::counters().uniformUploadBytes, job.uniformBytes);
        frameMail_ = lastFrame_;
    }
}

}  // namespace tn::engine
