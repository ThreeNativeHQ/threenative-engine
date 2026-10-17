#pragma once

#include <cstdint>
#include <vector>

namespace tn::engine {

/** The ABI handle (PRD-500): a slot index plus the identity that proves the slot is still it. */
struct Handle {
    uint16_t type = 0;
    uint16_t context = 0;
    uint32_t index = 0;
    uint32_t generation = 0;
};

enum class HandleError : uint8_t {
    None,
    Invalid,  // no such slot, or a zero type: never allocated by this table
    Context,  // allocated by another context's table
    Stale,    // the slot was released; its generation moved on
    Type,     // live, but of another type than the caller asked for
};

/**
 * Generational slots (PRD-502). A released slot bumps its generation before it can be reused, so a
 * retained handle to the old object is rejected instead of aliasing the new one. Single-threaded by
 * contract: the engine resolves handles on its own thread, and the Wasm build has no other.
 */
class HandleTable {
public:
    explicit HandleTable(uint16_t context) : context_(context) {}

    /** `type` 0 is reserved for "no type" and is refused with an Invalid handle back. */
    Handle allocate(uint16_t type);
    /** `expectedType` 0 accepts any live type. */
    HandleError check(Handle handle, uint16_t expectedType = 0) const;
    /** The same check on the fields as scalars: a caller holding them in registers pays no struct copy. */
    HandleError check(uint16_t type, uint16_t context, uint32_t index, uint32_t generation, uint16_t expectedType = 0) const {
        if (type == 0 || generation == 0) return HandleError::Invalid;
        if (context != context_) return HandleError::Context;
        if (index >= slots_.size()) return HandleError::Invalid;
        const Slot& slot = slots_[index];
        if (!slot.live || slot.generation != generation) return HandleError::Stale;
        // The handle's own type field is caller-supplied; the slot's type is the truth.
        if (slot.type != type) return HandleError::Type;
        if (expectedType != 0 && slot.type != expectedType) return HandleError::Type;
        return HandleError::None;
    }
    HandleError release(Handle handle);

    uint16_t context() const { return context_; }
    uint32_t liveCount() const { return live_; }
    uint32_t capacity() const { return static_cast<uint32_t>(slots_.size()); }

private:
    struct Slot {
        uint32_t generation = 1;  // never 0, so a zeroed handle is never live
        uint16_t type = 0;
        bool live = false;
    };

    uint16_t context_;
    std::vector<Slot> slots_;
    std::vector<uint32_t> free_;
    uint32_t live_ = 0;
};

}  // namespace tn::engine
