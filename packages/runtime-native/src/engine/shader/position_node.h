#pragma once

#include <cstdint>
#include <functional>
#include <string>
#include <array>
#include "engine/shader/graph/graph.h"
#include "engine/shader/graph/post_effects.h"

namespace tn::engine::shader {

class Program;

/** NodeMaterial slots; null nodes use the non-node material path. */
struct MaterialNodes {
    graph::Node colorNode, positionNode, normalNode, emissiveNode, roughnessNode, metalnessNode, opacityNode;
    /** NodeMaterial.vertexNode: the clip-space position itself, replacing model-view-projection. */
    graph::Node vertexNode;
    bool operator==(const MaterialNodes&) const = default;
    auto pointers() const { return std::array{colorNode.get(), positionNode.get(), normalNode.get(), emissiveNode.get(),
                                           roughnessNode.get(), metalnessNode.get(), opacityNode.get(), vertexNode.get()}; }
    auto graphs() const { return std::array{colorNode, positionNode, normalNode, emissiveNode,
                                         roughnessNode, metalnessNode, opacityNode, vertexNode}; }
    std::string key() const {
        std::string out;
        for (const auto& node : graphs()) {
            // An empty slot is most slots on most frames: graph::key(null) is "null;", without its
            // hash map, std::function and string.
            if (!node) { out += "5:null;"; continue; }
            out += "#" + std::to_string(graph::keyId(node)) + ";";  // the structure, interned
        }
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
    std::map<std::string, std::vector<float>> uniforms;
    /** The graph's uniform nodes, read each frame over `uniforms` (three's `uniform.value = x`). */
    std::vector<graph::Node> live;
};

}  // namespace tn::engine::shader
