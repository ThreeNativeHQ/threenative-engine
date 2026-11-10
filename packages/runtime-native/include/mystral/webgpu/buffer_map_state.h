#pragma once

#include "webgpu/webgpu.h"
#if defined(MYSTRAL_WEBGPU_WGPU)
#if __has_include("webgpu/wgpu.h")
#include "webgpu/wgpu.h"
#else
#include "wgpu/wgpu.h"
#endif
#endif
#include "mystral/webgpu_compat.h"

#include <condition_variable>
#include <cstdint>
#include <memory>
#include <mutex>

namespace mystral::webgpu {

// The state one asynchronous buffer map shares between the thread that waits for it and the
// callback that completes it. The callback owns a share through its userdata, so a callback that
// runs after the waiter timed out and returned (a cancelled map completes late) never touches a
// stack frame that is gone.
struct BufferMapData {
    // Extra padding added due to observed stack corruption during initialization.
    bool completed = false;
    uint8_t _pad1[7] = {};
    WGPUBufferMapAsyncStatus_Compat status = WGPUBufferMapAsyncStatus_Unknown_Compat;
    uint8_t _pad2[12] = {};
    std::mutex waitMutex;
    std::condition_variable waitCondition;
};

using BufferMapDataPtr = std::shared_ptr<BufferMapData>;

// The userdata handed to the map call: a heap share that the callback takes back and deletes.
inline void* makeBufferMapUserdata(const BufferMapDataPtr& data) { return new BufferMapDataPtr(data); }

inline BufferMapDataPtr takeBufferMapData(void* userdata) {
    auto* holder = static_cast<BufferMapDataPtr*>(userdata);
    if (holder == nullptr) return {};
    BufferMapDataPtr data = std::move(*holder);
    delete holder;
    return data;
}

// What both backends' map callbacks do: record the status, mark the map complete, wake the waiter.
inline void completeBufferMap(void* userdata, WGPUBufferMapAsyncStatus_Compat status) {
    const BufferMapDataPtr data = takeBufferMapData(userdata);
    if (!data) return;
    {
        std::lock_guard<std::mutex> lock(data->waitMutex);
        data->status = status;
        data->completed = true;
    }
    data->waitCondition.notify_all();
}

}  // namespace mystral::webgpu
