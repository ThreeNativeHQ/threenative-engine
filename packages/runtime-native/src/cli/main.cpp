/**
 * Mystral CLI
 *
 * Command-line interface for running Mystral applications.
 *
 * Usage:
 *   mystral run <script.js>                    Run a JavaScript file
 *   mystral run <script.js> --screenshot out.png  Run, screenshot, quit
 *   mystral --version                          Show version information
 *   mystral --help                             Show help
 */

#include "mystral/js/engine.h"
#include "mystral/cold_start.h"
#include "mystral/runtime.h"
#include "../webgpu/pipeline_cache.h"
#include "mystral/screenshot_gate.h"
#include "tool_dispatch.h"
#include "mystral/platform/ui_overlay.h"
#include "mystral/platform/window.h"
#include "mystral/vfs/embedded_bundle.h"
#include "mystral/debug/debug_server.h"
#include "mystral/video/async_capture.h"
#include "mystral/video/video_recorder.h"
#include <iostream>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>
#include <filesystem>
#include <cstdint>
#include <cstring>
#include <chrono>
#include <csignal>
#include <thread>
#include <condition_variable>
#include <cstdlib>
#include <queue>
#include <array>
#include <cmath>
#include <atomic>

#if defined(__APPLE__)
#include <dlfcn.h>

static void dumpLlvmProfile() {
    using ProfileDump = void (*)();
    const auto dump = reinterpret_cast<ProfileDump>(dlsym(RTLD_DEFAULT, "__llvm_profile_dump"));
    if (dump) dump();
}
#elif defined(__GNUC__) || defined(__clang__)
extern "C" void __llvm_profile_dump(void) __attribute__((weak));
static void dumpLlvmProfile() {
    if (__llvm_profile_dump) __llvm_profile_dump();
}
#else
static void dumpLlvmProfile() {}
#endif

#if TN_JS_PROFILE || TN_ANDROID_JS_PROFILE
// Flush a requested CPU profile before a deliberate `_exit`, which runs no destructor. Idempotent.
static int finalizeCpuProfile(int exitCode) {
    if (mystral::js::g_dumpCpuProfile) mystral::js::g_dumpCpuProfile();
    return mystral::js::g_cpuProfileFailed ? 1 : exitCode;
}
#else
static int finalizeCpuProfile(int exitCode) { return exitCode; }
#endif

// WebP animation encoding (for video recording)
#ifdef MYSTRAL_HAS_WEBP_MUX
#include <webp/encode.h>
#include <webp/mux.h>
#endif

// stb_image_write for PNG encoding (implementation is in stb_impl.cpp)
typedef void (*stbi_write_func)(void *context, void *data, int size);
extern "C" int stbi_write_png_to_func(stbi_write_func func, void *context, int w, int h, int comp, const void *data, int stride_in_bytes);

// SDL3 for input injection
#include <SDL3/SDL.h>

// Base64 encoding for screenshot data
static std::string base64Encode(const uint8_t* data, size_t len) {
    static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string result;
    result.reserve((len + 2) / 3 * 4);

    for (size_t i = 0; i < len; i += 3) {
        uint32_t n = static_cast<uint32_t>(data[i]) << 16;
        if (i + 1 < len) n |= static_cast<uint32_t>(data[i + 1]) << 8;
        if (i + 2 < len) n |= data[i + 2];

        result += alphabet[(n >> 18) & 0x3F];
        result += alphabet[(n >> 12) & 0x3F];
        result += (i + 1 < len) ? alphabet[(n >> 6) & 0x3F] : '=';
        result += (i + 2 < len) ? alphabet[n & 0x3F] : '=';
    }
    return result;
}

static std::string javascriptString(const std::string& value) {
    static const char hex[] = "0123456789abcdef";
    std::string result = "\"";
    for (unsigned char character : value) {
        switch (character) {
            case '\\': result += "\\\\"; break;
            case '"': result += "\\\""; break;
            case '\n': result += "\\n"; break;
            case '\r': result += "\\r"; break;
            case '\t': result += "\\t"; break;
            default:
                if (character < 0x20) {
                    result += "\\u00";
                    result.push_back(hex[(character >> 4) & 0x0f]);
                    result.push_back(hex[character & 0x0f]);
                } else {
                    result.push_back(static_cast<char>(character));
                }
                break;
        }
    }
    result += "\"";
    return result;
}

// PNG write callback for stbi_write_png_to_func
static void pngWriteCallback(void* context, void* data, int size) {
    auto* buffer = static_cast<std::vector<uint8_t>*>(context);
    const uint8_t* bytes = static_cast<const uint8_t*>(data);
    buffer->insert(buffer->end(), bytes, bytes + size);
}

// ============================================================================
// SDL Input Injection for Debug Server
// ============================================================================

/**
 * Map key name to SDL scancode
 * Supports both Playwright-style names (Enter, Space) and DOM KeyboardEvent.code values
 */
static SDL_Scancode keyNameToScancode(const std::string& key) {
    // Letters
    if (key == "KeyA" || key == "a" || key == "A") return SDL_SCANCODE_A;
    if (key == "KeyB" || key == "b" || key == "B") return SDL_SCANCODE_B;
    if (key == "KeyC" || key == "c" || key == "C") return SDL_SCANCODE_C;
    if (key == "KeyD" || key == "d" || key == "D") return SDL_SCANCODE_D;
    if (key == "KeyE" || key == "e" || key == "E") return SDL_SCANCODE_E;
    if (key == "KeyF" || key == "f" || key == "F") return SDL_SCANCODE_F;
    if (key == "KeyG" || key == "g" || key == "G") return SDL_SCANCODE_G;
    if (key == "KeyH" || key == "h" || key == "H") return SDL_SCANCODE_H;
    if (key == "KeyI" || key == "i" || key == "I") return SDL_SCANCODE_I;
    if (key == "KeyJ" || key == "j" || key == "J") return SDL_SCANCODE_J;
    if (key == "KeyK" || key == "k" || key == "K") return SDL_SCANCODE_K;
    if (key == "KeyL" || key == "l" || key == "L") return SDL_SCANCODE_L;
    if (key == "KeyM" || key == "m" || key == "M") return SDL_SCANCODE_M;
    if (key == "KeyN" || key == "n" || key == "N") return SDL_SCANCODE_N;
    if (key == "KeyO" || key == "o" || key == "O") return SDL_SCANCODE_O;
    if (key == "KeyP" || key == "p" || key == "P") return SDL_SCANCODE_P;
    if (key == "KeyQ" || key == "q" || key == "Q") return SDL_SCANCODE_Q;
    if (key == "KeyR" || key == "r" || key == "R") return SDL_SCANCODE_R;
    if (key == "KeyS" || key == "s" || key == "S") return SDL_SCANCODE_S;
    if (key == "KeyT" || key == "t" || key == "T") return SDL_SCANCODE_T;
    if (key == "KeyU" || key == "u" || key == "U") return SDL_SCANCODE_U;
    if (key == "KeyV" || key == "v" || key == "V") return SDL_SCANCODE_V;
    if (key == "KeyW" || key == "w" || key == "W") return SDL_SCANCODE_W;
    if (key == "KeyX" || key == "x" || key == "X") return SDL_SCANCODE_X;
    if (key == "KeyY" || key == "y" || key == "Y") return SDL_SCANCODE_Y;
    if (key == "KeyZ" || key == "z" || key == "Z") return SDL_SCANCODE_Z;

    // Numbers
    if (key == "Digit0" || key == "0") return SDL_SCANCODE_0;
    if (key == "Digit1" || key == "1") return SDL_SCANCODE_1;
    if (key == "Digit2" || key == "2") return SDL_SCANCODE_2;
    if (key == "Digit3" || key == "3") return SDL_SCANCODE_3;
    if (key == "Digit4" || key == "4") return SDL_SCANCODE_4;
    if (key == "Digit5" || key == "5") return SDL_SCANCODE_5;
    if (key == "Digit6" || key == "6") return SDL_SCANCODE_6;
    if (key == "Digit7" || key == "7") return SDL_SCANCODE_7;
    if (key == "Digit8" || key == "8") return SDL_SCANCODE_8;
    if (key == "Digit9" || key == "9") return SDL_SCANCODE_9;

    // Function keys
    if (key == "F1") return SDL_SCANCODE_F1;
    if (key == "F2") return SDL_SCANCODE_F2;
    if (key == "F3") return SDL_SCANCODE_F3;
    if (key == "F4") return SDL_SCANCODE_F4;
    if (key == "F5") return SDL_SCANCODE_F5;
    if (key == "F6") return SDL_SCANCODE_F6;
    if (key == "F7") return SDL_SCANCODE_F7;
    if (key == "F8") return SDL_SCANCODE_F8;
    if (key == "F9") return SDL_SCANCODE_F9;
    if (key == "F10") return SDL_SCANCODE_F10;
    if (key == "F11") return SDL_SCANCODE_F11;
    if (key == "F12") return SDL_SCANCODE_F12;

    // Navigation
    if (key == "ArrowUp" || key == "Up") return SDL_SCANCODE_UP;
    if (key == "ArrowDown" || key == "Down") return SDL_SCANCODE_DOWN;
    if (key == "ArrowLeft" || key == "Left") return SDL_SCANCODE_LEFT;
    if (key == "ArrowRight" || key == "Right") return SDL_SCANCODE_RIGHT;
    if (key == "Home") return SDL_SCANCODE_HOME;
    if (key == "End") return SDL_SCANCODE_END;
    if (key == "PageUp") return SDL_SCANCODE_PAGEUP;
    if (key == "PageDown") return SDL_SCANCODE_PAGEDOWN;

    // Editing
    if (key == "Backspace") return SDL_SCANCODE_BACKSPACE;
    if (key == "Delete") return SDL_SCANCODE_DELETE;
    if (key == "Insert") return SDL_SCANCODE_INSERT;
    if (key == "Enter" || key == "Return") return SDL_SCANCODE_RETURN;
    if (key == "Tab") return SDL_SCANCODE_TAB;
    if (key == "Escape" || key == "Esc") return SDL_SCANCODE_ESCAPE;
    if (key == "Space" || key == " ") return SDL_SCANCODE_SPACE;

    // Modifiers
    if (key == "ShiftLeft" || key == "Shift") return SDL_SCANCODE_LSHIFT;
    if (key == "ShiftRight") return SDL_SCANCODE_RSHIFT;
    if (key == "ControlLeft" || key == "Control" || key == "Ctrl") return SDL_SCANCODE_LCTRL;
    if (key == "ControlRight") return SDL_SCANCODE_RCTRL;
    if (key == "AltLeft" || key == "Alt") return SDL_SCANCODE_LALT;
    if (key == "AltRight") return SDL_SCANCODE_RALT;
    if (key == "MetaLeft" || key == "Meta" || key == "Command" || key == "Win") return SDL_SCANCODE_LGUI;
    if (key == "MetaRight") return SDL_SCANCODE_RGUI;
    if (key == "CapsLock") return SDL_SCANCODE_CAPSLOCK;

    // Punctuation
    if (key == "Minus" || key == "-") return SDL_SCANCODE_MINUS;
    if (key == "Equal" || key == "=" || key == "Plus") return SDL_SCANCODE_EQUALS;
    if (key == "BracketLeft" || key == "[") return SDL_SCANCODE_LEFTBRACKET;
    if (key == "BracketRight" || key == "]") return SDL_SCANCODE_RIGHTBRACKET;
    if (key == "Backslash" || key == "\\") return SDL_SCANCODE_BACKSLASH;
    if (key == "Semicolon" || key == ";") return SDL_SCANCODE_SEMICOLON;
    if (key == "Quote" || key == "'") return SDL_SCANCODE_APOSTROPHE;
    if (key == "Backquote" || key == "`") return SDL_SCANCODE_GRAVE;
    if (key == "Comma" || key == ",") return SDL_SCANCODE_COMMA;
    if (key == "Period" || key == ".") return SDL_SCANCODE_PERIOD;
    if (key == "Slash" || key == "/") return SDL_SCANCODE_SLASH;

    return SDL_SCANCODE_UNKNOWN;
}

