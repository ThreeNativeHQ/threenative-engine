#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <string>
#include <string_view>
#include <array>
#include <vector>
#include "engine/shader/graph/graph.h"
#include "engine/shader/graph/post_effects.h"

namespace tn::engine::shader {

class Program;

/**
 * A material's MRT output (three's mrt()): the colour node written to the target named `name`, a scene pass's custom
 * target or a render target's texture. The scene pass draws its own output, depth, velocity, normal and surface targets,
 * so a slot under one of those names writes only a render target's texture of that name (render_database resolveMrt).
 */
struct MrtOutput {
    std::string name;
    graph::Node node;
    bool operator==(const MrtOutput&) const = default;
};

/** One graph root per MaterialNodes::pointers(), for the arrays that hold them (the draw's source cache). */
inline constexpr std::size_t kMaterialGraphRoots = 19;

/** NodeMaterial slots; null nodes use the non-node material path. */
struct MaterialNodes {
    graph::Node colorNode, positionNode, normalNode, emissiveNode, roughnessNode, metalnessNode, opacityNode;
    /** NodeMaterial.aoNode: ambient occlusion (float) that darkens indirect light only. */
    graph::Node aoNode;
    /** The scene environment's diffuse term, replaced: cosine-weighted irradiance (E / pi, in the units of the PMREM level-1 sample) for the surface's own normalWorld. */
    graph::Node irradianceNode;
    /** NodeMaterial.envNode: the environment's radiance itself (vec3), replacing the environment map's sample. Its
     *  irradiance is this radiance times pi, as EnvironmentNode.setup reads a plain env node; with no env map the
     *  node is the material's whole indirect light (the Strata ocean's sky reflection). */
    graph::Node envNode;
    /** NodeMaterial.vertexNode: the clip-space position itself, replacing model-view-projection. */
    graph::Node vertexNode, fragmentNode;
    /** NodeMaterial.depthNode: the fragment's depth (frag_depth), replacing the rasterised one. */
    graph::Node depthNode;
    /** NodeMaterial.castShadowPositionNode: the local position the shadow depth pass casts from, in place of
     *  positionNode. A bare positionLocal casts the rest pose, so a cached shadow page holds what any later
     *  refresh draws again: a swaying tree's shadow cannot snap when its page re-renders. */
    graph::Node castShadowPositionNode;
    /** NodeMaterial.maskNode: a bool; a colour-pass fragment where it is false is discarded before its colour is read
     *  (three's setupDiffuseColor). The shadow depth pass masks with it only when no maskShadowNode is set. */
    graph::Node maskNode;
    /** NodeMaterial.maskShadowNode: a bool; a shadow-depth fragment where it is false is discarded. three r187's
     *  shadow pass masks with `maskShadowNode || maskNode` (Renderer._getShadowNodes): an impostor's quad casts only
     *  its baked coverage through it, and without it each quad cast a solid square. */
    graph::Node maskShadowNode;
    /** NodeMaterial.alphaTestNode: a float that replaces material.alphaTest as the cutoff, in the colour pass and the
     *  shadow depth pass (three's setupDiffuseColor and shadow override). A set node tests even when alphaTest is 0. */
    graph::Node alphaTestNode;
    /** SpriteNodeMaterial.scaleNode (a vec2 beside the model scale) and rotationNode (radians, over the material's). */
    graph::Node scaleNode, rotationNode;
    /** NodeMaterial.mrtNode's custom slots, in author order (three's mrt() takes any name and node). The named
     *  engine targets (normal, metalness, roughness, diffuseColor, emissive) keep their own fast paths, not here. */
    std::vector<MrtOutput> mrt;
    /** The scene's `fogNode`, a vec4(color, factor) mixed into the finished colour; set on draw items, never on a material. */
    graph::Node fogNode;
    /** NodeMaterial.lightsNode: a `lights([...])` of the only lights the material sums (three's LightsNode). Not a
     *  graph: its args hold the light objects, so it stays out of graphs() and the renderer keys the program on it. */
    graph::Node lightsNode;
    bool operator==(const MaterialNodes&) const = default;
    /** The material's own slots: the draw item's `fogNode` is the scene's, so no material owns it. */
    auto pointers() const {
        return std::array{colorNode.get(),    positionNode.get(),  normalNode.get(),
                          emissiveNode.get(), roughnessNode.get(), metalnessNode.get(),
                          opacityNode.get(),  vertexNode.get(),    fragmentNode.get(),
                          scaleNode.get(),    rotationNode.get(),  depthNode.get(),
                          aoNode.get(),       irradianceNode.get(), castShadowPositionNode.get(),
                          maskNode.get(),     envNode.get(),
                          alphaTestNode.get(), maskShadowNode.get()};
    }
    auto graphs() const {
        return std::array{colorNode,     positionNode, normalNode, emissiveNode, roughnessNode,
                          metalnessNode, opacityNode,  vertexNode, fragmentNode,
                          scaleNode,     rotationNode, depthNode,
                          aoNode,        irradianceNode, fogNode, castShadowPositionNode,
                          maskNode,      envNode,
                          alphaTestNode, maskShadowNode};
    }
    /** Every graph a material owns: the fixed slots, then the custom MRT slots, in one walk. */
    template <typename Fn>
    void forEachGraph(Fn&& visit) const {
        for (const auto& node : graphs()) visit(node);
        for (const auto& slot : mrt) visit(slot.node);
    }
    /** The position graph a shadow depth pass casts from: castShadowPositionNode when set (none for a bare
     *  positionLocal, the rest pose), else positionNode, as three's shadow pass assigns it. */
    graph::Node shadowPositionNode() const {
        if (!castShadowPositionNode) return positionNode;
        return castShadowPositionNode->kind == graph::Kind::PositionLocal ? graph::Node{} : castShadowPositionNode;
    }
    std::string key() const {
        std::string out;
        for (const auto& node : graphs()) {
            // An empty slot is most slots on most frames: graph::key(null) is "null;", without its
            // hash map, std::function and string.
            if (!node) { out += "5:null;"; continue; }
            out += "#" + std::to_string(graph::keyId(node)) + ";";  // the structure, interned
        }
        // A custom MRT slot's name is part of the key: a program built for one slot name writes that name's target.
        for (const auto& slot : mrt) {
            out += "m" + std::to_string(slot.name.size()) + ":" + slot.name + ":";
            out += slot.node ? "#" + std::to_string(graph::keyId(slot.node)) + ";" : "5:null;";
        }
        return out;
    }
    /** key() with tsl_call's serial names numbered by first use across the slots (graph::canonicalKey): equal for two
     *  materials one TSL function made, whose programs differ only in those names. Built once per program miss. */
    std::string canonicalKey(std::vector<std::string>& serials) const {
        std::string out;
        for (const auto& node : graphs()) out += node ? "{" + graph::canonicalKey(node, serials) + "};" : "5:null;";
        for (const auto& slot : mrt)
            out += "{" + std::to_string(slot.name.size()) + ":" + slot.name + ":" +
                   (slot.node ? graph::canonicalKey(slot.node, serials) : "null") + "};";
        return out;
    }
};

/**
 * A material's `positionNode` (three's NodeMaterial.positionNode): a TSL graph, authored with the
 * native builder (engine/shader/tsl/tsl.h), that replaces the vertex's local position after
 * morphing, skinning and instancing, as setupPosition assigns it last. `build` receives the vertex
 * program and that position (vec3) and returns the new one (vec3). Storage buffers it declares are
 * bound by name from Renderer::setStorage. `key` names the graph: two nodes with one key must build
 * the same program, which is how programs are cached.
 */
struct PositionNode {
    std::string key;
    std::function<uint32_t(Program& vertex, uint32_t positionLocal)> build;
};

/**
 * A post pass (three's RenderPipeline.outputNode over `pass(scene, camera)`): a TSL graph over the
 * scene's linear colour, applied before the output transform (tone mapping, colour space), as
 * RenderPipeline's outputColorTransform does. `build` receives the fragment program, the scene
 * texture (declared as texture "scene") and the screen uv (vec2), and returns the linear vec4.
 */
struct PostNode {
    std::string key;
    std::function<uint32_t(Program& fragment, uint32_t sceneTexture, uint32_t screenUv)> build;
    std::vector<graph::PostPass> passes;
    std::map<std::string, std::vector<double>> uniforms;
    /** The graph's uniform nodes, read each frame over `uniforms` (three's `uniform.value = x`). */
    std::vector<graph::Node> live;
    bool outputTransform = true;
};

}  // namespace tn::engine::shader
