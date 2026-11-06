#pragma once

// How many colour targets the aux pass may hold (Renderer::renderPrepared's planAux). The pass writes one
// attachment per post target the frame's graph reads, then one per custom MRT slot a material names, and no
// `color` of its own: every one of them is a declared target of each of its pipelines. WebGPU guarantees a
// pipeline eight colour targets and no more, and a ninth is refused at creation.

#include <cstddef>

namespace tn::engine {

/** The device's guaranteed colour attachments: `color` and the seven that follow it (pipeline_cache.h). */
inline constexpr std::size_t kMaxColourTargets = 8;

/**
 * Whether an aux pass holding `namedTargets` post targets and `customSlots` MRT slots fits the device. The pass
 * writes no `color`, so its own attachments are exactly these, up to the device's eighth.
 */
inline bool auxTargetsFit(std::size_t namedTargets, std::size_t customSlots) {
    return namedTargets + customSlots <= kMaxColourTargets;
}

}  // namespace tn::engine
