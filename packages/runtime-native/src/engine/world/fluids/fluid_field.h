#pragma once
#include "engine/renderer/compute.h"
#include <array>
#include <memory>

namespace tn::engine::world {
// FluidField2D's numeric mechanism, ported from core/fluid-field.ts. A vec4 buffer per
// texture preserves its nearest, clamped texel loads; appearance belongs to the game.
class FluidField2D {
public:
    struct Options {
        uint32_t resolution = 0, pressureIterations = 20, maxSplats = 8;
        double viscosity = 0, timeStep = 1.0 / 60, vorticity = 0.2, splatRadius = 0.08;
    };
    enum Kernel { VelocitySplat, DyeSplat, Curl, Vorticity, Divergence, Pressure, Gradient, AdvectVelocity, AdvectDye, Count };
    static shader::Program kernel(Kernel kind, const Options& options);
    FluidField2D(WGPUDevice device, GpuResources& gpu, Options options);
    ~FluidField2D();
    bool splat(double x, double y, double vx, double vy, double amount);
    // Submits each fixed step: subsequent queue writes cannot change prior steps' splats/uniforms.
    bool process();
    void release();
    Handle velocity() const { return velocity_[vi_]; }
    Handle dye() const { return dye_[di_]; }
    uint32_t steps() const { return steps_; }
    uint32_t splatsApplied() const { return applied_; }
    const std::string& error() const { return error_; }
private:
    WGPUDevice device_;
    GpuResources& gpu_;
    Options options_;
    std::array<Handle, 2> velocity_, dye_, pressure_;
    Handle curl_, divergence_, splats_;
    std::array<std::unique_ptr<ComputePass>, Count> passes_;
    std::vector<float> queued_;
    uint32_t vi_ = 0, di_ = 0, steps_ = 0, applied_ = 0;
    bool released_ = false;
    std::string error_;
};
} // namespace tn::engine::world
