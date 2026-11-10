// The renderer: material textures, samplers, bundles and the PMREM environment bake. PRD-840 split renderer.cpp by concern; renderer_internal.h holds what they share.
#include "engine/renderer/renderer_internal.h"

namespace tn::engine {

namespace {

// three@0.187.0 PMREMGenerator's constants (renderers/common/extras/PMREMGenerator.js:29-45): a cube
// no smaller than 256, a roughest mip LOD_MIN steps below the face size, 256 VNDF samples a sharp
// level, and the last three mips integrated from a 16px source mip.
constexpr uint32_t kPmremMinSize = 256;
constexpr uint32_t kPmremLodMin = 3;
constexpr uint32_t kPmremGgxSamples = 256;
constexpr uint32_t kPmremIntegrationSize = 16;
constexpr uint32_t kPmremIntegrationLevels = 3;
// PmremUniforms: roughness, lodBias, sourceLod, pad, then the face's mat4x4.
constexpr uint32_t kEnvUniformSize = 16 + 16 * 4;

// The PMREM generator's shaders: three@0.187.0's PMREMGenerator (renderers/common/extras) and
// PMREMUtils (nodes/pmrem) ported operation for operation — the equirect-to-cube conversion with its
// four subpixel taps, the source cube's mip chain, the GGX VNDF convolution (256 samples, filtered
// importance sampling) and the integration tail that weights every texel of a 16px source mip. Each
// pass renders one face of one mip of a cube render target. Hand-written because the material IR has
// no u32 loop or bit ops; this is renderer-internal plumbing, not a material.
//
// A face's fragment reads the direction three's box gives it (`positionWorldDirection`,
// accessors/Position.js:74): the cube camera's view matrix (`u.face`, CubeCamera's WebGPU branch)
// applied to the ray through the face texel, normalized. Both the equirect conversion and the
// premultiplied bake draw their faces the same way, so the cube they write is the cube three writes.
TN_WGSL_STRIPPED(kPmremPrelude, R"WGSL(
struct PmremUniforms {
  roughness: f32, lodBias: f32, sourceLod: f32, pad: f32,
  face: mat4x4<f32>,
};
@group(0) @binding(0) var<uniform> u: PmremUniforms;
struct VsOut {
  @builtin(position) position: vec4<f32>,
  @location(0) ndc: vec2<f32>,
};
@vertex fn vs(@builtin(vertex_index) index: u32) -> VsOut {
  // WebGPUTexturePassUtils' mainVS: one oversized triangle over the whole face.
  let corners = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  var out: VsOut;
  out.position = vec4<f32>(corners[index], 0.0, 1.0);
  out.ndc = corners[index];
  return out;
}
fn pmremDirection(ndc: vec2<f32>) -> vec3<f32> {
  return normalize((u.face * vec4<f32>(-ndc.x, -ndc.y, -1.0, 0.0)).xyz);
}
// CubeTextureNode.setupUV (accessors/CubeTextureNode.js:115) negates x for the WebGPU coordinate
// system: every cube three renders (CubeCamera faces included) is read through that flip.
fn pmremCube(direction: vec3<f32>, lod: f32, sampler: sampler, texture: texture_cube<f32>) -> vec3<f32> {
  return textureSampleLevel(texture, sampler, vec3<f32>(-direction.x, direction.y, direction.z), lod).rgb;
}
)WGSL");

// The equirect-to-cube conversion, PMREMGenerator.js:647 `_getEquirectMaterial`: four subpixel taps
// offset by the direction's derivatives, so a small bright feature survives the face resampling.
const char* kPmremEquirect = R"WGSL(
@group(0) @binding(1) var t_src: texture_2d<f32>;
@group(0) @binding(2) var s_src: sampler;
fn equirectTexel(direction: vec3<f32>) -> vec3<f32> {
  // EquirectUV.js: atan(z, x) / 2pi + 0.5 and asin(y) / pi + 0.5.
  let dir = normalize(direction);
  let uEquirect = atan2(dir.z, dir.x) * 0.15915494309189535 + 0.5;
  let vEquirect = asin(clamp(dir.y, -1.0, 1.0)) * 0.3183098861837907 + 0.5;
  return textureSampleLevel(t_src, s_src, vec2<f32>(uEquirect, vEquirect), 0.0).rgb;
}
@fragment fn fs(in: VsOut) -> @location(0) vec4<f32> {
  let direction = pmremDirection(in.ndc);
  let dx = dpdx(direction) * 0.25;
  let dy = dpdy(direction) * 0.25;
  let color = equirectTexel(direction - dx - dy) + equirectTexel(direction + dx - dy)
            + equirectTexel(direction - dx + dy) + equirectTexel(direction + dx + dy);
  return vec4<f32>(color * 0.25, 1.0);
}
)WGSL";

// The source cube's mip chain, WebGPUTexturePassUtils.generateMipmaps: each level is the previous
// one sampled at its own texel centers through a linear filter, a 2x2 box down at the face edges.
const char* kPmremMip = R"WGSL(
@group(0) @binding(1) var t_src: texture_2d<f32>;
@group(0) @binding(2) var s_src: sampler;
@fragment fn fs(in: VsOut) -> @location(0) vec4<f32> {
  // A face's stored row 0 is the top of the face, so the destination row reads the source at the
  // other end of clip-space y: v = 0.5 - ndc.y * 0.5. The two direction passes read ndc as a
  // direction, not as a uv, and take no flip.
  return textureSampleLevel(t_src, s_src, vec2<f32>(in.ndc.x * 0.5 + 0.5, 0.5 - in.ndc.y * 0.5), 0.0);
}
)WGSL";

TN_WGSL_STRIPPED(kPmremGgx, R"WGSL(
@group(0) @binding(1) var t_src: texture_cube<f32>;
@group(0) @binding(2) var s_src: sampler;
fn radicalInverse(bitsIn: u32) -> f32 {
  var bits = bitsIn;
  bits = (bits << 16u) | (bits >> 16u);
  bits = ((bits & 0x55555555u) << 1u) | ((bits & 0xAAAAAAAAu) >> 1u);
  bits = ((bits & 0x33333333u) << 2u) | ((bits & 0xCCCCCCCCu) >> 2u);
  bits = ((bits & 0x0F0F0F0Fu) << 4u) | ((bits & 0xF0F0F0F0u) >> 4u);
  bits = ((bits & 0x00FF00FFu) << 8u) | ((bits & 0xFF00FF00u) >> 8u);
  return f32(bits) * 2.3283064365386963e-10;
}
// PMREMUtils.js:88 ggxConvolution, V = N so the reflected direction is sampled directly, and each
// sample reads the source mip level that matches its solid angle (filtered importance sampling).
@fragment fn fs(in: VsOut) -> @location(0) vec4<f32> {
  let N = pmremDirection(in.ndc);
  var prefiltered = vec3<f32>(0.0);
  if (u.roughness < 0.001) {
    prefiltered = pmremCube(N, 0.0, s_src, t_src);
  } else {
    let alpha = u.roughness * u.roughness;
    let alpha2 = alpha * alpha;
    let up = select(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 0.0, 1.0), abs(N.z) < 0.999);
    let tangent = normalize(cross(up, N));
    let bitangent = cross(N, tangent);
    var totalWeight = 0.0;
    for (var i = 0u; i < 256u; i = i + 1u) {
      let Xi = vec2<f32>(f32(i) / 256.0, radicalInverse(i));
      let invQ = 1.0 / (1.0 - Xi.x + alpha2 * Xi.x);
      let NdotL = (1.0 - Xi.x - alpha2 * Xi.x) * invQ;
      if (NdotL > 0.0) {
        let phi = Xi.y * 6.283185307179586;
        let sinTheta = alpha * 2.0 * sqrt(Xi.x * (1.0 - Xi.x)) * invQ;
        let L = N * NdotL + (tangent * cos(phi) + bitangent * sin(phi)) * sinTheta;
        // The mip whose texel solid angle matches 1 / (GGX_SAMPLES * pdf), with the half-mip bias.
        let lod = max(log2(alpha2 * invQ) + u.lodBias, 0.0);
        prefiltered += pmremCube(L, lod, s_src, t_src) * NdotL;
        totalWeight += NdotL;
      }
    }
    prefiltered = prefiltered / totalWeight;
  }
  return vec4<f32>(prefiltered, 1.0);
}
)WGSL");

