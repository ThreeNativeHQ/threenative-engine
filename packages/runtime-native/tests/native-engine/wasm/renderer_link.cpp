// PRD-532 phase 1: the renderer links against the browser's WebGPU (emdawnwebgpu). Taking the
// address of its entry points pulls every renderer object file, and with them every wgpu* call they
// make, into the link, so a call the browser port lacks fails here rather than in a page.
#include "engine/renderer/render_database.h"
#include "engine/renderer/renderer.h"
#include "engine/scene/texture.h"

#include <cstdio>
#include "../check.h"

int main() {
    using namespace tn::engine;
    namespace g = shader::graph;
    Scene scene; PerspectiveCamera camera(60, 2, 0.1, 10);
    RenderDatabase database; LightState lights;
    auto sun = g::uniform("sun", shader::Type::f32(), {0.125});
    scene.backgroundNode = g::vec3({sun, g::float_(0.25), g::float_(0.5)});
    scene.backgroundIntensity = 2;
    auto draws = database.prepare(scene, camera, lights);
    CHECK(draws.size() == 1);
    if (draws.size() != 1) return 1;
    CHECK(draws[0].background && !draws[0].map && !draws[0].depthWrite);
    CHECK(draws[0].nodes->colorNode == scene.backgroundNode);
    CHECK(draws[0].material->color[0] == 2);
    sun->values[0] = 0.25;
    draws = database.prepare(scene, camera, lights);
    CHECK(shader::graph::uniformList(draws[0].nodes->colorNode)[0]->values[0] == 0.25);
    Scene copy; copy.copy(scene); CHECK(copy.backgroundNode == scene.backgroundNode);
    auto texture = std::make_shared<DataTexture>();
    scene.backgroundTexture = texture; // the node takes precedence, even over an unsupported texture background
    scene.backgroundNode = g::objectTexture(texture, "sky", g::uv());
    draws = database.prepare(scene, camera, lights);
    CHECK(draws.size() == 1 && !draws[0].map && draws[0].uvs);
    CHECK(draws[0].nodeTextures && draws[0].nodeTextures->at(0).second == texture.get());
    scene.backgroundTexture.reset();
    scene.backgroundNode.reset();
    CHECK(database.prepare(scene, camera, lights).empty());

    auto construct = [](WGPUInstance instance, WGPUDevice device, WGPUQueue queue, tn::engine::EventQueue& events) {
        return tn::engine::Renderer(instance, device, queue, events);
    };
    const bool linked = &tn::engine::RenderDatabase::render != nullptr && construct != nullptr;
    std::puts(linked ? "TN_WASM_RENDERER_LINKED" : "TN_WASM_RENDERER_MISSING");
    return linked && tn_check_failures == 0 ? 0 : 1;
}
