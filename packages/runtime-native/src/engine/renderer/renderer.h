#pragma once

#include <chrono>
#include <stdexcept>
#include <functional>
#include <array>
#include <atomic>
#include <mutex>
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
#include "engine/renderer/compute.h"
#include "engine/renderer/frame_gpu_timer.h"
#include "engine/renderer/pipeline_cache.h"
#include "engine/renderer/probes/volume.h"
#include "engine/renderer/shadows/virtual/atlas.h"
#include "engine/shader/output.h"
#include "engine/shader/package.h"
#include "engine/shader/standard.h"

namespace tn::engine {

using Matrix = std::array<double, 16>;  // column-major, as three's Matrix4.elements

class SkinnedMesh;
class Bone;
class PerspectiveCamera;
struct GpuJointScene {
    struct Rig {
        std::weak_ptr<SkinnedMesh> mesh;
        std::weak_ptr<Object3D> placement;
        const void* skeleton = nullptr;
        const void* geometry = nullptr;
        const void* material = nullptr;
        Matrix bind{};
        uint32_t outputBase = 0;
        std::shared_ptr<BufferStore> instances;
    };
    uint64_t hierarchy = 0;
    std::shared_ptr<bool> valid = std::make_shared<bool>(true);
    std::shared_ptr<std::vector<float>> locals = std::make_shared<std::vector<float>>();
    std::vector<Rig> rigs;
    std::vector<uint8_t> drawUse; // Diagnostic-only, unioned across main, shadow and reflection passes.
    std::vector<std::weak_ptr<Bone>> bones;
    std::vector<JointComputeRig> topology;
    std::vector<uint32_t> parents;
    std::vector<std::array<float, 16>> fixed;
    std::unordered_map<const SkinnedMesh*, uint32_t> byMesh;
    void revoke();
    bool current() const;
};
class TraaPass;
class PostEffects;
struct TraaOptions;
class Fog;
class Texture;  // the material's diffuse `map` (engine/scene/texture.h)
class RetiredTextures;  // this renderer's subscription to texture retirements

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
    bool depthMasked = false;     // the depth program runs the material's alpha test (PRD-651)
    void* pipeline = nullptr;
    void* depthPipeline = nullptr;
    void* mapGroup = nullptr;
};

/** One opaque draw. The render database (PRD-514 phase 1) fills these from the scene graph. */
struct DrawItem {
    const Object3D* shadowObject = nullptr;
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
    bool colorWrite = true;    // material.colorWrite
    // SkinnedMesh: the skin attributes, the skeleton's palette this frame and the bind matrices.
    BufferStore* skinIndices = nullptr; // u8, u16 or u32 ×4
    BufferStore* skinWeights = nullptr; // f32 ×4
    // Morph targets: the geometry (its morphPositions/morphNormals) and the mesh's influences.
    const BufferGeometry* morphGeometry = nullptr;
    const std::vector<double>* morphInfluences = nullptr;
    const std::vector<float>* boneMatrices = nullptr;
    Matrix bindMatrix{}, bindMatrixInverse{};
    SkinnedMesh* skinnedRig = nullptr; // authored rig, for projection eligibility and palette writes
    std::shared_ptr<GpuJointScene> gpuJoints;
    uint32_t gpuJointRig = 0;
    std::vector<uint32_t> gpuJointRigs; // Batch instance order; singleton draws use gpuJointRig.
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
    uint8_t shadowSide = 255;   // material.shadowSide, the same codes; 255 is null
    bool flatShading = false;   // material.flatShading: the face normal replaces the vertex normal
    bool twoSidedFoliage = false;  // material.twoSidedFoliage: Unreal's Two Sided Foliage receiver (PRD-651)
    bool roughDiffuse = false;     // material.roughDiffuse: Unreal's Substrate rough diffuse, EON (PRD-653)
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
    uint64_t id = 0;
    enum class Kind : uint8_t { Directional, Point, Spot };
    Kind kind = Kind::Directional;
    std::array<double, 3> color{0, 0, 0};
    std::array<double, 3> direction{0, 1, 0}; // directional: towards the light; spot: target to light
    std::array<double, 3> position{0, 0, 0};  // point and spot
    double distance = 0, decay = 2;           // point and spot: the cutoff (0 none) and the falloff exponent
    double sourceRadius = 0;                  // point and spot: Unreal's Source Radius in metres (PRD-653)
    double coneCos = 0, penumbraCos = 0;      // spot: cos(angle) and cos(angle * (1 - penumbra))
    /**
     * Set when the light casts a shadow and the shadow map is on (three's LightShadow after
     * updateMatrices): the shadow camera's view and projection draw the depth map, and `matrix` takes a
     * world position to the map's uv and depth.
     */
    struct Shadow {
        std::shared_ptr<const shadows::AtlasOptions> virtualShadow;
        std::optional<std::array<double, 6>> sourceAngleFilter;  // as LightShadow's
        std::optional<std::array<double, 4>> sourceRadiusFilter;
        double tanHalfFov = 1;  // a perspective map's: a cube face's is 1
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
    const Matrix& shadowMatrix(uint64_t id) const {
        for (const auto& light : direct) if (light.id == id) {
            if (!light.shadow) throw std::runtime_error("TN_NATIVE_LIGHT_SHADOW_MISSING: " + std::to_string(id));
            return light.shadow->matrix;
        }
        throw std::runtime_error("TN_NATIVE_LIGHT_NOT_RENDERED: " + std::to_string(id));
    }
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
    shader::graph::Node customToneMapping;
};

/**
 * three's renderer settings by their JS values: the `toneMapping` constant, `toneMappingExposure` and
 * `outputColorSpace`. Returns the OutputState, or empty with `refusal` naming the value the renderer
 * does not implement; a value is never mapped to a neighbour. Shared by the V8 player and the web host.
 */
std::optional<OutputState> outputStateOf(double toneMapping, double exposure, const std::string& colorSpace,
                                         std::string& refusal, shader::graph::Node custom = {});

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

