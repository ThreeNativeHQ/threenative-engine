// glTF to a native scene in GLTFLoader's shape (PRD-515 phase 1). Read loader.h first.
//
// Numbers a game sees (node transforms, material factors) are read from the JSON chunk as doubles,
// as JSON.parse gives them to three; cgltf stores them as float. cgltf owns the structure, the
// bounds checks and the binary data.
#include "engine/assets/gltf/loader.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <map>
#include <set>

#include "cgltf.h"
#include "engine/animation/skinning/skeleton.h"
#include "engine/assets/gltf/image_decode.h"
#include "engine/foundation/json.h"
#include "engine/scene/geometry.h"
#include "engine/scene/material.h"
#include "engine/scene/camera.h"
#include "engine/scene/lights.h"

namespace tn::engine::gltf {
namespace {

using json::Value;
using animation::AnimationClip;
using animation::Interpolation;
using animation::KeyframeTrack;
using animation::TrackType;

const Value* member(const Value* v, std::string_view key) { return v && v->isObject() ? v->find(key) : nullptr; }
const Value* item(const Value* v, std::size_t i) {
    return v && v->isArray() && i < v->items().size() ? &v->items()[i] : nullptr;
}
double number(const Value* v, double fallback) { return v && v->isNumber() ? v->number() : fallback; }
std::string text(const Value* v) { return v && v->isString() ? v->string() : std::string(); }
bool truthyName(const Value* v) { return v && v->isString() && !v->string().empty(); }

// PropertyBinding.sanitizeNodeName: whitespace to '_', then the reserved characters "[].:/" removed.
// ponytail: JS \s also matches Unicode spaces beyond NBSP; ASCII and U+00A0 cover the corpus.
std::string sanitizeNodeName(const std::string& name) {
    std::string out;
    for (std::size_t i = 0; i < name.size(); ++i) {
        const unsigned char c = static_cast<unsigned char>(name[i]);
        if (c == ' ' || c == '\t' || c == '\n' || c == '\v' || c == '\f' || c == '\r') {
            out += '_';
        } else if (c == 0xC2 && i + 1 < name.size() && static_cast<unsigned char>(name[i + 1]) == 0xA0) {
            out += '_';
            ++i;
        } else if (c != '[' && c != ']' && c != '.' && c != ':' && c != '/') {
            out += static_cast<char>(c);
        }
    }
    return out;
}

// The extensions GLTFLoader implements; one of these in a file changes what three builds, so this
// loader refuses it rather than build something else.
const std::set<std::string> kThreeExtensions = {
    "KHR_binary_glTF", "KHR_draco_mesh_compression", "KHR_lights_punctual", "KHR_materials_clearcoat",
    "KHR_materials_dispersion", "KHR_materials_ior", "KHR_materials_sheen", "KHR_materials_specular",
    "KHR_materials_transmission", "KHR_materials_iridescence", "KHR_materials_anisotropy", "KHR_materials_unlit",
    "KHR_materials_volume", "KHR_texture_basisu", "KHR_texture_transform", "KHR_mesh_quantization",
    "KHR_materials_emissive_strength", "EXT_materials_bump", "EXT_texture_webp", "EXT_texture_avif",
    "EXT_meshopt_compression", "KHR_meshopt_compression", "EXT_mesh_gpu_instancing"};
const std::set<std::string> kSupported = {"KHR_mesh_quantization", "KHR_lights_punctual", "KHR_materials_unlit",
                                          "KHR_materials_ior", "KHR_materials_specular", "KHR_materials_clearcoat"};

class Builder {
  public:
    Builder(const cgltf_data& data, const Value& json, const LoadOptions& options)
        : data_(data), json_(json), options_(options) {}

    LoadResult run() {
        LoadResult result;
        if (!checkExtensions()) return fail(result);
        markDefs();
        const Value* scenes = member(&json_, "scenes");
        for (std::size_t i = 0; i < data_.scenes_count; ++i) {
            result.scenes.push_back(loadScene(i, item(scenes, i)));
            if (!error_.empty()) return fail(result);
        }
        for (std::size_t i = 0; i < data_.cameras_count; ++i) result.cameras.push_back(loadCamera(i));
        if (!error_.empty()) return fail(result);
        resolveMeshes();
        if (!error_.empty()) return fail(result);
        bindSkins();
        if (!error_.empty()) return fail(result);
        const Value* animations = member(&json_, "animations");
        for (std::size_t i = 0; i < data_.animations_count; ++i) {
            result.animations.push_back(loadAnimation(i, item(animations, i)));
            if (!error_.empty()) return fail(result);
        }
        const std::size_t sceneIndex = data_.scene ? static_cast<std::size_t>(data_.scene - data_.scenes) : 0;
        if (sceneIndex < result.scenes.size()) result.scene = result.scenes[sceneIndex];
        return result;
    }

  private:
    LoadResult& fail(LoadResult& result) {
        result = LoadResult{};
        result.error = error_;
        return result;
    }
    void refuse(std::string error) {
        if (error_.empty()) error_ = std::move(error);
    }

    bool checkExtensions() {
        for (std::size_t i = 0; i < data_.extensions_used_count; ++i) {
            const std::string name = data_.extensions_used[i];
            if (name == "EXT_texture_webp" && decodesWebP()) continue;
            if (kThreeExtensions.count(name) && !kSupported.count(name)) {
                refuse("TN_NATIVE_GLTF_EXTENSION_UNSUPPORTED " + name);
                return false;
            }
        }
        for (std::size_t i = 0; i < data_.extensions_required_count; ++i) {
            const std::string name = data_.extensions_required[i];
            if (name == "EXT_texture_webp" && decodesWebP()) continue;
            if (!kSupported.count(name)) {
                refuse("TN_NATIVE_GLTF_EXTENSION_UNSUPPORTED " + name);
                return false;
            }
        }
        return true;
    }

    // _markDefs: joints become Bones, meshes under a skinned node become SkinnedMeshes.
    void markDefs() {
        bones_.assign(data_.nodes_count, false);
        skinnedMesh_.assign(data_.meshes_count, false);
        for (std::size_t s = 0; s < data_.skins_count; ++s)
            for (std::size_t j = 0; j < data_.skins[s].joints_count; ++j)
                bones_[data_.skins[s].joints[j] - data_.nodes] = true;
        for (std::size_t n = 0; n < data_.nodes_count; ++n)
            if (data_.nodes[n].mesh && data_.nodes[n].skin) skinnedMesh_[data_.nodes[n].mesh - data_.meshes] = true;
    }

