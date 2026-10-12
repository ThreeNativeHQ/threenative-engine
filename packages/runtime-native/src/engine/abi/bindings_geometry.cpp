// BufferGeometry, BufferAttribute and the geometry generators in the engine's one binding registry
// (PRD-508 phase 3). Members (`attributes.position`, `index`, `boundingBox`, `boundingSphere`) are
// read as Refs to the member itself, so a caller writes through the object rather than a copy; plain
// values (`array`, `parameters`, `groups`) are getters.

#include "engine/abi/bindings.h"

#include "engine/foundation/math/Matrix.h"
#include "engine/scene/geometry.h"
#include "engine/scene/geometries.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>
#include <memory>
#include <string>
#include <vector>

namespace tn::binding {

using namespace tn::engine;

namespace {

double optional(const Args& a, size_t i, double fallback) {
    return i < a.size() ? number(a.at(i)) : fallback;
}

bool flag(const Value& v) { return v.kind == Value::Kind::Bool ? v.flag : number(v) != 0; }

bool boolean(const Args& a, size_t i, bool fallback) {
    return i < a.size() ? flag(a.at(i)) : fallback;
}

template <typename T>
T* as(void* self) {
    return static_cast<T*>(self);
}

Value numbers(const std::vector<double>& values) { return Value::list(values); }

/** Any geometry class a fixture can name, matched against one base pointer. */
BufferGeometry& geometryArg(Store& store, const Value& arg) {
    static const char* const kClasses[] = {
        "BufferGeometry", "PlaneGeometry",  "BoxGeometry",   "SphereGeometry", "CylinderGeometry",
        "ConeGeometry",   "CircleGeometry", "TorusGeometry", "RingGeometry", "RoundedBoxGeometry", "LatheGeometry",
        "TubeGeometry", "ShapeGeometry", "ExtrudeGeometry", "IcosahedronGeometry", "CapsuleGeometry",
        "DodecahedronGeometry", "OctahedronGeometry", "TorusKnotGeometry", "InstancedBufferGeometry"};
    Object* found = store.find(arg);
    if (found == nullptr) throw Unsupported{"argument is not a BufferGeometry"};
    for (const char* cls : kClasses) {
        if (found->cls == cls) return *static_cast<BufferGeometry*>(found->ptr.get());
    }
    throw Unsupported{"argument is not a BufferGeometry, it is a " + found->cls};
}

/** Any buffer attribute class a fixture can name, matched against one base pointer. */
/**
 * A JS array index: a non-negative safe integer. Anything else (a fraction, a negative number, NaN)
 * names no element, so it maps to an index past every array: reads answer undefined and writes do
 * nothing, as typed-array access does.
 */
uint64_t jsIndex(const Value& v) {
    const double i = number(v);
    if (!(i >= 0 && i <= 9007199254740991.0) || i != std::floor(i)) return UINT64_MAX;
    return static_cast<uint64_t>(i);
}

int jsComponent(const Value& v) {
    const double c = number(v);
    return (c >= 0 && c < 2147483647.0 && c == std::floor(c)) ? static_cast<int>(c) : -1;  // -1 names nothing
}

/** One component, or undefined (null) past the end of the array. */
Value component(const BufferAttribute& attribute, uint64_t index, int c) {
    uint64_t at = 0;
    return attribute.element(index, c, at) ? Value::of(attribute.getComponent(index, c)) : Value{};
}

}  // namespace

/** The caller's attribute itself (not a copy): three stores the reference it is handed. */
std::shared_ptr<BufferAttribute> sharedAttributeArg(Store& store, const Value& arg) {
    Object* found = store.find(arg);
    if (found == nullptr) throw Unsupported{"argument is not a BufferAttribute"};
    if (found->cls == "BufferAttribute" || found->cls == "Float32BufferAttribute" ||
        found->cls == "Uint16BufferAttribute" || found->cls == "Uint32BufferAttribute" ||
        found->cls == "InstancedBufferAttribute") {
        return std::static_pointer_cast<BufferAttribute>(found->ptr);
    }
    throw Unsupported{"argument is not a BufferAttribute, it is a " + found->cls};
}

size_t typedArrayElementBytes(std::string_view type) {
    if (type == "Float32Array" || type == "Int32Array" || type == "Uint32Array") return 4;
    if (type == "Uint16Array" || type == "Int16Array") return 2;
    if (type == "Uint8Array" || type == "Int8Array" || type == "Uint8ClampedArray") return 1;
    return type == "Float64Array" ? 8 : 0;
}

namespace {
template <class T>
std::vector<double> widen(std::string_view bytes) {
    std::vector<double> out(bytes.size() / sizeof(T));
    for (size_t i = 0; i < out.size(); ++i) {
        T value;
        std::memcpy(&value, bytes.data() + i * sizeof(T), sizeof(T));  // the bytes need not be aligned
        out[i] = static_cast<double>(value);
    }
    return out;
}
}  // namespace

std::vector<double> typedArrayNumbers(std::string_view type, std::string_view bytes) {
    if (type == "Float32Array") return widen<float>(bytes);
    if (type == "Float64Array") return widen<double>(bytes);
    if (type == "Int32Array") return widen<int32_t>(bytes);
    if (type == "Uint32Array") return widen<uint32_t>(bytes);
    if (type == "Int16Array") return widen<int16_t>(bytes);
    if (type == "Uint16Array") return widen<uint16_t>(bytes);
    if (type == "Int8Array") return widen<int8_t>(bytes);
    return widen<uint8_t>(bytes);  // Uint8Array, Uint8ClampedArray
}

namespace {

BufferAttribute& attributeArg(Store& store, const Value& arg) {
    Object* found = store.find(arg);
    if (found == nullptr) throw Unsupported{"argument is not a BufferAttribute"};
    if (found->cls == "BufferAttribute" || found->cls == "Float32BufferAttribute" ||
        found->cls == "Uint16BufferAttribute" || found->cls == "Uint32BufferAttribute" ||
        found->cls == "InstancedBufferAttribute") {
        return *static_cast<BufferAttribute*>(found->ptr.get());
    }
    throw Unsupported{"argument is not a BufferAttribute, it is a " + found->cls};
}

Value string(std::string text) { return Value{Value::Kind::String, 0, std::move(text)}; }

// Float data shares as three's Float32BufferAttribute, so an `instanceof` test answers the array
// type without copying the array out of the engine.
Value shareAttribute(Store& store, const std::shared_ptr<BufferAttribute>& attribute) {
    const bool float32 = attribute != nullptr && !attribute->perInstance && attribute->store->scalar() == Scalar::F32;
    return store.share(float32 ? "Float32BufferAttribute" : "BufferAttribute", attribute);
}

// count, itemSize, normalized (0 or 1) and gpuType: the web surface reads the shape with one call.
Value shapeOf(const BufferAttribute& attribute) {
    return numbers({double(attribute.count()), double(attribute.itemSize), attribute.normalized ? 1.0 : 0.0,
                    double(attribute.gpuType)});
}

/** `updateRanges` as canonical JSON (`[{"count":N,"start":M}, ...]`), three's array of records. */
Value updateRangesJson(const BufferAttribute& attribute) {
    std::string json = "[";
    bool first = true;
    for (const UpdateRange& range : attribute.updateRanges()) {
        if (!first) json += ",";
        first = false;
        json += "{\"count\":" + std::to_string(range.count) + ",\"start\":" +
                std::to_string(range.start) + "}";
    }
    json += "]";
    return string(std::move(json));
}

Value attributeArray(const BufferGeometry& geometry, const char* name) {
    const std::shared_ptr<BufferAttribute> attribute = geometry.getAttribute(name);
    if (attribute == nullptr) throw Unsupported{std::string("this geometry has no ") + name + " attribute"};
    return numbers(attribute->toNumbers());
}


// ---------------------------------------------------------------- BufferAttribute

void registerBufferAttribute(ClassBinding& b, const char* cls) {
    b.ctorTakesBytes = true;
    b.ctor = [cls](const Args& a, Store&) {
        // fromDoubles reads the list in place; copying a vertex buffer here cost a malloc and a memcpy.
        static const std::vector<double> none;
        const bool list = !a.empty() && a.at(0).kind == Value::Kind::Numbers;
        const std::string_view bytes = list ? a.at(0).bytes : std::string_view();
        // BufferAttribute( array, itemSize, normalized = false ); itemSize is a positive integer.
        const double itemSize = optional(a, 1, 1);
        if (!(itemSize >= 1 && itemSize <= 65536) || itemSize != std::floor(itemSize)) throw Unsupported{"itemSize must be a positive integer"};
        const bool normalized = a.size() > 2 && flag(a.at(2));
        // The typed array it was given decides the storage, as three keeps the array it is handed.
        const std::string& array = a.empty() ? std::string() : a.at(0).text;
        const Scalar scalar = array == "Uint8Array"    ? Scalar::U8
                              : array == "Uint16Array" ? Scalar::U16
                              : array == "Uint32Array" ? Scalar::U32
                                                       : Scalar::F32;
        // A typed array whose storage is its own type is copied as it is; any other is read as numbers.
        const bool same = array == (scalar == Scalar::U8    ? "Uint8Array"
                                    : scalar == Scalar::U16 ? "Uint16Array"
                                    : scalar == Scalar::U32 ? "Uint32Array"
                                                            : "Float32Array");
        // A count with no bytes or numbers: the caller writes the contents later (tnw_attribute_defer).
        const double deferred = list && bytes.empty() && a.at(0).numbers.empty() ? a.at(0).number : 0;
        if (deferred > 0 && !same) throw Unsupported{"deferred contents need storage of the array's own type"};
        std::shared_ptr<BufferAttribute> attribute;
        if (deferred > 0) {
            attribute = std::make_shared<BufferAttribute>(scalar, static_cast<uint64_t>(deferred), static_cast<int>(itemSize), normalized);
        } else if (same && !bytes.empty()) {
            attribute = std::make_shared<BufferAttribute>(scalar, bytes.size() / typedArrayElementBytes(array),
                                                          static_cast<int>(itemSize), normalized);
            attribute->store->write(0, bytes.data(), bytes.size());
        } else if (!bytes.empty()) {
            attribute = BufferAttribute::fromDoubles(scalar, typedArrayNumbers(array, bytes), static_cast<int>(itemSize), normalized);
        } else {
            attribute = BufferAttribute::fromDoubles(scalar, list ? a.at(0).numbers : none, static_cast<int>(itemSize), normalized);
        }
        attribute->perInstance = std::string_view(cls) == "InstancedBufferAttribute";
        return std::static_pointer_cast<void>(attribute);
    };
    b.getters["array"] = [](void* self) { return numbers(as<BufferAttribute>(self)->toNumbers()); };
    b.getters["array.length"] = [](void* self) {
        return Value::of(double(as<BufferAttribute>(self)->store->count()));
    };
    b.getters["count"] = [](void* self) { return Value::of(double(as<BufferAttribute>(self)->count())); };
    b.getters["itemSize"] = [](void* self) { return Value::of(double(as<BufferAttribute>(self)->itemSize)); };
    b.getters["normalized"] = [](void* self) { return Value::of(as<BufferAttribute>(self)->normalized); };
    b.getters["__shape"] = [](void* self) { return shapeOf(*as<BufferAttribute>(self)); };
    b.getters["usage"] = [](void* self) { return Value::of(double(as<BufferAttribute>(self)->usage)); };
    // three's usage is a hint the WebGPU backend keeps and the engine uploads on needsUpdate either
    // way; a value that is none of three's nine *Usage constants is refused.
    const auto setUsage = [](void* self, const Value& v) {
        const double usage = number(v);
        if (usage < 35040 || usage > 35050 || usage == 35043 || usage == 35047 || usage != std::floor(usage))
            throw Unsupported{"usage must be one of three's *DrawUsage, *ReadUsage or *CopyUsage constants"};
        as<BufferAttribute>(self)->usage = static_cast<uint32_t>(usage);
    };
    b.setters["usage"] = setUsage;
    b.methods["setUsage"] = [setUsage](void* self, const Args& a, Store&) {
        setUsage(self, a.at(0));
        return chain();
    };
    b.getters["gpuType"] = [](void* self) { return Value::of(double(as<BufferAttribute>(self)->gpuType)); };
    b.getters["version"] = [](void* self) { return Value::of(double(as<BufferAttribute>(self)->version())); };
    b.getters["updateRanges"] = [](void* self) { return updateRangesJson(*as<BufferAttribute>(self)); };
    b.getters["id"] = [](void* self) { return Value::of(double(as<BufferAttribute>(self)->id)); };
    b.getters["name"] = [](void* self) { return string(as<BufferAttribute>(self)->name); };
    b.setters["name"] = [](void* self, const Value& v) {
        if (v.kind != Value::Kind::String) throw Unsupported{"name must be a string"};
        as<BufferAttribute>(self)->name = v.text;
    };
    b.setters["needsUpdate"] = [](void* self, const Value& v) {
        if (flag(v)) as<BufferAttribute>(self)->setNeedsUpdate();
    };

    // three's clone(): an attribute of the same class holding a copy of the array.
    b.methods["clone"] = [cls](void* self, const Args&, Store& store) {
        return store.adopt(cls, std::static_pointer_cast<void>(as<BufferAttribute>(self)->clone()));
    };
    b.methods["getX"] = [](void* self, const Args& a, Store&) {
        return component(*as<BufferAttribute>(self), jsIndex(a.at(0)), 0);
    };
    b.methods["getY"] = [](void* self, const Args& a, Store&) {
        return component(*as<BufferAttribute>(self), jsIndex(a.at(0)), 1);
    };
    b.methods["getZ"] = [](void* self, const Args& a, Store&) {
        return component(*as<BufferAttribute>(self), jsIndex(a.at(0)), 2);
    };
    b.methods["getW"] = [](void* self, const Args& a, Store&) {
        return component(*as<BufferAttribute>(self), jsIndex(a.at(0)), 3);
    };
    b.methods["getComponent"] = [](void* self, const Args& a, Store&) {
        const double c = number(a.at(1));
        if (!(c >= 0 && c < 2147483647.0) || c != std::floor(c)) return Value{};
        return component(*as<BufferAttribute>(self), jsIndex(a.at(0)), static_cast<int>(c));
    };
    b.methods["addUpdateRange"] = [](void* self, const Args& a, Store&) {
        const uint64_t start = jsIndex(a.at(0));
        const uint64_t count = jsIndex(a.at(1));
        if (start == UINT64_MAX || count == UINT64_MAX)
            throw Unsupported{"addUpdateRange takes a non-negative integer start and count"};
        as<BufferAttribute>(self)->addUpdateRange(start, count);
        return chain();
    };
    b.methods["clearUpdateRanges"] = [](void* self, const Args&, Store&) {
        as<BufferAttribute>(self)->clearUpdateRanges();
        return chain();
    };
    b.methods["setComponent"] = [](void* self, const Args& a, Store&) {
        as<BufferAttribute>(self)->setComponent(jsIndex(a.at(0)),
                                                jsComponent(a.at(1)), number(a.at(2)));
        return chain();
    };
    b.methods["setX"] = [](void* self, const Args& a, Store&) {
        as<BufferAttribute>(self)->setX(jsIndex(a.at(0)), number(a.at(1)));
        return chain();
    };
    b.methods["setY"] = [](void* self, const Args& a, Store&) {
        as<BufferAttribute>(self)->setY(jsIndex(a.at(0)), number(a.at(1)));
        return chain();
    };
    b.methods["setZ"] = [](void* self, const Args& a, Store&) {
        as<BufferAttribute>(self)->setZ(jsIndex(a.at(0)), number(a.at(1)));
        return chain();
    };
    b.methods["setW"] = [](void* self, const Args& a, Store&) {
        as<BufferAttribute>(self)->setW(jsIndex(a.at(0)), number(a.at(1)));
        return chain();
    };
    b.methods["setXY"] = [](void* self, const Args& a, Store&) {
        as<BufferAttribute>(self)->setXY(jsIndex(a.at(0)), number(a.at(1)),
                                         number(a.at(2)));
        return chain();
    };
    b.methods["setXYZ"] = [](void* self, const Args& a, Store&) {
        as<BufferAttribute>(self)->setXYZ(jsIndex(a.at(0)), number(a.at(1)),
                                          number(a.at(2)), number(a.at(3)));
        return chain();
    };
    b.methods["setXYZW"] = [](void* self, const Args& a, Store&) {
        as<BufferAttribute>(self)->setXYZW(jsIndex(a.at(0)), number(a.at(1)),
                                           number(a.at(2)), number(a.at(3)), number(a.at(4)));
        return chain();
    };
    b.methods["copyAt"] = [](void* self, const Args& a, Store& store) {
        as<BufferAttribute>(self)->copyAt(jsIndex(a.at(0)),
                                          attributeArg(store, a.at(1)), jsIndex(a.at(2)));
        return chain();
    };
    b.methods["applyMatrix3"] = [](void* self, const Args& a, Store& store) {
        as<BufferAttribute>(self)->applyMatrix3(store.ref<Matrix3>(a.at(0), "Matrix3"));
        return chain();
    };
    b.methods["applyMatrix4"] = [](void* self, const Args& a, Store& store) {
        as<BufferAttribute>(self)->applyMatrix4(store.ref<Matrix4>(a.at(0), "Matrix4"));
        return chain();
    };
    b.methods["applyNormalMatrix"] = [](void* self, const Args& a, Store& store) {
        as<BufferAttribute>(self)->applyNormalMatrix(store.ref<Matrix3>(a.at(0), "Matrix3"));
        return chain();
    };
    b.methods["transformDirection"] = [](void* self, const Args& a, Store& store) {
        as<BufferAttribute>(self)->transformDirection(store.ref<Matrix4>(a.at(0), "Matrix4"));
        return chain();
    };
}

// ----------------------------------------------------------------- BufferGeometry

void registerBufferGeometry(ClassBinding& b) {
    b.ctor = [](const Args&, Store&) {
        return std::static_pointer_cast<void>(std::make_shared<BufferGeometry>());
    };
    b.getters["type"] = [](void* self) { return string(as<BufferGeometry>(self)->type); };
    b.getters["name"] = [](void* self) { return string(as<BufferGeometry>(self)->name); };
    b.setters["name"] = [](void* self, const Value& v) { as<BufferGeometry>(self)->name = v.text; };
    b.getters["id"] = [](void* self) { return Value::of(double(as<BufferGeometry>(self)->id)); };
    b.getters["revision"] = [](void* self) { return Value::of(double(as<BufferGeometry>(self)->revision())); };
    b.getters["drawRange.start"] = [](void* self) { return Value::of(as<BufferGeometry>(self)->drawRange.start); };
    b.getters["drawRange.count"] = [](void* self) { return Value::of(as<BufferGeometry>(self)->drawRange.count); };
    b.getters["groups"] = [](void* self) { return string(as<BufferGeometry>(self)->groupsJson()); };
    // Every attribute name, one per line: the web surface lists `attributes` with one call.
    b.getters["__attributeNames"] = [](void* self) {
        std::string names;
        bool first = true;
        for (const auto& [name, attribute] : as<BufferGeometry>(self)->attributes) {
            if (!first) names += '\n';
            names += name;
            first = false;
        }
        return string(std::move(names));
    };
    // Every attribute by name as [attribute, its `__shape`]: the web surface answers a geometry's
    // getAttribute, hasAttribute and shape reads with one call.
    b.members["__attributes"] = [](void* self, const Args&, Store& store) {
        std::vector<std::pair<std::string, Value>> attributes;
        for (const auto& [name, attribute] : as<BufferGeometry>(self)->attributes)
            attributes.emplace_back(name, Value::array({shareAttribute(store, attribute), shapeOf(*attribute)}));
        return Value::record(std::move(attributes));
    };
    b.getters["parameters"] = [](void* self) {
        std::string json = as<BufferGeometry>(self)->parametersJson();
        if (json.empty()) throw Unsupported{"this geometry has no parameters"};
        return string(std::move(json));
    };
    b.getters["attributes.position.array"] = [](void* self) {
        return attributeArray(*as<BufferGeometry>(self), "position");
    };
    b.getters["attributes.normal.array"] = [](void* self) {
        return attributeArray(*as<BufferGeometry>(self), "normal");
    };
    b.getters["attributes.uv.array"] = [](void* self) {
        return attributeArray(*as<BufferGeometry>(self), "uv");
    };
    b.getters["attributes.color.array"] = [](void* self) {
        return attributeArray(*as<BufferGeometry>(self), "color");
    };
    b.getters["index.array"] = [](void* self) {
        const std::shared_ptr<BufferAttribute> index = as<BufferGeometry>(self)->index;
        if (index == nullptr) throw Unsupported{"this geometry has no index"};
        return numbers(index->toNumbers());
    };
    b.getters["boundingSphere.radius"] = [](void* self) {
        const std::shared_ptr<Sphere> sphere = as<BufferGeometry>(self)->boundingSphere;
        if (sphere == nullptr) throw Unsupported{"computeBoundingSphere() has not run"};
        return Value::of(sphere->radius);
    };
    b.getters["boundingSphere.center.x"] = [](void* self) {
        const std::shared_ptr<Sphere> sphere = as<BufferGeometry>(self)->boundingSphere;
        if (sphere == nullptr) throw Unsupported{"computeBoundingSphere() has not run"};
        return Value::of(sphere->center.x);
    };
    b.getters["boundingSphere.center.y"] = [](void* self) {
        const std::shared_ptr<Sphere> sphere = as<BufferGeometry>(self)->boundingSphere;
        if (sphere == nullptr) throw Unsupported{"computeBoundingSphere() has not run"};
        return Value::of(sphere->center.y);
    };
    b.getters["boundingSphere.center.z"] = [](void* self) {
        const std::shared_ptr<Sphere> sphere = as<BufferGeometry>(self)->boundingSphere;
        if (sphere == nullptr) throw Unsupported{"computeBoundingSphere() has not run"};
        return Value::of(sphere->center.z);
    };
    for (int i = 0; i < 3; ++i) {
        b.getters[std::string("boundingBox.min.") + "xyz"[i]] = [i](void* self) {
            const std::shared_ptr<Box3> box = as<BufferGeometry>(self)->boundingBox;
            if (box == nullptr) throw Unsupported{"computeBoundingBox() has not run"};
            return Value::of(i == 0 ? box->min.x : (i == 1 ? box->min.y : box->min.z));
        };
        b.getters[std::string("boundingBox.max.") + "xyz"[i]] = [i](void* self) {
            const std::shared_ptr<Box3> box = as<BufferGeometry>(self)->boundingBox;
            if (box == nullptr) throw Unsupported{"computeBoundingBox() has not run"};
            return Value::of(i == 0 ? box->max.x : (i == 1 ? box->max.y : box->max.z));
        };
    }

    b.members["attributes.position"] = [](void* self, const Args&, Store& store) {
        BufferGeometry* geometry = as<BufferGeometry>(self);
        return shareAttribute(store, geometry->getAttribute("position"));
    };
    b.members["attributes.normal"] = [](void* self, const Args&, Store& store) {
        BufferGeometry* geometry = as<BufferGeometry>(self);
        return shareAttribute(store, geometry->getAttribute("normal"));
    };
    b.members["attributes.uv"] = [](void* self, const Args&, Store& store) {
        BufferGeometry* geometry = as<BufferGeometry>(self);
        return shareAttribute(store, geometry->getAttribute("uv"));
    };
    b.members["index"] = [](void* self, const Args&, Store& store) {
        BufferGeometry* geometry = as<BufferGeometry>(self);
        return shareAttribute(store, geometry->index);
    };
    b.members["boundingBox"] = [](void* self, const Args&, Store& store) {
        return store.share("Box3", as<BufferGeometry>(self)->boundingBox);
    };
    b.members["boundingSphere"] = [](void* self, const Args&, Store& store) {
        return store.share("Sphere", as<BufferGeometry>(self)->boundingSphere);
    };

    b.methods["setIndex"] = [](void* self, const Args& a, Store& store) {
        BufferGeometry* geometry = as<BufferGeometry>(self);
        if (!a.empty() && a.at(0).kind == Value::Kind::Ref) {
            geometry->setIndex(sharedAttributeArg(store, a.at(0)));
        } else if (!a.empty() && a.at(0).kind == Value::Kind::Numbers) {
            // three: new (arrayNeedsUint32(index) ? Uint32 : Uint16)BufferAttribute(index, 1), deciding on the
            // numbers as given and then converting each as the typed array does (ToUint16/32).
            const std::vector<double>& values = a.at(0).numbers;
            const bool wide = std::any_of(values.begin(), values.end(), [](double v) { return v >= 65535; });
            geometry->setIndex(BufferAttribute::fromDoubles(wide ? Scalar::U32 : Scalar::U16, values, 1));
        } else {
            throw Unsupported{"setIndex needs a BufferAttribute or an array"};
        }
        return chain();
    };
    b.methods["getIndex"] = [](void* self, const Args&, Store& store) {
        BufferGeometry* geometry = as<BufferGeometry>(self);
        if (geometry->index == nullptr) return Value{};
        return shareAttribute(store, geometry->index);
    };
    // morphAttributes.position / .normal as an array of attributes, and morphTargetsRelative.
    for (const bool normals : {false, true}) {
        b.setters[normals ? "morphAttributes.normal" : "morphAttributes.position"] =
            [normals](void* self, const Value& v, Store& store) {
                std::vector<std::shared_ptr<BufferAttribute>> targets;
                for (const Value& ref : refsOf(v)) targets.push_back(sharedAttributeArg(store, ref));
                BufferGeometry* geometry = as<BufferGeometry>(self);
                (normals ? geometry->morphNormals : geometry->morphPositions) = std::move(targets);
            };
    }
    b.getters["morphTargetsRelative"] = [](void* self) { return Value::of(as<BufferGeometry>(self)->morphTargetsRelative); };
    b.setters["morphTargetsRelative"] = [](void* self, const Value& v) {
        as<BufferGeometry>(self)->morphTargetsRelative = v.kind == Value::Kind::Bool ? v.flag : number(v) != 0;
    };
    b.methods["setAttribute"] = [](void* self, const Args& a, Store& store) {
        if (a.at(0).kind != Value::Kind::String) throw Unsupported{"setAttribute needs a name"};
        as<BufferGeometry>(self)->setAttribute(a.at(0).text, sharedAttributeArg(store, a.at(1)));
        return chain();
    };
    // mergeGeometries' index and attributes in one call: (parts, indexed, attribute names), and
    // BufferGeometry::mergeFrom's answer. A merge in JS reads each part's arrays across the boundary.
    b.methods["__mergeFrom"] = [](void* self, const Args& a, Store& store) {
        std::vector<const BufferGeometry*> parts;
        for (const Value& ref : refsOf(a.at(0))) parts.push_back(&geometryArg(store, ref));
        std::vector<std::string> names;
        for (const Value& name : a.at(2).items) {
            if (name.kind != Value::Kind::String) throw Unsupported{"__mergeFrom needs attribute names"};
            names.push_back(name.text);
        }
        if (parts.empty() || names.empty()) return string("?");
        return string(as<BufferGeometry>(self)->mergeFrom(parts, a.at(1).flag, names));
    };
    b.methods["getAttribute"] = [](void* self, const Args& a, Store& store) {
        const std::shared_ptr<BufferAttribute> attribute = as<BufferGeometry>(self)->getAttribute(a.at(0).text);
        if (attribute == nullptr) return Value{};
        return shareAttribute(store, attribute);
    };
    b.methods["deleteAttribute"] = [](void* self, const Args& a, Store&) {
        as<BufferGeometry>(self)->deleteAttribute(a.at(0).text);
        return chain();
    };
    b.methods["hasAttribute"] = [](void* self, const Args& a, Store&) {
        return Value::of(as<BufferGeometry>(self)->hasAttribute(a.at(0).text));
    };
    b.methods["addGroup"] = [](void* self, const Args& a, Store&) {
        // addGroup( start, count, materialIndex = 0 ); a missing count is Infinity in practice (three
        // passes it through), and the numbers stay JS numbers.
        as<BufferGeometry>(self)->addGroup(number(a.at(0)), optional(a, 1, std::numeric_limits<double>::infinity()),
                                           optional(a, 2, 0));
        return chain();
    };
    b.methods["clearGroups"] = [](void* self, const Args&, Store&) {
        as<BufferGeometry>(self)->clearGroups();
        return chain();
    };
    b.methods["setDrawRange"] = [](void* self, const Args& a, Store&) {
        as<BufferGeometry>(self)->setDrawRange(number(a.at(0)), number(a.at(1)));
        return chain();
    };
    b.methods["computeBoundingBox"] = [](void* self, const Args&, Store&) {
        as<BufferGeometry>(self)->computeBoundingBox();
        return chain();
    };
    b.methods["computeBoundingSphere"] = [](void* self, const Args&, Store&) {
        as<BufferGeometry>(self)->computeBoundingSphere();
        return chain();
    };
    b.methods["computeVertexNormals"] = [](void* self, const Args&, Store&) {
        as<BufferGeometry>(self)->computeVertexNormals();
        return chain();
    };
    b.methods["normalizeNormals"] = [](void* self, const Args&, Store&) {
        as<BufferGeometry>(self)->normalizeNormals();
        return chain();
    };
    b.methods["applyMatrix4"] = [](void* self, const Args& a, Store& store) {
        as<BufferGeometry>(self)->applyMatrix4(store.ref<Matrix4>(a.at(0), "Matrix4"));
        return chain();
    };
    b.methods["translate"] = [](void* self, const Args& a, Store&) {
        as<BufferGeometry>(self)->translate(number(a.at(0)), number(a.at(1)), number(a.at(2)));
        return chain();
    };
    b.methods["rotateX"] = [](void* self, const Args& a, Store&) {
        as<BufferGeometry>(self)->rotateX(number(a.at(0)));
        return chain();
    };
    b.methods["rotateY"] = [](void* self, const Args& a, Store&) {
        as<BufferGeometry>(self)->rotateY(number(a.at(0)));
        return chain();
    };
    b.methods["rotateZ"] = [](void* self, const Args& a, Store&) {
        as<BufferGeometry>(self)->rotateZ(number(a.at(0)));
        return chain();
    };
    b.methods["scale"] = [](void* self, const Args& a, Store&) {
        as<BufferGeometry>(self)->scale(number(a.at(0)), number(a.at(1)), number(a.at(2)));
        return chain();
    };
    b.methods["center"] = [](void* self, const Args&, Store&) {
        as<BufferGeometry>(self)->center();
        return chain();
    };
    b.methods["toNonIndexed"] = [](void* self, const Args&, Store& store) {
        std::shared_ptr<BufferGeometry> nonIndexed = as<BufferGeometry>(self)->toNonIndexed();
        if (nonIndexed == nullptr) return chain();
        return store.adopt("BufferGeometry", std::static_pointer_cast<void>(nonIndexed));
    };
    // three's clone(): a geometry of the same class and parameters holding copies of every array.
    b.methods["clone"] = [](void* self, const Args&, Store& store) {
        std::shared_ptr<BufferGeometry> copy = as<BufferGeometry>(self)->clone();
        const std::string type = copy->type;
        return store.adopt(type, std::static_pointer_cast<void>(copy));
    };
    b.methods["dispose"] = [](void* self, const Args&, Store&) {
        as<BufferGeometry>(self)->dispose();
        return Value{Value::Kind::Undefined};
    };
    // morphAttributes.position / .normal read back as three's arrays of the attributes themselves.
    for (const bool normals : {false, true}) {
        b.members[normals ? "morphAttributes.normal" : "morphAttributes.position"] =
            [normals](void* self, const Args&, Store& store) {
                std::vector<Value> targets;
                const BufferGeometry* geometry = as<BufferGeometry>(self);
                for (const auto& target : normals ? geometry->morphNormals : geometry->morphPositions)
                    targets.push_back(shareAttribute(store, target));
                return Value::array(std::move(targets));
            };
    }
}

// -------------------------------------------------------------------- generators

template <typename Make>
void registerGenerator(Registry& classes, const char* name, Make make) {
    ClassBinding& b = classes[name];
    // A generator is a BufferGeometry in three, so it carries every base getter and method.
    registerBufferGeometry(b);
    b.ctor = [make](const Args& a, Store&) { return std::static_pointer_cast<void>(make(a)); };
}

void registerGeometryGenerators(Registry& classes) {
    registerGenerator(classes, "PlaneGeometry", [](const Args& a) {
        return makePlaneGeometry(optional(a, 0, 1), optional(a, 1, 1), optional(a, 2, 1),
                                 optional(a, 3, 1));
    });
    registerGenerator(classes, "BoxGeometry", [](const Args& a) {
        return makeBoxGeometry(optional(a, 0, 1), optional(a, 1, 1), optional(a, 2, 1), optional(a, 3, 1),
                               optional(a, 4, 1), optional(a, 5, 1));
    });
    registerGenerator(classes, "RoundedBoxGeometry", [](const Args& a) {
        return makeRoundedBoxGeometry(optional(a, 0, 1), optional(a, 1, 1), optional(a, 2, 1), optional(a, 3, 2),
                                      optional(a, 4, 0.1));
    });
    registerGenerator(classes, "SphereGeometry", [](const Args& a) {
        return makeSphereGeometry(optional(a, 0, 1), optional(a, 1, 32), optional(a, 2, 16),
                                  optional(a, 3, 0), optional(a, 4, 6.283185307179586),
                                  optional(a, 5, 0), optional(a, 6, 3.141592653589793));
    });
    registerGenerator(classes, "CylinderGeometry", [](const Args& a) {
        return makeCylinderGeometry(optional(a, 0, 1), optional(a, 1, 1), optional(a, 2, 1),
                                    optional(a, 3, 32), optional(a, 4, 1), boolean(a, 5, false),
                                    optional(a, 6, 0), optional(a, 7, 6.283185307179586));
    });
    registerGenerator(classes, "ConeGeometry", [](const Args& a) {
        return makeConeGeometry(optional(a, 0, 1), optional(a, 1, 1), optional(a, 2, 32),
                                optional(a, 3, 1), boolean(a, 4, false), optional(a, 5, 0),
                                optional(a, 6, 6.283185307179586));
    });
    registerGenerator(classes, "CircleGeometry", [](const Args& a) {
        return makeCircleGeometry(optional(a, 0, 1), optional(a, 1, 32), optional(a, 2, 0),
                                  optional(a, 3, 6.283185307179586));
    });
    registerGenerator(classes, "IcosahedronGeometry", [](const Args& a) {
        return makeIcosahedronGeometry(optional(a, 0, 1), optional(a, 1, 0));
    });
    registerGenerator(classes, "CapsuleGeometry", [](const Args& a) {
        return makeCapsuleGeometry(optional(a, 0, 1), optional(a, 1, 1), optional(a, 2, 4),
                                   optional(a, 3, 8), optional(a, 4, 1));
    });
    registerGenerator(classes, "DodecahedronGeometry", [](const Args& a) {
        return makeDodecahedronGeometry(optional(a, 0, 1), optional(a, 1, 0));
    });
    registerGenerator(classes, "OctahedronGeometry", [](const Args& a) {
        return makeOctahedronGeometry(optional(a, 0, 1), optional(a, 1, 0));
    });
    registerGenerator(classes, "TorusGeometry", [](const Args& a) {
        return makeTorusGeometry(optional(a, 0, 1), optional(a, 1, 0.4), optional(a, 2, 12),
                                 optional(a, 3, 48), optional(a, 4, 6.283185307179586),
                                 optional(a, 5, 0), optional(a, 6, 6.283185307179586));
    });
    registerGenerator(classes, "TorusKnotGeometry", [](const Args& a) {
        return makeTorusKnotGeometry(optional(a, 0, 1), optional(a, 1, 0.4), optional(a, 2, 64),
                                     optional(a, 3, 8), optional(a, 4, 2), optional(a, 5, 3));
    });
    registerGenerator(classes, "RingGeometry", [](const Args& a) {
        return makeRingGeometry(optional(a, 0, 0.5), optional(a, 1, 1), optional(a, 2, 32),
                                optional(a, 3, 1), optional(a, 4, 0), optional(a, 5, 6.283185307179586));
    });
    // three's LatheGeometry(points, segments, phiStart, phiLength): points is an array of Vector2. A
    // one-point profile reads past its end in three, so it is refused rather than guessed.
    ClassBinding& lathe = classes["LatheGeometry"];
    registerBufferGeometry(lathe);
    lathe.ctor = [](const Args& a, Store& store) {
        std::vector<Vector2> points{{0, -0.5}, {0.5, 0}, {0, 0.5}};
        if (!a.empty() && a.at(0).kind != Value::Kind::Undefined) {
            points.clear();
            for (const Value& ref : refsOf(a.at(0))) points.push_back(store.ref<Vector2>(ref, "Vector2"));
            if (points.size() == 1) throw Unsupported{"LatheGeometry needs at least two points"};
        }
        return std::static_pointer_cast<void>(
            makeLatheGeometry(points, optional(a, 1, 12), optional(a, 2, 0), optional(a, 3, 6.283185307179586)));
    };
}

// -------------------------------------------------------------------------------- curves

/** A Vector3 answer: written into the caller's target and returned, as three does, or a new one. */
Value vectorAnswer(const Vector3& value, const Args& a, size_t target, Store& store) {
    if (target < a.size() && a.at(target).kind != Value::Kind::Undefined && a.at(target).kind != Value::Kind::Null) {
        store.ref<Vector3>(a.at(target), "Vector3").copy(value);
        return a.at(target);
    }
    return store.adopt("Vector3", std::make_shared<Vector3>(value));
}

Value vectorList(const std::vector<Vector3>& values, Store& store) {
    std::vector<Value> out;
    for (const Vector3& value : values) out.push_back(store.adopt("Vector3", std::make_shared<Vector3>(value)));
    return Value::array(std::move(out));
}

std::string curveTypeArg(const Value& v) {
    if (v.kind != Value::Kind::String || (v.text != "centripetal" && v.text != "chordal" && v.text != "catmullrom"))
        throw Unsupported{"curveType must be centripetal, chordal or catmullrom"};
    return v.text;
}

// three's CatmullRomCurve3(points, closed, curveType, tension) and the Curve methods it inherits.
// Fewer than two points read past the array in three, so they are refused.
void registerCatmullRomCurve3(ClassBinding& b) {
    b.ctor = [](const Args& a, Store& store) {
        std::vector<std::shared_ptr<Vector3>> points;
        if (!a.empty() && a.at(0).kind != Value::Kind::Undefined)
            for (const Value& ref : refsOf(a.at(0))) points.push_back(store.shared<Vector3>(ref, "Vector3"));
        if (points.size() < 2) throw Unsupported{"CatmullRomCurve3 needs at least two points"};
        const bool closed = boolean(a, 1, false);
        const std::string curveType =
            a.size() > 2 && a.at(2).kind != Value::Kind::Undefined ? curveTypeArg(a.at(2)) : "centripetal";
        return std::static_pointer_cast<void>(
            std::make_shared<CatmullRomCurve3>(std::move(points), closed, curveType, optional(a, 3, 0.5)));
    };
    b.getters["type"] = [](void* self) { return string(as<CatmullRomCurve3>(self)->type); };
    b.getters["closed"] = [](void* self) { return Value::of(as<CatmullRomCurve3>(self)->closed); };
    b.setters["closed"] = [](void* self, const Value& v) { as<CatmullRomCurve3>(self)->closed = flag(v); };
    b.getters["curveType"] = [](void* self) { return string(as<CatmullRomCurve3>(self)->curveType); };
    b.setters["curveType"] = [](void* self, const Value& v) { as<CatmullRomCurve3>(self)->curveType = curveTypeArg(v); };
    b.getters["tension"] = [](void* self) { return Value::of(as<CatmullRomCurve3>(self)->tension); };
    b.setters["tension"] = [](void* self, const Value& v) { as<CatmullRomCurve3>(self)->tension = number(v); };
    b.getters["arcLengthDivisions"] = [](void* self) { return Value::of(as<CatmullRomCurve3>(self)->arcLengthDivisions); };
    b.setters["arcLengthDivisions"] = [](void* self, const Value& v) {
        as<CatmullRomCurve3>(self)->arcLengthDivisions = number(v);
    };
    b.members["points"] = [](void* self, const Args&, Store& store) {
        std::vector<Value> points;
        for (const auto& point : as<CatmullRomCurve3>(self)->points) points.push_back(store.share("Vector3", point));
        return Value::array(std::move(points));
    };
    b.methods["getPoint"] = [](void* self, const Args& a, Store& store) {
        return vectorAnswer(as<CatmullRomCurve3>(self)->getPoint(number(a.at(0))), a, 1, store);
    };
    b.methods["getPointAt"] = [](void* self, const Args& a, Store& store) {
        return vectorAnswer(as<CatmullRomCurve3>(self)->getPointAt(number(a.at(0))), a, 1, store);
    };
    b.methods["getTangent"] = [](void* self, const Args& a, Store& store) {
        return vectorAnswer(as<CatmullRomCurve3>(self)->getTangent(number(a.at(0))), a, 1, store);
    };
    b.methods["getTangentAt"] = [](void* self, const Args& a, Store& store) {
        return vectorAnswer(as<CatmullRomCurve3>(self)->getTangentAt(number(a.at(0))), a, 1, store);
    };
    b.methods["getPoints"] = [](void* self, const Args& a, Store& store) {
        return vectorList(as<CatmullRomCurve3>(self)->getPoints(optional(a, 0, 5)), store);
    };
    b.methods["getSpacedPoints"] = [](void* self, const Args& a, Store& store) {
        return vectorList(as<CatmullRomCurve3>(self)->getSpacedPoints(optional(a, 0, 5)), store);
    };
    b.methods["getLength"] = [](void* self, const Args&, Store&) {
        return Value::of(as<CatmullRomCurve3>(self)->getLength());
    };
    b.methods["getLengths"] = [](void* self, const Args& a, Store&) {
        const auto* curve = as<CatmullRomCurve3>(self);
        return numbers(curve->getLengths(optional(a, 0, curve->arcLengthDivisions)));
    };
    b.methods["updateArcLengths"] = [](void* self, const Args&, Store&) {
        as<CatmullRomCurve3>(self)->updateArcLengths();
        return Value{};
    };
    b.methods["getUtoTmapping"] = [](void* self, const Args& a, Store&) {
        const double distance = a.size() > 1 && a.at(1).kind == Value::Kind::Number ? a.at(1).number : 0;
        return Value::of(as<CatmullRomCurve3>(self)->getUtoTmapping(number(a.at(0)), distance));
    };
}

// ------------------------------------------------------------------------------ Path, Shape

std::vector<Vector2> vector2s(const Value& v, Store& store) {
    std::vector<Vector2> points;
    for (const Value& ref : refsOf(v)) points.push_back(store.ref<Vector2>(ref, "Vector2"));
    return points;
}

/** A Path or a Shape argument, as the Path it is. */
std::shared_ptr<Path> pathArg(Store& store, const Value& v) {
    Object* found = store.find(v);
    if (found != nullptr && found->cls == "Shape") return std::static_pointer_cast<Shape>(found->ptr);
    if (found != nullptr && found->cls == "Path") return std::static_pointer_cast<Path>(found->ptr);
    throw Unsupported{"argument is not a Path or a Shape"};
}

// three's Path and Shape: the drawing commands, autoClose and getPoints. Shape adds `holes`, the
// caller's own paths. The commands take numbers, as three's do; a profile with no points is refused,
// as three reads its first point.
template <class P>
void registerPath(ClassBinding& b) {
    b.ctor = [](const Args& a, Store& store) {
        if (a.empty() || a.at(0).kind == Value::Kind::Undefined || a.at(0).kind == Value::Kind::Null)
            return std::static_pointer_cast<void>(std::make_shared<P>());
        const std::vector<Vector2> points = vector2s(a.at(0), store);
        if (points.empty()) throw Unsupported{"a Path's points must not be empty"};
        return std::static_pointer_cast<void>(std::make_shared<P>(points));
    };
    b.getters["type"] = [](void* self) { return string(as<P>(self)->type); };
    b.getters["autoClose"] = [](void* self) { return Value::of(as<P>(self)->autoClose); };
    b.setters["autoClose"] = [](void* self, const Value& v) { as<P>(self)->autoClose = flag(v); };
    b.methods["moveTo"] = [](void* self, const Args& a, Store&) {
        as<P>(self)->moveTo(number(a.at(0)), number(a.at(1)));
        return chain();
    };
    b.methods["lineTo"] = [](void* self, const Args& a, Store&) {
        as<P>(self)->lineTo(number(a.at(0)), number(a.at(1)));
        return chain();
    };
    b.methods["quadraticCurveTo"] = [](void* self, const Args& a, Store&) {
        as<P>(self)->quadraticCurveTo(number(a.at(0)), number(a.at(1)), number(a.at(2)), number(a.at(3)));
        return chain();
    };
    b.methods["bezierCurveTo"] = [](void* self, const Args& a, Store&) {
        as<P>(self)->bezierCurveTo(number(a.at(0)), number(a.at(1)), number(a.at(2)), number(a.at(3)), number(a.at(4)),
                                   number(a.at(5)));
        return chain();
    };
    b.methods["splineThru"] = [](void* self, const Args& a, Store& store) {
        const std::vector<Vector2> points = vector2s(a.at(0), store);
        if (points.empty()) throw Unsupported{"splineThru needs points"};
        as<P>(self)->splineThru(points);
        return chain();
    };
    b.methods["setFromPoints"] = [](void* self, const Args& a, Store& store) {
        const std::vector<Vector2> points = vector2s(a.at(0), store);
        if (points.empty()) throw Unsupported{"setFromPoints needs points"};
        as<P>(self)->setFromPoints(points);
        return chain();
    };
    b.methods["arc"] = [](void* self, const Args& a, Store&) {
        as<P>(self)->arc(number(a.at(0)), number(a.at(1)), number(a.at(2)), number(a.at(3)), number(a.at(4)), boolean(a, 5, false));
        return chain();
    };
    b.methods["absarc"] = [](void* self, const Args& a, Store&) {
        as<P>(self)->absarc(number(a.at(0)), number(a.at(1)), number(a.at(2)), number(a.at(3)), number(a.at(4)),
                            boolean(a, 5, false));
        return chain();
    };
    b.methods["ellipse"] = [](void* self, const Args& a, Store&) {
        as<P>(self)->ellipse(number(a.at(0)), number(a.at(1)), number(a.at(2)), number(a.at(3)), number(a.at(4)),
                             number(a.at(5)), boolean(a, 6, false), optional(a, 7, 0));
        return chain();
    };
    b.methods["absellipse"] = [](void* self, const Args& a, Store&) {
        as<P>(self)->absellipse(number(a.at(0)), number(a.at(1)), number(a.at(2)), number(a.at(3)), number(a.at(4)),
                                number(a.at(5)), boolean(a, 6, false), optional(a, 7, 0));
        return chain();
    };
    b.methods["closePath"] = [](void* self, const Args&, Store&) {
        if (as<P>(self)->curves.empty()) throw Unsupported{"closePath on a path with no curves"};
        as<P>(self)->closePath();
        return chain();
    };
    b.methods["getPoints"] = [](void* self, const Args& a, Store& store) {
        std::vector<Value> out;
        for (const Vector2& p : as<P>(self)->getPoints(optional(a, 0, 12)))
            out.push_back(store.adopt("Vector2", std::make_shared<Vector2>(p)));
        return Value::array(std::move(out));
    };
    b.methods["getLength"] = [](void* self, const Args&, Store&) { return Value::of(as<P>(self)->getLength()); };
    fixedMember(b, "currentPoint", [](void* self, const Args&, Store& store) {
        return store.adoptAlias("Vector2", &as<P>(self)->currentPoint, self);
    });
}

void registerShape(ClassBinding& b) {
    registerPath<Shape>(b);
    b.members["holes"] = [](void* self, const Args&, Store& store) {
        std::vector<Value> holes;
        for (const auto& hole : as<Shape>(self)->holes)
            holes.push_back(store.share(dynamic_cast<Shape*>(hole.get()) ? "Shape" : "Path", hole));
        return Value::array(std::move(holes));
    };
    b.setters["holes"] = [](void* self, const Value& v, Store& store) {
        std::vector<std::shared_ptr<Path>> holes;
        for (const Value& ref : refsOf(v)) holes.push_back(pathArg(store, ref));
        as<Shape>(self)->holes = std::move(holes);
    };
}

/** One Shape, or an array of them, as ShapeGeometry and ExtrudeGeometry take; none is three's default. */
std::vector<std::shared_ptr<Shape>> shapesArg(const Args& a, Store& store, bool& asArray, std::vector<Vector2> fallback) {
    asArray = false;
    if (a.empty() || a.at(0).kind == Value::Kind::Undefined) return {std::make_shared<Shape>(fallback)};
    if (a.at(0).kind == Value::Kind::Ref) return {store.shared<Shape>(a.at(0), "Shape")};
    asArray = true;
    std::vector<std::shared_ptr<Shape>> shapes;
    for (const Value& ref : refsOf(a.at(0))) shapes.push_back(store.shared<Shape>(ref, "Shape"));
    return shapes;
}

ExtrudeOptions extrudeOptions(const Value& v) {
    ExtrudeOptions options;
    if (v.kind == Value::Kind::Undefined || v.kind == Value::Kind::Null) return options;
    if (v.kind != Value::Kind::Record) throw Unsupported{"ExtrudeGeometry options must be an object"};
    for (const auto& [key, value] : v.fields) {
        if (key == "curveSegments") options.curveSegments = number(value);
        else if (key == "steps") options.steps = number(value);
        else if (key == "depth") options.depth = number(value);
        else if (key == "bevelEnabled") options.bevelEnabled = flag(value);
        else if (key == "bevelThickness") options.bevelThickness = number(value);
        else if (key == "bevelSize") options.bevelSize = number(value);
        else if (key == "bevelOffset") options.bevelOffset = number(value);
        else if (key == "bevelSegments") options.bevelSegments = number(value);
        else if (key == "extrudePath" || key == "UVGenerator")
            throw Unsupported{"ExtrudeGeometry " + key + " is not supported natively"};
        // three reads only the keys above, so any other key is ignored there too.
    }
    return options;
}

}  // namespace

void registerGeometryBindings(Registry& classes) {
    // three's Vector{2,3,4}.fromBufferAttribute(attribute, index): the item's components by getX/Y/Z/W,
    // NaN past the array as three's undefined typed-array reads give.
    const auto read = [](Store& store, const Args& a, int c) {
        const Value v = component(attributeArg(store, a.at(0)), jsIndex(a.at(1)), c);
        return v.kind == Value::Kind::Number ? v.number : std::nan("");
    };
    classes["Vector2"].methods["fromBufferAttribute"] = [read](void* self, const Args& a, Store& store) {
        auto& v = *static_cast<Vector2*>(self);
        v.x = read(store, a, 0), v.y = read(store, a, 1);
        return chain();
    };
    classes["Vector3"].methods["fromBufferAttribute"] = [read](void* self, const Args& a, Store& store) {
        auto& v = *static_cast<Vector3*>(self);
        v.x = read(store, a, 0), v.y = read(store, a, 1), v.z = read(store, a, 2);
        return chain();
    };
    classes["Vector4"].methods["fromBufferAttribute"] = [read](void* self, const Args& a, Store& store) {
        auto& v = *static_cast<Vector4*>(self);
        v.x = read(store, a, 0), v.y = read(store, a, 1), v.z = read(store, a, 2), v.w = read(store, a, 3);
        return chain();
    };
    classes["Box3"].methods["setFromBufferAttribute"] = [](void* self, const Args& a, Store& store) {
        as<Box3>(self)->setFromBufferAttribute(*sharedAttributeArg(store, a.at(0)));
        return chain();
    };
    registerBufferAttribute(classes["BufferAttribute"], "BufferAttribute");
    // three's InstancedBufferAttribute: a BufferAttribute read once per instance (InstancedMesh's
    // instanceMatrix and instanceColor). meshPerAttribute stays 1, the only value InstancedMesh uses.
    ClassBinding& instanced = classes["InstancedBufferAttribute"];
    registerBufferAttribute(instanced, "InstancedBufferAttribute");
    instanced.getters["meshPerAttribute"] = [](void*) { return Value::of(1.0); };
    // three's Float32BufferAttribute: the same attribute, but its constructor wraps whatever it is
    // given in a Float32Array, so the storage is F32 and each value rounds once to binary32.
    ClassBinding& float32 = classes["Float32BufferAttribute"];
    registerBufferAttribute(float32, "Float32BufferAttribute");
    float32.ctorTakesBytes = false;  // its constructor reads numbers
    float32.ctor = [](const Args& a, Store&) {
        // fromDoubles reads the list in place; copying a vertex buffer here cost a malloc and a memcpy.
        static const std::vector<double> none;
        const std::vector<double>& values = !a.empty() && a.at(0).kind == Value::Kind::Numbers ? a.at(0).numbers : none;
        const double itemSize = optional(a, 1, 1);
        if (!(itemSize >= 1 && itemSize <= 65536) || itemSize != std::floor(itemSize))
            throw Unsupported{"itemSize must be a positive integer"};
        const bool normalized = a.size() > 2 && flag(a.at(2));
        return std::static_pointer_cast<void>(
            BufferAttribute::fromDoubles(Scalar::F32, values, static_cast<int>(itemSize), normalized));
    };
    registerBufferGeometry(classes["BufferGeometry"]);
    // three's InstancedBufferGeometry: a BufferGeometry drawn instanceCount times, its
    // InstancedBufferAttributes read once per instance.
    ClassBinding& instancedGeometry = classes["InstancedBufferGeometry"];
    registerBufferGeometry(instancedGeometry);
    instancedGeometry.ctor = [](const Args&, Store&) {
        auto geometry = std::make_shared<BufferGeometry>();
        geometry->type = "InstancedBufferGeometry";
        geometry->instanced = true;
        return std::static_pointer_cast<void>(geometry);
    };
    instancedGeometry.getters["instanceCount"] = [](void* self) {
        return Value::of(as<BufferGeometry>(self)->instanceCount);
    };
    instancedGeometry.setters["instanceCount"] = [](void* self, const Value& v) {
        const double count = number(v);
        if (!(count >= 0) || (count != std::floor(count) && !std::isinf(count)))
            throw Unsupported{"instanceCount must be a whole number of instances or Infinity"};
        as<BufferGeometry>(self)->instanceCount = count;
    };
    registerGeometryGenerators(classes);
    registerCatmullRomCurve3(classes["CatmullRomCurve3"]);
    registerPath<Path>(classes["Path"]);
    registerShape(classes["Shape"]);
    ClassBinding& shapeGeometry = classes["ShapeGeometry"];
    registerBufferGeometry(shapeGeometry);
    shapeGeometry.ctor = [](const Args& a, Store& store) {
        bool asArray = false;
        const auto shapes = shapesArg(a, store, asArray, {{0, 0.5}, {-0.5, -0.5}, {0.5, -0.5}});
        return std::static_pointer_cast<void>(makeShapeGeometry(shapes, asArray, optional(a, 1, 12)));
    };
    ClassBinding& extrude = classes["ExtrudeGeometry"];
    registerBufferGeometry(extrude);
    extrude.ctor = [](const Args& a, Store& store) {
        bool asArray = false;
        const auto shapes = shapesArg(a, store, asArray, {{0.5, 0.5}, {-0.5, 0.5}, {-0.5, -0.5}, {0.5, -0.5}});
        return std::static_pointer_cast<void>(makeExtrudeGeometry(shapes, extrudeOptions(a.size() > 1 ? a.at(1) : Value::undefined())));
    };
    // three's TubeGeometry(path, tubularSegments, radius, radialSegments, closed). Its default path is
    // a QuadraticBezierCurve3, which is not bound, so a missing path is refused.
    ClassBinding& tube = classes["TubeGeometry"];
    registerBufferGeometry(tube);
    tube.ctor = [](const Args& a, Store& store) {
        if (a.empty() || a.at(0).kind == Value::Kind::Undefined)
            throw Unsupported{"TubeGeometry needs a path; its default QuadraticBezierCurve3 is unbound"};
        const auto& path = store.ref<CatmullRomCurve3>(a.at(0), "CatmullRomCurve3");
        return std::static_pointer_cast<void>(makeTubeGeometry(path, optional(a, 1, 64), optional(a, 2, 1),
                                                               optional(a, 3, 8), boolean(a, 4, false)));
    };
}

}  // namespace tn::binding
