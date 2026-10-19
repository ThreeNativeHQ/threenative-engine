#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

#include "engine/animation/mixer.h"

namespace tn::engine::animation {

/**
 * The engine's animation schedule (PRD-516, §6.4). A mixer it manages advances once per simulation
 * tick, by that tick's step, unless the game already called `mixer.update()` itself during the tick:
 * an explicit update is synchronous, so the game sees the pose straight away and the schedule does
 * not evaluate that mixer a second time. Rendering never evaluates a mixer, so the evaluation count
 * follows ticks, whatever the render count.
 */
class AnimationSchedule {
  public:
    void manage(AnimationMixer& mixer);
    void release(AnimationMixer& mixer);

    /** Opens a tick: game code that runs before `closeTick` may update a managed mixer itself. */
    void openTick();
    /** Closes it: every managed mixer not updated since `openTick` advances by `dt`. Returns how many. */
    std::size_t closeTick(double dt);

  private:
    struct Entry {
        AnimationMixer* mixer;
        std::uint64_t updatesAtOpen;
    };
    std::vector<Entry> mixers_;
};

} // namespace tn::engine::animation