    // createUniqueName: the sanitized name, then name_1, name_2 for its repeats.
    std::string uniqueName(const std::string& original) {
        const std::string sanitized = sanitizeNodeName(original);
        const auto found = namesUsed_.find(sanitized);
        if (found != namesUsed_.end()) return sanitized + "_" + std::to_string(++found->second);
        namesUsed_[sanitized] = 0;
        return sanitized;
    }

    std::shared_ptr<Group> loadScene(std::size_t index, const Value* def) {
        auto scene = std::make_shared<Group>();
        if (truthyName(member(def, "name"))) scene->name = uniqueName(text(member(def, "name")));
        const cgltf_scene& s = data_.scenes[index];
        for (std::size_t i = 0; i < s.nodes_count && error_.empty(); ++i) {
            const std::size_t n = s.nodes[i] - data_.nodes;
            std::shared_ptr<Object3D> node = loadNode(n);
            if (!node) return scene;
            if (node->parent != nullptr) {
                refuse("TN_NATIVE_GLTF_SHARED_NODE_UNSUPPORTED node " + std::to_string(n));
                return scene;
            }
            scene->add(*node);
        }
        return scene;
    }

    // loadNode: the node itself (_loadNodeShallow, which takes its name now), then its children in
    // order; skins bind once every node exists (bindSkins).
    std::shared_ptr<Object3D> loadNode(std::size_t index) {
        if (nodes_.size() < data_.nodes_count) nodes_.resize(data_.nodes_count);
        if (nodes_[index]) return nodes_[index];
        std::shared_ptr<Object3D> node = loadNodeShallow(index);
        if (!node) return nullptr;
        const cgltf_node& def = data_.nodes[index];
        for (std::size_t i = 0; i < def.children_count; ++i) {
            std::shared_ptr<Object3D> child = loadNode(def.children[i] - data_.nodes);
            if (!child) return nullptr;
            node->add(*child);
        }
        return node;
    }

    std::shared_ptr<Object3D> loadNodeShallow(std::size_t index) {
        const cgltf_node& def = data_.nodes[index];
        const Value* json = item(member(&json_, "nodes"), index);
        const bool named = truthyName(member(json, "name"));
        const std::string nodeName = named ? uniqueName(text(member(json, "name"))) : std::string();
        // _loadNodeShallow: mesh, camera and extension attachments, in that order.
        std::vector<std::shared_ptr<Object3D>> objects;
        if (def.mesh) objects.push_back(meshObjectFor(def.mesh - data_.meshes, index));
        if (def.camera) objects.push_back(cameraRef(def.camera - data_.cameras));
        if (def.light) objects.push_back(loadLight(def.light - data_.lights));
        if (!error_.empty()) return nullptr;
        std::shared_ptr<Object3D> node;
        if (bones_[index]) node = std::make_shared<Bone>();
        else if (objects.size() > 1) node = std::make_shared<Group>();
        else if (objects.size() == 1) node = objects.front();
        else node = std::make_shared<Object3D>();
        if (!objects.empty() && node != objects.front())
            for (const auto& object : objects) node->add(*object);
        if (named) {
            node->name = nodeName;
            nodeNames_[node.get()] = nodeName; // the node's name outlives the mesh name taken later
        }
        // Transforms, from the JSON doubles.
        if (const Value* matrix = member(json, "matrix"); matrix && matrix->isArray() && matrix->items().size() == 16) {
            std::array<double, 16> e{};
            for (int i = 0; i < 16; ++i) e[i] = number(item(matrix, i), 0);
            Matrix4 m;
            m.fromArray(e.data());
            node->applyMatrix4(m);
        } else {
            if (const Value* t = member(json, "translation"))
                node->position.set(number(item(t, 0), 0), number(item(t, 1), 0), number(item(t, 2), 0));
            if (const Value* r = member(json, "rotation"))
                node->quaternion.set(number(item(r, 0), 0), number(item(r, 1), 0), number(item(r, 2), 0),
                                     number(item(r, 3), 1));
            if (const Value* s = member(json, "scale"))
                node->scale.set(number(item(s, 0), 1), number(item(s, 1), 1), number(item(s, 2), 1));
        }
        nodes_[index] = node;
        return node;
    }

    std::shared_ptr<Camera> loadCamera(std::size_t index) {
        auto& camera = cameras_[index];
        if (camera) return camera;
        const Value* def = item(member(&json_, "cameras"), index);
        const std::string type = text(member(def, "type"));
        const Value* params = member(def, type);
        if (!params) { refuse("TN_NATIVE_GLTF_CAMERA_INVALID missing parameters"); return nullptr; }
        if (type == "perspective") {
            // GLTFLoader uses JS `||`, including its 2e6 default when zfar is absent.
            const auto nonzero = [&](const char* name, double fallback) {
                const double value = number(member(params, name), 0); return value == 0 ? fallback : value;
            };
            camera = std::make_shared<PerspectiveCamera>(number(member(params, "yfov"), 0) * (180 / 3.141592653589793),
                nonzero("aspectRatio", 1), nonzero("znear", 1), nonzero("zfar", 2e6));
        } else if (type == "orthographic") {
            const double x = number(member(params, "xmag"), 0), y = number(member(params, "ymag"), 0);
            camera = std::make_shared<OrthographicCamera>(-x, x, y, -y,
                number(member(params, "znear"), 0.1), number(member(params, "zfar"), 2000));
        } else { refuse("TN_NATIVE_GLTF_CAMERA_INVALID " + type); return nullptr; }
        if (truthyName(member(def, "name"))) camera->name = uniqueName(text(member(def, "name")));
        return camera;
    }

