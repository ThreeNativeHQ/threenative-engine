#pragma once

#include <vector>
#include "engine/shader/graph/post_effects.h"
#include "engine/renderer/pipeline_cache.h"
#include <webgpu/webgpu.h>
#include <map>

namespace tn::engine {
struct CameraState;
/** Executes the serialized r185 effect passes using the existing native pass scheduler/cache. */
class PostEffects {
  public:
    PostEffects(WGPUDevice device, WGPUQueue queue, std::vector<shader::graph::PostPass> sources);
    ~PostEffects();
    PostEffects(const PostEffects&) = delete;
    PostEffects& operator=(const PostEffects&) = delete;
    void resize(uint32_t width, uint32_t height);
    /** Takes each live effect's current `resolutionScale` (set after install, as three reads it every
     *  frame) and rebuilds the targets when one changed; true when the targets are new. */
    bool syncScales();
    void input(const std::string& name, WGPUTextureView view);
    /** True when any pass reads the named resource ("normal" asks the renderer for a normal target). */
    bool reads(const std::string& name) const;
    void render(WGPUCommandEncoder encoder, WGPUTextureView scene, WGPUTextureView depth, WGPUBuffer triangle,
                const CameraState& camera, uint64_t frame);
    WGPUTextureView view(const std::string& name) const;
    WGPUSampler sampler(const std::string& name) const;

  private:
    struct Image {
        WGPUTexture texture = nullptr;
        WGPUTextureView view = nullptr;
        WGPUSampler sampler = nullptr;
        uint32_t width = 0, height = 0;
        WGPUTextureFormat format = WGPUTextureFormat_RGBA16Float;
    };
    struct Pass {
        shader::graph::PostPass source;
        WGPUBuffer uniforms = nullptr;
        WGPURenderPipeline pipeline = nullptr; // borrowed from cache
        // Explicit layout: an automatic one drops a binding the shader never reads (SMAA's unused
        // uniform block), and the pass binds every binding its package declares.
        WGPUBindGroupLayout layout = nullptr;
        WGPUPipelineLayout pipelineLayout = nullptr;
        bool rendered = false;
        // The bind group of the last frame and what it binds: reused while every entry is the same,
        // dropped with the targets (a released view's handle can come back for a new one).
        WGPUBindGroup group = nullptr;
        std::vector<WGPUBindGroupEntry> groupEntries;
    };
    void releaseGroups();
    void clearTargets();
    WGPUDevice device_;
    WGPUQueue queue_;
    PipelineCache pipelines_;
    std::vector<Pass> passes_;
    std::map<std::string, Image> targets_, images_;
    std::map<std::string, WGPUTextureView> inputs_;
    WGPUSampler linear_ = nullptr;
    uint32_t width_ = 0, height_ = 0;
};
} // namespace tn::engine
