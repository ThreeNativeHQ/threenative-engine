#include "renderer.h"
#include "engine/renderer/pipeline_cache.h"
#include "engine/renderer/render_target_pass.h"

#include <algorithm>
#include <bit>
#include <span>
#include <cctype>
#include <cmath>
#include <unordered_map>
#include <iterator>
#include <cstring>
#include <stdexcept>
#include <type_traits>
#include <vector>

#include "engine/shader/dfg_lut.h"
#include "engine/shader/sprite.h"
#include "engine/scene/texture.h"
#include "engine/scene/nodes.h"
#include "engine/scene/camera.h"
#include "engine/renderer/graph/render_graph.h"
#include "engine/renderer/post/traa.h"
#include "engine/renderer/post/effects.h"
#include "engine/shader/tsl/tsl.h"
#include "engine/shader/graph/serialized.h"
#include "mystral/webgpu_compat.h"

namespace tn::engine {

namespace {

WGPUTextureFormat textureFormat(const Texture& texture) {
    return texture.isFloat() ? WGPUTextureFormat_RGBA32Float
         : texture.isHalfFloat() ? WGPUTextureFormat_RGBA16Float
         : texture.isSRGB() ? WGPUTextureFormat_RGBA8UnormSrgb : WGPUTextureFormat_RGBA8Unorm;
}

using Matrix3 = std::array<double, 9>;

Matrix multiply(const Matrix& a, const Matrix& b) {
    Matrix out{};
    for (int c = 0; c < 4; ++c)
        for (int r = 0; r < 4; ++r) {
            double s = 0;
            for (int k = 0; k < 4; ++k) s += a[k * 4 + r] * b[c * 4 + k];
            out[c * 4 + r] = s;
        }
    return out;
}

// three's Matrix3.getNormalMatrix: the inverse transpose of the upper-left 3x3.
Matrix3 normalMatrix(const Matrix& m) {
    const double a = m[0], b = m[1], c = m[2], d = m[4], e = m[5], f = m[6], g = m[8], h = m[9], i = m[10];
    const double t11 = i * e - f * h, t12 = f * g - i * d, t13 = h * d - e * g;
    const double det = a * t11 + b * t12 + c * t13;
    if (det == 0) return {};
    const double s = 1 / det;
    // inverse (column-major), then transposed
    const Matrix3 inv{t11 * s, (c * h - i * b) * s, (f * b - c * e) * s,
                      t12 * s, (i * a - c * g) * s, (c * d - f * a) * s,
                      t13 * s, (b * g - h * a) * s, (e * a - b * d) * s};
    return {inv[0], inv[3], inv[6], inv[1], inv[4], inv[7], inv[2], inv[5], inv[8]};
}

WGPUVertexFormat skinIndexFormat(const DrawItem& item) {
    if (!item.skinIndices) return WGPUVertexFormat_Uint16x4;
    switch (item.skinIndices->scalar()) {
        case Scalar::U8: return WGPUVertexFormat_Uint8x4;
        case Scalar::U32: return WGPUVertexFormat_Uint32x4;
        default: return WGPUVertexFormat_Uint16x4;
    }
}

// A point through a column-major matrix (w = 1): a light's view-space position, as three's
// lightViewPosition computes it on the CPU before it becomes a uniform.
std::array<double, 3> transformPoint(const Matrix& m, const std::array<double, 3>& v) {
    return {m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12], m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
            m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14]};
}

std::array<double, 3> rotate(const Matrix& m, const std::array<double, 3>& v) {
    return {m[0] * v[0] + m[4] * v[1] + m[8] * v[2], m[1] * v[0] + m[5] * v[1] + m[9] * v[2],
            m[2] * v[0] + m[6] * v[1] + m[10] * v[2]};
}

// Writes a uniform by name; absent names are skipped (a program that does not read it).
template <size_t N>
void put(std::vector<uint8_t>& block, const shader::StageModule& stage, const char* name, const std::array<double, N>& v) {
    for (const shader::UniformField& f : stage.uniforms) {
        if (f.name != name) continue;
        float data[N];
        for (size_t k = 0; k < N; ++k) data[k] = static_cast<float>(v[k]);
        if (f.type.isMatrix() && f.type.rows == 3) {  // mat3x3 columns are 16-byte aligned
            for (int c = 0; c < 3; ++c) std::memcpy(&block[f.offset + c * 16], data + c * 3, 12);
        } else {
            std::memcpy(&block[f.offset], data, N * 4);
        }
    }
}

// Writes a uniform through its resolved field; a null field is a uniform this program does not read.
template <size_t N>
void put(std::vector<uint8_t>& block, size_t base, const shader::UniformField* f, const std::array<double, N>& v) {
    if (f == nullptr) return;
    float data[N];
    for (size_t k = 0; k < N; ++k) data[k] = static_cast<float>(v[k]);
    if (f->type.isMatrix() && f->type.rows == 3) {  // mat3x3 columns are 16-byte aligned
        for (int c = 0; c < 3; ++c) std::memcpy(&block[base + f->offset + c * 16], data + c * 3, 12);
    } else {
        std::memcpy(&block[base + f->offset], data, N * 4);
    }
}

// Authored uniform data accompanies the graph, not the cached program. Both colour and shadow
// draws bind it, so a graph positionNode has exactly the same deformation in the two passes.
// A draw's material uniforms for one stage, read in place from its graphs' uniform nodes every frame
// (no map built per draw): three's `time` (the frame's elapsed seconds), then each named value. A name
// bound to two different values across the material's graphs fails rather than pick one.
void putNodes(std::vector<uint8_t>& block, size_t base, const shader::StageModule& stage,
              const shader::MaterialNodes& nodes, float time) {
    using Named = std::pair<std::string_view, std::span<const float>>;
    thread_local std::vector<Named> values;
    values.clear();
    values.emplace_back("time", std::span<const float>(&time, 1));
    for (const auto& graph : nodes.graphs()) {
        if (!graph) continue;
        for (const auto& node : shader::graph::uniformList(graph)) {
            if (node->values.empty()) continue;
            const auto found = std::ranges::find(values, std::string_view(node->name), &Named::first);
            if (found == values.end()) values.emplace_back(node->name, node->values);
            else if (!std::ranges::equal(found->second, node->values)) throw std::runtime_error("TN_TSL_UNIFORM_CONFLICT: " + node->name);
        }
    }
    for (const auto& field : stage.uniforms) {
        const auto found = std::ranges::find(values, std::string_view(field.name), &Named::first);
        if (found == values.end()) continue;
        if (field.type.isMatrix() || field.type.scalar != shader::Type::Scalar::F32 || found->second.size() != field.type.rows)
            throw std::runtime_error("TN_TSL_UNIFORM_TYPE: " + field.name);
        std::memcpy(block.data() + base + field.offset, found->second.data(), found->second.size() * sizeof(float));
    }
}

constexpr const char* kSlotNames[] = {
    "modelMatrix", "viewMatrix", "projectionMatrix", "normalMatrix", "diffuse", "alphaTest", "opaque", "roughness",
    "metalness", "emissive", "specular", "shininess", "ior", "specularIntensity", "specularColor", "uvTransform",
    "hemisphereSky", "hemisphereGround", "hemisphereDirection", "ambient", "boneBase", "bindMatrix",
    "bindMatrixInverse", "morphBase", "morphInfluenceBase", "morphVertexCount", "morphBaseInfluence",
    "envMapIntensity", "cameraWorldMatrix", "envMapTexelWidth", "envMapTexelHeight", "envMapMaxMip", "boneStride", "fogColor", "fogNear", "fogFar", "fogDensity", "backgroundRotation", "envRotation", "instanceBase", "normalScale", "normalUvTransform", "cameraPosition", "cameraProjectionMatrix",
    "roughnessMapUvTransform", "metalnessMapUvTransform", "aoMapUvTransform", "emissiveMapUvTransform",
    "bumpMapUvTransform", "specularColorMapUvTransform",
    "specularIntensityMapUvTransform", "clearcoatMapUvTransform", "clearcoatRoughnessMapUvTransform",
    "clearcoatNormalMapUvTransform", "aoMapIntensity", "clearcoat", "clearcoatRoughness", "clearcoatNormalScale", "bumpScale",
    "pmremTexelWidth", "pmremTexelHeight", "pmremMaxMip", "pmremRotation", "screenSize", "cameraNear", "cameraFar",
    "modelNormalMatrix"};
constexpr const char* kLightFieldNames[] = {"Color",       "Direction",        "Position",     "Distance",
                                            "Decay",       "Axis",             "ConeCos",      "PenumbraCos",
                                            "ShadowMatrix", "ShadowBias",      "ShadowNormalBias", "ShadowRadius",
                                            "ShadowMapSize", "ShadowIntensity", "ShadowNear", "ShadowFar"};

constexpr uint64_t kUniformAlign = 256;  // minUniformBufferOffsetAlignment's WebGPU default
uint64_t aligned(uint64_t size) { return (size + kUniformAlign - 1) / kUniformAlign * kUniformAlign; }

WGPUTextureView view2d(WGPUTexture texture, WGPUTextureFormat format) {
    WGPUTextureViewDescriptor desc = {};
    desc.dimension = WGPUTextureViewDimension_2D;
    desc.mipLevelCount = 1;
    desc.arrayLayerCount = 1;
    desc.format = format;
    return wgpuTextureCreateView(texture, &desc);
}

// three's wrapping and filter constants (1000/1001/1002, 1000/1001) to WebGPU's.
WGPUAddressMode addressMode(uint16_t wrap) {
    switch (static_cast<TextureWrap>(wrap)) {
        case TextureWrap::Repeat: return WGPUAddressMode_Repeat;
        case TextureWrap::MirroredRepeat: return WGPUAddressMode_MirrorRepeat;
        default: return WGPUAddressMode_ClampToEdge;
    }
}
WGPUFilterMode filterMode(uint16_t filter) {
    return filter >= static_cast<uint16_t>(TextureFilter::Linear) && filter <= static_cast<uint16_t>(TextureFilter::LinearMipmapLinear)
        ? WGPUFilterMode_Linear : WGPUFilterMode_Nearest;
}

// A Line or LineSegments draw: its topology, no culling, and an indexed strip's index format.
void lineTopology(PipelineTarget& target, const DrawItem& item) {
    if (item.topology == WGPUPrimitiveTopology_TriangleList) return;
    target.topology = item.topology;
    target.cull = WGPUCullMode_None;
    if (item.topology == WGPUPrimitiveTopology_LineStrip && item.indices)
        target.stripIndexFormat = item.indices->scalar() == Scalar::U32 ? WGPUIndexFormat_Uint32 : WGPUIndexFormat_Uint16;
}

// three's Texture.updateMatrix: Matrix3.setUvTransform(offset.x, offset.y, repeat.x, repeat.y,
// rotation, center.x, center.y). Its elements are column-major, as the fragment's mat3x3 uniform reads them.
std::array<double, 9> uvTransformOf(const Texture& t) {
    return tn::engine::Matrix3()
        .setUvTransform(t.offset.x, t.offset.y, t.repeat.x, t.repeat.y, t.rotation, t.center.x, t.center.y)
        .elements;
}

// A program that samples a material `map` or an environment cannot have one shared fragment group:
// each draw's group binds its own texture and sampler. Its group[1] is left null and built per draw.
// A TSL texture(object, uv) binding (tsl_call's "nodeMap<id>"): the draw's own texture, in either stage.
bool graphTextureBinding(std::string_view name) { return name.rfind("t_nodeMap", 0) == 0; }

// Bit i set: the vertex stage's attribute i is one of the draw's InstancedBufferAttributes.
uint64_t instanceStepMask(const shader::StageModule& vertex, const DrawItem& item) {
    uint64_t mask = 0;
    for (std::size_t i = 0; i < vertex.attributes.size() && i < 64; ++i)
        for (const DrawItem::CustomAttribute& custom : item.attributes)
            if (custom.perInstance && custom.name == vertex.attributes[i].name) mask |= uint64_t(1) << i;
    return mask;
}

// A viewport texture binding: the frame's colour or depth as drawn before this draw.
bool viewportBinding(std::string_view name) {
    return name == "t_viewportColor" || name == "smp_viewportColor" || name == "t_viewportDepth" ||
           name == "smp_viewportDepth";
}

bool readsViewport(const shader::StageModule& stage) {
    return std::any_of(stage.bindings.begin(), stage.bindings.end(),
                       [](const shader::Binding& binding) { return viewportBinding(binding.name); });
}

bool perDrawFragment(const shader::StageModule& stage) {
    for (const shader::Binding& binding : stage.bindings)
        if (binding.name == "t_map" || binding.name == "t_env" || graphTextureBinding(binding.name) ||
            viewportBinding(binding.name))
            return true;
    return false;
}

// A vertex stage that samples a graph texture (a positionNode's displacement map) binds it per draw.
bool perDrawVertex(const shader::StageModule& stage) {
    return std::any_of(stage.bindings.begin(), stage.bindings.end(),
                       [](const shader::Binding& binding) { return graphTextureBinding(binding.name); });
}

// The PMREM generator's shaders, three's PMREMGenerator/PMREMUtils WGSL, ported operation for
// operation: getDirection/getFace/getUV/roughnessToMip/bilinearCubeUV/textureCubeUV and the GGX
// VNDF convolution (512 samples). Hand-written because the material IR has no u32 loop or bit ops;
// this is renderer-internal plumbing, not a material.
const char* kPmremPrelude = R"WGSL(
struct PmremUniforms {
  roughness: f32, mipInt: f32, texelWidth: f32, texelHeight: f32,
  maxMip: f32, pad0: f32, pad1: f32, pad2: f32,
};
@group(0) @binding(0) var<uniform> u: PmremUniforms;
@group(0) @binding(1) var t_src: texture_2d<f32>;
@group(0) @binding(2) var s_src: sampler;
struct VsOut {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) face: f32,
};
@vertex fn vs(@location(0) a_pos: vec3<f32>, @location(1) a_uv: vec2<f32>, @location(2) a_face: f32) -> VsOut {
  var out: VsOut;
  out.position = vec4<f32>(a_pos.xy, 0.0, 1.0);
  out.uv = a_uv;
  out.face = a_face;
  return out;
}
fn pmremFace(direction: vec3<f32>) -> f32 {
  let a = abs(direction);
  var face = -1.0;
  if (a.x > a.z) {
    if (a.x > a.y) { face = select(3.0, 0.0, direction.x > 0.0); }
    else { face = select(4.0, 1.0, direction.y > 0.0); }
  } else {
    if (a.z > a.y) { face = select(5.0, 2.0, direction.z > 0.0); }
    else { face = select(4.0, 1.0, direction.y > 0.0); }
  }
  return face;
}
fn pmremUv(direction: vec3<f32>, face: f32) -> vec2<f32> {
  var uv = vec2<f32>(0.0);
  let a = abs(direction);
  if (face == 0.0) { uv = vec2<f32>(direction.z, direction.y) / a.x; }
  else if (face == 1.0) { uv = vec2<f32>(-direction.x, -direction.z) / a.y; }
  else if (face == 2.0) { uv = vec2<f32>(-direction.x, direction.y) / a.z; }
  else if (face == 3.0) { uv = vec2<f32>(-direction.z, direction.y) / a.x; }
  else if (face == 4.0) { uv = vec2<f32>(-direction.x, direction.z) / a.y; }
  else { uv = vec2<f32>(direction.x, direction.y) / a.z; }
  return 0.5 * (uv + vec2<f32>(1.0));
}
fn pmremDirection(uvIn: vec2<f32>, face: f32) -> vec3<f32> {
  let uv = uvIn * 2.0 - 1.0;
  var d = vec3<f32>(uv, 1.0);
  if (face == 0.0) { d = d.zyx; }
  else if (face == 1.0) { d = d.xzy; d = vec3<f32>(-d.x, d.y, -d.z); }
  else if (face == 2.0) { d.x *= -1.0; }
  else if (face == 3.0) { d = d.zyx; d = vec3<f32>(-d.x, d.y, -d.z); }
  else if (face == 4.0) { d = d.xzy; d = vec3<f32>(-d.x, -d.y, d.z); }
  else { d.z *= -1.0; }
  return d;
}
)WGSL";

const char* kPmremEquirect = R"WGSL(
@fragment fn fs(in: VsOut) -> @location(0) vec4<f32> {
  let direction = normalize(pmremDirection(in.uv, in.face));
  let uEq = atan2(direction.z, direction.x) * 0.15915494309189535 + 0.5;
  let vEq = asin(clamp(direction.y, -1.0, 1.0)) * 0.3183098861837907 + 0.5;
  return textureSampleLevel(t_src, s_src, vec2<f32>(uEq, vEq), 0.0);
}
)WGSL";

const char* kPmremGgx = R"WGSL(
fn pmremBilinear(directionIn: vec3<f32>, mipIn: f32) -> vec3<f32> {
  var mip = mipIn;
  var face = pmremFace(directionIn);
  let filterInt = max(4.0 - mip, 0.0);
  mip = max(mip, 4.0);
  let faceSize = exp2(mip);
  var uv = pmremUv(directionIn, face) * (faceSize - 2.0) + 1.0;
  if (face > 2.0) { uv.y += faceSize; face -= 3.0; }
  uv.x += face * faceSize;
  uv.x += filterInt * 48.0;
  uv.y += 4.0 * (exp2(u.maxMip) - faceSize);
  uv *= vec2<f32>(u.texelWidth, u.texelHeight);
  return textureSampleLevel(t_src, s_src, uv, 0.0).xyz;
}
fn radicalInverse(bitsIn: u32) -> f32 {
  var bits = bitsIn;
  bits = (bits << 16u) | (bits >> 16u);
  bits = ((bits & 0x55555555u) << 1u) | ((bits & 0xAAAAAAAAu) >> 1u);
  bits = ((bits & 0x33333333u) << 2u) | ((bits & 0xCCCCCCCCu) >> 2u);
  bits = ((bits & 0x0F0F0F0Fu) << 4u) | ((bits & 0xF0F0F0F0u) >> 4u);
  bits = ((bits & 0x00FF00FFu) << 8u) | ((bits & 0xFF00FF00u) >> 8u);
  return f32(bits) * 2.3283064365386963e-10;
}
fn importanceSampleGGX_VNDF(Xi: vec2<f32>, V: vec3<f32>, roughness: f32) -> vec3<f32> {
  let alpha = roughness * roughness;
  let T1 = vec3<f32>(1.0, 0.0, 0.0);
  let T2 = cross(V, T1);
  let r = sqrt(Xi.x);
  let phi = (2.0 * 3.14159265359) * Xi.y;
  let t1 = r * cos(phi);
  var t2 = r * sin(phi);
  let s = 0.5 * (V.z + 1.0);
  t2 = (1.0 - s) * sqrt(1.0 - t1 * t1) + s * t2;
  let Nh = T1 * t1 + T2 * t2 + V * sqrt(max(0.0, 1.0 - (t1 * t1 + t2 * t2)));
  return normalize(vec3<f32>(alpha * Nh.x, alpha * Nh.y, max(0.0, Nh.z)));
}
@fragment fn fs(in: VsOut) -> @location(0) vec4<f32> {
  let N = normalize(pmremDirection(in.uv, in.face));
  var prefiltered = vec3<f32>(0.0);
  var totalWeight = 0.0;
  if (u.roughness < 0.001) {
    prefiltered = pmremBilinear(N, u.mipInt);
  } else {
    let up = select(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 0.0, 1.0), abs(N.z) < 0.999);
    let tangent = normalize(cross(up, N));
    let bitangent = cross(N, tangent);
    for (var i = 0u; i < 512u; i = i + 1u) {
      let Xi = vec2<f32>(f32(i) / 512.0, radicalInverse(i));
      let Ht = importanceSampleGGX_VNDF(Xi, vec3<f32>(0.0, 0.0, 1.0), u.roughness);
      let H = normalize(tangent * Ht.x + bitangent * Ht.y + N * Ht.z);
      let L = normalize(H * (dot(N, H) * 2.0) - N);
      let NdotL = max(dot(N, L), 0.0);
      if (NdotL > 0.0) {
        prefiltered += pmremBilinear(L, u.mipInt) * NdotL;
        totalWeight += NdotL;
      }
    }
    if (totalWeight > 0.0) { prefiltered /= totalWeight; }
  }
  return vec4<f32>(prefiltered, 1.0);
}
)WGSL";

}  // namespace

Renderer::Renderer(WGPUInstance instance, WGPUDevice device, WGPUQueue queue, EventQueue& events)
    : instance_(instance), device_(device), queue_(queue), events_(events), gpu_(instance, device, queue, events, 1), geometry_(std::make_shared<GeometryCopies>(instance, device, queue, events)), pipelines_(device) {
    geometry_->gpu.shareSubmissions(gpu_);
    // The DFG lookup the standard BRDF samples: three's 16x16 RG half-float table, linear filtered.
    WGPUTextureDescriptor lutDesc = {};
    lutDesc.dimension = WGPUTextureDimension_2D;
    lutDesc.size = {shader::kDfgLutSize, shader::kDfgLutSize, 1};
    lutDesc.format = WGPUTextureFormat_RG16Float;
    lutDesc.usage = WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst;
    lutDesc.mipLevelCount = 1;
    lutDesc.sampleCount = 1;
    lut_ = wgpuDeviceCreateTexture(device, &lutDesc);
    WGPUImageCopyTexture_Compat dst = {};
    dst.texture = lut_;
    dst.aspect = WGPUTextureAspect_All;
    WGPUTextureDataLayout_Compat layout = {};
    layout.bytesPerRow = shader::kDfgLutSize * 4;
    layout.rowsPerImage = shader::kDfgLutSize;
    const WGPUExtent3D extent = {shader::kDfgLutSize, shader::kDfgLutSize, 1};
    wgpuQueueWriteTexture(queue, &dst, shader::kDfgLut, sizeof shader::kDfgLut, &layout, &extent);
    lutView_ = wgpuTextureCreateView(lut_, nullptr);
    WGPUSamplerDescriptor sampler = {};
    sampler.magFilter = WGPUFilterMode_Linear;
    sampler.minFilter = WGPUFilterMode_Linear;
    sampler.addressModeU = sampler.addressModeV = sampler.addressModeW = WGPUAddressMode_ClampToEdge;
    sampler.maxAnisotropy = 1;
    lutSampler_ = wgpuDeviceCreateSampler(device, &sampler);
    sampler.compare = WGPUCompareFunction_LessEqual;
    compareSampler_ = wgpuDeviceCreateSampler(device, &sampler);

    // One triangle covers the frame; the output pass samples the scene target texel for texel.
    const float triangle[6] = {-1, -1, 3, -1, -1, 3};
    outputTriangle_ = gpu_.createBuffer(sizeof triangle, WGPUBufferUsage_Vertex | WGPUBufferUsage_CopyDst);
    for (const char* name : {"boneMatrices", "morphData", "morphInfluences", "instances"}) {
        FrameStorage& storage = storages_[name];
        storage.capacity = 64;
        storage.buffer = gpu_.createBuffer(storage.capacity, WGPUBufferUsage_Storage | WGPUBufferUsage_CopyDst);
    }
    gpu_.writeBuffer(outputTriangle_, 0, triangle, sizeof triangle);
    outputUniforms_ = gpu_.createBuffer(16, WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst);
    WGPUSamplerDescriptor nearest = {};
    nearest.magFilter = WGPUFilterMode_Nearest;
    nearest.minFilter = WGPUFilterMode_Nearest;
    nearest.addressModeU = nearest.addressModeV = nearest.addressModeW = WGPUAddressMode_ClampToEdge;
    nearest.maxAnisotropy = 1;
    outputSampler_ = wgpuDeviceCreateSampler(device, &nearest);
    if (wgpuDeviceHasFeature(device, WGPUFeatureName_TimestampQuery)) {
        WGPUQuerySetDescriptor queries = {};
        queries.type = WGPUQueryType_Timestamp;
        queries.count = 6;
        timestamps_ = wgpuDeviceCreateQuerySet(device, &queries);
        timestampResolve_ = gpu_.createBuffer(48, WGPUBufferUsage_QueryResolve | WGPUBufferUsage_CopySrc);
    }
    setOutput(OutputState{});
    setSize(1, 1);
}

