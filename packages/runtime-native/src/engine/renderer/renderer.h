#pragma once

#include <chrono>
#include <functional>
#include <array>
#include <map>
#include <cstdint>
#include <optional>
#include <span>
#include <string>
#include <unordered_map>
#include <memory>
#include <tuple>
#include <vector>

#include <webgpu/webgpu.h>

#include "engine/foundation/buffers.h"
#include "engine/scene/geometry.h"
#include "engine/renderer/geometry_cache.h"
#include "engine/renderer/gpu_resources.h"
#include "engine/renderer/pipeline_cache.h"
#include "engine/renderer/probes/volume.h"
#include "engine/renderer/shadows/virtual/atlas.h"
#include "engine/shader/output.h"
#include "engine/shader/package.h"
#include "engine/shader/standard.h"

namespace tn::engine {

using Matrix = std::array<double, 16>;  // column-major, as three's Matrix4.elements

class SkinnedMesh;
class TraaPass;
class PostEffects;
struct TraaOptions;
class Fog;
class Texture;  // the material's diffuse `map` (engine/scene/texture.h)

/** Which program a draw uses; each kind reads the StandardMaterial fields it needs. */
enum class MaterialKind : uint8_t { Standard, Basic, Lambert, Phong, Physical };

/** A material graph's texture(object, uv) reads: the binding name ("nodeMap<id>") and the texture. */
using GraphTextures = std::vector<std::pair<std::string, const Texture*>>;

/**
 * Per-draw resolved GPU state, reused by the renderer while the draw's program variant and pipeline
 * target are unchanged. The render database owns one per record (a record rebuild clears it), and
 * DrawItem::cache points at it; a synthesized (batched) draw carries none and resolves afresh. The
 * fields the renderer compares are the same inputs three keys its program cache on. The handle fields
 * are the renderer's opaque types (Program*, WGPURenderPipeline, WGPUBindGroup).
 */
struct DrawCache {
    MaterialKind kind = MaterialKind::Standard;
    shader::VertexVariant variant;
    uint64_t lightsKey = 0;       // the light layout and receiveShadow the program was resolved for
    uint64_t targetKey = 0;       // the pipeline target inputs (side, blend, front face, ...)
    uint64_t depthTargetKey = 0;  // the shadow-pass pipeline target inputs
    uint64_t mapGroupKey = 0;     // the textures/epoch the fragment bind group was built for
    void* program = nullptr;
    void* depthProgram = nullptr;
    void* pipeline = nullptr;
    void* depthPipeline = nullptr;
    void* mapGroup = nullptr;
};

/** One opaque draw. The render database (PRD-514 phase 1) fills these from the scene graph. */
struct DrawItem {
    uint32_t layers = 1;
    bool mainPass = true;
    bool background = false;
    const Fog* fog = nullptr;
    Matrix backgroundRotation{};
    uint64_t key = 0;                    // the renderable's stable identity; its GPU record persists under it
    BufferStore* positions = nullptr;    // vec3 float
    BufferStore* normals = nullptr;      // vec3 float; unused by Basic
    BufferStore* uvs = nullptr;          // vec2 float; only a mapped material's program reads it
    /** material.polygonOffset's depth bias (units) and slope scale (factor), zero without it. */
    int32_t depthBias = 0;
    float depthBiasSlopeScale = 0;
    /** The geometry's other attributes (TSL attribute(name) reads them), float, and whether each is an
     *  InstancedBufferAttribute read once per instance. */
    struct CustomAttribute {
        std::string name;
        BufferStore* store = nullptr;
        bool perInstance = false;
    };
    std::vector<CustomAttribute> attributes;
    BufferStore* colors = nullptr;       // material.vertexColors: the `color` attribute as float32
    uint8_t colorSize = 0;               // its item size, 3 or 4; 0 without vertex colours
    BufferStore* indices = nullptr;      // u16 or u32; null draws non-indexed
    Matrix matrixWorld{};
    // A merged draw retains its first member's render-list origin when its model becomes identity.
    std::optional<std::array<double, 3>> sortOrigin;
    const shader::StandardMaterial* material = nullptr;
    /** The material's diffuse `map`, if any: the fragment samples it at `uvTransform * vec3(uv, 1)`. */
    const Texture* map = nullptr;
    /** A tangent-space normalMap (decoded image, uv present) and the material's normalScale. */
    const Texture* normalMap = nullptr;
    double normalScaleX = 1, normalScaleY = 1;
    /** MeshStandardMaterial's roughnessMap, metalnessMap, aoMap and emissiveMap, and MeshPhysicalMaterial's
     *  specularColorMap, specularIntensityMap and clearcoat maps, by shader::PbrMap (decoded image, uv present). */
    std::array<const Texture*, shader::kPbrMapCount> pbrMaps{};
    double aoMapIntensity = 1;
    /** The environment (scene.environment or material.envMap): its PMREM is sampled for IBL. */
    const Texture* envMap = nullptr;
    double envMapIntensity = 1;
    Matrix envRotation{1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1};
    /** A node graph's pmremTexture source: prefiltered as an environment is, sampled as "pmrem". */
    const Texture* pmremMap = nullptr;
    /** A node graph's texture(object) samples, by binding name (`t_<name>`, either stage); null when it has none. */
    const GraphTextures* nodeTextures = nullptr;
    /** A node graph's storage(attribute) reads, by storage buffer name; null when it has none. */
    const std::vector<std::pair<std::string, const BufferAttribute*>>* nodeStorages = nullptr;
    Matrix pmremRotation{1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1};  // three's materialEnvRotation
    /** A node graph's reflector (an engine::Reflector) and the view of its mirrored pass, sampled as "reflector". */
    const void* reflector = nullptr;
    WGPUTextureView reflectorView = nullptr;
    WGPUSampler reflectorSampler = nullptr;
    MaterialKind kind = MaterialKind::Standard;
    /** three's Line (LineStrip) and LineSegments (LineList) draw lines; everything else triangles. */
    WGPUPrimitiveTopology topology = WGPUPrimitiveTopology_TriangleList;
    // Render-list inputs, as three's RenderList reads them.
    uint64_t id = 0;           // Object3D.id: the sort's last tiebreak
    int renderOrder = 0;       // Object3D.renderOrder
    bool transparent = false;  // material.transparent: drawn after opaques, back to front, blended
    bool forceSinglePass = false;  // material.forceSinglePass: a transparent DoubleSide draws once
    bool depthWrite = true;    // material.depthWrite
    // SkinnedMesh: the skin attributes, the skeleton's palette this frame and the bind matrices.
    BufferStore* skinIndices = nullptr; // u8, u16 or u32 ×4
    BufferStore* skinWeights = nullptr; // f32 ×4
    // Morph targets: the geometry (its morphPositions/morphNormals) and the mesh's influences.
    const BufferGeometry* morphGeometry = nullptr;
    const std::vector<double>* morphInfluences = nullptr;
    const std::vector<float>* boneMatrices = nullptr;
    Matrix bindMatrix{}, bindMatrixInverse{};
    SkinnedMesh* skinnedRig = nullptr; // authored rig, for projection eligibility and palette writes
    uint32_t boneStride = 0;           // palette matrices per instance; zero on exact skinned draws
    /** three's flipSided: mirrored authored meshes reverse the front-face winding. */
    [[nodiscard]] WGPUFrontFace frontFace() const {
        Matrix4 world;
        world.elements = matrixWorld;
        return world.determinant() < 0 ? WGPUFrontFace_CW : WGPUFrontFace_CCW;
    }
    bool castShadow = false;    // Object3D.castShadow: drawn into every shadow map
    bool receiveShadow = false; // Object3D.receiveShadow: its lit program reads the shadow maps
    uint8_t side = 0;           // material.side: 0 FrontSide, 1 BackSide, 2 DoubleSide
    uint8_t blending = 1;       // material.blending: 0 NoBlending, 1 NormalBlending, 2 AdditiveBlending
    // InstancedMesh: one mat4 (16 floats) per instance, an optional rgb per instance, and how many draw.
    BufferStore* instanceMatrices = nullptr;
    BufferStore* instanceColors = nullptr;
    uint32_t instanceCount = 1;
    bool sprite = false, spriteSizeAttenuation = true;
    std::array<double, 2> spriteCenter{0.5, 0.5};
    double spriteRotation = 0;
    // Automatic batching (RenderDatabase): which material it draws, and whether it may share a draw.
    const void* materialKey = nullptr;
    bool batchable = false;
    shader::MaterialNodes nodes;
    std::shared_ptr<const shader::PositionNode> positionNode;  // the material's; null keeps positionLocal
    /** The record's resolved-state cache, or null for a synthesized draw (the renderer then resolves afresh). */
    DrawCache* cache = nullptr;
};

struct CameraState {
    Matrix matrixWorldInverse{};
    // The camera's own world matrix: three transforms a view-space reflection direction by it
    // (cameraWorldMatrix) for environment radiance.
    Matrix matrixWorld{};
    // In three's WebGPUCoordinateSystem (clip z 0..1): WebGPURenderer.render switches a camera to it
    // and recomputes projectionMatrix, so the render database does the same before it fills this.
    Matrix projectionMatrix{};
    /** The camera's near and far planes (TSL's cameraNear / cameraFar). */
    double near = 0.1, far = 2000;
};

/** One direct light, world space and linear colour with its intensity folded in. */
struct DirectLight {
    enum class Kind : uint8_t { Directional, Point, Spot };
    Kind kind = Kind::Directional;
    std::array<double, 3> color{0, 0, 0};
    std::array<double, 3> direction{0, 1, 0}; // directional: towards the light; spot: target to light
    std::array<double, 3> position{0, 0, 0};  // point and spot
    double distance = 0, decay = 2;           // point and spot: the cutoff (0 none) and the falloff exponent
    double coneCos = 0, penumbraCos = 0;      // spot: cos(angle) and cos(angle * (1 - penumbra))
    /**
     * Set when the light casts a shadow and the shadow map is on (three's LightShadow after
     * updateMatrices): the shadow camera's view and projection draw the depth map, and `matrix` takes a
     * world position to the map's uv and depth.
     */
    struct Shadow {
        Matrix view{}, projection{}, matrix{};
        double bias = 0, normalBias = 0, radius = 1, intensity = 1;
        uint32_t width = 512, height = 512;
        // A point light's: a cube map, one view per face (PointShadowNode's WebGPU face order), and
        // the camera's near and far, which turn a distance into the stored depth.
        bool cube = false;
        std::array<Matrix, 6> faceViews{};
        double near = 0, far = 0;
        uint32_t layersMask = 1;
    };
    std::optional<Shadow> shadow;
    static DirectLight directional(std::array<double, 3> towards, std::array<double, 3> color) {
        DirectLight l;
        l.direction = towards;
        l.color = color;
        return l;
    }
};

/** Light values in world space and linear colour, intensity folded in (three's physically correct units). */
struct LightState {
    std::vector<DirectLight> direct; // three's LightsNode order: by Object3D id
    std::array<double, 3> hemisphereSky{0, 0, 0};
    std::array<double, 3> hemisphereGround{0, 0, 0};
    std::array<double, 3> hemisphereUp{0, 1, 0};
    std::array<double, 3> ambient{0, 0, 0};
    /** three's `renderer.shadowMap.type` is PCFSoftShadowMap: directional and spot maps read with
     *  PCFSoftShadowFilter; otherwise PCFShadowMap's filter. Point lights read PointShadowFilter either way. */
    bool softShadows = false;
};

/** three's renderer output settings: `toneMapping`, `toneMappingExposure`, `outputColorSpace`. */
struct OutputState {
    std::optional<shader::ToneMapping> toneMapping;  // empty: NoToneMapping
    double toneMappingExposure = 1;
    bool srgb = true;  // false: LinearSRGBColorSpace
};

/**
 * three's renderer settings by their JS values: the `toneMapping` constant, `toneMappingExposure` and
 * `outputColorSpace`. Returns the OutputState, or empty with `refusal` naming the value the renderer
 * does not implement; a value is never mapped to a neighbour. Shared by the V8 player and the web host.
 */
std::optional<OutputState> outputStateOf(double toneMapping, double exposure, const std::string& colorSpace,
                                         std::string& refusal);

/**
 * The native renderer's draw core (PRD-514): standard-material meshes into a linear RGBA16Float
 * scene target with depth, then three's output pass — tone mapping, then the output colour space —
 * into the RGBA8 frame, at the size the caller sets. The clear colour is linear and goes through the
 * output pass too, as three's background does. GPU records — geometry copies, pipelines, uniform buffers
 * and bind groups — persist across frames; a frame only rewrites uniforms and records commands.
 */
class Renderer {
public:
    Renderer(WGPUInstance instance, WGPUDevice device, WGPUQueue queue, EventQueue& events);
    ~Renderer();
    Renderer(const Renderer&) = delete;
    Renderer& operator=(const Renderer&) = delete;

