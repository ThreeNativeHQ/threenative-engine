#include "check.h"
#include "fixture/traa_dump.h"
#include "engine/renderer/render_database.h"
#include "engine/scene/geometries.h"
#include "engine/scene/texture.h"
#include "engine/renderer/renderer.h"
#include "engine/renderer/post/traa.h"
#include "engine/shader/graph/post_effects.h"
#include "mystral/webgpu/context.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <optional>
#include <string>
#include <thread>

using namespace tn::engine;

namespace {

#if defined(MYSTRAL_WEBGPU_DAWN)
// Dawn's Null backend validates the complete command stream without a GPU.
void traaValidation() {
    tn::engine::LightState lights;
    tn::engine::DirectLight firstLight, secondLight;
    firstLight.id = uint64_t(41); secondLight.id = uint64_t(41) + 1;
    firstLight.shadow.emplace(); secondLight.shadow.emplace();
    firstLight.shadow->matrix[12] = 3; secondLight.shadow->matrix[12] = 9;
    lights.direct = {secondLight, firstLight};
    CHECK(lights.shadowMatrix(uint64_t(41))[12] == 3);
    std::swap(lights.direct[0], lights.direct[1]);
    CHECK(lights.shadowMatrix(uint64_t(41))[12] == 3);
    bool missingLight = false;
    try { lights.shadowMatrix(uint64_t(41) + 2); } catch (const std::runtime_error&) { missingLight = true; }
    CHECK(missingLight);


    WGPUInstance instance = wgpuCreateInstance(nullptr);
    WGPUAdapter adapter = nullptr;
    WGPURequestAdapterOptions options{};
    options.backendType = WGPUBackendType_Null;
    WGPURequestAdapterCallbackInfo adapterInfo{};
    adapterInfo.mode = WGPUCallbackMode_AllowProcessEvents;
    adapterInfo.userdata1 = &adapter;
    adapterInfo.callback = [](WGPURequestAdapterStatus, WGPUAdapter a, WGPUStringView, void* user, void*) {
        *static_cast<WGPUAdapter*>(user) = a;
    };
    wgpuInstanceRequestAdapter(instance, &options, adapterInfo);
    wgpuInstanceProcessEvents(instance);
    CHECK(adapter != nullptr);
    if (!adapter) { wgpuInstanceRelease(instance); return; }
    WGPUDevice device = nullptr;
    WGPURequestDeviceCallbackInfo deviceInfo{};
    deviceInfo.mode = WGPUCallbackMode_AllowProcessEvents;
    deviceInfo.userdata1 = &device;
    deviceInfo.callback = [](WGPURequestDeviceStatus, WGPUDevice d, WGPUStringView, void* user, void*) {
        *static_cast<WGPUDevice*>(user) = d;
    };
    wgpuAdapterRequestDevice(adapter, nullptr, deviceInfo);
    wgpuInstanceProcessEvents(instance);
    CHECK(device != nullptr);
    if (!device) { wgpuAdapterRelease(adapter); wgpuInstanceRelease(instance); return; }
    WGPUQueue queue = wgpuDeviceGetQueue(device);
    wgpuDevicePushErrorScope(device, WGPUErrorFilter_Validation);
    {
        TraaPass pass(device, queue, TraaOptions{});
        pass.resize(32, 24);
        const auto& graph = pass.renderGraph();
        const auto compiled = graph.compile();
        CHECK(compiled.ok() && compiled.order.size() == 3);
        if (compiled.order.size() == 3) {
            CHECK(graph.passName(compiled.order[0]) == "traa-velocity");
            CHECK(graph.passName(compiled.order[1]) == "traa-resolve");
            CHECK(graph.passName(compiled.order[2]) == "traa-store-history");
        }
        CHECK(pass.resultView() != nullptr && pass.resultView() != pass.velocityView());
        CHECK(pass.needsSeed());
        // Use real begin/resolve calls so frame advancement and matrix column/sign mistakes
        // are checked against upstream cameras by traa_reference_test.mjs, without a GPU.
        WGPUTextureDescriptor texture{};
        texture.dimension = WGPUTextureDimension_2D; texture.size = {320, 240, 1};
        texture.mipLevelCount = texture.sampleCount = 1;
        texture.usage = WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopySrc;
        texture.format = WGPUTextureFormat_RGBA16Float;
        const auto beauty = wgpuDeviceCreateTexture(device, &texture);
        const auto beautyView = wgpuTextureCreateView(beauty, nullptr);
        texture.format = WGPUTextureFormat_Depth32Float;
        const auto depth = wgpuDeviceCreateTexture(device, &texture);
        const auto depthView = wgpuTextureCreateView(depth, nullptr);
        const TraaPass::Matrix identity{1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1};
        const TraaPass::Matrix projections[] = {
            {.75,0,0,0,0,1,0,0,0,0,-10.0/9,-1,0,0,-10.0/9,0},
            {1,0,0,0,0,1,0,0,0,0,-1,0,0,0,0,1}};
        {
            TraaPass manual(device, queue, TraaOptions{});
            manual.resize(320, 240);
            auto authored = projections[0];
            authored[8] += 0.125;
            CHECK(manual.begin(projections[0], identity, identity, &authored) == authored);
        }
        std::cout << std::setprecision(17) << "TRAA_PROJECTIONS [";
        for (int kind = 0; kind < 2; ++kind) {
            TraaPass jitter(device, queue, TraaOptions{});
            jitter.resize(320, 240);
            std::cout << (kind ? ",[" : "[");
            for (int frame = 0; frame < 96; ++frame) {
                const auto matrix = jitter.begin(projections[kind], identity, identity);
                std::cout << (frame ? ",[" : "[");
                for (int j = 0; j < 16; ++j) std::cout << (j ? "," : "") << matrix[j];
                std::cout << "]";
                const auto encoder = wgpuDeviceCreateCommandEncoder(device, nullptr);
                jitter.seedHistory(encoder, beauty);
                jitter.resolve(encoder, beauty, beautyView, depth, depthView);
                const auto commands = wgpuCommandEncoderFinish(encoder, nullptr);
                wgpuQueueSubmit(queue, 1, &commands);
                wgpuCommandBufferRelease(commands); wgpuCommandEncoderRelease(encoder);
            }
            CHECK(!jitter.needsSeed());
            jitter.cameraCut();
            CHECK(jitter.needsSeed());
            std::cout << "]";
        }
        std::cout << "]\n";
        wgpuTextureViewRelease(beautyView); wgpuTextureViewRelease(depthView);
        wgpuTextureRelease(beauty); wgpuTextureRelease(depth);
        EventQueue events;
        Renderer renderer(instance, device, queue, events);
        renderer.setSize(32, 24);
        renderer.setOutput(OutputState{});
        renderer.setTraa(TraaOptions{});
        CameraState camera;
        camera.projectionMatrix = camera.matrixWorld = camera.matrixWorldInverse =
            {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
        const float triangle[] = {-1, -1, 0.5, 1, -1, 0.5, 0, 1, 0.5};
        BufferStore positions(Scalar::F32, 9);
        positions.write(0, triangle, sizeof triangle);
        shader::StandardMaterial material;
        DrawItem item;
        item.key = item.id = 1; item.kind = MaterialKind::Basic;
        item.positions = &positions; item.material = &material; item.matrixWorld = camera.matrixWorld;
        const std::span<const DrawItem> items(&item, 1);
        renderer.render(items, camera, LightState{}, {0.1, 0.2, 0.3, 0.5});
        item.matrixWorld[12] += 0.01;
        renderer.render(items, camera, LightState{}, {0.1, 0.2, 0.3, 0.5});
        renderer.cutHistory();
        renderer.render(items, camera, LightState{}, {0.1, 0.2, 0.3, 0.5});
        renderer.setSize(16, 12);
        renderer.render(items, camera, LightState{}, {0.1, 0.2, 0.3, 0.5});
        bool readDone = false;
        renderer.readPixels([&](GpuStatus status, std::vector<uint8_t> pixels) {
            CHECK(status == GpuStatus::Ok && pixels.size() == 16 * 12 * 4);
            readDone = true;
        });
        for (int i = 0; i < 1000 && !readDone; ++i) { renderer.poll(); events.drain(); }
        CHECK(readDone);
    }
    {
        EventQueue events;
        Renderer renderer(instance, device, queue, events);
        renderer.setSize(32, 24);
        Scene scene;
        PerspectiveCamera camera(55, 4.0 / 3, 0.1, 100);
        camera.position.set(0.7, 0, 6); camera.lookAt(0, 0, 0);
        auto sky = std::make_shared<DataTexture>();
        sky->width = 128; sky->height = 64; sky->mapping = 303;
        sky->colorSpace = TextureColorSpace::SRGB;
        sky->minFilter = static_cast<uint16_t>(TextureFilter::LinearMipmapLinear);
        sky->magFilter = static_cast<uint16_t>(TextureFilter::Linear);
        sky->data.resize(128 * 64 * 4, 255); sky->needsUpdate();
        scene.backgroundTexture = scene.environment = sky;
        scene.backgroundIntensity = scene.environmentIntensity = 2.5;
        scene.backgroundRotation.set(0.1, 0.4, 0); scene.environmentRotation.set(0.1, 0.4, 0);
        auto material = std::make_shared<Material>(MaterialType::Standard);
        Mesh sphere(makeSphereGeometry(), material); scene.add(sphere);
        RenderDatabase database;
        // Frame-pumped PMREM (PRD-573): the first render starts the full-quality bake and publishes
        // nothing; the frame is skipped, so no draw reaches it and no partial target is exposed.
        CHECK(database.render(renderer, scene, camera, {0, 0, 0, 0}) == 0);
        CHECK(renderer.lastFrame().draws == 0);
        // Without a poll/drain the previous submission's completion is not observed, so a second
        // frame advances nothing either: the completion serial, not queue order, is the gate.
        CHECK(database.render(renderer, scene, camera, {0, 0, 0, 0}) == 0);
        CHECK(renderer.lastFrame().draws == 0);
        // Drain completions and pump one packet per frame until the bake publishes.
        const auto pumpUntilDrawn = [&]() {
            for (int i = 0; i < 800; ++i) {
                renderer.poll();
                events.drain();
                if (database.render(renderer, scene, camera, {0, 0, 0, 0}) != 0) return true;
            }
            return false;
        };
        CHECK(pumpUntilDrawn());
        CHECK(database.diagnostics().empty());
        CHECK(renderer.lastFrame().draws == 3 && renderer.lastFrame().triangles > 0); // sky, sphere, output
        // A source version change invalidates the published cache: the stale target is withheld and
        // the scene draws again only after a fresh full-quality bake completes.
        sky->needsUpdate();
        CHECK(database.render(renderer, scene, camera, {0, 0, 0, 0}) == 0);
        CHECK(pumpUntilDrawn());
        CHECK(renderer.lastFrame().draws == 3);
        // Removing only the background must remove the sky draw even with environment retained.
        scene.backgroundTexture.reset();
        CHECK(database.render(renderer, scene, camera, {0, 0, 0, 0}) != 0);
        CHECK(renderer.lastFrame().draws == 2); // sphere and output
        // A post graph's fullscreen effect passes are draws too: three's Info counts each as one draw of
        // one triangle, so a bloom chain is not invisible to the draw and triangle counters.
        const auto plain = renderer.lastFrame();
        namespace g = shader::graph;
        const auto colour = g::texture("scene", g::uv());
        renderer.setPostGraph(g::add(colour, g::bloom(colour, 0.7, 0.5, 0.2)));
        database.render(renderer, scene, camera, {0, 0, 0, 0});
        const auto post = renderer.lastFrame();
        CHECK(post.draws > plain.draws + 1);
        CHECK(post.draws - plain.draws == post.triangles - plain.triangles);
    }
    bool done = false;
    WGPUPopErrorScopeCallbackInfo errorInfo{};
    errorInfo.mode = WGPUCallbackMode_AllowProcessEvents;
    errorInfo.userdata1 = &done;
    errorInfo.callback = [](WGPUPopErrorScopeStatus status, WGPUErrorType type, WGPUStringView message, void* user, void*) {
        if (type != WGPUErrorType_NoError) std::fprintf(stderr, "TRAA validation: %.*s\n", int(message.length), message.data);
        CHECK(status == WGPUPopErrorScopeStatus_Success);
        CHECK(type == WGPUErrorType_NoError);
        *static_cast<bool*>(user) = true;
    };
    wgpuDevicePopErrorScope(device, errorInfo);
    wgpuInstanceProcessEvents(instance);
    CHECK(done);
    wgpuQueueRelease(queue); wgpuDeviceRelease(device); wgpuAdapterRelease(adapter); wgpuInstanceRelease(instance);
}
#endif

constexpr double kPi = 3.141592653589793;

// three's SphereGeometry(1, 32, 16) layout: non-indexed is enough for a coverage check.
struct Sphere {
    BufferStore positions{Scalar::F32, 0};
    BufferStore normals{Scalar::F32, 0};
    BufferStore indices{Scalar::U16, 0};
};

std::unique_ptr<Sphere> sphere(int segments, int rings) {
    auto s = std::make_unique<Sphere>();
    std::vector<float> p;
    std::vector<uint16_t> idx;
    for (int y = 0; y <= rings; ++y)
        for (int x = 0; x <= segments; ++x) {
            const double u = double(x) / segments, v = double(y) / rings;
            p.push_back(float(-std::cos(u * 2 * kPi) * std::sin(v * kPi)));
            p.push_back(float(std::cos(v * kPi)));
            p.push_back(float(std::sin(u * 2 * kPi) * std::sin(v * kPi)));
        }
    for (int y = 0; y < rings; ++y)
        for (int x = 0; x < segments; ++x) {
            const uint16_t a = y * (segments + 1) + x + 1, b = y * (segments + 1) + x, c = (y + 1) * (segments + 1) + x,
                           d = (y + 1) * (segments + 1) + x + 1;
            if (y != 0) idx.insert(idx.end(), {a, b, d});
            if (y != rings - 1) idx.insert(idx.end(), {b, c, d});
        }
    s->positions.resize(p.size());
    s->positions.write(0, p.data(), p.size() * 4);
    s->normals.resize(p.size());
    s->normals.write(0, p.data(), p.size() * 4);  // unit sphere: normal == position
    s->indices.resize(idx.size());
    s->indices.write(0, idx.data(), idx.size() * 2);
    return s;
}

// A camera at z = 4 looking down -z, three's PerspectiveCamera(50, aspect, 0.1, 100), WebGPU clip z.
CameraState camera(double aspect) {
    CameraState c;
    c.matrixWorldInverse = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -4, 1};
    const double top = 0.1 * std::tan(25 * kPi / 180), height = 2 * top, width = aspect * height;
    // three's makePerspective in WebGPUCoordinateSystem, which WebGPURenderer.render switches cameras to.
    const double x = 2 * 0.1 / width, y = 2 * 0.1 / height, cz = -100 / (100 - 0.1), d = -100 * 0.1 / (100 - 0.1);
    c.projectionMatrix = {x, 0, 0, 0, 0, y, 0, 0, 0, 0, cz, -1, 0, 0, d, 0};
    return c;
}

// `camera(aspect)` slid 0.02 along x per frame: the world matrix is the inverse of the view matrix.
CameraState slidingCamera(double aspect, int frame) {
    CameraState c = camera(aspect);
    const double x = 0.02 * frame;
    c.matrixWorld = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 4, 1};
    c.matrixWorldInverse = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -x, 0, -4, 1};
    return c;
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

