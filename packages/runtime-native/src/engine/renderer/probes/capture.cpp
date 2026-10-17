#include "engine/renderer/probes/capture.h"
#include "engine/renderer/render_database.h"
#include <cmath>
#include <cstring>
#include <stdexcept>

namespace tn::engine::probes {
namespace {
float halfFloat(uint16_t bits) {
    const uint32_t exponent = (bits >> 10) & 31, mantissa = bits & 1023;
    const float value = exponent == 0    ? std::ldexp(float(mantissa), -24)
                        : exponent == 31 ? (mantissa ? NAN : INFINITY)
                                         : std::ldexp(float(1024 + mantissa), int(exponent) - 25);
    return bits & 0x8000 ? -value : value;
}
} // namespace
GpuStatus captureFace(Renderer& renderer, Object3D& scene, const ProbeVolume& volume, const std::string& name,
                      uint32_t probe, uint32_t face, double near, double far, ProbeCaptureCallback done) {
    if (!done || probe >= volume.placement().probeCount || face >= 6 || !std::isfinite(near) || !std::isfinite(far) ||
        near <= 0 || far <= near)
        return GpuStatus::OutOfRange;
    try {
        (void)shader::probeStorageName(name);
    } catch (const std::invalid_argument&) {
        return GpuStatus::OutOfRange;
    }
    auto& capture = renderer.probeCaptureRenderer();
    const auto& p = volume.placement();
    double position[3];
    probePosition(p, probe % p.resolution[0], (probe / p.resolution[0]) % p.resolution[1],
                  probe / (p.resolution[0] * p.resolution[1]), position);
    // These rays are CubeCamera(-90, WebGPU) followed by CubeTextureNode's X flip and
    // cubeFaceCoordinate's texel lookup, expressed in projection-face order. Horizontal reversal
    // below maps raster camera right to the reference's cube sampler U axis.
    static const Vector3 directions[] = {{1, 0, 0}, {-1, 0, 0}, {0, 1, 0}, {0, -1, 0}, {0, 0, 1}, {0, 0, -1}};
    static const Vector3 ups[] = {{0, 1, 0}, {0, 1, 0}, {0, 0, -1}, {0, 0, 1}, {0, 1, 0}, {0, 1, 0}};
    PerspectiveCamera camera(90, 1, near, far);
    camera.position.set(position[0], position[1], position[2]);
    camera.up = ups[face];
    auto target = camera.position.clone().add(directions[face]);
    camera.lookAt(target);
    camera.updateMatrixWorld(true);
    const auto size = volume.cubemapSize();
    capture.setSize(size, size);
    capture.setProbeVolume(name, volume, true);
    RenderDatabase database;
    database.render(capture, scene, camera);
    if (!database.diagnostics().empty())
        return GpuStatus::DeviceError;
    auto status = capture.readProbePixels([size, done = std::move(done)](GpuStatus status, std::vector<uint8_t> bytes) {
        if (status != GpuStatus::Ok || bytes.size() != size_t(size) * size * 8) {
            done(status == GpuStatus::Ok ? GpuStatus::OutOfRange : status, {});
            return;
        }
        std::vector<float> rgb(size_t(size) * size * 3);
        for (uint32_t y = 0; y < size; ++y)
            for (uint32_t x = 0; x < size; ++x)
                for (uint32_t c = 0; c < 3; ++c) {
                    const size_t input = (size_t(y) * size + (size - 1 - x)) * 8 + c * 2;
                    const uint16_t bits = uint16_t(bytes[input]) | (uint16_t(bytes[input + 1]) << 8);
                    const float value = halfFloat(bits);
                    if (!std::isfinite(value)) {
                        done(GpuStatus::DeviceError, {});
                        return;
                    }
                    rgb[(size_t(y) * size + x) * 3 + c] = value;
                }
        done(GpuStatus::Ok, std::move(rgb));
    });
    return status;
}
ProbeStepStatus ProbeBaker::process(Renderer& renderer, Object3D& scene, ProbeVolume& volume, const std::string& name,
                                    std::string& error) {
    waiting_ = false;
    const auto status = volume.processAsync(
        clockMs_,
        [&](const ProbeWorkItem& item, std::span<float> rgb, std::string& reason) {
            if (!face_ || face_->volume != &volume || face_->revision != volume.revision() ||
                face_->item.probe != item.probe || face_->item.face != item.face || face_->item.pass != item.pass) {
                face_ = std::make_shared<Face>();
                face_->volume = &volume;
                face_->revision = volume.revision();
                face_->item = item;
                const auto submitted = captureFace(renderer, scene, volume, name, item.probe, item.face, near_, far_,
                                                   [face = face_](GpuStatus s, std::vector<float> pixels) {
                                                       face->status = s;
                                                       face->rgb = std::move(pixels);
                                                       face->done = true;
                                                   });
                if (submitted != GpuStatus::Ok) {
                    reason = "TN_PROBES_CAPTURE";
                    face_.reset();
                    return CaptureResult::Failed;
                }
            }
            if (!face_->done) {
                waiting_ = true;
                return CaptureResult::Pending;
            }
            if (face_->status != GpuStatus::Ok || face_->rgb.size() != rgb.size()) {
                reason = "TN_PROBES_CAPTURE";
                face_.reset();
                return CaptureResult::Failed;
            }
            std::copy(face_->rgb.begin(), face_->rgb.end(), rgb.begin());
            face_.reset();
            return CaptureResult::Ready;
        },
        error);
    if (status != ProbeStepStatus::Progress)
        face_.reset();
    renderer.setProbeVolume(name, volume);
    return status;
}
} // namespace tn::engine::probes