    /**
     * A storage buffer a positionNode reads, bound by its name (`storage("positions", ...)` in the
     * graph): e.g. the positions a compute pass wrote. It stays bound until set again.
     */
    void setStorage(const std::string& name, Handle buffer, uint64_t bytes) { externalStorage_[name] = {buffer, bytes}; }

    // VirtualShadowNode's explicit depth, fixed refresh/gate path. Unsupported policies are
    // named at this boundary rather than silently selected by a light's ordinary shadow.
    /** ProbeVolume's seven padded SH sub-volumes, bound by the sampling node's name. */
    void setProbeVolume(const std::string& name, const probes::ProbeVolume& volume, bool capture = false);
    /** Linear HDR capture before post/tone mapping; tightly packed RGBA16Float bytes. */
    GpuStatus readProbePixels(ReadbackCallback done);
    /** The post normal target (RGBA16Float, packed rows); InvalidHandle until a post pass has read "normal". */
    GpuStatus readNormalPixels(ReadbackCallback done);
    /** Textures the renderer holds GPU copies of (a destroyed Texture's are released at the next frame). */
    std::size_t materialTextureCount() const { return textures_->records.size(); }
    /** What the last frame refused or skipped by name; cleared at the start of each frame. */
    const std::vector<std::string>& diagnostics() const { return diagnostics_; }
    /** Separate capture targets: probe work never resizes the presented frame or its post history. */
    Renderer& probeCaptureRenderer();
    /** Another renderer on this device, with its own targets: a reflection pass draws into one. */
    /** A renderer on the same device for a render target or a reflection: it shares this one's map textures. */
    std::unique_ptr<Renderer> sibling() {
        auto child = std::make_unique<Renderer>(instance_, device_, queue_, events_);
        child->textures_ = textures_;
        child->gpu_.shareSubmissions(gpu_);
        child->geometry_ = geometry_;
        return child;
    }
    /** The last render's linear HDR scene target (RGBA16Float), before post and the output transform. */
    WGPUTextureView sceneColorView() const { return sceneView_; }
    /** Linear filtering, clamped to the edge: three's RenderTarget texture defaults. */
    WGPUSampler linearClampSampler();
    void setVirtualShadow(std::size_t light, const shadows::AtlasOptions& options);
    void cutVirtualShadows() { virtualCut_ = true; }
    void setOutput(const OutputState& output);
    /** A post pass between the scene and the output transform; null draws the scene straight out. */
    void setPostNode(std::shared_ptr<const shader::PostNode> post);
    void setPostGraph(shader::graph::Node root);
    /** A render-graph normal/history input supplied by its native producer; borrowed view. */
    void setPostInput(const std::string& name, WGPUTextureView view);
    void setTraa(const TraaOptions& options);
    TraaPass* traaDebugPass() const { return traa_.get(); }
    void cutHistory();
    const OutputState& output() const { return output_; }

