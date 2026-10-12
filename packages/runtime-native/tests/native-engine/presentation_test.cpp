#include "check.h"
#include "engine/renderer/presentation.h"
#include "mystral/webgpu/context.h"

#include <SDL3/SDL.h>
#include <webgpu/webgpu.h>
#include "mystral/webgpu_compat.h"

#include <chrono>
#include <cstdio>
#include <string>
#include <thread>

namespace {

// A windowed driver: 300 frames, a resize every 60, each frame inside a validation scope.
void resizes() {
    // The context's Linux surface path is X11; a session's Wayland would otherwise win.
    SDL_SetHint(SDL_HINT_VIDEO_DRIVER, "x11");
    CHECK(SDL_Init(SDL_INIT_VIDEO));
    // The flags the shipped host uses on Linux; without SDL_WINDOW_VULKAN the NVIDIA driver aborts in xcb.
    SDL_Window* window = SDL_CreateWindow("tn presentation", 640, 360, SDL_WINDOW_RESIZABLE | SDL_WINDOW_VULKAN);
    CHECK(window != nullptr);
    if (!window) return;
    SDL_PropertiesID props = SDL_GetWindowProperties(window);
    void* display = SDL_GetPointerProperty(props, SDL_PROP_WINDOW_X11_DISPLAY_POINTER, nullptr);
    const auto xwindow = static_cast<unsigned long>(SDL_GetNumberProperty(props, SDL_PROP_WINDOW_X11_WINDOW_NUMBER, 0));
    CHECK(display != nullptr && xwindow != 0);
    if (!display || !xwindow) return;

    // The device and swapchain go before the window and the X connection they present into.
    {
    mystral::webgpu::Context context;
    CHECK(context.initialize());
    CHECK(context.createSurfaceWithDisplay(display, reinterpret_cast<void*>(xwindow), mystral::webgpu::Context::PLATFORM_XLIB));
    CHECK(context.configureSurface(640, 360, true));  // FIFO, as the shipped host presents
    WGPUDevice device = context.getDevice();
    tn::engine::Presenter presenter(context);

    const uint32_t sizes[][2] = {{800, 450}, {320, 240}, {1024, 576}, {500, 700}, {640, 360}};
    int errors = 0;
    std::string firstError;
    for (int frame = 0; frame < 300; ++frame) {
        if (frame % 60 == 59) {
            const auto* size = sizes[frame / 60];
            SDL_SetWindowSize(window, size[0], size[1]);
            SDL_SyncWindow(window);
            CHECK(presenter.resize(size[0], size[1]));
        }
        SDL_Event event;
        while (SDL_PollEvent(&event)) {
        }
        wgpuDevicePushErrorScope(device, WGPUErrorFilter_Validation);
        tn::engine::Presenter::Frame target;
        CHECK(presenter.begin(target));
        WGPUCommandEncoderDescriptor encoderDesc = {};
        WGPUCommandEncoder encoder = wgpuDeviceCreateCommandEncoder(device, &encoderDesc);
        WGPURenderPassColorAttachment color = {};
        color.view = target.color;
        color.loadOp = WGPULoadOp_Clear;
        color.storeOp = WGPUStoreOp_Store;
        color.clearValue = {frame / 300.0, 0.2, 0.4, 1};
#if defined(MYSTRAL_WEBGPU_DAWN)
        color.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
#endif
        WGPURenderPassDepthStencilAttachment depth = {};
        depth.view = target.depth;
        depth.depthLoadOp = WGPULoadOp_Clear;
        depth.depthStoreOp = WGPUStoreOp_Store;
        depth.depthClearValue = 1;
        WGPURenderPassDescriptor pass = {};
        pass.colorAttachmentCount = 1;
        pass.colorAttachments = &color;
        pass.depthStencilAttachment = &depth;
        WGPURenderPassEncoder encoderPass = wgpuCommandEncoderBeginRenderPass(encoder, &pass);
        wgpuRenderPassEncoderEnd(encoderPass);
        wgpuRenderPassEncoderRelease(encoderPass);
        WGPUCommandBufferDescriptor commandDesc = {};
        WGPUCommandBuffer commands = wgpuCommandEncoderFinish(encoder, &commandDesc);
        wgpuQueueSubmit(context.getQueue(), 1, &commands);
        wgpuCommandBufferRelease(commands);
        wgpuCommandEncoderRelease(encoder);
        presenter.present();

        struct Result {
            bool done = false;
            std::string error;
        } result;
        WGPUPopErrorScopeCallbackInfo info = {};
        info.mode = WGPUCallbackMode_AllowProcessEvents;
        info.userdata1 = &result;
        info.callback = [](WGPUPopErrorScopeStatus, WGPUErrorType type, WGPUStringView message, void* user, void*) {
            auto* r = static_cast<Result*>(user);
            if (type != WGPUErrorType_NoError) r->error = message.data ? std::string(message.data, message.length) : "error";
            r->done = true;
        };
        wgpuDevicePopErrorScope(device, info);
        for (int i = 0; i < 1000 && !result.done; ++i) {
#if defined(MYSTRAL_WEBGPU_DAWN)
            wgpuInstanceProcessEvents(context.getInstance());
#endif
            if (!result.done) std::this_thread::sleep_for(std::chrono::microseconds(200));
        }
        if (!result.error.empty() && errors++ == 0) firstError = result.error;
    }
    if (errors) std::fprintf(stderr, "%d frames with validation errors; first: %s\n", errors, firstError.c_str());
    CHECK(errors == 0);
    CHECK(context.getDevice() == device);       // a resize never recreated the device
    CHECK(presenter.depthRebuilds() == 1 + 5);  // the first target, then one per resize
    CHECK(presenter.width() == 640 && presenter.height() == 360);
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
}

}  // namespace

TN_TEST_MAIN({"resizes", resizes})
