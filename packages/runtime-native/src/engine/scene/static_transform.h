#pragma once

#include <cstdint>
#include <memory>
#include <optional>
#include <set>
#include <vector>

#include "engine/scene/object3d.h"

namespace tn::engine {

/**
 * Authored static subtrees (PRD-519), ported from packages/core/src/static-transform.ts: a frozen
 * subtree stops composing its local matrices and its root stops recomposing its world matrix, while
 * the walk still visits it, as three's updateMatrixWorld does. Staticness is authored, never guessed:
 * `refresh` re-arms a root whose own transform the game moved, and a write deeper inside is the
 * author's to announce with `invalidate`. Public matrix semantics are three's, flag for flag.
 *
 * A frozen root is held, as the reference's Map holds it, until `unmark` or `reset`; the objects
 * whose flags the freeze silenced are held weakly, as its WeakSets are. Only shared-owned objects
 * can be marked (one an object nothing owns can't be kept alive, so `mark` answers 0 for it).
 */
class StaticTransforms {
  public:
    struct Census {
        uint32_t roots = 0;   // subtrees frozen
        uint32_t objects = 0; // objects inside them
        uint32_t rearmed = 0; // roots refresh re-armed since the last census
    };

    /** markStatic: freezes the subtree in place; returns the version it is now at (0: not shared-owned). */
    uint32_t mark(Object3D& root);
    /** unmarkStatic: every object composes again from the next walk. */
    void unmark(Object3D& root);
    /** invalidateStatic: the frozen root owning `object` recomposes once and refreezes. */
    std::optional<uint32_t> invalidate(Object3D& object);
    [[nodiscard]] bool isStatic(const Object3D& root) const;
    /** refreshStaticTransforms: re-arms each root whose authored transform moved; call before the walk. */
    void refresh();
    /** staticTransformCensus: what is frozen, and the re-arm counter it resets. */
    Census census();
    /** resetStaticTransforms: drops every registration. */
    void reset();

  private:
    static constexpr int kSnapshotLength = 3 + 4 + 3 + 16;
    using Snapshot = std::array<double, kSnapshotLength>;
    struct Frozen {
        std::shared_ptr<Object3D> root;
        uint32_t objects = 0;
        Snapshot snapshot{};
        uint32_t version = 0;
    };
    using WeakSet = std::set<std::weak_ptr<Object3D>, std::owner_less<std::weak_ptr<Object3D>>>;

    static Snapshot snapshotOf(const Object3D& root);
    uint32_t freeze(Object3D& root);
    void thaw(Object3D& root); // the shared re-arm: silenced flags back on, world matrices dirty
    Frozen* find(const Object3D& root);
    static bool erase(WeakSet& set, Object3D& object);

    std::vector<Frozen> frozen_; // insertion order, the census's order
    WeakSet composeSilenced_, worldSilenced_;
    uint32_t rearmedSinceCensus_ = 0;
};

} // namespace tn::engine
