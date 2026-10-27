// The native-engine desktop player loop (PRD-529 phase 2, PRD-531 phase 3): an SDL window on the
// display the playtest runner provides, the engine's fixed-step clock, the render database into the
// renderer, the presentation of that frame, and the mailbox the runner talks to. It names no game:
// the C++ demo and a V8 game bundle both arrive as a `player::Game`.
#include "engine/player/run.h"

#include <SDL3/SDL.h>
#if defined(__ANDROID__)
#include <android/native_window.h>
#include <android/log.h>
#endif

#if defined(__linux__) && !defined(__ANDROID__)
#include <dirent.h>
#include <dlfcn.h>
#include <sched.h>
#endif
#if defined(__linux__)
#include <linux/perf_event.h>
#include <sys/syscall.h>
#include <unistd.h>
#endif
#include <chrono>
#include <climits>
#include <cmath>
#include <ctime>
#include <array>
#include <cstring>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <stdexcept>
#include <vector>

#include "engine/animation/mixer.h"
#include "engine/inspect/endpoint.h"
#include "engine/player/mailbox.h"
#include "engine/renderer/presentation.h"
#include "engine/renderer/render_database.h"
#include "engine/scene/projected_cull.h"
#include "engine/world/loop/fixed_step.h"
#include "mystral/webgpu/context.h"
#include "mystral/webgpu/presentation.h"
#include "mystral/webgpu_compat.h"

// The legacy host's SDL-to-DOM input translation (platform/input.cpp), which declares none of these.
namespace mystral::platform {
void processKeyboardEvent(const SDL_KeyboardEvent& event, bool isDown);
void processMouseMotion(const SDL_MouseMotionEvent& event);
void processMouseButton(const SDL_MouseButtonEvent& event, bool isDown);
void processMouseWheel(const SDL_MouseWheelEvent& event);

// input.cpp's touch path scales by the window; the player owns exactly one, and does not link platform/window.cpp.
void getWindowSize(int* width, int* height) {
    int count = 0;
    SDL_Window** windows = SDL_GetWindows(&count);
    *width = *height = 0;
    if (windows != nullptr && count > 0) SDL_GetWindowSize(windows[0], width, height);
    SDL_free(windows);
}
}  // namespace mystral::platform

using namespace tn::engine;

namespace tn::engine::player {

namespace {
// Same numeric ids as core's render spans and GAME_SPANS; the host owns the wall clock.
constexpr const char* kGameSpanNames[] = {
    "compute", "beforeRender", "sceneUpdate", "reconcile", "clustered", "lod", "cull",
    "mainPass", "shadowPass", "reflectionPass", "nestedPass", "projectObject", "sort", "draw",
    "terrainBlock", "terrainSeam", "animationUpdate", "skinnedWrite", "input", "scheduler", "plugins", "sceneCallbacks", "entities", "afterPhysics", "mixer",
    "stride", "blend", "transport", "publish", "playtest", "hostUpdate", "hostFrame", "ui",
    "gc", "view", "loop", "state", "contacts", "transitions", "objectGraph", "physicsStep",
    "physicsRead", "physicsApply", "characterMove", "animationPlay", "inputVector", "graphVisit"};
constexpr size_t kGameSpanCount = std::size(kGameSpanNames);
// The host-owned spans (GAME_SPANS leaves them out); native-engine-game-spans.spec.ts pins these to the names.
constexpr int kHostUpdateSpan = 30;
constexpr int kHostFrameSpan = 31;
constexpr int kGcSpan = 33;
struct GameSpans {
    struct Entry { int id; std::chrono::steady_clock::time_point start; double childMs; };
    std::array<Entry, 64> stack{};
    size_t depth = 0;
    std::array<double, kGameSpanCount> inclusive{}, exclusive{};
    std::array<uint64_t, kGameSpanCount> calls{};
    bool invalid = false;
} gameSpans;
}

// Process-relative like a page's performance.now(); the origin is fixed at static init.
static const auto kWallOrigin = std::chrono::steady_clock::now();
double wallMs() {
    return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - kWallOrigin).count();
}

double gameSpan(int id, int action) {
    if ((id < 0 && action != 0) || (action != 0 && action != 1)) {
        gameSpans.invalid = true;
        return -1;
    }
    if (id == -1) {
        const char* flag = std::getenv("TN_GAME_SPANS");
        return flag && std::strcmp(flag, "1") == 0 ? 1 : 0;
    }
    if (id == -2) return wallMs();
    if (id == -3) return 0;  // diagnostic no-op: measures the runtime-to-engine call, not clock_gettime
    if (id < 0 || size_t(id) >= kGameSpanCount) {
        gameSpans.invalid = true;
        return -1;
    }
    // Mailbox observations between frames are outside gameJsMs's update/pre-render windows.
    if (gameSpans.depth == 0 && id != kHostUpdateSpan && id != kHostFrameSpan) return 0;
    if ((action == 0 && gameSpans.depth == gameSpans.stack.size()) ||
        (action == 1 && (gameSpans.depth == 0 || gameSpans.stack[gameSpans.depth - 1].id != id))) {
        gameSpans.invalid = true;
        return -1;
    }
    const auto now = std::chrono::steady_clock::now();
    if (action == 0) gameSpans.stack[gameSpans.depth++] = {id, now, 0};
    else {
        const auto entry = gameSpans.stack[--gameSpans.depth];
        const double ms = std::chrono::duration<double, std::milli>(now - entry.start).count();
        gameSpans.inclusive[id] += ms;
        gameSpans.exclusive[id] += ms - entry.childMs;
        ++gameSpans.calls[id];
        if (gameSpans.depth) gameSpans.stack[gameSpans.depth - 1].childMs += ms;
    }
    return 0;
}

json::Value gameSpanTiming(double gameMs) {
    if (gameSpans.invalid || gameSpans.depth) throw std::runtime_error("TN_GAME_SPANS_INVALID");
    std::vector<std::pair<std::string, json::Value>> spans;
    double measured = 0;
    for (size_t id = 0; id < kGameSpanCount; ++id) {
        measured += gameSpans.exclusive[id];
        spans.emplace_back(kGameSpanNames[id], json::Value::makeObject({
            {"ms", json::Value::makeNumber(gameSpans.inclusive[id])},
            {"selfMs", json::Value::makeNumber(gameSpans.exclusive[id])},
            {"calls", json::Value::makeNumber(gameSpans.calls[id])}}));
    }
    gameSpans = {};
    return json::Value::makeObject({{"gameJsMs", json::Value::makeNumber(gameMs)},
        {"residualMs", json::Value::makeNumber(gameMs - measured)},
        {"spans", json::Value::makeObject(std::move(spans))}});
}

/** The high-performance adapter's `info` fields, empty ones left out; empty when there is none. */
std::vector<std::pair<std::string, std::string>> adapterIdentity() {
    struct Request {
        WGPUAdapter adapter = nullptr;
        bool done = false;
    } request;
    WGPUInstance instance = wgpuCreateInstance(nullptr);
    if (!instance) return {};
    WGPURequestAdapterOptions options = {};
    options.powerPreference = WGPUPowerPreference_HighPerformance;
#if WGPU_USES_CALLBACK_INFO_PATTERN
    WGPURequestAdapterCallbackInfo callback = {};
    callback.mode = WGPUCallbackMode_AllowProcessEvents;
    callback.callback = [](WGPURequestAdapterStatus status, WGPUAdapter adapter, WGPUStringView, void* data, void*) {
        auto& r = *static_cast<Request*>(data);
        if (status == WGPURequestAdapterStatus_Success) r.adapter = adapter;
        r.done = true;
    };
    callback.userdata1 = &request;
    wgpuInstanceRequestAdapter(instance, &options, callback);
#else
    wgpuInstanceRequestAdapter(instance, &options, [](WGPURequestAdapterStatus status, WGPUAdapter adapter, char const*, void* data) {
        auto& r = *static_cast<Request*>(data);
        if (status == WGPURequestAdapterStatus_Success) r.adapter = adapter;
        r.done = true;
    }, &request);
#endif
    for (int i = 0; i < 1000000 && !request.done; ++i) wgpuInstanceProcessEvents(instance);
    std::vector<std::pair<std::string, std::string>> fields;
    if (request.adapter) {
        WGPUAdapterInfo info = {};
        wgpuAdapterGetInfo(request.adapter, &info);
        for (const auto& [name, value] : {std::pair{"architecture", WGPU_PRINT_STRING_VIEW(info.architecture)},
                                          std::pair{"description", WGPU_PRINT_STRING_VIEW(info.description)},
                                          std::pair{"device", WGPU_PRINT_STRING_VIEW(info.device)},
                                          std::pair{"vendor", WGPU_PRINT_STRING_VIEW(info.vendor)}})
            if (!value.empty() && value != "unknown") fields.emplace_back(name, value);  // the macro's empty
        wgpuAdapterInfoFreeMembers(info);
        wgpuAdapterRelease(request.adapter);
    }
    wgpuInstanceRelease(instance);
    return fields;
}


