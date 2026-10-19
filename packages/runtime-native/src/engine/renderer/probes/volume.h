#pragma once
#include "engine/renderer/probes/schedule.h"
#include <array>
#include <functional>
#include <span>

namespace tn::engine::probes {
using ProbeCoefficients = std::array<float, 27>;
using ProbeVector = std::array<double, 3>;
// RGB, row-major faces in +X,-X,+Y,-Y,+Z,-Z order, matching Three.js CubeCamera.
bool projectCubemap(std::span<const float> rgb, uint32_t size, ProbeCoefficients& out, std::string& error);
enum class CaptureResult { Ready, Pending, Failed };
class ProbeVolume {
  public:
    using AsyncCaptureFace = std::function<CaptureResult(const ProbeWorkItem&, std::span<float>, std::string&)>;
    using CaptureFace = std::function<bool(const ProbeWorkItem&, std::span<float>, std::string&)>;
    static bool create(const ProbeVolumeDescription&, const ProbeScheduleOptions&, uint32_t cubemapSize,
                       ProbeVolume& out, std::string& error);
    const ProbePlacement& placement() const { return placement_; }
    const ProbeVolumeDescription& description() const { return description_; }
    std::span<const float> atlas() const { return atlas_; }
    std::span<const float> displayAtlas() const {
        return fullBake_ && captureIsolated_ ? std::span<const float>(blackAtlas_) : std::span<const float>(atlas_);
    }
    std::span<const float> samplingAtlas() const {
        return captureIsolated_ ? std::span<const float>(blackAtlas_) : std::span<const float>(atlas_);
    }
    uint32_t cubemapSize() const { return cubemapSize_; }
    const ProbeScheduleOptions& scheduleOptions() const { return options_; }
    std::span<const float> coefficients() const { return coefficients_; }
    std::span<const uint64_t> captureCounts() const { return captureCounts_; }
    bool writeProbe(uint32_t index, const ProbeCoefficients&, std::string& error);
    void clear();
    bool requestBake();
    // Clears affected coefficients and padding synchronously, before the next public sample.
    bool invalidate(std::span<const uint32_t> indices, std::string& error);
    ProbeStepStatus process(double& clockMs, const CaptureFace&, std::string& error);
    /** One work item, retaining its scheduler position while an asynchronous face is pending. */
    ProbeStepStatus processAsync(double& clockMs, const AsyncCaptureFace&, std::string& error);
    uint64_t revision() const { return revision_; }
    bool pending() const { return scheduler_.pending(); }
    bool ready() const { return ready_; }
    bool samplingIsolated() const { return captureIsolated_; }
    std::array<float, 3> sample(const ProbeVector& position, const ProbeVector& normal) const;
    std::array<float, 3> sampleCapture(const ProbeVector& position, const ProbeVector& normal) const;

  private:
    ProbeStepStatus processWork(double&, const AsyncCaptureFace&, std::string&, uint32_t limit);
    bool begin(std::span<const uint32_t> indices, std::string& error);
    void repack(uint32_t slice);
    ProbeVolumeDescription description_;
    ProbePlacement placement_;
    ProbeScheduleOptions options_;
    ProbeScheduler scheduler_;
    uint32_t cubemapSize_ = 0;
    std::vector<float> coefficients_, staged_, atlas_, blackAtlas_, cube_;
    std::vector<uint64_t> captureCounts_;
    std::vector<uint32_t> selected_;
    ProbeCoefficients projected_{};
    uint64_t revision_ = 0;
    bool ready_ = false, captureIsolated_ = false, fullBake_ = false;
};
} // namespace tn::engine::probes
