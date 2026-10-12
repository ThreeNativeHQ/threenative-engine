#pragma once

// The shader corpus (PRD-510/511): one graph per stage shape the engine must emit.
#include "engine/shader/ir.h"
#include "engine/shader/tonemap.h"

#include <utility>
#include <vector>

namespace tn::engine::shader::corpus {

// Compute: storage read/write, a loop with an index, a branch and ordered reads.
inline Program particles() {
    Program p(Stage::Compute);
    const uint32_t positions = p.storageBuffer("positions", Type::vec(4));
    const ExprId id = p.swizzle(p.builtin("globalInvocationId"), "x");
    const VarId accum = p.var(Type::vec(4), p.loadStorage(positions, id));
    const ExprId dt = p.uniform("dt", Type::f32());
    p.Loop(p.constant(4), [&](ExprId) {
        p.assign(accum, p.add(p.load(accum), p.mul(p.construct(Type::vec(4), {p.constant(0.0f), dt, p.constant(0.0f), p.constant(0.0f)}), p.constant(0.25f))));
    });
    p.If(p.less(p.swizzle(p.load(accum), "y"), p.constant(10.0f)), [&] {
        p.store(positions, id, p.load(accum));
    }, [&] {
        p.store(positions, id, p.construct(Type::vec(4), {p.constant(0.0f)}));
    });
    return p;
}

// Vertex: attributes, a model-view-projection uniform, a position and a varying.
inline Program lit_vertex() {
    Program p(Stage::Vertex);
    const ExprId position = p.attribute("position", Type::vec(3));
    const ExprId normal = p.attribute("normal", Type::vec(3));
    const ExprId mvp = p.uniform("modelViewProjection", Type::mat(4, 4));
    p.output("position", p.mul(mvp, p.construct(Type::vec(4), {position, p.constant(1.0f)})));
    p.output("normal", p.call("normalize", {normal}));
    return p;
}

// Fragment: a uniform colour, a lambert term with mix and clamp, a cutout discard.
inline Program lit_fragment() {
    Program p(Stage::Fragment);
    const ExprId color = p.uniform("color", Type::vec(4));
    const ExprId light = p.uniform("lightDirection", Type::vec(3));
    const ExprId cutoff = p.uniform("alphaTest", Type::f32());
    const ExprId lambert = p.call("clamp", {p.call("dot", {light, p.uniform("normalHint", Type::vec(3))}), p.constant(0.0f), p.constant(1.0f)});
    p.If(p.less(p.swizzle(color, "a"), cutoff), [&] { p.discard(); });
    const ExprId rgb = p.call("mix", {p.mul(p.swizzle(color, "rgb"), p.constant(0.1f)), p.swizzle(color, "rgb"), lambert});
    // TSL's clamp(vec, 0, 1) has scalar bounds; WGSL's clamp has none, so the emitter splats them.
    const ExprId clamped = p.call("clamp", {rgb, p.constant(0.0f), p.constant(1.0f)});
    p.output("color", p.construct(Type::vec(4), {clamped, p.swizzle(color, "a")}));
    return p;
}

// Fragment: one catalogued tonemapping operator over an HDR varying.
template <ToneMapping M>
Program tonemapped() {
    Program p(Stage::Fragment);
    const ExprId hdr = p.swizzle(p.varying("hdr", Type::vec(4)), "rgb");
    const ExprId mapped = toneMap(p, M, hdr, p.uniform("toneMappingExposure", Type::f32()));
    p.output("color", p.construct(Type::vec(4), {mapped, p.constant(1.0f)}));
    return p;
}

inline std::vector<std::pair<const char*, Program (*)()>> all() {
    return {{"particles", particles},
            {"lit_vertex", lit_vertex},
            {"lit_fragment", lit_fragment},
            {"tonemap_linear", tonemapped<ToneMapping::Linear>},
            {"tonemap_reinhard", tonemapped<ToneMapping::Reinhard>},
            {"tonemap_cineon", tonemapped<ToneMapping::Cineon>},
            {"tonemap_aces", tonemapped<ToneMapping::ACESFilmic>},
            {"tonemap_agx", tonemapped<ToneMapping::AgX>},
            {"tonemap_neutral", tonemapped<ToneMapping::Neutral>}};
}

}  // namespace tn::engine::shader::corpus
