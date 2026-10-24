#pragma once

#include "engine/shader/graph/graph.h"
#include "engine/shader/position_node.h"

namespace tn::engine::shader::graph {

/** Import an upstream node DAG; unknown nodes refuse the whole graph, naming their r185 type. */
PostNode serializedPost(Node root, std::optional<ToneMapping> toneMapping = std::nullopt, bool srgb = false, Node custom = {});

Graph importSerialized(std::string_view source, std::vector<std::string>& errors);

} // namespace tn::engine::shader::graph
