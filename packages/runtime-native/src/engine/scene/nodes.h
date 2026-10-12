#pragma once

// Scene, Group and Mesh, ported from three@0.185.1 src/scenes/Scene.js, src/objects/Group.js and
// src/objects/Mesh.js.
//
// Not ported: toJSON and clone. Background Color and Texture have separate typed slots; bindings
// expose them as three's single background property.

#include <memory>
#include <vector>
#include <string_view>

#include "engine/foundation/math/Color.h"
#include "engine/foundation/math/Matrix.h"
#include "engine/scene/geometry.h"
#include "engine/scene/object3d.h"

namespace tn::engine {

class BufferGeometry;
class Material;
class Texture;

/** three's Fog / FogExp2 parameters. The shader reads -positionView.z, never radial distance. */
class Fog {
public:
    explicit Fog(Color color = Color(1, 1, 1), double near = 1, double far = 1000)
        : color(color), near(near), far(far) {}
    virtual ~Fog() = default;
    virtual bool exponential() const { return false; }
    Color color;
    std::string name;
    double near = 1, far = 1000, density = 0.00025;
};
class FogExp2 : public Fog {
public:
    explicit FogExp2(Color color = Color(1, 1, 1), double density = 0.00025) : Fog(color) { this->density = density; }
    bool exponential() const override { return true; }
};

/** three's Scene: an Object3D root plus what the renderer reads about the whole frame. */
class Scene : public Object3D {
  public:
    [[nodiscard]] std::string_view type() const override { return "Scene"; }

    std::shared_ptr<Color> background; // color alternative; bindings clear the other slot
    std::shared_ptr<Texture> environment;
    std::shared_ptr<Texture> backgroundTexture;
    std::shared_ptr<Fog> fog;
    void* overrideMaterial = nullptr;

    double backgroundBlurriness = 0;
    double backgroundIntensity = 1;
    Euler backgroundRotation;
    double environmentIntensity = 1;
    Euler environmentRotation;

    /** three's copy fields; resources remain shared until their clone paths are ported. */
    Scene& copy(const Scene& source);
};

/** three's Group: an Object3D with no members, so a name reads better than `new Object3D()`. */
class Group : public Object3D {
  public:
    [[nodiscard]] std::string_view type() const override { return "Group"; }
};

/** three's Mesh: an Object3D that also carries a geometry and a material. */
class Mesh : public Object3D {
  public:
    Mesh() = default;
    Mesh(std::shared_ptr<BufferGeometry> geometry, std::shared_ptr<Material> material)
        : geometry(std::move(geometry)), material(std::move(material)) {
        updateMorphTargets();
    }

    /** three's updateMorphTargets: one zero influence per morph target the geometry carries. */
    void updateMorphTargets() {
        morphTargetInfluences.clear();
        if (!geometry) return;
        const std::size_t count = !geometry->morphPositions.empty() ? geometry->morphPositions.size()
                                                                     : geometry->morphNormals.size();
        morphTargetInfluences.assign(count, 0.0);
    }
    std::vector<double> morphTargetInfluences;
    virtual Vector3& getVertexPosition(uint64_t index, Vector3& target) const;
    bool raycast(const Raycaster& raycaster, std::vector<Intersection>& intersects) override;

    [[nodiscard]] std::string_view type() const override { return "Mesh"; }

    // Shared, as a three Mesh references its geometry and material: the mesh keeps them alive while
    // it draws them. A material array (groups) arrives with PRD-514's multi-material work.
    std::shared_ptr<BufferGeometry> geometry;
    std::shared_ptr<Material> material;

  protected:
    friend class Box3;
    virtual const Box3& cachedBounds();
};

/** three's Line: its geometry's vertices drawn as one connected line strip, unlit. */
class Line : public Mesh {
public:
    using Mesh::Mesh;
    [[nodiscard]] std::string_view type() const override { return "Line"; }
    /** three's LineSegments draws each vertex pair as its own segment (a line list). */
    [[nodiscard]] virtual bool segments() const { return false; }
    /** three's Line.raycast: each segment within the raycaster's line threshold of the ray. */
    bool raycast(const Raycaster& caster, std::vector<Intersection>& hits) override;
};

/** three's LineSegments: vertex pairs drawn as separate segments. */
class LineSegments final : public Line {
public:
    using Line::Line;
    [[nodiscard]] std::string_view type() const override { return "LineSegments"; }
    [[nodiscard]] bool segments() const override { return true; }
};

/** three's Sprite: a view-aligned quad; count supports GPUParticles3D's instanced sprites. */
class Sprite : public Mesh {
public:
    explicit Sprite(std::shared_ptr<Material> material = {});
    [[nodiscard]] std::string_view type() const override { return "Sprite"; }
    Vector2 center{0.5, 0.5};
    uint32_t count = 1;
};

/**
 * three's InstancedMesh: one geometry and material drawn `count` times, each through its own matrix
 * and, once `setColorAt` has made the attribute, its own colour. Like three, the instance arrays are
 * float32, every matrix starts as the identity, and a write through `setMatrixAt`/`setColorAt` reaches
 * the GPU when the attribute's `setNeedsUpdate()` (three's `needsUpdate = true`) is called.
 */
class InstancedMesh : public Mesh {
  public:
    InstancedMesh(std::shared_ptr<BufferGeometry> geometry, std::shared_ptr<Material> material, uint32_t count);

