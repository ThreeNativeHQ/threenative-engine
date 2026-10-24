#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#endif

#include "mystral/async/event_loop.h"
#include "mystral/http/http_client.h"
#include "mystral/http/async_http_client.h"
#include "mystral/fs/async_file.h"
#include "mystral/fs/file_watcher.h"
#include "mystral/js/engine.h"
#include "mystral/webtransport/webtransport.h"
#include "runtime_scripts.h"
#include "../src/raytracing/bindings.h"
#include "../src/raytracing/rt_common.h"
#include "../src/cli/bundler.h"
#include "../src/cli/lightmap.h"
#include "../src/cli/tool_dispatch.h"

#define MYSTRAL_CLI_NO_MAIN 1
#include "../src/cli/main.cpp"
#undef MYSTRAL_CLI_NO_MAIN

#ifndef _WIN32
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>
#endif
#include <chrono>
#include <cstring>
#include <atomic>
#include <cstdlib>
#include <thread>
#include <iostream>
#include <vector>
#include <filesystem>
#include <fstream>

namespace fs = std::filesystem;

// Include the binding implementation a second time with a deterministic
// backend. The production coverage lane normally has only the unavailable
// stub, which can never reach the validation and resource-tracking branches of
// the JavaScript surface. This seam keeps those branches on the real source
// file while leaving the runtime's production symbols untouched.
namespace mystral::rt {

bool g_coverageFailGeometry = false;
bool g_coverageFailBLAS = false;
bool g_coverageFailTLAS = false;
bool g_coverageRayBatch = true;
bool g_coverageFailBatch = false;

class CoverageRTBackend final : public IRTBackend {
public:
    bool isSupported() override { return true; }
    RTBackendType getBackendType() override { return RTBackendType::Vulkan; }
    const char* getBackend() override { return "coverage"; }

    RTGeometryHandle createGeometry(const RTGeometryDesc& desc) override {
        if (g_coverageFailGeometry || desc.vertices == nullptr || desc.vertexCount == 0) {
            return {};
        }
        return {reinterpret_cast<void*>(static_cast<uintptr_t>(0x101)), 0};
    }

    void destroyGeometry(RTGeometryHandle) override {}

    RTBLASHandle createBLAS(RTGeometryHandle* geometries, size_t count) override {
        if (g_coverageFailBLAS || geometries == nullptr || count == 0) return {};
        return {reinterpret_cast<void*>(static_cast<uintptr_t>(0x202)), 0};
    }

    void destroyBLAS(RTBLASHandle) override {}

    RTTLASHandle createTLAS(const RTTLASInstance* instances, size_t count) override {
        if (g_coverageFailTLAS || instances == nullptr || count == 0) return {};
        return {reinterpret_cast<void*>(static_cast<uintptr_t>(0x303)), 0};
    }

    void updateTLAS(RTTLASHandle, const RTTLASInstance*, size_t) override {}
    void destroyTLAS(RTTLASHandle) override {}
    void traceRays(const TraceRaysOptions&) override {}

    RTCapabilities capabilities() override {
        RTCapabilities found;
        found.backend = "coverage";
        found.deviceName = "coverage device";
        found.apiVersion = (1u << 22) | (3u << 12) | 4u;
        found.rayBatch = g_coverageRayBatch;
        found.reason = g_coverageRayBatch ? "" : "the coverage backend has its ray batch switched off";
        found.sharedTransportReason = "the coverage backend has no shared transport";
        return found;
    }

    TraceRayBatchResult traceRayBatch(const TraceRayBatchOptions& options) override {
        TraceRayBatchResult result;
        if (g_coverageFailBatch) {
            result.error = "coverage batch failure";
            return result;
        }
        for (uint32_t i = 0; i < options.rayCount * kHitWords; ++i) options.hits[i] = -1.0f;
        result.ok = true;
        result.gpuMs = 0.5;
        result.totalMs = 1.5;
        return result;
    }

    double sharedTraceGpuMs() override { return 2.5; }
};

// A backend that overrides only what the interface requires, so the default answers of the
// optional ray batch and shared trace calls run on the real header.
class DefaultsRTBackend final : public IRTBackend {
public:
    bool isSupported() override { return false; }
    RTBackendType getBackendType() override { return RTBackendType::None; }
    const char* getBackend() override { return "defaults"; }
    RTGeometryHandle createGeometry(const RTGeometryDesc&) override { return {}; }
    void destroyGeometry(RTGeometryHandle) override {}
    RTBLASHandle createBLAS(RTGeometryHandle*, size_t) override { return {}; }
    void destroyBLAS(RTBLASHandle) override {}
    RTTLASHandle createTLAS(const RTTLASInstance*, size_t) override { return {}; }
    void updateTLAS(RTTLASHandle, const RTTLASInstance*, size_t) override {}
    void destroyTLAS(RTTLASHandle) override {}
    void traceRays(const TraceRaysOptions&) override {}
};

std::unique_ptr<IRTBackend> coverageCreateRTBackend() {
    return std::make_unique<CoverageRTBackend>();
}

}  // namespace mystral::rt

#define createRTBackend coverageCreateRTBackend
#define initializeRTBindings coverageInitializeRTBindings
#define cleanupRTBindings coverageCleanupRTBindings
#include "../src/raytracing/bindings.cpp"
#undef cleanupRTBindings
#undef initializeRTBindings
#undef createRTBackend

namespace {

#ifdef _WIN32
using SocketHandle = SOCKET;
using SocketLength = int;
constexpr SocketHandle kInvalidSocket = INVALID_SOCKET;

void closeSocket(SocketHandle socketHandle) {
    closesocket(socketHandle);
}
#else
using SocketHandle = int;
using SocketLength = socklen_t;
constexpr SocketHandle kInvalidSocket = -1;

void closeSocket(SocketHandle socketHandle) {
    close(socketHandle);
}
#endif

class MockHttpServer {
public:
    MockHttpServer() {
#ifdef _WIN32
        WSADATA winsockData{};
        if (WSAStartup(MAKEWORD(2, 2), &winsockData) != 0) return;
        winsockReady_ = true;
#endif
        serverFd_ = socket(AF_INET, SOCK_STREAM, 0);
        if (serverFd_ == kInvalidSocket) return;
        int opt = 1;
#ifdef _WIN32
        setsockopt(serverFd_, SOL_SOCKET, SO_REUSEADDR, reinterpret_cast<const char*>(&opt), sizeof(opt));
#else
        setsockopt(serverFd_, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));
#endif
        sockaddr_in addr{};
        addr.sin_family = AF_INET;
        addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        addr.sin_port = 0;
        if (bind(serverFd_, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) < 0) return;
        if (listen(serverFd_, 10) < 0) return;
        SocketLength len = sizeof(addr);
        getsockname(serverFd_, reinterpret_cast<sockaddr*>(&addr), &len);
        port_ = ntohs(addr.sin_port);

