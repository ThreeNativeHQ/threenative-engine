#pragma once

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <deque>

namespace tn::engine {

// Whether the web host draws this frame, from the drawn frames the GPU has not reported done.
// Chromium queues submitted frames without bound, so a page whose rAF outruns the GPU blocks until the GPU
// drains and the GPU process is killed (the device is lost). The gate holds that queue back.
//
// It reads the age of the oldest unfinished frame against the loop's own measured interval, not a count: the
// work-done signal reaches the page as a promise, often a frame or two after the GPU finished, so a count of
// two declined frames the GPU had already drawn (7.5 % on the RTS kit, each one a visible stutter). A frame is
// declined only when the oldest unfinished one is `kBehindIntervals` loop intervals old, which a GPU that keeps
// up never reaches; `kMaxFrames` bounds the queue whatever the ages say.
class FrameGate {
public:
    static constexpr double kBehindIntervals = 4;
    static constexpr std::size_t kMaxFrames = 6;

    // Called once per frame attempt, before the draw: true declines the frame.
    bool decline(uint64_t completedSerial, double nowMs) {
        if (lastAttemptMs_ >= 0 && nowMs > lastAttemptMs_)
            intervalMs_ += 0.1 * (std::clamp(nowMs - lastAttemptMs_, 1.0, 100.0) - intervalMs_);
        lastAttemptMs_ = nowMs;
        while (!frames_.empty() && frames_.front().serial <= completedSerial) frames_.pop_front();
        if (frames_.size() >= kMaxFrames) return true;
        return frames_.size() >= 2 && nowMs - frames_.front().submittedMs > kBehindIntervals * intervalMs_;
    }

    // Called after a drawn frame's submit, with the serial the frame ended at.
    void submitted(uint64_t serial, double nowMs) { frames_.push_back({serial, nowMs}); }

    std::size_t unfinished() const { return frames_.size(); }

private:
    struct Frame {
        uint64_t serial;
        double submittedMs;
    };
    std::deque<Frame> frames_;
    double intervalMs_ = 1000.0 / 60.0;  // the loop's attempt interval, followed as it runs
    double lastAttemptMs_ = -1;
};

}  // namespace tn::engine
