#include "effects.h"
#include "engine/renderer/pipeline_cache.h"
#include "engine/renderer/renderer.h"
#include "engine/renderer/graph/render_graph.h"
#include "engine/foundation/math/Matrix.h"
#include "mystral/webgpu_compat.h"
#include <algorithm>
#include <cmath>
#include <cstring>
#include <stdexcept>

namespace tn::engine {
namespace {
WGPUSampler makeSampler(WGPUDevice device, bool nearest, bool repeat) {
    WGPUSamplerDescriptor desc{};
    desc.minFilter = desc.magFilter = nearest ? WGPUFilterMode_Nearest : WGPUFilterMode_Linear;
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
void writeUniform(std::vector<uint8_t>& block, const shader::UniformField& field, const std::vector<float>& values) {
    const auto& t = field.type;
    if (values.size() != size_t(t.rows) * t.cols)
        throw std::runtime_error("TN_POST_UNIFORM_SIZE: " + field.name);
    const size_t stride = t.isMatrix() ? shader::uniformLayout(shader::Type::vec(t.rows)).align : t.rows * 4;
    for (size_t col = 0; col < t.cols; col++)
        std::memcpy(block.data() + field.offset + col * stride, values.data() + col * t.rows, t.rows * 4);
}
} // namespace

PostEffects::PostEffects(WGPUDevice device, WGPUQueue queue, std::vector<shader::graph::PostPass> sources)
    : device_(device), queue_(queue), pipelines_(device) {
    // Validate all packages before allocating any GPU resources.
    for (const auto& source : sources) {
        std::string error;
        if (!shader::acceptPackage(source.package, error))
            throw std::runtime_error(error);
    }
    linear_ = makeSampler(device, false, false);
    try {
        for (auto& source : sources) {
            passes_.push_back({std::move(source)});
            auto& pass = passes_.back();
            const auto& stages = pass.source.package.variants.at(0).stages;
            std::vector<WGPUBindGroupLayoutEntry> entries;
            for (const auto& binding : stages[1].bindings) {
                WGPUBindGroupLayoutEntry entry{};
                entry.binding = binding.binding;
                entry.visibility = WGPUShaderStage_Fragment;
                if (binding.kind == shader::BindingKind::Uniform) {
                    entry.buffer.type = WGPUBufferBindingType_Uniform;
                    entry.buffer.minBindingSize = stages[1].uniformBlockSize;
                } else if (binding.kind == shader::BindingKind::Texture) {
                    entry.texture.sampleType = binding.depth ? WGPUTextureSampleType_Depth : WGPUTextureSampleType_Float;
                    entry.texture.viewDimension = WGPUTextureViewDimension_2D;
                } else {
                    entry.sampler.type = WGPUSamplerBindingType_Filtering;
                }
                entries.push_back(entry);
            }
            WGPUBindGroupLayoutDescriptor layoutDesc{};
            layoutDesc.entryCount = entries.size();
            layoutDesc.entries = entries.data();
            pass.layout = wgpuDeviceCreateBindGroupLayout(device, &layoutDesc);
            WGPUPipelineLayoutDescriptor pipelineLayoutDesc{};
            pipelineLayoutDesc.bindGroupLayoutCount = 1;
            pipelineLayoutDesc.bindGroupLayouts = &pass.layout;
            pass.pipelineLayout = wgpuDeviceCreatePipelineLayout(device, &pipelineLayoutDesc);
            PipelineTarget target{pass.source.redFormat ? WGPUTextureFormat_R8Unorm : WGPUTextureFormat_RGBA16Float,
                                  WGPUTextureFormat_Undefined, WGPUCullMode_None};
            target.layout = pass.pipelineLayout;
            pass.pipeline = pipelines_.get(stages[0], &stages[1], target);
            if (!pass.pipeline)
                throw std::runtime_error("TN_POST_PIPELINE_REFUSED: " + pass.source.output);
            if (stages[1].uniformBlockSize) {
                WGPUBufferDescriptor desc{};
                desc.size = stages[1].uniformBlockSize;
                desc.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
                pass.uniforms = wgpuDeviceCreateBuffer(device, &desc);
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
        throw;
    }
}
PostEffects::~PostEffects() {
    clearTargets();
    for (auto& pass : passes_) {
        if (pass.uniforms)
            wgpuBufferRelease(pass.uniforms);
        wgpuPipelineLayoutRelease(pass.pipelineLayout);
        wgpuBindGroupLayoutRelease(pass.layout);
    }
    for (auto& [name, image] : images_) {
        wgpuSamplerRelease(image.sampler);
        wgpuTextureViewRelease(image.view);
        wgpuTextureRelease(image.texture);
    }
    wgpuSamplerRelease(linear_);
}
void PostEffects::releaseGroups() {
    for (auto& pass : passes_) {
        if (pass.group)
            wgpuBindGroupRelease(pass.group);
        pass.group = nullptr;
        pass.groupEntries.clear();
    }
}
void PostEffects::clearTargets() {
    releaseGroups();
    for (auto& [name, target] : targets_) {
        wgpuTextureViewRelease(target.view);
        wgpuTextureRelease(target.texture);
    }
    targets_.clear();
    for (auto& pass : passes_)
        pass.rendered = false;
}
void PostEffects::resize(uint32_t width, uint32_t height) {
    if (width == width_ && height == height_)
        return;
    clearTargets();
    width_ = width;
    height_ = height;
    for (const auto& pass : passes_) {
        auto& target = targets_[pass.source.output];
        const auto rounding = pass.source.floorSize ? 0.0f : 0.5f;
        target.width = std::max(
            1u, uint32_t(std::floor((pass.source.width ? pass.source.width : width) * pass.source.resolutionScale +
                                    rounding)));
        target.height = std::max(
            1u, uint32_t(std::floor((pass.source.height ? pass.source.height : height) * pass.source.resolutionScale +
                                    rounding)));
        target.format = pass.source.redFormat ? WGPUTextureFormat_R8Unorm : WGPUTextureFormat_RGBA16Float;
        target.texture = makeTexture(device_, target.width, target.height, target.format,
                                     WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_TextureBinding);
        target.view = wgpuTextureCreateView(target.texture, nullptr);
    }
}
bool PostEffects::syncScales() {
    bool changed = false;
    for (auto& pass : passes_)
        if (pass.source.effect && pass.source.effect->resolutionScale != pass.source.resolutionScale) {
            pass.source.resolutionScale = pass.source.effect->resolutionScale;
            changed = true;
        }
    if (!changed || !width_ || !height_)
        return false;
    const uint32_t width = width_, height = height_;
    width_ = height_ = 0;
    resize(width, height);
    return true;
}
void PostEffects::input(const std::string& name, WGPUTextureView view) {
    if (name == "scene" || name == "depth" || targets_.contains(name) || images_.contains(name))
        throw std::runtime_error("TN_POST_INPUT_RESERVED: " + name);
    if (view)
        inputs_[name] = view;
    else
        inputs_.erase(name);
}
bool PostEffects::reads(const std::string& name) const {
    for (const auto& pass : passes_)
        for (const auto& [binding, read] : pass.source.reads)
            if (read == name) return true;
    return false;
}
WGPUTextureView PostEffects::view(const std::string& name) const {
    if (const auto it = targets_.find(name); it != targets_.end())
        return it->second.view;
    if (const auto it = images_.find(name); it != images_.end())
        return it->second.view;
    if (const auto it = inputs_.find(name); it != inputs_.end())
        return it->second;
    return nullptr;
}
WGPUSampler PostEffects::sampler(const std::string& name) const {
    if (const auto it = images_.find(name); it != images_.end())
        return it->second.sampler;
    return linear_;
}
void PostEffects::render(WGPUCommandEncoder encoder, WGPUTextureView scene, WGPUTextureView depth, WGPUBuffer triangle,
                         const CameraState& camera, uint64_t frame) {
    graph::RenderGraph graph;
    std::map<std::string, graph::ResourceId> resources;
    const graph::TextureDesc desc{width_, height_, uint32_t(WGPUTextureFormat_RGBA16Float),
                                  uint32_t(WGPUTextureUsage_TextureBinding | WGPUTextureUsage_RenderAttachment)};
    for (const auto& [name, image] : images_)
        resources[name] = graph.external(name, {image.width, image.height, uint32_t(WGPUTextureFormat_RGBA8Unorm),
                                                uint32_t(WGPUTextureUsage_TextureBinding)});
    resources["scene"] = graph.external("scene", desc);
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
    for (const auto index : plan.order) {
        auto& pass = passes_.at(index);
        if (!pass.source.autoUpdate && pass.rendered)
            continue;
        const auto& target = targets_.at(pass.source.output);
        const auto& stages = pass.source.package.variants.at(0).stages;
        const auto& fragment = stages[1];
        auto values = pass.source.uniforms;
        for (const auto& node : pass.source.live)
            values[node->name] = node->values;
        if (pass.source.effect)
            for (const auto& [name, value] : pass.source.effect->parameters)
                if (name != "sampleVectors") values[name] = value;
        values["resolution"] = {float(target.width), float(target.height)};
        values["postTargetSize"] = {float(target.width), float(target.height)};
        values["_cameraProjectionMatrix"] = {camera.projectionMatrix.begin(), camera.projectionMatrix.end()};
        values["_cameraProjectionMatrixInverse"] = {inverse.elements.begin(), inverse.elements.end()};
        constexpr float rotations[]{60, 300, 180, 240, 120, 0};
        values["_temporalDirection"] = {pass.source.temporal ? rotations[frame % 6] / 360.0f : 0.0f};
        if (pass.uniforms) {
            std::vector<uint8_t> block(fragment.uniformBlockSize);
            for (const auto& field : fragment.uniforms) {
                const auto value = values.find(field.name);
                if (value == values.end())
                    throw std::runtime_error("TN_POST_UNIFORM_MISSING: " + field.name);
                writeUniform(block, field, value->second);
            }
            wgpuQueueWriteBuffer(queue_, pass.uniforms, 0, block.data(), block.size());
        }
        std::vector<WGPUBindGroupEntry> entries;
        for (const auto& binding : fragment.bindings) {
            WGPUBindGroupEntry entry{};
            entry.binding = binding.binding;
            if (binding.kind == shader::BindingKind::Uniform) {
                entry.buffer = pass.uniforms;
                entry.size = fragment.uniformBlockSize;
            } else {
                const auto& name =
                    pass.source.reads.at(binding.name.substr(binding.kind == shader::BindingKind::Texture ? 2 : 4));
                if (binding.kind == shader::BindingKind::Texture)
                    entry.textureView = name == "scene" ? scene : name == "depth" ? depth : view(name);
                else
                    entry.sampler = sampler(name);
                if (binding.kind == shader::BindingKind::Texture && !entry.textureView)
                    throw std::runtime_error("TN_POST_INPUT_MISSING: " + name);
            }
            entries.push_back(entry);
        }
        const auto same = [](const WGPUBindGroupEntry& a, const WGPUBindGroupEntry& b) {
            return a.binding == b.binding && a.buffer == b.buffer && a.offset == b.offset && a.size == b.size &&
                   a.sampler == b.sampler && a.textureView == b.textureView;
        };
        if (!pass.group || !std::equal(entries.begin(), entries.end(), pass.groupEntries.begin(),
                                       pass.groupEntries.end(), same)) {
            if (pass.group)
                wgpuBindGroupRelease(pass.group);
            WGPUBindGroupDescriptor groupDesc{};
            groupDesc.layout = pass.layout;
            groupDesc.entryCount = entries.size();
            groupDesc.entries = entries.data();
            pass.group = createBindGroup(device_, &groupDesc);
            pass.groupEntries = entries;
        }
        const auto group = pass.group;
        WGPURenderPassColorAttachment color{};
        color.view = target.view;
        color.loadOp = WGPULoadOp_Clear;
        color.storeOp = WGPUStoreOp_Store;
        color.clearValue = {pass.source.clear, 0, 0, pass.source.clear ? 1.0 : 0.0};
#if defined(MYSTRAL_WEBGPU_DAWN)
        color.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
#endif
        WGPURenderPassDescriptor passDesc{};
        passDesc.colorAttachmentCount = 1;
        passDesc.colorAttachments = &color;
        const auto render = wgpuCommandEncoderBeginRenderPass(encoder, &passDesc);
        wgpuRenderPassEncoderSetPipeline(render, pass.pipeline);
        wgpuRenderPassEncoderSetBindGroup(render, 0, group, 0, nullptr);
        wgpuRenderPassEncoderSetVertexBuffer(render, 0, triangle, 0, 24);
        wgpuRenderPassEncoderDraw(render, 3, 1, 0, 0);
        wgpuRenderPassEncoderEnd(render);
        wgpuRenderPassEncoderRelease(render);
        pass.rendered = true;
    }
}
} // namespace tn::engine
