#pragma once

// The engine's one binding model (PRD-500 / PRD-531): each native class registers a constructor,
// methods, getters and setters once, and every caller drives the same registry — the differential
// fixture driver by string ids, the C ABI (and the VMs above it: V8, browser JS over Wasm) by
// handles. A caller implements Store; a binding never knows which caller it serves.

#include <cstdint>
#include <functional>
#include <limits>
#include <map>
#include <set>
#include <memory>
#include <string>
#include <string_view>
#include <type_traits>
#include <vector>

#include "engine/scene/object3d.h"
#include "engine/shader/graph/graph.h"

namespace tn::binding {

struct Value {
    enum class Kind : uint8_t { Null, Number, String, Bool, Ref, Numbers, Refs, Array, Record, Undefined, ShaderNode };
    // A named constructor keeps pair's default-constructibility trait from recursively
    // instantiating an aggregate Value before the pair is complete (Clang + libstdc++ 16).
    Value() = default;
    Value(Kind kind, double number = 0, std::string text = {}, bool flag = false,
          std::vector<double> numbers = {})
        : kind(kind), number(number), text(std::move(text)), flag(flag), numbers(std::move(numbers)) {}

    Kind kind = Kind::Null;
    double number = 0;
    // String payload; the caller's object id for Ref; comma-separated ids for Refs (an array of
    // objects, as `new Skeleton(bones)` takes); for Numbers, the typed array they came as, if any.
    std::string text;
    bool flag = false;
    std::vector<double> numbers;  // a numeric array (`elements`, `toArray()`)
    // A typed array's own bytes, in place of `numbers`, for a constructor that keeps them
    // (ClassBinding::ctorTakesBytes); `text` names the array. Valid for the call only.
    std::string_view bytes;

    engine::shader::graph::Node node;
    static Value shaderNode(engine::shader::graph::Node node) { Value v; v.kind = node ? Kind::ShaderNode : Kind::Null; v.node = std::move(node); return v; }

    std::vector<Value> items;
    std::vector<std::pair<std::string, Value>> fields;
    static Value array(std::vector<Value> items) { Value v; v.kind = Kind::Array; v.items = std::move(items); return v; }
    static Value record(std::vector<std::pair<std::string, Value>> fields) { Value v; v.kind = Kind::Record; v.fields = std::move(fields); return v; }

    static Value undefined() { Value v; v.kind = Kind::Undefined; return v; }
    static Value of(double n) { return Value{Kind::Number, n}; }
    static Value of(bool b) { return Value{Kind::Bool, 0, {}, b}; }
    static Value list(std::vector<double> values) { return Value{Kind::Numbers, 0, {}, false, std::move(values)}; }
};

struct ClassBinding;
class Store;

/** A typed array's element size, by its name (`Float32Array`); 0 for a name that is not one. */
size_t typedArrayElementBytes(std::string_view type);
/** The numbers a typed array's bytes hold, by its name; the name must have an element size. */
std::vector<double> typedArrayNumbers(std::string_view type, std::string_view bytes);

/** A language listener for one event type: called with the event as one Record value. */
using EventCallback = std::shared_ptr<const std::function<bool(const Value& event, std::string& error)>>;

/** A native object as a caller holds it: its class name and shared ownership of the value. */
struct Object {
    std::string cls;
    std::shared_ptr<void> ptr;
    /** The registry entry for `cls`, found once by the ABI on the first call and kept (the registry is immutable). */
    mutable const ClassBinding* binding = nullptr;
};

/** Only registered classes backed by engine::Material may unwrap as that base type. */
inline bool isMaterialClass(std::string_view cls) {
    return cls == "SpriteMaterial" || cls == "SpriteNodeMaterial" || cls == "LineBasicMaterial" || cls == "Material" ||
           cls == "MeshBasicMaterial" || cls == "MeshLambertMaterial" ||
           cls == "MeshPhongMaterial" || cls == "MeshStandardMaterial" || cls == "MeshPhysicalMaterial" ||
           cls == "MeshBasicNodeMaterial" || cls == "MeshStandardNodeMaterial";
}

/** The engine's scene-graph classes: an Object3D argument (add, a render root) may be any of them. */
inline bool isObject3DClass(std::string_view cls) {
    static constexpr std::string_view kClasses[] = {
        "Object3D",   "Group",       "Mesh",          "Scene",      "Camera",       "PerspectiveCamera",
        "OrthographicCamera", "AmbientLight", "DirectionalLight", "HemisphereLight", "InstancedMesh",
        "PointLight", "Sprite",      "SpotLight",     "Bone",       "SkinnedMesh",  "LOD",
        "Line",       "LineSegments", "BatchedMesh"};
    for (const std::string_view known : kClasses)
        if (cls == known) return true;
    return false;
}

/** The engine texture classes a texture argument (a map, a background, a TSL texture) may be. */
inline bool isTextureClass(std::string_view cls) {
    return cls == "Texture" || cls == "DataTexture" || cls == "CanvasTexture";
}

inline bool acceptsClass(std::string_view actual, std::string_view expected) {
    return actual == expected || (expected == "Material" && isMaterialClass(actual));
}

/**
 * Thrown inside a binding when a call asks for something the native class does not support. It is
 * caught at the caller's boundary and becomes `unsupported` (driver) or TN_ERROR_UNSUPPORTED (ABI);
 * it never crosses the C ABI.
 */
struct Unsupported {
    std::string reason;
};

class Store;
using Args = std::vector<Value>;
using Ctor = std::function<std::shared_ptr<void>(const Args&, Store&)>;
/** Returns a value, or chain() to return the object it was called on. */
using Method = std::function<Value(void* self, const Args&, Store&)>;
using Getter = std::function<Value(void* self)>;

/**
 * A property write. Most setters need only the value; a member object's whole-value write
 * (`material.color = ref`, `scene.background = ref`) must resolve a Ref through the caller's Store,
 * so every call passes the caller's Store. A two-argument callable still fits: it ignores the Store.
 */
class Setter {
public:
    Setter() = default;
    template <typename F,
              typename = std::enable_if_t<std::is_invocable_v<F&, void*, const Value&> ||
                                          std::is_invocable_v<F&, void*, const Value&, Store&>>>
    Setter(F fn) : fn_(wrap(std::move(fn))) {}

