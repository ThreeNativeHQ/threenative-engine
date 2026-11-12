// One native table for every host (PRD-880 phase 2).
//
// The SDL3 -> W3C "standard" table used to exist twice: once in the owned engine player
// (`tnPollGamepads`) and once in the legacy host (`platform::getGamepadState`), with different
// counts — 6 axes and 17 buttons on the legacy side, 4 and 16 on the engine side — so a binding
// such as `gamepadAxes: [4]` read a trigger on Android and nothing on desktop. This test attaches
// one SDL virtual gamepad and requires both entry points to report the same state: the left stick
// on axes 0 and 1, the right trigger on button 7, the south button on button 0.

#include "engine/player/gamepads.h"
#include "mystral/platform/input.h"

#include <SDL3/SDL.h>

#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>

namespace platform = mystral::platform;

// window.cpp declares the same hook: it is the SDL_EVENT_GAMEPAD_ADDED handler, not public API.
namespace mystral {
namespace platform {
void processGamepadConnected(SDL_JoystickID id);
}
}  // namespace mystral

namespace {

int failures = 0;

void require(bool condition, const char* what) {
    if (condition) return;
    ++failures;
    std::fprintf(stderr, "FAILED: %s\n", what);
}

void requireClose(double actual, double expected, const char* what) {
    if (std::fabs(actual - expected) <= 0.0001) return;
    ++failures;
    std::fprintf(stderr, "FAILED: %s (expected %.4f, got %.4f)\n", what, expected, actual);
}

/** A virtual pad SDL treats as a gamepad, with a mapping so `SDL_OpenGamepad` applies. */
struct AttachedPad {
    SDL_JoystickID id = 0;
    SDL_Joystick* joystick = nullptr;
};

AttachedPad attachPad(const char* name) {
    SDL_VirtualJoystickDesc desc;
    SDL_INIT_INTERFACE(&desc);
    desc.type = SDL_JOYSTICK_TYPE_GAMEPAD;
    desc.naxes = 6;
    desc.nbuttons = 16;
    desc.nhats = 1;
    desc.name = name;
    AttachedPad pad;
    pad.id = SDL_AttachVirtualJoystick(&desc);
    if (pad.id == 0) {
        std::fprintf(stderr, "FAILED: SDL_AttachVirtualJoystick: %s\n", SDL_GetError());
        return pad;
    }
    // A virtual joystick has no database entry, so the mapping is added for its own GUID — before the
    // pad is opened as a gamepad, which is when SDL looks the mapping up.
    char guid[64];
    SDL_GUIDToString(SDL_GetJoystickGUIDForID(pad.id), guid, sizeof(guid));
    const std::string mapping = std::string(guid) +
        ",TN Test Pad,a:b0,b:b1,x:b2,y:b3,back:b6,start:b7,leftstick:b8,rightstick:b9,"
        "leftshoulder:b4,rightshoulder:b5,dpup:h0.1,dpdown:h0.4,dpleft:h0.8,dpright:h0.2,"
        "leftx:a0,lefty:a1,rightx:a2,righty:a3,lefttrigger:a4,righttrigger:a5,";
    if (SDL_AddGamepadMapping(mapping.c_str()) < 0) {
        std::fprintf(stderr, "FAILED: SDL_AddGamepadMapping: %s\n", SDL_GetError());
        return pad;
    }
    SDL_Gamepad* gamepad = SDL_OpenGamepad(pad.id);
    if (gamepad == nullptr) {
        std::fprintf(stderr, "FAILED: SDL_OpenGamepad: %s\n", SDL_GetError());
        return pad;
    }
    pad.joystick = SDL_GetGamepadJoystick(gamepad);
    return pad;
}

bool samePad(const platform::GamepadState& engine, const platform::GamepadState& legacy) {
    bool same = engine.numAxes == legacy.numAxes && engine.numButtons == legacy.numButtons &&
                engine.connected == legacy.connected;
    for (int index = 0; index < engine.numAxes && index < legacy.numAxes; ++index)
        same = same && std::fabs(engine.axes[index] - legacy.axes[index]) <= 0.0001;
    for (int index = 0; index < engine.numButtons && index < legacy.numButtons; ++index)
        same = same && engine.buttons[index] == legacy.buttons[index] &&
               std::fabs(engine.buttonValues[index] - legacy.buttonValues[index]) <= 0.0001;
    return same;
}

int gamepadStandard() {
    if (!SDL_Init(SDL_INIT_GAMEPAD)) {
        std::fprintf(stderr, "FAILED: SDL_Init(SDL_INIT_GAMEPAD): %s\n", SDL_GetError());
        return 1;
    }
    const AttachedPad pad = attachPad("TN Test Pad");
    if (pad.id == 0 || pad.joystick == nullptr) return 1;
    SDL_Joystick* joystick = pad.joystick;

    // Full right on the left stick, half-travel right trigger, south button down.
    SDL_SetJoystickVirtualAxis(joystick, SDL_GAMEPAD_AXIS_LEFTX, 32767);
    SDL_SetJoystickVirtualAxis(joystick, SDL_GAMEPAD_AXIS_LEFTY, 0);
    SDL_SetJoystickVirtualAxis(joystick, SDL_GAMEPAD_AXIS_RIGHT_TRIGGER, 20000);
    SDL_SetJoystickVirtualButton(joystick, SDL_GAMEPAD_BUTTON_SOUTH, true);
    SDL_UpdateJoysticks();

    // The legacy host tracks pads through its SDL_EVENT_GAMEPAD_ADDED handler.
    platform::processGamepadConnected(pad.id);
    platform::GamepadState legacy{};
    require(platform::getGamepadState(0, &legacy), "the legacy host reports the attached pad");

    platform::GamepadState engineStates[4]{};
    const int engineCount = tn::engine::player::tnPollGamepads(engineStates, 4);
    const platform::GamepadState* engine = nullptr;
    for (int index = 0; index < engineCount; ++index)
        if (engineStates[index].id.find("TN Test Pad") != std::string::npos)
            engine = &engineStates[index];
    require(engine != nullptr, "the engine player reports the attached pad");
    if (engine == nullptr) return 1;

    require(legacy.numAxes == 4, "the legacy host reports 4 stick axes");
    require(legacy.numButtons == 16, "the legacy host reports the standard's 16 buttons");
    require(engine->numAxes == 4, "the engine player reports 4 stick axes");
    require(engine->numButtons == 16, "the engine player reports the standard's 16 buttons");
    require(samePad(*engine, legacy), "both entry points report the same pad");

    requireClose(engine->axes[0], 1.0, "the left stick's x is on axis 0");
    requireClose(engine->axes[1], 0.0, "the left stick's y is on axis 1");
    require(engine->buttons[0], "the south button is button 0");
    require(engine->buttons[7], "the right trigger is button 7");
    require(!engine->buttons[6], "the left trigger stays up");

    require(SDL_DetachVirtualJoystick(pad.id), "the virtual pad detaches");
    SDL_Quit();
    if (failures == 0) std::printf("gamepad_standard: ok\n");
    return failures == 0 ? 0 : 1;
}

}  // namespace

int main(int argc, char** argv) {
    const char* test = argc > 1 ? argv[1] : "gamepad_standard";
    if (std::strcmp(test, "gamepad_standard") == 0) return gamepadStandard();
    std::fprintf(stderr, "unknown test case: %s\n", test);
    return 1;
}
