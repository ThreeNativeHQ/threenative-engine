#include "handles.h"

namespace tn::engine {

Handle HandleTable::allocate(uint16_t type) {
    if (type == 0) return Handle{};
    uint32_t index;
    if (!free_.empty()) {
        index = free_.back();
        free_.pop_back();
    } else {
        index = static_cast<uint32_t>(slots_.size());
        slots_.push_back(Slot{});
    }
    Slot& slot = slots_[index];
    slot.type = type;
    slot.live = true;
    ++live_;
    return Handle{type, context_, index, slot.generation};
}

HandleError HandleTable::check(Handle handle, uint16_t expectedType) const {
    return check(handle.type, handle.context, handle.index, handle.generation, expectedType);
}

HandleError HandleTable::release(Handle handle) {
    const HandleError error = check(handle);
    if (error != HandleError::None) return error;
    Slot& slot = slots_[handle.index];
    slot.live = false;
    slot.type = 0;
    // ponytail: a slot retires after 2^32 - 1 reuses rather than wrapping to a generation an old
    // handle could still hold; it is leaked, which costs 8 bytes per 4 billion frees.
    if (++slot.generation == 0) {
        --live_;
        return HandleError::None;
    }
    free_.push_back(handle.index);
    --live_;
    return HandleError::None;
}

}  // namespace tn::engine
