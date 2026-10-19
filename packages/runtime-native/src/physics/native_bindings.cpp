#include "mystral/physics/native_bindings.h"

#include "mystral/js/engine.h"
#include "threenative/physics_native.h"

#include <cmath>
#include <cstdint>
#include <limits>
#include <memory>
#include <string>
#include <vector>

namespace mystral::physics {
namespace {

constexpr uint32_t kMaxExactFloatId = 16'777'215;

struct SimulationOwner {
  TnPhysicsSimulation *simulation = nullptr;
  uint32_t nextId = 0;
  uint32_t nextJointId = 0;
  uint32_t nextVehicleId = 0;

  ~SimulationOwner() { dispose(); }

  void dispose() {
    if (simulation != nullptr) {
      tn_physics_destroy(simulation);
      simulation = nullptr;
    }
  }
};

js::JSValueHandle fail(js::Engine *engine, const char *message) {
  engine->throwException(message);
  return engine->newUndefined();
}

js::JSValueHandle failActuation(js::Engine *engine, int32_t status) {
  switch (status) {
  case TN_PHYSICS_ACTUATION_UNKNOWN_BODY:
    return fail(engine,
                "TN_PHYSICS_UNKNOWN_BODY: actuation references an unknown body.");
  case TN_PHYSICS_ACTUATION_NOT_DYNAMIC:
    return fail(engine,
                "TN_PHYSICS_NOT_DYNAMIC: actuation needs a dynamic body.");
  case TN_PHYSICS_ACTUATION_NON_FINITE:
    return fail(engine,
                "TN_PHYSICS_NON_FINITE: actuation vector must be finite.");
  default:
    return fail(engine, "TN_NATIVE_PHYSICS_INVALID: actuation was rejected.");
  }
}

bool readFiniteNumber(js::Engine *engine, js::JSValueHandle object,
                      const char *name, float &output) {
  const auto value = engine->getProperty(object, name);
  if (!engine->isNumber(value))
    return false;
  const double number = engine->toNumber(value);
  if (!std::isfinite(number) || number < -std::numeric_limits<float>::max() ||
      number > std::numeric_limits<float>::max()) {
    return false;
  }
  output = static_cast<float>(number);
  return true;
}

bool readOptionalFiniteNumber(js::Engine *engine, js::JSValueHandle object,
                              const char *name, float &output) {
  const auto value = engine->getProperty(object, name);
  if (engine->isUndefined(value))
    return true;
  return readFiniteNumber(engine, object, name, output);
}

bool readGroup(js::Engine *engine, js::JSValueHandle object, const char *name,
               uint32_t &output) {
  const auto value = engine->getProperty(object, name);
  if (engine->isUndefined(value))
    return true;
  if (!engine->isNumber(value))
    return false;
  const double number = engine->toNumber(value);
  if (!std::isfinite(number) || number < 0 ||
      number > std::numeric_limits<uint32_t>::max() ||
      std::floor(number) != number) {
    return false;
  }
  output = static_cast<uint32_t>(number);
  return true;
}

bool readMaxResults(js::Engine *engine, js::JSValueHandle object,
                    uint32_t &output) {
  const auto value = engine->getProperty(object, "maxResults");
  if (!engine->isNumber(value))
    return false;
  const double number = engine->toNumber(value);
  if (!std::isfinite(number) || number < 1 ||
      number > std::numeric_limits<uint32_t>::max() ||
      std::floor(number) != number) {
    return false;
  }
  output = static_cast<uint32_t>(number);
  return true;
}

bool readVector(js::Engine *engine, js::JSValueHandle parent,
                const char *name, float &x, float &y, float &z) {
  const auto value = engine->getProperty(parent, name);
  return engine->isObject(value) && readFiniteNumber(engine, value, "x", x) &&
         readFiniteNumber(engine, value, "y", y) &&
         readFiniteNumber(engine, value, "z", z);
}

bool readQuaternion(js::Engine *engine, js::JSValueHandle parent,
                    const char *name, float &x, float &y, float &z, float &w) {
  const auto value = engine->getProperty(parent, name);
  return engine->isObject(value) && readFiniteNumber(engine, value, "x", x) &&
         readFiniteNumber(engine, value, "y", y) &&
         readFiniteNumber(engine, value, "z", z) &&
         readFiniteNumber(engine, value, "w", w);
}

bool readGravity(js::Engine *engine, js::JSValueHandle options, float &x,
                 float &y, float &z) {
  const auto gravity = engine->getProperty(options, "gravity");
  if (engine->isUndefined(gravity))
    return true;
  if (engine->isNumber(gravity)) {
    const double value = engine->toNumber(gravity);
    if (!std::isfinite(value))
      return false;
    y = static_cast<float>(value);
    return true;
  }
  if (!engine->isObject(gravity))
    return false;
  if (engine->isArray(gravity)) {
    const auto xValue = engine->getPropertyIndex(gravity, 0);
    const auto yValue = engine->getPropertyIndex(gravity, 1);
    const auto zValue = engine->getPropertyIndex(gravity, 2);
    if (!engine->isNumber(xValue) || !engine->isNumber(yValue) ||
        !engine->isNumber(zValue)) {
      return false;
    }
    x = static_cast<float>(engine->toNumber(xValue));
    y = static_cast<float>(engine->toNumber(yValue));
    z = static_cast<float>(engine->toNumber(zValue));
    return std::isfinite(x) && std::isfinite(y) && std::isfinite(z);
  }
  return readFiniteNumber(engine, gravity, "x", x) &&
         readFiniteNumber(engine, gravity, "y", y) &&
         readFiniteNumber(engine, gravity, "z", z);
}

bool isTypedArray(js::Engine *engine, js::JSValueHandle value,
                  const char *expectedName) {
  if (!engine->isObject(value))
    return false;
  const auto constructor = engine->getProperty(value, "constructor");
  if (!engine->isFunction(constructor))
    return false;
  const auto name = engine->getProperty(constructor, "name");
  return engine->isString(name) && engine->toString(name) == expectedName;
}

struct TrimeshBuffers {
  const float *vertices = nullptr;
  uint32_t vertex_floats = 0;
  const uint32_t *indices = nullptr;
  uint32_t index_count = 0;
};

// A heightfield's samples (column-major, as the web backend hands Rapier), grid and extent.
struct HeightfieldBuffers {
  const float *heights = nullptr;
  uint32_t count = 0;
  uint32_t rows = 0;
  uint32_t columns = 0;
  float scale_x = 0.0f;
  float scale_y = 0.0f;
  float scale_z = 0.0f;
};

bool readGridCount(js::Engine *engine, js::JSValueHandle object, const char *name,
                   uint32_t &output) {
  float value = 0.0f;
  if (!readFiniteNumber(engine, object, name, value) || value < 2.0f ||
      value > 65536.0f || std::floor(value) != value)
    return false;
  output = static_cast<uint32_t>(value);
  return true;
}

// The samples' data pointer stays valid for the synchronous call that parses it, like a trimesh's.
bool parseHeightfield(js::Engine *engine, js::JSValueHandle shape,
                      HeightfieldBuffers &heightfield) {
  const auto heights = engine->getProperty(shape, "heights");
  if (!isTypedArray(engine, heights, "Float32Array") ||
      !readGridCount(engine, shape, "rows", heightfield.rows) ||
      !readGridCount(engine, shape, "columns", heightfield.columns) ||
      !readVector(engine, shape, "scale", heightfield.scale_x, heightfield.scale_y,
                  heightfield.scale_z))
    return false;
  size_t bytes = 0;
  void *data = engine->getArrayBufferData(heights, &bytes);
  if (data == nullptr || bytes % sizeof(float) != 0)
    return false;
  heightfield.heights = static_cast<const float *>(data);
  heightfield.count = static_cast<uint32_t>(bytes / sizeof(float));
  return true;
}

// The mesh's data pointers stay valid for the synchronous call that parses them: the typed
// arrays are reachable from the object the caller passed in, so nothing is collected mid-call.
bool parseTrimeshBuffers(js::Engine *engine, js::JSValueHandle shape,
                         TrimeshBuffers &trimesh) {
  const auto vertices = engine->getProperty(shape, "vertices");
  if (!isTypedArray(engine, vertices, "Float32Array"))
    return false;
  const auto indices = engine->getProperty(shape, "indices");
  if (!isTypedArray(engine, indices, "Uint32Array"))
    return false;
  size_t vertexBytes = 0;
  size_t indexBytes = 0;
  void *vertexData = engine->getArrayBufferData(vertices, &vertexBytes);
  void *indexData = engine->getArrayBufferData(indices, &indexBytes);
  if (vertexData == nullptr || indexData == nullptr)
    return false;
  trimesh.vertices = static_cast<const float *>(vertexData);
  trimesh.vertex_floats = static_cast<uint32_t>(vertexBytes / sizeof(float));
  trimesh.indices = static_cast<const uint32_t *>(indexData);
  trimesh.index_count = static_cast<uint32_t>(indexBytes / sizeof(uint32_t));
  return true;
}

bool parseBodyOptions(js::Engine *engine, js::JSValueHandle value, uint32_t id,
                      TnPhysicsBodyOptions &options, TrimeshBuffers &trimesh,
                      HeightfieldBuffers &heightfield) {
  if (!engine->isObject(value))
    return false;
  options = {id, 0, 0, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 1.0f,
             0.0f, 0.0f, 0.0f, 0.0f, 1,    0xffff, false, true};
  const auto type = engine->getProperty(value, "type");
  if (!engine->isString(type))
    return false;
  const std::string typeName = engine->toString(type);
  if (typeName == "dynamic")
    options.body_type = 0;
  else if (typeName == "fixed")
    options.body_type = 1;
  else if (typeName == "kinematic")
    options.body_type = 2;
  else if (typeName == "character")
    options.body_type = 3;
  else
    return false;

  const auto shape = engine->getProperty(value, "shape");
  if (!engine->isObject(shape))
    return false;
  const auto kind = engine->getProperty(shape, "kind");
  if (!engine->isString(kind))
    return false;
  const std::string shapeName = engine->toString(kind);
  if (shapeName == "box")
    options.shape_type = 0;
  else if (shapeName == "sphere")
    options.shape_type = 1;
  else if (shapeName == "capsule")
    options.shape_type = 2;
  else if (shapeName == "trimesh") {
    options.shape_type = 3;
    if (!parseTrimeshBuffers(engine, shape, trimesh))
      return false;
  } else if (shapeName == "heightfield") {
    // Shape type 4 never crosses the C ABI: it selects tn_physics_add_heightfield_body.
    options.shape_type = 4;
    if (!parseHeightfield(engine, shape, heightfield))
      return false;
  } else
    return false;

  const auto sensor = engine->getProperty(value, "sensor");
  if (!engine->isUndefined(sensor)) {
    if (!engine->isBoolean(sensor))
      return false;
    options.sensor = engine->toBoolean(sensor);
  }
  const auto continuousCollision =
      engine->getProperty(value, "continuousCollision");
  if (!engine->isUndefined(continuousCollision)) {
    if (!engine->isBoolean(continuousCollision))
      return false;
    options.continuous_collision = engine->toBoolean(continuousCollision);
  }
  return readVector(engine, value, "position", options.position_x,
                    options.position_y, options.position_z) &&
         readQuaternion(engine, value, "rotation", options.rotation_x,
                        options.rotation_y, options.rotation_z,
                        options.rotation_w) &&
         readFiniteNumber(engine, shape, "x", options.shape_x) &&
         readOptionalFiniteNumber(engine, shape, "y", options.shape_y) &&
         readOptionalFiniteNumber(engine, shape, "z", options.shape_z) &&
         readOptionalFiniteNumber(engine, value, "mass", options.mass) &&
         readGroup(engine, value, "collisionLayer", options.collision_layer) &&
         readGroup(engine, value, "collisionMask", options.collision_mask);
}

bool parseCharacterOptions(js::Engine *engine, js::JSValueHandle value,
                           uint32_t id,
                           TnPhysicsCharacterOptions &options) {
  if (!engine->isObject(value))
    return false;
  options = {id, 0.01f, 0.78539816339f, false, 0.0f,
             0.0f, false, false, 0.0f, 0, false};
  if (!readFiniteNumber(engine, value, "offset", options.offset) ||
      !readFiniteNumber(engine, value, "maxSlopeClimbAngle",
                        options.max_slope_climb_angle) ||
      !readGroup(engine, value, "oneWayLayers", options.one_way_layers)) {
    return false;
  }
  const auto autostep = engine->getProperty(value, "autostep");
  if (!engine->isUndefined(autostep)) {
    if (!engine->isObject(autostep) ||
        !readFiniteNumber(engine, autostep, "maxHeight",
                          options.autostep_max_height) ||
        !readFiniteNumber(engine, autostep, "minWidth",
                          options.autostep_min_width)) {
      return false;
    }
    const auto includeDynamic =
        engine->getProperty(autostep, "includeDynamicBodies");
    if (!engine->isBoolean(includeDynamic))
      return false;
    options.autostep_enabled = true;
    options.autostep_include_dynamic_bodies =
        engine->toBoolean(includeDynamic);
  }
  const auto snap = engine->getProperty(value, "snapToGround");
  if (!engine->isUndefined(snap)) {
    if (!engine->isNumber(snap) ||
        !std::isfinite(engine->toNumber(snap))) {
      return false;
    }
    options.snap_to_ground_enabled = true;
    options.snap_to_ground = static_cast<float>(engine->toNumber(snap));
  }
  const auto pushes = engine->getProperty(value, "pushesDynamicBodies");
  if (!engine->isUndefined(pushes)) {
    if (!engine->isBoolean(pushes))
      return false;
    options.pushes_dynamic_bodies = engine->toBoolean(pushes);
  }
  return true;
}

bool parseRayQuery(js::Engine *engine, js::JSValueHandle value,
                   TnPhysicsRayQuery &query) {
  if (!engine->isObject(value))
    return false;
  query = {0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0xffff};
  if (!readVector(engine, value, "from", query.from_x, query.from_y,
                  query.from_z) ||
      !readVector(engine, value, "to", query.to_x, query.to_y, query.to_z) ||
      !readGroup(engine, value, "collisionMask", query.collision_mask))
    return false;
  return query.from_x != query.to_x || query.from_y != query.to_y ||
         query.from_z != query.to_z;
}

bool parseShapeQuery(js::Engine *engine, js::JSValueHandle value,
                     TnPhysicsShapeQueryOptions &query) {
  if (!engine->isObject(value))
    return false;
  query = {0, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f,
           1.0f, 0xffff, 16};
  const auto shape = engine->getProperty(value, "shape");
  if (!engine->isObject(shape))
    return false;
  const auto kind = engine->getProperty(shape, "kind");
  if (!engine->isString(kind))
    return false;
  const std::string shapeName = engine->toString(kind);
  if (shapeName == "box")
    query.shape_type = 0;
  else if (shapeName == "sphere")
    query.shape_type = 1;
  else if (shapeName == "capsule")
    query.shape_type = 2;
  else
    return false;
  return readFiniteNumber(engine, shape, "x", query.shape_x) &&
         readFiniteNumber(engine, shape, "y", query.shape_y) &&
         readFiniteNumber(engine, shape, "z", query.shape_z) &&
         readVector(engine, value, "position", query.position_x,
                    query.position_y, query.position_z) &&
         readQuaternion(engine, value, "rotation", query.rotation_x,
                        query.rotation_y, query.rotation_z,
                        query.rotation_w) &&
         readGroup(engine, value, "collisionMask", query.collision_mask) &&
         readMaxResults(engine, value, query.max_results);
}

bool parsePointQuery(js::Engine *engine, js::JSValueHandle value,
                     float &x, float &y, float &z, uint32_t &mask,
                     uint32_t &maxResults) {
  if (!engine->isObject(value))
    return false;
  mask = 0xffff;
  return readVector(engine, value, "position", x, y, z) &&
         readGroup(engine, value, "collisionMask", mask) &&
         readMaxResults(engine, value, maxResults);
}

js::JSValueHandle makeVector(js::Engine *engine, float x, float y, float z) {
  auto vector = engine->newObject();
  engine->setProperty(vector, "x", engine->newNumber(x));
  engine->setProperty(vector, "y", engine->newNumber(y));
  engine->setProperty(vector, "z", engine->newNumber(z));
  return vector;
}

js::JSValueHandle makeQueryHit(js::Engine *engine,
                               const TnPhysicsQueryHit &hit) {
  auto result = engine->newObject();
  engine->setProperty(result, "bodyId", engine->newNumber(hit.body_id));
  engine->setProperty(
      result, "position",
      makeVector(engine, hit.position_x, hit.position_y, hit.position_z));
  return result;
}

js::JSValueHandle makeRayHit(js::Engine *engine, const TnPhysicsRayHit &hit) {
  auto result = engine->newObject();
  engine->setProperty(result, "bodyId", engine->newNumber(hit.body_id));
  engine->setProperty(
      result, "position",
      makeVector(engine, hit.position_x, hit.position_y, hit.position_z));
  engine->setProperty(
      result, "normal",
      makeVector(engine, hit.normal_x, hit.normal_y, hit.normal_z));
  engine->setProperty(result, "distance", engine->newNumber(hit.distance));
  return result;
}

bool parseActuationArguments(js::Engine *engine,
                             const std::vector<js::JSValueHandle> &args,
                             uint32_t &id, float &x, float &y, float &z) {
  if (args.size() < 2 || !engine->isNumber(args[0]))
    return false;
  const double idValue = engine->toNumber(args[0]);
  if (!std::isfinite(idValue) || idValue < 0 || idValue > kMaxExactFloatId ||
      std::floor(idValue) != idValue || !engine->isObject(args[1]))
    return false;
  if (!readFiniteNumber(engine, args[1], "x", x) ||
      !readFiniteNumber(engine, args[1], "y", y) ||
      !readFiniteNumber(engine, args[1], "z", z))
    return false;
  id = static_cast<uint32_t>(idValue);
  return true;
}

bool parseActuationAtPointArguments(js::Engine *engine,
                                    const std::vector<js::JSValueHandle> &args,
                                    uint32_t &id, float &forceX, float &forceY,
                                    float &forceZ, float &pointX, float &pointY,
                                    float &pointZ) {
  if (!parseActuationArguments(engine, args, id, forceX, forceY, forceZ) ||
      args.size() < 3 || !engine->isObject(args[2]) ||
      !readFiniteNumber(engine, args[2], "x", pointX) ||
      !readFiniteNumber(engine, args[2], "y", pointY) ||
      !readFiniteNumber(engine, args[2], "z", pointZ))
    return false;
  return true;
}

bool parseBodyIdArgument(js::Engine *engine,
                         const std::vector<js::JSValueHandle> &args,
                         uint32_t &id) {
  if (args.empty() || !engine->isNumber(args[0]))
    return false;
  const double idValue = engine->toNumber(args[0]);
  if (!std::isfinite(idValue) || idValue < 0 || idValue > kMaxExactFloatId ||
      std::floor(idValue) != idValue)
    return false;
  id = static_cast<uint32_t>(idValue);
  return true;
}

bool readBodyIdProperty(js::Engine *engine, js::JSValueHandle object,
                        const char *name, uint32_t &id) {
  const auto value = engine->getProperty(object, name);
  if (!engine->isNumber(value))
    return false;
  const double idValue = engine->toNumber(value);
  if (!std::isfinite(idValue) || idValue < 0 || idValue > kMaxExactFloatId ||
      std::floor(idValue) != idValue)
    return false;
  id = static_cast<uint32_t>(idValue);
  return true;
}

/// Read the vehicle options the TypeScript seam hands over. The wheels are already flattened
/// into a Float32Array by the seam — twelve floats per wheel, in the order the C ABI documents —
/// so the binding never has to walk a wheel object's optional fields.
bool parseVehicleOptions(js::Engine *engine, js::JSValueHandle value, uint32_t id,
                         TnPhysicsVehicleOptions &options,
                         const float *&wheels, uint32_t &wheelFloats) {
  if (!engine->isObject(value))
    return false;
  uint32_t bodyId = 0;
  if (!readBodyIdProperty(engine, value, "bodyId", bodyId) ||
      !readVector(engine, value, "axle", options.axle_x, options.axle_y,
                  options.axle_z))
    return false;
  const auto forwardAxis = engine->getProperty(value, "forwardAxis");
  if (!engine->isNumber(forwardAxis) || !std::isfinite(engine->toNumber(forwardAxis)))
    return false;
  const double axis = engine->toNumber(forwardAxis);
  if (axis != 0.0 && axis != 2.0)
    return false;
  const auto records = engine->getProperty(value, "wheels");
  if (!isTypedArray(engine, records, "Float32Array"))
    return false;
  size_t bytes = 0;
  auto *data =
      static_cast<const float *>(engine->getArrayBufferData(records, &bytes));
  if (data == nullptr || bytes % sizeof(float) != 0 ||
      bytes / sizeof(float) <
          static_cast<size_t>(TN_PHYSICS_VEHICLE_WHEEL_WIDTH))
    return false;
  options = {id, bodyId, static_cast<uint32_t>(axis), options.axle_x,
             options.axle_y, options.axle_z,
             static_cast<uint32_t>(bytes / sizeof(float) /
                                   TN_PHYSICS_VEHICLE_WHEEL_WIDTH)};
  wheels = data;
  wheelFloats = static_cast<uint32_t>(bytes / sizeof(float));
  return true;
}

bool readOptionalVector(js::Engine *engine, js::JSValueHandle object,
                        const char *name, float &x, float &y, float &z) {
  const auto value = engine->getProperty(object, name);
  if (engine->isUndefined(value))
    return true;
  return engine->isObject(value) && readFiniteNumber(engine, value, "x", x) &&
         readFiniteNumber(engine, value, "y", y) &&
         readFiniteNumber(engine, value, "z", z);
}

bool readOptionalQuaternion(js::Engine *engine, js::JSValueHandle object,
                            const char *name, float &x, float &y, float &z,
                            float &w) {
  const auto value = engine->getProperty(object, name);
  if (engine->isUndefined(value))
    return true;
  return engine->isObject(value) && readFiniteNumber(engine, value, "x", x) &&
         readFiniteNumber(engine, value, "y", y) &&
         readFiniteNumber(engine, value, "z", z) &&
         readFiniteNumber(engine, value, "w", w);
}

bool parseJointOptions(js::Engine *engine, js::JSValueHandle value,
                       uint32_t id, TnPhysicsJointOptions &options) {
  if (!engine->isObject(value))
    return false;
  options = {};
  options.id = id;
  options.axis_x = 1.0f;
  options.frame_a_w = 1.0f;
  options.frame_b_w = 1.0f;

  const auto type = engine->getProperty(value, "type");
  if (!engine->isString(type))
    return false;
  const std::string typeName = engine->toString(type);
  if (typeName == "pin")
    options.joint_type = 0;
  else if (typeName == "hinge")
    options.joint_type = 1;
  else if (typeName == "fixed")
    options.joint_type = 2;
  else
    return false;

  if (!readBodyIdProperty(engine, value, "bodyA", options.body_a) ||
      !readBodyIdProperty(engine, value, "bodyB", options.body_b) ||
      !readVector(engine, value, "anchorA", options.anchor_a_x,
                  options.anchor_a_y, options.anchor_a_z) ||
      !readVector(engine, value, "anchorB", options.anchor_b_x,
                  options.anchor_b_y, options.anchor_b_z) ||
      !readOptionalVector(engine, value, "axis", options.axis_x,
                          options.axis_y, options.axis_z))
    return false;

  const auto limit = engine->getProperty(value, "limit");
  if (!engine->isUndefined(limit)) {
    if (options.joint_type != 1 || !engine->isObject(limit) ||
        !readFiniteNumber(engine, limit, "lower", options.limit_lower) ||
        !readFiniteNumber(engine, limit, "upper", options.limit_upper))
      return false;
    options.limit_enabled = true;
  }

  const auto frameA = engine->getProperty(value, "frameA");
  const auto frameB = engine->getProperty(value, "frameB");
  if (options.joint_type != 2 &&
      (!engine->isUndefined(frameA) || !engine->isUndefined(frameB)))
    return false;
  return readOptionalQuaternion(engine, value, "frameA", options.frame_a_x,
                                options.frame_a_y, options.frame_a_z,
                                options.frame_a_w) &&
         readOptionalQuaternion(engine, value, "frameB", options.frame_b_x,
                                options.frame_b_y, options.frame_b_z,
                                options.frame_b_w);
}

js::JSValueHandle makeSimulationObject(
    js::Engine *engine, const std::shared_ptr<SimulationOwner> &owner) {
  auto simulation = engine->newObject();
  engine->setProperty(
      simulation, "createBody",
      engine->newFunction(
          "createBody",
          [engine, owner](void *, const std::vector<js::JSValueHandle> &args) {
            if (owner->simulation == nullptr)
              return fail(engine, "physics simulation is disposed");
            if (args.empty() || owner->nextId > kMaxExactFloatId)
              return fail(engine, "createBody requires options and an available id");
            TnPhysicsBodyOptions options{};
            TrimeshBuffers trimesh{};
            HeightfieldBuffers heightfield{};
            if (!parseBodyOptions(engine, args[0], owner->nextId, options, trimesh,
                                  heightfield))
              return fail(engine, "physics body options are invalid");
            const bool added =
                options.shape_type == 3
                    ? tn_physics_add_trimesh_body(
                          owner->simulation, &options, trimesh.vertices,
                          trimesh.vertex_floats, trimesh.indices,
                          trimesh.index_count)
                : options.shape_type == 4
                    ? tn_physics_add_heightfield_body(
                          owner->simulation, &options, heightfield.heights,
                          heightfield.count, heightfield.rows, heightfield.columns,
                          heightfield.scale_x, heightfield.scale_y, heightfield.scale_z)
                    : tn_physics_add_body(owner->simulation, &options);
            if (!added)
              return fail(engine, "physics body options are invalid");
            const uint32_t id = owner->nextId++;
            return engine->newNumber(id);
          }));
  engine->setProperty(
      simulation, "createJoint",
      engine->newFunction(
          "createJoint",
          [engine, owner](void *, const std::vector<js::JSValueHandle> &args) {
            if (owner->simulation == nullptr)
              return fail(engine, "physics simulation is disposed");
            if (args.empty() || owner->nextJointId > kMaxExactFloatId)
              return fail(engine, "createJoint requires options and an available id");
            TnPhysicsJointOptions options{};
            if (!parseJointOptions(engine, args[0], owner->nextJointId, options))
              return fail(engine, "physics joint options are invalid");
            const int32_t result =
                tn_physics_create_joint(owner->simulation, &options);
            if (result < 0)
              return fail(engine, "physics joint options were rejected");
            owner->nextJointId += 1;
            return engine->newNumber(result);
          }));
  engine->setProperty(
      simulation, "removeBody",
      engine->newFunction(
          "removeBody",
          [engine, owner](void *, const std::vector<js::JSValueHandle> &args) {
            if (owner->simulation == nullptr)
              return fail(engine, "physics simulation is disposed");
            if (args.empty() || !engine->isNumber(args[0]))
              return fail(engine, "removeBody requires a numeric id");
            const double id = engine->toNumber(args[0]);
            if (!std::isfinite(id) || id < 0 || id > kMaxExactFloatId ||
                std::floor(id) != id)
              return fail(engine, "removeBody received an invalid id");
            tn_physics_remove_body(owner->simulation,
                                   static_cast<uint32_t>(id));
            return engine->newUndefined();
          }));
  engine->setProperty(
      simulation, "removeJoint",
      engine->newFunction(
          "removeJoint",
          [engine, owner](void *, const std::vector<js::JSValueHandle> &args) {
            if (owner->simulation == nullptr)
              return fail(engine, "physics simulation is disposed");
            uint32_t id = 0;
            if (!parseBodyIdArgument(engine, args, id))
              return fail(engine, "removeJoint received an invalid id");
            tn_physics_remove_joint(owner->simulation, id);
            return engine->newUndefined();
          }));
  engine->setProperty(
      simulation, "configureCharacter",
      engine->newFunction(
          "configureCharacter",
          [engine, owner](void *, const std::vector<js::JSValueHandle> &args) {
            if (owner->simulation == nullptr)
              return fail(engine, "physics simulation is disposed");
            if (args.size() < 2 || !engine->isNumber(args[0]))
              return fail(engine, "configureCharacter requires an id and options");
            const double id = engine->toNumber(args[0]);
            if (!std::isfinite(id) || id < 0 || id > kMaxExactFloatId ||
                std::floor(id) != id)
              return fail(engine, "configureCharacter received an invalid id");
            TnPhysicsCharacterOptions options{};
            if (!parseCharacterOptions(engine, args[1],
                                       static_cast<uint32_t>(id), options) ||
                !tn_physics_configure_character(owner->simulation, &options)) {
              return fail(engine, "character controller options are invalid");
            }
            return engine->newUndefined();
          }));
  engine->setProperty(
      simulation, "createVehicle",
      engine->newFunction(
          "createVehicle",
          [engine, owner](void *, const std::vector<js::JSValueHandle> &args) {
            if (owner->simulation == nullptr)
              return fail(engine, "physics simulation is disposed");
            if (args.empty() || owner->nextVehicleId > kMaxExactFloatId)
              return fail(engine, "createVehicle requires options and an available id");
            TnPhysicsVehicleOptions options{};
            const float *wheels = nullptr;
            uint32_t wheelFloats = 0;
            if (!parseVehicleOptions(engine, args[0], owner->nextVehicleId,
                                     options, wheels, wheelFloats))
              return fail(engine, "vehicle options are invalid");
            const int32_t id = tn_physics_create_vehicle(owner->simulation, &options, wheels);
            if (id < 0)
              return fail(engine,
                          "TN_VEHICLE_INVALID: the chassis is missing, is not dynamic, or the "
                          "wheels are malformed.");
            owner->nextVehicleId += 1;
            return engine->newNumber(id);
          }));
  engine->setProperty(
      simulation, "setVehicleInput",
      engine->newFunction(
          "setVehicleInput",
          [engine, owner](void *, const std::vector<js::JSValueHandle> &args) {
            if (owner->simulation == nullptr)
              return fail(engine, "physics simulation is disposed");
            uint32_t id = 0;
            float engineForce = 0.0f;
            float brake = 0.0f;
            float steering = 0.0f;
            if (!parseBodyIdArgument(engine, args, id) || args.size() < 2 ||
                !engine->isObject(args[1]) ||
                !readFiniteNumber(engine, args[1], "engineForce", engineForce) ||
                !readFiniteNumber(engine, args[1], "brake", brake) ||
                !readFiniteNumber(engine, args[1], "steering", steering))
              return fail(engine,
                          "TN_PHYSICS_NON_FINITE: vehicle input needs a finite engineForce, brake "
                          "and steering.");
            if (!tn_physics_set_vehicle_input(owner->simulation, id, engineForce,
                                              brake, steering))
              return fail(engine, "TN_VEHICLE_UNKNOWN: the vehicle left the backend.");
            return engine->newUndefined();
          }));
  engine->setProperty(
      simulation, "readVehicleState",
      engine->newFunction(
          "readVehicleState",
          [engine, owner](void *, const std::vector<js::JSValueHandle> &args) {
            if (owner->simulation == nullptr)
              return fail(engine, "physics simulation is disposed");
            uint32_t id = 0;
            if (!parseBodyIdArgument(engine, args, id) || args.size() < 2 ||
                !isTypedArray(engine, args[1], "Float32Array"))
              return fail(engine, "readVehicleState requires an id and a Float32Array");
            size_t bytes = 0;
            auto *data = static_cast<float *>(
                engine->getArrayBufferData(args[1], &bytes));
            if (bytes % sizeof(float) != 0)
              return fail(engine, "vehicle state buffer is malformed");
            const int32_t count = tn_physics_read_vehicle_state(
                owner->simulation, id, data, bytes / sizeof(float));
            if (count < 0)
              return fail(engine,
                          "TN_VEHICLE_UNKNOWN: the vehicle left the backend or the buffer is too "
                          "small.");
            return engine->newNumber(count);
          }));
  engine->setProperty(
      simulation, "resetVehicle",
      engine->newFunction(
          "resetVehicle",
          [engine, owner](void *, const std::vector<js::JSValueHandle> &args) {
            if (owner->simulation == nullptr)
              return fail(engine, "physics simulation is disposed");
            uint32_t id = 0;
            float x = 0.0f;
            float y = 0.0f;
            float z = 0.0f;
            float yaw = 0.0f;
            if (!parseBodyIdArgument(engine, args, id) || args.size() < 3 ||
                !engine->isObject(args[1]) ||
                !readFiniteNumber(engine, args[1], "x", x) ||
                !readFiniteNumber(engine, args[1], "y", y) ||
                !readFiniteNumber(engine, args[1], "z", z) ||
                !engine->isNumber(args[2]))
              return fail(engine,
                          "TN_PHYSICS_NON_FINITE: a respawn needs a finite position and yaw.");
            const double yawNumber = engine->toNumber(args[2]);
            if (!std::isfinite(yawNumber) || yawNumber < -std::numeric_limits<float>::max() ||
                yawNumber > std::numeric_limits<float>::max())
              return fail(engine,
                          "TN_PHYSICS_NON_FINITE: a respawn needs a finite position and yaw.");
            yaw = static_cast<float>(yawNumber);
            if (!tn_physics_reset_vehicle(owner->simulation, id, x, y, z, yaw))
              return fail(engine, "TN_VEHICLE_UNKNOWN: the vehicle left the backend.");
            return engine->newUndefined();
          }));
  engine->setProperty(
      simulation, "setBodyTransform",
      engine->newFunction(
          "setBodyTransform",
          [engine, owner](void *, const std::vector<js::JSValueHandle> &args) {
            if (owner->simulation == nullptr)
              return fail(engine, "physics simulation is disposed");
            if (args.size() < 2 || !engine->isNumber(args[0]) ||
                !std::isfinite(engine->toNumber(args[0])))
              return fail(engine, "setBodyTransform requires an id and position");
            const double id = engine->toNumber(args[0]);
            if (id < 0 || id > kMaxExactFloatId || std::floor(id) != id)
              return fail(engine, "setBodyTransform received an invalid id");
            float x = 0.0f;
            float y = 0.0f;
            float z = 0.0f;
            if (!engine->isObject(args[1]) ||
                !readFiniteNumber(engine, args[1], "x", x) ||
                !readFiniteNumber(engine, args[1], "y", y) ||
                !readFiniteNumber(engine, args[1], "z", z))
              return fail(engine, "setBodyTransform received an invalid position");
            if (!tn_physics_set_body_transform(owner->simulation,
                                               static_cast<uint32_t>(id), x, y, z))
              return fail(engine, "setBodyTransform received an unknown id");
            return engine->newUndefined();
          }));
  engine->setProperty(
      simulation, "applyBodyImpulse",
      engine->newFunction(
          "applyBodyImpulse",
          [engine, owner](void *, const std::vector<js::JSValueHandle> &args) {
            if (owner->simulation == nullptr)
              return fail(engine, "physics simulation is disposed");
            uint32_t id = 0;
            float x = 0.0f;
            float y = 0.0f;
            float z = 0.0f;
            if (!parseActuationArguments(engine, args, id, x, y, z))
              return fail(engine,
                          "TN_PHYSICS_NON_FINITE: impulse must be a finite { x, y, z }.");
            const int32_t status =
                tn_physics_apply_body_impulse(owner->simulation, id, x, y, z);
            if (status != TN_PHYSICS_ACTUATION_OK)
              return failActuation(engine, status);
            return engine->newUndefined();
          }));
  engine->setProperty(
      simulation, "applyBodyForce",
      engine->newFunction(
          "applyBodyForce",
          [engine, owner](void *, const std::vector<js::JSValueHandle> &args) {
            if (owner->simulation == nullptr)
              return fail(engine, "physics simulation is disposed");
            uint32_t id = 0;
            float x = 0.0f;
            float y = 0.0f;
            float z = 0.0f;
            if (!parseActuationArguments(engine, args, id, x, y, z))
              return fail(engine,
                          "TN_PHYSICS_NON_FINITE: force must be a finite { x, y, z }.");
            const int32_t status =
                tn_physics_apply_body_force(owner->simulation, id, x, y, z);
            if (status != TN_PHYSICS_ACTUATION_OK)
              return failActuation(engine, status);
            return engine->newUndefined();
          }));
  engine->setProperty(
      simulation, "applyBodyForceAtPoint",
      engine->newFunction(
          "applyBodyForceAtPoint",
          [engine, owner](void *, const std::vector<js::JSValueHandle> &args) {
            if (owner->simulation == nullptr)
              return fail(engine, "physics simulation is disposed");
            uint32_t id = 0;
            float forceX = 0.0f;
            float forceY = 0.0f;
            float forceZ = 0.0f;
            float pointX = 0.0f;
            float pointY = 0.0f;
            float pointZ = 0.0f;
            if (!parseActuationAtPointArguments(engine, args, id, forceX, forceY,
                                                 forceZ, pointX, pointY, pointZ))
              return fail(
                  engine,
                  "TN_PHYSICS_NON_FINITE: force and point must be finite { x, y, z } values.");
            const int32_t status = tn_physics_apply_body_force_at_point(
                owner->simulation, id, forceX, forceY, forceZ, pointX, pointY, pointZ);
            if (status != TN_PHYSICS_ACTUATION_OK)
              return failActuation(engine, status);
            return engine->newUndefined();
          }));
  engine->setProperty(
      simulation, "setBodyLinearVelocity",
      engine->newFunction(
          "setBodyLinearVelocity",
          [engine, owner](void *, const std::vector<js::JSValueHandle> &args) {
            if (owner->simulation == nullptr)
              return fail(engine, "physics simulation is disposed");
            uint32_t id = 0;
            float x = 0.0f;
            float y = 0.0f;
            float z = 0.0f;
            if (!parseActuationArguments(engine, args, id, x, y, z))
              return fail(engine,
                          "TN_PHYSICS_NON_FINITE: velocity must be a finite { x, y, z }.");
            const int32_t status = tn_physics_set_body_linear_velocity(
                owner->simulation, id, x, y, z);
            if (status != TN_PHYSICS_ACTUATION_OK)
              return failActuation(engine, status);
            return engine->newUndefined();
          }));
  engine->setProperty(
      simulation, "readBodyLinearVelocity",
      engine->newFunction(
          "readBodyLinearVelocity",
          [engine, owner](void *, const std::vector<js::JSValueHandle> &args) {
            if (owner->simulation == nullptr)
              return fail(engine, "physics simulation is disposed");
            uint32_t id = 0;
            if (!parseBodyIdArgument(engine, args, id))
              return fail(engine, "readBodyLinearVelocity received an invalid id");
            TnPhysicsVector3 velocity{};
            const int32_t status = tn_physics_read_body_linear_velocity(
                owner->simulation, id, &velocity);
            if (status != TN_PHYSICS_ACTUATION_OK)
              return failActuation(engine, status);
            return makeVector(engine, velocity.x, velocity.y, velocity.z);
          }));
  engine->setProperty(
      simulation, "step",
      engine->newFunction(
          "step", [engine, owner](
                      void *, const std::vector<js::JSValueHandle> &args) {
            if (owner->simulation == nullptr)
              return fail(engine, "physics simulation is disposed");
            if (args.empty() || !engine->isNumber(args[0]))
              return fail(engine, "step requires a numeric deltaTime");
            const double deltaTime = engine->toNumber(args[0]);
            const float *input = nullptr;
            size_t count = 0;
            if (args.size() > 1 && !engine->isUndefined(args[1])) {
              if (!engine->isObject(args[1]))
                return fail(engine, "physics input snapshot must be an object");
              const auto countValue =
                  engine->getProperty(args[1], "kinematicCount");
              const auto transforms =
                  engine->getProperty(args[1], "kinematicTransforms");
              if (!engine->isNumber(countValue) ||
                  !isTypedArray(engine, transforms, "Float32Array")) {
                return fail(engine, "physics input snapshot is malformed");
              }
              const double countNumber = engine->toNumber(countValue);
              size_t bytes = 0;
              input = static_cast<const float *>(
                  engine->getArrayBufferData(transforms, &bytes));
              if (!std::isfinite(countNumber) || countNumber < 0 ||
                  std::floor(countNumber) != countNumber ||
                  countNumber > bytes / (8 * sizeof(float))) {
                return fail(engine, "physics input snapshot has an invalid count");
              }
              count = static_cast<size_t>(countNumber);
            }
            if (!std::isfinite(deltaTime) || deltaTime <= 0 ||
                !tn_physics_step(owner->simulation,
                                 static_cast<float>(deltaTime), input, count)) {
              return fail(engine, "physics step rejected its deltaTime or input");
            }
            return engine->newUndefined();
          }));
  engine->setProperty(
      simulation, "readVisibleTransforms",
      engine->newFunction(
          "readVisibleTransforms",
          [engine, owner](void *,
                          const std::vector<js::JSValueHandle> &args) {
            if (owner->simulation == nullptr)
              return fail(engine, "physics simulation is disposed");
            if (args.empty() ||
                !isTypedArray(engine, args[0], "Float32Array")) {
              return fail(engine,
                          "readVisibleTransforms requires a Float32Array");
            }
            size_t bytes = 0;
            auto *data = static_cast<float *>(
                engine->getArrayBufferData(args[0], &bytes));
            if (bytes % sizeof(float) != 0)
              return fail(engine, "transform buffer is malformed");
            const int32_t count = tn_physics_read_visible_transforms(
                owner->simulation, data, bytes / sizeof(float));
            if (count < 0)
              return fail(engine, "transform buffer is too small");
            return engine->newNumber(count);
          }));
  engine->setProperty(
      simulation, "readCharacterStates",
      engine->newFunction(
          "readCharacterStates",
          [engine, owner](void *,
                          const std::vector<js::JSValueHandle> &args) {
            if (owner->simulation == nullptr)
              return fail(engine, "physics simulation is disposed");
            if (args.empty() ||
                !isTypedArray(engine, args[0], "Float32Array")) {
              return fail(engine,
                          "readCharacterStates requires a Float32Array");
            }
            size_t bytes = 0;
            auto *data = static_cast<float *>(
                engine->getArrayBufferData(args[0], &bytes));
            if (bytes % sizeof(float) != 0)
              return fail(engine, "character state buffer is malformed");
            const int32_t count = tn_physics_read_character_states(
                owner->simulation, data, bytes / sizeof(float));
            if (count < 0)
              return fail(engine, "character state buffer is too small");
            return engine->newNumber(count);
          }));
  engine->setProperty(
      simulation, "readBodySleepStates",
      engine->newFunction(
          "readBodySleepStates",
          [engine, owner](void *,
                          const std::vector<js::JSValueHandle> &args) {
            if (owner->simulation == nullptr)
              return fail(engine, "physics simulation is disposed");
            if (args.empty() ||
                !isTypedArray(engine, args[0], "Float32Array")) {
              return fail(engine,
                          "readBodySleepStates requires a Float32Array");
            }
            size_t bytes = 0;
            auto *data = static_cast<float *>(
                engine->getArrayBufferData(args[0], &bytes));
            if (bytes % sizeof(float) != 0)
              return fail(engine, "sleep state buffer is malformed");
            const int32_t count = tn_physics_read_body_sleep_states(
                owner->simulation, data, bytes / sizeof(float));
            if (count < 0)
              return fail(engine, "sleep state buffer is too small");
            return engine->newNumber(count);
          }));
  engine->setProperty(
      simulation, "readContacts",
      engine->newFunction(
          "readContacts",
          [engine, owner](void *,
                          const std::vector<js::JSValueHandle> &args) {
            if (owner->simulation == nullptr)
              return fail(engine, "physics simulation is disposed");
            uint32_t target = 0;
            if (args.size() < 3 || !parseBodyIdArgument(engine, args, target) ||
                !isTypedArray(engine, args[1], "Uint32Array") ||
                !isTypedArray(engine, args[2], "Float32Array"))
              return fail(engine,
                          "readContacts requires a body id, a Uint32Array and a Float32Array");
            size_t candidateBytes = 0;
            size_t outputBytes = 0;
            auto *candidates = static_cast<const uint32_t *>(
                engine->getArrayBufferData(args[1], &candidateBytes));
            auto *output = static_cast<float *>(
                engine->getArrayBufferData(args[2], &outputBytes));
            if (candidateBytes % sizeof(uint32_t) != 0 || outputBytes % sizeof(float) != 0)
              return fail(engine, "contact buffer is malformed");
            const int32_t count = tn_physics_read_contacts(
                owner->simulation, target, candidates,
                candidateBytes / sizeof(uint32_t), output,
                outputBytes / sizeof(float));
            if (count < 0)
              return fail(engine, "readContacts target is not a live body");
            return engine->newNumber(count);
          }));
  engine->setProperty(
      simulation, "setColliderShape",
      engine->newFunction(
          "setColliderShape",
          [engine, owner](void *,
                          const std::vector<js::JSValueHandle> &args) {
            if (owner->simulation == nullptr)
              return fail(engine, "physics simulation is disposed");
            uint32_t id = 0;
            if (args.size() < 2 || !parseBodyIdArgument(engine, args, id) ||
                !engine->isObject(args[1]))
              return fail(engine, "setColliderShape requires a body id and a shape");
            const auto kind = engine->getProperty(args[1], "kind");
            if (!engine->isString(kind))
              return fail(engine, "setColliderShape requires a shape kind");
            if (engine->toString(kind) != "heightfield")
              return fail(engine, "setColliderShape supports heightfield shapes");
            HeightfieldBuffers heightfield{};
            if (!parseHeightfield(engine, args[1], heightfield) ||
                !tn_physics_set_heightfield_shape(
                    owner->simulation, id, heightfield.heights, heightfield.count,
                    heightfield.rows, heightfield.columns, heightfield.scale_x,
                    heightfield.scale_y, heightfield.scale_z))
              return fail(engine, "setColliderShape shape was rejected");
            return engine->newUndefined();
          }));
  engine->setProperty(
      simulation, "readAreaIntersections",
      engine->newFunction(
          "readAreaIntersections",
          [engine, owner](void *,
                          const std::vector<js::JSValueHandle> &args) {
            if (owner->simulation == nullptr)
              return fail(engine, "physics simulation is disposed");
            if (args.empty() ||
                !isTypedArray(engine, args[0], "Uint32Array")) {
              return fail(engine,
                          "readAreaIntersections requires a Uint32Array");
            }
            size_t bytes = 0;
            auto *data = static_cast<uint32_t *>(
                engine->getArrayBufferData(args[0], &bytes));
            if (bytes % sizeof(uint32_t) != 0)
              return fail(engine, "area intersection buffer is malformed");
            const int32_t count = tn_physics_read_area_intersections(
                owner->simulation, data, bytes / sizeof(uint32_t));
            if (count < 0)
              return fail(engine, "area intersection buffer is too small");
            return engine->newNumber(count);
          }));
  engine->setProperty(
      simulation, "intersectRay",
      engine->newFunction(
          "intersectRay",
          [engine, owner](void *,
                          const std::vector<js::JSValueHandle> &args) {
            if (owner->simulation == nullptr)
              return fail(engine, "physics simulation is disposed");
            if (args.size() < 2)
              return fail(engine, "intersectRay requires query options and output");
            if (!isTypedArray(engine, args[1], "Float32Array"))
              return fail(engine, "intersectRay requires a Float32Array output");
            size_t bytes = 0;
            auto *data = static_cast<float *>(
                engine->getArrayBufferData(args[1], &bytes));
            if (bytes < 8 * sizeof(float))
              return fail(engine, "intersectRay output buffer is too small");
            TnPhysicsRayQuery query{};
            if (!parseRayQuery(engine, args[0], query))
              return fail(engine, "intersectRay query options are invalid");
            TnPhysicsRayHit hit{};
            const int32_t status =
                tn_physics_intersect_ray(owner->simulation, &query, &hit);
            if (status < 0)
              return fail(engine,
                          "intersectRay query arithmetic is invalid or unrepresentable");
            if (status == 0)
              return engine->newNumber(0);
            if (status != 1)
              return fail(engine, "intersectRay returned an invalid status");
            data[0] = static_cast<float>(hit.body_id);
            data[1] = hit.position_x;
            data[2] = hit.position_y;
            data[3] = hit.position_z;
            data[4] = hit.normal_x;
            data[5] = hit.normal_y;
            data[6] = hit.normal_z;
            data[7] = hit.distance;
            return engine->newNumber(1);
          }));
  engine->setProperty(
      simulation, "intersectShape",
      engine->newFunction(
          "intersectShape",
          [engine, owner](void *,
                          const std::vector<js::JSValueHandle> &args) {
            if (owner->simulation == nullptr)
              return fail(engine, "physics simulation is disposed");
            if (args.empty())
              return fail(engine, "intersectShape requires query options");
            TnPhysicsShapeQueryOptions query{};
            if (!parseShapeQuery(engine, args[0], query))
              return fail(engine, "intersectShape query options are invalid");
            std::vector<TnPhysicsQueryHit> hits(query.max_results);
            const int32_t count = tn_physics_intersect_shape(
                owner->simulation, &query, hits.data(), hits.size());
            if (count < 0)
              return fail(engine, "intersectShape query was rejected");
            auto result = engine->newArray(static_cast<size_t>(count));
            for (int32_t index = 0; index < count; index += 1)
              engine->setPropertyIndex(result, static_cast<uint32_t>(index),
                                       makeQueryHit(engine, hits[index]));
            return result;
          }));
  engine->setProperty(
      simulation, "intersectPoint",
      engine->newFunction(
          "intersectPoint",
          [engine, owner](void *,
                          const std::vector<js::JSValueHandle> &args) {
            if (owner->simulation == nullptr)
              return fail(engine, "physics simulation is disposed");
            if (args.empty())
              return fail(engine, "intersectPoint requires query options");
            float x = 0.0f;
            float y = 0.0f;
            float z = 0.0f;
            uint32_t mask = 0xffff;
            uint32_t maxResults = 16;
            if (!parsePointQuery(engine, args[0], x, y, z, mask, maxResults))
              return fail(engine, "intersectPoint query options are invalid");
            std::vector<TnPhysicsQueryHit> hits(maxResults);
            const int32_t count = tn_physics_intersect_point(
                owner->simulation, x, y, z, mask, maxResults, hits.data(),
                hits.size());
            if (count < 0)
              return fail(engine, "intersectPoint query was rejected");
            auto result = engine->newArray(static_cast<size_t>(count));
            for (int32_t index = 0; index < count; index += 1)
              engine->setPropertyIndex(result, static_cast<uint32_t>(index),
                                       makeQueryHit(engine, hits[index]));
            return result;
          }));
  engine->setProperty(
      simulation, "drainCollisionEvents",
      engine->newFunction(
          "drainCollisionEvents",
          [engine, owner](void *,
                          const std::vector<js::JSValueHandle> &args) {
            if (owner->simulation == nullptr)
              return fail(engine, "physics simulation is disposed");
            if (args.empty() ||
                !isTypedArray(engine, args[0], "Uint32Array")) {
              return fail(engine,
                          "drainCollisionEvents requires a Uint32Array");
            }
            size_t bytes = 0;
            auto *data = static_cast<uint32_t *>(
                engine->getArrayBufferData(args[0], &bytes));
            if (bytes % sizeof(uint32_t) != 0)
              return fail(engine, "collision event buffer is malformed");
            const int32_t count = tn_physics_drain_collision_events(
                owner->simulation, data, bytes / sizeof(uint32_t));
            if (count < 0)
              return fail(engine, "collision event buffer is too small");
            return engine->newNumber(count);
          }));
  engine->setProperty(
      simulation, "dispose",
      engine->newFunction(
          "dispose", [engine, owner](
                         void *, const std::vector<js::JSValueHandle> &) {
            owner->dispose();
            return engine->newUndefined();
          }));
  return simulation;
}

} // namespace

bool initializeNativePhysicsBindings(js::Engine *engine) {
  if (engine == nullptr)
    return false;

  auto nativeHost = engine->getGlobalProperty("__THREENATIVE_NATIVE__");
  if (engine->isUndefined(nativeHost))
    nativeHost = engine->newObject();
  auto physicsHost = engine->newObject();
  engine->setProperty(physicsHost, "version",
                      engine->newString(tn_physics_version()));
  engine->setProperty(
      physicsHost, "createSimulation",
      engine->newFunction(
          "createSimulation",
          [engine](void *, const std::vector<js::JSValueHandle> &args) {
            TnPhysicsWorldOptions options{0.0f, -9.81f, 0.0f};
            if (!args.empty() && !engine->isUndefined(args[0])) {
              if (!engine->isObject(args[0]) ||
                  !readGravity(engine, args[0], options.gravity_x,
                               options.gravity_y, options.gravity_z)) {
                return fail(engine, "physics options contain invalid gravity");
              }
            }
            auto owner = std::make_shared<SimulationOwner>();
            owner->simulation = tn_physics_create(&options);
            if (owner->simulation == nullptr)
              return fail(engine, "Rapier simulation creation failed");
            return makeSimulationObject(engine, owner);
          }));
  engine->setProperty(nativeHost, "physics", physicsHost);
  return engine->setGlobalProperty("__THREENATIVE_NATIVE__", nativeHost);
}

} // namespace mystral::physics