/**
 * Inject a keyboard event into SDL's event queue
 */
static bool injectKeyboardEvent(SDL_Scancode scancode, bool down) {
    if (scancode == SDL_SCANCODE_UNKNOWN) return false;

    SDL_Event event;
    SDL_zero(event);
    event.type = down ? SDL_EVENT_KEY_DOWN : SDL_EVENT_KEY_UP;
    event.key.scancode = scancode;
    event.key.key = SDL_GetKeyFromScancode(scancode, SDL_KMOD_NONE, false);
    event.key.down = down;
    event.key.repeat = false;

    return SDL_PushEvent(&event) > 0;
}

/**
 * Inject a mouse motion event
 */
static bool injectMouseMotion(float x, float y) {
    SDL_Event event;
    SDL_zero(event);
    event.type = SDL_EVENT_MOUSE_MOTION;
    event.motion.x = x;
    event.motion.y = y;
    event.motion.xrel = 0;
    event.motion.yrel = 0;

    return SDL_PushEvent(&event) > 0;
}

/**
 * Inject a mouse button event
 */
static bool injectMouseButton(float x, float y, int button, bool down) {
    SDL_Event event;
    SDL_zero(event);
    event.type = down ? SDL_EVENT_MOUSE_BUTTON_DOWN : SDL_EVENT_MOUSE_BUTTON_UP;
    event.button.button = button;
    event.button.down = down;
    event.button.x = x;
    event.button.y = y;
    event.button.clicks = 1;

    return SDL_PushEvent(&event) > 0;
}

/**
 * Parse JSON to extract a string value for a key
 */
static std::string extractJsonString(const std::string& json, const std::string& key) {
    std::string searchKey = "\"" + key + "\"";
    size_t keyPos = json.find(searchKey);
    if (keyPos == std::string::npos) return "";

    size_t colonPos = json.find(':', keyPos);
    if (colonPos == std::string::npos) return "";

    size_t quoteStart = json.find('"', colonPos + 1);
    if (quoteStart == std::string::npos) return "";

    auto hexDigit = [](char value) -> int {
        if (value >= '0' && value <= '9') return value - '0';
        if (value >= 'a' && value <= 'f') return value - 'a' + 10;
        if (value >= 'A' && value <= 'F') return value - 'A' + 10;
        return -1;
    };
    auto readUnicodeEscape = [&](size_t start, unsigned int& value) -> bool {
        if (start + 4 >= json.size() || json[start] != 'u') return false;
        value = 0;
        for (size_t offset = 1; offset <= 4; ++offset) {
            const int digit = hexDigit(json[start + offset]);
            if (digit < 0) return false;
            value = (value << 4) | static_cast<unsigned int>(digit);
        }
        return true;
    };
    auto appendCodePoint = [](std::string& result, unsigned int value) {
        if (value <= 0x7f) {
            result.push_back(static_cast<char>(value));
        } else if (value <= 0x7ff) {
            result.push_back(static_cast<char>(0xc0 | (value >> 6)));
            result.push_back(static_cast<char>(0x80 | (value & 0x3f)));
        } else if (value <= 0xffff) {
            result.push_back(static_cast<char>(0xe0 | (value >> 12)));
            result.push_back(static_cast<char>(0x80 | ((value >> 6) & 0x3f)));
            result.push_back(static_cast<char>(0x80 | (value & 0x3f)));
        } else {
            result.push_back(static_cast<char>(0xf0 | (value >> 18)));
            result.push_back(static_cast<char>(0x80 | ((value >> 12) & 0x3f)));
            result.push_back(static_cast<char>(0x80 | ((value >> 6) & 0x3f)));
            result.push_back(static_cast<char>(0x80 | (value & 0x3f)));
        }
    };

    std::string result;
    for (size_t index = quoteStart + 1; index < json.size(); ++index) {
        const char value = json[index];
        if (value == '"') return result;
        if (value != '\\') {
            if (static_cast<unsigned char>(value) < 0x20) return "";
            result.push_back(value);
            continue;
        }
        if (++index >= json.size()) return "";
        switch (json[index]) {
            case '"': result.push_back('"'); break;
            case '\\': result.push_back('\\'); break;
            case '/': result.push_back('/'); break;
            case 'b': result.push_back('\b'); break;
            case 'f': result.push_back('\f'); break;
            case 'n': result.push_back('\n'); break;
            case 'r': result.push_back('\r'); break;
            case 't': result.push_back('\t'); break;
            case 'u': {
                unsigned int codePoint = 0;
                if (!readUnicodeEscape(index, codePoint)) return "";
                index += 4;
                if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
                    if (index + 6 >= json.size() || json[index + 1] != '\\' || json[index + 2] != 'u') {
                        return "";
                    }
                    unsigned int lowSurrogate = 0;
                    if (!readUnicodeEscape(index + 2, lowSurrogate) ||
                        lowSurrogate < 0xdc00 || lowSurrogate > 0xdfff) {
                        return "";
                    }
                    codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (lowSurrogate - 0xdc00);
                    index += 6;
                } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
                    return "";
                }
                appendCodePoint(result, codePoint);
                break;
            }
            default: return "";
        }
    }
    return "";
}

/**
 * Parse JSON to extract a number value for a key
 */
static double extractJsonNumber(const std::string& json, const std::string& key, double defaultValue = 0) {
    std::string searchKey = "\"" + key + "\"";
    size_t keyPos = json.find(searchKey);
    if (keyPos == std::string::npos) return defaultValue;

    size_t colonPos = json.find(':', keyPos);
    if (colonPos == std::string::npos) return defaultValue;

    size_t start = colonPos + 1;
    while (start < json.size() && (json[start] == ' ' || json[start] == '\t')) start++;

    size_t end = start;
    while (end < json.size() && (json[end] == '-' || json[end] == '.' || (json[end] >= '0' && json[end] <= '9'))) end++;

    if (end > start) {
        try {
            return std::stod(json.substr(start, end - start));
        } catch (...) {
            return defaultValue;
        }
    }
    return defaultValue;
}

static bool extractJsonBool(const std::string& json, const std::string& key, bool defaultValue) {
    std::string searchKey = "\"" + key + "\"";
    size_t keyPos = json.find(searchKey);
    if (keyPos == std::string::npos) return defaultValue;
    size_t colonPos = json.find(':', keyPos);
    if (colonPos == std::string::npos) return defaultValue;
    size_t start = colonPos + 1;
    while (start < json.size() && (json[start] == ' ' || json[start] == '\t' || json[start] == '\n' || json[start] == '\r')) start++;
    if (json.compare(start, 4, "true") == 0) return true;
    if (json.compare(start, 5, "false") == 0) return false;
    return defaultValue;
}

// Platform-specific headers for process termination
#ifdef _WIN32
#include <process.h>  // Windows: _exit()
#include <windows.h>  // Windows: ExitProcess()
#else
#include <unistd.h>   // POSIX: _exit(), getpid()
#include <signal.h>   // POSIX: kill(), SIGKILL

#endif

void printVersion() {
    std::cout << "Mystral Native Runtime v" << mystral::getVersion() << std::endl;
    std::cout << "Native WebGPU JS runtime - " << mystral::getWebGPUBackend() << " + " << mystral::getJSEngine() << " build" << std::endl;
}

