#pragma once

// PRD-840: what renderer.cpp and the renderer TUs split from it share - the includes, the file-local helpers
// (one copy per TU, as before the split) and the frame's private structs. Include it only from renderer*.cpp.

#include "engine/foundation/job_pool.h"
#include "engine/foundation/flags.h"
#include "engine/foundation/waste_counters.h"
#include "engine/shader/wgsl_strip.h"
#include "renderer.h"
#include "engine/renderer/pipeline_cache.h"
#include "engine/renderer/aux_fragment.h"
#include "engine/renderer/aux_targets.h"
#include "engine/renderer/aux_bundle_key.h"
#include "engine/renderer/texture_copy.h"
#include "engine/renderer/aux_depth.h"
#include "engine/renderer/readback_crop.h"
#include "engine/renderer/render_target_pass.h"
#include "engine/renderer/material_uniforms.h"
#include "engine/renderer/shadows/lamp_resolution.h"

#include <algorithm>
#include <bit>
#include <cassert>
#include <exception>
#include <span>
#include <deque>
#include <numeric>
#include <sstream>
#include <iomanip>
#include <cstdio>
#include <cctype>
#include <cstdlib>
#include <cmath>
#include <ctime>
#include <unordered_map>
#include "engine/animation/skinning/palette.h"
#include <iterator>
#include <cstring>
#include <stdexcept>
#include <type_traits>
#include <typeinfo>
#include <vector>
#if defined(__wasm_simd128__)
#include <wasm_simd128.h>
#endif

#include "engine/shader/dfg_lut.h"
#include "engine/shader/sprite.h"
#include "engine/scene/texture.h"
#include "engine/scene/nodes.h"
#include "engine/scene/material.h"
#include "engine/scene/camera.h"
#include "engine/renderer/graph/render_graph.h"
#include "engine/renderer/post/traa.h"
#include "engine/scene/lights.h"
#include "engine/renderer/post/effects.h"
#include "engine/shader/tsl/tsl.h"
#include "engine/shader/graph/serialized.h"
#include "mystral/webgpu_compat.h"

