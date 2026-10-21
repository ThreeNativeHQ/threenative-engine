#include "check.h"
#include "fixture/traa_dump.h"
#include "engine/renderer/render_database.h"
#include "engine/scene/geometries.h"
#include "engine/scene/texture.h"
#include "engine/renderer/renderer.h"
#include "engine/renderer/post/traa.h"
#include "engine/shader/graph/post_effects.h"
#include "mystral/webgpu/context.h"

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

}  // namespace

TN_TEST_MAIN({"resize_readback", resizeReadback}, {"output_ramp", outputRamp},
             {"traa_alpha", traaAlpha},
             {"traa_reset_seed", traaResetSeed},
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