    /** Reallocates the targets; the next render draws at the new extent. Zero sizes clamp to 1. */
    void setSize(uint32_t width, uint32_t height);
    void setSampleCount(uint32_t samples);
    uint32_t sampleCount() const { return sampleCount_; }
    uint32_t width() const { return width_; }
    uint32_t height() const { return height_; }

    /** The submission order, shared with batching so palette slots follow the exact draws. */
    static std::vector<std::pair<double, const DrawItem*>> sortDraws(std::span<const DrawItem> items,
                                                                  const CameraState& camera);

    /**
     * Draws one frame and returns its render ID (every render call gets its own, from 1). Items are
     * drawn in three's order: opaque by renderOrder, then depth front to back, then id; transparent
     * after them by renderOrder, then depth back to front, then id.
     */
    uint64_t render(std::span<const DrawItem> items, const CameraState& camera, const LightState& lights,
                    std::array<double, 4> clear = {0, 0, 0, 0});
    /** Pipeline preparation only: shares render's planning, submits no frame. */
    std::vector<std::shared_ptr<PipelineCompilation>> compileAsync(std::span<const DrawItem> items,
        const CameraState& camera, const LightState& lights, WGPUTextureFormat outputFormat = WGPUTextureFormat_RGBA8Unorm);
    /**
     * Draws the last render() output into `target` and submits it, so a windowed player puts the
     * very same frame on the screen the render database just built. `format` is the target view's
     * format. Returns false when the program for it is refused; the frame stays readable either way.
     */
    bool blitTo(WGPUQueue queue, WGPUTextureView target, WGPUTextureFormat format);
    /**
     * PRD-554: a UI overlay's newest frame, premultiplied 8-bit rows from the top (`bgra` for a desktop
     * web view's B,G,R,A; `stride` bytes per row, 0 for tight), which blitTo draws "over" the frame,
     * stretched to the target. `version` names the pixels: the same version uploads nothing, so a
     * steady UI costs one draw and no copy. A null `pixels` removes the overlay.
     */
    void setOverlay(const uint8_t* pixels, uint32_t width, uint32_t height, uint64_t version, uint32_t stride = 0,
                    bool bgra = false);
    /** How many overlay frames setOverlay uploaded: a steady UI adds none. */
    uint64_t overlayUploads() const { return overlayUploads_; }
    /** Bytes of map pixels written from the CPU by this renderer and its siblings: level 0 only, the GPU builds the mips. */
    uint64_t textureUploadBytes() const { return textures_->uploadBytes; }
    /** Upload through the draw path now, including submission of generated mipmaps. */
    void initTexture(const Texture& texture);
    /**
     * How the host copies its decoded image (Texture::external) into level 0 of `texture`, flipped
     * when `flipY`: the web host's copyExternalImageToTexture. Returns false when it cannot.
     */
    using ExternalImageCopy = std::function<bool(uint32_t image, WGPUTexture texture, bool flipY)>;
    void setExternalImageCopy(ExternalImageCopy copy) { textures_->copyExternal = std::move(copy); }
    /**
     * The next render() draws its output pass straight into `target`, a view of `format`, in place
     * of the intermediate RGBA8 frame and the blitTo that copies it: a presented frame costs one
     * pass, one encoder and one submission fewer. The pixels are the same bytes. That frame is not
     * kept, so readPixels() still answers the one before; a caller that reads frames back uses
     * blitTo. `target` is borrowed for that one render() call and must outlive it.
     */
    void presentNext(WGPUTextureView target, WGPUTextureFormat format) {
        presentTarget_ = target;
        presentFormat_ = format;
    }
    /** Disarms presentNext(); a no-op once render() has taken the view. */
    void cancelPresent() { presentTarget_ = nullptr; }
    /**
     * presentNext() for the lifetime of a scope: whatever happens between arming and render() (a
     * throw while the scene is prepared, an early return), the borrowed view is disarmed on exit,
     * so no later frame draws into a view its owner has released.
     */
    class PresentScope {
    public:
        PresentScope(Renderer& renderer, WGPUTextureView target, WGPUTextureFormat format) : renderer_(renderer) {
            renderer_.presentNext(target, format);
        }
        ~PresentScope() { renderer_.cancelPresent(); }
        PresentScope(const PresentScope&) = delete;
        PresentScope& operator=(const PresentScope&) = delete;
    private:
        Renderer& renderer_;
    };
    /** The last frame's pixels, RGBA8 rows tightly packed, delivered from poll(). */
    GpuStatus readPixels(ReadbackCallback done);
    /** The last frame as presented, the UI overlay drawn over it (PRD-554), read back: what a player sees. */
    GpuStatus readPresented(ReadbackCallback done);
    void poll() { gpu_.poll(); }
    EventQueue& events() { return events_; }