    /**
     * PRD-620: `Fn(...)().compute(n)` over storage(attribute) buffers. prepareCompute compiles the node's
     * pass (throwing TN_COMPUTE_* by name for a program it cannot hold); dispatchCompute submits one
     * dispatch with the uniform values it was queued with, ahead of every later submission; readStorage
     * copies the attribute's GPU buffer to the host (completing on a later drain); releaseStorage drops
     * the attribute's GPU copy, which the next use uploads again from its CPU contents.
     */
    void prepareCompute(const shader::graph::Node& node);
    void dispatchCompute(const ComputeDispatch& dispatch);
    GpuStatus readStorage(const BufferAttribute& attribute, ReadbackCallback done);
    void releaseStorage(const BufferAttribute& attribute);

    // Internal production admission: resources are validated before Bone boundaries become live.
    std::shared_ptr<GpuJointScene> prepareGpuJoints(Object3D& scene, std::shared_ptr<GpuJointScene> shared = {});
    std::shared_ptr<GpuJointScene> currentGpuJoints() const {
        return gpuJoints_ && gpuJoints_->current() ? gpuJoints_ : nullptr;
    }

    // VirtualShadowNode's explicit depth, fixed refresh/gate path. Unsupported policies are
    // named at this boundary rather than silently selected by a light's ordinary shadow.
    /** ProbeVolume's seven padded SH sub-volumes, bound by the sampling node's name. */
    void setProbeVolume(const std::string& name, const probes::ProbeVolume& volume, bool capture = false);
    /** Linear HDR capture before post/tone mapping; tightly packed RGBA16Float bytes. */
    GpuStatus readProbePixels(ReadbackCallback done);
    /** The post normal target (RGBA16Float, packed rows); InvalidHandle until a post pass has read "normal". */
    GpuStatus readNormalPixels(ReadbackCallback done);
    /** The post albedo target (RGBA16Float, packed rows); InvalidHandle until a post pass has read "albedo". */
    GpuStatus readAlbedoPixels(ReadbackCallback done);
    /** The emitted radiance (RGBA16Float); InvalidHandle until a post pass reads "emissive". */
    GpuStatus readEmissivePixels(ReadbackCallback done);
    /** Textures the renderer holds GPU copies of (a destroyed Texture's are released at the next frame). */
    std::size_t materialTextureCount() const { return textures_->records.size(); }
    /** What the last frame refused or skipped by name; cleared at the start of each frame. */
    const std::vector<std::string>& diagnostics() const { return diagnostics_; }
    /** The smallest and largest edge of the lamp maps the footprint sized, {0, 0} without one (PRD-650). */
    std::array<uint32_t, 2> lampShadowExtent() const {
        std::array<uint32_t, 2> extent{0, 0};
        for (const auto& [light, motion] : lampMotion_) {
            const uint32_t size = lampShadowSize(light);
            if (!size) continue;
            extent[0] = extent[0] ? std::min(extent[0], size) : size;
            extent[1] = std::max(extent[1], size);
        }
        return extent;
    }
    /** The edge of light `light`'s lamp map as last allocated, 0 without one (PRD-650). */
    uint32_t lampShadowSize(std::size_t light) const {
        for (const auto* maps : {&shadowMaps_, &cubeShadowMaps_})
            if (light < maps->size() && (*maps)[light].width) return (*maps)[light].width;
        return 0;
    }
    /** Separate capture targets: probe work never resizes the presented frame or its post history. */
    Renderer& probeCaptureRenderer();
    /** The face camera of a probe capture, shared so a render callback that keeps its handle is safe. The
     *  capture creates it on the first face and poses it again for each one. */
    std::shared_ptr<PerspectiveCamera>& probeCaptureCamera() { return probeCamera_; }
    /** Another renderer on this device, with its own targets: a reflection pass draws into one. */
    /** A renderer on the same device for a render target or a reflection: it shares this one's map
     *  textures, geometry copies, and layout and pipeline caches, as three's one renderer does. */
    std::unique_ptr<Renderer> sibling() {
        auto child = std::make_unique<Renderer>(instance_, device_, queue_, events_);
        child->textures_ = textures_;
        child->passTimer_ = passTimer_;
        child->ownsPassTimer_ = false;
        child->gpu_.shareSubmissions(gpu_);
        child->geometry_ = geometry_;
        child->layouts_ = layouts_;
        child->pipelines_ = pipelines_;
        return child;
    }
    /** The last render's linear HDR scene target (RGBA16Float), before post and the output transform. */
    void copyDepthToTexture(const Texture& texture);
    /** The main renderer's scene colour and depth this target's materials read by name. A bind group built over views the
     *  main renderer has since replaced (a resize, or temporal AA replacing multisampling) holds textures that keep their
     *  last frame, so replaced views rebuild the groups. */
    void setSourceAttachments(WGPUTextureView color, WGPUTextureView depth) {
        const bool replaced = color != sourceScene_ || depth != sourceDepth_;
        sourceScene_ = color;
        sourceDepth_ = depth;
        if (replaced) rebuildGroups();
    }
    /** The renderer whose post render-to-texture passes this target's materials sample (a material node may read one). */
    void setPostSource(const Renderer* main) { postSource_ = main; }
    WGPUTextureView sceneDepthView() const { return depthView_; }
    WGPUTextureView sceneColorView() const { return sceneView_; }
    /** The format the scene colour is drawn and read in: RGBA16Float, or RGBA32Float for a FloatType render target (a 32-bit target is never multisampled). */
    void setSceneFormat(WGPUTextureFormat format);
    /** True when a blended draw into RGBA32Float is valid on this device (float32-blendable); `forceHalfFloatTargets` says no, for tests. */
    bool float32Blendable() const { return !forceHalfFloatTargets_ && wgpuDeviceHasFeature(device_, WGPUFeatureName_Float32Blendable); }
    void forceHalfFloatTargets(bool force) { forceHalfFloatTargets_ = force; }
    WGPUTextureFormat sceneFormat() const { return sceneFormat_; }
    /** Linear filtering, clamped to the edge: three's RenderTarget texture defaults. */
    WGPUSampler linearClampSampler();
    void setVirtualShadow(std::size_t light, const shadows::AtlasOptions& options);
    /** `tanHalfFov` is the main view's (0 for a pass that is not it): auto-sized atlases measure on it. */
    void syncVirtualShadows(const LightState& lights, double tanHalfFov = 0);
    bool hasVirtualShadows() const { return !virtualShadows_.empty(); }
    /** The page plan of light `light`'s virtual shadow, or null. */
    const shadows::PageAtlas* virtualShadowAtlas(std::size_t light) const {
        const auto it = virtualShadows_.find(light);
        return it == virtualShadows_.end() ? nullptr : &it->second.atlas;
    }
    void cutVirtualShadows() { virtualCut_ = true; }
    void setOutput(const OutputState& output);
    /** A post pass between the scene and the output transform; null draws the scene straight out. */
    void setPostNode(std::shared_ptr<const shader::PostNode> post);
    void setPostGraph(shader::graph::Node root);
    /** A render-graph normal/history input supplied by its native producer; borrowed view. */
    void setPostInput(const std::string& name, WGPUTextureView view);
    void setTraa(const TraaOptions& options);
    TraaPass* traaDebugPass() const { return traa_.get(); }
    /**
     * The temporal pass as the last planned frame left it: whether a traa() effect is in the post graph, the frames it has
     * begun, whether the next resolve has history, and the sub-pixel jitter in pixels. A snapshot taken where frames are
     * planned, so the game thread reads it while the render thread encodes the frame before.
     */
    struct TemporalStatus {
        bool active = false, historyValid = false;
        uint64_t frame = 0;
        double jitterX = 0, jitterY = 0;
        // The newest counted frame (one in `TraaPass::kMeasureEvery` is counted): the pixels whose history the resolve
        // discarded (`rejected`: off screen or disoccluded), the pixels whose history it pulled into the colour
        // neighbourhood (`clamped`), the pixel count of that frame and the frame it was. All 0 until the first count.
        uint32_t rejected = 0, clamped = 0, pixels = 0;
        uint64_t countedFrame = 0;
    };
    const TemporalStatus& temporalStatus() const { return temporalStatus_; }
    void cutHistory();
    const OutputState& output() const { return output_; }

