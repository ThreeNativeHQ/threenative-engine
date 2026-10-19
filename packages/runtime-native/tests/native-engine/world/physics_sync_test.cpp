// PRD-528 boxes 53/54: the native Rapier world, stepped by the engine's FixedStepClock and bound to
// native Object3D nodes, answers what the TypeScript-driven path answers over the same scenario:
// every checkpoint's body transform within the tolerances native/physics/tests/parity.rs states, and
// the collision-event set and order exactly.
//
// The scenario is packages/physics's shared fixture, read here at run time; the expectations are
// physics_sync_reference.json, written by physics-sync-reference.ts from the real packages/physics
// simulation on WASM Rapier. Neither side enables enhanced determinism, so the transforms are
// compared within tolerance and the discrete rows are compared exactly, as parity.rs does.
#include "check.h"
#include "engine/foundation/json.h"
#include "engine/scene/object3d.h"
#include "engine/world/physics_sync.h"
#include "threenative/physics_native.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <fstream>
#include <iterator>
#include <map>
#include <memory>
#include <string>
#include <utility>
#include <vector>

using namespace tn::engine;
using namespace tn::engine::world;
using tn::engine::json::Value;

namespace {

// native/physics/tests/parity.rs: a per-axis delta above 0.02 fails the resting position, and a
// displacement further than 0.05 from the web arm fails. Rapier 0.30 against 0.19.3 drifts inside
// both; it is not bit-exact and cannot be.
constexpr double kAxisTolerance = 0.02;
constexpr double kDistanceTolerance = 0.05;

// The area whose membership the scenario samples at each checkpoint, as parity.rs reads it.
constexpr uint32_t kAreaId = 5;

std::string readFile(const char* path) {
    std::ifstream in(path, std::ios::binary);
    return std::string(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
}

bool loadJson(const char* path, Value& value) {
    json::Error error;
    if (json::parse(readFile(path), value, error))
        return true;
    std::fprintf(stderr, "FAIL: cannot read %s at byte %zu\n", path, error.offset);
    return false;
}

double num(const Value* value) { return value != nullptr && value->isNumber() ? value->number() : 0.0; }

double scalar(const Value& vector, std::size_t index) {
    return index < vector.items().size() ? num(&vector.items()[index]) : 0.0;
}

std::string text(const Value* value) { return value != nullptr && value->isString() ? value->string() : std::string(); }

uint32_t typeCode(const std::string& name) {
    if (name == "dynamic")
        return 0;
    if (name == "fixed")
        return 1;
    if (name == "kinematic")
        return 2;
    if (name == "character")
        return 3;
    return 0;
}

uint32_t shapeCode(const std::string& name) {
    if (name == "box")
        return 0;
    if (name == "sphere")
        return 1;
    if (name == "capsule")
        return 2;
    return 0;
}

struct Checkpoint {
    uint32_t step = 0;
    std::map<uint32_t, std::array<double, 7>> bodies;
    std::vector<uint32_t> areaMembership;
};

struct Observation {
    bool worldOk = false;
    uint64_t ticks = 0;
    std::size_t bodiesCompared = 0;
    std::size_t checkpoints = 0;
    std::size_t transformFailures = 0;
    std::size_t discreteFailures = 0;
    double maxAxisError = 0.0;
    double maxDistanceError = 0.0;
    std::vector<std::string> events;
};

/** Area membership of `area` as the C ABI reports it: two u32 per record, the area then the body. */
std::vector<uint32_t> areaMembers(const PhysicsSync& sync, uint32_t area) {
    std::vector<uint32_t> records(256);
    const int32_t count = tn_physics_read_area_intersections(sync.simulation(), records.data(), records.size());
    std::vector<uint32_t> members;
    if (count <= 0)
        return members;
    for (int32_t index = 0; index < count; ++index)
        if (records[static_cast<std::size_t>(index) * 2] == area)
            members.push_back(records[static_cast<std::size_t>(index) * 2 + 1]);
    std::sort(members.begin(), members.end());
    return members;
}

/** Grounded and its ground body for `body`, as `tn_physics_read_character_states` reports them. */
std::pair<bool, int64_t> characterState(const PhysicsSync& sync, uint32_t body) {
    std::vector<float> states(6);
    const int32_t count = tn_physics_read_character_states(sync.simulation(), states.data(), states.size());
    for (int32_t index = 0; index < count; ++index) {
        const float* record = states.data() + static_cast<std::size_t>(index) * 6;
        if (static_cast<uint32_t>(record[0]) == body)
            return {record[1] == 1.0f, static_cast<int64_t>(record[2])};
    }
    return {false, -1};
}

Checkpoint checkpointOf(const Value& value) {
    Checkpoint checkpoint;
    checkpoint.step = static_cast<uint32_t>(num(value.find("step")));
    for (const Value& body : value.find("bodies")->items()) {
        const Value& position = *body.find("position");
        const Value& quaternion = *body.find("quaternion");
        checkpoint.bodies[static_cast<uint32_t>(num(body.find("id")))] = {
            scalar(position, 0),   scalar(position, 1),   scalar(position, 2),  scalar(quaternion, 0),
            scalar(quaternion, 1), scalar(quaternion, 2), scalar(quaternion, 3)};
    }
    for (const Value& member : value.find("areaMembership")->items())
        checkpoint.areaMembership.push_back(static_cast<uint32_t>(num(&member)));
    return checkpoint;
}

/** The whole scenario, driven through PhysicsSync, against the reference's rows. */
Observation run(const Value& scenario, const Value& reference) {
    Observation observed;
    const Value& gravity = *scenario.find("gravity");
    const double deltaTime = num(scenario.find("deltaTime"));
    const auto steps = static_cast<uint32_t>(num(scenario.find("steps")));

    // The clock's own step is the scenario's, one update per frame: every frame banks exactly the
    // time one fixed step took, so every frame runs exactly one update. `stepMs` is folded once, so
    // each frame timestamp is an exact multiple of one step and no frame banks a rounding sliver.
    const double stepMs = deltaTime * 1000.0;
    PhysicsSync sync(Vector3(scalar(gravity, 0), scalar(gravity, 1), scalar(gravity, 2)), deltaTime, 1);
    sync.start(0.0);
    observed.worldOk = sync.ok();

    std::map<uint32_t, std::unique_ptr<Object3D>> nodes;
    for (const Value& body : scenario.find("bodies")->items()) {
        const uint32_t id = static_cast<uint32_t>(num(body.find("id")));
        const Value& size = *body.find("shapeSize");
        const Value& position = *body.find("position");
        const TnPhysicsBodyOptions options{id,
                                           typeCode(text(body.find("type"))),
                                           shapeCode(text(body.find("shape"))),
                                           static_cast<float>(scalar(position, 0)),
                                           static_cast<float>(scalar(position, 1)),
                                           static_cast<float>(scalar(position, 2)),
                                           0.0f,
                                           0.0f,
                                           0.0f,
                                           1.0f,
                                           static_cast<float>(scalar(size, 0)),
                                           static_cast<float>(scalar(size, 1)),
                                           static_cast<float>(scalar(size, 2)),
                                           static_cast<float>(num(body.find("mass"))),
                                           static_cast<uint32_t>(num(body.find("collisionLayer"))),
                                           static_cast<uint32_t>(num(body.find("collisionMask"))),
                                           body.find("sensor")->boolean(),
                                           false};
        nodes[id] = std::make_unique<Object3D>();
        if (!sync.addBody(options, *nodes[id]))
            ++observed.discreteFailures;
    }

    const Value& character = *scenario.find("character");
    const Value& autostep = *character.find("autostep");
    const TnPhysicsCharacterOptions characterOptions{static_cast<uint32_t>(num(character.find("bodyId"))),
                                                     static_cast<float>(num(character.find("offset"))),
                                                     static_cast<float>(num(character.find("maxSlopeClimbAngle"))),
                                                     true,
                                                     static_cast<float>(scalar(autostep, 0)),
                                                     static_cast<float>(scalar(autostep, 1)),
                                                     scalar(autostep, 2) == 1.0,
                                                     true,
                                                     static_cast<float>(num(character.find("snapToGround"))),
                                                     static_cast<uint32_t>(num(character.find("oneWayLayers"))),
                                                     false};
    if (!sync.configureCharacter(characterOptions))
        ++observed.discreteFailures;

    const std::vector<Checkpoint> expected = [&] {
        std::vector<Checkpoint> table;
        for (const Value& entry : reference.find("checkpoints")->items())
            table.push_back(checkpointOf(entry));
        return table;
    }();
    std::size_t nextCheckpoint = 0;

    for (uint32_t step = 0; step < steps; ++step) {
        const auto stepNumber = static_cast<uint32_t>(num(scenario.find("removeAtStep")));
        if (step == stepNumber) {
            CHECK(sync.removeBody(static_cast<uint32_t>(num(scenario.find("removeBodyId")))));
            nodes.erase(static_cast<uint32_t>(num(scenario.find("removeBodyId"))));
        }
        if (step == static_cast<uint32_t>(num(scenario.find("teleportAtStep")))) {
            const Value& teleport = *scenario.find("teleportPosition");
            const uint32_t body = static_cast<uint32_t>(num(scenario.find("teleportBodyId")));
            CHECK(sync.setBodyTransform(body, Vector3(scalar(teleport, 0), scalar(teleport, 1), scalar(teleport, 2))));
            CHECK(sync.ok());
        }
        // Every kinematic motion, from the position the bound node already carries.
        for (const Value& motion : scenario.find("motions")->items()) {
            const auto start = static_cast<uint32_t>(num(motion.find("startStep")));
            const auto end = static_cast<uint32_t>(num(motion.find("endStep")));
            if (step < start || step >= end)
                continue;
            const uint32_t body = static_cast<uint32_t>(num(motion.find("bodyId")));
            const auto node = nodes.find(body);
            if (node == nodes.end()) {
                CHECK(false);
                continue;
            }
            const Value& delta = *motion.find("delta");
            CHECK(sync.setKinematicTarget(body, Vector3(node->second->position.x + scalar(delta, 0),
                                                        node->second->position.y + scalar(delta, 1),
                                                        node->second->position.z + scalar(delta, 2))));
        }

        CHECK(sync.advance(static_cast<double>(step + 1) * stepMs) == 1);
        CHECK(sync.ok());
        for (const PhysicsSyncEvent& event : sync.events())
            observed.events.push_back(std::to_string(event.first) + "-" + std::to_string(event.second) + "-" +
                                      (event.started ? "1" : "0"));

        if (nextCheckpoint >= expected.size() || expected[nextCheckpoint].step != step)
            continue;
        const Checkpoint& checkpoint = expected[nextCheckpoint++];
        ++observed.checkpoints;
        for (const auto& [id, want] : checkpoint.bodies) {
            const auto node = nodes.find(id);
            if (node == nodes.end()) {
                ++observed.transformFailures;
                continue;
            }
            const Object3D& object = *node->second;
            const double got[7] = {object.position.x,   object.position.y,   object.position.z,  object.quaternion.x,
                                   object.quaternion.y, object.quaternion.z, object.quaternion.w};
            double distance = 0.0;
            for (std::size_t axis = 0; axis < 7; ++axis) {
                const double error = std::fabs(got[axis] - want[axis]);
                observed.maxAxisError = std::max(observed.maxAxisError, error);
                if (error > kAxisTolerance)
                    ++observed.transformFailures;
                if (axis < 3)
                    distance += error * error;
            }
            distance = std::sqrt(distance);
            observed.maxDistanceError = std::max(observed.maxDistanceError, distance);
            if (distance > kDistanceTolerance)
                ++observed.transformFailures;
            ++observed.bodiesCompared;
        }
        // Area membership is discrete, so it is compared exactly.
        if (areaMembers(sync, kAreaId) != checkpoint.areaMembership)
            ++observed.discreteFailures;
    }

    const auto characterBody = static_cast<uint32_t>(num(character.find("bodyId")));
    const auto [grounded, groundCollider] = characterState(sync, characterBody);
    const Value* expectedCollider = reference.find("groundCollider");
    if (grounded != reference.find("grounded")->boolean() ||
        groundCollider != (expectedCollider != nullptr && expectedCollider->isNumber()
                               ? static_cast<int64_t>(expectedCollider->number())
                               : -1))
        ++observed.discreteFailures;
    observed.ticks = sync.tick();
    return observed;
}

bool loadBoth(Value& scenario, Value& reference) {
    return loadJson(TN_PHYSICS_SYNC_SCENARIO, scenario) && loadJson(TN_PHYSICS_SYNC_REFERENCE, reference);
}

void rapierSync() { // not `sync`: POSIX ::sync() makes that name ambiguous under GCC
    Value scenario;
    Value reference;
    if (!loadBoth(scenario, reference))
        return;
    const Observation observed = run(scenario, reference);
    std::printf("rapier sync: %zu checkpoints, %zu bodies, max axis error %.3e, max distance error %.3e\n",
                observed.checkpoints, observed.bodiesCompared, observed.maxAxisError, observed.maxDistanceError);
    CHECK(observed.worldOk);
    CHECK(observed.checkpoints == reference.find("checkpoints")->items().size());
    CHECK(observed.ticks == static_cast<uint64_t>(num(scenario.find("steps"))));
    CHECK(observed.transformFailures == 0);
    CHECK(observed.discreteFailures == 0);
}

void events() {
    Value scenario;
    Value reference;
    if (!loadBoth(scenario, reference))
        return;
    const Observation observed = run(scenario, reference);
    std::vector<std::string> expected;
    for (const Value& event : reference.find("collisionEventSequence")->items())
        expected.push_back(text(&event));
    std::vector<std::string> sorted = observed.events;
    std::sort(sorted.begin(), sorted.end());
    sorted.erase(std::unique(sorted.begin(), sorted.end()), sorted.end());
    std::vector<std::string> expectedSet = expected;
    std::sort(expectedSet.begin(), expectedSet.end());
    expectedSet.erase(std::unique(expectedSet.begin(), expectedSet.end()), expectedSet.end());
    std::printf("rapier events: %zu drained, %zu distinct, order %s\n", observed.events.size(), sorted.size(),
                observed.events == expected ? "matches" : "differs");
    CHECK(!expected.empty());
    CHECK(sorted == expectedSet);
    CHECK(observed.events == expected);
}

} // namespace

TN_TEST_MAIN({"sync", rapierSync}, {"events", events})
