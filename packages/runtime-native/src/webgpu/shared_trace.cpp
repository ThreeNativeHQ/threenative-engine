#include "shared_trace.h"

#include <chrono>
#include <cstdlib>
#include <ctime>
#include <iostream>

#include "bindings_frame_stream.h"
#include "bindings_state.h"

#if defined(MYSTRAL_WEBGPU_DAWN) && defined(MYSTRAL_HAS_VULKAN_RT) && !defined(_WIN32)
#include <dirent.h>
#include <unistd.h>
#endif

namespace mystral::webgpu {

#if defined(MYSTRAL_WEBGPU_DAWN) && defined(MYSTRAL_HAS_VULKAN_RT) && !defined(_WIN32)

namespace {

constexpr uint32_t kCapacityRays = 1u << 20;
constexpr int32_t kLayoutGeneral = 1;  // VK_IMAGE_LAYOUT_GENERAL, the layout both images stay in
constexpr uint32_t kTexelBytes = 16;
constexpr uint32_t kRowBytes = rt::kSharedRowTexels * kTexelBytes;

struct Transport {
    BindingsState* state = nullptr;
    bool attached = false;
    std::string attachError;
    WGPUSharedTextureMemory raysMemory = nullptr;
    WGPUSharedTextureMemory hitsMemory = nullptr;
    WGPUTexture rays = nullptr;
    WGPUTexture hits = nullptr;
    // The two fences are imported once. Every trace signals them, and each WebGPU access waits on them once.
    WGPUSharedFence hitsReady = nullptr;  // the hit image holds the hits
    WGPUSharedFence raysFree = nullptr;   // the trace stopped reading the ray image
    bool raysFreePending = false;         // a trace signaled raysFree and no access has waited on it yet
    int hitsFreeFd = -1;                  // the WebGPU copy stopped reading the hit image
    std::string broken;                   // set when a failure left a semaphore signaled with no waiter
    uint32_t capacity = 0;
    uint64_t calls = 0;
    bool debug = false;
    double wallMs = 0;  // debug: summed wall time of the calls
    double cpuMs = 0;   // debug: summed time this thread ran, so a loaded host shows as wall minus cpu
};

Transport g;

uint32_t openFdCount() {
    uint32_t count = 0;
    if (DIR* dir = opendir("/proc/self/fd")) {
        while (readdir(dir) != nullptr) count += 1;
        closedir(dir);
    }
    return count;
}

double threadCpuMs() {
    timespec now = {};
    clock_gettime(CLOCK_THREAD_CPUTIME_ID, &now);
    return static_cast<double>(now.tv_sec) * 1e3 + static_cast<double>(now.tv_nsec) * 1e-6;
}

bool deviceHasFeatures(WGPUDevice device) {
    return wgpuDeviceHasFeature(device, WGPUFeatureName_SharedTextureMemoryOpaqueFD) != 0 &&
           wgpuDeviceHasFeature(device, WGPUFeatureName_SharedFenceVkSemaphoreOpaqueFD) != 0;
}

bool importImage(WGPUDevice device, const rt::SharedTraceImage& image, WGPUSharedTextureMemory& memory,
                 WGPUTexture& texture, std::string& error) {
    WGPUSharedTextureMemoryOpaqueFDDescriptor fd = WGPU_SHARED_TEXTURE_MEMORY_OPAQUE_FD_DESCRIPTOR_INIT;
    fd.vkImageCreateInfo = image.imageCreateInfo;
    fd.memoryFD = image.memoryFd;
    fd.memoryTypeIndex = image.memoryTypeIndex;
    fd.allocationSize = image.allocationSize;
    fd.dedicatedAllocation = image.dedicatedAllocation ? 1 : 0;
    WGPUSharedTextureMemoryDescriptor descriptor = WGPU_SHARED_TEXTURE_MEMORY_DESCRIPTOR_INIT;
    descriptor.nextInChain = &fd.chain;
    memory = wgpuDeviceImportSharedTextureMemory(device, &descriptor);
    if (!memory) {
        error = "wgpuDeviceImportSharedTextureMemory refused the image";
        return false;
    }

    WGPUTextureDescriptor textureDesc = WGPU_TEXTURE_DESCRIPTOR_INIT;
    textureDesc.usage = WGPUTextureUsage_CopySrc | WGPUTextureUsage_CopyDst;
    textureDesc.dimension = WGPUTextureDimension_2D;
    textureDesc.size = {image.width, image.height, 1};
    textureDesc.format = WGPUTextureFormat_RGBA32Float;
    textureDesc.mipLevelCount = 1;
    textureDesc.sampleCount = 1;
    texture = wgpuSharedTextureMemoryCreateTexture(memory, &textureDesc);
    if (!texture) {
        error = "wgpuSharedTextureMemoryCreateTexture refused the image";
        return false;
    }
    return true;
}

// Dawn duplicates the fd it imports, so the copy passed in is closed here.
WGPUSharedFence importFence(WGPUDevice device, int fd) {
    WGPUSharedFenceVkSemaphoreOpaqueFDDescriptor fdDescriptor = WGPU_SHARED_FENCE_VK_SEMAPHORE_OPAQUE_FD_DESCRIPTOR_INIT;
    fdDescriptor.handle = fd;
    WGPUSharedFenceDescriptor descriptor = WGPU_SHARED_FENCE_DESCRIPTOR_INIT;
    descriptor.nextInChain = &fdDescriptor.chain;
    WGPUSharedFence fence = wgpuDeviceImportSharedFence(device, &descriptor);
    close(fd);
    return fence;
}

bool beginAccess(WGPUSharedTextureMemory memory, WGPUTexture texture, WGPUSharedFence wait) {
    WGPUSharedTextureMemoryVkImageLayoutBeginState layout = WGPU_SHARED_TEXTURE_MEMORY_VK_IMAGE_LAYOUT_BEGIN_STATE_INIT;
    layout.oldLayout = kLayoutGeneral;
    layout.newLayout = kLayoutGeneral;
    const uint64_t signaled = 1;
    WGPUSharedTextureMemoryBeginAccessDescriptor begin = WGPU_SHARED_TEXTURE_MEMORY_BEGIN_ACCESS_DESCRIPTOR_INIT;
    begin.nextInChain = &layout.chain;
    begin.initialized = 1;
    begin.concurrentRead = 0;
    begin.fenceCount = wait ? 1 : 0;
    begin.fences = wait ? &wait : nullptr;
    begin.signaledValues = wait ? &signaled : nullptr;
    return wgpuSharedTextureMemoryBeginAccess(memory, texture, &begin) == WGPUStatus_Success;
}

// Returns the fd of the fence that signals when the WebGPU work on the texture is done, as a
// duplicate that the caller owns. -1 means the access ended with no fence or with an error.
int endAccess(WGPUSharedTextureMemory memory, WGPUTexture texture, std::string& error) {
    WGPUSharedTextureMemoryVkImageLayoutEndState layout = WGPU_SHARED_TEXTURE_MEMORY_VK_IMAGE_LAYOUT_END_STATE_INIT;
    WGPUSharedTextureMemoryEndAccessState end = WGPU_SHARED_TEXTURE_MEMORY_END_ACCESS_STATE_INIT;
    end.nextInChain = &layout.chain;
    if (wgpuSharedTextureMemoryEndAccess(memory, texture, &end) != WGPUStatus_Success) {
        error = "wgpuSharedTextureMemoryEndAccess failed";
        return -1;
    }
    if (g.debug && g.calls == 0) {
        std::cerr << "[SharedTrace] end access: layout " << layout.oldLayout << " -> " << layout.newLayout
                  << ", fences " << end.fenceCount << std::endl;
    }
    int fd = -1;
    if (end.fenceCount == 1) {
        WGPUSharedFenceVkSemaphoreOpaqueFDExportInfo fdInfo = WGPU_SHARED_FENCE_VK_SEMAPHORE_OPAQUE_FD_EXPORT_INFO_INIT;
        WGPUSharedFenceExportInfo info = WGPU_SHARED_FENCE_EXPORT_INFO_INIT;
        info.nextInChain = &fdInfo.chain;
        wgpuSharedFenceExportInfo(end.fences[0], &info);
        if (info.type == WGPUSharedFenceType_VkSemaphoreOpaqueFD && fdInfo.handle >= 0) {
            fd = dup(fdInfo.handle);
        }
        if (fd < 0) error = "the WebGPU fence did not export an opaque fd";
    } else if (end.fenceCount > 1) {
        error = "the WebGPU access ended with " + std::to_string(end.fenceCount) + " fences, and the transport takes one";
    }
    // Dawn closes the fd it exported when the state frees its fence, so the caller owns the duplicate.
    wgpuSharedTextureMemoryEndAccessStateFreeMembers(end);
    return fd;
}

// Copies `texels` RGBA32F texels between a buffer and the shared image: full rows, then one partial row.
template <typename Encode>
bool submitCopies(WGPUDevice device, WGPUQueue queue, uint32_t texels, Encode encode) {
    WGPUCommandEncoderDescriptor encoderDesc = {};
    WGPUCommandEncoder encoder = wgpuDeviceCreateCommandEncoder(device, &encoderDesc);
    if (!encoder) return false;
    const uint32_t fullRows = texels / rt::kSharedRowTexels;
    const uint32_t remainder = texels % rt::kSharedRowTexels;
    if (fullRows > 0) encode(encoder, 0u, 0u, rt::kSharedRowTexels, fullRows);
    if (remainder > 0) encode(encoder, fullRows * kRowBytes, fullRows, remainder, 1u);
    WGPUCommandBufferDescriptor commandDesc = {};
    WGPUCommandBuffer commands = wgpuCommandEncoderFinish(encoder, &commandDesc);
    wgpuCommandEncoderRelease(encoder);
    if (!commands) return false;
    wgpuQueueSubmit(queue, 1, &commands);
    wgpuCommandBufferRelease(commands);
    return true;
}

void releaseObjects() {
    if (g.hitsReady) wgpuSharedFenceRelease(g.hitsReady);
    if (g.raysFree) wgpuSharedFenceRelease(g.raysFree);
    if (g.rays) wgpuTextureRelease(g.rays);
    if (g.hits) wgpuTextureRelease(g.hits);
    if (g.raysMemory) wgpuSharedTextureMemoryRelease(g.raysMemory);
    if (g.hitsMemory) wgpuSharedTextureMemoryRelease(g.hitsMemory);
    if (g.hitsFreeFd >= 0) close(g.hitsFreeFd);
    g.hitsReady = g.raysFree = nullptr;
    g.raysFreePending = false;
    g.rays = g.hits = nullptr;
    g.raysMemory = g.hitsMemory = nullptr;
    g.hitsFreeFd = -1;
    g.attached = false;
}

bool attach(rt::IRTBackend& backend) {
    if (g.attached) return true;
    if (!g.attachError.empty()) return false;
    auto fail = [&](const std::string& message) {
        g.attachError = message;
        releaseObjects();
        backend.destroySharedTrace();
        return false;
    };
    if (!g.state || !g.state->device) return fail("the WebGPU device is not ready");
    if (!deviceHasFeatures(g.state->device)) {
        return fail("the WebGPU device lacks the shared-texture-memory-opaque-fd or shared-fence-vk-semaphore-opaque-fd feature");
    }

    rt::SharedTraceSetup setup = backend.createSharedTrace(kCapacityRays);
    if (!setup.ok) return fail(setup.error);
    std::string error;
    auto failWithFds = [&](const std::string& message) {
        if (setup.signalHitsFd >= 0) close(setup.signalHitsFd);
        if (setup.signalRaysFd >= 0) close(setup.signalRaysFd);
        return fail(message);
    };
    if (!importImage(g.state->device, setup.rays, g.raysMemory, g.rays, error)) {
        return failWithFds("ray image: " + error);
    }
    if (!importImage(g.state->device, setup.hits, g.hitsMemory, g.hits, error)) {
        return failWithFds("hit image: " + error);
    }
    g.hitsReady = importFence(g.state->device, setup.signalHitsFd);
    g.raysFree = importFence(g.state->device, setup.signalRaysFd);
    if (!g.hitsReady || !g.raysFree) return fail("importing the trace fences into the WebGPU device failed");
    g.capacity = setup.capacityRays;
    g.debug = std::getenv("TN_RT_SHARED_DEBUG") != nullptr;
    g.attached = true;
    if (g.debug) std::cerr << "[SharedTrace] attached, capacity " << g.capacity << " rays" << std::endl;
    return true;
}

}  // namespace

void setSharedTraceState(BindingsState* state) {
    g.state = state;
}

SharedTraceStatus sharedTraceStatus() {
    SharedTraceStatus status;
    if (!g.state || !g.state->device) {
        status.reason = "the WebGPU device is not ready";
    } else if (!deviceHasFeatures(g.state->device)) {
        status.reason = "the WebGPU device lacks the shared-texture-memory-opaque-fd or shared-fence-vk-semaphore-opaque-fd feature";
    } else if (!g.attachError.empty()) {
        status.reason = g.attachError;
    } else {
        status.available = true;
    }
    return status;
}

GpuTraceResult traceRayBatchOnGpu(rt::IRTBackend& backend, rt::RTTLASHandle tlas, uint64_t raysBufferId,
                                  uint64_t hitsBufferId, uint32_t rayCount) {
    const auto started = std::chrono::steady_clock::now();
    const double cpuStarted = threadCpuMs();
    GpuTraceResult result;
    auto fail = [&](const std::string& message) {
        result.ok = false;
        result.error = message;
        return result;
    };
    if (!g.state) return fail("the WebGPU bindings are not ready");
    if (!g.broken.empty()) return fail(g.broken);
    if (!attach(backend)) return fail(g.attachError);
    if (rayCount == 0 || rayCount > g.capacity) {
        return fail("rayCount " + std::to_string(rayCount) + " is outside 1 to the shared capacity of " +
                    std::to_string(g.capacity) + " rays");
    }

    // `queue.submit` is recorded, not executed. Replay it, so the buffer holds the rays the game wrote.
    if (!flushRecordedFrameOps(g.state)) return fail("replaying the recorded WebGPU work failed");
    flushUploadStaging(g.state);

    const auto raysIt = g.state->registries.bufferRegistry.find(raysBufferId);
    const auto hitsIt = g.state->registries.bufferRegistry.find(hitsBufferId);
    if (raysIt == g.state->registries.bufferRegistry.end() || !raysIt->second.buffer) {
        return fail("rays is not a live GPUBuffer");
    }
    if (hitsIt == g.state->registries.bufferRegistry.end() || !hitsIt->second.buffer) {
        return fail("hits is not a live GPUBuffer");
    }
    const uint64_t rayBytes = static_cast<uint64_t>(rayCount) * rt::kRayWords * sizeof(float);
    const uint64_t hitBytes = static_cast<uint64_t>(rayCount) * rt::kHitWords * sizeof(uint32_t);
    if (raysIt->second.size < rayBytes || !(raysIt->second.usage & WGPUBufferUsage_CopySrc)) {
        return fail("rays needs " + std::to_string(rayBytes) + " bytes and the CopySrc usage");
    }
    if (hitsIt->second.size < hitBytes || !(hitsIt->second.usage & WGPUBufferUsage_CopyDst)) {
        return fail("hits needs " + std::to_string(hitBytes) + " bytes and the CopyDst usage");
    }
    WGPUBuffer raysBuffer = raysIt->second.buffer;
    WGPUBuffer hitsBuffer = hitsIt->second.buffer;
    WGPUDevice device = g.state->device;
    WGPUQueue queue = g.state->queue;

    // From here a failure can leave a semaphore signaled with no waiter, so the transport stops.
    auto stop = [&](const std::string& message) {
        g.broken = message + " (the shared trace is off until the host restarts)";
        return fail(g.broken);
    };

    // 1. The WebGPU device copies the rays into the shared ray image, once the last trace left it.
    if (!beginAccess(g.raysMemory, g.rays, g.raysFreePending ? g.raysFree : nullptr)) {
        return stop("beginning the ray image access failed");
    }
    g.raysFreePending = false;
    const bool raysCopied = submitCopies(
        device, queue, rayCount * 2,
        [&](WGPUCommandEncoder encoder, uint32_t offset, uint32_t row, uint32_t width, uint32_t height) {
            WGPUImageCopyBuffer_Compat source = {};
            source.buffer = raysBuffer;
            source.layout.offset = offset;
            source.layout.bytesPerRow = kRowBytes;
            source.layout.rowsPerImage = height;
            WGPUImageCopyTexture_Compat target = {};
            target.texture = g.rays;
            target.origin = {0, row, 0};
            target.aspect = WGPUTextureAspect_All;
            const WGPUExtent3D size = {width, height, 1};
            wgpuCommandEncoderCopyBufferToTexture(encoder, &source, &target, &size);
        });
    std::string error;
    const int raysReadyFd = endAccess(g.raysMemory, g.rays, error);
    if (!raysCopied || raysReadyFd < 0) {
        return stop(error.empty() ? "copying the rays into the shared image failed" : error);
    }

    // 2. The ray tracing device traces them. It waits on the GPU, not on this thread.
    rt::SharedTraceOptions options;
    options.tlas = tlas;
    options.rayCount = rayCount;
    options.waitRaysFd = raysReadyFd;
    options.waitHitsFd = g.hitsFreeFd;
    g.hitsFreeFd = -1;
    const rt::SharedTraceResult traced = backend.traceShared(options);
    if (!traced.ok) return stop(traced.error);
    g.raysFreePending = true;

    // 3. The WebGPU device copies the hits out of the shared hit image, once the trace signals.
    if (!beginAccess(g.hitsMemory, g.hits, g.hitsReady)) return stop("beginning the hit image access failed");
    const bool hitsCopied = submitCopies(
        device, queue, rayCount,
        [&](WGPUCommandEncoder encoder, uint32_t offset, uint32_t row, uint32_t width, uint32_t height) {
            WGPUImageCopyTexture_Compat source = {};
            source.texture = g.hits;
            source.origin = {0, row, 0};
            source.aspect = WGPUTextureAspect_All;
            WGPUImageCopyBuffer_Compat target = {};
            target.buffer = hitsBuffer;
            target.layout.offset = offset;
            target.layout.bytesPerRow = kRowBytes;
            target.layout.rowsPerImage = height;
            const WGPUExtent3D size = {width, height, 1};
            wgpuCommandEncoderCopyTextureToBuffer(encoder, &source, &target, &size);
        });
    g.hitsFreeFd = endAccess(g.hitsMemory, g.hits, error);
    if (!hitsCopied || g.hitsFreeFd < 0) {
        return stop(error.empty() ? "copying the hits out of the shared image failed" : error);
    }

    g.calls += 1;
    if (g.debug && (g.calls == 1 || g.calls == 50 || g.calls == 200)) {
        std::cerr << "[SharedTrace] call " << g.calls << ", open fds " << openFdCount() << std::endl;
    }
    result.ok = true;
    result.totalMs =
        std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
    result.cpuMs = threadCpuMs() - cpuStarted;
    if (g.debug && g.calls > 1) {  // the first call also builds the images
        g.wallMs += result.totalMs;
        g.cpuMs += result.cpuMs;
        if (g.calls % 100 == 0) {
            std::cerr << "[SharedTrace] per call over " << g.calls - 1 << " calls: wall " << g.wallMs / (g.calls - 1)
                      << " ms, thread cpu " << g.cpuMs / (g.calls - 1) << " ms" << std::endl;
        }
    }
    return result;
}

void releaseSharedTrace() {
    releaseObjects();
    g.attachError.clear();
}

#else  // no Dawn host with the Vulkan ray tracing backend

void setSharedTraceState(BindingsState*) {}

SharedTraceStatus sharedTraceStatus() {
    SharedTraceStatus status;
    status.reason = "this host has no Dawn device with the Vulkan ray tracing backend";
    return status;
}

GpuTraceResult traceRayBatchOnGpu(rt::IRTBackend&, rt::RTTLASHandle, uint64_t, uint64_t, uint32_t) {
    GpuTraceResult result;
    result.error = sharedTraceStatus().reason;
    return result;
}

void releaseSharedTrace() {}

#endif

}  // namespace mystral::webgpu