TN_WGSL_STRIPPED(kPmremIntegration, R"WGSL(
@group(0) @binding(1) var t_src: texture_cube<f32>;
@group(0) @binding(2) var s_src: sampler;
// PMREMUtils.js:147 ggxIntegration: every texel of the 16px source mip, over three faces, weighted
// by the GGX lobe. Opposite texels pair up: only the one in N's hemisphere contributes.
@fragment fn fs(in: VsOut) -> @location(0) vec4<f32> {
  let N = pmremDirection(in.ndc);
  let alpha = u.roughness * u.roughness;
  let alpha2 = alpha * alpha;
  let texelSize = 2.0 / 16.0;
  var prefiltered = vec3<f32>(0.0);
  var totalWeight = 0.0;
  for (var face = 0; face < 3; face = face + 1) {
    for (var y = 0; y < 16; y = y + 1) {
      for (var x = 0; x < 16; x = x + 1) {
        let uv = (vec2<f32>(f32(x), f32(y)) + 0.5) * texelSize - 1.0;
        // select( face == 0, vec3( 1.0, uv ), select( face == 1, vec3( uv.x, 1.0, uv.y ), vec3( uv, 1.0 ) ) ):
        // three builds vec3(1.0, uv) by flattening the scalar first, so face 0 is (1, uv.x, uv.y).
        var texelDirection = select(select(vec3<f32>(uv, 1.0), vec3<f32>(uv.x, 1.0, uv.y), face == 1),
                                    vec3<f32>(1.0, uv.x, uv.y), face == 0);
        let invDistance = inverseSqrt(dot(uv, uv) + 1.0);
        var NdotL = dot(N, texelDirection);
        texelDirection = texelDirection * select(1.0, -1.0, NdotL < 0.0);
        NdotL = abs(NdotL) * invDistance;
        let d = alpha2 + 1.0 + (alpha2 - 1.0) * NdotL;
        let weight = NdotL * invDistance * invDistance * invDistance / (d * d);
        prefiltered += pmremCube(texelDirection, u.sourceLod, s_src, t_src) * weight;
        totalWeight += weight;
      }
    }
  }
  return vec4<f32>(prefiltered / totalWeight, 1.0);
}
)WGSL");

}  // namespace

void Renderer::copyDepthToTexture(const Texture& texture) {
    if (!texture.depthTexture || texture.width != inputWidth_ || texture.height != inputHeight_)
        throw std::runtime_error("TN_NATIVE_DEPTH_EXTENT: attachment must match its render target");
    const auto* destination = materialTexture(texture);
    WGPUImageCopyTexture_Compat source{}, target{};
    source.texture = depth_; source.aspect = WGPUTextureAspect_DepthOnly;
    target.texture = destination->texture; target.aspect = WGPUTextureAspect_DepthOnly;
    const WGPUExtent3D extent{texture.width, texture.height, 1};
    const auto encoder = wgpuDeviceCreateCommandEncoder(device_, nullptr);
    wgpuCommandEncoderCopyTextureToTexture(encoder, &source, &target, &extent);
    submit(wgpuCommandEncoderFinish(encoder, nullptr));
    wgpuCommandEncoderRelease(encoder);
}

void Renderer::initTexture(const Texture& texture) {
    // Mip passes run between frames (a Midway load showed 1199 render passes in one gap). Timed, they wait
    // in the stream, are summed into the next frame's GPU ms, and a few bursts fill it before a frame clears it.
    FrameGpuTimer::Scope timerScope(nullptr);
    materialTexture(texture);
    flushMipmaps();
}

// three's Renderer.copyTextureToTexture and WebGPUBackend.copyTextureToTexture: both textures are initialised, the
// region is one command, and a destination that generates mipmaps rebuilds them after a level 0 write.
void Renderer::copyTextureToTexture(const Texture& source, const Texture& destination, const TextureCopy& copy) {
    FrameGpuTimer::Scope timerScope(nullptr);
    // A render target's texture is its last render, read or written in place (three copies a cube face, a 3D slice or
    // a row of SH coefficients so); any other texture is its own uploaded record.
    const auto targetOf = [](const Texture& texture) {
        return std::static_pointer_cast<RenderTarget>(texture.renderTarget.lock());
    };
    const auto sourceTarget = targetOf(source), destinationTarget = targetOf(destination);
    const WGPUTexture from = sourceTarget ? renderTargetTexture(*this, *sourceTarget) : materialTexture(source)->texture;
    const MaterialTexture* to = destinationTarget ? nullptr : materialTexture(destination);
    const WGPUTexture into = destinationTarget ? renderTargetTexture(*this, *destinationTarget) : to->texture;
    if (!from || !into) throw std::runtime_error("TN_NATIVE_COPY_TEXTURE: both textures must have an image or a render");
    if (wgpuTextureGetFormat(from) != wgpuTextureGetFormat(into))
        throw std::runtime_error("TN_NATIVE_COPY_TEXTURE: the two textures store different formats (match their type)");
    flushMipmaps();  // the source's chain and the destination's earlier writes come first
    WGPUImageCopyTexture_Compat src{}, dst{};
    src.texture = from; src.mipLevel = copy.srcLevel; src.origin = {copy.srcX, copy.srcY, copy.srcZ};
    src.aspect = WGPUTextureAspect_All;
    dst.texture = into; dst.mipLevel = copy.dstLevel; dst.origin = {copy.dstX, copy.dstY, copy.dstZ};
    dst.aspect = WGPUTextureAspect_All;
    const WGPUExtent3D extent = {copy.width ? copy.width : source.width, copy.width ? copy.height : source.height,
                                 copy.depth};
    const auto encoder = wgpuDeviceCreateCommandEncoder(device_, nullptr);
    wgpuCommandEncoderCopyTextureToTexture(encoder, &src, &dst, &extent);
    submit(wgpuCommandEncoderFinish(encoder, nullptr));
    wgpuCommandEncoderRelease(encoder);
    if (copy.dstLevel != 0 || to == nullptr) return;  // a render target holds one level
    if (!copyRebuildsMipmaps(destination.volume, to->key.levels)) return;
    // ponytail: a CPU-built chain is not a render target, so a copy refreshes level 0 only; read the level back
    // and rebuild on the CPU if a PS4 game copies into a mipmapped texture.
    if (kCpuMipChain && !destination.external) return;
    generateMipmaps(to->texture, textureFormat(destination), to->key.levels, to->key.array ? to->key.depth : 1);
    flushMipmaps();
}

Renderer::MaterialTexture::Key Renderer::materialTextureKey(const Texture& texture) {
    MaterialTexture::Key key;
    key.width = texture.width;
    key.height = texture.height;
    // A DataArrayTexture stores `depth` 2D images in one 2D texture; a Data3DTexture is one 3D image.
    key.depth = texture.volume || texture.array ? texture.depth : 1;
    key.array = texture.array;
    key.cube = texture.cube;
    key.volume = texture.volume;
    key.texelBytes = texture.bytesPerTexel();
    key.wrapS = texture.wrapS;
    key.wrapT = texture.wrapT;
    key.wrapR = texture.wrapR;
    key.magFilter = texture.magFilter;
    key.minFilter = texture.minFilter;
    key.anisotropy = texture.anisotropy;
    if (texture.depthTexture) {
        key.kind = MaterialTexture::kDepth;
        key.format = WGPUTextureFormat_Depth32Float;
        key.usage = WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopySrc |
                    WGPUTextureUsage_CopyDst;
        key.texelBytes = 4;
    } else if (texture.storageTexture) {
        key.kind = MaterialTexture::kStorage;
        key.format = !texture.isFloat() && !texture.isHalfFloat() ? WGPUTextureFormat_RGBA8Unorm : textureFormat(texture);
        key.usage = WGPUTextureUsage_TextureBinding | WGPUTextureUsage_StorageBinding | WGPUTextureUsage_CopySrc;
    } else if (texture.hasImage() && texture.array && texture.external) {
        throw std::runtime_error("TN_NATIVE_TEXTURE_UNSUPPORTED: a host image in a DataArrayTexture");
    } else if (texture.hasImage() && texture.volume) {
        // A Data3DTexture: one 3D texture of `depth` slices, one level (ponytail: a volume's
        // generateMipmaps is ignored; no corpus game turns it on). A copy into it rebuilds no chain.
        key.kind = MaterialTexture::kVolume;
        key.format = textureFormat(texture);
        key.usage = kVolumeTextureUsage;
    } else if (texture.compressed()) {
        // three's CompressedTexture: its levels are uploaded as they are, never generated or rendered to.
        key.kind = MaterialTexture::kImage;
        key.levels = static_cast<uint32_t>(texture.mipmaps.size());
        key.format = textureFormat(texture);
        key.usage = WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst | WGPUTextureUsage_CopySrc;
    } else if (texture.hasImage()) {
        // three generates mipmaps for every Texture that is not a DataTexture; float images stay at one level.
        const bool mipmaps = texture.generateMipmaps && texture.bytesPerTexel() == 4;
        key.levels = mipmaps ? mipLevelCount(texture.width, texture.height) : 1;
        key.kind = texture.external ? MaterialTexture::kExternal : MaterialTexture::kImage;
        key.format = textureFormat(texture);
        // copyExternalImageToTexture writes through a render pass, as the mip chain does. `CopySrc` because
        // `copyTextureToTexture` reads a level back out of this texture (three's texture atlas copies).
        key.usage = WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst | WGPUTextureUsage_CopySrc |
                    ((key.levels > 1 && !kCpuMipChain) || texture.external ? WGPUTextureUsage_RenderAttachment
                                                                           : WGPUTextureUsage_None);
    } else {
        key.texelBytes = 0;  // nothing is created until the texture has an image
    }
    return key;
}

