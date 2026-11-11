#pragma once

#include "atlas.h"

#include <array>
#include <cstdint>
#include <vector>

namespace tn::engine::shadows {

/**
 * What a virtual-shadow plan reads from one caster beyond its world matrix. A plan rebuilds a caster
 * only when one of these moved, so a static caster that did not change costs a comparison (PRD-872).
 *
 * `controlEpoch` stands for the atlas control sets a caster's `tracked` and `pinned` come from: a
 * re-registered set has to re-derive them, an unchanged one not.
 */
struct CasterInputs {
    const void* positions = nullptr;
    const void* instances = nullptr;
    const void* cache = nullptr;
    uint64_t positionsVersion = 0, instanceVersion = 0, controlEpoch = 0;
    uint32_t instanceCount = 0, layers = 0;
    bool casts = false;
};

/** One caster's planned state, kept across frames: the bounds, the state the atlas reads, and the inputs it came from. */
struct PlannedCaster {
    CasterState state;
    Box3 bounds;
    double diameter = 0;
    const std::vector<Box3>* instanceBoxes = nullptr;
    CasterInputs inputs;
    bool casts = false, valid = false;
};

/**
 * The atlas control sets a caster's `tracked` and `pinned` are read from, folded into one value the plan compares:
 * an FNV-1a pass over `std::set`s, so the fold of a set does not depend on how it was built. Two different sets
 * collide only on a deliberate 64-bit collision; an unchanged pair costs one pass over its members.
 */
inline uint64_t controlStamp(const AtlasControl& control) {
    uint64_t stamp = 0xcbf29ce484222325ull;
    for (const uint64_t id : control.pinned) { stamp = (stamp ^ id) * 0x100000001b3ull; }
    stamp = (stamp ^ 0x9e3779b97f4a7c15ull) * 0x100000001b3ull;
    for (const uint64_t id : control.tracked) { stamp = (stamp ^ id) * 0x100000001b3ull; }
    return stamp;
}

/**
 * A frame's caster records for one shadow light. `slot` answers whether a caster must be rebuilt;
 * `rebuilds()` counts what the frame paid for, which is what a test asserts on.
 */
class CasterPlan {
  public:
    /** Sizes the frame to `count` casters and clears the frame's rebuild count. */
    void begin(std::size_t count) {
        if (slots_.size() < count) slots_.resize(count);
        used_ = count;
        rebuilds_ = 0;
    }

    /**
     * The slot for one caster. `stale` is true when its inputs or its world matrix moved since the last
     * frame, and only then is it worth rebuilding; an unchanged caster keeps last frame's bounds and state.
     */
    PlannedCaster& slot(std::size_t index, const std::array<double, 16>& world, const CasterInputs& inputs, bool& stale) {
        PlannedCaster& slot = slots_[index];
        stale = !slot.valid || slot.state.world.elements != world ||
                slot.inputs.positions != inputs.positions || slot.inputs.positionsVersion != inputs.positionsVersion ||
                slot.inputs.instances != inputs.instances || slot.inputs.instanceVersion != inputs.instanceVersion ||
                slot.inputs.instanceCount != inputs.instanceCount || slot.inputs.layers != inputs.layers ||
                slot.inputs.cache != inputs.cache || slot.inputs.casts != inputs.casts ||
                slot.inputs.controlEpoch != inputs.controlEpoch;
        if (stale) {
            slot.state.world.elements = world;
            slot.inputs = inputs;
            slot.valid = true;
            ++rebuilds_;
        }
        return slot;
    }

    /** Casters rebuilt this frame. */
    [[nodiscard]] uint64_t rebuilds() const { return rebuilds_; }
    [[nodiscard]] std::size_t size() const { return used_; }
    [[nodiscard]] const PlannedCaster& at(std::size_t index) const { return slots_[index]; }

  private:
    std::vector<PlannedCaster> slots_;
    std::size_t used_ = 0;
    uint64_t rebuilds_ = 0;
};

} // namespace tn::engine::shadows
