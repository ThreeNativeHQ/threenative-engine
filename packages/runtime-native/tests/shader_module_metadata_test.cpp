#include "../src/webgpu/bindings_state.h"

#include <cstdlib>
#include <iostream>
#include <unordered_map>

namespace {

std::unordered_map<WGPUShaderModule, size_t> releaseCounts;

void recordRelease(WGPUShaderModule module) {
    releaseCounts[module] += 1;
}

}  // namespace

int main() {
    auto store = std::make_shared<mystral::webgpu::ShaderModuleMetadataStore>();
    std::weak_ptr<mystral::webgpu::ShaderModuleMetadataStore> weakStore = store;
    const auto first = reinterpret_cast<WGPUShaderModule>(static_cast<uintptr_t>(1));
    const auto second = reinterpret_cast<WGPUShaderModule>(static_cast<uintptr_t>(2));
    // Match two createShaderModule calls that Dawn canonicalizes to one native handle.
    store->acquire(first, {"vertexFirst", "fragmentFirst"});
    store->acquire(first, {"vertexFirst", "fragmentFirst"});
    store->acquire(second, {"vertexSecond", "fragmentSecond"});
    store->acquire(second, {"vertexSecond", "fragmentSecond"});

    if (!store->release(first, &recordRelease) ||
        store->entries.find(first) == store->entries.end() ||
        !store->release(first, &recordRelease) ||
        store->entries.find(first) != store->entries.end() ||
        store->release(first, &recordRelease) ||
        store->entries.size() != 1 ||
        releaseCounts != std::unordered_map<WGPUShaderModule, size_t>{{first, 2}}) {
        std::cerr << "shader-module-metadata: wrapper release contract failed" << std::endl;
        return EXIT_FAILURE;
    }

    store->releaseAll(&recordRelease);
    if (!store->entries.empty() ||
        releaseCounts != std::unordered_map<WGPUShaderModule, size_t>{{first, 2}, {second, 2}}) {
        std::cerr << "shader-module-metadata: teardown release contract failed" << std::endl;
        return EXIT_FAILURE;
    }

    store.reset();
    if (!weakStore.expired()) {
        std::cerr << "shader-module-metadata: store outlived its binding state" << std::endl;
        return EXIT_FAILURE;
    }

    std::cout << "shader-module-metadata: wrapper=erase+release-once "
                 "duplicate-wrapper-refs=release-each teardown=release-survivors"
              << std::endl;
    return EXIT_SUCCESS;
}
