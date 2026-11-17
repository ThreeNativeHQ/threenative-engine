#include "engine/renderer/lod/instanced_lod.h"

#include <algorithm>
#include <cstring>
#include <limits>
#include <string>

#include "engine/renderer/lod/model_lod.h"

namespace tn::engine::lod {
namespace {

double drawnTriangles(const InstancedMesh& child) {
    const BufferGeometry& geometry = *child.geometry;
    const double elements = geometry.index                      ? double(geometry.index->count())
                            : geometry.getAttribute("position") ? double(geometry.getAttribute("position")->count())
                                                                : 0.0;
    return elements / 3 * child.count;
}

/** Whether `bytes` equals the attribute's current contents; refreshes the copy either way. */
bool sameBytes(const std::shared_ptr<BufferAttribute>& attribute, std::vector<std::byte>& bytes) {
    if (!attribute) {
        const bool same = bytes.empty();
        bytes.clear();
        return same;
    }
    const BufferStore& store = *attribute->store;
    const std::byte* data = store.data();
    const std::size_t length = static_cast<std::size_t>(store.byteLength());
    const bool same = bytes.size() == length && std::memcmp(bytes.data(), data, length) == 0;
    if (!same)
        bytes.assign(data, data + length);
    return same;
}

} // namespace

bool selectInstancedLods(InstancedMesh& mesh, InstancedLodState& state, Camera& camera, double viewportHeight,
                         double& triangles) {
    triangles = 0;
    if (state.children.empty())
        return true;
    mesh.updateWorldMatrix(true, false);
    Vector3 cameraPosition;
    camera.getWorldPosition(cameraPosition);
    for (const std::shared_ptr<InstancedMesh>& child : state.children) {
        child->material = mesh.material;
        child->setLayerMask(mesh.layers().mask);
        child->setCastShadow(mesh.castShadow());
        child->setReceiveShadow(mesh.receiveShadow());
        child->matrixWorld.copy(mesh.matrixWorld);
    }
    const bool authored = !state.chainErrors.has_value();
    const uint32_t count = mesh.count;
    if (state.states.size() < count)
        state.states.resize(count, 0);
    state.scratch.resize(count);
    Matrix4 matrix;
    Matrix4 world;
    for (uint32_t index = 0; index < count; ++index) {
        mesh.getMatrixAt(index, matrix);
        world.multiplyMatrices(mesh.matrixWorld, matrix);
        const Sphere sphere = worldSphere(state.local, world);
        double depth = 0;
        bool degenerate = false;
        conservativeViewDepth(camera, sphere.center, sphere.radius, cameraNear(camera), depth, degenerate);
        int level = 0;
        if (authored) {
            const double distance = biasedLodDistance(cameraPosition.distanceTo(sphere.center));
            while (static_cast<std::size_t>(level + 1) < state.distances.size() &&
                   distance >= state.distances[static_cast<std::size_t>(level + 1)])
                level += 1;
        } else {
            // Project local error at world scale without copying the chain's errors per placement.
            const double scale = world.getMaxScaleOnAxis();
            LodView view;
            view.camera = &camera;
            view.viewportHeight = viewportHeight;
            view.depth = biasedLodDistance(depth);
            view.degenerate = degenerate;
            std::string error;
            if (!selectLodLevel(*state.chainErrors, state.states[index],
                                state.budget / std::max(scale, std::numeric_limits<double>::epsilon()),
                                state.hysteresis, {view}, level, error))
                return false; // a refused selection leaves every count as it was
            if (level < 0)
                level = 0;
        }
        state.scratch[index] = level;
    }
    // Settled: the same levels over the same source matrices under the same mesh transform sort into
    // exactly the partitions the last frame left, so nothing is rewritten or uploaded again.
    const bool sameSource = sameBytes(mesh.instanceMatrix, state.sourceBytes);
    const bool sameColor = sameBytes(mesh.instanceColor, state.colorBytes);
    const bool settled = state.sorted && sameSource && sameColor && state.sourceCount == count &&
                         state.meshWorld == mesh.matrixWorld.elements &&
                         std::equal(state.scratch.begin(), state.scratch.end(), state.states.begin());
    if (settled) {
        for (const std::shared_ptr<InstancedMesh>& child : state.children)
            triangles += drawnTriangles(*child);
        return true;
    }
    for (const std::shared_ptr<InstancedMesh>& child : state.children)
        child->count = 0;
    for (uint32_t index = 0; index < count; ++index) {
        const int level = state.scratch[index];
        state.states[index] = level;
        InstancedMesh& child =
            *state.children[state.partitionOf[index] * state.levelCount + static_cast<std::size_t>(level)];
        mesh.getMatrixAt(index, matrix);
        child.setMatrixAt(child.count, matrix);
        if (mesh.instanceColor) {
            // A render partition has no colour of its own, so it starts black rather than white.
            if (!child.instanceColor)
                child.instanceColor =
                    BufferAttribute::fromFloats(std::vector<double>(child.instanceMatrix->count() * 3, 0.0), 3);
            child.instanceColor->setXYZ(child.count, mesh.instanceColor->getX(index), mesh.instanceColor->getY(index),
                                        mesh.instanceColor->getZ(index));
            child.instanceColor->setNeedsUpdate();
        }
        child.count += 1;
    }
    for (const std::shared_ptr<InstancedMesh>& child : state.children) {
        child->instanceMatrix->setNeedsUpdate();
        if (child->count > 0)
            child->computeBoundingSphere();
        triangles += drawnTriangles(*child);
    }
    state.sorted = true;
    state.sourceCount = count;
    state.meshWorld = mesh.matrixWorld.elements;
    return true;
}

} // namespace tn::engine::lod
