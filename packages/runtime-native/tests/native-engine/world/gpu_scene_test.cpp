// PRD-521: every recorded `cullAndSelect`, `cullAndSelectShadow` and `liveKeyInstances` result
// reproduces over the native GPU-scene CPU oracle. The table is generated from
// packages/core/src/world-gpu-scene.ts (packages/runtime-native/tests/native-engine/world/
// gpu-scene-reference.ts): each scene is a placement buffer, a slot/region table and a list of
// camera (and shadow) steps, and the reference's own result for each. Every f32 word is stored as
// its 32-bit pattern and every double as its 64-bit pattern and compares bit for bit, except that
// any two NaNs are equal.
#include "check.h"
#include "engine/renderer/lod/model_lod.h"
#include "engine/world/gpu_scene/gpu_scene.h"

#include <bit>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <iterator>
#include <string>
#include <string_view>
#include <vector>

using namespace tn::engine::world;

#include "gpu_scene_reference.h"

namespace {

void gpuScene() {
    std::size_t compared = 0;
    std::size_t mismatched = 0;

    for (std::size_t sceneIndex = 0; sceneIndex < std::size(kGpuSceneScenes); ++sceneIndex) {
        const RefScene& ref = kGpuSceneScenes[sceneIndex];
        GpuSceneInput input;
        input.placements.reserve(ref.placementCount);
        for (std::size_t i = 0; i < ref.placementCount; ++i)
            input.placements.push_back(buildPlacement(ref.placements[i]));
        input.count = ref.count;
        input.slots.reserve(ref.slotCount);
        for (std::size_t i = 0; i < ref.slotCount; ++i)
            input.slots.push_back(buildSlot(ref.slots[i]));
        input.regions.reserve(ref.regionCount);
        for (std::size_t i = 0; i < ref.regionCount; ++i)
            input.regions.push_back(buildRegion(ref.regions[i]));
        input.regionCount = static_cast<uint32_t>(ref.regionCount);

        for (std::size_t stepIndex = 0; stepIndex < ref.stepCount; ++stepIndex) {
            const RefStep& step = ref.steps[stepIndex];
            input.camera = buildCamera(step.camera);
            tn::engine::lod::setLodBias(doubleFromBits(step.bias));
            const GpuSceneResult got =
                step.shadow ? cullAndSelectShadow(input, buildShadow(step.shadowLevel))
                            : cullAndSelect(input);
            tn::engine::lod::setLodBias(1);
            ++compared;

            bool ok = true;
            for (std::size_t i = 0; i < ref.regionCount * kGpuSceneDrawArgsWords && ok; ++i)
                ok = got.args[i] == step.args[i];
            for (std::size_t regionIndex = 0; regionIndex < ref.regionCount && ok; ++regionIndex) {
                const RefRun& run = step.runs[regionIndex];
                if (got.counts[regionIndex] != step.counts[regionIndex] || got.counts[regionIndex] != run.count) {
                    ok = false;
                    break;
                }
                for (uint32_t taken = 0; taken < run.count && ok; ++taken) {
                    const std::size_t at = (static_cast<std::size_t>(ref.regions[regionIndex].start) + taken) * 16;
                    for (std::size_t word = 0; word < 16 && ok; ++word)
                        ok = sameFloat(got.drawn[at + word], floatFromBits(run.words[taken * 16 + word]));
                }
            }
            if (!ok) {
                ++mismatched;
                std::fprintf(stderr, "scene %zu step %zu differed\n", sceneIndex, stepIndex);
            }
        }
    }

    {
        const RefLiveCase& ref = kGpuSceneLive;
        std::vector<GpuScenePlacement> placements;
        placements.reserve(ref.placementCount);
        for (std::size_t i = 0; i < ref.placementCount; ++i)
            placements.push_back(buildPlacement(ref.placements[i]));
        std::vector<GpuSceneLiveAsset> assets;
        assets.reserve(ref.assetCount);
        for (std::size_t i = 0; i < ref.assetCount; ++i) {
            const RefLiveAsset& source = ref.assets[i];
            GpuSceneLiveAsset asset;
            asset.id = std::string_view(source.id);
            asset.distances.reserve(source.distanceCount);
            for (std::size_t d = 0; d < source.distanceCount; ++d)
                asset.distances.push_back(doubleFromBits(source.distances[d]));
            asset.hasCull = source.hasCull;
            asset.cull = doubleFromBits(source.cull);
            asset.impostor = source.impostor;
            for (std::size_t level = 0; level < source.levelCount; ++level) {
                const RefLiveLevel& parts = source.levels[level];
                std::vector<std::array<float, kGpuSceneLocalWords>> locals;
                locals.reserve(parts.partCount);
                for (std::size_t part = 0; part < parts.partCount; ++part) {
                    std::array<float, kGpuSceneLocalWords> local{};
                    for (std::size_t word = 0; word < 16; ++word)
                        local[word] = floatFromBits(parts.words[part * 16 + word]);
                    locals.push_back(local);
                }
                asset.locals.push_back(std::move(locals));
            }
            assets.push_back(std::move(asset));
        }
        const std::vector<GpuSceneLiveRun> got =
            liveKeyInstances(placements, assets, buildCamera(ref.camera));
        ++compared;
        bool ok = got.size() == ref.runCount;
        if (ok)
            for (std::size_t i = 0; i < ref.runCount; ++i) {
                if (got[i].key != ref.runs[i].key || got[i].words.size() != ref.runs[i].wordCount) {
                    ok = false;
                    break;
                }
                for (std::size_t word = 0; word < ref.runs[i].wordCount; ++word)
                    if (!sameFloat(got[i].words[word], floatFromBits(ref.runs[i].words[word]))) {
                        ok = false;
                        break;
                    }
            }
        if (!ok) {
            ++mismatched;
            std::fprintf(stderr, "live case differed\n");
        }
    }

    std::printf("gpu scene: %zu steps, %zu differ\n", compared, mismatched);
    CHECK(compared > 0 && mismatched == 0);
}

} // namespace

TN_TEST_MAIN({"gpu_scene", gpuScene})
