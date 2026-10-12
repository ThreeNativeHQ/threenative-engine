#include "check.h"
#include "engine/player/world_walk.h"
#include "engine/inspect/endpoint.h"
#include "engine/renderer/render_database.h"
#include "mystral/webgpu/context.h"

#include <filesystem>
#include <fstream>
#include <iterator>
#include <chrono>
#include <thread>

using namespace tn::engine;

#if defined(TN_WORLD_CPU_NULL)
namespace {
bool surfaceMock = false, acquisitionFails = false;
int textureRefs = 0, viewRefs = 0, acquisitions = 0;
WGPUDevice surfaceDevice = nullptr;
int surfaceToken;
} // namespace
// Replace only the window/swapchain seam; the CPU Null device and its texture/view ownership are real.
extern "C" {
void __real_wgpuSurfaceUnconfigure(WGPUSurface);
void __wrap_wgpuSurfaceUnconfigure(WGPUSurface s) {
    if (!surfaceMock) __real_wgpuSurfaceUnconfigure(s);
}
WGPUSurface __real_wgpuInstanceCreateSurface(WGPUInstance, const WGPUSurfaceDescriptor*);
WGPUSurface __wrap_wgpuInstanceCreateSurface(WGPUInstance i, const WGPUSurfaceDescriptor* d) {
    return surfaceMock ? reinterpret_cast<WGPUSurface>(&surfaceToken) : __real_wgpuInstanceCreateSurface(i, d);
}
WGPUFuture __real_wgpuInstanceRequestAdapter(WGPUInstance, const WGPURequestAdapterOptions*,
                                             WGPURequestAdapterCallbackInfo);
WGPUFuture __wrap_wgpuInstanceRequestAdapter(WGPUInstance i, const WGPURequestAdapterOptions* o,
                                             WGPURequestAdapterCallbackInfo c) {
    if (!surfaceMock)
        return __real_wgpuInstanceRequestAdapter(i, o, c);
    auto options = *o;
    options.compatibleSurface = nullptr;
    options.backendType = WGPUBackendType_Null;
    return __real_wgpuInstanceRequestAdapter(i, &options, c);
}
void __real_wgpuSurfaceRelease(WGPUSurface);
void __wrap_wgpuSurfaceRelease(WGPUSurface s) {
    if (surfaceMock) CHECK(textureRefs == 0 && viewRefs == 0);
    if (!surfaceMock)
        __real_wgpuSurfaceRelease(s);
}
WGPUStatus __real_wgpuSurfacePresent(WGPUSurface);
WGPUStatus __wrap_wgpuSurfacePresent(WGPUSurface s) {
    if (surfaceMock) CHECK(textureRefs == 1 && viewRefs == 1);
    return surfaceMock ? WGPUStatus_Success : __real_wgpuSurfacePresent(s);
}
void __real_wgpuSurfaceGetCurrentTexture(WGPUSurface, WGPUSurfaceTexture*);
void __wrap_wgpuSurfaceGetCurrentTexture(WGPUSurface s, WGPUSurfaceTexture* out) {
    if (!surfaceMock)
        return __real_wgpuSurfaceGetCurrentTexture(s, out);
    WGPUTextureDescriptor d{};
    d.dimension = WGPUTextureDimension_2D;
    d.size = {1, 1, 1};
    d.format = WGPUTextureFormat_RGBA8Unorm;
    d.mipLevelCount = d.sampleCount = 1;
    d.usage = WGPUTextureUsage_RenderAttachment;
    out->texture = wgpuDeviceCreateTexture(surfaceDevice, &d);
    out->status = acquisitionFails ? WGPUSurfaceGetCurrentTextureStatus_Timeout
                                   : WGPUSurfaceGetCurrentTextureStatus_SuccessOptimal;
    ++textureRefs;
    ++acquisitions;
}
WGPUTextureView __real_wgpuTextureCreateView(WGPUTexture, const WGPUTextureViewDescriptor*);
WGPUTextureView __wrap_wgpuTextureCreateView(WGPUTexture t, const WGPUTextureViewDescriptor* d) {
    const auto view = __real_wgpuTextureCreateView(t, d);
    if (surfaceMock && view)
        ++viewRefs;
    return view;
}
void __real_wgpuTextureRelease(WGPUTexture);
void __wrap_wgpuTextureRelease(WGPUTexture t) {
    if (surfaceMock)
        --textureRefs;
    __real_wgpuTextureRelease(t);
}
void __real_wgpuTextureViewRelease(WGPUTextureView);
void __wrap_wgpuTextureViewRelease(WGPUTextureView v) {
    if (surfaceMock)
        --viewRefs;
    __real_wgpuTextureViewRelease(v);
}
}
#endif

