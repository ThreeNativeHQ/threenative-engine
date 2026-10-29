// The scene classes in the engine's one binding registry (PRD-508). The differential fixture driver
// and the C ABI drive the same registry, so a fixture and a `tn_invoke` call reach the same method.
//
// Members are read two ways, because the protocol asks for both. A dotted path (`position.x`,
// `matrixWorld.elements`) is a getter or setter on the owning object. A whole member (`position`) is
// a *method* that answers a Ref to the member itself — not a copy — because the getter signature
// carries no Store and a Store is what turns a native pointer into a caller-visible object. So
// `object.position` is one vector, the same Ref on every call, and writing through it writes the
// object's own vector.
//
// `rotation.x`/`y`/`z` write the component and then call Euler::notify(), as three's Euler setters
// fire _onChangeCallback, so the quaternion follows; a JS `mesh.rotation.x = v` reaches the same
// notify through the Euler member's own setters.

#include "engine/renderer/projection/plan.h"
#include "engine/foundation/waste_counters.h"
#include "engine/scene/projected_cull.h"
#include "engine/abi/bindings.h"
#include "engine/abi/pooled_shared.h"
#include "engine/animation/mixer.h"
#include "engine/animation/skinning/skeleton.h"

#include <cmath>

#include "engine/foundation/math/Euler.h"
#include "engine/foundation/math/Matrix.h"
#include "engine/foundation/math/Quaternion.h"
#include "engine/foundation/math/Vector.h"
#include "engine/scene/camera.h"
#include "engine/scene/raycaster.h"
#include "engine/scene/geometry.h"
#include "engine/scene/material.h"
#include "engine/scene/nodes.h"
#include "engine/scene/texture.h"
#include "engine/foundation/job_pool.h"
#include "engine/scene/object3d.h"

#include <array>
#include <atomic>
#include <bit>
#include <cstdint>
#include <memory>
#include <unordered_map>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace tn::binding {

using namespace tn::engine;

namespace {

double optional(const Args& a, size_t i, double fallback) {
    return i < a.size() && a.at(i).kind != Value::Kind::Null ? number(a.at(i)) : fallback;
}

bool flag(const Value& v) { return v.kind == Value::Kind::Bool ? v.flag : number(v) != 0; }

bool boolean(const Args& a, size_t i, bool fallback) { return i < a.size() && a.at(i).kind != Value::Kind::Null ? flag(a.at(i)) : fallback; }

template <typename T>
T* as(void* self) {
    return static_cast<T*>(self);
}

Value numbers(const double* values, size_t count) {
    return Value::list(std::vector<double>(values, values + count));
}

double component3(const Vector3& v, int i) { return i == 0 ? v.x : (i == 1 ? v.y : v.z); }

void setComponent3(Vector3& v, int i, double value) {
    (i == 0 ? v.x : (i == 1 ? v.y : v.z)) = value;
}

double component4(const Quaternion& q, int i) {
    const std::array<double, 4> a = q.toArray();
    return a[i];
}

void setComponent4(Quaternion& q, int i, double value) {
    const std::array<double, 4> a = q.toArray();
    q.set(i == 0 ? value : a[0], i == 1 ? value : a[1], i == 2 ? value : a[2],
          i == 3 ? value : a[3]);
}

/** Registers `<prefix>.x`/`y`/`z` for a Vector3 field, read and written. */
template <typename T, typename Field>
void nestedVector(ClassBinding& b, const char* prefix, Field field) {
    for (int i = 0; i < 3; ++i) {
        const std::string path = std::string(prefix) + "." + "xyz"[i];
        b.getters[path] = [field, i](void* self) { as<T>(self)->materializeLocalTransform(); return Value::of(component3(std::invoke(field, *as<T>(self)), i)); };
        b.setters[path] = [field, i](void* self, const Value& v) {
            as<T>(self)->prepareLocalTransformWrite();
            setComponent3(std::invoke(field, *as<T>(self)), i, number(v));
            as<T>(self)->markLocalTransformDirty();
        };
    }
}

/** Registers `<prefix>.x`/`y`/`z`/`w` for a Quaternion field, read and written. */
template <typename T, typename Field>
void nestedQuaternion(ClassBinding& b, const char* prefix, Field field) {
    const char* const names[4] = {"x", "y", "z", "w"};
    for (int i = 0; i < 4; ++i) {
        const std::string path = std::string(prefix) + "." + names[i];
        b.getters[path] = [field, i](void* self) { as<T>(self)->materializeLocalTransform(); return Value::of(component4(std::invoke(field, *as<T>(self)), i)); };
        b.setters[path] = [field, i](void* self, const Value& v) {
            as<T>(self)->prepareLocalTransformWrite();
            setComponent4(std::invoke(field, *as<T>(self)), i, number(v));  // Quaternion::set notifies
        };
    }
}

/** Registers `<prefix>.elements` for a Matrix4 field: three's column-major array. */
template <typename T, typename Field>
void nestedMatrix(ClassBinding& b, const char* prefix, Field field) {
    b.getters[std::string(prefix) + ".elements"] = [field](void* self) {
        auto& matrix = std::invoke(field, *as<T>(self));
        Object3D::prepareTransformView(&matrix);
        return numbers(matrix.elements.data(), 16);
    };
}

/**
 * A method that answers the Ref of one of `self`'s own members. `memberAlias` resolves `self`
 * through the caller, so the Ref keeps the owner alive and is the same value on every call.
 */
template <typename Owner, typename M>
Method memberAliasMethod(M Owner::*field, const char* cls) {
    return [field, cls](void* self, const Args&, Store& store) {
        return memberAlias(store, self, as<Owner>(self)->*field, cls);
    };
}

template <typename Owner, typename M>
Method memberAliasMethod(M& (Owner::*field)(), const char* cls) {
    return [field, cls](void* self, const Args&, Store& store) {
        return memberAlias(store, self, (as<Owner>(self)->*field)(), cls);
    };
}

std::shared_ptr<void> makeNode() { return std::static_pointer_cast<void>(std::make_shared<Object3D>()); }

// ---------------------------------------------------------------------------- Object3D

/** A found descendant as its own Ref; a borrowed (C++-owned) object has no shared owner to hand out. */
Value foundObject(Store& store, Object3D* found) {
    if (found == nullptr) return Value{};
    std::shared_ptr<Object3D> shared = found->weak_from_this().lock();
    if (!shared) throw Unsupported{"the object found is not shared-owned"};
    return store.share(std::string(found->type()), std::static_pointer_cast<void>(shared));
}

// The projected-size cull's state for a root, kept while the root lives (a freed root's slot is
// dropped the next time any root asks).
ProjectedCull& projectedCullOf(Object3D& root) {
    static std::unordered_map<const Object3D*, std::pair<std::weak_ptr<Object3D>, ProjectedCull>> culls;
    for (auto it = culls.begin(); it != culls.end();)
        it = it->second.first.expired() ? culls.erase(it) : std::next(it);
    auto& entry = culls[&root];
    if (entry.first.expired()) entry = {root.weak_from_this(), ProjectedCull{}};
    return entry.second;
}

// core's AutoBatch movement guard (auto-batch.ts) on the engine: each merged source's local state as it
// was merged, compared in place. A JS check reads each field across the bridge (a few microseconds a
// source, so 8,000 sources took 40 frames a lap); here a lap of the same fields costs nanoseconds a source.
struct SourceGuard {
    // position, quaternion, scale, visible, castShadow, receiveShadow, renderOrder, layers mask,
    // matrixAutoUpdate off, and the manual matrix when it is off: what core's `writeStamp` reads.
    struct Entry {
        std::weak_ptr<Object3D> owner;  // expired: the source was freed, which counts as a change
        Object3D* object = nullptr;
        const Mesh* mesh = nullptr;     // the cast, done once
        const Object3D* parent = nullptr;
        const void* geometry = nullptr;
        const void* material = nullptr;
        std::array<double, 15> lanes{};
        bool manual = false;
        std::array<double, 16> matrix{};
        bool out = false;
    };
    std::vector<Entry> entries;
    std::size_t cursor = 0;

