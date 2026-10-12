#pragma once

#include "engine/renderer/graph/history.h"
#include "engine/renderer/graph/render_graph.h"
#include "engine/shader/output.h"
#include <webgpu/webgpu.h>
#include <memory>
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
    void cameraCut() { history_.cameraCut(0); }
    Matrix begin(const Matrix& projection, const Matrix& world, const Matrix& view);
    Matrix previousModel(uint64_t object, const Matrix& world);
    const Matrix& previousProjection() const { return previousProjection_; }
    const Matrix& previousView() const { return previousView_; }
    WGPUTextureView velocityView() const { return velocityView_; }
    WGPUTextureView resultView() const { return resolveView_; }
    void seedHistory(WGPUCommandEncoder encoder, WGPUTexture beauty);
    void resolve(WGPUCommandEncoder encoder, WGPUTexture beauty, WGPUTextureView beautyView,
                 WGPUTexture depth, WGPUTextureView depthView);
    bool needsSeed() const { return !history_.historyValid(0); }
    const graph::RenderGraph& renderGraph() const { return graph_; }
    // Fixture diagnostics only. No allocation/readback unless explicitly enabled by the driver.
    void enableDebugDump();
    struct DebugDump {
        struct Texture {
            WGPUBuffer buffer;
            std::string name;
            uint32_t pitch;
            uint64_t size;
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
    Matrix projection_{}, previousProjection_{}, world_{}, previousWorld_{}, view_{}, previousView_{};
    Matrix inverseProjection_{}, previousInverseProjection_{};
    bool started_ = false;
    uint32_t depthGeneration_ = 0;
    WGPUTexture historyColor_ = nullptr, historyDepth_ = nullptr, resolve_ = nullptr, velocity_ = nullptr;
    WGPUTextureView historyView_ = nullptr, historyDepthView_ = nullptr, resolveView_ = nullptr, velocityView_ = nullptr;
    WGPUBuffer uniforms_ = nullptr;
    WGPUSampler sampler_ = nullptr;
    WGPURenderPipeline pipeline_ = nullptr;
    void releaseTargets();
};

// Rigid-object VelocityNode: current/previous *unjittered* clip positions, then NDC subtraction.
shader::OutputPrograms traaVelocityPrograms();
const char* traaResolveWgsl();

} // namespace tn::engine
