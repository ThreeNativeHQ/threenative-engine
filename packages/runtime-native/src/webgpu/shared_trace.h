#pragma once

#include <cstdint>
#include <string>

#include "../raytracing/rt_common.h"

namespace mystral::webgpu {

struct BindingsState;

/**
 * PRD-645. The GPU side of the hardware trace: the rays and the hits cross between the ray
 * tracing device and the WebGPU device as two shared Vulkan images, so no step reads CPU memory.
 * Only a Dawn host built with the Vulkan ray tracing backend has it; every other host reports
 * why not.
 */

/// Gives the transport the bindings it reads the device, the queue and the buffers from.
void setSharedTraceState(BindingsState* state);

struct SharedTraceStatus {
    bool available = false;
    std::string reason;  // Why available is false; empty when it is true
};

/// Whether the WebGPU device can import the trace images.
SharedTraceStatus sharedTraceStatus();

struct GpuTraceResult {
    bool ok = false;
    std::string error;
    double totalMs = 0;  // Wall time of the call, which does not wait for the GPU
    double cpuMs = 0;    // Time this thread ran during the call: totalMs on a host with a free core
};

/**
 * Traces `rayCount` rays from the WebGPU buffer `raysBufferId` into the WebGPU buffer
 * `hitsBufferId`. Replays the recorded WebGPU work first, so the rays are the ones the game
 * wrote. The work that follows runs on the GPU in order and waits on the CPU for nothing.
 */
GpuTraceResult traceRayBatchOnGpu(rt::IRTBackend& backend, rt::RTTLASHandle tlas,
                                  uint64_t raysBufferId, uint64_t hitsBufferId, uint32_t rayCount);

/// Releases every WebGPU object the transport holds. Call before the device goes away.
void releaseSharedTrace();

}  // namespace mystral::webgpu