    std::shared_ptr<Camera> cameraRef(std::size_t index) {
        auto camera = loadCamera(index);
        if (!camera) return nullptr;
        std::size_t refs = 0;
        for (std::size_t i = 0; i < data_.nodes_count; ++i) refs += data_.nodes[i].camera == &data_.cameras[index];
        if (refs <= 1) return camera;
        std::shared_ptr<Camera> clone;
        if (auto p = std::dynamic_pointer_cast<PerspectiveCamera>(camera)) {
            auto copy = std::make_shared<PerspectiveCamera>(); copy->copy(*p); clone = copy;
        } else {
            auto copy = std::make_shared<OrthographicCamera>(); copy->copy(*std::static_pointer_cast<OrthographicCamera>(camera)); clone = copy;
        }
        clone->name += "_instance_" + std::to_string(cameraUses_[index]++);
        return clone;
    }

    std::shared_ptr<Light> loadLight(std::size_t index) {
        const Value* def = item(member(member(member(&json_, "extensions"), "KHR_lights_punctual"), "lights"), index);
        if (!def) { refuse("TN_NATIVE_GLTF_LIGHT_INVALID missing definition"); return nullptr; }
        const Value* rgb = member(def, "color");
        const Color color(number(item(rgb, 0), 1), number(item(rgb, 1), 1), number(item(rgb, 2), 1));
        const double range = number(member(def, "range"), 0);
        const std::string type = text(member(def, "type"));
        std::shared_ptr<Light> light;
        if (type == "directional") {
            auto sun = std::make_shared<DirectionalLight>(color);
            sun->target->position.set(0, 0, -1); sun->add(*sun->target); light = sun;
        } else if (type == "point") {
            light = std::make_shared<PointLight>(color, 1, range);
        } else if (type == "spot") {
            const Value* spot = member(def, "spot");
            const double outer = number(member(spot, "outerConeAngle"), 3.141592653589793 / 4);
            auto cone = std::make_shared<SpotLight>(color, 1, range, outer,
                1 - number(member(spot, "innerConeAngle"), 0) / outer);
            // Object3D owns shared children, so replace SpotLight's constructor-owned target.
            auto target = std::make_shared<Object3D>(); target->position.set(0, 0, -1);
            cone->ownTarget.reset(); cone->target = target.get(); cone->add(*target); light = cone;
        } else { refuse("TN_NATIVE_GLTF_LIGHT_INVALID " + type); return nullptr; }
        light->position.set(0, 0, 0);
        light->intensity = number(member(def, "intensity"), 1);
        auto& name = lightNames_[index];
        if (name.empty()) name = uniqueName(truthyName(member(def, "name")) ? text(member(def, "name")) : "light_" + std::to_string(index));
        light->name = name;
        std::size_t refs = 0;
        for (std::size_t i = 0; i < data_.nodes_count; ++i) refs += data_.nodes[i].light == &data_.lights[index];
        if (refs > 1) light->name += "_instance_" + std::to_string(lightUses_[index]++);
        return light;
    }

    // A mesh's object for one node: the first use builds it (its name is taken in resolveMeshes);
    // a later node shares the geometry and materials through objects of its own, as three's clone does.
    struct Primitive {
        std::shared_ptr<BufferGeometry> geometry;
        std::shared_ptr<Material> material;
        std::shared_ptr<Mesh> mesh;
    };
    struct MeshUse {
        std::size_t mesh;
        std::shared_ptr<Object3D> object;     // the Mesh, or the Group of primitive meshes
        std::vector<std::shared_ptr<Mesh>> meshes;
    };
    std::shared_ptr<Object3D> meshObjectFor(std::size_t meshIndex, std::size_t /*nodeIndex*/) {
        const cgltf_mesh& def = data_.meshes[meshIndex];
        MeshUse use{meshIndex, nullptr, {}};
        for (std::size_t p = 0; p < def.primitives_count; ++p) {
            std::shared_ptr<Mesh> mesh =
                skinnedMesh_[meshIndex] ? std::make_shared<SkinnedMesh>() : std::make_shared<Mesh>();
            use.meshes.push_back(mesh);
        }
        if (use.meshes.size() == 1) {
            use.object = use.meshes[0];
        } else {
            auto group = std::make_shared<Group>();
            for (const auto& mesh : use.meshes) group->add(*mesh);
            use.object = group;
        }
        uses_.push_back(use);
        return use.object;
    }

    // loadMesh's continuation, in the order the meshes were first asked for: geometry, final
    // material, then the unique name (from the mesh's name, or mesh_<index>), which a node object
    // that *is* the mesh then overrides with its own.
    void resolveMeshes() {
        std::map<std::size_t, std::vector<std::string>> named; // first use takes the names
        for (MeshUse& use : uses_) {
            const cgltf_mesh& def = data_.meshes[use.mesh];
            const Value* json = item(member(&json_, "meshes"), use.mesh);
            const bool first = !named.count(use.mesh);
            std::vector<std::string>& names = named[use.mesh];
            for (std::size_t p = 0; p < def.primitives_count; ++p) {
                const cgltf_primitive& primitive = def.primitives[p];
                if (primitive.type != cgltf_primitive_type_triangles) {
                    refuse("TN_NATIVE_GLTF_PRIMITIVE_UNSUPPORTED mode " + std::to_string(int(primitive.type)) +
                           " in mesh " + std::to_string(use.mesh));
                    return;
                }
                Mesh& mesh = *use.meshes[p];
                mesh.geometry = geometryFor(primitive);
                if (!error_.empty()) return;
                mesh.material = finalMaterial(primitive, *mesh.geometry);
                if (!error_.empty()) return;
                if (auto* skinned = dynamic_cast<SkinnedMesh*>(&mesh)) normalizeSkinWeights(*skinned);
                if (!mesh.geometry->morphPositions.empty() || !mesh.geometry->morphNormals.empty()) {
                    mesh.updateMorphTargets();
                    if (const Value* weights = member(json, "weights"))
                        for (std::size_t w = 0; w < mesh.morphTargetInfluences.size(); ++w)
                            mesh.morphTargetInfluences[w] = number(item(weights, w), 0);
                }
                if (first) {
                    const std::string base =
                        truthyName(member(json, "name")) ? text(member(json, "name")) : "mesh_" + std::to_string(use.mesh);
                    names.push_back(uniqueName(base));
                }
                mesh.name = names[p];
            }
            // The node object that is this mesh keeps the node's name.
            if (const auto found = nodeNames_.find(use.object.get()); found != nodeNames_.end())
                use.object->name = found->second;
        }
    }

