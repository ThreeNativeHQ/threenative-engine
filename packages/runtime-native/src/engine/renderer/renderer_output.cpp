// The renderer: the output pass, post inputs, size and sample count, readbacks, mipmaps, compute and blits. PRD-840 split renderer.cpp by concern; renderer_internal.h holds what they share.
#include "engine/renderer/renderer_internal.h"

namespace tn::engine {

void Renderer::setOutput(const OutputState& output) {
    const bool programChanged = outputVertex_.wgsl.code.empty() || output.toneMapping != output_.toneMapping || output.srgb != output_.srgb || output.customToneMapping != output_.customToneMapping;
    output_ = output;
    if (!programChanged) return;
    if (postGraph_) {
        post_ = std::make_shared<shader::PostNode>(shader::graph::serializedPost(postGraph_, output.toneMapping, output.srgb, output.customToneMapping));
        postEffects_ = post_->passes.empty() ? nullptr : std::make_unique<PostEffects>(device_, queue_, post_->passes);
        if (postEffects_ && width_ && height_) postEffects_->resize(inputWidth_, inputHeight_, width_, height_, traa_ && !lateTraa_);
    }
    const shader::OutputPrograms programs = shader::buildOutput(output.toneMapping, output.srgb, post_.get(), true, output.customToneMapping);
    outputVertex_ = shader::buildStage(programs.vertex, 0);
    outputFragment_ = shader::buildStage(programs.fragment, 0);
    if (!outputVertex_.wgsl.ok() || !outputFragment_.wgsl.ok()) {
        const auto& errors = outputFragment_.wgsl.ok() ? outputVertex_.wgsl.errors : outputFragment_.wgsl.errors;
        throw std::runtime_error("TN_NATIVE_SHADER_INVALID: output program: " + errors.front());
    }
    collectPostSources();
    releaseOutputGroup();  // its layout belongs to the previous program
    // An explicit layout: the output program declares the scene binding even when a post graph
    // never samples it, and an automatic layout would drop it and refuse the bind group.
    if (outputPipelineLayout_) wgpuPipelineLayoutRelease(outputPipelineLayout_);
    if (outputLayout_) wgpuBindGroupLayoutRelease(outputLayout_);
    std::vector<WGPUBindGroupLayoutEntry> layoutEntries;
    for (const shader::Binding& b : outputFragment_.bindings) {
        WGPUBindGroupLayoutEntry e = {};
        e.binding = b.binding;
        e.visibility = WGPUShaderStage_Fragment;
        if (b.kind == shader::BindingKind::Uniform) {
            e.buffer.type = WGPUBufferBindingType_Uniform;
            e.buffer.minBindingSize = outputFragment_.uniformBlockSize;
        } else if (b.kind == shader::BindingKind::Texture) {
            e.texture.sampleType = b.depth ? WGPUTextureSampleType_Depth : WGPUTextureSampleType_Float;
            e.texture.viewDimension = b.volume ? WGPUTextureViewDimension_3D : b.array ? WGPUTextureViewDimension_2DArray : WGPUTextureViewDimension_2D;
        } else {
            e.sampler.type = WGPUSamplerBindingType_Filtering;
        }
        layoutEntries.push_back(e);
    }
    WGPUBindGroupLayoutDescriptor layoutDesc = {};
    layoutDesc.entryCount = layoutEntries.size();
    layoutDesc.entries = layoutEntries.data();
    outputLayout_ = wgpuDeviceCreateBindGroupLayout(device_, &layoutDesc);
    WGPUPipelineLayoutDescriptor pipelineLayoutDesc = {};
    pipelineLayoutDesc.bindGroupLayoutCount = 1;
    pipelineLayoutDesc.bindGroupLayouts = &outputLayout_;
    outputPipelineLayout_ = wgpuDeviceCreatePipelineLayout(device_, &pipelineLayoutDesc);
    gpu_.destroy(outputUniforms_);
    outputUniforms_ = gpu_.createBuffer(std::max<uint32_t>(16, outputFragment_.uniformBlockSize), WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst);
}

void Renderer::setPostNode(std::shared_ptr<const shader::PostNode> post) {
    postGraph_.reset();
    rttTargets_.clear();
    auto effects = post && !post->passes.empty() ? std::make_unique<PostEffects>(device_,queue_,post->passes) : nullptr;
    postEffects_.reset();
    postTextures_.clear();
    postTextureNodes_.clear();
    postTextureVersions_.clear();
    postTextureViews_.clear();
    postUniforms_ = post ? post->uniforms : std::map<std::string,std::vector<double>>{};
    post_ = std::move(post);
    outputVertex_ = {};  // rebuild the output program with (or without) the post graph
    const OutputState output = output_;
    setOutput(output);
    postEffects_ = std::move(effects);
    if (postEffects_ && width_ && height_) postEffects_->resize(inputWidth_, inputHeight_, width_, height_, traa_ && !lateTraa_);
}

void Renderer::setPostGraph(shader::graph::Node root) {
    const auto temporal = shader::graph::traaEffect(root);
    setPostNode(root ? std::make_shared<shader::PostNode>(shader::graph::serializedPost(root, output_.toneMapping, output_.srgb, output_.customToneMapping)) : nullptr);
    postGraph_ = root;
    if (temporal && temporal != liveTraa_) setTraa(TraaOptions{});
    if (!temporal && liveTraa_) { traa_.reset(); releaseOutputGroup(); applySampleCount(); }
    liveTraa_ = temporal;
    lateTraa_ = temporal && shader::graph::traaResolvesLate(*temporal);
    setSize(width_, height_);
    if (postEffects_) postEffects_->resize(inputWidth_, inputHeight_, width_, height_, traa_ && !lateTraa_);
    collectPostSources();
}

void Renderer::collectPostSources() {
    postTextures_.clear();
    postTextureNodes_.clear();
    rttTargets_.clear();
    translucentRequested_ = false;
    std::unordered_set<const shader::graph::NodeData*> seen;
    const std::function<void(shader::graph::Node)> collect = [&](shader::graph::Node node) {
        if (!node || !seen.insert(node.get()).second) return;
        if (node->rtt && node->rtt->target &&
            std::none_of(rttTargets_.begin(), rttTargets_.end(),
                         [&](const auto& target) { return target.name == node->name; }))
            rttTargets_.push_back({node->name, node->rtt, node->rtt->material ? node->rtt->material->version() : 0,
                                   node->rtt->material.get()});
        // The graph asks for the transparent draws' own target, in one of its passes or in the output program: the plan
        // draws it and the post input is bound, or the graph would sample a slot nothing fills.
        if (node->kind == shader::graph::Kind::Texture && node->name == "translucent") translucentRequested_ = true;
        if (node->kind == shader::graph::Kind::Texture && node->textureObject())
            { postTextures_.emplace_back(node->name, static_cast<const Texture*>(node->textureObject().get())); postTextureNodes_.push_back(node); }
        if (node->rtt && node->rtt->material)
            for (const auto& graph : node->rtt->material->nodes.graphs())
                collect(graph);
        for (const auto* list : {&node->args, &node->body, &node->otherwise})
            for (const auto& child : *list) collect(child);
    };
    collect(postGraph_);
    collect(output_.customToneMapping);
}

void Renderer::setPostInput(const std::string& name, WGPUTextureView view) {
    if (!postEffects_) throw std::runtime_error("TN_POST_GRAPH_MISSING");
    postEffects_->input(name,view);
    releaseOutputGroup();
}

void Renderer::setTraa(const TraaOptions& options) {
    traa_ = std::make_unique<TraaPass>(device_, queue_, options);
    if (!traaStats_.type)
        traaStats_ = gpu_.createBuffer(8, WGPUBufferUsage_Storage | WGPUBufferUsage_CopyDst | WGPUBufferUsage_CopySrc);
    traa_->setStatsBuffer(gpu_.buffer(traaStats_));
    releaseOutputGroup();
    applySampleCount();
    setSize(width_, height_);
    traa_->resize(inputWidth_, inputHeight_, width_, height_);
}

void Renderer::cutHistory() { if (traa_) traa_->cameraCut(); }

// The frame before this one counted what its resolve did with the history, and its commands are submitted: ask for the two
// counters. They land on the event queue, so the newest counted frame is a few frames old by the time a reader sees it.
void Renderer::readTraaCounts() {
    const auto measure = traa_ ? traa_->takeMeasure() : std::nullopt;
    if (!measure) return;
    gpu_.readBuffer(traaStats_, 0, 8, [counts = traaCounts_, measure = *measure](GpuStatus status, std::vector<uint8_t> bytes) {
        if (status != GpuStatus::Ok || bytes.size() != 8) return;
        uint32_t values[2];
        std::memcpy(values, bytes.data(), sizeof values);
        waste::debugAdd(waste::counters().temporalRejectedPixels, values[0]);
        waste::debugAdd(waste::counters().temporalClampedPixels, values[1]);
        waste::debugAdd(waste::counters().temporalMeasuredPixels, measure.pixels);
        counts->rejected = values[0];
        counts->clamped = values[1];
        counts->pixels = measure.pixels;
        counts->frame = measure.frame;
    });
}

void Renderer::setSceneFormat(WGPUTextureFormat format) {
    if (format == sceneFormat_) return;
    sceneFormat_ = format;
    applySampleCount();
    if (!width_) return;
    const uint32_t width = width_, height = height_;
    width_ = height_ = 0;  // setSize returns early at the same extent
    setSize(width, height);
}

void Renderer::setSampleCount(uint32_t samples) {
    if (samples != 1 && samples != 4)
        throw std::runtime_error("TN_NATIVE_SAMPLES_UNSUPPORTED: sampleCount must be 1 or 4");
    requestedSamples_ = samples;
    applySampleCount();
}

// Temporal AA replaces multisampling, as one method does in Unreal. The velocity pass tests depth Equal against the
// colour pass, and 4x multisampling hands it one resolved sample of depth, so Equal fails on every sloped surface.
void Renderer::applySampleCount() {
    const bool float32 = sceneFormat_ == WGPUTextureFormat_RGBA32Float || sceneFormat_ == WGPUTextureFormat_RG32Float;
    const uint32_t samples = traa_ || float32 ? 1 : requestedSamples_;  // a float32 colour cannot resolve
    if (traa_ && requestedSamples_ == 4) {
        const std::string note = "TN_TRAA_MSAA_OFF: temporal AA replaces 4x multisampling, so the scene draws single-sampled";
        if (std::find(diagnostics_.begin(), diagnostics_.end(), note) == diagnostics_.end()) diagnostics_.push_back(note);
    }
    if (samples == sampleCount_) return;
    sampleCount_ = samples;
    dropBundles();
    if (width_ && height_) {
        const uint32_t w = width_, h = height_;
        width_ = height_ = 0;
        setSize(w, h);
    }
}

// Full-screen triangle, as pageClear builds it. The fragment writes sample 0 of the multisampled depth.
constexpr const char* kDepthResolveWgsl = R"(
@group(0) @binding(0) var msaaDepth: texture_depth_multisampled_2d;

@vertex
fn vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
    let x = select(-1.0, 3.0, index == 1u);
    let y = select(-1.0, 3.0, index == 0u);
    return vec4<f32>(x, y, 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) position: vec4<f32>) -> @builtin(frag_depth) f32 {
    return textureLoad(msaaDepth, vec2<i32>(position.xy), 0);
}
)";

