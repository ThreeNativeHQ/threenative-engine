// PRD-613 phase 1: the render thread's frame order. `renderDeferred` plans a frame on the game thread
// and `encodePending` records it on another, so what the game writes after the plan (a transform, a
// material colour, attribute bytes, a TSL uniform) must reach the next frame and never the one in
// flight, and a second frame may not be planned while one is pending.

#include "check.h"
#include "engine/renderer/reflector.h"
#include "engine/renderer/render_database.h"
#include "engine/shader/graph/graph.h"
#include "engine/scene/geometries.h"
#include "mystral/webgpu/context.h"

#include <atomic>
#include <chrono>
#include <functional>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

using namespace tn::engine;

namespace {

using Pixels = std::vector<uint8_t>;

Pixels read(Renderer& r, EventQueue& events) {
    Pixels out;
    bool done = false;
    r.readPixels([&](GpuStatus s, Pixels px) {
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

// One frame through the render thread: the plan runs here, the encode on `thread`, held until `afterPost`
// has written the game's data, which is what JavaScript does while the frame is in flight.
Pixels deferredFrame(Renderer& renderer, RenderDatabase& database, GpuThread& thread, EventQueue& events, Object3D& scene,
                     Camera& camera, const std::function<void()>& afterPost) {
    std::vector<std::function<void()>> jobs;
    std::atomic<bool> gate{false};
    thread.post([&gate] {
        while (!gate.load()) std::this_thread::yield();
    });
    database.encodeJobs = &jobs;
    database.render(renderer, scene, camera, {0.05, 0.06, 0.08, 1});
    database.encodeJobs = nullptr;
    CHECK(renderer.framePending());
    CHECK(database.diagnostics().empty());
    for (const auto& job : jobs) thread.post(job);
    afterPost();
    gate = true;
    thread.wait();
    CHECK(!renderer.framePending());
    return read(renderer, events);
}

struct Lit {
    Scene scene;
    PerspectiveCamera camera;
    std::shared_ptr<BufferGeometry> geometry = makeSphereGeometry(1, 24, 12);
    std::shared_ptr<Material> material = std::make_shared<Material>(MaterialType::Standard);
    Mesh mesh{geometry, material};
    DirectionalLight light{Color().setHex(0xffffff), 3};
    Lit() {
        camera.fov = 60;
        camera.aspect = 4.0 / 3;
        camera.near = 0.1;
        camera.far = 100;
        camera.position.set(0, 1.4, 3.2);
        camera.lookAt(0, 0, 0);
        light.position.set(2, 3, 1);
        scene.add(mesh);
        scene.add(light);
        camera.updateProjectionMatrix();
        scene.updateMatrixWorld(true);
    }
    // State k: a different pose, colour and vertex data, so frames of different states differ on screen.
    void setState(int k) {
        mesh.position.x = 0.4 * k - 0.6;
        mesh.rotation.y = 0.7 * k;
        material->color.setRGB(0.2 + 0.2 * k, 0.6 - 0.1 * k, 0.3);
        material->needsUpdate();
        BufferStore& positions = *geometry->attributes.at("position")->store;
        float* p = reinterpret_cast<float*>(positions.data());
        const float scale = k % 2 ? 0.6f : 1.0f;
        if (current != scale) {
            for (uint64_t i = 0; i < positions.count(); ++i) p[i] *= scale / current;
            current = scale;
            positions.needsUpdate();
        }
        scene.updateMatrixWorld(true);
    }
    float current = 1.0f;
};

void order() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(96, 72);
    renderer.setOutput(OutputState{shader::ToneMapping::ACESFilmic, 1, true});
    Lit s;
    RenderDatabase database;
    GpuThread thread;
    constexpr int states = 4;
    Pixels expected[states];
    for (int k = 0; k < 2; ++k) {  // warm-up: records, programs and pipelines settle before frames are compared
        s.setState(0);
        database.render(renderer, s.scene, s.camera, {0.05, 0.06, 0.08, 1});
    }
    for (int k = 0; k < states; ++k) {
        s.setState(k);
        database.render(renderer, s.scene, s.camera, {0.05, 0.06, 0.08, 1});
        expected[k] = read(renderer, events);
        CHECK(expected[k].size() == 96 * 72 * 4);
    }
    for (int k = 1; k < states; ++k) CHECK(expected[k] != expected[k - 1]);  // the states are visibly distinct
    for (int k = 0; k < states; ++k) {
        s.setState(k);
        // Frame k is planned; the game then writes state k + 1 into every live object the frame reads.
        const Pixels frame = deferredFrame(renderer, database, thread, events, s.scene, s.camera, [&] { s.setState(k + 1); });
        CHECK(frame == expected[k]);
        CHECK(frame != expected[(k + 1) % states]);
    }
    // And the writes made while a frame was in flight were not lost: the next frame draws them.
    s.setState(1);
    const Pixels next = deferredFrame(renderer, database, thread, events, s.scene, s.camera, [&] { s.setState(2); });
    CHECK(next == expected[1]);
    database.render(renderer, s.scene, s.camera, {0.05, 0.06, 0.08, 1});
    CHECK(read(renderer, events) == expected[2]);
    // The published stats follow the encode, one frame late: collectFrame publishes them.
    renderer.collectFrame();
    CHECK(renderer.lastFrame().draws > 0);
}

void uniformNode() {
    namespace g = shader::graph;
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(64, 48);
    Lit s;
    auto basic = std::make_shared<Material>(MaterialType::Basic);
    const auto level = g::uniform("level", shader::Type::f32(), {0.1f});
    basic->nodes.colorNode = g::vec4({level, g::float_(0), g::float_(0), g::float_(1)});
    s.mesh.material = basic;
    RenderDatabase database;
    GpuThread thread;
    const auto inlineFrame = [&](float value) {
        g::setUniformValues(level, {value});
        database.render(renderer, s.scene, s.camera, {0.05, 0.06, 0.08, 1});
        return read(renderer, events);
    };
    inlineFrame(0.1f);
    const Pixels dim = inlineFrame(0.1f), bright = inlineFrame(0.9f);
    CHECK(dim != bright);
    g::setUniformValues(level, {0.1f});
    const Pixels frame = deferredFrame(renderer, database, thread, events, s.scene, s.camera,
                                       [&] { g::setUniformValues(level, {0.9f}); });
    CHECK(frame == dim);  // the node's value at the plan, not the value written while the frame was in flight
}

// A mirror: its pass is planned with the main pass and encoded on the thread before it, from the same pending jobs.
struct Mirror {
    Scene scene;
    PerspectiveCamera camera;
    std::shared_ptr<Material> boxMaterial = std::make_shared<Material>(MaterialType::Standard);
    std::shared_ptr<Material> water = std::make_shared<Material>(MaterialType::Standard);
    std::shared_ptr<Mesh> box, tower, waterMesh;
    std::shared_ptr<Reflector> reflector = std::make_shared<Reflector>();
    std::shared_ptr<Object3D> target = std::make_shared<Object3D>();
    std::shared_ptr<DirectionalLight> sun = std::make_shared<DirectionalLight>(Color(1, 1, 1), 2.0);
    Mirror() {
        camera.fov = 50;
        camera.aspect = 4.0 / 3;
        camera.near = 0.5;
        camera.far = 400;
        camera.position.set(0, 6, 14);
        camera.lookAt(0, 0, -10);
        camera.updateProjectionMatrix();
        boxMaterial->color.setRGB(0.8, 0.4, 0.2);
        box = std::make_shared<Mesh>(makeBoxGeometry(), boxMaterial);
        box->position.set(0, 1, 0);
        box->setCastShadow(true);
        box->setReceiveShadow(true);
        scene.add(*box);
        tower = std::make_shared<Mesh>(makeBoxGeometry(1, 1, 1.5), boxMaterial);  // above the main frustum: only the mirror sees it
        tower->position.set(0, 30, -50);
        tower->scale.set(8, 8, 8);
        scene.add(*tower);
        waterMesh = std::make_shared<Mesh>(makePlaneGeometry(400, 400), water);
        waterMesh->rotateX(-3.141592653589793 / 2);
        scene.add(*waterMesh);
        target->rotateX(-3.141592653589793 / 2);
        scene.add(*target);
        reflector->target = target;
        reflector->camera = std::make_shared<PerspectiveCamera>();
        reflector->resolutionScale = 0.5;
        namespace g = shader::graph;
        const auto mirror = g::reflectorTexture(reflector, g::vec2({g::sub(g::float_(1), g::swizzle(g::screenUV(), "x")),
                                                                    g::swizzle(g::screenUV(), "y")}));
        water->nodes.colorNode = g::vec4({g::swizzle(mirror, "xyz"), g::float_(1)});
        water->needsUpdate();
        sun->setCastShadow(true);
        sun->position.set(30, 60, 20);
        scene.add(*sun);
        scene.updateMatrixWorld(true);
    }
    void setState(int k) {
        tower->position.x = 14.0 * k - 7;     // seen only through the mirror pass
        box->position.x = 3.0 * k - 3;        // seen by the main pass, and its shadow
        boxMaterial->color.setRGB(0.8 - 0.3 * k, 0.4, 0.2 + 0.3 * k);
        boxMaterial->needsUpdate();
        scene.updateMatrixWorld(true);
    }
};

void reflectionOrder() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(128, 96);
    renderer.setOutput(OutputState{shader::ToneMapping::ACESFilmic, 1, true});
    Mirror s;
    RenderDatabase database;
    database.shadowMapEnabled = true;
    GpuThread thread;
    for (int k = 0; k < 3; ++k) {
        s.setState(0);
        database.render(renderer, s.scene, s.camera, {0.05, 0.06, 0.08, 1});
    }
    constexpr int states = 3;
    Pixels expected[states];
    for (int k = 0; k < states; ++k) {
        s.setState(k);
        database.render(renderer, s.scene, s.camera, {0.05, 0.06, 0.08, 1});
        expected[k] = read(renderer, events);
    }
    for (int k = 1; k < states; ++k) CHECK(expected[k] != expected[k - 1]);
    for (int k = 0; k < states; ++k) {
        s.setState(k);
        const Pixels frame = deferredFrame(renderer, database, thread, events, s.scene, s.camera, [&] { s.setState(k + 1); });
        CHECK(frame == expected[k]);
        CHECK(database.reflectionDatabase(s.reflector.get()) != nullptr);
    }
}

void baton() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(64, 48);
    Lit s;
    RenderDatabase database;
    const auto throwsBaton = [&](const std::function<void()>& call) {
        try {
            call();
        } catch (const std::logic_error& error) {
            return std::string(error.what()).find("TN_RENDER_THREAD_BATON") != std::string::npos;
        }
        return false;
    };
    // Nothing is pending: an encode has nothing to record.
    CHECK(!renderer.framePending());
    CHECK(throwsBaton([&] { renderer.encodePending(); }));
    // One frame in flight at most: planning again, through the database or the renderer, is refused while one is pending.
    std::vector<std::function<void()>> jobs;
    database.encodeJobs = &jobs;
    database.render(renderer, s.scene, s.camera);
    database.encodeJobs = nullptr;
    CHECK(renderer.framePending() && jobs.size() == 1);
    CHECK(throwsBaton([&] { database.render(renderer, s.scene, s.camera); }));
    CHECK(throwsBaton([&] { renderer.render({}, CameraState{}, LightState{}); }));
    CHECK(throwsBaton([&] { renderer.renderDeferred({}, CameraState{}, LightState{}); }));
    // The refused calls left the pending frame alone: it encodes, and the next frame plans.
    jobs.front()();
    CHECK(!renderer.framePending());
    database.render(renderer, s.scene, s.camera);
    CHECK(!renderer.framePending());
    CHECK(read(renderer, events).size() == 64 * 48 * 4);
}

}  // namespace

TN_TEST_MAIN({"order", order}, {"uniform_node", uniformNode}, {"reflection_order", reflectionOrder}, {"baton", baton})