    // GLTFLoader's ATTRIBUTES, else the lower-cased glTF name; the first accessor for a name wins.
    static std::string attributeName(const std::string& gltf) {
        static const std::map<std::string, std::string> kNames = {
            {"POSITION", "position"},   {"NORMAL", "normal"},   {"TANGENT", "tangent"},  {"TEXCOORD_0", "uv"},
            {"TEXCOORD_1", "uv1"},      {"TEXCOORD_2", "uv2"},  {"TEXCOORD_3", "uv3"},   {"COLOR_0", "color"},
            {"WEIGHTS_0", "skinWeight"}, {"JOINTS_0", "skinIndex"}};
        if (const auto found = kNames.find(gltf); found != kNames.end()) return found->second;
        std::string lower = gltf;
        for (char& c : lower) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
        return lower;
    }

    std::shared_ptr<BufferGeometry> geometryFor(const cgltf_primitive& primitive) {
        auto geometry = std::make_shared<BufferGeometry>();
        for (std::size_t a = 0; a < primitive.attributes_count; ++a) {
            const cgltf_attribute& attribute = primitive.attributes[a];
            const std::string name = attributeName(attribute.name ? attribute.name : "");
            if (geometry->attributes.count(name)) continue;
            std::shared_ptr<BufferAttribute> loaded = accessor(*attribute.data);
            if (!loaded) return geometry;
            geometry->setAttribute(name, loaded);
        }
        if (primitive.indices) {
            std::shared_ptr<BufferAttribute> index = accessor(*primitive.indices);
            if (!index) return geometry;
            geometry->index = index;
        }
        // addMorphTargets: relative targets; a missing position or normal target is the base data.
        bool hasPosition = false, hasNormal = false;
        for (std::size_t t = 0; t < primitive.targets_count; ++t)
            for (std::size_t a = 0; a < primitive.targets[t].attributes_count; ++a) {
                const std::string name = primitive.targets[t].attributes[a].name;
                hasPosition = hasPosition || name == "POSITION";
                hasNormal = hasNormal || name == "NORMAL";
            }
        for (std::size_t t = 0; t < primitive.targets_count; ++t) {
            std::shared_ptr<BufferAttribute> position, normal;
            for (std::size_t a = 0; a < primitive.targets[t].attributes_count; ++a) {
                const cgltf_attribute& target = primitive.targets[t].attributes[a];
                const std::string name = target.name;
                if (name == "POSITION") position = accessor(*target.data);
                if (name == "NORMAL") normal = accessor(*target.data);
                if (!error_.empty()) return geometry;
            }
            if (hasPosition) geometry->morphPositions.push_back(position ? position : zeroLike(geometry->attributes["position"]));
            if (hasNormal) geometry->morphNormals.push_back(normal ? normal : zeroLike(geometry->attributes["normal"]));
        }
        if (primitive.targets_count) geometry->morphTargetsRelative = true;
        return geometry;
    }

    static std::shared_ptr<BufferAttribute> zeroLike(const std::shared_ptr<BufferAttribute>& base) {
        if (!base) return std::make_shared<BufferAttribute>(Scalar::F32, 0, 3);
        return std::make_shared<BufferAttribute>(Scalar::F32, base->count(), base->itemSize);
    }

    // loadAccessor: the accessor's own typed array (interleaved views de-interleaved, sparse values
    // applied), its item size and normalized flag. The bytes copy as stored, as three's typed-array
    // view reads them: no widening to double, which also quiets a signalling NaN.
    std::shared_ptr<BufferAttribute> accessor(const cgltf_accessor& a) {
        Scalar scalar = Scalar::F32;
        if (!scalarOf(a, scalar)) return nullptr;
        const int itemSize = static_cast<int>(cgltf_num_components(a.type));
        auto attribute = std::make_shared<BufferAttribute>(scalar, a.count * itemSize, itemSize, a.normalized != 0);
        if (!rawBytes(a, attribute->store->data())) return nullptr;
        return attribute;
    }

    // The accessor's stored values, in order, as the typed array holds them (not normalized).
    bool rawValues(const cgltf_accessor& a, std::vector<double>& values, Scalar& scalar) {
        if (!scalarOf(a, scalar)) return false;
        const std::size_t elementBytes = cgltf_component_size(a.component_type);
        std::vector<std::byte> bytes(a.count * cgltf_num_components(a.type) * elementBytes);
        if (!rawBytes(a, bytes.data())) return false;
        values.resize(bytes.size() / elementBytes);
        for (std::size_t i = 0; i < values.size(); ++i)
            values[i] = read(reinterpret_cast<const uint8_t*>(bytes.data()) + i * elementBytes, a.component_type);
        return true;
    }

    bool scalarOf(const cgltf_accessor& a, Scalar& scalar) {
        switch (a.component_type) {
            case cgltf_component_type_r_8: scalar = Scalar::I8; break;
            case cgltf_component_type_r_8u: scalar = Scalar::U8; break;
            case cgltf_component_type_r_16: scalar = Scalar::I16; break;
            case cgltf_component_type_r_16u: scalar = Scalar::U16; break;
            case cgltf_component_type_r_32u: scalar = Scalar::U32; break;
            case cgltf_component_type_r_32f: scalar = Scalar::F32; break;
            default:
                refuse("TN_NATIVE_GLTF_ACCESSOR_INVALID component type " + std::to_string(int(a.component_type)));
                return false;
        }
        return true;
    }

