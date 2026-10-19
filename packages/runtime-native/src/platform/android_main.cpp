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
    runtime->run();
    LOGI("run() returned");

    LOGI("Main loop exited");
    return 0;
}

#endif // __ANDROID__
