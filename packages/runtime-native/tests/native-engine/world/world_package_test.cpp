// PRD-521 phase 1: the native `world.json` validator reproduces packages/core/src/world-package.ts
// exactly. Every manifest and placement run is generated from that module
// (packages/runtime-native/tests/native-engine/world/world-package-reference.ts): the test parses
// the recorded JSON text with the engine's json.h, validates it natively and compares every error
// (code, path, message) in order, then borrows each placement run and compares its float32 records
// or its refusal code.
#include "check.h"
#include "engine/foundation/json.h"
#include "engine/world/package/world_package.h"

#include <bit>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <limits>
#include <string>
#include <vector>

using namespace tn::engine;
using namespace tn::engine::world;

namespace {

#include "world_package_reference.inc"

void world_package() {
    std::size_t errorsCompared = 0;
    std::size_t mismatched = 0;

    for (const RefWorldManifest& ref : kWorldManifests) {
        json::Value manifest;
        json::Error parseError;
        if (!json::parse(ref.text, manifest, parseError)) {
            ++mismatched;
            std::fprintf(stderr, "manifest did not parse at %zu: %s\n", parseError.offset, parseError.detail.c_str());
            continue;
        }
        WorldPackageOptions options;
        options.placementsByteLength = ref.placementsByteLength;
        options.hasHeightmapByteLength = ref.hasHeightmapByteLength;
        options.heightmapByteLength = ref.heightmapByteLength;
        const std::vector<WorldPackageError> errors = validateWorldPackage(manifest, options);
        ++errorsCompared;
        if (errors.size() != ref.errorCount) {
            if (mismatched < 8)
                std::fprintf(stderr, "error count %zu/%zu for %s\n", errors.size(), ref.errorCount, ref.text);
            ++mismatched;
            continue;
        }
        for (std::size_t i = 0; i < errors.size(); ++i) {
            ++errorsCompared;
            if (errors[i].code != ref.errors[i].code || errors[i].path != ref.errors[i].path ||
                errors[i].message != ref.errors[i].message) {
                if (mismatched < 8)
                    std::fprintf(stderr, "error %zu: [%s|%s|%s] vs [%s|%s|%s]\n", i, errors[i].code.c_str(),
                                 errors[i].path.c_str(), errors[i].message.c_str(), ref.errors[i].code,
                                 ref.errors[i].path, ref.errors[i].message);
                ++mismatched;
            }
        }
    }

    for (const RefPlacementCase& ref : kPlacements) {
        std::vector<float> buffer;
        buffer.reserve(ref.bufferFloats);
        for (std::size_t i = 0; i < ref.bufferFloats; ++i)
            buffer.push_back(std::bit_cast<float>(ref.buffer[i]));
        const std::span<const std::byte> bytes(reinterpret_cast<const std::byte*>(buffer.data()),
                                               buffer.size() * sizeof(float));
        std::string error;
        const std::optional<std::vector<float>> view =
            cellPlacements(bytes, PlacementRun{ref.offset, ref.count}, error);
        ++errorsCompared;
        if (ref.refused) {
            if (view.has_value() || error != ref.code) {
                if (mismatched < 8)
                    std::fprintf(stderr, "placement %s refused %d, code %s/%s\n", ref.name, view.has_value(),
                                 error.c_str(), ref.code);
                ++mismatched;
            }
            continue;
        }
        if (!view.has_value() || view->size() != ref.valueCount) {
            if (mismatched < 8)
                std::fprintf(stderr, "placement %s size %zu/%zu (%s)\n", ref.name,
                             view.has_value() ? view->size() : 0, ref.valueCount, error.c_str());
            ++mismatched;
            continue;
        }
        for (std::size_t i = 0; i < view->size(); ++i) {
            ++errorsCompared;
            if (std::bit_cast<uint32_t>((*view)[i]) != ref.values[i]) {
                if (mismatched < 8)
                    std::fprintf(stderr, "placement %s value %zu differs\n", ref.name, i);
                ++mismatched;
            }
        }
    }

    std::printf("world package: %zu manifests, %zu differ\n", std::size(kWorldManifests), mismatched);
    CHECK(errorsCompared > 0 && mismatched == 0);
}

} // namespace

TN_TEST_MAIN({"world_package", world_package})
