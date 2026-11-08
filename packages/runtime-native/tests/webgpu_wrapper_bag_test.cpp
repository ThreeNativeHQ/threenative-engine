// C++-only WebGPU metadata must stay out of the JavaScript objects the game holds.
//
// The bindings keep shader entry points and texture identity in C++ side tables
// (`ShaderModuleMetadataStore`, `findTextureInfoByHandle`). A wrapper that carries them as
// properties leaks host state into game code and makes it enumerable, cloneable and serializable.
// This creates a shader module, a texture, a view and a render pipeline through the real bindings
// of a headless Runtime, then walks every own property and the full prototype chain of each
// wrapper for the names those fields used to have. An adapter-less machine reports a skip.

#include "mystral/runtime.h"

#include <chrono>
#include <iostream>
#include <thread>

namespace {

constexpr int kCompletionExitCode = 42;
constexpr int kNoAdapterExitCode = 43;

constexpr const char* kScript = R"JS((() => {
  let device;
  try {
    device = navigator.gpu.requestAdapter().requestDevice();
  } catch (error) {
    process.exit(43);
    return;
  }
  const module = device.createShaderModule({
    code: `
      @vertex fn vs() -> @builtin(position) vec4f { return vec4f(0.0, 0.0, 0.0, 1.0); }
      @fragment fn fs() -> @location(0) vec4f { return vec4f(1.0); }
    `,
  });
  const texture = device.createTexture({
    size: { width: 4, height: 4, depthOrArrayLayers: 1 },
    format: "rgba8unorm",
    usage: 0x10 | 0x04,
  });
  const view = device.createTextureView(texture);
  const pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module, entryPoint: "vs" },
    fragment: { module, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] },
  });
  const forbidden = new Set([
    "_tnVertexEntryPoint", "_tnFragmentEntryPoint", "_formatEnum", "_createViewTextureId",
  ]);
  const leaks = [];
  const walk = (label, object) => {
    for (let o = object; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
      for (const name of Reflect.ownKeys(o)) {
        if (forbidden.has(String(name))) leaks.push(label + "." + String(name));
      }
    }
    for (const name in object) if (forbidden.has(name)) leaks.push(label + "." + name + " (enumerable)");
  };
  walk("shaderModule", module);
  walk("texture", texture);
  walk("textureView", view);
  walk("renderPipeline", pipeline);
  if (leaks.length > 0) console.log("C++-only metadata leaked: " + leaks.join(", "));
  process.exit(leaks.length === 0 ? 42 : 1);
})())JS";

}  // namespace

int main() {
    mystral::RuntimeConfig config;
    config.width = 1;
    config.height = 1;
    config.noSdl = true;

    auto runtime = mystral::Runtime::create(config);
    if (!runtime) {
        std::cerr << "could not create headless native runtime\n";
        return 1;
    }
    if (!runtime->evalScript(kScript, "webgpu_wrapper_bag_test.js")) {
        std::cerr << "could not run the wrapper probe\n";
        return 1;
    }
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
    while (runtime->pollEvents()) {
        if (runtime->getExitCode() != 0) break;
        if (std::chrono::steady_clock::now() >= deadline) break;
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }

    const int exitCode = runtime->getExitCode();
    if (exitCode == kNoAdapterExitCode) {
        std::cout << "native webgpu wrapper bag contract skipped: no adapter\n";
        return 0;
    }
    if (exitCode != kCompletionExitCode) {
        std::cerr << "native webgpu wrapper bag contract failed with exit " << exitCode << '\n';
        return 1;
    }
    std::cout << "native webgpu wrapper bag contract passed\n";
    return 0;
}
