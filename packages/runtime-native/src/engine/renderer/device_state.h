#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <vector>

#include "engine/renderer/gpu_resources.h"

namespace tn::engine {

/** §12: running → lost → recovering → running, or failed. Surface rebuilds never leave running. */
enum class DeviceState : uint8_t { Running, Lost, Recovering, Failed };

const char* deviceStateName(DeviceState state);

struct DeviceHandles {
    WGPUInstance instance = nullptr;
    WGPUDevice device = nullptr;
    WGPUQueue queue = nullptr;
};

/**
 * Owns the device's life (PRD-509 phase 3). The host acquires devices (`acquire`), the engine
 * re-creates its resources on each new one (`rebuild`), and every state change is published.
 * A loss is only recorded when it arrives; the state machine advances at the frame boundary.
 */
class DeviceLifecycle {
public:
    /** False when no adapter or device can be had. */
    using Acquire = std::function<bool(DeviceHandles& out)>;
    /** Re-creates resources from CPU-side descriptors and data; false on any error. */
    using Rebuild = std::function<bool(GpuResources& resources)>;
    using Transition = std::function<void(DeviceState from, DeviceState to)>;

    DeviceLifecycle(Acquire acquire, Rebuild rebuild, EventQueue& events);

    /** Acquires the first device and builds on it. */
    bool start();
    /** Safe from any thread, including inside a backend callback. */
    void notifyLost() { lostSignal_.store(true, std::memory_order_release); }
    /** Frame boundary: drives lost → recovering → running/failed. */
    void update();

    void onTransition(Transition transition) { transition_ = std::move(transition); }
    DeviceState state() const { return state_; }
    uint16_t generation() const { return generation_; }
    /** Null unless running. */
    GpuResources* resources() { return state_ == DeviceState::Running ? resources_.get() : nullptr; }

private:
    void enter(DeviceState next);
    bool bringUp();

    Acquire acquire_;
    Rebuild rebuild_;
    EventQueue& events_;
    Transition transition_;
    DeviceState state_ = DeviceState::Lost;
    uint16_t generation_ = 0;
    std::unique_ptr<GpuResources> resources_;
    std::atomic<bool> lostSignal_{false};
};

}  // namespace tn::engine
