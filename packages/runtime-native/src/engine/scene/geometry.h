#pragma once

// BufferAttribute and BufferGeometry, ported from three@0.185.1 src/core/BufferAttribute.js and
// src/core/BufferGeometry.js.
//
// Ownership: the attribute's `array` is a tn::engine::BufferStore held by std::shared_ptr, the same
// storage PRD-504 defined. `needsUpdate`, `version`, `addUpdateRange`, `clearUpdateRanges` and
// `updateRanges` are the store's, so the renderer's GeometryCache uploads from that store by its
// version and never a copy. A fixture or a caller reads the same bytes the renderer would.
//
// Not ported, and why:
//   - Interleaved/Instanced/GL/Float16 buffer attributes: no native backend consumes them yet
//     (PRD-508 phase 3).
//   - `onUpload`/`onUploadCallback`, `toJSON`, `clone` and `dispose`: a callback, a serializer and a
//     GPU lifecycle that belong to the renderer (PRD-514), not the object model.
//   - BufferGeometry's `setFromPoints`, `computeTangents`, `setIndirect`/`getIndirect`, `lookAt`,
//     `applyQuaternion`, `toJSON`: tangents and the indirect draw buffer are later work; the rest is
//     a serializer or a call the caller can write.

#include "engine/foundation/buffers.h"
#include "engine/foundation/math/Matrix.h"
#include "engine/foundation/math/Primitives.h"
#include "engine/foundation/math/Vector.h"

#include <cstdint>
#include <limits>
#include <map>
#include <memory>
#include <span>
#include <string>
#include <vector>

namespace tn::engine {

/** ECMAScript Number::toString(10): how a JS number prints, as JSON.stringify writes it. */
std::string jsNumber(double value);

/** three's BufferAttribute. The data lives in `store`; `itemSize` groups it per vertex. */
class BufferAttribute {
public:
    BufferAttribute(Scalar scalar, uint64_t count, int itemSize, bool normalized = false);

    /** Values rounded to `scalar` on the way in, as a typed-array constructor does in three. */
    static std::shared_ptr<BufferAttribute> fromDoubles(Scalar scalar, const std::vector<double>& values,
                                                        int itemSize, bool normalized = false);
    /** A `Float32BufferAttribute` from values computed in binary64, rounded to float on the way in. */
    static std::shared_ptr<BufferAttribute> fromFloats(const std::vector<double>& values, int itemSize,
                                                       bool normalized = false);
    /** A `Uint16BufferAttribute` or `Uint32BufferAttribute`, chosen by three's arrayNeedsUint32. */
    static std::shared_ptr<BufferAttribute> fromIndices(const std::vector<uint32_t>& values);

    std::shared_ptr<BufferStore> store;
    int itemSize = 1;
    bool normalized = false;
    uint32_t usage = 35044;  // StaticDrawUsage
    uint32_t gpuType = 1015;  // FloatType
    std::string name;
    uint64_t id = 0;
    /** three's InstancedBufferAttribute: read once per instance (meshPerAttribute 1), not per vertex. */
    bool perInstance = false;

    [[nodiscard]] uint64_t count() const { return store->count() / static_cast<uint64_t>(itemSize); }
    [[nodiscard]] uint32_t version() const { return store->version(); }
    void setNeedsUpdate() { store->needsUpdate(); }
    void addUpdateRange(uint64_t start, uint64_t count) { store->addUpdateRange(start, count); }
    void clearUpdateRanges() { store->clearUpdateRanges(); }
    [[nodiscard]] std::span<const UpdateRange> updateRanges() const { return store->updateRanges(); }

    /** The element `index * itemSize + component`, false when it is outside the array (or wraps). */
    [[nodiscard]] bool element(uint64_t index, int component, uint64_t& out) const;
    [[nodiscard]] double getComponent(uint64_t index, int component) const;
    BufferAttribute& setComponent(uint64_t index, int component, double value);
    [[nodiscard]] double getX(uint64_t index) const;
    [[nodiscard]] double getY(uint64_t index) const;
    [[nodiscard]] double getZ(uint64_t index) const;
    [[nodiscard]] double getW(uint64_t index) const;
    BufferAttribute& setX(uint64_t index, double x);
    BufferAttribute& setY(uint64_t index, double y);
    BufferAttribute& setZ(uint64_t index, double z);
    BufferAttribute& setW(uint64_t index, double w);
    BufferAttribute& setXY(uint64_t index, double x, double y);
    BufferAttribute& setXYZ(uint64_t index, double x, double y, double z);
    BufferAttribute& setXYZW(uint64_t index, double x, double y, double z, double w);
    Vector3& getXYZ(uint64_t index, Vector3& target) const;

    BufferAttribute& copyAt(uint64_t index1, const BufferAttribute& attribute, uint64_t index2);
    BufferAttribute& applyMatrix3(const Matrix3& m);
    BufferAttribute& applyMatrix4(const Matrix4& m);
    BufferAttribute& applyNormalMatrix(const Matrix3& m);
    BufferAttribute& transformDirection(const Matrix4& m);

