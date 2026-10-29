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

#ifdef TN_TEST_BUFFER_WRAP
extern "C" WGPUBuffer __real_wgpuDeviceCreateBuffer(WGPUDevice, const WGPUBufferDescriptor*);
int stagingAllocations = 0;
extern "C" WGPUBuffer __wrap_wgpuDeviceCreateBuffer(WGPUDevice device, const WGPUBufferDescriptor* desc) {
    if ((desc->usage & (WGPUBufferUsage_MapRead | WGPUBufferUsage_CopyDst)) ==
        (WGPUBufferUsage_MapRead | WGPUBufferUsage_CopyDst)) {
        ++stagingAllocations;
    }
    return __real_wgpuDeviceCreateBuffer(device, desc);
}
#endif
#ifdef TN_TEST_MAP_WRAP
extern "C" WGPUFuture __real_wgpuBufferMapAsync(WGPUBuffer, WGPUMapMode, size_t, size_t, WGPUBufferMapCallbackInfo);
bool failNextMap = false;
extern "C" WGPUFuture __wrap_wgpuBufferMapAsync(WGPUBuffer buffer, WGPUMapMode mode, size_t offset, size_t size,
                                                WGPUBufferMapCallbackInfo info) {
    if (failNextMap) {
        failNextMap = false;
        if (info.callback) info.callback(WGPUMapAsyncStatus_Error, WGPUStringView{}, info.userdata1, info.userdata2);
        return WGPUFuture{0};
    }
    return __real_wgpuBufferMapAsync(buffer, mode, offset, size, info);
}
#endif

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

// PRD-610 AC-9: with a GPU thread, submits and maps run there in order, and a queue write from the
// game thread never lands before a submit still waiting on it. The thread is held busy first, so a
// write that skipped the wait would overwrite the bytes the first read copies.
void gpuThreadOrdering() {
    Device device;
    CHECK(device.ok);
    if (!device.ok) return;
    GpuResources gpu(device.context.getInstance(), device.context.getDevice(), device.context.getQueue(),
                     device.events, 1);
    auto thread = std::make_shared<tn::engine::GpuThread>();
    gpu.setThread(thread);
    CHECK(gpu.thread() == thread.get());

    const std::vector<uint8_t> first(256, 0x11), second(256, 0x22);
    const Handle buffer = gpu.createBuffer(first.size(), WGPUBufferUsage_CopyDst | WGPUBufferUsage_CopySrc);
    CHECK(gpu.writeBuffer(buffer, 0, first.data(), first.size()) == GpuStatus::Ok);
    gpu.post([] { std::this_thread::sleep_for(std::chrono::milliseconds(50)); });
    std::vector<uint8_t> readFirst, readSecond;
    bool firstDone = false, secondDone = false;
    CHECK(gpu.readBuffer(buffer, 0, first.size(), [&](GpuStatus s, std::vector<uint8_t> out) {
        CHECK(s == GpuStatus::Ok);
        readFirst = std::move(out);
        firstDone = true;
    }) == GpuStatus::Ok);
    CHECK(gpu.writeBuffer(buffer, 0, second.data(), second.size()) == GpuStatus::Ok);
    CHECK(gpu.readBuffer(buffer, 0, second.size(), [&](GpuStatus s, std::vector<uint8_t> out) {
        CHECK(s == GpuStatus::Ok);
        readSecond = std::move(out);
        secondDone = true;
    }) == GpuStatus::Ok);
    CHECK(pump(gpu, device.events, [&] { return firstDone && secondDone; }));
    CHECK(readFirst == first);
    CHECK(readSecond == second);
    gpu.sync();
    CHECK(thread->ran() >= 5);  // the busy job, two submits, two maps, and the polls
}