    // The accessor's bytes into `out` (zeroed, count * item bytes long): interleaved views
    // de-interleaved, sparse values applied.
    bool rawBytes(const cgltf_accessor& a, std::byte* out) {
        const std::size_t itemBytes = cgltf_component_size(a.component_type) * cgltf_num_components(a.type);
        if (a.buffer_view && a.count) {
            const uint8_t* base = cgltf_buffer_view_data(a.buffer_view);
            if (!base) {
                refuse("TN_NATIVE_GLTF_BUFFER_MISSING accessor data");
                return false;
            }
            const std::size_t stride = a.buffer_view->stride ? a.buffer_view->stride : itemBytes;
            if (stride == itemBytes) std::memcpy(out, base + a.offset, a.count * itemBytes);
            else
                for (std::size_t i = 0; i < a.count; ++i) std::memcpy(out + i * itemBytes, base + a.offset + i * stride, itemBytes);
        }
        if (a.is_sparse) {
            const cgltf_accessor_sparse& s = a.sparse;
            const uint8_t* indices = cgltf_buffer_view_data(s.indices_buffer_view);
            const uint8_t* sparseValues = cgltf_buffer_view_data(s.values_buffer_view);
            if (!indices || !sparseValues) {
                refuse("TN_NATIVE_GLTF_BUFFER_MISSING sparse data");
                return false;
            }
            const std::size_t indexBytes = cgltf_component_size(s.indices_component_type);
            for (std::size_t i = 0; i < s.count; ++i) {
                const auto at = static_cast<std::size_t>(read(indices + s.indices_byte_offset + i * indexBytes, s.indices_component_type));
                if (at >= a.count) {
                    refuse("TN_NATIVE_GLTF_ACCESSOR_INVALID sparse index out of range");
                    return false;
                }
                std::memcpy(out + at * itemBytes, sparseValues + s.values_byte_offset + i * itemBytes, itemBytes);
            }
        }
        return true;
    }

    static double read(const uint8_t* p, cgltf_component_type type) {
        switch (type) {
            case cgltf_component_type_r_8: { int8_t v; std::memcpy(&v, p, 1); return v; }
            case cgltf_component_type_r_8u: return *p;
            case cgltf_component_type_r_16: { int16_t v; std::memcpy(&v, p, 2); return v; }
            case cgltf_component_type_r_16u: { uint16_t v; std::memcpy(&v, p, 2); return v; }
            case cgltf_component_type_r_32u: { uint32_t v; std::memcpy(&v, p, 4); return v; }
            case cgltf_component_type_r_32f: { float v; std::memcpy(&v, p, 4); return v; }
            default: return 0;
        }
    }

    // loadMaterial (core glTF; refused extensions never reach here), then assignFinalMaterial: a
    // geometry without tangents, with colours or without normals takes a cached clone flagged so.
    std::shared_ptr<Material> finalMaterial(const cgltf_primitive& primitive, const BufferGeometry& geometry) {
        const long index = primitive.material ? long(primitive.material - data_.materials) : -1;
        std::shared_ptr<Material> base = baseMaterial(index);
        const bool derivativeTangents = !geometry.attributes.count("tangent");
        const bool vertexColors = geometry.attributes.count("color") > 0;
        const bool flatShading = !geometry.attributes.count("normal");
        if (!derivativeTangents && !vertexColors && !flatShading) return base;
        const std::string key = std::to_string(index) + (derivativeTangents ? ":d" : "") + (vertexColors ? ":c" : "") +
                                (flatShading ? ":f" : "");
        std::shared_ptr<Material>& cached = finalMaterials_[key];
        if (!cached) {
            cached = std::make_shared<Material>(base->type);
            copyMaterial(*base, *cached);
            if (vertexColors) cached->vertexColors = true;
            if (flatShading) cached->flatShading = true;
            if (derivativeTangents && base->maps.count("normalMap")) cached->normalScale.y *= -1;
        }
        return cached;
    }

    static void copyMaterial(const Material& from, Material& to) {
        to.name = from.name;
        to.transparent = from.transparent;
        to.opacity = from.opacity;
        to.alphaTest = from.alphaTest;
        to.depthTest = from.depthTest;
        to.depthWrite = from.depthWrite;
        to.side = from.side;
        to.visible = from.visible;
        to.color = from.color;
        to.emissive = from.emissive;
        to.emissiveIntensity = from.emissiveIntensity;
        to.roughness = from.roughness;
        to.metalness = from.metalness;
        to.vertexColors = from.vertexColors;
        to.flatShading = from.flatShading;
        to.normalScale = from.normalScale;
        to.aoMapIntensity = from.aoMapIntensity;
        to.ior = from.ior;
        to.specularIntensity = from.specularIntensity;
        to.specularColor = from.specularColor;
        to.clearcoat = from.clearcoat;
        to.clearcoatRoughness = from.clearcoatRoughness;
        to.clearcoatNormalScale = from.clearcoatNormalScale;
        to.maps = from.maps;
    }