    static void lanesOf(Object3D& object, std::array<double, 15>& into) {
        into = {object.position.x, object.position.y, object.position.z, object.quaternion.x,
                object.quaternion.y, object.quaternion.z, object.quaternion.w, object.scale.x,
                object.scale.y, object.scale.z, object.visible() ? 1.0 : 0.0, object.castShadow() ? 1.0 : 0.0,
                object.receiveShadow() ? 1.0 : 0.0, double(object.renderOrder()), object.layers().mask};
    }
    static void watch(Object3D& object, Entry& entry) {
        object.materializeLocalTransform();
        entry.owner = object.weak_from_this();
        entry.object = &object;
        entry.mesh = dynamic_cast<const Mesh*>(&object);
        entry.parent = object.parent;
        entry.geometry = entry.mesh ? entry.mesh->geometry.get() : nullptr;
        entry.material = entry.mesh ? entry.mesh->material.get() : nullptr;
        lanesOf(object, entry.lanes);
        entry.manual = !object.matrixAutoUpdate;
        if (entry.manual)
            for (std::size_t element = 0; element < 16; ++element) entry.matrix[element] = object.matrix.elements[element];
    }
    // As core's `!==`, except that a NaN held still is still.
    static bool held(double now, double then) { return now == then || (std::isnan(now) && std::isnan(then)); }
    /** Whether the source still holds the state it was watched with. */
    static bool same(const Entry& entry) {
        if (entry.owner.expired()) return false;
        Object3D& object = *entry.object;
        object.materializeLocalTransform();
        if (object.parent != entry.parent || object.matrixAutoUpdate == entry.manual) return false;
        if (entry.mesh && (entry.mesh->geometry.get() != entry.geometry || entry.mesh->material.get() != entry.material))
            return false;
        std::array<double, 15> lanes;
        lanesOf(object, lanes);
        for (std::size_t lane = 0; lane < lanes.size(); ++lane)
            if (!held(lanes[lane], entry.lanes[lane])) return false;
        if (entry.manual)
            for (std::size_t element = 0; element < 16; ++element)
                if (!held(object.matrix.elements[element], entry.matrix[element])) return false;
        return true;
    }
};

// The guard for an AutoBatch root, kept while the root lives, as projectedCullOf keeps the cull's.
SourceGuard& sourceGuardOf(Object3D& root) {
    static std::unordered_map<const Object3D*, std::pair<std::weak_ptr<Object3D>, SourceGuard>> guards;
    for (auto it = guards.begin(); it != guards.end();)
        it = it->second.first.expired() ? guards.erase(it) : std::next(it);
    auto& entry = guards[&root];
    if (entry.first.expired()) entry = {root.weak_from_this(), SourceGuard{}};
    return entry.second;
}

// three's graph events (`added`, `removed` on the child; `childadded`, `childremoved` with `child` on
// the parent), which the engine's own dispatcher fires from add, remove and attach. A language
// listens per object and type through tn_set_callback, as it does to AnimationMixer's events.
struct ObjectListeners {
    Store* store = nullptr;
    std::map<std::string, EventCallback, std::less<>> byType;
    static void dispatch(const tn::engine::Event& event, void* context) {
        auto& self = *static_cast<ObjectListeners*>(context);
        const auto found = self.byType.find(event.type);
        if (found == self.byType.end() || !found->second) return;
        std::string failure;
        try {
            std::vector<std::pair<std::string, Value>> fields{{"type", Value{Value::Kind::String, 0, std::string(event.type)}}};
            if (event.child != nullptr) fields.emplace_back("child", foundObject(*self.store, event.child));
            const EventCallback callback = found->second;  // a listener may replace itself
            (*callback)(Value::record(std::move(fields)), failure);
        } catch (const Unsupported& refused) {
            failure = refused.reason;
        }
        if (auto& pending = pendingListenerError(); !failure.empty() && pending.empty()) pending = std::move(failure);
    }
};

void registerEvents(ClassBinding& b, EventDispatcher* (*dispatcher)(void*), std::initializer_list<const char*> types) {
    for (const char* type : types) {
        b.events[type] = [type, dispatcher](void* self, EventCallback callback, Store& store) {
            auto* object = dispatcher(self);
            if (!object->languageListeners) {
                auto listeners = std::make_shared<ObjectListeners>();
                listeners->store = &store;
                object->languageListeners = listeners;
            }
            auto* listeners = static_cast<ObjectListeners*>(object->languageListeners.get());
            const bool listening = listeners->byType.contains(type);
            if (!callback) {
                if (listening) object->removeEventListener(type, &ObjectListeners::dispatch, listeners);
                listeners->byType.erase(type);
                return;
            }
            if (!listening) object->addEventListener(type, &ObjectListeners::dispatch, listeners);
            listeners->byType[type] = std::move(callback);
        };
    }
    // EventDispatcher's methods keep language functions, so the language adapter implements them over
    // `events`; called through the ABI they refuse rather than drop a listener.
    for (const char* name : {"addEventListener", "removeEventListener", "hasEventListener", "dispatchEvent"}) {
        b.methods[name] = [](void*, const Args&, Store&) -> Value {
            throw Unsupported{"TN_NATIVE_EVENT_LISTENER: the language adapter keeps EventDispatcher listeners"};
        };
    }
}

// core's host projection seam (renderProjection.ts): the verdict the native renderer's own batching gives a
// root, in one call per frame. It is projection::decide, the port of core's scanProjection, kept while the
// structure stamp it reads holds and re-judged on core's decline cadence (matrices move a verdict too: a
// mirrored or non-uniform rig leaves its batch). The renderer batches the root itself; this only reports it.
struct HostProjection {
    double stamp = -1;
    uint64_t hierarchy = ~uint64_t(0);
    int minMeshes = -1;
    int sinceDecide = 0;
    projection::Decision decision;
};

HostProjection& hostProjectionOf(Object3D& root) {
    static std::unordered_map<const Object3D*, std::pair<std::weak_ptr<Object3D>, HostProjection>> roots;
    for (auto it = roots.begin(); it != roots.end();)
        it = it->second.first.expired() ? roots.erase(it) : std::next(it);
    auto& entry = roots[&root];
    if (entry.first.expired()) entry = {root.weak_from_this(), HostProjection{}};
    return entry.second;
}

Value hostProjectionReport(Object3D& root, int minMeshes) {
    constexpr int kDeclineRescanFrames = 60;  // core's DECLINE_RESCAN_FRAMES
    HostProjection& host = hostProjectionOf(root);
    // Walking 4,096 cubes to hash them costs more than the rest of the call: skip it while nothing in the
    // process was added, removed or attached, and let the cadence catch a geometry or material swap.
    const uint64_t hierarchy = Object3D::hierarchyVersion();
    const bool settled = hierarchy == host.hierarchy && minMeshes == host.minMeshes && host.sinceDecide + 1 < kDeclineRescanFrames;
    using Walks = projection::WalkCounters;
    Walks& walks = projection::walkCounters(projection::WalkCaller::HostReport);
    if (settled) {
        ++host.sinceDecide;
    } else {
        uint64_t& nodes = projection::walkedNodes();
        const uint64_t before = nodes;
        const double stamp = projection::structureStamp(root);
        ++walks.stampWalks;
        walks.stampNodes += nodes - before;
        ++walks.stampBy[hierarchy != host.hierarchy ? Walks::Hierarchy : minMeshes != host.minMeshes ? Walks::MinMeshes : Walks::Cadence];
        if (stamp != host.stamp || minMeshes != host.minMeshes || ++host.sinceDecide >= kDeclineRescanFrames) {
            ++walks.decideBy[stamp != host.stamp ? Walks::Structure : minMeshes != host.minMeshes ? Walks::MinMeshes : Walks::Cadence];
            const uint64_t at = nodes;
            host.decision = projection::decide(root, minMeshes);
            ++walks.decideWalks;
            walks.decideNodes += nodes - at;
            host.stamp = stamp;
            host.minMeshes = minMeshes;
            host.sinceDecide = 0;
        }
        host.hierarchy = hierarchy;
    }
    projection::countWalkCall(projection::WalkCaller::HostReport);
    const projection::Decision& d = host.decision;
    std::vector<std::pair<std::string, Value>> exact;
    for (const auto& [reason, count] : d.exact) exact.emplace_back(reason, Value::of(double(count)));
    if (!d.cause.empty())
        return Value::record({{"projecting", Value::of(d.projecting)},
                              {"reasonCode", Value{Value::Kind::String, 0, d.reasonCode}},
                              {"sourceRenderables", Value::of(double(d.sourceRenderables))},
                              {"projectedObjects", Value::of(0.0)},
                              {"instancedBatches", Value::of(0.0)},
                              {"materialBatches", Value::of(0.0)},
                              {"skinnedBatches", Value::of(0.0)},
                              {"exactObjects", Value::of(0.0)},
                              {"exact", Value::record({})},
                              {"cause", Value{Value::Kind::String, 0, d.cause}},
                              {"causeMeshes", Value::of(double(d.causeMeshes))}});
    return Value::record({{"projecting", Value::of(d.projecting)},
                          {"reasonCode", Value{Value::Kind::String, 0, d.reasonCode}},
                          {"sourceRenderables", Value::of(double(d.sourceRenderables))},
                          {"projectedObjects", Value::of(double(d.projectedObjects))},
                          {"instancedBatches", Value::of(double(d.instancedBatches))},
                          {"materialBatches", Value::of(double(d.materialBatches))},
                          {"skinnedBatches", Value::of(double(d.skinnedBatches))},
                          {"exactObjects", Value::of(double(d.exactObjects))},
                          {"exact", Value::record(std::move(exact))}});
}

void registerObject3D(ClassBinding& b) {
    b.members["parent"] = [](void* self, const Args&, Store& store) {
        return foundObject(store, as<Object3D>(self)->parent);
    };
    // three's `children`, as a fresh array of the attached objects in order (PRD-540). It is read
    // only: add, remove and attach change the graph, as three's own code does.
    b.members["children"] = [](void* self, const Args&, Store& store) {
        Args children;
        for (Object3D* child : as<Object3D>(self)->children) children.push_back(foundObject(store, child));
        return Value::array(std::move(children));
    };
    // Engine-internal (`__`: never three's surface): the subtree in three's traverse order, or only its
    // visible part, as one array. Both back ends' `traverse`/`traverseVisible` call their callback
    // over it, so a walk costs one crossing, not two per object (children and visible).
    // ponytail: a snapshot; an object a callback adds or removes mid-walk is not revisited, as three's
    // live walk would. Walk live if a game depends on it.
    // `__walk(visibleOnly, withParents)`: with parents, each object is followed by its parent's index
    // in the walk (-1 when the parent is outside it), so a back end learns every `parent` it walked.
    b.methods["__walk"] = [](void* self, const Args& a, Store& store) {
        std::vector<Object3D*> objects;
        const auto collect = [](Object3D& object, void* out) { static_cast<std::vector<Object3D*>*>(out)->push_back(&object); };
        if (boolean(a, 0, false)) as<Object3D>(self)->traverseVisible(collect, &objects);
        else as<Object3D>(self)->traverse(collect, &objects);
        const bool withParents = boolean(a, 1, false);
        std::unordered_map<const Object3D*, double> index;
        if (withParents) index.reserve(objects.size());
        Args walked;
        walked.reserve(objects.size() * (withParents ? 2 : 1));
        for (Object3D* object : objects) {
            walked.push_back(foundObject(store, object));
            if (!withParents) continue;
            const auto parent = index.find(object->parent);
            walked.push_back(Value::of(parent == index.end() ? -1.0 : parent->second));
            index.emplace(object, double(index.size()));
        }
        return Value::array(std::move(walked));
    };
    // Engine-internal: core's projected-size cull in one call (scene/projected_cull.h), its state kept
    // per root. `__cullProjected(camera, cameraResolved, scale, minimumPixels, enabled)` hides this
    // frame's sub-threshold objects and returns core's counters in report order; `__restoreCull()`
    // shows them again, after the host's draw when it holds restores.
    // `__alwaysRender` mirrors core's alwaysRender() marker.
    b.methods["__cullProjected"] = [](void* self, const Args& a, Store& store) {
        auto* camera = dynamic_cast<Camera*>(&objectArg(store, a.at(0)));
        if (camera == nullptr) throw Unsupported{"__cullProjected needs a camera"};
        const ProjectedCull::Report r = projectedCullOf(*as<Object3D>(self))
            .apply(*as<Object3D>(self), *camera, flag(a.at(1)), number(a.at(2)), number(a.at(3)), flag(a.at(4)));
        Args counts;
        for (const uint32_t count : {r.considered, r.culled, r.cameraAttached, r.marked, r.shadowCasters, r.withoutBounds,
                                     r.dynamicBounds, r.frustumCulled})
            counts.push_back(Value::of(double(count)));
        return Value::array(std::move(counts));
    };
    // Engine-internal: core's AutoBatch guard. `__tnGuardWatch(sources)` replaces the watched list with
    // each source's state now; `__tnGuardCheck(limit)` compares up to `limit` sources from where the last
    // check stopped and answers the indices that changed, which it stops watching.
    b.methods["__tnGuardWatch"] = [](void* self, const Args& a, Store& store) {
        SourceGuard& guard = sourceGuardOf(*as<Object3D>(self));
        guard.entries.clear();
        guard.cursor = 0;
        for (const Value& ref : refsOf(a.at(0))) {
            SourceGuard::Entry entry;
            SourceGuard::watch(objectArg(store, ref), entry);
            guard.entries.push_back(std::move(entry));
        }
        return Value::of(double(guard.entries.size()));
    };
    b.methods["__tnGuardCheck"] = [](void* self, const Args& a, Store&) {
        SourceGuard& guard = sourceGuardOf(*as<Object3D>(self));
        std::vector<double> changed;
        const std::size_t count = guard.entries.size();
        const double limit = number(a.at(0));
        const std::size_t checks = count == 0 ? 0 : limit >= double(count) ? count : limit > 0 ? std::size_t(limit) : 0;
        for (std::size_t checked = 0; checked < checks; ++checked) {
            SourceGuard::Entry& entry = guard.entries[guard.cursor];
            const std::size_t index = guard.cursor;
            guard.cursor = (guard.cursor + 1) % count;
            if (entry.out || SourceGuard::same(entry)) continue;
            entry.out = true;
            changed.push_back(double(index));
        }
        return Value::list(std::move(changed));
    };
    b.methods["__restoreCull"] = [](void* self, const Args&, Store&) {
        projectedCullOf(*as<Object3D>(self)).restoreAfterDraw();
        return Value{};
    };
    b.getters["__alwaysRender"] = [](void* self) { return Value::of(as<Object3D>(self)->alwaysRender); };
    b.setters["__alwaysRender"] = [](void* self, const Value& v) { as<Object3D>(self)->alwaysRender = flag(v); };
    b.callbacks["onBeforeRender"] = [](void* self, RenderCallback callback) {
        as<Object3D>(self)->onBeforeRender = std::move(callback);
    };
    b.methods["getObjectById"] = [](void* self, const Args& a, Store& store) {
        // An id is a safe non-negative integer; anything else names no object (`undefined` in three).
        const double id = number(a.at(0));
        if (!(id >= 0 && id <= 9007199254740991.0) || id != std::floor(id)) return Value::undefined();
        Object3D* found = as<Object3D>(self)->getObjectById(static_cast<uint64_t>(id));
        return found ? foundObject(store, found) : Value::undefined();
    };
    b.methods["getObjectByName"] = [](void* self, const Args& a, Store& store) {
        if (a.at(0).kind != Value::Kind::String) throw Unsupported{"getObjectByName needs a name"};
        Object3D* found = as<Object3D>(self)->getObjectByName(a.at(0).text);
        return found ? foundObject(store, found) : Value::undefined();
    };
    b.ctor = [](const Args&, Store&) { return makeNode(); };

    // The renderer's flat inputs. Every setter that bumps `revision` is one of these.
    b.getters["visible"] = [](void* self) { return Value::of(as<Object3D>(self)->visible()); };
    b.setters["visible"] = [](void* self, const Value& v) { as<Object3D>(self)->setVisible(flag(v)); };
    // Games set `visible` every frame, and the shadow flags on every mesh while they load; the Wasm
    // back end reads each byte and skips an unchanged set.
    const Object3D::FlagOffsets flags = Object3D::flagOffsets();
    b.fields["visible"] = {flags.visible, 0};
    b.fields["castShadow"] = {flags.castShadow, 0};
    b.fields["receiveShadow"] = {flags.receiveShadow, 0};
    // The flags sit after pointers, so they count from the first flag: the registry is dumped by a
    // 64-bit build and read by the 32-bit Wasm one.
    b.getters["__address"] = [](void* self) { return Value::of(double(reinterpret_cast<uintptr_t>(as<Object3D>(self)->flags()))); };
    // Every kept member's `__address` in one call: the Wasm back end asks once per object, not per member.
    b.getters["__addresses"] = [](void* self) {
        auto* o = as<Object3D>(self);
        Object3D::transformTrackingAddress(&o->position)[2] = 1;
        const auto at = [](const void* member) { return Value::of(double(reinterpret_cast<uintptr_t>(member))); };
        Object3D::prepareTransformView(&o->matrixWorld);
        return Value::record({{"__address", at(o->flags())}, {"position", at(&o->positionValue())}, {"rotation", at(&o->rotationValue())},
            {"quaternion", at(&o->quaternionValue())}, {"scale", at(&o->scaleValue())},
            {"up", at(&o->up)}, {"matrix", at(&o->matrixValue())}, {"matrixWorld", at(&o->matrixWorldValue())},
            {"layers", at(&o->layers())}});
    };
    // Engine-internal: the count of adds, removes, attaches and destroys at or under this object. Core keeps a
    // walk that only finds who is under whom (the camera pass's rig and camera-part sets) while it holds still.
    b.getters["__hierarchyRevision"] = [](void* self) { return Value::of(double(as<Object3D>(self)->subtreeVersion())); };
    // Engine-internal: the process-wide count of world-matrix composes. A playtest reads it per frame, so a
    // walk that composes nodes nothing draws (a hidden batch source) fails its bound.
    b.getters["__matrixEvaluations"] = [](void*) { return Value::of(double(Object3D::matrixEvaluations())); };
    // Engine-internal, PRD-752: the job pool's shared runs and their items, process-wide, so a playtest bounds
    // jobs per frame; both stay 0 on a build or a page with no pool threads.
    b.getters["__jobPoolRuns"] = [](void*) { return Value::of(double(JobPool::runs())); };
    b.getters["__jobPoolItems"] = [](void*) { return Value::of(double(JobPool::items())); };
    b.getters["castShadow"] = [](void* self) { return Value::of(as<Object3D>(self)->castShadow()); };
    b.setters["castShadow"] = [](void* self, const Value& v) { as<Object3D>(self)->setCastShadow(flag(v)); };
    b.getters["receiveShadow"] = [](void* self) { return Value::of(as<Object3D>(self)->receiveShadow()); };
    b.setters["receiveShadow"] = [](void* self, const Value& v) { as<Object3D>(self)->setReceiveShadow(flag(v)); };
    b.getters["frustumCulled"] = [](void* self) { return Value::of(as<Object3D>(self)->frustumCulled); };
    b.setters["frustumCulled"] = [](void* self, const Value& v) { as<Object3D>(self)->frustumCulled = flag(v); };
    b.getters["renderOrder"] = [](void* self) { return Value::of(double(as<Object3D>(self)->renderOrder())); };
    b.setters["renderOrder"] = [](void* self, const Value& v) {
        as<Object3D>(self)->setRenderOrder(static_cast<int>(number(v)));
    };
    b.getters["layers.mask"] = [](void* self) { return Value::of(double(as<Object3D>(self)->layers().mask)); };
    b.setters["layers.mask"] = [](void* self, const Value& v) {
        as<Object3D>(self)->setLayerMask(number(v));
    };
    b.getters["matrixAutoUpdate"] = [](void* self) { return Value::of(as<Object3D>(self)->matrixAutoUpdate); };
    b.setters["matrixAutoUpdate"] = [](void* self, const Value& v) {
        as<Object3D>(self)->prepareLocalTransformWrite();
        as<Object3D>(self)->matrixAutoUpdate = flag(v);
        as<Object3D>(self)->markLocalTransformDirty();
    };
    b.getters["matrixWorldAutoUpdate"] = [](void* self) { return Value::of(as<Object3D>(self)->matrixWorldAutoUpdate); };
    b.setters["matrixWorldAutoUpdate"] = [](void* self, const Value& v) {
        as<Object3D>(self)->prepareLocalTransformWrite();
        as<Object3D>(self)->matrixWorldAutoUpdate = flag(v);
        as<Object3D>(self)->markLocalTransformDirty();
    };
    b.getters["static"] = [](void* self) { return Value::of(as<Object3D>(self)->isStatic); };
    b.setters["static"] = [](void* self, const Value& v) { as<Object3D>(self)->isStatic = flag(v); };
    b.getters["matrixWorldNeedsUpdate"] = [](void* self) { return Value::of(as<Object3D>(self)->matrixWorldNeedsUpdate); };
    b.setters["matrixWorldNeedsUpdate"] = [](void* self, const Value& v) {
        as<Object3D>(self)->prepareLocalTransformWrite();
        as<Object3D>(self)->matrixWorldNeedsUpdate = flag(v);
        as<Object3D>(self)->markLocalTransformDirty();
    };
    b.getters["id"] = [](void* self) { return Value::of(double(as<Object3D>(self)->id())); };
    b.getters["uuid"] = [](void* self) { return Value{Value::Kind::String, 0, as<Object3D>(self)->uuid}; };
    b.setters["uuid"] = [](void* self, const Value& v) {
        if (v.kind != Value::Kind::String) throw Unsupported{"uuid must be a string"};
        as<Object3D>(self)->uuid = v.text;
    };
    b.getters["revision"] = [](void* self) { return Value::of(double(as<Object3D>(self)->revision())); };
    // The process-wide hierarchy counter's address: the Wasm back end keeps `children` and `parent` until it moves.
    b.getters["__hierarchy"] = [](void*) {
        return Value::of(double(reinterpret_cast<uintptr_t>(Object3D::hierarchyVersionAddress())));
    };
    // The engine's running work counts as "name@address,...": the Wasm back end reads each total's low
    // word in place every frame, so core's TN_FRAME_BUDGET.counters.engine costs no crossing (PRD-748).
    b.setters["__debugTelemetry"] = [](void*, const Value& value) {
        tn::engine::waste::setDebugEnabled(flag(value));
    };
    b.getters["__engineCounters"] = [](void*) {
        auto& w = tn::engine::waste::counters();
        const std::pair<const char*, const void*> totals[] = {
            {"contentClassOf", &w.contentClassCalls}, {"contentVersionKeys", &w.contentVersionKeys},
            {"classify", &w.classifies},              {"share", &w.shareCalls},
            {"shareHits", &w.shareHits},              {"shareMints", &w.shareMints},
            {"buffers", &w.bufferAllocs},             {"textures", &w.textureAllocs},
            {"matrixEvaluations", &Object3D::matrixEvaluations_}};
        std::string text;
        for (const auto& [name, address] : totals) {
            if (!text.empty()) text += ',';
            text += name;
            text += '@';
            text += std::to_string(reinterpret_cast<uintptr_t>(address));
        }
        if (tn::engine::waste::debugEnabled().load(std::memory_order_relaxed)) {
#define TN_COUNTER_ADDRESS(name) text += "," #name "@" + std::to_string(reinterpret_cast<uintptr_t>(&w.name));
            TN_DEBUG_COUNTERS(TN_COUNTER_ADDRESS)
#undef TN_COUNTER_ADDRESS
        }
        return Value{Value::Kind::String, 0, text};
    };
    b.getters["type"] = [](void* self) {
        return Value{Value::Kind::String, 0, std::string(as<Object3D>(self)->type())};
    };
    b.getters["name"] = [](void* self) { return Value{Value::Kind::String, 0, as<Object3D>(self)->name}; };
    b.setters["name"] = [](void* self, const Value& v) { as<Object3D>(self)->name = v.text; };

    nestedVector<Object3D>(b, "position", &Object3D::positionValue);
    nestedVector<Object3D>(b, "scale", &Object3D::scaleValue);
    nestedVector<Object3D>(b, "up", &Object3D::up);
    nestedQuaternion<Object3D>(b, "quaternion", &Object3D::quaternionValue);
    nestedMatrix<Object3D>(b, "matrix", &Object3D::matrixValue);
    nestedMatrix<Object3D>(b, "matrixWorld", &Object3D::matrixWorldValue);
    for (int i = 0; i < 3; ++i) {
        const std::string path = std::string("rotation.") + "xyz"[i];
        b.getters[path] = [i](void* self) { as<Object3D>(self)->materializeLocalTransform(); return Value::of(as<Object3D>(self)->rotation.toArray()[i]); };
        // As three's Euler setters: write the component, then sync the quaternion through notify().
        b.setters[path] = [i](void* self, const Value& v) {
            as<Object3D>(self)->prepareLocalTransformWrite();
            Euler& rotation = as<Object3D>(self)->rotation;
            (i == 0 ? rotation.x : i == 1 ? rotation.y : rotation.z) = number(v);
            rotation.notify();
        };
    }
    // `pivot` is `null` in three until something sets it, and the protocol's `set` carries one value,
    // so there is no way to make it non-null through a binding: a C++ caller assigns the member. Both
    // directions therefore refuse while it is null, rather than inventing a zero pivot.
    for (int i = 0; i < 3; ++i) {
        const std::string path = std::string("pivot.") + "xyz"[i];
        b.getters[path] = [i](void* self) {
            const std::optional<Vector3>& pivot = as<Object3D>(self)->pivot;
            if (!pivot.has_value()) throw Unsupported{"this Object3D has no pivot"};
            return Value::of(component3(*pivot, i));
        };
        b.setters[path] = [i](void* self, const Value& v) {
            std::optional<Vector3>& pivot = as<Object3D>(self)->pivot;
            if (!pivot.has_value()) throw Unsupported{"this Object3D has no pivot"};
            as<Object3D>(self)->prepareLocalTransformWrite();
            setComponent3(*pivot, i, number(v));
            as<Object3D>(self)->markLocalTransformDirty();
        };
    }
    b.getters["rotation.order"] = [](void* self) {
        static const char* const kNames[] = {"XYZ", "YXZ", "ZXY", "ZYX", "YZX", "XZY"};
        as<Object3D>(self)->materializeLocalTransform();
        const Euler& rotation = as<Object3D>(self)->rotation;
        return Value{Value::Kind::String, 0,
                     std::string(kNames[static_cast<int>(rotation.order)])};
    };
    b.setters["rotation.order"] = [](void* self, const Value& v) {
        static const char* const kNames[] = {"XYZ", "YXZ", "ZXY", "ZYX", "YZX", "XZY"};
        as<Object3D>(self)->prepareLocalTransformWrite();
        Euler& rotation = as<Object3D>(self)->rotation;
        for (int i = 0; i < 6; ++i) {
            if (v.kind == Value::Kind::String && v.text == kNames[i]) {
                rotation.order = static_cast<EulerOrder>(i);
                rotation.notify();  // three's order setter re-syncs the quaternion
                return;
            }
        }
        throw Unsupported{"unknown Euler order"};
    };

    // The members themselves, as Refs to the members.
    fixedMember(b, "layers", [](void* self, const Args&, Store& store) {
        return memberAlias(store, self, const_cast<Layers&>(as<Object3D>(self)->layers()), "Layers");
    });
    fixedMember(b, "position", memberAliasMethod(&Object3D::positionValue, "Vector3"));
    fixedMember(b, "scale", memberAliasMethod(&Object3D::scaleValue, "Vector3"));
    fixedMember(b, "up", memberAliasMethod(&Object3D::up, "Vector3"));
    fixedMember(b, "quaternion", memberAliasMethod(&Object3D::quaternionValue, "Quaternion"));
    fixedMember(b, "rotation", memberAliasMethod(&Object3D::rotationValue, "Euler"));
    fixedMember(b, "matrix", memberAliasMethod(&Object3D::matrixValue, "Matrix4"));
    fixedMember(b, "matrixWorld", memberAliasMethod(&Object3D::matrixWorldValue, "Matrix4"));

    // Transforms.
    // three's add(...objects) and remove(...objects) take every argument (PRD-540).
    b.methods["add"] = [](void* self, const Args& a, Store& store) {
        (void)a.at(0);  // no object is an invalid argument, as before
        for (const Value& object : a) as<Object3D>(self)->add(objectArg(store, object));
        return chain();
    };
    b.methods["remove"] = [](void* self, const Args& a, Store& store) {
        (void)a.at(0);
        for (const Value& object : a) as<Object3D>(self)->remove(objectArg(store, object));
        return chain();
    };
    b.methods["attach"] = [](void* self, const Args& a, Store& store) {
        as<Object3D>(self)->attach(objectArg(store, a.at(0)));
        return chain();
    };
    // three's clone(recursive = true): the copy as its own class, meshes sharing their resources.
    b.methods["clone"] = [](void* self, const Args& a, Store& store) {
        std::string error;
        std::shared_ptr<Object3D> copy = cloneObject(*as<Object3D>(self), boolean(a, 0, true), error);
        if (!copy) throw Unsupported{error};
        const std::string type(copy->type());
        return store.adopt(type, std::static_pointer_cast<void>(copy));
    };
    b.methods["removeFromParent"] = [](void* self, const Args&, Store&) {
        as<Object3D>(self)->removeFromParent();
        return chain();
    };
    b.methods["clear"] = [](void* self, const Args&, Store&) {
        as<Object3D>(self)->clear();
        return chain();
    };
    // core's projection-stability proof asks for this where it exists; three has no such method.
    b.methods["__tnStructureStamp"] = [](void* self, const Args&, Store&) {
        return Value::of(projection::structureStamp(*as<Object3D>(self)));
    };
    // core's SceneRenderProjection asks for this where it exists, instead of building a mirror: the native
    // renderer batches this scene itself, so one call answers what that batching will make of it.
    // `__tnProjectionReport(minMeshes)`: { projecting, reasonCode, sourceRenderables, projectedObjects, ... }.
    b.methods["__tnProjectionReport"] = [](void* self, const Args& a, Store&) {
        return hostProjectionReport(*as<Object3D>(self), a.empty() ? 200 : int(number(a.at(0))));
    };
    // The same, for projection-apply's "does the game want this drawn": every ancestor's flag in one
    // call, where the script walk costs a call and a wrapper per level.
    b.methods["__tnVisibleInWorld"] = [](void* self, const Args&, Store&) {
        for (const Object3D* node = as<Object3D>(self); node != nullptr; node = node->parent)
            if (!node->visible()) return Value::of(false);
        return Value::of(true);
    };
    // core's MatrixWorldPass asks for this where it exists: its walk in one call instead of a call per node.
    // `__tnUpdateMatrixWorld(force, prune)` answers the nodes it visited; with `prune` (core's "visible" mode) a
    // hidden subtree waits for the frame it shows (Object3D::updateMatrixWorldVisible).
    b.methods["__tnUpdateMatrixWorld"] = [](void* self, const Args& a, Store&) {
        return Value::of(double(as<Object3D>(self)->updateMatrixWorldVisibleJobs(boolean(a, 0, false), boolean(a, 1, false))));
    };
    // Read current world values without leasing the source's live transform view.
    b.methods["__tnCopyMatrixWorld"] = [](void* self, const Args& a, Store& store) {
        auto& target = store.ref<Matrix4>(a.at(0), "Matrix4");
        auto& source = *as<Object3D>(self);
        source.joinDeferredWorldTransform();
        Object3D::prepareTransformView(&target);
        target.copy(source.matrixWorld);
        return Value{};
    };
    b.methods["updateMatrix"] = [](void* self, const Args&, Store&) {
        as<Object3D>(self)->updateMatrix();
        return chain();
    };
    b.methods["updateMatrixWorld"] = [](void* self, const Args& a, Store&) {
        as<Object3D>(self)->updateMatrixWorld(boolean(a, 0, false));
        return chain();
    };
    b.methods["updateWorldMatrix"] = [](void* self, const Args& a, Store&) {
        as<Object3D>(self)->updateWorldMatrix(boolean(a, 0, false), boolean(a, 1, false),
                                               boolean(a, 2, false));
        return chain();
    };
    b.methods["applyMatrix4"] = [](void* self, const Args& a, Store& store) {
        as<Object3D>(self)->applyMatrix4(store.ref<Matrix4>(a.at(0), "Matrix4"));
        return chain();
    };
    b.methods["applyQuaternion"] = [](void* self, const Args& a, Store& store) {
        as<Object3D>(self)->applyQuaternion(store.ref<Quaternion>(a.at(0), "Quaternion"));
        return chain();
    };
    b.methods["setRotationFromAxisAngle"] = [](void* self, const Args& a, Store& store) {
        as<Object3D>(self)->setRotationFromAxisAngle(store.ref<Vector3>(a.at(0), "Vector3"),
                                                    number(a.at(1)));
        return chain();
    };
    b.methods["setRotationFromEuler"] = [](void* self, const Args& a, Store& store) {
        as<Object3D>(self)->setRotationFromEuler(store.ref<Euler>(a.at(0), "Euler"));
        return chain();
    };
    b.methods["setRotationFromMatrix"] = [](void* self, const Args& a, Store& store) {
        as<Object3D>(self)->setRotationFromMatrix(store.ref<Matrix4>(a.at(0), "Matrix4"));
        return chain();
    };
    b.methods["setRotationFromQuaternion"] = [](void* self, const Args& a, Store& store) {
        as<Object3D>(self)->setRotationFromQuaternion(store.ref<Quaternion>(a.at(0), "Quaternion"));
        return chain();
    };
    b.methods["rotateOnAxis"] = [](void* self, const Args& a, Store& store) {
        as<Object3D>(self)->rotateOnAxis(store.ref<Vector3>(a.at(0), "Vector3"), number(a.at(1)));
        return chain();
    };
    b.methods["rotateOnWorldAxis"] = [](void* self, const Args& a, Store& store) {
        as<Object3D>(self)->rotateOnWorldAxis(store.ref<Vector3>(a.at(0), "Vector3"), number(a.at(1)));
        return chain();
    };
    b.methods["rotateX"] = [](void* self, const Args& a, Store&) {
        as<Object3D>(self)->rotateX(number(a.at(0)));
        return chain();
    };
    b.methods["rotateY"] = [](void* self, const Args& a, Store&) {
        as<Object3D>(self)->rotateY(number(a.at(0)));
        return chain();
    };
    b.methods["rotateZ"] = [](void* self, const Args& a, Store&) {
        as<Object3D>(self)->rotateZ(number(a.at(0)));
        return chain();
    };
    b.methods["translateOnAxis"] = [](void* self, const Args& a, Store& store) {
        as<Object3D>(self)->translateOnAxis(store.ref<Vector3>(a.at(0), "Vector3"), number(a.at(1)));
        return chain();
    };
    b.methods["translateX"] = [](void* self, const Args& a, Store&) {
        as<Object3D>(self)->translateX(number(a.at(0)));
        return chain();
    };
    b.methods["translateY"] = [](void* self, const Args& a, Store&) {
        as<Object3D>(self)->translateY(number(a.at(0)));
        return chain();
    };
    b.methods["translateZ"] = [](void* self, const Args& a, Store&) {
        as<Object3D>(self)->translateZ(number(a.at(0)));
        return chain();
    };
    b.methods["localToWorld"] = [](void* self, const Args& a, Store& store) {
        as<Object3D>(self)->localToWorld(store.ref<Vector3>(a.at(0), "Vector3"));
        return a.at(0);  // three answers the vector it converted, not the object
    };
    b.methods["worldToLocal"] = [](void* self, const Args& a, Store& store) {
        as<Object3D>(self)->worldToLocal(store.ref<Vector3>(a.at(0), "Vector3"));
        return a.at(0);  // three answers the vector it converted, not the object
    };
    b.methods["lookAt"] = [](void* self, const Args& a, Store& store) {
        if (a.at(0).kind == Value::Kind::Ref) {
            as<Object3D>(self)->lookAt(store.ref<Vector3>(a.at(0), "Vector3"));
        } else {
            as<Object3D>(self)->lookAt(number(a.at(0)), number(a.at(1)), number(a.at(2)));
        }
        return chain();
    };
    b.methods["getWorldPosition"] = [](void* self, const Args& a, Store& store) {
        as<Object3D>(self)->getWorldPosition(store.ref<Vector3>(a.at(0), "Vector3"));
        return a.at(0);
    };
    b.methods["getWorldQuaternion"] = [](void* self, const Args& a, Store& store) {
        as<Object3D>(self)->getWorldQuaternion(store.ref<Quaternion>(a.at(0), "Quaternion"));
        return a.at(0);
    };
    b.methods["getWorldScale"] = [](void* self, const Args& a, Store& store) {
        as<Object3D>(self)->getWorldScale(store.ref<Vector3>(a.at(0), "Vector3"));
        return a.at(0);
    };
    b.methods["getWorldDirection"] = [](void* self, const Args& a, Store& store) {
        as<Object3D>(self)->getWorldDirection(store.ref<Vector3>(a.at(0), "Vector3"));
        return a.at(0);
    };
    b.methods["copy"] = [](void* self, const Args& a, Store& store) {
        as<Object3D>(self)->copy(objectArg(store, a.at(0)));
        return chain();
    };
    registerEvents(b, [](void* self) -> EventDispatcher* { return as<Object3D>(self); },
                   {"added", "removed", "childadded", "childremoved"});
}

// ----------------------------------------------------------------------------- Camera

/** The members and inputs both cameras share. */
void registerCameraCommon(ClassBinding& b) {
    b.getters["coordinateSystem"] = [](void* self) {
        return Value::of(static_cast<double>(as<Camera>(self)->coordinateSystem));
    };
    b.setters["coordinateSystem"] = [](void* self, const Value& value) {
        const double system = number(value);
        if (system != static_cast<int>(CoordinateSystem::WebGL) && system != static_cast<int>(CoordinateSystem::WebGPU))
            throw Unsupported{"unknown coordinate system"};
        as<Camera>(self)->coordinateSystem = static_cast<CoordinateSystem>(static_cast<int>(system));
    };
    b.getters["reversedDepth"] = [](void* self) { return Value::of(as<Camera>(self)->reversedDepth()); };
    nestedMatrix<Camera>(b, "projectionMatrix", &Camera::projectionMatrix);
    nestedMatrix<Camera>(b, "projectionMatrixInverse", &Camera::projectionMatrixInverse);
    nestedMatrix<Camera>(b, "matrixWorldInverse", &Camera::matrixWorldInverse);
    fixedMember(b, "projectionMatrix", memberAliasMethod(&Camera::projectionMatrix, "Matrix4"));
    fixedMember(b, "projectionMatrixInverse", memberAliasMethod(&Camera::projectionMatrixInverse, "Matrix4"));
    fixedMember(b, "matrixWorldInverse", memberAliasMethod(&Camera::matrixWorldInverse, "Matrix4"));
    // `setViewOffset` and `clearViewOffset` are registered per concrete class, because only
    // PerspectiveCamera's `setViewOffset` also writes `aspect`.
}

/** The six view-offset numbers both cameras take. */
Args viewOffsetArgs(const Args& a) {
    if (a.size() < 6) throw Unsupported{"setViewOffset needs fullWidth, fullHeight, x, y, width, height"};
    return a;
}

void registerCamera(ClassBinding& b) {
    registerObject3D(b);
    registerCameraCommon(b);
    b.ctor = [](const Args&, Store&) {
        return std::static_pointer_cast<void>(std::make_shared<Camera>());
    };
}

void registerPerspectiveCamera(ClassBinding& b) {
    registerCamera(b);
    b.ctor = [](const Args& a, Store&) {
        return std::static_pointer_cast<void>(std::make_shared<PerspectiveCamera>(
            optional(a, 0, 50), optional(a, 1, 1), optional(a, 2, 0.1), optional(a, 3, 2000)));
    };
    const std::pair<const char*, double PerspectiveCamera::*> kScalars[] = {
        {"fov", &PerspectiveCamera::fov},         {"zoom", &PerspectiveCamera::zoom},
        {"near", &PerspectiveCamera::near},       {"far", &PerspectiveCamera::far},
        {"focus", &PerspectiveCamera::focus},     {"aspect", &PerspectiveCamera::aspect},
        {"filmGauge", &PerspectiveCamera::filmGauge},
        {"filmOffset", &PerspectiveCamera::filmOffset},
    };
    for (const auto& [name, field] : kScalars) {
        b.getters[name] = [field](void* self) { return Value::of(as<PerspectiveCamera>(self)->*field); };
        b.setters[name] = [field](void* self, const Value& v) {
            as<PerspectiveCamera>(self)->*field = number(v);
        };
    }
    b.methods["updateProjectionMatrix"] = [](void* self, const Args&, Store&) {
        as<PerspectiveCamera>(self)->updateProjectionMatrix();
        return chain();
    };
    b.methods["setViewOffset"] = [](void* self, const Args& a, Store&) {
        const Args six = viewOffsetArgs(a);
        as<PerspectiveCamera>(self)->setViewOffset(number(six.at(0)), number(six.at(1)), number(six.at(2)),
                                                    number(six.at(3)), number(six.at(4)), number(six.at(5)));
        return chain();
    };
    b.methods["clearViewOffset"] = [](void* self, const Args&, Store&) {
        as<PerspectiveCamera>(self)->clearViewOffset();
        return chain();
    };
    b.methods["setFocalLength"] = [](void* self, const Args& a, Store&) {
        as<PerspectiveCamera>(self)->setFocalLength(number(a.at(0)));
        return chain();
    };
    b.methods["getFocalLength"] = [](void* self, const Args&, Store&) {
        return Value::of(as<PerspectiveCamera>(self)->getFocalLength());
    };
    b.methods["getEffectiveFOV"] = [](void* self, const Args&, Store&) {
        return Value::of(as<PerspectiveCamera>(self)->getEffectiveFOV());
    };
    b.methods["getFilmWidth"] = [](void* self, const Args&, Store&) {
        return Value::of(as<PerspectiveCamera>(self)->getFilmWidth());
    };
    b.methods["getFilmHeight"] = [](void* self, const Args&, Store&) {
        return Value::of(as<PerspectiveCamera>(self)->getFilmHeight());
    };
    b.methods["getViewSize"] = [](void* self, const Args& a, Store& store) {
        as<PerspectiveCamera>(self)->getViewSize(number(a.at(0)),
                                                  store.ref<Vector2>(a.at(1), "Vector2"));
        return chain();
    };
}

void registerOrthographicCamera(ClassBinding& b) {
    registerCamera(b);
    b.ctor = [](const Args& a, Store&) {
        return std::static_pointer_cast<void>(std::make_shared<OrthographicCamera>(
            optional(a, 0, -1), optional(a, 1, 1), optional(a, 2, 1), optional(a, 3, -1),
            optional(a, 4, 0.1), optional(a, 5, 2000)));
    };
    const std::pair<const char*, double OrthographicCamera::*> kScalars[] = {
        {"zoom", &OrthographicCamera::zoom},       {"left", &OrthographicCamera::left},
        {"right", &OrthographicCamera::right},     {"top", &OrthographicCamera::top},
        {"bottom", &OrthographicCamera::bottom},   {"near", &OrthographicCamera::near},
        {"far", &OrthographicCamera::far},
    };
    for (const auto& [name, field] : kScalars) {
        b.getters[name] = [field](void* self) { return Value::of(as<OrthographicCamera>(self)->*field); };
        b.setters[name] = [field](void* self, const Value& v) {
            as<OrthographicCamera>(self)->*field = number(v);
        };
    }
    b.methods["updateProjectionMatrix"] = [](void* self, const Args&, Store&) {
        as<OrthographicCamera>(self)->updateProjectionMatrix();
        return chain();
    };
    b.methods["setViewOffset"] = [](void* self, const Args& a, Store&) {
        const Args six = viewOffsetArgs(a);
        as<OrthographicCamera>(self)->setViewOffset(number(six.at(0)), number(six.at(1)), number(six.at(2)),
                                                    number(six.at(3)), number(six.at(4)), number(six.at(5)));
        return chain();
    };
    b.methods["clearViewOffset"] = [](void* self, const Args&, Store&) {
        as<OrthographicCamera>(self)->clearViewOffset();
        return chain();
    };
}

// --------------------------------------------------------------------- Scene, Group, Mesh

void registerScene(ClassBinding& b) {
    // registerObject3D first: it installs the base ctor, and the node class replaces it after.
    registerObject3D(b);
    b.ctor = [](const Args&, Store&) {
        return std::static_pointer_cast<void>(std::make_shared<Scene>());
    };
    const std::pair<const char*, double Scene::*> kScalars[] = {
        {"backgroundBlurriness", &Scene::backgroundBlurriness},
        {"backgroundIntensity", &Scene::backgroundIntensity},
        {"environmentIntensity", &Scene::environmentIntensity},
    };
    for (const auto& [name, field] : kScalars) {
        b.getters[name] = [field](void* self) { return Value::of(as<Scene>(self)->*field); };
        b.setters[name] = [field](void* self, const Value& v) { as<Scene>(self)->*field = number(v); };
    }
    b.members["environment"] = [](void* self, const Args&, Store& store) -> Value {
        return store.share("Texture", as<Scene>(self)->environment);
    };
    b.setters["environment"] = [](void* self, const Value& v, Store& store) {
        if (v.kind == Value::Kind::Null) { as<Scene>(self)->environment.reset(); return; }
        Object* texture = store.find(v);
        if (!texture || !isTextureClass(texture->cls))
            throw Unsupported{"environment must be a Texture or null"};
        as<Scene>(self)->environment = std::static_pointer_cast<Texture>(texture->ptr);
    };
    // `background` is the caller's Color itself, as in three: `scene.background = c` keeps `c`, so a
    // later write to `c` is a background change, and reading it back answers `c`.
    b.members["background"] = [](void* self, const Args&, Store& store) -> Value {
        // The Color itself, not an alias of the scene: a later `background =` replaces it, and a JS
        // reference to the old one must stay valid.
        auto* scene = as<Scene>(self);
        if (scene->backgroundTexture) return store.share("Texture", scene->backgroundTexture);
        return store.share("Color", scene->background);
    };
    b.setters["background"] = [](void* self, const Value& v, Store& store) {
        Scene* scene = as<Scene>(self);
        if (v.kind == Value::Kind::Null) {
            scene->background = nullptr;
            scene->backgroundTexture.reset();
            return;
        }
        Object* color = store.find(v);
        if (!color) throw Unsupported{"background must be a Color, Texture or null"};
        if (color->cls == "Color") {
            scene->background = std::static_pointer_cast<Color>(color->ptr); scene->backgroundTexture.reset();
        } else if (isTextureClass(color->cls)) {
            scene->backgroundTexture = std::static_pointer_cast<Texture>(color->ptr); scene->background.reset();
        } else throw Unsupported{"background must be a Color, Texture or null"};
    };
    b.getters["backgroundNode"] = [](void* self) { return Value::shaderNode(as<Scene>(self)->backgroundNode); };
    b.setters["backgroundNode"] = [](void* self, const Value& v) {
        if (v.kind != Value::Kind::Null && (v.kind != Value::Kind::ShaderNode || !v.node))
            throw Unsupported{"TN_NATIVE_BACKGROUND_NODE_INVALID: expected a TSL node or null"};
        as<Scene>(self)->backgroundNode = v.node;
    };
    // three's `scene.fogNode`: vec4(color, factor), a TSL node set through the TSL runtime (no ABI value carries it).
    b.getters["fogNode"] = [](void* self) { return Value::shaderNode(as<Scene>(self)->fogNode); };
    b.setters["fogNode"] = [](void* self, const Value& v) {
        if (v.kind != Value::Kind::Null && (v.kind != Value::Kind::ShaderNode || !v.node))
            throw Unsupported{"fogNode must be a shader node or null"};
        as<Scene>(self)->fogNode = v.node;
    };
    b.members["fog"] = [](void* self, const Args&, Store& store) -> Value {
        auto fog = as<Scene>(self)->fog;
        return fog ? store.share(fog->exponential() ? "FogExp2" : "Fog", fog) : Value{};
    };
    b.setters["fog"] = [](void* self, const Value& v, Store& store) {
        if (v.kind == Value::Kind::Null) { as<Scene>(self)->fog.reset(); return; }
        Object* fog = store.find(v);
        if (!fog || (fog->cls != "Fog" && fog->cls != "FogExp2")) throw Unsupported{"fog must be Fog, FogExp2 or null"};
        as<Scene>(self)->fog = std::static_pointer_cast<Fog>(fog->ptr);
    };
    for (const auto& [prefix, field] : {std::pair{"backgroundRotation", &Scene::backgroundRotation},
                                      std::pair{"environmentRotation", &Scene::environmentRotation}}) {
        b.members[prefix] = memberAliasMethod(field, "Euler");
        // three's `scene.backgroundRotation = new Euler(...)`: a plain property upstream, so the game may assign it.
        b.setters[prefix] = [field, name = std::string(prefix)](void* self, const Value& v, Store& store) {
            Object* euler = store.find(v);
            if (!euler || euler->cls != "Euler") throw Unsupported{name + " must be an Euler"};
            as<Scene>(self)->*field = *static_cast<Euler*>(euler->ptr.get());
        };
        for (int i = 0; i < 3; ++i) {
            const std::string path = std::string(prefix) + "." + "xyz"[i];
            b.getters[path] = [field, i](void* self) { auto& e = as<Scene>(self)->*field; return Value::of(i == 0 ? e.x : i == 1 ? e.y : e.z); };
            b.setters[path] = [field, i](void* self, const Value& v) { auto& e = as<Scene>(self)->*field;
                e.set(i == 0 ? number(v) : e.x, i == 1 ? number(v) : e.y, i == 2 ? number(v) : e.z, e.order); };
        }
    }

}

void registerFog(ClassBinding& b, bool exp2) {
    b.ctor = [exp2](const Args& a, Store& store) -> std::shared_ptr<void> {
        Color color;
        if (!a.empty()) {
            if (a.at(0).kind == Value::Kind::Number) color.setHex(static_cast<uint32_t>(number(a.at(0))));
            else { Object* c = store.find(a.at(0)); if (!c || c->cls != "Color") throw Unsupported{"fog color needs Color or hex"}; color = *as<Color>(c->ptr.get()); }
        }
        if (exp2) return std::make_shared<FogExp2>(color, optional(a, 1, 0.00025));
        return std::make_shared<Fog>(color, optional(a, 1, 1), optional(a, 2, 1000));
    };
    fixedMember(b, "color", memberAliasMethod(&Fog::color, "Color"));
    for (int i = 0; i < 3; ++i) {
        const std::string path = std::string("color.") + "rgb"[i];
        b.getters[path] = [i](void* self) { const auto& c = as<Fog>(self)->color; return Value::of(i == 0 ? c.r : i == 1 ? c.g : c.b); };
        b.setters[path] = [i](void* self, const Value& v) { auto& c = as<Fog>(self)->color; (i == 0 ? c.r : i == 1 ? c.g : c.b) = number(v); };
    }
    for (const auto& [name, field] : {std::pair{"near", &Fog::near}, std::pair{"far", &Fog::far}, std::pair{"density", &Fog::density}}) {
        if (exp2 != (field == &Fog::density)) continue;
        b.getters[name] = [field](void* self) { return Value::of(as<Fog>(self)->*field); };
        b.setters[name] = [field](void* self, const Value& v) { as<Fog>(self)->*field = number(v); };
    }
}

void registerGroup(ClassBinding& b) {
    registerObject3D(b);
    b.ctor = [](const Args&, Store&) {
        return std::static_pointer_cast<void>(std::make_shared<Group>());
    };
}

/** A geometry argument of any generator class, matched to one base pointer. */
std::shared_ptr<BufferGeometry> geometryArg(Store& store, const Value& arg) {
    static const char* const kClasses[] = {
        "BufferGeometry", "PlaneGeometry",  "BoxGeometry",   "SphereGeometry", "CylinderGeometry",
        "ConeGeometry",   "CircleGeometry", "TorusGeometry", "RingGeometry", "RoundedBoxGeometry", "LatheGeometry",
        "TubeGeometry", "ShapeGeometry", "ExtrudeGeometry", "IcosahedronGeometry", "CapsuleGeometry",
        "DodecahedronGeometry", "OctahedronGeometry", "TorusKnotGeometry", "InstancedBufferGeometry"};
    Object* found = store.find(arg);
    if (found == nullptr) throw Unsupported{"argument is not a BufferGeometry"};
    for (const char* cls : kClasses) {
        if (found->cls == cls) return std::static_pointer_cast<BufferGeometry>(found->ptr);
    }
    throw Unsupported{"argument is not a BufferGeometry, it is a " + found->cls};
}

/** A material argument of any mesh-material class, matched to one base pointer. */
std::shared_ptr<Material> materialArg(Store& store, const Value& arg) {
    return store.shared<Material>(arg, "Material");
}

bool isMaterialArray(const Value& arg) { return arg.kind == Value::Kind::Refs || arg.kind == Value::Kind::Array; }

std::vector<std::shared_ptr<Material>> materialsArg(Store& store, const Value& arg) {
    std::vector<std::shared_ptr<Material>> materials;
    for (const Value& ref : refsOf(arg)) materials.push_back(ref.kind == Value::Kind::Ref ? materialArg(store, ref) : nullptr);
    return materials;
}

// Structured intersection results preserve the actual scene object and publish real vector wrappers.
Value intersections(Store& store, const std::vector<Intersection>& hits) {
    std::vector<Value> values;
    for (const auto& h : hits) {
        const auto vector = [&](const auto& v, const char* cls) {
            using V = std::decay_t<decltype(v)>;
            return store.adopt(cls, std::make_shared<V>(v));
        };
        if (h.index) {  // three's Line hit: the segment index, no face
            values.push_back(Value::record({{"distance", Value::of(h.distance)}, {"point", vector(h.point, "Vector3")},
                {"index", Value::of(double(*h.index))}, {"face", Value{}}, {"faceIndex", Value{}},
                {"barycoord", Value{}}, {"object", foundObject(store, h.object)}}));
            continue;
        }
        std::vector<std::pair<std::string, Value>> fields = {
            {"distance", Value::of(h.distance)}, {"point", vector(h.point, "Vector3")},
            {"object", foundObject(store, h.object)}, {"faceIndex", Value::of(double(h.faceIndex))},
            {"face", Value::record({{"a", Value::of(double(h.face.a))}, {"b", Value::of(double(h.face.b))},
                {"c", Value::of(double(h.face.c))}, {"normal", vector(h.face.normal, "Vector3")},
                {"materialIndex", Value::of(h.face.materialIndex)}})},
            {"barycoord", vector(h.barycoord, "Vector3")}
        };
        if (h.uv) fields.emplace_back("uv", vector(*h.uv, "Vector2"));
        if (h.uv1) fields.emplace_back("uv1", vector(*h.uv1, "Vector2"));
        if (h.normal) fields.emplace_back("normal", vector(*h.normal, "Vector3"));
        if (h.instanceId) fields.emplace_back("instanceId", Value::of(double(*h.instanceId)));
        values.push_back(Value::record(std::move(fields)));
    }
    return Value::array(std::move(values));
}
int layerIndex(double value) {
    if (!std::isfinite(value) || value == 0) return 0;
    double index = std::fmod(std::trunc(value), 32);
    return int(index < 0 ? index + 32 : index);
}
void registerLayers(ClassBinding& b) {
    b.ctor = [](const Args&, Store&) { return std::make_shared<Layers>(); };
    b.getters["mask"] = [](void* self) { return Value::of(double(as<Layers>(self)->mask)); };
    b.setters["mask"] = [](void* self, const Value& v) { as<Layers>(self)->mask = number(v); };
    // Games enable and disable layers on every mesh while they load; the Wasm back end runs three's
    // bit operations on the mask in place.
    b.fields = {{"mask", {uint32_t(offsetof(Layers, mask)), 1}}};
    b.getters["__address"] = [](void* self) { return Value::of(double(reinterpret_cast<uintptr_t>(self))); };
    for (const auto name : {"set", "enable", "toggle", "disable"}) {
        b.methods[name] = [name](void* self, const Args& a, Store&) {
            const int layer = layerIndex(number(a.at(0)));
            auto& layers = *as<Layers>(self);
            if (std::string_view(name) == "set") layers.set(layer);
            else if (std::string_view(name) == "enable") layers.enable(layer);
            else if (std::string_view(name) == "toggle") layers.toggle(layer);
            else layers.disable(layer);
            return Value::undefined();
        };
    }
    b.methods["enableAll"] = [](void* self, const Args&, Store&) { as<Layers>(self)->enableAll(); return Value::undefined(); };
    b.methods["disableAll"] = [](void* self, const Args&, Store&) { as<Layers>(self)->disableAll(); return Value::undefined(); };
    b.methods["test"] = [](void* self, const Args& a, Store& store) { return Value::of(as<Layers>(self)->test(store.ref<Layers>(a.at(0), "Layers"))); };
    b.methods["isEnabled"] = [](void* self, const Args& a, Store&) { return Value::of(as<Layers>(self)->isEnabled(layerIndex(number(a.at(0))))); };
}
void registerRaycaster(ClassBinding& b) {
    b.ctor = [](const Args& a, Store& store) {
        const Vector3 origin = !a.empty() && a[0].kind != Value::Kind::Null ? store.ref<Vector3>(a[0], "Vector3") : Vector3{};
        const Vector3 direction = a.size() > 1 && a[1].kind != Value::Kind::Null ? store.ref<Vector3>(a[1], "Vector3") : Vector3{0,0,-1};
        return std::make_shared<Raycaster>(origin, direction, optional(a, 2, 0), optional(a, 3, std::numeric_limits<double>::infinity()));
    };
    fixedMember(b, "ray", memberAliasMethod(&Raycaster::ray, "Ray"));
    fixedMember(b, "layers", memberAliasMethod(&Raycaster::layers, "Layers"));
    for (const auto name : {"near", "far"}) {
        const auto field = std::string_view(name) == "near" ? &Raycaster::near : &Raycaster::far;
        b.getters[name] = [field](void* self) { return Value::of(as<Raycaster>(self)->*field); };
        b.setters[name] = [field](void* self, const Value& v) { as<Raycaster>(self)->*field = number(v); };
    }
    b.members["camera"] = [](void* self, const Args&, Store& store) { return foundObject(store, as<Raycaster>(self)->camera); };
    b.setters["camera"] = [](void* self, const Value& v, Store& store) {
        auto& caster = *as<Raycaster>(self);
        auto* camera = v.kind == Value::Kind::Null ? nullptr : dynamic_cast<Camera*>(&objectArg(store, v));
        if (v.kind != Value::Kind::Null && !camera) throw Unsupported{"camera is not a Camera"};
        caster.camera = camera; caster.cameraOwner = camera ? camera->weak_from_this().lock() : nullptr;
    };
    b.methods["set"] = [](void* self, const Args& a, Store& store) {
        as<Raycaster>(self)->set(store.ref<Vector3>(a.at(0), "Vector3"), store.ref<Vector3>(a.at(1), "Vector3")); return Value::undefined();
    };
    b.methods["setFromCamera"] = [](void* self, const Args& a, Store& store) {
        auto* camera = dynamic_cast<Camera*>(&objectArg(store, a.at(1)));
        if (!camera || !as<Raycaster>(self)->setFromCamera(store.ref<Vector2>(a.at(0), "Vector2"), *camera))
            throw Unsupported{"Raycaster camera is not perspective or orthographic"};
        return Value::undefined();
    };
    b.methods["intersectObject"] = [](void* self, const Args& a, Store& store) {
        return intersections(store, as<Raycaster>(self)->intersectObject(objectArg(store, a.at(0)), boolean(a, 1, true)));
    };
    b.methods["intersectObjects"] = [](void* self, const Args& a, Store& store) {
        std::vector<Object3D*> objects;
        if (a.at(0).kind != Value::Kind::Numbers || !a.at(0).numbers.empty())
            for (const auto& v : refsOf(a.at(0))) objects.push_back(&objectArg(store, v));
        return intersections(store, as<Raycaster>(self)->intersectObjects(objects, boolean(a, 1, true)));
    };
}
void registerLOD(ClassBinding& b) {
    registerObject3D(b);
    b.ctor = [](const Args&, Store&) { return std::make_shared<LOD>(); };
    b.getters["autoUpdate"] = [](void* self) { return Value::of(as<LOD>(self)->autoUpdate); };
    b.setters["autoUpdate"] = [](void* self, const Value& v) { as<LOD>(self)->autoUpdate = flag(v); };
    b.members["levels"] = [](void* self, const Args&, Store& store) {
        std::vector<Value> levels;
        for (const auto& l : as<LOD>(self)->levels) levels.push_back(Value::record({
            {"object", foundObject(store, l.object)}, {"distance", Value::of(l.distance)}, {"hysteresis", Value::of(l.hysteresis)}}));
        return Value::array(std::move(levels));
    };
    b.methods["addLevel"] = [](void* self, const Args& a, Store& store) {
        as<LOD>(self)->addLevel(objectArg(store, a.at(0)), optional(a, 1, 0), optional(a, 2, 0)); return chain();
    };
    b.methods["removeLevel"] = [](void* self, const Args& a, Store&) { return Value::of(as<LOD>(self)->removeLevel(number(a.at(0)))); };
    b.methods["getCurrentLevel"] = [](void* self, const Args&, Store&) { return Value::of(double(as<LOD>(self)->getCurrentLevel())); };
    b.methods["getObjectForDistance"] = [](void* self, const Args& a, Store& store) { return foundObject(store, as<LOD>(self)->getObjectForDistance(number(a.at(0)))); };
    b.methods["update"] = [](void* self, const Args& a, Store& store) {
        auto* camera = dynamic_cast<Camera*>(&objectArg(store, a.at(0)));
        if (!camera) throw Unsupported{"LOD.update needs a Camera"};
        as<LOD>(self)->update(*camera); return Value::undefined();
    };
}

void registerMesh(ClassBinding& b) {
    registerObject3D(b);
    // three's Mesh builds a BufferGeometry and a MeshBasicMaterial by default; this port takes both
    // from the caller, so a no-argument Mesh stays empty.
    b.ctor = [](const Args& a, Store& store) -> std::shared_ptr<void> {
        std::shared_ptr<BufferGeometry> geometry;
        std::shared_ptr<Material> material;
        if (!a.empty() && a.at(0).kind == Value::Kind::Ref) geometry = geometryArg(store, a.at(0));
        if (a.size() >= 2 && a.at(1).kind == Value::Kind::Ref) material = materialArg(store, a.at(1));
        auto mesh = detail::makeShared<Mesh>(geometry, material);
        if (a.size() >= 2 && isMaterialArray(a.at(1))) mesh->materials = materialsArg(store, a.at(1));
        return std::static_pointer_cast<void>(mesh);
    };
    // three's getVertexPosition(index, target): the vertex with morphs (and, on a SkinnedMesh, bones) applied.
    b.methods["getVertexPosition"] = [](void* self, const Args& a, Store& store) {
        const double index = number(a.at(0));
        if (!(index >= 0 && index <= 9007199254740991.0) || index != std::floor(index))
            throw Unsupported{"getVertexPosition needs a vertex index"};
        as<Mesh>(self)->getVertexPosition(static_cast<uint64_t>(index), store.ref<Vector3>(a.at(1), "Vector3"));
        return a.at(1);
    };
    b.members["geometry"] = [](void* self, const Args&, Store& store) -> Value {
        return store.share("BufferGeometry", as<Mesh>(self)->geometry);
    };
    // three's Mesh.geometry is a plain property: a game swaps it (Midway's LOD and merged hulls).
    b.setters["geometry"] = [](void* self, const Value& value, Store& store) {
        as<Mesh>(self)->geometry = geometryArg(store, value);
    };
    // morphTargetInfluences: a plain array three sizes from the geometry's morph targets.
    b.methods["updateMorphTargets"] = [](void* self, const Args&, Store&) {
        as<Mesh>(self)->updateMorphTargets();
        return Value{};
    };
    b.getters["morphTargetInfluences"] = [](void* self) { return Value::list(as<Mesh>(self)->morphTargetInfluences); };
    for (int i = 0; i < 64; ++i) {
        const std::string path = "morphTargetInfluences." + std::to_string(i);
        b.getters[path] = [i](void* self) {
            const auto& influences = as<Mesh>(self)->morphTargetInfluences;
            return std::size_t(i) < influences.size() ? Value::of(influences[i]) : Value{};
        };
        b.setters[path] = [i](void* self, const Value& v) {
            auto& influences = as<Mesh>(self)->morphTargetInfluences;
            if (std::size_t(i) >= influences.size()) influences.resize(i + 1, 0.0); // a JS array grows
            influences[i] = number(v);
        };
    }
    b.members["material"] = [](void* self, const Args&, Store& store) -> Value {
        const Mesh& mesh = *as<Mesh>(self);
        if (!mesh.materials.empty()) {
            std::vector<Value> slots;
            for (const auto& material : mesh.materials)
                slots.push_back(material ? store.share(std::string(material->typeName()), material) : Value{});
            return Value::array(std::move(slots));
        }
        return mesh.material ? store.share(std::string(mesh.material->typeName()), mesh.material) : Value{};
    };
    // three's `mesh.material` is one material or an array of them (one per geometry group).
    b.setters["material"] = [](void* self, const Value& value, Store& store) {
        Mesh& mesh = *as<Mesh>(self);
        if (isMaterialArray(value)) {
            mesh.materials = materialsArg(store, value);
            mesh.material = nullptr;
        } else {
            mesh.materials.clear();
            mesh.material = materialArg(store, value);
        }
    };
}

// three's Bone: an Object3D a Skeleton names.
void registerBone(ClassBinding& b) {
    registerObject3D(b);
    b.ctor = [](const Args&, Store&) { return std::static_pointer_cast<void>(std::make_shared<Bone>()); };
}

// three's Skeleton(bones, boneInverses = []): the bones as an array of objects; without inverses
// they are computed from the bones' current world matrices.
void registerSkeleton(ClassBinding& b) {
    b.ctor = [](const Args& a, Store& store) -> std::shared_ptr<void> {
        std::vector<std::shared_ptr<Bone>> bones;
        if (!a.empty()) {
            if (a.at(0).kind != Value::Kind::Refs && a.at(0).kind != Value::Kind::Array &&
            !(a.at(0).kind == Value::Kind::Numbers && a.at(0).numbers.empty())) throw Unsupported{"Skeleton needs an array of bones"};
            for (const Value& ref : refsOf(a.at(0))) bones.push_back(store.shared<Bone>(ref, "Bone"));
        }
        std::vector<Matrix4> inverses;
        if (a.size() > 1 && (a.at(1).kind == Value::Kind::Refs || a.at(1).kind == Value::Kind::Array))
            for (const Value& ref : refsOf(a.at(1))) inverses.push_back(store.ref<Matrix4>(ref, "Matrix4"));
        return std::static_pointer_cast<void>(std::make_shared<Skeleton>(std::move(bones), std::move(inverses)));
    };
    b.methods["update"] = [](void* self, const Args&, Store&) { as<Skeleton>(self)->update(); return Value{}; };
    b.methods["pose"] = [](void* self, const Args&, Store&) { as<Skeleton>(self)->pose(); return Value{}; };
    b.methods["calculateInverses"] = [](void* self, const Args&, Store&) {
        as<Skeleton>(self)->calculateInverses();
        return Value{};
    };
    b.getters["boneMatrices"] = [](void* self) {
        as<Skeleton>(self)->update();
        const std::vector<float>& m = as<Skeleton>(self)->boneMatrices;
        return Value::list(std::vector<double>(m.begin(), m.end()));
    };
    b.members["bones"] = [](void* self, const Args&, Store& store) {
        const auto& skeleton = *as<Skeleton>(self);
        std::vector<Value> bones;
        for (size_t i = 0; i < skeleton.bones.size(); ++i) bones.push_back(foundObject(store, skeleton.bone(i)));
        return Value::array(std::move(bones));
    };
    b.getters["bones.length"] = [](void* self) { return Value::of(double(as<Skeleton>(self)->bones.size())); };
}

template <typename T>
void registerObjectBounds(ClassBinding& b) {
    b.methods["computeBoundingBox"] = [](void* self, const Args&, Store&) {
        as<T>(self)->computeBoundingBox(); return Value::undefined();
    };
    b.members["boundingBox"] = [](void* self, const Args&, Store& store) {
        return store.share("Box3", as<T>(self)->boundingBox);
    };
    b.setters["boundingBox"] = [](void* self, const Value& value, Store& store) {
        as<T>(self)->boundingBox = value.kind == Value::Kind::Null ? nullptr : store.shared<Box3>(value, "Box3");
    };
}

// three's SkinnedMesh(geometry, material): bind(skeleton, bindMatrix?), pose(). bindMode stays
// "attached": three types it as BindMode, which the catalog does not publish yet.
void registerSkinnedMesh(ClassBinding& b) {
    registerMesh(b);
    registerObjectBounds<SkinnedMesh>(b);
    b.ctor = [](const Args& a, Store& store) -> std::shared_ptr<void> {
        std::shared_ptr<BufferGeometry> geometry;
        std::shared_ptr<Material> material;
        if (!a.empty() && a.at(0).kind == Value::Kind::Ref) geometry = geometryArg(store, a.at(0));
        if (a.size() >= 2 && a.at(1).kind == Value::Kind::Ref) material = materialArg(store, a.at(1));
        return std::static_pointer_cast<void>(std::make_shared<SkinnedMesh>(geometry, material));
    };
    b.methods["bind"] = [](void* self, const Args& a, Store& store) {
        if (a.empty() || a.at(0).kind != Value::Kind::Ref) throw Unsupported{"bind needs a Skeleton"};
        std::shared_ptr<Skeleton> skeleton = store.shared<Skeleton>(a.at(0), "Skeleton");
        if (a.size() > 1 && a.at(1).kind == Value::Kind::Ref) {
            const Matrix4& matrix = store.ref<Matrix4>(a.at(1), "Matrix4");
            as<SkinnedMesh>(self)->bind(std::move(skeleton), &matrix);
        } else {
            as<SkinnedMesh>(self)->bind(std::move(skeleton));
        }
        return Value{};
    };
    b.methods["pose"] = [](void* self, const Args&, Store&) { as<SkinnedMesh>(self)->pose(); return Value{}; };
    b.members["skeleton"] = [](void* self, const Args&, Store& store) -> Value {
        const std::shared_ptr<Skeleton>& skeleton = as<SkinnedMesh>(self)->skeleton;
        return skeleton ? store.share("Skeleton", skeleton) : Value{};
    };
    // three's `skeleton` and bind matrices are plain properties: core's projection stand-in is a fresh SkinnedMesh
    // handed the game's skeleton by assignment, and a dropped write draws the rig unskinned.
    b.setters["skeleton"] = [](void* self, const Value& value, Store& store) {
        as<SkinnedMesh>(self)->revokeGpuSkinning();
        if (value.kind != Value::Kind::Ref && value.kind != Value::Kind::Null && value.kind != Value::Kind::Undefined)
            throw Unsupported{"SkinnedMesh.skeleton must be a Skeleton or null"};
        as<SkinnedMesh>(self)->skeleton = value.kind == Value::Kind::Ref ? store.shared<Skeleton>(value, "Skeleton") : nullptr;
    };
    b.setters["bindMatrix"] = [](void* self, const Value& value, Store& store) {
        as<SkinnedMesh>(self)->revokeGpuSkinning();
        as<SkinnedMesh>(self)->bindMatrix.copy(store.ref<Matrix4>(value, "Matrix4"));
    };
    b.setters["bindMatrixInverse"] = [](void* self, const Value& value, Store& store) {
        as<SkinnedMesh>(self)->revokeGpuSkinning();
        as<SkinnedMesh>(self)->bindMatrixInverse.copy(store.ref<Matrix4>(value, "Matrix4"));
    };
    b.getters["bindMode"] = [](void* self) { return Value{Value::Kind::String, 0, as<SkinnedMesh>(self)->attached ? "attached" : "detached"}; };
    b.setters["bindMode"] = [](void* self, const Value& value) {
        as<SkinnedMesh>(self)->revokeGpuSkinning();
        if (value.kind != Value::Kind::String || (value.text != "attached" && value.text != "detached"))
            throw Unsupported{"SkinnedMesh.bindMode must be attached or detached"};
        as<SkinnedMesh>(self)->attached = value.text == "attached";
    };
    fixedMember(b, "bindMatrix", [](void* self, const Args&, Store& store) {
        auto& rig = *as<SkinnedMesh>(self);
        rig.exposeGpuBind();
        return memberAlias(store, self, rig.bindMatrix, "Matrix4");
    });
    fixedMember(b, "bindMatrixInverse", [](void* self, const Args&, Store& store) {
        auto& rig = *as<SkinnedMesh>(self);
        rig.exposeGpuBind();
        return memberAlias(store, self, rig.bindMatrixInverse, "Matrix4");
    });
    nestedMatrix<SkinnedMesh>(b, "bindMatrix", &SkinnedMesh::bindMatrix);
    nestedMatrix<SkinnedMesh>(b, "bindMatrixInverse", &SkinnedMesh::bindMatrixInverse);
}

// The listeners a language set on one mixer, by event type, and the first error one of them threw
// during a dispatch, which the update that dispatched it reports.
struct MixerListeners {
    tn::engine::animation::AnimationMixer* mixer = nullptr;
    Store* store = nullptr;
    std::map<std::string, EventCallback, std::less<>> byType;
    std::string error;