void printHelp() {
    std::cout << R"(
Mystral CLI - Native Runtime for Mystral Engine

USAGE:
    mystral run <script.js> [options]         Run a JavaScript file
    mystral compile <entry.js> [options]      Bundle JS + assets into a single binary
    mystral --compile <entry.js> [options]    Same as compile
    mystral bake <input.glb|input.js> [options]  Bake lightmaps for a scene
    mystral --version                         Show version information
    mystral --help                            Show this help message

RUN OPTIONS:
    --width <n>           Window width (default: 1280)
    --height <n>          Window height (default: 720)
    --title <str>         Window title (default: "Mystral")
    --windowed            Start a normal window at the configured size
    --maximized           Start maximized (implies windowed)
    --fullscreen           Start fullscreen (overrides the embedded config)
    --headless            Run with hidden window (background mode)
    --bypass-ui-loading   Run a web-UI game without attaching or waiting for its UI (diagnostic)
    --no-sdl              Run without SDL (headless GPU, no window system required)
    --watch, -w           Watch mode: reload script on file changes
    --screenshot <file>   Take screenshot after N frames and quit
    --frames <n>          Number of frames before screenshot (default: 60)
    --quiet, -q           Suppress all output except errors

VIDEO RECORDING OPTIONS:
    --video, --record <file>  Record video to file (WebP format, or MP4 with --mp4)
    --start-frame <n>     First frame to capture (default: 0)
    --end-frame <n>       Last frame to capture (required for video recording)
    --video-fps <n>       Video framerate (default: 60)
    --video-quality <n>   WebP quality 0-100 (default: 80, higher = better)
    --mp4                 Convert to MP4 via FFmpeg (auto-detected if --video ends in .mp4)
    --native-capture      Use OS-level screen capture (default on macOS 12.3+/Windows 10 1803+)
                          Directly encodes to H.264 MP4 with low CPU overhead
    --gpu-capture         Force GPU readback capture (fallback mode, works everywhere)

PROFILING OPTIONS:
    --cpu-prof <file>     Write a Chrome DevTools .cpuprofile of this run and print the top
                          self-time functions on exit; no system profiler to install.

DEBUG/TESTING OPTIONS:
    --debug               Enable verbose debug logging (WebGPU, shaders, etc.)
    --debug-port <port>   Enable debug server on specified port (e.g., 9222)
                          Allows remote testing via WebSocket protocol

COMPILE OPTIONS:
    --include <dir>       Asset directory to bundle (repeatable)
    --assets <dir>        Alias for --include
    --output <file>       Output binary path (default: ./<entry-stem>)
    --out, -o <file>      Alias for --output
    --root <dir>          Root directory for bundle paths (default: cwd)
    --bundle-only         Create standalone .bundle file (no exe, for .app packaging)

BAKE OPTIONS (Lightmap Generation):
    --output <dir>        Output directory for lightmaps (default: ./lightmaps)
    --resolution <n>      Max lightmap atlas size (default: 2048)
    --samples <n>         Rays per texel (default: 64)
    --bounces <n>         Light bounces for GI (default: 2)

HEADLESS MODE:
    Run without displaying a window (useful for servers, CI, etc.):

    mystral run game.js --headless
    MYSTRAL_HEADLESS=1 mystral run game.js

    In headless mode:
    - Window is created but hidden
    - WebGPU rendering still works (GPU is used)
    - All JavaScript APIs work normally
    - Combine with --screenshot or --video for automated capture

SCREENSHOT MODE:
    Capture rendered output to a PNG file:

    mystral run scene.js --screenshot output.png              # 60 frames (default)
    mystral run scene.js --screenshot output.png --frames 120 # 120 frames

VIDEO RECORDING MODE:
    Record game output to an animated WebP or MP4 file:

    mystral run game.js --video demo.webp --end-frame 300     # 5 sec at 60fps
    mystral run game.js --video demo.mp4 --end-frame 600      # 10 sec, auto-convert
    mystral run game.js --video demo.webp --mp4 --end-frame 300  # Explicit MP4 convert

    Notes:
    - MP4 conversion requires FFmpeg installed on your system
    - If FFmpeg is not found, the WebP file is kept
    - WebP files play directly in browsers and most apps

EXAMPLES:
    mystral run game.js                                       # Run interactively
    mystral run app.js --width 1920 --height 1080             # Custom size
    mystral run test.js --headless --screenshot out.png       # Headless + screenshot
    mystral run game.js --headless --video out.mp4 --end-frame 300  # Record 5 sec video
    MYSTRAL_HEADLESS=1 mystral run render.js --screenshot render.png --frames 10
    mystral compile game.js --include assets --out my-game    # Bundle into a single binary
    mystral compile game.js --include assets --out game.bundle --bundle-only  # Standalone bundle file
    mystral bake scene.glb --output ./lightmaps               # Bake lightmaps for scene
    mystral bake game.js --resolution 1024 --samples 128      # Bake with custom settings

ENVIRONMENT:
    MYSTRAL_HEADLESS=1        Run in headless mode (hidden window)
    MYSTRAL_DEBUG=1           Enable verbose debug logging
    MYSTRAL_BUNDLE=<path>     Load external bundle file (overrides auto-detection)
    MYSTRAL_WEBTRANSPORT_INSECURE=1
                              Development-only override for invalid WebTransport certificates;
                              only the exact value 1 enables it, and other values keep
                              TLS peer verification enabled

)" << std::endl;
}

std::string readFile(const std::string& path) {
    std::ifstream file(path);
    if (!file.is_open()) {
        throw std::runtime_error("Cannot open file: " + path);
    }
    std::stringstream buffer;
    buffer << file.rdbuf();
    return buffer.str();
}

struct CLIOptions {
    std::string command;
    std::string scriptPath;
    int width = 1280;
    int height = 720;
    std::string title = "ThreeNative";
    std::string iconPath;
    bool fullscreen = false;
    bool maximized = false;
    bool windowModeOverride = false;
    bool resizable = true;
    bool showHelp = false;
    bool showVersion = false;
    bool headless = false;
    bool watch = false;  // Watch mode for hot reloading

    // Screenshot mode
    std::string screenshotPath;
    int frames = 60;
    bool quiet = false;
    bool noSdl = false;  // Run without SDL (headless GPU, no window)
    bool vsync = true;   // --no-vsync selects an uncapped present mode (immediate/mailbox)
    uint32_t maxFps = 60;

    // Video recording mode
    std::string videoPath;      // Output video path
    int startFrame = 0;         // First frame to capture
    int endFrame = -1;          // Last frame to capture (-1 = unlimited until quit)
    int videoFps = 60;          // Video framerate
    int videoQuality = 80;      // WebP quality (0-100, higher = better quality, larger file)
    bool convertToMp4 = false;  // Convert WebP to MP4 via FFmpeg
    bool useNativeCapture = true;  // Use OS-level capture when available (macOS/Windows)

    // Compile options
    std::vector<std::string> assetDirs;
    std::string outputPath;
    std::string rootDir;
    bool bundleOnly = false;  // Create standalone .bundle file (no exe copy)

    // Debug server
    int debugPort = 0;  // Port for debug server (0 = disabled)

    // Verbose logging
    bool debug = false;  // Enable verbose WebGPU/shader logging

    std::string cpuProfilePath;  // PRD-444: DevTools `.cpuprofile` target; empty = summary only

    // The built UI bundle to render over the game surface, or empty for the native renderer.
    std::string uiRoot;
    bool bypassUiLoading = false;

    // `ui.renderer: "native-css"`: the same bundle, laid out and rasterised on the CPU by the
    // `native/css-ui` crate instead of by a web view. A backend choice, so it rides with `uiRoot`
    // — which the bundle-loading and ready-gate code below already keys on.
    bool cssUiRenderer = false;

    // Bake options
    int bakeResolution = 2048;   // Max lightmap atlas size
    int bakeSamples = 64;        // Rays per texel
    int bakeBounces = 2;         // Light bounces for GI
};

static void applyEmbeddedConfig(CLIOptions& opts) {
    std::vector<uint8_t> bytes;
    if (!mystral::vfs::readEmbeddedFile(".threenative/config.json", bytes)) return;
    const std::string config(bytes.begin(), bytes.end());
    const std::string title = extractJsonString(config, "title");
    if (!title.empty()) opts.title = title;
    const std::string icon = extractJsonString(config, "icon");
    if (!icon.empty()) {
        opts.iconPath = icon;
#ifdef _WIN32
        _putenv_s("THREENATIVE_WINDOW_ICON_BUNDLE", icon.c_str());
#else
        setenv("THREENATIVE_WINDOW_ICON_BUNDLE", icon.c_str(), 1);
#endif
    }
    const double width = extractJsonNumber(config, "width", opts.width);
    const double height = extractJsonNumber(config, "height", opts.height);
    if (width > 0) opts.width = static_cast<int>(width);
    if (height > 0) opts.height = static_cast<int>(height);
    if (!opts.windowModeOverride) {
        opts.fullscreen = extractJsonBool(config, "fullscreen", opts.fullscreen);
        opts.maximized = extractJsonBool(config, "maximized", opts.maximized);
    }
    opts.resizable = extractJsonBool(config, "resizable", opts.resizable);
    const double maxFps = extractJsonNumber(config, "maxFps", opts.maxFps);
    if (maxFps >= 0 && maxFps <= 1000 && std::floor(maxFps) == maxFps) {
        opts.maxFps = static_cast<uint32_t>(maxFps);
    }
    // `ui.renderer`, flattened by the packager to `uiRenderer` because `renderer` already means
    // the WebGPU preference here. Anything but "web" and "native-css" is the native renderer, which
    // ships no overlay at all — the same fail-closed reading the Android manifest metadata gets.
    const std::string uiRenderer = extractJsonString(config, "uiRenderer");
    if (uiRenderer == "web" || uiRenderer == "native-css") {
        // Both renderers read the same built bundle from the same place; they differ only in who
        // rasterises it, which is decided once here rather than at every call site below.
        opts.uiRoot = "ui";
        opts.cssUiRenderer = uiRenderer == "native-css";
    }
}

