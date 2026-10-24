// PRD-634: the owned engine's sun filter follows the browser's model (core `penumbraUv`): the disc
// radius is gap x tan(sourceAngle), so a plate's shadow edge widens linearly with its height above
// the floor. A uniform disc over a straight edge spans 10 to 90 percent across 2 x 0.687 radii.
#include "check.h"
#include "engine/renderer/render_database.h"
#include "engine/renderer/shadows/virtual/atlas.h"
#include "engine/scene/geometries.h"
#include "mystral/webgpu/context.h"
#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <thread>
#include <vector>

using namespace tn::engine;

namespace {

constexpr int kSize = 192;
constexpr double kHalf = 1.6;  // 3.2 m across 192 pixels: 16.7 mm each
constexpr double kAngle = 0.05;

// 10 to 90 percent width, in metres, of the shadow edge of a plate whose near edge is at x = 0.
// `samplesPerRay` 0 spreads the edge by the full gap; more is Unreal's shadow-ray test at 1.5 view distances.
double edgeWidth(double height, double samplesPerRay = 0) {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(kSize, kSize);
    OrthographicCamera camera(-kHalf, kHalf, kHalf, -kHalf, 0.1, 20);
    camera.position.set(0, 10, 0.001);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    Scene scene;
    DirectionalLight sun{Color(1, 1, 1), 3};
    sun.position.set(0, 10, 0.001);  // overhead: the gap is the plate's height, the edge is not stretched
    sun.setCastShadow(true);
    sun.shadow.camera->setLayerMask(double((1 << 0) | (1 << 2)));
    shadows::AtlasOptions atlas;
    atlas.clipExtents = {8}; atlas.mapSize = 2048; atlas.pageTexels = 128;  // 7.8 mm texels
    atlas.lightDistance = 20; atlas.depthRange = 40;
    sun.shadow.virtualShadow = std::make_shared<const shadows::AtlasOptions>(std::move(atlas));
    sun.shadow.sourceAngleFilter = std::array<double, 6>{kAngle, 16, 16, 0, samplesPerRay, 1.5};  // no pixel floor
    scene.add(sun);
    auto white = std::make_shared<Material>(MaterialType::Standard);
    Mesh floor{makeBoxGeometry(8, 0.2, 8), white};
    floor.position.y = -0.1;
    floor.setReceiveShadow(true);
    scene.add(floor);
    // The plate covers x 0..3, on layer 2 so the camera sees the floor under it.
    Mesh plate{makeBoxGeometry(3, 0.02, 3), white};
    plate.position.set(1.5, height, 0);
    plate.setCastShadow(true);
    plate.setLayer(2);
    scene.add(plate);
    scene.updateMatrixWorld(true);
    RenderDatabase database;
    database.shadowMapEnabled = true;
    for (int frame = 0; frame < 3; ++frame) database.render(renderer, scene, camera);
    std::vector<uint8_t> pixels;
    bool read = false;
    renderer.readPixels([&](GpuStatus status, std::vector<uint8_t> px) {
        if (status == GpuStatus::Ok) pixels = std::move(px);
        read = true;
    });
    for (int i = 0; i < 5000 && !read; ++i) {
        renderer.poll();
        events.drain();
        if (!read) std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    CHECK(pixels.size() == size_t{kSize} * kSize * 4);
    if (pixels.size() != size_t{kSize} * kSize * 4) return -1;
    std::vector<double> red(kSize);
    for (int x = 0; x < kSize; ++x) red[x] = pixels[(size_t{kSize / 2} * kSize + x) * 4];
    // The camera's x order is not assumed: the lit side is the brighter end of the row.
    if (red.front() < red.back()) std::reverse(red.begin(), red.end());
    const double lit = red[4], dark = red[kSize - 5];
    CHECK(lit > 32 && dark < 0.25 * lit);
    double high = -1, low = -1;
    for (int x = 4; x < kSize - 5; ++x) {
        const double level = (red[x] - dark) / (lit - dark), next = (red[x + 1] - dark) / (lit - dark);
        if (high < 0 && level >= 0.9 && next < 0.9) high = x + (level - 0.9) / (level - next);
        if (level >= 0.1 && next < 0.1) low = x + (level - 0.1) / (level - next);
    }
    CHECK(high >= 0 && low >= high);
    return (low - high) * 2 * kHalf / kSize;
}

void gapWidening() {
    const double nearW = edgeWidth(0.5), farW = edgeWidth(2);
    const double model = 2 * 0.687 * std::tan(kAngle);  // metres of 10..90 width per metre of gap
    std::printf("source angle: edge 10-90 width %.4f m at gap 0.5 (model %.4f), %.4f m at gap 2 (model %.4f)\n",
                nearW, 0.5 * model, farW, 2 * model);
    CHECK(std::abs(nearW / (0.5 * model) - 1) < 0.35);  // the texel (7.8 mm) and pixel (16.7 mm) widen a narrow edge
    CHECK(std::abs(farW / (2 * model) - 1) < 0.25);
    CHECK(farW / nearW > 2.5);  // linear in the gap: 4 by the model, less the fixed texel and pixel share
}

// PRD-634 AC-2: Unreal's shadow ray (4 samples at squared steps over 1.5 view distances, Epic) sees a
// caster at the distance of its first sample under it, so the edge spreads from that nearer gap (core
// shadowRayOccluderGap): at a 2 m gap 10 m from the camera, a 15 m ray sees 0.943 m.
void rayTestGap() {
    const double off = edgeWidth(2), on = edgeWidth(2, 4);
    const double reach = 15, x = std::sqrt(2 / reach), seen = reach * (x * x - x / 4 + 1.0 / 48);
    const double model = 2 * 0.687 * std::tan(kAngle) * seen;
    std::printf("ray test: edge 10-90 width %.4f m (model %.4f, seen gap %.3f m), %.4f m with the full gap\n",
                on, model, seen, off);
    CHECK(std::abs(on / model - 1) < 0.35);  // the texel and pixel widen it, as in gap_widening
    CHECK(on < 0.7 * off);
}

}  // namespace

TN_TEST_MAIN({"gap_widening", gapWidening}, {"ray_test_gap", rayTestGap})
