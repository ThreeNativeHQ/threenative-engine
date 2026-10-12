#pragma once

// Object3D, Layers and EventDispatcher, ported from three@0.185.1 src/core/{Object3D,Layers,
// EventDispatcher}.js. Ownership is a heap record per object: an Object3D never moves, and its
// transform members are plain fields, so `&object.position` is the same address on every access and
// survives any number of insertions into a sibling list.
//
// Not ported, and why:
//   - `clone`, `toJSON`: out of scope for the object model (PRD-508 phases 1-2).
//   - `userData`, `animations`, `customDepthMaterial`, `customDistanceMaterial`, `static`:
//     a bag, an animation list, renderer-only materials and a renderer fast-path flag.
//   - `onBeforeShadow`/`onAfterShadow`/`onBeforeRender`/`onAfterRender`: renderer callbacks that
//     only a renderer calls (PRD-514).
//   - `modelViewMatrix`, `normalMatrix`: the renderer's per-frame matrices (PRD-514).
//   - `getObjectsByProperty`: the single-result form above is all the object model needs.
//   - `isMesh`, `isScene`, `isGroup`, `isCamera`, `isLight` booleans: C++ answers them with the
//     class itself, and `isCamera`/`isLight` (the only two Object3D reads) are virtual below.
//   - `copy`'s `recursive` branch: it clones children, and `clone` is not ported.
//   - `Object.defineProperty` descriptors: plain members, which is what a C++ caller expects.
//
// Lifetime: a child that is shared-owned (made with std::make_shared, as every bound object is) is
// owned by its parent while attached, so a scene keeps what it draws alive after its creator lets go
// — what the reference gets from the garbage collector. A plain C++ child stays borrowed. Either
// side's destructor detaches the other, so neither ever holds a dangling `parent` or child.

#include <cstdint>
#include <bit>
#include <cmath>
#include <functional>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "engine/foundation/math/Euler.h"
#include "engine/foundation/math/Matrix.h"
#include "engine/foundation/math/Quaternion.h"
#include "engine/foundation/math/Vector.h"

namespace tn::engine {

class Object3D;
class BufferGeometry;
class Material;
class Raycaster;
struct Intersection;

/**
 * What a render callback receives, as three's onBeforeRender does: the scene and camera being
 * rendered and the object's geometry and material (PRD-531, PRD-506). Any may be null.
 */
struct RenderCallbackArgs {
    const Object3D* scene = nullptr;
    const Object3D* camera = nullptr;
    // Shared, as the mesh holds them: a language may have released its handle to either, and the
    // callback still hands it the same object.
    std::shared_ptr<const BufferGeometry> geometry;
    std::shared_ptr<const Material> material;
};

/**
 * A language callback set on an object: true when it ran, false with `error` when the callee threw.
 * Shared, so a call in progress keeps it alive while the callee replaces it.
 */
using RenderCallback = std::shared_ptr<const std::function<bool(const RenderCallbackArgs&, std::string& error)>>;

/**
 * A dispatched event, three's shape: the type, the dispatcher as `target`, and `child` for the two
 * child-lifecycle events. `type` names a static string; it never owns one.
 */
struct Event {
    std::string_view type;
    Object3D* target = nullptr;
    Object3D* child = nullptr;
};

/**
 * three's EventDispatcher: one listener list per event type, and a dispatch that copies the list
 * before calling it, so a listener may remove itself while the event is being delivered. A listener
 * is a function pointer plus a context, so registering one costs no allocation.
 *
 * It exists here only as Object3D's base, so the `target` a dispatch stamps on the event is
 * `static_cast<Object3D*>(this)`.
 */
class EventDispatcher {
public:
    using Listener = void (*)(const Event& event, void* context);

