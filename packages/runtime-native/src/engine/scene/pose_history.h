// PRD-877: physics interpolation without leaving the engine.
//
// Today core blends a body's previous and current pose in JavaScript: three `lerp`s, one `slerp`, one
// Euler sync and a dirty mark per body per frame, which the sizing gate measured at 1.05 ms a frame
// with 11,189 shared transform writes. This keeps the same state the engine already owns and does the
// blend in one call.
//
// The state is three poses, not a ring buffer: what `tick` solved this frame, what it solved last
// frame, and what the object held before a blend touched it. `blend` never writes a pose it cannot
// restore, and `restore` puts the solved pose back bit for bit, so a physics step that reads a
// transform after interpolation sees the body, not the picture of the body.
#ifndef TN_ENGINE_SCENE_POSE_HISTORY_H
#define TN_ENGINE_SCENE_POSE_HISTORY_H

#include <cstddef>
#include <memory>
#include <vector>

#include "engine/scene/object3d.h"

namespace tn::engine {

class PoseHistory {
public:
    struct Pose {
        double position[3] = {0, 0, 0};
        double quaternion[4] = {0, 0, 0, 1};

        [[nodiscard]] bool operator==(const Pose& other) const;
        [[nodiscard]] bool operator!=(const Pose& other) const { return !(*this == other); }
    };

    /** Replaces the watched list. Objects keep their history when they stay, so adding one refills
     *  only what is new; dropping one forgets it. */
    void watch(const std::vector<Object3D*>& objects);

    /** Forgets every pose but keeps watching, for a body that teleported: the next tick records a
     *  fresh pair, so the frame after a teleport does not blend across the gap. */
    void reset();

    /** Records this frame's solved pose. The pose recorded last time becomes the one to blend from.
     *  `phase` is the frame's position in its physics step; at or past 1 the step is not interpolating
     *  and nothing is recorded, which is how a paused or catching-up frame stays exact. */
    void tick(double phase);

    /** Writes `last + (latest - last) * alpha` on every watched object that still holds the pose this
     *  history recorded: position lerped, orientation slerped, Euler following the quaternion, local
     *  transform marked dirty. An object somebody else moved since `tick` is reset instead of blended,
     *  because blending against a pose the engine did not solve would show a body in two places.
     *  Throws `std::invalid_argument` unless `alpha` is a finite number in [0, 1]. */
    void blend(double alpha);

    /** Puts every watched object back on the solved pose, bit for bit, and marks it dirty. */
    void restore();

    [[nodiscard]] std::size_t size() const { return entries_.size(); }

    [[nodiscard]] static Pose poseOf(const Object3D& object);

private:
    struct Entry {
        std::weak_ptr<Object3D> object;
        Pose latest;
        Pose previous;
        bool hasPrevious = false;
        bool enabled = true;
    };

    void writePose(Object3D& object, const Pose& pose);

    std::vector<Entry> entries_;
};

} // namespace tn::engine

#endif
