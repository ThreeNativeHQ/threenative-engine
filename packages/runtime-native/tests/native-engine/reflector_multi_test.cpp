// One material that samples two reflectors: the stream joining two kettle ponds. three draws it —
// each ReflectorNode owns its render target — so the owned engine must too. It refused it with
// TN_NATIVE_REFLECTOR_UNSUPPORTED while GraphFind held one reflector per material.
//
// Scene: two mirror planes at different heights (y = 0 and y = 4), a red box 2.9 above the low one
// and a blue box 3.3 above the high one, and one river quad in front of both that draws the sum of
// the two reflections. Each mirror's pass shows only its own box, on its own side of the screen,
// so a binding that shared one view would leave one of the two colours missing.

#include "check.h"
#include "engine/renderer/render_database.h"
#include "engine/renderer/reflector.h"
#include "engine/scene/geometries.h"
#include "engine/shader/graph/graph.h"
#include "mystral/webgpu/context.h"
#include "mystral/webgpu_compat.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <thread>
#include <vector>

using namespace tn::engine;

namespace {

std::vector<uint8_t> readFrame(Renderer& r, EventQueue& events) {
    std::vector<uint8_t> out;
    bool done = false;
    r.readPixels([&](GpuStatus s, std::vector<uint8_t> px) {
        if (s == GpuStatus::Ok) out = std::move(px);
        done = true;
    });
    for (int i = 0; i < 4000 && !done; ++i) {
        r.poll();
        events.drain();
        if (!done) std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    return out;
}

// Two ponds at different heights, both sampled by the one river material.
struct TwoPonds {
    Scene scene;
    PerspectiveCamera camera;
    std::shared_ptr<Material> river = std::make_shared<Material>(MaterialType::Standard);
    std::shared_ptr<Reflector> low = std::make_shared<Reflector>();
    std::shared_ptr<Reflector> high = std::make_shared<Reflector>();
    std::shared_ptr<Object3D> lowPlane = std::make_shared<Object3D>();
    std::shared_ptr<Object3D> highPlane = std::make_shared<Object3D>();
    std::shared_ptr<Mesh> riverMesh, redBox, blueBox;
    std::shared_ptr<DirectionalLight> sun = std::make_shared<DirectionalLight>(Color(1, 1, 1), 3.0);
    std::shared_ptr<HemisphereLight> sky =
        std::make_shared<HemisphereLight>(Color(0.6, 0.7, 0.9), Color(0.1, 0.1, 0.1), 1.0);

    explicit TwoPonds() {
        camera.fov = 55;
        camera.aspect = 4.0 / 3;
        camera.near = 0.5;
        camera.far = 200;
        camera.position.set(0, 6, 8);
        camera.lookAt(0, 5, -8);
        camera.updateProjectionMatrix();

        // The mirror planes' frames: local +z is the plane normal, so turning the frame puts a
        // horizontal mirror at its own height, as WaterSurface3D does.
        lowPlane->position.y = 0;
        lowPlane->rotateX(-3.141592653589793 / 2);
        scene.add(*lowPlane);
        highPlane->position.y = 4;
        highPlane->rotateX(-3.141592653589793 / 2);
        scene.add(*highPlane);
        low->target = lowPlane;
        low->camera = std::make_shared<PerspectiveCamera>();
        high->target = highPlane;
        high->camera = std::make_shared<PerspectiveCamera>();

        // Unlit boxes: the reflection of each one is exactly its colour in that mirror's image.
        auto red = std::make_shared<Material>(MaterialType::Basic);
        red->color.setRGB(1, 0, 0);
        redBox = std::make_shared<Mesh>(makeBoxGeometry(), red);
        redBox->position.set(-4.9, 2.9, -6);  // 2.9 above the low pond's plane, behind the river
        scene.add(*redBox);
        auto blue = std::make_shared<Material>(MaterialType::Basic);
        blue->color.setRGB(0, 0, 1);
        blueBox = std::make_shared<Mesh>(makeBoxGeometry(), blue);
        blueBox->position.set(4.8, 7.3, -6);  // 3.3 above the high pond's plane
        scene.add(*blueBox);

        // The river: one material, both reflections, summed where the camera sees it.
        namespace g = shader::graph;
        const auto screen = g::screenUV();
        const auto flipped = g::vec2({g::sub(g::float_(1), g::swizzle(screen, "x")), g::swizzle(screen, "y")});
        river->nodes.colorNode = g::add(g::reflectorTexture(low, flipped), g::reflectorTexture(high, flipped));
        river->needsUpdate();
        riverMesh = std::make_shared<Mesh>(makePlaneGeometry(40, 40), river);
        riverMesh->position.z = -2;
        scene.add(*riverMesh);

        sun->position.set(10, 30, 10);
        scene.add(*sun);
        scene.add(*sky);
        scene.updateMatrixWorld(true);
    }
};

// How many of a pass's draws sit at x: the box only that mirror shows.
std::size_t drawnAt(const RenderDatabase& pass, double x) {
    std::size_t found = 0;
    for (const DrawItem& item : pass.drawn())
        if (item.mainPass && std::abs(item.matrixWorld[12] - x) < 1e-6) ++found;
    return found;
}

// A dominant colour's pixels: how many, and where their centre of mass sits across the frame.
struct ColourMass {
    int pixels = 0;
    double centreX = 0;
};

ColourMass massOf(const std::vector<uint8_t>& frame, int width, int height, int channel) {
    ColourMass mass;
    long sumX = 0;
    for (int y = 0; y < height; ++y)
        for (int x = 0; x < width; ++x) {
            const std::size_t at = (std::size_t(y) * width + x) * 4;
            const int r = frame[at], g = frame[at + 1], b = frame[at + 2];
            const int own = channel == 0 ? r : b, other = channel == 0 ? g : r, third = channel == 0 ? b : g;
            if (own > 60 && own > 2 * other && own > 2 * third) { ++mass.pixels; sumX += x; }
        }
    mass.centreX = mass.pixels > 0 ? double(sumX) / mass.pixels : 0;
    return mass;
}

void twoReflectors() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(160, 120);
    TwoPonds s;

    RenderDatabase database;
    database.shadowMapEnabled = false;
    for (int frame = 0; frame < 4; ++frame) {
        try {
            database.render(renderer, s.scene, s.camera, {0.02, 0.02, 0.03, 1});
        } catch (const std::exception& error) {
            std::fprintf(stderr, "render refused a two-reflector material: %s\n", error.what());
            CHECK(false);
            return;
        }
    }

    // Each mirror drew its own pass, and each pass draws the box only that mirror reflects.
    const RenderDatabase* lowPass = database.reflectionDatabase(s.low.get());
    const RenderDatabase* highPass = database.reflectionDatabase(s.high.get());
    CHECK(lowPass != nullptr && highPass != nullptr);
    CHECK(lowPass != highPass);
    if (!lowPass || !highPass) return;
    CHECK(drawnAt(*lowPass, -4.9) == 1 && drawnAt(*lowPass, 4.8) == 0);
    CHECK(drawnAt(*highPass, 4.8) == 1 && drawnAt(*highPass, -4.9) == 0);
    std::printf("two reflectors: low pass %zu draws, high pass %zu draws\n", lowPass->drawn().size(),
                highPass->drawn().size());

    // The river's draw binds both mirrors, each through its own view.
    const DrawItem* riverItem = nullptr;
    for (const DrawItem& item : database.drawn())
        if (item.materialKey == s.river.get() && item.mainPass) riverItem = &item;
    CHECK(riverItem != nullptr);
    if (!riverItem) return;
    CHECK(riverItem->reflectors != nullptr);
    if (!riverItem->reflectors) return;
    CHECK(riverItem->reflectors->size() == 2);
    if (riverItem->reflectors->size() != 2) return;
    const auto& [firstName, firstReflector, firstView, firstSampler] = (*riverItem->reflectors)[0];
    const auto& [secondName, secondReflector, secondView, secondSampler] = (*riverItem->reflectors)[1];
    std::printf("two reflectors: bindings %s %s\n", firstName.c_str(), secondName.c_str());
    CHECK(firstName != secondName);
    CHECK(firstReflector != secondReflector && firstReflector && secondReflector);
    CHECK(firstView && secondView && firstView != secondView);
    CHECK(firstSampler && secondSampler);

    // Both reflections reach the frame: the low mirror's red box on the left, the high one's blue
    // box on the right. A draw that bound one view under both names would miss one of the two.
    const auto frame = readFrame(renderer, events);
    CHECK(frame.size() == std::size_t{160} * 120 * 4);
    if (!frame.empty()) {
        const ColourMass red = massOf(frame, 160, 120, 0), blue = massOf(frame, 160, 120, 2);
        std::printf("two reflectors: red %d px at x=%.0f, blue %d px at x=%.0f\n", red.pixels, red.centreX,
                    blue.pixels, blue.centreX);
        CHECK(red.pixels > 0 && red.centreX < 80);
        CHECK(blue.pixels > 0 && blue.centreX > 80);
    }
}

}  // namespace

TN_TEST_MAIN({"two_reflectors", twoReflectors})