    static void dispatch(const tn::engine::animation::MixerEvent& event, void* context) {
        auto& self = *static_cast<MixerListeners*>(context);
        const auto found = self.byType.find(event.type);
        if (found == self.byType.end() || !found->second) return;
        // three's events: {type, action, direction} for "finished", {type, action, loopDelta} for "loop".
        std::vector<std::pair<std::string, Value>> fields{
            {"type", Value{Value::Kind::String, 0, std::string(event.type)}},
            {"action", self.store->adoptAlias("AnimationAction", event.action, self.mixer)}};
        if (event.type == "loop") fields.emplace_back("loopDelta", Value::of(event.loopDelta));
        else fields.emplace_back("direction", Value::of(double(event.direction)));
        const EventCallback callback = found->second;  // a listener may replace itself
        std::string error;
        if (!(*callback)(Value::record(std::move(fields)), error) && self.error.empty()) self.error = error;
    }
};

/** Runs a mixer call, then reports a listener that threw during it, as three's call would throw. */
template <typename Call>
Value withListeners(void* self, Call call) {
    auto* mixer = as<tn::engine::animation::AnimationMixer>(self);
    call(*mixer);
    if (auto* listeners = static_cast<MixerListeners*>(mixer->languageListeners.get()); listeners && !listeners->error.empty())
        throw Unsupported{std::exchange(listeners->error, {})};
    return chain();
}

// three's AnimationMixer(root), the actions it owns and the clips a loader hands back. An action
// is the mixer's: its Ref is an alias that keeps the mixer alive.
void registerAnimationMixer(ClassBinding& b) {
    for (const char* type : {"finished", "loop"}) {
        b.events[type] = [type](void* self, EventCallback callback, Store& store) {
            auto* mixer = as<tn::engine::animation::AnimationMixer>(self);
            if (!mixer->languageListeners) {
                auto listeners = std::make_shared<MixerListeners>();
                listeners->mixer = mixer;
                listeners->store = &store;
                mixer->languageListeners = listeners;
            }
            auto* listeners = static_cast<MixerListeners*>(mixer->languageListeners.get());
            const bool listening = listeners->byType.contains(type);
            if (!callback) {
                if (listening) mixer->removeEventListener(type, &MixerListeners::dispatch, listeners);
                listeners->byType.erase(type);
                return;
            }
            if (!listening) mixer->addEventListener(type, &MixerListeners::dispatch, listeners);
            listeners->byType[type] = std::move(callback);
        };
    }
    // EventDispatcher's methods keep language functions, so the language adapter implements them over
    // `events`; called through the ABI they refuse rather than drop a listener.
    for (const char* name : {"addEventListener", "removeEventListener", "hasEventListener", "dispatchEvent"}) {
        b.methods[name] = [](void*, const Args&, Store&) -> Value {
            throw Unsupported{"TN_NATIVE_EVENT_LISTENER: the language adapter keeps EventDispatcher listeners"};
        };
    }
    using namespace tn::engine::animation;
    b.ctor = [](const Args& a, Store& store) -> std::shared_ptr<void> {
        if (a.empty() || a.at(0).kind != Value::Kind::Ref) throw Unsupported{"AnimationMixer needs a root object"};
        std::shared_ptr<Object3D> root = objectArg(store, a.at(0)).weak_from_this().lock();
        if (!root) throw Unsupported{"AnimationMixer root is not shared-owned"};
        return std::static_pointer_cast<void>(std::make_shared<AnimationMixer>(root));
    };
    b.methods["clipAction"] = [](void* self, const Args& a, Store& store) -> Value {
        if (a.empty() || a.at(0).kind != Value::Kind::Ref) throw Unsupported{"clipAction needs an AnimationClip"};
        AnimationAction* action = as<AnimationMixer>(self)->clipAction(store.shared<AnimationClip>(a.at(0), "AnimationClip"));
        if (!action) throw Unsupported{"clipAction: the engine refuses a track of this clip"};
        return store.adoptAlias("AnimationAction", action, self);
    };
    b.methods["setTime"] = [](void* self, const Args& a, Store&) {
        const double time = number(a.at(0));
        return withListeners(self, [time](AnimationMixer& mixer) { mixer.setTime(time); });
    };
    b.methods["update"] = [](void* self, const Args& a, Store&) {
        const double delta = number(a.at(0));
        return withListeners(self, [delta](AnimationMixer& mixer) { mixer.update(delta); });
    };
    b.methods["stopAllAction"] = [](void* self, const Args&, Store&) {
        as<AnimationMixer>(self)->stopAllAction();
        return chain();
    };
    b.methods["getRoot"] = [](void* self, const Args&, Store& store) {
        return foundObject(store, &as<AnimationMixer>(self)->getRoot());
    };
    b.methods["uncacheClip"] = [](void* self, const Args& a, Store& store) {
        as<AnimationMixer>(self)->uncacheClip(store.ref<AnimationClip>(a.at(0), "AnimationClip"));
        return Value::undefined();
    };
    b.methods["uncacheRoot"] = [](void* self, const Args& a, Store& store) {
        as<AnimationMixer>(self)->uncacheRoot(objectArg(store, a.at(0)));
        return Value::undefined();
    };
    b.methods["uncacheAction"] = [](void* self, const Args& a, Store& store) {
        const Object3D* root = a.size() > 1 && a.at(1).kind == Value::Kind::Ref ? &objectArg(store, a.at(1)) : nullptr;
        as<AnimationMixer>(self)->uncacheAction(store.ref<AnimationClip>(a.at(0), "AnimationClip"), root);
        return Value::undefined();
    };
    b.methods["existingAction"] = [](void* self, const Args& a, Store& store) -> Value {
        const Object3D* root = a.size() > 1 && a.at(1).kind == Value::Kind::Ref ? &objectArg(store, a.at(1)) : nullptr;
        AnimationAction* action = as<AnimationMixer>(self)->existingAction(store.ref<AnimationClip>(a.at(0), "AnimationClip"), root);
        return action ? store.adoptAlias("AnimationAction", action, self) : Value{};
    };
    b.getters["time"] = [](void* self) { return Value::of(as<AnimationMixer>(self)->time); };
    b.getters["timeScale"] = [](void* self) { return Value::of(as<AnimationMixer>(self)->timeScale); };
    // The ABI returns a fresh numeric snapshot; each runtime keeps one live facade over this getter.
    b.getters["stats"] = [](void* self) {
        const auto* mixer = as<AnimationMixer>(self);
        const auto count = [](std::size_t total, std::size_t inUse) {
            return Value::record({{"total", Value::of(double(total))}, {"inUse", Value::of(double(inUse))}});
        };
        return Value::record({{"actions", count(mixer->actionsTotal(), mixer->actionsInUse())},
                              {"bindings", count(mixer->bindingsTotal(), mixer->bindingsInUse())},
                              {"controlInterpolants",
                               count(mixer->controlInterpolantsTotal(), mixer->controlInterpolantsInUse())}});
    };
    b.setters["timeScale"] = [](void* self, const Value& v) { as<AnimationMixer>(self)->timeScale = number(v); };
    // A game reads `time` every frame (Midway: 71 a frame); the Wasm back end reads it in place.
    static const AnimationMixer probe(std::make_shared<Object3D>());
    const auto timeAt = uint32_t(reinterpret_cast<const char*>(&probe.time) - reinterpret_cast<const char*>(&probe));
    // timeScale follows time (an AnimationPlayer reads it every frame, stress lab: 360 crossings a frame).
    static_assert(offsetof(AnimationMixer, timeScale) == offsetof(AnimationMixer, time) + 8);
    b.fields = {{"time", {timeAt, 1}}, {"timeScale", {timeAt + 8, 1}}};
    b.getters["__address"] = [](void* self) { return Value::of(double(reinterpret_cast<uintptr_t>(self))); };
}

/**
 * three's PropertyBinding over the engine's (engine/animation/property_binding.h), for every back end.
 * `bind()` answers the reason a path did not bind (empty when it did); the shared facade
 * (three-native/src/property-binding.ts) routes it to three's console function and returns nothing.
 * A PropertyBinding built with no arguments is the facade's helper for the static parseTrackName
 * and findNode.
 */
Value textValue(std::string text) { return Value{Value::Kind::String, 0, std::move(text)}; }

struct BoundProperty {
    std::optional<animation::PropertyBinding> binding;
};

void registerPropertyBinding(ClassBinding& b) {
    using animation::ParsedPath;
    const auto shared = [](Store& store, const Value& arg) {
        std::shared_ptr<Object3D> root = objectArg(store, arg).weak_from_this().lock();
        if (!root) throw Unsupported{"TN_NATIVE_PROPERTY_BINDING: the root is not shared-owned"};
        return root;
    };
    const auto path = [](const Value& v) {
        if (v.kind != Value::Kind::String) throw Unsupported{"TN_NATIVE_PROPERTY_BINDING: expected a track path string"};
        return v.text;
    };
    const auto node = [](Store& store, Object3D* object) -> Value {
        if (!object) return Value{};
        auto owner = object->weak_from_this().lock();
        if (!owner) throw Unsupported{"TN_NATIVE_PROPERTY_BINDING: node has no shared owner"};
        return store.share(std::string(object->type()), std::move(owner));
    };
    b.ctor = [shared, path](const Args& a, Store& store) -> std::shared_ptr<void> {
        auto bound = std::make_shared<BoundProperty>();
        if (a.empty()) return bound;
        if (a.size() != 2) throw Unsupported{"TN_NATIVE_PROPERTY_BINDING: construct with root and path"};
        const std::string track = path(a.at(1));
        ParsedPath parsed;
        std::string error;
        if (!animation::parseTrackName(track, parsed, error)) throw Unsupported{error};
        bound->binding.emplace(shared(store, a.at(0)), track);
        return bound;
    };
    const auto binding = [](void* self) -> animation::PropertyBinding& {
        auto& bound = *as<BoundProperty>(self);
        if (!bound.binding) throw Unsupported{"TN_NATIVE_PROPERTY_BINDING: this helper has no root and path"};
        return *bound.binding;
    };
    b.methods["bind"] = [binding](void* self, const Args&, Store&) {
        auto& property = binding(self);
        property.bind();
        return textValue(property.diagnostic);
    };
    b.methods["unbind"] = [binding](void* self, const Args&, Store&) {
        binding(self).unbind();
        return Value{};
    };
    b.getters["path"] = [binding](void* self) { return textValue(binding(self).path); };
    const auto target = [binding, node](void* self, const Args&, Store& store) -> Value {
        auto& property = binding(self);
        if (auto material = property.targetMaterial()) {
            std::string cls(material->typeName());  // read before the move: argument order is unspecified
            return store.share(std::move(cls), std::move(material));
        }
        return node(store, property.targetNode().get());
    };
    b.methods["targetObject"] = target;
    // Engine-internal: bind and its target in one call, `[reason, targetObject]`; games bind every
    // track of every clip while they load.
    b.methods["__bind"] = [binding, target](void* self, const Args& a, Store& store) {
        auto& property = binding(self);
        property.bind();
        return Value::array({textValue(property.diagnostic), target(self, a, store)});
    };
    b.methods["parseTrackName"] = [path](void*, const Args& a, Store&) {
        ParsedPath parsed;
        std::string error;
        if (a.size() != 1 || !animation::parseTrackName(path(a.at(0)), parsed, error))
            throw Unsupported{error.empty() ? "TN_NATIVE_PROPERTY_BINDING: expected one track path" : error};
        std::vector<std::pair<std::string, Value>> fields;
        for (const auto& [name, part] : std::vector<std::pair<const char*, std::optional<std::string>>>{
                 {"nodeName", parsed.nodeName}, {"objectName", parsed.objectName}, {"objectIndex", parsed.objectIndex},
                 {"propertyName", parsed.propertyName}, {"propertyIndex", parsed.propertyIndex}})
            fields.emplace_back(name, part ? textValue(*part) : Value::undefined());
        return Value::record(std::move(fields));
    };
    b.methods["findNode"] = [shared, path, node](void*, const Args& a, Store& store) {
        if (a.empty() || a.size() > 2) throw Unsupported{"TN_NATIVE_PROPERTY_BINDING: expected root and node name"};
        const auto root = shared(store, a.at(0));
        // An absent name (`undefined`, which a back end may pass as null or leave off) finds the root.
        const bool named = a.size() == 2 && a.at(1).kind != Value::Kind::Undefined && a.at(1).kind != Value::Kind::Null;
        const auto name = named ? std::optional<std::string>{path(a.at(1))} : std::optional<std::string>{};
        return node(store, animation::findNode(*root, name));
    };
}

void registerAnimationAction(ClassBinding& b) {
    using namespace tn::engine::animation;
    for (const char* name : {"play", "stop", "reset"}) {
        const std::string method = name;
        b.methods[method] = [method](void* self, const Args&, Store&) {
            AnimationAction* action = as<AnimationAction>(self);
            if (method == "play") action->play();
            else if (method == "stop") action->stop();
            else action->reset();
            return chain();
        };
    }
    b.methods["setEffectiveWeight"] = [](void* self, const Args& a, Store&) {
        as<AnimationAction>(self)->setEffectiveWeight(number(a.at(0)));
        return chain();
    };
    // Every other AnimationAction member three publishes, over the native action's own fields.
    using Chain1 = AnimationAction& (AnimationAction::*)(double);
    for (const auto& [name, method] : std::initializer_list<std::pair<const char*, Chain1>>{
             {"startAt", &AnimationAction::startAt}, {"fadeIn", &AnimationAction::fadeIn},
             {"fadeOut", &AnimationAction::fadeOut}, {"setEffectiveTimeScale", &AnimationAction::setEffectiveTimeScale},
             {"setDuration", &AnimationAction::setDuration}, {"halt", &AnimationAction::halt}}) {
        b.methods[name] = [method](void* self, const Args& a, Store&) {
            (as<AnimationAction>(self)->*method)(number(a.at(0)));
            return chain();
        };
    }
    b.methods["stopFading"] = [](void* self, const Args&, Store&) { as<AnimationAction>(self)->stopFading(); return chain(); };
    b.methods["stopWarping"] = [](void* self, const Args&, Store&) { as<AnimationAction>(self)->stopWarping(); return chain(); };
    b.methods["warp"] = [](void* self, const Args& a, Store&) {
        as<AnimationAction>(self)->warp(number(a.at(0)), number(a.at(1)), number(a.at(2)));
        return chain();
    };
    b.methods["isRunning"] = [](void* self, const Args&, Store&) { return Value::of(as<AnimationAction>(self)->isRunning()); };
    b.methods["isScheduled"] = [](void* self, const Args&, Store&) { return Value::of(as<AnimationAction>(self)->isScheduled()); };
    b.methods["getEffectiveWeight"] = [](void* self, const Args&, Store&) {
        return Value::of(as<AnimationAction>(self)->getEffectiveWeight());
    };
    b.methods["getEffectiveTimeScale"] = [](void* self, const Args&, Store&) {
        return Value::of(as<AnimationAction>(self)->getEffectiveTimeScale());
    };
    // three's loop constants: LoopOnce 2200, LoopRepeat 2201, LoopPingPong 2202.
    const auto loopOf = [](const Value& v) {
        const double mode = number(v);
        if (mode == 2200) return Loop::Once;
        if (mode == 2201) return Loop::Repeat;
        if (mode == 2202) return Loop::PingPong;
        throw Unsupported{"loop must be LoopOnce, LoopRepeat or LoopPingPong"};
    };
    b.methods["setLoop"] = [loopOf](void* self, const Args& a, Store&) {
        as<AnimationAction>(self)->setLoop(loopOf(a.at(0)), number(a.at(1)));
        return chain();
    };
    b.getters["loop"] = [](void* self) {
        const Loop loop = as<AnimationAction>(self)->loop;
        return Value::of(loop == Loop::Once ? 2200.0 : loop == Loop::Repeat ? 2201.0 : 2202.0);
    };
    b.setters["loop"] = [loopOf](void* self, const Value& v) { as<AnimationAction>(self)->loop = loopOf(v); };
    for (const auto& [name, field] : std::initializer_list<std::pair<const char*, double AnimationAction::*>>{
             {"time", &AnimationAction::time}, {"timeScale", &AnimationAction::timeScale},
             {"weight", &AnimationAction::weight}, {"repetitions", &AnimationAction::repetitions}}) {
        b.getters[name] = [field](void* self) { return Value::of(as<AnimationAction>(self)->*field); };
        b.setters[name] = [field](void* self, const Value& v) { as<AnimationAction>(self)->*field = number(v); };
    }
    // An AnimationPlayer reads timeScale and paused on every action every frame (stress lab: 775 crossings a
    // frame); the Wasm back end reads them in place. The block starts at `time`, so the offsets hold in the
    // 64-bit build that dumps the registry and the 32-bit Wasm one that reads it.
    {
        static_assert(offsetof(AnimationAction, timeScale) == offsetof(AnimationAction, time) + 8 &&
                          offsetof(AnimationAction, weight) == offsetof(AnimationAction, time) + 16 &&
                          offsetof(AnimationAction, paused) == offsetof(AnimationAction, time) + 32 &&
                          offsetof(AnimationAction, enabled) == offsetof(AnimationAction, time) + 33,
                      "AnimationAction's field block moved: update the Wasm back end's offsets");
        b.fields = {{"time", {0, 1}}, {"timeScale", {8, 1}}, {"weight", {16, 1}}, {"paused", {32, 0}},
                    {"enabled", {33, 0}}};
        b.getters["__address"] = [](void* self) {
            return Value::of(double(reinterpret_cast<uintptr_t>(&as<AnimationAction>(self)->time)));
        };
    }
    for (const auto& [name, field] : std::initializer_list<std::pair<const char*, bool AnimationAction::*>>{
             {"paused", &AnimationAction::paused}, {"enabled", &AnimationAction::enabled},
             {"clampWhenFinished", &AnimationAction::clampWhenFinished},
             {"zeroSlopeAtStart", &AnimationAction::zeroSlopeAtStart}, {"zeroSlopeAtEnd", &AnimationAction::zeroSlopeAtEnd}}) {
        b.getters[name] = [field](void* self) { return Value::of(as<AnimationAction>(self)->*field); };
        b.setters[name] = [field](void* self, const Value& v) {
            if (v.kind != Value::Kind::Bool) throw Unsupported{"expected a boolean"};
            as<AnimationAction>(self)->*field = v.flag;
        };
    }
    for (const char* name : {"crossFadeFrom", "crossFadeTo"}) {
        const bool from = name[9] == 'F';
        b.methods[name] = [from](void* self, const Args& a, Store& store) {
            AnimationAction& other = store.ref<AnimationAction>(a.at(0), "AnimationAction");
            const bool warp = a.size() > 2 && a.at(2).kind == Value::Kind::Bool && a.at(2).flag;
            if (from) as<AnimationAction>(self)->crossFadeFrom(other, number(a.at(1)), warp);
            else as<AnimationAction>(self)->crossFadeTo(other, number(a.at(1)), warp);
            return chain();
        };
    }
    b.methods["syncWith"] = [](void* self, const Args& a, Store& store) {
        as<AnimationAction>(self)->syncWith(store.ref<AnimationAction>(a.at(0), "AnimationAction"));
        return chain();
    };
    b.methods["getClip"] = [](void* self, const Args&, Store& store) {
        return store.share("AnimationClip", std::const_pointer_cast<AnimationClip>(as<AnimationAction>(self)->clip()));
    };
    b.methods["getRoot"] = [](void* self, const Args&, Store& store) {
        return foundObject(store, &as<AnimationAction>(self)->getRoot());
    };
}

/** The registry class of a track of each value type; colour and boolean tracks are not bound. */
const char* trackClass(tn::engine::animation::TrackType type) {
    using tn::engine::animation::TrackType;
    if (type == TrackType::Quaternion) return "QuaternionKeyframeTrack";
    if (type == TrackType::Vector) return "VectorKeyframeTrack";
    if (type == TrackType::Number) return "NumberKeyframeTrack";
    throw Unsupported{"colour and boolean keyframe tracks are not bound"};
}

std::vector<double> keyNumbers(const Value& v, const char* what) {
    if (v.kind != Value::Kind::Numbers) throw Unsupported{std::string("a keyframe track's ") + what + " must be numbers"};
    return v.numbers;
}

// three's Quaternion-, Vector- and NumberKeyframeTrack(name, times, values, interpolation). Values
// that are not a whole number of keys of the type's size are refused; three would read past them.
void registerKeyframeTrack(ClassBinding& b, tn::engine::animation::TrackType type) {
    using namespace tn::engine::animation;
    b.ctor = [type](const Args& a, Store&) {
        if (a.size() < 3 || a.at(0).kind != Value::Kind::String) throw Unsupported{"a keyframe track needs a name, times and values"};
        const std::vector<double> times = keyNumbers(a.at(1), "times");
        const std::vector<double> values = keyNumbers(a.at(2), "values");
        const size_t size = type == TrackType::Quaternion ? 4 : type == TrackType::Number ? 1 : 0;
        if (times.empty() || values.size() % times.size() != 0 || (size != 0 && values.size() != times.size() * size))
            throw Unsupported{"a keyframe track's values must be one value per time"};
        Interpolation mode = Interpolation::Linear;
        if (a.size() > 3 && a.at(3).kind != Value::Kind::Undefined) {
            const double m = number(a.at(3));  // InterpolateDiscrete 2300, InterpolateLinear 2301, InterpolateSmooth 2302
            if (m != 2300 && m != 2301 && m != 2302) throw Unsupported{"interpolation must be InterpolateDiscrete, InterpolateLinear or InterpolateSmooth"};
            mode = m == 2300 ? Interpolation::Discrete : m == 2302 ? Interpolation::Smooth : Interpolation::Linear;
        }
        return std::static_pointer_cast<void>(std::make_shared<KeyframeTrack>(a.at(0).text, type, times, values, mode));
    };
    b.getters["name"] = [](void* self) { return Value{Value::Kind::String, 0, as<KeyframeTrack>(self)->name}; };
    b.getters["ValueTypeName"] = [type](void*) {
        return Value{Value::Kind::String, 0, type == TrackType::Quaternion ? "quaternion" : type == TrackType::Vector ? "vector" : "number"};
    };
    b.getters["times"] = [](void* self) { return Value::list(as<KeyframeTrack>(self)->times); };
    b.getters["values"] = [](void* self) { return Value::list(as<KeyframeTrack>(self)->values); };
    b.methods["clone"] = [](void* self, const Args&, Store& store) {
        const auto* track = as<KeyframeTrack>(self);
        return store.adopt(trackClass(track->type), std::make_shared<KeyframeTrack>(*track));
    };
}

// three's AnimationClip(name, duration = -1, tracks, blendMode). The clip holds copies of the
// tracks it is handed, and `tracks` answers each held track as itself.
// ponytail: editing a track after it is in a clip does not reach the clip; three's clip shares it.
void registerAnimationClip(ClassBinding& b) {
    using namespace tn::engine::animation;
    b.ctor = [](const Args& a, Store& store) {
        const std::string name = !a.empty() && a.at(0).kind == Value::Kind::String ? a.at(0).text : "";
        const double duration = a.size() > 1 && a.at(1).kind != Value::Kind::Undefined ? number(a.at(1)) : -1;
        std::vector<KeyframeTrack> tracks;
        if (a.size() > 2 && a.at(2).kind != Value::Kind::Undefined) {
            for (const Value& ref : refsOf(a.at(2))) {
                Object* found = store.find(ref);
                if (found == nullptr || (found->cls != "QuaternionKeyframeTrack" && found->cls != "VectorKeyframeTrack" &&
                                         found->cls != "NumberKeyframeTrack"))
                    throw Unsupported{"an AnimationClip's tracks must be keyframe tracks"};
                tracks.push_back(*static_cast<KeyframeTrack*>(found->ptr.get()));
            }
        }
        BlendMode mode = BlendMode::Normal;
        if (a.size() > 3 && a.at(3).kind != Value::Kind::Undefined) {
            const double m = number(a.at(3));  // NormalAnimationBlendMode 2500, AdditiveAnimationBlendMode 2501
            if (m != 2500 && m != 2501) throw Unsupported{"blendMode must be a three AnimationBlendMode"};
            mode = m == 2501 ? BlendMode::Additive : BlendMode::Normal;
        }
        return std::static_pointer_cast<void>(std::make_shared<AnimationClip>(name, duration, std::move(tracks), mode));
    };
    b.getters["name"] = [](void* self) { return Value{Value::Kind::String, 0, as<AnimationClip>(self)->name}; };
    b.getters["duration"] = [](void* self) { return Value::of(as<AnimationClip>(self)->duration); };
    b.members["tracks"] = [](void* self, const Args&, Store& store) {
        std::vector<Value> tracks;
        for (auto& track : as<AnimationClip>(self)->tracks) tracks.push_back(store.adoptAlias(trackClass(track.type), &track, self));
        return Value::array(std::move(tracks));
    };
}

// three's InstancedMesh(geometry, material, count): every matrix the identity, no colour attribute
// until setColorAt; the arrays are float32 and reach the GPU on `needsUpdate`.
void registerInstancedMesh(ClassBinding& b) {
    registerMesh(b);
    registerObjectBounds<InstancedMesh>(b);
    b.methods["computeBoundingSphere"] = [](void* self, const Args&, Store&) {
        as<InstancedMesh>(self)->computeBoundingSphere();
        return Value::undefined();
    };
    b.members["boundingSphere"] = [](void* self, const Args&, Store& store) {
        return store.share("Sphere", as<InstancedMesh>(self)->boundingSphere);
    };
    b.setters["boundingSphere"] = [](void* self, const Value& value, Store& store) {
        as<InstancedMesh>(self)->boundingSphere = value.kind == Value::Kind::Null ? nullptr : store.shared<Sphere>(value, "Sphere");
    };
    b.ctor = [](const Args& a, Store& store) -> std::shared_ptr<void> {
        std::shared_ptr<BufferGeometry> geometry;
        std::shared_ptr<Material> material;
        if (!a.empty() && a.at(0).kind == Value::Kind::Ref) geometry = geometryArg(store, a.at(0));
        if (a.size() >= 2 && a.at(1).kind == Value::Kind::Ref) material = materialArg(store, a.at(1));
        const double count = a.size() >= 3 ? number(a.at(2)) : 0;
        if (!(count >= 0 && count <= 16777216.0) || count != std::floor(count))
            throw Unsupported{"InstancedMesh count must be a whole number of instances"};
        return std::static_pointer_cast<void>(
            std::make_shared<InstancedMesh>(geometry, material, static_cast<uint32_t>(count)));
    };
    b.getters["count"] = [](void* self) { return Value::of(double(as<InstancedMesh>(self)->count)); };
    b.setters["count"] = [](void* self, const Value& v) {
        const double count = number(v);
        if (!(count >= 0 && count <= 4294967295.0) || count != std::floor(count))
            throw Unsupported{"InstancedMesh count must be a whole number of instances"};
        as<InstancedMesh>(self)->count = static_cast<uint32_t>(count);
    };
    b.members["instanceMatrix"] = [](void* self, const Args&, Store& store) -> Value {
        return store.share("InstancedBufferAttribute", as<InstancedMesh>(self)->instanceMatrix);
    };
    // three's instanceMatrix is a plain property too: core's projection hands a stand-in the source's buffer, so the
    // game's later setMatrixAt writes reach what draws.
    b.setters["instanceMatrix"] = [](void* self, const Value& v, Store& store) {
        std::shared_ptr<BufferAttribute> matrices = sharedAttributeArg(store, v);
        if (matrices->itemSize != 16) throw Unsupported{"instanceMatrix needs 16 components per instance"};
        as<InstancedMesh>(self)->instanceMatrix = std::move(matrices);
    };
    b.members["instanceColor"] = [](void* self, const Args&, Store& store) -> Value {
        const auto& colors = as<InstancedMesh>(self)->instanceColor;
        return colors ? store.share("InstancedBufferAttribute", colors) : Value{};
    };
    // three's instanceColor is a plain property: a game assigns its own InstancedBufferAttribute
    // (three components per instance), or null to drop the colours.
    b.setters["instanceColor"] = [](void* self, const Value& v, Store& store) {
        auto& mesh = *as<InstancedMesh>(self);
        if (v.kind == Value::Kind::Undefined || v.kind == Value::Kind::Null) {
            mesh.instanceColor = nullptr;
            return;
        }
        std::shared_ptr<BufferAttribute> colors = sharedAttributeArg(store, v);
        if (colors->itemSize != 3) throw Unsupported{"instanceColor needs 3 components per instance"};
        mesh.instanceColor = std::move(colors);
    };
    const auto index = [](const Value& v, const InstancedMesh& mesh) {
        const double i = number(v);
        if (!(i >= 0 && i < double(mesh.instanceMatrix->count())) || i != std::floor(i))
            throw Unsupported{"instance index outside the instance arrays"};
        return static_cast<uint32_t>(i);
    };
    b.methods["setMatrixAt"] = [index](void* self, const Args& a, Store& store) {
        InstancedMesh& mesh = *as<InstancedMesh>(self);
        mesh.setMatrixAt(index(a.at(0), mesh), store.ref<Matrix4>(a.at(1), "Matrix4"));
        return chain();
    };
    b.methods["getMatrixAt"] = [index](void* self, const Args& a, Store& store) {
        const InstancedMesh& mesh = *as<InstancedMesh>(self);
        mesh.getMatrixAt(index(a.at(0), mesh), store.ref<Matrix4>(a.at(1), "Matrix4"));
        return a.at(1);
    };
    b.methods["setColorAt"] = [index](void* self, const Args& a, Store& store) {
        InstancedMesh& mesh = *as<InstancedMesh>(self);
        mesh.setColorAt(index(a.at(0), mesh), store.ref<Color>(a.at(1), "Color"));
        return chain();
    };
    b.methods["getColorAt"] = [index](void* self, const Args& a, Store& store) {
        const InstancedMesh& mesh = *as<InstancedMesh>(self);
        mesh.getColorAt(index(a.at(0), mesh), store.ref<Color>(a.at(1), "Color"));
        return a.at(1);
    };
}

// three's BatchedMesh(maxInstanceCount, maxVertexCount, maxIndexCount = maxVertexCount * 2, material):
// the members core's projection uses, with three's refusals by three's messages.
void registerBatchedMesh(ClassBinding& b) {
    registerMesh(b);
    b.ctor = [](const Args& a, Store& store) -> std::shared_ptr<void> {
        const auto count = [&](std::size_t i, double fallback) {
            const double value = i < a.size() && a.at(i).kind == Value::Kind::Number ? a.at(i).number : fallback;
            if (!(value >= 0 && value <= 4294967295.0) || value != std::floor(value))
                throw Unsupported{"BatchedMesh sizes must be whole numbers"};
            return static_cast<uint32_t>(value);
        };
        const uint32_t instances = count(0, 0), vertices = count(1, 0), indices = count(2, double(vertices) * 2);
        std::shared_ptr<Material> material;
        if (a.size() >= 4 && a.at(3).kind == Value::Kind::Ref) material = materialArg(store, a.at(3));
        return std::static_pointer_cast<void>(detail::makeShared<BatchedMesh>(instances, vertices, indices, material));
    };
    const auto id = [](const Value& v) {
        const double i = number(v);
        if (!(i >= 0 && i <= 4294967295.0) || i != std::floor(i)) throw Unsupported{"BatchedMesh ids are whole numbers"};
        return static_cast<uint32_t>(i);
    };
    b.methods["addGeometry"] = [](void* self, const Args& a, Store& store) {
        const auto reserved = [&](std::size_t i) {
            return i < a.size() && a.at(i).kind == Value::Kind::Number ? int64_t(a.at(i).number) : int64_t{-1};
        };
        const auto geometry = geometryArg(store, a.at(0));
        return Value::of(double(as<BatchedMesh>(self)->addGeometry(*geometry, reserved(1), reserved(2))));
    };
    b.methods["addInstance"] = [id](void* self, const Args& a, Store&) {
        return Value::of(double(as<BatchedMesh>(self)->addInstance(id(a.at(0)))));
    };
    b.methods["deleteInstance"] = [id](void* self, const Args& a, Store&) {
        as<BatchedMesh>(self)->deleteInstance(id(a.at(0)));
        return chain();
    };
    b.methods["setMatrixAt"] = [id](void* self, const Args& a, Store& store) {
        as<BatchedMesh>(self)->setMatrixAt(id(a.at(0)), store.ref<Matrix4>(a.at(1), "Matrix4"));
        return chain();
    };
    b.methods["getMatrixAt"] = [id](void* self, const Args& a, Store& store) {
        as<BatchedMesh>(self)->getMatrixAt(id(a.at(0)), store.ref<Matrix4>(a.at(1), "Matrix4"));
        return a.at(1);
    };
    b.methods["setColorAt"] = [id](void* self, const Args& a, Store& store) {
        as<BatchedMesh>(self)->setColorAt(id(a.at(0)), store.ref<Color>(a.at(1), "Color"));
        return chain();
    };
    b.methods["getColorAt"] = [id](void* self, const Args& a, Store& store) {
        as<BatchedMesh>(self)->getColorAt(id(a.at(0)), store.ref<Color>(a.at(1), "Color"));
        return a.at(1);
    };
    b.methods["setVisibleAt"] = [id](void* self, const Args& a, Store&) {
        as<BatchedMesh>(self)->setVisibleAt(id(a.at(0)), flag(a.at(1)));
        return chain();
    };
    b.methods["getVisibleAt"] = [id](void* self, const Args& a, Store&) {
        return Value::of(as<BatchedMesh>(self)->getVisibleAt(id(a.at(0))));
    };
    b.getters["instanceCount"] = [](void* self) { return Value::of(double(as<BatchedMesh>(self)->instanceCount())); };
    b.getters["maxInstanceCount"] = [](void* self) { return Value::of(double(as<BatchedMesh>(self)->maxInstanceCount)); };
    for (const auto& [name, field] : {std::pair{"perObjectFrustumCulled", &BatchedMesh::perObjectFrustumCulled},
                                      std::pair{"sortObjects", &BatchedMesh::sortObjects}}) {
        b.getters[name] = [field](void* self) { return Value::of(as<BatchedMesh>(self)->*field); };
        b.setters[name] = [field](void* self, const Value& v) { as<BatchedMesh>(self)->*field = flag(v); };
    }
}

}  // namespace

