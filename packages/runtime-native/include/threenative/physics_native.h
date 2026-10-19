#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct TnPhysicsSimulation TnPhysicsSimulation;

typedef struct TnPhysicsWorldOptions {
  float gravity_x;
  float gravity_y;
  float gravity_z;
} TnPhysicsWorldOptions;

typedef struct TnPhysicsBodyOptions {
  uint32_t id;
  uint32_t body_type;
  uint32_t shape_type;
  float position_x;
  float position_y;
  float position_z;
  float rotation_x;
  float rotation_y;
  float rotation_z;
  float rotation_w;
  float shape_x;
  float shape_y;
  float shape_z;
  float mass;
  uint32_t collision_layer;
  uint32_t collision_mask;
  bool sensor;
  bool continuous_collision;
} TnPhysicsBodyOptions;

typedef struct TnPhysicsJointOptions {
  uint32_t id;
  uint32_t joint_type;
  uint32_t body_a;
  uint32_t body_b;
  float anchor_a_x;
  float anchor_a_y;
  float anchor_a_z;
  float anchor_b_x;
  float anchor_b_y;
  float anchor_b_z;
  float axis_x;
  float axis_y;
  float axis_z;
  bool limit_enabled;
  float limit_lower;
  float limit_upper;
  float frame_a_x;
  float frame_a_y;
  float frame_a_z;
  float frame_a_w;
  float frame_b_x;
  float frame_b_y;
  float frame_b_z;
  float frame_b_w;
} TnPhysicsJointOptions;

typedef struct TnPhysicsCharacterOptions {
  uint32_t id;
  float offset;
  float max_slope_climb_angle;
  bool autostep_enabled;
  float autostep_max_height;
  float autostep_min_width;
  bool autostep_include_dynamic_bodies;
  bool snap_to_ground_enabled;
  float snap_to_ground;
  uint32_t one_way_layers;
  bool pushes_dynamic_bodies;
} TnPhysicsCharacterOptions;

typedef struct TnPhysicsRayQuery {
  float from_x;
  float from_y;
  float from_z;
  float to_x;
  float to_y;
  float to_z;
  uint32_t collision_mask;
} TnPhysicsRayQuery;

typedef struct TnPhysicsRayHit {
  uint32_t body_id;
  float position_x;
  float position_y;
  float position_z;
  float normal_x;
  float normal_y;
  float normal_z;
  float distance;
} TnPhysicsRayHit;

typedef struct TnPhysicsShapeQueryOptions {
  uint32_t shape_type;
  float shape_x;
  float shape_y;
  float shape_z;
  float position_x;
  float position_y;
  float position_z;
  float rotation_x;
  float rotation_y;
  float rotation_z;
  float rotation_w;
  uint32_t collision_mask;
  uint32_t max_results;
} TnPhysicsShapeQueryOptions;

typedef struct TnPhysicsQueryHit {
  uint32_t body_id;
  float position_x;
  float position_y;
  float position_z;
} TnPhysicsQueryHit;

typedef struct TnPhysicsVector3 {
  float x;
  float y;
  float z;
} TnPhysicsVector3;

/** Ray-cast vehicle options; the wheels ride in a separate flat float array.
 *
 * `forward_axis` is the chassis-local forward axis (0 = x, 2 = z) and `axle` is the wheels'
 * chassis-local axle: the vehicle's forward is `up x axle`, so its sign decides which way a
 * positive engine force drives and which way a positive speed means.
 */
typedef struct TnPhysicsVehicleOptions {
  uint32_t id;
  uint32_t body_id;
  uint32_t forward_axis;
  float axle_x;
  float axle_y;
  float axle_z;
  uint32_t wheel_count;
} TnPhysicsVehicleOptions;

/** Floats per wheel: position x/y/z, wheel radius, suspension rest length, suspension
 *  stiffness, damping compression, damping relaxation, friction slip, max suspension travel,
 * use as steering and use as traction. `max_suspension_travel` is always sent, defaulted to
 * Rapier's own 5.0 by the caller, so "absent" and "5.0" cannot drift apart across the ABI. */
enum {
  TN_PHYSICS_VEHICLE_WHEEL_WIDTH = 12,
};

/* Actuation returns 1 on success, 0 for an unknown body, -1 for a non-dynamic body,
 * and -2 for a non-finite vector. */
enum {
  TN_PHYSICS_ACTUATION_OK = 1,
  TN_PHYSICS_ACTUATION_UNKNOWN_BODY = 0,
  TN_PHYSICS_ACTUATION_NOT_DYNAMIC = -1,
  TN_PHYSICS_ACTUATION_NON_FINITE = -2,
};

const char *tn_physics_version(void);
TnPhysicsSimulation *
tn_physics_create(const TnPhysicsWorldOptions *options);
bool tn_physics_add_body(TnPhysicsSimulation *simulation,
                         const TnPhysicsBodyOptions *options);

/**
 * Add a body whose collider is a triangle mesh.
 *
 * `vertices` is a flat `x, y, z` float array of `vertex_floats` elements and `indices` a flat
 * triangle-index array of `index_count` elements. Both are copied into the collider during this
 * call, so the caller's buffers only have to outlive it.
 */
bool tn_physics_add_trimesh_body(TnPhysicsSimulation *simulation,
                                 const TnPhysicsBodyOptions *options,
                                 const float *vertices, uint32_t vertex_floats,
                                 const uint32_t *indices, uint32_t index_count);
/*
 * A fixed heightfield body, and the in-place refresh of one: `heights` holds `rows * columns`
 * samples in column-major order spanning `scale`, centred on the body, copied during the call.
 * The refresh keeps the id, parent body, collision groups and events.
 */
