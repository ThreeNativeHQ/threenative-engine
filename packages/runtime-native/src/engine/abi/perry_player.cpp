// Perry owns the promise queue; this adapter hands one frame at a time to the shared player.
#include "engine/abi/abi_internal.h"
#include "engine/inspect/endpoint.h"
#include "engine/player/run.h"
#include "engine/player/mailbox.h"
#include "engine/renderer/render_database.h"
#include "mystral/platform/ui_overlay.h"
#include <filesystem>
#include <SDL3/SDL.h>
#include <chrono>
#include <cstdlib>
#include <memory>
#include <limits>
#include <set>

extern "C" void tnp_player_update(double);
extern "C" void tnp_player_frame(double);
extern "C" double tnp_player_observe(double, double);

namespace {
using namespace tn::engine;
std::unique_ptr<player::Session, decltype(&player::close)> session(nullptr, player::close);
inspect::Endpoint* endpoint = nullptr;
std::set<std::string> held;
std::string codes, failure, uiMessage;
std::string adapterInfo;
int uiWidth = 1280, uiHeight = 720;
uint32_t drawCalls = 0;
uint64_t triangles = 0;
std::shared_ptr<Object3D> scene, camera;
std::array<double, 4> clear{0, 0, 0, 1};
OutputState output;
std::chrono::steady_clock::time_point frameStarted;
double frameClockMs = 0;
int64_t fail(const char* message) { failure = message; return reinterpret_cast<int64_t>(failure.c_str()); }
}

