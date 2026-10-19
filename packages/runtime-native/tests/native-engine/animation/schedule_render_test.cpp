// PRD-516 phase 3: the animation update count follows simulation ticks, never renders. A fixed-step
// clock drives frames that carry zero, one or several ticks and zero to three renders each; the
// schedule evaluates the managed mixer once per tick, and a render (the real renderer, headless)
// neither evaluates the mixer nor moves the pose, so two renders in one tick see one evaluation.
#include "check.h"
#include "engine/animation/schedule.h"
#include "engine/renderer/render_database.h"
#include "engine/scene/geometries.h"
#include "engine/world/loop/fixed_step.h"
#include "mystral/webgpu/context.h"

#include <cstdio>
#include <memory>

using namespace tn::engine;
using namespace tn::engine::animation;

namespace {

void tickVsRender() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(64, 64);

    auto scene = std::make_shared<Scene>();
    auto mesh = std::make_shared<Mesh>(makeBoxGeometry(1, 1, 1), std::make_shared<Material>(MaterialType::Basic));
    mesh->name = "hips";
    scene->add(*mesh);
    PerspectiveCamera camera;
    camera.position.set(0, 0, 5);
    camera.updateProjectionMatrix();
    AnimationMixer mixer(scene);
    auto clip = std::make_shared<AnimationClip>(
        "slide", -1, std::vector<KeyframeTrack>{{"hips.position", TrackType::Vector, {0, 1}, {-1, 0, 0, 1, 0, 0}}});
    mixer.clipAction(clip)->play();
    AnimationSchedule schedule;
    schedule.manage(mixer);
    RenderDatabase database;

    const double step = 1.0 / 60;
    world::FixedStepClock clock(step, 5);
    // Frame times (ms) and renders per frame: 0, 1, 2 and 3 renders against 0, 1 and 2 ticks.
    const double frames[] = {0, 8, 16.7, 33.4, 41, 75, 75.5, 92.2, 125.6, 126};
    const int renders[] = {2, 1, 2, 3, 2, 0, 2, 2, 1, 3};
    clock.start(frames[0]);
    uint64_t ticks = 0, totalRenders = 0;
    bool sawTwoRendersInOneTick = false;
    for (std::size_t f = 0; f < std::size(frames); ++f) {
        const uint32_t n = clock.advance(frames[f]);
        for (uint32_t i = 0; i < n; ++i) {
            schedule.openTick();
            schedule.closeTick(step);
            ++ticks;
        }
        const uint64_t evaluations = mixer.updateCount();
        const double x = mesh->position.x;
        for (int r = 0; r < renders[f]; ++r) {
            database.render(renderer, *scene, camera);
            ++totalRenders;
            CHECK(mixer.updateCount() == evaluations); // a render evaluates nothing
            CHECK(mesh->position.x == x);              // and moves nothing
        }
        if (n == 1 && renders[f] == 2)
            sawTwoRendersInOneTick = true;
    }
    std::printf("tick vs render: %llu ticks, %llu renders, %llu evaluations\n", (unsigned long long)ticks,
                (unsigned long long)totalRenders, (unsigned long long)mixer.updateCount());
    CHECK(sawTwoRendersInOneTick);
    CHECK(mixer.updateCount() == ticks && ticks == clock.tick());
    CHECK(totalRenders != ticks);
    CHECK(mesh->position.x > -1); // the schedule did move it
    for (const std::string& d : database.diagnostics())
        std::fprintf(stderr, "%s\n", d.c_str());
    CHECK(database.diagnostics().empty());
}

} // namespace

TN_TEST_MAIN({"tick_vs_render", tickVsRender})