    std::shared_ptr<Material> baseMaterial(long index) {
        if (const auto found = materials_.find(index); found != materials_.end()) return found->second;
        const Value* def = index < 0 ? nullptr : item(member(&json_, "materials"), static_cast<std::size_t>(index));
        const Value* extensions = member(def, "extensions");
        const bool unlit = member(extensions, "KHR_materials_unlit") != nullptr;
        const Value* ior = member(extensions, "KHR_materials_ior");
        const Value* specular = member(extensions, "KHR_materials_specular");
        const Value* clearcoat = member(extensions, "KHR_materials_clearcoat");
        // loadMaterial: unlit wins; otherwise the ior, specular and clearcoat plugins choose MeshPhysicalMaterial.
        auto material = std::make_shared<Material>(unlit ? MaterialType::Basic
                                                   : ior || specular || clearcoat ? MaterialType::Physical
                                                                                  : MaterialType::Standard);
        if (index < 0) {
            // createDefaultMaterial
            material->metalness = 1;
            material->roughness = 1;
            return materials_[index] = material;
        }
        const Value* pbr = member(def, "pbrMetallicRoughness");
        if (const Value* factor = member(pbr, "baseColorFactor"); factor && factor->isArray()) {
            material->color = Color(number(item(factor, 0), 1), number(item(factor, 1), 1), number(item(factor, 2), 1));
            material->opacity = number(item(factor, 3), 1);
        }
        assignTexture(*material, "map", member(pbr, "baseColorTexture"));
        if (!unlit) {
            material->metalness = number(member(pbr, "metallicFactor"), 1.0);
            material->roughness = number(member(pbr, "roughnessFactor"), 1.0);
            assignTexture(*material, "metalnessMap", member(pbr, "metallicRoughnessTexture"));
            assignTexture(*material, "roughnessMap", member(pbr, "metallicRoughnessTexture"));
        }
        if (const Value* sided = member(def, "doubleSided"); sided && sided->kind() == Value::Kind::Bool && sided->boolean())
            material->side = Side::Double;
        const std::string alphaMode = member(def, "alphaMode") ? text(member(def, "alphaMode")) : "OPAQUE";
        if (alphaMode == "BLEND") {
            material->transparent = true;
            material->depthWrite = false;
        } else {
            material->transparent = false;
            if (alphaMode == "MASK") material->alphaTest = number(member(def, "alphaCutoff"), 0.5);
        }
        if (!unlit) {
            if (const Value* normal = member(def, "normalTexture")) {
                assignTexture(*material, "normalMap", normal);
                material->normalScale.x = material->normalScale.y = number(member(normal, "scale"), 1);
            }
            if (const Value* occlusion = member(def, "occlusionTexture")) {
                assignTexture(*material, "aoMap", occlusion);
                if (member(occlusion, "strength")) material->aoMapIntensity = number(member(occlusion, "strength"), 1);
            }
            if (const Value* emissive = member(def, "emissiveFactor"))
                material->emissive = Color(number(item(emissive, 0), 0), number(item(emissive, 1), 0), number(item(emissive, 2), 0));
            assignTexture(*material, "emissiveMap", member(def, "emissiveTexture"));
            // GLTFMaterialsIorExtension: ior, 1.5 when absent, and 0 read as 1000 (three #26167).
            if (ior) {
                material->ior = number(member(ior, "ior"), 1.5);
                if (material->ior == 0) material->ior = 1000;
            }
            // GLTFMaterialsSpecularExtension: intensity (map alpha) and a linear colour (map sRGB).
            if (specular) {
                material->specularIntensity = number(member(specular, "specularFactor"), 1.0);
                assignTexture(*material, "specularIntensityMap", member(specular, "specularTexture"));
                if (const Value* color = member(specular, "specularColorFactor"); color && color->isArray())
                    material->specularColor = Color(number(item(color, 0), 1), number(item(color, 1), 1), number(item(color, 2), 1));
                assignTexture(*material, "specularColorMap", member(specular, "specularColorTexture"));
            }
            // GLTFMaterialsClearcoatExtension: each factor only when present (the physical defaults stand
            // otherwise), and the coat's maps and normal scale.
            if (clearcoat) {
                if (member(clearcoat, "clearcoatFactor")) material->clearcoat = number(member(clearcoat, "clearcoatFactor"), 0);
                assignTexture(*material, "clearcoatMap", member(clearcoat, "clearcoatTexture"));
                if (member(clearcoat, "clearcoatRoughnessFactor"))
                    material->clearcoatRoughness = number(member(clearcoat, "clearcoatRoughnessFactor"), 0);
                assignTexture(*material, "clearcoatRoughnessMap", member(clearcoat, "clearcoatRoughnessTexture"));
                if (const Value* normal = member(clearcoat, "clearcoatNormalTexture")) {
                    assignTexture(*material, "clearcoatNormalMap", normal);
                    if (member(normal, "scale"))
                        material->clearcoatNormalScale.x = material->clearcoatNormalScale.y = number(member(normal, "scale"), 1);
                }
            }
        }
        if (truthyName(member(def, "name"))) material->name = text(member(def, "name"));
        return materials_[index] = material;
    }

    void assignTexture(Material& material, const char* slot, const Value* info) {
        if (!info) return;
        const auto index = static_cast<std::size_t>(number(member(info, "index"), -1));
        const Value* def = item(member(&json_, "textures"), index);
        if (!def) {
            refuse(std::string("TN_NATIVE_GLTF_TEXTURE_INVALID ") + slot);
            return;
        }
        std::shared_ptr<Texture>& texture = textures_[index];
        if (!texture) {
            auto made = std::make_shared<Texture>();
            made->name = text(member(def, "name"));
            // GLTFTextureWebPExtension: a texture with EXT_texture_webp draws its WebP source when
            // WebP decodes (checkExtensions refused the file otherwise); `source` is the fallback.
            const Value* webp = member(member(def, "extensions"), "EXT_texture_webp");
            made->source = static_cast<int>(number(member(webp ? webp : def, "source"), -1));
            made->flipY = false;
            applySampler(*made, index);
            decodeImage(*made);
            texture = made;
        }
        // parser.assignTexture sets the colour space on the shared texture, so the last sRGB slot that
        // names it wins for every material that uses it, as upstream.
        if (std::string_view(slot) == "map" || std::string_view(slot) == "emissiveMap" || std::string_view(slot) == "specularColorMap")
            texture->colorSpace = TextureColorSpace::SRGB;
        material.maps[slot] = texture;
    }

    // GLTFLoader.assignTexture: the sampler's wraps and filters, else Repeat, Linear and
    // LinearMipmapLinear (three's WEBGL_WRAPPINGS and WEBGL_FILTERS tables).
    void applySampler(Texture& texture, std::size_t index) {
        texture.wrapS = texture.wrapT = static_cast<uint16_t>(TextureWrap::Repeat);
        texture.magFilter = static_cast<uint16_t>(TextureFilter::Linear);
        texture.minFilter = static_cast<uint16_t>(TextureFilter::LinearMipmapLinear);
        const cgltf_sampler* sampler = index < data_.textures_count ? data_.textures[index].sampler : nullptr;
        if (!sampler) return;
        auto wrap = [](int mode, uint16_t fallback) -> uint16_t {
            return mode == 33071 ? 1001 : mode == 33648 ? 1002 : mode == 10497 ? 1000 : fallback;
        };
        auto filter = [](int mode, uint16_t fallback) -> uint16_t {
            switch (mode) {
                case 9728: return 1003; case 9729: return 1006; case 9984: return 1004;
                case 9985: return 1007; case 9986: return 1005; case 9987: return 1008;
                default: return fallback;
            }
        };
        texture.wrapS = wrap(sampler->wrap_s, texture.wrapS);
        texture.wrapT = wrap(sampler->wrap_t, texture.wrapT);
        texture.magFilter = filter(sampler->mag_filter, texture.magFilter);
        texture.minFilter = filter(sampler->min_filter, texture.minFilter);
    }

