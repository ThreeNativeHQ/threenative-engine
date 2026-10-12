#include "device_state.h"

#include <utility>

namespace tn::engine {

const char* deviceStateName(DeviceState state) {
    switch (state) {
        case DeviceState::Running: return "running";
        case DeviceState::Lost: return "lost";
        case DeviceState::Recovering: return "recovering";
        case DeviceState::Failed: return "failed";
    }
    return "unknown";
}

DeviceLifecycle::DeviceLifecycle(Acquire acquire, Rebuild rebuild, EventQueue& events)
    : acquire_(std::move(acquire)), rebuild_(std::move(rebuild)), events_(events) {}

void DeviceLifecycle::enter(DeviceState next) {
    const DeviceState previous = state_;
    state_ = next;
    if (transition_) transition_(previous, next);
}

bool DeviceLifecycle::bringUp() {
    DeviceHandles handles;
    if (!acquire_(handles) || !handles.device || !handles.queue) return false;
    // A new generation: every handle from the old device now fails its context check.
    ++generation_;
    resources_ = std::make_unique<GpuResources>(handles.instance, handles.device, handles.queue, events_,
                                                generation_);
    return true;
}

bool DeviceLifecycle::start() {
    lostSignal_.store(false, std::memory_order_release);
    if (!bringUp()) {
        enter(DeviceState::Failed);
        return false;
    }
    enter(DeviceState::Recovering);
    if (!rebuild_(*resources_) || lostSignal_.exchange(false, std::memory_order_acq_rel)) {
        resources_.reset();
        enter(DeviceState::Failed);
        return false;
    }
    enter(DeviceState::Running);
    return true;
}

void DeviceLifecycle::update() {
    if (state_ != DeviceState::Running || !lostSignal_.exchange(false, std::memory_order_acq_rel)) return;

    enter(DeviceState::Lost);
    // The lost device's objects are released with it; their handles are already unreachable.
    resources_.reset();
    if (!bringUp()) {
        enter(DeviceState::Failed);
        return;
    }
    enter(DeviceState::Recovering);
    // A rebuild error, or a second loss before the rebuild finished, is failure, not a loop.
    if (!rebuild_(*resources_) || lostSignal_.exchange(false, std::memory_order_acq_rel)) {
        resources_.reset();
        enter(DeviceState::Failed);
        return;
    }
    enter(DeviceState::Running);
}

}  // namespace tn::engine