namespace {

constexpr uint32_t kWidth = 1280;
constexpr uint32_t kHeight = 720;
constexpr double kTickStep = 1.0 / 60;
// How long a launched runner may take to send its first request before the host stops holding the
// boot for it. The game's own attach timeout is the same 30 s (PLAYTEST_ATTACH_TIMEOUT_MS), so the
// two never disagree about when a missing runner is a failure.
constexpr double kRunnerAttachGraceMs = 30000;
#if defined(__ANDROID__)
// The legacy Android host uses Immediate/Mailbox at 60 Hz and the software/display pacing cap.
constexpr bool kSurfaceVsync = false;
#else
constexpr bool kSurfaceVsync = true;
#endif

/**
 * A measurement run states its surface: TN_PLAYER_WIDTH and TN_PLAYER_HEIGHT size the window (the
 * drawing buffer follows it), TN_PLAYER_VSYNC=0 presents uncapped as the legacy host's `--no-vsync`
 * does. Read once; an unreadable value stops the player by name rather than measuring a surface
 * nobody asked for. Unset, every default is unchanged. TN_PLAYER_TITLE names the window (a packaged
 * game passes its `window.title`).
 */
struct SurfaceConfig {
    uint32_t width = kWidth, height = kHeight;
    bool vsync = kSurfaceVsync;
    std::string title = "ThreeNative native engine";
    std::string problem;
};

SurfaceConfig readSurfaceConfig() {
    SurfaceConfig config;
    const auto dimension = [&](const char* name, uint32_t& into) {
        const char* text = std::getenv(name);
        if (text == nullptr || text[0] == '\0') return;
        char* end = nullptr;
        const unsigned long value = std::strtoul(text, &end, 10);
        if (*end != '\0' || value < 64 || value > 16384) {
            config.problem = std::string(name) + " must be an integer from 64 to 16384, got '" + text + "'";
            return;
        }
        into = static_cast<uint32_t>(value);
    };
    dimension("TN_PLAYER_WIDTH", config.width);
    dimension("TN_PLAYER_HEIGHT", config.height);
    if (const char* text = std::getenv("TN_PLAYER_TITLE"); text != nullptr && text[0] != '\0') config.title = text;
    if (const char* text = std::getenv("TN_PLAYER_VSYNC"); text != nullptr && text[0] != '\0') {
        if (std::strcmp(text, "0") == 0 || std::strcmp(text, "off") == 0) config.vsync = false;
        else if (std::strcmp(text, "1") == 0 || std::strcmp(text, "on") == 0) config.vsync = true;
        else config.problem = std::string("TN_PLAYER_VSYNC must be 0, 1, off or on, got '") + text + "'";
    }
    return config;
}

const SurfaceConfig& surfaceConfig() {
    static const SurfaceConfig config = readSurfaceConfig();
    return config;
}

void startupStage(const char* stage) {
#if defined(__ANDROID__)
    __android_log_print(ANDROID_LOG_INFO, "TN_Player", "TN_PLAYER_STAGE: %s", stage);
#else
    (void)stage;
#endif
}

struct Window {
    SDL_Window* handle = nullptr;
#if defined(__APPLE__)
    SDL_MetalView metalView = nullptr;
#endif
#if defined(__ANDROID__)
    mystral::webgpu::Context* context = nullptr;
    std::unique_ptr<Presenter>* presenter = nullptr;
    bool resumeSurface = false;
#endif
    uint32_t width = kWidth;
    uint32_t height = kHeight;
};

#if defined(__linux__) && !defined(__ANDROID__)
/**
 * A window manager shows `_NET_WM_NAME` (UTF-8). SDL's static X11 build leaves it unset and writes
 * `WM_NAME` through the locale, so a title with a dash shows as "MIDWAY â Open Pacific" in the title
 * bar. libX11 is already loaded by SDL (RTLD_NOLOAD finds it); the player sets the property itself.
 */
void publishUtf8Title(SDL_Window* window, const std::string& title) {
    void* x11 = dlopen("libX11.so.6", RTLD_NOW | RTLD_NOLOAD);
    if (x11 == nullptr) return;
    using InternAtom = unsigned long (*)(void*, const char*, int);
    using ChangeProperty = int (*)(void*, unsigned long, unsigned long, unsigned long, int, int, const unsigned char*, int);
    using Flush = int (*)(void*);
    const auto intern = reinterpret_cast<InternAtom>(dlsym(x11, "XInternAtom"));
    const auto change = reinterpret_cast<ChangeProperty>(dlsym(x11, "XChangeProperty"));
    const auto flush = reinterpret_cast<Flush>(dlsym(x11, "XFlush"));
    const SDL_PropertiesID properties = SDL_GetWindowProperties(window);
    void* display = SDL_GetPointerProperty(properties, SDL_PROP_WINDOW_X11_DISPLAY_POINTER, nullptr);
    const auto id = static_cast<unsigned long>(SDL_GetNumberProperty(properties, SDL_PROP_WINDOW_X11_WINDOW_NUMBER, 0));
    if (intern == nullptr || change == nullptr || flush == nullptr || display == nullptr || id == 0) return;
    change(display, id, intern(display, "_NET_WM_NAME", 0), intern(display, "UTF8_STRING", 0), 8, 0 /* PropModeReplace */,
           reinterpret_cast<const unsigned char*>(title.data()), static_cast<int>(title.size()));
    flush(display);
}
#endif

/** The legacy host's platform presentation flags, without web-view or UI branches. */
bool openWindow(Window& window) {
#if defined(__ANDROID__)
    SDL_SetHint(SDL_HINT_ANDROID_BLOCK_ON_PAUSE, "1");
#endif
#if defined(__linux__) && !defined(__ANDROID__)
    // Dawn's Xlib surface needs the X11 backend, as src/platform/window.cpp forces on Linux.
    // SDL reads the hint in SDL_Init: set after it, a Wayland session keeps Wayland and no surface.
    SDL_SetHint(SDL_HINT_VIDEO_DRIVER, "x11");
#endif
    if (!SDL_Init(SDL_INIT_VIDEO | SDL_INIT_EVENTS)) {
        std::printf("[Playtest] SDL_Init failed: %s\n", SDL_GetError());
        return false;
    }
    SDL_WindowFlags flags = SDL_WINDOW_RESIZABLE;
#if defined(__APPLE__)
    flags |= SDL_WINDOW_METAL;
#elif !defined(_WIN32)
    flags |= SDL_WINDOW_VULKAN;
#endif
    window.handle = SDL_CreateWindow(surfaceConfig().title.c_str(), static_cast<int>(surfaceConfig().width),
                                     static_cast<int>(surfaceConfig().height), flags);
    if (!window.handle) {
        std::printf("[Playtest] SDL_CreateWindow failed: %s\n", SDL_GetError());
        return false;
    }
#if defined(__linux__) && !defined(__ANDROID__)
    publishUtf8Title(window.handle, surfaceConfig().title);
#endif
    int width = 0, height = 0;
    SDL_GetWindowSize(window.handle, &width, &height);
    if (width <= 0 || height <= 0)
        return false;
    window.width = static_cast<uint32_t>(width);
    window.height = static_cast<uint32_t>(height);
    std::printf("TN_PLAYER_WINDOW: title '%s', %dx%d\n", SDL_GetWindowTitle(window.handle), width, height);
    return true;
}

/** SDL exposes the native handles needed by the host's existing Dawn surface API. */
bool surfaceForWindow(mystral::webgpu::Context& context, Window& window) {
#if defined(__ANDROID__)
    void* native = SDL_GetPointerProperty(SDL_GetWindowProperties(window.handle),
                                         SDL_PROP_WINDOW_ANDROID_WINDOW_POINTER, nullptr);
    return native && context.createSurface(native, mystral::webgpu::Context::PLATFORM_ANDROID);
#elif defined(__APPLE__)
    window.metalView = SDL_Metal_CreateView(window.handle);
    void* layer = window.metalView ? SDL_Metal_GetLayer(window.metalView) : nullptr;
    return layer && context.createSurface(layer, mystral::webgpu::Context::PLATFORM_METAL);
#elif defined(_WIN32)
    void* hwnd = SDL_GetPointerProperty(SDL_GetWindowProperties(window.handle),
                                       SDL_PROP_WINDOW_WIN32_HWND_POINTER, nullptr);
    return hwnd && context.createSurface(hwnd, mystral::webgpu::Context::PLATFORM_WINDOWS);
#else
    SDL_PropertiesID properties = SDL_GetWindowProperties(window.handle);
    void* display = SDL_GetPointerProperty(properties, SDL_PROP_WINDOW_X11_DISPLAY_POINTER, nullptr);
    const auto id = SDL_GetNumberProperty(properties, SDL_PROP_WINDOW_X11_WINDOW_NUMBER, 0);
    if (!display || id == 0) {
        std::printf("[Playtest] The window carries no X11 handle, so there is no surface to present into.\n");
        return false;
    }
    return context.createSurfaceWithDisplay(display, reinterpret_cast<void*>(static_cast<std::uintptr_t>(id)),
                                           mystral::webgpu::Context::PLATFORM_XLIB);
#endif
}

#if defined(__ANDROID__)
// SDL's Android pump queues this event on the game thread before blocking on pause. A polled
// handler runs too late: the Java SurfaceView may already have destroyed its ANativeWindow.
bool SDLCALL lifecycleWatch(void* data, SDL_Event* event) {
    auto& window = *static_cast<Window*>(data);
    if (event->type == SDL_EVENT_WILL_ENTER_BACKGROUND) {
        window.presenter->reset();
        window.context->releaseSurface();
        window.resumeSurface = true;
        startupStage("surface-released"); // acknowledgement before SDL parks the game thread
    }
    return true;
}
#endif

/** Quits on a close request; the runner ends a run with SIGTERM, not with a window message. */
bool pumpEvents(Window& window, const Game& game) {
    SDL_Event event;
    while (SDL_PollEvent(&event)) {
        if (event.type == SDL_EVENT_QUIT || event.type == SDL_EVENT_WINDOW_CLOSE_REQUESTED)
            return false;
        // The mouse reaches an attached UI first, as on the legacy host (PRD-554), in window-normalized
        // coordinates; what the UI declines is the game's.
        const bool mouse = event.type == SDL_EVENT_MOUSE_BUTTON_DOWN || event.type == SDL_EVENT_MOUSE_BUTTON_UP ||
                           event.type == SDL_EVENT_MOUSE_MOTION;
        if (game.uiPointer && window.width > 0 && window.height > 0 && mouse) {
            const bool motion = event.type == SDL_EVENT_MOUSE_MOTION;
            const float x = motion ? event.motion.x : event.button.x, y = motion ? event.motion.y : event.button.y;
            const SDL_MouseButtonFlags held = SDL_GetMouseState(nullptr, nullptr);
            int buttons = (held & SDL_BUTTON_LMASK ? 1 : 0) | (held & SDL_BUTTON_RMASK ? 2 : 0) | (held & SDL_BUTTON_MMASK ? 4 : 0);
            const char* type = motion ? "pointermove" : event.type == SDL_EVENT_MOUSE_BUTTON_DOWN ? "pointerdown" : "pointerup";
            if (game.uiPointer(type, x / float(window.width), y / float(window.height), buttons)) continue;
        }
        // A person's keys, mouse and wheel become the DOM events the game's listeners read, through the
        // legacy host's translation (platform/input.cpp); a game runtime installs the callbacks.
        switch (event.type) {
            case SDL_EVENT_KEY_DOWN: mystral::platform::processKeyboardEvent(event.key, true); continue;
            case SDL_EVENT_KEY_UP: mystral::platform::processKeyboardEvent(event.key, false); continue;
            case SDL_EVENT_MOUSE_MOTION: mystral::platform::processMouseMotion(event.motion); continue;
            case SDL_EVENT_MOUSE_BUTTON_DOWN: mystral::platform::processMouseButton(event.button, true); continue;
            case SDL_EVENT_MOUSE_BUTTON_UP: mystral::platform::processMouseButton(event.button, false); continue;
            case SDL_EVENT_MOUSE_WHEEL: mystral::platform::processMouseWheel(event.wheel); continue;
            default: break;
        }
        if (event.type != SDL_EVENT_WINDOW_RESIZED && event.type != SDL_EVENT_WINDOW_PIXEL_SIZE_CHANGED)
            continue;
        int width = 0, height = 0;
        SDL_GetWindowSize(window.handle, &width, &height);
        if (width > 0 && height > 0) {
            window.width = static_cast<uint32_t>(width);
            window.height = static_cast<uint32_t>(height);
        }
    }
    return true;
}

}  // namespace

