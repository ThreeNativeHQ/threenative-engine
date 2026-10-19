// Backgrounding must stop the loop, and coming back must start it again.
//
// The event pump handled QUIT, resize, keys, pointers, fingers and gamepads and no lifecycle
// event of any kind, so a physical Pixel 8 kept presenting for the full 60 s its screen was off
// (bug 9, 2026-08-23). SDL 3.2.8 decides the mechanism: on Android the background events are
// queued and the pump *then* blocks inside `Android_WaitLifecycleEvent`, so a polled handler runs
// only after the app is already parked. `SDL_AddEventWatch` is synchronous at send time.
//
// This drives the real transition table and the real audio registry with real SDL event
// constants. It needs no window and no GPU: SDL runs on its dummy video and audio drivers, and
// the events are fed the way the watch feeds them.

#include "mystral/audio/audio_context.h"
#include "mystral/platform/lifecycle.h"
#include "mystral/runtime.h"
#include "mystral/webgpu/bindings.h"
#include "../src/webgpu/bindings_state.h"

#include <chrono>
#include <cstdlib>
#include <iostream>
#include <string>
#include <vector>

#if !defined(_WIN32)
#include <sys/wait.h>
#include <unistd.h>
#endif

#include <SDL3/SDL.h>

namespace {

using mystral::platform::BackgroundMode;
using mystral::platform::LifecycleAction;

std::vector<std::string> failures;

void check(bool condition, const std::string& what) {
    if (condition) {
        std::cout << "PASS " << what << '\n';
        return;
    }
    failures.push_back(what);
    std::cerr << "FAIL " << what << '\n';
}

std::vector<std::string> drainMarkers() {
    std::vector<std::string> markers;
    std::string marker;
    while (mystral::platform::takeLifecycleMarker(marker)) markers.push_back(marker);
    return markers;
}

bool anyMarkerContains(const std::vector<std::string>& markers, const std::string& needle) {
    for (const std::string& marker : markers)
        if (marker.find(needle) != std::string::npos) return true;
    return false;
}

struct EventCase {
    uint32_t event;
    const char* label;
    LifecycleAction expected;
};

const EventCase kEvents[] = {
    {SDL_EVENT_WILL_ENTER_BACKGROUND, "WILL_ENTER_BACKGROUND", LifecycleAction::Pause},
    {SDL_EVENT_DID_ENTER_BACKGROUND, "DID_ENTER_BACKGROUND", LifecycleAction::Pause},
    {SDL_EVENT_WINDOW_MINIMIZED, "WINDOW_MINIMIZED", LifecycleAction::Pause},
    {SDL_EVENT_WINDOW_HIDDEN, "WINDOW_HIDDEN", LifecycleAction::Pause},
    {SDL_EVENT_WILL_ENTER_FOREGROUND, "WILL_ENTER_FOREGROUND", LifecycleAction::Resume},
    {SDL_EVENT_DID_ENTER_FOREGROUND, "DID_ENTER_FOREGROUND", LifecycleAction::Resume},
    {SDL_EVENT_WINDOW_RESTORED, "WINDOW_RESTORED", LifecycleAction::Resume},
    {SDL_EVENT_WINDOW_SHOWN, "WINDOW_SHOWN", LifecycleAction::Resume},
    {SDL_EVENT_TERMINATING, "TERMINATING", LifecycleAction::Terminate},
    {SDL_EVENT_WINDOW_DESTROYED, "WINDOW_DESTROYED", LifecycleAction::Terminate},
    {SDL_EVENT_LOW_MEMORY, "LOW_MEMORY", LifecycleAction::MemoryTrim},
    // Never a pause on focus alone: a desktop game in split screen is still on screen, and on
    // Android focus loss accompanies a real pause rather than being one.
    {SDL_EVENT_WINDOW_FOCUS_LOST, "WINDOW_FOCUS_LOST", LifecycleAction::RecordOnly},
    {SDL_EVENT_WINDOW_OCCLUDED, "WINDOW_OCCLUDED", LifecycleAction::RecordOnly},
    {SDL_EVENT_KEY_DOWN, "KEY_DOWN", LifecycleAction::None},
    {SDL_EVENT_MOUSE_MOTION, "MOUSE_MOTION", LifecycleAction::None},
};

bool surfaceBindingStateFollowsRebuild() {
    auto* state = mystral::webgpu::createBindingsState();
    if (!state) return false;
    void* replacement = reinterpret_cast<void*>(0x1);
    mystral::webgpu::republishSurface(
        state,
        replacement,
        static_cast<uint32_t>(WGPUTextureFormat_BGRA8Unorm),
        static_cast<uint32_t>(WGPUPresentMode_Fifo),
        720,
        1280);
    const bool published = state->surface == reinterpret_cast<WGPUSurface>(replacement) &&
                           state->presentation.surfaceFormat == WGPUTextureFormat_BGRA8Unorm &&
                           state->presentation.presentMode == WGPUPresentMode_Fifo &&
                           state->presentation.surfaceWidth == 720 && state->presentation.surfaceHeight == 1280 &&
                           state->presentation.canvasWidth == 800 && state->presentation.canvasHeight == 600;
    state->presentation.framePresentPending = true;
    mystral::webgpu::detachSurfaceForRebuild(state);
    const bool detached = state->surface == nullptr && !state->presentation.framePresentPending;
    mystral::webgpu::destroyBindingsState(state);
    return published && detached && state == nullptr;
}

bool forcedResumeFailureRetriesBeforeStopping() {
#if defined(_WIN32)
    return false;
#else
    const pid_t child = fork();
    if (child < 0) return false;
    if (child == 0) {
        setenv("THREENATIVE_FORCE_SURFACE_REVALIDATE_FAILURE", "1", 1);

        bool passed = false;
        {
            mystral::RuntimeConfig config;
            config.width = 320;
            config.height = 240;
            config.maxFps = 60;
            auto runtime = mystral::Runtime::create(config);
            if (runtime) {
                mystral::platform::handleLifecycleEvent(SDL_EVENT_WINDOW_RESTORED);
                const auto started = std::chrono::steady_clock::now();
                const bool stillRunning = runtime->pollEvents();
                const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
                    std::chrono::steady_clock::now() - started);
                passed = !stillRunning && runtime->getExitCode() == 1 &&
                         runtime->getPresentCount() == 0 &&
                         elapsed >= std::chrono::milliseconds(3900) &&
                         elapsed < std::chrono::milliseconds(5000);
                std::cout << "TN_LIFECYCLE_RETRY_HARNESS:{\"elapsedMs\":" << elapsed.count()
                          << ",\"presentCount\":" << runtime->getPresentCount()
                          << ",\"exitCode\":" << runtime->getExitCode() << "}" << std::endl;
                // The child exits immediately after this assertion; do not enter the unrelated
                // X11 teardown path that would otherwise run from Runtime's destructor.
                runtime.release();
            }
        }

        // The harness deliberately exits after observing the terminal path. Runtime shutdown is
        // outside this assertion; `_exit` keeps that teardown path from changing the retry result
        // the harness reports.
        std::cout.flush();
        std::cerr.flush();
        _exit(passed ? 0 : 1);
    }

