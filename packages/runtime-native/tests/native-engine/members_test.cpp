#include "check.h"
#include "engine/foundation/members.h"

#include <memory>
#include <vector>

using namespace tn::engine;

namespace {

enum : uint16_t { kMesh = 1, kVector3 = 2 };
enum : uint16_t { kPosition = 0, kScale = 1 };

struct Vec {
    double x = 0, y = 0, z = 0;
};
struct MeshRecord {
    Vec position, scale{1, 1, 1};
};

// The owner side the ABI would have: records by handle index, resolved on every access.
struct Store {
    HandleTable handles{1};
    MemberAliases aliases{handles};
    std::vector<std::unique_ptr<MeshRecord>> records;
    Handle create() {
        const Handle h = handles.allocate(kMesh);
        if (records.size() <= h.index) records.resize(h.index + 1);
        records[h.index] = std::make_unique<MeshRecord>();
        return h;
    }
    void release(Handle h) {
        aliases.releaseOwner(h);
        records[h.index].reset();
        handles.release(h);
    }
    Vec* member(Handle alias) {
        MemberAliases::Target t;
        if (!aliases.resolve(alias, t)) return nullptr;
        MeshRecord& r = *records[t.owner.index];
        return t.member == kPosition ? &r.position : &r.scale;
    }
};

bool same(Handle a, Handle b) { return a.index == b.index && a.generation == b.generation && a.type == b.type; }

void identity() {
    Store s;
    const Handle mesh = s.create();
    const Handle a = s.aliases.alias(mesh, kPosition, kVector3);
    const Handle b = s.aliases.alias(mesh, kPosition, kVector3);
    CHECK(same(a, b));                                      // mesh.position === mesh.position
    CHECK(!same(a, s.aliases.alias(mesh, kScale, kVector3)));
    s.member(a)->x = 4.5;                                   // a write through one alias ...
    CHECK(s.member(b)->x == 4.5);                           // ... is read through the other
    CHECK(s.records[mesh.index]->position.x == 4.5);        // and is the owner's own field

    // A released owner's aliases die with it; a reused slot gets fresh aliases.
    s.release(mesh);
    CHECK(s.member(a) == nullptr);
    CHECK(s.handles.check(a) != HandleError::None);         // the alias handle itself is released
    CHECK(s.aliases.size() == 0);                           // nothing leaks per released owner
    const Handle again = s.create();
    CHECK(again.index == mesh.index);
    const Handle fresh = s.aliases.alias(again, kPosition, kVector3);
    CHECK(!same(fresh, a));
    CHECK(s.member(fresh)->x == 0);
}

void growth() {
    Store s;
    const Handle mesh = s.create();
    const Handle position = s.aliases.alias(mesh, kPosition, kVector3);
    s.member(position)->y = 7;
    for (int i = 0; i < 100000; ++i) {
        const Handle other = s.create();
        s.aliases.alias(other, kPosition, kVector3);       // the alias table grows too
    }
    CHECK(s.records.size() > 100000);
    CHECK(same(s.aliases.alias(mesh, kPosition, kVector3), position));
    CHECK(s.member(position) == &s.records[mesh.index]->position);   // still its own object
    CHECK(s.member(position)->y == 7);
}

}  // namespace

TN_TEST_MAIN({"identity", identity}, {"growth", growth})
