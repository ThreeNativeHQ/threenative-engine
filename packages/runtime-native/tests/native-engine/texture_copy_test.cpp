#include "check.h"
#include "engine/renderer/texture_copy.h"

// A Data3DTexture in a texture copy (texture_copy.h). three's renderer.copyTextureToTexture takes any texture, and
// the engine's JS host forwards a volume as readily as an image, so the 3D texture it creates must carry the usage
// the copy needs and must never be asked for a mip chain it was not created with.

namespace {

using tn::engine::copyRebuildsMipmaps;
using tn::engine::kVolumeTextureUsage;

void volumeUsage() {
    CHECK((kVolumeTextureUsage & WGPUTextureUsage_TextureBinding) != 0);  // a material samples it
    CHECK((kVolumeTextureUsage & WGPUTextureUsage_CopyDst) != 0);         // wgpuQueueWriteTexture fills it
    CHECK((kVolumeTextureUsage & WGPUTextureUsage_CopySrc) != 0);         // copyTextureToTexture reads it back
}

void mipTail() {
    CHECK(!copyRebuildsMipmaps(true, 4));   // a volume stays one level, whatever a chain would hold
    CHECK(!copyRebuildsMipmaps(true, 1));
    CHECK(copyRebuildsMipmaps(false, 4));   // a 4-byte image with a chain rebuilds it after a level-0 write
    CHECK(!copyRebuildsMipmaps(false, 1));  // one level: nothing to rebuild
}

void cpuMipLevel() {
    // 3x2 -> 1x1: the odd column folds into the box, white and black average to mid grey.
    const uint8_t rgba[3 * 2 * 4] = {255, 255, 255, 255, 0, 0, 0, 255, 9, 9, 9, 9,
                                     255, 255, 255, 255, 0, 0, 0, 255, 9, 9, 9, 9};
    const auto linear = tn::engine::downsampleRgba8(rgba, 3, 2, false);
    CHECK(linear.size() == 4);
    CHECK(linear[0] == 128 && linear[3] == 255);
    // sRGB averages light, not code values: half of white is code 188, not 128.
    const auto srgb = tn::engine::downsampleRgba8(rgba, 3, 2, true);
    CHECK(srgb[0] == 188 && srgb[3] == 255);
    // 1x1 stays 1x1.
    CHECK(tn::engine::downsampleRgba8(rgba, 1, 1, false).size() == 4);
}

}  // namespace

TN_TEST_MAIN({"volume_usage", volumeUsage}, {"mip_tail", mipTail}, {"cpu_mip_level", cpuMipLevel})