        running_ = true;
        worker_ = std::thread([this]() {
            while (running_) {
                fd_set fds;
                FD_ZERO(&fds);
                FD_SET(serverFd_, &fds);
                timeval tv{ 0, 50000 };
#ifdef _WIN32
                int r = select(0, &fds, nullptr, nullptr, &tv);
#else
                int r = select(serverFd_ + 1, &fds, nullptr, nullptr, &tv);
#endif
                if (r > 0 && FD_ISSET(serverFd_, &fds)) {
                    SocketHandle clientFd = accept(serverFd_, nullptr, nullptr);
                    if (clientFd != kInvalidSocket) {
                        char buf[1024];
                        recv(clientFd, buf, static_cast<int>(sizeof(buf)), 0);
                        const char* resp = "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nX-Custom-Hdr: test-val\r\nContent-Length: 5\r\n\r\nhello";
                        send(clientFd, resp, static_cast<int>(std::strlen(resp)), 0);
                        closeSocket(clientFd);
                    }
                }
            }
        });
    }

    ~MockHttpServer() {
        running_ = false;
        if (worker_.joinable()) worker_.join();
        if (serverFd_ != kInvalidSocket) closeSocket(serverFd_);
#ifdef _WIN32
        if (winsockReady_) WSACleanup();
#endif
    }

    int port() const { return port_; }
    bool valid() const { return port_ > 0; }

private:
    SocketHandle serverFd_ = kInvalidSocket;
    int port_ = 0;
    std::atomic<bool> running_{ false };
    std::thread worker_;
#ifdef _WIN32
    bool winsockReady_ = false;
#endif
};

void exerciseCliHelpers() {
    const char* keys[] = {
        "KeyA", "KeyB", "KeyC", "KeyD", "KeyE", "KeyF", "KeyG", "KeyH", "KeyI", "KeyJ",
        "KeyK", "KeyL", "KeyM", "KeyN", "KeyO", "KeyP", "KeyQ", "KeyR", "KeyS", "KeyT",
        "KeyU", "KeyV", "KeyW", "KeyX", "KeyY", "KeyZ",
        "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
        "Digit0", "Digit1", "Digit9",
        "Enter", "Return", "Escape", "Esc", "Space", "Backspace", "Tab",
        "ArrowUp", "Up", "ArrowDown", "Down", "ArrowLeft", "Left", "ArrowRight", "Right",
        "Home", "End", "PageUp", "PageDown", "Insert", "Delete",
        "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
        "Shift", "ShiftLeft", "ShiftRight", "Control", "ControlLeft", "ControlRight",
        "Alt", "AltLeft", "AltRight", "Meta", "MetaLeft", "MetaRight",
        "CapsLock", "NumLock", "ScrollLock", "PrintScreen", "Pause",
        "Minus", "-", "Equal", "=", "Plus", "BracketLeft", "[", "BracketRight", "]",
        "Backslash", "\\", "Semicolon", ";", "Quote", "'", "Backquote", "`",
        "Comma", ",", "Period", ".", "Slash", "/", "UnknownKey"
    };
    for (const char* key : keys) keyNameToScancode(key);

    const std::string testJson = R"JSON({
        "title": "My \u0041pp \uD83D\uDE00",
        "escapes": "\"\\/\b\f\n\r\t",
        "width": 1920,
        "height": 1080.5,
        "negative": -42,
        "fullscreen": true,
        "maximized": false,
        "invalidNum": "abc"
    })JSON";
    extractJsonString(testJson, "title");
    extractJsonString(testJson, "escapes");
    extractJsonString(testJson, "missing");
    extractJsonString("{\"bad\": \"unterminated", "bad");
    extractJsonString("{\"bad\": unquoted}", "bad");
    extractJsonString("{\"bad\": \"\\u00\"}", "bad");
    extractJsonString("{\"bad\": \"\\uD800\\u0000\"}", "bad");
    extractJsonString("{\"bad\": \"\\x\"}", "bad");
    extractJsonNumber(testJson, "width", 0);
    extractJsonNumber(testJson, "height", 0);
    extractJsonNumber(testJson, "negative", 0);
    extractJsonNumber(testJson, "invalidNum", 123);
    extractJsonNumber(testJson, "missing", 456);
    extractJsonBool(testJson, "fullscreen", false);
    extractJsonBool(testJson, "maximized", true);
    extractJsonBool(testJson, "missing", false);

    const char* allFlags[] = {
        "mystral", "run", "dummy.js",
        "--width", "1024", "--height", "768", "--title", "Custom Title",
        "--windowed", "--maximized", "--fullscreen", "--include", "assets",
        "--assets", "more_assets", "--output", "out_bin", "--out", "out_bin2",
        "-o", "out_bin3", "--root", ".", "--ui", "ui", "--entry", "main.js",
        "--screenshot", "out.png", "--frames", "30", "--no-vsync", "--quiet", "-q",
        "--headless", "--no-sdl", "--watch", "-w", "--bundle-only", "--video", "test.mp4",
        "--start-frame", "0", "--end-frame", "10", "--video-fps", "30",
        "--video-quality", "90", "--mp4", "--native-capture", "--gpu-capture",
        "--debug-port", "9222", "--debug", "--resolution", "1024", "--samples", "32",
        "--bounces", "2", "--unknown-flag"
    };
    parseArgs(sizeof(allFlags) / sizeof(allFlags[0]), const_cast<char**>(allFlags));

    // Base64 encoding
    const uint8_t b64Sample[] = "ThreeNative Native CLI Integration";
    base64Encode(b64Sample, sizeof(b64Sample) - 1);
    base64Encode(nullptr, 0);

#if TN_ENABLE_DEBUG_SERVER
    // Debug commands
    handleKeyboardDebugCommand("Input.dispatchKeyEvent", "{\"type\":\"rawKeyDown\",\"key\":\"KeyA\"}");
    handleKeyboardDebugCommand("Input.dispatchKeyEvent", "{\"type\":\"keyUp\",\"key\":\"KeyA\"}");
    handleKeyboardDebugCommand("Input.dispatchKeyEvent", "{\"type\":\"invalid\"}");
    handleKeyboardDebugCommand("Input.unknownMethod", "{}");
    handleMouseDebugCommand("Input.dispatchMouseEvent", "{\"type\":\"mouseMoved\",\"x\":10,\"y\":20}");
    handleMouseDebugCommand("Input.dispatchMouseEvent", "{\"type\":\"mousePressed\",\"x\":10,\"y\":20,\"button\":\"left\"}");
    handleMouseDebugCommand("Input.dispatchMouseEvent", "{\"type\":\"mouseReleased\",\"x\":10,\"y\":20,\"button\":\"right\"}");
    handleMouseDebugCommand("Input.dispatchMouseEvent", "{\"type\":\"mouseWheel\",\"x\":10,\"y\":20,\"deltaX\":0,\"deltaY\":-10}");
    handleMouseDebugCommand("Input.dispatchMouseEvent", "{\"type\":\"invalid\"}");
    handleGamepadDebugCommand("Input.dispatchGamepadEvent", "{\"type\":\"connected\",\"index\":0}");
    handleGamepadDebugCommand("Input.dispatchGamepadEvent", "{\"type\":\"button\",\"index\":0,\"button\":0,\"value\":1.0,\"pressed\":true}");
    handleGamepadDebugCommand("Input.dispatchGamepadEvent", "{\"type\":\"axis\",\"index\":0,\"axis\":0,\"value\":0.5}");
    handleGamepadDebugCommand("Input.dispatchGamepadEvent", "{\"type\":\"disconnected\",\"index\":0}");
    handleGamepadDebugCommand("Input.dispatchGamepadEvent", "{\"type\":\"invalid\"}");
