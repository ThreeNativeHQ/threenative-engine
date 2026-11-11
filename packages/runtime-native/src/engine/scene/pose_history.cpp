#include "engine/scene/pose_history.h"

#include <algorithm>
#include <cmath>
#include <stdexcept>

#include "engine/foundation/math/Quaternion.h"

namespace tn::engine {

namespace {

double mixValue(double a, double b, double t) { return a + (b - a) * t; }

} // namespace

bool PoseHistory::Pose::operator==(const Pose& other) const {
    // Bit equality, not tolerance: `restore` promises the solved pose back exactly, and a slerp that
    // lands one ulp away from it is the bug this operator exists to catch.
    for (int i = 0; i < 3; ++i)
        if (position[i] != other.position[i]) return false;
    for (int i = 0; i < 4; ++i)
        if (quaternion[i] != other.quaternion[i]) return false;
    return true;
}

PoseHistory::Pose PoseHistory::poseOf(const Object3D& object) {
    Pose pose;
    pose.position[0] = object.position.x;
    pose.position[1] = object.position.y;
    pose.position[2] = object.position.z;
    pose.quaternion[0] = object.quaternion.x;
    pose.quaternion[1] = object.quaternion.y;
    pose.quaternion[2] = object.quaternion.z;
    pose.quaternion[3] = object.quaternion.w;
    return pose;
}

void PoseHistory::watch(const std::vector<Object3D*>& objects) {
    std::vector<Entry> next;
    next.reserve(objects.size());
    for (Object3D* object : objects) {
        if (object == nullptr) continue;
        Entry entry;
        entry.object = object->weak_from_this();
        // A watched object that was already watched keeps its pair, so the frame a game adds a body
        // does not reset the bodies beside it.
        const auto found = std::find_if(entries_.begin(), entries_.end(), [object](const Entry& existing) {
            const std::shared_ptr<Object3D> held = existing.object.lock();
            return held.get() == object;
        });
        if (found != entries_.end())
            entry = *found;
        else
            entry.latest = poseOf(*object);
        next.push_back(std::move(entry));
    }
    entries_ = std::move(next);
}

void PoseHistory::reset() {
    for (Entry& entry : entries_) {
        entry.hasPrevious = false;
        entry.enabled = true;
        if (const std::shared_ptr<Object3D> object = entry.object.lock()) entry.latest = poseOf(*object);
    }
}

void PoseHistory::tick(double phase) {
    if (!std::isfinite(phase) || phase >= 1.0) return;
    for (Entry& entry : entries_) {
        const std::shared_ptr<Object3D> object = entry.object.lock();
        if (!object) continue;
        const Pose solved = poseOf(*object);
        entry.previous = entry.latest;
        entry.hasPrevious = true;
        entry.latest = solved;
        entry.enabled = true;
    }
}

void PoseHistory::writePose(Object3D& object, const Pose& pose) {
    object.prepareLocalTransformWrite();
    object.position.set(pose.position[0], pose.position[1], pose.position[2]);
    // The synced quaternion notifies, so the object's Euler follows it, as three's own does.
    object.quaternion.set(pose.quaternion[0], pose.quaternion[1], pose.quaternion[2], pose.quaternion[3]);
    object.markLocalTransformDirty();
}

void PoseHistory::blend(double alpha) {
    if (!std::isfinite(alpha) || alpha < 0.0 || alpha > 1.0)
        throw std::invalid_argument("PoseHistory::blend needs a finite alpha in [0, 1]");
    for (Entry& entry : entries_) {
        const std::shared_ptr<Object3D> object = entry.object.lock();
        if (!object) continue;
        if (!entry.hasPrevious || !entry.enabled) continue;
        // Somebody wrote this body since `tick`: blending against the pose the engine solved would
        // draw it somewhere the simulation never put it, so forget the pair and let the next tick
        // rebuild it from wherever the body is now.
        if (poseOf(*object) != entry.latest) {
            // Rebuild the pair from where the body actually is, so the next tick blends from that
            // and not from a pose the body has already left.
            entry.latest = poseOf(*object);
            entry.hasPrevious = false;
            entry.enabled = false;
            continue;
        }
        Pose blended;
        for (int i = 0; i < 3; ++i)
            blended.position[i] = mixValue(entry.previous.position[i], entry.latest.position[i], alpha);
        Quaternion from{entry.previous.quaternion[0], entry.previous.quaternion[1], entry.previous.quaternion[2],
                        entry.previous.quaternion[3]};
        Quaternion to{entry.latest.quaternion[0], entry.latest.quaternion[1], entry.latest.quaternion[2],
                      entry.latest.quaternion[3]};
        Quaternion out;
        out.slerpQuaternions(from, to, alpha);
        blended.quaternion[0] = out.x;
        blended.quaternion[1] = out.y;
        blended.quaternion[2] = out.z;
        blended.quaternion[3] = out.w;
        writePose(*object, blended);
    }
}

void PoseHistory::restore() {
    for (Entry& entry : entries_) {
        const std::shared_ptr<Object3D> object = entry.object.lock();
        if (!object) continue;
        writePose(*object, entry.latest);
    }
}

} // namespace tn::engine
