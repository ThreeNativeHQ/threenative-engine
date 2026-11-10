#pragma once

// The native texture path (PRD-531 textures slice): a material's `map` as the renderer reads it.
// A Texture owns decoded RGBA bytes (RGBA8 or RGBA32Float), the sampler state three declares on it
// and the uv transform (repeat/offset/rotation/center) three applies before it samples. DataTexture
// is the fixture-built one; Texture is the empty base a loader fills. Header-only: the class carries
// no engine algorithm a binding cannot inline.

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <cstring>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <string_view>
#include <stdexcept>
#include <utility>
#include <vector>

#include "engine/scene/event.h"
#include "engine/foundation/math/Vector.h"

namespace tn::engine {

class RetiredTextures;

/** three's wrapping constants (three/src/constants.js), the values a fixture passes. */
enum class TextureWrap : uint16_t { Repeat = 1000, ClampToEdge = 1001, MirroredRepeat = 1002 };
/** three's filter constants: mipmapped filters retain their base-level nearest/linear filtering. */
enum class TextureFilter : uint16_t { Nearest = 1003, NearestMipmapNearest = 1004, NearestMipmapLinear = 1005,
    Linear = 1006, LinearMipmapNearest = 1007, LinearMipmapLinear = 1008 };
inline constexpr uint16_t kTextureUnsignedByteType = 1009;  // three's UnsignedByteType
inline constexpr uint16_t kTextureFloatType = 1015;         // three's FloatType
inline constexpr uint16_t kTextureHalfFloatType = 1016;     // three's HalfFloatType: IEEE binary16 bits
inline constexpr uint16_t kTextureRGBAFormat = 1023;        // three's RGBAFormat
inline constexpr uint16_t kTextureRedFormat = 1028;         // three's RedFormat (widened to RGBA)
inline constexpr uint16_t kTextureRGFormat = 1030;          // three's RGFormat (render targets only)
// three's compressed formats the engine uploads (PRD-867): 4x4 blocks of 16 bytes, one byte per texel.
inline constexpr uint16_t kTextureBC7Format = 36492;        // three's RGBA_BPTC_Format
inline constexpr uint16_t kTextureETC2RGBAFormat = 37496;   // three's RGBA_ETC2_EAC_Format

/**
 * The block format this process's GPU device samples, or 0 for none: the renderer sets it when it
 * takes its device, and the glTF loader transcodes KTX2 to it. One device per process.
 */
inline std::atomic<uint16_t>& compressedTextureTarget() {
    static std::atomic<uint16_t> target{0};
    return target;
}

/**
 * A texture's identity for GPU caches: unique for the process lifetime, never reused (an address is),
 * new for a copy, and retired when its Texture dies so a cache can release what it built for it.
 */
class TextureId {
  public:
    TextureId() : value_(next()) {}
    TextureId(const TextureId&) : value_(next()) {}
    TextureId& operator=(const TextureId&) { return *this; }
    ~TextureId() { retire(value_); }
    [[nodiscard]] uint64_t value() const { return value_; }
    /**
     * A renderer's subscription to retirements. Every watcher sees every id: a texture can be cached
     * by several renderers (the main one, a sibling pass, the probe capture renderer), and the first
     * one to sweep must not consume the retirement the others still need. Destroying it unsubscribes.
     */
    static std::shared_ptr<RetiredTextures> watch();

  private:
    friend class RetiredTextures;
    static uint64_t next() {
        static std::atomic<uint64_t> counter{1};
        return counter.fetch_add(1, std::memory_order_relaxed);
    }
    static std::mutex& mutex() {
        static std::mutex m;
        return m;
    }
    static std::vector<RetiredTextures*>& watchers() {
        static std::vector<RetiredTextures*> all;
        return all;
    }
    static void retire(uint64_t value);
    uint64_t value_;
};

/** The ids retired since the last take(), delivered to one renderer. */
class RetiredTextures {
  public:
    RetiredTextures(const RetiredTextures&) = delete;
    RetiredTextures& operator=(const RetiredTextures&) = delete;
    ~RetiredTextures() {
        std::lock_guard<std::mutex> lock(TextureId::mutex());
        auto& all = TextureId::watchers();
        all.erase(std::remove(all.begin(), all.end(), this), all.end());
    }
    std::vector<uint64_t> take() {
        std::lock_guard<std::mutex> lock(mutex_);
        return std::exchange(pending_, {});
    }

