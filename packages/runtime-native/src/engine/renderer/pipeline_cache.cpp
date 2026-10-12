#include "pipeline_cache.h"

#include <bit>
#include <stdexcept>
#include <optional>

#include "mystral/webgpu_compat.h"

namespace tn::engine {

namespace {

WGPUVertexFormat vertexFormat(const shader::Type& t) {
    using S = shader::Type::Scalar;
    if (t.scalar == S::U32) return t.rows == 4 ? WGPUVertexFormat_Uint32x4 : WGPUVertexFormat_Uint32;
    switch (t.rows) {
        case 1: return WGPUVertexFormat_Float32;
        case 2: return WGPUVertexFormat_Float32x2;
        case 3: return WGPUVertexFormat_Float32x3;
        default: return WGPUVertexFormat_Float32x4;
    }
}

WGPUShaderModule module(WGPUDevice device, const std::string& code) {
    WGPUShaderModuleWGSLDescriptor_Compat wgsl = {};
    WGPUShaderModuleDescriptor desc = {};
    setupShaderModuleWGSL(&desc, &wgsl, code.c_str());
    return wgpuDeviceCreateShaderModule(device, &desc);
}

}  // namespace

PipelineCompilation::~PipelineCompilation() {
    if (pipeline_) wgpuRenderPipelineRelease(pipeline_);
}

WGPURenderPipeline PipelineCompilation::get() const {
    const int status = status_.load(std::memory_order_acquire);
    if (status == 0) throw std::runtime_error("TN_NATIVE_COMPILE_PENDING");
    if (status < 0) throw std::runtime_error("TN_NATIVE_PIPELINE_REFUSED: " + error_);
    return pipeline_;
}

void PipelineCompilation::complete(WGPURenderPipeline pipeline, const std::string& error, bool replace) {
#ifndef __EMSCRIPTEN__
    std::lock_guard lock(completionMutex_);
#endif
    if (ready() && !replace) {
        if (pipeline) wgpuRenderPipelineRelease(pipeline);
        return;
    }
    if (pipeline_) wgpuRenderPipelineRelease(pipeline_);
    pipeline_ = pipeline;
    error_ = error;
    status_.store(pipeline && error.empty() ? 1 : -1, std::memory_order_release);
}

struct PipelineCache::Pending : PipelineCompilation {
    IdKey id;
    bool named;
    WGPUDevice device;
    Pending(IdKey key, bool named, WGPUDevice device) : id(key), named(named), device(device) {
        wgpuDeviceAddRef(device);
        if (id.target.layout) wgpuPipelineLayoutAddRef(id.target.layout);
    }
    ~Pending() {
        if (id.target.layout) wgpuPipelineLayoutRelease(id.target.layout);
        wgpuDeviceRelease(device);
    }
};

PipelineCache::~PipelineCache() {
#ifndef __EMSCRIPTEN__
    {
        std::lock_guard lock(workMutex_);
        stopping_ = true;
        pending_.clear();
    }
    workReady_.notify_all();
    for (auto& worker : workers_) if (worker.joinable()) worker.join();
    for (auto& [key, request] : compiling_)
        if (!request->ready()) request->complete(nullptr, "compile cancelled during shutdown");
#endif
    for (auto& [key, pipeline] : pipelines_) {
        if (pipeline) wgpuRenderPipelineRelease(pipeline);
    }
}

bool PipelineCache::IdKey::operator==(const IdKey& o) const {
    return vertex == o.vertex && fragment == o.fragment && vertexSize == o.vertexSize &&
           fragmentSize == o.fragmentSize && target.color == o.target.color &&
           target.depth == o.target.depth && target.sampleCount == o.target.sampleCount &&
           target.cull == o.target.cull && target.blend == o.target.blend &&
           target.depthWrite == o.target.depthWrite && target.layout == o.target.layout &&
           target.skinIndex == o.target.skinIndex && target.frontFace == o.target.frontFace &&
           target.depthCompare == o.target.depthCompare && target.depthBias == o.target.depthBias &&
           target.depthBiasSlopeScale == o.target.depthBiasSlopeScale && target.instanceStepMask == o.target.instanceStepMask &&
           target.topology == o.target.topology && target.stripIndexFormat == o.target.stripIndexFormat;
}

namespace {
uint64_t bindGroupCount = 0;
}

WGPUBindGroup createBindGroup(WGPUDevice device, const WGPUBindGroupDescriptor* descriptor) {
    ++bindGroupCount;
    return wgpuDeviceCreateBindGroup(device, descriptor);
}

uint64_t bindGroupsCreated() { return bindGroupCount; }

size_t PipelineCache::IdKeyHash::operator()(const IdKey& key) const {
    // 64-bit on every target: size_t is 32 bits on wasm32, where `size << 32` was undefined and gave
    // equal keys different hashes, so every lookup missed and the alias map grew each frame.
    uint64_t h = 0;
    const auto mix = [&](uint64_t v) { h = (h ^ v) * 0x9e3779b97f4a7c15ull; h ^= h >> 29; };
    mix(key.vertex);
    mix(key.fragment);
    mix(uint64_t(key.vertexSize) ^ uint64_t(key.fragmentSize) << 32);
    mix(uint64_t(key.target.color) | uint64_t(key.target.depth) << 32 ^ uint64_t(key.target.sampleCount) << 48);
    mix(uint64_t(key.target.cull) | uint64_t(key.target.frontFace) << 8 | uint64_t(key.target.depthCompare) << 16 |
        uint64_t(key.target.skinIndex) << 32 | uint64_t(key.target.blend) << 56 | uint64_t(key.target.depthWrite) << 58);
    mix(reinterpret_cast<uintptr_t>(key.target.layout));
    mix(uint64_t(uint32_t(key.target.depthBias)) | uint64_t(std::bit_cast<uint32_t>(key.target.depthBiasSlopeScale)) << 32);
    mix(key.target.instanceStepMask);
    mix(uint64_t(key.target.topology) | uint64_t(key.target.stripIndexFormat) << 32);
    return size_t(h ^ h >> 32);
}

PipelineCache::IdKey PipelineCache::idKey(const shader::StageModule& vertex, const shader::StageModule* fragment,
                                         const PipelineTarget& target) {
    return {vertex.wgsl.id, fragment ? fragment->wgsl.id : 0, vertex.wgsl.code.size(),
            fragment ? fragment->wgsl.code.size() : 0, target};
}

std::string PipelineCache::textKey(const shader::StageModule& vertex, const shader::StageModule* fragment,
                                   const PipelineTarget& target) {
    std::string key = vertex.wgsl.code;
    key += '\x1f';
    if (fragment) key += fragment->wgsl.code;
    key += '\x1f' + std::to_string(target.color) + ':' + std::to_string(target.depth) + ':' + std::to_string(target.sampleCount) + ':' +
           std::to_string(target.cull) + ':' + std::to_string(target.blend) + ':' + std::to_string(target.depthWrite) +
           ':' + std::to_string(reinterpret_cast<uintptr_t>(target.layout)) + ':' + std::to_string(target.skinIndex) +
           ':' + std::to_string(target.frontFace) + ':' + std::to_string(target.depthCompare) + ':' +
           std::to_string(target.depthBias) + ':' + std::to_string(std::bit_cast<uint32_t>(target.depthBiasSlopeScale)) +
           ':' + std::to_string(target.instanceStepMask) + ':' + std::to_string(target.topology) + ':' +
           std::to_string(target.stripIndexFormat);
    return key;
}

void PipelineCache::poll() {
    for (auto it = compiling_.begin(); it != compiling_.end();) {
        auto request = it->second;
        if (!request->ready()) { ++it; continue; }
        auto ready = it++;
        const std::string key = ready->first;
        compiling_.erase(ready);
        if (request->status_.load(std::memory_order_acquire) < 0) continue;  // only its ticket rejects
        const auto pipeline = request->get();
        const auto [stored, inserted] = pipelines_.emplace(key, pipeline);
        if (inserted) wgpuRenderPipelineAddRef(pipeline);  // cache and completion each own a reference
        if (request->named) byId_.emplace(request->id, stored->second);
    }
}

WGPURenderPipeline PipelineCache::get(const shader::StageModule& vertex, const shader::StageModule* fragment,
                                      const PipelineTarget& target) {
    poll();
    const bool named = vertex.wgsl.id != 0 && (!fragment || fragment->wgsl.id != 0);
    const IdKey id = idKey(vertex, fragment, target);
    if (named)
        if (const auto found = byId_.find(id); found != byId_.end()) return found->second;
    ++textLookups_;
    const std::string key = textKey(vertex, fragment, target);
    if (const auto found = pipelines_.find(key); found != pipelines_.end()) {
        if (named) byId_.emplace(id, found->second);
        return found->second;
    }
    const auto pipeline = create(device_, vertex, fragment, target);
    if (!compiling_.contains(key)) ++compiles_;  // an in-flight key and its draw fallback count once
    if (!pipeline) return nullptr;
    pipelines_.emplace(key, pipeline);
    if (named) byId_.emplace(id, pipeline);
    if (const auto found = compiling_.find(key); found != compiling_.end()) {
        wgpuRenderPipelineAddRef(pipeline);
        found->second->complete(pipeline, {}, true);  // the draw fulfills the speculative ticket too
    }
    return pipeline;
}

std::shared_ptr<PipelineCompilation> PipelineCache::getAsync(const shader::StageModule& vertex,
    const shader::StageModule* fragment, const PipelineTarget& target) {
    poll();
    const bool named = vertex.wgsl.id != 0 && (!fragment || fragment->wgsl.id != 0);
    const IdKey id = idKey(vertex, fragment, target);
    const auto ready = [id, named, this](WGPURenderPipeline pipeline) {
        auto result = std::make_shared<Pending>(id, named, device_);
        wgpuRenderPipelineAddRef(pipeline);
        result->complete(pipeline);
        return result;
    };
    if (named)
        if (const auto found = byId_.find(id); found != byId_.end()) return ready(found->second);
    ++textLookups_;
    const std::string key = textKey(vertex, fragment, target);
    if (const auto found = pipelines_.find(key); found != pipelines_.end()) {
        if (named) byId_.emplace(id, found->second);
        return ready(found->second);
    }
    if (const auto found = compiling_.find(key); found != compiling_.end()) return found->second;
    auto pending = std::make_shared<Pending>(id, named, device_);
    compiling_.emplace(key, pending);
    ++compiles_;
#ifdef __EMSCRIPTEN__
    create(device_, vertex, fragment, target, pending);
#else
    std::lock_guard lock(workMutex_);
    for (auto& worker : workers_) {
        if (worker.joinable()) continue;
        worker = std::thread([this] {
            for (;;) {
                std::function<void()> job;
                {
                    std::unique_lock lock(workMutex_);
                    workReady_.wait(lock, [this] { return stopping_ || !pending_.empty(); });  // TN_WORKER_ONLY: only inside a compile worker
                    if (pending_.empty()) return;
                    job = std::move(pending_.front()); pending_.pop_front();
                }
                job();
            }
        });
    }
    pending_.push_back([pending, vertex, fragment = fragment ? std::optional(*fragment) : std::nullopt, target] {
        if (pending->ready()) return;  // a draw may have fulfilled this key while it was queued
        try { pending->complete(create(pending->device, vertex, fragment ? &*fragment : nullptr, target)); }
        catch (const std::exception& error) { pending->complete(nullptr, error.what()); }
        catch (...) { pending->complete(nullptr, "unknown pipeline compilation exception"); }
    });
    workReady_.notify_all();
#endif
    return pending;
}

WGPURenderPipeline PipelineCache::create(WGPUDevice device, const shader::StageModule& vertex,
    const shader::StageModule* fragment, const PipelineTarget& target, const std::shared_ptr<Pending>& pending) {
    // One vertex buffer per attribute, in location order: the renderer binds them the same way. The
    // instance attributes step per instance; the four instance-matrix columns are one mat4 per
    // instance, the same buffer bound four times at offsets 0, 16, 32 and 48.
    std::vector<WGPUVertexAttribute> attributes(vertex.attributes.size());
    std::vector<WGPUVertexBufferLayout> buffers(vertex.attributes.size());
    for (size_t i = 0; i < vertex.attributes.size(); ++i) {
        const shader::Type& t = vertex.attributes[i].type;
        const std::string& name = vertex.attributes[i].name;
        const bool matrixColumn = name.rfind("instanceMatrix", 0) == 0;
        attributes[i] = {};
        const bool skinIndex = name == "skinIndex";
        attributes[i].format = skinIndex ? target.skinIndex : vertexFormat(t);
        attributes[i].shaderLocation = vertex.attributes[i].location;
        buffers[i] = {};
        buffers[i].arrayStride = matrixColumn ? 64
                                 : skinIndex  ? (target.skinIndex == WGPUVertexFormat_Uint8x4    ? 4
                                                 : target.skinIndex == WGPUVertexFormat_Uint16x4 ? 8
                                                                                                 : 16)
                                              : uint64_t{t.rows} * 4;
        const bool perInstance = matrixColumn || name == "instanceColor" || (i < 64 && (target.instanceStepMask >> i) & 1u);
        buffers[i].stepMode = perInstance ? WGPUVertexStepMode_Instance : WGPUVertexStepMode_Vertex;
        buffers[i].attributeCount = 1;
        buffers[i].attributes = &attributes[i];
    }
#ifdef __EMSCRIPTEN__
    if (pending) wgpuDevicePushErrorScope(device, WGPUErrorFilter_Validation);
#endif
    WGPUShaderModule vs = module(device, vertex.wgsl.code);
    WGPUShaderModule fs = fragment ? module(device, fragment->wgsl.code) : nullptr;
    WGPURenderPipelineDescriptor desc = {};
    desc.layout = target.layout;
    desc.vertex.module = vs;
    WGPU_SET_ENTRY_POINT(desc.vertex, "main");
    desc.vertex.bufferCount = buffers.size();
    desc.vertex.buffers = buffers.data();
    desc.primitive.topology = target.topology;
    desc.primitive.stripIndexFormat = target.stripIndexFormat;
    desc.primitive.cullMode = target.cull;
    desc.primitive.frontFace = target.frontFace;
    desc.multisample.count = target.sampleCount;
    desc.multisample.mask = 0xffffffffu;
    WGPUDepthStencilState depth = {};
    depth.format = target.depth;
    depth.depthWriteEnabled = target.depthWrite ? WGPU_OPTIONAL_BOOL_TRUE : WGPU_OPTIONAL_BOOL_FALSE;
    depth.depthCompare = target.depthCompare;
    depth.depthBias = target.depthBias;
    depth.depthBiasSlopeScale = target.depthBiasSlopeScale;
    if (target.depth != WGPUTextureFormat_Undefined) desc.depthStencil = &depth;
    WGPUColorTargetState color = {};
    color.format = target.color;
    color.writeMask = WGPUColorWriteMask_All;
    // WebGPUPipelineUtils._getBlending without premultiplied alpha: NormalBlending, or AdditiveBlending;
    // 3 is premultiplied "over", a UI overlay's frame whose colour already carries its alpha.
    const WGPUBlendFactor dst = target.blend == 2 ? WGPUBlendFactor_One : WGPUBlendFactor_OneMinusSrcAlpha;
    const WGPUBlendFactor src = target.blend == 3 ? WGPUBlendFactor_One : WGPUBlendFactor_SrcAlpha;
    WGPUBlendState blend = {};
    blend.color = {WGPUBlendOperation_Add, src, dst};
    blend.alpha = {WGPUBlendOperation_Add, WGPUBlendFactor_One, dst};
    if (target.blend) color.blend = &blend;
    WGPUFragmentState fragmentState = {};
    if (fs && target.color != WGPUTextureFormat_Undefined) {
        fragmentState.module = fs;
        WGPU_SET_ENTRY_POINT(fragmentState, "main");
        fragmentState.targetCount = 1;
        fragmentState.targets = &color;
        desc.fragment = &fragmentState;
    }
    WGPURenderPipeline pipeline = nullptr;
#ifdef __EMSCRIPTEN__
    if (pending) {
        WGPUCreateRenderPipelineAsyncCallbackInfo callback = {};
        callback.mode = WGPUCallbackMode_AllowProcessEvents;
        callback.userdata1 = new std::shared_ptr<Pending>(pending);
        callback.callback = [](WGPUCreatePipelineAsyncStatus status, WGPURenderPipeline result,
                               WGPUStringView message, void* data, void*) {
            std::unique_ptr<std::shared_ptr<Pending>> request(static_cast<std::shared_ptr<Pending>*>(data));
            const std::string error = status == WGPUCreatePipelineAsyncStatus_Success ? ""
                : message.data ? std::string(message.data, message.length == WGPU_STRLEN ? std::char_traits<char>::length(message.data) : message.length)
                               : "async creation failed";
            (*request)->complete(result, error);
        };
        wgpuDeviceCreateRenderPipelineAsync(device, &desc, callback);
    } else
#endif
        pipeline = wgpuDeviceCreateRenderPipeline(device, &desc);
    wgpuShaderModuleRelease(vs);
    if (fs) wgpuShaderModuleRelease(fs);
#ifdef __EMSCRIPTEN__
    if (pending) {
        WGPUPopErrorScopeCallbackInfo callback = {};
        callback.mode = WGPUCallbackMode_AllowProcessEvents;
        callback.userdata1 = new std::shared_ptr<Pending>(pending);
        callback.callback = [](WGPUPopErrorScopeStatus status, WGPUErrorType type, WGPUStringView message,
                               void* data, void*) {
            std::unique_ptr<std::shared_ptr<Pending>> request(static_cast<std::shared_ptr<Pending>*>(data));
            if (status == WGPUPopErrorScopeStatus_Success && type == WGPUErrorType_NoError) return;
            (*request)->complete(nullptr, message.data
                ? std::string(message.data, message.length == WGPU_STRLEN ? std::char_traits<char>::length(message.data) : message.length)
                : "shader validation failed");
        };
        wgpuDevicePopErrorScope(device, callback);
    }
#endif
    return pipeline;
}

}  // namespace tn::engine
