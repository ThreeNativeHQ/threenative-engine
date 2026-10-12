#pragma once

#include <cstdint>
#include <string>

#include "engine/inspect/endpoint.h"
#include "engine/scene/camera.h"
#include "engine/scene/lights.h"
#include "engine/scene/nodes.h"

namespace tn::engine::player {

/**
 * `inspect-demo`, the one built-in game (PRD-529 phase 2): no scripting, so a playtest proves the
 * engine and not a bundle. A floor, a named box `player`, a named sphere `beacon` under a
 * directional light, and the held arrow or WASD keys move `player` 0.1 per tick on the floor plane.
 */
class InspectDemo {
  public:
    /**
     * The first injected keydown the per-tick callback saw: the tick the input was injected for and
     * the tick the callback first saw it. Equal ticks are the whole claim (PRD-528 box 59).
     */
    struct InputLatch {
        bool latched = false;
        std::string key;
        uint64_t injectedTick = 0;
        uint64_t seenTick = 0;
    };

    explicit InspectDemo(std::string name = "inspect-demo");

    Scene& scene() { return scene_; }
    const Scene& scene() const { return scene_; }
    PerspectiveCamera& camera() { return camera_; }
    const std::string& name() const { return name_; }

    /** Binds the endpoint the per-tick callback reads queued input from. */
    void attachEndpoint(inspect::Endpoint& endpoint) { endpoint_ = &endpoint; }

    /**
     * The game's per-tick callback, the shape a game's `update(dt)` has. The loop calls it once per
     * fixed tick with the step in seconds; it takes the input queued since the last tick first, so
     * input injected before tick N is read by tick N's game code (PRD-529 phase 1, box 41) rather
     * than tick N+1, then moves the player.
     */
    void update(double dt);

    /** The first injected keydown this callback saw, and the ticks a scenario compares. */
    [[nodiscard]] const InputLatch& inputLatch() const { return latch_; }

  private:
    void apply(const inspect::InputEvent& event);

    std::string name_;
    inspect::Endpoint* endpoint_ = nullptr;
    Scene scene_;
    PerspectiveCamera camera_;
    Mesh floor_;
    Mesh player_;
    Mesh beacon_;
    DirectionalLight light_;
    InputLatch latch_;
    bool heldLeft_ = false, heldRight_ = false, heldForward_ = false, heldBack_ = false;
};

}  // namespace tn::engine::player