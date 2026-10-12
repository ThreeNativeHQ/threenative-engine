#pragma once

#include <cstdint>
#include <vector>

namespace tn::engine::shader::graph {
/** SMAANode r185's area (true) or search (false) lookup table, decoded to RGBA8 from its embedded PNG. */
std::vector<uint8_t> smaaTable(bool area, uint32_t& width, uint32_t& height);
}  // namespace tn::engine::shader::graph
