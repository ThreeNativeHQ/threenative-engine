// The shared facade's loader API over the engine's decoders; no JS engine or browser service.
#include "engine/abi/abi_internal.h"
#include "engine/assets/gltf/loader.h"
#include "engine/assets/gltf/image_decode.h"
#include "engine/scene/texture.h"
#include <algorithm>
#include <bit>
#include <cstdlib>
#include <cstring>
#include <fstream>

namespace {
thread_local std::string failure;
struct Handles {
    std::vector<tn_handle_t> values;
    ~Handles() { for (const auto handle : values) tn_object_release(handle, nullptr); }
};
uint16_t half(float value) {
    // three's DataUtils.toHalfFloat truncates the mantissa and clamps, rather than rounding.
    const auto bits = std::bit_cast<uint32_t>(std::clamp(value, -65504.0f, 65504.0f));
    const int exponent = int((bits >> 23) & 255) - 127;
    const uint16_t sign = uint16_t((bits >> 16) & 0x8000);
    if (exponent < -27) return sign;
    if (exponent < -14) return sign + (0x400 >> (-exponent - 14)) + ((bits & 0x7fffff) >> (-exponent - 1));
    return sign + ((exponent + 15) << 10) + ((bits & 0x7fffff) >> 13);
}
}

extern "C" int64_t tnp_load_asset(int64_t context, int64_t kind, int64_t input,
                                  int64_t size, int64_t output, int64_t type, int64_t fromFile) {
    using namespace tn::engine;
    const auto fail = [](std::string message) {
        failure = std::move(message);
        return int64_t(reinterpret_cast<uintptr_t>(failure.c_str()));
    };
    if (!context || !input || !output || (kind != 0 && kind != 1)) return fail("TN_PERRY_ASSET_ARGUMENT");
    try {
        std::vector<uint8_t> fileBytes;
        const auto* bytes = reinterpret_cast<const uint8_t*>(input);
        if (fromFile) {
            const auto* path = reinterpret_cast<const char*>(input);
            std::ifstream file(path, std::ios::binary | std::ios::ate);
            if (!file) return fail(std::string("TN_PERRY_ASSET_MISSING: ") + path);
            const auto length = file.tellg();
            if (length <= 0 || length > 0x7fffffff) return fail("TN_PERRY_ASSET_SIZE");
            fileBytes.resize(static_cast<std::size_t>(length));
            file.seekg(0);
            if (!file.read(reinterpret_cast<char*>(fileBytes.data()), length)) return fail("TN_PERRY_ASSET_READ");
            bytes = fileBytes.data();
            size = fileBytes.size();
        }
        if (size <= 0 || size > 0x7fffffff) return fail("TN_PERRY_ASSET_SIZE");
        auto* ctx = reinterpret_cast<tn_context_t*>(context);
        Handles owned;
        auto& handles = owned.values;
        handles.reserve(1);
        if (kind == 0) {
            auto loaded = gltf::load(std::span<const uint8_t>(bytes, size));
            if (!loaded.error.empty()) return fail(loaded.error);
            if (!loaded.scene) return fail("TN_NATIVE_GLTF_SCENE_MISSING");
            bool undecoded = false;
            loaded.scene->traverse([](Object3D& object, void* state) {
                auto* mesh = dynamic_cast<Mesh*>(&object);
                if (mesh && mesh->material)
                    for (const auto& [slot, map] : mesh->material->maps)
                        if (map && !map->hasImage()) *static_cast<bool*>(state) = true;
            }, &undecoded);
            if (undecoded) return fail("TN_NATIVE_GLTF_IMAGE_UNSUPPORTED");
            handles.reserve(1 + loaded.animations.size());
            handles.push_back(tn::abi::shareObject(ctx, "Group", loaded.scene));
            for (auto& clip : loaded.animations)
                handles.push_back(tn::abi::shareObject(ctx, "AnimationClip", clip));
        } else {
            if (type != kTextureFloatType && type != kTextureHalfFloatType) return fail("TN_HDR_INVALID: unsupported type");
            std::vector<float> rgba;
            uint32_t width = 0, height = 0;
            if (!gltf::decodeHdr(bytes, size, width, height, rgba)) return fail("TN_HDR_INVALID: invalid or oversized image");
            auto texture = std::make_shared<DataTexture>();
            texture->width = width; texture->height = height; texture->type = type;
            texture->flipY = true;
            texture->minFilter = texture->magFilter = uint16_t(TextureFilter::Linear);
            if (type == kTextureFloatType) {
                texture->data.resize(rgba.size() * sizeof(float));
                std::memcpy(texture->data.data(), rgba.data(), texture->data.size());
            } else {
                texture->data.resize(rgba.size() * sizeof(uint16_t));
                for (std::size_t i = 0; i < rgba.size(); ++i) {
                    const uint16_t bits = half(rgba[i]);
                    std::memcpy(texture->data.data() + i * sizeof(bits), &bits, sizeof(bits));
                }
            }
            texture->needsUpdate();
            handles.push_back(tn::abi::shareObject(ctx, "DataTexture", texture));
        }
        auto* result = static_cast<tn_handle_t*>(std::calloc(handles.size(), sizeof(tn_handle_t)));
        if (!result) return fail("TN_PERRY_OUT_OF_MEMORY");
        std::memcpy(result, handles.data(), handles.size() * sizeof(tn_handle_t));
        const uintptr_t pointer = reinterpret_cast<uintptr_t>(result);
        const uint32_t count = handles.size();
        std::memcpy(reinterpret_cast<void*>(output), &pointer, sizeof(pointer));
        std::memcpy(reinterpret_cast<uint8_t*>(output) + sizeof(pointer), &count, sizeof(count));
        handles.clear();
        return 0;
    } catch (const std::exception& error) { return fail(std::string("TN_PERRY_ASSET: ") + error.what()); }
    catch (...) { return fail("TN_PERRY_ASSET: decoder failed"); }
}