// ponytail: sample 0 stands in for the pixel depth, so an edge pixel uses one sample's depth.
// Upgrade: take the min or max of the four samples, if depth-based effects show edge errors.
// Resolves msaaDepth_ into depth_ with a full-screen pass that writes frag_depth.
void Renderer::resolveDepth(WGPUCommandEncoder encoder) {
    if (!depthResolve_) {
        WGPUShaderModuleWGSLDescriptor_Compat wgsl = {};
        WGPUShaderModuleDescriptor shaderDesc = {};
        setupShaderModuleWGSL(&shaderDesc, &wgsl, kDepthResolveWgsl);
        WGPUShaderModule module = wgpuDeviceCreateShaderModule(device_, &shaderDesc);
        WGPUFragmentState fragment = {};
        fragment.module = module;
        WGPU_SET_ENTRY_POINT(fragment, "fs");
        WGPUDepthStencilState depth = {};
        depth.format = WGPUTextureFormat_Depth32Float;
        depth.depthWriteEnabled = WGPU_OPTIONAL_BOOL_TRUE;
        depth.depthCompare = WGPUCompareFunction_Always;
        WGPURenderPipelineDescriptor desc = {};
        desc.vertex.module = module;
        WGPU_SET_ENTRY_POINT(desc.vertex, "vs");
        desc.primitive.topology = WGPUPrimitiveTopology_TriangleList;
        desc.multisample.count = 1;
        desc.multisample.mask = 0xffffffffu;
        desc.depthStencil = &depth;
        desc.fragment = &fragment;
        depthResolve_ = wgpuDeviceCreateRenderPipeline(device_, &desc);
        wgpuShaderModuleRelease(module);
        if (!depthResolve_) throw std::runtime_error("TN_NATIVE_PIPELINE_REFUSED: depth resolve");
    }
    const WGPUBindGroupLayout layout = wgpuRenderPipelineGetBindGroupLayout(depthResolve_, 0);
    WGPUBindGroupEntry entry = {};
    entry.binding = 0;
    entry.textureView = msaaDepthView_;
    WGPUBindGroupDescriptor groupDesc = {};
    groupDesc.layout = layout;
    groupDesc.entryCount = 1;
    groupDesc.entries = &entry;
    const WGPUBindGroup group = createBindGroup(device_, &groupDesc);
    WGPURenderPassDepthStencilAttachment depth = {};
    depth.view = depthView_;
    depth.depthLoadOp = WGPULoadOp_Clear;
    depth.depthStoreOp = WGPUStoreOp_Store;
    depth.depthClearValue = 1.0f;
    WGPURenderPassDescriptor passDesc = {};
    passDesc.depthStencilAttachment = &depth;
    WGPURenderPassEncoder pass = beginTimedRenderPass(encoder, &passDesc);
    wgpuRenderPassEncoderSetPipeline(pass, depthResolve_);
    wgpuRenderPassEncoderSetBindGroup(pass, 0, group, 0, nullptr);
    wgpuRenderPassEncoderDraw(pass, 3, 1, 0, 0);
    wgpuRenderPassEncoderEnd(pass);
    wgpuRenderPassEncoderRelease(pass);
    wgpuBindGroupRelease(group);
    wgpuBindGroupLayoutRelease(layout);
}