// A constant premultiplied frame must survive TRAA and the shared RenderOutputNode transform.
void traaAlpha() {
    mystral::webgpu::Context context;
    const bool initialized = context.initializeHeadless();
    CHECK(initialized);
    if (!initialized) return;
    WGPUAdapterInfo info{};
    wgpuAdapterGetInfo(context.getAdapter(), &info);
    const bool rendersPixels = info.backendType != WGPUBackendType_Null;
    wgpuAdapterInfoFreeMembers(info);
    if (!rendersPixels) std::fprintf(stderr, "TN_TRAA_ALPHA_REQUIRES_RENDERING_BACKEND: Null cannot verify pixels\n");
    CHECK(rendersPixels);
    if (!rendersPixels) return;
    EventQueue events;
    CameraState camera;
    camera.projectionMatrix = camera.matrixWorld = camera.matrixWorldInverse =
        {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
    for (bool srgb : {false, true}) for (double alpha : {0.0, 0.5, 1.0}) {
        Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
        renderer.setSize(16, 16);
        renderer.setOutput(OutputState{shader::ToneMapping::ACESFilmic, 1, srgb});
        const std::array<double, 4> clear{0.2 * alpha, 0.4 * alpha, 0.6 * alpha, alpha};
        renderer.render({}, camera, LightState{}, clear);
        const auto plain = read(renderer, events);
        renderer.setTraa(TraaOptions{});
        for (int frame = 0; frame < 3; ++frame) {
            renderer.render({}, camera, LightState{}, clear);
            const auto temporal = read(renderer, events);
            CHECK(plain.size() == 16 * 16 * 4 && temporal.size() == plain.size());
            if (plain.size() != 16 * 16 * 4 || temporal.size() != plain.size()) continue;
            const size_t center = (8 * 16 + 8) * 4;
            for (int c = 0; c < 4; ++c) CHECK(std::abs(int(temporal[center + c]) - int(plain[center + c])) <= 1);
            CHECK(temporal[center + 3] == plain[center + 3]);
        }
    }
}

bool rendersPixels(mystral::webgpu::Context& context) {
    WGPUAdapterInfo info{};
    wgpuAdapterGetInfo(context.getAdapter(), &info);
    const bool pixels = info.backendType != WGPUBackendType_Null;
    wgpuAdapterInfoFreeMembers(info);
    return pixels;
}

// A post graph's last node reads `screenSize` in the output pass (the vignette's aspect ratio does). The pass wrote no
// value there: the size read zero, the quotient was NaN and the whole frame came out black.
void outputScreenSize() {
    namespace g = shader::graph;
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    CHECK(rendersPixels(context));
    if (!rendersPixels(context)) return;
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(64, 32);
    renderer.setOutput(OutputState{std::nullopt, 1, false});
    CameraState camera;
    camera.projectionMatrix = camera.matrixWorld = camera.matrixWorldInverse =
        {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
    const auto screen = g::uniform("screenSize", shader::Type::vec(2));
    const auto aspect = g::div(g::swizzle(screen, "y"), g::swizzle(screen, "x"));  // 32 / 64
    renderer.setPostGraph(g::vec4({g::mul(g::swizzle(g::texture("scene", g::uv()), "xyz"), g::splat(aspect, 3)), g::float_(1)}));
    renderer.render({}, camera, LightState{}, {1, 1, 1, 1});
    const auto pixels = read(renderer, events);
    CHECK(pixels.size() == 64 * 32 * 4);
    if (pixels.size() == 64 * 32 * 4)
        for (const size_t texel : {size_t{0}, size_t{16 * 64 + 32}, size_t{64 * 32 - 1}})
            for (int c = 0; c < 3; ++c) CHECK(std::abs(int(pixels[texel * 4 + c]) - 128) <= 1);
}

// The velocity pass leaves out what it holds no previous vertices for (an instanced draw threw TN_TRAA_VELOCITY_UNSUPPORTED
// and cost the frame). The camera-motion fill gives those pixels the velocity a rigid draw of the same surface writes:
// the same sphere drawn rigid and drawn as one instance reads the same velocity under a moving camera, and every pixel
// of the target is a written one (alpha 1).
void traaCameraVelocity() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    CHECK(rendersPixels(context));
    if (!rendersPixels(context)) return;
    const auto ball = sphere(32, 16);
    shader::StandardMaterial material;
    BufferStore matrices(Scalar::F32, 16);
    const float identity[16] = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
    matrices.write(0, identity, sizeof identity);
    const auto directory = std::filesystem::current_path() /
        ("traa-camera-velocity-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    constexpr uint32_t width = 32, height = 24;
    const auto velocity = [&](bool instanced, bool& noted) {
        EventQueue events;
        Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
        renderer.setSize(width, height);
        renderer.setOutput(OutputState{});
        renderer.setTraa(TraaOptions{});
        auto* pass = renderer.traaDebugPass();
        pass->enableDebugDump();
        DrawItem item;
        item.key = item.id = 1; item.kind = MaterialKind::Basic;
        item.positions = &ball->positions; item.indices = &ball->indices; item.material = &material;
        item.matrixWorld = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
        if (instanced) { item.instanceMatrices = &matrices; item.instanceCount = 1; }
        const auto folder = directory / (instanced ? "instanced" : "rigid");
        noted = false;
        for (int frame = 0; frame <= 20; ++frame) {
            renderer.render({&item, 1}, slidingCamera(double(width) / height, frame), LightState{}, {0, 0, 0, 1});
            for (const auto& note : renderer.diagnostics()) noted = noted || note.rfind("TN_TRAA_VELOCITY_SKIPPED: instanced", 0) == 0;
            tn::fixture::finishTraaDump(*pass, context.getInstance(), folder);
        }
        std::ifstream file(folder / "frame-20-velocity.bin", std::ios::binary);
        CHECK(file.good());
        std::vector<float> texels(size_t{width} * height * 4);
        file.read(reinterpret_cast<char*>(texels.data()), std::streamsize(texels.size() * sizeof(float)));
        return texels;
    };
    bool rigidNoted = false, instancedNoted = false;
    const auto rigid = velocity(false, rigidNoted);
    const auto filled = velocity(true, instancedNoted);
    CHECK(!rigidNoted && instancedNoted);
    size_t moving = 0;
    for (size_t texel = 0; texel < size_t{width} * height; ++texel) {
        CHECK(rigid[texel * 4 + 3] == 1 && filled[texel * 4 + 3] == 1);
        for (int c = 0; c < 2; ++c) CHECK(std::abs(rigid[texel * 4 + c] - filled[texel * 4 + c]) < 1e-4f);
        if (std::abs(filled[texel * 4]) > 0.004f) ++moving;
    }
    CHECK(moving > 50);  // the sphere's pixels move with the camera, not zero
}

// The shape a template gives the engine: the temporal effect is the colour convertToTexture hands the stages, and a stage
// samples the velocity target the temporal pass draws. The effect has to be found inside the render texture (a TRAA the
// engine never saw leaves the camera unjittered and the velocity undrawn) and a stage's `velocity` input has to be bound.
// convertToTexture(traa(scene, depth, velocity, camera)): the colour a template's chain starts from.
shader::graph::Node temporalColour() {
    namespace g = shader::graph;
    auto effect = std::make_shared<g::PostEffect>();
    effect->kind = "TRAANode";
    effect->output = "scene";
    effect->inputs = {g::texture("scene", g::uv()), g::texture("depth", g::uv()), g::texture("velocity", g::uv())};
    effect->parameters = {{"depthThreshold", {0.0005f}}, {"edgeDepthDiff", {0.001f}}, {"maxVelocityLength", {128}},
                          {"useSubpixelCorrection", {1}}};
    auto colour = std::make_shared<g::NodeData>();
    colour->kind = g::Kind::RenderTexture;
    colour->type = shader::Type::vec(4);
    colour->name = "native_rtt_1";
    colour->args = {g::effectNode(effect), g::uv()};
    return colour;
}

void traaFeedsTheChain() {
    namespace g = shader::graph;
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    CHECK(rendersPixels(context));
    if (!rendersPixels(context)) return;
    constexpr uint32_t width = 32, height = 24;
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(width, height);
    renderer.setOutput(OutputState{std::nullopt, 1, false});
    const auto colour = temporalColour();
    // Red is the resolved colour. Green is the velocity's x, scaled so the camera's slide reads as a visible level.
    const auto motion = g::mul(g::swizzle(g::texture("velocity", g::uv()), "x"), g::float_(-50));
    auto stage = std::make_shared<g::NodeData>();  // convertToTexture(...): a stage that reads the velocity inside its own pass
    stage->kind = g::Kind::RenderTexture;
    stage->type = shader::Type::vec(4);
    stage->name = "native_rtt_2";
    stage->args = {g::vec4({g::swizzle(colour, "x"), motion, g::float_(0), g::float_(1)}), g::uv()};
    const auto ball = sphere(32, 16);
    shader::StandardMaterial material;
    material.color = {0.5f, 0.5f, 0.5f};
    DrawItem item;
    item.key = item.id = 1; item.kind = MaterialKind::Basic;
    item.positions = &ball->positions; item.indices = &ball->indices; item.material = &material;
    item.matrixWorld = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
    // The velocity is read where a chain reads it: in the final output graph, and inside a stage's own render texture.
    const g::Node outputRead = g::vec4({g::swizzle(colour, "x"), motion, g::float_(0), g::float_(1)});
    for (const g::Node& graph : {outputRead, static_cast<g::Node>(stage)}) {
        renderer.setPostGraph(graph);
        CHECK(renderer.traaDebugPass() != nullptr);
        for (int frame = 0; frame < 8; ++frame)
            renderer.render({&item, 1}, slidingCamera(double(width) / height, frame), LightState{}, {0, 0, 0, 1});
        const auto pixels = read(renderer, events);
        CHECK(pixels.size() == size_t{width} * height * 4);
        if (pixels.size() != size_t{width} * height * 4) return;
        const size_t centre = (size_t{height / 2} * width + width / 2) * 4;
        // The sphere's front is 3 units away: the 0.02 slide moves it P00 * 0.02 / 3 = 0.0107 in NDC, x 50 = 0.536.
        CHECK(std::abs(int(pixels[centre]) - 128) <= 3);
        CHECK(std::abs(int(pixels[centre + 1]) - 137) <= 12);
    }
}

// A 64x48 frame of an unlit grey sphere on black, which edge pixels it draws partly covered.
struct EdgeScene {
    mystral::webgpu::Context context;
    EventQueue events;
    std::unique_ptr<Renderer> renderer;
    std::unique_ptr<Sphere> ball;
    shader::StandardMaterial material;
    DrawItem item;
    static constexpr uint32_t width = 64, height = 48;
    EdgeScene() {
        CHECK(context.initializeHeadless());
        if (!rendersPixels(context)) return;
        renderer = std::make_unique<Renderer>(context.getInstance(), context.getDevice(), context.getQueue(), events);
        renderer->setSize(width, height);
        renderer->setOutput(OutputState{std::nullopt, 1, false});
        ball = sphere(32, 16);
        material.color = {0.5f, 0.5f, 0.5f};
        item.key = item.id = 1; item.kind = MaterialKind::Basic;
        item.positions = &ball->positions; item.indices = &ball->indices; item.material = &material;
        item.matrixWorld = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
    }
    // Draws `frames` frames of the static scene, then counts the pixels whose red channel is neither black (16) nor the
    // sphere's own level (`high` and above).
    int partial(int frames, int high = 112) {
        for (int frame = 0; frame < frames; ++frame)
            renderer->render({&item, 1}, camera(double(width) / height), LightState{}, {0, 0, 0, 1});
        const auto pixels = read(*renderer, events);
        CHECK(pixels.size() == size_t{width} * height * 4);
        int count = 0, covered = 0;
        for (size_t i = 0; i + 3 < pixels.size(); i += 4) {
            count += pixels[i] > 16 && pixels[i] < high;
            covered += pixels[i] >= high;
        }
        CHECK(covered > 200);  // the sphere is on screen
        return count;
    }
};

// A hard level of the red channel: 1 above `0.2`, else 0. The edge sits where the sphere's colour crosses the level.
shader::graph::Node thresholdOf(shader::graph::Node colour) {
    namespace g = shader::graph;
    const auto lit = g::select(g::greaterThan(g::swizzle(colour, "x"), g::float_(0.2)), g::float_(1), g::float_(0));
    return g::vec4({lit, lit, lit, g::float_(1)});
}

// A static scene converges to anti-aliased edges. The engine jitters the camera by a sub-pixel offset each frame and blends
// the frames, so a silhouette pixel settles at the fraction of it the surface covers. An unlit sphere on black has only
// all-or-nothing edge pixels without the effect.
void traaConvergesEdges() {
    namespace g = shader::graph;
    EdgeScene scene;
    if (!scene.renderer) return;
    const int plain = scene.partial(8);
    const auto red = g::swizzle(temporalColour(), "x");
    scene.renderer->setPostGraph(g::vec4({red, red, red, g::float_(1)}));
    const int temporal = scene.partial(60);
    std::fprintf(stderr, "TN_DEBUG partial edge pixels: plain %d, temporal %d\n", plain, temporal);
    CHECK(plain < 8);
    CHECK(temporal > 40);
}

// The resolve runs over the frame a graph drew, so an effect that comes before it is anti-aliased with the rest. The graph
// thresholds the scene colour, a hard edge that moves with the camera's jitter. Thresholded after the resolve, which is
// where the scene's own colour is resolved, the edge stays hard. Resolved after the threshold, the frames blend and the
// edge pixels take the fraction each frame covered.
void traaLateResolve() {
    namespace g = shader::graph;
    EdgeScene scene;
    if (!scene.renderer) return;
    scene.renderer->setPostGraph(thresholdOf(temporalColour()));
    const int early = scene.partial(60, 240);
    auto composite = std::make_shared<g::NodeData>();  // convertToTexture(threshold(scene colour))
    composite->kind = g::Kind::RenderTexture;
    composite->type = shader::Type::vec(4);
    composite->name = "native_rtt_30";
    composite->args = {thresholdOf(g::texture("scene", g::uv())), g::uv()};
    auto effect = std::make_shared<g::PostEffect>();
    effect->kind = "TRAANode";
    effect->output = "native_traa_30";
    effect->inputs = {composite, g::texture("depth", g::uv()), g::texture("velocity", g::uv())};
    effect->parameters = {{"depthThreshold", {0.0005f}}, {"edgeDepthDiff", {0.001f}}, {"maxVelocityLength", {128}},
                          {"useSubpixelCorrection", {1}}};
    CHECK(g::traaResolvesLate(*effect));
    const auto red = g::swizzle(g::effectNode(effect), "x");
    scene.renderer->setPostGraph(g::vec4({red, red, red, g::float_(1)}));
    const int late = scene.partial(60, 240);
    std::fprintf(stderr, "TN_DEBUG partial edge pixels: resolved before the threshold %d, after %d\n", early, late);
    CHECK(early < 8);
    CHECK(late > 40);
}

// Temporal AA replaces multisampling, as one method does in Unreal. The velocity pass tests depth Equal against the colour
// pass, and 4x multisampling hands it one resolved sample of depth: Equal fails on every sloped surface. The engine draws
// single-sampled while a traa() effect is in the graph, says so once, and returns to the requested count when it leaves.
void traaReplacesMultisampling() {
    namespace g = shader::graph;
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    CHECK(rendersPixels(context));
    if (!rendersPixels(context)) return;
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(32, 24);
    renderer.setOutput(OutputState{std::nullopt, 1, false});
    renderer.setSampleCount(4);
    CHECK(renderer.sampleCount() == 4);
    renderer.setPostGraph(temporalColour());
    CHECK(renderer.sampleCount() == 1);
    const auto& notes = renderer.diagnostics();
    CHECK(std::count_if(notes.begin(), notes.end(), [](const std::string& note) { return note.rfind("TN_TRAA_MSAA_OFF", 0) == 0; }) == 1);
    const auto ball = sphere(32, 16);
    shader::StandardMaterial material;
    material.color = {0.5f, 0.5f, 0.5f};
    DrawItem item;
    item.key = item.id = 1; item.kind = MaterialKind::Basic;
    item.positions = &ball->positions; item.indices = &ball->indices; item.material = &material;
    item.matrixWorld = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
    for (int frame = 0; frame < 4; ++frame)
        renderer.render({&item, 1}, slidingCamera(32.0 / 24, frame), LightState{}, {0, 0, 0, 1});
    const auto pixels = read(renderer, events);
    CHECK(pixels.size() == size_t{32} * 24 * 4);
    if (pixels.size() == size_t{32} * 24 * 4) CHECK(std::abs(int(pixels[(12 * 32 + 16) * 4]) - 128) <= 3);
    renderer.setPostGraph(nullptr);
    CHECK(renderer.sampleCount() == 4);
    renderer.setSampleCount(1);
    CHECK(renderer.sampleCount() == 1);
}

// A stage that reads the velocity with no temporal effect in the graph gets a named refusal, not the scene colour.
void velocityNeedsTraa() {
    namespace g = shader::graph;
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(16, 16);
    renderer.setOutput(OutputState{});
    renderer.setPostGraph(g::vec4({g::swizzle(g::texture("velocity", g::uv()), "x"), g::float_(0), g::float_(0), g::float_(1)}));
    CameraState view;
    view.projectionMatrix = view.matrixWorld = view.matrixWorldInverse = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
    bool refused = false;
    try { renderer.render({}, view, LightState{}, {0, 0, 0, 1}); }
    catch (const std::runtime_error& error) { refused = std::string(error.what()).find("TN_POST_INPUT_MISSING: velocity") == 0; }
    CHECK(refused);
}

// Pin the reset input itself: clipping a flat image could conceal the wrong seed in the output.
void traaResetSeed() {
    mystral::webgpu::Context context;
    const bool initialized = context.initializeHeadless();
    CHECK(initialized);
    if (!initialized) return;
    WGPUAdapterInfo info{};
    wgpuAdapterGetInfo(context.getAdapter(), &info);
    const bool rendersPixels = info.backendType != WGPUBackendType_Null;
    wgpuAdapterInfoFreeMembers(info);
    CHECK(rendersPixels);
    if (!rendersPixels) return;
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(16, 16);
    renderer.setTraa(TraaOptions{});
    const auto directory = std::filesystem::current_path() /
        ("traa-reset-seed-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    auto* pass = renderer.traaDebugPass();
    pass->enableDebugDump();
    CameraState camera;
    camera.projectionMatrix = camera.matrixWorld = camera.matrixWorldInverse =
        {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
    for (int frame = 0; frame <= 20; ++frame) {
        if (frame == 20) renderer.cutHistory();
        renderer.render({}, camera, LightState{}, frame == 20 ?
            std::array<double, 4>{0.75, 0.25, 0.5, 1} : std::array<double, 4>{0.25, 0.5, 0.75, 1});
        tn::fixture::finishTraaDump(*pass, context.getInstance(), directory);
    }
    const auto bytes = [&](const char* name) {
        std::ifstream file(directory / name, std::ios::binary);
        CHECK(file.good());
        return std::string(std::istreambuf_iterator<char>(file), {});
    };
    const auto history = bytes("frame-20-history.bin");
    CHECK(history.size() == 16 * 16 * 4 * sizeof(float));
    CHECK(history == bytes("frame-19-beauty.bin"));
    CHECK(history != bytes("frame-20-beauty.bin"));
}

// Pixels that differ from the clear colour (black), and whether the centre pixel is lit.
size_t covered(const std::vector<uint8_t>& px) {
    size_t n = 0;
    for (size_t i = 0; i + 3 < px.size(); i += 4) n += (px[i] | px[i + 1] | px[i + 2]) != 0;
    return n;
}

void resizeReadback() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    const auto ball = sphere(32, 16);
    shader::StandardMaterial material;
    material.color = {0.8f, 0.3f, 0.2f};
    material.roughness = 0.5f;
    LightState lights;
    lights.direct.push_back(DirectLight::directional({0.5, 0.8, 0.6}, {3, 3, 3}));
    lights.ambient = {0.1, 0.1, 0.1};
    DrawItem item;
    item.key = 1;
    item.positions = &ball->positions;
    item.normals = &ball->normals;
    item.indices = &ball->indices;
    item.matrixWorld = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
    item.material = &material;

    uint64_t lastId = 0;
    for (auto [w, h] : {std::pair{64u, 48u}, std::pair{160u, 90u}, std::pair{90u, 150u}}) {
        renderer.setSize(w, h);
        CHECK(renderer.width() == w && renderer.height() == h);
        const uint64_t id = renderer.render({&item, 1}, camera(double(w) / h), lights);
        CHECK(id == lastId + 1);
        lastId = id;
        const std::vector<uint8_t> px = read(renderer, events);
        CHECK(px.size() == size_t{w} * h * 4);
        const size_t lit = covered(px);
        // A unit sphere 4 units away projects to a disc of NDC radius r = tan(asin(1/4)) / tan(25 deg)
        // vertically; its share of a frame of aspect a is pi r^2 / (4a). Rasterization edges stay within 10%.
        const double r = std::tan(std::asin(0.25)) / std::tan(25 * kPi / 180);
        const double expected = kPi * r * r / (4.0 * w / h);
        const double share = double(lit) / (double(w) * h);
        std::printf("%ux%u: %zu bytes, %.2f%% covered, %.2f%% expected\n", w, h, px.size(), share * 100, expected * 100);
        CHECK(std::abs(share / expected - 1) < 0.1);
        const size_t centre = (size_t{h / 2} * w + w / 2) * 4;
        CHECK(px.size() > centre && px[centre] > px[centre + 2]);  // the red-dominant material, not the clear colour
    }
    // Steady state: rendering the same item again compiles nothing and uploads nothing.
    const uint64_t uploads = renderer.geometry().stats().fullUploads;
    for (int i = 0; i < 30; ++i) renderer.render({&item, 1}, camera(90.0 / 150), lights);
    CHECK(renderer.pipelines().compiles() == 2);  // the standard program and the output pass
    CHECK(renderer.geometry().stats().fullUploads == uploads);
}

// three@0.185.1 in Chromium (WebGPU, NVIDIA Turing), tonemap-ramp-* goldens: the 8-bit sRGB output
// of linear grey 0..8 under each tone mapping, exposure 1. Read from the golden PNGs
// (packages/three-native/tests/compatibility/goldens/0.185.1/tonemap-ramp-<mapping>.png, strip centres).
extern "C" unsigned char* stbi_load(const char* filename, int* x, int* y, int* comp, int req_comp);
extern "C" void stbi_image_free(void* data);
extern "C" int stbi_write_png(const char* filename, int w, int h, int comp, const void* data, int stride);

struct Ramp {
    const char* name;
    std::optional<shader::ToneMapping> mapping;
    uint8_t out[9];
};
constexpr Ramp kRamps[] = {
    {"linear", shader::ToneMapping::Linear, {0, 255, 255, 255, 255, 255, 255, 255, 255}},
    {"reinhard", shader::ToneMapping::Reinhard, {0, 188, 213, 225, 231, 235, 238, 240, 242}},
    {"cineon", shader::ToneMapping::Cineon, {0, 216, 233, 240, 244, 246, 247, 248, 249}},
    {"aces", shader::ToneMapping::ACESFilmic, {0, 227, 242, 247, 250, 251, 252, 253, 253}},
    {"agx", shader::ToneMapping::AgX, {0, 202, 224, 233, 239, 242, 245, 246, 248}},
    {"neutral", shader::ToneMapping::Neutral, {0, 240, 250, 252, 253, 254, 254, 254, 254}},
};

// The tonemap-ramp fixtures, natively: nine MeshBasicMaterial strips (PlaneGeometry(2/9, 2)) of
// linear grey 0..8 side by side under OrthographicCamera(-1, 1, 1, -1, 0.1, 10) at z = 1, 288x64.
// Every strip's pixels must equal the browser reference's.
void outputRamp() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(288, 64);
    const double w = 2.0 / 9;
    const float quad[12] = {float(-w / 2), -1, 0, float(w / 2), -1, 0, float(-w / 2), 1, 0, float(w / 2), 1, 0};
    const uint16_t corners[6] = {0, 1, 2, 2, 1, 3};  // PlaneGeometry's winding, facing +z
    BufferStore positions(Scalar::F32, 12), indices(Scalar::U16, 6);
    positions.write(0, quad, sizeof quad);
    indices.write(0, corners, sizeof corners);
    shader::StandardMaterial greys[9];
    std::vector<DrawItem> strips(9);
    for (int k = 0; k < 9; ++k) {
        greys[k].color = {float(k), float(k), float(k)};
        strips[k].key = k + 1;
        strips[k].kind = MaterialKind::Basic;
        strips[k].positions = &positions;
        strips[k].indices = &indices;
        strips[k].material = &greys[k];
        strips[k].matrixWorld = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -1 + (k + 0.5) * w, 0, 0, 1};
    }
    CameraState camera;
    camera.matrixWorldInverse = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -1, 1};
    camera.projectionMatrix = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1 / 9.9, 0, 0, 0, -0.1 / 9.9, 1};  // WebGPU clip z
    int worst = 0;
    for (const Ramp& ramp : kRamps) {
        renderer.setOutput(OutputState{ramp.mapping, 1, true});
        renderer.render(strips, camera, LightState{});
        const std::vector<uint8_t> px = read(renderer, events);
        CHECK(px.size() == 288 * 64 * 4);
        if (px.size() != 288 * 64 * 4) return;
        // Whole frame against the golden PNG, when the checkout has it.
        const std::string png = std::string(TN_GOLDENS_DIR) + "/tonemap-ramp-" + ramp.name + ".png";
        int gw = 0, gh = 0, gc = 0;
        if (unsigned char* golden = stbi_load(png.c_str(), &gw, &gh, &gc, 4)) {
            CHECK(gw == 288 && gh == 64);
            size_t mismatched = 0;
            for (size_t i = 0; gw == 288 && gh == 64 && i < px.size(); ++i) mismatched += std::abs(int(px[i]) - int(golden[i])) > 1;
            std::printf("%s: %zu of %zu channels differ from %s\n", ramp.name, mismatched, px.size(), png.c_str());
            CHECK(mismatched == 0);
            stbi_image_free(golden);
        } else {
            CHECK(!"golden PNG missing");
        }
        for (int k = 0; k < 9; ++k)
            for (int x : {k * 32 + 2, k * 32 + 16, k * 32 + 29})
                for (int y : {2, 32, 61}) {
                    const uint8_t* p = &px[(size_t(y) * 288 + x) * 4];
                    const int diff = std::abs(int(p[0]) - int(ramp.out[k]));
                    worst = std::max(worst, diff);
                    if (diff > 1) std::printf("%s strip %d (%d,%d): native %d, reference %d\n", ramp.name, k, x, y, p[0], ramp.out[k]);
                    CHECK(diff <= 1);
                    CHECK(p[0] == p[1] && p[1] == p[2] && p[3] == 255);
                }
    }
    std::printf("output ramp: 6 mappings x 9 strips x 9 samples, worst difference %d/255\n", worst);
    CHECK(renderer.pipelines().compiles() == 1 + 6);  // the basic program once, one output program per mapping
}

