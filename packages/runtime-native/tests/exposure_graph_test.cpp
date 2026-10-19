// Runs the generated Three.js reduction/adaptation shaders and applied output without SDL.
#include "mystral/runtime.h"
#include "../src/webgpu/bindings_state.h"
#include <chrono>
#include <fstream>
#include <iostream>
#include <iterator>
#include <thread>

int main(int argc, char** argv) {
    const bool injectValidation = argc == 2 && std::string(argv[1]) == "--inject-validation";
    mystral::RuntimeConfig config;
    config.width = 65;
    config.height = 33;
    config.noSdl = true;
    auto runtime = mystral::Runtime::create(config);
    if (!runtime) return 1;
    std::ifstream input(TN_EXPOSURE_GRAPH_BUNDLE);
    if (!input) { std::cerr << "exposure graph bundle missing\n"; return 1; }
    const std::string source((std::istreambuf_iterator<char>(input)), {});
    if (injectValidation && !runtime->evalScript("globalThis.__tnInjectValidation = true;", "inject.js")) return 1;
    if (!runtime->evalScript(source, "exposure_graph.js")) return 1;
    auto* state = static_cast<mystral::webgpu::BindingsState*>(runtime->getWebGPUBindingsState());
    if (!state) return 1;
    auto* engine = state->engine;
    for (int frame = 0; frame < 30000; ++frame) {
        if (!runtime->pollEvents()) break;
        const auto error = engine->getGlobalProperty("__tnExposureError");
        if (!engine->isUndefined(error)) {
            const auto message = engine->toString(error);
            if (injectValidation && message.find("GPU validation:") != std::string::npos) {
                std::cout << "native exposure validation negative control passed\n"; return 0;
            }
            std::cerr << message << '\n'; return 1;
        }
        if (engine->toBoolean(engine->getGlobalProperty("__tnExposureDone"))) {
            if (injectValidation) { std::cerr << "GPU validation was ignored\n"; return 1; }
            std::cout << "native exposure graph contract passed\n"; return 0;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    std::cerr << "native exposure graph timed out\n";
    return 1;
}