double Renderer::viewMipBias() const {
    if (!temporalStatus_.active) return 0;
    const double fraction = traa_ ? double(renderScale_) : 1.0;
    const double bias = std::clamp(std::max(-std::max(-std::log2(fraction), 0.0) - 0.3, -2.0), -4.0, 4.0);
    return std::ceil(bias * 128.0) / 128.0;  // 1024 steps over [-4, 4]
}

void Renderer::setRenderScale(float scale) {
    if (!std::isfinite(scale) || scale < 0.25f || scale > 1.f)
        throw std::runtime_error("TN_RENDER_SCALE_INVALID: expected a finite fraction in [0.25, 1]");
    if (scale == renderScale_) return;
    renderScale_ = scale;
    setSize(width_, height_);
}

void Renderer::setSize(uint32_t width, uint32_t height) {
    width = std::max(width, 1u);
    height = std::max(height, 1u);
    const float scale = traa_ ? renderScale_ : 1.f;
    const auto inputWidth = std::max(uint32_t(std::ceil(double(width) * 0.25)), uint32_t(std::round(double(width) * scale)));
    const auto inputHeight = std::max(uint32_t(std::ceil(double(height) * 0.25)), uint32_t(std::round(double(height) * scale)));
    if (width == width_ && height == height_ && inputWidth == inputWidth_ && inputHeight == inputHeight_) return;
    gpu_.sync();  // a posted blit still reads the targets released here
    releaseTargets();
    width_ = width;
    height_ = height;
    inputWidth_ = inputWidth;
    inputHeight_ = inputHeight;
    color_ = gpu_.createTexture(width, height, WGPUTextureFormat_RGBA8Unorm,
                                // TextureBinding too: a windowed player samples this finished frame to
                                // put it on the screen (Renderer::blitTo).
                                WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_CopySrc |
                                    WGPUTextureUsage_TextureBinding);
    WGPUTextureDescriptor depthDesc = {};
    depthDesc.dimension = WGPUTextureDimension_2D;
    depthDesc.size = {inputWidth, inputHeight, 1};
    depthDesc.format = WGPUTextureFormat_Depth32Float;
    depthDesc.usage = WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopySrc;
    depthDesc.mipLevelCount = 1;
    depthDesc.sampleCount = 1;
    depth_ = wgpuDeviceCreateTexture(device_, &depthDesc);
    WGPUTextureDescriptor sceneDesc = depthDesc;
    sceneDesc.format = sceneFormat_;
    // CopyDst: copyTextureToTexture writes into a render target's colour (three's texture copies into a target).
    sceneDesc.usage = WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopySrc |
                      WGPUTextureUsage_CopyDst;
    sceneColor_ = wgpuDeviceCreateTexture(device_, &sceneDesc);
    sceneView_ = view2d(sceneColor_, sceneFormat_);
    colorView_ = view2d(gpu_.texture(color_), WGPUTextureFormat_RGBA8Unorm);
    depthView_ = view2d(depth_, WGPUTextureFormat_Depth32Float);
    if (sampleCount_ == 4) {
        WGPUTextureDescriptor msaaDesc = depthDesc;
        msaaDesc.sampleCount = 4;
        // The depth resolve samples msaaDepth_, so that texture also takes TextureBinding.
        msaaDesc.usage = WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_TextureBinding;
        msaaDepth_ = wgpuDeviceCreateTexture(device_, &msaaDesc);
        msaaDepthView_ = view2d(msaaDepth_, WGPUTextureFormat_Depth32Float);
        msaaDesc.format = sceneFormat_;  // resolves into sceneColor_
        msaaDesc.usage = WGPUTextureUsage_RenderAttachment;
        msaaColor_ = wgpuDeviceCreateTexture(device_, &msaaDesc);
        msaaColorView_ = view2d(msaaColor_, sceneFormat_);
    }
    WGPUTextureDescriptor viewportDesc = sceneDesc;
    viewportDesc.usage = WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst;
    viewportColor_ = wgpuDeviceCreateTexture(device_, &viewportDesc);
    viewportColorView_ = view2d(viewportColor_, sceneFormat_);
    viewportDesc.format = WGPUTextureFormat_Depth32Float;
    viewportDepth_ = wgpuDeviceCreateTexture(device_, &viewportDesc);
    viewportDepthView_ = view2d(viewportDepth_, WGPUTextureFormat_Depth32Float);
    if (traa_) traa_->resize(inputWidth, inputHeight, width, height);
    if (postEffects_) postEffects_->resize(inputWidth, inputHeight, width, height, traa_ && !lateTraa_);
}

// One stage's bind group, from the bindings its package declares: the uniform block, and for a
// texture/sampler pair the view and sampler given.
// A stage's bind group: its uniform slice of `uniforms` (dynamic offset when the layout says so), and
// for a texture/sampler pair the view and sampler given.
uint64_t Renderer::postViewsStamp() const {
    return (postEffects_ ? postEffects_->viewsStamp() : 0) ^
           (postSource_ && postSource_->postEffects_ ? postSource_->postEffects_->viewsStamp() * 31 : 0);
}