WGPUSampler Renderer::linearClampSampler() {
    if (!linearClampSampler_) {
        WGPUSamplerDescriptor linear = {};
        linear.addressModeU = linear.addressModeV = linear.addressModeW = WGPUAddressMode_ClampToEdge;
        linear.magFilter = linear.minFilter = WGPUFilterMode_Linear;
        linear.mipmapFilter = WGPUMipmapFilterMode_Nearest;
        linear.maxAnisotropy = 1;
        linear.lodMaxClamp = 32;
        linearClampSampler_ = wgpuDeviceCreateSampler(device_, &linear);
    }
    return linearClampSampler_;
}

Renderer& Renderer::probeCaptureRenderer() {
    if (!probeCapture_) probeCapture_ = std::make_unique<Renderer>(instance_, device_, queue_, events_);
    return *probeCapture_;
}

void Renderer::setProbeVolume(const std::string& name, const probes::ProbeVolume& volume, bool capture) {
    if (!wgpuDeviceHasFeature(device_, WGPUFeatureName_Float32Filterable))
        throw std::runtime_error("TN_PROBES_TEXTURE_UNSUPPORTED: requires float32-filterable");
    auto& atlas = probeTextures_[shader::probeStorageName(name)];
    const auto& p = volume.placement();
    const WGPUExtent3D size{p.resolution[0], p.resolution[1], p.atlasDepth};
    const bool resized = atlas.texture && (atlas.size.width != size.width || atlas.size.height != size.height ||
                                            atlas.size.depthOrArrayLayers != size.depthOrArrayLayers);
    if (resized) {
        wgpuTextureViewRelease(atlas.view);
        wgpuSamplerRelease(atlas.sampler);
        wgpuTextureRelease(atlas.texture);
        atlas = {};
    }
    if (!atlas.texture) {
        WGPUTextureDescriptor descriptor{};
        descriptor.dimension = WGPUTextureDimension_3D;
        descriptor.size = size;
        descriptor.format = WGPUTextureFormat_RGBA32Float;
        descriptor.usage = WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst;
        descriptor.mipLevelCount = descriptor.sampleCount = 1;
        atlas.texture = wgpuDeviceCreateTexture(device_, &descriptor);
        atlas.view = wgpuTextureCreateView(atlas.texture, nullptr);
        WGPUSamplerDescriptor sampler{};
        sampler.addressModeU = sampler.addressModeV = sampler.addressModeW = WGPUAddressMode_ClampToEdge;
        sampler.magFilter = sampler.minFilter = WGPUFilterMode_Linear;
        sampler.maxAnisotropy = 1;
        atlas.sampler = wgpuDeviceCreateSampler(device_, &sampler);
        atlas.size = size;
    }
    const auto data = capture ? volume.samplingAtlas() : volume.displayAtlas();
    WGPUImageCopyTexture_Compat destination{};
    destination.texture = atlas.texture;
    destination.aspect = WGPUTextureAspect_All;
    WGPUTextureDataLayout_Compat layout{};
    layout.bytesPerRow = size.width * 4 * sizeof(float);
    layout.rowsPerImage = size.height;
    wgpuQueueWriteTexture(queue_, &destination, data.data(), data.size_bytes(), &layout, &size);
    if (resized && uniformCapacity_) rebuildGroups();
}

void Renderer::setVirtualShadow(std::size_t light, const shadows::AtlasOptions& options) {
    if (virtualShadows_.count(light)) throw std::runtime_error("TN_VIRTUAL_SHADOW_UNSUPPORTED: reconfiguration of an active light");
    std::string error;
    auto atlas = shadows::PageAtlas::create(options, error);
    if (!atlas) throw std::runtime_error(error);
    virtualShadows_.emplace(light, VirtualShadow{std::move(*atlas), {}, {}});
    // The table must exist before a cached material's bind groups can name it.
    auto& table = storages_["vsmTable" + std::to_string(light)];
    table.capacity = uint64_t(options.clipExtents.size()) * (9 + (options.mapSize/options.pageTexels)*(options.mapSize/options.pageTexels)) * 16;
    table.buffer = gpu_.createBuffer(table.capacity, WGPUBufferUsage_Storage | WGPUBufferUsage_CopyDst);
}

Renderer::~Renderer() {
    if (mipEncoder_) wgpuCommandEncoderRelease(mipEncoder_);
    for (WGPUBindGroup group : mipGroups_) wgpuBindGroupRelease(group);
    for (WGPUTextureView view : mipViews_) wgpuTextureViewRelease(view);
    if (mainBundle_) wgpuRenderBundleRelease(mainBundle_);
    if (viewportBundle_) wgpuRenderBundleRelease(viewportBundle_);
    mainBundle_ = viewportBundle_ = nullptr;
    if (timestamps_) wgpuQuerySetRelease(timestamps_);
    for (auto& [key, program] : programs_) {
        if (!program) continue;  // a refused program
        for (int g = 0; g < 2; ++g) {
            if (program->groups[g]) wgpuBindGroupRelease(program->groups[g]);
            if (program->layouts[g]) wgpuBindGroupLayoutRelease(program->layouts[g]);
        }
        if (program->pipelineLayout) wgpuPipelineLayoutRelease(program->pipelineLayout);
    }
    for (auto& [name, atlas] : probeTextures_) {
        if (atlas.view) wgpuTextureViewRelease(atlas.view);
        if (atlas.sampler) wgpuSamplerRelease(atlas.sampler);
        if (atlas.texture) wgpuTextureRelease(atlas.texture);
    }
    releaseTargets();
    releaseOutputGroup();
    if (depthResolve_) wgpuRenderPipelineRelease(depthResolve_);
    if (overlayView_) wgpuTextureViewRelease(overlayView_);
    if (presentedView_) wgpuTextureViewRelease(presentedView_);
    wgpuSamplerRelease(outputSampler_);
    if (outputPipelineLayout_) wgpuPipelineLayoutRelease(outputPipelineLayout_);
    if (outputLayout_) wgpuBindGroupLayoutRelease(outputLayout_);
    wgpuSamplerRelease(lutSampler_);
    wgpuSamplerRelease(compareSampler_);
    if (linearClampSampler_) wgpuSamplerRelease(linearClampSampler_);
    for (auto& [light, shadow] : virtualShadows_) shadowMaps_.push_back(shadow.map);
    shadowMaps_.insert(shadowMaps_.end(), cubeShadowMaps_.begin(), cubeShadowMaps_.end());
    for (ShadowMap& map : shadowMaps_) {
        if (map.view) wgpuTextureViewRelease(map.view);
        for (WGPUTextureView face : map.faces)
            if (face) wgpuTextureViewRelease(face);
        if (map.texture) wgpuTextureRelease(map.texture);
    }
    wgpuTextureViewRelease(lutView_);
    wgpuTextureRelease(lut_);
    releaseEnvironments();
    releaseMaterialTextures();
}

void Renderer::releaseTargets() {
    if (colorView_) {  // the color texture exists exactly while its view does
        wgpuTextureViewRelease(colorView_);
        gpu_.destroy(color_);
    }
    if (depthView_) wgpuTextureViewRelease(depthView_);
    if (depth_) wgpuTextureRelease(depth_);
    if (msaaDepthView_) wgpuTextureViewRelease(msaaDepthView_);
    if (msaaDepth_) wgpuTextureRelease(msaaDepth_);
    if (msaaColorView_) wgpuTextureViewRelease(msaaColorView_);
    if (msaaColor_) wgpuTextureRelease(msaaColor_);
    if (sceneView_) wgpuTextureViewRelease(sceneView_);
    if (sceneColor_) wgpuTextureRelease(sceneColor_);
    if (normalView_) wgpuTextureViewRelease(normalView_);
    if (normalTexture_) wgpuTextureRelease(normalTexture_);
    if (viewportColorView_) wgpuTextureViewRelease(viewportColorView_);
    if (viewportColor_) wgpuTextureRelease(viewportColor_);
    if (viewportDepthView_) wgpuTextureViewRelease(viewportDepthView_);
    if (viewportDepth_) wgpuTextureRelease(viewportDepth_);
    colorView_ = depthView_ = msaaColorView_ = msaaDepthView_ = sceneView_ = normalView_ = viewportColorView_ = viewportDepthView_ = nullptr;
    depth_ = msaaColor_ = msaaDepth_ = sceneColor_ = normalTexture_ = viewportColor_ = viewportDepth_ = nullptr;
    releaseOutputGroup();  // it binds the scene target
}

void Renderer::releaseOutputGroup() {
    if (outputGroup_) wgpuBindGroupRelease(outputGroup_);
    outputGroup_ = nullptr;
}

std::optional<OutputState> outputStateOf(double toneMapping, double exposure, const std::string& colorSpace,
                                         std::string& refusal) {
    // three's constants: NoToneMapping 0, Linear 1, Reinhard 2, Cineon 3, ACESFilmic 4, AgX 6, Neutral 7.
    static const std::map<double, std::optional<shader::ToneMapping>> mappings{
        {0, std::nullopt}, {1, shader::ToneMapping::Linear}, {2, shader::ToneMapping::Reinhard},
        {3, shader::ToneMapping::Cineon}, {4, shader::ToneMapping::ACESFilmic}, {6, shader::ToneMapping::AgX},
        {7, shader::ToneMapping::Neutral}};
    const auto tone = mappings.find(toneMapping);
    if (tone == mappings.end()) {
        refusal = "toneMapping " + std::to_string(toneMapping);
        return std::nullopt;
    }
    if (!std::isfinite(exposure)) {
        refusal = "toneMappingExposure must be finite";
        return std::nullopt;
    }
    if (colorSpace != "srgb" && colorSpace != "srgb-linear") {
        refusal = "outputColorSpace " + colorSpace;
        return std::nullopt;
    }
    return OutputState{tone->second, exposure, colorSpace == "srgb"};
}

void Renderer::setOutput(const OutputState& output) {
    const bool programChanged = outputVertex_.wgsl.code.empty() || output.toneMapping != output_.toneMapping || output.srgb != output_.srgb;
    output_ = output;
    if (!programChanged) return;
    const shader::OutputPrograms programs = shader::buildOutput(output.toneMapping, output.srgb, post_.get());
    outputVertex_ = shader::buildStage(programs.vertex, 0);
    outputFragment_ = shader::buildStage(programs.fragment, 0);
    if (!outputVertex_.wgsl.ok() || !outputFragment_.wgsl.ok()) throw std::runtime_error("TN_NATIVE_SHADER_INVALID: output program");
    releaseOutputGroup();  // its layout belongs to the previous program
    // An explicit layout: the output program declares the scene binding even when a post graph
    // never samples it, and an automatic layout would drop it and refuse the bind group.
    if (outputPipelineLayout_) wgpuPipelineLayoutRelease(outputPipelineLayout_);
    if (outputLayout_) wgpuBindGroupLayoutRelease(outputLayout_);
    std::vector<WGPUBindGroupLayoutEntry> layoutEntries;
    for (const shader::Binding& b : outputFragment_.bindings) {
        WGPUBindGroupLayoutEntry e = {};
        e.binding = b.binding;
        e.visibility = WGPUShaderStage_Fragment;
        if (b.kind == shader::BindingKind::Uniform) {
            e.buffer.type = WGPUBufferBindingType_Uniform;
            e.buffer.minBindingSize = outputFragment_.uniformBlockSize;
        } else if (b.kind == shader::BindingKind::Texture) {
            e.texture.sampleType = WGPUTextureSampleType_Float;
            e.texture.viewDimension = WGPUTextureViewDimension_2D;
        } else {
            e.sampler.type = WGPUSamplerBindingType_Filtering;
        }
        layoutEntries.push_back(e);
    }
    WGPUBindGroupLayoutDescriptor layoutDesc = {};
    layoutDesc.entryCount = layoutEntries.size();
    layoutDesc.entries = layoutEntries.data();
    outputLayout_ = wgpuDeviceCreateBindGroupLayout(device_, &layoutDesc);
    WGPUPipelineLayoutDescriptor pipelineLayoutDesc = {};
    pipelineLayoutDesc.bindGroupLayoutCount = 1;
    pipelineLayoutDesc.bindGroupLayouts = &outputLayout_;
    outputPipelineLayout_ = wgpuDeviceCreatePipelineLayout(device_, &pipelineLayoutDesc);
    gpu_.destroy(outputUniforms_);
    outputUniforms_ = gpu_.createBuffer(std::max<uint32_t>(16, outputFragment_.uniformBlockSize), WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst);
}

void Renderer::setPostNode(std::shared_ptr<const shader::PostNode> post) {
    auto effects = post && !post->passes.empty() ? std::make_unique<PostEffects>(device_,queue_,post->passes) : nullptr;
    postEffects_.reset();
    postUniforms_ = post ? post->uniforms : std::map<std::string,std::vector<float>>{};
    post_ = std::move(post);
    outputVertex_ = {};  // rebuild the output program with (or without) the post graph
    const OutputState output = output_;
    setOutput(output);
    postEffects_ = std::move(effects);
    if (postEffects_ && width_ && height_) postEffects_->resize(width_,height_);
}

void Renderer::setPostGraph(shader::graph::Node root) {
    setPostNode(root ? std::make_shared<shader::PostNode>(shader::graph::serializedPost(root)) : nullptr);
}

void Renderer::setPostInput(const std::string& name, WGPUTextureView view) {
    if (!postEffects_) throw std::runtime_error("TN_POST_GRAPH_MISSING");
    postEffects_->input(name,view);
    releaseOutputGroup();
}

void Renderer::setTraa(const TraaOptions& options) {
    traa_ = std::make_unique<TraaPass>(device_, queue_, options);
    if (width_ && height_) traa_->resize(width_, height_);
    releaseOutputGroup();
}

void Renderer::cutHistory() { if (traa_) traa_->cameraCut(); }

void Renderer::setSampleCount(uint32_t samples) {
    if (samples != 1 && samples != 4)
        throw std::runtime_error("TN_NATIVE_SAMPLES_UNSUPPORTED: sampleCount must be 1 or 4");
    if (samples == sampleCount_) return;
    sampleCount_ = samples;
    if (mainBundle_) wgpuRenderBundleRelease(mainBundle_);
    if (viewportBundle_) wgpuRenderBundleRelease(viewportBundle_);
    mainBundle_ = viewportBundle_ = nullptr;
    if (width_ && height_) {
        const uint32_t w = width_, h = height_;
        width_ = height_ = 0;
        setSize(w, h);
    }
}

// Full-screen triangle, as pageClear builds it. The fragment writes sample 0 of the multisampled depth.
constexpr const char* kDepthResolveWgsl = R"(
@group(0) @binding(0) var msaaDepth: texture_depth_multisampled_2d;

@vertex
fn vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
    let x = select(-1.0, 3.0, index == 1u);
    let y = select(-1.0, 3.0, index == 0u);
    return vec4<f32>(x, y, 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) position: vec4<f32>) -> @builtin(frag_depth) f32 {
    return textureLoad(msaaDepth, vec2<i32>(position.xy), 0);
}
)";

// ponytail: sample 0 stands in for the pixel depth, so an edge pixel uses one sample's depth.
// Upgrade: take the min or max of the four samples, if depth-based effects show edge errors.
// Resolves msaaDepth_ into depth_ with a full-screen pass that writes frag_depth.
void Renderer::resolveDepth(WGPUCommandEncoder encoder) {
    if (!depthResolve_) {
        WGPUShaderModuleWGSLDescriptor_Compat wgsl = {};
        WGPUShaderModuleDescriptor shaderDesc = {};
        setupShaderModuleWGSL(&shaderDesc, &wgsl, kDepthResolveWgsl);
        WGPUShaderModule module = wgpuDeviceCreateShaderModule(device_, &shaderDesc);
        WGPUFragmentState fragment = {};
        fragment.module = module;
        WGPU_SET_ENTRY_POINT(fragment, "fs");
        WGPUDepthStencilState depth = {};
        depth.format = WGPUTextureFormat_Depth32Float;
        depth.depthWriteEnabled = WGPU_OPTIONAL_BOOL_TRUE;
        depth.depthCompare = WGPUCompareFunction_Always;
        WGPURenderPipelineDescriptor desc = {};
        desc.vertex.module = module;
        WGPU_SET_ENTRY_POINT(desc.vertex, "vs");
        desc.primitive.topology = WGPUPrimitiveTopology_TriangleList;
        desc.multisample.count = 1;
        desc.multisample.mask = 0xffffffffu;
        desc.depthStencil = &depth;
        desc.fragment = &fragment;
        depthResolve_ = wgpuDeviceCreateRenderPipeline(device_, &desc);
        wgpuShaderModuleRelease(module);
        if (!depthResolve_) throw std::runtime_error("TN_NATIVE_PIPELINE_REFUSED: depth resolve");
    }
    const WGPUBindGroupLayout layout = wgpuRenderPipelineGetBindGroupLayout(depthResolve_, 0);
    WGPUBindGroupEntry entry = {};
    entry.binding = 0;
    entry.textureView = msaaDepthView_;
    WGPUBindGroupDescriptor groupDesc = {};
    groupDesc.layout = layout;
    groupDesc.entryCount = 1;
    groupDesc.entries = &entry;
    const WGPUBindGroup group = createBindGroup(device_, &groupDesc);
    WGPURenderPassDepthStencilAttachment depth = {};
    depth.view = depthView_;
    depth.depthLoadOp = WGPULoadOp_Clear;
    depth.depthStoreOp = WGPUStoreOp_Store;
    depth.depthClearValue = 1.0f;
    WGPURenderPassDescriptor passDesc = {};
    passDesc.depthStencilAttachment = &depth;
    WGPURenderPassEncoder pass = wgpuCommandEncoderBeginRenderPass(encoder, &passDesc);
    wgpuRenderPassEncoderSetPipeline(pass, depthResolve_);
    wgpuRenderPassEncoderSetBindGroup(pass, 0, group, 0, nullptr);
    wgpuRenderPassEncoderDraw(pass, 3, 1, 0, 0);
    wgpuRenderPassEncoderEnd(pass);
    wgpuRenderPassEncoderRelease(pass);
    wgpuBindGroupRelease(group);
    wgpuBindGroupLayoutRelease(layout);
}

void Renderer::setSize(uint32_t width, uint32_t height) {
    width = std::max(width, 1u);
    height = std::max(height, 1u);
    if (width == width_ && height == height_) return;
    releaseTargets();
    width_ = width;
    height_ = height;
    color_ = gpu_.createTexture(width, height, WGPUTextureFormat_RGBA8Unorm,
                                // TextureBinding too: a windowed player samples this finished frame to
                                // put it on the screen (Renderer::blitTo).
                                WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_CopySrc |
                                    WGPUTextureUsage_TextureBinding);
    WGPUTextureDescriptor depthDesc = {};
    depthDesc.dimension = WGPUTextureDimension_2D;
    depthDesc.size = {width, height, 1};
    depthDesc.format = WGPUTextureFormat_Depth32Float;
    depthDesc.usage = WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopySrc;
    depthDesc.mipLevelCount = 1;
    depthDesc.sampleCount = 1;
    depth_ = wgpuDeviceCreateTexture(device_, &depthDesc);
    WGPUTextureDescriptor sceneDesc = depthDesc;
    sceneDesc.format = WGPUTextureFormat_RGBA16Float;
    sceneDesc.usage = WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopySrc;
    sceneColor_ = wgpuDeviceCreateTexture(device_, &sceneDesc);
    sceneView_ = view2d(sceneColor_, WGPUTextureFormat_RGBA16Float);
    colorView_ = view2d(gpu_.texture(color_), WGPUTextureFormat_RGBA8Unorm);
    depthView_ = view2d(depth_, WGPUTextureFormat_Depth32Float);
    if (sampleCount_ == 4) {
        WGPUTextureDescriptor msaaDesc = depthDesc;
        msaaDesc.sampleCount = 4;
        // The depth resolve samples msaaDepth_, so that texture also takes TextureBinding.
        msaaDesc.usage = WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_TextureBinding;
        msaaDepth_ = wgpuDeviceCreateTexture(device_, &msaaDesc);
        msaaDepthView_ = view2d(msaaDepth_, WGPUTextureFormat_Depth32Float);
        msaaDesc.format = WGPUTextureFormat_RGBA16Float;
        msaaDesc.usage = WGPUTextureUsage_RenderAttachment;
        msaaColor_ = wgpuDeviceCreateTexture(device_, &msaaDesc);
        msaaColorView_ = view2d(msaaColor_, WGPUTextureFormat_RGBA16Float);
    }
    WGPUTextureDescriptor viewportDesc = sceneDesc;
    viewportDesc.usage = WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst;
    viewportColor_ = wgpuDeviceCreateTexture(device_, &viewportDesc);
    viewportColorView_ = view2d(viewportColor_, WGPUTextureFormat_RGBA16Float);
    viewportDesc.format = WGPUTextureFormat_Depth32Float;
    viewportDepth_ = wgpuDeviceCreateTexture(device_, &viewportDesc);
    viewportDepthView_ = view2d(viewportDepth_, WGPUTextureFormat_Depth32Float);
    if (traa_) traa_->resize(width, height);
    if (postEffects_) postEffects_->resize(width, height);
}