double srgbToLinear(double c) { return c < 0.04045 ? c * 0.0773993808 : std::pow(c * 0.9478672986 + 0.0521327014, 2.4); }

// The lit-render fixture, natively: SphereGeometry(1, 32, 16) with MeshStandardMaterial (0.8, 0.35,
// 0.2; roughness 0.35, metalness 0.1) under DirectionalLight(0xffffff, 3) at (2, 3, 1) and
// HemisphereLight(0xaabb91, 0x222222, 0.6), PerspectiveCamera(60, 4/3) at (0, 1.4, 3.2) looking at the
// origin, background (0.05, 0.06, 0.08), ACES, 320x240. Compared with the browser's golden frame.
void litReference() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(320, 240);
    renderer.setOutput(OutputState{shader::ToneMapping::ACESFilmic, 1, true});
    const auto ball = sphere(32, 16);
    shader::StandardMaterial material;
    material.color = {0.8f, 0.35f, 0.2f};
    material.roughness = 0.35f;
    material.metalness = 0.1f;
    DrawItem item;
    item.key = 1;
    item.positions = &ball->positions;
    item.normals = &ball->normals;
    item.indices = &ball->indices;
    item.matrixWorld = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
    item.material = &material;

    // Object3D.lookAt for a camera: -z towards the target, up (0, 1, 0); the view is its inverse.
    const double eye[3] = {0, 1.4, 3.2};
    const double zl = std::sqrt(eye[1] * eye[1] + eye[2] * eye[2]);
    const double z[3] = {0, eye[1] / zl, eye[2] / zl};
    const double x[3] = {1, 0, 0};  // up x z, normalised: z has no x component
    const double y[3] = {z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]};
    auto dot = [](const double* a, const double* b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; };
    CameraState camera;
    camera.matrixWorldInverse = {x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
                                 -dot(x, eye), -dot(y, eye), -dot(z, eye), 1};
    const double t = std::tan(30 * kPi / 180), aspect = 4.0 / 3;
    camera.projectionMatrix = {1 / (aspect * t), 0, 0, 0, 0, 1 / t, 0, 0, 0, 0, -100 / 99.9, -1, 0, 0, -10 / 99.9, 0};

    LightState lights;
    const double dl = std::sqrt(4.0 + 9 + 1);
    lights.direct.push_back(DirectLight::directional({2 / dl, 3 / dl, 1 / dl}, {3, 3, 3}));
    lights.hemisphereSky = {srgbToLinear(0xaa / 255.0) * 0.6, srgbToLinear(0xbb / 255.0) * 0.6, srgbToLinear(0x91 / 255.0) * 0.6};
    const double ground = srgbToLinear(0x22 / 255.0) * 0.6;
    lights.hemisphereGround = {ground, ground, ground};
    lights.hemisphereUp = {0, 1, 0};
    renderer.render({&item, 1}, camera, lights, {0.05, 0.06, 0.08, 1});
    const std::vector<uint8_t> px = read(renderer, events);
    CHECK(px.size() == 320 * 240 * 4);
    if (const char* out = std::getenv("TN_RENDER_OUT"); out && px.size() == 320 * 240 * 4)
        stbi_write_png(out, 320, 240, 4, px.data(), 320 * 4);  // for the PR's progress record

    const std::string png = std::string(TN_GOLDENS_DIR) + "/lit-render.png";
    int gw = 0, gh = 0, gc = 0;
    unsigned char* golden = stbi_load(png.c_str(), &gw, &gh, &gc, 4);
    CHECK(golden != nullptr && gw == 320 && gh == 240);
    if (!golden || px.size() != 320 * 240 * 4) return;
    size_t off1 = 0, off4 = 0;
    int worst = 0;
    double sum = 0;
    for (size_t i = 0; i < px.size(); i += 4)
        for (int c = 0; c < 3; ++c) {
            const int d = std::abs(int(px[i + c]) - int(golden[i + c]));
            worst = std::max(worst, d);
            sum += d;
            off1 += d > 1;
            off4 += d > 4;
        }
    stbi_image_free(golden);
    const double channels = 320.0 * 240 * 3;
    std::printf("lit-render vs browser: mean |d| %.3f, worst %d, >1: %.3f%%, >4: %.3f%% of channels\n", sum / channels, worst,
                off1 * 100 / channels, off4 * 100 / channels);
    // Measured on NVIDIA Turing (Dawn and wgpu-native): mean 0.001, worst 4, 0.006% over 1 level.
    // A wrong light term moves thousands of channels (the view-space hemisphere bug: 7% over 1).
    CHECK(worst <= 8 && off1 / channels < 0.001);
}