    /** Reallocates the targets; the next render draws at the new extent. Zero sizes clamp to 1. */
    void setSize(uint32_t width, uint32_t height);
    /** The multisampling the game asks for. A traa() effect in the post graph replaces it: see sampleCount(). */
    void setSampleCount(uint32_t samples);
    /** The samples the scene draws with: 1 while a traa() effect is in the post graph, otherwise the requested count. */
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
    /**
     * render() in two halves for the render thread (PRD-613). `renderDeferred` does everything that reads
     * scene-owned data (syncs, texture and geometry uploads, uniform packing, program lookup) and returns;
     * `encodePending` then records and submits the frame from what that half froze, on any one thread,
     * and reads nothing the game can write. The game thread touches this renderer only before the first
     * call and after the second; a call that breaks the order throws TN_RENDER_THREAD_BATON.
     */
    uint64_t renderDeferred(std::span<const DrawItem> items, const CameraState& camera, const LightState& lights,
                            std::array<double, 4> clear = {0, 0, 0, 0});
    void encodePending();
    /**
     * A game's RenderTarget whose draw was planned and not yet recorded (`jobs`: one encodePending per renderer it planned).
     * A target the post graph samples is recorded where the frame first reads it, after the render-to-texture passes its own
     * scene samples; any other is recorded at the top of the next frame, ahead of the scene pass. `owner` is the target's
     * GPU state, and a job whose owner is gone is dropped. Never recorded twice: a second plan for `key` records the first.
     */
    void deferTarget(const void* key, std::weak_ptr<void> owner, std::vector<std::function<void()>> jobs);
    /** Records the planned draw of `key` now, if it has one. */
    void flushDeferred(const void* key);
    /** How many planned target draws wait for the frame. */
    std::size_t deferredTargets() const { return deferred_.size(); }
    /** True from `renderDeferred` until `encodePending` returns: the game thread plans nothing meanwhile. */
    bool framePending() const { return pendingEncode_ || encoding_; }
    /** Pipeline preparation only: shares render's planning, submits no frame. */
    std::vector<std::shared_ptr<PipelineCompilation>> compileAsync(std::span<const DrawItem> items,
        const CameraState& camera, const LightState& lights, WGPUTextureFormat outputFormat = WGPUTextureFormat_RGBA8Unorm);
    /**
     * Frame-pumped PMREM (PRD-573): submits at most one retained full-quality packet of the single
     * in-flight environment preparation and reports whether every environment the frame samples is
     * fully baked. False means the render entry must skip this frame: no partial target is published
     * and the covered scene is not drawn. Both the native player and the WASM host call this through
     * RenderDatabase::render, so one mechanism serves both.
     */
    bool prepareEnvironments(std::span<const DrawItem> items);
    /** True while the last render() skipped its frame for an environment that is not baked yet. */
    bool environmentPending() const { return environmentPending_; }
    /**
     * Draws the last render() output into `target` and submits it, so a windowed player puts the
     * very same frame on the screen the render database just built. `format` is the target view's
     * format. Returns false when the program for it is refused; the frame stays readable either way.
     */
    bool blitTo(WGPUQueue queue, WGPUTextureView target, WGPUTextureFormat format);
    /**
     * blitTo in two halves (PRD-610 AC-9): the game thread prepares the pipelines and bind groups,
     * and `encodeBlit` records the pass on any thread without touching this renderer.
     */
    struct BlitPlan {
        WGPUDevice device = nullptr;
        WGPURenderPipeline pipeline = nullptr, over = nullptr;
        WGPUBindGroup group = nullptr, overGroup = nullptr;
        WGPUBuffer triangle = nullptr;
        uint32_t location = 0;
    };
    std::optional<BlitPlan> prepareBlit(WGPUTextureFormat format);
    /** Records the plan's pass into `target` and releases its bind groups. */
    static WGPUCommandBuffer encodeBlit(BlitPlan& plan, WGPUTextureView target);
    /**
     * PRD-554: a UI overlay's newest frame, premultiplied 8-bit rows from the top (`bgra` for a desktop
     * web view's B,G,R,A; `stride` bytes per row, 0 for tight), which blitTo draws "over" the frame,
     * stretched to the target. `version` names the pixels: the same version uploads nothing, so a
     * steady UI costs one draw and no copy. A null `pixels` removes the overlay. With a GPU thread the upload
     * runs there from `pixels` itself, which must stay valid until that thread's next wait() (a UI overlay
     * frame is valid until the next uiOverlayFrame call, which the player makes only after that wait).
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
        /** The triangles those shadow draws submitted; three's Info counts them with the main pass's. */
        uint64_t shadowTriangles = 0;
        /** Of the shadow draws, the spot and point light maps' (PRD-650): maps redrawn, and their draws. */
        uint32_t lampRedraws = 0, lampShadowDraws = 0;
        struct SkinnedPass {
            uint32_t batches = 0, draws = 0, exactDraws = 0, instances = 0;
        };
        SkinnedPass mainSkinned, shadowSkinned;
    };
    /** With a render thread the frame's stats arrive from `encodePending` and `collectFrame` publishes them, one frame late. */
    const FrameStats& lastFrame() const { return publishes_ ? published_ : lastFrame_; }
    /** Game thread, with the render thread idle: publishes the stats of the frame `encodePending` last finished. */
    void collectFrame() {
        std::lock_guard lock(frameMailMutex_);
        published_ = frameMail_;
        publishes_ = true;
    }
    /**
     * GPU time of the most recent frame whose timestamps came back, summed over every render
     * and compute pass, including offscreen targets, in milliseconds; negative until one has, and always on a device without timestamp-query.
     */
    double lastGpuMs() const { return timing_->lastMs; }
    /**
     * Whether frames are timed on the GPU: off by default, since a timed frame resolves its query
     * set and reads it back, a cost every frame pays and only a caller of lastGpuMs wants.
     */
    void setGpuTimer(bool on) { passTimer_->enabled = on; }
    /**
     * The caller's frame id for the next timed render, reported with its sample once the readback
     * lands. The caller owns the id: the engine's own render ids are not one per present.
     */
    void setGpuTimerSourceFrame(uint64_t frame) { sourceFrame_ = frame; }
    /**
     * The last timed frame's GPU time by segment, in ms: shadow passes (0 when the frame drew none),
     * scene pass, other passes (offscreen, compute, post, TRAA), output pass.
     */
    std::array<double, kGpuSegments> lastGpuSegments() const { return timing_->segments; }
    /** How many GPU times have come back, so a caller samples each one once. */
    uint64_t gpuSamples() const { return timing_->samples; }
    /** Timestamp pairs in the most recently resolved complete frame. */
    uint32_t gpuTimestampPasses() const { return timing_->passes; }
    /** The caller's frame id of the most recent resolved GPU time: the frame it was submitted with, not the one that read it back. */
    uint64_t gpuSourceFrame() const { return timing_->source; }
    /** Whether frames are actually timed: the device negotiated timestamp-query and the timer is on. */
    bool gpuTimerEnabled() const { return passTimer_->queries != nullptr && passTimer_->enabled; }
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
    const PipelineCache& pipelines() const { return *pipelines_; }
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
                                kLightShadowIntensity, kLightShadowNear, kLightShadowFar, kLightShadowSourceRadius,
                                kLightShadowPenumbraScale, kLightSourceRadius, kLightFieldCount };
    uint64_t renderPrepared(std::span<const DrawItem> items, const CameraState& camera, const LightState& lights,
        std::array<double, 4> clear, std::vector<std::shared_ptr<PipelineCompilation>>* compilation,
        WGPUTextureFormat outputFormat, bool defer = false);
    // renderPrepared's plan, frozen for encodePending: the draws with their programs, pipelines and uniform slices.
    struct Planned;
    struct ShadowPass;
    struct FrameJob;
    void encodeFrame(FrameJob& job);
    std::unique_ptr<FrameJob> job_;
    bool pendingEncode_ = false;
    std::atomic<bool> encoding_{false};
    mutable std::mutex frameMailMutex_;
    FrameStats frameMail_, published_;
    bool publishes_ = false;
    struct Program {
        shader::StageModule vertex;
        shader::StageModule fragment;
        shader::StageModule materialFragment;
        // Explicit layouts: each stage's uniform block is a dynamic-offset slice of the frame's one
        // uniform buffer, so a draw costs a bind-group offset, not a buffer and a bind group of its own.
        WGPUBindGroupLayout layouts[2] = {};
        WGPUPipelineLayout pipelineLayout = nullptr;
        WGPUBindGroup groups[2] = {};  // over the current frame buffer; rebuilt when it grows
        const shader::UniformField* vertexSlots[kSlotCount] = {};
        const shader::UniformField* fragmentSlots[kSlotCount] = {};
        std::vector<std::array<const shader::UniformField*, kLightFieldCount>> lightSlots;
        // What the program was built from, so albedoFragment() can build the same fragment again with its output swapped.
        MaterialKind kind = MaterialKind::Standard;
        shader::VertexVariant variant;
        std::string lightKinds;
        bool softShadows = false;
        std::unique_ptr<shader::StageModule> albedo;  // built on first request; empty module when the kind has none
        bool albedoBuilt = false;
        std::unique_ptr<shader::StageModule> emissive;
        bool emissiveBuilt = false;
    };
    /** The program's fragment with the diffuse colour as its output (VertexVariant::albedoOutput), on the program's own
     *  layout so a draw's bind groups serve it; null for an unlit kind, or when the builder refuses the variant. */
    const shader::StageModule* albedoFragment(Program& program);
    const shader::StageModule* emissiveFragment(Program& program);
    void buildLayouts(Program& program, const std::string& key);
    /** The program for a material kind, vertex variant and light layout, built on first use; null
     *  when its WGSL is invalid, which is reported once in diagnostics() and its draws are skipped,
     *  as three logs a shader error and draws the rest of the scene. */
    Program* program(MaterialKind kind, const shader::VertexVariant& variant, const std::string& lights,
                     bool softShadows = false);
    /** The shadow pass's depth-only program for a vertex variant (0 plain, 1 instanced). */
    Program& depthProgram(const shader::VertexVariant& variant, bool masked);
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
    uint64_t submit(WGPUCommandBuffer commands);
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
    friend class GraphCompute;
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
     * The full-quality bake is frame-pumped: `ready` turns on only after every retained packet has
     * been submitted and its completion observed, so no caller can read a partial target.
     */
    struct EnvironmentGpu {
        const Texture* source = nullptr;
        uint32_t version = 0;
        bool ready = false;              // all packets submitted and the last completion observed
        WGPUTexture texture = nullptr;   // the cubeUV render target, sampled by the material
        WGPUTextureView view = nullptr;
        WGPUTexture pingpong = nullptr;
        WGPUTextureView pingView = nullptr;
        WGPUSampler sampler = nullptr;
        uint32_t width = 0, height = 0, cubeSize = 0;
        uint32_t lodMax = 0, lods = 0;
        float texelWidth = 0, texelHeight = 0, maxMip = 0;
    };
    /** One retained PMREM packet: one full-quality pass drawn for one cube face. */
    struct PmremPacket {
        WGPUTextureView target = nullptr;
        WGPUTextureView source = nullptr;
        WGPUSampler sampler = nullptr;
        WGPURenderPipeline pipeline = nullptr;
        float x = 0, y = 0, w = 0, h = 0, roughness = 0, mipInt = 0;
        uint64_t vertexOffset = 0;
        uint32_t pass = 0, face = 0;     // the pass's uniform slice and the vertex's face span
        bool clear = false;
    };
    /** One face of one pass in fragment samples: the per-call submission cost. */
    static uint64_t pmremPacketCost(const PmremPacket& packet);
    // The single in-flight preparation: envUniforms_ is one shared buffer, so only one bakes at a time.
    struct EnvironmentPreparation {
        uint64_t ident = 0;
        uint32_t version = 0;
        const Texture* source = nullptr;
        std::vector<PmremPacket> packets;
        std::size_t next = 0;
        uint64_t awaitSerial = 0;        // the last submitted packet's serial, awaited before the next
        WGPUBindGroup group = nullptr;   // the current pass's bind group, rebuilt per pass
        std::size_t groupPass = SIZE_MAX;
        uint64_t stride = 0;
        uint64_t budget = 0;             // the costliest packet's cost: the per-call submission cap
    };
    std::optional<EnvironmentPreparation> envPrep_;
    bool environmentPending_ = false;
    bool advanceEnvironments(std::span<const DrawItem> items);
    void beginEnvironment(const Texture& equirect);
    bool pumpEnvironment();
    void abandonEnvironment();
    EnvironmentGpu& environment(const Texture& equirect);
    void buildEnvironmentPipelines();
    void releaseEnvironments();
    void rebuildGroups();
    void releaseTargets();
    void resolveDepth(WGPUCommandEncoder encoder);  // 4x: depth_ takes sample 0 of msaaDepth_
    GpuStatus readRgba16(WGPUTexture texture, ReadbackCallback done, uint32_t texelBytes = 8);
    void releaseOutputGroup();
    void outputPass(WGPUCommandEncoder encoder, WGPUTextureView present, WGPUTextureFormat presentFormat);

    WGPUInstance instance_;
    std::unique_ptr<Renderer> probeCapture_;
    std::shared_ptr<PerspectiveCamera> probeCamera_;
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
    // Shared with every sibling(): a render target's renderer draws the same programs, and a pipeline
    // compiled for one layout serves them all only if the layout handles are the same too.
    std::shared_ptr<PipelineCache> pipelines_;
    std::shared_ptr<PipelineLayoutCache> layouts_;
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
    struct VirtualShadowCosts {
        std::mutex mutex;
        std::map<int, std::pair<double, uint64_t>> levels;
    };
    struct VirtualShadow {
        shadows::PageAtlas atlas;
        std::shared_ptr<const shadows::AtlasOptions> source;
        ShadowMap map;
        std::shared_ptr<VirtualShadowCosts> costs = std::make_shared<VirtualShadowCosts>();
        std::map<int, uint64_t> consumedCosts;
    };
    std::map<std::size_t, VirtualShadow> virtualShadows_;
    /** Each lamp's last drawn map signature (PRD-650): an equal one skips its depth passes. */
    std::map<std::size_t, uint64_t> lampSignatures_;
    /** Each lamp's last pose and the frame it last moved: a moving lamp takes a coarser map (PRD-650). */
    struct LampMotion { uint64_t pose = 0; int64_t movedAt = 0; };
    std::map<std::size_t, LampMotion> lampMotion_;
    bool virtualCut_ = false;
    WGPUSampler compareSampler_ = nullptr;
    WGPUSampler depthValueSampler_ = nullptr;  // nearest, no compare: a blocker search's depth reads
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
    // Every retirement, not the first sweeper's share: siblings and the probe capture renderer cache
    // the same textures, so each renderer needs the whole stream.
    std::shared_ptr<RetiredTextures> retired_;
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
    WGPUTextureFormat sceneFormat_ = WGPUTextureFormat_RGBA16Float;
    bool forceHalfFloatTargets_ = false;
    WGPUTextureView sceneView_ = nullptr;
    uint32_t sampleCount_ = 1;
    uint32_t requestedSamples_ = 1;  // what the game asked for; sampleCount_ is 1 while a traa() effect is in the post graph
    WGPUTexture msaaColor_ = nullptr;
    WGPUTextureView msaaColorView_ = nullptr;
    WGPUTexture msaaAuxColor_ = nullptr;
    WGPUTextureView msaaAuxColorView_ = nullptr;
    WGPUTexture msaaDepth_ = nullptr;
    WGPUTextureView msaaDepthView_ = nullptr;
    WGPURenderPipeline depthResolve_ = nullptr;  // built by the first 4x frame
    // View-space normals for post passes that read "normal" (three's MRT `normal: normalView`),
    // drawn after the main pass; created with the first such frame, released with the targets.
    WGPUTexture normalTexture_ = nullptr;
    WGPUTextureView normalView_ = nullptr;
    /** The diffuse colour of every opaque lit draw for post passes that read "albedo" (three's MRT `diffuseColor`),
     *  drawn after the normal pass over the same draws; created with the first such frame, released with the targets. */
    WGPUTexture albedoTexture_ = nullptr;
    WGPUTextureView albedoView_ = nullptr;
    WGPUTexture emissiveTexture_ = nullptr;
    WGPUTextureView emissiveView_ = nullptr;
    shader::StageModule normalFragment_;
    /** normalFragment_ for Standard and Physical draws: the alpha also packs metalness and roughness (see planNormals). */
    shader::StageModule surfaceFragment_;
    WGPUTexture materialTexture_ = nullptr;
    WGPUTextureView materialView_ = nullptr;
    std::vector<std::string> diagnostics_;
    OutputState output_;
    std::shared_ptr<const shader::PostNode> post_;
    shader::graph::Node postGraph_;
    WGPUTextureView sourceScene_ = nullptr, sourceDepth_ = nullptr;
    const Renderer* postSource_ = nullptr;
    const PostEffects* postTextureOwner(const std::string& name) const;
    WGPUTextureView postTextureView(const std::string& name) const;
    void applySampleCount();
    uint64_t postViewsStamp() const;
    void collectPostSources();
    GraphTextures postTextures_;
    std::vector<shader::graph::Node> postTextureNodes_;
    struct RttTarget {
        std::string name;
        std::shared_ptr<shader::graph::RttState> state;
        uint32_t materialVersion = 0;
        const Material* material = nullptr;
    };
    std::vector<RttTarget> rttTargets_;

    struct DeferredTarget {
        const void* key;
        std::weak_ptr<void> owner;
        std::vector<std::function<void()>> jobs;
    };
    std::vector<DeferredTarget> deferred_;
    /** Records (and forgets) the planned target draws that the post graph samples (`sampled`) or does not. */
    void recordDeferred(bool sampled);
    bool postSamples(const void* key) const;
    std::vector<uint32_t> postTextureVersions_;
    std::vector<WGPUTextureView> postTextureViews_;  // a resized render target's texture is a new view
    std::unique_ptr<TraaPass> traa_;
    std::shared_ptr<const shader::graph::PostEffect> liveTraa_;
    TemporalStatus temporalStatus_;
    /** What the newest counted frame's readback brought back (`TemporalStatus::rejected`): shared with the callback, which can outlive the renderer. */
    struct TraaCounts {
        std::atomic<uint32_t> rejected{0}, clamped{0}, pixels{0};
        std::atomic<uint64_t> frame{0};
    };
    std::shared_ptr<TraaCounts> traaCounts_ = std::make_shared<TraaCounts>();
    Handle traaStats_;  // the resolve's two counters, read back after the frame that counted them
    void readTraaCounts();
    /** True when the resolve reads a frame the post graph drew (`traaResolvesLate`): it then runs as a graph pass. */
    bool lateTraa_ = false;
    /** The colour the post graph and the output pass read as `scene`: the scene pass's own, or its resolve. */
    WGPUTextureView postScene() const;
    std::unique_ptr<PostEffects> postEffects_;
    std::map<std::string, std::vector<double>> postUniforms_;
    /** three's `time` (its NodeFrame clock): seconds since this renderer was made, read once a frame. */
    std::chrono::steady_clock::time_point start_ = std::chrono::steady_clock::now();
    float frameTime_ = 0;
    float frameDelta_ = 0;  // three's deltaTime for the draws: frameTime_ minus the frame before's
    float computeTime_ = 0, computeDelta_ = 1.0f / 60.0f;  // the same clock as the compute dispatches see it
    uint64_t computeFrame_ = ~uint64_t{0};
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
    std::shared_ptr<FrameGpuTimer> passTimer_;
    bool ownsPassTimer_ = true;
    uint64_t sourceFrame_ = 0;  // the caller frame id the next timed frame is submitted with
    Handle timestampResolve_;
    // Shared with the readback callback by weak reference: a backend may deliver it after this
    // renderer is gone (wgpu does at teardown), and it must then find nothing to write into.
    struct Timing {
        double lastMs = -1;
        std::array<double, kGpuSegments> segments{};  // shadow passes, scene pass, other passes, output pass, screen-space gather, in ms
        uint32_t passes = 0;
        uint64_t samples = 0;
        uint64_t source = 0;  // the caller frame id the successful sample was submitted with
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
    std::shared_ptr<GpuJointScene> gpuJoints_;
    Object3D* gpuJointScene_ = nullptr;
    uint64_t gpuJointScan_ = ~uint64_t(0);
    Handle gpuJointLocals_;
    std::unique_ptr<JointComputePass> gpuJointPass_;
    std::unique_ptr<GraphCompute> graphCompute_;
    GraphCompute& graphCompute();
    bool bindGpuJoints(const std::shared_ptr<GpuJointScene>& plan);
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
