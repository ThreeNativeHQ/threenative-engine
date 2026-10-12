// InstancedBatch, ported from packages/core/src/instanced-batch.ts and instanced-batch-lod.ts
// (PRD-519). Every matrix, threshold, ordering and refusal is the reference's, in its order, because
// tests/native-engine/projection compares three's decisions bit for bit. Where the reference throws,
// the call answers a refused Verdict carrying a TN_BATCH_* code instead.

#include "engine/renderer/projection/instanced_batch.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <limits>
#include <unordered_map>

namespace tn::engine::projection {

namespace {

/** three's `UP`: the axis a unit-height shape is laid out along, and the span rotates from it. */
const Vector3 kUp{0, 1, 0};

/** The mesh that carries a batch, so `updateInstancedLods` finds it by walking a root. */
std::unordered_map<const Object3D*, InstancedBatch*>& registry() {
    static std::unordered_map<const Object3D*, InstancedBatch*> batches;
    return batches;
}

/** The elements a geometry draws, else its positions, else nothing: what `drawTriangles` counts. */
double drawElements(const BufferGeometry& geometry) {
    if (geometry.index) return double(geometry.index->count());
    const auto position = geometry.attributes.find("position");
    return position == geometry.attributes.end() ? 0 : double(position->second->count());
}

/** `pooledCapacity`: at least MESH_POOL_MIN_CAPACITY, and a power of two so a parked mesh fits. */
uint32_t pooledCapacity(uint32_t capacity) {
    uint32_t wanted = kMeshPoolMinCapacity;
    while (wanted < capacity) wanted *= 2;
    return wanted;
}

/** `mesh.name || "unnamed"`, as the two LOD reports print it. */
std::string meshLabel(const InstancedMesh& mesh) { return mesh.name.empty() ? "unnamed" : mesh.name; }

} // namespace

std::unique_ptr<InstancedBatch> InstancedBatch::create(BatchOptions options, Verdict& verdict) {
    if (!options.geometry) {
        verdict = Verdict::refuse(kBatchGeometryCode);
        return nullptr;
    }
    if (!options.material) {
        verdict = Verdict::refuse(kBatchMaterialCode);
        return nullptr;
    }
    verdict = {};
    return std::unique_ptr<InstancedBatch>(new InstancedBatch(std::move(options)));
}

InstancedBatch::InstancedBatch(BatchOptions options) : options_(std::move(options)) {}

InstancedBatch::~InstancedBatch() {
    if (mesh_ != nullptr) registry().erase(mesh_);
}

Verdict InstancedBatch::readTriple(std::span<const double> value, Vector3& out) {
    if (value.empty()) return {}; // the caller's own default, not a refusal
    if (value.size() != 3) return Verdict::refuse(kBatchTripleCode);
    for (double component : value)
        if (!std::isfinite(component)) return Verdict::refuse(kBatchFiniteCode);
    out.set(value[0], value[1], value[2]);
    return {};
}

Verdict InstancedBatch::open() {
    if (!built_) return {};
    return Verdict::refuse(kBatchClosedCode);
}

Verdict InstancedBatch::add(const Matrix4& matrix, uint32_t& index) {
    if (Verdict refused = open(); !refused.ok) return refused;
    // The matrix is copied, so one scratch Matrix4 can drive every call.
    matrices_.push_back(matrix);
    index = static_cast<uint32_t>(matrices_.size() - 1);
    return {};
}

Verdict InstancedBatch::place(const Placement& placement, uint32_t& index) {
    if (Verdict refused = open(); !refused.ok) return refused;
    Vector3 position;
    if (placement.position.empty()) return Verdict::refuse(kBatchTripleCode);
    if (Verdict refused = readTriple(placement.position, position); !refused.ok) return refused;
    Vector3 axes{1, 1, 1};
    if (placement.uniformScale) {
        if (!std::isfinite(placement.scale)) return Verdict::refuse(kBatchFiniteCode);
        axes.setScalar(placement.scale);
    } else if (Verdict refused = readTriple(placement.scaleAxes, axes); !refused.ok) return refused;
    Euler rotation;
    if (!placement.rotation.empty()) {
        Vector3 angles;
        if (Verdict refused = readTriple(placement.rotation, angles); !refused.ok) return refused;
        rotation.set(angles.x, angles.y, angles.z);
    }
    scratch_.position.copy(position);
    scratch_.quaternion.identity();
    scratch_.rotation.copy(rotation);
    scratch_.scale.copy(axes);
    scratch_.updateMatrix();
    matrices_.push_back(scratch_.matrix);
    index = static_cast<uint32_t>(matrices_.size() - 1);
    return {};
}

Verdict InstancedBatch::span(std::span<const double> from, std::span<const double> to, double radius,
                             uint32_t& index) {
    if (Verdict refused = open(); !refused.ok) return refused;
    Vector3 start, end;
    if (from.empty() || to.empty()) return Verdict::refuse(kBatchTripleCode);
    if (Verdict refused = readTriple(from, start); !refused.ok) return refused;
    if (Verdict refused = readTriple(to, end); !refused.ok) return refused;
    if (!std::isfinite(radius) || radius <= 0) return Verdict::refuse(kBatchRadiusCode);
    direction_.subVectors(end, start);
    const double length = direction_.length();
    // Fail closed rather than skip: `place` and `span` answer the index a game animates by, so a
    // silently dropped instance shifts every later index and the caller's own bookkeeping with it.
    if (length < kMinSpan) return Verdict::refuse(kBatchSpanCode);
    direction_.divideScalar(length);
    rotation_.setFromUnitVectors(kUp, direction_);
    midpoint_.set((start.x + end.x) / 2, (start.y + end.y) / 2, (start.z + end.z) / 2);
    scratch_.position.copy(midpoint_);
    scratch_.rotation.set(0, 0, 0);
    scratch_.quaternion.copy(rotation_);
    scratch_.scale.set(radius, length, radius);
    scratch_.updateMatrix();
    matrices_.push_back(scratch_.matrix);
    index = static_cast<uint32_t>(matrices_.size() - 1);
    return {};
}

bool InstancedBatch::equals(const InstancedBatch* other) const {
    if (other == nullptr || matrices_.size() != other->matrices_.size()) return false;
    for (std::size_t index = 0; index < matrices_.size(); ++index)
        if (std::memcmp(matrices_[index].elements.data(), other->matrices_[index].elements.data(),
                        sizeof(double) * 16) != 0)
            return false;
    return true;
}

uint32_t InstancedBatch::writeMatrices(std::vector<float>& target, uint32_t offset) const {
    for (std::size_t index = 0; index < matrices_.size(); ++index) {
        const std::array<double, 16> elements = matrices_[index].toArray();
        for (int field = 0; field < 16; ++field)
            target[(offset + index) * 16 + static_cast<uint32_t>(field)] = float(elements[field]);
    }
    return static_cast<uint32_t>(matrices_.size());
}

Build InstancedBatch::build(const BuildOptions& options) {
    Build build;
    if (built_) {
        build.verdict = Verdict::refuse(kBatchBuiltCode);
        return build;
    }
    built_ = true;
    const uint32_t placed = count();
    build.count = placed;
    // Nothing placed means no mesh: `new InstancedMesh(g, m, 0)` draws nothing and satisfies every
    // type check, so an empty batch would look exactly like a working one.
    if (placed == 0) return build;
    InstancedMesh* into = options.into;
    const bool refilled = into != nullptr && into->geometry == options_.geometry &&
                          into->material == options_.material && into->instanceMatrix->count() >= placed;
    if (!refilled)
        minted_ = std::make_shared<InstancedMesh>(
            options_.geometry, options_.material,
            pooledCapacity(std::max(placed, options.capacity.value_or(placed))));
    InstancedMesh& mesh = refilled ? *into : *minted_;
    mesh_ = &mesh;
    mesh.count = placed;
    mesh.setVisible(true);
    mesh.frustumCulled = true;
    if (options.name.has_value()) mesh.name = *options.name;
    for (uint32_t index = 0; index < placed; ++index) mesh.setMatrixAt(index, matrices_[index]);
    mesh.instanceMatrix->setNeedsUpdate();
    mesh.setCastShadow(options.castShadow.value_or(false));
    mesh.setReceiveShadow(options.receiveShadow.value_or(false));
    // Without this the batch is culled against the bounds of a single un-transformed copy, so a
    // spread-out batch pops out of view long before it leaves the frustum.
    mesh.computeBoundingSphere();
    build.verdict = attachLod(build.warnings);
    if (options.parent != nullptr) options.parent->add(mesh);
    build.mesh = mesh_ == nullptr ? nullptr : mesh_;
    build.minted = minted_;
    build.slots = static_cast<uint32_t>(mesh.instanceMatrix->count());
    return build;
}

// attachInstancedLod: the policy first, then the levels, then the carrier and the partitions.
Verdict InstancedBatch::attachLod(std::vector<std::string>& warnings) {
    if (!options_.autoLod.has_value() || *options_.autoLod) {
        const double budget = options_.maxPixelError;
        const double hysteresis = options_.hysteresis;
        if (!std::isfinite(budget) || budget <= 0 || !std::isfinite(hysteresis) || hysteresis < 0 ||
            hysteresis >= 1)
            return Verdict::refuse(kBatchAutoLodCode);
    }
    InstancedMesh& mesh = *mesh_;
    if (options_.autoLod.has_value() && !*options_.autoLod && !options_.lods.has_value()) return {};
    const bool authored = options_.lods.has_value();
    const LodChain* chain =
        authored ? nullptr : (options_.chain.has_value() ? &*options_.chain : nullptr);
    levels_ = {options_.geometry};
    distances_ = {0};
    if (authored) {
        double previous = 0;
        int failed = 0;
        for (const AuthoredLod& rung : *options_.lods) {
            if (!std::isfinite(rung.distance) || rung.distance <= previous)
                return Verdict::refuse(kBatchLodDistancesCode);
            previous = rung.distance;
            if (!rung.geometry || drawElements(*rung.geometry) < 3) {
                failed += 1;
                continue;
            }
            levels_.push_back(rung.geometry);
            distances_.push_back(rung.distance);
        }
        if (failed > 0)
            warnings.push_back("TN_INSTANCED_LOD_FAILED: '" + meshLabel(mesh) + "' skipped " +
                               std::to_string(failed) + " unavailable authored levels; " +
                               std::to_string(levels_.size()) + " usable levels remain.");
    } else if (chain != nullptr) {
        levels_ = chain->levels;
    }
    if (levels_.size() < 2) {
        const double triangles = drawElements(*options_.geometry) / 3;
        if (!authored && triangles * count() > 1000000)
            warnings.push_back("TN_INSTANCED_LOD_UNAVAILABLE: '" + meshLabel(mesh) + "' draws " +
                               std::to_string(static_cast<uint64_t>(std::floor(triangles * count()))) +
                               " triangles without a baked AutoLOD chain; cook the model or supply lods.");
        return {};
    }
    base_ = levels_[0];
    // Preparation may replace a normal/UV attribute after cloning; index-only rungs share its streams.
    if (!authored)
        for (const std::shared_ptr<BufferGeometry>& level : levels_)
            for (const auto& entry : base_->attributes) level->setAttribute(entry.first, entry.second);
    base_->computeBoundingSphere();
    local_ = base_->boundingSphere ? *base_->boundingSphere : Sphere();
    // A zero-range carrier keeps original matrices/indices queryable without drawing them twice.
    carrier_ = std::make_shared<BufferGeometry>();
    for (const auto& entry : base_->attributes) carrier_->setAttribute(entry.first, entry.second);
    carrier_->boundingBox = base_->boundingBox;
    carrier_->boundingSphere = base_->boundingSphere;
    carrier_->setIndexFromArray({});
    carrier_->setDrawRange(0, 0);
    mesh.geometry = carrier_;
    groups_ = spatialPartitions(static_cast<uint32_t>(std::ceil(std::sqrt(double(mesh.count)))));
    partitionOf_.assign(mesh.instanceMatrix->count(), 0);
    for (std::size_t partition = 0; partition < groups_.size(); ++partition)
        for (uint32_t index : groups_[partition]) partitionOf_[index] = static_cast<uint32_t>(partition);
    states_.assign(mesh.instanceMatrix->count(), 0);
    // Children draw the partitions; they share the game's geometries and never own their disposal.
    const uint32_t spare = static_cast<uint32_t>(mesh.instanceMatrix->count() - mesh.count);
    for (std::size_t partition = 0; partition < groups_.size(); ++partition)
        for (std::size_t level = 0; level < levels_.size(); ++level) {
            const uint32_t slots =
                static_cast<uint32_t>(groups_[partition].size()) + (partition == 0 ? spare : 0);
            auto child = std::make_shared<InstancedMesh>(levels_[level], mesh.material, slots);
            child->name = meshLabel(mesh) + ":cell" + std::to_string(partition) + ":lod" +
                          std::to_string(level);
            child->count = 0;
            child->setCastShadow(mesh.castShadow());
            child->setReceiveShadow(mesh.receiveShadow());
            child->setLayerMask(mesh.layers().mask);
            // Zero-count partitions stay visible: projection keys must not churn as detail changes.
            child->setVisible(true);
            child->frustumCulled = true;
            mesh.add(*child);
            children_.push_back(child);
        }
    registry()[&mesh] = this;
    return {};
}

// spatialPartitions: split a broad instance set along its measured longest axis, leaving every leaf
// with stable public slots.
std::vector<std::vector<uint32_t>> InstancedBatch::spatialPartitions(uint32_t limit) const {
    std::vector<std::vector<uint32_t>> groups;
    std::vector<uint32_t> all(mesh_->count);
    for (uint32_t index = 0; index < mesh_->count; ++index) all[index] = index;
    splitPartitions(all, limit, groups);
    return groups;
}

void InstancedBatch::splitPartitions(std::vector<uint32_t>& indices, uint32_t limit,
                                     std::vector<std::vector<uint32_t>>& groups) const {
    if (indices.size() <= limit) {
        groups.push_back(indices);
        return;
    }
    // The instance matrices as float32, widened: `instanceMatrix.array` is the same bytes.
    Matrix4 read;
    const auto axisValue = [&](uint32_t index, int component) {
        mesh_->getMatrixAt(index, read);
        return read.elements[static_cast<std::size_t>(12 + component)];
    };
    int axis = 12;
    double extent = -1;
    for (int component = 12; component < 15; ++component) {
        double min = std::numeric_limits<double>::infinity();
        double max = -std::numeric_limits<double>::infinity();
        for (uint32_t index : indices) {
            const double value = axisValue(index, component - 12);
            min = std::min(min, value);
            max = std::max(max, value);
        }
        if (max - min > extent) {
            extent = max - min;
            axis = component;
        }
    }
    // V8's Array.prototype.sort is stable, so a tie keeps placement order; std::stable_sort agrees.
    std::stable_sort(indices.begin(), indices.end(), [&](uint32_t a, uint32_t b) {
        return axisValue(a, axis - 12) < axisValue(b, axis - 12);
    });
    const auto middle = static_cast<std::ptrdiff_t>(indices.size() / 2);
    std::vector<uint32_t> lower(indices.begin(), indices.begin() + middle);
    std::vector<uint32_t> upper(indices.begin() + middle, indices.end());
    splitPartitions(lower, limit, groups);
    splitPartitions(upper, limit, groups);
}

LodUpdate InstancedBatch::selectLods(Camera& camera, double viewportHeight) {
    LodUpdate update;
    if (children_.empty()) return update;
    InstancedMesh& mesh = *mesh_;
    mesh.updateWorldMatrix(true, false);
    Vector3 cameraPosition;
    camera.getWorldPosition(cameraPosition);
    for (const std::shared_ptr<InstancedMesh>& child : children_) {
        child->count = 0;
        child->material = mesh.material;
        child->setLayerMask(mesh.layers().mask);
        child->setCastShadow(mesh.castShadow());
        child->setReceiveShadow(mesh.receiveShadow());
        child->matrixWorld.copy(mesh.matrixWorld);
    }
    const bool authored = options_.lods.has_value();
    const LodChain* chain =
        authored ? nullptr : (options_.chain.has_value() ? &*options_.chain : nullptr);
    const double budget = options_.maxPixelError;
    Matrix4 matrix;
    Matrix4 world;
    for (uint32_t index = 0; index < mesh.count; ++index) {
        mesh.getMatrixAt(index, matrix);
        world.multiplyMatrices(mesh.matrixWorld, matrix);
        const Sphere sphere = lod::worldSphere(local_, world);
        double depth = 0;
        bool degenerate = false;
        lod::conservativeViewDepth(camera, sphere.center, sphere.radius, lod::cameraNear(camera), depth,
                                   degenerate);
        uint32_t level = 0;
        if (authored) {
            const double distance = lod::biasedLodDistance(cameraPosition.distanceTo(sphere.center));
            while (level + 1 < distances_.size() && distance >= distances_[level + 1]) level += 1;
        } else if (chain != nullptr) {
            // Project local error at world scale without copying the chain's errors per placement.
            const double scale = world.getMaxScaleOnAxis();
            lod::LodView view;
            view.camera = &camera;
            view.viewportHeight = viewportHeight;
            view.depth = lod::biasedLodDistance(depth);
            view.degenerate = degenerate;
            int chosen = 0;
            std::string error;
            if (!lod::selectLodLevel(chain->errors, states_[index],
                                     budget / std::max(scale, std::numeric_limits<double>::epsilon()),
                                     options_.hysteresis, {view}, chosen, error))
                return update; // a refused selection leaves every count as it was
            level = static_cast<uint32_t>(chosen < 0 ? 0 : chosen);
        }
        states_[index] = static_cast<int>(level);
        InstancedMesh& child = *children_[partitionOf_[index] * levels_.size() + level];
        child.setMatrixAt(child.count, matrix);
        if (mesh.instanceColor) {
            // A render partition has no colour of its own, so it starts black rather than white.
            if (!child.instanceColor)
                child.instanceColor =
                    BufferAttribute::fromFloats(std::vector<double>(child.instanceMatrix->count() * 3, 0.0), 3);
            child.instanceColor->setXYZ(child.count, mesh.instanceColor->getX(index),
                                        mesh.instanceColor->getY(index),
                                        mesh.instanceColor->getZ(index));
            child.instanceColor->setNeedsUpdate();
        }
        child.count += 1;
    }
    for (const std::shared_ptr<InstancedMesh>& child : children_) {
        child->instanceMatrix->setNeedsUpdate();
        if (child->count > 0) child->computeBoundingSphere();
        update.triangles += drawElements(*child->geometry) / 3 * child->count;
    }
    return update;
}

LodUpdate InstancedBatch::updateLod(Camera& camera, double viewportHeight) {
    LodUpdate update = selectLods(camera, viewportHeight);
    if (mesh_ == nullptr) return update;
    update.partitions.reserve(children_.size());
    for (std::size_t partition = 0; partition < children_.size(); ++partition) {
        const InstancedMesh& child = *children_[partition];
        Partition entry;
        entry.cell = static_cast<uint32_t>(partition / levels_.size());
        entry.level = static_cast<uint32_t>(partition % levels_.size());
        entry.count = child.count;
        entry.indexCount = static_cast<uint32_t>(drawElements(*child.geometry));
        entry.visible = child.visible();
        entry.castShadow = child.castShadow();
        entry.receiveShadow = child.receiveShadow();
        if (child.boundingSphere) entry.boundingSphere = *child.boundingSphere;
        update.partitions.push_back(entry);
    }
    return update;
}

double updateInstancedLods(Object3D& root, Camera& camera, double viewportHeight) {
    camera.updateMatrixWorld();
    std::vector<Object3D*> nodes;
    root.traverse(
        [](Object3D& object, void* context) {
            static_cast<std::vector<Object3D*>*>(context)->push_back(&object);
        },
        &nodes);
    std::vector<InstancedBatch*> batches;
    for (Object3D* node : nodes) {
        const auto found = registry().find(node);
        if (found != registry().end()) batches.push_back(found->second);
    }
    double triangles = 0;
    for (InstancedBatch* batch : batches)
        triangles += batch->updateLod(camera, viewportHeight).triangles;
    return triangles;
}

} // namespace tn::engine::projection
