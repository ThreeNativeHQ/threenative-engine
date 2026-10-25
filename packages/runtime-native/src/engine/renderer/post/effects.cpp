#include "engine/renderer/frame_gpu_timer.h"
#include "effects.h"
#include "engine/scene/material.h"
#include "engine/scene/render_target.h"
#include "engine/scene/nodes.h"
#include "engine/scene/camera.h"
#include "engine/renderer/pipeline_cache.h"
#include "engine/renderer/renderer.h"
#include "engine/renderer/graph/render_graph.h"
#include "engine/foundation/math/Matrix.h"
#include "mystral/webgpu_compat.h"
#include <algorithm>
#include <cmath>
#include <cstring>
#include <stdexcept>
#include <set>

namespace tn::engine {
namespace {
WGPUSampler makeSampler(WGPUDevice device, bool nearest, bool repeat, int nearestMag = -1) {
    WGPUSamplerDescriptor desc{};
    desc.minFilter = nearest ? WGPUFilterMode_Nearest : WGPUFilterMode_Linear;
    desc.magFilter = (nearestMag < 0 ? nearest : nearestMag != 0) ? WGPUFilterMode_Nearest : WGPUFilterMode_Linear;
    desc.addressModeU = desc.addressModeV = repeat ? WGPUAddressMode_Repeat : WGPUAddressMode_ClampToEdge;
    desc.maxAnisotropy = 1;
    return wgpuDeviceCreateSampler(device, &desc);
}
WGPUTexture makeTexture(WGPUDevice device, uint32_t width, uint32_t height, WGPUTextureFormat format,
                        WGPUTextureUsage usage) {
    WGPUTextureDescriptor desc{};
    desc.dimension = WGPUTextureDimension_2D;
    desc.size = {width, height, 1};
    desc.format = format;
    desc.usage = usage;
    desc.sampleCount = desc.mipLevelCount = 1;
    return wgpuDeviceCreateTexture(device, &desc);
}
} // namespace

PostEffects::PostEffects(WGPUDevice device, WGPUQueue queue, std::vector<shader::graph::PostPass> sources)
    : device_(device), queue_(queue), pipelines_(device) {
    // Validate all packages before allocating any GPU resources.
    for (const auto& source : sources) {
        std::string error;
        if (source.host.empty() && !shader::acceptPackage(source.package, error))
            throw std::runtime_error(error);
    }
    linear_ = makeSampler(device, false, false);
    // A graph that reads the scene's depth binds it as a depth texture, whose sampler is a comparison one.
    WGPUSamplerDescriptor compare{};
    compare.minFilter = compare.magFilter = WGPUFilterMode_Nearest;
    compare.addressModeU = compare.addressModeV = WGPUAddressMode_ClampToEdge;
    compare.compare = WGPUCompareFunction_LessEqual;
    compare.maxAnisotropy = 1;
    compare_ = wgpuDeviceCreateSampler(device, &compare);
    try {
        for (auto& source : sources) {
            passes_.push_back({std::move(source)});
            auto& pass = passes_.back();
            // The renderer draws a host pass: it has no shader, bindings or uniforms of its own.
            if (!pass.source.host.empty()) continue;
            const auto& stages = pass.source.package.variants.at(0).stages;
            const auto layoutFor = [&](const shader::StageModule& stage, WGPUShaderStage visibility) {
                std::vector<WGPUBindGroupLayoutEntry> entries;
                for (const auto& binding : stage.bindings) {
                    WGPUBindGroupLayoutEntry entry{};
                    entry.binding = binding.binding;
                    entry.visibility = visibility;
                    if (binding.kind == shader::BindingKind::Uniform) {
                        entry.buffer.type = WGPUBufferBindingType_Uniform;
                        entry.buffer.minBindingSize = stage.uniformBlockSize;
                    } else if (binding.kind == shader::BindingKind::Texture) {
                        entry.texture.sampleType =
                            binding.depth ? WGPUTextureSampleType_Depth : WGPUTextureSampleType_Float;
                        entry.texture.viewDimension =
                            binding.volume ? WGPUTextureViewDimension_3D : WGPUTextureViewDimension_2D;
                    } else if (binding.kind == shader::BindingKind::Sampler) {
                        entry.sampler.type = binding.depth ? WGPUSamplerBindingType_Comparison : WGPUSamplerBindingType_Filtering;
                    } else
                        throw std::runtime_error("TN_POST_BINDING_UNSUPPORTED: " + binding.name);
                    entries.push_back(entry);
                }
                WGPUBindGroupLayoutDescriptor desc{};
                desc.entryCount = entries.size();
                desc.entries = entries.data();
                return wgpuDeviceCreateBindGroupLayout(device, &desc);
            };
            pass.layout = layoutFor(stages[1], WGPUShaderStage_Fragment);
            if (!stages[0].bindings.empty())
                pass.vertexLayout = layoutFor(stages[0], WGPUShaderStage_Vertex);
            const WGPUBindGroupLayout layouts[]{pass.layout, pass.vertexLayout};
            WGPUPipelineLayoutDescriptor pipelineLayoutDesc{};
            pipelineLayoutDesc.bindGroupLayoutCount = pass.vertexLayout ? 2 : 1;
            pipelineLayoutDesc.bindGroupLayouts = layouts;
            pass.pipelineLayout = wgpuDeviceCreatePipelineLayout(device, &pipelineLayoutDesc);
            PipelineTarget target{pass.source.redFormat ? WGPUTextureFormat_R8Unorm : WGPUTextureFormat_RGBA16Float,
                                  WGPUTextureFormat_Undefined, WGPUCullMode_None};
            if (pass.source.rtt && pass.source.rtt->material) {
                const auto& material = *pass.source.rtt->material;
                target.cull = material.side == Side::Double ? WGPUCullMode_None
                              : material.side == Side::Back ? WGPUCullMode_Front
                                                            : WGPUCullMode_Back;
                target.blend = material.blending == Blending::None ||
                                       (material.blending == Blending::Normal && !material.transparent)
                                   ? 0
                                   : uint8_t(material.blending);
            }
            target.layout = pass.pipelineLayout;
            pass.pipeline = pipelines_.get(stages[0], &stages[1], target);
            if (!pass.pipeline)
                throw std::runtime_error("TN_POST_PIPELINE_REFUSED: " + pass.source.output);
            for (size_t stage = 0; stage < 2; ++stage)
                if (stages[stage].uniformBlockSize) {
                    WGPUBufferDescriptor desc{};
                    desc.size = stages[stage].uniformBlockSize;
                    desc.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
                    (stage == 0 ? pass.vertexUniforms : pass.uniforms) = wgpuDeviceCreateBuffer(device, &desc);
                }
            for (const auto& sourceImage : pass.source.images) {
                auto& image = images_[sourceImage.name];
                image.width = sourceImage.width;
                image.height = sourceImage.height;
                image.texture = makeTexture(device, image.width, image.height, WGPUTextureFormat_RGBA8Unorm,
                                            WGPUTextureUsage_CopyDst | WGPUTextureUsage_TextureBinding);
                image.view = wgpuTextureCreateView(image.texture, nullptr);
                image.sampler = makeSampler(device, sourceImage.nearest, sourceImage.repeat);
                WGPUImageCopyTexture_Compat destination{};
                destination.texture = image.texture;
                destination.aspect = WGPUTextureAspect_All;
                WGPUTextureDataLayout_Compat layout{};
                layout.bytesPerRow = image.width * 4;
                layout.rowsPerImage = image.height;
                const WGPUExtent3D size{image.width, image.height, 1};
                wgpuQueueWriteTexture(queue, &destination, sourceImage.bytes.data(), sourceImage.bytes.size(), &layout,
                                      &size);
            }
        }
    } catch (...) {
        for (auto& pass : passes_) {
            if (pass.uniforms)
                wgpuBufferRelease(pass.uniforms);
            if (pass.vertexUniforms)
                wgpuBufferRelease(pass.vertexUniforms);
            if (pass.vertexLayout)
                wgpuBindGroupLayoutRelease(pass.vertexLayout);
            if (pass.pipelineLayout)
                wgpuPipelineLayoutRelease(pass.pipelineLayout);
            if (pass.layout)
                wgpuBindGroupLayoutRelease(pass.layout);
        }
        for (auto& [name, image] : images_) {
            if (image.sampler)
                wgpuSamplerRelease(image.sampler);
            if (image.view)
                wgpuTextureViewRelease(image.view);
            if (image.texture)
                wgpuTextureRelease(image.texture);
        }
        wgpuSamplerRelease(linear_);
        wgpuSamplerRelease(compare_);
        throw;
    }
}
PostEffects::~PostEffects() {
    clearTargets();
    for (auto& pass : passes_) {
        if (pass.uniforms)
            wgpuBufferRelease(pass.uniforms);
        if (pass.vertexUniforms)
            wgpuBufferRelease(pass.vertexUniforms);
        if (pass.vertexLayout)
            wgpuBindGroupLayoutRelease(pass.vertexLayout);
        if (pass.pipelineLayout)
            wgpuPipelineLayoutRelease(pass.pipelineLayout);
        if (pass.layout)
            wgpuBindGroupLayoutRelease(pass.layout);
    }
    for (auto& [name, image] : images_) {
        wgpuSamplerRelease(image.sampler);
        wgpuTextureViewRelease(image.view);
        wgpuTextureRelease(image.texture);
    }
    wgpuSamplerRelease(linear_);
    wgpuSamplerRelease(compare_);
}
void PostEffects::releaseGroups() {
    for (auto& pass : passes_) {
        pass.groups.clear();
        pass.vertexGroups.clear();
        pass.group = pass.vertexGroup = nullptr;
    }
}
void PostEffects::clearTargets() {
    releaseGroups();
    for (auto& [name, target] : targets_) {
        if (target.sampler) wgpuSamplerRelease(target.sampler);
        wgpuTextureViewRelease(target.view);
        wgpuTextureRelease(target.texture);
    }
    targets_.clear();
    for (auto& pass : passes_)
        pass.rendered = false;
}
std::array<uint32_t, 2> PostEffects::targetSize(const std::string& name) const {
    const auto texture = targets_.at(name).texture;
    return {wgpuTextureGetWidth(texture), wgpuTextureGetHeight(texture)};
}

void PostEffects::resize(uint32_t width, uint32_t height, uint32_t outputWidth, uint32_t outputHeight,
                         bool sceneResolved) {
    if (!outputWidth) outputWidth = width;
    if (!outputHeight) outputHeight = height;
    if (width == width_ && height == height_ && outputWidth == outputWidth_ && outputHeight == outputHeight_ &&
        sceneResolved == sceneResolved_)
        return;
    clearTargets();
    width_ = width;
    height_ = height;
    outputWidth_ = outputWidth;
    outputHeight_ = outputHeight;
    sceneResolved_ = sceneResolved;
    std::set<std::string> displayInputs;
    if (sceneResolved) displayInputs.insert("scene");
    // Serialized passes can arrive out of dependency order; propagate the resolve's extent before allocating.
    for (size_t iteration = 0; iteration < passes_.size(); ++iteration) {
        bool changed = false;
        for (const auto& pass : passes_) {
            const bool display = pass.source.host == "traa" ||
                std::any_of(pass.source.reads.begin(), pass.source.reads.end(), [&](const auto& read) {
                    return displayInputs.contains(read.second);
                });
            if (display) changed |= displayInputs.insert(pass.source.output).second;
        }
        if (!changed) break;
    }
    for (auto& pass : passes_) {
        pass.displaySized = displayInputs.contains(pass.source.output);
        const auto baseWidth = pass.displaySized ? outputWidth : width;
        const auto baseHeight = pass.displaySized ? outputHeight : height;
        auto& target = targets_[pass.source.output];
        const auto rounding = pass.source.floorSize ? 0.0f : 0.5f;
        target.width = std::max(
            1u, uint32_t(std::floor((pass.source.width ? pass.source.width : baseWidth) * pass.source.resolutionScale +
                                    rounding)));
        target.height = std::max(
            1u, uint32_t(std::floor((pass.source.height ? pass.source.height : baseHeight) * pass.source.resolutionScale +
                                    rounding)));
        target.width = std::max(1u, target.width >> pass.source.mipLevel);
        target.height = std::max(1u, target.height >> pass.source.mipLevel);
        if (pass.source.rtt) {
            target.sampler =
                makeSampler(device_, pass.source.rtt->minFilter == 1003, false, pass.source.rtt->magFilter == 1003);
            auto& state = *pass.source.rtt;
            if (state.target) {
                if (state.width == 0 && (state.autoUpdate || state.textureNeedsUpdate) &&
                    (state.target->width != target.width || state.target->height != target.height)) {
                    state.target->setSize(target.width, target.height);
                    state.textureNeedsUpdate = true;
                    ++state.revision;
                }
                target.width = state.target->width;
                target.height = state.target->height;
            } else {
                state.textureNeedsUpdate = true;
                ++state.revision;
            }
            pass.source.rtt->actualWidth = target.width;
            pass.source.rtt->actualHeight = target.height;
        }
        target.format = pass.source.redFormat ? WGPUTextureFormat_R8Unorm : WGPUTextureFormat_RGBA16Float;
        // A host pass copies what it reads and what it wrote (the resolve seeds and stores its history from them).
        const bool copied = std::any_of(passes_.begin(), passes_.end(), [&](const auto& host) {
            return !host.source.host.empty() &&
                   (host.source.output == pass.source.output || host.source.reads.at("beauty") == pass.source.output);
        });
        target.texture = makeTexture(device_, target.width, target.height, target.format,
                                     WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_TextureBinding |
                                         (copied ? WGPUTextureUsage_CopySrc : WGPUTextureUsage_None));
        target.view = wgpuTextureCreateView(target.texture, nullptr);
    }
}
bool PostEffects::syncScales() {
    bool changed = false, filtersChanged = false;
    for (auto& pass : passes_) {
        if (pass.source.rtt) {
            auto& r = *pass.source.rtt;
            if (r.target) {
                r.minFilter = r.target->texture->minFilter;
                r.magFilter = r.target->texture->magFilter;
                if ((r.minFilter != 1003 && r.minFilter != 1006) || (r.magFilter != 1003 && r.magFilter != 1006))
                    throw std::runtime_error("TN_NATIVE_RTT_FILTER: expected NearestFilter or LinearFilter");
                if (r.width == 0 && (r.autoUpdate || r.textureNeedsUpdate) &&
                    (r.target->width != std::max(1u, uint32_t(std::floor((pass.displaySized ? outputWidth_ : width_) * r.scale))) ||
                     r.target->height != std::max(1u, uint32_t(std::floor((pass.displaySized ? outputHeight_ : height_) * r.scale)))))
                    changed = true;

                if (const auto current = targets_.find(pass.source.output);
                    current != targets_.end() &&
                    (current->second.width != r.target->width || current->second.height != r.target->height))
                    changed = true;
            }
            if (pass.source.resolutionScale != r.scale || pass.source.width != r.width || pass.source.height != r.height) {
                pass.source.resolutionScale = r.scale; pass.source.width = r.width; pass.source.height = r.height;
                changed = true;
            }
            if (pass.rttMin != r.minFilter || pass.rttMag != r.magFilter) {
                pass.rttMin = r.minFilter; pass.rttMag = r.magFilter; filtersChanged = true;
                if (auto target = targets_.find(pass.source.output); target != targets_.end()) {
                    if (target->second.sampler) wgpuSamplerRelease(target->second.sampler);
                    target->second.sampler = makeSampler(device_, r.minFilter == 1003, false, r.magFilter == 1003);
                }
            }
            pass.source.autoUpdate = r.autoUpdate;
            if (pass.rttDisposal != r.disposal) { pass.rttDisposal = r.disposal; changed = true; }
        }
        if (pass.source.effect && pass.source.effect->resolutionScale != pass.source.resolutionScale) {
            pass.source.resolutionScale = pass.source.effect->resolutionScale;
            changed = true;
        }
    }
    if (filtersChanged) releaseGroups();
    if (!changed || !width_ || !height_)
        return filtersChanged;
    const uint32_t width = width_, height = height_;
    width_ = height_ = 0;
    resize(width, height, outputWidth_, outputHeight_, sceneResolved_);
    return true;
}
bool PostEffects::target(const std::string& name, WGPUTextureView view) {
    const auto pass = std::find_if(passes_.begin(), passes_.end(), [&](const auto& pass) {
        return pass.source.output == name && pass.source.rtt && pass.source.rtt->target;
    });
    if (pass == passes_.end() || !view)
        throw std::runtime_error("TN_POST_TARGET_INVALID: " + name);
    const auto previous = outputViews_.find(name);
    if (previous != outputViews_.end() && previous->second == view)
        return false;
    outputViews_[name] = view;
    releaseGroups();
    return true;
}
void PostEffects::input(const std::string& name, WGPUTextureView view, WGPUSampler sampler) {
    if (name == "scene" || name == "depth" || targets_.contains(name) || images_.contains(name))
        throw std::runtime_error("TN_POST_INPUT_RESERVED: " + name);
    if (sampler) inputSamplers_[name] = sampler; else inputSamplers_.erase(name);
    if (view)
        inputs_[name] = view;
    else
        inputs_.erase(name);
}
bool PostEffects::reads(const std::string& name) const {
    for (const auto& pass : passes_)
        for (const auto& [binding, read] : pass.source.reads)
            if (read == name)
                return true;
    return false;
}
WGPUTextureView PostEffects::view(const std::string& name) const {
    if (const auto it = outputViews_.find(name); it != outputViews_.end())
        return it->second;
    if (const auto it = targets_.find(name); it != targets_.end())
        return it->second.view;
    if (const auto it = images_.find(name); it != images_.end())
        return it->second.view;
    if (const auto it = inputs_.find(name); it != inputs_.end())
        return it->second;
    return nullptr;
}
uint64_t PostEffects::viewsStamp() const {
    uint64_t h = 0xcbf29ce484222325ull;
    const auto mix = [&h](uint64_t v) { h = (h ^ v) * 0x100000001b3ull; };
    for (const auto& [name, view] : outputViews_) mix(reinterpret_cast<uintptr_t>(view));
    for (const auto& [name, target] : targets_) mix(reinterpret_cast<uintptr_t>(target.view));
    return h;
}
WGPUSampler PostEffects::sampler(const std::string& name) const {
    if (const auto it = inputSamplers_.find(name); it != inputSamplers_.end())
        return it->second;
    if (const auto it = targets_.find(name); it != targets_.end() && it->second.sampler)
        return it->second.sampler;
    if (const auto it = images_.find(name); it != images_.end())
        return it->second.sampler;
    return linear_;
}
void PostEffects::captureUniforms() {
    for (auto& pass : passes_) {
        if (pass.source.rtt) {
            pass.rttRequested = pass.source.rtt->textureNeedsUpdate ? pass.source.rtt->revision : pass.rttRevision;
            pass.rttMin = pass.source.rtt->minFilter;
            pass.rttMag = pass.source.rtt->magFilter;
            pass.source.rtt->textureNeedsUpdate = false;
        }
        pass.captured.clear();
        for (const auto& node : pass.source.live)
            pass.captured[node->name] = node->values;
        if (pass.source.rtt && pass.source.rtt->quad) {
            auto& quad = *pass.source.rtt->quad;
            quad.updateMatrixWorld(true);
            static const auto projection = [] {
                OrthographicCamera camera(-1, 1, 1, -1, 0, 1);
                camera.coordinateSystem = CoordinateSystem::WebGPU;
                camera.updateProjectionMatrix();
                return camera.projectionMatrix;
            }();
            const auto put = [&](const char* name, const auto& matrix) {
                pass.captured[name] = std::vector<double>(matrix.elements.begin(), matrix.elements.end());
            };
            put("modelMatrix", quad.matrixWorld);
            put("viewMatrix", Matrix4{});
            put("cameraWorldMatrix", Matrix4{});
            put("cameraProjectionMatrix", projection);
            put("projectionMatrix", projection);
            Matrix3 normal;
            normal.getNormalMatrix(quad.matrixWorld);
            put("normalMatrix", normal);
            pass.captured["cameraPosition"] = {0, 0, 0};
        }
        if (pass.source.effect)
            for (const auto& [name, value] : pass.source.effect->parameters)
                if (name != "sampleVectors")
                    pass.captured[name] = value;
    }
    captured_ = true;
}
uint32_t PostEffects::render(WGPUCommandEncoder& encoder, WGPUTextureView scene, WGPUTextureView depth,
                             WGPUBuffer triangle, const CameraState& camera, uint64_t frame, float time, float exposure,
                             const LightState* lights, const std::function<bool(const std::string&)>& isDeferred,
                             const std::function<WGPUCommandEncoder(WGPUCommandEncoder)>& split) {
    if (!captured_)
        captureUniforms();
    captured_ = false;
    // three's deltaTime: this frame's time minus the one before (the first frame gets 1/60).
    const float delta = lastTime_ < 0 ? 1.0f / 60.0f : std::max(0.0f, time - lastTime_);
    lastTime_ = time;
    graph::RenderGraph graph;
    std::map<std::string, graph::ResourceId> resources;
    const graph::TextureDesc desc{width_, height_, uint32_t(WGPUTextureFormat_RGBA16Float),
                                  uint32_t(WGPUTextureUsage_TextureBinding | WGPUTextureUsage_RenderAttachment)};
    for (const auto& [name, image] : images_)
        resources[name] = graph.external(name, {image.width, image.height, uint32_t(WGPUTextureFormat_RGBA8Unorm),
                                                uint32_t(WGPUTextureUsage_TextureBinding)});
    resources["scene"] = graph.external("scene", {sceneResolved_ ? outputWidth_ : width_,
                                                    sceneResolved_ ? outputHeight_ : height_, desc.format, desc.usage});
    resources["depth"] = graph.external("depth", {width_, height_, uint32_t(WGPUTextureFormat_Depth32Float),
                                                  uint32_t(WGPUTextureUsage_TextureBinding)});
    for (const auto& [name, view] : inputs_)
        resources[name] = graph.external(name, desc);
    for (const auto& [name, target] : targets_)
        resources[name] = graph.transient(name, {target.width, target.height, uint32_t(target.format), desc.usage});
    for (const auto& pass : passes_) {
        std::vector<graph::Read> reads;
        for (const auto& [binding, name] : pass.source.reads) {
            if (!resources.contains(name))
                throw std::runtime_error("TN_POST_INPUT_MISSING: " + name);
            reads.push_back({resources.at(name)});
        }
        graph.pass(pass.source.output, graph::PassKind::Render, std::move(reads), {resources.at(pass.source.output)});
    }
    const auto plan = graph.compile();
    if (!plan.ok())
        throw std::runtime_error(plan.errors.front().code + ": " + plan.errors.front().detail);
    Matrix4 inverse;
    inverse.fromArray(camera.projectionMatrix.data()).invert();
    uint32_t drawn = 0;
    bool splitDone = false;
    for (const auto index : plan.order) {
        auto& pass = passes_.at(index);
        if (!pass.source.autoUpdate && (pass.source.rtt ? pass.rttRevision == pass.rttRequested : pass.rendered))
            continue;
        if (split && isDeferred && !splitDone)
            for (const auto& read : pass.source.reads)
                if (isDeferred(read.second)) {
                    encoder = split(encoder);
                    splitDone = true;
                    break;
                }
        auto& target = targets_.at(pass.source.output);
        if (!pass.source.host.empty()) {
            if (!host_)
                throw std::runtime_error("TN_POST_HOST_MISSING: " + pass.source.host);
            const auto& beauty = targets_.at(pass.source.reads.at("beauty"));
            host_(encoder, beauty.texture, beauty.view, target.texture, target.view);
            pass.rendered = true;
            ++drawn;  // three's Info counts the resolve like any other fullscreen effect pass
            continue;
        }
        if (pass.source.rtt)
            pass.rttRevision = pass.rttRequested;
        const auto& stages = pass.source.package.variants.at(0).stages;
        auto values = pass.source.uniforms;
        for (const auto& [name, value] : pass.captured)
            values[name] = value;
        values["time"] = {time};
        values["deltaTime"] = {delta};
        values["toneMappingExposure"] = {exposure};
        values["cameraNear"] = {static_cast<float>(camera.near)};
        values["cameraFar"] = {static_cast<float>(camera.far)};
        if (pass.source.rtt) {
            values["cameraNear"] = {0};
            values["cameraFar"] = {1};
        }
        values["resolution"] = {float(target.width), float(target.height)};
        values["postTargetSize"] = {float(target.width), float(target.height)};
        values["screenSize"] = {float(target.width), float(target.height)};
        values["_cameraProjectionMatrix"] = {camera.projectionMatrix.begin(), camera.projectionMatrix.end()};
        values["_cameraProjectionMatrixInverse"] = {inverse.elements.begin(), inverse.elements.end()};
        values["_cameraWorldMatrix"] = {camera.matrixWorld.begin(), camera.matrixWorld.end()};
        constexpr float rotations[]{60, 300, 180, 240, 120, 0};
        values["_temporalDirection"] = {pass.source.temporal ? rotations[frame % 6] / 360.0f : 0.0f};
        for (size_t stageIndex = 0; stageIndex < 2; ++stageIndex) {
            if (stageIndex == 0 && !pass.vertexLayout)
                continue;
            const auto& stage = stages[stageIndex];
            const auto buffer = stageIndex == 0 ? pass.vertexUniforms : pass.uniforms;
            const auto layout = stageIndex == 0 ? pass.vertexLayout : pass.layout;
            auto& cachedGroup = stageIndex == 0 ? pass.vertexGroup : pass.group;
            auto& cache = stageIndex == 0 ? pass.vertexGroups : pass.groups;
            if (buffer) {
                std::vector<uint8_t> block(stage.uniformBlockSize);
                for (const auto& field : stage.uniforms) {
                    constexpr std::string_view prefix = "authoredLightShadowMatrix";
                    if (field.name.starts_with(prefix)) {
                        if (!lights)
                            throw std::runtime_error("TN_NATIVE_LIGHT_STATE_MISSING");
                        const auto& matrix = lights->shadowMatrix(std::stoull(field.name.substr(prefix.size())));
                        values[field.name] = std::vector<double>(matrix.begin(), matrix.end());
                    }
                    const auto value = values.find(field.name);
                    if (value == values.end())
                        throw std::runtime_error("TN_POST_UNIFORM_MISSING: " + field.name);
                    shader::writeUniform(block, field, value->second);
                }
                wgpuQueueWriteBuffer(queue_, buffer, 0, block.data(), block.size());
            }
            std::vector<WGPUBindGroupEntry> entries;
            for (const auto& binding : stage.bindings) {
                WGPUBindGroupEntry entry{};
                entry.binding = binding.binding;
                if (binding.kind == shader::BindingKind::Uniform) {
                    entry.buffer = buffer;
                    entry.size = stage.uniformBlockSize;
                } else {
                    const auto& name =
                        pass.source.reads.at(binding.name.substr(binding.kind == shader::BindingKind::Texture ? 2 : 4));
                    if (binding.kind == shader::BindingKind::Texture)
                        entry.textureView = name == "scene" ? scene : name == "depth" ? depth : view(name);
                    else
                        entry.sampler = binding.depth ? compare_ : sampler(name);
                    if (binding.kind == shader::BindingKind::Texture && !entry.textureView)
                        throw std::runtime_error("TN_POST_INPUT_MISSING: " + name);
                }
                entries.push_back(entry);
            }
            cachedGroup = cache.get(device_, layout, entries);  // a ping-pong input hits one of the last two
        }
        const auto group = pass.group;
        WGPURenderPassColorAttachment color{};
        color.view = view(pass.source.output);
        color.loadOp = WGPULoadOp_Clear;
        color.storeOp = WGPUStoreOp_Store;
        color.clearValue = {pass.source.clear, 0, 0, pass.source.clear ? 1.0 : 0.0};
#if defined(MYSTRAL_WEBGPU_DAWN)
        color.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
#endif
        WGPURenderPassDescriptor passDesc{};
        passDesc.colorAttachmentCount = 1;
        passDesc.colorAttachments = &color;
        std::array<uint32_t, 2> extent{};
        if (auto* timer = FrameGpuTimer::current; timer && timer->trace) extent = targetSize(pass.source.output);
        const auto render = beginTimedRenderPass(encoder, &passDesc,
            pass.source.stage == shader::graph::kStageScreenSpaceGi ? kGpuGiSegment : 2,
            {"post", extent[0], extent[1]});
        if (pass.source.visible) {
            wgpuRenderPassEncoderSetPipeline(render, pass.pipeline);
            wgpuRenderPassEncoderSetBindGroup(render, 0, group, 0, nullptr);
            if (pass.vertexGroup)
                wgpuRenderPassEncoderSetBindGroup(render, 1, pass.vertexGroup, 0, nullptr);
            wgpuRenderPassEncoderSetVertexBuffer(render, 0, triangle, 0, 24);
            wgpuRenderPassEncoderDraw(render, 3, 1, 0, 0);
        }
        wgpuRenderPassEncoderEnd(render);
        wgpuRenderPassEncoderRelease(render);
        pass.rendered = true;
        if (pass.source.visible)
            ++drawn;
    }
    return drawn;
}
} // namespace tn::engine
