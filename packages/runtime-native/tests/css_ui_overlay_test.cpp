// The `native-css` UI backend, end to end through the host's own seam.
//
// `ui.renderer: "native-css"` is the backend with no browser in it: the game's `src/ui/` is laid
// out by blitz-dom, rasterised on the CPU and handed to the compositor as premultiplied RGBA8.
// This proves the facts that a screenshot cannot: that the frames arriving through
// `uiOverlayFrame()` really came from the CPU rasteriser (premultiplied RGBA, a counter that moves
// only on a repaint), that a click inside a published element becomes exactly one message in the
// game's own queue — the same queue `__tnUiGameReceive` drains — and that a batch the document
// rejects is refused rather than half-applied, without opening the CLI's ready gate on the empty
// document that was painted before the game posted anything.
//
// It drives the public functions only, needs no window and no display, and asserts nothing about
// how the document looks: this is a bridge contract, not a pixel baseline.
//
// A build without `TN_ENABLE_CSS_UI` is asserted too, and the assertion is not "it did nothing":
// `attachDesktopCssUi` must refuse, say why, and leave the host reporting no overlay — which is the
// difference between an absent backend and a silently broken HUD.

#include "mystral/platform/ui_overlay.h"

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <thread>

namespace {

int failures = 0;

void check(bool condition, const char* what) {
    if (condition) return;
    std::fprintf(stderr, "FAIL: %s\n", what);
    failures += 1;
}

/**
 * A fixed HUD: one section in the bottom-left corner holding one button, with a click listener.
 *
 * `position: fixed` plus explicit offsets because a hit test needs a box whose position is known
 * without measuring pixels — the points below are derived from the frame the host reports back, so
 * this holds at whatever size the document was attached at.
 */
constexpr const char* kHudBatch = R"({"ops":[
  {"op":"sheet","key":"hud","css":"section{position:fixed;left:24px;bottom:24px;width:80px;height:40px;background:#2563eb}button{display:block;width:80px;height:40px;background:#27272a}"},
  {"op":"create","id":1,"tag":"section"},
  {"op":"create","id":2,"tag":"button"},
  {"op":"append","parent":0,"child":1},
  {"op":"append","parent":1,"child":2},
  {"op":"listen","id":2,"event":"click"}
]})";

#if TN_ENABLE_CSS_UI

/**
 * The keyboard, the wheel and the clock: the three seams a player drives a HUD with that a
 * screenshot cannot show.
 *
 * Every expectation here is the same contract the crate's own tests and the Chromium corpus state,
 * asked of the host's public functions: a Tab that moved focus belongs to the UI and does not reach
 * the game, a wheel a scroller took does not also zoom, a transition runs against a clock the host
 * feeds, and a document with nothing focusable takes no key at all.
 */
constexpr const char* kInputBatch = R"({"ops":[
  {"op":"sheet","key":"input","css":"html,body{margin:0;padding:0}body{background:transparent}.a{position:fixed;left:200px;bottom:24px;width:80px;height:40px;background:#27272a}.b{position:fixed;left:300px;bottom:24px;width:80px;height:40px;background:#27272a}button:focus-visible{background:#f59e0b}.box{position:fixed;left:24px;top:20px;width:100px;height:60px;overflow:auto;background:#111111}.pad{height:400px}.h{position:fixed;left:150px;top:20px;width:60px;height:40px;background:#0000ff}@media (hover:hover){.h:hover{background:#ff0000}}.e{position:fixed;left:230px;top:20px;width:60px;height:40px;background:#00ff00}@media (prefers-color-scheme: dark){.e{background:#ff00ff}}.t{position:fixed;left:310px;top:20px;width:60px;height:40px;background:#0000ff;transition:background-color 200ms linear}.t:hover{background:#ff0000}"},
  {"op":"create","id":11,"tag":"button"},
  {"op":"attr","id":11,"name":"class","value":"a"},
  {"op":"append","parent":0,"child":11},
  {"op":"listen","id":11,"event":"click"},
  {"op":"create","id":12,"tag":"button"},
  {"op":"attr","id":12,"name":"class","value":"b"},
  {"op":"append","parent":0,"child":12},
  {"op":"listen","id":12,"event":"click"},
  {"op":"create","id":13,"tag":"div"},
  {"op":"attr","id":13,"name":"class","value":"box"},
  {"op":"create","id":14,"tag":"div"},
  {"op":"attr","id":14,"name":"class","value":"pad"},
  {"op":"append","parent":13,"child":14},
  {"op":"append","parent":0,"child":13},
  {"op":"create","id":15,"tag":"div"},
  {"op":"attr","id":15,"name":"class","value":"h"},
  {"op":"append","parent":0,"child":15},
  {"op":"create","id":16,"tag":"div"},
  {"op":"attr","id":16,"name":"class","value":"e"},
  {"op":"append","parent":0,"child":16},
  {"op":"create","id":17,"tag":"div"},
  {"op":"attr","id":17,"name":"class","value":"t"},
  {"op":"append","parent":0,"child":17}
]})";

