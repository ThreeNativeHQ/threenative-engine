// stb_image decodes SMAANode's two embedded PNG tables; third-party C, kept in its own unit.
#include "engine/shader/graph/smaa_tables.h"

#include <stdexcept>

#define STB_IMAGE_IMPLEMENTATION
#define STB_IMAGE_STATIC
#define STBI_NO_STDIO
#define STBI_ONLY_PNG
#include "stb_image.h"
#include "smaa_tables.inc"

namespace tn::engine::shader::graph {
std::vector<uint8_t> smaaTable(bool area, uint32_t& width, uint32_t& height) {
    const unsigned char* png = area ? kSmaaAreaPng : kSmaaSearchPng;
    const int size = area ? int(sizeof kSmaaAreaPng) : int(sizeof kSmaaSearchPng);
    int w = 0, h = 0, channels = 0;
    stbi_uc* pixels = stbi_load_from_memory(png, size, &w, &h, &channels, 4);
    if (!pixels) throw std::runtime_error("TN_POST_SMAA_TABLE: cannot decode the embedded table");
    std::vector<uint8_t> rgba(pixels, pixels + size_t(w) * h * 4);
    stbi_image_free(pixels);
    width = uint32_t(w);
    height = uint32_t(h);
    return rgba;
}
}  // namespace tn::engine::shader::graph