extern "C" int32_t js_tnp_player_open() try {
    if (session) return 1;
    player::Game game;
    game.name = "perry-game";
    game.gameRuntime = "perry";
    // SDL names the executable's directory, the same ui/ layout as the V8 packaged player.
    const auto uiRoot = std::filesystem::path(SDL_GetBasePath()) / "ui";
    if (std::filesystem::is_directory(uiRoot)) {
        const char* renderer = std::getenv("TN_UI_RENDERER");
        const bool cssUi = renderer && std::string(renderer) == "native-css";
#if defined(__linux__) && !defined(__ANDROID__)
        if (!cssUi) {
            SDL_SetHintWithPriority(SDL_HINT_VIDEO_DRIVER, "x11", SDL_HINT_OVERRIDE);
            setenv("GDK_BACKEND", "x11", 1);
        }
#endif
        game.uiAttach = [root = uiRoot.string(), cssUi](SDL_Window* window) {
            mystral::platform::setUiOverlayWindow(window);
            if (window) SDL_GetWindowSizeInPixels(window, &uiWidth, &uiHeight);
            const bool attached = cssUi ? mystral::platform::attachDesktopCssUi(root)
                                        : mystral::platform::attachDesktopUiOverlay(root);
            if (!attached) std::fprintf(stderr, "TN_UI_LOAD_FAILED: %s in %s\n",
                cssUi ? "native-css" : "web", root.c_str());
            return attached;
        };
        game.uiFrame = [] { mystral::platform::pumpUiOverlay(); };
        game.uiDraw = [](Renderer& renderer) {
            mystral::platform::UiOverlayFrame ui;
            if (mystral::platform::uiOverlayFrame(ui))
                renderer.setOverlay(ui.pixels, ui.width, ui.height, ui.counter, ui.stride, !ui.isRgba);
        };
        game.uiPointer = [](const char* type, float x, float y, int buttons) {
            return mystral::platform::uiOverlayAttached() &&
                mystral::platform::uiOverlayRoutePointer(type, x, y, buttons, 1);
        };
        game.uiResize = [](int width, int height) {
            uiWidth = width; uiHeight = height;
            mystral::platform::uiOverlaySetSize(width, height);
        };
        game.uiDetach = [] {
            mystral::platform::detachDesktopUiOverlay();
            mystral::platform::setUiOverlayWindow(nullptr);
        };
    }
    game.bridgeCalls = [] { return tn::abi::crossings(); };
    game.attach = [](inspect::Endpoint& attached) { endpoint = &attached; };
    game.update = [](double dt) {
        for (const auto& event : endpoint->takeInput()) {
            if (event.type.starts_with("pointer") && mystral::platform::uiOverlayAttached() &&
                mystral::platform::uiOverlayRoutePointer(event.type.c_str(), float(event.x / uiWidth), float(event.y / uiHeight),
                    event.buttons, event.pointerId)) continue;
            if ((event.type == "keydown" || event.type == "keyup") && mystral::platform::uiOverlayAttached() &&
                mystral::platform::uiOverlayRouteKey(event.key.c_str(), event.type == "keydown", held.count("ShiftLeft") || held.count("ShiftRight"))) continue;
            if (event.type == "keydown") held.insert(event.code);
            else if (event.type == "keyup") held.erase(event.code);
        }
        // Real SDL keys and injected keys share the code spelling used by core's input map.
        int count = 0;
        const bool* keys = SDL_GetKeyboardState(&count);
        std::set<std::string> all = held;
        for (int i = 0; keys && i < count; ++i) {
            if (!keys[i]) continue;
            std::string name = SDL_GetScancodeName(static_cast<SDL_Scancode>(i));
            if (name.size() == 1 && name[0] >= 'A' && name[0] <= 'Z') name = "Key" + name;
            else if (name == "Up" || name == "Down" || name == "Left" || name == "Right") name = "Arrow" + name;
            else if (name == "Return") name = "Enter";
            else if (name == "Left Shift") name = "ShiftLeft";
            else if (name == "Right Shift") name = "ShiftRight";
            all.insert(name);
        }
        codes.clear();
        for (const auto& code : all) { if (!codes.empty()) codes += '\n'; codes += code; }
        tnp_player_update(dt);
    };
    const auto frame = [] {
        frameStarted = std::chrono::steady_clock::now();
        tnp_player_frame(frameClockMs);
    };
    game.frameWithoutView = frame;
    game.frameComplete = [](Renderer& renderer, const std::vector<std::string>&) {
        drawCalls = renderer.lastFrame().draws;
        triangles = renderer.lastFrame().triangles;
        frameClockMs += std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - frameStarted).count();
    };

    game.view = [](Object3D*& world, Camera*& view, std::string&) {
        world = scene.get();
        view = static_cast<Camera*>(camera.get());
        return world && view ? 1 : 0;
    };
    game.clear = [] { return clear; };
    game.beforeRender = [frame, applied = shader::graph::Node{}](Renderer& renderer, RenderDatabase&) mutable {
        frame();
        renderer.setOutput(output);
        const auto& graph = tn::abi::perryPostGraph();
        if (graph != applied) { renderer.setPostGraph(graph); applied = graph; }
    };
    game.observe = [](const std::string& method, const json::Value* argument, json::Value& result, std::string& error) {
        const std::string text = argument ? json::stringify(*argument) : "";
        const auto pointer = static_cast<int64_t>(tnp_player_observe(
            double(reinterpret_cast<uintptr_t>(method.c_str())), double(reinterpret_cast<uintptr_t>(text.c_str()))));
        if (!pointer) { error = inspect::kStillSettling; return false; }
        const auto* answer = reinterpret_cast<const char*>(pointer);
        json::Value value;
        json::Error parseError;
        const bool valid = json::parse(answer, value, parseError);
        if (!valid) error = "TN_PERRY_OBSERVATION_INVALID";
        std::free(reinterpret_cast<void*>(pointer));
        if (!valid) return false;
        if (value.find("fallback")) return false;
        if (const auto* refusal = value.find("error")) { error = refusal->string(); return false; }
        if (const auto* reply = value.find("result")) { result = *reply; return true; }
        error = "TN_PERRY_OBSERVATION_INVALID";
        return false;
    };
    int status = 0;
    frameClockMs = 0;
    drawCalls = 0; triangles = 0;
    session.reset(player::open(game, status));
    return session ? 0 : status;
} catch (const std::exception& error) {
    endpoint = nullptr;
    std::fprintf(stderr, "TN_PERRY_PLAYER_FAILED:%s\n", error.what());
    return 1;
}