/**
 * The environment seam, called the way `attachDesktopCssUi` calls it: from the OS setting, once.
 *
 * Declared rather than routed through the header because what is under test first is that the entry
 * point the attach calls reaches the document, so the call is made here directly. The playtest's own
 * override, `uiOverlaySetEnvironment`, is asserted after it.
 */
extern "C" int tn_css_ui_set_env(int dark, int reduced_motion);

/** Straight sRGB at one pixel of the newest frame, which is premultiplied RGBA8 and opaque here. */
void pixel(const mystral::platform::UiOverlayFrame& frame, uint32_t x, uint32_t y, uint8_t* out) {
    const size_t offset = (y * frame.width + x) * 4;
    out[0] = frame.pixels[offset];
    out[1] = frame.pixels[offset + 1];
    out[2] = frame.pixels[offset + 2];
}

void checkColour(const mystral::platform::UiOverlayFrame& frame, uint32_t x, uint32_t y,
                 const uint8_t (&want)[3], const char* what) {
    uint8_t got[3] = {0, 0, 0};
    pixel(frame, x, y, got);
    // An 8-per-channel tolerance: the rasteriser blends in premultiplied space, so a round trip
    // through the compositor's own maths is not bit-exact and a strict equality would be a flake.
    const bool near = std::abs(static_cast<int>(got[0]) - want[0]) <= 8 &&
                      std::abs(static_cast<int>(got[1]) - want[1]) <= 8 &&
                      std::abs(static_cast<int>(got[2]) - want[2]) <= 8;
    if (!near) {
        std::fprintf(stderr, "FAIL: %s (got %u,%u,%u want %u,%u,%u)\n", what, got[0], got[1], got[2],
                     want[0], want[1], want[2]);
        failures += 1;
    }
}

/** The centre of the fixture's button, normalized to the viewport the host reported. */
void buttonPoint(const mystral::platform::UiOverlayFrame& frame, float& nx, float& ny) {
    nx = 64.0f / static_cast<float>(frame.width);
    ny = static_cast<float>(frame.height - 44) / static_cast<float>(frame.height);
}

/**
 * Focus traversal, activation, and the keys that stay with the game.
 *
 * One document, one traversal, and every answer read back from the host's own seam rather than from
 * the crate: the host is what decides to drop a key, and this is that decision under test.
 */
