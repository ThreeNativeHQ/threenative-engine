#include "engine/assets/gltf/image_decode.h"

#include <algorithm>
#include <cstdlib>
#include <memory>

#define STB_IMAGE_IMPLEMENTATION
#define STB_IMAGE_STATIC
#define STBI_NO_STDIO
#define STBI_ONLY_PNG
#define STBI_ONLY_JPEG
#define STBI_ONLY_HDR
#include "stb_image.h"

#if TN_ENGINE_WEBP
#include <webp/decode.h>
#endif

namespace tn::engine::gltf {

ImageFormat imageFormat(const uint8_t* bytes, std::size_t size) {
    static const uint8_t png[] = {0x89, 'P', 'N', 'G'};
    if (size >= 4 && std::equal(png, png + 4, bytes)) return ImageFormat::Png;
    if (size >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF) return ImageFormat::Jpeg;
    if (decodesWebP() && size >= 12 && std::equal(bytes, bytes + 4, "RIFF") && std::equal(bytes + 8, bytes + 12, "WEBP"))
        return ImageFormat::WebP;
    return ImageFormat::Unknown;
}

bool decodesWebP() {
#if TN_ENGINE_WEBP
    return true;
#else
    return false;
#endif
}

bool decodeImage(const uint8_t* bytes, std::size_t size, uint32_t& width, uint32_t& height,
                 std::vector<uint8_t>& rgba) {
    // 8192 is the largest texture dimension a WebGPU device guarantees; refuse before allocating more.
    constexpr int kMaxDimension = 8192;
    constexpr int kMaxPixels = 1 << 26;
    int w = 0, h = 0, channels = 0;
#if TN_ENGINE_WEBP
    if (imageFormat(bytes, size) == ImageFormat::WebP) {
        if (!WebPGetInfo(bytes, size, &w, &h)) return false;
        if (w < 1 || h < 1 || w > kMaxDimension || h > kMaxDimension || int64_t(w) * h > kMaxPixels) return false;
        rgba.resize(std::size_t(w) * h * 4);
        if (!WebPDecodeRGBAInto(bytes, size, rgba.data(), rgba.size(), w * 4)) return false;
        width = uint32_t(w);
        height = uint32_t(h);
        return true;
    }
#endif
    if (size > 0x7fffffff || !stbi_info_from_memory(bytes, int(size), &w, &h, &channels)) return false;
    if (w < 1 || h < 1 || w > kMaxDimension || h > kMaxDimension || int64_t(w) * h > kMaxPixels) return false;
    uint8_t* pixels = stbi_load_from_memory(bytes, int(size), &w, &h, &channels, 4);
    if (!pixels) return false;
    width = uint32_t(w);
    height = uint32_t(h);
    rgba.assign(pixels, pixels + std::size_t(w) * h * 4);
    stbi_image_free(pixels);
    return true;
}

bool decodeHdr(const uint8_t* bytes, std::size_t size, uint32_t& width, uint32_t& height,
               std::vector<float>& rgba) {
    int w = 0, h = 0, channels = 0;
    if (!bytes || size > 0x7fffffff || !stbi_is_hdr_from_memory(bytes, int(size)) ||
        !stbi_info_from_memory(bytes, int(size), &w, &h, &channels)) return false;
    if (w < 1 || h < 1 || w > 8192 || h > 8192 || int64_t(w) * h > (1 << 26)) return false;
    std::unique_ptr<float, decltype(&stbi_image_free)> pixels(
        stbi_loadf_from_memory(bytes, int(size), &w, &h, &channels, 4), stbi_image_free);
    if (!pixels) return false;
    width = uint32_t(w);
    height = uint32_t(h);
    rgba.assign(pixels.get(), pixels.get() + std::size_t(w) * h * 4);
    for (std::size_t i = 0; i < rgba.size(); ++i)
        if (i % 4 != 3) rgba[i] *= 256.0f / 255.0f;
    return true;
}

} // namespace tn::engine::gltf