    int status = 0;
    if (waitpid(child, &status, 0) != child) return false;
    return WIFEXITED(status) && WEXITSTATUS(status) == 0;
#endif
}

}  // namespace

int main() {
    const char* retryHarness = std::getenv("THREENATIVE_RUN_RESUME_RETRY_HARNESS");
    const bool runRetryHarness = retryHarness != nullptr && retryHarness[0] == '1';
#if defined(_WIN32)
    _putenv_s("SDL_AUDIO_DRIVER", "dummy");
    if (!runRetryHarness) _putenv_s("SDL_VIDEO_DRIVER", "dummy");
#else
    setenv("SDL_AUDIO_DRIVER", "dummy", 1);
    if (!runRetryHarness) setenv("SDL_VIDEO_DRIVER", "dummy", 1);
#endif

    // 1. The transition table, event by event.
    for (const EventCase& testCase : kEvents)
        check(mystral::platform::lifecycleActionFor(testCase.event) == testCase.expected,
              std::string("SDL_EVENT_") + testCase.label + " maps to " +
                  mystral::platform::lifecycleActionName(testCase.expected));

    // 2. Pause and resume, in the default mode.
    mystral::platform::resetLifecycleForTesting();
    check(!mystral::platform::isPaused(), "the loop starts unpaused");

    mystral::platform::handleLifecycleEvent(SDL_EVENT_DID_ENTER_BACKGROUND);
    check(mystral::platform::isPaused(), "backgrounding pauses the loop");
    std::vector<std::string> markers = drainMarkers();
    check(anyMarkerContains(markers, "TN_LIFECYCLE:{\"event\":\"paused\""),
          "the pause is reported as a TN_LIFECYCLE marker");
    check(anyMarkerContains(markers, "\"applied\":true"),
          "the pause marker says the pause was applied");
    int pauseTrimLevel = -2;
    check(mystral::platform::takeMemoryTrimRequest(pauseTrimLevel) && pauseTrimLevel == 20,
          "pausing queues the Android UI-hidden trim callback level");
    check(anyMarkerContains(markers, "TN_LIFECYCLE_MEMORY_TRIM:{\"level\":20"),
          "pausing records the host trim measurement");

    mystral::platform::handleLifecycleEvent(SDL_EVENT_DID_ENTER_FOREGROUND);
    check(!mystral::platform::isPaused(), "foregrounding resumes the loop");
    check(anyMarkerContains(drainMarkers(), "TN_LIFECYCLE:{\"event\":\"resumed\""),
          "the resume is reported as a TN_LIFECYCLE marker");

    // 2b. Resume is not just "unset the flag": the surface it presents to died with the window.
    check(surfaceBindingStateFollowsRebuild(),
          "surface detach and republish update the binding state");
    mystral::platform::resetLifecycleForTesting();
    check(mystral::platform::backgroundMode() == BackgroundMode::Pause,
          "the default background mode is pause");
    check(!mystral::platform::surfaceRevalidationPending(),
          "a host that has not resumed has nothing to revalidate");
    mystral::platform::handleLifecycleEvent(SDL_EVENT_DID_ENTER_BACKGROUND);
    check(!mystral::platform::surfaceRevalidationPending(),
          "backgrounding alone does not queue a rebuild; the window is not back yet");
    mystral::platform::handleLifecycleEvent(SDL_EVENT_DID_ENTER_FOREGROUND);
    check(mystral::platform::surfaceRevalidationPending(),
          "resuming queues the surface rebuild that resume never did");
    check(mystral::platform::takeSurfaceRevalidationRequest(),
          "the loop takes the request");
    check(!mystral::platform::surfaceRevalidationPending(),
          "and it is taken exactly once, so one resume is not rebuilt on every later frame");
    drainMarkers();

    // 2e. Android forwards its ComponentCallbacks2 level through SDL's level-less event. Moderate
    // pressure trims host-owned allocations; a lower advisory level remains observable but does
    // not pretend that memory was released.
    mystral::platform::resetLifecycleForTesting();
    mystral::platform::noteMemoryTrimLevel(60);
    mystral::platform::handleLifecycleEvent(SDL_EVENT_LOW_MEMORY);
    markers = drainMarkers();
    check(anyMarkerContains(markers, "TN_LIFECYCLE_MEMORY_TRIM:{\"level\":60"),
          "moderate Android pressure records a trim measurement");
    check(anyMarkerContains(markers, "\"action\":\"trim\""),
          "moderate Android pressure takes the host trim action");
    int moderateTrimLevel = -2;
    check(mystral::platform::takeMemoryTrimRequest(moderateTrimLevel) && moderateTrimLevel == 60,
          "moderate Android pressure queues its level for the game callback");

    mystral::platform::noteMemoryTrimLevel(20);
    mystral::platform::handleLifecycleEvent(SDL_EVENT_LOW_MEMORY);
    markers = drainMarkers();
    check(anyMarkerContains(markers, "\"level\":20"),
          "an advisory Android trim level remains observable");
    check(anyMarkerContains(markers, "\"action\":\"observed\""),
          "an advisory Android trim level does not claim a host trim");
    int advisoryTrimLevel = -2;
    check(mystral::platform::takeMemoryTrimRequest(advisoryTrimLevel) && advisoryTrimLevel == 20,
          "an advisory Android level still reaches the game callback");

    // SDL 3.2.30 queues and coalesces LOW_MEMORY, so ComponentCallbacks2 can report a severe
    // level before the event watch runs and then report a less severe level. Keep the maximum
    // pending level until the queued event consumes it.
    mystral::platform::resetLifecycleForTesting();
    mystral::platform::noteMemoryTrimLevel(80);
    mystral::platform::noteMemoryTrimLevel(20);
    mystral::platform::handleLifecycleEvent(SDL_EVENT_LOW_MEMORY);
    markers = drainMarkers();
    check(anyMarkerContains(markers, "TN_LIFECYCLE_MEMORY_TRIM:{\"level\":80"),
          "coalesced low-memory events preserve the most severe pending level");
    check(anyMarkerContains(markers, "\"action\":\"trim\""),
          "the preserved severe level still trims host-owned memory");
    int coalescedTrimLevel = -2;
    check(mystral::platform::takeMemoryTrimRequest(coalescedTrimLevel) && coalescedTrimLevel == 80,
          "the game callback receives the most severe coalesced level");

    // 2c. Android destroys the window whatever this host decided about pausing, so `continue`
    //     needs the same rebuild. The retreat that shipped `continue` as the default was living on
    //     this being untrue.
    mystral::platform::resetLifecycleForTesting();
    mystral::platform::setBackgroundMode(BackgroundMode::Continue);
    mystral::platform::handleLifecycleEvent(SDL_EVENT_DID_ENTER_BACKGROUND);
    mystral::platform::handleLifecycleEvent(SDL_EVENT_DID_ENTER_FOREGROUND);
    check(mystral::platform::surfaceRevalidationPending(),
          "backgroundMode=continue still queues the surface rebuild");
    mystral::platform::clearSurfaceRevalidationRequest();
    check(!mystral::platform::surfaceRevalidationPending(),
          "startup can drop a request it raised against a surface it just built");
    drainMarkers();

    // 2d. The negative control that reproduces the defect from the same binary.
    check(!mystral::platform::surfaceRevalidationDisabled(),
          "revalidation is on unless something explicitly asks for the pre-fix behaviour");
#if !defined(_WIN32)
    setenv("THREENATIVE_SKIP_SURFACE_REVALIDATE", "1", 1);
    check(mystral::platform::surfaceRevalidationDisabled(),
          "the documented control switch reinstates the pre-fix resume");
    setenv("THREENATIVE_SKIP_SURFACE_REVALIDATE", "0", 1);
    check(!mystral::platform::surfaceRevalidationDisabled(),
          "and anything but 1 leaves the fix in place");
    unsetenv("THREENATIVE_SKIP_SURFACE_REVALIDATE");
#endif

    // 3. Focus loss alone must not pause anything.
    mystral::platform::resetLifecycleForTesting();
    mystral::platform::handleLifecycleEvent(SDL_EVENT_WINDOW_FOCUS_LOST);
    check(!mystral::platform::isPaused(), "losing focus does not pause the loop");
    check(anyMarkerContains(drainMarkers(), "\"event\":\"observed\""),
          "losing focus is still recorded");

    // 4. The named override. Turning the pause off must not turn the reporting off.
    mystral::platform::resetLifecycleForTesting();
    mystral::platform::setBackgroundMode(BackgroundMode::Continue);
    mystral::platform::handleLifecycleEvent(SDL_EVENT_DID_ENTER_BACKGROUND);
    check(!mystral::platform::isPaused(), "backgroundMode=continue keeps the loop running");
    markers = drainMarkers();
    check(anyMarkerContains(markers, "\"mode\":\"continue\""),
          "the marker names the mode that executed");
    check(anyMarkerContains(markers, "\"applied\":false"),
          "the marker says the pause was not applied");

    // 5. Terminal events are terminal whatever the mode says.
    mystral::platform::handleLifecycleEvent(SDL_EVENT_TERMINATING);
    check(mystral::platform::isTerminating(),
          "a terminal event stops the loop even under backgroundMode=continue");
    check(anyMarkerContains(drainMarkers(), "\"event\":\"terminating\""),
          "the terminal event is reported");

    // 6. Mode parsing fails closed on anything it does not recognize.
    BackgroundMode parsed = BackgroundMode::Continue;
    check(mystral::platform::parseBackgroundMode("pause", parsed) && parsed == BackgroundMode::Pause,
          "\"pause\" parses");
    check(mystral::platform::parseBackgroundMode("continue", parsed) &&
              parsed == BackgroundMode::Continue,
          "\"continue\" parses");
    check(!mystral::platform::parseBackgroundMode("maybe", parsed),
          "an unrecognized backgroundMode is rejected rather than guessed");
    check(!mystral::platform::parseBackgroundMode(nullptr, parsed),
          "a missing backgroundMode is rejected rather than guessed");

    // 7. The audio registry. `suspend()` and `resume()` existed but were reachable only from
    //    JavaScript, which is exactly what stops running when an app is backgrounded.
    mystral::platform::resetLifecycleForTesting();
    if (SDL_InitSubSystem(SDL_INIT_AUDIO)) {
        auto context = std::make_unique<mystral::audio::AudioContext>();
        context->resume();
        const bool running = context->state() == mystral::audio::AudioContext::State::Running;
        check(mystral::audio::liveContextCount() >= 1,
              "a constructed AudioContext registers itself with the host");
        mystral::platform::handleLifecycleEvent(SDL_EVENT_DID_ENTER_BACKGROUND);
        if (running) {
            check(context->state() == mystral::audio::AudioContext::State::Suspended,
                  "backgrounding suspends every live AudioContext");
            check(context->hostSuspended(), "the host records that it owns the suspension");
            mystral::platform::handleLifecycleEvent(SDL_EVENT_DID_ENTER_FOREGROUND);
            check(context->state() == mystral::audio::AudioContext::State::Running,
                  "foregrounding resumes the contexts the host suspended");
        } else {
            std::cout << "SKIP audio suspension: this build's dummy device never reached Running\n";
        }

        // A context the game suspended is the game's business; the host must not resume it.
        context->suspend();
        mystral::platform::handleLifecycleEvent(SDL_EVENT_DID_ENTER_BACKGROUND);
        mystral::platform::handleLifecycleEvent(SDL_EVENT_DID_ENTER_FOREGROUND);
        check(context->state() == mystral::audio::AudioContext::State::Suspended,
              "resuming does not un-suspend a context the game suspended itself");

        const size_t before = mystral::audio::liveContextCount();
        context.reset();
        check(mystral::audio::liveContextCount() + 1 == before,
              "a destroyed AudioContext leaves the registry");
        SDL_QuitSubSystem(SDL_INIT_AUDIO);
    } else {
        failures.push_back("SDL audio could not start, so the registry was not proven");
        std::cerr << "FAIL SDL_InitSubSystem(SDL_INIT_AUDIO): " << SDL_GetError() << '\n';
    }

    // 8. The watch itself installs, and installs once.
    mystral::platform::resetLifecycleForTesting();
    if (SDL_InitSubSystem(SDL_INIT_VIDEO)) {
        check(mystral::platform::installLifecycleWatch(), "the SDL event watch installs");
        check(mystral::platform::installLifecycleWatch(), "installing twice is idempotent");

        // Push a real event through SDL so the watch is exercised on SDL's own send path, which
        // is the whole reason this is a watch and not a pump case.
        SDL_Event event = {};
        event.type = SDL_EVENT_DID_ENTER_BACKGROUND;
        SDL_PushEvent(&event);
        check(mystral::platform::isPaused(),
              "an event pushed through SDL reaches the watch synchronously, before any poll");
        mystral::platform::removeLifecycleWatch();
        SDL_QuitSubSystem(SDL_INIT_VIDEO);
    } else {
        failures.push_back("SDL video could not start, so the watch install was not proven");
        std::cerr << "FAIL SDL_InitSubSystem(SDL_INIT_VIDEO): " << SDL_GetError() << '\n';
    }

    if (runRetryHarness)
        check(forcedResumeFailureRetriesBeforeStopping(),
              "forced resume failure retries five times, stops within five seconds, and presents no frame");

    if (!failures.empty()) {
        std::cerr << "native lifecycle policy contract failed:\n";
        for (const std::string& failure : failures) std::cerr << "  - " << failure << '\n';
        return 1;
    }
    std::cout << "native lifecycle policy contract passed\n";
    return 0;
}
