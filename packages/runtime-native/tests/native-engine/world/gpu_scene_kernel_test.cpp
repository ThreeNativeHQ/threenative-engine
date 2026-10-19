// PRD-519 phase 3: the GPU cull and LOD kernel (engine/world/gpu_scene/cull_kernel.h) selects the
// same instances as the ported `cullAndSelect` / `cullAndSelectShadow` oracle, on every recorded
// step of gpu_scene_reference.inc (the spec's walk, a gate path forward and back, biased-LOD steps,
// two shadow levels). Per step: the draw args equal the oracle's word for word, and every matrix the
// kernel wrote into a key's run is a distinct one of the instances that key selects, within f32
// rounding of the matrix product. With no overflow that is the oracle's run exactly; when a key's
// candidates outrun its capacity, the GPU's atomic order picks which `capacity` of them are drawn.
#include "check.h"
#include "engine/renderer/compute.h"
#include "engine/renderer/lod/model_lod.h"
#include "engine/world/gpu_scene/cull_kernel.h"
#include "mystral/webgpu/context.h"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <iterator>
#include <thread>
#include <vector>

#include "gpu_scene_reference.h"

using namespace tn::engine;

namespace {

// f32 rounding of a 4x4 product: the oracle sums in double, the GPU in f32 (maybe fused).
bool close(float got, float want) { return std::fabs(got - want) <= 1e-5f * std::max(1.0f, std::fabs(want)); }

struct Gpu {
    mystral::webgpu::Context context;
    EventQueue events;
    std::unique_ptr<GpuResources> resources;

