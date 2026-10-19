/** WebGPU buffer, texture, view, and sampler resources. */

#include "bindings_frame_stream.h"
#include "bindings_handler_helpers.h"
#include "bindings_resources.h"
#include "bindings_state.h"
#include "surface_texture_transaction.h"
#include "mystral/stall_budget.h"
#include "mystral/webgpu/bindings.h"
#include "mystral/webgpu/checked_handle.h"
#include "mystral/webgpu/wrapper_factories.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <iostream>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#if defined(MYSTRAL_WEBGPU_WGPU) || defined(MYSTRAL_WEBGPU_DAWN)
#include <webgpu/webgpu.h>

#if defined(MYSTRAL_WEBGPU_WGPU)
#if __has_include(<webgpu/wgpu.h>)
#include <webgpu/wgpu.h>
#else
#include <wgpu/wgpu.h>
#endif
#endif
#include "mystral/webgpu_compat.h"
#endif

namespace mystral {
namespace webgpu {
#if defined(MYSTRAL_WEBGPU_WGPU) || defined(MYSTRAL_WEBGPU_DAWN)

// GPU texture accounting. Nothing in this runtime has ever reported how much texture memory a
// game holds, so "the process is using 1.6 GB" has never had an answer inside the engine — it had
// to be inferred from `dumpsys meminfo` and guesswork. Every texture this binding creates is
// measured here and reported beside the present tick, keyed by dimensions and format so a
// full-screen render target is distinguishable from an author's 1024x1024 albedo map.
/**
 * Bytes per texel for the formats this runtime actually creates.
 *
 * Deliberately keyed on the WebGPU format *string* rather than the enum: `createTexture` already
 * holds the string, the set is small, and an unknown format reports 4 rather than inventing a
 * number that would make the total silently wrong. Compressed formats are block-based and report
 * their per-texel average.
 */
static double textureBytesPerTexel(const std::string& format) {
    if (format.rfind("bc", 0) == 0 || format.rfind("etc2", 0) == 0 || format.rfind("astc", 0) == 0 ||
        format.rfind("eac", 0) == 0) {
        // ETC2/BC1-class formats are 0.5 bytes/texel; BC3/BC7/ASTC-4x4-class are 1.0. The suffix
        // that distinguishes them is the block size, so read it rather than assume.
        if (format.find("rgba8unorm") != std::string::npos || format.find("bc3") != std::string::npos ||
            format.find("bc7") != std::string::npos || format.find("astc-4x4") != std::string::npos)
            return 1.0;
        return 0.5;
    }
    if (format.find("32float") != std::string::npos || format.find("32uint") != std::string::npos ||
        format.find("32sint") != std::string::npos) {
        if (format.rfind("rgba", 0) == 0) return 16.0;
        if (format.rfind("rg", 0) == 0) return 8.0;
        return 4.0;
    }
    if (format.find("16float") != std::string::npos || format.find("16uint") != std::string::npos ||
        format.find("16sint") != std::string::npos || format.find("16unorm") != std::string::npos) {
        if (format.rfind("rgba", 0) == 0) return 8.0;
        if (format.rfind("rg", 0) == 0) return 4.0;
        return 2.0;
    }
    if (format.rfind("depth32float", 0) == 0) return format.find("stencil") != std::string::npos ? 5.0 : 4.0;
    if (format.rfind("depth24", 0) == 0) return 4.0;
    if (format.rfind("depth16", 0) == 0) return 2.0;
    if (format.rfind("r8", 0) == 0) return 1.0;
    if (format.rfind("rg8", 0) == 0) return 2.0;
    if (format.rfind("rgb10a2", 0) != std::string::npos && format.rfind("rgb10a2", 0) == 0) return 4.0;
    if (format.rfind("rg11b10", 0) == 0) return 4.0;
    return 4.0;
}

/** Records one created texture. `mips` is the declared level count, never a guess. */
static void recordTextureCreated(BindingsState* state, uint32_t width, uint32_t height, uint32_t layers, uint32_t mips,
                                 uint32_t sampleCount, const std::string& format) {
    const double perTexel = textureBytesPerTexel(format);
    double texels = 0.0;
    for (uint32_t level = 0; level < (mips == 0 ? 1u : mips); level += 1) {
        const double w = std::max(1.0, std::floor(static_cast<double>(width) / std::pow(2.0, level)));
        const double h = std::max(1.0, std::floor(static_cast<double>(height) / std::pow(2.0, level)));
        texels += w * h;
    }
    const uint64_t bytes = static_cast<uint64_t>(
        texels * static_cast<double>(layers == 0 ? 1u : layers) *
        static_cast<double>(sampleCount == 0 ? 1u : sampleCount) * perTexel);
    state->profiling.textureBytesLive += bytes;
    state->profiling.textureBytesCreated += bytes;
    state->profiling.textureCountLive += 1;
    std::ostringstream key;
    key << width << "x" << height;
    if (layers > 1) key << "x" << layers;
    key << " " << format;
    if (mips > 1) key << " mips" << mips;
    if (sampleCount > 1) key << " msaa" << sampleCount;
    auto& bucket = state->profiling.textureBuckets[key.str()];
    bucket.first += 1;
    bucket.second += bytes;
}

// Buffer accounting, for the same reason as textures: a game's GPU footprint is textures plus
// buffers, and reporting only one half turns "the rest" into guesswork. Bucketed by usage bits so
// vertex/index geometry is distinguishable from per-object uniform churn.
/** Names the usage bits that matter for attribution; anything else reports its raw mask. */
static std::string bufferUsageLabel(uint32_t usage) {
    std::string label;
    if (usage & WGPUBufferUsage_Vertex) label += "vertex|";
    if (usage & WGPUBufferUsage_Index) label += "index|";
    if (usage & WGPUBufferUsage_Uniform) label += "uniform|";
    if (usage & WGPUBufferUsage_Storage) label += "storage|";
    if (usage & WGPUBufferUsage_Indirect) label += "indirect|";
    if (usage & WGPUBufferUsage_CopySrc) label += "copysrc|";
    if (usage & WGPUBufferUsage_CopyDst) label += "copydst|";
    if (usage & WGPUBufferUsage_MapRead) label += "mapread|";
    if (usage & WGPUBufferUsage_MapWrite) label += "mapwrite|";
    if (label.empty()) return "other";
    label.pop_back();
    return label;
}

static void recordBufferCreated(BindingsState* state, uint64_t size, uint32_t usage) {
    state->profiling.bufferBytesLive += size;
    state->profiling.bufferCountLive += 1;
    auto& bucket = state->profiling.bufferBuckets[bufferUsageLabel(usage)];
    bucket.first += 1;
    bucket.second += size;
}
static std::shared_ptr<BufferMapRequest> takeBufferMapRequest(void* userdata) {
    auto* holder = static_cast<std::shared_ptr<BufferMapRequest>*>(userdata);
    if (holder == nullptr) return {};
    auto request = std::move(*holder);
    delete holder;
    return request;
}

static void completeBufferMap(
    std::shared_ptr<BufferMapRequest> request,
    WGPUBufferMapAsyncStatus_Compat status,
    const char* message = nullptr,
    size_t messageLength = 0) {
    if (!request) return;
    {
        std::lock_guard<std::mutex> lock(request->waitMutex);
        request->status = status;
        if (message != nullptr && messageLength > 0) {
            request->errorMessage.assign(message, messageLength);
        }
        request->completed = true;
    }
}

#if WGPU_BUFFER_MAP_USES_CALLBACK_INFO
// Dawn buffer map callback (4 params). The callback never enters JavaScript; it only records the
// result in a request that `pollEvents()` settles on the game thread.
static void onBufferMapped(
    WGPUMapAsyncStatus status, WGPUStringView message, void* userdata1, void* /*userdata2*/) {
    const auto request = takeBufferMapRequest(userdata1);
    const size_t messageLength = message.length == WGPU_STRLEN
        ? (message.data == nullptr ? 0 : std::strlen(message.data))
        : message.length;
    completeBufferMap(request, status, message.data, messageLength);
}
#else
// wgpu-native buffer map callback (2 params).
static void onBufferMapped(WGPUBufferMapAsyncStatus status, void* userdata) {
    completeBufferMap(takeBufferMapRequest(userdata), status);
}
#endif

static js::JSValueHandle bufferMapSettler(BindingsState* state) {
    return state->engine->getGlobalProperty("__tnBufferMapSettle");
}

static void settleBufferMapPromise(
    BindingsState* state,
    js::JSValueHandle settle,
    const std::shared_ptr<BufferMapRequest>& request,
    bool success,
    const std::string& error) {
    js::JSValueGuard thisArg(*state->engine, state->engine->newUndefined());
    js::JSValueGuard id(
        *state->engine, state->engine->newNumber(static_cast<double>(request->requestId)));
    js::JSValueGuard result(*state->engine, state->engine->newBoolean(success));
    js::JSValueGuard message(
        *state->engine,
        success ? state->engine->newUndefined() : state->engine->newString(error.c_str()));
    js::JSValueGuard ignored(
        *state->engine,
        state->engine->call(settle, thisArg.get(), {id.get(), result.get(), message.get()}));
}

static js::JSValueHandle pendingBufferMapPromise(
    BindingsState* state, uint64_t requestId) {
    js::JSValueGuard pending(*state->engine, state->engine->getGlobalProperty("__tnBufferMapPending"));
    if (!pending || !state->engine->isFunction(pending.get())) {
        state->engine->throwException(
            "async buffer mapping is not installed (__tnBufferMapPending missing)");
        return state->engine->newUndefined();
    }
    js::JSValueGuard thisArg(*state->engine, state->engine->newUndefined());
    js::JSValueGuard id(
        *state->engine, state->engine->newNumber(static_cast<double>(requestId)));
    return state->engine->call(pending.get(), thisArg.get(), {id.get()});
}

static void pollBufferMapCallbacks(BindingsState* state) {
#if defined(MYSTRAL_WEBGPU_WGPU)
    if (state->device) wgpuDevicePoll(state->device, false, nullptr);
#else
    if (state->instance) wgpuInstanceProcessEvents(state->instance);
    if (state->device) wgpuDeviceTick(state->device);
#endif
}

static std::vector<std::shared_ptr<BufferMapRequest>> removeBufferMapRequests(
    BindingsState* state, uint64_t bufferId) {
    std::vector<std::shared_ptr<BufferMapRequest>> removed;
    std::lock_guard<std::mutex> lock(state->asyncBufferMaps.mutex);
    for (auto it = state->asyncBufferMaps.pending.begin();
         it != state->asyncBufferMaps.pending.end();) {
        if (it->second->bufferId != bufferId) {
            ++it;
            continue;
        }
        removed.push_back(it->second);
        it = state->asyncBufferMaps.pending.erase(it);
    }
    return removed;
}

static void rejectBufferMapRequests(
    BindingsState* state,
    const std::vector<std::shared_ptr<BufferMapRequest>>& requests,
    const char* error) {
    if (requests.empty() || state == nullptr || state->engine == nullptr) return;
    js::JSValueGuard settle(*state->engine, bufferMapSettler(state));
    if (!settle || !state->engine->isFunction(settle.get())) return;
    for (const auto& request : requests) {
        settleBufferMapPromise(state, settle.get(), request, false, error);
    }
}

static void startBufferMapRequest(const std::shared_ptr<BufferMapRequest>& request) {
    request->started = true;
#if WGPU_BUFFER_MAP_USES_CALLBACK_INFO
    WGPUBufferMapCallbackInfo info = {};
    info.mode = WGPUCallbackMode_AllowSpontaneous;
    info.callback = onBufferMapped;
    info.userdata1 = new std::shared_ptr<BufferMapRequest>(request);
    wgpuBufferMapAsync(request->buffer, request->mode, request->offset, request->size, info);
#else
    wgpuBufferMapAsync(request->buffer, request->mode, request->offset, request->size,
                      onBufferMapped, new std::shared_ptr<BufferMapRequest>(request));
#endif
}

void startDeferredBufferMaps(BindingsState* state) {
    std::vector<std::shared_ptr<BufferMapRequest>> requests;
    {
        std::lock_guard<std::mutex> lock(state->asyncBufferMaps.mutex);
        for (const auto& entry : state->asyncBufferMaps.pending)
            if (!entry.second->started) requests.push_back(entry.second);
    }
    for (const auto& request : requests) startBufferMapRequest(request);
}

void drainAsyncBufferMaps(BindingsState* state) {
    if (state == nullptr || state->engine == nullptr) return;
    {
        std::lock_guard<std::mutex> lock(state->asyncBufferMaps.mutex);
        if (state->asyncBufferMaps.pending.empty()) return;
    }

    js::JSValueGuard settle(*state->engine, bufferMapSettler(state));
    if (!settle || !state->engine->isFunction(settle.get())) return;
    pollBufferMapCallbacks(state);

    std::vector<std::shared_ptr<BufferMapRequest>> completed;
    {
        std::lock_guard<std::mutex> lock(state->asyncBufferMaps.mutex);
        for (auto it = state->asyncBufferMaps.pending.begin();
             it != state->asyncBufferMaps.pending.end();) {
            std::lock_guard<std::mutex> requestLock(it->second->waitMutex);
            if (!it->second->completed) {
                ++it;
                continue;
            }
            completed.push_back(it->second);
            it = state->asyncBufferMaps.pending.erase(it);
        }
    }

    for (const auto& request : completed) {
        WGPUBufferMapAsyncStatus_Compat status;
        std::string error;
        {
            std::lock_guard<std::mutex> lock(request->waitMutex);
            status = request->status;
            error = request->errorMessage;
        }
        auto buffer = state->registries.bufferRegistry.find(request->bufferId);
        const bool success = status == WGPUBufferMapAsyncStatus_Success_Compat &&
                             buffer != state->registries.bufferRegistry.end();
        if (buffer != state->registries.bufferRegistry.end()) {
            buffer->second.mapPending = false;
            if (success) {
                buffer->second.isMapped = true;
                buffer->second.mapMode = request->mode;
            }
        }
        if (!success && error.empty()) error = "Buffer map failed";
        settleBufferMapPromise(state, settle.get(), request, success, error);
    }
}

void shutdownAsyncBufferMaps(BindingsState* state) {
    if (state == nullptr) return;
    std::vector<std::shared_ptr<BufferMapRequest>> pending;
    {
        std::lock_guard<std::mutex> lock(state->asyncBufferMaps.mutex);
        state->asyncBufferMaps.stopping = true;
        for (const auto& entry : state->asyncBufferMaps.pending) pending.push_back(entry.second);
        state->asyncBufferMaps.pending.clear();
    }
    rejectBufferMapRequests(state, pending, "Buffer map cancelled during shutdown");
    for (const auto& request : pending) {
        auto buffer = state->registries.bufferRegistry.find(request->bufferId);
        if (buffer != state->registries.bufferRegistry.end()) {
            wgpuBufferUnmap(buffer->second.buffer);
            buffer->second.mapPending = false;
        }
    }
    // Deliver cancellation callbacks without waiting for GPU work. A late callback owns only
    // its shared request, never the bindings state or the JavaScript engine.
    pollBufferMapCallbacks(state);
}

/**
 * Convert texture format enum to string
 */
const char* formatToString(WGPUTextureFormat format) {
    switch (format) {
        case WGPUTextureFormat_BGRA8Unorm: return "bgra8unorm";
        case WGPUTextureFormat_BGRA8UnormSrgb: return "bgra8unorm-srgb";
        case WGPUTextureFormat_RGBA8Unorm: return "rgba8unorm";
        case WGPUTextureFormat_RGBA8UnormSrgb: return "rgba8unorm-srgb";
        case WGPUTextureFormat_R8Unorm: return "r8unorm";
        case WGPUTextureFormat_RG8Unorm: return "rg8unorm";
        case WGPUTextureFormat_R16Float: return "r16float";
        case WGPUTextureFormat_RG16Float: return "rg16float";
        case WGPUTextureFormat_R32Float: return "r32float";
        case WGPUTextureFormat_RG32Float: return "rg32float";
        case WGPUTextureFormat_RGBA16Float: return "rgba16float";
        case WGPUTextureFormat_RGBA32Float: return "rgba32float";
        // Integer formats. three.js reaches for these whenever it stores indices rather than
        // colour in a texture — `BatchedMesh` keeps its per-draw indirection in an `r32uint`
        // texture — and a renderer that cannot name them cannot render a batch.
        case WGPUTextureFormat_R8Uint: return "r8uint";
        case WGPUTextureFormat_R8Sint: return "r8sint";
        case WGPUTextureFormat_RG8Uint: return "rg8uint";
        case WGPUTextureFormat_RG8Sint: return "rg8sint";
        case WGPUTextureFormat_RGBA8Uint: return "rgba8uint";
        case WGPUTextureFormat_RGBA8Sint: return "rgba8sint";
        case WGPUTextureFormat_R16Uint: return "r16uint";
        case WGPUTextureFormat_R16Sint: return "r16sint";
        case WGPUTextureFormat_RG16Uint: return "rg16uint";
        case WGPUTextureFormat_RG16Sint: return "rg16sint";
        case WGPUTextureFormat_RGBA16Uint: return "rgba16uint";
        case WGPUTextureFormat_RGBA16Sint: return "rgba16sint";
        case WGPUTextureFormat_R32Uint: return "r32uint";
        case WGPUTextureFormat_R32Sint: return "r32sint";
        case WGPUTextureFormat_RG32Uint: return "rg32uint";
        case WGPUTextureFormat_RG32Sint: return "rg32sint";
        case WGPUTextureFormat_RGBA32Uint: return "rgba32uint";
        case WGPUTextureFormat_RGBA32Sint: return "rgba32sint";
        case WGPUTextureFormat_R8Snorm: return "r8snorm";
        case WGPUTextureFormat_RG8Snorm: return "rg8snorm";
        case WGPUTextureFormat_RGBA8Snorm: return "rgba8snorm";
        case WGPUTextureFormat_RGB10A2Unorm: return "rgb10a2unorm";
        case WGPUTextureFormat_RG11B10Ufloat: return "rg11b10ufloat";
        case WGPUTextureFormat_Depth24Plus: return "depth24plus";
        case WGPUTextureFormat_Depth24PlusStencil8: return "depth24plus-stencil8";
        case WGPUTextureFormat_Depth32Float: return "depth32float";
        default: return "bgra8unorm";  // Default
    }
}

static uint64_t textureMetricBytes(const TextureInfo& info) {
    const double perTexel = textureBytesPerTexel(formatToString(info.format));
    double texels = 0.0;
    for (uint32_t level = 0; level < (info.mipLevelCount == 0 ? 1u : info.mipLevelCount);
         level += 1) {
        const double width = std::max(
            1.0, std::floor(static_cast<double>(info.width) / std::pow(2.0, level)));
        const double height = std::max(
            1.0, std::floor(static_cast<double>(info.height) / std::pow(2.0, level)));
        texels += width * height;
    }
    return static_cast<uint64_t>(
        texels * static_cast<double>(info.depthOrArrayLayers == 0 ? 1u : info.depthOrArrayLayers) *
        static_cast<double>(info.sampleCount == 0 ? 1u : info.sampleCount) * perTexel);
}

static std::string textureMetricBucket(const TextureInfo& info) {
    std::ostringstream key;
    key << info.width << "x" << info.height;
    if (info.depthOrArrayLayers > 1) key << "x" << info.depthOrArrayLayers;
    key << " " << formatToString(info.format);
    if (info.mipLevelCount > 1) key << " mips" << info.mipLevelCount;
    if (info.sampleCount > 1) key << " msaa" << info.sampleCount;
    return key.str();
}

static void recordTextureDestroyed(BindingsState* state, const TextureInfo& info) {
    if (!info.accounted) return;
    const uint64_t bytes = textureMetricBytes(info);
    state->profiling.textureBytesLive =
        state->profiling.textureBytesLive >= bytes ? state->profiling.textureBytesLive - bytes : 0;
    if (state->profiling.textureCountLive > 0)
        state->profiling.textureCountLive -= 1;
    const std::string bucketKey = textureMetricBucket(info);
    auto bucket = state->profiling.textureBuckets.find(bucketKey);
    if (bucket != state->profiling.textureBuckets.end()) {
        if (bucket->second.first > 0) bucket->second.first -= 1;
        bucket->second.second = bucket->second.second >= bytes
            ? bucket->second.second - bytes
            : 0;
        if (bucket->second.first == 0)
            state->profiling.textureBuckets.erase(bucket);
    }
}

static void recordBufferDestroyed(BindingsState* state, const BufferInfo& info) {
#if TN_ANDROID_JS_PROFILE
    state->registries.androidJsProfileBufferRegistry.erase(info.buffer);
#endif
    if (!info.accounted) return;
    state->profiling.bufferBytesLive =
        state->profiling.bufferBytesLive >= info.size ? state->profiling.bufferBytesLive - info.size : 0;
    if (state->profiling.bufferCountLive > 0)
        state->profiling.bufferCountLive -= 1;
    const std::string bucketKey = bufferUsageLabel(static_cast<uint32_t>(info.usage));
    auto bucket = state->profiling.bufferBuckets.find(bucketKey);
    if (bucket != state->profiling.bufferBuckets.end()) {
        if (bucket->second.first > 0) bucket->second.first -= 1;
        bucket->second.second = bucket->second.second >= info.size
            ? bucket->second.second - info.size
            : 0;
        if (bucket->second.first == 0)
            state->profiling.bufferBuckets.erase(bucket);
    }
}

void releaseTextureRegistryEntry(BindingsState* state, uint64_t textureId) {
    if (!state) return;
    const auto it = state->registries.textureRegistry.find(textureId);
    if (it == state->registries.textureRegistry.end())
        return;
    const TextureInfo info = it->second;
    state->registries.textureRegistry.erase(it);
    recordTextureDestroyed(state, info);
    if (state->presentation.currentSurfaceTextureId == textureId)
        state->presentation.currentSurfaceTextureId = 0;
    if (info.ownsTexture && info.texture) {
        wgpuTextureDestroy(info.texture);
        wgpuTextureRelease(info.texture);
    }
    if (state->registries.nextTextureId == textureId + 1)
        state->registries.nextTextureId = textureId;
}

static const TextureInfo* findTextureInfoByHandle(
    const BindingsState* state, WGPUTexture texture) {
    for (const auto& [textureId, info] : state->registries.textureRegistry) {
        (void)textureId;
        if (info.texture == texture) return &info;
    }
    return nullptr;
}

js::JSValueHandle acquireSurfaceTexture(
    BindingsState* state,
    const SurfaceTextureAcquire& acquire,
    const SurfaceTextureWrapper& wrap,
    const SurfaceTextureRelease& release) {
    const WGPUTexture previousCurrentTexture = state->presentation.currentTexture;
    const uint64_t previousSurfaceTextureId = state->presentation.currentSurfaceTextureId;
    const uint64_t previousNextTextureId = state->registries.nextTextureId;
    const int previousFrameCount = state->profiling.frameCount;
    WGPUTexture texture = state->presentation.currentTexture;
    uint64_t textureId = state->presentation.currentSurfaceTextureId;
    bool createdSurfaceTexture = false;
    if (!texture || textureId == 0) {
        texture = acquire(state);
        if (!texture) {
            state->engine->throwException("Failed to get current texture");
            return state->engine->newUndefined();
        }
        state->presentation.currentTexture = texture;
        if (state->profiling.frameCount++ < 3 && state->verboseLogging) {
            std::cout << "[Canvas] Got texture: " << texture << std::endl;
        }
        textureId = state->registries.nextTextureId++;
        TextureInfo textureInfo;
        textureInfo.texture = texture;
        textureInfo.format = state->presentation.surfaceFormat;
        textureInfo.width = state->presentation.canvasWidth;
        textureInfo.height = state->presentation.canvasHeight;
        textureInfo.ownsTexture = false;
        state->registries.textureRegistry[textureId] = textureInfo;
        state->presentation.currentSurfaceTextureId = textureId;
        createdSurfaceTexture = true;
    }

    const auto jsTexture =
        wrap(state, texture, textureId, state->presentation.canvasWidth, state->presentation.canvasHeight,
             formatToString(state->presentation.surfaceFormat), createdSurfaceTexture);
    if (createdSurfaceTexture && state->engine->isUndefined(jsTexture) &&
        state->engine->hasException()) {
        if (state->registries.textureRegistry.find(textureId) != state->registries.textureRegistry.end()) {
            releaseTextureRegistryEntry(state, textureId);
        }
        state->presentation.currentTexture = previousCurrentTexture;
        state->presentation.currentSurfaceTextureId = previousSurfaceTextureId;
        state->registries.nextTextureId = previousNextTextureId;
        state->profiling.frameCount = previousFrameCount;
        release(state, texture, previousCurrentTexture);
    }
    return jsTexture;
}

void releaseBufferRegistryEntry(BindingsState* state, uint64_t bufferId) {
    if (!state) return;
    const auto it = state->registries.bufferRegistry.find(bufferId);
    if (it == state->registries.bufferRegistry.end())
        return;
    const auto pendingMaps = removeBufferMapRequests(state, bufferId);
    if (it->second.mapPending) it->second.mapPending = false;
    rejectBufferMapRequests(state, pendingMaps, "Buffer was destroyed while mapping");
    const BufferInfo info = it->second;
    state->registries.bufferRegistry.erase(it);
    recordBufferDestroyed(state, info);
    if (info.buffer) {
        if (info.isMapped) wgpuBufferUnmap(info.buffer);
        wgpuBufferDestroy(info.buffer);
        wgpuBufferRelease(info.buffer);
    }
    if (state->registries.nextBufferId == bufferId + 1)
        state->registries.nextBufferId = bufferId;
}

/**
 * Parse texture format string to enum
 */
WGPUTextureFormat stringToFormat(const std::string& format) {
    if (format == "bgra8unorm") return WGPUTextureFormat_BGRA8Unorm;
    if (format == "bgra8unorm-srgb") return WGPUTextureFormat_BGRA8UnormSrgb;
    if (format == "rgba8unorm") return WGPUTextureFormat_RGBA8Unorm;
    if (format == "rgba8unorm-srgb") return WGPUTextureFormat_RGBA8UnormSrgb;
    if (format == "r8unorm") return WGPUTextureFormat_R8Unorm;
    if (format == "rg8unorm") return WGPUTextureFormat_RG8Unorm;
    if (format == "r16float") return WGPUTextureFormat_R16Float;
    if (format == "rg16float") return WGPUTextureFormat_RG16Float;
    if (format == "r32float") return WGPUTextureFormat_R32Float;
    if (format == "rg32float") return WGPUTextureFormat_RG32Float;
    if (format == "rgba16float") return WGPUTextureFormat_RGBA16Float;
    if (format == "rgba32float") return WGPUTextureFormat_RGBA32Float;
    // Three's KTX2Loader selects these when the device advertises texture-compression-bc. The
    // device feature was already requested, but falling through here silently created BGRA8
    // textures and then uploaded block-compressed bytes with invalid row geometry.
    if (format == "bc1-rgba-unorm") return WGPUTextureFormat_BC1RGBAUnorm;
    if (format == "bc1-rgba-unorm-srgb") return WGPUTextureFormat_BC1RGBAUnormSrgb;
    if (format == "bc2-rgba-unorm") return WGPUTextureFormat_BC2RGBAUnorm;
    if (format == "bc2-rgba-unorm-srgb") return WGPUTextureFormat_BC2RGBAUnormSrgb;
    if (format == "bc3-rgba-unorm") return WGPUTextureFormat_BC3RGBAUnorm;
    if (format == "bc3-rgba-unorm-srgb") return WGPUTextureFormat_BC3RGBAUnormSrgb;
    if (format == "bc4-r-unorm") return WGPUTextureFormat_BC4RUnorm;
    if (format == "bc4-r-snorm") return WGPUTextureFormat_BC4RSnorm;
    if (format == "bc5-rg-unorm") return WGPUTextureFormat_BC5RGUnorm;
    if (format == "bc5-rg-snorm") return WGPUTextureFormat_BC5RGSnorm;
    if (format == "bc6h-rgb-ufloat") return WGPUTextureFormat_BC6HRGBUfloat;
    if (format == "bc6h-rgb-float") return WGPUTextureFormat_BC6HRGBFloat;
    if (format == "bc7-rgba-unorm") return WGPUTextureFormat_BC7RGBAUnorm;
    if (format == "bc7-rgba-unorm-srgb") return WGPUTextureFormat_BC7RGBAUnormSrgb;
    // The mobile counterparts, selected when the device advertises texture-compression-etc2 or
    // -astc (Android). Unmapped, they took the same BGRA8 fall-through as BC once did.
    if (format == "etc2-rgb8unorm") return WGPUTextureFormat_ETC2RGB8Unorm;
    if (format == "etc2-rgb8unorm-srgb") return WGPUTextureFormat_ETC2RGB8UnormSrgb;
    if (format == "etc2-rgb8a1unorm") return WGPUTextureFormat_ETC2RGB8A1Unorm;
    if (format == "etc2-rgb8a1unorm-srgb") return WGPUTextureFormat_ETC2RGB8A1UnormSrgb;
    if (format == "etc2-rgba8unorm") return WGPUTextureFormat_ETC2RGBA8Unorm;
    if (format == "etc2-rgba8unorm-srgb") return WGPUTextureFormat_ETC2RGBA8UnormSrgb;
    if (format == "eac-r11unorm") return WGPUTextureFormat_EACR11Unorm;
    if (format == "eac-r11snorm") return WGPUTextureFormat_EACR11Snorm;
    if (format == "eac-rg11unorm") return WGPUTextureFormat_EACRG11Unorm;
    if (format == "eac-rg11snorm") return WGPUTextureFormat_EACRG11Snorm;
    if (format == "astc-4x4-unorm") return WGPUTextureFormat_ASTC4x4Unorm;
    if (format == "astc-4x4-unorm-srgb") return WGPUTextureFormat_ASTC4x4UnormSrgb;
    // Integer formats, the absence of which is not a missing feature but a wrong picture. An
    // unrecognized name fell through to the BGRA8Unorm default below, so a texture three.js asked
    // to sample as `uint` came back as a float colour format, every bind group built against it
    // failed validation, and the draw using it silently did not happen. `BatchedMesh` allocates an
    // `r32uint` indirection texture, so on this host every batched draw was invalid.
    if (format == "r8uint") return WGPUTextureFormat_R8Uint;
    if (format == "r8sint") return WGPUTextureFormat_R8Sint;
    if (format == "rg8uint") return WGPUTextureFormat_RG8Uint;
    if (format == "rg8sint") return WGPUTextureFormat_RG8Sint;
    if (format == "rgba8uint") return WGPUTextureFormat_RGBA8Uint;
    if (format == "rgba8sint") return WGPUTextureFormat_RGBA8Sint;
    if (format == "r16uint") return WGPUTextureFormat_R16Uint;
    if (format == "r16sint") return WGPUTextureFormat_R16Sint;
    if (format == "rg16uint") return WGPUTextureFormat_RG16Uint;
    if (format == "rg16sint") return WGPUTextureFormat_RG16Sint;
    if (format == "rgba16uint") return WGPUTextureFormat_RGBA16Uint;
    if (format == "rgba16sint") return WGPUTextureFormat_RGBA16Sint;
    if (format == "r32uint") return WGPUTextureFormat_R32Uint;
    if (format == "r32sint") return WGPUTextureFormat_R32Sint;
    if (format == "rg32uint") return WGPUTextureFormat_RG32Uint;
    if (format == "rg32sint") return WGPUTextureFormat_RG32Sint;
    if (format == "rgba32uint") return WGPUTextureFormat_RGBA32Uint;
    if (format == "rgba32sint") return WGPUTextureFormat_RGBA32Sint;
    if (format == "r8snorm") return WGPUTextureFormat_R8Snorm;
    if (format == "rg8snorm") return WGPUTextureFormat_RG8Snorm;
    if (format == "rgba8snorm") return WGPUTextureFormat_RGBA8Snorm;
    if (format == "rgb10a2unorm") return WGPUTextureFormat_RGB10A2Unorm;
    if (format == "rg11b10ufloat") return WGPUTextureFormat_RG11B10Ufloat;
    if (format == "depth24plus") return WGPUTextureFormat_Depth24Plus;
    if (format == "depth24plus-stencil8") return WGPUTextureFormat_Depth24PlusStencil8;
    if (format == "depth32float") return WGPUTextureFormat_Depth32Float;
    // Log unrecognized formats for debugging
    if (!format.empty()) {
        std::cerr << "[WebGPU] Warning: Unrecognized format '" << format << "', defaulting to BGRA8Unorm" << std::endl;
    }
    return WGPUTextureFormat_BGRA8Unorm;  // Default to non-sRGB
}

/**
 * Parse texture dimension string to enum
 */
static WGPUTextureDimension stringToTextureDimension(const std::string& dim) {
    if (dim == "1d") return WGPUTextureDimension_1D;
    if (dim == "2d") return WGPUTextureDimension_2D;
    if (dim == "3d") return WGPUTextureDimension_3D;
    return WGPUTextureDimension_2D;  // Default
}

/**
 * Parse texture view dimension string to enum
 */
WGPUTextureViewDimension stringToTextureViewDimension(const std::string& dim) {
    if (dim == "1d") return WGPUTextureViewDimension_1D;
    if (dim == "2d") return WGPUTextureViewDimension_2D;
    if (dim == "2d-array") return WGPUTextureViewDimension_2DArray;
    if (dim == "cube") return WGPUTextureViewDimension_Cube;
    if (dim == "cube-array") return WGPUTextureViewDimension_CubeArray;
    if (dim == "3d") return WGPUTextureViewDimension_3D;
    return WGPUTextureViewDimension_2D;  // Default
}

/**
 * Parse address mode string to enum
 */
static WGPUAddressMode stringToAddressMode(const std::string& mode) {
    if (mode == "clamp-to-edge") return WGPUAddressMode_ClampToEdge;
    if (mode == "repeat") return WGPUAddressMode_Repeat;
    if (mode == "mirror-repeat") return WGPUAddressMode_MirrorRepeat;
    return WGPUAddressMode_ClampToEdge;  // Default
}

/**
 * Parse filter mode string to enum
 */
static WGPUFilterMode stringToFilterMode(const std::string& mode) {
    if (mode == "nearest") return WGPUFilterMode_Nearest;
    if (mode == "linear") return WGPUFilterMode_Linear;
    return WGPUFilterMode_Nearest;  // Default
}

/**
 * Parse mipmap filter mode string to enum
 */
static WGPUMipmapFilterMode stringToMipmapFilterMode(const std::string& mode) {
    if (mode == "nearest") return WGPUMipmapFilterMode_Nearest;
    if (mode == "linear") return WGPUMipmapFilterMode_Linear;
    return WGPUMipmapFilterMode_Nearest;  // Default
}

/**
 * Parse compare function string to enum
 */
WGPUCompareFunction stringToCompareFunction(const std::string& func) {
    if (func == "never") return WGPUCompareFunction_Never;
    if (func == "less") return WGPUCompareFunction_Less;
    if (func == "equal") return WGPUCompareFunction_Equal;
    if (func == "less-equal") return WGPUCompareFunction_LessEqual;
    if (func == "greater") return WGPUCompareFunction_Greater;
    if (func == "not-equal") return WGPUCompareFunction_NotEqual;
    if (func == "greater-equal") return WGPUCompareFunction_GreaterEqual;
    if (func == "always") return WGPUCompareFunction_Always;
    return WGPUCompareFunction_Undefined;  // Default (no comparison)
}


js::JSValueHandle handleGpuDeviceCreateTextureView(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args) {
                            if (args.empty()) {
                                state->engine->throwException("createTextureView requires a texture");
                                return state->engine->newUndefined();
                            }
                            auto textureHandle = args[0];
                            WGPUTexture texture = (WGPUTexture)state->engine->getPrivateData(textureHandle);
                            if (!texture) {
                                state->engine->throwException("createTextureView: invalid texture");
                                return state->engine->newUndefined();
                            }
                            const TextureInfo* textureInfo =
                                findTextureInfoByHandle(state, texture);
                            WGPUTextureFormat format =
                                textureInfo ? textureInfo->format : state->presentation.surfaceFormat;
                            WGPUTextureViewDescriptor viewDesc = {};
                            viewDesc.format = format;
                            viewDesc.dimension = WGPUTextureViewDimension_2D;
                            viewDesc.baseMipLevel = 0;
                            viewDesc.mipLevelCount = 1;
                            viewDesc.baseArrayLayer = 0;
                            viewDesc.arrayLayerCount = 1;
                            viewDesc.aspect = WGPUTextureAspect_All;
                            // Parse descriptor if provided
                            if (args.size() > 1 && !state->engine->isUndefined(args[1])) {
                                auto descriptor = args[1];
                                auto formatProp = state->engine->getProperty(descriptor, "format");
                                if (!state->engine->isUndefined(formatProp)) {
                                    viewDesc.format = stringToFormat(state->engine->toString(formatProp));
                                }
                                auto dimensionProp = state->engine->getProperty(descriptor, "dimension");
                                if (!state->engine->isUndefined(dimensionProp)) {
                                    viewDesc.dimension = stringToTextureViewDimension(state->engine->toString(dimensionProp));
                                }
                                auto baseMipLevel = state->engine->getProperty(descriptor, "baseMipLevel");
                                if (!state->engine->isUndefined(baseMipLevel)) {
                                    viewDesc.baseMipLevel = (uint32_t)state->engine->toNumber(baseMipLevel);
                                }
                                auto mipLevelCount = state->engine->getProperty(descriptor, "mipLevelCount");
                                if (!state->engine->isUndefined(mipLevelCount)) {
                                    viewDesc.mipLevelCount = (uint32_t)state->engine->toNumber(mipLevelCount);
                                }
                                auto baseArrayLayer = state->engine->getProperty(descriptor, "baseArrayLayer");
                                if (!state->engine->isUndefined(baseArrayLayer)) {
                                    viewDesc.baseArrayLayer = (uint32_t)state->engine->toNumber(baseArrayLayer);
                                }
                                auto arrayLayerCount = state->engine->getProperty(descriptor, "arrayLayerCount");
                                if (!state->engine->isUndefined(arrayLayerCount)) {
                                    uint32_t requested = (uint32_t)state->engine->toNumber(arrayLayerCount);
                                    // Clamp to 1 for surface textures (which only have 1 layer)
                                    // or use the native registry record for regular textures.
                                    uint32_t maxLayers = textureInfo &&
                                            textureInfo->depthOrArrayLayers > 0
                                        ? textureInfo->depthOrArrayLayers
                                        : 1;
                                    viewDesc.arrayLayerCount = std::min(requested, maxLayers - viewDesc.baseArrayLayer);
                                }
                                auto aspect = state->engine->getProperty(descriptor, "aspect");
                                if (!state->engine->isUndefined(aspect)) {
                                    std::string aspectStr = state->engine->toString(aspect);
                                    if (aspectStr == "all") viewDesc.aspect = WGPUTextureAspect_All;
                                    else if (aspectStr == "stencil-only") viewDesc.aspect = WGPUTextureAspect_StencilOnly;
                                    else if (aspectStr == "depth-only") viewDesc.aspect = WGPUTextureAspect_DepthOnly;
                                }
                            }
                            // Final validation: Fix arrayLayerCount based on view dimension
                            if (viewDesc.dimension == WGPUTextureViewDimension_3D ||
                                viewDesc.dimension == WGPUTextureViewDimension_1D) {
                                viewDesc.arrayLayerCount = 1;
                            } else if (viewDesc.dimension == WGPUTextureViewDimension_Cube) {
                                viewDesc.arrayLayerCount = 6;
                            }
                            WGPUTextureView view = wgpuTextureCreateView(texture, &viewDesc);
                            if (!requireHandle(state->engine, view, "device.createTextureView"))
                                return state->engine->newUndefined();
                            auto jsView = createNativeWrapper(state, "GPUTextureView", view);
                            const uint64_t viewId = state->registries.nextTextureViewId++;
                            state->registries.textureViewRegistry[viewId] = view;
                            state->engine->setProperty(jsView, "_textureViewId", state->engine->newNumber(viewId));
                            state->engine->setProperty(jsView, "_type", state->engine->newString("textureView"));
                            state->engine->registerRelease(jsView, [state, view, viewId]() {
                                state->registries.textureViewRegistry.erase(viewId);
                                wgpuTextureViewRelease(view);
                            });
                            if (state->verboseLogging) std::cout << "[WebGPU] Created texture view" << std::endl;
                            return jsView;
}

js::JSValueHandle handleGpuDeviceCreateSampler(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args) {
                            WGPUSamplerDescriptor samplerDesc = {};
                            // Default values
                            samplerDesc.addressModeU = WGPUAddressMode_ClampToEdge;
                            samplerDesc.addressModeV = WGPUAddressMode_ClampToEdge;
                            samplerDesc.addressModeW = WGPUAddressMode_ClampToEdge;
                            samplerDesc.magFilter = WGPUFilterMode_Nearest;
                            samplerDesc.minFilter = WGPUFilterMode_Nearest;
                            samplerDesc.mipmapFilter = WGPUMipmapFilterMode_Nearest;
                            samplerDesc.lodMinClamp = 0.0f;
                            samplerDesc.lodMaxClamp = 32.0f;
                            samplerDesc.maxAnisotropy = 1;
                            if (!args.empty()) {
                                auto descriptor = args[0];
                                auto addressModeU = state->engine->getProperty(descriptor, "addressModeU");
                                if (!state->engine->isUndefined(addressModeU)) {
                                    samplerDesc.addressModeU = stringToAddressMode(state->engine->toString(addressModeU));
                                }
                                auto addressModeV = state->engine->getProperty(descriptor, "addressModeV");
                                if (!state->engine->isUndefined(addressModeV)) {
                                    samplerDesc.addressModeV = stringToAddressMode(state->engine->toString(addressModeV));
                                }
                                auto addressModeW = state->engine->getProperty(descriptor, "addressModeW");
                                if (!state->engine->isUndefined(addressModeW)) {
                                    samplerDesc.addressModeW = stringToAddressMode(state->engine->toString(addressModeW));
                                }
                                auto magFilter = state->engine->getProperty(descriptor, "magFilter");
                                if (!state->engine->isUndefined(magFilter)) {
                                    samplerDesc.magFilter = stringToFilterMode(state->engine->toString(magFilter));
                                }
                                auto minFilter = state->engine->getProperty(descriptor, "minFilter");
                                if (!state->engine->isUndefined(minFilter)) {
                                    samplerDesc.minFilter = stringToFilterMode(state->engine->toString(minFilter));
                                }
                                auto mipmapFilter = state->engine->getProperty(descriptor, "mipmapFilter");
                                if (!state->engine->isUndefined(mipmapFilter)) {
                                    samplerDesc.mipmapFilter = stringToMipmapFilterMode(state->engine->toString(mipmapFilter));
                                }
                                auto lodMinClamp = state->engine->getProperty(descriptor, "lodMinClamp");
                                if (!state->engine->isUndefined(lodMinClamp)) {
                                    samplerDesc.lodMinClamp = (float)state->engine->toNumber(lodMinClamp);
                                }
                                auto lodMaxClamp = state->engine->getProperty(descriptor, "lodMaxClamp");
                                if (!state->engine->isUndefined(lodMaxClamp)) {
                                    samplerDesc.lodMaxClamp = (float)state->engine->toNumber(lodMaxClamp);
                                }
                                auto compare = state->engine->getProperty(descriptor, "compare");
                                if (!state->engine->isUndefined(compare)) {
                                    samplerDesc.compare = stringToCompareFunction(state->engine->toString(compare));
                                }
                                auto maxAnisotropy = state->engine->getProperty(descriptor, "maxAnisotropy");
                                if (!state->engine->isUndefined(maxAnisotropy)) {
                                    samplerDesc.maxAnisotropy = (uint16_t)state->engine->toNumber(maxAnisotropy);
                                }
                            }
#if defined(MYSTRAL_WEBGPU_WGPU)
                            // wgpu-native's Vulkan backend returns zero when Three.js samples
                            // a one-level render target with its generic lodMaxClamp of 32.
                            // Samplers are created before they are paired with a texture view,
                            // so keep filtering intact and cap the backend's effective LOD range.
                            if (samplerDesc.lodMaxClamp > 1.0f) {
                                samplerDesc.lodMaxClamp = 1.0f;
                            }
#endif
                            if (samplerDesc.lodMinClamp > samplerDesc.lodMaxClamp) {
                                state->engine->throwException("Failed to create sampler");
                                return state->engine->newUndefined();
                            }
                            WGPUSampler sampler = wgpuDeviceCreateSampler(state->device, &samplerDesc);
                            if (!sampler) {
                                state->engine->throwException("Failed to create sampler");
                                return state->engine->newUndefined();
                            }
                            auto jsSampler = createNativeWrapper(state, "GPUSampler", sampler);
                            state->engine->setProperty(jsSampler, "_type", state->engine->newString("sampler"));
                            auto ownedResources = state->registries.ownedResources;
                            const uint64_t samplerId = ownedResources->trackSampler(sampler);
                            state->engine->registerRelease(jsSampler, [ownedResources, samplerId]() {
                                ownedResources->releaseSampler(samplerId);
                            });
                            if (state->verboseLogging) std::cout << "[WebGPU] Created sampler" << std::endl;
                            return jsSampler;
}

static js::JSValueHandle handleGpuTextureDestroy(
    BindingsState* state,
    uint64_t textureId,
    const std::vector<js::JSValueHandle>&) {
                                    releaseTextureRegistryEntry(state, textureId);
                                    return state->engine->newUndefined();
}

static js::JSValueHandle handleGpuTextureCreateView(BindingsState* state, uint64_t textureId, const std::vector<js::JSValueHandle>& args) {
                                    // Look up texture from registry using captured textureId
                                    auto it = state->registries.textureRegistry.find(textureId);
                                    if (it == state->registries.textureRegistry.end()) {
                                        std::cerr << "[WebGPU] createView: Texture " << textureId << " not found in registry" << std::endl;
                                        return state->engine->newUndefined();
                                    }
                                    WGPUTexture texture = it->second.texture;
                                    if (!texture) {
                                        std::cerr << "[WebGPU] createView: Texture " << textureId << " is null" << std::endl;
                                        return state->engine->newUndefined();
                                    }
                                    WGPUTextureViewDescriptor viewDesc = {};
                                    // Default values - use all mips and layers from the texture
                                    viewDesc.format = it->second.format;
                                    viewDesc.mipLevelCount = it->second.mipLevelCount > 0 ? it->second.mipLevelCount : 1;
                                    viewDesc.baseMipLevel = 0;
                                    viewDesc.baseArrayLayer = 0;
                                    viewDesc.aspect = WGPUTextureAspect_All;
                                    // Default dimension and arrayLayerCount based on texture dimension
                                    if (it->second.dimension == WGPUTextureDimension_3D) {
                                        // 3D textures: view as 3D, arrayLayerCount must be 1
                                        viewDesc.dimension = WGPUTextureViewDimension_3D;
                                        viewDesc.arrayLayerCount = 1;
                                    } else if (it->second.dimension == WGPUTextureDimension_1D) {
                                        // 1D textures
                                        viewDesc.dimension = WGPUTextureViewDimension_1D;
                                        viewDesc.arrayLayerCount = 1;
                                    } else {
                                        // 2D textures: use layers for 2D-array, 1 for regular 2D
                                        viewDesc.arrayLayerCount = it->second.depthOrArrayLayers > 0 ? it->second.depthOrArrayLayers : 1;
                                        viewDesc.dimension = it->second.depthOrArrayLayers > 1 ? WGPUTextureViewDimension_2DArray : WGPUTextureViewDimension_2D;
                                    }
                                    // Parse view descriptor if provided
                                    if (!args.empty() && !state->engine->isUndefined(args[0])) {
                                        auto descriptor = args[0];
                                        // format (optional, defaults to texture format)
                                        auto formatProp = state->engine->getProperty(descriptor, "format");
                                        if (!state->engine->isUndefined(formatProp)) {
                                            viewDesc.format = stringToFormat(state->engine->toString(formatProp));
                                        } else {
                                            viewDesc.format = it->second.format;
                                        }
                                        // dimension (optional)
                                        auto dimensionProp = state->engine->getProperty(descriptor, "dimension");
                                        if (!state->engine->isUndefined(dimensionProp)) {
                                            std::string dimStr = state->engine->toString(dimensionProp);
                                            if (dimStr == "1d") viewDesc.dimension = WGPUTextureViewDimension_1D;
                                            else if (dimStr == "2d") viewDesc.dimension = WGPUTextureViewDimension_2D;
                                            else if (dimStr == "2d-array") viewDesc.dimension = WGPUTextureViewDimension_2DArray;
                                            else if (dimStr == "cube") viewDesc.dimension = WGPUTextureViewDimension_Cube;
                                            else if (dimStr == "cube-array") viewDesc.dimension = WGPUTextureViewDimension_CubeArray;
                                            else if (dimStr == "3d") viewDesc.dimension = WGPUTextureViewDimension_3D;
                                        }
                                        // aspect (optional)
                                        auto aspectProp = state->engine->getProperty(descriptor, "aspect");
                                        if (!state->engine->isUndefined(aspectProp)) {
                                            std::string aspectStr = state->engine->toString(aspectProp);
                                            if (aspectStr == "all") viewDesc.aspect = WGPUTextureAspect_All;
                                            else if (aspectStr == "stencil-only") viewDesc.aspect = WGPUTextureAspect_StencilOnly;
                                            else if (aspectStr == "depth-only") viewDesc.aspect = WGPUTextureAspect_DepthOnly;
                                        }
                                        // baseMipLevel (optional)
                                        auto baseMipProp = state->engine->getProperty(descriptor, "baseMipLevel");
                                        if (!state->engine->isUndefined(baseMipProp)) {
                                            viewDesc.baseMipLevel = (uint32_t)state->engine->toNumber(baseMipProp);
                                        }
                                        // mipLevelCount (optional)
                                        auto mipCountProp = state->engine->getProperty(descriptor, "mipLevelCount");
                                        if (!state->engine->isUndefined(mipCountProp)) {
                                            viewDesc.mipLevelCount = (uint32_t)state->engine->toNumber(mipCountProp);
                                        }
                                        // baseArrayLayer (optional)
                                        auto baseLayerProp = state->engine->getProperty(descriptor, "baseArrayLayer");
                                        if (!state->engine->isUndefined(baseLayerProp)) {
                                            viewDesc.baseArrayLayer = (uint32_t)state->engine->toNumber(baseLayerProp);
                                        }
                                        // arrayLayerCount (optional)
                                        auto layerCountProp = state->engine->getProperty(descriptor, "arrayLayerCount");
                                        if (!state->engine->isUndefined(layerCountProp)) {
                                            uint32_t requested = (uint32_t)state->engine->toNumber(layerCountProp);
                                            uint32_t maxLayers = it->second.depthOrArrayLayers > 0 ? it->second.depthOrArrayLayers : 1;
                                            // Clamp to actual texture layer count
                                            viewDesc.arrayLayerCount = std::min(requested, maxLayers - viewDesc.baseArrayLayer);
                                        }
                                    }
                                    // else: defaults are already set above
                                    // Final validation: Fix arrayLayerCount based on view dimension
                                    if (viewDesc.dimension == WGPUTextureViewDimension_3D ||
                                        viewDesc.dimension == WGPUTextureViewDimension_1D) {
                                        // 3D/1D textures have no array layers
                                        viewDesc.arrayLayerCount = 1;
                                    } else if (viewDesc.dimension == WGPUTextureViewDimension_Cube) {
                                        // Cube requires exactly 6 layers (the 6 faces)
                                        viewDesc.arrayLayerCount = 6;
                                    } else if (viewDesc.dimension == WGPUTextureViewDimension_CubeArray) {
                                        // CubeArray must have multiple of 6 layers
                                        uint32_t maxLayers = it->second.depthOrArrayLayers > 0 ? it->second.depthOrArrayLayers : 6;
                                        viewDesc.arrayLayerCount = std::min(viewDesc.arrayLayerCount, maxLayers);
                                        // Round down to nearest multiple of 6
                                        viewDesc.arrayLayerCount = (viewDesc.arrayLayerCount / 6) * 6;
                                        if (viewDesc.arrayLayerCount < 6) viewDesc.arrayLayerCount = 6;
                                    }
                                    WGPUTextureView view = wgpuTextureCreateView(texture, &viewDesc);
                                    // PRD-207 routes the offscreen-canvas texture through the same wrapper, so
                                    // this one site is what main's `offscreenTexture.createView` guarded as well.
                                    if (!requireHandle(state->engine, view, "texture.createView",
                                                       "textureId=" + std::to_string(textureId)))
                                        return state->engine->newUndefined();
                                    auto jsView = createNativeWrapper(
                                        state, "GPUTextureView", view);
                                    const uint64_t viewId = state->registries.nextTextureViewId++;
                                    state->registries.textureViewRegistry[viewId] = view;
                                    state->engine->setProperty(jsView, "_textureViewId", state->engine->newNumber(viewId));
                                    state->engine->setProperty(jsView, "_type", state->engine->newString("textureView"));
                                    state->engine->registerRelease(jsView, [state, view, viewId]() {
                                        state->registries.textureViewRegistry.erase(viewId);
                                        wgpuTextureViewRelease(view);
                                    });
                                    return jsView;
}

js::JSValueHandle handleGpuDeviceCreateTexture(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args) {
                            mystral::StallScope stall(mystral::StallSegment::TextureUpload);
                            if (args.empty()) {
                                state->engine->throwException("createTexture requires a descriptor");
                                return state->engine->newUndefined();
                            }
                            auto descriptor = args[0];
                            // Parse size - can be [width, height, depth] array or {width, height, depthOrArrayLayers} object
                            auto sizeVal = state->engine->getProperty(descriptor, "size");
                            uint32_t width = 1, height = 1, depthOrArrayLayers = 1;
                            // Check if size is an array
                            auto lengthProp = state->engine->getProperty(sizeVal, "length");
                            if (!state->engine->isUndefined(lengthProp)) {
                                // Array format: [width, height?, depth?]
                                int len = (int)state->engine->toNumber(lengthProp);
                                if (len >= 1) width = (uint32_t)state->engine->toNumber(state->engine->getPropertyIndex(sizeVal, 0));
                                if (len >= 2) height = (uint32_t)state->engine->toNumber(state->engine->getPropertyIndex(sizeVal, 1));
                                if (len >= 3) depthOrArrayLayers = (uint32_t)state->engine->toNumber(state->engine->getPropertyIndex(sizeVal, 2));
                            } else {
                                // Object format: {width, height, depthOrArrayLayers}
                                auto w = state->engine->getProperty(sizeVal, "width");
                                auto h = state->engine->getProperty(sizeVal, "height");
                                auto d = state->engine->getProperty(sizeVal, "depthOrArrayLayers");
                                if (!state->engine->isUndefined(w)) width = (uint32_t)state->engine->toNumber(w);
                                if (!state->engine->isUndefined(h)) height = (uint32_t)state->engine->toNumber(h);
                                if (!state->engine->isUndefined(d)) depthOrArrayLayers = (uint32_t)state->engine->toNumber(d);
                            }
                            // Parse format
                            std::string formatStr = state->engine->toString(state->engine->getProperty(descriptor, "format"));
                            WGPUTextureFormat format = stringToFormat(formatStr);
                            // Parse usage
                            double usageVal = state->engine->toNumber(state->engine->getProperty(descriptor, "usage"));
                            WGPUTextureUsage usage = (WGPUTextureUsage)(uint32_t)usageVal;
                            // Fix format/usage incompatibility:
                            // BGRA8UnormSrgb doesn't support StorageBinding, convert to BGRA8Unorm or RGBA8Unorm
                            if (format == WGPUTextureFormat_BGRA8UnormSrgb && (usage & WGPUTextureUsage_StorageBinding)) {
                                std::cout << "[WebGPU] Warning: BGRA8UnormSrgb doesn't support StorageBinding, using RGBA8Unorm instead" << std::endl;
                                format = WGPUTextureFormat_RGBA8Unorm;
                                formatStr = "rgba8unorm";
                            }
                            // Also handle BGRA8Unorm which may not support storage on all platforms
                            if (format == WGPUTextureFormat_BGRA8Unorm && (usage & WGPUTextureUsage_StorageBinding)) {
                                std::cout << "[WebGPU] Warning: BGRA8Unorm may not support StorageBinding, using RGBA8Unorm instead" << std::endl;
                                format = WGPUTextureFormat_RGBA8Unorm;
                                formatStr = "rgba8unorm";
                            }
                            // Parse optional properties
                            std::string dimensionStr = state->engine->toString(state->engine->getProperty(descriptor, "dimension"));
                            WGPUTextureDimension dimension = dimensionStr.empty() ? WGPUTextureDimension_2D : stringToTextureDimension(dimensionStr);
                            auto mipLevelCountVal = state->engine->getProperty(descriptor, "mipLevelCount");
                            uint32_t mipLevelCount = state->engine->isUndefined(mipLevelCountVal) ? 1 : (uint32_t)state->engine->toNumber(mipLevelCountVal);
                            auto sampleCountVal = state->engine->getProperty(descriptor, "sampleCount");
                            uint32_t sampleCount = state->engine->isUndefined(sampleCountVal) ? 1 : (uint32_t)state->engine->toNumber(sampleCountVal);
                            // Only a renderer proof may opt in; usage alone never establishes lifetime.
                            const auto lifetime = state->engine->getProperty(descriptor, "_tnPassLocalMSAA");
                            if (!state->engine->isUndefined(lifetime) && !state->engine->isBoolean(lifetime)) {
                                state->engine->throwException("_tnPassLocalMSAA must be boolean");
                                return state->engine->newUndefined();
                            }
                            bool transientAttachment = false;
#if defined(MYSTRAL_WEBGPU_DAWN)
                            transientAttachment = state->engine->toBoolean(lifetime) && sampleCount > 1 &&
                                usage == WGPUTextureUsage_RenderAttachment &&
                                dimension == WGPUTextureDimension_2D && depthOrArrayLayers == 1 &&
                                mipLevelCount == 1 &&
                                wgpuDeviceHasFeature(state->device, WGPUFeatureName_TransientAttachments);
                            if (transientAttachment) usage |= WGPUTextureUsage_TransientAttachment;
#endif
                            // Create texture descriptor
                            WGPUTextureDescriptor texDesc = {};
                            texDesc.size.width = width;
                            texDesc.size.height = height;
                            texDesc.size.depthOrArrayLayers = depthOrArrayLayers;
                            texDesc.format = format;
                            texDesc.usage = usage;
                            texDesc.dimension = dimension;
                            texDesc.mipLevelCount = mipLevelCount;
                            texDesc.sampleCount = sampleCount;
                            WGPUTexture texture = wgpuDeviceCreateTexture(state->device, &texDesc);
                            if (!texture) {
                                state->engine->throwException("Failed to create texture");
                                return state->engine->newUndefined();
                            }
                            // Create JS wrapper
                            auto jsTexture = createNativeWrapper(state, "GPUTexture", texture);
                            // Store texture properties
                            state->engine->setProperty(jsTexture, "width", state->engine->newNumber(width));
                            state->engine->setProperty(jsTexture, "height", state->engine->newNumber(height));
                            state->engine->setProperty(jsTexture, "depthOrArrayLayers", state->engine->newNumber(depthOrArrayLayers));
                            state->engine->setProperty(jsTexture, "format", state->engine->newString(formatStr.c_str()));
                            state->engine->setProperty(jsTexture, "mipLevelCount", state->engine->newNumber(mipLevelCount));
                            state->engine->setProperty(jsTexture, "sampleCount", state->engine->newNumber(sampleCount));
                            // Register texture for lookup by createView
                            uint64_t textureId = state->registries.nextTextureId++;
                            TextureInfo textureInfo;
                            textureInfo.texture = texture;
                            textureInfo.format = format;
                            textureInfo.width = width;
                            textureInfo.height = height;
                            textureInfo.depthOrArrayLayers = depthOrArrayLayers;
                            textureInfo.mipLevelCount = mipLevelCount;
                            textureInfo.dimension = dimension;
                            textureInfo.sampleCount = sampleCount;
                            textureInfo.transientAttachment = transientAttachment;
                            textureInfo.transientNominalBytes = transientAttachment ? textureMetricBytes(textureInfo) : 0;
                            textureInfo.ownsTexture = true;
                            textureInfo.accounted = false;
                            state->registries.textureRegistry[textureId] = textureInfo;
                            // Store texture ID for lookup
                            state->engine->setProperty(jsTexture, "_textureId", state->engine->newNumber(textureId));
                            if (!installBindingTable(state->engine, state, bindingTable({
                                {"GPUTexture", "createView", 0, nullptr,
                                makeCapturedHandler(textureId, &handleGpuTextureCreateView)
                            , jsTexture},
                            // texture.destroy()
                                                            {"GPUTexture", "destroy", 0, nullptr,
                                makeCapturedHandler(textureId, &handleGpuTextureDestroy)
                            , jsTexture}}))) {
                                releaseTextureRegistryEntry(state, textureId);
                                return state->engine->newUndefined();
                            }
                            recordTextureCreated(state, width, height, depthOrArrayLayers, mipLevelCount,
                                                 sampleCount, formatStr);
                            state->registries.textureRegistry[textureId].accounted = true;
                            if (state->verboseLogging) std::cout << "[WebGPU] Created texture " << width << "x" << height << " format=" << formatStr << " (id=" << textureId << ")" << std::endl;
                            return jsTexture;
}

static js::JSValueHandle handleGpuBufferDestroy(BindingsState* state, uint64_t bufferId, const std::vector<js::JSValueHandle>& args) {
                                    releaseBufferRegistryEntry(state, bufferId);
                                    return state->engine->newUndefined();
}

static js::JSValueHandle handleGpuBufferUnmap(
    BindingsState* state, uint64_t bufferId, const std::vector<js::JSValueHandle>& args) {
                                    // Look up this specific buffer by its ID
                                    auto it = state->registries.bufferRegistry.find(bufferId);
                                    if (it == state->registries.bufferRegistry.end()) {
                                        std::cerr << "[WebGPU] unmap: Buffer " << bufferId << " not found in registry" << std::endl;
                                        return state->engine->newUndefined();
                                    }
                                    auto& bufferInfo = it->second;
                                    const auto pending = removeBufferMapRequests(state, bufferId);
                                    if (bufferInfo.isMapped || bufferInfo.mapPending) {
                                        wgpuBufferUnmap(bufferInfo.buffer);
                                        bufferInfo.isMapped = false;
                                        bufferInfo.mapPending = false;
                                        bufferInfo.mappedData = nullptr;
                                        bufferInfo.mappedSize = 0;
                                    }
                                    rejectBufferMapRequests(state, pending, "Buffer was unmapped while mapping");
                                    return state->engine->newUndefined();
}

static js::JSValueHandle handleGpuBufferGetMappedRange(BindingsState* state, uint64_t bufferId, const std::vector<js::JSValueHandle>& args) {
                                    // Look up this specific buffer by its ID
                                    auto it = state->registries.bufferRegistry.find(bufferId);
                                    if (it == state->registries.bufferRegistry.end()) {
                                        std::cerr << "[WebGPU] getMappedRange: Buffer " << bufferId << " not found in registry" << std::endl;
                                        return state->engine->newUndefined();
                                    }
                                    auto& bufferInfo = it->second;
                                    if (!bufferInfo.isMapped && !bufferInfo.mappedData) {
                                        if (state->verboseLogging) std::cerr << "[WebGPU] getMappedRange: Buffer " << bufferId << " is not mapped" << std::endl;
                                        return state->engine->newUndefined();
                                    }
                                    // An explicit undefined means the argument was omitted (WebGPU optional), not NaN.
                                    uint64_t offset = args.empty() || state->engine->isUndefined(args[0]) ? 0 : (uint64_t)state->engine->toNumber(args[0]);
                                    uint64_t rangeSize = args.size() > 1 && !state->engine->isUndefined(args[1]) ? (uint64_t)state->engine->toNumber(args[1]) : bufferInfo.size - offset;
                                    // Use wgpuBufferGetConstMappedRange for MAP_READ, wgpuBufferGetMappedRange for MAP_WRITE
                                    // Dawn requires the const version for read-only mapped buffers
                                    const void* mappedData = nullptr;
                                    if (bufferInfo.mapMode == WGPUMapMode_Read) {
                                        mappedData = wgpuBufferGetConstMappedRange(bufferInfo.buffer, offset, rangeSize);
                                    } else {
                                        mappedData = wgpuBufferGetMappedRange(bufferInfo.buffer, offset, rangeSize);
                                    }
                                    if (mappedData) {
                                        // Use newArrayBufferExternal to avoid copying
                                        // Cast away const for read-only buffers - the JS side shouldn't modify but we need void*
                                        return state->engine->newArrayBufferExternal(const_cast<void*>(mappedData), rangeSize);
                                    }
                                    if (state->verboseLogging) std::cerr << "[WebGPU] getMappedRange: GetMappedRange returned null for buffer " << bufferId << std::endl;
                                    return state->engine->newUndefined();
}

static js::JSValueHandle handleGpuBufferMapAsync(
    BindingsState* state, uint64_t bufferId, const std::vector<js::JSValueHandle>& args) {
    // A map is a synchronization point with the queue: WebGPU completes it only after the work
    // already submitted. `queue.submit` is recorded rather than executed, so the copy a readback
    // just submitted is still sitting in the frame recorder — the map would report success over
    // bytes the GPU never wrote, and the deferred submit would then land on a mapped buffer
    // ("used in submit while mapped"). Flush before looking the buffer up: the replay can retire
    // a deferred `buffer.destroy()` and invalidate the registry iterator.
    if (!flushRecordedFrameOps(state))
        return state->engine->evalScriptWithResult(
            "Promise.reject(new Error('Buffer map failed'))", "mapAsync-flush-failed");
    auto it = state->registries.bufferRegistry.find(bufferId);
    if (it == state->registries.bufferRegistry.end()) {
        std::cerr << "[WebGPU] mapAsync: Buffer " << bufferId << " not found" << std::endl;
        return state->engine->evalScriptWithResult("Promise.reject(new Error('Buffer not found'))", "mapAsync-error");
    }
                                    auto& bufferInfo = it->second;
                                    // Already mapped (mappedAtCreation)?
                                    if (bufferInfo.isMapped) {
                                        return state->engine->evalScriptWithResult(
                                            "Promise.reject(new Error('Buffer already mapped'))", "mapAsync-already-mapped");
                                    }
                                    if (bufferInfo.mapPending) {
                                        return state->engine->evalScriptWithResult(
                                            "Promise.reject(new Error('Buffer map already pending'))",
                                            "mapAsync-already-pending");
                                    }
                                    // Get mode (default to READ)
                                    WGPUMapMode mode = WGPUMapMode_Read;
                                    if (!args.empty()) {
                                        uint32_t jsMode =
                                            (uint32_t)state->engine->toNumber(args[0]);
                                        // GPUMapMode.READ = 1, GPUMapMode.WRITE = 2
                                        if (jsMode == 2) mode = WGPUMapMode_Write;
                                    }
                                    uint64_t offset = args.size() > 1 && !state->engine->isUndefined(args[1])
                                        ? (uint64_t)state->engine->toNumber(args[1])
                                        : 0;
                                    uint64_t mapSize = args.size() > 2 && !state->engine->isUndefined(args[2])
                                        ? (uint64_t)state->engine->toNumber(args[2])
                                        : bufferInfo.size - offset;

                                    // `queue.submit` is recorded rather than executed, so a map has
                                    // to replay the clean prefix first. This is the only synchronous
                                    // boundary left here; waiting for the GPU belongs to the callback
                                    // and the next `pollEvents()` call.
                                    flushUploadStaging(state);
                                    const uint64_t requestId = state->asyncBufferMaps.nextRequestId++;
                                    auto request = std::make_shared<BufferMapRequest>();
                                    request->requestId = requestId;
                                    request->bufferId = bufferId;
                                    request->buffer = bufferInfo.buffer;
                                    request->mode = mode;
                                    request->offset = offset;
                                    request->size = mapSize;
                                    {
                                        std::lock_guard<std::mutex> lock(state->asyncBufferMaps.mutex);
                                        if (state->asyncBufferMaps.stopping) {
                                            return state->engine->evalScriptWithResult(
                                                "Promise.reject(new Error('Buffer map cancelled'))",
                                                "mapAsync-stopping");
                                        }
                                        state->asyncBufferMaps.pending.emplace(requestId, request);
                                    }
                                    bufferInfo.mapPending = true;
                                    auto promise = pendingBufferMapPromise(state, requestId);
                                    if (!promise.ptr || state->engine->hasException()) {
                                        removeBufferMapRequests(state, bufferId);
                                        bufferInfo.mapPending = false;
                                        return promise;
                                    }
                                    // An outer render pass can precede this submitted readback in
                                    // the recorder. Its unfinished tail cannot replay until end-frame.
                                    if (!state->profiling.frameOpStreamPendingOps)
                                        startBufferMapRequest(request);
                                    return promise;
}

js::JSValueHandle handleGpuDeviceCreateBuffer(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args) {
                            mystral::StallScope stall(mystral::StallSegment::BufferUpload);
                            if (args.empty()) {
                                state->engine->throwException("createBuffer requires a descriptor");
                                return state->engine->newUndefined();
                            }
                            auto descriptor = args[0];
                            double size = state->engine->toNumber(state->engine->getProperty(descriptor, "size"));
                            double usage = state->engine->toNumber(state->engine->getProperty(descriptor, "usage"));
                            // Check for mappedAtCreation
                            auto mappedAtCreationProp = state->engine->getProperty(descriptor, "mappedAtCreation");
                            bool mappedAtCreation = !state->engine->isUndefined(mappedAtCreationProp) && state->engine->toBoolean(mappedAtCreationProp);
                            WGPUBufferDescriptor bufferDesc = {};
                            bufferDesc.size = (uint64_t)size;
                            bufferDesc.usage = (WGPUBufferUsage)(uint32_t)usage;
                            bufferDesc.mappedAtCreation = mappedAtCreation;
                            WGPUBuffer buffer = wgpuDeviceCreateBuffer(state->device, &bufferDesc);
                            if (!buffer) {
                                state->engine->throwException("Failed to create buffer");
                                return state->engine->newUndefined();
                            }
                            // Register buffer for mapping operations
                            uint64_t bufferId = state->registries.nextBufferId++;
                            // mappedAtCreation buffers are mapped for write
                            WGPUMapMode initialMapMode = mappedAtCreation ? WGPUMapMode_Write : WGPUMapMode_None;
                            BufferInfo bufferInfo;
                            bufferInfo.buffer = buffer;
                            bufferInfo.size = bufferDesc.size;
                            bufferInfo.usage = bufferDesc.usage;
                            bufferInfo.isMapped = mappedAtCreation;
                            bufferInfo.mappedData = nullptr;
                            bufferInfo.mappedSize = 0;
                            bufferInfo.mapMode = initialMapMode;
                            bufferInfo.accounted = false;
                            state->registries.bufferRegistry[bufferId] = bufferInfo;
#if TN_ANDROID_JS_PROFILE
                            state->registries.androidJsProfileBufferRegistry[buffer] = bufferInfo;
#endif
                            auto jsBuffer = createNativeWrapper(state, "GPUBuffer", buffer);
                            state->engine->setProperty(jsBuffer, "size", state->engine->newNumber(size));
                            state->engine->setProperty(jsBuffer, "_bufferId", state->engine->newNumber((double)bufferId));
                            state->engine->setProperty(jsBuffer, "usage", state->engine->newNumber(usage));
                            // Set initial mapState
                            state->engine->setProperty(jsBuffer, "mapState", state->engine->newString(mappedAtCreation ? "mapped" : "unmapped"));
                            // buffer.mapAsync(mode, offset?, size?) -> Promise
                            // Returns a Promise that resolves when the buffer is mapped
                            if (!installBindingTable(state->engine, state, bindingTable({
                                {"GPUBuffer", "mapAsync", 0, nullptr,
                                makeCapturedHandler(bufferId, &handleGpuBufferMapAsync)
                            , jsBuffer},
                            // buffer.getMappedRange(offset?, size?) -> ArrayBuffer
                            // Capture bufferId in closure to identify the correct buffer
                                {"GPUBuffer", "getMappedRange", 0, nullptr,
                                makeCapturedHandler(bufferId, &handleGpuBufferGetMappedRange)
                            , jsBuffer},
                            // buffer.unmap()
                            // Capture bufferId in closure to identify the correct buffer
                                {"GPUBuffer", "unmap", 0, nullptr,
                                makeCapturedHandler(bufferId, &handleGpuBufferUnmap)
                            , jsBuffer},
                            // buffer.destroy()
                            // Capture bufferId in closure to identify the correct buffer
                                {"GPUBuffer", "destroy", 0, nullptr,
                                makeCapturedHandler(bufferId, &handleGpuBufferDestroy)
                            , jsBuffer}}))) {
                                releaseBufferRegistryEntry(state, bufferId);
                                return state->engine->newUndefined();
                            }
                            recordBufferCreated(state, bufferDesc.size, (uint32_t)usage);
                            state->registries.bufferRegistry[bufferId].accounted = true;
                            return jsBuffer;
}


#endif
}  // namespace webgpu
}  // namespace mystral