bool tn_physics_add_heightfield_body(TnPhysicsSimulation *simulation,
                                     const TnPhysicsBodyOptions *options,
                                     const float *heights, uint32_t count, uint32_t rows,
                                     uint32_t columns, float scale_x, float scale_y,
                                     float scale_z);
bool tn_physics_set_heightfield_shape(TnPhysicsSimulation *simulation, uint32_t id,
                                      const float *heights, uint32_t count, uint32_t rows,
                                      uint32_t columns, float scale_x, float scale_y,
                                      float scale_z);
int32_t tn_physics_create_joint(TnPhysicsSimulation *simulation,
                                 const TnPhysicsJointOptions *options);
bool tn_physics_remove_joint(TnPhysicsSimulation *simulation, uint32_t id);
bool tn_physics_configure_character(
    TnPhysicsSimulation *simulation,
    const TnPhysicsCharacterOptions *options);
bool tn_physics_remove_body(TnPhysicsSimulation *simulation, uint32_t id);
/** Attach ray-cast wheels to a dynamic chassis and return the vehicle id, or -1 when the
 *  chassis is missing, is not dynamic, or the wheel records are malformed. `wheels` is
 *  `wheel_count` records of `TN_PHYSICS_VEHICLE_WHEEL_WIDTH` floats, copied here, so the
 *  caller's buffer only has to outlive the call. A vehicle lives and dies with its chassis:
 *  `tn_physics_remove_body` releases it. */
int32_t tn_physics_create_vehicle(TnPhysicsSimulation *simulation,
                                  const TnPhysicsVehicleOptions *options,
                                  const float *wheels);
bool tn_physics_set_vehicle_input(TnPhysicsSimulation *simulation, uint32_t id,
                                  float engine_force, float brake, float steering);
/** Writes the signed forward speed followed by contact, suspension length and rotation per
 *  wheel. Returns the number of floats written, or -1 for an unknown vehicle or a short
 *  buffer. */
int32_t tn_physics_read_vehicle_state(const TnPhysicsSimulation *simulation, uint32_t id,
                                      float *output, size_t output_float_capacity);
/** Respawn: move the chassis, face `yaw` radians about up, and drop both velocities. */
bool tn_physics_reset_vehicle(TnPhysicsSimulation *simulation, uint32_t id, float x, float y,
                              float z, float yaw);

bool tn_physics_set_body_transform(TnPhysicsSimulation *simulation, uint32_t id,
                                   float x, float y, float z);
int32_t tn_physics_apply_body_impulse(TnPhysicsSimulation *simulation,
                                      uint32_t id, float x, float y, float z);
int32_t tn_physics_apply_body_force(TnPhysicsSimulation *simulation,
                                    uint32_t id, float x, float y, float z);
int32_t tn_physics_apply_body_force_at_point(
    TnPhysicsSimulation *simulation, uint32_t id, float force_x, float force_y,
    float force_z, float point_x, float point_y, float point_z);
int32_t tn_physics_set_body_linear_velocity(
    TnPhysicsSimulation *simulation, uint32_t id, float x, float y, float z);
int32_t tn_physics_read_body_linear_velocity(
    const TnPhysicsSimulation *simulation, uint32_t id, TnPhysicsVector3 *output);
bool tn_physics_step(TnPhysicsSimulation *simulation, float delta_time,
                     const float *kinematic_transforms,
                     size_t kinematic_record_count);
int32_t tn_physics_read_visible_transforms(
    const TnPhysicsSimulation *simulation, float *output,
    size_t output_float_capacity);
int32_t tn_physics_read_body_sleep_states(
    const TnPhysicsSimulation *simulation, float *output,
    size_t output_float_capacity);
/* Writes eight floats per solved manifold between body `target` and each awake candidate body:
   candidate id, world contact point x/y/z, world normal x/y/z (target toward candidate) and the
   step's summed normal impulse. Returns the total count, which may exceed what `output` holds
   (only that many are written), or -1 for an unknown target or a malformed buffer. */
int32_t tn_physics_read_contacts(const TnPhysicsSimulation *simulation,
                                 uint32_t target, const uint32_t *candidates,
                                 size_t candidate_count, float *output,
                                 size_t output_float_capacity);
/* Writes six floats per character: id, grounded, ground body id (-1 when absent),
   and the world-space ground normal x/y/z. */
int32_t tn_physics_read_character_states(
    const TnPhysicsSimulation *simulation, float *output,
    size_t output_float_capacity);
int32_t tn_physics_read_area_intersections(
    const TnPhysicsSimulation *simulation, uint32_t *output,
    size_t output_u32_capacity);
/* Returns -1 for invalid/unrepresentable arithmetic, 0 for a miss, 1 for a hit. */
int32_t tn_physics_intersect_ray(TnPhysicsSimulation *simulation,
                                 const TnPhysicsRayQuery *query,
                                 TnPhysicsRayHit *output);
int32_t tn_physics_intersect_shape(
    TnPhysicsSimulation *simulation,
    const TnPhysicsShapeQueryOptions *query, TnPhysicsQueryHit *output,
    size_t output_capacity);
int32_t tn_physics_intersect_point(
    TnPhysicsSimulation *simulation, float position_x, float position_y,
    float position_z, uint32_t collision_mask, uint32_t max_results,
    TnPhysicsQueryHit *output, size_t output_capacity);
int32_t tn_physics_drain_collision_events(TnPhysicsSimulation *simulation,
                                          uint32_t *output,
                                          size_t output_u32_capacity);
void tn_physics_destroy(TnPhysicsSimulation *simulation);

#ifdef __cplusplus
}
#endif