const char* presentModeName() { return surfaceConfig().vsync ? "fifo" : "immediate"; }

SurfaceSize configuredSurface() { return {surfaceConfig().width, surfaceConfig().height}; }

double threadCpuMs() {
#if defined(__linux__)
    timespec now{};
    if (clock_gettime(CLOCK_THREAD_CPUTIME_ID, &now) == 0) return double(now.tv_sec) * 1e3 + double(now.tv_nsec) / 1e6;
#endif
    return -1;
}

// Instructions this thread retired in user space, from a counter opened on first use; -1 where the kernel
// refuses one (perf_event_paranoid above 2, a VM without a PMU). On a shared host, load and clock speed move
// thread CPU time by more than a small cut saves; this count barely moves, so an A/B can read it (PRD-610).
double threadInstructions() {
#if defined(__linux__)
    thread_local const int counter = [] {
        perf_event_attr attr{};
        attr.type = PERF_TYPE_HARDWARE;
        attr.size = sizeof(attr);
        attr.config = PERF_COUNT_HW_INSTRUCTIONS;
        attr.exclude_kernel = 1;
        attr.exclude_hv = 1;
        return int(syscall(SYS_perf_event_open, &attr, 0, -1, -1, 0));
    }();
    uint64_t count = 0;
    if (counter >= 0 && read(counter, &count, sizeof(count)) == ssize_t(sizeof(count))) return double(count);
#endif
    return -1;
}

double threadCycles() {
#if defined(__linux__)
    thread_local const int counter = [] {
        perf_event_attr attr{};
        attr.type = PERF_TYPE_HARDWARE;
        attr.size = sizeof(attr);
        attr.config = PERF_COUNT_HW_CPU_CYCLES;
        attr.exclude_kernel = 1;
        attr.exclude_hv = 1;
        return int(syscall(SYS_perf_event_open, &attr, 0, -1, -1, 0));
    }();
    uint64_t count = 0;
    if (counter >= 0 && read(counter, &count, sizeof(count)) == ssize_t(sizeof(count))) return double(count);
#endif
    return -1;
}

json::Value frameTiming(double gameMs, double renderMs, double cpuMs, double frameMs, uint64_t bridgeCalls,
                        uint64_t tick, uint64_t updates, double gameCpuMs, double cpuFrameCpuMs, double presentCpuMs,
                        double renderCpuMs) {
    using V = json::Value;
    std::vector<std::pair<std::string, V>> members{
        {"gameJsMs", V::makeNumber(gameMs)}, {"renderMs", V::makeNumber(renderMs)},
        {"cpuFrameMs", V::makeNumber(cpuMs)}, {"frameMs", V::makeNumber(frameMs)},
        {"bridgeCalls", V::makeNumber(double(bridgeCalls))},
        {"tick", V::makeNumber(double(tick))}, {"updates", V::makeNumber(double(updates))}};
    if (gameCpuMs >= 0) members.emplace_back("gameJsCpuMs", V::makeNumber(gameCpuMs));
    if (cpuFrameCpuMs >= 0) members.emplace_back("cpuFrameCpuMs", V::makeNumber(cpuFrameCpuMs));
    if (presentCpuMs >= 0) members.emplace_back("presentCpuMs", V::makeNumber(presentCpuMs));
    if (renderCpuMs >= 0) members.emplace_back("renderCpuMs", V::makeNumber(renderCpuMs));
    return V::makeObject(std::move(members));
}

#if defined(__linux__) && !defined(__ANDROID__)
/**
 * PRD-610: the game thread keeps its own cores. It takes one L3 domain (a Ryzen CCD), or one physical
 * core where all cores share one L3. Every other thread of the player and its child processes (the GPU
 * present worker, the render thread, shader compiles, V8 workers, the HUD overlay and its WebKit
 * processes) runs on the remaining CPUs. On Xvfb the NVIDIA present waits in a busy loop, and sharing
 * cores with it cost the game thread 15 to 30% of its IPC on Midway.
 * Placement starts from the core the firmware ranks last (ACPI CPPC) among the fastest by max frequency:
 * the scheduler packs other busy work onto top-ranked cores first, and a game thread pinned there
 * competed with it.
 */
struct ThreadPlacement {
    cpu_set_t helpers{};
    bool active = false;
    std::chrono::steady_clock::time_point lastSweep{};