// Render target tables batch their submits: two target draws and the frame's submit reach the queue as one
// wgpuQueueSubmit, and a target's second write after its own waiting draw still lands after that draw.
void batchedSubmits() {
    Device device;
    CHECK(device.ok);
    if (!device.ok) return;
    WGPUInstance instance = device.context.getInstance();
    WGPUDevice gpuDevice = device.context.getDevice();
    WGPUQueue queue = device.context.getQueue();
    GpuResources frame(instance, gpuDevice, queue, device.events, 1);
    GpuResources first(instance, gpuDevice, queue, device.events, 1), second(instance, gpuDevice, queue, device.events, 1);
    for (GpuResources* target : {&first, &second}) {
        target->shareSubmissions(frame);
        target->batchSubmits();
    }
    const auto usage = WGPUBufferUsage_CopyDst | WGPUBufferUsage_CopySrc;
    const auto copy = [&](GpuResources& gpu, Handle from, Handle to) {
        WGPUCommandEncoderDescriptor encoderDesc = {};
        WGPUCommandEncoder encoder = wgpuDeviceCreateCommandEncoder(gpuDevice, &encoderDesc);
        wgpuCommandEncoderCopyBufferToBuffer(encoder, gpu.buffer(from), 0, gpu.buffer(to), 0, 256);
        WGPUCommandBufferDescriptor commandDesc = {};
        const uint64_t serial = gpu.submit(wgpuCommandEncoderFinish(encoder, &commandDesc));
        wgpuCommandEncoderRelease(encoder);
        return serial;
    };
    const std::vector<uint8_t> a(256, 0xa1), b(256, 0xb2), c(256, 0xc3);
    const Handle uniforms = first.createBuffer(256, usage), firstOut = first.createBuffer(256, usage),
                 againOut = first.createBuffer(256, usage);
    const Handle secondIn = second.createBuffer(256, usage), secondOut = second.createBuffer(256, usage);
    const Handle frameIn = frame.createBuffer(256, usage), frameOut = frame.createBuffer(256, usage);

    const uint64_t before = GpuResources::queueSubmits();
    CHECK(first.writeBuffer(uniforms, 0, a.data(), a.size()) == GpuStatus::Ok);
    copy(first, uniforms, firstOut);
    CHECK(second.writeBuffer(secondIn, 0, b.data(), b.size()) == GpuStatus::Ok);  // another table: no flush
    copy(second, secondIn, secondOut);
    CHECK(GpuResources::queueSubmits() == before);  // both draws wait
    CHECK(frame.writeBuffer(frameIn, 0, c.data(), c.size()) == GpuStatus::Ok);  // the frame's write sends them
    const uint64_t frameSerial = copy(frame, frameIn, frameOut);
    CHECK(GpuResources::queueSubmits() == before + 2);
    CHECK(pump(frame, device.events, [&] { return frame.completedSerial() >= frameSerial; }));

    // Without the frame's write in between: the two draws and the frame submit are one queue submit.
    const uint64_t merged = GpuResources::queueSubmits();
    copy(first, uniforms, firstOut);
    copy(second, secondIn, secondOut);
    const uint64_t last = copy(frame, frameIn, frameOut);
    CHECK(GpuResources::queueSubmits() == merged + 1);
    CHECK(pump(frame, device.events, [&] { return frame.completedSerial() >= last; }));

    // A second write by a table whose draw waits goes after that draw, as an unbatched queue would order it.
    copy(first, uniforms, firstOut);
    CHECK(first.writeBuffer(uniforms, 0, b.data(), b.size()) == GpuStatus::Ok);
    copy(first, uniforms, againOut);
    std::vector<uint8_t> readFirst, readAgain, readSecond;
    int reads = 0;
    const auto into = [&](std::vector<uint8_t>& out) {
        return [&out, &reads](GpuStatus s, std::vector<uint8_t> bytes) {
            CHECK(s == GpuStatus::Ok);
            out = std::move(bytes);
            ++reads;
        };
    };
    CHECK(first.readBuffer(firstOut, 0, 256, into(readFirst)) == GpuStatus::Ok);  // a read sends what waits
    CHECK(first.readBuffer(againOut, 0, 256, into(readAgain)) == GpuStatus::Ok);
    CHECK(second.readBuffer(secondOut, 0, 256, into(readSecond)) == GpuStatus::Ok);
    CHECK(pump(frame, device.events, [&] { return reads == 3; }));
    CHECK(readFirst == a);
    CHECK(readAgain == b);
    CHECK(readSecond == b);
    CHECK(first.completedSerial() == frame.submittedSerial());

    // A dispatch names the buffers it binds: a write to another buffer leaves it waiting, a write to one it
    // binds sends it first, so it still reads the value written before it.
    const auto dispatch = [&](Handle from, Handle to) {
        WGPUCommandEncoderDescriptor encoderDesc = {};
        WGPUCommandEncoder encoder = wgpuDeviceCreateCommandEncoder(gpuDevice, &encoderDesc);
        wgpuCommandEncoderCopyBufferToBuffer(encoder, frame.buffer(from), 0, frame.buffer(to), 0, 256);
        WGPUCommandBufferDescriptor commandDesc = {};
        frame.submit(wgpuCommandEncoderFinish(encoder, &commandDesc), {frame.buffer(from), frame.buffer(to)});
        wgpuCommandEncoderRelease(encoder);
    };
    const Handle other = frame.createBuffer(256, usage);
    const uint64_t dispatched = GpuResources::queueSubmits();
    CHECK(frame.writeBuffer(frameIn, 0, a.data(), a.size()) == GpuStatus::Ok);
    dispatch(frameIn, frameOut);
    CHECK(frame.writeBuffer(other, 0, c.data(), c.size()) == GpuStatus::Ok);
    CHECK(GpuResources::queueSubmits() == dispatched);  // the dispatch binds no `other`
    CHECK(frame.writeBuffer(frameIn, 0, b.data(), b.size()) == GpuStatus::Ok);
    CHECK(GpuResources::queueSubmits() == dispatched + 1);
    std::vector<uint8_t> readDispatch;
    CHECK(frame.readBuffer(frameOut, 0, 256, into(readDispatch)) == GpuStatus::Ok);
    CHECK(pump(frame, device.events, [&] { return reads == 4; }));
    CHECK(readDispatch == a);
}

