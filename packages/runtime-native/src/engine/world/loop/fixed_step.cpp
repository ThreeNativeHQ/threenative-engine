#include "engine/world/loop/fixed_step.h"

#include <cfloat>
#include <cmath>
#include <limits>

namespace tn::engine::world {

FixedStepClock::FixedStepClock(double step, uint32_t maxSteps) : step_(step), maxSteps_(maxSteps) {}

void FixedStepClock::start(double nowMs) {
    // loop.ts's #lastTime and tick reset; the accumulator is not reset there either.
    lastTime_ = nowMs;
    started_ = true;
    tick_ = 0;
}

namespace {
// Math.max: NaN if either side is NaN (std::fmax returns the other side), and +0 over -0.
double jsMax(double a, double b) {
    if (std::isnan(a) || std::isnan(b))
        return std::numeric_limits<double>::quiet_NaN();
    if (a == b)
        return std::signbit(a) ? b : a;
    return a > b ? a : b;
}
} // namespace

// loop.ts's #advanceSimulation, operation for operation. Number.EPSILON is DBL_EPSILON.
uint32_t FixedStepClock::advance(double nowMs) {
    const double last = started_ ? lastTime_ : nowMs;
    const double elapsed = jsMax(0.0, (nowMs - last) / 1000.0);
    lastTime_ = jsMax(last, nowMs);
    started_ = true;
    accumulator_ += elapsed;
    uint32_t updates = 0;
    while (accumulator_ + DBL_EPSILON >= step_ && updates < maxSteps_) {
        tick_ += 1;
        accumulator_ -= step_;
        updates += 1;
    }
    if (updates == maxSteps_ && accumulator_ >= step_)
        accumulator_ = 0.0;
    return updates;
}

uint64_t FixedStepClock::tick() const { return tick_; }

double FixedStepClock::interpolationAlpha() const { return accumulator_ / step_; }

} // namespace tn::engine::world
