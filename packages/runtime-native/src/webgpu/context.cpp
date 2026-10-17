/**
 * WebGPU Context Implementation
 *
 * Handles WebGPU initialization using wgpu-native (or Dawn).
 * Both backends implement the same webgpu.h C API.
 */

#include "mystral/webgpu/context.h"
#include "mystral/webgpu/presentation.h"
#include <cstdlib>
#include <string>
#include <SDL3/SDL.h>
#include <iostream>
#include <iterator>
#include <cstring>
#include <memory>
#include <vector>
#include <thread>
#include <chrono>
#include <condition_variable>
#include <mutex>

#ifdef __ANDROID__
#include <android/log.h>
#include <sys/system_properties.h>
#define TN_CONTEXT_LOGE(...) __android_log_print(ANDROID_LOG_ERROR, "ThreeNativeWGPU", __VA_ARGS__)
#define TN_CONTEXT_LOGI(...) __android_log_print(ANDROID_LOG_INFO, "ThreeNativeWGPU", __VA_ARGS__)
#else
#define TN_CONTEXT_LOGE(...) do { } while (0)
#define TN_CONTEXT_LOGI(...) do { } while (0)
#endif

#ifdef _WIN32
#include <windows.h>
#endif

// stb_image_write declaration (implementation is in stb_impl.cpp)
extern "C" int stbi_write_png(const char* filename, int w, int h, int comp, const void* data, int stride_in_bytes);

#if defined(MYSTRAL_WEBGPU_WGPU) || defined(MYSTRAL_WEBGPU_DAWN)
#include "webgpu/webgpu.h"
#if defined(MYSTRAL_WEBGPU_WGPU)
#if __has_include("webgpu/wgpu.h")
#include "webgpu/wgpu.h"
#else
#include "wgpu/wgpu.h"
#endif
#endif
#include "mystral/webgpu_compat.h"
#include "surface_format_selection.h"
#endif

// Dawn-specific includes for proc table setup
// Windows uses Skia's dawn_combined.lib which requires proc table initialization
// Linux/macOS use official Dawn releases which have direct implementations
#if defined(MYSTRAL_WEBGPU_DAWN)
#include "dawn/native/DawnNative.h"
#if defined(_WIN32)
#include "dawn/dawn_proc.h"
#endif
#endif

// wgpu-native specific declarations (avoiding wgpu.h include path issues)
#if defined(MYSTRAL_WEBGPU_WGPU) && !defined(MYSTRAL_WEBGPU_WGPU_MODERN)
extern "C" {
// Log level enum
typedef enum WGPULogLevel {
    WGPULogLevel_Off = 0x00000000,
    WGPULogLevel_Error = 0x00000001,
    WGPULogLevel_Warn = 0x00000002,
    WGPULogLevel_Info = 0x00000003,
    WGPULogLevel_Debug = 0x00000004,
    WGPULogLevel_Trace = 0x00000005,
} WGPULogLevel;

// Instance backend flags
typedef enum WGPUInstanceBackend {
    WGPUInstanceBackend_All = 0x00000000,
    WGPUInstanceBackend_Vulkan = 1 << 0,
    WGPUInstanceBackend_GL = 1 << 1,
    WGPUInstanceBackend_Metal = 1 << 2,
    WGPUInstanceBackend_DX12 = 1 << 3,
    WGPUInstanceBackend_DX11 = 1 << 4,
    WGPUInstanceBackend_BrowserWebGPU = 1 << 5,
} WGPUInstanceBackend;

typedef enum WGPUInstanceFlag {
    WGPUInstanceFlag_Default = 0x00000000,
    WGPUInstanceFlag_Debug = 1 << 0,
    WGPUInstanceFlag_Validation = 1 << 1,
} WGPUInstanceFlag;

// Native sType for instance extras
#define WGPUSType_InstanceExtras 0x00030006

typedef struct WGPUInstanceExtras {
    WGPUChainedStruct chain;
    WGPUFlags backends;
    WGPUFlags flags;
    uint32_t dx12ShaderCompiler;
    uint32_t gles3MinorVersion;
    const char* dxilPath;
    const char* dxcPath;
} WGPUInstanceExtras;

typedef void (*WGPULogCallback)(WGPULogLevel level, char const* message, void* userdata);

// Wrapped submission index for device poll
typedef struct WGPUWrappedSubmissionIndex {
    WGPUQueue queue;
    uint64_t submissionIndex;
} WGPUWrappedSubmissionIndex;

void wgpuSetLogCallback(WGPULogCallback callback, void* userdata);
void wgpuSetLogLevel(WGPULogLevel level);

// Device poll - blocks until all GPU work is done
WGPUBool wgpuDevicePoll(WGPUDevice device, WGPUBool wait, WGPUWrappedSubmissionIndex const* wrappedSubmissionIndex);
}
#endif

