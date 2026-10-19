// Generates reference.tnpk with the C++ reference writer, so native-package.spec.ts can prove the
// TypeScript emitter is byte-identical to what the native engine's tests use. Rebuild from the
// repository root with:
//
//   c++ -std=c++20 -I packages/runtime-native/src -I packages/runtime-native/tests/native-engine \
//     packages/assets/__tests__/fixtures/package_writer_fixture.cpp \
//     packages/runtime-native/src/engine/assets/sha256.cpp -o /tmp/tnpk-fixture
//   /tmp/tnpk-fixture > packages/assets/__tests__/fixtures/reference.tnpk
//
// The texture header carries 18, WGPUTextureFormat_RGBA8Unorm on the wgpu-native product backend.
#include <cstdio>
#include <vector>

#include "package_writer.h"

using tn::test::EntrySpec;
using tn::test::writePackage;

int main() {
    std::vector<uint8_t> geometry(16);
    for (size_t i = 0; i < geometry.size(); ++i) geometry[i] = static_cast<uint8_t>(i);

    std::vector<uint8_t> texture;
    tn::test::put(texture, 2, 4);   // width
    tn::test::put(texture, 2, 4);   // height
    tn::test::put(texture, 18, 4);  // WGPUTextureFormat_RGBA8Unorm (wgpu-native)
    for (int i = 0; i < 2 * 2 * 4; ++i) texture.push_back(static_cast<uint8_t>(255 - i));

    const std::vector<EntrySpec> entries = {
        {"geometry/positions", 1, 0, geometry, 16, {}},
        {"scenes/main", 6, 0, {1, 2, 3, 4}, 0, {0, 2}},
        {"textures/albedo", 2, 0, texture, 16, {0}},
    };
    const auto package = writePackage(entries);
    std::fwrite(package.data(), 1, package.size(), stdout);
    return 0;
}
