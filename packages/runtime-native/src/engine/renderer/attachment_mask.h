#pragma once

// Which of a pipeline's colour attachments a draw writes. `color` is target 0; each MRT target follows it.
// A transparent draw that writes its own custom MRT slot (three's transparent sea under a normal target)
// masks the named targets and still writes its slot: the two decisions are separate, and folding them into
// one mask is how a proof's attachment read back empty while every draw looked healthy.

#include <cstddef>
#include <cstdint>

namespace tn::engine {

/**
 * Whether colour target `index` is written: target 0 follows the draw's own `color` mask (a custom-only
 * draw masks it), and target `index > 0` follows the material's mask and its own `moreWrites` bit.
 */
inline bool colourTargetWritten(std::size_t index, bool colorWrite, uint8_t moreWrites, bool materialWrite) {
    if (index == 0) return colorWrite && materialWrite;
    return materialWrite && (((moreWrites >> (index - 1)) & 1u) != 0);
}

}  // namespace tn::engine
