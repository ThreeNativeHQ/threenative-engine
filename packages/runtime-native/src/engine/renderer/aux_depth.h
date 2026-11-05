#pragma once

// The aux pass's depth test for one draw (Renderer::renderPrepared's planAux). The pass draws single-sampled
// against the colour pass's resolved depth, which it only reads, so Equal names the draws that wrote that depth.
// A draw with depthWrite off never wrote it: its fragment sits nearer the camera, over whatever opaque surface
// is behind it, and Equal compared against that surface instead. The pass then dropped the draw's custom MRT
// slot at 1x while the 4x path, which tests LessEqual already, wrote it.

#include <cstdint>

namespace tn::engine {

/**
 * Whether the aux pass tests LessEqual for this draw. At 4x the pass samples the colour pass's depth at a sample
 * position while it interpolates at the pixel centre, so every draw tests LessEqual with a bias pulling it
 * nearer by that slope. At 1x a draw that wrote its own depth tests Equal; one that wrote none (three's
 * transparent or depthWrite=false material) has to read as nearer than the surface behind it, so LessEqual.
 */
inline bool auxDepthLessEqual(bool depthWrite, uint32_t sampleCount) {
    return sampleCount == 4 || !depthWrite;
}

}  // namespace tn::engine