namespace {
std::vector<uint8_t> read(const std::filesystem::path& path) {
    std::ifstream in(path, std::ios::binary);
    CHECK(bool(in));
    return {std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>()};
}
void world_walk_fixture() {
    CHECK(packageTextureFormat(18) == WGPUTextureFormat_RGBA8Unorm);
    CHECK(packageTextureFormat(22) == WGPUTextureFormat_RGBA8Unorm);
    CHECK(packageTextureFormat(19) == WGPUTextureFormat_RGBA8UnormSrgb);
    CHECK(packageTextureFormat(23) == WGPUTextureFormat_RGBA8UnormSrgb);
    CHECK(packageTextureFormat(0) == WGPUTextureFormat_Undefined);
    CHECK(packageTextureFormat(21) == WGPUTextureFormat_Undefined);
    const std::filesystem::path root = TN_WORLD_WALK_FIXTURE;
    uint64_t total = 0;
    for (const auto& file : std::filesystem::directory_iterator(root))
        if (file.is_regular_file()) total += file.file_size();
    CHECK(total < 1024 * 1024);
    player::WorldWalk walk("world-walk", root); // the same manifest validation as the player
    CHECK(walk.snapshot().find("phase")->string() == "ready");
    CHECK(walk.game().renderEachTick);
    for (int cell = 0; cell < 4; ++cell) {
        const auto bytes = read(root / ("cell-" + std::to_string(cell) + ".tnpk"));
        assets::Package package;
        assets::PackageError failure;
        CHECK(assets::parsePackage(bytes, package, failure));
        CHECK(assets::verifyPackage(package, assets::targetDecoders(), failure));
        CHECK(package.entries.size() == 2);
        if (package.entries.size() != 2) continue;
        CHECK(package.entries[0].name == "positions" && package.entries[0].kind == 1 && package.entries[0].size == 72);
        CHECK(package.entries[1].name == "albedo" && package.entries[1].kind == 2 && package.entries[1].size == 16);
        CHECK(package.entries[0].uploadSize == 72 && package.entries[1].uploadSize == 4);
        const auto texture = package.data(package.entries[1]);
        CHECK(texture[0] == 1 && texture[4] == 1 && texture[8] == 22); // legacy Dawn wire code
        CHECK(packageTextureFormat(texture[8]) == WGPUTextureFormat_RGBA8Unorm);
    }
    const auto corrupt = read(root / "cell-1-corrupt.tnpk");
    assets::Package package;
    assets::PackageError failure;
    CHECK(assets::parsePackage(corrupt, package, failure));
    CHECK(!assets::verifyPackage(package, assets::targetDecoders(), failure));
    CHECK(failure.code == "TN_PACKAGE_HASH");
    std::printf("world walk fixture: %llu bytes; four TNPK cells verified, corrupt cell refused as TN_PACKAGE_HASH\n",
                static_cast<unsigned long long>(total));
}

#if defined(TN_WORLD_CPU_NULL)
void surface_lifetime_cpu() {
    surfaceMock = true;
    {
        mystral::webgpu::Context context;
        CHECK(context.initialize());
        CHECK(context.createSurfaceWithDisplay(&surfaceToken, &surfaceToken, mystral::webgpu::Context::PLATFORM_XLIB));
        surfaceDevice = context.getDevice();
        inspect::Host host;
        host.resource = [&context](const std::string&) {
            return json::Value::makeObject({
                {"deviceCreations", json::Value::makeNumber(context.deviceCreations())},
                {"surfaceCreations", json::Value::makeNumber(context.surfaceCreations())}});
        };
        inspect::Endpoint endpoint(host);
        const auto sampled = [&](unsigned surfaces) {
            json::Value out;
            json::Error error;
            CHECK(json::parse(endpoint.handle(R"({"id":"1","method":"sample","argument":{"resources":["surface"]}})"), out, error));
            const auto* surface = out.find("result")->find("resources")->find("surface");
            CHECK(surface->find("deviceCreations")->number() == 1);
            CHECK(surface->find("surfaceCreations")->number() == surfaces);
        };
        sampled(1);
        for (int frame = 0; frame < 300; ++frame) {
            const auto view = context.getCurrentTextureView();
            CHECK(view != nullptr && textureRefs == 1 && viewRefs == 1);
            CHECK(context.getCurrentTextureView() == view && acquisitions == frame + 1);
            context.present();
            CHECK(textureRefs == 0 && viewRefs == 0);
        }
        acquisitionFails = true;
        CHECK(context.getCurrentTextureView() == nullptr && textureRefs == 0 && viewRefs == 0);
        acquisitionFails = false;
        context.releaseSurface();
        CHECK(context.getSurface() == nullptr && context.getCurrentTextureView() == nullptr);
        CHECK(context.getDevice() == surfaceDevice);
        sampled(1);
        CHECK(!context.rebuildSurface(&surfaceToken, -1));
        sampled(1);
        CHECK(context.rebuildSurface(&surfaceToken, mystral::webgpu::Context::PLATFORM_XLIB));
        CHECK(context.getDevice() == surfaceDevice);
        sampled(2);
        context.releaseSurface();
        CHECK(context.rebuildSurface(&surfaceToken, mystral::webgpu::Context::PLATFORM_XLIB));
        CHECK(context.getDevice() == surfaceDevice);
        sampled(3);
        CHECK(context.getCurrentTextureView() != nullptr); // destruction must release an unpresented view
    }
    CHECK(textureRefs == 0 && viewRefs == 0);
    surfaceMock = false;
    std::printf("300 CPU surface frames: %d acquired texture references, %d view references retained after teardown\n",
                textureRefs, viewRefs);
}

// Dawn's Null backend runs the real world/player/renderer ownership paths on the CPU.
// It does not qualify pixels, physical GPU memory or GPU frame timing.
void world_walk_cycles_cpu() {
    WGPUInstance instance = wgpuCreateInstance(nullptr);
    WGPUAdapter adapter = nullptr;
    WGPURequestAdapterOptions options{};
    options.backendType = WGPUBackendType_Null;
    WGPURequestAdapterCallbackInfo adapterInfo{};
    adapterInfo.mode = WGPUCallbackMode_AllowProcessEvents;
    adapterInfo.userdata1 = &adapter;
    adapterInfo.callback = [](WGPURequestAdapterStatus, WGPUAdapter result, WGPUStringView, void* out, void*) {
        *static_cast<WGPUAdapter*>(out) = result;
    };
    wgpuInstanceRequestAdapter(instance, &options, adapterInfo);
    wgpuInstanceProcessEvents(instance);
    CHECK(adapter != nullptr);
    if (!adapter) {
        wgpuInstanceRelease(instance);
        return;
    }
    WGPUDevice device = nullptr;
    WGPURequestDeviceCallbackInfo deviceInfo{};
    deviceInfo.mode = WGPUCallbackMode_AllowProcessEvents;
    deviceInfo.userdata1 = &device;
    deviceInfo.callback = [](WGPURequestDeviceStatus, WGPUDevice result, WGPUStringView, void* out, void*) {
        *static_cast<WGPUDevice*>(out) = result;
    };
    const WGPUFeatureName timestamp = WGPUFeatureName_TimestampQuery;
    WGPUDeviceDescriptor deviceDesc{};
    deviceDesc.requiredFeatureCount = wgpuAdapterHasFeature(adapter, timestamp) ? 1 : 0;
    deviceDesc.requiredFeatures = &timestamp;
    wgpuAdapterRequestDevice(adapter, &deviceDesc, deviceInfo);
    wgpuInstanceProcessEvents(instance);
    CHECK(device != nullptr);
    if (!device) {
        wgpuAdapterRelease(adapter);
        wgpuInstanceRelease(instance);
        return;
    }
    WGPUQueue queue = wgpuDeviceGetQueue(device);
    {
        EventQueue events;
        Renderer renderer(instance, device, queue, events);
        renderer.setSize(32, 32);
        WGPUTextureDescriptor targetDesc{};
        targetDesc.dimension = WGPUTextureDimension_2D;
        targetDesc.size = {32, 32, 1};
        targetDesc.format = WGPUTextureFormat_BGRA8Unorm;
        targetDesc.usage = WGPUTextureUsage_RenderAttachment;
        targetDesc.mipLevelCount = targetDesc.sampleCount = 1;
        WGPUTexture target = wgpuDeviceCreateTexture(device, &targetDesc);
        WGPUTextureView targetView = wgpuTextureCreateView(target, nullptr);
        RenderDatabase database;
        player::WorldWalk walk("world-cycles", TN_WORLD_WALK_FIXTURE);
        auto game = walk.game();
        game.initialize(renderer);
        unsigned sampled = 0;
        for (unsigned tick = 0; tick < 10000; ++tick) {
            game.update(1.0 / 60);
            database.render(renderer, *game.scene, *game.camera);
            CHECK(renderer.blitTo(queue, targetView, targetDesc.format));
            renderer.poll();
            events.drain();
            game.frameComplete(renderer, database.diagnostics());
            const auto snapshot = walk.snapshot();
            const auto cycles = unsigned(snapshot.find("cycles")->number());
            if (cycles != sampled) {
                sampled = cycles;
                std::printf("cycle %u cpuHeapBytes %.0f\n", cycles,
                            snapshot.find("samples")->items().back().find("cpuHeapBytes")->number());
            }
            if (snapshot.find("phase")->string() == "done" || snapshot.find("phase")->string() == "failed")
                break;
            std::this_thread::sleep_for(std::chrono::microseconds(100));
        }
        const auto snapshot = walk.snapshot();
        CHECK(snapshot.find("cycles")->number() == 10);
        CHECK(snapshot.find("diagnosticCount")->number() == 0);
        CHECK(snapshot.find("rendererDiagnosticCount")->number() == 0);
        CHECK(snapshot.find("completedLoads")->number() >= 60);
        CHECK(snapshot.find("phase")->string() == "done");
        CHECK(snapshot.find("pendingCompletions")->number() == 0);
        CHECK(snapshot.find("inFlight")->number() == 0);
        for (const auto& sample : snapshot.find("samples")->items())
            CHECK(sample.find("cpuHeapBytes")->number() > 0);
        CHECK(snapshot.find("cpuRangeBytes")->number() <= 524288);
        const auto slope = snapshot.find("cpuSlopeBytesPerCycle");
        CHECK(slope->isNumber() && slope->number() >= -65536 && slope->number() <= 65536);
        CHECK(snapshot.find("geometrySlopePerCycle")->number() == 0);
        CHECK(snapshot.find("handleSlopePerCycle")->number() == 0);
        CHECK(snapshot.find("gpuBufferSlopeBytesPerCycle")->number() == 0);
        CHECK(snapshot.find("gpuTextureSlopeBytesPerCycle")->number() == 0);
        const auto budget = snapshot.find("TN_FRAME_BUDGET");
        CHECK(budget->find("maxAdmissionMs")->number() <= 4);
        CHECK(budget->find("maxAdmissionBytes")->number() <= 1024);
        CHECK(budget->find("violations")->number() == 0);
        std::printf("CPU slope %.2f bytes/cycle, range %.0f bytes; max admission %.3f ms\n", slope->number(),
                    snapshot.find("cpuRangeBytes")->number(),
                    snapshot.find("TN_FRAME_BUDGET")->find("maxAdmissionMs")->number());
        std::fflush(stdout); // retain cycle observations if the exit-time leak scan fails
        game.shutdown();
        wgpuTextureViewRelease(targetView);
        wgpuTextureRelease(target);
    }
    wgpuQueueRelease(queue);
    wgpuDeviceRelease(device);
    wgpuAdapterRelease(adapter);
    wgpuInstanceRelease(instance);
}
#endif
} // namespace

#if defined(TN_WORLD_CPU_NULL)
TN_TEST_MAIN({"world_walk_fixture", world_walk_fixture}, {"world_walk_cycles_cpu", world_walk_cycles_cpu},
             {"surface_lifetime_cpu", surface_lifetime_cpu})
#else
TN_TEST_MAIN({"world_walk_fixture", world_walk_fixture})
#endif
