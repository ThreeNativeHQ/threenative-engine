#include "engine/renderer/chain/plan.h"

#include <algorithm>
#include <cctype>
#include <iterator>
#include <limits>
#include <map>
#include <utility>

namespace tn::engine::chain {

namespace {

/** chain.ts's `RENDER_CHAIN_STAGE_ORDER`, in order. */
constexpr const char* kStageOrder[] = {
    "probeVolume",
    "ambientOcclusion",
    "ssgi",
    "godRays",
    "ssr",
    "denoise",
    "temporalReproject",
    "taa",
    "traa",
    "motionBlur",
    "sharpen",
    "bloom",
    "vignette",
    "lensDistortion",
    "sparkle",
    "gradualBackground",
};

/** chain.ts's `VELOCITY_STAGES`: the built-ins that require a velocity source by name. */
bool isVelocityStage(const std::string& id) {
    return id == "motionBlur" || id == "taa" || id == "temporalReproject" || id == "traa";
}

int builtInIndex(const std::string& id) {
    for (std::size_t i = 0; i < std::size(kStageOrder); ++i) {
        if (id == kStageOrder[i])
            return static_cast<int>(i);
    }
    return -1;
}

bool isBlank(const std::string& value) {
    for (const char c : value) {
        if (!std::isspace(static_cast<unsigned char>(c)))
            return false;
    }
    return true;
}

bool contains(const std::vector<std::string>& values, const std::string& value) {
    return std::find(values.begin(), values.end(), value) != values.end();
}

const ChainStage* findStage(const std::vector<ChainStage>& stages, const std::string& name) {
    for (const ChainStage& stage : stages) {
        if (stage.name == name)
            return &stage;
    }
    return nullptr;
}

// Engine code never throws: a refusal is the first message recorded, and every caller stops there.
bool fail(std::string& error, std::string message) {
    if (error.empty())
        error = std::move(message);
    return false;
}

/** resolveStageOrder's rank recursion and cycle guard, over one definition set. */
class OrderResolver {
  public:
    explicit OrderResolver(const std::vector<ChainStage>& stages)
        : stages_(stages), step_(1.0 / (static_cast<double>(stages.size()) + 1.0)) {}

    double rank(const std::string& id) {
        const int builtIn = builtInIndex(id);
        if (builtIn >= 0)
            return static_cast<double>(builtIn);
        if (const auto known = ranks_.find(id); known != ranks_.end())
            return known->second;
        for (std::size_t i = 0; i < visiting_.size(); ++i) {
            if (visiting_[i] != id)
                continue;
            std::string cycle;
            for (std::size_t j = i; j < visiting_.size(); ++j)
                cycle += visiting_[j] + " -> ";
            cycle += id;
            return failed("render-chain stage anchor cycle: " + cycle);
        }
        const ChainStage* definition = findStage(stages_, id);
        if (definition == nullptr)
            return failed("render-chain stage '" + id + "' has no supplied definition");
        const std::string* anchor = nullptr;
        if (definition->hasBefore)
            anchor = &definition->before;
        else if (definition->hasAfter)
            anchor = &definition->after;
        if (anchor == nullptr)
            return failed("authored render-chain stage '" + id + "' has no anchor");
        visiting_.push_back(id);
        const double anchorRank = rank(*anchor);
        visiting_.pop_back();
        if (!error_.empty())
            return anchorRank;
        const double resolved = anchorRank + (definition->hasBefore ? -step_ : step_);
        ranks_[id] = resolved;
        return resolved;
    }

