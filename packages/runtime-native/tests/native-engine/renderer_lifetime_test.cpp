// Two lifetime bugs around a texture's retirement and a probe capture that races the frame-pumped
// PMREM bake. Both run on the real headless WebGPU device because each one is a GPU resource path.
//
// `shared_retired_sweep`: several Renderers cache the same texture, and a texture's disposal is one
// event. A single global takeRetired() list let whichever renderer swept first consume the id, so a
// second renderer kept an in-flight environment preparation reading a disposed source.
// `probe_capture_environment`: captureFace draws one frame. While the capture renderer's
// scene.environment is still baking, render() returns 0 and draws nothing, so the readback must not
// publish the previous (or an undefined) target as a valid face.

#include "check.h"
#include "engine/assets/probe_volume.h"
#include "engine/renderer/probes/capture.h"
#include "engine/renderer/renderer.h"
#include "engine/scene/geometries.h"
#include "engine/scene/material.h"
#include "engine/scene/nodes.h"
#include "engine/scene/texture.h"
#include "mystral/webgpu/context.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <cstdio>
#include <functional>
#include <memory>
#include <new>
#include <string>
#include <thread>
#include <vector>

using namespace tn::engine;

namespace {

bool waitFor(Renderer& renderer, const std::function<bool()>& done) {
    for (int i = 0; i < 5000 && !done(); ++i) {
        renderer.poll();
        renderer.events().drain();
        if (!done()) std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    return done();
}

probes::ProbeVolume probeVolume() {
    probes::ProbeVolumeDescription description;
    std::fill_n(description.boundsMax, 3, 1.0);
    probes::ProbeScheduleOptions options;
    options.bounces = 0;
    options.bakeBudgetMs = 1000;
    options.maxWorkItemsPerFrame = 1;
    probes::ProbeVolume volume;
    std::string error;
    CHECK(probes::ProbeVolume::create(description, options, 8, volume, error));
    return volume;
}

// Renderer 1 sweeps a retired environment source first; renderer 2 still holds an in-flight
// preparation for that same source and must abandon it rather than keep pumping a disposed texture.
void sharedRetiredSweep() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer first(context.getInstance(), context.getDevice(), context.getQueue(), events);
    Renderer second(context.getInstance(), context.getDevice(), context.getQueue(), events);

    auto sky = std::make_shared<DataTexture>();
    sky->mapping = 303;
    sky->width = 128;
    sky->height = 64;
    sky->data.assign(size_t(sky->width) * sky->height * 4, 255);
    sky->needsUpdate();
    std::array<DrawItem, 1> items{};
    items[0].envMap = sky.get();

    CHECK(!first.prepareEnvironments(items));   // begins the bake and submits its first packet
    CHECK(!second.prepareEnvironments(items));
    CHECK(first.materialTextureCount() == 1);
    CHECK(second.materialTextureCount() == 1);

    // Dispose the texture exactly as Texture's destructor does: retire its identity. The object
    // stays addressable so the old path's read of the disposed source is a wrong state, not a crash
    // the test would mistake for a reproduction.
    const uint64_t ident = sky->ident.value();
    sky->ident.~TextureId();
    new (&sky->ident) TextureId();
    CHECK(sky->ident.value() != ident);

    // The first renderer sweeps the retirement. Before the fix it consumes the one global list here.
    CHECK(first.prepareEnvironments({}));
    CHECK(first.materialTextureCount() == 0);

    // Wait out the second renderer's in-flight packet, so a preparation that is still alive would
    // submit more work on the next call. The retired source must instead be abandoned: no packet,
    // and its GPU copy released.
    CHECK(waitFor(second, [&] { return second.gpu().completedSerial() >= second.gpu().submittedSerial(); }));
    const uint64_t submitted = second.gpu().submittedSerial();
    second.prepareEnvironments({});
    CHECK(second.gpu().submittedSerial() == submitted);
    CHECK(second.materialTextureCount() == 0);
}

// captureFace must wait for the environment bake rather than publish whatever the capture target
// held before the skipped frame.
void probeCaptureDuringEnvironmentBake() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    auto volume = probeVolume();

    // A first, environment-free face leaves the capture target a deterministic black. The second
    // capture skips its frame while the environment bakes and would publish exactly this black.
    Scene empty;
    bool warmDone = false;
    std::vector<float> warm;
    CHECK(probes::captureFace(renderer, empty, volume, "probe", 0, 0, 0.1, 20,
                              [&](GpuStatus status, std::vector<float> rgb) {
                                  CHECK(status == GpuStatus::Ok);
                                  warm = std::move(rgb);
                                  warmDone = true;
                              }) == GpuStatus::Ok);
    CHECK(waitFor(renderer, [&] { return warmDone; }));
    CHECK(warm.size() == size_t(volume.cubemapSize()) * volume.cubemapSize() * 3);
    CHECK(std::all_of(warm.begin(), warm.end(), [](float value) { return value == 0.0f; }));

    // A white room around the probe plus a scene environment: the environment starts an unbaked
    // PMREM, and drawing the room should produce white in every direction.
    Scene scene;
    auto material = std::make_shared<Material>(MaterialType::Standard);
    material->side = Side::Back;
    Mesh room(makeBoxGeometry(6, 6, 6), material);
    scene.add(room);
    auto sky = std::make_shared<DataTexture>();
    sky->mapping = 303;
    sky->width = 128;
    sky->height = 64;
    sky->data.assign(size_t(sky->width) * sky->height * 4, 255);
    sky->needsUpdate();
    scene.environment = sky;
    scene.background = std::make_shared<Color>(1, 1, 1);
    scene.updateMatrixWorld(true);

    bool faceDone = false;
    std::vector<float> face;
    CHECK(probes::captureFace(renderer, scene, volume, "probe", 0, 0, 0.1, 20,
                              [&](GpuStatus status, std::vector<float> rgb) {
                                  CHECK(status == GpuStatus::Ok);
                                  face = std::move(rgb);
                                  faceDone = true;
                              }) == GpuStatus::Ok);
    CHECK(waitFor(renderer, [&] { return faceDone; }));
    CHECK(face.size() == size_t(volume.cubemapSize()) * volume.cubemapSize() * 3);
    // A frame was actually drawn on the capture renderer: the bake finished instead of the capture
    // being skipped, and the face is the room's white rather than the previous black target.
    CHECK(!renderer.probeCaptureRenderer().environmentPending());
    CHECK(!face.empty() && std::all_of(face.begin(), face.end(), [](float value) { return value > 0.5f; }));
}

}  // namespace

TN_TEST_MAIN({"shared_retired_sweep", sharedRetiredSweep},
             {"probe_capture_environment", probeCaptureDuringEnvironmentBake})
