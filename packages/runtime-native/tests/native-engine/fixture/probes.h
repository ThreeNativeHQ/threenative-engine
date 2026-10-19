#pragma once
#include "engine/assets/probe_volume.h"
#include "engine/renderer/probes/capture.h"
#include "engine/scene/geometries.h"
#include "engine/scene/material.h"
#include "engine/scene/nodes.h"
#include "engine/scene/lights.h"
#include "../package_writer.h"
#include <algorithm>
#include <chrono>
#include <numeric>
#include <thread>

namespace tn::fixture::tsl_detail {
// Waiting belongs only in this desktop fixture driver; engine capture/readback is asynchronous.
inline bool probeWait(engine::Renderer& renderer, const std::function<bool()>& done) {
    for (int i = 0; i < 5000 && !done(); ++i) {
        renderer.poll();
        renderer.events().drain();
        if (!done())
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    return done();
}
inline std::string probeFixture(const std::string& program, engine::Scene& scene, engine::Renderer& renderer,
                                const std::function<std::string(uint32_t, uint32_t)>& renderAt) {
    namespace p = engine::probes;
    namespace g = engine::shader::graph;
    auto* left = dynamic_cast<engine::Mesh*>(scene.getObjectByName("probeReceiver"));
    auto* right = dynamic_cast<engine::Mesh*>(scene.getObjectByName("unaffectedReceiver"));
    if (!left || !right || !left->material || !right->material)
        return "TN_FIXTURE_PROBES_RECEIVER";
    p::ProbeVolumeDescription description;
    std::fill_n(description.boundsMin, 3, -0.5);
    std::fill_n(description.boundsMax, 3, 0.5);
    p::ProbeScheduleOptions options;
    options.bounces = 1;
    options.bakeBudgetMs = 1000;
    options.maxWorkItemsPerFrame = 1;
    p::ProbeVolume affected, unaffected;
    std::string error;
    if (!p::ProbeVolume::create(description, options, 8, affected, error) ||
        !p::ProbeVolume::create(description, options, 8, unaffected, error))
        return error;
    auto bind = [&](engine::Mesh& mesh, const p::ProbeVolume& probes, const std::string& name, double center) {
        const auto position = g::sub(g::varying("positionWorld", engine::shader::Type::vec(3)),
                                     g::vec3({g::float_(center), g::float_(0), g::float_(0)}));
        mesh.material->nodes.emissiveNode =
            g::div(engine::shader::probeSample(probes.placement(), name, position), g::float_(3.141592653589793));
        mesh.material->needsUpdate();
        renderer.setProbeVolume(name, probes);
    };
    struct CaptureScene {
        engine::Scene scene;
        std::shared_ptr<engine::Material> material =
            std::make_shared<engine::Material>(engine::MaterialType::Lambert, true);
        engine::Mesh room{engine::makeBoxGeometry(6, 6, 6), material};
        engine::PointLight light{engine::Color(0.2, 0.8, 1), 32, 0, 2};
        CaptureScene(const p::ProbeVolume& probes, const std::string& name) {
            material->side = engine::Side::Back;
            material->nodes.emissiveNode =
                g::div(engine::shader::probeSample(probes.placement(), name), g::float_(3.141592653589793));
            light.position.set(-1, 0, 1);
            scene.add(room);
            scene.add(light);
            scene.updateMatrixWorld(true);
        }
    };
    CaptureScene leftScene(affected, "left"), rightScene(unaffected, "right");
    auto converge = [&](p::ProbeVolume& probes, CaptureScene& captured, const std::string& name) {
        p::ProbeBaker baker(0.1, 20);
        for (uint32_t frame = 0; frame < 5000 && probes.pending(); ++frame) {
            if (baker.process(renderer, captured.scene, probes, name, error) == p::ProbeStepStatus::Refused)
                return false;
            renderer.poll();
            renderer.events().drain();
            if (baker.waiting())
                std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
        renderer.setProbeVolume(name, probes);
        return probes.ready() && !probes.pending();
    };
    if (program == "probes-baked") {
        // The cooked result is deliberately unlike the point-lit room. Recapturing is observable.
        p::ProbeVolume baked;
        if (!p::ProbeVolume::create(description, options, 8, baked, error))
            return error;
        for (uint32_t z = 0; z < 2; ++z)
            for (uint32_t y = 0; y < 2; ++y)
                for (uint32_t x = 0; x < 2; ++x) {
                    p::ProbeCoefficients c{};
                    c[0] = float(0.4 + 0.2 * x);
                    c[1] = float(1.2 + 0.2 * y);
                    c[2] = float(2 + 0.2 * z);
                    for (uint32_t i = 1; i < 9; ++i) {
                        c[i * 3] = float(0.03 * i * (x ? 1 : -1));
                        c[i * 3 + 1] = float(0.02 * i * (y ? 1 : -1));
                        c[i * 3 + 2] = float(0.01 * i * (z ? 1 : -1));
                    }
                    if (!baked.writeProbe(x + y * 2 + z * 4, c, error))
                        return error;
                }
        const auto payload = engine::assets::cookProbeVolumePayload(baked);
        const auto package = tn::test::writePackage({{"probes/fixture", 1, 0, payload, 0, {}}});
        engine::assets::PackageError failure;
        if (!engine::assets::loadProbeVolume(package, "fixture", affected, failure) ||
            !engine::assets::loadProbeVolume(package, "fixture", unaffected, failure))
            return failure.code;
        p::ProbeBaker idle(0.1, 20);
        for (int frame = 0; frame < 3; ++frame) {
            if (idle.process(renderer, leftScene.scene, affected, "left", error) != p::ProbeStepStatus::Finished ||
                idle.process(renderer, rightScene.scene, unaffected, "right", error) != p::ProbeStepStatus::Finished)
                return "TN_FIXTURE_PROBES_BAKED_RECAPTURE";
            renderer.poll();
            renderer.events().drain();
        }
        for (const auto* volume : {&affected, &unaffected})
            if (!volume->ready() || volume->pending() ||
                std::accumulate(volume->captureCounts().begin(), volume->captureCounts().end(), uint64_t(0)) != 0)
                return "TN_FIXTURE_PROBES_BAKED_RECAPTURE";
    } else {
        if (!affected.requestBake() || !converge(affected, leftScene, "left") || !unaffected.requestBake() ||
            !converge(unaffected, rightScene, "right"))
            return error.empty() ? "TN_FIXTURE_PROBES_CONVERGENCE" : error;
    }
    bind(*left, affected, "left", -1.1);
    bind(*right, unaffected, "right", 1.1);
    auto snapshot = [&](std::vector<uint8_t>& pixels) {
        if (const auto failed = renderAt(renderer.width(), renderer.height()); !failed.empty()) {
            error = failed;
            return false;
        }
        struct Result {
            bool done = false;
            engine::GpuStatus status = engine::GpuStatus::DeviceError;
            std::vector<uint8_t> pixels;
        };
        auto result = std::make_shared<Result>();
        if (renderer.readPixels([result](engine::GpuStatus s, std::vector<uint8_t> data) {
                result->status = s;
                result->pixels = std::move(data);
                result->done = true;
            }) != engine::GpuStatus::Ok ||
            !probeWait(renderer, [&] { return result->done; }) || result->status != engine::GpuStatus::Ok)
            return false;
        pixels = std::move(result->pixels);
        return pixels.size() == size_t(renderer.width()) * renderer.height() * 4;
    };
    std::vector<uint8_t> before, isolated, after;
    if (!snapshot(before))
        return "TN_FIXTURE_PROBES_READBACK: " + error;
    size_t lit = 0;
    for (size_t i = 0; i < before.size(); i += 4)
        if (std::max({before[i], before[i + 1], before[i + 2]}) > 8)
            ++lit;
    if (lit <= size_t(renderer.width()) * renderer.height() * 0.02)
        return "TN_FIXTURE_PROBES_NO_IRRADIANCE";
    if (program != "probes-relight")
        return "";
    const std::vector<uint64_t> untouched(unaffected.captureCounts().begin(), unaffected.captureCounts().end());
    leftScene.light.position.set(1, 0, 1);
    leftScene.light.color.setRGB(1, 0.25, 0.05);
    leftScene.scene.updateMatrixWorld(true);
    std::vector<uint32_t> affectedIndices(size_t(affected.placement().probeCount));
    std::iota(affectedIndices.begin(), affectedIndices.end(), 0);
    if (!affected.invalidate(affectedIndices, error))
        return error;
    renderer.setProbeVolume("left", affected);
    if (!snapshot(isolated))
        return "TN_FIXTURE_PROBES_FIRST_FRAME";
    size_t stalePixels = 0;
    for (uint32_t y = 42; y < renderer.height() - 42; ++y)
        for (uint32_t x = 43; x < 277; ++x) {
            if (x >= 151 && x < 169)
                continue;
            const auto offset = (size_t(y) * renderer.width() + x) * 4;
            if (x < 151) {
                if (isolated[offset] || isolated[offset + 1] || isolated[offset + 2])
                    ++stalePixels;
            } else if (!std::equal(before.begin() + offset, before.begin() + offset + 3, isolated.begin() + offset))
                return "TN_FIXTURE_PROBES_UNAFFECTED_PIXELS";
        }
    // A skipped invalidation leaves the converged cyan receiver covering 22% of the frame.
    if (stalePixels)
        return "TN_FIXTURE_PROBES_STALE_FRAME: " + std::to_string(stalePixels);
    if (!converge(affected, leftScene, "left"))
        return "TN_FIXTURE_PROBES_RELIGHT: " + error;
    if (!std::equal(untouched.begin(), untouched.end(), unaffected.captureCounts().begin()))
        return "TN_FIXTURE_PROBES_UNAFFECTED_RECAPTURE";
    if (!snapshot(after))
        return "TN_FIXTURE_PROBES_READBACK";
    size_t changed = 0;
    for (size_t i = 0; i < before.size(); i += 4)
        if (std::abs(int(before[i]) - int(after[i])) > 8 || std::abs(int(before[i + 1]) - int(after[i + 1])) > 8 ||
            std::abs(int(before[i + 2]) - int(after[i + 2])) > 8)
            ++changed;
    if (changed <= size_t(renderer.width()) * renderer.height() * 0.02)
        return "TN_FIXTURE_PROBES_NONDISCRIMINATING";
    return "";
}
} // namespace tn::fixture::tsl_detail
