#include "check.h"
#include "engine/renderer/attachment_mask.h"
#include "engine/renderer/aux_depth.h"

// Which colour attachments a draw writes (attachment_mask.h). A frame whose post graph reads the normal
// target and whose sea names a custom MRT slot holds two: the sea masks the named target and must still
// write its own slot. Masking both with one flag left the slot cleared to zero every frame, and the water
// proof's readback measured an empty attachment on a sea that filled the screen.

namespace {

using tn::engine::auxDepthLessEqual;
using tn::engine::colourTargetWritten;

void materialMaskAppliesToEveryTarget() {
    // An ordinary draw writes every attachment it holds.
    for (std::size_t index = 0; index < 4; ++index) CHECK(colourTargetWritten(index, true, 0xff, true));
    // A material that masks its colour writes none of them.
    for (std::size_t index = 0; index < 4; ++index) CHECK(!colourTargetWritten(index, true, 0xff, false));
}

void customOnlyDrawWritesItsOwnSlot() {
    // The sea: `color` masked (the named normal target keeps the opaque surface's value), its slot written.
    CHECK(!colourTargetWritten(0, false, 0xff, true));
    CHECK(colourTargetWritten(1, false, 0xff, true));
    // Bit i of moreWrites decides target i+1.
    CHECK(!colourTargetWritten(1, false, 0xfe, true));   // bit 0 clear
    CHECK(colourTargetWritten(2, false, 0xfe, true));    // bit 1 set
    CHECK(colourTargetWritten(3, false, 0xfe, true));    // bit 2 set
    CHECK(!colourTargetWritten(9, false, 0xfe, true));   // past the eight bits: not written
    // Two named targets then a slot: bits 0 and 1 cleared, the slot at index 3 written.
    CHECK(!colourTargetWritten(1, false, 0xfcu, true));
    CHECK(!colourTargetWritten(2, false, 0xfcu, true));
    CHECK(colourTargetWritten(3, false, 0xfcu, true));
}

// The aux pass's depth test (aux_depth.h). The water proof's sea is transparent and names a custom MRT slot: it
// wrote no depth in the colour pass, so the pass reads against the opaque surface behind it. Equal there dropped
// the slot at 1x — the sea's own fragment is nearer, never equal — while the 4x pass, which tests LessEqual
// already, wrote it. Only a draw that wrote that depth is tested for equality; every draw at 4x tests LessEqual.
void aDrawThatWroteNoDepthIsNotTestedForEquality() {
    CHECK(!auxDepthLessEqual(true, 1));   // an opaque draw wrote the depth it reads
    CHECK(auxDepthLessEqual(false, 1));   // the sea's slot: nearer than the surface behind it
    CHECK(auxDepthLessEqual(true, 4));    // 4x reads a sample position, biased, whatever the draw wrote
    CHECK(auxDepthLessEqual(false, 4));
}

}  // namespace

TN_TEST_MAIN({"material_mask", materialMaskAppliesToEveryTarget}, {"custom_slot", customOnlyDrawWritesItsOwnSlot},
             {"depth_test", aDrawThatWroteNoDepthIsNotTestedForEquality})
