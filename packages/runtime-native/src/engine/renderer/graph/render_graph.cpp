#include "render_graph.h"

#include <algorithm>

namespace tn::engine::graph {

ResourceId RenderGraph::transient(std::string name, TextureDesc desc) {
    resources_.push_back(Resource{std::move(name), desc, false});
    return static_cast<ResourceId>(resources_.size() - 1);
}

ResourceId RenderGraph::external(std::string name, TextureDesc desc) {
    resources_.push_back(Resource{std::move(name), desc, true});
    return static_cast<ResourceId>(resources_.size() - 1);
}

PassId RenderGraph::pass(std::string name, PassKind kind, std::vector<Read> reads, std::vector<ResourceId> writes) {
    passes_.push_back(Pass{std::move(name), kind, std::move(reads), std::move(writes)});
    return static_cast<PassId>(passes_.size() - 1);
}

RenderGraph::Compiled RenderGraph::compile() const {
    Compiled out;
    const size_t passCount = passes_.size();

    // Producers per resource, in declaration order.
    std::vector<std::vector<PassId>> producers(resources_.size());
    for (PassId p = 0; p < passCount; ++p) {
        for (ResourceId w : passes_[p].writes) producers[w].push_back(p);
    }

    // Edges: every producer of a read runs before the reader. A pass may read what it writes
    // (read-modify-write of an attachment); that is not a dependency on itself.
    std::vector<std::vector<PassId>> successors(passCount);
    std::vector<uint32_t> indegree(passCount, 0);
    for (PassId p = 0; p < passCount; ++p) {
        for (const Read& r : passes_[p].reads) {
            const Resource& res = resources_[r.resource];
            if (r.expectedFormat != 0 && r.expectedFormat != res.desc.format) {
                out.errors.push_back({"TN_GRAPH_FORMAT", passes_[p].name + " reads " + res.name + " as format " +
                                                             std::to_string(r.expectedFormat) + ", it is " +
                                                             std::to_string(res.desc.format)});
            }
            if (!res.external && producers[r.resource].empty()) {
                out.errors.push_back({"TN_GRAPH_MISSING_PRODUCER", passes_[p].name + " reads " + res.name +
                                                                       ", which no pass writes"});
            }
            for (PassId producer : producers[r.resource]) {
                if (producer == p) continue;
                successors[producer].push_back(p);
                ++indegree[p];
            }
        }
    }

    // Kahn's algorithm, always taking the lowest declared ready pass: a stable, deterministic order.
    std::vector<PassId> ready;
    for (PassId p = 0; p < passCount; ++p) {
        if (indegree[p] == 0) ready.push_back(p);
    }
    while (!ready.empty()) {
        const auto lowest = std::min_element(ready.begin(), ready.end());
        const PassId p = *lowest;
        ready.erase(lowest);
        out.order.push_back(p);
        for (PassId s : successors[p]) {
            if (--indegree[s] == 0) ready.push_back(s);
        }
    }
    if (out.order.size() != passCount) {
        std::string stuck;
        for (PassId p = 0; p < passCount; ++p) {
            if (indegree[p] > 0) stuck += (stuck.empty() ? "" : ", ") + passes_[p].name;
        }
        out.errors.push_back({"TN_GRAPH_CYCLE", "passes in a dependency cycle: " + stuck});
    }
    if (!out.ok()) return out;

    // Lifetimes in execution order: [first write, last read or write].
    std::vector<int32_t> first(resources_.size(), -1), last(resources_.size(), -1);
    for (size_t step = 0; step < out.order.size(); ++step) {
        const Pass& pass = passes_[out.order[step]];
        auto touch = [&](ResourceId id) {
            if (first[id] < 0) first[id] = static_cast<int32_t>(step);
            last[id] = static_cast<int32_t>(step);
        };
        for (ResourceId w : pass.writes) touch(w);
        for (const Read& r : pass.reads) touch(r.resource);
    }

    // Greedy interval allocation: a transient takes a free slot of an identical descriptor whose
    // previous tenant's lifetime ended before this one starts.
    struct Slot {
        TextureDesc desc;
        int32_t busyUntil;
    };
    std::vector<Slot> slots;
    out.physicalOf.assign(resources_.size(), -1);
    std::vector<ResourceId> byStart;
    for (ResourceId id = 0; id < resources_.size(); ++id) {
        if (!resources_[id].external && first[id] >= 0) byStart.push_back(id);
    }
    std::stable_sort(byStart.begin(), byStart.end(), [&](ResourceId a, ResourceId b) { return first[a] < first[b]; });
    for (ResourceId id : byStart) {
        int32_t chosen = -1;
        for (size_t s = 0; s < slots.size(); ++s) {
            if (slots[s].desc == resources_[id].desc && slots[s].busyUntil < first[id]) {
                chosen = static_cast<int32_t>(s);
                break;
            }
        }
        if (chosen < 0) {
            slots.push_back(Slot{resources_[id].desc, -1});
            chosen = static_cast<int32_t>(slots.size() - 1);
        }
        slots[chosen].busyUntil = last[id];
        out.physicalOf[id] = chosen;
    }
    out.physicalCount = static_cast<uint32_t>(slots.size());
    return out;
}

}  // namespace tn::engine::graph