    /** What the last render() submitted, as three's renderer.info.render counts it. */
    struct FrameStats {
        uint32_t draws = 0;
        uint64_t triangles = 0;
        uint32_t shadowDraws = 0;
        struct SkinnedPass {
            uint32_t batches = 0, draws = 0, exactDraws = 0, instances = 0;
        };
        SkinnedPass mainSkinned, shadowSkinned;
    };
    const FrameStats& lastFrame() const { return lastFrame_; }
    /**
     * GPU time of the most recent frame whose timestamps came back, first shadow pass (else scene
     * pass) start to output pass end, in milliseconds; negative until one has, and always on a device without timestamp-query.
     */
    double lastGpuMs() const { return timing_->lastMs; }
    /**
     * Whether frames are timed on the GPU: off by default, since a timed frame resolves its query
     * set and reads it back, a cost every frame pays and only a caller of lastGpuMs wants.
     */
    void setGpuTimer(bool on) { gpuTimer_ = on; }
    /**
     * The last timed frame's GPU time by segment, in ms: shadow passes (0 when the frame drew none),
     * scene pass, everything between the scene and output passes (post, TRAA), output pass.
     */
    std::array<double, 4> lastGpuSegments() const { return timing_->segments; }
    /** How many GPU times have come back, so a caller samples each one once. */
    uint64_t gpuSamples() const { return timing_->samples; }
    /** Whether the last timed frame's GPU time began at its first shadow pass (else at the scene pass). */
    bool gpuTimerBeganAtShadow() const { return timerBeganAtShadow_; }