#endif

    // Input injection
    injectKeyboardEvent(SDL_SCANCODE_SPACE, true);
    injectKeyboardEvent(SDL_SCANCODE_SPACE, false);
    injectMouseMotion(50.0f, 60.0f);
    injectMouseButton(50.0f, 60.0f, SDL_BUTTON_LEFT, true);
    injectMouseButton(50.0f, 60.0f, SDL_BUTTON_LEFT, false);

    // readFile & helpers
    try { readFile("nonexistent_path_file.txt"); } catch (...) {}
    isFFmpegAvailable();
    convertWebPToMP4("nonexistent.webp", "nonexistent.mp4", 30, false, true);
    javascriptString("test \\ \" \n \r \t \x01 hello");

#ifdef MYSTRAL_HAS_WEBP_MUX
    WebPVideoRecorder recorder(32, 32, 30, 80);
    if (recorder.isValid()) {
        std::vector<uint8_t> rgbaFrame(32 * 32 * 4, 200);
        recorder.addFrame(rgbaFrame.data());
        fs::path webpOut = fs::temp_directory_path() / "test_recorder.webp";
        recorder.save(webpOut.string());
        recorder.getFrameCount();
        fs::remove(webpOut);
    }
#endif
}

bool testCliSubsystem(const fs::path& tempDir) {
    // Test runCli
    char* helpArgv[] = { (char*)"mystral", (char*)"--help" };
    if (mystral::cli::runCli(2, helpArgv) != 0) return false;

    char* verArgv[] = { (char*)"mystral", (char*)"--version" };
    if (mystral::cli::runCli(2, verArgv) != 0) return false;

    char* emptyArgv[] = { (char*)"mystral" };
    if (mystral::cli::runCli(1, emptyArgv) == 0) return false;

    char* unkArgv[] = { (char*)"mystral", (char*)"bogus_cmd" };
    if (mystral::cli::runCli(2, unkArgv) == 0) return false;

    char* runNoScript[] = { (char*)"mystral", (char*)"run" };
    if (mystral::cli::runCli(2, runNoScript) == 0) return false;

    char* compileHelp[] = { (char*)"mystral", (char*)"compile", (char*)"--help" };
    if (mystral::cli::runCli(3, compileHelp) != 0) return false;

    char* bakeHelp[] = { (char*)"mystral", (char*)"bake", (char*)"--help" };
    if (mystral::cli::runCli(3, bakeHelp) != 0) return false;

    char* badRunArgv[] = { (char*)"mystral", (char*)"run", (char*)"non_existent_file_xyz.js", (char*)"--headless" };
    if (mystral::cli::runCli(4, badRunArgv) == 0) return false;

    fs::path testScriptPath = tempDir / "cli_integration_test_script.js";
    {
        std::ofstream out(testScriptPath);
        out << "console.log('cli integration script running');\n"
            << "process.exit(0);\n";
    }
    std::string testScriptStr = testScriptPath.string();

    // Direct test of pngWriteCallback
    std::vector<uint8_t> pngBytes;
    uint8_t sampleData[4] = { 10, 20, 30, 40 };
    pngWriteCallback(&pngBytes, sampleData, 4);
    if (pngBytes.size() != 4 || pngBytes[0] != 10) return false;

    // Test dispatchBuildTool with missing tool
#ifndef _WIN32
    char* toolDispatchArgv[] = { (char*)"threenative", (char*)"compile", nullptr };
    setenv("THREENATIVE_CLI_TOOLS", (tempDir / "nonexistent_tool_exec").string().c_str(), 1);
    int toolDispatchRc = mystral::cli::dispatchBuildTool(2, toolDispatchArgv);
    unsetenv("THREENATIVE_CLI_TOOLS");
    if (toolDispatchRc != 127) {
        std::cerr << "Expected dispatchBuildTool to return 127 for missing tool, got " << toolDispatchRc << "\n";
        return false;
    }
#endif

    // Test parseArgs with full range of options and unknown flag
    {
        std::string tDir = tempDir.string();
        std::string sPath = testScriptStr;
        char* edgeArgv[] = {
            (char*)"mystral",
            (char*)"run",
            (char*)"--root", const_cast<char*>(tDir.c_str()),
            (char*)"--ui", const_cast<char*>(tDir.c_str()),
            (char*)"--entry", const_cast<char*>(sPath.c_str()),
            (char*)"--screenshot", (char*)"shot.png",
            (char*)"--frames", (char*)"5",
            (char*)"--no-vsync",
            (char*)"--quiet",
            (char*)"--headless",
            (char*)"--no-sdl",
            (char*)"--watch",
            (char*)"--bundle-only",
            (char*)"--video", (char*)"out.mp4",
            (char*)"--start-frame", (char*)"2",
            (char*)"--end-frame", (char*)"10",
            (char*)"--video-fps", (char*)"30",
            (char*)"--video-quality", (char*)"80",
            (char*)"--mp4",
            (char*)"--native-capture",
            (char*)"--gpu-capture",
            (char*)"--debug-port", (char*)"9229",
            (char*)"--debug",
            (char*)"--resolution", (char*)"512",
            (char*)"--samples", (char*)"64",
            (char*)"--bounces", (char*)"2",
            (char*)"--unknown-option",
            nullptr
        };
        int edgeArgc = static_cast<int>(sizeof(edgeArgv) / sizeof(edgeArgv[0])) - 1;
        CLIOptions edgeOpts = parseArgs(edgeArgc, edgeArgv);
        if (!edgeOpts.convertToMp4 || edgeOpts.debugPort != 9229 || edgeOpts.bakeResolution != 512) return false;
    }

    // Exercise command-specific positional entries and the alternate recording spelling.
    {
        char* compileArgv[] = { (char*)"mystral", (char*)"compile", (char*)"compile-entry.js", nullptr };
        char* bakeArgv[] = { (char*)"mystral", (char*)"bake", (char*)"scene.glb", nullptr };
        char* recordArgv[] = { (char*)"mystral", (char*)"run", (char*)"game.js", (char*)"--record", (char*)"capture.webp", nullptr };
        char* shortVideoArgv[] = { (char*)"mystral", (char*)"run", (char*)"game.js", (char*)"--video", (char*)"x", nullptr };
        char* missingValueArgv[] = { (char*)"mystral", (char*)"run", (char*)"game.js", (char*)"--width", nullptr };
        const auto compileOpts = parseArgs(3, compileArgv);
        const auto bakeOpts = parseArgs(3, bakeArgv);
        const auto recordOpts = parseArgs(5, recordArgv);
        const auto shortVideoOpts = parseArgs(5, shortVideoArgv);
        parseArgs(4, missingValueArgv);
        if (compileOpts.command != "compile" || compileOpts.scriptPath != "compile-entry.js" ||
            bakeOpts.command != "bake" || bakeOpts.scriptPath != "scene.glb" ||
            recordOpts.videoPath != "capture.webp" || recordOpts.convertToMp4 ||
            shortVideoOpts.videoPath != "x") return false;
    }

    // Test applyEmbeddedConfig with bundle
    fs::path configBundle = tempDir / "config_test.bundle";
    fs::path dotTn = tempDir / ".threenative";
    fs::create_directories(dotTn);
    {
        std::ofstream cfg(dotTn / "config.json");
        cfg << R"JSON({
            "title": "Configured Title",
            "icon": "icon.png",
            "width": 1024,
            "height": 768,
            "fullscreen": false,
            "maximized": true,
            "resizable": true,
            "maxFps": 120,
            "uiRenderer": "web"
        })JSON";
    }
    mystral::cli::BundlerOptions cfgBundleOpts;
    cfgBundleOpts.scriptPath = testScriptStr;
    cfgBundleOpts.rootDir = tempDir.string();
    cfgBundleOpts.assetDirs.push_back(dotTn.string());
    cfgBundleOpts.outputPath = configBundle.string();
    cfgBundleOpts.bundleOnly = true;
    cfgBundleOpts.quiet = true;
    mystral::cli::compileBundle(cfgBundleOpts);

    // Test compileBundle with real dependency tree
    fs::path depEntry = tempDir / "dep_entry.js";
    fs::path depHelper = tempDir / "helper.js";
    fs::path depData = tempDir / "data.json";
    {
        std::ofstream e(depEntry);
        e << "import { foo } from './helper.js';\n"
          << "const d = require('./data.json');\n"
          << "import 'nonexistent-pkg';\n"
          << "console.log(foo, d);\n";
    }
    {
        std::ofstream h(depHelper);
        h << "export const foo = 42;\n";
    }
    {
        std::ofstream d(depData);
        d << "{\"count\": 10}\n";
    }

    mystral::cli::BundlerOptions depBundleOpts;
    depBundleOpts.scriptPath = depEntry.string();
    depBundleOpts.rootDir = tempDir.string();
    depBundleOpts.outputPath = (tempDir / "dep_test.bundle").string();
    depBundleOpts.bundleOnly = true;
    depBundleOpts.quiet = false;
    mystral::cli::compileBundle(depBundleOpts);

    // Test standalone binary compile (bundleOnly = false)
    mystral::cli::BundlerOptions binBundleOpts = depBundleOpts;
    binBundleOpts.outputPath = (tempDir / "dep_test.bin").string();
    binBundleOpts.bundleOnly = false;
    binBundleOpts.runtimePath = mystral::vfs::getExecutablePath();
    mystral::cli::compileBundle(binBundleOpts);

    // Test error cases for compileBundle
    mystral::cli::BundlerOptions errBundleOpts;
    errBundleOpts.scriptPath = "";
    mystral::cli::compileBundle(errBundleOpts);

    errBundleOpts.scriptPath = (tempDir / "missing_entry.js").string();
    mystral::cli::compileBundle(errBundleOpts);

    errBundleOpts.scriptPath = depEntry.string();
    errBundleOpts.rootDir = (tempDir / "missing_root").string();
    mystral::cli::compileBundle(errBundleOpts);

    errBundleOpts.rootDir = (tempDir / "other_root").string();
    fs::create_directories(tempDir / "other_root");
    mystral::cli::compileBundle(errBundleOpts);

