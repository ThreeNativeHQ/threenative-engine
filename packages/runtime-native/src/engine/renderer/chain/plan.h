#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace tn::engine::chain {

/**
 * The per-stage decisions of packages/core/src/render/chain.ts as a pure CPU plan (PRD-526 phase 1).
 * This port owns only stage ordering, availability, velocity provisioning and the drop reasons: it
 * builds no GPU resources and returns no graph nodes. Appearance and stage factories stay in the
 * game, exactly as the TypeScript chain leaves them to the caller.
 *
 * A refusal carries the chain.ts message as a code string (`TN_RENDER_CHAIN_ORDER: <message>`), so
 * the caller never sees a throw on this seam.
 */

/** How an authored stage's `available` hook answers. */
enum class StageAvailability : uint8_t {
    Available = 0,
    Unavailable = 1,
    Named = 2,
};

/** What a stage's `build` returns: the input, a new node, a throw, or nothing. */
enum class StageBuild : uint8_t {
    SameNode = 0,
    NewNode = 1,
    Throws = 2,
    ReturnsNothing = 3,
};

/** One supplied stage definition, in `RenderChain` `stages` order. */
struct ChainStage {
    std::string name;
    bool hasBefore = false;
    std::string before;
    bool hasAfter = false;
    std::string after;
    bool hasMinimumTier = false;
    std::string minimumTier;
    StageAvailability availability = StageAvailability::Available;
    /** Reason returned by `available` when `availability` is `Named`. */
    std::string availabilityReason;
    StageBuild build = StageBuild::NewNode;
    /** Message of the thrown `build` when `build` is `Throws`. */
    std::string buildError;
    bool hasRequiresVelocity = false;
    bool requiresVelocity = false;
    /** Renderer features the stage's pass needs (e.g. "depth", "normal", "ssr"), in its own order. */
    std::vector<std::string> features;
};

/** The velocity request flags `resolveVelocity` reads; `source` is "mrt" or "per-object". */
struct ChainVelocityRequest {
    bool hasSource = false;
    std::string source;
    bool pass = false;
    bool mrt = false;
    bool objectFlags = false;
    bool perObject = false;
};

/** A chain request: the request order, the tier and the supplied definitions. */
struct ChainRequest {
    std::string rendererKind = "webgpu";
    std::string tier = "high";
    ChainVelocityRequest velocity;
    std::vector<std::string> request;
    std::vector<ChainStage> stages;
    /**
     * The native renderer's features. Set, a requested stage needing one it lacks is dropped as
     * `TN_NATIVE_RENDER_FEATURE_UNSUPPORTED: <feature>` instead of building a pass that would draw
     * nothing; unset (the web path), features are not checked.
     */
    bool hasNativeFeatures = false;
    std::vector<std::string> nativeFeatures;
};

struct ChainDroppedStage {
    std::string name;
    std::string reason;
};

struct ChainContribution {
    std::string name;
    bool graphOutputChanged = false;
};

/** The applied velocity report; `source` is empty for chain.ts's `null`. */
struct ChainVelocityReport {
    bool provisioned = false;
    bool required = false;
    std::string source;
};

/** The planned chain. `error` is set only when `refused`. */
struct ChainPlan {
    bool refused = false;
    std::string error;
    std::vector<std::string> requested;
    std::vector<std::string> stages;
    std::vector<ChainDroppedStage> dropped;
    std::vector<ChainContribution> contributions;
    std::string tier;
    ChainVelocityReport velocity;
};

/** Plan one chain. Never throws: an ordering or request refusal becomes `refused` + `error`. */
ChainPlan planRenderChain(const ChainRequest& request);

} // namespace tn::engine::chain
