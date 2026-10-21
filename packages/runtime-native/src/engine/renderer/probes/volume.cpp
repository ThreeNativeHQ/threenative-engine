#include "engine/renderer/probes/volume.h"
#include <algorithm>
#include <cmath>
#include <limits>
#include <numeric>
#include <numbers>

namespace tn::engine::probes {
bool projectCubemap(std::span<const float> rgb, uint32_t size, ProbeCoefficients& out, std::string& error) {
    if (!size || size > 1024 || rgb.size() != uint64_t(size) * size * 18 ||
        !std::all_of(rgb.begin(), rgb.end(), [](float v) { return std::isfinite(v); })) {
        error = "TN_PROBES_CUBEMAP";
        return false;
    }
    std::array<float, 27> accum{};
    float total = 0;
    const double pixelSize = 2.0 / size;
    for (uint32_t face = 0; face < 6; ++face)
        for (uint32_t iy = 0; iy < size; ++iy)
            for (uint32_t ix = 0; ix < size; ++ix) {
                const double col = (ix + 0.5) * pixelSize - 1, row = 1 - (iy + 0.5) * pixelSize;
                ProbeVector d;
                switch (face) {
                case 0:
                    d = {1, row, -col};
                    break;
                case 1:
                    d = {-1, row, col};
                    break;
                case 2:
                    d = {col, 1, -row};
                    break;
                case 3:
                    d = {col, -1, row};
                    break;
                case 4:
                    d = {col, row, 1};
                    break;
                default:
                    d = {-col, row, -1};
                    break;
                }
                const double l2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2], length = std::sqrt(l2),
                             weight = 4 / (length * l2);
                const double inverseLength = 1 / length;
                const double x = d[0] * inverseLength, y = d[1] * inverseLength, z = d[2] * inverseLength;
                const double basis[9] = {0.282095,
                                         0.488603 * y,
                                         0.488603 * z,
                                         0.488603 * x,
                                         1.092548 * x * y,
                                         1.092548 * y * z,
                                         0.315392 * (3 * z * z - 1),
                                         1.092548 * x * z,
                                         0.546274 * (x * x - y * y)};
                total += float(weight);
                const size_t pixel = ((size_t(face) * size + iy) * size + ix) * 3;
                for (size_t c = 0; c < 9; ++c)
                    for (size_t channel = 0; channel < 3; ++channel) {
                        const float weighted = rgb[pixel + channel] * float(weight);
                        accum[c * 3 + channel] += weighted * float(basis[c]);
                    }
            }
    for (size_t i = 0; i < 27; ++i) {
        const float value = accum[i] * (float(4 * std::numbers::pi) / total);
        if (!std::isfinite(value) || std::abs(value) > std::numeric_limits<float>::max()) {
            error = "TN_PROBES_COEFFICIENT";
            return false;
        }
        out[i] = float(value);
    }
    return true;
}
bool ProbeVolume::create(const ProbeVolumeDescription& description, const ProbeScheduleOptions& options, uint32_t size,
                         ProbeVolume& out, std::string& error) {
    ProbeVolume v;
    if (!place(description, v.placement_, error))
        return false;
    // Bound host allocations and refuse scheduler arithmetic/cost overflow before accepting input.
    const auto& p = v.placement_;
    const double costs[] = {options.costs.capture, options.costs.project, options.costs.copy, options.costs.repack};
    if (!size || size > 1024 || p.atlasBytes > 256ull * 1024 * 1024 || p.probeCount > UINT32_MAX ||
        p.resolution[0] > 2048 || p.resolution[1] > 2048 || p.resolution[2] > 2048 || p.atlasDepth > 2048 ||
        p.paddedSlices != uint64_t(p.resolution[2]) + 2 || p.atlasDepth != uint64_t(p.paddedSlices) * 7 ||
        options.bounces == UINT32_MAX ||
        !std::all_of(std::begin(costs), std::end(costs), [](double x) { return std::isfinite(x) && x >= 0; }) ||
        !ProbeScheduler::create(p, options, v.scheduler_, error)) {
        error = "TN_PROBES_OPTIONS";
        return false;
    }
    v.description_ = description;
    v.options_ = options;
    v.cubemapSize_ = size;
    v.coefficients_.resize(size_t(p.probeCount) * 27);
    v.staged_ = v.coefficients_;
    v.atlas_.resize(size_t(p.atlasBytes / sizeof(float)));
    v.blackAtlas_ = v.atlas_;
    v.cube_.resize(size_t(size) * size * 18);
    v.captureCounts_.resize(size_t(p.probeCount));
    out = std::move(v);
    return true;
}
void ProbeVolume::repack(uint32_t slice) {
    const auto& p = placement_;
    const uint32_t sub = slice / p.paddedSlices;
    const uint32_t z = std::clamp<int64_t>(int64_t(slice % p.paddedSlices) - 1, 0, p.resolution[2] - 1);
    for (uint32_t y = 0; y < p.resolution[1]; ++y)
        for (uint32_t x = 0; x < p.resolution[0]; ++x) {
            const size_t probe = x + size_t(y) * p.resolution[0] + size_t(z) * p.resolution[0] * p.resolution[1];
            const size_t offset = ((size_t(slice) * p.resolution[1] + y) * p.resolution[0] + x) * 4;
            for (uint32_t c = 0; c < 4; ++c)
                atlas_[offset + c] = sub * 4 + c < 27 ? coefficients_[probe * 27 + sub * 4 + c] : 0;
        }
}
bool ProbeVolume::writeProbe(uint32_t index, const ProbeCoefficients& c, std::string& error) {
    if (pending() || index >= placement_.probeCount ||
        !std::all_of(c.begin(), c.end(), [](float v) { return std::isfinite(v); })) {
        error = "TN_PROBES_COEFFICIENT";
        return false;
    }
    std::copy(c.begin(), c.end(), coefficients_.begin() + size_t(index) * 27);
    std::copy(c.begin(), c.end(), staged_.begin() + size_t(index) * 27);
    const auto& p = placement_;
    const uint32_t x = index % p.resolution[0], y = (index / p.resolution[0]) % p.resolution[1],
                   z = index / (p.resolution[0] * p.resolution[1]);
    for (uint32_t sub = 0; sub < 7; ++sub) {
        auto write = [&](uint32_t slice) {
            const size_t offset = ((size_t(slice) * p.resolution[1] + y) * p.resolution[0] + x) * 4;
            for (uint32_t channel = 0; channel < 4; ++channel)
                atlas_[offset + channel] = sub * 4 + channel < 27 ? c[sub * 4 + channel] : 0;
        };
        write(atlasSlice(p, sub, z));
        if (z == 0)
            write(sub * p.paddedSlices);
        if (z == p.resolution[2] - 1)
            write(sub * p.paddedSlices + p.paddedSlices - 1);
    }
    ready_ = true;
    return true;
}
void ProbeVolume::clear() {
    ++revision_;
    std::fill(coefficients_.begin(), coefficients_.end(), 0);
    staged_ = coefficients_;
    std::fill(atlas_.begin(), atlas_.end(), 0);
    ready_ = false;
    std::string error;
    ProbeScheduler::create(placement_, options_, scheduler_, error);
    captureIsolated_ = false;
}
bool ProbeVolume::begin(std::span<const uint32_t> indices, std::string& error) {
    ProbePlacement scheduling = placement_;
    scheduling.probeCount = indices.size();
    if (!ProbeScheduler::create(scheduling, options_, scheduler_, error))
        return false;
    ++revision_;
    fullBake_ = indices.size() == placement_.probeCount;
    selected_.assign(indices.begin(), indices.end());
    staged_ = coefficients_;
    ready_ = false;
    captureIsolated_ = true;
    return scheduler_.requestBake();
}
bool ProbeVolume::requestBake() {
    if (pending())
        return false;
    clear();
    std::vector<uint32_t> indices(size_t(placement_.probeCount));
    std::iota(indices.begin(), indices.end(), 0);
    std::string error;
    return begin(indices, error);
}
bool ProbeVolume::invalidate(std::span<const uint32_t> indices, std::string& error) {
    if (indices.empty()) {
        error = "TN_PROBES_INDEX";
        return false;
    }
    std::vector<uint32_t> selected(indices.begin(), indices.end());
    std::sort(selected.begin(), selected.end());
    if (selected.back() >= placement_.probeCount ||
        std::adjacent_find(selected.begin(), selected.end()) != selected.end()) {
        error = "TN_PROBES_INDEX";
        return false;
    }
    // Invalidation interrupts pending work; never publish an old queued capture after a light move.
    for (uint32_t index : selected)
        std::fill_n(coefficients_.begin() + size_t(index) * 27, 27, 0);
    for (uint32_t s = 0; s < placement_.atlasDepth; ++s)
        repack(s);
    return begin(selected, error);
}
ProbeStepStatus ProbeVolume::process(double& clock, const CaptureFace& capture, std::string& error) {
    return processWork(
        clock,
        [&](const ProbeWorkItem& item, std::span<float> face, std::string& reason) {
            return capture && capture(item, face, reason) ? CaptureResult::Ready : CaptureResult::Failed;
        },
        error, UINT32_MAX);
}
ProbeStepStatus ProbeVolume::processAsync(double& clock, const AsyncCaptureFace& capture, std::string& error) {
    return processWork(clock, capture, error, 1);
}
ProbeStepStatus ProbeVolume::processWork(double& clock, const AsyncCaptureFace& capture, std::string& error,
                                         uint32_t limit) {
    if (!std::isfinite(clock)) {
        error = "TN_PROBES_CLOCK";
        return ProbeStepStatus::Refused;
    }
    std::vector<ProbeWorkItem> work;
    const auto previousScheduler = scheduler_;
    const double previousClock = clock;
    const auto status = scheduler_.process(clock, work, limit);
    if (status == ProbeStepStatus::Refused) {
        clear();
        error = "TN_PROBES_BUDGET";
        return status;
    }
    for (auto item : work) {
        captureIsolated_ = item.pass == 0;
        if (item.kind != ProbeWorkKind::Repack)
            item.probe = selected_[item.probe];
        if (item.kind == ProbeWorkKind::Capture) {
            auto face = std::span<float>(cube_).subspan(size_t(item.face) * cubemapSize_ * cubemapSize_ * 3,
                                                        size_t(cubemapSize_) * cubemapSize_ * 3);
            std::fill(face.begin(), face.end(), std::numeric_limits<float>::quiet_NaN());
            const auto result = capture ? capture(item, face, error) : CaptureResult::Failed;
            if (result == CaptureResult::Pending && limit == 1) {
                scheduler_ = previousScheduler;
                clock = previousClock;
                return ProbeStepStatus::Progress;
            }
            if (result != CaptureResult::Ready ||
                !std::all_of(face.begin(), face.end(), [](float v) { return std::isfinite(v); })) {
                clear();
                if (error.empty())
                    error = "TN_PROBES_CAPTURE";
                return ProbeStepStatus::Refused;
            }
            ++captureCounts_[item.probe];
        } else if (item.kind == ProbeWorkKind::Project) {
            if (!projectCubemap(cube_, cubemapSize_, projected_, error)) {
                clear();
                return ProbeStepStatus::Refused;
            }
        } else if (item.kind == ProbeWorkKind::Copy) {
            std::copy(projected_.begin(), projected_.end(), staged_.begin() + size_t(item.probe) * 27);
        } else {
            if (item.repack == 0)
                coefficients_ = staged_;
            repack(item.repack);
        }
    }
    captureIsolated_ = pending() && scheduler_.pass() == 0;
    if (status == ProbeStepStatus::Finished) {
        captureIsolated_ = false;
        if (!work.empty())
            ready_ = true;
    }
    return status;
}
std::array<float, 3> ProbeVolume::sample(const ProbeVector& position, const ProbeVector& normal) const {
    if (!std::all_of(position.begin(), position.end(), [](double v) { return std::isfinite(v); }) ||
        !std::all_of(normal.begin(), normal.end(), [](double v) { return std::isfinite(v); }))
        return {};
    const auto& p = placement_;
    if (!p.probeCount)
        return {};
    double grid[3];
    uint32_t low[3], high[3];
    double fraction[3];
    for (int a = 0; a < 3; ++a) {
        const double local = std::clamp((position[a] - p.boundsMin[a]) / p.boundsSize[a], 0.0, 1.0);
        const double uv = (local * (p.resolution[a] - 1) + 0.5) / p.resolution[a];
        grid[a] = std::clamp(uv * p.resolution[a] - 0.5, 0.0, double(p.resolution[a] - 1));
        low[a] = uint32_t(std::floor(grid[a]));
        high[a] = std::min(p.resolution[a] - 1, low[a] + 1);
        fraction[a] = grid[a] - low[a];
    }
    ProbeCoefficients c{};
    for (uint32_t sub = 0; sub < 7; ++sub)
        for (uint32_t channel = 0; channel < 4 && sub * 4 + channel < 27; ++channel) {
            double sum = 0;
            for (uint32_t z = low[2]; z <= high[2]; ++z)
                for (uint32_t y = low[1]; y <= high[1]; ++y)
                    for (uint32_t x = low[0]; x <= high[0]; ++x) {
                        auto weight = [&](uint32_t v, int a) {
                            return low[a] == high[a] ? 1.0 : v == low[a] ? 1 - fraction[a] : fraction[a];
                        };
                        const double w = weight(x, 0) * weight(y, 1) * weight(z, 2);
                        const size_t offset =
                            ((size_t(atlasSlice(p, sub, z)) * p.resolution[1] + y) * p.resolution[0] + x) * 4;
                        sum += atlas_[offset + channel] * w;
                    }
            c[sub * 4 + channel] = float(sum);
        }
    const double length = std::sqrt(normal[0] * normal[0] + normal[1] * normal[1] + normal[2] * normal[2]);
    const double x = length ? normal[0] / length : 0, y = length ? normal[1] / length : 0,
                 z = length ? normal[2] / length : 0;
    std::array<float, 3> result{};
    for (int ch = 0; ch < 3; ++ch)
        result[ch] =
            float(std::max(0.0, c[ch] * 0.886227 + c[3 + ch] * y * 1.023328 + c[6 + ch] * z * 1.023328 +
                                    c[9 + ch] * x * 1.023328 + c[12 + ch] * x * y * 0.858086 +
                                    c[15 + ch] * y * z * 0.858086 + c[18 + ch] * (z * z * 0.743125 - 0.247708) +
                                    c[21 + ch] * x * z * 0.858086 + c[24 + ch] * (x * x - y * y) * 0.429043));
    return result;
}
std::array<float, 3> ProbeVolume::sampleCapture(const ProbeVector& p, const ProbeVector& n) const {
    return captureIsolated_ ? std::array<float, 3>{} : sample(p, n);
}
} // namespace tn::engine::probes