  private:
    friend class TextureId;
    RetiredTextures() = default;
    void push(uint64_t value) {
        std::lock_guard<std::mutex> lock(mutex_);
        pending_.push_back(value);
    }
    std::mutex mutex_;
    std::vector<uint64_t> pending_;
};

inline std::shared_ptr<RetiredTextures> TextureId::watch() {
    auto watcher = std::shared_ptr<RetiredTextures>(new RetiredTextures());
    std::lock_guard<std::mutex> lock(mutex());
    watchers().push_back(watcher.get());
    return watcher;
}

inline void TextureId::retire(uint64_t value) {
    std::lock_guard<std::mutex> lock(mutex());
    for (RetiredTextures* watcher : watchers()) watcher->push(value);
}

/** three's ColorSpace: NoColorSpace (empty string) or an sRGB-encoded texture. */
enum class TextureColorSpace : uint8_t { None, SRGB };

/**
 * An image the host decoded and keeps, such as a browser ImageBitmap on the web host: the renderer
 * copies it to the GPU through the host (Renderer::setExternalImageCopy), so the texture holds no
 * bytes. The host's image is released with the last texture that shares it.
 */
struct ExternalImage {
    ExternalImage(uint32_t id, uint32_t width, uint32_t height, std::function<void(uint32_t)> release)
        : id(id), width(width), height(height), release(std::move(release)) {}
    ExternalImage(const ExternalImage&) = delete;
    ExternalImage& operator=(const ExternalImage&) = delete;
    ~ExternalImage() { if (release) release(id); }
    uint32_t id, width, height;
    std::function<void(uint32_t)> release;
};

/** One level of a compressed image (three's `CompressedTexture.mipmaps[i]`). */
struct TextureMipmap {
    std::vector<uint8_t> data;
    uint32_t width = 0, height = 0;
};

struct TextureSource {
    std::vector<uint8_t> data;
    /** A compressed image's levels, finest first, in `mipmapFormat`; `data` stays empty then. */
    std::vector<TextureMipmap> mipmaps;
    uint16_t mipmapFormat = 0;  // kTextureBC7Format or kTextureETC2RGBAFormat; 0 for an RGBA image
    /** Bit n: level n was written by `writeMipLevel`, so a renderer can upload that level alone. */
    uint32_t writtenLevels = 0;
    uint32_t width = 0, height = 0, depth = 1, version = 0;
    std::shared_ptr<const ExternalImage> external;
    /** three's `source.dataReady`: false when the texels are written on the GPU (copyTextureToTexture), so none are uploaded or held. */
    bool dataReady = true;
};

class Texture : public EventDispatcher {
public:
    // Copies share the image source; sampler state, transforms and GPU identity stay per texture.
    const std::shared_ptr<TextureSource> imageSource = std::make_shared<TextureSource>();
    Texture() = default;
    /** A fresh texture (default sampler state, its own GPU identity) over an image another texture decoded. */
    explicit Texture(std::shared_ptr<TextureSource> source) : imageSource(std::move(source)) {}
    virtual ~Texture() = default;