void registerEventBindings(ClassBinding& binding, EventDispatcher* (*dispatcher)(void*),
                           std::initializer_list<const char*> types) {
    registerEvents(binding, dispatcher, types);
}

std::string& pendingListenerError() {
    thread_local std::string error;
    return error;
}

/**
 * An Object3D argument of any scene class. `Store::ref` matches one class name, and a Mesh is a
 * valid child of a Group, so the argument is matched against the classes the scene graph owns.
 */
Object3D& objectArg(Store& store, const Value& arg) {
    Object* found = store.find(arg);
    if (found == nullptr) throw Unsupported{"argument is not an Object3D"};
    if (!isObject3DClass(found->cls)) throw Unsupported{"argument is not an Object3D, it is a " + found->cls};
    return *static_cast<Object3D*>(found->ptr.get());
}

void registerObject3DBindings(ClassBinding& b) {
    registerObject3D(b);
}

void registerSceneBindings(Registry& classes) {
    for (const auto* name : {"project", "unproject"}) {
        classes["Vector3"].methods[name] = [name](void* self, const Args& a, Store& store) {
            const auto* camera = dynamic_cast<Camera*>(&objectArg(store, a.at(0)));
            if (!camera) throw Unsupported{"Vector3 projection needs a Camera"};
            if (std::string_view(name) == "project") as<Vector3>(self)->project(*camera);
            else as<Vector3>(self)->unproject(*camera);
            return chain();
        };
    }
    for (const auto* name : {"setFromObject", "expandByObject"}) {
        classes["Box3"].methods[name] = [name](void* self, const Args& a, Store& store) {
            auto& object = objectArg(store, a.at(0));
            const bool precise = boolean(a, 1, false);
            if (std::string_view(name) == "setFromObject") as<Box3>(self)->setFromObject(object, precise);
            else as<Box3>(self)->expandByObject(object, precise);
            return chain();
        };
    }
    registerObject3D(classes["Object3D"]);
    registerCamera(classes["Camera"]);
    registerPerspectiveCamera(classes["PerspectiveCamera"]);
    registerOrthographicCamera(classes["OrthographicCamera"]);
    registerScene(classes["Scene"]);
    registerFog(classes["Fog"], false);
    registerFog(classes["FogExp2"], true);
    registerGroup(classes["Group"]);
    registerLayers(classes["Layers"]);
    registerRaycaster(classes["Raycaster"]);
    registerLOD(classes["LOD"]);
    registerMesh(classes["Mesh"]);
    registerInstancedMesh(classes["InstancedMesh"]);
    registerBatchedMesh(classes["BatchedMesh"]);
    for (const char* name : {"Line", "LineSegments"}) {
        auto& line = classes[name];
        registerMesh(line);
        line.methods.erase("getVertexPosition");  // three's Line is no Mesh: it has no vertex reader
        const bool segments = std::string_view(name) == "LineSegments";
        line.ctor = [segments](const Args& a, Store& store) {
            auto geometry = !a.empty() && a.at(0).kind == Value::Kind::Ref ? geometryArg(store, a.at(0))
                                                                           : std::make_shared<BufferGeometry>();
            auto material = a.size() >= 2 && a.at(1).kind == Value::Kind::Ref ? materialArg(store, a.at(1)) : nullptr;
            if (!material) {  // three's default: a new LineBasicMaterial
                material = std::make_shared<Material>(MaterialType::Basic);
                material->lineMaterial = true;
            }
            if (segments) return std::static_pointer_cast<void>(std::make_shared<LineSegments>(geometry, material));
            return std::static_pointer_cast<void>(std::make_shared<Line>(geometry, material));
        };
    }
    auto& sprite = classes["Sprite"];
    registerMesh(sprite);
    sprite.methods.erase("getVertexPosition");  // three's Sprite is no Mesh: it has no vertex reader
    sprite.ctor = [](const Args& a, Store& store) {
        return std::static_pointer_cast<void>(std::make_shared<Sprite>(a.empty() ? nullptr : materialArg(store, a.at(0))));
    };
    sprite.getters["count"] = [](void* self) { return Value::of(double(as<Sprite>(self)->count)); };
    sprite.setters["count"] = [](void* self, const Value& v) {
        const double n = number(v);
        if (!std::isfinite(n) || n < 0 || n != std::floor(n) || n > UINT32_MAX) throw Unsupported{"Sprite count must be a whole number of instances"};
        as<Sprite>(self)->count = static_cast<uint32_t>(n);
    };
    for (int i = 0; i < 2; ++i) {
        const std::string path = i == 0 ? "center.x" : "center.y";
        sprite.getters[path] = [i](void* self) { const auto& c = as<Sprite>(self)->center; return Value::of(i == 0 ? c.x : c.y); };
        sprite.setters[path] = [i](void* self, const Value& v) { auto& c = as<Sprite>(self)->center; (i == 0 ? c.x : c.y) = number(v); };
    }
    registerBone(classes["Bone"]);
    registerSkeleton(classes["Skeleton"]);
    // three's SkeletonUtils namespace: clone(root) copies the hierarchy, shares mesh resources and
    // remaps each skin to the cloned bones. A namespace class, exported as its one instance.
    ClassBinding& skeletonUtils = classes["SkeletonUtils"];
    skeletonUtils.ctor = [](const Args&, Store&) { return std::make_shared<int>(0); };
    skeletonUtils.methods["clone"] = [](void*, const Args& a, Store& store) {
        std::string error;
        std::shared_ptr<Object3D> copy = cloneSkeleton(objectArg(store, a.at(0)), error);
        if (!copy) throw Unsupported{error};
        const std::string type(copy->type());
        return store.adopt(type, std::static_pointer_cast<void>(copy));
    };
    registerSkinnedMesh(classes["SkinnedMesh"]);
    registerAnimationMixer(classes["AnimationMixer"]);
    registerAnimationAction(classes["AnimationAction"]);
    registerPropertyBinding(classes["PropertyBinding"]);
    registerAnimationClip(classes["AnimationClip"]);
    registerKeyframeTrack(classes["QuaternionKeyframeTrack"], tn::engine::animation::TrackType::Quaternion);
    registerKeyframeTrack(classes["VectorKeyframeTrack"], tn::engine::animation::TrackType::Vector);
    registerKeyframeTrack(classes["NumberKeyframeTrack"], tn::engine::animation::TrackType::Number);
}

}  // namespace tn::binding
