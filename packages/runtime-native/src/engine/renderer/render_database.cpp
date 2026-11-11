#include "engine/foundation/waste_counters.h"
#include "engine/foundation/flags.h"
#include "engine/foundation/ThreeConstants.h"
#include "engine/scene/raycaster.h"
#include "engine/foundation/prefetch.h"
#include "render_database.h"
#include "engine/renderer/reflection_pass.h"
#include "engine/renderer/reflector.h"

#include "engine/animation/skinning/skeleton.h"
#include "engine/renderer/projection/plan.h"

#include <algorithm>
#include <stdexcept>
#include <unordered_set>
#include <functional>
#include <cmath>
#include <chrono>
#include <limits>
#include <bit>
#include <typeinfo>
#include "engine/scene/geometries.h"
#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <cstring>

namespace tn::engine {

namespace {

// three's geometry.setIndirect (PRD-857), read every frame: a GPU world scene points a geometry at its key's
// record after the mesh is built, and points it at a grown buffer when the scene resizes.
void indirectOf(const Mesh& mesh, DrawItem& d) {
    const BufferGeometry* geometry = mesh.geometry.get();
    d.indirect = geometry && geometry->indirect ? geometry->indirect->store.get() : nullptr;
    d.indirectOffset = d.indirect ? static_cast<uint64_t>(geometry->indirectOffset) : 0;
}

// What a material's node graphs read from outside the material: the texture pmremTexture
// prefilters and the reflectors a reflector() node samples. One pmrem source per material: a second,
// different one is refused rather than silently sharing the first one's. Reflectors are a list, as
// three gives each ReflectorNode its own render target, so a material may sample two mirrors.
struct GraphFind {
    const Texture* texture = nullptr;
    std::vector<std::pair<std::string, std::shared_ptr<const void>>> reflectors;  // by binding name
    std::vector<shader::graph::Node> textureNodes;
    std::vector<std::pair<std::string, const Texture*>> textures;  // texture(object) samples, by binding
    std::vector<std::pair<std::string, const BufferAttribute*>> storages;  // storage(attribute) reads, by binding
};

GraphFind findGraphSources(const Material& material) {
    GraphFind found;
    std::unordered_set<const shader::graph::NodeData*> seen;
    const std::function<void(const shader::graph::Node&)> visit = [&](const shader::graph::Node& node) {
        if (!node || !seen.insert(node.get()).second) return;
        if (node->kind == shader::graph::Kind::Pmrem) {
            const auto* texture = static_cast<const Texture*>(node->object.get());
            if (found.texture && found.texture != texture)
                throw std::runtime_error("TN_NATIVE_PMREM_UNSUPPORTED: one material samples two pmremTexture sources");
            found.texture = texture;
        } else if ((node->kind == shader::graph::Kind::Texture || node->kind == shader::graph::Kind::StorageTexture) && node->textureObject()) {
            const auto* texture = static_cast<const Texture*>(node->textureObject().get());
            const auto same = std::find_if(found.textures.begin(), found.textures.end(),
                                           [&](const auto& entry) { return entry.first == node->name; });
            if (same == found.textures.end())
                { found.textures.emplace_back(node->name, texture); found.textureNodes.push_back(node); }
            // Nodes over one texture share its binding (tsl_call.cpp "texture"); a `.value` that moved only one of
            // them cannot be drawn from that one binding.
            else if (same->second != texture)
                throw std::runtime_error("TN_NATIVE_TEXTURE_VALUE_SHARED: " + node->name +
                                         " is sampled by two nodes that now hold different textures; give each its own texture()");
        } else if (node->kind == shader::graph::Kind::StorageElement && node->object) {
            if (std::none_of(found.storages.begin(), found.storages.end(),
                             [&](const auto& entry) { return entry.first == node->name; }))
                found.storages.emplace_back(node->name, static_cast<const BufferAttribute*>(node->object.get()));
        } else if (node->kind == shader::graph::Kind::Reflector) {
            // Each mirror has its own binding name and its own pass; two nodes over one mirror share both.
            if (std::none_of(found.reflectors.begin(), found.reflectors.end(),
                             [&](const auto& entry) { return entry.first == node->name; }))
                found.reflectors.emplace_back(node->name, node->object);
        }
        for (const auto* list : {&node->args, &node->body, &node->otherwise})
            for (const auto& child : *list) visit(child);
    };
    material.nodes.forEachGraph(visit);
    return found;
}

// ReflectorBaseNode.updateBefore's camera: `virtualCamera` mirrored through the target's plane, with
// the projection's near plane replaced by the mirror (Lengyel's oblique clip). False when the
// mirror faces away from the camera, where three draws nothing.
bool poseReflection(const Reflector& reflector, const Camera& camera, PerspectiveCamera& virtualCamera) {
    const Matrix4& targetWorld = reflector.target->matrixWorld;
    Vector3 reflectorPosition, cameraPosition, normal(0, 0, 1), view, lookAt(0, 0, -1), target;
    reflectorPosition.setFromMatrixPosition(targetWorld);
    cameraPosition.setFromMatrixPosition(camera.matrixWorld);
    Matrix4 rotation;
    rotation.extractRotation(targetWorld);
    normal.applyMatrix4(rotation);
    view.subVectors(reflectorPosition, cameraPosition);
    if (view.dot(normal) > 0) return false;
    view.reflect(normal).negate();
    view.add(reflectorPosition);
    rotation.extractRotation(camera.matrixWorld);
    lookAt.applyMatrix4(rotation);
    lookAt.add(cameraPosition);
    target.subVectors(reflectorPosition, lookAt);
    target.reflect(normal).negate();
    target.add(reflectorPosition);

    virtualCamera.coordinateSystem = camera.coordinateSystem;
    virtualCamera.position.copy(view);
    virtualCamera.up.set(0, 1, 0);
    virtualCamera.up.applyMatrix4(rotation);
    virtualCamera.up.reflect(normal);
    virtualCamera.lookAt(target);
    if (const auto* perspective = dynamic_cast<const PerspectiveCamera*>(&camera)) {
        virtualCamera.near = perspective->near;
        virtualCamera.far = perspective->far;
    }
    virtualCamera.updateMatrixWorld();
    virtualCamera.projectionMatrix.copy(camera.projectionMatrix);

    Plane plane;
    plane.setFromNormalAndCoplanarPoint(normal, reflectorPosition);
    plane.applyMatrix4(virtualCamera.matrixWorldInverse);
    Vector4 clip(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
    auto& e = virtualCamera.projectionMatrix.elements;
    const Vector4 q((std::copysign(1.0, clip.x) * (clip.x != 0) + e[8]) / e[0],
                    (std::copysign(1.0, clip.y) * (clip.y != 0) + e[9]) / e[5], -1.0, (1.0 + e[10]) / e[14]);
    clip.multiplyScalar(1.0 / (clip.x * q.x + clip.y * q.y + clip.z * q.z + clip.w * q.w));
    e[2] = clip.x;
    e[6] = clip.y;
    e[10] = camera.coordinateSystem == CoordinateSystem::WebGPU ? clip.z : clip.z + 1.0;
    e[14] = clip.w;
    virtualCamera.projectionMatrixInverse.copy(virtualCamera.projectionMatrix).invert();
    return true;
}

Matrix toArray(const Matrix4& m) {
    Matrix out{};
    for (int i = 0; i < 16; ++i)
        out[i] = m.elements[i];
    return out;
}

std::array<double, 3> scaled(const Color& c, double s) { return {c.r * s, c.g * s, c.b * s}; }

std::array<double, 3> worldPosition(const Object3D& o) {
    return {o.matrixWorld.elements[12], o.matrixWorld.elements[13], o.matrixWorld.elements[14]};
}

std::array<double, 3> normalized(std::array<double, 3> v) {
    const double l = std::sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    return l > 0 ? std::array<double, 3>{v[0] / l, v[1] / l, v[2] / l} : v;
}

constexpr double kRadToDeg = 180 / 3.141592653589793; // MathUtils.RAD2DEG
// A transparent DoubleSide draw's BackSide pass keys its GPU record apart from its FrontSide pass.
constexpr uint64_t kBackSidePassKey = uint64_t(1) << 62;

// LightShadow.updateMatrices in three's WebGPU coordinate system: the shadow camera stands at the
// light, looks at the target, and `matrix` is the uv/depth bias matrix times its projection-view.
DirectLight::Shadow shadowOf(LightShadow& shadow, const std::array<double, 3>& from, const std::array<double, 3>& to,
                             uint32_t layersMask, Frustum* frustum = nullptr) {
    Camera& camera = *shadow.camera;
    if (camera.coordinateSystem != CoordinateSystem::WebGPU) camera.coordinateSystem = CoordinateSystem::WebGPU;
    if (auto* o = dynamic_cast<OrthographicCamera*>(&camera)) o->updateProjectionMatrix();
    if (auto* p = dynamic_cast<PerspectiveCamera*>(&camera)) p->updateProjectionMatrix();
    camera.position.set(from[0], from[1], from[2]);
    camera.lookAt(Vector3(to[0], to[1], to[2]));
    camera.updateMatrixWorld();
    Matrix4 projScreen;
    projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    if (frustum) frustum->setFromProjectionMatrix(projScreen, CoordinateSystem::WebGPU, false);
    Matrix4 matrix;
    matrix.set(0.5, 0.0, 0.0, 0.5, 0.0, 0.5, 0.0, 0.5, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0);
    matrix.multiply(projScreen);
    DirectLight::Shadow out;
    out.view = toArray(camera.matrixWorldInverse);
    out.projection = toArray(camera.projectionMatrix);
    out.matrix = toArray(matrix);
    out.virtualShadow = shadow.virtualShadow;
    out.sourceAngleFilter = shadow.sourceAngleFilter;
    out.sourceRadiusFilter = shadow.sourceRadiusFilter;
    out.bias = shadow.bias;
    out.normalBias = shadow.normalBias;
    out.radius = shadow.radius;
    out.intensity = shadow.intensity;
    out.width = static_cast<uint32_t>(shadow.mapSize.x);
    out.height = static_cast<uint32_t>(shadow.mapSize.y);
    out.layersMask = layersMask;
    // A spot map is perspective: its depth turns back into a distance for the source-radius filter.
    if (const auto* perspective = dynamic_cast<const PerspectiveCamera*>(&camera)) {
        out.near = perspective->near;
        out.far = perspective->far;
        out.tanHalfFov = 1.0 / camera.projectionMatrix.elements[5];
    }
    return out;
}

// PointShadowNode.renderShadow in WebGPU: the camera at the light, far = distance || far, turned to
// each face in _cubeDirectionsWebGPU with _cubeUpsWebGPU; shadow.matrix is the translation to the light.
DirectLight::Shadow pointShadowOf(LightShadow& shadow, const std::array<double, 3>& at, double distance,
                                  uint32_t layersMask) {
    static const double kDirections[6][3] = {{1, 0, 0}, {-1, 0, 0}, {0, -1, 0}, {0, 1, 0}, {0, 0, 1}, {0, 0, -1}};
    static const double kUps[6][3] = {{0, -1, 0}, {0, -1, 0}, {0, 0, -1}, {0, 0, 1}, {0, -1, 0}, {0, -1, 0}};
    auto& camera = static_cast<PerspectiveCamera&>(*shadow.camera);
    camera.coordinateSystem = CoordinateSystem::WebGPU;
    if (distance != 0) camera.far = distance;
    camera.updateProjectionMatrix();
    DirectLight::Shadow out;
    for (int face = 0; face < 6; ++face) {
        camera.position.set(at[0], at[1], at[2]);
        camera.up.set(kUps[face][0], kUps[face][1], kUps[face][2]);
        camera.lookAt(Vector3(at[0] + kDirections[face][0], at[1] + kDirections[face][1], at[2] + kDirections[face][2]));
        camera.updateMatrixWorld();
        out.faceViews[face] = toArray(camera.matrixWorldInverse);
    }
    Matrix4 matrix;
    matrix.makeTranslation(-at[0], -at[1], -at[2]);
    out.cube = true;
    out.view = out.faceViews[0];
    out.projection = toArray(camera.projectionMatrix);
    out.matrix = toArray(matrix);
    out.virtualShadow = shadow.virtualShadow;
    out.sourceAngleFilter = shadow.sourceAngleFilter;
    out.sourceRadiusFilter = shadow.sourceRadiusFilter;
    out.bias = shadow.bias;
    out.normalBias = shadow.normalBias;
    out.radius = shadow.radius;
    out.intensity = shadow.intensity;
    out.width = out.height = static_cast<uint32_t>(shadow.mapSize.x);
    out.near = camera.near;
    out.far = camera.far;
    out.layersMask = layersMask;
    return out;
}

uint32_t effectiveShadowLayersMask(const Camera& shadowCamera, const Camera& mainCamera) {
    const uint32_t shadowMask = Layers::bits(shadowCamera.layers().mask);
    return (shadowMask & 0xFFFFFFFEu) == 0 ? Layers::bits(mainCamera.layers().mask) : shadowMask;
}

/** How many PbrMaps a material reads: Standard its four, Physical also its specular and clearcoat maps, others none. */
int pbrMapsRead(const Material& material) {
    return material.type == MaterialType::Physical ? shader::kPbrMapCount
           : material.type == MaterialType::Standard ? shader::kStandardPbrMapCount : 0;
}

/** The decoded PbrMaps a standard or physical material reads; none for any other type (refused above). */
std::array<const Texture*, shader::kPbrMapCount> pbrMapsOf(const Material& material) {
    std::array<const Texture*, shader::kPbrMapCount> maps{};
    for (int k = 0; k < pbrMapsRead(material); ++k) {
        const auto found = material.maps.find(shader::kPbrMapNames[k]);
        if (found != material.maps.end() && found->second && found->second->sampleable()) maps[k] = found->second.get();
    }
    return maps;
}

MaterialKind kindOf(MaterialType type) {
    switch (type) {
    case MaterialType::Basic:
        return MaterialKind::Basic;
    case MaterialType::Lambert:
        return MaterialKind::Lambert;
    case MaterialType::Phong:
        return MaterialKind::Phong;
    case MaterialType::Physical:
        return MaterialKind::Physical;
    default:
        return MaterialKind::Standard;
    }
}

// three's MRT (MRTNode.setup): the material's mrtNode output named after the attachment this database draws is written
// there as it is (no setupOutput), so it becomes the draw's fragmentNode. An attachment the mrt() does not name keeps the
// material's own output when it is the target's first texture, and is written zero otherwise.
// ponytail: each attachment is a scene draw of its own (render_target_pass.cpp), N draws for N textures; one pass with
// N colour attachments when an MRT pass costs a frame.
void resolveMrt(shader::MaterialNodes& nodes, const std::string& name, bool primary) {
    if (nodes.mrt.empty()) return;
    for (const auto& slot : nodes.mrt)
        if (slot.name == name) { nodes.fragmentNode = slot.node; return; }
    if (!primary) nodes.fragmentNode = shader::graph::vec4({shader::graph::float_(0.0), shader::graph::float_(0.0),
                                                            shader::graph::float_(0.0), shader::graph::float_(0.0)});
}

shader::StandardMaterial paramsOf(const Material& m) {
    shader::StandardMaterial p;
    p.color = {float(m.color.r), float(m.color.g), float(m.color.b)};
    p.opacity = float(m.opacity);
    p.alphaTest = float(m.alphaTest);
    p.maxPositionOffset = m.maxPositionOffset;
    p.alphaHash = m.alphaHash;
    p.roughness = float(m.roughness);
    p.metalness = float(m.metalness);
    p.envMapIntensity = float(m.envMapIntensity);
    p.emissive = {float(m.emissive.r), float(m.emissive.g), float(m.emissive.b)};
    p.emissiveIntensity = float(m.emissiveIntensity);
    p.specular = {float(m.specular.r), float(m.specular.g), float(m.specular.b)};
    p.shininess = float(m.shininess);
    p.ior = float(m.ior);
    p.specularIntensity = float(m.specularIntensity);
    p.specularColor = {float(m.specularColor.r), float(m.specularColor.g), float(m.specularColor.b)};
    p.subsurfaceColor = {float(m.subsurfaceColor.r), float(m.subsurfaceColor.g), float(m.subsurfaceColor.b)};
    p.clearcoat = float(m.clearcoat);
    p.clearcoatRoughness = float(m.clearcoatRoughness);
    p.bumpScale = float(m.bumpScale);
    p.clearcoatNormalScale = {float(m.clearcoatNormalScale.x), float(m.clearcoatNormalScale.y)};
    p.sheen = float(m.sheen);
    p.transmission = float(m.transmission);
    p.iridescence = float(m.iridescence);
    p.anisotropy = float(m.anisotropy);
    p.dispersion = float(m.dispersion);
    return p;
}

// Every field refresh()'s material half copies, as one value. uniformHash is the batch path's signature: all of
// it but the base colour, which travels per instance. These are the fields that signature leaves out and the
// sampleability of each map (which decides whether a map is bound, and moves with no version bump at all).
std::size_t materialSignature(const Material& m) {
    std::size_t h = projection::detail::uniformHash(m);
    const auto mix = [&h](uint64_t v) { h = (h ^ v) * 0x9e3779b1u; };
    for (double v : {m.color.r, m.color.g, m.color.b, m.subsurfaceColor.r, m.subsurfaceColor.g, m.subsurfaceColor.b}) {
        const auto bits = std::bit_cast<uint64_t>(v == 0 ? 0.0 : v);  // +0 and -0 draw the same
        mix(bits ^ (bits >> 32));
    }
    mix(static_cast<uint64_t>(m.blending));
    mix(m.blendFactors());
    mix(m.shadowSide ? 1 + static_cast<uint64_t>(*m.shadowSide) : 0);
    // Sorted by slot name (a std::map): a renamed slot moves uniformHash, so only the bit can change here.
    for (const auto& entry : m.maps) mix(entry.second && entry.second->sampleable() ? 1 : 0);
    return h;
}

// three draws geometry.instanceCount instances. Per-instance attributes cap it (WebGPU refuses a draw past a
// vertex buffer); a geometry with none (core's projection-skinned reads a storage palette by instanceIndex)
// draws instanceCount as set. ponytail: Infinity with none draws once.
uint32_t instanceCountOf(const BufferGeometry& geometry) {
    uint64_t held = std::numeric_limits<uint64_t>::max();
    for (const auto& [name, attribute] : geometry.attributes) {
        if (!attribute || name == "position" || name == "normal" || name == "uv" || name == "color" ||
            name == "skinIndex" || name == "skinWeight")
            continue;
        if (attribute->perInstance) held = std::min(held, attribute->count());
    }
    double count = geometry.instanceCount;
    if (held != std::numeric_limits<uint64_t>::max()) count = std::min(count, double(held));
    else if (!std::isfinite(count)) count = 1;
    return static_cast<uint32_t>(std::min(count, double(std::numeric_limits<uint32_t>::max())));
}

BufferStore* store(const BufferGeometry& g, const char* name) {
    const auto it = g.attributes.find(name);
    return it == g.attributes.end() || !it->second ? nullptr : it->second->store.get();
}

} // namespace


// The renderer binds position, normal, uv and skin weights as float32. glTF stores quantized models
// with normalized 8/16-bit attributes (GLTFExporter writes int8 normals, WEIGHTS_0 is unsigned byte
// in most files): they reach the shader as a dequantized float32 copy, kept while the source is unchanged.
// three's vertexColors: a material that asks for them reads the geometry's `color` attribute (3 or 4
// components); without the attribute three draws the plain colour, and so does this. A TSL
// attribute("color") reads the attribute whatever vertexColors says, so the store is kept either way.
void RenderDatabase::vertexColorsOf(const BufferGeometry& geometry, const Material& material, DrawItem& d) {
    d.colors = nullptr;
    d.colorSize = 0;
    const auto it = geometry.attributes.find("color");
    if (it == geometry.attributes.end() || !it->second) return;
    d.colors = floatStore(geometry, "color");
    if (!material.vertexColors) return;
    if (it->second->itemSize != 3 && it->second->itemSize != 4)
        throw std::runtime_error("TN_NATIVE_VERTEX_COLORS_UNSUPPORTED: a color attribute of " +
                                 std::to_string(it->second->itemSize) + " components");
    d.colorSize = static_cast<uint8_t>(it->second->itemSize);
}

// The geometry's attributes beyond the ones the programs name (a TSL attribute() reads them), and an
// InstancedBufferGeometry's instance count: instanceCount, at most what its per-instance attributes
// hold, as three's WebGL backend clamps it (_maxInstanceCount).
// A skinned mesh feeds skinIndex and skinWeight to three's skinning(); on any other mesh they are ordinary
// attributes a TSL attribute() reads (procedural-animals' DQS skin), so they join the list as float copies.
void RenderDatabase::geometryInputsOf(const BufferGeometry& geometry, DrawItem& d, bool skinned) {
    d.geometryBox = geometry.boundingBox ? std::optional<Box3>(*geometry.boundingBox) : std::nullopt;
    d.attributes->clear();
    for (const auto& [name, attribute] : geometry.attributes) {
        if (!attribute || name == "position" || name == "normal" || name == "uv" || name == "color" ||
            (skinned && (name == "skinIndex" || name == "skinWeight")))
            continue;
        d.attributes->push_back({name, floatStore(geometry, name.c_str()), attribute->perInstance});
    }
    if (geometry.instanced) d.instanceCount = instanceCountOf(geometry);
}

// three's render list keys a draw by the world position of its geometry's bounding-sphere centre
// (renderers/common/StandardDrawingPipeline.js:236-241), computing the sphere on the first frame that needs
// it, exactly as projectObject does. That is not the object's origin: a geometry whose vertices sit
// off-centre, such as a waterfall's arc, ranks the other way round, and the wrong transparent order draws
// the pale inner sheet over the outer one.
void RenderDatabase::sortCenterOf(const BufferGeometry& geometry, DrawItem& d) {
    const auto position = geometry.getAttribute("position");
    if (!position) return;  // no vertices to centre on: the object origin stays the key
    if (const Sphere* sphere = geometry.boundingSphere.get()) {  // already computed: one copy, no pass
        d.sortCenter = std::array<double, 3>{sphere->center.x, sphere->center.y, sphere->center.z};
        return;
    }
    // BufferGeometry.js:1074-1080: the sphere is centred on the box, so the box centre is the key. A material
    // edited every frame refreshes its draw every frame; the centre moves only with the vertices.
    if (geometry.sortCenterRevision_ != geometry.revision() || geometry.sortCenterVersion_ != position->version()) {
        Box3 box;
        Vector3 point, center;
        box.makeEmpty();
        for (uint64_t i = 0, count = position->count(); i < count; ++i) box.expandByPoint(position->getXYZ(i, point));
        box.getCenter(center);
        geometry.sortCenter_ = {center.x, center.y, center.z};
        geometry.sortCenterRevision_ = geometry.revision();
        geometry.sortCenterVersion_ = position->version();
        ++projection::detail::sortCenterPassCount();
    }
    d.sortCenter = geometry.sortCenter_;
}

// three's polygonOffset as WebGPUPipelineUtils sets it: depthBias = units, slope scale = factor.
void RenderDatabase::depthBiasOf(const Material& material, DrawItem& d) {
    d.depthBias = material.polygonOffset ? static_cast<int32_t>(material.polygonOffsetUnits) : 0;
    d.depthBiasSlopeScale = material.polygonOffset ? static_cast<float>(material.polygonOffsetFactor) : 0.0f;
}

BufferStore* RenderDatabase::floatStore(const BufferGeometry& g, const char* name) {
    const auto it = g.attributes.find(name);
    return it == g.attributes.end() || !it->second ? nullptr : floatStore(*it->second);
}

BufferStore* RenderDatabase::floatStore(const BufferAttribute& attribute) {
    if (attribute.store->scalar() == Scalar::F32) return attribute.store.get();
    // Entries whose source is gone are dropped once the table doubles, so a scene that loads and
    // unloads geometry does not keep their copies.
    if (converted_.size() >= convertedSweepAt_) {
        for (auto entry = converted_.begin(); entry != converted_.end();)
            entry = entry->second.source.expired() ? converted_.erase(entry) : std::next(entry);
        convertedSweepAt_ = std::max<std::size_t>(64, converted_.size() * 2);
    }
    Converted& copy = converted_[&attribute];
    const auto source = copy.source.lock();
    if (!copy.store || copy.version != attribute.version() || source != attribute.store) {
        const uint64_t items = attribute.count() * static_cast<uint64_t>(attribute.itemSize);
        std::vector<float> values;
        values.reserve(items);
        for (uint64_t i = 0; i < attribute.count(); ++i)
            for (int c = 0; c < attribute.itemSize; ++c)
                values.push_back(static_cast<float>(attribute.getComponent(i, c)));
        copy.store = std::make_shared<BufferStore>(Scalar::F32, items);
        copy.store->write(0, values.data(), values.size() * sizeof(float));
        copy.version = attribute.version();
        copy.source = attribute.store;
    }
    return copy.store.get();
}

RenderDatabase::Record* RenderDatabase::findRecord(const Object3D& object, bool insert) {
    constexpr uint64_t kIdSlots = uint64_t(1) << 20;  // ponytail: later ids keep the hash; a map if games pass it
    const uint64_t id = object.id();
    Record** slot = nullptr;
    if (id < kIdSlots) {
        if (id >= byId_.size()) byId_.resize(std::min(std::max(id + 1, uint64_t(byId_.size()) * 2), kIdSlots), nullptr);
        slot = &byId_[id];
        if (*slot) return *slot;
    }
    ++recordLookups_;
    Record* found = nullptr;
    if (insert) {
        found = &records_[&object];
    } else if (const auto it = records_.find(&object); it != records_.end()) {
        found = &it->second;
    }
    if (slot) *slot = found;
    if (slot && found) found->cacheId = id;
    return found;
}

RenderDatabase::Record& RenderDatabase::record(const Mesh& mesh, bool materialize) {
    return record(mesh, *findRecord(mesh, true), materialize);
}

RenderDatabase::Record& RenderDatabase::record(const Mesh& mesh, Record& r, bool materialize) {
    const Material* material = mesh.material.get();
    const uint64_t geometryRevision = mesh.geometry ? mesh.geometry->revision() : 0;
    const uint32_t materialVersion = material ? material->version() : 0;
    // Copies whose geometry bytes are equal draw from one of them (projection::contentClassOf), so their
    // buffers are the same stores and the batch passes below fold them into one instanced draw. A rig
    // keeps its own: the skinned lane groups by geometry identity, as core's does.
    const bool merges = mesh.geometry && typeid(mesh) != typeid(SkinnedMesh);
    const BufferGeometry* drawn = merges ? projection::contentClassOf(mesh.geometry).drawn : mesh.geometry.get();
    const bool cached = r.drawable && r.meshId == mesh.id() && r.geometry == mesh.geometry &&
                        r.geometryRevision == geometryRevision && r.material.get() == material &&
                        r.materialVersion == materialVersion && r.canonical.get() == drawn;
    auto& diagnostic = Material::diagnostics();
    if (!cached) {
        Material::DiagnosticTimer rebuildTimer(diagnostic.enabled, diagnostic.recordCpuNs);
        if (diagnostic.enabled) ++diagnostic.recordRebuilds;
        ++rebuilds_;
        const uint64_t cacheId = r.cacheId;
        r = Record{};
        r.cacheId = cacheId;
        r.meshId = mesh.id();
        r.geometry = mesh.geometry;
        r.canonical = merges ? projection::canonicalGeometry(mesh.geometry) : mesh.geometry;
        r.geometryRevision = geometryRevision;
        r.material = mesh.material;
        r.materialVersion = materialVersion;
        if (!mesh.geometry || !material)
            return r;
        if (const auto unsupported = shader::unsupportedFeatures(paramsOf(*material)); !unsupported.empty()) {
            for (const std::string& u : unsupported)
                diagnostics_.push_back("TN_NATIVE_MATERIAL_UNSUPPORTED " + std::string(material->typeName()) + ": " +
                                       u);
            return r;
        }
        // A decoded map the standard program does not read is refused by name, never drawn without it.
        // (A placeholder with no image was already refused where models load.)
        for (const auto& [slot, texture] : material->maps) {
            // envMap is read through the PMREM path below (a sphere reflection capture sets it).
            if (!texture || !texture->sampleable() || slot == "map" || slot == "normalMap" || slot == "envMap")
                continue;
            const auto pbr = std::find(std::begin(shader::kPbrMapNames), std::end(shader::kPbrMapNames), slot);
            if (pbr - std::begin(shader::kPbrMapNames) < pbrMapsRead(*material)) continue;
            diagnostics_.push_back("TN_NATIVE_MATERIAL_UNSUPPORTED " + std::string(material->typeName()) + ": " + slot +
                                   " is not read by the native standard program");
            return r;
        }
        if (const auto normal = material->maps.find("normalMap");
            normal != material->maps.end() && normal->second && normal->second->sampleable() &&
            !store(*r.canonical, "uv")) {
            diagnostics_.push_back("TN_NATIVE_MATERIAL_UNSUPPORTED " + std::string(material->typeName()) +
                                   ": normalMap needs a uv attribute (drawn without it)");
        }
        for (int k = 0; k < pbrMapsRead(*material); ++k)
            if (const auto map = material->maps.find(shader::kPbrMapNames[k]); map != material->maps.end() &&
                map->second && map->second->sampleable() && !store(*r.canonical, "uv"))
                diagnostics_.push_back("TN_NATIVE_MATERIAL_UNSUPPORTED " + std::string(material->typeName()) + ": " +
                                       shader::kPbrMapNames[k] + " needs a uv attribute (drawn without it)");
        const BufferGeometry& geometry = *r.canonical;
        r.buffers = {floatStore(geometry, "position"), floatStore(geometry, "normal"), floatStore(geometry, "uv"),
                     geometry.index ? geometry.index->store.get() : nullptr};
        for (const auto& [name, attribute] : {std::pair{"skinIndex", &r.skinIndex}, std::pair{"skinWeight", &r.skinWeight}})
            if (const auto it = geometry.attributes.find(name); it != geometry.attributes.end()) *attribute = it->second.get();
        // Match three's (0, 1, 0) fallback: geometry roughness still reads it when normalNode overrides lighting.
        // Flat shading instead derives its normals from position derivatives.
        if (!r.buffers[1] && r.buffers[0] && !material->flatShading && !material->nodes.fragmentNode &&
            kindOf(material->type) != MaterialKind::Basic) {
            r.zeroNormals = std::make_shared<BufferStore>(Scalar::F32, r.buffers[0]->count());
            std::vector<float> normals(r.buffers[0]->count(), 0);
            for (uint64_t i = 1; i < normals.size(); i += 3) normals[i] = 1;
            r.zeroNormals->write(0, normals.data(), normals.size() * sizeof(float));
            r.buffers[1] = r.zeroNormals.get();
        }
        r.drawable = r.buffers[0] != nullptr;
    }
    if (!materialize || !r.drawable)
        return r;
    if (r.draw) {
        r.draw->item.matrixWorld = toArray(mesh.matrixWorld);
        r.draw->item.renderOrder = mesh.renderOrder();
        // A game moves an InstancedBufferGeometry's instanceCount every frame (Midway's particles).
        if (mesh.geometry && mesh.geometry->instanced) geometryInputsOf(*mesh.geometry, r.draw->item, mesh.type() == "SkinnedMesh");
        indirectOf(mesh, r.draw->item);
        return r;
    }
    r.draw = std::make_unique<Record::Draw>();
    r.materialized = true;
    DrawItem& d = r.draw->item;
    d.cache = &r.cache;
    d.nodes = &r.draw->nodes;
    d.attributes = &r.draw->attributes;
    d.key = d.id = mesh.id();
    d.positions = r.buffers[0];
    d.normals = r.buffers[1];
    d.uvs = r.buffers[2];
    d.indices = r.buffers[3];
    indirectOf(mesh, d);
    // The diffuse map is sampled only when its image is decoded and the geometry carries uv; an
    // image-less glTF placeholder (source only) keeps drawing its flat colour as before.
    if (d.uvs != nullptr) {
        const auto found = material->maps.find("map");
        if (found != material->maps.end() && found->second && found->second->sampleable())
            d.map = found->second.get();
        const auto normal = material->maps.find("normalMap");
        if (normal != material->maps.end() && normal->second && normal->second->sampleable())
            d.normalMap = normal->second.get();
        d.pbrMaps = pbrMapsOf(*material);
    }
    d.aoMapIntensity = material->aoMapIntensity;
    d.normalScaleX = material->normalScale.x;
    d.normalScaleY = material->normalScale.y;
    vertexColorsOf(*r.canonical, *material, d);
    depthBiasOf(*material, d);
    geometryInputsOf(*r.canonical, d, mesh.type() == "SkinnedMesh");
    sortCenterOf(*r.canonical, d);
    d.matrixWorld = toArray(mesh.matrixWorld);
    r.draw->nodes = material->nodes;
    resolveMrt(r.draw->nodes, mrtName, mrtPrimary);
    d.kind = r.draw->nodes.fragmentNode ? MaterialKind::Basic : kindOf(material->type);
    d.renderOrder = mesh.renderOrder();
    d.transparent = material->transparent;
    d.forceSinglePass = material->forceSinglePass;
    d.depthWrite = material->depthWrite;
    d.depthTest = material->depthTest;
    d.colorWrite = material->colorWrite;
    d.materialKey = material;
    d.positionNode = material->positionNode;
    d.side = static_cast<uint8_t>(material->side);
    d.shadowSide = material->shadowSide ? static_cast<uint8_t>(*material->shadowSide) : 255;
    d.flatShading = material->flatShading;
    d.twoSidedFoliage = material->twoSidedFoliage;
    d.roughDiffuse = material->roughDiffuse;
    d.blending = static_cast<uint8_t>(material->blending);
    d.blendFactors = material->blendFactors();
    r.drawable = d.positions != nullptr;
    return r;
}

DrawItem& RenderDatabase::refresh(const Mesh& mesh, Record& r) {
    auto& d = r.draw->item;
    d.cache = &r.cache;  // the record owns the cache; refresh the pointer in case the record moved
    // The material half below is ~45 field writes, the uniform struct, the node graph and the attribute list:
    // all of it the same until the material or the geometry moves. Guarded by the uniform signature, not the
    // material's version: three lets `material.roughness = x` change without bumping one (see uniformHash's
    // epoch), so the signature is the only honest guard. The geometry revision covers the attribute list and
    // the vertex colours; the canonical geometry is the one the attributes are read from.
    const uint64_t revision = r.canonical ? r.canonical->revision() : 0;
    const std::size_t signature = materialSignature(*r.material);
    if (!r.materialResolved || r.materialSignature != signature || r.refreshRevision != revision) {
        r.materialResolved = true;
        r.materialSignature = signature;
        r.refreshRevision = revision;
        ++projection::detail::materialRefreshCount();
        r.draw->params = paramsOf(*r.material);
        d.material = &r.draw->params;
        d.transparent = r.material->transparent;
        d.forceSinglePass = r.material->forceSinglePass;
        d.depthWrite = r.material->depthWrite;
        d.depthTest = r.material->depthTest;
        d.colorWrite = r.material->colorWrite;
        d.side = static_cast<uint8_t>(r.material->side);
        d.shadowSide = r.material->shadowSide ? static_cast<uint8_t>(*r.material->shadowSide) : 255;
        d.flatShading = r.material->flatShading;
        d.twoSidedFoliage = r.material->twoSidedFoliage;
        d.roughDiffuse = r.material->roughDiffuse;
        d.blending = static_cast<uint8_t>(r.material->blending);
        d.blendFactors = r.material->blendFactors();
        d.positionNode = r.material->positionNode;
        ++projection::detail::materialNodeCopyCount();
        r.draw->nodes = r.material->nodes;
        resolveMrt(r.draw->nodes, mrtName, mrtPrimary);
        d.kind = r.draw->nodes.fragmentNode ? MaterialKind::Basic : kindOf(r.material->type);
        d.nodes = &r.draw->nodes;
        d.map = nullptr;
        d.normalMap = nullptr;
        d.pbrMaps = {};
        if (d.uvs) {
            const auto map = r.material->maps.find("map");
            if (map != r.material->maps.end() && map->second && map->second->sampleable())
                d.map = map->second.get();
            const auto normal = r.material->maps.find("normalMap");
            if (normal != r.material->maps.end() && normal->second && normal->second->sampleable())
                d.normalMap = normal->second.get();
            d.pbrMaps = pbrMapsOf(*r.material);
        }
        d.aoMapIntensity = r.material->aoMapIntensity;
        d.normalScaleX = r.material->normalScale.x;
        d.normalScaleY = r.material->normalScale.y;
        if (r.canonical) vertexColorsOf(*r.canonical, *r.material, d);
        depthBiasOf(*r.material, d);
        if (r.canonical) geometryInputsOf(*r.canonical, d, mesh.type() == "SkinnedMesh");
        if (r.canonical) sortCenterOf(*r.canonical, d);
        // A non-float colour or custom attribute reaches the draw as a converted copy that `needsUpdate` replaces
        // without moving the geometry revision: such a record re-reads those inputs every frame, as before FM1.
        r.convertedInputs = false;
        if (r.canonical)
            for (const auto& [name, attribute] : r.canonical->attributes)
                if (attribute && name != "position" && name != "normal" && name != "uv" && name != "skinIndex" &&
                    name != "skinWeight" && attribute->store->scalar() != Scalar::F32)
                    r.convertedInputs = true;
    } else if (r.convertedInputs) {
        vertexColorsOf(*r.canonical, *r.material, d);
        geometryInputsOf(*r.canonical, d, mesh.type() == "SkinnedMesh");
    }
    // An InstancedBufferGeometry's instanceCount moves freely (a game counts its particles per frame), and a
    // mesh's own count is read below, so a held material half still reads this one.
    if (r.canonical && r.canonical->instanced) d.instanceCount = instanceCountOf(*r.canonical);
    d.castShadow = mesh.castShadow();
    d.receiveShadow = mesh.receiveShadow();
    d.shadowObject = &mesh;
    d.layers = Layers::bits(mesh.layers().mask);
    d.mainPass = true;
    return d;
}

const RenderDatabase::GraphSources& RenderDatabase::graphSources(const Material& material) {
    static const GraphSources none;
    std::array<const void*, shader::kMaterialGraphRoots> roots{};
    const auto graphs = material.nodes.pointers();
    static_assert(decltype(graphs){}.size() == decltype(roots){}.size(), "a node slot was added to MaterialNodes");
    std::copy(graphs.begin(), graphs.end(), roots.begin());
    if (std::all_of(roots.begin(), roots.end(), [](const void* root) { return root == nullptr; }) && material.nodes.mrt.empty()) return none;
    GraphSources& cached = graphSources_[&material];
    if (cached.roots != roots || cached.version != material.version()) {
        auto& diagnostic = Material::diagnostics();
        Material::DiagnosticTimer rebuildTimer(diagnostic.enabled, diagnostic.graphCpuNs);
        if (diagnostic.enabled) ++diagnostic.graphRebuilds;
        GraphFind found = findGraphSources(material);
        cached = GraphSources{material.version(), roots, found.texture, std::move(found.reflectors), {},
                              std::move(found.textures), std::move(found.textureNodes), std::move(found.storages)};
        cached.reflectorViews.reserve(cached.reflectors.size());
        for (const auto& [name, mirror] : cached.reflectors)
            cached.reflectorViews.push_back(GraphReflector{name, mirror.get()});
    }
    for (size_t i = 0; i < cached.textureNodes.size(); ++i)
        cached.textures[i].second = static_cast<const Texture*>(cached.textureNodes[i]->textureObject().get());
    return cached;
}

// three's Frustum.intersectsObject / intersectsSprite: the object's world bounding sphere against
// this prepare's camera frustum. InstancedMesh uses its instance-aware sphere, computed once when
// null, as three does.
bool RenderDatabase::boundingSphereOf(Object3D& object, std::string_view type, Sphere& sphere) {
    ++sphereMeasures_;
    if (type == "Sprite") {
        sphere.set(Vector3(0, 0, 0), 0.7071067811865476);
    } else if (type == "InstancedMesh") {
        auto& instanced = static_cast<InstancedMesh&>(object);
        if (instanced.boundingSphere == nullptr) instanced.computeBoundingSphere();
        if (instanced.boundingSphere == nullptr) return false;
        sphere.copy(*instanced.boundingSphere);
    } else if (type == "SkinnedMesh") {
        // three reads `SkinnedMesh.boundingSphere`, computed from the posed vertices. A pose can reach
        // far past the bind pose, so only the posed bound may cull: `rigCastsShadow` asks it, and this
        // answer keeps the main camera's culling where it was, none.
        return false;
    } else {
        auto& mesh = static_cast<Mesh&>(object);
        // ponytail: a morphed mesh relies on morph targets, whose posed bounds native does not measure
        // (three's geometry sphere ignores them too; this is stricter). Add one when it draws off screen.
        if (mesh.geometry == nullptr ||
            (!mesh.geometry->morphPositions.empty() && !mesh.morphTargetInfluences.empty()))
            return false;
        if (mesh.geometry->boundingSphere == nullptr) mesh.geometry->computeBoundingSphere();
        if (mesh.geometry->boundingSphere == nullptr) return false;
        sphere.copy(*mesh.geometry->boundingSphere);
    }
    sphere.applyMatrix4(object.matrixWorld);
    return true;
}

// `sphere` is the object's world bounding sphere, null when it has none (it then always casts).
bool RenderDatabase::inShadowFrustum(const Object3D& object, const Sphere* sphere) {
    // ponytail: point light shadow culling across 6 faces omitted; keep casters unculled when a point shadow is present
    // Virtual windows replace the source shadow camera; the atlas culls casters per page.
    if (shadowPointLightActive_ || virtualShadows_) return true;
    if (shadowFrustums_.empty()) return false;
    if (!sphere) return true;
    const uint32_t mask = Layers::bits(object.layers().mask);
    for (const auto& sf : shadowFrustums_) {
        if ((mask & sf.layersMask) != 0 && sf.frustum.intersectsSphere(*sphere)) return true;
    }
    return false;
}

bool RenderDatabase::bonesOnly(const Object3D& bone) {
    BoneChain& chain = boneChains_[&bone];
    chain.seen = frame_;
    if (chain.id == bone.id() && chain.version == bone.subtreeVersion()) return chain.bonesOnly;
    const auto walk = [](const auto& self, const Object3D& node) -> bool {
        if (typeid(node) != typeid(Bone)) return false;
        for (const Object3D* child : node.children)
            if (!self(self, *child)) return false;
        return true;
    };
    chain = {bone.id(), bone.subtreeVersion(), frame_, walk(walk, bone)};
    return chain.bonesOnly;
}

// A rig's shadow bound, cheapest first. A rig no shadow frustum's layers see never casts, and that
// answer needs no bound. Its bind-pose sphere proves it inside one without reading a bone. Only when
// that misses does the posed reach decide: O(bones) per frame, and it publishes a deferred pose and
// joins its palette, which `gpu_joint_production` counts. A reach nothing can place always casts,
// because the bind pose alone would wrongly cull a rig whose pose reaches into the box.
bool RenderDatabase::rigCastsShadow(Object3D& object) {
    if (shadowPointLightActive_ || virtualShadows_) return true;
    if (shadowFrustums_.empty()) return false;
    const uint32_t mask = Layers::bits(object.layers().mask);
    if (std::none_of(shadowFrustums_.begin(), shadowFrustums_.end(),
                     [&](const ShadowFrustum& sf) { return (mask & sf.layersMask) != 0; }))
        return false;
    auto& rig = static_cast<SkinnedMesh&>(object);
    Sphere sphere;
    const auto inside = [&] {
        sphere.applyMatrix4(object.matrixWorld);
        return inShadowFrustum(object, &sphere);
    };
    if (rig.geometry) {
        if (rig.geometry->boundingSphere == nullptr) rig.geometry->computeBoundingSphere();
        if (rig.geometry->boundingSphere != nullptr) {
            sphere.copy(*rig.geometry->boundingSphere);
            if (inside()) return true;
        }
    }
    // A detached bind keeps `bindMatrixInverse` off the mesh's own world matrix, so the reach is not in
    // this object's space; a bound nothing can place keeps the rig a caster.
    Box3 reach;
    if (!rig.attached || !rig.boneReachBounds(reach) || reach.isEmpty()) return true;
    Vector3 centre, size;
    reach.getCenter(centre);
    reach.getSize(size);
    sphere.set(centre, size.length() * 0.5);
    return inside();
}

void RenderDatabase::collectShadowFrustums(Object3D& root, const Camera& mainCamera) {
    shadowFrustums_.clear();
    shadowByLight_.clear();
    shadowPointLightActive_ = false;
    if (!shadowMapEnabled) return;

    if (shadowLightsRoot_ != &root || shadowLightsVersion_ != Object3D::hierarchyVersion()) {
        shadowLightsRoot_ = &root;
        shadowLightsVersion_ = Object3D::hierarchyVersion();
        shadowLights_.clear();
        auto collect = [&](auto& self, Object3D& obj) -> void {
            const std::string_view type = obj.type();
            if (type == "DirectionalLight" || type == "SpotLight" || type == "PointLight") shadowLights_.push_back(&obj);
            for (Object3D* child : obj.children)
                if (child) self(self, *child);
        };
        collect(collect, root);
    }
    for (Object3D* light : shadowLights_) {
        // The walk skipped invisible subtrees: a light counts only if it and every ancestor are visible.
        const Object3D* node = light;
        while (node->visible() && node != &root) node = node->parent;
        if (!node->visible()) continue;
        // project() collects a light only if the camera's layers see it: an unseen light's shadow is
        // never drawn, so its casters are not gathered either (a mirror pass on its own layer sees none).
        if (reuseMainFrame && !light->layers().test(mainCamera.layers())) continue;
        Object3D& obj = *light;
        const std::string_view type = obj.type();
        if (type == "DirectionalLight") {
            auto& l = static_cast<DirectionalLight&>(obj);
            if (l.castShadow()) {
                const auto from = worldPosition(l), to = worldPosition(*l.target);
                Frustum f;
                const uint32_t mask = effectiveShadowLayersMask(*l.shadow.camera, mainCamera);
                shadowByLight_[&l] = shadowOf(l.shadow, from, to, mask, &f);
                shadowFrustums_.push_back({f, mask});
            }
        } else if (type == "SpotLight") {
            auto& l = static_cast<SpotLight&>(obj);
            if (l.castShadow()) {
                constexpr double kRadToDeg = 180.0 / 3.14159265358979323846;
                auto& shadowCamera = static_cast<PerspectiveCamera&>(*l.shadow.camera);
                shadowCamera.fov = kRadToDeg * 2 * l.angle * l.shadow.focus;
                shadowCamera.aspect = (l.shadow.mapSize.x / l.shadow.mapSize.y) * l.shadow.aspect;
                shadowCamera.far = l.distance != 0 ? l.distance : shadowCamera.far;
                const auto from = worldPosition(l), to = worldPosition(*l.target);
                Frustum f;
                const uint32_t mask = effectiveShadowLayersMask(shadowCamera, mainCamera);
                shadowByLight_[&l] = shadowOf(l.shadow, from, to, mask, &f);
                shadowFrustums_.push_back({f, mask});
            }
        } else if (type == "PointLight") {
            auto& l = static_cast<PointLight&>(obj);
            if (l.castShadow()) {
                // ponytail: point light shadow culling across 6 faces omitted; keep casters unculled when a point light casts shadows
                shadowPointLightActive_ = true;
            }
        }
    }
}

void RenderDatabase::projectGroups(const Mesh& mesh, const Camera& camera, std::vector<DrawItem>& items,
                                   LightState& lights, const Object3D* excluded) {
    if (!mesh.geometry) return;
    const auto& groups = mesh.geometry->groups;
    const auto& views = mesh.geometry->groupViews();
    mesh.groupMeshes.resize(views.size());
    for (std::size_t i = 0; i < views.size(); ++i) {
        // three skips a group whose material is missing, and a mesh with an array and no groups draws nothing.
        const double slot = std::floor(groups[i].materialIndex);
        if (!views[i] || !(slot >= 0 && slot < static_cast<double>(mesh.materials.size())) ||
            !mesh.materials[static_cast<std::size_t>(slot)])
            continue;
        std::shared_ptr<Mesh>& part = mesh.groupMeshes[i];
        if (!part) part = std::make_shared<Mesh>();
        part->geometry = views[i];
        part->material = mesh.materials[static_cast<std::size_t>(slot)];
        part->matrixWorld.copy(mesh.matrixWorld);
        part->frustumCulled = mesh.frustumCulled;
        part->setVisible(true);  // the mesh's own visibility was tested before this call
        part->setCastShadow(mesh.castShadow());
        part->setReceiveShadow(mesh.receiveShadow());
        part->setRenderOrder(mesh.renderOrder());
        part->setLayerMask(mesh.layers().mask);
        project(*part, camera, items, lights, false, false, nullptr, true, false, excluded);
    }
}

void RenderDatabase::project(Object3D& object, const Camera& camera, std::vector<DrawItem>& items, LightState& lights,
                             bool updateChildren, bool force, Record* cached, bool plainMesh, bool lightsOnly, const Object3D* excluded) {
    if (&object == excluded) return;
    ++projectVisits_;
    if (object.skipsGpuJointSubtree()) { ++Object3D::gpuProjectionVisits_; return; }
    // A skeleton's bones are matrices for its rigs, not scene draws: Unreal keeps them in the mesh component
    // (UE 5.8.3: Engine/Source/Runtime/Engine/Private/SkeletalRender.cpp:524) and the scene walks only primitives.
    if (typeid(object) == typeid(Bone) && bonesOnly(object)) return;
    if (!object.visible()) {
        if (updateChildren)
            for (Object3D* child : object.children)
                child->updateMatrixWorld(force);
        return;
    }
    // A plain Group or Object3D draws and lights nothing and holds no record: only its children matter.
    const bool plainNode = typeid(object) == typeid(Group) || typeid(object) == typeid(Object3D);
    bool mainPass = !plainNode && object.layers().test(camera.layers());
    bool shadowCaster = !plainNode && shadowMapEnabled && object.castShadow();
    if (plainNode) {
    } else if (mainPass || shadowCaster) {
        const std::string_view type = plainMesh ? "Mesh" : object.type();
        if (!lightsOnly && type == "LOD") {
            if (mainPass) {
                auto& lod = static_cast<LOD&>(object);
                if (lod.autoUpdate) lod.update(camera);
            }
        }
        if (!lightsOnly && type == "Mesh" && !static_cast<const Mesh&>(object).materials.empty()) {
            projectGroups(static_cast<const Mesh&>(object), camera, items, lights, excluded);
        } else if (!lightsOnly && (type == "Mesh" || type == "InstancedMesh" || type == "SkinnedMesh" || type == "Sprite" || type == "Line" ||
            type == "LineSegments" || type == "Points")) {
            const auto& mesh = static_cast<const Mesh&>(object);
            if (mesh.frustumCulled && !cullExempt_) {
                waste::debugAdd(waste::counters().cullCandidates);
                // One world sphere serves the camera's frustum and the shadow frustums.
                Sphere sphere;
                bool bounded = false, measured = false;
                const auto measure = [&] {
                    if (!measured) bounded = boundingSphereOf(object, type, sphere), measured = true;
                    return bounded;
                };
                // A compile pass keeps what the eye cannot see yet: a turn must not meet its first pipeline mid-frame
                // (UE 5.8.3: Engine/Source/Runtime/Engine/Private/PSOPrecache.cpp:230 precaches a primitive's PSOs when it
                // enters the scene, not when it enters the view).
                if (mainPass && !compiling_ && measure() && !frustum_.intersectsSphere(sphere)) mainPass = false;
                if (shadowCaster && !compiling_)
                    shadowCaster = type == "SkinnedMesh" ? rigCastsShadow(object)
                                                         : inShadowFrustum(object, measure() ? &sphere : nullptr);
            }
            if (!mainPass && !shadowCaster) {
                if (mesh.frustumCulled && !cullExempt_) waste::debugAdd(waste::counters().culledObjects);
                // Outside every frustum: keep its record alive and build nothing (PRD-610 AC-10).
                if (Record* r = cached ? (cached->meshId == mesh.id() ? cached : nullptr) : findRecord(mesh, false))
                    markSeen(*r);
            } else {
                const bool compact = batching && type == "Mesh" && mesh.geometry && mesh.material && !mesh.onBeforeRender &&
                                     !mesh.material->transparent && !mesh.material->vertexColors && !mesh.material->positionNode &&
                                     !mesh.material->nodes.positionNode && !mesh.material->nodes.vertexNode &&
                                     !mesh.geometry->instanced &&
                                     (mesh.geometry->morphPositions.empty() || mesh.morphTargetInfluences.empty()) &&
                                     mesh.matrixWorld.determinant() > 0;
                // A virtual shadow culls and detects movers per caster, so a caster keeps its own
                // shadow-only item (own key, own bounds); its main-pass draw still joins the batch.
                const bool pageCaster = compact && virtualShadows_ && shadowCaster;
                Record& r = cached ? record(mesh, *cached, !compact || pageCaster) : record(mesh, !compact || pageCaster);
                markSeen(r);
                if (r.drawable && r.material->visible && (mainPass || shadowCaster)) {
                    if (compact && !pageCaster) {
                        addBatchMesh(mesh, r, mainPass, shadowCaster);
                    } else if (pageCaster) {
                        if (mainPass) addBatchMesh(mesh, r, true, false);
                        DrawItem& d = refresh(mesh, r);
                        d.batchable = false;
                        d.mainPass = false;
                        d.castShadow = true;
                        d.layers = Layers::bits(mesh.layers().mask);
                        d.morphGeometry = nullptr;
                        d.morphInfluences = nullptr;
                        items.push_back(d);
                    } else {
                        DrawItem& d = refresh(mesh, r);
                        d.batchable = false;
                        d.mainPass = mainPass;
                        d.castShadow = shadowCaster;
                        d.layers = Layers::bits(mesh.layers().mask);
                        const bool morphed = !mesh.geometry->morphPositions.empty() && !mesh.morphTargetInfluences.empty();
                        d.morphGeometry = morphed ? mesh.geometry.get() : nullptr;
                        d.morphInfluences = morphed ? &mesh.morphTargetInfluences : nullptr;
                        if (morphed)
                            d.batchable = false;
                        items.push_back(d);
                        if (type == "SkinnedMesh") {
                            // three's skinning() updates each skeleton once per frame before its first draw.
                            const auto& skinned = static_cast<const SkinnedMesh&>(mesh);
                            DrawItem& d = items.back();
                            d.skinnedRig = static_cast<SkinnedMesh*>(&object);
                            d.skinIndices = r.skinIndex ? r.skinIndex->store.get() : nullptr;
                            d.skinWeights = r.skinWeight ? floatStore(*r.skinWeight) : nullptr;
                            if (skinned.skeleton && d.skinIndices && d.skinWeights) {
                                const void* skeleton = skinned.skeleton.get();
                                const bool gpu = gpuJoints_ && *gpuJoints_->valid && gpuJoints_->byMesh.count(&skinned);
                                if (!gpu && (skeletonsFresh_ == nullptr || skeletonsFresh_->count(skeleton) == 0) &&
                                    skeletonsUpdated_.insert(skeleton).second)
                                    skinned.skeleton->deferWorldPalette(worldsFreshSince_);
                                d.boneMatrices = &skinned.skeleton->boneMatrices;
                                d.bindMatrix = toArray(skinned.bindMatrix);
                                d.bindMatrixInverse = toArray(skinned.bindMatrixInverse);
                                if (gpu) {
                                    const auto index = gpuJoints_->byMesh.at(&skinned);
                                    auto& saved = gpuJoints_->rigs[index];
                                    const auto placement = saved.placement.lock();
                                    auto* matrices = reinterpret_cast<float*>(saved.instances->data());
                                    for (int k = 0; k < 16; ++k) matrices[k] = float(placement->matrixWorld.elements[k]);
                                    saved.instances->needsUpdate();
                                    d.sortOrigin = {d.matrixWorld[12], d.matrixWorld[13], d.matrixWorld[14]};
                                    d.matrixWorld = Matrix4{}.elements;
                                    d.bindMatrix = d.bindMatrixInverse = Matrix4{}.elements;
                                    d.instanceMatrices = saved.instances.get(); d.instanceCount = 1;
                                    d.boneStride = uint32_t(skinned.skeleton->bones.size());
                                    d.gpuJoints = gpuJoints_; d.gpuJointRig = index;
                                } else { d.gpuJoints.reset(); d.boneStride = 0; }

                            }
                        }
                        if (type == "InstancedMesh") {
                            // Read every frame, as three does: count changes and setColorAt's first call (which
                            // creates the colour attribute) need no record rebuild.
                            const auto& instanced = static_cast<const InstancedMesh&>(mesh);
                            DrawItem& d = items.back();
                            d.instanceMatrices = instanced.instanceMatrix->store.get();
                            d.instanceColors = instanced.instanceColor ? instanced.instanceColor->store.get() : nullptr;
                            d.instanceCount = static_cast<uint32_t>(
                                std::min<uint64_t>(instanced.count, instanced.instanceMatrix->count()));
                        }
                        if (type == "Line" || type == "LineSegments") {
                            DrawItem& d = items.back();
                            d.topology = type == "Line" ? WGPUPrimitiveTopology_LineStrip : WGPUPrimitiveTopology_LineList;
                            d.castShadow = false;  // ponytail: three's shadow pass draws lines; no corpus line casts one
                            if (!mainPass) items.pop_back();
                        }
                        if (type == "Points") {
                            DrawItem& d = items.back();
                            // three's WebGPU topology for a Points object (WebGPUUtils.getPrimitiveTopology:
                            // `object.isPoints` is PointList), which rasterizes one pixel per vertex.
                            d.topology = WGPUPrimitiveTopology_PointList;
                            d.castShadow = false;  // three's shadow pass draws points; no corpus point casts one
                            // Upstream's node path samples no map at all (no `materialMap` accessor exists: a
                            // PointsMaterial becomes a PointsNodeMaterial, StandardNodeLibrary.js:84), so a
                            // mapped point cloud draws its flat colour there. Dropping it here is the same frame,
                            // and one texel is all a one-pixel point could ever read.
                            d.map = nullptr;
                            if (!mainPass) items.pop_back();
                        }
                        if (type == "Sprite") {
                            const auto& sprite = static_cast<const Sprite&>(mesh);
                            DrawItem& d = items.back();
                            d.sprite = true;
                            d.castShadow = false;
                            d.instanceCount = sprite.count;
                            d.spriteCenter = {sprite.center.x, sprite.center.y};
                            d.spriteRotation = mesh.material->rotation;
                            d.spriteSizeAttenuation = mesh.material->sizeAttenuation;
                            if (!mainPass) items.pop_back();
                        }
                        if (virtualShadows_ && mainPass && shadowCaster && !items.empty() && items.back().skinnedRig) {
                            // Same split as a page caster above: the rig's main-pass copy joins the palette
                            // batch, its shadow copy stays individual for the per-page cull.
                            items.emplace_back(items.back());
                            items.back().mainPass = false;
                            items[items.size() - 2].castShadow = false;
                        }
                        if (mesh.onBeforeRender && mainPass)
                            callbacks_.push_back({mesh.weak_from_this().lock(), &mesh, &r});
                    }
                }
            }
        } else if (!lightsOnly && type == "BatchedMesh") {
            // three's BatchedMesh: each geometry's visible instances, drawn as one instanced mesh.
            // ponytail: never culled; three culls the whole batch and then each instance. Add when a
            // BatchedMesh scene draws mostly off screen.
            cullExempt_ = true;
            for (const auto& batch : static_cast<BatchedMesh&>(object).drawBatches())
                project(*batch, camera, items, lights, false, false, nullptr, false);
            cullExempt_ = false;
        } else if (mainPass && type == "AmbientLight") {
            const auto& l = static_cast<const AmbientLight&>(object);
            for (int c = 0; c < 3; ++c)
                lights.ambient[c] += scaled(l.color, l.intensity)[c];
            lights.ambients.emplace_back(object.id(), scaled(l.color, l.intensity));
        } else if (mainPass && type == "DirectionalLight") {
            auto& l = static_cast<DirectionalLight&>(object); // its shadow camera moves, as three's does
            // three reads light.target.matrixWorld as it stands: only a scene traversal refreshes it, so a target
            // outside the scene stays where its matrix last was (the origin) whatever its position says.
            const auto from = worldPosition(l), to = worldPosition(*l.target);
            direct_.emplace_back(object.id(), DirectLight::directional(normalized({from[0] - to[0], from[1] - to[1], from[2] - to[2]}),
                                                                      scaled(l.color, l.intensity)));
            if (shadowMapEnabled && l.castShadow()) {
                const auto it = shadowByLight_.find(&l);
                direct_.back().second.shadow = it != shadowByLight_.end() ? it->second : shadowOf(l.shadow, from, to, effectiveShadowLayersMask(*l.shadow.camera, camera));
            }
        } else if (mainPass && type == "PointLight") {
            auto& l = static_cast<PointLight&>(object); // its shadow camera moves, as three's does
            DirectLight d;
            d.kind = DirectLight::Kind::Point;
            d.color = scaled(l.color, l.intensity);
            d.position = worldPosition(l);
            d.distance = l.distance;
            d.decay = l.decay;
            d.sourceRadius = l.sourceRadius;
            if (shadowMapEnabled && l.castShadow())
                d.shadow = pointShadowOf(l.shadow, d.position, l.distance, effectiveShadowLayersMask(*l.shadow.camera, camera));
            direct_.emplace_back(object.id(), d);
        } else if (mainPass && type == "SpotLight") {
            // SpotLightNode.update: coneCos = cos(angle), penumbraCos = cos(angle * (1 - penumbra)); the
            // axis is lightTargetDirection, from the target to the light.
            auto& l = static_cast<SpotLight&>(object); // its shadow camera moves, as three's does
            DirectLight d;
            d.kind = DirectLight::Kind::Spot;
            d.color = scaled(l.color, l.intensity);
            d.position = worldPosition(l);
            const auto to = worldPosition(*l.target);
            d.direction = normalized({d.position[0] - to[0], d.position[1] - to[1], d.position[2] - to[2]});
            d.distance = l.distance;
            d.decay = l.decay;
            d.sourceRadius = l.sourceRadius;
            d.coneCos = std::cos(l.angle);
            d.penumbraCos = std::cos(l.angle * (1 - l.penumbra));
            if (shadowMapEnabled && l.castShadow()) {
                const auto it = shadowByLight_.find(&l);
                if (it != shadowByLight_.end()) {
                    d.shadow = it->second;
                } else {
                    // SpotLightShadow.updateMatrices: the camera's fov covers the cone (times focus), its
                    // aspect is the map's, and its far is the light's distance when it has one.
                    auto& shadowCamera = static_cast<PerspectiveCamera&>(*l.shadow.camera);
                    shadowCamera.fov = kRadToDeg * 2 * l.angle * l.shadow.focus;
                    shadowCamera.aspect = (l.shadow.mapSize.x / l.shadow.mapSize.y) * l.shadow.aspect;
                    shadowCamera.far = l.distance != 0 ? l.distance : shadowCamera.far;
                    d.shadow = shadowOf(l.shadow, d.position, to, effectiveShadowLayersMask(*l.shadow.camera, camera));
                }
            }
            direct_.emplace_back(object.id(), d);
        } else if (mainPass && type == "HemisphereLight") {
            const auto& l = static_cast<const HemisphereLight&>(object);
            if (hemisphere_++ == 0) {
                lights.hemisphereSky = scaled(l.color, l.intensity);
                lights.hemisphereGround = scaled(l.groundColor, l.intensity);
                lights.hemisphereUp = normalized(worldPosition(l));
                lights.hemisphereId = object.id();
            }
        }
    } else if (!lightsOnly && cached && cached->meshId == object.id()) {
        markSeen(*cached); // flat records also survive another camera's layer mask
    } else if (Record* found = lightsOnly ? nullptr : findRecord(object, false)) {
        markSeen(*found); // in the scene, on another camera's layer: its record stays
    }
    const bool ordered = !updateChildren && &object == slotRoot_;
    for (std::size_t i = 0; i < object.children.size(); ++i) {
        Object3D* child = object.children[i];
        Record* slot = updateChildren ? &flatRecords_[i] : nullptr;
        bool plainChild = updateChildren && flatPlainMeshes_[i];
        if (ordered && i < slotRecords_.size() && typeid(*child) == typeid(Mesh)) {
            // The pointer survives while its record does; a moved or new mesh looks itself up once.
            Record*& found = slotRecords_[i];
            if (!found || found->meshId != child->id()) {
                found = findRecord(*child, false);
            }
            slot = found;
            plainChild = true;
        }
#if defined(__GNUC__) && !defined(__EMSCRIPTEN__)
        if (ordered && i + 32 < slotRecords_.size() && slotRecords_[i + 32])
            TN_PREFETCH(slotRecords_[i + 32], 0, 1);
        if (ordered && i + 16 < slotRecords_.size() && i + 16 < object.children.size()) {
            const auto* next = reinterpret_cast<const char*>(object.children[i + 16]);
            for (std::size_t offset = 0; offset <= sizeof(Object3D); offset += 64)
                TN_PREFETCH(next + offset, 0, 1);
            if (const Record* future = slotRecords_[i + 16]) {
                const auto* material = reinterpret_cast<const char*>(future->material.get());
                if (material)
                    for (std::size_t offset = 0; offset < sizeof(Material); offset += 64)
                        TN_PREFETCH(material + offset, 0, 1);
            }
        }
        // Sparse authored metadata remains outside the dense transform columns. Fetch it
        // ahead of the fused traversal instead of serializing every cache miss at 64k.
        if (updateChildren && i + 32 < object.children.size())
            TN_PREFETCH(&flatRecords_[i + 32], 0, 1);
        if (updateChildren && i + 16 < object.children.size()) {
            const auto* future = object.children[i + 16];
            const auto* next = reinterpret_cast<const char*>(future);
            for (std::size_t offset = 0; offset < sizeof(Object3D); offset += 64)
                TN_PREFETCH(next + offset, 0, 1);
            if (flatPlainMeshes_[i + 16])
                TN_PREFETCH(next + sizeof(Object3D), 0, 1);
            const auto* material = reinterpret_cast<const char*>(flatRecords_[i + 16].material.get());
            if (material)
                for (std::size_t offset = 0; offset < sizeof(Material); offset += 64)
                    TN_PREFETCH(material + offset, 0, 1);
        }
        if (updateChildren && i + 8 < object.children.size()) {
            const auto* future = object.children[i + 8];
            TN_PREFETCH(&future->position, 0, 1);
            TN_PREFETCH(&future->quaternion, 0, 1);
            TN_PREFETCH(&future->scale, 0, 1);
            TN_PREFETCH(&future->matrix, 1, 1);
            TN_PREFETCH(reinterpret_cast<const char*>(&future->matrix) + 64, 1, 1);
            TN_PREFETCH(&future->matrixWorld, 1, 1);
            TN_PREFETCH(reinterpret_cast<const char*>(&future->matrixWorld) + 64, 1, 1);
        }
#endif
        if (updateChildren)
            child->Object3D::updateMatrixWorldSelf(force, flatParentIdentity_, flatPlainMeshes_[i]);
        project(*child, camera, items, lights, false, false, slot, plainChild, lightsOnly, excluded);
    }
}

// Groups batchable items by what they draw (geometry buffers, material, kind, render order) and
// replaces each group of kMinBatchMembers or more with one instanced item: identity model matrix,
// the members' world matrices (float32, as a uniform holds them) as instance matrices, drawn in the
// first member's place.
void RenderDatabase::batch(std::vector<DrawItem>& items, Object3D& scene,
                           const std::vector<std::pair<double, const DrawItem*>>& ordered) {
    // A decline writes no verdict, so a settled one holds no verdict until its rescan; an empty scene (still
    // loading) is judged again next frame. A projecting one holds while the scene's structure does, re-judged on
    // the same cadence (PRD-613: hostProjectionReport's rule; deciding every frame cost Midway ~1.5 ms).
    static const projection::Decision none;
    const projection::Decision* decision = &none;
    if (std::any_of(items.begin(), items.end(), [](const DrawItem& item) { return item.skinnedRig && !item.gpuJoints; })) {
        using Walks = projection::WalkCounters;
        Walks& walks = projection::walkCounters(projection::WalkCaller::RenderDatabase);
        uint64_t& nodes = projection::walkedNodes();
        const bool cadence = ++framesSinceDeclineScan_ >= kDeclineRescanFrames;
        bool due = cadence || &scene != batchScene_;
        Walks::Trigger trigger = cadence ? Walks::Cadence : Walks::Scene;
        if (!due && batchDecision_.projecting && Object3D::hierarchyVersion() != batchHierarchy_) {
            batchHierarchy_ = Object3D::hierarchyVersion();
            const uint64_t before = nodes;
            due = projection::structureStamp(scene) != batchStamp_;
            ++walks.stampWalks;
            walks.stampNodes += nodes - before;
            ++walks.stampBy[Walks::Hierarchy];
            trigger = Walks::Structure;
        }
        // The structure held, so every rig is alive: a rig that scaled, mirrored or changed material leaves now.
        for (std::size_t i = 0; !due && i < batchRigs_.size(); ++i) {
            due = projection::detail::rigLaneKey(*batchRigs_[i].first) != batchRigs_[i].second;
            trigger = Walks::Rig;
        }
        if (due) {
            uint64_t before = nodes;
            batchDecision_ = projection::decide(scene, 200, true, true);
            ++walks.decideWalks;
            walks.decideNodes += nodes - before;
            ++walks.decideBy[trigger];
            ++batchDecisions_;
            batchScene_ = &scene;
            batchHierarchy_ = Object3D::hierarchyVersion();
            before = nodes;
            batchStamp_ = batchDecision_.projecting ? projection::structureStamp(scene) : -1;
            if (batchDecision_.projecting) {
                ++walks.stampWalks;
                walks.stampNodes += nodes - before;
                ++walks.stampBy[trigger];
            }
            batchRigs_.clear();
            if (batchDecision_.projecting)
                for (const auto& [object, lane] : batchDecision_.verdict)
                    if (const auto* rig = dynamic_cast<const SkinnedMesh*>(object))
                        batchRigs_.emplace_back(rig, projection::detail::rigLaneKey(*rig));
            // TN_BATCH_DECISION_CACHE=0 (diagnostic): a projecting decision is judged again next frame, as before PRD-613.
            static const bool held = [] { const char* flag = flags::once<flags::BatchDecisionCache>(); return !flag || std::strcmp(flag, "0") != 0; }();
            framesSinceDeclineScan_ = batchDecision_.sourceRenderables == 0 || (!held && batchDecision_.projecting) ? kDeclineRescanFrames : 0;
        }
        decision = &batchDecision_;
    }
    projection::countWalkCall(projection::WalkCaller::RenderDatabase);
    skinnedPalettes_.clear();
    batchGroupsList_.clear();
    candidatesByKey_.clear();
    shadowCopies_.clear();
    if (virtualShadows_)
        for (std::size_t i = 0; i < items.size(); ++i)
            if (items[i].skinnedRig && !items[i].mainPass && !items[i].gpuJoints) shadowCopies_.emplace(items[i].skinnedRig, i);
    for (const auto& [depth, item] : ordered) {
        const std::size_t i = item - items.data();
        const DrawItem& d = items[i];
        const auto verdict = decision->verdict.find(d.skinnedRig);
        const bool skinned = bool(d.gpuJoints) || (d.boneMatrices && verdict != decision->verdict.end() && verdict->second == "skinned");
        if ((virtualShadows_ && d.castShadow) || (!d.batchable && !skinned))
            continue;
        auto same = [&](const std::vector<std::size_t>& g) {
            const DrawItem& o = items[g.front()];
            if (bool(o.skinnedRig) != bool(d.skinnedRig) || o.gpuJoints != d.gpuJoints)
                return false;
            if (skinned &&
                (o.skinnedRig->geometry != d.skinnedRig->geometry ||
                 o.skinnedRig->skeleton->bones.size() != d.skinnedRig->skeleton->bones.size() ||
                 projection::detail::batchFlags(*o.skinnedRig) != projection::detail::batchFlags(*d.skinnedRig)))
                return false;
            return o.positions == d.positions && o.normals == d.normals && o.indices == d.indices &&
                   o.uvs == d.uvs && o.kind == d.kind && o.renderOrder == d.renderOrder &&
                   (o.materialKey == d.materialKey || (!skinned && d.renderOrder == 0 &&
                    projection::detail::sameUniforms(*static_cast<const Material*>(o.materialKey),
                                                    *static_cast<const Material*>(d.materialKey)))) &&
                   o.castShadow == d.castShadow && o.receiveShadow == d.receiveShadow &&
                   o.mainPass == d.mainPass && o.layers == d.layers;
        };
        std::size_t hash = !skinned && d.renderOrder == 0
                               ? projection::detail::uniformHash(*static_cast<const Material*>(d.materialKey))
                               : std::hash<const void*>{}(d.materialKey);
        hash ^= std::hash<const void*>{}(d.positions);
        hash ^= std::hash<int>{}(d.renderOrder);
        hash ^= std::size_t(d.castShadow) * 31 + std::size_t(d.receiveShadow) * 67;
        hash ^= std::size_t(d.mainPass) * 101 + std::size_t(d.layers) * 131;
        if (skinned)
            hash ^= std::hash<const void*>{}(d.skinnedRig->geometry.get()) ^
                    std::hash<double>{}(projection::detail::batchFlags(*d.skinnedRig)) ^
                    d.skinnedRig->skeleton->bones.size();
        auto& candidates = candidatesByKey_[hash];
        auto it = std::find_if(candidates.begin(), candidates.end(), [&](std::size_t group) { return same(batchGroupsList_[group]); });
        if (it == candidates.end()) {
            candidates.push_back(batchGroupsList_.size());
            batchGroupsList_.push_back({i});
        } else {
            batchGroupsList_[*it].push_back(i);
        }
    }
    absorbed_.assign(items.size(), false);
    merged_.clear();
    for (const std::vector<std::size_t>& g : batchGroupsList_) {
        const bool skinned = items[g.front()].skinnedRig != nullptr;
        if (!skinned && g.size() < kMinBatchMembers)
            continue;
        SkinnedPalette* palette = nullptr;
        if (skinned && !items[g.front()].gpuJoints) {
            skinnedPalettes_.push_back(
                std::make_unique<SkinnedPalette>(items[g.front()].skinnedRig->skeleton->bones.size(), g.size(), false));
            palette = skinnedPalettes_.back().get();
            palette->begin();
        }
        ++batchGroups_;
        const auto slot = batchSlot(uint64_t{1} << 63 | uint64_t(&g - batchGroupsList_.data()));
        while (batchStores_.size() <= slot) batchStores_.push_back(std::make_shared<BufferStore>(Scalar::F32, 0));
        BufferStore& store = *batchStores_[slot];
        if (store.count() != g.size() * 16)
            store.resize(g.size() * 16);
        auto* matrices = reinterpret_cast<float*>(store.data());
        std::size_t matrixOffset = 0;
        const bool uniform = std::any_of(g.begin(), g.end(), [&](std::size_t i) {
            return items[i].materialKey != items[g.front()].materialKey;
        });
        if (batchColors_.size() <= slot) batchColors_.resize(slot + 1);
        if (uniform && !batchColors_[slot]) batchColors_[slot] = std::make_shared<BufferStore>(Scalar::F32, 0);
        if (uniform && batchColors_[slot]->count() != g.size() * 3) batchColors_[slot]->resize(g.size() * 3);
        auto* colors = uniform ? reinterpret_cast<float*>(batchColors_[slot]->data()) : nullptr;
        std::size_t colorOffset = 0;
        for (std::size_t i : g) {
            const Object3D* placement = nullptr;
            if (palette) {
                SkinnedMesh& rig = *items[i].skinnedRig;
                const auto slot = palette->claim(&rig);
                placement = palette->writeRelative(*slot, rig);
                // The rig's shadow copy reads the same root-relative slot instead of the skeleton's world palette, so a
                // rig has one palette a frame: the copy keeps its own model matrix (its shadow bounds read it) and its
                // bind pair folds the placement back in, meshWorld * (meshWorld^-1 * R) * (R^-1 * boneWorld * ...).
                const auto copy = placement ? shadowCopies_.find(&rig) : shadowCopies_.end();
                if (copy != shadowCopies_.end() && items[copy->second].boneMatrices == &rig.skeleton->boneMatrices) {
                    DrawItem& shadow = items[copy->second];
                    Matrix4 prefix;
                    prefix.multiplyMatrices(rig.bindMatrixInverse, placement->matrixWorld);
                    shadow.boneMatrices = &palette->matrices();
                    shadow.boneOffset = *slot * palette->bones();
                    shadow.bindMatrix = Matrix4{}.elements;
                    shadow.bindMatrixInverse = toArray(prefix);
                }
            }
            // Relative palettes carry placement here; eager world palettes retain identity.
            const Matrix identity{1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
            Matrix transform = placement ? toArray(placement->matrixWorld)
                                     : palette ? identity
                                               : items[i].matrixWorld;
            if (items[i].gpuJoints) {
                const auto* saved = reinterpret_cast<const float*>(items[i].instanceMatrices->data());
                for (int k = 0; k < 16; ++k) transform[k] = saved[k];
            }
            for (double e : transform)
                matrices[matrixOffset++] = static_cast<float>(e);
            if (colors) for (float c : items[i].material->color) colors[colorOffset++] = c;
            absorbed_[i] = true;
        }
        store.needsUpdate();
        DrawItem d = items[g.front()];
        if (d.gpuJoints) {
            d.gpuJointRigs.clear();
            for (std::size_t i : g) d.gpuJointRigs.push_back(items[i].gpuJointRig);
        }
        if (batchCaches_.size() <= slot) batchCaches_.resize(slot + 1);
        d.cache = &batchCaches_[slot];
        d.sortOrigin = d.sortOrigin.value_or(std::array<double, 3>{d.matrixWorld[12], d.matrixWorld[13], d.matrixWorld[14]});
        d.matrixWorld = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
        d.instanceMatrices = &store;
        d.instanceCount = static_cast<uint32_t>(g.size());
        if (uniform) {
            batchColors_[slot]->needsUpdate();
            d.instanceColors = batchColors_[slot].get();
            while (batchParams_.size() <= slot) batchParams_.push_back(std::make_unique<shader::StandardMaterial>());
            auto& params = *batchParams_[slot];
            params = *d.material;
            params.color = {1, 1, 1};
            d.material = &params;
        }
        if (palette) {
            palette->end();
            d.boneMatrices = &palette->matrices();
            d.boneStride = palette->bones();
            d.bindMatrix = d.bindMatrixInverse = d.matrixWorld;
        }
        merged_.push_back(d);
        batchMembers_ += g.size();
    }
    if (merged_.empty())
        return;
    // Compacted in place, in the same order: the draws before the first member stay where they are. A draw is 1.4 KB,
    // and copying every draw of the frame into a second list cost the stress lab's crowd 0.1 ms (PRD-878).
    std::size_t kept = std::size_t(std::find(absorbed_.begin(), absorbed_.end(), true) - absorbed_.begin());
    for (std::size_t i = kept; i < items.size(); ++i)
        if (!absorbed_[i]) items[kept++] = std::move(items[i]);
    items.erase(items.begin() + std::ptrdiff_t(kept), items.end());
    items.insert(items.end(), std::make_move_iterator(merged_.begin()), std::make_move_iterator(merged_.end()));
}

// Capture members while their scene/material cache lines are hot. DrawItems are made only for
// submitted draws; sorting and packing touch compact arrays rather than the authored object graph.
void RenderDatabase::addBatchMesh(const Mesh& mesh, Record& record, bool mainPass, bool shadowCaster) {
    const auto& geometry = record.buffers;
    const uint32_t layers = Layers::bits(mesh.layers().mask);
    const auto same = [&](std::size_t index) {
        const MeshGroup& group = meshGroups_[index];
        const auto& member = batchMeshes_[group.members.front()];
        const Mesh& first = *member.mesh;
        return ((record.geometry == member.record->geometry && record.geometryRevision == member.record->geometryRevision) ||
                group.geometry == geometry) && first.renderOrder() == mesh.renderOrder() &&
               member.shadowCaster == shadowCaster && first.receiveShadow() == mesh.receiveShadow() &&
               member.mainPass == mainPass && member.layers == layers &&
               first.material->type == mesh.material->type &&
               (first.material == mesh.material ||
                (mesh.renderOrder() == 0 && projection::detail::sameUniforms(*first.material, *mesh.material)));
    };
    std::size_t group;
    if (lastMeshGroup_ && same(*lastMeshGroup_)) {
        group = *lastMeshGroup_;
    } else {
        std::size_t hash = mesh.renderOrder() == 0 ? projection::detail::uniformHash(*mesh.material)
                                                   : std::hash<const void*>{}(mesh.material.get());
        const auto mix = [&](std::size_t v) { hash = (hash ^ v) * 0x9e3779b1u; };
        for (const auto* buffer : geometry)
            mix(std::hash<const void*>{}(buffer));
        mix(static_cast<std::size_t>(mesh.renderOrder()));
        mix(static_cast<std::size_t>(shadowCaster));
        mix(mesh.receiveShadow());
        mix(static_cast<std::size_t>(mainPass));
        mix(static_cast<std::size_t>(layers));
        auto& bucket = meshCandidates_[hash];
        const auto found = std::find_if(bucket.begin(), bucket.end(), same);
        if (found == bucket.end()) {
            group = meshGroupCount_++;
            const uint64_t identity = uint64_t(hash) * 0x9e3779b97f4a7c15ull + bucket.size();
            bucket.push_back(group);
            if (group == meshGroups_.size()) meshGroups_.push_back({geometry, {}});
            else {
                auto& reused = meshGroups_[group];
                reused.geometry = geometry;
                reused.members.clear();
                reused.orderedIds = true;
            }
            meshGroups_[group].identity = identity;
        } else
            group = *found;
        lastMeshGroup_ = group;
    }
    auto& target = meshGroups_[group];
    if (!target.members.empty() && batchMeshes_[target.members.back()].id > mesh.id())
        target.orderedIds = false;
    target.members.push_back(batchMeshes_.size());
    const auto& m = mesh.matrixWorld.elements;
    const auto& p = batchProjView_;
    batchMeshes_.push_back(
        {&mesh, mesh.material.get(),
         (p[2] * m[12] + p[6] * m[13] + p[10] * m[14] + p[14]) / (p[3] * m[12] + p[7] * m[13] + p[11] * m[14] + p[15]),
         mesh.id(), mesh.renderOrder(), &record, mainPass, layers, shadowCaster});
    BatchTransform packed;
    for (int i = 0; i < 16; ++i)
        packed.matrix[i] = static_cast<float>(m[i]);
    batchRgb_.push_back({static_cast<float>(mesh.material->color.r), static_cast<float>(mesh.material->color.g),
                         static_cast<float>(mesh.material->color.b)});
    batchTransforms_.push_back(packed);
}

std::size_t RenderDatabase::batchSlot(uint64_t identity) {
    if (!features().batchSlotReuse) return batchGroups_ - 1;  // RenderFeatures::web(): a batch takes the next slot each frame
    auto [slot, fresh] = batchSlotOf_.try_emplace(identity, 0);
    if (fresh) {
        if (batchSlotFree_.empty()) {
            slot->second = batchSlotSeen_.size();
            batchSlotSeen_.push_back(0);
        } else {
            slot->second = batchSlotFree_.back();
            batchSlotFree_.pop_back();
        }
    }
    batchSlotSeen_[slot->second] = frame_;
    return slot->second;
}

void RenderDatabase::batchMeshes(std::vector<DrawItem>& items) {
    const auto before = [&](std::size_t x, std::size_t y) {
        const auto& a = batchMeshes_[x];
        const auto& b = batchMeshes_[y];
        if (a.order != b.order)
            return a.order < b.order;
        if (a.depth != b.depth)
            return a.depth < b.depth;
        return a.id < b.id;
    };
    depthKeys_.resize(batchMeshes_.size());
    floatKeys_.resize(batchMeshes_.size());
    for (std::size_t i = 0; i < batchMeshes_.size(); ++i) {
        const double depth = batchMeshes_[i].depth == 0 ? 0.0 : batchMeshes_[i].depth;
        const auto bits = std::bit_cast<uint64_t>(depth);
        depthKeys_[i] = bits >> 63 ? ~bits : bits ^ (uint64_t{1} << 63);
        // The depth rounded to float32: never out of order against the double, so four radix passes
        // order everything but the keys that round together, which the pass after them settles.
        const auto narrow = std::bit_cast<uint32_t>(static_cast<float>(depth));
        floatKeys_[i] = narrow >> 31 ? ~narrow : narrow ^ (uint32_t{1} << 31);
    }
    for (std::size_t slot = 0; slot < meshGroupCount_; ++slot) {
        auto& group = meshGroups_[slot];
        auto& members = group.members;
        if (members.size() < 256 || std::any_of(members.begin(), members.end(), [&](std::size_t i) {
                return !std::isfinite(batchMeshes_[i].depth);
            })) {
            std::sort(members.begin(), members.end(), before);
            continue;
        }
        // Group flags already fix renderOrder. Stable depth radix preserves the id tie-break,
        // with bounded linear work even when every mesh moves. Signed zero sorts as one depth.
        const auto idBefore = [&](std::size_t a, std::size_t b) { return batchMeshes_[a].id < batchMeshes_[b].id; };
        if (!group.orderedIds)
            std::sort(members.begin(), members.end(), idBefore);
        sortScratch_.resize(members.size());
        uint32_t varying = 0;
        const uint32_t first = floatKeys_[members.front()];
        for (auto i : members) varying |= floatKeys_[i] ^ first;
        for (unsigned shift = 0; shift < 32; shift += 8) {
            if (((varying >> shift) & 255) == 0) continue;
            std::array<std::size_t, 256> offsets{};
            for (auto i : members) ++offsets[(floatKeys_[i] >> shift) & 255];
            std::size_t total = 0;
            for (auto& offset : offsets) { const auto count = offset; offset = total; total += count; }
            for (auto i : members) sortScratch_[offsets[(floatKeys_[i] >> shift) & 255]++] = i;
            members.swap(sortScratch_);
        }
        // Depths that round to the same float keep id order from the stable passes; put each such
        // run in exact depth order, with the id as the tie-break the scene order already gave.
        for (std::size_t at = 0; at < members.size();) {
            std::size_t end = at + 1;
            while (end < members.size() && floatKeys_[members[end]] == floatKeys_[members[at]]) ++end;
            if (end - at > 1)
                std::sort(members.begin() + at, members.begin() + end, [&](std::size_t a, std::size_t b) {
                    return depthKeys_[a] != depthKeys_[b] ? depthKeys_[a] < depthKeys_[b]
                                                          : batchMeshes_[a].id < batchMeshes_[b].id;
                });
            at = end;
        }
    }
    for (std::size_t groupIndex = 0; groupIndex < meshGroupCount_; ++groupIndex) {
        const auto& group = meshGroups_[groupIndex];
        const auto& members = group.members;
        if (members.size() < kMinBatchMembers) {
            for (std::size_t index : members) {
                const auto& member = batchMeshes_[index];
                const Mesh& mesh = *member.mesh;
                DrawItem item = refresh(mesh, record(mesh, *member.record));
                item.mainPass = member.mainPass;
                item.castShadow = member.shadowCaster;
                item.layers = member.layers;
                items.push_back(std::move(item));
            }
            continue;
        }
        const auto& firstMember = batchMeshes_[members.front()];
        const Mesh& first = *firstMember.mesh;
        DrawItem d = refresh(first, record(first, *firstMember.record));
        d.mainPass = firstMember.mainPass;
        d.castShadow = firstMember.shadowCaster;
        d.layers = firstMember.layers;
        // PRD-754: the group, not its nearest member, keys the draw, so culling a member moves no uniform slot. The id
        // stays the member's: it breaks three's depth ties, and with it the winner of two coplanar draws.
        if (features().batchSlotReuse) d.key = uint64_t{1} << 62 | (group.identity & ((uint64_t{1} << 62) - 1));
        ++batchGroups_;
        const auto slot = batchSlot(group.identity);
        if (batchCaches_.size() <= slot) batchCaches_.resize(slot + 1);
        d.cache = &batchCaches_[slot];
        while (batchStores_.size() <= slot) batchStores_.push_back(std::make_shared<BufferStore>(Scalar::F32, 0));
        auto& matrices = *batchStores_[slot];
        // Grow only, by half again: a member culled or back keeps the buffer, so the draw's vertex binding holds.
        if (matrices.count() < members.size() * 16)
            matrices.resize(members.size() * 24);
        auto* matrix = reinterpret_cast<float*>(matrices.data());
        const bool uniform = std::any_of(members.begin(), members.end(), [&](std::size_t i) {
            return batchMeshes_[i].material != first.material.get();
        });
        if (batchColors_.size() <= slot)
            batchColors_.resize(slot + 1);
        if (uniform && !batchColors_[slot])
            batchColors_[slot] = std::make_shared<BufferStore>(Scalar::F32, 0);
        if (uniform && batchColors_[slot]->count() < members.size() * 3)
            batchColors_[slot]->resize(members.size() * 9 / 2);
        auto* color = uniform ? reinterpret_cast<float*>(batchColors_[slot]->data()) : nullptr;
        for (std::size_t i = 0; i < members.size(); ++i) {
#if defined(__GNUC__) && !defined(__EMSCRIPTEN__)
            if (i + 16 < members.size()) {
                const auto next = members[i + 16];
                TN_PREFETCH(&batchTransforms_[next], 0, 3);
                if (color) TN_PREFETCH(&batchRgb_[next], 0, 3);
            }
#endif
            const auto index = members[i];
            const auto& packed = batchTransforms_[index];
            std::copy_n(packed.matrix.data(), 16, matrix);
            matrix += 16;
            if (color) {
                std::copy_n(batchRgb_[index].data(), 3, color);
                color += 3;
            }
        }
        matrices.needsUpdate();
        d.sortOrigin = {d.matrixWorld[12], d.matrixWorld[13], d.matrixWorld[14]};
        d.matrixWorld = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
        d.instanceMatrices = &matrices;
        d.instanceCount = static_cast<uint32_t>(members.size());
        // The slot's copy of the material, not the nearest member's: its address stays the draw's state key.
        while (batchParams_.size() <= slot) batchParams_.push_back(std::make_unique<shader::StandardMaterial>());
        *batchParams_[slot] = *d.material;
        if (uniform) {
            batchColors_[slot]->needsUpdate();
            d.instanceColors = batchColors_[slot].get();
            batchParams_[slot]->color = {1, 1, 1};
        }
        d.material = batchParams_[slot].get();
        items.push_back(std::move(d));
        batchMembers_ += members.size();
    }
}

const std::vector<DrawItem>& RenderDatabase::prepare(Object3D& scene, Camera& camera, LightState& lights, Object3D* targetScene, bool virtualShadows) {
    virtualShadows_ = virtualShadows;
    if (!gpuPreparing_ && gpuJoints_) { gpuJoints_->revoke(); gpuJoints_.reset(); }
    using Clock = std::chrono::steady_clock;
    const auto start = profiling ? Clock::now() : Clock::time_point{};
    if (targetScene && targetScene != &scene && targetScene->matrixWorldAutoUpdate) targetScene->updateMatrixWorld();
    ++frame_;
    mapSeen_ = 0;
    ++projection::detail::uniformEpoch();
    diagnostics_.clear();
    hemisphere_ = 0;
    // Renderer.render: world matrices first, then the camera in the renderer's coordinate system.
    // Fusion is safe only when matrix updates and light queries cannot run authored hooks.
    // Recheck the public child vector before any update: callers can reorder or replace its slots.
    // A reflection pass of this frame finds them current and leaves the fused walk, which updates, off.
    const bool fresh = std::exchange(matricesFresh_, false);
    const auto& cameraType = typeid(camera);
    bool flat = !fresh && typeid(scene) == typeid(Scene) && scene.matrixWorldAutoUpdate && camera.parent == nullptr &&
                camera.children.empty() && !shadowMapEnabled && (cameraType == typeid(PerspectiveCamera) ||
                                      cameraType == typeid(OrthographicCamera) || cameraType == typeid(Camera));
    if (flat) {
        flatPlainMeshes_.resize(scene.children.size());
        for (std::size_t i = 0; i < scene.children.size(); ++i) {
            const auto* child = scene.children[i];
            const auto& type = typeid(*child);
            const bool mesh = type == typeid(Mesh);
            flatPlainMeshes_[i] = mesh;
            if (child->parent != &scene || !child->children.empty()) { flat = false; break; }
            if (mesh) continue;
            const Object3D* target = nullptr;
            if (type == typeid(DirectionalLight)) target = static_cast<const DirectionalLight*>(child)->target.get();
            if (type == typeid(SpotLight)) target = static_cast<const SpotLight*>(child)->target.get();
            const bool light = type == typeid(Light) || type == typeid(AmbientLight) ||
                               type == typeid(PointLight) || type == typeid(HemisphereLight) ||
                               (target && typeid(*target) == typeid(Object3D) && target->parent == nullptr);
            if (!light) {
                flat = false;
                break;
            }
        }
    }
    bool force = false;
    worldsFreshSince_ = 0;
    if (flat) {
        worldsFreshSince_ = Object3D::matrixEvaluations() + 1;
        ++matrixWalks_;
        force = scene.updateMatrixWorldSelf();
    } else if (scene.matrixWorldAutoUpdate && !fresh) {
        worldsFreshSince_ = Object3D::matrixEvaluations() + 1;
        ++matrixWalks_;
        scene.updateMatrixWorld();
    }
    if (gpuJoints_ && !gpuJoints_->current()) {
        gpuJoints_->revoke(); gpuJoints_.reset();
        worldsFreshSince_ = Object3D::matrixEvaluations() + 1;
        scene.updateMatrixWorld(true); // The external matrix pass may already have skipped Bones.
    }
    if (camera.parent == nullptr && camera.matrixWorldAutoUpdate)
        camera.updateMatrixWorld();
    if (camera.coordinateSystem != CoordinateSystem::WebGPU) {
        camera.coordinateSystem = CoordinateSystem::WebGPU;
        if (auto* p = dynamic_cast<PerspectiveCamera*>(&camera))
            p->updateProjectionMatrix();
        if (auto* o = dynamic_cast<OrthographicCamera*>(&camera))
            o->updateProjectionMatrix();
    }
    flatParentIdentity_ = flat && scene.matrixWorld.elements == Matrix4{}.elements;
    items_.clear();
    items_.reserve(previousDrawCount_);
    auto& items = items_;
    const auto matrices = profiling ? Clock::now() : Clock::time_point{};
    lights = LightState{};
    lights.hemisphereSky = lights.hemisphereGround = {0, 0, 0};
    // r187 src/renderers/common/Renderer.js:1031 rewrites PCFSoftShadowMap to PCFShadowMap on the next render (its
    // filter slot is null in ShadowNode.js:117), so every directional and spot map reads PCFShadowFilter.
    if (shadowMapType == PCFSoftShadowMap) shadowMapType = 1;  // PCFShadowMap; three has no other map filter here
    callbacks_.clear();
    direct_.clear();
    skeletonsUpdated_.clear();
    batchMeshes_.clear();
    batchTransforms_.clear();
    batchRgb_.clear();
    meshGroupCount_ = 0;
    meshCandidates_.clear();
    lastMeshGroup_.reset();
    Matrix4 projectionView;
    projectionView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    batchProjView_ = toArray(projectionView);
    frustum_.setFromProjectionMatrix(projectionView, camera.coordinateSystem, camera.reversedDepth());
    collectShadowFrustums(targetScene ? *targetScene : scene, camera);
    if (flat) flatRecords_.resize(scene.children.size());
    else flatRecords_.clear();
    // Off the flat lane, the scene's plain meshes still find their records by scene order, not by hash.
    slotRecords_.resize(scene.children.size());
    slotRoot_ = flat ? nullptr : &scene;
    project(scene, camera, items, lights, flat, force);
    slotRoot_ = nullptr;
    if (targetScene && targetScene != &scene)
        project(*targetScene, camera, items, lights, false, false, nullptr, false, true, &scene);
    const auto projected = profiling ? Clock::now() : Clock::time_point{};
    // three's LightsNode sorts its lights by id; the direct terms are summed in that order.
    std::stable_sort(direct_.begin(), direct_.end(), [](const auto& a, const auto& b) { return a.first < b.first; });
    for (const auto& [id, light] : direct_) { lights.direct.push_back(light); lights.direct.back().id = id; }
    // Callbacks may detach members or edit their transforms. Snapshot their draws before invoking
    // any hook, just as the exact path does; the common hook-free path stays compact.
    if (!callbacks_.empty()) {
        for (const auto& member : batchMeshes_) {
            auto& item = refresh(*member.mesh, record(*member.mesh, *member.record));
            item.batchable = true;
            item.mainPass = member.mainPass;
            item.castShadow = member.shadowCaster;
            item.layers = member.layers;
            items.push_back(item);
        }
        batchMeshes_.clear();
        meshGroupCount_ = 0;
    }
    // three's onBeforeRender, before the object is drawn: after projection, so a callback that edits
    // the scene cannot invalidate the traversal, and before submission, so a uniform it sets (a
    // material colour) reaches this frame. A callee that threw is a diagnostic, never a crash.
    if (gpuJoints_ && !callbacks_.empty()) {
        if (compiling_ && std::none_of(items.begin(), items.end(), [](const DrawItem& item) { return bool(item.gpuJoints); })) {
            gpuJoints_.reset(); // An unrelated compile root does not own the borrowed plan.
        } else {
            gpuJoints_->revoke(); gpuJoints_.reset();
            scene.updateMatrixWorld(true);
            return prepare(scene, camera, lights, targetScene, virtualShadows);
        }
    }
    for (const PendingCallback& p : callbacks_) {
        const RenderCallback callback = p.mesh->onBeforeRender;
        if (!callback)
            continue;
        std::string error;
        if (!(*callback)({&scene, &camera, p.mesh->geometry, p.mesh->material}, error))
            diagnostics_.push_back("TN_CALLBACK_FAILED onBeforeRender: " + error);
        p.record->draw->params = paramsOf(*p.record->material);
        // The callback may have moved the material after refresh() signed it: the next frame refreshes in full.
        p.record->materialResolved = false;
    }
    ranCallbacks_ = !callbacks_.empty();
    callbacks_.clear();
    if (hemisphere_ > 1)
        diagnostics_.push_back("TN_NATIVE_LIGHTS_UNSUPPORTED: " + std::to_string(hemisphere_) +
                               " hemisphere lights; one is drawn");
    for (auto& r : flatRecords_) if (r.seen != frame_) r = Record{};
    // A chain unseen for 256 renders leaves the cache: its bone may be gone, and the entry never reads its pointer.
    if (frame_ % 256 == 0) std::erase_if(boneChains_, [&](const auto& entry) { return frame_ - entry.second.seen > 256; });
    // Objects that left the scene leave the database.
    // When every record in the map was seen this render, there is nothing to sweep.
    bool erased = false;
    if (mapSeen_ != records_.size()) ++recordSweeps_;
    for (auto it = mapSeen_ == records_.size() ? records_.end() : records_.begin(); it != records_.end();) {
        if (it->second.seen != frame_) {
            if (it->second.cacheId < byId_.size()) byId_[it->second.cacheId] = nullptr;
            it = records_.erase(it);
            erased = true;
        } else {
            ++it;
        }
    }
    if (erased) std::fill(slotRecords_.begin(), slotRecords_.end(), nullptr);  // one of these may have been erased
    batchGroups_ = batchMembers_ = 0;
    for (auto slot = batchSlotOf_.begin(); features().batchSlotReuse && slot != batchSlotOf_.end();) {
        if (frame_ - batchSlotSeen_[slot->second] <= 600) { ++slot; continue; }
        batchSlotFree_.push_back(slot->second);
        slot = batchSlotOf_.erase(slot);
    }
    const auto beforeBatch = profiling ? Clock::now() : Clock::time_point{};
    if (batching) {
        CameraState state;
        state.matrixWorldInverse = toArray(camera.matrixWorldInverse);
        state.projectionMatrix = toArray(camera.projectionMatrix);
        batch(items, scene, Renderer::sortDraws(items, state));
        batchMeshes(items);
    }
    // A draw that still reads a skeleton's world palette (a rig drawn alone, a shadow copy whose rig kept no slot)
    // runs that skeleton's held update now; a batch's root-relative slots read none (PRD-878).
    for (const DrawItem& item : items)
        if (item.skinnedRig && item.skinnedRig->skeleton && item.boneMatrices == &item.skinnedRig->skeleton->boneMatrices)
            item.skinnedRig->skeleton->ensureWorldPalette();
    const auto batched = profiling ? Clock::now() : Clock::time_point{};
    // Resolve the scene fallback every frame: environment can change without a material version bump.
    const Scene* world = dynamic_cast<const Scene*>(&scene);
    if (!world && targetScene) world = dynamic_cast<const Scene*>(targetScene);
    for (DrawItem& item : items) {
        const Material& source = *static_cast<const Material*>(item.materialKey);
        item.fog = world && source.fog ? world->fog.get() : nullptr;
        // three's scene.fogNode replaces scene.fog: the draw's program mixes the node's colour and factor instead.
        // Written into the record's own graph, which the next refresh of that draw rewrites from its material.
        item.nodes->fogNode = nullptr;
        if (world && source.fog && world->fogNode) { item.nodes->fogNode = world->fogNode; item.fog = nullptr; }
        // three's materialEnvRotation: the scene's environmentRotation when the scene has an
        // environment and the material no envMap, else the material's envMapRotation (identity here).
        const GraphSources& sources = graphSources(source);
        item.pmremMap = sources.texture;
        // The render publishes each mirror pass's view on the material's sources (the cached entry, which
        // outlives the frame), so the draw binds the view that pass drew this frame.
        item.reflectors = sources.reflectors.empty() ? nullptr : &const_cast<GraphSources&>(sources).reflectorViews;
        item.nodeTextures = sources.textures.empty() ? nullptr : &sources.textures;
        item.nodeStorages = sources.storages.empty() ? nullptr : &sources.storages;
        if (item.pmremMap) {
            Matrix4 rotation;
            if (world && world->environment && source.maps.find("envMap") == source.maps.end())
                rotation.makeRotationFromEuler(world->environmentRotation).transpose();
            item.pmremRotation = toArray(rotation);
        }
        if (item.kind != MaterialKind::Standard && item.kind != MaterialKind::Physical) continue;
        const Material& material = *static_cast<const Material*>(item.materialKey);
        const auto found = material.maps.find("envMap");
        const Texture* env = found != material.maps.end() ? found->second.get() : nullptr;
        item.envMap = env ? env : world ? world->environment.get() : nullptr;
        item.envMapIntensity = env ? material.envMapIntensity : world ? world->environmentIntensity : 1;
        Matrix4 rotation;
        if (!env && world) rotation.makeRotationFromEuler(world->environmentRotation).transpose();
        item.envRotation = toArray(rotation);
        // three's NodeMaterial.setupEnvironment takes material.envNode before material.envMap and before
        // scene.environment (NodeMaterial.js:968-970, MeshStandardNodeMaterial.js:110-116). The program then
        // lowers the author's node alone, so the draw binds no environment map.
        if ((item.envMap && !item.envMap->hasImage()) || item.nodes->envNode) item.envMap = nullptr;
    }
    // three's Renderer.renderObject: a transparent DoubleSide material (forceSinglePass false) draws
    // twice, its BackSide pass and then its FrontSide pass, so the far half composites under the near.
    const auto twoPass = [](const DrawItem& d) { return d.transparent && d.side == 2 && !d.forceSinglePass; };
    if (std::any_of(items.begin(), items.end(), twoPass)) {
        twoPasses_.clear();
        twoPasses_.reserve(items.size() + 8);
        for (DrawItem& item : items) {
            if (twoPass(item)) {
                DrawItem& back = twoPasses_.emplace_back(item);
                back.side = 1;
                back.key ^= kBackSidePassKey;  // its own GPU record beside the front pass's
                back.castShadow = false;
                item.side = 0;
            }
            twoPasses_.push_back(std::move(item));
        }
        items_.swap(twoPasses_);
    }
    if (world && (world->backgroundNode || world->backgroundTexture)) {
        if (!world->backgroundNode && (world->backgroundTexture->mapping != 303 || world->backgroundBlurriness != 0))
            throw std::runtime_error("TN_NATIVE_BACKGROUND_UNSUPPORTED: sharp EquirectangularReflectionMapping required");
        if (!backgroundGeometry_) backgroundGeometry_ = makeSphereGeometry(1, 32, 32);
        DrawItem sky;
        sky.background = true;
        sky.key = std::numeric_limits<uint64_t>::max();
        sky.positions = backgroundGeometry_->attributes.at("position")->store.get();
        sky.normals = backgroundGeometry_->attributes.at("normal")->store.get();
        sky.indices = backgroundGeometry_->index->store.get();
        sky.uvs = backgroundGeometry_->attributes.at("uv")->store.get();
        Matrix4 model;
        if (camera.projectionMatrix.elements[15] == 1) {
            const double scale = 3 / camera.projectionMatrix.elements[5]; model.makeScale(scale, scale, scale);
        }
        model.elements[12] = camera.matrixWorld.elements[12];
        model.elements[13] = camera.matrixWorld.elements[13];
        model.elements[14] = camera.matrixWorld.elements[14];
        sky.matrixWorld = toArray(model);
        Matrix4 rotation; rotation.makeRotationFromEuler(world->backgroundRotation).transpose();
        sky.backgroundRotation = toArray(rotation);
        backgroundParams_.color.fill(static_cast<float>(world->backgroundIntensity));
        sky.material = &backgroundParams_;
        sky.map = world->backgroundNode ? nullptr : world->backgroundTexture.get();
        if (backgroundNodeMaterial_.nodes.colorNode != world->backgroundNode) {
            backgroundNodeMaterial_.nodes.colorNode = world->backgroundNode;
            backgroundNodeMaterial_.needsUpdate();
        }
        sky.nodes = &backgroundNodeMaterial_.nodes;
        const auto& sources = graphSources(backgroundNodeMaterial_);
        sky.nodeTextures = sources.textures.empty() ? nullptr : &sources.textures;
        sky.nodeStorages = sources.storages.empty() ? nullptr : &sources.storages;
        sky.pmremMap = sources.texture;
        sky.kind = MaterialKind::Basic; sky.side = 1; sky.depthWrite = false;
        sky.mainPass = true;
        sky.layers = Layers::bits(camera.layers().mask);
        items.insert(items.begin(), sky);
    }
    if (profiling) prepareMs_ = {
        std::chrono::duration<double, std::milli>(matrices - start).count(),
        std::chrono::duration<double, std::milli>(projected - matrices).count(),
        std::chrono::duration<double, std::milli>(batched - beforeBatch).count(),
        std::chrono::duration<double, std::milli>((beforeBatch - projected) + (Clock::now() - batched)).count()};
    previousDrawCount_ = items.size();
    return items_;
}

std::vector<std::shared_ptr<PipelineCompilation>> RenderDatabase::compileAsync(Renderer& renderer,
    Object3D& root, Camera& camera, Object3D* targetScene, WGPUTextureFormat outputFormat) {
    LightState lights;
    gpuJoints_ = renderer.currentGpuJoints();
    gpuPreparing_ = true;
    compiling_ = true;
    try { prepare(root, camera, lights, targetScene, renderer.hasVirtualShadows()); } catch (...) { gpuPreparing_ = compiling_ = false; throw; }
    gpuPreparing_ = compiling_ = false;
    const auto& items = items_;
    if (!diagnostics_.empty()) throw std::runtime_error(diagnostics_.front());
    CameraState state;
    state.matrixWorld = toArray(camera.matrixWorld);
    state.matrixWorldInverse = toArray(camera.matrixWorldInverse);
    state.projectionMatrix = toArray(camera.projectionMatrix);
    auto compilations = renderer.compileAsync(items, state, lights, outputFormat);
    if (!reflecting_) precacheReflections(renderer, root, camera, targetScene, compilations);
    return compilations;
}

bool RenderDatabase::prepareEnvironments(Renderer& renderer, Object3D& scene, Camera& camera) {
    LightState lights;
    gpuJoints_ = renderer.currentGpuJoints();
    gpuPreparing_ = true;
    compiling_ = true;
    try { prepare(scene, camera, lights, nullptr, renderer.hasVirtualShadows()); } catch (...) { gpuPreparing_ = compiling_ = false; throw; }
    gpuPreparing_ = compiling_ = false;
    if (!diagnostics_.empty()) throw std::runtime_error(diagnostics_.front());
    return renderer.prepareEnvironments(items_);
}

uint64_t RenderDatabase::render(Renderer& renderer, Object3D& scene, Camera& camera, std::array<double, 4> clear, std::array<double, 2>* cpuMs) {
    // Planning rewrites the draws a pending encode reads, so a second frame in flight is refused first.
    if (renderer.framePending())
        throw std::logic_error("TN_RENDER_THREAD_BATON: a frame was planned before the previous one was encoded");
    using Clock = std::chrono::steady_clock;
    const auto start = (cpuMs || profiling) ? Clock::now() : Clock::time_point{};
    const bool metered = renderer.metered();
    const auto sceneStart = metered ? Clock::now() : Clock::time_point{};
    const auto chargeScene = [&] {
        if (metered) sceneMs_ += std::chrono::duration<double, std::milli>(Clock::now() - sceneStart).count();
    };
    const auto previousJoints = gpuJoints_;
    gpuJoints_ = renderer.prepareGpuJoints(scene, reflecting_ ? gpuJoints_ : nullptr);
    const auto jointsDone = profiling ? Clock::now() : Clock::time_point{};
    static const bool drawUse = [] { const auto* flag = flags::once<flags::GpuJointDrawUse>(); return flag && std::strcmp(flag, "1") == 0; }();
    if (drawUse && !reflecting_ && gpuJoints_) gpuJoints_->drawUse.assign(gpuJoints_->rigs.size(), 0);
    if (previousJoints && previousJoints != gpuJoints_) scene.updateMatrixWorld(true);
    gpuPreparing_ = true;
    try { prepare(scene, camera, lights_, nullptr, renderer.hasVirtualShadows()); } catch (...) { gpuPreparing_ = false; throw; }
    gpuPreparing_ = false;
    const bool hadVirtual = renderer.hasVirtualShadows();
    // The main view's tan(hfov / 2) is 1 / P[0]; a reflection pass is another view and measures nothing.
    const bool mainView = !reflecting_ && dynamic_cast<const PerspectiveCamera*>(&camera) && camera.projectionMatrix.elements[0] > 0;
    renderer.syncVirtualShadows(lights_, mainView ? 1.0 / camera.projectionMatrix.elements[0] : 0.0);
    if (!hadVirtual && renderer.hasVirtualShadows()) prepare(scene, camera, lights_, nullptr, true);
    const auto preparedScene = profiling ? Clock::now() : Clock::time_point{};
    // Frame-pumped PMREM (PRD-573): until every environment this frame samples is fully baked,
    // advance one retained packet and skip the frame. No partial target is published and the covered
    // scene is not drawn. The native player and the WASM host both reach this through render().
    if (!renderer.prepareEnvironments(items_)) {
        chargeScene();
        if (!reflecting_ && Object3D::poseObservationReport) Object3D::poseObservationReport();
        return 0;
    }
    if (!reflecting_) renderReflections(renderer, scene, camera, items_, clear);
    if (profiling) renderPhaseMs_ = {std::chrono::duration<double, std::milli>(jointsDone - start).count(),
                                    std::chrono::duration<double, std::milli>(preparedScene - jointsDone).count(),
                                    std::chrono::duration<double, std::milli>(Clock::now() - preparedScene).count()};
    cameraState_.matrixWorld = toArray(camera.matrixWorld);
    cameraState_.matrixWorldInverse = toArray(camera.matrixWorldInverse);
    cameraState_.projectionMatrix = toArray(camera.projectionMatrix);
    if (const auto* perspective = dynamic_cast<const PerspectiveCamera*>(&camera))
        std::tie(cameraState_.near, cameraState_.far) = std::pair{perspective->near, perspective->far};
    else if (const auto* orthographic = dynamic_cast<const OrthographicCamera*>(&camera))
        std::tie(cameraState_.near, cameraState_.far) = std::pair{orthographic->near, orthographic->far};
    const auto* world = dynamic_cast<const Scene*>(&scene);
    if (world && world->background) clear = {world->background->r, world->background->g, world->background->b, 1};
    const bool keep = !autoClear && !(world && world->background);
    renderer.keepContents(keep, keep);
    const auto prepared = cpuMs ? Clock::now() : Clock::time_point{};
    chargeScene();
    uint64_t result;
    const auto rendererStart = metered ? Clock::now() : Clock::time_point{};
    if (encodeJobs) {
        result = renderer.renderDeferred(items_, cameraState_, lights_, clear);
        encodeJobs->push_back([&renderer] { renderer.encodePending(); });
    } else {
        result = renderer.render(items_, cameraState_, lights_, clear);
    }
    if (metered) rendererMs_ += std::chrono::duration<double, std::milli>(Clock::now() - rendererStart).count();
    if (!reflecting_ && Object3D::poseObservationReport) Object3D::poseObservationReport();
    if (drawUse && !reflecting_) {
        const auto eligible = gpuJoints_ ? gpuJoints_->rigs.size() : 0;
        const auto drawn = gpuJoints_ ? std::count(gpuJoints_->drawUse.begin(), gpuJoints_->drawUse.end(), uint8_t{1}) : 0;
        std::printf("TN_GPU_JOINT_DRAW_USE:{\"eligible\":%zu,\"drawn\":%zu,\"unused\":%zu}\n", eligible, size_t(drawn), eligible - size_t(drawn));
    }
    if (cpuMs) *cpuMs = {std::chrono::duration<double, std::milli>(prepared - start).count(),
                        std::chrono::duration<double, std::milli>(Clock::now() - prepared).count()};
    return result;
}

RenderDatabase::ReflectionPass& RenderDatabase::reflectionPass(Renderer& renderer,
                                                               const std::shared_ptr<const Reflector>& reflector) {
    // Keyed by the reflector's address: a pass whose reflector is gone built nothing for whoever lives there now.
    ReflectionPass& pass = reflections_[reflector.get()];
    if (!pass.database || reflectionPassIsStale(pass.owner)) {
        pass.owner = reflector;
        pass.renderer = &renderer.reflectionRenderer(reflector);
        pass.database = std::make_unique<RenderDatabase>(features_);
        pass.database->reflecting_ = true;
    }
    pass.database->batching = batching;
    pass.database->reuseMainFrame = reuseMainFrame;
    pass.database->shadowMapEnabled = shadowMapEnabled;
    pass.renderer->setOutput(renderer.output());
    pass.renderer->setSize(uint32_t(std::lround(renderer.width() * reflector->resolutionScale)),
                           uint32_t(std::lround(renderer.height() * reflector->resolutionScale)));
    return pass;
}

void RenderDatabase::precacheReflections(Renderer& renderer, Object3D& root, Camera& camera, Object3D* targetScene,
                                         std::vector<std::shared_ptr<PipelineCompilation>>& compilations) {
    // Every reflector in the compiled set, seen or not: the mirror's first frame is the turn that shows the water.
    std::vector<std::shared_ptr<const Reflector>> reflectors;
    std::vector<Material*> hidden;
    for (const DrawItem& item : items_) {
        if (!item.reflectors) continue;
        auto* material = const_cast<Material*>(static_cast<const Material*>(item.materialKey));
        if (std::find(hidden.begin(), hidden.end(), material) == hidden.end()) hidden.push_back(material);
        for (const auto& [name, mirror] : graphSources(*material).reflectors) {
            const auto reflector = std::static_pointer_cast<const Reflector>(mirror);
            if (std::none_of(reflectors.begin(), reflectors.end(), [&](const auto& r) { return r.get() == reflector.get(); }))
                reflectors.push_back(reflector);
        }
    }
    if (reflectors.empty()) return;
    // The mirror hides the reflecting materials while it draws (renderReflections), so it compiles without them.
    std::vector<bool> wasVisible;
    for (Material* material : hidden) {
        wasVisible.push_back(material->visible);
        material->visible = false;
    }
    struct Restore {
        std::vector<Material*>& materials;
        std::vector<bool>& visible;
        ~Restore() {
            for (std::size_t i = 0; i < materials.size(); ++i) materials[i]->visible = visible[i];
        }
    } restore{hidden, wasVisible};
    for (const auto& reflector : reflectors) {
        ReflectionPass& pass = reflectionPass(renderer, reflector);
        // A camera under the plane leaves the mirror's last pose: a program does not depend on where it looks.
        poseReflection(*reflector, camera, *reflector->camera);
        auto more = pass.database->compileAsync(*pass.renderer, root, *reflector->camera, targetScene);
        compilations.insert(compilations.end(), more.begin(), more.end());
    }
}

void RenderDatabase::renderReflections(Renderer& renderer, Object3D& scene, Camera& camera, std::vector<DrawItem>& items,
                                       std::array<double, 4> clear) {
    for (auto it = reflections_.begin(); it != reflections_.end();)
        it = reflectionPassIsStale(it->second.owner) ? reflections_.erase(it) : std::next(it);
    reflectionMs_ = {0, 0};
    reflectionItems_ = 0;
    std::vector<std::shared_ptr<const Reflector>> drawn;
    std::vector<Material*> hidden;
    for (const DrawItem& item : items) {
        if (!item.mainPass || !item.reflectors) continue;
        auto* material = const_cast<Material*>(static_cast<const Material*>(item.materialKey));
        if (std::find(hidden.begin(), hidden.end(), material) == hidden.end()) hidden.push_back(material);
        // One pass per distinct mirror, however many draws sample it.
        for (const auto& [name, mirror] : graphSources(*material).reflectors) {
            const auto reflector = std::static_pointer_cast<const Reflector>(mirror);
            if (std::none_of(drawn.begin(), drawn.end(), [&](const auto& r) { return r.get() == reflector.get(); }))
                drawn.push_back(reflector);
        }
    }
    if (drawn.empty()) return;
    // three hides the reflecting material while its pass draws (material.visible = false).
    std::vector<bool> wasVisible;
    for (Material* material : hidden) {
        wasVisible.push_back(material->visible);
        material->visible = false;
    }
    struct Restore {
        std::vector<Material*>& materials;
        std::vector<bool>& visible;
        ~Restore() {
            for (std::size_t i = 0; i < materials.size(); ++i) materials[i]->visible = visible[i];
        }
    } restore{hidden, wasVisible};
    for (const auto& reflector : drawn) {
        ReflectionPass& pass = reflectionPass(renderer, reflector);
        PerspectiveCamera& virtualCamera = *reflector->camera;
        if (poseReflection(*reflector, camera, virtualCamera)) {
            pass.database->matricesFresh_ = reuseMainFrame && !ranCallbacks_;
            // Bones the main pass posed this frame are current too: no callback ran to move them.
            pass.database->skeletonsFresh_ = pass.database->matricesFresh_ ? &skeletonsUpdated_ : nullptr;
            pass.database->gpuJoints_ = gpuJoints_;
            std::array<double, 2> split{0, 0};
            pass.database->profiling = profiling;
            pass.database->encodeJobs = encodeJobs;
            pass.database->render(*pass.renderer, scene, virtualCamera, clear, profiling ? &split : nullptr);
            if (profiling) {
                reflectionMs_[0] += split[0];
                reflectionMs_[1] += split[1];
                reflectionItems_ += pass.database->drawn().size();
            }
            pass.database->skeletonsFresh_ = nullptr;
        }
        else if (encodeJobs) {
            pass.renderer->renderDeferred({}, CameraState{}, LightState{}, {0, 0, 0, 0});
            encodeJobs->push_back([renderer = pass.renderer] { renderer->encodePending(); });
        } else
            pass.renderer->render({}, CameraState{}, LightState{}, {0, 0, 0, 0});
        for (const auto& message : pass.database->diagnostics()) diagnostics_.push_back(message);
    }
    // Each sampled mirror reads its own pass's view, published on the material's graph sources.
    for (const DrawItem& item : items) {
        if (!item.reflectors) continue;
        for (GraphReflector& mirror : *item.reflectors) {
            const auto pass = reflections_.find(mirror.reflector);
            if (pass == reflections_.end()) continue;  // no pass yet: this draw is not in the main view
            mirror.view = pass->second.renderer->sceneColorView();
            mirror.sampler = renderer.linearClampSampler();
        }
    }
}

} // namespace tn::engine