    void operator()(void* self, const Value& value, Store& store) const { fn_(self, value, store); }
    explicit operator bool() const { return static_cast<bool>(fn_); }

private:
    /** A three-argument callable is kept as-is; a two-argument one ignores the store it is handed. */
    template <typename F>
    static std::function<void(void*, const Value&, Store&)> wrap(F fn) {
        if constexpr (std::is_invocable_v<F&, void*, const Value&, Store&>) {
            return std::function<void(void*, const Value&, Store&)>(std::move(fn));
        } else {
            return [fn = std::move(fn)](void* self, const Value& value, Store&) { fn(self, value); };
        }
    }

    std::function<void(void*, const Value&, Store&)> fn_;
};

struct ClassBinding {
    Ctor ctor;
    // The constructor reads a typed array argument as Value::bytes, so it is not widened to doubles.
    bool ctorTakesBytes = false;
    // The setters that read a typed array value as Value::bytes in the same way.
    std::set<std::string> settersTakeBytes;
    std::map<std::string, Method> methods;
    std::map<std::string, Getter> getters;  // keyed by full path: "x", "position.x", "matrixWorld.elements"
    std::map<std::string, Setter> setters;
    // Member objects (`position`, `matrixWorld`): read as properties, answered with the one alias Ref
    // of that member (memberAlias), so they need the Store a plain getter does not get.
    std::map<std::string, Method> members;
    // The members that name a field of the object itself (`position`, `material.color`): the same
    // object for the owner's whole life, so a caller may keep the Ref it got the first time. A member
    // that can be reassigned (`mesh.material`, `geometry.attributes.position`) is never listed.
    std::set<std::string> fixedMembers;
    // Doubles the object holds in place (`x`, `r`, `radius`, `elements`): byte offset from `__address`
    // and count; a count of 0 is one bool byte (`visible`). A back end that shares the engine's memory
    // (Wasm) reads them there instead of calling the getter of the same name; writes still go
    // through the setter, which the engine reacts to.
    // A class with fields also answers the engine-internal getter `__address`, as a number: self, or
    // where its fields start when they sit after pointers. The registry is dumped by a 64-bit build
    // and read by the 32-bit Wasm one, so an offset must not depend on pointer size.
    std::map<std::string, std::pair<uint32_t, uint32_t>> fields;
    // Callbacks a language sets on the object (`onBeforeRender`): set through tn_set_callback, never
    // a Value, because the engine calls back into the language that set them.
    std::map<std::string, std::function<void(void* self, tn::engine::RenderCallback)>> callbacks;
    // Event types a language listens for (`mixer.addEventListener("finished", fn)`), set through
    // tn_set_callback by type name; a null callback stops listening. The event arrives as a Record.
    std::map<std::string, std::function<void(void* self, EventCallback, Store&)>> events;
};

/** A language listener's failure inside an engine call (Object3D's graph events): the ABI call that
 *  set it off reports it once it returns, whichever method moved the graph (add, LOD.addLevel, ...). */
std::string& pendingListenerError();

/** Registers a member that names a field of the object itself (see ClassBinding::fixedMembers). */
inline void fixedMember(ClassBinding& b, const std::string& name, Method member) {
    b.members[name] = std::move(member);
    b.fixedMembers.insert(name);
}

using Registry = std::map<std::string, ClassBinding>;

/** What a binding needs from its caller: resolve an argument to an object, and adopt a new one. */
class Store {
public:
    virtual ~Store() = default;
    /** The object a Ref argument names, or null. */
    virtual Object* find(const Value& arg) = 0;
    /** Hands a new native object back to the caller as a Ref value. */
    virtual Value adopt(std::string cls, std::shared_ptr<void> ptr) = 0;
    /**
     * Hands back a member object (`object.position`) as the Ref value naming *that* member: the same
     * Ref on every call, because the member is not copied and does not move. `owner` is the pointer
     * the binding was called on, which the caller holds the shared ownership of; the returned Ref
     * keeps that owner alive, so an alias carries no lifetime of its own.
     */
    virtual Value adoptAlias(std::string cls, void* member, void* owner) = 0;
    /**
     * Hands back an object the engine shares ownership of (`geometry.attributes.position`,
     * `mesh.material`, `scene.background`) as its one Ref: the same Ref while it lives, and the Ref
     * holds the object itself, so it stays valid after the engine lets go of it (a deleted attribute,
     * a replaced background), as a JS reference to a three object does. A null object is null.
     */
    virtual Value share(std::string cls, std::shared_ptr<void> object) = 0;
    /** The numeric array a Ref names when it holds one (a boxed toArray() result); empty otherwise. */
    virtual std::vector<double> numbers(const Value& arg) = 0;

