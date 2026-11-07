#pragma once

// What a material texture must be created with to take part in `Renderer::copyTextureToTexture`, and whether a
// copy into it rebuilds its mip chain. The copy itself is one `wgpuCommandEncoderCopyTextureToTexture`, so a
// missing usage bit here is a WebGPU validation error, not the named refusal the copy throws.

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <vector>
#include <webgpu/webgpu.h>

namespace tn::engine {

/**
 * The usage of an uploaded volume's 3D texture (three's Data3DTexture): sampled by a material, written by
 * `wgpuQueueWriteTexture`, and read back by `copyTextureToTexture`, which the JS host forwards for a volume as
 * readily as for an image. Without `CopySrc` that copy is refused at validation.
 */
inline constexpr WGPUTextureUsage kVolumeTextureUsage =
    WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst | WGPUTextureUsage_CopySrc;

/** Levels in a `width`x`height` image's mip chain, level 0 included: what a created texture holds. */
inline uint32_t mipLevelCount(uint32_t width, uint32_t height) {
    uint32_t levels = 1;
    for (uint32_t size = width > height ? width : height; size > 1; size >>= 1) ++levels;
    return levels;
}

/**
 * Whether a copy into a texture created with `levels` mip levels rebuilds its chain, as three's backend does after a
 * level-0 write. A volume is one 3D image at the single level materialTextureKey gives it, so the copy takes its
 * pixels and nothing else: a chain drawn on it writes levels the texture does not have.
 */
inline bool copyRebuildsMipmaps(bool volume, uint32_t levels) { return !volume && levels > 1; }

/**
 * Whether an uploaded image builds its mip chain on the CPU, one queue write per level, instead of rendering it.
 * On PS4 a mipmapped texture created as a render target never gets its higher levels into the tiled memory the GPU
 * samples (the vk-ps4 driver tiles level 0 only for a colour target), so every level past 0 read zeros: black
 * floors and NaN normals at a distance.
 */
#if defined(TN_PS4)
inline constexpr bool kCpuMipChain = true;
#else
inline constexpr bool kCpuMipChain = false;
#endif

/**
 * The next mip level of a tightly packed RGBA8 image: a 2x2 box filter, the last row or column reused for an odd
 * size, so `w`x`h` becomes max(1, w/2)xmax(1, h/2). An sRGB image averages its colour in linear light, as the GPU
 * blit of an sRGB view does; alpha is linear. The PS4 lane builds its chain with it (renderer.cpp, kCpuMipChain).
 */
inline std::vector<uint8_t> downsampleRgba8(const uint8_t* src, uint32_t w, uint32_t h, bool srgb) {
    static const auto decode = [] {
        std::array<float, 256> table{};
        for (int i = 0; i < 256; ++i) {
            const float c = float(i) / 255.0f;
            table[i] = c <= 0.04045f ? c / 12.92f : std::pow((c + 0.055f) / 1.055f, 2.4f);
        }
        return table;
    }();
    const auto encode = [](float l) {
        const float c = l <= 0.0031308f ? l * 12.92f : 1.055f * std::pow(l, 1.0f / 2.4f) - 0.055f;
        return uint8_t(std::lround(std::clamp(c, 0.0f, 1.0f) * 255.0f));
    };
    const uint32_t ow = w > 1 ? w / 2 : 1, oh = h > 1 ? h / 2 : 1;
    std::vector<uint8_t> out(size_t(ow) * oh * 4);
    for (uint32_t y = 0; y < oh; ++y)
        for (uint32_t x = 0; x < ow; ++x) {
            const uint32_t x0 = std::min(2 * x, w - 1), x1 = std::min(2 * x + 1, w - 1);
            const uint32_t y0 = std::min(2 * y, h - 1), y1 = std::min(2 * y + 1, h - 1);
            const uint8_t* p[4] = {src + (size_t(y0) * w + x0) * 4, src + (size_t(y0) * w + x1) * 4,
                                   src + (size_t(y1) * w + x0) * 4, src + (size_t(y1) * w + x1) * 4};
            uint8_t* o = out.data() + (size_t(y) * ow + x) * 4;
            for (int c = 0; c < 4; ++c) {
                if (srgb && c < 3) {
                    o[c] = encode((decode[p[0][c]] + decode[p[1][c]] + decode[p[2][c]] + decode[p[3][c]]) * 0.25f);
                } else {
                    o[c] = uint8_t((p[0][c] + p[1][c] + p[2][c] + p[3][c] + 2) / 4);
                }
            }
        }
    return out;
}

}  // namespace tn::engine
