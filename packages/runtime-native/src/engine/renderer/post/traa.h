#pragma once

#include "engine/renderer/graph/history.h"
#include "engine/renderer/pipeline_cache.h"
#include "engine/renderer/graph/render_graph.h"
#include "engine/shader/output.h"
#include "engine/shader/standard.h"
#include <webgpu/webgpu.h>
#include <array>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace tn::engine {

// TRAANode r185, including its intentional modulo (32 - 1), not a generic TAA preset.
using graph::traaJitter;
struct TraaOptions {
    float depthThreshold = 0.0005f;
    float edgeDepthDiff = 0.001f;
    float maxVelocityLength = 128;
    bool useSubpixelCorrection = true;
};

class TraaPass {
public:
    using Matrix = graph::HistoryTracker::Matrix;
    TraaPass(WGPUDevice device, WGPUQueue queue, TraaOptions options);
    ~TraaPass();
    void resize(uint32_t width, uint32_t height);
    void resize(uint32_t inputWidth, uint32_t inputHeight, uint32_t outputWidth, uint32_t outputHeight);
    void setOptions(const TraaOptions& options) { options_ = options; }
    void cameraCut() { history_.cameraCut(0); }
    Matrix begin(const Matrix& projection, const Matrix& world, const Matrix& view,
                 const Matrix* viewProjection = nullptr);
    Matrix previousModel(uint64_t object, const Matrix& world);
    // Two dot-product rows that replace the resolve shader's previous-frame matrix chain. Rows 0..3 multiply the
    // previous clip position for the depth numerator, rows 4..7 for the denominator.
    static std::array<float, 8> historyDepthRows(const Matrix& projection, const Matrix& view,
                                                 const Matrix& previousWorld,
                                                 const Matrix& previousInverseProjection);
    const Matrix& previousProjection() const { return previousProjection_; }
    const Matrix& previousView() const { return previousView_; }
    WGPUTextureView velocityView() const { return velocityView_; }
    WGPUTexture velocityTexture() const { return velocity_; }
    WGPUTextureView resultView() const { return resolveView_; }
    // The velocity every pixel takes from the camera's own motion, rebuilt from the depth buffer. The velocity pass then
    // loads this target and overwrites the pixels of the rigid draws it knows. The sky and the draws it leaves out
    // (skinned, instanced, alpha-tested, transparent, sprites) keep the camera's motion instead of zero.
    void fillVelocity(WGPUCommandEncoder encoder, WGPUTextureView depthView);
    void seedHistory(WGPUCommandEncoder encoder, WGPUTexture beauty);
    // `output` and `outputView` take the resolved colour when the caller owns the target (a pass of the post graph, over a
    // frame the graph drew); left null, it lands in `resultView()`.
    void resolve(WGPUCommandEncoder encoder, WGPUTexture beauty, WGPUTextureView beautyView,
                 WGPUTexture depth, WGPUTextureView depthView, WGPUTexture output = nullptr,
                 WGPUTextureView outputView = nullptr);
    bool needsSeed() const { return !history_.historyValid(0); }
    // What the host reads for `debug().temporal`: the frames begun, the sub-pixel offset the last one jittered by, and
    // whether the next resolve has history to read.
    struct Status {
        uint64_t frame = 0;
        double jitterX = 0, jitterY = 0;
        bool historyValid = false;
        uint32_t inputWidth = 0, inputHeight = 0, outputWidth = 0, outputHeight = 0;
        uint32_t depthHistoryWidth = 0, depthHistoryHeight = 0, historyWidth = 0, historyHeight = 0;
        uint32_t jitterLength = 31;
    };
    Status status() const {
        return {history_.frame(), jitter_[0], jitter_[1], history_.historyValid(0),
                velocity_ ? wgpuTextureGetWidth(velocity_) : 0, velocity_ ? wgpuTextureGetHeight(velocity_) : 0,
                resolve_ ? wgpuTextureGetWidth(resolve_) : 0, resolve_ ? wgpuTextureGetHeight(resolve_) : 0,
                historyDepth_ ? wgpuTextureGetWidth(historyDepth_) : 0, historyDepth_ ? wgpuTextureGetHeight(historyDepth_) : 0,
                historyColor_ ? wgpuTextureGetWidth(historyColor_) : 0, historyColor_ ? wgpuTextureGetHeight(historyColor_) : 0,
                jitterLength_};
    }
    // One resolve in `kMeasureEvery` counts the pixels whose history it discarded (stats[0]) and pulled into the colour
    // neighbourhood (stats[1]). The owner gives the buffer (8 bytes, storage, copy source and destination) and reads it back
    // after the frame is submitted; `takeMeasure` says whether the last resolve counted, once.
    static constexpr uint64_t kMeasureEvery = 16;
    void setStatsBuffer(WGPUBuffer buffer) { stats_ = buffer ? buffer : ownStats_; }
    struct Measure {
        uint64_t frame = 0;
        uint32_t pixels = 0;
    };
    std::optional<Measure> takeMeasure() {
        if (!measured_) return std::nullopt;
        measured_ = false;
        return Measure{measuredFrame_, outputWidth_ * outputHeight_};
    }
    const graph::RenderGraph& renderGraph() const { return graph_; }
    // Fixture diagnostics only. No allocation/readback unless explicitly enabled by the driver.
    void enableDebugDump();
    struct DebugDump {
        struct Texture {
            WGPUBuffer buffer;
            std::string name;
            uint32_t pitch;
            uint64_t size;
            uint32_t width, height;
        };
        std::vector<Texture> pending;
        std::string metadata;
        uint64_t frame = 0;
        uint32_t width = 0, height = 0;
        ~DebugDump() { for (const auto& texture : pending) wgpuBufferRelease(texture.buffer); }
    };
    DebugDump* debugDump() const { return debugDump_.get(); }
private:
    std::unique_ptr<DebugDump> debugDump_;
    void stageDebugTexture(WGPUCommandEncoder encoder, WGPUTexture texture, const char* name);
    WGPUDevice device_;
    WGPUQueue queue_;
    TraaOptions options_;
    graph::HistoryTracker history_;
    graph::RenderGraph graph_;
    uint32_t width_ = 0, height_ = 0;
    uint32_t outputWidth_ = 0, outputHeight_ = 0, jitterLength_ = 31;
    Matrix projection_{}, previousProjection_{}, world_{}, previousWorld_{}, view_{}, previousView_{};
    Matrix inverseProjection_{}, previousInverseProjection_{};
    bool started_ = false;
    std::array<double, 2> jitter_{};
    std::array<double, 2> previousJitter_{};
    uint32_t depthGeneration_ = 0;
    WGPUTexture historyColor_ = nullptr, historyDepth_ = nullptr, resolve_ = nullptr, velocity_ = nullptr;
    WGPUTextureView historyView_ = nullptr, historyDepthView_ = nullptr, resolveView_ = nullptr, velocityView_ = nullptr;
    WGPUTexture dynamic_ = nullptr, historyDynamic_ = nullptr;
    WGPUTextureView dynamicView_ = nullptr, historyDynamicView_ = nullptr;
    WGPUBuffer uniforms_ = nullptr;
    WGPUBuffer ownStats_ = nullptr, stats_ = nullptr;
    bool measured_ = false;
    uint64_t measuredFrame_ = 0;
    WGPUSampler sampler_ = nullptr;
    WGPURenderPipeline pipeline_ = nullptr, fillPipeline_ = nullptr;
    WGPUBuffer fillUniforms_ = nullptr;
    WGPUBindGroupLayout layout_ = nullptr, fillLayout_ = nullptr;
    RecentBindGroups fillGroups_, resolveGroups_;
    void releaseTargets();
};

// VelocityNode: current/previous *unjittered* clip positions of the draw's local vertex, then NDC subtraction.
// The default variant is a rigid draw; a skinned, morphed or position-node variant deforms the vertex as the
// colour pass does and carries it through last frame's model, view and projection (last frame's bones are not kept).
shader::OutputPrograms traaVelocityPrograms(const shader::VertexVariant& variant = {});
const char* traaResolveWgsl();
const char* traaFillWgsl();

} // namespace tn::engine