    std::vector<std::string> order(const std::vector<std::string>& additionalIds) {
        std::vector<std::string> ids;
        for (const ChainStage& stage : stages_)
            if (!contains(ids, stage.name))
                ids.push_back(stage.name);
        for (const std::string& id : additionalIds)
            if (!contains(ids, id))
                ids.push_back(id);
        std::vector<std::pair<double, std::size_t>> ranked;
        ranked.reserve(ids.size());
        for (std::size_t i = 0; i < ids.size(); ++i) {
            ranked.emplace_back(rank(ids[i]), i);
            if (!error_.empty())
                return {};
        }
        std::stable_sort(ranked.begin(), ranked.end(), [](const auto& left, const auto& right) {
            if (left.first != right.first)
                return left.first < right.first;
            return left.second < right.second;
        });
        std::vector<std::string> ordered;
        ordered.reserve(ids.size());
        for (const auto& entry : ranked)
            ordered.push_back(ids[entry.second]);
        return ordered;
    }

    /** The first refusal, empty while the order resolved. */
    [[nodiscard]] const std::string& error() const { return error_; }

  private:
    double failed(std::string message) {
        fail(error_, std::move(message));
        return std::numeric_limits<double>::quiet_NaN();
    }

    std::string error_;
    const std::vector<ChainStage>& stages_;
    double step_;
    std::vector<std::string> visiting_;
    std::map<std::string, double> ranks_;
};

/** createStageDefinitions: shape and anchor checks, then the cycle guard. */
bool validateDefinitions(const std::vector<ChainStage>& stages, std::string& error) {
    std::vector<std::string> names;
    for (const ChainStage& stage : stages) {
        if (isBlank(stage.name))
            return fail(error, "render-chain stage id must be a non-blank string; received " + stage.name);
        if (contains(names, stage.name))
            return fail(error, "duplicate render-chain stage '" + stage.name + "'");
        const bool hasBefore = stage.hasBefore;
        const bool hasAfter = stage.hasAfter;
        if (builtInIndex(stage.name) >= 0) {
            if (hasBefore || hasAfter)
                return fail(error, "built-in render-chain stage '" + stage.name +
                                       "' cannot declare before or after; its canonical order is fixed");
        } else if (hasBefore == hasAfter) {
            return fail(error,
                        "authored render-chain stage '" + stage.name + "' must declare exactly one of before or after");
        }
        if (hasBefore && isBlank(stage.before))
            return fail(error, "render-chain stage '" + stage.name +
                                   "' before anchor id must be a non-blank string; received " + stage.before);
        if (hasAfter && isBlank(stage.after))
            return fail(error, "render-chain stage '" + stage.name +
                                   "' after anchor id must be a non-blank string; received " + stage.after);
        names.push_back(stage.name);
    }
    for (const ChainStage& stage : stages) {
        const std::string* anchor = stage.hasBefore ? &stage.before : stage.hasAfter ? &stage.after : nullptr;
        if (anchor != nullptr && builtInIndex(*anchor) < 0 && !contains(names, *anchor))
            return fail(error, "render-chain stage '" + stage.name + "' anchor '" + *anchor + "' is missing");
    }
    OrderResolver resolver(stages);
    resolver.order({});
    return resolver.error().empty() || fail(error, resolver.error());
}

/** normalizeRequestedStages: request checks, then the resolved order filtered to the request. */
bool normalizeRequested(const ChainRequest& request, std::vector<std::string>& ordered, std::string& error) {
    std::vector<std::string> requested;
    for (const std::string& name : request.request) {
        if (isBlank(name))
            return fail(error, "requested render-chain stage id must be a non-blank string; received " + name);
        if (contains(requested, name))
            return fail(error, "duplicate requested render-chain stage '" + name + "'");
        if (builtInIndex(name) < 0 && findStage(request.stages, name) == nullptr)
            return fail(error, "unknown render-chain stage '" + name + "': no supplied definition");
        requested.push_back(name);
    }
    OrderResolver resolver(request.stages);
    for (const std::string& id : resolver.order(requested))
        if (contains(requested, id))
            ordered.push_back(id);
    return resolver.error().empty() || fail(error, resolver.error());
}

/** requiresVelocityFor: an explicit flag, else the canonical temporal stage names. */
bool requiresVelocityFor(const ChainStage* definition, const std::string& id) {
    if (definition != nullptr && definition->hasRequiresVelocity)
        return definition->requiresVelocity;
    return builtInIndex(id) >= 0 && isVelocityStage(id);
}

/** resolveVelocity: explicit source, else the mrt/pass flags, else the per-object flags. */
ChainVelocityReport resolveVelocity(const ChainVelocityRequest& request, bool required) {
    if (!required)
        return {false, false, ""};
    std::string source;
    if (request.hasSource)
        source = request.source;
    else if (request.pass || request.mrt)
        source = "mrt";
    else if (request.objectFlags || request.perObject)
        source = "per-object";
    return {!source.empty(), true, source};
}

int tierLevel(const std::string& tier) {
    if (tier == "high")
        return 3;
    if (tier == "medium")
        return 2;
    if (tier == "low")
        return 1;
    return 0;
}

} // namespace

ChainPlan planRenderChain(const ChainRequest& request) {
    std::string error;
    std::vector<std::string> requested;
    if (!validateDefinitions(request.stages, error) || !normalizeRequested(request, requested, error)) {
        ChainPlan plan;
        plan.refused = true;
        plan.error = "TN_RENDER_CHAIN_ORDER: " + error;
        return plan;
    }
    {
        bool requiredVelocity = false;
        for (const std::string& name : requested) {
            if (requiresVelocityFor(findStage(request.stages, name), name)) {
                requiredVelocity = true;
                break;
            }
        }
        const ChainVelocityReport velocity = resolveVelocity(request.velocity, requiredVelocity);

        std::vector<std::string> stages;
        std::vector<ChainDroppedStage> dropped;
        std::vector<ChainContribution> contributions;
        for (const std::string& name : requested) {
            const ChainStage* definition = findStage(request.stages, name);
            if (request.tier == "off") {
                dropped.push_back({name, "tier:off"});
                continue;
            }
            if (definition == nullptr) {
                dropped.push_back({name, "provider:missing"});
                continue;
            }
            if (request.rendererKind != "webgpu") {
                dropped.push_back({name, "renderer:" + request.rendererKind});
                continue;
            }
            if (definition->hasMinimumTier && tierLevel(request.tier) < tierLevel(definition->minimumTier)) {
                dropped.push_back({name, "tier:" + request.tier});
                continue;
            }
            if (requiresVelocityFor(definition, name) && !velocity.provisioned) {
                dropped.push_back({name, "velocity:missing"});
                continue;
            }
            if (definition->availability == StageAvailability::Unavailable) {
                dropped.push_back({name, "unavailable:" + request.rendererKind});
                continue;
            }
            if (definition->availability == StageAvailability::Named) {
                dropped.push_back({name, definition->availabilityReason});
                continue;
            }
            if (request.hasNativeFeatures) {
                std::string missing;
                for (const std::string& feature : definition->features)
                    if (missing.empty() &&
                        std::find(request.nativeFeatures.begin(), request.nativeFeatures.end(), feature) ==
                            request.nativeFeatures.end())
                        missing = feature;
                if (!missing.empty()) {
                    dropped.push_back({name, "TN_NATIVE_RENDER_FEATURE_UNSUPPORTED: " + missing});
                    continue;
                }
            }
            if (definition->build == StageBuild::Throws) {
                dropped.push_back({name, "build:" + definition->buildError});
                continue;
            }
            if (definition->build == StageBuild::ReturnsNothing) {
                dropped.push_back({name, "build:stage returned no node"});
                continue;
            }
            contributions.push_back({name, definition->build == StageBuild::NewNode});
            stages.push_back(name);
        }

        bool activeVelocity = false;
        for (const std::string& name : stages) {
            if (requiresVelocityFor(findStage(request.stages, name), name)) {
                activeVelocity = true;
                break;
            }
        }

        ChainPlan plan;
        plan.requested = requested;
        plan.stages = stages;
        plan.dropped = dropped;
        plan.contributions = contributions;
        plan.tier = request.tier;
        plan.velocity = activeVelocity ? velocity : ChainVelocityReport{false, velocity.required, ""};
        return plan;
    }
}

} // namespace tn::engine::chain
