#pragma once

// Native Rapier driven by the engine's own loop (PRD-528 boxes 53/54): the fixed-step clock decides
// when the world advances — one Rapier step per clock update, at the step the clock was built with —
// and every body's translation and rotation land in the native scene graph with no TypeScript round
// trip. Each update also appends the collision events Rapier reported, in the order it reported them.
//
// The world is the prebuilt Rust Rapier library behind its C ABI (`threenative/physics_native.h`),
// the same one `src/physics/native_bindings.cpp` hands to a script: this class never touches a VM.

#include <cstdint>
#include <map>
#include <vector>

#include "engine/foundation/math/Vector.h"
#include "engine/scene/object3d.h"
#include "engine/world/loop/fixed_step.h"

struct TnPhysicsBodyOptions;
struct TnPhysicsCharacterOptions;
struct TnPhysicsSimulation;

namespace tn::engine::world {

/** One collision event, as Rapier paired it: the two body ids and whether the pair started. */
struct PhysicsSyncEvent {
    uint32_t first = 0;
    uint32_t second = 0;
    bool started = false;
};

/**
 * A Rapier world bound to scene nodes and stepped by `FixedStepClock`.
 *
 * Fail-closed, and never throws: a gravity or fixed step that is not a finite positive number, or a
 * world the ABI refuses to create, leaves `ok()` false, and every call then refuses.
 */
class PhysicsSync {
  public:
    /** A world under `gravity`, advancing `fixedStepSeconds` per clock update, at most `maxSteps`
     *  updates per frame. */
    PhysicsSync(const Vector3& gravity, double fixedStepSeconds, uint32_t maxSteps);
    ~PhysicsSync();
    PhysicsSync(const PhysicsSync&) = delete;
    PhysicsSync& operator=(const PhysicsSync&) = delete;

    /** Begin at `nowMs`; the first `advance` from that same timestamp banks nothing. */
    void start(double nowMs) { clock_.start(nowMs); }

    /** Adds a body and binds `node` to it: `addBody` writes its initial transform, and every update
     *  writes the stepped one. The node is borrowed, so it must outlive this sync. */
    bool addBody(const TnPhysicsBodyOptions& options, Object3D& node);
    bool configureCharacter(const TnPhysicsCharacterOptions& options);
    bool removeBody(uint32_t id);
    bool setBodyTransform(uint32_t id, const Vector3& position);
    /** Where a kinematic body must be before the next update. Targets are consumed by that update, so
     *  a body that keeps moving is re-armed every frame, as the web path re-sends its snapshot. */
    bool setKinematicTarget(uint32_t id, const Vector3& position);

    /** Bank `nowMs`, run the clock's updates and return how many ran. Each one steps Rapier at the
     *  fixed step, writes every bound body's transform and appends its collision events, replacing
     *  the previous frame's: a frame that ran no update reports none. */
    uint32_t advance(double nowMs);

    /** The fixed updates run since `start`. */
    [[nodiscard]] uint64_t tick() const { return clock_.tick(); }
    /** This frame's events, in Rapier's order. */
    [[nodiscard]] const std::vector<PhysicsSyncEvent>& events() const { return events_; }
    [[nodiscard]] bool ok() const { return simulation_ != nullptr && !failed_; }

    /** The owned world, for the reads this class does not shape: character state, area
     *  intersections, contact manifolds, sleep states. */
    [[nodiscard]] TnPhysicsSimulation* simulation() const { return simulation_; }

  private:
    void writeTransforms();
    void drainEvents();

    TnPhysicsSimulation* simulation_ = nullptr;
    FixedStepClock clock_;
    double step_ = 0.0;
    bool failed_ = false;
    std::map<uint32_t, Object3D*> bindings_;
    std::vector<std::pair<uint32_t, Vector3>> kinematic_;
    std::vector<float> input_;
    std::vector<float> transforms_;
    std::vector<uint32_t> event_records_;
    std::vector<PhysicsSyncEvent> events_;
};

} // namespace tn::engine::world
