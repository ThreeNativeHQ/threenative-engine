// Two lifetime bugs around a texture's retirement and a probe capture that races the frame-pumped
// PMREM bake. Both run on the real headless WebGPU device because each one is a GPU resource path.
//
// `shared_retired_sweep`: several Renderers cache the same texture, and a texture's disposal is one
// event. A single global takeRetired() list let whichever renderer swept first consume the id, so a
// second renderer kept an in-flight environment preparation reading a disposed source.
// `probe_capture_environment`: captureFace draws one frame. While the capture renderer's
// scene.environment is still baking, render() returns 0 and draws nothing, so captureFace must
// report Pending (and the caller retry) rather than publish the previous target as a valid face.
// `probe_capture_callback_camera`: an onBeforeRender during a capture gets the face camera, as three
// hands the camera it renders with: a shared object posed at the probe, looking down the face's axis.

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
#include <cmath>
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
    bool sawPending = false;
    std::vector<float> face;
    GpuStatus submitted = GpuStatus::Pending;
    CHECK(waitFor(renderer, [&] {
        if (submitted == GpuStatus::Pending) {
            submitted = probes::captureFace(renderer, scene, volume, "probe", 0, 0, 0.1, 20,
                                            [&](GpuStatus status, std::vector<float> rgb) {
                                                CHECK(status == GpuStatus::Ok);
                                                face = std::move(rgb);
                                                faceDone = true;
                                            });
            sawPending = sawPending || submitted == GpuStatus::Pending;
        }
        return faceDone || (submitted != GpuStatus::Pending && submitted != GpuStatus::Ok);
    }));
    CHECK(submitted == GpuStatus::Ok);
    CHECK(sawPending);  // the capture really raced the bake
    CHECK(face.size() == size_t(volume.cubemapSize()) * volume.cubemapSize() * 3);
    // A frame was actually drawn on the capture renderer: the bake finished instead of the capture
    // being skipped, and the face is the room's white rather than the previous black target.
    CHECK(!renderer.probeCaptureRenderer().environmentPending());
    CHECK(!face.empty() && std::all_of(face.begin(), face.end(), [](float value) { return value > 0.5f; }));
}

// three's Reflector and Water read camera.matrixWorld in onBeforeRender, so a null camera throws inside a
// capture. The callback gets one shared camera owned by the capture renderer, re-posed for each face.
void probeCaptureCallbackCamera() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    const Vector3 at{1, 2, 3};
    const Vector3 axes[] = {{1, 0, 0}, {-1, 0, 0}, {0, 1, 0}, {0, -1, 0}, {0, 0, 1}, {0, 0, -1}};
    // A mesh on each axis, so every face sees one and runs the callback.
    Scene scene;
    std::vector<std::unique_ptr<Mesh>> meshes;
    std::vector<std::shared_ptr<const Object3D>> kept(6);
    std::vector<Vector3> seenAt(6), seenLooking(6);
    int face = 0;
    const auto callback = std::make_shared<const std::function<bool(const RenderCallbackArgs&, std::string&)>>(
        [&](const RenderCallbackArgs& args, std::string&) {
            kept[face] = args.camera ? args.camera->weak_from_this().lock() : nullptr;
            if (!kept[face]) return true;
            const Matrix4& world = kept[face]->matrixWorld;
            seenAt[face] = Vector3(world.elements[12], world.elements[13], world.elements[14]);
            const_cast<Object3D&>(*kept[face]).getWorldDirection(seenLooking[face]);
            return true;
        });
    for (const Vector3& axis : axes) {
        meshes.push_back(std::make_unique<Mesh>(makeBoxGeometry(1, 1, 1), std::make_shared<Material>(MaterialType::Standard)));
        meshes.back()->position.set(at.x + axis.x * 3, at.y + axis.y * 3, at.z + axis.z * 3);
        meshes.back()->onBeforeRender = callback;
        scene.add(*meshes.back());
    }
    scene.updateMatrixWorld(true);
    for (face = 0; face < 6; ++face) {
        bool done = false;
        CHECK(probes::captureFace(renderer, scene, at, 16, uint32_t(face), 0.1, 20, [&](GpuStatus status, std::vector<float>) {
            CHECK(status == GpuStatus::Ok);
            done = true;
        }, false) == GpuStatus::Ok);
        CHECK(waitFor(renderer, [&] { return done; }));
    }
    for (face = 0; face < 6; ++face) {
        CHECK(kept[face] != nullptr);  // a shared camera, never null
        CHECK(kept[face] == kept[0]);  // one camera for the capture, re-posed per face
        CHECK(std::abs(seenAt[face].x - at.x) < 1e-6 && std::abs(seenAt[face].y - at.y) < 1e-6 && std::abs(seenAt[face].z - at.z) < 1e-6);
        CHECK(seenLooking[face].dot(axes[face]) > 0.999);  // matrixWorld is the face view
    }
}

}  // namespace

TN_TEST_MAIN({"shared_retired_sweep", sharedRetiredSweep},
             {"probe_capture_environment", probeCaptureDuringEnvironmentBake},
             {"probe_capture_callback_camera", probeCaptureCallbackCamera})
