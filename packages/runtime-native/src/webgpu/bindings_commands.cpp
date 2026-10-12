/** WebGPU encoder, render-pass, compute-pass, bundle, and query bindings. */

#include "bindings_commands.h"
#include "bindings_handler_helpers.h"
#include "bindings_presentation.h"
#include "bindings_resources.h"
#include "bindings_state.h"
#include "mystral/webgpu/checked_handle.h"
#include "mystral/webgpu/wrapper_factories.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <iostream>
#include <limits>
#include <memory>
#include <string>
#include <vector>

#if defined(MYSTRAL_WEBGPU_WGPU) || defined(MYSTRAL_WEBGPU_DAWN)
#include <webgpu/webgpu.h>
#include "mystral/webgpu_compat.h"
#endif

namespace mystral {
namespace webgpu {
#if defined(MYSTRAL_WEBGPU_WGPU) || defined(MYSTRAL_WEBGPU_DAWN)

static js::JSValueHandle handleGpuRenderBundleEncoderFinish(BindingsState* state, WGPURenderBundleEncoder capturedEncoder, const std::vector<js::JSValueHandle>& args) {
                                    WGPURenderBundleDescriptor desc = {};
                                    WGPURenderBundle bundle = wgpuRenderBundleEncoderFinish(capturedEncoder, &desc);
                                    auto jsBundle = createNativeWrapper(
                                        state, "GPURenderBundle", bundle);
                                    const uint64_t bundleId = state->registries.nextRenderBundleId++;
                                    state->registries.renderBundleRegistry[bundleId] = bundle;
                                    state->engine->setProperty(jsBundle, "_renderBundleId", state->engine->newNumber(bundleId));
                                    state->engine->registerRelease(jsBundle, [state, bundle, bundleId]() {
                                        state->registries.renderBundleRegistry.erase(bundleId);
                                        wgpuRenderBundleRelease(bundle);
                                    });
                                    state->engine->setProperty(jsBundle, "_type", state->engine->newString("renderBundle"));
                                    if (state->verboseLogging) std::cout << "[WebGPU] Render bundle finished" << std::endl;
                                    return jsBundle;
}

static js::JSValueHandle handleGpuRenderBundleEncoderDrawIndexed(BindingsState* state, WGPURenderBundleEncoder capturedEncoder, const std::vector<js::JSValueHandle>& args) {
                                    if (args.empty()) return state->engine->newUndefined();
#if TN_ANDROID_JS_PROFILE
                                    const auto profileStart = beginProfiledBinding();
#endif
                                    uint32_t indexCount = (uint32_t)state->engine->toNumber(args[0]);
                                    uint32_t instanceCount = args.size() > 1 ? (uint32_t)state->engine->toNumber(args[1]) : 1;
                                    uint32_t firstIndex = args.size() > 2 ? (uint32_t)state->engine->toNumber(args[2]) : 0;
                                    int32_t baseVertex = args.size() > 3 ? (int32_t)state->engine->toNumber(args[3]) : 0;
                                    uint32_t firstInstance = args.size() > 4 ? (uint32_t)state->engine->toNumber(args[4]) : 0;
                                    wgpuRenderBundleEncoderDrawIndexed(capturedEncoder, indexCount, instanceCount, firstIndex, baseVertex, firstInstance);
#if TN_ANDROID_JS_PROFILE
                                    endProfiledBinding(state, ProfiledRenderCommand::BundleDrawIndexed, profileStart);
#endif
                                    return state->engine->newUndefined();
}

// renderBundleEncoder.drawIndirect / drawIndexedIndirect(indirectBuffer, indirectOffset): the GPU-driven
// world (core's BundleGroup path) records its indirect batches into bundles, so a host without these
// throws `drawIndexedIndirect is not a function` on the first streamed cell. A bad call fails closed by
// name (a TypeError, as on the web) rather than recording nothing, because a bundle that silently drops a
// draw renders a world with holes and reports success.
static bool readBundleIndirectArgs(BindingsState* state, WGPURenderBundleEncoder encoder, const char* method,
                                   const std::vector<js::JSValueHandle>& args, WGPUBuffer* buffer, uint64_t* offset) {
    const std::string name = std::string("GPURenderBundleEncoder.") + method;
    if (args.size() < 2) {
        state->engine->throwTypeError((name + ": needs an indirect buffer and an indirect offset").c_str());
        return false;
    }
    if (!encoder) {
        state->engine->throwTypeError((name + ": the encoder is not valid").c_str());
        return false;
    }
    *buffer = state->engine->isObject(args[0]) ? (WGPUBuffer)state->engine->getPrivateData(args[0]) : nullptr;
    if (!*buffer) {
        state->engine->throwTypeError((name + ": argument 1 is not a GPUBuffer").c_str());
        return false;
    }
    const double rawOffset = state->engine->isNumber(args[1]) ? state->engine->toNumber(args[1]) : std::nan("");
    // 2^53 is the largest integer a JS number holds exactly, so a larger offset is not the one the caller wrote.
    if (!std::isfinite(rawOffset) || rawOffset < 0 || rawOffset > 9007199254740992.0 || std::fmod(rawOffset, 4.0) != 0.0) {
        state->engine->throwTypeError((name + ": the indirect offset must be a finite, non-negative multiple of 4").c_str());
        return false;
    }
    *offset = (uint64_t)rawOffset;
    return true;
}

static js::JSValueHandle handleGpuRenderBundleEncoderDrawIndirect(BindingsState* state, WGPURenderBundleEncoder capturedEncoder, const std::vector<js::JSValueHandle>& args) {
    WGPUBuffer indirectBuffer = nullptr;
    uint64_t indirectOffset = 0;
    if (readBundleIndirectArgs(state, capturedEncoder, "drawIndirect", args, &indirectBuffer, &indirectOffset))
        wgpuRenderBundleEncoderDrawIndirect(capturedEncoder, indirectBuffer, indirectOffset);
    return state->engine->newUndefined();
}

static js::JSValueHandle handleGpuRenderBundleEncoderDrawIndexedIndirect(BindingsState* state, WGPURenderBundleEncoder capturedEncoder, const std::vector<js::JSValueHandle>& args) {
    WGPUBuffer indirectBuffer = nullptr;
    uint64_t indirectOffset = 0;
    if (readBundleIndirectArgs(state, capturedEncoder, "drawIndexedIndirect", args, &indirectBuffer, &indirectOffset))
        wgpuRenderBundleEncoderDrawIndexedIndirect(capturedEncoder, indirectBuffer, indirectOffset);
    return state->engine->newUndefined();
}

static js::JSValueHandle handleGpuRenderBundleEncoderDraw(BindingsState* state, WGPURenderBundleEncoder capturedEncoder, const std::vector<js::JSValueHandle>& args) {
                                    if (args.empty()) return state->engine->newUndefined();
                                    uint32_t vertexCount = (uint32_t)state->engine->toNumber(args[0]);
                                    uint32_t instanceCount = args.size() > 1 ? (uint32_t)state->engine->toNumber(args[1]) : 1;
                                    uint32_t firstVertex = args.size() > 2 ? (uint32_t)state->engine->toNumber(args[2]) : 0;
                                    uint32_t firstInstance = args.size() > 3 ? (uint32_t)state->engine->toNumber(args[3]) : 0;
                                    wgpuRenderBundleEncoderDraw(capturedEncoder, vertexCount, instanceCount, firstVertex, firstInstance);
                                    return state->engine->newUndefined();
}

static js::JSValueHandle handleGpuRenderBundleEncoderSetBindGroup(BindingsState* state, WGPURenderBundleEncoder capturedEncoder, const std::vector<js::JSValueHandle>& args) {
                                    if (args.size() < 2) return state->engine->newUndefined();
                                    uint32_t index = (uint32_t)state->engine->toNumber(args[0]);
                                    WGPUBindGroup bindGroup = (WGPUBindGroup)state->engine->getPrivateData(args[1]);
                                    // Parse dynamic offsets if provided
                                    std::vector<uint32_t> dynamicOffsets;
                                    if (args.size() > 2 && !state->engine->isUndefined(args[2])) {
                                        auto offsetsArray = args[2];
                                        auto lengthProp = state->engine->getProperty(offsetsArray, "length");
                                        int offsetCount = state->engine->isUndefined(lengthProp) ? 0 : (int)state->engine->toNumber(lengthProp);
                                        for (int i = 0; i < offsetCount; i++) {
                                            dynamicOffsets.push_back((uint32_t)state->engine->toNumber(state->engine->getPropertyIndex(offsetsArray, i)));
                                        }
                                    }
                                    wgpuRenderBundleEncoderSetBindGroup(capturedEncoder, index, bindGroup, dynamicOffsets.size(), dynamicOffsets.data());
                                    return state->engine->newUndefined();
}

static js::JSValueHandle handleGpuRenderBundleEncoderSetIndexBuffer(BindingsState* state, WGPURenderBundleEncoder capturedEncoder, const std::vector<js::JSValueHandle>& args) {
                                    if (args.size() < 2) return state->engine->newUndefined();
                                    WGPUBuffer buffer = (WGPUBuffer)state->engine->getPrivateData(args[0]);
                                    std::string formatStr = state->engine->toString(args[1]);
                                    WGPUIndexFormat format = formatStr == "uint32" ? WGPUIndexFormat_Uint32 : WGPUIndexFormat_Uint16;
                                    uint64_t offset = args.size() > 2 && !state->engine->isUndefined(args[2]) ? (uint64_t)state->engine->toNumber(args[2]) : 0;
                                    uint64_t size = args.size() > 3 && !state->engine->isUndefined(args[3]) ? (uint64_t)state->engine->toNumber(args[3]) : WGPU_WHOLE_SIZE;
                                    wgpuRenderBundleEncoderSetIndexBuffer(capturedEncoder, buffer, format, offset, size);
                                    return state->engine->newUndefined();
}

static js::JSValueHandle handleGpuRenderBundleEncoderSetVertexBuffer(BindingsState* state, WGPURenderBundleEncoder capturedEncoder, const std::vector<js::JSValueHandle>& args) {
                                    if (args.size() < 2) return state->engine->newUndefined();
                                    uint32_t slot = (uint32_t)state->engine->toNumber(args[0]);
                                    WGPUBuffer buffer = (WGPUBuffer)state->engine->getPrivateData(args[1]);
                                    uint64_t offset = args.size() > 2 && !state->engine->isUndefined(args[2]) ? (uint64_t)state->engine->toNumber(args[2]) : 0;
                                    uint64_t size = args.size() > 3 && !state->engine->isUndefined(args[3]) ? (uint64_t)state->engine->toNumber(args[3]) : WGPU_WHOLE_SIZE;
                                    wgpuRenderBundleEncoderSetVertexBuffer(capturedEncoder, slot, buffer, offset, size);
                                    return state->engine->newUndefined();
}

static js::JSValueHandle handleGpuRenderBundleEncoderSetPipeline(BindingsState* state, WGPURenderBundleEncoder capturedEncoder, const std::vector<js::JSValueHandle>& args) {
                                    if (args.empty()) return state->engine->newUndefined();
                                    WGPURenderPipeline pipeline = (WGPURenderPipeline)state->engine->getPrivateData(args[0]);
                                    wgpuRenderBundleEncoderSetPipeline(capturedEncoder, pipeline);
                                    return state->engine->newUndefined();
}

js::JSValueHandle handleGpuDeviceCreateRenderBundleEncoder(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args) {
                            if (args.empty()) {
                                state->engine->throwException("createRenderBundleEncoder requires a descriptor");
                                return state->engine->newUndefined();
                            }
                            auto descriptor = args[0];
                            // Parse color formats
                            auto colorFormats = state->engine->getProperty(descriptor, "colorFormats");
                            auto colorFormatsLength = state->engine->getProperty(colorFormats, "length");
                            int colorFormatCount = state->engine->isUndefined(colorFormatsLength) ? 0 : (int)state->engine->toNumber(colorFormatsLength);
                            std::vector<WGPUTextureFormat> formats;
                            formats.reserve(colorFormatCount);
                            for (int i = 0; i < colorFormatCount; i++) {
                                auto formatProp = state->engine->getPropertyIndex(colorFormats, i);
                                if (!state->engine->isUndefined(formatProp) && !state->engine->isNull(formatProp)) {
                                    formats.push_back(stringToFormat(state->engine->toString(formatProp)));
                                }
                            }
                            // Parse depth stencil format
                            WGPUTextureFormat depthFormat = WGPUTextureFormat_Undefined;
                            auto depthFormatProp = state->engine->getProperty(descriptor, "depthStencilFormat");
                            if (!state->engine->isUndefined(depthFormatProp) && !state->engine->isNull(depthFormatProp)) {
                                depthFormat = stringToFormat(state->engine->toString(depthFormatProp));
                            }
                            // Parse sample count
                            uint32_t sampleCount = 1;
                            auto sampleCountProp = state->engine->getProperty(descriptor, "sampleCount");
                            if (!state->engine->isUndefined(sampleCountProp)) {
                                sampleCount = (uint32_t)state->engine->toNumber(sampleCountProp);
                            }
                            WGPURenderBundleEncoderDescriptor desc = {};
                            desc.colorFormatCount = formats.size();
                            desc.colorFormats = formats.data();
                            desc.depthStencilFormat = depthFormat;
                            desc.sampleCount = sampleCount;
                            WGPURenderBundleEncoder bundleEncoder = wgpuDeviceCreateRenderBundleEncoder(state->device, &desc);
                            if (!bundleEncoder) {
                                state->engine->throwException("Failed to create render bundle encoder");
                                return state->engine->newUndefined();
                            }
                            auto jsEncoder = createNativeWrapper(
                                state, "GPURenderBundleEncoder", bundleEncoder);
                            // Capture for closures
                            WGPURenderBundleEncoder capturedEncoder = bundleEncoder;
                            // renderBundleEncoder.setPipeline(pipeline)
                            if (!installBindingTable(state->engine, state, bindingTable({
                                {"GPURenderBundleEncoder", "setPipeline", 0, nullptr,
                                makeCapturedHandler(capturedEncoder, &handleGpuRenderBundleEncoderSetPipeline)
                            , jsEncoder},
                            // renderBundleEncoder.setVertexBuffer(slot, buffer, offset?, size?)
                                {"GPURenderBundleEncoder", "setVertexBuffer", 0, nullptr,
                                makeCapturedHandler(capturedEncoder, &handleGpuRenderBundleEncoderSetVertexBuffer)
                            , jsEncoder},
                            // renderBundleEncoder.setIndexBuffer(buffer, format, offset?, size?)
                                {"GPURenderBundleEncoder", "setIndexBuffer", 0, nullptr,
                                makeCapturedHandler(capturedEncoder, &handleGpuRenderBundleEncoderSetIndexBuffer)
                            , jsEncoder},
                            // renderBundleEncoder.setBindGroup(index, bindGroup, dynamicOffsets?)
                                {"GPURenderBundleEncoder", "setBindGroup", 0, nullptr,
                                makeCapturedHandler(capturedEncoder, &handleGpuRenderBundleEncoderSetBindGroup)
                            , jsEncoder},
                            // renderBundleEncoder.draw(vertexCount, instanceCount?, firstVertex?, firstInstance?)
                                {"GPURenderBundleEncoder", "draw", 0, nullptr,
                                makeCapturedHandler(capturedEncoder, &handleGpuRenderBundleEncoderDraw)
                            , jsEncoder},
                            // renderBundleEncoder.drawIndexed(indexCount, instanceCount?, firstIndex?, baseVertex?, firstInstance?)
                                {"GPURenderBundleEncoder", "drawIndexed", 0, nullptr,
                                makeCapturedHandler(capturedEncoder, &handleGpuRenderBundleEncoderDrawIndexed)
                            , jsEncoder},
                            // renderBundleEncoder.drawIndirect(indirectBuffer, indirectOffset)
                                {"GPURenderBundleEncoder", "drawIndirect", 0, nullptr,
                                makeCapturedHandler(capturedEncoder, &handleGpuRenderBundleEncoderDrawIndirect)
                            , jsEncoder},
                            // renderBundleEncoder.drawIndexedIndirect(indirectBuffer, indirectOffset)
                                {"GPURenderBundleEncoder", "drawIndexedIndirect", 0, nullptr,
                                makeCapturedHandler(capturedEncoder, &handleGpuRenderBundleEncoderDrawIndexedIndirect)
                            , jsEncoder},
                            // renderBundleEncoder.finish(descriptor?)
                                {"GPURenderBundleEncoder", "finish", 0, nullptr,
                                makeCapturedHandler(capturedEncoder, &handleGpuRenderBundleEncoderFinish)
                            , jsEncoder}}))) {
                                wgpuRenderBundleEncoderRelease(bundleEncoder);
                                return state->engine->newUndefined();
                            }
                            if (state->verboseLogging) std::cout << "[WebGPU] Created render bundle encoder" << std::endl;
                            return jsEncoder;
}

js::JSValueHandle tnWebgpuHandlerCreateQuerySet(
    BindingsState* state, BindingDestination, const std::vector<js::JSValueHandle>& args) {
    if (args.empty()) {
        state->engine->throwException("createQuerySet requires a descriptor");
        return state->engine->newUndefined();
    }
    const auto descriptor = args[0];
    const auto typeProp = state->engine->getProperty(descriptor, "type");
    const std::string type =
        state->engine->isUndefined(typeProp) ? std::string() : state->engine->toString(typeProp);
    if (type != "timestamp" && type != "occlusion") {
        state->engine->throwException("createQuerySet type must be 'timestamp' or 'occlusion'");
        return state->engine->newUndefined();
    }
    const auto countProp = state->engine->getProperty(descriptor, "count");
    const double rawCount = state->engine->isUndefined(countProp)
                                ? -1.0
                                : state->engine->toNumber(countProp);
    if (!(rawCount >= 1.0) || rawCount != std::floor(rawCount) || rawCount > 4096.0) {
        state->engine->throwException("createQuerySet count must be an integer from 1 to 4096");
        return state->engine->newUndefined();
    }
    const WGPUQueryType queryType =
        type == "timestamp" ? WGPUQueryType_Timestamp : WGPUQueryType_Occlusion;
    // Fail by name, before the device call, when the feature was never granted. A query set
    // created against a device without the feature is a validation error whose message names
    // neither the call nor the reason.
    if (queryType == WGPUQueryType_Timestamp &&
        wgpuDeviceHasFeature(state->device, WGPUFeatureName_TimestampQuery) == 0) {
        state->engine->throwException(
            "createQuerySet: this device was not granted 'timestamp-query'");
        return state->engine->newUndefined();
    }
    WGPUQuerySetDescriptor querySetDesc = {};
    querySetDesc.type = queryType;
    querySetDesc.count = static_cast<uint32_t>(rawCount);
    WGPUQuerySet querySet = wgpuDeviceCreateQuerySet(state->device, &querySetDesc);
    if (!querySet) {
        state->engine->throwException("Failed to create query set");
        return state->engine->newUndefined();
    }
    auto jsQuerySet = createNativeWrapper(state, "GPUQuerySet", querySet);
    const uint64_t querySetId = state->registries.nextQuerySetId++;
    state->registries.querySetRegistry[querySetId] = querySet;
    state->engine->setProperty(jsQuerySet, "_querySetId",
                               state->engine->newNumber((double)querySetId));
    state->engine->setProperty(jsQuerySet, "type", state->engine->newString(type.c_str()));
    state->engine->setProperty(jsQuerySet, "count",
                               state->engine->newNumber((double)querySetDesc.count));
    state->engine->registerRelease(jsQuerySet, [state, querySet, querySetId]() {
        state->registries.querySetRegistry.erase(querySetId);
        wgpuQuerySetRelease(querySet);
    });
    if (state->verboseLogging)
        std::cout << "[WebGPU] Created " << type << " query set of " << querySetDesc.count
                  << std::endl;
    return jsQuerySet;
}

/** Resolves a JS query-set wrapper to its native handle, or null with the exception already set. */
static WGPUQuerySet querySetFromJs(BindingsState* state, js::JSValueHandle value, const char* call) {
    if (state->engine->isUndefined(value) || state->engine->isNull(value)) {
        state->engine->throwException((std::string(call) + " requires a GPUQuerySet").c_str());
        return nullptr;
    }
    const auto idProp = state->engine->getProperty(value, "_querySetId");
    if (state->engine->isUndefined(idProp)) {
        state->engine->throwException(
            (std::string(call) + ": argument is not a GPUQuerySet from this device").c_str());
        return nullptr;
    }
    const auto it = state->registries.querySetRegistry.find(static_cast<uint64_t>(state->engine->toNumber(idProp)));
    if (it == state->registries.querySetRegistry.end()) {
        state->engine->throwException(
            (std::string(call) + ": query set was already destroyed").c_str());
        return nullptr;
    }
    return it->second;
}


/**
 * Parses `timestampWrites` from a render or compute pass descriptor.
 *
 * Returns false with an exception already set when the block is present but unusable; a caller
 * that asked to be timed and silently was not is worse than one that failed, because the number
 * it reads afterwards looks like a measurement.
 */
template <typename TimestampWrites>
static bool readTimestampWrites(
    BindingsState* state,
    js::JSValueHandle descriptor,
    const char* call,
    TimestampWrites& writes,
    bool& present) {
    present = false;
    const auto block = state->engine->getProperty(descriptor, "timestampWrites");
    if (state->engine->isUndefined(block) || state->engine->isNull(block)) return true;
    WGPUQuerySet querySet = querySetFromJs(state, state->engine->getProperty(block, "querySet"), call);
    if (!querySet) return false;
    const auto readIndex = [&](const char* name, uint32_t& out) {
        const auto prop = state->engine->getProperty(block, name);
        if (state->engine->isUndefined(prop) || state->engine->isNull(prop)) {
            out = WGPU_QUERY_SET_INDEX_UNDEFINED;
            return true;
        }
        const double raw = state->engine->toNumber(prop);
        if (!(raw >= 0.0) || raw != std::floor(raw)) {
            state->engine->throwException(
                (std::string(call) + ": timestampWrites." + name + " must be a query index").c_str());
            return false;
        }
        out = static_cast<uint32_t>(raw);
        return true;
    };
    writes = {};
    writes.querySet = querySet;
    if (!readIndex("beginningOfPassWriteIndex", writes.beginningOfPassWriteIndex)) return false;
    if (!readIndex("endOfPassWriteIndex", writes.endOfPassWriteIndex)) return false;
    if (writes.beginningOfPassWriteIndex == WGPU_QUERY_SET_INDEX_UNDEFINED &&
        writes.endOfPassWriteIndex == WGPU_QUERY_SET_INDEX_UNDEFINED) {
        state->engine->throwException(
            (std::string(call) + ": timestampWrites names no query index to write").c_str());
        return false;
    }
    present = true;
    return true;
}

static js::JSValueHandle handleGpuCommandEncoderFinish(BindingsState* state, WGPUCommandEncoder capturedEncoder, const std::vector<js::JSValueHandle>& args) {
                                    // Use captured encoder for this specific command encoder
                                    WGPUCommandEncoder encoderToFinish = capturedEncoder;
                                    if (!encoderToFinish ||
                                        state->registries.commandEncoderRegistry.find(encoderToFinish) ==
                                            state->registries.commandEncoderRegistry.end()) {
                                        return state->engine->newUndefined();
                                    }
                                    // Auto-end any active render/compute passes for THIS encoder
                                    // Look up from per-encoder map, not global
                                    auto renderPassIt = state->registries.encoderRenderPassMap.find(encoderToFinish);
                                    if (renderPassIt != state->registries.encoderRenderPassMap.end() &&
                                        renderPassIt->second) {
                                        WGPURenderPassEncoder renderPass = renderPassIt->second;
                                        if (state->verboseLogging) std::cout << "[WebGPU] Auto-ending render pass (pass=" << (void*)renderPass << ", encoder=" << (void*)encoderToFinish << ")" << std::endl;
                                        wgpuRenderPassEncoderEnd(renderPass);
                                        wgpuRenderPassEncoderRelease(renderPass);
                                        state->registries.encoderRenderPassMap.erase(renderPassIt);
                                        // Clear global if it matches
                                        if (state->registries.jsRenderPass == renderPass) {
                                            state->registries.jsRenderPass = nullptr;
                                        }
                                        // Mark surface render pass as ended
                                        if (state->presentation.surfaceRenderEncoder == encoderToFinish) {
                                            state->presentation.surfaceRenderPassEnded = true;
                                            if (state->verboseLogging) std::cout << "[WebGPU] Surface render pass auto-ended (encoder=" << (void*)encoderToFinish << ")" << std::endl;
                                        }
                                    }
                                    auto computePassIt = state->registries.encoderComputePassMap.find(encoderToFinish);
                                    if (computePassIt != state->registries.encoderComputePassMap.end() &&
                                        computePassIt->second) {
                                        WGPUComputePassEncoder computePass = computePassIt->second;
                                        if (state->verboseLogging) std::cout << "[WebGPU] Auto-ending compute pass (pass=" << (void*)computePass << ", encoder=" << (void*)encoderToFinish << ")" << std::endl;
                                        wgpuComputePassEncoderEnd(computePass);
                                        wgpuComputePassEncoderRelease(computePass);
                                        state->registries.encoderComputePassMap.erase(computePassIt);
                                        // Clear global if it matches
                                        if (state->registries.jsComputePass == computePass) {
                                            state->registries.jsComputePass = nullptr;
                                        }
                                    }
                                    WGPUCommandBufferDescriptor cmdDesc = {};
                                    WGPUCommandBuffer cmdBuffer = nullptr;
                                    if (encoderToFinish) {
                                        cmdBuffer = wgpuCommandEncoderFinish(encoderToFinish, &cmdDesc);
                                        wgpuCommandEncoderRelease(encoderToFinish);
                                        // Clear global if it matches
                                        if (state->registries.jsCommandEncoder == encoderToFinish) {
                                            state->registries.jsCommandEncoder = nullptr;
                                        }
                                        state->registries.commandEncoderRegistry.erase(encoderToFinish);
                                        if (state->presentation.surfaceRenderEncoder == encoderToFinish) {
                                            state->presentation.surfaceRenderEncoder = nullptr;
                                        }
                                        if (!state->registries.jsCommandEncoder &&
                                            !state->registries.commandEncoderRegistry.empty()) {
                                            state->registries.jsCommandEncoder =
                                                *state->registries.commandEncoderRegistry.begin();
                                        }
                                        // The encoder was checked; the command buffer it returns was not, and a
                                        // NULL one reaches queue.submit(), which reads it inside wgpu-native.
                                        if (!requireHandle(state->engine, cmdBuffer, "commandEncoder.finish"))
                                            return state->engine->newUndefined();
                                        if (state->verboseLogging) std::cout << "[WebGPU] Command encoder finished, buffer: " << cmdBuffer << std::endl;
                                    }
                                    auto jsCommandBuffer = createNativeWrapper(
                                        state, "GPUCommandBuffer", cmdBuffer);
                                    return jsCommandBuffer;
}

static js::JSValueHandle handleGpuCommandEncoderClearBuffer(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args) {
    if (args.empty() || !state->registries.jsCommandEncoder)
        return state->engine->newUndefined();
    WGPUBuffer buffer = (WGPUBuffer)state->engine->getPrivateData(args[0]);
    uint64_t offset = args.size() > 1 ? (uint64_t)state->engine->toNumber(args[1]) : 0;
    uint64_t size = args.size() > 2 ? (uint64_t)state->engine->toNumber(args[2]) : WGPU_WHOLE_SIZE;
    if (buffer) {
        wgpuCommandEncoderClearBuffer(state->registries.jsCommandEncoder, buffer, offset, size);
    }
                                    return state->engine->newUndefined();
}

static js::JSValueHandle handleGpuCommandEncoderCopyTextureToTexture(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args) {
    if (args.size() < 3 || !state->registries.jsCommandEncoder)
        return state->engine->newUndefined();
    auto sourceProp = args[0];
    auto destProp = args[1];
    auto sizeProp = args[2];
    // Source texture
    WGPUTexture srcTexture =
        (WGPUTexture)state->engine->getPrivateData(state->engine->getProperty(sourceProp, "texture"));
    uint32_t srcMipLevel = (uint32_t)state->engine->toNumber(state->engine->getProperty(sourceProp, "mipLevel"));
    auto srcOriginProp = state->engine->getProperty(sourceProp, "origin");
    uint32_t srcOriginX = 0, srcOriginY = 0, srcOriginZ = 0;
    if (!state->engine->isUndefined(srcOriginProp)) {
        srcOriginX = (uint32_t)state->engine->toNumber(state->engine->getPropertyIndex(srcOriginProp, 0));
        srcOriginY = (uint32_t)state->engine->toNumber(state->engine->getPropertyIndex(srcOriginProp, 1));
        srcOriginZ = (uint32_t)state->engine->toNumber(state->engine->getPropertyIndex(srcOriginProp, 2));
    }
                                    // Destination texture
                                    WGPUTexture dstTexture = (WGPUTexture)state->engine->getPrivateData(state->engine->getProperty(destProp, "texture"));
                                    uint32_t dstMipLevel = (uint32_t)state->engine->toNumber(state->engine->getProperty(destProp, "mipLevel"));
                                    auto dstOriginProp = state->engine->getProperty(destProp, "origin");
                                    uint32_t dstOriginX = 0, dstOriginY = 0, dstOriginZ = 0;
                                    if (!state->engine->isUndefined(dstOriginProp)) {
                                        dstOriginX = (uint32_t)state->engine->toNumber(state->engine->getPropertyIndex(dstOriginProp, 0));
                                        dstOriginY = (uint32_t)state->engine->toNumber(state->engine->getPropertyIndex(dstOriginProp, 1));
                                        dstOriginZ = (uint32_t)state->engine->toNumber(state->engine->getPropertyIndex(dstOriginProp, 2));
                                    }
                                    // Copy size - handle both array and object forms
                                    uint32_t width = 1, height = 1, depthOrLayers = 1;
                                    if (state->engine->isArray(sizeProp)) {
                                        width = (uint32_t)state->engine->toNumber(state->engine->getPropertyIndex(sizeProp, 0));
                                        height = (uint32_t)state->engine->toNumber(state->engine->getPropertyIndex(sizeProp, 1));
                                        auto depthVal = state->engine->getPropertyIndex(sizeProp, 2);
                                        if (!state->engine->isUndefined(depthVal)) {
                                            depthOrLayers = (uint32_t)state->engine->toNumber(depthVal);
                                        }
                                    } else {
                                        width = (uint32_t)state->engine->toNumber(state->engine->getProperty(sizeProp, "width"));
                                        height = (uint32_t)state->engine->toNumber(state->engine->getProperty(sizeProp, "height"));
                                        auto depthVal = state->engine->getProperty(sizeProp, "depthOrArrayLayers");
                                        if (!state->engine->isUndefined(depthVal)) {
                                            depthOrLayers = (uint32_t)state->engine->toNumber(depthVal);
                                        }
                                    }
                                    if (depthOrLayers == 0) depthOrLayers = 1;
                                    if (srcTexture && dstTexture) {
                                        WGPUImageCopyTexture_Compat srcCopy = {};
                                        srcCopy.texture = srcTexture;
                                        srcCopy.mipLevel = srcMipLevel;
                                        srcCopy.origin = {srcOriginX, srcOriginY, srcOriginZ};
                                        WGPUImageCopyTexture_Compat dstCopy = {};
                                        dstCopy.texture = dstTexture;
                                        dstCopy.mipLevel = dstMipLevel;
                                        dstCopy.origin = {dstOriginX, dstOriginY, dstOriginZ};
                                        WGPUExtent3D copySize = {width, height, depthOrLayers};
                                        wgpuCommandEncoderCopyTextureToTexture(state->registries.jsCommandEncoder,
                                                                               &srcCopy, &dstCopy, &copySize);
                                    }
                                    return state->engine->newUndefined();
}

static js::JSValueHandle handleGpuCommandEncoderCopyTextureToBuffer(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args) {
    if (args.size() < 3 || !state->registries.jsCommandEncoder)
        return state->engine->newUndefined();
    auto sourceProp = args[0];
    auto destProp = args[1];
    auto sizeProp = args[2];
    // Source (texture info)
    WGPUTexture texture = (WGPUTexture)state->engine->getPrivateData(state->engine->getProperty(sourceProp, "texture"));
    uint32_t mipLevel = (uint32_t)state->engine->toNumber(state->engine->getProperty(sourceProp, "mipLevel"));
    auto originProp = state->engine->getProperty(sourceProp, "origin");
    uint32_t originX = 0, originY = 0, originZ = 0;
    if (!state->engine->isUndefined(originProp)) {
        originX = (uint32_t)state->engine->toNumber(state->engine->getPropertyIndex(originProp, 0));
        originY = (uint32_t)state->engine->toNumber(state->engine->getPropertyIndex(originProp, 1));
        originZ = (uint32_t)state->engine->toNumber(state->engine->getPropertyIndex(originProp, 2));
    }
                                    // Destination (buffer info)
                                    WGPUBuffer buffer = (WGPUBuffer)state->engine->getPrivateData(state->engine->getProperty(destProp, "buffer"));
                                    uint64_t offset = (uint64_t)state->engine->toNumber(state->engine->getProperty(destProp, "offset"));
                                    uint32_t bytesPerRow = (uint32_t)state->engine->toNumber(state->engine->getProperty(destProp, "bytesPerRow"));
                                    uint32_t rowsPerImage = (uint32_t)state->engine->toNumber(state->engine->getProperty(destProp, "rowsPerImage"));
                                    // Copy size - can be array [w,h,d] or object {width, height, depthOrArrayLayers}
                                    uint32_t width = 0, height = 0, depthOrLayers = 1;
                                    auto widthProp = state->engine->getProperty(sizeProp, "width");
                                    if (!state->engine->isUndefined(widthProp)) {
                                        // Object format: { width, height, depthOrArrayLayers }
                                        width = (uint32_t)state->engine->toNumber(widthProp);
                                        height = (uint32_t)state->engine->toNumber(state->engine->getProperty(sizeProp, "height"));
                                        auto depthProp = state->engine->getProperty(sizeProp, "depthOrArrayLayers");
                                        depthOrLayers = state->engine->isUndefined(depthProp) ? 1 : (uint32_t)state->engine->toNumber(depthProp);
                                    } else {
                                        // Array format: [width, height, depth]
                                        width = (uint32_t)state->engine->toNumber(state->engine->getPropertyIndex(sizeProp, 0));
                                        height = (uint32_t)state->engine->toNumber(state->engine->getPropertyIndex(sizeProp, 1));
                                        depthOrLayers = (uint32_t)state->engine->toNumber(state->engine->getPropertyIndex(sizeProp, 2));
                                    }
                                    if (depthOrLayers == 0) depthOrLayers = 1;
                                    if (state->verboseLogging) {
                                        std::cout << "[WebGPU] copyTextureToBuffer: texture=" << texture
                                                  << ", buffer=" << buffer
                                                  << ", size=" << width << "x" << height << "x" << depthOrLayers
                                                  << ", bytesPerRow=" << bytesPerRow << std::endl;
                                    }
                                    if (buffer && texture) {
                                        WGPUImageCopyTexture_Compat srcCopy = {};
                                        srcCopy.texture = texture;
                                        srcCopy.mipLevel = mipLevel;
                                        srcCopy.origin = {originX, originY, originZ};
                                        WGPUImageCopyBuffer_Compat dstCopy = {};
                                        dstCopy.buffer = buffer;
                                        dstCopy.layout.offset = offset;
                                        dstCopy.layout.bytesPerRow = bytesPerRow;
                                        dstCopy.layout.rowsPerImage = rowsPerImage > 0 ? rowsPerImage : height;
                                        WGPUExtent3D copySize = {width, height, depthOrLayers};
                                        wgpuCommandEncoderCopyTextureToBuffer(state->registries.jsCommandEncoder,
                                                                              &srcCopy, &dstCopy, &copySize);
                                    }
                                    return state->engine->newUndefined();
}

static js::JSValueHandle handleGpuCommandEncoderCopyBufferToTexture(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args) {
    if (args.size() < 3 || !state->registries.jsCommandEncoder)
        return state->engine->newUndefined();
    auto sourceProp = args[0];
    auto destProp = args[1];
    auto sizeProp = args[2];
    // Source (buffer info)
    WGPUBuffer buffer = (WGPUBuffer)state->engine->getPrivateData(state->engine->getProperty(sourceProp, "buffer"));
    uint64_t offset = (uint64_t)state->engine->toNumber(state->engine->getProperty(sourceProp, "offset"));
    uint32_t bytesPerRow = (uint32_t)state->engine->toNumber(state->engine->getProperty(sourceProp, "bytesPerRow"));
    uint32_t rowsPerImage = (uint32_t)state->engine->toNumber(state->engine->getProperty(sourceProp, "rowsPerImage"));
    // Destination (texture info)
    WGPUTexture texture = (WGPUTexture)state->engine->getPrivateData(state->engine->getProperty(destProp, "texture"));
    uint32_t mipLevel = (uint32_t)state->engine->toNumber(state->engine->getProperty(destProp, "mipLevel"));
    auto originProp = state->engine->getProperty(destProp, "origin");
    uint32_t originX = 0, originY = 0, originZ = 0;
    if (!state->engine->isUndefined(originProp)) {
        originX = (uint32_t)state->engine->toNumber(state->engine->getPropertyIndex(originProp, 0));
        originY = (uint32_t)state->engine->toNumber(state->engine->getPropertyIndex(originProp, 1));
        originZ = (uint32_t)state->engine->toNumber(state->engine->getPropertyIndex(originProp, 2));
    }
                                    // Copy size
                                    uint32_t width = (uint32_t)state->engine->toNumber(state->engine->getPropertyIndex(sizeProp, 0));
                                    uint32_t height = (uint32_t)state->engine->toNumber(state->engine->getPropertyIndex(sizeProp, 1));
                                    uint32_t depthOrLayers = (uint32_t)state->engine->toNumber(state->engine->getPropertyIndex(sizeProp, 2));
                                    if (depthOrLayers == 0) depthOrLayers = 1;
                                    if (buffer && texture) {
                                        WGPUImageCopyBuffer_Compat srcCopy = {};
                                        srcCopy.buffer = buffer;
                                        srcCopy.layout.offset = offset;
                                        srcCopy.layout.bytesPerRow = bytesPerRow;
                                        srcCopy.layout.rowsPerImage = rowsPerImage > 0 ? rowsPerImage : height;
                                        WGPUImageCopyTexture_Compat dstCopy = {};
                                        dstCopy.texture = texture;
                                        dstCopy.mipLevel = mipLevel;
                                        dstCopy.origin = {originX, originY, originZ};
                                        WGPUExtent3D copySize = {width, height, depthOrLayers};
                                        wgpuCommandEncoderCopyBufferToTexture(state->registries.jsCommandEncoder,
                                                                              &srcCopy, &dstCopy, &copySize);
                                    }
                                    return state->engine->newUndefined();
}

static js::JSValueHandle handleGpuCommandEncoderCopyBufferToBuffer(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args) {
    if (args.size() < 5 || !state->registries.jsCommandEncoder)
        return state->engine->newUndefined();
    WGPUBuffer source = (WGPUBuffer)state->engine->getPrivateData(args[0]);
    uint64_t sourceOffset = (uint64_t)state->engine->toNumber(args[1]);
    WGPUBuffer destination = (WGPUBuffer)state->engine->getPrivateData(args[2]);
    uint64_t destOffset = (uint64_t)state->engine->toNumber(args[3]);
    uint64_t size = (uint64_t)state->engine->toNumber(args[4]);
    if (source && destination) {
        wgpuCommandEncoderCopyBufferToBuffer(state->registries.jsCommandEncoder, source, sourceOffset, destination,
                                             destOffset, size);
    }
                                    return state->engine->newUndefined();
}


// encoder.resolveQuerySet(querySet, firstQuery, queryCount, destination, destinationOffset)
//
// Timestamps land in an opaque query set; this is the only way to get them into a buffer the
// game can map and read. Fails by name on every malformed argument: a resolve that quietly did
// nothing leaves stale or zeroed bytes that read exactly like a measurement of a fast pass.
static js::JSValueHandle tnWebgpuHandlerResolveQuerySet(
    BindingsState* state, BindingDestination, const std::vector<js::JSValueHandle>& args) {
    if (args.size() < 5) {
        state->engine->throwException(
            "resolveQuerySet requires (querySet, firstQuery, queryCount, destination, destinationOffset)");
        return state->engine->newUndefined();
    }
    if (!state->registries.jsCommandEncoder) {
        state->engine->throwException("resolveQuerySet called with no command encoder");
        return state->engine->newUndefined();
    }
    WGPUQuerySet querySet = querySetFromJs(state, args[0], "resolveQuerySet");
    if (!querySet) return state->engine->newUndefined();
    WGPUBuffer destination = (WGPUBuffer)state->engine->getPrivateData(args[3]);
    if (!destination) {
        state->engine->throwException("resolveQuerySet destination is not a GPUBuffer");
        return state->engine->newUndefined();
    }
    const double firstQuery = state->engine->toNumber(args[1]);
    const double queryCount = state->engine->toNumber(args[2]);
    const double destinationOffset = state->engine->toNumber(args[4]);
    if (!(firstQuery >= 0.0) || firstQuery != std::floor(firstQuery) || !(queryCount >= 1.0) ||
        queryCount != std::floor(queryCount) || !(destinationOffset >= 0.0) ||
        destinationOffset != std::floor(destinationOffset)) {
        state->engine->throwException(
            "resolveQuerySet firstQuery, queryCount and destinationOffset must be non-negative integers");
        return state->engine->newUndefined();
    }
    wgpuCommandEncoderResolveQuerySet(state->registries.jsCommandEncoder, querySet, static_cast<uint32_t>(firstQuery),
                                      static_cast<uint32_t>(queryCount), destination,
                                      static_cast<uint64_t>(destinationOffset));
    return state->engine->newUndefined();
}

static js::JSValueHandle handleGpuComputePassEncoderEnd(
    BindingsState* state,
    WGPUCommandEncoder capturedEncoder,
    WGPUComputePassEncoder capturedComputePass,
    const std::vector<js::JSValueHandle>&) {
    auto passIt = state->registries.encoderComputePassMap.find(capturedEncoder);
    if (capturedComputePass && passIt != state->registries.encoderComputePassMap.end() &&
        passIt->second == capturedComputePass) {
        wgpuComputePassEncoderEnd(capturedComputePass);
        wgpuComputePassEncoderRelease(capturedComputePass);
        state->registries.encoderComputePassMap.erase(passIt);
        if (state->registries.jsComputePass == capturedComputePass) {
            state->registries.jsComputePass = nullptr;
        }
    }
                                            return state->engine->newUndefined();
}

static js::JSValueHandle handleGpuComputePassEncoderDispatchWorkgroups(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args) {
                                            if (args.empty()) return state->engine->newUndefined();
                                            uint32_t countX = (uint32_t)state->engine->toNumber(args[0]);
                                            uint32_t countY = args.size() > 1 ? (uint32_t)state->engine->toNumber(args[1]) : 1;
                                            uint32_t countZ = args.size() > 2 ? (uint32_t)state->engine->toNumber(args[2]) : 1;
                                            if (state->registries.jsComputePass) {
                                                wgpuComputePassEncoderDispatchWorkgroups(
                                                    state->registries.jsComputePass, countX, countY, countZ);
                                            }
                                            return state->engine->newUndefined();
}

static js::JSValueHandle handleGpuComputePassEncoderDispatchWorkgroupsIndirect(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args) {
                                            if (args.size() < 2) return state->engine->newUndefined();
                                            WGPUBuffer indirectBuffer = (WGPUBuffer)state->engine->getPrivateData(args[0]);
                                            uint64_t indirectOffset = (uint64_t)state->engine->toNumber(args[1]);
                                            if (state->registries.jsComputePass && indirectBuffer) {
                                                wgpuComputePassEncoderDispatchWorkgroupsIndirect(state->registries.jsComputePass, indirectBuffer, indirectOffset);
                                                if (state->verboseLogging) std::cout << "[WebGPU] DispatchWorkgroupsIndirect at offset " << indirectOffset << std::endl;
                                            }
                                            return state->engine->newUndefined();
}

static js::JSValueHandle handleGpuComputePassEncoderSetBindGroup(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args) {
                                            if (args.size() < 2) return state->engine->newUndefined();
                                            uint32_t index = (uint32_t)state->engine->toNumber(args[0]);
                                            WGPUBindGroup bindGroup = (WGPUBindGroup)state->engine->getPrivateData(args[1]);
                                            if (state->registries.jsComputePass && bindGroup) {
                                                wgpuComputePassEncoderSetBindGroup(state->registries.jsComputePass,
                                                                                   index, bindGroup, 0, nullptr);
                                            }
                                            return state->engine->newUndefined();
}

static js::JSValueHandle handleGpuComputePassEncoderSetPipeline(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args) {
                                            if (args.empty()) return state->engine->newUndefined();
                                            WGPUComputePipeline pipeline = (WGPUComputePipeline)state->engine->getPrivateData(args[0]);
                                            if (state->registries.jsComputePass && pipeline) {
                                                wgpuComputePassEncoderSetPipeline(state->registries.jsComputePass,
                                                                                  pipeline);
                                            }
                                            return state->engine->newUndefined();
}

static js::JSValueHandle handleGpuCommandEncoderBeginComputePass(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args) {
    if (!state->registries.jsCommandEncoder) {
        state->engine->throwException("No command encoder");
        return state->engine->newUndefined();
    }
                                    WGPUComputePassDescriptor computePassDesc = {};
                                    WGPUComputePassTimestampWrites_Compat computeTimestampWrites = {};
                                    bool hasComputeTimestampWrites = false;
                                    if (!args.empty() &&
                                        !readTimestampWrites(state, args[0],
                                                             "commandEncoder.beginComputePass",
                                                             computeTimestampWrites,
                                                             hasComputeTimestampWrites))
                                        return state->engine->newUndefined();
                                    if (hasComputeTimestampWrites)
                                        computePassDesc.timestampWrites = &computeTimestampWrites;
                                    WGPUCommandEncoder capturedEncoder = state->registries.jsCommandEncoder;
                                    WGPUComputePassEncoder computePass =
                                        wgpuCommandEncoderBeginComputePass(capturedEncoder, &computePassDesc);
                                    if (!requireHandle(state->engine, computePass, "commandEncoder.beginComputePass"))
                                        return state->engine->newUndefined();
                                    const WGPUComputePassEncoder previousJsComputePass =
                                        state->registries.jsComputePass;
                                    const auto previousComputePassIt =
                                        state->registries.encoderComputePassMap.find(capturedEncoder);
                                    const bool hadPreviousComputePass =
                                        previousComputePassIt != state->registries.encoderComputePassMap.end();
                                    const WGPUComputePassEncoder previousComputePassForEncoder =
                                        hadPreviousComputePass ? previousComputePassIt->second : nullptr;
                                    state->registries.jsComputePass = computePass;
                                    state->registries.encoderComputePassMap[capturedEncoder] = computePass;
                                    auto jsComputePass = state->engine->newObject();
                                    // computePass.setPipeline(pipeline)
                                    if (!installBindingTable(state->engine, state, bindingTable({
                                        {"GPUComputePassEncoder", "setPipeline", 0, nullptr,
                                        &handleGpuComputePassEncoderSetPipeline
                                    , jsComputePass},
                                    // computePass.setBindGroup(index, bindGroup, dynamicOffsets?)
                                                                            {"GPUComputePassEncoder", "setBindGroup", 0, nullptr,
                                        &handleGpuComputePassEncoderSetBindGroup
                                    , jsComputePass},
                                    // computePass.dispatchWorkgroups(countX, countY?, countZ?)
                                                                            {"GPUComputePassEncoder", "dispatchWorkgroups", 0, nullptr,
                                        &handleGpuComputePassEncoderDispatchWorkgroups
                                    , jsComputePass},
                                    // computePass.dispatchWorkgroupsIndirect(indirectBuffer, indirectOffset)
                                                                            {"GPUComputePassEncoder", "dispatchWorkgroupsIndirect", 0, nullptr,
                                        &handleGpuComputePassEncoderDispatchWorkgroupsIndirect
                                    , jsComputePass},
                                    // computePass.end()
                                                                            {"GPUComputePassEncoder", "end", 0, nullptr,
                                        makeCapturedPairHandler(capturedEncoder, computePass, &handleGpuComputePassEncoderEnd)
                                    , jsComputePass}}))) {
                                        wgpuComputePassEncoderEnd(computePass);
                                        wgpuComputePassEncoderRelease(computePass);
                                        auto it = state->registries.encoderComputePassMap.find(capturedEncoder);
                                        if (it != state->registries.encoderComputePassMap.end() &&
                                            it->second == computePass) {
                                            if (hadPreviousComputePass) {
                                                it->second = previousComputePassForEncoder;
                                            } else {
                                                state->registries.encoderComputePassMap.erase(it);
                                            }
                                        } else if (hadPreviousComputePass) {
                                            state->registries.encoderComputePassMap[capturedEncoder] =
                                                previousComputePassForEncoder;
                                        }
                                        state->registries.jsComputePass = previousJsComputePass;
                                        return state->engine->newUndefined();
                                    }
                                    if (state->verboseLogging) std::cout << "[WebGPU] Compute pass started" << std::endl;
                                    return jsComputePass;
}


static js::JSValueHandle handleGpuRenderPassEncoderEnd(
    BindingsState* state,
    WGPUCommandEncoder capturedEncoderForEnd,
    WGPURenderPassEncoder capturedRenderPass,
    const std::vector<js::JSValueHandle>& args) {
#if TN_ANDROID_JS_PROFILE
                                            const auto profileStart = beginProfiledBinding();
#endif
                                            auto passIt =
                                                state->registries.encoderRenderPassMap.find(capturedEncoderForEnd);
                                            if (capturedRenderPass &&
                                                passIt != state->registries.encoderRenderPassMap.end() &&
                                                passIt->second == capturedRenderPass) {
                                                wgpuRenderPassEncoderEnd(capturedRenderPass);
                                                wgpuRenderPassEncoderRelease(capturedRenderPass);
                                                // Remove from per-encoder map
                                                state->registries.encoderRenderPassMap.erase(passIt);
                                                // Clear global if it matches
                                                if (state->registries.jsRenderPass == capturedRenderPass) {
                                                    state->registries.jsRenderPass = nullptr;
                                                }
                                                // Mark surface render pass as ended
                                                if (state->presentation.surfaceRenderEncoder == capturedEncoderForEnd) {
                                                    state->presentation.surfaceRenderPassEnded = true;
                                                }
                                                if (state->verboseLogging) std::cout << "[WebGPU] Render pass ended" << std::endl;
                                            }
#if TN_ANDROID_JS_PROFILE
                                            endProfiledBinding(state, ProfiledRenderCommand::EndRenderPass, profileStart);
#endif
                                            return state->engine->newUndefined();
}

static js::JSValueHandle handleGpuRenderPassEncoderExecuteBundles(BindingsState* state, WGPURenderPassEncoder capturedRenderPassForBundles, const std::vector<js::JSValueHandle>& args) {
                                            if (args.empty() || !capturedRenderPassForBundles) return state->engine->newUndefined();
#if TN_ANDROID_JS_PROFILE
                                            const auto profileStart = beginProfiledBinding();
#endif
                                            auto bundlesArray = args[0];
                                            auto lengthProp = state->engine->getProperty(bundlesArray, "length");
                                            int bundleCount = state->engine->isUndefined(lengthProp) ? 0 : (int)state->engine->toNumber(lengthProp);
                                            std::vector<WGPURenderBundle> bundles;
                                            bundles.reserve(bundleCount);
                                            for (int i = 0; i < bundleCount; i++) {
                                                auto bundleHandle = state->engine->getPropertyIndex(bundlesArray, i);
                                                WGPURenderBundle bundle = (WGPURenderBundle)state->engine->getPrivateData(bundleHandle);
                                                if (bundle) bundles.push_back(bundle);
                                            }
                                            if (!bundles.empty()) {
                                                wgpuRenderPassEncoderExecuteBundles(capturedRenderPassForBundles, bundles.size(), bundles.data());
#if TN_ANDROID_JS_PROFILE
                                                state->profiling.androidJsNativeProfile.bundlesExecuted +=
                                                    bundles.size();
#endif
                                                if (state->verboseLogging) std::cout << "[WebGPU] Executed " << bundles.size() << " render bundles" << std::endl;
                                            }
#if TN_ANDROID_JS_PROFILE
                                            endProfiledBinding(state, ProfiledRenderCommand::ExecuteBundles, profileStart);
#endif
                                            return state->engine->newUndefined();
}

static js::JSValueHandle handleGpuRenderPassEncoderSetStencilReference(BindingsState* state, WGPURenderPassEncoder capturedRenderPassForCommands, const std::vector<js::JSValueHandle>& args) {
                                            if (args.empty()) return state->engine->newUndefined();
                                            uint32_t reference = (uint32_t)state->engine->toNumber(args[0]);
                                            if (capturedRenderPassForCommands) {
                                                wgpuRenderPassEncoderSetStencilReference(capturedRenderPassForCommands, reference);
                                            }
                                            return state->engine->newUndefined();
}

static js::JSValueHandle handleGpuRenderPassEncoderSetBlendConstant(BindingsState* state, WGPURenderPassEncoder capturedRenderPassForCommands, const std::vector<js::JSValueHandle>& args) {
                                            if (args.empty()) return state->engine->newUndefined();
                                            auto color = args[0];
                                            WGPUColor blendColor = {};
                                            if (state->engine->isArray(color)) {
                                                blendColor.r = state->engine->toNumber(state->engine->getPropertyIndex(color, 0));
                                                blendColor.g = state->engine->toNumber(state->engine->getPropertyIndex(color, 1));
                                                blendColor.b = state->engine->toNumber(state->engine->getPropertyIndex(color, 2));
                                                blendColor.a = state->engine->toNumber(state->engine->getPropertyIndex(color, 3));
                                            } else {
                                                blendColor.r = state->engine->toNumber(state->engine->getProperty(color, "r"));
                                                blendColor.g = state->engine->toNumber(state->engine->getProperty(color, "g"));
                                                blendColor.b = state->engine->toNumber(state->engine->getProperty(color, "b"));
                                                blendColor.a = state->engine->toNumber(state->engine->getProperty(color, "a"));
                                            }
                                            if (capturedRenderPassForCommands) {
                                                wgpuRenderPassEncoderSetBlendConstant(capturedRenderPassForCommands, &blendColor);
                                            }
                                            return state->engine->newUndefined();
}

static js::JSValueHandle handleGpuRenderPassEncoderSetScissorRect(BindingsState* state, WGPURenderPassEncoder capturedRenderPassForCommands, const std::vector<js::JSValueHandle>& args) {
                                            if (args.size() < 4) return state->engine->newUndefined();
                                            uint32_t x = (uint32_t)state->engine->toNumber(args[0]);
                                            uint32_t y = (uint32_t)state->engine->toNumber(args[1]);
                                            uint32_t width = (uint32_t)state->engine->toNumber(args[2]);
                                            uint32_t height = (uint32_t)state->engine->toNumber(args[3]);
                                            if (capturedRenderPassForCommands) {
                                                wgpuRenderPassEncoderSetScissorRect(capturedRenderPassForCommands, x, y, width, height);
                                                if (state->verboseLogging) std::cout << "[WebGPU] SetScissorRect: " << x << "," << y << " " << width << "x" << height << std::endl;
                                            }
                                            return state->engine->newUndefined();
}

static js::JSValueHandle handleGpuRenderPassEncoderSetViewport(BindingsState* state, WGPURenderPassEncoder capturedRenderPassForCommands, const std::vector<js::JSValueHandle>& args) {
                                            if (args.size() < 6) return state->engine->newUndefined();
                                            float x = (float)state->engine->toNumber(args[0]);
                                            float y = (float)state->engine->toNumber(args[1]);
                                            float width = (float)state->engine->toNumber(args[2]);
                                            float height = (float)state->engine->toNumber(args[3]);
                                            float minDepth = (float)state->engine->toNumber(args[4]);
                                            float maxDepth = (float)state->engine->toNumber(args[5]);
                                            if (capturedRenderPassForCommands) {
                                                wgpuRenderPassEncoderSetViewport(capturedRenderPassForCommands, x, y, width, height, minDepth, maxDepth);
                                                if (state->verboseLogging) std::cout << "[WebGPU] SetViewport: " << x << "," << y << " " << width << "x" << height << std::endl;
                                            }
                                            return state->engine->newUndefined();
}

static js::JSValueHandle handleGpuRenderPassEncoderDrawIndexedIndirect(BindingsState* state, WGPURenderPassEncoder capturedRenderPassForCommands, const std::vector<js::JSValueHandle>& args) {
                                            if (args.size() < 2) return state->engine->newUndefined();
                                            WGPUBuffer indirectBuffer = (WGPUBuffer)state->engine->getPrivateData(args[0]);
                                            uint64_t indirectOffset = (uint64_t)state->engine->toNumber(args[1]);
                                            if (capturedRenderPassForCommands && indirectBuffer) {
                                                wgpuRenderPassEncoderDrawIndexedIndirect(capturedRenderPassForCommands, indirectBuffer, indirectOffset);
                                                if (state->verboseLogging) std::cout << "[WebGPU] DrawIndexedIndirect at offset " << indirectOffset << std::endl;
                                            }
                                            return state->engine->newUndefined();
}

static js::JSValueHandle handleGpuRenderPassEncoderDrawIndirect(BindingsState* state, WGPURenderPassEncoder capturedRenderPassForCommands, const std::vector<js::JSValueHandle>& args) {
                                            if (args.size() < 2) return state->engine->newUndefined();
                                            WGPUBuffer indirectBuffer = (WGPUBuffer)state->engine->getPrivateData(args[0]);
                                            uint64_t indirectOffset = (uint64_t)state->engine->toNumber(args[1]);
                                            if (capturedRenderPassForCommands && indirectBuffer) {
                                                wgpuRenderPassEncoderDrawIndirect(capturedRenderPassForCommands, indirectBuffer, indirectOffset);
                                                if (state->verboseLogging) std::cout << "[WebGPU] DrawIndirect at offset " << indirectOffset << std::endl;
                                            }
                                            return state->engine->newUndefined();
}

static js::JSValueHandle handleGpuRenderPassEncoderDrawIndexed(BindingsState* state, WGPURenderPassEncoder capturedRenderPassForCommands, const std::vector<js::JSValueHandle>& args) {
                                            if (args.empty()) return state->engine->newUndefined();
#if TN_ANDROID_JS_PROFILE
                                            const auto profileStart = beginProfiledBinding();
#endif
                                            uint32_t indexCount = (uint32_t)state->engine->toNumber(args[0]);
                                            uint32_t instanceCount = args.size() > 1 ? (uint32_t)state->engine->toNumber(args[1]) : 1;
                                            uint32_t firstIndex = args.size() > 2 ? (uint32_t)state->engine->toNumber(args[2]) : 0;
                                            int32_t baseVertex = args.size() > 3 ? (int32_t)state->engine->toNumber(args[3]) : 0;
                                            uint32_t firstInstance = args.size() > 4 ? (uint32_t)state->engine->toNumber(args[4]) : 0;
                                            if (capturedRenderPassForCommands) {
                                                wgpuRenderPassEncoderDrawIndexed(capturedRenderPassForCommands, indexCount, instanceCount, firstIndex, baseVertex, firstInstance);
                                                if (state->verboseLogging) std::cout << "[WebGPU] DrawIndexed: " << indexCount << " indices, firstInstance=" << firstInstance << std::endl;
                                            }
#if TN_ANDROID_JS_PROFILE
                                            endProfiledBinding(state, ProfiledRenderCommand::DrawIndexed, profileStart);
#endif
                                            return state->engine->newUndefined();
}

static js::JSValueHandle handleGpuRenderPassEncoderSetIndexBuffer(BindingsState* state, WGPURenderPassEncoder capturedRenderPassForCommands, const std::vector<js::JSValueHandle>& args) {
                                            if (args.size() < 2) return state->engine->newUndefined();
#if TN_ANDROID_JS_PROFILE
                                            const auto profileStart = beginProfiledBinding();
#endif
                                            WGPUBuffer buffer = (WGPUBuffer)state->engine->getPrivateData(args[0]);
                                            std::string formatStr = state->engine->toString(args[1]);
                                            uint64_t offset = args.size() > 2 ? (uint64_t)state->engine->toNumber(args[2]) : 0;
                                            uint64_t size = args.size() > 3 ? (uint64_t)state->engine->toNumber(args[3]) : WGPU_WHOLE_SIZE;
                                            WGPUIndexFormat format = WGPUIndexFormat_Uint16;
                                            if (formatStr == "uint32") format = WGPUIndexFormat_Uint32;
                                            else if (formatStr == "uint16") format = WGPUIndexFormat_Uint16;
                                            if (capturedRenderPassForCommands && buffer) {
                                                wgpuRenderPassEncoderSetIndexBuffer(capturedRenderPassForCommands, buffer, format, offset, size);
                                                if (state->verboseLogging) std::cout << "[WebGPU] Set index buffer, format: " << formatStr << std::endl;
                                            }
#if TN_ANDROID_JS_PROFILE
                                            endProfiledBinding(state, ProfiledRenderCommand::SetIndexBuffer, profileStart);
#endif
                                            return state->engine->newUndefined();
}

static js::JSValueHandle handleGpuRenderPassEncoderSetVertexBuffer(BindingsState* state, WGPURenderPassEncoder capturedRenderPassForCommands, const std::vector<js::JSValueHandle>& args) {
                                            if (args.size() < 2) return state->engine->newUndefined();
#if TN_ANDROID_JS_PROFILE
                                            const auto profileStart = beginProfiledBinding();
#endif
                                            uint32_t slot = (uint32_t)state->engine->toNumber(args[0]);
                                            WGPUBuffer buffer = (WGPUBuffer)state->engine->getPrivateData(args[1]);
                                            uint64_t offset = args.size() > 2 ? (uint64_t)state->engine->toNumber(args[2]) : 0;
                                            uint64_t size = args.size() > 3 ? (uint64_t)state->engine->toNumber(args[3]) : WGPU_WHOLE_SIZE;
                                            if (capturedRenderPassForCommands && buffer) {
                                                wgpuRenderPassEncoderSetVertexBuffer(capturedRenderPassForCommands, slot, buffer, offset, size);
                                                if (state->verboseLogging) std::cout << "[WebGPU] Set vertex buffer at slot " << slot << std::endl;
                                            }
#if TN_ANDROID_JS_PROFILE
                                            endProfiledBinding(state, ProfiledRenderCommand::SetVertexBuffer, profileStart);
#endif
                                            return state->engine->newUndefined();
}

static js::JSValueHandle handleGpuRenderPassEncoderDraw(BindingsState* state, WGPURenderPassEncoder capturedRenderPassForCommands, const std::vector<js::JSValueHandle>& args) {
                                            if (args.empty()) return state->engine->newUndefined();
#if TN_ANDROID_JS_PROFILE
                                            const auto profileStart = beginProfiledBinding();
#endif
                                            uint32_t vertexCount = (uint32_t)state->engine->toNumber(args[0]);
                                            uint32_t instanceCount = args.size() > 1 ? (uint32_t)state->engine->toNumber(args[1]) : 1;
                                            uint32_t firstVertex = args.size() > 2 ? (uint32_t)state->engine->toNumber(args[2]) : 0;
                                            uint32_t firstInstance = args.size() > 3 ? (uint32_t)state->engine->toNumber(args[3]) : 0;
                                            if (capturedRenderPassForCommands) {
                                                wgpuRenderPassEncoderDraw(capturedRenderPassForCommands, vertexCount, instanceCount, firstVertex, firstInstance);
                                                if (state->verboseLogging) std::cout << "[WebGPU] Draw: " << vertexCount << " vertices" << std::endl;
                                            }
#if TN_ANDROID_JS_PROFILE
                                            endProfiledBinding(state, ProfiledRenderCommand::Draw, profileStart);
#endif
                                            return state->engine->newUndefined();
}

static js::JSValueHandle handleGpuRenderPassEncoderSetBindGroup(BindingsState* state, WGPURenderPassEncoder capturedRenderPassForCommands, const std::vector<js::JSValueHandle>& args) {
                                            if (args.size() < 2) {
                                                state->engine->throwException("setBindGroup requires index and bindGroup");
                                                return state->engine->newUndefined();
                                            }
#if TN_ANDROID_JS_PROFILE
                                            const auto profileStart = beginProfiledBinding();
#endif
                                            uint32_t groupIndex = (uint32_t)state->engine->toNumber(args[0]);
                                            WGPUBindGroup bindGroup = (WGPUBindGroup)state->engine->getPrivateData(args[1]);
                                            if (capturedRenderPassForCommands && bindGroup) {
                                                // TODO: Support dynamic offsets
                                                wgpuRenderPassEncoderSetBindGroup(capturedRenderPassForCommands, groupIndex, bindGroup, 0, nullptr);
                                                if (state->verboseLogging) std::cout << "[WebGPU] Set bind group at index " << groupIndex << std::endl;
                                            }
#if TN_ANDROID_JS_PROFILE
                                            endProfiledBinding(state, ProfiledRenderCommand::SetBindGroup, profileStart);
#endif
                                            return state->engine->newUndefined();
}

static js::JSValueHandle handleGpuRenderPassEncoderSetPipeline(BindingsState* state, WGPURenderPassEncoder capturedRenderPassForCommands, const std::vector<js::JSValueHandle>& args) {
                                            if (args.empty()) return state->engine->newUndefined();
#if TN_ANDROID_JS_PROFILE
                                            const auto profileStart = beginProfiledBinding();
#endif
                                            WGPURenderPipeline pipeline = (WGPURenderPipeline)state->engine->getPrivateData(args[0]);
                                            if (capturedRenderPassForCommands && pipeline) {
                                                wgpuRenderPassEncoderSetPipeline(capturedRenderPassForCommands, pipeline);
                                                if (state->verboseLogging) std::cout << "[WebGPU] Pipeline set" << std::endl;
                                            }
#if TN_ANDROID_JS_PROFILE
                                            endProfiledBinding(state, ProfiledRenderCommand::SetPipeline, profileStart);
#endif
                                            return state->engine->newUndefined();
}

// Defined below the handler rows; handler38's wrapper creation takes this fast path first.
static bool ensureRenderPassEncoderClassTable(
    BindingsState* state, js::JSValueHandle& outPrototype);

static js::JSValueHandle handleGpuCommandEncoderBeginRenderPass(BindingsState* state, WGPUCommandEncoder capturedEncoder, const std::vector<js::JSValueHandle>& args) {
                                    if (args.empty()) {
                                        state->engine->throwException("beginRenderPass requires a descriptor");
                                        return state->engine->newUndefined();
                                    }
                                    // Use the captured encoder for this specific command encoder
                                    WGPUCommandEncoder encoderToUse = capturedEncoder;
                                    if (!encoderToUse) {
                                        state->engine->throwException("Command encoder not available");
                                        return state->engine->newUndefined();
                                    }
                                    auto descriptor = args[0];
                                    const WGPUCommandEncoder previousSurfaceRenderEncoder =
                                        state->presentation.surfaceRenderEncoder;
                                    const bool previousSurfaceRenderPassEnded =
                                        state->presentation.surfaceRenderPassEnded;
                                    const WGPURenderPassEncoder previousJsRenderPass = state->registries.jsRenderPass;
                                    const auto previousRenderPassIt =
                                        state->registries.encoderRenderPassMap.find(encoderToUse);
                                    const bool hadPreviousRenderPass =
                                        previousRenderPassIt != state->registries.encoderRenderPassMap.end();
                                    const WGPURenderPassEncoder previousRenderPassForEncoder =
                                        hadPreviousRenderPass ? previousRenderPassIt->second : nullptr;
                                    auto colorAttachments = state->engine->getProperty(descriptor, "colorAttachments");
                                    // Parse all color attachments (deferred renderer uses multiple)
                                    auto attachmentsLengthProp = state->engine->getProperty(colorAttachments, "length");
                                    int numAttachments = state->engine->isUndefined(attachmentsLengthProp) ? 0 : (int)state->engine->toNumber(attachmentsLengthProp);
                                    std::vector<WGPURenderPassColorAttachment> colorAttachmentList;
                                    colorAttachmentList.reserve(numAttachments);
                                    bool touchesSurface = false;
                                    double firstR = 0, firstG = 0, firstB = 0, firstA = 1;
                                    for (int i = 0; i < numAttachments; i++) {
                                        auto attachment = state->engine->getPropertyIndex(colorAttachments, i);
                                        auto viewHandle = state->engine->getProperty(attachment, "view");
                                        WGPUTextureView view = (WGPUTextureView)state->engine->getPrivateData(viewHandle);
                                        // Debug: Log first color attachment for comparison with
                                        // state->presentation.currentTextureView
                                        if (i == 0) {
                                            if (state->verboseLogging) {
                                                std::cout
                                                    << "[WebGPU] Render pass attachment[0]: view=" << (void*)view
                                                    << ", state->presentation.currentTextureView="
                                                    << (void*)state->presentation.currentTextureView << ", matches="
                                                    << (view == state->presentation.currentTextureView ? "YES" : "NO")
                                                    << std::endl;
                                            }
                                        }
                                        touchesSurface = touchesSurface || isCurrentSurfaceTextureView(state, view);
                                        // Debug: Log GBuffer pass attachments
                                        if (numAttachments >= 5 && i == 0) {
                                            if (state->verboseLogging) std::cout << "[WebGPU] GBuffer pass - 5 attachments, view[0]=" << (void*)view << std::endl;
                                        }
                                        if (!view && numAttachments >= 5) {
                                            std::cerr << "[WebGPU] ERROR: GBuffer attachment " << i << " has null view!" << std::endl;
                                        }
                                        // Parse loadOp (default 'clear')
                                        WGPULoadOp loadOp = WGPULoadOp_Clear;
                                        auto loadOpProp = state->engine->getProperty(attachment, "loadOp");
                                        if (!state->engine->isUndefined(loadOpProp)) {
                                            std::string loadOpStr = state->engine->toString(loadOpProp);
                                            if (loadOpStr == "load") loadOp = WGPULoadOp_Load;
                                        }
                                        // Parse storeOp (default 'store')
                                        WGPUStoreOp storeOp = WGPUStoreOp_Store;
                                        auto storeOpProp = state->engine->getProperty(attachment, "storeOp");
                                        if (!state->engine->isUndefined(storeOpProp)) {
                                            std::string storeOpStr = state->engine->toString(storeOpProp);
                                            if (storeOpStr == "discard") storeOp = WGPUStoreOp_Discard;
                                        }
                                        // Parse clearValue only if loadOp is 'clear'
                                        double r = 0, g = 0, b = 0, a = 1;
                                        if (loadOp == WGPULoadOp_Clear) {
                                            auto clearValue = state->engine->getProperty(attachment, "clearValue");
                                            if (!state->engine->isUndefined(clearValue)) {
                                                // Check if it's an array [r, g, b, a] or object {r, g, b, a}
                                                if (state->engine->isArray(clearValue)) {
                                                    r = state->engine->toNumber(state->engine->getPropertyIndex(clearValue, 0));
                                                    g = state->engine->toNumber(state->engine->getPropertyIndex(clearValue, 1));
                                                    b = state->engine->toNumber(state->engine->getPropertyIndex(clearValue, 2));
                                                    a = state->engine->toNumber(state->engine->getPropertyIndex(clearValue, 3));
                                                } else {
                                                    r = state->engine->toNumber(state->engine->getProperty(clearValue, "r"));
                                                    g = state->engine->toNumber(state->engine->getProperty(clearValue, "g"));
                                                    b = state->engine->toNumber(state->engine->getProperty(clearValue, "b"));
                                                    a = state->engine->toNumber(state->engine->getProperty(clearValue, "a"));
                                                }
                                            }
                                        }
                                        if (i == 0) {
                                            firstR = r; firstG = g; firstB = b; firstA = a;
                                        }
                                        WGPURenderPassColorAttachment colorAttachment = {};
                                        colorAttachment.view = view;
                                        auto resolveTargetHandle = state->engine->getProperty(attachment, "resolveTarget");
                                        if (!state->engine->isUndefined(resolveTargetHandle) &&
                                            !state->engine->isNull(resolveTargetHandle)) {
                                            colorAttachment.resolveTarget = static_cast<WGPUTextureView>(
                                                state->engine->getPrivateData(resolveTargetHandle));
                                            touchesSurface = touchesSurface ||
                                                             isCurrentSurfaceTextureView(
                                                                 state, colorAttachment.resolveTarget);
                                        }
                                        colorAttachment.loadOp = loadOp;
                                        colorAttachment.storeOp = storeOp;
                                        colorAttachment.clearValue = {r, g, b, a};
                                        auto depthSliceProp = state->engine->getProperty(attachment, "depthSlice");
                                        if (state->engine->isUndefined(depthSliceProp) ||
                                            state->engine->isNull(depthSliceProp)) {
                                            colorAttachment.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
                                        } else {
                                            const double depthSlice = state->engine->toNumber(depthSliceProp);
                                            if (!std::isfinite(depthSlice) || depthSlice < 0 ||
                                                std::floor(depthSlice) != depthSlice ||
                                                depthSlice > std::numeric_limits<uint32_t>::max()) {
                                                state->engine->throwException(
                                                    "beginRenderPass depthSlice must be a non-negative integer");
                                                return state->engine->newUndefined();
                                            }
                                            colorAttachment.depthSlice = static_cast<uint32_t>(depthSlice);
                                        }
                                        colorAttachmentList.push_back(colorAttachment);
                                    }
                                    if (touchesSurface) {
                                        state->presentation.surfaceRenderEncoder = encoderToUse;
                                        state->presentation.surfaceRenderPassEnded = false;
                                    }
                                    WGPURenderPassDescriptor renderPassDesc = {};
                                    renderPassDesc.colorAttachmentCount = colorAttachmentList.size();
                                    renderPassDesc.colorAttachments = colorAttachmentList.data();
                                    // Parse depth stencil attachment if present
                                    WGPURenderPassDepthStencilAttachment depthStencilAttachment = {};
                                    auto depthStencilProp = state->engine->getProperty(descriptor, "depthStencilAttachment");
                                    if (!state->engine->isUndefined(depthStencilProp)) {
                                        auto depthViewHandle = state->engine->getProperty(depthStencilProp, "view");
                                        WGPUTextureView depthView = (WGPUTextureView)state->engine->getPrivateData(depthViewHandle);
                                        depthStencilAttachment.view = depthView;
                                        // Depth clear value (default 1.0)
                                        auto depthClearValueProp = state->engine->getProperty(depthStencilProp, "depthClearValue");
                                        depthStencilAttachment.depthClearValue = state->engine->isUndefined(depthClearValueProp)
                                            ? 1.0f : (float)state->engine->toNumber(depthClearValueProp);
                                        // Depth load/store ops (default clear/store)
                                        auto depthLoadOpProp = state->engine->getProperty(depthStencilProp, "depthLoadOp");
                                        if (!state->engine->isUndefined(depthLoadOpProp)) {
                                            std::string loadOpStr = state->engine->toString(depthLoadOpProp);
                                            if (loadOpStr == "load") depthStencilAttachment.depthLoadOp = WGPULoadOp_Load;
                                            else depthStencilAttachment.depthLoadOp = WGPULoadOp_Clear;
                                        } else {
                                            depthStencilAttachment.depthLoadOp = WGPULoadOp_Clear;
                                        }
                                        auto depthStoreOpProp = state->engine->getProperty(depthStencilProp, "depthStoreOp");
                                        if (!state->engine->isUndefined(depthStoreOpProp)) {
                                            std::string storeOpStr = state->engine->toString(depthStoreOpProp);
                                            if (storeOpStr == "discard") depthStencilAttachment.depthStoreOp = WGPUStoreOp_Discard;
                                            else depthStencilAttachment.depthStoreOp = WGPUStoreOp_Store;
                                        } else {
                                            depthStencilAttachment.depthStoreOp = WGPUStoreOp_Store;
                                        }
                                        // Stencil ops (default undefined/disabled)
                                        depthStencilAttachment.stencilClearValue = 0;
                                        depthStencilAttachment.stencilLoadOp = WGPULoadOp_Undefined;
                                        depthStencilAttachment.stencilStoreOp = WGPUStoreOp_Undefined;
                                        renderPassDesc.depthStencilAttachment = &depthStencilAttachment;
                                        if (state->verboseLogging) std::cout << "[WebGPU] Render pass with depth attachment, clear=" << depthStencilAttachment.depthClearValue << std::endl;
                                    }
                                    // Optional GPU timestamps around this pass. Parsed before the
                                    // pass begins so a malformed block fails the call rather than
                                    // producing an untimed pass whose readback looks measured.
                                    WGPURenderPassTimestampWrites_Compat renderTimestampWrites = {};
                                    bool hasRenderTimestampWrites = false;
                                    if (!readTimestampWrites(state, descriptor,
                                                             "commandEncoder.beginRenderPass",
                                                             renderTimestampWrites,
                                                             hasRenderTimestampWrites)) {
                                        state->presentation.surfaceRenderEncoder = previousSurfaceRenderEncoder;
                                        state->presentation.surfaceRenderPassEnded = previousSurfaceRenderPassEnded;
                                        return state->engine->newUndefined();
                                    }
                                    if (hasRenderTimestampWrites)
                                        renderPassDesc.timestampWrites = &renderTimestampWrites;
                                    // Begin render pass on the captured encoder (not the global)
                                    WGPURenderPassEncoder renderPass = wgpuCommandEncoderBeginRenderPass(encoderToUse, &renderPassDesc);
                                    if (!requireHandle(state->engine, renderPass, "commandEncoder.beginRenderPass",
                                                       "colorAttachments=" + std::to_string(numAttachments))) {
                                        state->presentation.surfaceRenderEncoder = previousSurfaceRenderEncoder;
                                        state->presentation.surfaceRenderPassEnded = previousSurfaceRenderPassEnded;
                                        return state->engine->newUndefined();
                                    }
                                    // Store in per-encoder map (fixes issue with multiple encoders)
                                    state->registries.encoderRenderPassMap[encoderToUse] = renderPass;
                                    // Also set global for backwards compatibility with render pass methods
                                    state->registries.jsRenderPass = renderPass;
                                    if (state->verboseLogging) std::cout << "[WebGPU] Render pass started (" << numAttachments << " attachments), clear: (" << firstR << "," << firstG << "," << firstB << "," << firstA << ")" << std::endl;
                                    // Suspend frame tracking while creating render pass wrapper
                                    state->engine->suspendFrameTracking();
                                    auto jsRenderPass = createNativeWrapper(
                                        state, "GPURenderPassEncoder", renderPass);
                                    // Fast path: point this instance at the class's one-time
                                    // prototype instead of reinstalling fifteen methods
                                    // transactionally per pass (PRD-224 phase 2).
                                    js::JSValueHandle renderPassPrototype{};
                                    if (!state->engine->hasException() &&
                                        ensureRenderPassEncoderClassTable(state, renderPassPrototype) &&
                                        state->engine->setPrototypeOf(jsRenderPass, renderPassPrototype)) {
                                        state->engine->resumeFrameTracking();
                                        return jsRenderPass;
                                    }
                                    // Legacy per-call install: retained unchanged so the fast
                                    // path can be reverted in one commit.
                                    WGPURenderPassEncoder capturedRenderPassForCommands = renderPass;
                                    const auto rollbackRenderPass = [&]() {
                                        auto it = state->registries.encoderRenderPassMap.find(encoderToUse);
                                        if (it != state->registries.encoderRenderPassMap.end() &&
                                            it->second == renderPass) {
                                            if (hadPreviousRenderPass) {
                                                it->second = previousRenderPassForEncoder;
                                            } else {
                                                state->registries.encoderRenderPassMap.erase(it);
                                            }
                                        } else if (hadPreviousRenderPass) {
                                            state->registries.encoderRenderPassMap[encoderToUse] =
                                                previousRenderPassForEncoder;
                                        }
                                        state->registries.jsRenderPass = previousJsRenderPass;
                                        if (renderPass) {
                                            wgpuRenderPassEncoderEnd(renderPass);
                                            wgpuRenderPassEncoderRelease(renderPass);
                                            renderPass = nullptr;
                                        }
                                        state->presentation.surfaceRenderEncoder = previousSurfaceRenderEncoder;
                                        state->presentation.surfaceRenderPassEnded = previousSurfaceRenderPassEnded;
                                    };
                                    // renderPass.setPipeline(pipeline)
                                    if (!installBindingTable(state->engine, state, bindingTable({
                                        {"GPURenderPassEncoder", "setPipeline", 0, nullptr,
                                        makeCapturedHandler(renderPass, &handleGpuRenderPassEncoderSetPipeline)
                                    , jsRenderPass},
                                    // renderPass.setBindGroup(index, bindGroup, dynamicOffsets?)
                                        {"GPURenderPassEncoder", "setBindGroup", 0, nullptr,
                                        makeCapturedHandler(renderPass, &handleGpuRenderPassEncoderSetBindGroup)
                                    , jsRenderPass},
                                    // renderPass.draw(vertexCount, instanceCount?, firstVertex?, firstInstance?)
                                        {"GPURenderPassEncoder", "draw", 0, nullptr,
                                        makeCapturedHandler(renderPass, &handleGpuRenderPassEncoderDraw)
                                    , jsRenderPass},
                                    // renderPass.setVertexBuffer(slot, buffer, offset?, size?)
                                        {"GPURenderPassEncoder", "setVertexBuffer", 0, nullptr,
                                        makeCapturedHandler(renderPass, &handleGpuRenderPassEncoderSetVertexBuffer)
                                    , jsRenderPass},
                                    // renderPass.setIndexBuffer(buffer, format, offset?, size?)
                                        {"GPURenderPassEncoder", "setIndexBuffer", 0, nullptr,
                                        makeCapturedHandler(renderPass, &handleGpuRenderPassEncoderSetIndexBuffer)
                                    , jsRenderPass},
                                    // renderPass.drawIndexed(indexCount, instanceCount?, firstIndex?, baseVertex?, firstInstance?)
                                        {"GPURenderPassEncoder", "drawIndexed", 0, nullptr,
                                        makeCapturedHandler(renderPass, &handleGpuRenderPassEncoderDrawIndexed)
                                    , jsRenderPass},
                                    // renderPass.drawIndirect(indirectBuffer, indirectOffset)
                                        {"GPURenderPassEncoder", "drawIndirect", 0, nullptr,
                                        makeCapturedHandler(renderPass, &handleGpuRenderPassEncoderDrawIndirect)
                                    , jsRenderPass},
                                    // renderPass.drawIndexedIndirect(indirectBuffer, indirectOffset)
                                        {"GPURenderPassEncoder", "drawIndexedIndirect", 0, nullptr,
                                        makeCapturedHandler(renderPass, &handleGpuRenderPassEncoderDrawIndexedIndirect)
                                    , jsRenderPass},
                                    // renderPass.setViewport(x, y, width, height, minDepth, maxDepth)
                                        {"GPURenderPassEncoder", "setViewport", 0, nullptr,
                                        makeCapturedHandler(renderPass, &handleGpuRenderPassEncoderSetViewport)
                                    , jsRenderPass},
                                    // renderPass.setScissorRect(x, y, width, height)
                                        {"GPURenderPassEncoder", "setScissorRect", 0, nullptr,
                                        makeCapturedHandler(renderPass, &handleGpuRenderPassEncoderSetScissorRect)
                                    , jsRenderPass},
                                    // renderPass.setBlendConstant(color)
                                        {"GPURenderPassEncoder", "setBlendConstant", 0, nullptr,
                                        makeCapturedHandler(renderPass, &handleGpuRenderPassEncoderSetBlendConstant)
                                    , jsRenderPass},
                                    // renderPass.setStencilReference(reference)
                                        {"GPURenderPassEncoder", "setStencilReference", 0, nullptr,
                                        makeCapturedHandler(renderPass, &handleGpuRenderPassEncoderSetStencilReference)
                                    , jsRenderPass}}))) {
                                        rollbackRenderPass();
                                        state->engine->resumeFrameTracking();
                                        return state->engine->newUndefined();
                                    }
                                    // renderPass.executeBundles(bundles)
                                    // Used by Three.js for mipmap generation
                                    WGPURenderPassEncoder capturedRenderPassForBundles = renderPass;
                                    if (!installBindingTable(state->engine, state, bindingTable({
                                        {"GPURenderPassEncoder", "executeBundles", 0, nullptr,
                                        makeCapturedHandler(renderPass, &handleGpuRenderPassEncoderExecuteBundles)
                                    , jsRenderPass}}))) {
                                        rollbackRenderPass();
                                        state->engine->resumeFrameTracking();
                                        return state->engine->newUndefined();
                                    }
                                    // renderPass.end() - capture encoder and render pass for cleanup
                                    if (!installBindingTable(state->engine, state, bindingTable({
                                        {"GPURenderPassEncoder", "end", 0, nullptr,
                                        makeCapturedPairHandler(encoderToUse, renderPass, &handleGpuRenderPassEncoderEnd)
                                    , jsRenderPass}}))) {
                                        rollbackRenderPass();
                                        state->engine->resumeFrameTracking();
                                        return state->engine->newUndefined();
                                    }
                                    // Resume frame tracking
                                    state->engine->resumeFrameTracking();
                                    return jsRenderPass;
}

// ---------------------------------------------------------------------------
// Per-class binding tables (PRD-222).
//
// Every WebGPU object previously installed its method table per instance, per
// creating call, through the full transactional machinery — measured at
// 64 µs for device.createCommandEncoder against Chrome's 919 ns
// (docs/bugs/webgpu-binding-table-installed-per-call-2026-08-26.md). GPUCommandEncoder,
// the largest single measured tax, instead installs its table ONCE on a shared
// prototype below, and each wrapper instance points at it. Receiver-aware
// methods resolve their native handle from the receiver's private data.
// ---------------------------------------------------------------------------

/** Validation requires a non-null handler even when a row installs a prebuilt function. */
static js::JSValueHandle tnWebgpuClassRowPlaceholder(
    BindingsState* state, BindingDestination, const std::vector<js::JSValueHandle>&) {
    // Never dispatched: prebuiltFunction rows bypass BindingHandler entirely.
    return state->engine->newUndefined();
}

/**
 * Creates one receiver-aware method function that adapts a captured-handle handler
 * (handleGpuCommandEncoderBeginRenderPass/63 shape) to resolve its encoder from the receiving wrapper instead of a
 * per-instance closure capture.
 */
static js::JSValueHandle makeCommandEncoderMethod(
    BindingsState* state,
    const char* name,
    js::JSValueHandle (*method)(
        BindingsState*, WGPUCommandEncoder, const std::vector<js::JSValueHandle>&),
    const char* missingReceiverError) {
    auto* engine = state->engine;
    return engine->newMethod(
        name,
        [state, method, missingReceiverError](
            js::Engine& engineRef, void* receiverPrivate,
            const std::vector<js::JSValueHandle>& args) {
            const auto encoder = static_cast<WGPUCommandEncoder>(receiverPrivate);
            if (!encoder) {
                engineRef.throwException(missingReceiverError);
                return engineRef.newUndefined();
            }
            return method(state, encoder, args);
        });
}

/**
 * Builds the shared GPUCommandEncoder prototype the first time an encoder is created, then
 * returns it through outPrototype for every instance afterwards. Returns false — without side
 * effects on instances — whenever the engine cannot carry receiver-aware methods or the one-time
 * transaction fails; callers fall back to the legacy per-instance install.
 */
static bool ensureCommandEncoderClassTable(
    BindingsState* state, js::JSValueHandle& outPrototype) {
    auto* engine = state->engine;
    if (!engine->supportsNativeMethods()) return false;
    if (state->registries.commandEncoderPrototype.ptr) {
        outPrototype = state->registries.commandEncoderPrototype;
        return true;
    }

    const auto prototype = engine->newObject();
    if (!prototype.ptr || engine->hasException()) return false;

    const auto beginRenderPassFn = makeCommandEncoderMethod(
        state, "beginRenderPass", &handleGpuCommandEncoderBeginRenderPass,
        "beginRenderPass called with no command encoder receiver");
    const auto finishFn = makeCommandEncoderMethod(
        state, "finish", &handleGpuCommandEncoderFinish,
        "finish called with no command encoder receiver");
    if (!beginRenderPassFn.ptr || !finishFn.ptr || engine->hasException()) {
        if (engine->hasException()) engine->getException();  // consume; caller falls back
        return false;
    }

    // One transactional install for the whole class: the snapshot/verify/rollback guarantees
    // run once here instead of per instance, which is the point of the change.
    if (!installBindingTable(engine, state, bindingTable({
        {"GPUCommandEncoder", "beginRenderPass", 0, nullptr,
         &tnWebgpuClassRowPlaceholder, prototype, &beginRenderPassFn},
        {"GPUCommandEncoder", "beginComputePass", 0, nullptr,
         &handleGpuCommandEncoderBeginComputePass, prototype},
        {"GPUCommandEncoder", "copyBufferToBuffer", 0, nullptr,
         &handleGpuCommandEncoderCopyBufferToBuffer, prototype},
        {"GPUCommandEncoder", "resolveQuerySet", 0, nullptr,
         &tnWebgpuHandlerResolveQuerySet, prototype},
        {"GPUCommandEncoder", "copyBufferToTexture", 0, nullptr,
         &handleGpuCommandEncoderCopyBufferToTexture, prototype},
        {"GPUCommandEncoder", "copyTextureToBuffer", 0, nullptr,
         &handleGpuCommandEncoderCopyTextureToBuffer, prototype},
        {"GPUCommandEncoder", "copyTextureToTexture", 0, nullptr,
         &handleGpuCommandEncoderCopyTextureToTexture, prototype},
        {"GPUCommandEncoder", "clearBuffer", 0, nullptr,
         &handleGpuCommandEncoderClearBuffer, prototype},
        {"GPUCommandEncoder", "finish", 0, nullptr,
         &tnWebgpuClassRowPlaceholder, prototype, &finishFn},
    }))) {
        return false;
    }

    // The prototype carries frozen methods holding no native handles, so it lives as long as
    // the binding state does.
    engine->freezeHandle(prototype);
    state->registries.commandEncoderPrototype = prototype;
    outPrototype = prototype;
    return true;
}

/**
 * Creates one receiver-aware GPURenderPassEncoder method that resolves the pass from the
 * receiving wrapper's private data. Same shape as makeCommandEncoderMethod; handlers 39–51 only
 * ever needed the pass, so a plain receiver resolve replaces the per-instance capture.
 */
static js::JSValueHandle makeRenderPassMethod(
    BindingsState* state,
    const char* name,
    js::JSValueHandle (*method)(
        BindingsState*, WGPURenderPassEncoder, const std::vector<js::JSValueHandle>&),
    const char* missingReceiverError) {
    auto* engine = state->engine;
    return engine->newMethod(
        name,
        [state, method, missingReceiverError](
            js::Engine& engineRef, void* receiverPrivate,
            const std::vector<js::JSValueHandle>& args) {
            const auto pass = static_cast<WGPURenderPassEncoder>(receiverPrivate);
            if (!pass) {
                engineRef.throwException(missingReceiverError);
                return engineRef.newUndefined();
            }
            return method(state, pass, args);
        });
}

/**
 * The paired-state ruling for `end` (PRD-224 phase 2): the command encoder is NOT captured.
 * It resolves from the receiver through `encoderRenderPassMap` — the one map beginRenderPass
 * already maintains — so a shared prototype can serve every (encoder, pass) pairing. Lifetime
 * is re-derived at the call, never assumed: a pass whose map entry is gone (already ended, or
 * its encoder rolled back) takes the same silent no-op the captured handler's mismatch branch
 * has always taken.
 */
static WGPUCommandEncoder encoderForLiveRenderPass(
    BindingsState* state, WGPURenderPassEncoder pass) {
    for (const auto& entry : state->registries.encoderRenderPassMap) {
        if (entry.second == pass) return entry.first;
    }
    return nullptr;
}

static js::JSValueHandle makeRenderPassEndMethod(BindingsState* state) {
    auto* engine = state->engine;
    return engine->newMethod(
        "end",
        [state](
            js::Engine& engineRef, void* receiverPrivate,
            const std::vector<js::JSValueHandle>&) {
            const auto pass = static_cast<WGPURenderPassEncoder>(receiverPrivate);
            if (!pass) {
                engineRef.throwException("end called with no render pass receiver");
                return engineRef.newUndefined();
            }
            const auto encoder = encoderForLiveRenderPass(state, pass);
            if (encoder) {
                wgpuRenderPassEncoderEnd(pass);
                wgpuRenderPassEncoderRelease(pass);
                state->registries.encoderRenderPassMap.erase(encoder);
                if (state->registries.jsRenderPass == pass)
                    state->registries.jsRenderPass = nullptr;
                if (state->presentation.surfaceRenderEncoder == encoder) {
                    state->presentation.surfaceRenderPassEnded = true;
                }
            }
            return engineRef.newUndefined();
        });
}


/**
 * Builds the shared GPURenderPassEncoder prototype the first time a pass is created, then
 * returns it through outPrototype for every instance afterwards. Same contract as
 * ensureCommandEncoderClassTable: false — with no side effects on instances — whenever the
 * engine cannot carry receiver-aware methods or the one-time transaction fails, and the caller
 * falls back to the legacy per-instance install.
 */
static bool ensureRenderPassEncoderClassTable(
    BindingsState* state, js::JSValueHandle& outPrototype) {
    auto* engine = state->engine;
    if (!engine->supportsNativeMethods()) return false;
    if (state->registries.renderPassPrototype.ptr) {
        outPrototype = state->registries.renderPassPrototype;
        return true;
    }

    const auto prototype = engine->newObject();
    if (!prototype.ptr || engine->hasException()) return false;

    const auto endFn = makeRenderPassEndMethod(state);
    const auto setPipelineFn = makeRenderPassMethod(
        state, "setPipeline", &handleGpuRenderPassEncoderSetPipeline,
        "setPipeline called with no render pass receiver");
    const auto setBindGroupFn = makeRenderPassMethod(
        state, "setBindGroup", &handleGpuRenderPassEncoderSetBindGroup,
        "setBindGroup called with no render pass receiver");
    const auto drawFn = makeRenderPassMethod(
        state, "draw", &handleGpuRenderPassEncoderDraw, "draw called with no render pass receiver");
    const auto setVertexBufferFn = makeRenderPassMethod(
        state, "setVertexBuffer", &handleGpuRenderPassEncoderSetVertexBuffer,
        "setVertexBuffer called with no render pass receiver");
    const auto setIndexBufferFn = makeRenderPassMethod(
        state, "setIndexBuffer", &handleGpuRenderPassEncoderSetIndexBuffer,
        "setIndexBuffer called with no render pass receiver");
    const auto drawIndexedFn = makeRenderPassMethod(
        state, "drawIndexed", &handleGpuRenderPassEncoderDrawIndexed,
        "drawIndexed called with no render pass receiver");
    const auto drawIndirectFn = makeRenderPassMethod(
        state, "drawIndirect", &handleGpuRenderPassEncoderDrawIndirect,
        "drawIndirect called with no render pass receiver");
    const auto drawIndexedIndirectFn = makeRenderPassMethod(
        state, "drawIndexedIndirect", &handleGpuRenderPassEncoderDrawIndexedIndirect,
        "drawIndexedIndirect called with no render pass receiver");
    const auto setViewportFn = makeRenderPassMethod(
        state, "setViewport", &handleGpuRenderPassEncoderSetViewport,
        "setViewport called with no render pass receiver");
    const auto setScissorRectFn = makeRenderPassMethod(
        state, "setScissorRect", &handleGpuRenderPassEncoderSetScissorRect,
        "setScissorRect called with no render pass receiver");
    const auto setBlendConstantFn = makeRenderPassMethod(
        state, "setBlendConstant", &handleGpuRenderPassEncoderSetBlendConstant,
        "setBlendConstant called with no render pass receiver");
    const auto setStencilReferenceFn = makeRenderPassMethod(
        state, "setStencilReference", &handleGpuRenderPassEncoderSetStencilReference,
        "setStencilReference called with no render pass receiver");
    const auto executeBundlesFn = makeRenderPassMethod(
        state, "executeBundles", &handleGpuRenderPassEncoderExecuteBundles,
        "executeBundles called with no render pass receiver");
    const bool methodsReady =
        endFn.ptr && setPipelineFn.ptr && setBindGroupFn.ptr && drawFn.ptr
        && setVertexBufferFn.ptr && setIndexBufferFn.ptr && drawIndexedFn.ptr
        && drawIndirectFn.ptr && drawIndexedIndirectFn.ptr && setViewportFn.ptr
        && setScissorRectFn.ptr && setBlendConstantFn.ptr && setStencilReferenceFn.ptr
        && executeBundlesFn.ptr
        && !engine->hasException();
    if (!methodsReady) {
        if (engine->hasException()) engine->getException();  // consume; caller falls back
        return false;
    }

    // One transactional install for the whole class: the snapshot/verify/rollback guarantees
    // run once here instead of fourteen-plus times per pass, which is the point of the change.
    if (!installBindingTable(engine, state, bindingTable({
        {"GPURenderPassEncoder", "setPipeline", 0, nullptr,
         &tnWebgpuClassRowPlaceholder, prototype, &setPipelineFn},
        {"GPURenderPassEncoder", "setBindGroup", 0, nullptr,
         &tnWebgpuClassRowPlaceholder, prototype, &setBindGroupFn},
        {"GPURenderPassEncoder", "draw", 0, nullptr,
         &tnWebgpuClassRowPlaceholder, prototype, &drawFn},
        {"GPURenderPassEncoder", "setVertexBuffer", 0, nullptr,
         &tnWebgpuClassRowPlaceholder, prototype, &setVertexBufferFn},
        {"GPURenderPassEncoder", "setIndexBuffer", 0, nullptr,
         &tnWebgpuClassRowPlaceholder, prototype, &setIndexBufferFn},
        {"GPURenderPassEncoder", "drawIndexed", 0, nullptr,
         &tnWebgpuClassRowPlaceholder, prototype, &drawIndexedFn},
        {"GPURenderPassEncoder", "drawIndirect", 0, nullptr,
         &tnWebgpuClassRowPlaceholder, prototype, &drawIndirectFn},
        {"GPURenderPassEncoder", "drawIndexedIndirect", 0, nullptr,
         &tnWebgpuClassRowPlaceholder, prototype, &drawIndexedIndirectFn},
        {"GPURenderPassEncoder", "setViewport", 0, nullptr,
         &tnWebgpuClassRowPlaceholder, prototype, &setViewportFn},
        {"GPURenderPassEncoder", "setScissorRect", 0, nullptr,
         &tnWebgpuClassRowPlaceholder, prototype, &setScissorRectFn},
        {"GPURenderPassEncoder", "setBlendConstant", 0, nullptr,
         &tnWebgpuClassRowPlaceholder, prototype, &setBlendConstantFn},
        {"GPURenderPassEncoder", "setStencilReference", 0, nullptr,
         &tnWebgpuClassRowPlaceholder, prototype, &setStencilReferenceFn},
        {"GPURenderPassEncoder", "executeBundles", 0, nullptr,
         &tnWebgpuClassRowPlaceholder, prototype, &executeBundlesFn},
        {"GPURenderPassEncoder", "end", 0, nullptr,
         &tnWebgpuClassRowPlaceholder, prototype, &endFn},
    }))) {
        return false;
    }

    engine->freezeHandle(prototype);
    state->registries.renderPassPrototype = prototype;
    outPrototype = prototype;
    return true;
}

static void rollbackCommandEncoder(
    BindingsState* state,
    WGPUCommandEncoder encoder,
    WGPUCommandEncoder previousJsCommandEncoder) {
    if (!state || !encoder) return;
    auto renderIt = state->registries.encoderRenderPassMap.find(encoder);
    if (renderIt != state->registries.encoderRenderPassMap.end()) {
        if (renderIt->second) {
            wgpuRenderPassEncoderEnd(renderIt->second);
            wgpuRenderPassEncoderRelease(renderIt->second);
        }
        if (state->registries.jsRenderPass == renderIt->second)
            state->registries.jsRenderPass = nullptr;
        state->registries.encoderRenderPassMap.erase(renderIt);
    }
    auto computeIt = state->registries.encoderComputePassMap.find(encoder);
    if (computeIt != state->registries.encoderComputePassMap.end()) {
        if (computeIt->second) {
            wgpuComputePassEncoderEnd(computeIt->second);
            wgpuComputePassEncoderRelease(computeIt->second);
        }
        if (state->registries.jsComputePass == computeIt->second)
            state->registries.jsComputePass = nullptr;
        state->registries.encoderComputePassMap.erase(computeIt);
    }
    if (state->presentation.surfaceRenderEncoder == encoder) {
        state->presentation.surfaceRenderEncoder = nullptr;
        state->presentation.surfaceRenderPassEnded = true;
    }
    state->registries.commandEncoderRegistry.erase(encoder);
    state->registries.jsCommandEncoder = previousJsCommandEncoder;
    wgpuCommandEncoderRelease(encoder);
}

js::JSValueHandle handleGpuDeviceCreateCommandEncoder(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args) {
                            WGPUCommandEncoderDescriptor desc = {};
                            WGPUCommandEncoder encoder = wgpuDeviceCreateCommandEncoder(state->device, &desc);
                            if (!requireHandle(state->engine, encoder, "device.createCommandEncoder"))
                                return state->engine->newUndefined();
                            // Store in global for use by beginRenderPass
                            // Note: Multiple encoders are supported via per-encoder render pass tracking
                            const WGPUCommandEncoder previousJsCommandEncoder = state->registries.jsCommandEncoder;
                            state->registries.jsCommandEncoder = encoder;
                            state->registries.commandEncoderRegistry.insert(encoder);
                            // Suspend frame tracking while creating encoder wrapper
                            // This prevents the wrapper's methods from being garbage collected at frame end
                            state->engine->suspendFrameTracking();
                            auto jsEncoder = createNativeWrapper(
                                state, "GPUCommandEncoder", encoder);

                            // Fast path: point this instance at the class's one-time prototype
                            // instead of reinstalling eight methods transactionally per call.
                            js::JSValueHandle commandEncoderPrototype{};
                            const bool wrapperReady = !state->engine->hasException();
                            const bool classReady = wrapperReady &&
                                ensureCommandEncoderClassTable(state, commandEncoderPrototype);
                            const bool prototypeReady = classReady &&
                                state->engine->setPrototypeOf(jsEncoder, commandEncoderPrototype);
                            if (prototypeReady) {
                                state->engine->resumeFrameTracking();
                                return jsEncoder;
                            }
                            // Legacy per-call install: retained unchanged so the fast path can
                            // be reverted in one commit.
                            // Capture encoder pointer for use in closures
                            WGPUCommandEncoder capturedEncoder = encoder;
                            // encoder.beginRenderPass(descriptor)
                            if (!installBindingTable(state->engine, state, bindingTable({
                                {"GPUCommandEncoder", "beginRenderPass", 0, nullptr,
                                makeCapturedHandler(capturedEncoder, &handleGpuCommandEncoderBeginRenderPass)
                            , jsEncoder}}))) {
                                rollbackCommandEncoder(state, encoder, previousJsCommandEncoder);
                                state->engine->resumeFrameTracking();
                                return state->engine->newUndefined();
                            }
                            // encoder.beginComputePass(descriptor?)
                            if (!installBindingTable(state->engine, state, bindingTable({
                                {"GPUCommandEncoder", "beginComputePass", 0, nullptr,
                                &handleGpuCommandEncoderBeginComputePass
                            , jsEncoder}}))) {
                                rollbackCommandEncoder(state, encoder, previousJsCommandEncoder);
                                state->engine->resumeFrameTracking();
                                return state->engine->newUndefined();
                            }
                            // encoder.copyBufferToBuffer(source, sourceOffset, destination, destinationOffset, size)
                            if (!installBindingTable(state->engine, state, bindingTable({
                                {"GPUCommandEncoder", "copyBufferToBuffer", 0, nullptr,
                                &handleGpuCommandEncoderCopyBufferToBuffer
                            , jsEncoder},
                            // encoder.resolveQuerySet(querySet, firstQuery, queryCount, destination, destinationOffset)
                                {"GPUCommandEncoder", "resolveQuerySet", 0, nullptr,
                                &tnWebgpuHandlerResolveQuerySet
                            , jsEncoder},
                            // encoder.copyBufferToTexture(source, destination, copySize)
                                                            {"GPUCommandEncoder", "copyBufferToTexture", 0, nullptr,
                                &handleGpuCommandEncoderCopyBufferToTexture
                            , jsEncoder},
                            // encoder.copyTextureToBuffer(source, destination, copySize)
                                                            {"GPUCommandEncoder", "copyTextureToBuffer", 0, nullptr,
                                &handleGpuCommandEncoderCopyTextureToBuffer
                            , jsEncoder},
                            // encoder.copyTextureToTexture(source, destination, copySize)
                                                            {"GPUCommandEncoder", "copyTextureToTexture", 0, nullptr,
                                &handleGpuCommandEncoderCopyTextureToTexture
                            , jsEncoder},
                            // encoder.clearBuffer(buffer, offset?, size?)
                                                            {"GPUCommandEncoder", "clearBuffer", 0, nullptr,
                                &handleGpuCommandEncoderClearBuffer
                            , jsEncoder},
                            // encoder.finish(descriptor?)
                                {"GPUCommandEncoder", "finish", 0, nullptr,
                                makeCapturedHandler(capturedEncoder, &handleGpuCommandEncoderFinish)
                            , jsEncoder}}))) {
                                rollbackCommandEncoder(state, encoder, previousJsCommandEncoder);
                                state->engine->resumeFrameTracking();
                                return state->engine->newUndefined();
                            }
                            // Resume frame tracking now that encoder wrapper is created
                            state->engine->resumeFrameTracking();
                            return jsEncoder;
}


#endif
}  // namespace webgpu
}  // namespace mystral
