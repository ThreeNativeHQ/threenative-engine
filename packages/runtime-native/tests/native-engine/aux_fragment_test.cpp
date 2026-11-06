#include "check.h"
#include "engine/renderer/aux_fragment.h"

// The aux pass's fragment choice (aux_fragment.h): the small normal-only fragment writes one colour output, so the
// pass must hold one colour target. A frame whose MRT names a custom slot holds a second one, and a pipeline that
// skipped it is refused by WebGPU at creation: "Color target has no corresponding fragment stage output". The water
// proof's diagnostic slot is exactly that frame.

namespace {

using tn::engine::smallNormalFragmentFits;

void normalOnlyWithoutSlots() {
    CHECK(smallNormalFragmentFits(true, false));
    // A frame with any named target besides normal already takes the merged fragment.
    CHECK(!smallNormalFragmentFits(false, false));
}

void refusedWithACustomSlot() {
    // The frame the water proof draws: the normal target and a diagnostic slot.
    CHECK(!smallNormalFragmentFits(true, true));
    CHECK(!smallNormalFragmentFits(false, true));
}

}  // namespace

TN_TEST_MAIN({"fits_without_slots", normalOnlyWithoutSlots}, {"refused_with_a_slot", refusedWithACustomSlot})
