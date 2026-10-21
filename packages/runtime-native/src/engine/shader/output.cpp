#include "output.h"

namespace tn::engine::shader {

ExprId srgbTransferOetf(Program& p, ExprId linear) {
    const ExprId a = p.sub(p.mul(p.call("pow", {linear, p.construct(Type::vec(3), {p.constant(1 / 2.4f)})}), p.constant(1.055f)),
                           p.constant(0.055f));
    const ExprId b = p.mul(linear, p.constant(12.92f));
    const ExprId le = p.call("step", {linear, p.construct(Type::vec(3), {p.constant(0.0031308f)})});  // 1 where linear <= cutoff
    return p.call("mix", {a, b, le});
}

ExprId renderOutput(Program& p, ExprId scene, std::optional<ToneMapping> toneMapping, bool srgb) {
    // RenderOutputNode: unpremultiply before nonlinear transforms, then premultiply in output space.
    const ExprId alpha = p.call("clamp", {p.swizzle(scene, "w"), p.constant(0.0f), p.constant(1.0f)});
    ExprId rgb = p.select(p.equal(alpha, p.constant(0.0f)), p.construct(Type::vec(3), {p.constant(0.0f)}),
                         p.div(p.swizzle(scene, "xyz"), alpha));
    if (toneMapping) rgb = toneMap(p, *toneMapping, rgb, p.uniform("toneMappingExposure", Type::f32()));
    if (srgb) rgb = srgbTransferOetf(p, rgb);
    return p.construct(Type::vec(4), {p.mul(rgb, alpha), alpha});
}

OutputPrograms buildOutput(std::optional<ToneMapping> toneMapping, bool srgb, const PostNode* post) {
    return buildOutput(toneMapping, srgb, post, true);
}

OutputPrograms buildOutput(std::optional<ToneMapping> toneMapping, bool srgb, const PostNode* post, bool outputTransform) {
    OutputPrograms out;
    Program& v = out.vertex;
    const ExprId position = v.attribute("position", Type::vec(2));
    v.output("position", v.construct(Type::vec(4), {position, v.constant(0.0f), v.constant(1.0f)}));
    // Clip space to texture space: y flips, as a WebGPU texture's first row is the top.
    v.output("uv", v.construct(Type::vec(2), {v.add(v.mul(v.swizzle(position, "x"), v.constant(0.5f)), v.constant(0.5f)),
                                              v.sub(v.constant(0.5f), v.mul(v.swizzle(position, "y"), v.constant(0.5f)))}));

    Program& f = out.fragment;
    const uint32_t texture = f.texture2d("scene");
    const ExprId uv = f.varying("uv", Type::vec(2));
    const ExprId scene = post ? post->build(f, texture, uv) : f.sample(texture, uv);
    // `depth` and linearDepth() in a post graph read positionView; this pass draws a screen quad, so its own
    // position is the view position (PRD-617: rain's post shader names depth for a gl_FragCoord.z it never reads).
    for (const auto& [name, type] : f.varyings())
        if (name == "positionView" && !v.hasOutput(name)) v.output(name, v.construct(Type::vec(3), {position, v.constant(0.0f)}));
    if (!outputTransform || (post && !post->outputTransform)) { f.output("color", scene); return out; }
    f.output("color", renderOutput(f, scene, toneMapping, srgb));
    return out;
}

}  // namespace tn::engine::shader