WGPUTexture Renderer::createMaterialTexture(const MaterialTexture::Key& key) {
    WGPUTextureDescriptor desc = {};
    desc.dimension = key.volume ? WGPUTextureDimension_3D : WGPUTextureDimension_2D;
    desc.size = {key.width, key.height, key.depth};
    desc.format = key.format;
    desc.usage = key.usage;
    desc.mipLevelCount = key.levels;
    desc.sampleCount = 1;
    const WGPUTexture texture = wgpuDeviceCreateTexture(device_, &desc);
    // GpuResources::createTexture counts the handles it owns; a material map never passes through it, so
    // `?tnDebug=1` would report every one of these as zero bytes allocated and zero uploaded.
    waste::debugAdd(waste::counters().textureCreatedBytes, key.bytes());
    return texture;
}

// The one upload both the create path and an in-place update run, so a re-upload of the same extent writes
// exactly what the first upload wrote.
void Renderer::uploadMaterialTexture(WGPUTexture destination, const Texture& texture, const MaterialTexture::Key& key) {
    WGPUImageCopyTexture_Compat image = {};
    image.texture = destination;
    image.aspect = WGPUTextureAspect_All;
    WGPUTextureDataLayout_Compat layout = {};
    layout.bytesPerRow = texture.width * texture.bytesPerTexel();
    layout.rowsPerImage = texture.height;
    const WGPUExtent3D extent = {key.width, key.height, key.depth};
    const auto counted = [&] {
        textures_->uploadBytes += texture.data.size();
        waste::debugAdd(waste::counters().textureUploadBytes, texture.data.size());
    };
    if (texture.compressed()) {
        uploadCompressedLevels(destination, texture, 0, key.levels);
        return;
    }
    if (key.kind == MaterialTexture::kVolume) {
        if (texture.flipY) throw std::runtime_error("TN_NATIVE_TEXTURE_UNSUPPORTED: flipY on a Data3DTexture");
        if (!texture.dataReady) return;  // a RenderTarget3D's texels are written on the GPU
        const uint64_t expected = uint64_t(texture.width) * texture.height * texture.depth * texture.bytesPerTexel();
        if (texture.data.size() != expected) throw std::runtime_error("TN_NATIVE_TEXTURE_INVALID: RGBA volume byte count");
        gpu_.sync();  // ordered after any submit still on the GPU thread
        wgpuQueueWriteTexture(queue_, &image, texture.data.data(), texture.data.size(), &layout, &extent);
        counted();
        return;
    }
    if (key.kind == MaterialTexture::kExternal) {
        if (!textures_->copyExternal || texture.bytesPerTexel() != 4)
            throw std::runtime_error("TN_NATIVE_TEXTURE_UNSUPPORTED: a host image needs the host's copy and RGBA8");
        gpu_.sync();  // both uploads are queue work: ordered after any submit still on the GPU thread
        if (!textures_->copyExternal(texture.external->id, destination, texture.flipY))
            throw std::runtime_error("TN_NATIVE_TEXTURE_UPLOAD_FAILED: the host could not copy its image");
    } else {
        // A DataArrayTexture is `layers` 2D images stored one after another, each with its own mip chain.
        const uint32_t layers = key.array ? key.depth : 1;
        if (key.array && texture.flipY)
            throw std::runtime_error("TN_NATIVE_TEXTURE_UNSUPPORTED: flipY on a DataArrayTexture");
        const uint64_t expected = uint64_t(texture.width) * texture.height * layers * texture.bytesPerTexel();
        // `dataReady` false is a texture whose texels are written on the GPU (three's dataReady contract), so it
        // has no CPU image to validate or upload yet.
        if (texture.dataReady && texture.data.size() != expected)
            throw std::runtime_error("TN_NATIVE_TEXTURE_INVALID: RGBA image byte count");
        if (texture.dataReady) {
            std::vector<uint8_t> flipped;
            const uint8_t* pixels = texture.data.data();
            if (texture.flipY) {
                const size_t row = size_t(texture.width) * texture.bytesPerTexel();
                flipped.resize(texture.data.size());
                for (uint32_t y = 0; y < texture.height; ++y)
                    std::memcpy(flipped.data() + size_t(y) * row, texture.data.data() + size_t(texture.height - 1 - y) * row, row);
                pixels = flipped.data();
            }
            gpu_.sync();  // the upload is queue work: ordered after any submit still on the GPU thread
            wgpuQueueWriteTexture(queue_, &image, pixels, texture.data.size(), &layout, &extent);
            counted();
            if (kCpuMipChain && key.levels > 1) {
                const bool srgb = key.format == WGPUTextureFormat_RGBA8UnormSrgb;
                const size_t layerBytes = size_t(texture.width) * texture.height * 4;
                for (uint32_t layer = 0; layer < layers; ++layer) {
                    std::vector<uint8_t> level(pixels + layer * layerBytes, pixels + (layer + 1) * layerBytes);
                    uint32_t w = texture.width, h = texture.height;
                    for (uint32_t l = 1; l < key.levels; ++l) {
                        level = downsampleRgba8(level.data(), w, h, srgb);
                        w = w > 1 ? w / 2 : 1;
                        h = h > 1 ? h / 2 : 1;
                        WGPUImageCopyTexture_Compat mip = image;
                        mip.mipLevel = l;
                        mip.origin = {0, 0, layer};
                        WGPUTextureDataLayout_Compat mipLayout = {};
                        mipLayout.bytesPerRow = w * 4;
                        mipLayout.rowsPerImage = h;
                        const WGPUExtent3D mipExtent = {w, h, 1};
                        wgpuQueueWriteTexture(queue_, &mip, level.data(), level.size(), &mipLayout, &mipExtent);
                    }
                }
                return;
            }
        }
    }
    // A texture whose texels are written on the GPU (dataReady false) has none to build a chain from yet.
    if (key.levels > 1 && texture.dataReady)
        generateMipmaps(destination, key.format, key.levels, key.array ? key.depth : 1);
}

// A compressed texture's levels [first, end): 4x4 blocks of 16 bytes, each level written at its block-rounded
// size, as WebGPU's copy rules ask. three uploads a CompressedTexture unflipped, and so does this.
void Renderer::uploadCompressedLevels(WGPUTexture destination, const Texture& texture, uint32_t first, uint32_t end) {
    const bool bc7 = texture.imageSource->mipmapFormat == kTextureBC7Format;
    const WGPUFeatureName feature = bc7 ? WGPUFeatureName_TextureCompressionBC : WGPUFeatureName_TextureCompressionETC2;
    if (!wgpuDeviceHasFeature(device_, feature))
        throw std::runtime_error(std::string("TN_NATIVE_TEXTURE_UNSUPPORTED: ") + (bc7 ? "BC7" : "ETC2") +
                                 " needs the device feature " + (bc7 ? "texture-compression-bc" : "texture-compression-etc2"));
    if (texture.width % 4 != 0 || texture.height % 4 != 0)
        throw std::runtime_error("TN_NATIVE_TEXTURE_INVALID: a compressed texture's size must be a multiple of 4, not " +
                                 std::to_string(texture.width) + "x" + std::to_string(texture.height));
    gpu_.sync();  // the upload is queue work: ordered after any submit still on the GPU thread
    for (uint32_t level = first; level < end; ++level) {
        const TextureMipmap& mip = texture.mipmaps[level];
        const uint32_t blocksX = (mip.width + 3) / 4, blocksY = (mip.height + 3) / 4;
        const uint32_t expectedWidth = std::max(1u, texture.width >> level), expectedHeight = std::max(1u, texture.height >> level);
        if (mip.width != expectedWidth || mip.height != expectedHeight || mip.data.size() != size_t(blocksX) * blocksY * 16)
            throw std::runtime_error("TN_NATIVE_TEXTURE_INVALID: compressed level " + std::to_string(level) + " is " +
                                     std::to_string(mip.width) + "x" + std::to_string(mip.height) + ", " +
                                     std::to_string(mip.data.size()) + " bytes");
        WGPUImageCopyTexture_Compat image = {};
        image.texture = destination;
        image.aspect = WGPUTextureAspect_All;
        image.mipLevel = level;
        WGPUTextureDataLayout_Compat layout = {};
        layout.bytesPerRow = blocksX * 16;
        layout.rowsPerImage = blocksY;
        const WGPUExtent3D extent = {blocksX * 4, blocksY * 4, 1};
        wgpuQueueWriteTexture(queue_, &image, mip.data.data(), mip.data.size(), &layout, &extent);
        textures_->uploadBytes += mip.data.size();
        waste::debugAdd(waste::counters().textureUploadBytes, mip.data.size());
    }
}

