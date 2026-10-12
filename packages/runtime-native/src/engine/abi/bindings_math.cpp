#include "engine/abi/bindings.h"

#include "engine/foundation/math/Color.h"
#include "engine/foundation/math/Euler.h"
#include "engine/foundation/math/MathUtils.h"
#include "engine/foundation/math/Matrix.h"
#include "engine/foundation/math/Primitives.h"
#include "engine/foundation/math/Quaternion.h"
#include "engine/foundation/math/Vector.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <memory>
#include <string>
#include <vector>

namespace tn::binding {

using namespace tn::engine;

namespace {

// --------------------------------------------------------------------------------- arguments

double optional(const Args& a, size_t i, double fallback) {
    return i < a.size() ? number(a.at(i)) : fallback;
}

/** `integer(a, i, 0)`: three's optional offset arguments are absent far more often than not. */
int integer(const Args& a, size_t i, int fallback = 0) {
    return i < a.size() ? static_cast<int>(number(a.at(i))) : fallback;
}

bool boolean(const Args& a, size_t i, bool fallback) {
    if (i >= a.size()) return fallback;
    const Value& v = a.at(i);
    return v.kind == Value::Kind::Bool ? v.flag : number(v) != 0;
}

EulerOrder order(const Args& a, size_t i, EulerOrder fallback) {
    if (i >= a.size()) return fallback;
    const std::string& name = a.at(i).text;
    if (name == "XYZ") return EulerOrder::XYZ;
    if (name == "YXZ") return EulerOrder::YXZ;
    if (name == "ZXY") return EulerOrder::ZXY;
    if (name == "ZYX") return EulerOrder::ZYX;
    if (name == "YZX") return EulerOrder::YZX;
    if (name == "XZY") return EulerOrder::XZY;
    throw Unsupported{"unknown Euler order " + name};
}

ColorSpace space(const Args& a, size_t i, ColorSpace fallback) {
    if (i >= a.size()) return fallback;
    const std::string& name = a.at(i).text;
    if (name == "srgb") return ColorSpace::SRGB;
    if (name == "srgb-linear" || name == "linear") return ColorSpace::LinearSRGB;
    throw Unsupported{"unknown colour space " + name};
}

CoordinateSystem system(const Args& a, size_t i, CoordinateSystem fallback) {
    if (i >= a.size()) return fallback;
    if (a.at(i).kind == Value::Kind::String) {
        if (a.at(i).text == "WebGL") return CoordinateSystem::WebGL;
        if (a.at(i).text == "WebGPU") return CoordinateSystem::WebGPU;
        throw Unsupported{"unknown coordinate system " + a.at(i).text};
    }
    const int value = integer(a, i);
    if (value == static_cast<int>(CoordinateSystem::WebGL)) return CoordinateSystem::WebGL;
    if (value == static_cast<int>(CoordinateSystem::WebGPU)) return CoordinateSystem::WebGPU;
    throw Unsupported{"unknown coordinate system " + std::to_string(value)};
}

/** The protocol carries no array value, so a point list is a run of Vector3 references. */
std::vector<Vector3> pointsOf(const Args& a, Store& d) {
    std::vector<Vector3> points;
    points.reserve(a.size());
    for (const Value& v : a) points.push_back(d.ref<Vector3>(v, "Vector3"));
    return points;
}

Value numbers(const double* values, size_t count) {
    return Value::list(std::vector<double>(values, values + count));
}

// ------------------------------------------------------------------------------- registration

template <typename T>
T* as(void* self) {
    return static_cast<T*>(self);
}

double component(const Vector3& v, int i) { return i == 0 ? v.x : (i == 1 ? v.y : v.z); }

void setComponent(Vector3& v, int i, double value) { (i == 0 ? v.x : (i == 1 ? v.y : v.z)) = value; }

/** Builds the constructor: a fresh value, then the reference's own default-then-set shape. */
template <typename T, typename Build>
Ctor ctor(Build build) {
    return [build](const Args& a, Store&) {
        auto object = std::make_shared<T>();
        build(*object, a);
        return std::static_pointer_cast<void>(object);
    };
}

/** `clone()` is three's only method that answers a new object; the fixture binds it by result id. */
template <typename T>
Method cloneAs(const char* cls) {
    return [cls](void* self, const Args&, Store& d) {
        return d.adopt(cls, std::make_shared<T>(as<T>(self)->clone()));
    };
}

/** Registers the plain component fields: `x`/`y`/`z`/`w`, read by path and written by `set`. */
template <typename T, size_t N>
void members(ClassBinding& b, const char* const (&names)[N], double T::* const (&fields)[N]) {
    for (size_t i = 0; i < N; ++i) {
        b.getters[names[i]] = [fields, i](void* self) {
            return Value::of((as<T>(self)->*fields[i]));
        };
        b.setters[names[i]] = [fields, i](void* self, const Value& v) {
            (as<T>(self)->*fields[i]) = number(v);
        };
    }
}

/**
 * Component setters that fire the change callback, as three's public `x`/`y`/`z`/`w` setters on
 * Euler and Quaternion do: an Object3D's rotation and quaternion stay in sync through any write.
 */
template <typename T, size_t N>
void notifyingSetters(ClassBinding& b, const char* const (&names)[N], double T::* const (&fields)[N]) {
    for (size_t i = 0; i < N; ++i) {
        b.setters[names[i]] = [fields, i](void* self, const Value& v) {
            as<T>(self)->*fields[i] = number(v);
            as<T>(self)->notify();
        };
    }
}

/**
 * Registers a Vector3 field twice over: `<prefix>.x`/`y`/`z` for the protocol's dotted paths, and
 * `<prefix>` itself as a member object (`box.min`), so JS reaches it as three's code does.
 */
template <typename T>
void nestedVector(ClassBinding& b, const char* prefix, Vector3 T::*field) {
    fixedMember(b, prefix, [field](void* self, const Args&, Store& store) {
        return memberAlias(store, self, as<T>(self)->*field, "Vector3");
    });
    for (int i = 0; i < 3; ++i) {
        const std::string path = std::string(prefix) + "." + "xyz"[i];
        b.getters[path] = [field, i](void* self) {
            return Value::of(component(as<T>(self)->*field, i));
        };
        b.setters[path] = [field, i](void* self, const Value& v) {
            setComponent(as<T>(self)->*field, i, number(v));
        };
    }
}

// Each helper takes the member pointer as an ordinary parameter: a pointer-to-member cannot be
// deduced against its own signature, so `T& (T::*M)(double)` as a non-type template parameter
// would leave every call site to name it twice.
template <typename T, typename M>
void chainVoid(ClassBinding& b, const char* name, M method) {
    b.methods[name] = [method](void* self, const Args&, Store&) {
        (as<T>(self)->*method)();
        return chain();
    };
}

template <typename T, typename M>
void chainOne(ClassBinding& b, const char* name, M method) {
    b.methods[name] = [method](void* self, const Args& a, Store&) {
        (as<T>(self)->*method)(number(a.at(0)));
        return chain();
    };
}

template <typename T, typename M>
void chainTwo(ClassBinding& b, const char* name, M method) {
    b.methods[name] = [method](void* self, const Args& a, Store&) {
        (as<T>(self)->*method)(number(a.at(0)), number(a.at(1)));
        return chain();
    };
}

template <typename T, typename M>
void chainThree(ClassBinding& b, const char* name, M method) {
    b.methods[name] = [method](void* self, const Args& a, Store&) {
        (as<T>(self)->*method)(number(a.at(0)), number(a.at(1)), number(a.at(2)));
        return chain();
    };
}

template <typename T, typename M>
void chainFour(ClassBinding& b, const char* name, M method) {
    b.methods[name] = [method](void* self, const Args& a, Store&) {
        (as<T>(self)->*method)(number(a.at(0)), number(a.at(1)), number(a.at(2)), number(a.at(3)));
        return chain();
    };
}

template <typename T, typename U, typename M>
void chainRef(ClassBinding& b, const char* name, const char* cls, M method) {
    b.methods[name] = [cls, method](void* self, const Args& a, Store& d) {
        U scratch;
        (as<T>(self)->*method)(d.in<U>(a.at(0), cls, scratch));
        return chain();
    };
}

template <typename T, typename U, typename M>
void chainRefOne(ClassBinding& b, const char* name, const char* cls, M method) {
    b.methods[name] = [cls, method](void* self, const Args& a, Store& d) {
        U scratch;
        (as<T>(self)->*method)(d.in<U>(a.at(0), cls, scratch), number(a.at(1)));
        return chain();
    };
}

/** `lerpVectors(a, b, alpha)`: three's two-vector forms carry the blend as a third argument. */
template <typename T, typename U, typename M>
void chainRef2One(ClassBinding& b, const char* name, const char* cls, M method) {
    b.methods[name] = [cls, method](void* self, const Args& a, Store& d) {
        U first, second;
        (as<T>(self)->*method)(d.in<U>(a.at(0), cls, first), d.in<U>(a.at(1), cls, second), number(a.at(2)));
        return chain();
    };
}

template <typename T, typename U, typename M>
void chainRef2(ClassBinding& b, const char* name, const char* cls, M method) {
    b.methods[name] = [cls, method](void* self, const Args& a, Store& d) {
        U first, second;
        (as<T>(self)->*method)(d.in<U>(a.at(0), cls, first), d.in<U>(a.at(1), cls, second));
        return chain();
    };
}

template <typename T, typename M>
void readScalar(ClassBinding& b, const char* name, M method) {
    b.methods[name] = [method](void* self, const Args&, Store&) {
        return Value::of((as<T>(self)->*method)());
    };
}

template <typename T, typename M>
void readFlag(ClassBinding& b, const char* name, M method) {
    b.methods[name] = [method](void* self, const Args&, Store&) {
        return Value::of((as<T>(self)->*method)());
    };
}

template <typename T, std::size_t N>
void toArray(ClassBinding& b, const char* name, std::array<double, N> (T::*method)() const) {
    b.methods[name] = [method](void* self, const Args&, Store&) {
        const std::array<double, N> values = (as<T>(self)->*method)();
        return numbers(values.data(), N);
    };
}

/**
 * `fromArray(array)` reads the plain array the reference reads, which is a boxed `toArray()`.
 * Euler's form takes no offset at all and every other class defaults it to zero.
 */
template <typename T>
void fromArray(ClassBinding& b, const char* name) {
    b.methods[name] = [](void* self, const Args& a, Store& d) {
        const std::vector<double> values = d.numbers(a.at(0));
        (as<T>(self)->fromArray)(values.data());
        return chain();
    };
}

// ------------------------------------------------------------------------------ Vector2/3/4

void registerVector2(ClassBinding& b) {
    b.ctor = ctor<Vector2>(
        [](Vector2& v, const Args& a) { v.set(optional(a, 0, 0), optional(a, 1, 0)); });
    members<Vector2>(b, {"x", "y"}, {&Vector2::x, &Vector2::y});
    b.getters["width"] = [](void* self) { return Value::of(as<Vector2>(self)->width()); };
    b.getters["height"] = [](void* self) { return Value::of(as<Vector2>(self)->height()); };
    b.setters["width"] = [](void* self, const Value& v) { as<Vector2>(self)->x = number(v); };
    b.setters["height"] = [](void* self, const Value& v) { as<Vector2>(self)->y = number(v); };

    chainTwo<Vector2>(b, "set", &Vector2::set);
    chainOne<Vector2>(b, "setScalar", &Vector2::setScalar);
    chainOne<Vector2>(b, "setX", &Vector2::setX);
    chainOne<Vector2>(b, "setY", &Vector2::setY);
    chainOne<Vector2>(b, "addScalar", &Vector2::addScalar);
    chainOne<Vector2>(b, "subScalar", &Vector2::subScalar);
    chainOne<Vector2>(b, "multiplyScalar", &Vector2::multiplyScalar);
    chainOne<Vector2>(b, "divideScalar", &Vector2::divideScalar);
    chainTwo<Vector2>(b, "clampScalar", &Vector2::clampScalar);
    chainTwo<Vector2>(b, "clampLength", &Vector2::clampLength);
    chainOne<Vector2>(b, "setLength", &Vector2::setLength);
    chainVoid<Vector2>(b, "floor", &Vector2::floor);
    chainVoid<Vector2>(b, "ceil", &Vector2::ceil);
    chainVoid<Vector2>(b, "round", &Vector2::round);
    chainVoid<Vector2>(b, "roundToZero", &Vector2::roundToZero);
    chainVoid<Vector2>(b, "negate", &Vector2::negate);
    chainVoid<Vector2>(b, "normalize", &Vector2::normalize);
    chainRef<Vector2, Vector2>(b, "copy", "Vector2", &Vector2::copy);
    chainRef<Vector2, Vector2>(b, "add", "Vector2", &Vector2::add);
    chainRef<Vector2, Vector2>(b, "sub", "Vector2", &Vector2::sub);
    chainRef<Vector2, Vector2>(b, "multiply", "Vector2", &Vector2::multiply);
    chainRef<Vector2, Vector2>(b, "divide", "Vector2", &Vector2::divide);
    chainRef<Vector2, Vector2>(b, "min", "Vector2", &Vector2::min);
    chainRef<Vector2, Vector2>(b, "max", "Vector2", &Vector2::max);
    chainRef2<Vector2, Vector2>(b, "clamp", "Vector2", &Vector2::clamp);
    chainRefOne<Vector2, Vector2>(b, "lerp", "Vector2", &Vector2::lerp);
    chainRef2<Vector2, Vector2>(b, "addVectors", "Vector2", &Vector2::addVectors);
    chainRef2<Vector2, Vector2>(b, "subVectors", "Vector2", &Vector2::subVectors);
    chainRef2One<Vector2, Vector2>(b, "lerpVectors", "Vector2", &Vector2::lerpVectors);
    chainRefOne<Vector2, Vector2>(b, "addScaledVector", "Vector2", &Vector2::addScaledVector);
    chainRef<Vector2, Matrix3>(b, "applyMatrix3", "Matrix3", &Vector2::applyMatrix3);
    fromArray<Vector2>(b, "fromArray");
    toArray<Vector2>(b, "toArray", &Vector2::toArray);
    b.methods["clone"] = cloneAs<Vector2>("Vector2");

    b.methods["setComponent"] = [](void* self, const Args& a, Store&) {
        const int index = integer(a, 0);
        if (index < 0 || index > 1) throw Unsupported{"Vector2.setComponent index out of range"};
        as<Vector2>(self)->setComponent(index, number(a.at(1)));
        return chain();
    };
    b.methods["getComponent"] = [](void* self, const Args& a, Store&) {
        const int index = integer(a, 0);
        if (index < 0 || index > 1) throw Unsupported{"Vector2.getComponent index out of range"};
        return Value::of(as<Vector2>(self)->getComponent(index));
    };
    b.methods["rotateAround"] = [](void* self, const Args& a, Store& d) {
        as<Vector2>(self)->rotateAround(d.ref<Vector2>(a.at(0), "Vector2"), number(a.at(1)));
        return chain();
    };
    readScalar<Vector2>(b, "lengthSq", &Vector2::lengthSq);
    readScalar<Vector2>(b, "length", &Vector2::length);
    readScalar<Vector2>(b, "manhattanLength", &Vector2::manhattanLength);
    readScalar<Vector2>(b, "angle", &Vector2::angle);
    auto read2 = [&b](const char* name, double (Vector2::*Method)(const Vector2&) const) {
        b.methods[name] = [Method](void* self, const Args& a, Store& d) {
            Vector2 scratch;
            return Value::of((as<Vector2>(self)->*Method)(d.in<Vector2>(a.at(0), "Vector2", scratch)));
        };
    };
    read2("dot", &Vector2::dot);
    read2("cross", &Vector2::cross);
    read2("angleTo", &Vector2::angleTo);
    read2("distanceTo", &Vector2::distanceTo);
    read2("distanceToSquared", &Vector2::distanceToSquared);
    read2("manhattanDistanceTo", &Vector2::manhattanDistanceTo);
    b.methods["equals"] = [](void* self, const Args& a, Store& d) {
        return Value::of(as<Vector2>(self)->equals(d.ref<Vector2>(a.at(0), "Vector2")));
    };
}

void registerVector3(ClassBinding& b) {
    b.ctor = ctor<Vector3>([](Vector3& v, const Args& a) {
        v.set(optional(a, 0, 0), optional(a, 1, 0), optional(a, 2, 0));
    });
    members<Vector3>(b, {"x", "y", "z"}, {&Vector3::x, &Vector3::y, &Vector3::z});

    b.methods["set"] = [](void* self, const Args& a, Store&) {
        Vector3& v = *as<Vector3>(self);
        // three's two-argument shape keeps z, for the sprite-scale call form.
        if (a.size() >= 3) v.set(number(a.at(0)), number(a.at(1)), number(a.at(2)));
        else v.set(number(a.at(0)), number(a.at(1)));
        return chain();
    };
    chainOne<Vector3>(b, "setScalar", &Vector3::setScalar);
    chainOne<Vector3>(b, "setX", &Vector3::setX);
    chainOne<Vector3>(b, "setY", &Vector3::setY);
    chainOne<Vector3>(b, "setZ", &Vector3::setZ);
    chainOne<Vector3>(b, "addScalar", &Vector3::addScalar);
    chainOne<Vector3>(b, "subScalar", &Vector3::subScalar);
    chainOne<Vector3>(b, "multiplyScalar", &Vector3::multiplyScalar);
    chainOne<Vector3>(b, "divideScalar", &Vector3::divideScalar);
    chainTwo<Vector3>(b, "clampScalar", &Vector3::clampScalar);
    chainTwo<Vector3>(b, "clampLength", &Vector3::clampLength);
    chainOne<Vector3>(b, "setLength", &Vector3::setLength);
    chainThree<Vector3>(b, "setFromSphericalCoords", &Vector3::setFromSphericalCoords);
    chainThree<Vector3>(b, "setFromCylindricalCoords", &Vector3::setFromCylindricalCoords);
    chainVoid<Vector3>(b, "floor", &Vector3::floor);
    chainVoid<Vector3>(b, "ceil", &Vector3::ceil);
    chainVoid<Vector3>(b, "round", &Vector3::round);
    chainVoid<Vector3>(b, "roundToZero", &Vector3::roundToZero);
    chainVoid<Vector3>(b, "negate", &Vector3::negate);
    chainVoid<Vector3>(b, "normalize", &Vector3::normalize);
    // three's copy reads v.x, v.y and v.z: a Vector3, or a plain {x, y, z} a game passes (Midway's
    // audio cues), copies the same.
    b.methods["copy"] = [](void* self, const Args& a, Store& d) {
        const Value& source = a.at(0);
        if (source.kind == Value::Kind::Record) {
            double xyz[3] = {0, 0, 0};
            int found = 0;
            for (const auto& [key, value] : source.fields) {
                const auto lane = key == "x" ? 0 : key == "y" ? 1 : key == "z" ? 2 : -1;
                if (lane < 0) continue;
                xyz[lane] = number(value);
                ++found;
            }
            if (found != 3) throw Unsupported{"copy needs a Vector3 or an object with x, y and z"};
            as<Vector3>(self)->set(xyz[0], xyz[1], xyz[2]);
            return chain();
        }
        as<Vector3>(self)->copy(d.ref<Vector3>(source, "Vector3"));
        return chain();
    };
    chainRef<Vector3, Vector3>(b, "add", "Vector3", &Vector3::add);
    chainRef<Vector3, Vector3>(b, "sub", "Vector3", &Vector3::sub);
    chainRef<Vector3, Vector3>(b, "multiply", "Vector3", &Vector3::multiply);
    chainRef<Vector3, Vector3>(b, "divide", "Vector3", &Vector3::divide);
    chainRef<Vector3, Vector3>(b, "min", "Vector3", &Vector3::min);
    chainRef<Vector3, Vector3>(b, "max", "Vector3", &Vector3::max);
    chainRef2<Vector3, Vector3>(b, "clamp", "Vector3", &Vector3::clamp);
    chainRefOne<Vector3, Vector3>(b, "lerp", "Vector3", &Vector3::lerp);
    chainRef<Vector3, Vector3>(b, "cross", "Vector3", &Vector3::cross);
    chainRef<Vector3, Vector3>(b, "projectOnVector", "Vector3", &Vector3::projectOnVector);
    chainRef<Vector3, Vector3>(b, "projectOnPlane", "Vector3", &Vector3::projectOnPlane);
    chainRef<Vector3, Vector3>(b, "reflect", "Vector3", &Vector3::reflect);
    chainRef<Vector3, Euler>(b, "applyEuler", "Euler", &Vector3::applyEuler);
    chainRef<Vector3, Quaternion>(b, "applyQuaternion", "Quaternion", &Vector3::applyQuaternion);
    chainRef<Vector3, Matrix3>(b, "applyMatrix3", "Matrix3", &Vector3::applyMatrix3);
    chainRef<Vector3, Matrix3>(b, "applyNormalMatrix", "Matrix3", &Vector3::applyNormalMatrix);
    chainRef<Vector3, Matrix4>(b, "applyMatrix4", "Matrix4", &Vector3::applyMatrix4);
    chainRef<Vector3, Matrix4>(b, "transformDirection", "Matrix4", &Vector3::transformDirection);
    chainRef<Vector3, Matrix4>(b, "setFromMatrixPosition", "Matrix4", &Vector3::setFromMatrixPosition);
    chainRef<Vector3, Matrix4>(b, "setFromMatrixScale", "Matrix4", &Vector3::setFromMatrixScale);
    b.methods["setFromMatrix3Column"] = [](void* self, const Args& a, Store& d) {
        as<Vector3>(self)->setFromMatrix3Column(d.ref<Matrix3>(a.at(0), "Matrix3"), integer(a, 1));
        return chain();
    };
    chainRef<Vector3, Color>(b, "setFromColor", "Color", &Vector3::setFromColor);
    chainRefOne<Vector3, Vector3>(b, "addScaledVector", "Vector3", &Vector3::addScaledVector);
    chainRefOne<Vector3, Vector3>(b, "applyAxisAngle", "Vector3", &Vector3::applyAxisAngle);
    chainRef2<Vector3, Vector3>(b, "addVectors", "Vector3", &Vector3::addVectors);
    chainRef2<Vector3, Vector3>(b, "subVectors", "Vector3", &Vector3::subVectors);
    chainRef2<Vector3, Vector3>(b, "multiplyVectors", "Vector3", &Vector3::multiplyVectors);
    chainRef2<Vector3, Vector3>(b, "crossVectors", "Vector3", &Vector3::crossVectors);
    chainRef2One<Vector3, Vector3>(b, "lerpVectors", "Vector3", &Vector3::lerpVectors);
    fromArray<Vector3>(b, "fromArray");
    toArray<Vector3>(b, "toArray", &Vector3::toArray);
    b.methods["clone"] = cloneAs<Vector3>("Vector3");

    b.methods["setFromEuler"] = [](void* self, const Args& a, Store& d) {
        as<Vector3>(self)->setFromEuler(d.ref<Euler>(a.at(0), "Euler"));
        return chain();
    };
    b.methods["setFromMatrixColumn"] = [](void* self, const Args& a, Store& d) {
        as<Vector3>(self)->setFromMatrixColumn(d.ref<Matrix4>(a.at(0), "Matrix4"), integer(a, 1));
        return chain();
    };
    b.methods["setComponent"] = [](void* self, const Args& a, Store&) {
        const int index = integer(a, 0);
        if (index < 0 || index > 2) throw Unsupported{"Vector3.setComponent index out of range"};
        as<Vector3>(self)->setComponent(index, number(a.at(1)));
        return chain();
    };
    b.methods["getComponent"] = [](void* self, const Args& a, Store&) {
        const int index = integer(a, 0);
        if (index < 0 || index > 2) throw Unsupported{"Vector3.getComponent index out of range"};
        return Value::of(as<Vector3>(self)->getComponent(index));
    };
    readScalar<Vector3>(b, "lengthSq", &Vector3::lengthSq);
    readScalar<Vector3>(b, "length", &Vector3::length);
    readScalar<Vector3>(b, "manhattanLength", &Vector3::manhattanLength);
    auto read3 = [&b](const char* name, double (Vector3::*Method)(const Vector3&) const) {
        b.methods[name] = [Method](void* self, const Args& a, Store& d) {
            Vector3 scratch;
            return Value::of((as<Vector3>(self)->*Method)(d.in<Vector3>(a.at(0), "Vector3", scratch)));
        };
    };
    read3("dot", &Vector3::dot);
    read3("angleTo", &Vector3::angleTo);
    read3("distanceTo", &Vector3::distanceTo);
    read3("distanceToSquared", &Vector3::distanceToSquared);
    read3("manhattanDistanceTo", &Vector3::manhattanDistanceTo);
    b.methods["equals"] = [](void* self, const Args& a, Store& d) {
        Vector3 scratch;
        return Value::of(as<Vector3>(self)->equals(d.in<Vector3>(a.at(0), "Vector3", scratch)));
    };
}

void registerVector4(ClassBinding& b) {
    b.ctor = ctor<Vector4>([](Vector4& v, const Args& a) {
        v.set(optional(a, 0, 0), optional(a, 1, 0), optional(a, 2, 0), optional(a, 3, 1));
    });
    members<Vector4>(b, {"x", "y", "z", "w"},
                    {&Vector4::x, &Vector4::y, &Vector4::z, &Vector4::w});
    b.getters["width"] = [](void* self) { return Value::of(as<Vector4>(self)->width()); };
    b.getters["height"] = [](void* self) { return Value::of(as<Vector4>(self)->height()); };

    chainFour<Vector4>(b, "set", &Vector4::set);
    chainOne<Vector4>(b, "setScalar", &Vector4::setScalar);
    chainOne<Vector4>(b, "setX", &Vector4::setX);
    chainOne<Vector4>(b, "setY", &Vector4::setY);
    chainOne<Vector4>(b, "setZ", &Vector4::setZ);
    chainOne<Vector4>(b, "setW", &Vector4::setW);
    chainOne<Vector4>(b, "addScalar", &Vector4::addScalar);
    chainOne<Vector4>(b, "subScalar", &Vector4::subScalar);
    chainOne<Vector4>(b, "multiplyScalar", &Vector4::multiplyScalar);
    chainOne<Vector4>(b, "divideScalar", &Vector4::divideScalar);
    chainTwo<Vector4>(b, "clampScalar", &Vector4::clampScalar);
    chainTwo<Vector4>(b, "clampLength", &Vector4::clampLength);
    chainOne<Vector4>(b, "setLength", &Vector4::setLength);
    chainVoid<Vector4>(b, "floor", &Vector4::floor);
    chainVoid<Vector4>(b, "ceil", &Vector4::ceil);
    chainVoid<Vector4>(b, "round", &Vector4::round);
    chainVoid<Vector4>(b, "roundToZero", &Vector4::roundToZero);
    chainVoid<Vector4>(b, "negate", &Vector4::negate);
    chainVoid<Vector4>(b, "normalize", &Vector4::normalize);
    chainRef<Vector4, Vector4>(b, "add", "Vector4", &Vector4::add);
    chainRef<Vector4, Vector4>(b, "sub", "Vector4", &Vector4::sub);
    chainRef<Vector4, Vector4>(b, "multiply", "Vector4", &Vector4::multiply);
    chainRef<Vector4, Vector4>(b, "divide", "Vector4", &Vector4::divide);
    chainRef<Vector4, Vector4>(b, "min", "Vector4", &Vector4::min);
    chainRef<Vector4, Vector4>(b, "max", "Vector4", &Vector4::max);
    chainRef2<Vector4, Vector4>(b, "clamp", "Vector4", &Vector4::clamp);
    chainRefOne<Vector4, Vector4>(b, "lerp", "Vector4", &Vector4::lerp);
    chainRef<Vector4, Matrix4>(b, "applyMatrix4", "Matrix4", &Vector4::applyMatrix4);
    chainRef<Vector4, Quaternion>(b, "setAxisAngleFromQuaternion", "Quaternion", &Vector4::setAxisAngleFromQuaternion);
    chainRef<Vector4, Matrix4>(b, "setAxisAngleFromRotationMatrix", "Matrix4", &Vector4::setAxisAngleFromRotationMatrix);
    chainRef<Vector4, Matrix4>(b, "setFromMatrixPosition", "Matrix4", &Vector4::setFromMatrixPosition);
    chainRefOne<Vector4, Vector4>(b, "addScaledVector", "Vector4", &Vector4::addScaledVector);
    chainRef2<Vector4, Vector4>(b, "addVectors", "Vector4", &Vector4::addVectors);
    chainRef2<Vector4, Vector4>(b, "subVectors", "Vector4", &Vector4::subVectors);
    chainRef2One<Vector4, Vector4>(b, "lerpVectors", "Vector4", &Vector4::lerpVectors);
    fromArray<Vector4>(b, "fromArray");
    toArray<Vector4>(b, "toArray", &Vector4::toArray);
    b.methods["clone"] = cloneAs<Vector4>("Vector4");

    // three's Vector4.copy defaults w to 1 when the source has none, so Vector2/Vector3 work too.
    b.methods["copy"] = [](void* self, const Args& a, Store& d) {
        Vector4& v = *as<Vector4>(self);
        const Value& source = a.at(0);
        if (source.kind == Value::Kind::Record) {
            Vector4 scratch;
            const Vector4& s = d.in<Vector4>(source, "Vector4", scratch);
            const bool hasW = std::any_of(source.fields.begin(), source.fields.end(),
                                          [](const auto& field) { return field.first == "w"; });
            v.set(s.x, s.y, s.z, hasW ? s.w : 1);
            return chain();
        }
        try {
            v.copy(d.ref<Vector4>(source, "Vector4"));
        } catch (const Unsupported&) {
            try {
                const Vector3& s = d.ref<Vector3>(source, "Vector3");
                v.set(s.x, s.y, s.z, 1);
            } catch (const Unsupported&) {
                const Vector2& s = d.ref<Vector2>(source, "Vector2");
                v.set(s.x, s.y, 0, 1);
            }
        }
        return chain();
    };
    b.methods["setComponent"] = [](void* self, const Args& a, Store&) {
        const int index = integer(a, 0);
        if (index < 0 || index > 3) throw Unsupported{"Vector4.setComponent index out of range"};
        as<Vector4>(self)->setComponent(index, number(a.at(1)));
        return chain();
    };
    b.methods["getComponent"] = [](void* self, const Args& a, Store&) {
        const int index = integer(a, 0);
        if (index < 0 || index > 3) throw Unsupported{"Vector4.getComponent index out of range"};
        return Value::of(as<Vector4>(self)->getComponent(index));
    };
    readScalar<Vector4>(b, "lengthSq", &Vector4::lengthSq);
    readScalar<Vector4>(b, "length", &Vector4::length);
    readScalar<Vector4>(b, "manhattanLength", &Vector4::manhattanLength);
    b.methods["dot"] = [](void* self, const Args& a, Store& d) {
        return Value::of(as<Vector4>(self)->dot(d.ref<Vector4>(a.at(0), "Vector4")));
    };
    b.methods["equals"] = [](void* self, const Args& a, Store& d) {
        return Value::of(as<Vector4>(self)->equals(d.ref<Vector4>(a.at(0), "Vector4")));
    };
}

// ------------------------------------------------------------------------- Quaternion, Euler

void registerQuaternion(ClassBinding& b) {
    b.ctor = ctor<Quaternion>([](Quaternion& q, const Args& a) {
        q.set(optional(a, 0, 0), optional(a, 1, 0), optional(a, 2, 0), optional(a, 3, 1));
    });
    members<Quaternion>(b, {"x", "y", "z", "w"},
                        {&Quaternion::x, &Quaternion::y, &Quaternion::z, &Quaternion::w});
    notifyingSetters<Quaternion>(b, {"x", "y", "z", "w"},
                                 {&Quaternion::x, &Quaternion::y, &Quaternion::z, &Quaternion::w});

    chainFour<Quaternion>(b, "set", &Quaternion::set);
    chainVoid<Quaternion>(b, "identity", &Quaternion::identity);
    chainVoid<Quaternion>(b, "invert", &Quaternion::invert);
    chainVoid<Quaternion>(b, "conjugate", &Quaternion::conjugate);
    chainVoid<Quaternion>(b, "normalize", &Quaternion::normalize);
    chainRef<Quaternion, Quaternion>(b, "copy", "Quaternion", &Quaternion::copy);
    chainRef<Quaternion, Quaternion>(b, "multiply", "Quaternion", &Quaternion::multiply);
    chainRef<Quaternion, Quaternion>(b, "premultiply", "Quaternion", &Quaternion::premultiply);
    chainRefOne<Quaternion, Vector3>(b, "setFromAxisAngle", "Vector3", &Quaternion::setFromAxisAngle);
    chainRef2<Quaternion, Vector3>(b, "setFromUnitVectors", "Vector3", &Quaternion::setFromUnitVectors);
    chainRef<Quaternion, Matrix4>(b, "setFromRotationMatrix", "Matrix4", &Quaternion::setFromRotationMatrix);
    chainRef2<Quaternion, Quaternion>(b, "multiplyQuaternions", "Quaternion", &Quaternion::multiplyQuaternions);
    fromArray<Quaternion>(b, "fromArray");
    toArray<Quaternion>(b, "toArray", &Quaternion::toArray);
    b.methods["clone"] = cloneAs<Quaternion>("Quaternion");

    b.methods["setFromEuler"] = [](void* self, const Args& a, Store& d) {
        as<Quaternion>(self)->setFromEuler(d.ref<Euler>(a.at(0), "Euler"));
        return chain();
    };
    b.methods["slerp"] = [](void* self, const Args& a, Store& d) {
        as<Quaternion>(self)->slerp(d.ref<Quaternion>(a.at(0), "Quaternion"), number(a.at(1)));
        return chain();
    };
    b.methods["slerpQuaternions"] = [](void* self, const Args& a, Store& d) {
        as<Quaternion>(self)->slerpQuaternions(d.ref<Quaternion>(a.at(0), "Quaternion"),
                                               d.ref<Quaternion>(a.at(1), "Quaternion"),
                                               number(a.at(2)));
        return chain();
    };
    b.methods["rotateTowards"] = [](void* self, const Args& a, Store& d) {
        as<Quaternion>(self)->rotateTowards(d.ref<Quaternion>(a.at(0), "Quaternion"),
                                             number(a.at(1)));
        return chain();
    };
    readScalar<Quaternion>(b, "lengthSq", &Quaternion::lengthSq);
    readScalar<Quaternion>(b, "length", &Quaternion::length);
    b.methods["dot"] = [](void* self, const Args& a, Store& d) {
        return Value::of(as<Quaternion>(self)->dot(d.ref<Quaternion>(a.at(0), "Quaternion")));
    };
    b.methods["angleTo"] = [](void* self, const Args& a, Store& d) {
        return Value::of(as<Quaternion>(self)->angleTo(d.ref<Quaternion>(a.at(0), "Quaternion")));
    };
    b.methods["equals"] = [](void* self, const Args& a, Store& d) {
        return Value::of(as<Quaternion>(self)->equals(d.ref<Quaternion>(a.at(0), "Quaternion")));
    };
}

void registerEuler(ClassBinding& b) {
    b.ctor = ctor<Euler>([](Euler& e, const Args& a) {
        e.set(optional(a, 0, 0), optional(a, 1, 0), optional(a, 2, 0),
              order(a, 3, EulerOrder::XYZ));
    });
    members<Euler>(b, {"x", "y", "z"}, {&Euler::x, &Euler::y, &Euler::z});
    notifyingSetters<Euler>(b, {"x", "y", "z"}, {&Euler::x, &Euler::y, &Euler::z});
    b.getters["order"] = [](void* self) {
        static const char* const NAMES[] = {"XYZ", "YXZ", "ZXY", "ZYX", "YZX", "XZY"};
        return Value{Value::Kind::String, 0, NAMES[static_cast<int>(as<Euler>(self)->order)]};
    };
    auto orderName = b.getters["order"];
    b.setters["order"] = [](void* self, const Value& v) {
        Args one;
        one.push_back(v);
        as<Euler>(self)->order = order(one, 0, as<Euler>(self)->order);
        as<Euler>(self)->notify();  // three's order setter fires _onChangeCallback too
    };

    chainRef<Euler, Euler>(b, "copy", "Euler", &Euler::copy);
    b.methods["set"] = [](void* self, const Args& a, Store&) {
        as<Euler>(self)->set(number(a.at(0)), number(a.at(1)), number(a.at(2)),
                             order(a, 3, as<Euler>(self)->order));
        return chain();
    };
    b.methods["setFromRotationMatrix"] = [](void* self, const Args& a, Store& d) {
        as<Euler>(self)->setFromRotationMatrix(d.ref<Matrix4>(a.at(0), "Matrix4"),
                                              order(a, 1, as<Euler>(self)->order));
        return chain();
    };
    b.methods["setFromQuaternion"] = [](void* self, const Args& a, Store& d) {
        as<Euler>(self)->setFromQuaternion(d.ref<Quaternion>(a.at(0), "Quaternion"),
                                           order(a, 1, as<Euler>(self)->order));
        return chain();
    };
    b.methods["setFromVector3"] = [](void* self, const Args& a, Store& d) {
        as<Euler>(self)->setFromVector3(d.ref<Vector3>(a.at(0), "Vector3"),
                                       order(a, 1, as<Euler>(self)->order));
        return chain();
    };
    b.methods["reorder"] = [](void* self, const Args& a, Store&) {
        as<Euler>(self)->reorder(order(a, 0, as<Euler>(self)->order));
        return chain();
    };
    fromArray<Euler>(b, "fromArray");
    b.methods["toArray"] = [orderName](void* self, const Args&, Store&) {
        const std::array<double, 3> angles = as<Euler>(self)->toArray();
        // three returns [x, y, z, order]: the fourth slot is the order string, so a mixed array.
        return Value::array({Value::of(angles[0]), Value::of(angles[1]), Value::of(angles[2]), orderName(self)});
    };
    b.methods["clone"] = cloneAs<Euler>("Euler");
    b.methods["equals"] = [](void* self, const Args& a, Store& d) {
        return Value::of(as<Euler>(self)->equals(d.ref<Euler>(a.at(0), "Euler")));
    };
}

// ------------------------------------------------------------------------ Matrix3 and Matrix4

void registerMatrix3(ClassBinding& b) {
    b.ctor = ctor<Matrix3>([](Matrix3& m, const Args& a) {
        // three only calls set when the first argument exists, and fills the rest with undefined.
        if (a.empty()) return;
        double values[9];
        for (size_t i = 0; i < 9; ++i) values[i] = optional(a, i, QUIET_NAN);
        m.set(values[0], values[1], values[2], values[3], values[4], values[5], values[6],
              values[7], values[8]);
    });
    b.methods["set"] = [](void* self, const Args& a, Store&) {
        if (a.size() < 9) throw Unsupported{"Matrix3.set needs nine numbers"};
        double values[9];
        for (size_t i = 0; i < 9; ++i) values[i] = number(a.at(i));
        as<Matrix3>(self)->set(values[0], values[1], values[2], values[3], values[4], values[5],
                               values[6], values[7], values[8]);
        return chain();
    };
    b.getters["elements"] = [](void* self) {
        const std::array<double, 9>& e = as<Matrix3>(self)->elements;
        return numbers(e.data(), e.size());
    };
    fromArray<Matrix3>(b, "fromArray");
    toArray<Matrix3>(b, "toArray", &Matrix3::toArray);
    b.methods["clone"] = cloneAs<Matrix3>("Matrix3");

    chainVoid<Matrix3>(b, "identity", &Matrix3::identity);
    chainVoid<Matrix3>(b, "invert", &Matrix3::invert);
    chainVoid<Matrix3>(b, "transpose", &Matrix3::transpose);
    chainOne<Matrix3>(b, "multiplyScalar", &Matrix3::multiplyScalar);
    chainTwo<Matrix3>(b, "scale", &Matrix3::scale);
    chainOne<Matrix3>(b, "rotate", &Matrix3::rotate);
    chainTwo<Matrix3>(b, "translate", &Matrix3::translate);
    chainTwo<Matrix3>(b, "makeTranslation", &Matrix3::makeTranslation);
    chainOne<Matrix3>(b, "makeRotation", &Matrix3::makeRotation);
    chainTwo<Matrix3>(b, "makeScale", &Matrix3::makeScale);
    chainRef<Matrix3, Matrix3>(b, "copy", "Matrix3", &Matrix3::copy);
    chainRef<Matrix3, Matrix3>(b, "multiply", "Matrix3", &Matrix3::multiply);
    chainRef<Matrix3, Matrix3>(b, "premultiply", "Matrix3", &Matrix3::premultiply);
    chainRef<Matrix3, Matrix4>(b, "setFromMatrix4", "Matrix4", &Matrix3::setFromMatrix4);
    chainRef<Matrix3, Matrix4>(b, "getNormalMatrix", "Matrix4", &Matrix3::getNormalMatrix);
    chainRef2<Matrix3, Matrix3>(b, "multiplyMatrices", "Matrix3", &Matrix3::multiplyMatrices);
    readScalar<Matrix3>(b, "determinant", &Matrix3::determinant);
    b.methods["setUvTransform"] = [](void* self, const Args& a, Store&) {
        if (a.size() < 7) throw Unsupported{"Matrix3.setUvTransform needs seven numbers"};
        as<Matrix3>(self)->setUvTransform(number(a.at(0)), number(a.at(1)), number(a.at(2)),
                                          number(a.at(3)), number(a.at(4)), number(a.at(5)),
                                          number(a.at(6)));
        return chain();
    };
    b.methods["extractBasis"] = [](void* self, const Args& a, Store& d) {
        as<Matrix3>(self)->extractBasis(d.ref<Vector3>(a.at(0), "Vector3"),
                                        d.ref<Vector3>(a.at(1), "Vector3"),
                                        d.ref<Vector3>(a.at(2), "Vector3"));
        return chain();
    };
    b.methods["equals"] = [](void* self, const Args& a, Store& d) {
        return Value::of(as<Matrix3>(self)->equals(d.ref<Matrix3>(a.at(0), "Matrix3")));
    };
}

void registerMatrix4(ClassBinding& b) {
    b.ctor = ctor<Matrix4>([](Matrix4& m, const Args& a) {
        // three only calls set when the first argument exists, and fills the rest with undefined.
        if (a.empty()) return;
        double values[16];
        for (size_t i = 0; i < 16; ++i) values[i] = optional(a, i, QUIET_NAN);
        m.set(values[0], values[1], values[2], values[3], values[4], values[5], values[6], values[7],
              values[8], values[9], values[10], values[11], values[12], values[13], values[14],
              values[15]);
    });
    b.methods["set"] = [](void* self, const Args& a, Store&) {
        if (a.size() < 16) throw Unsupported{"Matrix4.set needs sixteen numbers"};
        double values[16];
        for (size_t i = 0; i < 16; ++i) values[i] = number(a.at(i));
        as<Matrix4>(self)->set(values[0], values[1], values[2], values[3], values[4], values[5],
                               values[6], values[7], values[8], values[9], values[10], values[11],
                               values[12], values[13], values[14], values[15]);
        return chain();
    };
    b.getters["elements"] = [](void* self) {
        const std::array<double, 16>& e = as<Matrix4>(self)->elements;
        return numbers(e.data(), e.size());
    };
    fromArray<Matrix4>(b, "fromArray");
    toArray<Matrix4>(b, "toArray", &Matrix4::toArray);
    b.methods["clone"] = cloneAs<Matrix4>("Matrix4");

    chainVoid<Matrix4>(b, "identity", &Matrix4::identity);
    chainVoid<Matrix4>(b, "transpose", &Matrix4::transpose);
    chainVoid<Matrix4>(b, "invert", &Matrix4::invert);
    chainOne<Matrix4>(b, "multiplyScalar", &Matrix4::multiplyScalar);
    chainOne<Matrix4>(b, "makeRotationX", &Matrix4::makeRotationX);
    chainOne<Matrix4>(b, "makeRotationY", &Matrix4::makeRotationY);
    chainOne<Matrix4>(b, "makeRotationZ", &Matrix4::makeRotationZ);
    chainRef<Matrix4, Matrix4>(b, "copy", "Matrix4", &Matrix4::copy);
    chainRef<Matrix4, Matrix4>(b, "copyPosition", "Matrix4", &Matrix4::copyPosition);
    chainRef<Matrix4, Matrix4>(b, "multiply", "Matrix4", &Matrix4::multiply);
    chainRef<Matrix4, Matrix4>(b, "premultiply", "Matrix4", &Matrix4::premultiply);
    chainRef<Matrix4, Matrix4>(b, "extractRotation", "Matrix4", &Matrix4::extractRotation);
    chainRef<Matrix4, Matrix3>(b, "setFromMatrix3", "Matrix3", &Matrix4::setFromMatrix3);
    chainRef<Matrix4, Vector3>(b, "scale", "Vector3", &Matrix4::scale);
    chainRef<Matrix4, Vector3>(b, "setPosition", "Vector3", &Matrix4::setPosition);
    chainThree<Matrix4>(b, "makeTranslation", &Matrix4::makeTranslation);
    chainThree<Matrix4>(b, "makeScale", &Matrix4::makeScale);
    chainRefOne<Matrix4, Vector3>(b, "makeRotationAxis", "Vector3", &Matrix4::makeRotationAxis);
    chainRef<Matrix4, Quaternion>(b, "makeRotationFromQuaternion", "Quaternion", &Matrix4::makeRotationFromQuaternion);
    chainRef2<Matrix4, Matrix4>(b, "multiplyMatrices", "Matrix4", &Matrix4::multiplyMatrices);
    readScalar<Matrix4>(b, "determinant", &Matrix4::determinant);
    readScalar<Matrix4>(b, "determinantAffine", &Matrix4::determinantAffine);
    readScalar<Matrix4>(b, "getMaxScaleOnAxis", &Matrix4::getMaxScaleOnAxis);

    b.methods["makeRotationFromEuler"] = [](void* self, const Args& a, Store& d) {
        as<Matrix4>(self)->makeRotationFromEuler(d.ref<Euler>(a.at(0), "Euler"));
        return chain();
    };
    b.methods["lookAt"] = [](void* self, const Args& a, Store& d) {
        as<Matrix4>(self)->lookAt(d.ref<Vector3>(a.at(0), "Vector3"),
                                  d.ref<Vector3>(a.at(1), "Vector3"),
                                  d.ref<Vector3>(a.at(2), "Vector3"));
        return chain();
    };
    b.methods["extractBasis"] = [](void* self, const Args& a, Store& d) {
        as<Matrix4>(self)->extractBasis(d.ref<Vector3>(a.at(0), "Vector3"),
                                        d.ref<Vector3>(a.at(1), "Vector3"),
                                        d.ref<Vector3>(a.at(2), "Vector3"));
        return chain();
    };
    b.methods["makeBasis"] = [](void* self, const Args& a, Store& d) {
        as<Matrix4>(self)->makeBasis(d.ref<Vector3>(a.at(0), "Vector3"),
                                     d.ref<Vector3>(a.at(1), "Vector3"),
                                     d.ref<Vector3>(a.at(2), "Vector3"));
        return chain();
    };
    b.methods["compose"] = [](void* self, const Args& a, Store& d) {
        as<Matrix4>(self)->compose(d.ref<Vector3>(a.at(0), "Vector3"),
                                   d.ref<Quaternion>(a.at(1), "Quaternion"),
                                   d.ref<Vector3>(a.at(2), "Vector3"));
        return chain();
    };
    b.methods["decompose"] = [](void* self, const Args& a, Store& d) {
        as<Matrix4>(self)->decompose(d.ref<Vector3>(a.at(0), "Vector3"),
                                     d.ref<Quaternion>(a.at(1), "Quaternion"),
                                     d.ref<Vector3>(a.at(2), "Vector3"));
        return chain();
    };
    b.methods["makeShear"] = [](void* self, const Args& a, Store&) {
        if (a.size() < 6) throw Unsupported{"Matrix4.makeShear needs six numbers"};
        as<Matrix4>(self)->makeShear(number(a.at(0)), number(a.at(1)), number(a.at(2)),
                                     number(a.at(3)), number(a.at(4)), number(a.at(5)));
        return chain();
    };
    b.methods["makePerspective"] = [](void* self, const Args& a, Store&) {
        if (a.size() < 6) throw Unsupported{"Matrix4.makePerspective needs six numbers"};
        as<Matrix4>(self)->makePerspective(number(a.at(0)), number(a.at(1)), number(a.at(2)),
                                           number(a.at(3)), number(a.at(4)), number(a.at(5)),
                                           system(a, 6, CoordinateSystem::WebGL),
                                           boolean(a, 7, false));
        return chain();
    };
    b.methods["makeOrthographic"] = [](void* self, const Args& a, Store&) {
        if (a.size() < 6) throw Unsupported{"Matrix4.makeOrthographic needs six numbers"};
        as<Matrix4>(self)->makeOrthographic(number(a.at(0)), number(a.at(1)), number(a.at(2)),
                                            number(a.at(3)), number(a.at(4)), number(a.at(5)),
                                            system(a, 6, CoordinateSystem::WebGL),
                                            boolean(a, 7, false));
        return chain();
    };
    b.methods["equals"] = [](void* self, const Args& a, Store& d) {
        return Value::of(as<Matrix4>(self)->equals(d.ref<Matrix4>(a.at(0), "Matrix4")));
    };
}

// ------------------------------------------------------------------------------------ Color

/** three's Color.set(r, g, b): one argument is a Color, a hex number or a CSS style; three are RGB. */
void setColor(Color& c, const Args& a, Store& d) {
    const auto absent = [&](size_t i) {
        return a.size() <= i || a.at(i).kind == Value::Kind::Undefined || a.at(i).kind == Value::Kind::Null;
    };
    const bool single = absent(1) && absent(2);
    if (!single) {
        c.setRGB(number(a.at(0)), number(a.at(1)), number(a.at(2)), space(a, 3, ColorSpace::LinearSRGB));
        return;
    }
    const Value& value = a.at(0);
    if (value.kind == Value::Kind::Ref) c.copy(d.ref<Color>(value, "Color"));
    else if (value.kind == Value::Kind::Number) c.setHex(value.number);
    else if (value.kind == Value::Kind::String) c.setStyle(value.text.c_str());
    else throw Unsupported{"Color.set needs a Color, a hex number, a CSS style or three numbers"};
}

void registerColor(ClassBinding& b) {
    b.ctor = [](const Args& a, Store& d) {
        auto c = std::make_shared<Color>();
        // three's no-argument Color stays white, untouched by any conversion; one argument is set().
        if (!a.empty() && a.at(0).kind != Value::Kind::Undefined && a.at(0).kind != Value::Kind::Null) setColor(*c, a, d);
        return std::static_pointer_cast<void>(c);
    };
    b.methods["set"] = [](void* self, const Args& a, Store& d) {
        if (a.empty()) throw Unsupported{"Color.set needs a value"};
        setColor(*as<Color>(self), a, d);
        return chain();
    };
    members<Color>(b, {"r", "g", "b"}, {&Color::r, &Color::g, &Color::b});

    b.methods["setRGB"] = [](void* self, const Args& a, Store&) {
        if (a.size() < 3) throw Unsupported{"Color.setRGB needs three numbers"};
        as<Color>(self)->setRGB(number(a.at(0)), number(a.at(1)), number(a.at(2)),
                                space(a, 3, ColorSpace::LinearSRGB));
        return chain();
    };
    b.methods["setHex"] = [](void* self, const Args& a, Store&) {
        as<Color>(self)->setHex(number(a.at(0)), space(a, 1, ColorSpace::SRGB));
        return chain();
    };
    b.methods["setHSL"] = [](void* self, const Args& a, Store&) {
        if (a.size() < 3) throw Unsupported{"Color.setHSL needs three numbers"};
        as<Color>(self)->setHSL(number(a.at(0)), number(a.at(1)), number(a.at(2)),
                                space(a, 3, ColorSpace::LinearSRGB));
        return chain();
    };
    b.methods["setStyle"] = [](void* self, const Args& a, Store&) {
        as<Color>(self)->setStyle(a.at(0).text.c_str(), space(a, 1, ColorSpace::SRGB));
        return chain();
    };
    b.methods["setColorName"] = [](void* self, const Args& a, Store&) {
        as<Color>(self)->setColorName(a.at(0).text.c_str(), space(a, 1, ColorSpace::SRGB));
        return chain();
    };
    chainOne<Color>(b, "setScalar", &Color::setScalar);
    chainOne<Color>(b, "addScalar", &Color::addScalar);
    chainOne<Color>(b, "multiplyScalar", &Color::multiplyScalar);
    chainVoid<Color>(b, "convertSRGBToLinear", &Color::convertSRGBToLinear);
    chainVoid<Color>(b, "convertLinearToSRGB", &Color::convertLinearToSRGB);
    chainRef<Color, Color>(b, "copy", "Color", &Color::copy);
    chainRef<Color, Color>(b, "copySRGBToLinear", "Color", &Color::copySRGBToLinear);
    chainRef<Color, Color>(b, "copyLinearToSRGB", "Color", &Color::copyLinearToSRGB);
    chainRef<Color, Color>(b, "add", "Color", &Color::add);
    chainRef<Color, Color>(b, "sub", "Color", &Color::sub);
    chainRef<Color, Color>(b, "multiply", "Color", &Color::multiply);
    chainRef<Color, Vector3>(b, "setFromVector3", "Vector3", &Color::setFromVector3);
    chainRef<Color, Matrix3>(b, "applyMatrix3", "Matrix3", &Color::applyMatrix3);
    chainRefOne<Color, Color>(b, "lerp", "Color", &Color::lerp);
    chainRefOne<Color, Color>(b, "lerpHSL", "Color", &Color::lerpHSL);
    chainRef2<Color, Color>(b, "addColors", "Color", &Color::addColors);
    fromArray<Color>(b, "fromArray");
    toArray<Color>(b, "toArray", &Color::toArray);
    b.methods["clone"] = cloneAs<Color>("Color");

    b.methods["lerpColors"] = [](void* self, const Args& a, Store& d) {
        as<Color>(self)->lerpColors(d.ref<Color>(a.at(0), "Color"), d.ref<Color>(a.at(1), "Color"),
                                    number(a.at(2)));
        return chain();
    };
    b.methods["offsetHSL"] = [](void* self, const Args& a, Store&) {
        as<Color>(self)->offsetHSL(number(a.at(0)), number(a.at(1)), number(a.at(2)));
        return chain();
    };
    b.methods["getHex"] = [](void* self, const Args& a, Store&) {
        return Value::of(as<Color>(self)->getHex(space(a, 0, ColorSpace::SRGB)));
    };
    b.methods["getHexString"] = [](void* self, const Args& a, Store&) {
        return Value{Value::Kind::String, 0, as<Color>(self)->getHexString(space(a, 0, ColorSpace::SRGB))};
    };
    // three fills a plain { h, s, l } target, which no class here has and the line protocol
    // cannot name, so this answers the three numbers instead and no fixture observes it.
    b.methods["getHSL"] = [](void* self, const Args& a, Store&) {
        const IColorHsl hsl = as<Color>(self)->getHSL(space(a, 0, ColorSpace::LinearSRGB));
        return Value::list({hsl.h, hsl.s, hsl.l});
    };
    // three writes r/g/b onto the target, so the target is another Color and the answer is it.
    b.methods["getRGB"] = [](void* self, const Args& a, Store& d) {
        Color& target = d.ref<Color>(a.at(0), "Color");
        const std::array<double, 3> rgb =
            as<Color>(self)->getRGB(space(a, 1, ColorSpace::LinearSRGB));
        target.setRGB(rgb[0], rgb[1], rgb[2], ColorSpace::LinearSRGB);
        return a.at(0);
    };
    b.methods["equals"] = [](void* self, const Args& a, Store& d) {
        return Value::of(as<Color>(self)->equals(d.ref<Color>(a.at(0), "Color")));
    };
}

// ------------------------------------------- Box3, Sphere, Plane, Ray and Frustum

void registerBox3(ClassBinding& b) {
    b.ctor = [](const Args& a, Store& d) {
        auto box = std::make_shared<Box3>();
        if (a.size() >= 2)
            box->set(d.ref<Vector3>(a.at(0), "Vector3"), d.ref<Vector3>(a.at(1), "Vector3"));
        return std::static_pointer_cast<void>(box);
    };
    nestedVector<Box3>(b, "min", &Box3::min);
    nestedVector<Box3>(b, "max", &Box3::max);
    chainOne<Box3>(b, "expandByScalar", &Box3::expandByScalar);
    chainVoid<Box3>(b, "makeEmpty", &Box3::makeEmpty);
    readFlag<Box3>(b, "isEmpty", &Box3::isEmpty);
    chainRef<Box3, Vector3>(b, "expandByPoint", "Vector3", &Box3::expandByPoint);
    chainRef<Box3, Vector3>(b, "expandByVector", "Vector3", &Box3::expandByVector);
    chainRef<Box3, Vector3>(b, "translate", "Vector3", &Box3::translate);
    chainRef<Box3, Box3>(b, "intersect", "Box3", &Box3::intersect);
    chainRef<Box3, Box3>(b, "union", "Box3", &Box3::unionWith);
    chainRef<Box3, Matrix4>(b, "applyMatrix4", "Matrix4", &Box3::applyMatrix4);

    chainRef<Box3, Box3>(b, "copy", "Box3", &Box3::copy);
    b.methods["set"] = [](void* self, const Args& a, Store& d) {
        as<Box3>(self)->set(d.ref<Vector3>(a.at(0), "Vector3"), d.ref<Vector3>(a.at(1), "Vector3"));
        return chain();
    };
    b.methods["setFromArray"] = [](void* self, const Args& a, Store& d) {
        const std::vector<double> values = d.numbers(a.at(0));
        as<Box3>(self)->setFromArray(values.data(), values.size());
        return chain();
    };
    b.methods["setFromPoints"] = [](void* self, const Args& a, Store& d) {
        as<Box3>(self)->setFromPoints(pointsOf(a, d));
        return chain();
    };
    b.methods["setFromCenterAndSize"] = [](void* self, const Args& a, Store& d) {
        as<Box3>(self)->setFromCenterAndSize(d.ref<Vector3>(a.at(0), "Vector3"),
                                             d.ref<Vector3>(a.at(1), "Vector3"));
        return chain();
    };
    b.methods["getCenter"] = [](void* self, const Args& a, Store& d) {
        as<Box3>(self)->getCenter(d.ref<Vector3>(a.at(0), "Vector3"));
        return a.at(0);  // three answers the target
    };
    b.methods["getSize"] = [](void* self, const Args& a, Store& d) {
        as<Box3>(self)->getSize(d.ref<Vector3>(a.at(0), "Vector3"));
        return a.at(0);  // three answers the target
    };
    b.methods["getParameter"] = [](void* self, const Args& a, Store& d) {
        as<Box3>(self)->getParameter(d.ref<Vector3>(a.at(0), "Vector3"),
                                     d.ref<Vector3>(a.at(1), "Vector3"));
        return a.at(1);  // three answers the target
    };
    b.methods["clampPoint"] = [](void* self, const Args& a, Store& d) {
        as<Box3>(self)->clampPoint(d.ref<Vector3>(a.at(0), "Vector3"),
                                   d.ref<Vector3>(a.at(1), "Vector3"));
        return a.at(1);  // three answers the target
    };
    b.methods["getBoundingSphere"] = [](void* self, const Args& a, Store& d) {
        if (a.empty())
            return d.adopt("Sphere", std::make_shared<Sphere>(as<Box3>(self)->getBoundingSphere()));
        // The port answers a fresh Sphere; three writes the target the caller names.
        d.ref<Sphere>(a.at(0), "Sphere") = as<Box3>(self)->getBoundingSphere();
        return a.at(0);
    };
    b.methods["containsPoint"] = [](void* self, const Args& a, Store& d) {
        return Value::of(as<Box3>(self)->containsPoint(d.ref<Vector3>(a.at(0), "Vector3")));
    };
    b.methods["containsBox"] = [](void* self, const Args& a, Store& d) {
        return Value::of(as<Box3>(self)->containsBox(d.ref<Box3>(a.at(0), "Box3")));
    };
    b.methods["intersectsBox"] = [](void* self, const Args& a, Store& d) {
        return Value::of(as<Box3>(self)->intersectsBox(d.ref<Box3>(a.at(0), "Box3")));
    };
    b.methods["intersectsSphere"] = [](void* self, const Args& a, Store& d) {
        return Value::of(as<Box3>(self)->intersectsSphere(d.ref<Sphere>(a.at(0), "Sphere")));
    };
    b.methods["intersectsPlane"] = [](void* self, const Args& a, Store& d) {
        return Value::of(as<Box3>(self)->intersectsPlane(d.ref<Plane>(a.at(0), "Plane")));
    };
    b.methods["distanceToPoint"] = [](void* self, const Args& a, Store& d) {
        return Value::of(as<Box3>(self)->distanceToPoint(d.ref<Vector3>(a.at(0), "Vector3")));
    };
    b.methods["equals"] = [](void* self, const Args& a, Store& d) {
        return Value::of(as<Box3>(self)->equals(d.ref<Box3>(a.at(0), "Box3")));
    };
}

void registerSphere(ClassBinding& b) {
    b.ctor = [](const Args& a, Store& d) {
        auto sphere = std::make_shared<Sphere>();
        if (!a.empty())
            sphere->set(d.ref<Vector3>(a.at(0), "Vector3"), a.size() > 1 ? number(a.at(1)) : -1);
        return std::static_pointer_cast<void>(sphere);
    };
    nestedVector<Sphere>(b, "center", &Sphere::center);
    members<Sphere>(b, {"radius"}, {&Sphere::radius});
    chainVoid<Sphere>(b, "makeEmpty", &Sphere::makeEmpty);
    readFlag<Sphere>(b, "isEmpty", &Sphere::isEmpty);
    chainRef<Sphere, Sphere>(b, "copy", "Sphere", &Sphere::copy);
    chainRef<Sphere, Vector3>(b, "translate", "Vector3", &Sphere::translate);
    chainRef<Sphere, Vector3>(b, "expandByPoint", "Vector3", &Sphere::expandByPoint);
    chainRef<Sphere, Sphere>(b, "union", "Sphere", &Sphere::unionWith);
    chainRef<Sphere, Matrix4>(b, "applyMatrix4", "Matrix4", &Sphere::applyMatrix4);

    b.methods["set"] = [](void* self, const Args& a, Store& d) {
        as<Sphere>(self)->set(d.ref<Vector3>(a.at(0), "Vector3"),
                              a.size() > 1 ? number(a.at(1)) : -1);
        return chain();
    };
    b.methods["setFromPoints"] = [](void* self, const Args& a, Store& d) {
        // The line protocol carries no array value, so the points arrive as a run of references.
        // three's optional centre has no argument left over here, so this is its centroid form.
        as<Sphere>(self)->setFromPoints(pointsOf(a, d));
        return chain();
    };
    b.methods["clampPoint"] = [](void* self, const Args& a, Store& d) {
        as<Sphere>(self)->clampPoint(d.ref<Vector3>(a.at(0), "Vector3"),
                                     d.ref<Vector3>(a.at(1), "Vector3"));
        return a.at(1);  // three answers the target
    };
    b.methods["getBoundingBox"] = [](void* self, const Args& a, Store& d) {
        if (a.empty())
            return d.adopt("Box3", std::make_shared<Box3>(as<Sphere>(self)->getBoundingBox()));
        d.ref<Box3>(a.at(0), "Box3") = as<Sphere>(self)->getBoundingBox();
        return a.at(0);
    };
    b.methods["containsPoint"] = [](void* self, const Args& a, Store& d) {
        return Value::of(as<Sphere>(self)->containsPoint(d.ref<Vector3>(a.at(0), "Vector3")));
    };
    b.methods["distanceToPoint"] = [](void* self, const Args& a, Store& d) {
        return Value::of(as<Sphere>(self)->distanceToPoint(d.ref<Vector3>(a.at(0), "Vector3")));
    };
    b.methods["intersectsSphere"] = [](void* self, const Args& a, Store& d) {
        return Value::of(as<Sphere>(self)->intersectsSphere(d.ref<Sphere>(a.at(0), "Sphere")));
    };
    b.methods["intersectsBox"] = [](void* self, const Args& a, Store& d) {
        return Value::of(as<Sphere>(self)->intersectsBox(d.ref<Box3>(a.at(0), "Box3")));
    };
    b.methods["intersectsPlane"] = [](void* self, const Args& a, Store& d) {
        return Value::of(as<Sphere>(self)->intersectsPlane(d.ref<Plane>(a.at(0), "Plane")));
    };
    b.methods["equals"] = [](void* self, const Args& a, Store& d) {
        return Value::of(as<Sphere>(self)->equals(d.ref<Sphere>(a.at(0), "Sphere")));
    };
}

void registerPlane(ClassBinding& b) {
    b.ctor = [](const Args& a, Store& d) {
        auto plane = std::make_shared<Plane>();
        if (!a.empty())
            plane->set(d.ref<Vector3>(a.at(0), "Vector3"), a.size() > 1 ? number(a.at(1)) : 0);
        return std::static_pointer_cast<void>(plane);
    };
    nestedVector<Plane>(b, "normal", &Plane::normal);
    members<Plane>(b, {"constant"}, {&Plane::constant});
    chainVoid<Plane>(b, "normalize", &Plane::normalize);
    chainVoid<Plane>(b, "negate", &Plane::negate);
    chainRef<Plane, Plane>(b, "copy", "Plane", &Plane::copy);
    chainRef<Plane, Vector3>(b, "translate", "Vector3", &Plane::translate);
    chainRef<Plane, Matrix4>(b, "applyMatrix4", "Matrix4", &Plane::applyMatrix4);

    b.methods["set"] = [](void* self, const Args& a, Store& d) {
        as<Plane>(self)->set(d.ref<Vector3>(a.at(0), "Vector3"),
                             a.size() > 1 ? number(a.at(1)) : 0);
        return chain();
    };
    b.methods["setComponents"] = [](void* self, const Args& a, Store&) {
        as<Plane>(self)->setComponents(number(a.at(0)), number(a.at(1)), number(a.at(2)),
                                       number(a.at(3)));
        return chain();
    };
    b.methods["setFromNormalAndCoplanarPoint"] = [](void* self, const Args& a, Store& d) {
        as<Plane>(self)->setFromNormalAndCoplanarPoint(d.ref<Vector3>(a.at(0), "Vector3"),
                                                       d.ref<Vector3>(a.at(1), "Vector3"));
        return chain();
    };
    b.methods["setFromCoplanarPoints"] = [](void* self, const Args& a, Store& d) {
        as<Plane>(self)->setFromCoplanarPoints(d.ref<Vector3>(a.at(0), "Vector3"),
                                               d.ref<Vector3>(a.at(1), "Vector3"),
                                               d.ref<Vector3>(a.at(2), "Vector3"));
        return chain();
    };
    b.methods["projectPoint"] = [](void* self, const Args& a, Store& d) {
        as<Plane>(self)->projectPoint(d.ref<Vector3>(a.at(0), "Vector3"),
                                      d.ref<Vector3>(a.at(1), "Vector3"));
        return a.at(1);  // three answers the target
    };
    b.methods["coplanarPoint"] = [](void* self, const Args& a, Store& d) {
        as<Plane>(self)->coplanarPoint(d.ref<Vector3>(a.at(0), "Vector3"));
        return a.at(0);  // three answers the target
    };
    b.methods["distanceToPoint"] = [](void* self, const Args& a, Store& d) {
        return Value::of(as<Plane>(self)->distanceToPoint(d.ref<Vector3>(a.at(0), "Vector3")));
    };
    b.methods["distanceToSphere"] = [](void* self, const Args& a, Store& d) {
        return Value::of(as<Plane>(self)->distanceToSphere(d.ref<Sphere>(a.at(0), "Sphere")));
    };
    b.methods["intersectsBox"] = [](void* self, const Args& a, Store& d) {
        return Value::of(as<Plane>(self)->intersectsBox(d.ref<Box3>(a.at(0), "Box3")));
    };
    b.methods["intersectsSphere"] = [](void* self, const Args& a, Store& d) {
        return Value::of(as<Plane>(self)->intersectsSphere(d.ref<Sphere>(a.at(0), "Sphere")));
    };
    b.methods["equals"] = [](void* self, const Args& a, Store& d) {
        return Value::of(as<Plane>(self)->equals(d.ref<Plane>(a.at(0), "Plane")));
    };
}

void registerRay(ClassBinding& b) {
    b.ctor = [](const Args& a, Store& d) {
        auto ray = std::make_shared<Ray>();
        if (!a.empty() && a.at(0).kind != Value::Kind::Null) ray->origin.copy(d.ref<Vector3>(a.at(0), "Vector3"));
        if (a.size() > 1 && a.at(1).kind != Value::Kind::Null) ray->direction.copy(d.ref<Vector3>(a.at(1), "Vector3"));
        return std::static_pointer_cast<void>(ray);
    };
    nestedVector<Ray>(b, "origin", &Ray::origin);
    nestedVector<Ray>(b, "direction", &Ray::direction);
    chainRef<Ray, Ray>(b, "copy", "Ray", &Ray::copy);
    chainRef<Ray, Matrix4>(b, "applyMatrix4", "Matrix4", &Ray::applyMatrix4);
    b.methods["clone"] = cloneAs<Ray>("Ray");

    b.methods["set"] = [](void* self, const Args& a, Store& d) {
        as<Ray>(self)->set(d.ref<Vector3>(a.at(0), "Vector3"),
                           a.size() > 1 ? d.ref<Vector3>(a.at(1), "Vector3") : Vector3(0, 0, -1));
        return chain();
    };
    b.methods["at"] = [](void* self, const Args& a, Store& d) {
        as<Ray>(self)->at(number(a.at(0)), d.ref<Vector3>(a.at(1), "Vector3"));
        return a.at(1);  // three answers the target
    };
    b.methods["lookAt"] = [](void* self, const Args& a, Store& d) {
        as<Ray>(self)->lookAt(d.ref<Vector3>(a.at(0), "Vector3"));
        return chain();
    };
    b.methods["recast"] = [](void* self, const Args& a, Store&) {
        as<Ray>(self)->recast(number(a.at(0)));
        return chain();
    };
    b.methods["closestPointToPoint"] = [](void* self, const Args& a, Store& d) {
        as<Ray>(self)->closestPointToPoint(d.ref<Vector3>(a.at(0), "Vector3"),
                                           d.ref<Vector3>(a.at(1), "Vector3"));
        return a.at(1);  // three answers the target
    };
    b.methods["distanceSqToSegment"] = [](void* self, const Args& a, Store& d) {
        if (a.size() < 2 || a.size() > 4) throw Unsupported{"Ray.distanceSqToSegment needs 2 to 4 args"};
        Vector3 onRay;
        Vector3 onSegment;
        const double sqrDist = as<Ray>(self)->distanceSqToSegment(
            d.ref<Vector3>(a.at(0), "Vector3"), d.ref<Vector3>(a.at(1), "Vector3"),
            a.size() > 2 ? &onRay : nullptr, a.size() > 3 ? &onSegment : nullptr);
        if (a.size() > 2) d.ref<Vector3>(a.at(2), "Vector3").copy(onRay);
        if (a.size() > 3) d.ref<Vector3>(a.at(3), "Vector3").copy(onSegment);
        return Value::of(sqrDist);
    };
    b.methods["intersectSphere"] = [](void* self, const Args& a, Store& d) {
        const bool hit = as<Ray>(self)->intersectSphere(d.ref<Sphere>(a.at(0), "Sphere"),
                                       d.ref<Vector3>(a.at(1), "Vector3"));
        return hit ? a.at(1) : Value{};
    };
    b.methods["intersectsSphere"] = [](void* self, const Args& a, Store& d) {
        return Value::of(as<Ray>(self)->intersectsSphere(d.ref<Sphere>(a.at(0), "Sphere")));
    };
    b.methods["intersectPlane"] = [](void* self, const Args& a, Store& d) {
        const bool hit = as<Ray>(self)->intersectPlane(d.ref<Plane>(a.at(0), "Plane"),
                                      d.ref<Vector3>(a.at(1), "Vector3"));
        return hit ? a.at(1) : Value{};
    };
    b.methods["intersectsPlane"] = [](void* self, const Args& a, Store& d) {
        return Value::of(as<Ray>(self)->intersectsPlane(d.ref<Plane>(a.at(0), "Plane")));
    };
    b.methods["intersectBox"] = [](void* self, const Args& a, Store& d) {
        const bool hit = as<Ray>(self)->intersectBox(d.ref<Box3>(a.at(0), "Box3"), d.ref<Vector3>(a.at(1), "Vector3"));
        return hit ? a.at(1) : Value{};
    };
    b.methods["intersectsBox"] = [](void* self, const Args& a, Store& d) {
        return Value::of(as<Ray>(self)->intersectsBox(d.ref<Box3>(a.at(0), "Box3")));
    };
    b.methods["intersectTriangle"] = [](void* self, const Args& a, Store& d) {
        const bool hit = as<Ray>(self)->intersectTriangle(d.ref<Vector3>(a.at(0), "Vector3"),
                                         d.ref<Vector3>(a.at(1), "Vector3"),
                                         d.ref<Vector3>(a.at(2), "Vector3"), boolean(a, 3, false),
                                         d.ref<Vector3>(a.at(4), "Vector3"));
        return hit ? a.at(4) : Value{};
    };
    b.methods["distanceToPoint"] = [](void* self, const Args& a, Store& d) {
        return Value::of(as<Ray>(self)->distanceToPoint(d.ref<Vector3>(a.at(0), "Vector3")));
    };
    b.methods["distanceSqToPoint"] = [](void* self, const Args& a, Store& d) {
        return Value::of(as<Ray>(self)->distanceSqToPoint(d.ref<Vector3>(a.at(0), "Vector3")));
    };
    b.methods["distanceToPlane"] = [](void* self, const Args& a, Store& d) {
        double distance = 0;
        // three answers null for a coplanar or receding ray; NaN is the value a fixture compares.
        if (!as<Ray>(self)->distanceToPlane(d.ref<Plane>(a.at(0), "Plane"), distance))
            return Value::of(QUIET_NAN);
        return Value::of(distance);
    };
    b.methods["equals"] = [](void* self, const Args& a, Store& d) {
        return Value::of(as<Ray>(self)->equals(d.ref<Ray>(a.at(0), "Ray")));
    };
}

void registerFrustum(ClassBinding& b) {
    b.ctor = ctor<Frustum>([](Frustum&, const Args&) {});
    chainRef<Frustum, Frustum>(b, "copy", "Frustum", &Frustum::copy);
    b.methods["clone"] = cloneAs<Frustum>("Frustum");
    b.methods["set"] = [](void* self, const Args& a, Store& d) {
        Plane planes[6];
        for (size_t i = 0; i < 6; ++i) planes[i] = d.ref<Plane>(a.at(i), "Plane");
        as<Frustum>(self)->set(planes[0], planes[1], planes[2], planes[3], planes[4], planes[5]);
        return chain();
    };
    b.methods["setFromProjectionMatrix"] = [](void* self, const Args& a, Store& d) {
        as<Frustum>(self)->setFromProjectionMatrix(d.ref<Matrix4>(a.at(0), "Matrix4"),
                                                   system(a, 1, CoordinateSystem::WebGL),
                                                   boolean(a, 2, false));
        return chain();
    };
    b.methods["intersectsSphere"] = [](void* self, const Args& a, Store& d) {
        return Value::of(as<Frustum>(self)->intersectsSphere(d.ref<Sphere>(a.at(0), "Sphere")));
    };
    b.methods["intersectsBox"] = [](void* self, const Args& a, Store& d) {
        return Value::of(as<Frustum>(self)->intersectsBox(d.ref<Box3>(a.at(0), "Box3")));
    };
    b.methods["containsPoint"] = [](void* self, const Args& a, Store& d) {
        return Value::of(as<Frustum>(self)->containsPoint(d.ref<Vector3>(a.at(0), "Vector3")));
    };
    for (int i = 0; i < 6; ++i) {
        const std::string prefix = "planes." + std::to_string(i) + ".";
        for (int axis = 0; axis < 3; ++axis) {
            b.getters[prefix + "normal." + "xyz"[axis]] = [i, axis](void* self) {
                return Value::of(component(as<Frustum>(self)->planes[i].normal, axis));
            };
        }
        b.getters[prefix + "constant"] = [i](void* self) {
            return Value::of(as<Frustum>(self)->planes[i].constant);
        };
        b.setters[prefix + "constant"] = [i](void* self, const Value& v) {
            as<Frustum>(self)->planes[i].constant = number(v);
        };
    }
}

}  // namespace

/** Every engine class the differential fixtures can reach; each work package adds its own. */
void registerMathBindings(Registry& classes) {
    const std::pair<const char*, void (*)(ClassBinding&)> CLASSES[] = {
        {"Vector2", registerVector2},   {"Vector3", registerVector3},
        {"Vector4", registerVector4},   {"Quaternion", registerQuaternion},
        {"Euler", registerEuler},       {"Matrix3", registerMatrix3},
        {"Matrix4", registerMatrix4},   {"Color", registerColor},
        {"Box3", registerBox3},         {"Sphere", registerSphere},
        {"Plane", registerPlane},       {"Ray", registerRay},
        {"Frustum", registerFrustum},
    };
    for (const auto& [name, bind] : CLASSES) {
        ClassBinding binding;
        bind(binding);
        classes[name] = binding;
    }
    // In-place doubles (ClassBinding::fields), measured on a real object of each class.
    const auto field = [](const auto& object, const auto& member, uint32_t count = 1) {
        const auto* base = reinterpret_cast<const char*>(&object);
        return std::pair<uint32_t, uint32_t>{uint32_t(reinterpret_cast<const char*>(&member) - base), count};
    };
    static const Vector2 v2;
    static const Vector3 v3;
    static const Vector4 v4;
    static const Quaternion q;
    static const Euler e;
    static const Color c;
    static const Matrix3 m3;
    static const Matrix4 m4;
    static const Sphere sphere;
    classes["Vector2"].fields = {{"x", field(v2, v2.x)}, {"y", field(v2, v2.y)}};
    classes["Vector3"].fields = {{"x", field(v3, v3.x)}, {"y", field(v3, v3.y)}, {"z", field(v3, v3.z)}};
    classes["Vector4"].fields = {{"x", field(v4, v4.x)}, {"y", field(v4, v4.y)}, {"z", field(v4, v4.z)}, {"w", field(v4, v4.w)}};
    classes["Quaternion"].fields = {{"x", field(q, q.x)}, {"y", field(q, q.y)}, {"z", field(q, q.z)}, {"w", field(q, q.w)}};
    // `__order` is the order enum's low byte (count 0, as a bool field): with it the browser back end
    // writes an Object3D's rotation in place and syncs the quaternion itself.
    classes["Euler"].fields = {{"x", field(e, e.x)}, {"y", field(e, e.y)}, {"z", field(e, e.z)}, {"__order", field(e, e.order, 0)}};
    classes["Color"].fields = {{"r", field(c, c.r)}, {"g", field(c, c.g)}, {"b", field(c, c.b)}};
    classes["Matrix3"].fields = {{"elements", field(m3, m3.elements[0], 9)}};
    classes["Matrix4"].fields = {{"elements", field(m4, m4.elements[0], 16)}};
    classes["Sphere"].fields = {{"radius", field(sphere, sphere.radius)}};
    for (auto& [name, binding] : classes)
        if (!binding.fields.empty())
            binding.getters["__address"] = [](void* self) { return Value::of(double(reinterpret_cast<uintptr_t>(self))); };
}

}  // namespace tn::binding
