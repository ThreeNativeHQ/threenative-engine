#pragma once

// What a material texture must be created with to take part in `Renderer::copyTextureToTexture`, and whether a
// copy into it rebuilds its mip chain. The copy itself is one `wgpuCommandEncoderCopyTextureToTexture`, so a
// missing usage bit here is a WebGPU validation error, not the named refusal the copy throws.

#include <cstdint>
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

}  // namespace tn::engine
