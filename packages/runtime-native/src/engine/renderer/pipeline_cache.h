#pragma once

#include <cstdint>
#include <atomic>
#include <memory>
#ifndef __EMSCRIPTEN__
#include <array>
#include <condition_variable>  // TN_WORKER_ONLY: the compile workers park between jobs
#include <deque>
#include <functional>
#include <mutex>
#include <thread>
#endif
#include <string>
#include <unordered_map>
#include <vector>

#include <webgpu/webgpu.h>

#include "engine/shader/package.h"

namespace tn::engine {

/** A nonblocking compile result; only renderer-thread poll/get observes a worker's completion. */
class PipelineCompilation {
public:
    ~PipelineCompilation();
    bool ready() const { return status_.load(std::memory_order_acquire) != 0; }
    /** Throws if still pending or refused; never waits on the game thread. */
    WGPURenderPipeline get() const;
private:
    friend class PipelineCache;
    void complete(WGPURenderPipeline pipeline, const std::string& error = {}, bool replace = false);
#ifndef __EMSCRIPTEN__
    std::mutex completionMutex_;  // publication only; GPU creation never holds this lock
#endif
    WGPURenderPipeline pipeline_ = nullptr;
    std::string error_;
    std::atomic<int> status_{0};
};

/** What a render pipeline depends on besides its shaders. */
struct PipelineTarget {
    WGPUTextureFormat color = WGPUTextureFormat_RGBA8Unorm;  // Undefined: depth-only (shadow) pass
    WGPUTextureFormat depth = WGPUTextureFormat_Depth32Float;
    WGPUCullMode cull = WGPUCullMode_Back;
    uint8_t blend = 0;       // 0 none, three's NormalBlending (1) or AdditiveBlending (2), premultipliedAlpha false; 3 premultiplied "over" (a UI overlay)
    bool depthWrite = true;  // material.depthWrite
    uint32_t sampleCount = 1;
    WGPUPipelineLayout layout = nullptr;  // explicit layout (dynamic-offset uniforms); null: auto
    // `skinIndex` as the geometry stores it: three's Uint8/16/32 attribute read as vec4<u32>.
    WGPUVertexFormat skinIndex = WGPUVertexFormat_Uint16x4;
    WGPUFrontFace frontFace = WGPUFrontFace_CCW;
    WGPUCompareFunction depthCompare = WGPUCompareFunction_LessEqual;
    // material.polygonOffset: WebGPUPipelineUtils' depthBias (polygonOffsetUnits) and
    // depthBiasSlopeScale (polygonOffsetFactor); zero without it.
    int32_t depthBias = 0;
    float depthBiasSlopeScale = 0;
    // Bit i: vertex attribute i (in the stage's attribute order) steps per instance
    // (an InstancedBufferAttribute), beside instanceMatrix* and instanceColor.
    uint64_t instanceStepMask = 0;
    WGPUPrimitiveTopology topology = WGPUPrimitiveTopology_TriangleList;
    WGPUIndexFormat stripIndexFormat = WGPUIndexFormat_Undefined;  // an indexed line strip's index format
};

/**
 * Every bind group the renderer creates goes through here, so a steady frame can be held to creating
 * none (render_database_test steady_state): a per-frame group is a regression, not a cost to tune.
 */
WGPUBindGroup createBindGroup(WGPUDevice device, const WGPUBindGroupDescriptor* descriptor);
/** How many bind groups createBindGroup has made in this process. */
uint64_t bindGroupsCreated();

/**
 * Render pipelines by what they are made of (PRD-514): the stages' WGSL text — deterministic by
 * construction (PRD-511) — their vertex layout and the target formats. The first request compiles;
 * every later one, every frame, is a lookup.
 */
class PipelineCache {
public:
    explicit PipelineCache(WGPUDevice device) : device_(device) {}
    ~PipelineCache();
    PipelineCache(const PipelineCache&) = delete;
    PipelineCache& operator=(const PipelineCache&) = delete;

    /** `fragment` null builds a depth-only pipeline. Returns null when the device refuses it. */
    WGPURenderPipeline get(const shader::StageModule& vertex, const shader::StageModule* fragment, const PipelineTarget& target);

    /** Missing keys compile on two native workers, or through WebGPU's browser async entry. */
    std::shared_ptr<PipelineCompilation> getAsync(const shader::StageModule& vertex,
        const shader::StageModule* fragment, const PipelineTarget& target);
    /** Adopt completed pipelines on the renderer thread; workers never mutate the cache. */
    void poll();

    uint64_t compiles() const { return compiles_; }
    /** Lookups that had to build the text key: the ones an id did not answer. */
    uint64_t textLookups() const { return textLookups_; }
    size_t size() const { return pipelines_.size(); }

private:
    /** The same pipeline by the ids of its stages' texts: a lookup that copies and hashes no WGSL. */
    struct IdKey {
        uint64_t vertex, fragment;
        size_t vertexSize, fragmentSize;  // an edit that changes the length also changes the key
        PipelineTarget target;
        bool operator==(const IdKey& o) const;
    };
    struct IdKeyHash {
        size_t operator()(const IdKey& key) const;
    };
    struct Pending;
    static IdKey idKey(const shader::StageModule& vertex, const shader::StageModule* fragment, const PipelineTarget& target);
    static std::string textKey(const shader::StageModule& vertex, const shader::StageModule* fragment, const PipelineTarget& target);
    static WGPURenderPipeline create(WGPUDevice device, const shader::StageModule& vertex,
        const shader::StageModule* fragment, const PipelineTarget& target, const std::shared_ptr<Pending>& pending = {});
    std::unordered_map<std::string, std::shared_ptr<Pending>> compiling_;
#ifndef __EMSCRIPTEN__
    std::array<std::thread, 2> workers_;
    std::mutex workMutex_;
    std::condition_variable workReady_;  // TN_WORKER_ONLY: the compile workers park between jobs
    std::deque<std::function<void()>> pending_;
    bool stopping_ = false;
#endif
    WGPUDevice device_;
    std::unordered_map<std::string, WGPURenderPipeline> pipelines_;
    std::unordered_map<IdKey, WGPURenderPipeline, IdKeyHash> byId_;  // aliases of pipelines_, never owners
    uint64_t compiles_ = 0;
    uint64_t textLookups_ = 0;
};

}  // namespace tn::engine
