#pragma once

#include <unordered_set>

#include <array>
#include <cstdint>
#include <deque>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

#include "engine/renderer/renderer.h"
#include "engine/animation/skinning/palette.h"
#include "engine/scene/camera.h"
#include "engine/scene/geometry.h"
#include "engine/scene/lights.h"
#include "engine/scene/material.h"
#include "engine/scene/nodes.h"

namespace tn::engine {

/**
 * The render database (PRD-514 phase 1): `renderer.render(scene, camera)` on the native path. It
 * reads the native scene graph — never a JS scene — and keeps one draw record per mesh, rebuilt
 * only when its geometry's identity/revision or material's identity/version moves. Transforms and
 * mutable uniforms refresh independently; moving a mesh does not rebuild its resource record.
 *
 * Per call it does what three's Renderer.render does before drawing: updateMatrixWorld on the scene
 * (matrixWorldAutoUpdate) and on a parentless camera, switches the camera to WebGPU clip space,
 * then projects the scene as projectObject does — invisible subtrees skipped, layers tested
 * against the camera's — into meshes and lights.
 *
 * Lights: every directional, point and spot light, summed in three's id order; one hemisphere light
 * (more are refused by name). Frustum culling follows projectObject: a frustumCulled mesh, line,
 * sprite or instanced mesh outside the camera frustum skips the main pass. Not yet: groups and
 * multi-material meshes.
 */
class RenderDatabase {
  public:
    uint64_t render(Renderer& renderer, Object3D& scene, Camera& camera, std::array<double, 4> clear = {0, 0, 0, 0},
                    std::array<double, 2>* cpuMs = nullptr);

    std::vector<std::shared_ptr<PipelineCompilation>> compileAsync(Renderer& renderer, Object3D& root,
        Camera& camera, Object3D* targetScene = nullptr, WGPUTextureFormat outputFormat = WGPUTextureFormat_RGBA8Unorm);

    /** CPU preparation used by render; returned pointers remain valid until the next prepare. */
    const std::vector<DrawItem>& prepare(Object3D& scene, Camera& camera, LightState& lights, Object3D* targetScene = nullptr);

    /** Float32 copies of quantized attributes held for live sources (dead ones are swept). */
    [[nodiscard]] std::size_t convertedCount() const { return converted_.size(); }
    /** Records rebuilt since construction; the invalidation test reads it. */
    [[nodiscard]] uint64_t rebuilds() const { return rebuilds_; }
    /** Why the last render left something out (TN_NATIVE_MATERIAL_UNSUPPORTED, TN_NATIVE_LIGHTS_UNSUPPORTED...). */
    [[nodiscard]] const std::vector<std::string>& diagnostics() const { return diagnostics_; }

    /**
     * Automatic batching (PRD-519): opaque plain meshes that share a geometry and material uniforms
     * (base colours travel per instance),
     * at least kMinBatchMembers of them and none with a render callback, draw as one instanced
     * draw. Compatible skinned rigs share one palette draw per pass even across other draws.
     * On by default; off draws every mesh on its own, subject to the measured pixel-edge budget.
     */
    bool batching = true;
    bool profiling = false;
    // Matrix setup, projection/record refresh (including fused flat-scene matrices), batch packing, remaining.
    [[nodiscard]] const std::array<double, 4>& lastPrepareMs() const { return prepareMs_; }
    /** three's `renderer.shadowMap.enabled`: off, no light draws or reads a shadow map. */
    bool shadowMapEnabled = false;
    /** three's `renderer.shadowMap.type`: PCFShadowMap (1) or PCFSoftShadowMap (2). */
    int shadowMapType = 1;
    static constexpr std::size_t kMinBatchMembers = 4;
    /** Draws the last render merged by batching: groups made and meshes they absorbed. */
    [[nodiscard]] std::pair<std::size_t, std::size_t> lastBatches() const { return {batchGroups_, batchMembers_}; }

