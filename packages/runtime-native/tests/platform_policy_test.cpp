// Pure platform decisions that otherwise only run on a device: what a resize event asks of the
// runtime, and which font manager each platform builds. The Android build also static_asserts the
// font mapping (font_backend.h), so a swap fails build-android without a device.
//
//   ninja -C build/tn-linux threenative-platform-policy-test && ./build/tn-linux/threenative-platform-policy-test

#include "mystral/canvas/font_backend.h"
#include "mystral/platform/resize_plan.h"

#include <iostream>

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

    if (failures) return 1;
    std::cout << "native platform policy contract passed\n";
    return 0;
}
