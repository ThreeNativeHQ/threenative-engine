/**
 * Android entry point for Mystral Runtime
 *
 * This provides the SDL_main entry point that SDL3 calls on Android.
 * The script path is passed via command line arguments from MystralActivity.
 */

#ifdef __ANDROID__

#include "mystral/runtime.h"
#include "mystral/platform/android_stdio.h"
#include "mystral/cold_start.h"
#include "mystral/platform/ui_overlay.h"
#include "../webgpu/pipeline_cache.h"
#include <SDL3/SDL.h>
#include <iostream>
#include <fstream>
#include <sstream>
#include <cstdio>
#include <cstdlib>
#include <thread>
#include <chrono>
#include <climits>
#include <cerrno>
#include <cstring>
#include <string>
#include <dirent.h>
#include <dlfcn.h>
#include <sched.h>
#include <sys/resource.h>
#include <unistd.h>
#include <android/log.h>
#include <android/asset_manager.h>
#include <android/asset_manager_jni.h>

#define LOG_TAG "MystralRuntime"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

/**
 * Read a script file from Android assets using SDL3's IOStream.
 * Asset paths are relative to the assets directory.
 */
#if defined(MYSTRAL_JS_V8)
namespace mystral {
namespace js {
void mystralSetV8SnapshotBlob(const char* data, size_t size);
}  // namespace js
}  // namespace mystral
#endif

static std::string readAsset(const std::string& assetPath) {
    LOGI("Loading asset: %s", assetPath.c_str());

    // Use SDL's IO stream to read from Android assets
    SDL_IOStream* io = SDL_IOFromFile(assetPath.c_str(), "r");
    if (!io) {
        LOGE("Failed to open asset: %s - %s", assetPath.c_str(), SDL_GetError());
        return "";
    }

    // Get file size
    Sint64 size = SDL_GetIOSize(io);
    if (size < 0) {
        LOGE("Failed to get asset size: %s", SDL_GetError());
        SDL_CloseIO(io);
        return "";
    }

    LOGI("Asset size: %lld bytes", (long long)size);

    // Read content
    std::string content;
    content.resize(static_cast<size_t>(size));

    size_t bytesRead = SDL_ReadIO(io, content.data(), static_cast<size_t>(size));
    SDL_CloseIO(io);

    if (bytesRead != static_cast<size_t>(size)) {
        LOGE("Failed to read asset: expected %lld, got %zu", (long long)size, bytesRead);
        return "";
    }

    LOGI("Asset loaded successfully: %zu bytes", bytesRead);
    return content;
}

/**
 * PRD-859: the game thread wins the CPU on Android. The game thread (this SDL thread) takes nice -4 (NORMAL - 4,
 * Unreal's TPri_Highest) and an ADPF hint session (API 33+, resolved at run time so older devices still load) that
 * hears each frame's work time against the frame target. Every other thread the process owns takes SCHED_BATCH and
 * nice +10 (Unreal's TPri_Lowest), except the Java main thread, the HWUI and binder threads and SDL's audio threads.
 * `display.priority: "normal"` turns both off. One logcat line reports what the OS applied after each change.
 */