namespace mystral {
namespace webgpu {

#if defined(MYSTRAL_WEBGPU_WGPU) || defined(MYSTRAL_WEBGPU_DAWN)
static bool linearSurfaceRequested() {
#if defined(__ANDROID__)
    char property[PROP_VALUE_MAX] = {};
    if (__system_property_get("debug.threenative.linear_surface", property) > 0)
        return property[0] == '1';
#endif
    const char* configured = std::getenv("THREENATIVE_LINEAR_SURFACE");
    return configured != nullptr && configured[0] == '1';
}

static WGPUTextureFormat linearSurfaceFormatForProbe(WGPUTextureFormat format) {
    if (format == WGPUTextureFormat_RGBA8UnormSrgb) return WGPUTextureFormat_RGBA8Unorm;
    if (format == WGPUTextureFormat_BGRA8UnormSrgb) return WGPUTextureFormat_BGRA8Unorm;
    return format;
}

static bool isSrgbSurfaceFormatForProbe(WGPUTextureFormat format) {
    return format == WGPUTextureFormat_RGBA8UnormSrgb ||
           format == WGPUTextureFormat_BGRA8UnormSrgb;
}

static bool hasSurfaceFormat(
    const WGPUTextureFormat* formats,
    uint32_t formatCount,
    WGPUTextureFormat requestedFormat) {
    for (uint32_t i = 0; i < formatCount; i++) {
        if (formats[i] == requestedFormat) return true;
    }
    return false;
}

SurfaceFormatSelection selectSurfaceFormat(
    const WGPUTextureFormat* formats,
    uint32_t formatCount,
    bool linearDiagnosticRequested) {
    if (!formats || formatCount == 0) {
        return {WGPUTextureFormat_Undefined, WGPUTextureFormat_Undefined,
                "TN_LINEAR_SURFACE_UNSUPPORTED"};
    }

    // Keep the product path byte-for-byte equivalent to the existing preference: BGRA linear
    // wins, then RGBA linear, then the first capability. The diagnostic arm is deliberately
    // selected after this value so the product default cannot drift when the switch is off.
    WGPUTextureFormat productDefaultFormat = formats[0];
    for (uint32_t i = 0; i < formatCount; i++) {
        if (formats[i] == WGPUTextureFormat_BGRA8Unorm) {
            productDefaultFormat = WGPUTextureFormat_BGRA8Unorm;
            break;
        }
        if (formats[i] == WGPUTextureFormat_RGBA8Unorm) {
            productDefaultFormat = WGPUTextureFormat_RGBA8Unorm;
        }
    }

    if (!linearDiagnosticRequested) {
        return {productDefaultFormat, productDefaultFormat, nullptr};
    }

    // This arm is an sRGB presentation-bridge ablation, not a colour-channel preference test.
    // When the product selection is already linear, changing BGRA to RGBA would leave the bridge
    // disabled in both runs and make any timing delta impossible to attribute. Report that the arm
    // is unavailable instead of manufacturing a false treatment/control pair.
    if (!isSrgbSurfaceFormatForProbe(productDefaultFormat)) {
        return {productDefaultFormat, productDefaultFormat, "TN_LINEAR_SURFACE_NO_CHANGE"};
    }

    bool matchingLinearTwinFound = false;
    for (uint32_t i = 0; i < formatCount; i++) {
        if (!isSrgbSurfaceFormatForProbe(formats[i])) continue;
        const WGPUTextureFormat linearTwin = linearSurfaceFormatForProbe(formats[i]);
        if (!hasSurfaceFormat(formats, formatCount, linearTwin)) continue;
        matchingLinearTwinFound = true;
        if (linearTwin != productDefaultFormat) {
            return {productDefaultFormat, linearTwin, nullptr};
        }
    }

    if (matchingLinearTwinFound) {
        return {productDefaultFormat, productDefaultFormat, "TN_LINEAR_SURFACE_NO_CHANGE"};
    }
    return {productDefaultFormat, productDefaultFormat, "TN_LINEAR_SURFACE_UNSUPPORTED"};
}
#endif

// Callback data for async operations
struct AdapterRequestData {
    WGPUAdapter adapter = nullptr;
    bool completed = false;
};

struct DeviceRequestData {
    WGPUDevice device = nullptr;
    bool completed = false;
};

// Callbacks - different signatures for Dawn vs wgpu-native
/// A lost device is the end of the run, so say so where the player is looking.
///
/// Nothing can be drawn once the device is gone: the frame loop keeps ticking, presents nothing,
/// and the process exits 0 — a hung black window that reports success. A game that dies must say
/// it died. One fatal line for the log, the platform's own dialog for the player (SDL needs no
/// GPU, which is the entire point here), and a non-zero status for whatever launched it.
static void reportFatalDeviceLoss(const std::string& detail) {
    std::cerr << "[FATAL] The GPU device was lost: " << detail << std::endl;
    TN_CONTEXT_LOGE("The GPU device was lost: %s", detail.c_str());
#if !defined(__ANDROID__)
    // Modal, and that is the point for a player — but a playtest, a headless run or a CI lane has
    // nobody to click it, and a dialog nobody dismisses turns a crash into a hang that reads as a
    // timeout. Those lanes already have the log, which is what they assert on.
    const bool unattended = std::getenv("MYSTRAL_HEADLESS") != nullptr ||
                            std::getenv("TN_PLAYTEST_MAILBOX_ROOT") != nullptr ||
                            std::getenv("CI") != nullptr;
    if (!unattended) {
        const std::string body =
            "The GPU device was lost and the game cannot keep rendering.\n\n" + detail;
        SDL_ShowSimpleMessageBox(SDL_MESSAGEBOX_ERROR, "ThreeNative", body.c_str(), nullptr);
    }
#endif
    std::exit(1);
}

#if WGPU_USES_CALLBACK_INFO_PATTERN
// Dawn callback signatures
static void onAdapterRequestEnded(WGPURequestAdapterStatus status, WGPUAdapter adapter, WGPUStringView message, void* userdata1, void* userdata2) {
    auto* data = static_cast<AdapterRequestData*>(userdata1);
    if (status == WGPURequestAdapterStatus_Success) {
        data->adapter = adapter;
        std::cout << "[WebGPU] Adapter acquired successfully" << std::endl;
    } else {
        std::cerr << "[WebGPU] Failed to request adapter: " << WGPU_PRINT_STRING_VIEW(message) << std::endl;
        TN_CONTEXT_LOGE("Failed to request adapter: %s", WGPU_PRINT_STRING_VIEW(message).c_str());
    }
    data->completed = true;
}

static void onDeviceRequestEnded(WGPURequestDeviceStatus status, WGPUDevice device, WGPUStringView message, void* userdata1, void* userdata2) {
    auto* data = static_cast<DeviceRequestData*>(userdata1);
    if (status == WGPURequestDeviceStatus_Success) {
        data->device = device;
        std::cout << "[WebGPU] Device acquired successfully" << std::endl;
    } else {
        std::cerr << "[WebGPU] Failed to request device: " << WGPU_PRINT_STRING_VIEW(message) << std::endl;
        TN_CONTEXT_LOGE("Failed to request device: %s", WGPU_PRINT_STRING_VIEW(message).c_str());
    }
    data->completed = true;
}

static void onDeviceError(WGPUDevice const* device, WGPUErrorType type, WGPUStringView message, void* userdata1, void* userdata2) {
    const char* typeStr = "Unknown";
    switch (type) {
        case WGPUErrorType_NoError: typeStr = "NoError"; break;
        case WGPUErrorType_Validation: typeStr = "Validation"; break;
        case WGPUErrorType_OutOfMemory: typeStr = "OutOfMemory"; break;
        case WGPUErrorType_Internal: typeStr = "Internal"; break;
        case WGPUErrorType_Unknown: typeStr = "Unknown"; break;
        // Note: DeviceLost is not a separate error type in Dawn (maps to Unknown)
        default: break;
    }
    std::cerr << "[WebGPU] Device error (" << typeStr << "): " << WGPU_PRINT_STRING_VIEW(message) << std::endl;
    // std::cerr goes nowhere on Android. Without this the next wgpuQueueSubmit aborts the
    // process on a validation error and logcat shows nothing at all.
    TN_CONTEXT_LOGE("Device error (%s): %s", typeStr, WGPU_PRINT_STRING_VIEW(message).c_str());
}

/// `Destroyed` is this runtime shutting its own device down, not a fault.
/// A context with a lost handler (the native engine's device lifecycle) hears every loss, its own
/// destroy() included, and recovers; without one a loss stays fatal as above.
static void onDeviceLost(WGPUDevice const* device, WGPUDeviceLostReason reason, WGPUStringView message, void* userdata1, void* userdata2) {
    (void)device;
    (void)userdata2;
    auto* context = static_cast<mystral::webgpu::Context*>(userdata1);
    if (context && context->notifyDeviceLost(static_cast<uint32_t>(reason), WGPU_PRINT_STRING_VIEW(message).c_str())) return;
    if (reason == WGPUDeviceLostReason_Destroyed) return;
    reportFatalDeviceLoss(WGPU_PRINT_STRING_VIEW(message));
}
#else
// wgpu-native callback signatures
static void onAdapterRequestEnded(WGPURequestAdapterStatus status, WGPUAdapter adapter, char const* message, void* userdata) {
    auto* data = static_cast<AdapterRequestData*>(userdata);
    if (status == WGPURequestAdapterStatus_Success) {
        data->adapter = adapter;
        std::cout << "[WebGPU] Adapter acquired successfully" << std::endl;
    } else {
        std::cerr << "[WebGPU] Failed to request adapter: " << (message ? message : "unknown error") << std::endl;
        TN_CONTEXT_LOGE("Failed to request adapter: %s", message ? message : "unknown error");
    }
    data->completed = true;
}

static void onDeviceRequestEnded(WGPURequestDeviceStatus status, WGPUDevice device, char const* message, void* userdata) {
    auto* data = static_cast<DeviceRequestData*>(userdata);
    if (status == WGPURequestDeviceStatus_Success) {
        data->device = device;
        std::cout << "[WebGPU] Device acquired successfully" << std::endl;
    } else {
        std::cerr << "[WebGPU] Failed to request device: " << (message ? message : "unknown error") << std::endl;
        TN_CONTEXT_LOGE("Failed to request device: %s", message ? message : "unknown error");
    }
    data->completed = true;
}

static void onDeviceError(WGPUErrorType type, char const* message, void* userdata) {
    const char* typeStr = "Unknown";
    switch (type) {
        case WGPUErrorType_NoError: typeStr = "NoError"; break;
        case WGPUErrorType_Validation: typeStr = "Validation"; break;
        case WGPUErrorType_OutOfMemory: typeStr = "OutOfMemory"; break;
        case WGPUErrorType_Internal: typeStr = "Internal"; break;
        case WGPUErrorType_Unknown: typeStr = "Unknown"; break;
        case WGPUErrorType_DeviceLost_Compat: typeStr = "DeviceLost"; break;
        default: break;
    }
    std::cerr << "[WebGPU] Device error (" << typeStr << "): " << (message ? message : "no message") << std::endl;
    TN_CONTEXT_LOGE("Device error (%s): %s", typeStr, message ? message : "no message");
    // This path has no device-lost callback; it reports the loss as an error type instead.
    if (type == WGPUErrorType_DeviceLost_Compat) reportFatalDeviceLoss(message ? message : "no message");
}
#endif

/// Every device this runtime creates reports the same way, and three call sites used to say only
/// half of it. Whatever is added here reaches all of them.
static void installDeviceCallbacks(WGPUDeviceDescriptor& deviceDesc, mystral::webgpu::Context* context) {
    WGPUUncapturedErrorCallbackInfo errorCallbackInfo = {};
    errorCallbackInfo.callback = onDeviceError;
    deviceDesc.uncapturedErrorCallbackInfo = errorCallbackInfo;
#if WGPU_USES_CALLBACK_INFO_PATTERN
    WGPUDeviceLostCallbackInfo lostCallbackInfo = {};
    lostCallbackInfo.mode = WGPUCallbackMode_AllowSpontaneous;
    lostCallbackInfo.callback = onDeviceLost;
    lostCallbackInfo.userdata1 = context;
    deviceDesc.deviceLostCallbackInfo = lostCallbackInfo;
#else
    (void)context;
#endif
#if defined(MYSTRAL_WEBGPU_DAWN) && defined(TN_ENGINE_HOST_SERVICES)
    // Dawn rounds timestamp queries to a coarse step by default (a browser's fingerprinting guard),
    // so every pass of a small frame read the same time and the engine's GPU timer measured nothing.
    // Only the native engine's host-services build asks for full resolution; the legacy host is
    // compiled without TN_ENGINE_HOST_SERVICES and keeps Dawn's default.
    static const char* const disabled[] = {"timestamp_quantization"};
    static WGPUDawnTogglesDescriptor toggles = [] {
        WGPUDawnTogglesDescriptor descriptor = {};
        descriptor.chain.sType = WGPUSType_DawnTogglesDescriptor;
        descriptor.disabledToggleCount = 1;
        descriptor.disabledToggles = disabled;
        return descriptor;
    }();
    deviceDesc.nextInChain = &toggles.chain;
#endif
}

#if defined(MYSTRAL_WEBGPU_WGPU)
#if defined(MYSTRAL_WEBGPU_WGPU_MODERN)
static void onWgpuLog(WGPULogLevel level, WGPUStringView message, void* userdata) {
    const std::string messageText = WGPU_PRINT_STRING_VIEW(message);
#else
static void onWgpuLog(WGPULogLevel level, char const* message, void* userdata) {
#endif
    const char* levelStr = "???";
    switch (level) {
        case WGPULogLevel_Error: levelStr = "ERROR"; break;
        case WGPULogLevel_Warn: levelStr = "WARN"; break;
        case WGPULogLevel_Info: levelStr = "INFO"; break;
        case WGPULogLevel_Debug: levelStr = "DEBUG"; break;
        case WGPULogLevel_Trace: levelStr = "TRACE"; break;
        default: break;
    }
#if defined(MYSTRAL_WEBGPU_WGPU_MODERN)
    std::cout << "[wgpu " << levelStr << "] " << messageText << std::endl;
    if (level == WGPULogLevel_Error) {
        TN_CONTEXT_LOGE("wgpu %s: %s", levelStr, messageText.c_str());
    } else {
        TN_CONTEXT_LOGI("wgpu %s: %s", levelStr, messageText.c_str());
    }
#else
    std::cout << "[wgpu " << levelStr << "] " << (message ? message : "") << std::endl;
    if (level == WGPULogLevel_Error) {
        TN_CONTEXT_LOGE("wgpu %s: %s", levelStr, message ? message : "");
    } else {
        TN_CONTEXT_LOGI("wgpu %s: %s", levelStr, message ? message : "");
    }
#endif
}
#endif

/**
 * Names every feature the device was actually granted, once per device creation.
 *
 * Dawn and wgpu both report only features that were *requested*, and this file asks for them in
 * six separate hand-written arrays across three backends and two entry points. A branch that
 * forgets one — or whose bound stops the array short — loses `timestamp-query` and with it the GPU
 * meter, silently, invisibly from JavaScript. Nobody knew whether the meter could work on Android
 * until it was tried on a phone, which is exactly the state this line ends.
 *
 * Asked per feature rather than enumerated, because the enumeration call differs across the header
 * versions this host builds against while `wgpuDeviceHasFeature` does not.
 */
static void reportGrantedFeatures(WGPUDevice device) {
    if (device == nullptr) return;
    struct NamedFeature {
        WGPUFeatureName feature;
        char const* name;
    };
    static NamedFeature const kFeatures[] = {
        {WGPUFeatureName_TimestampQuery, "timestamp-query"},
#if defined(MYSTRAL_WEBGPU_WGPU_MODERN) && defined(__ANDROID__)
        {static_cast<WGPUFeatureName>(WGPUNativeFeature_TextureAdapterSpecificFormatFeatures), "texture-adapter-specific-format-features"},
#endif
        {WGPUFeatureName_TextureCompressionBC, "texture-compression-bc"},
        {WGPUFeatureName_TextureCompressionETC2, "texture-compression-etc2"},
        {WGPUFeatureName_TextureCompressionASTC, "texture-compression-astc"},
        {WGPUFeatureName_IndirectFirstInstance, "indirect-first-instance"},
        {WGPUFeatureName_RG11B10UfloatRenderable, "rg11b10ufloat-renderable"},
#if defined(MYSTRAL_WEBGPU_DAWN)
        {WGPUFeatureName_TransientAttachments, "transient-attachments"},
#endif
#if MYSTRAL_HAS_CORE_FEATURES_AND_LIMITS
        {WGPUFeatureName_CoreFeaturesAndLimits, "core-features-and-limits"},
#endif
    };
    std::cout << "[WebGPU] TN_WEBGPU_FEATURES:{";
    bool first = true;
    for (NamedFeature const& entry : kFeatures) {
        std::cout << (first ? "" : ",") << "\"" << entry.name
                  << "\":" << (wgpuDeviceHasFeature(device, entry.feature) ? "true" : "false");
        first = false;
    }
    std::cout << "}" << std::endl;
}

struct RequiredFeatures {
    std::vector<WGPUFeatureName> names;
    bool hasIndirectFirstInstance = false;
    bool hasTimestampQuery = false;
    bool hasPipelineCache = false;
};

static RequiredFeatures buildRequiredFeatures(WGPUAdapter adapter,
                                              bool allowIndirectFirstInstance) {
    RequiredFeatures result;
    const auto appendIfSupported = [&](WGPUFeatureName feature, const char* label) {
        const bool supported = wgpuAdapterHasFeature(adapter, feature) != 0;
        std::cout << "[WebGPU] adapter feature probe " << label << ": "
                  << (supported ? "yes" : "no") << std::endl;
        if (supported) result.names.push_back(feature);
        return supported;
    };

    if (allowIndirectFirstInstance) {
        result.hasIndirectFirstInstance =
            appendIfSupported(WGPUFeatureName_IndirectFirstInstance, "indirect-first-instance");
        if (result.hasIndirectFirstInstance)
            std::cout << "[WebGPU] Requesting IndirectFirstInstance feature (supported)"
                      << std::endl;
    } else {
        std::cout << "[WebGPU] IndirectFirstInstance feature disabled for this Android backend"
                  << std::endl;
    }

#if defined(MYSTRAL_WEBGPU_WGPU_MODERN) && defined(__ANDROID__)
    // wgpu's own extension, and only wgpu declares it: without it an adapter that advertises a
    // compressed format still refuses the adapter-specific format capabilities three's KTX2 path
    // relies on. It lived in the Android branch alone before this builder existed; asking for it
    // here means all three device-creation paths ask for the same set on that backend.
    appendIfSupported(
        static_cast<WGPUFeatureName>(WGPUNativeFeature_TextureAdapterSpecificFormatFeatures),
        "texture-adapter-specific-format-features");
#endif
#if defined(MYSTRAL_WEBGPU_DAWN) && defined(TN_ENGINE_HOST_SERVICES)
    // Dawn locks the device around each call only when asked: the engine's GPU thread submits and
    // presents while the game thread encodes, and pipeline workers create pipelines (PRD-610 AC-9).
    appendIfSupported(WGPUFeatureName_ImplicitDeviceSynchronization, "implicit-device-synchronization");
#endif
    appendIfSupported(WGPUFeatureName_TextureCompressionBC, "texture-compression-bc");
    appendIfSupported(WGPUFeatureName_TextureCompressionETC2, "texture-compression-etc2");
    appendIfSupported(WGPUFeatureName_TextureCompressionASTC, "texture-compression-astc");
    result.hasTimestampQuery =
        appendIfSupported(WGPUFeatureName_TimestampQuery, "timestamp-query");
#if defined(MYSTRAL_WGPU_PIPELINE_CACHE)
    // PRD-368 Phase 1B: the maintained cache API patch exposes this feature on wgpu-native, and
    // `MYSTRAL_WGPU_PIPELINE_CACHE` is defined only when the installed header declares it.
    // Requested only when the adapter advertises it; absence keeps the old no-cache behavior.
    result.hasPipelineCache = appendIfSupported(
        static_cast<WGPUFeatureName>(WGPUNativeFeature_PipelineCache), "pipeline-cache");
#endif
    appendIfSupported(WGPUFeatureName_RG11B10UfloatRenderable, "rg11b10ufloat-renderable");
    // Float LUTs need linear filtering for continuous color grading.
    appendIfSupported(WGPUFeatureName_Float32Filterable, "float32-filterable");
#if defined(MYSTRAL_WEBGPU_DAWN)
    // Comparison control: omit the feature at device creation, preserving ordinary allocations.
    const char* transientControl = std::getenv("TN_TRANSIENT_ATTACHMENTS");
    if (!transientControl || std::strcmp(transientControl, "0") != 0)
        appendIfSupported(WGPUFeatureName_TransientAttachments, "transient-attachments");
#endif
#if MYSTRAL_HAS_CORE_FEATURES_AND_LIMITS
    appendIfSupported(WGPUFeatureName_CoreFeaturesAndLimits, "core-features-and-limits");
#endif
    return result;
}

Context::Context() = default;

Context::~Context() {
    releaseSurfaceView();
    // Clean up offscreen resources
    if (offscreenTextureView_) {
        wgpuTextureViewRelease((WGPUTextureView)offscreenTextureView_);
        offscreenTextureView_ = nullptr;
    }
    if (offscreenTexture_) {
        wgpuTextureRelease((WGPUTexture)offscreenTexture_);
        offscreenTexture_ = nullptr;
    }
    if (surface_) {
        wgpuSurfaceRelease(surface_);
        surface_ = nullptr;
    }
#if defined(TN_ENGINE_HOST_SERVICES)
    // The engine's tests build and destroy many contexts in one process; the legacy host keeps its
    // queue reference as it always has.
    if (queue_) {
        wgpuQueueRelease(queue_);
        queue_ = nullptr;
    }
#endif
    if (device_) {
        wgpuDeviceRelease(device_);
        device_ = nullptr;
    }
    if (adapter_) {
        wgpuAdapterRelease(adapter_);
        adapter_ = nullptr;
    }
    if (instance_) {
        wgpuInstanceRelease(instance_);
        instance_ = nullptr;
    }
    std::cout << "[WebGPU] Context destroyed" << std::endl;
}

bool Context::initialize() {
    std::cout << "[WebGPU] Initializing..." << std::endl;

#if defined(MYSTRAL_WEBGPU_DAWN) && defined(_WIN32)
    // Windows Dawn (from Skia build) requires setting up the proc table before any WebGPU calls
    // This connects the wgpu* function calls to Dawn's actual implementation
    // Linux/macOS Dawn releases have direct implementations and don't need this
    dawnProcSetProcs(&dawn::native::GetProcs());
    std::cout << "[WebGPU] Dawn proc table initialized" << std::endl;
#endif

#if defined(MYSTRAL_WEBGPU_WGPU)
    // Set up wgpu-native logging
    // Use Error level to suppress noisy warnings like "Depth slice on color attachments is not implemented"
    wgpuSetLogCallback(onWgpuLog, nullptr);
    wgpuSetLogLevel(WGPULogLevel_Error);
    // Quiet startup produces no callback, so publish one deterministic heartbeat. Android
    // conformance uses this to prove that an empty error log is observable rather than lost.
    TN_CONTEXT_LOGI("channel ready");

    // Create instance with Metal backend on macOS
    WGPUInstanceExtras instanceExtras = {};
    instanceExtras.chain.sType = (WGPUSType)WGPUSType_InstanceExtras;
#if defined(__APPLE__)
    instanceExtras.backends = WGPUInstanceBackend_Metal;
#elif defined(_WIN32)
    instanceExtras.backends = WGPUInstanceBackend_DX12 | WGPUInstanceBackend_Vulkan;
#else
    instanceExtras.backends = WGPUInstanceBackend_Vulkan;
#endif
    instanceExtras.flags = WGPUInstanceFlag_Validation;

    WGPUInstanceDescriptor instanceDesc = {};
    instanceDesc.nextInChain = (WGPUChainedStruct*)&instanceExtras;
#else
    WGPUInstanceDescriptor instanceDesc = {};
#endif

    instance_ = wgpuCreateInstance(&instanceDesc);
    if (!instance_) {
        std::cerr << "[WebGPU] Failed to create instance" << std::endl;
        return false;
    }
    std::cout << "[WebGPU] Instance created" << std::endl;

    initialized_ = true;
    return true;
}

bool Context::initializeHeadless() {
    std::cout << "[WebGPU] Initializing headless mode (no SDL)..." << std::endl;

    // First initialize the instance
    if (!initialize()) {
        return false;
    }

    headless_ = true;

    // Request adapter WITHOUT a compatible surface
    WGPURequestAdapterOptions adapterOptions = {};
    adapterOptions.compatibleSurface = nullptr;  // No surface required
    adapterOptions.powerPreference = WGPUPowerPreference_HighPerformance;

    AdapterRequestData adapterData;

#if WGPU_USES_CALLBACK_INFO_PATTERN
    WGPURequestAdapterCallbackInfo callbackInfo = {};
    callbackInfo.mode = WGPUCallbackMode_AllowProcessEvents;
    callbackInfo.callback = onAdapterRequestEnded;
    callbackInfo.userdata1 = &adapterData;
    callbackInfo.userdata2 = nullptr;
    wgpuInstanceRequestAdapter(instance_, &adapterOptions, callbackInfo);
#else
    wgpuInstanceRequestAdapter(instance_, &adapterOptions, onAdapterRequestEnded, &adapterData);
#endif

#if defined(MYSTRAL_WEBGPU_WGPU)
    while (!adapterData.completed) {
        wgpuInstanceProcessEvents(instance_);
    }
#elif defined(MYSTRAL_WEBGPU_DAWN)
    while (!adapterData.completed) {
        wgpuInstanceProcessEvents(instance_);
    }
#endif

    if (!adapterData.adapter) {
        std::cerr << "[WebGPU] Failed to get adapter in headless mode" << std::endl;
        return false;
    }
    adapter_ = adapterData.adapter;

    // Print adapter info
    WGPUAdapterInfo adapterInfo = {};
    wgpuAdapterGetInfo(adapter_, &adapterInfo);
    std::cout << "[WebGPU] Headless adapter: " << WGPU_PRINT_STRING_VIEW(adapterInfo.device) << std::endl;
    std::cout << "[WebGPU] Backend: ";
    switch (adapterInfo.backendType) {
        case WGPUBackendType_Null: std::cout << "Null"; break;
        case WGPUBackendType_WebGPU: std::cout << "WebGPU"; break;
        case WGPUBackendType_D3D11: std::cout << "D3D11"; break;
        case WGPUBackendType_D3D12: std::cout << "D3D12"; break;
        case WGPUBackendType_Metal: std::cout << "Metal"; break;
        case WGPUBackendType_Vulkan: std::cout << "Vulkan"; break;
        case WGPUBackendType_OpenGL: std::cout << "OpenGL"; break;
        case WGPUBackendType_OpenGLES: std::cout << "OpenGLES"; break;
        default: std::cout << "Unknown"; break;
    }
    std::cout << std::endl;
    wgpuAdapterInfoFreeMembers(adapterInfo);

    // Request device
    WGPUDeviceDescriptor deviceDesc = {};
    WGPU_SET_LABEL(deviceDesc, "Mystral Headless Device");

#if defined(MYSTRAL_WEBGPU_WGPU_MODERN) && defined(__ANDROID__)
    WGPULimits adapterLimits = {};
    wgpuAdapterGetLimits(adapter_, &adapterLimits);
    WGPULimits requiredLimits = adapterLimits;
    const uint32_t neededBytesPerSample = 64;
    if (adapterLimits.maxColorAttachmentBytesPerSample >= neededBytesPerSample)
        requiredLimits.maxColorAttachmentBytesPerSample = neededBytesPerSample;
    deviceDesc.requiredLimits = &requiredLimits;
    // The emulator workaround stays scoped to the feature it names: Android
    // emulator Vulkan can advertise IndirectFirstInstance through WebGPU while
    // rejecting it when the HAL opens the device. Dropping every feature was
    // collateral damage — three's KTX2Loader saw no compressed format and
    // createAssetLoader threw TN_ASSETS_KTX2_UNSUPPORTED at boot on physical
    // devices too (docs/bugs/android-ktx2-unsupported-2026-08-23.md).
    // Compression features are requested when the adapter advertises them,
    // mirroring the non-Android branches below; a format the hardware lacks
    // stays unrequested and truthfully absent from the device's feature set.
#elif defined(MYSTRAL_WEBGPU_DAWN) || defined(MYSTRAL_WEBGPU_WGPU_MODERN)
    WGPULimits adapterLimits = {};
    wgpuAdapterGetLimits(adapter_, &adapterLimits);
    WGPULimits requiredLimits = adapterLimits;
    const uint32_t neededBytesPerSample = 64;
    if (adapterLimits.maxColorAttachmentBytesPerSample >= neededBytesPerSample)
        requiredLimits.maxColorAttachmentBytesPerSample = neededBytesPerSample;
    deviceDesc.requiredLimits = &requiredLimits;
#elif defined(MYSTRAL_WEBGPU_WGPU)
    WGPUSupportedLimits adapterLimits = {};
    wgpuAdapterGetLimits(adapter_, &adapterLimits);
    WGPURequiredLimits requiredLimits = {};
    requiredLimits.limits = adapterLimits.limits;
    const uint32_t neededBytesPerSample = 64;
    if (adapterLimits.limits.maxColorAttachmentBytesPerSample >= neededBytesPerSample)
        requiredLimits.limits.maxColorAttachmentBytesPerSample = neededBytesPerSample;
    deviceDesc.requiredLimits = &requiredLimits;
#endif

#if defined(MYSTRAL_WEBGPU_WGPU_MODERN) && defined(__ANDROID__)
    const bool allowIndirectFirstInstance = false;
#else
    const bool allowIndirectFirstInstance = true;
#endif
    const auto requiredFeatures = buildRequiredFeatures(adapter_, allowIndirectFirstInstance);
    hasIndirectFirstInstance_ = requiredFeatures.hasIndirectFirstInstance;
    hasTimestampQuery_ = requiredFeatures.hasTimestampQuery;
    deviceDesc.requiredFeatureCount = requiredFeatures.names.size();
    deviceDesc.requiredFeatures = !requiredFeatures.names.empty() ? requiredFeatures.names.data() : nullptr;

    installDeviceCallbacks(deviceDesc, this);

    DeviceRequestData deviceData;

#if WGPU_USES_CALLBACK_INFO_PATTERN
    WGPURequestDeviceCallbackInfo deviceCallbackInfo = {};
    deviceCallbackInfo.mode = WGPUCallbackMode_AllowProcessEvents;
    deviceCallbackInfo.callback = onDeviceRequestEnded;
    deviceCallbackInfo.userdata1 = &deviceData;
    deviceCallbackInfo.userdata2 = nullptr;
    wgpuAdapterRequestDevice(adapter_, &deviceDesc, deviceCallbackInfo);
#else
    wgpuAdapterRequestDevice(adapter_, &deviceDesc, onDeviceRequestEnded, &deviceData);
#endif

#if defined(MYSTRAL_WEBGPU_WGPU)
    while (!deviceData.completed) {
        wgpuInstanceProcessEvents(instance_);
    }
#elif defined(MYSTRAL_WEBGPU_DAWN)
    while (!deviceData.completed) {
        wgpuInstanceProcessEvents(instance_);
    }
#endif

    if (!deviceData.device) {
        std::cerr << "[WebGPU] Failed to get device in headless mode" << std::endl;
        return false;
    }
    device_ = deviceData.device;
    ++deviceCreations_;
    reportGrantedFeatures(device_);

    queue_ = wgpuDeviceGetQueue(device_);
    if (!queue_) {
        std::cerr << "[WebGPU] Failed to get queue in headless mode" << std::endl;
        return false;
    }

    std::cout << "[WebGPU] Headless mode initialized successfully" << std::endl;
    return true;
}

bool Context::createOffscreenTarget(uint32_t width, uint32_t height) {
    if (!device_) {
        std::cerr << "[WebGPU] Cannot create offscreen target: no device" << std::endl;
        return false;
    }

    std::cout << "[WebGPU] Creating offscreen render target: " << width << "x" << height << std::endl;

    surfaceWidth_ = width;
    surfaceHeight_ = height;

    // Use BGRA8Unorm format (same as surface format for compatibility)
    preferredFormat_ = WGPUTextureFormat_BGRA8Unorm;

    // Create offscreen texture
    WGPUTextureDescriptor textureDesc = {};
    WGPU_SET_LABEL(textureDesc, "Offscreen Render Target");
    textureDesc.usage = WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_CopySrc;
    textureDesc.dimension = WGPUTextureDimension_2D;
    textureDesc.size = {width, height, 1};
    textureDesc.format = (WGPUTextureFormat)preferredFormat_;
    textureDesc.mipLevelCount = 1;
    textureDesc.sampleCount = 1;

    WGPUTexture texture = wgpuDeviceCreateTexture(device_, &textureDesc);
    if (!texture) {
        std::cerr << "[WebGPU] Failed to create offscreen texture" << std::endl;
        return false;
    }
    offscreenTexture_ = texture;

    // Create texture view
    WGPUTextureViewDescriptor viewDesc = {};
    viewDesc.format = (WGPUTextureFormat)preferredFormat_;
    viewDesc.dimension = WGPUTextureViewDimension_2D;
    viewDesc.baseMipLevel = 0;
    viewDesc.mipLevelCount = 1;
    viewDesc.baseArrayLayer = 0;
    viewDesc.arrayLayerCount = 1;
    viewDesc.aspect = WGPUTextureAspect_All;

    WGPUTextureView view = wgpuTextureCreateView(texture, &viewDesc);
    if (!view) {
        std::cerr << "[WebGPU] Failed to create offscreen texture view" << std::endl;
        return false;
    }
    offscreenTextureView_ = view;

    std::cout << "[WebGPU] Offscreen render target created" << std::endl;
    return true;
}

WGPUSurface Context::makeSurface(void* nativeHandle, int platformType) {
    if (!instance_) {
        std::cerr << "[WebGPU] Cannot create surface: no instance" << std::endl;
        return nullptr;
    }

    std::cout << "[WebGPU] Creating surface for platform type " << platformType << std::endl;

    WGPUSurfaceDescriptor surfaceDesc = {};

    // Declare platform-specific descriptors outside the switch to avoid use-after-free
    // (the pointer in nextInChain must remain valid until wgpuInstanceCreateSurface returns)
#if defined(__APPLE__)
    WGPUSurfaceDescriptorFromMetalLayer_Compat metalDesc = {};
#endif
#if defined(_WIN32)
    WGPUSurfaceDescriptorFromWindowsHWND_Compat windowsDesc = {};
#endif
#if defined(__ANDROID__)
    WGPUSurfaceDescriptorFromAndroidNativeWindow_Compat androidDesc = {};
#endif
#if defined(__linux__) && !defined(__ANDROID__)
    WGPUSurfaceDescriptorFromXlibWindow_Compat xlibDesc = {};
#endif

    switch (platformType) {
#if defined(__APPLE__)
        case PLATFORM_METAL:
            metalDesc.chain.sType = WGPUSType_SurfaceDescriptorFromMetalLayer_Compat;
            metalDesc.layer = nativeHandle;
            surfaceDesc.nextInChain = (WGPUChainedStruct*)&metalDesc;
            break;
#endif
#if defined(_WIN32)
        case PLATFORM_WINDOWS:
            windowsDesc.chain.sType = WGPUSType_SurfaceDescriptorFromWindowsHWND_Compat;
            windowsDesc.hinstance = GetModuleHandle(NULL);
            windowsDesc.hwnd = nativeHandle;
            surfaceDesc.nextInChain = (WGPUChainedStruct*)&windowsDesc;
            break;
#endif
#if defined(__ANDROID__)
        case PLATFORM_ANDROID:
            androidDesc.chain.sType = WGPUSType_SurfaceDescriptorFromAndroidNativeWindow_Compat;
            androidDesc.window = nativeHandle;
            surfaceDesc.nextInChain = (WGPUChainedStruct*)&androidDesc;
            std::cout << "[WebGPU] Creating Android surface with ANativeWindow: " << nativeHandle << std::endl;
            break;
#endif
#if defined(__linux__) && !defined(__ANDROID__)
        case PLATFORM_XLIB:
            xlibDesc.chain.sType = WGPUSType_SurfaceDescriptorFromXlibWindow_Compat;
            xlibDesc.display = nullptr;  // Will be set by wgpu from the environment
            xlibDesc.window = reinterpret_cast<uint64_t>(nativeHandle);
            surfaceDesc.nextInChain = (WGPUChainedStruct*)&xlibDesc;
            std::cout << "[WebGPU] Creating X11 surface with window: " << nativeHandle << std::endl;
            break;
#endif
        default:
            std::cerr << "[WebGPU] Unsupported platform type: " << platformType << std::endl;
            return nullptr;
    }

    WGPUSurface created = wgpuInstanceCreateSurface(instance_, &surfaceDesc);
    if (!created) {
        std::cerr << "[WebGPU] Failed to create surface" << std::endl;
        return nullptr;
    }
    ++surfaceCreations_;
    std::cout << "[WebGPU] Surface created" << std::endl;
    return created;
}

bool Context::createSurface(void* nativeHandle, int platformType) {
    surface_ = makeSurface(nativeHandle, platformType);
    if (!surface_) return false;
    surfaceNativeHandle_ = nativeHandle;
    surfacePlatformType_ = platformType;

    // Now request adapter with surface compatibility
    WGPURequestAdapterOptions adapterOptions = {};
    adapterOptions.compatibleSurface = surface_;
    adapterOptions.powerPreference = WGPUPowerPreference_HighPerformance;

    AdapterRequestData adapterData;

#if WGPU_USES_CALLBACK_INFO_PATTERN
    // Dawn uses CallbackInfo struct with required callback mode
    WGPURequestAdapterCallbackInfo callbackInfo = {};
    callbackInfo.mode = WGPUCallbackMode_AllowProcessEvents;
    callbackInfo.callback = onAdapterRequestEnded;
    callbackInfo.userdata1 = &adapterData;
    callbackInfo.userdata2 = nullptr;
    wgpuInstanceRequestAdapter(instance_, &adapterOptions, callbackInfo);
#else
    // wgpu-native uses separate callback and userdata
    wgpuInstanceRequestAdapter(instance_, &adapterOptions, onAdapterRequestEnded, &adapterData);
#endif

    // wgpu-native is synchronous for requestAdapter, but we should poll just in case
#if defined(MYSTRAL_WEBGPU_WGPU)
    while (!adapterData.completed) {
        wgpuInstanceProcessEvents(instance_);
    }
#elif defined(MYSTRAL_WEBGPU_DAWN)
    // Dawn also needs event processing
    while (!adapterData.completed) {
        wgpuInstanceProcessEvents(instance_);
    }
#endif

    if (!adapterData.adapter) {
        std::cerr << "[WebGPU] Failed to get adapter" << std::endl;
        return false;
    }
    adapter_ = adapterData.adapter;

    // Print adapter info
    WGPUAdapterInfo adapterInfo = {};
    wgpuAdapterGetInfo(adapter_, &adapterInfo);
    std::cout << "[WebGPU] Adapter: " << WGPU_PRINT_STRING_VIEW(adapterInfo.device) << std::endl;
    std::cout << "[WebGPU] Vendor: " << WGPU_PRINT_STRING_VIEW(adapterInfo.vendor) << std::endl;
    std::cout << "[WebGPU] Backend: ";
    switch (adapterInfo.backendType) {
        case WGPUBackendType_Null: std::cout << "Null"; break;
        case WGPUBackendType_WebGPU: std::cout << "WebGPU"; break;
        case WGPUBackendType_D3D11: std::cout << "D3D11"; break;
        case WGPUBackendType_D3D12: std::cout << "D3D12"; break;
        case WGPUBackendType_Metal: std::cout << "Metal"; break;
        case WGPUBackendType_Vulkan: std::cout << "Vulkan"; break;
        case WGPUBackendType_OpenGL: std::cout << "OpenGL"; break;
        case WGPUBackendType_OpenGLES: std::cout << "OpenGLES"; break;
        default: std::cout << "Unknown"; break;
    }
    std::cout << std::endl;
    wgpuAdapterInfoFreeMembers(adapterInfo);

    // Request device with required limits
    WGPUDeviceDescriptor deviceDesc = {};
    WGPU_SET_LABEL(deviceDesc, "Mystral Device");

    // Set up required limits - copy adapter limits and override what we need
    // WebGPU default is 32 bytes per sample, but deferred rendering needs ~40
    // Chrome defaults: https://www.w3.org/TR/webgpu/#limits
#if defined(MYSTRAL_WEBGPU_WGPU_MODERN) && defined(__ANDROID__)
    WGPULimits adapterLimits = {};
    wgpuAdapterGetLimits(adapter_, &adapterLimits);
    WGPULimits requiredLimits = adapterLimits;
    uint32_t neededBytesPerSample = 64;
    if (adapterLimits.maxColorAttachmentBytesPerSample >= neededBytesPerSample) {
        requiredLimits.maxColorAttachmentBytesPerSample = neededBytesPerSample;
    }
    deviceDesc.requiredLimits = &requiredLimits;
#elif defined(MYSTRAL_WEBGPU_DAWN) || defined(MYSTRAL_WEBGPU_WGPU_MODERN)
    // Dawn uses WGPULimits directly
    WGPULimits adapterLimits = {};
    wgpuAdapterGetLimits(adapter_, &adapterLimits);

    // Start with adapter limits as baseline (avoids minimum limit validation errors)
    WGPULimits requiredLimits = adapterLimits;

    // Request higher maxColorAttachmentBytesPerSample for deferred rendering
    uint32_t neededBytesPerSample = 64;  // 4 RGBA16Float + 1 BGRA8 = 40, round up
    if (adapterLimits.maxColorAttachmentBytesPerSample >= neededBytesPerSample) {
        requiredLimits.maxColorAttachmentBytesPerSample = neededBytesPerSample;
        std::cout << "[WebGPU] Requesting maxColorAttachmentBytesPerSample: " << neededBytesPerSample << std::endl;
    }

    deviceDesc.requiredLimits = &requiredLimits;

#elif defined(MYSTRAL_WEBGPU_WGPU)
    // wgpu-native uses WGPURequiredLimits wrapper
    WGPUSupportedLimits adapterLimits = {};
    wgpuAdapterGetLimits(adapter_, &adapterLimits);

    // Start with adapter limits as baseline
    WGPURequiredLimits requiredLimits = {};
    requiredLimits.limits = adapterLimits.limits;

    uint32_t neededBytesPerSample = 64;
    if (adapterLimits.limits.maxColorAttachmentBytesPerSample >= neededBytesPerSample) {
        requiredLimits.limits.maxColorAttachmentBytesPerSample = neededBytesPerSample;
        std::cout << "[WebGPU] Requesting maxColorAttachmentBytesPerSample: " << neededBytesPerSample << std::endl;
    }

    deviceDesc.requiredLimits = &requiredLimits;

#endif

#if defined(MYSTRAL_WEBGPU_WGPU_MODERN) && defined(__ANDROID__)
    const bool allowIndirectFirstInstance = false;
#else
    const bool allowIndirectFirstInstance = true;
#endif
    const auto requiredFeatures = buildRequiredFeatures(adapter_, allowIndirectFirstInstance);
    hasIndirectFirstInstance_ = requiredFeatures.hasIndirectFirstInstance;
    hasTimestampQuery_ = requiredFeatures.hasTimestampQuery;
    deviceDesc.requiredFeatureCount = requiredFeatures.names.size();
    deviceDesc.requiredFeatures = !requiredFeatures.names.empty() ? requiredFeatures.names.data() : nullptr;

    // Set up error callback
    installDeviceCallbacks(deviceDesc, this);

    DeviceRequestData deviceData;

#if WGPU_USES_CALLBACK_INFO_PATTERN
    // Dawn uses CallbackInfo struct with required callback mode
    WGPURequestDeviceCallbackInfo deviceCallbackInfo = {};
    deviceCallbackInfo.mode = WGPUCallbackMode_AllowProcessEvents;
    deviceCallbackInfo.callback = onDeviceRequestEnded;
    deviceCallbackInfo.userdata1 = &deviceData;
    deviceCallbackInfo.userdata2 = nullptr;
    wgpuAdapterRequestDevice(adapter_, &deviceDesc, deviceCallbackInfo);
#else
    // wgpu-native uses separate callback and userdata
    wgpuAdapterRequestDevice(adapter_, &deviceDesc, onDeviceRequestEnded, &deviceData);
#endif

#if defined(MYSTRAL_WEBGPU_WGPU)
    while (!deviceData.completed) {
        wgpuInstanceProcessEvents(instance_);
    }
#elif defined(MYSTRAL_WEBGPU_DAWN)
    while (!deviceData.completed) {
        wgpuInstanceProcessEvents(instance_);
    }
#endif

    if (!deviceData.device) {
        std::cerr << "[WebGPU] Failed to get device" << std::endl;
        return false;
    }
    device_ = deviceData.device;
    ++deviceCreations_;
    reportGrantedFeatures(device_);

    // Get queue
    queue_ = wgpuDeviceGetQueue(device_);
    if (!queue_) {
        std::cerr << "[WebGPU] Failed to get queue" << std::endl;
        return false;
    }
    std::cout << "[WebGPU] Queue acquired" << std::endl;

    return true;
}

bool Context::createSurfaceWithDisplay(void* display, void* window, int platformType) {
    if (!instance_) {
        std::cerr << "[WebGPU] Cannot create surface: no instance" << std::endl;
        return false;
    }

    std::cout << "[WebGPU] Creating surface for platform type " << platformType << " with display pointer" << std::endl;

    WGPUSurfaceDescriptor surfaceDesc = {};

#if defined(__linux__) && !defined(__ANDROID__)
    WGPUSurfaceDescriptorFromXlibWindow_Compat xlibDesc = {};
    WGPUSurfaceDescriptorFromWaylandSurface_Compat waylandDesc = {};

    if (platformType == PLATFORM_XLIB) {
        xlibDesc.chain.sType = WGPUSType_SurfaceDescriptorFromXlibWindow_Compat;
        xlibDesc.display = display;  // Pass the actual X11 Display pointer
        xlibDesc.window = reinterpret_cast<uint64_t>(window);
        surfaceDesc.nextInChain = (WGPUChainedStruct*)&xlibDesc;
        std::cout << "[WebGPU] Creating X11 surface with display: " << display << " window: " << window << std::endl;
    } else if (platformType == PLATFORM_WAYLAND) {
        waylandDesc.chain.sType = WGPUSType_SurfaceDescriptorFromWaylandSurface_Compat;
        waylandDesc.display = display;  // wl_display*
        waylandDesc.surface = window;    // wl_surface*
        surfaceDesc.nextInChain = (WGPUChainedStruct*)&waylandDesc;
        std::cout << "[WebGPU] Creating Wayland surface with display: " << display << " surface: " << window << std::endl;
    } else {
        std::cerr << "[WebGPU] createSurfaceWithDisplay only supports PLATFORM_XLIB or PLATFORM_WAYLAND on Linux" << std::endl;
        return false;
    }
#else
    (void)display;
    (void)window;
    (void)platformType;
    std::cerr << "[WebGPU] createSurfaceWithDisplay is only available on Linux" << std::endl;
    return false;
#endif

    surface_ = wgpuInstanceCreateSurface(instance_, &surfaceDesc);
    if (!surface_) {
        std::cerr << "[WebGPU] Failed to create surface" << std::endl;
        return false;
    }
    ++surfaceCreations_;
    std::cout << "[WebGPU] Surface created" << std::endl;

    // Now request adapter with surface compatibility
    WGPURequestAdapterOptions adapterOptions = {};
    adapterOptions.compatibleSurface = surface_;
    adapterOptions.powerPreference = WGPUPowerPreference_HighPerformance;

    AdapterRequestData adapterData;

#if WGPU_USES_CALLBACK_INFO_PATTERN
    WGPURequestAdapterCallbackInfo callbackInfo = {};
    callbackInfo.mode = WGPUCallbackMode_AllowProcessEvents;
    callbackInfo.callback = onAdapterRequestEnded;
    callbackInfo.userdata1 = &adapterData;
    callbackInfo.userdata2 = nullptr;
    wgpuInstanceRequestAdapter(instance_, &adapterOptions, callbackInfo);
#else
    wgpuInstanceRequestAdapter(instance_, &adapterOptions, onAdapterRequestEnded, &adapterData);
#endif

#if defined(MYSTRAL_WEBGPU_WGPU) || defined(MYSTRAL_WEBGPU_DAWN)
    while (!adapterData.completed) {
        wgpuInstanceProcessEvents(instance_);
    }
#endif

    if (!adapterData.adapter) {
        std::cerr << "[WebGPU] Failed to get adapter" << std::endl;
        return false;
    }
    adapter_ = adapterData.adapter;

    // Print adapter info
    WGPUAdapterInfo adapterInfo = {};
    wgpuAdapterGetInfo(adapter_, &adapterInfo);
    std::cout << "[WebGPU] Adapter: " << WGPU_PRINT_STRING_VIEW(adapterInfo.device) << std::endl;
    std::cout << "[WebGPU] Vendor: " << WGPU_PRINT_STRING_VIEW(adapterInfo.vendor) << std::endl;
    std::cout << "[WebGPU] Backend: ";
    switch (adapterInfo.backendType) {
        case WGPUBackendType_Null: std::cout << "Null"; break;
        case WGPUBackendType_WebGPU: std::cout << "WebGPU"; break;
        case WGPUBackendType_D3D11: std::cout << "D3D11"; break;
        case WGPUBackendType_D3D12: std::cout << "D3D12"; break;
        case WGPUBackendType_Metal: std::cout << "Metal"; break;
        case WGPUBackendType_Vulkan: std::cout << "Vulkan"; break;
        case WGPUBackendType_OpenGL: std::cout << "OpenGL"; break;
        case WGPUBackendType_OpenGLES: std::cout << "OpenGLES"; break;
        default: std::cout << "Unknown"; break;
    }
    std::cout << std::endl;
    wgpuAdapterInfoFreeMembers(adapterInfo);

    // Request device with required limits - same as createSurface
    WGPUDeviceDescriptor deviceDesc = {};
    WGPU_SET_LABEL(deviceDesc, "Mystral Device");

#if defined(MYSTRAL_WEBGPU_WGPU_MODERN) && defined(__ANDROID__)
    WGPULimits adapterLimits = {};
    wgpuAdapterGetLimits(adapter_, &adapterLimits);
    WGPULimits requiredLimits = adapterLimits;
    uint32_t neededBytesPerSample = 64;
    if (adapterLimits.maxColorAttachmentBytesPerSample >= neededBytesPerSample) {
        requiredLimits.maxColorAttachmentBytesPerSample = neededBytesPerSample;
    }
    deviceDesc.requiredLimits = &requiredLimits;
#elif defined(MYSTRAL_WEBGPU_DAWN) || defined(MYSTRAL_WEBGPU_WGPU_MODERN)
    WGPULimits adapterLimits = {};
    wgpuAdapterGetLimits(adapter_, &adapterLimits);
    WGPULimits requiredLimits = adapterLimits;
    uint32_t neededBytesPerSample = 64;
    if (adapterLimits.maxColorAttachmentBytesPerSample >= neededBytesPerSample) {
        requiredLimits.maxColorAttachmentBytesPerSample = neededBytesPerSample;
    }
    deviceDesc.requiredLimits = &requiredLimits;

#elif defined(MYSTRAL_WEBGPU_WGPU)
    WGPUSupportedLimits adapterLimits = {};
    wgpuAdapterGetLimits(adapter_, &adapterLimits);
    WGPURequiredLimits requiredLimits = {};
    requiredLimits.limits = adapterLimits.limits;
    uint32_t neededBytesPerSample = 64;
    if (adapterLimits.limits.maxColorAttachmentBytesPerSample >= neededBytesPerSample) {
        requiredLimits.limits.maxColorAttachmentBytesPerSample = neededBytesPerSample;
    }
    deviceDesc.requiredLimits = &requiredLimits;

#endif

#if defined(MYSTRAL_WEBGPU_WGPU_MODERN) && defined(__ANDROID__)
    const bool allowIndirectFirstInstance = false;
#else
    const bool allowIndirectFirstInstance = true;
#endif
    const auto requiredFeatures = buildRequiredFeatures(adapter_, allowIndirectFirstInstance);
    hasIndirectFirstInstance_ = requiredFeatures.hasIndirectFirstInstance;
    hasTimestampQuery_ = requiredFeatures.hasTimestampQuery;
    deviceDesc.requiredFeatureCount = requiredFeatures.names.size();
    deviceDesc.requiredFeatures = !requiredFeatures.names.empty() ? requiredFeatures.names.data() : nullptr;

    installDeviceCallbacks(deviceDesc, this);

    DeviceRequestData deviceData;

#if WGPU_USES_CALLBACK_INFO_PATTERN
    WGPURequestDeviceCallbackInfo deviceCallbackInfo = {};
    deviceCallbackInfo.mode = WGPUCallbackMode_AllowProcessEvents;
    deviceCallbackInfo.callback = onDeviceRequestEnded;
    deviceCallbackInfo.userdata1 = &deviceData;
    deviceCallbackInfo.userdata2 = nullptr;
    wgpuAdapterRequestDevice(adapter_, &deviceDesc, deviceCallbackInfo);
#else
    wgpuAdapterRequestDevice(adapter_, &deviceDesc, onDeviceRequestEnded, &deviceData);
#endif

#if defined(MYSTRAL_WEBGPU_WGPU) || defined(MYSTRAL_WEBGPU_DAWN)
    while (!deviceData.completed) {
        wgpuInstanceProcessEvents(instance_);
    }
#endif

    if (!deviceData.device) {
        std::cerr << "[WebGPU] Failed to get device" << std::endl;
        return false;
    }
    device_ = deviceData.device;
    ++deviceCreations_;
    reportGrantedFeatures(device_);

    queue_ = wgpuDeviceGetQueue(device_);
    if (!queue_) {
        std::cerr << "[WebGPU] Failed to get queue" << std::endl;
        return false;
    }
    std::cout << "[WebGPU] Queue acquired" << std::endl;

    return true;
}

bool Context::configureSurface(uint32_t width, uint32_t height, bool vsync) {
    std::cout << "[WebGPU] configureSurface called: " << width << "x" << height << std::endl;
    std::cout << "[WebGPU] surface_=" << (void*)surface_ << ", device_=" << (void*)device_ << ", adapter_=" << (void*)adapter_ << std::endl;

    if (!surface_ || !device_) {
        std::cerr << "[WebGPU] Cannot configure surface: missing surface or device" << std::endl;
        return false;
    }

    if (!adapter_) {
        std::cerr << "[WebGPU] Cannot configure surface: missing adapter" << std::endl;
        return false;
    }

    releaseSurfaceView();
    surfaceWidth_ = width;
    surfaceHeight_ = height;

    // Get surface capabilities
    std::cout << "[WebGPU] Getting surface capabilities..." << std::endl;
    WGPUSurfaceCapabilities capabilities = {};
    wgpuSurfaceGetCapabilities(surface_, adapter_, &capabilities);
    std::cout << "[WebGPU] Got capabilities: formatCount=" << capabilities.formatCount << std::endl;

    if (capabilities.formatCount == 0) {
        std::cerr << "[WebGPU] No surface formats available" << std::endl;
        wgpuSurfaceCapabilitiesFreeMembers(capabilities);
        return false;
    }

    WGPUPresentMode selectedPresentMode = WGPUPresentMode_Fifo;
    const char* selectedPresentModeName = "fifo";
    if (!vsync) {
        bool foundUncappedMode = false;
        for (uint32_t i = 0; i < capabilities.presentModeCount; i++) {
            if (capabilities.presentModes[i] == WGPUPresentMode_Immediate) {
                selectedPresentMode = WGPUPresentMode_Immediate;
                selectedPresentModeName = "immediate";
                foundUncappedMode = true;
                break;
            }
            if (capabilities.presentModes[i] == WGPUPresentMode_Mailbox) {
                selectedPresentMode = WGPUPresentMode_Mailbox;
                selectedPresentModeName = "mailbox";
                foundUncappedMode = true;
            }
        }
        if (!foundUncappedMode) {
            std::cerr << "[WebGPU] Uncapped presentation requested but unsupported; refusing FIFO fallback"
                      << std::endl;
            wgpuSurfaceCapabilitiesFreeMembers(capabilities);
            return false;
        }
    }

    // List all available formats
    std::cout << "[WebGPU] Available surface formats:" << std::endl;
    for (uint32_t i = 0; i < capabilities.formatCount; i++) {
        std::cout << "  [" << i << "] = " << capabilities.formats[i] << std::endl;
    }

    // Prefer a non-sRGB surface to match the byte-encoded output Three.js writes for the
    // browser canvas. Bindings add a presentation bridge only when the platform exposes no
    // linear surface format. The diagnostic selector runs after this product choice and only
    // succeeds when it can turn a real sRGB bridge into a linear-surface treatment.
    const bool linearDiagnosticRequested = linearSurfaceRequested();
    const SurfaceFormatSelection selection = selectSurfaceFormat(
        capabilities.formats, capabilities.formatCount, linearDiagnosticRequested);
    if (selection.errorCode != nullptr) {
        std::cerr << selection.errorCode
                  << ": linear surface diagnostic could not select a changed supported format"
                  << std::endl;
        wgpuSurfaceCapabilitiesFreeMembers(capabilities);
        return false;
    }
    preferredFormat_ = static_cast<uint32_t>(selection.selectedFormat);
    if (linearDiagnosticRequested) {
        std::cout << "[WebGPU] Linear surface diagnostic enabled; using format: "
                  << preferredFormat_ << std::endl;
    }
    std::cout << "[WebGPU] Using surface format: " << preferredFormat_ << std::endl;
    TN_CONTEXT_LOGI("surface format %u", static_cast<unsigned>(preferredFormat_));

    // Configure surface
    WGPUSurfaceConfiguration config = {};
    config.device = device_;
    config.format = (WGPUTextureFormat)preferredFormat_;
    config.usage = WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_CopySrc;
    config.alphaMode = WGPUCompositeAlphaMode_Auto;
    config.width = width;
    config.height = height;
    config.presentMode = selectedPresentMode;
    configurePresentationSurface(surface_, &config);
    vsync_ = vsync;
    presentMode_ = static_cast<uint32_t>(selectedPresentMode);
    std::cout << "[WebGPU] Surface configured: " << width << "x" << height << std::endl;
    std::cout << "[WebGPU] Present mode: " << selectedPresentModeName
              << " (vsync=" << (vsync ? "true" : "false") << ")" << std::endl;
    TN_CONTEXT_LOGI("present mode %s vsync=%s", selectedPresentModeName, vsync ? "true" : "false");

    wgpuSurfaceCapabilitiesFreeMembers(capabilities);
    return true;
}

bool Context::rebuildSurface(void* nativeHandle, int platformType) {
    // The adapter, device and queue outlive the window: only the surface is bound to the
    // `ANativeWindow` Android destroyed, and recreating the device would throw away every GPU
    // resource the running game holds. So this is a surface swap and nothing more.
    if (!instance_) {
        std::cerr << "[WebGPU] Cannot rebuild surface: no instance" << std::endl;
        return false;
    }

    WGPUSurface replacement = makeSurface(nativeHandle, platformType);
    if (!replacement) {
        std::cerr << "[WebGPU] Failed to rebuild surface for the new native window" << std::endl;
        return false;
    }

    releaseSurface();
    surface_ = replacement;
    surfaceNativeHandle_ = nativeHandle;
    surfacePlatformType_ = platformType;
    // Force the next configure to run even at an unchanged size: this is a different swapchain,
    // not a resize of the one that was already configured.
    surfaceWidth_ = 0;
    surfaceHeight_ = 0;
    return true;
}

void Context::releaseSurface() {
    releaseSurfaceView();
    if (surface_) {
        wgpuSurfaceUnconfigure(surface_);
        wgpuSurfaceRelease(surface_);
        surface_ = nullptr;
    }
    surfaceNativeHandle_ = nullptr;
    surfacePlatformType_ = -1;
    surfaceWidth_ = surfaceHeight_ = 0;
}

void Context::resizeSurface(uint32_t width, uint32_t height) {
    if (width != surfaceWidth_ || height != surfaceHeight_) {
        if (!configureSurface(width, height, vsync_)) {
            std::cerr << "[WebGPU] Surface resize configuration failed" << std::endl;
        }
    }
}

void* Context::getCurrentTextureView() {
    if (surfaceView_) return surfaceView_;
    if (!surface_) {
        return nullptr;
    }

    WGPUSurfaceTexture surfaceTexture = {};
    acquirePresentationSurface(surface_, &surfaceTexture);

    if (!wgpuSurfaceTextureStatusIsSuccess(surfaceTexture.status)) {
        std::cerr << "[WebGPU] Failed to get current texture, status: " << surfaceTexture.status << std::endl;
        if (surfaceTexture.texture) wgpuTextureRelease(surfaceTexture.texture);
        return nullptr;
    }

    WGPUTextureViewDescriptor viewDesc = {};
    viewDesc.format = (WGPUTextureFormat)preferredFormat_;
    viewDesc.dimension = WGPUTextureViewDimension_2D;
    viewDesc.baseMipLevel = 0;
    viewDesc.mipLevelCount = 1;
    viewDesc.baseArrayLayer = 0;
    viewDesc.arrayLayerCount = 1;
    viewDesc.aspect = WGPUTextureAspect_All;

    surfaceView_ = wgpuTextureCreateView(surfaceTexture.texture, &viewDesc);
    // wgpu-native's acquired handle discards an unpresented frame when released, even if a
    // view survives. Keep it through present on both backends; release each reference once.
    surfaceTexture_ = surfaceTexture.texture;
    if (!surfaceView_) releaseSurfaceView();
    return surfaceView_;
}

void Context::releaseSurfaceView() {
    if (surfaceView_) wgpuTextureViewRelease(surfaceView_);
    surfaceView_ = nullptr;
    if (surfaceTexture_) wgpuTextureRelease(surfaceTexture_);
    surfaceTexture_ = nullptr;
}

bool Context::present() {
    bool presented = false;
    if (surface_ && surfaceView_) {
        presented = wgpuSurfacePresent(surface_) == WGPUStatus_Success;
#if defined(__ANDROID__)
        __android_log_print(ANDROID_LOG_INFO, "TN_Player", "TN_SURFACE_FRAME:{\"view\":true}");
#endif
    }
    releaseSurfaceView();
    return presented;
}

// Screenshot callback data
// Note: Extra padding added due to observed stack corruption during initialization
struct BufferMapData {
    bool completed = false;
    uint8_t _pad1[7] = {};
    WGPUBufferMapAsyncStatus_Compat status = WGPUBufferMapAsyncStatus_Unknown_Compat;
    uint8_t _pad2[12] = {};
    std::mutex waitMutex;
    std::condition_variable waitCondition;
};

using BufferMapDataPtr = std::shared_ptr<BufferMapData>;

static BufferMapDataPtr takeBufferMapData(void* userdata) {
    auto* holder = static_cast<BufferMapDataPtr*>(userdata);
    if (holder == nullptr) return {};
    BufferMapDataPtr data = std::move(*holder);
    delete holder;
    return data;
}

#if WGPU_BUFFER_MAP_USES_CALLBACK_INFO
// Dawn buffer map callback
static void onBufferMapped(WGPUMapAsyncStatus status, WGPUStringView message, void* userdata1, void* userdata2) {
    const BufferMapDataPtr data = takeBufferMapData(userdata1);
    if (!data) return;
    {
        std::lock_guard<std::mutex> lock(data->waitMutex);
        data->status = status;
        data->completed = true;
    }
    data->waitCondition.notify_all();
}
#else
// wgpu-native buffer map callback
static void onBufferMapped(WGPUBufferMapAsyncStatus status, void* userdata) {
    const BufferMapDataPtr data = takeBufferMapData(userdata);
    if (!data) return;
    {
        std::lock_guard<std::mutex> lock(data->waitMutex);
        data->status = status;
        data->completed = true;
    }
    data->waitCondition.notify_all();
}
#endif

static bool bufferMapCompleted(BufferMapData& data) {
    std::lock_guard<std::mutex> lock(data.waitMutex);
    return data.completed;
}

static WGPUBufferMapAsyncStatus_Compat bufferMapStatus(BufferMapData& data) {
    std::lock_guard<std::mutex> lock(data.waitMutex);
    return data.status;
}

static bool waitForBufferMap(BufferMapData& data, WGPUDevice device, WGPUInstance instance) {
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
#if defined(MYSTRAL_WEBGPU_WGPU)
    int maxIterations = 100;
    while (!bufferMapCompleted(data) && maxIterations-- > 0) {
        wgpuDevicePoll(device, true, nullptr);
    }
#else
    // A fixed iteration count expires before a software Dawn adapter finishes a large readback.
    // Keep pumping the backend until a real wall-clock deadline, while the condition variable
    // avoids burning a core between event batches.
    while (!bufferMapCompleted(data) && std::chrono::steady_clock::now() < deadline) {
        wgpuDeviceTick(device);
        wgpuInstanceProcessEvents(instance);
        if (!bufferMapCompleted(data)) {
            std::unique_lock<std::mutex> lock(data.waitMutex);
            data.waitCondition.wait_for(lock, std::chrono::milliseconds(1), [&data]() {
                return data.completed;
            });
        }
    }
#endif
    return bufferMapCompleted(data);
}

static void cancelBufferMap(WGPUBuffer buffer) {
    // Unmapping cancels a pending map in the same way the normal WebGPU buffer shutdown path
    // does. The callback owns its shared state, so a late cancellation callback cannot touch a
    // stack frame that has already returned.
    if (buffer) wgpuBufferUnmap(buffer);
}

static bool copyScreenshotPixels(
    const uint8_t* source,
    uint32_t width,
    uint32_t height,
    uint32_t bytesPerRow,
    uint32_t format,
    std::vector<uint8_t>& destination
) {
    const bool bgra = format == WGPUTextureFormat_BGRA8Unorm ||
                      format == WGPUTextureFormat_BGRA8UnormSrgb;
    const bool rgba = format == WGPUTextureFormat_RGBA8Unorm ||
                      format == WGPUTextureFormat_RGBA8UnormSrgb;
    if (!bgra && !rgba) return false;

    destination.resize(width * height * 4);
    for (uint32_t y = 0; y < height; y++) {
        const uint8_t* sourceRow = source + y * bytesPerRow;
        uint8_t* destinationRow = destination.data() + y * width * 4;
        for (uint32_t x = 0; x < width; x++) {
            const uint8_t* pixel = sourceRow + x * 4;
            uint8_t* output = destinationRow + x * 4;
            output[0] = bgra ? pixel[2] : pixel[0];
            output[1] = pixel[1];
            output[2] = bgra ? pixel[0] : pixel[2];
            output[3] = pixel[3];
        }
    }
    return true;
}

void Context::requestFrameScreenshot() {
    if (captureSource_) captureSource_->request();
}

bool Context::isFrameScreenshotReady() {
    return captureSource_ && captureSource_->ready();
}

void Context::clearFrameScreenshotReady() {
    if (captureSource_) captureSource_->clearReady();
}

bool Context::saveScreenshot(const char* filename) {
    if (!device_ || !queue_) {
        std::cerr << "[Screenshot] WebGPU not initialized" << std::endl;
        return false;
    }

    // Check if screenshot buffer is ready (populated during queue.submit)
    if (!captureSource_ || !captureSource_->ready()) {
        std::cerr << "[Screenshot] No rendered frame available yet" << std::endl;
        return false;
    }

    const host::FrameCaptureView frame = captureSource_->view();
    WGPUBuffer screenshotBuffer = static_cast<WGPUBuffer>(frame.buffer);
    if (!screenshotBuffer) {
        std::cerr << "[Screenshot] Screenshot buffer not available" << std::endl;
        return false;
    }

    // Get dimensions for screenshot
    uint32_t width = frame.width;
    uint32_t height = frame.height;
    uint32_t bytesPerRow = frame.bytesPerRow;
    size_t bufferSize = frame.size;
    TN_CONTEXT_LOGI("renderer capture map begin %ux%u format=%u bytes=%zu", width, height, frame.format, bufferSize);

    // Map the screenshot buffer (it was already populated during submit)
    auto mapData = std::make_shared<BufferMapData>();

#if WGPU_BUFFER_MAP_USES_CALLBACK_INFO
    // Dawn uses CallbackInfo struct with required callback mode
    WGPUBufferMapCallbackInfo mapCallbackInfo = {};
    mapCallbackInfo.mode = WGPUCallbackMode_AllowSpontaneous;
    mapCallbackInfo.callback = onBufferMapped;
    mapCallbackInfo.userdata1 = new BufferMapDataPtr(mapData);
    mapCallbackInfo.userdata2 = nullptr;
    wgpuBufferMapAsync(screenshotBuffer, WGPUMapMode_Read, 0, bufferSize, mapCallbackInfo);
#else
    // wgpu-native uses separate callback and userdata
    wgpuBufferMapAsync(screenshotBuffer, WGPUMapMode_Read, 0, bufferSize, onBufferMapped, new BufferMapDataPtr(mapData));
#endif

    const bool mapCompleted = waitForBufferMap(*mapData, device_, instance_);

    if (!mapCompleted) {
        std::cerr << "[Screenshot] Buffer mapping timed out" << std::endl;
        cancelBufferMap(screenshotBuffer);
        return false;
    }

    if (bufferMapStatus(*mapData) != WGPUBufferMapAsyncStatus_Success_Compat) {
        std::cerr << "[Screenshot] Buffer map failed with status: " << bufferMapStatus(*mapData) << std::endl;
        return false;
    }
    TN_CONTEXT_LOGI("renderer capture map complete");

    // Read the data
    const void* mappedData = wgpuBufferGetConstMappedRange(screenshotBuffer, 0, bufferSize);
    if (!mappedData) {
        std::cerr << "[Screenshot] Failed to get mapped range" << std::endl;
        wgpuBufferUnmap(screenshotBuffer);
        return false;
    }

    // Debug: Print first few bytes of mapped data (BGRA format)
    const uint8_t* debugBytes = static_cast<const uint8_t*>(mappedData);
    std::cout << "[Screenshot] First 16 bytes (BGRA raw): ";
    for (int i = 0; i < 16; i++) {
        std::cout << (int)debugBytes[i] << " ";
    }
    std::cout << std::endl;

    // Also check bytes in the middle of the image
    size_t midOffset = bytesPerRow * (height / 2) + (width / 2) * 4;
    std::cout << "[Screenshot] Middle bytes (BGRA raw): ";
    for (int i = 0; i < 16 && (midOffset + i) < bufferSize; i++) {
        std::cout << (int)debugBytes[midOffset + i] << " ";
    }
    std::cout << std::endl;

    std::vector<uint8_t> rgbaData;
    if (!copyScreenshotPixels(
            static_cast<const uint8_t*>(mappedData),
            width,
            height,
            bytesPerRow,
            frame.format,
            rgbaData)) {
        std::cerr << "[Screenshot] Unsupported surface format: " << frame.format << std::endl;
        wgpuBufferUnmap(screenshotBuffer);
        return false;
    }
    TN_CONTEXT_LOGI("renderer capture pixel copy complete");

    // Unmap the screenshot buffer (keep it for future screenshots)
    wgpuBufferUnmap(screenshotBuffer);
    TN_CONTEXT_LOGI("renderer capture buffer unmapped");

    // Save as PNG using stb_image_write
    if (!stbi_write_png(filename, width, height, 4, rgbaData.data(), width * 4)) {
        std::cerr << "[Screenshot] Failed to write PNG: " << filename << std::endl;
        return false;
    }
    TN_CONTEXT_LOGI("renderer capture PNG written");

    std::cout << "[Screenshot] Saved: " << filename << " (" << width << "x" << height << ")" << std::endl;
    return true;
}

bool Context::captureFrame(std::vector<uint8_t>& outData, uint32_t& outWidth, uint32_t& outHeight) {
    if (!device_ || !queue_) {
        return false;
    }

    // Check if screenshot buffer is ready (populated during queue.submit)
    if (!captureSource_ || !captureSource_->ready()) {
        return false;
    }

    const host::FrameCaptureView frame = captureSource_->view();
    WGPUBuffer screenshotBuffer = static_cast<WGPUBuffer>(frame.buffer);
    if (!screenshotBuffer) {
        return false;
    }

    // Get dimensions
    outWidth = frame.width;
    outHeight = frame.height;
    uint32_t bytesPerRow = frame.bytesPerRow;
    size_t bufferSize = frame.size;

    // Map the screenshot buffer
    auto mapData = std::make_shared<BufferMapData>();

#if WGPU_BUFFER_MAP_USES_CALLBACK_INFO
    WGPUBufferMapCallbackInfo mapCallbackInfo = {};
    mapCallbackInfo.mode = WGPUCallbackMode_AllowSpontaneous;
    mapCallbackInfo.callback = onBufferMapped;
    mapCallbackInfo.userdata1 = new BufferMapDataPtr(mapData);
    mapCallbackInfo.userdata2 = nullptr;
    wgpuBufferMapAsync(screenshotBuffer, WGPUMapMode_Read, 0, bufferSize, mapCallbackInfo);
#else
    wgpuBufferMapAsync(screenshotBuffer, WGPUMapMode_Read, 0, bufferSize, onBufferMapped, new BufferMapDataPtr(mapData));
#endif

    const bool mapCompleted = waitForBufferMap(*mapData, device_, instance_);

    if (!mapCompleted || bufferMapStatus(*mapData) != WGPUBufferMapAsyncStatus_Success_Compat) {
        if (!mapCompleted) cancelBufferMap(screenshotBuffer);
        return false;
    }

    // Read the data
    const void* mappedData = wgpuBufferGetConstMappedRange(screenshotBuffer, 0, bufferSize);
    if (!mappedData) {
        wgpuBufferUnmap(screenshotBuffer);
        return false;
    }

    if (!copyScreenshotPixels(
            static_cast<const uint8_t*>(mappedData),
            outWidth,
            outHeight,
            bytesPerRow,
            frame.format,
            outData)) {
        wgpuBufferUnmap(screenshotBuffer);
        return false;
    }

    wgpuBufferUnmap(screenshotBuffer);
    return true;
}

}  // namespace webgpu
}  // namespace mystral
