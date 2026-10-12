#include "compute.h"
#include "engine/renderer/pipeline_cache.h"

#include <cstring>

#include "mystral/webgpu_compat.h"

namespace tn::engine {

ComputePass::ComputePass(WGPUDevice device, GpuResources& gpu, const shader::Program& program)
    : device_(device), gpu_(gpu), module_(shader::buildStage(program, 0)) {
    if (!module_.wgsl.ok()) {
        error_ = "TN_COMPUTE_PROGRAM: " + (module_.wgsl.errors.empty() ? std::string("invalid") : module_.wgsl.errors[0]);
        return;
    }
    WGPUShaderModuleWGSLDescriptor_Compat wgsl = {};
    WGPUShaderModuleDescriptor moduleDesc = {};
    setupShaderModuleWGSL(&moduleDesc, &wgsl, module_.wgsl.code.c_str());
    WGPUShaderModule shaderModule = wgpuDeviceCreateShaderModule(device, &moduleDesc);
    WGPUComputePipelineDescriptor desc = {};
    desc.compute.module = shaderModule;
    WGPU_SET_ENTRY_POINT(desc.compute, module_.wgsl.entryPoint.c_str());
    pipeline_ = shaderModule ? wgpuDeviceCreateComputePipeline(device, &desc) : nullptr;
    if (shaderModule) wgpuShaderModuleRelease(shaderModule);
    if (!pipeline_) {
        error_ = "TN_COMPUTE_PIPELINE_REFUSED";
        return;
    }
    if (module_.uniformBlockSize) uniforms_ = gpu_.createBuffer(module_.uniformBlockSize, WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst);
}

ComputePass::~ComputePass() {
    if (pipeline_) wgpuComputePipelineRelease(pipeline_);
    if (module_.uniformBlockSize) gpu_.destroy(uniforms_);
}

bool ComputePass::dispatch(WGPUCommandEncoder encoder, std::span<const Handle> storage, uint32_t invocations,
                           const std::vector<std::pair<std::string, double>>& uniforms) {
    if (!pipeline_) return false;
    if (module_.uniformBlockSize) {
        std::vector<uint8_t> block(module_.uniformBlockSize);
        for (const auto& [name, value] : uniforms) {
            for (const shader::UniformField& f : module_.uniforms) {
                if (f.name != name) continue;
                const float v = static_cast<float>(value);
                std::memcpy(&block[f.offset], &v, 4);
            }
        }
        gpu_.writeBuffer(uniforms_, 0, block.data(), block.size());
    }
    std::vector<WGPUBindGroupEntry> entries;
    size_t next = 0;
    for (const shader::Binding& b : module_.bindings) {
        WGPUBindGroupEntry e = {};
        e.binding = b.binding;
        if (b.kind == shader::BindingKind::Uniform) {
            e.buffer = gpu_.buffer(uniforms_);
            e.size = module_.uniformBlockSize;
        } else if (b.kind == shader::BindingKind::Storage) {
            if (next >= storage.size() || gpu_.buffer(storage[next]) == nullptr) {
                error_ = "TN_COMPUTE_STORAGE: the program declares more storage buffers than were given";
                return false;
            }
            e.buffer = gpu_.buffer(storage[next++]);
            e.size = wgpuBufferGetSize(e.buffer);
        } else {
            error_ = "TN_COMPUTE_BINDING: textures in compute are not supported yet";
            return false;
        }
        entries.push_back(e);
    }
    if (next != storage.size()) {
        error_ = "TN_COMPUTE_STORAGE: more storage buffers were given than the program declares";
        return false;
    }
    WGPUBindGroupLayout layout = wgpuComputePipelineGetBindGroupLayout(pipeline_, 0);
    WGPUBindGroupDescriptor groupDesc = {};
    groupDesc.layout = layout;
    groupDesc.entryCount = entries.size();
    groupDesc.entries = entries.data();
    WGPUBindGroup group = createBindGroup(device_, &groupDesc);
    wgpuBindGroupLayoutRelease(layout);
    WGPUComputePassDescriptor passDesc = {};
    WGPUComputePassEncoder pass = wgpuCommandEncoderBeginComputePass(encoder, &passDesc);
    wgpuComputePassEncoderSetPipeline(pass, pipeline_);
    wgpuComputePassEncoderSetBindGroup(pass, 0, group, 0, nullptr);
    wgpuComputePassEncoderDispatchWorkgroups(pass, (invocations + 63) / 64, 1, 1);
    wgpuComputePassEncoderEnd(pass);
    wgpuComputePassEncoderRelease(pass);
    wgpuBindGroupRelease(group);
    return true;
}

}  // namespace tn::engine
