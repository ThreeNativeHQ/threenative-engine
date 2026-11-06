#pragma once

// The words a frame adds to the aux pass's render-bundle key. The pass holds one colour target per named
// post target the frame's graph reads, then one per custom MRT slot a material names. A bundle records the
// target count it was built for, and WebGPU refuses a bundle whose state differs from the pass it executes
// in. A frame that draws nothing into the pass adds no rows to the key (every draw waits for its pipeline,
// as a presentation the host holds does): the pass's own words are then what tells two layouts apart.

#include <cstddef>
#include <cstdint>
#include <vector>

namespace tn::engine {

/** how many words `appendAuxBundleKey` appends: the named-target mask and the custom-slot count. The
 *  retained-rows boundary (`Renderer::renderPrepared`'s `keyTail`) reads this count, so a word added
 *  here cannot silently shift the last draw's row span. */
inline constexpr std::size_t kAuxBundleKeyWords = 2;

/** Appends the aux pass key's own words: the named targets it holds, and the custom MRT slots it adds. */
inline void appendAuxBundleKey(std::vector<uint64_t>& key, uint8_t auxMask, std::size_t customSlots) {
    key.push_back(auxMask);
    key.push_back(static_cast<uint64_t>(customSlots));
}

}  // namespace tn::engine
