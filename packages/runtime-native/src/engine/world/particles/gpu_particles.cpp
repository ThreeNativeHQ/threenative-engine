#include "engine/world/particles/gpu_particles.h"

#include <utility>

namespace tn::engine::world {

using namespace shader;

GpuParticles3D::GpuParticles3D(WGPUDevice device, GpuResources& gpu, Options options)
    : gpu_(gpu), amount_(options.amount), storage_(std::move(options.storage)) {
    if (options.amount == 0) {
        error_ = "GPUParticles3D.amount must be a positive integer.";
        return;
    }
    if (!options.start) {
        error_ = "GPUParticles3D.start must be a function.";
        return;
    }
    if (!options.process) {
        error_ = "GPUParticles3D.process must be a function.";
        return;
    }
    // WGSL lays a vec3 array out at 16 bytes an element, as three's instancedArray(n, "vec3") does.
    const uint64_t bytes = uint64_t{amount_} * 16;
    const auto usage = WGPUBufferUsage_Storage | WGPUBufferUsage_CopySrc | WGPUBufferUsage_CopyDst;
    positions_ = gpu_.createBuffer(bytes, usage);
    velocities_ = gpu_.createBuffer(bytes, usage);
    const std::vector<uint8_t> zeros(bytes, 0);
    gpu_.writeBuffer(positions_, 0, zeros.data(), bytes);
    gpu_.writeBuffer(velocities_, 0, zeros.data(), bytes);
    const Program start = build(options.start);
    const Program process = build(options.process);
    for (const Program* program : {&start, &process})
        for (const Diagnostic& d : program->diagnostics())
            if (error_.empty()) error_ = d.code + " " + d.node + ": " + d.reason;
    if (!error_.empty()) return;
    start_ = std::make_unique<ComputePass>(device, gpu_, start);
    process_ = std::make_unique<ComputePass>(device, gpu_, process);
    if (!start_->error().empty()) error_ = start_->error();
    else if (!process_->error().empty()) error_ = process_->error();
}

GpuParticles3D::~GpuParticles3D() { release(); }

Program GpuParticles3D::build(const Kernel& kernel) const {
    Program program(Stage::Compute);
    tsl::Build scope(program);
    const tsl::Storage positions = tsl::storage("positions", Type::vec(3));
    const tsl::Storage velocities = tsl::storage("velocities", Type::vec(3));
    const tsl::Node index = tsl::instanceIndex();
    tsl::If(index.lessThan(tsl::uint_(amount_)), [&] { kernel(positions, velocities); });
    return program;
}

bool GpuParticles3D::dispatch(ComputePass& pass, WGPUCommandEncoder encoder) {
    std::vector<Handle> storage{positions_, velocities_};
    storage.insert(storage.end(), storage_.begin(), storage_.end());
    if (pass.dispatch(encoder, storage, amount_)) return true;
    error_ = pass.error();
    return false;
}

bool GpuParticles3D::attach(WGPUCommandEncoder encoder) {
    if (released_) {
        error_ = "GPUParticles3D cannot be attached after release.";
        return false;
    }
    if (!error_.empty()) return false;
    if (attached_) return true;
    attached_ = true;
    return dispatch(*start_, encoder);
}

bool GpuParticles3D::process(WGPUCommandEncoder encoder) {
    if (released_ || !emitting) return true;
    if (!attached_) {
        error_ = "GPUParticles3D is not attached to a renderer.";
        return false;
    }
    processDispatches_ += 1;
    return dispatch(*process_, encoder);
}

void GpuParticles3D::release() {
    if (released_) return;
    released_ = true;
    start_.reset();
    process_.reset();
    if (gpu_.buffer(positions_) != nullptr) gpu_.destroy(positions_);
    if (gpu_.buffer(velocities_) != nullptr) gpu_.destroy(velocities_);
}

} // namespace tn::engine::world