    static long readNumber(const std::string& path) {
        long value = -1;
        if (std::FILE* file = std::fopen(path.c_str(), "r")) {
            if (std::fscanf(file, "%ld", &value) != 1) value = -1;
            std::fclose(file);
        }
        return value;
    }
    /** A sysfs CPU list ("11,23", "6-11,18-23") as a set; empty when unreadable. */
    static cpu_set_t readList(const std::string& path) {
        cpu_set_t set;
        CPU_ZERO(&set);
        if (std::FILE* file = std::fopen(path.c_str(), "r")) {
            int first = 0, last = 0;
            char separator = 0;
            while (std::fscanf(file, "%d", &first) == 1) {
                last = first;
                if (std::fscanf(file, "%c", &separator) == 1 && separator == '-' && std::fscanf(file, "%d", &last) == 1)
                    std::fscanf(file, "%c", &separator);
                for (int c = first; c <= last && c < CPU_SETSIZE; ++c) CPU_SET(c, &set);
            }
            std::fclose(file);
        }
        return set;
    }
    void start() {
        cpu_set_t allowed;
        if (sched_getaffinity(0, sizeof allowed, &allowed) != 0 || CPU_COUNT(&allowed) < 4) return;
        int chosen = -1;
        // The fastest cores by max frequency first (P-cores on a hybrid CPU), then the last CPPC rank among them.
        const auto cpuFile = [](int c, const char* name) { return "/sys/devices/system/cpu/cpu" + std::to_string(c) + name; };
        long fastest = -1, lowest = LONG_MAX;
        for (int c = 0; c < CPU_SETSIZE; ++c)
            if (CPU_ISSET(c, &allowed)) fastest = std::max(fastest, readNumber(cpuFile(c, "/cpufreq/cpuinfo_max_freq")));
        for (int c = 0; c < CPU_SETSIZE; ++c) {
            if (!CPU_ISSET(c, &allowed) || readNumber(cpuFile(c, "/cpufreq/cpuinfo_max_freq")) != fastest) continue;
            const long rank = std::max(0L, readNumber(cpuFile(c, "/acpi_cppc/highest_perf")));
            if (rank <= lowest) lowest = rank, chosen = c;
        }
        // Several L3 domains (a Ryzen CCD): the game thread takes the chosen core's domain and the helpers the
        // others, so neither shares a core or an L3 with the other. One shared L3: the game thread takes the core.
        const std::string base = "/sys/devices/system/cpu/cpu" + std::to_string(chosen);
        const cpu_set_t domain = readList(base + "/cache/index3/shared_cpu_list");
        cpu_set_t main;
        CPU_AND(&main, &domain, &allowed);
        if (CPU_COUNT(&main) == 0 || CPU_EQUAL(&main, &allowed)) {
            const cpu_set_t core = readList(base + "/topology/thread_siblings_list");
            CPU_AND(&main, &core, &allowed);
        }
        if (CPU_COUNT(&main) == 0) CPU_SET(chosen, &main);
        CPU_XOR(&helpers, &allowed, &main);
        if (CPU_COUNT(&helpers) == 0 || sched_setaffinity(0, sizeof main, &main) != 0) return;
        active = true;
        sweep();
        std::string cpus;
        for (int c = 0; c < CPU_SETSIZE; ++c)
            if (CPU_ISSET(c, &main)) cpus += (cpus.empty() ? "" : ",") + std::to_string(c);
        std::printf("TN_THREAD_PLACEMENT main=%s helpers=%d\n", cpus.c_str(), CPU_COUNT(&helpers));
    }
    /** Moves every thread but the calling (game) one, and every descendant process, onto the helpers. */
    void moveTasks(int pid, bool self) {
        const std::string root = "/proc/" + std::to_string(pid) + "/task";
        DIR* tasks = opendir(root.c_str());
        if (!tasks) return;
        const pid_t me = static_cast<pid_t>(syscall(SYS_gettid));
        while (const dirent* entry = readdir(tasks)) {
            const int tid = std::atoi(entry->d_name);
            if (tid <= 0) continue;
            if (!self || tid != me) sched_setaffinity(tid, sizeof helpers, &helpers);
            // Children are listed per thread; WebKit's processes hang off the overlay's thread.
            if (std::FILE* file = std::fopen((root + "/" + entry->d_name + "/children").c_str(), "r")) {
                int child = 0;
                while (std::fscanf(file, "%d", &child) == 1) moveTasks(child, false);
                std::fclose(file);
            }
        }
        closedir(tasks);
    }
    void sweep() {
        lastSweep = std::chrono::steady_clock::now();
        moveTasks(static_cast<int>(getpid()), true);
    }
    /** Threads started after `start` inherit the game thread's core; a sweep a second moves them. */
    void sweepIfDue() {
        if (active && std::chrono::steady_clock::now() - lastSweep >= std::chrono::seconds(1)) sweep();
    }
};
#else
struct ThreadPlacement {
    void start() {}
    void sweepIfDue() {}
};
#endif

struct Session {
    Game game;
    Window window;
    std::unique_ptr<mystral::webgpu::Context> context;
    std::unique_ptr<Presenter> presenter;
    EventQueue events;
    std::unique_ptr<Renderer> renderer;
    // PRD-610 AC-9: submit, acquire, blit, present and the device poll run here, off the game thread,
    // while the next frame's JS runs. TN_GPU_THREAD=0 keeps them on the game thread.
    std::shared_ptr<GpuThread> gpuThread;
    double gpuThreadCpuMs = -1;  // the GPU thread's CPU for the previous frame's present job
    double gpuJobCpuMs = -1;     // written by that job; copied above only after a wait
    // PRD-613: the encode half of the frame (every pass, main and reflections) runs here, off the game
    // thread, while the next frame's JS runs. On by default; TN_RENDER_THREAD=0 turns it off and GPU timing runs
    // keep it off. It needs the GPU thread.
    // The game thread touches the renderer only after waitRenderThread() and before it posts the next job.
    std::shared_ptr<GpuThread> renderThread;
    std::vector<std::function<void()>> encodeJobs;  // this frame's passes, in order; the job reads them, so they live here
    double renderThreadCpuMs = -1;  // the render thread's CPU for the previous frame's job
    double renderJobCpuMs = -1;     // written by that job; copied above only after a wait
    std::exception_ptr renderError;  // an encode failure, rethrown on the game thread at the next handoff
    bool renderJobPosted = false;
    uint64_t renderFallbacks = 0;    // frames that took the inline path while the render thread was on
    /** Waits for the frame in flight: the render thread first, then the GPU thread its job fed. */
    void waitRenderThread(bool rethrow) {
        if (renderThread) {
            renderThread->wait();
            if (renderJobPosted) renderThreadCpuMs = renderJobCpuMs;
            renderJobPosted = false;
        }
        if (gpuThread) {
            gpuThread->wait();
            gpuThreadCpuMs = gpuJobCpuMs;
        }
        if (renderThread && renderer) renderer->collectFrame();
        if (rethrow && renderError) std::rethrow_exception(std::exchange(renderError, nullptr));
    }
    world::FixedStepClock clock{kTickStep, 5};
    uint64_t drivenTicks = 0;
    double nowMs = 0;
    std::unique_ptr<inspect::Endpoint> endpoint;
    std::unique_ptr<Mailbox> mailbox;
    Object3D* scene;
    Camera* camera;
    std::function<void()> renderFrame;
    std::function<bool()> refreshView;
    std::chrono::steady_clock::time_point freeRunStart;
    std::optional<std::chrono::steady_clock::time_point> attachWaitStart;
    RenderDatabase database;
    bool runner = false, initialized = false, readbackInFlight = false, firstFrame = true;
    bool viewFailed = false;
    bool metrics = std::getenv("TN_PLAYER_METRICS") != nullptr || gameSpan(-1, 0) == 1;
    bool gpuTiming = metrics && std::getenv("TN_PLAYER_GPU_TIMING") && std::strcmp(std::getenv("TN_PLAYER_GPU_TIMING"), "1") == 0;
    uint64_t previousGpuSamples = 0;
    bool mainThreadCpuEnabled = [] {
        const char* flag = std::getenv("TN_PLAYER_MAIN_THREAD_CPU");
        const char* metricsFlag = std::getenv("TN_PLAYER_METRICS");
        return metricsFlag && std::strcmp(metricsFlag, "1") == 0 && flag && std::strcmp(flag, "1") == 0;
    }();
    bool spans = gameSpan(-1, 0) == 1;
    uint64_t measuredFrames = 0, previousCrossings = 0, updateTicks = 0;
    // Headless pacing: the last tick this loop drew, and whether it has drawn at all. A window's
    // present paces the loop; without one the loop would submit thousands of frames a second and
    // queue them ahead of the next readback faster than a software GPU executes them.
    uint64_t lastRenderedTick = UINT64_MAX;
    bool hasRendered = false;
    std::set<std::string> renderNotes;  // a renderer note (a skipped draw) prints once, not every frame
    double updateMs = 0, readyMs = 0, updateCpuMs = 0, updateInstructions = 0, updateCycles = 0;
    double updateMixerCpuMs = 0;
    uint64_t updateMixerCalls = 0;
    double updateCullCpuMs = 0;
    uint64_t updateCullCalls = 0;
    void update(double dt) {
        const auto begin = metrics ? std::chrono::steady_clock::now() : std::chrono::steady_clock::time_point{};
        const double cpuBegin = metrics ? threadCpuMs() : -1;
        const auto cullBegin = metrics ? ProjectedCull::cpuTiming : ProjectedCull::CpuTiming{};
        const auto mixerBegin = metrics ? animation::AnimationMixer::cpuTiming : animation::AnimationMixer::CpuTiming{};
        const double instructionsBegin = metrics ? threadInstructions() : -1;
        const double cyclesBegin = metrics ? threadCycles() : -1;
        if (spans) gameSpan(kHostUpdateSpan, 0);
        if (game.update) game.update(dt);
        if (spans) gameSpan(kHostUpdateSpan, 1);
        if (metrics) updateMs += std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - begin).count();
        if (cpuBegin >= 0) updateCpuMs += threadCpuMs() - cpuBegin;
        if (metrics) {
            updateMixerCpuMs += animation::AnimationMixer::cpuTiming.ms - mixerBegin.ms;
            updateMixerCalls += animation::AnimationMixer::cpuTiming.calls - mixerBegin.calls;
            updateCullCpuMs += ProjectedCull::cpuTiming.ms - cullBegin.ms;
            updateCullCalls += ProjectedCull::cpuTiming.calls - cullBegin.calls;
        }
        if (instructionsBegin >= 0) updateInstructions += threadInstructions() - instructionsBegin;
        if (cyclesBegin >= 0) updateCycles += threadCycles() - cyclesBegin;
        if (metrics) ++updateTicks;
    }