#ifndef _WIN32
    setenv("MYSTRAL_BUNDLE", configBundle.string().c_str(), 1);
#else
    _putenv_s("MYSTRAL_BUNDLE", configBundle.string().c_str());
#endif
    CLIOptions embOpts;
    applyEmbeddedConfig(embOpts);
#ifndef _WIN32
    unsetenv("MYSTRAL_BUNDLE");
#else
    _putenv_s("MYSTRAL_BUNDLE", "");
#endif

#ifndef _WIN32
    // The VFS intentionally caches its first bundle lookup. Probe the embedded-config path in a
    // fresh process so the environment override is present before that cache is initialized.
    setenv("MYSTRAL_BUNDLE", configBundle.string().c_str(), 1);
    setenv("TN_CLI_CONFIG_PROBE", "1", 1);
    const pid_t configPid = fork();
    if (configPid == 0) {
        const std::string executable = mystral::vfs::getExecutablePath();
        execl(executable.c_str(), executable.c_str(), "--config-probe", nullptr);
        _exit(127);
    }
    int configStatus = 0;
    waitpid(configPid, &configStatus, 0);
    unsetenv("TN_CLI_CONFIG_PROBE");
    unsetenv("MYSTRAL_BUNDLE");
    if (!WIFEXITED(configStatus) || WEXITSTATUS(configStatus) != 0) return false;
