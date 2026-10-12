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

#include <chrono>
#include <ctime>
#include <array>
#include <cstring>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <optional>
#include <string>
#include <stdexcept>
#include <vector>

#include "engine/inspect/endpoint.h"
#include "engine/player/mailbox.h"
#include "engine/renderer/presentation.h"
#include "engine/renderer/render_database.h"
#include "engine/world/loop/fixed_step.h"
#include "mystral/webgpu/context.h"
#include "mystral/webgpu/presentation.h"
#include "mystral/webgpu_compat.h"

using namespace tn::engine;

namespace tn::engine::player {

namespace {
// Same numeric ids as core's render spans and GAME_SPANS; the host owns the wall clock.
constexpr const char* kGameSpanNames[] = {
    "compute", "beforeRender", "sceneUpdate", "reconcile", "clustered", "lod", "cull",
    "mainPass", "shadowPass", "reflectionPass", "nestedPass", "projectObject", "sort", "draw",
    "terrainBlock", "terrainSeam", "input", "scheduler", "plugins", "sceneCallbacks", "entities", "afterPhysics", "mixer",
    "stride", "blend", "transport", "publish", "playtest", "hostUpdate", "hostFrame", "ui",
    "gc", "view", "loop", "state", "contacts", "transitions", "objectGraph", "physicsStep",
    "physicsRead", "physicsApply", "characterMove", "animationPlay", "inputVector", "graphVisit"};
constexpr size_t kGameSpanCount = std::size(kGameSpanNames);
// The host-owned spans (GAME_SPANS leaves them out); native-engine-game-spans.spec.ts pins these to the names.
constexpr int kHostUpdateSpan = 28;
constexpr int kHostFrameSpan = 29;
constexpr int kGcSpan = 31;
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
 * nobody asked for. Unset, every default is unchanged.
 */
struct SurfaceConfig {
    uint32_t width = kWidth, height = kHeight;
    bool vsync = kSurfaceVsync;
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
    window.handle = SDL_CreateWindow("ThreeNative native engine", static_cast<int>(surfaceConfig().width),
                                     static_cast<int>(surfaceConfig().height), flags);
    if (!window.handle) {
        std::printf("[Playtest] SDL_CreateWindow failed: %s\n", SDL_GetError());
        return false;
    }
    int width = 0, height = 0;
    SDL_GetWindowSize(window.handle, &width, &height);
    if (width <= 0 || height <= 0)
        return false;
    window.width = static_cast<uint32_t>(width);
    window.height = static_cast<uint32_t>(height);
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
        // coordinates.
        if (game.uiPointer && window.width > 0 && window.height > 0 &&
            (event.type == SDL_EVENT_MOUSE_BUTTON_DOWN || event.type == SDL_EVENT_MOUSE_BUTTON_UP ||
             event.type == SDL_EVENT_MOUSE_MOTION)) {
            const bool motion = event.type == SDL_EVENT_MOUSE_MOTION;
            const float x = motion ? event.motion.x : event.button.x, y = motion ? event.motion.y : event.button.y;
            const SDL_MouseButtonFlags held = SDL_GetMouseState(nullptr, nullptr);
            int buttons = (held & SDL_BUTTON_LMASK ? 1 : 0) | (held & SDL_BUTTON_RMASK ? 2 : 0) | (held & SDL_BUTTON_MMASK ? 4 : 0);
            const char* type = motion ? "pointermove" : event.type == SDL_EVENT_MOUSE_BUTTON_DOWN ? "pointerdown" : "pointerup";
            game.uiPointer(type, x / float(window.width), y / float(window.height), buttons);
            continue;
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

double threadCpuMs() {
#if defined(__linux__)
    timespec now{};
    if (clock_gettime(CLOCK_THREAD_CPUTIME_ID, &now) == 0) return double(now.tv_sec) * 1e3 + double(now.tv_nsec) / 1e6;
#endif
    return -1;
}

json::Value frameTiming(double gameMs, double renderMs, double cpuMs, double frameMs, uint64_t bridgeCalls,
                        uint64_t tick, uint64_t updates, double gameCpuMs, double cpuFrameCpuMs) {
    using V = json::Value;
    std::vector<std::pair<std::string, V>> members{
        {"gameJsMs", V::makeNumber(gameMs)}, {"renderMs", V::makeNumber(renderMs)},
        {"cpuFrameMs", V::makeNumber(cpuMs)}, {"frameMs", V::makeNumber(frameMs)},
        {"bridgeCalls", V::makeNumber(double(bridgeCalls))},
        {"tick", V::makeNumber(double(tick))}, {"updates", V::makeNumber(double(updates))}};
    if (gameCpuMs >= 0) members.emplace_back("gameJsCpuMs", V::makeNumber(gameCpuMs));
    if (cpuFrameCpuMs >= 0) members.emplace_back("cpuFrameCpuMs", V::makeNumber(cpuFrameCpuMs));
    return V::makeObject(std::move(members));
}

struct Session {
    Game game;
    Window window;
    std::unique_ptr<mystral::webgpu::Context> context;
    std::unique_ptr<Presenter> presenter;
    EventQueue events;
    std::unique_ptr<Renderer> renderer;
    world::FixedStepClock clock{kTickStep, 5};
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
    bool spans = gameSpan(-1, 0) == 1;
    uint64_t measuredFrames = 0, previousCrossings = 0, updateTicks = 0;
    double updateMs = 0, readyMs = 0, updateCpuMs = 0;
    void update(double dt) {
        const auto begin = metrics ? std::chrono::steady_clock::now() : std::chrono::steady_clock::time_point{};
        const double cpuBegin = metrics ? threadCpuMs() : -1;
        if (spans) gameSpan(kHostUpdateSpan, 0);
        if (game.update) game.update(dt);
        if (spans) gameSpan(kHostUpdateSpan, 1);
        if (metrics) updateMs += std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - begin).count();
        if (cpuBegin >= 0) updateCpuMs += threadCpuMs() - cpuBegin;
        if (metrics) ++updateTicks;
    }
#if defined(__ANDROID__)
    bool watching = false;
#endif
    explicit Session(const Game& source) : game(source), scene(game.scene), camera(game.camera) {
        // Benchmarks need one rendered sample per driven simulation tick, not a batch of 600 updates.
        if (metrics) game.renderEachTick = true;
        if (spans) gameSpans = {};
    }
    int initialize();
    int step();
    ~Session();
};

int Session::initialize() {
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
    renderer->setSize(width, height);
    renderer->setOutput(OutputState{shader::ToneMapping::ACESFilmic, 1, true});
    startupStage("renderer-ready");
    initialized = true;
    startupStage("game-initialize-begin");
    if (game.initialize)
        game.initialize(*renderer);
    startupStage("game-initialize-ready");

    clock.start(0);
    inspect::Host host;
    host.scene = game.scene;
    host.gameRuntime = game.gameRuntime;
    host.observe = game.observe;
    host.tick = [this] { return clock.tick(); };
    host.step = [this] {
        // One fixed update per driven tick, so the reported clock is the engine's own.
        nowMs += 1000.0 * kTickStep;
        clock.advance(nowMs);
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
        return game.resource ? game.resource(id, clock.tick()) : json::Value::makeNull();
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
    previousCrossings = (game.bridgeCalls ? game.bridgeCalls() : 0);
    renderFrame = [this] {
        const auto frameBegin = metrics ? std::chrono::steady_clock::now() : std::chrono::steady_clock::time_point{};
        const double cpuFrameBegin = metrics ? threadCpuMs() : -1;
        if (spans) gameSpan(kHostFrameSpan, 0);
        double presentMs = 0, presentCpuMs = 0, gameCpuMs = -1;
        std::optional<json::Value> frameSpans;
        const auto elapsed = [](auto begin) {
            return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - begin).count();
        };
        if (firstFrame) startupStage("first-render-begin");
        if (spans) gameSpan(kGcSpan, 0);
        if (game.afterRender)  // after the previous frame; between frames, never inside one
            game.afterRender();
        if (spans) gameSpan(kGcSpan, 1);
        if (!refreshView()) { if (spans) gameSpan(kHostFrameSpan, 1); return; }

        if (presenter && (presenter->width() != window.width || presenter->height() != window.height)) {
            presenter->resize(window.width, window.height);
            renderer->setSize(presenter->width(), presenter->height());
            if (game.uiResize) game.uiResize(int(window.width), int(window.height));
        }
        // Nothing is drawn until the game publishes its view, as a page's canvas stays blank while it loads.
        if (scene == nullptr || camera == nullptr) {
            if (game.frameWithoutView) game.frameWithoutView();
            if (spans) { gameSpan(kHostFrameSpan, 1); gameSpanTiming(0); }
            renderer->poll();
            events.drain();
            return;
        }
        if (game.beforeRender) game.beforeRender(*renderer, database);
        // Frame callbacks can replace the published view and release its previous owners.
        if (!refreshView() || scene == nullptr || camera == nullptr) { if (spans) gameSpan(kHostFrameSpan, 1); return; }
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
        const auto renderBegin = metrics ? std::chrono::steady_clock::now() : std::chrono::steady_clock::time_point{};
        database.render(*renderer, *scene, *camera, game.clear ? game.clear() : std::array<double, 4>{0.05, 0.06, 0.09, 1});
        const double renderMs = metrics ? elapsed(renderBegin) : 0;
        for (const std::string& diagnostic : database.diagnostics())
            std::printf("[Playtest] %s\n", diagnostic.c_str());
        for (const std::string& diagnostic : renderer->diagnostics())
            std::printf("[Playtest] %s\n", diagnostic.c_str());
        if (presenter) {
            Presenter::Frame target;
            if (firstFrame) startupStage("first-acquire-begin");
            // The page's newest frame goes over the world in the same blit (PRD-554).
            if (game.uiDraw) game.uiDraw(*renderer);
            const auto presentBegin = metrics ? std::chrono::steady_clock::now() : std::chrono::steady_clock::time_point{};
            const double presentCpuBegin = metrics ? threadCpuMs() : -1;
            if (presenter->begin(target)) {
                // The window carries the very frame the render database just built.
                renderer->blitTo(context->getQueue(), target.color,
                                static_cast<WGPUTextureFormat>(context->getPreferredFormat()));
                presenter->present();
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
            if (presentCpuBegin >= 0) presentCpuMs = threadCpuMs() - presentCpuBegin;
        }

        // A screenshot answer is a real frame of this loop, so it is read back from the renderer the
        // moment the mailbox asks for one. The readback lands a few frames later.
        if (mailbox->screenshotRequested() && !readbackInFlight) {
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
        for (int i = 0; i < 100000 && (readbackInFlight || events.pending()); ++i) {
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
                                      clock.tick(), updateTicks, gameCpuMs,
                                      cpuFrameBegin >= 0 ? updateCpuMs + threadCpuMs() - cpuFrameBegin - presentCpuMs : -1);
            if (spans) {
                auto members = sample.members();
                members.emplace_back("gameSpans", std::move(*frameSpans));
                sample = json::Value::makeObject(std::move(members));
            }
            ++measuredFrames;
            std::printf("TN_PLAYER_FRAME:%s\n", json::stringify(sample).c_str());
            std::fflush(stdout);
            previousCrossings = (game.bridgeCalls ? game.bridgeCalls() : 0);
            updateMs = 0;
            updateCpuMs = 0;
            updateTicks = 0;
        }
    };
    return 0;
}

int Session::step() {
    if (!pumpEvents(window, game)) return 0;

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
    if (!runner) {
        nowMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - freeRunStart).count();
        for (uint32_t steps = clock.advance(nowMs); steps > 0 && game.update; --steps)
            update(kTickStep);
    }
    if (!refreshView())
        return -1;
    renderFrame();
    return viewFailed ? -1 : 1;
}

Session::~Session() {
#if defined(__APPLE__)
    if (window.metalView)
        SDL_Metal_DestroyView(window.metalView);
#endif
#if defined(__ANDROID__)
    if (watching) SDL_RemoveEventWatch(lifecycleWatch, &window);
    presenter.reset();
    if (context) context->releaseSurface();
#endif
    if (initialized && game.shutdown) game.shutdown();
    renderer.reset();
    presenter.reset();
    context.reset();
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
