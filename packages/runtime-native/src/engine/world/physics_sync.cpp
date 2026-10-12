#include "engine/world/physics_sync.h"

#include <algorithm>
#include <cmath>
#include <cstddef>

#include "threenative/physics_native.h"

namespace tn::engine::world {
namespace {

// The C ABI's record widths: id, translation x/y/z and quaternion x/y/z/w per visible transform;
// smaller body id, larger body id, started and kind per collision event.
constexpr std::size_t kTransformWidth = 8;
constexpr std::size_t kEventWidth = 4;

} // namespace

PhysicsSync::PhysicsSync(const Vector3& gravity, double fixedStepSeconds, uint32_t maxSteps)
    : clock_(fixedStepSeconds, maxSteps), step_(fixedStepSeconds) {
    if (maxSteps == 0 || !std::isfinite(step_) || step_ <= 0.0 || !std::isfinite(gravity.x) ||
        !std::isfinite(gravity.y) || !std::isfinite(gravity.z))
        return;
    const TnPhysicsWorldOptions options{static_cast<float>(gravity.x), static_cast<float>(gravity.y),
                                        static_cast<float>(gravity.z)};
    simulation_ = tn_physics_create(&options);
}

PhysicsSync::~PhysicsSync() {
    if (simulation_ != nullptr)
        tn_physics_destroy(simulation_);
}

bool PhysicsSync::addBody(const TnPhysicsBodyOptions& options, Object3D& node) {
    if (simulation_ == nullptr || !tn_physics_add_body(simulation_, &options))
        return false;
    bindings_[options.id] = &node;
    // The node starts where the world put the body, so a caller reads a bound node before the first
    // step instead of the origin three's constructor leaves behind.
    writeTransforms();
    return true;
}

bool PhysicsSync::configureCharacter(const TnPhysicsCharacterOptions& options) {
    return simulation_ != nullptr && tn_physics_configure_character(simulation_, &options);
}

bool PhysicsSync::removeBody(uint32_t id) {
    if (simulation_ == nullptr || !tn_physics_remove_body(simulation_, id))
        return false;
    bindings_.erase(id);
    kinematic_.erase(std::remove_if(kinematic_.begin(), kinematic_.end(),
                                    [id](const std::pair<uint32_t, Vector3>& target) { return target.first == id; }),
                     kinematic_.end());
    return true;
}

bool PhysicsSync::setBodyTransform(uint32_t id, const Vector3& position) {
    return simulation_ != nullptr &&
           tn_physics_set_body_transform(simulation_, id, static_cast<float>(position.x),
                                         static_cast<float>(position.y), static_cast<float>(position.z));
}

bool PhysicsSync::setKinematicTarget(uint32_t id, const Vector3& position) {
    if (simulation_ == nullptr || bindings_.find(id) == bindings_.end())
        return false;
    const auto target = std::find_if(kinematic_.begin(), kinematic_.end(),
                                     [id](const std::pair<uint32_t, Vector3>& entry) { return entry.first == id; });
    if (target != kinematic_.end())
        target->second = position;
    else
        kinematic_.emplace_back(id, position);
    return true;
}

uint32_t PhysicsSync::advance(double nowMs) {
    const uint32_t updates = clock_.advance(nowMs);
    events_.clear();
    if (simulation_ == nullptr)
        return 0;
    for (uint32_t update = 0; update < updates; ++update) {
        // The caller re-arms the kinematic targets every frame, as the web path re-sends its snapshot.
        input_.clear();
        for (const auto& [id, target] : kinematic_)
            input_.insert(input_.end(),
                          {static_cast<float>(id), static_cast<float>(target.x), static_cast<float>(target.y),
                           static_cast<float>(target.z), 0.0f, 0.0f, 0.0f, 1.0f});
        if (!tn_physics_step(simulation_, static_cast<float>(step_), input_.data(), kinematic_.size())) {
            failed_ = true;
            break;
        }
        writeTransforms();
        drainEvents();
    }
    kinematic_.clear();
    return updates;
}

void PhysicsSync::writeTransforms() {
    transforms_.assign(bindings_.size() * kTransformWidth, 0.0f);
    const int32_t count = tn_physics_read_visible_transforms(simulation_, transforms_.data(), transforms_.size());
    if (count < 0) {
        failed_ = true;
        return;
    }
    for (int32_t index = 0; index < count; ++index) {
        const float* record = transforms_.data() + static_cast<std::size_t>(index) * kTransformWidth;
        const auto binding = bindings_.find(static_cast<uint32_t>(record[0]));
        if (binding == bindings_.end())
            continue;
        // `quaternion` notifies, so the object's Euler follows it, as three's own does.
        binding->second->position.set(record[1], record[2], record[3]);
        binding->second->quaternion.set(record[4], record[5], record[6], record[7]);
    }
}

void PhysicsSync::drainEvents() {
    // Every live pair can start and stop once per step, so a pair per live body is the bound; the ABI
    // refuses a short buffer instead of truncating.
    event_records_.assign(bindings_.size() * bindings_.size() * kEventWidth, 0u);
    const int32_t count = tn_physics_drain_collision_events(simulation_, event_records_.data(), event_records_.size());
    if (count < 0) {
        failed_ = true;
        return;
    }
    for (int32_t index = 0; index < count; ++index) {
        const uint32_t* record = event_records_.data() + static_cast<std::size_t>(index) * kEventWidth;
        events_.push_back(PhysicsSyncEvent{record[0], record[1], record[2] != 0});
    }
}

} // namespace tn::engine::world