// Compares a frame with a golden PNG; returns the share of channels more than `levels` apart.
double goldenMismatch(const std::vector<uint8_t>& px, const char* name, int w, int h, int levels, int& worst) {
    const std::string png = std::string(TN_GOLDENS_DIR) + "/" + name + ".png";
    int gw = 0, gh = 0, gc = 0;
    unsigned char* golden = stbi_load(png.c_str(), &gw, &gh, &gc, 4);
    CHECK(golden != nullptr && gw == w && gh == h && px.size() == size_t(w) * h * 4);
    if (!golden || gw != w || gh != h || px.size() != size_t(w) * h * 4) return 1;
    size_t off = 0;
    worst = 0;
    for (size_t i = 0; i < px.size(); i += 4)
        for (int c = 0; c < 3; ++c) {
            const int d = std::abs(int(px[i + c]) - int(golden[i + c]));
            worst = std::max(worst, d);
            off += d > levels;
        }
    stbi_image_free(golden);
    return double(off) / (double(w) * h * 3);
}

// The materials-lambert / materials-phong fixtures, natively: the litReference scene (sphere,
// DirectionalLight(3) at (2,3,1), HemisphereLight(0xaabb91, 0x222222, 0.6), camera, ACES,
// 320x240) with MeshLambertMaterial (specular off) or MeshPhongMaterial (Blinn-Phong), vs the
// browser golden. The gate is litReference's: a wrong light term moves thousands of channels.
void materialReference(const char* golden, MaterialKind kind, const shader::StandardMaterial& material) {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(320, 240);
    renderer.setOutput(OutputState{shader::ToneMapping::ACESFilmic, 1, true});
    const auto ball = sphere(32, 16);
    DrawItem item;
    item.key = 1;
    item.kind = kind;
    item.positions = &ball->positions;
    item.normals = &ball->normals;
    item.indices = &ball->indices;
    item.matrixWorld = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
    item.material = &material;

    const double eye[3] = {0, 1.4, 3.2};
    const double zl = std::sqrt(eye[1] * eye[1] + eye[2] * eye[2]);
    const double z[3] = {0, eye[1] / zl, eye[2] / zl};
    const double x[3] = {1, 0, 0};
    const double y[3] = {z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]};
    auto dot = [](const double* a, const double* b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; };
    CameraState camera;
    camera.matrixWorldInverse = {x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
                                 -dot(x, eye), -dot(y, eye), -dot(z, eye), 1};
    const double t = std::tan(30 * kPi / 180), aspect = 4.0 / 3;
    camera.projectionMatrix = {1 / (aspect * t), 0, 0, 0, 0, 1 / t, 0, 0, 0, 0, -100 / 99.9, -1, 0, 0, -10 / 99.9, 0};

    LightState lights;
    const double dl = std::sqrt(4.0 + 9 + 1);
    lights.direct.push_back(DirectLight::directional({2 / dl, 3 / dl, 1 / dl}, {3, 3, 3}));
    lights.hemisphereSky = {srgbToLinear(0xaa / 255.0) * 0.6, srgbToLinear(0xbb / 255.0) * 0.6, srgbToLinear(0x91 / 255.0) * 0.6};
    const double ground = srgbToLinear(0x22 / 255.0) * 0.6;
    lights.hemisphereGround = {ground, ground, ground};
    lights.hemisphereUp = {0, 1, 0};
    renderer.render({&item, 1}, camera, lights, {0.05, 0.06, 0.08, 1});
    const std::vector<uint8_t> px = read(renderer, events);
    int worst = 0;
    const double off = goldenMismatch(px, golden, 320, 240, 1, worst);
    std::printf("%s vs browser: worst %d, %.3f%% of channels over 1\n", golden, worst, off * 100);
    CHECK(worst <= 8 && off < 0.001);
}