#if defined(__ANDROID__)
    bool watching = false;
#endif
    explicit Session(const Game& source) : game(source), scene(game.scene), camera(game.camera) {
        ProjectedCull::cpuTiming = {metrics ? &threadCpuMs : nullptr};
        animation::AnimationMixer::cpuTiming = {metrics ? &threadCpuMs : nullptr};
        // Benchmarks need one rendered sample per driven simulation tick, not a batch of 600 updates.
        if (metrics) game.renderEachTick = true;
        if (spans) gameSpans = {};
    }
    uint64_t tick() const { return runner ? drivenTicks : clock.tick(); }
    ThreadPlacement placement;
    int initialize();
    int step();
    ~Session();
};

int Session::initialize() {
    if (const char* rt = std::getenv("TN_RENDER_THREAD"); gpuTiming && rt && std::strcmp(rt, "1") == 0) {
        std::fprintf(stderr, "TN_PLAYER_GPU_TIMING_UNSUPPORTED: TN_RENDER_THREAD=1 has no synchronized GPU timing snapshot.\n");
        return 2;
    }
    if (!game.view && (game.scene == nullptr || game.camera == nullptr)) {
        std::printf("TN_PLAYER_NO_SCENE: %s carries no scene or camera.\n", game.name.c_str());
        return 1;
    }

    if (!surfaceConfig().problem.empty()) {
        std::printf("TN_PLAYER_ENV: %s\n", surfaceConfig().problem.c_str());
        return 1;
    }
    startupStage("sdl-window-begin");
    const bool windowed = openWindow(window);
    startupStage(windowed ? "sdl-window-ready" : "sdl-window-failed");
    // A game's UI over this window (PRD-554); one that asked for a UI and cannot show it stops by name
    // rather than playing behind an empty rectangle.
    if (game.uiAttach && !game.uiAttach(windowed ? window.handle : nullptr))
        return 1;
    auto candidate = std::make_unique<mystral::webgpu::Context>();
    startupStage("webgpu-surface-begin");
    if (windowed && candidate->initialize() && surfaceForWindow(*candidate, window) &&
        candidate->configureSurface(window.width, window.height, surfaceConfig().vsync)) {
        context = std::move(candidate);
        presenter = std::make_unique<Presenter>(*context);
    } else {
        // The window is the product path. Without a display or a surface the game still runs, so a
        // scenario can inspect and advance it; only the presented frame is missing.
#if defined(__ANDROID__)
        std::printf("TN_PLAYER_ANDROID_SURFACE_FAILED\n");
        return 2; // a device run must never silently become headless
#endif
        std::printf("[Playtest] No presentable surface; running headless.\n");
        context = std::make_unique<mystral::webgpu::Context>();
        if (!context->initializeHeadless())
            return 2;
    }
    startupStage("webgpu-surface-ready");

#if defined(__ANDROID__)
    mystral::webgpu::notePresentationFramesStopped();
    mystral::webgpu::setPresentationCapHz(60);
    window.context = context.get();
    window.presenter = &presenter;
    if (!SDL_AddEventWatch(lifecycleWatch, &window)) {
        std::fprintf(stderr, "TN_PLAYER_ANDROID_EVENT_WATCH_FAILED: %s\n", SDL_GetError());
        return 2;
    }
    watching = true;
#endif
    startupStage("renderer-begin");
    renderer = std::make_unique<Renderer>(context->getInstance(), context->getDevice(), context->getQueue(), events);
    const uint32_t width = presenter ? presenter->width() : surfaceConfig().width;
    const uint32_t height = presenter ? presenter->height() : surfaceConfig().height;
    renderer->setGpuTimer(gpuTiming);
    renderer->setSize(width, height);
    renderer->setOutput(OutputState{shader::ToneMapping::ACESFilmic, 1, true});
#if !defined(__ANDROID__)
    if (const char* flag = std::getenv("TN_GPU_THREAD"); presenter && !(flag && std::strcmp(flag, "0") == 0)) {
        gpuThread = std::make_shared<GpuThread>();
        renderer->gpu().setThread(gpuThread);
        // Only a game that fences its own renderer touches (setRenderBarrier) can share the renderer with a thread.
        if (const char* rt = std::getenv("TN_RENDER_THREAD"); !gpuTiming && !(rt && std::strcmp(rt, "0") == 0) && game.setRenderBarrier) {
            renderThread = std::make_shared<GpuThread>();
            renderer->collectFrame();
            game.setRenderBarrier([this] { waitRenderThread(false); });
        }
    }
#endif
    startupStage("renderer-ready");
    initialized = true;
    startupStage("game-initialize-begin");
    if (game.initialize)
        game.initialize(*renderer);
    startupStage("game-initialize-ready");
    placement.start();

    clock.start(0);
    inspect::Host host;
    host.scene = game.scene;
    host.gameRuntime = game.gameRuntime;
    host.renderEachTick = game.renderEachTick;
    host.observe = game.observe;
    host.tick = [this] { return tick(); };
    host.setLiveClock = [this](bool) {
        waitRenderThread(true);
        clock = world::FixedStepClock{kTickStep, 5};
        clock.start(0);
        freeRunStart = std::chrono::steady_clock::now();
    };
    host.step = [this] {
        // A runner requests updates directly; the wall-time accumulator may bank zero or two.
        ++drivenTicks;
        update(kTickStep);
        if (game.renderEachTick && renderFrame)
            renderFrame();
    };
    // What the scenario schema can read: the profile describe reports, a state snapshot a scenario
    // compares across labelled steps, and whatever else the game registers.
    host.resource = [this](const std::string& id) -> json::Value {
        if (id == "surface")
            return json::Value::makeObject({
                {"deviceCreations", json::Value::makeNumber(context->deviceCreations())},
                {"surfaceCreations", json::Value::makeNumber(context->surfaceCreations())}});
        if (id == "profile")
            return json::Value::makeObject({{"engine", json::Value::makeString("native")},
                                            {"gameRuntime", json::Value::makeString(game.gameRuntime)}});
        if (id == "render") {
            const auto pass = [](const Renderer::FrameStats::SkinnedPass& stats) {
                return json::Value::makeObject({{"skinnedBatches", json::Value::makeNumber(stats.batches)},
                                                {"skinnedDraws", json::Value::makeNumber(stats.draws)},
                                                {"skinnedExactDraws", json::Value::makeNumber(stats.exactDraws)},
                                                {"skinnedInstances", json::Value::makeNumber(stats.instances)}});
            };
            const auto& stats = renderer->lastFrame();
            return json::Value::makeObject({{"main", pass(stats.mainSkinned)}, {"shadow", pass(stats.shadowSkinned)}});
        }
        return game.resource ? game.resource(id, tick()) : json::Value::makeNull();
    };
    endpoint = std::make_unique<inspect::Endpoint>(std::move(host));
    if (game.attach)
        game.attach(*endpoint);
    refreshView = [this] {
        if (!game.view) return true;
        std::string error;
        if (game.view(scene, camera, error) < 0) {
            viewFailed = true;
            return std::printf("TN_PLAYER_VIEW: %s\n", error.c_str()), false;
        }
        endpoint->setScene(scene);
        return true;
    };

    mailbox = std::make_unique<Mailbox>(Mailbox::rootFromEnvironment());
    runner = mailbox->announceReady();
    startupStage(runner ? "mailbox-ready" : "mailbox-off");
    std::printf("[Playtest] threenative-native-engine ready: game %s, runtime %s, %ux%u, mailbox %s\n",
                game.name.c_str(), game.gameRuntime.c_str(), renderer->width(), renderer->height(),
                runner ? "on" : "off");

    freeRunStart = std::chrono::steady_clock::now();
    database.shadowMapEnabled = game.shadowMapEnabled;
    // Diagnostic (PRD-613 stage 0): per-frame prepare split and upload bytes in TN_PLAYER_FRAME.
    database.profiling = metrics && std::getenv("TN_RENDER_PREPARE_SPLIT") != nullptr;
    previousCrossings = (game.bridgeCalls ? game.bridgeCalls() : 0);
    renderFrame = [this, lastWorldVisits = Object3D::matrixEvaluations(),
                   lastJoinVisits = Object3D::joinDependencyVisits(),
                   lastBoundaryVisits = Object3D::gpuBoundaryVisits(),
                   lastProjectionVisits = Object3D::gpuProjectionVisits_,
                   lastValidationVisits = Object3D::gpuValidationVisits_,
                   lastMaintenanceVisits = Object3D::gpuMaintenanceVisits_]() mutable {
        const auto frameBegin = metrics ? std::chrono::steady_clock::now() : std::chrono::steady_clock::time_point{};
        const double cpuFrameBegin = metrics ? threadCpuMs() : -1;
        const auto cullBegin = metrics ? ProjectedCull::cpuTiming : ProjectedCull::CpuTiming{};
        const auto mixerBegin = metrics ? animation::AnimationMixer::cpuTiming : animation::AnimationMixer::CpuTiming{};
        const double instructionsFrameBegin = metrics ? threadInstructions() : -1;
        const double cyclesFrameBegin = metrics ? threadCycles() : -1;
        if (spans) gameSpan(kHostFrameSpan, 0);
        double presentMs = 0, presentCpuMs = 0, gameCpuMs = -1, presentInstructions = 0, presentCycles = 0;
        double presentCpuStart = -1, presentCpuEnd = -1;
        bool presentTimed = false;
        std::optional<json::Value> frameSpans;
        const auto elapsed = [](auto begin) {
            return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - begin).count();
        };
        if (firstFrame) startupStage("first-render-begin");
        if (spans) gameSpan(kGcSpan, 0);
        if (game.afterRender)  // after the previous frame; between frames, never inside one
            game.afterRender();
        if (spans) gameSpan(kGcSpan, 1);
        const double cpuAfterRender = metrics ? threadCpuMs() : -1;
        if (!refreshView()) { if (spans) gameSpan(kHostFrameSpan, 1); return; }

        bool resized = false;
        if (presenter && (presenter->width() != window.width || presenter->height() != window.height)) {
            waitRenderThread(true);  // the previous present still uses the surface
            resized = true;
            presenter->resize(window.width, window.height);
            renderer->setSize(presenter->width(), presenter->height());
            if (game.uiResize) game.uiResize(int(window.width), int(window.height));
        }
        // Nothing is drawn until the game publishes its view, as a page's canvas stays blank while it loads.
        const bool withoutView = scene == nullptr || camera == nullptr;
        if (withoutView) {
            if (game.frameWithoutView) game.frameWithoutView();
            // A loading screen drawn before the world is published is still presented.
            if (!game.overlay || game.overlay() == 0) {
                if (spans) { gameSpan(kHostFrameSpan, 1); gameSpanTiming(0); }
                renderer->poll();
                events.drain();
                return;
            }
        }
        // core restores its projected cull inside beforeRender, before this C++ draw: hold it until the
        // frame ends so the draw sees the hides, as a browser draw inside render() does.
        ProjectedCull::holdRestores(true);
        struct ReleaseCull {
            ~ReleaseCull() { ProjectedCull::holdRestores(false); ProjectedCull::releaseHeld(); }
        } releaseCull;
        if (!withoutView && game.beforeRender) game.beforeRender(*renderer, database);
        // Frame callbacks can replace the published view and release its previous owners.
        if (!withoutView && (!refreshView() || scene == nullptr || camera == nullptr)) { if (spans) gameSpan(kHostFrameSpan, 1); return; }
        const int overlay = withoutView ? 2 : game.overlay ? game.overlay() : 0;
        if (metrics && measuredFrames == 0) {
            const char* launch = std::getenv("TN_BENCH_LAUNCH_MS");
            if (launch) readyMs = std::chrono::duration<double, std::milli>(std::chrono::system_clock::now().time_since_epoch()).count() - std::strtod(launch, nullptr);
        }
        const double gameMs = metrics ? updateMs + elapsed(frameBegin) : 0;
        if (cpuFrameBegin >= 0) gameCpuMs = updateCpuMs + threadCpuMs() - cpuFrameBegin;
        if (spans) {
            gameSpan(kHostFrameSpan, 1);
            frameSpans = gameSpanTiming(gameMs);
        }
        // One frame in flight: the previous frame's present job ends before this frame touches the queue.
        // The JS above ran while it was still going.
        // With the render thread on, the render thread's job ends first: it posts the present.
        waitRenderThread(true);
        // The page's newest frame goes over the world in the blit (PRD-554); uploaded before the render
        // so its queue write never waits for this frame's submit on the GPU thread.
        if (presenter && game.uiDraw) game.uiDraw(*renderer);
        const auto renderBegin = metrics ? std::chrono::steady_clock::now() : std::chrono::steady_clock::time_point{};
        const double renderCpuBegin = metrics ? threadCpuMs() : -1;
        std::array<double, 2> renderSplitMs{-1, -1};  // wall ms: {prepare, encode+submit}
        // The first frame, a resize and a surface-less run encode inline: they read the frame back at once.
        // A frame with an overlay too: the overlay composites over the world frame, so the world encodes first.
        const bool offThread = renderThread && presenter && !firstFrame && !resized && overlay == 0;
        if (renderThread && !offThread) ++renderFallbacks;
        encodeJobs.clear();
        database.encodeJobs = offThread ? &encodeJobs : nullptr;
        // ponytail: an overlay alone, or over a world frame the environment bake skipped, composites over the last
        // output frame, so a translucent one builds up; core holds an opaque cover there, a clear pass if one is not.
        if (overlay != 2) try {
            database.render(*renderer, *scene, *camera, game.clear ? game.clear() : std::array<double, 4>{0.05, 0.06, 0.09, 1},
                            metrics ? &renderSplitMs : nullptr);
        } catch (...) {
            // A pass that planned before the failure still holds its frame: encode it, as the inline path would have.
            for (auto& job : encodeJobs) job();
            encodeJobs.clear();
            throw;
        }
        if (overlay != 0) game.drawOverlay(*renderer);
        if (renderThread && !offThread) renderer->collectFrame();
        const double renderMs = metrics ? elapsed(renderBegin) : 0;
        const double renderCpuMs = renderCpuBegin >= 0 ? threadCpuMs() - renderCpuBegin : -1;
        for (const std::string& diagnostic : database.diagnostics())
            std::printf("[Playtest] %s\n", diagnostic.c_str());
        for (const std::string& diagnostic : renderer->diagnostics())
            if (renderNotes.insert(diagnostic).second) std::printf("[Playtest] %s\n", diagnostic.c_str());
        lastRenderedTick = tick();
        hasRendered = true;
        if (presenter) {
            Presenter::Frame target;
            if (firstFrame) startupStage("first-acquire-begin");
            const auto presentBegin = metrics ? std::chrono::steady_clock::now() : std::chrono::steady_clock::time_point{};
            const auto format = static_cast<WGPUTextureFormat>(context->getPreferredFormat());
            const auto presentationEpoch = endpoint->liveClock() ? endpoint->presentationEpoch() : 0;
            if (offThread) {
                // Every pass's encode, then the present job for the GPU thread, in order on the render thread.
                // The jobs hold renderers, never scene data, and the game thread does not touch them until
                // its next waitRenderThread().
                renderJobPosted = true;
                renderThread->post([this, format, queue = context->getQueue(), presentationEpoch]() mutable {
                    const double begin = threadCpuMs();
                    try {
                        for (auto& job : encodeJobs) job();
                        if (auto plan = renderer->prepareBlit(format)) {
                            gpuThread->post([plan = *plan, presenter = presenter.get(), queue,
                                             stats = &gpuJobCpuMs, observation = endpoint.get(), presentationEpoch]() mutable {
                                const double gpuBegin = threadCpuMs();
                                Presenter::Frame frame;
                                WGPUCommandBuffer commands = presenter->begin(frame) ? Renderer::encodeBlit(plan, frame.color) : nullptr;
                                if (commands) {
                                    wgpuQueueSubmit(queue, 1, &commands);
                                    wgpuCommandBufferRelease(commands);
                                    const bool presented = presenter->present();
                                    if (observation->liveClock()) observation->recordPresentation(std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count(), presentationEpoch, presented);
                                } else {
                                    wgpuBindGroupRelease(plan.group);
                                    if (plan.overGroup) wgpuBindGroupRelease(plan.overGroup);
                                }
                                *stats = threadCpuMs() - gpuBegin;
                            });
                        }
                    } catch (...) {
                        renderError = std::current_exception();
                    }
                    renderJobCpuMs = threadCpuMs() - begin;
                });
            } else if (gpuThread && !firstFrame) {
                // Prepared here, recorded there: the job reads the plan and the presenter, never the renderer.
                if (auto plan = renderer->prepareBlit(format)) {
                    gpuThread->post([plan = *plan, presenter = presenter.get(), queue = context->getQueue(),
                                     stats = &gpuJobCpuMs, observation = endpoint.get(), presentationEpoch]() mutable {
                        const double begin = threadCpuMs();
                        Presenter::Frame frame;
                        WGPUCommandBuffer commands = presenter->begin(frame) ? Renderer::encodeBlit(plan, frame.color) : nullptr;
                        if (commands) {
                            wgpuQueueSubmit(queue, 1, &commands);
                            wgpuCommandBufferRelease(commands);
                            const bool presented = presenter->present();
                            if (observation->liveClock()) observation->recordPresentation(std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count(), presentationEpoch, presented);
                        } else {
                            wgpuBindGroupRelease(plan.group);
                            if (plan.overGroup) wgpuBindGroupRelease(plan.overGroup);
                        }
                        *stats = threadCpuMs() - begin;  // read by the game thread after its next wait
                    });
                }
            } else if (presenter->begin(target)) {
                // The window carries the very frame the render database just built.
                renderer->blitTo(context->getQueue(), target.color, format);
                // blitTo's submit is posted to the GPU thread: it must reach the queue before the surface
                // texture is presented (and destroyed), or Dawn rejects a submit of a destroyed texture.
                if (gpuThread) gpuThread->wait();
                // The swap call alone, on the clock the legacy host uses around wgpuSurfacePresent.
                const double presentCpuBegin = metrics ? threadCpuMs() : -1;
                const double presentInstructionsBegin = metrics ? threadInstructions() : -1;
                const double presentCyclesBegin = metrics ? threadCycles() : -1;
                const bool presented = presenter->present();
                if (endpoint->liveClock()) endpoint->recordPresentation(std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count(), presentationEpoch, presented);
                if (presentInstructionsBegin >= 0) presentInstructions = threadInstructions() - presentInstructionsBegin;
                if (presentCyclesBegin >= 0) presentCycles = threadCycles() - presentCyclesBegin;
                if (presentCpuBegin >= 0) { presentCpuEnd = threadCpuMs(); presentCpuMs = presentCpuEnd - presentCpuBegin; presentCpuStart = presentCpuBegin; presentTimed = true; }
#if defined(__ANDROID__)
                mystral::webgpu::paceToPresentationCap();
#endif
                if (firstFrame) {
                    startupStage("first-present-ready");
                    std::printf("TN_PLAYER_FIRST_PRESENT: runtime %s\n", game.gameRuntime.c_str());
                    std::fflush(stdout);
                }
                if (metrics && measuredFrames == 0) {
                    std::printf("TN_PLAYER_TIMING:%s\n", json::stringify(json::Value::makeObject({
                        {"readyMs", json::Value::makeNumber(readyMs)},
                        {"firstFrameMs", json::Value::makeNumber(elapsed(frameBegin))}})).c_str());
                }
                firstFrame = false;
            }
            if (metrics) presentMs = elapsed(presentBegin);
        }

        // A screenshot answer is a real frame of this loop, so it is read back from the renderer the
        // moment the mailbox asks for one. The readback lands a few frames later.
        if (mailbox->screenshotRequested() && !readbackInFlight) {
            waitRenderThread(true);  // the read-back takes this very frame, so its encode ends first
            // With a UI the answer is the presented frame, the page drawn over it, as a player sees it.
            const auto read = [this](ReadbackCallback done) {
                return game.uiDraw ? renderer->readPresented(std::move(done)) : renderer->readPixels(std::move(done));
            };
            readbackInFlight = read([this](GpuStatus status, std::vector<uint8_t> pixels) {
                readbackInFlight = false;
                if (status == GpuStatus::Ok) {
                    mailbox->answerScreenshot(pixels, renderer->width(), renderer->height());
                }
            }) == GpuStatus::Ok;
        }
        // Bounded by iteration count, never by a wait: a readback completes on a later drain of
        // the event queue (GpuResources::readTexture), and the swapchain's present paces the loop.
        // With a GPU thread the poll is one more posted job, after the present; what it delivers
        // drains on a later frame.
        for (int i = 0; !gpuThread && i < 100000 && (readbackInFlight || events.pending()); ++i) {
            renderer->poll();
            events.drain();
            if (!readbackInFlight && events.pending() == 0)
                break;
        }
        // Retirement callbacks also need a poll when no readback/event was queued at frame start.
        renderer->poll();
        events.drain();
        if (game.frameComplete)
            game.frameComplete(*renderer, database.diagnostics());
        if (metrics) {
            const double duration = updateMs + elapsed(frameBegin);
            auto sample = frameTiming(gameMs, renderMs, duration - presentMs, duration,
                                      (game.bridgeCalls ? game.bridgeCalls() : 0) - previousCrossings,
                                      tick(), updateTicks, gameCpuMs,
                                      cpuFrameBegin >= 0 ? updateCpuMs + threadCpuMs() - cpuFrameBegin - presentCpuMs : -1,
                                      presentTimed ? presentCpuMs : -1, renderCpuMs);
            if (presentTimed && renderCpuMs >= 0) {
                // The host segments outside the page's phases, so the bench's `other` splits on a clock (PRD-573 v1.11).
                using V = json::Value;
                auto members = sample.members();
                members.emplace_back("hostCpuMs", V::makeObject({
                    {"afterRender", V::makeNumber(cpuAfterRender - cpuFrameBegin)},
                    {"prePresent", V::makeNumber(presentCpuStart - (renderCpuBegin + renderCpuMs))},
                    {"postPresent", V::makeNumber(threadCpuMs() - presentCpuEnd)},
                    {"update", V::makeNumber(updateCpuMs)}}));
                sample = V::makeObject(std::move(members));
            }
            if (renderSplitMs[0] >= 0) {
                auto members = sample.members();
                members.emplace_back("renderPrepareMs", json::Value::makeNumber(renderSplitMs[0]));
                members.emplace_back("renderEncodeMs", json::Value::makeNumber(renderSplitMs[1]));
                if (database.profiling) {
                    static uint64_t lastGeometryBytes = 0, lastTextureBytes = 0;
                    const auto& split = database.lastPrepareMs();
                    const uint64_t geometryBytes = renderer->geometry().stats().bytesUploaded;
                    const uint64_t textureBytes = renderer->textureUploadBytes();
                    const auto [groups, batched] = database.lastBatches();
                    const auto& phases = database.lastRenderPhaseMs();
                    members.emplace_back("renderJointsMs", json::Value::makeNumber(phases[0]));
                    members.emplace_back("renderScenePrepareMs", json::Value::makeNumber(phases[1]));
                    members.emplace_back("renderReflectionsMs", json::Value::makeNumber(phases[2]));
                    members.emplace_back("reflectionPrepareMs", json::Value::makeNumber(database.lastReflectionMs()[0]));
                    members.emplace_back("reflectionEncodeMs", json::Value::makeNumber(database.lastReflectionMs()[1]));
                    members.emplace_back("reflectionItems", json::Value::makeNumber(double(database.lastReflectionItems())));
                    members.emplace_back("prepareMatrixMs", json::Value::makeNumber(split[0]));
                    members.emplace_back("prepareProjectMs", json::Value::makeNumber(split[1]));
                    members.emplace_back("prepareBatchMs", json::Value::makeNumber(split[2]));
                    members.emplace_back("prepareOtherMs", json::Value::makeNumber(split[3]));
                    members.emplace_back("drawItems", json::Value::makeNumber(double(database.drawn().size())));
                    members.emplace_back("batchGroups", json::Value::makeNumber(double(groups)));
                    members.emplace_back("batchMembers", json::Value::makeNumber(double(batched)));
                    members.emplace_back("geometryUploadBytes", json::Value::makeNumber(double(geometryBytes - lastGeometryBytes)));
                    members.emplace_back("textureUploadBytes", json::Value::makeNumber(double(textureBytes - lastTextureBytes)));
                    lastGeometryBytes = geometryBytes;
                    lastTextureBytes = textureBytes;
                }
                sample = json::Value::makeObject(std::move(members));
            }
            if (gpuTiming) {
                // Resolved render-pass GPU time: excludes queue wait, final swapchain blit and present.
                const uint64_t samples = renderer->gpuSamples();
                const auto segments = renderer->lastGpuSegments();
                auto members = sample.members();
                members.emplace_back("gpuTiming", json::Value::makeObject({
                    {"enabled", json::Value::makeBool(true)},
                    {"supported", json::Value::makeBool(context->hasTimestampQuery())},
                    {"samples", json::Value::makeNumber(double(samples))},
                    {"fresh", json::Value::makeBool(samples > previousGpuSamples)},
                    {"elapsedMs", samples ? json::Value::makeNumber(renderer->lastGpuMs()) : json::Value::makeNull()},
                    {"segmentsMs", samples ? json::Value::makeArray({json::Value::makeNumber(segments[0]), json::Value::makeNumber(segments[1]),
                        json::Value::makeNumber(segments[2]), json::Value::makeNumber(segments[3]), json::Value::makeNumber(segments[4]),
                        json::Value::makeNumber(segments[5])}) : json::Value::makeNull()}}));
                previousGpuSamples = samples;
                sample = json::Value::makeObject(std::move(members));
            }
            if (instructionsFrameBegin >= 0) {
                // The span cpuFrameCpuMs covers (ticks and frame, the swap call left out), in thousands.
                auto members = sample.members();
                members.emplace_back("cpuFrameKInstructions", json::Value::makeNumber(std::round(
                    (updateInstructions + threadInstructions() - instructionsFrameBegin - presentInstructions) / 1e3)));
                sample = json::Value::makeObject(std::move(members));
            }
            if (cyclesFrameBegin >= 0) {
                auto members = sample.members();
                members.emplace_back("cpuFrameKCycles", json::Value::makeNumber(std::round(
                    (updateCycles + threadCycles() - cyclesFrameBegin - presentCycles) / 1e3)));
                sample = json::Value::makeObject(std::move(members));
            }
            if (renderThread) {
                auto members = sample.members();
                if (renderThreadCpuMs >= 0)  // the previous frame's encode and submit, now off the game thread
                    members.emplace_back("renderThreadCpuMs", json::Value::makeNumber(renderThreadCpuMs));
                members.emplace_back("renderThreadFallbacks", json::Value::makeNumber(double(renderFallbacks)));
                sample = json::Value::makeObject(std::move(members));
            }
            if (gpuThread && gpuThreadCpuMs >= 0) {
                // The previous frame's submit, acquire, blit and present, now off the game thread.
                auto members = sample.members();
                members.emplace_back("gpuThreadCpuMs", json::Value::makeNumber(gpuThreadCpuMs));
                sample = json::Value::makeObject(std::move(members));
            }
            if (spans) {
                auto members = sample.members();
                members.emplace_back("gameSpans", std::move(*frameSpans));
                sample = json::Value::makeObject(std::move(members));
            }
            {
                auto members = sample.members();
                const auto& cull = ProjectedCull::cpuTiming;
                members.emplace_back("projectedCullCalls", json::Value::makeNumber(updateCullCalls + cull.calls - cullBegin.calls));
                members.emplace_back("projectedCullCpuMs", cpuFrameBegin >= 0 && cull.clock && cull.available
                    ? json::Value::makeNumber(updateCullCpuMs + cull.ms - cullBegin.ms) : json::Value::makeNull());
                sample = json::Value::makeObject(std::move(members));
            }
            {
                // Same tick+frame CPU window as cpuFrameCpuMs; event-listener callbacks are excluded.
                auto members = sample.members();
                const auto& mixer = animation::AnimationMixer::cpuTiming;
                members.emplace_back("animationMixerCalls", json::Value::makeNumber(updateMixerCalls + mixer.calls - mixerBegin.calls));
                members.emplace_back("animationMixerCpuMs", cpuFrameBegin >= 0 && mixer.clock && mixer.available
                    ? json::Value::makeNumber(updateMixerCpuMs + mixer.ms - mixerBegin.ms) : json::Value::makeNull());
                sample = json::Value::makeObject(std::move(members));
            }
            {
                const auto world = Object3D::matrixEvaluations();
                const auto joins = Object3D::joinDependencyVisits();
                const auto boundaries = Object3D::gpuBoundaryVisits();
                const auto projections = Object3D::gpuProjectionVisits_;
                const auto validations = Object3D::gpuValidationVisits_;
                const auto maintenance = Object3D::gpuMaintenanceVisits_;
                auto members = sample.members();
                members.emplace_back("worldVisitCounterVersion", json::Value::makeNumber(2));
                members.emplace_back("worldUpdateVisits", json::Value::makeNumber(double(world - lastWorldVisits)));
                members.emplace_back("joinDependencyVisits", json::Value::makeNumber(double(joins - lastJoinVisits)));
                members.emplace_back("gpuBoundaryVisits", json::Value::makeNumber(double(boundaries - lastBoundaryVisits)));
                members.emplace_back("gpuProjectionBoundaryVisits", json::Value::makeNumber(double(projections - lastProjectionVisits)));
                members.emplace_back("gpuPlanValidationVisits", json::Value::makeNumber(double(validations - lastValidationVisits)));
                members.emplace_back("gpuPlanMaintenanceVisits", json::Value::makeNumber(double(maintenance - lastMaintenanceVisits)));
                members.emplace_back("worldWorkVisitsTotal", json::Value::makeNumber(double(
                    world - lastWorldVisits + joins - lastJoinVisits + boundaries - lastBoundaryVisits +
                    projections - lastProjectionVisits + validations - lastValidationVisits + maintenance - lastMaintenanceVisits)));
                sample = json::Value::makeObject(std::move(members));
                lastWorldVisits = world; lastJoinVisits = joins; lastBoundaryVisits = boundaries;
                lastProjectionVisits = projections; lastValidationVisits = validations; lastMaintenanceVisits = maintenance;
            }
            ++measuredFrames;
            if (mainThreadCpuEnabled) {
                // Cumulative whole main-thread CPU at this completed render; UI/GPU helper threads are excluded.
                const double cpuMs = threadCpuMs();
                auto members = sample.members();
                members.emplace_back("mainThreadCpuMs", std::isfinite(cpuMs) && cpuMs > 0 ? json::Value::makeNumber(cpuMs) : json::Value::makeNull());
                members.emplace_back("measuredFrames", json::Value::makeNumber(double(measuredFrames)));
                sample = json::Value::makeObject(std::move(members));
            }
            std::printf("TN_PLAYER_FRAME:%s\n", json::stringify(sample).c_str());
            std::fflush(stdout);
            previousCrossings = (game.bridgeCalls ? game.bridgeCalls() : 0);
            updateMs = 0;
            updateCpuMs = 0;
            updateMixerCpuMs = 0;
            updateMixerCalls = 0;
            updateCullCpuMs = 0;
            updateCullCalls = 0;
            updateInstructions = 0;
            updateCycles = 0;
            updateTicks = 0;
        }
    };
    return 0;
}

