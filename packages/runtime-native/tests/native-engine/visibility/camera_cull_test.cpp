// PRD-519: every recorded RenderCameraCull report reproduces over the native scene graph. The table
// is generated from packages/core/src/render-camera-cull.ts
// (packages/runtime-native/tests/native-engine/visibility/camera-cull-reference.ts): each scene is a
// flat node list, a camera, a viewport and the gate options the C++ test rebuilds natively, and the
// report the real gate produced for it. Every double is stored as its binary64 bit pattern and
// compares bit for bit, except that any two NaNs are equal.
#include "check.h"
#include "engine/renderer/visibility/camera_cull.h"

#include <bit>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <iterator>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "engine/scene/geometry.h"
#include "engine/scene/nodes.h"

using namespace tn::engine;
using namespace tn::engine::visibility;

namespace {

// Doubles travel as their binary64 bit pattern so the generator can write them as `0x...ull` and the
// comparison stays exact. counts stay decimal.
struct RefNode {
    int32_t parent; // -1 scene root, -2 camera, otherwise a node index
    bool mesh;
    uint64_t x, y, z;
    uint64_t sx, sy, sz;
    uint64_t radius;
    uint64_t centerX, centerY, centerZ;
    bool castShadow;
    bool frustumCulled;
    bool alwaysRender;
    bool visible;
    uint32_t layer;
};

struct RefCamera {
    bool perspective;
    uint64_t fov;
    uint64_t x, y, z;
};

struct RefExpected {
    bool enabled;
    bool cameraResolved;
    uint64_t thresholdPixels;
    uint32_t considered;
    uint32_t culled;
    uint32_t exemptCameraAttached;
    uint32_t exemptMarked;
    uint32_t exemptShadowCasters;
    uint32_t exemptWithoutBounds;
    uint32_t exemptDynamicBounds;
    uint32_t exemptFrustumCulled;
};

struct RefScene {
    const RefNode* nodes;
    std::size_t nodeCount;
    RefCamera camera;
    uint64_t viewportHeight;
    bool optionsEnabled;
    uint64_t optionsMinimumPixels;
    RefExpected expected;
};

#include "camera_cull_reference.inc"

constexpr double fromBits(uint64_t bits) { return std::bit_cast<double>(bits); }

// Bit-exact, except that every NaN is the same value: the reference is JavaScript, whose NaN
// payloads are not distinguishable (and x86 sets the sign bit on an arithmetic NaN, ARM does not).
bool sameDouble(double got, double want) {
    return std::bit_cast<uint64_t>(got) == std::bit_cast<uint64_t>(want) || (std::isnan(got) && std::isnan(want));
}

void cameraCull() {
    std::size_t compared = 0;
    std::size_t mismatched = 0;

    for (std::size_t sceneIndex = 0; sceneIndex < std::size(kCameraCullScenes); ++sceneIndex) {
        const RefScene& ref = kCameraCullScenes[sceneIndex];
        Scene root;
        std::vector<std::shared_ptr<Object3D>> objects;
        objects.reserve(ref.nodeCount);
        for (std::size_t index = 0; index < ref.nodeCount; ++index) {
            const RefNode& entry = ref.nodes[index];
            if (entry.mesh) {
                auto geometry = std::make_shared<BufferGeometry>();
                geometry->boundingSphere = std::make_shared<Sphere>();
                geometry->boundingSphere->center.set(fromBits(entry.centerX), fromBits(entry.centerY),
                                                     fromBits(entry.centerZ));
                geometry->boundingSphere->radius = fromBits(entry.radius);
                objects.push_back(std::make_shared<Mesh>(geometry, std::shared_ptr<Material>{}));
            } else {
                objects.push_back(std::make_shared<Group>());
            }
            Object3D& object = *objects.back();
            object.position.set(fromBits(entry.x), fromBits(entry.y), fromBits(entry.z));
            object.scale.set(fromBits(entry.sx), fromBits(entry.sy), fromBits(entry.sz));
            object.setVisible(entry.visible);
            object.setCastShadow(entry.castShadow);
            object.frustumCulled = entry.frustumCulled;
            object.setLayer(static_cast<int>(entry.layer));
        }

        std::shared_ptr<Camera> camera =
            ref.camera.perspective
                ? std::shared_ptr<Camera>(
                      std::make_shared<PerspectiveCamera>(fromBits(ref.camera.fov), 1, 0.1, 1'000'000))
                : std::shared_ptr<Camera>(std::make_shared<OrthographicCamera>(-1, 1, 1, -1, 0.1, 100));
        camera->position.set(fromBits(ref.camera.x), fromBits(ref.camera.y), fromBits(ref.camera.z));
        camera->updateMatrixWorld();

        bool cameraInScene = false;
        for (std::size_t index = 0; index < ref.nodeCount; ++index) {
            if (ref.nodes[index].parent == -2)
                cameraInScene = true;
        }
        if (cameraInScene)
            root.add(*camera);
        for (std::size_t index = 0; index < ref.nodeCount; ++index) {
            const int32_t parent = ref.nodes[index].parent;
            Object3D& target = parent == -2 ? *camera : parent < 0 ? root : *objects[static_cast<std::size_t>(parent)];
            target.add(*objects[index]);
        }

        const CameraCullOptions options{ref.optionsEnabled, fromBits(ref.optionsMinimumPixels)};
        std::string error;
        std::optional<CameraCull> cull = CameraCull::create(options, error);
        if (!cull) {
            ++mismatched;
            std::fprintf(stderr, "scene %zu: gate refused: %s\n", sceneIndex, error.c_str());
            continue;
        }
        for (std::size_t index = 0; index < ref.nodeCount; ++index) {
            if (ref.nodes[index].alwaysRender)
                cull->alwaysRender(*objects[index]);
        }
        root.updateMatrixWorld();
        camera->updateMatrixWorld();
        cull->apply(root, *camera, fromBits(ref.viewportHeight));

        const CameraCullReport& got = cull->report();
        const RefExpected& want = ref.expected;
        ++compared;
        const bool ok =
            got.enabled == want.enabled && got.cameraResolved == want.cameraResolved &&
            sameDouble(got.thresholdPixels, fromBits(want.thresholdPixels)) && got.considered == want.considered &&
            got.culled == want.culled && got.exemptCameraAttached == want.exemptCameraAttached &&
            got.exemptMarked == want.exemptMarked && got.exemptShadowCasters == want.exemptShadowCasters &&
            got.exemptWithoutBounds == want.exemptWithoutBounds &&
            got.exemptDynamicBounds == want.exemptDynamicBounds && got.exemptFrustumCulled == want.exemptFrustumCulled;
        if (!ok) {
            ++mismatched;
            std::fprintf(stderr,
                         "scene %zu: got {enabled %d resolved %d thr %.17g considered %u culled %u attached "
                         "%u marked %u shadow %u nobounds %u dynamic %u frustum %u}\n",
                         sceneIndex, got.enabled, got.cameraResolved, got.thresholdPixels, got.considered, got.culled,
                         got.exemptCameraAttached, got.exemptMarked, got.exemptShadowCasters, got.exemptWithoutBounds,
                         got.exemptDynamicBounds, got.exemptFrustumCulled);
            std::fprintf(stderr,
                         "         want {enabled %d resolved %d thr %.17g considered %u culled %u attached %u "
                         "marked %u shadow %u nobounds %u dynamic %u frustum %u}\n",
                         want.enabled, want.cameraResolved, fromBits(want.thresholdPixels), want.considered,
                         want.culled, want.exemptCameraAttached, want.exemptMarked, want.exemptShadowCasters,
                         want.exemptWithoutBounds, want.exemptDynamicBounds, want.exemptFrustumCulled);
        }
    }

    std::printf("camera cull: %zu scenes, %zu differ\n", compared, mismatched);
    CHECK(compared > 0 && mismatched == 0);
}

} // namespace

TN_TEST_MAIN({"camera_cull", cameraCull})
