#pragma once
// PNG, JPEG and (with libwebp, TN_ENGINE_WEBP) WebP bytes to straight RGBA8, row 0 first (glTF
// images are not flipped). stb_image is compiled static in image_decode.cpp so it cannot collide
// with the host runtime's own copy.

#include <cstddef>
#include <cstdint>
#include <vector>

namespace tn::engine::gltf {

enum class ImageFormat { Unknown, Png, Jpeg, WebP };

/** The format the bytes' magic announces; Unknown means this build does not decode it. */
ImageFormat imageFormat(const uint8_t* bytes, std::size_t size);

/** True when this build decodes WebP (EXT_texture_webp). */
bool decodesWebP();

/** Decodes a PNG, JPEG or WebP into `rgba` (width * height * 4 bytes); false for a damaged or oversized image. */
bool decodeImage(const uint8_t* bytes, std::size_t size, uint32_t& width, uint32_t& height,
                 std::vector<uint8_t>& rgba);

/** Radiance HDR to RGBA32F, with three's RGBE /255 scale (stb's decoder uses /256). */
bool decodeHdr(const uint8_t* bytes, std::size_t size, uint32_t& width, uint32_t& height,
               std::vector<float>& rgba);

} // namespace tn::engine::gltf
