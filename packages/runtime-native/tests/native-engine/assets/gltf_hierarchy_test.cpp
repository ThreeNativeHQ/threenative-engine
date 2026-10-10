// PRD-515 phase 1: every glTF in the corpus loads into the hierarchy three's GLTFLoader builds —
// names, types, parents, transforms, geometry layout, materials, skeletons and the clip list —
// compared against gltf_reference.json (written by gltf-reference.ts from the real loader).
#include <algorithm>
#include <cstring>
#include <cstdio>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

#include "engine/animation/skinning/skeleton.h"
#include "engine/assets/gltf/loader.h"
#include "engine/foundation/json.h"
#include "engine/scene/geometry.h"
#include "engine/scene/material.h"
#include "engine/scene/lights.h"

using namespace tn::engine;
using tn::engine::json::Value;
using namespace tn::engine::animation;

namespace {

std::string readFile(const std::string& path) {
    std::ifstream in(path, std::ios::binary);
    return std::string(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
}

Value num(double v) { return Value::makeNumber(v); }
Value str(std::string s) { return Value::makeString(std::move(s)); }
Value flag(bool b) { return Value::makeBool(b); }
Value numbers(std::initializer_list<double> values) {
    std::vector<Value> items;
    for (double v : values) items.push_back(num(v));
    return Value::makeArray(std::move(items));
}

// Members sorted by key, all the way down: the comparison is of content, not of insertion order.
Value canonical(const Value& v) {
    if (v.isArray()) {
        std::vector<Value> items;
        for (const Value& item : v.items()) items.push_back(canonical(item));
        return Value::makeArray(std::move(items));
    }
    if (v.isObject()) {
        std::vector<std::pair<std::string, Value>> members;
        for (const auto& [key, value] : v.members()) members.emplace_back(key, canonical(value));
        std::sort(members.begin(), members.end(), [](const auto& a, const auto& b) { return a.first < b.first; });
        return Value::makeObject(std::move(members));
    }
    return v;
}

const char* arrayName(Scalar s) {
    switch (s) {
        case Scalar::I8: return "Int8Array";
        case Scalar::U8: return "Uint8Array";
        case Scalar::I16: return "Int16Array";
        case Scalar::U16: return "Uint16Array";
        case Scalar::U32: return "Uint32Array";
        case Scalar::I32: return "Int32Array";
        case Scalar::F64: return "Float64Array";
        default: return "Float32Array";
    }
}

const char* const kMapSlots[] = {
    "map", "normalMap", "roughnessMap", "metalnessMap", "emissiveMap", "aoMap", "alphaMap", "clearcoatMap",
    "clearcoatNormalMap", "clearcoatRoughnessMap", "sheenColorMap", "sheenRoughnessMap", "transmissionMap",
    "thicknessMap", "specularIntensityMap", "specularColorMap", "iridescenceMap", "iridescenceThicknessMap",
    "anisotropyMap"};

Value material(const Material& m) {
    std::vector<Value> maps;
    for (const char* slot : kMapSlots)
        if (m.maps.count(slot)) maps.push_back(str(slot));
    return Value::makeObject({{"type", str(std::string(m.typeName()))},
                              {"name", str(m.name)},
                              {"opacity", num(m.opacity)},
                              {"transparent", flag(m.transparent)},
                              {"side", num(static_cast<double>(m.side))},
                              {"alphaTest", num(m.alphaTest)},
                              {"depthWrite", flag(m.depthWrite)},
                              {"vertexColors", flag(m.vertexColors)},
                              {"color", numbers({m.color.r, m.color.g, m.color.b})},
                              {"emissive", numbers({m.emissive.r, m.emissive.g, m.emissive.b})},
                              {"roughness", num(m.roughness)},
                              {"metalness", num(m.metalness)},
                              {"emissiveIntensity", num(m.emissiveIntensity)},
                              {"flatShading", flag(m.flatShading)},
                              {"maps", Value::makeArray(std::move(maps))}});
}

void traverse(Object3D& object, std::vector<Object3D*>& out) {
    out.push_back(&object);
    for (Object3D* child : object.children) traverse(*child, out);
}

Value node(Object3D& o, const std::vector<Object3D*>& order) {
    const auto indexOf = [&](const Object3D* p) {
        const auto it = std::find(order.begin(), order.end(), p);
        return it == order.end() ? -1.0 : double(it - order.begin());
    };
    const auto q = o.quaternion.toArray();
    std::vector<std::pair<std::string, Value>> m = {
        {"name", str(o.name)},
        {"type", str(std::string(o.type()))},
        {"parent", num(o.parent ? indexOf(o.parent) : -1)},
        {"position", numbers({o.position.x, o.position.y, o.position.z})},
        {"quaternion", numbers({q[0], q[1], q[2], q[3]})},
        {"scale", numbers({o.scale.x, o.scale.y, o.scale.z})}};
    if (auto* mesh = dynamic_cast<Mesh*>(&o)) {
        std::vector<Value> attributes;
        for (const auto& [name, attribute] : mesh->geometry->attributes) // std::map: sorted by name
            attributes.push_back(Value::makeObject({{"name", str(name)},
                                                    {"itemSize", num(attribute->itemSize)},
                                                    {"count", num(double(attribute->count()))},
                                                    {"normalized", flag(attribute->normalized)},
                                                    {"array", str(arrayName(attribute->store->scalar()))}}));
        m.emplace_back("geometry",
                       Value::makeObject({{"attributes", Value::makeArray(std::move(attributes))},
                                          {"index", mesh->geometry->index ? num(double(mesh->geometry->index->count()))
                                                                          : Value::makeNull()},
                                          {"morphTargets", num(double(mesh->geometry->morphPositions.size()))},
                                          {"groups", num(0)}}));
        m.emplace_back("materials", Value::makeArray({material(*mesh->material)}));
        if (!mesh->morphTargetInfluences.empty()) {
            std::vector<Value> influences;
            for (double v : mesh->morphTargetInfluences) influences.push_back(num(v));
            m.emplace_back("morphTargetInfluences", Value::makeArray(std::move(influences)));
        }
    }
    if (auto* skinned = dynamic_cast<SkinnedMesh*>(&o)) {
        std::vector<Value> bones;
        for (std::size_t i = 0; i < skinned->skeleton->bones.size(); ++i) {
            const Bone* bone = skinned->skeleton->bone(i);
            bones.push_back(str(bone ? bone->name : ""));
        }
        m.emplace_back("skeleton", Value::makeArray(std::move(bones)));
    }
    return Value::makeObject(std::move(m));
}

const char* typeName(TrackType t) {
    switch (t) {
        case TrackType::Quaternion: return "quaternion";
        case TrackType::Number: return "number";
        case TrackType::Color: return "color";
        case TrackType::Bool: return "bool";
        default: return "vector";
    }
}

double interpolation(Interpolation i) {
    return i == Interpolation::Discrete ? 2300 : i == Interpolation::Smooth ? 2302 : 2301; // QuaternionLinear reads as Linear
}

Value dump(const std::string& file, gltf::LoadResult& loaded) {
    std::vector<Object3D*> order;
    traverse(*loaded.scene, order);
    std::vector<Value> nodes;
    for (Object3D* o : order) nodes.push_back(node(*o, order));
    std::vector<Value> clips;
    for (const auto& clip : loaded.animations) {
        std::vector<Value> tracks;
        for (const KeyframeTrack& t : clip->tracks)
            tracks.push_back(Value::makeObject({{"name", str(t.name)},
                                                {"type", str(typeName(t.type))},
                                                {"times", num(double(t.times.size()))},
                                                {"values", num(double(t.values.size()))},
                                                {"interpolation", num(interpolation(t.interpolation))}}));
        clips.push_back(Value::makeObject(
            {{"name", str(clip->name)}, {"duration", num(clip->duration)}, {"tracks", Value::makeArray(std::move(tracks))}}));
    }
    return Value::makeObject(
        {{"file", str(file)}, {"nodes", Value::makeArray(std::move(nodes))}, {"animations", Value::makeArray(std::move(clips))}});
}

// The first place two dumps differ, as a path.
std::string firstDifference(const Value& a, const Value& b, const std::string& at) {
    if (a.kind() != b.kind()) return at + " (kind)";
    if (a.isArray()) {
        if (a.items().size() != b.items().size())
            return at + " (length " + std::to_string(a.items().size()) + " vs " + std::to_string(b.items().size()) + ")";
        for (std::size_t i = 0; i < a.items().size(); ++i)
            if (std::string d = firstDifference(a.items()[i], b.items()[i], at + "[" + std::to_string(i) + "]"); !d.empty())
                return d;
        return "";
    }
    if (a.isObject()) {
        if (a.members().size() != b.members().size()) return at + " (keys)";
        for (std::size_t i = 0; i < a.members().size(); ++i) {
            if (a.members()[i].first != b.members()[i].first) return at + " (key " + a.members()[i].first + ")";
            if (std::string d = firstDifference(a.members()[i].second, b.members()[i].second, at + "." + a.members()[i].first);
                !d.empty())
                return d;
        }
        return "";
    }
    return json::stringify(a) == json::stringify(b) ? "" : at + ": " + json::stringify(a) + " vs " + json::stringify(b);
}

} // namespace

int main() {
    Value reference;
    json::Error error;
    if (!json::parse(readFile(TN_GLTF_REFERENCE), reference, error)) {
        std::printf("FAIL: cannot read %s\n", TN_GLTF_REFERENCE);
        return 1;
    }
    int files = 0, differ = 0;
    // The same loader entry point used by a game, without a GPU or recorded reference.
    const std::string featureJson = R"({"asset":{"version":"2.0"},"extensionsUsed":["KHR_lights_punctual"],
      "extensions":{"KHR_lights_punctual":{"lights":[{"type":"directional","color":[0.2,0.4,0.8],"intensity":3},
        {"type":"point","range":7},{"type":"spot","spot":{"innerConeAngle":0.2,"outerConeAngle":0.6}}]}},
      "cameras":[{"type":"perspective","perspective":{"yfov":1,"znear":0.25}},
        {"type":"orthographic","orthographic":{"xmag":2,"ymag":3,"znear":0.1,"zfar":40}}],
      "nodes":[{"camera":0,"translation":[1,2,3]}, {"camera":1},
        {"extensions":{"KHR_lights_punctual":{"light":0}}},
        {"extensions":{"KHR_lights_punctual":{"light":1}}},
        {"extensions":{"KHR_lights_punctual":{"light":2}}}],"scenes":[{"nodes":[0,1,2,3,4]}],"scene":0})";
    auto feature = gltf::load(std::span<const uint8_t>(reinterpret_cast<const uint8_t*>(featureJson.data()), featureJson.size()));
    if (!feature.error.empty() || !feature.scene || feature.scene->children.size() != 5) {
        std::printf("lights/cameras: %s\n", feature.error.c_str()); ++differ;
    } else {
        auto* perspective = dynamic_cast<PerspectiveCamera*>(feature.scene->children[0]);
        auto* ortho = dynamic_cast<OrthographicCamera*>(feature.scene->children[1]);
        auto* sun = dynamic_cast<DirectionalLight*>(feature.scene->children[2]);
        auto* point = dynamic_cast<PointLight*>(feature.scene->children[3]);
        auto* spot = dynamic_cast<SpotLight*>(feature.scene->children[4]);
        const bool ok = perspective && perspective->fov == 180 / 3.141592653589793 && perspective->aspect == 1 &&
            perspective->near == 0.25 && perspective->far == 2e6 && perspective->position.x == 1 &&
            ortho && ortho->left == -2 && ortho->top == 3 && ortho->far == 40 && sun && sun->intensity == 3 &&
            sun->color.b == 0.8 && sun->position.y == 0 && sun->target->parent == sun && sun->target->position.z == -1 &&
            point && point->distance == 7 && point->decay == 2 && spot && spot->angle == 0.6 &&
            spot->penumbra == 1 - 0.2 / 0.6 && spot->target->parent == spot && spot->target->position.z == -1;
        if (!ok) { std::printf("lights/cameras: wrong native objects or defaults\n"); ++differ; }
    }
    // Accessor bytes reach the attribute as three's typed-array view reads them: a signalling NaN, a
    // NaN payload and -0 keep their bits through an interleaved view and a sparse override.
    {
        const uint32_t sNaN = 0x7fa00001u, payload = 0x7fc12345u, negZero = 0x80000000u;
        const auto bitsOf = [](float f) { uint32_t u; std::memcpy(&u, &f, 4); return u; };
        std::vector<uint32_t> bin = {sNaN, negZero, bitsOf(1.5f), 0, bitsOf(2), bitsOf(3), bitsOf(4), 0,
                                     1, bitsOf(5), payload, bitsOf(6)};
        const std::string json = R"({"asset":{"version":"2.0"},"buffers":[{"byteLength":48}],
          "bufferViews":[{"buffer":0,"byteLength":32,"byteStride":16},{"buffer":0,"byteOffset":32,"byteLength":4},
            {"buffer":0,"byteOffset":36,"byteLength":12}],
          "accessors":[{"bufferView":0,"componentType":5126,"type":"VEC3","count":2,
            "sparse":{"count":1,"indices":{"bufferView":1,"componentType":5121},"values":{"bufferView":2}}}],
          "meshes":[{"primitives":[{"attributes":{"POSITION":0}}]}],"nodes":[{"mesh":0,"name":"bits"}],
          "scenes":[{"nodes":[0]}],"scene":0})";
        const std::string text = json + std::string((4 - json.size() % 4) % 4, ' ');
        const auto u32 = [](std::string& out, uint32_t v) { out.append(reinterpret_cast<const char*>(&v), 4); };
        std::string glb;
        u32(glb, 0x46546c67u); u32(glb, 2); u32(glb, static_cast<uint32_t>(12 + 8 + text.size() + 8 + 48));
        u32(glb, static_cast<uint32_t>(text.size())); u32(glb, 0x4e4f534au); glb += text;
        u32(glb, 48); u32(glb, 0x004e4942u); glb.append(reinterpret_cast<const char*>(bin.data()), 48);
        auto loaded = gltf::load(std::span<const uint8_t>(reinterpret_cast<const uint8_t*>(glb.data()), glb.size()));
        auto* mesh = loaded.scene ? dynamic_cast<Mesh*>(loaded.scene->getObjectByName("bits")) : nullptr;
        std::vector<uint32_t> got(6, 0);
        if (mesh && mesh->geometry && mesh->geometry->attributes.count("position") &&
            mesh->geometry->attributes["position"]->store->byteLength() == 24)
            std::memcpy(got.data(), mesh->geometry->attributes["position"]->store->data(), 24);
        const std::vector<uint32_t> want = {sNaN, negZero, bitsOf(1.5f), bitsOf(5), payload, bitsOf(6)};
        if (!loaded.error.empty() || got != want) {
            std::printf("accessor bits: %s", loaded.error.c_str());
            for (uint32_t u : got) std::printf(" %08x", u);
            std::printf("\n");
            ++differ;
        }
    }
    const std::string unlitBytes = readFile(std::string(TN_REPO_ROOT) + "/packages/three-native/tests/compatibility/fixtures/gltf-unlit.glb");
    auto unlit = gltf::load(std::span<const uint8_t>(reinterpret_cast<const uint8_t*>(unlitBytes.data()), unlitBytes.size()));
    auto* unlitMesh = unlit.scene ? dynamic_cast<Mesh*>(unlit.scene->getObjectByName("leftPanel")) : nullptr;
    if (!unlit.error.empty() || !unlitMesh || !unlitMesh->material ||
        unlitMesh->material->type != MaterialType::Basic || unlitMesh->material->color.r != 0.8 ||
        unlitMesh->material->opacity != 0.7 || !unlitMesh->material->transparent || unlitMesh->material->depthWrite ||
        unlitMesh->material->emissive.g != 0 || unlitMesh->material->maps.count("metalnessMap")) {
        std::printf("unlit: wrong material/alpha or lit-only inputs were not ignored: %s\n", unlit.error.c_str()); ++differ;
    }
    // KHR_materials_ior / KHR_materials_specular make a MeshPhysicalMaterial (GLTFLoader's
    // getMaterialType); the tangent-less clone keeps its inputs; ior 0 reads as 1000.
    const std::string physicalBytes = readFile(std::string(TN_REPO_ROOT) + "/packages/three-native/tests/compatibility/fixtures/gltf-model-physical.glb");
    auto physical = gltf::load(std::span<const uint8_t>(reinterpret_cast<const uint8_t*>(physicalBytes.data()), physicalBytes.size()));
    const auto materialOf = [&](const char* name) -> const Material* {
        auto* mesh = physical.scene ? dynamic_cast<Mesh*>(physical.scene->getObjectByName(name)) : nullptr;
        return mesh ? mesh->material.get() : nullptr;
    };
    const Material* plain = materialOf("standard");
    const Material* ior = materialOf("ior");
    const Material* specular = materialOf("specular");
    const Material* infinite = materialOf("iorInfinite");
    if (!physical.error.empty() || !plain || !ior || !specular || !infinite || plain->type != MaterialType::Standard ||
        ior->type != MaterialType::Physical || ior->ior != 2.2 || ior->specularIntensity != 1 || ior->specularColor.g != 1 ||
        specular->type != MaterialType::Physical || specular->ior != 1.5 || specular->specularIntensity != 0.7 ||
        specular->specularColor.r != 1 || specular->specularColor.g != 0.45 || specular->specularColor.b != 0.15 ||
        infinite->ior != 1000 || infinite->specularColor.b != 0.3) {
        std::printf("physical: wrong material type or ior/specular inputs: %s\n", physical.error.c_str()); ++differ;
    }
    // KHR_materials_clearcoat (GLTFMaterialsClearcoatExtension): a MeshPhysicalMaterial with the coat's
    // factors and its clearcoat and clearcoat-roughness maps.
    const std::string coatBytes = readFile(std::string(TN_REPO_ROOT) + "/packages/three-native/tests/compatibility/fixtures/gltf-model-clearcoat.glb");
    auto coat = gltf::load(std::span<const uint8_t>(reinterpret_cast<const uint8_t*>(coatBytes.data()), coatBytes.size()));
    const auto coatOf = [&](const char* name) -> const Material* {
        auto* mesh = coat.scene ? dynamic_cast<Mesh*>(coat.scene->getObjectByName(name)) : nullptr;
        return mesh ? mesh->material.get() : nullptr;
    };
    const Material* coated = coatOf("coated");
    const Material* coatMapped = coatOf("coatMapped");
    if (!coat.error.empty() || !coated || !coatMapped || coated->type != MaterialType::Physical || coated->clearcoat != 1 ||
        coated->clearcoatRoughness != 0.05 || !coated->maps.empty() || coatMapped->clearcoat != 0.9 ||
        coatMapped->clearcoatRoughness != 1 || !coatMapped->maps.count("clearcoatMap") ||
        !coatMapped->maps.count("clearcoatRoughnessMap")) {
        std::printf("clearcoat: wrong material type, factors or maps: %s\n", coat.error.c_str()); ++differ;
    }
    // PRD-526: a texture's image decodes at load (PNG and JPEG), with the sampler GLTFLoader applies.
    const std::string imageBytes = readFile(std::string(TN_REPO_ROOT) + "/packages/runtime-native/tests/native-engine/assets/image-textures.gltf");
    auto images = gltf::load(std::span<const uint8_t>(reinterpret_cast<const uint8_t*>(imageBytes.data()), imageBytes.size()));
    auto* imageMesh = images.scene ? dynamic_cast<Mesh*>(images.scene->children.empty() ? nullptr : images.scene->children[0]) : nullptr;
    const Texture* base = imageMesh && imageMesh->material && imageMesh->material->maps.count("map") ? imageMesh->material->maps.at("map").get() : nullptr;
    const Texture* emissive = imageMesh && imageMesh->material && imageMesh->material->maps.count("emissiveMap") ? imageMesh->material->maps.at("emissiveMap").get() : nullptr;
    const std::vector<uint8_t> pngPixels = {255,0,0,255, 0,255,0,128, 0,0,255,255, 10,20,30,40};
    if (!images.error.empty() || !base || !emissive || !base->hasImage() || base->width != 2 || base->height != 2 ||
        base->data != pngPixels || base->wrapS != 1001 || base->wrapT != 1002 || base->magFilter != 1003 ||
        base->minFilter != 1008 || !emissive->hasImage() || emissive->width != 3 || emissive->height != 1 ||
        emissive->data.size() != 12 || emissive->wrapS != 1000 || emissive->wrapT != 1000 ||
        emissive->magFilter != 1006 || emissive->minFilter != 1008) {
        std::printf("image textures: PNG/JPEG not decoded or sampler not applied: %s\n", images.error.c_str()); ++differ;
    }
    // A host that decodes images itself (the web host's ImageBitmaps) supplies them by glTF image
    // index: the texture keeps the host's image and no bytes, an image it declines still decodes
    // here, and the host's image is released with the last texture that holds it.
    std::vector<uint32_t> released;
    {
        gltf::LoadOptions options;
        options.externalImage = [&](std::size_t image) -> std::shared_ptr<const ExternalImage> {
            if (image != 0) return nullptr;
            return std::make_shared<const ExternalImage>(7, 2, 2, [&](uint32_t id) { released.push_back(id); });
        };
        auto hosted = gltf::load(std::span<const uint8_t>(reinterpret_cast<const uint8_t*>(imageBytes.data()), imageBytes.size()),
                                 options);
        auto* mesh = hosted.scene ? dynamic_cast<Mesh*>(hosted.scene->children.empty() ? nullptr : hosted.scene->children[0]) : nullptr;
        const Texture* map = mesh && mesh->material ? mesh->material->maps.at("map").get() : nullptr;
        const Texture* glow = mesh && mesh->material ? mesh->material->maps.at("emissiveMap").get() : nullptr;
        if (!hosted.error.empty() || !map || !glow || !map->external || map->external->id != 7 || !map->data.empty() ||
            !map->hasImage() || map->width != 2 || map->height != 2 || glow->external || glow->data.size() != 12 || !released.empty()) {
            std::printf("image textures: a host image was not taken by index (%s)\n", hosted.error.c_str()); ++differ;
        }
    }
    if (released != std::vector<uint32_t>{7}) {
        std::printf("image textures: the host image was released %zu times\n", released.size()); ++differ;
    }
    // A damaged PNG is refused, not left as an image-less texture.
    std::string damaged = imageBytes;
    damaged.replace(damaged.find("R4nGP4z8Dw"), 10, "R4nGP4zzzz"); // the PNG signature stays, its pixel stream breaks
    auto refused = gltf::load(std::span<const uint8_t>(reinterpret_cast<const uint8_t*>(damaged.data()), damaged.size()));
    if (refused.error.rfind("TN_NATIVE_GLTF_IMAGE_INVALID", 0) != 0) {
        std::printf("image textures: a corrupt image was not refused (%s)\n", refused.error.c_str()); ++differ;
    }
    for (const Value& expected : reference.find("files")->items()) {
        const std::string file = expected.find("file")->string();
        const std::string bytes = readFile(std::string(TN_REPO_ROOT) + "/" + file);
        gltf::LoadResult loaded =
            gltf::load(std::span<const uint8_t>(reinterpret_cast<const uint8_t*>(bytes.data()), bytes.size()));
        ++files;
        if (!loaded.error.empty() || !loaded.scene) {
            std::printf("  %s: %s\n", file.c_str(), loaded.error.c_str());
            ++differ;
            continue;
        }
        const std::string d = firstDifference(canonical(dump(file, loaded)), canonical(expected), "");
        if (!d.empty()) {
            std::printf("  %s differs at %s\n", file.c_str(), d.c_str());
            ++differ;
        }
    }
    std::printf("gltf hierarchy: %d files, %d differ\n", files, differ);
    if (files == 0 || differ != 0) {
        std::printf("FAIL\n");
        return 1;
    }
    std::printf("PASS\n");
    return 0;
}
