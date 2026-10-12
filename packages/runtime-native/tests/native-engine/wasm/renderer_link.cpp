// PRD-532 phase 1: the renderer links against the browser's WebGPU (emdawnwebgpu). Taking the
// address of its entry points pulls every renderer object file, and with them every wgpu* call they
// make, into the link, so a call the browser port lacks fails here rather than in a page.
#include "engine/renderer/render_database.h"
#include "engine/renderer/renderer.h"

#include <cstdio>

int main() {
    auto construct = [](WGPUInstance instance, WGPUDevice device, WGPUQueue queue, tn::engine::EventQueue& events) {
        return tn::engine::Renderer(instance, device, queue, events);
    };
    const bool linked = &tn::engine::RenderDatabase::render != nullptr && construct != nullptr;
    std::puts(linked ? "TN_WASM_RENDERER_LINKED" : "TN_WASM_RENDERER_MISSING");
    return linked ? 0 : 1;
}