CLIOptions parseArgs(int argc, char* argv[]) {
    CLIOptions opts;

    for (int i = 1; i < argc; i++) {
        std::string arg = argv[i];

        if (arg == "--help" || arg == "-h") {
            opts.showHelp = true;
        } else if (arg == "--version" || arg == "-v") {
            opts.showVersion = true;
        } else if (arg == "--width" && i + 1 < argc) {
            opts.width = std::stoi(argv[++i]);
        } else if (arg == "--height" && i + 1 < argc) {
            opts.height = std::stoi(argv[++i]);
        } else if (arg == "--title" && i + 1 < argc) {
            opts.title = argv[++i];
        } else if (arg == "--windowed") {
            opts.fullscreen = false;
            opts.maximized = false;
            opts.windowModeOverride = true;
        } else if (arg == "--maximized") {
            opts.fullscreen = false;
            opts.maximized = true;
            opts.windowModeOverride = true;
        } else if (arg == "--fullscreen") {
            opts.fullscreen = true;
            opts.maximized = false;
            opts.windowModeOverride = true;
        } else if ((arg == "--include" || arg == "--assets") && i + 1 < argc) {
            opts.assetDirs.push_back(argv[++i]);
        } else if ((arg == "--output" || arg == "--out" || arg == "-o") && i + 1 < argc) {
            opts.outputPath = argv[++i];
        } else if (arg == "--root" && i + 1 < argc) {
            opts.rootDir = argv[++i];
        } else if (arg == "--ui" && i + 1 < argc) {
            opts.uiRoot = argv[++i];
        } else if (arg == "--bypass-ui-loading") {
            opts.bypassUiLoading = true;
        } else if (arg == "--entry" && i + 1 < argc) {
            opts.scriptPath = argv[++i];
        } else if (arg == "--screenshot" && i + 1 < argc) {
            opts.screenshotPath = argv[++i];
        } else if (arg == "--frames" && i + 1 < argc) {
            opts.frames = std::stoi(argv[++i]);
        } else if (arg == "--no-vsync") {
            // Presenting FIFO pins every frame to the display and turns a benchmark into a
            // measurement of the monitor. `configureSurface` already refuses to fall back to FIFO
            // when an uncapped mode is unavailable, so this either measures the engine or fails.
            opts.vsync = false;
        } else if (arg == "--cpu-prof" && i + 1 < argc) {
            opts.cpuProfilePath = argv[++i];
        } else if (arg.rfind("--cpu-prof=", 0) == 0) {  // the playtest runner's one-arg form
            opts.cpuProfilePath = arg.substr(std::string("--cpu-prof=").size());
        } else if (arg == "--quiet" || arg == "-q") {
            opts.quiet = true;
        } else if (arg == "--headless") {
            opts.headless = true;
        } else if (arg == "--no-sdl") {
            opts.noSdl = true;
        } else if (arg == "--watch" || arg == "-w") {
            opts.watch = true;
        } else if (arg == "--bundle-only") {
            opts.bundleOnly = true;
        } else if ((arg == "--video" || arg == "--record") && i + 1 < argc) {
            opts.videoPath = argv[++i];
            // Auto-detect --mp4 from extension
            if (opts.videoPath.size() > 4) {
                std::string ext = opts.videoPath.substr(opts.videoPath.size() - 4);
                if (ext == ".mp4" || ext == ".MP4") {
                    opts.convertToMp4 = true;
                }
            }
        } else if (arg == "--start-frame" && i + 1 < argc) {
            opts.startFrame = std::stoi(argv[++i]);
        } else if (arg == "--end-frame" && i + 1 < argc) {
            opts.endFrame = std::stoi(argv[++i]);
        } else if (arg == "--video-fps" && i + 1 < argc) {
            opts.videoFps = std::stoi(argv[++i]);
        } else if (arg == "--video-quality" && i + 1 < argc) {
            opts.videoQuality = std::stoi(argv[++i]);
        } else if (arg == "--mp4") {
            opts.convertToMp4 = true;
        } else if (arg == "--native-capture") {
            opts.useNativeCapture = true;
        } else if (arg == "--gpu-capture" || arg == "--no-native-capture") {
            opts.useNativeCapture = false;
        } else if (arg == "--debug-port" && i + 1 < argc) {
            opts.debugPort = std::stoi(argv[++i]);
        } else if (arg == "--debug") {
            opts.debug = true;
        } else if (arg == "--resolution" && i + 1 < argc) {
            opts.bakeResolution = std::stoi(argv[++i]);
        } else if (arg == "--samples" && i + 1 < argc) {
            opts.bakeSamples = std::stoi(argv[++i]);
        } else if (arg == "--bounces" && i + 1 < argc) {
            opts.bakeBounces = std::stoi(argv[++i]);
        } else if ((arg == "run") && opts.command.empty()) {
            opts.command = "run";
        } else if ((arg == "compile" || arg == "--compile") && opts.command.empty()) {
            opts.command = "compile";
        } else if ((arg == "bake") && opts.command.empty()) {
            opts.command = "bake";
        } else if (opts.command == "run" && opts.scriptPath.empty()) {
            opts.scriptPath = arg;
        } else if (opts.command == "compile" && opts.scriptPath.empty() && (arg.empty() || arg[0] != '-')) {
            opts.scriptPath = arg;
        } else if (opts.command == "bake" && opts.scriptPath.empty() && (arg.empty() || arg[0] != '-')) {
            opts.scriptPath = arg;
        } else if (arg[0] == '-') {
            // Unknown flag - warn the user
            std::cerr << "Warning: Unknown option '" << arg << "'" << std::endl;
        }
    }

    return opts;
}

// ============================================================================
// Video Recording (Animated WebP)
// ============================================================================

#ifdef MYSTRAL_HAS_WEBP_MUX

/**
 * WebP Video Recorder
 *
 * Records frames to an animated WebP file using libwebp's WebPAnimEncoder.
 * Optionally converts to MP4 using FFmpeg if available.
 */
class WebPVideoRecorder {
public:
    WebPVideoRecorder(int width, int height, int fps, int quality)
        : width_(width), height_(height), fps_(fps), quality_(quality),
          encoder_(nullptr), frameCount_(0), timestampMs_(0) {

        // Initialize animation encoder options
        if (!WebPAnimEncoderOptionsInit(&encOptions_)) {
            std::cerr << "[Video] Failed to initialize WebP encoder options" << std::endl;
            return;
        }

        // Set encoding options
        encOptions_.anim_params.loop_count = 0;  // Infinite loop
        encOptions_.allow_mixed = 0;  // All frames same format
        encOptions_.minimize_size = 0;  // Prioritize speed over size
        // Force every frame to be a keyframe (prevents frame differencing artifacts)
        encOptions_.kmin = 1;
        encOptions_.kmax = 1;

        // Create encoder
        encoder_ = WebPAnimEncoderNew(width, height, &encOptions_);
        if (!encoder_) {
            std::cerr << "[Video] Failed to create WebP animation encoder" << std::endl;
            return;
        }

        // Calculate frame duration in milliseconds
        frameDurationMs_ = 1000 / fps;
    }

    ~WebPVideoRecorder() {
        if (encoder_) {
            WebPAnimEncoderDelete(encoder_);
        }
    }

    bool isValid() const {
        return encoder_ != nullptr;
    }

    /**
     * Add a frame from RGBA pixel data
     * @param rgbaData Pointer to RGBA pixel data (width * height * 4 bytes)
     * @return true on success
     */
    bool addFrame(const uint8_t* rgbaData) {
        if (!encoder_) return false;

        // Set up WebP picture
        WebPPicture pic;
        if (!WebPPictureInit(&pic)) {
            std::cerr << "[Video] Failed to init WebP picture" << std::endl;
            return false;
        }

        pic.width = width_;
        pic.height = height_;
        pic.use_argb = 1;  // Use ARGB format

        // Allocate picture buffer
        if (!WebPPictureAlloc(&pic)) {
            std::cerr << "[Video] Failed to allocate WebP picture" << std::endl;
            return false;
        }

        // Convert RGBA to ARGB (WebP's internal format)
        // RGBA: R G B A -> ARGB: A R G B (but stored as 32-bit words)
        // Actually WebPPictureImportRGBA handles this for us
        if (!WebPPictureImportRGBA(&pic, rgbaData, width_ * 4)) {
            std::cerr << "[Video] Failed to import RGBA data" << std::endl;
            WebPPictureFree(&pic);
            return false;
        }

        // Set up encoding config
        WebPConfig config;
        if (!WebPConfigInit(&config)) {
            std::cerr << "[Video] Failed to init WebP config" << std::endl;
            WebPPictureFree(&pic);
            return false;
        }

        // Set quality (0-100)
        config.quality = static_cast<float>(quality_);
        config.method = 4;  // Compression method (0=fast, 6=slow but better)

        // Add frame to animation
        if (!WebPAnimEncoderAdd(encoder_, &pic, timestampMs_, &config)) {
            std::cerr << "[Video] Failed to add frame: " << WebPAnimEncoderGetError(encoder_) << std::endl;
            WebPPictureFree(&pic);
            return false;
        }

        WebPPictureFree(&pic);

        frameCount_++;
        timestampMs_ += frameDurationMs_;

        return true;
    }

    /**
     * Finalize and save the video to a file
     * @param outputPath Path to save the WebP file
     * @return true on success
     */
    bool save(const std::string& outputPath) {
        if (!encoder_) return false;

        // Add final "null" frame to signal end of animation
        if (!WebPAnimEncoderAdd(encoder_, nullptr, timestampMs_, nullptr)) {
            std::cerr << "[Video] Failed to finalize animation" << std::endl;
            return false;
        }

        // Assemble the animation
        WebPData webpData;
        WebPDataInit(&webpData);

        if (!WebPAnimEncoderAssemble(encoder_, &webpData)) {
            std::cerr << "[Video] Failed to assemble animation: " << WebPAnimEncoderGetError(encoder_) << std::endl;
            return false;
        }

        // Write to file
        std::ofstream file(outputPath, std::ios::binary);
        if (!file.is_open()) {
            std::cerr << "[Video] Failed to open output file: " << outputPath << std::endl;
            WebPDataClear(&webpData);
            return false;
        }

        file.write(reinterpret_cast<const char*>(webpData.bytes), webpData.size);
        file.close();

        WebPDataClear(&webpData);

        return true;
    }

    int getFrameCount() const { return frameCount_; }

private:
    int width_;
    int height_;
    int fps_;
    int quality_;
    WebPAnimEncoder* encoder_;
    WebPAnimEncoderOptions encOptions_;
    int frameCount_;
    int timestampMs_;
    int frameDurationMs_;
};

#endif // MYSTRAL_HAS_WEBP_MUX

/**
 * Check if FFmpeg is available on the system
 * Note: Not static - used by video recorders
 */
bool isFFmpegAvailable() {
#ifdef _WIN32
    int result = system("where ffmpeg >nul 2>nul");
#else
    int result = system("which ffmpeg >/dev/null 2>&1");
#endif
    return result == 0;
}

/**
 * Convert WebP to MP4 using FFmpeg
 * Note: FFmpeg's native webp decoder doesn't support animated WebP.
 * We use the anim_dump approach: extract frames, then encode.
 * @param webpPath Input WebP file path
 * @param mp4Path Output MP4 file path
 * @param fps Video framerate
 * @param deleteWebp Whether to delete the WebP file after conversion
 * @return true on success
 * Note: Not static - used by video recorders
 */
