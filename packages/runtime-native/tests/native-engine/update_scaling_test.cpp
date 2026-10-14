#include "check.h"
#include "engine/renderer/render_database.h"
#include "engine/scene/geometries.h"

#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <cmath>

using namespace tn::engine;

namespace {
double measure(int count) {
    Scene scene;
    PerspectiveCamera camera;
    RenderDatabase database;
    database.profiling = true;
    LightState lights;
    const auto geometry = makeBoxGeometry();
    auto groundMaterial = std::make_shared<Material>(MaterialType::Standard);
    groundMaterial->color.setHex(0xb8c4cc);
    groundMaterial->roughness = 0.75;
    auto ground = std::make_shared<Mesh>(makePlaneGeometry(200, 200), groundMaterial);
    ground->rotation.set(-3.141592653589793 / 2, 0, 0);
    ground->matrixAutoUpdate = false;
    ground->updateMatrix();
    scene.add(*ground);
    DirectionalLight light;
    CHECK(light.isLight()); // Lights must not force the heterogeneous scene off the flat lane.
    light.intensity = 2.4;
    light.position.set(40, 80, 25);
    scene.add(light);
    camera.fov = 60;
    camera.aspect = 1280.0 / 720;
    camera.far = 4000;
    camera.updateProjectionMatrix();
    uint32_t seed = 1337;
    const auto random = [&]() { seed = seed * 1664525u + 1013904223u; return double(seed) / 4294967296.0; };
    const int side = int(std::ceil(std::sqrt(count)));
    const double half = (side - 1) / 2.0, extent = side * 2.5;
    std::vector<Vector3> base;
    base.reserve(count);
    std::vector<std::shared_ptr<Mesh>> meshes;
    meshes.reserve(count);
    for (int i = 0; i < count; ++i) {
        auto material = std::make_shared<Material>(MaterialType::Standard);
        material->color.setHex(0xff0000 | i);
        material->roughness = 0.75;
        auto mesh = std::make_shared<Mesh>(geometry, material);
        const double x = (i % side - half) * 2.5 + (random() - 0.5) * 1.5;
        const double z = (i / side - half) * 2.5 + (random() - 0.5) * 1.5;
        base.emplace_back(x, 0.5 + random() * 3, z);
        mesh->position.copy(base.back());
        scene.add(*mesh);
        meshes.push_back(std::move(mesh));
    }
    std::vector<double> times;
    std::array<std::vector<double>, 4> phases;
    std::vector<double> writes;
    for (int frame = 0; frame < 300; ++frame) {
        const double angle = frame * 0.0045;
        camera.position.set(std::cos(angle) * extent * 0.34, extent * 0.09 + 4, std::sin(angle) * extent * 0.34);
        camera.lookAt(std::cos(angle + 3.141592653589793) * extent * 0.12, 1.5,
                      std::sin(angle + 3.141592653589793) * extent * 0.12);
        const auto writeStart = std::chrono::steady_clock::now();
        for (int i = 0; i < count; ++i) {
            meshes[i]->position.y = base[i].y + std::sin(frame * 0.05 + i * 0.3) * 0.5;
            meshes[i]->rotation.set(i * 0.011 + frame * 0.013, i * 0.017 + frame * 0.02, 0);
        }
        const auto start = std::chrono::steady_clock::now();
        const auto items = database.prepare(scene, camera, lights);
        const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
        // Frustum culling (the renderer's default) keeps only the cubes the orbiting camera can see in
        // the batch, so its member count is bounded by `count` and no longer equal to it. A cube builds its
        // record the first time a frustum holds it and never again (PRD-610: an unseen cube builds nothing).
        CHECK(items.size() == 2 && database.lastBatches().second > 0 &&
              database.lastBatches().second <= static_cast<uint32_t>(count));
        CHECK(database.diagnostics().empty());
        CHECK(database.rebuilds() <= static_cast<uint64_t>(count + 1));
        if (frame >= 60) {
            times.push_back(ms);
            writes.push_back(std::chrono::duration<double, std::milli>(start - writeStart).count());
            for (int phase = 0; phase < 4; ++phase)
                phases[phase].push_back(database.lastPrepareMs()[phase]);
        }
    }
    std::sort(times.begin(), times.end());
    for (auto& phase : phases)
        std::sort(phase.begin(), phase.end());
    std::sort(writes.begin(), writes.end());
    std::printf("warm-cache update %d: %.4f ms (matrix %.4f, records %.4f, batch %.4f, other %.4f, writes %.4f)\n", count,
                times[times.size() / 2], phases[0][120], phases[1][120], phases[2][120], phases[3][120],
                writes[writes.size() / 2]);
    return times[times.size() / 2];
}

void scaling() {
    if (const auto* count = std::getenv("TN_UPDATE_OBJECTS")) {
        measure(std::atoi(count));
        return;
    }
    const double small = measure(4096), medium = measure(16384), large = measure(65536);
    std::printf("scaling: 16k/4k %.2fx, 64k/4k %.2fx (limit 18x)\n", medium / small, large / small);
    CHECK(large <= small * 18);
}

// The correctness half of the screen at a size that finishes in a second: every cube is re-read, the
// batch holds the visible ones, and no diagnostic fires.
void warmBatches() { measure(512); }
} // namespace

TN_TEST_MAIN({"scaling", scaling}, {"warm_batches", warmBatches})
