#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <vector>

#include <webgpu/webgpu.h>

#include "engine/foundation/handles.h"

namespace tn::engine {

/**
 * WebGPU callbacks fire during a non-blocking poll; their results land here and run only when the
 * engine drains the queue at a frame boundary (PRD-509, §12). Nothing in the engine waits on the
 * device, so the same code runs on browser WebGPU.
 */
class EventQueue {
public:
    void post(std::function<void()> event) { events_.push_back(std::move(event)); }
    /** Runs the events posted so far; events they post wait for the next drain. */
    size_t drain();
    size_t pending() const { return events_.size(); }

private:
    std::vector<std::function<void()>> events_;
};

enum class GpuStatus : uint8_t {
    Ok,
    InvalidHandle,
    StaleGeneration,  // TN_GPU_STALE_GENERATION: the handle belongs to a lost device
    WrongType,
    OutOfRange,
    DeviceError,
};

using ReadbackCallback = std::function<void(GpuStatus, std::vector<uint8_t>)>;

/**
 * Native-owned GPU buffers and textures keyed by generational handles (PRD-509). The handle's
 * context is the device generation, so a handle from a lost device is refused, never reused.
 */
class GpuResources {
public:
    static constexpr uint16_t kBuffer = 1;
    static constexpr uint16_t kTexture = 2;

    GpuResources(WGPUInstance instance, WGPUDevice device, WGPUQueue queue, EventQueue& events,
                 uint16_t deviceGeneration);
    ~GpuResources();
    GpuResources(const GpuResources&) = delete;
    GpuResources& operator=(const GpuResources&) = delete;

    Handle createBuffer(uint64_t size, WGPUBufferUsage usage);
    /** A buffer holding `bytes` of `data` from creation (mapped at creation, as three's backend does). */
    Handle createBuffer(uint64_t size, WGPUBufferUsage usage, const void* data, uint64_t bytes);
    /** RGBA8-sized formats only for now; mip 0, one layer. */
    Handle createTexture(uint32_t width, uint32_t height, WGPUTextureFormat format, WGPUTextureUsage usage);

    /** The queue copies the bytes before returning, so the caller's memory is free at once. */
    GpuStatus writeBuffer(Handle buffer, uint64_t offset, const void* data, uint64_t size);
    /** Bytes sent through queue writes so far; the geometry cache test bounds it. */
    uint64_t queueWriteBytes() const { return queueWriteBytes_; }
    GpuStatus writeTexture(Handle texture, const void* pixels, uint64_t size);

    /** Completes on a later drain of the event queue, never inside this call. */
    GpuStatus readBuffer(Handle buffer, uint64_t offset, uint64_t size, ReadbackCallback done);
    GpuStatus readTexture(Handle texture, ReadbackCallback done);

    /** The handle dies now; the GPU object lives until every submission so far has completed. */
    GpuStatus destroy(Handle resource);
    /** One serial with `other`, a table on the same queue: a destroy here waits for its submissions too. */
    void shareSubmissions(const GpuResources& other) { shared_ = other.shared_; }

    WGPUBuffer buffer(Handle handle) const;
    WGPUTexture texture(Handle handle) const;

    /** The only path to the queue, so every submission has a serial a destroy can wait for. */
    uint64_t submit(WGPUCommandBuffer commands);
    /** Non-blocking: lets the backend deliver finished callbacks into the event queue. */
    void poll();

    uint64_t submittedSerial() const { return shared_->submitted; }
    uint64_t completedSerial() const { return shared_->completed; }
    size_t pendingDestroyCount() const { return shared_->pending.size(); }
    uint32_t liveCount() const { return handles_.liveCount(); }

    GpuStatus status(Handle handle, uint16_t type) const;

private:
    struct Record {
        WGPUBuffer buffer = nullptr;
        WGPUTexture texture = nullptr;
        uint64_t size = 0;
        uint32_t width = 0;
        uint32_t height = 0;
        uint32_t bytesPerPixel = 4;  // RGBA8 by default; RGBA32Float is 16
    };
    struct PendingDestroy {
        uint64_t afterSerial;
        Record record;
    };
    // Outlived by nothing that captures it: callbacks hold a weak reference, so a callback that
    // arrives after this object is gone finds it expired and does nothing.
    struct Shared {
        uint64_t submitted = 0;
        uint64_t completed = 0;
        std::vector<PendingDestroy> pending;
        void collect();
    };

    static void release(Record& record);
    Record* record(Handle handle, uint16_t type, GpuStatus& status);
    void readInto(WGPUCommandEncoder encoder, WGPUBuffer staging, uint64_t size,
                  std::function<void(const uint8_t*)> unpack, ReadbackCallback done);

    WGPUInstance instance_;
    WGPUDevice device_;
    WGPUQueue queue_;
    EventQueue& events_;
    HandleTable handles_;
    std::vector<Record> records_;
    std::shared_ptr<Shared> shared_ = std::make_shared<Shared>();
    uint64_t queueWriteBytes_ = 0;
};

}  // namespace tn::engine