bool convertWebPToMP4(const std::string& webpPath, const std::string& mp4Path, int fps, bool deleteWebp, bool quiet) {
    if (!isFFmpegAvailable()) {
        if (!quiet) {
            std::cerr << "[Video] FFmpeg not found. WebP file saved: " << webpPath << std::endl;
            std::cerr << "[Video] Note: Animated WebP plays in browsers and many apps" << std::endl;
            std::cerr << "[Video] To convert to MP4, install FFmpeg and use a tool that supports animated WebP" << std::endl;
        }
        return false;
    }

    // Create temp directory for frames
    std::error_code ec;
    std::filesystem::path tempDir = std::filesystem::temp_directory_path(ec) / ("mystral-video-" + std::to_string(std::time(nullptr)));
    if (ec) {
        if (!quiet) std::cerr << "[Video] Failed to get temp directory" << std::endl;
        return false;
    }
    std::filesystem::create_directories(tempDir, ec);
    if (ec) {
        if (!quiet) std::cerr << "[Video] Failed to create temp directory" << std::endl;
        return false;
    }

    // Check if webpmux is available (from libwebp package)
    bool hasWebpmux = false;
#ifdef _WIN32
    hasWebpmux = system("where webpmux >nul 2>nul") == 0;
#else
    hasWebpmux = system("which webpmux >/dev/null 2>&1") == 0;
#endif

    bool success = false;

    if (hasWebpmux) {
        // Use webpmux to extract frames, then ffmpeg to encode
        if (!quiet) std::cout << "[Video] Extracting frames with webpmux..." << std::endl;

        // Get frame count (we'll try up to 10000 frames)
        std::string extractCmd = "webpmux -get frame 1 \"" + webpPath + "\" -o \"" + tempDir.string() + "/frame_0001.webp\"";
#ifdef _WIN32
        extractCmd += " 2>nul";
#else
        extractCmd += " 2>/dev/null";
#endif

        // Extract first frame to test
        if (system(extractCmd.c_str()) != 0) {
            if (!quiet) std::cerr << "[Video] Failed to extract frames from animated WebP" << std::endl;
        } else {
            // Extract all frames
            int frameNum = 1;
            while (frameNum <= 10000) {
                char framePath[512];
                snprintf(framePath, sizeof(framePath), "%s/frame_%04d.webp", tempDir.string().c_str(), frameNum);

                std::string cmd = "webpmux -get frame " + std::to_string(frameNum) + " \"" + webpPath + "\" -o \"" + framePath + "\"";
#ifdef _WIN32
                cmd += " 2>nul";
#else
                cmd += " 2>/dev/null";
#endif
                if (system(cmd.c_str()) != 0) break;
                frameNum++;
            }

            if (frameNum > 1) {
                if (!quiet) std::cout << "[Video] Extracted " << (frameNum - 1) << " frames, encoding to MP4..." << std::endl;

                // Use FFmpeg to encode frames to MP4
                std::string ffmpegCmd = "ffmpeg -y -framerate " + std::to_string(fps) +
                    " -i \"" + tempDir.string() + "/frame_%04d.webp\" -c:v libx264 -pix_fmt yuv420p -crf 18 \"" + mp4Path + "\"";
                if (quiet) ffmpegCmd += " -loglevel quiet";
#ifdef _WIN32
                else ffmpegCmd += " 2>nul";
#endif

                if (system(ffmpegCmd.c_str()) == 0) {
                    success = true;
                }
            }
        }
    } else {
        // webpmux not available, provide instructions
        if (!quiet) {
            std::cerr << "[Video] MP4 conversion requires 'webpmux' (from libwebp) to extract animated WebP frames" << std::endl;
            std::cerr << "[Video] Install libwebp-tools: brew install webp (macOS) or apt install webp (Linux)" << std::endl;
            std::cerr << "[Video] Or use an online converter that supports animated WebP to MP4" << std::endl;
        }
    }

    // Cleanup temp directory
    std::filesystem::remove_all(tempDir, ec);

    if (success) {
        // Delete the WebP file if requested
        if (deleteWebp) {
            std::filesystem::remove(webpPath, ec);
        }
    } else {
        if (!quiet) {
            std::cerr << "[Video] MP4 conversion failed. WebP file preserved: " << webpPath << std::endl;
        }
    }

    return success;
}

static void setupHeadlessEnvironment(const CLIOptions& opts) {
    // Enable headless mode via environment variable (SDL3 uses this)
    if (opts.headless) {
#ifdef _WIN32
        _putenv_s("MYSTRAL_HEADLESS", "1");
#else
        setenv("MYSTRAL_HEADLESS", "1", 1);
#endif
    }
}

static void printRunBanner(const CLIOptions& opts, bool screenshotMode, bool videoMode) {
    if (!opts.quiet) {
        std::cout << "=== ThreeNative Native Runtime ===" << std::endl;
        std::cout << "Version: " << mystral::getVersion() << std::endl;
        std::cout << "Script: " << opts.scriptPath << std::endl;
        std::cout << "Window: " << opts.width << "x" << opts.height << std::endl;
        if (screenshotMode) {
            std::cout << "Screenshot mode: " << opts.frames << " frames -> " << opts.screenshotPath << std::endl;
        }
        if (videoMode) {
            std::cout << "Video mode: frames " << opts.startFrame << "-";
            if (opts.endFrame >= 0) {
                std::cout << opts.endFrame;
            } else {
                std::cout << "end";
            }
            std::cout << " @ " << opts.videoFps << "fps -> " << opts.videoPath << std::endl;
        }
        if (opts.watch) {
            std::cout << "Watch mode: enabled (hot reload on file changes)" << std::endl;
        }
        if (opts.debugPort > 0) {
            std::cout << "Debug server: port " << opts.debugPort << std::endl;
        }
        std::cout << std::endl;
    }
}

static std::unique_ptr<mystral::Runtime> createConfiguredRuntime(const CLIOptions& opts) {
#if defined(__linux__) && TN_ENABLE_UI_OVERLAY
    // Only the web overlay needs this. The CSS UI backend attaches to no window system at all — it
    // hands the compositor pixels — so it must not cost a Wayland session its native video driver.
    if (!opts.uiRoot.empty() && !opts.cssUiRenderer) {
        // The web overlay attaches to an X11 surface, also on Wayland via XWayland. SDL_HINT_OVERRIDE
        // below replaces any explicit driver, so a Wayland request with this overlay would run on X11
        // without saying so. Refuse it instead and name the two ways forward.
        const char* sdl3Driver = std::getenv("SDL_VIDEO_DRIVER");
        const char* legacyDriver = std::getenv("SDL_VIDEODRIVER");
        const char* requestedDriver = (sdl3Driver != nullptr && *sdl3Driver != '\0') ? sdl3Driver : legacyDriver;
        if (requestedDriver != nullptr && std::string(requestedDriver) == "wayland") {
            std::cerr << "[Mystral] The web UI overlay needs X11, but SDL_VIDEO_DRIVER/SDL_VIDEODRIVER "
                         "asks for Wayland. Set ui.renderer: \"native-css\", or unset the variable."
                      << std::endl;
            std::exit(1);
        }
        // Select both backends before SDL/GTK initialization and worker creation; a desktop
        // session's GDK_BACKEND=wayland must not leave the game's requested HUD unattached.
        SDL_SetHintWithPriority(SDL_HINT_VIDEO_DRIVER, "x11", SDL_HINT_OVERRIDE);
        setenv("GDK_BACKEND", "x11", 1);
    }
#endif
    // Check for debug mode via environment variable
    bool debugMode = opts.debug;
    const char* debugEnv = std::getenv("MYSTRAL_DEBUG");
    if (debugEnv && (std::string(debugEnv) == "1" || std::string(debugEnv) == "true")) {
        debugMode = true;
    }

    // Create runtime
    mystral::RuntimeConfig config;
    config.width = opts.width;
    config.height = opts.height;
    config.title = opts.title.c_str();
    config.fullscreen = opts.fullscreen;
    config.maximized = opts.maximized;
    config.resizable = opts.resizable;
    config.noSdl = opts.noSdl;
    config.watch = opts.watch;
    config.vsync = opts.vsync;
    config.maxFps = opts.maxFps;
    config.debug = debugMode;
    config.storageIdentity = opts.scriptPath;
    // An embedded release is one closed source graph. Development module trees and hot reload
    // deliberately stay memory-only rather than identifying imported shaders by the entry alone.
    if (!opts.watch && mystral::vfs::hasEmbeddedBundle()) {
        std::vector<uint8_t> source;
        if (mystral::vfs::readEmbeddedFile(mystral::vfs::getEmbeddedEntryPath(), source) && !source.empty()) {
            config.pipelineCacheAppIdentity = mystral::vfs::getExecutablePath();
            config.pipelineCacheSourceIdentity = mystral::webgpu::pipelineCacheDigest(
                std::string_view(reinterpret_cast<const char*>(source.data()), source.size()));
        }
    }

    // `display.backgroundMode` on desktop. Android carries it as manifest metadata; there is no
    // manifest here, so the environment is the seam. Unrecognized values keep the default and say
    // so rather than being guessed at.
    const char* backgroundModeEnv = std::getenv("THREENATIVE_BACKGROUND_MODE");
    if (backgroundModeEnv != nullptr && backgroundModeEnv[0] != '\0') {
        mystral::platform::BackgroundMode mode = mystral::platform::BackgroundMode::Pause;
        if (mystral::platform::parseBackgroundMode(backgroundModeEnv, mode)) {
            config.backgroundMode = mode;
        } else {
            std::cerr << "[Mystral] Unrecognized THREENATIVE_BACKGROUND_MODE '"
                      << backgroundModeEnv << "'; keeping 'pause'" << std::endl;
        }
    }

    return mystral::Runtime::create(config);
}

static bool attachUiOverlayIfConfigured(const CLIOptions& opts, mystral::Runtime&) {
    // The UI layer, if the game asked for it. After the runtime exists because the overlay
    // attaches to the window the runtime owns, and before the loop starts so the first frame the
    // player sees already has its HUD.
    //
    // A game whose `ui.renderer` is `native` never reaches here and links no overlay at all.
    if (!opts.uiRoot.empty()) {
        if (opts.bypassUiLoading) return true;
        std::filesystem::path uiRoot(opts.uiRoot);
        if (uiRoot.is_relative()) {
            // Next to the executable, which is where the packager stages it. Resolving against the
            // working directory instead would work when launched from the game folder and fail
            // from anywhere else, which is the worst kind of works-on-my-machine.
            const char* base = SDL_GetBasePath();
            if (base != nullptr) uiRoot = std::filesystem::path(base) / uiRoot;
        }
        const char* renderer = opts.cssUiRenderer ? "native-css" : "web";
        std::error_code exists;
        if (!std::filesystem::is_directory(uiRoot, exists)) {
            std::cerr << "TN_UI_BUNDLE_MISSING: the " << renderer << " UI renderer was requested "
                      << "but " << uiRoot.string() << " is not a directory." << std::endl;
            return false;
        }
        const bool attached = opts.cssUiRenderer
            ? mystral::platform::attachDesktopCssUi(uiRoot.string())
            : mystral::platform::attachDesktopUiOverlay(uiRoot.string());
        if (!attached) {
            std::cerr << "TN_UI_LOAD_FAILED: the requested " << renderer << " UI overlay could not "
                      << "attach. Use --bypass-ui-loading only for scene diagnostics." << std::endl;
            return false;
        }
    }
    return true;
}

static bool wirePlaytestMailboxBridge(std::unique_ptr<mystral::Runtime>& runtime) {
    // Desktop playtests use the same native mailbox bridge as Android and iOS. The runner passes
    // the temporary root through the process environment so packaged game entries do not need a
    // playtest-specific source wrapper or a platform branch.
    namespace fs = std::filesystem;
    const char* configuredMailboxRoot = std::getenv("TN_PLAYTEST_MAILBOX_ROOT");
    if (configuredMailboxRoot != nullptr && configuredMailboxRoot[0] != '\0') {
        const fs::path root(configuredMailboxRoot);
        const std::string request = (root / "tn-playtest-request.json").string();
        const std::string response = (root / "tn-playtest-response.json").string();
        const std::string mailbox = "globalThis.TN_PLAYTEST_ENDPOINT='native://desktop-mailbox';"
            "globalThis.TN_PLAYTEST_MAILBOX={request:" + javascriptString(request)
            + ",response:" + javascriptString(response) + "};";
        if (!runtime->evalScript(mailbox, "threenative-playtest-mailbox.js")) {
            std::cerr << "Error: Failed to configure the desktop playtest mailbox." << std::endl;
            return false;
        }
        std::cout << "[Mystral] Desktop playtest mailbox configured" << std::endl;
    }
    return true;
}

