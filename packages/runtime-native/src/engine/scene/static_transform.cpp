#include "engine/scene/static_transform.h"

#include <algorithm>
#include <type_traits>

namespace tn::engine {

namespace {

// Object3D::traverse with a lambda: the native traversal takes a function pointer and a context.
template <typename Fn> void each(Object3D& root, Fn&& fn) {
    using F = std::remove_reference_t<Fn>;
    root.traverse([](Object3D& object, void* context) { (*static_cast<F*>(context))(object); }, &fn);
}

} // namespace

StaticTransforms::Snapshot StaticTransforms::snapshotOf(const Object3D& root) {
    Snapshot s{};
    s[0] = root.position.x;
    s[1] = root.position.y;
    s[2] = root.position.z;
    s[3] = root.quaternion.x;
    s[4] = root.quaternion.y;
    s[5] = root.quaternion.z;
    s[6] = root.quaternion.w;
    s[7] = root.scale.x;
    s[8] = root.scale.y;
    s[9] = root.scale.z;
    for (int e = 0; e < 16; ++e)
        s[10 + e] = root.matrix.elements[e];
    return s;
}

bool StaticTransforms::erase(WeakSet& set, Object3D& object) { return set.erase(object.weak_from_this()) > 0; }

StaticTransforms::Frozen* StaticTransforms::find(const Object3D& root) {
    for (Frozen& f : frozen_)
        if (f.root.get() == &root)
            return &f;
    return nullptr;
}

uint32_t StaticTransforms::freeze(Object3D& root) {
    root.updateMatrixWorld(true);
    uint32_t objects = 0;
    each(root, [&](Object3D& object) {
        ++objects;
        if (object.matrixAutoUpdate)
            composeSilenced_.insert(object.weak_from_this());
        object.matrixAutoUpdate = false;
        object.matrixWorldNeedsUpdate = false;
    });
    if (root.matrixWorldAutoUpdate)
        worldSilenced_.insert(root.weak_from_this());
    root.matrixWorldAutoUpdate = false;
    return objects;
}

uint32_t StaticTransforms::mark(Object3D& root) {
    std::shared_ptr<Object3D> held = root.weak_from_this().lock();
    if (!held)
        return 0;
    const uint32_t objects = freeze(root);
    Frozen* existing = find(root);
    if (!existing) {
        frozen_.push_back({held, 0, {}, 0});
        existing = &frozen_.back();
    }
    existing->objects = objects;
    existing->snapshot = snapshotOf(root);
    existing->version += 1;
    return existing->version;
}

void StaticTransforms::unmark(Object3D& root) {
    const auto it =
        std::find_if(frozen_.begin(), frozen_.end(), [&](const Frozen& f) { return f.root.get() == &root; });
    if (it == frozen_.end())
        return;
    const std::shared_ptr<Object3D> held = it->root; // alive through the thaw
    frozen_.erase(it);
    if (erase(worldSilenced_, root))
        root.matrixWorldAutoUpdate = true;
    each(root, [&](Object3D& object) {
        if (erase(composeSilenced_, object))
            object.matrixAutoUpdate = true;
        object.matrixWorldNeedsUpdate = true;
    });
}

void StaticTransforms::thaw(Object3D& root) {
    each(root, [&](Object3D& child) {
        if (erase(composeSilenced_, child))
            child.matrixAutoUpdate = true;
        child.matrixWorldNeedsUpdate = true;
    });
    if (erase(worldSilenced_, root))
        root.matrixWorldAutoUpdate = true;
}

std::optional<uint32_t> StaticTransforms::invalidate(Object3D& object) {
    for (Object3D* node = &object; node != nullptr; node = node->parent) {
        if (!find(*node))
            continue;
        thaw(*node);
        return mark(*node);
    }
    return std::nullopt;
}

bool StaticTransforms::isStatic(const Object3D& root) const {
    return std::any_of(frozen_.begin(), frozen_.end(), [&](const Frozen& f) { return f.root.get() == &root; });
}

// refreshStaticTransforms re-arms by root while iterating the Map; mark() only updates an entry in
// place, so iterating by index is the same order and visits each root once.
void StaticTransforms::refresh() {
    for (std::size_t i = 0; i < frozen_.size(); ++i) {
        Object3D& root = *frozen_[i].root;
        if (snapshotOf(root) == frozen_[i].snapshot)
            continue;
        // The reference thaws the world flag before the children; the order touches disjoint flags.
        if (erase(worldSilenced_, root))
            root.matrixWorldAutoUpdate = true;
        each(root, [&](Object3D& child) {
            if (erase(composeSilenced_, child))
                child.matrixAutoUpdate = true;
            child.matrixWorldNeedsUpdate = true;
        });
        mark(root);
        ++rearmedSinceCensus_;
    }
}

StaticTransforms::Census StaticTransforms::census() {
    Census c;
    c.roots = static_cast<uint32_t>(frozen_.size());
    for (const Frozen& f : frozen_)
        c.objects += f.objects;
    c.rearmed = rearmedSinceCensus_;
    rearmedSinceCensus_ = 0;
    return c;
}

void StaticTransforms::reset() {
    frozen_.clear();
    rearmedSinceCensus_ = 0;
}

} // namespace tn::engine
