// The TSL compute programs of programs.js, authored with the native builder and run on the device,
// against compute_reference.json (recorded from the pinned three in headed Chromium's WebGPU):
//   instance_grid      PRD-513: one pass writes 10,000 instance positions.
//   particles_lifetime PRD-527: GPUParticles3D with a game emitter; after the same seed and 90 ticks
//                      every particle's life and generation are equal, so emission, lifetime and
//                      recycling counts are; positions within f32 rounding.
#include "check.h"
#include "engine/foundation/json.h"
#include "engine/renderer/compute.h"
#include "engine/world/particles/gpu_particles.h"
#include "engine/world/fluids/fluid_field.h"
#include "engine/world/fluids/fluid_particles.h"
#include "engine/shader/sprite.h"
#include "engine/renderer/render_database.h"
#include "mystral/webgpu/context.h"

#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iterator>
#include <thread>
#include <vector>

using namespace tn::engine;
using namespace tn::engine::shader;
using namespace tn::engine::shader::tsl;

namespace {

constexpr uint32_t kGridCount = 10000;
constexpr uint32_t kParticleAmount = 256;
constexpr int kParticleTicks = 90;
constexpr uint32_t kParticleSeed = 1337;

std::vector<float> decode(const std::string& base64) {
    static const std::string alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::vector<uint8_t> bytes;
    uint32_t buffer = 0;
    int bits = 0;
    for (const char c : base64) {
        const auto at = alphabet.find(c);
        if (at == std::string::npos) continue;  // '=' padding
        buffer = (buffer << 6) | static_cast<uint32_t>(at);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            bytes.push_back(static_cast<uint8_t>(buffer >> bits));
        }
    }
    std::vector<float> out(bytes.size() / 4);
    std::memcpy(out.data(), bytes.data(), out.size() * 4);
    return out;
}

