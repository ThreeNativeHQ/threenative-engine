#pragma once

#include <cstdint>
#include <memory>
#include <unordered_map>
#include <vector>

namespace tn::engine {

class BufferAttribute;
class BufferGeometry;
class Camera;
class Mesh;
class Object3D;
class Sphere;

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
    // Main-thread-only diagnostic hook; the owning player installs and clears its existing CPU clock.
    struct CpuTiming {
        double (*clock)() = nullptr;
        double ms = 0;
        uint64_t calls = 0;
        bool available = true;
    };
    static CpuTiming cpuTiming;
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
    /**
     * core's `__restoreCull()`. A host that draws after the frame callbacks return (the player draws
     * in C++ after `beforeRender`) holds it, so the draw sees this frame's hides; the host releases
     * them once it has drawn. Without a hold this is restore().
     */
    void restoreAfterDraw();
    /** While held, restoreAfterDraw() defers its showing to releaseHeld(). */
    static void holdRestores(bool hold);
    /** Shows every object a held restoreAfterDraw() deferred. */
    static void releaseHeld();

    /** Times apply() rebuilt its flat walk (a hierarchy change, another root or camera); for the ctest. */
    [[nodiscard]] uint64_t rebuilds() const { return rebuilds_; }

    /**
     * core's animation rate bands (render-camera-cull.ts `#visitAnimation` and `#observeAnimation`) for each rig,
     * in one call: the rig's visible renderables in traverseVisible order, each banded off the camera's forward
     * ray by the union of the rig's part spheres so far, and the rig's rate the least of its parts' (1, 2, 4 or
     * 8). 0 means no part was visited, and core leaves that rig's state alone, as its walk does. Bounds follow
     * apply()'s rule with their own versions, so a band walk before the cull counts each consult once.
     */
    std::vector<double> bandRates(const std::vector<Object3D*>& rigs, const Camera& camera, bool cameraResolved,
                                  double scale);

private:
    /**
     * The tree under the root in three's traverse order, built once per hierarchy version: a node, where its
     * subtree ends (so a hidden node skips it whole, as traverseVisible does) and, for a renderable, its mesh and
     * whether it hangs under the camera. A frame then reads no type string and casts nothing (PRD-610 AC-4).
     */
    struct Node {
        Object3D* object;
        const Mesh* mesh;  // null: not a renderable
        uint32_t end;            // index past this node's subtree
        bool cameraAttached;
        bool instanced;          // an InstancedMesh: its own bound comes first
        // The mesh's geometry and its position attribute at that geometry's revision, so a frame does not
        // look "position" up in the attribute map (most of the cull's time in Midway flight).
        const BufferGeometry* geometry = nullptr;
        uint64_t geometryRevision = 0;
        const BufferAttribute* position = nullptr;
    };
    std::vector<Node> nodes_;
    uint64_t nodesVersion_ = 0;
    const Object3D* nodesRoot_ = nullptr;
    const Camera* nodesCamera_ = nullptr;
    uint64_t rebuilds_ = 0;
    void rebuild(Object3D& root, const Camera& camera);

    struct Version {
        std::weak_ptr<const BufferGeometry> geometry;
        uint32_t version = 0;
        bool changedLastConsult = false;
        bool stale = false;
    };
    std::unordered_map<const BufferGeometry*, Version> versions_;
    std::unordered_map<const BufferGeometry*, Version> bandVersions_;
    std::vector<std::weak_ptr<Object3D>> hidden_;

    enum class Bound { Sphere, Dynamic, None };
    Bound boundsOf(Node& node, const Sphere*& sphere, std::unordered_map<const BufferGeometry*, Version>& versions);
    /** A rig's flat walk, kept while the hierarchy holds still, like nodes_. */
    struct RigWalk {
        std::weak_ptr<const Object3D> rig;
        std::vector<Node> nodes;
        uint64_t version = 0;
    };
    std::unordered_map<const Object3D*, RigWalk> rigWalks_;
    static void walk(std::vector<Node>& nodes, Object3D& root, const Camera& camera);
};

}  // namespace tn::engine