    /** Adds the listener for `type`, unless that exact listener is already registered for it. */
    void addEventListener(std::string_view type, Listener listener, void* context);
    [[nodiscard]] bool hasEventListener(std::string_view type, Listener listener, void* context) const;
    void removeEventListener(std::string_view type, Listener listener, void* context);
    void dispatchEvent(Event& event);

private:
    struct Entry {
        Listener listener;
        void* context;
    };
    // std::less<> keeps the lookup by string_view from allocating a temporary std::string.
    std::map<std::string, std::vector<Entry>, std::less<>> listeners_;
};

/** three's Layers: a 32-bit membership mask, layer 0 by default. */
class Layers {
public:
    // A JS number property: assignment does not coerce; bit operations use ECMAScript ToUint32.
    double mask = 1;
    static uint32_t bits(double value) {
        if (!std::isfinite(value) || value == 0) return 0;
        if (value >= 0 && value <= 4294967295.0) return uint32_t(value);
        double integer = std::fmod(std::trunc(value), 4294967296.0);
        if (integer < 0) integer += 4294967296.0;
        return uint32_t(integer);
    }
    static double signedBits(uint32_t value) { return double(std::bit_cast<int32_t>(value)); }
    void set(int layer) { mask = double(uint32_t(1) << (uint32_t(layer) & 31)); }
    void enable(int layer) { mask = signedBits(bits(mask) | (uint32_t(1) << (uint32_t(layer) & 31))); }
    void enableAll() { mask = -1; }
    void toggle(int layer) { mask = signedBits(bits(mask) ^ (uint32_t(1) << (uint32_t(layer) & 31))); }
    void disable(int layer) { mask = signedBits(bits(mask) & ~(uint32_t(1) << (uint32_t(layer) & 31))); }
    void disableAll() { mask = 0; }
    [[nodiscard]] bool test(const Layers& layers) const { return (bits(mask) & bits(layers.mask)) != 0; }
    [[nodiscard]] bool isEnabled(int layer) const { return (bits(mask) & (uint32_t(1) << (uint32_t(layer) & 31))) != 0; }

};

/**
 * An Object3D's `rotation` and `quaternion` are two views of one orientation, as three's are: an
 * Euler component write fires `_onChangeCallback`, which writes the quaternion, and a quaternion
 * component write fires the other callback. The math classes expose their components as plain
 * fields, so a C++ `object.rotation.x = a` would write the field and bypass the callback. These two
 * subclasses add three's component setters: they write the inherited field, then notify, so a C++
 * author gets the same coupling the bindings already give a JS one. Every method and every
 * `Euler&`/`Quaternion&` view still reads and writes the same plain fields underneath.
 */
class SyncedEuler : public Euler {
public:
    SyncedEuler() = default;
    /**
     * A copy is three's `clone`: the values come over (base copy ctor, no callback), and the
     * accessors default-initialise against the new object, so a write to the copy cannot reach the
     * source. Without this the copied accessors would keep the source's `this`.
     */
    SyncedEuler(const SyncedEuler& other) : Euler(other) {}
    /** Keep this object's callback and accessors; the base copy overwrites the values and notifies. */
    SyncedEuler& operator=(const SyncedEuler& other) { Euler::operator=(other); return *this; }
    /** The plain Euler form, so `object.rotation = someEuler` syncs the quaternion, as three does. */
    SyncedEuler& operator=(const Euler& other) { Euler::operator=(other); return *this; }

    /** three's `euler.x = v`: write the field, then fire `_onChangeCallback`. */
    template<double Euler::* Field>
    class Angle {
    public:
        explicit Angle(Euler* owner) : owner_(owner) {}
        Angle& operator=(double value) {
            owner_->*Field = value;
            owner_->notify();
            return *this;
        }
        Angle& operator=(const Angle& other) { return *this = static_cast<double>(other); }
        [[nodiscard]] operator double() const { return owner_->*Field; }

    private:
        Euler* owner_;
    };
    /** three's `euler.order = v`: reorders the angles, then fires `_onChangeCallback`. */
    class Order {
    public:
        explicit Order(Euler* owner) : owner_(owner) {}
        Order& operator=(EulerOrder value) {
            owner_->order = value;
            owner_->notify();
            return *this;
        }
        Order& operator=(const Order& other) { return *this = static_cast<EulerOrder>(other); }
        [[nodiscard]] operator EulerOrder() const { return owner_->order; }

    private:
        Euler* owner_;
    };

    Angle<&Euler::x> x{this};
    Angle<&Euler::y> y{this};
    Angle<&Euler::z> z{this};
    Order order{this};
};

/** three's quaternion setters: the same coupling, the other direction. */
class SyncedQuaternion : public Quaternion {
public:
    SyncedQuaternion() = default;
    /** A copy is three's `clone`: values only, with the accessors bound to the new object. */
    SyncedQuaternion(const SyncedQuaternion& other) : Quaternion(other) {}
    /** Keep this object's callback and accessors; the base copy overwrites the values and notifies. */
    SyncedQuaternion& operator=(const SyncedQuaternion& other) {
        Quaternion::operator=(other);
        return *this;
    }
    /** The plain Quaternion form, so `object.quaternion = someQuaternion` syncs the Euler. */
    SyncedQuaternion& operator=(const Quaternion& other) {
        Quaternion::operator=(other);
        return *this;
    }

    template<double Quaternion::* Field>
    class Component {
    public:
        explicit Component(Quaternion* owner) : owner_(owner) {}
        Component& operator=(double value) {
            owner_->*Field = value;
            owner_->notify();
            return *this;
        }
        Component& operator=(const Component& other) { return *this = static_cast<double>(other); }
        [[nodiscard]] operator double() const { return owner_->*Field; }