    TextureId ident;  // identity for GPU caches; see TextureId
    std::string name;
    int source = -1;  // the glTF image index a loaded texture records before its bytes are decoded
    // three's Texture defaults (DataTexture overrides magFilter/minFilter to Nearest).
    uint16_t mapping = 300;  // UVMapping; equirectangular reflection is 303
    uint16_t wrapS = static_cast<uint16_t>(TextureWrap::ClampToEdge);
    uint16_t wrapT = static_cast<uint16_t>(TextureWrap::ClampToEdge);
    uint16_t wrapR = static_cast<uint16_t>(TextureWrap::ClampToEdge);  // Data3DTexture's W axis
    uint16_t magFilter = static_cast<uint16_t>(TextureFilter::Linear);
    uint16_t minFilter = static_cast<uint16_t>(TextureFilter::LinearMipmapLinear);
    uint16_t format = kTextureRGBAFormat;
    uint16_t type = kTextureUnsignedByteType;
    bool flipY = true; // TextureLoader images; DataTexture and GLTFLoader override false.
    bool generateMipmaps = true; // three's Texture default; DataTexture overrides false.
    double anisotropy = 1;       // three's Texture.DEFAULT_ANISOTROPY; used when every filter is linear
    TextureColorSpace colorSpace = TextureColorSpace::None;
    Vector2 repeat{1, 1};
    Vector2 offset{0, 0};
    double rotation = 0;
    Vector2 center{0, 0};

    // RGBA bytes, width-major: 4 bytes/texel for UnsignedByteType, 8 for HalfFloatType (binary16
    // bits), 16 for FloatType. Empty until a loader or DataTexture fills it.
    std::vector<uint8_t>& data = imageSource->data;
    std::vector<TextureMipmap>& mipmaps = imageSource->mipmaps;  // three's CompressedTexture.mipmaps
    uint32_t& width = imageSource->width;
    uint32_t& height = imageSource->height;
    uint32_t& depth = imageSource->depth;   // slices of a Data3DTexture, stored one after another
    bool depthTexture = false;
    bool storageTexture = false, mipmapsAutoUpdate = true;
    bool volume = false;  // three's isData3DTexture: uploaded and sampled as a 3D texture, at any depth
    bool array = false;   // three's isDataArrayTexture: `depth` layers of one 2D size, each with its own mip chain
    bool cube = false;    // three's isCubeTexture: an `array` of six faces (+X, -X, +Y, -Y, +Z, -Z) sampled as a cube
    bool& dataReady = imageSource->dataReady;  // three keeps it on the source
    /**
     * The render target this texture is the colour of (three's `renderTarget.texture`,
     * scene/render_target.h): the renderer samples that target's last render instead of uploading
     * `data`. Type-erased, so this layer does not depend on the target.
     */
    std::weak_ptr<void> renderTarget;
    /** The host's decoded image, uploaded in place of `data` (empty then); width and height are its size. */
    std::shared_ptr<const ExternalImage>& external = imageSource->external;

    /** three.js `texture.needsUpdate`: a GPU record rebuilds when its counter moves. */
    void needsUpdate() { ++version_; ++imageSource->version; }

    /**
     * Makes this a compressed texture of `levels` empty levels (finest first) in `format`, sized from
     * width x height; `writeMipLevel` fills them. Streaming fills them coarse first.
     */
    void allocateMipmaps(uint16_t format, uint32_t levels) {
        if (format != kTextureBC7Format && format != kTextureETC2RGBAFormat)
            throw std::invalid_argument("TN_NATIVE_TEXTURE_UNSUPPORTED: compressed format " + std::to_string(format) +
                                        " (BC7 and ETC2 RGBA upload; ASTC is deferred, PRD-867)");
        if (width == 0 || height == 0 || width % 4 != 0 || height % 4 != 0 || levels == 0 || levels > 32 ||
            (std::max(width, height) >> (levels - 1)) == 0)
            throw std::invalid_argument("TN_NATIVE_TEXTURE_INVALID: " + std::to_string(levels) + " levels of a " +
                                        std::to_string(width) + "x" + std::to_string(height) +
                                        " compressed texture (a multiple of 4, at most a full chain)");
        imageSource->mipmaps.assign(levels, {});
        for (uint32_t level = 0; level < levels; ++level)
            imageSource->mipmaps[level] = {{}, std::max(1u, width >> level), std::max(1u, height >> level)};
        imageSource->mipmapFormat = format;
        imageSource->writtenLevels = 0;
        data.clear();
        needsUpdate();
    }

