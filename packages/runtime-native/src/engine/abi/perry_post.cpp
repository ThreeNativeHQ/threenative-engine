// Perry uses the same context-owned TSL graph as the Wasm host's tnw_web_set_post.
#include "engine/abi/abi_internal.h"

namespace {
tn::engine::shader::graph::Node pending;
}

namespace tn::abi {
const engine::shader::graph::Node& perryPostGraph() { return pending; }
}

extern "C" int64_t js_tnp_set_post(int64_t context, int64_t node) {
    tn::engine::shader::graph::Node graph;
    if (node) {
        graph = tn::abi::tslNode(reinterpret_cast<tn_context_t*>(context),
                                *reinterpret_cast<const uint64_t*>(node));
        if (!graph) return reinterpret_cast<int64_t>("TN_PERRY_POST: not a TSL node of this context");
    }
    if (graph != pending) pending = std::move(graph);
    return 0;
}
