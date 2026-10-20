// PRD-526 phase 1: every recorded chain reproduces chain.ts's ordering and per-stage decisions. The
// table is generated from the real `RenderChain` (packages/runtime-native/tests/native-engine/chain/
// chain-reference.ts): each configuration rebuilds the request and compares the planned stage order,
// dropped reasons, contributions, requested order, tier and velocity report. No GPU and no graph.
#include "check.h"
#include "engine/renderer/chain/plan.h"

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <utility>
#include <vector>

using namespace tn::engine::chain;

namespace {

struct StageRow {
    const char* name;
    const char* before;
    const char* after;
    const char* minimumTier;
    uint8_t availability;
    const char* availabilityReason;
    uint8_t build;
    const char* buildError;
    int8_t requiresVelocity;
};

struct DroppedRow {
    const char* name;
    const char* reason;
};

struct ContributionRow {
    const char* name;
    bool changed;
};

struct ChainCase {
    const char* name;
    const char* rendererKind;
    const char* tier;
    bool velocityHasSource;
    const char* velocitySource;
    bool velocityPass;
    bool velocityMrt;
    bool velocityObjectFlags;
    bool velocityPerObject;
    const char* const* request;
    size_t requestCount;
    const StageRow* stages;
    size_t stageCount;
    bool refused;
    const char* error;
    const char* const* requested;
    size_t requestedCount;
    const char* const* appliedStages;
    size_t appliedStageCount;
    const DroppedRow* dropped;
    size_t droppedCount;
    const ContributionRow* contributions;
    size_t contributionCount;
    const char* expectedTier;
    bool velocityProvisioned;
    bool velocityRequired;
    const char* velocityReportSource;
};

#include "chain_reference.inc"

ChainRequest toRequest(const ChainCase& testCase) {
    ChainRequest request;
    request.rendererKind = testCase.rendererKind;
    request.tier = testCase.tier;
    request.velocity.hasSource = testCase.velocityHasSource;
    if (testCase.velocitySource != nullptr)
        request.velocity.source = testCase.velocitySource;
    request.velocity.pass = testCase.velocityPass;
    request.velocity.mrt = testCase.velocityMrt;
    request.velocity.objectFlags = testCase.velocityObjectFlags;
    request.velocity.perObject = testCase.velocityPerObject;
    for (size_t i = 0; i < testCase.requestCount; ++i)
        request.request.emplace_back(testCase.request[i]);
    for (size_t i = 0; i < testCase.stageCount; ++i) {
        const StageRow& row = testCase.stages[i];
        ChainStage stage;
        stage.name = row.name;
        if (row.before != nullptr) {
            stage.hasBefore = true;
            stage.before = row.before;
        }
        if (row.after != nullptr) {
            stage.hasAfter = true;
            stage.after = row.after;
        }
        if (row.minimumTier != nullptr) {
            stage.hasMinimumTier = true;
            stage.minimumTier = row.minimumTier;
        }
        stage.availability = static_cast<StageAvailability>(row.availability);
        if (row.availabilityReason != nullptr)
            stage.availabilityReason = row.availabilityReason;
        stage.build = static_cast<StageBuild>(row.build);
        if (row.buildError != nullptr)
            stage.buildError = row.buildError;
        if (row.requiresVelocity >= 0) {
            stage.hasRequiresVelocity = true;
            stage.requiresVelocity = row.requiresVelocity == 1;
        }
        request.stages.push_back(std::move(stage));
    }
    return request;
}

bool sameStrings(const std::vector<std::string>& got, const char* const* want, size_t count) {
    if (got.size() != count)
        return false;
    for (size_t i = 0; i < count; ++i)
        if (got[i] != want[i])
            return false;
    return true;
}

bool sameDropped(const std::vector<ChainDroppedStage>& got, const DroppedRow* want, size_t count) {
    if (got.size() != count)
        return false;
    for (size_t i = 0; i < count; ++i)
        if (got[i].name != want[i].name || got[i].reason != want[i].reason)
            return false;
    return true;
}

bool sameContributions(const std::vector<ChainContribution>& got, const ContributionRow* want, size_t count) {
    if (got.size() != count)
        return false;
    for (size_t i = 0; i < count; ++i)
        if (got[i].name != want[i].name || got[i].graphOutputChanged != want[i].changed)
            return false;
    return true;
}

void chain_order() {
    size_t configurations = 0, differ = 0;
    for (const ChainCase& testCase : kCases) {
        ++configurations;
        const ChainPlan plan = planRenderChain(toRequest(testCase));
        bool same = plan.refused == testCase.refused && std::strcmp(plan.error.c_str(), testCase.error) == 0;
        if (same && !testCase.refused) {
            same = plan.tier == testCase.expectedTier &&
                   sameStrings(plan.requested, testCase.requested, testCase.requestedCount) &&
                   sameStrings(plan.stages, testCase.appliedStages, testCase.appliedStageCount) &&
                   sameDropped(plan.dropped, testCase.dropped, testCase.droppedCount) &&
                   sameContributions(plan.contributions, testCase.contributions, testCase.contributionCount) &&
                   plan.velocity.provisioned == testCase.velocityProvisioned &&
                   plan.velocity.required == testCase.velocityRequired &&
                   plan.velocity.source == testCase.velocityReportSource;
        }
        if (!same) {
            ++differ;
            if (differ <= 8)
                std::fprintf(stderr, "chain %s: %s differs\n", testCase.name, testCase.refused ? "refusal" : "plan");
        }
    }
    std::printf("chain order: %zu configurations, %zu differ\n", configurations, differ);
    CHECK(configurations > 0 && differ == 0);
}

} // namespace