    private:
        Quaternion* owner_;
    };

    Component<&Quaternion::x> x{this};
    Component<&Quaternion::y> y{this};
    Component<&Quaternion::z> z{this};
    Component<&Quaternion::w> w{this};
};

struct TransformPage;

class Object3D : public EventDispatcher, public std::enable_shared_from_this<Object3D> {
private:
    struct TransformSlot { TransformPage* page; std::size_t index; };
    static TransformSlot acquireTransform();
    void releaseTransform();
    TransformSlot transform_;
public:
    // false suppresses recursive ray traversal, as three's raycast return value does.
    virtual bool raycast(const Raycaster&, std::vector<Intersection>&) { return true; }
    Object3D();
    std::string uuid;
    Object3D(const Object3D&) = delete;
    Object3D& operator=(const Object3D&) = delete;
    /** Detaches from both sides: children lose their `parent`, the parent loses this child. */
    virtual ~Object3D();

    /** three's `type` string, the class name a loader would serialize. */
    [[nodiscard]] virtual std::string_view type() const { return "Object3D"; }
    /** The two type tests three's own code reads inside Object3D: `lookAt` picks its order by them. */
    [[nodiscard]] virtual bool isCamera() const { return false; }
    [[nodiscard]] virtual bool isLight() const { return false; }

    /** three's `_object3DId ++`: a process-wide counter starting at zero. */
    [[nodiscard]] uint64_t id() const { return id_; }
    [[nodiscard]] static uint64_t hierarchyVersion();
    std::string name;  // not a renderer input, so a plain field: writes do not bump `revision()`

    Object3D* parent = nullptr;
    /** three's onBeforeRender: run before this object is drawn (RenderDatabase::render). */
    RenderCallback onBeforeRender;
    std::vector<Object3D*> children;

    /** `Object3D.DEFAULT_UP`, the up direction a new object copies. */
    static Vector3 defaultUp;
    static bool defaultMatrixAutoUpdate;
    static bool defaultMatrixWorldAutoUpdate;

    // The transform. Plain fields: their addresses are stable for the object's whole life.
    // `rotation` and `quaternion` are the synced subclasses, so a component write reaches the other
    // form; every `Euler&`/`Quaternion&` view of them still sees the same plain fields.
    // Stable references into paged SoA storage. Bulk writes and batch reads share these arrays;
    // the public math members and their component addresses never move.
    Vector3& position;
    SyncedEuler& rotation;
    SyncedQuaternion& quaternion;
    Vector3& scale;
    Vector3& positionValue() { return position; }
    Vector3& scaleValue() { return scale; }
    SyncedEuler& rotationValue() { return rotation; }
    SyncedQuaternion& quaternionValue() { return quaternion; }
    Matrix4& matrixValue() { return matrix; }
    Matrix4& matrixWorldValue() { return matrixWorld; }
    Vector3 up{0, 1, 0};
    Matrix4& matrix;
    Matrix4& matrixWorld;
    /** r185's pivot: rotation and scale apply around this point instead of the origin. */
    std::optional<Vector3> pivot;

    bool matrixAutoUpdate = true;
    bool matrixWorldAutoUpdate = true;
    bool matrixWorldNeedsUpdate = false;
    bool frustumCulled = true;
    /** core's alwaysRender() marker, mirrored for the engine's projected-size cull (projected_cull.h). */
    bool alwaysRender = false;
    /** Owned for a language binding that listens to this object's graph events; dies with the object. */
    std::shared_ptr<void> languageListeners;

    /** The renderer's inputs. Each setter bumps `revision()`; a direct field write cannot. */
    [[nodiscard]] bool visible() const { return visible_; }
    void setVisible(bool value);
    /** Where each flag sits from `flags()`, for a back end that reads it in place (Wasm). The
     *  offsets count from the first flag, not the object, so they hold for every pointer size. */
    struct FlagOffsets { uint32_t visible, castShadow, receiveShadow; };
    static FlagOffsets flagOffsets();
    [[nodiscard]] const void* flags() const { return &visible_; }
    [[nodiscard]] bool castShadow() const { return castShadow_; }
    void setCastShadow(bool value);
    [[nodiscard]] bool receiveShadow() const { return receiveShadow_; }
    void setReceiveShadow(bool value);
    [[nodiscard]] int renderOrder() const { return renderOrder_; }
    void setRenderOrder(int value);
    [[nodiscard]] const Layers& layers() const { return layers_; }
    /** Every Layers mutation goes through here or through one of the wrappers below, so it counts. */
    void setLayerMask(double mask);
    void setLayer(int layer);
    void enableLayer(int layer);
    void enableAllLayers();
    void toggleLayer(int layer);
    void disableLayer(int layer);
    void disableAllLayers();