const Renderer::MaterialTexture* Renderer::materialTexture(const Texture& texture) {
    // A render target's texture is that target's last render, borrowed from its own renderer; every other
    // texture answers from its own record below. Ask the weak_ptr which one this is before locking it: a
    // texture that never had a target holds no control block, and that is the shape most draws sample (FM3).
    if (!texture.renderTarget.expired()) {
        waste::debugAdd(waste::counters().textureTargetLocks);
        const auto target = std::static_pointer_cast<RenderTarget>(texture.renderTarget.lock());
        if (target) {
            MaterialTexture& sampled = renderTargetTextures_[texture.ident.value()];
            const WGPUTextureView view = renderTargetView(*this, *target);
            // three samples a target's texture with its own wrap and filters, as any other texture.
            if (sampled.view != view || sampled.key.wrapS != texture.wrapS || sampled.key.wrapT != texture.wrapT ||
                sampled.key.magFilter != texture.magFilter || sampled.key.minFilter != texture.minFilter) {
                if (sampled.view) dropMapGroups();  // a resized target's old view address may come back
                sampled.view = view;
                sampled.key.wrapS = texture.wrapS; sampled.key.wrapT = texture.wrapT;
                sampled.key.magFilter = texture.magFilter; sampled.key.minFilter = texture.minFilter;
                WGPUSamplerDescriptor sampler = {};  // one level: the mip filter never applies
                sampler.addressModeU = addressMode(texture.wrapS);
                sampler.addressModeV = addressMode(texture.wrapT);
                sampler.addressModeW = WGPUAddressMode_ClampToEdge;
                sampler.magFilter = filterMode(texture.magFilter);
                sampler.minFilter = filterMode(texture.minFilter);
                sampler.mipmapFilter = WGPUMipmapFilterMode_Nearest;
                sampler.maxAnisotropy = 1;
                sampler.lodMaxClamp = 32;
                sampled.sampler = samplerFor(sampler);
            }
            return &sampled;
        }
    }
    if (texture.storageTexture) (void)texture.storageFormat();
    // Match WebGPUTextureUtils: FloatType stays RGBA32Float, HalfFloatType RGBA16Float; sRGB byte
    // textures decode before filtering in the GPU, not after filtering in the material/PMREM shader.
    if (!texture.depthTexture && texture.isFloat() && !wgpuDeviceHasFeature(device_, WGPUFeatureName_Float32Filterable))
        throw std::runtime_error("TN_NATIVE_TEXTURE_UNSUPPORTED: FloatType requires float32-filterable");
    MaterialTexture& record = textures_->records[texture.ident.value()];
    if (record.view != nullptr && record.version == texture.version()) return &record;
    const MaterialTexture::Key key = materialTextureKey(texture);
    // three's `needsUpdate` on the same extent writes into the texture that is already here: its view, its
    // sampler, every bind group that bound them and every recorded bundle stay valid. Releasing the record
    // instead builds a new texture whose view can reuse the old one's address, so every group and bundle made
    // for that address is stale — a fog-of-war texture updated 20 times a second rebuilt all of them.
    if (record.view != nullptr && record.key == key && key.updatesInPlace()) {
        uploadMaterialTexture(record.texture, texture, key);
        record.version = texture.version();
        return &record;
    }
    if (record.view) texturesChanged();  // its old view's address may be reused by the new one
    record.release();
    if (key.kind != MaterialTexture::kNone) {
        record.texture = createMaterialTexture(key);
        if (key.kind != MaterialTexture::kStorage) uploadMaterialTexture(record.texture, texture, key);
        WGPUTextureViewDescriptor view = {};
        view.dimension = key.volume ? WGPUTextureViewDimension_3D
                        : key.cube ? WGPUTextureViewDimension_Cube
                        : key.array ? WGPUTextureViewDimension_2DArray : WGPUTextureViewDimension_2D;
        view.mipLevelCount = key.levels;
        view.arrayLayerCount = key.array ? key.depth : 1;
        view.format = key.format;
        record.view = wgpuTextureCreateView(record.texture, &view);
    }
    record.key = key;
    WGPUSamplerDescriptor sampler = {};
    if (key.kind == MaterialTexture::kDepth) {
        sampler.compare = WGPUCompareFunction_LessEqual;
        sampler.maxAnisotropy = 1;
    } else {
        sampler.addressModeU = addressMode(texture.wrapS);
        sampler.addressModeV = addressMode(texture.wrapT);
        sampler.addressModeW = addressMode(texture.wrapR);
        sampler.magFilter = filterMode(texture.magFilter);
        sampler.minFilter = filterMode(texture.minFilter);
        // NearestMipmapLinear and LinearMipmapLinear blend between two levels, the other filters take one.
        sampler.mipmapFilter = texture.minFilter == static_cast<uint16_t>(TextureFilter::NearestMipmapLinear) ||
                                       texture.minFilter == static_cast<uint16_t>(TextureFilter::LinearMipmapLinear)
                                   ? WGPUMipmapFilterMode_Linear : WGPUMipmapFilterMode_Nearest;
        sampler.lodMaxClamp = 32;  // a zeroed C descriptor clamps the level of detail to 0, which hides the chain
        // WebGPUTextureUtils: anisotropy only when every filter is linear; WebGPU clamps it to 16.
        sampler.maxAnisotropy = sampler.magFilter == WGPUFilterMode_Linear && sampler.minFilter == WGPUFilterMode_Linear &&
                                        sampler.mipmapFilter == WGPUMipmapFilterMode_Linear
                                    ? static_cast<uint16_t>(std::min(texture.anisotropy, 16.0))
                                    : 1;
    }
    record.sampler = samplerFor(sampler);
    record.version = texture.version();
    return &record;
}