// A stage needing a renderer feature the native engine lacks is dropped by name, never built into a
// pass that draws nothing; every requested stage is either in the chain or named in `dropped`.
void chain_unsupported() {
    using namespace tn::engine::chain;
    const auto stage = [](const char* name, std::vector<std::string> features) {
        ChainStage s;
        s.name = name;
        s.features = std::move(features);
        return s;
    };
    ChainRequest request;
    request.request = {"bloom", "ssr", "vignette", "ambientOcclusion"};
    request.stages = {stage("bloom", {}), stage("ssr", {"depth", "normal", "ssr"}), stage("vignette", {"depth"}),
                      stage("ambientOcclusion", {"normal", "depth"})};
    request.hasNativeFeatures = true;
    request.nativeFeatures = {"depth"};
    const ChainPlan plan = planRenderChain(request);
    CHECK(!plan.refused);
    if (plan.refused) std::printf("refused: %s\n", plan.error.c_str());
    CHECK((plan.stages == std::vector<std::string>{"bloom", "vignette"})); // built-in order
    CHECK(plan.dropped.size() == 2);
    if (plan.dropped.size() == 2) {
        CHECK(plan.dropped[0].name == "ambientOcclusion"); // chain order: AO, SSR, bloom, vignette
        CHECK(plan.dropped[0].reason == "TN_NATIVE_RENDER_FEATURE_UNSUPPORTED: normal"); // its first missing
        CHECK(plan.dropped[1].name == "ssr");
        CHECK(plan.dropped[1].reason == "TN_NATIVE_RENDER_FEATURE_UNSUPPORTED: normal");
    }
    CHECK(plan.stages.size() + plan.dropped.size() == request.request.size()); // nothing vanishes

    // Every feature present: nothing is dropped.
    request.nativeFeatures = {"depth", "normal", "ssr"};
    const ChainPlan full = planRenderChain(request);
    CHECK(full.stages.size() == 4 && full.dropped.empty());

    // The web path checks no features, whatever a stage declares.
    request.hasNativeFeatures = false;
    request.nativeFeatures.clear();
    const ChainPlan web = planRenderChain(request);
    CHECK(web.stages.size() == 4 && web.dropped.empty());
    std::printf("chain unsupported: %zu kept, %zu dropped by name\n", plan.stages.size(), plan.dropped.size());
}

TN_TEST_MAIN({"chain_order", chain_order}, {"chain_unsupported", chain_unsupported})