// A post render-to-texture pass's output by name. A render target's own renderer has no post effects, so a material
// node there (rain's bloom pass reads the chain colour) reads the main renderer's, whose passes ran before the draw.
const PostEffects* Renderer::postTextureOwner(const std::string& name) const {
    if (postEffects_ && postEffects_->view(name)) return postEffects_.get();
    if (postSource_ && postSource_->postEffects_ && postSource_->postEffects_->view(name)) return postSource_->postEffects_.get();
    return nullptr;
}

WGPUTextureView Renderer::postScene() const { return traa_ && !lateTraa_ ? traa_->resultView() : sceneView_; }

WGPUTextureView Renderer::postTextureView(const std::string& name) const {
    const PostEffects* owner = postTextureOwner(name);
    return owner ? owner->view(name) : nullptr;
}

WGPUBindGroup Renderer::bindGroup(WGPUBindGroupLayout layout, const shader::StageModule& stage, Handle uniforms,
                                  WGPUTextureView view, WGPUSampler sampler, WGPUTextureView mapView,
                                  WGPUSampler mapSampler, WGPUTextureView envView, WGPUSampler envSampler,
                                  WGPUTextureView normalView, WGPUSampler normalSampler,
                                  const std::array<const MaterialTexture*, shader::kPbrMapCount>* pbrMaps,
                                  WGPUTextureView pmremView, WGPUSampler pmremSampler,
                                  const GraphReflectors* reflectors,
                                  const GraphTextures* graphTextures, RecentBindGroups* cache) {
    // A graph texture's GPU texture, by its `t_<name>` / `smp_<name>` binding; null for any other.
    const auto graph = [&](std::string_view name, bool sampler) -> const MaterialTexture* {
        if (!graphTextures) return nullptr;
        std::string_view label = name.substr(sampler ? 4 : 2);
        for (const auto& [positional, own] : stage.graphTextureLabels)  // positionalGraphTextures: the draw's own map
            if (label == positional) { label = own; break; }
        for (const auto& [own, texture] : *graphTextures)
            if (label == own) return materialTexture(*texture);
        return nullptr;
    };
    // A PbrMap's texture or sampler, by its `t_<name>` / `smp_<name>` binding; null for any other.
    const auto pbr = [&](std::string_view name, bool sampler) -> const MaterialTexture* {
        if (!pbrMaps) return nullptr;
        for (int k = 0; k < shader::kPbrMapCount; ++k)
            if (name == (sampler ? "smp_" : "t_") + std::string(shader::kPbrMapNames[k])) return (*pbrMaps)[k];
        return nullptr;
    };
    std::vector<WGPUBindGroupEntry> entries;
    for (const shader::Binding& b : stage.bindings) {
        WGPUBindGroupEntry e = {};
        e.binding = b.binding;
        // Cached programs outlive a detached virtual-shadow provider. Rebind when it returns.
        if (b.kind == shader::BindingKind::Storage && b.name.rfind("s_vsmTable", 0) == 0 &&
            !storages_.count(b.name.substr(2))) return nullptr;
        if (b.kind == shader::BindingKind::Uniform) {
            e.buffer = gpu_.buffer(uniforms);
            e.size = stage.uniformBlockSize;
        } else if (b.kind == shader::BindingKind::Storage && externalStorage_.count(b.name.substr(2))) {
            const auto& [buffer, bytes] = externalStorage_.at(b.name.substr(2)); // a positionNode's buffer
            e.buffer = (buffer.context == kGeometryHandles ? geometry_->gpu : gpu_).buffer(buffer);
            // A disposed attribute dropped its GPU copy: the handle here is dead until the frame's
            // storage pass re-syncs it from the live store. A drawn material is re-synced before this
            // point, so this only skips a program whose providing scene is gone. Never build a bind
            // group around a destroyed buffer, which downstream fails as `resource: undefined`.
            if (e.buffer == nullptr) return nullptr;
            e.size = bytes;
        } else if (b.kind == shader::BindingKind::Storage && storages_.count(b.name.substr(2))) {
            const FrameStorage& storage = storages_.at(b.name.substr(2)); // "s_<name>"
            e.buffer = gpu_.buffer(storage.buffer);
            // A storage a program names before the frame's upload pass has allocated it (a new one, such as
            // `shadowSkin` on its first grouped page) has no buffer yet: the pass allocates it and rebuildGroups
            // follows before the draw is encoded, so never build a group around a null buffer.
            if (e.buffer == nullptr) return nullptr;
            e.size = storage.capacity;
        } else if (sourceScene_ && &stage != &outputFragment_ && &stage != &blitFragment_ &&
                   (b.name == "t_scene" || b.name == "smp_scene" || b.name == "t_depth" ||
                                    b.name == "smp_depth" || viewportBinding(b.name))) {
            // The output and blit passes keep this renderer's own scene colour, also named t_scene.
            const bool sourceDepth =
                b.name.find("depth") != std::string::npos || b.name.find("Depth") != std::string::npos;
            if (b.kind == shader::BindingKind::Texture)
                e.textureView = sourceDepth ? sourceDepth_ : sourceScene_;
            else
                e.sampler = outputSampler_;
        } else if (viewportBinding(b.name)) {
            const bool depthCopy = b.name.find("Depth") != std::string::npos;
            if (b.kind == shader::BindingKind::Texture) e.textureView = depthCopy ? viewportDepthView_ : viewportColorView_;
            else e.sampler = depthCopy ? compareSampler_ : outputSampler_;
        } else if (b.name == "t_velocity" || b.name == "smp_velocity") {
            // The temporal pass's velocity target, read by name (motion blur). Nothing else draws one, and the
            // fallback below would hand the stage the scene colour as motion.
            if (!traa_) throw std::runtime_error("TN_POST_INPUT_MISSING: velocity is drawn only while a traa() effect is in the post graph");
            if (b.kind == shader::BindingKind::Texture) e.textureView = traa_->velocityView();
            else e.sampler = sampler;
        } else if (graphTextureBinding(b.kind == shader::BindingKind::Sampler ? "t_" + b.name.substr(4) : b.name)) {
            // A graph's own texture (texture(object), texture3D), checked before the 3D probe atlases.
            const MaterialTexture* texture = graph(b.name, b.kind == shader::BindingKind::Sampler);
            if (!texture) throw std::runtime_error("TN_NATIVE_BINDING_UNSUPPORTED: " + b.name + " has no texture this draw");
            if (b.kind == shader::BindingKind::Texture) e.textureView = texture->view;
            else e.sampler = texture->sampler;
        } else if (reflectorBinding(b.name)) {
            // A graph's own mirror pass (reflector): looked up by the mirror's name, so a material may
            // sample two of them, each with the view of its own pass.
            const bool sampler = b.kind == shader::BindingKind::Sampler;
            const std::string_view label = std::string_view(b.name).substr(sampler ? 4 : 2);
            const GraphReflector* mirror = nullptr;
            if (reflectors)
                for (const GraphReflector& entry : *reflectors)
                    if (entry.name == label) { mirror = &entry; break; }
            if (!mirror || !mirror->view)
                throw std::runtime_error("TN_NATIVE_BINDING_UNSUPPORTED: " + std::string(b.name) +
                                         " has no mirror pass this draw");
            if (sampler) e.sampler = mirror->sampler;
            else e.textureView = mirror->view;
        } else if (b.volume) {
            const auto& atlas = probeTextures_.at(b.name.substr(b.kind == shader::BindingKind::Texture ? 2 : 4));
            if (b.kind == shader::BindingKind::Texture) e.textureView = atlas.view;
            else e.sampler = atlas.sampler;
        } else if (b.kind == shader::BindingKind::Texture && b.name == "t_depth") {
            e.textureView = depthView_;
        } else if (b.depth) {
            // `t_shadow{i}` / `t_shadowCube{i}` and their samplers: direct light i's shadow map (2D, or a
            // point light's cube) and the comparison sampler.
            const bool virtualMap = b.name.find("vsm") != std::string::npos;
            const std::string prefix = virtualMap ? "vsm" : b.cube ? "shadowCube" : "shadow";
            const std::size_t index = std::stoul(b.name.substr(b.name.find(prefix) + prefix.size()));
            // A virtual shadow this scene does not have leaves the group to the draw's own group (a cached program
            // from a torn-down scene keeps a null one). One this scene has but that holds no atlas view is a fault:
            // name it here, because a null texture binding reaches the port as an invalid descriptor and aborts the
            // module with no line of ours in the trace.
            if (virtualMap) {
                const auto shadow = virtualShadows_.find(index);
                if (shadow == virtualShadows_.end()) return nullptr;
                if (!shadow->second.map.view)
                    throw std::runtime_error("TN_VIRTUAL_SHADOW_UNINITIALISED: t_vsm" + std::to_string(index) +
                                             " has no atlas view");
            }
            if (b.kind == shader::BindingKind::Texture)
                e.textureView = virtualMap ? virtualShadows_.at(index).map.view : (b.cube ? cubeShadowMaps_ : shadowMaps_).at(index).view;
            else e.sampler = b.values ? depthValueSampler_ : compareSampler_;
        } else if (b.kind == shader::BindingKind::Texture) {
            const auto postView = postTextureView(b.name.substr(2));
            const MaterialTexture* pbrTexture = pbr(b.name, false);
            e.textureView = postView ? postView : pbrTexture ? pbrTexture->view : b.name == "t_map" ? mapView : b.name == "t_normalMap" ? normalView : b.name == "t_env" ? envView
                            : b.name == "t_pmrem" ? pmremView : view;
        } else if (b.kind == shader::BindingKind::Sampler) {
            const PostEffects* const postOwner = postTextureOwner(b.name.substr(4));
            const MaterialTexture* pbrTexture = pbr(b.name, true);
            e.sampler = postOwner ? postOwner->sampler(b.name.substr(4)) : pbrTexture ? pbrTexture->sampler : b.name == "smp_map" ? mapSampler : b.name == "smp_normalMap" ? normalSampler : b.name == "smp_env" ? envSampler
                        : b.name == "smp_pmrem" ? pmremSampler : sampler;
        } else {
            throw std::runtime_error("TN_NATIVE_BINDING_UNSUPPORTED: " + b.name);
        }
        entries.push_back(e);
    }
    WGPUBindGroupDescriptor desc = {};
    desc.layout = layout;
    desc.entryCount = entries.size();
    desc.entries = entries.data();
    return cache ? cache->get(device_, layout, entries) : createBindGroup(device_, &desc);
}

