#pragma once

#include <array>
#include <cstdint>
#include <functional>
#include <string>
#include <vector>

#include "engine/foundation/json.h"
#include "engine/scene/object3d.h"

struct SDL_Window;

namespace tn::engine {

class Camera;
class Renderer;
class RenderDatabase;

namespace inspect {
class Endpoint;
}  // namespace inspect

namespace player {

/**
 * One desktop game for the native-engine player loop (PRD-529, PRD-531 phase 3): the world, the
 * camera, the per-tick update and the resources the inspect endpoint samples. The loop owns the SDL
 * window, the renderer, the mailbox and screenshots; a game owns only what it draws, so the JS-free
 * C++ demo and a game bundle on V8 share the same window, loop, mailbox and render path.
 */
struct Game {
    std::string name = "inspect-demo";
    Object3D* scene = nullptr;
    Camera* camera = nullptr;
    /** The game runtime named in `describe` and `sample.profile`: "cpp" for a built-in game, "v8"
     *  for a game bundle on the V8 adapter. */
    std::string gameRuntime = "cpp";
    /** Shared C ABI call counter; absent on a C++ game with no runtime bridge. */
    std::function<uint64_t()> bridgeCalls;
    bool shadowMapEnabled = false;
    /** Streaming proofs render every driven tick, including ticks in a batched advance request. */
    bool renderEachTick = false;
    std::function<void(Renderer&)> initialize;
    /** Before each frame is drawn: the game applies the renderer settings it changed since the last. */
    std::function<void(Renderer&, RenderDatabase&)> beforeRender;
    std::function<void(Renderer&, const std::vector<std::string>&)> frameComplete;
    /** Each loop pass before the game publishes its view: its frame callbacks run, as a page's
     *  requestAnimationFrame fires while nothing is drawn yet (a loader that adds in slices per frame,
     *  core's describe() waiting for the scene the game enters). */
    std::function<void()> frameWithoutView;
    /**
     * three's overlay render (core's canvas layer). overlay: 0 for none this frame, 1 drawn over the world frame, 2
     * drawn alone (a held loader frame: no world this frame, published or not). drawOverlay: after the world frame,
     * the overlay composited over the renderer's output frame (Renderer::overlayRenderer), before the present.
     */
    std::function<int()> overlay;
    std::function<void(Renderer&)> drawOverlay;
    /**
     * PRD-554: a UI the game runtime shows over the frame (the V8 player's overlay seam). Every hook is
     * optional; a game with no UI sets none, and this loop links no UI code.
     * - uiAttach: once the window exists (null when headless); false stops the player by name.
     * - uiFrame: at the top of each loop pass, the page's queued frames to the game.
     * - uiDraw: before each present, the page's newest frame handed to the renderer (Renderer::setOverlay).
     * - uiPointer: a window mouse event in 0..1, true when the UI took it.
     * - uiResize, uiDetach: the window's new size, and teardown.
     */
    std::function<bool(SDL_Window* window)> uiAttach;
    std::function<void()> uiFrame;
    std::function<void(Renderer& renderer)> uiDraw;
    std::function<bool(const char* type, float x, float y, int buttons)> uiPointer;
    std::function<void(int width, int height)> uiResize;
    std::function<void()> uiDetach;
    /**
     * PRD-613: with the render thread on, the loop hands the game a function that waits for the frame in
     * flight. A game calls it before anything it does to the renderer from outside the loop's own
     * handoff (a render target, a read-back, a compile, a post graph). Absent without a render thread.
     */
    std::function<void(std::function<void()> barrier)> setRenderBarrier;
    /** Releases game-owned GPU resources before the loop destroys its renderer. */
    std::function<void()> shutdown;
    /** One fixed tick; `dt` is the step in seconds. The loop calls it once per `advance` tick. */
    std::function<void(double dt)> update;
    /** A registered resource by id, or null. The loop answers `profile` itself; the `tick` is the
     *  simulation tick that last ran, for a state snapshot. */
    std::function<json::Value(const std::string& id, uint64_t tick)> resource;
    std::function<bool(const std::string&, const json::Value*, json::Value&, std::string&)> observe;
    /** A hook after each frame's render (the V8 adapter's callback safe point). */
    std::function<void()> afterRender;
    /** Binds the endpoint, so a game reads the input queued for each tick itself. */
    std::function<void(inspect::Endpoint& endpoint)> attach;
    /** The scene and camera to draw this frame, for a game that publishes them at run time (a V8
     *  bundle's async boot, a later `renderer.render(other, camera)`): 1 bound, 0 not published yet
     *  (the frame stays undrawn), -1 failed, with `error` set. Without it, `scene`/`camera` are fixed. */
    std::function<int(Object3D*& scene, Camera*& camera, std::string& error)> view;
    /** The frame's linear clear colour and alpha (a V8 bundle's renderer.setClearColor); without it,
     *  the built-in games' dark blue. */
    std::function<std::array<double, 4>()> clear;
};

/** The same CPU split for every host: game callbacks, database render, CPU excluding present.
 * bridgeCalls counts the shared C ABI entries since the previous rendered frame. presentCpuMs is the thread
 * CPU inside the surface present call (the legacy host reports the same field around wgpuSurfacePresent);
 * cpuFrameCpuMs excludes it. renderCpuMs is the thread CPU inside the database render call: the work the
 * facade's JS `renderer.render` defers to the host, which the bench's `render` phase adds back for this arm. */
json::Value frameTiming(double gameMs, double renderMs, double cpuMs, double frameMs, uint64_t bridgeCalls,
                        uint64_t tick = 0, uint64_t updates = 0, double gameCpuMs = -1, double cpuFrameCpuMs = -1,
                        double presentCpuMs = -1, double renderCpuMs = -1);

/** CPU time of the calling thread in ms (CLOCK_THREAD_CPUTIME_ID), or -1 off Linux/Android. One clock for
 * every arm: unlike wall time it does not count the thread's time off-CPU under host load. frameTiming
 * emits gameJsCpuMs/cpuFrameCpuMs only when the value is >= 0. */
double threadCpuMs();

/** Default-off TN_GAME_SPANS sink: -1 queries the flag, -2 reads monotonic ms, -3 is a no-op FFI probe.
 * Normal ids begin (action 0) or end (action 1) inside host windows 26/27; outside spans are ignored.
 * Invalid input/nesting returns -1. */
double gameSpan(int id, int action);
/** Real monotonic ms since process start: the clock behind performance.now on every player host.
 * Ticks and timers keep their fixed-step time; only this clock moves inside one frame. */
double wallMs();
/** "fifo" (vsync, the default) or "immediate" (TN_PLAYER_VSYNC=0): the present mode this run's surface uses. */
const char* presentModeName();
/** The window this run opens (TN_PLAYER_WIDTH x TN_PLAYER_HEIGHT, else the default): what a game may read before the
 * renderer exists. Once it does, the renderer's own size is the drawing buffer. */
struct SurfaceSize { uint32_t width, height; };
SurfaceSize configuredSurface();
json::Value gameSpanTiming(double gameMs);

/** One owned player session; step returns 1 while running, 0 on close, a negative error on failure. */
struct Session;
Session* open(const Game& game, int& status);
int step(Session& session);
void close(Session* session);

/** The high-performance adapter's nonempty info fields, shared by every host. */
std::vector<std::pair<std::string, std::string>> adapterIdentity();

/** Runs one game until the window closes or the runner stops the process. */
int run(const Game& game);

}  // namespace player
}  // namespace tn::engine
