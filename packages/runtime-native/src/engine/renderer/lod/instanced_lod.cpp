#include "engine/renderer/lod/instanced_lod.h"

#include <algorithm>
#include <cmath>
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

int authoredLevelForDistance(const std::vector<double>& distances, double scaledDistance) {
    int level = 0;
    while (static_cast<std::size_t>(level + 1) < distances.size() &&
           scaledDistance >= distances[static_cast<std::size_t>(level + 1)]) {
        level += 1;
    }
    return level;
}

void minMaxDistanceToBounds(const Vector3& p, const InstancedLodState::PartitionBounds& b, double& minDist,
                            double& maxDist) {
    const double dxMin = p.x < b.minX ? (b.minX - p.x) : (p.x > b.maxX ? (p.x - b.maxX) : 0.0);
    const double dyMin = p.y < b.minY ? (b.minY - p.y) : (p.y > b.maxY ? (p.y - b.maxY) : 0.0);
    const double dzMin = p.z < b.minZ ? (b.minZ - p.z) : (p.z > b.maxZ ? (p.z - b.maxZ) : 0.0);
    minDist = std::sqrt(dxMin * dxMin + dyMin * dyMin + dzMin * dzMin);

    const double dxMax = std::max(std::abs(p.x - b.minX), std::abs(p.x - b.maxX));
    const double dyMax = std::max(std::abs(p.y - b.minY), std::abs(p.y - b.maxY));
    const double dzMax = std::max(std::abs(p.z - b.minZ), std::abs(p.z - b.maxZ));
    maxDist = std::sqrt(dxMax * dxMax + dyMax * dyMax + dzMax * dzMax);
}

bool markSourceDiffs(const std::shared_ptr<BufferAttribute>& attr, uint32_t count, const std::vector<uint32_t>& partitionOf,
                     std::vector<std::byte>& saved, std::size_t& savedLen, uint64_t& savedStoreId,
                     std::vector<uint8_t>& partitionDirty, std::vector<uint8_t>* partitionSourceDirty, bool& rebuilt) {
    if (!attr) {
        if (!saved.empty() || savedLen != 0 || savedStoreId != 0) {
            saved.clear();
            savedLen = 0;
            savedStoreId = 0;
            return true;
        }
        return false;
    }
    const BufferStore& store = *attr->store;
    const std::byte* data = store.data();
    const std::size_t length = static_cast<std::size_t>(store.byteLength());
    const std::size_t stride =
        static_cast<std::size_t>(attr->itemSize) * static_cast<std::size_t>(scalarSize(store.scalar()));
    const std::size_t activeBytes = std::min(length, static_cast<std::size_t>(count) * stride);
    if (rebuilt || store.id() != savedStoreId || length != savedLen || saved.size() < activeBytes) {
        saved.assign(data, data + length);
        savedLen = length;
        savedStoreId = store.id();
        return true;
    }
    if (activeBytes == 0 || std::memcmp(saved.data(), data, activeBytes) == 0)
        return false;
    for (uint32_t i = 0; i < count; ++i) {
        const std::size_t off = static_cast<std::size_t>(i) * stride;
        if (off + stride > activeBytes)
            break;
        if (std::memcmp(saved.data() + off, data + off, stride) != 0) {
            const uint32_t p = partitionOf[i];
            partitionDirty[p] = 1;
            if (partitionSourceDirty != nullptr)
                (*partitionSourceDirty)[p] = 1;
            std::memcpy(saved.data() + off, data + off, stride);
        }
    }
    return false;
}

} // namespace

