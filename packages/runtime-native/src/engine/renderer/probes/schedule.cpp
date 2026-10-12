#include "engine/renderer/probes/schedule.h"

#include <algorithm>
#include <cmath>

namespace tn::engine::probes {

namespace {

bool finiteVector(const double* values) {
    return std::isfinite(values[0]) && std::isfinite(values[1]) && std::isfinite(values[2]);
}

bool positiveInteger(double value) {
    return std::isfinite(value) && value > 0 && std::floor(value) == value &&
           value <= 9007199254740991.0; // Number.MAX_SAFE_INTEGER
}

} // namespace

bool place(const ProbeVolumeDescription& description, ProbePlacement& out, std::string& error) {
    if (!finiteVector(description.boundsMin) || !finiteVector(description.boundsMax)) {
        error.assign(kBoundsCode);
        return false;
    }
    for (int axis = 0; axis < 3; ++axis) {
        if (!(description.boundsMin[axis] < description.boundsMax[axis])) {
            error.assign(kBoundsCode);
            return false;
        }
    }
    if (!finiteVector(description.density)) {
        error.assign(kDensityCode);
        return false;
    }
    for (double axis : description.density) {
        if (!(axis > 0)) {
            error.assign(kDensityCode);
            return false;
        }
    }

    ProbePlacement placement;
    for (int axis = 0; axis < 3; ++axis) {
        placement.boundsMin[axis] = description.boundsMin[axis];
        placement.boundsSize[axis] = description.boundsMax[axis] - description.boundsMin[axis];
        // `resolutionForAxis`: Math.ceil(size * density) + 1. std::ceil matches JS Math.ceil for the
        // finite positive inputs accepted here.
        const double resolution = std::ceil(placement.boundsSize[axis] * description.density[axis]) + 1;
        if (!(std::isfinite(resolution) && std::floor(resolution) == resolution && resolution >= 2 &&
              resolution <= 4294967295.0)) {
            error.assign(kDensityCode);
            return false;
        }
        placement.resolution[axis] = static_cast<uint32_t>(resolution);
    }

    // `checkedAtlasDepth`: seven padded sub-volumes along z.
    const uint64_t paddedSlices =
        static_cast<uint64_t>(placement.resolution[2]) + 2 * static_cast<uint64_t>(kAtlasPadding);
    placement.paddedSlices = static_cast<uint32_t>(paddedSlices);
    placement.atlasDepth = static_cast<uint32_t>(kPackedSubVolumeCount * paddedSlices);

    const uint64_t maximumDimension =
        std::max({static_cast<uint64_t>(placement.resolution[0]), static_cast<uint64_t>(placement.resolution[1]),
                  static_cast<uint64_t>(placement.atlasDepth)});
    if (description.hasMaxTextureDimension3D) {
        const double limit = description.maxTextureDimension3D;
        if (!positiveInteger(limit)) {
            error.assign(kTextureLimitCode);
            return false;
        }
        if (maximumDimension > static_cast<uint64_t>(limit)) {
            error.assign(kTextureLimitCode);
            return false;
        }
    }

    // `checkedIntegerProduct`: a safe positive integer, or the atlas cannot be addressed exactly.
    const uint64_t probeCount =
        static_cast<uint64_t>(placement.resolution[0]) * placement.resolution[1] * placement.resolution[2];
    if (probeCount == 0 || probeCount > 9007199254740991ull) {
        error.assign(kDensityCode);
        return false;
    }
    const uint64_t texelCount = probeCount / placement.resolution[2] * placement.atlasDepth;
    if (texelCount == 0 || texelCount > 9007199254740991ull / (4 * sizeof(float))) {
        error.assign(kTextureLimitCode);
        return false;
    }
    placement.probeCount = probeCount;
    placement.atlasBytes = texelCount * 4 * sizeof(float);

    out = placement;
    return true;
}

void probePosition(const ProbePlacement& placement, uint32_t ix, uint32_t iy, uint32_t iz, double out[3]) {
    const uint32_t indices[3] = {ix, iy, iz};
    for (int axis = 0; axis < 3; ++axis) {
        out[axis] = placement.boundsMin[axis] + (static_cast<double>(indices[axis]) * placement.boundsSize[axis]) /
                                                    (static_cast<double>(placement.resolution[axis]) - 1);
    }
}

uint32_t atlasSlice(const ProbePlacement& placement, uint32_t subVolume, uint32_t iz) {
    return subVolume * placement.paddedSlices + kAtlasPadding + iz;
}

bool ProbeScheduler::create(const ProbePlacement& placement, const ProbeScheduleOptions& options, ProbeScheduler& out,
                            std::string& error) {
    if (!(std::isfinite(options.bakeBudgetMs) && options.bakeBudgetMs > 0) || options.maxWorkItemsPerFrame == 0) {
        error.assign(kOptionsCode);
        return false;
    }
    if (placement.probeCount == 0 || placement.resolution[0] < 2 || placement.resolution[1] < 2 ||
        placement.resolution[2] < 2) {
        error.assign(kOptionsCode);
        return false;
    }

    ProbeScheduler scheduler;
    scheduler.placement_ = placement;
    scheduler.options_ = options;
    scheduler.passes_ = options.bounces + 1;
    scheduler.workPerPass_ = placement.probeCount * kWorkItemsPerProbe +
                             static_cast<uint64_t>(kPackedSubVolumeCount) * placement.paddedSlices;
    out = scheduler;
    return true;
}

bool ProbeScheduler::requestBake() {
    if (pending_ || refused_)
        return false;
    started_ = true;
    pending_ = true;
    phase_ = Phase::Capture;
    pass_ = 0;
    probeIndex_ = 0;
    cubeFaceIndex_ = 0;
    repackIndex_ = 0;
    completedWork_ = 0;
    completedProbes_ = 0;
    maxWorkItemCostMs_ = 0;
    return true;
}

ProbeWorkKind ProbeScheduler::currentKind() const {
    switch (phase_) {
    case Phase::Capture:
        return ProbeWorkKind::Capture;
    case Phase::Project:
        return ProbeWorkKind::Project;
    case Phase::Copy:
        return ProbeWorkKind::Copy;
    case Phase::Repack:
        return ProbeWorkKind::Repack;
    }
    return ProbeWorkKind::Capture;
}

double ProbeScheduler::costOf(ProbeWorkKind kind) const {
    switch (kind) {
    case ProbeWorkKind::Capture:
        return options_.costs.capture;
    case ProbeWorkKind::Project:
        return options_.costs.project;
    case ProbeWorkKind::Copy:
        return options_.costs.copy;
    case ProbeWorkKind::Repack:
        return options_.costs.repack;
    }
    return 0;
}

void ProbeScheduler::advance() {
    switch (phase_) {
    case Phase::Capture:
        cubeFaceIndex_ += 1;
        if (cubeFaceIndex_ >= kCubeFaceCount)
            phase_ = Phase::Project;
        break;
    case Phase::Project:
        phase_ = Phase::Copy;
        break;
    case Phase::Copy:
        probeIndex_ += 1;
        completedProbes_ += 1;
        if (probeIndex_ >= placement_.probeCount) {
            phase_ = Phase::Repack;
            repackIndex_ = 0;
        } else {
            phase_ = Phase::Capture;
            cubeFaceIndex_ = 0;
        }
        break;
    case Phase::Repack:
        repackIndex_ += 1;
        if (repackIndex_ < kPackedSubVolumeCount * placement_.paddedSlices)
            break;
        if (pass_ + 1 < passes_) {
            pass_ += 1;
            phase_ = Phase::Capture;
            cubeFaceIndex_ = 0;
            probeIndex_ = 0;
        } else {
            pending_ = false;
        }
        break;
    }
}

ProbeStepStatus ProbeScheduler::process(double& clockMs, std::vector<ProbeWorkItem>& out, uint32_t limit) {
    if (refused_)
        return ProbeStepStatus::Refused;
    if (!pending_)
        return ProbeStepStatus::Finished;

    const double started = clockMs;
    uint32_t workItems = 0;
    while (pending_ && workItems < options_.maxWorkItemsPerFrame && workItems < limit) {
        // Reference Math.max(0, now() - started). The clock only ever advances by finite costs, so the
        // NaN and negative branches of that JS idiom have no case here.
        const double elapsedBefore = std::max(0.0, clockMs - started);
        if (workItems > 0 && elapsedBefore + maxWorkItemCostMs_ > options_.bakeBudgetMs)
            break;
        const ProbeWorkKind kind = currentKind();
        const double cost = costOf(kind);
        clockMs += cost;
        maxWorkItemCostMs_ = std::max(maxWorkItemCostMs_, cost);
        const double elapsed = std::max(0.0, clockMs - started);
        if (cost > options_.bakeBudgetMs + kBudgetSlackMs || elapsed > options_.bakeBudgetMs + kBudgetSlackMs) {
            // The reference fails the bake closed here; the engine reports it instead of throwing.
            pending_ = false;
            refused_ = true;
            return ProbeStepStatus::Refused;
        }

        ProbeWorkItem item;
        item.kind = kind;
        item.pass = pass_;
        // `probe` is meaningful for capture/project/copy; `face` only for capture and `repack` only
        // for repack. The other fields stay zero so an item is canonical.
        item.probe = kind == ProbeWorkKind::Repack ? 0 : probeIndex_;
        item.face = kind == ProbeWorkKind::Capture ? cubeFaceIndex_ : 0;
        item.repack = kind == ProbeWorkKind::Repack ? repackIndex_ : 0;
        out.push_back(item);

        advance();
        completedWork_ += 1;
        workItems += 1;
        if (elapsed >= options_.bakeBudgetMs)
            break;
    }
    return pending_ ? ProbeStepStatus::Progress : ProbeStepStatus::Finished;
}

} // namespace tn::engine::probes