namespace {
uint64_t outputPassCount = 0;
}

uint64_t outputPassesRecorded() { return outputPassCount; }

void Renderer::outputPass(WGPUCommandEncoder encoder, WGPUTextureView present, WGPUTextureFormat presentFormat) {
    ++outputPassCount;
    PipelineTarget outputTarget{present ? presentFormat : WGPUTextureFormat_RGBA8Unorm, WGPUTextureFormat_Undefined, WGPUCullMode_None};
    outputTarget.layout = outputPipelineLayout_;
    // overlayRenderer(): the output is premultiplied (buildOutput), so it composites "over" the frame on the surface.
    const bool over = outputOver_ && present;
    if (over) outputTarget.blend = 3;
    WGPURenderPipeline pipeline = pipelines_->get(outputVertex_, &outputFragment_, outputTarget);
    if (!pipeline) throw std::runtime_error("TN_NATIVE_PIPELINE_REFUSED: output program");
    std::vector<uint8_t> block(std::max<uint32_t>(outputFragment_.uniformBlockSize, 4));
    // post_->live was copied into postUniforms_ while the frame was planned: the game writes those nodes.
    postUniforms_["time"] = {frameTime_};
    postUniforms_["deltaTime"] = {frameDelta_};
    // `screenSize` in an output graph is the drawing buffer, as it is in the render-target quads that draw before it.
    // Left at zero it turned any stage that divides by it (the vignette's aspect ratio) into NaN, a black frame.
    postUniforms_["screenSize"] = {static_cast<float>(width_), static_cast<float>(height_)};
    for (const auto& field : outputFragment_.uniforms) {
        const auto value = postUniforms_.find(field.name);
        if (value == postUniforms_.end()) continue;
        shader::writeUniform(block, field, value->second);
    }
    put(block, outputFragment_, "toneMappingExposure", std::array<double, 1>{output_.toneMappingExposure});
    if (outputFragment_.uniformBlockSize) gpu_.writeBuffer(outputUniforms_, 0, block.data(), outputFragment_.uniformBlockSize);
    // The explicit output layout is shared by the offscreen and the presenting pipeline, so one
    // group serves both and needs no rebuild when the present format changes.
    WGPUBindGroup& group = outputGroup_;
    if (!group) {
        group = bindGroup(outputLayout_, outputFragment_, outputUniforms_, postScene(), outputSampler_, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, &postTextures_, &outputGroups_);
    }
    WGPURenderPassColorAttachment color = {};
    color.view = present ? present : colorView_;
    color.loadOp = over ? WGPULoadOp_Load : WGPULoadOp_Clear;
    color.storeOp = WGPUStoreOp_Store;
#if defined(MYSTRAL_WEBGPU_DAWN)
    color.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
#endif
    WGPURenderPassDescriptor passDesc = {};
    passDesc.colorAttachmentCount = 1;
    passDesc.colorAttachments = &color;
    WGPURenderPassEncoder pass = beginTimedRenderPass(encoder, &passDesc, ownsPassTimer_ ? 3 : 2, {"output", width_, height_});
    wgpuRenderPassEncoderSetPipeline(pass, pipeline);
    wgpuRenderPassEncoderSetBindGroup(pass, 0, group, 0, nullptr);
    wgpuRenderPassEncoderSetVertexBuffer(pass, outputVertex_.attributes.at(0).location, gpu_.buffer(outputTriangle_), 0, 24);
    wgpuRenderPassEncoderDraw(pass, 3, 1, 0, 0);
    // three's renderer.info counts its output QuadMesh as one draw of one triangle; so does this.
    ++lastFrame_.draws;
    ++lastFrame_.triangles;
    wgpuRenderPassEncoderEnd(pass);
    wgpuRenderPassEncoderRelease(pass);
}

