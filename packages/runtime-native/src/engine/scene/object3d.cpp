// Object3D, Layers and EventDispatcher: three@0.185.1 src/core/Object3D.js, Layers.js and
// EventDispatcher.js, method for method. The file-scope temporaries below are three's `_v1`, `_m1`,
// `_q1`, `_target`, `_position`, `_scale` and `_quaternion`; three keeps them module-level because
// its methods never re-enter. The one place this port could re-enter is a change callback, and the
// two callbacks below use their own locals, so no temporary is shared across a re-entry.

#include "engine/scene/object3d.h"

#include <algorithm>
#include <cstring>
#include <random>
#include <mutex>

namespace tn::engine {

// Each column is contiguous; pages keep every public transform address stable through growth.
struct alignas(64) TransformPage {
    static constexpr std::size_t size = 256;
    std::array<Vector3, size> positions, scales;
    std::array<SyncedEuler, size> rotations;
    std::array<SyncedQuaternion, size> quaternions;
    std::array<Matrix4, size> matrices, worlds;
};

namespace {

struct TransformPool {
    std::mutex mutex;
    std::vector<std::unique_ptr<TransformPage>> pages;
    std::vector<std::pair<TransformPage*, std::size_t>> free;
    std::size_t live = 0;
};
// Application/VM owners can outlive this lazy singleton during static teardown. Pages are still
// reclaimed when the last object dies; only the pool bookkeeping has process lifetime.
TransformPool& transforms() { static auto* pool = new TransformPool; return *pool; }
}

Object3D::TransformSlot Object3D::acquireTransform() {
    auto& pool = transforms();
    const std::lock_guard lock(pool.mutex);
    if (pool.free.empty()) {
        auto page = std::make_unique<TransformPage>();
        for (std::size_t i = TransformPage::size; i > 0; --i) pool.free.emplace_back(page.get(), i - 1);
        pool.pages.push_back(std::move(page));
    }
    const auto [page, i] = pool.free.back();
    pool.free.pop_back();
    ++pool.live;
    // Reusing a slot resets its callbacks/accessors as well as its numeric values.
    const auto reset = [](auto& value) { std::destroy_at(&value); std::construct_at(&value); };
    reset(page->positions[i]); reset(page->rotations[i]); reset(page->quaternions[i]);
    reset(page->scales[i]); reset(page->matrices[i]); reset(page->worlds[i]);
    page->scales[i].set(1, 1, 1);
    return {page, i};
}

void Object3D::releaseTransform() {
    auto& pool = transforms();
    const std::lock_guard lock(pool.mutex);
    pool.free.emplace_back(transform_.page, transform_.index);
    if (--pool.live == 0) { pool.free.clear(); pool.pages.clear(); }
}

namespace {

// three's `_object3DId`, and the first Object3D this process builds takes 0 as three's does.
uint64_t nextObjectId = 0;
uint64_t hierarchyRevision = 0;

// three's module-level scratch values.
Vector3 scratchV1;
Quaternion scratchQ1;
Matrix4 scratchM1;
Vector3 scratchTarget;
Vector3 scratchPosition;
Vector3 scratchScale;
Quaternion scratchQuaternion;
const Vector3 axisX{1, 0, 0};
const Vector3 axisY{0, 1, 0};
const Vector3 axisZ{0, 0, 1};

// three shares one event object per type. The target is stamped per dispatch, and `child` is set
// and cleared around the parent dispatch, exactly as three does it.
Event addedEvent{"added", nullptr, nullptr};
Event removedEvent{"removed", nullptr, nullptr};
Event childAddedEvent{"childadded", nullptr, nullptr};
Event childRemovedEvent{"childremoved", nullptr, nullptr};

}  // namespace

Vector3 Object3D::defaultUp{0, 1, 0};
bool Object3D::defaultMatrixAutoUpdate = true;
bool Object3D::defaultMatrixWorldAutoUpdate = true;

// ------------------------------------------------------------------------------ EventDispatcher

void EventDispatcher::addEventListener(std::string_view type, Listener listener, void* context) {
    std::vector<Entry>& entries = listeners_[std::string(type)];
    for (const Entry& entry : entries) {
        if (entry.listener == listener && entry.context == context) return;
    }
    entries.push_back(Entry{listener, context});
}

bool EventDispatcher::hasEventListener(std::string_view type, Listener listener, void* context) const {
    const auto found = listeners_.find(type);
    if (found == listeners_.end()) return false;
    for (const Entry& entry : found->second) {
        if (entry.listener == listener && entry.context == context) return true;
    }
    return false;
}

void EventDispatcher::removeEventListener(std::string_view type, Listener listener, void* context) {
    const auto found = listeners_.find(type);
    if (found == listeners_.end()) return;
    std::vector<Entry>& entries = found->second;
    for (auto it = entries.begin(); it != entries.end(); ++it) {
        if (it->listener == listener && it->context == context) {
            entries.erase(it);
            return;
        }
    }
}

void EventDispatcher::dispatchEvent(Event& event) {
    const auto found = listeners_.find(event.type);
    if (found == listeners_.end()) return;
    // EventDispatcher is only ever Object3D's base, so this downcast is total; see the header.
    event.target = static_cast<Object3D*>(this);
    // A copy, so a listener that removes itself while the event is delivered does not shift the list.
    const std::vector<Entry> array = found->second;
    for (const Entry& entry : array) entry.listener(event, entry.context);
    event.target = nullptr;
}

// ------------------------------------------------------------------------------ Object3D

uint64_t Object3D::hierarchyVersion() { return hierarchyRevision; }

Object3D::Object3D() : transform_(acquireTransform()),
    position(transform_.page->positions[transform_.index]), rotation(transform_.page->rotations[transform_.index]),
    quaternion(transform_.page->quaternions[transform_.index]), scale(transform_.page->scales[transform_.index]),
    matrix(transform_.page->matrices[transform_.index]), matrixWorld(transform_.page->worlds[transform_.index]),
    id_(nextObjectId++) {
    // RFC 4122 version/variant bits, as three's MathUtils.generateUUID; identity lives natively.
    static thread_local std::mt19937 random(std::random_device{}());
    constexpr char hex[] = "0123456789abcdef";
    std::array<uint8_t, 16> bytes{};
    for (size_t i = 0; i < bytes.size(); i += 4) {
        const uint32_t value = random();
        for (size_t j = 0; j < 4; ++j) bytes[i + j] = static_cast<uint8_t>(value >> (8 * j));
    }
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    for (size_t i = 0; i < bytes.size(); ++i) {
        if (i == 4 || i == 6 || i == 8 || i == 10) uuid += '-';
        uuid += hex[bytes[i] >> 4]; uuid += hex[bytes[i] & 15];
    }
    up = defaultUp;
    matrixAutoUpdate = defaultMatrixAutoUpdate;
    matrixWorldAutoUpdate = defaultMatrixWorldAutoUpdate;
    rotation.onChange(&Object3D::onRotationChange, this);
    quaternion.onChange(&Object3D::onQuaternionChange, this);
}

void Object3D::onRotationChange(void* context) {
    // three's `onRotationChange`: the Euler is authoritative, so it writes the quaternion without
    // notifying back, which is what `update = false` is for.
    auto& object = *static_cast<Object3D*>(context);
    object.quaternion.setFromEuler(object.rotation, false);
}

void Object3D::onQuaternionChange(void* context) {
    auto& object = *static_cast<Object3D*>(context);
    object.rotation.setFromQuaternion(object.quaternion, object.rotation.order, false);
}

void Object3D::setVisible(bool value) {
    if (visible_ == value) return;
    visible_ = value;
    bump();
}

Object3D::FlagOffsets Object3D::flagOffsets() {
    static const Object3D probe;
    const auto at = [](const bool& flag) {
        return uint32_t(reinterpret_cast<const char*>(&flag) - reinterpret_cast<const char*>(probe.flags()));
    };
    return {at(probe.visible_), at(probe.castShadow_), at(probe.receiveShadow_)};
}

void Object3D::setCastShadow(bool value) {
    if (castShadow_ == value) return;
    castShadow_ = value;
    bump();
}

void Object3D::setReceiveShadow(bool value) {
    if (receiveShadow_ == value) return;
    receiveShadow_ = value;
    bump();
}

void Object3D::setRenderOrder(int value) {
    renderOrder_ = value;
    bump();
}

void Object3D::setLayerMask(double mask) {
    layers_.mask = mask;
    bump();
}

void Object3D::setLayer(int layer) {
    layers_.set(layer);
    bump();
}

void Object3D::enableLayer(int layer) {
    layers_.enable(layer);
    bump();
}

void Object3D::enableAllLayers() {
    layers_.enableAll();
    bump();
}

void Object3D::toggleLayer(int layer) {
    layers_.toggle(layer);
    bump();
}

void Object3D::disableLayer(int layer) {
    layers_.disable(layer);
    bump();
}

void Object3D::disableAllLayers() {
    layers_.disableAll();
    bump();
}

// ------------------------------------------------------------------------------ transforms

void Object3D::applyMatrix4(const Matrix4& m) {
    if (matrixAutoUpdate) updateMatrix();
    matrix.premultiply(m);
    matrix.decompose(position, quaternion, scale);
    bump();
}

Object3D& Object3D::applyQuaternion(const Quaternion& q) {
    quaternion.premultiply(q);
    bump();
    return *this;
}

void Object3D::setRotationFromAxisAngle(const Vector3& axis, double angle) {
    quaternion.setFromAxisAngle(axis, angle);  // assumes the axis is normalized
    bump();
}

void Object3D::setRotationFromEuler(const Euler& euler) {
    quaternion.setFromEuler(euler, true);
    bump();
}

void Object3D::setRotationFromMatrix(const Matrix4& m) {
    quaternion.setFromRotationMatrix(m);  // assumes the upper 3x3 is a pure rotation
    bump();
}

void Object3D::setRotationFromQuaternion(const Quaternion& q) {
    quaternion.copy(q);  // assumes q is normalized
    bump();
}

Object3D& Object3D::rotateOnAxis(const Vector3& axis, double angle) {
    scratchQ1.setFromAxisAngle(axis, angle);
    quaternion.multiply(scratchQ1);
    bump();
    return *this;
}

Object3D& Object3D::rotateOnWorldAxis(const Vector3& axis, double angle) {
    scratchQ1.setFromAxisAngle(axis, angle);
    quaternion.premultiply(scratchQ1);
    bump();
    return *this;
}

Object3D& Object3D::rotateX(double angle) { return rotateOnAxis(axisX, angle); }

Object3D& Object3D::rotateY(double angle) { return rotateOnAxis(axisY, angle); }

Object3D& Object3D::rotateZ(double angle) { return rotateOnAxis(axisZ, angle); }

Object3D& Object3D::translateOnAxis(const Vector3& axis, double distance) {
    scratchV1.copy(axis).applyQuaternion(quaternion);
    position.add(scratchV1.multiplyScalar(distance));
    bump();
    return *this;
}

Object3D& Object3D::translateX(double distance) { return translateOnAxis(axisX, distance); }

Object3D& Object3D::translateY(double distance) { return translateOnAxis(axisY, distance); }

Object3D& Object3D::translateZ(double distance) { return translateOnAxis(axisZ, distance); }

Vector3& Object3D::localToWorld(Vector3& vector) {
    updateWorldMatrix(true, false);
    return vector.applyMatrix4(matrixWorld);
}

Vector3& Object3D::worldToLocal(Vector3& vector) {
    updateWorldMatrix(true, false);
    return vector.applyMatrix4(scratchM1.copy(matrixWorld).invert());
}

void Object3D::lookAt(const Vector3& target) {
    // This method does not support objects having non-uniformly-scaled parent(s).
    scratchTarget.copy(target);  // three copies too, so a target that aliases a member survives
    Object3D* const parent_ = parent;
    updateWorldMatrix(true, false);
    scratchPosition.setFromMatrixPosition(matrixWorld);

    if (isCamera() || isLight()) {
        scratchM1.lookAt(scratchPosition, scratchTarget, up);
    } else {
        scratchM1.lookAt(scratchTarget, scratchPosition, up);
    }

    quaternion.setFromRotationMatrix(scratchM1);

    if (parent_ != nullptr) {
        scratchM1.extractRotation(parent_->matrixWorld);
        scratchQ1.setFromRotationMatrix(scratchM1);
        quaternion.premultiply(scratchQ1.invert());
    }
    bump();
}

void Object3D::lookAt(double x, double y, double z) {
    scratchTarget.set(x, y, z);
    lookAt(scratchTarget);
}

// ------------------------------------------------------------------------------ hierarchy

Object3D::~Object3D() {
    ++hierarchyRevision;
    for (Object3D* child : children) child->parent = nullptr;  // owned children die after this body
    if (parent != nullptr) {
        auto& siblings = parent->children;
        siblings.erase(std::remove(siblings.begin(), siblings.end(), this), siblings.end());
    }
    releaseTransform();
}

void Object3D::own(Object3D& child) {
    if (std::shared_ptr<Object3D> shared = child.weak_from_this().lock()) owned_.push_back(std::move(shared));
}

void Object3D::disown(Object3D& child) {
    const auto found = std::find_if(owned_.begin(), owned_.end(), [&](const auto& o) { return o.get() == &child; });
    if (found != owned_.end()) owned_.erase(found);
}

Object3D& Object3D::add(Object3D& object) {
    if (&object == this) return *this;  // three logs an error and returns; no exception crosses here
    // Re-parenting drops the old parent's hold: keep the object alive across it.
    const std::shared_ptr<Object3D> keep = object.weak_from_this().lock();
    object.removeFromParent();
    object.parent = this;
    children.push_back(&object);
    ++hierarchyRevision;
    own(object);
    object.dispatchEvent(addedEvent);
    childAddedEvent.child = &object;
    dispatchEvent(childAddedEvent);
    childAddedEvent.child = nullptr;
    bump();
    return *this;
}

Object3D& Object3D::add(const std::vector<Object3D*>& objects) {
    for (Object3D* object : objects) add(*object);
    return *this;
}

Object3D& Object3D::remove(Object3D& object) {
    const auto found = std::find(children.begin(), children.end(), &object);
    if (found == children.end()) return *this;
    const std::shared_ptr<Object3D> keep = object.weak_from_this().lock();  // alive until this returns
    children.erase(found);
    ++hierarchyRevision;
    disown(object);
    object.parent = nullptr;
    object.dispatchEvent(removedEvent);
    childRemovedEvent.child = &object;
    dispatchEvent(childRemovedEvent);
    childRemovedEvent.child = nullptr;
    bump();
    return *this;
}

Object3D& Object3D::remove(const std::vector<Object3D*>& objects) {
    for (Object3D* object : objects) remove(*object);
    return *this;
}

Object3D& Object3D::removeFromParent() {
    if (parent != nullptr) parent->remove(*this);
    return *this;
}

Object3D& Object3D::clear() {
    // three splices the live array out of the spread; copying first is the same order, and the copy
    // matters: remove() erases from `children` while the loop walks it.
    return remove(std::vector<Object3D*>(children));
}

Object3D& Object3D::attach(Object3D& object) {
    // Adds object as a child of this, while maintaining the object's world transform.
    updateWorldMatrix(true, false);
    scratchM1.copy(matrixWorld).invert();

    if (object.parent != nullptr) {
        object.parent->updateWorldMatrix(true, false);
        scratchM1.multiply(object.parent->matrixWorld);
    }

    object.applyMatrix4(scratchM1);
    const std::shared_ptr<Object3D> keep = object.weak_from_this().lock();
    object.removeFromParent();
    object.parent = this;
    children.push_back(&object);
    ++hierarchyRevision;
    own(object);

    object.updateWorldMatrix(false, true);

    object.dispatchEvent(addedEvent);
    childAddedEvent.child = &object;
    dispatchEvent(childAddedEvent);
    childAddedEvent.child = nullptr;
    bump();
    return *this;
}

Object3D* Object3D::getObjectById(uint64_t id) {
    if (id_ == id) return this;
    for (Object3D* child : children) {
        if (Object3D* found = child->getObjectById(id)) return found;
    }
    return nullptr;
}

Object3D* Object3D::getObjectByName(std::string_view name) { return getObjectByProperty("name", name); }

Object3D* Object3D::getObjectByProperty(std::string_view property, std::string_view value) {
    // three compares `this[property] === value`, so a property Object3D does not have matches nothing.
    if (property == "name" && name == value) return this;
    if (property == "type" && type() == value) return this;
    for (Object3D* child : children) {
        if (Object3D* found = child->getObjectByProperty(property, value)) return found;
    }
    return nullptr;
}

// ------------------------------------------------------------------------------ world queries

Vector3& Object3D::getWorldPosition(Vector3& target) {
    updateWorldMatrix(true, false);
    return target.setFromMatrixPosition(matrixWorld);
}

Quaternion& Object3D::getWorldQuaternion(Quaternion& target) {
    updateWorldMatrix(true, false);
    matrixWorld.decompose(scratchPosition, target, scratchScale);
    return target;
}

Vector3& Object3D::getWorldScale(Vector3& target) {
    updateWorldMatrix(true, false);
    matrixWorld.decompose(scratchPosition, scratchQuaternion, target);
    return target;
}

Vector3& Object3D::getWorldDirection(Vector3& target) {
    updateWorldMatrix(true, false);
    const double* e = matrixWorld.elements.data();
    return target.set(e[8], e[9], e[10]).normalize();
}

// ------------------------------------------------------------------------------ traversal

void Object3D::traverse(Visitor visitor, void* context) {
    visitor(*this, context);
    for (Object3D* child : children) child->traverse(visitor, context);
}

void Object3D::traverseVisible(Visitor visitor, void* context) {
    if (!visible_) return;
    visitor(*this, context);
    for (Object3D* child : children) child->traverseVisible(visitor, context);
}

void Object3D::traverseAncestors(Visitor visitor, void* context) {
    if (parent == nullptr) return;
    visitor(*parent, context);
    parent->traverseAncestors(visitor, context);
}

// ------------------------------------------------------------------------------ matrices

void Object3D::updateMatrix() {
    Matrix4 composed;
    composed.compose(position, quaternion, scale);

    if (pivot.has_value()) {
        const double px = pivot->x, py = pivot->y, pz = pivot->z;
        double* te = composed.elements.data();
        te[12] += px - te[0] * px - te[4] * py - te[8] * pz;
        te[13] += py - te[1] * px - te[5] * py - te[9] * pz;
        te[14] += pz - te[2] * px - te[6] * py - te[10] * pz;
    }

    matrixWorldNeedsUpdate = true;
    // three recomposes every frame for every auto-update object; only a changed matrix is a change.
    if (std::memcmp(matrix.elements.data(), composed.elements.data(), sizeof(double) * 16) != 0) bump();
    matrix.copy(composed);
}

namespace {
// memcmp(a, b, 128) != 0 without the library call: one pass of word loads that vectorizes, the same
// bitwise answer (a signed zero or a NaN payload differs, an unchanged NaN does not).
inline bool bitsDiffer(const std::array<double, 16>& a, const std::array<double, 16>& b) {
    uint64_t diff = 0;
    for (std::size_t i = 0; i < 16; ++i) {
        uint64_t x, y;
        std::memcpy(&x, &a[i], sizeof x);
        std::memcpy(&y, &b[i], sizeof y);
        diff |= x ^ y;
    }
    return diff != 0;
}
}  // namespace

bool Object3D::updateMatrixWorldSelf(bool force, bool identityParent, bool plain) {
    if (plain && identityParent && matrixAutoUpdate && matrixWorldAutoUpdate && !pivot) {
        Matrix4 composed;
        composed.compose(position, quaternion, scale);
        const bool changed = bitsDiffer(matrix.elements, composed.elements);
        matrix.copy(composed);
        if (changed) bump();
        const uint64_t parentId = parent ? parent->id() + 1 : 0;
        const uint64_t parentRevision = parent ? parent->revision() : 0;
        if (changed || matrixWorldNeedsUpdate || force || worldParentId_ != parentId || worldParentRevision_ != parentRevision) {
            if (bitsDiffer(matrixWorld.elements, composed.elements)) bump();
            matrixWorld.copy(composed);
            matrixWorldNeedsUpdate = false;
            worldParentId_ = parentId;
            worldParentRevision_ = parentRevision;
            return true;
        }
        return false;
    }
    if (matrixAutoUpdate) {
        const bool dirty = matrixWorldNeedsUpdate;
        const auto before = revision();
        if (plain) Object3D::updateMatrix();
        else updateMatrix();
        // Auto composition must not dirty an unchanged root and force every descendant.
        matrixWorldNeedsUpdate = dirty || revision() != before;
    }

    const uint64_t parentId = parent ? parent->id() + 1 : 0;
    const uint64_t parentRevision = parent ? parent->revision() : 0;
    if (matrixWorldNeedsUpdate || force || worldParentId_ != parentId || worldParentRevision_ != parentRevision) {
        if (matrixWorldAutoUpdate) {
            Matrix4 composed;
            if (parent == nullptr || identityParent) {
                composed.copy(matrix);
            } else {
                composed.multiplyMatrices(parent->matrixWorld, matrix);
            }
            // A parent's move reaches the renderer through the child's world matrix.
            if (std::memcmp(matrixWorld.elements.data(), composed.elements.data(), sizeof(double) * 16) != 0) bump();
            matrixWorld.copy(composed);
        }
        matrixWorldNeedsUpdate = false;
        worldParentId_ = parentId;
        worldParentRevision_ = parentRevision;
        force = true;
    }

    // A manually owned world matrix can change without a revision; retain its forced child update.
    if (!matrixWorldAutoUpdate) force = true;
    return force;
}

void Object3D::updateMatrixWorld(bool force) {
    force = updateMatrixWorldSelf(force);
    for (Object3D* child : children) child->updateMatrixWorld(force);
}

void Object3D::updateWorldMatrix(bool updateParents, bool updateChildren, bool force) {
    Object3D* const parent_ = parent;

    if (updateParents && parent_ != nullptr) parent_->updateWorldMatrix(true, false);

    if (matrixAutoUpdate) updateMatrix();

    if (matrixWorldNeedsUpdate || force) {
        if (matrixWorldAutoUpdate) {
            const Matrix4 before = matrixWorld;
            if (parent_ == nullptr) {
                matrixWorld.copy(matrix);
            } else {
                matrixWorld.multiplyMatrices(parent_->matrixWorld, matrix);
            }
            if (std::memcmp(before.elements.data(), matrixWorld.elements.data(), sizeof(double) * 16) != 0) bump();
        }
        matrixWorldNeedsUpdate = false;
        worldParentId_ = parent_ ? parent_->id() + 1 : 0;
        worldParentRevision_ = parent_ ? parent_->revision() : 0;
        force = true;
    }

    if (updateChildren) {
        for (Object3D* child : children) child->updateWorldMatrix(false, true, force);
    }
}

Object3D& Object3D::copy(const Object3D& source) {
    name = source.name;
    up.copy(source.up);
    position.copy(source.position);
    rotation.order = source.rotation.order;
    quaternion.copy(source.quaternion);
    scale.copy(source.scale);
    pivot = source.pivot;
    matrix.copy(source.matrix);
    matrixWorld.copy(source.matrixWorld);
    worldParentId_ = source.parent ? source.parent->id() + 1 : 0;
    worldParentRevision_ = source.parent ? source.parent->revision() : 0;
    matrixAutoUpdate = source.matrixAutoUpdate;
    matrixWorldAutoUpdate = source.matrixWorldAutoUpdate;
    matrixWorldNeedsUpdate = source.matrixWorldNeedsUpdate;
    layers_.mask = source.layers_.mask;
    visible_ = source.visible_;
    castShadow_ = source.castShadow_;
    receiveShadow_ = source.receiveShadow_;
    frustumCulled = source.frustumCulled;
    renderOrder_ = source.renderOrder_;
    bump();
    return *this;
}

}  // namespace tn::engine
