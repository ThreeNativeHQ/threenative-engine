#include "check.h"
#include "engine/renderer/aux_bundle_key.h"

// The aux pass's bundle key (aux_bundle_key.h). The water proof's sea names a custom MRT slot, so the pass
// holds one colour target more than the frame before did. Frames during a presentation the host holds draw
// nothing into the pass and add no rows, so the key's own words are all that mark the new layout. Without
// the slot count the engine replayed a one-target bundle into the two-target pass, WebGPU refused it, and
// TN_WASM_RENDERER_LOST stopped the renderer for the rest of the run.

namespace {

using tn::engine::appendAuxBundleKey;

std::vector<uint64_t> keyOf(uint8_t auxMask, std::size_t customSlots) {
    std::vector<uint64_t> key;
    appendAuxBundleKey(key, auxMask, customSlots);
    return key;
}

void aWiderPassTakesADifferentKey() {
    // One named target, one custom slot more: the pass holds two colour targets, not one.
    CHECK(keyOf(0x1, 0) != keyOf(0x1, 1));
    // The sea's slot on its own is a pass of one target, and it differs from a pass of two.
    CHECK(keyOf(0x0, 1) != keyOf(0x1, 1));
}

void theSameLayoutTakesTheSameKey() {
    CHECK(keyOf(0x1, 1) == keyOf(0x1, 1));
    // The named targets alone still split the key.
    CHECK(keyOf(0x0, 2) != keyOf(0x1, 2));
    // A second custom slot is another target.
    CHECK(keyOf(0x0, 1) != keyOf(0x0, 2));
}

}  // namespace

TN_TEST_MAIN({"wider_pass", aWiderPassTakesADifferentKey}, {"same_layout", theSameLayoutTakesTheSameKey})
