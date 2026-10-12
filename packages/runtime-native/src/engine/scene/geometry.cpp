// BufferAttribute and BufferGeometry, ported from three@0.185.1 src/core/BufferAttribute.js and
// src/core/BufferGeometry.js. Every mutation keeps three's operation order; the array data lives in
// a BufferStore (PRD-504) so `needsUpdate` and `version` are the store's and the renderer uploads
// from it directly.

#include "engine/scene/geometry.h"

#include <algorithm>
#include <bit>
#include <charconv>
#include <cmath>
#include <cstring>
#include <limits>
#include <utility>

namespace tn::engine {

namespace {

uint64_t nextAttributeId() {
    static uint64_t id = 0;
    return id++;
}

/** three's `arrayNeedsUint32`: the index buffer is Uint32 only when a value reaches 65535. */
bool arrayNeedsUint32(const std::vector<uint32_t>& values) {
    for (uint32_t value : values) {
        if (value >= 65535) return true;
    }
    return false;
}

}  // namespace

// ECMAScript Number::toString(10) over the shortest round-trip digits: `100000` and `1e-7`, where
// std::to_chars alone writes `1e+05` and `1e-07`.
std::string jsNumber(double value) {
    if (std::isnan(value)) return "NaN";
    if (value == 0) return "0";  // -0 too
    if (std::isinf(value)) return value < 0 ? "-Infinity" : "Infinity";
    if (value < 0) return "-" + jsNumber(-value);
    char buffer[40];
    const auto result = std::to_chars(buffer, buffer + sizeof buffer, value, std::chars_format::scientific);
    const std::string text(buffer, result.ptr);           // "d.ddde+XX" or "de-XX"
    const size_t e = text.find('e');
    std::string digits = text.substr(0, e);
    digits.erase(std::remove(digits.begin(), digits.end(), '.'), digits.end());
    const int k = static_cast<int>(digits.size());
    const int n = std::stoi(text.substr(e + 1)) + 1;     // value = 0.digits x 10^n
    if (k <= n && n <= 21) return digits + std::string(static_cast<size_t>(n - k), '0');
    if (0 < n && n <= 21) return digits.substr(0, static_cast<size_t>(n)) + "." + digits.substr(static_cast<size_t>(n));
    if (-6 < n && n <= 0) return "0." + std::string(static_cast<size_t>(-n), '0') + digits;
    const int exponent = n - 1;
    const std::string mantissa = k == 1 ? digits : digits.substr(0, 1) + "." + digits.substr(1);
    return mantissa + "e" + (exponent < 0 ? "-" : "+") + std::to_string(std::abs(exponent));
}

namespace {

/** JSON.stringify's number form: Number::toString, and null for NaN and the infinities. */
std::string jsonNumber(double value) {
    return std::isfinite(value) ? jsNumber(value) : "null";
}

}  // namespace

// ------------------------------------------------------------------- BufferAttribute

BufferAttribute::BufferAttribute(Scalar scalar, uint64_t count, int itemSize, bool normalized)
    : store(std::make_shared<BufferStore>(scalar, count)),
      itemSize(itemSize),
      normalized(normalized),
      id(nextAttributeId()) {}

std::shared_ptr<BufferAttribute> BufferAttribute::fromFloats(const std::vector<double>& values,
                                                             int itemSize, bool normalized) {
    return fromDoubles(Scalar::F32, values, itemSize, normalized);
}

namespace {

/** ECMAScript ToInt8/16/32 and ToUint8/16/32: truncate, wrap modulo 2^bits, then read as signed. */
int64_t jsToInteger(double value, int bits, bool isSigned) {
    // In range, truncation is the whole conversion; NaN fails both comparisons and falls through.
    const double lo = isSigned ? -std::ldexp(1.0, bits - 1) : 0.0;
    const double hi = isSigned ? std::ldexp(1.0, bits - 1) : std::ldexp(1.0, bits);
    if (value > lo - 1 && value < hi) return static_cast<int64_t>(value);
    if (!std::isfinite(value)) return 0;
    const double modulus = std::ldexp(1.0, bits);
    double wrapped = std::fmod(std::trunc(value), modulus);
    if (wrapped < 0) wrapped += modulus;
    if (isSigned && wrapped >= modulus / 2) wrapped -= modulus;
    return static_cast<int64_t>(wrapped);
}

// One typed write loop for a freshly sized store: `values.size()` equals the store's count, so
// the per-element bounds check and validate of `setRaw` are dead weight over a million elements.
template <typename T, typename Source, typename Convert>
void fillStore(BufferStore& store, const std::vector<Source>& values, Convert convert) {
    std::byte* out = store.data();
    for (size_t i = 0; i < values.size(); ++i) {
        const T value = convert(values[i]);
        std::memcpy(out + i * sizeof(T), &value, sizeof(T));
    }
}

template <typename T>
T load(const BufferStore& store, uint64_t element) {
    T value{};
    store.read(element * sizeof(T), &value, sizeof(T));
    return value;
}

template <typename T>
void storeValue(BufferStore& store, uint64_t element, T value) {
    store.write(element * sizeof(T), &value, sizeof(T));
}

}  // namespace

std::shared_ptr<BufferAttribute> BufferAttribute::fromDoubles(Scalar scalar,
                                                              const std::vector<double>& values,
                                                              int itemSize, bool normalized) {
    auto attribute = std::make_shared<BufferAttribute>(scalar, values.size(), itemSize, normalized);
    BufferStore& store = *attribute->store;
    switch (scalar) {
        case Scalar::F32: fillStore<float>(store, values, [](double v) { return static_cast<float>(v); }); break;
        case Scalar::F64: fillStore<double>(store, values, [](double v) { return v; }); break;
        case Scalar::I8: fillStore<int8_t>(store, values, [](double v) { return static_cast<int8_t>(jsToInteger(v, 8, true)); }); break;
        case Scalar::U8: fillStore<uint8_t>(store, values, [](double v) { return static_cast<uint8_t>(jsToInteger(v, 8, false)); }); break;
        case Scalar::I16: fillStore<int16_t>(store, values, [](double v) { return static_cast<int16_t>(jsToInteger(v, 16, true)); }); break;
        case Scalar::U16: fillStore<uint16_t>(store, values, [](double v) { return static_cast<uint16_t>(jsToInteger(v, 16, false)); }); break;
        case Scalar::I32: fillStore<int32_t>(store, values, [](double v) { return static_cast<int32_t>(jsToInteger(v, 32, true)); }); break;
        case Scalar::U32: fillStore<uint32_t>(store, values, [](double v) { return static_cast<uint32_t>(jsToInteger(v, 32, false)); }); break;
    }
    return attribute;
}

std::shared_ptr<BufferAttribute> BufferAttribute::fromIndices(const std::vector<uint32_t>& values) {
    const Scalar scalar = arrayNeedsUint32(values) ? Scalar::U32 : Scalar::U16;
    auto attribute = std::make_shared<BufferAttribute>(scalar, values.size(), 1);
    BufferStore& store = *attribute->store;
    if (scalar == Scalar::U32) fillStore<uint32_t>(store, values, [](uint32_t v) { return v; });
    else fillStore<uint16_t>(store, values, [](uint32_t v) { return static_cast<uint16_t>(v); });
    return attribute;
}

// A typed array read: NaN past the end (where JS reads `undefined`, which arithmetic turns to NaN),
// never uninitialised bytes.
double BufferAttribute::raw(uint64_t elementIndex) const {
    if (elementIndex >= store->count()) return std::numeric_limits<double>::quiet_NaN();
    switch (store->scalar()) {
        case Scalar::F32: return load<float>(*store, elementIndex);
        case Scalar::F64: return load<double>(*store, elementIndex);
        case Scalar::I8: return load<int8_t>(*store, elementIndex);
        case Scalar::U8: return load<uint8_t>(*store, elementIndex);
        case Scalar::I16: return load<int16_t>(*store, elementIndex);
        case Scalar::U16: return load<uint16_t>(*store, elementIndex);
        case Scalar::I32: return load<int32_t>(*store, elementIndex);
        case Scalar::U32: return load<uint32_t>(*store, elementIndex);
    }
    return std::numeric_limits<double>::quiet_NaN();
}

// A typed array write: Math.fround for Float32, ToIntN wrapping for the integer arrays, and a
// write past the end is ignored, as JS ignores it.
void BufferAttribute::setRaw(uint64_t elementIndex, double value) {
    if (elementIndex >= store->count()) return;
    switch (store->scalar()) {
        case Scalar::F32: return storeValue(*store, elementIndex, static_cast<float>(value));
        case Scalar::F64: return storeValue(*store, elementIndex, value);
        case Scalar::I8: return storeValue(*store, elementIndex, static_cast<int8_t>(jsToInteger(value, 8, true)));
        case Scalar::U8: return storeValue(*store, elementIndex, static_cast<uint8_t>(jsToInteger(value, 8, false)));
        case Scalar::I16: return storeValue(*store, elementIndex, static_cast<int16_t>(jsToInteger(value, 16, true)));
        case Scalar::U16: return storeValue(*store, elementIndex, static_cast<uint16_t>(jsToInteger(value, 16, false)));
        case Scalar::I32: return storeValue(*store, elementIndex, static_cast<int32_t>(jsToInteger(value, 32, true)));
        case Scalar::U32: return storeValue(*store, elementIndex, static_cast<uint32_t>(jsToInteger(value, 32, false)));
    }
}

// three's MathUtils.denormalize / normalize for each typed array a normalized attribute may use.
double BufferAttribute::denormalize(double value) const {
    if (!normalized) return value;
    switch (store->scalar()) {
        case Scalar::U32: return value / 4294967295.0;
        case Scalar::U16: return value / 65535.0;
        case Scalar::U8: return value / 255.0;
        case Scalar::I32: return std::max(value / 2147483647.0, -1.0);
        case Scalar::I16: return std::max(value / 32767.0, -1.0);
        case Scalar::I8: return std::max(value / 127.0, -1.0);
        default: return value;  // Float32Array; Float64Array is refused when an attribute is made
    }
}

double BufferAttribute::normalize(double value) const {
    if (!normalized) return value;
    switch (store->scalar()) {
        case Scalar::U32: return jsRound(value * 4294967295.0);
        case Scalar::U16: return jsRound(value * 65535.0);
        case Scalar::U8: return jsRound(value * 255.0);
        case Scalar::I32: return jsRound(value * 2147483647.0);
        case Scalar::I16: return jsRound(value * 32767.0);
        case Scalar::I8: return jsRound(value * 127.0);
        default: return value;
    }
}

// index * itemSize + component without wrapping: a caller-supplied index can be anything, and a
// product that wrapped would land back inside the array.
bool BufferAttribute::element(uint64_t index, int component, uint64_t& out) const {
    if (component < 0 || itemSize <= 0) return false;
    const uint64_t max = std::numeric_limits<uint64_t>::max();
    if (index > max / static_cast<uint64_t>(itemSize)) return false;
    const uint64_t scaled = index * static_cast<uint64_t>(itemSize);
    if (static_cast<uint64_t>(component) > max - scaled) return false;
    out = scaled + static_cast<uint64_t>(component);
    return out < store->count();
}

double BufferAttribute::getComponent(uint64_t index, int component) const {
    uint64_t at = 0;
    return element(index, component, at) ? denormalize(raw(at)) : std::numeric_limits<double>::quiet_NaN();
}

BufferAttribute& BufferAttribute::setComponent(uint64_t index, int component, double value) {
    uint64_t at = 0;
    if (element(index, component, at)) setRaw(at, normalize(value));
    return *this;
}

double BufferAttribute::getX(uint64_t index) const { return getComponent(index, 0); }
double BufferAttribute::getY(uint64_t index) const { return getComponent(index, 1); }
double BufferAttribute::getZ(uint64_t index) const { return getComponent(index, 2); }
double BufferAttribute::getW(uint64_t index) const { return getComponent(index, 3); }

BufferAttribute& BufferAttribute::setX(uint64_t index, double x) { return setComponent(index, 0, x); }
BufferAttribute& BufferAttribute::setY(uint64_t index, double y) { return setComponent(index, 1, y); }
BufferAttribute& BufferAttribute::setZ(uint64_t index, double z) { return setComponent(index, 2, z); }
BufferAttribute& BufferAttribute::setW(uint64_t index, double w) { return setComponent(index, 3, w); }

BufferAttribute& BufferAttribute::setXY(uint64_t index, double x, double y) {
    index *= static_cast<uint64_t>(itemSize);
    setRaw(index + 0, normalize(x));
    setRaw(index + 1, normalize(y));
    return *this;
}

BufferAttribute& BufferAttribute::setXYZ(uint64_t index, double x, double y, double z) {
    if (float* at = floatXYZ(index)) {
        const float xyz[3] = {static_cast<float>(x), static_cast<float>(y), static_cast<float>(z)};
        std::memcpy(at, xyz, sizeof(xyz));
        return *this;
    }
    index *= static_cast<uint64_t>(itemSize);
    setRaw(index + 0, normalize(x));
    setRaw(index + 1, normalize(y));
    setRaw(index + 2, normalize(z));
    return *this;
}

BufferAttribute& BufferAttribute::setXYZW(uint64_t index, double x, double y, double z, double w) {
    index *= static_cast<uint64_t>(itemSize);
    setRaw(index + 0, normalize(x));
    setRaw(index + 1, normalize(y));
    setRaw(index + 2, normalize(z));
    setRaw(index + 3, normalize(w));
    return *this;
}

// The three floats of an in-range item of a Float32, unnormalized attribute with itemSize >= 3 (the
// position and normal layout): the element path converts these exactly as a direct float read does.
// The const form reads, so the store's write count holds; the other is a write and moves it.
const float* BufferAttribute::floatXYZ(uint64_t index) const {
    if (store->scalar() != Scalar::F32 || normalized || itemSize < 3) return nullptr;
    const uint64_t stride = static_cast<uint64_t>(itemSize) * sizeof(float);
    if (index >= store->byteLength() / stride) return nullptr;
    return reinterpret_cast<const float*>(std::as_const(*store).data() + index * stride);
}

float* BufferAttribute::floatXYZ(uint64_t index) {
    const float* at = std::as_const(*this).floatXYZ(index);
    if (at != nullptr) (void)store->data();
    return const_cast<float*>(at);
}

Vector3& BufferAttribute::getXYZ(uint64_t index, Vector3& target) const {
    if (const float* at = floatXYZ(index)) {
        float xyz[3];
        std::memcpy(xyz, at, sizeof(xyz));
        target.x = xyz[0];
        target.y = xyz[1];
        target.z = xyz[2];
        return target;
    }
    target.x = getX(index);
    target.y = getY(index);
    target.z = getZ(index);
    return target;
}

BufferAttribute& BufferAttribute::copyAt(uint64_t index1, const BufferAttribute& attribute,
                                         uint64_t index2) {
    index1 *= static_cast<uint64_t>(itemSize);
    index2 *= static_cast<uint64_t>(attribute.itemSize);
    for (int i = 0; i < itemSize; ++i) setRaw(index1 + static_cast<uint64_t>(i), attribute.raw(index2 + i));
    return *this;
}

BufferAttribute& BufferAttribute::applyMatrix3(const Matrix3& m) {
    Vector3 vector;
    if (itemSize == 2) {
        for (uint64_t i = 0; i < count(); ++i) {
            Vector2 v2(getX(i), getY(i));
            v2.applyMatrix3(m);
            setXY(i, v2.x, v2.y);
        }
    } else if (itemSize == 3) {
        for (uint64_t i = 0; i < count(); ++i) {
            getXYZ(i, vector).applyMatrix3(m);
            setXYZ(i, vector.x, vector.y, vector.z);
        }
    }
    return *this;
}

BufferAttribute& BufferAttribute::applyMatrix4(const Matrix4& m) {
    Vector3 vector;
    for (uint64_t i = 0, n = count(); i < n; ++i) {
        getXYZ(i, vector).applyMatrix4(m);
        setXYZ(i, vector.x, vector.y, vector.z);
    }
    return *this;
}

BufferAttribute& BufferAttribute::applyNormalMatrix(const Matrix3& m) {
    Vector3 vector;
    for (uint64_t i = 0, n = count(); i < n; ++i) {
        getXYZ(i, vector).applyNormalMatrix(m);
        setXYZ(i, vector.x, vector.y, vector.z);
    }
    return *this;
}

BufferAttribute& BufferAttribute::transformDirection(const Matrix4& m) {
    Vector3 vector;
    for (uint64_t i = 0, n = count(); i < n; ++i) {
        getXYZ(i, vector).transformDirection(m);
        setXYZ(i, vector.x, vector.y, vector.z);
    }
    return *this;
}

std::vector<double> BufferAttribute::toNumbers() const {
    std::vector<double> values;
    values.reserve(store->count());
    for (uint64_t i = 0; i < store->count(); ++i) values.push_back(raw(i));
    return values;
}

// -------------------------------------------------------------------- BufferGeometry

uint64_t BufferGeometry::nextId() {
    static uint64_t id = 0;
    return id++;
}

void BufferGeometry::setIndex(const std::shared_ptr<BufferAttribute>& attribute) {
    index = attribute;
    bumpRevision();
}

void BufferGeometry::setIndexFromArray(const std::vector<uint32_t>& values) {
    setIndex(BufferAttribute::fromIndices(values));
}

void BufferGeometry::setAttribute(const std::string& name, std::shared_ptr<BufferAttribute> attribute) {
    attributes[name] = std::move(attribute);
    bumpRevision();
}

std::shared_ptr<BufferAttribute> BufferGeometry::getAttribute(const std::string& name) const {
    const auto it = attributes.find(name);
    return it == attributes.end() ? nullptr : it->second;
}

bool BufferGeometry::deleteAttribute(const std::string& name) {
    const bool erased = attributes.erase(name) > 0;
    if (erased) bumpRevision();
    return erased;
}

bool BufferGeometry::hasAttribute(const std::string& name) const {
    return attributes.find(name) != attributes.end();
}

void BufferGeometry::addGroup(double start, double count, double materialIndex) {
    groups.push_back(GeometryGroup{start, count, materialIndex});
    bumpRevision();
}

void BufferGeometry::clearGroups() {
    groups.clear();
    bumpRevision();
}

void BufferGeometry::setDrawRange(double start, double count) {
    drawRange.start = start;
    drawRange.count = count;
    bumpRevision();
}

Box3& Box3::setFromBufferAttribute(const BufferAttribute& attribute) {
    makeEmpty();
    Vector3 point;
    for (uint64_t i = 0, n = attribute.count(); i < n; ++i) expandByPoint(attribute.getXYZ(i, point));
    return *this;
}

void BufferGeometry::computeBoundingBox() {
    if (boundingBox == nullptr) boundingBox = std::make_shared<Box3>();
    boundingBox->makeEmpty();
    const std::shared_ptr<BufferAttribute> position = getAttribute("position");
    if (position == nullptr) return;
    boundingBox->setFromBufferAttribute(*position);
    Vector3 point;
    Box3 morphBox;
    for (const auto& morph : morphPositions) {
        morphBox.setFromBufferAttribute(*morph);
        if (morphTargetsRelative) {
            boundingBox->expandByPoint(point.addVectors(boundingBox->min, morphBox.min));
            boundingBox->expandByPoint(point.addVectors(boundingBox->max, morphBox.max));
        } else {
            boundingBox->expandByPoint(morphBox.min);
            boundingBox->expandByPoint(morphBox.max);
        }
    }
}

void BufferGeometry::computeBoundingSphere() {
    if (boundingSphere == nullptr) boundingSphere = std::make_shared<Sphere>();
    const std::shared_ptr<BufferAttribute> position = getAttribute("position");
    if (position == nullptr) return;
    Vector3& center = boundingSphere->center;
    Box3 box;
    box.makeEmpty();
    Vector3 point;
    const uint64_t vertices = position->count();
    for (uint64_t i = 0; i < vertices; ++i) box.expandByPoint(position->getXYZ(i, point));
    box.getCenter(center);
    double maxRadiusSq = 0;
    for (uint64_t i = 0; i < vertices; ++i) {
        position->getXYZ(i, point);
        // Math.max propagates NaN; std::max would drop it and report a finite radius.
        const double d = center.distanceToSquared(point);
        maxRadiusSq = std::isnan(maxRadiusSq) || std::isnan(d) ? std::numeric_limits<double>::quiet_NaN() : std::max(maxRadiusSq, d);
    }
    boundingSphere->radius = std::sqrt(maxRadiusSq);
}

void BufferGeometry::computeVertexNormals() {
    const std::shared_ptr<BufferAttribute> position = getAttribute("position");
    if (position == nullptr) return;
    std::shared_ptr<BufferAttribute> normal = getAttribute("normal");
    if (normal == nullptr || normal->count() != position->count()) {
        normal = BufferAttribute::fromFloats(std::vector<double>(position->count() * 3, 0.0), 3);
        setAttribute("normal", normal);
    } else {
        for (uint64_t i = 0; i < normal->count(); ++i) normal->setXYZ(i, 0, 0, 0);
    }

    Vector3 pA, pB, pC, nA, nB, nC, cb, ab;
    if (index != nullptr) {
        for (uint64_t i = 0; i < index->count(); i += 3) {
            const uint64_t vA = static_cast<uint64_t>(index->getX(i + 0));
            const uint64_t vB = static_cast<uint64_t>(index->getX(i + 1));
            const uint64_t vC = static_cast<uint64_t>(index->getX(i + 2));
            position->getXYZ(vA, pA);
            position->getXYZ(vB, pB);
            position->getXYZ(vC, pC);
            cb.subVectors(pC, pB);
            ab.subVectors(pA, pB);
            cb.cross(ab);
            normal->getXYZ(vA, nA);
            normal->getXYZ(vB, nB);
            normal->getXYZ(vC, nC);
            nA.add(cb);
            nB.add(cb);
            nC.add(cb);
            normal->setXYZ(vA, nA.x, nA.y, nA.z);
            normal->setXYZ(vB, nB.x, nB.y, nB.z);
            normal->setXYZ(vC, nC.x, nC.y, nC.z);
        }
    } else {
        for (uint64_t i = 0; i < position->count(); i += 3) {
            position->getXYZ(i + 0, pA);
            position->getXYZ(i + 1, pB);
            position->getXYZ(i + 2, pC);
            cb.subVectors(pC, pB);
            ab.subVectors(pA, pB);
            cb.cross(ab);
            normal->setXYZ(i + 0, cb.x, cb.y, cb.z);
            normal->setXYZ(i + 1, cb.x, cb.y, cb.z);
            normal->setXYZ(i + 2, cb.x, cb.y, cb.z);
        }
    }
    normalizeNormals();
    normal->setNeedsUpdate();
}

void BufferGeometry::normalizeNormals() {
    std::shared_ptr<BufferAttribute> normals = getAttribute("normal");
    if (normals == nullptr) return;
    Vector3 vector;
    for (uint64_t i = 0, n = normals->count(); i < n; ++i) {
        normals->getXYZ(i, vector).normalize();
        normals->setXYZ(i, vector.x, vector.y, vector.z);
    }
}

std::shared_ptr<BufferAttribute> BufferAttribute::clone() const {
    auto copy = std::make_shared<BufferAttribute>(store->scalar(), store->count(), itemSize, normalized);
    copy->store->write(0, std::as_const(*store).data(), store->byteLength());
    copy->name = name;
    copy->usage = usage;
    copy->gpuType = gpuType;
    copy->perInstance = perInstance;
    return copy;
}

namespace {

std::shared_ptr<BufferAttribute> cloneAttribute(const BufferAttribute& source) { return source.clone(); }

}  // namespace

std::shared_ptr<BufferGeometry> BufferGeometry::clone() const {
    auto geometry = std::make_shared<BufferGeometry>();
    geometry->type = type;
    geometry->parameters = parameters;
    geometry->copy(*this);
    return geometry;
}

BufferGeometry& BufferGeometry::copy(const BufferGeometry& source) {
    index = source.index ? source.index->clone() : nullptr;
    attributes.clear();
    for (const auto& [name, attribute] : source.attributes) setAttribute(name, attribute->clone());
    morphPositions.clear();
    morphNormals.clear();
    for (const auto& target : source.morphPositions) morphPositions.push_back(target->clone());
    for (const auto& target : source.morphNormals) morphNormals.push_back(target->clone());
    morphTargetsRelative = source.morphTargetsRelative;
    instanced = source.instanced;
    instanceCount = source.instanceCount;
    groups = source.groups;
    boundingBox = source.boundingBox ? std::make_shared<Box3>(*source.boundingBox) : nullptr;
    boundingSphere = source.boundingSphere ? std::make_shared<Sphere>(*source.boundingSphere) : nullptr;
    drawRange = source.drawRange;
    name = source.name;
    bumpRevision();
    return *this;
}

void BufferGeometry::dispose() {
    if (index) index->store->releaseGpuCopy();
    for (const auto& [name, attribute] : attributes) attribute->store->releaseGpuCopy();
    for (const auto& target : morphPositions) target->store->releaseGpuCopy();
    for (const auto& target : morphNormals) target->store->releaseGpuCopy();
}

std::shared_ptr<BufferGeometry> BufferGeometry::toNonIndexed() const {
    if (index == nullptr) return nullptr;
    auto geometry = std::make_shared<BufferGeometry>();
    const std::vector<double> indices = index->toNumbers();
    for (const auto& [name, attribute] : attributes) {
        // Raw element copies, as three's convertBufferAttribute does (array2[i] = array[j]): reading
        // through getComponent would denormalize and fromDoubles would not re-normalize.
        const uint64_t size = static_cast<uint64_t>(attribute->itemSize);
        auto copy = std::make_shared<BufferAttribute>(attribute->store->scalar(), indices.size() * size,
                                                      attribute->itemSize, attribute->normalized);
        // An in-range item is its bytes; only an index past the end goes element by element.
        const uint64_t elementBytes = scalarSize(attribute->store->scalar());
        const uint64_t itemBytes = size * elementBytes;
        const uint64_t items = attribute->count();
        std::byte* to = copy->store->data();
        const std::byte* from = std::as_const(*attribute->store).data();
        uint64_t out = 0;
        for (const double vertex : indices) {
            const auto item = static_cast<uint64_t>(vertex);
            if (item < items) {
                std::memcpy(to + out * elementBytes, from + item * itemBytes, itemBytes);
                out += size;
            } else {
                for (uint64_t j = 0; j < size; ++j) copy->setRaw(out++, attribute->raw(item * size + j));
            }
        }
        geometry->setAttribute(name, copy);
    }
    for (const GeometryGroup& group : groups) {
        geometry->addGroup(group.start, group.count, group.materialIndex);
    }
    return geometry;
}

std::string BufferGeometry::mergeFrom(const std::vector<const BufferGeometry*>& parts, bool indexed,
                                      const std::vector<std::string>& names) {
    std::vector<std::vector<const BufferAttribute*>> lists;
    for (const std::string& name : names) {
        auto& list = lists.emplace_back();
        for (const BufferGeometry* part : parts) {
            const auto it = part->attributes.find(name);
            if (it == part->attributes.end()) return "?";
            const BufferAttribute& attribute = *it->second;
            if (attribute.store->count() != attribute.count() * static_cast<uint64_t>(attribute.itemSize)) return "?";
            list.push_back(&attribute);
        }
    }
    if (indexed) {
        std::vector<double> values;
        double offset = 0;
        for (const BufferGeometry* part : parts) {
            const auto position = part->attributes.find("position");
            if (part->index == nullptr || position == part->attributes.end()) return "?";
            const BufferAttribute& source = *part->index;
            for (uint64_t j = 0, count = source.count(); j < count; ++j) values.push_back(source.getX(j) + offset);
            offset += static_cast<double>(position->second->count());
        }
        const bool wide = std::any_of(values.begin(), values.end(), [](double v) { return v >= 65535; });
        setIndex(BufferAttribute::fromDoubles(wide ? Scalar::U32 : Scalar::U16, values, 1));
    }
    for (size_t n = 0; n < names.size(); ++n) {
        const BufferAttribute& first = *lists[n].front();
        uint64_t total = 0;
        for (const BufferAttribute* attribute : lists[n]) {
            const char* field = attribute->store->scalar() != first.store->scalar() ? "array"
                                : attribute->itemSize != first.itemSize             ? "itemSize"
                                : attribute->normalized != first.normalized         ? "normalized"
                                : attribute->gpuType != first.gpuType               ? "gpuType"
                                                                                    : nullptr;
            if (field != nullptr) return std::string(field) + '\n' + names[n];
            total += attribute->store->count();
        }
        auto merged = std::make_shared<BufferAttribute>(first.store->scalar(), total, first.itemSize, first.normalized);
        merged->gpuType = first.gpuType;
        std::byte* to = merged->store->data();
        for (const BufferAttribute* attribute : lists[n]) {
            const uint64_t bytes = attribute->store->byteLength();
            if (bytes != 0) std::memcpy(to, std::as_const(*attribute->store).data(), bytes);
            to += bytes;
        }
        setAttribute(names[n], std::move(merged));
    }
    return "";
}

BufferGeometry& BufferGeometry::applyMatrix4(const Matrix4& matrix) {
    const std::shared_ptr<BufferAttribute> position = getAttribute("position");
    if (position != nullptr) {
        position->applyMatrix4(matrix);
        position->setNeedsUpdate();
    }
    const std::shared_ptr<BufferAttribute> normal = getAttribute("normal");
    if (normal != nullptr) {
        Matrix3 normalMatrix;
        normalMatrix.getNormalMatrix(matrix);
        normal->applyNormalMatrix(normalMatrix);
        normal->setNeedsUpdate();
    }
    const std::shared_ptr<BufferAttribute> tangent = getAttribute("tangent");
    if (tangent != nullptr) {
        tangent->transformDirection(matrix);
        tangent->setNeedsUpdate();
    }
    if (boundingBox != nullptr) computeBoundingBox();
    if (boundingSphere != nullptr) computeBoundingSphere();
    transformed = true;
    bumpRevision();
    return *this;
}

BufferGeometry& BufferGeometry::translate(double x, double y, double z) {
    Matrix4 matrix;
    matrix.makeTranslation(x, y, z);
    return applyMatrix4(matrix);
}

BufferGeometry& BufferGeometry::rotateX(double angle) {
    Matrix4 matrix;
    matrix.makeRotationX(angle);
    return applyMatrix4(matrix);
}

BufferGeometry& BufferGeometry::rotateY(double angle) {
    Matrix4 matrix;
    matrix.makeRotationY(angle);
    return applyMatrix4(matrix);
}

BufferGeometry& BufferGeometry::rotateZ(double angle) {
    Matrix4 matrix;
    matrix.makeRotationZ(angle);
    return applyMatrix4(matrix);
}

BufferGeometry& BufferGeometry::scale(double x, double y, double z) {
    Matrix4 matrix;
    matrix.makeScale(x, y, z);
    return applyMatrix4(matrix);
}

BufferGeometry& BufferGeometry::center() {
    computeBoundingBox();
    Vector3 offset;
    boundingBox->getCenter(offset);
    offset.negate();
    return translate(offset.x, offset.y, offset.z);
}

std::string BufferGeometry::parametersJson() const {
    if (parameters.empty()) return {};
    std::string json = "{";
    bool first = true;
    for (const auto& [name, value] : parameters) {
        if (!first) json += ",";
        first = false;
        json += "\"" + name + "\":" + value;
    }
    json += "}";
    return json;
}

std::string BufferGeometry::groupsJson() const {
    std::string json = "[";
    for (size_t i = 0; i < groups.size(); ++i) {
        if (i) json += ",";
        json += "{\"count\":" + jsonNumber(groups[i].count) +
                ",\"materialIndex\":" + jsonNumber(groups[i].materialIndex) +
                ",\"start\":" + jsonNumber(groups[i].start) + "}";
    }
    json += "]";
    return json;
}

}  // namespace tn::engine