    /**
     * One level's blocks into a compressed texture that already has its levels (three's
     * `mipmaps[level].data = bytes` then `needsUpdate`). Levels are resident from the smallest up, so a level
     * is written only when the next coarser one holds blocks. The renderer writes this level alone into the
     * GPU texture that is already there.
     */
    void writeMipLevel(uint32_t level, std::vector<uint8_t> bytes) {
        auto& levels = imageSource->mipmaps;
        if (imageSource->mipmapFormat == 0 || level >= levels.size())
            throw std::invalid_argument("TN_NATIVE_TEXTURE_INVALID: no compressed level " + std::to_string(level) + " of " +
                                        std::to_string(levels.size()));
        TextureMipmap& mip = levels[level];
        const std::size_t expected = std::size_t((mip.width + 3) / 4) * ((mip.height + 3) / 4) * 16;
        if (bytes.size() != expected)
            throw std::invalid_argument("TN_NATIVE_TEXTURE_INVALID: compressed level " + std::to_string(level) + " (" +
                                        std::to_string(mip.width) + "x" + std::to_string(mip.height) + ") takes " +
                                        std::to_string(expected) + " bytes, not " + std::to_string(bytes.size()));
        if (level + 1 < levels.size() && levels[level + 1].data.empty())
            throw std::invalid_argument("TN_NATIVE_TEXTURE_INVALID: compressed level " + std::to_string(level) +
                                        " before level " + std::to_string(level + 1) + ": levels arrive coarse first");
        mip.data = std::move(bytes);
        imageSource->writtenLevels |= 1u << level;
        needsUpdate();
    }
    /** The finest level that holds blocks: the base of the sampled view. */
    [[nodiscard]] uint32_t residentLevel() const {
        uint32_t level = uint32_t(imageSource->mipmaps.size());
        while (level > 0 && !imageSource->mipmaps[level - 1].data.empty()) --level;
        return level;
    }

    /**
     * three's `Texture.dispose()`: the renderer lets the GPU copy go and the texture uploads again on
     * its next use, so the version moves; then `dispose` is dispatched, as three does.
     */
    void dispose() {
        needsUpdate();
        Event event{"dispose"};
        dispatchEvent(event);
    }
    [[nodiscard]] uint32_t version() const { return version_; }