namespace mystral::platform {
namespace {
struct GameThreadPriority {
    using Manager = void* (*)();
    using Create = void* (*)(void*, const int32_t*, size_t, int64_t);
    using Update = int (*)(void*, int64_t);
    using Report = int (*)(void*, int64_t);
    bool enabled = false;
    pid_t game = 0;
    bool adpfTried = false;
    void* session = nullptr;
    Update update = nullptr;
    Report report = nullptr;
    int64_t targetNs = 0;
    std::string adpf = "off", source = "none", reported;
    std::chrono::steady_clock::time_point lastEnd{}, lastSweep{};
};
GameThreadPriority g_priority;

int niceOf(int tid) {
    errno = 0;
    const int value = getpriority(PRIO_PROCESS, static_cast<id_t>(tid));
    return errno == 0 ? value : INT_MIN;
}

/** Threads the platform owns and the frame waits on keep their priority. */
bool keeps(int tid, const std::string& name) {
    return tid == g_priority.game || tid == getpid() || name == "RenderThread" || name.rfind("hwui", 0) == 0 ||
           // Android 12+ names binder threads `binder:<pid>_<n>`; older releases use `Binder:`. The binder
           // driver sets their priority per call, so a sweep would only fight it.
           name.rfind("Binder:", 0) == 0 || name.rfind("binder:", 0) == 0 || name.rfind("HwBinder:", 0) == 0 ||
           name.rfind("SDLAudio", 0) == 0;
}

void openSession(int64_t targetNs) {
    g_priority.adpfTried = true;
    void* library = dlopen("libandroid.so", RTLD_NOW | RTLD_LOCAL);
    const auto manager = library ? reinterpret_cast<GameThreadPriority::Manager>(dlsym(library, "APerformanceHint_getManager")) : nullptr;
    const auto create = library ? reinterpret_cast<GameThreadPriority::Create>(dlsym(library, "APerformanceHint_createSession")) : nullptr;
    g_priority.update = library ? reinterpret_cast<GameThreadPriority::Update>(dlsym(library, "APerformanceHint_updateTargetWorkDuration")) : nullptr;
    g_priority.report = library ? reinterpret_cast<GameThreadPriority::Report>(dlsym(library, "APerformanceHint_reportActualWorkDuration")) : nullptr;
    if (!manager || !create || !g_priority.update || !g_priority.report) {
        g_priority.adpf = "unsupported reason=no-api";  // API < 33
        return;
    }
    void* hints = manager();
    const int32_t threads[] = {static_cast<int32_t>(g_priority.game)};
    g_priority.session = hints ? create(hints, threads, 1, targetNs) : nullptr;
    g_priority.adpf = g_priority.session ? "on" : hints ? "unsupported reason=no-session" : "unsupported reason=no-manager";
    g_priority.targetNs = targetNs;
}

void sweep() {
    g_priority.lastSweep = std::chrono::steady_clock::now();
    int lowest = INT_MAX, batch = 0, background = 0;
    if (DIR* tasks = opendir("/proc/self/task")) {
        while (const dirent* entry = readdir(tasks)) {
            const int tid = std::atoi(entry->d_name);
            if (tid <= 0) continue;
            char name[32] = {};
            if (std::FILE* file = std::fopen(("/proc/self/task/" + std::string(entry->d_name) + "/comm").c_str(), "r")) {
                if (!std::fgets(name, sizeof name, file)) name[0] = 0;
                std::fclose(file);
            }
            std::string comm = name;
            while (!comm.empty() && comm.back() == '\n') comm.pop_back();
            if (keeps(tid, comm)) continue;
            ++background;
            if (g_priority.enabled) {
                if (sched_getscheduler(tid) != SCHED_BATCH) {
                    const sched_param param{0};
                    sched_setscheduler(tid, SCHED_BATCH, &param);
                }
                if (const int value = niceOf(tid); value != INT_MIN && value < 10) setpriority(PRIO_PROCESS, static_cast<id_t>(tid), 10);
            }
            if (sched_getscheduler(tid) == SCHED_BATCH) ++batch;
            lowest = std::min(lowest, niceOf(tid));
        }
        closedir(tasks);
    }
    std::string line = "game=" + std::to_string(niceOf(g_priority.game)) +
                       " background=" + (lowest == INT_MAX ? std::string("none") : std::to_string(lowest)) +
                       " batch=" + std::to_string(batch) + "/" + std::to_string(background) + " source=" +
                       (g_priority.enabled ? g_priority.source : "none") + " adpf=" + g_priority.adpf +
                       (g_priority.enabled ? " override=none" : " override=normal");
    if (line == g_priority.reported) return;
    g_priority.reported = line;
    LOGI("TN_PROCESS_PRIORITY %s", line.c_str());
}
}  // namespace

void startGameThreadPriority(bool enabled) {
    g_priority.enabled = enabled;
    g_priority.game = gettid();
    if (enabled) {
        if (setpriority(PRIO_PROCESS, static_cast<id_t>(g_priority.game), -4) == 0) g_priority.source = "setpriority";
        else g_priority.source = std::string("none reason=") + (errno == EACCES ? "EACCES" : errno == EPERM ? "EPERM" : std::to_string(errno));
    }
    sweep();
}

/** From the presentation pacing, on the game thread: the frame's work ended now; `targetNs` is the frame target. */
void noteGameFrameWork(int64_t targetNs) {
    if (!g_priority.enabled || g_priority.game == 0) return;
    const auto now = std::chrono::steady_clock::now();
    if (!g_priority.adpfTried && targetNs > 0) openSession(targetNs);
    if (g_priority.session) {
        if (targetNs > 0 && targetNs != g_priority.targetNs && g_priority.update(g_priority.session, targetNs) == 0)
            g_priority.targetNs = targetNs;
        if (g_priority.lastEnd != std::chrono::steady_clock::time_point{})
            g_priority.report(g_priority.session, std::chrono::duration_cast<std::chrono::nanoseconds>(now - g_priority.lastEnd).count());
    }
    if (now - g_priority.lastSweep >= std::chrono::seconds(1)) sweep();
}

/** From the presentation pacing: the wait for the next present ended; the next frame's work starts now. */
void noteGameFrameWaitEnded() {
    if (g_priority.enabled) g_priority.lastEnd = std::chrono::steady_clock::now();
}
}  // namespace mystral::platform