    std::vector<uint8_t> read(Handle buffer, uint64_t bytes) {
        std::vector<uint8_t> got;
        bool done = false;
        resources->readBuffer(buffer, 0, bytes, [&](GpuStatus s, std::vector<uint8_t> b) {
            CHECK(s == GpuStatus::Ok);
            got = std::move(b);
            done = true;
        });
        for (int i = 0; i < 4000 && !done; ++i) {
            resources->poll();
            events.drain();
            if (!done) std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
        CHECK(done && got.size() == bytes);
        return got;
    }

    template <typename T> Handle upload(std::vector<T> words, std::size_t minimum) {
        words.resize(std::max(words.size(), minimum));
        const uint64_t bytes = words.size() * sizeof(T);
        const Handle h = resources->createBuffer(bytes, WGPUBufferUsage_Storage | WGPUBufferUsage_CopySrc | WGPUBufferUsage_CopyDst);
        resources->writeBuffer(h, 0, words.data(), bytes);
        return h;
    }
};

bool built(const shader::Program& program, const ComputePass& pass, const char* name) {
    for (const shader::Diagnostic& d : program.diagnostics())
        std::fprintf(stderr, "%s %s %s: %s\n", name, d.code.c_str(), d.node.c_str(), d.reason.c_str());
    if (!pass.error().empty()) std::fprintf(stderr, "%s: %s\n", name, pass.error().c_str());
    return program.diagnostics().empty() && pass.error().empty();
}

void gpuSceneSelect() {
    Gpu gpu;
    CHECK(gpu.context.initializeHeadless());
    gpu.resources = std::make_unique<GpuResources>(gpu.context.getInstance(), gpu.context.getDevice(),
                                                   gpu.context.getQueue(), gpu.events, 1);
    const shader::Program clearProgram = gpuSceneClearKernel();
    const shader::Program mainProgram = gpuSceneCullKernel(false);
    const shader::Program shadowProgram = gpuSceneCullKernel(true);
    const shader::Program clampProgram = gpuSceneClampKernel();
    ComputePass clear(gpu.context.getDevice(), *gpu.resources, clearProgram);
    ComputePass cullMain(gpu.context.getDevice(), *gpu.resources, mainProgram);
    ComputePass cullShadow(gpu.context.getDevice(), *gpu.resources, shadowProgram);
    ComputePass clamp(gpu.context.getDevice(), *gpu.resources, clampProgram);
    CHECK(built(clearProgram, clear, "clear") && built(mainProgram, cullMain, "cull") &&
          built(shadowProgram, cullShadow, "shadow cull") && built(clampProgram, clamp, "clamp"));

    std::size_t steps = 0, differ = 0, instances = 0, overflowed = 0, inexact = 0;
    for (std::size_t sceneIndex = 0; sceneIndex < std::size(kGpuSceneScenes); ++sceneIndex) {
        const RefScene& ref = kGpuSceneScenes[sceneIndex];
        GpuSceneInput input;
        for (std::size_t i = 0; i < ref.placementCount; ++i) input.placements.push_back(buildPlacement(ref.placements[i]));
        input.count = ref.count;
        for (std::size_t i = 0; i < ref.slotCount; ++i) input.slots.push_back(buildSlot(ref.slots[i]));
        for (std::size_t i = 0; i < ref.regionCount; ++i) input.regions.push_back(buildRegion(ref.regions[i]));
        input.regionCount = static_cast<uint32_t>(ref.regionCount);
        // Every key's whole candidate list: the same selection with room for every placement.
        GpuSceneInput roomy = input;
        const uint32_t room = static_cast<uint32_t>(std::max<std::size_t>(1, input.placements.size()));
        for (std::size_t i = 0; i < roomy.regions.size(); ++i) {
            roomy.regions[i].start = static_cast<uint32_t>(i) * room;
            roomy.regions[i].capacity = room;
        }

        for (std::size_t stepIndex = 0; stepIndex < ref.stepCount; ++stepIndex) {
            const RefStep& step = ref.steps[stepIndex];
            input.camera = roomy.camera = buildCamera(step.camera);
            const GpuSceneShadowLevel shadowLevel = buildShadow(step.shadowLevel);
            const double bias = doubleFromBits(step.bias);
            lod::setLodBias(bias);
            const GpuSceneResult want = step.shadow ? cullAndSelectShadow(input, shadowLevel) : cullAndSelect(input);
            const GpuSceneResult every = step.shadow ? cullAndSelectShadow(roomy, shadowLevel) : cullAndSelect(roomy);
            lod::setLodBias(1);

            const GpuSceneTables t = packGpuScene(input, step.shadow ? &shadowLevel : nullptr, bias);
            const Handle buffers[] = {gpu.upload(t.params, 4),  gpu.upload(t.matrices, 16), gpu.upload(t.centres, 4),
                                      gpu.upload(t.info, 4),    gpu.upload(t.gates, 4),     gpu.upload(t.levels, 4),
                                      gpu.upload(t.keys, 4),    gpu.upload(t.locals, 16),   gpu.upload(t.args, 4),
                                      gpu.upload(std::vector<float>(std::size_t{t.drawnCapacity} * 16), 16)};
            const Handle keyed[] = {buffers[0], buffers[6], buffers[8]};
            WGPUCommandEncoderDescriptor encoderDesc = {};
            WGPUCommandEncoder encoder = wgpuDeviceCreateCommandEncoder(gpu.context.getDevice(), &encoderDesc);
            bool recorded = clear.dispatch(encoder, keyed, std::max(1u, t.keyCount));
            recorded = recorded && (step.shadow ? cullShadow : cullMain)
                                       .dispatch(encoder, buffers, std::max<uint32_t>(1, static_cast<uint32_t>(input.placements.size())));
            recorded = recorded && clamp.dispatch(encoder, keyed, std::max(1u, t.keyCount));
            CHECK(recorded);
            WGPUCommandBufferDescriptor commandDesc = {};
            gpu.resources->submit(wgpuCommandEncoderFinish(encoder, &commandDesc));
            wgpuCommandEncoderRelease(encoder);
            const std::vector<uint8_t> argBytes = gpu.read(buffers[8], t.args.size() * 4);
            const std::vector<uint8_t> drawnBytes = gpu.read(buffers[9], std::max<uint64_t>(16, uint64_t{t.drawnCapacity} * 16) * 4);
            for (const Handle h : buffers) gpu.resources->destroy(h);
            ++steps;
            if (argBytes.size() != t.args.size() * 4) {
                ++differ;
                continue;
            }
            std::vector<uint32_t> args(t.args.size());
            std::memcpy(args.data(), argBytes.data(), argBytes.size());
            std::vector<float> drawn(drawnBytes.size() / 4);
            std::memcpy(drawn.data(), drawnBytes.data(), drawnBytes.size());

            std::string why = args == want.args ? "" : "args";
            for (std::size_t r = 0; r < input.regions.size() && why.empty(); ++r) {
                const GpuSceneRegion& region = input.regions[r];
                const uint32_t count = want.counts[r];
                const uint32_t candidates = every.counts[r];
                overflowed += candidates > region.capacity;
                std::vector<bool> used(candidates, false);
                for (uint32_t n = 0; n < count && why.empty(); ++n) {
                    const float* got = &drawn[(std::size_t{region.start} + n) * 16];
                    bool matched = false;
                    for (uint32_t c = 0; c < candidates && !matched; ++c) {
                        if (used[c]) continue;
                        const float* option = &every.drawn[(std::size_t{roomy.regions[r].start} + c) * 16];
                        bool same = true, exact = true;
                        for (int w = 0; w < 16 && same; ++w) {
                            same = close(got[w], option[w]);
                            exact = exact && got[w] == option[w];
                        }
                        if (same) {
                            used[c] = matched = true;
                            inexact += !exact;
                        }
                    }
                    if (!matched) why = "region " + std::to_string(r) + " instance " + std::to_string(n);
                    ++instances;
                }
            }
            if (!why.empty()) {
                ++differ;
                std::fprintf(stderr, "scene %zu step %zu (%s) differs: %s\n", sceneIndex, stepIndex,
                             step.shadow ? "shadow" : "main", why.c_str());
            }
        }
    }
    std::printf("gpu scene select: %zu steps, %zu differ; %zu instances, %zu keys overflowed, %zu matrices "
                "within f32 rounding rather than bit-equal\n",
                steps, differ, instances, overflowed, inexact);
    CHECK(steps > 0 && differ == 0);
}

}  // namespace

TN_TEST_MAIN({"gpu_scene_select", gpuSceneSelect})