    [[nodiscard]] std::string storageFormat() const {
        if (format == kTextureRGBAFormat) {
            if (type == kTextureHalfFloatType) return "rgba16float";
            if (type == kTextureFloatType) return "rgba32float";
            if (type == kTextureUnsignedByteType) return "rgba8unorm";
        }
        const std::string typeName = type == kTextureHalfFloatType ? "HalfFloatType" : type == kTextureFloatType ? "FloatType"
                                   : type == kTextureUnsignedByteType ? "UnsignedByteType" : "unknown";
        throw std::runtime_error("TN_NATIVE_STORAGE_TEXTURE_FORMAT: type=" + std::to_string(type) + " (" + typeName +
                                 "), format=" + std::to_string(format) + (format == kTextureRGBAFormat ? " (RGBAFormat)" : " (unknown)"));
    }
    [[nodiscard]] bool isFloat() const { return type == kTextureFloatType; }
    [[nodiscard]] bool isHalfFloat() const { return type == kTextureHalfFloatType; }
    /** Bytes per RGBA texel as stored in `data` and uploaded: RGBA8, RGBA16Float or RGBA32Float. */
    [[nodiscard]] uint32_t bytesPerTexel() const { return compressed() ? 1u : isFloat() ? 16u : isHalfFloat() ? 8u : 4u; }
    /** Its image is block-compressed levels (`mipmaps`), uploaded as they are: no flip and no generated chain. */
    [[nodiscard]] bool compressed() const {
        return imageSource->mipmapFormat != 0 && !imageSource->mipmaps.empty() && !imageSource->mipmaps.back().data.empty();
    }
    [[nodiscard]] bool isSRGB() const { return colorSpace == TextureColorSpace::SRGB; }
    [[nodiscard]] bool hasImage() const { return width > 0 && height > 0 && depth > 0 && (!data.empty() || compressed() || external || !dataReady); }
    /** A material can sample it: an uploaded image, or a render target's last render. */
    [[nodiscard]] bool sampleable() const { return ((depthTexture || storageTexture) && width > 0 && height > 0) || hasImage() || !renderTarget.expired(); }

private:
    uint32_t version_ = 0;
};

/**
 * DataTexture(data, width, height, format, type): the bytes a fixture passed as a typed array. The
 * values arrive as JS doubles; UnsignedByteType stores a byte per channel, FloatType a float32 and
 * HalfFloatType the Uint16Array's binary16 bit patterns, as three uploads them (RGBA16Float).
 */
class DataTexture final : public Texture {
public:
    DataTexture() {
        flipY = false;
        generateMipmaps = false;
        // DataTexture's own defaults (three/src/textures/DataTexture.js).
        magFilter = minFilter = static_cast<uint16_t>(TextureFilter::Nearest);
        format = kTextureRGBAFormat;
        type = kTextureUnsignedByteType;
    }
    /** Built as RedFormat: stored as RGBA, so `image.data` takes one lane per texel and widens it too. */
    bool redSource = false;

    void setImage(const std::vector<double>& values, const std::string& arrayType, uint32_t w, uint32_t h,
                  uint16_t fmt, uint16_t dataType, bool bump = true) {
        width = w;
        height = h;
        format = fmt;
        type = dataType;
        const bool asFloat = dataType == kTextureFloatType || arrayType == "Float32Array";
        data.clear();
        if (dataType == kTextureHalfFloatType) {
            data.resize(values.size() * sizeof(uint16_t));
            for (std::size_t i = 0; i < values.size(); ++i) {
                const auto bits = static_cast<uint16_t>(values[i]);
                std::memcpy(data.data() + i * sizeof(uint16_t), &bits, sizeof(uint16_t));
            }
        } else if (asFloat) {
            data.resize(values.size() * sizeof(float));
            for (std::size_t i = 0; i < values.size(); ++i) {
                const float v = static_cast<float>(values[i]);
                std::memcpy(data.data() + i * sizeof(float), &v, sizeof(float));
            }
        } else {
            data.resize(values.size());
            for (std::size_t i = 0; i < values.size(); ++i)
                data[i] = static_cast<uint8_t>(values[i] < 0 ? 0 : (values[i] > 255 ? 255 : values[i]));
        }
        if (bump) needsUpdate();
    }

    /** The typed array's own bytes, when they already are the stored layout (Uint16Array binary16,
     *  Float32Array float, Uint8Array bytes): one copy, no per-value round trip. False otherwise. */
    bool setImageBytes(std::string_view bytes, const std::string& arrayType, uint32_t w, uint32_t h,
                       uint16_t fmt, uint16_t dataType, bool bump = true) {
        const bool exact = dataType == kTextureHalfFloatType ? arrayType == "Uint16Array"
                           : dataType == kTextureFloatType || arrayType == "Float32Array"
                               ? arrayType == "Float32Array"
                               : arrayType == "Uint8Array" || arrayType == "Uint8ClampedArray";
        if (!exact) return false;
        width = w;
        height = h;
        format = fmt;
        type = dataType;
        data.assign(bytes.begin(), bytes.end());
        if (bump) needsUpdate();
        return true;
    }
};

}  // namespace tn::engine
