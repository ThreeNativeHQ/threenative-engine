#include "check.h"
#include "engine/renderer/device_state.h"
#include "mystral/webgpu/context.h"

#include <chrono>
#include <memory>
#include <string>
#include <thread>
#include <vector>

using namespace tn::engine;

namespace {

// The host side of the lifecycle: every acquire is a fresh context whose losses reach the engine.
struct Host {
    std::vector<std::unique_ptr<mystral::webgpu::Context>> contexts;
    DeviceLifecycle* lifecycle = nullptr;
    int acquireBudget = 1 << 30;

    bool acquire(DeviceHandles& out) {
        if (acquireBudget-- <= 0) return false;
        auto context = std::make_unique<mystral::webgpu::Context>();
        context->setDeviceLostHandler(
            [](void* user, uint32_t, const char*) { static_cast<Host*>(user)->lifecycle->notifyLost(); }, this);
        if (!context->initializeHeadless()) return false;
        out = {context->getInstance(), context->getDevice(), context->getQueue()};
        contexts.push_back(std::move(context));
        return true;
    }
};

// What the renderer keeps on the CPU so a new device can be rebuilt: a 4x4 RGBA texture.
struct Scene {
    std::vector<uint8_t> pixels = std::vector<uint8_t>(4 * 4 * 4);
    Handle texture;
    Scene() {
        for (size_t i = 0; i < pixels.size(); ++i) pixels[i] = static_cast<uint8_t>(i * 13 + 1);
    }
    bool rebuild(GpuResources& gpu) {
        texture = gpu.createTexture(4, 4, WGPUTextureFormat_RGBA8Unorm,
                                    WGPUTextureUsage_CopyDst | WGPUTextureUsage_CopySrc);
        return gpu.writeTexture(texture, pixels.data(), pixels.size()) == GpuStatus::Ok;
    }
};

struct Fixture {
    EventQueue events;
    Host host;
    Scene scene;
    std::vector<std::string> transitions;
    DeviceLifecycle lifecycle{[this](DeviceHandles& out) { return host.acquire(out); },
                              [this](GpuResources& gpu) { return scene.rebuild(gpu); }, events};
    Fixture() {
        host.lifecycle = &lifecycle;
        lifecycle.onTransition([this](DeviceState from, DeviceState to) {
            transitions.push_back(std::string(deviceStateName(from)) + ">" + deviceStateName(to));
        });
    }

    // Destroys the running device the way a driver reset would, and waits for the loss to arrive.
    bool loseDevice() {
        wgpuDeviceDestroy(host.contexts.back()->getDevice());
        for (int i = 0; i < 2000 && lifecycle.state() == DeviceState::Running; ++i) {
            lifecycle.resources()->poll();
            events.drain();
            lifecycle.update();
            if (lifecycle.state() == DeviceState::Running && lifecycle.generation() == 1) {
                std::this_thread::sleep_for(std::chrono::milliseconds(1));
            } else {
                break;
            }
        }
        return lifecycle.generation() > 1 || lifecycle.state() != DeviceState::Running;
    }

    std::vector<uint8_t> readScene() {
        std::vector<uint8_t> out;
        bool done = false;
        GpuResources* gpu = lifecycle.resources();
        if (!gpu || gpu->readTexture(scene.texture, [&](GpuStatus s, std::vector<uint8_t> bytes) {
                if (s == GpuStatus::Ok) out = std::move(bytes);
                done = true;
            }) != GpuStatus::Ok) {
            return out;
        }
        for (int i = 0; i < 2000 && !done; ++i) {
            gpu->poll();
            events.drain();
            if (!done) std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
        return out;
    }
};

void recover() {
    Fixture f;
    CHECK(f.lifecycle.start());
    CHECK(f.lifecycle.state() == DeviceState::Running);
    CHECK(f.readScene() == f.scene.pixels);

    CHECK(f.loseDevice());
    CHECK(f.lifecycle.state() == DeviceState::Running);
    CHECK(f.lifecycle.generation() == 2);
    const std::vector<std::string> expected = {"lost>recovering", "recovering>running", "running>lost",
                                               "lost>recovering", "recovering>running"};
    CHECK(f.transitions == expected);
    // The next frame reads the texture rebuilt from the CPU copy on the new device.
    CHECK(f.readScene() == f.scene.pixels);
}

void staleHandle() {
    Fixture f;
    CHECK(f.lifecycle.start());
    const Handle before = f.scene.texture;
    CHECK(f.loseDevice());
    GpuResources* gpu = f.lifecycle.resources();
    CHECK(gpu != nullptr);
    if (!gpu) return;
    CHECK(gpu->status(before, GpuResources::kTexture) == GpuStatus::StaleGeneration);
    CHECK(gpu->texture(before) == nullptr);
    CHECK(gpu->readTexture(before, [](GpuStatus, std::vector<uint8_t>) {}) == GpuStatus::StaleGeneration);
    CHECK(gpu->status(f.scene.texture, GpuResources::kTexture) == GpuStatus::Ok);
}

void noAdapter() {
    Fixture f;
    f.host.acquireBudget = 1;  // the first device only; recovery finds none
    CHECK(f.lifecycle.start());
    CHECK(f.loseDevice());
    CHECK(f.lifecycle.state() == DeviceState::Failed);
    CHECK(f.lifecycle.resources() == nullptr);
    CHECK(f.transitions.back() == "lost>failed");
}

}  // namespace

TN_TEST_MAIN({"recover", recover}, {"stale_handle", staleHandle}, {"no_adapter", noAdapter})
