#pragma once

#include <webgpu/webgpu.h>
#include "mystral/webgpu_compat.h"
#include <atomic>
#include <cstdint>
#include <stdexcept>
#include <vector>

namespace tn::engine {

// One query stream shared by a renderer and its offscreen siblings, across all their encoders.
struct FrameGpuTimer {
    static constexpr uint32_t maxPasses = 2048;
    WGPUQuerySet queries = nullptr;
    bool enabled = false, failed = false;
    std::atomic<bool> pending{false};
    std::vector<uint8_t> segments;

    explicit FrameGpuTimer(WGPUDevice device) {
        if (!wgpuDeviceHasFeature(device, WGPUFeatureName_TimestampQuery)) return;
        WGPUQuerySetDescriptor desc{};
        desc.type = WGPUQueryType_Timestamp;
        desc.count = maxPasses * 2;
        queries = wgpuDeviceCreateQuerySet(device, &desc);
    }
    ~FrameGpuTimer() { if (queries) wgpuQuerySetRelease(queries); }
    bool active() const { return queries && enabled && !pending; }

    bool measurePass() {
        if (!queries || !enabled) return false;
        if (pending) failed = true;  // A partially observed frame is not a complete sample.
        return !pending && !failed;
    }

    template<class Writes> void attach(Writes& writes, uint8_t segment) {
        if (segments.size() == maxPasses) {
            failed = true;  // Refuse the entire sample rather than silently dropping a pass.
            throw std::runtime_error("TN_GPU_TIMER_CAPACITY: too many passes in one frame");
        }
        writes.querySet = queries;
        writes.beginningOfPassWriteIndex = uint32_t(segments.size()) * 2;
        writes.endOfPassWriteIndex = writes.beginningOfPassWriteIndex + 1;
        segments.push_back(segment);
    }

    // Encoder scopes are thread-local: planning and encoding may run on different threads.
    inline static thread_local FrameGpuTimer* current = nullptr;
    struct Scope {
        FrameGpuTimer* previous;
        explicit Scope(FrameGpuTimer* timer) : previous(current) { current = timer; }
        ~Scope() { current = previous; }
    };
};

inline WGPURenderPassEncoder beginTimedRenderPass(WGPUCommandEncoder encoder,
    const WGPURenderPassDescriptor* descriptor, uint8_t segment = 2) {
    auto desc = *descriptor;
    WGPURenderPassTimestampWrites_Compat writes{};
    if (auto* timer = FrameGpuTimer::current; timer && timer->measurePass()) {
        timer->attach(writes, segment);
        desc.timestampWrites = &writes;
    }
    return wgpuCommandEncoderBeginRenderPass(encoder, &desc);
}

inline WGPUComputePassEncoder beginTimedComputePass(WGPUCommandEncoder encoder,
    const WGPUComputePassDescriptor* descriptor) {
    auto desc = *descriptor;
    WGPUComputePassTimestampWrites_Compat writes{};
    if (auto* timer = FrameGpuTimer::current; timer && timer->measurePass()) {
        timer->attach(writes, 2);
        desc.timestampWrites = &writes;
    }
    return wgpuCommandEncoderBeginComputePass(encoder, &desc);
}

}  // namespace tn::engine