void lambertReference() {
    shader::StandardMaterial material;
    material.color = {0.8f, 0.35f, 0.2f};
    materialReference("materials-lambert", MaterialKind::Lambert, material);
}

void phongReference() {
    shader::StandardMaterial material;
    material.color = {0.8f, 0.35f, 0.2f};
    material.shininess = 60;
    material.specular = {0.5f, 0.5f, 0.5f};
    materialReference("materials-phong", MaterialKind::Phong, material);
}

void physicalReference() {
    shader::StandardMaterial material;
    material.color = {0.8f, 0.35f, 0.2f};
    material.roughness = 0.35f;
    material.metalness = 0.1f;
    material.ior = 1.8f;
    material.specularIntensity = 0.7f;
    material.specularColor = {1.0f, 0.8f, 0.6f};
    materialReference("materials-physical", MaterialKind::Physical, material);
}

// PlaneGeometry(w, h): three's vertex order and index.
std::unique_ptr<Sphere> plane(double w, double h) {
    auto s = std::make_unique<Sphere>();
    const float v[12] = {float(-w / 2), float(h / 2), 0, float(w / 2), float(h / 2), 0,
                         float(-w / 2), float(-h / 2), 0, float(w / 2), float(-h / 2), 0};
    const uint16_t i[6] = {0, 2, 1, 2, 3, 1};
    s->positions.resize(12);
    s->positions.write(0, v, sizeof v);
    s->indices.resize(6);
    s->indices.write(0, i, sizeof i);
    return s;
}

