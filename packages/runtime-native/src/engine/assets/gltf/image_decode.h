#pragma once
// PNG, JPEG, (with libwebp, TN_ENGINE_WEBP) WebP and (with Basis Universal, TN_ENGINE_BASISU) KTX2
// bytes to straight RGBA8, row 0 first (glTF images are not flipped). stb_image is compiled static in image_decode.cpp so it cannot collide
// with the host runtime's own copy.

#include <cstddef>
#include <cstdint>
#include <vector>

#include "engine/scene/texture.h"

namespace tn::engine::gltf {

enum class ImageFormat { Unknown, Png, Jpeg, WebP, Ktx2 };

/** The format the bytes' magic announces; Unknown means this build does not decode it. */
ImageFormat imageFormat(const uint8_t* bytes, std::size_t size);

/** True when this build decodes WebP (EXT_texture_webp). */
bool decodesWebP();

/**
 * True when this build transcodes KTX2 (KHR_texture_basisu): ETC1S or UASTC, zstd or not, to the
 * device's block format (compressedTextureTarget) or, with none, to RGBA8.
 */
bool decodesKtx2();

/** Decodes a PNG, JPEG, WebP or KTX2 (its base level) into `rgba` (width * height * 4 bytes); false for a damaged or oversized image. */
bool decodeImage(const uint8_t* bytes, std::size_t size, uint32_t& width, uint32_t& height,
                 std::vector<uint8_t>& rgba);

/**
 * As above into `image`, except a KTX2 becomes every level in `target`'s block format (`image.mipmaps`)
 * when `target` is kTextureBC7Format or kTextureETC2RGBAFormat and the size is a multiple of 4.
 * Otherwise RGBA8, and the first KTX2 says which in a TN_TEXTURE_TRANSCODE_TARGET line.
 */
bool decodeImage(const uint8_t* bytes, std::size_t size, TextureSource& image,
                 uint16_t target = compressedTextureTarget().load());

/** Radiance HDR to RGBA32F, with three's RGBE /255 scale (stb's decoder uses /256). */
bool decodeHdr(const uint8_t* bytes, std::size_t size, uint32_t& width, uint32_t& height,
               std::vector<float>& rgba);

} // namespace tn::engine::gltf
