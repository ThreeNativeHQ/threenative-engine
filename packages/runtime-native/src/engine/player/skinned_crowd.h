#pragma once

#include "engine/animation/mixer.h"
#include "engine/animation/skinning/skeleton.h"
#include "engine/scene/camera.h"

namespace tn::engine::player {

/**
 * The example's 8×8 animated tube crowd, plus four individually drawn refusal cases. Without the
 * refusal cases it is exactly 64 identical rigs, the benchmark's presented crowd.
 */
class SkinnedCrowd {
  public:
    explicit SkinnedCrowd(bool refusalCases = true);
    Scene& scene() { return scene_; }
    PerspectiveCamera& camera() { return camera_; }
    void update(double dt);

  private:
    Scene scene_;
    PerspectiveCamera camera_{50, 16.0 / 9.0, 0.1, 200};
    std::shared_ptr<animation::AnimationClip> clip_;
    std::vector<std::unique_ptr<animation::AnimationMixer>> mixers_;
    uint64_t frames_ = 0;
};

} // namespace tn::engine::player
