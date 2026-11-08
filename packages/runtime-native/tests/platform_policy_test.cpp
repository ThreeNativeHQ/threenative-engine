// Platform decisions that otherwise only run on a device: what a resize event asks of the runtime,
// which font manager each platform builds, and which UI frames stop at the host. The Android build also static_asserts the
// font mapping (font_backend.h), so a swap fails build-android without a device.
//
//   ninja -C build/tn-linux threenative-platform-policy-test && ./build/tn-linux/threenative-platform-policy-test

#include "mystral/canvas/font_backend.h"
#include "mystral/platform/resize_plan.h"
#include "mystral/platform/ui_overlay.h"

#include <iostream>
#include <string>
#include <vector>

using namespace mystral;

static int failures = 0;
#define CHECK(cond) do { if (!(cond)) { std::cerr << "FAIL " #cond " line " << __LINE__ << "\n"; ++failures; } } while (0)

int main() {
    const auto plan = platform::planResizeEvent(2400, 1080);
    CHECK(plan.width == 2400 && plan.height == 1080);
    CHECK(plan.syncPlatformWindow);
    CHECK(!plan.reconfigureSurface);

    using canvas::FontBackend;
    using canvas::FontPlatform;
    CHECK(canvas::fontBackendFor(FontPlatform::Android) == FontBackend::AndroidSystem);
    CHECK(canvas::fontBackendFor(FontPlatform::Linux) == FontBackend::FontConfig);
    CHECK(canvas::fontBackendFor(FontPlatform::Apple) == FontBackend::CoreText);
    CHECK(canvas::fontBackendFor(FontPlatform::Other) == FontBackend::Empty);

    // A page's hit regions stop at the host; every other frame reaches the game, in order. This is
    // the function runtime.cpp drains the overlay queue through.
    platform::queueUiMessage(R"({"type":"tn:hit-regions","regions":[{"x":0.1,"y":0.2,"width":0.3,"height":0.4}]})");
    platform::queueUiMessage(R"({"type":"intent","name":"slide"})");
    platform::queueUiMessage(R"({"type":"tn:hit-regions","regions":[{"x":1}]})");  // malformed: still the host's
    platform::queueUiMessage(R"({"type":"intent","name":"restart"})");
    std::vector<std::string> forwarded;
    const size_t count = platform::drainUiFramesToGame([&](const std::string& frame) { forwarded.push_back(frame); });
    CHECK(count == 2 && forwarded.size() == 2);
    CHECK(forwarded.size() == 2 && forwarded[0].find("slide") != std::string::npos);
    CHECK(forwarded.size() == 2 && forwarded[1].find("restart") != std::string::npos);
    for (const auto& frame : forwarded) CHECK(frame.find("tn:hit-regions") == std::string::npos);

    if (failures) return 1;
    std::cout << "native platform policy contract passed\n";
    return 0;
}
