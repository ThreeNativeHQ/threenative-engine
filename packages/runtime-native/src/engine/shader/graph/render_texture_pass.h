#pragma once
#include "engine/shader/graph/post_effects.h"
#include "engine/shader/output.h"
#include "engine/shader/tsl/tsl.h"

namespace tn::engine::shader::graph {
inline PostPass renderTexturePass(Node node) {
    PostPass pass; pass.output = node->name; pass.resolutionScale = node->scale;
    pass.floorSize = true; pass.autoUpdate = node->bits != 1;
    pass.width = node->width; pass.height = node->height; pass.package.name = node->name;
    const PostNode post{key(node->args[0]), [node](Program& p, uint32_t, ExprId coordinate) {
        tsl::Build scope(p); return lower(node->args[0], p, {{"uv", coordinate}});
    }};
    // Intermediate RTTs render the shader value verbatim, before RenderOutput transforms.
    auto programs = buildOutput(std::nullopt, false, &post, false);
    if (!node->otherwise.empty()) {
        auto& vertex = programs.vertex;
        const auto position = vertex.attribute("position", Type::vec(2));
        const auto local = vertex.construct(Type::vec(3), {position, vertex.constant(0.0f)});
        tsl::Build scope(vertex);
        vertex.output("position", lower(node->otherwise[0], vertex, {{"position", local}}));
        // An authored geometry UV is bottom-up; ScreenNode.uv remains WebGPU top-down.
        vertex.output("uv", vertex.add(vertex.mul(position, vertex.constant(0.5f)), vertex.constant(0.5f)));
    }
    for (const Program* p : {&programs.vertex, &programs.fragment})
        for (const auto& d : p->diagnostics()) pass.package.errors.push_back(d.code + ": " + d.node + ": " + d.reason);
    auto fragment = buildStage(programs.fragment);
    for (const auto& binding : fragment.bindings)
        if (binding.kind == BindingKind::Texture) pass.reads[binding.name.substr(2)] = binding.name.substr(2);
    pass.uniforms = uniforms(node->args[0]);
    pass.live = uniformNodes(node->args[0]);
    pass.package.variants.push_back({0, {buildStage(programs.vertex), std::move(fragment)}});
    return pass;
}
} // namespace tn::engine::shader::graph