namespace tn::engine {

inline std::atomic<bool> cpuMetersOn{true};  // Renderer::setCpuMeters; meterStart reads it

namespace {

// TR1: are two byte runs equal? musl's memcmp is a word loop on Wasm (about 5 GB/s with the engine's flags); 64 bytes a
// step with SIMD runs at about 15, and the storage upload scans every byte of a still `instances` array each plan.
inline bool sameBytes(const uint8_t* a, const uint8_t* b, std::size_t n) {
    std::size_t i = 0;
#if defined(__wasm_simd128__)
    for (; i + 64 <= n; i += 64) {
        v128_t diff = wasm_v128_xor(wasm_v128_load(a + i), wasm_v128_load(b + i));
        diff = wasm_v128_or(diff, wasm_v128_xor(wasm_v128_load(a + i + 16), wasm_v128_load(b + i + 16)));
        diff = wasm_v128_or(diff, wasm_v128_xor(wasm_v128_load(a + i + 32), wasm_v128_load(b + i + 32)));
        diff = wasm_v128_or(diff, wasm_v128_xor(wasm_v128_load(a + i + 48), wasm_v128_load(b + i + 48)));
        if (wasm_v128_any_true(diff)) return false;
    }
#endif
    return std::memcmp(a + i, b + i, n - i) == 0;
}

inline bool gpuJointAncestorEligible(const Object3D& ancestor, const SkinnedMesh& rig) {
    const auto* flags = ancestor.ownTransformTracking();
    if (!flags || !flags[0] || ancestor.onBeforeRender) return false;
    if (!flags[2]) return true;
    // Only CPU-eager auto-world nodes strictly outside the rig's placement may escape.
    return &ancestor != &rig && &ancestor != rig.parent && ancestor.matrixWorldAutoUpdate &&
        (typeid(ancestor) == typeid(Object3D) ||
        typeid(ancestor) == typeid(Group) || typeid(ancestor) == typeid(Mesh));
}

inline WGPUTextureFormat textureFormat(const Texture& texture) {
    if (texture.compressed())
        return texture.imageSource->mipmapFormat == kTextureBC7Format
                   ? (texture.isSRGB() ? WGPUTextureFormat_BC7RGBAUnormSrgb : WGPUTextureFormat_BC7RGBAUnorm)
                   : (texture.isSRGB() ? WGPUTextureFormat_ETC2RGBA8UnormSrgb : WGPUTextureFormat_ETC2RGBA8Unorm);
    return texture.isFloat() ? WGPUTextureFormat_RGBA32Float
         : texture.isHalfFloat() ? WGPUTextureFormat_RGBA16Float
         : texture.isSRGB() ? WGPUTextureFormat_RGBA8UnormSrgb : WGPUTextureFormat_RGBA8Unorm;
}

using Matrix3 = std::array<double, 9>;

inline Matrix multiply(const Matrix& a, const Matrix& b) {
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
inline Matrix3 normalMatrix(const Matrix& m) {
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

/** A positionNode caster with no maxPositionOffset whose geometry states its own boundingBox: that box bounds it. */
inline bool displacedByGeometryBox(const DrawItem& item) {
    return (item.positionNode || item.nodes->shadowPositionNode()) && item.geometryBox && !item.geometryBox->isEmpty() &&
           !(item.material && item.material->maxPositionOffset > 0) && !item.boneMatrices && !item.morphGeometry && !item.gpuJoints;
}

inline WGPUVertexFormat skinIndexFormat(const DrawItem& item) {
    if (!item.skinIndices) return WGPUVertexFormat_Uint16x4;
    switch (item.skinIndices->scalar()) {
        case Scalar::U8: return WGPUVertexFormat_Uint8x4;
        case Scalar::U32: return WGPUVertexFormat_Uint32x4;
        default: return WGPUVertexFormat_Uint16x4;
    }
}

// A point through a column-major matrix (w = 1): a light's view-space position, as three's
// lightViewPosition computes it on the CPU before it becomes a uniform.
inline std::array<double, 3> transformPoint(const Matrix& m, const std::array<double, 3>& v) {
    return {m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12], m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
            m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14]};
}

inline std::array<double, 3> rotate(const Matrix& m, const std::array<double, 3>& v) {
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

// A caster or draw whose alpha test runs: the flat alphaTest above 0, or an alphaTestNode (three tests a set node always).
static inline bool alphaTested(const shader::StandardMaterial& material, const shader::MaterialNodes& nodes) {
    return material.alphaTest > 0 || bool(nodes.alphaTestNode);
}

// Authored uniform data accompanies the graph, not the cached program. Both colour and shadow
// draws bind it, so a graph positionNode has exactly the same deformation in the two passes.
// A draw's material uniforms for one stage, read in place from its graphs' uniform nodes every frame
// (no map built per draw): three's `time` (the frame's elapsed seconds), then each named value. The
// resolution itself is material_uniforms.h, which resolves a field by the name hash the stage was laid
// out with instead of comparing every field's name against every value: those string compares were 59%
// of the shooter's frame memcmp time (#574).
inline void putNodes(std::vector<uint8_t>& block, size_t base, const shader::StageModule& stage,
              const shader::MaterialNodes& nodes, float time, float delta, const LightState& lights) {
    thread_local std::vector<shader::BoundUniform> values;
    const std::array<double, 2> clock{time, delta};
    shader::bindMaterialUniforms(values, nodes, clock);
    for (const auto& field : stage.uniforms) {
        if (field.shadowLightId != shader::kNoShadowLight) {
            put(block, base, &field, lights.shadowMatrix(field.shadowLightId));
            continue;
        }
        const shader::BoundUniform* found = shader::findBoundUniform(values, field);
        if (found == nullptr) continue;
        if (field.type.scalar == shader::Type::Scalar::Bool ||
            found->values.size() != size_t(field.type.rows) * field.type.cols)
            throw std::runtime_error("TN_TSL_UNIFORM_TYPE: " + field.name);
        shader::writeUniform(std::span(block).subspan(base), field, found->values);
    }
}

constexpr const char* kSlotNames[] = {
    "modelMatrix", "viewMatrix", "projectionMatrix", "normalMatrix", "diffuse", "alphaTest", "opaque", "roughness",
    "metalness", "emissive", "specular", "shininess", "ior", "specularIntensity", "specularColor", "uvTransform",
    "hemisphereSky", "hemisphereGround", "hemisphereDirection", "ambient", "boneBase", "bindMatrix",
    "bindMatrixInverse", "morphBase", "morphInfluenceBase", "morphVertexCount", "morphBaseInfluence",
    "envMapIntensity", "cameraWorldMatrix", "envMapMaxMip", "boneStride", "fogColor", "fogNear", "fogFar", "fogDensity", "backgroundRotation", "envRotation", "instanceBase", "normalScale", "normalUvTransform", "cameraPosition", "cameraProjectionMatrix",
    "roughnessMapUvTransform", "metalnessMapUvTransform", "aoMapUvTransform", "emissiveMapUvTransform",
    "bumpMapUvTransform", "specularColorMapUvTransform",
    "specularIntensityMapUvTransform", "clearcoatMapUvTransform", "clearcoatRoughnessMapUvTransform",
    "clearcoatNormalMapUvTransform", "aoMapIntensity", "clearcoat", "clearcoatRoughness", "clearcoatNormalScale", "bumpScale",
    "pmremMaxMip", "pmremRotation", "screenSize", "cameraNear", "cameraFar",
    "modelNormalMatrix", "subsurfaceColor", "shadowNoiseFrame", "viewMipBias"};
constexpr const char* kLightFieldNames[] = {"Color",       "Direction",        "Position",     "Distance",
                                            "Decay",       "Axis",             "ConeCos",      "PenumbraCos",
                                            "ShadowMatrix", "ShadowBias",      "ShadowNormalBias", "ShadowRadius",
                                            "ShadowMapSize", "ShadowIntensity", "ShadowNear", "ShadowFar",
                                            "ShadowSourceRadius", "ShadowPenumbraScale", "SourceRadius"};

constexpr uint64_t kUniformAlign = 256;  // minUniformBufferOffsetAlignment's WebGPU default
// A lamp stores a caster's back faces. A back face in the receiver's own plane, a crate's bottom face on
// the floor beside it, ties with that floor to the last bit of the depth, and the tie lights a dotted line
// along the crate's far foot. The back faces go this many depth steps nearer the lamp, so a tie is a block
// (native_engine_contact_shadow_foot needs 2; the lamp-room crate, 1).
constexpr int32_t kLampBackFaceBias = 8;
// The page x caster pairs below which one light's caster selection stays on the caller: a proposed gate, not a
// measured crossover (a whole light's pairs below it cost less than a dispatch).
constexpr uint64_t kShadowPageJobPairs = 16384;
inline uint64_t aligned(uint64_t size) { return (size + kUniformAlign - 1) / kUniformAlign * kUniformAlign; }

inline WGPUTextureView view2d(WGPUTexture texture, WGPUTextureFormat format) {
    WGPUTextureViewDescriptor desc = {};
    desc.dimension = WGPUTextureViewDimension_2D;
    desc.mipLevelCount = 1;
    desc.arrayLayerCount = 1;
    desc.format = format;
    return wgpuTextureCreateView(texture, &desc);
}

// three's wrapping and filter constants (1000/1001/1002, 1000/1001) to WebGPU's.
inline WGPUAddressMode addressMode(uint16_t wrap) {
    switch (static_cast<TextureWrap>(wrap)) {
        case TextureWrap::Repeat: return WGPUAddressMode_Repeat;
        case TextureWrap::MirroredRepeat: return WGPUAddressMode_MirrorRepeat;
        default: return WGPUAddressMode_ClampToEdge;
    }
}
inline WGPUFilterMode filterMode(uint16_t filter) {
    return filter >= static_cast<uint16_t>(TextureFilter::Linear) && filter <= static_cast<uint16_t>(TextureFilter::LinearMipmapLinear)
        ? WGPUFilterMode_Linear : WGPUFilterMode_Nearest;
}

// A Line or LineSegments draw: its topology, no culling, and an indexed strip's index format.
inline void lineTopology(PipelineTarget& target, const DrawItem& item) {
    if (item.topology == WGPUPrimitiveTopology_TriangleList) return;
    target.topology = item.topology;
    target.cull = WGPUCullMode_None;
    if (item.topology == WGPUPrimitiveTopology_LineStrip && item.indices)
        target.stripIndexFormat = item.indices->scalar() == Scalar::U32 ? WGPUIndexFormat_Uint32 : WGPUIndexFormat_Uint16;
}

// three's Texture.updateMatrix: Matrix3.setUvTransform(offset.x, offset.y, repeat.x, repeat.y,
// rotation, center.x, center.y). Its elements are column-major, as the fragment's mat3x3 uniform reads them.
inline std::array<double, 9> uvTransformOf(const Texture& t) {
    return tn::engine::Matrix3()
        .setUvTransform(t.offset.x, t.offset.y, t.repeat.x, t.repeat.y, t.rotation, t.center.x, t.center.y)
        .elements;
}

// A program that samples a material `map` or an environment cannot have one shared fragment group:
// each draw's group binds its own texture and sampler. Its group[1] is left null and built per draw.
// A TSL texture(object, uv) binding (tsl_call's "nodeMap<id>"): the draw's own texture, in either stage.
inline bool graphTextureBinding(std::string_view name) { return name.rfind("t_nodeMap", 0) == 0; }

// A TSL reflector() binding ("t_reflector<serial>", "smp_reflector<serial>"): the draw's own mirror pass.
inline bool reflectorBinding(std::string_view name) {
    return name.rfind("t_reflector", 0) == 0 || name.rfind("smp_reflector", 0) == 0;
}

// A material node reading a post render-to-texture pass (convertToTexture's "native_rtt_<n>", or a late resolve's own
// "native_traa_<n>"): the pass's output view belongs to the main renderer's post effects and moves when they resize, so
// each draw binds it itself.
inline bool postTextureBinding(std::string_view name) {
    for (const std::string_view prefix : {"t_native_rtt", "smp_native_rtt", "t_native_traa", "smp_native_traa"})
        if (name.rfind(prefix, 0) == 0) return true;
    return false;
}

// The store a vertex attribute reads for a draw, by the attribute's name; null for a name the draw lacks.
// Shared by the plan, which syncs it, and the encode half, which binds it.
inline BufferStore* vertexSourceOf(const DrawItem& item, const shader::VertexAttribute& a) {
    const bool column = a.name.rfind("instanceMatrix", 0) == 0;
    BufferStore* source = a.name == "position"        ? item.positions
                          : a.name == "normal"        ? item.normals
                          : a.name == "uv"            ? item.uvs
                          : a.name == "color"         ? item.colors
                          : a.name == "instanceColor" ? item.instanceColors
                          : a.name == "skinIndex" && a.type.scalar == shader::Type::Scalar::U32 ? item.skinIndices
                          : a.name == "skinWeight"    ? item.skinWeights
                          : column                   ? item.instanceMatrices : nullptr;
    // Any other name is one of the geometry's own attributes (TSL attribute(name)).
    for (const DrawItem::CustomAttribute& custom : *item.attributes)
        if (!source && custom.name == a.name) source = custom.store;
    return source;
}

// Bit i set: the vertex stage's attribute i is one of the draw's InstancedBufferAttributes.
inline uint64_t instanceStepMask(const shader::StageModule& vertex, const DrawItem& item) {
    uint64_t mask = 0;
    for (std::size_t i = 0; i < vertex.attributes.size() && i < 64; ++i)
        for (const DrawItem::CustomAttribute& custom : *item.attributes)
            if (custom.perInstance && custom.name == vertex.attributes[i].name) mask |= uint64_t(1) << i;
    return mask;
}

// A grouped shadow row's per-instance bytes live in the frame's `instances` storage, so this store only marks
// the draw instanced: no buffer is read through it (FM8).
inline BufferStore& shadowGroupInstances() {
    static BufferStore store(Scalar::F32, 0);
    return store;
}

// FM8's lever: TN_SHADOW_INSTANCE_GROUPS=0 plans one row per caster per page again. Read per frame, not once,
// so a test and the stress lab's paired runs plan both arms in one process.
inline bool shadowGroupsEnabled() {
    const char* flag = flags::read<flags::ShadowInstanceGroups>();
    return flag == nullptr || std::strcmp(flag, "0") != 0;
}

// FG1's lever: TN_SHADOW_INSTANCE_CULL=0 draws every instance of an instanced caster on each page its union box reaches
// again. Read per frame, not once, so a test and the stress lab's paired runs plan both arms in one process.
inline bool shadowInstanceCullEnabled() {
    const char* flag = flags::read<flags::ShadowInstanceCull>();
    return flag == nullptr || std::strcmp(flag, "0") != 0;
}

// A viewport texture binding: the frame's colour or depth as drawn before this draw.
inline bool viewportBinding(std::string_view name) {
    return name == "t_viewportColor" || name == "smp_viewportColor" || name == "t_viewportDepth" ||
           name == "smp_viewportDepth";
}

inline bool readsPostTexture(const shader::StageModule& stage) {
    waste::debugAdd(waste::counters().programProbeScans);
    return std::any_of(stage.bindings.begin(), stage.bindings.end(),
                       [](const shader::Binding& binding) { return postTextureBinding(binding.name); });
}

inline bool readsViewport(const shader::StageModule& stage) {
    waste::debugAdd(waste::counters().programProbeScans);
    return std::any_of(stage.bindings.begin(), stage.bindings.end(),
                       [](const shader::Binding& binding) { return viewportBinding(binding.name); });
}

inline bool perDrawFragment(const shader::StageModule& stage) {
    waste::debugAdd(waste::counters().programProbeScans);
    for (const shader::Binding& binding : stage.bindings)
        if (binding.name == "t_map" || binding.name == "t_normalMap" || binding.name == "t_env" ||
            reflectorBinding(binding.name) || graphTextureBinding(binding.name) ||
            postTextureBinding(binding.name) || viewportBinding(binding.name))
            return true;
    return false;
}

// A vertex stage that samples a graph texture (a positionNode's displacement map) binds it per draw.
inline bool perDrawVertex(const shader::StageModule& stage) {
    waste::debugAdd(waste::counters().programProbeScans);
    return std::any_of(stage.bindings.begin(), stage.bindings.end(),
                       [](const shader::Binding& binding) { return graphTextureBinding(binding.name); });
}

// The normal target's value (three's MRT `normalView`): the fragment's own normal, which is the material's normalNode
// result when it authors one (`authored`, the value the lit fragment shades with: three's NodeMaterial.setupNormal
// returns vec3(normalNode), so no face flip and no map). Without one it is the interpolated view-space normal, or a flat
// face's from the derivatives of positionView as the colour fragment takes it (flat vertices carry zero normals), flipped
// on a DoubleSide back face. For post passes that read metalness and roughness, a Standard or Physical surface packs both
// into the alpha:
//   alpha = 2 * round(7 * metalness) + 0.25 + 0.5 * roughness
// so the integer half is the metalness level, the fraction is roughness, and 0 (nothing written) is no surface at all.
// Half-float spacing stays well under the 0.25 offset. The material's own `metalness` and `roughness` uniforms are
// read, so a fragment that declares only these two finds them at the lit block's offsets 0 and 4.
static inline shader::ExprId normalTarget(shader::Program& f, bool flat, bool doubleSide, bool surface,
                                   shader::ExprId authored = shader::kInvalid) {
    shader::ExprId normal = authored;
    if (normal == shader::kInvalid) {
        normal = f.varying("normalView", shader::Type::vec(3));
        if (flat) {
            const auto position = f.varying("positionView", shader::Type::vec(3));
            normal = f.call("cross", {f.call("dFdx", {position}), f.call("dFdy", {position})});
        }
        normal = f.call("normalize", {normal});
        if (doubleSide && !flat)
            normal = f.mul(normal, f.select(f.builtin("frontFacing"), f.constant(1.f), f.constant(-1.f)));
    }
    auto alpha = f.constant(0.f);
    if (surface) {
        const auto clamp01 = [&](shader::ExprId v) { return f.call("clamp", {v, f.constant(0.f), f.constant(1.f)}); };
        const auto metalness = clamp01(f.uniform("metalness", shader::Type::f32()));
        const auto roughness = clamp01(f.uniform("roughness", shader::Type::f32()));
        const auto level = f.call("floor", {f.add(f.mul(metalness, f.constant(7.f)), f.constant(0.5f))});
        alpha = f.add(f.add(f.mul(level, f.constant(2.f)), f.constant(0.25f)), f.mul(roughness, f.constant(0.5f)));
    }
    return f.construct(shader::Type::vec(4), {normal, alpha});
}

// A custom MRT slot's node as the vec4 its RGBA16F attachment holds: vec3 gains an opaque alpha, a float splats to
// every lane as three's vec4(float) does. The slot's type was checked when the frame planned it.
static inline shader::ExprId mrtColour(shader::Program& f, shader::ExprId value) {
    const shader::Type type = f.expr(value).type;
    if (type.rows == 4) return value;
    if (type.rows == 3) return f.construct(shader::Type::vec(4), {value, f.constant(1.f)});
    if (type.rows == 2) return f.construct(shader::Type::vec(4), {f.swizzle(value, "xy"), f.constant(0.f), f.constant(1.f)});
    return f.construct(shader::Type::vec(4), {value, value, value, value});
}

// PRD-754's recording meters: the calling thread's CPU ms where the platform has that clock, so a loaded host does
// not inflate them, else wall ms.
static inline double meterMs() {
#if defined(__linux__) && !defined(__EMSCRIPTEN__)
    timespec t{};
    clock_gettime(CLOCK_THREAD_CPUTIME_ID, &t);
    return double(t.tv_sec) * 1e3 + double(t.tv_nsec) / 1e6;
#else
    return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count();
#endif
}

// A stage opened while the meters are off carries a negative start and adds nothing, so flipping the switch inside a
// frame never charges the clock's epoch to a stage.
static inline double meterStart(bool on) { return on && cpuMetersOn.load(std::memory_order_relaxed) ? meterMs() : -1; }

}  // namespace

// What a frame's plan holds for its encode half (PRD-613): everything renderPrepared resolved from
// scene-owned data, so encodeFrame needs none of it. One job lives in the renderer and is reused.
struct Renderer::Planned {
    const DrawItem* item;
    Program* program;
    WGPURenderPipeline pipeline;
    uint32_t vertexOffset, fragmentOffset;
    double instanceBase = 0;  // a shadow draw's slice in the packed instance storage
    WGPUBindGroup mapGroup = nullptr;  // a mapped material's fragment group, else the program's
    WGPUBindGroup vertexGroup = nullptr;  // a vertex stage's per-draw group (graph textures), else the program's
    uint64_t slot = 0;  // a main draw's uniform slot (PRD-754), 0 when its blocks were appended
    // A shadow row that draws several casters in one instanced draw names them, in instance order (FM8);
    // empty for a row that draws the one caster it points at.
    const DrawItem* const* members = nullptr;
    uint32_t memberCount = 0;
};

/**
 * PRD-754: one main-pass draw as the bundle records it, resolved from its Planned entry while that frame's stores were
 * live. A draw out of view keeps its row with no instances, drawn through drawIndexedIndirect, so the bundle holds
 * while the visible set changes (UE 5.8.3: Engine/Source/Runtime/Renderer/Private/MeshDrawCommands.cpp keeps cached
 * draw commands across frames and only the visible set and instance counts change). The handles are raw: the current
 * bundle keeps every row's objects alive, and the rows out of view go when any GPU resource is destroyed.
 */
struct Renderer::MainRow {
    bool background = false, transparent = false;
    int renderOrder = 0;
    MaterialKind kind = MaterialKind::Standard;
    uint8_t side = 0;
    uintptr_t material = 0, positions = 0, indices = 0;
    uint64_t id = 0, slot = 0;
    WGPURenderPipeline pipeline = nullptr;
    WGPUBindGroup vertexGroup = nullptr, mapGroup = nullptr;
    uint32_t vertexOffset = 0, fragmentOffset = 0;
    bool fragmentBlock = false;
    struct Vertex { uint32_t location; WGPUBuffer buffer; uint64_t offset, size; };
    std::vector<Vertex> vertex;
    WGPUBuffer index = nullptr;
    WGPUIndexFormat indexFormat = WGPUIndexFormat_Undefined;
    uint64_t indexSize = 0;
    uint32_t count = 0;      // indices, or vertices for a non-indexed draw
    uint32_t instances = 0;  // this frame's; 0 while out of view
    WGPUBuffer indirect = nullptr;  // the geometry's own GPU-filled record (PRD-857), drawn in place of the pass's
    uint64_t indirectOffset = 0;
    uint64_t seen = 0;
    std::vector<uint64_t> words;  // the draw's row of the per-draw bundle key: unchanged, the commands are too
    // sortDraws' state order: the background first, then renderOrder, then state.
    auto order() const { return std::make_tuple(!background, renderOrder, kind, side, material, positions, indices, id, slot); }
};

/** PRD-754: one pass's retained rows for this frame's encode, and three's Info for its visible draws. */
struct Renderer::PassRows {
    bool on = false;
    std::shared_ptr<const std::vector<Renderer::MainRow>> rows;
    Renderer::RecordCause cause = Renderer::RecordNone;
    WGPUBuffer indirect = nullptr;
    std::size_t sorted = 0;              // rows [0, sorted) record in state order; the rest, first seen since, after them
    std::array<uint64_t, 3> deltaKey{};  // the rows after `sorted`
    std::size_t tail = 0;                 // aux and velocity: the first transparent draw, recorded after the rows
    std::vector<uint64_t> tailKey;        // its draws' rows of the per-draw key
    double ms = 0;  // building the rows, in the plan stage
    uint32_t draws = 0;
    uint64_t triangles = 0;
    Renderer::FrameStats::SkinnedPass skinned{};
};

struct Renderer::MainRows {
    std::vector<MainRow> rows;                     // opaque draws with a uniform slot, kept while out of view
    std::unordered_map<uint64_t, uint32_t> index;  // slot -> rows position
    std::vector<MainRow> loose;                    // transparent draws and draws with no slot, last frame's, plan order
    std::vector<MainRow> after;                    // the draws after the viewport copy: their counts, for Info
    std::shared_ptr<const std::vector<MainRow>> ordered;  // the bundle's rows, rebuilt only when a row changes
    std::vector<uint32_t> source;                  // ordered position -> rows index, or kLoose | loose index
    std::vector<uint32_t> args;                    // the indirect records as last written
    std::vector<uint64_t> planKey;                 // the per-draw key the rows were last resolved from
    std::vector<uint32_t> planRows, planSource;    // its row starts, and each plan draw's row: rows, kLoose or kAfter
    std::vector<uint32_t> lastSource;              // last frame's planSource: a draw in the same place finds its row there
    uint64_t frame = 0, destroys = 0, generation = 0;
    std::size_t sorted = 0;  // the ordered rows the last full record sorted; rows first seen since follow them
    PassRows last;           // the last frame's result, for a frame whose key matches it word for word
    Handle indirect{};
    uint64_t capacity = 0;
    static constexpr uint32_t kLoose = 1u << 31, kAfter = 1u << 30;
    MainRow& at(uint32_t code) {
        return code & kLoose ? loose[code & ~kLoose] : code & kAfter ? after[code & ~kAfter] : rows[code];
    }
    void clear() {
        rows.clear(); index.clear(); loose.clear(); after.clear(); ordered.reset(); source.clear(); planKey.clear();
        sorted = 0;
    }
};

struct Renderer::ShadowPass {
    WGPUTextureView target;
    std::size_t virtualLight = 0;  // the light the pass draws for
    int virtualLevel = -1;
    bool lamp = false;  // a spot or point light's own map (PRD-650): counted and timed apart from the sun's
    bool mover = false;  // one light's mover map, drawn for the casters that are moving this frame
    int x = 0, y = 0, size = 0; // zero: ordinary map; otherwise one atlas page's guarded viewport
    // The camera this pass draws through, kept so the retained draws pack after the lamp cache decides.
    Matrix view{}, projection{};
    std::vector<Planned> draws;
};

// The frame storages a velocity stage also reads at their previous frame's contents, as traaPrevious_<name>.
constexpr std::array<const char*, 2> kPreviousStorages{"boneMatrices", "instances"};

struct Renderer::FrameJob {
    uint64_t groupEpoch = 0;  // the group epoch the plan's bind groups were chosen under
    // Skinned and instanced velocity: the bytes of each kPreviousStorages entry copied to its traaPrevious_ twin after the
    // velocity pass (zero copies nothing), and whether a seeded frame copies them before it too.
    std::array<uint64_t, 2> previousBytes{};
    bool previousSeed = false;
    std::vector<Planned> plan, velocityPlan, auxPlan, translucentPlan;
    std::unordered_map<uint64_t, DeformationFrame> deformationFrames;
    std::vector<ShadowPass> shadowPasses;
    uint32_t keptShadowMaps = 0;  // FrameStats::keptShadowMaps, counted by the plan
    uint64_t uniformBytes = 0;  // FrameStats::uniformBytes, written by the plan
    uint32_t paletteWrites = 0;  // FrameStats::paletteWrites, counted by the plan
    uint32_t shadowGroupRows = 0;  // FrameStats::shadowGroupRows, counted by the plan
    uint32_t instanceCopies = 0;  // FrameStats::instanceCopies, counted by the plan
    std::deque<DrawItem> shadowLodItems;
    // FM8: a page's grouped casters as rows (one per page and group) and each row's member list. Both are
    // deques: a plan's row points at its members' array until the frame is encoded.
    std::deque<DrawItem> shadowGroupItems;
    std::deque<std::vector<const DrawItem*>> shadowGroups;
    WGPURenderPassColorAttachment color{};
    WGPURenderPassDepthStencilAttachment depth{};
    WGPUCommandEncoder encoder = nullptr;
    WGPURenderPipeline pageClear = nullptr;
    CameraState camera;
    LightState lights;
    WGPUTextureView presentTarget = nullptr;
    WGPUTextureFormat presentFormat = WGPUTextureFormat_Undefined;
    bool timed = false;
    bool debugTimestampRequested = true;
    uint8_t auxMask = 0;  // the AuxTarget bits the aux pass writes, in attachment order
    std::vector<std::string> auxMrt;  // the custom MRT slots the aux pass writes after them, in name order
    bool translucentActive = false;  // the post graph reads "translucent": the transparent draws have their own pass
    uint64_t source = 0;  // the caller frame id this frame's timed sample is reported under
    // The main, aux and velocity bundles' inputs, built while the draws' stores were live; and each shadow pass's.
    std::vector<uint64_t> bundleKey, auxKey, velocityKey;
    std::vector<uint32_t> bundleRows;  // where each main draw's key row starts (Renderer::recordCause)
    // PRD-754: the main pass as retained rows (state order, then transparent draws), and three's Info for its visible draws.
    std::vector<uint64_t> viewportKey;  // the draws after the viewport copy, empty when none
    std::size_t tail = 0;               // the first draw after the main rows: the first transparent draw, or the copy
    std::vector<uint64_t> tailKey;      // the draws from there to the viewport copy
    PassRows mainRows, auxRows, velocityRows;
    std::vector<std::vector<uint64_t>> shadowKeys;
};


}  // namespace tn::engine
