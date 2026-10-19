#include "check.h"
#include "engine/foundation/handles.h"

using tn::engine::Handle;
using tn::engine::HandleError;
using tn::engine::HandleTable;

namespace {

void generation() {
    HandleTable table(1);
    const Handle first = table.allocate(7);
    CHECK(table.check(first, 7) == HandleError::None);
    CHECK(table.release(first) == HandleError::None);
    CHECK(table.check(first) == HandleError::Stale);
    CHECK(table.check(first.type, first.context, first.index, first.generation) == HandleError::Stale);  // the scalar form the ABI resolves with
    CHECK(table.release(first) == HandleError::Stale);

    // The slot is reused for a new object, and the old handle still does not reach it.
    const Handle second = table.allocate(7);
    CHECK(second.index == first.index);
    CHECK(second.generation != first.generation);
    CHECK(table.check(second, 7) == HandleError::None);
    CHECK(table.check(second.type, second.context, second.index, second.generation, 7) == HandleError::None);
    CHECK(table.check(first, 7) == HandleError::Stale);
    CHECK(table.liveCount() == 1);

    CHECK(table.check(Handle{}) == HandleError::Invalid);
    CHECK(table.allocate(0).type == 0);
    CHECK(table.check(Handle{7, 1, 99, 1}) == HandleError::Invalid);
}

void identity() {
    HandleTable scene(1);
    HandleTable other(2);
    const Handle mesh = scene.allocate(3);
    const Handle foreign = other.allocate(3);
    CHECK(scene.check(foreign) == HandleError::Context);
    CHECK(other.check(mesh) == HandleError::Context);
    CHECK(scene.check(mesh, 4) == HandleError::Type);

    // A caller cannot relabel a handle into another type: the slot's type is the truth.
    Handle forged = mesh;
    forged.type = 4;
    CHECK(scene.check(forged) == HandleError::Type);
    CHECK(scene.check(forged, 4) == HandleError::Type);
    CHECK(scene.release(forged) == HandleError::Type);
    CHECK(scene.check(mesh, 3) == HandleError::None);
}

}  // namespace

TN_TEST_MAIN({"generation", generation}, {"identity", identity})
