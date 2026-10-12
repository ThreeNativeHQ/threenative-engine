#include "sprite.h"
#include "engine/shader/tsl/tsl.h"
#include <stdexcept>

namespace tn::engine::shader {
StandardPrograms buildSprite(const VertexVariant& variant) {
    // Reuse the unlit material's fragment graph, texture, opacity and alpha-test paths.
    StandardPrograms out = buildBasic(variant);
    out.vertex = Program(Stage::Vertex);
    Program& v = out.vertex;
    tsl::Build build(v);
    using namespace tsl;
    const Node geometry = positionLocal();
    Node centre = vec3({0});
    if (variant.positionNode) centre = variant.positionNode->build(v, centre.id);
    if (variant.nodes.positionNode) centre = graph::lower(variant.nodes.positionNode, v, {{"positionLocal", centre.id}});
    const Node model = uniform("modelMatrix", Type::mat(4, 4));
    const Node view = uniform("viewMatrix", Type::mat(4, 4));
    const Node projection = uniform("projectionMatrix", Type::mat(4, 4));
    const Node mv = view.mul(model).mul(vec4({centre, 1}));
    Node scale = vec2({length(model.mul(vec4({1, 0, 0, 0})).xyz()), length(model.mul(vec4({0, 1, 0, 0})).xyz())});
    scale = scale.mul(select(uniform("spriteNoAttenuation", Type::f32()).greaterThan(0), mv.z().negate(), float_(1)));
    const Node aligned = geometry.xy().sub(uniform("spriteCenter", Type::vec(2)).sub(0.5)).mul(scale);
    const Node rotation = uniform("spriteRotation", Type::f32());
    const Node c = cos(rotation), s = sin(rotation);
    const Node rotated = vec2({c.mul(aligned.x()).sub(s.mul(aligned.y())), s.mul(aligned.x()).add(c.mul(aligned.y()))});
    output("position", projection.mul(vec4({mv.xy().add(rotated), mv.swizzle("zw")})));
    if (variant.fog) output("positionView", mv.xyz());
    // The basic fragment graph can read the same UV/position varyings as a sprite material.
    for (const auto& varying : out.fragment.varyings()) {
        if (varying.first == "uv") output("uv", uv());
        else if (varying.first == "positionLocal") output("positionLocal", centre);
        else throw std::runtime_error("TN_SPRITE_VARYING_UNSUPPORTED: " + varying.first);
    }
    v.linkVaryings(out.fragment);
    return out;
}
} // namespace tn::engine::shader