static int runScreenshotMode(
    const CLIOptions& opts, std::unique_ptr<mystral::Runtime>& runtime) {
    mystral::Runtime& host = *runtime;
    auto startTime = std::chrono::high_resolution_clock::now();
    for (int frame = 0; frame < opts.frames; frame++) {
        // Request a framebuffer capture before each screenshot frame.
        host.requestFrameScreenshot();
        if (!host.pollEvents()) {
            if (!opts.quiet) {
                std::cerr << "Warning: Runtime quit early at frame " << frame << std::endl;
            }
            break;
        }
        // saveScreenshot() owns the GPU readback fence, so no fixed delay is needed here.
    }
    // The requested frames are done; the world may still not be on screen. StartupReadiness
    // resolves on five consecutive in-budget frames or, for a host that never produces one — every
    // software rasteriser — only when its bounded window expires. A 300-frame run on llvmpipe
    // finished in 3.0s against that 10s window and captured five distinct colours, while a slower
    // run of the same build took 16.8s, crossed it, and captured 17,163. Keep presenting until the
    // gate opens so the capture holds the world rather than the loading state.
    //
    // Bounded by the gate's own worst case plus margin: a game that never becomes ready must still
    // produce a frame and a report rather than hanging the lane.
    //
    // Ordering matters as much as presence. The two-flag wait this replaced ended the instant
    // readiness flipped, and a buffer filled during loading stayed filled — CI run 33789430714
    // printed TN_STARTUP_CAPTURE_READY:1 one line after its last present and saved a progress bar
    // at 92%. The gate drops any pre-readiness capture and keeps driving frames until a fresh one
    // lands, so the frame that gets saved postdates readiness.
    constexpr auto kStartupCaptureBudget = std::chrono::seconds(30);
    mystral::ScreenshotGateHooks captureHooks;
    captureHooks.requestFrameScreenshot = [&host] { host.requestFrameScreenshot(); };
    captureHooks.pollEvents = [&host] { return host.pollEvents(); };
    captureHooks.isStartupReady = [&host] { return host.isStartupReady(); };
    captureHooks.hasCapturedFrame = [&host] { return host.hasCapturedFrame(); };
    captureHooks.clearCapturedFrame = [&host] { host.clearCapturedFrame(); };
    captureHooks.now = [] { return std::chrono::steady_clock::now(); };
    const mystral::ScreenshotGateResult capture = mystral::awaitStartupCapture(
        captureHooks, std::chrono::steady_clock::now() + kStartupCaptureBudget);
    if (!opts.quiet) {
        if (capture.ready && capture.captured) {
            std::cout << "TN_STARTUP_CAPTURE_READY:1" << std::endl;
        } else {
            std::cerr << "Warning: startup gate never opened within "
                      << kStartupCaptureBudget.count() << "s; capturing anyway." << std::endl;
            std::cout << "TN_STARTUP_CAPTURE_READY:0" << std::endl;
        }
        // The gate drives frames of its own — the refresh that guarantees the saved capture
        // postdates readiness — and each is one present beyond the requested frame count.
        // Naming them keeps the one-present-per-frame invariant exact instead of loosened.
        std::cout << "TN_CAPTURE_REFRESH_PRESENTS:" << capture.presents << std::endl;
    }
    auto endTime = std::chrono::high_resolution_clock::now();
    auto duration = std::chrono::duration_cast<std::chrono::milliseconds>(endTime - startTime);
    bool success = host.saveScreenshot(opts.screenshotPath);
    if (!opts.quiet) {
        if (success) {
            std::cout << "Screenshot saved: " << opts.screenshotPath << std::endl;
            std::cout << "Rendered " << opts.frames << " frames in " << duration.count() << "ms" << std::endl;
            // One present per frame is what lets a second pass -- the canvas-layer overlay --
            // composite onto the world instead of taking a swapchain image of its own.
            std::cout << "TN_PRESENTS:" << host.getPresentCount() << std::endl;
        } else {
            std::cerr << "Error: Failed to save screenshot!" << std::endl;
        }
    }
    // Finalize capture before the deliberate exit; runtime destruction may crash after screenshots.
    host.finalizePipelineCapture();
    std::cout.flush();
    std::cerr.flush();
#ifndef MYSTRAL_CLI_NO_MAIN
    dumpLlvmProfile();
    _exit(finalizeCpuProfile(success ? 0 : 1));
#else
    runtime.reset();
    return finalizeCpuProfile(success ? 0 : 1);
#endif
}

#if !TN_ENABLE_VIDEO
static int runVideoMode(const CLIOptions&, std::unique_ptr<mystral::Runtime>&) {
    std::cerr << "Error: Video recording is disabled in this build (configure with -DTN_ENABLE_VIDEO=ON)" << std::endl;
    return 1;
}
#else
#ifdef MYSTRAL_HAS_WEBP_MUX
static int runLegacyWebPVideo(const CLIOptions& opts, std::unique_ptr<mystral::Runtime>& runtime) {
    if (!opts.quiet) {
        std::cout << "[Video] Falling back to legacy WebP recorder..." << std::endl;
    }
    std::string webpPath = opts.videoPath;
    std::string mp4Path;
    bool needsConversion = opts.convertToMp4;
    if (needsConversion) {
        mp4Path = opts.videoPath;
        size_t dotPos = mp4Path.rfind('.');
        if (dotPos != std::string::npos) mp4Path = mp4Path.substr(0, dotPos) + ".mp4";
        else mp4Path = mp4Path + ".mp4";
        dotPos = webpPath.rfind('.');
        if (dotPos != std::string::npos) {
            std::string ext = webpPath.substr(dotPos);
            if (ext != ".webp" && ext != ".WEBP") webpPath = webpPath.substr(0, dotPos) + ".webp";
        } else {
            webpPath = webpPath + ".webp";
        }
    }

    WebPVideoRecorder legacyRecorder(opts.width, opts.height, opts.videoFps, opts.videoQuality);
    if (!legacyRecorder.isValid()) {
        std::cerr << "Error: Failed to create video recorder" << std::endl;
        return 1;
    }
    if (!opts.quiet) {
        std::cout << "[Video] Recording " << (opts.endFrame - opts.startFrame + 1) << " frames..." << std::endl;
    }

    std::queue<std::vector<uint8_t>> frameQueue;
    std::mutex queueMutex;
    std::condition_variable queueCondition;
    std::atomic<bool> encodingDone{false};
    std::atomic<int> encodedFrames{0};
    const int maxQueuedFrames = 30;
    std::thread encoderThread([&]() {
        while (true) {
            std::vector<uint8_t> frameData;
            {
                std::unique_lock<std::mutex> lock(queueMutex);
                queueCondition.wait(lock, [&]() {
                    return encodingDone.load(std::memory_order_acquire) || !frameQueue.empty();
                });
                if (frameQueue.empty() && encodingDone.load(std::memory_order_acquire)) break;
                frameData = std::move(frameQueue.front());
                frameQueue.pop();
            }
            if (!frameData.empty()) {
                legacyRecorder.addFrame(frameData.data());
                encodedFrames++;
            }
        }
    });

    auto startTime = std::chrono::high_resolution_clock::now();
    int capturedFrames = 0;
    for (int frame = 0; frame <= opts.endFrame; frame++) {
        if (!runtime->pollEvents()) {
            if (!opts.quiet) std::cerr << "[Video] Runtime quit early at frame " << frame << std::endl;
            break;
        }
        if (frame >= opts.startFrame) {
            std::vector<uint8_t> frameData;
            uint32_t frameWidth, frameHeight;
            if (runtime->captureFrame(frameData, frameWidth, frameHeight)) {
                bool queued = false;
                {
                    std::lock_guard<std::mutex> lock(queueMutex);
                    if (frameQueue.size() < static_cast<size_t>(maxQueuedFrames)) {
                        frameQueue.push(std::move(frameData));
                        queued = true;
                    }
                }
                if (queued) queueCondition.notify_one();
                if (queued) {
                    capturedFrames++;
                    if (!opts.quiet && capturedFrames % 60 == 0) {
                        std::cout << "[Video] Captured frame " << capturedFrames << "/" << (opts.endFrame - opts.startFrame + 1)
                                  << " (queue: " << frameQueue.size() << ", encoded: " << encodedFrames.load() << ")" << std::endl;
                    }
                }
            }
        }
    }
    encodingDone = true;
    queueCondition.notify_one();
    encoderThread.join();
    auto endTime = std::chrono::high_resolution_clock::now();
    auto duration = std::chrono::duration_cast<std::chrono::milliseconds>(endTime - startTime);
    runtime.reset();
    SDL_PumpEvents();

    bool success = legacyRecorder.save(webpPath);
    if (success) {
        if (!opts.quiet) {
            std::cout << "[Video] Saved WebP: " << webpPath << std::endl;
            std::cout << "[Video] Recorded " << capturedFrames << " frames in " << duration.count() << "ms" << std::endl;
        }
        if (needsConversion && convertWebPToMP4(webpPath, mp4Path, opts.videoFps, true, opts.quiet)) {
            if (!opts.quiet) {
                std::cout << "[Video] Converted to MP4: " << mp4Path << std::endl;
            }
        }
    }
    std::cout.flush();
    std::cerr.flush();
    _exit(finalizeCpuProfile(success ? 0 : 1));
}
#endif

