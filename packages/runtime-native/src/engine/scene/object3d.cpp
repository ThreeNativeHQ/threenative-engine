// Object3D, Layers and EventDispatcher: three@0.185.1 src/core/Object3D.js, Layers.js and
// EventDispatcher.js, method for method. The file-scope temporaries below are three's `_v1`, `_m1`,
// `_q1`, `_target`, `_position`, `_scale` and `_quaternion`; three keeps them module-level because
// its methods never re-enter. The one place this port could re-enter is a change callback, and the
// two callbacks below use their own locals, so no temporary is shared across a re-entry.

#include "engine/scene/object3d.h"
#include "engine/foundation/flags.h"

#include "engine/foundation/job_pool.h"
#include "engine/foundation/waste_counters.h"
#include "engine/foundation/uuid.h"

#include <algorithm>
#include <atomic>
#include <cstring>
#include <cstdlib>
#include <random>
#include <mutex>

namespace tn::engine {

thread_local bool Object3D::poseObservationEnabled = [] {
    const auto* flag = flags::read<flags::AnimationPoseObservation>();
    return flag && std::strcmp(flag, "1") == 0;
}();

// Each column is contiguous; pages keep every public transform address stable through growth.
struct alignas(64) TransformPage {
    static constexpr std::size_t size = 256;
    std::array<Vector3, size> positions, scales;
    std::array<SyncedEuler, size> rotations;
    std::array<SyncedQuaternion, size> quaternions;
    std::array<Matrix4, size> matrices, worlds;
    // Leases on a slot: a live language view of any of its columns. A slot whose object died while
    // leased is a zombie (still counted live) until the last lease is returned.
    std::array<Object3D*, size> owners{};
    std::array<uint16_t, size> leases{};
    std::array<bool, size> zombie{};
    std::array<std::array<uint8_t, 3>, size> tracking{};
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

namespace {
// Gives a slot back to the free list; the last one out frees the pages. Needs pool.mutex.
void recycleLocked(TransformPool& pool, TransformPage* page, std::size_t index) {
    pool.free.emplace_back(page, index);
    if (--pool.live == 0) { pool.free.clear(); pool.pages.clear(); }
}

struct Column { uint32_t offset, stride; };
std::array<Column, 6> columns() { const auto l = Object3D::transformLayout(); return {{
    {l.positions, l.vectorStride}, {l.scales, l.vectorStride}, {l.rotations, l.eulerStride},
    {l.quaternions, l.quaternionStride}, {l.matrices, l.matrixStride}, {l.worlds, l.matrixStride}}}; }

// The page slot and column whose storage holds `address`, or a null page. Needs pool.mutex.
struct Found { TransformPage* page = nullptr; std::size_t index = 0; int column = -1; };
Found findLocked(TransformPool& pool, const void* address) {
    const auto at = static_cast<const char*>(address);
    static const auto layout = columns();
    for (const auto& page : pool.pages) {
        const auto base = reinterpret_cast<const char*>(page.get());
        if (at < base || at >= base + sizeof(TransformPage)) continue;
        const auto offset = static_cast<uint32_t>(at - base);
        for (int c = 0; c < 6; ++c) {
            const auto [start, stride] = layout[c];
            if (offset >= start && offset < start + stride * TransformPage::size) return {page.get(), (offset - start) / stride, c};
        }
    }
    return {};
}
}  // namespace

Object3D::TransformLayout Object3D::transformLayout() {
    static const TransformLayout layout = [] {
        const auto page = std::make_unique<TransformPage>();
        const auto at = [&](const void* column) {
            return static_cast<uint32_t>(reinterpret_cast<const char*>(column) - reinterpret_cast<const char*>(page.get()));
        };
        return TransformLayout{static_cast<uint32_t>(sizeof(TransformPage)), static_cast<uint32_t>(TransformPage::size),
            at(&page->positions), at(&page->scales), at(&page->rotations), at(&page->quaternions), at(&page->matrices),
            at(&page->worlds), static_cast<uint32_t>(sizeof(Vector3)), static_cast<uint32_t>(sizeof(SyncedEuler)),
            static_cast<uint32_t>(sizeof(SyncedQuaternion)), static_cast<uint32_t>(sizeof(Matrix4))};
    }();
    return layout;
}

void Object3D::enableTrackedTransform() {
    auto& flags = transform_.page->tracking[transform_.index];
    if (!flags[0]) flags = {1, 1, 0};
}

uint8_t* Object3D::ownTransformTracking() const { return transform_.page->tracking[transform_.index].data(); }

void Object3D::markLocalTransformDirty() { waste::debugAdd(waste::counters().sceneDirtyMarks); waste::meterAdd(waste::counters().dirtyTransforms); transform_.page->tracking[transform_.index][1] = 1; localTransformWritten(); }

uint8_t* Object3D::transformTrackingAddress(const void* address) {
    auto& pool = transforms();
    const std::lock_guard lock(pool.mutex);
    const Found found = findLocked(pool, address);
    return found.page ? found.page->tracking[found.index].data() : nullptr;
}

void Object3D::joinDeferredWorldTransform() {
    bool publication = false, stale = false;
    for (Object3D* node = this; node; node = node->parent) {
        ++joinDependencyVisits_;
        publication = publication || node->hasDeferredTransformPublication();
        const uint64_t parentId = node->parent ? node->parent->id() + 1 : 0;
        const uint64_t parentRevision = node->parent ? node->parent->revision() : 0;
        stale = stale || node->matrixWorldNeedsUpdate || node->worldParentId_ != parentId ||
                node->worldParentRevision_ != parentRevision;
    }
    if (publication && stale) updateWorldMatrix(true, false);
}

void Object3D::prepareTransformView(const void* address) {
    Object3D* owner = nullptr;
    int column = -1;
    {
        auto& pool = transforms();
        const std::lock_guard lock(pool.mutex);
        const Found found = findLocked(pool, address);
        if (found.page) { owner = found.page->owners[found.index]; column = found.column; }
    }
    if (!owner) return;
    if (column == 5) owner->joinDeferredWorldTransform();
    owner->exposeLocalTransform();
}

int Object3D::leaseTransform(const void* address) {
    auto& pool = transforms();
    const std::lock_guard lock(pool.mutex);
    const Found found = findLocked(pool, address);
    if (found.page == nullptr) return -1;
    ++found.page->leases[found.index];
    if (found.column >= 4) found.page->tracking[found.index][2] = 1;
    return found.column;
}

const void* Object3D::transformColumnAddress(const void* address, int column) {
    if (column < 0 || column > 5) return nullptr;
    auto& pool = transforms();
    const std::lock_guard lock(pool.mutex);
    const Found found = findLocked(pool, address);
    if (found.page == nullptr) return nullptr;
    const auto [start, stride] = columns()[column];
    return reinterpret_cast<const char*>(found.page) + start + stride * found.index;
}

void Object3D::unleaseTransform(const void* address) {
    auto& pool = transforms();
    const std::lock_guard lock(pool.mutex);
    const Found found = findLocked(pool, address);
    if (found.page == nullptr || found.page->leases[found.index] == 0) return;
    if (--found.page->leases[found.index] == 0 && found.page->zombie[found.index]) {
        found.page->zombie[found.index] = false;
        recycleLocked(pool, found.page, found.index);
    }
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
    page->tracking[i] = {0, 1, 1};
    return {page, i};
}

void Object3D::releaseTransform() {
    auto& pool = transforms();
    const std::lock_guard lock(pool.mutex);
    transform_.page->owners[transform_.index] = nullptr;
    // A language view still reads this slot: it stays out of reuse (and the pages stay) until unleased.
    if (transform_.page->leases[transform_.index] > 0) { transform_.page->zombie[transform_.index] = true; return; }
    recycleLocked(pool, transform_.page, transform_.index);
}

namespace {

// three's `_object3DId`, and the first Object3D this process builds takes 0 as three's does.
// Atomic: the web host builds models on its glTF loader thread while the main thread builds too (PRD-860).
std::atomic<uint64_t> nextObjectId{0};
// Atomic for the same reason: a lost increment would hide a main-thread hierarchy change. The facade
// reads it as a plain u64 at hierarchyVersionAddress(), which a lock-free atomic lays out the same.
std::atomic<uint64_t> hierarchyRevision{0};
// Starts at 1 so `gpuJointSkinnedEpoch == 0` stays reserved for direct legacy callers in tests.
std::atomic<uint64_t> skinnedHierarchyRevision{1};
static_assert(std::atomic<uint64_t>::is_always_lock_free && sizeof(std::atomic<uint64_t>) == sizeof(uint64_t));

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
    event.target = this;
    // A copy, so a listener that removes itself while the event is delivered does not shift the list.
    const std::vector<Entry> array = found->second;
    for (const Entry& entry : array) entry.listener(event, entry.context);
    event.target = nullptr;
}

// ------------------------------------------------------------------------------ Object3D

uint64_t Object3D::hierarchyVersion() { return hierarchyRevision.load(std::memory_order_relaxed); }
uint64_t Object3D::skinnedHierarchyVersion() { return skinnedHierarchyRevision.load(std::memory_order_relaxed); }
void Object3D::markSkinnedHierarchy() { skinnedHierarchyRevision.fetch_add(1, std::memory_order_relaxed); }
void Object3D::adjustSkinnedSubtree(int32_t delta) {
    for (Object3D* node = this; node != nullptr; node = node->parent) {
        node->skinnedSubtreeCount_ = uint32_t(int64_t(node->skinnedSubtreeCount_) + delta);
    }
}
void Object3D::markSkinnedNode() {
    if (isSkinnedNode_) return;
    isSkinnedNode_ = true;
    adjustSkinnedSubtree(1);
    if (parent != nullptr) {
        ++parent->directSkinnedChildren_;
        markSkinnedHierarchy();
    }
}
void Object3D::markBoneNode() {
    if (isBoneNode_) return;
    isBoneNode_ = true;
    adjustSkinnedSubtree(1);
    if (parent != nullptr) markSkinnedHierarchy();
}
void Object3D::markHierarchy(Object3D* node) {
    const uint64_t revision = hierarchyRevision.fetch_add(1, std::memory_order_relaxed) + 1;
    for (; node != nullptr; node = node->parent) node->subtreeVersion_ = revision;
}
const uint64_t* Object3D::hierarchyVersionAddress() { return reinterpret_cast<const uint64_t*>(&hierarchyRevision); }

Object3D::Object3D() : transform_(acquireTransform()),
    position(transform_.page->positions[transform_.index]), rotation(transform_.page->rotations[transform_.index]),
    quaternion(transform_.page->quaternions[transform_.index]), scale(transform_.page->scales[transform_.index]),
    matrix(transform_.page->matrices[transform_.index]), matrixWorld(transform_.page->worlds[transform_.index]),
    id_(nextObjectId++) {
    transform_.page->owners[transform_.index] = this;
    uuid = generateUuid();
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
    object.markLocalTransformDirty();
    object.quaternion.setFromEuler(object.rotation, false);
}

void Object3D::onQuaternionChange(void* context) {
    auto& object = *static_cast<Object3D*>(context);
    object.markLocalTransformDirty();
    object.rotation.setFromQuaternion(object.quaternion, object.rotation.order, false);
}

void Object3D::setVisible(bool value) {
    if (visible_ == value) return;
    visible_ = value;
    bump();
}

void Object3D::setBatchHidden(bool value) {
    if (batchHidden_ == value) return;
    batchHidden_ = value;
    bump();
}

Object3D::FlagOffsets Object3D::flagOffsets() {
    static const Object3D probe;
    const auto at = [](const bool& flag) {
        return uint32_t(reinterpret_cast<const char*>(&flag) - reinterpret_cast<const char*>(probe.flags()));
    };
    return {at(probe.visible_), at(probe.castShadow_), at(probe.receiveShadow_),
            at(probe.matrixWorldNeedsUpdate)};
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
    prepareLocalTransformWrite();
    markLocalTransformDirty();
    if (matrixAutoUpdate) updateMatrix();
    matrix.premultiply(m);
    matrix.decompose(position, quaternion, scale);
    bump();
}

Object3D& Object3D::applyQuaternion(const Quaternion& q) {
    prepareLocalTransformWrite();
    quaternion.premultiply(q);
    bump();
    return *this;
}

void Object3D::setRotationFromAxisAngle(const Vector3& axis, double angle) {
    prepareLocalTransformWrite();
    quaternion.setFromAxisAngle(axis, angle);  // assumes the axis is normalized
    bump();
}

void Object3D::setRotationFromEuler(const Euler& euler) {
    prepareLocalTransformWrite();
    quaternion.setFromEuler(euler, true);
    bump();
}

void Object3D::setRotationFromMatrix(const Matrix4& m) {
    prepareLocalTransformWrite();
    quaternion.setFromRotationMatrix(m);  // assumes the upper 3x3 is a pure rotation
    bump();
}

void Object3D::setRotationFromQuaternion(const Quaternion& q) {
    prepareLocalTransformWrite();
    quaternion.copy(q);  // assumes q is normalized
    bump();
}

Object3D& Object3D::rotateOnAxis(const Vector3& axis, double angle) {
    prepareLocalTransformWrite();
    scratchQ1.setFromAxisAngle(axis, angle);
    quaternion.multiply(scratchQ1);
    bump();
    return *this;
}

Object3D& Object3D::rotateOnWorldAxis(const Vector3& axis, double angle) {
    prepareLocalTransformWrite();
    scratchQ1.setFromAxisAngle(axis, angle);
    quaternion.premultiply(scratchQ1);
    bump();
    return *this;
}

Object3D& Object3D::rotateX(double angle) { return rotateOnAxis(axisX, angle); }

Object3D& Object3D::rotateY(double angle) { return rotateOnAxis(axisY, angle); }

Object3D& Object3D::rotateZ(double angle) { return rotateOnAxis(axisZ, angle); }

Object3D& Object3D::translateOnAxis(const Vector3& axis, double distance) {
    prepareLocalTransformWrite();
    markLocalTransformDirty();
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
    prepareLocalTransformWrite();
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

void Object3D::billboardFace(Object3D& camera, int lockAxis) {
    constexpr double kEpsilon = 1e-12;
    prepareLocalTransformWrite();
    Object3D* const parent_ = parent;
    updateWorldMatrix(true, false);  // ancestors included, so parent_->matrixWorld below is current
    camera.updateWorldMatrix(true, false);

    Vector3 objectPosition, cameraPosition, direction;
    Quaternion cameraQuaternion, objectQuaternion, parentQuaternion;
    objectPosition.setFromMatrixPosition(matrixWorld);
    // A perspective billboard aims at the camera's position; only an orthographic one, or a camera sitting
    // on the billboard, needs its rotation, so the decompose waits for the read that needs it.
    bool cameraRotationRead = false;
    auto cameraOrientation = [&]() -> Quaternion& {
        if (!cameraRotationRead) {
            camera.matrixWorld.decompose(scratchPosition, cameraQuaternion, scratchScale);
            cameraRotationRead = true;
        }
        return cameraQuaternion;
    };

    if (camera.type() == "OrthographicCamera") {
        direction.set(0.0, 0.0, -1.0).applyQuaternion(cameraOrientation()).negate();
    } else {
        cameraPosition.setFromMatrixPosition(camera.matrixWorld);
        direction.subVectors(cameraPosition, objectPosition);
        if (direction.lengthSq() <= kEpsilon) {
            direction.set(0.0, 0.0, -1.0).applyQuaternion(cameraOrientation()).negate();
        }
    }
    if (direction.lengthSq() <= kEpsilon) direction.set(0.0, 0.0, 1.0);

    if (lockAxis == 1 || lockAxis == 2 || lockAxis == 3) {
        if (lockAxis == 1) direction.x = 0.0;
        if (lockAxis == 2) direction.y = 0.0;
        if (lockAxis == 3) direction.z = 0.0;
        if (direction.lengthSq() <= kEpsilon) {
            if (lockAxis == 3) direction.set(1.0, 0.0, 0.0);
            else direction.set(0.0, 0.0, 1.0);
        }
    }
    direction.normalize();

    if (lockAxis == 1 || lockAxis == 2 || lockAxis == 3) {
        const Vector3 forward(0.0, 0.0, 1.0);
        objectQuaternion.setFromUnitVectors(forward, direction);
    } else {
        Vector3 screenUp(0.0, 1.0, 0.0);
        screenUp.applyQuaternion(cameraOrientation()).projectOnPlane(direction);
        if (screenUp.lengthSq() <= kEpsilon) {
            screenUp.set(1.0, 0.0, 0.0).applyQuaternion(cameraOrientation()).projectOnPlane(direction);
        }
        if (screenUp.lengthSq() <= kEpsilon) {
            screenUp.set(0.0, 1.0, 0.0);
            if (std::abs(screenUp.dot(direction)) >= 1.0 - kEpsilon) screenUp.set(1.0, 0.0, 0.0);
            screenUp.projectOnPlane(direction);
        }
        screenUp.normalize();
        Vector3 screenRight;
        screenRight.crossVectors(screenUp, direction).normalize();
        Matrix4 basis;
        basis.makeBasis(screenRight, screenUp, direction);
        objectQuaternion.setFromRotationMatrix(basis);
    }

    if (parent_ == nullptr) {
        if (quaternion.equals(objectQuaternion)) return;  // nothing moved: leave the revision alone
        quaternion.copy(objectQuaternion);
        bump();
        return;
    }
    const auto& pm = parent_->matrixWorld.elements;
    if (pm[1] == 0.0 && pm[2] == 0.0 && pm[4] == 0.0 && pm[6] == 0.0 && pm[8] == 0.0 && pm[9] == 0.0 &&
        pm[0] > 0.0 && pm[5] > 0.0 && pm[10] > 0.0) {
        // The parent carries no rotation (axis-aligned, unmirrored world): the local angle is the facing one.
        if (quaternion.equals(objectQuaternion)) return;
        quaternion.copy(objectQuaternion);
        bump();
        return;
    }
    // parent_->matrixWorld is already current from the updateWorldMatrix above, so decompose it here
    // rather than walking the parent's ancestors a second time.
    parent_->matrixWorld.decompose(scratchPosition, parentQuaternion, scratchScale);
    parentQuaternion.invert().multiply(objectQuaternion);
    if (quaternion.equals(parentQuaternion)) return;
    quaternion.copy(parentQuaternion);
    bump();
}

// ------------------------------------------------------------------------------ hierarchy

Object3D::~Object3D() {
    // Only a linked object's death changes a children list. A scratch object (InstancedMesh::raycast
    // builds a Mesh per ray) left the counter alone, or every cache keyed on it dropped once per ray.
    if (parent != nullptr || !children.empty()) markHierarchy(parent);
    const uint32_t selfContrib = (isSkinnedNode_ ? 1u : 0u) + (isBoneNode_ ? 1u : 0u);
    bool affectsSkin = !children.empty() && (skinnedSubtreeCount_ > selfContrib || isBoneNode_ || directSkinnedChildren_ > 0);
    if (parent != nullptr) {
        if (skinnedSubtreeCount_ > 0 || parent->isBoneNode_ || parent->directSkinnedChildren_ > 0 || isSkinnedNode_)
            affectsSkin = true;
        if (isSkinnedNode_ && parent->directSkinnedChildren_ > 0) --parent->directSkinnedChildren_;
        if (skinnedSubtreeCount_ > 0) parent->adjustSkinnedSubtree(-int32_t(skinnedSubtreeCount_));
    }
    if (affectsSkin) markSkinnedHierarchy();
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
    waste::debugAdd(waste::counters().sceneAdds);
    object.parent = this;
    children.push_back(&object);
    markHierarchy(this);
    {
        const bool affectsSkin = object.skinnedSubtreeCount_ > 0 || isBoneNode_ || directSkinnedChildren_ > 0;
        if (object.isSkinnedNode_) ++directSkinnedChildren_;
        if (object.skinnedSubtreeCount_ > 0) adjustSkinnedSubtree(int32_t(object.skinnedSubtreeCount_));
        if (affectsSkin) markSkinnedHierarchy();
    }
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
    waste::debugAdd(waste::counters().sceneRemoves);
    children.erase(found);
    markHierarchy(this);
    {
        const bool affectsSkin =
            object.skinnedSubtreeCount_ > 0 || isBoneNode_ || directSkinnedChildren_ > 0 || object.isSkinnedNode_;
        if (object.isSkinnedNode_ && directSkinnedChildren_ > 0) --directSkinnedChildren_;
        if (object.skinnedSubtreeCount_ > 0) adjustSkinnedSubtree(-int32_t(object.skinnedSubtreeCount_));
        if (affectsSkin) markSkinnedHierarchy();
    }
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
    waste::debugAdd(waste::counters().sceneAdds);
    object.parent = this;
    children.push_back(&object);
    markHierarchy(this);
    {
        const bool affectsSkin = object.skinnedSubtreeCount_ > 0 || isBoneNode_ || directSkinnedChildren_ > 0;
        if (object.isSkinnedNode_) ++directSkinnedChildren_;
        if (object.skinnedSubtreeCount_ > 0) adjustSkinnedSubtree(int32_t(object.skinnedSubtreeCount_));
        if (affectsSkin) markSkinnedHierarchy();
    }
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
    materializeLocalTransform();
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
    if (std::memcmp(matrix.elements.data(), composed.elements.data(), sizeof(double) * 16) != 0) { bump(); localTransformWritten(); }
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
    if (walkStamp_ != 0) {
        lastWorldEvaluation_ = walkStamp_;
        ++threadComposes_;
    } else {
        lastWorldEvaluation_ = ++matrixEvaluations_;
    }
    materializeLocalTransform();
    // Escaped aliases can change without a revision; auto-world ownership recomposes eagerly.
    const auto* tracking = ownTransformTracking();
    const bool escapedAutoWorld = tracking[0] && tracking[2] && matrixWorldAutoUpdate;
    if (plain && identityParent && matrixAutoUpdate && matrixWorldAutoUpdate && !pivot) {
        Matrix4 composed;
        composed.compose(position, quaternion, scale);
        const bool changed = bitsDiffer(matrix.elements, composed.elements);
        matrix.copy(composed);
        if (changed) { bump(); localTransformWritten(); }
        const uint64_t parentId = parent ? parent->id() + 1 : 0;
        const uint64_t parentRevision = parent ? parent->revision() : 0;
        const bool updateWorld = changed || matrixWorldNeedsUpdate || force || worldParentId_ != parentId || worldParentRevision_ != parentRevision;
        if (updateWorld || escapedAutoWorld) {
            const bool worldChanged = bitsDiffer(matrixWorld.elements, composed.elements);
            if (worldChanged) bump();
            matrixWorld.copy(composed);
            matrixWorldNeedsUpdate = false;
            worldParentId_ = parentId;
            worldParentRevision_ = parentRevision;
            return updateWorld || worldChanged;
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
    } else {
        localTransformWritten();  // the game owns `matrix` and writes it with no call: every walk may be a new pose
    }

    const uint64_t parentId = parent ? parent->id() + 1 : 0;
    const uint64_t parentRevision = parent ? parent->revision() : 0;
    const bool updateWorld = matrixWorldNeedsUpdate || force || worldParentId_ != parentId || worldParentRevision_ != parentRevision;
    if (updateWorld || escapedAutoWorld) {
        bool worldChanged = false;
        if (matrixWorldAutoUpdate) {
            Matrix4 composed;
            if (parent == nullptr || identityParent) {
                composed.copy(matrix);
            } else {
                composed.multiplyMatrices(parent->matrixWorld, matrix);
            }
            // A parent's move reaches the renderer through the child's world matrix.
            worldChanged = std::memcmp(matrixWorld.elements.data(), composed.elements.data(), sizeof(double) * 16) != 0;
            if (worldChanged) bump();
            matrixWorld.copy(composed);
        }
        matrixWorldNeedsUpdate = false;
        worldParentId_ = parentId;
        worldParentRevision_ = parentRevision;
        force = updateWorld || worldChanged;
    }

    // A manually owned world matrix can change without a revision; retain its forced child update.
    if (!matrixWorldAutoUpdate) force = true;
    return force;
}

void Object3D::updateMatrixWorld(bool force) {
    if (skipsGpuJointSubtree()) { ++gpuBoundaryVisits_; return; }
    force = updateMatrixWorldSelf(force);
    for (Object3D* child : children) child->updateMatrixWorld(force);
}

int Object3D::visitMatrixWorldVisible(bool force, bool prune) {
    if (skipsGpuJointSubtree()) { ++gpuBoundaryVisits_; return -1; }
    // Nothing here can draw, so its own compose waits for the frame it shows, as core's MatrixWorldPass
    // does. Remembered even when clean: its local or an ancestor's transform can change while it is hidden.
    // A camera renders from its world matrix whatever its flag, and a rig's bones pose a visible mesh.
    if (prune && !visible_ && !isCamera()) {
        if (holdsBones_ < 0) {
            holdsBones_ = 0;
            traverse([](Object3D& node, void* found) {
                if (node.type() == "Bone") *static_cast<int8_t*>(found) = 1;
            }, &holdsBones_);
        }
        if (holdsBones_ == 0) {
            worldStale_ = true;
            return -1;
        }
    }
    bool childForce = updateMatrixWorldSelf(force || worldStale_);
    afterMatrixWorld();
    if (worldStale_) childForce = true;
    worldStale_ = false;
    if (isStatic && !matrixWorldAutoUpdate) return -1;
    return childForce ? 1 : 0;
}

uint32_t Object3D::updateMatrixWorldVisible(bool force, bool prune) {
    waste::debugAdd(waste::counters().sceneVisits);
    const int childForce = visitMatrixWorldVisible(force, prune);
    uint32_t visited = 1;
    if (childForce >= 0)
        for (Object3D* child : children) visited += child->updateMatrixWorldVisible(childForce == 1, prune);
    return visited;
}

uint32_t Object3D::updateMatrixWorldVisibleJobs(bool force, bool prune) {
    const uint64_t composedBefore = matrixEvaluations_;
    // The compose gate comes first: the pool starts on the first walk that needs it, so a realm that walks no
    // large scene (the page that only hosts the game's worker) starts no threads.
    if (walkComposes_ < kParallelWalkComposes || JobPool::inJob() || poseObserver != nullptr ||
        JobPool::shared().workers() == 0) {
        walkNodes_ = updateMatrixWorldVisible(force, prune);
        walkComposes_ = uint32_t(matrixEvaluations_ - composedBefore);
        return walkNodes_;
    }
    JobPool& pool = JobPool::shared();
    struct Item { Object3D* node; bool force; };
    // The caller's scratch: a job names it through this reference, never through the thread_local.
    static thread_local std::vector<Item> scratch, scratchJobs;
    std::vector<Item>& frontier = scratch;
    std::vector<Item>& jobs = scratchJobs;
    frontier.clear();
    jobs.clear();
    frontier.push_back({this, force});
    // Breadth-first: a subtree becomes a job once there are enough jobs and its last walk was small,
    // so one deep subtree is split instead of keeping a worker busy while the others wait.
    const std::size_t target = 8 * (std::size_t(pool.workers()) + 1);
    const uint32_t grain = walkNodes_ / uint32_t(target);
    std::size_t head = 0;
    uint32_t visited = 0;
    while (head < frontier.size()) {
        const Item item = frontier[head++];
        if (item.node->walkNodes_ <= grain && jobs.size() + (frontier.size() - head) + 1 >= target) {
            jobs.push_back(item);
            continue;
        }
        ++visited;
        const int childForce = item.node->visitMatrixWorldVisible(item.force, prune);
        if (childForce >= 0)
            for (Object3D* child : item.node->children) frontier.push_back({child, childForce == 1});
    }
    // Every node a job composes takes one stamp, later than any the frontier took: "evaluated since" holds.
    const uint64_t stamp = matrixEvaluations_ + 1;
    std::atomic<uint32_t> jobVisits{0};
    std::atomic<uint64_t> jobComposes{0};
    pool.forEach(uint32_t(jobs.size()), [&](uint32_t i) {
        Object3D& node = *jobs[i].node;
        walkStamp_ = stamp;
        threadComposes_ = 0;
        // The subtree's size decides next frame whether it is split further.
        node.walkNodes_ = node.updateMatrixWorldVisible(jobs[i].force, prune);
        jobVisits.fetch_add(node.walkNodes_, std::memory_order_relaxed);
        jobComposes.fetch_add(threadComposes_, std::memory_order_relaxed);
        walkStamp_ = 0;
    });
    // At least the stamp when any job composed, so a later stamp is later than every job's.
    matrixEvaluations_ += jobComposes.load(std::memory_order_relaxed);
    walkComposes_ = uint32_t(matrixEvaluations_ - composedBefore);
    return walkNodes_ = visited + jobVisits.load(std::memory_order_relaxed);
}

void Object3D::updateWorldMatrix(bool updateParents, bool updateChildren, bool force) {
    lastWorldEvaluation_ = ++matrixEvaluations_;
    materializeLocalTransform();
    Object3D* const parent_ = parent;

    if (updateParents && parent_ != nullptr) parent_->updateWorldMatrix(true, false);

    if (matrixAutoUpdate) updateMatrix();

    const uint64_t parentId = parent_ ? parent_->id() + 1 : 0;
    const uint64_t parentRevision = parent_ ? parent_->revision() : 0;
    if (matrixWorldNeedsUpdate || force || worldParentId_ != parentId || worldParentRevision_ != parentRevision) {
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
    // A SkinnedMesh bound after its last world update keeps an identity bindMatrixInverse; measuring
    // it here (Box3, normaliseToMetres) would otherwise skip the inverse of its own world matrix.
    afterMatrixWorld();

    if (updateChildren) {
        for (Object3D* child : children) child->updateWorldMatrix(false, true, force);
    }
}

Object3D& Object3D::copy(const Object3D& source) {
    const_cast<Object3D&>(source).materializeLocalTransform();
    prepareLocalTransformWrite();
    markLocalTransformDirty();
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
    isStatic = source.isStatic;
    layers_.mask = source.layers_.mask;
    visible_ = source.visible_;
    castShadow_ = source.castShadow_;
    receiveShadow_ = source.receiveShadow_;
    frustumCulled = source.frustumCulled;
    renderOrder_ = source.renderOrder_;
    bump();
    return *this;
}

namespace {
// The pre-walk's GPU-joint verdict for each node it admits, in visit order: the shift walk below visits the same
// nodes in the same order and reads it here instead of locking each boundary's weak flag a second time.
thread_local std::vector<uint8_t> shiftBoundaries;

bool canShiftWorldYSubtree(const Object3D& node) {
    if (!node.matrixAutoUpdate || !node.matrixWorldAutoUpdate || node.pivot.has_value()) return false;
    // MatrixWorldPass skips GPU-joint bone subtrees; they evaluate on GPU relative to the shifted placement.
    const bool boundary = node.skipsGpuJointSubtree();
    shiftBoundaries.push_back(boundary ? 1 : 0);
    if (boundary) return true;
    if (node.hasDeferredTransformPublication()) return false;
    for (const Object3D* child : node.children) {
        if (!canShiftWorldYSubtree(*child)) return false;
    }
    return true;
}
}  // namespace

bool Object3D::shiftWorldYInPlace(double dy, Object3D* alreadyWalkedDescendant) {
    (void)alreadyWalkedDescendant;
    if (dy == 0.0) return true;
    // The shift root owns its own placement: a manual matrix, a pivot, a deferred publication or a GPU-joint
    // subtree makes a blind +dy world shift a guess, so answer in O(1) before the walk and let the caller compose.
    if (!matrixAutoUpdate || !matrixWorldAutoUpdate || pivot.has_value() || hasDeferredTransformPublication() ||
        skipsGpuJointSubtree())
        return false;
    shiftBoundaries.clear();
    for (const Object3D* child : children) {
        if (!canShiftWorldYSubtree(*child)) return false;
    }

    const uint64_t expectedParentId = parent ? parent->id() + 1 : 0;
    const uint64_t expectedParentRev = parent ? parent->revision() : 0;
    const bool wasCleanSelf =
        !matrixWorldNeedsUpdate && worldParentId_ == expectedParentId && worldParentRevision_ == expectedParentRev;
    const Matrix4 oldWorld = matrixWorld;
    const uint64_t selfOldRev = revision_;

    prepareLocalTransformWrite();
    if (parent == nullptr) {
        position.y += dy;
    } else {
        const auto& pm = parent->matrixWorld.elements;
        if (std::abs(pm[1]) < 1e-12 && std::abs(pm[9]) < 1e-12 && std::abs(pm[5]) > 1e-12) {
            position.y += dy / pm[5];
        } else {
            Matrix4 parentInverse;
            parentInverse.copy(parent->matrixWorld).invert();
            Vector3 origin(0.0, 0.0, 0.0);
            Vector3 target(0.0, dy, 0.0);
            origin.applyMatrix4(parentInverse);
            target.applyMatrix4(parentInverse);
            position.add(target.sub(origin));
        }
    }

    updateMatrix();
    Matrix4 composed;
    if (parent == nullptr) composed.copy(matrix);
    else composed.multiplyMatrices(parent->matrixWorld, matrix);
    bool pureYShift = wasCleanSelf;
    if (pureYShift) {
        for (int k = 0; k < 16; ++k) {
            const double want = oldWorld.elements[k] + (k == 13 ? dy : 0.0);
            if (std::abs(composed.elements[k] - want) > 1e-9) {
                pureYShift = false;
                break;
            }
        }
    }
    if (std::memcmp(matrixWorld.elements.data(), composed.elements.data(), sizeof(double) * 16) != 0)
        bump();
    matrixWorld.copy(composed);
    matrixWorldNeedsUpdate = false;
    worldParentId_ = expectedParentId;
    worldParentRevision_ = expectedParentRev;
    lastWorldEvaluation_ = ++matrixEvaluations_;
    afterMatrixWorld();

    // Shift only subtrees whose cached local & world state is strictly clean from this parent; any node with
    // uncomposed local edits or unwalked parent links composes itself once instead of blind shifting.
    std::size_t visit = 0;
    auto syncOrShift = [&](auto& selfRef, Object3D& node, uint64_t pId, uint64_t pOldRev, bool canShift) -> void {
        if (shiftBoundaries[visit++] != 0) return;
        const uint64_t nodeOldRev = node.revision_;
        bool nodeClean = false;
        if (canShift) {
            // canShiftWorldYSubtree admitted this node, so it owns its local matrix: recompose it in place.
            // updateMatrix() always raises matrixWorldNeedsUpdate, so the dirt that matters is the earlier
            // one, and a local matrix that actually moved shows up as a revision bump inside updateMatrix().
            node.materializeLocalTransform();
            const bool worldWasDirty = node.matrixWorldNeedsUpdate;
            if (node.matrixAutoUpdate) node.updateMatrix();
            nodeClean = !worldWasDirty && node.revision_ == nodeOldRev && node.worldParentId_ == pId &&
                        node.worldParentRevision_ == pOldRev;
        }
        if (nodeClean) {
            node.matrixWorld.elements[13] += dy;
            node.bump();
            node.matrixWorldNeedsUpdate = false;
            node.worldParentId_ = pId;
            node.worldParentRevision_ = node.parent->revision();
            node.lastWorldEvaluation_ = ++matrixEvaluations_;
            node.afterMatrixWorld();
            for (Object3D* c : node.children) selfRef(selfRef, *c, node.id() + 1, nodeOldRev, true);
            return;
        }
        if (canShift) {
            // The local matrix is materialised and composed above, so compose the world matrix alone here:
            // updateWorldMatrix would materialise and compose that local matrix a second time.
            node.matrixWorldNeedsUpdate = false;
            const Matrix4 before = node.matrixWorld;
            node.matrixWorld.multiplyMatrices(node.parent->matrixWorld, node.matrix);
            if (std::memcmp(before.elements.data(), node.matrixWorld.elements.data(), sizeof(double) * 16) != 0)
                node.bump();
            node.worldParentId_ = pId;
            node.worldParentRevision_ = node.parent->revision();
            node.lastWorldEvaluation_ = ++matrixEvaluations_;
            node.afterMatrixWorld();
        } else {
            node.updateWorldMatrix(false, false, true);
        }
        for (Object3D* c : node.children) selfRef(selfRef, *c, node.id() + 1, nodeOldRev, false);
    };
    for (Object3D* c : children) syncOrShift(syncOrShift, *c, id() + 1, selfOldRev, pureYShift);
    return true;
}

}  // namespace tn::engine
