// PRD-514 phase 1: the render database draws the native scene graph. `lit_scene` builds the
// lit-render fixture as a scene (SphereGeometry, MeshStandardMaterial, DirectionalLight,
// HemisphereLight, PerspectiveCamera) and renders it with renderer.render(scene, camera)'s native
// path, against the browser's golden frame. `invalidation` checks that records follow revisions only.

#include "check.h"
#include "engine/renderer/post/traa.h"
#include "engine/renderer/render_database.h"
#include "engine/renderer/render_target_pass.h"
#include "engine/renderer/projection/plan.h"
#include "engine/shader/package.h"
#include "engine/shader/graph/post_effects.h"
#include "engine/player/skinned_crowd.h"
#include "engine/scene/geometries.h"
#include "mystral/webgpu/context.h"
#include "mystral/webgpu_compat.h"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <chrono>
#include <cstring>
#include <functional>
#include <limits>
#include <cstdlib>
#include <cmath>
#include <cstdio>
#include <string>
#include <thread>

extern "C" unsigned char* stbi_load(const char* filename, int* x, int* y, int* comp, int req_comp);
extern "C" void stbi_image_free(void* data);

using namespace tn::engine;

namespace {

void uniformBatchPreparation() {
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
        if (key == "traa-velocity") { ++velocity; CHECK(flagged(source)); }
        else if (key.rfind("depth|", 0) == 0) CHECK(!flagged(source));  // the shadow depth program shares its stage with nothing, TRAA or not
        else if (before) CHECK(!flagged(source));                         // built by the plain frame, untouched
        else { ++colour; CHECK(flagged(source)); }
    }
    CHECK(velocity == 1 && colour >= 1);  // the TRAA frame built its own flagged colour program beside the plain one
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
        const auto refused = renderToTarget(renderer, *target, inner, innerCamera, {0.25, 0.5, 0.75, 1}, false);
        CHECK(refused.empty());
        database.render(renderer, scene, camera, {0, 0, 0, 1});
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
// it batches on the 60th frame after the declining scan. A projecting decision is re-judged every frame.
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
void normalMapTilt() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(160, 120);
    renderer.setOutput(OutputState{std::nullopt, 1, true});
    struct Tilt { int red, green; bool loaded; };  // red < 0: no map
    auto brightness = [&](Tilt tilt, std::array<double, 3> lightAt) {
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
        database.render(renderer, scene, camera, {0, 0, 0, 1});
        CHECK(database.diagnostics().empty());
        const auto px = read(renderer, events);
        CHECK(px.size() == 160 * 120 * 4);
        double sum = 0;
        for (int y = 40; y < 80; ++y)
            for (int x = 60; x < 100; ++x) sum += px[(size_t(y) * 160 + x) * 4 + 1];
        return sum / (40 * 40);
    };
    const std::array<double, 3> fromRight{4, 0, 2}, fromAbove{0, 4, 2};
    const double none = brightness({-1, 128, false}, fromRight);
    const double toward = brightness({191, 128, false}, fromRight), away = brightness({64, 128, false}, fromRight);
    const double noneUp = brightness({-1, 128, false}, fromAbove);
    const double up = brightness({128, 191, false}, fromAbove), down = brightness({128, 64, false}, fromAbove);
    const double loadedToward = brightness({191, 128, true}, fromRight);
    const double loadedUp = brightness({128, 191, true}, fromAbove);
    std::printf("normal map tilt: x %.1f/%.1f/%.1f, y %.1f/%.1f/%.1f, loaded %.1f/%.1f\n", toward, none, away, up, noneUp, down,
                loadedToward, loadedUp);
    CHECK(toward > none + 8 && none > away + 8);
    CHECK(up > noneUp + 8 && noneUp > down + 8);  // green: the dFdy sign
    CHECK(std::abs(loadedToward - toward) < 2 && std::abs(loadedUp - up) < 2);
    brightness({-1, 128, false}, fromRight);  // the next frame sweeps the last arm's dead texture too
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

// Device errors reach stderr only, never the diagnostics. A frame that must draw cleanly runs inside
// a validation scope, and the scope's verdict is what the frame is checked against.
struct ScopeVerdict {
    std::atomic<bool> done{false};
    WGPUErrorType type = WGPUErrorType_NoError;
};

#if WGPU_USES_CALLBACK_INFO_PATTERN
void onScopePopped(WGPUPopErrorScopeStatus, WGPUErrorType type, WGPUStringView, void* verdict, void*) {
    static_cast<ScopeVerdict*>(verdict)->type = type;
    static_cast<ScopeVerdict*>(verdict)->done = true;
}
#else
void onScopePopped(WGPUErrorType type, const char*, void* verdict) {
    static_cast<ScopeVerdict*>(verdict)->type = type;
    static_cast<ScopeVerdict*>(verdict)->done = true;
}
#endif

// Pops the scope pushed before the frame, then polls until its verdict arrives.
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
    CHECK(verdict.done && verdict.type == WGPUErrorType_NoError);
    CHECK(database.diagnostics().empty());
    CHECK(renderer.diagnostics().empty());
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

    // 2. Default case: shadow camera with mask 1 uses the main camera's mask.
    // A layer-2 mesh casts only if the main camera enables layer 2.
    light->shadow.camera->setLayerMask(1);
    database.render(renderer, scene, camera);
    stats = renderer.lastFrame();
    CHECK(stats.draws == 2);
    CHECK(stats.shadowDraws == 1);

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

TN_TEST_MAIN({"uniform_batch_preparation", uniformBatchPreparation}, {"steady_state", steadyState}, {"steady_cache_invalidation", steadyCacheInvalidation}, {"render_target", renderTarget}, {"scene_environment", sceneEnvironment}, {"lit_scene", litScene}, {"present_direct", presentDirect}, {"invariant_scope", invariantScope}, {"instance_counts", instanceCounts}, {"flat_lane_equivalence", flatLaneEquivalence}, {"directional_target", directionalTarget}, {"invalidation", invalidation}, {"alpha_scene", alphaScene},
             {"material_unsupported", materialUnsupported}, {"shader_invalid", shaderInvalid}, {"time_uniform", timeUniform}, {"gpu_mipmaps", gpuMipmaps}, {"updates", updates},
             {"multi_camera_layers", multiCameraLayers}, {"render_callback", renderCallback}, {"instanced", instanced},
             {"batched_vs_unbatched", batchedVsUnbatched}, {"skinned_crowd", skinnedCrowdPixels}, {"skinned_decline_cadence", skinnedDeclineCadence}, {"skinned_normalized_weights", skinnedNormalizedWeights}, {"normal_map_tilt", normalMapTilt}, {"unsupported_map_slot", unsupportedMapSlot}, {"converted_copies_swept", convertedCopiesAreSwept}, {"gpu_timer_covers_shadows", gpuTimerCoversShadows}, {"overlay_over_frame", overlayOverFrame}, {"gpu_timer_is_opt_in", gpuTimerIsOptIn}, {"msaa_edges", msaaEdges}, {"shadow_camera_layers", shadowCameraLayers}, {"map_sampleability_changes", mapSampleabilityChanges}, {"batch_caches_stay_put", batchCachesStayPut}, {"frustum_culling", frustumCulling},
             {"shadow_caster_frustum_culling", shadowCasterFrustumCulling}, {"shadow_lights_follow_hierarchy", shadowLightsFollowHierarchy})






