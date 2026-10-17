#pragma once
// The native twins of three-native/tests/compatibility/render/tsl-programs.js: the TSL program a
// render fixture's `tsl` op names, authored with the native TSL builder, applied to the bound
// material (and any GPU work it needs) just before the frame is drawn.

#include "engine/abi/binding.h"
#include "engine/abi/tsl_call.h"
#include "probes.h"
#include "engine/renderer/compute.h"
#include "engine/renderer/renderer.h"
#include "engine/renderer/post/traa.h"
#include "engine/scene/material.h"
#include "engine/scene/camera.h"
#include "engine/scene/lights.h"
#include "engine/shader/tsl/tsl.h"
#include "engine/shader/graph/post_effects.h"
#include "engine/world/particles/gpu_particles.h"
#include "engine/world/fluids/fluid_particles.h"
#include "engine/scene/nodes.h"
#include "engine/animation/skinning/skeleton.h"

#include <functional>
#include <cstdlib>
#include <memory>
#include <string>
#include <tuple>
#include <vector>

namespace tn::fixture {

namespace tsl_detail {

inline constexpr uint32_t kGridCount = 10000;

inline engine::Material* materialOf(binding::Object& object) {
    if (!binding::isMaterialClass(object.cls)) return nullptr;
    return static_cast<engine::Material*>(object.ptr.get());
}

/** The JS programs' dataTexture(): RGBA8, linear filtering, texels from `texel(x, y)`. */
template <typename Texel>
std::shared_ptr<engine::DataTexture> dataTexture(uint32_t width, uint32_t height, Texel texel) {
    auto map = std::make_shared<engine::DataTexture>();
    map->width = width; map->height = height; map->data.resize(std::size_t(width) * height * 4);
    for (uint32_t y = 0; y < height; ++y) for (uint32_t x = 0; x < width; ++x) {
        const auto rgb = texel(x, y);
        const auto at = (std::size_t(y) * width + x) * 4;
        map->data[at] = rgb[0]; map->data[at + 1] = rgb[1]; map->data[at + 2] = rgb[2]; map->data[at + 3] = 255;
    }
    map->magFilter = static_cast<uint16_t>(engine::TextureFilter::Linear);
    map->minFilter = static_cast<uint16_t>(engine::TextureFilter::Linear);
    map->needsUpdate();
    return map;
}

/** The equirectangular sky of the JS programs' equirectSky(): asymmetric bands. */
inline std::shared_ptr<engine::DataTexture> equirectSky() {
    auto sky = std::make_shared<engine::DataTexture>();
    sky->width = 128; sky->height = 64; sky->data.resize(128 * 64 * 4);
    for (uint32_t y = 0; y < 64; ++y) for (uint32_t x = 0; x < 128; ++x) {
        const auto at = (y * 128 + x) * 4;
        sky->data[at] = 20 + (x * 160) % 220;
        sky->data[at + 1] = 30 + y * 180 / 64;
        sky->data[at + 2] = 220 - x * 150 / 128;
        sky->data[at + 3] = 255;
    }
    sky->mapping = 303; sky->colorSpace = engine::TextureColorSpace::SRGB;
    sky->magFilter = static_cast<uint16_t>(engine::TextureFilter::Linear);
    sky->minFilter = static_cast<uint16_t>(engine::TextureFilter::LinearMipmapLinear);
    sky->needsUpdate();
    return sky;
}

/** The JS programs' checker(): 8 x 8, nearest-filtered, texels 255 and 64 alternating in r, g, b. */
inline std::shared_ptr<engine::DataTexture> checker() {
    auto map = std::make_shared<engine::DataTexture>();
    map->width = 8; map->height = 8; map->data.resize(8 * 8 * 4);
    for (uint32_t i = 0; i < 64; ++i) {
        const uint8_t value = ((i % 8) + i / 8) % 2 ? 255 : 64;
        map->data[i * 4] = map->data[i * 4 + 1] = map->data[i * 4 + 2] = value;
        map->data[i * 4 + 3] = 255;
    }
    map->magFilter = map->minFilter = static_cast<uint16_t>(engine::TextureFilter::Nearest);
    map->needsUpdate();
    return map;
}

/** PRD-513: a compute pass writes the grid; the positionNode places instance i at entry i. */
inline std::string storageInstances(engine::Material& material, engine::Renderer& renderer, WGPUDevice device) {
    using namespace engine::shader;
    using namespace engine::shader::tsl;
    Program kernel(Stage::Compute);
    {
        Build build(kernel);
        const Storage positions = storage("positions", Type::vec(4));
        const Node time = uniform("time", Type::f32());
        If(instanceIndex().lessThan(uint_(kGridCount)), [&] {
            const Node row = instanceIndex().div(uint_(100));
            const Node column = float_(instanceIndex().sub(row.mul(uint_(100))));
            positions.element(instanceIndex())
                .assign(vec4({column.mul(0.5), sin(column.mul(0.25).add(time)), float_(row).mul(0.5), 1}));
        });
    }
    engine::GpuResources& gpu = renderer.gpu();
    engine::ComputePass pass(device, gpu, kernel);
    if (!kernel.ok() || !pass.error().empty()) return "storage-instances: " + pass.error();
    const uint64_t bytes = uint64_t{kGridCount} * 16;
    const engine::Handle buffer =
        gpu.createBuffer(bytes, WGPUBufferUsage_Storage | WGPUBufferUsage_CopySrc | WGPUBufferUsage_CopyDst);
    WGPUCommandEncoderDescriptor encoderDesc = {};
    WGPUCommandEncoder encoder = wgpuDeviceCreateCommandEncoder(device, &encoderDesc);
    const engine::Handle bound[] = {buffer};
    if (!pass.dispatch(encoder, bound, kGridCount, {{"time", 0.75}})) return "storage-instances: " + pass.error();
    WGPUCommandBufferDescriptor commandDesc = {};
    gpu.submit(wgpuCommandEncoderFinish(encoder, &commandDesc));
    wgpuCommandEncoderRelease(encoder);
    renderer.setStorage("positions", buffer, bytes);
    material.positionNode = std::make_shared<PositionNode>(PositionNode{
        "storage-instances", [](Program& vertex, ExprId position) {
            Build build(vertex);
            const Storage positions = storage("positions", Type::vec(4));
            return Node(position).add(Node(positions.element(instanceIndex())).xyz()).id;
        }});
    return "";
}

inline std::string particleSprites(binding::Object& object, engine::Renderer& renderer, WGPUDevice device,
                                   std::vector<std::shared_ptr<void>>& resources, bool fluid) {
    using namespace engine::shader;
    using namespace engine::shader::tsl;
    if (object.cls != "Sprite") return "particle fixture needs a Sprite";
    auto& sprite = *static_cast<engine::Sprite*>(object.ptr.get());
    if (!sprite.material || !sprite.material->spriteMaterial) return "particle fixture needs the game sprite material";
    constexpr uint32_t amount = 12;
    constexpr int ticks = 10;
    const auto initialPosition = [] {
        const Node row = instanceIndex().div(uint_(4));
        const Node col = instanceIndex().sub(row.mul(uint_(4)));
        const Node mod3 = instanceIndex().sub(instanceIndex().div(uint_(3)).mul(uint_(3)));
        return vec3({float_(col).sub(1.5).mul(1.1), float_(row).sub(1).mul(0.85), float_(mod3).sub(1).mul(0.2)});
    };
    engine::GpuResources& gpu = renderer.gpu();
    WGPUCommandEncoderDescriptor desc = {};
    WGPUCommandEncoder encoder = wgpuDeviceCreateCommandEncoder(device, &desc);
    engine::Handle positions;
    uint64_t bytes = amount * 16;
    if (!fluid) {
        auto particles = std::make_shared<engine::world::GpuParticles3D>(device, gpu,
            engine::world::GpuParticles3D::Options{amount,
                [&](Storage p, Storage v) {
                    p.element(instanceIndex()).assign(initialPosition());
                    v.element(instanceIndex()).assign(vec3({0.1, 0.25, -0.08}));
                },
                [](Storage p, Storage v) {
                    const Node velocity = v.element(instanceIndex());
                    p.element(instanceIndex()).assign(Node(p.element(instanceIndex())).add(velocity.mul(1.0 / 60)));
                    v.element(instanceIndex()).assign(velocity.add(vec3({0, -1.2 / 60, 0})));
                }, {}});
        if (!particles->error().empty() || !particles->attach(encoder)) {
            wgpuCommandEncoderRelease(encoder);
            return "particles-sprite: " + particles->error();
        }
        for (int tick = 0; tick < ticks; ++tick) if (!particles->process(encoder)) {
            wgpuCommandEncoderRelease(encoder); return "particles-sprite: " + particles->error();
        }
        positions = particles->positions();
        resources.push_back(std::move(particles)); // lives through draw/readback, before renderer teardown
    } else {
        engine::world::FluidParticles3D::Options options;
        options.capacity = amount; options.min = {-1, -1, -1}; options.max = {1, 1, 1}; options.voxelSize = 0.25;
        auto particles = std::make_shared<engine::world::FluidParticles3D>(device, gpu, options);
        if (!particles->error().empty()) { wgpuCommandEncoderRelease(encoder); return particles->error(); }
        for (uint32_t i = 0; i < amount; ++i) {
            if (!particles->emit({(int(i % 3) - 1) * 0.1, (int(i / 3 % 2) - 0.5) * 0.1, (int(i / 6) - 0.5) * 0.1},
                {0.1 + (i % 3) * 0.07, 0.25, -0.08 + (i / 6) * 0.1})) {
                wgpuCommandEncoderRelease(encoder); return "fluid-particles emission refused";
            }
        }
        for (int tick = 0; tick < ticks; ++tick) if (!particles->process()) {
            wgpuCommandEncoderRelease(encoder); return particles->error();
        }
        positions = particles->positions();
        resources.push_back(std::move(particles));
    }
    WGPUCommandBufferDescriptor commands = {};
    gpu.submit(wgpuCommandEncoderFinish(encoder, &commands));
    wgpuCommandEncoderRelease(encoder);
    renderer.setStorage("positions", positions, bytes);
    sprite.count = amount;
    sprite.material->positionNode = std::make_shared<PositionNode>(PositionNode{
        fluid ? "fluid-particles" : "particles-sprite", [fluid](Program& vertex, ExprId) {
            Build build(vertex);
            return Node(storage("positions", Type::vec(fluid ? 4 : 3)).element(instanceIndex())).xyz().id;
        }});
    namespace g = engine::shader::graph;
    sprite.material->nodes.colorNode = g::vec4({g::uv(), g::float_(0.35), g::float_(1)});
    sprite.material->nodes.opacityNode = g::float_(0.8);
    sprite.material->needsUpdate();
    return "";
}

/** PRD-512: a plane bent by a sine wave along its own z. */
inline std::string wavePlane(engine::Material& material) {
    using namespace engine::shader;
    using namespace engine::shader::tsl;
    material.positionNode = std::make_shared<PositionNode>(PositionNode{
        "wave-plane", [](Program& vertex, ExprId position) {
            Build build(vertex);
            const Node local(position);
            return local.add(vec3({0, 0, sin(local.x().mul(2)).mul(0.4)})).id;
        }});
    return "";
}

/**
 * PRD-513: a post pass over the scene texture: a 2-texel chromatic split (texel centres, so the
 * sampler's filter cannot matter) and a radial vignette, before tone mapping.
 */
inline void postChromatic(engine::Renderer& renderer) {
    using namespace engine::shader;
    using namespace engine::shader::tsl;
    renderer.setPostNode(std::make_shared<PostNode>(PostNode{
        "post-chromatic", [](Program& fragment, uint32_t scene, ExprId screenUv) {
            Build build(fragment);
            const Node uv(screenUv);
            const Node offset = vec2({2.0 / 320.0, 0});
            const Node r = sample(scene, uv.add(offset)).x();
            const Node g = sample(scene, uv).y();
            const Node b = sample(scene, uv.sub(offset)).z();
            const Node vignette = float_(1).sub(length(uv.sub(0.5)).mul(0.6));
            return vec4({vec3({r, g, b}).mul(vignette), 1}).id;
        }}));
}

/**
 * PRD-531 slice 4: three r185's post addons built live (the graph a game's `ao()`, `denoise()`, `bloom()`
 * and `smaa()` make on V8), over the scene pass's colour, depth and normal. `post-template-high` is
 * the minimal template's high-tier chain, stage for stage: exposure, GTAO with its denoise, bloom,
 * vignette, then SMAA under the reversible Karis squeeze.
 */
inline std::string postAddons(const std::string& program, engine::Renderer& renderer,
                              const std::function<std::string(uint32_t, uint32_t)>& renderAt, uint32_t width,
                              uint32_t height) {
    namespace g = engine::shader::graph;
    const auto colour = g::texture("scene", g::uv()), depth = g::texture("depth", g::uv()),
               normal = g::texture("normal", g::uv());
    const auto rgbMax = [](const g::Node& c) {
        return g::max(g::swizzle(c, "x"), g::max(g::swizzle(c, "y"), g::swizzle(c, "z")));
    };
    const auto occlusion = [&](const g::Node& input) {
        auto contact = g::gtaoEffect(depth, normal);
        contact->parameters["radius"] = {0.35f};
        const auto denoised = g::effectNode(g::denoiseEffect(g::effectNode(contact), depth, normal, 1));
        return g::mul(input, g::swizzle(denoised, "x"));
    };
    const auto antialias = [&](const g::Node& input) {
        const auto squeezed = g::div(input, g::add(rgbMax(input), g::float_(1)));
        const auto filtered = g::effectNode(g::smaaEffect(squeezed));
        return g::div(filtered, g::max(g::sub(g::float_(1), rgbMax(filtered)), g::float_(1e-4)));
    };
    const auto rtt = [](const g::Node& source) {
        auto target = std::make_shared<g::NodeData>();
        target->kind = g::Kind::RenderTexture; target->name = "fixture_rtt_" + std::to_string(reinterpret_cast<uintptr_t>(source.get()));
        target->type = engine::shader::Type::vec(4); target->args = {source, g::uv()};
        return g::Node(target);
    };
    g::Node root;
    if (program == "post-ao") root = occlusion(colour);
    else if (program == "post-ao-raw") {
        auto contact = g::gtaoEffect(depth, normal);
        contact->parameters["radius"] = {0.35f};
        root = g::mul(colour, g::swizzle(g::effectNode(contact), "x"));
    }
    else if (program == "post-bloom") root = g::add(colour, g::bloom(colour, 0.7, 0.5, 0.2));
    else if (program == "post-live-parameters" || program == "post-uniform-write") {
        // Written after the first frame through the calls both language back ends make
        // (`ao.resolutionScale = s`, `bloomNode.strength.value = v`, `uniform.value = v`).
        std::function<void()> afterFirstFrame;
        if (program == "post-live-parameters") {
            auto effect = g::gtaoEffect(depth, normal);
            effect->parameters["radius"] = {0.35f};
            const auto contact = g::effectNode(effect);
            const auto glow = g::bloom(colour, 0.7, 0.5, 0.2);
            root = g::add(g::mul(colour, g::swizzle(contact, "x")), glow);
            afterFirstFrame = [contact, glow] {
                for (const auto& [node, name, value] : {std::tuple{contact, "resolutionScale", 0.5},
                                                        {glow, "strength", 0.3}, {glow, "radius", 0.9},
                                                        {glow, "threshold", 0.8}})
                    abi::tslEffectParameter(node, name, &value);
            };
        } else {
            const auto gain = g::uniform("fixtureGain", engine::shader::Type::f32(), {0.25f});
            const auto lift = g::uniform("fixtureLift", engine::shader::Type::f32(), {0.4f});
            root = g::mul(rtt(g::mul(colour, lift)), gain);
            afterFirstFrame = [gain, lift] {
                const double one = 1, more = 1.5;
                abi::tslSetUniform(gain, &one, 1);
                abi::tslSetUniform(lift, &more, 1);
            };
        }
        renderer.setPostGraph(root);
        try {
            if (const auto failed = renderAt(width, height); !failed.empty()) return failed;
            afterFirstFrame();
        } catch (const std::exception& error) {
            return error.what();
        }
        return "";
    }
    else if (program == "post-smaa") root = antialias(colour);
    else if (program == "post-template-high") {
        auto input = occlusion(g::mul(colour, g::float_(0.62)));
        input = g::add(input, g::bloom(rtt(input), 0.22, 0.6, 1));
        const auto radius = g::mul(g::length(g::mul(g::sub(g::uv(), g::vec2({g::float_(0.5), g::float_(0.5)})),
                                                    g::vec2({g::float_(1.78), g::float_(1)}))), g::float_(1.04));
        const auto fall = g::mul(g::smoothstep(g::float_(0.55), g::float_(1.02), radius), g::float_(0.22));
        root = antialias(g::mul(input, g::sub(g::float_(1), fall)));
    } else return "TN_FIXTURE_POST_UNKNOWN: " + program;
    renderer.setPostGraph(root);
    return "";
}

}  // namespace tsl_detail

/**
 * Applies the named program; empty on success, else why not (an unknown name included).
 * `renderAt(width, height)` draws the fixture's scene once at that size, for a program that
 * renders before the captured frame (a resize).
 */
inline std::string applyTslProgram(const std::string& program, binding::Object& object, engine::Renderer& renderer,
                                   WGPUDevice device, const std::function<std::string(uint32_t, uint32_t)>& renderAt,
                                   std::vector<std::shared_ptr<void>>& resources, engine::Camera* camera = nullptr) {
    if (program == "sky-equirect") {
        if (object.cls != "Scene") return "TN_FIXTURE_SKY_INVALID: requires scene";
        auto& scene = *static_cast<engine::Scene*>(object.ptr.get());
        auto sky = tsl_detail::equirectSky();
        scene.backgroundTexture = scene.environment = sky;
        scene.backgroundIntensity = scene.environmentIntensity = 2.5;
        scene.backgroundRotation.set(0.1, 0.4, 0); scene.environmentRotation.set(0.1, 0.4, 0);
        return "";
    }
    if (program == "tsl-normal-world-doubleside") {
        // normalWorld through the shared TSL table, on the material's normal (r185 NodeMaterial.setupNormal).
        if (object.cls != "Scene") return "TN_FIXTURE_NORMAL_WORLD_INVALID: requires scene";
        auto& scene = *static_cast<engine::Scene*>(object.ptr.get());
        namespace g = engine::shader::graph;
        uint64_t serial = 0;
        const auto shade = g::add(g::mul(abi::tslCall("normalWorld", nullptr, {}, serial), g::float_(0.5)), g::float_(0.5));
        const auto material = [&scene](const char* name) {
            auto* mesh = dynamic_cast<engine::Mesh*>(scene.getObjectByName(name));
            return mesh ? mesh->material.get() : nullptr;
        };
        auto *front = material("front"), *back = material("back"), *tilted = material("tilted"), *mapped = material("mapped");
        if (!front || !back || !tilted || !mapped) return "TN_FIXTURE_NORMAL_WORLD_INVALID: planes";
        front->nodes.colorNode = back->nodes.colorNode = g::vec4({shade, g::float_(1)});
        tilted->nodes.normalNode = g::normalize(g::vec3({g::float_(0.6), g::float_(0), g::float_(0.8)}));
        tilted->nodes.emissiveNode = mapped->nodes.emissiveNode = shade;
        using Rgb = std::array<uint8_t, 3>;
        mapped->maps["normalMap"] = tsl_detail::dataTexture(4, 4, [](uint32_t, uint32_t) { return Rgb{200, 128, 230}; });
        for (auto* m : {front, back, tilted, mapped}) m->needsUpdate();
        return "";
    }
    if (program == "tsl-transform-normal-to-view") {
        // r185's transformNormalToView(normalGeometry) through the shared TSL table.
        if (object.cls != "Scene") return "TN_FIXTURE_NORMAL_TO_VIEW_INVALID: requires scene";
        auto& scene = *static_cast<engine::Scene*>(object.ptr.get());
        namespace g = engine::shader::graph;
        uint64_t serial = 0;
        const auto normal = abi::tslCall("normalGeometry", nullptr, {}, serial);
        const auto toView = abi::tslCall("transformNormalToView", nullptr, {abi::TslArg::of(normal)}, serial);
        const auto shade = g::vec4({g::add(g::mul(toView, g::float_(0.5)), g::float_(0.5)), g::float_(1)});
        for (const char* name : {"box", "stretched"}) {
            auto* mesh = dynamic_cast<engine::Mesh*>(scene.getObjectByName(name));
            if (!mesh || !mesh->material) return "TN_FIXTURE_NORMAL_TO_VIEW_INVALID: meshes";
            mesh->material->nodes.colorNode = shade;
            mesh->material->needsUpdate();
        }
        return "";
    }
    if (program == "tsl-view-geometry-varyings") {
        // r185's positionViewDirection, normalWorldGeometry and depth fragment varyings, through the shared TSL table.
        if (object.cls != "Scene") return "TN_FIXTURE_VARYINGS_INVALID: requires scene";
        auto& scene = *static_cast<engine::Scene*>(object.ptr.get());
        namespace g = engine::shader::graph;
        uint64_t serial = 0;
        const auto tsl = [&serial](const char* name) { return abi::tslCall(name, nullptr, {}, serial); };
        const auto half = [](const g::Node& n) { return g::add(g::mul(n, g::float_(0.5)), g::float_(0.5)); };
        const auto material = [&scene](const char* name) {
            auto* mesh = dynamic_cast<engine::Mesh*>(scene.getObjectByName(name));
            return mesh ? mesh->material.get() : nullptr;
        };
        auto *sphere = material("sphere"), *box = material("box"), *stretched = material("stretched"),
             *mapped = material("mapped"), *depth = material("depth");
        if (!sphere || !box || !stretched || !mapped || !depth) return "TN_FIXTURE_VARYINGS_INVALID: meshes";
        sphere->nodes.colorNode = g::vec4({half(tsl("positionViewDirection")), g::float_(1)});
        const auto geometryShade = half(tsl("normalWorldGeometry"));
        box->nodes.colorNode = stretched->nodes.colorNode = g::vec4({geometryShade, g::float_(1)});
        mapped->nodes.emissiveNode = geometryShade;
        using Rgb = std::array<uint8_t, 3>;
        mapped->maps["normalMap"] = tsl_detail::dataTexture(4, 4, [](uint32_t, uint32_t) { return Rgb{200, 128, 230}; });
        const auto shade = g::mul(g::sub(g::float_(1), tsl("depth")), g::float_(25));
        depth->nodes.colorNode = g::vec4({g::vec3({shade, shade, shade}), g::float_(1)});
        for (auto* m : {sphere, box, stretched, mapped, depth}) m->needsUpdate();
        return "";
    }
    if (program == "instanced-geometry") {
        if (object.cls != "Scene") return "TN_FIXTURE_INSTANCED_INVALID: requires scene";
        auto& scene = *static_cast<engine::Scene*>(object.ptr.get());
        auto* quads = dynamic_cast<engine::Mesh*>(scene.getObjectByName("quads"));
        if (!quads || !quads->material) return "TN_FIXTURE_INSTANCED_INVALID: quads/material";
        namespace g = engine::shader::graph;
        // Through the shared TSL table, as V8 and Wasm build it.
        uint64_t serial = 0;
        const auto tsl = [&serial](const char* name, std::vector<abi::TslArg> args) {
            return abi::tslCall(name, nullptr, args, serial);
        };
        g::Node view;
        for (auto& [label, node] : abi::tslConstants())
            if (label == "cameraViewMatrix") view = node;
        const auto offset = tsl("attribute", {abi::TslArg::of(std::string("aOffset")), abi::TslArg::of(std::string("vec3"))});
        const auto tint = tsl("attribute", {abi::TslArg::of(std::string("aTint")), abi::TslArg::of(std::string("vec3"))});
        const auto local = g::add(g::mul(g::positionLocal(), g::float_(0.4f)), offset);
        quads->material->nodes.vertexNode = g::mul(tsl("cameraProjectionMatrix", {}), g::mul(view, g::vec4({local, g::float_(1)})));
        quads->material->nodes.colorNode = g::vec4({tint, g::float_(1)});
        quads->material->needsUpdate();
        return "";
    }
    if (program == "batched-mesh") {
        // The JS program's BatchedMesh through the engine class: two geometries, five instances.
        if (object.cls != "Scene") return "TN_FIXTURE_BATCHED_INVALID: requires scene";
        auto& scene = *static_cast<engine::Scene*>(object.ptr.get());
        auto material = std::make_shared<engine::Material>(engine::MaterialType::Standard);
        material->roughness = 0.5;
        auto batch = std::make_shared<engine::BatchedMesh>(8, 2000, 4000, material);
        // Non-indexed, as the JS program: r185's WebGPU BatchedMesh draws a second indexed geometry from
        // index 0 (its golden showed the box inside each sphere), so the comparison avoids that path.
        const uint32_t box = batch->addGeometry(*engine::makeBoxGeometry(0.8, 0.8, 0.8)->toNonIndexed());
        const uint32_t ball = batch->addGeometry(*engine::makeSphereGeometry(0.5, 16, 8)->toNonIndexed());
        const auto place = [&](uint32_t geometry, double x, double y, double r, double g, double b) {
            const uint32_t id = batch->addInstance(geometry);
            engine::Matrix4 matrix;
            matrix.makeRotationZ(x * 0.3).setPosition(engine::Vector3(x, y, 0));
            batch->setMatrixAt(id, matrix);
            batch->setColorAt(id, engine::Color().setRGB(r, g, b));
            return id;
        };
        place(box, -1.5, 0.6, 1, 0.25, 0.25);
        place(box, 0, 0.6, 0.25, 1, 0.25);
        place(box, 1.5, 0.6, 0.25, 0.25, 1);
        place(ball, -0.75, -0.7, 1, 1, 0.25);
        place(ball, 0.75, -0.7, 1, 0.25, 1);
        batch->setVisibleAt(place(ball, 2.2, -0.7, 0.25, 1, 1), false);
        auto sun = std::make_shared<engine::DirectionalLight>(engine::Color(1, 1, 1), 2.5);
        sun->position.set(3, 4, 5);
        auto ambient = std::make_shared<engine::AmbientLight>(engine::Color(1, 1, 1), 0.4);
        scene.add(*batch);
        scene.add(*sun);
        scene.add(*ambient);
        resources.insert(resources.end(), {batch, sun, ambient});
        return "";
    }
    if (program == "shadow-billboard") {
        // A camera-facing card through the shared TSL table: cameraWorldMatrix's right and up axes.
        if (object.cls != "Scene") return "TN_FIXTURE_BILLBOARD_INVALID: requires scene";
        auto& scene = *static_cast<engine::Scene*>(object.ptr.get());
        auto* card = dynamic_cast<engine::Mesh*>(scene.getObjectByName("card"));
        if (!card || !card->material) return "TN_FIXTURE_BILLBOARD_INVALID: card";
        namespace g = engine::shader::graph;
        g::Node world;
        for (auto& [label, node] : abi::tslConstants())
            if (label == "cameraWorldMatrix") world = node;
        const auto axis = [&](float x, float y) {
            return g::swizzle(g::mul(world, g::vec4({g::float_(x), g::float_(y), g::float_(0), g::float_(0)})), "xyz");
        };
        const auto local = g::positionLocal();
        card->material->nodes.positionNode = g::add(g::mul(axis(1, 0), g::swizzle(local, "x")), g::mul(axis(0, 1), g::swizzle(local, "y")));
        card->material->needsUpdate();
        return "";
    }
    if (program == "skinned-clone") {
        // SkeletonUtils.clone, as the binding calls it: the copy's own bones bend its skin.
        if (object.cls != "Scene") return "TN_FIXTURE_SKINNED_CLONE: requires scene";
        auto& scene = *static_cast<engine::Scene*>(object.ptr.get());
        const engine::Object3D* skin = scene.getObjectByName("skin");
        if (!skin) return "TN_FIXTURE_SKINNED_CLONE: skin";
        std::string error;
        const auto copy = engine::cloneSkeleton(*skin, error);
        auto* skinned = dynamic_cast<engine::SkinnedMesh*>(copy.get());
        if (!skinned || !skinned->skeleton) return "TN_FIXTURE_SKINNED_CLONE: " + error;
        skinned->position.x = 1.2;
        for (const std::size_t i : {2u, 3u}) {
            engine::Bone* bone = skinned->skeleton->bone(i);
            if (!bone) return "TN_FIXTURE_SKINNED_CLONE: bone";
            bone->rotation.z = 0.5;
        }
        scene.add(*copy);
        resources.push_back(copy);
        return "";
    }
    if (program == "tsl-viewport-linear-depth") {
        if (object.cls != "Scene") return "TN_FIXTURE_VIEWPORT_INVALID: requires scene";
        auto& scene = *static_cast<engine::Scene*>(object.ptr.get());
        auto* water = dynamic_cast<engine::Mesh*>(scene.getObjectByName("water"));
        if (!water || !water->material) return "TN_FIXTURE_VIEWPORT_INVALID: water/material";
        namespace g = engine::shader::graph;
        uint64_t serial = 0;
        g::Node viewport, nearPlane, farPlane;
        for (auto& [label, node] : abi::tslConstants()) {
            if (label == "viewportLinearDepth") viewport = node;
            if (label == "cameraNear") nearPlane = node;
            if (label == "cameraFar") farPlane = node;
        }
        if (!viewport || !nearPlane || !farPlane) return "TN_FIXTURE_VIEWPORT_INVALID: depth constants";
        const auto own = abi::tslCall("linearDepth", nullptr, {}, serial);
        water->material->nodes.colorNode = g::vec4({g::mul(viewport, g::float_(4)), g::mul(own, g::float_(4)),
            g::add(g::mul(nearPlane, g::float_(5)), g::mul(farPlane, g::float_(0.005f))), g::float_(1)});
        water->material->needsUpdate();
        return "";
    }
    if (program == "viewport-textures") {
        if (object.cls != "Scene") return "TN_FIXTURE_VIEWPORT_INVALID: requires scene";
        auto& scene = *static_cast<engine::Scene*>(object.ptr.get());
        auto* water = dynamic_cast<engine::Mesh*>(scene.getObjectByName("water"));
        if (!water || !water->material) return "TN_FIXTURE_VIEWPORT_INVALID: water/material";
        namespace g = engine::shader::graph;
        // Through the shared TSL table, as V8 and Wasm build it.
        uint64_t serial = 0;
        const auto behind = abi::tslCall("viewportSharedTexture", nullptr,
            {abi::TslArg::of(g::add(g::screenUV(), g::vec2({g::float_(0.02f), g::float_(0)})))}, serial);
        g::Node linear;
        for (auto& [label, node] : abi::tslConstants())
            if (label == "viewportLinearDepth") linear = node;
        const auto own = abi::tslCall("linearDepth", nullptr, {}, serial);
        const auto offsetDepth = abi::tslCall("viewportDepthTexture", nullptr,
            {abi::TslArg::of(g::add(g::screenUV(), g::vec2({g::float_(0.02f), g::float_(0)})))}, serial);
        const auto offsetLinear = abi::tslCall("linearDepth", nullptr, {abi::TslArg::of(offsetDepth)}, serial);
        water->material->nodes.colorNode = g::vec4({g::add(g::add(g::mul(g::swizzle(behind, "xyz"),
            g::vec3({g::float_(0.5f), g::float_(0.8f), g::float_(1)})),
            g::vec3({g::float_(0), g::float_(0), g::mul(g::sub(linear, own), g::float_(8))})),
            g::vec3({g::mul(offsetLinear, g::float_(0.2f)), g::float_(0), g::float_(0)})), g::float_(1)});
        water->material->needsUpdate();
        return "";
    }
    if (program == "storage-attribute") {
        if (object.cls != "Mesh") return "TN_FIXTURE_STORAGE_INVALID: requires mesh";
        auto& mesh = *static_cast<engine::Mesh*>(object.ptr.get());
        if (!mesh.material) return "TN_FIXTURE_STORAGE_INVALID: material";
        namespace g = engine::shader::graph;
        auto geometry = std::make_shared<engine::BufferGeometry>();  // an InstancedBufferGeometry
        geometry->type = "InstancedBufferGeometry";
        geometry->instanced = true;
        geometry->setAttribute("position", engine::BufferAttribute::fromFloats(
            {-0.25, 0.25, 0, 0.25, 0.25, 0, -0.25, -0.25, 0, 0.25, -0.25, 0}, 3));
        geometry->setIndexFromArray({0, 2, 1, 2, 3, 1});
        geometry->instanceCount = 5;
        mesh.geometry = geometry;
        auto palette = engine::BufferAttribute::fromFloats(
            {-1, 0.5, 0, 0, 0, 0.5, 0, 0, 1, 0.5, 0, 0, -1, -0.5, 0, 0, 0, -0.5, 0, 0}, 4);
        resources.push_back(palette);
        uint64_t serial = 0;
        const auto offset = abi::tslCall("storage:object", nullptr,
            {abi::TslArg::objectOf("BufferAttribute", palette), abi::TslArg::of(std::string("vec4")),
             abi::TslArg::of(std::string()), abi::TslArg::of(g::instanceIndex())}, serial);
        mesh.material->nodes.positionNode = g::add(g::positionLocal(), g::swizzle(offset, "xyz"));
        mesh.material->nodes.colorNode = g::vec4({g::float_(1), g::float_(0.6), g::float_(0.2), g::float_(1)});
        mesh.material->needsUpdate();
        return "";
    }
    if (program == "reflector-plane") {
        if (object.cls != "Scene") return "TN_FIXTURE_REFLECTOR_INVALID: requires scene";
        auto& scene = *static_cast<engine::Scene*>(object.ptr.get());
        auto* floor = dynamic_cast<engine::Mesh*>(scene.getObjectByName("mirror"));
        if (!floor || !floor->material) return "TN_FIXTURE_REFLECTOR_INVALID: mirror/material";
        namespace g = engine::shader::graph;
        auto target = std::make_shared<engine::Object3D>();
        auto camera = std::make_shared<engine::PerspectiveCamera>();
        target->rotateX(-3.141592653589793 / 2);
        scene.add(*target);
        resources.push_back(target);
        resources.push_back(camera);
        uint64_t serial = 0;
        const auto mirror = abi::tslCall("reflector", nullptr,
            {abi::TslArg::objectOf("Object3D", target), abi::TslArg::objectOf("PerspectiveCamera", camera),
             abi::TslArg::of(1.0), abi::TslArg::of(1.0), abi::TslArg::of(0.0), abi::TslArg::of(0.0), abi::TslArg::of(0.0)},
            serial);
        floor->material->nodes.colorNode = g::vec4({g::mul(g::swizzle(mirror, "xyz"),
            g::vec3({g::float_(0.75), g::float_(0.85), g::float_(1)})), g::float_(1)});
        floor->material->needsUpdate();
        return "";
    }
    if (program == "traa-history" || program == "history-cut") {
        if (object.cls != "Scene" || !camera) return "TN_FIXTURE_TRAA_INVALID: scene/camera";
        auto* scene = static_cast<engine::Scene*>(object.ptr.get());
        auto* mesh = dynamic_cast<engine::Mesh*>(scene->getObjectByName("temporalPattern"));
        if (!mesh || !mesh->material) return "TN_FIXTURE_TRAA_INVALID: temporalPattern/material";
        namespace g = engine::shader::graph;
        const auto pattern = [&](float phase) {
            const auto value = g::mul(g::sin(g::add(g::mul(g::swizzle(g::uv(), "x"), g::float_(900)),
                g::uniform("temporalPhase", engine::shader::Type::f32(), {phase}))),
                g::sin(g::mul(g::swizzle(g::uv(), "y"), g::float_(700))));
            mesh->material->nodes.colorNode = g::vec4({g::vec3({g::add(g::mul(value, g::float_(0.45)), g::float_(0.5))}), g::float_(1)});
            mesh->material->needsUpdate();
        };
        pattern(0);
        renderer.setTraa(engine::TraaOptions{});
        if (const char* directory = std::getenv("TN_TRAA_DUMP");
            program == "traa-history" && directory && *directory)
            renderer.traaDebugPass()->enableDebugDump();
        const auto draw = [&]() { camera->updateMatrixWorld(true); return renderAt(renderer.width(), renderer.height()); };
        for (int i = 0; i < 20; ++i) {
            mesh->position.x = i * 0.002;
            if (const auto error = draw(); !error.empty()) return error;
        }
        camera->position.z = 5.01; camera->updateMatrixWorld(true);
        pattern(float(3.141592653589793));
        renderer.cutHistory();
        const int steps = program == "history-cut" ? 0 : 3;
        for (int i = 0; i < steps; ++i) {
            mesh->position.x = (20 + i) * 0.002;
            if (const auto error = draw(); !error.empty()) return error;
        }
        mesh->position.x = (20 + steps) * 0.002;
        return "";
    }
    if (program == "probes" || program == "probes-baked" || program == "probes-relight") {
        if (object.cls != "Scene") return "TN_FIXTURE_PROBES_SCENE";
        const auto error = tsl_detail::probeFixture(program, *static_cast<engine::Scene*>(object.ptr.get()), renderer, renderAt);
        return error.empty() || error.starts_with("TN_FIXTURE_PROBES_")
                   ? error : "TN_FIXTURE_PROBES_FAILURE: " + error;
    }
    if (program == "particles-sprite" || program == "fluid-particles")
        return tsl_detail::particleSprites(object, renderer, device, resources, program == "fluid-particles");
    if (program == "vsm-basic" || program == "vsm-cut") {
        if (object.cls != "DirectionalLight" || !camera) return "TN_FIXTURE_VSM_INVALID: light/camera";
        engine::shadows::AtlasOptions options;
        options.clipExtents = {8, 24}; options.mapSize = 256; options.pageTexels = 64;
        options.lightDistance = 20; options.depthRange = 40; options.refreshStep = {0};
        renderer.setVirtualShadow(0, options);
        for (int i = 0; i < 2; ++i) {
            camera->updateMatrixWorld(true);
            if (const std::string error = renderAt(renderer.width(), renderer.height()); !error.empty()) return error;
        }
        if (program == "vsm-cut") {
            // Same eye/page keys, changed indices only: neither bounds nor position signatures
            // invalidate this cached shadow. Only the cut removes the box's broad ghost shadow.
            auto* light = static_cast<engine::DirectionalLight*>(object.ptr.get());
            auto* caster = light->parent ? dynamic_cast<engine::Mesh*>(light->parent->getObjectByName("cutCaster")) : nullptr;
            if (!caster || !caster->geometry || !caster->geometry->index) return "TN_FIXTURE_VSM_INVALID: cutCaster/index";
            caster->geometry->setIndexFromArray(std::vector<uint32_t>(caster->geometry->index->count(), 0));
            camera->lookAt(engine::Vector3(0, 0.4, 0)); camera->updateMatrixWorld(true);
            renderer.cutVirtualShadows();
        }
        return "";
    }
    if (program == "post-ao" || program == "post-ao-raw" || program == "post-bloom" || program == "post-smaa" ||
        program == "post-template-high" || program == "post-live-parameters" || program == "post-uniform-write")
        return tsl_detail::postAddons(program, renderer, renderAt, renderer.width(), renderer.height());
    if (program == "post-chromatic") {
        tsl_detail::postChromatic(renderer);
        return "";
    }
    if (program == "post-chromatic-resized") {
        // Drawn once at another size first, so the captured frame is the one after a resize.
        tsl_detail::postChromatic(renderer);
        return renderAt(200, 150);
    }
    engine::Material* material = tsl_detail::materialOf(object);
    if (material == nullptr) return "tsl " + program + ": " + object.cls + " is not a material";
    // PRD-531 slice 3: the upstream fixture programs above, built as native lazy graphs.
    namespace g = engine::shader::graph;
    using engine::shader::Type;
    const auto x = g::swizzle(g::uv(), "x"), y = g::swizzle(g::uv(), "y");
    if (program == "vsm-deformation") {
        material->nodes.positionNode = g::add(g::positionLocal(),
            g::vec3({g::float_(0), g::float_(0), g::mul(g::sin(g::mul(g::swizzle(g::positionLocal(), "x"), g::float_(2))), g::float_(0.4))}));
    } else if (program == "nodemat-color-uv") {
        material->nodes.colorNode = g::vec4({g::uv(), g::uniform("nodeTint", Type::f32(), {0.35f}), g::float_(1)});
    } else if (program == "materialx-noise") {
        // Through the shared TSL table, as V8 and Wasm build it (engine/abi/tsl_call.cpp).
        uint64_t serial = 0;
        const auto tsl = [&serial](const char* name, std::vector<abi::TslArg> args) {
            return abi::tslCall(name, nullptr, args, serial);
        };
        const auto node = [](g::Node value) { return abi::TslArg::of(std::move(value)); };
        const auto positionWorld = g::varying("positionWorld", Type::vec(3));
        const auto perlin3 = g::add(g::mul(tsl("mx_noise_float", {node(g::mul(positionWorld, g::float_(1.8)))}),
                                           g::float_(0.5)), g::float_(0.5));
        const auto perlin2 = tsl("mx_noise_float", {node(g::mul(g::uv(), g::float_(6))), abi::TslArg::of(0.8),
                                                    abi::TslArg::of(0.1)});
        const auto cells = tsl("mx_worley_noise_vec2", {node(g::mul(g::uv(), g::float_(5))), abi::TslArg::of(0.9)});
        const auto cells3 = tsl("mx_worley_noise_vec2", {node(g::mul(positionWorld, g::float_(2)))});
        material->nodes.colorNode = g::vec4({perlin3, g::add(perlin2, g::mul(g::swizzle(cells, "x"), g::float_(0.3))),
            g::mul(g::add(g::swizzle(cells, "y"), g::swizzle(cells3, "x")), g::float_(0.4)), g::float_(1)});
    } else if (program == "screen-uv") {
        uint64_t serial = 0;
        const auto screen = abi::tslCall("screenUV", nullptr, {}, serial);
        const abi::TslArg receiver = abi::TslArg::of(screen);
        const auto flipped = abi::tslCall("flipX", &receiver, {}, serial);
        material->nodes.colorNode = g::vec4({flipped, g::mul(g::swizzle(screen, "x"), g::swizzle(screen, "y")), g::float_(1)});
    } else if (program == "tsl-texture-object") {
        // Through the shared TSL table: texture(textureObject, uv) and .level(0), as V8 and Wasm build them.
        uint64_t serial = 0;
        using Rgb = std::array<uint8_t, 3>;
        const auto ramp = tsl_detail::dataTexture(8, 4, [](uint32_t tx, uint32_t ty) {
            return Rgb{uint8_t(tx * 36), uint8_t(ty * 80), uint8_t(200 - tx * 20)}; });
        const auto bumps = tsl_detail::dataTexture(8, 8, [](uint32_t tx, uint32_t ty) {
            return Rgb{uint8_t(((tx + ty) % 4) * 80), 0, 0}; });
        const auto sample = [&serial](std::shared_ptr<engine::DataTexture> map) {
            return abi::tslCall("texture", nullptr, {abi::TslArg::objectOf("DataTexture", std::move(map)), abi::TslArg::of(g::uv())}, serial);
        };
        const abi::TslArg bump = abi::TslArg::of(sample(bumps));
        const auto level = abi::tslCall("level", &bump, {abi::TslArg::of(0.0)}, serial);
        material->nodes.positionNode = g::add(g::positionLocal(),
            g::vec3({g::float_(0), g::float_(0), g::mul(g::swizzle(level, "x"), g::float_(0.4))}));
        material->nodes.colorNode = g::vec4({g::swizzle(sample(ramp), "xyz"), g::float_(1)});
    } else if (program == "tsl-stage-vertex-texture-level") {
        // A positionNode reads texture(object, uv) with no level and texture(object, uv).level(0).
        uint64_t serial = 0;
        using Rgb = std::array<uint8_t, 3>;
        const auto ramp = tsl_detail::dataTexture(8, 4, [](uint32_t tx, uint32_t ty) {
            return Rgb{uint8_t(tx * 36), uint8_t(ty * 80), uint8_t(200 - tx * 20)}; });
        const auto bumps = tsl_detail::dataTexture(8, 8, [](uint32_t tx, uint32_t ty) {
            return Rgb{uint8_t(((tx + ty) % 4) * 80), 0, 0}; });
        const auto waves = tsl_detail::dataTexture(8, 1, [](uint32_t tx, uint32_t) {
            return Rgb{0, uint8_t((tx % 2) * 255), 0}; });
        const auto sample = [&serial](std::shared_ptr<engine::DataTexture> map) {
            return abi::tslCall("texture", nullptr, {abi::TslArg::objectOf("DataTexture", std::move(map)), abi::TslArg::of(g::uv())}, serial);
        };
        const abi::TslArg wave = abi::TslArg::of(sample(waves));
        const auto level = abi::tslCall("level", &wave, {abi::TslArg::of(0.0)}, serial);
        material->nodes.positionNode = g::add(g::positionLocal(),
            g::vec3({g::float_(0), g::mul(g::swizzle(level, "y"), g::float_(0.3)), g::mul(g::swizzle(sample(bumps), "x"), g::float_(0.4))}));
        material->nodes.colorNode = g::vec4({g::swizzle(sample(ramp), "xyz"), g::float_(1)});
    } else if (program == "texture-data-3d") {
        // texture3D(volume, uvw) and texture3D(volume).sample(q) through the shared TSL table, as the
        // rain template's clouds sample their noise volume; q runs past 1 along W, which repeats.
        uint64_t serial = 0;
        auto volume = std::make_shared<engine::DataTexture>();
        volume->volume = true;
        volume->width = volume->height = volume->depth = 4;
        volume->data.resize(4 * 4 * 4 * 4);
        for (uint32_t z = 0; z < 4; ++z) for (uint32_t y = 0; y < 4; ++y) for (uint32_t x = 0; x < 4; ++x) {
            const auto at = ((z * 4 + y) * 4 + x) * 4;
            volume->data[at] = uint8_t(x * 80); volume->data[at + 1] = uint8_t(y * 80);
            volume->data[at + 2] = uint8_t(z * 80); volume->data[at + 3] = 255;
        }
        volume->magFilter = volume->minFilter = static_cast<uint16_t>(engine::TextureFilter::Linear);
        volume->wrapR = static_cast<uint16_t>(engine::TextureWrap::Repeat);
        volume->needsUpdate();
        const auto object = abi::TslArg::objectOf("Data3DTexture", volume);
        const auto u = g::swizzle(g::uv(), "x"), v = g::swizzle(g::uv(), "y");
        const auto slice = abi::tslCall("texture3D", nullptr, {object, abi::TslArg::of(g::vec3({u, v, g::float_(0.25)}))}, serial);
        const abi::TslArg drifting = abi::TslArg::of(abi::tslCall("texture3D", nullptr, {object}, serial));
        const auto q = g::vec3({v, u, g::add(g::mul(u, g::float_(2)), g::float_(0.6))});
        const auto drift = abi::tslCall("sample", &drifting, {abi::TslArg::of(q)}, serial);
        material->nodes.colorNode = g::vec4({g::swizzle(slice, "x"), g::swizzle(slice, "y"), g::swizzle(drift, "z"), g::float_(1)});
    } else if (program == "texture-object") {
        // texture(object, uv) through the shared TSL table, as V8 and Wasm pass an engine Texture.
        uint64_t serial = 0;
        const auto sample = [&serial](std::shared_ptr<void> map) {
            return abi::tslCall("texture", nullptr, {abi::TslArg::objectOf("DataTexture", std::move(map)),
                                                     abi::TslArg::of(g::uv())}, serial);
        };
        const auto bands = sample(tsl_detail::equirectSky()), squares = sample(tsl_detail::checker());
        material->nodes.colorNode = g::vec4({g::mul(g::swizzle(bands, "xyz"),
            g::add(g::mul(g::swizzle(squares, "x"), g::float_(0.6)), g::float_(0.4))), g::float_(1)});
    } else if (program == "pmrem-texture") {
        uint64_t serial = 0;
        const auto positionWorld = g::varying("positionWorld", Type::vec(3));
        const std::vector<abi::TslArg> args = {abi::TslArg::objectOf("DataTexture", tsl_detail::equirectSky()),
            abi::TslArg::of(g::normalize(positionWorld)), abi::TslArg::of(g::mul(x, g::float_(0.9)))};
        material->nodes.colorNode = g::vec4({abi::tslCall("pmremTexture", nullptr, args, serial), g::float_(1)});
    } else if (program == "vertex-node-screen" || program == "vertex-node-world") {
        uint64_t serial = 0;
        const auto geometry = abi::tslCall("positionGeometry", nullptr, {}, serial);
        if (program == "vertex-node-screen") {
            material->nodes.vertexNode = g::vec4({g::add(g::mul(g::swizzle(geometry, "xy"), g::float_(0.4)),
                                                         g::vec2({g::float_(-0.5), g::float_(0.45)})),
                                                  g::float_(0), g::float_(1)});
        } else {
            const auto bent = g::add(geometry, g::vec3({g::float_(0), g::mul(g::sin(g::mul(g::swizzle(geometry, "x"),
                                                         g::float_(3))), g::float_(0.3)), g::float_(0)}));
            const auto projection = abi::tslCall("cameraProjectionMatrix", nullptr, {}, serial);
            material->nodes.vertexNode = g::mul(projection, g::mul(g::uniform("viewMatrix", Type::mat(4, 4)),
                                                                   g::vec4({bent, g::float_(1)})));
        }
    } else if (program == "nodemat-standard-nodes") {
        material->nodes.roughnessNode = g::add(g::mul(x, g::float_(0.7)), g::float_(0.2));
        material->nodes.metalnessNode = g::mul(y, g::float_(0.8));
        material->nodes.emissiveNode = g::vec3({g::add(g::mul(g::sin(g::mul(x, g::float_(8))), g::float_(0.15)),
                                                    g::float_(0.15)), g::float_(0), g::float_(0)});
    } else if (program == "nodemat-normal-opacity") {
        material->nodes.normalNode = g::normalize(g::add(g::varying("normalViewGeometry", Type::vec(3)),
            g::vec3({g::mul(g::sin(g::mul(x, g::float_(10))), g::float_(0.35)), g::float_(0), g::float_(0)})));
        material->nodes.opacityNode = g::add(g::mul(y, g::float_(0.6)), g::float_(0.2));
    } else {
        if (program == "storage-instances") return tsl_detail::storageInstances(*material, renderer, device);
        if (program == "wave-plane") return tsl_detail::wavePlane(*material);
        return "TN_FIXTURE_TSL_UNKNOWN: " + program;
    }
    material->needsUpdate();
    return "";
}

}  // namespace tn::fixture