// CubeMapNode / CubeRenderTarget.fromEquirectangularTexture, three r185. The six camera
// rotations and negative 90-degree FOV are CubeCamera's WebGPU branch. Level 0 is enough for
// Background.js's sharp sky (backgroundBlurriness=0); environment lighting uses PMREM separately.
Renderer::BackgroundCube& Renderer::backgroundCube(const Texture& texture) {
    if (texture.mapping != 303 || !texture.hasImage() || texture.format != kTextureRGBAFormat ||
        (texture.type != kTextureFloatType && texture.type != kTextureHalfFloatType && texture.type != kTextureUnsignedByteType) ||
        uint64_t(texture.width) * texture.height * texture.bytesPerTexel() != texture.data.size())
        throw std::runtime_error("TN_NATIVE_BACKGROUND_INVALID: decoded RGBA equirectangular pixels required");
    auto& cube = backgroundCubes_[texture.ident.value()];
    if (cube.view && cube.version == texture.version()) return cube;
    if (cube.view) wgpuTextureViewRelease(cube.view);
    if (cube.texture) wgpuTextureRelease(cube.texture);
    if (cube.sampler) wgpuSamplerRelease(cube.sampler);
    cube = {};
    const auto* source = materialTexture(texture);
    if (!source->view) throw std::runtime_error("TN_NATIVE_BACKGROUND_UPLOAD_FAILED");
    const auto format = texture.isFloat() ? WGPUTextureFormat_RGBA32Float
        : texture.isHalfFloat() ? WGPUTextureFormat_RGBA16Float : texture.isSRGB()
        ? WGPUTextureFormat_RGBA8UnormSrgb : WGPUTextureFormat_RGBA8Unorm;
    WGPUTextureDescriptor desc{};
    desc.dimension = WGPUTextureDimension_2D; desc.size = {texture.height, texture.height, 6};
    desc.format = format; desc.mipLevelCount = 1; desc.sampleCount = 1;
    desc.usage = WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_TextureBinding;
    cube.texture = wgpuDeviceCreateTexture(device_, &desc);
    WGPUTextureViewDescriptor view{};
    view.dimension = WGPUTextureViewDimension_Cube; view.arrayLayerCount = 6; view.mipLevelCount = 1;
    cube.view = wgpuTextureCreateView(cube.texture, &view);
    WGPUSamplerDescriptor sampler{};
    sampler.magFilter = filterMode(texture.magFilter); sampler.minFilter = filterMode(texture.minFilter);
    sampler.addressModeU = sampler.addressModeV = sampler.addressModeW = WGPUAddressMode_ClampToEdge;
    sampler.maxAnisotropy = 1;
    cube.sampler = wgpuDeviceCreateSampler(device_, &sampler);

    const auto conversion = shader::buildEquirectangularCube();
    const auto vs = shader::buildStage(conversion.vertex, 0), fs = shader::buildStage(conversion.fragment, 0);
    if (!vs.wgsl.ok() || !fs.wgsl.ok()) throw std::runtime_error("TN_NATIVE_SHADER_INVALID: equirectangular cube conversion");
    PipelineTarget target{format, WGPUTextureFormat_Undefined, WGPUCullMode_None};
    const auto pipeline = pipelines_->get(vs, &fs, target);
    if (!pipeline) throw std::runtime_error("TN_NATIVE_PIPELINE_REFUSED: background cube conversion");
    const auto layout = wgpuRenderPipelineGetBindGroupLayout(pipeline, 0);
    const Vector3 directions[6] = {{-1,0,0}, {1,0,0}, {0,1,0}, {0,-1,0}, {0,0,1}, {0,0,-1}};
    const Vector3 ups[6] = {{0,-1,0}, {0,-1,0}, {0,0,1}, {0,0,-1}, {0,-1,0}, {0,-1,0}};
    Handle uniforms[6];
    auto encoder = wgpuDeviceCreateCommandEncoder(device_, nullptr);
    for (uint32_t face = 0; face < 6; ++face) {
        Matrix4 rotation;
        rotation.lookAt(Vector3{}, directions[face], ups[face]); // detached camera destruction would invalidate live joint plans
        std::vector<uint8_t> block(fs.uniformBlockSize, 0); put(block, fs, "cubeRotation", rotation.elements);
        uniforms[face] = gpu_.createBuffer(block.size(), WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst);
        gpu_.writeBuffer(uniforms[face], 0, block.data(), block.size());
        const auto group = bindGroup(layout, fs, uniforms[face], nullptr, nullptr, source->view, source->sampler);
        WGPUTextureViewDescriptor faceView{};
        faceView.dimension = WGPUTextureViewDimension_2D; faceView.baseArrayLayer = face;
        faceView.arrayLayerCount = 1; faceView.mipLevelCount = 1;
        const auto destination = wgpuTextureCreateView(cube.texture, &faceView);
        WGPURenderPassColorAttachment color{};
        color.view = destination; color.loadOp = WGPULoadOp_Clear; color.storeOp = WGPUStoreOp_Store;
#if defined(MYSTRAL_WEBGPU_DAWN)
        color.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
#endif
        WGPURenderPassDescriptor passDesc{}; passDesc.colorAttachmentCount = 1; passDesc.colorAttachments = &color;
        const auto pass = beginTimedRenderPass(encoder, &passDesc);
        wgpuRenderPassEncoderSetPipeline(pass, pipeline); wgpuRenderPassEncoderSetBindGroup(pass, 0, group, 0, nullptr);
        wgpuRenderPassEncoderDraw(pass, 3, 1, 0, 0); wgpuRenderPassEncoderEnd(pass);
        wgpuRenderPassEncoderRelease(pass); wgpuTextureViewRelease(destination); wgpuBindGroupRelease(group);
    }
    submit(wgpuCommandEncoderFinish(encoder, nullptr)); wgpuCommandEncoderRelease(encoder);
    for (auto handle : uniforms) gpu_.destroy(handle);
    wgpuBindGroupLayoutRelease(layout);
    cube.version = texture.version();
    return cube;
}

void Renderer::dropBundles() {
    for (WGPURenderBundle* bundle :
         {&mainBundle_, &tailBundle_, &viewportBundle_, &auxBundle_, &velocityBundle_, &mainDelta_, &auxDelta_, &velocityDelta_,
          &auxTail_, &velocityTail_}) {
        if (*bundle) wgpuRenderBundleRelease(*bundle);
        *bundle = nullptr;
    }
    for (ShadowBundle& shadow : shadowBundles_)
        if (shadow.bundle) wgpuRenderBundleRelease(shadow.bundle);
    shadowBundles_.clear();
    if (features().stableRows)
        for (auto* rows : {&mainRows_, &auxRows_, &velocityRows_})
            if (*rows) (*rows)->clear();  // the bundles kept their objects alive
}

void Renderer::releaseMaterialTextures() {
    dropBundles();
    for (auto& [texture, cube] : backgroundCubes_) {
        if (cube.view) wgpuTextureViewRelease(cube.view);
        if (cube.texture) wgpuTextureRelease(cube.texture);
        if (cube.sampler) wgpuSamplerRelease(cube.sampler);
    }
    backgroundCubes_.clear();
    for (auto& [key, group] : mapGroups_)
        if (group) wgpuBindGroupRelease(group);
    mapGroups_.clear();
}

void Renderer::dropMapGroups() {
    // A bind group is cached by the address of the views it binds; a view released here can come back
    // at the same address.
    dropBundles();
    for (auto& [key, group] : mapGroups_)
        if (group) wgpuBindGroupRelease(group);
    mapGroups_.clear();
    ++groupEpoch_;
}

void Renderer::texturesChanged() {
    dropMapGroups();
    texturesSeen_ = ++textures_->generation;
}

void Renderer::MaterialTexture::release() {
    if (view) wgpuTextureViewRelease(view);
    if (texture) wgpuTextureRelease(texture);
    // The sampler is shared by descriptor and owned by the store's cache; it is not released here.
    sampler = nullptr;
    *this = MaterialTexture{};
}

WGPUSampler Renderer::samplerFor(const WGPUSamplerDescriptor& descriptor) {
    // The full descriptor is the key, so a changed filter, wrap, anisotropy, compare or LOD clamp
    // yields a different sampler instead of a stale one. Floats compare by their bit pattern.
    std::string key;
    key.reserve(48);
    const auto add = [&key](uint64_t v) {
        for (int i = 0; i < 8; ++i) key.push_back(char((v >> (i * 8)) & 0xff));
    };
    add(uint64_t(uint32_t(descriptor.addressModeU)) | uint64_t(uint32_t(descriptor.addressModeV)) << 8 |
        uint64_t(uint32_t(descriptor.addressModeW)) << 16 | uint64_t(uint32_t(descriptor.magFilter)) << 24 |
        uint64_t(uint32_t(descriptor.minFilter)) << 32 | uint64_t(uint32_t(descriptor.mipmapFilter)) << 40 |
        uint64_t(uint32_t(descriptor.compare)) << 48);
    add(std::bit_cast<uint32_t>(descriptor.lodMinClamp) | uint64_t(std::bit_cast<uint32_t>(descriptor.lodMaxClamp)) << 32);
    add(uint64_t(descriptor.maxAnisotropy));
    if (const auto found = textures_->samplers.find(key); found != textures_->samplers.end()) return found->second;
    ++samplersCreated_;
    return textures_->samplers.emplace(std::move(key), wgpuDeviceCreateSampler(device_, &descriptor)).first->second;
}

Renderer::MaterialTextureStore::~MaterialTextureStore() {
    for (auto& [id, record] : records) record.release();
    for (auto& [key, sampler] : samplers)
        if (sampler) wgpuSamplerRelease(sampler);
}

