#pragma once

#include <cstdint>
#include <memory>
#include <unordered_map>
#include <vector>

namespace tn::engine {

class BufferGeometry;
class Camera;
class Object3D;

/**
 * core's projected-size cull (packages/core/src/render-camera-cull.ts) in the engine, one call per
 * frame instead of a JS walk that reads every object's bounds, matrices and flags across the
 * boundary. The TypeScript is the rule's specification and this is its port, kept in step by
 * native_engine_projected_cull: every visible renderable under the root that the camera resolves to
 * fewer than `minimumPixels` is hidden, with the same exemptions and the same bound-staleness
 * tracking, and put back on the next apply() or restore().
 */
class ProjectedCull {
public:
    /** The counters core's report carries. */
    struct Report {
        uint32_t considered = 0, culled = 0, cameraAttached = 0, marked = 0, shadowCasters = 0, withoutBounds = 0,
                 dynamicBounds = 0, frustumCulled = 0;
    };
    /**
     * `cameraResolved` and `scale` (viewportHeight / (2 tan(fov / 2))) come from the caller, which owns
     * the camera rules (a perspective camera, a positive viewport); the walk runs either way, as core's
     * does, so a disabled or unresolved cull still reports what it considered.
     */
    Report apply(Object3D& root, const Camera& camera, bool cameraResolved, double scale, double minimumPixels,
                 bool enabled);
    /** Shows again every object the last apply() hid. */
    void restore();

private:
    struct Version {
        std::weak_ptr<const BufferGeometry> geometry;
        uint32_t version = 0;
        bool changedLastConsult = false;
        bool stale = false;
    };
    std::unordered_map<const BufferGeometry*, Version> versions_;
    std::vector<std::weak_ptr<Object3D>> hidden_;
};

}  // namespace tn::engine