GpuStatus Renderer::readProbePixels(ReadbackCallback done) {
    const uint32_t texelBytes = sceneFormat_ == WGPUTextureFormat_RGBA32Float ? 16u
                              : sceneFormat_ == WGPUTextureFormat_RG32Float  ? 8u
                              : sceneFormat_ == WGPUTextureFormat_RG16Float  ? 4u : 8u;
    return readRgba16(sceneColor_, std::move(done), texelBytes);
}

GpuStatus Renderer::readNormalPixels(ReadbackCallback done) { return readRgba16(normalTexture_, std::move(done)); }
GpuStatus Renderer::readAlbedoPixels(ReadbackCallback done) { return readRgba16(albedoTexture_, std::move(done)); }
GpuStatus Renderer::readEmissivePixels(ReadbackCallback done) { return readRgba16(emissiveTexture_, std::move(done)); }
GpuStatus Renderer::readIndirectPixels(ReadbackCallback done) { return readRgba16(indirectTexture_, std::move(done)); }

GpuStatus Renderer::readMrtPixels(std::string_view slot, uint32_t x, uint32_t y, uint32_t width, uint32_t height,
                                  ReadbackCallback done) {
    if (!done) return GpuStatus::OutOfRange;
    const auto found = mrtTextures_.find(std::string(slot));
    if (found == mrtTextures_.end() || !found->second) return GpuStatus::InvalidHandle;
    const WGPUTexture texture = found->second;
    const uint32_t full = wgpuTextureGetWidth(texture);
    return readRgba16(texture,
        [full, x, y, width, height, done = std::move(done)](GpuStatus status, std::vector<uint8_t> rows) {
            if (status != GpuStatus::Ok) {
                done(status, {});
                return;
            }
            auto region = cropRgba16Rows(rows, full, x, y, width, height);
            if (region.empty()) {
                done(GpuStatus::OutOfRange, {});
                return;
            }
            done(GpuStatus::Ok, std::move(region));
        });
}

GpuStatus Renderer::readRgba16(WGPUTexture texture, ReadbackCallback done, uint32_t texelBytes) {
    if (!done) return GpuStatus::OutOfRange;
    if (!texture) return GpuStatus::InvalidHandle;
    const uint32_t width = wgpuTextureGetWidth(texture), height = wgpuTextureGetHeight(texture),
                   row = width * texelBytes, pitch = (row + 255u) & ~255u;
    const Handle staging = gpu_.createBuffer(uint64_t(pitch) * height, WGPUBufferUsage_CopyDst | WGPUBufferUsage_CopySrc);
    WGPUCommandEncoderDescriptor descriptor{};
    auto encoder = wgpuDeviceCreateCommandEncoder(device_, &descriptor);
    WGPUTexelCopyTextureInfo source{}; source.texture = texture; source.aspect = WGPUTextureAspect_All;
    WGPUTexelCopyBufferInfo destination{}; destination.buffer = gpu_.buffer(staging);
    destination.layout.bytesPerRow = pitch; destination.layout.rowsPerImage = height;
    const WGPUExtent3D extent{width, height, 1};
    wgpuCommandEncoderCopyTextureToBuffer(encoder, &source, &destination, &extent);
    WGPUCommandBufferDescriptor command{};
    submit(wgpuCommandEncoderFinish(encoder, &command));
    wgpuCommandEncoderRelease(encoder);
    const auto result = gpu_.readBuffer(staging, 0, uint64_t(pitch) * height,
        [width, height, row, pitch, done = std::move(done)](GpuStatus status, std::vector<uint8_t> bytes) {
            if (status != GpuStatus::Ok || bytes.size() != uint64_t(pitch) * height) {
                done(status == GpuStatus::Ok ? GpuStatus::OutOfRange : status, {}); return;
            }
            std::vector<uint8_t> packed(uint64_t(row) * height);
            for (uint32_t y = 0; y < height; ++y)
                std::memcpy(packed.data() + uint64_t(y) * row, bytes.data() + uint64_t(y) * pitch, row);
            done(GpuStatus::Ok, std::move(packed));
        });
    gpu_.destroy(staging);
    return result;
}

GpuStatus Renderer::readPixels(ReadbackCallback done) { return gpu_.readTexture(color_, std::move(done)); }

GpuStatus Renderer::readPresented(ReadbackCallback done) {
    if (!colorView_) return GpuStatus::InvalidHandle;
    if (!presentedView_ || presentedWidth_ != width_ || presentedHeight_ != height_) {
        if (presentedView_) {
            wgpuTextureViewRelease(presentedView_);
            gpu_.destroy(presented_);
        }
        presented_ = gpu_.createTexture(width_, height_, WGPUTextureFormat_RGBA8Unorm,
                                        WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_CopySrc);
        presentedView_ = view2d(gpu_.texture(presented_), WGPUTextureFormat_RGBA8Unorm);
        presentedWidth_ = width_;
        presentedHeight_ = height_;
    }
    if (!blitTo(nullptr, presentedView_, WGPUTextureFormat_RGBA8Unorm)) return GpuStatus::InvalidHandle;
    return gpu_.readTexture(presented_, std::move(done));
}

// The output triangle again, this time sampling the finished RGBA8 frame into a window surface. The
// program's own variant is chosen by the target format, so a BGRA swapchain gets a BGRA pipeline.
WGPURenderPipeline Renderer::copyPipeline(WGPUTextureFormat format, uint8_t blend,
    std::vector<std::shared_ptr<PipelineCompilation>>* compilation) {
    if (blitVertex_.wgsl.code.empty()) {
        const shader::OutputPrograms copy = shader::buildOutput(std::nullopt, false);
        blitVertex_ = shader::buildStage(copy.vertex, 0);
        blitFragment_ = shader::buildStage(copy.fragment, 0);
    }
    const PipelineTarget target{format, WGPUTextureFormat_Undefined, WGPUCullMode_None, blend};
    if (compilation) {
        compilation->push_back(pipelines_->getAsync(blitVertex_, &blitFragment_, target));
        return nullptr;
    }
    return pipelines_->get(blitVertex_, &blitFragment_, target);
}