#endif

    // Test runToolsCli
    char* toolUsageArgv[] = { (char*)"mystral-tools" };
    if (mystral::cli::runToolsCli(1, toolUsageArgv) == 0) return false;

    char* toolHelpArgv[] = { (char*)"mystral-tools", (char*)"--help" };
    if (mystral::cli::runToolsCli(2, toolHelpArgv) != 0) return false;

    char* toolCompNoFile[] = { (char*)"mystral-tools", (char*)"compile" };
    if (mystral::cli::runToolsCli(2, toolCompNoFile) == 0) return false;

    char* toolBakeNoFile[] = { (char*)"mystral-tools", (char*)"bake" };
    if (mystral::cli::runToolsCli(2, toolBakeNoFile) == 0) return false;

    fs::path dummyJs = tempDir / "dummy.js";
    std::string dummyJsStr = dummyJs.string();
    {
        std::ofstream out(dummyJs);
        out << "console.log('dummy bundle input');";
    }
    readFile(dummyJsStr);
    fs::path assetsDir = tempDir / "assets";
    fs::create_directories(assetsDir);
    {
        std::ofstream assetFile(assetsDir / "test.txt");
        assetFile << "asset content";
    }

    // Test BundlerOptions & compileBundle
    mystral::cli::BundlerOptions bundleOpts;
    bundleOpts.scriptPath = dummyJsStr;
    bundleOpts.rootDir = tempDir.string();
    bundleOpts.assetDirs.push_back(assetsDir.string());
    bundleOpts.outputPath = (tempDir / "out.bundle").string();
    bundleOpts.bundleOnly = true;
    bundleOpts.quiet = true;
    mystral::cli::compileBundle(bundleOpts);

    bundleOpts.bundleOnly = false;
    bundleOpts.outputPath = (tempDir / "out_app").string();
    mystral::cli::compileBundle(bundleOpts);

    // Multi-file dependency bundling
    fs::path depA = tempDir / "depA.js";
    { std::ofstream f(depA); f << "import { b } from './depB.js'; export const a = 1;"; }
    fs::path depB = tempDir / "depB.js";
    { std::ofstream f(depB); f << "const c = require('./depC.js'); export const b = 2;"; }
    fs::path depC = tempDir / "depC.js";
    { std::ofstream f(depC); f << "module.exports = { c: 3 };"; }
    fs::path depD = tempDir / "depD.ts";
    { std::ofstream f(depD); f << "export const d: number = 4;"; }
    fs::path depMain = tempDir / "depMain.js";
    { std::ofstream f(depMain); f << "import './depA.js'; import './depD.ts';"; }

    mystral::cli::BundlerOptions multiOpts;
    multiOpts.scriptPath = depMain.string();
    multiOpts.rootDir = tempDir.string();
    multiOpts.outputPath = (tempDir / "multi.bundle").string();
    multiOpts.bundleOnly = true;
    multiOpts.quiet = true;
    mystral::cli::compileBundle(multiOpts);

    mystral::cli::BundlerOptions badOpts;
    badOpts.scriptPath = (tempDir / "nonexistent.js").string();
    mystral::cli::compileBundle(badOpts);

    // Test LightmapOptions & bakeLightmaps
    mystral::cli::LightmapOptions bakeOpts;
    bakeOpts.scriptPath = dummyJsStr;
    bakeOpts.outputPath = (tempDir / "lightmaps").string();
    bakeOpts.bakeResolution = 512;
    bakeOpts.bakeSamples = 16;
    bakeOpts.bakeBounces = 1;
    bakeOpts.quiet = true;
    mystral::cli::bakeLightmaps(bakeOpts);

    // GLB lightmap bake path
    fs::path dummyGlb = tempDir / "scene.glb";
    { std::ofstream f(dummyGlb); f << "glTF-binary-mock"; }
    mystral::cli::LightmapOptions glbBakeOpts = bakeOpts;
    glbBakeOpts.scriptPath = dummyGlb.string();
    mystral::cli::bakeLightmaps(glbBakeOpts);

    // Tool dispatch with valid helper
    fs::path toolsBinary = fs::current_path() / "mystral-tools";
    if (fs::exists(toolsBinary)) {
#ifndef _WIN32
        setenv("THREENATIVE_CLI_TOOLS", toolsBinary.string().c_str(), 1);
        pid_t dPid = fork();
        if (dPid == 0) {
            char* dispatchArgv[] = {
                const_cast<char*>("mystral-tools"),
                const_cast<char*>("--help"),
                nullptr
            };
            int rc = mystral::cli::dispatchBuildTool(2, dispatchArgv);
            _exit(rc);
        }
        int dStatus = 0;
        waitpid(dPid, &dStatus, 0);
        unsetenv("THREENATIVE_CLI_TOOLS");
#endif
    }

    // All fork/exec probes above finish before any runtime is created. This keeps the child from
    // inheriting a V8/Dawn worker or a locked runtime mutex.
    CLIOptions bannerOpts;
    bannerOpts.scriptPath = testScriptStr;
    bannerOpts.width = 256;
    bannerOpts.height = 256;
    bannerOpts.maxFps = 60;
    bannerOpts.headless = true;
    bannerOpts.quiet = true;
    setupHeadlessEnvironment(bannerOpts);
    printRunBanner(bannerOpts, false, false);
    printRunBanner(bannerOpts, true, false);
    printRunBanner(bannerOpts, false, true);
    auto runtime = createConfiguredRuntime(bannerOpts);
    if (!runtime || !wirePlaytestMailboxBridge(runtime)) return false;

    char* runArgv[] = {
        (char*)"mystral",
        (char*)"run",
        const_cast<char*>(testScriptStr.c_str()),
        (char*)"--no-sdl",
        (char*)"--quiet",
        nullptr
    };
    if (mystral::cli::runCli(5, runArgv) != 0) return false;

    // Direct runScript invocations in test mode (MYSTRAL_CLI_NO_MAIN)
    CLIOptions directRunOpts;
    directRunOpts.scriptPath = testScriptStr;
    directRunOpts.noSdl = true;
    directRunOpts.headless = true;
    directRunOpts.quiet = true;
    if (runScript(directRunOpts) != 0) return false;

    CLIOptions directShotOpts = directRunOpts;
    directShotOpts.screenshotPath = (tempDir / "direct_shot.png").string();
    directShotOpts.frames = 1;
    // --no-sdl has no presented frame to save; the CLI must fail closed rather than report a
    // screenshot that was never written.
    if (runScript(directShotOpts) != 1) return false;

    CLIOptions directVidOpts = directRunOpts;
    directVidOpts.videoPath = (tempDir / "direct_vid.mp4").string();
    const int directVideoResult = runScript(directVidOpts);
#if TN_ENABLE_VIDEO
    if (directVideoResult != 0) return false;
#else
    if (directVideoResult == 0) return false;
#endif

    std::string tempDirStr = tempDir.string();
    std::string lmDirStr = (tempDir / "lm").string();

    char* toolCompArgv[] = {
        (char*)"mystral-tools",
        (char*)"compile",
        (char*)dummyJsStr.c_str(),
        (char*)"--output", (char*)tempDirStr.c_str(),
        (char*)"--root", (char*)tempDirStr.c_str(),
        (char*)"--bundle-only",
        (char*)"--quiet"
    };
    mystral::cli::runToolsCli(8, toolCompArgv);

    char* toolBakeArgv[] = {
        (char*)"mystral-tools",
        (char*)"bake",
        (char*)dummyJsStr.c_str(),
        (char*)"--output", (char*)lmDirStr.c_str(),
        (char*)"--resolution", (char*)"512",
        (char*)"--samples", (char*)"16",
        (char*)"--bounces", (char*)"1",
        (char*)"--debug",
        (char*)"--quiet"
    };
    mystral::cli::runToolsCli(12, toolBakeArgv);

    char* dispatchArgv[] = { (char*)"mystral", (char*)"compile", (char*)"dummy.js", nullptr };
#ifdef _WIN32
    _putenv_s("THREENATIVE_CLI_TOOLS", "/nonexistent/tool/mystral-tools");
#else
    setenv("THREENATIVE_CLI_TOOLS", "/nonexistent/tool/mystral-tools", 1);
#endif
    mystral::cli::dispatchBuildTool(3, dispatchArgv);
#ifdef _WIN32
    _putenv_s("THREENATIVE_CLI_TOOLS", "");
#else
    unsetenv("THREENATIVE_CLI_TOOLS");
#endif

    // Test all CLI parsing and helper branches in the production translation unit.
    exerciseCliHelpers();

    return true;
}

bool testHttpSubsystem() {
    auto& loop = mystral::async::EventLoop::instance();
    loop.init();
    loop.init();
    loop.isAvailable();
    loop.handle();
    loop.hasPendingWork();

    MockHttpServer server;
    if (!server.valid()) {
        std::cerr << "could not start the loopback HTTP fixture\n";
        loop.shutdown();
        return false;
    }
    std::string serverUrl = "http://127.0.0.1:" + std::to_string(server.port()) + "/test";

    // Synchronous HttpClient
    mystral::http::HttpClient client;
    mystral::http::HttpOptions opts;
    opts.timeout = 1;
    opts.headers["X-Test"] = "HeaderVal";
    const auto response = client.get(serverUrl, opts);
    if (!response.ok || response.status != 200 ||
        std::string(response.data.begin(), response.data.end()) != "hello") {
        std::cerr << "loopback HTTP response did not match the fixture\n";
        loop.shutdown();
        return false;
    }
    client.post(serverUrl, { 1, 2, 3 }, opts);
    client.request("PUT", serverUrl, { 4, 5 }, opts);
    client.request("DELETE", serverUrl, {}, opts);
    client.request("HEAD", serverUrl, {}, opts);

    // Error cases
    if (client.get("http://127.0.0.1:0/nonexistent", opts).ok) {
        std::cerr << "unreachable HTTP endpoint reported success\n";
        loop.shutdown();
        return false;
    }
    mystral::http::getHttpClient().get(serverUrl, opts);

    // Asynchronous HttpClient
    auto& asyncClient = mystral::http::AsyncHttpClient::instance();
    asyncClient.init();
    if (asyncClient.isReady()) {
        asyncClient.get(serverUrl, [](mystral::http::HttpResponse) {}, opts);
        asyncClient.post(serverUrl, { 1, 2 }, [](mystral::http::HttpResponse) {}, opts);
        asyncClient.request("PUT", serverUrl, { 3 }, [](mystral::http::HttpResponse) {}, opts);
        asyncClient.request("DELETE", serverUrl, {}, [](mystral::http::HttpResponse) {}, opts);
        asyncClient.activeRequestCount();
        for (int i = 0; i < 10; ++i) {
            loop.runOnce();
            std::this_thread::sleep_for(std::chrono::milliseconds(5));
        }
        asyncClient.processCompletedRequests();
    }
    asyncClient.shutdown();
    mystral::http::getAsyncHttpClient();
    loop.shutdown();

    return true;
}