void keyboardContract() {
    std::string event;
    // A click focuses the control it landed on, so the UI already holds the keyboard before any key
    // was pressed — and the traversal below needs two stops of its own, not the pointer section's.
    check(mystral::platform::uiOverlayKeyboardCaptured(),
          "the click focused the control it landed on, so the UI holds the keyboard");
    check(mystral::platform::postUiMessage(R"({"ops":[{"op":"remove","id":2}]})"),
          "the pointer fixture's control can be removed");
    check(!mystral::platform::uiOverlayKeyboardCaptured(), "and removing it released that focus");
    check(!mystral::platform::uiOverlayRouteKey("Tab", false, false),
          "a Tab release moves nothing, so it is the game's");
    check(!mystral::platform::uiOverlayRouteKey("a", true, false),
          "a key the document has no use for is the game's");
    check(mystral::platform::uiOverlayRouteKey("Tab", true, false), "Tab is the UI's");
    check(mystral::platform::uiOverlayKeyboardCaptured(), "and the UI now holds the keyboard");
    check(mystral::platform::uiOverlayRouteKey("Tab", true, false), "Tab moves on");
    check(mystral::platform::uiOverlayRouteKey("Tab", true, true), "and Shift+Tab moves back");

    // Enter fires the click on the press, so the game sees an activation exactly once.
    check(mystral::platform::uiOverlayRouteKey("Enter", true, false), "Enter is the button's");
    mystral::platform::pumpUiOverlay();
    check(mystral::platform::takeUiMessage(event), "the activation reached the game's own queue");
    check(event == R"({"type":"click","id":11})", "naming the focused button");

    // The space key is the other half of the same rule: the press is consumed, the release clicks.
    check(mystral::platform::uiOverlayRouteKey(" ", true, false), "the space key press is consumed");
    check(!mystral::platform::takeUiMessage(event), "and it activates nothing yet");
    check(mystral::platform::uiOverlayRouteKey(" ", false, false), "the release activates");
    mystral::platform::pumpUiOverlay();
    check(mystral::platform::takeUiMessage(event), "the space key reached the queue");
    check(event == R"({"type":"click","id":11})", "as one click, not two");

    // Traversal is what put that focus there: from outside, two Tabs and an Enter land on the other
    // control, which is the fact a screenshot cannot show.
    mystral::platform::uiOverlayRouteKey("Escape", true, false);
    check(!mystral::platform::uiOverlayKeyboardCaptured(), "Escape drops the UI's focus");
    check(!mystral::platform::uiOverlayRouteKey("Escape", false, false),
          "and its release is the game's");
    check(mystral::platform::uiOverlayRouteKey("Tab", true, false), "Tab again");
    check(mystral::platform::uiOverlayRouteKey("Tab", true, false), "and again");
    check(mystral::platform::uiOverlayRouteKey("Enter", true, false), "Enter on the second button");
    mystral::platform::pumpUiOverlay();
    check(mystral::platform::takeUiMessage(event), "the second activation reached the queue");
    check(event == R"({"type":"click","id":12})", "naming the control Tab moved to");

    // With nothing focusable left, the document must be out of the keyboard's way entirely: a game
    // whose UI has no controls keeps every key it owns.
    check(mystral::platform::postUiMessage(
              R"({"ops":[{"op":"remove","id":11},{"op":"remove","id":12}]})"),
          "the focusable controls can be removed");
    mystral::platform::uiOverlayRouteKey("Escape", true, false);
    check(!mystral::platform::uiOverlayKeyboardCaptured(), "and the UI holds no key once they are gone");
    check(!mystral::platform::uiOverlayRouteKey("Tab", true, false),
          "a document with nothing to focus consumes no Tab");
    check(!mystral::platform::uiOverlayRouteKey("Tab", true, true), "nor Shift+Tab");
    check(!mystral::platform::uiOverlayRouteKey("Enter", true, false), "and no Enter");
    check(!mystral::platform::uiOverlayRouteKey(" ", false, false), "and no space key");
    check(!mystral::platform::uiOverlayRouteKey("Escape", true, false), "and no Escape");
}

/**
 * The wheel, the clock and the environment.
 *
 * A wheel a scroller took must not also reach the game, a transition must move while its clock runs
 * and stop when it does not, and the pointer kind and colour scheme must reach the stylesheet. Those
 * are the four facts a frame counter and a pixel decode can answer on their own.
 */
