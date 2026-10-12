#include "engine/scene/raycaster.h"
#include "render_database.h"
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

namespace tn::engine {

namespace {

// What a material's node graphs read from outside the material: the texture pmremTexture
// prefilters and the reflector a reflector() node samples, or null. One of each per material: a
// second, different source is refused rather than silently sharing the first one's.
struct GraphFind {
    const Texture* texture = nullptr;
    std::shared_ptr<const void> reflector;
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
        } else if (node->kind == shader::graph::Kind::Texture && node->object) {
            const auto* texture = static_cast<const Texture*>(node->object.get());
            if (std::none_of(found.textures.begin(), found.textures.end(),
                             [&](const auto& entry) { return entry.first == node->name; }))
                found.textures.emplace_back(node->name, texture);
        } else if (node->kind == shader::graph::Kind::StorageElement && node->object) {
            if (std::none_of(found.storages.begin(), found.storages.end(),
                             [&](const auto& entry) { return entry.first == node->name; }))
                found.storages.emplace_back(node->name, static_cast<const BufferAttribute*>(node->object.get()));
        } else if (node->kind == shader::graph::Kind::Reflector) {
            if (found.reflector && found.reflector != node->object)
                throw std::runtime_error("TN_NATIVE_REFLECTOR_UNSUPPORTED: one material samples two reflectors");
            found.reflector = node->object;
        }
        for (const auto* list : {&node->args, &node->body, &node->otherwise})
            for (const auto& child : *list) visit(child);
    };
    for (const auto& graph : material.nodes.graphs()) visit(graph);
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
    out.bias = shadow.bias;
    out.normalBias = shadow.normalBias;
    out.radius = shadow.radius;
    out.intensity = shadow.intensity;
    out.width = static_cast<uint32_t>(shadow.mapSize.x);
    out.height = static_cast<uint32_t>(shadow.mapSize.y);
    out.layersMask = layersMask;
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

shader::StandardMaterial paramsOf(const Material& m) {
    shader::StandardMaterial p;
    p.color = {float(m.color.r), float(m.color.g), float(m.color.b)};
    p.opacity = float(m.opacity);
    p.alphaTest = float(m.alphaTest);
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

BufferStore* store(const BufferGeometry& g, const char* name) {
    const auto it = g.attributes.find(name);
    return it == g.attributes.end() || !it->second ? nullptr : it->second->store.get();
}

} // namespace


// The renderer binds position, normal, uv and skin weights as float32. glTF stores quantized models
// with normalized 8/16-bit attributes (GLTFExporter writes int8 normals, WEIGHTS_0 is unsigned byte
// in most files): they reach the shader as a dequantized float32 copy, kept while the source is unchanged.
// three's vertexColors: a material that asks for them reads the geometry's `color` attribute (3 or 4
// components); without the attribute three draws the plain colour, and so does this.
void RenderDatabase::vertexColorsOf(const BufferGeometry& geometry, const Material& material, DrawItem& d) {
    d.colors = nullptr;
    d.colorSize = 0;
    if (!material.vertexColors) return;
    const auto it = geometry.attributes.find("color");
    if (it == geometry.attributes.end() || !it->second) return;
    if (it->second->itemSize != 3 && it->second->itemSize != 4)
        throw std::runtime_error("TN_NATIVE_VERTEX_COLORS_UNSUPPORTED: a color attribute of " +
                                 std::to_string(it->second->itemSize) + " components");
    d.colors = floatStore(geometry, "color");
    d.colorSize = static_cast<uint8_t>(it->second->itemSize);
}

// The geometry's attributes beyond the ones the programs name (a TSL attribute() reads them), and an
// InstancedBufferGeometry's instance count: instanceCount, at most what its per-instance attributes
// hold, as three's WebGL backend clamps it (_maxInstanceCount).
void RenderDatabase::geometryInputsOf(const BufferGeometry& geometry, DrawItem& d) {
    d.attributes.clear();
    uint64_t held = std::numeric_limits<uint64_t>::max();
    for (const auto& [name, attribute] : geometry.attributes) {
        if (!attribute || name == "position" || name == "normal" || name == "uv" || name == "color" ||
            name == "skinIndex" || name == "skinWeight")
            continue;
        d.attributes.push_back({name, floatStore(geometry, name.c_str()), attribute->perInstance});
        if (attribute->perInstance) held = std::min(held, attribute->count());
    }
    if (!geometry.instanced) return;
    // three draws geometry.instanceCount instances. Per-instance attributes cap it (WebGPU refuses a
    // draw past a vertex buffer); a geometry with none (core's projection-skinned reads a storage
    // palette by instanceIndex) draws instanceCount as set. ponytail: Infinity with none draws once.
    double count = geometry.instanceCount;
    if (held != std::numeric_limits<uint64_t>::max()) count = std::min(count, double(held));
    else if (!std::isfinite(count)) count = 1;
    d.instanceCount = static_cast<uint32_t>(std::min(count, double(std::numeric_limits<uint32_t>::max())));
}

// three's polygonOffset as WebGPUPipelineUtils sets it: depthBias = units, slope scale = factor.
void RenderDatabase::depthBiasOf(const Material& material, DrawItem& d) {
    d.depthBias = material.polygonOffset ? static_cast<int32_t>(material.polygonOffsetUnits) : 0;
    d.depthBiasSlopeScale = material.polygonOffset ? static_cast<float>(material.polygonOffsetFactor) : 0.0f;
}

BufferStore* RenderDatabase::floatStore(const BufferGeometry& g, const char* name) {
    const auto it = g.attributes.find(name);
    if (it == g.attributes.end() || !it->second) return nullptr;
    const BufferAttribute& attribute = *it->second;
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

RenderDatabase::Record& RenderDatabase::record(const Mesh& mesh, bool materialize) {
    return record(mesh, records_[&mesh], materialize);
}

RenderDatabase::Record& RenderDatabase::record(const Mesh& mesh, Record& r, bool materialize) {
    const Material* material = mesh.material.get();
    const uint64_t geometryRevision = mesh.geometry ? mesh.geometry->revision() : 0;
    const uint32_t materialVersion = material ? material->version() : 0;
    const bool cached = r.drawable && r.meshId == mesh.id() && r.geometry == mesh.geometry &&
                        r.geometryRevision == geometryRevision && r.material.get() == material &&
                        r.materialVersion == materialVersion;
    if (!cached) {
        ++rebuilds_;
        r = Record{};
        r.meshId = mesh.id();
        r.geometry = mesh.geometry;
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
            if (!texture || !texture->sampleable() || slot == "map" || slot == "normalMap") continue;
            const auto pbr = std::find(std::begin(shader::kPbrMapNames), std::end(shader::kPbrMapNames), slot);
            if (pbr - std::begin(shader::kPbrMapNames) < pbrMapsRead(*material)) continue;
            diagnostics_.push_back("TN_NATIVE_MATERIAL_UNSUPPORTED " + std::string(material->typeName()) + ": " + slot +
                                   " is not read by the native standard program");
            return r;
        }
        if (const auto normal = material->maps.find("normalMap");
            normal != material->maps.end() && normal->second && normal->second->sampleable() &&
            !store(*mesh.geometry, "uv")) {
            diagnostics_.push_back("TN_NATIVE_MATERIAL_UNSUPPORTED " + std::string(material->typeName()) +
                                   ": normalMap needs a uv attribute (drawn without it)");
        }
        for (int k = 0; k < pbrMapsRead(*material); ++k)
            if (const auto map = material->maps.find(shader::kPbrMapNames[k]); map != material->maps.end() &&
                map->second && map->second->sampleable() && !store(*mesh.geometry, "uv"))
                diagnostics_.push_back("TN_NATIVE_MATERIAL_UNSUPPORTED " + std::string(material->typeName()) + ": " +
                                       shader::kPbrMapNames[k] + " needs a uv attribute (drawn without it)");
        r.buffers = {floatStore(*mesh.geometry, "position"), floatStore(*mesh.geometry, "normal"),
                     floatStore(*mesh.geometry, "uv"), mesh.geometry->index ? mesh.geometry->index->store.get() : nullptr};
        r.drawable = r.buffers[0] != nullptr;
    }
    if (!materialize || !r.drawable)
        return r;
    if (r.draw) {
        r.draw->item.matrixWorld = toArray(mesh.matrixWorld);
        r.draw->item.renderOrder = mesh.renderOrder();
        // A game moves an InstancedBufferGeometry's instanceCount every frame (Midway's particles).
        if (mesh.geometry && mesh.geometry->instanced) geometryInputsOf(*mesh.geometry, r.draw->item);
        return r;
    }
    r.draw = std::make_unique<Record::Draw>();
    r.materialized = true;
    DrawItem& d = r.draw->item;
    d.cache = &r.cache;
    d.key = d.id = mesh.id();
    d.positions = r.buffers[0];
    d.normals = r.buffers[1];
    d.uvs = r.buffers[2];
    d.indices = r.buffers[3];
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
    vertexColorsOf(*mesh.geometry, *material, d);
    depthBiasOf(*material, d);
    geometryInputsOf(*mesh.geometry, d);
    d.matrixWorld = toArray(mesh.matrixWorld);
    d.kind = kindOf(material->type);
    d.renderOrder = mesh.renderOrder();
    d.transparent = material->transparent;
    d.forceSinglePass = material->forceSinglePass;
    d.depthWrite = material->depthWrite;
    d.materialKey = material;
    d.positionNode = material->positionNode;
    d.nodes = material->nodes;
    d.side = static_cast<uint8_t>(material->side);
    d.blending = static_cast<uint8_t>(material->blending);
    r.drawable = d.positions != nullptr;
    return r;
}

DrawItem& RenderDatabase::refresh(const Mesh& mesh, Record& r) {
    auto& d = r.draw->item;
    d.cache = &r.cache;  // the record owns the cache; refresh the pointer in case the record moved
    r.draw->params = paramsOf(*r.material);
    d.material = &r.draw->params;
    d.transparent = r.material->transparent;
    d.forceSinglePass = r.material->forceSinglePass;
    d.depthWrite = r.material->depthWrite;
    d.side = static_cast<uint8_t>(r.material->side);
    d.blending = static_cast<uint8_t>(r.material->blending);
    d.positionNode = r.material->positionNode;
    d.nodes = r.material->nodes;
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
    if (mesh.geometry) vertexColorsOf(*mesh.geometry, *r.material, d);
    depthBiasOf(*r.material, d);
    if (mesh.geometry) geometryInputsOf(*mesh.geometry, d);
    d.castShadow = mesh.castShadow();
    d.receiveShadow = mesh.receiveShadow();
    d.layers = Layers::bits(mesh.layers().mask);
    d.mainPass = true;
    return d;
}

const RenderDatabase::GraphSources& RenderDatabase::graphSources(const Material& material) {
    static const GraphSources none;
    std::array<const void*, 8> roots{};
    const auto graphs = material.nodes.pointers();
    std::copy(graphs.begin(), graphs.end(), roots.begin());
    if (std::all_of(roots.begin(), roots.end(), [](const void* root) { return root == nullptr; })) return none;
    GraphSources& cached = graphSources_[&material];
    if (cached.roots != roots || cached.version != material.version()) {
        GraphFind found = findGraphSources(material);
        cached = GraphSources{material.version(), roots, found.texture, std::move(found.reflector),
                              std::move(found.textures), std::move(found.storages)};
    }
    return cached;
}

// three's Frustum.intersectsObject / intersectsSprite: the object's world bounding sphere against
// this prepare's camera frustum. InstancedMesh uses its instance-aware sphere, computed once when
// null, as three does.
bool RenderDatabase::boundingSphereOf(Object3D& object, std::string_view type, Sphere& sphere) {
    if (type == "Sprite") {
        sphere.set(Vector3(0, 0, 0), 0.7071067811865476);
    } else if (type == "InstancedMesh") {
        auto& instanced = static_cast<InstancedMesh&>(object);
        if (instanced.boundingSphere == nullptr) instanced.computeBoundingSphere();
        if (instanced.boundingSphere == nullptr) return false;
        sphere.copy(*instanced.boundingSphere);
    } else {
        auto& mesh = static_cast<Mesh&>(object);
        // ponytail: skinned and morphed meshes always draw; native bounds ignore bones and morph
        // targets, which three's include. Add bone- and morph-aware spheres when they draw off screen.
        if (type == "SkinnedMesh" || mesh.geometry == nullptr ||
            (!mesh.geometry->morphPositions.empty() && !mesh.morphTargetInfluences.empty()))
            return false;
        if (mesh.geometry->boundingSphere == nullptr) mesh.geometry->computeBoundingSphere();
        if (mesh.geometry->boundingSphere == nullptr) return false;
        sphere.copy(*mesh.geometry->boundingSphere);
    }
    sphere.applyMatrix4(object.matrixWorld);
    return true;
}

bool RenderDatabase::inFrustum(Object3D& object, std::string_view type) {
    Sphere sphere;
    if (!boundingSphereOf(object, type, sphere)) return true;
    return frustum_.intersectsSphere(sphere);
}

bool RenderDatabase::inShadowFrustum(Object3D& object, std::string_view type) {
    // ponytail: point light shadow culling across 6 faces omitted; keep casters unculled when a point shadow is present
    if (shadowPointLightActive_) return true;
    if (shadowFrustums_.empty()) return false;
    Sphere sphere;
    if (!boundingSphereOf(object, type, sphere)) return true;
    const uint32_t mask = Layers::bits(object.layers().mask);
    for (const auto& sf : shadowFrustums_) {
        if ((mask & sf.layersMask) != 0 && sf.frustum.intersectsSphere(sphere)) return true;
    }
    return false;
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
        Object3D& obj = *light;
        const std::string_view type = obj.type();
        if (type == "DirectionalLight") {
            auto& l = static_cast<DirectionalLight&>(obj);
            if (l.castShadow()) {
                l.target->updateWorldMatrix(true, false);
                const auto from = worldPosition(l), to = worldPosition(*l.target);
                Frustum f;
                const uint32_t mask = effectiveShadowLayersMask(*l.shadow.camera, mainCamera);
                shadowByLight_[&l] = shadowOf(l.shadow, from, to, mask, &f);
                shadowFrustums_.push_back({f, mask});
            }
        } else if (type == "SpotLight") {
            auto& l = static_cast<SpotLight&>(obj);
            if (l.castShadow()) {
                l.target->updateWorldMatrix(true, false);
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

void RenderDatabase::project(Object3D& object, const Camera& camera, std::vector<DrawItem>& items, LightState& lights,
                             bool updateChildren, bool force, Record* cached, bool plainMesh, bool lightsOnly, const Object3D* excluded) {
    if (&object == excluded) return;
    if (!object.visible()) {
        if (updateChildren)
            for (Object3D* child : object.children)
                child->updateMatrixWorld(force);
        return;
    }
    bool mainPass = object.layers().test(camera.layers());
    bool shadowCaster = shadowMapEnabled && object.castShadow();
    if (mainPass || shadowCaster) {
        const std::string_view type = plainMesh ? "Mesh" : object.type();
        if (!lightsOnly && type == "LOD") {
            if (mainPass) {
                auto& lod = static_cast<LOD&>(object);
                if (lod.autoUpdate) lod.update(camera);
            }
        }
        if (!lightsOnly && (type == "Mesh" || type == "InstancedMesh" || type == "SkinnedMesh" || type == "Sprite" || type == "Line" ||
            type == "LineSegments")) {
            const auto& mesh = static_cast<const Mesh&>(object);
            if (mainPass && mesh.frustumCulled && !cullExempt_ && !inFrustum(object, type)) mainPass = false;
            if (shadowCaster && mesh.frustumCulled && !cullExempt_ && !inShadowFrustum(object, type)) shadowCaster = false;
            const bool compact = batching && type == "Mesh" && mesh.geometry && mesh.material && !mesh.onBeforeRender &&
                                 !mesh.material->transparent && !mesh.material->vertexColors && !mesh.material->positionNode &&
                                 !mesh.material->nodes.positionNode && !mesh.material->nodes.vertexNode &&
                                 !mesh.geometry->instanced &&
                                 (mesh.geometry->morphPositions.empty() || mesh.morphTargetInfluences.empty()) &&
                                 mesh.matrixWorld.determinant() > 0;
            Record& r = cached ? record(mesh, *cached, !compact) : record(mesh, !compact);
            r.seen = frame_;
            if (r.drawable && r.material->visible && (mainPass || shadowCaster)) {
                if (compact) {
                    addBatchMesh(mesh, r, mainPass, shadowCaster);
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
                        d.skinIndices = store(*mesh.geometry, "skinIndex");
                        d.skinWeights = floatStore(*mesh.geometry, "skinWeight");
                        if (skinned.skeleton && d.skinIndices && d.skinWeights) {
                            if (skeletonsUpdated_.insert(skinned.skeleton.get()).second)
                                skinned.skeleton->update();
                            d.boneMatrices = &skinned.skeleton->boneMatrices;
                            d.bindMatrix = toArray(skinned.bindMatrix);
                            d.bindMatrixInverse = toArray(skinned.bindMatrixInverse);
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
                    if (mesh.onBeforeRender && mainPass)
                        callbacks_.push_back({mesh.weak_from_this().lock(), &mesh, &r});
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
        } else if (mainPass && type == "DirectionalLight") {
            auto& l = static_cast<DirectionalLight&>(object); // its shadow camera moves, as three's does
            l.target->updateWorldMatrix(true, false);
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
            }
        }
    } else if (!lightsOnly && cached && cached->meshId == object.id()) {
        cached->seen = frame_; // flat records also survive another camera's layer mask
    } else if (const auto it = records_.find(&object); !lightsOnly && it != records_.end()) {
        it->second.seen = frame_; // in the scene, on another camera's layer: its record stays
    }
    for (std::size_t i = 0; i < object.children.size(); ++i) {
        Object3D* child = object.children[i];
#if defined(__GNUC__) && !defined(__EMSCRIPTEN__)
        // Sparse authored metadata remains outside the dense transform columns. Fetch it
        // ahead of the fused traversal instead of serializing every cache miss at 64k.
        if (updateChildren && i + 32 < object.children.size())
            __builtin_prefetch(&flatRecords_[i + 32], 0, 1);
        if (updateChildren && i + 16 < object.children.size()) {
            const auto* future = object.children[i + 16];
            const auto* next = reinterpret_cast<const char*>(future);
            for (std::size_t offset = 0; offset < sizeof(Object3D); offset += 64)
                __builtin_prefetch(next + offset, 0, 1);
            if (flatPlainMeshes_[i + 16])
                __builtin_prefetch(next + sizeof(Object3D), 0, 1);
            const auto* material = reinterpret_cast<const char*>(flatRecords_[i + 16].material.get());
            if (material)
                for (std::size_t offset = 0; offset < sizeof(Material); offset += 64)
                    __builtin_prefetch(material + offset, 0, 1);
        }
        if (updateChildren && i + 8 < object.children.size()) {
            const auto* future = object.children[i + 8];
            __builtin_prefetch(&future->position, 0, 1);
            __builtin_prefetch(&future->quaternion, 0, 1);
            __builtin_prefetch(&future->scale, 0, 1);
            __builtin_prefetch(&future->matrix, 1, 1);
            __builtin_prefetch(reinterpret_cast<const char*>(&future->matrix) + 64, 1, 1);
            __builtin_prefetch(&future->matrixWorld, 1, 1);
            __builtin_prefetch(reinterpret_cast<const char*>(&future->matrixWorld) + 64, 1, 1);
        }
#endif
        if (updateChildren)
            child->Object3D::updateMatrixWorldSelf(force, flatParentIdentity_, flatPlainMeshes_[i]);
        project(*child, camera, items, lights, false, false, updateChildren ? &flatRecords_[i] : nullptr,
                updateChildren && flatPlainMeshes_[i], lightsOnly, excluded);
    }
}

// Groups batchable items by what they draw (geometry buffers, material, kind, render order) and
// replaces each group of kMinBatchMembers or more with one instanced item: identity model matrix,
// the members' world matrices (float32, as a uniform holds them) as instance matrices, drawn in the
// first member's place.
void RenderDatabase::batch(std::vector<DrawItem>& items, Object3D& scene,
                           const std::vector<std::pair<double, const DrawItem*>>& ordered) {
    // A decline writes no verdict, so a settled one is an empty decision until its rescan; an empty
    // scene (still loading) or a projecting one is judged again next frame, as SceneRenderProjection.
    projection::Decision decision;
    if (std::any_of(items.begin(), items.end(), [](const DrawItem& item) { return item.skinnedRig; }) &&
        ++framesSinceDeclineScan_ >= kDeclineRescanFrames) {
        decision = projection::decide(scene);
        framesSinceDeclineScan_ = decision.projecting || decision.sourceRenderables == 0 ? kDeclineRescanFrames : 0;
    }
    skinnedPalettes_.clear();
    batchGroupsList_.clear();
    candidatesByKey_.clear();
    for (const auto& [depth, item] : ordered) {
        const std::size_t i = item - items.data();
        const DrawItem& d = items[i];
        const auto verdict = decision.verdict.find(d.skinnedRig);
        const bool skinned = d.boneMatrices && verdict != decision.verdict.end() && verdict->second == "skinned";
        if (!d.batchable && !skinned)
            continue;
        auto same = [&](const std::vector<std::size_t>& g) {
            const DrawItem& o = items[g.front()];
            if (bool(o.skinnedRig) != bool(d.skinnedRig))
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
    batchParams_.resize(batchGroupsList_.size());
    for (const std::vector<std::size_t>& g : batchGroupsList_) {
        const bool skinned = items[g.front()].skinnedRig != nullptr;
        if (!skinned && g.size() < kMinBatchMembers)
            continue;
        SkinnedPalette* palette = nullptr;
        if (skinned) {
            skinnedPalettes_.push_back(
                std::make_unique<SkinnedPalette>(items[g.front()].skinnedRig->skeleton->bones.size(), g.size(), false));
            palette = skinnedPalettes_.back().get();
            palette->begin();
        }
        if (batchStores_.size() <= batchGroups_)
            batchStores_.push_back(std::make_shared<BufferStore>(Scalar::F32, 0));
        const auto slot = batchGroups_++;
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
            if (palette) {
                const auto slot = palette->claim(items[i].skinnedRig);
                palette->write(*slot, *items[i].skinnedRig, false); // project updated this skeleton once
            }
            // SkinnedPalette already folds world placement into the bones. Instance transforms
            // must be identity; applying each rig's matrix here would transform it twice.
            const Matrix identity{1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
            for (double e : palette ? identity : items[i].matrixWorld)
                matrices[matrixOffset++] = static_cast<float>(e);
            if (colors) for (float c : items[i].material->color) colors[colorOffset++] = c;
            absorbed_[i] = true;
        }
        store.needsUpdate();
        DrawItem d = items[g.front()];
        if (batchCaches_.size() <= slot) batchCaches_.resize(slot + 1);
        d.cache = &batchCaches_[slot];
        d.sortOrigin = {d.matrixWorld[12], d.matrixWorld[13], d.matrixWorld[14]};
        d.matrixWorld = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
        d.instanceMatrices = &store;
        d.instanceCount = static_cast<uint32_t>(g.size());
        if (uniform) {
            batchColors_[slot]->needsUpdate();
            d.instanceColors = batchColors_[slot].get();
            auto& params = batchParams_[slot];
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
    batchedOut_.clear();
    batchedOut_.reserve(items.size() - batchMembers_ + merged_.size());
    for (std::size_t i = 0; i < items.size(); ++i)
        if (!absorbed_[i])
            batchedOut_.push_back(items[i]);
    batchedOut_.insert(batchedOut_.end(), merged_.begin(), merged_.end());
    items.swap(batchedOut_);
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
            bucket.push_back(group);
            if (group == meshGroups_.size()) meshGroups_.push_back({geometry, {}});
            else {
                auto& reused = meshGroups_[group];
                reused.geometry = geometry;
                reused.members.clear();
                reused.orderedIds = true;
            }
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
    batchParams_.resize(batchGroups_ + meshGroupCount_);
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
        const auto slot = batchGroups_++;
        if (batchCaches_.size() <= slot) batchCaches_.resize(slot + 1);
        d.cache = &batchCaches_[slot];
        if (batchStores_.size() <= slot)
            batchStores_.push_back(std::make_shared<BufferStore>(Scalar::F32, 0));
        auto& matrices = *batchStores_[slot];
        if (matrices.count() != members.size() * 16)
            matrices.resize(members.size() * 16);
        auto* matrix = reinterpret_cast<float*>(matrices.data());
        const bool uniform = std::any_of(members.begin(), members.end(), [&](std::size_t i) {
            return batchMeshes_[i].material != first.material.get();
        });
        if (batchColors_.size() <= slot)
            batchColors_.resize(slot + 1);
        if (uniform && !batchColors_[slot])
            batchColors_[slot] = std::make_shared<BufferStore>(Scalar::F32, 0);
        if (uniform && batchColors_[slot]->count() != members.size() * 3)
            batchColors_[slot]->resize(members.size() * 3);
        auto* color = uniform ? reinterpret_cast<float*>(batchColors_[slot]->data()) : nullptr;
        for (std::size_t i = 0; i < members.size(); ++i) {
#if defined(__GNUC__) && !defined(__EMSCRIPTEN__)
            if (i + 16 < members.size()) {
                const auto next = members[i + 16];
                __builtin_prefetch(&batchTransforms_[next], 0, 3);
                if (color) __builtin_prefetch(&batchRgb_[next], 0, 3);
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
        if (uniform) {
            batchColors_[slot]->needsUpdate();
            d.instanceColors = batchColors_[slot].get();
            batchParams_[slot] = *d.material;
            batchParams_[slot].color = {1, 1, 1};
            d.material = &batchParams_[slot];
        }
        items.push_back(std::move(d));
        batchMembers_ += members.size();
    }
}

const std::vector<DrawItem>& RenderDatabase::prepare(Object3D& scene, Camera& camera, LightState& lights, Object3D* targetScene) {
    using Clock = std::chrono::steady_clock;
    const auto start = profiling ? Clock::now() : Clock::time_point{};
    if (targetScene && targetScene != &scene && targetScene->matrixWorldAutoUpdate) targetScene->updateMatrixWorld();
    ++frame_;
    ++projection::detail::uniformEpoch();
    diagnostics_.clear();
    hemisphere_ = 0;
    // Renderer.render: world matrices first, then the camera in the renderer's coordinate system.
    // Fusion is safe only when matrix updates and light queries cannot run authored hooks.
    // Recheck the public child vector before any update: callers can reorder or replace its slots.
    const auto& cameraType = typeid(camera);
    bool flat = typeid(scene) == typeid(Scene) && scene.matrixWorldAutoUpdate && camera.parent == nullptr &&
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
            if (type == typeid(SpotLight)) target = static_cast<const SpotLight*>(child)->target;
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
    if (flat)
        force = scene.updateMatrixWorldSelf();
    else if (scene.matrixWorldAutoUpdate)
        scene.updateMatrixWorld();
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
    lights.softShadows = shadowMapType == 2;
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
    project(scene, camera, items, lights, flat, force);
    if (targetScene && targetScene != &scene)
        project(*targetScene, camera, items, lights, false, false, nullptr, false, true, &scene);
    const auto projected = profiling ? Clock::now() : Clock::time_point{};
    // three's LightsNode sorts its lights by id; the direct terms are summed in that order.
    std::stable_sort(direct_.begin(), direct_.end(), [](const auto& a, const auto& b) { return a.first < b.first; });
    for (const auto& [id, light] : direct_) lights.direct.push_back(light);
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
    for (const PendingCallback& p : callbacks_) {
        const RenderCallback callback = p.mesh->onBeforeRender;
        if (!callback)
            continue;
        std::string error;
        if (!(*callback)({&scene, &camera, p.mesh->geometry, p.mesh->material}, error))
            diagnostics_.push_back("TN_CALLBACK_FAILED onBeforeRender: " + error);
        p.record->draw->params = paramsOf(*p.record->material);
    }
    callbacks_.clear();
    if (hemisphere_ > 1)
        diagnostics_.push_back("TN_NATIVE_LIGHTS_UNSUPPORTED: " + std::to_string(hemisphere_) +
                               " hemisphere lights; one is drawn");
    for (auto& r : flatRecords_) if (r.seen != frame_) r = Record{};
    // Objects that left the scene leave the database.
    for (auto it = records_.begin(); it != records_.end();) {
        if (it->second.seen != frame_) {
            it = records_.erase(it);
        } else {
            ++it;
        }
    }
    batchGroups_ = batchMembers_ = 0;
    const auto beforeBatch = profiling ? Clock::now() : Clock::time_point{};
    if (batching) {
        batchParams_.reserve(items.size() + meshGroupCount_);
        CameraState state;
        state.matrixWorldInverse = toArray(camera.matrixWorldInverse);
        state.projectionMatrix = toArray(camera.projectionMatrix);
        batch(items, scene, Renderer::sortDraws(items, state));
        batchMeshes(items);
    }
    const auto batched = profiling ? Clock::now() : Clock::time_point{};
    // Resolve the scene fallback every frame: environment can change without a material version bump.
    const Scene* world = dynamic_cast<const Scene*>(&scene);
    if (!world && targetScene) world = dynamic_cast<const Scene*>(targetScene);
    for (DrawItem& item : items) {
        const Material& source = *static_cast<const Material*>(item.materialKey);
        item.fog = world && source.fog ? world->fog.get() : nullptr;
        // three's materialEnvRotation: the scene's environmentRotation when the scene has an
        // environment and the material no envMap, else the material's envMapRotation (identity here).
        const GraphSources& sources = graphSources(source);
        item.pmremMap = sources.texture;
        item.reflector = sources.reflector.get();
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
        if (item.envMap && !item.envMap->hasImage()) item.envMap = nullptr;
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
    if (world && world->backgroundTexture) {
        if (world->backgroundTexture->mapping != 303 || world->backgroundBlurriness != 0)
            throw std::runtime_error("TN_NATIVE_BACKGROUND_UNSUPPORTED: sharp EquirectangularReflectionMapping required");
        if (!backgroundGeometry_) backgroundGeometry_ = makeSphereGeometry(1, 32, 32);
        DrawItem sky;
        sky.background = true;
        sky.key = std::numeric_limits<uint64_t>::max();
        sky.positions = backgroundGeometry_->attributes.at("position")->store.get();
        sky.normals = backgroundGeometry_->attributes.at("normal")->store.get();
        sky.indices = backgroundGeometry_->index->store.get();
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
        sky.map = world->backgroundTexture.get();
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
    const auto& items = prepare(root, camera, lights, targetScene);
    if (!diagnostics_.empty()) throw std::runtime_error(diagnostics_.front());
    CameraState state;
    state.matrixWorld = toArray(camera.matrixWorld);
    state.matrixWorldInverse = toArray(camera.matrixWorldInverse);
    state.projectionMatrix = toArray(camera.projectionMatrix);
    return renderer.compileAsync(items, state, lights, outputFormat);
}

uint64_t RenderDatabase::render(Renderer& renderer, Object3D& scene, Camera& camera, std::array<double, 4> clear, std::array<double, 2>* cpuMs) {
    using Clock = std::chrono::steady_clock;
    const auto start = cpuMs ? Clock::now() : Clock::time_point{};
    prepare(scene, camera, lights_);
    if (!reflecting_) renderReflections(renderer, scene, camera, items_, clear);
    cameraState_.matrixWorld = toArray(camera.matrixWorld);
    cameraState_.matrixWorldInverse = toArray(camera.matrixWorldInverse);
    cameraState_.projectionMatrix = toArray(camera.projectionMatrix);
    if (const auto* perspective = dynamic_cast<const PerspectiveCamera*>(&camera))
        std::tie(cameraState_.near, cameraState_.far) = std::pair{perspective->near, perspective->far};
    else if (const auto* orthographic = dynamic_cast<const OrthographicCamera*>(&camera))
        std::tie(cameraState_.near, cameraState_.far) = std::pair{orthographic->near, orthographic->far};
    if (const auto* world = dynamic_cast<const Scene*>(&scene); world && world->background)
        clear = {world->background->r, world->background->g, world->background->b, 1};
    const auto prepared = cpuMs ? Clock::now() : Clock::time_point{};
    const auto result = renderer.render(items_, cameraState_, lights_, clear);
    if (cpuMs) *cpuMs = {std::chrono::duration<double, std::milli>(prepared - start).count(),
                        std::chrono::duration<double, std::milli>(Clock::now() - prepared).count()};
    return result;
}

void RenderDatabase::renderReflections(Renderer& renderer, Object3D& scene, Camera& camera, std::vector<DrawItem>& items,
                                       std::array<double, 4> clear) {
    for (auto it = reflections_.begin(); it != reflections_.end();)
        it = it->second.owner.expired() ? reflections_.erase(it) : std::next(it);
    std::vector<std::shared_ptr<const Reflector>> drawn;
    std::vector<Material*> hidden;
    for (const DrawItem& item : items) {
        if (!item.mainPass || !item.reflector) continue;
        auto* material = const_cast<Material*>(static_cast<const Material*>(item.materialKey));
        if (std::find(hidden.begin(), hidden.end(), material) == hidden.end()) hidden.push_back(material);
        if (std::none_of(drawn.begin(), drawn.end(), [&](const auto& r) { return r.get() == item.reflector; }))
            drawn.push_back(std::static_pointer_cast<const Reflector>(graphSources(*material).reflector));
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
        ReflectionPass& pass = reflections_[reflector.get()];
        if (!pass.renderer) {
            pass.owner = reflector;
            pass.renderer = renderer.sibling();
            pass.database = std::make_unique<RenderDatabase>();
            pass.database->reflecting_ = true;
        }
        pass.database->batching = batching;
        pass.database->shadowMapEnabled = shadowMapEnabled;
        pass.renderer->setOutput(renderer.output());
        pass.renderer->setSize(uint32_t(std::lround(renderer.width() * reflector->resolutionScale)),
                               uint32_t(std::lround(renderer.height() * reflector->resolutionScale)));
        PerspectiveCamera& virtualCamera = *reflector->camera;
        if (poseReflection(*reflector, camera, virtualCamera))
            pass.database->render(*pass.renderer, scene, virtualCamera, clear);
        else
            pass.renderer->render({}, CameraState{}, LightState{}, {0, 0, 0, 0});
        for (const auto& message : pass.database->diagnostics()) diagnostics_.push_back(message);
    }
    for (DrawItem& item : items) {
        if (!item.reflector) continue;
        item.reflectorView = reflections_.at(item.reflector).renderer->sceneColorView();
        item.reflectorSampler = renderer.linearClampSampler();
    }
}

} // namespace tn::engine