    /** Every built program's vertex WGSL by program key: what a test reads to see how the frame's programs were compiled. */
    std::vector<std::pair<std::string, std::string>> programVertexSources() const {
        std::vector<std::pair<std::string, std::string>> out;
        for (const auto& [key, program] : programs_)
            if (program) out.emplace_back(key, program->vertex.wgsl.code);
        return out;
    }
    GpuResources& gpu() { return gpu_; }
    const GeometryCache& geometry() const { return geometry_->cache; }
    const PipelineCache& pipelines() const { return pipelines_; }
    /** Material programs built or refused so far; a steady frame adds none. */
    size_t programCount() const { return programs_.size(); }
    /** Program key strings built and Program* lookups done so far; a steady frame adds none. */
    uint64_t programKeyBuilds() const { return programKeyBuilds_; }
    uint64_t programLookups() const { return programLookups_; }
    /** GPU samplers created so far and the distinct sampler descriptors they are deduplicated to. */
    uint64_t samplersCreated() const { return samplersCreated_; }
    size_t samplerCount() const { return textures_->samplers.size(); }

private:
    // The uniforms a material program may read, resolved to block offsets once per program.
    enum Slot : uint8_t {
        kModelMatrix, kViewMatrix, kProjectionMatrix, kNormalMatrix, kDiffuse, kAlphaTest, kOpaque, kRoughness,
        kMetalness, kEmissive, kSpecular, kShininess, kIor, kSpecularIntensity, kSpecularColor,
        kUvTransform, kHemisphereSky, kHemisphereGround, kHemisphereDirection, kAmbient, kBoneBase, kBindMatrix,
        kBindMatrixInverse, kMorphBase, kMorphInfluenceBase, kMorphVertexCount, kMorphBaseInfluence,
        kEnvMapIntensity, kCameraWorldMatrix, kEnvMapTexelWidth, kEnvMapTexelHeight, kEnvMapMaxMip, kBoneStride, kFogColor, kFogNear, kFogFar, kFogDensity, kBackgroundRotation, kEnvRotation, kInstanceBase, kNormalScale, kNormalUvTransform, kCameraPosition, kCameraProjectionMatrix,
        kRoughnessMapUvTransform, kMetalnessMapUvTransform, kAoMapUvTransform, kEmissiveMapUvTransform,
        kBumpMapUvTransform, kSpecularColorMapUvTransform,
        kSpecularIntensityMapUvTransform, kClearcoatMapUvTransform, kClearcoatRoughnessMapUvTransform,
        kClearcoatNormalMapUvTransform, kAoMapIntensity, kClearcoat, kClearcoatRoughness, kClearcoatNormalScale, kBumpScale,
        kPmremTexelWidth, kPmremTexelHeight, kPmremMaxMip, kPmremRotation, kScreenSize, kCameraNear, kCameraFar,
        kModelNormalMatrix, kSlotCount
    };
    // Per direct light i, `light{i}<Field>` (shader::LightLayout).
    enum LightField : uint8_t { kLightColor, kLightDirection, kLightPosition, kLightDistance, kLightDecay, kLightAxis,
                                kLightConeCos, kLightPenumbraCos, kLightShadowMatrix, kLightShadowBias,
                                kLightShadowNormalBias, kLightShadowRadius, kLightShadowMapSize,
                                kLightShadowIntensity, kLightShadowNear, kLightShadowFar, kLightFieldCount };
    uint64_t renderPrepared(std::span<const DrawItem> items, const CameraState& camera, const LightState& lights,
        std::array<double, 4> clear, std::vector<std::shared_ptr<PipelineCompilation>>* compilation,
        WGPUTextureFormat outputFormat);
    struct Program {
        shader::StageModule vertex;
        shader::StageModule fragment;
        // Explicit layouts: each stage's uniform block is a dynamic-offset slice of the frame's one
        // uniform buffer, so a draw costs a bind-group offset, not a buffer and a bind group of its own.
        WGPUBindGroupLayout layouts[2] = {};
        WGPUPipelineLayout pipelineLayout = nullptr;
        WGPUBindGroup groups[2] = {};  // over the current frame buffer; rebuilt when it grows
        const shader::UniformField* vertexSlots[kSlotCount] = {};
        const shader::UniformField* fragmentSlots[kSlotCount] = {};
        std::vector<std::array<const shader::UniformField*, kLightFieldCount>> lightSlots;
    };
    void buildLayouts(Program& program);
    /** The program for a material kind, vertex variant and light layout, built on first use; null
     *  when its WGSL is invalid, which is reported once in diagnostics() and its draws are skipped,
     *  as three logs a shader error and draws the rest of the scene. */
    Program* program(MaterialKind kind, const shader::VertexVariant& variant, const std::string& lights,
                     bool softShadows = false);
    /** The shadow pass's depth-only program for a vertex variant (0 plain, 1 instanced). */
    Program& depthProgram(const shader::VertexVariant& variant);
    Program& add(const std::string& key, shader::StageModule vertex, shader::StageModule fragment);
    struct MaterialTexture;
    /** blitTo's pass-through copy into `format`, blended by PipelineTarget's `blend`. */
    WGPURenderPipeline copyPipeline(WGPUTextureFormat format, uint8_t blend,
        std::vector<std::shared_ptr<PipelineCompilation>>* compilation = nullptr);
    /** Records a texture's mip chain into the pending mip encoder; `submit` flushes it first. */
    void generateMipmaps(WGPUTexture texture, WGPUTextureFormat format, uint32_t levels);
    /** Submits the mip passes of every texture uploaded since the last submit, as one command buffer. */
    void flushMipmaps();
    /** Every frame, readback and pass submit goes through here so a sampled texture's mips exist first. */
    void submit(WGPUCommandBuffer commands);
    WGPUBindGroup bindGroup(WGPUBindGroupLayout layout, const shader::StageModule& stage, Handle uniforms,
                            WGPUTextureView view, WGPUSampler sampler,
                            WGPUTextureView mapView = nullptr, WGPUSampler mapSampler = nullptr,
                            WGPUTextureView envView = nullptr, WGPUSampler envSampler = nullptr,
                            WGPUTextureView normalView = nullptr, WGPUSampler normalSampler = nullptr,
                            const std::array<const MaterialTexture*, shader::kPbrMapCount>* pbrMaps = nullptr,
                            WGPUTextureView pmremView = nullptr, WGPUSampler pmremSampler = nullptr,
                            WGPUTextureView reflectorView = nullptr, WGPUSampler reflectorSampler = nullptr,
                            const GraphTextures* graphTextures = nullptr);
    /** The GPU texture and sampler for a material map, (re)built when the texture's version moves. */
    struct MaterialTexture {
        WGPUTexture texture = nullptr;
        WGPUTextureView view = nullptr;
        WGPUSampler sampler = nullptr;
        uint32_t version = 0;
        void release();
    };
    const MaterialTexture* materialTexture(const Texture& texture);
    // Render-target textures by texture id: views borrowed from each target's renderer, never released here.
    std::unordered_map<uint64_t, MaterialTexture> renderTargetTextures_;
    struct BackgroundCube {
        WGPUTexture texture = nullptr;
        WGPUTextureView view = nullptr;
        WGPUSampler sampler = nullptr;
        uint32_t version = 0;
    };
    BackgroundCube& backgroundCube(const Texture& texture);
    std::map<uint64_t, BackgroundCube> backgroundCubes_;  // by Texture::ident
    void releaseMaterialTextures();
    /** Releases what the caches built for textures that no longer exist. */
    void sweepTextures();
    void dropMapGroups();
    /**
     * The PMREM cubeUV form of an equirectangular (or PMREM) environment, built on first use and
     * rebuilt when the source texture's version moves (three's PMREMGenerator.fromEquirectangular).
     */
    struct EnvironmentGpu {
        const Texture* source = nullptr;
        uint32_t version = 0;
        WGPUTexture texture = nullptr;   // the cubeUV render target, sampled by the material
        WGPUTextureView view = nullptr;
        WGPUTexture pingpong = nullptr;
        WGPUTextureView pingView = nullptr;
        WGPUSampler sampler = nullptr;
        uint32_t width = 0, height = 0, cubeSize = 0;
        uint32_t lodMax = 0, lods = 0;
        float texelWidth = 0, texelHeight = 0, maxMip = 0;
    };
    EnvironmentGpu& environment(const Texture& equirect);
    void buildEnvironmentPipelines();
    void releaseEnvironments();
    void rebuildGroups();
    void releaseTargets();
    void resolveDepth(WGPUCommandEncoder encoder);  // 4x: depth_ takes sample 0 of msaaDepth_
    GpuStatus readRgba16(WGPUTexture texture, ReadbackCallback done);
    void releaseOutputGroup();
    void outputPass(WGPUCommandEncoder encoder, bool timed, WGPUTextureView present, WGPUTextureFormat presentFormat);

