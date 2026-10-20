#include "fluid_field.h"
#include "engine/shader/tsl/tsl.h"
#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace tn::engine::world {
using namespace shader;
using namespace shader::tsl;

Program FluidField2D::kernel(Kernel kind, const Options& o) {
    Program p(Stage::Compute);
    Build build(p);
    const Storage source = storage("source", Type::vec(4));
    const Storage target = storage("target", Type::vec(4));
    const bool usesExtra = kind != Curl && kind != Divergence && kind != AdvectVelocity;
    const Storage extra = usesExtra ? storage("extra", Type::vec(4)) : Storage{};
    const Node r = float_(o.resolution);
    const Node row = instanceIndex().div(uint_(o.resolution));
    const Node column = instanceIndex().sub(row.mul(uint_(o.resolution)));
    const Node uv = vec2({float_(column).add(0.5).div(r), float_(row).add(0.5).div(r)});
    const auto sample = [&](Storage field, Node at) -> Node {
        const Node xy = clamp(at.mul(r), 0, float_(o.resolution - 1));
        return field.element(uint_(xy.y()).mul(uint_(o.resolution)).add(uint_(xy.x())));
    };
    const auto neighbour = [&](Storage field, int x, int y) {
        return sample(field, clamp(uv.add(vec2({float_(x), float_(y)}).div(r)), 0, 1));
    };
    If(instanceIndex().lessThan(uint_(o.resolution * o.resolution)), [&] {
        const Node center = sample(source, uv);
        Node next = center;
        switch (kind) {
        case VelocitySplat:
        case DyeSplat: {
            const Var pixel = toVar(center);
            const Node count = uniform("splatCount", Type::f32());
            Loop(Node(p.construct(Type::i32(), {count.id})), [&](Node index) {
                const Node i = uint_(index);
                const Node position = extra.element(i.mul(uint_(2)));
                const Node amount = Node(extra.element(i.mul(uint_(2)).add(uint_(1)))).x();
                const Node influence = clamp(float_(1).sub(length(uv.sub(position.xy())).div(o.splatRadius)), 0, 1);
                If(influence.greaterThan(0), [&] {
                    const Node current = pixel.read();
                    pixel.assign(kind == VelocitySplat
                        ? vec4({current.xy().add(position.swizzle("zw").mul(amount).mul(influence)), current.swizzle("zw")})
                        : vec4({current.x().add(amount.mul(influence)), current.swizzle("yzw")}));
                });
            });
            next = pixel.read();
            break;
        }
        case Curl:
            next = vec4({0, 0, neighbour(source, 1, 0).y().sub(neighbour(source, -1, 0).y())
                .sub(neighbour(source, 0, 1).x()).add(neighbour(source, 0, -1).x()).mul(0.5), center.w()});
            break;
        case Vorticity: {
            const Node gradient = vec2({abs(neighbour(extra, 0, 1).z()).sub(abs(neighbour(extra, 0, -1).z())),
                                       abs(neighbour(extra, 1, 0).z()).sub(abs(neighbour(extra, -1, 0).z()))});
            const Node force = gradient.div(length(gradient).add(0.0001));
            next = vec4({center.xy().add(vec2({force.x(), force.y().negate()}).mul(sample(extra, uv).z())
                            .mul(o.vorticity * o.timeStep)), center.swizzle("zw")});
            break;
        }
        case Divergence:
            next = vec4({0, 0, 0, neighbour(source, 1, 0).x().sub(neighbour(source, -1, 0).x())
                .add(neighbour(source, 0, 1).y()).sub(neighbour(source, 0, -1).y()).mul(0.5)});
            break;
        case Pressure:
            next = vec4({neighbour(source, -1, 0).x().add(neighbour(source, 1, 0).x())
                .add(neighbour(source, 0, -1).x()).add(neighbour(source, 0, 1).x())
                .sub(sample(extra, uv).w()).mul(0.25), 0, 0, 0});
            break;
        case Gradient: {
            const Node gradient = vec2({neighbour(extra, 1, 0).x().sub(neighbour(extra, -1, 0).x()),
                                        neighbour(extra, 0, 1).x().sub(neighbour(extra, 0, -1).x())}).mul(0.5);
            next = vec4({center.xy().sub(gradient), center.swizzle("zw")});
            break;
        }
        case AdvectVelocity: {
            const Node traced = clamp(uv.sub(center.xy().mul(o.timeStep)), 0, 1);
            const Node laplacian = neighbour(source, -1, 0).xy().add(neighbour(source, 1, 0).xy())
                .add(neighbour(source, 0, -1).xy()).add(neighbour(source, 0, 1).xy()).sub(center.xy().mul(4));
            next = vec4({sample(source, traced).xy().add(laplacian.mul(o.viscosity * o.timeStep)), center.swizzle("zw")});
            break;
        }
        case AdvectDye:
            next = sample(source, clamp(uv.sub(sample(extra, uv).xy().mul(o.timeStep)), 0, 1));
            break;
        default: break;
        }
        target.element(instanceIndex()).assign(next);
    });
    return p;
}