bool testFsSubsystem(const fs::path& tempDir) {
    fs::path testFile = tempDir / "async_test.txt";
    {
        std::ofstream out(testFile);
        out << "async content";
    }

    // Test sync fallback when not initialized
    mystral::fs::readFileAsync(testFile.string(), [](std::vector<uint8_t>, std::string) {});
    mystral::fs::readFileAsync("nonexistent_sync.txt", [](std::vector<uint8_t>, std::string) {});

    auto& loop = mystral::async::EventLoop::instance();
    loop.init();

    // AsyncFileReader with loop initialized
    auto& reader = mystral::fs::AsyncFileReader::instance();
    reader.init();
    if (reader.isReady()) {
        reader.readFile(testFile.string(), [](std::vector<uint8_t>, std::string) {});
        reader.readFile("nonexistent_path_xyz.txt", [](std::vector<uint8_t>, std::string) {});
        for (int i = 0; i < 5; ++i) {
            loop.runOnce();
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
        }
        reader.processCompletedReads();
    }
    reader.shutdown();
    mystral::fs::getAsyncFileReader();

    // FileWatcher
    auto& watcher = mystral::fs::FileWatcher::instance();
    watcher.init();
    if (watcher.isReady()) {
        bool changeObserved = false;
        int watchId = watcher.watch(tempDir.string(), [&](const std::string&, mystral::fs::FileChangeType) {
            changeObserved = true;
        });
        // Trigger a file change
        {
            std::ofstream out(testFile, std::ios::app);
            out << " more";
        }
        for (int i = 0; i < 5; ++i) {
            loop.runOnce();
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
        }
        watcher.processPendingEvents();
        if (watchId >= 0) {
            watcher.unwatch(watchId);
        }
    }
    watcher.shutdown();
    mystral::fs::getFileWatcher();
    loop.shutdown();

    return true;
}

bool testRaytracingAndWebTransport() {
    auto engine = mystral::js::createEngine();
    if (!engine) return false;

#ifndef _WIN32
    setenv("MYSTRAL_TEST_MOCK_RT", "1", 1);
#else
    _putenv_s("MYSTRAL_TEST_MOCK_RT", "1");
#endif

    auto backend = mystral::rt::createRTBackend();
    if (backend->getBackendType() == mystral::rt::RTBackendType::None && backend->isSupported()) {
        std::cerr << "unavailable ray tracing became supported through an environment variable\n";
        return false;
    }
    const auto require = [](bool condition, const char* message) {
        if (!condition) std::cerr << message << "\n";
        return condition;
    };
    if (!require(backend->getBackend() != nullptr, "ray tracing backend exposes a stable name") ||
        !require(std::string(mystral::rt::getBackendName(mystral::rt::RTBackendType::None)) == "none",
                 "ray tracing names the stub backend") ||
        !require(std::string(mystral::rt::getBackendName(mystral::rt::RTBackendType::DXR)) == "dxr",
                 "ray tracing names the DXR backend") ||
        !require(std::string(mystral::rt::getBackendName(mystral::rt::RTBackendType::Vulkan)) == "vulkan",
                 "ray tracing names the Vulkan backend") ||
        !require(std::string(mystral::rt::getBackendName(mystral::rt::RTBackendType::Metal)) == "metal",
                 "ray tracing names the Metal backend")) {
        return false;
    }
    const mystral::rt::RTGeometryDesc emptyGeometry{};
    auto geometry = backend->createGeometry(emptyGeometry);
    auto blas = backend->createBLAS(nullptr, 0);
    auto tlas = backend->createTLAS(nullptr, 0);
    backend->updateTLAS(tlas, nullptr, 0);
    backend->traceRays(mystral::rt::TraceRaysOptions{});
    backend->destroyGeometry(geometry);
    backend->destroyBLAS(blas);
    backend->destroyTLAS(tlas);

    // Raytracing bindings
    mystral::rt::initializeRTBindings(engine.get());
    const char* rtScript = R"JS((() => {
      if (typeof mystralRT !== 'undefined') {
        if (mystralRT.isSupported()) throw new Error('native ray tracing has no readable result');
        mystralRT.getBackend();
        const vtx = new Float32Array([0,0,0, 1,0,0, 0,1,0]);
        const idx = new Uint32Array([0, 1, 2]);
        const geom = mystralRT.createGeometry({
          vertices: vtx,
          indices: idx,
          vertexStride: 12,
        });
        const blas = mystralRT.createBLAS([geom]);
        const xform = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
        const tlas = mystralRT.createTLAS([{
          blas: blas,
          transform: xform,
          instanceId: 1,
          mask: 0xFF
        }]);
        mystralRT.updateTLAS(tlas, [{
          blas: blas,
          transform: xform,
          instanceId: 1,
          mask: 0xFF
        }]);
        let traceRejected = false;
        try {
          mystralRT.traceRays({
            tlas: tlas,
            width: 64,
            height: 64
          });
        } catch (e) {
          traceRejected = String(e).includes('TN_NATIVE_RAYTRACING_UNAVAILABLE');
        }
        if (!traceRejected) throw new Error('traceRays must reject without copy-out interop');
        mystralRT.destroyGeometry(geom);
        mystralRT.destroyBLAS(blas);
        mystralRT.destroyTLAS(tlas);

        try { mystralRT.createGeometry({}); } catch (e) {}
        try { mystralRT.createBLAS([]); } catch (e) {}
        try { mystralRT.createTLAS([]); } catch (e) {}
        try { mystralRT.updateTLAS(null, []); } catch (e) {}
        try { mystralRT.destroyGeometry(null); } catch (e) {}
        try { mystralRT.destroyBLAS(null); } catch (e) {}
        try { mystralRT.destroyTLAS(null); } catch (e) {}
      } else {
        throw new Error('ray tracing bindings are missing');
      }
    })())JS";
    const bool rtPassed = engine->evalScript(rtScript, "rt_test.js");
    mystral::rt::cleanupRTBindings();
#ifndef _WIN32
    unsetenv("MYSTRAL_TEST_MOCK_RT");
#else
    _putenv_s("MYSTRAL_TEST_MOCK_RT", "");
