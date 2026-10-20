#pragma once

#include <functional>
#include <vector>
#include "engine/shader/graph/post_effects.h"
#include "engine/renderer/pipeline_cache.h"
#include <webgpu/webgpu.h>
#include <map>

namespace tn::engine {
struct CameraState;
struct LightState;
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
    /**
     * Copies what `render` reads from the game's uniform nodes and effect parameters (PRD-613): the game
     * thread calls it with the render thread idle, then `render` runs on the copy while the game writes on.
     */
    void captureUniforms();
    bool target(const std::string& name, WGPUTextureView view);
    void input(const std::string& name, WGPUTextureView view, WGPUSampler sampler = nullptr);
    /** True when any pass reads the named resource ("normal" asks the renderer for a normal target). */
    bool reads(const std::string& name) const;
    /**
     * `encoder` is replaced when `split` runs: just before the first pass that reads an input `isDeferred` names, `split`
     * takes the encoder (to finish and submit it ahead of a game render target's draw) and returns the one to go on with.
     */
    /** The fullscreen passes it drew, which three's renderer.info counts as one draw and one triangle each. */
    uint32_t render(WGPUCommandEncoder& encoder, WGPUTextureView scene, WGPUTextureView depth, WGPUBuffer triangle,
                const CameraState& camera, uint64_t frame, float time = 0, float exposure = 1, const LightState* lights = nullptr,
                const std::function<bool(const std::string&)>& isDeferred = {},
                const std::function<WGPUCommandEncoder(WGPUCommandEncoder)>& split = {});
    WGPUTextureView view(const std::string& name) const;
    WGPUSampler sampler(const std::string& name) const;
    /** Changes whenever any output view is replaced (a resize, a new target), so a cached bind group of one can be rebuilt. */
    uint64_t viewsStamp() const;

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
        WGPUBuffer uniforms = nullptr, vertexUniforms = nullptr;
        WGPURenderPipeline pipeline = nullptr; // borrowed from cache
        // Explicit layout: an automatic one drops a binding the shader never reads (SMAA's unused
        // uniform block), and the pass binds every binding its package declares.
        WGPUBindGroupLayout layout = nullptr, vertexLayout = nullptr;
        WGPUPipelineLayout pipelineLayout = nullptr;
        uint64_t rttRevision = 0, rttRequested = 0, rttDisposal = 0;
        uint16_t rttMin = 1006, rttMag = 1006;
        bool rendered = false;
        std::map<std::string, std::vector<double>> captured;  // the live nodes' and effect's values, over `source.uniforms`
        // The bind group of the last frame and what it binds: reused while every entry is the same,
        // dropped with the targets (a released view's handle can come back for a new one).
        WGPUBindGroup group = nullptr, vertexGroup = nullptr;
        std::vector<WGPUBindGroupEntry> groupEntries, vertexEntries;
    };
    void releaseGroups();
    void clearTargets();
    WGPUDevice device_;
    WGPUQueue queue_;
    PipelineCache pipelines_;
    std::vector<Pass> passes_;
    std::map<std::string, Image> targets_, images_;
    std::map<std::string, WGPUTextureView> inputs_;
    std::map<std::string, WGPUTextureView> outputViews_;
    std::map<std::string, WGPUSampler> inputSamplers_;
    WGPUSampler linear_ = nullptr;
    WGPUSampler compare_ = nullptr;
    uint32_t width_ = 0, height_ = 0;
    bool captured_ = false;
    float lastTime_ = -1;  // the frame time of the render before, for deltaTime
};
} // namespace tn::engine