  private:
    // A material's pmremTexture source and reflector, walked once per material version: the graph
    // roots are kept so a new material at a freed one's address never reads the old answer.
    // ponytail: entries for released materials stay until the database goes; prune if materials churn.
    struct GraphSources {
        uint32_t version = 0;
        std::array<const void*, 8> roots{};
        const Texture* texture = nullptr;
        std::shared_ptr<const void> reflector;  // an engine::Reflector
        std::vector<std::pair<std::string, const Texture*>> textures;  // texture(object) samples
        std::vector<std::pair<std::string, const BufferAttribute*>> storages;  // storage(attribute) reads
    };
    std::unordered_map<const Material*, GraphSources> graphSources_;
    const GraphSources& graphSources(const Material& material);
    void vertexColorsOf(const BufferGeometry& geometry, const Material& material, DrawItem& d);
    static void depthBiasOf(const Material& material, DrawItem& d);
    void geometryInputsOf(const BufferGeometry& geometry, DrawItem& d);
    // One mirrored pass per live reflector: its own targets and its own records, so the pass never
    // resizes the frame or churns the frame's draw records. A pass draws no further reflections.
    struct ReflectionPass {
        std::weak_ptr<const void> owner;
        std::unique_ptr<Renderer> renderer;
        std::unique_ptr<RenderDatabase> database;
    };
    std::unordered_map<const void*, ReflectionPass> reflections_;
    bool reflecting_ = false;
    void renderReflections(Renderer& renderer, Object3D& scene, Camera& camera, std::vector<DrawItem>& items,
                           std::array<double, 4> clear);
    std::shared_ptr<BufferGeometry> backgroundGeometry_;
    shader::StandardMaterial backgroundParams_;
    using GeometryKey = std::array<BufferStore*, 4>;
    struct alignas(64) Record {
        uint64_t geometryRevision = 0;
        uint64_t meshId = 0;
        uint64_t seen = 0; // the render it was last projected in
        uint32_t materialVersion = 0;
        bool drawable = false, materialized = false;
        // Held, so neither is released while the record's item points into it, and a new one can
        // never take its address and pass for it. The mesh is known by its id, never reused.
        std::shared_ptr<const BufferGeometry> geometry;
        std::shared_ptr<const Material> material;
        // The renderer's resolved program/pipeline/bind groups, reused while the variant is unchanged.
        // On the record, not its draw: a batched mesh's draw is rebuilt every frame but the record is not.
        DrawCache cache;
        GeometryKey buffers{};
        struct Draw {
            shader::StandardMaterial params;
            DrawItem item;
        };
        std::unique_ptr<Draw> draw; // materialize only actual draws, not every batched member
    };
    void project(Object3D& object, const Camera& camera, std::vector<DrawItem>& items, LightState& lights,
                 bool updateChildren = false, bool force = false, Record* cached = nullptr, bool plainMesh = false,
                 bool lightsOnly = false, const Object3D* excluded = nullptr);
    void batch(std::vector<DrawItem>& items, Object3D& scene,
               const std::vector<std::pair<double, const DrawItem*>>& ordered);
    std::vector<std::shared_ptr<BufferStore>> batchStores_; // reused frame to frame, one per group
    std::vector<std::shared_ptr<BufferStore>> batchColors_;
    std::vector<shader::StandardMaterial> batchParams_;
    std::deque<DrawCache> batchCaches_;
    Frustum frustum_;          // this prepare's camera frustum, as three's _frustum
    bool cullExempt_ = false;  // inside a BatchedMesh, which three culls per instance
    struct ShadowFrustum {
        Frustum frustum;
        uint32_t layersMask = 1;
    };
    std::vector<ShadowFrustum> shadowFrustums_;
    std::unordered_map<const Light*, DirectLight::Shadow> shadowByLight_;
    bool shadowPointLightActive_ = false;
    // Directional, spot and point lights under `shadowLightsRoot_` in walk order, visible or not;
    // rebuilt when any add/remove/attach/destructor moves Object3D::hierarchyVersion().
    std::vector<Object3D*> shadowLights_;
    const Object3D* shadowLightsRoot_ = nullptr;
    uint64_t shadowLightsVersion_ = ~uint64_t(0);
    void collectShadowFrustums(Object3D& root, const Camera& mainCamera);
    bool boundingSphereOf(Object3D& object, std::string_view type, Sphere& sphere);
    bool inFrustum(Object3D& object, std::string_view type);  // a deque: a draw keeps its slot's address while later slots grow
    bool inShadowFrustum(Object3D& object, std::string_view type);
    std::vector<std::unique_ptr<SkinnedPalette>> skinnedPalettes_; // borrowed by this frame's draws
    // core's DECLINE_RESCAN_FRAMES: a settled projection decline re-judges on this cadence, not per
    // frame. Starts at the interval so the first batch always scans.
    static constexpr std::size_t kDeclineRescanFrames = 60;
    std::size_t framesSinceDeclineScan_ = kDeclineRescanFrames;
    std::size_t batchGroups_ = 0, batchMembers_ = 0;

