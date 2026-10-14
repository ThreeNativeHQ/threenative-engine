#include "compute.h"
#include "engine/renderer/pipeline_cache.h"

#include <algorithm>
#include <cmath>
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

namespace {
shader::Program jointProgram() {
    using namespace shader;
    Program p(Stage::Compute);
    const auto topology = p.storageBuffer("jointTopology", Type::u32());
    const auto locals = p.storageBuffer("jointLocals", Type::vec(4));
    const auto fixed = p.storageBuffer("jointFixed", Type::mat(4, 4));
    const auto output = p.storageBuffer("boneMatrices", Type::mat(4, 4));
    auto u = [&](int32_t n) { return p.construct(Type::u32(), {p.constant(n)}); };
    auto f = [&](float n) { return p.constant(n); };
    auto vec = [&](ExprId x, ExprId y, ExprId z, ExprId w) { return p.construct(Type::vec(4), {x, y, z, w}); };
    const auto id = p.swizzle(p.builtin("globalInvocationId"), "x");
    p.If(p.less(id, p.loadStorage(topology, u(0))), [&] {
        const auto base = p.add(u(1), p.mul(id, u(5)));
        auto field = [&](int n) { return p.loadStorage(topology, p.add(base, u(n))); };
        const auto count = field(0), parents = field(1), inputs = field(2), matrices = field(3), outputs = field(4);
        p.Loop(p.construct(Type::i32(), {count}), [&](ExprId index) {
            const auto j = p.construct(Type::u32(), {index});
            const auto input = p.mul(p.add(inputs, j), u(3));
            const auto position = p.loadStorage(locals, input);
            const auto q = p.loadStorage(locals, p.add(input, u(1)));
            const auto scale = p.loadStorage(locals, p.add(input, u(2)));
            const auto x = p.swizzle(q, "x"), y = p.swizzle(q, "y"), z = p.swizzle(q, "z"), w = p.swizzle(q, "w");
            auto twice = [&](ExprId a, ExprId b) { return p.mul(f(2), p.mul(a, b)); };
            const auto xx = twice(x, x), yy = twice(y, y), zz = twice(z, z);
            const auto xy = twice(x, y), xz = twice(x, z), yz = twice(y, z);
            const auto wx = twice(w, x), wy = twice(w, y), wz = twice(w, z);
            auto column = [&](ExprId a, ExprId b, ExprId c, const char* lane) {
                return p.mul(vec(a, b, c, f(0)), p.swizzle(scale, lane));
            };
            const auto local = p.construct(Type::mat(4, 4), {
                column(p.sub(f(1), p.add(yy, zz)), p.add(xy, wz), p.sub(xz, wy), "x"),
                column(p.sub(xy, wz), p.sub(f(1), p.add(xx, zz)), p.add(yz, wx), "y"),
                column(p.add(xz, wy), p.sub(yz, wx), p.sub(f(1), p.add(xx, yy)), "z"),
                vec(p.swizzle(position, "x"), p.swizzle(position, "y"), p.swizzle(position, "z"), f(1))});
            const auto world = p.var(Type::mat(4, 4), p.mul(p.loadStorage(fixed, p.mul(p.add(matrices, j), u(2))), local));
            const auto parent = p.loadStorage(topology, p.add(parents, j));
            p.If(p.less(parent, count), [&] {
                p.assign(world, p.mul(p.loadStorage(output, p.add(outputs, parent)), p.load(world)));
            });
            p.store(output, p.add(outputs, j), p.load(world));
        });
        // All relatives are consumed before any palette matrix replaces them.
        p.Loop(p.construct(Type::i32(), {count}), [&](ExprId index) {
            const auto j = p.construct(Type::u32(), {index});
            const auto at = p.add(outputs, j);
            p.store(output, at, p.mul(p.loadStorage(output, at),
                p.loadStorage(fixed, p.add(p.mul(p.add(matrices, j), u(2)), u(1)))));
        });
    });
    return p;
}
}  // namespace

