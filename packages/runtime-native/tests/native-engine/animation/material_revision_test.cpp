// PRD-517 phase 1: an animated material property reaches the screen through the material revision.
// A colour track drives an unlit cube from red to blue: each mixer write bumps the material version
// (three's needsUpdate), the next render rebuilds that mesh's record and draws the new colour, and a
// frame whose value did not change bumps nothing and rebuilds nothing.
#include "check.h"
#include "engine/animation/mixer.h"
#include "engine/renderer/render_database.h"
#include "engine/scene/geometries.h"
#include "mystral/webgpu/context.h"

#include <chrono>
#include <cstdio>
#include <memory>
#include <thread>

using namespace tn::engine;
using namespace tn::engine::animation;

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

void materialRevision() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(64, 64);

    auto scene = std::make_shared<Scene>();
    auto material = std::make_shared<Material>(MaterialType::Basic);
    material->color.setRGB(1, 0, 0);
    auto cube = std::make_shared<Mesh>(makeBoxGeometry(2, 2, 2), material);
    cube->name = "cube";
    scene->add(*cube);
    PerspectiveCamera camera(50, 1, 0.1, 100);
    camera.position.set(0, 0, 5);
    camera.updateProjectionMatrix();
    scene->updateMatrixWorld(true);
    camera.updateMatrixWorld(true);

    AnimationMixer mixer(scene);
    auto clip = std::make_shared<AnimationClip>(
        "tint", -1, std::vector<KeyframeTrack>{{"cube.material.color", TrackType::Color, {0, 1}, {1, 0, 0, 0, 0, 1}}});
    AnimationAction& tint = *mixer.clipAction(clip);
    tint.setLoop(Loop::Once, 1); // held on its last key, so the track ends on blue instead of wrapping
    tint.clampWhenFinished = true;
    tint.play();
    RenderDatabase database;

    database.render(renderer, *scene, camera);
    const auto red = centre(renderer, events);
    const uint32_t v0 = material->version();
    const uint64_t r0 = database.rebuilds();

    mixer.update(0.5); // halfway: the track writes a new colour
    const uint32_t v1 = material->version();
    database.render(renderer, *scene, camera);
    const auto mid = centre(renderer, events);
    const uint64_t r1 = database.rebuilds();

    mixer.update(0); // the same value again: three's apply skips the write
    database.render(renderer, *scene, camera);
    const uint32_t v2 = material->version();
    const uint64_t r2 = database.rebuilds();

    mixer.update(0.5);
    database.render(renderer, *scene, camera);
    const auto blue = centre(renderer, events);

    std::printf(
        "material revision: versions %u %u %u, rebuilds %llu %llu %llu, centre (%d,%d,%d) (%d,%d,%d) (%d,%d,%d)\n", v0,
        v1, v2, (unsigned long long)r0, (unsigned long long)r1, (unsigned long long)r2, red[0], red[1], red[2], mid[0],
        mid[1], mid[2], blue[0], blue[1], blue[2]);
    CHECK(v1 > v0 && r1 == r0 + 1);            // the write bumped the version, the render rebuilt the record
    CHECK(v2 == v1 && r2 == r1);               // no change, no bump, no rebuild
    CHECK(red[0] > 200 && red[2] < 30);        // the first frame drew red
    CHECK(mid[0] < red[0] && mid[2] > red[2]); // the next render drew the animated colour
    CHECK(blue[0] < 30 && blue[2] > 200);      // and the end of the track is blue
    for (const std::string& d : database.diagnostics())
        std::fprintf(stderr, "%s\n", d.c_str());
    CHECK(database.diagnostics().empty());
}

} // namespace

TN_TEST_MAIN({"material_revision", materialRevision})