// A completed read returns its staging lease to the owner's idle pool, so serial reads of one size
// allocate once. In-flight, failed and differently sized reads never share a lease.
void readbackReusesStaging() {
    Device device;
    CHECK(device.ok);
    if (!device.ok) return;
    GpuResources gpu(device.context.getInstance(), device.context.getDevice(), device.context.getQueue(),
                     device.events, 1);
    const uint64_t size = 64;
    std::vector<uint8_t> bytes(size);
    for (uint64_t i = 0; i < size; ++i) bytes[i] = static_cast<uint8_t>(i * 5 + 7);
    const Handle source = gpu.createBuffer(size, WGPUBufferUsage_CopyDst | WGPUBufferUsage_CopySrc);
    CHECK(gpu.writeBuffer(source, 0, bytes.data(), bytes.size()) == GpuStatus::Ok);

#ifdef TN_TEST_BUFFER_WRAP
    const int baseline = stagingAllocations;
#endif
    std::vector<uint8_t> warm;
    int warmCalls = 0;
    bool warmDone = false;
    CHECK(gpu.readBuffer(source, 0, size, [&](GpuStatus s, std::vector<uint8_t> out) {
        CHECK(s == GpuStatus::Ok);
        warm = std::move(out);
        ++warmCalls;
        warmDone = true;
    }) == GpuStatus::Ok);
    CHECK(!warmDone);  // never inside the call
    CHECK(pump(gpu, device.events, [&] { return warmDone; }));
    CHECK(warm == bytes);
    CHECK(warmCalls == 1);
#ifdef TN_TEST_BUFFER_WRAP
    CHECK(stagingAllocations == baseline + 1);  // the warm read allocated its lease
    const int warmed = stagingAllocations;
#endif

    for (int i = 0; i < 4; ++i) {
        std::vector<uint8_t> serial;
        int serialCalls = 0;
        bool serialDone = false;
        CHECK(gpu.readBuffer(source, 0, size, [&](GpuStatus s, std::vector<uint8_t> out) {
            CHECK(s == GpuStatus::Ok);
            serial = std::move(out);
            ++serialCalls;
            serialDone = true;
        }) == GpuStatus::Ok);
        CHECK(!serialDone);
        CHECK(pump(gpu, device.events, [&] { return serialDone; }));
        CHECK(serial == bytes);
        CHECK(serialCalls == 1);
    }
#ifdef TN_TEST_BUFFER_WRAP
    CHECK(stagingAllocations == warmed);  // no staging buffer after the warm read
#endif

    // Two reads in flight at once lease distinct buffers; both still deliver their bytes exactly once.
    std::vector<uint8_t> firstOverlap, secondOverlap;
    int overlapCalls = 0;
    bool firstDone = false, secondDone = false;
    CHECK(gpu.readBuffer(source, 0, size, [&](GpuStatus s, std::vector<uint8_t> out) {
        CHECK(s == GpuStatus::Ok);
        firstOverlap = std::move(out);
        ++overlapCalls;
        firstDone = true;
    }) == GpuStatus::Ok);
    CHECK(gpu.readBuffer(source, 0, size, [&](GpuStatus s, std::vector<uint8_t> out) {
        CHECK(s == GpuStatus::Ok);
        secondOverlap = std::move(out);
        ++overlapCalls;
        secondDone = true;
    }) == GpuStatus::Ok);
    CHECK(!firstDone && !secondDone);
    CHECK(pump(gpu, device.events, [&] { return firstDone && secondDone; }));
    CHECK(firstOverlap == bytes && secondOverlap == bytes);
    CHECK(overlapCalls == 2);
#ifdef TN_TEST_BUFFER_WRAP
    CHECK(stagingAllocations == warmed + 1);  // the second in-flight read cannot lease the mapped one
    const int smallReads = stagingAllocations;
#endif

    // A read of another size allocates once and then reuses that capacity, never the larger lease.
    for (int i = 0; i < 2; ++i) {
        std::vector<uint8_t> small;
        bool smallDone = false;
        CHECK(gpu.readBuffer(source, 0, 16, [&](GpuStatus s, std::vector<uint8_t> out) {
            CHECK(s == GpuStatus::Ok);
            small = std::move(out);
            smallDone = true;
        }) == GpuStatus::Ok);
        CHECK(pump(gpu, device.events, [&] { return smallDone; }));
        CHECK(small == std::vector<uint8_t>(bytes.begin(), bytes.begin() + 16));
    }
#ifdef TN_TEST_BUFFER_WRAP
    CHECK(stagingAllocations == smallReads + 1);
#endif

#ifdef TN_TEST_MAP_WRAP
    // A failed map releases its lease instead of pooling it: the next same-size read allocates again.
    const int beforeFailure = stagingAllocations;
    failNextMap = true;
    GpuStatus failedStatus = GpuStatus::Ok;
    std::vector<uint8_t> failedBytes(1, 0xaa);
    bool failed = false;
    CHECK(gpu.readBuffer(source, 0, 32, [&](GpuStatus s, std::vector<uint8_t> out) {
        failedStatus = s;
        failedBytes = std::move(out);
        failed = true;
    }) == GpuStatus::Ok);
    CHECK(pump(gpu, device.events, [&] { return failed; }));
    CHECK(failedStatus == GpuStatus::DeviceError);
    CHECK(failedBytes.empty());
    CHECK(stagingAllocations == beforeFailure + 1);

    std::vector<uint8_t> recovered;
    bool recoveredDone = false;
    CHECK(gpu.readBuffer(source, 0, 32, [&](GpuStatus s, std::vector<uint8_t> out) {
        CHECK(s == GpuStatus::Ok);
        recovered = std::move(out);
        recoveredDone = true;
    }) == GpuStatus::Ok);
    CHECK(pump(gpu, device.events, [&] { return recoveredDone; }));
    CHECK(recovered == std::vector<uint8_t>(bytes.begin(), bytes.begin() + 32));
    CHECK(stagingAllocations == beforeFailure + 2);
#endif

    // A table destroyed with a read in flight leaves that lease to the late callback: the bytes are
    // never delivered to the dead table and the callback must not touch its pool.
    int lateCalls = 0;
    {
        GpuResources dying(device.context.getInstance(), device.context.getDevice(), device.context.getQueue(),
                           device.events, 1);
        const Handle late = dying.createBuffer(size, WGPUBufferUsage_CopyDst | WGPUBufferUsage_CopySrc);
        CHECK(dying.writeBuffer(late, 0, bytes.data(), bytes.size()) == GpuStatus::Ok);
        CHECK(dying.readBuffer(late, 0, size, [&](GpuStatus, std::vector<uint8_t>) { ++lateCalls; }) == GpuStatus::Ok);
    }
    GpuResources survivor(device.context.getInstance(), device.context.getDevice(), device.context.getQueue(),
                          device.events, 1);
    for (int i = 0; i < 50; ++i) {
        survivor.poll();
        device.events.drain();
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    CHECK(lateCalls == 0);
}

TN_TEST_MAIN({"upload_readback", uploadReadback}, {"deferred_destroy", deferredDestroy}, {"async_only", asyncOnly}, {"gpu_thread_ordering", gpuThreadOrdering},
             {"lifetime_deferred_gpu", lifetimeDeferredGpu}, {"batched_submits", batchedSubmits},
             {"readback_reuses_staging", readbackReusesStaging})