#endif

    // Re-run the binding source with a deterministic supported backend so the
    // contract covers argument validation, handle tracking, cleanup, and the
    // successful geometry/BLAS/TLAS paths that hardware-free CI cannot reach.
    if (mystral::rt::coverageInitializeRTBindings(nullptr)) {
        std::cerr << "ray tracing bindings accepted a null engine\n";
        return false;
    }
    if (!mystral::rt::coverageInitializeRTBindings(engine.get())) {
        std::cerr << "coverage ray tracing bindings failed to initialize\n";
        return false;
    }
    const char* coverageRtScript = R"JS((() => {
      const vtx = new Float32Array([0,0,0, 1,0,0, 0,1,0]);
      const idx = new Uint32Array([0, 1, 2]);
      const identity = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
      const geom = mystralRT.createGeometry({
        vertices: vtx, indices: idx, vertexStride: 12, vertexOffset: 0
      });
      if (!geom || geom._type !== 'geometry') throw new Error('coverage geometry missing');
      const blas = mystralRT.createBLAS([geom]);
      if (!blas || blas._type !== 'blas') throw new Error('coverage BLAS missing');
      const tlas = mystralRT.createTLAS([{
        blas, transform: identity, instanceId: 7
      }]);
      if (!tlas || tlas._type !== 'tlas') throw new Error('coverage TLAS missing');
      mystralRT.updateTLAS(tlas, [{ blas, transform: new Float32Array([1,2,3]) }]);
      mystralRT.destroyGeometry(geom);
      mystralRT.destroyBLAS(blas);
      mystralRT.destroyTLAS(tlas);

      // Invalid argument and missing-handle paths return the documented null or undefined.
      if (mystralRT.createGeometry() !== null) throw new Error('missing geometry options accepted');
      if (mystralRT.createGeometry({ vertices: new Uint8Array([1]) }) !== null) {
        throw new Error('wrong geometry data accepted');
      }
      if (mystralRT.createBLAS() !== null || mystralRT.createBLAS([]) !== null) {
        throw new Error('invalid BLAS arguments accepted');
      }
      if (mystralRT.createTLAS() !== null || mystralRT.createTLAS([]) !== null) {
        throw new Error('invalid TLAS arguments accepted');
      }
      mystralRT.updateTLAS();
      mystralRT.updateTLAS({}, []);
      mystralRT.updateTLAS({}, 'not-an-array');
      mystralRT.destroyGeometry();
      mystralRT.destroyBLAS();
      mystralRT.destroyTLAS();
      mystralRT.destroyGeometry({ _id: 999999 });
      mystralRT.destroyBLAS({ _id: 999999 });
      mystralRT.destroyTLAS({ _id: 999999 });
      if (mystralRT.isSupported() !== false || mystralRT.getBackend() !== 'coverage') {
        throw new Error('coverage backend query mismatch');
      }
      return true;
    })())JS";
    if (!engine->evalScript(coverageRtScript, "raytracing_supported_test.js")) {
        std::cerr << "supported ray tracing binding contract failed\n";
        return false;
    }

    // Exercise backend failure returns while the JS surface is still fully initialized.
    const char* coverageGeometryFailureScript = R"JS((() => {
      const vtx = new Float32Array([0,0,0, 1,0,0, 0,1,0]);
      const geom = mystralRT.createGeometry({ vertices: vtx });
      if (geom !== null) throw new Error('failed geometry was returned');
      return true;
    })())JS";
    const char* coverageBlasFailureScript = R"JS((() => {
      const vtx = new Float32Array([0,0,0, 1,0,0, 0,1,0]);
      const validGeom = mystralRT.createGeometry({ vertices: vtx });
      if (!validGeom) throw new Error('valid geometry missing before BLAS failure');
      const blas = mystralRT.createBLAS([validGeom]);
      if (blas !== null) throw new Error('failed BLAS was returned');
      return true;
    })())JS";
    const char* coverageTlasFailureScript = R"JS((() => {
      const vtx = new Float32Array([0,0,0, 1,0,0, 0,1,0]);
      const validGeom = mystralRT.createGeometry({ vertices: vtx });
      const validBlas = mystralRT.createBLAS([validGeom]);
      if (!validBlas) throw new Error('valid BLAS missing before TLAS failure');
      const tlas = mystralRT.createTLAS([{ blas: validBlas }]);
      if (tlas !== null) throw new Error('failed TLAS was returned');
      return true;
    })())JS";
    mystral::rt::g_coverageFailGeometry = true;
    if (!engine->evalScript(coverageGeometryFailureScript, "raytracing_geometry_failure_test.js")) return false;
    mystral::rt::g_coverageFailGeometry = false;
    mystral::rt::g_coverageFailBLAS = true;
    if (!engine->evalScript(coverageBlasFailureScript, "raytracing_blas_failure_test.js")) return false;
    mystral::rt::g_coverageFailBLAS = false;
    mystral::rt::g_coverageFailTLAS = true;
    if (!engine->evalScript(coverageTlasFailureScript, "raytracing_tlas_failure_test.js")) return false;
    mystral::rt::g_coverageFailTLAS = false;

    // The optional calls keep refusing by name on a backend that overrides none of them.
    {
        mystral::rt::DefaultsRTBackend defaults;
        const auto batch = defaults.traceRayBatch(mystral::rt::TraceRayBatchOptions{});
        const auto setup = defaults.createSharedTrace(16);
        defaults.destroySharedTrace();
        const auto shared = defaults.traceShared(mystral::rt::SharedTraceOptions{});
        const auto found = defaults.capabilities();
        if (batch.ok || batch.error.find("defaults") == std::string::npos || setup.ok ||
            shared.ok || defaults.sharedTraceGpuMs() != 0 || found.backend != "defaults" ||
            found.reason.empty()) {
            std::cerr << "default ray batch and shared trace answers changed\n";
            return false;
        }
    }

    // The ray batch bindings: capabilities, argument validation, success, backend failure and the
    // host that has no batch path. The GPU variant is unavailable here, so it must refuse by name.
    const char* coverageBatchScript = R"JS((() => {
      const vtx = new Float32Array([0,0,0, 1,0,0, 0,1,0]);
      const geom = mystralRT.createGeometry({ vertices: vtx });
      const blas = mystralRT.createBLAS([geom]);
      const tlas = mystralRT.createTLAS([{ blas }]);
      const caps = mystralRT.capabilities();
      if (caps.backend !== 'coverage' || caps.apiVersion !== '1.3.4' || caps.rayBatch !== true ||
          caps.sharedTransport !== false || caps.sharedTransportReason.length === 0) {
        throw new Error('coverage capabilities mismatch');
      }
      const code = (fn) => { try { fn(); } catch (e) { return String(e); } return ''; };
      const rays = new Float32Array(16);
      const hits = new Float32Array(8);
      const result = mystralRT.traceRayBatch({ tlas, rays, hits });
      if (result.rayCount !== 2 || result.gpuMs !== 0.5 || result.totalMs !== 1.5 || hits[0] !== -1) {
        throw new Error('coverage ray batch result mismatch');
      }
      if (mystralRT.traceRayBatch({ tlas, rays, hits, rayCount: 1 }).rayCount !== 1) {
        throw new Error('coverage ray batch count ignored');
      }
      const invalid = [
        () => mystralRT.traceRayBatch(),
        () => mystralRT.traceRayBatch({ tlas: {}, rays, hits }),
        () => mystralRT.traceRayBatch({ tlas, rays: new Float32Array(7), hits }),
        () => mystralRT.traceRayBatch({ tlas, rays }),
        () => mystralRT.traceRayBatch({ tlas, rays, hits, rayCount: 3 }),
        () => mystralRT.traceRayBatch({ tlas, rays, hits, rayCount: 1.5 }),
        () => mystralRT.traceRayBatch({ tlas, rays, hits: new Float32Array(4) }),
        () => mystralRT.traceRayBatchGpu(),
      ];
      for (const fn of invalid) {
        if (!code(fn).includes('TN_NATIVE_RAYTRACING_')) throw new Error('invalid batch accepted: ' + fn);
      }
      if (!code(() => mystralRT.traceRayBatchGpu({ tlas, rays, hits, rayCount: 1 }))
        .includes('TN_NATIVE_RAYTRACING_UNAVAILABLE')) {
        throw new Error('GPU batch must be unavailable without a shared transport');
      }
      if (mystralRT.sharedBatchGpuMs() !== 2.5) throw new Error('shared GPU time mismatch');
      globalThis.__coverageBatch = { code, tlas, rays, hits };
      return true;
    })())JS";
    if (!engine->evalScript(coverageBatchScript, "raytracing_batch_test.js")) {
        std::cerr << "ray batch binding contract failed\n";
        return false;
    }
    mystral::rt::g_coverageFailBatch = true;
    if (!engine->evalScript(R"JS((() => {
      const { code, tlas, rays, hits } = globalThis.__coverageBatch;
      if (!code(() => mystralRT.traceRayBatch({ tlas, rays, hits })).includes('TN_NATIVE_RAYTRACING_BATCH_FAILED')) {
        throw new Error('a failed batch must throw by name');
      }
      return true;
    })())JS", "raytracing_batch_failure_test.js")) {
        std::cerr << "ray batch failure contract failed\n";
        return false;
    }
    mystral::rt::g_coverageFailBatch = false;
    mystral::rt::g_coverageRayBatch = false;
    if (!engine->evalScript(R"JS((() => {
      const { code, tlas, rays, hits } = globalThis.__coverageBatch;
      if (!code(() => mystralRT.traceRayBatch({ tlas, rays, hits })).includes('TN_NATIVE_RAYTRACING_UNAVAILABLE')) {
        throw new Error('a host without a batch path must throw by name');
      }
      return true;
    })())JS", "raytracing_batch_unavailable_test.js")) {
        std::cerr << "ray batch unavailable contract failed\n";
        return false;
    }
    mystral::rt::g_coverageRayBatch = true;
    mystral::rt::coverageCleanupRTBindings();

    // WebTransport bindings.
    //
    // The streams polyfill first, exactly as Runtime::init sequences it: setupFetch() installs
    // Web Streams before webtransport::initBindings(). The WebTransport polyfill installs nothing
    // when ReadableStream/WritableStream are absent - deliberately, with a console error - and
    // webtransport.cpp then reads globalThis.__wtDispatch, finds nothing, and fails:
    //   [error] [WebTransport] Web Streams not available; WebTransport disabled.
    //   [WebTransport] __wtDispatch not defined by polyfill
    // This engine is created bare by createEngine(), so without this the test drove initBindings
    // outside the prerequisite it documents.
    {
        const auto streams = mystral::runtime_scripts::find("streams-polyfill");
        if (!streams.data) {
            std::cerr << "embedded streams-polyfill missing" << std::endl;
            return false;
        }
        const std::string streamsSource(streams.data, streams.size);
        if (!engine->eval(streamsSource.c_str(), "streams-polyfill.js")) {
            std::cerr << "streams-polyfill eval failed: " << engine->getException() << std::endl;
            return false;
        }
    }
    mystral::webtransport::init();
    if (!mystral::webtransport::initBindings(engine.get())) {
        std::cerr << "webtransport::initBindings failed after installing Web Streams" << std::endl;
        return false;
    }
    const char* wtScript = R"JS((() => {
      // Error and boundary cases
      __wtConnect("");
      __wtConnect("http://not-https:4433");
      __wtConnect("https://bad:0");
      __wtSendDatagram(9999, new Uint8Array([1]));
      __wtCreateStream(9999, true);
      __wtCreateStream(9999, false);
      __wtStreamWrite(9999, 0, new Uint8Array([1]), false);
      __wtStreamShutdown(9999, 0, 0);
      __wtClose(9999, 0, "test");
      try {
        __wtNativeStats();
        __wtStreamReadCredit(9999, 0, 1024);
        __wtStreamReadCredit(9999, 0, -1);
        __wtStreamReleaseRead(9999, 0);
        __wtMaxDatagramSize(9999);
        __wtSendStreamsBudget(9999, true);
        __wtReceiveStreamsBudget(9999, false);
      } catch (e) {}

      const id = __wtConnect("https://127.0.0.1:4433/test");
      if (typeof id === 'number' && id > 0) {
        __wtSendDatagram(id, new Uint8Array([1, 2, 3]));
        __wtCreateStream(id, true);
        __wtCreateStream(id, false);
        __wtStreamWrite(id, 0, new Uint8Array([4, 5]), false);
        __wtStreamShutdown(id, 0, 0);
        __wtClose(id, 0, "test-close");
      }
    })())JS";
    const bool wtPassed = engine->evalScript(wtScript, "wt_test.js");
    mystral::webtransport::processEvents();
    mystral::webtransport::hasActiveSessions();
    mystral::webtransport::shutdown();

    // Name which half failed. This returned a bare `false` before, so the contract runner could
    // only report "exited 1" and the cause had to be guessed from surrounding log noise - the
    // engine prints caught exceptions too, so the loudest line is routinely not the failure. Both
    // halves are `engine->evalScript`, and a script that throws returns false here.
    if (!rtPassed) {
        std::cerr << "TN_CLI_NETWORK_FS_RT_SCRIPT_FAILED: rt_test.js did not evaluate cleanly: "
                  << engine->getException() << std::endl;
    }
    if (!wtPassed) {
        std::cerr << "TN_CLI_NETWORK_FS_WT_SCRIPT_FAILED: wt_test.js did not evaluate cleanly: "
                  << engine->getException() << std::endl;
    }
    return rtPassed && wtPassed;
}

}  // namespace