// One stage's bind group, from the bindings its package declares: the uniform block, and for a
// texture/sampler pair the view and sampler given.
// A stage's bind group: its uniform slice of `uniforms` (dynamic offset when the layout says so), and
// for a texture/sampler pair the view and sampler given.
WGPUBindGroup Renderer::bindGroup(WGPUBindGroupLayout layout, const shader::StageModule& stage, Handle uniforms,
                                  WGPUTextureView view, WGPUSampler sampler, WGPUTextureView mapView,
                                  WGPUSampler mapSampler, WGPUTextureView envView, WGPUSampler envSampler,
                                  WGPUTextureView normalView, WGPUSampler normalSampler,
                                  const std::array<const MaterialTexture*, shader::kPbrMapCount>* pbrMaps,
                                  WGPUTextureView pmremView, WGPUSampler pmremSampler,
                                  WGPUTextureView reflectorView, WGPUSampler reflectorSampler,
                                  const GraphTextures* graphTextures) {
    // A graph texture's GPU texture, by its `t_<name>` / `smp_<name>` binding; null for any other.
    const auto graph = [&](std::string_view name, bool sampler) -> const MaterialTexture* {
        if (!graphTextures) return nullptr;
        for (const auto& [label, texture] : *graphTextures)
            if (name == (sampler ? "smp_" : "t_") + label) return materialTexture(*texture);
        return nullptr;
    };
    // A PbrMap's texture or sampler, by its `t_<name>` / `smp_<name>` binding; null for any other.
    const auto pbr = [&](std::string_view name, bool sampler) -> const MaterialTexture* {
        if (!pbrMaps) return nullptr;
        for (int k = 0; k < shader::kPbrMapCount; ++k)
            if (name == (sampler ? "smp_" : "t_") + std::string(shader::kPbrMapNames[k])) return (*pbrMaps)[k];
        return nullptr;
    };
    std::vector<WGPUBindGroupEntry> entries;
    for (const shader::Binding& b : stage.bindings) {
        WGPUBindGroupEntry e = {};
        e.binding = b.binding;
        if (b.kind == shader::BindingKind::Uniform) {
            e.buffer = gpu_.buffer(uniforms);
            e.size = stage.uniformBlockSize;
        } else if (b.kind == shader::BindingKind::Storage && externalStorage_.count(b.name.substr(2))) {
            const auto& [buffer, bytes] = externalStorage_.at(b.name.substr(2)); // a positionNode's buffer
            e.buffer = (buffer.context == kGeometryHandles ? geometry_->gpu : gpu_).buffer(buffer);
            e.size = bytes;
        } else if (b.kind == shader::BindingKind::Storage && storages_.count(b.name.substr(2))) {
            const FrameStorage& storage = storages_.at(b.name.substr(2)); // "s_<name>"
            e.buffer = gpu_.buffer(storage.buffer);
            e.size = storage.capacity;
        } else if (viewportBinding(b.name)) {
            const bool depthCopy = b.name.find("Depth") != std::string::npos;
            if (b.kind == shader::BindingKind::Texture) e.textureView = depthCopy ? viewportDepthView_ : viewportColorView_;
            else e.sampler = depthCopy ? compareSampler_ : outputSampler_;
        } else if (graphTextureBinding(b.kind == shader::BindingKind::Sampler ? "t_" + b.name.substr(4) : b.name)) {
            // A graph's own texture (texture(object), texture3D), checked before the 3D probe atlases.
            const MaterialTexture* texture = graph(b.name, b.kind == shader::BindingKind::Sampler);
            if (!texture) throw std::runtime_error("TN_NATIVE_BINDING_UNSUPPORTED: " + b.name + " has no texture this draw");
            if (b.kind == shader::BindingKind::Texture) e.textureView = texture->view;
            else e.sampler = texture->sampler;
        } else if (b.volume) {
            const auto& atlas = probeTextures_.at(b.name.substr(b.kind == shader::BindingKind::Texture ? 2 : 4));
            if (b.kind == shader::BindingKind::Texture) e.textureView = atlas.view;
            else e.sampler = atlas.sampler;
        } else if (b.depth) {
            // `t_shadow{i}` / `t_shadowCube{i}` and their samplers: direct light i's shadow map (2D, or a
            // point light's cube) and the comparison sampler.
            const bool virtualMap = b.name.find("vsm") != std::string::npos;
            const std::string prefix = virtualMap ? "vsm" : b.cube ? "shadowCube" : "shadow";
            const std::size_t index = std::stoul(b.name.substr(b.name.find(prefix) + prefix.size()));
            if (b.kind == shader::BindingKind::Texture)
                e.textureView = virtualMap ? virtualShadows_.at(index).map.view : (b.cube ? cubeShadowMaps_ : shadowMaps_).at(index).view;
            else e.sampler = compareSampler_;
        } else if (b.kind == shader::BindingKind::Texture) {
            const auto postView = postEffects_ ? postEffects_->view(b.name.substr(2)) : nullptr;
            const MaterialTexture* pbrTexture = pbr(b.name, false);
            e.textureView = postView ? postView : pbrTexture ? pbrTexture->view : b.name == "t_map" ? mapView : b.name == "t_normalMap" ? normalView : b.name == "t_env" ? envView
                            : b.name == "t_pmrem" ? pmremView : b.name == "t_reflector" ? reflectorView : view;
        } else if (b.kind == shader::BindingKind::Sampler) {
            const bool postView = postEffects_ && postEffects_->view(b.name.substr(4));
            const MaterialTexture* pbrTexture = pbr(b.name, true);
            e.sampler = postView ? postEffects_->sampler(b.name.substr(4)) : pbrTexture ? pbrTexture->sampler : b.name == "smp_map" ? mapSampler : b.name == "smp_normalMap" ? normalSampler : b.name == "smp_env" ? envSampler
                        : b.name == "smp_pmrem" ? pmremSampler : b.name == "smp_reflector" ? reflectorSampler : sampler;
        } else {
            throw std::runtime_error("TN_NATIVE_BINDING_UNSUPPORTED: " + b.name);
        }
        entries.push_back(e);
    }
    WGPUBindGroupDescriptor desc = {};
    desc.layout = layout;
    desc.entryCount = entries.size();
    desc.entries = entries.data();
    return createBindGroup(device_, &desc);
}

void Renderer::initTexture(const Texture& texture) {
    materialTexture(texture);
    flushMipmaps();
}

