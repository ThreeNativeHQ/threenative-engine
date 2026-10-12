#pragma once

// Probe placement and the incremental update schedule, ported from `ProbeVolume` in
// packages/core/src/render/probe-volume.ts (PRD-525). It owns only the CPU decisions: where probes
// are placed for a volume description, which atlas slice each probe occupies, and which work items
// a bounded render-phase slice runs, in what order. The GPU bake, the SH projection and the atlas
// texture stay out.
//
// Native differences from the reference, all because the engine must not own the clock or the GPU:
//   - The reference reads wall-clock time from an injected `now`; here the caller owns `clockMs` and
//     the per-work-item costs (`ProbeWorkCosts`) are data, so one frame slice is deterministic.
//   - Engine code never throws. `place` and `ProbeScheduler::create` refuse invalid input by
//     returning false and a named code string; `process` reports an over-budget slice with
//     `ProbeStepStatus::Refused` instead of throwing.

#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace tn::engine::probes {

/** The atlas has one copied edge texel on either side of each packed SH sub-volume. */
inline constexpr uint32_t kAtlasPadding = 1;
/** The seven packed SH sub-volumes in the atlas. */
inline constexpr uint32_t kPackedSubVolumeCount = 7;
/** The six cube-map faces captured per probe. */
inline constexpr uint32_t kCubeFaceCount = 6;
/** Six captures, one projection and one copy per probe. */
inline constexpr uint32_t kWorkItemsPerProbe = kCubeFaceCount + 2;
/** The scheduling slack the reference adds to `bakeBudgetMs` before failing a slice. */
inline constexpr double kBudgetSlackMs = 0.5;

/** A degenerate or non-finite bounds rectangle is refused by this name. */
inline constexpr std::string_view kBoundsCode = "TN_PROBES_BOUNDS";
/** A non-finite or non-positive density is refused by this name. */
inline constexpr std::string_view kDensityCode = "TN_PROBES_DENSITY";
/** An invalid/too small `maxTextureDimension3D` is refused by this name. */
inline constexpr std::string_view kTextureLimitCode = "TN_PROBES_TEXTURE_LIMIT";
/** A schedule option that is not positive and finite is refused by this name. */
inline constexpr std::string_view kOptionsCode = "TN_PROBES_OPTIONS";

/** World-space bounds and probe density in probes per world unit, per axis. */
struct ProbeVolumeDescription {
    double boundsMin[3] = {0, 0, 0};
    double boundsMax[3] = {0, 0, 0};
    double density[3] = {1, 1, 1};
    /** Optional device limit. Ignored unless `hasMaxTextureDimension3D` is true. */
    bool hasMaxTextureDimension3D = false;
    double maxTextureDimension3D = 0;
};

/** Where a volume description places its probes. */
struct ProbePlacement {
    uint32_t resolution[3] = {0, 0, 0};
    uint32_t paddedSlices = 0;
    uint32_t atlasDepth = 0;
    uint64_t probeCount = 0;
    uint64_t atlasBytes = 0;
    double boundsMin[3] = {0, 0, 0};
    double boundsSize[3] = {0, 0, 0};
};

/**
 * Resolves a volume description to its probe grid and atlas geometry. A degenerate or non-finite
 * bounds, a non-finite or non-positive density, a resolution that is not safely representable, or a
 * supplied texture limit the atlas exceeds, refuses with a named code.
 */
bool place(const ProbeVolumeDescription& description, ProbePlacement& out, std::string& error);

/** The world position of probe `(ix, iy, iz)` on the grid. */
void probePosition(const ProbePlacement& placement, uint32_t ix, uint32_t iy, uint32_t iz, double out[3]);

/** The atlas slice a probe at `iz` writes into packed sub-volume `subVolume`. */
uint32_t atlasSlice(const ProbePlacement& placement, uint32_t subVolume, uint32_t iz);

/** The kind of one bounded work item in the bake state machine. */
enum class ProbeWorkKind : uint32_t { Capture = 0, Project = 1, Copy = 2, Repack = 3 };

/** One work item the scheduler ran. Unused fields stay zero for the item's kind. */
struct ProbeWorkItem {
    ProbeWorkKind kind = ProbeWorkKind::Capture;
    uint32_t pass = 0;
    uint32_t probe = 0;
    uint32_t face = 0;
    uint32_t repack = 0;
};

/** Per-work-item wall-clock costs the host measures, consumed by the time budget. */
struct ProbeWorkCosts {
    double capture = 1;
    double project = 1;
    double copy = 0.25;
    double repack = 1;
};

/** The bounded-slice configuration. `bounces` adds indirect passes onto the first. */
struct ProbeScheduleOptions {
    double bakeBudgetMs = 2;
    uint32_t maxWorkItemsPerFrame = 1;
    uint32_t bounces = 0;
    ProbeWorkCosts costs;
};

/** The outcome of one `process` slice. */
enum class ProbeStepStatus { Progress, Finished, Refused };

/**
 * The incremental bake state machine. One `process` call is one bounded render-phase slice: it runs
 * work items in the reference's order (per pass, per probe: six captures, one projection, one copy;
 * then one repack item per packed sub-volume slice) until the count budget or the time budget stops
 * it. `requestBake` coalesces while a bake is pending, returning false, exactly as the reference
 * returns its existing promise.
 */
class ProbeScheduler {
  public:
    ProbeScheduler() = default;

    static bool create(const ProbePlacement& placement, const ProbeScheduleOptions& options, ProbeScheduler& out,
                       std::string& error);

    /** Starts a bake. Returns false when one is already pending (the reference coalesces). */
    bool requestBake();

    /**
     * Runs one bounded frame slice. `clockMs` is advanced by each work item's measured cost. The
     * work items that ran, in order, are appended to `out`.
     */
    ProbeStepStatus process(double& clockMs, std::vector<ProbeWorkItem>& out, uint32_t limit = UINT32_MAX);

    [[nodiscard]] bool pending() const { return pending_; }
    [[nodiscard]] bool finished() const { return !pending_ && started_; }
    [[nodiscard]] uint32_t pass() const { return pass_; }
    [[nodiscard]] uint32_t probeIndex() const { return probeIndex_; }
    [[nodiscard]] uint64_t completedWork() const { return completedWork_; }
    [[nodiscard]] double maxWorkItemCostMs() const { return maxWorkItemCostMs_; }

  private:
    enum class Phase { Capture, Project, Copy, Repack };

    [[nodiscard]] ProbeWorkKind currentKind() const;
    [[nodiscard]] double costOf(ProbeWorkKind kind) const;
    void advance();

    ProbePlacement placement_;
    ProbeScheduleOptions options_;
    uint32_t passes_ = 1;
    uint64_t workPerPass_ = 0;

    bool pending_ = false;
    bool started_ = false;
    bool refused_ = false;
    Phase phase_ = Phase::Capture;
    uint32_t pass_ = 0;
    uint32_t probeIndex_ = 0;
    uint32_t cubeFaceIndex_ = 0;
    uint32_t repackIndex_ = 0;
    uint64_t completedWork_ = 0;
    uint64_t completedProbes_ = 0;
    double maxWorkItemCostMs_ = 0;
};

} // namespace tn::engine::probes
