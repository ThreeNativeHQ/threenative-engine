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

std::size_t PoseHistory::watch(const std::vector<Object3D*>& objects) {
    std::vector<Entry> next;
    next.reserve(objects.size());
    for (Object3D* object : objects) {
        if (object == nullptr) continue;
        Entry entry;
        entry.object = object->weak_from_this();
        // A body that was already watched keeps its three poses, so the frame a game adds one does
        // not reset the bodies beside it.
        const auto found = std::find_if(entries_.begin(), entries_.end(), [object](const Entry& existing) {
            const std::shared_ptr<Object3D> held = existing.object.lock();
            return held.get() == object;
        });
        if (found != entries_.end()) {
            entry = *found;
        } else {
            entry.previous = poseOf(*object);
            entry.current = entry.previous;
            entry.saved = entry.previous;
        }
        next.push_back(std::move(entry));
    }
    entries_ = std::move(next);
    blended_.clear();
    return entries_.size();
}

void PoseHistory::reset(const std::vector<Object3D*>& objects) {
    for (Object3D* object : objects) {
        if (object == nullptr) continue;
        const auto found = std::find_if(entries_.begin(), entries_.end(), [object](const Entry& existing) {
            const std::shared_ptr<Object3D> held = existing.object.lock();
            return held.get() == object;
        });
        if (found == entries_.end()) continue;
        found->previous = poseOf(*object);
        found->current = found->previous;
    }
}

void PoseHistory::tick(double phase) {
    for (Entry& entry : entries_) {
        const std::shared_ptr<Object3D> object = entry.object.lock();
        if (!object) continue;
        const Pose pose = poseOf(*object);
        if (phase >= 1.0)
            entry.current = pose;
        else
            entry.previous = pose;
    }
}

void PoseHistory::writePose(Object3D& object, const Pose& pose) {
    // The same four calls physics_sync.cpp:112-115 makes for a solved body.
    object.prepareLocalTransformWrite();
    object.position.set(pose.position[0], pose.position[1], pose.position[2]);
    // The synced quaternion notifies, so the object's Euler follows it, as three's own does.
    object.quaternion.set(pose.quaternion[0], pose.quaternion[1], pose.quaternion[2], pose.quaternion[3]);
    object.markLocalTransformDirty();
}

void PoseHistory::blend(double alpha) {
    if (!std::isfinite(alpha) || alpha < 0.0 || alpha > 1.0)
        throw std::invalid_argument("PoseHistory::blend needs a finite alpha in [0, 1]");
    blended_.clear();
    for (std::size_t index = 0; index < entries_.size(); ++index) {
        Entry& entry = entries_[index];
        const std::shared_ptr<Object3D> object = entry.object.lock();
        if (!object) continue;
        Pose now = poseOf(*object);
        // Somebody wrote this body since the tick: blending against the pose the engine solved would
        // draw it somewhere the simulation never put it, so it resets instead and the blend below
        // lands it exactly where it already is.
        if (now != entry.current) {
            entry.previous = now;
            entry.current = now;
        }
        entry.saved = now;
        blended_.push_back(index);
        Pose blended;
        for (int i = 0; i < 3; ++i)
            blended.position[i] = mixValue(entry.previous.position[i], entry.current.position[i], alpha);
        Quaternion from{entry.previous.quaternion[0], entry.previous.quaternion[1], entry.previous.quaternion[2],
                        entry.previous.quaternion[3]};
        Quaternion to{entry.current.quaternion[0], entry.current.quaternion[1], entry.current.quaternion[2],
                      entry.current.quaternion[3]};
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
    for (const std::size_t index : blended_) {
        if (index >= entries_.size()) continue;
        Entry& entry = entries_[index];
        const std::shared_ptr<Object3D> object = entry.object.lock();
        if (!object) continue;
        if (poseOf(*object) == entry.saved) continue;
        writePose(*object, entry.saved);
    }
    blended_.clear();
}

} // namespace tn::engine