/**
 * SDL_main - Entry point called by SDL on Android.
 *
 * Arguments come from MystralActivity.getArguments().
 * Must be visible and use C linkage for SDL to find it via dlsym.
 */
extern "C" __attribute__((visibility("default"))) int SDL_main(int argc, char* argv[]) {
    mystral::platform::redirectStdioToLogcat();
    mystral::coldStartMark("process");
    LOGI("SDL_main called with %d arguments", argc);
    for (int i = 0; i < argc; i++) {
        LOGI("  arg[%d] = %s", i, argv[i]);
    }

    // Get script path from arguments (set by MystralActivity.getArguments())
    std::string scriptPath = "asset://scripts/main.js";
    if (argc > 1 && argv[1]) {
        scriptPath = argv[1];
    }

    LOGI("Script path: %s", scriptPath.c_str());

#if defined(MYSTRAL_JS_V8)
    // V8 on Android keeps its startup snapshot outside the library, so it has to be handed over
    // before the engine is created. Missing, the runtime fails with "Failed to create JavaScript
    // engine" and no further detail.
    //
    // The snapshot is ABI-specific and the APK ships every ABI it targets, so the path carries the
    // ABI. A single shared `v8/snapshot_blob.bin` was arm64's, copied into every slice: on arm64 it
    // worked and nothing else was ever run, which is why it survived. The ABI is known at compile
    // time, so the right file is selected here rather than guessed at runtime.
    {
#if defined(__aarch64__)
        const char* const snapshotAsset = "v8/arm64-v8a/snapshot_blob.bin";
#elif defined(__x86_64__)
        const char* const snapshotAsset = "v8/x86_64/snapshot_blob.bin";
#else
#error "No V8 startup snapshot is staged for this Android ABI."
#endif
        const std::string snapshot = readAsset(snapshotAsset);
        if (snapshot.empty()) {
            LOGE("V8 startup snapshot asset is missing: %s; the engine cannot start.",
                 snapshotAsset);
            return 1;
        }
        mystral::js::mystralSetV8SnapshotBlob(snapshot.data(), snapshot.size());
    }
#endif

    // Read script content
    std::string scriptContent;
    if (scriptPath.find("asset://") == 0) {
        // Load from Android assets
        std::string assetPath = scriptPath.substr(8);  // Remove "asset://"
        mystral::coldStartMark("asset_begin");
        scriptContent = readAsset(assetPath);
        mystral::coldStartMark("asset_complete");
    } else {
        // Load from file system
        std::ifstream file(scriptPath);
        if (!file.is_open()) {
            LOGE("Failed to open script file: %s", scriptPath.c_str());
            return 1;
        }
        std::stringstream buffer;
        buffer << file.rdbuf();
        scriptContent = buffer.str();
    }

    LOGI("Script loaded, %zu bytes", scriptContent.size());

    // Create runtime config
    mystral::RuntimeConfig config;
    // The packaged bundle owns its Three.js/WGSL source graph. A loose script may import files
    // outside it, so only the owned asset entry qualifies for cross-process compiler data.
    if (scriptPath.find("asset://") == 0 && !scriptContent.empty()) {
        config.pipelineCacheAppIdentity = scriptPath;
        config.pipelineCacheSourceIdentity = mystral::webgpu::pipelineCacheDigest(scriptContent);
    }
    config.storageIdentity = scriptPath;
    config.width = 0;   // Use full screen width (0 = auto)
    config.height = 0;  // Use full screen height (0 = auto)
    std::string windowTitle = "ThreeNative";
    if (argc > 4 && argv[4] && argv[4][0] != '\0') windowTitle = argv[4];
    config.title = windowTitle.c_str();
    config.fullscreen = argc <= 5 || !argv[5] || std::string(argv[5]) == "true";
    // `display.backgroundMode`, carried from the manifest as TN_BACKGROUND_MODE. Anything the
    // parser does not recognize keeps the default and says so, rather than being guessed at.
    if (argc > 6 && argv[6] && argv[6][0] != '\0') {
        mystral::platform::BackgroundMode mode = mystral::platform::BackgroundMode::Pause;
        if (mystral::platform::parseBackgroundMode(argv[6], mode)) {
            config.backgroundMode = mode;
        } else {
            LOGE("Unrecognized TN_BACKGROUND_MODE '%s'; keeping 'pause'", argv[6]);
        }
    }
    LOGI("backgroundMode=%s", mystral::platform::backgroundModeName(config.backgroundMode));
    if (argc > 7 && argv[7] && argv[7][0] != '\0') {
        try {
            const std::string value = argv[7];
            size_t consumed = 0;
            const unsigned long parsed = std::stoul(value, &consumed);
            if (consumed != value.size() || parsed > 1000) throw std::out_of_range("maxFps");
            config.maxFps = static_cast<uint32_t>(parsed);
        } catch (const std::exception&) {
            LOGE("TN_PRESENTATION_CAP_INVALID: TN_MAX_FPS must be 0..1000, got '%s'", argv[7]);
            return 2;
        }
    }
    LOGI("maxFps=%u", config.maxFps);
    // `display.priority` (PRD-859), carried from the manifest as TN_PRIORITY. Empty means the default.
    bool gamePriority = true;
    if (argc > 11 && argv[11] && argv[11][0] != '\0') {
        if (std::strcmp(argv[11], "normal") == 0) gamePriority = false;
        else if (std::strcmp(argv[11], "game") != 0) {
            LOGE("TN_PRIORITY_INVALID: TN_PRIORITY must be game or normal, got '%s'", argv[11]);
            return 2;
        }
    }
#if TN_ANDROID_VSYNC
    // FIFO quantizes a missed vblank to an integer divisor: at physical 60 Hz, a 10-14 ms frame
    // with a small scheduling miss becomes a 33 ms frame. Keep FIFO below the full-refresh target,
    // but use the runtime's supported mailbox/immediate path for 60, high refresh and uncapped
    // presentation. The software maxFps ceiling still applies after every successful present.
    config.vsync = config.maxFps != 0 && config.maxFps < 60;
#else
    config.vsync = false;
#endif
    LOGI("vsync=%s", config.vsync ? "true" : "false");

    LOGI("Creating Mystral runtime...");

    // Create runtime
    auto runtime = mystral::Runtime::create(config);
    if (!runtime) {
        LOGE("Failed to create Mystral runtime!");
        return 1;
    }

    LOGI("Runtime created successfully");
    mystral::coldStartMark("runtime_created");

    if (argc > 2 && argv[2] && argv[2][0] != '\0') {
        std::string endpoint = argv[2];
        std::string escaped;
        escaped.reserve(endpoint.size());
        for (char value : endpoint) {
            if (value == '\\' || value == '\'') escaped.push_back('\\');
            escaped.push_back(value);
        }
        runtime->evalScript(
            "globalThis.TN_PLAYTEST_ENDPOINT='" + escaped + "';",
            "threenative-playtest-endpoint.js"
        );
        LOGI("Device playtest endpoint configured");
    }
    if (argc > 3 && argv[3] && argv[3][0] != '\0') {
        std::string root = argv[3];
        ::setenv("TN_PLAYTEST_MAILBOX_ROOT", root.c_str(), 1);
        runtime->evalScript(
            "globalThis.TN_PLAYTEST_MAILBOX={request:'" + root +
                "/tn-playtest-request.json',response:'" + root +
                "/tn-playtest-response.json'};",
            "threenative-playtest-mailbox.js"
        );
        LOGI("Device playtest mailbox configured");
        // An Android app inherits no environment, and `am start` passes none, so the two test-only
        // knobs the native-css UI reads with getenv arrive as intent extras instead: its animation
        // clock (`TN_CSS_UI_FIXED_STEP_MS`, read by the attach below before anything is laid out)
        // and the focus/scroll state line (`TN_CSS_UI_STATE_TRACE`). Inside this block because they
        // are playtest configuration: a launch without a mailbox configures neither.
        if (argc > 9 && argv[9] && argv[9][0] != '\0') {
            ::setenv("TN_CSS_UI_FIXED_STEP_MS", argv[9], 1);
            LOGI("Fixed UI clock: %s ms per tick", argv[9]);
        }
        if (argc > 10 && argv[10] && argv[10][0] != '\0') {
            ::setenv("TN_CSS_UI_STATE_TRACE", argv[10], 1);
            LOGI("UI state trace: on");
        }
    }
    // `ui.renderer: "native-css"`: the activity extracted the packaged `ui/` stylesheets, fonts and
    // images to a real directory (APK assets are not one) and passes it here. Attached on this
    // thread because the document is thread-local and the game loop below is what pumps, posts to
    // and composites it. Fail closed, as on desktop: a game that asked for a HUD and has none would
    // look like a HUD with nothing to show.
    if (argc > 8 && argv[8] && argv[8][0] != '\0') {
        if (!mystral::platform::attachDesktopCssUi(argv[8])) {
            LOGE("TN_UI_LOAD_FAILED: the requested native-css UI could not attach from %s", argv[8]);
            return 1;
        }
    }

    // Execute the script
    LOGI("About to call evalScript...");
    // The runtime evaluates its own bootstrap scripts first, so the engine's compile markers
    // fire three times a launch. This brackets the one that is the game.
    mystral::coldStartMark("game_eval_begin");
    bool success = runtime->evalScript(scriptContent, scriptPath);
    LOGI("evalScript returned: %s", success ? "true" : "false");
    if (!success) {
        LOGE("Failed to execute script!");
        // Don't return, let the runtime run anyway for debugging
    } else {
        LOGI("Script executed successfully");
    }

    // Run the main loop
    LOGI("About to call run()...");
    mystral::platform::startGameThreadPriority(gamePriority);
    runtime->run();
    LOGI("run() returned");

    LOGI("Main loop exited");
    return 0;
}

#endif // __ANDROID__