extern "C" int32_t js_tnp_player_step() {
    if (!session) return -1;
    try { return player::step(*session); }
    catch (const std::exception& error) { std::fprintf(stderr, "TN_PERRY_PLAYER_FAILED:%s\n", error.what()); return -1; }
}
extern "C" void js_tnp_player_close() {
    session.reset(); endpoint = nullptr; scene.reset(); camera.reset(); held.clear(); codes.clear(); uiMessage.clear();
    drawCalls = 0; triangles = 0; adapterInfo.clear();
    js_tnp_set_post(0, 0);
}
extern "C" int32_t js_tnp_player_running() { return session ? 1 : 0; }
extern "C" int32_t js_tnp_player_runner() { return !player::Mailbox::rootFromEnvironment().empty(); }
extern "C" int64_t js_tnp_player_codes() { return reinterpret_cast<int64_t>(codes.c_str()); }
extern "C" int32_t js_tnp_player_ui_attached() { return mystral::platform::uiOverlayAttached(); }
extern "C" int32_t js_tnp_player_ui_post(int64_t text) {
    return text && mystral::platform::postUiMessage(reinterpret_cast<const char*>(text));
}
extern "C" int64_t js_tnp_player_ui_take() {
    while (mystral::platform::takeUiMessage(uiMessage)) {
        if (!mystral::platform::applyUiHitRegionsFrame(uiMessage))
            return reinterpret_cast<int64_t>(uiMessage.c_str());
    }
    return 0;
}
extern "C" double js_tnp_player_render_info(int32_t field) {
    if (field == 0) return drawCalls;
    if (field == 1) return static_cast<double>(triangles);
    return std::numeric_limits<double>::quiet_NaN();
}
extern "C" int64_t js_tnp_player_adapter_info() {
    if (adapterInfo.empty()) {
        std::vector<std::pair<std::string, json::Value>> fields;
        for (const auto& [name, value] : player::adapterIdentity())
            fields.emplace_back(name, json::Value::makeString(value));
        adapterInfo = json::stringify(fields.empty() ? json::Value::makeNull() : json::Value::makeObject(std::move(fields)));
    }
    return reinterpret_cast<int64_t>(adapterInfo.c_str());
}
extern "C" int32_t js_tnp_player_capture(int32_t on) {
    int count = 0;
    SDL_Window** windows = SDL_GetWindows(&count);
    SDL_Window* window = windows && count ? windows[0] : nullptr;
    SDL_free(windows);
    return window && SDL_SetWindowRelativeMouseMode(window, on != 0) ? 0 : 1;
}
extern "C" int64_t js_tnp_player_publish(int64_t sceneHandle, int64_t cameraHandle, double tone,
                                         double exposure, int32_t srgb, int64_t clearPointer) {
    auto* world = tn::abi::objectOf(*reinterpret_cast<tn_handle_t*>(sceneHandle));
    auto* view = tn::abi::objectOf(*reinterpret_cast<tn_handle_t*>(cameraHandle));
    std::string refusal;
    const auto state = outputStateOf(tone, exposure, srgb ? "srgb" : "srgb-linear", refusal);
    if (!world || !view || !state) return fail("TN_PERRY_PLAYER_VIEW");
    scene = std::static_pointer_cast<Object3D>(world->ptr);
    camera = std::static_pointer_cast<Object3D>(view->ptr);
    output = *state;
    const auto* values = reinterpret_cast<const double*>(clearPointer);
    std::copy(values, values + 4, clear.begin());
    return 0;
}
