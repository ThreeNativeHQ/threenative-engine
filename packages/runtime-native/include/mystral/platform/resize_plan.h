#pragma once

namespace mystral::platform {

// What a window resize event asks of the runtime. Kept pure so a desktop test pins the decision
// that otherwise runs only on an Android launch.
struct ResizePlan {
    int width;
    int height;
    bool syncPlatformWindow;  // touch coordinates scale with the platform size, so it tracks the canvas
    bool reconfigureSurface;  // false: reconfiguring from inside the resize callback tears the surface
                              // down under the frame in flight (SIGABRT on a Pixel 8 after the first
                              // frame). A correct version defers it to a frame boundary.
};

constexpr ResizePlan planResizeEvent(int width, int height) {
    return {width, height, true, false};
}

}  // namespace mystral::platform
