#include "reachability.h"

#include <algorithm>
#include <chrono>

namespace tn::engine {

ObjectGraph::Node* ObjectGraph::node(Handle handle) {
    return handles_.check(handle) == HandleError::None ? &nodes_[handle.index] : nullptr;
}

Handle ObjectGraph::create(uint16_t type, Reclaim onReclaim) {
    const Handle handle = handles_.allocate(type);
    if (handle.type == 0) return handle;
    if (nodes_.size() <= handle.index) nodes_.resize(handle.index + 1);
    Node& n = nodes_[handle.index];
    n = Node{};
    n.self = handle;
    n.onReclaim = std::move(onReclaim);
    return handle;
}

bool ObjectGraph::addEdge(Handle from, Handle to) {
    Node* source = node(from);
    if (!source || !alive(to)) return false;
    source->edges.push_back(to);
    return true;
}

bool ObjectGraph::removeEdge(Handle from, Handle to) {
    Node* source = node(from);
    if (!source) return false;
    auto& edges = source->edges;
    const auto it = std::find_if(edges.begin(), edges.end(), [&](const Handle& e) {
        return e.index == to.index && e.generation == to.generation;
    });
    if (it == edges.end()) return false;
    *it = edges.back();
    edges.pop_back();
    return true;
}

bool ObjectGraph::root(Handle object) {
    Node* n = node(object);
    if (!n) return false;
    ++n->roots;
    return true;
}

bool ObjectGraph::unroot(Handle object) {
    Node* n = node(object);
    if (!n || n->roots == 0) return false;
    --n->roots;
    return true;
}

ObjectGraph::CollectStats ObjectGraph::collect() {
    const auto start = std::chrono::steady_clock::now();
    CollectStats stats;
    // A fresh epoch instead of clearing marks: nothing unmarked survives from a previous collection.
    const uint32_t epoch = ++epoch_ == 0 ? ++epoch_ : epoch_;

    // Iterative, so a 100,000-deep hierarchy cannot overflow the stack.
    std::vector<uint32_t> stack;
    for (Node& n : nodes_) {
        if (n.roots > 0 && alive(n.self) && n.mark != epoch) {
            n.mark = epoch;
            stack.push_back(n.self.index);
        }
    }
    while (!stack.empty()) {
        const uint32_t index = stack.back();
        stack.pop_back();
        ++stats.marked;
        // Edges to reclaimed objects are dropped here, so a stale edge never outlives one collection.
        auto& edges = nodes_[index].edges;
        for (size_t i = 0; i < edges.size();) {
            const Handle to = edges[i];
            if (!alive(to)) {
                edges[i] = edges.back();
                edges.pop_back();
                continue;
            }
            Node& target = nodes_[to.index];
            if (target.mark != epoch) {
                target.mark = epoch;
                stack.push_back(to.index);
            }
            ++i;
        }
    }

    // Collect first, then run reclaim hooks, so a hook that touches the graph sees it settled.
    std::vector<Reclaim> hooks;
    for (Node& n : nodes_) {
        if (!alive(n.self) || n.mark == epoch) continue;
        if (n.onReclaim) hooks.push_back(std::move(n.onReclaim));
        handles_.release(n.self);
        n = Node{};
        ++stats.reclaimed;
    }
    for (Reclaim& hook : hooks) hook();
    reclaimedTotal_ += stats.reclaimed;
    stats.pauseNs = static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now() - start).count());
    return stats;
}

}  // namespace tn::engine