    [[nodiscard]] std::string_view type() const override { return "InstancedMesh"; }

    InstancedMesh& setMatrixAt(uint32_t index, const Matrix4& matrix);
    Matrix4& getMatrixAt(uint32_t index, Matrix4& target) const;
    InstancedMesh& setColorAt(uint32_t index, const Color& color);
    Color& getColorAt(uint32_t index, Color& target) const;

    /** three's `Mesh.boundingSphere`, which InstancedMesh computes over its instances, not the geometry. */
    std::shared_ptr<Sphere> boundingSphere;
    std::shared_ptr<Box3> boundingBox;
    void computeBoundingBox();
    /** three's `InstancedMesh.computeBoundingSphere`: the union of every drawn instance's own sphere. */
    void computeBoundingSphere();
    bool raycast(const Raycaster& raycaster, std::vector<Intersection>& intersects) override;

    std::shared_ptr<BufferAttribute> instanceMatrix; // 16 floats per instance
    std::shared_ptr<BufferAttribute> instanceColor;  // 3 floats per instance; null until setColorAt
    uint32_t count;                                  // how many instances draw (at most the capacity)

  protected:
    const Box3& cachedBounds() override;
};

/**
 * three's BatchedMesh: geometries added once (copied, as three copies them into its own buffers) and
 * instances of them, each with its own matrix, colour and visibility. The engine draws each geometry's
 * visible instances as one instanced draw (`drawBatches`), so nothing is merged into one vertex buffer.
 * ponytail: three's per-instance frustum culling and sorting save draws; the engine draws every visible
 * instance, which gives the same frame.
 */
class BatchedMesh : public Mesh {
  public:
    BatchedMesh(uint32_t maxInstanceCount, uint32_t maxVertexCount, uint32_t maxIndexCount,
                std::shared_ptr<Material> material);

    [[nodiscard]] std::string_view type() const override { return "BatchedMesh"; }

    /** three's addGeometry: the geometry's id; refuses a geometry past the reserved buffer sizes. */
    uint32_t addGeometry(const BufferGeometry& geometry, int64_t reservedVertexCount = -1,
                         int64_t reservedIndexCount = -1);
    /** three's addInstance: an identity-matrix, white, visible instance of `geometryId`, a freed id first. */
    uint32_t addInstance(uint32_t geometryId);
    void deleteInstance(uint32_t instanceId);
    BatchedMesh& setMatrixAt(uint32_t instanceId, const Matrix4& matrix);
    Matrix4& getMatrixAt(uint32_t instanceId, Matrix4& target) const;
    BatchedMesh& setColorAt(uint32_t instanceId, const Color& color);
    Color& getColorAt(uint32_t instanceId, Color& target) const;
    BatchedMesh& setVisibleAt(uint32_t instanceId, bool visible);
    [[nodiscard]] bool getVisibleAt(uint32_t instanceId) const;
    /** three's instanceCount: the active instances. */
    [[nodiscard]] uint32_t instanceCount() const;

    /** The per-geometry instanced meshes the renderer draws, rebuilt after an instance changed. */
    const std::vector<std::shared_ptr<InstancedMesh>>& drawBatches();

    const uint32_t maxInstanceCount, maxVertexCount, maxIndexCount;
    bool perObjectFrustumCulled = true;
    bool sortObjects = true;

  private:
    struct Instance {
        uint32_t geometry = 0;
        Matrix4 matrix;
        Color color{1, 1, 1};
        bool visible = true;
        bool active = true;
    };
    Instance& instance(uint32_t instanceId);
    [[nodiscard]] const Instance& instance(uint32_t instanceId) const;

    std::vector<std::shared_ptr<BufferGeometry>> geometries_;
    std::vector<Instance> instances_;
    std::vector<uint32_t> freeInstances_;
    uint64_t nextVertex_ = 0, nextIndex_ = 0;
    bool colored_ = false, dirty_ = true;
    std::vector<std::shared_ptr<InstancedMesh>> batches_;
};

} // namespace tn::engine