const Renderer::MaterialTexture* Renderer::materialTexture(const Texture& texture) {
    // A render target's texture is that target's last render, borrowed from its own renderer.
    if (const auto target = std::static_pointer_cast<RenderTarget>(texture.renderTarget.lock())) {
        MaterialTexture& sampled = renderTargetTextures_[texture.ident.value()];
        const WGPUTextureView view = renderTargetView(*this, *target);
        if (sampled.view != view) {
            if (sampled.view) dropMapGroups();  // a resized target's old view address may come back
            sampled.view = view;
            sampled.sampler = linearClampSampler();
        }
        return &sampled;
    }
    MaterialTexture& record = textures_->records[texture.ident.value()];
    if (record.view != nullptr && record.version == texture.version()) return &record;
    if (record.view) texturesChanged();  // its old view's address may be reused by the new one
    record.release();
    // Match WebGPUTextureUtils: FloatType stays RGBA32Float, HalfFloatType RGBA16Float; sRGB byte
    // textures decode before filtering in the GPU, not after filtering in the material/PMREM shader.
    if (texture.isFloat() && !wgpuDeviceHasFeature(device_, WGPUFeatureName_Float32Filterable))
        throw std::runtime_error("TN_NATIVE_TEXTURE_UNSUPPORTED: FloatType requires float32-filterable");
    const WGPUTextureFormat format = textureFormat(texture);
    if (texture.hasImage() && texture.volume) {
        // A Data3DTexture: one 3D texture of `depth` slices, one level (ponytail: a volume's
        // generateMipmaps is ignored; no corpus game turns it on).
        if (texture.flipY) throw std::runtime_error("TN_NATIVE_TEXTURE_UNSUPPORTED: flipY on a Data3DTexture");
        const uint64_t expected = uint64_t(texture.width) * texture.height * texture.depth * texture.bytesPerTexel();
        if (texture.data.size() != expected) throw std::runtime_error("TN_NATIVE_TEXTURE_INVALID: RGBA volume byte count");
        WGPUTextureDescriptor desc = {};
        desc.dimension = WGPUTextureDimension_3D;
        desc.size = {texture.width, texture.height, texture.depth};
        desc.format = format;
        desc.usage = WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst;
        desc.mipLevelCount = 1;
        desc.sampleCount = 1;
        record.texture = wgpuDeviceCreateTexture(device_, &desc);
        WGPUImageCopyTexture_Compat destination = {};
        destination.texture = record.texture;
        destination.aspect = WGPUTextureAspect_All;
        WGPUTextureDataLayout_Compat layout = {};
        layout.bytesPerRow = texture.width * texture.bytesPerTexel();
        layout.rowsPerImage = texture.height;
        const WGPUExtent3D extent = {texture.width, texture.height, texture.depth};
        wgpuQueueWriteTexture(queue_, &destination, texture.data.data(), texture.data.size(), &layout, &extent);
        textures_->uploadBytes += texture.data.size();
        WGPUTextureViewDescriptor view = {};
        view.dimension = WGPUTextureViewDimension_3D;
        view.mipLevelCount = 1;
        view.arrayLayerCount = 1;
        view.format = format;
        record.view = wgpuTextureCreateView(record.texture, &view);
    } else if (texture.hasImage()) {
        // three generates mipmaps for every Texture that is not a DataTexture; float images stay at one level.
        const bool mipmaps = texture.generateMipmaps && texture.bytesPerTexel() == 4;
        uint32_t levels = 1;
        for (uint32_t extent = std::max(texture.width, texture.height); mipmaps && extent > 1; extent >>= 1) ++levels;
        const uint64_t expected = uint64_t(texture.width) * texture.height * texture.bytesPerTexel();
        if (!texture.external && texture.data.size() != expected)
            throw std::runtime_error("TN_NATIVE_TEXTURE_INVALID: RGBA image byte count");
        if (texture.external && (!textures_->copyExternal || texture.bytesPerTexel() != 4))
            throw std::runtime_error("TN_NATIVE_TEXTURE_UNSUPPORTED: a host image needs the host's copy and RGBA8");
        std::vector<uint8_t> flipped;
        const uint8_t* pixels = texture.data.data();
        if (texture.flipY && !texture.external) {
            const size_t row = size_t(texture.width) * texture.bytesPerTexel();
            flipped.resize(texture.data.size());
            for (uint32_t y = 0; y < texture.height; ++y)
                std::memcpy(flipped.data() + size_t(y) * row, texture.data.data() + size_t(texture.height - 1 - y) * row, row);
            pixels = flipped.data();
        }
        WGPUTextureDescriptor desc = {};
        desc.dimension = WGPUTextureDimension_2D;
        desc.size = {texture.width, texture.height, 1};
        desc.format = format;
        // copyExternalImageToTexture writes through a render pass, as the mip chain does.
        desc.usage = WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst |
                     (levels > 1 || texture.external ? WGPUTextureUsage_RenderAttachment : WGPUTextureUsage_None);
        desc.mipLevelCount = levels;
        desc.sampleCount = 1;
        record.texture = wgpuDeviceCreateTexture(device_, &desc);
        WGPUImageCopyTexture_Compat destination = {};
        destination.texture = record.texture;
        destination.aspect = WGPUTextureAspect_All;
        WGPUTextureDataLayout_Compat layout = {};
        layout.bytesPerRow = texture.width * texture.bytesPerTexel();
        layout.rowsPerImage = texture.height;
        const WGPUExtent3D extent = {texture.width, texture.height, 1};
        if (texture.external) {
            if (!textures_->copyExternal(texture.external->id, record.texture, texture.flipY))
                throw std::runtime_error("TN_NATIVE_TEXTURE_UPLOAD_FAILED: the host could not copy its image");
        } else {
            wgpuQueueWriteTexture(queue_, &destination, pixels, texture.data.size(), &layout, &extent);
            textures_->uploadBytes += texture.data.size();
        }
        if (levels > 1) generateMipmaps(record.texture, format, levels);
        WGPUTextureViewDescriptor view = {};
        view.dimension = WGPUTextureViewDimension_2D;
        view.mipLevelCount = levels;
        view.arrayLayerCount = 1;
        view.format = format;
        record.view = wgpuTextureCreateView(record.texture, &view);
    }
    WGPUSamplerDescriptor sampler = {};
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
    const auto pipeline = pipelines_.get(vs, &fs, target);
    if (!pipeline) throw std::runtime_error("TN_NATIVE_PIPELINE_REFUSED: background cube conversion");
    const auto layout = wgpuRenderPipelineGetBindGroupLayout(pipeline, 0);
    const Vector3 directions[6] = {{-1,0,0}, {1,0,0}, {0,1,0}, {0,-1,0}, {0,0,1}, {0,0,-1}};
    const Vector3 ups[6] = {{0,-1,0}, {0,-1,0}, {0,0,1}, {0,0,-1}, {0,-1,0}, {0,-1,0}};
    Handle uniforms[6];
    auto encoder = wgpuDeviceCreateCommandEncoder(device_, nullptr);
    for (uint32_t face = 0; face < 6; ++face) {
        PerspectiveCamera camera(-90, 1, 1, 10); camera.up = ups[face]; camera.lookAt(directions[face]); camera.updateMatrixWorld();
        std::vector<uint8_t> block(fs.uniformBlockSize, 0); put(block, fs, "cubeRotation", camera.matrixWorld.elements);
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
        const auto pass = wgpuCommandEncoderBeginRenderPass(encoder, &passDesc);
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

void Renderer::releaseMaterialTextures() {
    if (mainBundle_) wgpuRenderBundleRelease(mainBundle_);
    if (viewportBundle_) wgpuRenderBundleRelease(viewportBundle_);
    mainBundle_ = viewportBundle_ = nullptr;
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
    if (mainBundle_) wgpuRenderBundleRelease(mainBundle_);
    if (viewportBundle_) wgpuRenderBundleRelease(viewportBundle_);
    mainBundle_ = viewportBundle_ = nullptr;
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
    const auto retired = TextureId::takeRetired();
    if (retired.empty()) return;
    dropMapGroups();
    for (const uint64_t id : retired) {
        if (const auto cube = backgroundCubes_.find(id); cube != backgroundCubes_.end()) {
            if (cube->second.view) wgpuTextureViewRelease(cube->second.view);
            if (cube->second.texture) wgpuTextureRelease(cube->second.texture);
            if (cube->second.sampler) wgpuSamplerRelease(cube->second.sampler);
            backgroundCubes_.erase(cube);
        }
        if (const auto env = environments_.find(id); env != environments_.end()) {
            EnvironmentGpu& e = env->second;
            if (e.view) wgpuTextureViewRelease(e.view);
            if (e.pingView) wgpuTextureViewRelease(e.pingView);
            if (e.texture) wgpuTextureRelease(e.texture);
            if (e.pingpong) wgpuTextureRelease(e.pingpong);
            if (e.sampler) wgpuSamplerRelease(e.sampler);
            environments_.erase(env);
        }
        if (const auto record = textures_->records.find(id); record != textures_->records.end()) {
            record->second.release();
            textures_->records.erase(record);
            texturesChanged();
        }
    }
}

void Renderer::releaseEnvironments() {
    for (auto& [texture, env] : environments_) {
        if (env.view) wgpuTextureViewRelease(env.view);
        if (env.pingView) wgpuTextureViewRelease(env.pingView);
        if (env.texture) wgpuTextureRelease(env.texture);
        if (env.pingpong) wgpuTextureRelease(env.pingpong);
        if (env.sampler) wgpuSamplerRelease(env.sampler);
    }
    environments_.clear();
    if (envEquirectPipeline_) wgpuRenderPipelineRelease(envEquirectPipeline_);
    if (envGgxPipeline_) wgpuRenderPipelineRelease(envGgxPipeline_);
    if (envPipelineLayout_) wgpuPipelineLayoutRelease(envPipelineLayout_);
    if (envLayout_) wgpuBindGroupLayoutRelease(envLayout_);
    envEquirectPipeline_ = envGgxPipeline_ = nullptr;
    envPipelineLayout_ = nullptr;
    envLayout_ = nullptr;
}

void Renderer::buildEnvironmentPipelines() {
    if (envGgxPipeline_) return;
    WGPUBindGroupLayoutEntry entries[3] = {};
    entries[0].binding = 0;
    entries[0].visibility = WGPUShaderStage_Vertex | WGPUShaderStage_Fragment;
    entries[0].buffer.type = WGPUBufferBindingType_Uniform;
    entries[0].buffer.minBindingSize = 32;
    entries[1].binding = 1;
    entries[1].visibility = WGPUShaderStage_Fragment;
    entries[1].texture.sampleType = WGPUTextureSampleType_Float;
    entries[1].texture.viewDimension = WGPUTextureViewDimension_2D;
    entries[2].binding = 2;
    entries[2].visibility = WGPUShaderStage_Fragment;
    entries[2].sampler.type = WGPUSamplerBindingType_Filtering;
    WGPUBindGroupLayoutDescriptor layoutDesc = {};
    layoutDesc.entryCount = 3;
    layoutDesc.entries = entries;
    envLayout_ = wgpuDeviceCreateBindGroupLayout(device_, &layoutDesc);
    WGPUPipelineLayoutDescriptor pipelineLayoutDesc = {};
    pipelineLayoutDesc.bindGroupLayoutCount = 1;
    pipelineLayoutDesc.bindGroupLayouts = &envLayout_;
    envPipelineLayout_ = wgpuDeviceCreatePipelineLayout(device_, &pipelineLayoutDesc);

    WGPUVertexAttribute attributes[3] = {};
    attributes[0].format = WGPUVertexFormat_Float32x3;
    attributes[0].offset = 0;
    attributes[0].shaderLocation = 0;
    attributes[1].format = WGPUVertexFormat_Float32x2;
    attributes[1].offset = 12;
    attributes[1].shaderLocation = 1;
    attributes[2].format = WGPUVertexFormat_Float32;
    attributes[2].offset = 20;
    attributes[2].shaderLocation = 2;
    WGPUVertexBufferLayout vertexBuffer = {};
    vertexBuffer.arrayStride = 24;
    vertexBuffer.stepMode = WGPUVertexStepMode_Vertex;
    vertexBuffer.attributeCount = 3;
    vertexBuffer.attributes = attributes;

    auto pipeline = [&](const char* fragment) {
        std::string code = kPmremPrelude;
        code += fragment;
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
        desc.layout = envPipelineLayout_;
        desc.vertex.module = module;
        WGPU_SET_ENTRY_POINT(desc.vertex, "vs");
        desc.vertex.bufferCount = 1;
        desc.vertex.buffers = &vertexBuffer;
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
    envEquirectPipeline_ = pipeline(kPmremEquirect);
    envGgxPipeline_ = pipeline(kPmremGgx);
}

Renderer::EnvironmentGpu& Renderer::environment(const Texture& equirect) {
    if (equirect.mapping != 303)
        throw std::runtime_error("TN_NATIVE_ENVIRONMENT_UNSUPPORTED: requires EquirectangularReflectionMapping");
    if (equirect.width < 64 || !equirect.hasImage() || equirect.format != kTextureRGBAFormat ||
        (equirect.type != kTextureFloatType && equirect.type != kTextureHalfFloatType && equirect.type != kTextureUnsignedByteType) ||
        uint64_t(equirect.width) * equirect.height * equirect.bytesPerTexel() != equirect.data.size())
        throw std::runtime_error("TN_NATIVE_ENVIRONMENT_INVALID: requires decoded RGBA equirectangular pixels, width >= 64");
    EnvironmentGpu& env = environments_[equirect.ident.value()];
    if (env.view != nullptr && env.version == equirect.version()) return env;
    if (env.view) wgpuTextureViewRelease(env.view);
    if (env.pingView) wgpuTextureViewRelease(env.pingView);
    if (env.texture) wgpuTextureRelease(env.texture);
    if (env.pingpong) wgpuTextureRelease(env.pingpong);
    if (env.sampler) wgpuSamplerRelease(env.sampler);
    env = EnvironmentGpu{};
    env.source = &equirect;
    env.version = equirect.version();
    const MaterialTexture* source = materialTexture(equirect);
    if (source->view == nullptr) throw std::runtime_error("TN_NATIVE_ENVIRONMENT_UPLOAD_FAILED");
    // three's _setSizeFromTexture: an equirect's cube size is image.width / 4.
    uint32_t cubeSize = std::max(equirect.width / 4, 1u);
    uint32_t lodMax = 0;
    while ((2u << lodMax) <= cubeSize) ++lodMax;
    cubeSize = 1u << lodMax;
    env.cubeSize = cubeSize;
    env.lodMax = lodMax;
    env.lods = lodMax - 4 + 1 + 6;  // LOD_MIN=4, EXTRA_LOD_SIGMA.length=6 in pinned PMREMGenerator
    // _createPlanes computes positions and each LOD's expanded UVs in JS doubles, then stores
    // Float32Arrays. Expanding base UVs in the vertex shader adds a second, different f32 rounding.
    std::vector<float> data;
    data.reserve(env.lods * 36 * 6);
    static const unsigned kFaceLib[6] = {3, 1, 5, 0, 4, 2};
    for (uint32_t i = 0; i < env.lods; ++i) {
        const double size = double(1u << std::max(int(lodMax) - int(i), 4));
        const double texelSize = 1.0 / (size - 2);
        const float min = float(-texelSize), max = float(1.0 + texelSize);
        const float uv[6][2] = {{min, min}, {max, min}, {max, max}, {min, min}, {max, max}, {min, max}};
        std::array<float, 36 * 6> vertices{};
        for (unsigned face = 0; face < 6; ++face) {
            const double x = double(face % 3) * 2.0 / 3.0 - 1.0;
            const double y = face > 2 ? 0.0 : -1.0;
            const double coordinates[6][3] = {{x, y, 0}, {x + 2.0 / 3.0, y, 0}, {x + 2.0 / 3.0, y + 1, 0},
                                              {x, y, 0}, {x + 2.0 / 3.0, y + 1, 0}, {x, y + 1, 0}};
            const unsigned faceIdx = kFaceLib[face];
            for (unsigned v = 0; v < 6; ++v) {
                const unsigned offset = (faceIdx * 6 + v) * 6;
                for (unsigned c = 0; c < 3; ++c) vertices[offset + c] = float(coordinates[v][c]);
                vertices[offset + 3] = uv[v][0];
                vertices[offset + 4] = uv[v][1];
                vertices[offset + 5] = float(faceIdx);
            }
        }
        data.insert(data.end(), vertices.begin(), vertices.end());
    }
    const uint64_t vertexBytes = data.size() * sizeof(float);
    if (envVertex_.type == 0 || envVertexCapacity_ < vertexBytes) {
        if (envVertex_.type != 0) gpu_.destroy(envVertex_);
        envVertexCapacity_ = vertexBytes;
        envVertex_ = gpu_.createBuffer(vertexBytes, WGPUBufferUsage_Vertex | WGPUBufferUsage_CopyDst);
    }
    gpu_.writeBuffer(envVertex_, 0, data.data(), vertexBytes);
    const uint32_t width = 3 * std::max(cubeSize, 112u);
    const uint32_t height = 4 * cubeSize;
    env.width = width;
    env.height = height;
    env.texelWidth = 1.0f / float(width);
    env.texelHeight = 1.0f / float(height);
    env.maxMip = float(lodMax);
    WGPUTextureDescriptor target = {};
    target.dimension = WGPUTextureDimension_2D;
    target.size = {width, height, 1};
    target.format = WGPUTextureFormat_RGBA16Float;
    target.usage = WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_TextureBinding;
    target.mipLevelCount = 1;
    target.sampleCount = 1;
    env.texture = wgpuDeviceCreateTexture(device_, &target);
    env.pingpong = wgpuDeviceCreateTexture(device_, &target);
    env.view = view2d(env.texture, WGPUTextureFormat_RGBA16Float);
    env.pingView = view2d(env.pingpong, WGPUTextureFormat_RGBA16Float);
    WGPUSamplerDescriptor sampler = {};
    sampler.magFilter = sampler.minFilter = WGPUFilterMode_Linear;
    sampler.addressModeU = sampler.addressModeV = sampler.addressModeW = WGPUAddressMode_ClampToEdge;
    sampler.maxAnisotropy = 1;
    env.sampler = wgpuDeviceCreateSampler(device_, &sampler);
    buildEnvironmentPipelines();

    // Every pass's uniform slice, then the passes themselves.
    struct Pass {
        WGPUTextureView target;
        WGPUTextureView source;
        WGPUSampler sampler;
        WGPURenderPipeline pipeline;
        float x, y, w, h;
        float roughness, mipInt;
        uint64_t vertexOffset;
    };
    std::vector<Pass> passes;
    passes.push_back({env.view, source->view, source->sampler, envEquirectPipeline_, 0, 0,
                      float(3 * cubeSize), float(2 * cubeSize), 0.0f, 0.0f, 0});
    int lod = int(lodMax);
    for (int i = 1; i < int(env.lods); ++i) {
        if (lod > 4) --lod;
        const float size = float(1u << lod);
        // _applyGGXFilter computes these in JavaScript doubles and rounds once, on upload to f32.
        const double targetRoughness = double(i) / double(env.lods - 1);
        const double sourceRoughness = double(i - 1) / double(env.lods - 1);
        const double incremental = std::sqrt(targetRoughness * targetRoughness - sourceRoughness * sourceRoughness);
        const float adjusted = float(incremental * (0.0 + targetRoughness * 1.25));
        const float x = 3.0f * size * float(i > int(lodMax) - 4 ? i - int(lodMax) + 4 : 0);
        const float y = 4.0f * float(cubeSize - unsigned(size));
        // Render the GGX result into the ping-pong, then copy it back (roughness 0).
        passes.push_back({env.pingView, env.view, env.sampler, envGgxPipeline_, x, y, 3.0f * size, 2.0f * size,
                          adjusted, shader::pmremMip(lodMax, i - 1), uint64_t(i) * 36 * 24});
        passes.push_back({env.view, env.pingView, env.sampler, envGgxPipeline_, x, y, 3.0f * size, 2.0f * size,
                          0.0f, shader::pmremMip(lodMax, i), uint64_t(i) * 36 * 24});
    }
    const uint64_t stride = aligned(32);
    const uint64_t total = stride * passes.size();
    if (envUniforms_.type == 0 || envUniformCapacity_ < total) {
        if (envUniforms_.type != 0) gpu_.destroy(envUniforms_);
        envUniformCapacity_ = std::max<uint64_t>(total, 4096);
        envUniforms_ = gpu_.createBuffer(envUniformCapacity_, WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst);
    }
    std::vector<float> uniforms(envUniformCapacity_ / 4, 0.0f);
    for (std::size_t p = 0; p < passes.size(); ++p) {
        float* slice = uniforms.data() + (p * stride) / 4;
        slice[0] = passes[p].roughness;
        slice[1] = passes[p].mipInt;
        slice[2] = env.texelWidth;
        slice[3] = env.texelHeight;
        slice[4] = env.maxMip;
    }
    gpu_.writeBuffer(envUniforms_, 0, uniforms.data(), uniforms.size() * 4);

    WGPUCommandEncoderDescriptor encoderDesc = {};
    WGPUCommandEncoder encoder = wgpuDeviceCreateCommandEncoder(device_, &encoderDesc);
    for (std::size_t p = 0; p < passes.size(); ++p) {
        WGPUBindGroupEntry entries[3] = {};
        entries[0].binding = 0;
        entries[0].buffer = gpu_.buffer(envUniforms_);
        entries[0].offset = p * stride;
        entries[0].size = 32;
        entries[1].binding = 1;
        entries[1].textureView = passes[p].source;
        entries[2].binding = 2;
        entries[2].sampler = passes[p].sampler;
        WGPUBindGroupDescriptor groupDesc = {};
        groupDesc.layout = envLayout_;
        groupDesc.entryCount = 3;
        groupDesc.entries = entries;
        WGPUBindGroup group = createBindGroup(device_, &groupDesc);
        WGPURenderPassColorAttachment color = {};
        color.view = passes[p].target;
        color.loadOp = p == 0 ? WGPULoadOp_Clear : WGPULoadOp_Load;
        color.storeOp = WGPUStoreOp_Store;
        color.clearValue = {0, 0, 0, 1};
#if defined(MYSTRAL_WEBGPU_DAWN)
        color.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
#endif
        WGPURenderPassDescriptor passDesc = {};
        passDesc.colorAttachmentCount = 1;
        passDesc.colorAttachments = &color;
        WGPURenderPassEncoder pass = wgpuCommandEncoderBeginRenderPass(encoder, &passDesc);
        wgpuRenderPassEncoderSetViewport(pass, passes[p].x, passes[p].y, passes[p].w, passes[p].h, 0.0f, 1.0f);
        wgpuRenderPassEncoderSetScissorRect(pass, uint32_t(passes[p].x), uint32_t(passes[p].y), uint32_t(passes[p].w),
                                            uint32_t(passes[p].h));
        wgpuRenderPassEncoderSetPipeline(pass, passes[p].pipeline);
        wgpuRenderPassEncoderSetBindGroup(pass, 0, group, 0, nullptr);
        wgpuRenderPassEncoderSetVertexBuffer(pass, 0, gpu_.buffer(envVertex_), passes[p].vertexOffset, 36 * 24);
        wgpuRenderPassEncoderDraw(pass, 36, 1, 0, 0);
        wgpuRenderPassEncoderEnd(pass);
        wgpuRenderPassEncoderRelease(pass);
        wgpuBindGroupRelease(group);
    }
    WGPUCommandBufferDescriptor commandDesc = {};
    submit(wgpuCommandEncoderFinish(encoder, &commandDesc));
    wgpuCommandEncoderRelease(encoder);
    return env;
}

// Each stage's layout from the bindings its package declares, the uniform block with a dynamic
// offset; the uniform slots resolved to fields once, so a draw never looks a name up.
void Renderer::buildLayouts(Program& program) {
    const shader::StageModule* stages[2] = {&program.vertex, &program.fragment};
    for (int g = 0; g < 2; ++g) {
        std::vector<WGPUBindGroupLayoutEntry> entries;
        for (const shader::Binding& b : stages[g]->bindings) {
            WGPUBindGroupLayoutEntry e = {};
            e.binding = b.binding;
            e.visibility = g == 0 ? WGPUShaderStage_Vertex : WGPUShaderStage_Fragment;
            if (b.kind == shader::BindingKind::Uniform) {
                e.buffer.type = WGPUBufferBindingType_Uniform;
                e.buffer.hasDynamicOffset = true;
                e.buffer.minBindingSize = stages[g]->uniformBlockSize;
            } else if (b.kind == shader::BindingKind::Storage) {
                e.buffer.type = WGPUBufferBindingType_ReadOnlyStorage;
                e.buffer.minBindingSize = b.minSize;
            } else if (b.kind == shader::BindingKind::Texture) {
                e.texture.sampleType = b.depth ? WGPUTextureSampleType_Depth : WGPUTextureSampleType_Float;
                e.texture.viewDimension = b.volume ? WGPUTextureViewDimension_3D
                                          : b.cube ? WGPUTextureViewDimension_Cube : WGPUTextureViewDimension_2D;
            } else if (b.kind == shader::BindingKind::Sampler) {
                e.sampler.type = b.depth ? WGPUSamplerBindingType_Comparison : WGPUSamplerBindingType_Filtering;
            } else {
                throw std::runtime_error("TN_NATIVE_BINDING_UNSUPPORTED: " + b.name);
            }
            entries.push_back(e);
        }
        WGPUBindGroupLayoutDescriptor desc = {};
        desc.entryCount = entries.size();
        desc.entries = entries.data();
        program.layouts[g] = wgpuDeviceCreateBindGroupLayout(device_, &desc);
    }
    WGPUPipelineLayoutDescriptor desc = {};
    desc.bindGroupLayoutCount = 2;
    desc.bindGroupLayouts = program.layouts;
    program.pipelineLayout = wgpuDeviceCreatePipelineLayout(device_, &desc);
    for (int s = 0; s < kSlotCount; ++s) {
        for (const shader::UniformField& f : program.vertex.uniforms)
            if (f.name == kSlotNames[s]) program.vertexSlots[s] = &f;
        for (const shader::UniformField& f : program.fragment.uniforms)
            if (f.name == kSlotNames[s]) program.fragmentSlots[s] = &f;
    }
    for (const shader::UniformField& f : program.fragment.uniforms) {
        if (f.name.rfind("light", 0) != 0) continue;
        std::size_t end = 5;
        while (end < f.name.size() && std::isdigit(static_cast<unsigned char>(f.name[end]))) ++end;
        if (end == 5) continue;
        const std::size_t index = std::stoul(f.name.substr(5, end - 5));
        if (program.lightSlots.size() <= index) program.lightSlots.resize(index + 1);
        for (int field = 0; field < kLightFieldCount; ++field)
            if (f.name.compare(end, std::string::npos, kLightFieldNames[field]) == 0) program.lightSlots[index][field] = &f;
    }
}

Renderer::Program* Renderer::program(MaterialKind kind, const shader::VertexVariant& vv, const std::string& lights,
                                     bool softShadows) {
    ++programKeyBuilds_;
    ++programLookups_;
    const std::string key = std::to_string(static_cast<int>(kind)) + "|" + vv.key() + "|" + lights + (softShadows ? "|soft" : "");
    const auto refuse = [&](const std::string& reason) -> Program* {
        if (std::find(diagnostics_.begin(), diagnostics_.end(), reason) == diagnostics_.end()) diagnostics_.push_back(reason);
        return nullptr;
    };
    if (const auto found = programs_.find(key); found != programs_.end())
        return found->second ? found->second.get() : refuse(refusedPrograms_.at(key));
    const auto refuseBuild = [&](const std::string& why) {
        programs_[key] = nullptr;
        return refuse(refusedPrograms_[key] = "TN_NATIVE_SHADER_INVALID: material program " + key.substr(0, 120) +
                                              (key.size() > 120 ? "...: " : ": ") + why);
    };
    const shader::LightLayout layout{lights, softShadows};
    shader::StandardPrograms source;
    try {
        switch (kind) {
        case MaterialKind::Standard: source = shader::buildStandard(shader::StandardMaterial{}, vv, layout); break;
        case MaterialKind::Basic: source = vv.sprite ? shader::buildSprite(vv) : shader::buildBasic(vv); break;
        case MaterialKind::Lambert: source = shader::buildLambert(vv, layout); break;
        case MaterialKind::Phong: source = shader::buildPhong(vv, layout); break;
        case MaterialKind::Physical: source = shader::buildPhysical(shader::StandardMaterial{}, vv, layout); break;
        }
    } catch (const std::exception& error) {
        return refuseBuild(error.what());  // a graph the builder refuses (TN_TSL_VARYING_CONFLICT, ...)
    }
    // The first construction diagnostic names the node; the WGSL error only says there was one.
    for (const shader::Program* stage : {&source.vertex, &source.fragment})
        if (!stage->diagnostics().empty()) {
            const auto& d = stage->diagnostics().front();
            return refuseBuild(d.code + ": " + d.node + ": " + d.reason);
        }
    source.vertex.setInvariantPosition(vv.invariantPosition);
    shader::StageModule vertex = shader::buildStage(source.vertex, 0);
    shader::StageModule fragment = shader::buildStage(source.fragment, 1);
    if (!vertex.wgsl.ok() || !fragment.wgsl.ok()) {
        const auto& errors = vertex.wgsl.ok() ? fragment.wgsl.errors : vertex.wgsl.errors;
        return refuseBuild(errors.empty() ? "no reason" : errors.front());
    }
    return &add(key, std::move(vertex), std::move(fragment));
}

Renderer::Program& Renderer::depthProgram(const shader::VertexVariant& variant) {
    ++programKeyBuilds_;
    ++programLookups_;
    shader::VertexVariant kind = variant;
    kind.instanceColor = false;
    kind.vertexColors = 0;
    kind.invariantPosition = false;  // the shadow depth pass shares its vertex stage with nothing
    const auto positionGraph = kind.nodes.positionNode;
    kind.nodes = {};
    kind.nodes.positionNode = positionGraph; // a depth pass reads no colour
    kind.nodes.vertexNode = variant.nodes.vertexNode;  // ...but casts where the vertexNode puts it
    kind.map = false;           // ...nor a diffuse map: no uv passes through the depth program
    const std::string key = "depth|" + kind.key();
    if (const auto found = programs_.find(key); found != programs_.end()) return *found->second;
    // three's shadow pass draws with the default positionNode, the same transform as a basic material.
    shader::StageModule vertex = shader::buildStage(shader::buildBasic(kind).vertex, 0);
    if (!vertex.wgsl.ok()) throw std::runtime_error("TN_NATIVE_SHADER_INVALID: shadow depth program");
    shader::StageModule fragment;
    fragment.stage = shader::Stage::Fragment;
    return add(key, std::move(vertex), std::move(fragment));
}

Renderer::Program& Renderer::add(const std::string& key, shader::StageModule vertex, shader::StageModule fragment) {
    auto built = std::make_unique<Program>();
    built->vertex = std::move(vertex);
    built->fragment = std::move(fragment);
    buildLayouts(*built);
    if (uniformCapacity_ != 0) {
        for (int g = 0; g < 2; ++g) {
            if (g == 1 && perDrawFragment(built->fragment)) continue;  // per-draw groups instead
            if (g == 0 && perDrawVertex(built->vertex)) continue;
            built->groups[g] = bindGroup(built->layouts[g], g == 0 ? built->vertex : built->fragment, uniformBuffer_,
                                         lutView_, lutSampler_);
        }
    }
    return *programs_.emplace(key, std::move(built)).first->second;
}

void Renderer::rebuildGroups() {
    if (mainBundle_) wgpuRenderBundleRelease(mainBundle_);
    if (viewportBundle_) wgpuRenderBundleRelease(viewportBundle_);
    mainBundle_ = viewportBundle_ = nullptr; // Emdawn may recycle a released bind-group handle immediately
    for (auto& [key, group] : mapGroups_)  // they bind the old uniform buffer
        if (group) wgpuBindGroupRelease(group);
    mapGroups_.clear();
    ++groupEpoch_;
    for (auto& [key, program] : programs_) {
        if (!program) continue;  // a refused program
        for (int g = 0; g < 2; ++g) {
            if (program->groups[g]) wgpuBindGroupRelease(program->groups[g]);
            program->groups[g] = (g == 1 && perDrawFragment(program->fragment)) || (g == 0 && perDrawVertex(program->vertex))
                                     ? nullptr
                                     : bindGroup(program->layouts[g], g == 0 ? program->vertex : program->fragment,
                                                 uniformBuffer_, lutView_, lutSampler_);
        }
    }
}

std::vector<std::pair<double, const DrawItem*>> Renderer::sortDraws(std::span<const DrawItem> items,
                                                                 const CameraState& camera) {
    // RenderList: z is the object origin's clip-space depth (setFromMatrixPosition, then the
    // projection-view matrix); painterSortStable for opaques, reversePainterSortStable for the rest.
    const Matrix projView = multiply(camera.projectionMatrix, camera.matrixWorldInverse);
    std::vector<std::pair<double, const DrawItem*>> opaque, transparent;
    for (const DrawItem& item : items) {
        const Matrix& m = item.matrixWorld;
        const auto origin = item.sortOrigin.value_or(std::array<double, 3>{m[12], m[13], m[14]});
        const double z = projView[2] * origin[0] + projView[6] * origin[1] + projView[10] * origin[2] + projView[14];
        const double w = projView[3] * origin[0] + projView[7] * origin[1] + projView[11] * origin[2] + projView[15];
        (item.transparent ? transparent : opaque).push_back({z / w, &item});
    }
    std::sort(opaque.begin(), opaque.end(), [](const auto& a, const auto& b) {
        if (a.second->background != b.second->background) return a.second->background;
        if (a.second->renderOrder != b.second->renderOrder) return a.second->renderOrder < b.second->renderOrder;
        if (a.first != b.first) return a.first < b.first;
        return a.second->id < b.second->id;
    });
    // Stable: a transparent DoubleSide material's BackSide pass stays right before its FrontSide pass.
    std::stable_sort(transparent.begin(), transparent.end(), [](const auto& a, const auto& b) {
        if (a.second->renderOrder != b.second->renderOrder) return a.second->renderOrder < b.second->renderOrder;
        if (a.first != b.first) return a.first > b.first;
        return a.second->id < b.second->id;
    });
    opaque.insert(opaque.end(), transparent.begin(), transparent.end());

    return opaque;
}

uint64_t Renderer::render(std::span<const DrawItem> items, const CameraState& camera, const LightState& lights,
                          std::array<double, 4> clear) {
    return renderPrepared(items, camera, lights, clear, nullptr, WGPUTextureFormat_RGBA8Unorm);
}

std::vector<std::shared_ptr<PipelineCompilation>> Renderer::compileAsync(std::span<const DrawItem> items,
    const CameraState& camera, const LightState& lights, WGPUTextureFormat outputFormat) {
    std::vector<std::shared_ptr<PipelineCompilation>> compilation;
    renderPrepared(items, camera, lights, {}, &compilation, outputFormat);
    return compilation;
}

uint64_t Renderer::renderPrepared(std::span<const DrawItem> items, const CameraState& unjitteredCamera,
    const LightState& lights, std::array<double, 4> clear,
    std::vector<std::shared_ptr<PipelineCompilation>>* compilation, WGPUTextureFormat outputFormat) {
    const uint64_t id = compilation ? renderId_ : ++renderId_;
    // Taken at once: a frame that throws must not leave a borrowed view armed for the next one.
    const WGPUTextureView presentTarget = compilation ? nullptr : std::exchange(presentTarget_, nullptr);
    const WGPUTextureFormat presentFormat = presentFormat_;
    CameraState camera = unjitteredCamera;
    if (traa_ && !compilation) camera.projectionMatrix = traa_->begin(camera.projectionMatrix, camera.matrixWorld, camera.matrixWorldInverse);
    const Matrix& view = camera.matrixWorldInverse;
    geometry_->cache.sweep();  // GPU copies of attributes released since the last frame
    sweepTextures();    // ...and of textures that no longer exist
    // A sibling replaced or released a shared map texture: this renderer's groups may bind its old view.
    if (texturesSeen_ != textures_->generation) texturesChanged();
    diagnostics_.clear();
    frameTime_ = std::chrono::duration<float>(std::chrono::steady_clock::now() - start_).count();
    // storage(attribute) reads: each attribute's data is the storage buffer its name binds, synced
    // like a vertex buffer. A new or regrown buffer rebinds the programs' groups before any draw.
    bool storagesMoved = false;
    for (const DrawItem& item : items) {
        if (!item.nodeStorages) continue;
        for (const auto& [name, attribute] : *item.nodeStorages) {
            const Handle buffer = geometry_->cache.sync(*attribute->store, WGPUBufferUsage_Storage);
            const std::pair<Handle, uint64_t> bound{buffer, attribute->store->byteLength()};
            if (const auto found = externalStorage_.find(name); found != externalStorage_.end()) {
                const Handle& was = found->second.first;
                if (was.type == buffer.type && was.context == buffer.context && was.index == buffer.index &&
                    was.generation == buffer.generation && found->second.second == bound.second)
                    continue;
            }
            setStorage(name, bound.first, bound.second);
            storagesMoved = true;
        }
    }
    if (storagesMoved && uniformCapacity_ != 0) rebuildGroups();

    WGPUCommandEncoderDescriptor encoderDesc = {};
    WGPUCommandEncoder encoder = compilation ? nullptr : wgpuDeviceCreateCommandEncoder(device_, &encoderDesc);
    WGPURenderPassColorAttachment color = {};
    if (sampleCount_ == 4) {
        color.view = msaaColorView_;
        color.resolveTarget = sceneView_;
    } else {
        color.view = sceneView_;
    }
    color.loadOp = WGPULoadOp_Clear;
    color.storeOp = WGPUStoreOp_Store;
    color.clearValue = {clear[0], clear[1], clear[2], clear[3]};
#if defined(MYSTRAL_WEBGPU_DAWN)
    color.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
#endif
    WGPURenderPassDepthStencilAttachment depth = {};
    depth.view = sampleCount_ == 4 ? msaaDepthView_ : depthView_;
    depth.depthLoadOp = WGPULoadOp_Clear;
    depth.depthStoreOp = WGPUStoreOp_Store;
    depth.depthClearValue = 1.0f;
    WGPURenderPassDescriptor passDesc = {};
    passDesc.colorAttachmentCount = 1;
    passDesc.colorAttachments = &color;
    passDesc.depthStencilAttachment = &depth;
    const bool timed = timestamps_ && gpuTimer_ && !timing_->pending;
    WGPURenderPassTimestampWrites_Compat sceneTimes = {};
    if (timed) {
        sceneTimes.querySet = timestamps_;
        // Both indices on both passes: a browser rejects the "undefined" index sentinel.
        sceneTimes.beginningOfPassWriteIndex = 0;
        sceneTimes.endOfPassWriteIndex = 1;
        passDesc.timestampWrites = &sceneTimes;
    }

    const auto opaque = sortDraws(items, camera);

    // The light layout every lit program this frame is specialized for, in three's light order.
    // Upper case: the light casts a shadow, which a receiving mesh's program reads; a mesh that does
    // not receive shadows takes the lower-case layout, as three keys a program on receiveShadow.
    std::map<std::size_t, std::vector<shadows::AtlasPage>> virtualPages;
    std::map<std::size_t, std::map<uint64_t, Box3>> casterBounds;
    for (auto& [i, shadow] : virtualShadows_) {
        if (compilation) continue;
        if (i >= lights.direct.size() || lights.direct[i].kind != DirectLight::Kind::Directional || !lights.direct[i].shadow)
            throw std::runtime_error("TN_VIRTUAL_SHADOW_UNSUPPORTED: requires a shadow-casting directional light");
        const uint32_t mask = lights.direct[i].shadow->layersMask;
        auto& lightCasterBounds = casterBounds[i];
        for (const DrawItem& item : items) {
            if (!item.castShadow || !item.positions || item.instanceCount == 0 || (item.layers & mask) == 0) continue;
            Box3 bounds;
            if (item.positions->scalar() == Scalar::F32) {
                for (uint64_t idx = 0; idx + 2 < item.positions->count(); idx += 3) {
                    float p[3]; item.positions->read(idx * 4, p, sizeof(p));
                    bounds.expandByPoint(Vector3(p[0], p[1], p[2]));
                }
            }
            Matrix4 model; model.elements = item.matrixWorld;
            bounds.applyMatrix4(model);
            lightCasterBounds[item.key] = bounds;
        }
        const auto& direction = lights.direct[i].direction;
        const Vector3 towards(direction[0], direction[1], direction[2]);
        if (!std::isfinite(towards.lengthSq()) || towards.lengthSq() == 0)
            throw std::runtime_error("TN_VIRTUAL_SHADOW_INVALID: light direction");
        const double radius = lights.direct[i].shadow->radius;
        if (!std::isfinite(radius) || radius < 0 || radius + 0.5 > shadow.atlas.options().border)
            throw std::runtime_error("TN_VIRTUAL_SHADOW_UNSUPPORTED: PCF radius exceeds page guard texels");
        for (const auto& [key, bounds] : shadow.casters) {
            const auto now = lightCasterBounds.find(key);
            if (now == lightCasterBounds.end() || !shadows::boundsEqual(bounds, now->second)) shadow.atlas.invalidate(bounds);
        }
        for (const auto& [key, bounds] : lightCasterBounds) {
            const auto old = shadow.casters.find(key);
            if (old == shadow.casters.end() || !shadows::boundsEqual(bounds, old->second)) shadow.atlas.invalidate(bounds);
        }
        // A shader can displace beyond the CPU AABB. Redraw and bypass the bounds gate rather than
        // silently clipping a caster whose deformation cannot be evaluated on the CPU.
        std::map<uint64_t, std::string> casterPrograms;
        for (const DrawItem& item : items) {
            if (!item.castShadow || !item.positions || item.instanceCount == 0 || (item.layers & mask) == 0) continue;
            std::string signature = std::to_string(item.positions->version());
            if (item.instanceMatrices) signature += ":instances:" + std::to_string(item.instanceMatrices->version()) + ":" + std::to_string(item.instanceCount);
            if (item.nodes.positionNode) {
                signature += "#" + std::to_string(shader::graph::keyId(item.nodes.positionNode));
                for (const auto& node : shader::graph::uniformList(item.nodes.positionNode)) {
                    signature += node->name;
                    signature.append(reinterpret_cast<const char*>(node->values.data()), node->values.size() * sizeof(float));
                }
            }
            if (item.positionNode || item.boneMatrices || item.morphGeometry ||
                (shadow.casterPrograms.count(item.key) && shadow.casterPrograms.at(item.key) != signature)) shadow.atlas.invalidateAll();
            casterPrograms[item.key] = std::move(signature);
        }
        shadow.casterPrograms = std::move(casterPrograms);
        shadow.casters = lightCasterBounds;
        virtualPages[i] = shadow.atlas.update(Vector3(camera.matrixWorld[12], camera.matrixWorld[13], camera.matrixWorld[14]), towards, virtualCut_);
    }
    if (!compilation) virtualCut_ = false;
    std::string lightKinds, unshadowedKinds;
    for (std::size_t i = 0; i < lights.direct.size(); ++i) {
        const DirectLight& l = lights.direct[i];
        const char kind = l.kind == DirectLight::Kind::Directional ? 'd' : l.kind == DirectLight::Kind::Point ? 'p' : 's';
        unshadowedKinds += kind;
        lightKinds += virtualShadows_.count(i) ? char('0' + virtualShadows_.at(i).atlas.options().clipExtents.size()) : l.shadow ? static_cast<char>(kind - 'a' + 'A') : kind;
        if (virtualShadows_.count(i)) {
            auto& shadow = virtualShadows_.at(i);
            if (shadow.map.texture) continue;
            WGPUTextureDescriptor desc = {};
            desc.dimension = WGPUTextureDimension_2D;
            desc.size = {uint32_t(shadow.atlas.edge()), uint32_t(shadow.atlas.edge()), 1};
            WGPULimits limits = {}; wgpuDeviceGetLimits(device_, &limits);
            if (desc.size.width > limits.maxTextureDimension2D)
                throw std::runtime_error("TN_VIRTUAL_SHADOW_UNSUPPORTED: atlas exceeds device texture limit");
            desc.format = WGPUTextureFormat_Depth24Plus;
            desc.usage = WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_TextureBinding;
            desc.mipLevelCount = desc.sampleCount = 1;
            shadow.map.texture = wgpuDeviceCreateTexture(device_, &desc);
            shadow.map.view = view2d(shadow.map.texture, desc.format);
            shadow.map.width = shadow.map.height = desc.size.width;
            shadowMapsChanged_ = true;
            continue;
        }
        if (!l.shadow) continue;
        std::vector<ShadowMap>& maps = l.shadow->cube ? cubeShadowMaps_ : shadowMaps_;
        if (maps.size() <= i) maps.resize(i + 1);
        ShadowMap& map = maps[i];
        if (map.width == l.shadow->width && map.height == l.shadow->height) continue;
        if (map.view) wgpuTextureViewRelease(map.view);
        for (WGPUTextureView& face : map.faces) {
            if (face) wgpuTextureViewRelease(face);
            face = nullptr;
        }
        if (map.texture) wgpuTextureRelease(map.texture);
        WGPUTextureDescriptor desc = {};
        desc.dimension = WGPUTextureDimension_2D;
        desc.size = {l.shadow->width, l.shadow->height, l.shadow->cube ? 6u : 1u};
        desc.format = WGPUTextureFormat_Depth24Plus;
        desc.usage = WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_TextureBinding;
        desc.mipLevelCount = 1;
        desc.sampleCount = 1;
        map.texture = wgpuDeviceCreateTexture(device_, &desc);
        map.cube = l.shadow->cube;
        if (map.cube) {
            WGPUTextureViewDescriptor view = {};
            view.format = WGPUTextureFormat_Depth24Plus;
            view.mipLevelCount = 1;
            view.dimension = WGPUTextureViewDimension_Cube;
            view.arrayLayerCount = 6;
            map.view = wgpuTextureCreateView(map.texture, &view);
            view.dimension = WGPUTextureViewDimension_2D;
            view.arrayLayerCount = 1;
            for (uint32_t face = 0; face < 6; ++face) {
                view.baseArrayLayer = face;
                map.faces[face] = wgpuTextureCreateView(map.texture, &view);
            }
        } else {
            map.view = view2d(map.texture, WGPUTextureFormat_Depth24Plus);
        }
        map.width = l.shadow->width;
        map.height = l.shadow->height;
        shadowMapsChanged_ = true;
    }

    // Each skinned draw's palette, appended once to the frame's bone buffer; its draws (main and shadow)
    // read it from `boneBase`. three's skeleton.update() ran in the render database.
    // Each morphed draw's targets and influences likewise (three's morph texture, as vec4 per vertex
    // and target, the normal after the position), and its base influence: 1 for relative targets,
    // else 1 minus the influences' sum, summed in double as JS reduces them.
    for (auto& [name, storage] : storages_)
        if (name.rfind("probe_", 0) != 0 && name != "instances") storage.data.clear();
    for (const auto& [i, shadow] : virtualShadows_) storages_["vsmTable" + std::to_string(i)].data = shadow.atlas.table();
    std::vector<float>& bones = storages_["boneMatrices"].data;
    std::vector<float>& morphData = storages_["morphData"].data;
    std::vector<float>& morphInfluences = storages_["morphInfluences"].data;
    std::vector<float>& instances = storages_["instances"].data;
    std::unordered_map<const DrawItem*, double> instanceBases;
    // Twenty floats per instance: its matrix, then its colour and a pad. The storage keeps its
    // elements between frames, so a steady crowd overwrites memory it owns instead of zero-filling
    // and appending; it is cut to what this frame wrote after the loop.
    std::size_t written = 0;
    for (const auto& [depth, drawn] : opaque) {
        if (!drawn->instanceMatrices) continue;
        instanceBases[drawn] = double(written / 4);
        const auto* matrices = reinterpret_cast<const float*>(drawn->instanceMatrices->data());
        const auto* colors = drawn->instanceColors ? reinterpret_cast<const float*>(drawn->instanceColors->data()) : nullptr;
        const std::size_t end = written + std::size_t{drawn->instanceCount} * 20;
        if (instances.size() < end) instances.resize(end);
        float* out = instances.data() + written;
        for (uint32_t i = 0; i < drawn->instanceCount; ++i, out += 20) {
            std::memcpy(out, matrices + i * 16, 16 * sizeof(float));
            out[16] = colors ? colors[i * 3] : 1;
            out[17] = colors ? colors[i * 3 + 1] : 1;
            out[18] = colors ? colors[i * 3 + 2] : 1;
            out[19] = 0;
        }
        written = end;
    }
    instances.resize(written);
    struct Deform {
        double boneBase = 0, morphBase = 0, morphInfluenceBase = 0, morphVertexCount = 0, morphBaseInfluence = 1;
    };
    std::unordered_map<const DrawItem*, Deform> deforms;
    for (const auto& [depthKey, drawn] : opaque) {
        if (!drawn->boneMatrices && !drawn->morphGeometry) continue;
        Deform& d = deforms[drawn];
        if (drawn->boneMatrices) {
            d.boneBase = double(bones.size() / 16);
            bones.insert(bones.end(), drawn->boneMatrices->begin(), drawn->boneMatrices->end());
        }
        if (const BufferGeometry* g = drawn->morphGeometry) {
            const bool normals = !g->morphNormals.empty();
            const std::size_t vertices = g->morphPositions.front()->count();
            d.morphBase = double(morphData.size() / 4);
            d.morphVertexCount = double(vertices);
            for (std::size_t i = 0; i < g->morphPositions.size(); ++i) {
                for (std::size_t j = 0; j < vertices; ++j) {
                    const BufferAttribute& p = *g->morphPositions[i];
                    morphData.insert(morphData.end(), {float(p.getComponent(j, 0)), float(p.getComponent(j, 1)),
                                                       float(p.getComponent(j, 2)), 0.0f});
                    if (normals) {
                        const BufferAttribute& n = *g->morphNormals.at(i);
                        morphData.insert(morphData.end(), {float(n.getComponent(j, 0)), float(n.getComponent(j, 1)),
                                                           float(n.getComponent(j, 2)), 0.0f});
                    }
                }
            }
            d.morphInfluenceBase = double(morphInfluences.size());
            double sum = 0;
            for (const double influence : *drawn->morphInfluences) {
                morphInfluences.push_back(float(influence));
                sum += influence;
            }
            // One influence per target the program reads; a shorter array reads as zeros.
            for (std::size_t i = drawn->morphInfluences->size(); i < g->morphPositions.size(); ++i)
                morphInfluences.push_back(0.0f);
            d.morphBaseInfluence = g->morphTargetsRelative ? 1 : 1 - sum;
        }
    }
    auto putSkin = [&](uint64_t v, const shader::UniformField* const* vs, const DrawItem& item) {
        const auto found = deforms.find(&item);
        if (found == deforms.end()) return;
        const Deform& d = found->second;
        if (item.boneMatrices) {
            put(frameUniforms_, v, vs[kBoneStride], std::array<double, 1>{double(item.boneStride)});
            put(frameUniforms_, v, vs[kBoneBase], std::array<double, 1>{d.boneBase});
            put(frameUniforms_, v, vs[kBindMatrix], item.bindMatrix);
            put(frameUniforms_, v, vs[kBindMatrixInverse], item.bindMatrixInverse);
        }
        put(frameUniforms_, v, vs[kMorphBase], std::array<double, 1>{d.morphBase});
        put(frameUniforms_, v, vs[kMorphInfluenceBase], std::array<double, 1>{d.morphInfluenceBase});
        put(frameUniforms_, v, vs[kMorphVertexCount], std::array<double, 1>{d.morphVertexCount});
        put(frameUniforms_, v, vs[kMorphBaseInfluence], std::array<double, 1>{d.morphBaseInfluence});
    };
    // Only a frame that draws a second pipeline depth-Equal against the colour pass asks for @invariant
    // positions: the normal pass (it shares the colour vertex stage) and TRAA's velocity pass (its own
    // vertex stage, flagged the same way below). Every other frame is compiled as three's is.
    const bool invariantPosition = (postEffects_ && postEffects_->reads("normal")) || traa_;
    auto variantOf = [invariantPosition](const DrawItem& item) {
        shader::VertexVariant v;
        v.invariantPosition = invariantPosition;
        v.background = item.background;
        v.fog = item.fog ? item.fog->exponential() ? 2 : 1 : 0;
        v.sprite = item.sprite;
        v.backSide = item.side == 1;
        v.doubleSide = item.side == 2;
        v.vertexColors = item.colors ? item.colorSize : 0;
        v.instanced = item.instanceMatrices != nullptr;
        v.instanceColor = item.instanceColors != nullptr;
        v.vertexColors = item.colorSize;
        v.instanceStorage = v.instanced;
        v.skinned = item.boneMatrices != nullptr;
        v.skinnedPalette = item.boneStride != 0;
        if (item.morphGeometry) {
            v.morphTargets = static_cast<uint8_t>(item.morphGeometry->morphPositions.size());
            v.morphNormals = !item.morphGeometry->morphNormals.empty();
        }
        v.positionNode = item.positionNode;
        v.nodes = item.nodes;
        v.environment = item.envMap != nullptr;
        v.map = item.map != nullptr;
        v.normalMap = item.normalMap != nullptr;
        for (int k = 0; k < shader::kPbrMapCount; ++k)
            if (item.pbrMaps[k]) v.pbrMaps |= static_cast<uint16_t>(1u << k);
        // three's useClearcoat: a physical material with clearcoat > 0 builds the clearcoat layer.
        v.clearcoat = item.kind == MaterialKind::Physical && item.material && item.material->clearcoat > 0;
        v.mapSRGB = false;  // WGSLNodeBuilder uses GPU sRGB formats; no shader colour conversion.
        return v;
    };

    // The program invalidators (PRD-...): a draw whose VertexVariant, kind and light layout are
    // unchanged reuses its record's cached Program*, exactly as three keys a material's program cache.
    const auto hashBytes = [](const void* data, std::size_t size) {
        uint64_t h = 0xcbf29ce484222325ull;  // FNV-1a: stable across runs and targets
        for (const unsigned char* p = static_cast<const unsigned char*>(data), *end = p + size; p != end; ++p)
            h = (h ^ *p) * 0x100000001b3ull;
        return h;
    };
    const uint64_t lightKindsKey = hashBytes(lightKinds.data(), lightKinds.size());
    const uint64_t unshadowedKindsKey = hashBytes(unshadowedKinds.data(), unshadowedKinds.size());
    const uint64_t basicLightsKey = hashBytes("", 0) ^ 0x5bf03635ull;
    const auto drawLightsKey = [&](const DrawItem& item) {
        uint64_t key = item.kind == MaterialKind::Basic ? basicLightsKey
                       : item.receiveShadow              ? lightKindsKey
                                                          : unshadowedKindsKey;
        // A receiving mesh takes the soft-shadow filter (three keys a program on receiveShadow + type).
        if (item.receiveShadow && lights.softShadows) key ^= 0x9e3779b97f4a7c15ull;
        return key;
    };
    // The pipeline target inputs not already in the VertexVariant: side, blending, depth state and
    // the vertex layout. Equal keys mean the same pipeline, so the cached handle can be reused.
    const auto drawTargetKey = [&](const DrawItem& item, const shader::StageModule& vertex) {
        uint64_t h = 0xcbf29ce484222325ull;
        const auto mix = [&h](uint64_t v) { h = (h ^ v) * 0x100000001b3ull; };
        mix(item.side); mix(item.blending); mix(item.transparent); mix(item.depthWrite);
        mix(item.depthBias); mix(std::bit_cast<uint32_t>(item.depthBiasSlopeScale));
        mix(item.background); mix(item.frontFace() == WGPUFrontFace_CW);
        mix(static_cast<uint64_t>(item.topology));
        mix(item.indices ? item.indices->scalar() == Scalar::U32 : 0);
        mix(static_cast<uint64_t>(skinIndexFormat(item)));
        mix(instanceStepMask(vertex, item));
        mix(sampleCount_);
        return h;
    };

    // Plan: each draw's program, pipeline and uniform slices, all uniforms into one CPU block.
    struct Planned {
        const DrawItem* item;
        Program* program;
        WGPURenderPipeline pipeline;
        uint32_t vertexOffset, fragmentOffset;
        WGPUBindGroup mapGroup = nullptr;  // a mapped material's fragment group, else the program's
        WGPUBindGroup vertexGroup = nullptr;  // a vertex stage's per-draw group (graph textures), else the program's
    };
    std::vector<Planned> plan, velocityPlan;
    plan.reserve(opaque.size());
    frameUniforms_.clear();
    for (const auto& [depthKey, drawn] : opaque) {
        const DrawItem& item = *drawn;
        if (!item.mainPass) continue;
        shader::VertexVariant variant = variantOf(item);
        const uint64_t lightsKey = drawLightsKey(item);
        DrawCache* cache = item.cache;
        Program* built = nullptr;
        if (cache && cache->program && cache->kind == item.kind && cache->lightsKey == lightsKey &&
            cache->variant == variant) {
            built = static_cast<Program*>(cache->program);
        } else {
            built = this->program(item.kind, variant,
                                  item.kind == MaterialKind::Basic ? ""
                                  : item.receiveShadow            ? lightKinds
                                                                  : unshadowedKinds,
                                  item.receiveShadow && lights.softShadows);
            if (!built) continue;
            if (cache) {
                cache->kind = item.kind; cache->variant = variant; cache->lightsKey = lightsKey;
                cache->program = built; cache->pipeline = nullptr; cache->targetKey = 0;
                cache->depthProgram = nullptr; cache->depthPipeline = nullptr;
            }
        }
        Program& program = *built;
        if (item.instanceCount == 0) continue;  // three draws nothing for count 0
        const bool lit = item.kind != MaterialKind::Basic;
        if (!item.positions || (lit && !item.normals) || !item.material) continue;
        // material.side: FrontSide culls back faces, BackSide front faces, DoubleSide none.
        const WGPUCullMode cull = item.side == 2 ? WGPUCullMode_None : item.side == 1 ? WGPUCullMode_Front : WGPUCullMode_Back;
        // three blends unless NoBlending, or NormalBlending on a material that is not transparent.
        const uint8_t blend = item.blending == 0 || (item.blending == 1 && !item.transparent) ? 0 : item.blending;
        PipelineTarget target{WGPUTextureFormat_RGBA16Float, WGPUTextureFormat_Depth32Float, cull, blend,
                              item.depthWrite};
        target.sampleCount = sampleCount_;
        target.layout = program.pipelineLayout;
        if (item.background) target.depthCompare = WGPUCompareFunction_Always;
        target.depthBias = item.depthBias;
        target.depthBiasSlopeScale = item.depthBiasSlopeScale;
        target.frontFace = item.frontFace();
        target.skinIndex = skinIndexFormat(item);
        target.instanceStepMask = instanceStepMask(program.vertex, item);
        lineTopology(target, item);
        if (compilation) {
            compilation->push_back(pipelines_.getAsync(program.vertex, &program.fragment, target));
            plan.push_back({&item, &program, nullptr, 0, 0});
            continue;
        }
        const uint64_t targetKey = drawTargetKey(item, program.vertex);
        WGPURenderPipeline pipeline;
        if (cache && cache->pipeline && cache->targetKey == targetKey) {
            pipeline = static_cast<WGPURenderPipeline>(cache->pipeline);
        } else {
            pipeline = pipelines_.get(program.vertex, &program.fragment, target);
            if (!pipeline) throw std::runtime_error("TN_NATIVE_PIPELINE_REFUSED: material program");
            if (cache) { cache->targetKey = targetKey; cache->pipeline = pipeline; }
        }
        const uint64_t v = frameUniforms_.size();
        const uint64_t f = v + aligned(program.vertex.uniformBlockSize);
        frameUniforms_.resize(f + aligned(program.fragment.uniformBlockSize), 0);
        const auto* vs = program.vertexSlots;
        const auto* fs = program.fragmentSlots;
        put(frameUniforms_, v, vs[kModelMatrix], item.matrixWorld);
        if (item.instanceMatrices) put(frameUniforms_, v, vs[kInstanceBase], std::array<double, 1>{instanceBases.at(&item)});
        put(frameUniforms_, v, vs[kViewMatrix], view);
        put(frameUniforms_, v, vs[kProjectionMatrix], camera.projectionMatrix);
        put(frameUniforms_, v, vs[kNormalMatrix], normalMatrix(multiply(view, item.matrixWorld)));
        putSkin(v, vs, item);
        const shader::StandardMaterial& m = *item.material;
        put(frameUniforms_, f, fs[kDiffuse], std::array<double, 4>{m.color[0], m.color[1], m.color[2], m.opacity});
        put(frameUniforms_, f, fs[kViewMatrix], view);  // normalWorld is derived in the fragment, as three does
        // TSL's camera accessors, read by node graphs in either stage.
        const std::array<double, 3> cameraPosition{camera.matrixWorld[12], camera.matrixWorld[13], camera.matrixWorld[14]};
        // three's modelNormalMatrix (transformNormalToView), only for a program that reads it.
        const bool modelNormal = vs[kModelNormalMatrix] || fs[kModelNormalMatrix];
        const std::array<double, 9> modelNormalMatrix = modelNormal ? normalMatrix(item.matrixWorld) : std::array<double, 9>{};
        for (const auto [base, slots] : {std::pair{v, vs}, std::pair{f, fs}}) {
            if (modelNormal) put(frameUniforms_, base, slots[kModelNormalMatrix], modelNormalMatrix);
            put(frameUniforms_, base, slots[kCameraPosition], cameraPosition);
            put(frameUniforms_, base, slots[kCameraProjectionMatrix], camera.projectionMatrix);
            put(frameUniforms_, base, slots[kCameraWorldMatrix], camera.matrixWorld);
            put(frameUniforms_, base, slots[kCameraNear], std::array<double, 1>{camera.near});
            put(frameUniforms_, base, slots[kCameraFar], std::array<double, 1>{camera.far});
        }
        put(frameUniforms_, f, fs[kAlphaTest], std::array<double, 1>{m.alphaTest});
        // NodeMaterial forces alpha to 1 only on an opaque NormalBlending material.
        put(frameUniforms_, f, fs[kOpaque], std::array<double, 1>{!item.transparent && item.blending == 1 ? 1.0 : 0.0});
        put(frameUniforms_, f, fs[kRoughness], std::array<double, 1>{m.roughness});
        put(frameUniforms_, f, fs[kMetalness], std::array<double, 1>{m.metalness});
        put(frameUniforms_, f, fs[kEmissive],
            std::array<double, 3>{m.emissive[0] * m.emissiveIntensity, m.emissive[1] * m.emissiveIntensity,
                                  m.emissive[2] * m.emissiveIntensity});
        put(frameUniforms_, f, fs[kSpecular], std::array<double, 3>{m.specular[0], m.specular[1], m.specular[2]});
        put(frameUniforms_, f, fs[kShininess], std::array<double, 1>{m.shininess});
        put(frameUniforms_, f, fs[kIor], std::array<double, 1>{m.ior});
        put(frameUniforms_, f, fs[kSpecularIntensity], std::array<double, 1>{m.specularIntensity});
        put(frameUniforms_, f, fs[kSpecularColor], std::array<double, 3>{m.specularColor[0], m.specularColor[1], m.specularColor[2]});
        put(frameUniforms_, f, fs[kClearcoat], std::array<double, 1>{m.clearcoat});
        put(frameUniforms_, f, fs[kClearcoatRoughness], std::array<double, 1>{m.clearcoatRoughness});
        put(frameUniforms_, f, fs[kClearcoatNormalScale], std::array<double, 2>{m.clearcoatNormalScale[0], m.clearcoatNormalScale[1]});
        put(frameUniforms_, f, fs[kBumpScale], std::array<double, 1>{m.bumpScale});
        if (item.background) put(frameUniforms_, f, fs[kBackgroundRotation], item.backgroundRotation);
        if (item.fog) {
            const auto& fog = *item.fog;
            put(frameUniforms_, f, fs[kFogColor], std::array<double, 3>{fog.color.r, fog.color.g, fog.color.b});
            put(frameUniforms_, f, fs[kFogNear], std::array<double, 1>{fog.near});
            put(frameUniforms_, f, fs[kFogFar], std::array<double, 1>{fog.far});
            put(frameUniforms_, f, fs[kFogDensity], std::array<double, 1>{fog.density});
        }
        if (item.map) put(frameUniforms_, f, fs[kUvTransform], uvTransformOf(*item.map));
        for (int k = 0; k < shader::kPbrMapCount; ++k)
            if (item.pbrMaps[k]) put(frameUniforms_, f, fs[kRoughnessMapUvTransform + k], uvTransformOf(*item.pbrMaps[k]));
        if (item.pbrMaps[shader::kAoMap]) put(frameUniforms_, f, fs[kAoMapIntensity], std::array<double, 1>{item.aoMapIntensity});
        if (item.normalMap) {
            put(frameUniforms_, f, fs[kNormalScale], std::array<double, 2>{item.normalScaleX, item.normalScaleY});
            put(frameUniforms_, f, fs[kNormalUvTransform], uvTransformOf(*item.normalMap));
        }
        if (item.envMap) {
            const EnvironmentGpu& env = environment(*item.envMap);
            put(frameUniforms_, f, fs[kEnvRotation], item.envRotation);
            put(frameUniforms_, f, fs[kEnvMapIntensity], std::array<double, 1>{item.envMapIntensity});
            put(frameUniforms_, f, fs[kEnvMapTexelWidth], std::array<double, 1>{env.texelWidth});
            put(frameUniforms_, f, fs[kEnvMapTexelHeight], std::array<double, 1>{env.texelHeight});
            put(frameUniforms_, f, fs[kEnvMapMaxMip], std::array<double, 1>{env.maxMip});
        }
        put(frameUniforms_, f, fs[kScreenSize], std::array<double, 2>{double(width_), double(height_)});
        if (item.pmremMap) {
            const EnvironmentGpu& pmrem = environment(*item.pmremMap);
            put(frameUniforms_, f, fs[kPmremRotation], item.pmremRotation);
            put(frameUniforms_, f, fs[kPmremTexelWidth], std::array<double, 1>{pmrem.texelWidth});
            put(frameUniforms_, f, fs[kPmremTexelHeight], std::array<double, 1>{pmrem.texelHeight});
            put(frameUniforms_, f, fs[kPmremMaxMip], std::array<double, 1>{pmrem.maxMip});
        }
        for (std::size_t i = 0; i < lights.direct.size() && i < program.lightSlots.size(); ++i) {
            const DirectLight& l = lights.direct[i];
            const auto& slot = program.lightSlots[i];
            put(frameUniforms_, f, slot[kLightColor], l.color);
            put(frameUniforms_, f, slot[kLightDirection], rotate(view, l.direction));
            put(frameUniforms_, f, slot[kLightAxis], rotate(view, l.direction));
            put(frameUniforms_, f, slot[kLightPosition], transformPoint(view, l.position));
            put(frameUniforms_, f, slot[kLightDistance], std::array<double, 1>{l.distance});
            put(frameUniforms_, f, slot[kLightDecay], std::array<double, 1>{l.decay});
            put(frameUniforms_, f, slot[kLightConeCos], std::array<double, 1>{l.coneCos});
            put(frameUniforms_, f, slot[kLightPenumbraCos], std::array<double, 1>{l.penumbraCos});
            if (l.shadow) {
                put(frameUniforms_, f, slot[kLightShadowMatrix], l.shadow->matrix);
                put(frameUniforms_, f, slot[kLightShadowBias], std::array<double, 1>{l.shadow->bias});
                put(frameUniforms_, f, slot[kLightShadowNormalBias], std::array<double, 1>{l.shadow->normalBias});
                put(frameUniforms_, f, slot[kLightShadowRadius], std::array<double, 1>{l.shadow->radius});
                put(frameUniforms_, f, slot[kLightShadowMapSize],
                    std::array<double, 2>{double(l.shadow->width), double(l.shadow->height)});
                put(frameUniforms_, f, slot[kLightShadowIntensity], std::array<double, 1>{l.shadow->intensity});
                put(frameUniforms_, f, slot[kLightShadowNear], std::array<double, 1>{l.shadow->near});
                put(frameUniforms_, f, slot[kLightShadowFar], std::array<double, 1>{l.shadow->far});
            }
        }
        put(frameUniforms_, f, fs[kHemisphereSky], lights.hemisphereSky);
        put(frameUniforms_, f, fs[kHemisphereGround], lights.hemisphereGround);
        put(frameUniforms_, f, fs[kHemisphereDirection], lights.hemisphereUp);  // world space: it meets normalWorld
        put(frameUniforms_, f, fs[kAmbient], lights.ambient);
        if (item.sprite) for (const auto& field : program.vertex.uniforms) {
            if (field.name == "spriteCenter") put(frameUniforms_, v, &field, item.spriteCenter);
            if (field.name == "spriteRotation") put(frameUniforms_, v, &field, std::array<double, 1>{item.spriteRotation});
            if (field.name == "spriteNoAttenuation") put(frameUniforms_, v, &field,
                std::array<double, 1>{!item.spriteSizeAttenuation && camera.projectionMatrix[11] == -1 ? 1.0 : 0.0});
        }
        putNodes(frameUniforms_, v, program.vertex, item.nodes, frameTime_);
        putNodes(frameUniforms_, f, program.fragment, item.nodes, frameTime_);
        plan.push_back({&item, &program, pipeline, static_cast<uint32_t>(v), static_cast<uint32_t>(f)});
    }

    // Each shadow-casting light's depth pass: every caster through the shadow camera, back faces for
    // front-sided materials (three's _shadowSide), depth only. Order is free: depth keeps the nearest.
    struct ShadowPass {
        WGPUTextureView target;
        int x = 0, y = 0, size = 0; // zero: ordinary map; otherwise one atlas page's guarded viewport
        std::vector<Planned> draws;
    };
    std::vector<ShadowPass> shadowPasses;
    for (std::size_t i = 0; i < lights.direct.size(); ++i) {
        if (!lights.direct[i].shadow) continue;
        const DirectLight::Shadow& shadow = *lights.direct[i].shadow;
        const auto virtualIt = virtualShadows_.find(i);
        const bool virtualMap = virtualIt != virtualShadows_.end();
        const int passCount = compilation ? 1 : virtualMap ? int(virtualPages[i].size()) : shadow.cube ? 6 : 1;
        for (int face = 0; face < passCount; ++face) {
        const shadows::AtlasPage* page = virtualMap && !compilation ? &virtualPages[i][face] : nullptr;
        const Matrix& view = page ? page->view.elements : shadow.cube ? shadow.faceViews[face] : shadow.view;
        ShadowPass& pass = shadowPasses.emplace_back();
        pass.target = compilation ? nullptr : virtualMap ? virtualIt->second.map.view : shadow.cube ? cubeShadowMaps_[i].faces[face] : shadowMaps_[i].view;
        if (page) {
            const auto [x, y] = virtualIt->second.atlas.origin(page->slot);
            pass.x = x; pass.y = y; pass.size = virtualIt->second.atlas.stride();
        }
        for (const auto& [depthKey, drawn] : opaque) {
            const DrawItem& item = *drawn;
            if (!item.castShadow || item.instanceCount == 0 || !item.positions) continue;
            if ((item.layers & shadow.layersMask) == 0) continue;
            if (page && !item.positionNode && !item.nodes.positionNode && !item.boneMatrices && !item.morphGeometry &&
                !item.instanceMatrices && !virtualIt->second.atlas.overlaps(*page, casterBounds.at(i).at(item.key))) continue;
            shader::VertexVariant variant = variantOf(item);
            DrawCache* cache = item.cache;
            Program* cachedDepth = nullptr;
            if (cache && cache->depthProgram && cache->variant == variant)
                cachedDepth = static_cast<Program*>(cache->depthProgram);
            else {
                cachedDepth = &depthProgram(variant);
                if (cache) {
                    cache->variant = variant;  // a shadow-only draw has no main program to set it
                    cache->depthProgram = cachedDepth; cache->depthPipeline = nullptr; cache->depthTargetKey = 0;
                }
            }
            Program& program = *cachedDepth;
            // three's _shadowSide: a front-sided caster draws its back faces, a back-sided one its
            // front faces, a double-sided one both.
            const WGPUCullMode cull =
                item.side == 2 ? WGPUCullMode_None : item.side == 1 ? WGPUCullMode_Back : WGPUCullMode_Front;
            PipelineTarget target{WGPUTextureFormat_Undefined, WGPUTextureFormat_Depth24Plus, cull};
            target.layout = program.pipelineLayout;
            target.frontFace = item.frontFace();
            target.skinIndex = skinIndexFormat(item);
            target.instanceStepMask = instanceStepMask(program.vertex, item);
            if (compilation) {
                compilation->push_back(pipelines_.getAsync(program.vertex, nullptr, target));
                continue;
            }
            const uint64_t depthTargetKey = drawTargetKey(item, program.vertex);
            WGPURenderPipeline pipeline;
            if (cache && cache->depthPipeline && cache->depthTargetKey == depthTargetKey) {
                pipeline = static_cast<WGPURenderPipeline>(cache->depthPipeline);
            } else {
                pipeline = pipelines_.get(program.vertex, nullptr, target);
                if (!pipeline) throw std::runtime_error("TN_NATIVE_PIPELINE_REFUSED: shadow depth program");
                if (cache) { cache->depthTargetKey = depthTargetKey; cache->depthPipeline = pipeline; }
            }
            const uint64_t v = frameUniforms_.size();
            frameUniforms_.resize(v + aligned(program.vertex.uniformBlockSize), 0);
            put(frameUniforms_, v, program.vertexSlots[kModelMatrix], item.matrixWorld);
            if (item.instanceMatrices) put(frameUniforms_, v, program.vertexSlots[kInstanceBase], std::array<double, 1>{instanceBases.at(&item)});
            put(frameUniforms_, v, program.vertexSlots[kViewMatrix], view);
            put(frameUniforms_, v, program.vertexSlots[kProjectionMatrix], page ? page->projection.elements : shadow.projection);
            // r185 draws a caster through the shadow camera, so TSL's camera accessors (a billboard's
            // positionNode) read that camera here: its world matrix is the view's inverse.
            Matrix4 shadowCamera;
            shadowCamera.elements = view;
            shadowCamera.invert();
            const std::array<double, 3> shadowPosition{shadowCamera.elements[12], shadowCamera.elements[13], shadowCamera.elements[14]};
            put(frameUniforms_, v, program.vertexSlots[kCameraWorldMatrix], shadowCamera.elements);
            put(frameUniforms_, v, program.vertexSlots[kCameraPosition], shadowPosition);
            put(frameUniforms_, v, program.vertexSlots[kCameraProjectionMatrix], page ? page->projection.elements : shadow.projection);
            putSkin(v, program.vertexSlots, item);
            putNodes(frameUniforms_, v, program.vertex, item.nodes, frameTime_);
            pass.draws.push_back({&item, &program, pipeline, static_cast<uint32_t>(v), 0});
        }
        }
    }

    // One buffer for the frame's uniforms, grown (and its bind groups rebuilt) when it is too small,
    // written once: a queue write, so it lands before this frame's commands and after the last's.
    if (traa_) {
        const std::string key = "traa-velocity";
        if (!programs_.count(key)) {
            auto source = traaVelocityPrograms();
            source.vertex.setInvariantPosition(true);  // drawn depth-Equal against the colour pass, which is flagged under TRAA
            add(key, shader::buildStage(source.vertex, 0), shader::buildStage(source.fragment, 1));
        }
        Program& velocity = *programs_.at(key);
        for (const Planned& draw : plan) {
            const DrawItem& item = *draw.item;
            // Previous deformed vertex data is not yet retained by these variants. Refuse it;
            // ordinary rigid object/camera motion goes through the real VelocityNode equations.
            if (item.instanceMatrices || item.skinIndices || item.morphGeometry || item.sprite ||
                item.positionNode || item.nodes.positionNode || item.nodes.vertexNode || !item.attributes.empty() ||
                item.transparent || item.material->alphaTest > 0)
                throw std::runtime_error("TN_TRAA_VELOCITY_UNSUPPORTED: deformed/instanced/sprite/alpha-tested/transparent draw");
            PipelineTarget target{WGPUTextureFormat_RGBA16Float, WGPUTextureFormat_Depth32Float,
                item.side == 2 ? WGPUCullMode_None : item.side == 1 ? WGPUCullMode_Front : WGPUCullMode_Back};
            target.layout = velocity.pipelineLayout; target.depthWrite = false;
            lineTopology(target, item);
            target.depthCompare = WGPUCompareFunction_Equal; target.frontFace = item.frontFace();
            if (compilation) {
                compilation->push_back(pipelines_.getAsync(velocity.vertex, &velocity.fragment, target));
                continue;
            }
            const auto pipeline = pipelines_.get(velocity.vertex, &velocity.fragment, target);
            if (!pipeline) throw std::runtime_error("TN_TRAA_VELOCITY_PIPELINE_REFUSED");
            const uint32_t offset = frameUniforms_.size();
            frameUniforms_.resize(offset + aligned(velocity.vertex.uniformBlockSize), 0);
            put(frameUniforms_, offset, velocity.vertexSlots[kModelMatrix], item.matrixWorld);
            put(frameUniforms_, offset, velocity.vertexSlots[kViewMatrix], camera.matrixWorldInverse);
            put(frameUniforms_, offset, velocity.vertexSlots[kProjectionMatrix], camera.projectionMatrix);
            for (const auto& field : velocity.vertex.uniforms) {
                if (field.name == "unjitteredProjection") put(frameUniforms_, offset, &field, unjitteredCamera.projectionMatrix);
                if (field.name == "previousModel") put(frameUniforms_, offset, &field, traa_->previousModel(item.key, item.matrixWorld));
                if (field.name == "previousProjection") put(frameUniforms_, offset, &field, traa_->previousProjection());
                if (field.name == "previousView") put(frameUniforms_, offset, &field, traa_->previousView());
            }
            velocityPlan.push_back({&item, &velocity, pipeline, offset, 0});
        }
    }
    // A post pass that reads "normal" (GTAO, denoise) gets three's MRT normal output as a second
    // pass over the same draws: each draw's own vertex stage (skinning, morphs, instancing, position
    // nodes included, so the depth matches the main pass exactly) with a fragment that writes the
    // interpolated view-space normal, depth-tested Equal against the main pass's depth.
    std::vector<Planned> normalPlan;
    const bool normalPass = postEffects_ && postEffects_->reads("normal");
    const auto planNormals = [&] {
        if (normalPass) {
            if (normalFragment_.wgsl.code.empty()) {
                shader::Program fragment{shader::Stage::Fragment};
                fragment.output("color", fragment.construct(shader::Type::vec(4),
                    {fragment.call("normalize", {fragment.varying("normalView", shader::Type::vec(3))}), fragment.constant(0.f)}));
                normalFragment_ = shader::buildStage(fragment, 1);
                if (!normalFragment_.wgsl.ok()) throw std::runtime_error("TN_NATIVE_SHADER_INVALID: post normal program");
            }
            for (const Planned& draw : plan) {
                const DrawItem& item = *draw.item;
                // The sky and unlit materials write no view-space normal (their programs have no normalView).
                if (item.background || item.kind == MaterialKind::Basic) continue;
                // These draws write no normal, so the post pass reads its depth-derived one there. Named once a
                // frame, not thrown: a transparent particle must not cost the frame.
                if (item.transparent || item.sprite || item.material->alphaTest > 0) {
                    const std::string reason = item.transparent ? "transparent" : item.sprite ? "sprite" : "alpha-tested";
                    const std::string note = "TN_POST_NORMAL_SKIPPED: " + reason + " draws write no normal (depth-derived there)";
                    if (std::find(diagnostics_.begin(), diagnostics_.end(), note) == diagnostics_.end()) diagnostics_.push_back(note);
                    continue;
                }
                if (item.nodes.normalNode)
                    throw std::runtime_error("TN_POST_NORMAL_UNSUPPORTED: a material normalNode is not written to the normal target");
                // The normal fragment reads `normalView` at location 0, which the program's vertex stage must write there.
                if (draw.program->vertex.wgsl.code.find("@location(0) o_normalView") == std::string::npos)
                    throw std::runtime_error("TN_POST_NORMAL_LAYOUT: normalView is not the vertex stage's first varying");
                PipelineTarget target{WGPUTextureFormat_RGBA16Float, WGPUTextureFormat_Depth32Float,
                    item.side == 2 ? WGPUCullMode_None : item.side == 1 ? WGPUCullMode_Front : WGPUCullMode_Back};
                target.layout = draw.program->pipelineLayout; target.depthWrite = false;
                target.depthCompare = WGPUCompareFunction_Equal; target.frontFace = item.frontFace();
                target.skinIndex = skinIndexFormat(item);
                target.instanceStepMask = instanceStepMask(draw.program->vertex, item);
                if (compilation) {
                    compilation->push_back(pipelines_.getAsync(draw.program->vertex, &normalFragment_, target));
                    continue;
                }
                const auto pipeline = pipelines_.get(draw.program->vertex, &normalFragment_, target);
                if (!pipeline) throw std::runtime_error("TN_POST_NORMAL_PIPELINE_REFUSED");
                Planned normal = draw;
                normal.pipeline = pipeline;
                normalPlan.push_back(normal);
            }
            if (!compilation && !normalTexture_) {
                WGPUTextureDescriptor desc = {};
                desc.dimension = WGPUTextureDimension_2D; desc.size = {width_, height_, 1};
                desc.format = WGPUTextureFormat_RGBA16Float; desc.mipLevelCount = 1; desc.sampleCount = 1;
                desc.usage = WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopySrc;
                normalTexture_ = wgpuDeviceCreateTexture(device_, &desc);
                normalView_ = view2d(normalTexture_, WGPUTextureFormat_RGBA16Float);
            }
            if (!compilation) postEffects_->input("normal", normalView_);
        }
    };
    WGPURenderPipeline pageClear = nullptr;
    if (!virtualShadows_.empty()) {
        shader::Program clear(shader::Stage::Vertex);
        const auto i = clear.builtin("vertexIndex");
        const auto zero = clear.construct(shader::Type::u32(), {clear.constant(int32_t(0))}), one = clear.construct(shader::Type::u32(), {clear.constant(int32_t(1))});
        const auto x = clear.select(clear.equal(i, one), clear.constant(3.0f), clear.constant(-1.0f));
        const auto y = clear.select(clear.equal(i, zero), clear.constant(3.0f), clear.constant(-1.0f));
        clear.output("position", clear.construct(shader::Type::vec(4), {x, y, clear.constant(1.0f), clear.constant(1.0f)}));
        const auto vertex = shader::buildStage(clear, 0);
        PipelineTarget target{WGPUTextureFormat_Undefined, WGPUTextureFormat_Depth24Plus, WGPUCullMode_None};
        target.depthCompare = WGPUCompareFunction_Always;
        if (compilation) compilation->push_back(pipelines_.getAsync(vertex, nullptr, target));
        else {
            pageClear = pipelines_.get(vertex, nullptr, target);
            if (!pageClear) throw std::runtime_error("TN_NATIVE_PIPELINE_REFUSED: virtual page clear");
        }
    }
    if (compilation) {
        planNormals();
        PipelineTarget target{outputFormat, WGPUTextureFormat_Undefined, WGPUCullMode_None};
        target.layout = outputPipelineLayout_;
        compilation->push_back(pipelines_.getAsync(outputVertex_, &outputFragment_, target));
        const auto texture = [&](const Texture* map) {
            if (map && !map->volume && map->hasImage() && map->generateMipmaps && map->bytesPerTexel() == 4 &&
                std::max(map->width, map->height) > 1)
                copyPipeline(textureFormat(*map), 0, compilation);
        };
        for (const DrawItem& item : items) {
            texture(item.map); texture(item.normalMap); texture(item.envMap); texture(item.pmremMap);
            for (const Texture* map : item.pbrMaps) texture(map);
            if (item.nodeTextures) for (const auto& [name, map] : *item.nodeTextures) texture(map);
            if (item.background && item.map) {
                const auto conversion = shader::buildEquirectangularCube();
                const auto vs = shader::buildStage(conversion.vertex, 0), fs = shader::buildStage(conversion.fragment, 0);
                PipelineTarget cube{textureFormat(*item.map), WGPUTextureFormat_Undefined, WGPUCullMode_None};
                compilation->push_back(pipelines_.getAsync(vs, &fs, cube));
            }
        }
        return id;
    }

    if (frameUniforms_.size() > uniformCapacity_) {
        if (uniformCapacity_ != 0) gpu_.destroy(uniformBuffer_);
        uniformCapacity_ = std::max<uint64_t>(frameUniforms_.size() * 2, 64 * 1024);
        uniformBuffer_ = gpu_.createBuffer(uniformCapacity_, WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst);
        rebuildGroups();
    } else if (shadowMapsChanged_) {
        rebuildGroups();
    }
    shadowMapsChanged_ = false;
    if (!frameUniforms_.empty()) gpu_.writeBuffer(uniformBuffer_, 0, frameUniforms_.data(), frameUniforms_.size());
    for (auto& [name, storage] : storages_) {
        if (storage.data.size() * 4 > storage.capacity) {
            gpu_.destroy(storage.buffer);
            storage.capacity = std::max<uint64_t>(storage.data.size() * 4 * 2, 64 * 1024);
            storage.buffer = gpu_.createBuffer(storage.capacity, WGPUBufferUsage_Storage | WGPUBufferUsage_CopyDst);
            rebuildGroups();
        }
        if (!storage.data.empty()) gpu_.writeBuffer(storage.buffer, 0, storage.data.data(), storage.data.size() * 4);
    }

    // A vertex stage that samples graph textures (a positionNode's displacement map) binds them per
    // draw, in the main pass and the shadow passes alike; `graphKey` names the draw's textures.
    const auto vertexGroupOf = [&](const Planned& p, const std::string& graphKey) -> WGPUBindGroup {
        if (!perDrawVertex(p.program->vertex)) return nullptr;
        const std::string vertexKey = "vertex|" + std::to_string(reinterpret_cast<uintptr_t>(p.program)) + graphKey;
        const auto found = mapGroups_.find(vertexKey);
        if (found != mapGroups_.end()) return found->second;
        return mapGroups_.emplace(vertexKey, bindGroup(p.program->layouts[0], p.program->vertex, uniformBuffer_,
                                  lutView_, lutSampler_, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr,
                                  nullptr, nullptr, nullptr, nullptr, p.item->nodeTextures)).first->second;
    };
    const auto graphKeyOf = [&](const DrawItem& item) {
        std::string key;
        if (item.nodeTextures)
            for (const auto& [label, texture] : *item.nodeTextures) {
                const MaterialTexture* gpu = materialTexture(*texture);
                key += "|" + label + "," + std::to_string(reinterpret_cast<uintptr_t>(gpu->view)) + "," +
                       std::to_string(reinterpret_cast<uintptr_t>(gpu->sampler));
            }
        return key;
    };
    for (ShadowPass& pass : shadowPasses)
        for (Planned& draw : pass.draws) draw.vertexGroup = vertexGroupOf(draw, graphKeyOf(*draw.item));

    // A draw's fragment group depends on its program, its textures (identity and version, which the
    // descriptor derives from) and the group epoch (a rebuilt uniform buffer or dropped groups). Equal
    // keys mean the record's cached group can be bound without rebuilding it or its key string.
    const auto textureToken = [](const Texture* t) -> uint64_t {
        if (!t) return 0;
        uint64_t h = reinterpret_cast<uintptr_t>(t);
        return h ^ (uint64_t(t->version()) + 0x9e3779b97f4a7c15ull + (h << 6) + (h >> 2));
    };
    const auto drawGroupKey = [&](const Planned& p) {
        const DrawItem& item = *p.item;
        uint64_t h = 0xcbf29ce484222325ull;
        const auto mix = [&h](uint64_t v) { h = (h ^ v) * 0x100000001b3ull; };
        mix(reinterpret_cast<uintptr_t>(p.program));
        mix(textureToken(item.map)); mix(textureToken(item.normalMap));
        for (const Texture* t : item.pbrMaps) mix(textureToken(t));
        mix(textureToken(item.envMap)); mix(textureToken(item.pmremMap));
        mix(reinterpret_cast<uintptr_t>(item.reflectorView));
        mix(reinterpret_cast<uintptr_t>(item.reflectorSampler));
        if (item.nodeTextures)
            for (const auto& [label, texture] : *item.nodeTextures) {
                mix(hashBytes(label.data(), label.size()));
                mix(textureToken(texture));
            }
        mix(reinterpret_cast<uintptr_t>(viewportColorView_));
        mix(reinterpret_cast<uintptr_t>(viewportDepthView_));
        mix(groupEpoch_);
        return h;
    };

    // A mapped draw's fragment group binds its own texture and sampler beside the frame's uniforms.
    // Created here, after the uniform buffer exists; cached per program and texture.
    for (Planned& p : plan) {
        const bool readsPbr = std::any_of(p.item->pbrMaps.begin(), p.item->pbrMaps.end(), [](const Texture* t) { return t; });
        const GraphTextures* graphTextures = p.item->nodeTextures;
        std::string graphKey = graphKeyOf(*p.item);
        p.vertexGroup = vertexGroupOf(p, graphKey);
        const bool viewport = readsViewport(p.program->fragment);
        if (!p.item->map && !p.item->envMap && !p.item->normalMap && !readsPbr && !p.item->pmremMap &&
            !p.item->reflectorView && !graphTextures && !viewport) continue;
        DrawCache* cache = p.item->cache;
        const uint64_t groupKey = drawGroupKey(p);
        if (cache && cache->mapGroup && cache->mapGroupKey == groupKey) {
            p.mapGroup = static_cast<WGPUBindGroup>(cache->mapGroup);
            continue;
        }
        if (viewport)
            graphKey += "|viewport," + std::to_string(reinterpret_cast<uintptr_t>(viewportColorView_)) + "," +
                        std::to_string(reinterpret_cast<uintptr_t>(viewportDepthView_));
        const MaterialTexture* normal = p.item->normalMap ? materialTexture(*p.item->normalMap) : nullptr;
        std::array<const MaterialTexture*, shader::kPbrMapCount> pbrTextures{};
        for (int k = 0; k < shader::kPbrMapCount; ++k)
            if (p.item->pbrMaps[k]) pbrTextures[k] = materialTexture(*p.item->pbrMaps[k]);
        const MaterialTexture* map = p.item->map && !p.item->background ? materialTexture(*p.item->map) : nullptr;
        const BackgroundCube* cube = p.item->background ? &backgroundCube(*p.item->map) : nullptr;
        const EnvironmentGpu* env = p.item->envMap ? &environment(*p.item->envMap) : nullptr;
        const EnvironmentGpu* pmrem = p.item->pmremMap ? &environment(*p.item->pmremMap) : nullptr;
        const WGPUTextureView mapView = cube ? cube->view : map ? map->view : nullptr, envView = env ? env->view : nullptr;
        const WGPUSampler mapSampler = cube ? cube->sampler : map ? map->sampler : nullptr, envSampler = env ? env->sampler : nullptr;
        const std::string key = std::to_string(reinterpret_cast<uintptr_t>(p.program)) + "|" +
                                std::to_string(reinterpret_cast<uintptr_t>(mapView)) + "|" +
                                std::to_string(reinterpret_cast<uintptr_t>(mapSampler)) + "|" +
                                std::to_string(reinterpret_cast<uintptr_t>(envView)) + "|" +
                                std::to_string(reinterpret_cast<uintptr_t>(normal ? normal->view : nullptr)) + "|" +
                                std::to_string(reinterpret_cast<uintptr_t>(normal ? normal->sampler : nullptr)) + "|" +
                                std::to_string(reinterpret_cast<uintptr_t>(pmrem ? pmrem->view : nullptr)) + "|" +
                                std::to_string(reinterpret_cast<uintptr_t>(p.item->reflectorView));
        std::string pbrKey;
        for (const MaterialTexture* texture : pbrTextures)
            pbrKey += "|" + std::to_string(reinterpret_cast<uintptr_t>(texture ? texture->view : nullptr)) + "," +
                      std::to_string(reinterpret_cast<uintptr_t>(texture ? texture->sampler : nullptr));
        pbrKey += graphKey;
        const auto found = mapGroups_.find(key + pbrKey);
        p.mapGroup = found != mapGroups_.end()
                         ? found->second
                         : mapGroups_.emplace(key + pbrKey, bindGroup(p.program->layouts[1], p.program->fragment, uniformBuffer_,
                                                             lutView_, lutSampler_, mapView, mapSampler, envView, envSampler,
                                                         normal ? normal->view : nullptr, normal ? normal->sampler : nullptr, &pbrTextures,
                                                         pmrem ? pmrem->view : nullptr, pmrem ? pmrem->sampler : nullptr,
                                                         p.item->reflectorView, p.item->reflectorSampler, graphTextures))
                               .first->second;
        if (cache) { cache->mapGroupKey = groupKey; cache->mapGroup = p.mapGroup; }
    }

    planNormals();

    // Encode: state changes only where they change; per draw, its dynamic offsets and the draw. The
    // shadow passes first, so the main pass samples this frame's maps.
    WGPURenderPipeline bound = nullptr;
    const BufferStore* boundVertex[8] = {};  // by vertex buffer slot (attribute location)
    const BufferStore* boundIndex = nullptr;
    lastFrame_ = FrameStats{};
    auto encode = [&](auto pass, const Planned& p, bool counted) {
        // The same commands record a direct pass or a cached bundle.
#define TN_ENCODE(name, ...) \
        if constexpr (std::is_same_v<decltype(pass), WGPURenderBundleEncoder>) \
            wgpuRenderBundleEncoder##name(pass, __VA_ARGS__); \
        else wgpuRenderPassEncoder##name(pass, __VA_ARGS__)
        const DrawItem& item = *p.item;
        if (p.pipeline != bound) {
            TN_ENCODE(SetPipeline, bound = p.pipeline);
            std::fill(std::begin(boundVertex), std::end(boundVertex), nullptr);
            boundIndex = nullptr;
        }
        for (const shader::VertexAttribute& a : p.program->vertex.attributes) {
            // instanceMatrix0..3 are the columns of one buffer of mat4s, bound at 16-byte steps.
            const bool column = a.name.rfind("instanceMatrix", 0) == 0;
            BufferStore* source = a.name == "position"        ? item.positions
                                  : a.name == "normal"        ? item.normals
                                  : a.name == "uv"            ? item.uvs
                                  : a.name == "color"         ? item.colors
                                  : a.name == "instanceColor" ? item.instanceColors
                                  : a.name == "skinIndex"     ? item.skinIndices
                                  : a.name == "skinWeight"    ? item.skinWeights
                                  : column                   ? item.instanceMatrices : nullptr;
            // Any other name is one of the geometry's own attributes (TSL attribute(name)).
            for (const DrawItem::CustomAttribute& custom : item.attributes)
                if (!source && custom.name == a.name) source = custom.store;
            if (!source) throw std::runtime_error("TN_NATIVE_ATTRIBUTE_MISSING: " + a.name);
            BufferStore& store = *source;
            const uint64_t offset = column ? uint64_t(a.name.back() - '0') * 16 : 0;
            const Handle buffer = geometry_->cache.sync(store, WGPUBufferUsage_Vertex);
            if (a.location < std::size(boundVertex) && boundVertex[a.location] == &store) continue;
            TN_ENCODE(SetVertexBuffer, a.location, geometry_->gpu.buffer(buffer), offset, store.byteLength() - offset);
            if (a.location < std::size(boundVertex)) boundVertex[a.location] = &store;
        }
        TN_ENCODE(SetBindGroup, 0, p.vertexGroup ? p.vertexGroup : p.program->groups[0], 1, &p.vertexOffset);
        // The depth program's fragment group is empty: no uniform block, no dynamic offset.
        const bool fragmentBlock = p.program->fragment.uniformBlockSize != 0;
        TN_ENCODE(SetBindGroup, 1, p.mapGroup ? p.mapGroup : p.program->groups[1],
                  fragmentBlock ? 1 : 0, &p.fragmentOffset);
        if (item.indices) {
            const Handle indices = geometry_->cache.sync(*item.indices, WGPUBufferUsage_Index);
            const bool wide = item.indices->scalar() == Scalar::U32;
            if (boundIndex != item.indices) {
                TN_ENCODE(SetIndexBuffer, geometry_->gpu.buffer(indices),
                          wide ? WGPUIndexFormat_Uint32 : WGPUIndexFormat_Uint16, 0,
                          (item.indices->byteLength() + 3) & ~uint64_t{3});
                boundIndex = item.indices;
            }
            const uint32_t count = static_cast<uint32_t>(item.indices->byteLength() / (wide ? 4 : 2));
            TN_ENCODE(DrawIndexed, count, item.instanceCount, 0, 0, 0);
            if (counted) lastFrame_.triangles += uint64_t{item.instanceCount} * (count / 3);  // three's Info.update
        } else {
            const uint32_t count = static_cast<uint32_t>(item.positions->byteLength() / 12);
            TN_ENCODE(Draw, count, item.instanceCount, 0, 0);
            if (counted) lastFrame_.triangles += uint64_t{item.instanceCount} * (count / 3);
        }
        if (counted) ++lastFrame_.draws;
        else ++lastFrame_.shadowDraws;
        if (item.boneMatrices) {
            auto& stats = counted ? lastFrame_.mainSkinned : lastFrame_.shadowSkinned;
            ++stats.draws;
            if (item.boneStride) {
                ++stats.batches;
                stats.instances += item.instanceCount;
            } else {
                ++stats.exactDraws;
            }
        }
#undef TN_ENCODE
    };
    if (!virtualShadows_.empty()) {
        graph::RenderGraph graph;
        std::vector<graph::Read> reads;
        for (const auto& [i, shadow] : virtualShadows_) {
            const auto atlas = graph.external("vsm-atlas" + std::to_string(i),
                {uint32_t(shadow.atlas.edge()), uint32_t(shadow.atlas.edge()), WGPUTextureFormat_Depth24Plus,
                 WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_TextureBinding});
            const auto table = graph.external("vsm-page-table" + std::to_string(i), {});
            graph.pass("vsm-pages" + std::to_string(i), graph::PassKind::Render, {{table}}, {atlas});
            reads.push_back({atlas}); reads.push_back({table});
        }
        graph.pass("vsm-receivers", graph::PassKind::Render, reads, {});
        if (!graph.compile().ok()) throw std::runtime_error("TN_GRAPH_INVALID: virtual shadows");
    }
    // The frame's GPU time starts at its first shadow pass, which runs before the scene pass.
    const bool shadowTimed = timed && !shadowPasses.empty();
    if (timed) timerBeganAtShadow_ = shadowTimed;
    WGPURenderPassTimestampWrites_Compat shadowTimes = {};
    bool shadowTimesTaken = false;
    for (const ShadowPass& shadowPlan : shadowPasses) {
        WGPURenderPassDepthStencilAttachment shadowDepth = {};
        shadowDepth.view = shadowPlan.target;
        shadowDepth.depthLoadOp = shadowPlan.size ? WGPULoadOp_Load : WGPULoadOp_Clear;
        shadowDepth.depthStoreOp = WGPUStoreOp_Store;
        shadowDepth.depthClearValue = 1.0f;
        WGPURenderPassDescriptor shadowDesc = {};
        shadowDesc.depthStencilAttachment = &shadowDepth;
        if (shadowTimed && !shadowTimesTaken) {
            shadowTimes.querySet = timestamps_;
            shadowTimes.beginningOfPassWriteIndex = 4;
            shadowTimes.endOfPassWriteIndex = 5;
            shadowDesc.timestampWrites = &shadowTimes;
            shadowTimesTaken = true;
        }
        WGPURenderPassEncoder shadowPass = wgpuCommandEncoderBeginRenderPass(encoder, &shadowDesc);
        if (shadowPlan.size) {
            wgpuRenderPassEncoderSetViewport(shadowPass, shadowPlan.x, shadowPlan.y, shadowPlan.size, shadowPlan.size, 0, 1);
            wgpuRenderPassEncoderSetScissorRect(shadowPass, shadowPlan.x, shadowPlan.y, shadowPlan.size, shadowPlan.size);
            wgpuRenderPassEncoderSetPipeline(shadowPass, pageClear);
            wgpuRenderPassEncoderDraw(shadowPass, 3, 1, 0, 0);
        }
        bound = nullptr;
        boundIndex = nullptr;
        for (const Planned& p : shadowPlan.draws) encode(shadowPass, p, false); // three's info counts the main pass
        wgpuRenderPassEncoderEnd(shadowPass);
        wgpuRenderPassEncoderRelease(shadowPass);
    }
    if (traa_) traa_->seedHistory(encoder, sceneColor_);
    WGPURenderPassEncoder pass = wgpuCommandEncoderBeginRenderPass(encoder, &passDesc);
    bound = nullptr;
    boundIndex = nullptr;
    // A bundle references buffers and offsets, not their contents. Matrix, colour, camera and
    // light writes therefore leave it valid; changed draw order, resources or counts rebuild it.
    std::vector<uint64_t> bundleKey;
    for (const Planned& p : plan) {
        const DrawItem& item = *p.item;
        bundleKey.insert(bundleKey.end(), {reinterpret_cast<uintptr_t>(p.pipeline),
            reinterpret_cast<uintptr_t>(p.vertexGroup ? p.vertexGroup : p.program->groups[0]),
            reinterpret_cast<uintptr_t>(p.mapGroup ? p.mapGroup : p.program->groups[1]),
            p.vertexOffset, p.fragmentOffset, item.instanceCount});
        for (BufferStore* store : {item.positions, item.normals, item.uvs, item.indices, item.skinIndices, item.skinWeights}) {
            const Handle handle = store ? geometry_->cache.sync(*store,
                store == item.indices ? WGPUBufferUsage_Index : WGPUBufferUsage_Vertex) : Handle{};
            bundleKey.insert(bundleKey.end(), {handle.type, handle.context, handle.index, handle.generation,
                store ? store->byteLength() : 0, store ? static_cast<uintptr_t>(store->scalar()) : 0});
        }
    }
    // three's viewport textures copy the frame at the first draw that reads one: the main pass splits
    // there, the scene colour and depth are copied, and the rest draws in a second pass that loads them.
    const std::size_t viewportSplit = static_cast<std::size_t>(
        std::find_if(plan.begin(), plan.end(), [](const Planned& p) { return readsViewport(p.program->fragment); }) -
        plan.begin());
    bundleKey.push_back(viewportSplit);
    if (!mainBundle_ || bundleKey != mainBundleKey_) {
        if (mainBundle_) wgpuRenderBundleRelease(mainBundle_);
        if (viewportBundle_) wgpuRenderBundleRelease(viewportBundle_);
        mainBundle_ = viewportBundle_ = nullptr;
        WGPURenderBundleEncoderDescriptor descriptor{};
        const WGPUTextureFormat color = WGPUTextureFormat_RGBA16Float;
        descriptor.colorFormatCount = 1; descriptor.colorFormats = &color;
        descriptor.depthStencilFormat = WGPUTextureFormat_Depth32Float; descriptor.sampleCount = sampleCount_;
        const auto shadowStats = lastFrame_.shadowSkinned;
        const auto shadowDraws = lastFrame_.shadowDraws;
        lastFrame_ = FrameStats{};
        const auto record = [&](std::size_t from, std::size_t to) {
            const auto bundle = wgpuDeviceCreateRenderBundleEncoder(device_, &descriptor);
            bound = nullptr;
            boundIndex = nullptr;
            std::fill(std::begin(boundVertex), std::end(boundVertex), nullptr);
            for (std::size_t k = from; k < to; ++k) encode(bundle, plan[k], true);
            WGPURenderBundleDescriptor finish{};
            const WGPURenderBundle recorded = wgpuRenderBundleEncoderFinish(bundle, &finish);
            wgpuRenderBundleEncoderRelease(bundle);
            return recorded;
        };
        mainBundle_ = record(0, viewportSplit);
        if (viewportSplit < plan.size()) viewportBundle_ = record(viewportSplit, plan.size());
        mainBundleStats_ = lastFrame_;
        lastFrame_.shadowSkinned = shadowStats;
        lastFrame_.shadowDraws = shadowDraws;
        mainBundleKey_ = std::move(bundleKey);
    } else {
        lastFrame_.draws = mainBundleStats_.draws;
        lastFrame_.triangles = mainBundleStats_.triangles;
        lastFrame_.mainSkinned = mainBundleStats_.mainSkinned;
    }
    wgpuRenderPassEncoderExecuteBundles(pass, 1, &mainBundle_);
    wgpuRenderPassEncoderEnd(pass);
    wgpuRenderPassEncoderRelease(pass);
    // At 4x, the main pass draws depth into msaaDepth_. Resolve it into depth_ for the copy below.
    if (sampleCount_ == 4) resolveDepth(encoder);
    if (viewportBundle_) {
        WGPUImageCopyTexture_Compat from = {}, to = {};
        const WGPUExtent3D extent{width_, height_, 1};
        from.texture = sceneColor_; to.texture = viewportColor_;
        wgpuCommandEncoderCopyTextureToTexture(encoder, &from, &to, &extent);
        from.texture = depth_; to.texture = viewportDepth_;
        from.aspect = to.aspect = WGPUTextureAspect_DepthOnly;
        wgpuCommandEncoderCopyTextureToTexture(encoder, &from, &to, &extent);
        WGPURenderPassColorAttachment loadColor = color;
        loadColor.loadOp = WGPULoadOp_Load;
        WGPURenderPassDepthStencilAttachment loadDepth = depth;
        loadDepth.depthLoadOp = WGPULoadOp_Load;
        WGPURenderPassDescriptor viewportDesc = {};
        viewportDesc.colorAttachmentCount = 1;
        viewportDesc.colorAttachments = &loadColor;
        viewportDesc.depthStencilAttachment = &loadDepth;
        WGPURenderPassEncoder rest = wgpuCommandEncoderBeginRenderPass(encoder, &viewportDesc);
        wgpuRenderPassEncoderExecuteBundles(rest, 1, &viewportBundle_);
        wgpuRenderPassEncoderEnd(rest);
        wgpuRenderPassEncoderRelease(rest);
        // The rest pass draws more depth. Resolve it again for the normal, motion and post stages.
        if (sampleCount_ == 4) resolveDepth(encoder);
    }
    if (normalPass) {
        WGPURenderPassColorAttachment normals{};
        normals.view = normalView_; normals.loadOp = WGPULoadOp_Clear; normals.storeOp = WGPUStoreOp_Store;
#if defined(MYSTRAL_WEBGPU_DAWN)
        normals.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
#endif
        WGPURenderPassDepthStencilAttachment normalDepth{};
        normalDepth.view = depthView_; normalDepth.depthReadOnly = true;
        WGPURenderPassDescriptor normalDesc{};
        normalDesc.colorAttachmentCount = 1; normalDesc.colorAttachments = &normals;
        normalDesc.depthStencilAttachment = &normalDepth;
        auto normalEncoder = wgpuCommandEncoderBeginRenderPass(encoder, &normalDesc);
        bound = nullptr; boundIndex = nullptr;
        for (const Planned& p : normalPlan) encode(normalEncoder, p, false);
        wgpuRenderPassEncoderEnd(normalEncoder); wgpuRenderPassEncoderRelease(normalEncoder);
    }
    if (traa_) {
        WGPURenderPassColorAttachment motion{};
        motion.view = traa_->velocityView(); motion.loadOp = WGPULoadOp_Clear; motion.storeOp = WGPUStoreOp_Store;
#if defined(MYSTRAL_WEBGPU_DAWN)
        motion.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
#endif
        WGPURenderPassDepthStencilAttachment motionDepth{};
        motionDepth.view = depthView_; motionDepth.depthReadOnly = true;
        WGPURenderPassDescriptor motionDesc{};
        motionDesc.colorAttachmentCount = 1; motionDesc.colorAttachments = &motion;
        motionDesc.depthStencilAttachment = &motionDepth;
        auto velocityPass = wgpuCommandEncoderBeginRenderPass(encoder, &motionDesc);
        bound = nullptr; boundIndex = nullptr;
        for (const Planned& p : velocityPlan) encode(velocityPass, p, false);
        wgpuRenderPassEncoderEnd(velocityPass); wgpuRenderPassEncoderRelease(velocityPass);
        traa_->resolve(encoder, sceneColor_, sceneView_, depth_, depthView_);
    }
    if (postEffects_ && postEffects_->syncScales()) releaseOutputGroup();
    if (postEffects_) postEffects_->render(encoder, traa_ ? traa_->resultView() : sceneView_, depthView_, gpu_.buffer(outputTriangle_), camera, renderId_);
    outputPass(encoder, timed, presentTarget, presentFormat);
    if (timed) wgpuCommandEncoderResolveQuerySet(encoder, timestamps_, 0, 6, gpu_.buffer(timestampResolve_), 0);
    WGPUCommandBufferDescriptor commandDesc = {};
    submit(wgpuCommandEncoderFinish(encoder, &commandDesc));
    wgpuCommandEncoderRelease(encoder);
    if (timed) {
        timing_->pending = true;
        std::weak_ptr<Timing> timing = timing_;
        gpu_.readBuffer(timestampResolve_, 0, 48, [timing, shadowTimed](GpuStatus status, std::vector<uint8_t> bytes) {
            const std::shared_ptr<Timing> t = timing.lock();
            if (!t) return;  // the renderer is gone
            t->pending = false;
            uint64_t ns[6];
            if (status != GpuStatus::Ok || bytes.size() != sizeof ns) return;
            std::memcpy(ns, bytes.data(), sizeof ns);
            const uint64_t begin = shadowTimed ? ns[4] : ns[0];
            if (ns[3] <= begin) return;  // a reset clock reads as no sample
            t->lastMs = double(ns[3] - begin) / 1e6;
            const auto span = [](uint64_t from, uint64_t to) { return to > from ? double(to - from) / 1e6 : 0.0; };
            t->segments = {shadowTimed ? span(ns[4], ns[0]) : 0.0, span(ns[0], ns[1]), span(ns[1], ns[2]), span(ns[2], ns[3])};
            ++t->samples;
        });
    }
    return id;
}

void Renderer::outputPass(WGPUCommandEncoder encoder, bool timed, WGPUTextureView present, WGPUTextureFormat presentFormat) {
    PipelineTarget outputTarget{present ? presentFormat : WGPUTextureFormat_RGBA8Unorm, WGPUTextureFormat_Undefined, WGPUCullMode_None};
    outputTarget.layout = outputPipelineLayout_;
    WGPURenderPipeline pipeline = pipelines_.get(outputVertex_, &outputFragment_, outputTarget);
    if (!pipeline) throw std::runtime_error("TN_NATIVE_PIPELINE_REFUSED: output program");
    std::vector<uint8_t> block(std::max<uint32_t>(outputFragment_.uniformBlockSize, 4));
    if (post_)
        for (const auto& node : post_->live) postUniforms_[node->name] = node->values;
    postUniforms_["time"] = {frameTime_};
    for (const auto& field : outputFragment_.uniforms) {
        const auto value = postUniforms_.find(field.name);
        if (value == postUniforms_.end()) continue;
        const auto& values = value->second;
        if (values.size() != size_t(field.type.rows)*field.type.cols) throw std::runtime_error("TN_POST_UNIFORM_SIZE: " + field.name);
        const size_t stride = field.type.isMatrix() ? shader::uniformLayout(shader::Type::vec(field.type.rows)).align : field.type.rows*4;
        for (size_t col = 0; col < field.type.cols; ++col) std::memcpy(block.data()+field.offset+col*stride, values.data()+col*field.type.rows, field.type.rows*4);
    }
    put(block, outputFragment_, "toneMappingExposure", std::array<double, 1>{output_.toneMappingExposure});
    if (outputFragment_.uniformBlockSize) gpu_.writeBuffer(outputUniforms_, 0, block.data(), outputFragment_.uniformBlockSize);
    // The explicit output layout is shared by the offscreen and the presenting pipeline, so one
    // group serves both and needs no rebuild when the present format changes.
    WGPUBindGroup& group = outputGroup_;
    if (!group) {
        group = bindGroup(outputLayout_, outputFragment_, outputUniforms_, traa_ ? traa_->resultView() : sceneView_, outputSampler_);
    }
    WGPURenderPassColorAttachment color = {};
    color.view = present ? present : colorView_;
    color.loadOp = WGPULoadOp_Clear;
    color.storeOp = WGPUStoreOp_Store;
#if defined(MYSTRAL_WEBGPU_DAWN)
    color.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
#endif
    WGPURenderPassDescriptor passDesc = {};
    passDesc.colorAttachmentCount = 1;
    passDesc.colorAttachments = &color;
    WGPURenderPassTimestampWrites_Compat outputTimes = {};
    if (timed) {
        outputTimes.querySet = timestamps_;
        outputTimes.beginningOfPassWriteIndex = 2;
        outputTimes.endOfPassWriteIndex = 3;
        passDesc.timestampWrites = &outputTimes;
    }
    WGPURenderPassEncoder pass = wgpuCommandEncoderBeginRenderPass(encoder, &passDesc);
    wgpuRenderPassEncoderSetPipeline(pass, pipeline);
    wgpuRenderPassEncoderSetBindGroup(pass, 0, group, 0, nullptr);
    wgpuRenderPassEncoderSetVertexBuffer(pass, outputVertex_.attributes.at(0).location, gpu_.buffer(outputTriangle_), 0, 24);
    wgpuRenderPassEncoderDraw(pass, 3, 1, 0, 0);
    // three's renderer.info counts its output QuadMesh as one draw of one triangle; so does this.
    ++lastFrame_.draws;
    ++lastFrame_.triangles;
    wgpuRenderPassEncoderEnd(pass);
    wgpuRenderPassEncoderRelease(pass);
}

GpuStatus Renderer::readProbePixels(ReadbackCallback done) { return readRgba16(sceneColor_, std::move(done)); }

GpuStatus Renderer::readNormalPixels(ReadbackCallback done) { return readRgba16(normalTexture_, std::move(done)); }

GpuStatus Renderer::readRgba16(WGPUTexture texture, ReadbackCallback done) {
    if (!done) return GpuStatus::OutOfRange;
    if (!texture) return GpuStatus::InvalidHandle;
    const uint32_t width = width_, height = height_, row = width * 8, pitch = (row + 255u) & ~255u;
    const Handle staging = gpu_.createBuffer(uint64_t(pitch) * height, WGPUBufferUsage_CopyDst | WGPUBufferUsage_CopySrc);
    WGPUCommandEncoderDescriptor descriptor{};
    auto encoder = wgpuDeviceCreateCommandEncoder(device_, &descriptor);
    WGPUTexelCopyTextureInfo source{}; source.texture = texture; source.aspect = WGPUTextureAspect_All;
    WGPUTexelCopyBufferInfo destination{}; destination.buffer = gpu_.buffer(staging);
    destination.layout.bytesPerRow = pitch; destination.layout.rowsPerImage = height;
    const WGPUExtent3D extent{width, height, 1};
    wgpuCommandEncoderCopyTextureToBuffer(encoder, &source, &destination, &extent);
    WGPUCommandBufferDescriptor command{};
    submit(wgpuCommandEncoderFinish(encoder, &command));
    wgpuCommandEncoderRelease(encoder);
    const auto result = gpu_.readBuffer(staging, 0, uint64_t(pitch) * height,
        [width, height, row, pitch, done = std::move(done)](GpuStatus status, std::vector<uint8_t> bytes) {
            if (status != GpuStatus::Ok || bytes.size() != uint64_t(pitch) * height) {
                done(status == GpuStatus::Ok ? GpuStatus::OutOfRange : status, {}); return;
            }
            std::vector<uint8_t> packed(uint64_t(row) * height);
            for (uint32_t y = 0; y < height; ++y)
                std::memcpy(packed.data() + uint64_t(y) * row, bytes.data() + uint64_t(y) * pitch, row);
            done(GpuStatus::Ok, std::move(packed));
        });
    gpu_.destroy(staging);
    return result;
}

GpuStatus Renderer::readPixels(ReadbackCallback done) { return gpu_.readTexture(color_, std::move(done)); }

GpuStatus Renderer::readPresented(ReadbackCallback done) {
    if (!colorView_) return GpuStatus::InvalidHandle;
    if (!presentedView_ || presentedWidth_ != width_ || presentedHeight_ != height_) {
        if (presentedView_) {
            wgpuTextureViewRelease(presentedView_);
            gpu_.destroy(presented_);
        }
        presented_ = gpu_.createTexture(width_, height_, WGPUTextureFormat_RGBA8Unorm,
                                        WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_CopySrc);
        presentedView_ = view2d(gpu_.texture(presented_), WGPUTextureFormat_RGBA8Unorm);
        presentedWidth_ = width_;
        presentedHeight_ = height_;
    }
    if (!blitTo(nullptr, presentedView_, WGPUTextureFormat_RGBA8Unorm)) return GpuStatus::InvalidHandle;
    return gpu_.readTexture(presented_, std::move(done));
}

// The output triangle again, this time sampling the finished RGBA8 frame into a window surface. The
// program's own variant is chosen by the target format, so a BGRA swapchain gets a BGRA pipeline.
WGPURenderPipeline Renderer::copyPipeline(WGPUTextureFormat format, uint8_t blend,
    std::vector<std::shared_ptr<PipelineCompilation>>* compilation) {
    if (blitVertex_.wgsl.code.empty()) {
        const shader::OutputPrograms copy = shader::buildOutput(std::nullopt, false);
        blitVertex_ = shader::buildStage(copy.vertex, 0);
        blitFragment_ = shader::buildStage(copy.fragment, 0);
    }
    const PipelineTarget target{format, WGPUTextureFormat_Undefined, WGPUCullMode_None, blend};
    if (compilation) {
        compilation->push_back(pipelines_.getAsync(blitVertex_, &blitFragment_, target));
        return nullptr;
    }
    return pipelines_.get(blitVertex_, &blitFragment_, target);
}

// WebGPUTextureUtils.generateMipmaps: each level is drawn from a one-level view of the level above,
// sampled bilinearly at its texel centres, so only level 0 crosses from the CPU. An sRGB view decodes
// on the read and encodes on the write, so the chain filters in linear light.
void Renderer::generateMipmaps(WGPUTexture texture, WGPUTextureFormat format, uint32_t levels) {
    WGPURenderPipeline pipeline = copyPipeline(format, 0);
    if (!pipeline) throw std::runtime_error("TN_NATIVE_TEXTURE_MIPMAPS_FAILED: no copy pipeline");
    WGPUBindGroupLayout layout = wgpuRenderPipelineGetBindGroupLayout(pipeline, 0);
    if (!mipEncoder_) {
        WGPUCommandEncoderDescriptor encoderDesc = {};
        mipEncoder_ = wgpuDeviceCreateCommandEncoder(device_, &encoderDesc);
    }
    WGPUCommandEncoder encoder = mipEncoder_;
    std::vector<WGPUTextureView> views;
    for (uint32_t level = 0; level < levels; ++level) {
        WGPUTextureViewDescriptor desc = {};
        desc.dimension = WGPUTextureViewDimension_2D;
        desc.format = format;
        desc.baseMipLevel = level;
        desc.mipLevelCount = 1;
        desc.arrayLayerCount = 1;
        views.push_back(wgpuTextureCreateView(texture, &desc));
    }
    for (uint32_t level = 1; level < levels; ++level) {
        WGPUBindGroup group = bindGroup(layout, blitFragment_, outputUniforms_, views[level - 1], linearClampSampler());
        if (!group) throw std::runtime_error("TN_NATIVE_TEXTURE_MIPMAPS_FAILED: no bind group");
        mipGroups_.push_back(group);
        WGPURenderPassColorAttachment color = {};
        color.view = views[level];
        color.loadOp = WGPULoadOp_Clear;
        color.storeOp = WGPUStoreOp_Store;
#if defined(MYSTRAL_WEBGPU_DAWN)
        color.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
#endif
        WGPURenderPassDescriptor passDesc = {};
        passDesc.colorAttachmentCount = 1;
        passDesc.colorAttachments = &color;
        WGPURenderPassEncoder pass = wgpuCommandEncoderBeginRenderPass(encoder, &passDesc);
        wgpuRenderPassEncoderSetPipeline(pass, pipeline);
        wgpuRenderPassEncoderSetBindGroup(pass, 0, group, 0, nullptr);
        wgpuRenderPassEncoderSetVertexBuffer(pass, blitVertex_.attributes.at(0).location, gpu_.buffer(outputTriangle_), 0, 24);
        wgpuRenderPassEncoderDraw(pass, 3, 1, 0, 0);
        wgpuRenderPassEncoderEnd(pass);
        wgpuRenderPassEncoderRelease(pass);
    }
    wgpuBindGroupLayoutRelease(layout);
    for (WGPUTextureView view : views) mipViews_.push_back(view);
}

// One submit for every chain recorded since the last flush: a submit costs a queue call and a
// work-done callback each, and a scene load uploads hundreds of mipmapped textures.
void Renderer::flushMipmaps() {
    if (!mipEncoder_) return;
    WGPUCommandBufferDescriptor commandDesc = {};
    gpu_.submit(wgpuCommandEncoderFinish(mipEncoder_, &commandDesc));
    wgpuCommandEncoderRelease(mipEncoder_);
    mipEncoder_ = nullptr;
    for (WGPUBindGroup group : mipGroups_) wgpuBindGroupRelease(group);
    for (WGPUTextureView view : mipViews_) wgpuTextureViewRelease(view);
    mipGroups_.clear();
    mipViews_.clear();
}

void Renderer::submit(WGPUCommandBuffer commands) {
    flushMipmaps();
    gpu_.submit(commands);
}

bool Renderer::blitTo(WGPUQueue queue, WGPUTextureView target, WGPUTextureFormat format) {
    if (!target || !colorView_)
        return false;
    // The finished frame is already tone mapped and encoded: the blit copies it, never re-encodes it.
    WGPURenderPipeline pipeline = copyPipeline(format, 0);
    if (!pipeline)
        return false;
    WGPUBindGroupLayout layout = wgpuRenderPipelineGetBindGroupLayout(pipeline, 0);
    WGPUBindGroup group = bindGroup(layout, blitFragment_, outputUniforms_, colorView_, outputSampler_);
    wgpuBindGroupLayoutRelease(layout);
    if (!group)
        return false;

    WGPUCommandEncoderDescriptor encoderDesc = {};
    WGPUCommandEncoder encoder = wgpuDeviceCreateCommandEncoder(device_, &encoderDesc);
    WGPURenderPassColorAttachment color = {};
    color.view = target;
    color.loadOp = WGPULoadOp_Clear;
    color.storeOp = WGPUStoreOp_Store;
    color.clearValue = {0, 0, 0, 1};
#if defined(MYSTRAL_WEBGPU_DAWN)
    color.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
#endif
    WGPURenderPassDescriptor passDesc = {};
    passDesc.colorAttachmentCount = 1;
    passDesc.colorAttachments = &color;
    WGPURenderPassEncoder pass = wgpuCommandEncoderBeginRenderPass(encoder, &passDesc);
    wgpuRenderPassEncoderSetPipeline(pass, pipeline);
    wgpuRenderPassEncoderSetBindGroup(pass, 0, group, 0, nullptr);
    wgpuRenderPassEncoderSetVertexBuffer(pass, blitVertex_.attributes.at(0).location,
                                         gpu_.buffer(outputTriangle_), 0, 24);
    wgpuRenderPassEncoderDraw(pass, 3, 1, 0, 0);
    // The UI overlay's frame over the world, in the same pass: the same copy program samples it, and
    // premultiplied "over" blending keeps whatever the page left transparent.
    WGPUBindGroup overlayGroup = nullptr;
    if (overlayView_) {
        WGPURenderPipeline over = copyPipeline(format, 3);
        if (over) {
            WGPUBindGroupLayout overLayout = wgpuRenderPipelineGetBindGroupLayout(over, 0);
            overlayGroup = bindGroup(overLayout, blitFragment_, outputUniforms_, overlayView_, outputSampler_);
            wgpuBindGroupLayoutRelease(overLayout);
        }
        if (overlayGroup) {
            wgpuRenderPassEncoderSetPipeline(pass, over);
            wgpuRenderPassEncoderSetBindGroup(pass, 0, overlayGroup, 0, nullptr);
            wgpuRenderPassEncoderDraw(pass, 3, 1, 0, 0);
        }
    }
    wgpuRenderPassEncoderEnd(pass);
    wgpuRenderPassEncoderRelease(pass);
    WGPUCommandBufferDescriptor commandDesc = {};
    submit(wgpuCommandEncoderFinish(encoder, &commandDesc));
    wgpuCommandEncoderRelease(encoder);
    wgpuBindGroupRelease(group);
    if (overlayGroup) wgpuBindGroupRelease(overlayGroup);
    return true;
}

void Renderer::setOverlay(const uint8_t* pixels, uint32_t width, uint32_t height, uint64_t version, uint32_t stride,
                          bool bgra) {
    // overlayView_ is set exactly while overlay_ names a live texture.
    const auto release = [this] {
        if (!overlayView_) return;
        wgpuTextureViewRelease(overlayView_);
        overlayView_ = nullptr;
        gpu_.destroy(overlay_);
        overlay_ = {};
    };
    if (!pixels || width == 0 || height == 0) {
        release();
        overlayWidth_ = overlayHeight_ = 0;
        overlayVersion_ = 0;
        return;
    }
    if (overlayView_ && version == overlayVersion_ && width == overlayWidth_ && height == overlayHeight_ &&
        bgra == overlayBgra_)
        return;
    // The texture's own format reads B,G,R,A as colour, so the shared copy program needs no swizzle.
    const WGPUTextureFormat format = bgra ? WGPUTextureFormat_BGRA8Unorm : WGPUTextureFormat_RGBA8Unorm;
    if (!overlayView_ || width != overlayWidth_ || height != overlayHeight_ || bgra != overlayBgra_) {
        release();
        overlay_ = gpu_.createTexture(width, height, format, WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst);
        overlayView_ = view2d(gpu_.texture(overlay_), format);
        overlayWidth_ = width;
        overlayHeight_ = height;
        overlayBgra_ = bgra;
    }
    const uint32_t row = width * 4;
    if (stride != 0 && stride != row) {
        overlayRows_.resize(size_t(row) * height);
        for (uint32_t y = 0; y < height; ++y) std::memcpy(overlayRows_.data() + size_t(y) * row, pixels + size_t(y) * stride, row);
        pixels = overlayRows_.data();
    }
    gpu_.writeTexture(overlay_, pixels, uint64_t(row) * height);
    overlayVersion_ = version;
    ++overlayUploads_;
}

}  // namespace tn::engine
