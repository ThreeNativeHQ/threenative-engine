#pragma once
#include "engine/renderer/compute.h"
#include <array>
#include <memory>

namespace tn::engine::world {
// Numeric PBF mechanism from core/fluid-particles.ts; density is a linear x/y/z f32 volume.
class FluidParticles3D {
public:
    struct Options {
        uint32_t capacity = 0, iterations = 3;
        double spacing = 0.22, viscosity = 0.008, cohesion = 0.03, vorticity = 0.015;
        double gravity = 9.81, maxSpeed = 18, timeStep = 1.0 / 60, voxelSize = 0;
        std::array<double, 3> min = {-2.9, 0.0968, -1.6}, max = {2.9, 4.65, 1.6};
    };
    enum Kernel { Inject, Predict, GridClear, GridBuild, Lambda, Delta, Apply, Velocity, Smooth, Confine, Volume, Count };
    static shader::Program kernel(Kernel kind, const Options& options);
    FluidParticles3D(WGPUDevice device, GpuResources& gpu, Options options);
    ~FluidParticles3D();
    bool emit(std::array<double, 3> position, std::array<double, 3> velocity = {});
    bool process();
    void release();
    Handle positions() const { return buffers_[Positions]; }
    Handle velocities() const { return buffers_[Velocities]; }
    Handle density() const { return buffers_[DensityVolume]; }
    std::array<uint32_t, 3> volumeSize() const;
    uint32_t steps() const { return steps_; }
    const std::string& error() const { return error_; }
private:
    enum Buffer { Positions, Velocities, Previous, Deltas, Omega, Lambdas, Densities, CellCount, CellItems, DensityVolume, Spawns, BufferCount };
    static std::vector<Buffer> bindings(Kernel kind);
    WGPUDevice device_;
    GpuResources& gpu_;
    Options options_;
    std::array<Handle, BufferCount> buffers_{};
    std::array<std::unique_ptr<ComputePass>, Count> passes_;
    std::vector<float> queued_;
    uint32_t cursor_ = 0, used_ = 0, steps_ = 0;
    bool released_ = false;
    std::string error_;
};
} // namespace tn::engine::world
