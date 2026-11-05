#include "check.h"
#include "engine/renderer/aux_targets.h"

// How many colour targets the aux pass may hold (aux_targets.h). The pass writes one attachment per post target
// the frame's graph reads, then one per custom MRT slot, and no `color` of its own. WebGPU guarantees eight colour
// attachments, so a pass of eight fits and a pass of nine does not. A frame that reads the normal target beside
// seven custom slots is that eighth attachment, and the engine refused it as a pass of nine.

namespace {

using tn::engine::auxTargetsFit;

void eightFit() {
    CHECK(auxTargetsFit(0, 8));  // eight custom slots, no named target
    CHECK(auxTargetsFit(1, 7));  // the normal target and seven slots: what one PassNode names beside `output`
    CHECK(auxTargetsFit(4, 4));  // every named target and four slots
    CHECK(auxTargetsFit(1, 0));
}

void nineAreRefused() {
    CHECK(!auxTargetsFit(0, 9));
    CHECK(!auxTargetsFit(1, 8));
    CHECK(!auxTargetsFit(4, 5));
}

}  // namespace

TN_TEST_MAIN({"eight_fit", eightFit}, {"nine_are_refused", nineAreRefused})
