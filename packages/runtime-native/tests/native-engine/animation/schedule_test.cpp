// PRD-516 phase 3: the scheduling contract. An explicit mixer.update() applies the pose straight
// away, and the engine schedule then leaves that mixer alone for the rest of the tick; a managed
// mixer the game did not touch advances exactly once when the tick closes.
#include "check.h"
#include "engine/animation/schedule.h"

#include <memory>

using namespace tn::engine;
using namespace tn::engine::animation;

namespace {

struct Rig {
    std::shared_ptr<Object3D> root = std::make_shared<Object3D>();
    std::shared_ptr<Object3D> hips = std::make_shared<Object3D>();
    AnimationMixer mixer{root};
    Rig() {
        hips->name = "hips";
        root->add(*hips);
        // hips.position.x goes 0 -> 1 over one second; every value below is exact in float32.
        auto clip = std::make_shared<AnimationClip>(
            "slide", -1, std::vector<KeyframeTrack>{{"hips.position", TrackType::Vector, {0, 1}, {0, 0, 0, 1, 0, 0}}});
        mixer.clipAction(clip)->play();
    }
};

void explicitUpdate() {
    Rig game, engine;
    AnimationSchedule schedule;
    schedule.manage(game.mixer);
    schedule.manage(engine.mixer);

    // Tick 1: the game updates its mixer itself and reads the pose at once.
    schedule.openTick();
    game.mixer.update(0.25);
    CHECK(game.hips->position.x == 0.25); // applied synchronously, not deferred to the schedule
    CHECK(engine.hips->position.x == 0);
    CHECK(schedule.closeTick(0.125) == 1); // only the untouched mixer
    CHECK(game.mixer.time == 0.25 && game.mixer.updateCount() == 1);
    CHECK(engine.mixer.time == 0.125 && engine.hips->position.x == 0.125);

    // Tick 2: nobody updates explicitly, so both advance once.
    schedule.openTick();
    CHECK(schedule.closeTick(0.125) == 2);
    CHECK(game.mixer.time == 0.375 && engine.mixer.time == 0.25);

    // Tick 3: a zero-length explicit update still counts as the game's update for that tick.
    schedule.openTick();
    game.mixer.update(0);
    CHECK(schedule.closeTick(0.125) == 1);
    CHECK(game.mixer.time == 0.375 && game.mixer.updateCount() == 3);
    CHECK(engine.mixer.time == 0.375);

    // A released mixer is the game's alone.
    schedule.release(engine.mixer);
    schedule.openTick();
    CHECK(schedule.closeTick(0.125) == 1);
    CHECK(engine.mixer.time == 0.375 && game.mixer.time == 0.5);
}

} // namespace

TN_TEST_MAIN({"explicit_update", explicitUpdate})