    WGPUInstance instance_;
    std::unique_ptr<Renderer> probeCapture_;
    WGPUDevice device_;
    WGPUQueue queue_;
    // Mip passes recorded since the last submit: one encoder for every texture uploaded in between,
    // with the views and bind groups its passes hold until the buffer is finished.
    WGPUCommandEncoder mipEncoder_ = nullptr;
    std::vector<WGPUTextureView> mipViews_;
    std::vector<WGPUBindGroup> mipGroups_;
    EventQueue& events_;
    GpuResources gpu_;
    // Attribute copies, shared with every sibling() as three's one renderer keeps one copy for every
    // pass that draws it; their handles live in this table, never in gpu_ (PRD-553).
    static constexpr uint16_t kGeometryHandles = 2;
    struct GeometryCopies {
        GeometryCopies(WGPUInstance instance, WGPUDevice device, WGPUQueue queue, EventQueue& events)
            : gpu(instance, device, queue, events, kGeometryHandles), cache(gpu) {}
        GpuResources gpu;
        GeometryCache cache;
    };
    std::shared_ptr<GeometryCopies> geometry_;
    PipelineCache pipelines_;
    // By MaterialKind, vertex variant (0 plain, 1 instanced, 2 instanced with instanceColor) and light
    // layout; held by pointer so a frame's plan keeps its addresses while new programs are added.
    std::map<std::string, std::unique_ptr<Program>> programs_;  // a null entry: refused, never retried
    std::map<std::string, std::string> refusedPrograms_;          // why, reported each frame it skips draws
    uint64_t programKeyBuilds_ = 0, programLookups_ = 0, samplersCreated_ = 0;
    // Moves whenever the per-draw bind groups (mapGroups_) are released, so a DrawCache's group
    // handles built under an older epoch are never reused.
    uint64_t groupEpoch_ = 0;
    WGPUTexture lut_ = nullptr;
    WGPUTextureView lutView_ = nullptr;
    WGPUSampler lutSampler_ = nullptr;
    // Shadow maps by direct-light index (Depth24Plus, three's DepthTexture of UnsignedIntType), and
    // the less-equal comparison sampler with linear filtering PCFShadowMap samples them with.
    struct ShadowMap {
        WGPUTexture texture = nullptr;
        WGPUTextureView view = nullptr;      // sampled: 2D, or a cube for a point light
        WGPUTextureView faces[6] = {};       // a cube's faces, each drawn as a 2D depth target
        uint32_t width = 0, height = 0;
        bool cube = false;
    };
    // 2D maps and cube maps in separate slots, so a program built while light i was a directional
    // light still binds a 2D map after light i becomes a point light.
    std::vector<ShadowMap> shadowMaps_, cubeShadowMaps_;
    bool shadowMapsChanged_ = false;  // compilation changes survive until a real frame rebuilds groups
    struct VirtualShadow {
        shadows::PageAtlas atlas;
        ShadowMap map;
        std::map<uint64_t, Box3> casters;
        std::map<uint64_t, std::string> casterPrograms;
    };
    std::map<std::size_t, VirtualShadow> virtualShadows_;
    bool virtualCut_ = false;
    WGPUSampler compareSampler_ = nullptr;
    // The viewport textures (three's viewportSharedTexture / viewportDepthTexture): the scene colour
    // and depth copied at the first draw that reads either, created with the scene target.
    WGPUTexture viewportColor_ = nullptr, viewportDepth_ = nullptr;
    WGPUTextureView viewportColorView_ = nullptr, viewportDepthView_ = nullptr;
    WGPUSampler linearClampSampler_ = nullptr;
    Handle color_;
    Handle overlay_;  // setOverlay's texture, recreated when the page's size changes
    WGPUTextureView overlayView_ = nullptr;
    uint32_t overlayWidth_ = 0, overlayHeight_ = 0;
    uint64_t overlayVersion_ = 0, overlayUploads_ = 0;
    // Map textures, shared with every sibling(), as three's one renderer serves every render target.
    struct MaterialTextureStore {
        std::unordered_map<uint64_t, MaterialTexture> records;  // by Texture::ident, never an address
        std::map<std::string, WGPUSampler> samplers;  // deduplicated by full descriptor, shared with siblings
        uint64_t generation = 0;  // moves when a record's view is replaced or released
        uint64_t uploadBytes = 0;
        ExternalImageCopy copyExternal;
        ~MaterialTextureStore();
    };
    std::shared_ptr<MaterialTextureStore> textures_ = std::make_shared<MaterialTextureStore>();
    uint64_t texturesSeen_ = 0;
    /**
     * The GPU sampler for a full descriptor, created once and shared: three's one sampler per
     * descriptor instead of one per texture. The store owns every sampler it hands out.
     */
    WGPUSampler samplerFor(const WGPUSamplerDescriptor& descriptor);
    /** A shared map texture's view went away: drop the groups bound to views, here and (by generation) in siblings. */
    void texturesChanged();
    bool overlayBgra_ = false;
    std::vector<uint8_t> overlayRows_;  // a padded frame's rows, packed for the upload
    Handle presented_;  // readPresented's RGBA8 copy of the presented frame
    WGPUTextureView presentedView_ = nullptr;
    uint32_t presentedWidth_ = 0, presentedHeight_ = 0;
    WGPUTexture depth_ = nullptr;
    WGPUTextureView colorView_ = nullptr;
    WGPUTextureView depthView_ = nullptr;
    WGPUTexture sceneColor_ = nullptr;  // linear HDR, what materials draw into
    WGPUTextureView sceneView_ = nullptr;
    uint32_t sampleCount_ = 1;
    WGPUTexture msaaColor_ = nullptr;
    WGPUTextureView msaaColorView_ = nullptr;
    WGPUTexture msaaDepth_ = nullptr;
    WGPUTextureView msaaDepthView_ = nullptr;
    WGPURenderPipeline depthResolve_ = nullptr;  // built by the first 4x frame
    // View-space normals for post passes that read "normal" (three's MRT `normal: normalView`),
    // drawn after the main pass; created with the first such frame, released with the targets.
    WGPUTexture normalTexture_ = nullptr;
    WGPUTextureView normalView_ = nullptr;
    shader::StageModule normalFragment_;
    std::vector<std::string> diagnostics_;
    OutputState output_;
    std::shared_ptr<const shader::PostNode> post_;
    std::unique_ptr<TraaPass> traa_;
    std::unique_ptr<PostEffects> postEffects_;
    std::map<std::string, std::vector<float>> postUniforms_;
    /** three's `time` (its NodeFrame clock): seconds since this renderer was made, read once a frame. */
    std::chrono::steady_clock::time_point start_ = std::chrono::steady_clock::now();
    float frameTime_ = 0;
    shader::StageModule blitVertex_, blitFragment_;  // blitTo's pass-through copy
    shader::StageModule outputVertex_;
    shader::StageModule outputFragment_;
    Handle outputTriangle_;
    Handle outputUniforms_;
    WGPUSampler outputSampler_ = nullptr;
    WGPUBindGroup outputGroup_ = nullptr;
    WGPUBindGroupLayout outputLayout_ = nullptr;
    WGPUPipelineLayout outputPipelineLayout_ = nullptr;
    WGPUTextureView presentTarget_ = nullptr;  // presentNext: the output pass draws here, not into colorView_
    WGPUTextureFormat presentFormat_ = WGPUTextureFormat_Undefined;
    uint32_t width_ = 0;
    uint32_t height_ = 0;
    uint64_t renderId_ = 0;
    FrameStats lastFrame_;
    WGPURenderBundle mainBundle_ = nullptr;
    WGPURenderBundle viewportBundle_ = nullptr;  // the draws after a viewport-texture copy, else null
    std::vector<uint64_t> mainBundleKey_;
    FrameStats mainBundleStats_;
    bool timerBeganAtShadow_ = false;
    bool gpuTimer_ = false;
    WGPUQuerySet timestamps_ = nullptr;  // scene pass begin/end [0, 1], output pass begin/end [2, 3], first shadow pass begin [4, 5]
    Handle timestampResolve_;
    // Shared with the readback callback by weak reference: a backend may deliver it after this
    // renderer is gone (wgpu does at teardown), and it must then find nothing to write into.
    struct Timing {
        bool pending = false;  // a resolve is being read back; the next frames are not timed
        double lastMs = -1;
        std::array<double, 4> segments{};  // shadow passes, scene pass, post (between), output pass, in ms
        uint64_t samples = 0;
    };
    std::shared_ptr<Timing> timing_ = std::make_shared<Timing>();
    std::vector<uint8_t> frameUniforms_;  // every draw's uniform blocks, written to the GPU once a frame
    Handle uniformBuffer_;
    uint64_t uniformCapacity_ = 0;
    // Every skinned draw's bone palette this frame, one storage buffer the skinned programs index
    // from their `boneBase`; grown (and the bind groups rebuilt) like the uniform buffer.
    // Per-frame storage the vertex variants read, by binding name: `boneMatrices` (skinning),
    // `morphData` and `morphInfluences` (morph targets). Each starts at 64 bytes so a program always
    // has a buffer to bind, and grows (bind groups rebuilt) like the uniform buffer.
    struct FrameStorage {
        std::vector<float> data;
        Handle buffer;
        uint64_t capacity = 0;
    };
    struct ProbeTexture {
        WGPUTexture texture = nullptr;
        WGPUTextureView view = nullptr;
        WGPUSampler sampler = nullptr;
        WGPUExtent3D size{};
    };
    std::map<std::string, ProbeTexture> probeTextures_;
    std::map<std::string, FrameStorage> storages_;
    std::map<std::string, std::pair<Handle, uint64_t>> externalStorage_;  // setStorage, by name
    // A material's diffuse map: its GPU texture/sampler, and, per (program, texture), the bind group
    // that binds it alongside the frame's uniforms. Cleared when the uniform buffer is rebuilt.
    std::map<std::string, WGPUBindGroup> mapGroups_;
    // PMREM (three's PMREMGenerator.fromEquirectangular): the cubeUV tiles and the pipelines that
    // fill them, keyed by the equirect source texture.
    std::map<uint64_t, EnvironmentGpu> environments_;  // by Texture::ident
    WGPUBindGroupLayout envLayout_ = nullptr;
    WGPUPipelineLayout envPipelineLayout_ = nullptr;
    WGPURenderPipeline envEquirectPipeline_ = nullptr;
    WGPURenderPipeline envGgxPipeline_ = nullptr;
    Handle envVertex_{};      // per-LOD: 36 vertices, position vec3 + expandedUv vec2 + face f32
    uint64_t envVertexCapacity_ = 0;
    Handle envUniforms_{};    // one aligned slice per PMREM pass
    uint64_t envUniformCapacity_ = 0;
};

}  // namespace tn::engine