void Renderer::sweepTextures() {
    const auto retired = retired_->take();
    if (retired.empty()) return;
    // This renderer receives every texture retirement, including textures it never cached, so drop
    // its groups only when it is about to release one it did cache.
    bool groupsDropped = false;
    const auto dropGroups = [&] {
        if (groupsDropped) return;
        groupsDropped = true;
        dropMapGroups();
    };
    for (const uint64_t id : retired) {
        if (const auto cube = backgroundCubes_.find(id); cube != backgroundCubes_.end()) {
            dropGroups();
            if (cube->second.view) wgpuTextureViewRelease(cube->second.view);
            if (cube->second.texture) wgpuTextureRelease(cube->second.texture);
            if (cube->second.sampler) wgpuSamplerRelease(cube->second.sampler);
            backgroundCubes_.erase(cube);
        }
        if (const auto env = environments_.find(id); env != environments_.end()) {
            dropGroups();
            if (envPrep_ && envPrep_->ident == id) abandonEnvironment();  // a disposed source never publishes
            EnvironmentGpu& e = env->second;
            for (WGPUTextureView view : e.targetViews)
                if (view) wgpuTextureViewRelease(view);
            for (WGPUTextureView view : e.sourceViews)
                if (view) wgpuTextureViewRelease(view);
            if (e.view) wgpuTextureViewRelease(e.view);
            if (e.sourceView) wgpuTextureViewRelease(e.sourceView);
            if (e.texture) wgpuTextureRelease(e.texture);
            if (e.sourceCube) wgpuTextureRelease(e.sourceCube);
            if (e.sampler) wgpuSamplerRelease(e.sampler);
            if (e.blitSampler) wgpuSamplerRelease(e.blitSampler);
            environments_.erase(env);
        }
        if (const auto record = textures_->records.find(id); record != textures_->records.end()) {
            record->second.release();
            textures_->records.erase(record);
            texturesChanged();  // drops the groups that bound the released view
        }
    }
}

void Renderer::releaseEnvironments() {
    abandonEnvironment();  // release the in-flight packet's bind group before the shared buffers go
    for (auto& [texture, env] : environments_) {
        for (WGPUTextureView view : env.targetViews)
            if (view) wgpuTextureViewRelease(view);
        for (WGPUTextureView view : env.sourceViews)
            if (view) wgpuTextureViewRelease(view);
        if (env.view) wgpuTextureViewRelease(env.view);
        if (env.sourceView) wgpuTextureViewRelease(env.sourceView);
        if (env.texture) wgpuTextureRelease(env.texture);
        if (env.sourceCube) wgpuTextureRelease(env.sourceCube);
        if (env.sampler) wgpuSamplerRelease(env.sampler);
        if (env.blitSampler) wgpuSamplerRelease(env.blitSampler);
    }
    environments_.clear();
    if (envEquirectPipeline_) wgpuRenderPipelineRelease(envEquirectPipeline_);
    if (envMipPipeline_) wgpuRenderPipelineRelease(envMipPipeline_);
    if (envGgxPipeline_) wgpuRenderPipelineRelease(envGgxPipeline_);
    if (envIntegrationPipeline_) wgpuRenderPipelineRelease(envIntegrationPipeline_);
    if (envPipelineLayout_) wgpuPipelineLayoutRelease(envPipelineLayout_);
    if (envCubePipelineLayout_) wgpuPipelineLayoutRelease(envCubePipelineLayout_);
    if (envLayout_) wgpuBindGroupLayoutRelease(envLayout_);
    if (envCubeLayout_) wgpuBindGroupLayoutRelease(envCubeLayout_);
    envEquirectPipeline_ = envMipPipeline_ = envGgxPipeline_ = envIntegrationPipeline_ = nullptr;
    envPipelineLayout_ = envCubePipelineLayout_ = nullptr;
    envLayout_ = envCubeLayout_ = nullptr;
}

void Renderer::buildEnvironmentPipelines() {
    if (envGgxPipeline_) return;
    // Every pass binds the packet's uniform slice, the source texture and a sampler; the source is a
    // 2D view of the equirect shape (the conversion, the mip chain) or the cube (the GGX convolution,
    // the integration tail), and the two cannot share a layout.
    const auto makeLayout = [&](WGPUTextureViewDimension dimension) {
        WGPUBindGroupLayoutEntry entries[3] = {};
        entries[0].binding = 0;
        entries[0].visibility = WGPUShaderStage_Vertex | WGPUShaderStage_Fragment;
        entries[0].buffer.type = WGPUBufferBindingType_Uniform;
        entries[0].buffer.minBindingSize = kEnvUniformSize;
        entries[1].binding = 1;
        entries[1].visibility = WGPUShaderStage_Fragment;
        entries[1].texture.sampleType = WGPUTextureSampleType_Float;
        entries[1].texture.viewDimension = dimension;
        entries[2].binding = 2;
        entries[2].visibility = WGPUShaderStage_Fragment;
        entries[2].sampler.type = WGPUSamplerBindingType_Filtering;
        WGPUBindGroupLayoutDescriptor layoutDesc = {};
        layoutDesc.entryCount = 3;
        layoutDesc.entries = entries;
        return wgpuDeviceCreateBindGroupLayout(device_, &layoutDesc);
    };
    envLayout_ = makeLayout(WGPUTextureViewDimension_2D);
    envCubeLayout_ = makeLayout(WGPUTextureViewDimension_Cube);
    WGPUPipelineLayoutDescriptor pipelineLayoutDesc = {};
    pipelineLayoutDesc.bindGroupLayoutCount = 1;
    pipelineLayoutDesc.bindGroupLayouts = &envLayout_;
    envPipelineLayout_ = wgpuDeviceCreatePipelineLayout(device_, &pipelineLayoutDesc);
    pipelineLayoutDesc.bindGroupLayouts = &envCubeLayout_;
    envCubePipelineLayout_ = wgpuDeviceCreatePipelineLayout(device_, &pipelineLayoutDesc);

    // WebGPUTexturePassUtils' faces are one oversized triangle (`@builtin(vertex_index)`), so none of
    // these passes reads a vertex buffer.
    auto pipeline = [&](const std::string& code, WGPUPipelineLayout layout) {
        WGPUShaderModuleWGSLDescriptor_Compat wgsl = {};
        WGPUShaderModuleDescriptor shaderDesc = {};
        setupShaderModuleWGSL(&shaderDesc, &wgsl, code.c_str());
        WGPUShaderModule module = wgpuDeviceCreateShaderModule(device_, &shaderDesc);
        WGPUColorTargetState color = {};
        color.format = WGPUTextureFormat_RGBA16Float;
        color.writeMask = WGPUColorWriteMask_All;
        WGPUFragmentState fragmentState = {};
        fragmentState.module = module;
        WGPU_SET_ENTRY_POINT(fragmentState, "fs");
        fragmentState.targetCount = 1;
        fragmentState.targets = &color;
        WGPURenderPipelineDescriptor desc = {};
        desc.layout = layout;
        desc.vertex.module = module;
        WGPU_SET_ENTRY_POINT(desc.vertex, "vs");
        desc.primitive.topology = WGPUPrimitiveTopology_TriangleList;
        desc.primitive.cullMode = WGPUCullMode_None;
        desc.primitive.frontFace = WGPUFrontFace_CCW;
        desc.multisample.count = 1;
        desc.multisample.mask = 0xffffffffu;
        desc.fragment = &fragmentState;
        WGPURenderPipeline created = wgpuDeviceCreateRenderPipeline(device_, &desc);
        wgpuShaderModuleRelease(module);
        return created;
    };
    const std::string prelude = kPmremPrelude;
    envEquirectPipeline_ = pipeline(prelude + kPmremEquirect, envPipelineLayout_);
    envMipPipeline_ = pipeline(prelude + kPmremMip, envPipelineLayout_);
    envGgxPipeline_ = pipeline(prelude + kPmremGgx, envCubePipelineLayout_);
    envIntegrationPipeline_ = pipeline(prelude + kPmremIntegration, envCubePipelineLayout_);
}

// One face in fragment samples: a GGX face reads 256 source taps a pixel, an integration face every
// texel of a 16px mip over three faces, the equirect conversion four taps, a mip chain step one.
uint64_t Renderer::pmremPacketCost(const PmremPacket& packet) {
    return uint64_t(packet.width) * uint64_t(packet.height) * packet.samples;
}