std::vector<float> reference(const char* program, const char* buffer) {
    std::ifstream in(TN_COMPUTE_REFERENCE, std::ios::binary);
    const std::string text((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
    json::Value root;
    json::Error error;
    CHECK(json::parse(text, root, error));
    const json::Value* programs = root.find("programs");
    const json::Value* entry = programs != nullptr ? programs->find(program) : nullptr;
    const json::Value* data = entry != nullptr ? entry->find(buffer) : nullptr;
    CHECK(data != nullptr);
    return data != nullptr ? decode(data->string()) : std::vector<float>{};
}

struct Device {
    mystral::webgpu::Context context;
    EventQueue events;
    std::unique_ptr<GpuResources> gpu;

    Device() {
        CHECK(context.initializeHeadless());
        gpu = std::make_unique<GpuResources>(context.getInstance(), context.getDevice(), context.getQueue(), events, 1);
    }
    WGPUCommandEncoder encoder() {
        WGPUCommandEncoderDescriptor desc = {};
        return wgpuDeviceCreateCommandEncoder(context.getDevice(), &desc);
    }
    void submit(WGPUCommandEncoder encoder) {
        WGPUCommandBufferDescriptor desc = {};
        gpu->submit(wgpuCommandEncoderFinish(encoder, &desc));
        wgpuCommandEncoderRelease(encoder);
    }
    std::vector<float> read(Handle buffer, uint64_t floats) {
        std::vector<float> out;
        bool done = false;
        gpu->readBuffer(buffer, 0, floats * 4, [&](GpuStatus s, std::vector<uint8_t> bytes) {
            CHECK(s == GpuStatus::Ok);
            out.resize(bytes.size() / 4);
            std::memcpy(out.data(), bytes.data(), out.size() * 4);
            done = true;
        });
        for (int i = 0; i < 4000 && !done; ++i) {
            gpu->poll();
            events.drain();
            if (!done) std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
        CHECK(done);
        return out;
    }
    Handle storage(uint64_t floats) {
        const uint64_t bytes = floats * 4;
        const Handle h = gpu->createBuffer(bytes, WGPUBufferUsage_Storage | WGPUBufferUsage_CopySrc | WGPUBufferUsage_CopyDst);
        const std::vector<uint8_t> zeros(bytes, 0);
        gpu->writeBuffer(h, 0, zeros.data(), bytes);
        return h;
    }
};

/** Equal, or both within f32 rounding of each other; counts how many were not bit-equal. */
size_t compare(const std::vector<float>& got, const std::vector<float>& want, float tolerance, size_t& inexact) {
    size_t differ = got.size() == want.size() ? 0 : 1;
    for (size_t i = 0; i < std::min(got.size(), want.size()); ++i) {
        if (got[i] == want[i]) continue;
        if (std::fabs(got[i] - want[i]) <= tolerance * std::max(1.0f, std::fabs(want[i]))) ++inexact;
        else ++differ;
    }
    return differ;
}

Node lcg(Node state) { return state.mul(uint_(1664525)).add(uint_(1013904223)); }
Node modulo(Node value, uint32_t n) { return value.sub(value.div(uint_(n)).mul(uint_(n))); }

void instanceGrid() {
    Device device;
    Program program(Stage::Compute);
    {
        Build build(program);
        const Storage positions = storage("positions", Type::vec(4));
        const Node time = uniform("time", Type::f32());
        Fn([&] {
            If(instanceIndex().lessThan(uint_(kGridCount)), [&] {
                const Node row = instanceIndex().div(uint_(100));
                const Node column = float_(instanceIndex().sub(row.mul(uint_(100))));
                positions.element(instanceIndex())
                    .assign(vec4({column.mul(0.5), sin(column.mul(0.25).add(time)), float_(row).mul(0.5), 1}));
            });
        });
    }
    for (const Diagnostic& d : program.diagnostics()) std::fprintf(stderr, "%s %s: %s\n", d.code.c_str(), d.node.c_str(), d.reason.c_str());
    ComputePass pass(device.context.getDevice(), *device.gpu, program);
    CHECK(program.ok() && pass.error().empty());
    const Handle positions = device.storage(uint64_t{kGridCount} * 4);
    WGPUCommandEncoder encoder = device.encoder();
    const Handle storage[] = {positions};
    CHECK(pass.dispatch(encoder, storage, kGridCount, {{"time", 0.75}}));
    device.submit(encoder);
    const auto got = device.read(positions, uint64_t{kGridCount} * 4);
    const auto want = reference("instance-grid", "positions");
    // WGSL sin is implementation-approximated: the Nvidia oracle differs from CPU sin by
    // 2.22e-6, and SwiftShader differs from that oracle by 1.89e-4. Use the corpus's 0.2 mm
    // position bound only for wave heights; grid coordinates and w remain exact.
    size_t differ = got.size() == uint64_t{kGridCount} * 4 && got.size() == want.size() ? 0 : 1;
    float worst = 0;
    for (size_t i = 0; i < std::min(got.size(), want.size()); ++i) {
        const float error = std::fabs(got[i] - want[i]);
        const float tolerance = i % 4 == 1 ? 2e-4f : 0;
        if (!std::isfinite(got[i]) || !std::isfinite(want[i]) || !(error <= tolerance)) ++differ;
        worst = std::max(worst, error);
    }
    std::printf("instance grid: %u positions, %zu components differ, max absolute error %.9g\n", kGridCount, differ, worst);
    CHECK(differ == 0);
}

void particlesLifetime() {
    Device device;
    const Handle state = device.storage(uint64_t{kParticleAmount} * 2);
    const auto seed = [](Node generation) {
        return lcg(lcg(instanceIndex().add(uint_(kParticleSeed)).add(generation.mul(uint_(7919)))));
    };
    const auto spawn = [&](Storage positions, Storage velocities, Storage life, Node generation) {
        const Node s = seed(generation);
        life.element(instanceIndex()).assign(vec2({float_(modulo(s, 60).add(uint_(1))), float_(generation)}));
        positions.element(instanceIndex()).assign(vec3({0, 0, 0}));
        const Node x = float_(modulo(s.div(uint_(64)), 200)).sub(100).mul(0.01);
        const Node z = float_(modulo(s.div(uint_(16384)), 200)).sub(100).mul(0.01);
        velocities.element(instanceIndex()).assign(vec3({x, 2, z}));
    };
    world::GpuParticles3D particles(
        device.context.getDevice(), *device.gpu,
        {kParticleAmount,
         [&](Storage positions, Storage velocities) {
             spawn(positions, velocities, storage("state", Type::vec(2)), uint_(0));
         },
         [&](Storage positions, Storage velocities) {
             const Storage life = storage("state", Type::vec(2));
             const Node current = life.element(instanceIndex());
             const Node remaining = current.x().sub(1);
             const Node generation = current.y();
             const Node velocity = velocities.element(instanceIndex());
             positions.element(instanceIndex())
                 .assign(Node(positions.element(instanceIndex())).add(velocity.mul(1.0 / 60)));
             velocities.element(instanceIndex()).assign(velocity.sub(vec3({0, 9.8 / 60, 0})));
             life.element(instanceIndex()).assign(vec2({remaining, generation}));
             If(remaining.lessThan(0.5), [&] { spawn(positions, velocities, life, uint_(generation.add(1))); });
         },
         {state}});
    if (!particles.error().empty()) std::fprintf(stderr, "%s\n", particles.error().c_str());
    CHECK(particles.error().empty());
    WGPUCommandEncoder encoder = device.encoder();
    CHECK(particles.attach(encoder));
    for (int tick = 0; tick < kParticleTicks; ++tick) CHECK(particles.process(encoder));
    device.submit(encoder);

    const std::vector<float> gotState = device.read(state, uint64_t{kParticleAmount} * 2);
    const std::vector<float> wantState = reference("particles", "state");
    size_t inexact = 0;
    const size_t stateDiffer = compare(gotState, wantState, 0, inexact);
    double recycled = 0, wantRecycled = 0;
    for (size_t i = 1; i < gotState.size(); i += 2) recycled += gotState[i];
    for (size_t i = 1; i < wantState.size(); i += 2) wantRecycled += wantState[i];
    size_t positionsInexact = 0;
    const size_t positionsDiffer =
        compare(device.read(particles.positions(), uint64_t{kParticleAmount} * 4), reference("particles", "positions"), 1e-5f, positionsInexact);
    std::printf("particles: %u emitted at start, %.0f recycled (reference %.0f) over %d ticks; %zu state values differ, "
                "%zu position components differ, %zu within f32 rounding\n",
                kParticleAmount, recycled, wantRecycled, kParticleTicks, stateDiffer, positionsDiffer, positionsInexact);
    CHECK(stateDiffer == 0 && positionsDiffer == 0 && recycled == wantRecycled && recycled > 0);
    CHECK(particles.processDispatches() == static_cast<uint32_t>(kParticleTicks));

    // Not emitting, then released: no dispatch either way, as TS's `process` returns early.
    particles.emitting = false;
    WGPUCommandEncoder idle = device.encoder();
    CHECK(particles.process(idle));
    particles.emitting = true;
    particles.release();
    CHECK(particles.process(idle) && particles.processDispatches() == static_cast<uint32_t>(kParticleTicks));
    CHECK(!particles.attach(idle));
    device.submit(idle);
    device.gpu->destroy(state);
}

world::FluidField2D::Options fluidOptions() {
    world::FluidField2D::Options o;
    o.resolution = 16; o.pressureIterations = 5; o.viscosity = 0.03; o.splatRadius = 0.24;
    return o;
}

void fluidIr() {
    const auto o = fluidOptions();
    for (int k = 0; k < world::FluidField2D::Count; ++k) {
        const Program p = world::FluidField2D::kernel(static_cast<world::FluidField2D::Kernel>(k), o);
        for (const Diagnostic& d : p.diagnostics()) std::fprintf(stderr, "%s: %s\n", d.code.c_str(), d.reason.c_str());
        const auto module = buildStage(p, 0);
        CHECK(p.ok() && module.wgsl.ok());
        CHECK(module.wgsl.code.find("texture") == std::string::npos);
        CHECK(module.wgsl.code.find("global_invocation_id") != std::string::npos);
    }
    VertexVariant sprite;
    sprite.sprite = true;
    sprite.nodes.colorNode = graph::vec4({graph::uv(), graph::float_(0.35), graph::float_(1)});
    sprite.positionNode = std::make_shared<PositionNode>(PositionNode{"particle-storage", [](Program& p, ExprId) {
        Build build(p);
        return Node(storage("positions", Type::vec(3)).element(instanceIndex())).id;
    }});
    const auto stages = buildSprite(sprite);
    CHECK(stages.vertex.ok() && stages.fragment.ok());
    CHECK(buildStage(stages.vertex, 0).wgsl.ok() && buildStage(stages.fragment, 1).wgsl.ok());
    const auto vertex = buildStage(stages.vertex, 0);
    CHECK(vertex.wgsl.code.find("instance_index") != std::string::npos);
    CHECK(vertex.wgsl.code.find("s_positions") != std::string::npos);
    Scene scene;
    auto material = std::make_shared<Material>(MaterialType::Basic, true);
    material->spriteMaterial = true; material->rotation = 0.3;
    auto object = std::make_shared<Sprite>(material);
    object->count = 12; object->center.x = 0.3; object->setCastShadow(true);
    scene.add(*object);
    PerspectiveCamera camera(50, 4.0 / 3, 0.1, 50);
    camera.position.set(3, 2, 7); camera.lookAt(Vector3(0, 0, 0));
    RenderDatabase database;
    LightState lights;
    const auto draws = database.prepare(scene, camera, lights);
    CHECK(draws.size() == 1 && database.diagnostics().empty());
    if (draws.size() == 1) {
        CHECK(draws[0].sprite && draws[0].instanceCount == 12 && !draws[0].castShadow);
        CHECK(draws[0].spriteCenter[0] == 0.3 && draws[0].spriteRotation == 0.3);
        CHECK(!draws[0].instanceMatrices && !draws[0].batchable);
    }

}

void fluidField() {
    Device device;
    world::FluidField2D field(device.context.getDevice(), *device.gpu, fluidOptions());
    CHECK(field.error().empty());
    if (!field.error().empty()) { std::fprintf(stderr, "%s\n", field.error().c_str()); return; }
    for (int tick = 0; tick < 6; ++tick) {
        if (tick % 2 == 0) {
            CHECK(field.splat(0.35, 0.45, 0.12, -0.08, 0.7));
            CHECK(field.splat(0.72, 0.65, -0.09, 0.11, 0.4));
        }
        CHECK(field.process());
    }
    CHECK(field.steps() == 6 && field.splatsApplied() == 6);
    // 1e-5 * max(1, |reference|): f32 division/length and fused arithmetic differ across
    // WGSL backends; six steps with five Jacobi iterations accumulate that rounding.
    // No tolerance for changed texel selection: all 16x16 vec4 entries must match.
    for (const auto& entry : {std::pair{"velocity", field.velocity()}, std::pair{"dye", field.dye()}}) {
        const auto got = device.read(entry.second, 16 * 16 * 4);
        const auto want = reference("fluid-field", entry.first);
        size_t inexact = 0;
        const size_t differ = compare(got, want, 1e-5f, inexact);
        std::printf("fluid %s: %zu differ, %zu within 1e-5 f32 tolerance\n", entry.first, differ, inexact);
        CHECK(got.size() == 1024 && differ == 0);
        CHECK(std::any_of(got.begin(), got.end(), [](float v) { return v != 0; }));
    }
    field.release();
    CHECK(field.process() && field.steps() == 6);
}

world::FluidParticles3D::Options fluidParticleOptions() {
    world::FluidParticles3D::Options o;
    o.capacity = 12; o.min = {-1, -1, -1}; o.max = {1, 1, 1}; o.voxelSize = 0.25;
    return o;
}

void fluidParticlesIr() {
    const auto o = fluidParticleOptions();
    CHECK(o.iterations == 3 && o.viscosity == 0.008 && o.cohesion == 0.03 && o.vorticity == 0.015);
    for (int k = 0; k < world::FluidParticles3D::Count; ++k) {
        const Program p = world::FluidParticles3D::kernel(static_cast<world::FluidParticles3D::Kernel>(k), o);
        for (const Diagnostic& d : p.diagnostics()) std::fprintf(stderr, "kernel %d %s: %s\n", k, d.code.c_str(), d.reason.c_str());
        const auto module = buildStage(p, 0);
        for (const std::string& error : module.wgsl.errors) std::fprintf(stderr, "kernel %d: %s\n", k, error.c_str());
        CHECK(p.ok() && module.wgsl.ok());
        CHECK(module.wgsl.code.find("global_invocation_id") != std::string::npos);
        CHECK(module.bindings.size() <= 8);
    }
}

void fluidParticles() {
    Device device;
    auto run = [&](bool broken) {
        auto o = fluidParticleOptions();
        if (broken) o.iterations = 0; // Red control: bypass only the density constraint.
        world::FluidParticles3D fluid(device.context.getDevice(), *device.gpu, o);
        CHECK(fluid.error().empty());
        if (!fluid.error().empty()) { std::fprintf(stderr, "%s\n", fluid.error().c_str()); return std::pair<std::vector<float>, std::vector<float>>{}; }
        for (uint32_t i = 0; i < 12; ++i)
            CHECK(fluid.emit({(int(i % 3) - 1) * 0.1, (int(i / 3 % 2) - 0.5) * 0.1, (int(i / 6) - 0.5) * 0.1},
                {0.1 + (i % 3) * 0.07, 0.25, -0.08 + (i / 6) * 0.1}));
        for (int tick = 0; tick < 6; ++tick) CHECK(fluid.process());
        CHECK(fluid.steps() == 6);
        auto positions = device.read(fluid.positions(), 48), velocities = device.read(fluid.velocities(), 48);
        const auto volume = device.read(fluid.density(), 512);
        CHECK(volume.size() == 512 && std::all_of(volume.begin(), volume.end(), [](float v) { return std::isfinite(v) && v >= 0; }));
        CHECK(std::any_of(volume.begin(), volume.end(), [](float v) { return v > 0; }));
        fluid.release(); CHECK(fluid.process() && fluid.steps() == 6);
        return std::pair{positions, velocities};
    };
    const auto [positions, velocities] = run(false);
    const auto [redPositions, redVelocities] = run(true);
    // Absolute bounds: 0.2 mm on positions, 0.02 m/s on velocity/foam. Atomic grid insertion
    // permutes f32 neighbour sums; pow/sqrt/FMA differ across WGSL backends. Eighteen PBF
    // iterations accumulate rounding, then velocity reconstruction amplifies it by 1/dt = 60.
    // Every component must match; no aggregate error can hide an individual particle failure.
    const auto compareAbsolute = [](const std::vector<float>& got, const std::vector<float>& want, float tolerance) {
        float worst = 0;
        CHECK(got.size() == 48 && want.size() == 48);
        for (size_t i = 0; i < std::min(got.size(), want.size()); ++i) {
            CHECK(std::isfinite(got[i]) && std::isfinite(want[i]));
            worst = std::max(worst, std::fabs(got[i] - want[i]));
        }
        std::printf("fluid particles: max absolute error %.9g, bound %.9g\n", worst, tolerance);
        CHECK(worst <= tolerance);
    };
    const auto wantPositions = reference("fluid-particles", "positions");
    const auto wantVelocities = reference("fluid-particles", "velocities");
    compareAbsolute(positions, wantPositions, 2e-4f);
    compareAbsolute(velocities, wantVelocities, 0.02f);
    compareAbsolute(redPositions, reference("fluid-particles", "unconstrainedPositions"), 2e-4f);
    compareAbsolute(redVelocities, reference("fluid-particles", "unconstrainedVelocities"), 0.02f);
    float redPositionError = 0, redVelocityError = 0;
    for (size_t i = 0; i < std::min(redPositions.size(), wantPositions.size()); ++i)
        redPositionError = std::max(redPositionError, std::fabs(redPositions[i] - wantPositions[i]));
    for (size_t i = 0; i < std::min(redVelocities.size(), wantVelocities.size()); ++i)
        redVelocityError = std::max(redVelocityError, std::fabs(redVelocities[i] - wantVelocities[i]));
    std::printf("density disabled red control: position error %.9g, velocity error %.9g\n", redPositionError, redVelocityError);
    CHECK(redPositionError > 2e-4f && redVelocityError > 0.02f);
}

}  // namespace

TN_TEST_MAIN({"instance_grid", instanceGrid}, {"particles_lifetime", particlesLifetime}, {"fluid_field", fluidField}, {"fluid_ir", fluidIr}, {"fluid_particles", fluidParticles}, {"fluid_particles_ir", fluidParticlesIr})