// WebGPUTextureUtils.generateMipmaps: each level is drawn from a one-level view of the level above,
// sampled bilinearly at its texel centres, so only level 0 crosses from the CPU. An sRGB view decodes
// on the read and encodes on the write, so the chain filters in linear light.
void Renderer::generateMipmaps(WGPUTexture texture, WGPUTextureFormat format, uint32_t levels, uint32_t layers) {
    WGPURenderPipeline pipeline = copyPipeline(format, 0);
    if (!pipeline) throw std::runtime_error("TN_NATIVE_TEXTURE_MIPMAPS_FAILED: no copy pipeline");
    WGPUBindGroupLayout layout = wgpuRenderPipelineGetBindGroupLayout(pipeline, 0);
    if (!mipEncoder_) {
        WGPUCommandEncoderDescriptor encoderDesc = {};
        mipEncoder_ = wgpuDeviceCreateCommandEncoder(device_, &encoderDesc);
    }
    WGPUCommandEncoder encoder = mipEncoder_;
    std::vector<WGPUTextureView> views;  // layer-major: each layer's chain is levels long
    for (uint32_t layer = 0; layer < layers; ++layer)
        for (uint32_t level = 0; level < levels; ++level) {
            WGPUTextureViewDescriptor desc = {};
            desc.dimension = WGPUTextureViewDimension_2D;
            desc.format = format;
            desc.baseMipLevel = level;
            desc.mipLevelCount = 1;
            desc.baseArrayLayer = layer;
            desc.arrayLayerCount = 1;
            views.push_back(wgpuTextureCreateView(texture, &desc));
        }
    for (uint32_t step = 0; step < layers * (levels - 1); ++step) {
        const uint32_t level = step % (levels - 1) + 1, base = step / (levels - 1) * levels;
        WGPUBindGroup group = bindGroup(layout, blitFragment_, outputUniforms_, views[base + level - 1], linearClampSampler());
        if (!group) throw std::runtime_error("TN_NATIVE_TEXTURE_MIPMAPS_FAILED: no bind group");
        mipGroups_.push_back(group);
        WGPURenderPassColorAttachment color = {};
        color.view = views[base + level];
        color.loadOp = WGPULoadOp_Clear;
        color.storeOp = WGPUStoreOp_Store;
#if defined(MYSTRAL_WEBGPU_DAWN)
        color.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
#endif
        WGPURenderPassDescriptor passDesc = {};
        passDesc.colorAttachmentCount = 1;
        passDesc.colorAttachments = &color;
        WGPURenderPassEncoder pass = beginTimedRenderPass(encoder, &passDesc);
        wgpuRenderPassEncoderSetPipeline(pass, pipeline);
        wgpuRenderPassEncoderSetBindGroup(pass, 0, group, 0, nullptr);
        wgpuRenderPassEncoderSetVertexBuffer(pass, blitVertex_.attributes.at(0).location, gpu_.buffer(outputTriangle_), 0, 24);
        wgpuRenderPassEncoderDraw(pass, 3, 1, 0, 0);
        wgpuRenderPassEncoderEnd(pass);
        wgpuRenderPassEncoderRelease(pass);
    }
    wgpuBindGroupLayoutRelease(layout);
    for (WGPUTextureView view : views) mipViews_.push_back(view);
}

// One submit for every chain recorded since the last flush: a submit costs a queue call and a
// work-done callback each, and a scene load uploads hundreds of mipmapped textures.
void Renderer::flushMipmaps() {
    if (!mipEncoder_) return;
    WGPUCommandBufferDescriptor commandDesc = {};
    gpu_.submit(wgpuCommandEncoderFinish(mipEncoder_, &commandDesc));
    wgpuCommandEncoderRelease(mipEncoder_);
    mipEncoder_ = nullptr;
    for (WGPUBindGroup group : mipGroups_) wgpuBindGroupRelease(group);
    for (WGPUTextureView view : mipViews_) wgpuTextureViewRelease(view);
    mipGroups_.clear();
    mipViews_.clear();
}

GraphCompute& Renderer::graphCompute() {
    if (!graphCompute_) graphCompute_ = std::make_unique<GraphCompute>(device_, geometry_->gpu, geometry_->cache);
    return *graphCompute_;
}

void Renderer::prepareCompute(const shader::graph::Node& node) { (void)graphCompute().prepare(node); }

void Renderer::dispatchCompute(const ComputeDispatch& dispatch) {
    std::string error;
    dispatchCompute(std::span(&dispatch, 1), [&](const std::string& why) { error = why; });
    if (!error.empty()) throw std::runtime_error(error);
}

void Renderer::dispatchCompute(std::span<const ComputeDispatch> dispatches, const std::function<void(const std::string&)>& failed) {
    FrameGpuTimer::Scope timerScope(passTimer_.get());
    WGPUCommandEncoderDescriptor desc = {};
    WGPUCommandEncoder encoder = wgpuDeviceCreateCommandEncoder(device_, &desc);
    // The clock moves once per rendered frame, as three's NodeFrame does; a dispatch before the first render gets 1/60.
    const float now = std::chrono::duration<float>(std::chrono::steady_clock::now() - start_).count();
    if (renderId_ != computeFrame_) {
        computeDelta_ = computeFrame_ == ~uint64_t{0} ? 1.0f / 60.0f : std::max(0.0f, now - computeTime_);
        computeTime_ = now;
        computeFrame_ = renderId_;
    }
    ComputeBatch batch = graphCompute().batch();
    std::vector<WGPUBuffer> reads;
    for (const ComputeDispatch& dispatch : dispatches) {
        try {
            const auto bound = graphCompute().record(encoder, dispatch, {now, computeDelta_}, *this, &batch);
            reads.insert(reads.end(), bound.begin(), bound.end());
        } catch (const std::exception& error) {
            failed(error.what());
        }
    }
    if (!batch.pass) {
        wgpuCommandEncoderRelease(encoder);
        return;
    }
    wgpuComputePassEncoderEnd(batch.pass);
    wgpuComputePassEncoderRelease(batch.pass);
    WGPUCommandBufferDescriptor commandDesc = {};
    // Its own submission, batched with the frame's next one: a queue write to a buffer it binds sends it first,
    // so the uniform blocks written for these dispatches are not rewritten before they run.
    flushMipmaps();
    gpu_.submit(wgpuCommandEncoderFinish(encoder, &commandDesc), std::move(reads));
    wgpuCommandEncoderRelease(encoder);
}

