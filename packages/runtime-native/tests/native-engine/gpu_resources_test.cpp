#include "check.h"
#include "engine/foundation/reachability.h"
#include "engine/renderer/gpu_resources.h"
#include "mystral/webgpu/context.h"

#include <chrono>
#include <thread>

using tn::engine::EventQueue;
using tn::engine::GpuResources;
using tn::engine::GpuStatus;
using tn::engine::Handle;

namespace {

struct Device {
    mystral::webgpu::Context context;
    EventQueue events;
    bool ok = context.initializeHeadless();
};

// The test may wait; the engine never does. Polls until `done` or about two seconds pass.
template <typename Done>
bool pump(GpuResources& gpu, EventQueue& events, Done done) {
    for (int i = 0; i < 2000 && !done(); ++i) {
        gpu.poll();
        events.drain();
        if (!done()) std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    return done();
}

void uploadReadback() {
    Device device;
    CHECK(device.ok);
    if (!device.ok) return;
    GpuResources gpu(device.context.getInstance(), device.context.getDevice(), device.context.getQueue(),
                     device.events, 1);

    std::vector<uint8_t> bytes(4096);
    for (size_t i = 0; i < bytes.size(); ++i) bytes[i] = static_cast<uint8_t>(i * 7 + 3);
    const Handle buffer = gpu.createBuffer(bytes.size(), WGPUBufferUsage_CopyDst | WGPUBufferUsage_CopySrc);
    CHECK(gpu.writeBuffer(buffer, 0, bytes.data(), bytes.size()) == GpuStatus::Ok);
    CHECK(gpu.writeBuffer(buffer, 4092, bytes.data(), 8) == GpuStatus::OutOfRange);

    // 13 wide: a row of 52 bytes, so the readback must strip 256-byte row padding.
    const uint32_t width = 13, height = 5;
    std::vector<uint8_t> pixels(width * height * 4);
    for (size_t i = 0; i < pixels.size(); ++i) pixels[i] = static_cast<uint8_t>(255 - i);
    const Handle texture = gpu.createTexture(width, height, WGPUTextureFormat_RGBA8Unorm,
                                             WGPUTextureUsage_CopyDst | WGPUTextureUsage_CopySrc);
    CHECK(gpu.writeTexture(texture, pixels.data(), pixels.size()) == GpuStatus::Ok);

    std::vector<uint8_t> readBytes, readPixels;
    bool bufferDone = false, textureDone = false;
    CHECK(gpu.readBuffer(buffer, 0, bytes.size(), [&](GpuStatus s, std::vector<uint8_t> out) {
        CHECK(s == GpuStatus::Ok);
        readBytes = std::move(out);
        bufferDone = true;
    }) == GpuStatus::Ok);
    CHECK(gpu.readTexture(texture, [&](GpuStatus s, std::vector<uint8_t> out) {
        CHECK(s == GpuStatus::Ok);
        readPixels = std::move(out);
        textureDone = true;
    }) == GpuStatus::Ok);
    CHECK(pump(gpu, device.events, [&] { return bufferDone && textureDone; }));
    CHECK(readBytes == bytes);
    CHECK(readPixels == pixels);
    CHECK(gpu.readBuffer(texture, 0, 4, [](GpuStatus, std::vector<uint8_t>) {}) == GpuStatus::WrongType);
}

void deferredDestroy() {
    Device device;
    CHECK(device.ok);
    if (!device.ok) return;
    GpuResources gpu(device.context.getInstance(), device.context.getDevice(), device.context.getQueue(),
                     device.events, 1);
    const Handle source = gpu.createBuffer(256, WGPUBufferUsage_CopyDst | WGPUBufferUsage_CopySrc);
    const Handle target = gpu.createBuffer(256, WGPUBufferUsage_CopyDst | WGPUBufferUsage_CopySrc);

    // A submission that reads `source`, then a destroy before the GPU has been polled at all.
    WGPUCommandEncoderDescriptor encoderDesc = {};
    WGPUCommandEncoder encoder = wgpuDeviceCreateCommandEncoder(device.context.getDevice(), &encoderDesc);
    wgpuCommandEncoderCopyBufferToBuffer(encoder, gpu.buffer(source), 0, gpu.buffer(target), 0, 256);
    WGPUCommandBufferDescriptor commandDesc = {};
    const uint64_t serial = gpu.submit(wgpuCommandEncoderFinish(encoder, &commandDesc));
    wgpuCommandEncoderRelease(encoder);

    CHECK(gpu.destroy(source) == GpuStatus::Ok);
    CHECK(gpu.buffer(source) == nullptr);                    // the handle dies at once
    CHECK(gpu.destroy(source) == GpuStatus::InvalidHandle);
    CHECK(gpu.completedSerial() < serial);
    CHECK(gpu.pendingDestroyCount() == 1);                   // the GPU object waits for the submission
    CHECK(pump(gpu, device.events, [&] { return gpu.completedSerial() >= serial; }));
    CHECK(gpu.pendingDestroyCount() == 0);
    CHECK(gpu.liveCount() == 1);
}

void asyncOnly() {
    Device device;
    CHECK(device.ok);
    if (!device.ok) return;
    GpuResources gpu(device.context.getInstance(), device.context.getDevice(), device.context.getQueue(),
                     device.events, 1);
    const Handle buffer = gpu.createBuffer(64, WGPUBufferUsage_CopyDst | WGPUBufferUsage_CopySrc);
    bool done = false;
    CHECK(gpu.readBuffer(buffer, 0, 64, [&](GpuStatus, std::vector<uint8_t>) { done = true; }) == GpuStatus::Ok);
    CHECK(!done);  // never inside the call
    // Polling alone only queues the result; it is delivered when the engine drains its events.
    for (int i = 0; i < 2000 && device.events.pending() == 0; ++i) {
        gpu.poll();
        if (device.events.pending() == 0) std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    CHECK(!done);
    CHECK(pump(gpu, device.events, [&] { return done; }));

    // A handle from another device generation is refused by name.
    GpuResources nextDevice(device.context.getInstance(), device.context.getDevice(), device.context.getQueue(),
                            device.events, 2);
    CHECK(nextDevice.status(buffer, GpuResources::kBuffer) == GpuStatus::StaleGeneration);
}

void lifetimeDeferredGpu() {
    Device device;
    CHECK(device.ok);
    if (!device.ok) return;
    GpuResources gpu(device.context.getInstance(), device.context.getDevice(), device.context.getQueue(),
                     device.events, 1);
    tn::engine::ObjectGraph graph(1);
    const Handle buffer = gpu.createBuffer(256, WGPUBufferUsage_CopyDst | WGPUBufferUsage_CopySrc);
    const Handle copyTarget = gpu.createBuffer(256, WGPUBufferUsage_CopyDst);
    // The geometry object owns the buffer; reclaiming it hands the buffer to the deferred queue.
    const Handle geometry = graph.create(1, [&] { gpu.destroy(buffer); });

    WGPUCommandEncoderDescriptor encoderDesc = {};
    WGPUCommandEncoder encoder = wgpuDeviceCreateCommandEncoder(device.context.getDevice(), &encoderDesc);
    wgpuCommandEncoderCopyBufferToBuffer(encoder, gpu.buffer(buffer), 0, gpu.buffer(copyTarget), 0, 256);
    WGPUCommandBufferDescriptor commandDesc = {};
    const uint64_t serial = gpu.submit(wgpuCommandEncoderFinish(encoder, &commandDesc));
    wgpuCommandEncoderRelease(encoder);

    CHECK(graph.collect().reclaimed == 1);             // unrooted: reclaimed at this safe point
    CHECK(!graph.alive(geometry));
    CHECK(gpu.buffer(buffer) == nullptr);
    CHECK(gpu.completedSerial() < serial);
    CHECK(gpu.pendingDestroyCount() == 1);             // not released before the submission completes
    CHECK(pump(gpu, device.events, [&] { return gpu.completedSerial() >= serial; }));
    CHECK(gpu.pendingDestroyCount() == 0);             // and released after
}

}  // namespace

TN_TEST_MAIN({"upload_readback", uploadReadback}, {"deferred_destroy", deferredDestroy}, {"async_only", asyncOnly},
             {"lifetime_deferred_gpu", lifetimeDeferredGpu})