// A render target's renderer reads the main renderer's scene colour by name (a game's exposure meter does). Temporal AA
// replaces 4x multisampling by allocating the scene target again, and a bind group built over the old view reads a
// texture that keeps the last frame drawn into it. The target's next draw must read the live scene.
void siblingReadsTheLiveScene() {
    namespace g = shader::graph;
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    CHECK(rendersPixels(context));
    if (!rendersPixels(context)) return;
    EventQueue events;
    Renderer main(context.getInstance(), context.getDevice(), context.getQueue(), events);
    main.setSize(16, 16);
    main.setSampleCount(4);
    main.setOutput(OutputState{std::nullopt, 1, false});
    const auto board = plane(2, 2);  // fills the clip space under the identity camera
    shader::StandardMaterial paint, copy;
    DrawItem wall;
    wall.key = wall.id = 1; wall.kind = MaterialKind::Basic;
    wall.positions = &board->positions; wall.indices = &board->indices; wall.material = &paint;
    wall.matrixWorld = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0.5, 1};
    DrawItem mirror = wall;
    mirror.key = mirror.id = 2; mirror.material = &copy;
    mirror.nodes.fragmentNode = g::texture("scene", g::screenUV());
    CameraState flat;
    flat.projectionMatrix = flat.matrixWorld = flat.matrixWorldInverse = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
    const auto target = main.sibling();
    target->setSize(8, 8);
    target->setOutput(OutputState{std::nullopt, 1, false});
    target->setPostSource(&main);
    // The red channel of what the target's draw read, as renderToTarget draws it each frame.
    const auto sceneRead = [&](float scene) {
        paint.color = {scene, scene, scene};
        main.render({&wall, 1}, flat, LightState{}, {0, 0, 0, 1});
        target->setSourceAttachments(main.sceneColorView(), main.sceneDepthView());
        target->render({&mirror, 1}, flat, LightState{}, {0, 0, 0, 1});
        const auto pixels = read(*target, events);
        CHECK(pixels.size() == 8 * 8 * 4);
        return pixels.size() == 8 * 8 * 4 ? int(pixels[(4 * 8 + 4) * 4]) : -1;
    };
    const int before = sceneRead(0.2f);
    main.setSampleCount(1);
    const int after = sceneRead(0.6f);
    std::fprintf(stderr, "TN_DEBUG scene read by the target: %d (0.2), %d (0.6)\n", before, after);
    CHECK(std::abs(before - 51) <= 2);
    CHECK(std::abs(after - 153) <= 2);
}

// Bars across the view at z = -1, 2 px of white in each 4 px. A busy neighbourhood is where a stale colour hides from the
// resolve's history clamp, so it is where a trail would show.
struct BarField {
    BufferStore positions{Scalar::F32, 0};
    BufferStore indices{Scalar::U16, 0};
    BarField() {
        std::vector<float> p;
        std::vector<uint16_t> idx;
        for (int bar = -40; bar < 40; ++bar) {
            const float x0 = float(bar) * 0.4f, x1 = x0 + 0.2f;
            const auto base = uint16_t(p.size() / 3);
            p.insert(p.end(), {x0, -3, -1, x1, -3, -1, x1, 3, -1, x0, 3, -1});
            idx.insert(idx.end(), {base, uint16_t(base + 1), uint16_t(base + 2), base, uint16_t(base + 2), uint16_t(base + 3)});
        }
        positions.resize(p.size());
        positions.write(0, p.data(), p.size() * 4);
        indices.resize(idx.size());
        indices.write(0, idx.data(), idx.size() * 2);
    }
};

// What a frame keeps of an object that is not there. `with` is the resolved frame of the field and the object, `without` the
// same field resolved with no object, and `cover` the object's own footprint in a hard-edged frame. A pixel more than
// `margin` pixels from the footprint should read as the field does. The red channel's difference summed outside the
// footprint, over the same sum on the footprint (the object's own contrast), is the trail the object left.
double trailLeft(const std::vector<uint8_t>& with, const std::vector<uint8_t>& without, const std::vector<bool>& cover,
                 int width, int height, int margin) {
    double trail = 0, body = 0;
    for (int y = 0; y < height; ++y)
        for (int x = 0; x < width; ++x) {
            bool near = false;
            for (int dy = -margin; dy <= margin && !near; ++dy)
                for (int dx = -margin; dx <= margin && !near; ++dx) {
                    const int u = x + dx, v = y + dy;
                    near = u >= 0 && v >= 0 && u < width && v < height && cover[size_t(v) * width + u];
                }
            const size_t at = (size_t(y) * width + x) * 4;
            const double difference = std::abs(int(with[at]) - int(without[at]));
            if (cover[size_t(y) * width + x]) body += difference;
            else if (!near) trail += difference;
        }
    return body > 0 ? trail / body : -1;
}