    /** three's clone(): a new array of the same type holding the same elements, and the settings
     *  (name, usage, gpuType). */
    [[nodiscard]] std::shared_ptr<BufferAttribute> clone() const;

    /** The typed array as plain doubles, exactly what `Array.from(attribute.array)` answers. */
    [[nodiscard]] std::vector<double> toNumbers() const;

    /** `attribute.array[i]`: the stored element (NaN past the end, as JS reads undefined). */
    [[nodiscard]] double raw(uint64_t elementIndex) const;
    /** `attribute.array[i] = value`, converted as the typed array converts; ignored past the end. */
    void setRaw(uint64_t elementIndex, double value);

private:
    [[nodiscard]] const float* floatXYZ(uint64_t index) const;
    [[nodiscard]] float* floatXYZ(uint64_t index);
    [[nodiscard]] double denormalize(double value) const;
    [[nodiscard]] double normalize(double value) const;
};

/** three's BufferGeometry group: one draw call's slice of the index buffer. */
/** Numbers as JS holds them: `addGroup(0, Infinity)` is valid three and keeps its Infinity. */
struct GeometryGroup {
    double start = 0;
    double count = 0;
    double materialIndex = 0;
};

/** three's drawRange: `count` defaults to Infinity, as the reference leaves it. */
struct DrawRange {
    double start = 0;
    double count = std::numeric_limits<double>::infinity();
};

/** three's BufferGeometry: attributes, index, groups, bounds and the mutation methods on them. */
class BufferGeometry {
public:
    static uint64_t nextId();

    std::map<std::string, std::shared_ptr<BufferAttribute>> attributes;
    std::shared_ptr<BufferAttribute> index;
    // three's morphAttributes.position / .normal (one attribute per target) and morphTargetsRelative.
    std::vector<std::shared_ptr<BufferAttribute>> morphPositions;
    std::vector<std::shared_ptr<BufferAttribute>> morphNormals;
    bool morphTargetsRelative = false;
    /** three's InstancedBufferGeometry: drawn instanceCount times (Infinity: as many as its
     *  per-instance attributes hold). */
    bool instanced = false;
    double instanceCount = std::numeric_limits<double>::infinity();
    std::vector<GeometryGroup> groups;
    DrawRange drawRange;
    std::shared_ptr<Box3> boundingBox;
    std::shared_ptr<Sphere> boundingSphere;
    std::map<std::string, std::string> parameters;  // already-JSON values, keyed by parameter name
    std::string name;
    std::string type = "BufferGeometry";
    uint64_t id = 0;
    bool transformed = false;

    BufferGeometry() : id(nextId()) {}

    [[nodiscard]] uint64_t revision() const { return revision_; }
    void bumpRevision() { ++revision_; }

    [[nodiscard]] std::shared_ptr<BufferAttribute> getIndex() const { return index; }
    void setIndex(const std::shared_ptr<BufferAttribute>& attribute);
    void setIndexFromArray(const std::vector<uint32_t>& values);

    void setAttribute(const std::string& name, std::shared_ptr<BufferAttribute> attribute);
    [[nodiscard]] std::shared_ptr<BufferAttribute> getAttribute(const std::string& name) const;
    bool deleteAttribute(const std::string& name);
    [[nodiscard]] bool hasAttribute(const std::string& name) const;

    void addGroup(double start, double count, double materialIndex = 0);
    void clearGroups();
    void setDrawRange(double start, double count);

    void computeBoundingBox();
    void computeBoundingSphere();
    void computeVertexNormals();
    void normalizeNormals();
    [[nodiscard]] std::shared_ptr<BufferGeometry> toNonIndexed() const;
    /** three's `clone()`: `copy` into a new geometry of the same type and parameters. */
    [[nodiscard]] std::shared_ptr<BufferGeometry> clone() const;
    /** three's `copy(source)`: every attribute, index and morph target copied, groups, bounds and draw range. */
    BufferGeometry& copy(const BufferGeometry& source);
    /** three's `dispose()`: the renderer lets the GPU copies go; the CPU data stays usable. */
    void dispose();

    BufferGeometry& applyMatrix4(const Matrix4& matrix);
    BufferGeometry& translate(double x, double y, double z);
    BufferGeometry& rotateX(double angle);
    BufferGeometry& rotateY(double angle);
    BufferGeometry& rotateZ(double angle);
    BufferGeometry& scale(double x, double y, double z);
    BufferGeometry& center();

    /** three's `parameters` object as canonical JSON, or empty when this geometry has none. */
    [[nodiscard]] std::string parametersJson() const;
    /** three's `groups` array as canonical JSON. */
    [[nodiscard]] std::string groupsJson() const;

private:
    uint64_t revision_ = 0;
};

}  // namespace tn::engine