int Session::step() {
    if (!pumpEvents(window, game)) return 0;
    placement.sweepIfDue();

#if defined(__ANDROID__)
    if (window.resumeSurface) {
        auto* native = static_cast<ANativeWindow*>(SDL_GetPointerProperty(
            SDL_GetWindowProperties(window.handle), SDL_PROP_WINDOW_ANDROID_WINDOW_POINTER, nullptr));
        if (!native || ANativeWindow_getWidth(native) <= 0 || ANativeWindow_getHeight(native) <= 0 ||
            !context->rebuildSurface(native, mystral::webgpu::Context::PLATFORM_ANDROID) ||
            !context->configureSurface(ANativeWindow_getWidth(native), ANativeWindow_getHeight(native), kSurfaceVsync)) {
            std::printf("TN_PLAYER_ANDROID_SURFACE_RECREATE_FAILED\n");
            return -2;
        }
        window.width = context->getSurfaceWidth();
        window.height = context->getSurfaceHeight();
        presenter = std::make_unique<Presenter>(*context);
        renderer->setSize(window.width, window.height);
        window.resumeSurface = false;
    }
#endif
    if (game.uiFrame) game.uiFrame();
    // An advance may render several streaming frames; each tick gets its own admission cap.
    mailbox->poll(*endpoint);
    if (endpoint->automaticRenderHeld() && !endpoint->liveClock()) return viewFailed ? -1 : 1;
    // A launched runner holds the game's boot until its first request, and that request races this
    // loop: the host reaches its first step in milliseconds, the runner polls every 40 ms. A frame
    // presented before the request is a loader frame, so how many there were, which settings the
    // first present carried and where the render samples began all depended on who won. Nothing is
    // drawn or ticked until the runner attaches (or the grace runs out), which makes the first
    // frame the first frame of the attached run. A run without a runner never takes this branch.
    if (runner && !mailbox->attached()) {
        const auto now = std::chrono::steady_clock::now();
        if (!attachWaitStart) attachWaitStart = now;
        if (std::chrono::duration<double, std::milli>(now - *attachWaitStart).count() < kRunnerAttachGraceMs) {
            SDL_Delay(1);  // a host-loop wait for the runner, not a GPU or async wait
            return 1;
        }
    }
    // Without a runner nothing drives host.step, and the game would re-render one frozen tick:
    // the clock follows real time instead, as the web loop follows requestAnimationFrame.
    if (!runner || endpoint->liveClock()) {
        nowMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - freeRunStart).count();
        for (uint32_t steps = clock.advance(nowMs); steps > 0 && game.update; --steps) {
            if (runner) ++drivenTicks;
            update(kTickStep);
        }
    }
    if (endpoint->automaticRenderHeld()) return viewFailed ? -1 : 1;
    if (!refreshView())
        return -1;
    // A window's swap/present paces this loop; headless there is no presentation, so draw once per
    // simulation tick instead of as fast as the CPU can submit. Unpaced headless frames pile up in
    // the queue ahead of the next render-target readback and make it wait behind all of them.
    if (presenter || !hasRendered || tick() != lastRenderedTick) {
        renderFrame();
    } else {
        renderer->poll();
        events.drain();
    }
    return viewFailed ? -1 : 1;
}