    // The texture's image bytes (a GLB view or a base64 data URI) become RGBA8. A format this loader
    // does not decode, or an image in an external file, stays undecoded and the player refuses the
    // model by name; a PNG or JPEG that will not decode is a damaged file and fails the load.
    void decodeImage(Texture& texture) {
        if (texture.source < 0 || static_cast<std::size_t>(texture.source) >= data_.images_count) return;
        if (options_.externalImage) {
            if (auto image = options_.externalImage(static_cast<std::size_t>(texture.source))) {
                texture.width = image->width;
                texture.height = image->height;
                texture.external = std::move(image);
                return;
            }
        }
        const cgltf_image& image = data_.images[texture.source];
        void* freeAfter = nullptr;  // a base64 image's decoded copy, read in place
        const uint8_t* bytes = nullptr;
        std::size_t size = 0;
        if (image.buffer_view) {
            bytes = static_cast<const uint8_t*>(cgltf_buffer_view_data(image.buffer_view));
            size = image.buffer_view->size;
        } else if (image.uri && std::strncmp(image.uri, "data:", 5) == 0) {
            const char* comma = std::strchr(image.uri, ',');
            if (!comma || comma - image.uri < 7 || std::strncmp(comma - 7, ";base64", 7) != 0) return;
            const std::size_t length = std::strlen(comma + 1);
            const std::size_t padding = length >= 2 ? (comma[length] == '=') + (comma[length - 1] == '=') : 0;
            cgltf_options options{};
            void* decoded = nullptr;
            const std::size_t decodedSize = length / 4 * 3 - padding;
            if (cgltf_load_buffer_base64(&options, decodedSize, comma + 1, &decoded) != cgltf_result_success) {
                refuse("TN_NATIVE_GLTF_IMAGE_INVALID image " + std::to_string(texture.source) + " base64");
                return;
            }
            bytes = static_cast<const uint8_t*>(decoded);
            size = decodedSize;
            freeAfter = decoded;
        }
        if (bytes && imageFormat(bytes, size) != ImageFormat::Unknown &&
            !gltf::decodeImage(bytes, size, texture.width, texture.height, texture.data)) {
            texture.width = texture.height = 0;
            refuse("TN_NATIVE_GLTF_IMAGE_INVALID image " + std::to_string(texture.source));
        }
        std::free(freeAfter);
    }

    // SkinnedMesh.normalizeSkinWeights: each vertex's weights over their sum; all zero becomes (1,0,0,0).
    static void normalizeSkinWeights(SkinnedMesh& mesh) {
        auto found = mesh.geometry->attributes.find("skinWeight");
        if (found == mesh.geometry->attributes.end()) return;
        BufferAttribute& weights = *found->second;
        for (uint64_t i = 0; i < weights.count(); ++i) {
            const double x = weights.getX(i), y = weights.getY(i), z = weights.getZ(i), w = weights.getW(i);
            const double length = std::abs(x) + std::abs(y) + std::abs(z) + std::abs(w); // manhattanLength
            const double scale = 1.0 / length;
            if (scale != INFINITY) {
                weights.setX(i, x * scale).setY(i, y * scale).setZ(i, z * scale).setW(i, w * scale);
            } else {
                weights.setX(i, 1).setY(i, 0).setZ(i, 0).setW(i, 0);
            }
        }
    }

    // loadNode's skin step: every SkinnedMesh under a skinned node binds the skin's Skeleton with
    // an identity bind matrix.
    void bindSkins() {
        const Value* skins = member(&json_, "skins");
        std::vector<std::shared_ptr<Skeleton>> skeletons(data_.skins_count);
        for (std::size_t n = 0; n < data_.nodes_count; ++n) {
            const cgltf_node& def = data_.nodes[n];
            if (!def.skin || n >= nodes_.size() || !nodes_[n]) continue;
            const std::size_t s = def.skin - data_.skins;
            if (!skeletons[s]) skeletons[s] = loadSkin(s, item(skins, s));
            if (!error_.empty()) return;
            bindUnder(*nodes_[n], skeletons[s]);
        }
    }
    void bindUnder(Object3D& object, const std::shared_ptr<Skeleton>& skeleton) {
        if (auto* skinned = dynamic_cast<SkinnedMesh*>(&object)) {
            const Matrix4 identity;
            skinned->bind(skeleton, &identity);
        }
        for (Object3D* child : object.children) bindUnder(*child, skeleton);
    }
    std::shared_ptr<Skeleton> loadSkin(std::size_t index, const Value* /*def*/) {
        const cgltf_skin& skin = data_.skins[index];
        std::vector<std::shared_ptr<Bone>> bones;
        std::vector<Matrix4> inverses;
        std::shared_ptr<BufferAttribute> matrices = skin.inverse_bind_matrices ? accessor(*skin.inverse_bind_matrices) : nullptr;
        for (std::size_t j = 0; j < skin.joints_count; ++j) {
            const std::size_t n = skin.joints[j] - data_.nodes;
            auto bone = n < nodes_.size() ? std::dynamic_pointer_cast<Bone>(nodes_[n]) : nullptr;
            if (!bone) {
                refuse("TN_NATIVE_GLTF_SKIN_INVALID joint " + std::to_string(n) + " is not in a scene");
                return nullptr;
            }
            bones.push_back(bone);
            Matrix4 inverse;
            if (matrices) {
                std::array<double, 16> e{};
                for (int k = 0; k < 16; ++k) e[k] = matrices->getComponent(j, k);
                inverse.fromArray(e.data());
            }
            inverses.push_back(inverse);
        }
        return std::make_shared<Skeleton>(std::move(bones), std::move(inverses));
    }

