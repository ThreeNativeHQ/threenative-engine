#include "check.h"
#include "package_writer.h"
#include "engine/assets/probe_volume.h"
#include "engine/shader/standard.h"
#include "engine/shader/package.h"
#include <algorithm>
#include <cmath>
#include <limits>
using namespace tn::engine::probes;
namespace {
ProbeVolume make(uint32_t bounces = 0) {
    ProbeVolumeDescription d;
    std::fill_n(d.boundsMax, 3, 1);
    ProbeScheduleOptions o;
    o.bounces = bounces;
    o.bakeBudgetMs = 100;
    o.maxWorkItemsPerFrame = 17;
    ProbeVolume v;
    std::string error;
    CHECK(ProbeVolume::create(d, o, 4, v, error));
    return v;
}
void projection() {
    std::string error;
    std::vector<float> rgb(6 * 4 * 4 * 3, 1);
    ProbeCoefficients c;
    CHECK(projectCubemap(rgb, 4, c, error));
    CHECK(std::abs(c[0] - 3.5449103) < 1e-5);
    for (size_t i = 3; i < c.size(); ++i)
        CHECK(std::abs(c[i]) < 1e-5);
    // +X alone has a positive x coefficient, -X reverses it, Y/Z terms cancel.
    std::fill(rgb.begin(), rgb.end(), 0);
    std::fill_n(rgb.begin(), 4 * 4 * 3, 1);
    CHECK(projectCubemap(rgb, 4, c, error));
    CHECK(c[9] > 0.8);
    CHECK(std::abs(c[3]) < 1e-6 && std::abs(c[6]) < 1e-6);
    std::rotate(rgb.begin(), rgb.begin() + 4 * 4 * 3, rgb.end());
    CHECK(projectCubemap(rgb, 4, c, error)); // +X became -Z; coefficient ordering stays y,z,x.
    CHECK(c[6] < -0.8 && std::abs(c[9]) < 1e-6);
    rgb[0] = std::numeric_limits<float>::quiet_NaN();
    CHECK(!projectCubemap(rgb, 4, c, error));
    CHECK(!projectCubemap({}, 0, c, error));
    // Frozen independent f32 projection of three-channel, face/row/column-varying radiance.
    // Constants are computed as JS doubles, then GPU mul/add and accumulation round to f32.
    const ProbeCoefficients expected = {
        2.8359282f,       3.22586727f,     3.61580896f,   -0.205729574f, -0.205729589f, -0.205729514f,   -0.170588672f,
        -0.170588642f,    -0.170588732f,   -0.129590884f, -0.129590884f, -0.129590914f, 6.44153042e-09f, 0.f,
        -1.28830608e-08f, 0.030478159f,    0.0304780751f, 0.0304780565f, 0.881470382f,  0.881470263f,    0.881470263f,
        -3.86491834e-08f, 2.57661217e-08f, 0.f,           -0.508916259f, -0.508916259f, -0.508916259f};
    rgb.resize(6 * 3 * 3 * 3);
    for (uint32_t face = 0; face < 6; ++face)
        for (uint32_t y = 0; y < 3; ++y)
            for (uint32_t x = 0; x < 3; ++x)
                for (uint32_t ch = 0; ch < 3; ++ch)
                    rgb[((face * 3 + y) * 3 + x) * 3 + ch] = float((face + 1) * .2 + y * .03 + x * .07 + ch * .11);
    CHECK(projectCubemap(rgb, 3, c, error));
    for (size_t i = 0; i < c.size(); ++i)
        CHECK(c[i] == expected[i]);
}
void sampling() {
    auto v = make();
    std::string error;
    for (uint32_t p = 0; p < 8; ++p) {
        ProbeCoefficients c{};
        c[0] = float(p + 1);
        c[26] = float(p + 11);
        CHECK(v.writeProbe(p, c, error));
    }
    CHECK(std::abs(v.sample({.5, .5, .5}, {0, 0, 0})[0] - 4.5 * 0.886227) < 1e-5);
    CHECK(std::abs(v.sample({-1, -1, -1}, {0, 0, 0})[0] - 0.886227) < 1e-5);
    auto a = v.atlas();
    const auto& p = v.placement();
    for (uint32_t sub = 0; sub < 7; ++sub)
        for (uint32_t xy = 0; xy < 4; ++xy)
            for (uint32_t ch = 0; ch < 4; ++ch) {
                CHECK(a[(sub * p.paddedSlices * 4 + xy) * 4 + ch] == a[((sub * p.paddedSlices + 1) * 4 + xy) * 4 + ch]);
                CHECK(a[((sub * p.paddedSlices + 3) * 4 + xy) * 4 + ch] ==
                      a[((sub * p.paddedSlices + 2) * 4 + xy) * 4 + ch]);
            }
    CHECK(a.back() == 0);
    ProbeCoefficients c{};
    c[3] = 1;
    c[6] = 2;
    c[9] = 3;
    c[18] = 4;
    CHECK(v.writeProbe(0, c, error));
    CHECK(std::abs(v.sample({0, 0, 0}, {0, 1, 0})[0] - std::max(0., 1.023328 - 4 * .247708)) < 1e-6);
    CHECK(std::abs(v.sample({0, 0, 0}, {0, 0, 1})[0] - (2 * 1.023328 + 4 * (.743125 - .247708))) < 1e-6);
}
void bake() {
    auto v = make(1);
    CHECK(v.requestBake());
    CHECK(v.samplingIsolated());
    CHECK(!v.requestBake());
    std::string error;
    double clock = 0;
    size_t direct = 0, indirect = 0;
    auto capture = [&](const ProbeWorkItem& item, std::span<float> face, std::string&) {
        if (item.pass == 0) {
            ++direct;
            CHECK(v.sampleCapture({0, 0, 0}, {0, 1, 0})[0] == 0);
            if (direct <= 48)
                CHECK(std::all_of(v.displayAtlas().begin(), v.displayAtlas().end(), [](float x) { return x == 0; }));
        } else {
            ++indirect;
            CHECK(v.sampleCapture({0, 0, 0}, {0, 1, 0})[0] > 3);
        }
        std::fill(face.begin(), face.end(), item.pass ? 2.f : 1.f);
        return true;
    };
    for (int i = 0; i < 100 && v.pending(); ++i)
        CHECK(v.process(clock, capture, error) != ProbeStepStatus::Refused);
    CHECK(v.ready() && direct == 48 && indirect == 48);
    CHECK(v.sample({0, 0, 0}, {0, 1, 0})[0] > 6);
    for (auto count : v.captureCounts())
        CHECK(count == 12);
    const auto before = v.sample({1, 1, 1}, {0, 1, 0});
    uint32_t index = 0;
    CHECK(v.invalidate(std::span(&index, 1), error));
    CHECK(v.sample({0, 0, 0}, {0, 1, 0})[0] == 0);
    CHECK(v.sample({1, 1, 1}, {0, 1, 0}) == before);
    for (int i = 0; i < 100 && v.pending(); ++i)
        CHECK(v.process(clock, capture, error) != ProbeStepStatus::Refused);
    CHECK(v.captureCounts()[0] == 24);
    for (size_t i = 1; i < 8; ++i)
        CHECK(v.captureCounts()[i] == 12);
    CHECK(v.sample({1, 1, 1}, {0, 1, 0}) == before);
    CHECK(v.requestBake());
    CHECK(v.process(clock, [](const auto&, auto, std::string&) { return false; }, error) == ProbeStepStatus::Refused);
    CHECK(!v.ready() && !v.pending());
    CHECK(v.sample({0, 0, 0}, {0, 1, 0})[0] == 0);
}
void asynchronous() {
    auto volume = make();
    std::string error;
    double clock = 0;
    CHECK(volume.requestBake());
    const auto revision = volume.revision();
    for (int frame = 0; frame < 3; ++frame) {
        CHECK(volume.processAsync(
                  clock,
                  [&](const ProbeWorkItem& item, std::span<float>, std::string&) {
                      CHECK(item.probe == 0 && item.face == 0 && item.pass == 0);
                      return CaptureResult::Pending;
                  },
                  error) == ProbeStepStatus::Progress);
        CHECK(clock == 0 && volume.captureCounts()[0] == 0 && volume.pending());
        CHECK(volume.revision() == revision);
    }
    CHECK(volume.processAsync(
              clock,
              [](const auto& item, std::span<float> face, std::string&) {
                  CHECK(item.face == 0);
                  std::fill(face.begin(), face.end(), 1);
                  return CaptureResult::Ready;
              },
              error) == ProbeStepStatus::Progress);
    CHECK(volume.captureCounts()[0] == 1 && clock == 1);
    uint32_t affected = 0;
    CHECK(volume.invalidate(std::span(&affected, 1), error));
    CHECK(volume.revision() > revision);
    CHECK(volume.processAsync(
              clock,
              [](const auto& item, auto, std::string&) {
                  CHECK(item.probe == 0 && item.face == 0);
                  return CaptureResult::Pending;
              },
              error) == ProbeStepStatus::Progress);
    CHECK(clock == 1 && volume.captureCounts()[0] == 1);
}

void shaderSampling() {
    namespace s = tn::engine::shader;
    namespace g = s::graph;
    const auto volume = make();
    s::VertexVariant variant;
    variant.nodes.emissiveNode = g::div(s::probeSample(volume.placement(), "cpu"), g::float_(3.141592653589793));
    for (bool backSide : {false, true}) {
        variant.backSide = backSide;
        auto programs = s::buildLambert(variant, s::LightLayout{"p"});
        CHECK(programs.diagnostics.empty());
        CHECK(programs.vertex.ok() && programs.fragment.ok());
        const auto vertex = s::buildStage(programs.vertex, 0), fragment = s::buildStage(programs.fragment, 1);
        CHECK(vertex.wgsl.ok() && fragment.wgsl.ok());
        CHECK(fragment.wgsl.code.find("t_probe_cpu: texture_3d<f32>") != std::string::npos);
        CHECK(fragment.wgsl.code.find("textureSample(t_probe_cpu, smp_probe_cpu,") != std::string::npos);
        CHECK(vertex.wgsl.code.find("o_positionWorld") != std::string::npos);
        CHECK(fragment.wgsl.code.find("f_emissive") == std::string::npos);
        CHECK(std::count_if(fragment.bindings.begin(), fragment.bindings.end(), [](const auto& b) {
                  return b.kind == s::BindingKind::Texture && b.name == "t_probe_cpu" && b.volume && !b.depth && !b.cube;
              }) == 1);
        for (const auto& [name, type] : programs.fragment.varyings()) {
            const auto at = fragment.wgsl.code.find("i_" + name + ":");
            const auto location = fragment.wgsl.code.rfind("@location(", at),
                       end = fragment.wgsl.code.find(')', location);
            CHECK(vertex.wgsl.code.find(fragment.wgsl.code.substr(location, end - location + 1) + " o_" + name + ":") !=
                  std::string::npos);
        }
    }
    // A 3D float texture must reject 2D coordinates and comparison sampling.
    s::Program wrongCoordinate(s::Stage::Fragment);
    const auto texture = wrongCoordinate.texture3d("atlas");
    CHECK(texture == wrongCoordinate.texture3d("atlas"));
    CHECK(wrongCoordinate.sample(texture, wrongCoordinate.construct(s::Type::vec(2), {wrongCoordinate.constant(0.f)})) == s::kInvalid);
    s::Program wrongComparison(s::Stage::Fragment);
    CHECK(wrongComparison.sampleCompare(wrongComparison.texture3d("atlas"),
              wrongComparison.construct(s::Type::vec(3), {wrongComparison.constant(0.f)}),
              wrongComparison.constant(0.f)) == s::kInvalid);
    bool refused = false;
    try {
        (void)s::probeSample(volume.placement(), "invalid:name");
    } catch (const std::invalid_argument&) {
        refused = true;
    }
    CHECK(refused);
}

void cooked() {
    using namespace tn::engine::assets;
    auto v = make();
    std::string reason;
    ProbeCoefficients c{};
    for (uint32_t p = 0; p < 8; ++p) {
        for (size_t i = 0; i < c.size(); ++i)
            c[i] = float(0.03 * (i + 1) * (p + 1) * (i % 2 ? -1 : 1));
        CHECK(v.writeProbe(p, c, reason));
    }
    auto payload = cookProbeVolumePayload(v);
    auto pack = [&](const std::vector<uint8_t>& b) {
        return tn::test::writePackage({{"probes/test", 1, 0, b, b.size(), {}}});
    };
    auto bytes = pack(payload);
    ProbeVolume loaded;
    PackageError error;
    CHECK(loadProbeVolume(bytes, "test", loaded, error));
    CHECK(loaded.ready() && !loaded.pending());
    CHECK(std::equal(loaded.coefficients().begin(), loaded.coefficients().end(), v.coefficients().begin()));
    CHECK(std::equal(loaded.atlas().begin(), loaded.atlas().end(), v.atlas().begin()));
    CHECK(loaded.sample({.5, .5, .5}, {0, 1, 0}) == v.sample({.5, .5, .5}, {0, 1, 0}));
    for (auto count : loaded.captureCounts())
        CHECK(count == 0);
    bytes.back() ^= 1;
    CHECK(!loadProbeVolume(bytes, "test", loaded, error));
    CHECK(error.code == "TN_PACKAGE_HASH");
    payload.back() = 0x7f;
    payload[payload.size() - 2] = 0xc0;
    payload[payload.size() - 3] = 0;
    payload[payload.size() - 4] = 0;
    CHECK(!loadProbeVolume(pack(payload), "test", loaded, error));
    CHECK(error.code == "TN_PROBES_PAYLOAD");
    payload.resize(96);
    CHECK(!loadProbeVolume(pack(payload), "test", loaded, error));
    CHECK(!loadProbeVolume(pack(cookProbeVolumePayload(v)), "missing", loaded, error));
}
} // namespace
TN_TEST_MAIN({"projection", projection}, {"sampling", sampling}, {"bake", bake}, {"cooked", cooked},
             {"shader", shaderSampling}, {"async", asynchronous})