// A stale colour must not outlive the object that left it. The resolve blends each frame into a history, so an object that
// moves leaves a trail unless the history it reads moves with it. A grey sphere crosses the bar field, drawn as a rigid draw
// (the renderer knows its previous matrix, so its velocity is its own) and as one instance (it does not, so the velocity
// is the camera's, zero here). The field with no sphere resolves in step with it, so both have the same jitter and history.
void traaGhosting() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    CHECK(rendersPixels(context));
    if (!rendersPixels(context)) return;
    constexpr uint32_t width = 64, height = 48;
    constexpr int settle = 40, moved = 8;
    constexpr float scale = 0.4f, step = 0.1f, start = -0.7f;
    BarField field;
    const auto ball = sphere(32, 16);
    shader::StandardMaterial grey, white;
    grey.color = {0.5f, 0.5f, 0.5f};
    white.color = {1, 1, 1};
    BufferStore matrices(Scalar::F32, 16);
    DrawItem bars;
    bars.key = bars.id = 2; bars.kind = MaterialKind::Basic;
    bars.positions = &field.positions; bars.indices = &field.indices; bars.material = &white;
    bars.matrixWorld = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
    // The sphere at `x`, as one rigid draw or as one instance.
    const auto sphereAt = [&](float x, bool instanced) {
        DrawItem item;
        item.key = item.id = 1; item.kind = MaterialKind::Basic;
        item.positions = &ball->positions; item.indices = &ball->indices; item.material = &grey;
        const float m[16] = {scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, x, 0, 0, 1};
        if (instanced) {
            item.matrixWorld = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
            matrices.write(0, m, sizeof m);
            item.instanceMatrices = &matrices; item.instanceCount = 1;
        } else {
            for (int i = 0; i < 16; ++i) item.matrixWorld[size_t(i)] = m[i];
        }
        return item;
    };
    const auto view = camera(double(width) / height);
    const auto make = [&](EventQueue& events, bool temporal) {
        auto renderer = std::make_unique<Renderer>(context.getInstance(), context.getDevice(), context.getQueue(), events);
        renderer->setSize(width, height);
        renderer->setOutput(OutputState{std::nullopt, 1, false});
        if (temporal) renderer->setPostGraph(temporalColour());
        return renderer;
    };
    EventQueue plainEvents;
    auto plain = make(plainEvents, false);
    plain->render({&bars, 1}, view, LightState{}, {0, 0, 0, 1});
    const auto plainField = read(*plain, plainEvents);
    CHECK(plainField.size() == size_t{width} * height * 4);
    if (plainField.size() != size_t{width} * height * 4) return;
    const auto trails = [&](bool instanced) {
        EventQueue events, fieldEvents;
        auto mover = make(events, true);
        auto still = make(fieldEvents, true);
        std::vector<double> out;
        for (int frame = 0; frame < settle + moved; ++frame) {
            const float x = frame < settle ? start : start + step * float(frame - settle + 1);
            const std::array<DrawItem, 2> items = {bars, sphereAt(x, instanced)};
            mover->render({items.data(), items.size()}, view, LightState{}, {0, 0, 0, 1});
            still->render({&bars, 1}, view, LightState{}, {0, 0, 0, 1});
            if (frame < settle) continue;
            const auto with = read(*mover, events);
            const auto without = read(*still, fieldEvents);
            plain->render({items.data(), items.size()}, view, LightState{}, {0, 0, 0, 1});
            const auto hard = read(*plain, plainEvents);
            CHECK(with.size() == plainField.size() && without.size() == plainField.size() && hard.size() == plainField.size());
            if (with.size() != plainField.size() || without.size() != plainField.size() || hard.size() != plainField.size()) return out;
            std::vector<bool> cover(size_t{width} * height);
            for (size_t i = 0; i < cover.size(); ++i) cover[i] = std::abs(int(hard[i * 4]) - int(plainField[i * 4])) > 24;
            out.push_back(trailLeft(with, without, cover, int(width), int(height), 3));
        }
        return out;
    };
    const auto rigid = trails(false);
    const auto instanced = trails(true);
    CHECK(rigid.size() == size_t{moved} && instanced.size() == size_t{moved});
    for (size_t i = 0; i < std::min(rigid.size(), instanced.size()); ++i)
        std::fprintf(stderr, "TN_DEBUG ghost, frame %zu of the move: trail %.3f of the sphere's contrast (rigid), %.3f (instanced)\n", i + 1, rigid[i], instanced[i]);
    if (rigid.size() != size_t{moved} || instanced.size() != size_t{moved}) return;
    // The trail sums every pixel the sphere has left, so it grows with the move: 0.46 (rigid) and 0.22 (instanced) after 8
    // frames of one pixel each, and nothing before the third frame. A history that outlives the object (no disocclusion test)
    // holds the sphere's colour where it was and keeps a whole contrast per pixel it left, which is well above these bounds.
    CHECK(rigid.front() < 0.05 && instanced.front() < 0.05);
    CHECK(rigid.back() < 0.7 && instanced.back() < 0.4);
}

// The same field seen by a camera that slides: the history is read where the camera's own motion moved it, so the bars keep
// their contrast. A history read at the wrong place blends neighbouring bars into grey. The measure is the spread of the red
// channel (its standard deviation) once the camera has slid for 40 frames, over the spread with the camera still.
void traaCameraPan() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    CHECK(rendersPixels(context));
    if (!rendersPixels(context)) return;
    constexpr uint32_t width = 64, height = 48;
    constexpr int frames = 40;
    BarField field;
    shader::StandardMaterial white;
    white.color = {1, 1, 1};
    DrawItem bars;
    bars.key = bars.id = 2; bars.kind = MaterialKind::Basic;
    bars.positions = &field.positions; bars.indices = &field.indices; bars.material = &white;
    bars.matrixWorld = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
    // `camera(aspect)` moved by `x` along its own x axis.
    const auto at = [&](double x) {
        CameraState c = camera(double(width) / height);
        c.matrixWorld = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 4, 1};
        c.matrixWorldInverse = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -x, 0, -4, 1};
        return c;
    };
    const auto spread = [&](double per, bool temporal) {
        EventQueue events;
        Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
        renderer.setSize(width, height);
        renderer.setOutput(OutputState{std::nullopt, 1, false});
        if (temporal) renderer.setPostGraph(temporalColour());
        for (int frame = 0; frame < frames; ++frame)
            renderer.render({&bars, 1}, at(per * frame), LightState{}, {0, 0, 0, 1});
        const auto pixels = read(renderer, events);
        CHECK(pixels.size() == size_t{width} * height * 4);
        if (pixels.size() != size_t{width} * height * 4) return -1.0;
        double sum = 0, squares = 0;
        int count = 0;
        for (int y = 4; y < int(height) - 4; ++y)
            for (int x = 4; x < int(width) - 4; ++x) {
                const double v = pixels[(size_t(y) * width + x) * 4];
                sum += v; squares += v * v; ++count;
            }
        const double mean = sum / count;
        return std::sqrt(std::max(0.0, squares / count - mean * mean));
    };
    // One pixel per frame at the bars' depth: 0.1 of a world unit is 1.03 pixels here. The bars span 32 units, so 40 frames at
    // up to 0.15 stay inside them.
    const double hard = spread(0, false), still = spread(0, true), slow = spread(0.05, true), fast = spread(0.1, true), quick = spread(0.15, true);
    std::fprintf(stderr, "TN_DEBUG pan, spread of the red channel: hard %.1f, temporal still %.1f, half a pixel a frame %.1f, a pixel %.1f, a pixel and a half %.1f\n", hard, still, slow, fast, quick);
    // The resolve softens the bars' edges (still keeps 78 percent of the hard spread here) and a pan blurs a little more where
    // the history lands between two texels (half a pixel keeps 62 percent of still, a whole pixel 80). A history read where
    // the camera was, not where the camera's motion put it, blends neighbouring bars into grey and collapses all three.
    CHECK(hard > 0 && still > 0.7 * hard);
    CHECK(slow > 0.5 * still && fast > 0.6 * still && quick > 0.5 * still);
}

// OrthographicCamera(-2, 2, 1, -1, 0.1, 10) at z = 5, in WebGPU clip z.
CameraState wideOrtho() {
    CameraState camera;
    camera.matrixWorldInverse = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -5, 1};
    camera.projectionMatrix = {0.5, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1 / 9.9, 0, 0, 0, -0.1 / 9.9, 1};
    return camera;
}

// The alpha-transparency fixture, natively: MeshBasicMaterial planes under OrthographicCamera(-2, 2,
// 1, -1, 0.1, 10) at z = 5, 256x128, no tone mapping. Transparent planes are listed front-most
// first, so only three's back-to-front sort gets the blend right, and a renderOrder pair checks
// that renderOrder outranks depth while depthWrite stays on.
void alphaTransparency() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(256, 128);
    const auto big = plane(1.6, 1.6), small = plane(1, 1);
    struct Plane {
        Sphere* geometry;
        std::array<float, 3> color;
        bool transparent;
        float opacity;
        double x, z;
        int renderOrder;
    };
    const Plane planes[] = {{big.get(), {0, 0, 1}, true, 0.5f, 0.2, 0.5, 0},       {big.get(), {0, 1, 0}, true, 0.5f, -0.3, 0, 0},
                            {big.get(), {1, 0, 0}, false, 1, -0.8, -0.5, 0},       {small.get(), {1, 0, 1}, true, 0.6f, 1.35, -0.4, 2},
                            {small.get(), {1, 1, 0}, true, 0.6f, 1.0, 0.4, 1}};
    shader::StandardMaterial materials[5];
    std::vector<DrawItem> items(5);
    for (int k = 0; k < 5; ++k) {
        materials[k].color = planes[k].color;
        materials[k].opacity = planes[k].opacity;
        DrawItem& d = items[k];
        d.key = d.id = k + 1;  // creation order, as Object3D.id counts
        d.kind = MaterialKind::Basic;
        d.positions = &planes[k].geometry->positions;
        d.indices = &planes[k].geometry->indices;
        d.material = &materials[k];
        d.transparent = planes[k].transparent;
        d.renderOrder = planes[k].renderOrder;
        d.matrixWorld = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, planes[k].x, 0, planes[k].z, 1};
    }
    renderer.render(items, wideOrtho(), LightState{}, {0.1, 0.1, 0.1, 1});
    const std::vector<uint8_t> px = read(renderer, events);
    if (const char* out = std::getenv("TN_RENDER_OUT"); out && px.size() == 256 * 128 * 4)
        stbi_write_png(out, 256, 128, 4, px.data(), 256 * 4);
    int worst = 0;
    const double off = goldenMismatch(px, "alpha-transparency", 256, 128, 1, worst);
    std::printf("alpha-transparency vs browser: worst %d, %.3f%% of channels over 1\n", worst, off * 100);
    CHECK(worst <= 2 && off < 0.001);
}