bool selectInstancedLods(InstancedMesh& mesh, InstancedLodState& state, Camera& camera, double viewportHeight,
                         double bias, double& triangles) {
    triangles = 0;
    if (state.children.empty() || state.levelCount == 0)
        return true;

    mesh.updateWorldMatrix(true, false);
    Vector3 cameraPosition;
    camera.getWorldPosition(cameraPosition);

    const std::size_t partitionCount = state.children.size() / state.levelCount;
    const bool authored = !state.chainErrors.has_value();
    const uint32_t count =
        mesh.instanceMatrix ? std::min<uint32_t>(mesh.count, static_cast<uint32_t>(mesh.instanceMatrix->count())) : 0;

    const bool worldChanged = !state.sorted || state.meshWorld != mesh.matrixWorld.elements;
    const void* matPtr = mesh.material.get();
    const double layerMask = mesh.layers().mask;
    const bool castShadow = mesh.castShadow();
    const bool receiveShadow = mesh.receiveShadow();
    const bool metaChanged = !state.childMetaInitialized || state.cachedMaterialPtr != matPtr ||
                             state.cachedLayerMask != layerMask || state.cachedCastShadow != castShadow ||
                             state.cachedReceiveShadow != receiveShadow;

    if (worldChanged || metaChanged) {
        for (const std::shared_ptr<InstancedMesh>& child : state.children) {
            if (metaChanged) {
                if (child->material != mesh.material)
                    child->material = mesh.material;
                if (child->layers().mask != layerMask)
                    child->setLayerMask(layerMask);
                if (child->castShadow() != castShadow)
                    child->setCastShadow(castShadow);
                if (child->receiveShadow() != receiveShadow)
                    child->setReceiveShadow(receiveShadow);
            }
            if (worldChanged)
                child->matrixWorld.copy(mesh.matrixWorld);
        }
        state.cachedMaterialPtr = matPtr;
        state.cachedLayerMask = layerMask;
        state.cachedCastShadow = castShadow;
        state.cachedReceiveShadow = receiveShadow;
        state.childMetaInitialized = true;
    }

    if (state.states.size() < count)
        state.states.resize(count, 0);
    state.scratch.resize(count);

    bool topologyChanged =
        !state.sorted || state.sourceCount != count || state.partitionIndices.size() != partitionCount ||
        state.childTriangles.size() != state.children.size() || state.cachedSpheres.size() < count;
    if (topologyChanged) {
        state.partitionIndices.assign(partitionCount, {});
        for (uint32_t i = 0; i < count; ++i) {
            const uint32_t p = state.partitionOf[i];
            if (p < partitionCount)
                state.partitionIndices[p].push_back(i);
        }
        state.cachedSpheres.resize(count);
        state.partitionBounds.resize(partitionCount);
        state.partitionUniformLevel.assign(partitionCount, -1);
        state.childTriangles.assign(state.children.size(), 0.0);
    }

    state.partitionDirty.assign(partitionCount, 0);
    state.partitionSourceDirty.assign(partitionCount, 0);

    bool allDirty = topologyChanged || worldChanged;
    if (markSourceDiffs(mesh.instanceMatrix, count, state.partitionOf, state.sourceBytes, state.cachedMatrixLen,
                        state.cachedMatrixStoreId, state.partitionDirty, &state.partitionSourceDirty, allDirty)) {
        allDirty = true;
    }
    if (markSourceDiffs(mesh.instanceColor, count, state.partitionOf, state.colorBytes, state.cachedColorLen,
                        state.cachedColorStoreId, state.partitionDirty, nullptr, allDirty)) {
        allDirty = true;
    }
    if (allDirty) {
        std::fill(state.partitionDirty.begin(), state.partitionDirty.end(), uint8_t{1});
        std::fill(state.partitionSourceDirty.begin(), state.partitionSourceDirty.end(), uint8_t{1});
    }

    Matrix4 matrix;
    Matrix4 world;
    for (std::size_t p = 0; p < partitionCount; ++p) {
        if (!state.partitionSourceDirty[p])
            continue;
        state.partitionUniformLevel[p] = -1;
        auto& pb = state.partitionBounds[p];
        pb.minX = pb.minY = pb.minZ = std::numeric_limits<double>::infinity();
        pb.maxX = pb.maxY = pb.maxZ = -std::numeric_limits<double>::infinity();
        for (uint32_t index : state.partitionIndices[p]) {
            mesh.getMatrixAt(index, matrix);
            world.multiplyMatrices(mesh.matrixWorld, matrix);
            const Sphere sphere = worldSphere(state.local, world);
            auto& cs = state.cachedSpheres[index];
            cs.cx = sphere.center.x;
            cs.cy = sphere.center.y;
            cs.cz = sphere.center.z;
            cs.radius = sphere.radius;
            cs.maxScale = authored ? 1.0 : world.getMaxScaleOnAxis();
            pb.minX = std::min(pb.minX, cs.cx);
            pb.minY = std::min(pb.minY, cs.cy);
            pb.minZ = std::min(pb.minZ, cs.cz);
            pb.maxX = std::max(pb.maxX, cs.cx);
            pb.maxY = std::max(pb.maxY, cs.cy);
            pb.maxZ = std::max(pb.maxZ, cs.cz);
        }
    }

    const double nearPlane = authored ? 0.0 : cameraNear(camera);
    for (std::size_t p = 0; p < partitionCount; ++p) {
        const auto& indices = state.partitionIndices[p];
        if (indices.empty())
            continue;

        if (authored) {
            double dMin = 0.0;
            double dMax = 0.0;
            minMaxDistanceToBounds(cameraPosition, state.partitionBounds[p], dMin, dMax);
            const double eps = 1e-9 * (1.0 + dMax);
            const int levelMin = authoredLevelForDistance(state.distances, std::max(0.0, dMin - eps) * bias);
            const int levelMax = authoredLevelForDistance(state.distances, (dMax + eps) * bias);
            if (levelMin == levelMax) {
                if (!state.partitionDirty[p] && state.partitionUniformLevel[p] == levelMin)
                    continue;
                bool changed = state.partitionDirty[p] != 0;
                for (uint32_t index : indices) {
                    state.scratch[index] = levelMin;
                    if (!changed && state.states[index] != levelMin)
                        changed = true;
                }
                if (changed)
                    state.partitionDirty[p] = 1;
                else
                    state.partitionUniformLevel[p] = levelMin;
                continue;
            }
            bool changed = state.partitionDirty[p] != 0;
            for (uint32_t index : indices) {
                const auto& cs = state.cachedSpheres[index];
                const double dx = cameraPosition.x - cs.cx;
                const double dy = cameraPosition.y - cs.cy;
                const double dz = cameraPosition.z - cs.cz;
                const double distance = std::sqrt(dx * dx + dy * dy + dz * dz) * bias;
                const int level = authoredLevelForDistance(state.distances, distance);
                state.scratch[index] = level;
                if (!changed && state.states[index] != level)
                    changed = true;
            }
            if (changed)
                state.partitionDirty[p] = 1;
        } else {
            bool changed = state.partitionDirty[p] != 0;
            for (uint32_t index : indices) {
                const auto& cs = state.cachedSpheres[index];
                double depth = 0;
                bool degenerate = false;
                conservativeViewDepth(camera, Vector3(cs.cx, cs.cy, cs.cz), cs.radius, nearPlane, depth, degenerate);
                LodView view;
                view.camera = &camera;
                view.viewportHeight = viewportHeight;
                view.depth = depth * bias;
                view.degenerate = degenerate;
                int level = 0;
                std::string error;
                if (!selectLodLevel(*state.chainErrors, state.states[index],
                                    state.budget / std::max(cs.maxScale, std::numeric_limits<double>::epsilon()),
                                    state.hysteresis, {view}, level, error)) {
                    state.sorted = false;
                    return false;
                }
                if (level < 0)
                    level = 0;
                state.scratch[index] = level;
                if (!changed && state.states[index] != level)
                    changed = true;
            }
            if (changed)
                state.partitionDirty[p] = 1;
        }
    }

    const bool hasColor = static_cast<bool>(mesh.instanceColor);
    const bool fastF32Matrix =
        mesh.instanceMatrix && mesh.instanceMatrix->store->scalar() == Scalar::F32 && mesh.instanceMatrix->itemSize == 16;
    const std::byte* srcMatData = fastF32Matrix ? mesh.instanceMatrix->store->data() : nullptr;
    const bool fastF32Color =
        hasColor && mesh.instanceColor->store->scalar() == Scalar::F32 && mesh.instanceColor->itemSize == 3;
    const std::byte* srcColData = fastF32Color ? mesh.instanceColor->store->data() : nullptr;

    for (std::size_t p = 0; p < partitionCount; ++p) {
        const std::size_t base = p * state.levelCount;
        if (!state.partitionDirty[p]) {
            for (std::size_t l = 0; l < state.levelCount; ++l)
                triangles += state.childTriangles[base + l];
            continue;
        }

        for (std::size_t l = 0; l < state.levelCount; ++l)
            state.children[base + l]->count = 0;

        int firstLevel = -1;
        bool uniform = true;
        for (uint32_t index : state.partitionIndices[p]) {
            const int level = state.scratch[index];
            state.states[index] = level;
            if (firstLevel < 0)
                firstLevel = level;
            else if (firstLevel != level)
                uniform = false;

            InstancedMesh& child = *state.children[base + static_cast<std::size_t>(level)];
            const uint32_t dstIndex = child.count;
            if (fastF32Matrix && child.instanceMatrix->store->scalar() == Scalar::F32 &&
                child.instanceMatrix->itemSize == 16) {
                std::byte* dstMatData = child.instanceMatrix->store->data();
                std::memcpy(dstMatData + static_cast<std::size_t>(dstIndex) * 64,
                            srcMatData + static_cast<std::size_t>(index) * 64, 64);
            } else {
                mesh.getMatrixAt(index, matrix);
                child.setMatrixAt(dstIndex, matrix);
            }

            if (hasColor) {
                if (!child.instanceColor)
                    child.instanceColor =
                        BufferAttribute::fromFloats(std::vector<double>(child.instanceMatrix->count() * 3, 0.0), 3);
                if (fastF32Color && child.instanceColor->store->scalar() == Scalar::F32 &&
                    child.instanceColor->itemSize == 3) {
                    std::byte* dstColData = child.instanceColor->store->data();
                    std::memcpy(dstColData + static_cast<std::size_t>(dstIndex) * 12,
                                srcColData + static_cast<std::size_t>(index) * 12, 12);
                } else {
                    child.instanceColor->setXYZ(dstIndex, mesh.instanceColor->getX(index),
                                                mesh.instanceColor->getY(index), mesh.instanceColor->getZ(index));
                }
            }
            child.count = dstIndex + 1;
        }
        state.partitionUniformLevel[p] = uniform ? firstLevel : -1;

        for (std::size_t l = 0; l < state.levelCount; ++l) {
            InstancedMesh& child = *state.children[base + l];
            child.instanceMatrix->setNeedsUpdate();
            if (hasColor && child.instanceColor)
                child.instanceColor->setNeedsUpdate();
            if (child.count > 0)
                child.computeBoundingSphere();
            const double tri = drawnTriangles(child);
            state.childTriangles[base + l] = tri;
            triangles += tri;
        }
    }

    state.sorted = true;
    state.sourceCount = count;
    state.meshWorld = mesh.matrixWorld.elements;
    return true;
}

} // namespace tn::engine::lod
