#include "engine/player/gamepads.h"

#include "engine/foundation/flags.h"

#include <cstdint>
#include <cstdio>
#include <cstdlib>

#if defined(TN_PS4)
#include <orbis/Pad.h>
#include <orbis/UserService.h>
#else
#include <SDL3/SDL.h>
#endif

// The platform half of `navigator.getGamepads()` (v8_main.cpp installs the JavaScript side). A game
// reads controllers through the standard Web Gamepad API and nothing else (packages/core/src/input.ts
// samples `axes` and `buttons[i].pressed` once per step), so both branches below produce the same
// W3C "standard" mapping — the one a PS4 DualShock 4 and an SDL3 pad both already match.
namespace tn::engine::player {

namespace {

constexpr int kButtonCount = 16;  // the standard's 0..15; its 16 is the guide button, which neither API reports
constexpr int kAxisCount = 4;     // left x/y, right x/y: the standard's triggers are buttons 6 and 7
constexpr int kLeftTrigger = 6;
constexpr int kRightTrigger = 7;

/** An axis as the standard reports it: -1..1, negative up and positive down, clamped (travel can overshoot). */
double standardAxis(double raw) { return raw < -1.0 ? -1.0 : raw > 1.0 ? 1.0 : raw; }

#if defined(TN_PS4)

constexpr const char* kPadId = "DUALSHOCK 4 (PS4)";

// The W3C "standard" button index -> the DS4 bit for it, in the order the standard numbers them. The
// names are the OpenOrbis header's (orbis/_types/pad.h), so a bit this lane got wrong cannot compile.
constexpr uint32_t kButtonBits[kButtonCount] = {
    ORBIS_PAD_BUTTON_CROSS,      // 0
    ORBIS_PAD_BUTTON_CIRCLE,     // 1
    ORBIS_PAD_BUTTON_SQUARE,     // 2
    ORBIS_PAD_BUTTON_TRIANGLE,   // 3
    ORBIS_PAD_BUTTON_L1,         // 4
    ORBIS_PAD_BUTTON_R1,         // 5
    ORBIS_PAD_BUTTON_L2,         // 6  (value = the trigger's travel)
    ORBIS_PAD_BUTTON_R2,         // 7
    ORBIS_PAD_BUTTON_TOUCH_PAD,  // 8
    ORBIS_PAD_BUTTON_OPTIONS,    // 9
    ORBIS_PAD_BUTTON_L3,         // 10
    ORBIS_PAD_BUTTON_R3,         // 11
    ORBIS_PAD_BUTTON_UP,         // 12
    ORBIS_PAD_BUTTON_DOWN,       // 13
    ORBIS_PAD_BUTTON_LEFT,       // 14
    ORBIS_PAD_BUTTON_RIGHT,      // 15
};

int32_t g_handle = -1;          // the open pad, or < 0: the one attempt failed
int32_t g_user = -1;            // the console's initial user, the id scePadOpen takes
bool g_tried = false;           // the open attempt happens once, on the first poll
bool g_connected = false;       // and its success is reported once
uint32_t g_mask = 0xffffffffu;  // the last printed button mask; ~0 so the first read prints a baseline
// The guest cannot read the host's environment, so the change-only trace is on: one line per new mask.
bool g_trace = true;

/** A DS4 stick byte (0 left/up, 128 centre, 255 right/down) as the standard's -1..1. No dead zone. */
double stickAxis(uint8_t value) { return standardAxis((static_cast<int>(value) - 128) / 127.0); }

/**
 * The console's first pad belongs to its initial user, and scePadOpen takes that user's id rather
 * than the handle it returns, so the two stay apart here. The first failing step is what the failure
 * line reports; every later poll sees `g_handle < 0` and asks the library nothing more.
 */
void openPad() {
    g_tried = true;
    if (const char* trace = flags::once<flags::Ps4PadTrace>();
        trace != nullptr && trace[0] != '\0' && trace[0] != '0')
        g_trace = true;
    // An already-initialised user service (another library did it) returns an error that is no failure.
    sceUserServiceInitialize(nullptr);
    int32_t status = sceUserServiceGetInitialUser(&g_user);
    if (status >= 0) status = scePadInit();
    if (status >= 0) status = scePadOpen(g_user, ORBIS_PAD_PORT_TYPE_STANDARD, 0, nullptr);
    if (status >= 0) {
        g_handle = status;
        std::printf("TN_PS4_PAD opened user=%d handle=%d\n", g_user, g_handle);
        std::fflush(stdout);
        return;
    }
    std::printf("TN_PS4_PAD open failed: 0x%08x\n", static_cast<unsigned>(status));
    std::fflush(stdout);
}

void fillPad(mystral::platform::GamepadState& pad, const OrbisPadData& data) {
    pad.index = 0;
    pad.id = kPadId;
    pad.connected = true;
    pad.numAxes = kAxisCount;
    pad.axes[0] = stickAxis(data.leftStick.x);
    pad.axes[1] = stickAxis(data.leftStick.y);
    pad.axes[2] = stickAxis(data.rightStick.x);
    pad.axes[3] = stickAxis(data.rightStick.y);
    pad.numButtons = kButtonCount;
    for (int index = 0; index < kButtonCount; ++index) {
        const bool pressed = (data.buttons & kButtonBits[index]) != 0;
        // The triggers report their travel as the button's value, as a browser reports an analog one.
        double value = pressed ? 1.0 : 0.0;
        if (index == kLeftTrigger) value = data.analogButtons.l2 / 255.0;
        else if (index == kRightTrigger) value = data.analogButtons.r2 / 255.0;
        pad.buttons[index] = pressed;
        pad.buttonValues[index] = value;
    }
}

int pollPads(mystral::platform::GamepadState* out, int max) {
    if (out == nullptr || max < 1) return 0;
    if (!g_tried) openPad();
    if (g_handle < 0) return 0;
    OrbisPadData data{};
    const int32_t read = scePadReadState(g_handle, &data);
    if (read < 0 || data.connected == 0) {
        static bool reported = false;  // one line: a pad that never connects is a fact, not a flood
        if (!reported) {
            reported = true;
            std::printf("TN_PS4_PAD not connected: read=0x%08x connected=%d\n", static_cast<unsigned>(read), data.connected);
            std::fflush(stdout);
        }
        return 0;
    }
    if (!g_connected) {
        g_connected = true;
        std::printf("TN_PS4_PAD connected user=%d handle=%d\n", g_user, g_handle);
        std::fflush(stdout);
    }
    if (g_trace && data.buttons != g_mask) {
        g_mask = data.buttons;
        std::printf("TN_PS4_PAD buttons=0x%04x lx=%d ly=%d\n", static_cast<unsigned>(data.buttons),
                    data.leftStick.x, data.leftStick.y);
        std::fflush(stdout);
    }
    fillPad(out[0], data);
    return 1;
}

#else

// The W3C "standard" button index -> the SDL3 button for it, in the standard's own order.
constexpr SDL_GamepadButton kButtons[kButtonCount] = {
    SDL_GAMEPAD_BUTTON_SOUTH,            // 0  A / Cross
    SDL_GAMEPAD_BUTTON_EAST,             // 1  B / Circle
    SDL_GAMEPAD_BUTTON_WEST,             // 2  X / Square
    SDL_GAMEPAD_BUTTON_NORTH,            // 3  Y / Triangle
    SDL_GAMEPAD_BUTTON_LEFT_SHOULDER,    // 4
    SDL_GAMEPAD_BUTTON_RIGHT_SHOULDER,   // 5
    SDL_GAMEPAD_BUTTON_INVALID,          // 6  the left trigger: an axis, read as a button below
    SDL_GAMEPAD_BUTTON_INVALID,          // 7  the right trigger: the same
    SDL_GAMEPAD_BUTTON_BACK,             // 8  select / share
    SDL_GAMEPAD_BUTTON_START,            // 9  start / options
    SDL_GAMEPAD_BUTTON_LEFT_STICK,       // 10
    SDL_GAMEPAD_BUTTON_RIGHT_STICK,      // 11
    SDL_GAMEPAD_BUTTON_DPAD_UP,          // 12
    SDL_GAMEPAD_BUTTON_DPAD_DOWN,        // 13
    SDL_GAMEPAD_BUTTON_DPAD_LEFT,        // 14
    SDL_GAMEPAD_BUTTON_DPAD_RIGHT,       // 15
};

/** SDL's int16 travel as the standard's -1..1; -32768 clamps to -1. No dead zone. */
double padAxis(SDL_Gamepad* pad, SDL_GamepadAxis which) {
    return standardAxis(SDL_GetGamepadAxis(pad, which) / 32767.0);
}

int pollPads(mystral::platform::GamepadState* out, int max) {
    if (out == nullptr || max < 1) return 0;
    // The player's window already initialises SDL (platform/window.cpp); a host that did not still gets pads.
    static const bool ready = SDL_InitSubSystem(SDL_INIT_GAMEPAD);
    if (!ready) return 0;
    int total = 0;
    SDL_JoystickID* ids = SDL_GetGamepads(&total);
    if (ids == nullptr) return 0;
    int count = 0;
    for (int index = 0; index < total && count < max; ++index) {
        // An opened pad stays open for the process (SDL keeps it); opening it per poll would leak one.
        SDL_Gamepad* pad = SDL_GetGamepadFromID(ids[index]);
        if (pad == nullptr) pad = SDL_OpenGamepad(ids[index]);
        if (pad == nullptr) continue;
        mystral::platform::GamepadState& state = out[count++];
        const char* name = SDL_GetGamepadName(pad);
        state.index = index;
        state.id = name != nullptr ? name : "Gamepad";
        state.connected = true;
        state.numAxes = kAxisCount;
        state.axes[0] = padAxis(pad, SDL_GAMEPAD_AXIS_LEFTX);
        state.axes[1] = padAxis(pad, SDL_GAMEPAD_AXIS_LEFTY);
        state.axes[2] = padAxis(pad, SDL_GAMEPAD_AXIS_RIGHTX);
        state.axes[3] = padAxis(pad, SDL_GAMEPAD_AXIS_RIGHTY);
        state.numButtons = kButtonCount;
        for (int button = 0; button < kButtonCount; ++button) {
            double value = 0;
            bool pressed = false;
            if (button == kLeftTrigger || button == kRightTrigger) {
                value = padAxis(pad, button == kLeftTrigger ? SDL_GAMEPAD_AXIS_LEFT_TRIGGER
                                                           : SDL_GAMEPAD_AXIS_RIGHT_TRIGGER);
                pressed = value > 0.5;  // triggers travel 0..1, so the standard's reading is a threshold
            } else {
                pressed = SDL_GetGamepadButton(pad, kButtons[button]);
                value = pressed ? 1.0 : 0.0;
            }
            state.buttons[button] = pressed;
            state.buttonValues[button] = value;
        }
    }
    SDL_free(ids);
    return count;
}

#endif

}  // namespace

int tnPollGamepads(mystral::platform::GamepadState* out, int max) { return pollPads(out, max); }

}  // namespace tn::engine::player