JointComputePass::JointComputePass(WGPUDevice device, GpuResources& gpu,
    std::span<const JointComputeRig> rigs, std::span<const uint32_t> parents,
    std::span<const std::array<float, 16>> fixed, Handle locals, Handle output) : gpu_(gpu) {
    auto refuse = [&](const char* why) { error_ = std::string("TN_JOINT_COMPUTE: ") + why; };
    WGPULimits limits = {};
#if defined(MYSTRAL_WEBGPU_DAWN) || defined(MYSTRAL_WEBGPU_WGPU_MODERN)
    if (wgpuDeviceGetLimits(device, &limits) != WGPUStatus_Success) { refuse("device limits unavailable"); return; }
#else
    WGPUSupportedLimits supported = {};
    if (!wgpuDeviceGetLimits(device, &supported)) { refuse("device limits unavailable"); return; }
    limits = supported.limits;
#endif
    if (rigs.empty() || rigs.size() > uint64_t(limits.maxComputeWorkgroupsPerDimension) * 64 ||
        parents.size() > UINT32_MAX || 1 + uint64_t(rigs.size()) * 5 + parents.size() > UINT32_MAX ||
        limits.maxStorageBuffersPerShaderStage < 4 || limits.maxBindingsPerBindGroup < 4 ||
        limits.maxBindGroups < 1 || limits.maxComputeInvocationsPerWorkgroup < 64 ||
        limits.maxComputeWorkgroupSizeX < 64) { refuse("rig count or compute limits"); return; }
    const auto inputBuffer = gpu.buffer(locals), outputBuffer = gpu.buffer(output);
    if (!inputBuffer || !outputBuffer || inputBuffer == outputBuffer) { refuse("invalid or aliased buffers"); return; }
    const auto inputBytes = wgpuBufferGetSize(inputBuffer), outputBytes = wgpuBufferGetSize(outputBuffer);
    const uint64_t topologyBytes = (1 + rigs.size() * 5 + parents.size()) * 4;
    const uint64_t fixedBytes = fixed.size_bytes();
    for (uint64_t bytes : {topologyBytes, fixedBytes, inputBytes, outputBytes}) {
        if (!bytes || bytes > limits.maxStorageBufferBindingSize || bytes > limits.maxBufferSize) {
            refuse("storage binding size"); return;
        }
    }
    if (!(wgpuBufferGetUsage(inputBuffer) & WGPUBufferUsage_Storage) ||
        !(wgpuBufferGetUsage(outputBuffer) & WGPUBufferUsage_Storage) || inputBytes % 48 || outputBytes % 64) {
        refuse("storage usage or element alignment"); return;
    }
    std::vector<std::pair<uint64_t, uint64_t>> ranges;
    for (const auto& rig : rigs) {
        if (!rig.count || rig.count > INT32_MAX || uint64_t(rig.parentBase) + rig.count > parents.size() ||
            uint64_t(rig.inputBase) + rig.count > inputBytes / 48 ||
            (uint64_t(rig.fixedBase) + rig.count) * 2 > fixed.size() ||
            uint64_t(rig.outputBase) + rig.count > outputBytes / 64) { refuse("joint range"); return; }
        for (uint32_t j = 0; j < rig.count; ++j) {
            const auto parent = parents[rig.parentBase + j];
            if (parent != UINT32_MAX && parent >= j) { refuse("parent must precede child"); return; }
        }
        ranges.emplace_back(rig.outputBase, uint64_t(rig.outputBase) + rig.count);
    }
    std::sort(ranges.begin(), ranges.end());
    for (size_t i = 1; i < ranges.size(); ++i) {
        if (ranges[i].first < ranges[i - 1].second) { refuse("overlapping output ranges"); return; }
    }
    for (const auto& matrix : fixed) for (float value : matrix) {
        if (!std::isfinite(value)) { refuse("nonfinite fixed matrix"); return; }
    }
    std::vector<uint32_t> topology{uint32_t(rigs.size())};
    for (const auto& rig : rigs) {
        topology.insert(topology.end(), {rig.count, uint32_t(1 + rigs.size() * 5 + rig.parentBase),
            rig.inputBase, rig.fixedBase, rig.outputBase});
    }
    topology.insert(topology.end(), parents.begin(), parents.end());
    storage_[0] = gpu.createBuffer(topologyBytes, WGPUBufferUsage_Storage, topology.data(), topologyBytes);
    storage_[1] = locals;
    storage_[2] = gpu.createBuffer(fixedBytes, WGPUBufferUsage_Storage, fixed.data(), fixedBytes);
    storage_[3] = output;
    count_ = uint32_t(rigs.size());
    pass_ = std::make_unique<ComputePass>(device, gpu, jointProgram());
    error_ = pass_->error();
}

JointComputePass::~JointComputePass() {
    if (pass_) { gpu_.destroy(storage_[0]); gpu_.destroy(storage_[2]); }
}

bool JointComputePass::dispatch(WGPUCommandEncoder encoder) {
    if (!error_.empty() || !pass_) return false;
    const bool ok = pass_->dispatch(encoder, storage_, count_);
    if (!ok) error_ = pass_->error();
    return ok;
}

}  // namespace tn::engine
