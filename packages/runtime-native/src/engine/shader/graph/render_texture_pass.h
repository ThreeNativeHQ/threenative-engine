#pragma once
#include "engine/shader/graph/post_effects.h"
#include "engine/shader/output.h"
#include "engine/shader/tsl/tsl.h"
#include "engine/scene/material.h"

namespace tn::engine::shader::graph {
inline PostPass renderTexturePass(Node node, std::optional<ToneMapping> toneMapping = std::nullopt, bool srgb = false) {
    PostPass pass; pass.output = node->name; pass.resolutionScale = node->scale;
    pass.floorSize = true; pass.autoUpdate = node->bits != 1;
    pass.width = node->width; pass.height = node->height; pass.package.name = node->name;
    const auto material = node->rtt ? node->rtt->material : nullptr;
    if (material)
        pass.visible = material->visible;
    const auto source = material && material->nodes.fragmentNode ? material->nodes.fragmentNode : node->args[0];
    const PostNode post{key(source), [source, toneMapping, srgb](Program& p, uint32_t, ExprId coordinate) {
                            tsl::Build scope(p);
                            return lower(source, p, {{"uv", coordinate}}, toneMapping, srgb);
                        }};
    if (node->rtt) {
        pass.rtt = node->rtt;
        pass.width = node->rtt->width; pass.height = node->rtt->height;
        pass.resolutionScale = node->rtt->scale; pass.autoUpdate = node->rtt->autoUpdate;
    }
    // Intermediate RTTs render the shader value verbatim, before RenderOutput transforms.
    auto programs = buildOutput(std::nullopt, false, &post, false);
    const auto vertexNode = material && material->nodes.vertexNode ? material->nodes.vertexNode
                            : !node->otherwise.empty()             ? node->otherwise[0]
                                                                   : nullptr;
    const auto positionNode = material ? material->nodes.positionNode : nullptr;
    if (vertexNode || positionNode) {
        auto& vertex = programs.vertex;
        const auto position = vertex.attribute("position", Type::vec(2));
        auto local = vertex.construct(Type::vec(3), {position, vertex.constant(0.0f)});
        tsl::Build scope(vertex);
        if (positionNode)
            local = lower(positionNode, vertex, {{"position", local}, {"positionLocal", local}});
        const auto clip =
            vertexNode
                ? lower(vertexNode, vertex, {{"position", local}, {"positionLocal", local}})
                : vertex.construct(Type::vec(4), {vertex.swizzle(local, "xy"), vertex.neg(vertex.swizzle(local, "z")),
                                                  vertex.constant(1.0f)});
        vertex.output("position", clip);
        // An authored geometry UV is bottom-up; ScreenNode.uv remains WebGPU top-down.
        if (!material)
            vertex.output("uv", vertex.add(vertex.mul(position, vertex.constant(0.5f)), vertex.constant(0.5f)));
        // `depth` and linearDepth() read positionView, which the quad's identity camera makes its own local
        // position (PRD-617: rain's post shader names depth for a gl_FragCoord.z it never reads).
        for (const auto& [name, type] : programs.fragment.varyings())
            if (name == "positionView" && !vertex.hasOutput(name)) vertex.output(name, local);
    }
    for (const Program* p : {&programs.vertex, &programs.fragment})
        for (const auto& d : p->diagnostics()) pass.package.errors.push_back(d.code + ": " + d.node + ": " + d.reason);
    auto fragment = buildStage(programs.fragment);
    for (const auto& binding : fragment.bindings)
        if (binding.kind == BindingKind::Texture) pass.reads[binding.name.substr(2)] = binding.name.substr(2);
    pass.uniforms = uniforms(source);
    pass.live = uniformNodes(source);
    auto vertex = buildStage(programs.vertex, 1);
    for (const auto& binding : vertex.bindings)
        if (binding.kind == BindingKind::Texture)
            pass.reads[binding.name.substr(2)] = binding.name.substr(2);
    for (const auto& root : {positionNode, vertexNode})
        if (root) {
            const auto initial = uniforms(root);
            pass.uniforms.insert(initial.begin(), initial.end());
            const auto live = uniformNodes(root);
            pass.live.insert(pass.live.end(), live.begin(), live.end());
        }
    pass.package.variants.push_back({0, {std::move(vertex), std::move(fragment)}});
    return pass;
}
} // namespace tn::engine::shader::graph