void wheelClockAndEnvironmentContract(const mystral::platform::UiOverlayFrame& sized) {
    const float width = static_cast<float>(sized.width);
    const float height = static_cast<float>(sized.height);
    // `.box` is 100x60 at (24,20); `.h`, `.e` and `.t` are 60x40 across the top row.
    const float boxX = 74.0f / width;
    const float boxY = 50.0f / height;
    const float emptyX = 440.0f / width;
    const float emptyY = 300.0f / height;

    check(mystral::platform::uiOverlayRouteWheel(boxX, boxY, 0.0f, 120.0f),
          "a scroller under the wheel took the delta");
    check(mystral::platform::uiOverlayRouteWheel(boxX, boxY, 0.0f, 120.0f), "and the next tick too");
    check(!mystral::platform::uiOverlayRouteWheel(emptyX, emptyY, 0.0f, 120.0f),
          "over the empty page the wheel belongs to the game");
    check(!mystral::platform::uiOverlayRouteWheel(boxX, boxY, 0.0f, 0.0f), "a zero delta is nothing");

    // The pointer kind: a finger does not hover, so a rule inside `(hover:hover)` stops applying.
    const uint8_t blue[3] = {0, 0, 255};
    const uint8_t red[3] = {255, 0, 0};
    mystral::platform::uiOverlayRoutePointer("pointermove", 180.0f / width, 40.0f / height, 0, 1);
    mystral::platform::UiOverlayFrame hovered = {};
    check(mystral::platform::uiOverlayFrame(hovered), "the hover painted");
    checkColour(hovered, 180, 40, red, "a mouse matches (hover: hover)");
    mystral::platform::uiOverlaySetPointerKind(true);
    mystral::platform::uiOverlayRoutePointer("pointermove", 180.0f / width, 40.0f / height, 0, 1);
    mystral::platform::UiOverlayFrame tapped = {};
    check(mystral::platform::uiOverlayFrame(tapped), "the finger painted");
    checkColour(tapped, 180, 40, blue, "a finger does not hover");
    mystral::platform::uiOverlaySetPointerKind(false);

    // The clock the host feeds: a running transition repaints on its own, and stops when it ends.
    mystral::platform::uiOverlayRoutePointer("pointermove", 340.0f / width, 40.0f / height, 0, 1);
    mystral::platform::UiOverlayFrame hovering = {};
    check(mystral::platform::uiOverlayFrame(hovering), "the hover on the transition box painted");
    const uint64_t started = hovering.counter;
    mystral::platform::pumpUiOverlay();
    mystral::platform::UiOverlayFrame moving = {};
    check(mystral::platform::uiOverlayFrame(moving), "the document still has a frame");
    check(moving.counter > started, "a running transition advances the counter with the clock");
    // 200ms of transition, then long enough for the rasteriser to have been handed every frame of it.
    std::this_thread::sleep_for(std::chrono::milliseconds(320));
    mystral::platform::pumpUiOverlay();
    mystral::platform::pumpUiOverlay();
    mystral::platform::UiOverlayFrame settled = {};
    check(mystral::platform::uiOverlayFrame(settled), "the transition's last frame exists");
    const uint8_t arrived[3] = {255, 0, 0};
    checkColour(settled, 340, 40, arrived, "and it arrived where the clock said it would");
    mystral::platform::pumpUiOverlay();
    mystral::platform::UiOverlayFrame idle = {};
    check(mystral::platform::uiOverlayFrame(idle), "an idle document still has its frame");
    check(idle.counter == settled.counter, "an idle document stops repainting");

    // The colour scheme: `.e` is green in light and magenta in dark, from the host's OS setting.
    const uint8_t green[3] = {0, 255, 0};
    const uint8_t magenta[3] = {255, 0, 255};
    checkColour(idle, 260, 40, green, "the document is styled for a light environment");
    check(tn_css_ui_set_env(1, 0) == 0, "the environment seam the host calls at attach");
    mystral::platform::UiOverlayFrame dark = {};
    check(mystral::platform::uiOverlayFrame(dark), "the restyled document still has a frame");
    checkColour(dark, 260, 40, magenta, "prefers-color-scheme: dark follows the environment");
    check(tn_css_ui_set_env(0, 0) == 0, "and back again");

    // The playtest's override of that environment: one setting at a time, the other kept.
    check(mystral::platform::uiOverlaySetEnvironment(1, -1), "the environment override is accepted");
    mystral::platform::UiOverlayFrame overridden = {};
    check(mystral::platform::uiOverlayFrame(overridden), "the overridden document has a frame");
    checkColour(overridden, 260, 40, magenta, "the override reaches prefers-color-scheme");
    check(mystral::platform::uiOverlaySetEnvironment(-1, 1), "reduced motion alone is accepted");
    mystral::platform::UiOverlayFrame kept = {};
    check(mystral::platform::uiOverlayFrame(kept), "and the document still has a frame");
    checkColour(kept, 260, 40, magenta, "and -1 keeps the colour scheme it did not name");
    check(mystral::platform::uiOverlaySetEnvironment(0, 0), "and back to the default environment");
    mystral::platform::UiOverlayFrame light = {};
    check(mystral::platform::uiOverlayFrame(light), "the light document has a frame");
    checkColour(light, 260, 40, green, "clearing the override restores the light styling");
    check(!mystral::platform::uiOverlayAdvanceClock(10),
          "the real-time clock is the default, and a tick count does not move it");
}

void setEnvironment(const char* name, const char* value) {
#if defined(_WIN32)
    _putenv_s(name, value == nullptr ? "" : value);
#else
    if (value == nullptr) unsetenv(name);
    else setenv(name, value, 1);
#endif
}