void Renderer::beginEnvironment(const Texture& equirect) {
    if (equirect.mapping != 303)
        throw std::runtime_error("TN_NATIVE_ENVIRONMENT_UNSUPPORTED: requires EquirectangularReflectionMapping");
    if (equirect.width < 64 || !equirect.hasImage() || equirect.format != kTextureRGBAFormat ||
        (equirect.type != kTextureFloatType && equirect.type != kTextureHalfFloatType && equirect.type != kTextureUnsignedByteType) ||
        uint64_t(equirect.width) * equirect.height * equirect.bytesPerTexel() != equirect.data.size())
        throw std::runtime_error("TN_NATIVE_ENVIRONMENT_INVALID: requires decoded RGBA equirectangular pixels, width >= 64");
    abandonEnvironment();  // one active preparation globally: envUniforms_ is shared
    EnvironmentGpu& env = environments_[equirect.ident.value()];
    for (WGPUTextureView view : env.targetViews)
        if (view) wgpuTextureViewRelease(view);
    for (WGPUTextureView view : env.sourceViews)
        if (view) wgpuTextureViewRelease(view);
    if (env.view) wgpuTextureViewRelease(env.view);
    if (env.sourceView) wgpuTextureViewRelease(env.sourceView);
    if (env.texture) wgpuTextureRelease(env.texture);
    if (env.sourceCube) wgpuTextureRelease(env.sourceCube);
    if (env.sampler) wgpuSamplerRelease(env.sampler);
    if (env.blitSampler) wgpuSamplerRelease(env.blitSampler);
    env = EnvironmentGpu{};
    env.source = &equirect;
    env.version = equirect.version();
    env.ready = false;  // a re-bake never reads as ready until its last packet completes
    const MaterialTexture* source = materialTexture(equirect);
    if (source->view == nullptr) throw std::runtime_error("TN_NATIVE_ENVIRONMENT_UPLOAD_FAILED");
    // PMREMGenerator._setSize (:344): an equirect's cube size is image.width / 4, floored to a power
    // of two and no smaller than MIN_SIZE (:29), so a 64x32 sky is upsampled to a 256 cube.
    uint32_t cubeSize = std::max(equirect.width / 4, 1u);
    uint32_t sizeLog2 = 0;
    while ((2u << sizeLog2) <= cubeSize) ++sizeLog2;
    cubeSize = std::max(1u << sizeLog2, kPmremMinSize);
    env.cubeSize = cubeSize;
    // _allocateTarget (:371): one mip per roughness step, the roughest LOD_MIN steps down from the
    // face size (256 -> mips 0..5 at 256, 128, 64, 32, 16, 8).
    env.maxLod = std::max(uint32_t(std::bit_width(cubeSize) - 1), kPmremLodMin) - kPmremLodMin;
    const uint32_t sourceMips = uint32_t(std::bit_width(cubeSize) - 1) + 1;
    const float sourceLod = float(std::bit_width(cubeSize) - 1 - uint32_t(std::bit_width(kPmremIntegrationSize) - 1));

    // The cube three renders into and filters from (HalfFloatType, LinearMipmapLinearFilter, a full
    // mip chain: the GGX convolution reads it at the lod each sample's solid angle needs).
    const auto createCube = [&](uint32_t mipLevels) {
        WGPUTextureDescriptor desc = {};
        desc.dimension = WGPUTextureDimension_2D;
        desc.size = {cubeSize, cubeSize, 6};
        desc.format = WGPUTextureFormat_RGBA16Float;
        desc.mipLevelCount = mipLevels;
        desc.sampleCount = 1;
        desc.usage = WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_TextureBinding;
        return wgpuDeviceCreateTexture(device_, &desc);
    };
    env.texture = createCube(env.maxLod + 1);
    env.sourceCube = createCube(sourceMips);
    const auto cubeView = [&](WGPUTexture texture, uint32_t mips) {
        WGPUTextureViewDescriptor desc = {};
        desc.dimension = WGPUTextureViewDimension_Cube;
        desc.arrayLayerCount = 6;
        desc.mipLevelCount = mips;
        return wgpuTextureCreateView(texture, &desc);
    };
    env.view = cubeView(env.texture, env.maxLod + 1);
    env.sourceView = cubeView(env.sourceCube, sourceMips);
    // One 2D view per face of each mip, the attachment a pass renders into.
    const auto faceViews = [](WGPUTexture texture, uint32_t mips) {
        std::vector<WGPUTextureView> views;
        views.reserve(size_t(mips) * 6);
        for (uint32_t mip = 0; mip < mips; ++mip)
            for (uint32_t face = 0; face < 6; ++face) {
                WGPUTextureViewDescriptor desc = {};
                desc.dimension = WGPUTextureViewDimension_2D;
                desc.baseMipLevel = mip;
                desc.mipLevelCount = 1;
                desc.baseArrayLayer = face;
                desc.arrayLayerCount = 1;
                views.push_back(wgpuTextureCreateView(texture, &desc));
            }
        return views;
    };
    env.targetViews = faceViews(env.texture, env.maxLod + 1);
    env.sourceViews = faceViews(env.sourceCube, sourceMips);

    // Both cubes are read through a trilinear clamp sampler with the whole chain reachable:
    // CubeRenderTarget's LinearMipmapLinearFilter, and a zeroed C descriptor would clamp lod to 0.
    const auto sampler = [&](WGPUMipmapFilterMode mipmap) {
        WGPUSamplerDescriptor desc = {};
        desc.magFilter = desc.minFilter = WGPUFilterMode_Linear;
        desc.mipmapFilter = mipmap;
        desc.addressModeU = desc.addressModeV = desc.addressModeW = WGPUAddressMode_ClampToEdge;
        desc.maxAnisotropy = 1;
        desc.lodMaxClamp = 32;
        return wgpuDeviceCreateSampler(device_, &desc);
    };
    env.sampler = sampler(WGPUMipmapFilterMode_Linear);
    env.blitSampler = sampler(WGPUMipmapFilterMode_Nearest);
    buildEnvironmentPipelines();

    // Three's order: the equirect becomes the source cube's level 0, the source cube grows its mip
    // chain, then every PMREM mip is filtered from it. Each is one face of one target per packet.
    struct Pass {
        WGPUTextureView target;
        WGPUTextureView source;
        WGPUSampler sampler;
        WGPURenderPipeline pipeline;
        uint32_t size;
        uint32_t samples;
        float roughness, lodBias, sourceLod;
        uint32_t face;
    };
    std::vector<Pass> passes;
    passes.reserve(6 + 6 * (size_t(sourceMips) - 1) + 6 * size_t(env.maxLod + 1));
    for (uint32_t face = 0; face < 6; ++face)
        passes.push_back({env.sourceViews[face], source->view, source->sampler, envEquirectPipeline_,
                          cubeSize, 4, 0.0f, 0.0f, 0.0f, face});
    for (uint32_t mip = 1; mip < sourceMips; ++mip) {
        const uint32_t size = cubeSize >> mip;
        for (uint32_t face = 0; face < 6; ++face)
            passes.push_back({env.sourceViews[size_t(mip) * 6 + face], env.sourceViews[size_t(mip - 1) * 6 + face],
                              env.blitSampler, envMipPipeline_, size, 1, 0.0f, 0.0f, 0.0f, face});
    }
    for (uint32_t lod = 0; lod <= env.maxLod; ++lod) {
        // lodToRoughness (:336): 1 - sqrt(1 - lod/maxLod); the last INTEGRATION_LEVELS integrate a
        // 16px source mip instead of importance sampling. lodBias (:514) matches the source texel
        // solid angle to 1 / (GGX_SAMPLES * pdf), with a half-mip bias against sampling noise.
        const float roughness = float(1.0 - std::sqrt(1.0 - double(lod) / double(env.maxLod)));
        const bool integrate = lod > env.maxLod - kPmremIntegrationLevels;
        const double bias = roughness > 0.0f
            ? std::log2(double(cubeSize)) + 0.5 * std::log2(6.0 / (kPmremGgxSamples * std::pow(double(roughness), 4.0))) + 0.5
            : 0.0;
        const uint32_t size = cubeSize >> lod;
        for (uint32_t face = 0; face < 6; ++face)
            passes.push_back({env.targetViews[size_t(lod) * 6 + face], env.sourceView, env.sampler,
                              integrate ? envIntegrationPipeline_ : envGgxPipeline_, size,
                              // Roughness 0 reads one texel (kPmremGgx's roughness < 0.001 branch), not 256.
                              integrate ? kPmremIntegrationSize * kPmremIntegrationSize * 3u
                                        : roughness < 0.001f ? 1u : kPmremGgxSamples,
                              roughness, float(bias), sourceLod, face});
    }

    const uint64_t stride = aligned(kEnvUniformSize);
    const uint64_t total = stride * passes.size();
    if (envUniforms_.type == 0 || envUniformCapacity_ < total) {
        if (envUniforms_.type != 0) gpu_.destroy(envUniforms_);
        envUniformCapacity_ = std::max<uint64_t>(total, 4096);
        envUniforms_ = gpu_.createBuffer(envUniformCapacity_, WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst);
    }
    // PMREMGenerator's material draws a 5x5x5 box from inside: the face's direction is the box
    // position, which is CubeCamera's view matrix applied to the ray through the face texel
    // (backgroundCube's rotations, so both cubes share one orientation).
    const Vector3 directions[6] = {{-1, 0, 0}, {1, 0, 0}, {0, 1, 0}, {0, -1, 0}, {0, 0, 1}, {0, 0, -1}};
    const Vector3 ups[6] = {{0, -1, 0}, {0, -1, 0}, {0, 0, 1}, {0, 0, -1}, {0, -1, 0}, {0, -1, 0}};
    std::array<Matrix4, 6> rotations;
    for (uint32_t face = 0; face < 6; ++face) rotations[face].lookAt(Vector3{}, directions[face], ups[face]);
    std::vector<float> uniforms(envUniformCapacity_ / 4, 0.0f);
    for (std::size_t p = 0; p < passes.size(); ++p) {
        float* slice = uniforms.data() + (p * stride) / 4;
        slice[0] = passes[p].roughness;
        slice[1] = passes[p].lodBias;
        slice[2] = passes[p].sourceLod;
        for (uint32_t c = 0; c < 16; ++c) slice[4 + c] = float(rotations[passes[p].face].elements[c]);
    }
    gpu_.writeBuffer(envUniforms_, 0, uniforms.data(), uniforms.size() * 4);

    // Retain every full-quality packet; pumpEnvironment submits one cost-bounded group per call,
    // only after the previous group's completion serial is observed. Never enqueue them all.
    EnvironmentPreparation prep;
    prep.ident = equirect.ident.value();
    prep.version = env.version;
    prep.source = &equirect;
    prep.stride = stride;
    prep.packets.reserve(passes.size());
    for (std::size_t p = 0; p < passes.size(); ++p)
        prep.packets.push_back({passes[p].target, passes[p].source, passes[p].sampler, passes[p].pipeline,
                                passes[p].size, passes[p].size, passes[p].samples, uint32_t(p)});
    for (const PmremPacket& packet : prep.packets) prep.heaviest = std::max(prep.heaviest, pmremPacketCost(packet));
    prep.budget = prep.heaviest;
    envPrep_ = std::move(prep);
}
void Renderer::abandonEnvironment() {
    if (!envPrep_) return;
    if (envPrep_->group) wgpuBindGroupRelease(envPrep_->group);
    envPrep_.reset();
}

