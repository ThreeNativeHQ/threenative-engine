#include "fluid_particles.h"
#include "engine/shader/tsl/tsl.h"
#include <algorithm>
#include <cmath>
#include <numbers>
#include <stdexcept>

namespace tn::engine::world {
using namespace shader;
using namespace shader::tsl;
namespace {
std::array<uint32_t, 3> gridSize(const FluidParticles3D::Options& o) {
    return {uint32_t(std::ceil((o.max[0] - o.min[0]) / (2 * o.spacing))) + 3,
            uint32_t(std::ceil((o.max[1] - o.min[1]) / (2 * o.spacing))) + 3,
            uint32_t(std::ceil((o.max[2] - o.min[2]) / (2 * o.spacing))) + 3};
}
std::array<uint32_t, 3> volumeSize(const FluidParticles3D::Options& o) {
    const double edge = o.voxelSize == 0 ? o.spacing / 2 : o.voxelSize;
    return {uint32_t(std::ceil((o.max[0] - o.min[0]) / edge)),
            uint32_t(std::ceil((o.max[1] - o.min[1]) / edge)),
            uint32_t(std::ceil((o.max[2] - o.min[2]) / edge))};
}
uint64_t product(std::array<uint32_t, 3> a) { return uint64_t{a[0]} * a[1] * a[2]; }
Node asInt(Node n) { return program().construct(Type::i32(), {n.id}); }
Node modulo(Node n, uint32_t d) { return n.sub(n.div(uint_(d)).mul(uint_(d))); }
}

std::vector<FluidParticles3D::Buffer> FluidParticles3D::bindings(Kernel k) {
    switch (k) {
    case Inject: return {Positions, Velocities, Spawns};
    case Predict: return {Positions, Velocities, Previous};
    case GridClear: return {CellCount};
    case GridBuild: return {Positions, CellCount, CellItems};
    case Lambda: return {Positions, CellCount, CellItems, Densities, Lambdas};
    case Delta: return {Positions, CellCount, CellItems, Lambdas, Deltas};
    case Apply: return {Positions, Deltas};
    case Velocity: return {Positions, Velocities, Previous};
    case Smooth: return {Positions, CellCount, CellItems, Velocities, Deltas, Omega};
    case Confine: return {Positions, CellCount, CellItems, Velocities, Deltas, Omega};
    case Volume: return {Positions, CellCount, CellItems, DensityVolume};
    default: return {};
    }
}

Program FluidParticles3D::kernel(Kernel kind, const Options& o) {
    Program p(Stage::Compute);
    Build build(p);
    const char* names[] = {"positions", "velocities", "previous", "deltas", "omega", "lambdas", "densities", "cellCount", "cellItems", "volume", "spawns"};
    std::array<Storage, BufferCount> s{};
    for (Buffer b : bindings(kind)) {
        const Type type = b == CellCount || b == CellItems ? Type::u32()
            : b == Lambdas || b == Densities || b == DensityVolume ? Type::f32() : Type::vec(4);
        s[b] = Storage{p.storageBuffer(names[b], type, b == CellCount)};
    }
    const Node i = instanceIndex();
    const double h = o.spacing * 2, h2 = h * h, volume = std::pow(o.spacing, 3);
    const double poly6 = 315 / (64 * std::numbers::pi * std::pow(h, 9));
    const double spiky = -45 / (std::numbers::pi * std::pow(h, 6));
    const double wReference = poly6 * std::pow(h2 - std::pow(0.3 * h, 2), 3);
    const double edge = o.voxelSize == 0 ? o.spacing / 2 : o.voxelSize;
    const auto dims = gridSize(o), voxels = world::volumeSize(o);
    const Node low = vec3({o.min[0], o.min[1], o.min[2]}), high = vec3({o.max[0], o.max[1], o.max[2]});
    const auto cellOf = [&](Node point) {
        const Node origin = vec3({o.min[0] - h, o.min[1] - h, o.min[2] - h});
        const Node cell = clamp(floor(point.sub(origin).div(h)), vec3({1}), vec3({double(dims[0] - 2), double(dims[1] - 2), double(dims[2] - 2)}));
        return Node(p.construct(Type::vec(3, Type::Scalar::I32), {cell.id}));
    };
    const auto cellId = [&](Node cell) {
        return uint_(cell.x().add(cell.y().mul(int_(dims[0]))).add(cell.z().mul(int_(dims[0] * dims[1]))));
    };
    const auto neighbours = [&](Node point, Node self, const std::function<void(Node, Node, Node)>& body) {
        const Node cell = cellOf(point);
        Loop(27, [&](Node k) {
            const Node dx = k.sub(k.div(int_(3)).mul(int_(3))).sub(int_(1));
            const Node row = k.div(int_(3));
            const Node dy = row.sub(row.div(int_(3)).mul(int_(3))).sub(int_(1));
            const Node dz = k.div(int_(9)).sub(int_(1));
            const Node offsetCell = p.construct(Type::vec(3, Type::Scalar::I32), {dx.id, dy.id, dz.id});
            const Node id = cellId(cell.add(offsetCell));
            const Node count = s[CellCount].element(id);
            const Var limit = toVar(select(count.lessThan(uint_(32)), count, uint_(32)));
            Loop(asInt(limit), [&](Node slot) {
                const Node other = s[CellItems].element(id.mul(uint_(32)).add(uint_(slot)));
                If(other.equal(self), [] {}, [&] {
                    const Node offset = point.sub(Node(s[Positions].element(other)).xyz());
                    const Node r2 = dot(offset, offset);
                    If(r2.lessThan(h2), [&] { body(other, offset, r2); });
                });
            });
        });
    };
    const auto weight = [&](Node r2) { return pow(float_(h2).sub(r2), 3).mul(poly6); };
    const auto gradientScale = [&](Node r) { return pow(float_(h).sub(r), 2).mul(volume * spiky).div(r); };
    const auto crossProduct = [&](Node a, Node b) {
        return vec3({a.y().mul(b.z()).sub(a.z().mul(b.y())), a.z().mul(b.x()).sub(a.x().mul(b.z())), a.x().mul(b.y()).sub(a.y().mul(b.x()))});
    };
    if (kind == GridClear) {
        If(i.lessThan(uint_(product(dims))), [&] { s[CellCount].element(i).assign(uint_(0)); });
    } else if (kind == Volume) {
        If(i.lessThan(uint_(product(voxels))), [&] {
            const Node ix = modulo(i, voxels[0]), iy = modulo(i.div(uint_(voxels[0])), voxels[1]), iz = i.div(uint_(voxels[0] * voxels[1]));
            const Node centre = vec3({float_(ix), float_(iy), float_(iz)}).add(0.5).mul(edge).add(low);
            const Var total = toVar(float_(0));
            neighbours(centre, uint_(0xffffffff), [&](Node, Node, Node r2) { total.assign(total.add(weight(r2).mul(volume))); });
            s[DensityVolume].element(i).assign(total);
        });
    } else if (kind == Inject) {
        If(i.lessThan(uint_(o.capacity)), [&] {
            const Node count = uniform("spawnCount", Type::f32());
            Loop(asInt(count), [&](Node spawn) {
                const Node a = s[Spawns].element(uint_(spawn).mul(uint_(2)));
                If(i.equal(uint_(a.w())), [&] {
                    s[Positions].element(i).assign(vec4({a.xyz(), 1}));
                    s[Velocities].element(i).assign(s[Spawns].element(uint_(spawn).mul(uint_(2)).add(uint_(1))));
                });
            });
        });
    } else {
        If(i.lessThan(uint_(uniform("slots", Type::f32()))), [&] {
            If(Node(s[Positions].element(i)).w().greaterThan(0.5), [&] {
                const Node position = Node(s[Positions].element(i)).xyz();
                switch (kind) {
                case Predict: {
                    const Var v = toVar(Node(s[Velocities].element(i)).xyz().add(vec3({0, float_(o.gravity).negate().mul(o.timeStep), 0})));
                    v.assign(v.mul(float_(o.maxSpeed).div(max(length(v), o.maxSpeed))));
                    const Var next = toVar(position);
                    s[Previous].element(i).assign(vec4({position, 1}));
                    // ceil(x) == -floor(-x); the native builder already provides floor.
                    const Var segments = toVar(uint_(clamp(floor(length(v).mul(o.timeStep).div(o.spacing * 0.44).negate()).negate(), 1,
                        std::max(1.0, std::ceil(o.maxSpeed * o.timeStep / (o.spacing * 0.44))))));
                    Loop(asInt(segments), [&](Node) {
                        next.assign(clamp(next.add(v.mul(o.timeStep).div(float_(segments))), low, high));
                    });
                    s[Positions].element(i).assign(vec4({next, 1}));
                    s[Velocities].element(i).assign(vec4({v, Node(s[Velocities].element(i)).w()}));
                    break;
                }
                case GridBuild: {
                    const Node id = cellId(cellOf(position));
                    const Var slot = toVar(p.atomicAdd(s[CellCount].buffer, id.id, uint_(1).id));
                    If(Node(slot).lessThan(uint_(32)), [&] { s[CellItems].element(id.mul(uint_(32)).add(slot)).assign(i); });
                    break;
                }
                case Lambda: {
                    const Var rho = toVar(float_(volume * (poly6 * std::pow(h, 6)))), gradient = toVar(vec3({0})), sum = toVar(float_(0));
                    neighbours(position, i, [&](Node, Node offset, Node r2) {
                        rho.assign(rho.add(weight(r2).mul(volume)));
                        const Node r = sqrt(r2);
                        If(r.greaterThan(1e-6), [&] {
                            const Node a = offset.mul(gradientScale(r));
                            gradient.assign(gradient.add(a)); sum.assign(sum.add(dot(a, a)));
                        });
                    });
                    s[Densities].element(i).assign(rho);
                    s[Lambdas].element(i).assign(max(Node(rho).sub(1), 0).negate().div(sum.add(dot(gradient, gradient)).add(0.03)));
                    break;
                }
                case Delta: {
                    const Node own = s[Lambdas].element(i);
                    const Var total = toVar(vec3({0}));
                    neighbours(position, i, [&](Node other, Node offset, Node r2) {
                        const Node r = sqrt(r2);
                        If(r.greaterThan(1e-6), [&] {
                            const Node tensile = pow(weight(r2).div(wReference), 4).mul(-0.001);
                            const Node strength = own.add(s[Lambdas].element(other)).add(tensile);
                            total.assign(total.add(offset.mul(strength.mul(gradientScale(r)))));
                        });
                    });
                    const Node magnitude = length(total), limit = float_(o.spacing * 0.24);
                    const Node scale = select(magnitude.greaterThan(limit), limit.div(magnitude), float_(1));
                    s[Deltas].element(i).assign(vec4({total.mul(scale), 0}));
                    break;
                }
                case Apply:
                    s[Positions].element(i).assign(vec4({clamp(position.add(Node(s[Deltas].element(i)).xyz()), low, high), 1})); break;
                case Velocity:
                    s[Velocities].element(i).assign(vec4({position.sub(Node(s[Previous].element(i)).xyz()).div(o.timeStep), Node(s[Velocities].element(i)).w()})); break;
                case Smooth: {
                    const Node v = Node(s[Velocities].element(i)).xyz();
                    const Var change = toVar(vec3({0})), curl = toVar(vec3({0})), count = toVar(float_(0));
                    neighbours(position, i, [&](Node other, Node offset, Node r2) {
                        const Node w = weight(r2).mul(volume), dv = Node(s[Velocities].element(other)).xyz().sub(v);
                        change.assign(change.add(dv.mul(float_(o.viscosity).mul(w)).sub(offset.mul(float_(o.cohesion).mul(w).mul(o.timeStep).mul(8)))));
                        count.assign(count.add(1));
                        const Node r = sqrt(r2);
                        If(r.greaterThan(1e-6), [&] { curl.assign(curl.add(crossProduct(dv, offset).mul(gradientScale(r)))); });
                    });
                    s[Deltas].element(i).assign(vec4({change, 0})); s[Omega].element(i).assign(vec4({curl, count}));
                    break;
                }
                case Confine: {
                    const Node own = length(Node(s[Omega].element(i)).xyz());
                    const Var eta = toVar(vec3({0}));
                    neighbours(position, i, [&](Node other, Node offset, Node r2) {
                        const Node r = sqrt(r2);
                        If(r.greaterThan(1e-6), [&] {
                            const Node diff = length(Node(s[Omega].element(other)).xyz()).sub(own);
                            eta.assign(eta.add(offset.mul(gradientScale(r).mul(diff))));
                        });
                    });
                    const Node scale = float_(o.vorticity).mul(o.timeStep).div(length(eta).add(1e-5));
                    const Node force = crossProduct(eta, Node(s[Omega].element(i)).xyz()).mul(scale);
                    const Var v = toVar(Node(s[Velocities].element(i)).xyz().add(Node(s[Deltas].element(i)).xyz())
                        .add(select(float_(o.vorticity).greaterThan(0), clamp(force, vec3({-0.15}), vec3({0.15})), vec3({0}))));
                    If(position.y().greaterThan(o.min[1] + 0.002), [] {}, [&] { v.assign(vec3({Node(v).x().mul(0.92), Node(v).y(), Node(v).z().mul(0.92)})); });
                    v.assign(v.mul(float_(o.maxSpeed).div(max(length(v), o.maxSpeed))));
                    const Node source = clamp(length(v).sub(1.5).mul(0.14), 0, 1)
                        .mul(select(Node(s[Omega].element(i)).w().lessThan(22), float_(1), float_(0.2)));
                    const Node foam = max(Node(s[Velocities].element(i)).w().mul(exp(float_(o.timeStep).mul(-1.3))), source);
                    s[Velocities].element(i).assign(vec4({v, foam}));
                    break;
                }
                default: break;
                }
            });
        });
    }
    return p;
}

FluidParticles3D::FluidParticles3D(WGPUDevice device, GpuResources& gpu, Options o)
    : device_(device), gpu_(gpu), options_(o) {
    bool valid = o.capacity > 0 && o.iterations <= 8;
    for (double v : {o.spacing, o.maxSpeed, o.timeStep}) valid &= std::isfinite(v) && v > 0;
    for (double v : {o.viscosity, o.cohesion, o.vorticity, o.gravity, o.voxelSize}) valid &= std::isfinite(v) && v >= 0;
    for (int a = 0; a < 3; ++a) valid &= std::isfinite(o.min[a]) && std::isfinite(o.max[a]) && o.max[a] - o.min[a] >= 2 * o.spacing;
    if (!valid) { error_ = "FluidParticles3D: invalid capacity, bounds or solver options"; return; }
    // Check dimensions in double before integer conversion/allocation.
    const double edge = o.voxelSize == 0 ? o.spacing / 2 : o.voxelSize;
    double cells = 1, voxels = 1;
    for (int a = 0; a < 3; ++a) { cells *= std::ceil((o.max[a] - o.min[a]) / (2 * o.spacing)) + 3; voxels *= std::ceil((o.max[a] - o.min[a]) / edge); }
    if (voxels > 4000000 || cells * 32 > UINT32_MAX) { error_ = "FluidParticles3D: grid or density volume too large"; return; }
    for (int b = 0; b < BufferCount; ++b) {
        const uint64_t bytes = b == CellCount ? uint64_t(cells) * 4 : b == CellItems ? uint64_t(cells) * 32 * 4
            : b == DensityVolume ? uint64_t(voxels) * 4 : b == Spawns ? 16 * 32
            : uint64_t{o.capacity} * (b == Lambdas || b == Densities ? 4 : 16);
        buffers_[b] = gpu_.createBuffer(bytes, WGPUBufferUsage_Storage | WGPUBufferUsage_CopySrc | WGPUBufferUsage_CopyDst);
        const std::vector<uint8_t> zeros(bytes);
        gpu_.writeBuffer(buffers_[b], 0, zeros.data(), bytes);
    }
    for (int k = 0; k < Count; ++k) {
        const Program p = kernel(static_cast<Kernel>(k), o);
        passes_[k] = std::make_unique<ComputePass>(device_, gpu_, p);
        if (!p.ok() || !passes_[k]->error().empty()) { error_ = "FluidParticles3D kernel " + std::to_string(k) + ": " + passes_[k]->error(); return; }
    }
}
FluidParticles3D::~FluidParticles3D() { release(); }
std::array<uint32_t, 3> FluidParticles3D::volumeSize() const { return world::volumeSize(options_); }
bool FluidParticles3D::emit(std::array<double, 3> position, std::array<double, 3> velocity) {
    if (released_) throw std::runtime_error("FluidParticles3D cannot emit after release.");
    for (const auto& vector : {position, velocity}) for (double v : vector)
        if (!std::isfinite(v)) throw std::invalid_argument("FluidParticles3D.emit arguments must be finite.");
    if (!error_.empty() || queued_.size() / 8 >= 16) return false;
    const uint32_t slot = cursor_ % options_.capacity;
    queued_.insert(queued_.end(), {float(position[0]), float(position[1]), float(position[2]), float(slot), float(velocity[0]), float(velocity[1]), float(velocity[2]), 0});
    ++cursor_; used_ = std::min(cursor_, options_.capacity);
    return true;
}
bool FluidParticles3D::process() {
    if (released_) return true;
    if (!error_.empty()) return false;
    if (!queued_.empty()) gpu_.writeBuffer(buffers_[Spawns], 0, queued_.data(), queued_.size() * sizeof(float));
    WGPUCommandEncoderDescriptor desc = {};
    WGPUCommandEncoder encoder = wgpuDeviceCreateCommandEncoder(device_, &desc);
    const auto dispatch = [&](Kernel k) {
        std::vector<Handle> buffers;
        for (Buffer b : bindings(k)) buffers.push_back(buffers_[b]);
        const uint32_t count = k == GridClear ? product(gridSize(options_)) : k == Volume ? product(volumeSize()) : options_.capacity;
        if (passes_[k]->dispatch(encoder, buffers, count, {{"slots", used_}, {"spawnCount", queued_.size() / 8}})) return true;
        error_ = passes_[k]->error(); return false;
    };
    bool ok = queued_.empty() || dispatch(Inject);
    if (used_ > 0) {
        ok = ok && dispatch(Predict);
        for (uint32_t n = 0; n < options_.iterations && ok; ++n)
            ok = dispatch(GridClear) && dispatch(GridBuild) && dispatch(Lambda) && dispatch(Delta) && dispatch(Apply);
        ok = ok && dispatch(GridClear) && dispatch(GridBuild) && dispatch(Velocity) && dispatch(Smooth) && dispatch(Confine) && dispatch(Volume);
    }
    if (ok) {
        WGPUCommandBufferDescriptor desc = {};
        gpu_.submit(wgpuCommandEncoderFinish(encoder, &desc));
        queued_.clear(); ++steps_;
    }
    wgpuCommandEncoderRelease(encoder);
    return ok;
}
void FluidParticles3D::release() {
    if (released_) return;
    for (auto& pass : passes_) pass.reset();
    for (Handle h : buffers_) if (h.type) gpu_.destroy(h);
    released_ = true;
}
} // namespace tn::engine::world