// The alpha-test fixture: tiles over an opaque red wall. alphaTest 0.5 discards opacity 0.4 (opaque)
// and 0.45 (transparent); opacity 0.6 stays and is drawn opaque; an opaque material ignores its
// opacity 0.3; a transparent tile at 0.55 passes the test and blends.
void alphaTest() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(256, 128);
    const auto wall = plane(4, 1.2), tile = plane(0.7, 0.7);
    struct Tile {
        std::array<float, 3> color;
        bool transparent;
        float opacity, alphaTest;
        double x;
    };
    const Tile tiles[] = {{{0, 1, 0}, false, 0.4f, 0.5f, -1.6}, {{0, 0, 1}, false, 0.6f, 0.5f, -0.8},
                          {{1, 1, 0}, false, 0.3f, 0, 0},       {{1, 0, 1}, true, 0.45f, 0.5f, 0.8},
                          {{0, 1, 1}, true, 0.55f, 0.5f, 1.6}};
    shader::StandardMaterial materials[6];
    std::vector<DrawItem> items(6);
    materials[0].color = {1, 0, 0};
    items[0].positions = &wall->positions;
    items[0].indices = &wall->indices;
    items[0].matrixWorld = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -0.5, 1};
    for (int k = 0; k < 5; ++k) {
        materials[k + 1].color = tiles[k].color;
        materials[k + 1].opacity = tiles[k].opacity;
        materials[k + 1].alphaTest = tiles[k].alphaTest;
        DrawItem& d = items[k + 1];
        d.positions = &tile->positions;
        d.indices = &tile->indices;
        d.transparent = tiles[k].transparent;
        d.matrixWorld = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, tiles[k].x, 0, 0, 1};
    }
    for (int k = 0; k < 6; ++k) {
        items[k].key = items[k].id = k + 1;
        items[k].kind = MaterialKind::Basic;
        items[k].material = &materials[k];
    }
    renderer.render(items, wideOrtho(), LightState{}, {0.1, 0.1, 0.1, 1});
    const std::vector<uint8_t> px = read(renderer, events);
    int worst = 0;
    const double off = goldenMismatch(px, "alpha-test", 256, 128, 1, worst);
    std::printf("alpha-test vs browser: worst %d, %.3f%% of channels over 1\n", worst, off * 100);
    CHECK(worst <= 2 && off < 0.001);
}

// Every uploaded mipmapped texture used to cost its own queue submit and work-done callback; the
// chains of all textures uploaded before a frame now go out as one command buffer. The first frame
// of five distinct textures submits exactly what one texture's does.
void mipmapsShareOneSubmit() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    const auto firstFrameSubmits = [&](int textureCount) {
        EventQueue events;
        Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
        renderer.setSize(64, 32);
        const auto geometry = plane(0.4, 0.4);
        BufferStore uvs(Scalar::F32, 8);
        const float uv[8] = {0, 1, 1, 1, 0, 0, 1, 0};
        uvs.write(0, uv, sizeof uv);
        std::vector<std::shared_ptr<DataTexture>> textures;
        shader::StandardMaterial materials[8];
        std::vector<DrawItem> items(textureCount);
        for (int k = 0; k < textureCount; ++k) {
            auto texture = std::make_shared<DataTexture>();
            texture->width = texture->height = 32;
            texture->generateMipmaps = true;
            texture->minFilter = static_cast<uint16_t>(TextureFilter::LinearMipmapLinear);
            texture->data.assign(32 * 32 * 4, static_cast<uint8_t>(40 * k + 20));
            texture->needsUpdate();
            textures.push_back(texture);
            DrawItem& d = items[k];
            d.key = d.id = k + 1;
            d.kind = MaterialKind::Basic;
            d.positions = &geometry->positions;
            d.indices = &geometry->indices;
            d.uvs = &uvs;
            d.material = &materials[k];
            d.map = texture.get();
            d.matrixWorld = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.1 * k, 0, 0, 1};
        }
        const uint64_t before = renderer.gpu().submittedSerial();
        renderer.render(items, wideOrtho(), LightState{}, {0.1, 0.1, 0.1, 1});
        const uint64_t submits = renderer.gpu().submittedSerial() - before;
        // Replacing a later draw's map must preserve the earlier draw's selected bind group.
        textures.back()->needsUpdate();
        renderer.render(items, wideOrtho(), LightState{}, {0.1, 0.1, 0.1, 1});
        CHECK(renderer.lastFrame().draws == uint32_t(textureCount) + 1);
        renderer.render(items, wideOrtho(), LightState{}, {0.1, 0.1, 0.1, 1});
        return submits;
    };
    const uint64_t one = firstFrameSubmits(1), five = firstFrameSubmits(5);
    std::printf("first-frame submits: 1 texture %llu, 5 textures %llu\n", (unsigned long long)one,
                (unsigned long long)five);
    CHECK(one > 0);
    CHECK(five == one);
}

// Read the HDR target itself, so tone mapping cannot hide a lost emissive term.
void emissivePass(bool requirePixels) {
    mystral::webgpu::Context context;
    const bool initialized = context.initializeHeadless();
    CHECK(initialized);
    if (!initialized) return;
    WGPUAdapterInfo info{};
    wgpuAdapterGetInfo(context.getAdapter(), &info);
    const bool rendersPixels = info.backendType != WGPUBackendType_Null;
    wgpuAdapterInfoFreeMembers(info);
    if (requirePixels) {
        CHECK(rendersPixels);
        if (!rendersPixels) return;
    }
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    renderer.setSize(16, 16);
    renderer.setOutput(OutputState{shader::ToneMapping::Linear, 1, false});
    namespace g = shader::graph;
    renderer.setPostGraph(g::bloom(g::texture("emissive", g::uv()), 0, 0, 0));
    CHECK(renderer.readEmissivePixels([](GpuStatus, std::vector<uint8_t>) {}) == GpuStatus::InvalidHandle);
    const auto geometry = plane(4, 4);
    shader::StandardMaterial material;
    material.emissive = {1, 0.5f, 0};
    material.emissiveIntensity = 4;
    DrawItem item;
    item.key = item.id = 1;
    item.kind = MaterialKind::Standard;
    item.positions = &geometry->positions; item.normals = &geometry->normals; item.indices = &geometry->indices;
    item.material = &material;
    item.matrixWorld = {1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1};
    for (int mode = 0; mode < 3; ++mode) {
        if (mode == 1) material.emissiveIntensity = 0;
        if (mode == 2) { item.kind = MaterialKind::Basic; material.emissiveIntensity = 4; }
        renderer.render(std::span<const DrawItem>(&item, 1), camera(1), LightState{}, {0,0,0,0});
        bool done = false;
        std::vector<uint8_t> pixels;
        const auto status = renderer.readEmissivePixels([&](GpuStatus status, std::vector<uint8_t> bytes) {
            CHECK(status == GpuStatus::Ok);
            pixels = std::move(bytes); done = true;
        });
        CHECK(status == GpuStatus::Ok);
        if (status != GpuStatus::Ok) continue;
        for (int i = 0; i < 4000 && !done; ++i) {
            renderer.poll(); events.drain();
            if (!done) std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
        CHECK(done && pixels.size() == 16 * 16 * 8);
        if (!rendersPixels || pixels.size() != 16 * 16 * 8) continue;
        const uint16_t expected[] = {uint16_t(mode == 0 ? 0x4400 : 0), uint16_t(mode == 0 ? 0x4000 : 0), 0};
        for (int lane = 0; lane < 3; ++lane) {
            const size_t offset = (8 * 16 + 8) * 8 + lane * 2;
            const uint16_t half = uint16_t(pixels[offset]) | (uint16_t(pixels[offset + 1]) << 8);
            CHECK(half == expected[lane]);
        }
    }
}

void emissiveTarget() { emissivePass(true); }
void emissiveValidation() { emissivePass(false); }

}  // namespace

TN_TEST_MAIN({"resize_readback", resizeReadback}, {"emissive_target", emissiveTarget}, {"emissive_validation", emissiveValidation}, {"output_ramp", outputRamp},
             {"traa_alpha", traaAlpha},
             {"traa_reset_seed", traaResetSeed},
             {"traa_camera_velocity", traaCameraVelocity},
             {"traa_feeds_the_chain", traaFeedsTheChain},
             {"velocity_needs_traa", velocityNeedsTraa},
             {"traa_replaces_multisampling", traaReplacesMultisampling},
             {"traa_converges_edges", traaConvergesEdges},
             {"traa_late_resolve", traaLateResolve},
             {"sibling_reads_the_live_scene", siblingReadsTheLiveScene},
             {"traa_ghosting", traaGhosting},
             {"traa_camera_pan", traaCameraPan},
             {"output_screen_size", outputScreenSize},
#if defined(MYSTRAL_WEBGPU_DAWN)
             {"traa_validation", traaValidation},
#endif
             {"lit_reference", litReference},
             {"lambert_reference", lambertReference},
             {"phong_reference", phongReference},
             {"physical_reference", physicalReference},
             {"alpha_transparency", alphaTransparency},
             {"alpha_test", alphaTest},
             {"mipmaps_share_one_submit", mipmapsShareOneSubmit})