    std::vector<DrawItem> items_;
    std::vector<DrawItem> twoPasses_;
    std::vector<std::vector<std::size_t>> batchGroupsList_;
    std::unordered_map<std::size_t, std::vector<std::size_t>> candidatesByKey_;
    std::vector<bool> absorbed_;
    std::vector<DrawItem> merged_;
    std::vector<DrawItem> batchedOut_;
    LightState lights_;
    CameraState cameraState_;

    Record& record(const Mesh& mesh, bool materialize = true);
    Record& record(const Mesh& mesh, Record& cached, bool materialize = true);
    DrawItem& refresh(const Mesh& mesh, Record& record);
    void batchMeshes(std::vector<DrawItem>& items);
    void addBatchMesh(const Mesh& mesh, Record& record, bool mainPass, bool shadowCaster);
    struct BatchMember {
        const Mesh* mesh;
        const Material* material;
        double depth;
        uint64_t id;
        int order;
        Record* record;
        bool mainPass = true;
        uint32_t layers = 1;
        bool shadowCaster = false;
    };
    struct MeshGroup {
        GeometryKey geometry;
        std::vector<std::size_t> members;
        bool orderedIds = true;
    };
    std::vector<BatchMember> batchMeshes_;
    struct alignas(64) BatchTransform { std::array<float, 16> matrix; };
    std::vector<BatchTransform> batchTransforms_; // one cache line per matrix, in scene order
    std::vector<std::array<float, 3>> batchRgb_;
    std::vector<MeshGroup> meshGroups_;
    std::size_t meshGroupCount_ = 0;
    std::unordered_map<std::size_t, std::vector<std::size_t>> meshCandidates_;
    std::optional<std::size_t> lastMeshGroup_;
    Matrix batchProjView_{};

    // Drawn meshes that carry onBeforeRender, run after projection and before submission.
    struct PendingCallback {
        std::shared_ptr<const Object3D> keep; // a callback may detach it; the call still finds it
        const Mesh* mesh;
        Record* record;
    };
    std::vector<PendingCallback> callbacks_;
    std::unordered_map<const Object3D*, Record> records_;
    std::vector<Record> flatRecords_; // scene-order slots; no per-mesh hash lookup on the flat lane
    std::vector<uint8_t> flatPlainMeshes_;
    bool flatParentIdentity_ = false;
    std::vector<std::size_t> sortScratch_;
    std::vector<uint64_t> depthKeys_;
    std::vector<uint32_t> floatKeys_;
    std::vector<std::string> diagnostics_;
    uint64_t rebuilds_ = 0;
    // A float32 copy per attribute. The source is held weakly: a freed store (or one whose address a
    // new store took) reads as expired, so a stale copy is never served and a dead entry can be swept.
    struct Converted {
        std::shared_ptr<BufferStore> store;
        uint32_t version = 0;
        std::weak_ptr<BufferStore> source;
    };
    std::unordered_map<const BufferAttribute*, Converted> converted_;
    std::size_t convertedSweepAt_ = 64;
    BufferStore* floatStore(const BufferGeometry& g, const char* name);
    uint64_t frame_ = 0;
    std::size_t previousDrawCount_ = 0;
    std::array<double, 4> prepareMs_{};
    std::vector<std::pair<uint64_t, DirectLight>> direct_; // this render's direct lights with their ids
    std::unordered_set<const void*> skeletonsUpdated_;     // skeletons this render already updated
    int hemisphere_ = 0;
};

} // namespace tn::engine
