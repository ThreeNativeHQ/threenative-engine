// The WebGPU bindings must reject malformed creation input at the API call that caused it.
//
// This drives the bindings through the native Runtime with no SDL window. Before the repair,
// createSampler/createBindGroup previously allowed invalid native state to escape as a wrapper,
// leaving the failure to surface later when a queue submission dereferenced it.

#include "mystral/runtime.h"

#include <iostream>

namespace {

constexpr const char* kScript = R"JS((() => {
  const expectCreationFailure = (name, expected, create) => {
    try {
      create();
    } catch (error) {
      const message = String(error && error.message ? error.message : error);
      if (!message.includes(expected))
        throw new Error(name + " threw '" + message + "' instead of '" + expected + "'");
      return;
    }
    throw new Error(name + " did not throw at creation");
  };

  const adapter = navigator.gpu.requestAdapter();
  const device = adapter.requestDevice();

  // device.lost must stay pending while the device lives. A settled promise tells every consumer
  // (three's renderer, bounded texture preparation) that the device is already gone.
  globalThis.__tnDeviceLostSettled = false;
  device.lost.then(() => {
    globalThis.__tnDeviceLostSettled = true;
  });

  const wideLodSampler = device.createSampler({
    lodMinClamp: 0,
    lodMaxClamp: 32,
    magFilter: "nearest",
    minFilter: "linear",
    mipmapFilter: "nearest",
  });
  if (!wideLodSampler) throw new Error("wide-LOD sampler compatibility returned no sampler");

  // Reject an inverted LOD range at the binding boundary instead of returning an invalid sampler.
  expectCreationFailure("createSampler", "Failed to create sampler", () =>
    device.createSampler({ lodMinClamp: 2, lodMaxClamp: 1 }),
  );

  // Reject an object without a native bind-group-layout handle before calling the device.
  expectCreationFailure("createBindGroup", "Failed to create bind group", () =>
    device.createBindGroup({ layout: {}, entries: [] }),
  );

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

    if (!runtime->evalScript(kScript, "bindings_creation_test.js")) {
        std::cerr << "native WebGPU creation bindings failed";
        if (runtime->getExitCode() != 0) std::cerr << " (exit " << runtime->getExitCode() << ")";
        std::cerr << '\n';
        return 1;
    }

    // Microtasks have run since the first script: an already-settled device.lost has fired.
    if (!runtime->evalScript(
            "if (globalThis.__tnDeviceLostSettled) throw new Error('device.lost settled without a device loss');",
            "bindings_device_lost_test.js")) {
        std::cerr << "native device.lost settled with a live device\n";
        return 1;
    }

    std::cout << "proof: creation-refusal\n";
    return 0;
}
