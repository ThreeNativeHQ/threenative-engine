#pragma once

#include "engine/renderer/compute.h"
#include "engine/shader/tsl/tsl.h"

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace tn::engine::world {

/**
 * GPUParticles3D's mechanism (PRD-527 phase 1), ported from packages/core/src/particles.ts: the
 * framework owns two vec3 storage buffers (positions, velocities), dispatches the game's `start`
 * kernel once on the first attach and its `process` kernel once per render while `emitting`, and
 * stops after release. Emission, lifetime and recycling are the game's kernels, as in TS; the look
 * (the material that reads `positions`) is the game's too.
 *
 * A kernel is authored with the native TSL builder against the two framework buffers; any storage
 * buffer it declares after them is the game's own, bound from `Options::storage` in order. Every
 * invocation past `amount` is skipped, so a game kernel never writes past the buffers.
 */
class GpuParticles3D {
public:
    using Kernel = std::function<void(shader::tsl::Storage positions, shader::tsl::Storage velocities)>;

    struct Options {
        uint32_t amount = 0;
        Kernel start;
        Kernel process;
        std::vector<Handle> storage;  // the game's own buffers, in the order its kernels declare them
    };

    GpuParticles3D(WGPUDevice device, GpuResources& gpu, Options options);
    ~GpuParticles3D();
    GpuParticles3D(const GpuParticles3D&) = delete;
    GpuParticles3D& operator=(const GpuParticles3D&) = delete;

    /** Empty when constructed; else the TS constructor's refusal, by its message. */
    const std::string& error() const { return error_; }

    /** First attach records the start kernel into `encoder`; later attaches do nothing. */
    bool attach(WGPUCommandEncoder encoder);
    /** One process dispatch, unless released or not emitting (TS's `process`). */
    bool process(WGPUCommandEncoder encoder);
    void release();

    bool emitting = true;
    bool released() const { return released_; }
    uint32_t amount() const { return amount_; }
    Handle positions() const { return positions_; }
    Handle velocities() const { return velocities_; }
    uint32_t processDispatches() const { return processDispatches_; }

private:
    shader::Program build(const Kernel& kernel) const;
    bool dispatch(ComputePass& pass, WGPUCommandEncoder encoder);

    GpuResources& gpu_;
    uint32_t amount_ = 0;
    std::vector<Handle> storage_;
    Handle positions_;
    Handle velocities_;
    std::unique_ptr<ComputePass> start_;
    std::unique_ptr<ComputePass> process_;
    bool attached_ = false;
    bool released_ = false;
    uint32_t processDispatches_ = 0;
    std::string error_;
};

} // namespace tn::engine::world