    // loadAnimation: one track per channel (per morph-target mesh for weights), named
    // `<node name>.<property>`; a channel without a target node is skipped.
    std::shared_ptr<AnimationClip> loadAnimation(std::size_t index, const Value* def) {
        const cgltf_animation& animation = data_.animations[index];
        std::vector<KeyframeTrack> tracks;
        for (std::size_t c = 0; c < animation.channels_count; ++c) {
            const cgltf_animation_channel& channel = animation.channels[c];
            if (!channel.target_node) continue;
            const std::size_t n = channel.target_node - data_.nodes;
            if (n >= nodes_.size() || !nodes_[n]) continue;
            Object3D& node = *nodes_[n];
            const cgltf_animation_sampler& sampler = *channel.sampler;
            if (sampler.interpolation == cgltf_interpolation_type_cubic_spline) {
                refuse("TN_NATIVE_GLTF_CUBICSPLINE_UNSUPPORTED animation " + std::to_string(index));
                return nullptr;
            }
            const Interpolation interpolation =
                sampler.interpolation == cgltf_interpolation_type_step ? Interpolation::Discrete : Interpolation::Linear;
            std::vector<double> times, values;
            Scalar inputScalar = Scalar::F32, outputScalar = Scalar::F32;
            if (!rawValues(*sampler.input, times, inputScalar) || !rawValues(*sampler.output, values, outputScalar))
                return nullptr;
            // _getArrayFromAccessor: normalized output is the raw value times getNormalizedComponentScale
            // (1/127, 1/255, 1/32767, 1/65535), not BufferAttribute's clamped division.
            const cgltf_accessor& raw = *sampler.output;
            const double scale = !raw.normalized                                      ? 1.0
                                 : raw.component_type == cgltf_component_type_r_8    ? 1.0 / 127
                                 : raw.component_type == cgltf_component_type_r_8u   ? 1.0 / 255
                                 : raw.component_type == cgltf_component_type_r_16   ? 1.0 / 32767
                                                                                     : 1.0 / 65535;
            if (raw.normalized)
                for (double& value : values) value *= scale;
            std::string property;
            TrackType type;
            std::vector<std::string> targets;
            switch (channel.target_path) {
                case cgltf_animation_path_type_translation: property = "position"; type = TrackType::Vector; break;
                case cgltf_animation_path_type_rotation: property = "quaternion"; type = TrackType::Quaternion; break;
                case cgltf_animation_path_type_scale: property = "scale"; type = TrackType::Vector; break;
                case cgltf_animation_path_type_weights: property = "morphTargetInfluences"; type = TrackType::Number; break;
                default:
                    refuse("TN_NATIVE_GLTF_ANIMATION_PATH_UNSUPPORTED animation " + std::to_string(index));
                    return nullptr;
            }
            if (channel.target_path == cgltf_animation_path_type_weights) {
                auto collect = [&](Object3D& object) {
                    auto* mesh = dynamic_cast<Mesh*>(&object);
                    if (mesh && !mesh->morphTargetInfluences.empty()) targets.push_back(object.name);
                };
                collect(node);
                if (dynamic_cast<Group*>(&node))
                    for (Object3D* child : node.children) collect(*child);
            } else {
                targets.push_back(node.name);
            }
            for (const std::string& target : targets) {
                if (target.empty()) {
                    refuse("TN_NATIVE_GLTF_ANIMATION_TARGET_UNNAMED node " + std::to_string(n)); // three uses the uuid
                    return nullptr;
                }
                tracks.emplace_back(target + "." + property, type, times, values, interpolation);
            }
        }
        const std::string name = truthyName(member(def, "name")) ? text(member(def, "name")) : "animation_" + std::to_string(index);
        return std::make_shared<AnimationClip>(name, -1, std::move(tracks));
    }

    const cgltf_data& data_;
    const Value& json_;
    const LoadOptions& options_;
    std::string error_;
    std::vector<bool> bones_, skinnedMesh_;
    std::map<std::string, int> namesUsed_;
    std::vector<std::shared_ptr<Object3D>> nodes_;
    std::map<const Object3D*, std::string> nodeNames_;
    std::vector<MeshUse> uses_;
    std::map<std::size_t, std::shared_ptr<Camera>> cameras_;
    std::map<std::size_t, std::size_t> cameraUses_, lightUses_;
    std::map<std::size_t, std::string> lightNames_;
    std::map<long, std::shared_ptr<Material>> materials_;
    std::map<std::string, std::shared_ptr<Material>> finalMaterials_;
    std::map<std::size_t, std::shared_ptr<Texture>> textures_;
};

} // namespace

namespace {
bool alignedView(const cgltf_buffer_view* view, cgltf_size offset, cgltf_size componentSize) {
    if (!view || componentSize == 0) return true;
    return (view->offset + offset) % componentSize == 0 && view->stride % componentSize == 0;
}
bool aligned(const cgltf_data& data) {
    for (cgltf_size i = 0; i < data.accessors_count; ++i) {
        const cgltf_accessor& a = data.accessors[i];
        if (!alignedView(a.buffer_view, a.offset, cgltf_component_size(a.component_type))) return false;
        if (a.is_sparse &&
            (!alignedView(a.sparse.indices_buffer_view, a.sparse.indices_byte_offset,
                          cgltf_component_size(a.sparse.indices_component_type)) ||
             !alignedView(a.sparse.values_buffer_view, a.sparse.values_byte_offset, cgltf_component_size(a.component_type))))
            return false;
    }
    return true;
}
} // namespace

LoadResult load(std::span<const uint8_t> bytes, const LoadOptions& hostOptions) {
    LoadResult result;
    cgltf_options options{};
    cgltf_data* data = nullptr;
    if (cgltf_parse(&options, bytes.data(), bytes.size(), &data) != cgltf_result_success) {
        result.error = "TN_NATIVE_GLTF_PARSE_FAILED";
        return result;
    }
    // External files are not read: a GLB's own chunk and data URIs only.
    if (cgltf_load_buffers(&options, data, nullptr) != cgltf_result_success) {
        cgltf_free(data);
        result.error = "TN_NATIVE_GLTF_BUFFER_MISSING an external or unreadable buffer";
        return result;
    }
    // glTF 2.0 requires an accessor's offset and stride to be multiples of its component size; three
    // fails on such a file too (a typed array cannot start there). Checked before cgltf_validate,
    // whose index-bound pass reads index data through an aligned cast.
    if (!aligned(*data)) {
        cgltf_free(data);
        result.error = "TN_NATIVE_GLTF_ACCESSOR_INVALID misaligned accessor";
        return result;
    }
    if (cgltf_validate(data) != cgltf_result_success) {
        cgltf_free(data);
        result.error = "TN_NATIVE_GLTF_INVALID";
        return result;
    }
    json::Value json;
    json::Error error;
    if (!json::parse(std::string_view(data->json, data->json_size), json, error)) {
        cgltf_free(data);
        result.error = "TN_NATIVE_GLTF_PARSE_FAILED json";
        return result;
    }
    result = Builder(*data, json, hostOptions).run();
    cgltf_free(data);
    return result;
}

} // namespace tn::engine::gltf
