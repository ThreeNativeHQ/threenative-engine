#pragma once

#include <array>
#include <functional>
#include <map>
#include <memory>
#include <span>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include <webgpu/webgpu.h>

#include "engine/renderer/geometry_cache.h"
#include "engine/renderer/gpu_resources.h"
#include "engine/shader/graph/graph.h"
#include "engine/shader/ir.h"
#include "engine/shader/package.h"

namespace tn::engine {

class BufferAttribute;
class Renderer;

/** three's `time` and `deltaTime` (its NodeFrame clock) at the dispatch: seconds since the renderer was made, and since the frame before. */
struct FrameClock {
    float time = 0;
    float delta = 0;
};

/**
 * A compute program from the shader IR dispatched over storage buffers (PRD-513 phase 1): one
 * pipeline per program; the storage buffers bind in the program's declaration order, and its scalar
 * uniforms are written by name before each dispatch. Workgroups are the emitter's 64 threads.
 */
class ComputePass {
public:
    ComputePass(WGPUDevice device, GpuResources& gpu, const shader::Program& program);
    ~ComputePass();
    ComputePass(const ComputePass&) = delete;
    ComputePass& operator=(const ComputePass&) = delete;

    /** Empty when the program compiled to a pipeline; else why not. */
    const std::string& error() const { return error_; }

    /**
     * Records `invocations` threads into `encoder`: `storage` holds one buffer per storage buffer the
     * program declares, in order; `uniforms` are the scalar uniforms by name. False with error() set
     * when the buffers do not match the program.
     */
    bool dispatch(WGPUCommandEncoder encoder, std::span<const Handle> storage, uint32_t invocations,
                  const std::vector<std::pair<std::string, double>>& uniforms = {});
    /**
     * The graph form (PRD-620): `uniforms` carries one value per lane by name, as the game's uniform
     * nodes held them, and a dispatch too long for one dimension spreads over rows of workgroups.
     * Throws std::runtime_error naming the uniform or storage buffer the program cannot be given.
     */
    void dispatchValues(WGPUCommandEncoder encoder, std::span<const Handle> storage, uint32_t invocations,
                        const std::map<std::string, std::vector<double>>& uniforms, const FrameClock& clock = {},
                        std::span<const WGPUBindGroupEntry> textures = {});
    const shader::StageModule& module() const { return module_; }

private:
    bool encode(WGPUCommandEncoder encoder, std::span<const Handle> storage, uint32_t invocations,
                const std::vector<uint8_t>& uniformBlock, std::span<const WGPUBindGroupEntry> textures = {});
    WGPUDevice device_;
    GpuResources& gpu_;
    shader::StageModule module_;
    uint32_t workgroup_ = 64;
    WGPUComputePipeline pipeline_ = nullptr;
    Handle uniforms_;
    std::string error_;
};

/** A compute node and the uniform values it was called with, so a later edit reaches only later calls. */
struct ComputeDispatch {
    shader::graph::Node node;
    std::map<std::string, std::vector<double>> uniforms;
    /** Snapshots `node`'s uniforms now. Throws unless `node` is a `Fn(...)().compute(n)` node. */
    static ComputeDispatch of(const shader::graph::Node& node);
};

/**
 * `Fn(...)().compute(count, workgroupSize)` nodes as WGSL compute passes (PRD-620). The body lowers
 * through the shader graph into one `@compute` entry point guarded by `instanceIndex < count`; each
 * storage(attribute) / instancedArray it touches binds the attribute's GPU copy, and a pass is
 * compiled once per graph structure. A feature the program cannot hold refuses by name.
 */
class GraphCompute {
public:
    GraphCompute(WGPUDevice device, GpuResources& gpu, GeometryCache& cache) : device_(device), gpu_(gpu), cache_(cache) {}
    /** Compiles the node's pass if it has none; throws std::runtime_error TN_COMPUTE_* with the reason. */
    ComputePass& prepare(const shader::graph::Node& node);
    /** Records one dispatch into `encoder`. */
    void record(WGPUCommandEncoder encoder, const ComputeDispatch& dispatch, const FrameClock& clock, Renderer& renderer);

private:
    WGPUDevice device_;
    GpuResources& gpu_;
    GeometryCache& cache_;
    std::unordered_map<uint64_t, std::unique_ptr<ComputePass>> passes_;
};

/**
 * `renderer.compute` and `renderer.getArrayBufferAsync` in call order (PRD-620). A host queues them as
 * the game calls and flushes before it draws, so a kernel runs ahead of the frame's passes and a
 * readback sees every kernel queued before it. Nothing here needs the renderer until the flush.
 */
class ComputeQueue {
public:
    ComputeQueue() = default;
    ComputeQueue(const ComputeQueue&) = delete;
    ComputeQueue& operator=(const ComputeQueue&) = delete;
    /** Queues a dispatch with the node's uniform values as of now. Lowers the node at once, so a kernel
     *  the engine cannot hold refuses here, by name, at the game's call. */
    void dispatch(const shader::graph::Node& node);
    /** Queues a copy of `attribute`'s GPU buffer, as it stands after the dispatches queued so far. */
    void readback(std::shared_ptr<BufferAttribute> attribute, ReadbackCallback done);
    /** Queues the release of `attribute`'s GPU copy. */
    void release(std::shared_ptr<BufferAttribute> attribute);
    bool empty() const { return items_.empty(); }
    /**
     * Submits everything queued, in call order. A dispatch that fails goes to `failed` by name and the
     * rest still run; a readback that cannot start completes with an error status.
     */
    void flush(Renderer& renderer, const std::function<void(const std::string&)>& failed);

private:
    void bindDisposal(const std::shared_ptr<BufferAttribute>& attribute);
    struct Item {
        ComputeDispatch dispatch;
        std::shared_ptr<BufferAttribute> attribute;  // a readback or release
        ReadbackCallback done;
        bool release = false;
    };
    std::vector<Item> items_;
    // Weak hooks expire before queued attributes are destroyed; none keeps this queue alive.
    std::shared_ptr<void> lifetime_ = std::make_shared<int>(0);
};

// Internal palette kernel. Indices are joint/packed-TRS/matrix offsets, never byte offsets.
struct JointComputeRig {
    uint32_t count, parentBase, inputBase, fixedBase, outputBase;
};

class JointComputePass {
public:
    // parents are rig-local (UINT32_MAX means root); fixed holds bridge, inverseBind*bind per joint.
    // locals holds position/quaternion/scale as three vec4<f32>s; output is array<mat4x4<f32>>.
    JointComputePass(WGPUDevice device, GpuResources& gpu, std::span<const JointComputeRig> rigs,
                     std::span<const uint32_t> parents, std::span<const std::array<float, 16>> fixed,
                     Handle locals, Handle output);
    ~JointComputePass();
    JointComputePass(const JointComputePass&) = delete;
    JointComputePass& operator=(const JointComputePass&) = delete;
    const std::string& error() const { return error_; }
    bool dispatch(WGPUCommandEncoder encoder);
    // Renderer-owned output permutation; joint/parent order and bindings remain fixed.
    bool remapOutputs(std::span<const uint32_t> bases);

private:
    GpuResources& gpu_;
    std::unique_ptr<ComputePass> pass_;
    std::array<Handle, 4> storage_{};
    uint32_t count_ = 0;
    uint64_t outputMatrices_ = 0;
    std::vector<uint32_t> headers_;
    std::string error_;
};

}  // namespace tn::engine
