// The corpus renders offscreen; a running Perry game publishes into the shared player.
#include "engine/abi/abi_internal.h"
#include "engine/renderer/render_database.h"
#include "mystral/webgpu/context.h"
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cmath>
#include <unistd.h>
extern "C" int32_t js_tnp_player_running();
extern "C" int64_t js_tnp_player_publish(int64_t, int64_t, double, double, int32_t, int64_t);
extern "C" int stbi_write_png(const char*, int, int, int, const void*, int);

extern "C" int64_t js_tnp_render(int64_t sceneHandle, int64_t cameraHandle, int32_t width,
                                int32_t height, double tone, double exposure, int32_t srgb,
                                int64_t clearPointer) {
    using namespace tn::engine;
    const auto fail = [](const char* message) { return int64_t(reinterpret_cast<uintptr_t>(message)); };
    try {
        if (!sceneHandle || !cameraHandle || !clearPointer) return fail("TN_PERRY_RENDER_ARGUMENT");
        const auto* clear = reinterpret_cast<const double*>(clearPointer);
        for (int i = 0; i < 4; ++i)
            if (!std::isfinite(clear[i])) return fail("TN_PERRY_RENDER_ARGUMENT");
        auto* scene = tn::abi::objectOf(*reinterpret_cast<tn_handle_t*>(sceneHandle));
        auto* camera = tn::abi::objectOf(*reinterpret_cast<tn_handle_t*>(cameraHandle));
        if (!scene || scene->cls != "Scene" || !camera ||
            (camera->cls != "OrthographicCamera" && camera->cls != "PerspectiveCamera") ||
            width <= 0 || height <= 0 || width > 16384 || height > 16384)
            return fail("TN_PERRY_RENDER_ARGUMENT");
        std::string refusal;
        auto output = outputStateOf(tone, exposure, srgb ? "srgb" : "srgb-linear", refusal);
        if (!output) return fail("TN_PERRY_RENDER_OUTPUT");
        if (js_tnp_player_running())
            return js_tnp_player_publish(sceneHandle, cameraHandle, tone, exposure, srgb, clearPointer);
        std::fflush(stdout);
        const int saved = dup(STDOUT_FILENO);
        if (saved < 0) return fail("TN_PERRY_RENDER_STDOUT");
        if (dup2(STDERR_FILENO, STDOUT_FILENO) < 0) { close(saved); return fail("TN_PERRY_RENDER_STDOUT"); }
        mystral::webgpu::Context context;
        const bool initialized = context.initializeHeadless();
        std::fflush(stdout);
        const int restored = dup2(saved, STDOUT_FILENO);
        close(saved);
        if (restored < 0) return fail("TN_PERRY_RENDER_STDOUT");
        if (!initialized) return fail("TN_PERRY_RENDER_NO_DEVICE");
        WGPUAdapterInfo info = {};
        wgpuAdapterGetInfo(context.getAdapter(), &info);
        const bool realBackend = info.backendType != WGPUBackendType_Null && info.backendType != WGPUBackendType_Undefined;
        wgpuAdapterInfoFreeMembers(info);
        if (!realBackend) return fail("TN_PERRY_RENDER_NO_DRAW_BACKEND");
        EventQueue events;
        Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
        renderer.setSize(width, height);
        renderer.setOutput(*output);
        if (const auto& graph = tn::abi::perryPostGraph()) renderer.setPostGraph(graph);
        RenderDatabase database;
        database.render(renderer, *static_cast<Scene*>(scene->ptr.get()),
                        *static_cast<Camera*>(camera->ptr.get()), {clear[0], clear[1], clear[2], clear[3]});
        if (!database.diagnostics().empty()) return fail("TN_PERRY_RENDER_DIAGNOSTIC");
        const char* file = std::getenv("TN_TSL_FRAME");
        if (!file || !*file) return 0;
        bool done = false;
        std::vector<uint8_t> pixels;
        renderer.readPixels([&](GpuStatus status, std::vector<uint8_t> data) {
            if (status == GpuStatus::Ok) pixels = std::move(data);
            done = true;
        });
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
        while (!done && std::chrono::steady_clock::now() < deadline) {
            renderer.poll(); events.drain();
        }
        if (pixels.size() != size_t(width) * size_t(height) * 4) return fail("TN_PERRY_RENDER_READBACK");
        if (!stbi_write_png(file, width, height, 4, pixels.data(), width * 4)) return fail("TN_PERRY_RENDER_PNG");
        return 0;
    } catch (...) { return fail("TN_PERRY_RENDER_EXCEPTION"); }
}
