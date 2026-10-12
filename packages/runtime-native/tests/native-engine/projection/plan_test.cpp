// PRD-519 phase 1 / PRD-518 phase 2: the native projection planner decides every described scene as
// the real SceneRenderProjection does (projection_reference.json, written by projection-reference.ts):
// whether the frame projects or why not, how many objects batch on each lane and every exact
// object's reason. The scenes are built here from the same descriptions the generator builds.
#include <cstdio>
#include <fstream>
#include <iterator>
#include <map>
#include <memory>
#include <string>

#include "engine/foundation/json.h"
#include "engine/renderer/projection/plan.h"
#include "engine/scene/geometries.h"

using namespace tn::engine;
using tn::engine::json::Value;

namespace {

std::string readFile(const char* path) {
    std::ifstream in(path, std::ios::binary);
    return std::string(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
}

double num(const Value* v, double fallback) { return v && v->isNumber() ? v->number() : fallback; }
bool flag(const Value* v) { return v && v->kind() == Value::Kind::Bool && v->boolean(); }
std::string text(const Value* v) { return v && v->isString() ? v->string() : std::string(); }

struct Assets {
    std::map<std::string, std::shared_ptr<BufferGeometry>> geometries;
    std::map<std::string, std::shared_ptr<Material>> materials;
};

std::shared_ptr<BufferGeometry> geometryOf(const Value& spec) {
    auto geometry = text(spec.find("kind")) == "box" ? makeBoxGeometry() : makeSphereGeometry(0.5, 8, 6);
    const uint64_t count = geometry->attributes.at("position")->count();
    if (flag(spec.find("morph"))) geometry->morphPositions.push_back(geometry->attributes.at("position"));
    if (flag(spec.find("skinned"))) {
        geometry->setAttribute("skinIndex", BufferAttribute::fromDoubles(Scalar::U16, std::vector<double>(count * 4, 0), 4));
        std::vector<double> weights(count * 4, 0);
        for (uint64_t i = 0; i < count; ++i) weights[i * 4] = 1;
        geometry->setAttribute("skinWeight", BufferAttribute::fromDoubles(Scalar::F32, weights, 4));
    }
    if (flag(spec.find("noNormal"))) geometry->deleteAttribute("normal");
    return geometry;
}

std::shared_ptr<Material> materialOf(const Value& spec) {
    const std::string type = text(spec.find("type"));
    const MaterialType kind = type == "MeshBasicMaterial"     ? MaterialType::Basic
                              : type == "MeshLambertMaterial" ? MaterialType::Lambert
                              : type == "MeshPhongMaterial"   ? MaterialType::Phong
                                                              : MaterialType::Standard;
    auto material = std::make_shared<Material>(kind);
    if (const Value* color = spec.find("color")) material->color.setHex(static_cast<uint32_t>(color->number()));
    if (const Value* roughness = spec.find("roughness")) material->roughness = roughness->number();
    if (const Value* transparent = spec.find("transparent")) material->transparent = transparent->boolean();
    return material;
}

std::shared_ptr<Object3D> build(const Value& spec, Assets& assets) {
    const std::string kind = text(spec.find("kind"));
    const auto geometry = assets.geometries[text(spec.find("geometry"))];
    const auto material = assets.materials[text(spec.find("material"))];
    std::shared_ptr<Object3D> object;
    if (kind == "mesh") object = std::make_shared<Mesh>(geometry, material);
    else if (kind == "instanced")
        object = std::make_shared<InstancedMesh>(geometry, material, static_cast<uint32_t>(num(spec.find("count"), 4)));
    else if (kind == "light") object = std::make_shared<DirectionalLight>(Color(1, 1, 1), 1);
    else if (kind == "group") object = std::make_shared<Group>();
    else {
        auto rig = std::make_shared<SkinnedMesh>(geometry, material);
        std::vector<std::shared_ptr<Bone>> bones;
        for (int i = 0; i < int(num(spec.find("bones"), 2)); ++i) {
            auto bone = std::make_shared<Bone>();
            bone->position.y = i == 0 ? 0 : 0.5;
            (i == 0 ? static_cast<Object3D&>(*rig) : static_cast<Object3D&>(*bones.back())).add(*bone);
            bones.push_back(bone);
        }
        rig->bind(std::make_shared<Skeleton>(bones));
        object = rig;
    }
    if (const Value* p = spec.find("position"))
        object->position.set(p->items()[0].number(), p->items()[1].number(), p->items()[2].number());
    if (const Value* s = spec.find("scale"))
        object->scale.set(s->items()[0].number(), s->items()[1].number(), s->items()[2].number());
    if (const Value* order = spec.find("renderOrder")) object->setRenderOrder(int(order->number()));
    if (const Value* cast = spec.find("castShadow")) object->setCastShadow(cast->boolean());
    if (const Value* receive = spec.find("receiveShadow")) object->setReceiveShadow(receive->boolean());
    if (flag(spec.find("hook")))
        if (auto* mesh = dynamic_cast<Mesh*>(object.get()))
            mesh->onBeforeRender = std::make_shared<const std::function<bool(const RenderCallbackArgs&, std::string&)>>(
                [](const RenderCallbackArgs&, std::string&) { return true; });
    if (const Value* children = spec.find("children"))
        for (const Value& child : children->items())
            for (int i = 0; i < int(num(child.find("repeat"), 1)); ++i) object->add(*build(child, assets));
    return object;
}

} // namespace

int main() {
    Value reference;
    json::Error error;
    if (!json::parse(readFile(TN_PROJECTION_REFERENCE), reference, error)) {
        std::printf("FAIL: cannot read %s\n", TN_PROJECTION_REFERENCE);
        return 1;
    }
    int scenes = 0, differ = 0;
    for (const Value& entry : reference.find("scenes")->items()) {
        const Value& spec = *entry.find("scene");
        const Value& expected = *entry.find("decision");
        Assets assets;
        for (const Value& g : spec.find("geometries")->items()) assets.geometries[text(g.find("id"))] = geometryOf(g);
        for (const Value& m : spec.find("materials")->items()) assets.materials[text(m.find("id"))] = materialOf(m);
        auto scene = std::make_shared<Scene>();
        std::vector<std::shared_ptr<Object3D>> keep;
        for (const Value& object : spec.find("objects")->items())
            for (int i = 0; i < int(num(object.find("repeat"), 1)); ++i) {
                keep.push_back(build(object, assets));
                scene->add(*keep.back());
            }
        scene->updateMatrixWorld(true);
        const projection::Decision d = projection::decide(*scene, int(num(spec.find("minMeshes"), 200)));
        ++scenes;
        std::string mismatch;
        const auto check = [&](const char* field, double got) {
            if (mismatch.empty() && got != num(expected.find(field), -1))
                mismatch = std::string(field) + " " + std::to_string(got) + " vs " + std::to_string(num(expected.find(field), -1));
        };
        if (d.projecting != flag(expected.find("projecting"))) mismatch = "projecting";
        if (mismatch.empty() && d.reasonCode != text(expected.find("reasonCode")))
            mismatch = "reasonCode " + d.reasonCode + " vs " + text(expected.find("reasonCode"));
        check("sourceRenderables", d.sourceRenderables);
        check("projectedObjects", d.projectedObjects);
        check("instancedBatches", d.instancedBatches);
        check("materialBatches", d.materialBatches);
        check("skinnedBatches", d.skinnedBatches);
        check("exactObjects", d.exactObjects);
        const Value* exact = expected.find("exact");
        if (mismatch.empty() && exact->members().size() != d.exact.size()) mismatch = "exact reasons";
        for (const auto& [reason, count] : exact->members())
            if (mismatch.empty() && (!d.exact.count(reason) || d.exact.at(reason) != int(count.number())))
                mismatch = "exact." + reason;
        if (!mismatch.empty()) {
            std::printf("  %s differs: %s\n", text(spec.find("name")).c_str(), mismatch.c_str());
            ++differ;
        }
    }
    std::printf("projection plan: %d scenes, %d differ\n", scenes, differ);
    if (scenes == 0 || differ != 0) {
        std::printf("FAIL\n");
        return 1;
    }
    std::printf("PASS\n");
    return 0;
}