    /** Resolves a Ref argument to shared ownership of its object, refusing a class mismatch. */
    template <typename T>
    std::shared_ptr<T> shared(const Value& arg, const char* cls) {
        Object* object = find(arg);
        if (!object || !acceptsClass(object->cls, cls)) throw Unsupported{std::string("argument is not a ") + cls};
        return std::static_pointer_cast<T>(object->ptr);
    }

    /** Resolves a Ref argument, refusing a class mismatch. */
    template <typename T>
    T& ref(const Value& arg, const char* cls) {
        Object* object = find(arg);
        if (!object || !acceptsClass(object->cls, cls)) throw Unsupported{std::string("argument is not a ") + cls};
        return *static_cast<T*>(object->ptr.get());
    }

    /**
     * A read-only argument (`v.copy(source)`, `v.add(other)`): an engine `cls`, or, for a vector, any
     * plain object with its fields, as three's methods read `source.x`, `source.y`... A missing field
     * reads NaN: three stores the `undefined` and its arithmetic then reads NaN. A plain object is
     * read into `scratch`.
     * Never for an output argument (`getWorldPosition(target)`), which three writes into.
     */
    template <typename T>
    const T& in(const Value& arg, const char* cls, T& scratch) {
        constexpr bool vector = std::is_same_v<T, engine::Vector2> || std::is_same_v<T, engine::Vector3> ||
                                std::is_same_v<T, engine::Vector4>;
        if constexpr (vector) {
            if (arg.kind == Value::Kind::Record) {
                const auto field = [&](const char* name) {
                    for (const auto& [key, value] : arg.fields) {
                        if (key != name) continue;
                        if (value.kind != Value::Kind::Number)
                            throw Unsupported{std::string("argument is not a ") + cls + ": " + name + " is not a number"};
                        return value.number;
                    }
                    return std::numeric_limits<double>::quiet_NaN();
                };
                scratch.x = field("x");
                scratch.y = field("y");
                if constexpr (!std::is_same_v<T, engine::Vector2>) scratch.z = field("z");
                if constexpr (std::is_same_v<T, engine::Vector4>) scratch.w = field("w");
                return scratch;
            }
        }
        return ref<T>(arg, cls);
    }
};

/**
 * A numeric array argument as doubles: a Numbers value, or a mixed Array (Euler.toArray()'s
 * [x, y, z, order]) whose non-number items read as NaN, as `+"XYZ"` does. Anything else is empty.
 */
inline std::vector<double> numbersOf(const Value& v) {
    if (v.kind == Value::Kind::Numbers) return v.numbers;
    std::vector<double> out;
    if (v.kind == Value::Kind::Array)
        for (const auto& item : v.items)
            out.push_back(item.kind == Value::Kind::Number ? item.number : std::numeric_limits<double>::quiet_NaN());
    return out;
}

/** Each Ref in a Refs argument, in order. */
inline std::vector<Value> refsOf(const Value& v) {
    std::vector<Value> out;
    if (v.kind == Value::Kind::Array) {
        for (const auto& item : v.items) {
            if (item.kind != Value::Kind::Ref) throw Unsupported{"object array contains a non-object"};
            out.push_back(item);
        }
        return out;
    }
    if (v.kind == Value::Kind::Numbers && v.numbers.empty()) return out;
    if (v.kind != Value::Kind::Refs) throw Unsupported{"argument is not an object array"};
    std::size_t start = 0;
    while (start < v.text.size()) {
        std::size_t end = v.text.find(',', start);
        if (end == std::string::npos) end = v.text.size();
        out.push_back(Value{Value::Kind::Ref, 0, v.text.substr(start, end - start)});
        start = end + 1;
    }
    return out;
}

/** The value a chaining method returns: the object it was called on. */
inline Value chain() { return Value{Value::Kind::Ref, 0, "\x01self"}; }

/** The Ref for a member object of the object a binding was called on; registered in `members`. */
template <typename T>
Value memberAlias(Store& store, void* self, T& member, const char* cls) {
    return store.adoptAlias(cls, &member, self);
}

inline double number(const Value& v) {
    if (v.kind != Value::Kind::Number) throw Unsupported{"expected a number"};
    return v.number;
}

}  // namespace tn::binding
