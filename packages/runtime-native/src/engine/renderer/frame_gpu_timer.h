#pragma once

#include <webgpu/webgpu.h>
#include "mystral/webgpu_compat.h"
#include <atomic>
#include <cstdint>
#include <cstdlib>
#include <vector>

namespace tn::engine {

// A timed pass sums into one segment of the frame: 0 the sun's shadow passes, 1 the scene pass, 2 other passes
// (offscreen, compute, post, TRAA), 3 the output pass, 4 the screen-space gather (post passes labelled
// `kStageScreenSpaceGi`), 5 the spot and point lights' shadow passes (PRD-650).
inline constexpr size_t kGpuSegments = 6;
inline constexpr uint8_t kGpuGiSegment = 4;
inline constexpr uint8_t kGpuLampShadowSegment = 5;

// One query stream shared by a renderer and its offscreen siblings, across all their encoders.
struct FrameGpuTimer {
    static constexpr uint32_t maxPasses = 2048;
    struct PassInfo {
        const char* name;
        uint32_t width, height;
    };
    WGPUQuerySet queries = nullptr;
    bool enabled = false, failed = false, trace = false;
    std::atomic<bool> pending{false};
    std::vector<uint8_t> segments;
    std::vector<PassInfo> passes;

    FrameGpuTimer() = default;  // No device, no queries: the stream's bookkeeping alone (its test).
    explicit FrameGpuTimer(WGPUDevice device) {
        const char* passes = std::getenv("TN_GPU_PASSES");
        trace = passes && passes[0] == '1' && passes[1] == '\0';
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

    // False when the stream is full: the pass runs untimed and the sample is refused, never a thrown
    // frame. Passes outside a frame (texture mips, compute dispatches) fill segments until the next
    // owner frame clears them, so a burst larger than maxPasses must not poison every later render.
    template<class Writes> bool attach(Writes& writes, uint8_t segment, PassInfo info = {"other", 0, 0}) {
        if (segments.size() >= maxPasses) {
            failed = true;  // Refuse the entire sample rather than silently dropping a pass.
            return false;
        }
        writes.querySet = queries;
        writes.beginningOfPassWriteIndex = uint32_t(segments.size()) * 2;
        writes.endOfPassWriteIndex = writes.beginningOfPassWriteIndex + 1;
        segments.push_back(segment);
        if (trace) passes.push_back(info);
        return true;
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
    const WGPURenderPassDescriptor* descriptor, uint8_t segment = 2,
    FrameGpuTimer::PassInfo info = {"other", 0, 0}) {
    auto desc = *descriptor;
    WGPURenderPassTimestampWrites_Compat writes{};
    if (auto* timer = FrameGpuTimer::current; timer && timer->measurePass()) {
        if (timer->attach(writes, segment, info)) desc.timestampWrites = &writes;
    }
    return wgpuCommandEncoderBeginRenderPass(encoder, &desc);
}

inline WGPUComputePassEncoder beginTimedComputePass(WGPUCommandEncoder encoder,
    const WGPUComputePassDescriptor* descriptor,
    FrameGpuTimer::PassInfo info = {"compute", 0, 0}) {
    auto desc = *descriptor;
    WGPUComputePassTimestampWrites_Compat writes{};
    if (auto* timer = FrameGpuTimer::current; timer && timer->measurePass()) {
        if (timer->attach(writes, 2, info)) desc.timestampWrites = &writes;
    }
    return wgpuCommandEncoderBeginComputePass(encoder, &desc);
}

}  // namespace tn::engine
