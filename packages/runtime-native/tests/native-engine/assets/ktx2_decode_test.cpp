// PRD-861 KTX2 slice: a KHR_texture_basisu model loads with its textures transcoded to RGBA8, and a
// damaged KTX2 image refuses the model by name. The fixture is a 1.5 KB GLB with one triangle and two
// 8x8 KHR_texture_basisu images in buffer views and no PNG fallback: baseColorTexture is solid red
// as ETC1S, emissiveTexture is solid green as UASTC with zstd supercompression, both written by the
// asset cook's own encoder (packages/assets/src/ktx2-encoder.ts, basis v2.5) at quality 128.
#include "check.h"
#include "engine/assets/gltf/loader.h"
#include "engine/scene/nodes.h"

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iterator>
#include <string>

using namespace tn::engine;

namespace {

std::string readFixture() {
    std::ifstream in(TN_GLTF_KTX2_FIXTURE, std::ios::binary);
    return std::string(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
}

gltf::LoadResult loadBytes(const std::string& bytes) {
    return gltf::load(std::span<const uint8_t>(reinterpret_cast<const uint8_t*>(bytes.data()), bytes.size()));
}

// Every texel of `slot` is within 8 levels of the solid colour the fixture encoded.
bool solid(const Material& material, const char* slot, int r, int g, int b) {
    const auto found = material.maps.find(slot);
    if (found == material.maps.end() || !found->second) return std::printf("%s: no texture\n", slot), false;
    const Texture& texture = *found->second;
    if (texture.width != 8 || texture.height != 8 || texture.data.size() != 8 * 8 * 4)
        return std::printf("%s: %ux%u, %zu bytes\n", slot, texture.width, texture.height, texture.data.size()), false;
    for (std::size_t i = 0; i < texture.data.size(); i += 4) {
        const uint8_t* t = &texture.data[i];
        if (std::abs(t[0] - r) > 8 || std::abs(t[1] - g) > 8 || std::abs(t[2] - b) > 8 || t[3] != 255)
            return std::printf("%s texel %zu: %u %u %u %u\n", slot, i / 4, t[0], t[1], t[2], t[3]), false;
    }
    return true;
}

void transcodesToRgba() {
    const std::string bytes = readFixture();
    CHECK(!bytes.empty());
    const gltf::LoadResult loaded = loadBytes(bytes);
    if (!loaded.error.empty()) std::printf("ktx2 fixture: %s\n", loaded.error.c_str());
    CHECK(loaded.error.empty() && loaded.scene);
    if (!loaded.scene) return;
    const auto* mesh = dynamic_cast<Mesh*>(loaded.scene->getObjectByName("quad"));
    CHECK(mesh && mesh->material);
    if (!mesh || !mesh->material) return;
    CHECK(solid(*mesh->material, "map", 255, 0, 0));        // ETC1S
    CHECK(solid(*mesh->material, "emissiveMap", 0, 255, 0));  // UASTC + zstd
}

// A KTX2 whose header no longer parses is TN_NATIVE_GLTF_IMAGE_INVALID naming the image, not a model
// drawn without its texture.
void damagedIsRefused() {
    std::string bytes = readFixture();
    const std::size_t magic = bytes.find("\xABKTX 20\xBB");
    CHECK(magic != std::string::npos);
    if (magic == std::string::npos) return;
    bytes[magic + 12] = char(0xff);  // vkFormat's low byte: a Basis KTX2 must say VK_FORMAT_UNDEFINED
    bytes[magic + 13] = char(0xff);
    const gltf::LoadResult loaded = loadBytes(bytes);
    std::printf("damaged ktx2: %s\n", loaded.error.empty() ? "(loaded)" : loaded.error.c_str());
    CHECK(loaded.error.rfind("TN_NATIVE_GLTF_IMAGE_INVALID image 0", 0) == 0);
    CHECK(!loaded.scene);
}

}  // namespace

TN_TEST_MAIN({"transcodes_to_rgba", transcodesToRgba}, {"damaged_is_refused", damagedIsRefused})