int main() {
#ifndef _WIN32
    if (std::getenv("TN_CLI_CONFIG_PROBE") != nullptr) {
        CLIOptions probe;
        applyEmbeddedConfig(probe);
        if (probe.title != "Configured Title" || probe.iconPath != "icon.png" ||
            probe.width != 1024 || probe.height != 768 || !probe.maximized ||
            !probe.resizable || probe.maxFps != 120 || probe.uiRoot != "ui") return 1;
        return 0;
    }
#endif
    fs::path tempDir = fs::temp_directory_path() / "tn_cli_net_fs_test";
    fs::remove_all(tempDir);
    fs::create_directories(tempDir);

    bool ok = true;
    if (!testCliSubsystem(tempDir)) {
        std::cerr << "testCliSubsystem failed\n";
        ok = false;
    }
    if (!testHttpSubsystem()) {
        std::cerr << "testHttpSubsystem failed\n";
        ok = false;
    }
    if (!testFsSubsystem(tempDir)) {
        std::cerr << "testFsSubsystem failed\n";
        ok = false;
    }
    if (!testRaytracingAndWebTransport()) {
        std::cerr << "testRaytracingAndWebTransport failed\n";
        ok = false;
    }

    fs::remove_all(tempDir);
    if (!ok) return 1;

    std::cout << "native CLI network and FS comprehensive contract passed\n";
    return 0;
}
