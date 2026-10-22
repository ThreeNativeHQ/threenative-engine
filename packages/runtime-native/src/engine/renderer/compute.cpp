#include "engine/renderer/frame_gpu_timer.h"
#include "compute.h"
#include "engine/renderer/pipeline_cache.h"

#include <algorithm>
#include <bit>
#include <cmath>
#include <cstring>
#include <functional>
#include <stdexcept>
#include <unordered_set>

#include "engine/renderer/renderer.h"
#include "engine/scene/texture.h"
#include "engine/shader/tsl/tsl.h"

#include "mystral/webgpu_compat.h"

namespace tn::engine {

ComputePass::ComputePass(WGPUDevice device, GpuResources& gpu, const shader::Program& program)
    : device_(device), gpu_(gpu), module_(shader::buildStage(program, 0)), workgroup_(program.workgroupSize()) {
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
    std::vector<uint8_t> block(module_.uniformBlockSize);
    for (const auto& [name, value] : uniforms) {
        for (const shader::UniformField& f : module_.uniforms) {
            if (f.name != name) continue;
            const float v = static_cast<float>(value);
            std::memcpy(&block[f.offset], &v, 4);
        }
    }
    return encode(encoder, storage, invocations, block);
}

void ComputePass::dispatchValues(WGPUCommandEncoder encoder, std::span<const Handle> storage, uint32_t invocations,
                                 const std::map<std::string, std::vector<double>>& uniforms, const FrameClock& clock, std::span<const WGPUBindGroupEntry> textures) {
    std::vector<uint8_t> block(module_.uniformBlockSize);
    for (const shader::UniformField& f : module_.uniforms) {
        // The engine's own frame clock, as the render passes get it.
        if ((f.name == "time" || f.name == "deltaTime") && f.type == shader::Type::f32()) {
            const uint32_t word = std::bit_cast<uint32_t>(f.name == "time" ? clock.time : clock.delta);
            std::memcpy(&block[f.offset], &word, 4);
            continue;
        }
        const auto found = uniforms.find(f.name);
        if (found == uniforms.end())
            throw std::runtime_error("TN_COMPUTE_UNIFORM: " + f.name + " is the engine's own value and has no meaning in a compute kernel");
        const std::vector<double>& lanes = found->second;
        if (f.type.isMatrix() || lanes.size() != f.type.rows)
            throw std::runtime_error("TN_COMPUTE_UNIFORM: " + f.name + " is " + f.type.name() + " and the node holds " +
                                     std::to_string(lanes.size()) + " value(s)");
        shader::writeUniform(block, f, lanes);
    }
    if (!pipeline_ || !encode(encoder, storage, invocations, block, textures))
        throw std::runtime_error(error_.empty() ? std::string("TN_COMPUTE_PIPELINE_REFUSED") : error_);
}

bool ComputePass::encode(WGPUCommandEncoder encoder, std::span<const Handle> storage, uint32_t invocations,
                         const std::vector<uint8_t>& uniformBlock, std::span<const WGPUBindGroupEntry> textures) {
    if (module_.uniformBlockSize) gpu_.writeBuffer(uniforms_, 0, uniformBlock.data(), uniformBlock.size());
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
            const auto found = std::find_if(textures.begin(), textures.end(), [&](const auto& entry) { return entry.binding == b.binding; });
            if (found == textures.end()) {
                error_ = "TN_COMPUTE_BINDING: missing texture binding " + b.name;
                return false;
            }
            e = *found;
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
    WGPUComputePassEncoder pass = beginTimedComputePass(encoder, &passDesc);
    wgpuComputePassEncoderSetPipeline(pass, pipeline_);
    wgpuComputePassEncoderSetBindGroup(pass, 0, group, 0, nullptr);
    // One row of at most 65535 workgroups; a longer dispatch stacks rows, which instanceIndex folds back.
    const uint64_t groups = (static_cast<uint64_t>(invocations) + workgroup_ - 1) / workgroup_;
    const uint32_t across = static_cast<uint32_t>(std::min<uint64_t>(groups, 65535));
    wgpuComputePassEncoderDispatchWorkgroups(pass, across, across == 0 ? 1 : static_cast<uint32_t>((groups + across - 1) / across), 1);
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
    storage_[0] = gpu.createBuffer(topologyBytes, WGPUBufferUsage_Storage | WGPUBufferUsage_CopyDst, topology.data(), topologyBytes);
    storage_[1] = locals;
    storage_[2] = gpu.createBuffer(fixedBytes, WGPUBufferUsage_Storage, fixed.data(), fixedBytes);
    storage_[3] = output;
    count_ = uint32_t(rigs.size());
    outputMatrices_ = outputBytes / 64;
    headers_.assign(topology.begin(), topology.begin() + 1 + rigs.size() * 5);
    pass_ = std::make_unique<ComputePass>(device, gpu, jointProgram());
    error_ = pass_->error();
}

JointComputePass::~JointComputePass() {
    if (pass_) { gpu_.destroy(storage_[0]); gpu_.destroy(storage_[2]); }
}

bool JointComputePass::remapOutputs(std::span<const uint32_t> bases) {
    if (!error_.empty() || !pass_ || bases.size() != count_) return false;
    bool changed = false;
    for (uint32_t i = 0; i < count_; ++i) changed |= bases[i] != headers_[5 + i * 5];
    if (!changed) return true;
    std::vector<std::pair<uint64_t, uint64_t>> ranges;
    ranges.reserve(count_);
    for (uint32_t i = 0; i < count_; ++i) {
        const uint64_t end = uint64_t(bases[i]) + headers_[1 + i * 5];
        if (end > outputMatrices_) return false;
        ranges.emplace_back(bases[i], end);
    }
    std::sort(ranges.begin(), ranges.end());
    for (uint32_t i = 1; i < count_; ++i) if (ranges[i].first < ranges[i - 1].second) return false;
    auto headers = headers_;
    for (uint32_t i = 0; i < count_; ++i) headers[5 + i * 5] = bases[i];
    if (gpu_.writeBuffer(storage_[0], 0, headers.data(), headers.size() * sizeof(uint32_t)) != GpuStatus::Ok) return false;
    headers_.swap(headers);
    return true;
}

bool JointComputePass::dispatch(WGPUCommandEncoder encoder) {
    if (!error_.empty() || !pass_) return false;
    const bool ok = pass_->dispatch(encoder, storage_, count_);
    if (!ok) error_ = pass_->error();
    return ok;
}

namespace graph = shader::graph;

namespace {
// The BufferAttributes a compute graph's storage(attribute) / instancedArray nodes name, by binding name.
void collectStorages(const graph::Node& node, std::unordered_map<std::string, std::shared_ptr<BufferAttribute>>& out,
                     std::unordered_set<const graph::NodeData*>& seen) {
    if (!node || !seen.insert(node.get()).second) return;
    if (node->kind == graph::Kind::StorageElement && node->object)
        out.emplace(node->name, std::const_pointer_cast<BufferAttribute>(std::static_pointer_cast<const BufferAttribute>(node->object)));
    for (const auto* list : {&node->args, &node->body, &node->otherwise})
        for (const auto& child : *list) collectStorages(child, out, seen);
}

// The lowered program of a compute node, built once per structure and shared by every GraphCompute: a
// node is checked when the game calls renderer.compute, which has no device yet. ponytail: never
// pruned, like graph::keyId's table; one entry per distinct kernel.
const shader::Program& loweredProgram(const graph::Node& node) {
    static std::unordered_map<uint64_t, std::unique_ptr<shader::Program>> programs;
    const uint64_t id = graph::keyId(node);
    if (const auto found = programs.find(id); found != programs.end()) return *found->second;
    const uint32_t count = static_cast<uint32_t>(node->bits), workgroup = node->width;
    const uint64_t groups = (static_cast<uint64_t>(count) + workgroup - 1) / workgroup;
    auto program = std::make_unique<shader::Program>(shader::Stage::Compute);
    program->setWorkgroup(workgroup, groups > 65535 ? 65535 * workgroup : 0);
    {
        shader::tsl::Build build(*program);
        const shader::ExprId index = shader::tsl::instanceIndex().id;
        const shader::ExprId limit = program->construct(shader::Type::u32(), {program->constant(static_cast<int32_t>(count))});
        // A thread past the count writes nothing, so the last workgroup's spare threads never count.
        program->If(program->less(index, limit), [&] { graph::lower(node->args[0], *program); });
    }
    if (!program->ok()) {
        const shader::Diagnostic& d = program->diagnostics().front();
        throw std::runtime_error("TN_COMPUTE_PROGRAM: " + d.code + " " + d.node + ": " + d.reason +
                                 (node->name.empty() ? "" : " (compute node " + node->name + ")"));
    }
    return *programs.emplace(id, std::move(program)).first->second;
}
}  // namespace

ComputeDispatch ComputeDispatch::of(const graph::Node& node) {
    if (!node || node->kind != graph::Kind::Compute)
        throw std::runtime_error("TN_COMPUTE_NODE: renderer.compute takes the node Fn(() => { ... })().compute(count) makes");
    (void)loweredProgram(node);
    return {node, graph::uniforms(node)};
}

ComputePass& GraphCompute::prepare(const graph::Node& node) {
    const uint64_t id = graph::keyId(node);
    if (const auto found = passes_.find(id); found != passes_.end()) return *found->second;
    auto pass = std::make_unique<ComputePass>(device_, gpu_, loweredProgram(node));
    if (!pass->error().empty()) throw std::runtime_error(pass->error());
    return *passes_.emplace(id, std::move(pass)).first->second;
}

void GraphCompute::record(WGPUCommandEncoder encoder, const ComputeDispatch& dispatch, const FrameClock& clock, Renderer& renderer) {
    ComputePass& pass = prepare(dispatch.node);
    std::unordered_map<std::string, std::shared_ptr<BufferAttribute>> attributes;
    std::unordered_set<const graph::NodeData*> seen;
    collectStorages(dispatch.node, attributes, seen);
    std::vector<Handle> storage;
    for (const shader::Binding& b : pass.module().bindings) {
        if (b.kind != shader::BindingKind::Storage) continue;
        const auto found = attributes.find(b.name.substr(2));
        if (found == attributes.end())
            throw std::runtime_error("TN_COMPUTE_STORAGE: the kernel uses storage '" + b.name.substr(2) +
                                     "' that no storage(attribute) or instancedArray owns");
        // Copies in and out: a kernel's result is read back, and the CPU contents seed the buffer.
        storage.push_back(cache_.sync(*found->second->store,
                                      WGPUBufferUsage_Storage | WGPUBufferUsage_CopySrc | WGPUBufferUsage_CopyDst));
    }
    std::unordered_map<std::string, std::shared_ptr<const Texture>> sources;
    seen.clear();
    const auto collect = [&](const auto& self, const graph::Node& node) -> void {
        if (!node || !seen.insert(node.get()).second) return;
        if (node->object && (node->kind == graph::Kind::Texture || node->kind == graph::Kind::StorageTexture || node->kind == graph::Kind::TextureStore))
            sources.emplace(node->name, std::static_pointer_cast<const Texture>(node->object));
        for (const auto* list : {&node->args, &node->body, &node->otherwise})
            for (const auto& child : *list) self(self, child);
    };
    collect(collect, dispatch.node);
    std::vector<WGPUBindGroupEntry> textures;
    for (const auto& b : pass.module().bindings) {
        if (b.kind != shader::BindingKind::Texture && b.kind != shader::BindingKind::Sampler && b.kind != shader::BindingKind::StorageTexture) continue;
        const auto found = sources.find(b.name.substr(b.kind == shader::BindingKind::Sampler ? 4 : b.kind == shader::BindingKind::StorageTexture ? 3 : 2));
        if (found == sources.end()) throw std::runtime_error("TN_COMPUTE_BINDING: no texture owns " + b.name);
        const auto* gpu = renderer.materialTexture(*found->second);
        WGPUBindGroupEntry entry{}; entry.binding = b.binding;
        if (b.kind == shader::BindingKind::Sampler) entry.sampler = gpu->sampler;
        else entry.textureView = gpu->view;
        textures.push_back(entry);
    }
    pass.dispatchValues(encoder, storage, static_cast<uint32_t>(dispatch.node->bits), dispatch.uniforms, clock, textures);
}

void ComputeQueue::bindDisposal(const std::shared_ptr<BufferAttribute>& attribute) {
    if (const auto owner = attribute->gpuReleaseOwner.lock()) {
        if (owner != lifetime_) throw std::runtime_error("TN_COMPUTE_STORAGE_OWNER: attribute belongs to another live compute queue");
        return;
    }
    const std::weak_ptr<void> alive = lifetime_;
    const std::weak_ptr<BufferAttribute> weak = attribute;
    attribute->releaseGpuCopy = [alive, weak, this] {
        if (const auto held = weak.lock()) {
            if (alive.expired()) held->store->releaseGpuCopy();
            else release(held);
        }
    };
    attribute->gpuReleaseOwner = lifetime_;
}

void ComputeQueue::dispatch(const graph::Node& node) {
    auto dispatch = ComputeDispatch::of(node);
    std::unordered_map<std::string, std::shared_ptr<BufferAttribute>> attributes;
    std::unordered_set<const graph::NodeData*> seen;
    collectStorages(node, attributes, seen);
    for (const auto& [name, attribute] : attributes) bindDisposal(attribute);
    items_.push_back({std::move(dispatch), nullptr, {}, false});
}

void ComputeQueue::readback(std::shared_ptr<BufferAttribute> attribute, ReadbackCallback done) {
    bindDisposal(attribute);
    items_.push_back({{}, std::move(attribute), std::move(done), false});
}

void ComputeQueue::release(std::shared_ptr<BufferAttribute> attribute) {
    items_.push_back({{}, std::move(attribute), {}, true});
}

void ComputeQueue::flush(Renderer& renderer, const std::function<void(const std::string&)>& failed) {
    // Items queued while this runs (a completion callback never runs inside it) wait for the next flush.
    std::vector<Item> items;
    items.swap(items_);
    for (Item& item : items) {
        if (item.release) {
            renderer.releaseStorage(*item.attribute);
        } else if (item.attribute) {
            const GpuStatus status = renderer.readStorage(*item.attribute, item.done);
            if (status != GpuStatus::Ok) item.done(status, {});
        } else {
            try {
                renderer.dispatchCompute(item.dispatch);
            } catch (const std::exception& error) {
                failed(error.what());
            }
        }
    }
}

}  // namespace tn::engine
