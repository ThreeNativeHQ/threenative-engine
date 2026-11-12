// PRD-877: physics interpolation without leaving the engine.
//
// Core blends a body's previous and current pose in JavaScript today: three `lerp`s, one `slerp`, one
// Euler sync and a dirty mark per body per frame, which the sizing gate measured at 1.05 ms a frame
// with 11,189 shared transform writes. This keeps the same state in C++ and does the blend in one call.
//
// Three poses per object, as the PRD's Solution table names them: `previous` (what the body held when
// the tick began), `current` (where the physics step put it) and `saved` (what the object held before
// the blend touched it). `restore` puts `saved` back bit for bit, so a step that reads a transform
// after interpolation sees the body and not the picture of the body.
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

        // Bit equality, not tolerance: `restore` promises the saved pose back exactly, and a slerp
        // that lands one ulp away from it is the bug this operator exists to catch.
        [[nodiscard]] bool operator==(const Pose& other) const;
        [[nodiscard]] bool operator!=(const Pose& other) const { return !(*this == other); }
    };

    /** Replaces the watched list and answers how many it accepted. An object that was already
     *  watched keeps its three poses; a new one gets previous = current = its pose now, so spawning
     *  a body does not reset the bodies beside it. */
    std::size_t watch(const std::vector<Object3D*>& objects);

    /** Sets previous = current = the pose now for the named objects: what a teleport announces, so
     *  the next blend does not cross the gap. */
    void reset(const std::vector<Object3D*>& objects);

    /** Phase 0 copies each pose to `previous` (the tick is starting); phase 1 copies it to `current`
     *  (the physics step has landed). Those are the only two phases core asks for. */
    void tick(double phase);

    /** For each watched object: when its pose differs from `current` something else moved it, so it
     *  resets rather than blends across a gap the simulation never made. Saves the pose, then writes
     *  the lerp and the slerp between `previous` and `current`.
     *  Throws `std::invalid_argument` unless `alpha` is a finite number in [0, 1]. */
    void blend(double alpha);

    /** Puts every object of the last blend back on the pose it held before that blend, bit for bit,
     *  and marks the transform dirty. A dead object is skipped. */
    void restore();

    [[nodiscard]] std::size_t size() const { return entries_.size(); }

    [[nodiscard]] static Pose poseOf(const Object3D& object);

private:
    struct Entry {
        std::weak_ptr<Object3D> object;
        Pose previous;
        Pose current;
        Pose saved;
    };

    static void writePose(Object3D& object, const Pose& pose);

    std::vector<Entry> entries_;
    // The entries the last blend touched, so the restore reaches exactly those and no others.
    std::vector<std::size_t> blended_;
};

} // namespace tn::engine

#endif