static int runVideoRecorder(const CLIOptions& opts, std::unique_ptr<mystral::Runtime>& runtime,
                            std::unique_ptr<mystral::video::VideoRecorder>& recorder,
                            const std::string& outputPath) {
    if (!opts.quiet) {
        std::cout << "[Video] Using " << recorder->getTypeName() << std::endl;
        std::cout << "[Video] Recording " << (opts.endFrame - opts.startFrame + 1) << " frames to " << outputPath << std::endl;
    }
    mystral::video::VideoRecorderConfig recConfig;
    recConfig.fps = opts.videoFps;
    recConfig.width = opts.width;
    recConfig.height = opts.height;
    recConfig.quality = opts.videoQuality;
    recConfig.convertToMp4 = opts.convertToMp4;
    if (!recorder->startRecording(runtime->getSDLWindow(), outputPath, recConfig)) {
        std::cerr << "Error: Failed to start video recording" << std::endl;
        return 1;
    }

    auto startTime = std::chrono::high_resolution_clock::now();
    for (int frame = 0; frame <= opts.endFrame; frame++) {
        if (!runtime->pollEvents()) {
            if (!opts.quiet) std::cerr << "[Video] Runtime quit early at frame " << frame << std::endl;
            break;
        }
        if (frame >= opts.startFrame) {
            void* texture = runtime->getCurrentTexture();
            if (texture) recorder->captureFrame(texture, opts.width, opts.height);
        }
        recorder->processFrame();
        if (!opts.quiet && frame >= opts.startFrame && (frame - opts.startFrame) % 60 == 0) {
            auto stats = recorder->getStats();
            std::cout << "[Video] Frame " << (frame - opts.startFrame) << "/" << (opts.endFrame - opts.startFrame + 1)
                      << " (captured: " << stats.capturedFrames << ", dropped: " << stats.droppedFrames << ")" << std::endl;
        }
    }
    bool success = recorder->stopRecording();
    auto endTime = std::chrono::high_resolution_clock::now();
    auto duration = std::chrono::duration_cast<std::chrono::milliseconds>(endTime - startTime);
    if (success) {
        auto stats = recorder->getStats();
        if (!opts.quiet) {
            std::cout << "[Video] Recording complete: " << outputPath << std::endl;
            std::cout << "[Video] Captured " << stats.capturedFrames << " frames in " << duration.count() << "ms" << std::endl;
            if (stats.droppedFrames > 0) {
                std::cout << "[Video] Dropped " << stats.droppedFrames << " frames" << std::endl;
            }
        }
    }
    recorder.reset();
    runtime.reset();
    SDL_PumpEvents();
    std::cout.flush();
    std::cerr.flush();
    _exit(finalizeCpuProfile(success ? 0 : 1));
}

static int runVideoMode(const CLIOptions& opts, std::unique_ptr<mystral::Runtime>& runtime) {
    if (opts.endFrame < 0) {
        std::cerr << "Error: --end-frame is required for video recording" << std::endl;
        std::cerr << "Example: mystral run game.js --video output.mp4 --end-frame 300" << std::endl;
        return 1;
    }
    if (opts.endFrame <= opts.startFrame) {
        std::cerr << "Error: --end-frame must be greater than --start-frame" << std::endl;
        return 1;
    }

    bool useNative = opts.useNativeCapture && mystral::video::VideoRecorder::isNativeCaptureAvailable();
    std::string outputPath = opts.videoPath;
    if (useNative) {
        size_t dotPos = outputPath.rfind('.');
        if (dotPos != std::string::npos) {
            std::string ext = outputPath.substr(dotPos);
            if (ext != ".mp4" && ext != ".MP4") outputPath = outputPath.substr(0, dotPos) + ".mp4";
        } else {
            outputPath += ".mp4";
        }
    }

    std::unique_ptr<mystral::video::VideoRecorder> recorder;
    if (useNative) {
        recorder = mystral::video::VideoRecorder::create(nullptr, nullptr, nullptr, runtime->getWebGPUBindingsState());
    } else {
        recorder = mystral::video::VideoRecorder::create(
            static_cast<WGPUDevice>(runtime->getWGPUDevice()),
            static_cast<WGPUQueue>(runtime->getWGPUQueue()),
            static_cast<WGPUInstance>(runtime->getWGPUInstance()),
            runtime->getWebGPUBindingsState());
    }
    if (!recorder) {
#ifdef MYSTRAL_HAS_WEBP_MUX
        return runLegacyWebPVideo(opts, runtime);
#else
        std::cerr << "Error: Video recording requires libwebpmux (build with MYSTRAL_HAS_WEBP_MUX)" << std::endl;
        return 1;
#endif
    }
    return runVideoRecorder(opts, runtime, recorder, outputPath);
}
#endif

#if TN_ENABLE_DEBUG_SERVER
static std::string handleKeyboardDebugCommand(const std::string& method, const std::string& params) {
    std::string subMethod = method.substr(9);
    std::string keyName = extractJsonString(params, "key");
    if (subMethod == "press") {
        SDL_Scancode scancode = keyNameToScancode(keyName);
        if (scancode == SDL_SCANCODE_UNKNOWN) return "{\"error\":\"Unknown key: " + keyName + "\"}";
        injectKeyboardEvent(scancode, true);
        injectKeyboardEvent(scancode, false);
        return "{}";
    }
    if (subMethod == "down" || subMethod == "up") {
        SDL_Scancode scancode = keyNameToScancode(keyName);
        if (scancode == SDL_SCANCODE_UNKNOWN) return "{\"error\":\"Unknown key: " + keyName + "\"}";
        injectKeyboardEvent(scancode, subMethod == "down");
        return "{}";
    }
    if (subMethod == "type") {
        std::string text = extractJsonString(params, "text");
        for (char character : text) {
            SDL_Scancode scancode = keyNameToScancode(std::string(1, character));
            if (scancode != SDL_SCANCODE_UNKNOWN) {
                injectKeyboardEvent(scancode, true);
                injectKeyboardEvent(scancode, false);
            }
        }
        return "{}";
    }
    return "{\"error\":\"Unknown keyboard method: " + subMethod + "\"}";
}

static std::string handleMouseDebugCommand(const std::string& method, const std::string& params) {
    std::string subMethod = method.substr(6);
    float x = static_cast<float>(extractJsonNumber(params, "x", 0));
    float y = static_cast<float>(extractJsonNumber(params, "y", 0));
    std::string buttonStr = extractJsonString(params, "button");
    int button = SDL_BUTTON_LEFT;
    if (buttonStr == "right") button = SDL_BUTTON_RIGHT;
    else if (buttonStr == "middle") button = SDL_BUTTON_MIDDLE;
    if (subMethod == "move") {
        injectMouseMotion(x, y);
        return "{}";
    }
    if (subMethod == "click") {
        injectMouseButton(x, y, button, true);
        injectMouseButton(x, y, button, false);
        return "{}";
    }
    if (subMethod == "down" || subMethod == "up") {
        injectMouseButton(x, y, button, subMethod == "down");
        return "{}";
    }
    return "{\"error\":\"Unknown mouse method: " + subMethod + "\"}";
}

static std::string handleGamepadDebugCommand(const std::string& method, const std::string& params) {
    std::string subMethod = method.substr(8);
    if (subMethod == "press") {
        std::string buttonStr = extractJsonString(params, "button");
        SDL_GamepadButton button = SDL_GAMEPAD_BUTTON_INVALID;
        if (buttonStr == "A" || buttonStr == "a") button = SDL_GAMEPAD_BUTTON_SOUTH;
        else if (buttonStr == "B" || buttonStr == "b") button = SDL_GAMEPAD_BUTTON_EAST;
        else if (buttonStr == "X" || buttonStr == "x") button = SDL_GAMEPAD_BUTTON_WEST;
        else if (buttonStr == "Y" || buttonStr == "y") button = SDL_GAMEPAD_BUTTON_NORTH;
        else if (buttonStr == "LB" || buttonStr == "L1") button = SDL_GAMEPAD_BUTTON_LEFT_SHOULDER;
        else if (buttonStr == "RB" || buttonStr == "R1") button = SDL_GAMEPAD_BUTTON_RIGHT_SHOULDER;
        else if (buttonStr == "Back" || buttonStr == "Select") button = SDL_GAMEPAD_BUTTON_BACK;
        else if (buttonStr == "Start") button = SDL_GAMEPAD_BUTTON_START;
        else if (buttonStr == "Guide" || buttonStr == "Home") button = SDL_GAMEPAD_BUTTON_GUIDE;
        else if (buttonStr == "LS" || buttonStr == "L3") button = SDL_GAMEPAD_BUTTON_LEFT_STICK;
        else if (buttonStr == "RS" || buttonStr == "R3") button = SDL_GAMEPAD_BUTTON_RIGHT_STICK;
        else if (buttonStr == "DPadUp") button = SDL_GAMEPAD_BUTTON_DPAD_UP;
        else if (buttonStr == "DPadDown") button = SDL_GAMEPAD_BUTTON_DPAD_DOWN;
        else if (buttonStr == "DPadLeft") button = SDL_GAMEPAD_BUTTON_DPAD_LEFT;
        else if (buttonStr == "DPadRight") button = SDL_GAMEPAD_BUTTON_DPAD_RIGHT;
        if (button == SDL_GAMEPAD_BUTTON_INVALID) return "{\"error\":\"Unknown gamepad button: " + buttonStr + "\"}";
        SDL_Event event;
        SDL_zero(event);
        event.type = SDL_EVENT_GAMEPAD_BUTTON_DOWN;
        event.gbutton.button = button;
        event.gbutton.down = true;
        SDL_PushEvent(&event);
        event.type = SDL_EVENT_GAMEPAD_BUTTON_UP;
        event.gbutton.down = false;
        SDL_PushEvent(&event);
        return "{}";
    }
    if (subMethod == "axis") {
        std::string axisStr = extractJsonString(params, "axis");
        float x = static_cast<float>(extractJsonNumber(params, "x", 0));
        float y = static_cast<float>(extractJsonNumber(params, "y", 0));
        SDL_GamepadAxis axisX = SDL_GAMEPAD_AXIS_INVALID;
        SDL_GamepadAxis axisY = SDL_GAMEPAD_AXIS_INVALID;
        if (axisStr == "leftStick" || axisStr == "left") {
            axisX = SDL_GAMEPAD_AXIS_LEFTX;
            axisY = SDL_GAMEPAD_AXIS_LEFTY;
        } else if (axisStr == "rightStick" || axisStr == "right") {
            axisX = SDL_GAMEPAD_AXIS_RIGHTX;
            axisY = SDL_GAMEPAD_AXIS_RIGHTY;
        }
        if (axisX == SDL_GAMEPAD_AXIS_INVALID) return "{\"error\":\"Unknown gamepad axis: " + axisStr + "\"}";
        SDL_Event event;
        SDL_zero(event);
        event.type = SDL_EVENT_GAMEPAD_AXIS_MOTION;
        event.gaxis.axis = axisX;
        event.gaxis.value = static_cast<int16_t>(x * 32767);
        SDL_PushEvent(&event);
        event.gaxis.axis = axisY;
        event.gaxis.value = static_cast<int16_t>(y * 32767);
        SDL_PushEvent(&event);
        return "{}";
    }
    return "{\"error\":\"Unknown gamepad method: " + subMethod + "\"}";
}

