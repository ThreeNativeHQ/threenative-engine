#include "engine/scene/projected_cull.h"

#include <algorithm>
#include <cmath>
#include <string_view>

#include "engine/foundation/math/Primitives.h"
#include "engine/scene/camera.h"
#include "engine/scene/geometry.h"
#include "engine/scene/nodes.h"
#include "engine/scene/object3d.h"

namespace tn::engine {
namespace {

constexpr double kMinDistance = 1e-4;  // render-camera-cull.ts MIN_DISTANCE

bool gHold = false;
std::vector<std::weak_ptr<Object3D>> gHeld;  // hides a held restoreAfterDraw() still owes

// projection-plan.ts isRenderable: three's isMesh, isSprite, isPoints and isLine classes.
bool renderable(std::string_view type) {
    return type == "Mesh" || type == "InstancedMesh" || type == "SkinnedMesh" || type == "BatchedMesh" ||
           type == "Sprite" || type == "Line" || type == "LineSegments" || type == "Points";
}

}  // namespace

ProjectedCull::CpuTiming ProjectedCull::cpuTiming;

// boundsOf: an InstancedMesh's own bound, else its geometry's, recomputed when the position
// buffer moved and given up on when it moves on consecutive consults (rewritten every frame).
ProjectedCull::Bound ProjectedCull::boundsOf(Node& node, const Sphere*& sphere,
                                             std::unordered_map<const BufferGeometry*, Version>& versions) {
    sphere = nullptr;
    const Mesh* mesh = node.mesh;
    if (node.instanced) {
        const auto& own = static_cast<const InstancedMesh*>(mesh)->boundingSphere;
        if (own) return sphere = own.get(), Bound::Sphere;
    }
    const BufferGeometry* geometry = mesh->geometry.get();
    if (geometry == nullptr) return Bound::None;
    auto& mutableGeometry = const_cast<BufferGeometry&>(*geometry);
    if (node.geometry != geometry || node.geometryRevision != geometry->revision()) {
        const auto found = geometry->attributes.find("position");
        node.position = found != geometry->attributes.end() ? found->second.get() : nullptr;
        node.geometry = geometry;
        node.geometryRevision = geometry->revision();
    }
    const bool versioned = node.position != nullptr;
    const uint32_t version = versioned ? node.position->version() : 0;
    const auto answer = [&]() -> Bound {
        sphere = geometry->boundingSphere.get();
        return sphere ? Bound::Sphere : Bound::None;
    };
    auto known = versions.find(geometry);
    if (known != versions.end() && known->second.geometry.expired()) {  // a freed geometry's address reused
        versions.erase(known);
        known = versions.end();
    }
    const auto remember = [&] {
        versions[geometry] = {std::static_pointer_cast<const BufferGeometry>(mesh->geometry), version, false, false};
    };
    if (!geometry->boundingSphere) {
        mutableGeometry.computeBoundingSphere();
        if (versioned) remember();
        return answer();
    }
    if (!versioned) return answer();
    if (known == versions.end()) {
        remember();
        return answer();
    }
    Version& v = known->second;
    if (v.version == version) {
        if (v.stale) mutableGeometry.computeBoundingSphere();
        v.changedLastConsult = false;
        v.stale = false;
        return answer();
    }
    v.version = version;
    if (v.changedLastConsult) {
        v.stale = true;
        return Bound::Dynamic;
    }
    mutableGeometry.computeBoundingSphere();
    v.changedLastConsult = true;
    return answer();
}

ProjectedCull::Report ProjectedCull::apply(Object3D& root, const Camera& camera, bool cameraResolved, double scale,
                                           double minimumPixels, bool enabled) {
    const double cpuBegin = cpuTiming.clock ? cpuTiming.clock() : -1;
    restore();
    Report report;
    Frustum frustum;
    const auto& e = camera.matrixWorld.elements;
    const double cameraX = e[12], cameraY = e[13], cameraZ = e[14];
    if (cameraResolved) {
        Matrix4 projectionScreen;
        projectionScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        frustum.setFromProjectionMatrix(projectionScreen);
    }
    const auto visit = [&](Node& node) {
        Object3D& object = *node.object;
        ++report.considered;
        if (cameraResolved && node.cameraAttached) {
            ++report.cameraAttached;
            return;
        }
        if (object.alwaysRender) {
            ++report.marked;
            return;
        }
        if (!object.frustumCulled) {
            ++report.frustumCulled;
            return;
        }
        const Sphere* sphere = nullptr;
        const Bound bound = boundsOf(node, sphere, versions_);
        if (bound == Bound::Dynamic) {
            ++report.dynamicBounds;
            return;
        }
        if (bound == Bound::None || !(std::isfinite(sphere->radius) && sphere->radius > 0)) {
            ++report.withoutBounds;
            return;
        }
        Vector3 center = sphere->center;
        center.applyMatrix4(object.matrixWorld);
        if (object.castShadow() && (!cameraResolved || !frustum.containsPoint(center))) {
            ++report.shadowCasters;
            return;
        }
        if (!enabled || !cameraResolved) return;
        const double dx = center.x - cameraX, dy = center.y - cameraY, dz = center.z - cameraZ;
        const double distance = std::sqrt(dx * dx + dy * dy + dz * dz);
        const double worldRadius = sphere->radius * object.matrixWorld.getMaxScaleOnAxis();
        const double projected = (2 * worldRadius * scale) / std::max(distance - worldRadius, kMinDistance);
        if (projected >= minimumPixels) return;
        object.setVisible(false);
        hidden_.push_back(object.weak_from_this());
        ++report.culled;
    };
    if (nodesRoot_ != &root || nodesCamera_ != &camera || nodesVersion_ != Object3D::hierarchyVersion())
        rebuild(root, camera);
    // three's traverseVisible: a node is checked, then visited, then its children walked, so a node
    // the visit hides still has its children visited. A hidden node skips its whole subtree.
    for (uint32_t i = 0; i < nodes_.size();) {
        Node& node = nodes_[i];
        if (!node.object->visible()) {
            i = node.end;
            continue;
        }
        if (node.mesh != nullptr) visit(node);
        ++i;
    }
    if (cpuTiming.clock) {
        const double cpuEnd = cpuTiming.clock();
        ++cpuTiming.calls;
        if (cpuBegin < 0 || cpuEnd < cpuBegin || !std::isfinite(cpuBegin) || !std::isfinite(cpuEnd)) cpuTiming.available = false;
        else cpuTiming.ms += cpuEnd - cpuBegin;
    }
    return report;
}

void ProjectedCull::rebuild(Object3D& root, const Camera& camera) {
    ++rebuilds_;
    walk(nodes_, root, camera);
    nodesRoot_ = &root;
    nodesCamera_ = &camera;
    nodesVersion_ = Object3D::hierarchyVersion();
}

void ProjectedCull::walk(std::vector<Node>& nodes, Object3D& root, const Camera& camera) {
    nodes.clear();
    const auto add = [&](auto& self, Object3D& object, bool underCamera) -> void {
        const auto index = uint32_t(nodes.size());
        const std::string_view type = object.type();
        const Mesh* mesh = renderable(type) ? static_cast<const Mesh*>(&object) : nullptr;
        nodes.push_back({&object, mesh, 0, underCamera, type == "InstancedMesh"});
        const bool childrenUnderCamera = underCamera || &object == &camera;
        for (Object3D* child : object.children) self(self, *child, childrenUnderCamera);
        nodes[index].end = uint32_t(nodes.size());
    };
    bool rootUnderCamera = false;
    for (const Object3D* node = root.parent; node != nullptr; node = node->parent)
        if (node == &camera) rootUnderCamera = true;
    add(add, root, rootUnderCamera);
}

std::vector<double> ProjectedCull::bandRates(const std::vector<Object3D*>& rigs, const Camera& camera,
                                             bool cameraResolved, double scale) {
    std::vector<double> rates(rigs.size(), 0.0);
    const auto& e = camera.matrixWorld.elements;
    const double cameraX = e[12], cameraY = e[13], cameraZ = e[14];
    double fx = -e[8], fy = -e[9], fz = -e[10];
    double length = std::hypot(fx, fy, fz);
    if (!(length > 0)) length = 1;  // core's `|| 1`
    fx /= length, fy /= length, fz /= length;
    Frustum frustum;
    if (cameraResolved) {
        Matrix4 projectionScreen;
        projectionScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        frustum.setFromProjectionMatrix(projectionScreen);
    }
    // three's Ray.intersectsSphere off the camera's forward centre ray.
    const auto rayMeets = [&](const Vector3& c, double radius) {
        if (radius < 0) return false;
        const double dx = c.x - cameraX, dy = c.y - cameraY, dz = c.z - cameraZ;
        const double along = dx * fx + dy * fy + dz * fz;
        if (along < 0) return dx * dx + dy * dy + dz * dz <= radius * radius;
        const double ox = dx - fx * along, oy = dy - fy * along, oz = dz - fz * along;
        return ox * ox + oy * oy + oz * oz <= radius * radius;
    };
    const uint64_t version = Object3D::hierarchyVersion();
    for (auto it = rigWalks_.begin(); it != rigWalks_.end();)
        it = it->second.rig.expired() ? rigWalks_.erase(it) : std::next(it);
    for (std::size_t r = 0; r < rigs.size(); ++r) {
        Object3D& rig = *rigs[r];
        RigWalk& rigWalk = rigWalks_[&rig];
        if (rigWalk.rig.expired() || rigWalk.version != version || rigWalk.rig.lock().get() != &rig) {
            rigWalk.rig = rig.weak_from_this();
            rigWalk.version = version;
            walk(rigWalk.nodes, rig, camera);
        }
        // The rig's sphere so far this walk: x, y, z, radius (render-camera-cull.ts #rigSphere).
        bool grown = false;
        double ux = 0, uy = 0, uz = 0, ur = 0;
        double rate = 0;
        for (uint32_t i = 0; i < rigWalk.nodes.size();) {
            Node& node = rigWalk.nodes[i];
            if (!node.object->visible()) {
                i = node.end;
                continue;
            }
            ++i;
            if (node.mesh == nullptr) continue;
            const Object3D& object = *node.object;
            double partRate = 1;
            const Sphere* sphere = nullptr;
            if (cameraResolved && !node.cameraAttached && !object.alwaysRender && object.frustumCulled &&
                boundsOf(node, sphere, bandVersions_) == Bound::Sphere && std::isfinite(sphere->radius) &&
                sphere->radius > 0) {
                Vector3 center = sphere->center;
                center.applyMatrix4(object.matrixWorld);
                const double radius = sphere->radius * object.matrixWorld.getMaxScaleOnAxis();
                if (!rayMeets(center, radius)) {
                    if (!(radius > 0)) {
                        partRate = 8;  // a part scaled to nothing leaves the rig to its other parts
                    } else {
                        if (!grown) {
                            grown = true;
                            ux = center.x, uy = center.y, uz = center.z, ur = radius;
                        } else {
                            const double distance = std::hypot(center.x - ux, center.y - uy, center.z - uz);
                            if (distance + radius > ur) {
                                if (distance + ur <= radius) {
                                    ux = center.x, uy = center.y, uz = center.z, ur = radius;
                                } else {
                                    const double next = (distance + ur + radius) / 2;
                                    const double shift = (next - ur) / distance;
                                    ux += (center.x - ux) * shift, uy += (center.y - uy) * shift;
                                    uz += (center.z - uz) * shift, ur = next;
                                }
                            }
                        }
                        if (!frustum.intersectsSphere(Sphere(Vector3(ux, uy, uz), ur))) {
                            partRate = 8;
                        } else {
                            const double distance = std::hypot(ux - cameraX, uy - cameraY, uz - cameraZ);
                            const double pixels = (2 * ur * scale) / std::max(distance - ur, kMinDistance);
                            // PRD-570's provisional pixel bands.
                            partRate = pixels >= 128 ? 1 : pixels >= 32 ? 2 : pixels >= 8 ? 4 : 8;
                        }
                    }
                }
            }
            rate = rate == 0 ? partRate : std::min(rate, partRate);
        }
        rates[r] = rate;
    }
    return rates;
}

void ProjectedCull::restore() {
    for (const auto& weak : hidden_)
        if (const auto object = weak.lock()) object->setVisible(true);
    hidden_.clear();
}

void ProjectedCull::restoreAfterDraw() {
    if (!gHold) return restore();
    gHeld.insert(gHeld.end(), hidden_.begin(), hidden_.end());
    hidden_.clear();
}

void ProjectedCull::holdRestores(bool hold) { gHold = hold; }

void ProjectedCull::releaseHeld() {
    for (const auto& weak : gHeld)
        if (const auto object = weak.lock()) object->setVisible(true);
    gHeld.clear();
}

}  // namespace tn::engine
