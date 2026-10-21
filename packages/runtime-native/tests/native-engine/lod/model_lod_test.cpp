// PRD-519: every recorded discrete-LOD selection value and chosen level reproduces
// packages/core/src/model-lod.ts exactly. The table is generated from that module
// (packages/runtime-native/tests/native-engine/lod/model-lod-reference.ts): the pure functions run
// over deterministic argument sets including their refusals, and four scripted camera paths approach
// and recede across switch distances so hysteresis keeps a level on the way back and a bias moves
// the switches.
#include "check.h"
#include "engine/renderer/lod/model_lod.h"

#include <bit>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

using namespace tn::engine;
using namespace tn::engine::lod;

namespace {

constexpr double bitsToDouble(uint64_t bits) { return std::bit_cast<double>(bits); }
constexpr uint64_t doubleToBits(double value) { return std::bit_cast<uint64_t>(value); }

// Bit-exact, except that every NaN is the same value: JavaScript cannot tell NaN payloads apart,
// and an arithmetic NaN's sign bit is the hardware's (x86 sets it, ARM does not).
bool same(uint64_t got, uint64_t want) {
    return got == want || (std::isnan(bitsToDouble(got)) && std::isnan(bitsToDouble(want)));
}

bool isCode(const std::string& error, std::string_view code) { return error == std::string(code); }

// The generated classification: 0 ok, 1 TN_LOD_VIEWPORT, 2 TN_LOD_ORTHO, 3 TN_LOD_CAMERA.
int outcomeCode(const std::string& error) {
    if (isCode(error, kLodViewportCode))
        return 1;
    if (isCode(error, kLodOrthoCode))
        return 2;
    if (isCode(error, kLodCameraCode))
        return 3;
    return -1;
}

// Camera kind: 0 perspective, 1 orthographic, 2 plain Camera. Mirrors the generator's makeCamera.
std::unique_ptr<Camera> makeCamera(int kind, double fov, double top, double bottom, double zoom) {
    if (kind == 0) {
        auto camera = std::make_unique<PerspectiveCamera>(fov, 1.0, 0.1, 1000.0);
        camera->zoom = zoom;
        camera->updateMatrixWorld(true);
        return camera;
    }
    if (kind == 1) {
        auto camera = std::make_unique<OrthographicCamera>(-1.0, 1.0, top, bottom, 0.1, 100.0);
        camera->zoom = zoom;
        camera->updateMatrixWorld(true);
        return camera;
    }
    return std::make_unique<Camera>();
}

struct PixelScaleCase {
    int kind;
    uint64_t fov, top, bottom, zoom, viewport, depth;
    int outcome;
    uint64_t expected;
};

struct ErrorCase {
    uint64_t worldError;
    int kind;
    uint64_t fov, top, bottom, zoom, viewport, depth;
    int outcome;
    uint64_t expected;
};

struct DepthCase {
    uint64_t camX, camY, camZ, nearPlane;
    uint64_t centerX, centerY, centerZ, radius;
    uint64_t expectedDepth;
    bool expectedDegenerate;
};

struct SphereCase {
    uint64_t localX, localY, localZ, localRadius;
    uint64_t posX, posY, posZ, scaleX, scaleY, scaleZ;
    uint64_t expectedCenterX, expectedCenterY, expectedCenterZ, expectedRadius;
};

struct BiasCase {
    uint64_t bias, distance, expectedBias, expectedDistance;
};

struct SelectViewRow {
    int kind;
    uint64_t fov, top, bottom, zoom, viewport, depth;
    bool degenerate, finest;
};

struct SelectCase {
    const uint64_t* errors;
    std::size_t errorCount;
    int current;
    uint64_t budgetPixels, hysteresis;
    const SelectViewRow* views;
    std::size_t viewCount;
    int outcome;
    int expected;
};

struct LodPathCase {
    uint64_t bias, budgetPixels, hysteresis, fov, nearPlane, viewportHeight;
    const uint64_t* errors;
    std::size_t errorCount;
    const uint64_t* local;    // 4
    const uint64_t* position; // 3
    const uint64_t* scale;    // 3
    const uint64_t* cameraZ;
    std::size_t stepCount;
    const int* levels;
};

#include "model_lod_reference.inc"

std::vector<double> valuesFromBits(const uint64_t* values, std::size_t count) {
    std::vector<double> result;
    result.reserve(count);
    for (std::size_t i = 0; i < count; ++i)
        result.push_back(bitsToDouble(values[i]));
    return result;
}

void modelLod() {
    std::size_t values = 0;
    std::size_t levels = 0;
    std::size_t mismatched = 0;

    for (const PixelScaleCase& c : kPixelScaleCases) {
        auto camera =
            makeCamera(c.kind, bitsToDouble(c.fov), bitsToDouble(c.top), bitsToDouble(c.bottom), bitsToDouble(c.zoom));
        double value = 0;
        std::string error;
        const bool ok = lodPixelScale(*camera, bitsToDouble(c.viewport), bitsToDouble(c.depth), value, error);
        const int outcome = ok ? 0 : outcomeCode(error);
        ++values;
        if (outcome != c.outcome || (c.outcome == 0 && !same(doubleToBits(value), c.expected))) {
            if (mismatched < 8)
                std::fprintf(stderr,
                             "pixel scale kind %d vp %.17g depth %.17g: outcome %d/%d value 0x%016llx/0x%016llx (%s)\n",
                             c.kind, bitsToDouble(c.viewport), bitsToDouble(c.depth), outcome, c.outcome,
                             (unsigned long long)doubleToBits(value), (unsigned long long)c.expected, error.c_str());
            ++mismatched;
        }
    }

    for (const ErrorCase& c : kErrorCases) {
        auto camera =
            makeCamera(c.kind, bitsToDouble(c.fov), bitsToDouble(c.top), bitsToDouble(c.bottom), bitsToDouble(c.zoom));
        double value = 0;
        std::string error;
        const bool ok = projectedLodError(bitsToDouble(c.worldError), *camera, bitsToDouble(c.viewport),
                                          bitsToDouble(c.depth), value, error);
        const int outcome = ok ? 0 : outcomeCode(error);
        ++values;
        if (outcome != c.outcome || (c.outcome == 0 && !same(doubleToBits(value), c.expected))) {
            if (mismatched < 8)
                std::fprintf(stderr, "projected error %.17g kind %d: outcome %d/%d value 0x%016llx/0x%016llx (%s)\n",
                             bitsToDouble(c.worldError), c.kind, outcome, c.outcome,
                             (unsigned long long)doubleToBits(value), (unsigned long long)c.expected, error.c_str());
            ++mismatched;
        }
    }

    for (const DepthCase& c : kDepthCases) {
        const double nearPlane = bitsToDouble(c.nearPlane);
        PerspectiveCamera camera(60, 1, nearPlane, 5000);
        camera.position.set(bitsToDouble(c.camX), bitsToDouble(c.camY), bitsToDouble(c.camZ));
        camera.updateMatrixWorld(true);
        double depth = 0;
        bool degenerate = false;
        conservativeViewDepth(camera,
                              Vector3(bitsToDouble(c.centerX), bitsToDouble(c.centerY), bitsToDouble(c.centerZ)),
                              bitsToDouble(c.radius), nearPlane, depth, degenerate);
        values += 2;
        if (!same(doubleToBits(depth), c.expectedDepth) || degenerate != c.expectedDegenerate) {
            if (mismatched < 8)
                std::fprintf(stderr, "view depth: 0x%016llx/0x%016llx degenerate %d/%d\n",
                             (unsigned long long)doubleToBits(depth), (unsigned long long)c.expectedDepth, degenerate,
                             c.expectedDegenerate);
            ++mismatched;
        }
    }

    for (const SphereCase& c : kSphereCases) {
        Object3D object;
        object.position.set(bitsToDouble(c.posX), bitsToDouble(c.posY), bitsToDouble(c.posZ));
        object.scale.set(bitsToDouble(c.scaleX), bitsToDouble(c.scaleY), bitsToDouble(c.scaleZ));
        object.updateMatrixWorld(true);
        const Sphere local(Vector3(bitsToDouble(c.localX), bitsToDouble(c.localY), bitsToDouble(c.localZ)),
                           bitsToDouble(c.localRadius));
        const Sphere world = worldSphere(local, object.matrixWorld);
        const uint64_t got[4] = {doubleToBits(world.center.x), doubleToBits(world.center.y),
                                 doubleToBits(world.center.z), doubleToBits(world.radius)};
        const uint64_t want[4] = {c.expectedCenterX, c.expectedCenterY, c.expectedCenterZ, c.expectedRadius};
        values += 4;
        for (int i = 0; i < 4; ++i) {
            if (same(got[i], want[i]))
                continue;
            if (mismatched < 8)
                std::fprintf(stderr, "world sphere %d: 0x%016llx/0x%016llx\n", i, (unsigned long long)got[i],
                             (unsigned long long)want[i]);
            ++mismatched;
        }
    }

    for (const BiasCase& c : kBiasCases) {
        setLodBias(bitsToDouble(c.bias));
        const uint64_t gotBias = doubleToBits(lodBias());
        const uint64_t gotDistance = doubleToBits(biasedLodDistance(bitsToDouble(c.distance)));
        values += 2;
        if (!same(gotBias, c.expectedBias) || !same(gotDistance, c.expectedDistance)) {
            if (mismatched < 8)
                std::fprintf(stderr, "bias %.17g distance %.17g: 0x%016llx/0x%016llx 0x%016llx/0x%016llx\n",
                             bitsToDouble(c.bias), bitsToDouble(c.distance), (unsigned long long)gotBias,
                             (unsigned long long)c.expectedBias, (unsigned long long)gotDistance,
                             (unsigned long long)c.expectedDistance);
            ++mismatched;
        }
    }
    setLodBias(1);

    for (const SelectCase& c : kSelectCases) {
        const std::vector<double> errors = valuesFromBits(c.errors, c.errorCount);
        std::vector<LodView> views;
        std::vector<std::unique_ptr<Camera>> cameras;
        views.reserve(c.viewCount);
        cameras.reserve(c.viewCount);
        for (std::size_t i = 0; i < c.viewCount; ++i) {
            const SelectViewRow& view = c.views[i];
            cameras.push_back(makeCamera(view.kind, bitsToDouble(view.fov), bitsToDouble(view.top),
                                         bitsToDouble(view.bottom), bitsToDouble(view.zoom)));
            views.push_back({cameras.back().get(), view.degenerate, bitsToDouble(view.depth),
                             bitsToDouble(view.viewport), view.finest});
        }
        int chosen = 0;
        std::string error;
        const bool ok = selectLodLevel(errors, c.current, bitsToDouble(c.budgetPixels), bitsToDouble(c.hysteresis),
                                       views, chosen, error);
        const int outcome = ok ? 0 : outcomeCode(error);
        ++levels;
        if (outcome != c.outcome || (c.outcome == 0 && chosen != c.expected)) {
            if (mismatched < 8)
                std::fprintf(stderr, "select case: outcome %d/%d level %d/%d (%s)\n", outcome, c.outcome, chosen,
                             c.expected, error.c_str());
            ++mismatched;
        }
    }

    for (const LodPathCase& p : kPathCases) {
        setLodBias(bitsToDouble(p.bias));
        PerspectiveCamera camera(bitsToDouble(p.fov), 1, bitsToDouble(p.nearPlane), 5000);
        Object3D object;
        object.position.set(bitsToDouble(p.position[0]), bitsToDouble(p.position[1]), bitsToDouble(p.position[2]));
        object.scale.set(bitsToDouble(p.scale[0]), bitsToDouble(p.scale[1]), bitsToDouble(p.scale[2]));
        object.updateMatrixWorld(true);
        const Sphere local(Vector3(bitsToDouble(p.local[0]), bitsToDouble(p.local[1]), bitsToDouble(p.local[2])),
                           bitsToDouble(p.local[3]));
        DiscreteLod controller(valuesFromBits(p.errors, p.errorCount), bitsToDouble(p.budgetPixels),
                               bitsToDouble(p.hysteresis));
        for (std::size_t i = 0; i < p.stepCount; ++i) {
            camera.position.set(0, 0, bitsToDouble(p.cameraZ[i]));
            camera.updateMatrixWorld(true);
            int chosen = 0;
            std::string error;
            const bool ok = controller.update(camera, bitsToDouble(p.viewportHeight), local, object, chosen, error);
            ++levels;
            if (!ok || chosen != p.levels[i]) {
                if (mismatched < 8)
                    std::fprintf(stderr, "path step %zu z %.17g: level %d/%d (%s)\n", i, bitsToDouble(p.cameraZ[i]),
                                 chosen, p.levels[i], error.c_str());
                ++mismatched;
            }
        }
    }
    setLodBias(1);

    std::printf("model lod: %zu values, %zu levels, %zu differ\n", values, levels, mismatched);
    CHECK(values > 0 && levels > 0 && mismatched == 0);
}

} // namespace

TN_TEST_MAIN({"model_lod", modelLod})
