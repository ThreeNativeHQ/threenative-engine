#include "engine/world/gpu_scene/cull_kernel.h"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <functional>

namespace tn::engine::world {

using shader::ExprId;
using shader::Program;
using shader::Stage;
using shader::Type;

namespace {

// world-gpu-scene.ts's GATE_STEP: the terminal impostor gate's floor sits one step past the last
// source gate.
constexpr float kGateStep = 0x1p-22f;

struct Kernel {
    Program p{Stage::Compute};

    ExprId u32(int32_t value) { return p.construct(Type::u32(), {p.constant(value)}); }
    ExprId toU32(ExprId value) { return p.construct(Type::u32(), {value}); }
    ExprId toF32(ExprId value) { return p.construct(Type::f32(), {value}); }
    ExprId toI32(ExprId value) { return p.construct(Type::i32(), {value}); }
    ExprId lane(ExprId value, const char* lanes) { return p.swizzle(value, lanes); }
    /** TSL's `Return()` under `condition`: the rest runs only when it is false. */
    void unless(ExprId condition, const std::function<void()>& rest) { p.If(condition, [] {}, rest); }
};

} // namespace

GpuSceneTables packGpuScene(const GpuSceneInput& input, const GpuSceneShadowLevel* shadow, double bias) {
    GpuSceneTables t;
    const float* planes = shadow != nullptr ? shadow->planes.data() : input.camera.planes.data();
    t.placements = input.count;
    t.keyCount = input.regionCount;
    t.params = {static_cast<float>(input.count),
                static_cast<float>(input.slots.size()),
                static_cast<float>(input.regionCount),
                static_cast<float>(bias),
                static_cast<float>(shadow != nullptr ? shadow->centreX : input.camera.x),
                static_cast<float>(shadow != nullptr ? shadow->centreZ : input.camera.z),
                static_cast<float>(shadow != nullptr ? shadow->gate : 0),
                static_cast<float>(shadow != nullptr ? shadow->base : 0)};
    t.params.insert(t.params.end(), planes, planes + kGpuScenePlaneWords);

    for (const GpuScenePlacement& placement : input.placements) {
        t.matrices.insert(t.matrices.end(), placement.matrix.begin(), placement.matrix.end());
        t.centres.insert(t.centres.end(), placement.centre.begin(), placement.centre.end());
        // The record's scale is finite-sanitised when it is written, as `levelAtGates` reads it.
        const double scale = std::isfinite(placement.scale) ? placement.scale : 1;
        t.info.insert(t.info.end(), {static_cast<float>(placement.slot), static_cast<float>(scale), 0, 0});
    }

    // `#writeSlots`: one vec4 per asset, one per level.
    uint32_t row = 0;
    for (const GpuSceneSlot& slot : input.slots) {
        const uint32_t first = row;
        for (std::size_t index = 0; index < slot.levels.size(); ++index) {
            const double distance = index < slot.distances.size() ? slot.distances[index] : 0;
            const bool terminal = slot.impostor && index + 1 == slot.levels.size();
            t.levels.insert(t.levels.end(), {static_cast<float>(distance), static_cast<float>(slot.levels[index].firstKey),
                                             static_cast<float>(slot.levels[index].parts), terminal ? 1.0f : 0.0f});
            row += 1;
        }
        t.gates.insert(t.gates.end(), {static_cast<float>(first), static_cast<float>(slot.levels.size()),
                                       static_cast<float>(slot.hasCull ? slot.cull : 0), slot.hasCull ? 1.0f : 0.0f});
    }

    t.args.assign(static_cast<std::size_t>(input.regionCount) * kGpuSceneDrawArgsWords, 0);
    for (const GpuSceneRegion& region : input.regions) {
        t.keys.insert(t.keys.end(), {static_cast<float>(region.start), static_cast<float>(region.capacity),
                                     static_cast<float>(region.argsIndex), 0});
        t.locals.insert(t.locals.end(), region.local.begin(), region.local.end());
        t.drawnCapacity = std::max(t.drawnCapacity, region.start + region.capacity);
        const std::size_t at = static_cast<std::size_t>(region.argsIndex) * kGpuSceneDrawArgsWords + 4;
        if (at < t.args.size()) t.args[at] = region.start;
    }
    return t;
}

Program gpuSceneClearKernel() {
    Kernel k;
    Program& p = k.p;
    const uint32_t params = p.storageBuffer("params", Type::vec(4));
    const uint32_t keys = p.storageBuffer("keys", Type::vec(4));
    const uint32_t args = p.storageBuffer("args", Type::u32(), true);
    const ExprId id = k.lane(p.builtin("globalInvocationId"), "x");
    const ExprId keyCount = k.lane(p.loadStorage(params, k.u32(0)), "z");
    p.If(p.less(k.toF32(id), keyCount), [&] {
        const ExprId key = p.loadStorage(keys, id);
        const ExprId at = p.add(p.mul(k.toU32(k.lane(key, "z")), k.u32(kGpuSceneDrawArgsWords)), k.u32(1));
        p.store(args, at, k.u32(0));
    });
    return std::move(k.p);
}

Program gpuSceneClampKernel() {
    Kernel k;
    Program& p = k.p;
    const uint32_t params = p.storageBuffer("params", Type::vec(4));
    const uint32_t keys = p.storageBuffer("keys", Type::vec(4));
    const uint32_t args = p.storageBuffer("args", Type::u32(), true);
    const ExprId id = k.lane(p.builtin("globalInvocationId"), "x");
    const ExprId keyCount = k.lane(p.loadStorage(params, k.u32(0)), "z");
    p.If(p.less(k.toF32(id), keyCount), [&] {
        const ExprId key = p.loadStorage(keys, id);
        const ExprId at = p.add(p.mul(k.toU32(k.lane(key, "z")), k.u32(kGpuSceneDrawArgsWords)), k.u32(1));
        const ExprId taken = p.loadStorage(args, at);
        const ExprId capacity = k.toU32(k.lane(key, "y"));
        p.store(args, at, p.select(p.less(capacity, taken), capacity, taken));
    });
    return std::move(k.p);
}

Program gpuSceneCullKernel(bool shadow) {
    Kernel k;
    Program& p = k.p;
    const uint32_t params = p.storageBuffer("params", Type::vec(4));
    const uint32_t matrices = p.storageBuffer("matrices", Type::mat(4, 4));
    const uint32_t centres = p.storageBuffer("centres", Type::vec(4));
    const uint32_t info = p.storageBuffer("info", Type::vec(4));
    const uint32_t gates = p.storageBuffer("gates", Type::vec(4));
    const uint32_t levels = p.storageBuffer("levels", Type::vec(4));
    const uint32_t keys = p.storageBuffer("keys", Type::vec(4));
    const uint32_t locals = p.storageBuffer("locals", Type::mat(4, 4));
    const uint32_t args = p.storageBuffer("args", Type::u32(), true);
    const uint32_t drawn = p.storageBuffer("drawn", Type::mat(4, 4));

    const ExprId id = k.lane(p.builtin("globalInvocationId"), "x");
    const ExprId head = p.loadStorage(params, k.u32(0));
    const ExprId eye = p.loadStorage(params, k.u32(1));
    const ExprId zero = p.constant(0.0f);
    const ExprId half = p.constant(0.5f);

    p.If(p.less(k.toF32(id), k.lane(head, "x")), [&] {
        const ExprId centre = p.loadStorage(centres, id);
        const ExprId record = p.loadStorage(info, id);
        const ExprId slot = k.lane(record, "x");
        k.unless(p.less(slot, zero), [&] {
            p.If(p.less(slot, k.lane(head, "y")), [&] {
                const ExprId radius = k.lane(centre, "w");
                // `plane.dot(centre.xyz)`: TSL widens the vec3 to vec4(xyz, 1), so the plane's
                // constant is added.
                const ExprId point = p.construct(Type::vec(4), {k.lane(centre, "xyz"), p.constant(1.0f)});
                const shader::VarId visible = p.var(Type::boolean(), p.constant(true));
                for (int32_t plane = 0; plane < 6; ++plane) {
                    const ExprId normal = p.loadStorage(params, k.u32(2 + plane));
                    p.If(p.less(p.call("dot", {normal, point}), p.neg(radius)),
                         [&] { p.assign(visible, p.constant(false)); });
                }
                if (shadow) {
                    // Sub-texel for this map: `gate > 0 && radius * 2 < gate`.
                    const ExprId texel = k.lane(eye, "z");
                    p.If(p.less(zero, texel), [&] {
                        p.If(p.less(p.mul(radius, p.constant(2.0f)), texel),
                             [&] { p.assign(visible, p.constant(false)); });
                    });
                }
                p.If(p.load(visible), [&] {
                    const ExprId asset = p.loadStorage(gates, k.toU32(slot));
                    const ExprId offset = p.construct(Type::vec(3), {p.sub(k.lane(centre, "x"), k.lane(eye, "x")), zero,
                                                                     p.sub(k.lane(centre, "z"), k.lane(eye, "y"))});
                    const ExprId distance = p.call("length", {offset});
                    const shader::VarId kept = p.var(Type::boolean(), p.constant(true));
                    p.If(p.less(half, k.lane(asset, "w")), [&] {
                        p.If(p.less(k.lane(asset, "z"), distance), [&] { p.assign(kept, p.constant(false)); });
                    });
                    p.If(p.load(kept), [&] {
                        // Cull above is the authored distance; the main pass's level reads it scaled
                        // by the adaptive LOD bias, the shadow pass's does not.
                        const ExprId lodDistance = shadow ? distance : p.mul(distance, k.lane(head, "w"));
                        const shader::VarId level = p.var(Type::i32(), p.constant(int32_t{0}));
                        const ExprId scale = p.call("abs", {k.lane(record, "y")});
                        const ExprId first = k.lane(asset, "x");
                        p.Loop(p.sub(k.toI32(k.lane(asset, "y")), p.constant(int32_t{1})), [&](ExprId step) {
                            const ExprId i = p.add(step, p.constant(int32_t{1}));
                            const ExprId row = p.add(first, k.toF32(i));
                            const ExprId candidate = p.loadStorage(levels, k.toU32(row));
                            const shader::VarId threshold = p.var(Type::f32(), k.lane(candidate, "x"));
                            p.If(p.less(half, k.lane(candidate, "w")), [&] {
                                const ExprId previous =
                                    k.lane(p.loadStorage(levels, k.toU32(p.sub(row, p.constant(1.0f)))), "x");
                                const ExprId floor =
                                    p.add(previous, p.mul(p.call("abs", {previous}), p.constant(kGateStep)));
                                p.assign(threshold, p.call("max", {floor, p.mul(k.lane(candidate, "x"), scale)}));
                            });
                            // The last level past its gate that has keys: `drawableLevel`, in one pass.
                            p.If(p.less(p.load(threshold), lodDistance), [&] {
                                p.If(p.less(half, k.lane(candidate, "z")), [&] { p.assign(level, i); });
                            });
                        });
                        ExprId chosen = k.toF32(p.load(level));
                        if (shadow) {
                            // `drawableLevel(max(selected, min(base, last)))`: a base naming a level
                            // with no keys walks down to the last one that has keys, as the oracle
                            // does. The TS shadow kernel skips this walk and draws nothing there.
                            const ExprId base = p.call("min", {k.lane(eye, "w"), p.sub(k.lane(asset, "y"), p.constant(1.0f))});
                            const ExprId top = k.toI32(p.call("max", {chosen, base}));
                            const shader::VarId drawable = p.var(Type::i32(), p.constant(int32_t{0}));
                            const shader::VarId found = p.var(Type::boolean(), p.constant(false));
                            p.Loop(top, [&](ExprId step) {
                                const ExprId candidate = p.sub(top, step);
                                const ExprId parts = k.lane(p.loadStorage(levels, k.toU32(p.add(first, k.toF32(candidate)))), "z");
                                k.unless(p.load(found), [&] {
                                    p.If(p.less(half, parts), [&] {
                                        p.assign(drawable, candidate);
                                        p.assign(found, p.constant(true));
                                    });
                                });
                            });
                            chosen = k.toF32(p.load(drawable));
                        }
                        const ExprId at = p.loadStorage(levels, k.toU32(p.add(first, chosen)));
                        const ExprId matrix = p.loadStorage(matrices, id);
                        p.Loop(k.toI32(k.lane(at, "z")), [&](ExprId part) {
                            const ExprId keyIndex = k.toU32(p.add(k.lane(at, "y"), k.toF32(part)));
                            const ExprId key = p.loadStorage(keys, keyIndex);
                            const ExprId word =
                                p.add(p.mul(k.toU32(k.lane(key, "z")), k.u32(kGpuSceneDrawArgsWords)), k.u32(1));
                            const ExprId taken = p.atomicAdd(args, word, k.u32(1));
                            p.If(p.less(k.toF32(taken), k.lane(key, "y")), [&] {
                                p.store(drawn, p.add(k.toU32(k.lane(key, "x")), taken),
                                        p.mul(matrix, p.loadStorage(locals, keyIndex)));
                            });
                        });
                    });
                });
            });
        });
    });
    return std::move(k.p);
}

} // namespace tn::engine::world
