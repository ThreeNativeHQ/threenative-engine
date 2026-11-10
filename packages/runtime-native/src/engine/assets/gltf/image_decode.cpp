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

#if TN_ENGINE_BASISU
#include <cstdio>
#include <mutex>

#include "basisu_transcoder.h"
#endif

namespace tn::engine::gltf {

namespace {
// 8192 is the largest texture dimension a WebGPU device guarantees; refuse before allocating more.
constexpr int kMaxDimension = 8192;
constexpr int kMaxPixels = 1 << 26;

#if TN_ENGINE_BASISU
// One KTX2 image ready to transcode: a single 2D face and layer, within the size limits.
bool startKtx2(basist::ktx2_transcoder& ktx2, const uint8_t* bytes, std::size_t size) {
    // The transcoder's tables are built once per process; ktx2_transcoder keeps its own state, so
    // the loader's decode pool runs one per image in parallel.
    static std::once_flag tables;
    std::call_once(tables, [] { basist::basisu_transcoder_init(); });
    if (size > 0xffffffffu || !ktx2.init(bytes, uint32_t(size)) || ktx2.get_faces() != 1 || ktx2.get_layers() > 1) return false;
    const int w = int(ktx2.get_width()), h = int(ktx2.get_height());
    if (w < 1 || h < 1 || w > kMaxDimension || h > kMaxDimension || int64_t(w) * h > kMaxPixels) return false;
    return ktx2.start_transcoding();
}

// The first KTX2 of the process names the format its images take, so an RGBA8 fallback is never silent.
void reportTarget(uint16_t target) {
    static std::once_flag reported;
    std::call_once(reported, [target] {
        if (target == kTextureBC7Format) std::printf("TN_TEXTURE_TRANSCODE_TARGET bc7\n");
        else if (target == kTextureETC2RGBAFormat) std::printf("TN_TEXTURE_TRANSCODE_TARGET etc2\n");
        else std::printf("TN_TEXTURE_TRANSCODE_TARGET rgba8: this process has no device with texture-compression-bc or texture-compression-etc2\n");
        std::fflush(stdout);
    });
}
#endif
}  // namespace

ImageFormat imageFormat(const uint8_t* bytes, std::size_t size) {
    static const uint8_t png[] = {0x89, 'P', 'N', 'G'};
    if (size >= 4 && std::equal(png, png + 4, bytes)) return ImageFormat::Png;
    if (size >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF) return ImageFormat::Jpeg;
    if (decodesWebP() && size >= 12 && std::equal(bytes, bytes + 4, "RIFF") && std::equal(bytes + 8, bytes + 12, "WEBP"))
        return ImageFormat::WebP;
    static const uint8_t ktx2[] = {0xAB, 'K', 'T', 'X', ' ', '2', '0', 0xBB, '\r', '\n', 0x1A, '\n'};
    if (decodesKtx2() && size >= 12 && std::equal(ktx2, ktx2 + 12, bytes)) return ImageFormat::Ktx2;
    return ImageFormat::Unknown;
}

bool decodesKtx2() {
#if TN_ENGINE_BASISU
    return true;
#else
    return false;
#endif
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
#if TN_ENGINE_BASISU
    if (imageFormat(bytes, size) == ImageFormat::Ktx2) {
        basist::ktx2_transcoder ktx2;
        if (!startKtx2(ktx2, bytes, size)) return false;
        w = int(ktx2.get_width());
        h = int(ktx2.get_height());
        // RGBA8: the base level only, and the renderer builds its own mip chain.
        rgba.resize(std::size_t(w) * h * 4);
        if (!ktx2.transcode_image_level(0, 0, 0, rgba.data(), uint32_t(w) * uint32_t(h),
                                        basist::transcoder_texture_format::cTFRGBA32))
            return false;
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

bool decodeImage(const uint8_t* bytes, std::size_t size, TextureSource& image, uint16_t target) {
#if TN_ENGINE_BASISU
    if (imageFormat(bytes, size) == ImageFormat::Ktx2) {
        const bool blockTarget = target == kTextureBC7Format || target == kTextureETC2RGBAFormat;
        reportTarget(target);
        basist::ktx2_transcoder ktx2;
        if (!startKtx2(ktx2, bytes, size)) return false;
        const uint32_t w = ktx2.get_width(), h = ktx2.get_height();
        if (blockTarget && (w % 4 != 0 || h % 4 != 0)) {
            // WebGPU creates a block-compressed texture only at a multiple of the block size.
            std::printf("TN_TEXTURE_TRANSCODE_TARGET rgba8 for a %ux%u image: a block format needs a multiple of 4\n", w, h);
            std::fflush(stdout);
        }
        if (blockTarget && w % 4 == 0 && h % 4 == 0) {
            const auto format = target == kTextureBC7Format ? basist::transcoder_texture_format::cTFBC7_RGBA
                                                            : basist::transcoder_texture_format::cTFETC2_RGBA;
            // Every level the file carries, finest first. ponytail: a file with one level samples one level;
            // a block format cannot be rendered to, so no chain is generated for it.
            std::vector<TextureMipmap> levels(ktx2.get_levels());
            for (uint32_t level = 0; level < levels.size(); ++level) {
                basist::ktx2_image_level_info info;
                if (!ktx2.get_image_level_info(info, level, 0, 0)) return false;
                const uint32_t blocks = info.m_num_blocks_x * info.m_num_blocks_y;
                levels[level].width = info.m_orig_width;
                levels[level].height = info.m_orig_height;
                levels[level].data.resize(std::size_t(blocks) * 16);
                if (!ktx2.transcode_image_level(level, 0, 0, levels[level].data.data(), blocks, format)) return false;
            }
            image.width = w;
            image.height = h;
            image.data.clear();
            image.mipmaps = std::move(levels);
            image.mipmapFormat = target;
            return true;
        }
    }
#else
    (void)target;
#endif
    return decodeImage(bytes, size, image.width, image.height, image.data);
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