Session::~Session() {
    animation::AnimationMixer::cpuTiming = {};
    ProjectedCull::cpuTiming = {};
#if defined(__APPLE__)
    if (window.metalView)
        SDL_Metal_DestroyView(window.metalView);
#endif
#if defined(__ANDROID__)
    if (watching) SDL_RemoveEventWatch(lifecycleWatch, &window);
    presenter.reset();
    if (context) context->releaseSurface();
#endif
    waitRenderThread(false);  // the frame in flight reads the renderer and the game's resources
    renderThread.reset();
    if (initialized && game.shutdown) game.shutdown();
    renderer.reset();
    presenter.reset();
    context.reset();
    if (gpuThread) gpuThread->wait();  // an overlay upload reads the UI frame that detaching frees
    if (game.uiDetach) game.uiDetach();
    if (window.handle)
        SDL_DestroyWindow(window.handle);
    SDL_QuitSubSystem(SDL_INIT_VIDEO);
}

Session* open(const Game& game, int& status) {
    auto session = std::make_unique<Session>(game);
    status = session->initialize();
    return status == 0 ? session.release() : nullptr;
}

int step(Session& session) { return session.step(); }
void close(Session* session) { delete session; }

int run(const Game& game) {
    int status = 0;
    std::unique_ptr<Session, decltype(&close)> session(open(game, status), close);
    if (!session) return status;
    while ((status = step(*session)) > 0) {}
    return -status;
}

}  // namespace tn::engine::player