/**
 * The opt-in fixed clock: with `TN_CSS_UI_FIXED_STEP_MS` the transition moves by ticks and by nothing
 * else, so a mid-transition pixel is the same on every run; a malformed step refuses the backend.
 */
void fixedClockContract() {
    setEnvironment("TN_CSS_UI_FIXED_STEP_MS", "ten");
    check(!mystral::platform::attachDesktopCssUi("/nonexistent-css-ui-root"),
          "a malformed fixed clock step refuses the backend");
    check(!mystral::platform::uiOverlayAttached(), "and leaves no overlay attached");
    setEnvironment("TN_CSS_UI_FIXED_STEP_MS", "10");
    check(mystral::platform::attachDesktopCssUi("/nonexistent-css-ui-root"),
          "a fixed clock step attaches the backend");
    check(mystral::platform::postUiMessage(kInputBatch), "the input fixture reaches the fixed-clock document");
    mystral::platform::UiOverlayFrame sized = {};
    check(mystral::platform::uiOverlayFrame(sized), "and painted");
    const float width = static_cast<float>(sized.width);
    const float height = static_cast<float>(sized.height);
    mystral::platform::uiOverlayRoutePointer("pointermove", 340.0f / width, 40.0f / height, 0, 1);
    mystral::platform::pumpUiOverlay();
    mystral::platform::UiOverlayFrame start = {};
    check(mystral::platform::uiOverlayFrame(start), "the hover on the transition box painted");
    check(mystral::platform::uiOverlayAdvanceClock(10), "ten ticks advance the fixed clock");
    mystral::platform::pumpUiOverlay();
    mystral::platform::UiOverlayFrame half = {};
    check(mystral::platform::uiOverlayFrame(half), "the mid-transition frame exists");
    const uint8_t midway[3] = {128, 0, 128};
    checkColour(half, 340, 40, midway, "100ms of a 200ms transition is exactly half way");
    std::this_thread::sleep_for(std::chrono::milliseconds(250));
    mystral::platform::pumpUiOverlay();
    mystral::platform::pumpUiOverlay();
    mystral::platform::UiOverlayFrame waited = {};
    check(mystral::platform::uiOverlayFrame(waited), "the frame after a wall-clock wait exists");
    checkColour(waited, 340, 40, midway, "wall-clock time does not move the fixed clock");
    check(mystral::platform::uiOverlayAdvanceClock(10), "ten more ticks");
    mystral::platform::pumpUiOverlay();
    mystral::platform::UiOverlayFrame done = {};
    check(mystral::platform::uiOverlayFrame(done), "the settled frame exists");
    const uint8_t red[3] = {255, 0, 0};
    checkColour(done, 340, 40, red, "and the transition ends on the tick its duration names");
    mystral::platform::detachDesktopUiOverlay();
    setEnvironment("TN_CSS_UI_FIXED_STEP_MS", nullptr);
}

/** The held-modifier tracker the playtest keyboard uses to turn `["Shift","Tab"]` into Shift+Tab. */
void modifierContract() {
    mystral::platform::UiKeyModifiers mods;
    check(mystral::platform::uiOverlayTrackModifier("Shift", true, mods) && mods.shift,
          "Shift down is held");
    check(!mystral::platform::uiOverlayTrackModifier("Tab", true, mods) && mods.shift,
          "Tab is not a modifier and leaves Shift held");
    check(mystral::platform::uiOverlayTrackModifier("Control", true, mods) && mods.ctrl, "Control");
    check(mystral::platform::uiOverlayTrackModifier("Alt", true, mods) && mods.alt, "Alt");
    check(mystral::platform::uiOverlayTrackModifier("Meta", true, mods) && mods.meta, "Meta");
    check(mystral::platform::uiOverlayTrackModifier("Shift", false, mods) && !mods.shift,
          "Shift up releases it");
    check(!mystral::platform::uiOverlayTrackModifier("ShiftLeft", true, mods) && !mods.shift,
          "only the DOM key name counts");
}