    /**
     * The renderer's change counter (PRD-508 §6.4). It counts the writes the renderer must react
     * to, and nothing else: every transform method below, `updateMatrix` and the world-matrix updates
     * when they change the matrix bits (three recomposes every auto-update object every frame, so an
     * unchanged recompose is not a change), `add`/`remove`/`attach`/
     * `clear` (which bump the object they are called on, so `child.removeFromParent()` bumps the
     * parent), every setter above, and `copy`. A direct write to `position`, `scale`, `up`,
     * `matrix`, `matrixWorld`, `pivot` or the auto-update flags is a C++ field write the engine
     * cannot see; its sync point is `updateMatrix`, which the renderer calls when `matrixAutoUpdate`
     * is on. A write to a component of `rotation` or `quaternion` goes through three's setters and
     * syncs the other form immediately, as three does.
     */
    [[nodiscard]] uint64_t revision() const { return revision_; }

    using Visitor = void (*)(Object3D& object, void* context);

    // ---- transforms, three's order
    void applyMatrix4(const Matrix4& m);
    Object3D& applyQuaternion(const Quaternion& q);
    void setRotationFromAxisAngle(const Vector3& axis, double angle);
    void setRotationFromEuler(const Euler& euler);
    void setRotationFromMatrix(const Matrix4& m);
    void setRotationFromQuaternion(const Quaternion& q);
    Object3D& rotateOnAxis(const Vector3& axis, double angle);
    Object3D& rotateOnWorldAxis(const Vector3& axis, double angle);
    Object3D& rotateX(double angle);
    Object3D& rotateY(double angle);
    Object3D& rotateZ(double angle);
    Object3D& translateOnAxis(const Vector3& axis, double distance);
    Object3D& translateX(double distance);
    Object3D& translateY(double distance);
    Object3D& translateZ(double distance);
    Vector3& localToWorld(Vector3& vector);
    Vector3& worldToLocal(Vector3& vector);
    void lookAt(const Vector3& target);
    void lookAt(double x, double y, double z);

    // ---- hierarchy
    Object3D& add(Object3D& object);
    Object3D& add(const std::vector<Object3D*>& objects);
    Object3D& remove(Object3D& object);
    /** The vector form is what `clear` passes, and how a loader adds a whole list. */
    Object3D& remove(const std::vector<Object3D*>& objects);
    Object3D& removeFromParent();
    Object3D& clear();
    Object3D& attach(Object3D& object);

    [[nodiscard]] Object3D* getObjectById(uint64_t id);
    [[nodiscard]] Object3D* getObjectByName(std::string_view name);
    /**
     * three's `getObjectByProperty`, narrowed to the string-valued properties this class has
     * (`name` and `type`). Any other property matches nothing, which is what three's strict
     * comparison already answers for a property Object3D does not carry.
     */
    [[nodiscard]] Object3D* getObjectByProperty(std::string_view property, std::string_view value);

    // ---- synchronous world queries
    Vector3& getWorldPosition(Vector3& target);
    Quaternion& getWorldQuaternion(Quaternion& target);
    Vector3& getWorldScale(Vector3& target);
    virtual Vector3& getWorldDirection(Vector3& target);

    void traverse(Visitor visitor, void* context);
    void traverseVisible(Visitor visitor, void* context);
    void traverseAncestors(Visitor visitor, void* context);

    virtual void updateMatrix();
    virtual void updateMatrixWorld(bool force = false);
    /** Renderer traversal can consume a flat child immediately after updating it. */
    bool updateMatrixWorldSelf(bool force = false, bool identityParent = false, bool plain = false);
    virtual void updateWorldMatrix(bool updateParents, bool updateChildren, bool force = false);

    /** three's `copy` without its `recursive` branch: fields only, because `clone` is not ported. */
    Object3D& copy(const Object3D& source);

private:
    void bump() { ++revision_; }
    uint64_t worldParentId_ = 0, worldParentRevision_ = 0;

    static void onRotationChange(void* context);
    static void onQuaternionChange(void* context);

    bool visible_ = true;
    bool castShadow_ = false;
    bool receiveShadow_ = false;
    int renderOrder_ = 0;
    Layers layers_;
    uint64_t id_ = 0;
    uint64_t revision_ = 0;
    std::vector<std::shared_ptr<Object3D>> owned_;  // shared-owned children, held while attached
    void own(Object3D& child);
    void disown(Object3D& child);
};

}  // namespace tn::engine
