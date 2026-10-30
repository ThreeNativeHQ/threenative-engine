// PRD-514 phase 1: the render database draws the native scene graph. `lit_scene` builds the
// lit-render fixture as a scene (SphereGeometry, MeshStandardMaterial, DirectionalLight,
// HemisphereLight, PerspectiveCamera) and renders it with renderer.render(scene, camera)'s native
// path, against the browser's golden frame. `invalidation` checks that records follow revisions only.

#include "check.h"
#include "engine/animation/property_binding.h"
#include "engine/foundation/job_pool.h"
#include "engine/foundation/waste_counters.h"
#include "engine/animation/mixer.h"
#include "engine/renderer/post/traa.h"
#include "engine/renderer/render_database.h"
#include "engine/renderer/shadows/virtual/atlas.h"
#include "engine/renderer/shadows/lamp_resolution.h"
#include "engine/renderer/reflector.h"
#include "engine/renderer/render_target_pass.h"
#include "engine/shader/graph/graph.h"
#include "engine/renderer/projection/plan.h"
#include "engine/shader/package.h"
#include "engine/shader/graph/post_effects.h"
#include "engine/player/skinned_crowd.h"
#include "engine/scene/geometries.h"
#include "mystral/webgpu/context.h"
#include "mystral/webgpu_compat.h"

#include <algorithm>
#include <array>
#include <atomic>
#include <bit>
#include <cmath>
#include <chrono>
#include <cstring>
#include <functional>
#include <limits>
#include <map>
#include <cstdlib>
#include <cmath>
#include <cstdio>
#include <numeric>
#include <set>
#include <string>
#include <thread>

extern "C" unsigned char* stbi_load(const char* filename, int* x, int* y, int* comp, int req_comp);
extern "C" void stbi_image_free(void* data);

using namespace tn::engine;

namespace {

// CPU-only proof of the exact palette/instance records used by all render passes.
void rigRelativePreparation() {
    Scene scene;
    scene.enableTrackedTransform();
    DirectionalLight sun;
    sun.position.set(10, 20, 20);
    sun.setCastShadow(true);
    scene.add(sun);
    auto geometry = makeBoxGeometry();
    const auto vertices = geometry->attributes.at("position")->count();
    geometry->setAttribute("skinIndex",
                           BufferAttribute::fromDoubles(Scalar::U16, std::vector<double>(vertices * 4, 0), 4));
    std::vector<double> weights(vertices * 4, 0);
    for (std::size_t i = 0; i < vertices; ++i)
        weights[i * 4] = 1;
    geometry->setAttribute("skinWeight", BufferAttribute::fromFloats(weights, 4));
    auto material = std::make_shared<Material>(MaterialType::Standard);
    std::vector<std::shared_ptr<Object3D>> roots;
    std::vector<std::shared_ptr<SkinnedMesh>> rigs;
    std::vector<std::shared_ptr<Bone>> bones, tips;
    for (int i = 0; i < 8; ++i) {
        auto root = std::make_shared<Object3D>();
        auto rig = std::make_shared<SkinnedMesh>(geometry, material);
        auto bone = std::make_shared<Bone>();
        auto tip = std::make_shared<Bone>();
        tip->enableTrackedTransform();
        bone->add(*tip);
        tip->position.y = 0.4;
        root->enableTrackedTransform();
        rig->enableTrackedTransform();
        bone->enableTrackedTransform();
        rig->frustumCulled = false;
        rig->setCastShadow(true);
        rig->position.set(0.2, -0.1, 0.3);
        root->add(*rig);
        root->add(*bone);
        scene.add(*root);
        root->updateMatrixWorld(true);
        rig->bind(std::make_shared<Skeleton>(std::vector<std::shared_ptr<Bone>>{bone, tip}));
        root->position.set(i * 3 + 2, i * 0.2, -i);
        root->rotation.set(0.2, i * 0.1 + 0.3, -0.15);
        root->scale.setScalar(1.4);
        bone->position.set(0.3, 0.8, -0.2);
        bone->rotation.set(0.1, 0.2, 0.4);
        roots.push_back(root);
        rigs.push_back(rig);
        bones.push_back(bone);
        tips.push_back(tip);
    }
    PerspectiveCamera mainCamera, reflectedCamera;
    mainCamera.position.set(10, 8, 40);
    mainCamera.lookAt(10, 0, 0);
    reflectedCamera.position.set(10, -8, 40);
    reflectedCamera.lookAt(10, 0, 0);
    RenderDatabase mainDatabase, reflectedDatabase;
    mainDatabase.shadowMapEnabled = reflectedDatabase.shadowMapEnabled = true;
    LightState lights;
    for (int frame = 0; frame < 3; ++frame) {
        // A legacy slot can share the same draw with relative slots without applying placement twice.
        if (frame == 2)
            Object3D::transformTrackingAddress(&bones[0]->position)[2] = 1;
        bones[0]->rotation.z = double(bones[0]->rotation.z) + 0.17;
        roots[0]->position.x += 0.7;
        for (int pass = 0; pass < 2; ++pass) {
            auto& database = pass ? reflectedDatabase : mainDatabase;
            auto& camera = pass ? reflectedCamera : mainCamera;
            const auto& draws = database.prepare(scene, camera, lights);
            CHECK(draws.size() == 1);
            if (draws.size() != 1)
                continue;
            const DrawItem& draw = draws.front();
            CHECK(draw.instanceCount == rigs.size() && draw.boneStride == 2);
            CHECK(draw.castShadow && draw.mainPass);
            for (int k = 0; k < 16; ++k) {
                const double identity = k % 5 == 0 ? 1 : 0;
                CHECK(draw.matrixWorld[k] == identity);
                CHECK(draw.bindMatrix[k] == identity && draw.bindMatrixInverse[k] == identity);
            }
            if (!draw.instanceMatrices || !draw.boneMatrices)
                continue;
            const auto* instances = reinterpret_cast<const float*>(draw.instanceMatrices->data());
            std::vector<bool> seen(rigs.size(), false);
            for (std::size_t slot = 0; slot < rigs.size(); ++slot) {
                Matrix4 placement;
                for (int k = 0; k < 16; ++k)
                    placement.elements[k] = instances[slot * 16 + k];
                std::size_t rigIndex = rigs.size();
                for (std::size_t i = 0; i < roots.size(); ++i)
                    if (std::abs(placement.elements[12] - roots[i]->matrixWorld.elements[12]) < 1e-5)
                        rigIndex = i;
                if (frame == 2 && placement.elements[12] == 0)
                    rigIndex = 0;
                CHECK(rigIndex < rigs.size());
                if (rigIndex == rigs.size())
                    continue;
                CHECK(!seen[rigIndex]);
                seen[rigIndex] = true;
                SkinnedPalette eager(2, 1, false);
                eager.write(*eager.claim(rigs[rigIndex].get()), *rigs[rigIndex], false);
                for (std::size_t bone = 0; bone < 2; ++bone) {
                    float world[16];
                    multiplyAffine(placement.elements.data(), 0, draw.boneMatrices->data(), slot * 32 + bone * 16,
                                   world, 0);
                    for (int k = 0; k < 16; ++k)
                        CHECK(std::abs(world[k] - eager.palette()[bone * 16 + k]) < 1e-5);
                    // Skinning applies its linear matrix to normals; instances use inverse transpose.
                    Matrix3 normalMatrix;
                    normalMatrix.getNormalMatrix(placement);
                    Vector3 normal(0.3, 0.7, -0.2), expected;
                    const auto* p = draw.boneMatrices->data() + slot * 32 + bone * 16;
                    expected
                        .set(world[0] * normal.x + world[4] * normal.y + world[8] * normal.z,
                             world[1] * normal.x + world[5] * normal.y + world[9] * normal.z,
                             world[2] * normal.x + world[6] * normal.y + world[10] * normal.z)
                        .normalize();
                    normal
                        .set(p[0] * 0.3 + p[4] * 0.7 - p[8] * 0.2, p[1] * 0.3 + p[5] * 0.7 - p[9] * 0.2,
                             p[2] * 0.3 + p[6] * 0.7 - p[10] * 0.2)
                        .applyMatrix3(normalMatrix)
                        .normalize();
                    CHECK(normal.distanceTo(expected) < 1e-6);
                }
            }
            for (bool found : seen)
                CHECK(found);
        }
    }
    const auto fallback = [&](int index) {
        scene.updateMatrixWorld(true);
        auto& rig = *rigs[index];
        rig.skeleton->update();
        SkinnedPalette expected(2, 1, false), actual(2, 1, false);
        expected.write(*expected.claim(&rig), rig, false);
        CHECK(actual.writeRelative(*actual.claim(&rig), rig) == nullptr);
        CHECK(actual.matrices() == expected.matrices());
    };
    fallback(0); // escaped bone
    rigs[1]->attached = false;
    fallback(1);
    rigs[1]->attached = true;
    Object3D::transformTrackingAddress(&bones[2]->position)[0] = 0;
    fallback(2); // raw C++ transform
    roots[3]->scale.set(1, 2, 1);
    rigs[3]->scale.set(1, 0.5, 1);
    fallback(3);
    roots[4]->scale.set(-1, 1, 1);
    rigs[4]->scale.set(-1, 1, 1);
    fallback(4);
    roots[5]->scale.setScalar(0);
    fallback(5);
    scene.add(*tips[6]);
    fallback(6); // unrelated bones share only the Scene, never a rig root
    roots[7]->onBeforeRender = std::make_shared<const std::function<bool(const RenderCallbackArgs&, std::string&)>>(
        [](const RenderCallbackArgs&, std::string&) { return true; });
    fallback(7);
    roots[7]->onBeforeRender.reset();
    material->nodeMaterial = true;
    fallback(7);
    material->nodeMaterial = false;
    scene.updateMatrixWorld(true);
    rigs[7]->bindMatrixInverse.identity();
    SkinnedPalette staleBind(2, 1, false), original(2, 1, false);
    original.write(*original.claim(rigs[7].get()), *rigs[7], false);
    CHECK(staleBind.writeRelative(*staleBind.claim(rigs[7].get()), *rigs[7]) == nullptr);
    CHECK(staleBind.matrices() == original.matrices());
}

// PRD-617: a material ARRAY draws one group per material, as three does. A Mesh(box, [m0..m5]) is six draws
// of two triangles each, in its group's colour; meshes sharing the geometry and materials batch per group.
void multiMaterialGroups() {
    Scene scene; PerspectiveCamera camera; LightState lights; RenderDatabase database;
    database.shadowMapEnabled = true;
    DirectionalLight sun;
    sun.position.set(10, 20, 20);
    sun.setCastShadow(true);
    scene.add(sun);
    camera.position.set(0, 0, 12);
    camera.lookAt(0, 0, 0);
    const auto geometry = makeBoxGeometry();
    CHECK(geometry->groups.size() == 6);
    std::vector<std::shared_ptr<Material>> materials;
    for (int i = 0; i < 6; ++i) {
        auto material = std::make_shared<Material>(MaterialType::Standard);
        material->color.setRGB(double(i + 1) / 8, 0.25, 0.5);
        materials.push_back(material);
    }
    auto mesh = std::make_shared<Mesh>(geometry, nullptr);
    mesh->materials = materials;
    mesh->setCastShadow(true);
    scene.add(*mesh);
    auto items = database.prepare(scene, camera, lights);
    CHECK(items.size() == 6);
    for (std::size_t i = 0; i < items.size() && i < 6; ++i) {
        CHECK(items[i].indices != nullptr && items[i].indices->count() == 6);
        CHECK(items[i].castShadow);
    }
    std::vector<double> reds;
    for (const DrawItem& item : items) reds.push_back(item.material->color[0]);
    std::sort(reds.begin(), reds.end());
    for (int i = 0; i < 6 && i < int(reds.size()); ++i) CHECK(std::abs(reds[i] - double(i + 1) / 8) < 1e-9);

    // A group whose material slot is missing draws nothing, as in three.
    mesh->materials.resize(3);
    items = database.prepare(scene, camera, lights);
    CHECK(items.size() == 3);

    // A moved mesh moves every group; the views are shared, not rebuilt.
    mesh->materials = materials;
    mesh->position.set(2, 0, 0);
    items = database.prepare(scene, camera, lights);
    CHECK(items.size() == 6);
    for (const DrawItem& item : items) CHECK(item.matrixWorld[12] == 2);

    // Four meshes sharing the geometry and materials batch per group: six instanced draws.
    std::vector<std::shared_ptr<Mesh>> crowd;
    for (int i = 0; i < 4; ++i) {
        auto member = std::make_shared<Mesh>(geometry, nullptr);
        member->materials = materials;
        member->position.set(-3 + i, 1, 0);
        scene.add(*member);
        crowd.push_back(member);
    }
    scene.remove(*mesh);
    items = database.prepare(scene, camera, lights);
    CHECK(items.size() == 6);
    for (const DrawItem& item : items) CHECK(item.instanceCount == 4);
    // A batched group draws its own slice only: the crowd's triangles are the boxes' triangles, no more.
    uint64_t triangles = 0;
    for (const DrawItem& item : items) triangles += uint64_t{item.instanceCount} * (item.indices->count() / 3);
    CHECK(triangles == 4 * 12);
}

// Forty copies that each built their own box draw as one instanced item from one copy's buffers;
// copies with different data at the same vertex count do not; a copy whose data moves leaves.
void contentIdenticalGeometryBatches() {
    Scene scene; PerspectiveCamera camera; LightState lights; RenderDatabase database;
    camera.position.set(20, 30, 60);
    camera.lookAt(20, 0, 0);
    auto material = std::make_shared<Material>(MaterialType::Standard);
    std::vector<std::shared_ptr<Mesh>> meshes;
    for (int i = 0; i < 40; ++i) {
        meshes.push_back(std::make_shared<Mesh>(makeBoxGeometry(), material));
        meshes.back()->position.set(i, 0, 0);
        scene.add(*meshes.back());
    }
    auto items = database.prepare(scene, camera, lights);
    CHECK(items.size() == 1 && items[0].instanceCount == 40);
    if (items.size() != 1) return;
    const BufferStore* drawn = items[0].positions;
    const auto owner = std::find_if(meshes.begin(), meshes.end(), [&](const auto& mesh) {
        return mesh->geometry->attributes.at("position")->store.get() == drawn;
    });
    CHECK(owner != meshes.end());
    if (owner == meshes.end()) return;
    auto position = (*owner)->geometry->attributes.at("position");
    position->setY(0, 5);
    position->setNeedsUpdate();
    items = database.prepare(scene, camera, lights);
    CHECK(items.size() == 2);
    const bool moved = std::any_of(items.begin(), items.end(), [&](const DrawItem& item) {
        return item.instanceCount <= 1 && item.positions == position->store.get();
    });
    const bool rest = std::any_of(items.begin(), items.end(), [&](const DrawItem& item) {
        return item.instanceCount == 39 && item.positions != position->store.get();
    });
    CHECK(moved && rest);

    Scene varied; RenderDatabase other;
    std::vector<std::shared_ptr<Mesh>> keep;
    for (int i = 0; i < 40; ++i) {
        auto geometry = makeBoxGeometry();
        geometry->scale(1, 1 + i / 100.0, 1);
        keep.push_back(std::make_shared<Mesh>(geometry, material));
        keep.back()->position.set(i, 0, 0);
        varied.add(*keep.back());
    }
    CHECK(other.prepare(varied, camera, lights).size() == 40);
}

void uniformBatchPreparation() {
    rigRelativePreparation();
    Material a(MaterialType::Standard), b(MaterialType::Standard);
    const std::array<double*, 27> left{
        &a.opacity, &a.alphaTest, &a.emissive.r, &a.emissive.g,
        &a.emissive.b, &a.emissiveIntensity, &a.roughness, &a.envMapIntensity,
        &a.metalness, &a.specular.r, &a.specular.g, &a.specular.b,
        &a.shininess, &a.ior, &a.specularIntensity, &a.specularColor.r,
        &a.specularColor.g, &a.specularColor.b, &a.clearcoat, &a.sheen,
        &a.transmission, &a.iridescence, &a.anisotropy, &a.dispersion,
        &a.normalScale.x, &a.normalScale.y, &a.aoMapIntensity,
    };
    const std::array<double*, 27> right{
        &b.opacity, &b.alphaTest, &b.emissive.r, &b.emissive.g,
        &b.emissive.b, &b.emissiveIntensity, &b.roughness, &b.envMapIntensity,
        &b.metalness, &b.specular.r, &b.specular.g, &b.specular.b,
        &b.shininess, &b.ior, &b.specularIntensity, &b.specularColor.r,
        &b.specularColor.g, &b.specularColor.b, &b.clearcoat, &b.sheen,
        &b.transmission, &b.iridescence, &b.anisotropy, &b.dispersion,
        &b.normalScale.x, &b.normalScale.y, &b.aoMapIntensity,
    };
    for (std::size_t i = 0; i < left.size(); ++i) {
        const double beforeA = *left[i], beforeB = *right[i];
        *left[i] = *right[i] + 0.25;
        CHECK(!projection::detail::sameUniforms(a, b));
        *left[i] = -0.0; *right[i] = 0.0;
        CHECK(projection::detail::sameUniforms(a, b));
        *left[i] = *right[i] = std::numeric_limits<double>::infinity();
        CHECK(projection::detail::sameUniforms(a, b));
        *left[i] = *right[i] = std::numeric_limits<double>::quiet_NaN();
        CHECK(!projection::detail::sameUniforms(a, b));
        *left[i] = beforeA; *right[i] = beforeB;
    }
    Scene scene; PerspectiveCamera camera; LightState lights; RenderDatabase database;
    camera.position.set(32, 80, 200); // the whole 64 x 64 grid inside the frustum
    camera.lookAt(32, 0, 32);
    const auto geometry = makeBoxGeometry();
    std::vector<std::shared_ptr<Mesh>> meshes;
    for (int i = 0; i < 4096; ++i) {
        auto material = std::make_shared<Material>(MaterialType::Standard);
        material->color.setRGB(double(i) / 4096, 0.2, 0.3);
        auto mesh = std::make_shared<Mesh>(geometry, material);
        mesh->position.set(i % 64, 0, i / 64);
        scene.add(*mesh); meshes.push_back(mesh);
    }
    std::reverse(scene.children.begin(), scene.children.end());
    auto items = database.prepare(scene, camera, lights);
    CHECK(items.size() == 1);
    if (items.size() != 1) return;
    CHECK(items[0].instanceCount == 4096 && items[0].instanceColors);
    CHECK(items[0].material->color[0] == 1 && items[0].material->color[1] == 1);
    // The dense radix lane must preserve the exact depth/id order of individual opaque draws.
    Matrix4 projectionView;
    projectionView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    std::vector<std::pair<double, const Mesh*>> expected;
    for (const auto& mesh : meshes) {
        Vector3 origin;
        origin.setFromMatrixPosition(mesh->matrixWorld).applyMatrix4(projectionView);
        expected.emplace_back(origin.z, mesh.get());
    }
    std::sort(expected.begin(), expected.end(), [](const auto& a, const auto& b) {
        return a.first != b.first ? a.first < b.first : a.second->id() < b.second->id();
    });
    const auto* matrices = reinterpret_cast<const float*>(items[0].instanceMatrices->data());
    const auto* colors = reinterpret_cast<const float*>(items[0].instanceColors->data());
    for (std::size_t i = 0; i < expected.size(); ++i) {
        CHECK(matrices[i * 16 + 12] == float(expected[i].second->position.x));
        CHECK(matrices[i * 16 + 14] == float(expected[i].second->position.z));
        CHECK(colors[i * 3] == float(expected[i].second->material->color.r));
    }
    // Exercise signs/zero ties, nonfinite fallback, and groups with different active radix digits.
    Camera depthCamera;
    depthCamera.coordinateSystem = CoordinateSystem::WebGPU;
    // The depth keys under test lie far outside this identity projection's clip volume.
    for (auto& mesh : meshes) mesh->frustumCulled = false;
    for (int pattern = 0; pattern < 5; ++pattern) {
        const bool infinite = pattern == 1, multiple = pattern >= 2;
        depthCamera.projectionMatrix.identity();
        if (infinite) depthCamera.projectionMatrix.elements[15] = 0;
        std::array<std::vector<std::pair<double, const Mesh*>>, 2> expectedGroups;
        for (std::size_t i = 0; i < meshes.size(); ++i) {
            const std::size_t group =
                multiple ? (pattern == 3 ? std::size_t(i % 3 == 0) : i % 2) : 0;
            meshes[i]->material->roughness = group ? 0.25 : 1;
            const bool wide = (group + pattern) % 2 == 0;
            const double z = multiple
                ? (pattern == 4 && group == 0 ? 1
                   : wide ? std::ldexp(double(int(i % 33) - 16), pattern * 20)
                          : 1 + std::ldexp(double(i % 33), -40 - pattern))
                : (infinite ? double(i % 33 + 1) : double(int(i % 33) - 16));
            meshes[i]->position.z = z == 0 && i % 2 ? -0.0 : z;
            expectedGroups[group].emplace_back(infinite ? std::numeric_limits<double>::infinity() : z, meshes[i].get());
        }
        for (auto& group : expectedGroups)
            std::sort(group.begin(), group.end(), [](const auto& a, const auto& b) {
                return a.first != b.first ? a.first < b.first : a.second->id() < b.second->id();
            });
        items = database.prepare(scene, depthCamera, lights);
        CHECK(items.size() == (multiple ? 2 : 1));
        if (items.size() != (multiple ? 2 : 1)) return;
        for (const auto& item : items) {
            const auto& group = expectedGroups[item.material->roughness == 0.25 ? 1 : 0];
            CHECK(item.instanceCount == group.size() && item.instanceColors);
            if (item.instanceCount != group.size() || !item.instanceColors) return;
            matrices = reinterpret_cast<const float*>(item.instanceMatrices->data());
            colors = reinterpret_cast<const float*>(item.instanceColors->data());
            for (std::size_t i = 0; i < group.size(); ++i) {
                CHECK(matrices[i * 16 + 12] == float(group[i].second->position.x));
                CHECK(matrices[i * 16 + 14] == float(group[i].second->position.z));
                CHECK(colors[i * 3] == float(group[i].second->material->color.r));
            }
        }
    }
    // Depths that round together as float32 keep their exact double order, and equal depths keep id
    // order: positive, negative, straddling zero (with both zeros), and beyond float32's range.
    depthCamera.projectionMatrix.identity();
    const auto scrambled = [](std::size_t i, unsigned modulus) { return double((i * 2654435761u) % modulus); };
    const std::vector<std::function<double(std::size_t)>> roundedDepths = {
        [&](std::size_t i) { return 1 + std::ldexp(scrambled(i, 211), -30); },
        [&](std::size_t i) { return -1 - std::ldexp(scrambled(i, 211), -30); },
        [&](std::size_t i) {
            if (i % 97 == 0) return i % 2 ? -0.0 : 0.0;
            return std::ldexp(scrambled(i, 211) - 105, -60);
        },
        [&](std::size_t i) { return i % 50 == 0 ? double(int(i % 7)) : 1e39 * (1 + std::ldexp(scrambled(i, 211), -40)); },
        [&](std::size_t i) { return -1e39 * (1 + std::ldexp(scrambled(i, 211), -40)); },
    };
    for (const auto& depthOf : roundedDepths) {
        std::vector<std::pair<double, const Mesh*>> rounded;
        for (std::size_t i = 0; i < meshes.size(); ++i) {
            meshes[i]->material->roughness = 1;
            meshes[i]->position.z = depthOf(i);
            rounded.emplace_back(meshes[i]->position.z, meshes[i].get());
        }
        std::sort(rounded.begin(), rounded.end(), [](const auto& a, const auto& b) {
            return a.first != b.first ? a.first < b.first : a.second->id() < b.second->id();
        });
        items = database.prepare(scene, depthCamera, lights);
        CHECK(items.size() == 1 && items[0].instanceCount == rounded.size() && items[0].instanceColors);
        if (items.size() == 1 && items[0].instanceColors) {
            colors = reinterpret_cast<const float*>(items[0].instanceColors->data());
            for (std::size_t i = 0; i < rounded.size(); ++i)
                CHECK(colors[i * 3] == float(rounded[i].second->material->color.r));
        }
    }
    for (std::size_t i = 0; i < meshes.size(); ++i) {
        meshes[i]->position.z = double(i / 64);
        meshes[i]->material->roughness = 1;
    }
    const auto rebuilds = database.rebuilds();
    for (auto& mesh : meshes) mesh->position.y = 2;
    meshes[0]->material->color.r = 0.8;
    items = database.prepare(scene, camera, lights);
    CHECK(items.size() == 1 && database.rebuilds() == rebuilds);
    CHECK(meshes[0]->matrixWorld.elements[13] == 2);
    // Ordinary member edits are checked immediately, without a version bump.
    meshes[0]->material->roughness = 0.5;
    items = database.prepare(scene, camera, lights);
    CHECK(items.size() == 2);
    meshes[0]->material->roughness = 1;
    meshes[0]->material->fog = false;
    items = database.prepare(scene, camera, lights);
    CHECK(items.size() == 2);
    meshes[0]->material->fog = true;
    meshes[0]->setRenderOrder(2);
    items = database.prepare(scene, camera, lights);
    CHECK(items.size() == 2);
    scene.remove(*meshes[0]);
    items = database.prepare(scene, camera, lights);
    CHECK(items.size() == 1 && items[0].instanceCount == 4095);
    Object3D parent; parent.position.x = 100; scene.add(parent);
    database.prepare(scene, camera, lights);
    parent.add(*meshes[1]);
    database.prepare(scene, camera, lights);
    CHECK(meshes[1]->matrixWorld.elements[12] == 101);
    parent.position.x = 200;
    parent.updateWorldMatrix(true, false); // a query refreshed the parent before the render
    database.prepare(scene, camera, lights);
    CHECK(meshes[1]->matrixWorld.elements[12] == 201);
    Object3D copy; copy.copy(*meshes[1]); copy.updateMatrixWorld();
    CHECK(copy.matrixWorld.elements[12] == 1);
    parent.matrixWorldAutoUpdate = false;
    parent.matrixWorld.makeTranslation(300, 0, 0);
    database.prepare(scene, camera, lights);
    CHECK(meshes[1]->matrixWorld.elements[12] == 301);
    parent.remove(*meshes[1]);
    meshes[1]->updateMatrixWorld();
    CHECK(meshes[1]->matrixWorld.elements[12] == 1);
    scene.remove(parent);
    // All matrix hooks run before projection: earlier meshes see a later geometry edit too.
    struct GeometryChange final : Mesh {
        using Mesh::Mesh;
        std::shared_ptr<BufferAttribute> next;
        void updateMatrix() override {
            if (next) { geometry->setAttribute("position", next); next.reset(); }
            Object3D::updateMatrix();
        }
    } changer(geometry, meshes[2]->material);
    changer.next = makeBoxGeometry()->attributes.at("position");
    scene.add(changer);
    items = database.prepare(scene, camera, lights);
    CHECK(items.size() == 1 && database.lastBatches().second == 4095);
    if (items.size() == 1) CHECK(items[0].positions == geometry->attributes.at("position")->store.get());

    // The public child vector can change without a hierarchy-version bump.
    Scene reordered; Mesh ordinary(geometry, meshes[2]->material); DirectionalLight sun;
    RenderDatabase reorderDatabase; reordered.add(ordinary).add(sun);
    CHECK(reorderDatabase.prepare(reordered, camera, lights).size() == 1);
    for (int i = 0; i < 2; ++i) {
        std::reverse(reordered.children.begin(), reordered.children.end());
        const auto draws = reorderDatabase.prepare(reordered, camera, lights);
        CHECK(draws.size() == 1 && lights.direct.size() == 1);
        if (draws.size() == 1) CHECK(draws[0].key == ordinary.id());
    }
    struct HookMesh : Mesh {
        using Mesh::Mesh; std::string* trace = nullptr;
        void updateMatrixWorld(bool force = false) override {
            *trace += 'M'; Mesh::updateMatrixWorld(force);
        }
    };
    struct HookLight : DirectionalLight {
        std::string* trace = nullptr;
        void updateMatrixWorld(bool force = false) override {
            *trace += 'L'; DirectionalLight::updateMatrixWorld(force);
        }
    };
    struct HookScene : Scene {
        std::string* trace = nullptr;
        void updateMatrixWorld(bool force = false) override {
            *trace += 'S'; Scene::updateMatrixWorld(force);
        }
    };
    struct HookCamera : PerspectiveCamera {
        std::string* trace = nullptr; Mesh* watched = nullptr;
        void updateMatrixWorld(bool force = false) override {
            *trace += 'C'; watched->position.x += 1; PerspectiveCamera::updateMatrixWorld(force);
        }
    };
    for (int mode = 0; mode < 5; ++mode) {
        std::string trace;
        Scene plainScene; HookScene hookScene; hookScene.trace = &trace;
        Mesh plainMesh(geometry, meshes[2]->material);
        HookMesh hookMesh(geometry, meshes[2]->material); hookMesh.trace = &trace;
        DirectionalLight plainLight; HookLight hookLight; hookLight.trace = &trace;
        PerspectiveCamera plainCamera; HookCamera hookCamera; hookCamera.trace = &trace;
        Scene& world = mode == 2 || mode == 4 ? hookScene : plainScene;
        Mesh& mesh = mode == 0 || mode == 4 ? hookMesh : plainMesh;
        DirectionalLight& light = mode == 1 || mode == 4 ? hookLight : plainLight;
        PerspectiveCamera& view = mode == 3 || mode == 4 ? hookCamera : plainCamera;
        // The default camera sits inside this mesh; the test is about update order, not culling.
        hookCamera.watched = &mesh; mesh.position.x = 1; mesh.frustumCulled = false; world.add(mesh).add(light);
        RenderDatabase db;
        CHECK(db.prepare(world, view, lights).size() == 1);
        CHECK(trace == (mode == 0 ? "M" : mode == 1 ? "L" : mode == 2 ? "S" : mode == 3 ? "C" : "SMLC"));
        CHECK(mesh.matrixWorld.elements[12] == 1);
        CHECK(mesh.position.x == (mode >= 3 ? 2 : 1));
    }
    // Build the replacement subtree before warming so no later add() invalidates the old cache.
    Scene nested; Mesh before(geometry, meshes[2]->material), after(geometry, meshes[2]->material);
    Mesh descendant(geometry, meshes[2]->material); after.add(descendant);
    after.position.x = 10; descendant.position.x = 2; nested.add(before);
    RenderDatabase nestedDatabase; CHECK(nestedDatabase.prepare(nested, camera, lights).size() == 1);
    nested.children[0] = &after; before.parent = nullptr; after.parent = &nested;
    const auto nestedDraws = nestedDatabase.prepare(nested, camera, lights);
    CHECK(nestedDraws.size() == 2);
    CHECK(descendant.matrixWorld.elements[12] == 12);
    struct MoveOnUpdate : Object3D {
        Mesh* watched = nullptr;
        void updateMatrix() override { watched->position.x += 1; Object3D::updateMatrix(); }
    };
    // Queries from a light target, camera child or shadow camera must follow scene updates.
    for (int mode = 0; mode < 4; ++mode) {
        Scene world; PerspectiveCamera view; DirectionalLight light;
        Mesh mesh(geometry, meshes[2]->material); mesh.position.x = 1; mesh.frustumCulled = false;
        auto hook = std::make_shared<MoveOnUpdate>(); hook->watched = &mesh;
        if (mode == 0) light.target = hook;
        if (mode == 1) hook->add(*light.target);
        if (mode == 2) view.add(*hook);
        if (mode == 3) { light.setCastShadow(true); light.shadow.camera->add(*hook); }
        world.add(light).add(mesh);
        if (mode < 2) world.add(*hook);  // three refreshes a light target only through the scene
        RenderDatabase db; db.shadowMapEnabled = mode == 3;
        CHECK(db.prepare(world, view, lights).size() == 1);
        CHECK(mesh.position.x == 2 && mesh.matrixWorld.elements[12] == 1);
    }

    // Replacing a flat slot with a layer-excluded child must release the old resource owners.
    Scene replaced; RenderDatabase replacementDatabase;
    auto removed = std::make_shared<Mesh>(makeBoxGeometry(), std::make_shared<Material>(MaterialType::Standard));
    std::weak_ptr<BufferGeometry> removedGeometry = removed->geometry;
    std::weak_ptr<Material> removedMaterial = removed->material;
    replaced.add(*removed);
    CHECK(replacementDatabase.prepare(replaced, camera, lights).size() == 1);
    replaced.remove(*removed);
    removed.reset();
    Mesh excluded(makeBoxGeometry(), std::make_shared<Material>(MaterialType::Standard));
    excluded.setLayer(1); replaced.add(excluded);
    CHECK(replacementDatabase.prepare(replaced, camera, lights).empty());
    CHECK(removedGeometry.expired() && removedMaterial.expired());
}

// Consumer preparation, with no GPU: scene fog and sky must reach the same DrawItems used by render().
void sceneEnvironment() {
    CHECK(Texture{}.flipY && Texture{}.minFilter == 1008 && !DataTexture{}.flipY);
    RenderDatabase database;
    Scene scene; PerspectiveCamera camera(55, 4.0 / 3, 0.1, 100); camera.position.set(1, 2, 6);
    LightState lights;
    auto material = std::make_shared<Material>(MaterialType::Standard);
    auto mesh = std::make_shared<Mesh>(makeSphereGeometry(), material); scene.add(*mesh);
    auto sky = std::make_shared<DataTexture>(); sky->mapping = 303; sky->width = 128; sky->height = 64;
    sky->data.resize(128 * 64 * 4, 255); sky->needsUpdate();
    scene.backgroundTexture = scene.environment = sky;
    scene.backgroundIntensity = scene.environmentIntensity = 2.5;
    scene.fog = std::make_shared<FogExp2>(Color(0.1, 0.4, 0.8), 0.003);
    auto draws = database.prepare(scene, camera, lights);
    CHECK(draws.size() == 2); if (draws.size() != 2) return;
    CHECK(draws[0].background && !draws[0].depthWrite && !draws[0].fog && draws[0].map == sky.get());
    CHECK(draws[0].material->color[0] == 2.5f && draws[0].side == 1);
    CHECK(draws[0].matrixWorld[12] == 1 && draws[0].matrixWorld[14] == 6);
    shader::VertexVariant skyVariant; skyVariant.background = draws[0].background; skyVariant.map = draws[0].map != nullptr;
    const auto skyVertex = shader::buildStage(shader::buildBasic(skyVariant).vertex, 0);
    CHECK(skyVertex.wgsl.ok() && !skyVertex.attributes.empty());
    for (const auto& attribute : skyVertex.attributes)
        CHECK((attribute.name == "position" && draws[0].positions) || (attribute.name == "normal" && draws[0].normals));
    CHECK(draws[1].fog == scene.fog.get() && draws[1].envMap == sky.get() && draws[1].envMapIntensity == 2.5);
    CameraState state; state.matrixWorldInverse = camera.matrixWorldInverse.elements;
    const auto sorted = Renderer::sortDraws(draws, state); CHECK(sorted.front().second->background);
    material->fog = false; scene.backgroundIntensity = 1.25;
    draws = database.prepare(scene, camera, lights);
    CHECK(!draws[1].fog && draws[0].material->color[0] == 1.25f);
    scene.backgroundTexture.reset(); scene.environment = sky;
    draws = database.prepare(scene, camera, lights); CHECK(draws.size() == 1 && !draws[0].background && draws[0].envMap == sky.get());
    scene.backgroundTexture = sky;
    OrthographicCamera ortho(-4, 4, 3, -3, 0.1, 100);
    draws = database.prepare(scene, ortho, lights); CHECK(draws[0].matrixWorld[0] == 9);
    // A material envMap (a sphere reflection capture) replaces the scene environment for that mesh and is not refused.
    Scene mirrorScene; mirrorScene.environment = sky;
    auto mirror = std::make_shared<Material>(MaterialType::Standard);
    auto probe = std::make_shared<DataTexture>(); probe->mapping = 303; probe->width = 128; probe->height = 64;
    probe->data.resize(128 * 64 * 4, 128); probe->needsUpdate();
    mirror->maps["envMap"] = probe; mirror->envMapIntensity = 0.5;
    auto mirrorMesh = std::make_shared<Mesh>(makeSphereGeometry(), mirror); mirrorScene.add(*mirrorMesh);
    RenderDatabase mirrorDatabase;
    draws = mirrorDatabase.prepare(mirrorScene, camera, lights);
    CHECK(draws.size() == 1 && draws[0].envMap == probe.get() && draws[0].envMapIntensity == 0.5);
    for (const auto& line : mirrorDatabase.diagnostics()) CHECK(line.find("envMap") == std::string::npos);
}

std::vector<uint8_t> read(Renderer& r, EventQueue& events) {
    std::vector<uint8_t> out;
    bool done = false;
    r.readPixels([&](GpuStatus s, std::vector<uint8_t> px) {
        if (s == GpuStatus::Ok) out = std::move(px);
        done = true;
    });
    for (int i = 0; i < 4000 && !done; ++i) {
        r.poll();
        events.drain();
        if (!done) std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    return out;
}

// The lit-render fixture's scene, built through the native classes as its ops build it.
struct LitScene {
    Scene scene;
    PerspectiveCamera camera;
    std::shared_ptr<BufferGeometry> geometry = makeSphereGeometry(1, 32, 16);
    std::shared_ptr<Material> material = std::make_shared<Material>(MaterialType::Standard);
    Mesh mesh{geometry, material};
    DirectionalLight light{Color().setHex(0xffffff), 3};
    HemisphereLight sky{Color().setHex(0xaabb91), Color().setHex(0x222222), 0.6};
    LitScene() {
        camera.fov = 60;
        camera.aspect = 4.0 / 3;
        camera.near = 0.1;
        camera.far = 100;
        camera.position.y = 1.4;
        camera.position.z = 3.2;
        camera.lookAt(0, 0, 0);
        light.position.set(2, 3, 1);
        material->color.setRGB(0.8, 0.35, 0.2);
        material->roughness = 0.35;
        material->metalness = 0.1;
        scene.add(mesh);
        scene.add(light);
        scene.add(sky);
        camera.updateProjectionMatrix();
        scene.updateMatrixWorld(true);
    }
};

// PRD-771: the scene half of render() (joints, scene walk, shadow sync) is metered as its own stage, and the three
// stages the page reads (scene, prepare, encode) never add up to more than the call took.
void sceneStageIsMetered() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(320, 240);
    renderer.setOutput(OutputState{shader::ToneMapping::ACESFilmic, 1, true});
    LitScene s;
    RenderDatabase database;
    CHECK(database.sceneMs() == 0 && database.rendererMs() == 0);
    const auto wall = std::chrono::steady_clock::now();
    for (int frame = 0; frame < 3; ++frame) database.render(renderer, s.scene, s.camera, {0.05, 0.06, 0.08, 1});
    const double callMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - wall).count();
    const double scene = database.sceneMs();
    const double prepare = renderer.cpuStageMs(Renderer::CpuPrepare), encode = renderer.cpuStageMs(Renderer::CpuEncode);
    const double inRenderer = database.rendererMs();
    CHECK(scene > 0 && prepare > 0 && encode > 0);
    CHECK(scene + prepare + encode <= callMs + 0.5);
    // `Renderer::render` holds both halves, and the scene half ends where it starts.
    CHECK(inRenderer >= prepare + encode - 0.5 && scene + inRenderer <= callMs + 0.5);
    Renderer::setCpuMeters(false);
    for (int frame = 0; frame < 3; ++frame) database.render(renderer, s.scene, s.camera, {0.05, 0.06, 0.08, 1});
    Renderer::setCpuMeters(true);
    CHECK(database.sceneMs() == scene && database.rendererMs() == inRenderer);
    CHECK(renderer.cpuStageMs(Renderer::CpuPrepare) == prepare && renderer.cpuStageMs(Renderer::CpuEncode) == encode);
    // A sibling (a render target's or a reflection's renderer) publishes nothing, so it reads no clock.
    auto child = renderer.sibling();
    RenderDatabase childDatabase;
    CHECK(!child->metered() && renderer.metered());
    childDatabase.render(*child, s.scene, s.camera, {0.05, 0.06, 0.08, 1});
    CHECK(child->cpuStageMs(Renderer::CpuPrepare) == 0 && child->cpuStageMs(Renderer::CpuEncode) == 0);
    CHECK(childDatabase.sceneMs() == 0 && childDatabase.rendererMs() == 0);
}

void overlayLeavesStageTotals() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(320, 240);
    renderer.setOutput(OutputState{shader::ToneMapping::ACESFilmic, 1, true});
    LitScene s;
    RenderDatabase database, overlayDatabase;
    database.render(renderer, s.scene, s.camera, {0.05, 0.06, 0.08, 1});
    std::array<double, Renderer::kCpuStageCount> before{};
    for (size_t i = 0; i < before.size(); ++i) before[i] = renderer.cpuStageMs(Renderer::CpuStage(i));
    const double scene = database.sceneMs(), inRenderer = database.rendererMs();
    // The canvas layer's draw is the overlay: its renderer is a sibling and its database is its own, so the world's
    // totals (and the next world frame's difference) hold no overlay time.
    Renderer& overlay = renderer.overlayRenderer();
    CHECK(!overlay.metered());
    for (int frame = 0; frame < 3; ++frame) overlayDatabase.render(overlay, s.scene, s.camera, {0, 0, 0, 0});
    for (size_t i = 0; i < before.size(); ++i) CHECK(renderer.cpuStageMs(Renderer::CpuStage(i)) == before[i]);
    CHECK(database.sceneMs() == scene && database.rendererMs() == inRenderer);
    CHECK(overlayDatabase.sceneMs() == 0 && overlayDatabase.rendererMs() == 0);
}

void litScene() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(320, 240);
    renderer.setOutput(OutputState{shader::ToneMapping::ACESFilmic, 1, true});
    LitScene s;
    RenderDatabase database;
    database.render(renderer, s.scene, s.camera, {0.05, 0.06, 0.08, 1});
    for (const std::string& d : database.diagnostics()) std::fprintf(stderr, "%s\n", d.c_str());
    CHECK(database.diagnostics().empty());
    const std::vector<uint8_t> px = read(renderer, events);
    // The desktop frame, raw RGBA, for the browser build's parity scenario (PRD-532).
    if (FILE* out = std::fopen(TN_NATIVE_LIT_OUT, "wb")) {
        std::fwrite(px.data(), 1, px.size(), out);
        std::fclose(out);
    }
    const std::string png = std::string(TN_GOLDENS_DIR) + "/lit-render.png";
    int w = 0, h = 0, c = 0;
    unsigned char* golden = stbi_load(png.c_str(), &w, &h, &c, 4);
    CHECK(golden && w == 320 && h == 240 && px.size() == 320 * 240 * 4);
    if (!golden || px.size() != 320 * 240 * 4) return;
    int worst = 0;
    size_t over1 = 0;
    for (size_t i = 0; i < px.size(); i += 4)
        for (int k = 0; k < 3; ++k) {
            const int d = std::abs(int(px[i + k]) - int(golden[i + k]));
            worst = std::max(worst, d);
            over1 += d > 1;
        }
    stbi_image_free(golden);
    std::printf("scene lit-render vs browser: worst %d, %.3f%% of channels over 1\n", worst, over1 * 100.0 / (320 * 240 * 3));
    CHECK(worst <= 8 && over1 < 320 * 240 * 3 / 1000);
}

std::vector<uint8_t> readTexture(Renderer& r, EventQueue& events, Handle texture) {
    std::vector<uint8_t> out;
    bool done = false;
    r.gpu().readTexture(texture, [&](GpuStatus s, std::vector<uint8_t> px) {
        if (s == GpuStatus::Ok) out = std::move(px);
        done = true;
    });
    for (int i = 0; i < 4000 && !done; ++i) {
        r.poll();
        events.drain();
        if (!done) std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    return out;
}

// presentNext puts the output pass into the target itself: the bytes the blit copies, for the
// formats a window surface takes, frame after frame, without disturbing the readable frame.
void presentDirect() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(160, 120);
    renderer.setOutput(OutputState{shader::ToneMapping::ACESFilmic, 1, true});
    LitScene s;
    RenderDatabase database;
    for (const WGPUTextureFormat format : {WGPUTextureFormat_RGBA8Unorm, WGPUTextureFormat_BGRA8Unorm}) {
        const WGPUTextureUsage usage = WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_CopySrc;
        const Handle copied = renderer.gpu().createTexture(160, 120, format, usage);
        const Handle direct = renderer.gpu().createTexture(160, 120, format, usage);
        WGPUTextureView copiedView = wgpuTextureCreateView(renderer.gpu().texture(copied), nullptr);
        WGPUTextureView directView = wgpuTextureCreateView(renderer.gpu().texture(direct), nullptr);
        for (int frame = 0; frame < 3; ++frame) {
            s.mesh.rotation.y = 0.4 * (frame + 1);
            database.render(renderer, s.scene, s.camera, {0.05, 0.06, 0.08, 1});
            CHECK(renderer.blitTo(context.getQueue(), copiedView, format));
            const std::vector<uint8_t> expected = readTexture(renderer, events, copied);
            const std::vector<uint8_t> readable = read(renderer, events);
            renderer.presentNext(directView, format);
            database.render(renderer, s.scene, s.camera, {0.05, 0.06, 0.08, 1});
            const std::vector<uint8_t> actual = readTexture(renderer, events, direct);
            CHECK(database.diagnostics().empty());
            CHECK(expected.size() == 160 * 120 * 4 && actual == expected);
            CHECK(std::any_of(expected.begin(), expected.end(), [&](uint8_t b) { return b != expected[0]; }));
            CHECK(read(renderer, events) == readable);  // a presented frame leaves the readable one alone
        }
        wgpuTextureViewRelease(copiedView);
        wgpuTextureViewRelease(directView);
        renderer.gpu().destroy(copied);
        renderer.gpu().destroy(direct);
    }
    // A frame that fails between arming and render() must not leave its borrowed view armed: the
    // next, ordinary frame may not draw into a view the caller has since released.
    const Handle stale = renderer.gpu().createTexture(160, 120, WGPUTextureFormat_RGBA8Unorm,
                                                      WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_CopySrc);
    WGPUTextureView staleView = wgpuTextureCreateView(renderer.gpu().texture(stale), nullptr);
    auto sky = std::make_shared<DataTexture>();
    sky->mapping = 300;  // prepare() refuses anything but equirectangular reflection mapping
    s.scene.backgroundTexture = sky;
    bool threw = false;
    try {
        Renderer::PresentScope armed(renderer, staleView, WGPUTextureFormat_RGBA8Unorm);
        database.render(renderer, s.scene, s.camera, {0.05, 0.06, 0.08, 1});
    } catch (const std::runtime_error&) {
        threw = true;
    }
    CHECK(threw);
    s.scene.backgroundTexture.reset();
    database.render(renderer, s.scene, s.camera, {0.05, 0.06, 0.08, 1});
    const std::vector<uint8_t> untouched = readTexture(renderer, events, stale);
    CHECK(untouched.size() == 160 * 120 * 4 &&
          std::all_of(untouched.begin(), untouched.end(), [](uint8_t b) { return b == 0; }));
    wgpuTextureViewRelease(staleView);
    renderer.gpu().destroy(stale);
}

// The world's post graph still reaches the canvas after an overlay draw, in the web host's order: each world frame
// takes the canvas view only when it draws (presentWhenDrawn), and the canvas-layer overlay draws over it.
void postSurvivesOverlay() {
    namespace g = shader::graph;
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(160, 120);
    renderer.setOutput(OutputState{shader::ToneMapping::ACESFilmic, 1, true});
    LitScene s;
    RenderDatabase database, overlayDatabase;
    const WGPUTextureFormat format = WGPUTextureFormat_BGRA8Unorm;
    const Handle surface = renderer.gpu().createTexture(160, 120, format, WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_CopySrc);
    WGPUTextureView view = wgpuTextureCreateView(renderer.gpu().texture(surface), nullptr);
    const auto world = [&] {
        Renderer::PresentScope present(renderer, [&] { return view; }, format);
        database.render(renderer, s.scene, s.camera, {0.05, 0.06, 0.08, 1});
        return readTexture(renderer, events, surface);
    };
    Scene layer;
    OrthographicCamera ortho(-1, 1, 1, -1, 0.1, 10);
    ortho.position.z = 5;
    ortho.updateProjectionMatrix();
    layer.updateMatrixWorld(true);
    const auto overlay = [&] {
        Renderer& target = renderer.overlayRenderer();
        Renderer::PresentScope present(target, [&] { return view; }, format);
        overlayDatabase.render(target, layer, ortho, {0, 0, 0, 0});
    };
    const std::vector<uint8_t> plain = world();
    renderer.setPostGraph(g::mul(g::texture("scene", g::uv()), g::float_(0.25)));
    const std::vector<uint8_t> posted = world();
    CHECK(posted != plain);
    for (int frame = 0; frame < 3; ++frame) {
        overlay();
        CHECK(world() == posted);
    }
    wgpuTextureViewRelease(view);
    renderer.gpu().destroy(surface);
}

// The canvas-layer overlay (core's loading screen) draws over the presented world frame: an empty overlay leaves it
// byte for byte, a plane over the left half replaces only that half. Drawn through the world renderer it cleared the
// frame and ran the world's temporal step. The overlay is UI, so it draws with no tone curve (Unreal's Slate composites
// after the tonemapper): its grey lands on the CSS value within 2 levels under a world output that tone maps. And a frame the renderer skips (its environment still bakes) never asks
// for the surface view: a taken canvas texture presents, so the skipped frame flashed black.
void canvasLayerOverlay() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(160, 120);
    renderer.setOutput(OutputState{shader::ToneMapping::ACESFilmic, 1, true});
    LitScene s;
    RenderDatabase database;
    const WGPUTextureFormat format = WGPUTextureFormat_BGRA8Unorm;
    const Handle surface = renderer.gpu().createTexture(160, 120, format, WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_CopySrc);
    WGPUTextureView view = wgpuTextureCreateView(renderer.gpu().texture(surface), nullptr);
    renderer.presentNext(view, format);
    database.render(renderer, s.scene, s.camera, {0.05, 0.06, 0.08, 1});
    const std::vector<uint8_t> world = readTexture(renderer, events, surface);
    CHECK(world.size() == 160 * 120 * 4);

    Scene layer;
    OrthographicCamera ortho(-1, 1, 1, -1, 0.1, 10);
    ortho.position.z = 5;
    ortho.updateProjectionMatrix();
    RenderDatabase overlayDatabase;
    Renderer& overlay = renderer.overlayRenderer();
    layer.updateMatrixWorld(true);
    overlay.presentNext(view, format);
    overlayDatabase.render(overlay, layer, ortho, {0, 0, 0, 0});
    CHECK(overlayDatabase.diagnostics().empty());
    CHECK(readTexture(renderer, events, surface) == world);

    // Mid grey: sRGB 128 is linear 0.2158. The world's ACES curve took it to about 146; UI draws after the curve.
    auto cover = std::make_shared<Material>(MaterialType::Basic);
    cover->color.setRGB(0.2158, 0.2158, 0.2158);
    Mesh plane(makePlaneGeometry(1, 2), cover);
    plane.position.x = -0.5;
    layer.add(plane);
    layer.updateMatrixWorld(true);
    overlay.presentNext(view, format);
    overlayDatabase.render(overlay, layer, ortho, {0, 0, 0, 0});
    const std::vector<uint8_t> covered = readTexture(renderer, events, surface);
    bool rightKept = true, leftCovered = true;
    for (size_t y = 0; y < 120; ++y)
        for (size_t x = 0; x < 160; ++x) {
            const size_t at = (y * 160 + x) * 4;
            if (x >= 84) rightKept = rightKept && std::equal(&covered[at], &covered[at] + 4, &world[at]);
            if (x < 76)
                for (size_t c = 0; c < 3; ++c) leftCovered = leftCovered && std::abs(int(covered[at + c]) - 128) <= 2;
        }
    CHECK(rightKept);
    CHECK(leftCovered);

    auto sky = std::make_shared<DataTexture>();
    sky->mapping = 303;
    sky->width = 128;
    sky->height = 64;
    sky->data.assign(size_t(sky->width) * sky->height * 4, 255);
    sky->needsUpdate();
    s.scene.environment = sky;
    int asked = 0;
    const auto acquire = [&] { ++asked; return view; };
    {
        Renderer::PresentScope present(renderer, acquire, format);
        CHECK(database.render(renderer, s.scene, s.camera, {0.05, 0.06, 0.08, 1}) == 0);  // the bake skips this frame
    }
    CHECK(asked == 0);
    for (int frame = 0; frame < 5000 && asked == 0; ++frame) {
        {
            Renderer::PresentScope present(renderer, acquire, format);
            database.render(renderer, s.scene, s.camera, {0.05, 0.06, 0.08, 1});
        }
        renderer.poll();
        events.drain();
        if (asked == 0) std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    CHECK(asked == 1);  // the first drawn frame asked once
    // The web host's held frame arms the same lazy acquire with the hold decided inside it (web_host.cpp
    // tnw_web_render): a drawn frame is handed a null view and draws into the renderer's own output, which is what
    // any held frame did through presentNext(nullptr). The encode must accept that answer, not the arm site refuse it.
    int heldAsked = 0;
    {
        Renderer::PresentScope present(
            renderer, [&]() -> WGPUTextureView { ++heldAsked; return nullptr; }, format);
        CHECK(database.render(renderer, s.scene, s.camera, {0.05, 0.06, 0.08, 1}) != 0);
    }
    CHECK(heldAsked == 1);
    CHECK(database.diagnostics().empty());
    wgpuTextureViewRelease(view);
    renderer.gpu().destroy(surface);
}

// The instance storage keeps its elements between frames: N instances, then fewer, then more, must
// each draw exactly what a renderer that never saw another count draws.
void instanceCounts() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer reused(context.getInstance(), context.getDevice(), context.getQueue(), events);
    const auto configure = [](Renderer& r) {
        r.setSize(96, 72);
        r.setOutput(OutputState{shader::ToneMapping::ACESFilmic, 1, true});
    };
    configure(reused);
    Scene scene;
    PerspectiveCamera camera(50, 96.0 / 72, 0.1, 100);
    camera.position.set(0, 0, 22);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    const auto geometry = makeBoxGeometry();
    std::vector<std::shared_ptr<Mesh>> meshes;
    for (int i = 0; i < 100; ++i) {
        auto material = std::make_shared<Material>(MaterialType::Standard);
        material->color.setRGB(double(i) / 100, 0.3, 1 - double(i) / 100);
        material->roughness = i % 2 ? 0.3 : 0.8;  // two uniform groups: two instanced draws, the second at a base
        auto mesh = std::make_shared<Mesh>(geometry, material);
        mesh->position.set((i % 10 - 4.5) * 1.6, (i / 10 - 4.5) * 1.6, 0);
        scene.add(*mesh);
        meshes.push_back(mesh);
    }
    DirectionalLight light{Color().setHex(0xffffff), 3};
    light.position.set(3, 5, 8);
    scene.add(light);
    RenderDatabase reusedDb;
    for (const int count : {60, 20, 90, 100, 12, 12, 55}) {
        for (int i = 0; i < 100; ++i) meshes[i]->setVisible(i < count);
        reusedDb.render(reused, scene, camera, {0.05, 0.06, 0.08, 1});
        Renderer fresh(context.getInstance(), context.getDevice(), context.getQueue(), events);  // never saw another count
        configure(fresh);
        RenderDatabase freshDb;
        freshDb.render(fresh, scene, camera, {0.05, 0.06, 0.08, 1});
        const std::vector<uint8_t> a = read(reused, events), b = read(fresh, events);
        CHECK(a.size() == 96 * 72 * 4 && a == b);
        CHECK(reusedDb.lastBatches().second == static_cast<std::size_t>(count) && reusedDb.lastBatches().first == 2);
    }
}

// Packed frame storage is uploaded once for the bytes it holds: a frame that repeats the same
// instance matrices on the same buffer copies nothing, and a frame that moves one instance copies
// the 256-byte block that holds it once (TR1: it used to copy the whole packed array). Count and
// layout stay fixed, so only the bytes decide.
void unchangedFrameStorage() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(96, 72);
    renderer.setOutput(OutputState{shader::ToneMapping::ACESFilmic, 1, true});
    Scene scene;
    PerspectiveCamera camera(50, 96.0 / 72, 0.1, 100);
    camera.position.set(0, 0, 20);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    auto material = std::make_shared<Material>(MaterialType::Standard);
    material->roughness = 0.6;
    constexpr uint32_t count = 8, capacity = 1024;  // room to grow the destination later
    auto mesh = std::make_shared<InstancedMesh>(makeBoxGeometry(), material, capacity);
    mesh->count = count;
    mesh->frustumCulled = false;
    for (uint32_t i = 0; i < capacity; ++i) {
        Matrix4 placement;
        placement.makeTranslation(double(i % 4) * 2.0 - 3.0, double(i / 4) * 2.0 - 1.0, 0);
        mesh->setMatrixAt(i, placement);
    }
    mesh->instanceMatrix->setNeedsUpdate();
    scene.add(*mesh);
    DirectionalLight light{Color().setHex(0xffffff), 3};  // no shadows: one plain instanced draw
    light.position.set(3, 5, 8);
    scene.add(light);
    // One skinned draw on the CPU palette path: its flat palette is a storage too, and an untracked
    // bone keeps the rig out of GPU joints, so a moved bone changes bytes in `boneMatrices`.
    auto skinGeometry = makeBoxGeometry();
    const uint64_t skinVertices = skinGeometry->attributes.at("position")->count();
    skinGeometry->setAttribute("skinIndex",
        BufferAttribute::fromDoubles(Scalar::U16, std::vector<double>(skinVertices * 4, 0), 4));
    std::vector<double> skinWeights(skinVertices * 4, 0);
    for (std::size_t i = 0; i < skinVertices; ++i) skinWeights[i * 4] = 1;
    skinGeometry->setAttribute("skinWeight", BufferAttribute::fromFloats(skinWeights, 4));
    auto rig = std::make_shared<SkinnedMesh>(skinGeometry, std::make_shared<Material>(MaterialType::Standard));
    auto root = std::make_shared<Object3D>();
    auto bone = std::make_shared<Bone>();
    bone->position.set(0.3, 0.5, 0);
    root->add(*rig);
    root->add(*bone);
    scene.add(*root);
    root->updateMatrixWorld(true);
    rig->bind(std::make_shared<Skeleton>(std::vector<std::shared_ptr<Bone>>{bone}));
    RenderDatabase database;
    const auto frameUpload = [&] {
        const uint64_t before = renderer.gpu().queueWriteBytes();
        database.render(renderer, scene, camera, {0.05, 0.06, 0.08, 1});
        return renderer.gpu().queueWriteBytes() - before;
    };
    for (int warm = 0; warm < 4; ++warm) {  // capacity, storage buffers and pipelines ready
        frameUpload();
        renderer.poll();
        events.drain();
    }
    const uint64_t unchanged = frameUpload();  // same bytes, same destination
    renderer.poll();
    events.drain();
    Matrix4 moved;
    moved.makeTranslation(6, 0, 0);
    mesh->setMatrixAt(0, moved);
    mesh->instanceMatrix->setNeedsUpdate();
    const uint64_t changed = frameUpload();
    const uint64_t packed = uint64_t{count} * 20 * sizeof(float);  // matrix, colour and pad, per instance
    const uint64_t steadyMoved = frameUpload();
    mesh->count = capacity - 24;  // 1000 instances: the packed range grows past the 64 KiB buffer
    const uint64_t grown = frameUpload();
    const uint64_t grownPacked = uint64_t{capacity - 24} * 20 * sizeof(float);
    const uint64_t steadyGrown = frameUpload();
    bone->rotation.z = 0.4;  // palette bytes change, with the same bones and base
    const uint64_t palette = frameUpload();
    const uint64_t paletteBytes = 16 * sizeof(float);  // one bone's 4x4, packed as floats
    std::printf("frame storage upload: unchanged %llu, changed %llu (block %llu), grown %llu (block %llu), "
                "moved palette %llu (block %llu)\n",
                static_cast<unsigned long long>(unchanged), static_cast<unsigned long long>(changed),
                static_cast<unsigned long long>(packed), static_cast<unsigned long long>(grown),
                static_cast<unsigned long long>(grownPacked), static_cast<unsigned long long>(palette),
                static_cast<unsigned long long>(paletteBytes));
    CHECK(changed == unchanged + std::min<uint64_t>(256, packed));  // instance 0 sits in the first block
    CHECK(steadyMoved == unchanged);
    // PRD-754's main-pass rows (off by default) would also rewrite their indirect records, five words per draw.
    CHECK(grown == steadyMoved + grownPacked);
    CHECK(steadyGrown == unchanged);
    CHECK(palette == steadyGrown + paletteBytes);
}

// TR1: the `instances` storage kept each draw's instances in depth order, so a camera turn that swapped two
// draws moved both draws' bytes and the frame re-sent the whole array. A draw now keeps its place, and only the
// bytes that changed cross to the GPU. Two instanced draws, one at each side of the origin: the camera stands on
// one side (A nearer), steps a little (the control: the order holds), then crosses to the other side (B nearer).
// Every pose change rewrites the uniform arena alike, so the cross must send what the control sent.
void instanceUploadIsStableAcrossACameraTurn() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(96, 72);
    renderer.setOutput(OutputState{shader::ToneMapping::ACESFilmic, 1, true});
    Scene scene;
    PerspectiveCamera camera(50, 96.0 / 72, 0.1, 100);
    constexpr uint32_t countA = 300, countB = 200;
    const auto instanced = [&](uint32_t count, double roughness, double x) {
        auto material = std::make_shared<Material>(MaterialType::Standard);
        material->roughness = roughness;
        auto mesh = std::make_shared<InstancedMesh>(makeBoxGeometry(), material, count);
        mesh->count = count;
        mesh->frustumCulled = false;  // both draws stay in the frame whichever way the camera looks
        mesh->position.set(x, 0, 0);
        for (uint32_t i = 0; i < count; ++i) {
            Matrix4 placement;
            placement.makeTranslation(double(i % 20) * 0.2, double(i / 20) * 0.2, 0);
            mesh->setMatrixAt(i, placement);
        }
        mesh->instanceMatrix->setNeedsUpdate();
        scene.add(*mesh);
        return mesh;
    };
    const auto a = instanced(countA, 0.6, -4);
    const auto b = instanced(countB, 0.3, 4);
    DirectionalLight light{Color().setHex(0xffffff), 3};  // no shadows: two plain instanced draws
    light.position.set(3, 5, 8);
    scene.add(light);
    RenderDatabase database;
    const auto pose = [&](double x) {
        camera.position.set(x, 0, 12);
        camera.lookAt(0, 0, 0);
        camera.updateProjectionMatrix();
    };
    const auto frameUpload = [&](double x) {
        pose(x);
        const uint64_t before = renderer.gpu().queueWriteBytes();
        database.render(renderer, scene, camera, {0.05, 0.06, 0.08, 1});
        const uint64_t sent = renderer.gpu().queueWriteBytes() - before;
        renderer.poll();
        events.drain();
        return sent;
    };
    for (int warm = 0; warm < 4; ++warm) frameUpload(-12);  // capacity, storage buffers and pipelines ready
    const uint64_t still = frameUpload(-12);
    const uint64_t control = frameUpload(-12.5);  // a step: A stays nearer
    const uint64_t cross = frameUpload(12);       // B is nearer now: the order of the two draws swapped
    const uint64_t back = frameUpload(-12);       // and back
    const uint64_t packed = uint64_t{countA + countB} * 20 * sizeof(float);
    std::printf("instance upload over a camera turn: still %llu, control %llu, cross %llu, back %llu (both draws %llu)\n",
                static_cast<unsigned long long>(still), static_cast<unsigned long long>(control),
                static_cast<unsigned long long>(cross), static_cast<unsigned long long>(back),
                static_cast<unsigned long long>(packed));
    CHECK(still < control);  // a pose step does rewrite the uniform arena, so the control is a fair baseline
    CHECK(cross == control);
    CHECK(back == control);
    // Work bound: ten more swaps send what one step sends, so no slot or byte accumulates with frames.
    uint64_t total = 0;
    for (int turn = 0; turn < 10; ++turn) total += frameUpload(turn % 2 == 0 ? 12 : -12);
    CHECK(total == 10 * control);
    (void)a;
    (void)b;
}

// TR1: a draw that leaves the view keeps its place in the `instances` storage, so the draws that stay do not move and
// the draw costs nothing to come back. Two instanced draws, A nearer: B sits after A in the storage. A hidden, the old
// layout packed B to the front and re-sent it; A shown again, it re-sent both.
void instancePlacesSurviveADrawLeavingTheView() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(96, 72);
    renderer.setOutput(OutputState{shader::ToneMapping::ACESFilmic, 1, true});
    Scene scene;
    PerspectiveCamera camera(50, 96.0 / 72, 0.1, 100);
    constexpr uint32_t countA = 300, countB = 200;
    const auto instanced = [&](uint32_t count, double roughness, double x) {
        auto material = std::make_shared<Material>(MaterialType::Standard);
        material->roughness = roughness;
        auto mesh = std::make_shared<InstancedMesh>(makeBoxGeometry(), material, count);
        mesh->count = count;
        mesh->frustumCulled = false;
        mesh->position.set(x, 0, 0);
        for (uint32_t i = 0; i < count; ++i) {
            Matrix4 placement;
            placement.makeTranslation(double(i % 20) * 0.2, double(i / 20) * 0.2, 0);
            mesh->setMatrixAt(i, placement);
        }
        mesh->instanceMatrix->setNeedsUpdate();
        scene.add(*mesh);
        return mesh;
    };
    const auto a = instanced(countA, 0.6, -4);
    const auto b = instanced(countB, 0.3, 4);
    DirectionalLight light{Color().setHex(0xffffff), 3};
    light.position.set(3, 5, 8);
    scene.add(light);
    RenderDatabase database;
    const auto frameUpload = [&](double x) {  // x < 0: A is nearer, so A is drawn first and B follows it
        camera.position.set(x, 0, 12);
        camera.lookAt(0, 0, 0);
        camera.updateProjectionMatrix();
        const uint64_t before = renderer.gpu().queueWriteBytes();
        database.render(renderer, scene, camera, {0.05, 0.06, 0.08, 1});
        const uint64_t sent = renderer.gpu().queueWriteBytes() - before;
        renderer.poll();
        events.drain();
        return sent;
    };
    for (int warm = 0; warm < 4; ++warm) frameUpload(-12);
    const uint64_t control = frameUpload(-12.5);
    a->setVisible(false);
    const uint64_t hidden = frameUpload(-12);
    const uint64_t hiddenStill = frameUpload(-12.5);
    a->setVisible(true);
    const uint64_t shown = frameUpload(-12);
    const uint64_t packedA = uint64_t{countA} * 20 * sizeof(float), packedB = uint64_t{countB} * 20 * sizeof(float);
    std::printf("instance upload over a draw leaving the view: control %llu, hidden %llu, hidden still %llu, shown %llu (A %llu, B %llu)\n",
                static_cast<unsigned long long>(control), static_cast<unsigned long long>(hidden),
                static_cast<unsigned long long>(hiddenStill), static_cast<unsigned long long>(shown),
                static_cast<unsigned long long>(packedA), static_cast<unsigned long long>(packedB));
    // The uniform arena shrinks and grows with the draw count, so allow it a few blocks; B's instances are 16000 bytes.
    CHECK(hidden < packedB);
    CHECK(hiddenStill < packedB);
    CHECK(shown < packedA);
    (void)b;
}

// FM2: every draw's uniform block carries the frame's whole light and camera slab, so the plan used to
// evaluate those fields once per draw and the arena was re-uploaded in full every frame. The slab is now
// one block per program per frame, copied into each draw's slot, and the upload carries only the bytes
// that changed. Fixture: 8 boxes of one material under one sun and two point lights.
// The frame's uniform arena, the hash of its bytes and the channels a one-light channel flip moves, as the
// per-draw plan wrote them: recorded from the red run of this test, before the slab existed (FM2).
constexpr uint64_t kFrameSlabArenaBytes = 6144, kFrameSlabArenaHash = 0x81822b8c72b318c0ull;
constexpr int kFrameSlabLightFlipDiffers = 2037;
void frameSlabIsPerProgram() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(96, 96);
    renderer.setOutput(OutputState{shader::ToneMapping::ACESFilmic, 1, true});
    Scene scene;
    PerspectiveCamera camera(50, 1, 0.1, 100);
    camera.position.set(0, 0, 12);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    auto geometry = makeBoxGeometry();
    std::vector<std::shared_ptr<Mesh>> boxes;
    for (int i = 0; i < 8; ++i) {
        // A material of its own: a batch would collapse the eight draws into one, and its instance store
        // would upload every frame beside the arena this test measures.
        auto material = std::make_shared<Material>(MaterialType::Standard);
        material->roughness = 0.3 + 0.05 * i;
        auto box = std::make_shared<Mesh>(geometry, material);
        box->position.set(double(i % 4) * 1.6 - 2.4, double(i / 4) * 1.6 - 0.8, 0);
        scene.add(*box);
        boxes.push_back(box);
    }
    DirectionalLight sun{Color().setHex(0xffffff), 2.5};
    sun.position.set(3, 5, 8);
    scene.add(sun);
    PointLight lamp{Color().setHex(0xffd0a0), 30, 12};
    lamp.position.set(-3, 2, 4);
    scene.add(lamp);
    PointLight fill{Color().setHex(0x90c0ff), 20, 10};
    fill.position.set(3, -2, 4);
    scene.add(fill);
    RenderDatabase database;
    struct Frame {
        uint64_t upload = 0, evaluations = 0, uniforms = 0, hash = 0;
        uint32_t draws = 0;
    };
    const auto hashOf = [](std::span<const uint8_t> bytes) {
        uint64_t h = 0xcbf29ce484222325ull;  // FNV-1a: the arena's bytes, whatever wrote them
        for (const uint8_t byte : bytes) h = (h ^ byte) * 0x100000001b3ull;
        return h;
    };
    const auto frame = [&] {
        const uint64_t bytes = renderer.gpu().queueWriteBytes();
        const uint64_t evaluations = waste::counters().uniformFrameConstantEvaluations.load();
        database.render(renderer, scene, camera, {0.05, 0.06, 0.08, 1});
        const Frame out{renderer.gpu().queueWriteBytes() - bytes,
                        waste::counters().uniformFrameConstantEvaluations.load() - evaluations,
                        renderer.lastFrame().uniformBytes, hashOf(renderer.frameUniformBytes()),
                        renderer.lastFrame().draws};
        renderer.poll();
        events.drain();
        return out;
    };
    const auto pixels = [&] {
        std::vector<uint8_t> out;
        bool read = false;
        renderer.readPixels([&](GpuStatus status, std::vector<uint8_t> px) {
            if (status == GpuStatus::Ok) out = std::move(px);
            read = true;
        });
        for (int i = 0; i < 5000 && !read; ++i) {
            renderer.poll();
            events.drain();
            if (!read) std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
        CHECK(out.size() == size_t{96} * 96 * 4);
        return out;
    };
    const auto differing = [](const std::vector<uint8_t>& a, const std::vector<uint8_t>& b) {
        int count = 0;
        for (std::size_t i = 0; i < a.size() && i < b.size(); ++i) count += a[i] != b[i];
        return count;
    };
    const auto pose = [&](double x) {
        camera.position.set(x, 0.2, 12);
        camera.lookAt(0, 0, 0);
        camera.updateProjectionMatrix();
    };
    for (int warm = 0; warm < 4; ++warm) frame();  // programs, pipelines and the arena's slots
    // (a) a still frame with a moving camera: the arena is the one the per-draw plan wrote, byte for byte,
    // and no larger. The red run of this test recorded both.
    pose(0.4);
    const Frame moved = frame();
    std::printf("frame slab: arena %llu bytes %016llx, %u draws, %llu frame-constant evaluations "
                "(%llu upload), still %llu upload\n",
                static_cast<unsigned long long>(moved.uniforms), static_cast<unsigned long long>(moved.hash),
                moved.draws, static_cast<unsigned long long>(moved.evaluations),
                static_cast<unsigned long long>(moved.upload), static_cast<unsigned long long>(frame().upload));
    CHECK(moved.draws > 1);
    CHECK(moved.uniforms <= kFrameSlabArenaBytes);
    CHECK(moved.hash == kFrameSlabArenaHash);
    // (b) the light and camera fields are evaluated once per program, not once per draw: one draw and eight
    // draws of the same program cost the same.
    const Frame eight = frame();
    for (std::size_t i = 1; i < boxes.size(); ++i) boxes[i]->setVisible(false);
    const Frame one = frame();
    std::printf("frame slab: %llu evaluations for %u draws, %llu for %u draw\n",
                static_cast<unsigned long long>(eight.evaluations), eight.draws,
                static_cast<unsigned long long>(one.evaluations), one.draws);
    CHECK(one.draws < eight.draws);
    CHECK(eight.evaluations > 0);
    CHECK(eight.evaluations == one.evaluations);
    // (c) a frame where neither the camera nor an object moved uploads nothing: the arena's bytes are the ones
    // the GPU holds. A frame whose camera moved still rewrites every slot (the view is in each draw's block), so
    // its upload stays the arena's size; the still frame is the arena's worth fewer than it.
    const Frame still = frame();
    const Frame stillAgain = frame();
    std::printf("frame slab: still frames upload %llu and %llu bytes, a moved camera %llu of %llu\n",
                static_cast<unsigned long long>(still.upload), static_cast<unsigned long long>(stillAgain.upload),
                static_cast<unsigned long long>(moved.upload), static_cast<unsigned long long>(moved.uniforms));
    CHECK(still.upload <= moved.upload - moved.uniforms);
    CHECK(stillAgain.upload == still.upload);
    CHECK(moved.upload <= moved.uniforms + still.upload);
    // (d) the same pose reaches the same pixels however the frame got there, and a light's channel flip moves
    // as many of them from a still arm as from a moved one: a stale slab would show here.
    for (auto& box : boxes) box->setVisible(true);
    pose(0.4);
    frame();
    frame();
    const std::vector<uint8_t> stillPixels = pixels();
    pose(-2.5);
    frame();
    pose(0.4);
    frame();
    frame();
    const std::vector<uint8_t> arrived = pixels();
    std::printf("frame slab: the same pose from two paths differs on %d channels\n",
                differing(stillPixels, arrived));
    CHECK(differing(stillPixels, arrived) == 0);
    lamp.color.setRGB(0.2, 0.4, 1.0);
    const Frame flipUpload = frame();  // one light's fields moved: the upload is their blocks, not the arena
    const std::vector<uint8_t> stillFlip = pixels();
    lamp.color.setHex(0xffd0a0);
    pose(-2.5);
    frame();
    pose(0.4);
    frame();
    frame();
    lamp.color.setRGB(0.2, 0.4, 1.0);
    frame();
    const std::vector<uint8_t> movedFlip = pixels();
    const int stillDiffers = differing(stillPixels, stillFlip), movedDiffers = differing(arrived, movedFlip);
    std::printf("frame slab: a one-light channel flip moves %d channels still, %d moved, and uploads %llu of "
                "%llu arena bytes\n",
                stillDiffers, movedDiffers, static_cast<unsigned long long>(flipUpload.upload),
                static_cast<unsigned long long>(flipUpload.uniforms));
    CHECK(stillDiffers > 0);
    CHECK(stillDiffers == movedDiffers);
    CHECK(stillDiffers == kFrameSlabLightFlipDiffers);
}

// The flat lane's compact fast path (RenderDatabase::projectCompact) must decide exactly what the
// general project() decides. The same population, flat and then made non-flat by one parented
// object, must give the same draws: hidden, other-layer, transparent, mirrored, callback and
// ordinary batching meshes alike.
bool sameFloats(const void* a, const void* b, std::size_t bytes) {
    const auto* x = static_cast<const float*>(a);
    const auto* y = static_cast<const float*>(b);
    for (std::size_t i = 0; i < bytes / sizeof(float); ++i)
        if (x[i] != y[i]) return false;  // numeric: the two lanes may differ in the sign of a zero
    return true;
}

void flatLaneEquivalence() {
    struct Population {
        Scene scene;
        Object3D parent, child;  // only the non-flat variant attaches them
        std::vector<std::shared_ptr<Mesh>> meshes;
        std::shared_ptr<BufferGeometry> geometry = makeBoxGeometry();
        explicit Population(bool flat) {
            for (int i = 0; i < 96; ++i) {
                auto material = std::make_shared<Material>(MaterialType::Standard);
                material->color.setRGB(double(i) / 96, 0.4, 0.2);
                material->roughness = i % 5 == 0 ? 0.5 : 0.75;  // two uniform groups
                material->transparent = i % 9 == 0;
                auto mesh = std::make_shared<Mesh>(geometry, material);
                mesh->position.set((i % 12 - 5.5) * 1.7, (i / 12 - 3.5) * 1.7, -double(i % 7));
                if (i % 10 == 0) mesh->scale.x = -1;  // mirrored: negative determinant
                if (i % 11 == 0) mesh->setLayerMask(2);  // not on the camera's layer
                if (i % 8 == 1) mesh->setVisible(false);
                if (i % 13 == 2)
                    mesh->onBeforeRender = std::make_shared<const std::function<bool(const RenderCallbackArgs&, std::string&)>>(
                        [](const RenderCallbackArgs&, std::string&) { return true; });
                scene.add(*mesh);
                meshes.push_back(mesh);
            }
            if (!flat) {
                parent.add(child);
                scene.add(parent);
            }
        }
    };
    PerspectiveCamera camera(50, 4.0 / 3, 0.1, 100);
    camera.position.set(0, 0, 24);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    Population flatScene(true), generalScene(false);
    RenderDatabase flatDb, generalDb;
    for (int frame = 0; frame < 3; ++frame) {
        for (auto* population : {&flatScene, &generalScene})
            for (std::size_t i = 0; i < population->meshes.size(); ++i)
                population->meshes[i]->position.y += 0.05 * double(i % 4);  // they move, records stay
        LightState flatLights, generalLights;
        const auto flatItems = flatDb.prepare(flatScene.scene, camera, flatLights);
        auto generalItems = generalDb.prepare(generalScene.scene, camera, generalLights);
        CHECK(flatDb.diagnostics().empty() && generalDb.diagnostics().empty());
        CHECK(flatItems.size() == generalItems.size() && flatItems.size() > 3);
        CHECK(flatDb.lastBatches() == generalDb.lastBatches());
        CHECK(flatDb.rebuilds() == generalDb.rebuilds());
        for (std::size_t i = 0; i < std::min(flatItems.size(), generalItems.size()); ++i) {
            const DrawItem &a = flatItems[i], &b = generalItems[i];
            CHECK(a.instanceCount == b.instanceCount && a.transparent == b.transparent && a.matrixWorld == b.matrixWorld);
            CHECK(a.material->roughness == b.material->roughness && a.material->color == b.material->color);
            CHECK((a.instanceMatrices == nullptr) == (b.instanceMatrices == nullptr));
            if (a.instanceMatrices && b.instanceMatrices) {
                CHECK(a.instanceMatrices->byteLength() == b.instanceMatrices->byteLength());
                CHECK(sameFloats(a.instanceMatrices->data(), b.instanceMatrices->data(), a.instanceMatrices->byteLength()));
            }
            CHECK((a.instanceColors == nullptr) == (b.instanceColors == nullptr));
            if (a.instanceColors && b.instanceColors) {
                CHECK(a.instanceColors->byteLength() == b.instanceColors->byteLength());
                CHECK(sameFloats(a.instanceColors->data(), b.instanceColors->data(), a.instanceColors->byteLength()));
            }
        }
    }
}

// @invariant clip positions are asked for only by a frame that draws a second pipeline depth-Equal
// against the colour pass. Plain frames compile as three's do; under TRAA the colour programs and the
// velocity program are flagged together, and a program built before the toggle is not rebuilt in place.
void invariantScope() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(64, 48);
    LitScene s;
    s.light.setCastShadow(true);  // a shadow depth program exists beside the colour program
    s.mesh.setCastShadow(true);
    RenderDatabase database;
    database.shadowMapEnabled = true;
    const auto flagged = [](const std::string& source) { return source.find("@invariant") != std::string::npos; };
    database.render(renderer, s.scene, s.camera);
    const auto plain = renderer.programVertexSources();
    CHECK(!plain.empty());
    for (const auto& [key, source] : plain) CHECK(!flagged(source));
    CHECK(std::any_of(plain.begin(), plain.end(), [](const auto& p) { return p.first.rfind("depth|", 0) == 0; }));
    renderer.setTraa(TraaOptions{});
    database.render(renderer, s.scene, s.camera);
    std::size_t colour = 0, velocity = 0;
    for (const auto& [key, source] : renderer.programVertexSources()) {
        const bool before = std::any_of(plain.begin(), plain.end(), [&](const auto& p) { return p.first == key; });
        if (key.starts_with("traa-velocity|")) { ++velocity; CHECK(flagged(source)); }
        else if (key.rfind("depth|", 0) == 0) CHECK(!flagged(source));  // the shadow depth program shares its stage with nothing, TRAA or not
        else if (before) CHECK(!flagged(source));                         // built by the plain frame, untouched
        else { ++colour; CHECK(flagged(source)); }
    }
    CHECK(velocity == 1 && colour >= 1);  // the TRAA frame built its own flagged colour program beside the plain one
    // A steady TRAA frame makes no bind group: the velocity fill and the resolve made one each a frame before.
    database.render(renderer, s.scene, s.camera);
    const uint64_t groups = bindGroupsCreated();
    database.render(renderer, s.scene, s.camera);
    database.render(renderer, s.scene, s.camera);
    CHECK(bindGroupsCreated() == groups);
}

void directionalTarget() {
    Scene scene;
    PerspectiveCamera camera;
    DirectionalLight light;
    light.position.set(0, 3, 0);
    light.setCastShadow(true);
    scene.add(light);
    Object3D parent;
    parent.position.x = 1;
    parent.add(*light.target);
    scene.add(parent);
    light.target->position.x = 2;
    RenderDatabase database;
    database.shadowMapEnabled = true;
    LightState lights;
    database.prepare(scene, camera, lights);
    CHECK(lights.direct.size() == 1);
    if (lights.direct.empty()) return;
    CHECK(light.target->matrixWorld.elements[12] == 3);
    const double axis = 1 / std::sqrt(2.0);
    CHECK(std::abs(lights.direct[0].direction[0] + axis) < 1e-12);
    CHECK(std::abs(lights.direct[0].direction[1] - axis) < 1e-12);
    Vector3 direction;
    light.shadow.camera->getWorldDirection(direction);
    CHECK(std::abs(direction.x - axis) < 1e-12 && std::abs(direction.y + axis) < 1e-12);
    light.target->matrixWorldAutoUpdate = false;
    light.target->matrixWorld.makeTranslation(0, 1, 0);
    light.target->position.x = 10;
    database.prepare(scene, camera, lights);
    CHECK(lights.direct[0].direction[0] == 0 && lights.direct[0].direction[1] == 1);
}

// PRD-617: three reads `light.target.matrixWorld` as it stands, and only a scene traversal refreshes it. A
// target the game never added to the scene stays at the origin whatever its position says: the racing
// template's sun moves `key.target.position` with the car and, on stock three, still points at the origin.
void directionalTargetOutsideScene() {
    Scene scene;
    PerspectiveCamera camera;
    DirectionalLight light;
    light.position.set(30, 40, 0);
    light.setCastShadow(true);
    scene.add(light);
    light.target->position.set(30, 0, 0);
    RenderDatabase database;
    database.shadowMapEnabled = true;
    LightState lights;
    database.prepare(scene, camera, lights);
    CHECK(lights.direct.size() == 1);
    if (lights.direct.empty()) return;
    CHECK(light.target->matrixWorld.elements[12] == 0);
    CHECK(std::abs(lights.direct[0].direction[0] - 0.6) < 1e-12);
    CHECK(std::abs(lights.direct[0].direction[1] - 0.8) < 1e-12);
    Vector3 direction;
    light.shadow.camera->getWorldDirection(direction);
    CHECK(std::abs(direction.x + 0.6) < 1e-12 && std::abs(direction.y + 0.8) < 1e-12);
    // In the scene, the same position is honoured: the sun now points straight down from the target.
    scene.add(*light.target);
    database.prepare(scene, camera, lights);
    CHECK(std::abs(lights.direct[0].direction[0]) < 1e-12 && std::abs(lights.direct[0].direction[1] - 1) < 1e-12);
}

// PRD-617: three applies `scene.fogNode` in place of `scene.fog`, to every material that takes fog. The draw
// item carries the node and no fog record, so the program mixes the node's colour and factor, not fogColor.
void sceneFogNode() {
    RenderDatabase database;
    Scene scene; PerspectiveCamera camera(55, 4.0 / 3, 0.1, 100); camera.position.set(1, 2, 6);
    LightState lights;
    auto material = std::make_shared<Material>(MaterialType::Standard);
    auto mesh = std::make_shared<Mesh>(makeSphereGeometry(), material); scene.add(*mesh);
    scene.fog = std::make_shared<FogExp2>(Color(0.1, 0.4, 0.8), 0.003);
    scene.fogNode = shader::graph::vec4({shader::graph::uniform("hazeColor", shader::Type::vec(3), {0.1, 0.2, 0.3}), shader::graph::float_(0.5)});
    auto draws = database.prepare(scene, camera, lights);
    CHECK(draws.size() == 1); if (draws.size() != 1) return;
    CHECK(draws[0].nodes->fogNode == scene.fogNode && !draws[0].fog);
    material->fog = false;
    draws = database.prepare(scene, camera, lights);
    CHECK(!draws[0].nodes->fogNode && !draws[0].fog);
    material->fog = true; scene.fogNode = nullptr;
    draws = database.prepare(scene, camera, lights);
    CHECK(!draws[0].nodes->fogNode && draws[0].fog == scene.fog.get());
}

// three draws a lit mesh whose geometry has no `normal` attribute: Normal.js supplies (0, 1, 0), and
// getGeometryRoughness returns zero. The draw item carries that fallback per vertex, including for the sailing sea.
void litMeshWithoutNormals() {
    RenderDatabase database;
    Scene scene; PerspectiveCamera camera(55, 4.0 / 3, 0.1, 100); camera.position.set(1, 2, 6);
    LightState lights;
    auto geometry = makeSphereGeometry();
    const uint64_t vertices = geometry->attributes.at("position")->count();
    geometry->attributes.erase("normal");
    auto material = std::make_shared<Material>(MaterialType::Standard);
    auto mesh = std::make_shared<Mesh>(geometry, material); scene.add(*mesh);
    auto draws = database.prepare(scene, camera, lights);
    CHECK(draws.size() == 1); if (draws.size() != 1) return;
    CHECK(draws[0].normals != nullptr);
    if (draws[0].normals == nullptr) return;
    CHECK(draws[0].normals->scalar() == Scalar::F32);
    CHECK(draws[0].normals->count() == vertices * 3);
    std::array<float, 3> normal{};
    for (uint64_t vertex = 0; vertex < vertices; ++vertex) {
        draws[0].normals->read(vertex * 3 * sizeof(float), normal.data(), sizeof normal);
        CHECK(normal[0] == 0 && normal[1] == 1 && normal[2] == 0);
    }
}

void invalidation() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(64, 48);
    LitScene s;
    RenderDatabase database;
    database.render(renderer, s.scene, s.camera);
    const uint64_t first = database.rebuilds();
    CHECK(first == 1);
    auto& diagnostic = Material::diagnostics();
    const auto savedDiagnostic = diagnostic;
    diagnostic = {};

    for (int frame = 0; frame < 300; ++frame) database.render(renderer, s.scene, s.camera);
    CHECK(database.rebuilds() == first);  // an unchanged scene rebuilds nothing
    s.mesh.position.x = 0.5;  // a transform: the mesh's revision moves on the next updateMatrixWorld
    database.render(renderer, s.scene, s.camera);
    CHECK(database.rebuilds() == first);
    s.material->color.setRGB(0, 1, 0);
    s.material->needsUpdate();  // three's material.needsUpdate = true
    database.render(renderer, s.scene, s.camera);
    CHECK(database.rebuilds() == first + 1);
    s.scene.remove(s.mesh);  // a mesh that leaves the scene leaves the database
    database.render(renderer, s.scene, s.camera);
    s.scene.add(s.mesh);
    database.render(renderer, s.scene, s.camera);
    CHECK(database.rebuilds() == first + 2);
    for (int frame = 0; frame < 300; ++frame) database.render(renderer, s.scene, s.camera);
    CHECK(database.rebuilds() == first + 2);
    CHECK(diagnostic.recordRebuilds == 0 && diagnostic.graphRebuilds == 0);
    diagnostic.enabled = true;
    Mesh shared(s.mesh.geometry, s.material);
    s.scene.add(shared);
    RenderDatabase observed;
    observed.render(renderer, s.scene, s.camera);
    CHECK(diagnostic.recordRebuilds == observed.rebuilds() && diagnostic.recordRebuilds == 2);
    const auto rebuilt = diagnostic.recordRebuilds;
    s.material->needsUpdate();
    observed.render(renderer, s.scene, s.camera);
    CHECK(diagnostic.recordRebuilds == rebuilt + 2);
    CHECK(!diagnostic.threadCpuSupported || diagnostic.recordCpuNs > 0);
    diagnostic = savedDiagnostic;
}

// The alpha-transparency fixture as a scene: an OrthographicCamera, so WebGL clip z would put every
// plane behind the near plane — the WebGPU switch render() makes is what keeps them on screen —
// and transparent meshes sorted back to front by depth, renderOrder and Object3D.id.
void alphaScene() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(256, 128);
    Scene scene;
    OrthographicCamera camera(-2, 2, 1, -1, 0.1, 10);
    camera.position.z = 5;
    const auto big = makePlaneGeometry(1.6, 1.6), small = makePlaneGeometry(1, 1);
    struct Spec {
        std::shared_ptr<BufferGeometry> geometry;
        double r, g, b;
        bool transparent;
        double opacity, x, z;
        int renderOrder;
    };
    const Spec specs[] = {{big, 0, 0, 1, true, 0.5, 0.2, 0.5, 0},       {big, 0, 1, 0, true, 0.5, -0.3, 0, 0},
                          {big, 1, 0, 0, false, 1, -0.8, -0.5, 0},       {small, 1, 0, 1, true, 0.6, 1.35, -0.4, 2},
                          {small, 1, 1, 0, true, 0.6, 1.0, 0.4, 1}};
    std::vector<std::shared_ptr<Material>> materials;
    std::vector<std::unique_ptr<Mesh>> meshes;
    for (const Spec& s : specs) {
        materials.push_back(std::make_shared<Material>(MaterialType::Basic));
        Material& m = *materials.back();
        m.color.setRGB(s.r, s.g, s.b);
        m.transparent = s.transparent;
        m.opacity = s.opacity;
        meshes.push_back(std::make_unique<Mesh>(s.geometry, materials.back()));
        Mesh& mesh = *meshes.back();
        mesh.position.x = s.x;
        mesh.position.z = s.z;
        mesh.setRenderOrder(s.renderOrder);
        scene.add(mesh);
    }
    RenderDatabase database;
    database.render(renderer, scene, camera, {0.1, 0.1, 0.1, 1});
    const std::vector<uint8_t> px = read(renderer, events);
    const std::string png = std::string(TN_GOLDENS_DIR) + "/alpha-transparency.png";
    int w = 0, h = 0, c = 0;
    unsigned char* golden = stbi_load(png.c_str(), &w, &h, &c, 4);
    CHECK(golden && w == 256 && h == 128 && px.size() == 256 * 128 * 4);
    if (!golden || px.size() != 256 * 128 * 4) return;
    int worst = 0;
    for (size_t i = 0; i < px.size(); i += 4)
        for (int k = 0; k < 3; ++k) worst = std::max(worst, std::abs(int(px[i + k]) - int(golden[i + k])));
    stbi_image_free(golden);
    std::printf("scene alpha-transparency vs browser: worst %d\n", worst);
    CHECK(worst <= 1);
}

// An unported material property is refused by name and its mesh is not drawn, never silently drawn
// with a simpler shader (PRD-514 decision 4); a supported material in the same scene still draws.
void materialUnsupported() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(64, 48);
    LitScene s;
    auto sheened = std::make_shared<Material>(MaterialType::Physical);
    sheened->sheen = 0.5;
    Mesh refused{s.geometry, sheened};
    refused.position.x = 1;
    s.scene.add(refused);
    RenderDatabase database;
    database.render(renderer, s.scene, s.camera);
    bool named = false;
    for (const std::string& d : database.diagnostics()) {
        std::fprintf(stderr, "%s\n", d.c_str());
        named = named || (d.rfind("TN_NATIVE_MATERIAL_UNSUPPORTED MeshPhysicalMaterial", 0) == 0 && d.find("sheen") != std::string::npos);
    }
    CHECK(named);
    CHECK(database.diagnostics().size() == 1);  // the standard mesh beside it is not refused
}

// A material whose program cannot be built is refused by name and skipped, every frame it is drawn,
// and the rest of the frame still draws, as three logs a shader error and draws the rest of the scene.
// Two ways to fail: a type error leaves construction diagnostics, a varying conflict throws.
void shaderInvalid() {
    namespace g = shader::graph;
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(64, 48);
    LitScene s;
    auto typed = std::make_shared<Material>(MaterialType::Standard);
    typed->nodes.colorNode = g::add(g::vec4({g::float_(1), g::float_(0), g::float_(0), g::float_(1)}),
                                    g::vec2({g::float_(1), g::float_(1)}));
    auto clashing = std::make_shared<Material>(MaterialType::Basic);
    const auto position = g::positionLocal();
    clashing->nodes.colorNode = g::vec4({g::add(g::varying(position, "dup"), g::varying(g::mul(position, g::float_(2)), "dup")),
                                         g::float_(1)});
    Mesh typedMesh{s.geometry, typed}, clashingMesh{s.geometry, clashing};
    typedMesh.position.x = 1.5;
    clashingMesh.position.x = -1.5;
    s.scene.add(typedMesh);
    s.scene.add(clashingMesh);
    RenderDatabase database;
    for (int frame = 0; frame < 2; ++frame) {
        database.render(renderer, s.scene, s.camera);
        int refused = 0;
        bool reasons = false;
        for (const std::string& d : renderer.diagnostics()) {
            if (d.rfind("TN_NATIVE_SHADER_INVALID: material program", 0) != 0) continue;
            ++refused;
            reasons = reasons || d.find("TN_TSL_TYPE") != std::string::npos;
        }
        CHECK(refused == 2 && reasons);
        CHECK(database.diagnostics().empty());
    }
    std::vector<uint8_t> pixels;
    bool read = false;
    renderer.readPixels([&](GpuStatus status, std::vector<uint8_t> px) {
        if (status == GpuStatus::Ok) pixels = std::move(px);
        read = true;
    });
    for (int i = 0; i < 5000 && !read; ++i) {
        renderer.poll();
        events.drain();
        if (!read) std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    // The valid sphere at the centre still draws: its pixel is not the clear colour.
    const size_t centre = (size_t{24} * 64 + 32) * 4;
    CHECK(pixels.size() == size_t{64} * 48 * 4 && (pixels[centre] | pixels[centre + 1] | pixels[centre + 2]) != 0);
}

// three's TSL `time` is the renderer's elapsed seconds, refreshed every frame (PRD-547): a colour that
// reads it changes between two frames drawn 120 ms apart.
void timeUniform() {
    namespace g = shader::graph;
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(64, 48);
    LitScene s;
    auto pulse = std::make_shared<Material>(MaterialType::Basic);
    const auto time = g::uniform("time", shader::Type::f32());  // the shared TSL table's `time`
    pulse->nodes.colorNode = g::vec4({g::fract(g::mul(time, g::float_(10))), g::float_(0), g::float_(0), g::float_(1)});
    s.mesh.material = pulse;
    RenderDatabase database;
    const auto red = [&] {
        database.render(renderer, s.scene, s.camera);
        std::vector<uint8_t> pixels;
        bool read = false;
        renderer.readPixels([&](GpuStatus status, std::vector<uint8_t> px) {
            if (status == GpuStatus::Ok) pixels = std::move(px);
            read = true;
        });
        for (int i = 0; i < 5000 && !read; ++i) {
            renderer.poll();
            events.drain();
            if (!read) std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
        CHECK(pixels.size() == size_t{64} * 48 * 4);
        return pixels[(size_t{24} * 64 + 32) * 4];
    };
    const uint8_t first = red();
    std::this_thread::sleep_for(std::chrono::milliseconds(120));
    const uint8_t second = red();
    std::fprintf(stderr, "time uniform: red %u then %u\n", unsigned(first), unsigned(second));
    CHECK(first != second);
}

// A FloatType target keeps float32: auto exposure feeds its last value back through one, and a half
// float rounded each frame stalled the adaptation 0.006 to 0.009 stops short of its target. A device
// without float32-blendable stores it as half instead (blending into RGBA32Float would fail validation),
// reports that on the target, and a read still returns float32 rows.
void drawFloatTarget(bool forceHalf) {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.forceHalfFloatTargets(forceHalf);
    renderer.setSize(64, 64);
    const bool expectFloat32 = !forceHalf && wgpuDeviceHasFeature(context.getDevice(), WGPUFeatureName_Float32Blendable);
    const auto target = RenderTarget::make(4, 4, kTextureFloatType);
    Scene inner;
    OrthographicCamera innerCamera(-1, 1, 1, -1, 0.1, 10);
    innerCamera.position.z = 5;
    innerCamera.updateMatrixWorld();
    // A half-transparent blue square over the whole target: a blended draw into the FloatType target.
    auto blue = std::make_shared<Material>(MaterialType::Basic);
    blue->color.setRGB(0, 0, 1);
    blue->transparent = true;
    blue->opacity = 0.5;
    Mesh square(makePlaneGeometry(4, 4), blue);
    inner.add(square);
    inner.updateMatrixWorld(true);
    // 1 + 2^-12 and 2^-12 + 2^-24 need more than half float's 11 significant bits.
    const double high = 1.0 + std::ldexp(1.0, -12), low = std::ldexp(1.0, -12) + std::ldexp(1.0, -24);
    CHECK(renderToTarget(renderer, *target, inner, innerCamera, {high, low, 0.5, 1}, false).empty());
    CHECK(target->halfPrecision == !expectFloat32);
    std::vector<uint8_t> region;
    bool done = false;
    CHECK(readRenderTarget(*target, 0, 0, 4, 4, [&](GpuStatus status, std::vector<uint8_t> bytes) {
        CHECK(status == GpuStatus::Ok);
        region = std::move(bytes);
        done = true;
    }) == GpuStatus::Ok);
    for (int i = 0; i < 5000 && !done; ++i) {
        renderer.poll();
        events.drain();
        if (!done) std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    CHECK(region.size() == size_t{4} * 4 * 16);  // float32 rows either way
    if (region.size() == size_t{4} * 4 * 16) {
        float texel[4];
        std::memcpy(texel, region.data() + (size_t{1} * 4 + 1) * 16, sizeof texel);
        std::fprintf(stderr, "float target (%s): %.9g %.9g %.9g\n", expectFloat32 ? "float32" : "half", texel[0], texel[1], texel[2]);
        // Half-opaque blue over (high, low, 0.5): red and green keep half of the clear, blue mixes toward 1.
        const float red = float(high) * 0.5f, green = float(low) * 0.5f, blueMix = 0.75f;
        const float tolerance = expectFloat32 ? 1e-6f : 2e-3f;
        CHECK(std::abs(texel[0] - red) <= tolerance && std::abs(texel[1] - green) <= tolerance &&
              std::abs(texel[2] - blueMix) <= tolerance);
        if (expectFloat32) CHECK(texel[0] == red);  // the half rounding of 1 + 2^-12 halved would differ
    }
}

void floatRenderTargetKeepsFloat32() { drawFloatTarget(false); }
void floatRenderTargetFallsBackToHalf() { drawFloatTarget(true); }

// PRD-551: a game's RenderTarget. A render into it writes the linear scene colour (no tone mapping, no
// output transform, as r185 writes a target); readRenderTarget returns a region of it; a material whose
// map is `target.texture` samples it; and a frame that renders the target and then the scene adds no
// setup work after warm-up.
float halfToFloat(uint16_t h) {
    const uint32_t sign = (h >> 15) & 1, exponent = (h >> 10) & 31, mantissa = h & 1023;
    float value = exponent == 0 ? std::ldexp(float(mantissa), -24)
                : exponent == 31 ? std::numeric_limits<float>::infinity()
                                 : std::ldexp(float(mantissa | 1024), int(exponent) - 25);
    return sign ? -value : value;
}

void renderTarget() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(64, 64);
    renderer.setOutput(OutputState{std::nullopt, 1, false});  // linear out: the bytes are the sampled values
    // The target's scene: cleared to (0.25, 0.5, 0.75), with an unlit red square over its middle half.
    const auto target = RenderTarget::make(32, 32, kTextureHalfFloatType);
    Scene inner;
    OrthographicCamera innerCamera(-1, 1, 1, -1, 0.1, 10);
    innerCamera.position.z = 5;
    innerCamera.updateMatrixWorld();
    auto red = std::make_shared<Material>(MaterialType::Basic);
    red->color.setRGB(1, 0, 0);
    Mesh square(makePlaneGeometry(1, 1), red);
    inner.add(square);
    inner.updateMatrixWorld(true);
    // The main scene: one plane filling the view, mapped with the target's texture.
    Scene scene;
    OrthographicCamera camera(-1, 1, 1, -1, 0.1, 10);
    camera.position.z = 5;
    camera.updateMatrixWorld();
    auto mapped = std::make_shared<Material>(MaterialType::Basic);
    mapped->maps["map"] = target->texture;
    Mesh plane(makePlaneGeometry(2, 2), mapped);
    scene.add(plane);
    scene.updateMatrixWorld(true);
    RenderDatabase database;
    const auto frame = [&] {
        const uint64_t outputs = outputPassesRecorded();
        const auto refused = renderToTarget(renderer, *target, inner, innerCamera, {0.25, 0.5, 0.75, 1}, false);
        CHECK(refused.empty());
        // The target is read as linear scene colour: a tone-mapped output image of it would be drawn and never read.
        CHECK(outputPassesRecorded() == outputs);
        database.render(renderer, scene, camera, {0, 0, 0, 1});
        CHECK(outputPassesRecorded() == outputs + 1);
    };
    frame();
    // The target's own pixels: a corner is the clear colour, the middle is the red square.
    std::vector<uint8_t> region;
    bool done = false;
    CHECK(readRenderTarget(*target, 0, 0, 32, 32, [&](GpuStatus status, std::vector<uint8_t> bytes) {
        CHECK(status == GpuStatus::Ok);
        region = std::move(bytes);
        done = true;
    }) == GpuStatus::Ok);
    for (int i = 0; i < 5000 && !done; ++i) {
        renderer.poll();
        events.drain();
        if (!done) std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    CHECK(region.size() == size_t{32} * 32 * 8);
    const auto texel = [&](uint32_t x, uint32_t y, int channel) {
        uint16_t bits = 0;
        std::memcpy(&bits, region.data() + (size_t(y) * 32 + x) * 8 + channel * 2, 2);
        return halfToFloat(bits);
    };
    if (region.size() == size_t{32} * 32 * 8) {
        std::fprintf(stderr, "render target: corner %.3f %.3f %.3f, middle %.3f %.3f %.3f\n", texel(1, 1, 0),
                     texel(1, 1, 1), texel(1, 1, 2), texel(16, 16, 0), texel(16, 16, 1), texel(16, 16, 2));
        CHECK(std::abs(texel(1, 1, 0) - 0.25f) < 1e-3f && std::abs(texel(1, 1, 1) - 0.5f) < 1e-3f &&
              std::abs(texel(1, 1, 2) - 0.75f) < 1e-3f);
        CHECK(texel(16, 16, 0) == 1.0f && texel(16, 16, 1) == 0.0f && texel(16, 16, 2) == 0.0f);
    }
    // The main frame samples it: the plane's middle is red, its corner the clear colour.
    const std::vector<uint8_t> px = read(renderer, events);
    CHECK(px.size() == size_t{64} * 64 * 4);
    if (px.size() == size_t{64} * 64 * 4) {
        const auto at = [&](int x, int y, int c) { return int(px[(size_t(y) * 64 + x) * 4 + c]); };
        std::fprintf(stderr, "sampled: corner %d %d %d, middle %d %d %d\n", at(2, 2, 0), at(2, 2, 1), at(2, 2, 2),
                     at(32, 32, 0), at(32, 32, 1), at(32, 32, 2));
        CHECK(std::abs(at(2, 2, 0) - 64) <= 1 && std::abs(at(2, 2, 1) - 128) <= 1 && std::abs(at(2, 2, 2) - 191) <= 1);
        CHECK(at(32, 32, 0) == 255 && at(32, 32, 1) == 0 && at(32, 32, 2) == 0);
    }
    // Steady: the target and the frame that samples it add no setup work after warm-up.
    for (int i = 0; i < 3; ++i) frame();
    const auto compiles = renderer.pipelines().compiles(), texts = renderer.pipelines().textLookups();
    const auto groups = bindGroupsCreated(), programs = renderer.programCount();
    for (int i = 0; i < 30; ++i) frame();
    std::fprintf(stderr, "render target steady over 30 frames: compiles +%llu, text keys +%llu, bind groups +%llu, programs +%zu\n",
                 (unsigned long long)(renderer.pipelines().compiles() - compiles),
                 (unsigned long long)(renderer.pipelines().textLookups() - texts),
                 (unsigned long long)(bindGroupsCreated() - groups), renderer.programCount() - programs);
    CHECK(renderer.pipelines().compiles() == compiles && renderer.pipelines().textLookups() == texts);
    CHECK(bindGroupsCreated() == groups && renderer.programCount() == programs);
    // A geometry the target and the frame both draw has one GPU copy, as three's one renderer
    // keeps: the target's pass uploads it into the renderer's cache, and the frame reuses it. A
    // copy per pass doubled Midway's hull and water-reflected geometry (PRD-553: 104 MB).
    auto green = std::make_shared<Material>(MaterialType::Basic);
    green->color.setRGB(0, 1, 0);
    const auto both = makePlaneGeometry(0.25, 0.25);
    Mesh inTarget(both, green), inFrame(both, green);
    inner.add(inTarget);
    scene.add(inFrame);
    inner.updateMatrixWorld(true);
    scene.updateMatrixWorld(true);
    const uint64_t before = renderer.geometry().stats().fullUploads;
    CHECK(renderToTarget(renderer, *target, inner, innerCamera, {0.25, 0.5, 0.75, 1}, false).empty());
    const uint64_t afterTarget = renderer.geometry().stats().fullUploads;
    database.render(renderer, scene, camera, {0, 0, 0, 1});
    std::fprintf(stderr, "render target geometry: full uploads %llu -> %llu (target) -> %llu (frame)\n",
                 (unsigned long long)before, (unsigned long long)afterTarget,
                 (unsigned long long)renderer.geometry().stats().fullUploads);
    CHECK(afterTarget > before);
    CHECK(renderer.geometry().stats().fullUploads == afterTarget);
    // PRD-617: scheduled and manual RTT draws must share the target, including a frozen frame.
    namespace g = shader::graph;
    const auto live = g::uniform("rttColour", shader::Type::vec(4), {0.25f, 0.5f, 0.75f, 1});
    auto rtt = std::make_shared<g::NodeData>();
    rtt->kind = g::Kind::RenderTexture;
    rtt->type = shader::Type::vec(4);
    rtt->name = "rtt_lifecycle";
    rtt->args = {live, g::uv()};
    rtt->rtt = std::make_shared<g::RttState>();
    auto& state = *rtt->rtt;
    state.width = state.height = 32;
    state.autoUpdate = false;
    state.target = target;
    state.source = live;
    state.quad = std::make_shared<Mesh>(makePlaneGeometry(2, 2), std::make_shared<Material>(MaterialType::Basic, true));
    state.material = state.quad->material;
    state.material->rawNodeMaterial = true;
    state.material->nodes.fragmentNode = live;
    renderer.setPostGraph(rtt);
    const auto rttFrame = [&] {
        renderer.render({}, CameraState{}, LightState{}, {0, 0, 0, 1});
        const auto bytes = read(renderer, events);
        CHECK(bytes.size() == 64 * 64 * 4);
        return bytes.size() == 64 * 64 * 4 ? bytes[(32 * 64 + 32) * 4] : 0;
    };
    CHECK(std::abs(int(rttFrame()) - 64) <= 1);
    g::setUniformValues(live, {0.75f, 0.5f, 0.25f, 1});
    CHECK(std::abs(int(rttFrame()) - 64) <= 1); // frozen despite changed uniforms
    state.textureNeedsUpdate = true;
    ++state.revision;
    CHECK(std::abs(int(rttFrame()) - 191) <= 1);
    g::setUniformValues(live, {0.5f, 0.25f, 0.75f, 1});
    state.quad->updateMatrixWorld(true);
    CHECK(renderToTarget(renderer, *target, *state.quad, innerCamera, {0, 0, 0, 1}, false).empty());
    CHECK(std::abs(int(rttFrame()) - 128) <= 1); // explicit quad render reaches the same sampled texture
    const auto vertexScale = g::uniform("quadScale", shader::Type::f32(), {1});
    state.material->nodes.vertexNode =
        g::vec4({g::mul(g::attribute("position", shader::Type::vec(2)), vertexScale), g::float_(0), g::float_(1)});
    state.material->needsUpdate();
    state.autoUpdate = true;
    CHECK(std::abs(int(rttFrame()) - 128) <= 1);
    g::setUniformValues(vertexScale, {0});
    CHECK(rttFrame() == 0); // the quad's live vertex uniform reaches group 1
    CHECK(renderer.diagnostics().empty());
}

// PRD-617: rain's lightning crashed the web host when the post graph's render target was resized. The post graph's
// textures were read after the draws chose their bind groups, so the moved view dropped the groups the frame was about
// to record (a released handle that the host may reuse). A mapped draw plus a resized post texture must still render.
void postTextureResizeKeepsDrawGroups() {
    namespace g = shader::graph;
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(64, 64);
    renderer.setOutput(OutputState{std::nullopt, 1, false});
    const auto mappedTarget = RenderTarget::make(32, 32, kTextureHalfFloatType);
    const auto sampled = RenderTarget::make(32, 32, kTextureHalfFloatType);
    Scene scene;
    OrthographicCamera camera(-1, 1, 1, -1, 0.1, 10);
    camera.position.z = 5;
    camera.updateMatrixWorld();
    auto mapped = std::make_shared<Material>(MaterialType::Basic);
    mapped->maps["map"] = mappedTarget->texture;
    Mesh plane(makePlaneGeometry(2, 2), mapped);
    scene.add(plane);
    scene.updateMatrixWorld(true);
    renderer.setPostGraph(g::add(g::objectTexture(sampled->texture, "resizedSide", g::uv()),
                                 g::mul(g::texture("scene", g::uv()), g::float_(1))));
    RenderDatabase database;
    const auto frame = [&] {
        try {
            database.render(renderer, scene, camera, {0, 0, 0, 1});
            return std::string();
        } catch (const std::exception& error) {
            return std::string(error.what());
        }
    };
    CHECK(frame().empty());
    sampled->setSize(16, 16);
    const std::string refused = frame();
    CHECK(refused.empty());
    if (!refused.empty()) std::fprintf(stderr, "resized post texture: %s\n", refused.c_str());
    sampled->setSize(48, 48);
    CHECK(frame().empty());
    CHECK(renderer.diagnostics().empty());
}

// PRD-617: an offscreen PassNode's target is planned in the JS frame and recorded by the renderer. A target the post
// graph samples is drawn after the post render-to-texture passes of the same frame, so what its scene samples from an
// RTT is this frame's value; planned immediately it would show the previous frame's. The sampled target keeps working
// when it is resized, because the output pass's bind group follows the new view.
void deferredTargetFollowsPostRtt() {
    namespace g = shader::graph;
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(64, 64);
    renderer.setOutput(OutputState{std::nullopt, 1, false});  // linear out: the bytes are the sampled values
    // The post RTT: the live colour, drawn every frame into rttTarget.
    const auto rttTarget = RenderTarget::make(32, 32, kTextureHalfFloatType);
    const auto live = g::uniform("deferredLive", shader::Type::vec(4), {0.25f, 0.5f, 0.25f, 1});
    auto rtt = std::make_shared<g::NodeData>();
    rtt->kind = g::Kind::RenderTexture;
    rtt->type = shader::Type::vec(4);
    rtt->name = "rtt_deferred";
    rtt->args = {live, g::uv()};
    rtt->rtt = std::make_shared<g::RttState>();
    auto& state = *rtt->rtt;
    state.width = state.height = 32;
    state.autoUpdate = true;
    state.target = rttTarget;
    state.source = live;
    state.quad = std::make_shared<Mesh>(makePlaneGeometry(2, 2), std::make_shared<Material>(MaterialType::Basic, true));
    state.material = state.quad->material;
    state.material->rawNodeMaterial = true;
    state.material->nodes.fragmentNode = live;
    // The offscreen pass: a plane whose material samples the post RTT, drawn into `side` and sampled by the post graph.
    const auto side = RenderTarget::make(32, 32, kTextureHalfFloatType);
    Scene inner;
    OrthographicCamera innerCamera(-1, 1, 1, -1, 0.1, 10);
    innerCamera.position.z = 5;
    innerCamera.updateMatrixWorld();
    auto mapped = std::make_shared<Material>(MaterialType::Basic);
    mapped->maps["map"] = rttTarget->texture;
    Mesh plane(makePlaneGeometry(2, 2), mapped);
    inner.add(plane);
    inner.updateMatrixWorld(true);
    renderer.setPostGraph(g::add(g::objectTexture(side->texture, "deferredSide", g::uv()), g::mul(rtt, g::float_(0))));
    // One frame at red channel `value`; the byte the output holds at the middle.
    const auto frame = [&](float value, bool deferred) {
        g::setUniformValues(live, {value, 0.5f, 0.25f, 1});
        CHECK(renderToTarget(renderer, *side, inner, innerCamera, {0, 0, 0, 1}, false, deferred).empty());
        CHECK(renderer.deferredTargets() == (deferred ? 1u : 0u));
        renderer.render({}, CameraState{}, LightState{}, {0, 0, 0, 1});
        CHECK(renderer.deferredTargets() == 0);  // recorded in this frame, once
        const auto bytes = read(renderer, events);
        CHECK(bytes.size() == 64 * 64 * 4);
        return bytes.size() == 64 * 64 * 4 ? int(bytes[(32 * 64 + 32) * 4]) : -1;
    };
    frame(0.25f, true);
    frame(0.25f, true);
    // (a) deferred: the target shows the value the RTT was given this frame.
    CHECK(std::abs(frame(0.75f, true) - 191) <= 1);
    CHECK(std::abs(frame(0.25f, true) - 64) <= 1);
    // Planned and drawn at once (the control), it samples the RTT as the previous frame left it.
    CHECK(std::abs(frame(0.75f, false) - 64) <= 1);
    CHECK(std::abs(frame(0.25f, false) - 191) <= 1);
    // A second plan before a frame records the first: nothing is dropped, nothing is drawn twice.
    CHECK(renderToTarget(renderer, *side, inner, innerCamera, {0, 0, 0, 1}, false, true).empty());
    CHECK(renderToTarget(renderer, *side, inner, innerCamera, {0, 0, 0, 1}, false, true).empty());
    CHECK(renderer.deferredTargets() == 1);
    renderer.render({}, CameraState{}, LightState{}, {0, 0, 0, 1});
    CHECK(renderer.deferredTargets() == 0);
    // A deferred target cannot carry a depth texture: the copy would read the previous draw.
    side->depthTexture = std::make_shared<Texture>();
    CHECK(!renderToTarget(renderer, *side, inner, innerCamera, {0, 0, 0, 1}, false, true).empty());
    side->depthTexture.reset();
    // (b) resized: the post graph's bind group follows the sampled target's new view.
    side->setSize(16, 16);
    CHECK(std::abs(frame(0.5f, true) - 128) <= 1);
    side->setSize(48, 48);
    CHECK(std::abs(frame(0.75f, true) - 191) <= 1);
    CHECK(renderer.diagnostics().empty());
}

// PRD-617: an offscreen PassNode whose material samples a post render-to-texture node directly (rain's bloom pass
// reads the chain colour that convertToTexture made) draws in its own renderer. That renderer has no post effects,
// so the node's texture fell back to a default view and the bloom came out as a screen-wide gradient. It reads the
// main renderer's post texture instead, as t_scene already does.
void deferredTargetSamplesPostRttNode() {
    namespace g = shader::graph;
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(64, 64);
    renderer.setOutput(OutputState{std::nullopt, 1, false});
    const auto live = g::uniform("nodeLive", shader::Type::vec(4), {0.25f, 0.5f, 0.25f, 1});
    auto rtt = std::make_shared<g::NodeData>();  // convertToTexture(colour): a render texture with no target or quad
    rtt->kind = g::Kind::RenderTexture;
    rtt->type = shader::Type::vec(4);
    rtt->name = "native_rtt_7";  // convertToTexture names its texture node so
    rtt->args = {live, g::uv()};
    const auto side = RenderTarget::make(32, 32, kTextureHalfFloatType);
    Scene inner;
    OrthographicCamera innerCamera(-1, 1, 1, -1, 0.1, 10);
    innerCamera.position.z = 5;
    innerCamera.updateMatrixWorld();
    auto sampling = std::make_shared<Material>(MaterialType::Basic, true);
    sampling->rawNodeMaterial = true;
    sampling->nodes.fragmentNode = rtt;  // the plane shows the post RTT through the node, not through a map
    Mesh plane(makePlaneGeometry(2, 2), sampling);
    inner.add(plane);
    inner.updateMatrixWorld(true);
    // The plane's program is built, and its bind group cached, before the post graph exists (a game builds its
    // render targets first); the post graph then adds the texture the node reads.
    CHECK(renderToTarget(renderer, *side, inner, innerCamera, {0, 0, 0, 1}, false, true).empty());
    renderer.render({}, CameraState{}, LightState{}, {0, 0, 0, 1});
    renderer.setPostGraph(g::add(g::objectTexture(side->texture, "nodeSampledSide", g::uv()), g::mul(rtt, g::float_(0))));
    const auto frame = [&](float value) {
        g::setUniformValues(live, {value, 0.5f, 0.25f, 1});
        CHECK(renderToTarget(renderer, *side, inner, innerCamera, {0, 0, 0, 1}, false, true).empty());
        renderer.render({}, CameraState{}, LightState{}, {0, 0, 0, 1});
        const auto bytes = read(renderer, events);
        CHECK(bytes.size() == 64 * 64 * 4);
        return bytes.size() == 64 * 64 * 4 ? int(bytes[(32 * 64 + 32) * 4]) : -1;
    };
    frame(0.25f);
    frame(0.25f);
    const int hi = frame(0.75f), lo = frame(0.25f);
    CHECK(std::abs(hi - 191) <= 1);
    CHECK(std::abs(lo - 64) <= 1);
    CHECK(renderer.diagnostics().empty());
}

// The same read of convertToTexture(traa(...)) over a texture the graph drew: the node is the resolve's own output,
// "native_traa_<n>", which the kart's bloom samples in its first downsample. Bound once with the program, it kept the
// fallback view and the bloom flickered between two colours at full resolution.
void targetSamplesLateTraaOutput() {
    namespace g = shader::graph;
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(64, 64);
    renderer.setOutput(OutputState{std::nullopt, 1, false});
    const auto live = g::uniform("nodeLive", shader::Type::vec(4), {0.25f, 0.5f, 0.25f, 1});
    auto composite = std::make_shared<g::NodeData>();  // the texture the graph drew under the resolve
    composite->kind = g::Kind::RenderTexture;
    composite->type = shader::Type::vec(4);
    composite->name = "native_rtt_8";
    composite->args = {live, g::uv()};
    auto effect = std::make_shared<g::PostEffect>();
    effect->kind = "TRAANode";
    effect->output = "native_traa_9";
    effect->inputs = {composite, g::texture("depth", g::uv()), g::texture("velocity", g::uv())};
    effect->parameters = {{"depthThreshold", {0.0005f}}, {"edgeDepthDiff", {0.001f}}, {"maxVelocityLength", {128}},
                          {"useSubpixelCorrection", {1}}};
    auto resolved = std::make_shared<g::NodeData>(*g::texture(effect->output, g::uv()));  // tsl_call's convertToTexture
    resolved->otherwise = {g::effectNode(effect)};
    const auto side = RenderTarget::make(32, 32, kTextureHalfFloatType);
    Scene inner;
    OrthographicCamera innerCamera(-1, 1, 1, -1, 0.1, 10);
    innerCamera.position.z = 5;
    innerCamera.updateMatrixWorld();
    auto sampling = std::make_shared<Material>(MaterialType::Basic, true);
    sampling->rawNodeMaterial = true;
    sampling->nodes.fragmentNode = resolved;
    Mesh plane(makePlaneGeometry(2, 2), sampling);
    inner.add(plane);
    inner.updateMatrixWorld(true);
    // As a game does: the bloom's targets draw before the post graph that holds the resolve exists.
    CHECK(renderToTarget(renderer, *side, inner, innerCamera, {0, 0, 0, 1}, false).empty());
    renderer.render({}, CameraState{}, LightState{}, {0, 0, 0, 1});
    renderer.setPostGraph(g::add(g::objectTexture(side->texture, "nodeSampledSide", g::uv()), g::mul(resolved, g::float_(0))));
    // The resolve settles on a still input over a few frames; the target reads the frame before (it draws first).
    const auto frame = [&](float value, size_t size) {
        g::setUniformValues(live, {value, 0.5f, 0.25f, 1});
        for (int settle = 0; settle < 6; ++settle) {
            CHECK(renderToTarget(renderer, *side, inner, innerCamera, {0, 0, 0, 1}, false).empty());
            renderer.render({}, CameraState{}, LightState{}, {0, 0, 0, 1});
        }
        const auto bytes = read(renderer, events);
        CHECK(bytes.size() == size * size * 4);
        return bytes.size() == size * size * 4 ? int(bytes[(size / 2 * size + size / 2) * 4]) : -1;
    };
    const int hi = frame(0.75f, 64);
    renderer.setSize(48, 48);  // the resolve's output is allocated again
    const int lo = frame(0.25f, 48);
    std::fprintf(stderr, "TN_DEBUG late resolve read by the target: %d (0.75), %d (0.25 after a resize)\n", hi, lo);
    CHECK(std::abs(hi - 191) <= 2);
    CHECK(std::abs(lo - 64) <= 2);
    CHECK(renderer.diagnostics().empty());
}

// PRD-617: rain's streaks are projected by hand in the vertex stage from `screenSize`, which the renderer wrote only
// into the fragment uniform block. The vertex stage read zero, every quad collapsed, and no drop was drawn.
void screenSizeReachesTheVertexStage() {
    namespace g = shader::graph;
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(64, 64);
    renderer.setOutput(OutputState{std::nullopt, 1, false});
    Scene scene;
    OrthographicCamera camera(-1, 1, 1, -1, 0.1, 10);
    camera.position.z = 5;
    camera.updateMatrixWorld();
    auto material = std::make_shared<Material>(MaterialType::Basic, true);
    material->rawNodeMaterial = true;
    // The plane's corners are +-1: scaled by 64 / screenSize they cover the 64 pixel frame exactly.
    const auto screen = g::uniform("screenSize", shader::Type::vec(2));
    const auto scale = g::div(g::splat(g::float_(64), 2), screen);
    material->nodes.vertexNode =
        g::vec4({g::mul(g::swizzle(g::positionLocal(), "xy"), scale), g::float_(0), g::float_(1)});
    material->nodes.fragmentNode = g::vec4({g::float_(1), g::float_(0), g::float_(0), g::float_(1)});
    Mesh plane(makePlaneGeometry(2, 2), material);
    scene.add(plane);
    scene.updateMatrixWorld(true);
    RenderDatabase database;
    database.render(renderer, scene, camera, {0, 0, 0, 1});
    const auto bytes = read(renderer, events);
    CHECK(bytes.size() == 64 * 64 * 4);
    CHECK(bytes.size() == 64 * 64 * 4 && bytes[(32 * 64 + 32) * 4] == 255);
    CHECK(renderer.diagnostics().empty());
}

// PRD-617: rain's coast quad writes the coast's depth through NodeMaterial.depthNode so the drops drawn after it are
// hidden only where the coast is nearer. The renderer ignored depthNode: the quad wrote the depth of its own vertices
// (the near plane) and every later draw failed the depth test, so no drop was seen.
void depthNodeSetsFragmentDepth() {
    namespace g = shader::graph;
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(64, 64);
    renderer.setOutput(OutputState{std::nullopt, 1, false});
    Scene scene;
    OrthographicCamera camera(-1, 1, 1, -1, 0.1, 10);
    camera.position.z = 5;
    camera.updateMatrixWorld();
    const auto quad = [&](float scale, float z, float r, float green) {
        auto material = std::make_shared<Material>(MaterialType::Basic, true);
        material->rawNodeMaterial = true;
        material->nodes.vertexNode = g::vec4({g::mul(g::swizzle(g::positionLocal(), "xy"), g::splat(g::float_(scale), 2)),
                                             g::float_(z), g::float_(1)});
        material->nodes.fragmentNode = g::vec4({g::float_(r), g::float_(green), g::float_(0), g::float_(1)});
        return material;
    };
    // The coast: clip depth 0 (nearest), green, drawn first, and its depthNode says 0.9 (far).
    auto coast = quad(1, 0, 0, 1);
    coast->nodes.depthNode = g::float_(0.9);
    // The drop: clip depth 0.5, red, transparent so it draws after the coast.
    auto drop = quad(0.5, 0.5, 1, 0);
    drop->transparent = true;
    Mesh coastMesh(makePlaneGeometry(2, 2), coast), dropMesh(makePlaneGeometry(2, 2), drop);
    scene.add(coastMesh);
    scene.add(dropMesh);
    scene.updateMatrixWorld(true);
    RenderDatabase database;
    database.render(renderer, scene, camera, {0, 0, 0, 1});
    const auto bytes = read(renderer, events);
    CHECK(bytes.size() == 64 * 64 * 4);
    const auto at = [&](int x, int y, int channel) { return int(bytes[(y * 64 + x) * 4 + channel]); };
    if (bytes.size() == 64 * 64 * 4) {
        CHECK(at(32, 32, 0) == 255 && at(32, 32, 1) == 0);  // the drop is in front of the coast's depth
        CHECK(at(4, 4, 1) == 255 && at(4, 4, 0) == 0);      // the coast shows where the drop is not
    }
    // Without a depthNode the coast keeps its own depth (0) and the later drop is hidden.
    coast->nodes.depthNode = nullptr;
    coast->needsUpdate();
    database.render(renderer, scene, camera, {0, 0, 0, 1});
    const auto hidden = read(renderer, events);
    CHECK(hidden.size() == 64 * 64 * 4 && hidden[(32 * 64 + 32) * 4 + 1] == 255 && hidden[(32 * 64 + 32) * 4] == 0);
    CHECK(renderer.diagnostics().empty());
}

// NodeMaterial.depthNode is honoured by every node material program, not only the unlit fragmentNode one. A lit
// coast (emissive green) with a depthNode of 0.9 must let the later drop through, as MeshBasic's does.
void depthNodeReachesEveryMaterialProgram() {
    namespace g = shader::graph;
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(64, 64);
    renderer.setOutput(OutputState{std::nullopt, 1, false});
    OrthographicCamera camera(-1, 1, 1, -1, 0.1, 10);
    camera.position.z = 5;
    camera.updateMatrixWorld();
    const auto quad = [&](auto material, float scale, float z) {
        material->nodes.vertexNode = g::vec4({g::mul(g::swizzle(g::positionLocal(), "xy"), g::splat(g::float_(scale), 2)),
                                             g::float_(z), g::float_(1)});
        return material;
    };
    for (const MaterialType type : {MaterialType::Basic, MaterialType::Lambert, MaterialType::Phong, MaterialType::Standard,
                                    MaterialType::Physical}) {
        Scene scene;
        auto coast = quad(std::make_shared<Material>(type, true), 1, 0);
        coast->nodes.colorNode = g::vec4({g::float_(0), g::float_(0), g::float_(0), g::float_(1)});
        coast->nodes.emissiveNode = g::vec3({g::float_(0), g::float_(1), g::float_(0)});
        if (type == MaterialType::Basic) coast->nodes.colorNode = g::vec4({g::float_(0), g::float_(1), g::float_(0), g::float_(1)});
        coast->nodes.depthNode = g::float_(0.9);
        auto drop = quad(std::make_shared<Material>(MaterialType::Basic, true), 0.5, 0.5);
        drop->rawNodeMaterial = true;
        drop->nodes.fragmentNode = g::vec4({g::float_(1), g::float_(0), g::float_(0), g::float_(1)});
        drop->transparent = true;
        Mesh coastMesh(makePlaneGeometry(2, 2), coast), dropMesh(makePlaneGeometry(2, 2), drop);
        scene.add(coastMesh);
        scene.add(dropMesh);
        scene.updateMatrixWorld(true);
        RenderDatabase database;
        database.render(renderer, scene, camera, {0, 0, 0, 1});
        const auto bytes = read(renderer, events);
        CHECK(bytes.size() == 64 * 64 * 4);
        if (bytes.size() != 64 * 64 * 4) continue;
        const auto at = [&](int x, int y, int channel) { return int(bytes[(y * 64 + x) * 4 + channel]); };
        if (!(at(32, 32, 0) == 255 && at(32, 32, 1) == 0))
            std::fprintf(stderr, "material type %d: drop pixel %d,%d,%d\n", int(type), at(32, 32, 0), at(32, 32, 1), at(32, 32, 2));
        CHECK(at(32, 32, 0) == 255 && at(32, 32, 1) == 0);  // the drop is in front of the coast's depthNode
        CHECK(at(4, 4, 1) > 100 && at(4, 4, 0) < 50);       // the coast shows where the drop is not
        CHECK(renderer.diagnostics().empty());
    }
}

// three draws the normal target in the scene pass it counts once, so a post graph that reads `normal`
// adds no draws and no triangles to the frame's counters (the engine's extra normal pass used to land
// in the shadow tally, which put the web platformer at 873 draws against three's 431).
void normalPassIsNotTallied() {
    namespace g = shader::graph;
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(96, 72);
    LitScene s;
    const auto depth = g::texture("depth", g::uv()), normal = g::texture("normal", g::uv());
    const auto colour = g::texture("scene", g::uv());
    const auto occlusion = g::effectNode(g::gtaoEffect(depth, normal));
    renderer.setPostGraph(g::mul(colour, g::swizzle(occlusion, "x")));
    RenderDatabase database;
    for (int i = 0; i < 3; ++i) {
        database.render(renderer, s.scene, s.camera);
        renderer.poll();
        events.drain();
    }
    CHECK(renderer.lastFrame().shadowDraws == 0 && renderer.lastFrame().shadowTriangles == 0);
}

// GTAO's `reachPx` puts the occlusion's reach on the screen (Unreal's short-range AO searches 32 px): with no
// world radius, a reach of 0 leaves a sphere on a floor unoccluded, and a reach of 32 darkens the same area around
// the contact at any distance. The sphere sits at two camera distances; the dark ring must stay a similar share
// of the sphere's footprint, which a fixed world radius would not give.
void gtaoScreenReach() {
    namespace g = shader::graph;
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(320, 240);
    LitScene s;
    auto floorMaterial = std::make_shared<Material>(MaterialType::Standard);
    floorMaterial->color.setRGB(0.8, 0.8, 0.8);
    Mesh floor(makePlaneGeometry(40, 40), floorMaterial);
    floor.rotation.x = -1.5707963267948966;
    floor.position.y = -1;
    s.scene.add(floor);
    s.camera.updateProjectionMatrix();
    s.scene.updateMatrixWorld(true);
    const auto colour = g::texture("scene", g::uv()), depth = g::texture("depth", g::uv()),
               normal = g::texture("normal", g::uv());
    RenderDatabase database;
    // The occlusion frame for one reach and one camera distance.
    const auto frame = [&](float reachPx, double distance, float radius = 0.0001f, float thickness = 1.0f) {
        s.camera.position.set(0, 1.4, distance);
        s.camera.lookAt(0, 0, 0);
        s.camera.updateProjectionMatrix();
        s.scene.updateMatrixWorld(true);
        auto contact = g::gtaoEffect(depth, normal);
        contact->parameters["radius"] = {radius};
        contact->parameters["reachPx"] = {reachPx};
        contact->parameters["thickness"] = {thickness};
        contact->parameters["distanceFallOff"] = {0};  // Unreal weighs every step alike
        renderer.setPostGraph(g::mul(colour, g::swizzle(g::effectNode(contact), "x")));
        database.render(renderer, s.scene, s.camera, {0.05, 0.06, 0.08, 1});
        return read(renderer, events);
    };
    // Pixels a reach darkened against the same view with no reach (a world radius of a tenth of a millimetre).
    const auto darkened = [&](float reachPx, double distance, float radius = 0.0001f, float thickness = 1.0f) {
        const std::vector<uint8_t> open = frame(0, distance), px = frame(reachPx, distance, radius, thickness);
        CHECK(!px.empty() && px.size() == open.size());
        size_t count = 0;
        for (size_t i = 0; i < px.size(); i += 4) count += px[i] + 6 < open[i];
        return count;
    };
    const size_t near32 = darkened(32, 3.2), far32 = darkened(32, 6.4);
    const size_t nearWorld = darkened(0, 3.2, 0.3f), farWorld = darkened(0, 6.4, 0.3f);
    CHECK(near32 > 200);
    // Twice the distance, the same dark area to within a factor of two (the reach is on the screen).
    CHECK(far32 * 2 > near32 && near32 * 2 > far32);
    // At twice the distance a world radius darkens a ring of half the width, so its dark area falls faster than a
    // reach of 32 px does: the reach keeps a larger share of its near count (measured 0.32 against 0.23).
    CHECK(far32 * nearWorld * 4 > near32 * farWorld * 5);
    // The reach takes Unreal's foreground reject (a sample's occlusion fades out over 0.3 of the pixel's depth)
    // instead of a metre cutoff: a thickness of a tenth of a millimetre does not blind it, while the world radius
    // path still honours the cutoff.
    CHECK(darkened(32, 3.2, 0.0001f, 0.0001f) > near32 / 2);
    CHECK(darkened(0, 3.2, 0.3f, 0.0001f) < nearWorld / 2);
}

// three's material.colorWrite = false masks every colour channel of that material's draw (the tower-defense
// tap pads rely on it); the engine did not bind it, so the web native build stopped at the material's constructor.
void colorWriteMasksTheDraw() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(96, 72);
    LitScene s;
    RenderDatabase database;
    const auto lit = [&] {
        database.render(renderer, s.scene, s.camera, {0, 0, 0, 1});
        size_t count = 0;
        const std::vector<uint8_t> px = read(renderer, events);
        for (size_t i = 0; i < px.size(); i += 4) count += (px[i] | px[i + 1] | px[i + 2]) != 0;
        return count;
    };
    CHECK(lit() > 0);
    s.mesh.material->colorWrite = false;
    CHECK(lit() == 0);
    s.mesh.material->colorWrite = true;
    CHECK(lit() > 0);
}

// three's material.depthTest = false draws over whatever is nearer (the RTS kit's health bars over its buildings);
// the engine ignored it, so a bar behind a model's antenna was cut by it and its coplanar frame fought its fill.
void depthTestOffDrawsOverNearer() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(96, 72);
    LitScene s;
    auto overlay = std::make_shared<Material>(MaterialType::Basic);
    overlay->color.setRGB(0, 1, 0);
    overlay->transparent = true;
    Mesh behind{makeSphereGeometry(0.4, 16, 8), overlay};
    behind.position.z = -1.5;
    s.scene.add(behind);
    s.scene.updateMatrixWorld(true);
    RenderDatabase database;
    const auto green = [&] {
        database.render(renderer, s.scene, s.camera, {0, 0, 0, 1});
        size_t count = 0;
        const std::vector<uint8_t> px = read(renderer, events);
        for (size_t i = 0; i < px.size(); i += 4) count += px[i + 1] > 200 && px[i] < 60 && px[i + 2] < 60;
        return count;
    };
    CHECK(green() == 0);
    overlay->depthTest = false;
    CHECK(green() > 20);
    overlay->depthTest = true;
    CHECK(green() == 0);
}

// A steady frame does no setup work: after warm-up, sixty more frames of a lit node-material scene with
// shadows and the template's bloom + GTAO/denoise chain compile no pipeline, build no pipeline text
// key, create no bind group, serialize no graph key and build no program. Each of these was a
// per-frame regression once (the wasm32 pipeline-id hash, per-draw graph keys, per-pass post bind
// groups); counters, unlike timings, fail the same way on every machine.
void steadyState() {
    namespace g = shader::graph;
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(96, 72);
    LitScene s;
    s.mesh.setCastShadow(true);
    s.mesh.setReceiveShadow(true);
    s.light.setCastShadow(true);
    if (s.light.shadow.camera)
        s.light.shadow.camera->setLayerMask(double((1 << 0) | (1 << 2)));
    auto rim = std::make_shared<Material>(MaterialType::Standard, true);
    rim->color.setRGB(0.6, 0.6, 0.65);
    // A diffuse map: its program samples a texture, so the sampler path and a per-draw fragment
    // group run every frame (the Midway case: many textures, one descriptor each).
    auto map = std::make_shared<Texture>();
    map->width = map->height = 4;
    for (int i = 0; i < 16; ++i) map->data.insert(map->data.end(), {200, 200, 200, 255});
    map->needsUpdate();
    rim->maps["map"] = map;
    const auto gain = g::uniform("steadyGain", shader::Type::f32(), {0.25f});
    rim->nodes.emissiveNode = g::mul(g::swizzle(g::uniform("diffuse", shader::Type::vec(4)), "xyz"), gain);
    s.mesh.material = rim;
    const auto colour = g::texture("scene", g::uv()), depth = g::texture("depth", g::uv()),
               normal = g::texture("normal", g::uv());
    auto contact = g::gtaoEffect(depth, normal);
    const auto occlusion = g::effectNode(g::denoiseEffect(g::effectNode(contact), depth, normal, 1));
    renderer.setPostGraph(g::add(g::mul(colour, g::swizzle(occlusion, "x")), g::bloom(colour, 0.7, 0.5, 0.2)));

    // Batched static meshes (compact)
    auto boxGeom = makeBoxGeometry(1, 1, 1);
    auto batchMat = std::make_shared<Material>(MaterialType::Standard);
    batchMat->color.setHex(0xaaaaaa);
    batchMat->roughness = 0.5;
    std::vector<std::shared_ptr<Mesh>> batchedMeshes;
    for (int i = 0; i < 4; ++i) {
        auto bm = std::make_shared<Mesh>(boxGeom, batchMat);
        bm->setCastShadow(true);
        bm->position.set(-2.0 + i, 0, -2.0);
        s.scene.add(*bm);
        batchedMeshes.push_back(bm);
    }

    // Shadow-only proxy on layer 2
    auto proxyMat = std::make_shared<Material>(MaterialType::Standard);
    auto proxy = std::make_shared<Mesh>(boxGeom, proxyMat);
    proxy->setCastShadow(true);
    proxy->setLayer(2);
    proxy->position.set(0, 3, 0);
    s.scene.add(*proxy);

    // Skinned animated character
    auto skinGeom = makeBoxGeometry(1, 1, 1);
    skinGeom->setAttribute("skinIndex", BufferAttribute::fromDoubles(Scalar::U16, std::vector<double>(skinGeom->attributes.at("position")->count() * 4, 0.0), 4));
    skinGeom->setAttribute("skinWeight", BufferAttribute::fromFloats(std::vector<double>(skinGeom->attributes.at("position")->count() * 4, 0.25), 4));
    auto skinMat = std::make_shared<Material>(MaterialType::Standard);
    auto rig = std::make_shared<SkinnedMesh>(skinGeom, skinMat);
    auto b0 = std::make_shared<Bone>();
    auto b1 = std::make_shared<Bone>();
    rig->add(*b0);
    b0->add(*b1);
    std::vector<std::shared_ptr<Bone>> bones{b0, b1};
    rig->bind(std::make_shared<Skeleton>(bones));
    rig->setCastShadow(true);
    s.scene.add(*rig);

    // Transparent water
    auto waterMat = std::make_shared<Material>(MaterialType::Standard);
    waterMat->transparent = true;
    waterMat->opacity = 0.6;
    auto water = std::make_shared<Mesh>(makePlaneGeometry(10, 10), waterMat);
    water->position.set(0, -1, 0);
    s.scene.add(*water);

    RenderDatabase database;
    database.shadowMapEnabled = true;
    const auto frame = [&] {
        database.render(renderer, s.scene, s.camera);
        renderer.poll();
        events.drain();
    };
    for (int i = 0; i < 5; ++i) frame();
    const auto cleanDiag = [](const std::vector<std::string>& diags) {
        for (const auto& d : diags) if (d.rfind("TN_POST_NORMAL_SKIPPED", 0) != 0) return false;
        return true;
    };
    CHECK(database.diagnostics().empty() && cleanDiag(renderer.diagnostics()));
    const auto compiles = renderer.pipelines().compiles(), texts = renderer.pipelines().textLookups();
    const auto groups = bindGroupsCreated(), keys = g::keyBuilds(), uniformMaps = g::uniformMapBuilds();
    const auto programs = renderer.programCount();
    const auto programKeys = renderer.programKeyBuilds(), lookups = renderer.programLookups();
    const auto samplers = renderer.samplersCreated();
    const auto uHashes = projection::detail::uniformHashCount().load();
    for (int i = 0; i < 60; ++i) {
        if (i % 2) s.mesh.position.x = 0.01 * i;  // a moving object is still a steady frame
        frame();
    }
    std::fprintf(stderr, "steady state over 60 frames: compiles +%llu, text keys +%llu, bind groups +%llu, graph keys +%llu, uniform maps +%llu, programs +%zu, program keys +%llu, lookups +%llu, samplers +%llu\n",
                 (unsigned long long)(renderer.pipelines().compiles() - compiles),
                 (unsigned long long)(renderer.pipelines().textLookups() - texts),
                 (unsigned long long)(bindGroupsCreated() - groups), (unsigned long long)(g::keyBuilds() - keys),
                 (unsigned long long)(g::uniformMapBuilds() - uniformMaps), renderer.programCount() - programs,
                 (unsigned long long)(renderer.programKeyBuilds() - programKeys),
                 (unsigned long long)(renderer.programLookups() - lookups),
                 (unsigned long long)(renderer.samplersCreated() - samplers));
    CHECK(renderer.pipelines().compiles() == compiles);
    CHECK(renderer.pipelines().textLookups() == texts);
    CHECK(bindGroupsCreated() == groups);
    CHECK(g::keyBuilds() == keys);
    CHECK(g::uniformMapBuilds() == uniformMaps);  // per-draw uniform packing reads the nodes in place
    CHECK(renderer.programCount() == programs);
    // A steady frame reuses every resolved draw: no program key is built, no Program* looked up, no
    // sampler created. three caches all of these on the material and version; so does the record.
    CHECK(renderer.programKeyBuilds() == programKeys);
    CHECK(renderer.programLookups() == lookups);
    CHECK(renderer.samplersCreated() == samplers);
    // A material hashes at most once per prepare, not once per member: five materials here.
    CHECK(projection::detail::uniformHashCount().load() - uHashes <= 60 * 5);
    CHECK(database.diagnostics().empty() && cleanDiag(renderer.diagnostics()));
}

// FM1: a steady frame must not rebuild a draw from its material. refresh() recopied ~45 material-derived
// fields, the node graph and the attribute list into the record every frame, and project() then copied the
// whole DrawItem into the frame list, so each draw allocated two containers and bumped three refcounts a
// frame. None of that may happen while a material's uniforms and its geometry hold; a change three makes
// without a version bump (base colour, roughness, a swapped map) must still reach the pixels; and two
// independently built arms must draw identical bytes, the work assertion being a counter and not a clock.
void steadyStateDrawRefreshWork() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    constexpr int kWidth = 96, kHeight = 72;
    struct Arm {
        std::unique_ptr<EventQueue> events;
        std::unique_ptr<Renderer> renderer;
        Scene scene;
        PerspectiveCamera camera;
        RenderDatabase database;
        std::shared_ptr<BufferGeometry> geometry;
        std::shared_ptr<DirectionalLight> light;
        std::vector<std::shared_ptr<Material>> materials;
        std::vector<std::shared_ptr<Mesh>> meshes;
        std::shared_ptr<Material> moverMaterial;
        std::shared_ptr<Mesh> mover;
    };
    std::array<Arm, 2> arms;
    for (Arm& arm : arms) {
        arm.events = std::make_unique<EventQueue>();
        arm.renderer = std::make_unique<Renderer>(context.getInstance(), context.getDevice(), context.getQueue(), *arm.events);
        arm.renderer->setSize(kWidth, kHeight);
        arm.camera.fov = 45;
        arm.camera.aspect = double(kWidth) / kHeight;
        arm.camera.near = 0.1;
        arm.camera.far = 100;
        arm.camera.position.set(0, 0, 12);
        arm.camera.lookAt(0, 0, 0);
        arm.camera.updateProjectionMatrix();
        arm.geometry = makeBoxGeometry(0.7, 0.7, 0.7);
        // Eight materials that differ in base colour alone: one uniform signature, so only a field that
        // signature leaves out tells their draws apart.
        for (int m = 0; m < 8; ++m) {
            auto material = std::make_shared<Material>(MaterialType::Standard);
            material->color.setRGB(0.15 + 0.09 * m, 0.2 + 0.07 * m, 0.72 - 0.07 * m);
            material->roughness = 0.35;
            material->metalness = 0.1;
            arm.materials.push_back(material);
        }
        for (int i = 0; i < 64; ++i) {
            auto mesh = std::make_shared<Mesh>(arm.geometry, arm.materials[std::size_t(i) % 8]);
            mesh->position.set(-3.15 + 0.9 * (i % 8), -3.15 + 0.9 * (i / 8), 0);
            arm.scene.add(*mesh);
            arm.meshes.push_back(mesh);
        }
        // The one draw that moves every frame: its transform refreshes, its material half must hold.
        arm.moverMaterial = std::make_shared<Material>(MaterialType::Standard);
        arm.moverMaterial->color.setRGB(0.05, 0.85, 0.15);
        arm.moverMaterial->roughness = 0.25;
        arm.mover = std::make_shared<Mesh>(arm.geometry, arm.moverMaterial);
        arm.mover->position.set(-3.0, -4.3, 1);
        arm.scene.add(*arm.mover);
        arm.light = std::make_shared<DirectionalLight>(Color().setHex(0xffffff), 3);
        arm.light->position.set(1.5, 2.5, 6);
        arm.scene.add(*arm.light);
        arm.database.batching = false;  // one record per draw: the per-draw refresh is what is measured
        arm.scene.updateMatrixWorld(true);
    }
    int step = 0;
    const auto frame = [&](Arm& arm) {
        arm.database.render(*arm.renderer, arm.scene, arm.camera, {0.02, 0.02, 0.03, 1});
        arm.renderer->poll();
        arm.events->drain();
    };
    const auto frameBoth = [&] {
        for (Arm& arm : arms) {
            arm.mover->position.x = -3.0 + 0.2 * step;  // the same frame on both arms
            frame(arm);
        }
        ++step;
    };
    for (int i = 0; i < 3; ++i) frameBoth();  // warm: the first frame records every draw

    // (a) work: a steady frame recopies no draw's material state, on either arm.
    const uint64_t refreshes = projection::detail::materialRefreshCount().load();
    const uint64_t copies = projection::detail::materialNodeCopyCount().load();
    frameBoth();
    frameBoth();
    const uint64_t refreshed = projection::detail::materialRefreshCount().load() - refreshes;
    const uint64_t copied = projection::detail::materialNodeCopyCount().load() - copies;
    const std::size_t draws = arms[0].database.drawn().size();
    std::printf("steady refresh: %llu material refreshes and %llu node copies over 2 frames of %zu draws\n",
                (unsigned long long)refreshed, (unsigned long long)copied, draws);
    CHECK(draws == 65);
    CHECK(refreshed == 0);
    CHECK(copied == 0);
    CHECK(arms[0].database.diagnostics().empty());
    // The frame-varying half still refreshes: the mover's draw carries this frame's transform.
    const auto& drawn = arms[0].database.drawn();
    const auto moverDraw = std::find_if(drawn.begin(), drawn.end(), [&](const DrawItem& d) {
        return d.materialKey == arms[0].moverMaterial.get();
    });
    CHECK(moverDraw != drawn.end());
    const double movedTo = arms[0].mover->matrixWorld.elements[12];
    CHECK(movedTo > -3.0 && movedTo == -3.0 + 0.2 * (step - 1));
    if (moverDraw != drawn.end()) CHECK(moverDraw->matrixWorld[12] == movedTo);

    // (b) pixels: both arms draw byte-identical buffers.
    const auto differing = [](const std::vector<uint8_t>& a, const std::vector<uint8_t>& b) {
        std::size_t n = 0;
        for (std::size_t i = 0; i < std::min(a.size(), b.size()); ++i) n += a[i] != b[i];
        return n + (a.size() == b.size() ? 0 : std::max(a.size(), b.size()));
    };
    const auto digest = [](const std::vector<uint8_t>& px) {
        uint64_t h = 0xcbf29ce484222325ull;
        for (uint8_t byte : px) { h ^= byte; h *= 0x100000001b3ull; }
        return h;
    };
    std::array<std::vector<uint8_t>, 2> current, previous;
    const auto readBoth = [&] {
        for (std::size_t i = 0; i < arms.size(); ++i) current[i] = read(*arms[i].renderer, *arms[i].events);
    };
    readBoth();
    CHECK(current[0].size() == std::size_t{kWidth} * kHeight * 4);
    CHECK(current[1].size() == current[0].size());
    std::printf("steady refresh: steady frame differs on %zu bytes, digest %016llx\n",
                differing(current[0], current[1]), (unsigned long long)digest(current[0]));
    CHECK(differing(current[0], current[1]) == 0);

    // (c) change detection: a field three writes without a version bump still reaches the pixels, alike on
    // both arms, so a held material half can never go stale.
    const auto edit = [&](const char* what, const std::function<void(Arm&)>& change) {
        previous = current;
        for (Arm& arm : arms) change(arm);
        frameBoth();
        readBoth();
        const std::size_t changed = differing(current[0], previous[0]);
        std::printf("steady refresh: %s changed %zu bytes (other arm %zu), arms differ on %zu\n", what, changed,
                    differing(current[1], previous[1]), differing(current[0], current[1]));
        CHECK(changed > 0);
        CHECK(differing(current[1], previous[1]) == changed);
        CHECK(differing(current[0], current[1]) == 0);
        CHECK(arms[0].database.diagnostics().empty());
    };
    const auto texture = [](uint8_t r, uint8_t g, uint8_t b) {
        auto map = std::make_shared<Texture>();
        map->width = map->height = 4;
        for (int i = 0; i < 16; ++i) map->data.insert(map->data.end(), {r, g, b, 255});
        map->needsUpdate();
        return map;
    };
    edit("material.color", [](Arm& arm) { arm.materials[3]->color.setRGB(0.95, 0.15, 0.2); });
    edit("material.roughness", [](Arm& arm) { arm.materials[3]->roughness = 0.02; });
    edit("material.maps[map]", [&](Arm& arm) { arm.materials[3]->maps["map"] = texture(20, 80, 240); });
    edit("material.maps[map] swapped", [&](Arm& arm) { arm.materials[3]->maps["map"] = texture(240, 200, 20); });

    // The counters are wired, on the smallest case: the mover owns its material, so one edit between frames
    // recopies exactly that one draw, and the 64 static draws beside it recopy nothing.
    const uint64_t beforeEdit = projection::detail::materialRefreshCount().load();
    const uint64_t beforeCopies = projection::detail::materialNodeCopyCount().load();
    arms[0].moverMaterial->color.setRGB(0.9, 0.1, 0.6);
    arms[0].mover->position.x = -3.0 + 0.2 * step;
    frame(arms[0]);
    ++step;
    std::printf("steady refresh: one mover colour edit refreshed %llu draws, copied %llu node graphs\n",
                (unsigned long long)(projection::detail::materialRefreshCount().load() - beforeEdit),
                (unsigned long long)(projection::detail::materialNodeCopyCount().load() - beforeCopies));
    CHECK(projection::detail::materialRefreshCount().load() - beforeEdit == 1);
    CHECK(projection::detail::materialNodeCopyCount().load() - beforeCopies == 1);
}

// The steady-state cache must not hide a real change: a texture whose descriptor moves (anisotropy)
// rebuilds its sampler, two textures with one descriptor share it, and a material edit rebuilds the
// record while a draw that only moves reuses everything.
void steadyCacheInvalidation() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(64, 48);
    const auto texture = [] {
        auto map = std::make_shared<Texture>();
        map->width = map->height = 4;
        for (int i = 0; i < 16; ++i) map->data.insert(map->data.end(), {200, 200, 200, 255});
        map->needsUpdate();
        return map;
    };
    auto mapA = texture(), mapB = texture();
    auto materialA = std::make_shared<Material>(MaterialType::Standard);
    materialA->maps["map"] = mapA;
    auto materialB = std::make_shared<Material>(MaterialType::Standard);
    materialB->maps["map"] = mapB;
    Scene scene;
    PerspectiveCamera camera;
    camera.fov = 45; camera.aspect = 4.0 / 3; camera.near = 0.1; camera.far = 50;
    camera.position.z = 4; camera.lookAt(0, 0, 0); camera.updateProjectionMatrix();
    auto geometry = makePlaneGeometry(3, 3);
    Mesh meshA{geometry, materialA};
    meshA.setCastShadow(true); meshA.setReceiveShadow(true);
    Mesh meshB{geometry, materialB};
    meshB.position.x = 10;  // off screen until it is added: its texture must not be uploaded early
    DirectionalLight light{Color().setHex(0xffffff), 3};
    light.position.set(2, 3, 1);
    light.setCastShadow(true);
    scene.add(meshA);
    scene.add(light);
    scene.updateMatrixWorld(true);
    RenderDatabase database;
    database.shadowMapEnabled = true;
    const auto frame = [&] { database.render(renderer, scene, camera, {0, 0, 0, 1}); events.drain(); };
    for (int i = 0; i < 4; ++i) frame();
    CHECK(database.diagnostics().empty());
    const auto created = renderer.samplersCreated(), distinct = renderer.samplerCount();
    // Anisotropy is part of the descriptor: a changed value yields a new sampler (a changed key).
    mapA->anisotropy = 8;
    mapA->needsUpdate();
    frame();
    CHECK(renderer.samplersCreated() == created + 1 && renderer.samplerCount() == distinct + 1);
    frame();  // and the new sampler is reused
    CHECK(renderer.samplersCreated() == created + 1);
    // A second texture with the same descriptor shares the sampler instead of building another.
    meshB.position.x = 0;
    scene.add(meshB);
    scene.updateMatrixWorld(true);
    frame();
    frame();
    CHECK(renderer.samplersCreated() == created + 1 && renderer.samplerCount() == distinct + 1);
    // Back to the first descriptor: the original sampler is served again, nothing new is built.
    mapA->anisotropy = 1;
    mapA->needsUpdate();
    frame();
    frame();
    CHECK(renderer.samplersCreated() == created + 1);
    // A material edit rebuilds the record, but a still frame after it reuses every program again.
    const auto rebuilds = database.rebuilds();
    materialA->color.setRGB(0.1, 0.2, 0.9);
    materialA->needsUpdate();
    frame();
    CHECK(database.rebuilds() > rebuilds);
    const auto lookups = renderer.programLookups();
    frame();
    frame();
    CHECK(renderer.programLookups() == lookups);
}

// PRD-514: an edit between frames shows on the next frame, and nothing a frame no longer draws stays
// behind: a released geometry's GPU copies are freed and never served to a geometry that reuses its
// address.
void updates() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(64, 48);
    LitScene s;
    RenderDatabase database;
    const auto frame = [&] {
        database.render(renderer, s.scene, s.camera, {0, 0, 0, 1});
        CHECK(database.diagnostics().empty());
        return read(renderer, events);
    };
    const auto lit = [](const std::vector<uint8_t>& px) {
        size_t n = 0;
        for (size_t i = 0; i + 3 < px.size(); i += 4) n += (px[i] | px[i + 1] | px[i + 2]) != 0;
        return n;
    };
    const size_t center = (24 * 64 + 32) * 4;
    std::vector<uint8_t> px = frame();
    CHECK(px.size() == 64 * 48 * 4 && px[center] > px[center + 2]);  // the orange sphere

    // A material edit is blue on the next frame.
    s.material->color.setRGB(0.1, 0.2, 0.9);
    s.material->needsUpdate();
    px = frame();
    CHECK(px[center + 2] > px[center]);

    // Positions edited in place and flagged (three's attribute.needsUpdate) shrink the next frame.
    const size_t whole = lit(px);
    BufferStore& positions = *s.geometry->attributes.at("position")->store;
    float* p = reinterpret_cast<float*>(positions.data());
    for (uint64_t i = 0; i < positions.count(); ++i) p[i] *= 0.25f;
    positions.needsUpdate();
    px = frame();
    CHECK(lit(px) > 0 && lit(px) * 4 < whole);

    // 200 geometry swaps, each old geometry released. Same vertex count, alternating radius: a new
    // geometry at a released one's address must draw its own radius, never the old GPU copy, and the
    // GPU keeps copies of the live geometry and at most the one the previous frame drew.
    s.geometry.reset();
    size_t silhouette[2] = {0, 0};
    int stale = 0;
    for (int i = 0; i < 200; ++i) {
        s.mesh.geometry = makeSphereGeometry(i % 2 ? 0.5 : 1, 16, 8);
        const size_t n = lit(frame());
        if (i < 2) silhouette[i] = n;
        else stale += n != silhouette[i % 2];
    }
    CHECK(silhouette[1] > 0 && silhouette[1] < silhouette[0]);
    CHECK(stale == 0);
    if (stale) std::fprintf(stderr, "frames drawn from a released geometry: %d\n", stale);
    CHECK(renderer.geometry().entries() <= 6);
    if (renderer.geometry().entries() > 6) std::fprintf(stderr, "GPU copies: %zu\n", renderer.geometry().entries());
}

// PRD-514: two cameras with different layers, rendered in one tick, each see only their layer's mesh
// and get distinct render IDs; ticking both keeps every record, so no frame rebuilds the other's.
void multiCameraLayers() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(64, 48);
    LitScene s;
    s.mesh.position.x = -1.2;
    s.mesh.setLayer(1);
    auto blue = std::make_shared<Material>(MaterialType::Standard);
    blue->color.setRGB(0.1, 0.2, 0.9);
    Mesh right{s.geometry, blue};
    right.position.x = 1.2;
    right.setLayer(2);
    s.scene.add(right);
    for (Object3D* light : {static_cast<Object3D*>(&s.light), static_cast<Object3D*>(&s.sky)}) {
        light->enableLayer(1);
        light->enableLayer(2);
    }
    PerspectiveCamera second;  // the same view as the first, on another layer
    second.fov = s.camera.fov;
    second.aspect = s.camera.aspect;
    second.near = s.camera.near;
    second.far = s.camera.far;
    second.position.copy(s.camera.position);
    second.lookAt(0, 0, 0);
    second.updateProjectionMatrix();
    s.camera.setLayer(1);
    second.setLayer(2);
    RenderDatabase database;
    const auto lit = [](const std::vector<uint8_t>& px, int x) {
        const size_t i = (24 * 64 + size_t(x)) * 4;
        return px.size() == 64 * 48 * 4 && (px[i] | px[i + 1] | px[i + 2]) != 0;
    };
    const uint64_t first = database.render(renderer, s.scene, s.camera);
    const std::vector<uint8_t> a = read(renderer, events);
    const uint64_t other = database.render(renderer, s.scene, second);
    const std::vector<uint8_t> b = read(renderer, events);
    CHECK(first != other);
    CHECK(lit(a, 14) && !lit(a, 50));  // layer 1: the left mesh only
    CHECK(!lit(b, 14) && lit(b, 50));  // layer 2: the right mesh only
    CHECK(database.diagnostics().empty());
    const uint64_t built = database.rebuilds();
    for (int tick = 0; tick < 100; ++tick) {
        database.render(renderer, s.scene, s.camera);
        database.render(renderer, s.scene, second);
    }
    CHECK(database.rebuilds() == built);
    if (database.rebuilds() != built) std::fprintf(stderr, "rebuilds over 100 ticks: %llu\n", (unsigned long long)(database.rebuilds() - built));
}

// PRD-531/506: onBeforeRender runs once per drawn frame with the scene and camera, before the draw,
// so a colour it sets reaches the same frame; a callee that threw is a diagnostic, not a crash.
void renderCallback() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(64, 48);
    LitScene s;
    RenderDatabase database;
    int calls = 0;
    RenderCallbackArgs seen;
    s.mesh.onBeforeRender = std::make_shared<const std::function<bool(const RenderCallbackArgs&, std::string&)>>(
        [&](const RenderCallbackArgs& a, std::string&) {
            ++calls;
            seen = a;
            s.material->color.setRGB(0.1, 0.2, 0.9);
            return true;
        });
    database.render(renderer, s.scene, s.camera, {0, 0, 0, 1});
    const std::vector<uint8_t> px = read(renderer, events);
    const size_t center = (24 * 64 + 32) * 4;
    CHECK(calls == 1);
    CHECK(seen.scene == &s.scene && seen.camera == &s.camera);
    CHECK(seen.geometry == s.geometry && seen.material == s.material);
    CHECK(px.size() == 64 * 48 * 4 && px[center + 2] > px[center]);  // blue in the frame it was set
    CHECK(database.diagnostics().empty());

    s.mesh.onBeforeRender = std::make_shared<const std::function<bool(const RenderCallbackArgs&, std::string&)>>(
        [](const RenderCallbackArgs&, std::string& error) {
            error = "boom";
            return false;
        });
    database.render(renderer, s.scene, s.camera, {0, 0, 0, 1});
    CHECK(database.diagnostics().size() == 1 && database.diagnostics()[0] == "TN_CALLBACK_FAILED onBeforeRender: boom");

    s.mesh.setVisible(false);  // a mesh not drawn is not called
    calls = 0;
    s.mesh.onBeforeRender = std::make_shared<const std::function<bool(const RenderCallbackArgs&, std::string&)>>(
        [&](const RenderCallbackArgs&, std::string&) {
            ++calls;
            return true;
        });
    database.render(renderer, s.scene, s.camera, {0, 0, 0, 1});
    CHECK(calls == 0);
}

// PRD-519 groundwork: an InstancedMesh draws exactly what the same objects drawn one by one draw.
// Nine lit spheres, rotated, non-uniformly scaled and coloured per instance, render once as one
// InstancedMesh (one draw, three's instance(): matrix per instance, normals by its inverse
// transpose, instanceColor times the material colour) and once as nine Meshes with those world
// matrices and colours (nine draws). The frames must match to within float rounding.
void instanced() {
    if (std::getenv("TN_DUMP_WGSL")) {
        const auto p = shader::buildBasic({true, true});
        std::printf("%s\n", shader::buildStage(p.vertex, 0).wgsl.code.c_str());
        return;
    }
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(160, 120);
    PerspectiveCamera camera(50, 4.0 / 3, 0.1, 100);
    camera.position.set(0, 2, 9);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    // Spheres, not boxes: a box's normals are axis-aligned, and for those the instance matrix and its
    // inverse transpose point the same way, so only a curved surface tests the normal transform.
    auto geometry = makeSphereGeometry(0.6, 24, 16);
    const Color base = Color().setHex(0xdddddd);
    std::vector<Matrix4> matrices;
    std::vector<Color> colors;
    for (int i = 0; i < 9; ++i) {
        const Vector3 position((i % 3 - 1) * 2.6, (i / 3 - 1) * 1.9, -0.4 * i);
        Quaternion q;
        q.setFromEuler(Euler(0.3 * i, 0.5 + 0.2 * i, 0.1 * i));
        const Vector3 scale(0.6 + 0.1 * i, 1.0 - 0.05 * i, 0.8 + (i % 2) * 0.5);  // non-uniform: the normal path
        matrices.push_back(Matrix4().compose(position, q, scale));
        colors.push_back(Color().setHSL(i / 9.0, 0.7, 0.5));
    }
    const auto light = [](Object3D& scene) {
        auto sun = std::make_shared<DirectionalLight>(Color().setHex(0xffffff), 2.5);
        sun->position.set(3, 4, 5);
        auto sky = std::make_shared<HemisphereLight>(Color().setHex(0xb0c4de), Color().setHex(0x302820), 0.8);
        scene.add(*sun);
        scene.add(*sky);
        return std::make_pair(sun, sky);
    };

    Scene batched;
    const auto keepA = light(batched);
    auto material = std::make_shared<Material>(MaterialType::Standard);
    material->color = base;
    material->roughness = 0.6;
    auto mesh = std::make_shared<InstancedMesh>(geometry, material, 9);
    for (int i = 0; i < 9; ++i) mesh->setMatrixAt(i, matrices[i]).setColorAt(i, colors[i]);
    batched.add(*mesh);
    RenderDatabase dbA;
    dbA.render(renderer, batched, camera);
    const auto statsA = renderer.lastFrame();
    const std::vector<uint8_t> a = read(renderer, events);

    Scene separate;
    const auto keepB = light(separate);
    std::vector<std::shared_ptr<Mesh>> meshes;
    for (int i = 0; i < 9; ++i) {
        auto m = std::make_shared<Material>(MaterialType::Standard);
        // The instance colour is stored as float32 and multiplies the material colour in the shader.
        m->color.setRGB(float(colors[i].r) * base.r, float(colors[i].g) * base.g, float(colors[i].b) * base.b);
        m->roughness = 0.6;
        auto one = std::make_shared<Mesh>(geometry, m);
        one->matrixAutoUpdate = false;
        one->matrix = matrices[i];
        separate.add(*one);
        meshes.push_back(one);
    }
    RenderDatabase dbB;
    dbB.batching = false; // the reference is nine separate draws, not the engine's own instancing
    dbB.render(renderer, separate, camera);
    const auto statsB = renderer.lastFrame();
    const std::vector<uint8_t> b = read(renderer, events);

    CHECK(a.size() == b.size() && !a.empty());
    std::size_t lit = 0, differ = 0;
    int worst = 0;
    for (std::size_t p = 0; p + 3 < a.size() && a.size() == b.size(); p += 4) {
        int d = 0;
        for (int c = 0; c < 3; ++c) d = std::max(d, std::abs(int(a[p + c]) - int(b[p + c])));
        worst = std::max(worst, d);
        if (d > 2) ++differ;
        if (a[p] + a[p + 1] + a[p + 2] > 0) ++lit;
    }
    std::printf("instanced: draws %u vs %u, triangles %llu vs %llu, %zu covered pixels, %zu differ by more than 2 (worst %d)\n",
                statsA.draws, statsB.draws, (unsigned long long)statsA.triangles, (unsigned long long)statsB.triangles,
                lit, differ, worst);
    // Each frame adds the output pass (one draw, one triangle) to the scene's.
    CHECK(statsA.draws == 1 + 1 && statsB.draws == 9 + 1 && statsA.triangles == statsB.triangles);
    CHECK(lit > 1000 && differ == 0);
    for (const std::string& d : dbA.diagnostics()) std::fprintf(stderr, "%s\n", d.c_str());
    CHECK(dbA.diagnostics().empty());

    // PRD-545: a game assigns its own colour attribute after the mesh has drawn (Midway's tracers set
    // instanceColor = new InstancedBufferAttribute(...)); the next frame shows the colours.
    Scene later;
    const auto keepC = light(later);
    auto plain = std::make_shared<InstancedMesh>(geometry, material, 9);
    for (int i = 0; i < 9; ++i) plain->setMatrixAt(i, matrices[i]);
    later.add(*plain);
    RenderDatabase dbC;
    dbC.render(renderer, later, camera);
    const std::vector<uint8_t> before = read(renderer, events);
    std::vector<double> rgb;
    for (const Color& c : colors) rgb.insert(rgb.end(), {c.r, c.g, c.b});
    plain->instanceColor = BufferAttribute::fromFloats(rgb, 3);
    dbC.render(renderer, later, camera);
    const std::vector<uint8_t> after = read(renderer, events);
    std::size_t stale = 0, changed = 0;
    for (std::size_t p = 0; p + 3 < after.size() && after.size() == b.size() && before.size() == b.size(); p += 4) {
        int d = 0, moved = 0;
        for (int c = 0; c < 3; ++c) {
            d = std::max(d, std::abs(int(after[p + c]) - int(b[p + c])));
            moved = std::max(moved, std::abs(int(after[p + c]) - int(before[p + c])));
        }
        if (d > 2) ++stale;
        if (moved > 2) ++changed;
    }
    std::printf("instanced colour assigned after a frame: %zu pixels changed, %zu differ from the reference\n", changed,
                stale);
    CHECK(after.size() == b.size() && changed > 1000 && stale == 0);
    CHECK(dbC.diagnostics().empty());
}

// PRD-519 phase 1: a mixed scene renders the same batched and fully unbatched. Automatic batching
// merges opaque plain meshes sharing a geometry and material (at least four) into instanced draws;
// below the minimum, transparent meshes, a different render order and a mesh with a render callback
// stay single. Batching on and off must give the same frame, with fewer draws on.
void batchedVsUnbatched() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(200, 150);
    PerspectiveCamera camera(55, 4.0 / 3, 0.1, 100);
    camera.position.set(0, 3, 13);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);

    Scene scene;
    auto sun = std::make_shared<DirectionalLight>(Color().setHex(0xffffff), 2.2);
    sun->position.set(2, 5, 4);
    auto sky = std::make_shared<HemisphereLight>(Color().setHex(0xc0d0ff), Color().setHex(0x403020), 0.7);
    scene.add(*sun);
    scene.add(*sky);
    auto sphere = makeSphereGeometry(0.5, 20, 14);
    auto box = makeBoxGeometry(0.8, 0.8, 0.8);
    const auto material = [](MaterialType type, uint32_t hex, bool transparent = false) {
        auto m = std::make_shared<Material>(type);
        m->color.setHex(hex);
        if (transparent) {
            m->transparent = true;
            m->opacity = 0.5;
        }
        return m;
    };
    auto standard = material(MaterialType::Standard, 0x88aaee), lambert = material(MaterialType::Lambert, 0xee9955),
         glass = material(MaterialType::Standard, 0x99ffcc, true), single = material(MaterialType::Phong, 0xdddd66);
    std::vector<std::shared_ptr<Mesh>> meshes;
    const auto place = [&](const std::shared_ptr<BufferGeometry>& g, const std::shared_ptr<Material>& m, double x,
                           double y, double z, int order = 0) {
        auto mesh = std::make_shared<Mesh>(g, m);
        mesh->position.set(x, y, z);
        mesh->rotation.set(0.3 * x, 0.2 * y, 0.1 * z);
        mesh->scale.set(1 + 0.05 * x, 1 - 0.03 * y, 1);
        if (order) mesh->setRenderOrder(order);
        scene.add(*mesh);
        meshes.push_back(mesh);
        return mesh;
    };
    for (int i = 0; i < 6; ++i) place(sphere, standard, -5 + i * 2.0, 2.4, 0);       // one batch of six
    for (int i = 0; i < 3; ++i) place(sphere, single, -2 + i * 2.0, -2.6, 1);        // three: below the minimum
    for (int i = 0; i < 5; ++i) place(box, lambert, -4 + i * 2.0, 0.4, -1);          // a second batch of five
    for (int i = 0; i < 4; ++i) place(sphere, glass, -3 + i * 2.0, -0.9, 2.5);       // transparent: never batched
    for (int i = 0; i < 4; ++i) place(box, standard, -3 + i * 2.0, 4.2, -2, 1);      // another render order
    auto watched = place(sphere, standard, 4, -2.6, 1);                              // a callback keeps it single
    int callbacks = 0;
    watched->onBeforeRender = std::make_shared<const std::function<bool(const RenderCallbackArgs&, std::string&)>>(
        [&](const RenderCallbackArgs&, std::string&) { return ++callbacks, true; });

    RenderDatabase database;
    database.batching = false;
    database.render(renderer, scene, camera);
    const auto unbatchedStats = renderer.lastFrame();
    const std::vector<uint8_t> unbatched = read(renderer, events);
    database.batching = true;
    database.render(renderer, scene, camera);
    const auto batchedStats = renderer.lastFrame();
    const auto [groups, members] = database.lastBatches();
    const std::vector<uint8_t> batched = read(renderer, events);

    std::size_t covered = 0, differ = 0;
    int worst = 0;
    for (std::size_t p = 0; p + 3 < batched.size() && batched.size() == unbatched.size(); p += 4) {
        int d = 0;
        for (int c = 0; c < 3; ++c) d = std::max(d, std::abs(int(batched[p + c]) - int(unbatched[p + c])));
        worst = std::max(worst, d);
        if (d > 2) ++differ;
        if (batched[p] + batched[p + 1] + batched[p + 2] > 0) ++covered;
    }
    std::printf("batched vs unbatched: %zu groups of %zu meshes; draws %u vs %u, triangles %llu vs %llu; "
                "%zu covered pixels, %zu differ by more than 2 (worst %d); callback ran %d times\n",
                groups, members, batchedStats.draws, unbatchedStats.draws, (unsigned long long)batchedStats.triangles,
                (unsigned long long)unbatchedStats.triangles, covered, differ, worst, callbacks);
    CHECK(batched.size() == unbatched.size() && !batched.empty());
    CHECK(groups == 3 && members == 6 + 5 + 4);                 // standard spheres, lambert boxes, ordered boxes
    CHECK(batchedStats.draws == unbatchedStats.draws - members + groups);
    CHECK(batchedStats.triangles == unbatchedStats.triangles);
    CHECK(covered > 2000 && differ == 0);
    CHECK(callbacks == 2);                                       // the callback mesh drew in both renders
    for (const std::string& d : database.diagnostics()) std::fprintf(stderr, "%s\n", d.c_str());
    CHECK(database.diagnostics().empty());
}

// PRD-754: the passes a frame replays from recorded bundles draw the pixels the same commands draw when encoded
// directly (setStablePasses(false)), on a lit, shadowed scene across a camera turn that also moves a caster; and the
// turn replays the shadow pass's bundle, since a moved caster is a uniform write.
void stablePassesMatchDirect() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Scene scene;
    auto sun = std::make_shared<DirectionalLight>(Color().setHex(0xffffff), 2.2);
    sun->position.set(2, 6, 4);
    sun->setCastShadow(true);
    scene.add(*sun);
    auto ground = std::make_shared<Mesh>(makeBoxGeometry(12, 0.2, 12), std::make_shared<Material>(MaterialType::Standard));
    ground->position.set(0, -1, 0);
    ground->setReceiveShadow(true);
    scene.add(*ground);
    auto sphere = makeSphereGeometry(0.5, 20, 14);
    auto box = makeBoxGeometry(0.8, 0.8, 0.8);
    std::vector<std::shared_ptr<Mesh>> casters;
    for (int i = 0; i < 5; ++i) {
        auto material = std::make_shared<Material>(i % 2 ? MaterialType::Lambert : MaterialType::Standard);
        material->color.setHex(0x335577u + 0x221100u * uint32_t(i));
        auto mesh = std::make_shared<Mesh>(i % 2 ? box : sphere, material);
        mesh->position.set(-4 + i * 2.0, 0.2 * i, -1 + 0.5 * i);
        mesh->setCastShadow(true);
        mesh->setReceiveShadow(true);
        scene.add(*mesh);
        casters.push_back(mesh);
    }
    PerspectiveCamera camera(55, 4.0 / 3, 0.1, 100);
    const auto pose = [&](int k) {
        camera.position.set(0, 3, 13);
        camera.lookAt(k ? 1.5 : 0, 0, 0);
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld(true);
        casters[2]->position.set(0, k ? 0.9 : 0.4, 0);
    };
    const auto frames = [&](bool stable) {
        Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
        renderer.setSize(200, 150);
        renderer.setStablePasses(stable);
        renderer.setStableRows(stable);
        RenderDatabase database;
        database.shadowMapEnabled = true;
        database.batching = false;
        std::vector<std::vector<uint8_t>> pixels;
        std::vector<Renderer::FrameStats> stats;
        for (int k : {0, 1, 1}) {
            pose(k);
            database.render(renderer, scene, camera);
            stats.push_back(renderer.lastFrame());
            pixels.push_back(read(renderer, events));
        }
        return std::pair{pixels, stats};
    };
    const auto [direct, directStats] = frames(false);
    const auto [stable, stableStats] = frames(true);
    std::size_t differ = 0, covered = 0;
    for (std::size_t f = 0; f < direct.size(); ++f) {
        CHECK(direct[f].size() == stable[f].size() && !direct[f].empty());
        for (std::size_t p = 0; p + 3 < direct[f].size() && direct[f].size() == stable[f].size(); p += 4) {
            differ += direct[f][p] != stable[f][p] || direct[f][p + 1] != stable[f][p + 1] || direct[f][p + 2] != stable[f][p + 2];
            covered += f == 0 && direct[f][p] + direct[f][p + 1] + direct[f][p + 2] > 0;
        }
    }
    std::printf("stable passes vs direct: %zu covered pixels, %zu differ; shadow draws %u/%u, recorded %u then %u, %u\n",
                covered, differ, stableStats[1].shadowDraws, directStats[1].shadowDraws, stableStats[0].shadowRecorded,
                stableStats[1].shadowRecorded, stableStats[2].shadowRecorded);
    CHECK(covered > 2000 && differ == 0);
    // The third frame repeats the second's pose, so the sun keeps its map (#574) and neither arm draws a caster.
    CHECK(stableStats[2].keptShadowMaps == 1 && directStats[2].keptShadowMaps == 1 && stableStats[2].shadowDraws == 0);
    for (std::size_t f = 0; f < 3; ++f) {
        CHECK(stableStats[f].shadowDraws == directStats[f].shadowDraws && (f == 2 || stableStats[f].shadowDraws >= 5));
        CHECK(stableStats[f].shadowTriangles == directStats[f].shadowTriangles);
        CHECK(directStats[f].shadowRecorded == 0);
    }
    CHECK(stableStats[0].shadowRecorded == stableStats[0].shadowDraws);
    CHECK(stableStats[1].shadowRecorded == 0 && stableStats[2].shadowRecorded == 0);
}

// PRD-754: a camera that turns in place culls meshes in and out of view, batched and unbatched. Once each draw has
// been seen, a second lap records nothing in the main pass (rows out of view keep their place with no instances), and
// every frame draws the pixels and three's Info of the depth-order path that re-records.
void cameraCull() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Scene scene;
    auto light = std::make_shared<DirectionalLight>(Color().setHex(0xffffff), 2.0);
    light->position.set(2, 6, 4);
    scene.add(*light);
    auto box = makeBoxGeometry(0.6, 0.6, 0.6);
    auto shared = std::make_shared<Material>(MaterialType::Standard);
    shared->color.setHex(0x88aacc);
    std::vector<std::shared_ptr<Mesh>> meshes;
    for (int i = 0; i < 48; ++i) {  // one batch per material: a ring of boxes around the camera
        const double a = i * 2 * M_PI / 48 + 0.35 * std::sin(i * 1.7);  // uneven, so each step sees another count
        auto mesh = std::make_shared<Mesh>(box, i % 3 ? shared : std::make_shared<Material>(MaterialType::Lambert));
        mesh->position.set(8 * std::cos(a), 0.3 * (i % 4), 8 * std::sin(a));
        scene.add(*mesh);
        meshes.push_back(mesh);
    }
    for (int i = 0; i < 6; ++i) {  // unbatched: each its own geometry
        const double a = (i + 0.5) * 2 * M_PI / 6;
        auto material = std::make_shared<Material>(MaterialType::Standard);
        material->color.setHex(0x553311u + 0x112233u * uint32_t(i));
        auto mesh = std::make_shared<Mesh>(makeSphereGeometry(0.4 + 0.1 * i, 12, 8), material);
        mesh->position.set(5 * std::cos(a), 1, 5 * std::sin(a));
        scene.add(*mesh);
        meshes.push_back(mesh);
    }
    PerspectiveCamera camera(50, 4.0 / 3, 0.1, 100);
    const auto pose = [&](int step) {
        const double yaw = step * 2 * M_PI / 16;
        camera.position.set(0, 1, 0);
        camera.lookAt(std::cos(yaw), 1, std::sin(yaw));
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld(true);
    };
    struct Frame { std::vector<uint8_t> pixels; Renderer::FrameStats stats; std::size_t batches; };
    const auto laps = [&](bool stable, bool post = false) {
        Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
        renderer.setSize(160, 120);
        renderer.setStablePasses(stable);
        renderer.setStableRows(stable);
        if (post) {  // the velocity pass, and a post graph that reads the normal target
            namespace g = shader::graph;
            renderer.setTraa(TraaOptions{});
            renderer.setPostGraph(g::bloom(g::vec4({g::swizzle(g::texture("normal", g::uv()), "x"), g::float_(0), g::float_(0),
                                                    g::float_(0)}), 0, 0, 0));
        }
        RenderDatabase database;
        std::vector<Frame> frames;
        for (int step = 0; step < 32; ++step) {
            pose(step % 16);
            database.render(renderer, scene, camera);
            frames.push_back({read(renderer, events), renderer.lastFrame(), database.lastBatches().first});
        }
        return frames;
    };
    const auto direct = laps(false), stable = laps(true);
    std::size_t differ = 0, covered = 0;
    uint32_t firstLap = 0, secondLap = 0, directRecorded = 0, batches = 0;
    for (std::size_t f = 0; f < direct.size(); ++f) {
        CHECK(direct[f].pixels.size() == stable[f].pixels.size() && !direct[f].pixels.empty());
        for (std::size_t p = 0; p + 3 < direct[f].pixels.size() && direct[f].pixels.size() == stable[f].pixels.size(); p += 4) {
            const auto& d = direct[f].pixels;
            const auto& t = stable[f].pixels;
            differ += d[p] != t[p] || d[p + 1] != t[p + 1] || d[p + 2] != t[p + 2];
            covered += d[p] + d[p + 1] + d[p + 2] > 0;
        }
        CHECK(direct[f].stats.draws == stable[f].stats.draws && direct[f].stats.triangles == stable[f].stats.triangles);
        (f < 16 ? firstLap : secondLap) += stable[f].stats.mainRecorded;
        if (f >= 16) directRecorded += direct[f].stats.mainRecorded;
        batches += uint32_t(stable[f].batches);
    }
    std::printf("camera cull: %zu covered pixels, %zu differ; second lap records %u stable, %u direct (first lap %u); %u batch draws\n",
                covered, differ, secondLap, directRecorded, firstLap, batches);
    CHECK(covered > 20000 && differ == 0);
    CHECK(directRecorded > 0);
    CHECK(secondLap == 0);
    // With the velocity and normal passes on, they replay their bundles too: the second lap records no aux draw.
    const auto postDirect = laps(false, true), postStable = laps(true, true);
    std::size_t postDiffer = 0;
    uint32_t auxSecond = 0, auxDirect = 0, mainSecond = 0;
    for (std::size_t f = 0; f < postDirect.size(); ++f) {
        CHECK(postDirect[f].pixels.size() == postStable[f].pixels.size());
        for (std::size_t p = 0; p + 3 < postDirect[f].pixels.size() && postDirect[f].pixels.size() == postStable[f].pixels.size(); ++p)
            postDiffer += postDirect[f].pixels[p] != postStable[f].pixels[p];
        CHECK(postDirect[f].stats.auxPasses == 1 && postStable[f].stats.auxPasses == 1);
        if (f >= 16) {
            auxSecond += postStable[f].stats.auxRecorded;
            auxDirect += postDirect[f].stats.auxRecorded;
            mainSecond += postStable[f].stats.mainRecorded;
        }
    }
    std::printf("camera cull, velocity and normal passes: %zu bytes differ; second lap records %u aux draws stable "
                "(%u main), %u direct\n", postDiffer, auxSecond, mainSecond, auxDirect);
    CHECK(postDiffer == 0);
    CHECK(auxSecond == 0 && mainSecond == 0);
}

// PRD-518 box 38: the same animated poses and refusals, with batching on and off, including shadows.
void skinnedCrowdPixels() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(320, 180);
    player::SkinnedCrowd crowd;
    auto* bound = static_cast<SkinnedMesh*>(crowd.scene().getObjectByName("walker-0"));
    bound->bindMatrix.makeTranslation(0.15, 0, 0);
    auto* detached = static_cast<SkinnedMesh*>(crowd.scene().getObjectByName("walker-1"));
    detached->attached = false;
    crowd.scene().getObjectByName("walker-2")->scale.setScalar(1.2);
    RenderDatabase database;
    database.shadowMapEnabled = true;
    for (int pose = 0; pose < 3; ++pose) {
        for (int tick = 0; tick < 30; ++tick)
            crowd.update(1.0 / 60);
        database.batching = false;
        database.render(renderer, crowd.scene(), crowd.camera());
        const auto separate = read(renderer, events);
        const auto exactStats = renderer.lastFrame();
        database.batching = true;
        database.render(renderer, crowd.scene(), crowd.camera());
        const auto batched = read(renderer, events);
        const auto stats = renderer.lastFrame();
        CHECK(!batched.empty() && separate.size() == batched.size());
        CHECK(stats.triangles == exactStats.triangles);
        for (const auto& pass : {stats.mainSkinned, stats.shadowSkinned}) {
            CHECK(pass.batches == 1 && pass.draws == 5 && pass.exactDraws == 4 && pass.instances == 64);
        }
        CHECK(exactStats.mainSkinned.draws == 68 && exactStats.shadowSkinned.draws == 68);
        std::size_t covered = 0, differ = 0;
        int worst = 0;
        for (std::size_t p = 0; p + 3 < batched.size() && separate.size() == batched.size(); p += 4) {
            int delta = 0;
            for (int channel = 0; channel < 3; ++channel)
                delta = std::max(delta, std::abs(int(batched[p + channel]) - int(separate[p + channel])));
            worst = std::max(worst, delta);
            differ += delta > 2;
            covered += batched[p] + batched[p + 1] + batched[p + 2] > 0;
        }
        std::printf("skinned crowd pose %d: %zu covered, %zu pixels differ >2, worst %d\n", pose, covered, differ,
                    worst);
        // CPU f32 world-space palettes (world * bindInverse * bone * bind) round differently
        // from the exact shader's model/bind transforms, moving a triangle edge across a pixel
        // centre. The GPU measured 1 pixel >2 levels in each pose; allow at most 4 edge pixels.
        CHECK(covered > 1000 && differ <= 4);
        CHECK(database.diagnostics().empty());
    }
}

// A settled projection decline re-judges every 60 frames, as core's SceneRenderProjection does
// (DECLINE_RESCAN_FRAMES): a crowd blocked by a render hook draws exactly, and once the hook leaves
// it batches on the 60th frame after the declining scan.
void skinnedDeclineCadence() {
    player::SkinnedCrowd crowd(false);
    Mesh hooked(makeBoxGeometry(), std::make_shared<Material>(MaterialType::Standard));
    hooked.onBeforeRender = std::make_shared<const std::function<bool(const RenderCallbackArgs&, std::string&)>>(
        [](const RenderCallbackArgs&, std::string&) { return true; });
    crowd.scene().add(hooked);
    RenderDatabase database;
    LightState lights;
    database.prepare(crowd.scene(), crowd.camera(), lights);
    CHECK(database.lastBatches().first == 0);
    crowd.scene().remove(hooked);
    int frames = 0;
    do {
        database.prepare(crowd.scene(), crowd.camera(), lights);
        ++frames;
    } while (database.lastBatches().first == 0 && frames < 100);
    std::printf("skinned decline cadence: batched %d frames after the declining scan\n", frames);
    CHECK(frames == 60);
    crowd.scene().add(hooked);
    database.prepare(crowd.scene(), crowd.camera(), lights);
    CHECK(database.lastBatches().first == 0);
}

// PRD-613: a projecting decision holds while the scene's structure does, re-judged on the same 60-frame
// cadence as a decline (hostProjectionReport's rule). Moving bones and rigs re-decide nothing; adding or
// removing an object does. Every frame batches as a fresh decision would.
void skinnedProjectingCadence() {
    player::SkinnedCrowd crowd(false);
    RenderDatabase database;
    LightState lights;
    const auto fresh = [&] {
        RenderDatabase once;
        LightState l;
        once.prepare(crowd.scene(), crowd.camera(), l);
        return once.lastBatches();
    };
    database.prepare(crowd.scene(), crowd.camera(), lights);
    CHECK(database.lastBatches().first > 0);
    CHECK(database.batchDecisions() == 1);
    for (int frame = 1; frame < 59; ++frame) {
        crowd.update(1.0 / 60);
        database.prepare(crowd.scene(), crowd.camera(), lights);
        CHECK(database.lastBatches() == fresh());
    }
    CHECK(database.batchDecisions() == 1);
    Mesh box(makeBoxGeometry(), std::make_shared<Material>(MaterialType::Standard));
    crowd.scene().add(box);
    database.prepare(crowd.scene(), crowd.camera(), lights);
    CHECK(database.batchDecisions() == 2);
    CHECK(database.lastBatches() == fresh());
    crowd.scene().remove(box);
    database.prepare(crowd.scene(), crowd.camera(), lights);
    CHECK(database.batchDecisions() == 3);
    for (int frame = 1; frame < 60; ++frame) database.prepare(crowd.scene(), crowd.camera(), lights);
    CHECK(database.batchDecisions() == 3);
    database.prepare(crowd.scene(), crowd.camera(), lights);  // the 60th frame since the last decision
    CHECK(database.batchDecisions() == 4);
    CHECK(database.lastBatches() == fresh());
}

// PRD-526: glTF stores WEIGHTS_0 as normalized unsigned bytes. The shader reads vec4<f32>, so the
// vertex format must be Unorm8x4: bound as Float32x4 the buffer reads as zeros and the rig vanishes.
void skinnedNormalizedWeights() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(320, 180);
    player::SkinnedCrowd crowd;
    RenderDatabase database;
    database.batching = false;
    database.render(renderer, crowd.scene(), crowd.camera());
    const auto floats = read(renderer, events);
    auto* walker = static_cast<SkinnedMesh*>(crowd.scene().getObjectByName("walker-0"));
    const auto weights = walker->geometry->attributes.at("skinWeight");
    std::vector<double> bytes;
    for (uint64_t i = 0; i < weights->count() * 4; ++i)
        bytes.push_back(std::round(weights->getComponent(i / 4, int(i % 4)) * 255));
    walker->geometry->setAttribute("skinWeight", BufferAttribute::fromDoubles(Scalar::U8, bytes, 4, true));
    database.render(renderer, crowd.scene(), crowd.camera());
    const auto normalized = read(renderer, events);
    CHECK(!floats.empty() && floats.size() == normalized.size());
    std::size_t covered = 0, differ = 0;
    for (std::size_t p = 0; p + 3 < floats.size(); p += 4) {
        int delta = 0;
        for (int channel = 0; channel < 3; ++channel)
            delta = std::max(delta, std::abs(int(floats[p + channel]) - int(normalized[p + channel])));
        differ += delta > 8;
        covered += floats[p] + floats[p + 1] + floats[p + 2] > 0;
    }
    std::printf("normalized skin weights: %zu covered pixels, %zu differ by more than 8 levels\n", covered, differ);
    // One-in-255 weight rounding moves a few edge pixels; a vanished rig would differ by thousands.
    CHECK(covered > 1000 && differ <= 40);
}

// PRD-526: a tangent-space normalMap bends the lit normal along the uv axes (three's perturbNormal2Arb).
// A plane facing the camera: lit from +x, a map tilting every normal toward +x (red high) brightens it,
// one tilting away darkens it, and no map sits between; lit from +y the same holds for green, whose
// direction is where dFdy's sign shows. The same maps as a loaded `Texture` (mipmapped) must agree
// with the DataTexture (one level). Each arm's textures are destroyed before the next arm builds its
// own: the renderer's texture cache must not serve a dead texture's image to one built at its address.
struct ScopeVerdict {
    std::atomic<bool> done{false};
    WGPUErrorType type = WGPUErrorType_NoError;
    std::string message;
    bool popSucceeded = false;

    bool clean() const { return done && popSucceeded && type == WGPUErrorType_NoError; }
};

#if WGPU_USES_CALLBACK_INFO_PATTERN
void onScopePopped(WGPUPopErrorScopeStatus status, WGPUErrorType type, WGPUStringView message, void* verdict, void*) {
    auto& result = *static_cast<ScopeVerdict*>(verdict);
    result.popSucceeded = status == WGPUPopErrorScopeStatus_Success;
    result.type = type;
    if (message.data) result.message.assign(message.data, message.length);
    result.done = true;
}
#else
void onScopePopped(WGPUErrorType type, const char* message, void* verdict) {
    auto& result = *static_cast<ScopeVerdict*>(verdict);
    // This legacy callback API exposes no pop status; callback delivery is its only completion signal.
    result.popSucceeded = true;
    result.type = type;
    if (message) result.message = message;
    result.done = true;
}
#endif

void popScope(WGPUDevice device, Renderer& r, EventQueue& events, ScopeVerdict& verdict) {
#if WGPU_USES_CALLBACK_INFO_PATTERN
    WGPUPopErrorScopeCallbackInfo callbackInfo = {};
    callbackInfo.mode = WGPUCallbackMode_AllowSpontaneous;
    callbackInfo.callback = onScopePopped;
    callbackInfo.userdata1 = &verdict;
    (void)wgpuDevicePopErrorScope(device, callbackInfo);
#else
    wgpuDevicePopErrorScope(device, onScopePopped, &verdict);
#endif
    for (int i = 0; i < 4000 && !verdict.done; ++i) {
        r.poll();
        events.drain();
        if (!verdict.done) std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
}

void normalMapTilt() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(160, 120);
    renderer.setOutput(OutputState{std::nullopt, 1, true});
    struct Tilt { int red, green; bool loaded; };  // red < 0: no map
    auto brightness = [&](const char* label, Tilt tilt, std::array<double, 3> lightAt) {
        Scene scene;
        PerspectiveCamera camera;
        camera.fov = 40; camera.aspect = 4.0 / 3; camera.near = 0.1; camera.far = 50;
        camera.position.z = 3;
        camera.lookAt(0, 0, 0);
        camera.updateProjectionMatrix();
        auto material = std::make_shared<Material>(MaterialType::Standard);
        material->roughness = 1;
        if (tilt.red >= 0) {
            std::vector<double> texels;
            for (int i = 0; i < 4; ++i) texels.insert(texels.end(), {double(tilt.red), double(tilt.green), 220, 255});
            if (tilt.loaded) {
                auto map = std::make_shared<Texture>();  // what the glTF loader makes: mipmapped, not a DataTexture
                map->width = map->height = 2;
                map->flipY = false;
                for (double v : texels) map->data.push_back(static_cast<uint8_t>(v));
                map->needsUpdate();
                material->maps["normalMap"] = map;
            } else {
                auto map = std::make_shared<DataTexture>();
                map->setImage(texels, "Uint8Array", 2, 2, kTextureRGBAFormat, kTextureUnsignedByteType);
                map->needsUpdate();
                material->maps["normalMap"] = map;
            }
        }
        Mesh plane(makePlaneGeometry(3, 3), material);
        DirectionalLight light{Color().setHex(0xffffff), 3};
        light.position.set(lightAt[0], lightAt[1], lightAt[2]);
        scene.add(plane);
        scene.add(light);
        scene.updateMatrixWorld(true);
        RenderDatabase database;
        const WGPUDevice device = context.getDevice();
        wgpuDevicePushErrorScope(device, WGPUErrorFilter_Validation);
        database.render(renderer, scene, camera, {0, 0, 0, 1});
        CHECK(database.diagnostics().empty());
        const auto px = read(renderer, events);
        ScopeVerdict verdict;
        popScope(device, renderer, events, verdict);
        if (!verdict.clean())
            std::fprintf(stderr, "normal map arm %s WebGPU validation error: %s\n", label, verdict.message.c_str());
        CHECK(verdict.clean());
        CHECK(px.size() == 160 * 120 * 4);
        double sum = 0;
        for (int y = 40; y < 80; ++y)
            for (int x = 60; x < 100; ++x) sum += px[(size_t(y) * 160 + x) * 4 + 1];
        return sum / (40 * 40);
    };
    const std::array<double, 3> fromRight{4, 0, 2}, fromAbove{0, 4, 2};
    const double none = brightness("none-x", {-1, 128, false}, fromRight);
    const double toward = brightness("data-red-toward", {191, 128, false}, fromRight);
    const double away = brightness("data-red-away", {64, 128, false}, fromRight);
    const double noneUp = brightness("none-y", {-1, 128, false}, fromAbove);
    const double up = brightness("data-green-up", {128, 191, false}, fromAbove);
    const double down = brightness("data-green-down", {128, 64, false}, fromAbove);
    const double loadedToward = brightness("loaded-red-toward", {191, 128, true}, fromRight);
    const double loadedUp = brightness("loaded-green-up", {128, 191, true}, fromAbove);
    std::printf("normal map tilt: x %.1f/%.1f/%.1f, y %.1f/%.1f/%.1f, loaded %.1f/%.1f\n", toward, none, away, up, noneUp, down,
                loadedToward, loadedUp);
    CHECK(toward > none + 8 && none > away + 8);
    CHECK(up > noneUp + 8 && noneUp > down + 8);  // green: the dFdy sign
    CHECK(std::abs(loadedToward - toward) < 2 && std::abs(loadedUp - up) < 2);
    brightness("final-sweep", {-1, 128, false}, fromRight);  // sweep the last arm's dead texture too
    CHECK(renderer.materialTextureCount() == 0);  // no dead texture's GPU copy is kept
}

// three's WebGPUTextureUtils builds a map's mip chain on the GPU: only level 0 crosses from the CPU,
// and an sRGB map filters in linear light. A 16x16 sRGB map with one white texel per 4x4 block, drawn
// at 4:1, reads level 2: 1/16 in linear light is sRGB 71. Level 0 alone reads 0; averaging the
// encoded bytes reads 16.
void gpuMipmaps() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(4, 4);
    renderer.setOutput(OutputState{std::nullopt, 1, true});
    auto map = std::make_shared<Texture>();
    map->width = map->height = 16;
    map->colorSpace = TextureColorSpace::SRGB;
    for (uint32_t y = 0; y < 16; ++y)
        for (uint32_t x = 0; x < 16; ++x) {
            const uint8_t v = x % 4 == 0 && y % 4 == 0 ? 255 : 0;
            map->data.insert(map->data.end(), {v, v, v, 255});
        }
    map->needsUpdate();
    auto material = std::make_shared<Material>(MaterialType::Basic);
    material->maps["map"] = map;
    Scene scene;
    OrthographicCamera camera(-1, 1, 1, -1, 0.1, 10);
    camera.position.z = 2;
    camera.updateProjectionMatrix();
    Mesh plane(makePlaneGeometry(2, 2), material);
    scene.add(plane);
    scene.updateMatrixWorld(true);
    RenderDatabase database;
    database.render(renderer, scene, camera, {0, 0, 0, 1});
    CHECK(database.diagnostics().empty());
    const auto px = read(renderer, events);
    CHECK(px.size() == 4 * 4 * 4);
    std::fprintf(stderr, "gpu mipmaps: centre %d, %llu texture bytes uploaded\n", px[(1 * 4 + 1) * 4],
                 static_cast<unsigned long long>(renderer.textureUploadBytes()));
    for (size_t i = 0; i < px.size(); i += 4) CHECK(std::abs(int(px[i]) - 71) <= 2);
    CHECK(renderer.textureUploadBytes() == 16 * 16 * 4);  // level 0 only
    // A render target draws the same map from the same upload, as three's one renderer does.
    const auto target = RenderTarget::make(4, 4, kTextureUnsignedByteType);
    CHECK(renderToTarget(renderer, *target, scene, camera, {0, 0, 0, 1}, false).empty());
    std::fprintf(stderr, "gpu mipmaps: %llu texture bytes after a render target\n",
                 static_cast<unsigned long long>(renderer.textureUploadBytes()));
    CHECK(renderer.textureUploadBytes() == 16 * 16 * 4);
    // A host image (the web host's ImageBitmap) reaches level 0 through the host's copy, never as
    // bytes from here, and gets the same GPU chain. Without the host's copy it is refused by name.
    auto hosted = std::make_shared<Texture>();
    hosted->width = hosted->height = 16;
    hosted->colorSpace = TextureColorSpace::SRGB;
    hosted->flipY = false;  // as GLTFLoader sets it
    hosted->external = std::make_shared<const ExternalImage>(3, 16, 16, nullptr);
    hosted->needsUpdate();
    std::vector<uint32_t> copied;
    renderer.setExternalImageCopy([&](uint32_t image, WGPUTexture gpu, bool flipY) {
        copied.push_back(image);
        WGPUImageCopyTexture_Compat destination = {};
        destination.texture = gpu;
        destination.aspect = WGPUTextureAspect_All;
        WGPUTextureDataLayout_Compat layout = {};
        layout.bytesPerRow = 16 * 4;
        layout.rowsPerImage = 16;
        const WGPUExtent3D extent = {16, 16, 1};
        wgpuQueueWriteTexture(context.getQueue(), &destination, map->data.data(), map->data.size(), &layout, &extent);
        return !flipY;
    });
    material->maps["map"] = hosted;
    database.render(renderer, scene, camera, {0, 0, 0, 1});
    CHECK(database.diagnostics().empty());
    const auto fromHost = read(renderer, events);
    CHECK(copied == std::vector<uint32_t>{3});
    for (size_t i = 0; i < fromHost.size(); i += 4) CHECK(std::abs(int(fromHost[i]) - 71) <= 2);
    CHECK(renderer.textureUploadBytes() == 16 * 16 * 4);  // nothing more crossed from the CPU
    Renderer bare(context.getInstance(), context.getDevice(), context.getQueue(), events);
    bare.setSize(4, 4);
    RenderDatabase bareDatabase;
    bool named = false;
    try {
        bareDatabase.render(bare, scene, camera, {0, 0, 0, 1});
    } catch (const std::runtime_error& error) {
        named = std::string(error.what()).rfind("TN_NATIVE_TEXTURE_UNSUPPORTED", 0) == 0;
    }
    CHECK(named);
}

// PRD-526 review: a decoded map the standard program does not read is refused by name, never drawn without it.
void unsupportedMapSlot() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(64, 48);
    LitScene s;
    auto rough = std::make_shared<Material>(MaterialType::Standard);
    auto map = std::make_shared<DataTexture>();
    map->setImage({255, 255, 255, 255}, "Uint8Array", 1, 1, kTextureRGBAFormat, kTextureUnsignedByteType);
    rough->maps["lightMap"] = map;  // roughnessMap is read now (PRD-530); lightMap still is not
    Mesh refused{s.geometry, rough};
    refused.position.x = 1;
    s.scene.add(refused);
    RenderDatabase database;
    database.render(renderer, s.scene, s.camera);
    bool named = false;
    for (const std::string& d : database.diagnostics())
        named = named || (d.rfind("TN_NATIVE_MATERIAL_UNSUPPORTED", 0) == 0 && d.find("lightMap") != std::string::npos);
    CHECK(named);
    CHECK(database.diagnostics().size() == 1);  // the plain mesh beside it is not refused
}

// PRD-635: a decoded envMap (a sphere reflection capture) is read by the standard program through the PMREM
// path, so a material that carries one is drawn, not refused with the maps the program does not read.
void envMapSlotIsRead() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(64, 48);
    LitScene s;
    auto mirror = std::make_shared<Material>(MaterialType::Standard);
    auto env = std::make_shared<DataTexture>();
    env->width = 128;
    env->height = 64;
    env->mapping = 303;  // EquirectangularReflectionMapping; the PMREM needs 64 px or more
    env->colorSpace = TextureColorSpace::SRGB;
    env->minFilter = static_cast<uint16_t>(TextureFilter::LinearMipmapLinear);
    env->magFilter = static_cast<uint16_t>(TextureFilter::Linear);
    env->data.resize(128 * 64 * 4, 255);
    env->needsUpdate();
    mirror->maps["envMap"] = env;
    Mesh drawn{s.geometry, mirror};
    drawn.position.x = 1;
    s.scene.add(drawn);
    RenderDatabase database;
    database.render(renderer, s.scene, s.camera);
    for (const std::string& d : database.diagnostics()) std::fprintf(stderr, "%s\n", d.c_str());
    CHECK(database.diagnostics().empty());
}

// PRD-526 review: the float32 copies of quantized attributes follow their sources. A scene that loads and
// unloads quantized geometry must not keep one copy per geometry it ever saw.
void convertedCopiesAreSwept() {
    RenderDatabase database;
    PerspectiveCamera camera;
    camera.updateProjectionMatrix();
    // Each round's attribute stays allocated (a distinct key) while its store is replaced, so the old
    // source is gone but its table entry is not overwritten by an address reuse.
    std::vector<std::shared_ptr<BufferAttribute>> retained;
    for (int round = 0; round < 300; ++round) {
        Scene scene;
        auto geometry = makeBoxGeometry(1, 1, 1);
        const auto normals = geometry->attributes.at("normal");
        std::vector<double> quantized;
        for (uint64_t i = 0; i < normals->count(); ++i)
            for (int c = 0; c < 3; ++c) quantized.push_back(std::round(normals->getComponent(i, c) * 127));
        auto attribute = BufferAttribute::fromDoubles(Scalar::I8, quantized, 3, true);
        geometry->setAttribute("normal", attribute);
        retained.push_back(attribute);
        auto material = std::make_shared<Material>(MaterialType::Standard);
        Mesh mesh(geometry, material);
        scene.add(mesh);
        scene.updateMatrixWorld(true);
        LightState lights;
        const auto items = database.prepare(scene, camera, lights);
        CHECK(items.size() == 1 && items[0].normals != nullptr);
        CHECK(items[0].normals->scalar() == Scalar::F32);  // the renderer is handed floats
        attribute->store = std::make_shared<BufferStore>(Scalar::I8, 3);  // the source dies
    }
    std::printf("converted copies held after 300 geometries: %zu\n", database.convertedCount());
    CHECK(database.convertedCount() <= 130);
}

// The frame's GPU time starts at its first shadow pass, which runs before the scene pass; before the
// fix it started at the scene pass and a shadowed scene's shadow work was never timed.
void gpuTimerCoversShadows() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(64, 48);
    if (!wgpuDeviceHasFeature(context.getDevice(), WGPUFeatureName_TimestampQuery)) {
        std::printf("no timestamp-query on this device: nothing to time\n");
        return;
    }
    for (const bool shadows : {true, false}) {
        LitScene s;
        s.light.setCastShadow(shadows);
        s.mesh.setCastShadow(shadows);
        RenderDatabase database;
        database.shadowMapEnabled = shadows;
        renderer.setGpuTimer(true);
        const uint64_t before = renderer.gpuSamples();
        // A sample is read back asynchronously: render a few frames, as a game does, until one lands.
        for (int frame = 0; frame < 8 && renderer.gpuSamples() == before; ++frame) {
            database.render(renderer, s.scene, s.camera);
            while (renderer.gpu().completedSerial() < renderer.gpu().submittedSerial()) {
                renderer.poll();
                events.drain();
            }
            const auto until = std::chrono::steady_clock::now() + std::chrono::milliseconds(250);
            while (renderer.gpuSamples() == before && std::chrono::steady_clock::now() < until) {
                renderer.poll();
                events.drain();
            }
        }
        CHECK(renderer.gpuSamples() > before);  // a timestamp-query device times the frame
        CHECK(renderer.gpuTimerBeganAtShadow() == shadows);
    }
}

// PRD-650: the lamp maps' GPU time is its own segment, apart from the sun's, and the segments sum to the frame.
void gpuTimerSplitsLampShadows() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(96, 96);
    if (!wgpuDeviceHasFeature(context.getDevice(), WGPUFeatureName_TimestampQuery)) {
        std::printf("no timestamp-query on this device: nothing to time\n");
        return;
    }
    OrthographicCamera camera(-4, 4, 4, -4, 0.1, 20);
    camera.position.set(0, 10, 0.001);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    Scene scene;
    SpotLight spot{Color(1, 1, 1), 40, 6, 0.9};
    spot.position.set(1.5, 3, 0);
    spot.target->position.set(1.5, 0, 0);
    spot.setCastShadow(true);
    scene.add(spot);
    scene.add(*spot.target);
    DirectionalLight sun{Color(1, 1, 1), 2};
    sun.position.set(2, 8, 1);
    sun.setCastShadow(true);
    scene.add(sun);
    auto white = std::make_shared<Material>(MaterialType::Standard);
    Mesh floor{makeBoxGeometry(8, 0.2, 8), white};
    floor.position.y = -0.1;
    floor.setReceiveShadow(true);
    scene.add(floor);
    Mesh box{makeBoxGeometry(0.6, 0.6, 0.6), white};
    box.position.set(1.5, 1, 0);
    box.setCastShadow(true);
    scene.add(box);
    // A caster beyond the spot's range that moves: the sun's map redraws while the lamp's stays cached.
    Mesh far{makeBoxGeometry(0.2, 0.2, 0.2), white};
    far.position.set(-4, 0.3, -2.5);  // 6.6 m from the spot (range 6), inside the sun's shadow camera
    far.setCastShadow(true);
    scene.add(far);
    RenderDatabase database;
    database.shadowMapEnabled = true;
    renderer.setGpuTimer(true);
    // One frame and its own GPU sample: wait for the frame's readback before the next frame.
    const auto timed = [&] {
        const uint64_t before = renderer.gpuSamples();
        scene.updateMatrixWorld(true);
        database.render(renderer, scene, camera);
        const auto until = std::chrono::steady_clock::now() + std::chrono::milliseconds(2000);
        while (renderer.gpuSamples() == before && std::chrono::steady_clock::now() < until) {
            renderer.poll();
            events.drain();
        }
        CHECK(renderer.gpuSamples() > before);
        const auto segments = renderer.lastGpuSegments();
        CHECK(std::abs(std::accumulate(segments.begin(), segments.end(), 0.0) - renderer.lastGpuMs()) < 1e-9);
        return segments;
    };
    const auto first = timed();
    std::printf("lamp gpu: first frame sun %.4f ms, lamps %.4f ms (%u maps)\n", first[0], first[kGpuLampShadowSegment], renderer.lastFrame().lampRedraws);
    CHECK(renderer.lastFrame().lampRedraws == 1);
    CHECK(first[0] > 0 && first[kGpuLampShadowSegment] > 0);
    far.position.x = -4.1;
    const auto cached = timed();
    std::printf("lamp gpu: cached frame sun %.4f ms, lamps %.4f ms (%u maps)\n", cached[0], cached[kGpuLampShadowSegment], renderer.lastFrame().lampRedraws);
    CHECK(renderer.lastFrame().lampRedraws == 0);
    CHECK(cached[0] > 0 && cached[kGpuLampShadowSegment] == 0);
}

// Secondary targets and the main scene must resolve as one complete GPU sample.
void gpuTimerCoversOffscreen() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(64, 48);
    if (!wgpuDeviceHasFeature(context.getDevice(), WGPUFeatureName_TimestampQuery)) {
        CHECK(!renderer.gpuTimerEnabled() && renderer.lastGpuMs() < 0);
        return;
    }
    LitScene s;
    RenderDatabase database;
    const auto target = RenderTarget::make(32, 24, kTextureHalfFloatType);
    renderer.setGpuTimer(true);
    const auto unrequestedBefore = waste::counters().gpuTimestampUnrequestedSamples.load();
    for (const bool deferred : {false, true}) {
        waste::setDebugEnabled(deferred);
        renderer.setDebugTimestampRequested(false);
        const auto before = renderer.gpuSamples();
        renderer.setGpuTimerSourceFrame(deferred ? 42 : 41);
        CHECK(renderToTarget(renderer, *target, s.scene, s.camera, {}, false, deferred).empty());
        database.render(renderer, s.scene, s.camera);
        const auto until = std::chrono::steady_clock::now() + std::chrono::seconds(2);
        while (renderer.gpuSamples() == before && std::chrono::steady_clock::now() < until) {
            renderer.poll();
            events.drain();
        }
        CHECK(renderer.gpuSamples() == before + 1);
        CHECK(waste::counters().gpuTimestampUnrequestedSamples.load() == unrequestedBefore + (deferred ? 1 : 0));
        CHECK(renderer.gpuSourceFrame() == (deferred ? 42 : 41));
        // Two scene passes and one output pass: the offscreen sibling's image is read through its
        // scene colour, so it records no output pass of its own (a0ecc6f0d).
        CHECK(renderer.gpuTimestampPasses() == 3);
        CHECK(renderer.lastGpuMs() > 0);
        const auto segments = renderer.lastGpuSegments();
        CHECK(segments[1] > 0 && segments[2] > 0 && segments[3] > 0);
        CHECK(segments[4] == 0);  // nothing is labelled as the screen-space gather here
        CHECK(renderer.lastGpuMs() == segments[0] + segments[1] + segments[2] + segments[3] + segments[4]);
    }
    waste::setDebugEnabled(false);
    renderer.setDebugTimestampRequested(true);
    // A separately submitted compute encoder is part of the next rendered frame too.
    namespace g = shader::graph;
    auto values = BufferAttribute::fromFloats({0}, 1);
    auto storage = g::storage("gpuTimerCompute", shader::Type::f32());
    storage.object = values;
    g::Block body;
    body.assign(storage.element(g::instanceIndex()), g::float_(1));
    const auto before = renderer.gpuSamples();
    renderer.dispatchCompute(ComputeDispatch::of(g::computeNode(body.node(), 1)));
    database.render(renderer, s.scene, s.camera);
    const auto until = std::chrono::steady_clock::now() + std::chrono::seconds(2);
    while (renderer.gpuSamples() == before && std::chrono::steady_clock::now() < until) {
        renderer.poll();
        events.drain();
    }
    CHECK(renderer.gpuSamples() == before + 1);
    CHECK(renderer.gpuTimestampPasses() == 3);  // compute, main scene, output
}

// A post pass the author labels with a stage reports its GPU time under that stage's segment, not under "other
// passes", and the segments still add up to the frame (web_host.cpp exports each as a `tnw_web_frame` field).
void gpuTimerSplitsTheLabelledGather() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(64, 48);
    if (!wgpuDeviceHasFeature(context.getDevice(), WGPUFeatureName_TimestampQuery)) {
        std::printf("no timestamp-query on this device: nothing to time\n");
        return;
    }
    namespace g = shader::graph;
    LitScene s;
    RenderDatabase database;
    renderer.setGpuTimer(true);
    for (const uint8_t stage : {g::kStageNone, g::kStageScreenSpaceGi}) {
        const auto live = g::uniform("gatherColour", shader::Type::vec(4), {0.25f, 0.5f, 0.75f, 1});
        auto rtt = std::make_shared<g::NodeData>();
        rtt->kind = g::Kind::RenderTexture;
        rtt->type = shader::Type::vec(4);
        rtt->name = stage == g::kStageNone ? "rtt_unlabelled" : "rtt_gather";
        rtt->args = {live, g::uv()};
        rtt->rtt = std::make_shared<g::RttState>();
        auto& state = *rtt->rtt;
        state.width = state.height = 32;
        state.stage = stage;
        state.target = RenderTarget::make(32, 24, kTextureHalfFloatType);
        state.source = live;
        state.quad = std::make_shared<Mesh>(makePlaneGeometry(2, 2), std::make_shared<Material>(MaterialType::Basic, true));
        state.material = state.quad->material;
        state.material->rawNodeMaterial = true;
        state.material->nodes.fragmentNode = live;
        renderer.setPostGraph(rtt);
        const uint64_t before = renderer.gpuSamples();
        // A sample is read back asynchronously: render a few frames, as a game does, until one lands.
        for (int frame = 0; frame < 8 && renderer.gpuSamples() == before; ++frame) {
            database.render(renderer, s.scene, s.camera);
            while (renderer.gpu().completedSerial() < renderer.gpu().submittedSerial()) {
                renderer.poll();
                events.drain();
            }
            const auto until = std::chrono::steady_clock::now() + std::chrono::milliseconds(250);
            while (renderer.gpuSamples() == before && std::chrono::steady_clock::now() < until) {
                renderer.poll();
                events.drain();
            }
        }
        CHECK(renderer.gpuSamples() > before);
        const auto segments = renderer.lastGpuSegments();
        CHECK(segments[1] > 0 && segments[3] > 0);  // the scene pass and the output pass
        if (stage == g::kStageNone) CHECK(segments[2] > 0 && segments[4] == 0);  // the pass counts as an other pass
        else CHECK(segments[4] > 0);                                            // the labelled pass has its own segment
        CHECK(renderer.lastGpuMs() == segments[0] + segments[1] + segments[2] + segments[3] + segments[4]);
    }
}

// PRD-554: blitTo draws a UI overlay's premultiplied frame "over" the world, a steady overlay (the
// same version) uploads nothing, and removing it gives the world back.
void overlayOverFrame() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(16, 16);
    LitScene s;
    RenderDatabase database;
    const Handle target = renderer.gpu().createTexture(
        16, 16, WGPUTextureFormat_RGBA8Unorm, WGPUTextureUsage(WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_CopySrc));
    WGPUTextureViewDescriptor viewDesc = {};
    viewDesc.dimension = WGPUTextureViewDimension_2D;
    viewDesc.mipLevelCount = 1;
    viewDesc.arrayLayerCount = 1;
    WGPUTextureView view = wgpuTextureCreateView(renderer.gpu().texture(target), &viewDesc);
    const auto frame = [&] {
        database.render(renderer, s.scene, s.camera);
        CHECK(renderer.blitTo(context.getQueue(), view, WGPUTextureFormat_RGBA8Unorm));
        const std::vector<uint8_t> pixels = readTexture(renderer, events, target);
        CHECK(pixels.size() == 16 * 16 * 4);
        const size_t at = (8 * 16 + 8) * 4;  // the centre: the lit sphere
        return std::array<int, 4>{pixels[at], pixels[at + 1], pixels[at + 2], pixels[at + 3]};
    };
    const auto world = frame();
    std::vector<uint8_t> page(4 * 4 * 4);
    for (size_t i = 0; i < page.size(); i += 4) page[i] = page[i + 3] = 128;  // half-covering red, premultiplied
    renderer.setOverlay(page.data(), 4, 4, 1);
    const auto over = frame();
    const auto blend = [](int overlay, int below) { return overlay + below * (255 - 128) / 255; };
    std::fprintf(stderr, "overlay: world %d,%d,%d,%d -> %d,%d,%d,%d\n", world[0], world[1], world[2], world[3], over[0],
                 over[1], over[2], over[3]);
    CHECK(std::abs(over[0] - blend(128, world[0])) <= 2);
    CHECK(std::abs(over[1] - blend(0, world[1])) <= 2);
    CHECK(std::abs(over[2] - blend(0, world[2])) <= 2);
    // A desktop web view's B,G,R,A rows with padding are the same page.
    std::vector<uint8_t> padded(4 * (4 * 4 + 8));
    for (size_t y = 0; y < 4; ++y)
        for (size_t x = 0; x < 4; ++x) padded[y * 24 + x * 4 + 2] = padded[y * 24 + x * 4 + 3] = 128;
    renderer.setOverlay(padded.data(), 4, 4, 7, 24, true);
    CHECK(frame() == over);
    renderer.setOverlay(page.data(), 4, 4, 1);
    // A screenshot reads the presented frame, the page over the world.
    std::vector<uint8_t> presented;
    bool read = false;
    CHECK(renderer.readPresented([&](GpuStatus status, std::vector<uint8_t> pixels) {
        if (status == GpuStatus::Ok) presented = std::move(pixels);
        read = true;
    }) == GpuStatus::Ok);
    for (int i = 0; i < 4000 && !read; ++i) {
        renderer.poll();
        events.drain();
    }
    const size_t centre = (8 * 16 + 8) * 4;
    CHECK(presented.size() == 16 * 16 * 4 && presented[centre] == over[0] && presented[centre + 1] == over[1]);
    const uint64_t uploads = renderer.overlayUploads();
    renderer.setOverlay(page.data(), 4, 4, 1);
    frame();
    CHECK(renderer.overlayUploads() == uploads);  // the same version: no copy
    renderer.setOverlay(page.data(), 4, 4, 2);
    CHECK(renderer.overlayUploads() == uploads + 1);
    renderer.setOverlay(nullptr, 0, 0, 0);
    const auto back = frame();
    CHECK(back == world);
    wgpuTextureViewRelease(view);
}

// A timed frame resolves its query set and reads it back; only a caller of lastGpuMs wants that, so
// a renderer times nothing until it is asked.
void gpuTimerIsOptIn() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(64, 48);
    if (!wgpuDeviceHasFeature(context.getDevice(), WGPUFeatureName_TimestampQuery)) {
        std::printf("no timestamp-query on this device: nothing to time\n");
        return;
    }
    LitScene s;
    RenderDatabase database;
    const auto frames = [&](int count) {
        for (int frame = 0; frame < count; ++frame) {
            database.render(renderer, s.scene, s.camera);
            const auto until = std::chrono::steady_clock::now() + std::chrono::milliseconds(60);
            while (std::chrono::steady_clock::now() < until) {
                renderer.poll();
                events.drain();
            }
        }
    };
    frames(6);
    CHECK(renderer.gpuSamples() == 0 && renderer.lastGpuMs() < 0);  // the default frame is untimed
    renderer.setGpuTimer(true);
    for (int attempt = 0; attempt < 10 && renderer.gpuSamples() == 0; ++attempt)  // a sample lands asynchronously, later under load
        frames(2);
    CHECK(renderer.gpuSamples() > 0 && renderer.lastGpuMs() >= 0);
}

void msaaEdges() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(32, 32);

    auto geometry = std::make_shared<BufferGeometry>();
    const std::vector<double> positions = {
        -1.0, -1.0, 0.0,
         1.0, -1.0, 0.0,
         1.0,  1.0, 0.0,
    };
    geometry->setAttribute("position", BufferAttribute::fromFloats(positions, 3));

    auto material = std::make_shared<Material>(MaterialType::Basic);
    material->color.setRGB(1.0, 1.0, 1.0);
    Scene scene;
    Mesh mesh(geometry, material);
    scene.add(mesh);

    OrthographicCamera camera(-1, 1, 1, -1, 0.1, 10);
    camera.position.z = 2;
    camera.updateProjectionMatrix();
    scene.updateMatrixWorld(true);

    RenderDatabase database;

    // 1x sample count
    renderer.setSampleCount(1);
    database.render(renderer, scene, camera, {0, 0, 0, 1});
    CHECK(database.diagnostics().empty());
    const auto px1x = read(renderer, events);
    CHECK(px1x.size() == 32 * 32 * 4);
    for (size_t i = 0; i < px1x.size(); i += 4) {
        const uint8_t r = px1x[i];
        CHECK(r == 0 || r == 255);
    }

    // 4x sample count
    renderer.setSampleCount(4);
    database.render(renderer, scene, camera, {0, 0, 0, 1});
    CHECK(database.diagnostics().empty());
    const auto px4x = read(renderer, events);
    CHECK(px4x.size() == 32 * 32 * 4);
    int edgePixels = 0;
    for (size_t i = 0; i < px4x.size(); i += 4) {
        const uint8_t r = px4x[i];
        if (r > 20 && r < 235) {
            ++edgePixels;
        }
    }
    std::fprintf(stderr, "msaa edges: 4x edge pixel count = %d\n", edgePixels);
    CHECK(edgePixels >= 8);

    // Pipeline cache never mixes counts: render 1x, then 4x, then 1x again
    renderer.setSampleCount(1);
    database.render(renderer, scene, camera, {0, 0, 0, 1});
    CHECK(database.diagnostics().empty());
    CHECK(renderer.diagnostics().empty());

    renderer.setSampleCount(4);
    database.render(renderer, scene, camera, {0, 0, 0, 1});
    CHECK(database.diagnostics().empty());
    CHECK(renderer.diagnostics().empty());

    renderer.setSampleCount(1);
    database.render(renderer, scene, camera, {0, 0, 0, 1});
    CHECK(database.diagnostics().empty());
    CHECK(renderer.diagnostics().empty());

    // 4x with TRAA: its velocity pass and resolve read the resolved depth, with no validation error.
    renderer.setSampleCount(4);
    renderer.setTraa(TraaOptions{});
    WGPUDevice device = context.getDevice();
    wgpuDevicePushErrorScope(device, WGPUErrorFilter_Validation);
    database.render(renderer, scene, camera, {0, 0, 0, 1});
    ScopeVerdict verdict;
    popScope(device, renderer, events, verdict);
    CHECK(verdict.clean());
    CHECK(database.diagnostics().empty());
    CHECK(renderer.diagnostics().empty());
}

// A flat-shaded lit mesh needs no normal attribute (three's NodeMaterial.setupNormal takes the face
// normal from the position's derivatives). A glTF without NORMAL, the Khronos Fox, loads that way: the
// draw must reach the main pass and light the mesh instead of vanishing from it.
void flatShadingNeedsNoNormals() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(64, 48);

    Scene scene;
    PerspectiveCamera camera(60, 4.0 / 3, 0.1, 100);
    camera.position.set(0, 0, 4);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    auto light = std::make_shared<DirectionalLight>(Color(1, 1, 1), 3.0);
    light->position.set(2, 3, 5);
    scene.add(*light);

    auto geometry = makeBoxGeometry(1.5, 1.5, 1.5);
    geometry->attributes.erase("normal");
    auto material = std::make_shared<Material>(MaterialType::Standard);
    material->flatShading = true;
    Mesh mesh(geometry, material);
    scene.add(mesh);

    RenderDatabase database;
    database.render(renderer, scene, camera, {0, 0, 0, 1});
    CHECK(database.diagnostics().empty());
    CHECK(renderer.diagnostics().empty());
    CHECK(renderer.lastFrame().draws == 2);  // the box and the output pass
    CHECK(renderer.lastFrame().triangles > 3);

    std::vector<uint8_t> pixels;
    bool read = false;
    renderer.readPixels([&](GpuStatus status, std::vector<uint8_t> px) {
        if (status == GpuStatus::Ok) pixels = std::move(px);
        read = true;
    });
    for (int i = 0; i < 5000 && !read; ++i) {
        renderer.poll();
        events.drain();
        if (!read) std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    const size_t centre = (size_t{24} * 64 + 32) * 4;
    CHECK(pixels.size() == size_t{64} * 48 * 4 && (pixels[centre] | pixels[centre + 1] | pixels[centre + 2]) != 0);
}

// Shadow-camera layers: a light shadow camera can draw casters on layers excluded by the main camera.
void shadowCameraLayers() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(64, 48);

    Scene scene;
    PerspectiveCamera camera(60, 4.0 / 3, 0.1, 100);
    camera.position.set(0, 2, 5);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();

    auto light = std::make_shared<DirectionalLight>(Color(1, 1, 1), 1.0);
    light->position.set(5, 10, 5);
    light->setCastShadow(true);
    light->shadow.camera->setLayerMask(double((1 << 0) | (1 << 2)));
    scene.add(*light);

    auto geom = makeBoxGeometry(1, 1, 1);
    auto mat0 = std::make_shared<Material>(MaterialType::Standard);
    auto mesh0 = std::make_shared<Mesh>(geom, mat0);
    mesh0->setCastShadow(true);
    mesh0->setLayer(0);
    scene.add(*mesh0);

    auto mat2 = std::make_shared<Material>(MaterialType::Standard);
    auto mesh2 = std::make_shared<Mesh>(geom, mat2);
    mesh2->setCastShadow(true);
    mesh2->setLayer(2);
    mesh2->position.set(2, 0, 0);
    scene.add(*mesh2);

    RenderDatabase database;
    database.shadowMapEnabled = true;
    database.batching = false;

    // 1. Shadow camera mask = (1<<0)|(1<<2):
    // layer-2 mesh is drawn in light's shadow pass and NOT in main pass;
    // layer-0 mesh is in both.
    database.render(renderer, scene, camera);
    auto stats = renderer.lastFrame();
    CHECK(stats.draws == 2);
    CHECK(stats.shadowDraws == 2);
    // The shadow pass counts its triangles beside its draws (three's Info counts both passes): two
    // draws of one geometry, then one when the layer mask drops a caster.
    const uint64_t twoCasters = stats.shadowTriangles;
    CHECK(twoCasters > 0 && twoCasters % 2 == 0);

    // 2. Default case: shadow camera with mask 1 uses the main camera's mask.
    // A layer-2 mesh casts only if the main camera enables layer 2.
    light->shadow.camera->setLayerMask(1);
    database.render(renderer, scene, camera);
    stats = renderer.lastFrame();
    CHECK(stats.draws == 2);
    CHECK(stats.shadowDraws == 1);
    CHECK(stats.shadowTriangles == twoCasters / 2);

    camera.enableLayer(2);
    database.render(renderer, scene, camera);
    stats = renderer.lastFrame();
    CHECK(stats.draws == 3);
    CHECK(stats.shadowDraws == 2);

    // 3. Batching: items never merge across distinct mainPass or layer bits.
    Scene batchScene;
    PerspectiveCamera batchCam(60, 4.0 / 3, 0.1, 100);
    batchCam.position.set(0, 2, 5);
    batchCam.lookAt(0, 0, 0);
    batchCam.updateProjectionMatrix();
    auto batchLight = std::make_shared<DirectionalLight>(Color(1, 1, 1), 1.0);
    batchLight->position.set(0, 10, 0); // frame the light above the y=2 layer-2 meshes so they sit inside the shadow frustum
    batchLight->setCastShadow(true);
    batchLight->shadow.camera->setLayerMask(double((1 << 0) | (1 << 2)));
    batchScene.add(*batchLight);
    std::vector<std::shared_ptr<Mesh>> meshes;
    for (int i = 0; i < 4; ++i) {
        auto m = std::make_shared<Mesh>(geom, mat0);
        m->setCastShadow(true);
        m->setLayer(0);
        m->position.set(-2.0 + i, 0, 0);
        batchScene.add(*m);
        meshes.push_back(m);
    }
    for (int i = 0; i < 4; ++i) {
        auto m = std::make_shared<Mesh>(geom, mat0);
        m->setCastShadow(true);
        m->setLayer(2);
        m->position.set(-2.0 + i, 2, 0);
        batchScene.add(*m);
        meshes.push_back(m);
    }
    RenderDatabase batchDb;
    batchDb.shadowMapEnabled = true;
    batchDb.batching = true;
    batchDb.render(renderer, batchScene, batchCam);
    auto batchStats = renderer.lastFrame();
    // Main pass draws only layer-0 batch (1 merged draw) + 1 output quad = 2
    CHECK(batchStats.draws == 2);
    // Shadow pass draws 2 batches (layer-0 merged batch + layer-2 merged batch) = 2
    CHECK(batchStats.shadowDraws == 2);
    CHECK(batchDb.lastBatches().first == 2 && batchDb.lastBatches().second == 8);
}

}  // namespace

// A glTF image decodes after the mesh first draws, and a render target can die, with no material
// version bump either way: the draw picks up the map once it samples, and drops it when it stops.
void mapSampleabilityChanges() {
    Scene scene; PerspectiveCamera camera; LightState lights; RenderDatabase database;
    camera.position.set(0, 0, 5);
    camera.lookAt(0, 0, 0);
    auto material = std::make_shared<Material>(MaterialType::Standard);
    auto map = std::make_shared<Texture>();  // what the glTF loader makes before decodeImage lands
    material->maps["map"] = map;
    Mesh plane(makePlaneGeometry(1, 1), material);
    scene.add(plane);
    CHECK(database.prepare(scene, camera, lights).at(0).map == nullptr);
    map->width = map->height = 1;
    map->data = {200, 200, 200, 255};
    CHECK(database.prepare(scene, camera, lights).at(0).map == map.get());
    auto target = std::make_shared<int>();
    auto colour = std::make_shared<Texture>();
    colour->renderTarget = target;
    material->maps["map"] = colour;
    material->needsUpdate();
    CHECK(database.prepare(scene, camera, lights).at(0).map == colour.get());
    target.reset();
    CHECK(database.prepare(scene, camera, lights).at(0).map == nullptr);
}

// Batch groups that first appear together grow the per-group cache store within one prepare; each
// draw's cache pointer must stay where the next frame finds it, never in a reallocated-away block.
void batchCachesStayPut() {
    Scene scene; PerspectiveCamera camera; LightState lights; RenderDatabase database;
    camera.position.set(32, 80, 200); // every geometry inside the frustum
    camera.lookAt(32, 0, 32);
    std::vector<std::shared_ptr<Mesh>> meshes;
    for (int g = 0; g < 64; ++g) {
        const auto geometry = makeBoxGeometry();
        geometry->scale(1, 1 + g / 100.0, 1); // distinct bytes: equal boxes would batch as one group
        auto material = std::make_shared<Material>(MaterialType::Standard);
        for (int i = 0; i < 4; ++i) {
            auto mesh = std::make_shared<Mesh>(geometry, material);
            mesh->position.set(g, 0, i);
            scene.add(*mesh); meshes.push_back(mesh);
        }
    }
    const auto first = database.prepare(scene, camera, lights);
    const auto second = database.prepare(scene, camera, lights);
    CHECK(first.size() == 64 && second.size() == 64);
    if (first.size() != second.size()) return;
    std::size_t moved = 0;
    for (std::size_t i = 0; i < first.size(); ++i) moved += first[i].cache != second[i].cache;
    std::printf("batch caches moved between frames: %zu of %zu\n", moved, first.size());
    CHECK(moved == 0);
}

// A batch's id breaks the opaque depth ties, so it stays a member mesh's id as three's would: a group-derived id
// changed which of two exactly coplanar draws wins (PRD-754 review).
void batchKeepsMemberId() {
    Scene scene; PerspectiveCamera camera; LightState lights; RenderDatabase database;
    camera.position.set(4, 20, 50);
    camera.lookAt(4, 0, 4);
    std::vector<std::shared_ptr<Mesh>> meshes;
    std::vector<uint64_t> ids;
    for (int g = 0; g < 8; ++g) {
        const auto geometry = makeBoxGeometry();
        geometry->scale(1, 1 + g / 100.0, 1); // distinct bytes: equal boxes would batch as one group
        auto material = std::make_shared<Material>(MaterialType::Standard);
        for (int i = 0; i < 4; ++i) {
            auto mesh = std::make_shared<Mesh>(geometry, material);
            mesh->position.set(g, 0, i);
            scene.add(*mesh); meshes.push_back(mesh); ids.push_back(mesh->id());
        }
    }
    const auto& items = database.prepare(scene, camera, lights);
    std::size_t foreign = 0;
    for (const DrawItem& d : items) foreign += std::find(ids.begin(), ids.end(), d.id) == ids.end();
    std::printf("batch draws: %zu, ids that are no member's: %zu\n", items.size(), foreign);
    CHECK(items.size() == 8);
    CHECK(foreign == 0);
}

// three's projectObject frustum-culls each Mesh, Line, Sprite and InstancedMesh (its instance-aware
// sphere) unless `frustumCulled` is false; a culled shadow caster still reaches the shadow pass.
void frustumCulling() {
    Scene scene; PerspectiveCamera camera; LightState lights; RenderDatabase database;
    database.shadowMapEnabled = true;
    database.batching = false; // one item per mesh
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);
    const auto geometry = makeBoxGeometry();
    const auto material = std::make_shared<Material>(MaterialType::Standard);
    const auto add = [&](std::shared_ptr<Mesh> mesh, double x, double z) {
        mesh->position.set(x, 0, z);
        scene.add(*mesh);
        return mesh;
    };
    const auto inside = add(std::make_shared<Mesh>(geometry, material), 0, 0);
    const auto behind = add(std::make_shared<Mesh>(geometry, material), 0, 20);
    const auto aside = add(std::make_shared<Mesh>(geometry, material), 200, 0);
    const auto unculled = add(std::make_shared<Mesh>(geometry, material), 0, 30);
    unculled->frustumCulled = false;
    const auto caster = add(std::make_shared<Mesh>(geometry, material), -200, 0);
    caster->setCastShadow(true);
    // Frame the shadow caster so the test's caster reaches the shadow pass.
    auto sun = std::make_shared<DirectionalLight>(Color(1, 1, 1), 1.0);
    sun->setCastShadow(true);
    auto& sc = static_cast<OrthographicCamera&>(*sun->shadow.camera);
    sc.left = -300; sc.right = 300; sc.top = 300; sc.bottom = -300; sc.near = 0.1; sc.far = 1000;
    scene.add(*sun);
    // Its geometry sits behind the camera; its one instance is moved in front of it.
    const auto instanced = std::make_shared<InstancedMesh>(geometry, material, 1);
    instanced->setMatrixAt(0, Matrix4().makeTranslation(0, 0, -25));
    add(instanced, 0, 25);
    const auto sprite = std::make_shared<Sprite>();
    sprite->position.set(0, 0, 40);
    scene.add(*sprite);
    const auto& items = database.prepare(scene, camera, lights);
    std::size_t main = 0, shadowOnly = 0;
    for (const auto& item : items) (item.mainPass ? main : shadowOnly) += 1;
    std::printf("frustum: %zu main, %zu shadow-only of %zu items\n", main, shadowOnly, items.size());
    CHECK(main == 3);       // inside, unculled, instanced
    CHECK(shadowOnly == 1); // the caster off to the side
    (void)inside; (void)behind; (void)aside;
}

// PRD-651: an alpha-tested caster casts its cut, as three's shadow pass does. A leaf card whose map is
// transparent on one half shades half its footprint on the floor, not the whole card; a FrontSide card
// facing the light casts nothing (three draws its back faces), and DoubleSide casts from both faces.
void maskedShadow() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(64, 64);
    Scene scene;
    OrthographicCamera camera(-2, 2, 2, -2, 0.1, 20);
    camera.position.set(0, 10, 0.001);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    DirectionalLight light{Color(1, 1, 1), 3};
    light.position.set(0.001, 10, 0);
    light.setCastShadow(true);
    light.shadow.camera->setLayerMask(double((1 << 0) | (1 << 2)));
    scene.add(light);
    auto floorMaterial = std::make_shared<Material>(MaterialType::Standard);
    Mesh floor{makePlaneGeometry(4, 4), floorMaterial};
    floor.rotation.set(-M_PI / 2, 0, 0);
    floor.setReceiveShadow(true);
    scene.add(floor);
    // The card's left texel is transparent, its right opaque; it draws only on the light's layer 2,
    // so the camera sees the floor under it.
    auto map = std::make_shared<Texture>();
    map->width = 2; map->height = 1;
    map->data = {255, 255, 255, 0, 255, 255, 255, 255};
    map->needsUpdate();
    auto leaf = std::make_shared<Material>(MaterialType::Standard);
    leaf->maps["map"] = map;
    leaf->alphaTest = 0.5;
    Mesh card{makePlaneGeometry(2, 2), leaf};
    card.rotation.set(-M_PI / 2, 0, 0);  // faces the light
    card.position.y = 1;
    card.setCastShadow(true);
    card.setLayer(2);
    scene.add(card);
    scene.updateMatrixWorld(true);
    RenderDatabase database;
    database.shadowMapEnabled = true;
    // The fraction of the card's footprint (the centre 32 x 32 pixels) darker than half the lit floor.
    const auto shadowed = [&] {
        database.render(renderer, scene, camera);
        std::vector<uint8_t> pixels;
        bool read = false;
        renderer.readPixels([&](GpuStatus status, std::vector<uint8_t> px) {
            if (status == GpuStatus::Ok) pixels = std::move(px);
            read = true;
        });
        for (int i = 0; i < 5000 && !read; ++i) {
            renderer.poll();
            events.drain();
            if (!read) std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
        CHECK(pixels.size() == size_t{64} * 64 * 4);
        const uint8_t lit = pixels[(size_t{2} * 64 + 2) * 4];  // a corner outside the footprint
        CHECK(lit > 64);
        int dark = 0;
        for (int y = 18; y < 46; ++y)
            for (int x = 18; x < 46; ++x) dark += pixels[(size_t(y) * 64 + x) * 4] < lit / 2;
        return dark / double(28 * 28);
    };
    leaf->side = Side::Double;
    const double cut = shadowed();
    leaf->side = Side::Front;
    const double frontFacingLight = shadowed();
    leaf->alphaTest = 0;
    leaf->shadowSide = Side::Front;  // material.shadowSide draws the front face that faces the light
    const double frontShadowSide = shadowed();
    leaf->shadowSide.reset();
    leaf->side = Side::Double;
    const double solid = shadowed();
    std::printf("masked shadow: cut %.3f, front side facing the light %.3f, shadowSide front %.3f, solid %.3f\n", cut,
                frontFacingLight, frontShadowSide, solid);
    CHECK(frontShadowSide > 0.95);
    CHECK(solid > 0.95);                   // the card without a cut shades its whole footprint
    CHECK(std::abs(cut - 0.5) < 0.05);     // the cut card shades its opaque half
    CHECK(frontFacingLight < 0.05);        // three's shadowSide: a FrontSide caster draws its back faces
}

// PRD-643: a Two Sided Foliage leaf lets the sun through from behind, as Unreal's SSS_TYPE_TWO_SIDED_WRAP does:
// subsurfaceColor x saturate((-N.L + 0.5) / 2.25) x D_GGX(alpha 0.6, saturate(-V.L)) x the sun, with no N.L and no
// 1/pi. Three cards face the camera with the sun straight behind them, so no card takes front light: the marked
// card with a subsurfaceColor matches the closed form, and a marked card without one and an unmarked card with one
// stay black.
void foliageTransmission() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(96, 96);
    OrthographicCamera camera(-3, 3, 3, -3, 0.1, 20);  // 16 pixels per metre
    camera.position.set(0, 10, 0.001);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    Scene scene;
    DirectionalLight sun{Color(1, 1, 1), 1};
    sun.position.set(0, -5, 0.001);  // under the cards: straight behind them from the camera
    scene.add(sun);
    const Color subsurface(0.5, 0.4, 0.1);
    std::vector<std::unique_ptr<Mesh>> cards;
    const auto card = [&](double x, bool marked, bool withColour) {
        auto material = std::make_shared<Material>(MaterialType::Standard);
        material->side = Side::Double;
        material->color = Color(0.2, 0.5, 0.3);
        material->twoSidedFoliage = marked;
        material->hasSubsurfaceColor = withColour;
        if (withColour) material->subsurfaceColor = subsurface;
        cards.push_back(std::make_unique<Mesh>(makePlaneGeometry(1.5, 1.5), material));
        cards.back()->rotation.set(-M_PI / 2, 0, 0);
        cards.back()->position.set(x, 0, 0);
        scene.add(*cards.back());
    };
    card(0, true, true);  // in the middle, where the view direction is the camera's axis
    card(-2, true, false);
    card(2, false, true);
    scene.updateMatrixWorld(true);
    RenderDatabase database;
    database.render(renderer, scene, camera);
    std::vector<uint8_t> pixels;
    bool read = false;
    renderer.readPixels([&](GpuStatus status, std::vector<uint8_t> px) {
        if (status == GpuStatus::Ok) pixels = std::move(px);
        read = true;
    });
    for (int i = 0; i < 5000 && !read; ++i) {
        renderer.poll();
        events.drain();
        if (!read) std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    CHECK(pixels.size() == size_t{96} * 96 * 4);
    const auto at = [&](int x, int c) { return double(pixels[(size_t{48} * 96 + size_t(x)) * 4 + c]); };
    const auto srgb = [](double v) { return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * std::pow(v, 1 / 2.4) - 0.055); };
    // -N.L = 1 and -V.L = 1: wrap (1 + 0.5) / 2.25, D_GGX at its peak 1 / (pi alpha^2).
    const double lobe = (1.5 / 2.25) / (M_PI * 0.36);
    const double expected[3] = {srgb(lobe * subsurface.r), srgb(lobe * subsurface.g), srgb(lobe * subsurface.b)};
    std::printf("foliage transmission: marked %.0f %.0f %.0f (closed form %.1f %.1f %.1f), marked bare %.0f, unmarked %.0f\n",
                at(48, 0), at(48, 1), at(48, 2), expected[0], expected[1], expected[2], at(16, 0), at(80, 0));
    for (int c = 0; c < 3; ++c) CHECK(std::abs(at(48, c) - expected[c]) <= 3);
    for (int c = 0; c < 3; ++c) CHECK(at(16, c) <= 1 && at(80, c) <= 1);
}

// PRD-651: a receiver marked twoSidedFoliage (Unreal's Two Sided Foliage shading model) looks its shadow
// up where it stands, and a source-angle filter widens to Unreal's 5 degree minimum on it. A plate 1 m
// above the floor with the sun at 45 degrees throws an edge at x = 1; a normal bias b along the floor's
// normal moves a biased lookup's edge to x = 1 - b. The floor is the receiver: a marked floor skips the
// bias, and a floor with two sides and a cut but no marker (Unreal's default lit) keeps it.
void leafReceiver() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(96, 96);
    OrthographicCamera camera(-3, 3, 3, -3, 0.1, 20);  // 16 pixels per metre
    camera.position.set(0, 10, 0.001);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    const auto row = [&](RenderDatabase& database, Scene& scene) {
        database.render(renderer, scene, camera);
        std::vector<uint8_t> pixels;
        bool read = false;
        renderer.readPixels([&](GpuStatus status, std::vector<uint8_t> px) {
            if (status == GpuStatus::Ok) pixels = std::move(px);
            read = true;
        });
        for (int i = 0; i < 5000 && !read; ++i) {
            renderer.poll();
            events.drain();
            if (!read) std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
        CHECK(pixels.size() == size_t{96} * 96 * 4);
        std::vector<double> out;
        for (int x = 0; x < 96; ++x) out.push_back(pixels[(size_t{48} * 96 + size_t(x)) * 4]);
        return out;
    };
    // The shadow edge on the middle row in metres (the first pixel brighter than half the lit floor, from
    // the left, interpolated) and the width between 15 and 85 percent of the lit floor.
    struct Edge { double at, width; };
    const auto edgeOf = [](const std::vector<double>& line) {
        const double lit = line[93], dark = *std::min_element(line.begin(), line.begin() + 80);
        CHECK(lit - dark > 20);
        const auto cross = [&](double fraction) {
            const double level = dark + (lit - dark) * fraction;
            for (int x = 1; x < 96; ++x)
                if (line[x - 1] < level && line[x] >= level) return x - 1 + (level - line[x - 1]) / (line[x] - line[x - 1]);
            return -1.0;
        };
        return Edge{(cross(0.5) - 48) / 16.0, (cross(0.85) - cross(0.15)) / 16.0};
    };
    // One floor, one plate, a sun at 45 degrees; the receiver's marker, side and cut and the light's bias vary.
    const auto edge = [&](bool foliage, Side side, double alphaTest, double normalBias, bool filter) {
        Scene scene;
        DirectionalLight light{Color(1, 1, 1), 3};
        light.position.set(-5, 5, 0);
        light.setCastShadow(true);
        light.shadow.camera->setLayerMask(double((1 << 0) | (1 << 2)));
        light.shadow.normalBias = normalBias;
        if (filter) {
            auto options = std::make_shared<shadows::AtlasOptions>();
            options->clipExtents = {8};
            options->mapSize = 512;
            options->pageTexels = 128;
            options->lightDistance = 20;
            options->depthRange = 40;
            options->refreshStep = {0};
            light.shadow.virtualShadow = options;
            light.shadow.sourceAngleFilter = std::array<double, 6>{0.0047, 16, 16, 0};  // 0.27 degrees, Unreal's sun
        }
        scene.add(light);
        auto material = std::make_shared<Material>(MaterialType::Standard);
        material->side = side;
        material->alphaTest = alphaTest;
        material->twoSidedFoliage = foliage;
        Mesh floor{makePlaneGeometry(6, 6), material};
        floor.rotation.set(-M_PI / 2, 0, 0);
        floor.setReceiveShadow(true);
        scene.add(floor);
        // The plate covers x < 0 at 1 m (2 m with the filter, so the gap is wide enough to measure).
        Mesh plate{makeBoxGeometry(3, 0.05, 6), std::make_shared<Material>(MaterialType::Standard)};
        plate.position.set(-1.5, filter ? 2 : 1, 0);
        plate.setCastShadow(true);
        plate.setLayer(2);
        scene.add(plate);
        scene.updateMatrixWorld(true);
        RenderDatabase database;
        database.shadowMapEnabled = true;
        // A virtual map is drawn on the first frame and read on the next.
        std::vector<double> line = row(database, scene);
        for (int frame = 0; frame < (filter ? 2 : 0); ++frame) line = row(database, scene);
        return edgeOf(line);
    };
    const double bias = 0.4;
    const Edge unbiased = edge(false, Side::Front, 0, 0, false);
    const Edge biased = edge(false, Side::Front, 0, bias, false);
    const Edge leaf = edge(true, Side::Double, 0.5, bias, false);
    const Edge marked = edge(true, Side::Front, 0, bias, false);
    const Edge plainCut = edge(false, Side::Double, 0.5, bias, false);
    std::printf("leaf receiver bias: unbiased %.3f, biased %.3f, marked leaf %.3f, marked alone %.3f, plain cut %.3f\n",
                unbiased.at, biased.at, leaf.at, marked.at, plainCut.at);
    CHECK(unbiased.at - biased.at > 0.3);          // the bias moves an ordinary receiver's edge by about b
    CHECK(std::abs(leaf.at - unbiased.at) < 0.1);  // a marked leaf keeps the unbiased edge
    CHECK(std::abs(marked.at - unbiased.at) < 0.1);       // the marker alone is the shading model
    CHECK(std::abs(plainCut.at - biased.at) < 0.1);       // two sides and a cut without it stay default lit
    const Edge hard = edge(false, Side::Front, 0, 0, true);
    const Edge hardCut = edge(false, Side::Double, 0.5, 0, true);
    const Edge soft = edge(true, Side::Double, 0.5, 0, true);
    std::printf("leaf receiver source: ordinary edge width %.3f m, plain cut %.3f m, marked leaf %.3f m\n", hard.width,
                hardCut.width, soft.width);
    CHECK(soft.width > hard.width + 0.15);         // the 5 degree minimum widens the marked leaf's penumbra
    CHECK(std::abs(hardCut.width - hard.width) < 0.05);   // a plain cut card keeps the sun's own source
}

// PCF's five taps turn by interleaved gradient noise of the pixel. With a fixed rotation a wide radius leaves a stipple
// the temporal pass cannot average (Lantern Vale, radius 12), so the noise takes Unreal's frame term: every PCF filter
// (directional, point, virtual) reads `shadowNoiseFrame`, which is the temporal pass's frame mod 8 and 0 without it.
void shadowNoiseFrame() {
    for (const char* kinds : {"D", "P", "2"}) {
        const auto fragment = shader::buildStage(shader::buildStandard({}, {}, {kinds}).fragment, 1);
        CHECK(fragment.wgsl.ok());
        CHECK(fragment.wgsl.code.find("shadowNoiseFrame") != std::string::npos);
    }
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(32, 32);
    PerspectiveCamera camera(60, 1, 0.1, 100);
    camera.position.set(0, 0, 4);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    Scene scene;
    Mesh box{makeBoxGeometry(1, 1, 1), std::make_shared<Material>(MaterialType::Standard)};
    scene.add(box);
    scene.updateMatrixWorld(true);
    RenderDatabase database;
    for (int frame = 0; frame < 3; ++frame) {
        database.render(renderer, scene, camera);
        CHECK(renderer.shadowNoiseFrame() == 0);  // no temporal pass: three's static rotation, a deterministic still
    }
    renderer.setTraa(TraaOptions{});
    std::vector<double> seen;
    for (int frame = 0; frame < 9; ++frame) {
        database.render(renderer, scene, camera);
        CHECK(renderer.shadowNoiseFrame() >= 0 && renderer.shadowNoiseFrame() < 8);
        seen.push_back(renderer.shadowNoiseFrame());
    }
    std::sort(seen.begin(), seen.end());
    CHECK(std::unique(seen.begin(), seen.end()) - seen.begin() == 8);  // eight rotations, as StateFrameIndexMod8
}

// PRD-653: a material marked roughDiffuse shades direct light with Unreal's Substrate rough diffuse (the EON
// model) where three shades Lambert. A grey floor seen from above at 26.6 degrees and lit at 45 degrees from the
// camera's side (back-scatter) or from the far side (forward scatter) differs between the two renders by EON's
// factor on the diffuse term alone, whatever the specular does: E x N.L x albedo / pi x (g - 1). A lamp's Source
// Radius fades the model's roughness to nothing at 20 cm, so a lamp that large shades Lambert.
void roughDiffuse() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(96, 96);
    renderer.setOutput(OutputState{std::nullopt, 1, false});  // linear and unmapped: a pixel is radiance x 255
    PerspectiveCamera camera(20, 1, 0.1, 50);
    camera.position.set(0, 1, 2);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    const double irradiance = 5, albedo = 0.5;
    const double nov = 1 / std::sqrt(5.0);  // the floor's centre, seen from (0, 1, 2)
    // EON's factor on Lambert in doubles, from the published model: the shader's twin.
    const auto factor = [&](double r, double nol, double vol) {
        const double s = vol - nov * nol, sOverT = std::max(s / std::max(1e-6, std::max(nov, nol)), s);
        const double single = 1 - r * (1 - 1 / (1.5 - 2 / (3 * M_PI)));
        const double multi = 1 - single * (1 + r * 0.262048 * (1 - nov));
        const double gain = 1 + 0.189468 * (1 - albedo) * r;
        return gain * (single * (1 + r * sOverT) + albedo * gain * multi);
    };
    // The floor's centre pixel, 0 to 255, under one sun or lamp 4 m away towards `towards`.
    const auto centre = [&](bool rough, bool lamp, const std::array<double, 3>& towards, double sourceRadius) {
        Scene scene;
        DirectionalLight sun{Color(1, 1, 1), irradiance};
        PointLight bulb{Color(1, 1, 1), irradiance, 0, 0};  // no falloff: the floor sees the full irradiance
        bulb.sourceRadius = sourceRadius;
        Light& light = lamp ? static_cast<Light&>(bulb) : sun;
        light.position.set(4 * towards[0], 4 * towards[1], 4 * towards[2]);
        scene.add(light);
        auto material = std::make_shared<Material>(MaterialType::Standard);
        material->color = Color(albedo, albedo, albedo);
        material->roughness = 1;
        material->roughDiffuse = rough;
        Mesh floor{makePlaneGeometry(6, 6), material};
        floor.rotation.set(-M_PI / 2, 0, 0);
        scene.add(floor);
        scene.updateMatrixWorld(true);
        RenderDatabase database;
        database.render(renderer, scene, camera);
        const auto pixels = read(renderer, events);
        CHECK(pixels.size() == size_t{96} * 96 * 4);
        return pixels.size() == size_t{96} * 96 * 4 ? double(pixels[(size_t{48} * 96 + 48) * 4]) : 0.0;
    };
    // What the factor moves the pixel by: 255 x E x N.L x albedo / pi x (g - 1), for the light `towards` it.
    const auto shift = [&](const std::array<double, 3>& towards, double r) {
        const double nol = towards[1], vol = nov * towards[1] + 2 / std::sqrt(5.0) * towards[2];
        return 255 * irradiance * nol * albedo / M_PI * (factor(r, nol, vol) - 1);
    };
    const std::array<double, 3> back{0, M_SQRT1_2, M_SQRT1_2}, forward{0, M_SQRT1_2, -M_SQRT1_2};
    const double backShift = centre(true, false, back, 0) - centre(false, false, back, 0);
    const double forwardShift = centre(true, false, forward, 0) - centre(false, false, forward, 0);
    std::printf("rough diffuse: sun back-scatter %+.1f (expect %+.1f), forward %+.1f (expect %+.1f)\n", backShift,
                shift(back, 0.4), forwardShift, shift(forward, 0.4));
    CHECK(std::abs(backShift - shift(back, 0.4)) < 2.5);
    CHECK(std::abs(forwardShift - shift(forward, 0.4)) < 2.5);
    CHECK(backShift > 30 && forwardShift < -30);  // EON brightens the retro-reflection and darkens the forward lobe
    // A lamp's Source Radius: 0 is a sun's weight 1, 10 cm halves the model's roughness, 20 cm is Lambert.
    const double lambert = centre(false, true, back, 0);
    const double point = centre(true, true, back, 0) - lambert;
    const double half = centre(true, true, back, 0.1) - lambert;
    const double large = centre(true, true, back, 0.2) - lambert;
    std::printf("rough diffuse: lamp r0 %+.1f (expect %+.1f), r0.1 %+.1f (expect %+.1f), r0.2 %+.1f (expect 0)\n", point,
                shift(back, 0.4), half, shift(back, 0.2), large);
    CHECK(std::abs(point - shift(back, 0.4)) < 2.5);
    CHECK(std::abs(half - shift(back, 0.2)) < 2.5);
    CHECK(std::abs(large) <= 1.5);
}

// sourceRadiusShadowFilter on a lamp (PRD-650): a plate 2 m under a lamp 4 m above the floor throws an
// edge whose penumbra is 2 x sourceRadius x (4 - 2) / 2 m wide on the floor. The edge's width, in pixels
// whose shadowed-to-unshadowed ratio lies between 0.15 and 0.85, follows the radius for a point light's
// cube and a spot light's map: three's PCF and a radius of 0 stay hard.
void lampSourceRadius() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(96, 96);
    OrthographicCamera camera(-3, 3, 3, -3, 0.1, 20);  // 16 pixels per metre
    camera.position.set(0, 10, 0.001);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    const auto edgeWidth = [&](Light& lamp, LightShadow& shadow, std::optional<std::array<double, 4>> filter) {
        Scene scene;
        lamp.position.set(0, 4, 0);
        lamp.setCastShadow(true);
        shadow.mapSize = {1024, 1024};
        shadow.sourceRadiusFilter = filter;
        scene.add(lamp);
        Mesh floor{makePlaneGeometry(6, 6), std::make_shared<Material>(MaterialType::Standard)};
        floor.rotation.set(-M_PI / 2, 0, 0);
        floor.setReceiveShadow(true);
        scene.add(floor);
        // The plate covers x < 0 at 2 m, on layer 2 only, so the camera sees the floor under it.
        shadow.camera->setLayerMask(double((1 << 0) | (1 << 2)));
        Mesh plate{makeBoxGeometry(3, 0.05, 6), std::make_shared<Material>(MaterialType::Standard)};
        plate.position.set(-1.5, 2, 0);
        plate.setCastShadow(true);
        plate.setLayer(2);
        scene.add(plate);
        scene.updateMatrixWorld(true);
        RenderDatabase database;
        database.shadowMapEnabled = true;
        const auto row = [&] {
            database.render(renderer, scene, camera);
            std::vector<uint8_t> pixels;
            bool read = false;
            renderer.readPixels([&](GpuStatus status, std::vector<uint8_t> px) {
                if (status == GpuStatus::Ok) pixels = std::move(px);
                read = true;
            });
            for (int i = 0; i < 5000 && !read; ++i) {
                renderer.poll();
                events.drain();
                if (!read) std::this_thread::sleep_for(std::chrono::milliseconds(1));
            }
            CHECK(pixels.size() == size_t{96} * 96 * 4);
            std::vector<double> red(96);
            for (int x = 0; x < 96; ++x) red[x] = pixels[(size_t{48} * 96 + x) * 4];
            return red;
        };
        const std::vector<double> shadowed = row();
        plate.setCastShadow(false);
        const std::vector<double> open = row();
        int width = 0, dark = 0;
        for (int x = 8; x < 88; ++x) {
            const double ratio = shadowed[x] / std::max(open[x], 1.0);
            width += ratio > 0.15 && ratio < 0.85;
            dark += ratio <= 0.15;
        }
        CHECK(dark > 10);  // the plate shades the floor
        scene.remove(lamp);
        return width;
    };
    // {sourceRadius, blockerSamples, filterSamples, penumbraScale}: a scale of 1 is the geometric penumbra.
    const std::array<double, 4> wide{0.5, 16, 16, 1}, none{0, 16, 16, 1}, resolved{0.5, 16, 16, 0.6};
    PointLight point{Color(1, 1, 1), 60};
    SpotLight spot{Color(1, 1, 1), 60};
    const int pointPcf = edgeWidth(point, point.shadow, std::nullopt), pointHard = edgeWidth(point, point.shadow, none),
              pointSoft = edgeWidth(point, point.shadow, wide), pointScaled = edgeWidth(point, point.shadow, resolved);
    const int spotPcf = edgeWidth(spot, spot.shadow, std::nullopt), spotHard = edgeWidth(spot, spot.shadow, none),
              spotSoft = edgeWidth(spot, spot.shadow, wide), spotScaled = edgeWidth(spot, spot.shadow, resolved);
    std::printf("lamp source radius edge px: point pcf %d, r0 %d, r0.5 %d, r0.5 x0.6 %d; spot pcf %d, r0 %d, r0.5 %d, r0.5 x0.6 %d\n",
                pointPcf, pointHard, pointSoft, pointScaled, spotPcf, spotHard, spotSoft, spotScaled);
    // A 0.5 m radius: a 1 m penumbra, 16 pixels. A disk light's edge is a circular segment's area, whose
    // 0.15-0.85 band is about 60% of it: 9.5 pixels, sampled here by 16 taps.
    for (const int soft : {pointSoft, spotSoft}) CHECK(soft >= 6 && soft <= 13);
    for (const int hard : {pointPcf, pointHard, spotPcf, spotHard}) CHECK(hard <= 3);
    // penumbraScale keeps a share of that width: 0.6 of 9.5 pixels is 5.7.
    for (const auto& [soft, scaled] : {std::pair{pointSoft, pointScaled}, std::pair{spotSoft, spotScaled}})
        CHECK(scaled >= 4 && scaled <= 8 && scaled * 10 <= soft * 8 && scaled * 10 >= soft * 4);
}

// PRD-650: a plate's edge thrown on a wall that the lamp sees 40 degrees off the wall's normal (cornell's
// red wall), the wall in the shadow map too. The wall's own texels nearer the lamp than a receiver are not
// blockers: the receiver's plane decides, so the edge keeps its geometric width. A 0.5 m disk 3 m above a
// plate whose edge is 1.2 m out, on a wall 2 m out, throws a 0.15-0.85 band of 8.3 pixels at 16 pixels per
// metre; a wall that shades itself narrows it to 1 or 2 pixels. The same edge on a flat floor under the lamp
// is lampSourceRadius.
void lampSourceRadiusWall() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(96, 96);
    OrthographicCamera camera(-3, 3, 3, -3, 0.1, 20);
    camera.position.set(8, 1.5, 0);
    camera.lookAt(-2, 1.5, 0);
    camera.updateProjectionMatrix();
    const auto edgeWidth = [&](Light& lamp, LightShadow& shadow, Object3D* aim, double penumbraScale) {
        Scene scene;
        lamp.position.set(0, 3, 0);
        lamp.setCastShadow(true);
        shadow.mapSize = {1024, 1024};
        shadow.sourceRadiusFilter = std::array<double, 4>{0.5, 16, 16, penumbraScale};
        scene.add(lamp);
        if (aim) scene.add(*aim);
        Mesh wall{makePlaneGeometry(6, 6), std::make_shared<Material>(MaterialType::Standard)};
        wall.rotation.set(0, M_PI / 2, 0);  // faces +x, towards the camera and the lamp
        wall.position.set(-2, 1.5, 0);
        wall.setReceiveShadow(true);
        wall.setCastShadow(true);  // the wall is in the map too: its texels nearer the lamp than a receiver are not blockers
        wall.material->shadowSide = Side::Double;  // a plane faces the lamp, so a front-face or back-face pass alone would drop it
        scene.add(wall);
        // The plate covers x in [-1.2, 0] at 1 m under the lamp, on layer 2 only, so the camera sees the wall.
        shadow.camera->setLayerMask(double((1 << 0) | (1 << 2)));
        Mesh plate{makeBoxGeometry(1.2, 0.05, 6), std::make_shared<Material>(MaterialType::Standard)};
        plate.position.set(-0.6, 2, 0);
        plate.setCastShadow(true);
        plate.setLayer(2);
        scene.add(plate);
        scene.updateMatrixWorld(true);
        RenderDatabase database;
        database.shadowMapEnabled = true;
        const auto column = [&] {
            database.render(renderer, scene, camera);
            const std::vector<uint8_t> pixels = read(renderer, events);
            CHECK(pixels.size() == size_t{96} * 96 * 4);
            std::vector<double> red(96);
            for (int y = 0; y < 96; ++y) red[y] = pixels[(size_t(y) * 96 + 48) * 4];
            return red;
        };
        const std::vector<double> shadowed = column();
        plate.setCastShadow(false);
        const std::vector<double> open = column();
        int width = 0, dark = 0;
        for (int y = 8; y < 88; ++y) {
            const double ratio = shadowed[y] / std::max(open[y], 1.0);
            width += ratio > 0.15 && ratio < 0.85;
            dark += ratio <= 0.15;
        }
        CHECK(dark > 10);  // the plate shades the wall
        scene.remove(lamp);
        if (aim) scene.remove(*aim);
        return width;
    };
    PointLight point{Color(1, 1, 1), 60};
    SpotLight spot{Color(1, 1, 1), 60};
    spot.target->position.set(-2, 1.3, 0);  // the edge's height on the wall
    const int pointWall = edgeWidth(point, point.shadow, nullptr, 1), spotWall = edgeWidth(spot, spot.shadow, spot.target.get(), 1);
    const int pointKept = edgeWidth(point, point.shadow, nullptr, 0.6), spotKept = edgeWidth(spot, spot.shadow, spot.target.get(), 0.6);
    std::printf("lamp source radius wall edge px: point %d, spot %d; at penumbraScale 0.6: point %d, spot %d\n", pointWall,
                spotWall, pointKept, spotKept);
    // The plate the lamp sees at a slant has a depth that falls across the search cone, so the blocker average
    // widens the edge to 1.7 to 2.2 times the geometric width at scale 1. A wall that shades itself is 1 or 2.
    for (const int wall : {pointWall, spotWall}) CHECK(wall >= 7 && wall <= 20);
    // The default scale keeps a share of that, never narrower than the self-shaded 1 or 2 pixels.
    for (const auto& [full, kept] : {std::pair{pointWall, pointKept}, std::pair{spotWall, spotKept}}) CHECK(kept >= 4 && kept < full);
}

// PRD-650: the soft filter never lights what the hard filter shades. lamp-room's crate stands on the floor
// under a 5 cm point lamp, and three's shadowSide stores the crate's back faces: on the floor a few
// centimetres behind its dark face the stored depth lies within centimetres of the receiver, so a blocker
// there reaches almost nothing. A filter that finds no blocker in reach and calls the receiver lit leaves a
// bright stripe in the crate's umbra (lamp-room point pose, 2026-10-21). Every floor pixel the hard filter
// shades below 0.35 of the open floor stays below 0.75 with the soft filter. The crate's bottom face lies in
// the floor's plane, so the floor beside its far foot ties with the stored depth to the last bit: both filters
// light a dotted line of single pixels along the foot unless the lamp stores its back faces a hair nearer.
void lampSourceRadiusCrate() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    constexpr int kWidth = 1280, kHeight = 720;
    renderer.setSize(kWidth, kHeight);
    PerspectiveCamera camera(36, double(kWidth) / kHeight, 0.05, 50);  // the pose's 60 degree horizontal fov
    camera.position.set(-0.4, 1.6, 2.2);
    camera.lookAt(-0.4, 0.3, -0.9);
    camera.updateProjectionMatrix();
    const auto render = [&](std::optional<std::array<double, 4>> filter, bool casters) {
        Scene scene;
        PointLight lamp{Color(1, 1, 1), 4, 12};
        lamp.position.set(0.6, 1.5, 0.4);
        lamp.setCastShadow(true);
        lamp.shadow.mapSize = {1024, 1024};
        lamp.shadow.sourceRadiusFilter = filter;
        auto& shadowCamera = static_cast<PerspectiveCamera&>(*lamp.shadow.camera);
        shadowCamera.near = 0.02;
        shadowCamera.updateProjectionMatrix();
        scene.add(lamp);
        const auto material = std::make_shared<Material>(MaterialType::Standard);
        std::vector<std::shared_ptr<Mesh>> meshes;
        const auto box = [&](double w, double h, double d, double x, double y, double z, double turn = 0) {
            auto mesh = std::make_shared<Mesh>(makeBoxGeometry(w, h, d), material);
            mesh->position.set(x, y, z);
            mesh->rotation.set(0, turn, 0);
            mesh->setCastShadow(casters);
            mesh->setReceiveShadow(true);
            scene.add(*mesh);
            meshes.push_back(mesh);
        };
        box(6.2, 0.2, 4.2, 0, -0.1, 0);                      // Floor
        box(6.2, 0.2, 4.2, 0, 3.1, 0);                       // Ceiling
        box(6.2, 3.2, 0.2, 0, 1.5, -2.1);                    // Back
        box(0.2, 3.2, 4.2, -3.1, 1.5, 0);                    // Wall_L
        box(0.2, 3.2, 4.2, 3.1, 1.5, 0);                     // Wall_R
        box(1.0, 0.05, 0.8, -2, 0.8, -0.5);                  // Table_L
        box(1.0, 0.05, 0.8, 2, 0.8, -0.5);                   // Table_R
        box(0.5, 0.5, 0.5, -0.4, 0.25, -0.6, M_PI / 9);      // Crate, 20 degrees about +Y
        box(0.01, 2.0, 0.01, 0.6, 1.0, -1.945);              // Rod
        scene.updateMatrixWorld(true);
        RenderDatabase database;
        database.shadowMapEnabled = true;
        database.render(renderer, scene, camera);
        const std::vector<uint8_t> pixels = read(renderer, events);
        CHECK(pixels.size() == size_t{kWidth} * kHeight * 4);
        std::vector<double> red(size_t{kWidth} * kHeight);
        for (size_t i = 0; i < red.size(); ++i) red[i] = pixels[i * 4];
        scene.remove(lamp);
        return red;
    };
    const std::vector<double> open = render(std::array<double, 4>{0, 16, 16, 1}, false);
    const std::vector<double> hard = render(std::array<double, 4>{0, 16, 16, 1}, true);
    const std::vector<double> soft = render(std::array<double, 4>{0.05, 16, 16, 0.6}, true);
    int shaded = 0, leaked = 0;
    for (size_t i = 0; i < open.size(); ++i) {
        if (open[i] < 24) continue;
        const bool umbra = hard[i] < 0.35 * open[i];
        shaded += umbra;
        leaked += umbra && soft[i] > 0.75 * open[i];
    }
    // A lit pixel whose eight neighbours are all dark: the tie's dots, never a penumbra's edge.
    const auto isolated = [&](const std::vector<double>& image) {
        int count = 0;
        for (int y = 1; y < kHeight - 1; ++y)
            for (int x = 1; x < kWidth - 1; ++x) {
                const size_t i = size_t(y) * kWidth + x;
                if (open[i] < 24 || image[i] <= 0.5 * open[i]) continue;
                bool alone = true;
                for (int dy = -1; dy <= 1 && alone; ++dy)
                    for (int dx = -1; dx <= 1; ++dx) {
                        const size_t j = i + size_t(dy * kWidth + dx);
                        if ((dx != 0 || dy != 0) && image[j] >= 0.25 * std::max(open[i], open[j])) { alone = false; break; }
                    }
                count += alone;
            }
        return count;
    };
    const int hardDots = isolated(hard), softDots = isolated(soft);
    std::printf("lamp source radius crate: %d umbra pixels, %d lit by the soft filter; isolated lit pixels: hard %d, soft %d\n",
                shaded, leaked, hardDots, softDots);
    CHECK(shaded > 5000);  // the room's shadows are there
    CHECK(leaked <= 40);   // a penumbra's edge may differ by a pixel; a stripe is hundreds
    CHECK(hardDots == 0);  // 8 before the lamp stored its back faces a hair nearer
    CHECK(softDots == 0);  // 3 before
}

// A box standing on a floor slab under a point lamp shades the floor right behind its far foot. three's
// shadowSide draws a front-sided caster's back faces, so there the stored depth is the box's back face
// at the floor and the strip leaks light (cornell's tall box, 0.859 of the open floor); a lamp stores its
// back faces a few depth steps nearer, which closes the strip without acne on the lit floor. The strip's
// darkest-to-brightest shadowed-to-open ratio. material.shadowSide = FrontSide closes it as well.
// PRD-650: a still lamp keeps its map. Over 300 still frames neither lamp draws a caster; a caster
// moving inside a lamp's range redraws it, one moving outside its range does not, and the kept map
// still shadows the floor as a fresh one does.
void lampCache() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(96, 96);
    OrthographicCamera camera(-4, 4, 4, -4, 0.1, 20);
    camera.position.set(0, 10, 0.001);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    Scene scene;
    PointLight lamp{Color(1, 1, 1), 40, 6};  // range 6 m: the shadow camera's far
    lamp.position.set(-1.5, 2, 0);
    lamp.setCastShadow(true);
    scene.add(lamp);
    SpotLight spot{Color(1, 1, 1), 40, 6, 0.9};
    spot.position.set(1.5, 3, 0);
    spot.target->position.set(1.5, 0, 0);
    spot.setCastShadow(true);
    scene.add(spot);
    scene.add(*spot.target);
    auto white = std::make_shared<Material>(MaterialType::Standard);
    Mesh floor{makeBoxGeometry(8, 0.2, 8), white};
    floor.position.y = -0.1;
    floor.setReceiveShadow(true);
    scene.add(floor);
    Mesh near{makeBoxGeometry(0.6, 0.6, 0.6), white};
    near.position.set(-1.5, 1, 0);
    near.setCastShadow(true);
    scene.add(near);
    Mesh far{makeBoxGeometry(0.6, 0.6, 0.6), white};
    far.position.set(30, 1, 0);  // 31 m from the lamp, 28.5 m from the spot: beyond both ranges
    far.setCastShadow(true);
    scene.add(far);
    RenderDatabase database;
    database.shadowMapEnabled = true;
    const auto frame = [&] {
        scene.updateMatrixWorld(true);
        database.render(renderer, scene, camera);
        return renderer.lastFrame().shadowDraws;
    };
    const auto pixels = [&] {
        std::vector<uint8_t> out;
        bool read = false;
        renderer.readPixels([&](GpuStatus status, std::vector<uint8_t> px) {
            if (status == GpuStatus::Ok) out = std::move(px);
            read = true;
        });
        for (int i = 0; i < 5000 && !read; ++i) {
            renderer.poll();
            events.drain();
            if (!read) std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
        CHECK(out.size() == size_t{96} * 96 * 4);
        return out;
    };
    const uint64_t first = frame();
    CHECK(first > 0);
    // Both lamps redraw on the first frame, a cube's six faces as one, and every shadow draw is theirs.
    CHECK(renderer.lastFrame().lampRedraws == 2);
    CHECK(renderer.lastFrame().lampShadowDraws == first);
    const std::vector<uint8_t> fresh = pixels();
    uint64_t still = 0;
    for (int i = 0; i < 300; ++i) still += frame();
    std::printf("lamp cache: first %llu, 300 still frames %llu\n", (unsigned long long)first, (unsigned long long)still);
    CHECK(still == 0);
    const std::vector<uint8_t> kept = pixels();
    int differ = 0;
    for (size_t k = 0; k < kept.size(); ++k) differ += std::abs(int(kept[k]) - int(fresh[k])) > 2;
    std::printf("lamp cache: kept map differs on %d channels\n", differ);
    CHECK(differ == 0);
    far.position.x = 31;
    const uint64_t outside = frame();
    std::printf("lamp cache: caster moved outside range %llu\n", (unsigned long long)outside);
    CHECK(outside == 0);
    near.position.x = -1.2;
    const uint64_t inside = frame();
    std::printf("lamp cache: caster moved inside range %llu\n", (unsigned long long)inside);
    CHECK(inside > 0);
    CHECK(renderer.lastFrame().lampRedraws >= 1);  // the box moved inside the point light's range
    CHECK(frame() == 0);
    // A mixed-light frame: the sun's map redraws, the lamps' stay cached, and the two parts add up.
    DirectionalLight sun{Color(1, 1, 1), 2};
    sun.position.set(2, 8, 1);
    sun.setCastShadow(true);
    scene.add(sun);
    const uint64_t mixed = frame();
    std::printf("lamp cache: mixed frame %llu shadow draws, %u lamp\n", (unsigned long long)mixed, renderer.lastFrame().lampShadowDraws);
    CHECK(mixed > 0);
    CHECK(renderer.lastFrame().lampRedraws == 0 && renderer.lastFrame().lampShadowDraws == 0);
    near.position.x = -1.5;
    const uint64_t both = frame();
    std::printf("lamp cache: mixed frame with a moved caster %llu shadow draws, %u lamp, %u lamp maps\n", (unsigned long long)both,
                renderer.lastFrame().lampShadowDraws, renderer.lastFrame().lampRedraws);
    CHECK(renderer.lastFrame().lampRedraws >= 1);
    CHECK(renderer.lastFrame().lampShadowDraws > 0 && renderer.lastFrame().lampShadowDraws < both);
}

// PRD-650: a lamp whose map is cached must not pack or upload its casters' uniform slices. One
// shadow-only caster under a still spot light is compared with an empty control renderer of the
// same output state: the cached frame uploads the control's bytes and draws no shadow.
void cachedLampHasNoUniformUpload() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    Renderer control(context.getInstance(), context.getDevice(), context.getQueue(), events);
    const auto configure = [](Renderer& r) {
        r.setSize(96, 96);
        r.setOutput(OutputState{shader::ToneMapping::ACESFilmic, 1, true});
    };
    configure(renderer);
    configure(control);
    CameraState camera;
    const double near = 0.1, far = 10, cz = -far / (far - near), d = -far * near / (far - near);
    camera.matrixWorldInverse = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -6, 1};
    camera.matrixWorld = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 6, 1};
    camera.projectionMatrix = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, cz, -1, 0, 0, d, 0};
    shader::StandardMaterial material;
    BufferStore positions(Scalar::F32, 9);
    const float triangle[] = {-1, -1, 0.5f, 1, -1, 0.5f, 0, 1, 0.5f};
    positions.write(0, triangle, sizeof triangle);
    DrawItem caster;
    caster.key = caster.id = 1;
    caster.positions = &positions;
    caster.material = &material;
    caster.mainPass = false;
    caster.castShadow = true;
    caster.matrixWorld = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
    const std::span<const DrawItem> items(&caster, 1);
    LightState lights;
    DirectLight spot;
    spot.id = 1;
    spot.kind = DirectLight::Kind::Spot;
    spot.position = {0, 3, 0};
    spot.direction = {0, 1, 0};
    spot.coneCos = 0.5;
    spot.penumbraCos = 0.4;
    DirectLight::Shadow shadow;
    shadow.width = shadow.height = 256;  // the game's fixed size, so the footprint rule leaves it alone
    shadow.view = camera.matrixWorldInverse;
    shadow.projection = camera.projectionMatrix;
    shadow.matrix = camera.matrixWorldInverse;
    shadow.near = near;
    shadow.far = far;
    shadow.layersMask = 1;
    spot.shadow = shadow;
    lights.direct.push_back(spot);
    const std::array<double, 4> clear{0.05, 0.06, 0.08, 1};
    const auto framePair = [&] {
        const auto upload = [&](Renderer& r, std::span<const DrawItem> draws) {
            const uint64_t before = r.gpu().queueWriteBytes();
            r.render(draws, camera, lights, clear);
            return r.gpu().queueWriteBytes() - before;
        };
        const uint64_t bytes = upload(renderer, items), baseline = upload(control, {});
        renderer.poll();
        control.poll();
        events.drain();
        return std::pair{bytes, baseline};
    };
    for (int warm = 0; warm < 4; ++warm) framePair();
    const auto [cached, baseline] = framePair();
    std::printf("cached lamp upload: caster %llu bytes, empty control %llu bytes, %u shadow draws\n",
                static_cast<unsigned long long>(cached), static_cast<unsigned long long>(baseline),
                renderer.lastFrame().shadowDraws);
    CHECK(renderer.lastFrame().shadowDraws == 0);
    CHECK(cached == baseline);
    // The signature still redraws on a changed material cut and on a resized map, and caches again.
    material.alphaTest = 0.5f;
    const auto cut = framePair().first;
    std::printf("cached lamp upload: changed cut %llu bytes, %u shadow draws\n",
                static_cast<unsigned long long>(cut), renderer.lastFrame().shadowDraws);
    CHECK(renderer.lastFrame().shadowDraws > 0);
    const auto [cutCached, cutBaseline] = framePair();
    CHECK(renderer.lastFrame().shadowDraws == 0);
    CHECK(cutCached == cutBaseline);
    lights.direct[0].shadow->width = lights.direct[0].shadow->height = 128;
    const auto resized = framePair().first;
    std::printf("cached lamp upload: resized map %llu bytes, %u shadow draws\n",
                static_cast<unsigned long long>(resized), renderer.lastFrame().shadowDraws);
    CHECK(renderer.lastFrame().shadowDraws > 0);
    const auto [resizedCached, resizedBaseline] = framePair();
    CHECK(renderer.lastFrame().shadowDraws == 0);
    CHECK(resizedCached == resizedBaseline);
}

void sunCache() {
    // An ordinary sun map is kept like a lamp's while nothing it draws changed: no shadow draw is encoded and
    // none of their uniforms is uploaded, and the kept map shades the frame the same. A caster or the light moving redraws it.
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(96, 96);
    OrthographicCamera camera(-4, 4, 4, -4, 0.1, 20);
    camera.position.set(0, 10, 0.001);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    Scene scene;
    DirectionalLight sun{Color(1, 1, 1), 2};
    sun.position.set(2, 8, 1);
    sun.setCastShadow(true);
    scene.add(sun);
    auto white = std::make_shared<Material>(MaterialType::Standard);
    Mesh floor{makeBoxGeometry(8, 0.2, 8), white};
    floor.position.y = -0.1;
    floor.setReceiveShadow(true);
    scene.add(floor);
    Mesh box{makeBoxGeometry(0.6, 0.6, 0.6), white};
    box.position.set(0, 1, 0);
    box.setCastShadow(true);
    scene.add(box);
    RenderDatabase database;
    database.shadowMapEnabled = true;
    const auto frame = [&] {
        scene.updateMatrixWorld(true);
        database.render(renderer, scene, camera);
        return renderer.lastFrame().shadowDraws;
    };
    const auto pixels = [&] {
        std::vector<uint8_t> out;
        bool read = false;
        renderer.readPixels([&](GpuStatus status, std::vector<uint8_t> px) {
            if (status == GpuStatus::Ok) out = std::move(px);
            read = true;
        });
        for (int i = 0; i < 5000 && !read; ++i) {
            renderer.poll();
            events.drain();
            if (!read) std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
        CHECK(out.size() == size_t{96} * 96 * 4);
        return out;
    };
    const uint64_t first = frame();
    const uint64_t drawnBytes = renderer.lastFrame().uniformBytes;
    CHECK(first > 0 && renderer.lastFrame().keptShadowMaps == 0);
    const std::vector<uint8_t> fresh = pixels();
    uint64_t still = 0;
    for (int i = 0; i < 60; ++i) still += frame();
    std::printf("sun cache: first %llu draws %llu uniform bytes, 60 still frames %llu draws %llu bytes, %u kept\n",
                (unsigned long long)first, (unsigned long long)drawnBytes, (unsigned long long)still,
                (unsigned long long)renderer.lastFrame().uniformBytes, renderer.lastFrame().keptShadowMaps);
    CHECK(still == 0);
    CHECK(renderer.lastFrame().keptShadowMaps == 1);
    CHECK(renderer.lastFrame().uniformBytes < drawnBytes);
    const std::vector<uint8_t> kept = pixels();
    int differ = 0;
    for (size_t k = 0; k < kept.size(); ++k) differ += std::abs(int(kept[k]) - int(fresh[k])) > 2;
    std::printf("sun cache: kept map differs on %d channels\n", differ);
    CHECK(differ == 0);
    box.position.x = 0.5;
    const uint64_t moved = frame();
    std::printf("sun cache: caster moved %llu\n", (unsigned long long)moved);
    CHECK(moved > 0 && renderer.lastFrame().keptShadowMaps == 0);
    const std::vector<uint8_t> shifted = pixels();
    differ = 0;
    for (size_t k = 0; k < shifted.size(); ++k) differ += std::abs(int(shifted[k]) - int(fresh[k])) > 2;
    CHECK(differ > 0);  // the shadow followed the box
    CHECK(frame() == 0);
    // The mirror position flips the signs of the view's x terms in pairs, which a word-wise FNV signature cancelled.
    sun.position.set(-2, 8, 1);
    const uint64_t lit = frame();
    std::printf("sun cache: light moved to its mirror image %llu\n", (unsigned long long)lit);
    CHECK(lit > 0);
    CHECK(frame() == 0);
}

void lampAtlas() {
    // PRD-650 Phase 1: Unreal's local-light rule picks the map from the pixel footprint.
    using shadows::LampDemand;
    CHECK((shadows::lampMapSizes({LampDemand{17}, LampDemand{30}}) == std::vector<uint32_t>{1024, 1024}));
    CHECK((shadows::lampMapSizes({LampDemand{17, 1}}) == std::vector<uint32_t>{512}));  // moving: one mip coarser
    // Over the budget one global bias rises: the lamp nearest its next coarser mip (30 texels) steps first.
    CHECK((shadows::lampMapSizes({LampDemand{17}, LampDemand{30}}, 1024.0 * 1024 + 512 * 512) == std::vector<uint32_t>{1024, 512}));
    CHECK((shadows::lampMapSizes({LampDemand{17, 0, true}, LampDemand{30}}, 1) == std::vector<uint32_t>{128, 128}));

    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(256, 256);
    PerspectiveCamera camera(50, 1, 0.1, 100);
    Scene scene;
    SpotLight spot{Color(1, 1, 1), 40, 0, 0.6};
    spot.position.set(0, 3, 0);
    spot.target->position.set(0, 0, 0);
    spot.setCastShadow(true);
    scene.add(spot);
    scene.add(*spot.target);
    auto white = std::make_shared<Material>(MaterialType::Standard);
    Mesh floor{makeBoxGeometry(60, 0.2, 60), white};
    floor.position.y = -0.1;
    floor.setReceiveShadow(true);
    scene.add(floor);
    Mesh box{makeBoxGeometry(0.4, 0.4, 0.4), white};
    box.position.set(0, 1, 0);
    box.setCastShadow(true);
    scene.add(box);
    RenderDatabase database;
    database.shadowMapEnabled = true;
    const auto sizeFrom = [&](double away) {
        camera.position.set(0, 1.2, away);
        camera.lookAt(0, 0, 0);
        scene.updateMatrixWorld(true);
        database.render(renderer, scene, camera);
        return renderer.lampShadowSize(0);
    };
    const uint32_t near = sizeFrom(2), far = sizeFrom(20);
    std::printf("lamp atlas: 2 m %u, 20 m %u\n", near, far);
    CHECK(near > far);
    CHECK(near > 128 && near < 16384);
    for (int i = 0; i < 12; ++i) sizeFrom(2);
    const uint32_t still = renderer.lampShadowSize(0);
    CHECK(still == near);
    for (int i = 0; i < 3; ++i) {
        spot.position.x += 0.001;
        sizeFrom(2);
    }
    const uint32_t moving = renderer.lampShadowSize(0);
    for (int i = 0; i < 12; ++i) sizeFrom(2);
    const uint32_t settled = renderer.lampShadowSize(0);
    std::printf("lamp atlas: still %u, moving %u, settled %u\n", still, moving, settled);
    CHECK(moving * 2 == still);
    CHECK(settled == still);
    spot.shadow.mapSize.set(300, 300);
    sizeFrom(2);
    CHECK(renderer.lampShadowSize(0) == 300);  // the game's mapSize overrides, and says so
    CHECK(std::any_of(renderer.diagnostics().begin(), renderer.diagnostics().end(),
                      [](const std::string& d) { return d.starts_with("TN_LAMP_SHADOW_MAPSIZE_OVERRIDE"); }));
}

void contactShadowFoot() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(192, 192);
    // 0.4 m across the box's far foot at x = 2: about 2 mm per pixel.
    OrthographicCamera camera(-0.2, 0.2, 0.2, -0.2, 0.1, 20);
    camera.position.set(2, 10, 0.001);
    camera.lookAt(2, 0, 0);
    camera.updateProjectionMatrix();
    const auto strip = [&](std::optional<Side> side, double bias, double normalBias) -> std::array<double, 2> {
        Scene scene;
        PointLight lamp{Color(1, 1, 1), 60};
        lamp.position.set(0, 3, 0);
        lamp.setCastShadow(true);
        lamp.shadow.bias = bias;
        lamp.shadow.normalBias = normalBias;
        lamp.shadow.camera->setLayerMask(double((1 << 0) | (1 << 2)));
        scene.add(lamp);
        auto white = std::make_shared<Material>(MaterialType::Standard);
        white->shadowSide = side;
        Mesh floor{makeBoxGeometry(6, 0.2, 6), white};
        floor.position.y = -0.1;
        floor.setCastShadow(true);
        floor.setReceiveShadow(true);
        scene.add(floor);
        // The box covers x 1..2 at z -0.5..0.5, 2 m tall, on layer 2: the camera sees the floor at x > 2.
        Mesh box{makeBoxGeometry(1, 2, 1), white};
        box.position.set(1.5, 1, 0);
        box.setCastShadow(true);
        box.setLayer(2);
        scene.add(box);
        scene.updateMatrixWorld(true);
        RenderDatabase database;
        database.shadowMapEnabled = true;
        const auto row = [&] {
            database.render(renderer, scene, camera);
            std::vector<uint8_t> pixels;
            bool read = false;
            renderer.readPixels([&](GpuStatus status, std::vector<uint8_t> px) {
                if (status == GpuStatus::Ok) pixels = std::move(px);
                read = true;
            });
            for (int i = 0; i < 5000 && !read; ++i) {
                renderer.poll();
                events.drain();
                if (!read) std::this_thread::sleep_for(std::chrono::milliseconds(1));
            }
            CHECK(pixels.size() == size_t{192} * 192 * 4);
            std::vector<double> red(192);
            for (int x = 0; x < 192; ++x) red[x] = pixels[(size_t{96} * 192 + x) * 4];
            return red;
        };
        const std::vector<double> shadowed = row();
        box.setCastShadow(false);
        const std::vector<double> open = row();
        lamp.setCastShadow(false);
        const std::vector<double> free = row();
        // Acne: the lit floor with no box shadow, against the floor with no shadow pass at all.
        double acne = 1;
        for (int x = 0; x < 192; ++x) acne = std::min(acne, open[x] / std::max(free[x], 1.0));
        // Floor x 2.0 .. 2.2 m beyond the foot: pixels 97 .. 191 on one side of the centre, the side
        // that is darker on average (the camera's x order is not assumed).
        std::array<double, 2> brightest{}, mean{};
        for (int i = 1; i <= 95; ++i)
            for (int side = 0; side < 2; ++side) {
                const int x = side == 0 ? 96 + i : 96 - i;
                const double ratio = shadowed[x] / std::max(open[x], 1.0);
                brightest[side] = std::max(brightest[side], ratio);
                mean[side] += ratio / 95;
            }
        CHECK(*std::max_element(open.begin(), open.end()) > 32);
        return std::array<double, 2>{mean[0] < mean[1] ? brightest[0] : brightest[1], acne};
    };
    const auto [backLeak, backKept] = strip(std::nullopt, 0, 0);
    const auto [frontLeak, frontKept] = strip(Side::Front, 0, 0);
    std::printf("contact foot: back faces leak %.3f, lit floor kept %.3f; shadowSide front leak %.3f, kept %.3f\n",
                backLeak, backKept, frontLeak, frontKept);
    CHECK(backLeak < 0.05);   // three's derived shadowSide: the far foot stays dark (0.859 without the lamp's back-face bias)
    CHECK(backKept > 0.95);   // and the lit floor does not shadow itself
    CHECK(frontLeak < 0.05);  // shadowSide = FrontSide, the faces Unreal draws: the foot stays dark
    CHECK(frontKept > 0.95);  // and the lit floor does not shadow itself
}

// The same far foot under a sun with a virtual shadow map: a front-sided caster with a null shadowSide
// draws its front faces into a virtual page, as Unreal's sun does, so the strip the box shades beside
// its foot stays dark. Back faces store the depth on the box's own far face, at the floor, and leak
// the sun along every seam where a box meets a surface (the sunlit room's inner wall edges).
void virtualSunContactFoot() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(192, 192);
    // 0.4 m across the box's far foot at x = 1: about 2 mm per pixel.
    OrthographicCamera camera(-0.2, 0.2, 0.2, -0.2, 0.1, 20);
    camera.position.set(1, 10, 0.001);
    camera.lookAt(1, 0, 0);
    camera.updateProjectionMatrix();
    const auto strip = [&](std::optional<Side> side) -> std::array<double, 2> {
        Scene scene;
        DirectionalLight sun{Color(1, 1, 1), 3};
        sun.position.set(3, 3, 0);  // 45 degrees: the box shades the floor at x < 1
        sun.setCastShadow(true);
        sun.shadow.camera->setLayerMask(double((1 << 0) | (1 << 2)));
        shadows::AtlasOptions atlas;
        atlas.clipExtents = {8}; atlas.mapSize = 512; atlas.pageTexels = 128;
        atlas.lightDistance = 20; atlas.depthRange = 40;
        sun.shadow.virtualShadow = std::make_shared<const shadows::AtlasOptions>(std::move(atlas));
        scene.add(sun);
        auto white = std::make_shared<Material>(MaterialType::Standard);
        white->shadowSide = side;
        Mesh floor{makeBoxGeometry(6, 0.2, 6), white};
        floor.position.y = -0.1;
        floor.setCastShadow(true);
        floor.setReceiveShadow(true);
        scene.add(floor);
        // The box covers x 1..2 at z -0.5..0.5, 2 m tall, on layer 2: the camera sees the floor at x < 1.
        Mesh box{makeBoxGeometry(1, 2, 1), white};
        box.position.set(1.5, 1, 0);
        box.setCastShadow(true);
        box.setLayer(2);
        scene.add(box);
        scene.updateMatrixWorld(true);
        RenderDatabase database;
        database.shadowMapEnabled = true;
        const auto row = [&] {
            for (int frame = 0; frame < 3; ++frame) database.render(renderer, scene, camera);
            std::vector<uint8_t> pixels;
            bool read = false;
            renderer.readPixels([&](GpuStatus status, std::vector<uint8_t> px) {
                if (status == GpuStatus::Ok) pixels = std::move(px);
                read = true;
            });
            for (int i = 0; i < 5000 && !read; ++i) {
                renderer.poll();
                events.drain();
                if (!read) std::this_thread::sleep_for(std::chrono::milliseconds(1));
            }
            CHECK(pixels.size() == size_t{192} * 192 * 4);
            std::vector<double> red(192);
            for (int x = 0; x < 192; ++x) red[x] = pixels[(size_t{96} * 192 + x) * 4];
            return red;
        };
        const std::vector<double> shadowed = row();
        box.setCastShadow(false);
        const std::vector<double> open = row();
        sun.setCastShadow(false);
        const std::vector<double> free = row();
        double acne = 1;
        for (int x = 0; x < 192; ++x) acne = std::min(acne, open[x] / std::max(free[x], 1.0));
        // The strip beside the foot, floor x 0.8 .. 1.0 m, on whichever side of the centre is darker.
        std::array<double, 2> brightest{}, mean{};
        for (int i = 1; i <= 95; ++i)
            for (int s = 0; s < 2; ++s) {
                const int x = s == 0 ? 96 + i : 96 - i;
                const double ratio = shadowed[x] / std::max(open[x], 1.0);
                brightest[s] = std::max(brightest[s], ratio);
                mean[s] += ratio / 95;
            }
        CHECK(*std::max_element(open.begin(), open.end()) > 32);
        return std::array<double, 2>{mean[0] < mean[1] ? brightest[0] : brightest[1], acne};
    };
    const auto [derivedLeak, derivedKept] = strip(std::nullopt);
    const auto [frontLeak, frontKept] = strip(Side::Front);
    std::printf("virtual sun foot: derived leak %.3f, kept %.3f; shadowSide front leak %.3f, kept %.3f\n",
                derivedLeak, derivedKept, frontLeak, frontKept);
    CHECK(frontLeak < 0.05);    // the faces the sun sees store the depth, so the foot stays dark
    CHECK(derivedLeak < 0.05);  // and a null shadowSide on a virtual page draws them too
    CHECK(derivedKept > 0.95);  // without the lit floor shadowing itself
}

// The sunlit room's inner seams under a sun with a virtual shadow map and a source-angle filter. A roofed room
// (a wall, a floor slab and a roof slab 0.2 m thick, the sun on the open side) is dark wherever the sun cannot
// reach, so every lit pixel along a seam is a leak. The receivers sit far from the light's near plane (40 m), as
// under a tall caster, so the filter's blocker search is wide (0.26 m) and its taps compare with the receiver
// plane's depth at each tap. The roof's gap to the wall, 0.2 m / sin(sun), is far under that search: the sun
// must still stay out, and a lit surface must not shadow itself. Back faces store the depth on the receiving
// surface itself and let the sun in along the seam, which the last arm shows (the proof can fail).
void virtualSunRoomSeam() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(192, 192);
    struct View { const char* name; double elevation; bool floorView; };
    const View views[] = {{"wall under the roof, sun 60", 60, false}, {"wall under the roof, sun 15", 15, false},
                          {"floor at the wall, sun 60", 60, true}, {"floor at the wall, sun 15", 15, true}};
    // The lit band of a roofed seam in metres, and the least share of an open surface that stays lit.
    const auto seam = [&](const View& view, std::optional<Side> side) -> std::array<double, 2> {
        Scene scene;
        DirectionalLight sun{Color(1, 1, 1), 6};
        const double elevation = view.elevation * M_PI / 180, azimuth = 25 * M_PI / 180;
        sun.position.set(40 * std::sin(azimuth) * std::cos(elevation), 40 * std::sin(elevation), 40 * std::cos(azimuth) * std::cos(elevation));
        sun.setCastShadow(true);
        sun.shadow.camera->setLayerMask(double((1 << 0) | (1 << 2)));
        shadows::AtlasOptions atlas;
        // The coarse level of the sunlit room: 22.4 m across 2048 texels, about 11 mm each.
        atlas.clipExtents = {11.2}; atlas.mapSize = 2048; atlas.pageTexels = 128;
        atlas.lightDistance = 40; atlas.depthRange = 40;
        sun.shadow.virtualShadow = std::make_shared<const shadows::AtlasOptions>(std::move(atlas));
        sun.shadow.sourceAngleFilter = std::array<double, 6>{0.006421, 16, 16, 0};  // Unreal's sun, 0.7357 degrees across
        scene.add(sun);
        auto white = std::make_shared<Material>(MaterialType::Standard);
        white->shadowSide = side;
        // The back wall's inner face is the plane z = 0, from the floor top (y = 0) to the roof underside (y = 3).
        // The room's slabs reach the sun's side far enough that no ray to the room passes round them.
        Mesh wall{makeBoxGeometry(30, 3.2, 0.2), white};
        wall.position.set(0, 1.4, -0.1);
        wall.setCastShadow(true);
        wall.setReceiveShadow(true);
        scene.add(wall);
        Mesh floor{makeBoxGeometry(30, 0.2, 40), white};
        floor.position.set(0, -0.1, 19.8);
        floor.setCastShadow(true);
        floor.setReceiveShadow(true);
        scene.add(floor);
        // The roof slab covers the room. Layer 2: the camera sees the wall and floor, the shadow camera sees all.
        Mesh roof{makeBoxGeometry(30, 0.2, 40), white};
        roof.position.set(0, 3.1, 19.8);
        roof.setCastShadow(true);
        roof.setLayer(2);
        scene.add(roof);
        // A 0.4 m square of the wall just under the roof, or of the floor just in front of the wall.
        OrthographicCamera camera(-0.2, 0.2, 0.2, -0.2, 0.1, 20);
        if (view.floorView) { camera.up.set(0, 0, -1); camera.position.set(0, 6, 0.2); camera.lookAt(0, 0, 0.2); }
        else { camera.position.set(0, 2.8, 6); camera.lookAt(0, 2.8, 0); }
        camera.updateProjectionMatrix();
        scene.updateMatrixWorld(true);
        RenderDatabase database;
        database.shadowMapEnabled = true;
        const auto frame = [&] {
            for (int i = 0; i < 3; ++i) database.render(renderer, scene, camera);
            std::vector<uint8_t> pixels;
            bool read = false;
            renderer.readPixels([&](GpuStatus status, std::vector<uint8_t> px) {
                if (status == GpuStatus::Ok) pixels = std::move(px);
                read = true;
            });
            for (int i = 0; i < 5000 && !read; ++i) {
                renderer.poll();
                events.drain();
                if (!read) std::this_thread::sleep_for(std::chrono::milliseconds(1));
            }
            CHECK(pixels.size() == size_t{192} * 192 * 4);
            std::vector<double> red(size_t{192} * 192);
            for (size_t i = 0; i < red.size(); ++i) red[i] = pixels[i * 4];
            return red;
        };
        const std::vector<double> roofed = frame();
        roof.setCastShadow(false);
        const std::vector<double> open = frame();
        sun.setCastShadow(false);
        const std::vector<double> free = frame();
        CHECK(*std::max_element(free.begin(), free.end()) > 24);
        // Rows with a lit pixel under the roof, and the least lit share of the open surface without it.
        int leakRows = 0;
        double kept = 1;
        for (int y = 0; y < 192; ++y) {
            bool lit = false;
            for (int x = 0; x < 192; ++x) {
                const size_t i = size_t(y) * 192 + x;
                if (free[i] < 8) continue;
                lit = lit || roofed[i] > 0.25 * free[i];
                kept = std::min(kept, open[i] / free[i]);
            }
            leakRows += lit;
        }
        return {double(leakRows) * 0.4 / 192, kept};
    };
    for (const View& view : views) {
        const auto [leak, kept] = seam(view, std::nullopt);
        std::printf("virtual sun room seam, %s: lit band %.1f mm, open surface kept %.3f\n", view.name, leak * 1000, kept);
        CHECK(leak < 0.025);  // under 2 texels: the sun does not come in along the seam
        CHECK(kept > 0.95);   // and the open surface does not shadow itself
    }
    const auto [backLeak, backKept] = seam(views[0], Side::Back);
    std::printf("virtual sun room seam, back faces, %s: lit band %.1f mm, open surface kept %.3f\n", views[0].name, backLeak * 1000, backKept);
    CHECK(backLeak > 0.05);  // the proof can fail: back faces put the depth on the wall and the sun comes in
}

// A shadow edge is never narrower than `minPenumbraPixels` of the receiver's pixels: a tall caster's far edge
// on a floor has a penumbra of a few millimetres and a texel under a pixel, so it is one hard step that crawls
// as the camera moves. The floor widens the filter disc to the pixel, measured here as the 10 to 90 percent
// width of the edge in pixels, for a floor of 0, 1 and 2 pixels.
void virtualSunPixelFloor() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(192, 192);
    // 3.2 m across 192 pixels: 17 mm each, over twice the 7.8 mm texel of the finest level.
    OrthographicCamera camera(-1.6, 1.6, 1.6, -1.6, 0.1, 20);
    camera.position.set(0, 10, 0.001);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    const auto edgeWidth = [&](double minPixels) {
        Scene scene;
        DirectionalLight sun{Color(1, 1, 1), 3};
        sun.position.set(3, 3, 0);  // 45 degrees: a 0.3 m plate shades the floor 0.3 m before its edge
        sun.setCastShadow(true);
        sun.shadow.camera->setLayerMask(double((1 << 0) | (1 << 2)));
        shadows::AtlasOptions atlas;
        atlas.clipExtents = {8}; atlas.mapSize = 2048; atlas.pageTexels = 128;
        atlas.lightDistance = 20; atlas.depthRange = 40;
        sun.shadow.virtualShadow = std::make_shared<const shadows::AtlasOptions>(std::move(atlas));
        sun.shadow.sourceAngleFilter = std::array<double, 6>{0.006421, 16, 16, minPixels};
        scene.add(sun);
        auto white = std::make_shared<Material>(MaterialType::Standard);
        Mesh floor{makeBoxGeometry(8, 0.2, 8), white};
        floor.position.y = -0.1;
        floor.setCastShadow(true);
        floor.setReceiveShadow(true);
        scene.add(floor);
        // The plate covers x 1..2, 0.3 m tall, on layer 2: the camera sees the floor and the shadow at x < 1.
        Mesh plate{makeBoxGeometry(1, 0.3, 1), white};
        plate.position.set(1.5, 0.15, 0);
        plate.setCastShadow(true);
        plate.setLayer(2);
        scene.add(plate);
        scene.updateMatrixWorld(true);
        RenderDatabase database;
        database.shadowMapEnabled = true;
        for (int frame = 0; frame < 3; ++frame) database.render(renderer, scene, camera);
        std::vector<uint8_t> pixels;
        bool read = false;
        renderer.readPixels([&](GpuStatus status, std::vector<uint8_t> px) {
            if (status == GpuStatus::Ok) pixels = std::move(px);
            read = true;
        });
        for (int i = 0; i < 5000 && !read; ++i) {
            renderer.poll();
            events.drain();
            if (!read) std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
        CHECK(pixels.size() == size_t{192} * 192 * 4);
        std::vector<double> red(192);
        for (int x = 0; x < 192; ++x) red[x] = pixels[(size_t{96} * 192 + x) * 4];
        // The floor is lit at x = -1.4 m (pixel 12) and dark inside the strip (pixel 150, x = 0.86 m).
        const double lit = red[12], dark = red[150];
        CHECK(lit > 32 && dark < 0.25 * lit);
        // The strip's lit-side edge sits at x = 0.7 m (pixel 138): find where it falls through 90 and 10 percent.
        double high = -1, low = -1;
        for (int x = 120; x < 150; ++x) {
            const double level = (red[x] - dark) / (lit - dark), next = (red[x + 1] - dark) / (lit - dark);
            if (level >= 0.9 && next < 0.9) high = x + (level - 0.9) / (level - next);
            if (level >= 0.1 && next < 0.1) low = x + (level - 0.1) / (level - next);
        }
        CHECK(high >= 0 && low >= high);
        return low - high;
    };
    const double none = edgeWidth(0), one = edgeWidth(1), two = edgeWidth(2);
    std::printf("virtual sun pixel floor: edge width %.2f px at 0, %.2f px at 1, %.2f px at 2\n", none, one, two);
    CHECK(none < 1.0);            // a hard edge without the floor
    CHECK(one > none + 0.5);      // each pixel of floor widens the edge, in quadrature with the texel
    CHECK(two > one + 0.5);
    CHECK(two < 4.5);             // and never the smear of a wide penumbra
}

// A clip level past the finest draws a caster's coarse AutoLOD rung only where one texel of the level hides
// the rung's error. The plate's only rung draws nothing, so the floor behind it is lit when the rung is used
// and dark when the plate keeps its own geometry. The strip is outside the 0.2 m finest window: level 1, 7.8 mm texels.
void virtualSunLodRung() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(192, 192);
    OrthographicCamera camera(-1.6, 1.6, 1.6, -1.6, 0.1, 20);
    camera.position.set(0, 10, 0.001);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    const auto stripLight = [&](double rungError, double texels = 1) {
        Scene scene;
        DirectionalLight sun{Color(1, 1, 1), 3};
        sun.position.set(3, 3, 0);
        sun.setCastShadow(true);
        sun.shadow.camera->setLayerMask(double((1 << 0) | (1 << 2)));
        auto white = std::make_shared<Material>(MaterialType::Standard);
        Mesh floor{makeBoxGeometry(8, 0.2, 8), white};
        floor.position.y = -0.1;
        floor.setCastShadow(true);
        floor.setReceiveShadow(true);
        scene.add(floor);
        auto own = makeBoxGeometry(1, 0.3, 1);
        Mesh plate{own, white};
        plate.position.set(1.5, 0.15, 0);
        plate.setCastShadow(true);
        plate.setLayer(2);
        scene.add(plate);
        shadows::AtlasOptions atlas;
        atlas.clipExtents = {0.2, 8}; atlas.mapSize = 2048; atlas.pageTexels = 128;
        atlas.lightDistance = 20; atlas.depthRange = 40;
        atlas.shadowLodBias = true;
        atlas.shadowLodTexels = texels;
        auto rung = own->clone();
        rung->setIndexFromArray({0, 0, 0});
        atlas.control->lods[plate.id()] = shadows::ShadowLodChain{{rung}, {rungError}};
        sun.shadow.virtualShadow = std::make_shared<const shadows::AtlasOptions>(std::move(atlas));
        scene.add(sun);
        scene.updateMatrixWorld(true);
        RenderDatabase database;
        database.shadowMapEnabled = true;
        for (int frame = 0; frame < 3; ++frame) database.render(renderer, scene, camera);
        std::vector<uint8_t> pixels;
        bool read = false;
        renderer.readPixels([&](GpuStatus status, std::vector<uint8_t> px) {
            if (status == GpuStatus::Ok) pixels = std::move(px);
            read = true;
        });
        for (int i = 0; i < 5000 && !read; ++i) {
            renderer.poll();
            events.drain();
            if (!read) std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
        CHECK(pixels.size() == size_t{192} * 192 * 4);
        // Pixel 12 is lit floor at x = -1.4 m; pixel 150 is x = 0.86 m, inside the plate's shadow (x 0.7 to 2).
        const double lit = pixels[(size_t{96} * 192 + 12) * 4], strip = pixels[(size_t{96} * 192 + 150) * 4];
        CHECK(lit > 32);
        return strip / lit;
    };
    const double coarse = stripLight(0.5), fine = stripLight(0.001), unbounded = stripLight(0.5, std::numeric_limits<double>::infinity());
    std::printf("virtual sun lod rung: strip %.2f of lit with a 0.5 m rung, %.2f with a 1 mm rung, %.2f with a 0.5 m rung and an unbounded budget\n",
                coarse, fine, unbounded);
    CHECK(coarse < 0.25);     // 0.5 m of error is 64 texels: the plate keeps its own geometry and casts
    CHECK(fine > 0.9);        // 1 mm is under a texel: the rung is drawn, and it casts nothing
    CHECK(unbounded > 0.9);   // shadowLodTexels = infinity draws the coarsest rung on every level, as before
}

// Levels of different sizes: the shader finds level 1's pages after level 0's own table. The strip under
// the plate lies outside the 1 m finest window, so level 1 (2048 texels) shades it while level 0 holds 256.
void virtualSunLevelSizes() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(192, 192);
    OrthographicCamera camera(-1.6, 1.6, 1.6, -1.6, 0.1, 20);
    camera.position.set(0, 10, 0.001);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    const auto stripLight = [&](std::vector<int> sizes) {
        Scene scene;
        DirectionalLight sun{Color(1, 1, 1), 3};
        sun.position.set(3, 3, 0);
        sun.setCastShadow(true);
        auto white = std::make_shared<Material>(MaterialType::Standard);
        Mesh floor{makeBoxGeometry(8, 0.2, 8), white};
        floor.position.y = -0.1;
        floor.setCastShadow(true);
        floor.setReceiveShadow(true);
        scene.add(floor);
        Mesh plate{makeBoxGeometry(1, 0.3, 1), white};
        plate.position.set(1.5, 0.15, 0);
        plate.setCastShadow(true);
        scene.add(plate);
        shadows::AtlasOptions atlas;
        atlas.clipExtents = {1, 8}; atlas.mapSize = 2048; atlas.levelMapSizes = std::move(sizes); atlas.pageTexels = 128;
        atlas.lightDistance = 20; atlas.depthRange = 40;
        sun.shadow.virtualShadow = std::make_shared<const shadows::AtlasOptions>(std::move(atlas));
        scene.add(sun);
        scene.updateMatrixWorld(true);
        RenderDatabase database;
        database.shadowMapEnabled = true;
        for (int frame = 0; frame < 3; ++frame) database.render(renderer, scene, camera);
        std::vector<uint8_t> pixels;
        bool read = false;
        renderer.readPixels([&](GpuStatus status, std::vector<uint8_t> px) {
            if (status == GpuStatus::Ok) pixels = std::move(px);
            read = true;
        });
        for (int i = 0; i < 5000 && !read; ++i) {
            renderer.poll();
            events.drain();
            if (!read) std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
        CHECK(pixels.size() == size_t{192} * 192 * 4);
        if (pixels.size() != size_t{192} * 192 * 4) return 1.0;
        // Pixel 12 is lit floor at x = -1.4 m; pixel 150 is x = 0.86 m, inside the plate's shadow (x 0.7 to 1).
        const double lit = pixels[(size_t{96} * 192 + 12) * 4], strip = pixels[(size_t{96} * 192 + 150) * 4];
        CHECK(lit > 32);
        return strip / lit;
    };
    const double same = stripLight({}), mixed = stripLight({256, 2048});
    std::printf("virtual sun level sizes: strip %.2f of lit with one size, %.2f with 256 and 2048\n", same, mixed);
    CHECK(same < 0.25);
    CHECK(mixed < 0.25);
}

// An auto-sized sun measures Unreal's texel rule on the view that renders it: 2944 texels per level at
// hfov 60 and 1280 px (core's clipmapMapSizes numbers), and the atlas is rebuilt when the fov widens.
void virtualSunAutoMapSize() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(1280, 720);
    const auto verticalFov = [](double hfov) { return 2 * std::atan(std::tan(hfov * M_PI / 360) * 720 / 1280) * 180 / M_PI; };
    PerspectiveCamera camera(verticalFov(60), 1280.0 / 720, 0.1, 200);
    camera.position.set(0, 1.7, 5);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    Scene scene;
    DirectionalLight sun{Color(1, 1, 1), 3};
    sun.position.set(3, 3, 0);
    sun.setCastShadow(true);
    Mesh floor{makeBoxGeometry(8, 0.2, 8), std::make_shared<Material>(MaterialType::Standard)};
    floor.position.y = -0.1;
    floor.setCastShadow(true);
    floor.setReceiveShadow(true);
    scene.add(floor);
    shadows::AtlasOptions atlas;
    atlas.clipExtents = {7, 14, 28, 56}; atlas.mapSize = 512; atlas.moverMapSize = 512;
    atlas.lightDistance = 20; atlas.depthRange = 40; atlas.autoMapSize = true;
    sun.shadow.virtualShadow = std::make_shared<const shadows::AtlasOptions>(std::move(atlas));
    scene.add(sun);
    scene.updateMatrixWorld(true);
    RenderDatabase database;
    database.shadowMapEnabled = true;
    database.render(renderer, scene, camera);
    const auto* plan = renderer.virtualShadowAtlas(0);
    CHECK(plan != nullptr);
    if (!plan) return;
    const int at60 = plan->mapSize(0), coarse60 = plan->mapSize(3);
    camera.fov = verticalFov(75);
    camera.updateProjectionMatrix();
    database.render(renderer, scene, camera);
    plan = renderer.virtualShadowAtlas(0);
    CHECK(plan != nullptr);
    if (!plan) return;
    std::printf("virtual sun auto map size: %d (coarsest %d) at hfov 60, %d at hfov 75, atlas %d\n", at60, coarse60, plan->mapSize(0), plan->edge());
    CHECK(at60 == 2944 && coarse60 == 2944);
    CHECK(plan->mapSize(0) == 2176);  // ceil(1280 / (0.775 tan 37.5) / 128) pages
}

// A point light's cube shadow: five casters around and below the lamp each shade the floor where its
// shadow lands, through four side faces and the bottom one, and the floor between them stays lit.
void pointShadowCubeFaces() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(96, 96);
    Scene scene;
    OrthographicCamera camera(-3, 3, 3, -3, 0.1, 20);
    camera.position.set(0, 10, 0.001);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    PointLight lamp{Color(1, 1, 1), 40};
    lamp.position.set(0, 2, 0);
    lamp.setCastShadow(true);
    lamp.shadow.camera->setLayerMask(double((1 << 0) | (1 << 2)));
    scene.add(lamp);
    Mesh floor{makePlaneGeometry(6, 6), std::make_shared<Material>(MaterialType::Standard)};
    floor.rotation.set(-M_PI / 2, 0, 0);
    floor.setReceiveShadow(true);
    scene.add(floor);
    // Casters on layer 2 only: the camera sees the floor under them. A box at (x, 0.5, z) throws its
    // shadow centre to (x, z) x 2 / 1.5 on the floor.
    const auto box = makeBoxGeometry(0.4, 0.4, 0.4);
    std::vector<std::unique_ptr<Mesh>> casters;
    const double sites[5][2] = {{1, 0}, {-1, 0}, {0, 1}, {0, -1}, {0, 0}};
    for (const auto& site : sites) {
        auto& caster = casters.emplace_back(std::make_unique<Mesh>(box, std::make_shared<Material>(MaterialType::Standard)));
        caster->position.set(site[0], site[0] == 0 && site[1] == 0 ? 1.0 : 0.5, site[1]);
        caster->setCastShadow(true);
        caster->setLayer(2);
        scene.add(*caster);
    }
    scene.updateMatrixWorld(true);
    RenderDatabase database;
    database.shadowMapEnabled = true;
    database.render(renderer, scene, camera);
    std::vector<uint8_t> pixels;
    bool read = false;
    renderer.readPixels([&](GpuStatus status, std::vector<uint8_t> px) {
        if (status == GpuStatus::Ok) pixels = std::move(px);
        read = true;
    });
    for (int i = 0; i < 5000 && !read; ++i) {
        renderer.poll();
        events.drain();
        if (!read) std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    CHECK(pixels.size() == size_t{96} * 96 * 4);
    // 16 pixels per metre; the floor point (x, z) is the pixel 48 + 16 x, 48 + 16 z up to the camera's
    // axis order, and the five sites are symmetric under it.
    const auto red = [&](double x, double z) { return pixels[(size_t(48 + 16 * z) * 96 + size_t(48 + 16 * x)) * 4]; };
    const double reach = 2.0 / 1.5;
    const unsigned lit = std::min({red(reach, reach), red(-reach, reach), red(reach, -reach), red(-reach, -reach)});
    std::printf("point shadow: lit %u, +x %u, -x %u, +z %u, -z %u, below %u\n", lit, red(reach, 0), red(-reach, 0),
                red(0, reach), red(0, -reach), red(0, 0));
    CHECK(lit > 64);
    for (const auto& site : sites) CHECK(red(site[0] * reach, site[1] * reach) < lit / 2);
}

// three.js projectObject frustum-culls shadow casters against each shadow camera frustum.
void shadowCasterFrustumCulling() {
    Scene scene; PerspectiveCamera camera; LightState lights; RenderDatabase database;
    database.shadowMapEnabled = true;
    database.batching = false;
    camera.position.set(0, 0, 100);
    camera.lookAt(0, 0, 200);
    camera.near = 1; camera.far = 50;
    camera.updateProjectionMatrix();

    auto light = std::make_shared<DirectionalLight>(Color(1, 1, 1), 1.0);
    light->setCastShadow(true);
    light->position.set(0, 10, 0);
    light->target->position.set(0, 0, 0);
    light->shadow.camera->setLayerMask(double((1 << 0) | (1 << 2)));
    auto& shadowCam = static_cast<OrthographicCamera&>(*light->shadow.camera);
    shadowCam.left = -2; shadowCam.right = 2;
    shadowCam.top = 2; shadowCam.bottom = -2;
    shadowCam.near = 1; shadowCam.far = 20;
    shadowCam.updateProjectionMatrix();
    scene.add(*light);

    const auto geometry = makeBoxGeometry();
    const auto material = std::make_shared<Material>(MaterialType::Standard);
    const auto addCaster = [&](double x, double y, double z) {
        auto mesh = std::make_shared<Mesh>(geometry, material);
        mesh->position.set(x, y, z);
        mesh->setCastShadow(true);
        mesh->setLayer(2);
        scene.add(*mesh);
        return mesh;
    };

    const auto inside = addCaster(0, 0, 0);
    const auto farOutside = addCaster(200, 0, 0);
    const auto unculledOutside = addCaster(-200, 0, 0);
    unculledOutside->frustumCulled = false;

    const auto& items = database.prepare(scene, camera, lights);
    std::size_t main = 0, shadowOnly = 0;
    for (const auto& item : items) (item.mainPass ? main : shadowOnly) += 1;
    std::printf("shadow caster frustum culling: %zu main, %zu shadow-only of %zu items\n", main, shadowOnly, items.size());
    CHECK(main == 0);
    CHECK(shadowOnly == 2);
    // VSM owns wider camera-centred windows; the source light's narrow camera cannot reject casters.
    const auto& virtualItems = database.prepare(scene, camera, lights, nullptr, true);
    CHECK(virtualItems.size() == 3);
    for (const auto& item : virtualItems) CHECK(item.castShadow && !item.mainPass);
    CHECK(database.prepare(scene, camera, lights).size() == 2);
    (void)inside; (void)farOutside; (void)unculledOutside;
}

// The shadow-light list is cached across frames; it must still follow the hierarchy and visibility
// the per-frame walk read: a hidden ancestor, a removed light and a re-added one.
void shadowLightsFollowHierarchy() {
    Scene scene; PerspectiveCamera camera; LightState lights; RenderDatabase database;
    database.shadowMapEnabled = true;
    database.batching = false;
    camera.position.set(0, 0, 100);
    camera.lookAt(0, 0, 200);
    camera.near = 1; camera.far = 50;
    camera.updateProjectionMatrix();
    Group rig;
    auto light = std::make_shared<DirectionalLight>(Color(1, 1, 1), 1.0);
    light->setCastShadow(true);
    light->position.set(0, 10, 0);
    auto& shadowCam = static_cast<OrthographicCamera&>(*light->shadow.camera);
    shadowCam.left = -2; shadowCam.right = 2;
    shadowCam.top = 2; shadowCam.bottom = -2;
    shadowCam.near = 1; shadowCam.far = 20;
    shadowCam.updateProjectionMatrix();
    rig.add(*light);
    scene.add(rig);
    const auto geometry = makeBoxGeometry();
    Mesh caster(geometry, std::make_shared<Material>(MaterialType::Standard));
    caster.setCastShadow(true);
    scene.add(caster);
    const auto shadowOnly = [&] {
        std::size_t count = 0;
        for (const auto& item : database.prepare(scene, camera, lights)) count += !item.mainPass;
        return count;
    };
    std::vector<std::size_t> seen;
    seen.push_back(shadowOnly());
    rig.setVisible(false);
    seen.push_back(shadowOnly());
    rig.setVisible(true);
    seen.push_back(shadowOnly());
    rig.remove(*light);
    seen.push_back(shadowOnly());
    rig.add(*light);
    seen.push_back(shadowOnly());
    light->setCastShadow(false);
    seen.push_back(shadowOnly());
    std::printf("shadow lights follow hierarchy: %zu %zu %zu %zu %zu %zu\n", seen[0], seen[1], seen[2], seen[3], seen[4],
                seen[5]);
    CHECK((seen == std::vector<std::size_t>{1, 0, 1, 0, 1, 0}));
}

// A scene's plain meshes find their records by scene order, so a sibling that leaves, joins or moves
// must not make the others rebuild theirs: a spawn or a despawn in a 4,096 mesh scene is not a hitch.
void recordsSurviveSiblings() {
    Scene scene; PerspectiveCamera camera; LightState lights; RenderDatabase database;
    database.batching = false;  // one record and one item per mesh
    camera.position.set(0, 0, 30);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    Group group;  // a child with children keeps the scene off the flat lane
    Object3D leaf;
    group.add(leaf);
    scene.add(group);
    const auto geometry = makeBoxGeometry();
    const auto material = std::make_shared<Material>(MaterialType::Standard);
    std::vector<std::shared_ptr<Mesh>> meshes;
    for (int i = 0; i < 12; ++i) {
        meshes.push_back(std::make_shared<Mesh>(geometry, material));
        meshes.back()->position.set(i - 6.0, 0, 0);
        scene.add(*meshes.back());
    }
    const auto drawn = [&] { return database.prepare(scene, camera, lights).size(); };
    CHECK(drawn() == 12);
    const uint64_t built = database.rebuilds();
    CHECK(built == 12);
    CHECK(drawn() == 12 && database.rebuilds() == built);
    scene.remove(*meshes[3]);  // every later mesh moves up one place in scene order
    CHECK(drawn() == 11 && database.rebuilds() == built);
    scene.add(*meshes[3]);  // it left the database, so it is built again, and only it
    CHECK(drawn() == 12 && database.rebuilds() == built + 1);
    scene.remove(*meshes[0]);
    group.add(*meshes[0]);  // deeper in the graph: the same record, found by the mesh
    CHECK(drawn() == 12 && database.rebuilds() == built + 1);
    group.remove(*meshes[0]);
    scene.add(*meshes[0]);
    for (int frame = 0; frame < 3; ++frame) CHECK(drawn() == 12 && database.rebuilds() == built + 1);
    meshes[5]->setVisible(false);  // hidden meshes keep their records and draw nothing
    CHECK(drawn() == 11 && database.rebuilds() == built + 1);
}

// PRD-610: a mesh under a group finds its record by object id, so a steady frame hashes it no more than a scene
// child; a mesh that leaves is swept and found again when it returns.
void nestedRecordCache() {
    for (const bool batching : {false, true}) {
        Scene scene; Group group; PerspectiveCamera camera; LightState lights; RenderDatabase database;
        database.batching = batching;
        camera.position.set(0, 0, 10);
        camera.lookAt(0, 0, 0);
        auto mesh = std::make_shared<Mesh>(makeBoxGeometry(), std::make_shared<Material>(MaterialType::Standard));
        scene.add(group); group.add(*mesh);
        const auto drawn = [&] { return database.prepare(scene, camera, lights).size(); };
        CHECK(drawn() == 1); CHECK(drawn() == 1);
        const uint64_t lookups = database.recordLookups(), sweeps = database.recordSweeps();
        for (int frame = 0; frame < 3; ++frame) CHECK(drawn() == 1);
        CHECK(database.recordLookups() == lookups);
        CHECK(database.recordSweeps() == sweeps);
        group.remove(*mesh);
        CHECK(drawn() == 0 && database.recordSweeps() == sweeps + 1);
        group.add(*mesh);
        CHECK(drawn() == 1);
        CHECK(drawn() == 1);
        const uint64_t settled = database.recordLookups();
        CHECK(drawn() == 1 && database.recordLookups() == settled);
    }
}

// PRD-610: a mesh outside every frustum keeps its record and builds nothing until it is back in view.
void frustumRecordRetention() {
    Scene scene; Group group; PerspectiveCamera camera; LightState lights; RenderDatabase database;
    database.batching = false;
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);
    auto material = std::make_shared<Material>(MaterialType::Standard);
    Mesh mesh(makeBoxGeometry(), material);
    scene.add(group); group.add(mesh);
    const auto drawn = [&] { return database.prepare(scene, camera, lights).size(); };
    CHECK(drawn() == 1);
    const uint64_t sweeps = database.recordSweeps(), rebuilt = database.rebuilds();
    mesh.position.z = 20;
    // The early-out postpones changed material work until the mesh is in view again.
    material->needsUpdate();
    for (int frame = 0; frame < 3; ++frame) CHECK(drawn() == 0);
    CHECK(database.recordSweeps() == sweeps);
    CHECK(database.rebuilds() == rebuilt);
    mesh.position.z = 0;
    CHECK(drawn() == 1 && database.rebuilds() == rebuilt + 1);
    CHECK(database.recordSweeps() == sweeps);
}

// The R5 render cut (PRD-573 v1.11): off the flat lane a steady frame finds every record by its scene slot and
// sweeps nothing, so a frame of 4,096 cubes hashes no object. A mesh that leaves costs one sweep.
void steadyFrameHashesNoRecord() {
    for (const bool batching : {false, true}) {
        Scene scene; PerspectiveCamera camera; LightState lights; RenderDatabase database;
        database.batching = batching;
        camera.position.set(0, 0, 30);
        camera.lookAt(0, 0, 0);
        camera.updateProjectionMatrix();
        Group group;  // a child with children keeps the scene off the flat lane
        Object3D leaf;
        group.add(leaf);
        scene.add(group);
        const auto geometry = makeBoxGeometry();
        const auto material = std::make_shared<Material>(MaterialType::Standard);
        std::vector<std::shared_ptr<Mesh>> meshes;
        for (int i = 0; i < 64; ++i) {
            meshes.push_back(std::make_shared<Mesh>(geometry, material));
            meshes.back()->position.set((i % 8) - 4.0, (i / 8) - 4.0, 0);
            scene.add(*meshes.back());
        }
        const auto frame = [&] { database.prepare(scene, camera, lights); };
        frame();
        frame();
        const uint64_t lookups = database.recordLookups(), sweeps = database.recordSweeps();
        for (int i = 0; i < 3; ++i) frame();
        CHECK(database.recordLookups() == lookups);
        CHECK(database.recordSweeps() == sweeps);
        scene.remove(*meshes[3]);
        frame();
        CHECK(database.recordSweeps() == sweeps + 1);
        frame();  // the slots refill once after the sweep
        const uint64_t settled = database.recordLookups();
        frame();
        CHECK(database.recordLookups() == settled && database.recordSweeps() == sweeps + 1);
    }
}

// The R5 render cut (PRD-573 v1.11): a frustum-culled mesh's world sphere is measured once per frame and serves
// both the camera and the shadow frustums.
void worldSphereMeasuredOnce() {
    Scene scene; PerspectiveCamera camera; LightState lights; RenderDatabase database;
    database.shadowMapEnabled = true;
    database.batching = false;
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);
    camera.near = 1; camera.far = 50;
    camera.updateProjectionMatrix();
    auto light = std::make_shared<DirectionalLight>(Color(1, 1, 1), 1.0);
    light->setCastShadow(true);
    light->position.set(0, 10, 0);
    light->target->position.set(0, 0, 0);
    auto& shadowCam = static_cast<OrthographicCamera&>(*light->shadow.camera);
    shadowCam.left = -8; shadowCam.right = 8;
    shadowCam.top = 8; shadowCam.bottom = -8;
    shadowCam.near = 1; shadowCam.far = 20;
    shadowCam.updateProjectionMatrix();
    scene.add(*light);
    const auto geometry = makeBoxGeometry();
    const auto material = std::make_shared<Material>(MaterialType::Standard);
    std::vector<std::shared_ptr<Mesh>> meshes;
    for (int i = 0; i < 4; ++i) {
        meshes.push_back(std::make_shared<Mesh>(geometry, material));
        meshes.back()->position.set(i - 1.5, 0, 0);
        meshes.back()->setCastShadow(true);
        scene.add(*meshes.back());
    }
    database.prepare(scene, camera, lights);  // warms the caches and the geometry bounds
    const uint64_t measured = database.sphereMeasures();
    const auto& items = database.prepare(scene, camera, lights);
    std::size_t drawn = 0;
    for (const auto& item : items) drawn += item.mainPass ? 1 : 0;
    CHECK(drawn == meshes.size());  // each mesh reaches the camera test, then the shadow test
    CHECK(database.sphereMeasures() - measured == meshes.size());
}

// PRD-610 AC-10: a water-like mirror over a grouped scene. Most boxes sit in the main view, a tower
// stands above the main frustum that only the mirrored camera sees, and a sun casts shadows. The
// reflector and its virtual camera are made by hand, as the `reflector` TSL call makes them.
struct ReflectionScene {
    Scene scene;
    PerspectiveCamera camera;
    std::shared_ptr<BufferGeometry> box = makeBoxGeometry(), plane = makePlaneGeometry(400, 400);
    std::vector<std::shared_ptr<Material>> materials;
    std::vector<std::shared_ptr<Mesh>> meshes;
    std::shared_ptr<Material> water = std::make_shared<Material>(MaterialType::Standard);
    std::shared_ptr<Mesh> waterMesh, tower;
    std::shared_ptr<Reflector> reflector = std::make_shared<Reflector>();
    std::shared_ptr<DirectionalLight> sun = std::make_shared<DirectionalLight>(Color(1, 1, 1), 2.0);
    std::shared_ptr<Object3D> target = std::make_shared<Object3D>();
    explicit ReflectionScene(int groupCount = 12, int perGroup = 20, int uniqueDraws = 12) {
        camera.fov = 50;
        camera.aspect = 4.0 / 3;
        camera.near = 0.5;
        camera.far = 400;
        camera.position.set(0, 6, 14);
        camera.lookAt(0, 0, -10);
        camera.updateProjectionMatrix();
        for (int m = 0; m < 6; ++m) {
            materials.push_back(std::make_shared<Material>(MaterialType::Standard));
            materials.back()->color.setRGB(0.2 + 0.12 * m, 0.5, 0.9 - 0.12 * m);
        }
        for (int g = 0; g < groupCount; ++g) {
            auto group = std::make_shared<Group>();
            group->position.set((g % 12 - 6) * 12.0, 0, -(g / 12) * 14.0 + 4);
            scene.add(*group);
            for (int i = 0; i < perGroup; ++i) {
                auto mesh = std::make_shared<Mesh>(box, materials[(g + i) % materials.size()]);
                mesh->position.set((i % 8) * 1.4 - 5, 0.6 + 0.2 * (i / 8), (i / 8) * 1.4 - 3);
                mesh->setCastShadow(true);
                mesh->setReceiveShadow(true);
                group->add(*mesh);
                meshes.push_back(mesh);
            }
        }
        // Single-member draws: each has its own geometry, so nothing batches (a game's props and hulls).
        for (int i = 0; i < uniqueDraws; ++i) {
            auto mesh = std::make_shared<Mesh>(makeBoxGeometry(1 + 0.01 * i, 1, 1), materials[i % materials.size()]);
            mesh->position.set((i % 20) * 2.0 - 20, 1.5, -(i / 20) * 3.0 - 2);
            mesh->setCastShadow(true);
            mesh->setReceiveShadow(true);
            scene.add(*mesh);
            meshes.push_back(mesh);
        }
        tower = std::make_shared<Mesh>(makeBoxGeometry(1, 1, 1.5), materials[0]);  // its own draw, never batched
        tower->position.set(0, 30, -50);
        tower->scale.set(8, 8, 8);
        scene.add(*tower);
        water->color.setRGB(0.1, 0.3, 0.5);
        waterMesh = std::make_shared<Mesh>(plane, water);
        waterMesh->rotateX(-3.141592653589793 / 2);
        scene.add(*waterMesh);
        target->rotateX(-3.141592653589793 / 2);
        scene.add(*target);
        reflector->target = target;
        reflector->camera = std::make_shared<PerspectiveCamera>();
        namespace g = shader::graph;
        const auto mirror = g::reflectorTexture(reflector, g::vec2({g::sub(g::float_(1), g::swizzle(g::screenUV(), "x")),
                                                                    g::swizzle(g::screenUV(), "y")}));
        water->nodes.colorNode = g::vec4({g::mul(g::swizzle(mirror, "xyz"), g::vec3({g::float_(0.75), g::float_(0.85), g::float_(1)})),
                                          g::float_(1)});
        water->needsUpdate();
        sun->setCastShadow(true);
        sun->position.set(30, 60, 20);
        auto& sc = static_cast<OrthographicCamera&>(*sun->shadow.camera);
        sc.left = -120; sc.right = 120; sc.top = 120; sc.bottom = -120; sc.near = 1; sc.far = 300;
        sc.updateProjectionMatrix();
        scene.add(*sun);
        scene.updateMatrixWorld(true);
    }
};

// What a pass drew, comparable across databases: one row per item, sorted.
std::vector<std::array<double, 8>> drawRows(const std::vector<DrawItem>& items) {
    std::vector<std::array<double, 8>> rows;
    for (const DrawItem& item : items) {
        const auto& at = item.sortOrigin ? *item.sortOrigin : std::array<double, 3>{item.matrixWorld[12], item.matrixWorld[13], item.matrixWorld[14]};
        rows.push_back({double(item.mainPass), double(item.castShadow), double(item.instanceCount), double(item.kind), at[0], at[1], at[2], double(item.layers)});
    }
    std::sort(rows.begin(), rows.end());
    return rows;
}

// PRD-610 AC-10: a reflection pass reuses the frame's work. It walks no matrices of its own (the
// frame's walk is current), keeps the draws it always had, including ones outside the main view
// that only the mirrored camera sees, and renders the same pixels.
void reflectionReuse() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(160, 120);
    ReflectionScene s;
    auto& diagnostic = Material::diagnostics();
    const auto savedDiagnostic = diagnostic;
    diagnostic = {}; diagnostic.enabled = true;
    s.tower->setCastShadow(false);
    const auto tower = std::array<double, 3>{0, 30, -50};
    const auto drawsTower = [&](const RenderDatabase& database) {
        for (const DrawItem& item : database.drawn())
            if (item.mainPass && item.matrixWorld[12] == tower[0] && item.matrixWorld[13] == tower[1] && item.matrixWorld[14] == tower[2]) return true;
        return false;
    };
    constexpr int frames = 6;
    for (const bool reuse : {false, true}) {
        diagnostic = {}; diagnostic.enabled = true;
        RenderDatabase database;
        database.shadowMapEnabled = true;
        if (!reuse) database.reuseMainFrame = false;  // on is the default
        for (int i = 0; i < frames; ++i) database.render(renderer, s.scene, s.camera);
        const RenderDatabase* pass = database.reflectionDatabase(s.reflector.get());
        CHECK(pass != nullptr);
        if (!pass) continue;
        CHECK(diagnostic.recordRebuilds == database.rebuilds() + pass->rebuilds());
        CHECK(diagnostic.graphRebuilds > 0);
        CHECK(!diagnostic.threadCpuSupported || diagnostic.graphCpuNs > 0);
        std::printf("reuse=%d: matrix walks main %llu, reflection %llu over %d frames\n", reuse,
                    (unsigned long long)database.matrixWalks(), (unsigned long long)pass->matrixWalks(), frames);
        CHECK(database.matrixWalks() == frames);
        CHECK(pass->matrixWalks() == (reuse ? 0u : frames));
        CHECK(!drawsTower(database) && drawsTower(*pass));  // only the mirrored view sees the tower
        // The pass draws what an independent database prepares for the posed mirror camera.
        RenderDatabase alone;
        alone.shadowMapEnabled = true;
        s.water->visible = false;
        LightState lights;
        alone.prepare(s.scene, *s.reflector->camera, lights);
        s.water->visible = true;
        CHECK(drawRows(alone.drawn()) == drawRows(pass->drawn()));
        CHECK(!pass->drawn().empty());
    }
    // The same frame, pixel for pixel, with and without reuse.
    std::vector<uint8_t> frame[2];
    for (const bool reuse : {false, true}) {
        RenderDatabase database;
        database.shadowMapEnabled = true;
        if (!reuse) database.reuseMainFrame = false;  // on is the default
        for (int i = 0; i < 4; ++i) database.render(renderer, s.scene, s.camera, {0.1, 0.1, 0.15, 1});
        frame[reuse] = read(renderer, events);
    }
    CHECK(frame[0].size() == 160 * 120 * 4 && frame[0] == frame[1]);
    // A mirror on its own layer (WaterSurface3D's layered mirror) sees the hulls and not the sun, so no
    // shadow it could draw has a caster; without the reuse its pass still gathers every one.
    {
        ReflectionScene layered;
        layered.reflector->camera->setLayerMask(2);
        layered.tower->enableLayer(1);
        for (std::size_t i = 0; i < layered.meshes.size(); i += 7) layered.meshes[i]->enableLayer(1);
        std::vector<uint8_t> shot[2];
        for (const bool reuse : {false, true}) {
            RenderDatabase database;
            database.shadowMapEnabled = true;
            if (!reuse) database.reuseMainFrame = false;  // on is the default
            for (int i = 0; i < 4; ++i) database.render(renderer, layered.scene, layered.camera, {0.1, 0.1, 0.15, 1});
            shot[reuse] = read(renderer, events);
            const RenderDatabase* pass = database.reflectionDatabase(layered.reflector.get());
            CHECK(pass != nullptr);
            if (!pass) continue;
            std::size_t casters = 0, drawnInMirror = 0;
            for (const DrawItem& item : pass->drawn()) casters += item.castShadow, drawnInMirror += item.mainPass;
            std::printf("reuse=%d: mirror pass %zu draws, %zu casters\n", reuse, drawnInMirror, casters);
            CHECK(drawnInMirror > 0);
            CHECK(reuse ? casters == 0 : casters > 0);
        }
        CHECK(shot[0].size() == 160 * 120 * 4 && shot[0] == shot[1]);
    }
    // A render hook may move things after the frame's walk: the pass walks again and sees them.
    RenderDatabase hooked;
    hooked.shadowMapEnabled = true;
    s.meshes.back()->onBeforeRender = std::make_shared<const std::function<bool(const RenderCallbackArgs&, std::string&)>>(
        [&](const RenderCallbackArgs&, std::string&) {
            s.tower->position.x += 1;
            return true;
        });
    for (int i = 0; i < 3; ++i) hooked.render(renderer, s.scene, s.camera);
    const RenderDatabase* pass = hooked.reflectionDatabase(s.reflector.get());
    CHECK(pass && pass->matrixWalks() == 3);
    // Per frame the hook runs in the main prepare, then again in the pass's: the pass drew the first move.
    bool moved = false;
    for (const DrawItem& item : pass->drawn()) moved = moved || (item.mainPass && item.matrixWorld[12] == s.tower->position.x - 1 && item.matrixWorld[14] == -50);
    CHECK(moved);
    diagnostic = savedDiagnostic;
}

void gpuJointProduction() {
    const auto* drawUseFlag = std::getenv("TN_GPU_JOINT_DRAW_USE");
    const bool drawUse = drawUseFlag && std::strcmp(drawUseFlag, "1") == 0;
    const Vector3 directions[6] = {{-1,0,0}, {1,0,0}, {0,1,0}, {0,-1,0}, {0,0,1}, {0,0,-1}};
    const Vector3 ups[6] = {{0,-1,0}, {0,-1,0}, {0,0,1}, {0,0,-1}, {0,-1,0}, {0,-1,0}};
    for (int face = 0; face < 6; ++face) {
        PerspectiveCamera camera(-90, 1, 1, 10);
        camera.up = ups[face]; camera.lookAt(directions[face]); camera.updateMatrixWorld();
        Matrix4 rotation; rotation.lookAt(Vector3{}, directions[face], ups[face]);
        for (int k = 0; k < 16; ++k) CHECK(std::abs(rotation.elements[k] - camera.matrixWorld.elements[k]) < 1e-12);
    }
    // Count executed updates, including a query's full parent chain, independently of walk returns.
    auto countRoot = std::make_shared<Object3D>();
    auto countMiddle = std::make_shared<Object3D>();
    auto countLeaf = std::make_shared<Object3D>();
    countRoot->add(*countMiddle); countMiddle->add(*countLeaf);
    const auto countBefore = Object3D::matrixEvaluations();
    CHECK(countRoot->updateMatrixWorldVisible(false, false) == 3);
    Vector3 queried; countLeaf->getWorldPosition(queried);
    CHECK(Object3D::matrixEvaluations() - countBefore == 6);

    struct Fixture {
        Scene scene;
        Scene unrelatedCompileScene;
        unsigned compileCallbacks = 0;
        PerspectiveCamera camera;
        std::vector<std::shared_ptr<Group>> movers;
        std::vector<std::shared_ptr<SkinnedMesh>> meshes;
        std::vector<std::shared_ptr<Bone>> tips;
        double* escapedWorld = nullptr;
        double* escapedAutoWorld = nullptr;
        double* escapedLocal = nullptr;
        std::shared_ptr<Reflector> reflector = std::make_shared<Reflector>();
        Fixture(bool tracked) {
            camera.aspect = 4.0 / 3; camera.position.set(0, 0, 8); camera.updateProjectionMatrix();
            if (tracked) scene.enableTrackedTransform();
            auto geometry = makeBoxGeometry(0.7, 0.7, 0.7);
            const auto vertices = geometry->attributes.at("position")->count();
            std::vector<double> indices(vertices * 4, 0), weights(vertices * 4, 0);
            for (size_t i = 0; i < vertices; ++i) { indices[i * 4] = 2; weights[i * 4] = 1; }
            geometry->setAttribute("skinIndex", BufferAttribute::fromDoubles(Scalar::U16, indices, 4));
            geometry->setAttribute("skinWeight", BufferAttribute::fromFloats(weights, 4));
            auto material = std::make_shared<Material>(MaterialType::Basic);
            material->color.setRGB(0.8, 0.2, 0.1);
            auto unrelated = std::make_shared<Mesh>(makeBoxGeometry(), material);
            unrelated->onBeforeRender = std::make_shared<const std::function<bool(const RenderCallbackArgs&, std::string&)>>(
                [this](const RenderCallbackArgs&, std::string&) { ++compileCallbacks; return true; });
            unrelatedCompileScene.add(*unrelated);
            auto sun = std::make_shared<DirectionalLight>();
            sun->position.set(2, 5, 4); sun->setCastShadow(true);
            sun->shadow.mapSize.set(128, 128);
            scene.add(*sun);
            for (int i = 0; i < 6; ++i) {
                const int count = i == 4 ? 1100 : 3;
                auto mover = std::make_shared<Group>(); mover->position.x = double(i - 2) * 1.2;
                auto placement = std::make_shared<Group>();
                auto mesh = std::make_shared<SkinnedMesh>(geometry, material);
                mesh->setCastShadow(true); mesh->setReceiveShadow(true);
                std::vector<std::shared_ptr<Bone>> bones;
                for (int j = 0; j < count; ++j) {
                    auto bone = std::make_shared<Bone>();
                    if (tracked) bone->enableTrackedTransform();
                    if (j) bones.back()->add(*bone);
                    bones.push_back(bone);
                }
                bones[2]->rotation.z = i * 0.12;
                bones[1]->position.y = 0.15; bones[2]->position.y = -0.15;
                placement->add(*bones.front()); placement->add(*mesh);
                mover->add(*placement); scene.add(*mover);
                if (tracked) { mover->enableTrackedTransform(); placement->enableTrackedTransform(); mesh->enableTrackedTransform(); }
                if (i == 0) {
                    mover->updateMatrix(); mover->matrixAutoUpdate = false;
                    escapedLocal = mover->matrix.elements.data();
                    CHECK(Object3D::leaseTransform(&mover->matrixWorld) == 5);
                    escapedAutoWorld = mover->matrixWorld.elements.data();
                    escapedAutoWorld[12] = 100;
                }
                if (i == 5) {
                    CHECK(Object3D::leaseTransform(&mover->matrixWorld) == 5);
                    escapedWorld = mover->matrixWorld.elements.data();
                    escapedWorld[12] = mover->position.x;
                    mover->matrixWorldAutoUpdate = false;
                }
                auto skeleton = std::make_shared<Skeleton>(bones, std::vector<Matrix4>(bones.size()));
                Matrix4 bind; mesh->bind(skeleton, &bind);
                if (i == 1 || i == 4) {
                    // A non-skinned attachment makes these rigs eager; no synthetic static hints.
                    auto attachment = std::make_shared<Mesh>(makeBoxGeometry(0.1, 0.1, 0.1), material);
                    bones.back()->add(*attachment);
                }
                if (i == 4) mover->setVisible(false);
                movers.push_back(mover); meshes.push_back(mesh); tips.push_back(bones[2]);
            }
            auto water = std::make_shared<Material>(MaterialType::Standard);
            auto plane = std::make_shared<Mesh>(makePlaneGeometry(12, 12), water);
            plane->position.y = -1; plane->rotateX(-3.141592653589793 / 2); scene.add(*plane);
            reflector->target = std::make_shared<Object3D>();
            reflector->target->position.y = -1;
            reflector->target->rotateX(-3.141592653589793 / 2); scene.add(*reflector->target);
            reflector->camera = std::make_shared<PerspectiveCamera>();
            namespace g = shader::graph;
            water->nodes.colorNode = g::reflectorTexture(reflector, g::screenUV());
            water->needsUpdate();
            auto sky = std::make_shared<DataTexture>();
            sky->mapping = 303; sky->width = 8; sky->height = 4;
            sky->data.resize(8 * 4 * 4, 1); sky->needsUpdate(); // keep the sky below the rig coverage threshold
            scene.backgroundTexture = sky;
        }
        ~Fixture() {
            Object3D::unleaseTransform(&movers[0]->matrixWorld);
            Object3D::unleaseTransform(&movers[5]->matrixWorld);
        }
    } accelerated(true), eager(false);
    mystral::webgpu::Context context; CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer gpu(context.getInstance(), context.getDevice(), context.getQueue(), events);
    Renderer cpu(context.getInstance(), context.getDevice(), context.getQueue(), events);
    gpu.setSize(160, 120); cpu.setSize(160, 120);
    RenderDatabase database, reference; reference.batching = false;
    database.shadowMapEnabled = reference.shadowMapEnabled = true;
    std::shared_ptr<GpuJointScene> admittedPlan;
    for (int frame = 0; frame < 4; ++frame) {
        if (frame) {
            for (auto* fixture : {&accelerated, &eager}) {
                animation::PropertyBinding position(fixture->tips[0], ".position");
                const double p[3] = {0.3, -0.15, 0}; position.setValue(p, 0);
                animation::PropertyBinding orientation(fixture->tips[0], ".quaternion");
                const double q[4] = {0, 0, std::sin(0.25), std::cos(0.25)}; orientation.setValue(q, 0);
                fixture->movers[0]->position.y = 0.5;
                fixture->movers[0]->position.z = -frame * 0.2;
                fixture->escapedLocal[13] = 0.5;
                fixture->escapedLocal[14] = -frame * 0.2;
                fixture->escapedAutoWorld[12] = 100; // auto-world ownership repairs the raw alias
                fixture->movers[2]->position.z = frame * 0.2;
                fixture->meshes[3]->setLayer(frame == 3 ? 0 : 1);
                fixture->camera.enableLayer(1);
                fixture->movers[0]->setVisible(frame != 2);
                fixture->meshes[0]->parent->position.x = 0.2;
                fixture->meshes[0]->parent->rotateY(0.15); // placement can move after admission
                fixture->movers[4]->setVisible(true); // grows mixed GPU+CPU palette beyond 64 KiB
                fixture->escapedWorld[13] = frame * 0.1;
                fixture->movers[5]->matrixWorldNeedsUpdate = true;
            }
            CHECK(accelerated.tips[0]->hasDeferredTransform());
            const auto before = Object3D::matrixEvaluations();
            const auto visits = accelerated.scene.updateMatrixWorldVisible(false, false);
            CHECK(Object3D::matrixEvaluations() - before + 3 == visits); // the unpruned walk inspects all three GPU boundaries
            CHECK(accelerated.tips[0]->hasDeferredTransform());
        }
        if (frame == 2) {
            database.shadowMapEnabled = reference.shadowMapEnabled = false;
            for (auto* fixture : {&accelerated, &eager}) fixture->scene.add(*std::make_shared<Group>());
        }
        if (frame == 1) {
            RenderDatabase compilation; compilation.shadowMapEnabled = database.shadowMapEnabled;
            const auto pending = compilation.compileAsync(gpu, accelerated.scene, accelerated.camera);
            CHECK(!pending.empty());
            CHECK(admittedPlan && *admittedPlan->valid); // async warm-up must retain the live GPU palette owner
            compilation.compileAsync(gpu, accelerated.unrelatedCompileScene, accelerated.camera);
            CHECK(accelerated.compileCallbacks == 1);
            CHECK(admittedPlan && *admittedPlan->valid); // unrelated compile callbacks do not own the live GPU plan
        }
        const auto projectionBefore = Object3D::gpuProjectionVisits_;
        const auto maintenanceBefore = Object3D::gpuMaintenanceVisits_;
        const auto hierarchyBefore = Object3D::hierarchyVersion();
        database.render(gpu, accelerated.scene, accelerated.camera, {0, 0, 0, 1});
        CHECK(Object3D::hierarchyVersion() == hierarchyBefore); // cold sky conversion owns no scene nodes
        CHECK(Object3D::gpuProjectionVisits_ - projectionBefore >= (frame == 2 ? 4 : 6)); // visible main/reflection boundaries, plus verdict scans
        if (!frame || frame == 2) CHECK(Object3D::gpuMaintenanceVisits_ > maintenanceBefore);
        else CHECK(Object3D::gpuMaintenanceVisits_ == maintenanceBefore); // no per-frame Bone scan
        eager.scene.updateMatrixWorld(true); // independent eager composition repairs every raw auto-world alias
        reference.render(cpu, eager.scene, eager.camera, {0, 0, 0, 1});
        CHECK(!accelerated.tips[5]->hasDeferredTransform() && !accelerated.tips[5]->skipsGpuJointSubtree());
        CHECK(accelerated.movers[5]->ownTransformTracking()[2] == 1);
        Vector3 escapedActual, escapedExpected;
        accelerated.tips[5]->getWorldPosition(escapedActual);
        eager.tips[5]->getWorldPosition(escapedExpected);
        CHECK(escapedActual.distanceTo(escapedExpected) < 1e-10);
        CHECK(std::abs(escapedActual.y - frame * 0.1) < 1e-10);
        const auto actual = read(gpu, events), expected = read(cpu, events);
        CHECK(actual.size() == 160 * 120 * 4 && expected.size() == actual.size());
        size_t different = 0, covered = 0;
        for (size_t i = 0; i + 3 < actual.size() && actual.size() == expected.size(); i += 4) {
            int delta = 0; for (int k = 0; k < 3; ++k) delta = std::max(delta, std::abs(int(actual[i + k]) - int(expected[i + k])));
            different += delta > 2; covered += actual[i] > 20;
        }
        std::printf("production GPU joints frame %d: %zu covered, %zu pixels differ >2\n", frame, covered, different);
        CHECK(covered > 100 && different <= 4);
        size_t admitted = 0, instances = 0;
        for (const auto& draw : database.drawn()) if (draw.gpuJoints) { ++admitted; instances += draw.instanceCount; admittedPlan = draw.gpuJoints; }
        CHECK(admitted == (frame == 1 || frame == 2 ? 2 : 1));
        CHECK(instances == (frame == 2 ? 2 : 3));
        CHECK(gpu.lastFrame().mainSkinned.batches == admitted);
        if (frame < 2) CHECK(gpu.lastFrame().shadowSkinned.batches == admitted);
        const auto validationBefore = Object3D::gpuValidationVisits_;
        CHECK(admittedPlan != nullptr);
        if (!admittedPlan) return;
        CHECK(admittedPlan->drawUse.size() == (drawUse ? 3 : 0));
        if (drawUse) CHECK(std::count(admittedPlan->drawUse.begin(), admittedPlan->drawUse.end(), uint8_t{1}) == (frame == 2 ? 2 : 3));
        CHECK(admittedPlan->current());
        CHECK(Object3D::gpuValidationVisits_ - validationBefore == 18); // three rigs, placement and four ancestors each
        accelerated.scene.matrixWorldAutoUpdate = false;
        CHECK(admittedPlan->current()); // unescaped manual-world Scene remains eligible
        accelerated.scene.matrixWorldAutoUpdate = true;
        CHECK(accelerated.movers[0]->ownTransformTracking()[2] == 1);
        CHECK(accelerated.movers[0]->matrixWorld.elements[12] == accelerated.movers[0]->position.x);
        accelerated.movers[0]->matrixWorldAutoUpdate = false;
        CHECK(!admittedPlan->current());
        accelerated.movers[0]->matrixWorldAutoUpdate = true;
        accelerated.movers[0]->matrixAutoUpdate = false;
        CHECK(admittedPlan->current());
        accelerated.movers[0]->matrixAutoUpdate = true;
        CHECK(admittedPlan->current());
        accelerated.movers[0]->matrixAutoUpdate = false;
        accelerated.movers[0]->onBeforeRender = std::make_shared<const std::function<bool(const RenderCallbackArgs&, std::string&)>>(
            [](const RenderCallbackArgs&, std::string&) { return true; });
        CHECK(!admittedPlan->current());
        accelerated.movers[0]->onBeforeRender.reset();
        CHECK(admittedPlan->current());
        if (frame == 0) {
            CHECK(Object3D::leaseTransform(&accelerated.movers[2]->matrixWorld) == 5);
            CHECK(admittedPlan->current()); // escape of another auto ancestor after admission is safe
            Object3D::unleaseTransform(&accelerated.movers[2]->matrixWorld);
        }
        auto* placement = accelerated.meshes[0]->parent;
        const auto placed = placement->matrixWorld;
        placement->matrixWorld.elements[0] = 2;
        CHECK(!admittedPlan->current()); // non-similarity remains refused
        placement->matrixWorld.copy(placed);
        const auto* reflection = database.reflectionDatabase(accelerated.reflector.get());
        CHECK(reflection != nullptr);
        size_t mirrorGpu = 0, mirrorInstances = 0;
        if (reflection) for (const auto& draw : reflection->drawn()) if (draw.gpuJoints) {
            ++mirrorGpu; mirrorInstances += draw.instanceCount;
        }
        CHECK(mirrorGpu == (frame == 1 ? 2 : 1));
        CHECK(mirrorInstances == (frame == 2 ? 1 : 3));
        std::printf("GPU batching frame %d: main %zu draws/%zu instances, reflection %zu draws/%zu instances, shadow %u batches\n",
                    frame, admitted, instances, mirrorGpu, mirrorInstances, gpu.lastFrame().shadowSkinned.batches);
        CHECK(accelerated.tips[0]->skipsGpuJointSubtree());
    }
    if (drawUse) {
        std::vector<std::unique_ptr<animation::AnimationMixer>> observers;
        if (animation::AnimationMixer::poseObservation.enabled) {
            auto clip = std::make_shared<animation::AnimationClip>("observe", 1, std::vector<animation::KeyframeTrack>{
                animation::KeyframeTrack(".scale", animation::TrackType::Vector, {0, 1}, {1, 1, 1, 1, 1, 1})});
            for (const auto i : {0, 2, 3}) {
                auto mixer = std::make_unique<animation::AnimationMixer>(accelerated.tips[i]);
                mixer->clipAction(clip)->play(); observers.push_back(std::move(mixer));
            }
        }
        const auto renderObserved = [&](uint64_t drawn) {
            for (const auto& mixer : observers) mixer->update(0);
            const auto before = animation::AnimationMixer::poseObservation;
            database.render(gpu, accelerated.scene, accelerated.camera);
            for (const auto& mixer : observers) mixer->update(0);
            if (!observers.empty()) {
                const auto& after = animation::AnimationMixer::poseObservation;
                CHECK(after.intervals - before.intervals == 3 && after.tracks - before.tracks == 3);
                CHECK(after.drawnTracks - before.drawnTracks == drawn);
                CHECK(after.unusedTracks - before.unusedTracks == 3 - drawn);
            }
        };
        for (const auto& mover : accelerated.movers) mover->setVisible(false);
        renderObserved(0);
        CHECK(admittedPlan->drawUse == std::vector<uint8_t>(3, 0)); // Reset removes last frame's use.
        accelerated.movers[0]->setVisible(true);
        accelerated.meshes[0]->setLayer(1);
        accelerated.camera.disableLayer(1);
        accelerated.reflector->camera->enableLayer(1);
        renderObserved(1);
        CHECK(gpu.lastFrame().mainSkinned.batches == 0);
        CHECK(std::count(admittedPlan->drawUse.begin(), admittedPlan->drawUse.end(), uint8_t{1}) == 1); // Reflection only.
        accelerated.reflector->camera->disableLayer(1);
        database.shadowMapEnabled = true;
        for (auto* child : accelerated.scene.children) if (auto* sun = dynamic_cast<DirectionalLight*>(child)) sun->shadow.camera->enableLayer(1);
        for (int repeat = 0; repeat < 2; ++repeat) {
            renderObserved(1);
            CHECK(gpu.lastFrame().mainSkinned.batches == 0);
            CHECK(gpu.lastFrame().shadowSkinned.batches > 0);
            CHECK(std::count(admittedPlan->drawUse.begin(), admittedPlan->drawUse.end(), uint8_t{1}) == 1); // Shadow only, including steady replay.
        }
        accelerated.meshes[0]->setLayer(0);
        database.shadowMapEnabled = false;
        for (int repeat = 0; repeat < 2; ++repeat) {
            renderObserved(1);
            CHECK(gpu.lastFrame().mainSkinned.batches == 1);
            CHECK(std::count(admittedPlan->drawUse.begin(), admittedPlan->drawUse.end(), uint8_t{1}) == 1); // Main bundle reuse.
        }
        for (const auto& mover : accelerated.movers) mover->setVisible(true);
    }
    const auto joins = Object3D::joinDependencyVisits(), updates = Object3D::matrixEvaluations();
    accelerated.tips[0]->materializeWorldTransformIfPending();
    CHECK(Object3D::joinDependencyVisits() - joins == 6);
    CHECK(Object3D::matrixEvaluations() - updates == 6);
    animation::PropertyBinding finalPosition(accelerated.tips[0], ".position");
    const double finalPose[3] = {0.7, -0.15, 0}; finalPosition.setValue(finalPose, 0);
    animation::PropertyBinding eagerPosition(eager.tips[0], ".position");
    eagerPosition.setValue(finalPose, 0);
    eager.scene.updateMatrixWorld(true); // independent eager expected worlds, never the accelerated scene
    CHECK(accelerated.tips[0]->hasDeferredTransform());
    const auto revokeBefore = Object3D::gpuMaintenanceVisits_;
    admittedPlan->revoke(); // revoke the last admitted rig while its local pose is still pending
    CHECK(Object3D::gpuMaintenanceVisits_ - revokeBefore == 9);
    CHECK(!accelerated.tips[0]->skipsGpuJointSubtree());
    CHECK(!accelerated.tips[0]->hasDeferredTransform());
    accelerated.meshes[0]->skeleton->calculateInverses(); // first reader after full revocation
    eager.meshes[0]->skeleton->calculateInverses();
    for (size_t bone = 0; bone < 3; ++bone) for (int k = 0; k < 16; ++k) {
        CHECK(std::abs(accelerated.meshes[0]->skeleton->bone(bone)->matrixWorld.elements[k] -
                       eager.meshes[0]->skeleton->bone(bone)->matrixWorld.elements[k]) < 1e-10);
        CHECK(std::abs(accelerated.meshes[0]->skeleton->boneInverses[bone].elements[k] -
                       eager.meshes[0]->skeleton->boneInverses[bone].elements[k]) < 1e-10);
    }
    const double postRevokePose[3] = {0.9, -0.15, 0};
    finalPosition.setValue(postRevokePose, 0); eagerPosition.setValue(postRevokePose, 0);
    eager.scene.updateMatrixWorld(true);
    Vector3 actualVertex, expectedVertex;
    accelerated.meshes[0]->getVertexPosition(0, actualVertex); // immediate CPU skinning must join stale worlds
    eager.meshes[0]->getVertexPosition(0, expectedVertex);
    CHECK(std::abs(actualVertex.x - expectedVertex.x) < 1e-10);
    CHECK(std::abs(actualVertex.y - expectedVertex.y) < 1e-10);
    CHECK(std::abs(actualVertex.z - expectedVertex.z) < 1e-10);
    accelerated.meshes[0]->skeleton->update(); eager.meshes[0]->skeleton->update();
    for (size_t i = 0; i < 48; ++i)
        CHECK(std::abs(accelerated.meshes[0]->skeleton->boneMatrices[i] - eager.meshes[0]->skeleton->boneMatrices[i]) < 1e-6);
    accelerated.meshes[0]->exposeGpuBind();
    const auto eagerRenderJoins = Object3D::joinDependencyVisits();
    database.render(gpu, accelerated.scene, accelerated.camera);
    CHECK(Object3D::joinDependencyVisits() == eagerRenderJoins); // a completed eager walk already joined these palettes
    for (const auto& draw : database.drawn()) CHECK(!draw.gpuJoints);
    CHECK(!accelerated.tips[0]->hasDeferredTransform());
    for (size_t rig = 0; rig < accelerated.meshes.size(); ++rig) {
        eager.meshes[rig]->skeleton->update();
        const auto& actual = accelerated.meshes[rig]->skeleton->boneMatrices;
        const auto& expected = eager.meshes[rig]->skeleton->boneMatrices;
        CHECK(actual.size() == expected.size());
        for (size_t i = 0; i < actual.size(); ++i) CHECK(std::abs(actual[i] - expected[i]) < 1e-6);
    }
    auto external = std::make_shared<Bone>(); external->enableTrackedTransform();
    Skeleton externalSkeleton({external}, {Matrix4{}});
    CHECK(external->enableDeferredTransform());
    const double externalPose[3] = {2, 0, 0};
    CHECK(external->deferTransformValue(0, externalPose));
    const auto firstEvaluation = Object3D::matrixEvaluations() + 1;
    accelerated.scene.updateMatrixWorld(true); // the external bone is deliberately outside this walk
    const auto externalJoins = Object3D::joinDependencyVisits();
    externalSkeleton.updateAfterWorldWalk(firstEvaluation);
    CHECK(Object3D::joinDependencyVisits() == externalJoins + 1);
    CHECK(std::abs(externalSkeleton.boneMatrices[12] - 2) < 1e-6);

    struct CustomGroup : Group {};
    for (int variant = 0; variant < 12; ++variant) {
        Fixture fixture(true);
        std::shared_ptr<Object3D> ancestor;
        if (variant == 0) ancestor = std::make_shared<Object3D>();
        else if (variant == 1) ancestor = std::make_shared<Mesh>();
        else if (variant == 3) ancestor = std::make_shared<CustomGroup>();
        else if (variant == 11) ancestor = std::make_shared<Bone>();
        else ancestor = std::make_shared<Group>();
        ancestor->enableTrackedTransform();
        CHECK(Object3D::leaseTransform(&ancestor->matrixWorld) == 5);
        ancestor->add(*fixture.movers[0]); fixture.scene.add(*ancestor);
        if (variant == 4) ancestor->matrixWorldAutoUpdate = false;
        if (variant == 5) ancestor->matrixAutoUpdate = false;
        if (variant == 6) ancestor->onBeforeRender = std::make_shared<const std::function<bool(const RenderCallbackArgs&, std::string&)>>(
            [](const RenderCallbackArgs&, std::string&) { return true; });
        if (variant == 7) ancestor->scale.y = 2;
        Object3D* strict = variant == 8 ? fixture.meshes[0]->parent : variant == 9 ? fixture.meshes[0].get() :
            variant == 10 ? static_cast<Object3D*>(&fixture.scene) : nullptr;
        if (strict) CHECK(Object3D::leaseTransform(&strict->matrixWorld) == 5);
        fixture.scene.updateMatrixWorld(true);
        const auto plan = gpu.prepareGpuJoints(fixture.scene);
        CHECK(bool(plan && plan->byMesh.count(fixture.meshes[0].get())) == (variant < 3 || variant == 5));
        CHECK(!plan || !plan->byMesh.count(fixture.meshes[1].get())); // attachment outside Bone set remains eager
        if (plan && (variant < 3 || variant == 5)) {
            CHECK(plan->current());
            fixture.scene.add(*fixture.movers[0]);
            CHECK(!plan->current()); // live reparent invalidates before a skipped Bone walk
        }
        if (strict) Object3D::unleaseTransform(&strict->matrixWorld);
        Object3D::unleaseTransform(&ancestor->matrixWorld);
    }
}

// A virtual shadow keeps each caster's own key and bounds for mover detection and per-page culls,
// but that is a shadow-page need: colour-only casters still draw as one main-pass batch (stress lab:
// 600 props went from 61 to 621 main draws when VirtualShadowNode was installed).
void virtualShadowCastersBatchInMainPass() {
    Scene scene; PerspectiveCamera camera; LightState lights; RenderDatabase database;
    database.shadowMapEnabled = true;
    camera.position.set(4, 20, 30);
    camera.lookAt(4, 0, 4);
    const auto geometry = makeBoxGeometry();
    std::vector<std::shared_ptr<Mesh>> meshes;
    for (int i = 0; i < 64; ++i) {
        auto material = std::make_shared<Material>(MaterialType::Standard);
        material->color.setRGB(double(i) / 64, 0.4, 0.2);
        auto mesh = std::make_shared<Mesh>(geometry, material);
        mesh->position.set(i % 8, 0, i / 8);
        mesh->setCastShadow(true);
        scene.add(*mesh); meshes.push_back(mesh);
    }
    for (int frame = 0; frame < 2; ++frame) {
        const auto& items = database.prepare(scene, camera, lights, nullptr, /*virtualShadows=*/true);
        std::size_t mainDraws = 0, mainInstances = 0, shadowOnly = 0;
        for (const DrawItem& item : items) {
            if (item.mainPass) { ++mainDraws; mainInstances += item.instanceCount; CHECK(!item.castShadow); }
            if (item.castShadow) { CHECK(!item.mainPass && item.instanceCount <= 1); ++shadowOnly; }
        }
        CHECK(mainDraws == 1 && mainInstances == 64);
        CHECK(shadowOnly == 64);
    }
}

// The skinned half of the same rule: rigs that share a geometry draw as one palette batch in the main
// pass under a virtual shadow, and each rig keeps its own shadow-only item for the pages.
void virtualShadowRigsBatchInMainPass() {
    Scene scene;
    scene.enableTrackedTransform();
    auto geometry = makeBoxGeometry();
    const auto vertices = geometry->attributes.at("position")->count();
    geometry->setAttribute("skinIndex",
                           BufferAttribute::fromDoubles(Scalar::U16, std::vector<double>(vertices * 4, 0), 4));
    std::vector<double> weights(vertices * 4, 0);
    for (std::size_t i = 0; i < vertices; ++i) weights[i * 4] = 1;
    geometry->setAttribute("skinWeight", BufferAttribute::fromFloats(weights, 4));
    auto material = std::make_shared<Material>(MaterialType::Standard);
    std::vector<std::shared_ptr<Object3D>> keep;
    for (int i = 0; i < 8; ++i) {
        auto root = std::make_shared<Object3D>();
        auto rig = std::make_shared<SkinnedMesh>(geometry, material);
        auto bone = std::make_shared<Bone>();
        root->enableTrackedTransform();
        rig->enableTrackedTransform();
        bone->enableTrackedTransform();
        rig->frustumCulled = false;
        rig->setCastShadow(true);
        root->add(*rig);
        root->add(*bone);
        scene.add(*root);
        root->updateMatrixWorld(true);
        rig->bind(std::make_shared<Skeleton>(std::vector<std::shared_ptr<Bone>>{bone}));
        root->position.set(i * 3, 0, 0);
        keep.insert(keep.end(), {root, rig, bone});
    }
    PerspectiveCamera camera;
    camera.position.set(10, 8, 40);
    camera.lookAt(10, 0, 0);
    RenderDatabase database;
    database.shadowMapEnabled = true;
    LightState lights;
    for (int frame = 0; frame < 3; ++frame) {
        const auto& items = database.prepare(scene, camera, lights, nullptr, /*virtualShadows=*/true);
        std::size_t mainDraws = 0, mainInstances = 0, shadowOnly = 0;
        for (const DrawItem& item : items) {
            if (item.mainPass) { ++mainDraws; mainInstances += item.instanceCount; CHECK(!item.castShadow); }
            if (item.castShadow) { CHECK(!item.mainPass); ++shadowOnly; }
        }
        CHECK(mainDraws == 1 && mainInstances == 8);
        CHECK(shadowOnly == 8);
    }
}

// FM8: a virtual shadow page drew one row per caster per page, so the crowd's 240 casters cost 720 rows
// under a three-level sun. The casters a page selects that share one depth program and one material now
// draw as one instanced row per (page, group). The page's depth must not move: that row draws the same
// casters with the same matrices, so this case plans the same scene with the lever off and on and compares
// the rows, the casters each row draws and the frame's pixels.
struct ShadowInstanceArm {
    Scene scene;
    PerspectiveCamera camera{50, 4.0 / 3, 0.1, 200};
    DirectionalLight sun{Color(1, 1, 1), 3};
    EventQueue events;
    std::unique_ptr<Renderer> renderer;
    RenderDatabase database;
    std::vector<std::shared_ptr<Object3D>> keep;
    std::vector<Bone*> bones;
};

// One planned frame: its shadow rows, its stats, its pixels, and each row expanded into the (page, caster)
// pairs it draws — the multiset two arms must agree on, in a form a sorted compare can hold.
struct ShadowPlanCapture {
    std::vector<Renderer::ShadowPlanRow> rows;
    Renderer::FrameStats stats;
    std::size_t uniformBytes = 0;  // the frame's per-draw uniform arena: a grouped page packs fewer rows
    std::vector<uint8_t> pixels;
    std::vector<std::string> casters;  // "<page> <matrixWorld as hex>" per caster drawn
    struct Page {
        std::string name;
        std::size_t rows = 0, casters = 0;
        bool operator==(const Page&) const = default;
        bool operator<(const Page& o) const { return name < o.name; }
    };
    std::vector<Page> pages;
    std::size_t pageCount = 0, groups = 0;
    // The pages' names and the casters each drew: the page set and the per-page work, without the row counts
    // a collapsed page no longer has.
    std::vector<std::string> pageNames() const {
        std::vector<std::string> names;
        for (const Page& page : pages) if (page.casters != 0) names.push_back(page.name);
        return names;
    }
    std::vector<std::pair<std::string, std::size_t>> castersPerPage() const {
        std::vector<std::pair<std::string, std::size_t>> work;
        for (const Page& page : pages) if (page.casters != 0) work.emplace_back(page.name, page.casters);
        return work;
    }
};

ShadowPlanCapture captureShadowPlan(Renderer& renderer, EventQueue& events) {
    ShadowPlanCapture out;
    out.rows = renderer.shadowPlan();
    out.stats = renderer.lastFrame();
    out.uniformBytes = renderer.frameUniformBytes().size();
    out.pixels = read(renderer, events);
    const auto pageName = [](const Renderer::ShadowPlanRow& row) {
        return std::to_string(row.pass) + ' ' + std::to_string(row.x) + ',' + std::to_string(row.y) +
               (row.mover ? "mover" : "static");
    };
    const auto hex = [](double value) {
        char text[17];
        std::snprintf(text, sizeof text, "%016llx", static_cast<unsigned long long>(std::bit_cast<uint64_t>(value)));
        return std::string(text);
    };
    for (const Renderer::ShadowPlanRow& row : out.rows) {
        const std::string name = pageName(row);
        auto page = std::find_if(out.pages.begin(), out.pages.end(), [&](const ShadowPlanCapture::Page& p) { return p.name == name; });
        if (page == out.pages.end()) page = out.pages.emplace(out.pages.end(), ShadowPlanCapture::Page{name});
        ++page->rows;
        page->casters += row.members.size();
        for (const Renderer::ShadowPlanRow::Member& member : row.members) {
            std::string line = name;
            for (double value : member.matrixWorld) line += ' ' + hex(value);
            out.casters.push_back(std::move(line));
        }
    }
    std::sort(out.casters.begin(), out.casters.end());
    std::sort(out.pages.begin(), out.pages.end());
    for (const ShadowPlanCapture::Page& page : out.pages) if (page.casters != 0) ++out.pageCount;
    for (std::size_t i = 0; i < out.rows.size(); ++i) {  // distinct casters' geometries: an upper bound on groups
        bool seen = false;
        for (std::size_t j = 0; j < i && !seen; ++j) seen = out.rows[j].indices == out.rows[i].indices;
        if (!seen) ++out.groups;
    }
    return out;
}

// The two lever settings, so one process plans both arms: the flag is read per frame.
void setShadowInstanceLever(bool on) {
    if (on) unsetenv("TN_SHADOW_INSTANCE_GROUPS");
    else setenv("TN_SHADOW_INSTANCE_GROUPS", "0", 1);
}

void buildSkinnedShadowInstanceArm(ShadowInstanceArm& arm, mystral::webgpu::Context& context) {
    arm.renderer = std::make_unique<Renderer>(context.getInstance(), context.getDevice(), context.getQueue(), arm.events);
    arm.renderer->setSize(192, 192);
    arm.scene.enableTrackedTransform();
    arm.camera.position.set(0, 20, 0.001);
    arm.camera.lookAt(0, 0, 0);
    arm.camera.updateProjectionMatrix();
    arm.database.shadowMapEnabled = true;
    arm.sun.position.set(6, 12, 4);
    arm.sun.setCastShadow(true);
    // One page per clip level, each covering its whole window: a mover page per level holds every rig, so a
    // frame plans three pages and the rigs' rows are the page work this case counts.
    shadows::AtlasOptions atlas;
    atlas.clipExtents = {16, 48, 160};
    atlas.mapSize = 128;
    atlas.pageTexels = 128;
    atlas.adaptiveRefresh = false;
    atlas.adaptiveCasterGate = false;
    atlas.lightDistance = 80;
    atlas.depthRange = 160;
    arm.sun.shadow.virtualShadow = std::make_shared<const shadows::AtlasOptions>(std::move(atlas));
    arm.scene.add(arm.sun);
    auto material = std::make_shared<Material>(MaterialType::Standard);
    // The receiving ground: the page's depth reaches the frame only as these shadows.
    auto ground = std::make_shared<Mesh>(makeBoxGeometry(40, 0.2, 40), material);
    ground->position.y = -0.1;
    ground->setReceiveShadow(true);
    arm.scene.add(*ground);
    arm.keep.push_back(ground);
    // Two primitives a rig, sharing one geometry per primitive and one material, as a crowd's body and head do.
    const auto skinnable = [](std::shared_ptr<BufferGeometry> geometry) {
        const auto vertices = geometry->attributes.at("position")->count();
        geometry->setAttribute("skinIndex", BufferAttribute::fromDoubles(Scalar::U16, std::vector<double>(vertices * 4, 0), 4));
        std::vector<double> weights(vertices * 4, 0);
        for (std::size_t i = 0; i < vertices; ++i) weights[i * 4] = 1;
        geometry->setAttribute("skinWeight", BufferAttribute::fromFloats(weights, 4));
        return geometry;
    };
    auto body = skinnable(makeBoxGeometry(0.5, 1.1, 0.5));
    auto head = skinnable(makeBoxGeometry(0.45, 0.45, 0.45));
    for (int i = 0; i < 8; ++i) {
        auto root = std::make_shared<Object3D>();
        auto bone = std::make_shared<Bone>();
        root->enableTrackedTransform();
        bone->enableTrackedTransform();
        root->position.set(-3.5 + i, 0, 0);
        arm.scene.add(*root);
        auto skeleton = std::make_shared<Skeleton>(std::vector<std::shared_ptr<Bone>>{bone});
        root->add(*bone);
        std::vector<std::shared_ptr<SkinnedMesh>> rigs;
        for (const auto& [geometry, height] : {std::pair{body, 0.55}, std::pair{head, 1.4}}) {
            auto rig = std::make_shared<SkinnedMesh>(geometry, material);
            rig->frustumCulled = false;
            rig->setCastShadow(true);
            rig->position.y = height;
            rig->enableTrackedTransform();
            root->add(*rig);
            arm.keep.push_back(rig);
            rigs.push_back(rig);
        }
        root->updateMatrixWorld(true);
        for (const auto& rig : rigs) rig->bind(skeleton);
        arm.keep.insert(arm.keep.end(), {root, bone});
        arm.bones.push_back(bone.get());
    }
}

void buildStaticShadowInstanceArm(ShadowInstanceArm& arm, mystral::webgpu::Context& context) {
    arm.renderer = std::make_unique<Renderer>(context.getInstance(), context.getDevice(), context.getQueue(), arm.events);
    arm.renderer->setSize(192, 192);
    arm.camera.position.set(0, 14, 0.001);
    arm.camera.fov = 60;
    arm.camera.lookAt(0, 0, 0);
    arm.camera.updateProjectionMatrix();
    arm.database.shadowMapEnabled = true;
    arm.sun.position.set(6, 14, 4);
    arm.sun.setCastShadow(true);
    // Four pages over a 32 m window, so one wide caster straddles two of them and one page holds one caster.
    shadows::AtlasOptions atlas;
    atlas.clipExtents = {16};
    atlas.mapSize = 256;
    atlas.pageTexels = 128;
    atlas.adaptiveRefresh = false;
    atlas.adaptiveCasterGate = false;
    atlas.lightDistance = 60;
    atlas.depthRange = 120;
    arm.sun.shadow.virtualShadow = std::make_shared<const shadows::AtlasOptions>(std::move(atlas));
    arm.scene.add(arm.sun);
    auto material = std::make_shared<Material>(MaterialType::Standard);
    auto ground = std::make_shared<Mesh>(makeBoxGeometry(48, 0.2, 48), material);
    ground->position.y = -0.1;
    ground->setReceiveShadow(true);
    arm.scene.add(*ground);
    arm.keep.push_back(ground);
    auto small = makeBoxGeometry(6, 0.6, 0.6), wide = makeBoxGeometry(40, 0.6, 0.6);
    const auto caster = [&](std::shared_ptr<BufferGeometry> geometry, double x, double z) {
        auto mesh = std::make_shared<Mesh>(geometry, material);
        mesh->position.set(x, 0.9, z);
        mesh->setCastShadow(true);
        arm.scene.add(*mesh);
        arm.keep.push_back(mesh);
    };
    caster(wide, 0, -8);   // straddles the two pages of the window's lower half
    caster(small, -11, -8);
    caster(small, -4, -8);
    caster(small, 4, -8);
    caster(small, 11, -8);
    caster(small, 12, 12);  // alone in its page
}

// FG1: one InstancedMesh row spans the union of its instances, so every page of a level that union reached drew every
// instance: a camera move refills up to 256 pages, and the stress lab's 14,000 instanced trunks, canopies and rocks
// were drawn 256 times. A page now draws the instances whose own box reaches it. This case plans one 8 x 8 grid of boxes
// over a 4 x 4 page level with the lever off (the old row) and on, and holds the plan to the geometry: every page draws
// exactly the instances whose box reaches its rect, together they draw the mesh about once, and the frame's pixels do not
// move. TN_SHADOW_INSTANCE_CULL=0 in the environment runs both arms the old way, which is this case's red run.
void setShadowInstanceCullLever(bool on) {
    if (on) unsetenv("TN_SHADOW_INSTANCE_CULL");
    else setenv("TN_SHADOW_INSTANCE_CULL", "0", 1);
}

void virtualShadowPageDrawsOnlyItsInstances() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    const char* external = std::getenv("TN_SHADOW_INSTANCE_CULL");
    const bool leverOff = external != nullptr && std::strcmp(external, "0") == 0;
    constexpr uint32_t kSide = 8, kInstances = kSide * kSide;
    std::vector<Box3> boxes;  // the instances' world boxes, from their placements
    std::array<ShadowInstanceArm, 2> arms;
    std::array<ShadowPlanCapture, 2> capture;
    std::array<std::vector<uint8_t>, 2> settled;
    std::array<uint64_t, 2> meshId{};
    // A side x side grid of boxes `spacing` apart over a level of (mapSize / 128)^2 pages and a window 2 x extent wide.
    const auto build = [&](ShadowInstanceArm& built, uint32_t side, double spacing, double extent, int mapSize,
                           std::vector<Box3>& placed) {
        const double scale = extent / 16;
        built.renderer = std::make_unique<Renderer>(context.getInstance(), context.getDevice(), context.getQueue(), built.events);
        built.renderer->setSize(192, 192);
        built.camera.position.set(0, 28 * scale, 0.001);
        built.camera.fov = 60;
        built.camera.lookAt(0, 0, 0);
        built.camera.updateProjectionMatrix();
        built.database.shadowMapEnabled = true;
        built.database.batching = false;
        built.sun.position.set(6, 14, 4);
        built.sun.setCastShadow(true);
        // Pages of 8 m x scale, on a fixed depth range so the frame's plan repeats.
        shadows::AtlasOptions atlas;
        atlas.clipExtents = {extent};
        atlas.mapSize = mapSize;
        atlas.pageTexels = 128;
        atlas.adaptiveRefresh = false;
        atlas.adaptiveCasterGate = false;
        atlas.lightDistance = 60 * scale;
        atlas.depthRange = 120 * scale;
        built.sun.shadow.virtualShadow = std::make_shared<const shadows::AtlasOptions>(std::move(atlas));
        built.scene.add(built.sun);
        auto material = std::make_shared<Material>(MaterialType::Standard);
        auto ground = std::make_shared<Mesh>(makeBoxGeometry(48 * scale, 0.2, 48 * scale), material);
        ground->position.y = -0.1;
        ground->setReceiveShadow(true);
        built.scene.add(*ground);
        built.keep.push_back(ground);
        auto forest = std::make_shared<InstancedMesh>(makeBoxGeometry(1.5, 1.5, 1.5), material, side * side);
        placed.clear();
        const double first = -spacing * double(side - 1) / 2;
        for (uint32_t i = 0; i < side * side; ++i) {
            const Vector3 at(first + spacing * double(i % side), 0.75, first + spacing * double(i / side));
            Matrix4 matrix;
            matrix.makeTranslation(at.x, at.y, at.z);
            forest->setMatrixAt(i, matrix);
            placed.push_back(Box3().setFromCenterAndSize(at, Vector3(1.5, 1.5, 1.5)));
        }
        forest->setCastShadow(true);
        built.scene.add(*forest);
        built.keep.push_back(forest);
        return forest->id();
    };
    for (int arm = 0; arm < 2; ++arm) meshId[arm] = build(arms[arm], kSide, 4.0, 16, 512, boxes);
    for (int arm = 0; arm < 2; ++arm) {
        setShadowInstanceCullLever(arm == 1 && !leverOff);  // 0: one row per page for the whole mesh, 1: per instance
        // The level's static pages are drawn on the frame its window is granted: capture that frame, then settle.
        arms[arm].database.render(*arms[arm].renderer, arms[arm].scene, arms[arm].camera);
        capture[arm] = captureShadowPlan(*arms[arm].renderer, arms[arm].events);
        for (int frame = 0; frame < 2; ++frame)
            arms[arm].database.render(*arms[arm].renderer, arms[arm].scene, arms[arm].camera);
        settled[arm] = read(*arms[arm].renderer, arms[arm].events);
    }
    setShadowInstanceCullLever(true);
    if (external != nullptr) setenv("TN_SHADOW_INSTANCE_CULL", external, 1);
    // The geometry, independent of the engine's own page test: a page is its projection's frustum, a box reaches it
    // when its centre and half extents along the view's x and y axes overlap that frustum's range.
    const auto reaches = [](const Renderer::ShadowPlanRow& row, const Box3& box) {
        const auto& view = row.view;
        const auto& projection = row.projection;
        Vector3 centre, size;
        box.getCenter(centre);
        box.getSize(size);
        for (int axis = 0; axis < 2; ++axis) {
            const double middle = view[axis] * centre.x + view[4 + axis] * centre.y + view[8 + axis] * centre.z + view[12 + axis];
            const double reach = (std::abs(view[axis]) * size.x + std::abs(view[4 + axis]) * size.y + std::abs(view[8 + axis]) * size.z) / 2;
            double low = (-1 - projection[12 + axis]) / projection[axis * 5];
            double high = (1 - projection[12 + axis]) / projection[axis * 5];
            if (low > high) std::swap(low, high);
            if (middle + reach < low || middle - reach > high) return false;
        }
        return true;
    };
    std::array<uint64_t, 2> drawn{};
    std::array<std::size_t, 2> pages{};
    for (int arm = 0; arm < 2; ++arm) {
        for (const Renderer::ShadowPlanRow& row : capture[arm].rows) {
            if (row.mover || row.virtualLevel < 0 || row.key != meshId[arm]) continue;
            ++pages[arm];
            drawn[arm] += row.instanceCount;
            uint32_t expected = 0;
            for (const Box3& box : boxes) expected += reaches(row, box);
            if (arm == 1 && row.instanceCount != expected)
                std::printf("instance cull: page %d,%d draws %u instances, the geometry says %u\n", row.x, row.y, row.instanceCount, expected);
            // the old row draws the whole mesh on every page its union reached; the new one, what the page reaches
            CHECK(row.instanceCount == (arm == 0 ? kInstances : expected));
            CHECK(row.instanceCount > 0);
        }
        std::printf("instance cull, arm %s: %zu page rows, %llu instances drawn, %llu shadow triangles, %u shadow draws\n",
                    arm == 0 ? "off" : "on", pages[arm], static_cast<unsigned long long>(drawn[arm]),
                    static_cast<unsigned long long>(capture[arm].stats.shadowTriangles), capture[arm].stats.shadowDraws);
        CHECK(pages[arm] > 4);
        CHECK(capture[arm].stats.shadowTriangles == 12ull * drawn[arm]);  // a box is twelve triangles
    }
    CHECK(pages[1] <= pages[0]);  // a page only the union reached (the gap between instances) has no row now
    // (a) work: every page drew the whole mesh before; now the pages draw it about once between them, however many
    // pages the level has (a page count of 16 here, 256 in the stress lab).
    CHECK(drawn[0] == uint64_t{kInstances} * pages[0]);
    CHECK(drawn[1] < drawn[0] / 3);
    CHECK(drawn[1] <= 3ull * kInstances);
    CHECK(capture[1].stats.shadowTriangles < capture[0].stats.shadowTriangles / 3);
    // (b) pixels: a page's depth reaches the frame only through these shadows, so the buffers are equal.
    CHECK(!capture[0].pixels.empty() && capture[0].pixels == capture[1].pixels);
    CHECK(!settled[0].empty() && settled[0] == settled[1]);
    std::size_t covered = 0;
    int low = 255, high = 0;
    for (std::size_t p = 0; p + 3 < settled[0].size(); p += 4) {
        covered += settled[0][p] + settled[0][p + 1] + settled[0][p + 2] > 0;
        low = std::min(low, int(settled[0][p]));
        high = std::max(high, int(settled[0][p]));
    }
    std::printf("instance cull: %zu covered pixels, red %d..%d\n", covered, low, high);
    CHECK(covered > 10000);
    CHECK(high > 32 && low < high / 2);  // a lit floor and the boxes' shadows on it, not a blank frame
    // (c) the stress lab's shape: 1024 boxes over a 16 x 16 level (256 pages). Whole-mesh rows draw 1024 x pages
    // instances; the pages draw the mesh about once between them, and the work follows the instances, not the pages.
    ShadowInstanceArm big;
    std::vector<Box3> placed;
    const uint64_t bigId = build(big, 32, 3.5, 64, 2048, placed);
    // PRD-773: the shadow counters TN_FRAME_BUDGET carries under tnDebug name the same instances the plan draws.
    waste::setDebugEnabled(true);
    const uint64_t rowsBefore = waste::counters().shadowPageRows.load(), instancesBefore = waste::counters().shadowPageInstances.load();
    big.database.render(*big.renderer, big.scene, big.camera);
    const uint64_t countedRows = waste::counters().shadowPageRows.load() - rowsBefore;
    const uint64_t countedInstances = waste::counters().shadowPageInstances.load() - instancesBefore;
    waste::setDebugEnabled(false);
    uint64_t bigDrawn = 0;
    std::size_t bigPages = 0;
    for (const Renderer::ShadowPlanRow& row : big.renderer->shadowPlan()) {
        if (row.mover || row.virtualLevel < 0 || row.key != bigId) continue;
        ++bigPages;
        bigDrawn += row.instanceCount;
    }
    std::printf("instance cull, 16 x 16 pages: %zu page rows draw %llu instances of %zu (%llu with whole-mesh rows)\n",
                bigPages, static_cast<unsigned long long>(bigDrawn), placed.size(),
                static_cast<unsigned long long>(bigPages * placed.size()));
    std::printf("instance cull, counters: %llu static page rows, %llu instances\n",
                static_cast<unsigned long long>(countedRows), static_cast<unsigned long long>(countedInstances));
    CHECK(bigPages > 100);
    CHECK(bigDrawn <= 4ull * placed.size());
    CHECK(countedInstances == bigDrawn && countedRows >= bigPages);
}

void shadowPagesInstanceSkinnedCasters() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    // The skinned arm: 8 rigs x 2 primitives, all inside every level's window and animated a frame apart.
    std::array<ShadowInstanceArm, 2> arms;
    std::array<ShadowPlanCapture, 2> capture;
    for (int arm = 0; arm < 2; ++arm) buildSkinnedShadowInstanceArm(arms[arm], context);
    for (int arm = 0; arm < 2; ++arm) {
        setShadowInstanceLever(arm == 1);  // 0: one row per caster (the lever off), 1: one row per (page, group)
        for (int frame = 0; frame < 6; ++frame) {
            for (std::size_t b = 0; b < arms[arm].bones.size(); ++b)
                arms[arm].bones[b]->rotation.z = 0.15 * std::sin(0.4 * (frame + 3.0 * double(b)));
            arms[arm].scene.updateMatrixWorld(true);
            arms[arm].database.render(*arms[arm].renderer, arms[arm].scene, arms[arm].camera);
        }
        capture[arm] = captureShadowPlan(*arms[arm].renderer, arms[arm].events);
    }
    setShadowInstanceLever(true);
    for (int arm = 0; arm < 2; ++arm) {
        std::size_t instances = 0;
        for (const Renderer::ShadowPlanRow& row : capture[arm].rows) instances += row.instanceCount;
        std::printf("page groups, arm %s: %zu rows over %zu pages, %zu instances, %zu casters, %u shadow draws, "
                    "%u palette writes, %u skinned batches, %u exact, %zu uniform bytes\n", arm == 0 ? "off" : "on",
                    capture[arm].rows.size(), capture[arm].pageCount, instances, capture[arm].casters.size(),
                    capture[arm].stats.shadowDraws, capture[arm].stats.paletteWrites,
                    capture[arm].stats.shadowSkinned.batches, capture[arm].stats.shadowSkinned.exactDraws,
                    capture[arm].uniformBytes);
        CHECK(instances == capture[arm].casters.size());
        CHECK(capture[arm].stats.shadowDraws == capture[arm].rows.size());
        CHECK(!capture[arm].pixels.empty());  // a readback that never landed would compare two empty buffers
    }
    // (a) work: 8 rigs x 2 primitives x 3 levels before, one row per (page, material group) after — and the row
    // count can never grow with the square of the scene: it is bounded by the pages times the groups.
    CHECK(capture[0].rows.size() == 48);
    CHECK(capture[0].pageCount == 3);
    CHECK(capture[1].rows.size() <= 6);
    CHECK(capture[1].rows.size() * 1 < capture[0].rows.size());
    CHECK(capture[1].groups >= 2);
    // The rows a page can plan never exceed its casters' groups: this bound is independent of the caster
    // count, so a page cannot grow rows with the square of the scene the way F3's comparison loop did.
    CHECK(capture[1].stats.shadowDraws <= capture[1].pageCount * capture[1].groups);
    CHECK(capture[1].stats.shadowDraws < capture[0].stats.shadowDraws);
    // The per-draw uniform arena the frame uploads packs that many fewer rows: the crowd's ~1 MB of row
    // slabs per frame is the same multiplication.
    CHECK(capture[1].uniformBytes < capture[0].uniformBytes);
    // (b) identity: the pages, and every (page, caster, matrix) triple, are the same in both arms.
    CHECK(capture[0].casters == capture[1].casters);
    CHECK(capture[0].pageNames() == capture[1].pageNames());
    CHECK(capture[0].castersPerPage() == capture[1].castersPerPage());
    // (c) pixels: the page depth reaches the frame only through these shadows, so the buffers are equal.
    CHECK(!capture[0].pixels.empty() && capture[0].pixels == capture[1].pixels);
    if (!capture[0].pixels.empty()) {
        std::size_t covered = 0, differ = 0;
        int low = 255, high = 0;
        for (std::size_t p = 0; p + 3 < capture[0].pixels.size(); ++p) {
            differ += capture[0].pixels[p] != capture[1].pixels[p];
            if (p % 4 != 0) continue;
            low = std::min(low, int(capture[0].pixels[p]));
            high = std::max(high, int(capture[0].pixels[p]));
        }
        for (std::size_t p = 0; p + 3 < capture[0].pixels.size(); p += 4)
            covered += capture[0].pixels[p] + capture[0].pixels[p + 1] + capture[0].pixels[p + 2] > 0;
        std::printf("page groups: %zu covered pixels, %zu bytes differ, red %d..%d\n", covered, differ, low, high);
        CHECK(covered > 10000 && differ == 0);
        CHECK(high > 32 && low < high / 2);  // a lit floor and the rigs' shadows on it, not a blank frame
    }
    // (d) set once: the palette is written once per rig per frame, not once per page, and a grouped row is a batch.
    CHECK(capture[0].stats.paletteWrites == capture[1].stats.paletteWrites);
    CHECK(capture[0].stats.paletteWrites > 0 && capture[0].stats.paletteWrites < 48);
    CHECK(capture[0].stats.shadowSkinned.exactDraws == 48 && capture[0].stats.shadowSkinned.batches == 0);
    CHECK(capture[1].stats.shadowSkinned.exactDraws == 0 && capture[1].stats.shadowSkinned.batches == capture[1].rows.size());
    // (e) the static arm: a caster that straddles two pages groups inside each page, a page that selects one
    // caster keeps its plain row, and the pixels do not move.
    std::array<ShadowInstanceArm, 2> still;
    std::array<ShadowPlanCapture, 2> stillCapture;
    for (int arm = 0; arm < 2; ++arm) buildStaticShadowInstanceArm(still[arm], context);
    for (int arm = 0; arm < 2; ++arm) {
        setShadowInstanceLever(arm == 1);
        // The level's static pages are drawn on the frame its window is granted: capture that frame.
        still[arm].database.render(*still[arm].renderer, still[arm].scene, still[arm].camera);
        stillCapture[arm] = captureShadowPlan(*still[arm].renderer, still[arm].events);
    }
    setShadowInstanceLever(true);
    std::printf("page groups, static arm: %zu rows off, %zu on over %zu pages\n", stillCapture[0].rows.size(),
                stillCapture[1].rows.size(), stillCapture[0].pageCount);
    for (const auto& [name, casters] : stillCapture[0].castersPerPage())
        std::printf("page groups: static page %s drew %zu casters\n", name.c_str(), casters);
    // The wide caster straddles two pages and groups inside each; the page that selects one caster keeps one row.
    CHECK(stillCapture[0].rows.size() > stillCapture[1].rows.size());
    CHECK(stillCapture[0].pageNames() == stillCapture[1].pageNames());
    CHECK(stillCapture[0].castersPerPage() == stillCapture[1].castersPerPage());
    CHECK(stillCapture[0].casters == stillCapture[1].casters);
    CHECK(!stillCapture[0].pixels.empty() && stillCapture[0].pixels == stillCapture[1].pixels);
    // the page that selects one caster: one row before and after, carrying that caster alone — no work added
    for (const auto& page : stillCapture[1].pages)
        if (page.casters == 1) {
            std::size_t rows = 0, instances = 0;
            for (const Renderer::ShadowPlanRow& row : stillCapture[1].rows) {
                if (row.mover) continue;
                if (std::to_string(row.pass) + ' ' + std::to_string(row.x) + ',' + std::to_string(row.y) + "static" != page.name) continue;
                ++rows;
                instances += row.instanceCount;
            }
            std::printf("page groups: the single-caster page %s draws %zu row(s), %zu instance(s)\n", page.name.c_str(),
                        rows, instances);
            CHECK(rows == 1 && instances == 1);
        }
}

// Virtual shadow bounds fit a rig from its bones (UE 5.8.3 fits skinned bounds to bones), not by
// skinning every vertex on the CPU each frame: the box must still hold every posed vertex.
void boneReachBoundsHoldPosedVertices() {
    auto geometry = makeBoxGeometry();
    const auto vertices = geometry->attributes.at("position")->count();
    std::vector<double> indices(vertices * 4, 0), weights(vertices * 4, 0);
    for (std::size_t i = 0; i < vertices; ++i) {
        indices[i * 4] = 0; indices[i * 4 + 1] = 1;
        weights[i * 4] = i % 3 == 0 ? 1 : 0.4; weights[i * 4 + 1] = i % 3 == 0 ? 0 : 0.6;
    }
    geometry->setAttribute("skinIndex", BufferAttribute::fromDoubles(Scalar::U16, indices, 4));
    geometry->setAttribute("skinWeight", BufferAttribute::fromFloats(weights, 4));
    auto root = std::make_shared<Object3D>();
    auto rig = std::make_shared<SkinnedMesh>(geometry, std::make_shared<Material>(MaterialType::Standard));
    auto hip = std::make_shared<Bone>(), knee = std::make_shared<Bone>();
    hip->add(*knee);
    knee->position.y = -0.6;
    rig->position.set(1, 0.5, -2);
    rig->scale.setScalar(1.5);
    root->add(*rig);
    root->add(*hip);
    root->updateMatrixWorld(true);
    rig->bind(std::make_shared<Skeleton>(std::vector<std::shared_ptr<Bone>>{hip, knee}));
    for (int pose = 0; pose < 4; ++pose) {
        hip->position.set(pose * 0.7, 0.3 * pose, -0.2);
        hip->rotation.set(0.4 * pose, 0.9 - pose * 0.3, 0.2);
        knee->rotation.set(-0.8 * pose, 0.1, 0.5);
        knee->scale.setScalar(1 + 0.25 * pose);
        root->updateMatrixWorld(true);
        Box3 box;
        CHECK(rig->boneReachBounds(box));
        Box3 exact;
        for (uint64_t i = 0; i < vertices; ++i) {
            Vector3 vertex;
            rig->getVertexPosition(i, vertex);
            exact.expandByPoint(vertex);
            CHECK(vertex.x >= box.min.x - 1e-6 && vertex.y >= box.min.y - 1e-6 && vertex.z >= box.min.z - 1e-6);
            CHECK(vertex.x <= box.max.x + 1e-6 && vertex.y <= box.max.y + 1e-6 && vertex.z <= box.max.z + 1e-6);
        }
        // Conservative, not unbounded: a sphere per bone, so a few times the exact box at most.
        CHECK(box.min.distanceTo(box.max) <= 4 * exact.min.distanceTo(exact.max));
    }
    // Weights that do not sum to 1 leave the bones' hull: the caller falls back to the vertices.
    weights[0] = 0.5;
    geometry->setAttribute("skinWeight", BufferAttribute::fromFloats(weights, 4));
    Box3 box;
    CHECK(!rig->boneReachBounds(box));
}

void virtualShadowBoundsCache() {
    auto geometry = makeBoxGeometry(2, 2, 2);
    DrawItem item;
    item.positions = geometry->getAttribute("position")->store.get();
    Matrix4 model;
    item.matrixWorld = model.elements;
    DrawCache cache;
    const auto sample = [&] { return cache.virtualShadowBounds(item); };
    CHECK(sample().first.min.equals(Vector3(-1, -1, -1)));
    CHECK(std::abs(sample().second - std::sqrt(12.0)) < 1e-12);
    const auto built = cache.shadowBoundsBuilds;
    sample();
    CHECK(cache.shadowBoundsBuilds == built);
    model.makeTranslation(3, 0, 0); item.matrixWorld = model.elements;
    CHECK(sample().first.max.x == 4);
    const float changed[3] = {20, 2, 3};
    CHECK(item.positions->write(0, changed, sizeof(changed)) == BufferError::None);
    CHECK(sample().first.max.x == 23);
    item.positions->needsUpdate();
    const auto beforeVersion = cache.shadowBoundsBuilds;
    sample();
    CHECK(cache.shadowBoundsBuilds == beforeVersion + 1);
    CHECK(item.positions->resize(3));
    CHECK(sample().first.min.equals(Vector3(23, 2, 3)));
    CHECK(sample().first.max.equals(Vector3(23, 2, 3)));
    geometry = makeBoxGeometry(2, 2, 2);
    item.positions = geometry->getAttribute("position")->store.get();
    auto matrices = std::make_shared<BufferStore>(Scalar::F32, 32);
    std::array<float, 32> values{};
    for (int i = 0; i < 2; ++i) for (int j = 0; j < 16; ++j) values[i * 16 + j] = model.elements[j];
    values[28] = 10;
    CHECK(matrices->write(0, values.data(), sizeof(values)) == BufferError::None);
    item.instanceMatrices = matrices.get(); item.instanceCount = 2;
    CHECK(sample().first.max.x == 14);
    item.instanceCount = 1;
    CHECK(sample().first.max.x == 7);
    values[12] = 4;
    CHECK(matrices->write(0, values.data(), 16 * sizeof(float)) == BufferError::None);
    CHECK(sample().first.max.x == 8);
    const auto beforeInstanceVersion = cache.shadowBoundsBuilds;
    matrices->needsUpdate(); sample();
    CHECK(cache.shadowBoundsBuilds == beforeInstanceVersion + 1);
    const auto settled = cache.shadowBoundsBuilds;
    sample();
    CHECK(cache.shadowBoundsBuilds == settled);
    std::vector<float> bones;
    item.boneMatrices = &bones;
    const auto deforming = cache.shadowBoundsBuilds;
    sample(); sample();
    CHECK(cache.shadowBoundsBuilds == deforming + 2);
    item.boneMatrices = nullptr;
    sample();
    const auto staticAgain = cache.shadowBoundsBuilds;
    sample();
    CHECK(cache.shadowBoundsBuilds == staticAgain);
    item.morphGeometry = geometry.get();
    sample();
    const auto morphing = cache.shadowBoundsBuilds;
    sample();
    CHECK(cache.shadowBoundsBuilds == morphing + 1);
    item.morphGeometry = nullptr; item.instanceMatrices = nullptr; item.instanceCount = 1;
    item.matrixWorld = Matrix4().elements;
    alignas(BufferStore) std::byte storage[sizeof(BufferStore)];
    const auto fresh = [&] {
        return std::shared_ptr<BufferStore>(new (storage) BufferStore(Scalar::F32, 3),
                                           [](BufferStore* store) { store->~BufferStore(); });
    };
    auto original = fresh();
    const float oldPoint[3] = {1, 2, 3};
    CHECK(original->write(0, oldPoint, sizeof(oldPoint)) == BufferError::None);
    item.positions = original.get();
    CHECK(sample().first.max.z == 3);
    original.reset();
    auto replacement = fresh();
    const float newPoint[3] = {9, 8, 7};
    CHECK(replacement->write(0, newPoint, sizeof(newPoint)) == BufferError::None);
    item.positions = replacement.get();
    CHECK(sample().first.max.z == 7);  // same address, versions, writes and matrix; a new owner
}

void virtualShadowInstancePages() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    const auto draws = [&](bool instanced, uint32_t count, double offset) {
        EventQueue events;
        Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
        renderer.setSize(64, 64);
        Scene scene;
        PerspectiveCamera camera(50, 1, 0.1, 200);
        camera.position.set(0, 6, 10); camera.lookAt(0, 0, 0);
        DirectionalLight sun{Color(1, 1, 1), 3};
        sun.position.set(3, 8, 2); sun.setCastShadow(true);
        shadows::AtlasOptions atlas;
        atlas.clipExtents = {32}; atlas.mapSize = 256; atlas.pageTexels = 64;
        sun.shadow.virtualShadow = std::make_shared<const shadows::AtlasOptions>(std::move(atlas));
        scene.add(sun);
        auto material = std::make_shared<Material>(MaterialType::Standard);
        std::shared_ptr<Mesh> caster;
        if (instanced) {
            auto mesh = std::make_shared<InstancedMesh>(makeBoxGeometry(2, 2, 2), material, count);
            for (uint32_t i = 0; i < count; ++i) {
                Matrix4 matrix; matrix.makeTranslation(i * 10, 0, 0);
                mesh->setMatrixAt(i, matrix);
            }
            caster = mesh;
        } else {
            caster = std::make_shared<Mesh>(makeBoxGeometry(count == 1 ? 2 : 12, 2, 2), material);
        }
        caster->position.set(offset + (!instanced && count == 2 ? 5 : 0), 1, 0);
        caster->setCastShadow(true); caster->setReceiveShadow(true);
        scene.add(*caster);
        RenderDatabase database; database.shadowMapEnabled = true; database.batching = false;
        database.render(renderer, scene, camera);
        const auto* plan = renderer.virtualShadowAtlas(0);
        CHECK(plan != nullptr);
        return std::pair(renderer.lastFrame().shadowDraws, plan ? plan->pageCount() : 0);
    };
    for (uint32_t count : {1u, 2u}) for (double offset : {0.0, 18.0}) {
        const auto regular = draws(false, count, offset), instanced = draws(true, count, offset);
        std::printf("instance page cull: %u instances, offset %.0f, ordinary %u, instanced %u, pages %d\n",
                    count, offset, regular.first, instanced.first, regular.second);
        CHECK(regular.first > 0 && regular.first < uint32_t(regular.second));
        CHECK(instanced.first == regular.first);
    }
}

// F2: a virtual shadow's pages each select their casters from the same immutable draw list, so the frame
// spreads that selection over the job pool. The pooled plan must keep every page's draw list exactly as the
// caller's loop did: this case plans the same frames both ways, compares every planned shadow draw, and
// requires a dispatch for a large scene and none for a small one.
struct ShadowPageArm {
    Scene scene;
    PerspectiveCamera camera{70, 1, 0.1, 200};
    DirectionalLight sun{Color(1, 1, 1), 3};
    EventQueue events;
    std::unique_ptr<Renderer> renderer;
    RenderDatabase database;
    // The scene's objects and geometries in creation order: a draw item's key and index store belong to one
    // renderer, so the two arms address them by these ordinals.
    std::map<uint64_t, std::size_t> objectOrdinal;
    std::map<const void*, std::size_t> indexOrdinal;
    std::vector<std::shared_ptr<Mesh>> meshes;
    std::vector<Mesh*> movers;
};

void setupShadowPageArm(ShadowPageArm& arm, mystral::webgpu::Context& context, bool malformed) {
    arm.renderer = std::make_unique<Renderer>(context.getInstance(), context.getDevice(), context.getQueue(), arm.events);
    arm.renderer->setSize(64, 64);
    arm.camera.position.set(0, 10, 4);
    arm.camera.lookAt(0, 0, 0);
    arm.camera.updateProjectionMatrix();
    arm.database.shadowMapEnabled = true;
    arm.database.batching = false;
    arm.sun.position.set(3, 8, 2);
    arm.sun.setCastShadow(true);
    arm.scene.add(arm.sun);

    const auto add = [&](std::shared_ptr<Mesh> mesh) {
        arm.objectOrdinal.emplace(mesh->id(), arm.objectOrdinal.size());
        arm.meshes.push_back(mesh);
        mesh->setCastShadow(true);
        arm.scene.add(*mesh);
        return mesh;
    };
    // every caster is a cube, its edge the only variable
    const auto box = [](double size) { return makeBoxGeometry(size, size, size); };
    auto plain = std::make_shared<Material>(MaterialType::Standard);
    auto masked = std::make_shared<Material>(MaterialType::Standard);
    masked->alphaTest = 0.5;
    auto blended = std::make_shared<Material>(MaterialType::Standard);
    blended->transparent = true;
    blended->opacity = 0.5;
    // The finest level's 256 pages each cover a cell of this grid: the page x caster pairs alone pass the
    // dispatch gate, and an 8x8 grid keeps the accepted draws per page small.
    for (int z = 0; z < 8; ++z)
        for (int x = 0; x < 8; ++x) {
            auto mesh = add(std::make_shared<Mesh>(box(1.5), plain));
            mesh->position.set(-8.75 + 2.5 * x, 0.75, -8.75 + 2.5 * z);
        }
    auto maskedMesh = add(std::make_shared<Mesh>(box(1.6), masked));
    maskedMesh->position.set(-10, 0.8, 0);
    auto blendedMesh = add(std::make_shared<Mesh>(box(1.4), blended));
    blendedMesh->position.set(10, 0.7, 0);
    auto instanced = std::make_shared<InstancedMesh>(box(1.2), plain, 4);
    for (uint32_t i = 0; i < 4; ++i) {
        Matrix4 matrix;
        matrix.makeTranslation(-10.0 + 1.4 * i, 0.6, 8.0);
        instanced->setMatrixAt(i, matrix);
    }
    add(instanced);
    // A caster with a morph target: its bounds are its bind pose, so the pages take it without a cull.
    auto morphGeometry = box(1.3);
    const auto vertices = morphGeometry->attributes.at("position")->count();
    morphGeometry->morphPositions.push_back(BufferAttribute::fromFloats(std::vector<double>(vertices * 3, 0.0), 3));
    auto morphed = add(std::make_shared<Mesh>(morphGeometry, plain));
    morphed->position.set(10, 0.65, 8);
    auto mover = add(std::make_shared<Mesh>(box(1.3), plain));
    mover->position.set(-3, 0.65, 3);
    mover->setLayerMask(double(uint32_t{1} | (uint32_t{1} << 29)));  // the tracked caster layer: never still
    arm.movers.push_back(mover.get());
    auto pinnedMesh = add(std::make_shared<Mesh>(box(1.3), plain));
    pinnedMesh->position.set(3, 0.65, -3);
    // One mesh, two materials: its group draws are minted on its first frame and share its attributes.
    auto grouped = box(1.4);
    grouped->addGroup(0, 18, 0);
    grouped->addGroup(18, 18, 1);
    auto multi = std::make_shared<Mesh>();
    multi->geometry = grouped;
    multi->materials = {plain, masked};
    add(multi)->position.set(0, 0.7, -10);
    if (malformed) {
        auto hashMaterial = std::make_shared<Material>(MaterialType::Standard);
        hashMaterial->alphaHash = true;
        hashMaterial->nodes.opacityNode = shader::graph::float_(0.3);
        auto bad = add(std::make_shared<Mesh>(box(1.0), hashMaterial));
        bad->position.set(0, 2, 0);
        bad->setLayer(28);  // shadow only: the main pass never resolves this node graph
    }
    // Fixed atlas: no adaptive refresh or gate, a fixed clip and page size, so every frame's plan repeats.
    shadows::AtlasOptions atlas;
    atlas.clipExtents = {16, 48};
    atlas.mapSize = 512;
    atlas.pageTexels = 32;
    atlas.adaptiveRefresh = false;
    atlas.adaptiveCasterGate = false;
    atlas.control->pinned.insert(pinnedMesh->id());
    arm.sun.shadow.virtualShadow = std::make_shared<const shadows::AtlasOptions>(std::move(atlas));
}

// A multi-material mesh mints its group draws on its first frame, in group order: register them once, in both
// arms, so the ordinal a group draw reads is its group's. The index store a draw used is named by the ordinal of
// its first user: equal geometry bytes fold to one canonical buffer, so two casters may draw the same store.
void registerShadowPageDraws(ShadowPageArm& arm) {
    for (const auto& mesh : arm.meshes)
        for (const auto& part : mesh->groupMeshes) {
            if (!part) continue;
            arm.objectOrdinal.emplace(part->id(), arm.objectOrdinal.size());
        }
    for (const DrawItem& item : arm.database.drawn()) {
        if (!item.indices) continue;
        const auto object = arm.objectOrdinal.find(item.key);
        arm.indexOrdinal.emplace(item.indices,
                                 object == arm.objectOrdinal.end() ? arm.indexOrdinal.size() : object->second);
    }
}

// Every planned shadow draw, byte for byte: the pass state, the caster and its index store by ordinal, and the
// uniform blocks its offsets point at.
std::string shadowPlanDump(const Renderer& renderer, const ShadowPageArm& arm) {
    std::string out;
    const auto hex = [](double value) {
        char text[17];
        std::snprintf(text, sizeof text, "%016llx", static_cast<unsigned long long>(std::bit_cast<uint64_t>(value)));
        return std::string(text);
    };
    const auto ordinal = [](const auto& map, const auto& value) {
        const auto found = map.find(value);
        return found == map.end() ? std::size_t(-1) : found->second;
    };
    const std::span<const uint8_t> bytes = renderer.frameUniformBytes();
    for (const Renderer::ShadowPlanRow& row : renderer.shadowPlan()) {
        out += std::to_string(row.pass) + ' ' + std::to_string(row.virtualLight) + ' ' + std::to_string(row.virtualLevel) +
               ' ' + (row.lamp ? "lamp" : "map") + ' ' + (row.mover ? "mover" : "static") + ' ' + std::to_string(row.x) +
               ',' + std::to_string(row.y) + ',' + std::to_string(row.size) + ' ' +
               std::to_string(ordinal(arm.objectOrdinal, row.key)) + ' ' +
               std::to_string(ordinal(arm.indexOrdinal, row.indices)) + ' ' + std::to_string(row.instanceCount) + ' ' +
               hex(row.instanceBase) + ' ' + std::to_string(row.vertexOffset) + ' ' + std::to_string(row.fragmentOffset) + ' ';
        for (double value : row.view) out += hex(value);
        for (double value : row.projection) out += hex(value);
        for (double value : row.matrixWorld) out += hex(value);
        for (const auto [offset, length] : {std::pair{row.vertexOffset, row.vertexBytes}, std::pair{row.fragmentOffset, row.fragmentBytes}})
            if (length != 0 && std::size_t(offset) + length <= bytes.size())
                out.append(reinterpret_cast<const char*>(bytes.data()) + offset, length);
        out += '\n';
    }
    return out;
}

// The first byte two dumps disagree at, or npos.
std::size_t shadowPlanDifference(const std::string& a, const std::string& b) {
    const std::size_t common = std::min(a.size(), b.size());
    for (std::size_t i = 0; i < common; ++i) if (a[i] != b[i]) return i;
    return a.size() == b.size() ? std::string::npos : common;
}

// A window of a dump as hex, so a difference reads the same in a report as in a terminal.
std::string shadowPlanWindow(const std::string& dump, std::size_t from) {
    std::string out;
    char hex[3];
    for (std::size_t i = from; i < std::min(dump.size(), from + 96); ++i) {
        std::snprintf(hex, sizeof hex, "%02x", static_cast<unsigned>(static_cast<unsigned char>(dump[i])));
        out += hex;
    }
    return out;
}

// One number per plan, so a run before a change and a run after it compare in one line (`FNV-1a`).
uint64_t shadowPlanDigest(const std::string& dump) {
    uint64_t hash = 0xcbf29ce484222325ull;
    for (const char byte : dump) { hash ^= static_cast<unsigned char>(byte); hash *= 0x100000001b3ull; }
    return hash;
}

// FS9: `pageRange` is the inverse of `overlaps`, and the per-page index reads it. It must never miss a page the
// scan would take — that is a missing shadow — so every page `overlaps` accepts has to lie inside the range: a
// caster on a page edge lands in both cells, and one wholly outside the window reaches none.
void shadowPageRangeCoversEveryOverlappingPage() {
    shadows::AtlasOptions options;
    options.clipExtents = {16};
    options.mapSize = 256;
    options.pageTexels = 64;  // 4 x 4 pages of 8 m
    std::string error;
    auto atlas = shadows::PageAtlas::create(options, error);
    CHECK(atlas.has_value());
    if (!atlas) return;
    const std::vector<shadows::AtlasPage> pages =
        atlas->update(Vector3(0, 10, 4), Vector3(0.35, 0.9, 0.2), true, {}, 1.0 / 60);
    CHECK(!pages.empty());
    // The cell grid's origin page, and its neighbour across one cell edge.
    const shadows::AtlasPage* corner = nullptr;
    const shadows::AtlasPage* right = nullptr;
    for (const shadows::AtlasPage& page : pages) {
        if (page.x == 0 && page.y == 0) corner = &page;
        if (page.x == 1 && page.y == 0) right = &page;
    }
    CHECK(corner != nullptr && right != nullptr);
    if (!corner || !right) return;
    // The two rects overlap by the border texels, so the midpoint of their facing edges is the cell edge.
    const double edgeU = (corner->highU + right->lowU) / 2;
    const double middleV = (corner->lowV + corner->highV) / 2;
    // A world point of the light-space (u, v) plane: a page's axes are the light view's orthonormal x and y.
    const auto point = [&](double u, double v) {
        Vector3 out = corner->axisU;
        out.multiplyScalar(u);
        out.addScaledVector(corner->axisV, v);
        return out;
    };
    const auto cube = [](const Vector3& centre, double size) {
        Box3 box;
        box.setFromCenterAndSize(centre, Vector3(size, size, size));
        return box;
    };
    int x0 = 0, x1 = 0, y0 = 0, y1 = 0;
    // A 2.5 m caster centred on the edge straddles both cells.
    const Box3 straddler = cube(point(edgeU, middleV), 2.5);
    atlas->pageRange(0, straddler, x0, x1, y0, y1);
    std::printf("page range: straddler x %d..%d y %d..%d of %d\n", x0, x1, y0, y1, atlas->tiles(0));
    CHECK(x0 <= 0 && x1 >= 1 && y0 <= 0 && y1 >= 0);
    CHECK(atlas->overlaps(*corner, straddler) && atlas->overlaps(*right, straddler));
    // Every page the scan keeps is inside the range, for boxes of every size and placement.
    const std::array<Box3, 6> boxes{straddler, cube(point(edgeU, middleV), 0.5),
        cube(point((corner->lowU + corner->highU) / 2, middleV), 20), cube(point(corner->lowU, corner->lowV), 2.5),
        cube(point(edgeU, corner->highV), 1.5),
        cube(point(right->highU, (right->lowV + right->highV) / 2), 2.5)};
    std::size_t overlapping = 0;
    for (const Box3& box : boxes) {
        int a0, a1, b0, b1;
        atlas->pageRange(0, box, a0, a1, b0, b1);
        for (const shadows::AtlasPage& page : pages) {
            if (!atlas->overlaps(page, box)) continue;  // the scan would keep this page
            ++overlapping;
            CHECK(page.x >= a0 && page.x <= a1 && page.y >= b0 && page.y <= b1);
        }
    }
    std::printf("page range: %zu page(s) the scan keeps, all inside the range\n", overlapping);
    CHECK(overlapping > 0);
    // A caster wholly outside the window reaches none of its pages.
    const Box3 outside = cube(point(corner->lowU - 40, middleV), 2.5);
    atlas->pageRange(0, outside, x0, x1, y0, y1);
    std::printf("page range: outside box x %d..%d y %d..%d\n", x0, x1, y0, y1);
    CHECK(x1 < x0 && y1 < y0);
    for (const shadows::AtlasPage& page : pages) CHECK(!atlas->overlaps(page, outside));
    // A level the atlas has not mapped, or does not have, has no page to reach.
    atlas->pageRange(1, boxes[1], x0, x1, y0, y1);
    CHECK(x1 < x0 && y1 < y0);
}

void virtualShadowPageJobs() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    std::array<ShadowPageArm, 2> arms;
    for (ShadowPageArm& arm : arms) setupShadowPageArm(arm, context, false);
    // Twenty identical edits on both arms: the camera and the tracked caster move, so every frame rebuilds its
    // pages and the plan is never a repeat of the last. Arm 0 selects each page's casters from the whole draw list
    // (FS9's flat scan), arm 1 from the per-page index, so one dump comparison covers both arms of both levers.
    for (int frame = 0; frame < 20; ++frame) {
        for (ShadowPageArm& arm : arms) {
            arm.camera.position.set(0.25 * frame, 10, 4);
            arm.camera.lookAt(0, 0, 0);
            arm.camera.updateProjectionMatrix();
            for (Mesh* mover : arm.movers) mover->position.x = -3.0 + 0.3 * frame;
            arm.renderer->cutVirtualShadows();
        }
        waste::setDebugEnabled(true);
        flatShadowSelection() = true;
        const uint64_t flatBefore = waste::counters().shadowPageSelectionProbes.load();
        const uint64_t casterMapsBefore = waste::counters().shadowCasterMapProbes.load();
        JobPool::resetShared(0);
        const uint64_t callerRuns = JobPool::runs();
        arms[0].database.render(*arms[0].renderer, arms[0].scene, arms[0].camera);
        const bool callerStayed = JobPool::runs() == callerRuns;  // a pool with no workers selects on the caller
        const uint64_t flatProbes = waste::counters().shadowPageSelectionProbes.load() - flatBefore;
        flatShadowSelection() = false;
        const uint64_t indexedBefore = waste::counters().shadowPageSelectionProbes.load();
        JobPool::resetShared(3);
        const uint64_t pooledRuns = JobPool::runs();
        arms[1].database.render(*arms[1].renderer, arms[1].scene, arms[1].camera);
        const bool dispatched = JobPool::runs() > pooledRuns;
        const uint64_t indexedProbes = waste::counters().shadowPageSelectionProbes.load() - indexedBefore;
        // FS11: the caster bookkeeping is a flat record indexed by the draw's position, so neither render descends a
        // map of casters keyed by `DrawItem::key`. The two maps it replaced rebuilt from scratch every frame: two
        // descents per draw to rebuild the states, twice per draw again to judge a page's candidates, an insert per
        // caster into each tree. Both renders of the frame are inside this window, so any descent either path makes
        // is counted here.
        const uint64_t casterMapProbes = waste::counters().shadowCasterMapProbes.load() - casterMapsBefore;
        waste::setDebugEnabled(false);
        for (ShadowPageArm& arm : arms) registerShadowPageDraws(arm);
        const std::string serial = shadowPlanDump(*arms[0].renderer, arms[0]);
        const std::string pooled = shadowPlanDump(*arms[1].renderer, arms[1]);
        const std::size_t difference = shadowPlanDifference(serial, pooled);
        // The plan's own account of the work: the rows it kept, and the levels its granted pages belong to. A
        // selection that reads the whole draw list per page pays pages x casters probes; the index pays one entry
        // per caster per granted level plus the cells a caster straddles, which the selected casters already count:
        // a grouped row (FM8) draws its members as instances, so it counts each member a page selected.
        std::size_t rows = 0;
        std::set<int> grantedLevels;
        for (const Renderer::ShadowPlanRow& row : arms[1].renderer->shadowPlan()) {
            rows += std::max<std::size_t>(row.members.size(), 1);
            if (row.virtualLevel >= 0) grantedLevels.insert(row.virtualLevel);
        }
        const uint64_t draws = arms[0].database.drawn().size();
        const uint64_t bound =
            draws * std::max<std::size_t>(grantedLevels.size(), 1) + rows;  // never draws x pages
        std::printf("page jobs: frame %d, %zu items, %d shadow draws, %zu planned bytes, digest %016llx, dispatch %s, "
                    "plan %s, probes flat %llu indexed %llu (bound %llu, %zu row(s), %zu level(s)), caster map probes "
                    "%llu\n", frame,
                    arms[0].database.drawn().size(), arms[0].renderer->lastFrame().shadowDraws, serial.size(),
                    (unsigned long long)shadowPlanDigest(serial),
                    dispatched ? "yes" : "no", difference == std::string::npos ? "identical" : "DIFFER",
                    (unsigned long long)flatProbes, (unsigned long long)indexedProbes,
                    (unsigned long long)bound, rows, grantedLevels.size(), (unsigned long long)casterMapProbes);
        if (difference != std::string::npos) {
            const std::size_t line = std::size_t(std::count(serial.begin(), serial.begin() + std::min(difference, serial.size()), '\n'));
            const std::size_t from = difference > 48 ? difference - 48 : 0;
            std::printf("page jobs: first difference at byte %zu of line %zu\npage jobs: serial %s\npage jobs: pooled %s\n",
                        difference, line, shadowPlanWindow(serial, from).c_str(), shadowPlanWindow(pooled, from).c_str());
        }
        CHECK(!serial.empty());
        CHECK(callerStayed);
        CHECK(dispatched);
        CHECK(difference == std::string::npos);
        CHECK(flatProbes > 0 && indexedProbes > 0);
        CHECK(flatProbes > indexedProbes);  // the index is the flat scan's work minus the pairs no page can take
        CHECK(indexedProbes <= bound);      // and it never grows with the page count, which flatProbes does
        CHECK(casterMapProbes == 0);  // FS11: no map of casters is built, probed or scanned on a frame
    }
    // A small scene stays on the caller: a page or two of a handful of casters is no split.
    {
        Scene scene;
        PerspectiveCamera camera(50, 1, 0.1, 100);
        camera.position.set(0, 6, 8);
        camera.lookAt(0, 0, 0);
        DirectionalLight sun{Color(1, 1, 1), 3};
        sun.position.set(3, 8, 2);
        sun.setCastShadow(true);
        shadows::AtlasOptions atlas;
        atlas.clipExtents = {16};
        atlas.mapSize = 256;
        atlas.pageTexels = 64;
        sun.shadow.virtualShadow = std::make_shared<const shadows::AtlasOptions>(std::move(atlas));
        scene.add(sun);
        auto material = std::make_shared<Material>(MaterialType::Standard);
        std::vector<std::shared_ptr<Mesh>> meshes;
        for (int i = 0; i < 3; ++i) {
            auto mesh = std::make_shared<Mesh>(makeBoxGeometry(), material);
            mesh->position.set(double(i) - 1, 0.5, 0);
            mesh->setCastShadow(true);
            scene.add(*mesh);
            meshes.push_back(mesh);
        }
        EventQueue events;
        Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
        renderer.setSize(64, 64);
        RenderDatabase database;
        database.shadowMapEnabled = true;
        database.batching = false;
        JobPool::resetShared(3);
        const uint64_t before = JobPool::runs();
        database.render(renderer, scene, camera);
        std::printf("page jobs: small scene, %zu draws, %d shadow draws, dispatch %s\n", renderer.shadowPlan().size(),
                    renderer.lastFrame().shadowDraws, JobPool::runs() > before ? "yes" : "no");
        CHECK(renderer.lastFrame().shadowDraws > 0);
        CHECK(JobPool::runs() == before);
    }
    // A malformed caster stops the frame on the caller, with the pooled selection in flight rather than a
    // terminated worker. Its node graph and alpha hash are what the shadow pass refuses.
    {
        ShadowPageArm malformed;
        setupShadowPageArm(malformed, context, true);
        JobPool::resetShared(3);
        const uint64_t before = JobPool::runs();
        std::string thrown;
        try {
            malformed.database.render(*malformed.renderer, malformed.scene, malformed.camera);
        } catch (const std::runtime_error& error) {
            thrown = error.what();
        }
        std::printf("page jobs: malformed caster threw `%s`, dispatched %s\n", thrown.c_str(),
                    JobPool::runs() > before ? "yes" : "no");
        CHECK(thrown.rfind("TN_NATIVE_SHADOW_ALPHA_UNSUPPORTED", 0) == 0);
        CHECK(JobPool::runs() > before);
    }
    shadowPageRangeCoversEveryOverlappingPage();
    JobPool::resetShared(0);
}

// FS11: the caster record is one flat vector per light, one entry per position in the frame's frozen draw list. It
// is reused between frames, so an unchanged draw list neither allocates nor moves it: the two maps it replaced were
// rebuilt every frame, a tree node allocated and freed per caster, and probed twice per draw to rebuild the states.
void casterRecordAllocatesPerFrame() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    if (tn_check_failures != 0) return;
    ShadowPageArm arm;
    setupShadowPageArm(arm, context, false);
    JobPool::resetShared(0);
    arm.database.render(*arm.renderer, arm.scene, arm.camera);  // mints the group draws, and the record
    registerShadowPageDraws(arm);
    const std::size_t draws = arm.database.drawn().size();
    const auto& records = arm.renderer->casterRecords();
    std::printf("caster record: %zu recorded light(s), %zu draws\n", records.size(), draws);
    CHECK(!records.empty());
    if (records.empty()) return;
    const std::vector<Renderer::CasterRecord>& record = records.begin()->second;
    const Renderer::CasterRecord* const storage = record.data();
    const std::size_t capacity = record.capacity();
    std::size_t casters = 0;
    for (const Renderer::CasterRecord& entry : record) casters += entry.casts;
    CHECK(record.size() == draws);  // one entry per draw list position, and no others
    CHECK(casters > 0 && casters <= draws);  // it tells a caster from a receiver with a bool, not a map probe
    // The record assumes one key per caster: two draws sharing a key would have shared the two maps' last write.
    std::set<uint64_t> casterKeys;
    for (const DrawItem& item : arm.database.drawn()) if (item.castShadow) casterKeys.insert(item.key);
    CHECK(casterKeys.size() == casters);
    for (int frame = 0; frame < 3; ++frame) {
        arm.database.render(*arm.renderer, arm.scene, arm.camera);
        const auto& again = arm.renderer->casterRecords();
        CHECK(again.size() == records.size());
        const std::vector<Renderer::CasterRecord>& after = again.begin()->second;
        // The same storage every frame, sized to the draw list: a vector reused, never rebuilt.
        CHECK(after.size() == draws);
        CHECK(after.capacity() == capacity);
        CHECK(after.data() == storage);
    }
    std::printf("caster record: %zu draw(s), %zu caster(s), capacity %zu (%zu bytes), storage kept over 3 frames\n",
                draws, casters, capacity, capacity * sizeof(Renderer::CasterRecord));
    JobPool::resetShared(0);
}

// FM3: a draw's four probes (perDrawFragment, perDrawVertex, readsViewport, readsPostTexture) are pure
// functions of its program's stage modules, and a texture resolves to the same GPU record until its
// version (or, for a render target, its view) moves. Before FM3 every draw of every pass of every frame
// rescanned the program's bindings and took a `renderTarget.lock()` per sampled texture; a steady frame
// now does neither, and the pixels do not move.
void programProbesAreResolvedOnce() {
    namespace g = shader::graph;
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(64, 64);
    renderer.setOutput(OutputState{std::nullopt, 1, false});  // linear out: the bytes are the sampled values
    OrthographicCamera camera(-3, 3, 3, -3, 0.1, 10);
    camera.position.z = 5;
    camera.updateMatrixWorld();
    Scene scene;
    DirectionalLight sun{Color(1, 1, 1), 1};
    sun.position.set(1, 2, 3);
    sun.setCastShadow(true);  // the shadow passes read their own programs' probes too
    scene.add(sun);
    const auto image = [](uint8_t red, uint8_t green, uint8_t blue) {
        auto texture = std::make_shared<Texture>();
        texture->width = texture->height = 2;
        for (int i = 0; i < 4; ++i) texture->data.insert(texture->data.end(), {red, green, blue, 255});
        texture->needsUpdate();
        return texture;
    };
    // Twelve draws: four sampling a material `map`, four a TSL texture(object) node, four neither.
    std::vector<std::shared_ptr<Texture>> textures;
    std::vector<std::shared_ptr<Mesh>> meshes;
    for (int row = 0; row < 3; ++row)
        for (int col = 0; col < 4; ++col) {
            std::shared_ptr<Material> material;
            if (row == 0) {
                material = std::make_shared<Material>(MaterialType::Standard);
                textures.push_back(image(uint8_t(40 + col * 50), 120, 60));
                material->maps["map"] = textures.back();
            } else if (row == 1) {
                material = std::make_shared<Material>(MaterialType::Basic, true);
                material->rawNodeMaterial = true;
                textures.push_back(image(200, uint8_t(40 + col * 50), 60));
                // t_nodeMap<n>: a graph texture, so the vertex and fragment stages both bind per draw.
                material->nodes.fragmentNode =
                    g::objectTexture(textures.back(), "nodeMap" + std::to_string(row * 4 + col), g::uv());
            } else {
                material = std::make_shared<Material>(MaterialType::Standard);
                material->color.setRGB(0.2, 0.3, 0.7);
            }
            auto plane = std::make_shared<Mesh>(makePlaneGeometry(1, 1), material);
            plane->position.set((col - 1.5) * 1.2, (1 - row) * 1.2, 0);
            scene.add(*plane);
            meshes.push_back(plane);
        }
    scene.updateMatrixWorld(true);
    RenderDatabase database;
    database.shadowMapEnabled = true;
    const auto frame = [&] {
        database.render(renderer, scene, camera, {0, 0, 0, 1});
        return read(renderer, events);
    };
    waste::setDebugEnabled(true);
    const std::vector<uint8_t> first = frame();
    CHECK(first.size() == 64 * 64 * 4);
    CHECK(renderer.programCount() >= 3);  // the three kinds of draw built their own programs
    const uint64_t probes = waste::counters().programProbeScans.load();
    CHECK(probes > 0);  // the first frame resolved the programs' probes at least once
    const uint64_t locks = waste::counters().textureTargetLocks.load();
    const std::vector<uint8_t> second = frame();
    const uint64_t scans = waste::counters().programProbeScans.load() - probes;
    const uint64_t taken = waste::counters().textureTargetLocks.load() - locks;
    std::printf("program probes: %llu to build the programs, %llu on a steady frame; render-target locks %llu, then %llu\n",
                (unsigned long long)probes, (unsigned long long)scans, (unsigned long long)locks,
                (unsigned long long)taken);
    CHECK(scans == 0);   // a steady frame scans no bindings
    CHECK(taken == 0);   // and takes no render-target lock
    CHECK(renderer.diagnostics().empty());
    // The per-draw arm resolves the same probes on every draw; its pixels must be byte-identical.
    const std::vector<uint8_t> third = frame();
    CHECK(second == third);  // steady: nothing temporal, so a frame repeats its bytes
    perDrawProbes() = true;
    const std::vector<uint8_t> perDraw = frame();
    perDrawProbes() = false;
    CHECK(perDraw.size() == first.size());
    CHECK(perDraw == first);
    // The branch the fast path skips stays live: a render target's texture is locked, and its view followed.
    const auto target = RenderTarget::make(16, 16, kTextureHalfFloatType);
    auto sampling = std::make_shared<Material>(MaterialType::Basic);
    sampling->maps["map"] = target->texture;
    auto sampled = std::make_shared<Mesh>(makePlaneGeometry(0.8, 0.8), sampling);
    sampled->position.set(0, 0, 1);
    scene.add(*sampled);
    meshes.push_back(sampled);
    scene.updateMatrixWorld(true);
    const uint64_t beforeTarget = waste::counters().textureTargetLocks.load();
    CHECK(frame().size() == first.size());
    const uint64_t targetLocks = waste::counters().textureTargetLocks.load() - beforeTarget;
    std::printf("program probes: %llu render-target locks for a texture that borrows a target's view\n",
                (unsigned long long)targetLocks);
    CHECK(targetLocks > 0);
    CHECK(renderer.diagnostics().empty());
    perDrawProbes() = false;
    waste::setDebugEnabled(false);
}

// FM1 review: the material half of a draw is held while its signature and geometry revision hold, so two
// writes that move neither must still reach the pixels. (1) A normalized byte colour attribute reaches the
// draw as a converted float copy, and `setNeedsUpdate` replaces that copy without a geometry revision.
// (2) An onBeforeRender callback writes the material after refresh() signed it, so a game that puts the
// material back once the callback is gone matches the stale signature.
void drawRefreshGuardHoles() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(64, 48);
    const size_t center = (24 * 64 + 32) * 4;
    {
        LitScene s;
        s.material->color.setRGB(1, 1, 1);
        s.material->vertexColors = true;
        const uint64_t count = s.geometry->attributes.at("position")->count();
        std::vector<double> red;
        for (uint64_t i = 0; i < count; ++i) red.insert(red.end(), {255, 0, 0});
        s.geometry->setAttribute("color", BufferAttribute::fromDoubles(Scalar::U8, red, 3, true));
        RenderDatabase database;
        database.render(renderer, s.scene, s.camera, {0, 0, 0, 1});
        const std::vector<uint8_t> before = read(renderer, events);
        auto color = s.geometry->attributes.at("color");
        for (uint64_t i = 0; i < count; ++i) {
            color->setComponent(i, 0, 0);
            color->setComponent(i, 2, 1);
        }
        color->setNeedsUpdate();
        database.render(renderer, s.scene, s.camera, {0, 0, 0, 1});
        const std::vector<uint8_t> after = read(renderer, events);
        std::printf("converted colour: centre red %d -> %d, blue %d -> %d\n", before[center], after[center],
                    before[center + 2], after[center + 2]);
        CHECK(before.size() == 64 * 48 * 4 && after.size() == before.size());
        CHECK(before[center] > 40 && before[center] > before[center + 2]);
        CHECK(after[center] * 3 < before[center]);  // the repainted bytes reached the draw
    }
    {
        LitScene s;
        s.material->color.setRGB(0.9, 0.2, 0.1);
        RenderDatabase database;
        s.mesh.onBeforeRender = std::make_shared<const std::function<bool(const RenderCallbackArgs&, std::string&)>>(
            [&](const RenderCallbackArgs&, std::string&) {
                s.material->color.setRGB(0.1, 0.2, 0.9);
                return true;
            });
        database.render(renderer, s.scene, s.camera, {0, 0, 0, 1});
        const std::vector<uint8_t> blue = read(renderer, events);
        s.mesh.onBeforeRender = nullptr;
        s.material->color.setRGB(0.9, 0.2, 0.1);  // the signature refresh() took before the callback
        database.render(renderer, s.scene, s.camera, {0, 0, 0, 1});
        const std::vector<uint8_t> red = read(renderer, events);
        std::printf("callback colour: centre r/b %d/%d -> %d/%d\n", blue[center], blue[center + 2], red[center],
                    red[center + 2]);
        CHECK(blue.size() == 64 * 48 * 4 && blue[center + 2] > blue[center]);
        CHECK(red.size() == blue.size() && red[center] > red[center + 2]);  // the game's colour, not the callback's
    }
}

// TR1b: an instanced draw whose stores did not move since the GPU got its bytes is left alone: the plan neither copies its
// floats into `instances` nor compares them, so a static forest costs nothing per frame. Any write to its matrices or
// colours, a change of count, or a new place for it, copies it again.
void staticInstancesAreNotRecopied() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(96, 72);
    renderer.setOutput(OutputState{shader::ToneMapping::ACESFilmic, 1, true});
    Scene scene;
    PerspectiveCamera camera(50, 96.0 / 72, 0.1, 100);
    constexpr uint32_t countA = 300, countB = 200;
    const auto instanced = [&](uint32_t count, double roughness, double x) {
        auto material = std::make_shared<Material>(MaterialType::Standard);
        material->roughness = roughness;
        auto mesh = std::make_shared<InstancedMesh>(makeBoxGeometry(), material, count);
        mesh->count = count;
        mesh->frustumCulled = false;
        mesh->position.set(x, 0, 0);
        for (uint32_t i = 0; i < count; ++i) {
            Matrix4 placement;
            placement.makeTranslation(double(i % 20) * 0.2, double(i / 20) * 0.2, 0);
            mesh->setMatrixAt(i, placement);
        }
        mesh->instanceMatrix->setNeedsUpdate();
        scene.add(*mesh);
        return mesh;
    };
    const auto a = instanced(countA, 0.6, -4);
    const auto b = instanced(countB, 0.3, 4);
    DirectionalLight light{Color().setHex(0xffffff), 3};
    light.position.set(3, 5, 8);
    scene.add(light);
    RenderDatabase database;
    struct Frame { uint32_t copies; uint64_t sent; };
    const auto frame = [&](double x) {
        camera.position.set(x, 0, 12);
        camera.lookAt(0, 0, 0);
        camera.updateProjectionMatrix();
        const uint64_t before = renderer.gpu().queueWriteBytes();
        database.render(renderer, scene, camera, {0.05, 0.06, 0.08, 1});
        const Frame result{renderer.lastFrame().instanceCopies, renderer.gpu().queueWriteBytes() - before};
        renderer.poll();
        events.drain();
        return result;
    };
    const Frame first = frame(-12);
    for (int warm = 0; warm < 3; ++warm) frame(-12);
    const Frame still = frame(-12);
    const Frame turned = frame(12);  // the draws swap order; each keeps its place and its bytes
    frame(-12);
    std::printf("static instances: first copies %u, still copies %u (%llu B), turned copies %u (%llu B)\n", first.copies,
                still.copies, static_cast<unsigned long long>(still.sent), turned.copies,
                static_cast<unsigned long long>(turned.sent));
    CHECK(first.copies == 2);
    CHECK(still.copies == 0);
    CHECK(turned.copies == 0);
    // A matrix written and flagged copies that draw alone, and its new bytes reach the GPU.
    Matrix4 moved;
    moved.makeTranslation(9, 9, 0);
    a->setMatrixAt(7, moved);
    a->instanceMatrix->setNeedsUpdate();
    const Frame edited = frame(-12);
    CHECK(edited.copies == 1);
    CHECK(edited.sent > still.sent);
    CHECK(frame(-12).copies == 0);
    // A colour write, a count change and a hidden-then-shown draw each copy exactly what they touched.
    b->setColorAt(3, Color().setHex(0xff0000));
    b->instanceColor->setNeedsUpdate();
    CHECK(frame(-12).copies == 1);
    CHECK(frame(-12).copies == 0);
    a->count = 100;
    CHECK(frame(-12).copies == 1);
    CHECK(frame(-12).copies == 0);
    a->count = countA;
    CHECK(frame(-12).copies == 1);  // grown back: its stamp holds another count
    CHECK(frame(-12).copies == 0);
}

TN_TEST_MAIN({"virtual_shadow_page_jobs", virtualShadowPageJobs}, {"caster_record_allocates_per_frame", casterRecordAllocatesPerFrame}, {"virtual_shadow_instance_pages", virtualShadowInstancePages}, {"virtual_shadow_page_draws_only_its_instances", virtualShadowPageDrawsOnlyItsInstances},{"virtual_shadow_bounds_cache", virtualShadowBoundsCache}, {"gpu_joint_production", gpuJointProduction}, {"virtual_shadow_casters_batch_in_main_pass", virtualShadowCastersBatchInMainPass}, {"virtual_shadow_rigs_batch_in_main_pass", virtualShadowRigsBatchInMainPass}, {"virtual_shadow_pages_instance_skinned_casters", shadowPagesInstanceSkinnedCasters}, {"bone_reach_bounds_hold_posed_vertices", boneReachBoundsHoldPosedVertices}, {"multi_material_groups", multiMaterialGroups}, {"uniform_batch_preparation", uniformBatchPreparation}, {"content_identical_geometry_batches", contentIdenticalGeometryBatches}, {"steady_state", steadyState}, {"steady_state_draw_refresh_work", steadyStateDrawRefreshWork}, {"draw_refresh_guard_holes", drawRefreshGuardHoles}, {"color_write_masks_the_draw", colorWriteMasksTheDraw}, {"depth_test_off_draws_over_nearer", depthTestOffDrawsOverNearer}, {"normal_pass_is_not_tallied", normalPassIsNotTallied}, {"gtao_screen_reach", gtaoScreenReach}, {"steady_cache_invalidation", steadyCacheInvalidation}, {"render_target", renderTarget}, {"float_render_target_keeps_float32", floatRenderTargetKeepsFloat32}, {"float_render_target_falls_back_to_half", floatRenderTargetFallsBackToHalf}, {"post_texture_resize_keeps_draw_groups", postTextureResizeKeepsDrawGroups}, {"deferred_target_follows_post_rtt", deferredTargetFollowsPostRtt}, {"deferred_target_samples_post_rtt_node", deferredTargetSamplesPostRttNode}, {"screen_size_reaches_the_vertex_stage", screenSizeReachesTheVertexStage}, {"depth_node_sets_fragment_depth", depthNodeSetsFragmentDepth}, {"depth_node_reaches_every_material_program", depthNodeReachesEveryMaterialProgram}, {"scene_environment", sceneEnvironment}, {"lit_scene", litScene}, {"scene_stage_is_metered", sceneStageIsMetered}, {"overlay_leaves_stage_totals", overlayLeavesStageTotals}, {"present_direct", presentDirect}, {"canvas_layer_overlay", canvasLayerOverlay}, {"post_survives_overlay", postSurvivesOverlay}, {"invariant_scope", invariantScope}, {"instance_counts", instanceCounts}, {"target_samples_late_traa_output", targetSamplesLateTraaOutput}, {"unchanged_frame_storage", unchangedFrameStorage}, {"static_instances_are_not_recopied", staticInstancesAreNotRecopied}, {"instance_places_survive_a_draw_leaving_the_view", instancePlacesSurviveADrawLeavingTheView}, {"instance_upload_is_stable_across_a_camera_turn", instanceUploadIsStableAcrossACameraTurn}, {"flat_lane_equivalence", flatLaneEquivalence}, {"directional_target", directionalTarget}, {"directional_target_outside_scene", directionalTargetOutsideScene}, {"scene_fog_node", sceneFogNode}, {"lit_mesh_without_normals", litMeshWithoutNormals}, {"invalidation", invalidation}, {"alpha_scene", alphaScene}, {"frame_slab_is_per_program", frameSlabIsPerProgram},
             {"material_unsupported", materialUnsupported}, {"shader_invalid", shaderInvalid}, {"time_uniform", timeUniform}, {"gpu_mipmaps", gpuMipmaps}, {"updates", updates},
             {"multi_camera_layers", multiCameraLayers}, {"render_callback", renderCallback}, {"instanced", instanced},
             {"virtual_sun_room_seam", virtualSunRoomSeam},
             {"virtual_sun_pixel_floor", virtualSunPixelFloor},
             {"virtual_sun_lod_rung", virtualSunLodRung},
             {"virtual_sun_level_sizes", virtualSunLevelSizes},
             {"virtual_sun_auto_map_size", virtualSunAutoMapSize},
             {"batched_vs_unbatched", batchedVsUnbatched}, {"stable_passes_match_direct", stablePassesMatchDirect}, {"camera_cull_keeps_bundle", cameraCull}, {"skinned_crowd", skinnedCrowdPixels}, {"skinned_decline_cadence", skinnedDeclineCadence}, {"skinned_projecting_cadence", skinnedProjectingCadence}, {"skinned_normalized_weights", skinnedNormalizedWeights}, {"normal_map_tilt", normalMapTilt}, {"unsupported_map_slot", unsupportedMapSlot}, {"env_map_slot_is_read", envMapSlotIsRead}, {"converted_copies_swept", convertedCopiesAreSwept}, {"gpu_timer_covers_offscreen", gpuTimerCoversOffscreen}, {"gpu_timer_splits_the_gather", gpuTimerSplitsTheLabelledGather}, {"gpu_timer_covers_shadows", gpuTimerCoversShadows}, {"overlay_over_frame", overlayOverFrame}, {"gpu_timer_is_opt_in", gpuTimerIsOptIn}, {"msaa_edges", msaaEdges}, {"shadow_camera_layers", shadowCameraLayers}, {"flat_shading_needs_no_normals", flatShadingNeedsNoNormals}, {"map_sampleability_changes", mapSampleabilityChanges}, {"batch_caches_stay_put", batchCachesStayPut}, {"batch_keeps_member_id", batchKeepsMemberId}, {"frustum_culling", frustumCulling},
             {"shadow_caster_frustum_culling", shadowCasterFrustumCulling}, {"masked_shadow", maskedShadow}, {"leaf_receiver", leafReceiver}, {"shadow_noise_frame", shadowNoiseFrame},{"foliage_transmission", foliageTransmission}, {"rough_diffuse", roughDiffuse}, {"point_shadow_cube_faces", pointShadowCubeFaces}, {"lamp_source_radius", lampSourceRadius}, {"lamp_source_radius_wall", lampSourceRadiusWall}, {"lamp_source_radius_crate", lampSourceRadiusCrate}, {"contact_shadow_foot", contactShadowFoot}, {"virtual_sun_contact_foot", virtualSunContactFoot}, {"lamp_cache", lampCache}, {"cached_lamp_has_no_uniform_upload", cachedLampHasNoUniformUpload}, {"sun_cache", sunCache}, {"lamp_atlas", lampAtlas}, {"gpu_timer_splits_lamp_shadows", gpuTimerSplitsLampShadows}, {"shadow_lights_follow_hierarchy", shadowLightsFollowHierarchy}, {"records_survive_siblings", recordsSurviveSiblings}, {"steady_frame_hashes_no_record", steadyFrameHashesNoRecord}, {"nested_record_cache", nestedRecordCache}, {"frustum_record_retention", frustumRecordRetention}, {"world_sphere_measured_once", worldSphereMeasuredOnce}, {"reflection_reuse", reflectionReuse}, {"program_probes_are_resolved_once", programProbesAreResolvedOnce})