int runCssBackend() {
    setEnvironment("TN_CSS_UI_FIXED_STEP_MS", nullptr);
    modifierContract();
    check(!mystral::platform::uiOverlaySetEnvironment(1, 0),
          "no environment override reaches a document that is not attached");
    check(mystral::platform::attachDesktopCssUi("/nonexistent-css-ui-root"),
          "attachDesktopCssUi returns false only when the document could not be created");
    check(mystral::platform::uiOverlayAttached(), "the CSS backend reports itself attached");

    // Readiness is not "a frame exists". The empty document paints one too, before the game has
    // posted anything, and a HUD whose every batch was rejected is exactly that — so counting the
    // first paint as ready is what kept such a game looking alive while showing nothing.
    mystral::platform::UiOverlayFrame empty = {};
    check(mystral::platform::uiOverlayFrame(empty),
          "the document paints before the game has posted anything");
    check(empty.counter > 0, "the first paint counts as a published frame");
    check(mystral::platform::uiOverlayFramesPublished() >= 1,
          "the published-frame count moves on the first paint");
    check(!mystral::platform::uiReadyIntentReceived(), "an empty first paint is not readiness");

    // Fail closed, and say so: a batch naming an op that does not exist, and one naming a tag this
    // HUD does not model, are both refused whole — no op applied, `false` returned, no crash, and
    // the document left as it was.
    check(!mystral::platform::postUiMessage(R"({"ops":[{"op":"teleport","id":1}]})"),
          "a malformed batch is refused");
    check(!mystral::platform::postUiMessage(R"({"ops":[{"op":"create","id":1,"tag":"marquee"}]})"),
          "a batch naming an unsupported tag is refused");
    check(mystral::platform::uiOverlayFrame(empty),
          "a refused batch leaves a document the host can still read");
    check(empty.counter == 1, "a refused batch applies none of its ops");
    check(!mystral::platform::uiReadyIntentReceived(), "a refused batch is not a HUD");

    // The game publishes its own state over the same bridge. The engine accepts and ignores it, and
    // it is not the HUD: readiness must not arm on it.
    check(mystral::platform::postUiMessage(R"({"type":"tn:state","state":{"frames":1}})"),
          "a frame of another type is accepted and ignored");
    check(!mystral::platform::uiReadyIntentReceived(), "a state frame is not a HUD");

    check(mystral::platform::postUiMessage(kHudBatch), "a mutation batch reaches the document");

    mystral::platform::UiOverlayFrame frame = {};
    check(mystral::platform::uiOverlayFrame(frame), "the document paints without a web view");
    check(frame.pixels != nullptr && frame.length > 0, "the painted frame carries pixels");
    check(frame.width > 0 && frame.height > 0 && frame.stride > 0, "the frame is sized");
    check(frame.stride == frame.width * 4, "the rasteriser's own stride is four bytes a pixel");
    check(frame.length >= static_cast<size_t>(frame.stride) * frame.height,
          "the frame holds every row it claims");
    check(frame.isRgba, "vello_cpu hands back premultiplied RGBA, so the upload format must say so");
    const uint64_t firstCounter = frame.counter;
    check(firstCounter > empty.counter, "the accepted batch repainted the document");
    check(mystral::platform::uiReadyIntentReceived(),
          "the first repaint after an accepted post is the HUD being on screen");

    // An unchanged document repaints nothing, which is what lets the composite skip the upload.
    mystral::platform::UiOverlayFrame unchanged = {};
    check(mystral::platform::uiOverlayFrame(unchanged), "an unchanged document still has a frame");
    check(unchanged.counter == firstCounter, "an unchanged document does not advance the counter");

    // The resize seam: the window's size is the document's viewport.
    mystral::platform::uiOverlaySetSize(480, 320);
    mystral::platform::UiOverlayFrame resized = {};
    check(mystral::platform::uiOverlayFrame(resized), "a resized document repaints");
    check(resized.width == 480 && resized.height == 320, "the document followed the surface");
    check(resized.counter > firstCounter, "a resize is a new frame");

    float buttonX = 0.0f;
    float buttonY = 0.0f;
    buttonPoint(resized, buttonX, buttonY);
    const float emptyX = 400.0f / 480.0f;
    const float emptyY = 20.0f / 320.0f;
    check(mystral::platform::uiOverlayHitTest(buttonX, buttonY),
          "a listener inside the HUD claims the pointer");
    check(!mystral::platform::uiOverlayHitTest(emptyX, emptyY),
          "the empty background belongs to the game");
    check(!mystral::platform::uiOverlayKeyboardCaptured(),
          "a document with nothing focused holds no key");

    // Hover, press and release over the button, then the one message they owe the game.
    check(mystral::platform::uiOverlayRoutePointer("pointermove", buttonX, buttonY, 0, 1),
          "hovering the button is the UI's");
    check(mystral::platform::uiOverlayRoutePointer("pointerdown", buttonX, buttonY, 1, 1),
          "the press belongs to the UI");
    check(mystral::platform::uiOverlayRoutePointer("pointerup", buttonX, buttonY, 0, 1),
          "the release belongs to the UI");
    mystral::platform::pumpUiOverlay();
    std::string event;
    check(mystral::platform::takeUiMessage(event), "the click reached the game's message queue");
    check(event == R"({"type":"click","id":2})",
          "exactly one click, naming the button that was pressed");

    // A press on the empty background is the game's, and the latch that a drag relies on resets.
    check(!mystral::platform::uiOverlayRoutePointer("pointerdown", emptyX, emptyY, 1, 1),
          "a press outside the HUD is the game's");
    check(!mystral::platform::uiOverlayRoutePointer("pointerup", emptyX, emptyY, 0, 1),
          "and so is its release");
    check(!mystral::platform::takeUiMessage(event), "and it produced no UI message");

    // A second document's worth of controls, for the keyboard, the wheel and the clock.
    check(mystral::platform::postUiMessage(kInputBatch), "the input fixture reaches the document");
    mystral::platform::UiOverlayFrame inputs = {};
    check(mystral::platform::uiOverlayFrame(inputs), "and painted");
    keyboardContract();
    wheelClockAndEnvironmentContract(inputs);

    mystral::platform::detachDesktopUiOverlay();
    check(!mystral::platform::uiOverlayAttached(), "detach reports the overlay gone");
    check(!mystral::platform::postUiMessage(kHudBatch),
          "a detached backend posts to nothing rather than to a dead document");
    check(!mystral::platform::uiOverlayRouteKey("Tab", true, false),
          "and routes no key either");
    check(!mystral::platform::uiOverlayRouteWheel(0.5f, 0.5f, 0.0f, 120.0f), "and no wheel");
    check(!mystral::platform::uiOverlayKeyboardCaptured(), "and holds no key");

    fixedClockContract();
    return failures;
}

