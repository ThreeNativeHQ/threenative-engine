#pragma once

#include <cstdint>

namespace tn::engine::world {

/**
 * The fixed-step clock from packages/core/src/loop.ts (PRD-528 phase 1): the accumulate-and-catch-up
 * arithmetic behind `FixedStepLoop`, in binary64 and the same operation order, so a recorded run
 * produces the same update count, tick and interpolation alpha on native. The held and frozen
 * branches are deliberately not ported: they skip the whole block, and the native host that
 * replaces them is not this clock.
 */
class FixedStepClock {
  public:
    FixedStepClock(double step, uint32_t maxSteps);

    /** Begin at `nowMs`; the next advance from that same timestamp banks nothing. */
    void start(double nowMs);

    /** Bank `nowMs` and return the updates this frame ran, capped at maxSteps. */
    uint32_t advance(double nowMs);

    /** The number of fixed updates run since `start`. */
    uint64_t tick() const;

    /** The banked accumulator as a fraction of the step, for render interpolation. */
    double interpolationAlpha() const;

  private:
    double step_;
    uint32_t maxSteps_;
    double accumulator_ = 0.0;
    double lastTime_ = 0.0;
    bool started_ = false;
    uint64_t tick_ = 0;
};

} // namespace tn::engine::world
