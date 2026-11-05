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

}  // namespace

TN_TEST_MAIN({"volume_usage", volumeUsage}, {"mip_tail", mipTail})
