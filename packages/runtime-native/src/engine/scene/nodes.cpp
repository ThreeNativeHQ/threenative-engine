// Scene: three@0.185.1 src/scenes/Scene.js. Group adds nothing to Object3D and Mesh only carries the
// two opaque pointers, so only `copy` has a body.

#include "engine/scene/nodes.h"

#include <algorithm>
#include <array>
#include <stdexcept>
#include <string>
#include <utility>
#include "engine/scene/geometries.h"
#include "engine/scene/material.h"

namespace tn::engine {

Box3& Box3::setFromObject(Object3D& object, bool precise) {
    makeEmpty();
    return expandByObject(object, precise);
}

Box3& Box3::expandByObject(Object3D& object, bool precise) {
    object.updateWorldMatrix(false, false);
    if (auto* mesh = dynamic_cast<Mesh*>(&object); mesh && mesh->geometry) {
        const auto position = mesh->geometry->getAttribute("position");
        if (precise && position && dynamic_cast<InstancedMesh*>(mesh) == nullptr) {
            Vector3 vertex;
            for (uint64_t i = 0; i < position->count(); ++i) {
                mesh->getVertexPosition(i, vertex);
                expandByPoint(vertex.applyMatrix4(object.matrixWorld));
            }
        } else {
            Box3 box;
            box.copy(mesh->cachedBounds()).applyMatrix4(object.matrixWorld);
            unionWith(box);
        }
    }
    const auto count = object.children.size();
    for (size_t i = 0; i < count; ++i) expandByObject(*object.children[i], precise);
    return *this;
}

const Box3& Mesh::cachedBounds() {
    if (!geometry->boundingBox) geometry->computeBoundingBox();
    return *geometry->boundingBox;
}

const Box3& InstancedMesh::cachedBounds() {
    if (!boundingBox) computeBoundingBox();
    return *boundingBox;
}

void InstancedMesh::computeBoundingBox() {
    if (!boundingBox) boundingBox = std::make_shared<Box3>();
    boundingBox->makeEmpty();
    if (!geometry) return;
    if (!geometry->boundingBox) geometry->computeBoundingBox();
    Matrix4 instance;
    Box3 box;
    for (uint32_t i = 0; i < count; ++i) {
        getMatrixAt(i, instance);
        box.copy(*geometry->boundingBox).applyMatrix4(instance);
        boundingBox->unionWith(box);
    }
}

Scene& Scene::copy(const Scene& source) {
    Object3D::copy(source);
    // Resource clone support is not ported: this copy retains shared background/environment/fog
    // resources, as the existing scene copy contract does.
    background = source.background;
    backgroundTexture = source.backgroundTexture;
    environment = source.environment;
    fog = source.fog;
    overrideMaterial = source.overrideMaterial;
    backgroundBlurriness = source.backgroundBlurriness;
    backgroundIntensity = source.backgroundIntensity;
    backgroundRotation.copy(source.backgroundRotation);
    environmentIntensity = source.environmentIntensity;
    environmentRotation.copy(source.environmentRotation);
    matrixAutoUpdate = source.matrixAutoUpdate;
    return *this;
}

Sprite::Sprite(std::shared_ptr<Material> m) : Mesh(makePlaneGeometry(), std::move(m)) {
    if (!material) {
        material = std::make_shared<Material>(MaterialType::Basic);
        material->spriteMaterial = true;
        material->fog = false;
        material->transparent = true;
    }
}

InstancedMesh::InstancedMesh(std::shared_ptr<BufferGeometry> g, std::shared_ptr<Material> m, uint32_t instances)
    : Mesh(std::move(g), std::move(m)),
      instanceMatrix(std::make_shared<BufferAttribute>(Scalar::F32, uint64_t{instances} * 16, 16)), count(instances) {
    const Matrix4 identity;
    for (uint32_t i = 0; i < instances; ++i)
        setMatrixAt(i, identity);
}

InstancedMesh& InstancedMesh::setMatrixAt(uint32_t index, const Matrix4& matrix) {
    const std::array<double, 16> e = matrix.toArray();
    for (int c = 0; c < 16; ++c)
        instanceMatrix->setComponent(index, c, e[c]);
    return *this;
}

Matrix4& InstancedMesh::getMatrixAt(uint32_t index, Matrix4& target) const {
    std::array<double, 16> e{};
    for (int c = 0; c < 16; ++c)
        e[c] = instanceMatrix->getComponent(index, c);
    return target.fromArray(e.data());
}

// three creates the colour attribute on first use, every colour white, sized to the matrices.
InstancedMesh& InstancedMesh::setColorAt(uint32_t index, const Color& color) {
    if (!instanceColor) {
        const uint64_t capacity = instanceMatrix->count();
        instanceColor = BufferAttribute::fromFloats(std::vector<double>(capacity * 3, 1.0), 3);
    }
    instanceColor->setXYZ(index, color.r, color.g, color.b);
    return *this;
}

Color& InstancedMesh::getColorAt(uint32_t index, Color& target) const {
    if (!instanceColor)
        return target.setRGB(1, 1, 1); // three's answer before any setColorAt
    target.r = instanceColor->getX(index);
    target.g = instanceColor->getY(index);
    target.b = instanceColor->getZ(index);
    return target;
}

// three's InstancedMesh.computeBoundingSphere, in its order: the geometry's own sphere first, then
// every drawn instance's copy of it under its own matrix, unioned in.
void InstancedMesh::computeBoundingSphere() {
    if (!boundingSphere) boundingSphere = std::make_shared<Sphere>();
    if (!geometry) return;
    if (!geometry->boundingSphere) geometry->computeBoundingSphere();
    boundingSphere->makeEmpty();
    Matrix4 instance;
    Sphere world;
    for (uint32_t i = 0; i < count; ++i) {
        getMatrixAt(i, instance);
        world.copy(*geometry->boundingSphere).applyMatrix4(instance);
        boundingSphere->unionWith(world);
    }
}

// three's BatchedMesh (r185 objects/BatchedMesh.js): its refusals by its own messages.
BatchedMesh::BatchedMesh(uint32_t instances, uint32_t vertices, uint32_t indices, std::shared_ptr<Material> m)
    : Mesh(nullptr, std::move(m)), maxInstanceCount(instances), maxVertexCount(vertices), maxIndexCount(indices) {}

uint32_t BatchedMesh::addGeometry(const BufferGeometry& geometry, int64_t reservedVertexCount, int64_t reservedIndexCount) {
    const auto position = geometry.attributes.find("position");
    if (position == geometry.attributes.end() || !position->second)
        throw std::runtime_error("THREE.BatchedMesh: Added geometry missing \"position\". All geometries must have consistent attributes.");
    if (!geometries_.empty() && (geometries_.front()->index != nullptr) != (geometry.index != nullptr))
        throw std::runtime_error("THREE.BatchedMesh: All geometries must consistently have \"index\".");
    const uint64_t vertices = reservedVertexCount < 0 ? position->second->count() : uint64_t(reservedVertexCount);
    const uint64_t indices = !geometry.index ? 0 : reservedIndexCount < 0 ? geometry.index->count() : uint64_t(reservedIndexCount);
    if ((geometry.index && nextIndex_ + indices > maxIndexCount) || nextVertex_ + vertices > maxVertexCount)
        throw std::runtime_error("THREE.BatchedMesh: Reserved space request exceeds the maximum buffer size.");
    if (position->second->count() > vertices || (geometry.index && geometry.index->count() > indices))
        throw std::runtime_error("THREE.BatchedMesh: Reserved space not large enough for provided geometry.");
    nextVertex_ += vertices;
    nextIndex_ += indices;
    geometries_.push_back(geometry.clone());
    return uint32_t(geometries_.size() - 1);
}

uint32_t BatchedMesh::addInstance(uint32_t geometryId) {
    if (geometryId >= geometries_.size())
        throw std::runtime_error("THREE.BatchedMesh: Invalid geometryId " + std::to_string(geometryId) +
                                 ". Geometry is either out of range or has been deleted.");
    if (instances_.size() >= maxInstanceCount && freeInstances_.empty())
        throw std::runtime_error("THREE.BatchedMesh: Maximum item count reached.");
    Instance added;
    added.geometry = geometryId;
    dirty_ = true;
    if (!freeInstances_.empty()) {
        const auto lowest = std::min_element(freeInstances_.begin(), freeInstances_.end());
        const uint32_t id = *lowest;
        freeInstances_.erase(lowest);
        instances_[id] = added;
        return id;
    }
    instances_.push_back(added);
    return uint32_t(instances_.size() - 1);
}

BatchedMesh::Instance& BatchedMesh::instance(uint32_t id) {
    return const_cast<Instance&>(std::as_const(*this).instance(id));
}

const BatchedMesh::Instance& BatchedMesh::instance(uint32_t id) const {
    if (id >= instances_.size() || !instances_[id].active)
        throw std::runtime_error("THREE.BatchedMesh: Invalid instanceId " + std::to_string(id) +
                                 ". Instance is either out of range or has been deleted.");
    return instances_[id];
}

void BatchedMesh::deleteInstance(uint32_t id) {
    instance(id).active = false;
    freeInstances_.push_back(id);
    dirty_ = true;
}

BatchedMesh& BatchedMesh::setMatrixAt(uint32_t id, const Matrix4& matrix) {
    instance(id).matrix.copy(matrix);
    dirty_ = true;
    return *this;
}

Matrix4& BatchedMesh::getMatrixAt(uint32_t id, Matrix4& target) const { return target.copy(instance(id).matrix); }

BatchedMesh& BatchedMesh::setColorAt(uint32_t id, const Color& color) {
    instance(id).color = color;
    colored_ = true;  // three makes the colour texture on the first setColorAt
    dirty_ = true;
    return *this;
}

Color& BatchedMesh::getColorAt(uint32_t id, Color& target) const { return target = instance(id).color; }

BatchedMesh& BatchedMesh::setVisibleAt(uint32_t id, bool visible) {
    instance(id).visible = visible;
    dirty_ = true;
    return *this;
}

bool BatchedMesh::getVisibleAt(uint32_t id) const { return instance(id).visible; }

uint32_t BatchedMesh::instanceCount() const {
    return uint32_t(instances_.size() - freeInstances_.size());
}

const std::vector<std::shared_ptr<InstancedMesh>>& BatchedMesh::drawBatches() {
    if (dirty_) {
        // One instanced mesh per geometry, sized to its drawn instances; rebuilt only after a change.
        std::vector<std::vector<const Instance*>> drawn(geometries_.size());
        for (const Instance& each : instances_)
            if (each.active && each.visible) drawn[each.geometry].push_back(&each);
        batches_.clear();
        for (std::size_t g = 0; g < geometries_.size(); ++g) {
            if (drawn[g].empty()) continue;
            auto batch = std::make_shared<InstancedMesh>(geometries_[g], material, uint32_t(drawn[g].size()));
            for (std::size_t i = 0; i < drawn[g].size(); ++i) {
                batch->setMatrixAt(uint32_t(i), drawn[g][i]->matrix);
                if (colored_) batch->setColorAt(uint32_t(i), drawn[g][i]->color);
            }
            batches_.push_back(std::move(batch));
        }
        dirty_ = false;
    }
    for (const auto& batch : batches_) {
        batch->material = material;
        batch->matrixWorld = matrixWorld;
        batch->frustumCulled = false;
        batch->setCastShadow(castShadow());
        batch->setReceiveShadow(receiveShadow());
        batch->setRenderOrder(renderOrder());
        batch->setLayerMask(layers().mask);
    }
    return batches_;
}

} // namespace tn::engine
