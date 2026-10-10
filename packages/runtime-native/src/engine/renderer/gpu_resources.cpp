#include "gpu_resources.h"

#include <algorithm>
#include <cstring>
#include <utility>

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
    ready.swap(events_);
    for (auto& event : ready) event();
    return ready.size();
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

GpuStatus GpuResources::writeBuffer(Handle buffer, uint64_t offset, const void* data, uint64_t size) {
    GpuStatus status;
    Record* target = record(buffer, kBuffer, status);
    if (!target) return status;
    if (offset > target->size || size > target->size - offset || size % 4 != 0 || offset % 4 != 0) {
        return GpuStatus::OutOfRange;
    }
    wgpuQueueWriteBuffer(queue_, target->buffer, offset, data, size);
    queueWriteBytes_ += size;
    return GpuStatus::Ok;
}

GpuStatus GpuResources::writeTexture(Handle texture, const void* pixels, uint64_t size) {
    GpuStatus status;
    Record* target = record(texture, kTexture, status);
    if (!target) return status;
    if (size != target->size) return GpuStatus::OutOfRange;
    WGPUImageCopyTexture_Compat destination = {};
    destination.texture = target->texture;
    destination.aspect = WGPUTextureAspect_All;
    WGPUTextureDataLayout_Compat layout = {};
    layout.bytesPerRow = target->width * target->bytesPerPixel;
    layout.rowsPerImage = target->height;
    const WGPUExtent3D extent = {target->width, target->height, 1};
    wgpuQueueWriteTexture(queue_, &destination, pixels, size, &layout, &extent);
    return GpuStatus::Ok;
}

void GpuResources::readInto(WGPUCommandEncoder encoder, WGPUBuffer staging, uint64_t size,
                            std::function<void(const uint8_t*)> unpack, ReadbackCallback done) {
    WGPUCommandBufferDescriptor commandDesc = {};
    WGPUCommandBuffer commands = wgpuCommandEncoderFinish(encoder, &commandDesc);
    wgpuCommandEncoderRelease(encoder);
    submit(commands);

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
            wgpuBufferRelease(request->staging);
        });
    };
    wgpuBufferMapAsync(staging, WGPUMapMode_Read, 0, size, info);
}

GpuStatus GpuResources::readBuffer(Handle buffer, uint64_t offset, uint64_t size, ReadbackCallback done) {
    GpuStatus status;
    Record* source = record(buffer, kBuffer, status);
    if (!source) return status;
    if (offset > source->size || size > source->size - offset || size % 4 != 0 || offset % 4 != 0) {
        return GpuStatus::OutOfRange;
    }
    WGPUBufferDescriptor stagingDesc = {};
    stagingDesc.size = size;
    stagingDesc.usage = WGPUBufferUsage_MapRead | WGPUBufferUsage_CopyDst;
    WGPUBuffer staging = wgpuDeviceCreateBuffer(device_, &stagingDesc);
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

    WGPUBufferDescriptor stagingDesc = {};
    stagingDesc.size = stagingSize;
    stagingDesc.usage = WGPUBufferUsage_MapRead | WGPUBufferUsage_CopyDst;
    WGPUBuffer staging = wgpuDeviceCreateBuffer(device_, &stagingDesc);
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
    shared_->pending.push_back(PendingDestroy{shared_->submitted, *target});
    *target = Record{};
    shared_->collect();
    return GpuStatus::Ok;
}

WGPUBuffer GpuResources::buffer(Handle handle) const {
    return handles_.check(handle, kBuffer) == HandleError::None ? records_[handle.index].buffer : nullptr;
}

WGPUTexture GpuResources::texture(Handle handle) const {
    return handles_.check(handle, kTexture) == HandleError::None ? records_[handle.index].texture : nullptr;
}

uint64_t GpuResources::submit(WGPUCommandBuffer commands) {
    wgpuQueueSubmit(queue_, 1, &commands);
    wgpuCommandBufferRelease(commands);
    const uint64_t serial = ++shared_->submitted;

    struct WorkDone {
        std::weak_ptr<Shared> owner;
        EventQueue* events;
        uint64_t serial;
    };
    WGPUQueueWorkDoneCallbackInfo info = {};
    info.mode = WGPUCallbackMode_AllowProcessEvents;
    info.userdata1 = new WorkDone{shared_, &events_, serial};
    info.callback = [](WGPUQueueWorkDoneStatus,
#if defined(MYSTRAL_WEBGPU_DAWN)
                       WGPUStringView,
#endif
                       void* userdata, void*) {
        std::unique_ptr<WorkDone> done(static_cast<WorkDone*>(userdata));
        // A backend may fire this at device release, after the resource table and the event queue
        // it posts to are gone (wgpu does); the queue outlives the table, so a live owner is the test.
        if (done->owner.expired()) return;
        done->events->post([owner = done->owner, serial = done->serial]() {
            if (auto shared = owner.lock()) {
                shared->completed = std::max(shared->completed, serial);
                shared->collect();
            }
        });
    };
    wgpuQueueOnSubmittedWorkDone(queue_, info);
    return serial;
}

void GpuResources::poll() {
#if defined(MYSTRAL_WEBGPU_DAWN)
    wgpuInstanceProcessEvents(instance_);
#else
    wgpuDevicePoll(device_, false, nullptr);
#endif
}

}  // namespace tn::engine