FluidField2D::FluidField2D(WGPUDevice device, GpuResources& gpu, Options o)
    : device_(device), gpu_(gpu), options_(o) {
    if (o.resolution < 2 || uint64_t{o.resolution} * o.resolution > UINT32_MAX || o.maxSplats == 0 ||
        !std::isfinite(o.viscosity) || o.viscosity < 0 || !std::isfinite(o.vorticity) || o.vorticity < 0 ||
        !std::isfinite(o.timeStep) || o.timeStep <= 0 || !std::isfinite(o.splatRadius) || o.splatRadius <= 0) {
        error_ = "FluidField2D: invalid resolution, splat capacity or solver options";
        return;
    }
    const auto allocate = [&](uint64_t bytes) {
        const Handle h = gpu_.createBuffer(bytes, WGPUBufferUsage_Storage | WGPUBufferUsage_CopySrc | WGPUBufferUsage_CopyDst);
        const std::vector<uint8_t> zeros(bytes);
        gpu_.writeBuffer(h, 0, zeros.data(), bytes);
        return h;
    };
    const uint64_t bytes = uint64_t{o.resolution} * o.resolution * 16;
    for (auto* pair : {&velocity_, &dye_, &pressure_}) for (Handle& h : *pair) h = allocate(bytes);
    curl_ = allocate(bytes);
    divergence_ = allocate(bytes);
    splats_ = allocate(uint64_t{o.maxSplats} * 32);
    for (int i = 0; i < Count; ++i) {
        const Program p = kernel(static_cast<Kernel>(i), o);
        passes_[i] = std::make_unique<ComputePass>(device_, gpu_, p);
        if (!p.ok() || !passes_[i]->error().empty()) {
            error_ = "FluidField2D kernel " + std::to_string(i) + ": " + passes_[i]->error();
            return;
        }
    }
}
FluidField2D::~FluidField2D() { release(); }

bool FluidField2D::splat(double x, double y, double vx, double vy, double amount) {
    if (released_) throw std::runtime_error("FluidField2D cannot splat after release.");
    for (double v : {x, y, vx, vy, amount})
        if (!std::isfinite(v)) throw std::invalid_argument("FluidField2D.splat arguments must be finite.");
    if (amount < 0) throw std::invalid_argument("FluidField2D.splat amount must be non-negative.");
    if (!error_.empty() || amount == 0 || queued_.size() / 8 >= options_.maxSplats) return false;
    queued_.insert(queued_.end(), {float(std::clamp(x, 0.0, 1.0)), float(std::clamp(y, 0.0, 1.0)),
                                 float(vx), float(vy), float(amount), 0, 0, 0});
    return true;
}

bool FluidField2D::process() {
    if (released_) return true;
    if (!error_.empty()) return false;
    const uint32_t count = queued_.size() / 8;
    if (count) gpu_.writeBuffer(splats_, 0, queued_.data(), queued_.size() * sizeof(float));
    WGPUCommandEncoderDescriptor desc = {};
    WGPUCommandEncoder encoder = wgpuDeviceCreateCommandEncoder(device_, &desc);
    const auto dispatch = [&](Kernel k, Handle source, Handle target, Handle extra) {
        const Handle buffers[] = {source, target, extra};
        const bool ok = passes_[k]->dispatch(encoder, std::span<const Handle>(buffers, k == Curl || k == Divergence || k == AdvectVelocity ? 2 : 3), options_.resolution * options_.resolution, {{"splatCount", count}});
        if (!ok) error_ = passes_[k]->error();
        return ok;
    };
    bool ok = dispatch(VelocitySplat, velocity_[vi_], velocity_[1 - vi_], splats_); vi_ = 1 - vi_;
    ok = ok && dispatch(DyeSplat, dye_[di_], dye_[1 - di_], splats_); di_ = 1 - di_;
    ok = ok && dispatch(Curl, velocity_[vi_], curl_, splats_);
    ok = ok && dispatch(Vorticity, velocity_[vi_], velocity_[1 - vi_], curl_); vi_ = 1 - vi_;
    ok = ok && dispatch(Divergence, velocity_[vi_], divergence_, splats_);
    // Reset via a queue write before submission: pressure[0] is read only after this reset.
    const std::vector<uint8_t> zeros(uint64_t{options_.resolution} * options_.resolution * 16);
    gpu_.writeBuffer(pressure_[0], 0, zeros.data(), zeros.size());
    uint32_t pi = 0;
    for (uint32_t i = 0; i < options_.pressureIterations && ok; ++i) {
        ok = dispatch(Pressure, pressure_[pi], pressure_[1 - pi], divergence_); pi = 1 - pi;
    }
    ok = ok && dispatch(Gradient, velocity_[vi_], velocity_[1 - vi_], pressure_[pi]); vi_ = 1 - vi_;
    ok = ok && dispatch(AdvectVelocity, velocity_[vi_], velocity_[1 - vi_], splats_); vi_ = 1 - vi_;
    ok = ok && dispatch(AdvectDye, dye_[di_], dye_[1 - di_], velocity_[vi_]); di_ = 1 - di_;
    if (ok) {
        WGPUCommandBufferDescriptor commands = {};
        gpu_.submit(wgpuCommandEncoderFinish(encoder, &commands));
        ++steps_; applied_ += count; queued_.clear();
    }
    wgpuCommandEncoderRelease(encoder);
    return ok;
}
void FluidField2D::release() {
    if (released_) return;
    for (auto* pair : {&velocity_, &dye_, &pressure_}) for (Handle h : *pair) if (h.type) gpu_.destroy(h);
    for (Handle h : {curl_, divergence_, splats_}) if (h.type) gpu_.destroy(h);
    for (auto& pass : passes_) pass.reset();
    released_ = true;
}
} // namespace tn::engine::world
