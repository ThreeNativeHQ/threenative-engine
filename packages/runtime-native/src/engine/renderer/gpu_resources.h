#pragma once

#include <condition_variable>  // TN_WORKER_ONLY: GpuThread parks its worker and joins one frame
#include <cstdint>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <thread>
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
    /** Thread-safe: with a GPU thread, Dawn fires callbacks there and they post here. */
    void post(std::function<void()> event) {
        std::lock_guard lock(mutex_);
        events_.push_back(std::move(event));
    }
    /** Runs the events posted so far; events they post wait for the next drain. */
    size_t drain();
    size_t pending() const {
        std::lock_guard lock(mutex_);
        return events_.size();
    }

private:
    mutable std::mutex mutex_;
    std::vector<std::function<void()>> events_;
};

/**
 * One thread that runs queue work in the order it was posted (PRD-610 AC-9): submits, the present
 * and the device poll leave the game thread, as a browser's GPU process takes them from the page.
 * The game thread calls `wait()` before it touches the queue or the targets a posted job reads.
 */
class GpuThread {
public:
    GpuThread();
    ~GpuThread();
    GpuThread(const GpuThread&) = delete;
    GpuThread& operator=(const GpuThread&) = delete;

    void post(std::function<void()> job);
    /** Returns once every job posted so far has run. */
    void wait();
    /** Jobs run so far; a test reads it. */
    uint64_t ran() const;

private:
    mutable std::mutex mutex_;
    std::condition_variable work_;  // TN_WORKER_ONLY: parks the GPU thread between jobs
    std::condition_variable idle_;  // TN_WORKER_ONLY: GpuThread::wait, the one frame-pacing join
    std::deque<std::function<void()>> pending_;
    bool busy_ = false, stopping_ = false;
    uint64_t ran_ = 0;
    std::thread thread_;
};

enum class GpuStatus : uint8_t {
    Ok,
    InvalidHandle,
    StaleGeneration,  // TN_GPU_STALE_GENERATION: the handle belongs to a lost device
    WrongType,
    OutOfRange,
    DeviceError,
    Pending,  // the work cannot start yet (an environment still baking); retry on a later frame
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
    // `borrowed`: the caller keeps `pixels` alive until the GPU thread's next wait(), so a posted write needs no copy.
    GpuStatus writeTexture(Handle texture, const void* pixels, uint64_t size, bool borrowed = false);

    /** Completes on a later drain of the event queue, never inside this call. */
    GpuStatus readBuffer(Handle buffer, uint64_t offset, uint64_t size, ReadbackCallback done);
    GpuStatus readTexture(Handle texture, ReadbackCallback done);

    /** The handle dies now; the GPU object lives until every submission so far has completed. */
    GpuStatus destroy(Handle resource);
    /** One serial with `other`, a table on the same queue: a destroy here waits for its submissions too. */
    void shareSubmissions(const GpuResources& other) { shared_ = other.shared_; }

    /** Queue work (submits, maps, polls) runs on `thread` from now on; null runs it inline again. */
    void setThread(std::shared_ptr<GpuThread> thread);
    GpuThread* thread() const { return shared_->thread.get(); }
    /** Waits for the posted queue work; a no-op without a GPU thread. */
    void sync() const {
        flushSubmits();
        if (shared_->thread) shared_->thread->wait();
    }
    /** Runs `job` on the GPU thread after the work posted before it, or now without one. */
    void post(std::function<void()> job) const;

    WGPUBuffer buffer(Handle handle) const;
    WGPUTexture texture(Handle handle) const;

    /** The only path to the queue, so every submission has a serial a destroy can wait for. */
    uint64_t submit(WGPUCommandBuffer commands);
    /**
     * Without a GPU thread, this table's submits wait and reach the queue in one wgpuQueueSubmit with the next
     * submit of a table that does not batch: a render target draw then costs no queue submit and no work-done
     * callback of its own (29 per Lantern Vale frame). Order holds: any other queue write or read sends the
     * waiting work first, and so does this table's own write once its work waits.
     */
    void batchSubmits() { batching_ = true; }
    /** A submit that reads no queue-written buffer but `reads` (a compute dispatch): it waits too, from any table. */
    uint64_t submit(WGPUCommandBuffer commands, std::vector<WGPUBuffer> reads);
    /** Sends the waiting batched submits to the queue now; a no-op when none wait. */
    static void flushSubmits();
    /** wgpuQueueSubmit calls so far, by every table; a test reads it. */
    static uint64_t queueSubmits();
    /** Non-blocking: lets the backend deliver finished callbacks into the event queue. */
    void poll();

    uint64_t submittedSerial() const { std::lock_guard lock(shared_->mutex); return shared_->submitted; }
    uint64_t completedSerial() const { std::lock_guard lock(shared_->mutex); return shared_->completed; }
    size_t pendingDestroyCount() const { std::lock_guard lock(shared_->mutex); return shared_->pending.size(); }
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
    // The render thread submits and destroys while the game thread drains completions (PRD-613):
    // `mutex` guards the serials and the pending list; collect() runs with it held.
    struct Shared {
        struct IdleStaging {
            WGPUBuffer buffer;
            uint64_t size;
        };
        std::shared_ptr<GpuThread> thread;
        mutable std::mutex mutex;
        uint64_t submitted = 0;
        uint64_t completed = 0;
        std::vector<PendingDestroy> pending;
        // Completed readback leases wait here, by exact size, until the next read of that size.
        std::mutex stagingMutex;
        std::vector<IdleStaging> idleStaging;
        ~Shared();
        void collect();
    };

    static void release(Record& record);
    static void recycleStaging(const std::shared_ptr<Shared>& shared, WGPUBuffer staging, uint64_t size);
    WGPUBuffer leaseStaging(uint64_t size);
    static void complete(const std::shared_ptr<void>& owner, uint64_t serial);
    bool waitingMayRead(WGPUBuffer buffer) const;
    uint64_t submit(WGPUCommandBuffer commands, bool batch, std::vector<WGPUBuffer>* reads);
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
    bool batching_ = false;
};

}  // namespace tn::engine
