#pragma once

#include "engine/foundation/waste_counters.h"

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <deque>

namespace tn::engine {

// Whether the web host draws this frame, from the drawn frames the GPU has not reported done.
// Chromium queues submitted frames without bound, so a page whose rAF outruns the GPU blocks until the GPU
// drains and the GPU process is killed (the device is lost). The gate holds that queue back.
//
// It reads the age of the oldest unfinished frame against two things: how long the work-done signal normally
// takes to reach the page, and the loop's own measured interval. The signal is a promise, and a loaded host
// resolves it a steady 70-80 ms after the submit while the GPU frame itself costs a couple of milliseconds
// (2026-10-28, Chrome, the RTS kit), so an absolute age rule calls a constant delay a backlog and declines most
// of a 60 Hz page's frames (measured: 105-167 of 300). A constant delay is not a backlog: the gate learns the
// delay from the frames that do complete into `signalDelayMs_`, and declines a frame only when the oldest
// unfinished one is `kBehindIntervals` loop intervals OLDER than that delay. A signal that stays late never
// reaches the learned age; a GPU that falls behind climbs past it, faster than the average follows. Until a
// frame has completed there is nothing to learn, and the delay is zero, which is the plain age rule: the safe
// fallback, cheap to be wrong for the first frames of a page. A GPU that falls behind slowly enough for the
// average to follow its backlog is stopped by `kMaxFrames`, the hard bound on the queue whatever the ages say.
class FrameGate {
public:
    static constexpr double kBehindIntervals = 4;
    static constexpr std::size_t kMaxFrames = 6;

    // Called once per frame attempt, before the draw: true declines the frame.
    bool decline(uint64_t completedSerial, double nowMs) {
        waste::debugAdd(waste::counters().gateAttempts);
        if (lastAttemptMs_ >= 0 && nowMs > lastAttemptMs_)
            intervalMs_ += 0.1 * (std::clamp(nowMs - lastAttemptMs_, 1.0, 100.0) - intervalMs_);
        lastAttemptMs_ = nowMs;
        learnSignalDelay(completedSerial, nowMs);
        if (frames_.size() >= kMaxFrames) {
            waste::debugAdd(waste::counters().gateDeclinedCapacity);
            return true;
        }
        const bool behind = frames_.size() >= 2 &&
                            nowMs - frames_.front().submittedMs > signalDelayMs_ + kBehindIntervals * intervalMs_;
        if (behind) waste::debugAdd(waste::counters().gateDeclinedAge);
        return behind;
    }

    // Called after a drawn frame's submit, with the serial the frame ended at.
    void submitted(uint64_t serial, double nowMs) { frames_.push_back({serial, nowMs}); }

    std::size_t unfinished() const { return frames_.size(); }

private:
    struct Frame {
        uint64_t serial;
        double submittedMs;
    };

    // The frames the signal has just reached: the newest of them is the one whose delay was just observed.
    void learnSignalDelay(uint64_t completedSerial, double nowMs) {
        double delayMs = -1;
        while (!frames_.empty() && frames_.front().serial <= completedSerial) {
            delayMs = nowMs - frames_.front().submittedMs;
            frames_.pop_front();
        }
        if (delayMs < 0) return;
        // A sample is clamped to 0..1000 ms, a sane range: a serial or a clock that jumps must not teach the gate a
        // delay no host has, and the bound is wide enough that the learning follows a real one within frames.
        signalDelayMs_ += 0.1 * (std::clamp(delayMs, 0.0, 1000.0) - signalDelayMs_);
    }

    std::deque<Frame> frames_;
    double intervalMs_ = 1000.0 / 60.0;  // the loop's attempt interval, followed as it runs
    double signalDelayMs_ = 0;  // how late the work-done signal reaches the page, learned; zero until it has
    double lastAttemptMs_ = -1;
};

}  // namespace tn::engine
