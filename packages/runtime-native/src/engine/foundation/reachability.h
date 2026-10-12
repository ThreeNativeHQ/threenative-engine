#pragma once

#include <cstdint>
#include <functional>
#include <vector>

#include "engine/foundation/handles.h"

namespace tn::engine {

/**
 * The object graph's lifetime (PRD-503). Objects live while a root reaches them: an active scene,
 * a native owner, a language wrapper the adapter still holds, a pending callback. Edges are the
 * observable links (parent/child both ways, mesh→material, userData, callback→capture). Cycles
 * with no root are reclaimed at a safe point; nothing is reference-counted, so nothing leaks.
 * `scene.remove()` is an edge removal, `dispose()` is the owner releasing GPU data — neither is
 * reclamation. Single-threaded: collections run between frames on the engine thread.
 */
class ObjectGraph {
public:
    using Reclaim = std::function<void()>;

    struct CollectStats {
        uint32_t marked = 0;
        uint32_t reclaimed = 0;
        uint64_t pauseNs = 0;
    };

    explicit ObjectGraph(uint16_t context) : handles_(context) {}

    /** `onReclaim` releases the object's native resources (GPU ones through the deferred queue). */
    Handle create(uint16_t type, Reclaim onReclaim = {});
    bool addEdge(Handle from, Handle to);
    bool removeEdge(Handle from, Handle to);
    /** Counted: a wrapper and a scene may both root one object. */
    bool root(Handle object);
    bool unroot(Handle object);

    /** A safe point: mark from the roots, reclaim the rest. */
    CollectStats collect();

    bool alive(Handle object) const { return handles_.check(object) == HandleError::None; }
    uint32_t liveCount() const { return handles_.liveCount(); }
    uint64_t reclaimedTotal() const { return reclaimedTotal_; }

private:
    struct Node {
        Handle self;
        std::vector<Handle> edges;
        Reclaim onReclaim;
        uint32_t roots = 0;
        uint32_t mark = 0;
    };

    Node* node(Handle handle);

    HandleTable handles_;
    std::vector<Node> nodes_;
    uint32_t epoch_ = 0;
    uint64_t reclaimedTotal_ = 0;
};

}  // namespace tn::engine
