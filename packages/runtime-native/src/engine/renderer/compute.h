#pragma once

#include <array>
#include <memory>
#include <span>
#include <string>
#include <utility>
#include <vector>

#include <webgpu/webgpu.h>

#include "engine/renderer/gpu_resources.h"
#include "engine/shader/ir.h"
#include "engine/shader/package.h"

namespace tn::engine {

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

private:
    WGPUDevice device_;
    GpuResources& gpu_;
    shader::StageModule module_;
    WGPUComputePipeline pipeline_ = nullptr;
    Handle uniforms_;
    std::string error_;
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
