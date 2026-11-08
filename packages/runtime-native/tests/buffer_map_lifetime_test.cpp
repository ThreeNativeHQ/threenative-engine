// A screenshot readback waits on an asynchronous buffer map for a fixed time, gives up, cancels the
// map and returns. The cancelled map's callback still runs afterwards. This proves the shared map
// state outlives the waiter until that late callback has run, and not longer.

#include "mystral/webgpu/buffer_map_state.h"

#include <iostream>

using namespace mystral::webgpu;

static int failures = 0;
static void expect(bool ok, const char* what) {
    if (ok) return;
    std::cerr << "FAIL: " << what << "\n";
    failures++;
}

int main() {
    // The ordinary order: the callback runs while the waiter still holds its share.
    {
        auto data = std::make_shared<BufferMapData>();
        void* userdata = makeBufferMapUserdata(data);
        expect(data.use_count() == 2, "the map call holds its own share");
        completeBufferMap(userdata, WGPUBufferMapAsyncStatus_Compat{});
        expect(data->completed, "the callback marks the map complete");
        expect(data.use_count() == 1, "the callback releases its share");
    }

    // The timeout order: the waiter returns (drops its share) before the cancelled map's callback.
    {
        auto data = std::make_shared<BufferMapData>();
        std::weak_ptr<BufferMapData> alive = data;
        void* userdata = makeBufferMapUserdata(data);
        data.reset();  // the waiter's frame is gone
        expect(!alive.expired(), "the state outlives the waiter until the late callback runs");
        completeBufferMap(userdata, WGPUBufferMapAsyncStatus_Compat{});  // must not touch freed state
        expect(alive.expired(), "the late callback releases the last share");
    }

    // A callback with no userdata is a no-op, not a crash.
    completeBufferMap(nullptr, WGPUBufferMapAsyncStatus_Compat{});

    if (failures > 0) return 1;
    std::cout << "native buffer map lifetime contract passed\n";
    return 0;
}
