#include "mystral/webgpu/wrapper_factories.h"

#include <iostream>

#include <webgpu/webgpu.h>

#include "bindings_state.h"
#include "bindings_presentation.h"
#include "mystral/webgpu/bindings.h"
#include "mystral/webgpu/registration_table.h"

namespace mystral::webgpu {

namespace {

js::JSValueHandle createTextureViewBinding(
    BindingsState* state,
    uint64_t textureId,
    const std::vector<js::JSValueHandle>&) {
    const auto it = state->registries.textureRegistry.find(textureId);
    if (it == state->registries.textureRegistry.end()) {
        state->engine->throwException("Texture not found in registry");
        return state->engine->newUndefined();
    }
    if (!it->second.texture) {
        state->engine->throwException("No current texture");
        return state->engine->newUndefined();
    }

    WGPUTextureViewDescriptor viewDesc = {};
    viewDesc.format = it->second.format;
    viewDesc.dimension = WGPUTextureViewDimension_2D;
    viewDesc.baseMipLevel = 0;
    viewDesc.mipLevelCount = 1;
    viewDesc.baseArrayLayer = 0;
    viewDesc.arrayLayerCount = 1;
    viewDesc.aspect = WGPUTextureAspect_All;
    WGPUTextureView view = wgpuTextureCreateView(it->second.texture, &viewDesc);
    auto jsView = createNativeWrapper(state, "GPUTextureView", view);
    const uint64_t viewId = state->registries.nextTextureViewId++;
    state->registries.textureViewRegistry[viewId] = view;
    const bool isSurfaceView = textureId == state->presentation.currentSurfaceTextureId &&
                               it->second.texture == state->presentation.currentTexture;
    if (isSurfaceView) trackCurrentSurfaceTextureView(state, viewId, view);
    state->engine->setProperty(jsView, "_textureViewId", state->engine->newNumber(viewId));
    state->engine->setProperty(jsView, "_type", state->engine->newString("textureView"));
    state->engine->registerRelease(jsView, [state, view, viewId, isSurfaceView]() {
        if (isSurfaceView) untrackCurrentSurfaceTextureView(state, viewId);
        if (state->registries.textureViewRegistry.erase(viewId) != 0)
            wgpuTextureViewRelease(view);
    });
    return jsView;
}

js::JSValueHandle destroyTextureBinding(
    BindingsState* state,
    uint64_t textureId,
    const std::vector<js::JSValueHandle>&) {
    releaseTextureRegistryEntry(state, textureId);
    return state->engine->newUndefined();
}

js::JSValueHandle getPipelineBindGroupLayoutBinding(
    BindingsState* state,
    uint64_t pipelineId,
    bool renderPipeline,
    const std::vector<js::JSValueHandle>& args) {
    WGPUBindGroupLayout layout = nullptr;
    const uint32_t groupIndex = args.empty() ? 0 : static_cast<uint32_t>(state->engine->toNumber(args[0]));
    if (renderPipeline) {
        const auto it = state->registries.renderPipelineRegistry.find(pipelineId);
        if (it == state->registries.renderPipelineRegistry.end() || !it->second) {
            std::cerr << "[WebGPU] getBindGroupLayout: Render pipeline not found" << std::endl;
            return state->engine->newUndefined();
        }
        layout = wgpuRenderPipelineGetBindGroupLayout(it->second, groupIndex);
    } else {
        const auto it = state->registries.computePipelineRegistry.find(pipelineId);
        if (it == state->registries.computePipelineRegistry.end() || !it->second) {
            std::cerr << "[WebGPU] getBindGroupLayout: Compute pipeline not found" << std::endl;
            return state->engine->newUndefined();
        }
        layout = wgpuComputePipelineGetBindGroupLayout(it->second, groupIndex);
    }

    if (!layout) {
        std::cerr << "[WebGPU] getBindGroupLayout: Failed to get layout" << std::endl;
        return state->engine->newUndefined();
    }

    auto jsLayout = createNativeWrapper(state, "GPUBindGroupLayout", layout);
    state->engine->setProperty(jsLayout, "_type", state->engine->newString("bindGroupLayout"));
    auto ownedResources = state->registries.ownedResources;
    const uint64_t layoutId = ownedResources->trackBindGroupLayout(layout);
    state->engine->registerRelease(jsLayout, [ownedResources, layoutId]() {
        ownedResources->releaseBindGroupLayout(layoutId);
    });
    return jsLayout;
}

BindingHandler makeTextureViewBinding(BindingsState* state, uint64_t textureId) {
    return [state, textureId](BindingsState*, BindingDestination,
                              const std::vector<js::JSValueHandle>& args) {
        return createTextureViewBinding(state, textureId, args);
    };
}

BindingHandler makeDestroyTextureBinding(BindingsState* state, uint64_t textureId) {
    return [state, textureId](BindingsState*, BindingDestination,
                              const std::vector<js::JSValueHandle>& args) {
        return destroyTextureBinding(state, textureId, args);
    };
}

BindingHandler makePipelineBindGroupLayoutBinding(
    BindingsState* state, uint64_t pipelineId, bool renderPipeline) {
    return [state, pipelineId, renderPipeline](
               BindingsState*, BindingDestination,
               const std::vector<js::JSValueHandle>& args) {
        return getPipelineBindGroupLayoutBinding(state, pipelineId, renderPipeline, args);
    };
}

}  // namespace

js::JSValueHandle createNativeWrapper(
    BindingsState* state,
    const char* className,
    void* nativeData) {
    if (state->engine->supportsNativeObjectTemplates()) {
        return state->engine->newNativeObject(className, nativeData);
    }
    auto wrapper = state->engine->newObject();
    state->engine->setPrivateData(wrapper, nativeData);
    return wrapper;
}

js::JSValueHandle createTextureWrapper(
    BindingsState* state,
    void* textureHandle,
    uint64_t textureId,
    uint32_t width,
    uint32_t height,
    const char* format,
    bool rollbackRegistryEntry) {
    const WGPUTexture texture = static_cast<WGPUTexture>(textureHandle);
    auto jsTexture = createNativeWrapper(state, "GPUTexture", texture);
    state->engine->setProperty(jsTexture, "_textureId", state->engine->newNumber(textureId));
    state->engine->setProperty(jsTexture, "width", state->engine->newNumber(width));
    state->engine->setProperty(jsTexture, "height", state->engine->newNumber(height));
    state->engine->setProperty(jsTexture, "depthOrArrayLayers", state->engine->newNumber(1));
    state->engine->setProperty(jsTexture, "format", state->engine->newString(format));

    if (!installBindingTable(state->engine, state, bindingTable({
        {"GPUTexture", "createView", 0, nullptr,
         makeTextureViewBinding(state, textureId), jsTexture},
        {"GPUTexture", "destroy", 0, nullptr,
         makeDestroyTextureBinding(state, textureId), jsTexture},
    }))) {
        if (rollbackRegistryEntry) releaseTextureRegistryEntry(state, textureId);
        return state->engine->newUndefined();
    }
    return jsTexture;
}

js::JSValueHandle createPipelineWrapper(
    BindingsState* state,
    void* pipelineHandle,
    uint64_t pipelineId,
    bool renderPipeline) {
    auto jsPipeline = createNativeWrapper(
        state,
        renderPipeline ? "GPURenderPipeline" : "GPUComputePipeline",
        pipelineHandle);
    state->engine->setProperty(jsPipeline, "_pipelineId", state->engine->newNumber((double)pipelineId));
    state->engine->setProperty(
        jsPipeline,
        "_type",
        state->engine->newString(renderPipeline ? "renderPipeline" : "computePipeline"));
    const char* pipelineSurface = renderPipeline ? "GPURenderPipeline" : "GPUComputePipeline";
    if (!installBindingTable(state->engine, state, bindingTable({
        {pipelineSurface, "getBindGroupLayout", 0, nullptr,
         makePipelineBindGroupLayoutBinding(state, pipelineId, renderPipeline), jsPipeline},
    }))) {
        if (renderPipeline) {
            releaseRenderPipelineRegistryEntry(state, pipelineId);
        } else {
            releaseComputePipelineRegistryEntry(state, pipelineId);
        }
        return state->engine->newUndefined();
    }
    return jsPipeline;
}

}  // namespace mystral::webgpu