GpuStatus Renderer::readStorage(const BufferAttribute& attribute, ReadbackCallback done) {
    BufferStore& store = *attribute.store;
    const Handle buffer = geometry_->cache.sync(store, WGPUBufferUsage_Storage | WGPUBufferUsage_CopySrc | WGPUBufferUsage_CopyDst);
    const uint64_t bytes = store.byteLength();
    const uint64_t padded = (bytes + 3) & ~uint64_t{3};
    return geometry_->gpu.readBuffer(buffer, 0, padded, [bytes, done = std::move(done)](GpuStatus status, std::vector<uint8_t> data) {
        if (data.size() > bytes) data.resize(bytes);
        done(status, std::move(data));
    });
}

void Renderer::releaseStorage(const BufferAttribute& attribute) { geometry_->cache.forget(*attribute.store); }

uint64_t Renderer::submit(WGPUCommandBuffer commands) {
    flushMipmaps();
    return gpu_.submit(commands);
}

bool Renderer::blitTo(WGPUQueue, WGPUTextureView target, WGPUTextureFormat format) {
    if (!target) return false;
    auto plan = prepareBlit(format);
    if (!plan) return false;
    submit(encodeBlit(*plan, target));
    return true;
}

std::optional<Renderer::BlitPlan> Renderer::prepareBlit(WGPUTextureFormat format) {
    if (!colorView_) return std::nullopt;
    // The finished frame is already tone mapped and encoded: the blit copies it, never re-encodes it.
    BlitPlan plan;
    plan.device = device_;
    plan.pipeline = copyPipeline(format, 0);
    if (!plan.pipeline) return std::nullopt;
    WGPUBindGroupLayout layout = wgpuRenderPipelineGetBindGroupLayout(plan.pipeline, 0);
    plan.group = bindGroup(layout, blitFragment_, outputUniforms_, colorView_, outputSampler_);
    wgpuBindGroupLayoutRelease(layout);
    if (!plan.group) return std::nullopt;
    plan.triangle = gpu_.buffer(outputTriangle_);
    plan.location = blitVertex_.attributes.at(0).location;
    // The UI overlay's frame over the world, in the same pass: the same copy program samples it, and
    // premultiplied "over" blending keeps whatever the page left transparent.
    if (overlayView_) {
        plan.over = copyPipeline(format, 3);
        if (plan.over) {
            WGPUBindGroupLayout overLayout = wgpuRenderPipelineGetBindGroupLayout(plan.over, 0);
            plan.overGroup = bindGroup(overLayout, blitFragment_, outputUniforms_, overlayView_, outputSampler_);
            wgpuBindGroupLayoutRelease(overLayout);
        }
    }
    return plan;
}

WGPUCommandBuffer Renderer::encodeBlit(BlitPlan& plan, WGPUTextureView target) {
    WGPUCommandEncoderDescriptor encoderDesc = {};
    WGPUCommandEncoder encoder = wgpuDeviceCreateCommandEncoder(plan.device, &encoderDesc);
    WGPURenderPassColorAttachment color = {};
    color.view = target;
    color.loadOp = WGPULoadOp_Clear;
    color.storeOp = WGPUStoreOp_Store;
    color.clearValue = {0, 0, 0, 1};
#if defined(MYSTRAL_WEBGPU_DAWN)
    color.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
#endif
    WGPURenderPassDescriptor passDesc = {};
    passDesc.colorAttachmentCount = 1;
    passDesc.colorAttachments = &color;
    WGPURenderPassEncoder pass = beginTimedRenderPass(encoder, &passDesc);
    wgpuRenderPassEncoderSetPipeline(pass, plan.pipeline);
    wgpuRenderPassEncoderSetBindGroup(pass, 0, plan.group, 0, nullptr);
    wgpuRenderPassEncoderSetVertexBuffer(pass, plan.location, plan.triangle, 0, 24);
    wgpuRenderPassEncoderDraw(pass, 3, 1, 0, 0);
    if (plan.overGroup) {
        wgpuRenderPassEncoderSetPipeline(pass, plan.over);
        wgpuRenderPassEncoderSetBindGroup(pass, 0, plan.overGroup, 0, nullptr);
        wgpuRenderPassEncoderDraw(pass, 3, 1, 0, 0);
    }
    wgpuRenderPassEncoderEnd(pass);
    wgpuRenderPassEncoderRelease(pass);
    WGPUCommandBufferDescriptor commandDesc = {};
    WGPUCommandBuffer commands = wgpuCommandEncoderFinish(encoder, &commandDesc);
    wgpuCommandEncoderRelease(encoder);
    wgpuBindGroupRelease(plan.group);
    if (plan.overGroup) wgpuBindGroupRelease(plan.overGroup);
    plan.group = plan.overGroup = nullptr;
    return commands;
}

void Renderer::setOverlay(const uint8_t* pixels, uint32_t width, uint32_t height, uint64_t version, uint32_t stride,
                          bool bgra) {
    // overlayView_ is set exactly while overlay_ names a live texture.
    const auto release = [this] {
        if (!overlayView_) return;
        wgpuTextureViewRelease(overlayView_);
        overlayView_ = nullptr;
        gpu_.destroy(overlay_);
        overlay_ = {};
    };
    if (!pixels || width == 0 || height == 0) {
        release();
        overlayWidth_ = overlayHeight_ = 0;
        overlayVersion_ = 0;
        return;
    }
    if (overlayView_ && version == overlayVersion_ && width == overlayWidth_ && height == overlayHeight_ &&
        bgra == overlayBgra_)
        return;
    // The texture's own format reads B,G,R,A as colour, so the shared copy program needs no swizzle.
    const WGPUTextureFormat format = bgra ? WGPUTextureFormat_BGRA8Unorm : WGPUTextureFormat_RGBA8Unorm;
    if (!overlayView_ || width != overlayWidth_ || height != overlayHeight_ || bgra != overlayBgra_) {
        release();
        overlay_ = gpu_.createTexture(width, height, format, WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst);
        overlayView_ = view2d(gpu_.texture(overlay_), format);
        overlayWidth_ = width;
        overlayHeight_ = height;
        overlayBgra_ = bgra;
    }
    const uint32_t row = width * 4;
    if (stride != 0 && stride != row) {
        overlayRows_.resize(size_t(row) * height);
        for (uint32_t y = 0; y < height; ++y) std::memcpy(overlayRows_.data() + size_t(y) * row, pixels + size_t(y) * stride, row);
        pixels = overlayRows_.data();
    }
    gpu_.writeTexture(overlay_, pixels, uint64_t(row) * height, true);  // a full-screen copy per HUD change was 4% of Midway
    overlayVersion_ = version;
    ++overlayUploads_;
}

}  // namespace tn::engine
