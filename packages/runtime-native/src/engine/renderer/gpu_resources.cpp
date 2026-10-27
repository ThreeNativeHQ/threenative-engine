#include "gpu_resources.h"

#include <algorithm>
#include <atomic>
#include <cstring>
#include <utility>

#include "engine/foundation/waste_counters.h"

#include "mystral/webgpu_compat.h"

#if defined(MYSTRAL_WEBGPU_WGPU)
#if __has_include(<webgpu/wgpu.h>)
#include <webgpu/wgpu.h>
#else
#include <wgpu/wgpu.h>
#endif
#endif

#if !WGPU_BUFFER_MAP_USES_CALLBACK_INFO
#error "the native engine needs the callback-info WebGPU API (Dawn or wgpu-native 25+)"
#endif

namespace tn::engine {

namespace {

constexpr uint32_t kBytesPerPixel = 4;

// Idle readback leases kept per owner; a readback of another size is a different lease.
constexpr size_t kMaxIdleStaging = 4;
constexpr uint64_t kMaxIdleStagingBytes = 8u << 20;

// The formats this table uploads: RGBA8 (4 bytes), RGBA16Float (8) and RGBA32Float (16). Anything
// else keeps 4 so a new format fails its size check rather than writing a wrong row pitch.
uint32_t bytesPerPixel(WGPUTextureFormat format) {
    if (format == WGPUTextureFormat_RGBA32Float) return 16u;
    if (format == WGPUTextureFormat_RGBA16Float) return 8u;
    return kBytesPerPixel;
}

uint32_t alignedRow(uint32_t width, uint32_t bpp) { return (width * bpp + 255u) & ~255u; }

GpuStatus fromHandleError(HandleError error) {
    switch (error) {
        case HandleError::None: return GpuStatus::Ok;
        case HandleError::Context: return GpuStatus::StaleGeneration;
        case HandleError::Type: return GpuStatus::WrongType;
        case HandleError::Stale:
        case HandleError::Invalid: return GpuStatus::InvalidHandle;
    }
    return GpuStatus::InvalidHandle;
}

}  // namespace

size_t EventQueue::drain() {
    std::vector<std::function<void()>> ready;
    {
        std::lock_guard lock(mutex_);
        ready.swap(events_);
    }
    for (auto& event : ready) event();
    return ready.size();
}

GpuThread::GpuThread() {
    thread_ = std::thread([this] {
        std::unique_lock lock(mutex_);
        for (;;) {
            work_.wait(lock, [this] { return stopping_ || !pending_.empty(); });  // TN_WORKER_ONLY: only inside the GPU thread
            if (pending_.empty()) return;
            auto job = std::move(pending_.front());
            pending_.pop_front();
            busy_ = true;
            lock.unlock();
            job();
            lock.lock();
            busy_ = false;
            ++ran_;
            if (pending_.empty()) idle_.notify_all();
        }
    });
}

GpuThread::~GpuThread() {
    {
        std::lock_guard lock(mutex_);
        stopping_ = true;
    }
    work_.notify_one();
    thread_.join();  // runs what was posted first: a posted submit still reaches the queue
}

void GpuThread::post(std::function<void()> job) {
    {
        std::lock_guard lock(mutex_);
        pending_.push_back(std::move(job));
    }
    work_.notify_one();
}

void GpuThread::wait() {
    std::unique_lock lock(mutex_);
    // The game thread waits here for the previous frame's present job, once per frame: the swap it
    // used to block in itself. Never on GPU completion, and only the native player starts a GpuThread.
    idle_.wait(lock, [this] { return pending_.empty() && !busy_; });  // TN_WORKER_ONLY: GpuThread::wait frame join
}

uint64_t GpuThread::ran() const {
    std::lock_guard lock(mutex_);
    return ran_;
}

void GpuResources::Shared::collect() {
    auto done = std::partition(pending.begin(), pending.end(),
                               [this](const PendingDestroy& entry) { return entry.afterSerial > completed; });
    for (auto it = done; it != pending.end(); ++it) GpuResources::release(it->record);
    pending.erase(done, pending.end());
}

GpuResources::GpuResources(WGPUInstance instance, WGPUDevice device, WGPUQueue queue, EventQueue& events,
                           uint16_t deviceGeneration)
    : instance_(instance), device_(device), queue_(queue), events_(events), handles_(deviceGeneration) {}

GpuResources::~GpuResources() {
    sync();  // a posted job or a waiting batched submit may still read these
    for (Record& record : records_) release(record);
    if (shared_.use_count() > 1) return;  // a table sharing the serial still submits: it frees them
    for (PendingDestroy& entry : shared_->pending) release(entry.record);
    shared_->pending.clear();
}

void GpuResources::release(Record& record) {
    if (record.buffer) {
        wgpuBufferDestroy(record.buffer);
        wgpuBufferRelease(record.buffer);
    }
    if (record.texture) {
        wgpuTextureDestroy(record.texture);
        wgpuTextureRelease(record.texture);
    }
    record = Record{};
}

GpuStatus GpuResources::status(Handle handle, uint16_t type) const {
    return fromHandleError(handles_.check(handle, type));
}

GpuResources::Record* GpuResources::record(Handle handle, uint16_t type, GpuStatus& status) {
    status = fromHandleError(handles_.check(handle, type));
    return status == GpuStatus::Ok ? &records_[handle.index] : nullptr;
}

Handle GpuResources::createBuffer(uint64_t size, WGPUBufferUsage usage) {
    return createBuffer(size, usage, nullptr, 0);
}

Handle GpuResources::createBuffer(uint64_t size, WGPUBufferUsage usage, const void* data, uint64_t bytes) {
    ++waste::counters().bufferAllocs;
    WGPUBufferDescriptor desc = {};
    desc.size = size;
    desc.usage = usage;
    // Mapped creation needs a whole number of words; the mapped memory starts zeroed.
    desc.mappedAtCreation = bytes > 0 && bytes <= size && size % 4 == 0;
    WGPUBuffer buffer = wgpuDeviceCreateBuffer(device_, &desc);
    if (!buffer) return Handle{};
    if (desc.mappedAtCreation) {
        void* mapped = wgpuBufferGetMappedRange(buffer, 0, size);
        if (mapped) std::memcpy(mapped, data, bytes);
        wgpuBufferUnmap(buffer);
        if (!mapped) {
            wgpuBufferRelease(buffer);
            return Handle{};
        }
    }
    const Handle handle = handles_.allocate(kBuffer);
    if (records_.size() <= handle.index) records_.resize(handle.index + 1);
    records_[handle.index] = Record{buffer, nullptr, size, 0, 0};
    return handle;
}

Handle GpuResources::createTexture(uint32_t width, uint32_t height, WGPUTextureFormat format,
                                   WGPUTextureUsage usage) {
    ++waste::counters().textureAllocs;
    WGPUTextureDescriptor desc = {};
    desc.dimension = WGPUTextureDimension_2D;
    desc.size = {width, height, 1};
    desc.format = format;
    desc.usage = usage;
    desc.mipLevelCount = 1;
    desc.sampleCount = 1;
    WGPUTexture texture = wgpuDeviceCreateTexture(device_, &desc);
    if (!texture) return Handle{};
    const Handle handle = handles_.allocate(kTexture);
    if (records_.size() <= handle.index) records_.resize(handle.index + 1);
    const uint32_t bpp = bytesPerPixel(format);
    records_[handle.index] = Record{nullptr, texture, uint64_t{width} * height * bpp, width, height, bpp};
    return handle;
}

void GpuResources::setThread(std::shared_ptr<GpuThread> thread) {
    sync();
    shared_->thread = std::move(thread);
}

void GpuResources::post(std::function<void()> job) const {
    if (shared_->thread) shared_->thread->post(std::move(job));
    else job();
}

GpuStatus GpuResources::writeBuffer(Handle buffer, uint64_t offset, const void* data, uint64_t size) {
    GpuStatus status;
    Record* target = record(buffer, kBuffer, status);
    if (!target) return status;
    if (offset > target->size || size > target->size - offset || size % 4 != 0 || offset % 4 != 0) {
        return GpuStatus::OutOfRange;
    }
    // A waiting submit that may read this buffer goes first. A batching table's own write is safe until its own
    // work waits, since no other table's submit reads its buffers.
    if (waitingMayRead(target->buffer)) flushSubmits();
    if (shared_->thread) {
        // Queued behind the submits already posted, with its own copy of the bytes, as a browser's
        // GPU process takes a write: the game thread never waits for the GPU thread here.
        WGPUBuffer gpuBuffer = target->buffer;
        wgpuBufferAddRef(gpuBuffer);
        std::vector<uint8_t> bytes(static_cast<const uint8_t*>(data), static_cast<const uint8_t*>(data) + size);
        shared_->thread->post([queue = queue_, gpuBuffer, offset, bytes = std::move(bytes)] {
            wgpuQueueWriteBuffer(queue, gpuBuffer, offset, bytes.data(), bytes.size());
            wgpuBufferRelease(gpuBuffer);
        });
    } else {
        wgpuQueueWriteBuffer(queue_, target->buffer, offset, data, size);
    }
    queueWriteBytes_ += size;
    return GpuStatus::Ok;
}

GpuStatus GpuResources::writeTexture(Handle texture, const void* pixels, uint64_t size, bool borrowed) {
    GpuStatus status;
    Record* target = record(texture, kTexture, status);
    if (!target) return status;
    if (size != target->size) return GpuStatus::OutOfRange;
    flushSubmits();
    WGPUImageCopyTexture_Compat destination = {};
    destination.texture = target->texture;
    destination.aspect = WGPUTextureAspect_All;
    WGPUTextureDataLayout_Compat layout = {};
    layout.bytesPerRow = target->width * target->bytesPerPixel;
    layout.rowsPerImage = target->height;
    const WGPUExtent3D extent = {target->width, target->height, 1};
    if (shared_->thread && borrowed) {
        wgpuTextureAddRef(destination.texture);
        shared_->thread->post([queue = queue_, destination, layout, extent, pixels, size] {
            wgpuQueueWriteTexture(queue, &destination, pixels, size, &layout, &extent);
            wgpuTextureRelease(destination.texture);
        });
    } else if (shared_->thread) {
        // Posted with its own copy, like writeBuffer.
        wgpuTextureAddRef(destination.texture);
        std::vector<uint8_t> bytes(static_cast<const uint8_t*>(pixels), static_cast<const uint8_t*>(pixels) + size);
        shared_->thread->post([queue = queue_, destination, layout, extent, bytes = std::move(bytes)] {
            wgpuQueueWriteTexture(queue, &destination, bytes.data(), bytes.size(), &layout, &extent);
            wgpuTextureRelease(destination.texture);
        });
    } else {
        wgpuQueueWriteTexture(queue_, &destination, pixels, size, &layout, &extent);
    }
    return GpuStatus::Ok;
}

GpuResources::Shared::~Shared() {
    for (const IdleStaging& entry : idleStaging) wgpuBufferRelease(entry.buffer);
}

WGPUBuffer GpuResources::leaseStaging(uint64_t size) {
    {
        std::lock_guard lock(shared_->stagingMutex);
        auto& idle = shared_->idleStaging;
        for (auto it = idle.begin(); it != idle.end(); ++it) {
            if (it->size != size) continue;
            WGPUBuffer buffer = it->buffer;
            idle.erase(it);
            return buffer;
        }
    }
    WGPUBufferDescriptor desc = {};
    desc.size = size;
    desc.usage = WGPUBufferUsage_MapRead | WGPUBufferUsage_CopyDst;
    return wgpuDeviceCreateBuffer(device_, &desc);
}

void GpuResources::recycleStaging(const std::shared_ptr<Shared>& shared, WGPUBuffer staging, uint64_t size) {
    std::lock_guard lock(shared->stagingMutex);
    auto& idle = shared->idleStaging;
    uint64_t bytes = 0;
    for (const Shared::IdleStaging& entry : idle) bytes += entry.size;
    if (idle.size() >= kMaxIdleStaging || bytes + size > kMaxIdleStagingBytes) {
        wgpuBufferRelease(staging);
        return;
    }
    idle.push_back(Shared::IdleStaging{staging, size});
}

void GpuResources::readInto(WGPUCommandEncoder encoder, WGPUBuffer staging, uint64_t size,
                            std::function<void(const uint8_t*)> unpack, ReadbackCallback done) {
    WGPUCommandBufferDescriptor commandDesc = {};
    WGPUCommandBuffer commands = wgpuCommandEncoderFinish(encoder, &commandDesc);
    wgpuCommandEncoderRelease(encoder);
    submit(commands);
    flushSubmits();  // the copy reaches the queue before the map below

    struct MapRequest {
        std::weak_ptr<Shared> owner;
        EventQueue* events;
        WGPUBuffer staging;
        uint64_t size;
        std::function<void(const uint8_t*)> unpack;
        ReadbackCallback done;
    };
    auto* request = new MapRequest{shared_, &events_, staging, size, std::move(unpack), std::move(done)};

    WGPUBufferMapCallbackInfo info = {};
    info.mode = WGPUCallbackMode_AllowProcessEvents;
    info.userdata1 = request;
    info.callback = [](WGPUMapAsyncStatus mapStatus, WGPUStringView, void* userdata, void*) {
        std::unique_ptr<MapRequest> owned(static_cast<MapRequest*>(userdata));
        if (owned->owner.expired()) {
            // The resource table is gone; nothing is left to hand the bytes to.
            wgpuBufferRelease(owned->staging);
            return;
        }
        EventQueue* events = owned->events;
        events->post([request = std::shared_ptr<MapRequest>(std::move(owned)), mapStatus]() {
            if (mapStatus != WGPUMapAsyncStatus_Success) {
                wgpuBufferRelease(request->staging);
                request->done(GpuStatus::DeviceError, {});
                return;
            }
            const auto* bytes = static_cast<const uint8_t*>(
                wgpuBufferGetConstMappedRange(request->staging, 0, request->size));
            request->unpack(bytes);
            wgpuBufferUnmap(request->staging);
            // Idle only after the unmap: a concurrent read must never lease a mapped buffer.
            if (auto shared = request->owner.lock()) recycleStaging(shared, request->staging, request->size);
            else wgpuBufferRelease(request->staging);
        });
    };
    // After the submit that fills it: mapping a buffer an unsubmitted copy still writes is an error.
    post([staging, size, info] { wgpuBufferMapAsync(staging, WGPUMapMode_Read, 0, size, info); });
}

GpuStatus GpuResources::readBuffer(Handle buffer, uint64_t offset, uint64_t size, ReadbackCallback done) {
    GpuStatus status;
    Record* source = record(buffer, kBuffer, status);
    if (!source) return status;
    if (offset > source->size || size > source->size - offset || size % 4 != 0 || offset % 4 != 0) {
        return GpuStatus::OutOfRange;
    }
    WGPUBuffer staging = leaseStaging(size);
    if (!staging) return GpuStatus::DeviceError;

    WGPUCommandEncoderDescriptor encoderDesc = {};
    WGPUCommandEncoder encoder = wgpuDeviceCreateCommandEncoder(device_, &encoderDesc);
    wgpuCommandEncoderCopyBufferToBuffer(encoder, source->buffer, offset, staging, 0, size);
    auto finish = std::make_shared<ReadbackCallback>(std::move(done));
    readInto(
        encoder, staging, size,
        [size, finish](const uint8_t* bytes) { (*finish)(GpuStatus::Ok, std::vector<uint8_t>(bytes, bytes + size)); },
        [finish](GpuStatus failed, std::vector<uint8_t> none) { (*finish)(failed, std::move(none)); });
    return GpuStatus::Ok;
}

GpuStatus GpuResources::readTexture(Handle texture, ReadbackCallback done) {
    GpuStatus status;
    Record* source = record(texture, kTexture, status);
    if (!source) return status;
    const uint32_t width = source->width;
    const uint32_t height = source->height;
    const uint32_t bpp = source->bytesPerPixel;
    const uint32_t paddedRow = alignedRow(width, bpp);
    const uint64_t stagingSize = uint64_t{paddedRow} * height;

    WGPUBuffer staging = leaseStaging(stagingSize);
    if (!staging) return GpuStatus::DeviceError;

    WGPUCommandEncoderDescriptor encoderDesc = {};
    WGPUCommandEncoder encoder = wgpuDeviceCreateCommandEncoder(device_, &encoderDesc);
    WGPUImageCopyTexture_Compat from = {};
    from.texture = source->texture;
    from.aspect = WGPUTextureAspect_All;
    WGPUImageCopyBuffer_Compat to = {};
    to.buffer = staging;
    to.layout.bytesPerRow = paddedRow;
    to.layout.rowsPerImage = height;
    const WGPUExtent3D extent = {width, height, 1};
    wgpuCommandEncoderCopyTextureToBuffer(encoder, &from, &to, &extent);

    auto finish = std::make_shared<ReadbackCallback>(std::move(done));
    readInto(
        encoder, staging, stagingSize,
        [width, height, paddedRow, bpp, finish](const uint8_t* bytes) {
            // Rows arrive 256-byte aligned; the caller gets them tightly packed.
            const uint32_t row = width * bpp;
            std::vector<uint8_t> pixels(uint64_t{row} * height);
            for (uint32_t y = 0; y < height; ++y) std::memcpy(&pixels[uint64_t{y} * row], bytes + uint64_t{y} * paddedRow, row);
            (*finish)(GpuStatus::Ok, std::move(pixels));
        },
        [finish](GpuStatus failed, std::vector<uint8_t> none) { (*finish)(failed, std::move(none)); });
    return GpuStatus::Ok;
}

GpuStatus GpuResources::destroy(Handle resource) {
    GpuStatus status;
    Record* target = record(resource, resource.type, status);
    if (!target) return status;
    handles_.release(resource);
    // Any submission so far may read it; it is freed once the last of them has completed.
    {
        std::lock_guard lock(shared_->mutex);
        shared_->pending.push_back(PendingDestroy{shared_->submitted, *target});
        *target = Record{};
        shared_->collect();
    }
    return GpuStatus::Ok;
}

WGPUBuffer GpuResources::buffer(Handle handle) const {
    return handles_.check(handle, kBuffer) == HandleError::None ? records_[handle.index].buffer : nullptr;
}

WGPUTexture GpuResources::texture(Handle handle) const {
    return handles_.check(handle, kTexture) == HandleError::None ? records_[handle.index].texture : nullptr;
}

namespace {

// One completion callback per queue submit: it raises `completed` to the last serial the submit carried.
void onWorkDone(WGPUQueue queue, std::weak_ptr<void> owner, EventQueue* events, uint64_t serial,
                void (*complete)(const std::shared_ptr<void>&, uint64_t)) {
    struct WorkDone {
        std::weak_ptr<void> owner;
        EventQueue* events;
        uint64_t serial;
        void (*complete)(const std::shared_ptr<void>&, uint64_t);
    };
    WGPUQueueWorkDoneCallbackInfo info = {};
    info.mode = WGPUCallbackMode_AllowProcessEvents;
    info.userdata1 = new WorkDone{std::move(owner), events, serial, complete};
    info.callback = [](WGPUQueueWorkDoneStatus,
#if defined(MYSTRAL_WEBGPU_DAWN)
                       WGPUStringView,
#endif
                       void* userdata, void*) {
        std::unique_ptr<WorkDone> done(static_cast<WorkDone*>(userdata));
        // A backend may fire this at device release, after the resource table and the event queue
        // it posts to are gone (wgpu does); the queue outlives the table, so a live owner is the test.
        if (done->owner.expired()) return;
        done->events->post([owner = done->owner, serial = done->serial, complete = done->complete]() {
            if (auto shared = owner.lock()) complete(shared, serial);
        });
    };
    wgpuQueueOnSubmittedWorkDone(queue, info);
}

// Batched submits wait here (web host: one thread, one queue), with the table serial each one took.
// ponytail: one process-wide batch, since the web host has one device; key it by queue if a second appears.
struct Batched {
    WGPUCommandBuffer commands;
    const void* table;
    std::weak_ptr<void> owner;
    EventQueue* events;
    uint64_t serial;
    std::optional<std::vector<WGPUBuffer>> reads;  // none: any buffer of `table`, or of a table that does not batch
};
struct Batch {
    WGPUQueue queue = nullptr;
    std::vector<Batched> waiting;
    std::atomic<uint64_t> queueSubmits = 0;  // a GPU thread's submits count too
};
Batch& batch() {
    static Batch instance;
    return instance;
}

}  // namespace

void GpuResources::flushSubmits() {
    Batch& b = batch();
    if (b.waiting.empty()) return;
    std::vector<WGPUCommandBuffer> commands;
    commands.reserve(b.waiting.size());
    for (const Batched& entry : b.waiting) commands.push_back(entry.commands);
    wgpuQueueSubmit(b.queue, commands.size(), commands.data());
    ++b.queueSubmits;
    for (WGPUCommandBuffer command : commands) wgpuCommandBufferRelease(command);
    // Completion is in order: one callback per submission table, for the last serial it waited with.
    for (size_t i = 0; i < b.waiting.size(); ++i) {
        const Batched& entry = b.waiting[i];
        bool last = true;
        for (size_t j = i + 1; j < b.waiting.size() && last; ++j)
            last = b.waiting[j].owner.owner_before(entry.owner) || entry.owner.owner_before(b.waiting[j].owner);
        if (last) onWorkDone(b.queue, entry.owner, entry.events, entry.serial, complete);
    }
    b.waiting.clear();
}

uint64_t GpuResources::queueSubmits() { return batch().queueSubmits; }

void GpuResources::complete(const std::shared_ptr<void>& owner, uint64_t serial) {
    auto* shared = static_cast<Shared*>(owner.get());
    std::lock_guard lock(shared->mutex);
    shared->completed = std::max(shared->completed, serial);
    shared->collect();
}

bool GpuResources::waitingMayRead(WGPUBuffer buffer) const {
    for (const Batched& entry : batch().waiting) {
        if (entry.reads ? std::find(entry.reads->begin(), entry.reads->end(), buffer) != entry.reads->end()
                        : !batching_ || entry.table == this)
            return true;
    }
    return false;
}

uint64_t GpuResources::submit(WGPUCommandBuffer commands) { return submit(commands, batching_, nullptr); }

uint64_t GpuResources::submit(WGPUCommandBuffer commands, std::vector<WGPUBuffer> reads) {
    return submit(commands, true, &reads);
}

uint64_t GpuResources::submit(WGPUCommandBuffer commands, bool batch_, std::vector<WGPUBuffer>* reads) {
    uint64_t serial;
    {
        std::lock_guard lock(shared_->mutex);
        serial = ++shared_->submitted;
    }
    if (batch_ && !shared_->thread) {
        batch().queue = queue_;
        batch().waiting.push_back(Batched{commands, this, std::weak_ptr<void>(shared_), &events_, serial,
                                          reads ? std::optional(std::move(*reads)) : std::nullopt});
        return serial;
    }
    if (!shared_->thread && !batch().waiting.empty()) {
        // The waiting work and this submit reach the queue together, in order.
        batch().waiting.push_back(Batched{commands, this, std::weak_ptr<void>(shared_), &events_, serial, std::nullopt});
        flushSubmits();
        return serial;
    }
    post([queue = queue_, commands, owner = std::weak_ptr<void>(shared_), events = &events_, serial] {
        wgpuQueueSubmit(queue, 1, &commands);
        ++batch().queueSubmits;
        wgpuCommandBufferRelease(commands);
        onWorkDone(queue, owner, events, serial, complete);
    });
    return serial;
}

void GpuResources::poll() {
    post([instance = instance_, device = device_] {
#if defined(MYSTRAL_WEBGPU_DAWN)
        (void)device;
        wgpuInstanceProcessEvents(instance);
#else
        (void)instance;
        wgpuDevicePoll(device, false, nullptr);
#endif
    });
}

}  // namespace tn::engine
