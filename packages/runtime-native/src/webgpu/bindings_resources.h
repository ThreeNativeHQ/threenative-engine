#pragma once

#include "bindings_state.h"
#include "mystral/webgpu/registration_table.h"

namespace mystral::webgpu {

#if defined(MYSTRAL_WEBGPU_WGPU) || defined(MYSTRAL_WEBGPU_DAWN)

void startDeferredBufferMaps(BindingsState* state);

const char* formatToString(WGPUTextureFormat format);
WGPUTextureFormat stringToFormat(const std::string& format);
WGPUTextureViewDimension stringToTextureViewDimension(const std::string& dim);
WGPUCompareFunction stringToCompareFunction(const std::string& func);

js::JSValueHandle handleGpuDeviceCreateTextureView(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args);
js::JSValueHandle handleGpuDeviceCreateSampler(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args);
js::JSValueHandle handleGpuDeviceCreateTexture(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args);
js::JSValueHandle handleGpuDeviceCreateBuffer(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args);

#endif

}  // namespace mystral::webgpu