static std::string handleDebugCommand(mystral::Runtime& runtime, int frameCount,
                                      const std::string& method, const std::string& params) {
    if (method == "getFrameCount" || method == "waitForFrame") {
        return "{\"frame\":" + std::to_string(frameCount) + "}";
    }
    if (method == "screenshot") {
        std::vector<uint8_t> frameData;
        uint32_t width, height;
        if (runtime.captureFrame(frameData, width, height)) {
            std::vector<uint8_t> pngData;
            if (stbi_write_png_to_func(pngWriteCallback, &pngData, width, height, 4, frameData.data(), width * 4)) {
                std::string base64 = base64Encode(pngData.data(), pngData.size());
                return "{\"data\":\"" + base64 + "\",\"width\":" + std::to_string(width) + ",\"height\":" + std::to_string(height) + "}";
            }
            return "{\"error\":\"Failed to encode PNG\"}";
        }
        return "{\"error\":\"Failed to capture frame\"}";
    }
    if (method.rfind("keyboard.", 0) == 0) return handleKeyboardDebugCommand(method, params);
    if (method.rfind("mouse.", 0) == 0) return handleMouseDebugCommand(method, params);
    if (method.rfind("gamepad.", 0) == 0) return handleGamepadDebugCommand(method, params);
    if (method == "evaluate") return "{\"error\":\"evaluate not yet implemented\"}";
    return "{\"error\":\"Unknown method: " + method + "\"}";
}

static std::unique_ptr<mystral::debug::DebugServer> createDebugServer(
    const CLIOptions& opts, mystral::Runtime& runtime, int& frameCount) {
    if (opts.debugPort <= 0) return nullptr;
    auto debugServer = std::make_unique<mystral::debug::DebugServer>(opts.debugPort);
    if (!debugServer->start()) {
        std::cerr << "Warning: Failed to start debug server on port " << opts.debugPort << std::endl;
        return nullptr;
    }
    mystral::Runtime* runtimePointer = &runtime;
    int* frameCountPointer = &frameCount;
    debugServer->setCommandHandler(
        [runtimePointer, frameCountPointer](const std::string& method, const std::string& params) {
            return handleDebugCommand(*runtimePointer, *frameCountPointer, method, params);
        });
    if (!opts.quiet) {
        std::cout << "[DebugServer] Listening on ws://127.0.0.1:" << opts.debugPort << std::endl;
    }
    return debugServer;
}
#endif

static int runNormalMode(const CLIOptions& opts, mystral::Runtime& runtime) {
#if !TN_ENABLE_DEBUG_SERVER
    if (opts.debugPort > 0) {
        std::cerr << "Error: Debug server is disabled in this build (configure with -DTN_ENABLE_DEBUG_SERVER=ON)" << std::endl;
        return 1;
    }
#else
    std::unique_ptr<mystral::debug::DebugServer> debugServer;
    int frameCount = 0;
    debugServer = createDebugServer(opts, runtime, frameCount);
    if (debugServer) {
        while (runtime.pollEvents()) {
            frameCount++;
            if (debugServer->getClientCount() > 0) {
                debugServer->broadcastEvent("frameRendered", "{\"frame\":" + std::to_string(frameCount) + "}");
            }
        }
        int exitCode = runtime.getExitCode();
        debugServer->broadcastEvent("exit", "{\"code\":" + std::to_string(exitCode) + "}");
        debugServer->stop();
    } else
#endif
    {
        runtime.run();
    }

    int exitCode = runtime.getExitCode();
    if (!opts.uiRoot.empty() && !opts.bypassUiLoading &&
        !mystral::platform::uiReadyIntentReceived()) {
        std::cerr << "TN_UI_LOAD_FAILED: the web UI exited before its tn:ready intent." << std::endl;
        exitCode = 1;
    }
    if (!opts.quiet) std::cout << "=== Script finished ===" << std::endl;
#ifndef MYSTRAL_CLI_NO_MAIN
    exitCode = finalizeCpuProfile(exitCode);
#ifdef __APPLE__
    // SDL3's audio callback threads can prevent graceful shutdown, so give them a moment then kill.
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
    kill(getpid(), SIGKILL);
    return exitCode;
#elif !defined(_WIN32)
    dumpLlvmProfile();
    _exit(exitCode);
#else
    ExitProcess(exitCode);
#endif
#else
    return finalizeCpuProfile(exitCode);
#endif
}

static int driveMainLoop(const CLIOptions& opts, std::unique_ptr<mystral::Runtime>& runtime) {
    if (!opts.screenshotPath.empty()) return runScreenshotMode(opts, runtime);
    if (!opts.videoPath.empty()) return runVideoMode(opts, runtime);
    return runNormalMode(opts, *runtime);
}

int runScript(const CLIOptions& opts) {
    std::ifstream script(opts.scriptPath);
    if (!script.is_open() && opts.scriptPath != mystral::vfs::getEmbeddedEntryPath()) {
        std::cerr << "Error: Cannot open file: " << opts.scriptPath << std::endl;
        return 1;
    }

    setupHeadlessEnvironment(opts);
#if TN_JS_PROFILE || TN_ANDROID_JS_PROFILE
    if (!opts.cpuProfilePath.empty()) mystral::js::g_cpuProfilePath = opts.cpuProfilePath;
#else
    if (!opts.cpuProfilePath.empty()) {
        std::cerr << "Error: --cpu-prof requires a build compiled with TN_JS_PROFILE=ON." << std::endl;
        return 1;
    }
#endif
    bool screenshotMode = !opts.screenshotPath.empty();
    bool videoMode = !opts.videoPath.empty();
    printRunBanner(opts, screenshotMode, videoMode);
    auto runtime = createConfiguredRuntime(opts);
    if (!runtime) {
        std::cerr << "Error: Failed to create runtime!" << std::endl;
        return 1;
    }
    // Mirrors `android_main.cpp`. Before PRD-328 the desktop CLI emitted no launch markers at
    // all, so `first_frame` was the only one on the record and the whole of host bring-up, runtime
    // creation, JavaScript compile and top-level execution sat inside `residualMs` — 69.6 of a
    // 111.7 ms launch, unattributed, in the 2026-09-02 probe.
    mystral::coldStartMark("runtime_created");
    if (!attachUiOverlayIfConfigured(opts, *runtime)) return 1;
    if (!wirePlaytestMailboxBridge(runtime)) return 1;
    std::atomic<bool> stopUiDeadline{false};
    std::thread uiDeadline;
    if (!opts.uiRoot.empty() && !opts.bypassUiLoading) {
        uiDeadline = std::thread([&] {
            constexpr auto deadline = std::chrono::seconds(15);
            const auto expiresAt = std::chrono::steady_clock::now() + deadline;
            while (!stopUiDeadline.load(std::memory_order_acquire) &&
                   !mystral::platform::uiReadyIntentReceived() &&
                   std::chrono::steady_clock::now() < expiresAt) {
                std::this_thread::sleep_for(std::chrono::milliseconds(20));
            }
            if (stopUiDeadline.load(std::memory_order_acquire) ||
                mystral::platform::uiReadyIntentReceived()) return;
            std::cerr << "TN_UI_LOAD_FAILED: the web UI did not send its tn:ready intent within "
                      << "15 seconds." << std::endl;
            std::_Exit(1);
        });
    }
    auto stopUiDeadlineAndReport = [&] {
        stopUiDeadline.store(true, std::memory_order_release);
        if (uiDeadline.joinable()) uiDeadline.join();
        return !opts.uiRoot.empty() && !opts.bypassUiLoading &&
               !mystral::platform::uiReadyIntentReceived();
    };
    // Load and execute the script after host bridges exist and before mode dispatch starts.
    // The runtime evaluates its own bootstrap scripts first, so the engine's compile markers fire
    // more than once a launch. This brackets the one that is the game.
    mystral::coldStartMark("game_eval_begin");
    if (!runtime->loadScript(opts.scriptPath)) {
        // The window is already open, so this is the one failure a developer sees without reading
        // a log: the title says the game did not start, the line is prefixed so a grep finds it,
        // and the process exits non-zero rather than leaving a window that draws nothing. A launch
        // that survives a bundle which never evaluated is the silent failure this refuses.
        const char* title = "ThreeNative - the game did not start (TN_FATAL in the log)";
        mystral::platform::setWindowTitle(title);
        std::cerr << "[TN_FATAL] the game script did not load: " << opts.scriptPath << std::endl;
        stopUiDeadlineAndReport();
        return 1;
    }
#if TN_JS_PROFILE || TN_ANDROID_JS_PROFILE
    // After runtime startup (SDL resets dispositions); the render loop flushes on the flag.
    if (!opts.cpuProfilePath.empty())
        std::signal(SIGTERM, [](int) { mystral::js::g_cpuProfileStopRequested = 1; });
#endif
    const int exitCode = driveMainLoop(opts, runtime);
    return stopUiDeadlineAndReport() ? 1 : exitCode;
}

namespace mystral::cli {
int runCli(int argc, char* argv[]) {
    // First marker of the launch, and the one that pins the launch thread for `ColdStartEvalScope`
    // (see `mystral/cold_start.h`). It must stay the first `coldStartMark` on this entry point.
    mystral::coldStartMark("process");
    CLIOptions opts = parseArgs(argc, argv);
    std::string embeddedEntry = mystral::vfs::getEmbeddedEntryPath();

    // Handle --version
    if (opts.showVersion) {
        printVersion();
        return 0;
    }

    // Handle --help
    if (opts.showHelp) {
        printHelp();
        return 0;
    }

    // If we have an embedded entry and no explicit command, treat it as run
    if (opts.command.empty() && !embeddedEntry.empty()) {
        opts.command = "run";
        opts.scriptPath = embeddedEntry;
    }
    applyEmbeddedConfig(opts);

    // Handle no args with no embedded entry
    if (opts.command.empty() && argc < 2) {
        printHelp();
        return 1;
    }

    // Build-time commands execute in the separate tools binary. Keeping the dispatch seam in the
    // runtime CLI preserves the public command surface without copying bundler/lightmap bodies
    // into every compiled game.
    if (opts.command == "compile" || opts.command == "bake") {
        return mystral::cli::dispatchBuildTool(argc, argv);
    }

    // Handle 'run' command
    if (opts.command == "run") {
        if (opts.scriptPath.empty()) {
            if (!embeddedEntry.empty()) {
                opts.scriptPath = embeddedEntry;
            } else {
                std::cerr << "Error: No script file specified." << std::endl;
                std::cerr << "Usage: mystral run <script.js>" << std::endl;
                return 1;
            }
        }
        return runScript(opts);
    }

    // Unknown command
    std::cerr << "Error: Unknown command or missing arguments." << std::endl;
    printHelp();
    return 1;
}

}  // namespace mystral::cli

#ifndef MYSTRAL_CLI_NO_MAIN
int main(int argc, char* argv[]) {
    return mystral::cli::runCli(argc, argv);
}
#endif
