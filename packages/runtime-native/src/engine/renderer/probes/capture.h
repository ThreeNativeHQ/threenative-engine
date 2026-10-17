#pragma once
#include "engine/renderer/renderer.h"
#include "engine/scene/object3d.h"

namespace tn::engine::probes {
using ProbeCaptureCallback = std::function<void(GpuStatus, std::vector<float>)>;
/** One CubeCamera view of the real scene, linear HDR before any output transform.
 * Completion is asynchronous, delivered by the renderer's EventQueue. The caller advances the
 * existing scheduler after the face arrives; a light revision must discard an in-flight face.
 */
GpuStatus captureFace(Renderer& renderer, Object3D& scene, const ProbeVolume& volume, const std::string& name,
                      uint32_t probe, uint32_t face, double near, double far, ProbeCaptureCallback done);
/** Incremental render-phase updater. A face in flight consumes no further scheduler work. */
class ProbeBaker {
  public:
    explicit ProbeBaker(double near = 0.1, double far = 100) : near_(near), far_(far) {}
    ProbeStepStatus process(Renderer&, Object3D& scene, ProbeVolume&, const std::string& name, std::string& error);
    bool waiting() const { return waiting_; }

  private:
    struct Face {
        const ProbeVolume* volume = nullptr;
        uint64_t revision = 0;
        ProbeWorkItem item;
        bool done = false;
        GpuStatus status = GpuStatus::DeviceError;
        std::vector<float> rgb;
    };
    std::shared_ptr<Face> face_;
    double clockMs_ = 0;
    double near_ = 0.1, far_ = 100;
    bool waiting_ = false;
};
} // namespace tn::engine::probes
