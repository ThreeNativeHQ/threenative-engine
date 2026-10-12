#include "engine/animation/schedule.h"

#include <algorithm>

namespace tn::engine::animation {

void AnimationSchedule::manage(AnimationMixer& mixer) {
    if (std::none_of(mixers_.begin(), mixers_.end(), [&](const Entry& e) { return e.mixer == &mixer; }))
        mixers_.push_back({&mixer, mixer.updateCount()});
}

void AnimationSchedule::release(AnimationMixer& mixer) {
    std::erase_if(mixers_, [&](const Entry& e) { return e.mixer == &mixer; });
}

void AnimationSchedule::openTick() {
    for (Entry& e : mixers_)
        e.updatesAtOpen = e.mixer->updateCount();
}

std::size_t AnimationSchedule::closeTick(double dt) {
    std::size_t evaluated = 0;
    for (Entry& e : mixers_) {
        if (e.mixer->updateCount() != e.updatesAtOpen)
            continue; // the game updated it this tick
        e.mixer->update(dt);
        ++evaluated;
    }
    return evaluated;
}

} // namespace tn::engine::animation