#else  // TN_ENABLE_CSS_UI

int runCssBackend() {
    // The option is off. The contract here is the refusal: a game that asked for this renderer must
    // be told, and the host must not start reporting an overlay it does not have.
    check(!mystral::platform::attachDesktopCssUi("ui"),
          "a build without the backend refuses the renderer");
    check(!mystral::platform::uiOverlayAttached(), "and reports no overlay afterwards");
    check(!mystral::platform::postUiMessage("{\"ops\":[]}"), "and posts to nothing");
    mystral::platform::UiOverlayFrame frame = {};
    check(!mystral::platform::uiOverlayFrame(frame), "and has no frame to composite");
    check(!mystral::platform::uiOverlayHitTest(0.5f, 0.5f), "and never claims a pointer");
    // The input seams are no-ops without the backend, not stubs that answer a question.
    check(!mystral::platform::uiOverlayRouteKey("Tab", true, false), "and routes no key");
    check(!mystral::platform::uiOverlayRouteWheel(0.5f, 0.5f, 0.0f, 120.0f), "and no wheel");
    check(!mystral::platform::uiOverlayKeyboardCaptured(), "and holds no key");
    mystral::platform::uiOverlaySetPointerKind(true);
    check(!mystral::platform::uiOverlayKeyboardCaptured(),
          "declaring a pointer kind does not invent an overlay");
    check(!mystral::platform::uiOverlaySetEnvironment(1, 1), "and no environment override lands");
    check(!mystral::platform::uiOverlayAdvanceClock(10), "and no clock moves");
    mystral::platform::UiKeyModifiers mods;
    check(mystral::platform::uiOverlayTrackModifier("Shift", true, mods) && mods.shift,
          "the modifier tracker needs no backend");
    return failures;
}

#endif

}  // namespace

int main() {
    failures = runCssBackend();
    if (failures != 0) {
        std::fprintf(stderr, "native-css overlay contract: %d assertion(s) failed\n", failures);
        return 1;
    }
    std::printf("native-css overlay contract passed: TN_ENABLE_CSS_UI=%d\n",
#if TN_ENABLE_CSS_UI
                1
#else
                0
#endif
    );
    return 0;
}