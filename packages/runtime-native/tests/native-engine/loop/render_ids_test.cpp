// PRD-528 phase 1: tick ids and render ids are separate counters, and a second render in the same
// tick sees a mutation made between the two. One fixed-step tick runs; the cube is drawn at the
// centre, moved off it, and drawn again before the next tick: the two renders get distinct ids, the
// tick id does not move, and the second frame's centre pixel shows the background.
#include "check.h"
#include "engine/renderer/render_database.h"
#include "engine/scene/geometries.h"
#include "engine/world/loop/fixed_step.h"
#include "mystral/webgpu/context.h"

#include <chrono>
#include <cstdio>
#include <memory>
#include <thread>

using namespace tn::engine;

namespace {

std::array<int, 3> centre(Renderer& r, EventQueue& events) {
    std::vector<uint8_t> px;
    bool done = false;
    r.readPixels([&](GpuStatus s, std::vector<uint8_t> out) {
        if (s == GpuStatus::Ok)
            px = std::move(out);
        done = true;
    });
    for (int i = 0; i < 4000 && !done; ++i) {
        r.poll();
        events.drain();
        if (!done)
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    if (px.size() < 64 * 64 * 4)
        return {-1, -1, -1};
    const std::size_t at = (32 * 64 + 32) * 4;
    return {px[at], px[at + 1], px[at + 2]};
}

void renderIds() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(64, 64);

    Scene scene;
    auto material = std::make_shared<Material>(MaterialType::Basic);
    material->color.setRGB(1, 1, 1);
    Mesh cube(makeBoxGeometry(1, 1, 1), material);
    scene.add(cube);
    PerspectiveCamera camera(50, 1, 0.1, 100);
    camera.position.set(0, 0, 5);
    camera.updateProjectionMatrix();
    RenderDatabase database;

    world::FixedStepClock clock(1.0 / 60, 5);
    clock.start(0);
    CHECK(clock.advance(1000.0 / 60) == 1);
    const uint64_t tick = clock.tick();

    const uint64_t first = database.render(renderer, scene, camera);
    const auto drawn = centre(renderer, events);
    cube.position.x = 10; // off screen, between two renders of one tick
    const uint64_t second = database.render(renderer, scene, camera);
    const auto moved = centre(renderer, events);

    std::printf("render ids: tick %llu, renders %llu and %llu, centre (%d,%d,%d) then (%d,%d,%d)\n",
                (unsigned long long)tick, (unsigned long long)first, (unsigned long long)second, drawn[0], drawn[1],
                drawn[2], moved[0], moved[1], moved[2]);
    CHECK(second != first && second == first + 1); // a render id per render
    CHECK(clock.tick() == tick);                   // the tick id is not a render id
    CHECK(drawn[0] > 200 && drawn[1] > 200 && drawn[2] > 200);
    CHECK(moved[0] < 30 && moved[1] < 30 && moved[2] < 30); // the second render saw the move
    for (const std::string& d : database.diagnostics())
        std::fprintf(stderr, "%s\n", d.c_str());
    CHECK(database.diagnostics().empty());
}

} // namespace

TN_TEST_MAIN({"render_ids", renderIds})