bool Renderer::pumpEnvironment() {
    if (!envPrep_) return true;
    EnvironmentPreparation& prep = *envPrep_;
    const Texture* source = prep.source;
    // A version change or a disposal must never publish a stale or partial target: abandon and let
    // the next frame re-prepare from the live source.
    if (source == nullptr || source->version() != prep.version) {
        abandonEnvironment();
        return false;
    }
    // Advance one packet only once the previous submission's completion is observed.
    if (prep.next > 0 && gpu_.completedSerial() < prep.awaitSerial) {
        ++prep.waits;
        return false;
    }
    if (prep.next >= prep.packets.size()) {
        if (const auto found = environments_.find(prep.ident);
            found != environments_.end() && found->second.version == prep.version)
            found->second.ready = true;
        abandonEnvironment();
        return true;
    }
    // One frame carries packets up to the budget (fragments x samples). It starts at the heaviest single packet, so
    // the cheap low-LOD packets share frames, and doubles after each group the GPU finished by the next frame: every
    // group costs a completion round trip (about two frames), and a GPU that keeps up needs 4 groups for a 512 cube,
    // not 10 (PRD-860). It stops at 4x the heaviest packet, and a slow group (a software adapter) puts it back.
    constexpr uint64_t kPmremBudgetGrowth = 4;
    if (prep.next > 0)
        prep.budget = prep.waits <= 1 ? std::min(prep.budget * 2, prep.heaviest * kPmremBudgetGrowth) : prep.heaviest;
    prep.waits = 0;
    uint64_t spent = 0;
    do {
    const PmremPacket& packet = prep.packets[prep.next];
    spent += pmremPacketCost(packet);
    if (prep.groupUniform != packet.uniform) {
        if (prep.group) wgpuBindGroupRelease(prep.group);
        // The uniform carries this face's rotation, so every packet has its own slice and group; the
        // source's view dimension picks which layout the packet's pipeline was built against.
        WGPUBindGroupEntry entries[3] = {};
        entries[0].binding = 0;
        entries[0].buffer = gpu_.buffer(envUniforms_);
        entries[0].offset = packet.uniform * prep.stride;
        entries[0].size = kEnvUniformSize;
        entries[1].binding = 1;
        entries[1].textureView = packet.source;
        entries[2].binding = 2;
        entries[2].sampler = packet.sampler;
        WGPUBindGroupDescriptor groupDesc = {};
        groupDesc.layout = packet.pipeline == envEquirectPipeline_ || packet.pipeline == envMipPipeline_
                               ? envLayout_ : envCubeLayout_;
        groupDesc.entryCount = 3;
        groupDesc.entries = entries;
        prep.group = createBindGroup(device_, &groupDesc);
        prep.groupUniform = packet.uniform;
    }
    WGPUCommandEncoderDescriptor encoderDesc = {};
    WGPUCommandEncoder encoder = wgpuDeviceCreateCommandEncoder(device_, &encoderDesc);
    WGPURenderPassColorAttachment color = {};
    color.view = packet.target;
    color.loadOp = WGPULoadOp_Clear;  // every packet writes a whole face, and nothing else writes it
    color.storeOp = WGPUStoreOp_Store;
    color.clearValue = {0, 0, 0, 1};
#if defined(MYSTRAL_WEBGPU_DAWN)
    color.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
#endif
    WGPURenderPassDescriptor passDesc = {};
    passDesc.colorAttachmentCount = 1;
    passDesc.colorAttachments = &color;
    WGPURenderPassEncoder pass = beginTimedRenderPass(encoder, &passDesc);
    wgpuRenderPassEncoderSetPipeline(pass, packet.pipeline);
    wgpuRenderPassEncoderSetBindGroup(pass, 0, prep.group, 0, nullptr);
    wgpuRenderPassEncoderDraw(pass, 3, 1, 0, 0);  // one oversized triangle covers the face
    wgpuRenderPassEncoderEnd(pass);
    wgpuRenderPassEncoderRelease(pass);
    WGPUCommandBufferDescriptor commandDesc = {};
    prep.awaitSerial = submit(wgpuCommandEncoderFinish(encoder, &commandDesc));
    wgpuCommandEncoderRelease(encoder);
    ++prep.next;
    } while (prep.next < prep.packets.size() && spent + pmremPacketCost(prep.packets[prep.next]) <= prep.budget);
    if (prep.next >= prep.packets.size() && gpu_.completedSerial() >= prep.awaitSerial) {
        if (const auto found = environments_.find(prep.ident);
            found != environments_.end() && found->second.version == prep.version)
            found->second.ready = true;
        abandonEnvironment();
        return true;
    }
    return false;
}

bool Renderer::prepareEnvironments(std::span<const DrawItem> items) {
    environmentPending_ = !advanceEnvironments(items);
    return !environmentPending_;
}

bool Renderer::advanceEnvironments(std::span<const DrawItem> items) {
    sweepTextures();  // a retired source must not keep a preparation reading a dead view
    // The active bake advances on every call, sampled by this pass or not: a render-target or
    // secondary pass that does not sample it must not discard its progress. Only a version change
    // or a disposal abandons it (pumpEnvironment, sweepTextures).
    if (envPrep_ && !pumpEnvironment()) {
        for (const DrawItem& item : items)
            for (const Texture* texture : {item.envMap, item.pmremMap}) {
                if (texture == nullptr) continue;
                const auto found = environments_.find(texture->ident.value());
                if (found == environments_.end() || !found->second.ready || found->second.version != texture->version())
                    return false;  // this pass samples an environment that is not baked yet
            }
        return true;
    }
    for (const DrawItem& item : items) {
        for (const Texture* texture : {item.envMap, item.pmremMap}) {
            if (texture == nullptr) continue;
            EnvironmentGpu& env = environments_[texture->ident.value()];
            if (env.ready && env.version == texture->version()) continue;
            beginEnvironment(*texture);
            return pumpEnvironment();
        }
    }
    return true;
}

Renderer::EnvironmentGpu& Renderer::environment(const Texture& equirect) {
    // Ready-only accessor: prepareEnvironments must have baked and published this environment.
    if (const auto found = environments_.find(equirect.ident.value());
        found != environments_.end() && found->second.ready && found->second.version == equirect.version())
        return found->second;
    throw std::runtime_error("TN_NATIVE_ENVIRONMENT_NOT_READY");
}

}  // namespace tn::engine
