use rapier3d::control::{
    CharacterAutostep, CharacterLength, DynamicRayCastVehicleController, KinematicCharacterController,
    WheelTuning,
};
use rapier3d::na::{DMatrix, Point3, Quaternion, UnitQuaternion};
use rapier3d::prelude::*;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::ptr;
use std::sync::Mutex;

const TRANSFORM_WIDTH: usize = 8;
const SLEEP_STATE_WIDTH: usize = 2;
const EVENT_WIDTH: usize = 4;
const CHARACTER_STATE_WIDTH: usize = 6;
/// `[collider id, world x, y, z, normal x, y, z, impulse]`, the shared `PHYSICS_CONTACT_STRIDE`.
const CONTACT_WIDTH: usize = 8;
/// One float of signed speed, then `PHYSICS_VEHICLE_WHEEL_STRIDE` floats per wheel: contact,
/// suspension length, rotation.
const VEHICLE_SPEED_FLOATS: usize = 1;
const VEHICLE_WHEEL_STRIDE: usize = 3;

#[repr(C)]
pub struct TnPhysicsWorldOptions {
    pub gravity_x: f32,
    pub gravity_y: f32,
    pub gravity_z: f32,
}

#[repr(C)]
pub struct TnPhysicsBodyOptions {
    pub id: u32,
    pub body_type: u32,
    pub shape_type: u32,
    pub position_x: f32,
    pub position_y: f32,
    pub position_z: f32,
    pub rotation_x: f32,
    pub rotation_y: f32,
    pub rotation_z: f32,
    pub rotation_w: f32,
    pub shape_x: f32,
    pub shape_y: f32,
    pub shape_z: f32,
    pub mass: f32,
    pub collision_layer: u32,
    pub collision_mask: u32,
    pub sensor: bool,
    pub continuous_collision: bool,
}

#[repr(C)]
pub struct TnPhysicsJointOptions {
    pub id: u32,
    pub joint_type: u32,
    pub body_a: u32,
    pub body_b: u32,
    pub anchor_a_x: f32,
    pub anchor_a_y: f32,
    pub anchor_a_z: f32,
    pub anchor_b_x: f32,
    pub anchor_b_y: f32,
    pub anchor_b_z: f32,
    pub axis_x: f32,
    pub axis_y: f32,
    pub axis_z: f32,
    pub limit_enabled: bool,
    pub limit_lower: f32,
    pub limit_upper: f32,
    pub frame_a_x: f32,
    pub frame_a_y: f32,
    pub frame_a_z: f32,
    pub frame_a_w: f32,
    pub frame_b_x: f32,
    pub frame_b_y: f32,
    pub frame_b_z: f32,
    pub frame_b_w: f32,
}

#[repr(C)]
pub struct TnPhysicsCharacterOptions {
    pub id: u32,
    pub offset: f32,
    pub max_slope_climb_angle: f32,
    pub autostep_enabled: bool,
    pub autostep_max_height: f32,
    pub autostep_min_width: f32,
    pub autostep_include_dynamic_bodies: bool,
    pub snap_to_ground_enabled: bool,
    pub snap_to_ground: f32,
    pub one_way_layers: u32,
    pub pushes_dynamic_bodies: bool,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct TnPhysicsRayQuery {
    pub from_x: f32,
    pub from_y: f32,
    pub from_z: f32,
    pub to_x: f32,
    pub to_y: f32,
    pub to_z: f32,
    pub collision_mask: u32,
    /// Godot `hit_from_inside`: 0 skips a solid that contains the origin, nonzero reports it.
    pub hit_from_inside: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct TnPhysicsRayHit {
    pub body_id: u32,
    pub position_x: f32,
    pub position_y: f32,
    pub position_z: f32,
    pub normal_x: f32,
    pub normal_y: f32,
    pub normal_z: f32,
    pub distance: f32,
}

#[repr(C)]
pub struct TnPhysicsShapeQueryOptions {
    pub shape_type: u32,
    pub shape_x: f32,
    pub shape_y: f32,
    pub shape_z: f32,
    pub position_x: f32,
    pub position_y: f32,
    pub position_z: f32,
    pub rotation_x: f32,
    pub rotation_y: f32,
    pub rotation_z: f32,
    pub rotation_w: f32,
    pub collision_mask: u32,
    pub max_results: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct TnPhysicsQueryHit {
    pub body_id: u32,
    pub position_x: f32,
    pub position_y: f32,
    pub position_z: f32,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct TnPhysicsVector3 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

/// Floats per wheel in the flat `wheels` array of `tn_physics_create_vehicle`: the attachment
/// point, the four suspension numbers, the tyre, the travel limit, and the two wheel roles.
/// `max_suspension_travel` is always present, defaulted to Rapier's own 5.0 by the caller, so
/// "absent" and "5.0" cannot drift apart across the ABI.
#[repr(C)]
pub struct TnPhysicsVehicleOptions {
    pub id: u32,
    pub body_id: u32,
    /// Chassis-local forward axis: 0 = x, 2 = z.
    pub forward_axis: u32,
    /// Chassis-local wheel axle. The vehicle's forward is `up × axle`, so its sign decides which
    /// way a positive engine force drives and which way a positive speed means.
    pub axle_x: f32,
    pub axle_y: f32,
    pub axle_z: f32,
    pub wheel_count: u32,
}

const VEHICLE_WHEEL_WIDTH: usize = 12;
const WHEEL_RADIUS: usize = 3;
const WHEEL_REST_LENGTH: usize = 4;
const WHEEL_STIFFNESS: usize = 5;
const WHEEL_COMPRESSION: usize = 6;
const WHEEL_RELAXATION: usize = 7;
const WHEEL_FRICTION_SLIP: usize = 8;
const WHEEL_MAX_TRAVEL: usize = 9;
const WHEEL_STEERING: usize = 10;
const WHEEL_TRACTION: usize = 11;

#[derive(Debug, PartialEq, Eq)]
enum RayQueryError {
    InvalidArithmetic,
}

#[derive(Clone)]
struct BodyEntry {
    body: RigidBodyHandle,
    collider: ColliderHandle,
    character: bool,
    sensor: bool,
    shape: SharedShape,
}

#[derive(Clone)]
struct CharacterEntry {
    controller: KinematicCharacterController,
    shape: SharedShape,
    grounded: bool,
    ground_collider: Option<u32>,
    ground_normal: [f32; 3],
    one_way_layers: u32,
    pushes_dynamic_bodies: bool,
}

/// A chassis plus its ray-cast wheels. A vehicle lives and dies with its body: `remove_body`
/// drops every entry whose `body_id` it removed, so a controller can never outlive its chassis.
struct VehicleEntry {
    controller: DynamicRayCastVehicleController,
    body_id: u32,
    /// The chassis' own collision groups, so a wheel ray misses whatever the chassis is masked
    /// against. Rapier 0.30 takes this as a query filter rather than a per-ray argument.
    ray_groups: InteractionGroups,
    rest_lengths: Vec<Real>,
    /// Indices of the wheels that take engine force and the ones that steer.
    traction: Vec<usize>,
    steering: Vec<usize>,
    /// Which way along `forward_axis` a positive engine force drives; see `vehicle_speed`.
    direction: f32,
    forward_axis: usize,
}

#[repr(i32)]
#[derive(Debug, PartialEq, Eq)]
enum ActuationStatus {
    Ok = 1,
    UnknownBody = 0,
    NotDynamic = -1,
    NonFinite = -2,
}

/// Receives the collision events Rapier fires while a step runs, so a transition reaches the
/// game the step it happens instead of being rediscovered by polling every body pair every
/// step. Rapier delivers each started/stopped transition exactly once here; the sink only
/// records the pair and the direction.
#[derive(Default)]
struct CollisionEventCollector {
    transitions: Mutex<Vec<(ColliderHandle, ColliderHandle, bool)>>,
}

impl EventHandler for CollisionEventCollector {
    fn handle_collision_event(
        &self,
        _bodies: &RigidBodySet,
        _colliders: &ColliderSet,
        event: CollisionEvent,
        _contact_pair: Option<&ContactPair>,
    ) {
        let (left, right, started) = match event {
            CollisionEvent::Started(left, right, _) => (left, right, true),
            CollisionEvent::Stopped(left, right, _) => (left, right, false),
        };
        if let Ok(mut transitions) = self.transitions.lock() {
            transitions.push((left, right, started));
        }
    }

    fn handle_contact_force_event(
        &self,
        _dt: Real,
        _bodies: &RigidBodySet,
        _colliders: &ColliderSet,
        _contact_pair: &ContactPair,
        _total_force_magnitude: Real,
    ) {
    }
}

/// A heightfield over `rows` x `columns` samples in the column-major order the web backend hands
/// Rapier (`DMatrix::from_vec`), spanning `scale` and centred on its body, with internal-edge
/// correction so a resting body is not kicked by ghost edges. `None` for malformed input.
fn heightfield_shape(
    heights: *const f32,
    count: u32,
    rows: u32,
    columns: u32,
    scale: [f32; 3],
) -> Option<SharedShape> {
    if heights.is_null() || rows < 2 || columns < 2 || count as u64 != rows as u64 * columns as u64 {
        return None;
    }
    if !scale.iter().all(|value| value.is_finite() && *value > 0.0) {
        return None;
    }
    let samples = unsafe { std::slice::from_raw_parts(heights, count as usize) };
    if !samples.iter().all(|value| value.is_finite()) {
        return None;
    }
    Some(SharedShape::heightfield_with_flags(
        DMatrix::from_vec(rows as usize, columns as usize, samples.to_vec()),
        vector![scale[0], scale[1], scale[2]],
        HeightFieldFlags::FIX_INTERNAL_EDGES,
    ))
}

/// Validate and copy a flat xyz vertex buffer and a flat triangle-index buffer from C.
fn copy_trimesh(
    vertices: *const f32,
    vertex_floats: u32,
    indices: *const u32,
    index_count: u32,
) -> Option<(Vec<Point3<Real>>, Vec<[u32; 3]>)> {
    if vertices.is_null() || indices.is_null() {
        return None;
    }
    let vertex_count = vertex_floats as usize;
    let triangle_vertices = index_count as usize;
    if vertex_count == 0 || vertex_count % 3 != 0 || triangle_vertices == 0 || triangle_vertices % 3 != 0
    {
        return None;
    }
    let floats = unsafe { std::slice::from_raw_parts(vertices, vertex_count) };
    if !floats.iter().all(|value| value.is_finite()) {
        return None;
    }
    let raw_indices = unsafe { std::slice::from_raw_parts(indices, triangle_vertices) };
    let point_count = vertex_count / 3;
    if raw_indices.iter().any(|index| *index as usize >= point_count) {
        return None;
    }
    let points = floats
        .chunks_exact(3)
        .map(|vertex| Point3::new(vertex[0], vertex[1], vertex[2]))
        .collect();
    let triangles = raw_indices
        .chunks_exact(3)
        .map(|triangle| [triangle[0], triangle[1], triangle[2]])
        .collect();
    Some((points, triangles))
}

pub struct Simulation {
    gravity: Vector<Real>,
    pipeline: PhysicsPipeline,
    integration: IntegrationParameters,
    islands: IslandManager,
    broad_phase: BroadPhaseBvh,
    narrow_phase: NarrowPhase,
    bodies: RigidBodySet,
    colliders: ColliderSet,
    impulse_joints: ImpulseJointSet,
    multibody_joints: MultibodyJointSet,
    ccd: CCDSolver,
    entries: BTreeMap<u32, BodyEntry>,
    joints: BTreeMap<u32, ImpulseJointHandle>,
    characters: BTreeMap<u32, CharacterEntry>,
    vehicles: BTreeMap<u32, VehicleEntry>,
    collision_events: CollisionEventCollector,
    events: VecDeque<[u32; EVENT_WIDTH]>,
    query_dirty: bool,
}

impl Simulation {
    fn new(options: TnPhysicsWorldOptions) -> Option<Self> {
        if ![options.gravity_x, options.gravity_y, options.gravity_z]
            .into_iter()
            .all(f32::is_finite)
        {
            return None;
        }
        Some(Self {
            gravity: vector![options.gravity_x, options.gravity_y, options.gravity_z],
            pipeline: PhysicsPipeline::new(),
            integration: IntegrationParameters::default(),
            islands: IslandManager::new(),
            broad_phase: BroadPhaseBvh::new(),
            narrow_phase: NarrowPhase::new(),
            bodies: RigidBodySet::new(),
            colliders: ColliderSet::new(),
            impulse_joints: ImpulseJointSet::new(),
            multibody_joints: MultibodyJointSet::new(),
            ccd: CCDSolver::new(),
            entries: BTreeMap::new(),
            joints: BTreeMap::new(),
            characters: BTreeMap::new(),
            vehicles: BTreeMap::new(),
            collision_events: CollisionEventCollector::default(),
            events: VecDeque::new(),
            query_dirty: true,
        })
    }

    fn add_body(&mut self, options: TnPhysicsBodyOptions) -> bool {
        let collider = match options.shape_type {
            0 if options.shape_x > 0.0 && options.shape_y > 0.0 && options.shape_z > 0.0 => {
                ColliderBuilder::cuboid(options.shape_x, options.shape_y, options.shape_z)
            }
            1 if options.shape_x > 0.0 => ColliderBuilder::ball(options.shape_x),
            2 if options.shape_x >= 0.0 && options.shape_y > 0.0 => {
                ColliderBuilder::capsule_y(options.shape_x, options.shape_y)
            }
            _ => return false,
        };
        self.insert_body(options, collider)
    }

    /// A triangle mesh, the only concave shape a static level needs. Rapier refuses a degenerate
    /// mesh with an error rather than panicking, so a bad import fails closed.
    fn add_trimesh_body(
        &mut self,
        options: TnPhysicsBodyOptions,
        vertices: Vec<Point3<Real>>,
        indices: Vec<[u32; 3]>,
    ) -> bool {
        let Ok(collider) = ColliderBuilder::trimesh_with_flags(
            vertices,
            indices,
            TriMeshFlags::FIX_INTERNAL_EDGES,
        ) else {
            return false;
        };
        self.insert_body(options, collider)
    }

    /// Replace one body's collider shape in place: same handle, parent, groups and events.
    /// Bodies sleeping on it wake, since the new surface may no longer hold them up.
    fn set_collider_shape(&mut self, id: u32, shape: SharedShape) -> bool {
        let Some(entry) = self.entries.get_mut(&id) else {
            return false;
        };
        let Some(collider) = self.colliders.get_mut(entry.collider) else {
            return false;
        };
        // Rapier wakes the bodies touching a collider whose shape changed; the test holds it to that.
        collider.set_shape(shape.clone());
        entry.shape = shape;
        self.query_dirty = true;
        true
    }

    /// One record per solved manifold between `target` and each awake candidate. Returns the total
    /// count; records past `output`'s capacity are counted but not written, so a caller can grow
    /// its buffer and read again instead of losing a contact.
    fn read_contacts(&self, target: u32, candidates: &[u32], output: &mut [f32]) -> Option<usize> {
        let target_collider = self.entries.get(&target)?.collider;
        let capacity = output.len() / CONTACT_WIDTH;
        let mut count = 0;
        for &id in candidates {
            if id == target {
                continue;
            }
            let Some(entry) = self.entries.get(&id) else {
                continue;
            };
            // A sleeping body was not solved this step, so its stored impulses are not this step's.
            if self.bodies.get(entry.body).is_none_or(|body| body.is_sleeping()) {
                continue;
            }
            let Some(pair) = self.narrow_phase.contact_pair(target_collider, entry.collider) else {
                continue;
            };
            let sign = if pair.collider1 == target_collider { 1.0 } else { -1.0 };
            for manifold in &pair.manifolds {
                let solved = manifold.data.solver_contacts.len();
                if solved == 0 {
                    continue;
                }
                if count < capacity {
                    let impulse: Real = manifold.points.iter().map(|point| point.data.impulse).sum();
                    let mut centre = Vector::zeros();
                    for contact in &manifold.data.solver_contacts {
                        centre += contact.point.coords;
                    }
                    centre /= solved as Real;
                    let normal = manifold.data.normal * sign;
                    output[count * CONTACT_WIDTH..(count + 1) * CONTACT_WIDTH].copy_from_slice(&[
                        id as f32, centre.x, centre.y, centre.z, normal.x, normal.y, normal.z,
                        impulse,
                    ]);
                }
                count += 1;
            }
        }
        Some(count)
    }

    fn insert_body(&mut self, options: TnPhysicsBodyOptions, collider: ColliderBuilder) -> bool {
        let finite = [
            options.position_x,
            options.position_y,
            options.position_z,
            options.rotation_x,
            options.rotation_y,
            options.rotation_z,
            options.rotation_w,
            options.shape_x,
            options.shape_y,
            options.shape_z,
            options.mass,
        ]
        .into_iter()
        .all(f32::is_finite);
        let quaternion_norm = options.rotation_x * options.rotation_x
            + options.rotation_y * options.rotation_y
            + options.rotation_z * options.rotation_z
            + options.rotation_w * options.rotation_w;
        if !finite
            || quaternion_norm <= f32::EPSILON
            || self.entries.contains_key(&options.id)
            || options.mass < 0.0
        {
            return false;
        }
        let Some(layer) = Group::from_bits(options.collision_layer) else {
            return false;
        };
        let Some(mask) = Group::from_bits(options.collision_mask) else {
            return false;
        };
        let position = Isometry::from_parts(
            Translation::new(options.position_x, options.position_y, options.position_z),
            UnitQuaternion::new_normalize(Quaternion::new(
                options.rotation_w,
                options.rotation_x,
                options.rotation_y,
                options.rotation_z,
            )),
        );
        let mut body = match options.body_type {
            0 => RigidBodyBuilder::dynamic(),
            1 => RigidBodyBuilder::fixed(),
            2 | 3 => RigidBodyBuilder::kinematic_position_based(),
            _ => return false,
        }
        .pose(position);
        if options.body_type == 0 {
            body = body.ccd_enabled(options.continuous_collision);
        }
        let body = self.bodies.insert(body);
        // Explicit mass is the body's total mass, not a bonus on top of the collider's
        // density-derived mass. Zero keeps the automatic collider mass.
        let mut collider = collider
            .collision_groups(InteractionGroups::new(layer, mask))
            .sensor(options.sensor);
        if options.mass > 0.0 {
            collider = collider.mass(options.mass);
        }
        collider = collider.active_events(ActiveEvents::COLLISION_EVENTS);
        let shape = collider.shape.clone();
        let collider = self
            .colliders
            .insert_with_parent(collider, body, &mut self.bodies);
        self.entries.insert(
            options.id,
            BodyEntry {
                body,
                collider,
                character: options.body_type == 3,
                sensor: options.sensor,
                shape,
            },
        );
        self.query_dirty = true;
        true
    }

    fn configure_character(&mut self, options: TnPhysicsCharacterOptions) -> bool {
        if ![
            options.offset,
            options.max_slope_climb_angle,
            options.autostep_max_height,
            options.autostep_min_width,
            options.snap_to_ground,
        ]
        .into_iter()
        .all(f32::is_finite)
            || options.offset <= 0.0
            || options.max_slope_climb_angle < 0.0
            || (options.autostep_enabled
                && (options.autostep_max_height <= 0.0 || options.autostep_min_width <= 0.0))
            || (options.snap_to_ground_enabled && options.snap_to_ground <= 0.0)
            || !self
                .entries
                .get(&options.id)
                .is_some_and(|entry| entry.character)
        {
            return false;
        }
        let character_shape = self.entries[&options.id].shape.clone();
        let mut controller = KinematicCharacterController {
            offset: CharacterLength::Absolute(options.offset),
            max_slope_climb_angle: options.max_slope_climb_angle,
            snap_to_ground: options
                .snap_to_ground_enabled
                .then_some(CharacterLength::Absolute(options.snap_to_ground)),
            ..KinematicCharacterController::default()
        };
        controller.autostep = options.autostep_enabled.then_some(CharacterAutostep {
            max_height: CharacterLength::Absolute(options.autostep_max_height),
            min_width: CharacterLength::Absolute(options.autostep_min_width),
            include_dynamic_bodies: options.autostep_include_dynamic_bodies,
        });
        self.characters.insert(
            options.id,
            CharacterEntry {
                controller,
                shape: character_shape,
                grounded: false,
                ground_collider: None,
                ground_normal: [0.0, 1.0, 0.0],
                one_way_layers: options.one_way_layers,
                pushes_dynamic_bodies: options.pushes_dynamic_bodies,
            },
        );
        true
    }

    /// Attach ray-cast wheels to a dynamic chassis. `wheels` is `wheel_count` records of
    /// `VEHICLE_WHEEL_WIDTH` floats, copied into the controllers during this call.
    fn create_vehicle(&mut self, options: TnPhysicsVehicleOptions, wheels: &[f32]) -> bool {
        if options.forward_axis != 0 && options.forward_axis != 2 {
            return false;
        }
        let forward_axis = options.forward_axis as usize;
        let Some(entry) = self.entries.get(&options.body_id).cloned() else {
            return false;
        };
        if !self.bodies[entry.body].is_dynamic() {
            return false;
        }
        let wheel_count = options.wheel_count as usize;
        if wheel_count == 0 || wheels.len() != wheel_count * VEHICLE_WHEEL_WIDTH {
            return false;
        }
        if !wheels.iter().all(|value| value.is_finite())
            || ![options.axle_x, options.axle_y, options.axle_z]
                .into_iter()
                .all(f32::is_finite)
        {
            return false;
        }
        if wheels
            .chunks_exact(VEHICLE_WHEEL_WIDTH)
            .any(|wheel| wheel[WHEEL_RADIUS] <= 0.0 || wheel[WHEEL_REST_LENGTH] <= 0.0)
        {
            return false;
        }
        let mut controller = DynamicRayCastVehicleController::new(entry.body);
        controller.index_up_axis = 1;
        controller.index_forward_axis = forward_axis;
        let axle = vector![options.axle_x, options.axle_y, options.axle_z];
        let mut rest_lengths = Vec::with_capacity(wheel_count);
        let mut traction = Vec::new();
        let mut steering = Vec::new();
        for (index, wheel) in wheels.chunks_exact(VEHICLE_WHEEL_WIDTH).enumerate() {
            let tuning = WheelTuning {
                suspension_stiffness: wheel[WHEEL_STIFFNESS],
                suspension_compression: wheel[WHEEL_COMPRESSION],
                suspension_damping: wheel[WHEEL_RELAXATION],
                max_suspension_travel: wheel[WHEEL_MAX_TRAVEL],
                friction_slip: wheel[WHEEL_FRICTION_SLIP],
                ..WheelTuning::default()
            };
            // The role flags are 0/1 floats on the wire; anything non-zero counts as set.
            if wheel[WHEEL_STEERING] > 0.0 {
                steering.push(index);
            }
            if wheel[WHEEL_TRACTION] > 0.0 {
                traction.push(index);
            }
            rest_lengths.push(wheel[WHEEL_REST_LENGTH]);
            controller.add_wheel(
                point![wheel[0], wheel[1], wheel[2]],
                vector![0.0, -1.0, 0.0],
                axle,
                wheel[WHEEL_REST_LENGTH],
                wheel[WHEEL_RADIUS],
                &tuning,
            );
        }
        // The engine force follows `up × axle`, so that is also the direction a positive speed
        // means. This is the web adapter's rule, unchanged.
        let axle_component = if forward_axis == 2 {
            options.axle_x
        } else {
            options.axle_z
        };
        let forward_component = if forward_axis == 2 {
            -axle_component
        } else {
            axle_component
        };
        self.vehicles.insert(
            options.id,
            VehicleEntry {
                controller,
                body_id: options.body_id,
                ray_groups: self.colliders[entry.collider].collision_groups(),
                rest_lengths,
                traction,
                steering,
                direction: if forward_component < 0.0 { -1.0 } else { 1.0 },
                forward_axis,
            },
        );
        true
    }

    fn set_vehicle_input(
        &mut self,
        id: u32,
        engine_force: f32,
        brake: f32,
        steering_angle: f32,
    ) -> bool {
        if ![engine_force, brake, steering_angle]
            .into_iter()
            .all(f32::is_finite)
        {
            return false;
        }
        let Some(vehicle) = self.vehicles.get_mut(&id) else {
            return false;
        };
        let wheels = vehicle.controller.wheels_mut();
        for wheel in &vehicle.traction {
            wheels[*wheel].engine_force = engine_force;
        }
        for wheel in &vehicle.steering {
            wheels[*wheel].steering = steering_angle;
        }
        for wheel in wheels.iter_mut() {
            wheel.brake = brake;
        }
        true
    }

    /// Signed metres per second along the vehicle's own forward axis.
    ///
    /// Rapier's `current_vehicle_speed()` is not this: it follows the positive forward axis
    /// regardless of which way the car drives, and on a settled car it reports the suspension's
    /// residual vertical velocity. Rotating the chassis velocity into the chassis frame and taking
    /// the forward component is the number the shared seam names, on both backends.
    fn vehicle_speed(&self, vehicle: &VehicleEntry) -> f32 {
        let Some(entry) = self.entries.get(&vehicle.body_id) else {
            return 0.0;
        };
        let body = &self.bodies[entry.body];
        let local = body.rotation().inverse_transform_vector(body.linvel());
        let forward = if vehicle.forward_axis == 2 {
            local.z
        } else {
            local.x
        };
        (forward * vehicle.direction) as f32
    }

    /// Writes the signed speed followed by contact, suspension length and rotation per wheel.
    fn write_vehicle_state(&self, id: u32, output: &mut [f32]) -> Option<usize> {
        let vehicle = self.vehicles.get(&id)?;
        let wheels = vehicle.controller.wheels();
        let required = VEHICLE_SPEED_FLOATS + VEHICLE_WHEEL_STRIDE * wheels.len();
        if output.len() < required {
            return None;
        }
        output[0] = self.vehicle_speed(vehicle);
        for (index, wheel) in wheels.iter().enumerate() {
            let info = wheel.raycast_info();
            let offset = VEHICLE_SPEED_FLOATS + VEHICLE_WHEEL_STRIDE * index;
            output[offset] = if info.is_in_contact { 1.0 } else { 0.0 };
            output[offset + 1] = info.suspension_length;
            output[offset + 2] = wheel.rotation;
        }
        Some(required)
    }

    /// Respawn: move the chassis, face `yaw` radians about up, and drop both velocities.
    fn reset_vehicle(&mut self, id: u32, x: f32, y: f32, z: f32, yaw: f32) -> bool {
        if ![x, y, z, yaw].into_iter().all(f32::is_finite) {
            return false;
        }
        let Some(vehicle) = self.vehicles.get(&id) else {
            return false;
        };
        let Some(entry) = self.entries.get(&vehicle.body_id).cloned() else {
            return false;
        };
        let body = &mut self.bodies[entry.body];
        if !body.is_dynamic() {
            return false;
        }
        body.set_translation(vector![x, y, z], true);
        // Godot's yaw is a turn about up: (0, sin(yaw / 2), 0, cos(yaw / 2)) in w, x, y, z order.
        body.set_rotation(
            UnitQuaternion::new_normalize(Quaternion::new(
                (yaw * 0.5).cos(),
                0.0,
                (yaw * 0.5).sin(),
                0.0,
            )),
            true,
        );
        body.set_linvel(Vector::zeros(), true);
        body.set_angvel(Vector::zeros(), true);
        self.bodies
            .propagate_modified_body_positions_to_colliders(&mut self.colliders);
        self.query_dirty = true;
        true
    }

    fn remove_body(&mut self, id: u32) -> bool {
        let Some(entry) = self.entries.remove(&id) else {
            return false;
        };
        self.bodies.remove(
            entry.body,
            &mut self.islands,
            &mut self.colliders,
            &mut self.impulse_joints,
            &mut self.multibody_joints,
            true,
        );
        self.characters.remove(&id);
        self.vehicles.retain(|_, vehicle| vehicle.body_id != id);
        self.joints
            .retain(|_, handle| self.impulse_joints.contains(*handle));
        self.query_dirty = true;
        true
    }

    fn create_joint(&mut self, options: TnPhysicsJointOptions) -> bool {
        if self.joints.contains_key(&options.id)
            || options.body_a == options.body_b
            || !self.entries.contains_key(&options.body_a)
            || !self.entries.contains_key(&options.body_b)
        {
            return false;
        }
        let finite = [
            options.anchor_a_x,
            options.anchor_a_y,
            options.anchor_a_z,
            options.anchor_b_x,
            options.anchor_b_y,
            options.anchor_b_z,
            options.axis_x,
            options.axis_y,
            options.axis_z,
            options.limit_lower,
            options.limit_upper,
            options.frame_a_x,
            options.frame_a_y,
            options.frame_a_z,
            options.frame_a_w,
            options.frame_b_x,
            options.frame_b_y,
            options.frame_b_z,
            options.frame_b_w,
        ]
        .into_iter()
        .all(f32::is_finite);
        if !finite
            || (options.limit_enabled && options.limit_lower > options.limit_upper)
        {
            return false;
        }
        if options.joint_type == 2 {
            let frame_a_length = options.frame_a_x * options.frame_a_x
                + options.frame_a_y * options.frame_a_y
                + options.frame_a_z * options.frame_a_z
                + options.frame_a_w * options.frame_a_w;
            let frame_b_length = options.frame_b_x * options.frame_b_x
                + options.frame_b_y * options.frame_b_y
                + options.frame_b_z * options.frame_b_z
                + options.frame_b_w * options.frame_b_w;
            if frame_a_length <= f32::EPSILON || frame_b_length <= f32::EPSILON {
                return false;
            }
        }
        let anchor_a = point![options.anchor_a_x, options.anchor_a_y, options.anchor_a_z];
        let anchor_b = point![options.anchor_b_x, options.anchor_b_y, options.anchor_b_z];
        let data: GenericJoint = match options.joint_type {
            0 => SphericalJointBuilder::new()
                .local_anchor1(anchor_a)
                .local_anchor2(anchor_b)
                .build()
                .into(),
            1 => {
                let Some(axis) = UnitVector::try_new(
                    vector![options.axis_x, options.axis_y, options.axis_z],
                    f32::EPSILON,
                ) else {
                    return false;
                };
                let mut builder = RevoluteJointBuilder::new(axis)
                    .local_anchor1(anchor_a)
                    .local_anchor2(anchor_b);
                if options.limit_enabled {
                    builder = builder.limits([options.limit_lower, options.limit_upper]);
                }
                builder.build().into()
            }
            2 => {
                let frame_a = Isometry::from_parts(
                    Translation::from(anchor_a.coords),
                    UnitQuaternion::new_normalize(Quaternion::new(
                        options.frame_a_w,
                        options.frame_a_x,
                        options.frame_a_y,
                        options.frame_a_z,
                    )),
                );
                let frame_b = Isometry::from_parts(
                    Translation::from(anchor_b.coords),
                    UnitQuaternion::new_normalize(Quaternion::new(
                        options.frame_b_w,
                        options.frame_b_x,
                        options.frame_b_y,
                        options.frame_b_z,
                    )),
                );
                FixedJointBuilder::new()
                    .local_frame1(frame_a)
                    .local_frame2(frame_b)
                    .build()
                    .into()
            }
            _ => return false,
        };
        let body_a = self.entries[&options.body_a].body;
        let body_b = self.entries[&options.body_b].body;
        let handle = self.impulse_joints.insert(body_a, body_b, data, true);
        self.joints.insert(options.id, handle);
        true
    }

    fn remove_joint(&mut self, id: u32) -> bool {
        let Some(handle) = self.joints.remove(&id) else {
            return false;
        };
        self.impulse_joints.remove(handle, true).is_some()
    }

    fn set_body_transform(&mut self, id: u32, x: f32, y: f32, z: f32) -> bool {
        if ![x, y, z].into_iter().all(f32::is_finite) {
            return false;
        }
        let Some(entry) = self.entries.get(&id) else {
            return false;
        };
        let body = &mut self.bodies[entry.body];
        body.set_translation(vector![x, y, z], true);
        body.set_next_kinematic_translation(vector![x, y, z]);
        self.bodies
            .propagate_modified_body_positions_to_colliders(&mut self.colliders);
        self.query_dirty = true;
        true
    }

    fn apply_body_impulse(&mut self, id: u32, x: f32, y: f32, z: f32) -> ActuationStatus {
        if ![x, y, z].into_iter().all(f32::is_finite) {
            return ActuationStatus::NonFinite;
        }
        let Some(entry) = self.entries.get(&id).cloned() else {
            return ActuationStatus::UnknownBody;
        };
        let body = &mut self.bodies[entry.body];
        if !body.is_dynamic() {
            return ActuationStatus::NotDynamic;
        }
        body.apply_impulse(vector![x, y, z], true);
        ActuationStatus::Ok
    }

    fn apply_body_force(&mut self, id: u32, x: f32, y: f32, z: f32) -> ActuationStatus {
        if ![x, y, z].into_iter().all(f32::is_finite) {
            return ActuationStatus::NonFinite;
        }
        let Some(entry) = self.entries.get(&id).cloned() else {
            return ActuationStatus::UnknownBody;
        };
        let body = &mut self.bodies[entry.body];
        if !body.is_dynamic() {
            return ActuationStatus::NotDynamic;
        }
        body.add_force(vector![x, y, z], true);
        ActuationStatus::Ok
    }

    fn apply_body_force_at_point(
        &mut self,
        id: u32,
        force_x: f32,
        force_y: f32,
        force_z: f32,
        point_x: f32,
        point_y: f32,
        point_z: f32,
    ) -> ActuationStatus {
        if ![force_x, force_y, force_z, point_x, point_y, point_z]
            .into_iter()
            .all(f32::is_finite)
        {
            return ActuationStatus::NonFinite;
        }
        let Some(entry) = self.entries.get(&id).cloned() else {
            return ActuationStatus::UnknownBody;
        };
        let body = &mut self.bodies[entry.body];
        if !body.is_dynamic() {
            return ActuationStatus::NotDynamic;
        }
        body.add_force_at_point(
            vector![force_x, force_y, force_z],
            point![point_x, point_y, point_z],
            true,
        );
        ActuationStatus::Ok
    }

    fn set_body_linear_velocity(&mut self, id: u32, x: f32, y: f32, z: f32) -> ActuationStatus {
        if ![x, y, z].into_iter().all(f32::is_finite) {
            return ActuationStatus::NonFinite;
        }
        let Some(entry) = self.entries.get(&id).cloned() else {
            return ActuationStatus::UnknownBody;
        };
        let body = &mut self.bodies[entry.body];
        if !body.is_dynamic() {
            return ActuationStatus::NotDynamic;
        }
        body.set_linvel(vector![x, y, z], true);
        ActuationStatus::Ok
    }

    fn read_body_linear_velocity(&self, id: u32, output: &mut TnPhysicsVector3) -> ActuationStatus {
        let Some(entry) = self.entries.get(&id) else {
            return ActuationStatus::UnknownBody;
        };
        let body = &self.bodies[entry.body];
        if !body.is_dynamic() {
            return ActuationStatus::NotDynamic;
        }
        let velocity = body.linvel();
        output.x = velocity.x;
        output.y = velocity.y;
        output.z = velocity.z;
        ActuationStatus::Ok
    }

    fn apply_kinematic(&mut self, values: &[f32], delta_time: f32) -> bool {
        if values.len() % TRANSFORM_WIDTH != 0 || !values.iter().all(|value| value.is_finite()) {
            return false;
        }
        for record in values.chunks_exact(TRANSFORM_WIDTH) {
            let id_value = record[0];
            if id_value < 0.0 || id_value.fract() != 0.0 || id_value > u32::MAX as f32 {
                return false;
            }
            let id = id_value as u32;
            let Some(entry) = self.entries.get(&id).cloned() else {
                return false;
            };
            let rotation_norm = record[4] * record[4]
                + record[5] * record[5]
                + record[6] * record[6]
                + record[7] * record[7];
            if rotation_norm <= f32::EPSILON {
                return false;
            }
            let target = vector![record[1], record[2], record[3]];
            let rotation = UnitQuaternion::new_normalize(Quaternion::new(
                record[7], record[4], record[5], record[6],
            ));
            if entry.character {
                let Some(character) = self.characters.get(&id).cloned() else {
                    return false;
                };
                let body = &self.bodies[entry.body];
                let desired = target - body.translation();
                let upward = desired.y > 0.0;
                let one_way_layers = character.one_way_layers;
                let groups = self.colliders[entry.collider].collision_groups();
                let predicate = |_: ColliderHandle, collider: &Collider| {
                    !collider.is_sensor()
                        && (!upward
                            || (collider.collision_groups().memberships.bits() & one_way_layers)
                                == 0)
                };
                let filter = QueryFilter {
                    flags: QueryFilterFlags::EXCLUDE_SENSORS,
                    groups: Some(groups),
                    exclude_rigid_body: Some(entry.body),
                    predicate: Some(&predicate),
                    ..QueryFilter::default()
                };
                let query = self.broad_phase.as_query_pipeline(
                    self.narrow_phase.query_dispatcher(),
                    &self.bodies,
                    &self.colliders,
                    filter,
                );
                let collider_ids: HashMap<ColliderHandle, u32> = self
                    .entries
                    .iter()
                    .map(|(body_id, body_entry)| (body_entry.collider, *body_id))
                    .collect();
                let mut ground_collider = None;
                let mut ground_normal = None;
                // Rapier flags ground at any positive up component. Contacts that are all steeper
                // than 60 degrees from up mean a wall, matching the web backend; a snap-to-ground
                // step records no contact and keeps Rapier's answer.
                let mut walkable = false;
                let mut contacts = 0u32;
                let mut collisions = Vec::new();
                let movement = character.controller.move_shape(
                    delta_time,
                    &query,
                    character.shape.as_ref(),
                    body.position(),
                    desired,
                    |collision| {
                        contacts += 1;
                        if collision.hit.normal1.y >= 0.5 {
                            walkable = true;
                            ground_collider = collider_ids.get(&collision.handle).copied();
                            ground_normal = Some([
                                collision.hit.normal1.x,
                                collision.hit.normal1.y,
                                collision.hit.normal1.z,
                            ]);
                        }
                        if character.pushes_dynamic_bodies {
                            collisions.push(collision);
                        }
                    },
                );
                if character.pushes_dynamic_bodies && !collisions.is_empty() {
                    let mut query = self.broad_phase.as_query_pipeline_mut(
                        self.narrow_phase.query_dispatcher(),
                        &mut self.bodies,
                        &mut self.colliders,
                        filter,
                    );
                    let character_mass = query.bodies[entry.body].mass();
                    character.controller.solve_character_collision_impulses(
                        delta_time,
                        &mut query,
                        character.shape.as_ref(),
                        character_mass,
                        collisions.iter(),
                    );
                }
                let body = &mut self.bodies[entry.body];
                let current = *body.translation();
                body.set_next_kinematic_translation(current + movement.translation);
                body.set_next_kinematic_rotation(rotation);
                let state = self.characters.get_mut(&id).expect("character was checked");
                // Standing still on a floor while pressing a wall records only the wall; the floor
                // held the downward step in place, so Rapier's answer stands, as on the web backend.
                let held = desired.y < -1e-4 && movement.translation.y.abs() < 1e-4;
                let grounded = movement.grounded && (walkable || contacts == 0 || held);
                state.grounded = grounded;
                state.ground_collider = ground_collider
                    .or_else(|| grounded.then_some(state.ground_collider).flatten());
                state.ground_normal = ground_normal.unwrap_or_else(|| {
                    if grounded {
                        state.ground_normal
                    } else {
                        [0.0, 1.0, 0.0]
                    }
                });
            } else {
                let body = &mut self.bodies[entry.body];
                if !body.is_kinematic() {
                    return false;
                }
                body.set_next_kinematic_translation(target);
                body.set_next_kinematic_rotation(rotation);
            }
        }
        true
    }

    fn step(&mut self, delta_time: f32, kinematic: &[f32]) -> bool {
        if !delta_time.is_finite()
            || delta_time <= 0.0
            || !self.apply_kinematic(kinematic, delta_time)
        {
            return false;
        }
        self.update_vehicles(delta_time);
        self.integration.dt = delta_time;
        self.pipeline.step(
            &self.gravity,
            &self.integration,
            &mut self.islands,
            &mut self.broad_phase,
            &mut self.narrow_phase,
            &mut self.bodies,
            &mut self.colliders,
            &mut self.impulse_joints,
            &mut self.multibody_joints,
            &mut self.ccd,
            &(),
            &self.collision_events,
        );
        // Rapier retains accumulated forces and torques unless the caller clears them. The
        // JavaScript seam promises a force for one fixed step (an off-centre one adds a torque),
        // so keep the native backend identical to web.
        for entry in self.entries.values() {
            self.bodies[entry.body].reset_forces(true);
            self.bodies[entry.body].reset_torques(true);
        }
        // Rapier delivered the started/stopped transitions while the step ran; translate
        // collider handles back to body ids exactly the way the web path does
        // (`packages/physics/src/simulation.ts` maps through `byCollider` and drops events
        // whose colliders no longer resolve to a body, which is also what removal does).
        let transitions = self
            .collision_events
            .transitions
            .lock()
            .map(|mut transitions| std::mem::take(&mut *transitions))
            .unwrap_or_default();
        if !transitions.is_empty() {
            let collider_ids: HashMap<ColliderHandle, u32> = self
                .entries
                .iter()
                .map(|(id, entry)| (entry.collider, *id))
                .collect();
            for (left, right, started) in transitions {
                let (Some(left_id), Some(right_id)) =
                    (collider_ids.get(&left), collider_ids.get(&right))
                else {
                    continue;
                };
                let (smaller, larger) = if left_id <= right_id {
                    (*left_id, *right_id)
                } else {
                    (*right_id, *left_id)
                };
                self.events.push_back([smaller, larger, u32::from(started), 1]);
            }
        }
        self.query_dirty = false;
        true
    }

    /// Ray-cast the wheels and write the chassis' velocity, before the solver runs — the same
    /// order the web adapter uses, and the only place a vehicle can be stepped.
    fn update_vehicles(&mut self, delta_time: f32) {
        let delta_time = delta_time as Real;
        // The vehicle map is borrowed per iteration rather than across it, because
        // `update_vehicle` needs `&mut` on the body and collider sets it also holds.
        for id in self.vehicles.keys().copied().collect::<Vec<_>>() {
            let Some((chassis, ray_groups)) = self
                .vehicles
                .get(&id)
                .map(|vehicle| (vehicle.controller.chassis, vehicle.ray_groups))
            else {
                continue;
            };
            {
                // The chassis' own groups, exactly as the web adapter passes them: a wheel ray
                // misses whatever the chassis itself is masked against. The chassis is also
                // excluded outright, because a wheel ray starts inside the chassis box and Rapier
                // 0.30 reports that as a hit at zero distance, which reads as a fully compressed
                // strut and launches the car. Rapier 0.19.3 missed the same ray on its own; a
                // vehicle must never stand on itself. Sensors are excluded for the same reason the
                // web adapter excludes them: an `Area3D` is a trigger volume, and a wheel that
                // rests on the finish-line gate reads a fully compressed strut and is thrown into
                // the air. A trigger volume is never ground.
                let filter = QueryFilter {
                    groups: Some(ray_groups),
                    exclude_rigid_body: Some(chassis),
                    flags: QueryFilterFlags::EXCLUDE_SENSORS,
                    ..QueryFilter::default()
                };
                let queries = self.broad_phase.as_query_pipeline_mut(
                    self.narrow_phase.query_dispatcher(),
                    &mut self.bodies,
                    &mut self.colliders,
                    filter,
                );
                if let Some(vehicle) = self.vehicles.get_mut(&id) {
                    vehicle.controller.update_vehicle(delta_time, queries);
                }
            }
            // A loaded wheel is holding the car up, and `update_vehicle` writes velocity rather
            // than impulses. Rapier skips a sleeping body, so a car that dozed off mid-drop would
            // hang in the air for good; only an unloaded car is left alone to sleep.
            let loaded = self.vehicles[&id]
                .controller
                .wheels()
                .iter()
                .enumerate()
                .any(|(index, wheel)| {
                    let info = wheel.raycast_info();
                    info.is_in_contact
                        && info.suspension_length < self.vehicles[&id].rest_lengths[index]
                });
            if loaded && self.bodies.contains(chassis) {
                self.bodies[chassis].wake_up(true);
            }
        }
    }

    fn refresh_query_pipeline(&mut self) {
        if !self.query_dirty {
            return;
        }
        let modified: Vec<_> = self.entries.values().map(|entry| entry.collider).collect();
        let mut events = Vec::new();
        self.broad_phase.update(
            &self.integration,
            &self.colliders,
            &self.bodies,
            &modified,
            &[],
            &mut events,
        );
        self.query_dirty = false;
    }

    fn write_character_states(&self, output: &mut [f32]) -> Option<usize> {
        if output.len() < self.characters.len() * CHARACTER_STATE_WIDTH {
            return None;
        }
        for (index, (id, character)) in self.characters.iter().enumerate() {
            let offset = index * CHARACTER_STATE_WIDTH;
            output[offset] = *id as f32;
            output[offset + 1] = if character.grounded { 1.0 } else { 0.0 };
            output[offset + 2] = character
                .ground_collider
                .map_or(-1.0, |collider| collider as f32);
            output[offset + 3] = character.ground_normal[0];
            output[offset + 4] = character.ground_normal[1];
            output[offset + 5] = character.ground_normal[2];
        }
        Some(self.characters.len())
    }

    fn area_intersections(&self) -> Vec<[u32; 2]> {
        let collider_ids: HashMap<ColliderHandle, u32> = self
            .entries
            .iter()
            .map(|(body_id, body_entry)| (body_entry.collider, *body_id))
            .collect();
        let mut pairs = Vec::new();
        for (area_id, area) in self.entries.iter().filter(|(_, entry)| entry.sensor) {
            let area_collider = &self.colliders[area.collider];
            let area_mask = area_collider.collision_groups().filter.bits();
            let predicate = |handle: ColliderHandle, collider: &Collider| {
                handle != area.collider
                    && !collider.is_sensor()
                    && (collider.collision_groups().memberships.bits() & area_mask) != 0
            };
            let filter = QueryFilter {
                predicate: Some(&predicate),
                ..QueryFilter::default()
            };
            let query = self.broad_phase.as_query_pipeline(
                self.narrow_phase.query_dispatcher(),
                &self.bodies,
                &self.colliders,
                filter,
            );
            for (collider, _) in
                query.intersect_shape(*area_collider.position(), area_collider.shape())
            {
                if let Some(body_id) = collider_ids.get(&collider) {
                    pairs.push([*area_id, *body_id]);
                }
            }
        }
        pairs
    }

    fn intersect_ray(
        &mut self,
        query: TnPhysicsRayQuery,
    ) -> Result<Option<TnPhysicsRayHit>, RayQueryError> {
        self.refresh_query_pipeline();
        let direction = vector![
            query.to_x - query.from_x,
            query.to_y - query.from_y,
            query.to_z - query.from_z
        ];
        let scale = direction
            .x
            .abs()
            .max(direction.y.abs())
            .max(direction.z.abs());
        if !scale.is_finite() || scale == 0.0 {
            return Err(RayQueryError::InvalidArithmetic);
        }
        let scaled_direction = direction / scale;
        let scaled_distance = scaled_direction.norm();
        if !scaled_distance.is_finite() || scaled_distance == 0.0 {
            return Err(RayQueryError::InvalidArithmetic);
        }
        let distance = scale * scaled_distance;
        if !distance.is_finite() || distance == 0.0 {
            return Err(RayQueryError::InvalidArithmetic);
        }
        let ray = Ray::new(
            point![query.from_x, query.from_y, query.from_z],
            scaled_direction / scaled_distance,
        );
        // Rapier's solid cast reports a ray that starts inside a collider as time of impact 0
        // with a zero normal. Godot's default (`hit_from_inside` false) skips that collider, so
        // skip it and cast again: one pass per overlapping collider at most.
        let mut skipped: Vec<ColliderHandle> = Vec::new();
        let (collider, intersection) = loop {
            let predicate = |handle: ColliderHandle, collider: &Collider| {
                !skipped.contains(&handle)
                    && self.entries.values().any(|entry| entry.collider == handle)
                    && !collider.is_sensor()
                    && (collider.collision_groups().memberships.bits() & query.collision_mask) != 0
            };
            let filter = QueryFilter {
                flags: QueryFilterFlags::EXCLUDE_SENSORS,
                predicate: Some(&predicate),
                ..QueryFilter::default()
            };
            let pipeline = self.broad_phase.as_query_pipeline(
                self.narrow_phase.query_dispatcher(),
                &self.bodies,
                &self.colliders,
                filter,
            );
            let Some((collider, intersection)) =
                pipeline.cast_ray_and_get_normal(&ray, distance, true)
            else {
                return Ok(None);
            };
            if query.hit_from_inside == 0
                && intersection.time_of_impact == 0.0
                && intersection.normal == vector![0.0, 0.0, 0.0]
            {
                skipped.push(collider);
                continue;
            }
            break (collider, intersection);
        };
        let Some(body_id) = self
            .entries
            .iter()
            .find_map(|(id, entry)| (entry.collider == collider).then_some(*id))
        else {
            return Ok(None);
        };
        let position = ray.point_at(intersection.time_of_impact);
        let hit = TnPhysicsRayHit {
            body_id,
            position_x: position.x,
            position_y: position.y,
            position_z: position.z,
            normal_x: intersection.normal.x,
            normal_y: intersection.normal.y,
            normal_z: intersection.normal.z,
            distance: intersection.time_of_impact,
        };
        if [
            hit.position_x,
            hit.position_y,
            hit.position_z,
            hit.normal_x,
            hit.normal_y,
            hit.normal_z,
            hit.distance,
        ]
        .into_iter()
        .all(f32::is_finite)
        {
            Ok(Some(hit))
        } else {
            Err(RayQueryError::InvalidArithmetic)
        }
    }

    fn query_shape(options: &TnPhysicsShapeQueryOptions) -> Option<SharedShape> {
        let dimensions = [options.shape_x, options.shape_y, options.shape_z];
        if !dimensions.into_iter().all(f32::is_finite) {
            return None;
        }
        match options.shape_type {
            0 if options.shape_x > 0.0
                && options.shape_y > 0.0
                && options.shape_z > 0.0 =>
            {
                Some(SharedShape::cuboid(
                    options.shape_x,
                    options.shape_y,
                    options.shape_z,
                ))
            }
            1 if options.shape_x > 0.0 => Some(SharedShape::ball(options.shape_x)),
            2 if options.shape_x >= 0.0 && options.shape_y > 0.0 => {
                Some(SharedShape::capsule_y(options.shape_x, options.shape_y))
            }
            _ => None,
        }
    }

    fn query_pose(options: &TnPhysicsShapeQueryOptions) -> Option<Isometry<Real>> {
        let values = [
            options.position_x,
            options.position_y,
            options.position_z,
            options.rotation_x,
            options.rotation_y,
            options.rotation_z,
            options.rotation_w,
        ];
        if !values.into_iter().all(f32::is_finite) {
            return None;
        }
        let norm = options.rotation_x * options.rotation_x
            + options.rotation_y * options.rotation_y
            + options.rotation_z * options.rotation_z
            + options.rotation_w * options.rotation_w;
        if norm <= f32::EPSILON {
            return None;
        }
        Some(Isometry::from_parts(
            Translation::new(
                options.position_x,
                options.position_y,
                options.position_z,
            ),
            UnitQuaternion::new_normalize(Quaternion::new(
                options.rotation_w,
                options.rotation_x,
                options.rotation_y,
                options.rotation_z,
            )),
        ))
    }

    fn intersect_shape(
        &mut self,
        options: TnPhysicsShapeQueryOptions,
    ) -> Option<Vec<TnPhysicsQueryHit>> {
        self.refresh_query_pipeline();
        if options.max_results == 0 {
            return None;
        }
        let shape = Self::query_shape(&options)?;
        let pose = Self::query_pose(&options)?;
        let predicate = |handle: ColliderHandle, collider: &Collider| {
            self.entries.values().any(|entry| entry.collider == handle)
                && !collider.is_sensor()
                && (collider.collision_groups().memberships.bits() & options.collision_mask) != 0
        };
        let filter = QueryFilter {
            flags: QueryFilterFlags::EXCLUDE_SENSORS,
            predicate: Some(&predicate),
            ..QueryFilter::default()
        };
        let pipeline = self.broad_phase.as_query_pipeline(
            self.narrow_phase.query_dispatcher(),
            &self.bodies,
            &self.colliders,
            filter,
        );
        let mut hits = Vec::with_capacity(options.max_results as usize);
        for (collider, _) in pipeline.intersect_shape(pose, shape.as_ref()) {
            let Some((body_id, entry)) = self
                .entries
                .iter()
                .find(|(_, entry)| entry.collider == collider)
            else {
                continue;
            };
            let position = self.bodies[entry.body].translation();
            hits.push(TnPhysicsQueryHit {
                body_id: *body_id,
                position_x: position.x,
                position_y: position.y,
                position_z: position.z,
            });
            if hits.len() == options.max_results as usize {
                break;
            }
        }
        Some(hits)
    }

    fn intersect_point(
        &mut self,
        position_x: f32,
        position_y: f32,
        position_z: f32,
        collision_mask: u32,
        max_results: u32,
    ) -> Option<Vec<TnPhysicsQueryHit>> {
        self.refresh_query_pipeline();
        if max_results == 0
            || ![position_x, position_y, position_z]
                .into_iter()
                .all(f32::is_finite)
        {
            return None;
        }
        let point = point![position_x, position_y, position_z];
        let predicate = |handle: ColliderHandle, collider: &Collider| {
            self.entries.values().any(|entry| entry.collider == handle)
                && !collider.is_sensor()
                && (collider.collision_groups().memberships.bits() & collision_mask) != 0
        };
        let filter = QueryFilter {
            flags: QueryFilterFlags::EXCLUDE_SENSORS,
            predicate: Some(&predicate),
            ..QueryFilter::default()
        };
        let pipeline = self.broad_phase.as_query_pipeline(
            self.narrow_phase.query_dispatcher(),
            &self.bodies,
            &self.colliders,
            filter,
        );
        let mut hits = Vec::with_capacity(max_results as usize);
        for (collider, _) in pipeline.intersect_point(point) {
            let Some((body_id, entry)) = self
                .entries
                .iter()
                .find(|(_, entry)| entry.collider == collider)
            else {
                continue;
            };
            let position = self.bodies[entry.body].translation();
            hits.push(TnPhysicsQueryHit {
                body_id: *body_id,
                position_x: position.x,
                position_y: position.y,
                position_z: position.z,
            });
            if hits.len() == max_results as usize {
                break;
            }
        }
        Some(hits)
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn tn_physics_version() -> *const std::ffi::c_char {
    c"0.30.0".as_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn tn_physics_create(options: *const TnPhysicsWorldOptions) -> *mut Simulation {
    if options.is_null() {
        return ptr::null_mut();
    }
    let options = unsafe { ptr::read(options) };
    Simulation::new(options)
        .map(Box::new)
        .map_or(ptr::null_mut(), Box::into_raw)
}

#[unsafe(no_mangle)]
pub extern "C" fn tn_physics_add_body(
    simulation: *mut Simulation,
    options: *const TnPhysicsBodyOptions,
) -> bool {
    let (Some(simulation), false) = (unsafe { simulation.as_mut() }, options.is_null()) else {
        return false;
    };
    simulation.add_body(unsafe { ptr::read(options) })
}

/// Add a fixed or dynamic body whose collider is a triangle mesh.
///
/// `vertices` is a flat `x, y, z` float array and `indices` a flat triangle-index array. Both are
/// copied into the collider here, so the caller's buffers only have to outlive this call.
#[unsafe(no_mangle)]
pub extern "C" fn tn_physics_add_trimesh_body(
    simulation: *mut Simulation,
    options: *const TnPhysicsBodyOptions,
    vertices: *const f32,
    vertex_floats: u32,
    indices: *const u32,
    index_count: u32,
) -> bool {
    let (Some(simulation), false) = (unsafe { simulation.as_mut() }, options.is_null()) else {
        return false;
    };
    let Some((points, triangles)) = copy_trimesh(vertices, vertex_floats, indices, index_count)
    else {
        return false;
    };
    simulation.add_trimesh_body(unsafe { ptr::read(options) }, points, triangles)
}

/// Add a fixed body whose collider is a heightfield. `heights` holds `rows * columns` samples in
/// column-major order; it is copied during the call.
#[unsafe(no_mangle)]
pub extern "C" fn tn_physics_add_heightfield_body(
    simulation: *mut Simulation,
    options: *const TnPhysicsBodyOptions,
    heights: *const f32,
    count: u32,
    rows: u32,
    columns: u32,
    scale_x: f32,
    scale_y: f32,
    scale_z: f32,
) -> bool {
    let (Some(simulation), false) = (unsafe { simulation.as_mut() }, options.is_null()) else {
        return false;
    };
    let Some(shape) = heightfield_shape(heights, count, rows, columns, [scale_x, scale_y, scale_z])
    else {
        return false;
    };
    simulation.insert_body(unsafe { ptr::read(options) }, ColliderBuilder::new(shape))
}

/// Replace a body's collider with a new heightfield in place, keeping its id, parent body,
/// collision groups and events. Rebuilding a heightfield copies its samples and nothing else, so
/// a deforming surface can be refreshed every fixed step.
#[unsafe(no_mangle)]
pub extern "C" fn tn_physics_set_heightfield_shape(
    simulation: *mut Simulation,
    id: u32,
    heights: *const f32,
    count: u32,
    rows: u32,
    columns: u32,
    scale_x: f32,
    scale_y: f32,
    scale_z: f32,
) -> bool {
    let Some(simulation) = (unsafe { simulation.as_mut() }) else {
        return false;
    };
    let Some(shape) = heightfield_shape(heights, count, rows, columns, [scale_x, scale_y, scale_z])
    else {
        return false;
    };
    simulation.set_collider_shape(id, shape)
}

/// Persistent solved contacts between one body's collider and a list of candidate bodies, one
/// `CONTACT_WIDTH` record per solved manifold. Returns the total count, which may exceed what
/// `output` holds (only that many are written), or -1 for an unknown target or a bad buffer.
#[unsafe(no_mangle)]
pub extern "C" fn tn_physics_read_contacts(
    simulation: *const Simulation,
    target: u32,
    candidates: *const u32,
    candidate_count: usize,
    output: *mut f32,
    output_float_capacity: usize,
) -> i32 {
    let Some(simulation) = (unsafe { simulation.as_ref() }) else {
        return -1;
    };
    if (candidate_count > 0 && candidates.is_null()) || (output_float_capacity > 0 && output.is_null())
    {
        return -1;
    }
    let candidates = if candidate_count == 0 {
        &[][..]
    } else {
        unsafe { std::slice::from_raw_parts(candidates, candidate_count) }
    };
    let output = if output_float_capacity == 0 {
        &mut [][..]
    } else {
        unsafe { std::slice::from_raw_parts_mut(output, output_float_capacity) }
    };
    match simulation.read_contacts(target, candidates, output) {
        Some(count) => i32::try_from(count).unwrap_or(-1),
        None => -1,
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn tn_physics_create_joint(
    simulation: *mut Simulation,
    options: *const TnPhysicsJointOptions,
) -> i32 {
    let (Some(simulation), false) = (unsafe { simulation.as_mut() }, options.is_null()) else {
        return -1;
    };
    let options = unsafe { ptr::read(options) };
    let id = options.id;
    if simulation.create_joint(options) {
        id as i32
    } else {
        -1
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn tn_physics_remove_joint(simulation: *mut Simulation, id: u32) -> bool {
    unsafe { simulation.as_mut() }.is_some_and(|simulation| simulation.remove_joint(id))
}

#[unsafe(no_mangle)]
pub extern "C" fn tn_physics_remove_body(simulation: *mut Simulation, id: u32) -> bool {
    unsafe { simulation.as_mut() }.is_some_and(|simulation| simulation.remove_body(id))
}

#[unsafe(no_mangle)]
pub extern "C" fn tn_physics_configure_character(
    simulation: *mut Simulation,
    options: *const TnPhysicsCharacterOptions,
) -> bool {
    let (Some(simulation), false) = (unsafe { simulation.as_mut() }, options.is_null()) else {
        return false;
    };
    simulation.configure_character(unsafe { ptr::read(options) })
}

/// Attach ray-cast wheels to a dynamic chassis. `wheels` is `wheel_count` records of
/// `VEHICLE_WHEEL_WIDTH` floats, copied into the controllers here, so the caller's buffer only
/// has to outlive the call. Returns the vehicle id, or -1 when the chassis is missing, not
/// dynamic, or the wheel records are malformed.
#[unsafe(no_mangle)]
pub extern "C" fn tn_physics_create_vehicle(
    simulation: *mut Simulation,
    options: *const TnPhysicsVehicleOptions,
    wheels: *const f32,
) -> i32 {
    let (Some(simulation), false) = (unsafe { simulation.as_mut() }, options.is_null()) else {
        return -1;
    };
    let options = unsafe { ptr::read(options) };
    let (id, wheel_count) = (options.id, options.wheel_count);
    if wheel_count == 0 || wheels.is_null() {
        return -1;
    }
    let values =
        unsafe { std::slice::from_raw_parts(wheels, wheel_count as usize * VEHICLE_WHEEL_WIDTH) };
    if simulation.create_vehicle(options, values) {
        id as i32
    } else {
        -1
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn tn_physics_set_vehicle_input(
    simulation: *mut Simulation,
    id: u32,
    engine_force: f32,
    brake: f32,
    steering: f32,
) -> bool {
    unsafe { simulation.as_mut() }
        .is_some_and(|simulation| simulation.set_vehicle_input(id, engine_force, brake, steering))
}

/// Writes the signed speed followed by contact, suspension length and rotation per wheel.
/// Returns the number of floats written, or -1 for an unknown vehicle or a short buffer.
#[unsafe(no_mangle)]
pub extern "C" fn tn_physics_read_vehicle_state(
    simulation: *const Simulation,
    id: u32,
    output: *mut f32,
    output_float_capacity: usize,
) -> i32 {
    let Some(simulation) = (unsafe { simulation.as_ref() }) else {
        return -1;
    };
    if output.is_null() {
        return -1;
    }
    let values = unsafe { std::slice::from_raw_parts_mut(output, output_float_capacity) };
    simulation
        .write_vehicle_state(id, values)
        .map_or(-1, |count| count as i32)
}

#[unsafe(no_mangle)]
pub extern "C" fn tn_physics_reset_vehicle(
    simulation: *mut Simulation,
    id: u32,
    x: f32,
    y: f32,
    z: f32,
    yaw: f32,
) -> bool {
    unsafe { simulation.as_mut() }.is_some_and(|simulation| simulation.reset_vehicle(id, x, y, z, yaw))
}

#[unsafe(no_mangle)]
pub extern "C" fn tn_physics_set_body_transform(
    simulation: *mut Simulation,
    id: u32,
    x: f32,
    y: f32,
    z: f32,
) -> bool {
    unsafe { simulation.as_mut() }
        .is_some_and(|simulation| simulation.set_body_transform(id, x, y, z))
}

#[unsafe(no_mangle)]
pub extern "C" fn tn_physics_apply_body_impulse(
    simulation: *mut Simulation,
    id: u32,
    x: f32,
    y: f32,
    z: f32,
) -> i32 {
    unsafe { simulation.as_mut() }.map_or(ActuationStatus::UnknownBody as i32, |simulation| {
        simulation.apply_body_impulse(id, x, y, z) as i32
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn tn_physics_apply_body_force(
    simulation: *mut Simulation,
    id: u32,
    x: f32,
    y: f32,
    z: f32,
) -> i32 {
    unsafe { simulation.as_mut() }.map_or(ActuationStatus::UnknownBody as i32, |simulation| {
        simulation.apply_body_force(id, x, y, z) as i32
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn tn_physics_apply_body_force_at_point(
    simulation: *mut Simulation,
    id: u32,
    force_x: f32,
    force_y: f32,
    force_z: f32,
    point_x: f32,
    point_y: f32,
    point_z: f32,
) -> i32 {
    unsafe { simulation.as_mut() }.map_or(ActuationStatus::UnknownBody as i32, |simulation| {
        simulation.apply_body_force_at_point(id, force_x, force_y, force_z, point_x, point_y, point_z)
            as i32
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn tn_physics_set_body_linear_velocity(
    simulation: *mut Simulation,
    id: u32,
    x: f32,
    y: f32,
    z: f32,
) -> i32 {
    unsafe { simulation.as_mut() }.map_or(ActuationStatus::UnknownBody as i32, |simulation| {
        simulation.set_body_linear_velocity(id, x, y, z) as i32
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn tn_physics_read_body_linear_velocity(
    simulation: *const Simulation,
    id: u32,
    output: *mut TnPhysicsVector3,
) -> i32 {
    let (Some(simulation), false) = (unsafe { simulation.as_ref() }, output.is_null()) else {
        return ActuationStatus::UnknownBody as i32;
    };
    let output = unsafe { &mut *output };
    simulation.read_body_linear_velocity(id, output) as i32
}

#[unsafe(no_mangle)]
pub extern "C" fn tn_physics_step(
    simulation: *mut Simulation,
    delta_time: f32,
    kinematic_transforms: *const f32,
    kinematic_record_count: usize,
) -> bool {
    let Some(simulation) = (unsafe { simulation.as_mut() }) else {
        return false;
    };
    if kinematic_record_count > 0 && kinematic_transforms.is_null() {
        return false;
    }
    let values = if kinematic_record_count == 0 {
        &[]
    } else {
        unsafe {
            std::slice::from_raw_parts(
                kinematic_transforms,
                kinematic_record_count * TRANSFORM_WIDTH,
            )
        }
    };
    simulation.step(delta_time, values)
}

#[unsafe(no_mangle)]
pub extern "C" fn tn_physics_read_visible_transforms(
    simulation: *const Simulation,
    output: *mut f32,
    output_float_capacity: usize,
) -> i32 {
    let Some(simulation) = (unsafe { simulation.as_ref() }) else {
        return -1;
    };
    let required = simulation.entries.len() * TRANSFORM_WIDTH;
    if required > output_float_capacity || (required > 0 && output.is_null()) {
        return -1;
    }
    for (index, (id, entry)) in simulation.entries.iter().enumerate() {
        let body = &simulation.bodies[entry.body];
        let translation = body.translation();
        let rotation = body.rotation().quaternion();
        let values = [
            *id as f32,
            translation.x,
            translation.y,
            translation.z,
            rotation.i,
            rotation.j,
            rotation.k,
            rotation.w,
        ];
        unsafe {
            ptr::copy_nonoverlapping(
                values.as_ptr(),
                output.add(index * TRANSFORM_WIDTH),
                TRANSFORM_WIDTH,
            )
        };
    }
    simulation.entries.len() as i32
}

#[unsafe(no_mangle)]
pub extern "C" fn tn_physics_read_body_sleep_states(
    simulation: *const Simulation,
    output: *mut f32,
    output_float_capacity: usize,
) -> i32 {
    let Some(simulation) = (unsafe { simulation.as_ref() }) else {
        return -1;
    };
    let required = simulation.entries.len() * SLEEP_STATE_WIDTH;
    if required > output_float_capacity || (required > 0 && output.is_null()) {
        return -1;
    }
    for (index, (id, entry)) in simulation.entries.iter().enumerate() {
        let values = [
            *id as f32,
            if simulation.bodies[entry.body].is_sleeping() {
                1.0
            } else {
                0.0
            },
        ];
        unsafe {
            ptr::copy_nonoverlapping(
                values.as_ptr(),
                output.add(index * SLEEP_STATE_WIDTH),
                SLEEP_STATE_WIDTH,
            )
        };
    }
    simulation.entries.len() as i32
}

#[unsafe(no_mangle)]
pub extern "C" fn tn_physics_read_character_states(
    simulation: *const Simulation,
    output: *mut f32,
    output_float_capacity: usize,
) -> i32 {
    let Some(simulation) = (unsafe { simulation.as_ref() }) else {
        return -1;
    };
    let required = simulation.characters.len() * CHARACTER_STATE_WIDTH;
    if required > output_float_capacity || (required > 0 && output.is_null()) {
        return -1;
    }
    let values = if required == 0 {
        &mut []
    } else {
        unsafe { std::slice::from_raw_parts_mut(output, required) }
    };
    simulation
        .write_character_states(values)
        .map_or(-1, |count| count as i32)
}

#[unsafe(no_mangle)]
pub extern "C" fn tn_physics_read_area_intersections(
    simulation: *const Simulation,
    output: *mut u32,
    output_u32_capacity: usize,
) -> i32 {
    let Some(simulation) = (unsafe { simulation.as_ref() }) else {
        return -1;
    };
    let pairs = simulation.area_intersections();
    let required = pairs.len() * 2;
    if required > output_u32_capacity || (required > 0 && output.is_null()) {
        return -1;
    }
    for (index, pair) in pairs.iter().enumerate() {
        unsafe { ptr::copy_nonoverlapping(pair.as_ptr(), output.add(index * 2), 2) };
    }
    pairs.len() as i32
}

#[unsafe(no_mangle)]
pub extern "C" fn tn_physics_intersect_ray(
    simulation: *mut Simulation,
    query: *const TnPhysicsRayQuery,
    output: *mut TnPhysicsRayHit,
) -> i32 {
    let (Some(simulation), false) = (unsafe { simulation.as_mut() }, query.is_null()) else {
        return -1;
    };
    let hit = match simulation.intersect_ray(unsafe { ptr::read(query) }) {
        Err(RayQueryError::InvalidArithmetic) => return -1,
        Ok(None) => return 0,
        Ok(Some(hit)) => hit,
    };
    if output.is_null() {
        return -1;
    }
    unsafe { ptr::write(output, hit) };
    1
}

#[unsafe(no_mangle)]
pub extern "C" fn tn_physics_intersect_shape(
    simulation: *mut Simulation,
    query: *const TnPhysicsShapeQueryOptions,
    output: *mut TnPhysicsQueryHit,
    output_capacity: usize,
) -> i32 {
    let (Some(simulation), false) = (unsafe { simulation.as_mut() }, query.is_null()) else {
        return -1;
    };
    let query = unsafe { ptr::read(query) };
    if query.max_results == 0 || output_capacity < query.max_results as usize {
        return -1;
    }
    let Some(hits) = simulation.intersect_shape(query) else {
        return -1;
    };
    if hits.len() > output_capacity || (hits.len() > 0 && output.is_null()) {
        return -1;
    }
    for (index, hit) in hits.iter().enumerate() {
        unsafe { ptr::write(output.add(index), *hit) };
    }
    hits.len() as i32
}

#[unsafe(no_mangle)]
pub extern "C" fn tn_physics_intersect_point(
    simulation: *mut Simulation,
    position_x: f32,
    position_y: f32,
    position_z: f32,
    collision_mask: u32,
    max_results: u32,
    output: *mut TnPhysicsQueryHit,
    output_capacity: usize,
) -> i32 {
    let Some(simulation) = (unsafe { simulation.as_mut() }) else {
        return -1;
    };
    if max_results == 0 || output_capacity < max_results as usize {
        return -1;
    }
    let Some(hits) = simulation.intersect_point(
        position_x,
        position_y,
        position_z,
        collision_mask,
        max_results,
    ) else {
        return -1;
    };
    if hits.len() > output_capacity || (hits.len() > 0 && output.is_null()) {
        return -1;
    }
    for (index, hit) in hits.iter().enumerate() {
        unsafe { ptr::write(output.add(index), *hit) };
    }
    hits.len() as i32
}

#[unsafe(no_mangle)]
pub extern "C" fn tn_physics_drain_collision_events(
    simulation: *mut Simulation,
    output: *mut u32,
    output_u32_capacity: usize,
) -> i32 {
    let Some(simulation) = (unsafe { simulation.as_mut() }) else {
        return -1;
    };
    let required = simulation.events.len() * EVENT_WIDTH;
    if required > output_u32_capacity || (required > 0 && output.is_null()) {
        return -1;
    }
    for (event_index, event) in simulation.events.iter().enumerate() {
        unsafe {
            ptr::copy_nonoverlapping(
                event.as_ptr(),
                output.add(event_index * EVENT_WIDTH),
                EVENT_WIDTH,
            )
        };
    }
    let count = simulation.events.len() as i32;
    simulation.events.clear();
    count
}

#[unsafe(no_mangle)]
pub extern "C" fn tn_physics_destroy(simulation: *mut Simulation) {
    if !simulation.is_null() {
        unsafe { drop(Box::from_raw(simulation)) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixed_box(id: u32, x: f32, y: f32, layer: u32) -> TnPhysicsBodyOptions {
        TnPhysicsBodyOptions {
            id,
            body_type: 1,
            shape_type: 0,
            position_x: x,
            position_y: y,
            position_z: 0.0,
            rotation_x: 0.0,
            rotation_y: 0.0,
            rotation_z: 0.0,
            rotation_w: 1.0,
            shape_x: 0.5,
            shape_y: 0.5,
            shape_z: 0.5,
            mass: 0.0,
            collision_layer: layer,
            collision_mask: u16::MAX.into(),
            sensor: false,
            continuous_collision: true,
        }
    }

    #[test]
    fn explicit_mass_is_the_total_body_mass_not_added_to_the_collider() {
        let mut simulation = Simulation::new(TnPhysicsWorldOptions {
            gravity_x: 0.0,
            gravity_y: 0.0,
            gravity_z: 0.0,
        })
        .unwrap();
        let mut explicit = fixed_box(1, 0.0, 0.0, 1);
        explicit.body_type = 0;
        explicit.shape_x = 1.0;
        explicit.shape_y = 1.0;
        explicit.shape_z = 1.0;
        explicit.mass = 2.0;
        assert!(simulation.add_body(explicit));
        let mut automatic = fixed_box(2, 10.0, 0.0, 1);
        automatic.body_type = 0;
        automatic.shape_x = 1.0;
        automatic.shape_y = 1.0;
        automatic.shape_z = 1.0;
        automatic.mass = 0.0;
        assert!(simulation.add_body(automatic));

        let explicit_mass = simulation.bodies[simulation.entries[&1].body].mass();
        assert!(
            (explicit_mass - 2.0).abs() < 1e-4,
            "explicit mass was {explicit_mass} instead of 2"
        );
        let automatic_mass = simulation.bodies[simulation.entries[&2].body].mass();
        assert!(
            (automatic_mass - 8.0).abs() < 1e-3,
            "automatic collider mass was {automatic_mass} instead of 8"
        );
    }

    #[test]
    fn continuous_collision_stops_a_fast_body_and_opt_out_tunnels() {
        let mut simulation = Simulation::new(TnPhysicsWorldOptions {
            gravity_x: 0.0,
            gravity_y: 0.0,
            gravity_z: 0.0,
        })
        .unwrap();
        assert!(simulation.add_body(TnPhysicsBodyOptions {
            id: 0,
            body_type: 1,
            shape_type: 0,
            position_x: 0.0,
            position_y: 0.0,
            position_z: 0.0,
            rotation_x: 0.0,
            rotation_y: 0.0,
            rotation_z: 0.0,
            rotation_w: 1.0,
            shape_x: 0.05,
            shape_y: 1.0,
            shape_z: 1.0,
            mass: 0.0,
            collision_layer: 1,
            collision_mask: u16::MAX.into(),
            sensor: false,
            continuous_collision: true,
        }));
        for (id, continuous_collision) in [(1, true), (2, false)] {
            assert!(simulation.add_body(TnPhysicsBodyOptions {
                id,
                body_type: 0,
                shape_type: 1,
                position_x: -1.0,
                position_y: 0.0,
                position_z: 0.0,
                rotation_x: 0.0,
                rotation_y: 0.0,
                rotation_z: 0.0,
                rotation_w: 1.0,
                shape_x: 0.05,
                shape_y: 0.0,
                shape_z: 0.0,
                mass: 1.0,
                collision_layer: 1,
                collision_mask: u16::MAX.into(),
                sensor: false,
                continuous_collision,
            }));
            assert_eq!(
                simulation.set_body_linear_velocity(id, 120.0, 0.0, 0.0),
                ActuationStatus::Ok
            );
        }

        assert!(simulation.step(1.0 / 60.0, &[]));
        let continuous_x = simulation.bodies[simulation.entries[&1].body]
            .translation()
            .x;
        let discrete_x = simulation.bodies[simulation.entries[&2].body]
            .translation()
            .x;
        assert!(
            continuous_x < 0.0,
            "continuous body crossed the wall at {continuous_x}"
        );
        assert!(
            discrete_x > 0.1,
            "opted-out body did not tunnel at {discrete_x}"
        );
    }

    /// A 4 m wide, 2 m tall wall in the x/y plane at z = 0 with a 1 m opening centred on x = 0.
    /// `left` and `right` are the two quad halves, so the gap between them is the doorway.
    fn trimesh_wall() -> (Vec<Point3<Real>>, Vec<[u32; 3]>) {
        let left = [-2.0f32, -1.0, 0.0, -0.5, -1.0, 0.0, -0.5, 1.0, 0.0, -2.0, -1.0, 0.0,
            -0.5, 1.0, 0.0, -2.0, 1.0, 0.0];
        let right = [0.5f32, -1.0, 0.0, 2.0, -1.0, 0.0, 2.0, 1.0, 0.0, 0.5, -1.0, 0.0, 2.0, 1.0,
            0.0, 0.5, 1.0, 0.0];
        let flat: Vec<f32> = left.into_iter().chain(right).collect();
        let points = flat
            .chunks_exact(3)
            .map(|vertex| Point3::new(vertex[0], vertex[1], vertex[2]))
            .collect();
        let triangles = (0..12u32).collect::<Vec<u32>>()
            .chunks_exact(3)
            .map(|triangle| [triangle[0], triangle[1], triangle[2]])
            .collect();
        (points, triangles)
    }

    #[test]
    fn a_trimesh_body_keeps_the_openings_the_mesh_has() {
        let mut simulation = Simulation::new(TnPhysicsWorldOptions {
            gravity_x: 0.0,
            gravity_y: 0.0,
            gravity_z: 0.0,
        })
        .unwrap();
        let (points, triangles) = trimesh_wall();
        let mut options = fixed_box(0, 0.0, 0.0, 1);
        options.shape_type = 3;
        assert!(simulation.add_trimesh_body(options, points, triangles));
        assert!(simulation.step(1.0 / 60.0, &[]));

        let through = simulation
            .intersect_ray(TnPhysicsRayQuery {
                from_x: 0.0,
                from_y: 0.0,
                from_z: -2.0,
                to_x: 0.0,
                to_y: 0.0,
                to_z: 2.0,
                collision_mask: 1,
                hit_from_inside: 0,
            })
            .expect("clear ray arithmetic");
        assert!(through.is_none(), "a ray through the opening must miss");
        let wall = simulation
            .intersect_ray(TnPhysicsRayQuery {
                from_x: 1.5,
                from_y: 0.0,
                from_z: -2.0,
                to_x: 1.5,
                to_y: 0.0,
                to_z: 2.0,
                collision_mask: 1,
                hit_from_inside: 0,
            })
            .expect("wall ray arithmetic")
            .expect("a ray into the intact wall must hit");
        assert_eq!(wall.body_id, 0);
    }

    #[test]
    fn the_trimesh_ffi_rejects_a_degenerate_or_out_of_range_mesh() {
        let gravity = TnPhysicsWorldOptions {
            gravity_x: 0.0,
            gravity_y: 0.0,
            gravity_z: 0.0,
        };
        let mut simulation = Simulation::new(gravity).unwrap();
        let mut options = fixed_box(0, 0.0, 0.0, 1);
        options.shape_type = 3;
        let vertices = [-1.0f32, -1.0, 0.0, 1.0, -1.0, 0.0, 0.0, 1.0, 0.0];
        // An index past the vertex buffer must be refused, not read.
        let bad = [0u32, 1, 3];
        assert!(!tn_physics_add_trimesh_body(
            &mut simulation,
            &options,
            vertices.as_ptr(),
            9,
            bad.as_ptr(),
            3,
        ));
        // A NaN vertex is not a mesh.
        let nan = [0.0f32, f32::NAN, 0.0];
        assert!(!tn_physics_add_trimesh_body(
            &mut simulation,
            &options,
            nan.as_ptr(),
            3,
            [0u32, 0, 0].as_ptr(),
            3,
        ));
        let good = [0u32, 1, 2];
        assert!(tn_physics_add_trimesh_body(
            &mut simulation,
            &options,
            vertices.as_ptr(),
            9,
            good.as_ptr(),
            3,
        ));
    }

    #[test]
    fn spatial_queries_report_numeric_hits_and_apply_masks_and_bounds() {
        let mut simulation = Simulation::new(TnPhysicsWorldOptions {
            gravity_x: 0.0,
            gravity_y: 0.0,
            gravity_z: 0.0,
        })
        .unwrap();
        assert!(simulation.add_body(fixed_box(0, 4.0, 0.0, 1)));
        assert!(simulation.add_body(fixed_box(1, 6.0, 0.0, 2)));
        for id in 0..20 {
            assert!(simulation.add_body(fixed_box(id + 2, id as f32, 10.0, 1)));
        }
        assert!(simulation.step(1.0 / 60.0, &[]));

        let hit = simulation
            .intersect_ray(TnPhysicsRayQuery {
                from_x: 0.0,
                from_y: 0.0,
                from_z: 0.0,
                to_x: 10.0,
                to_y: 0.0,
                to_z: 0.0,
                collision_mask: 1,
                hit_from_inside: 0,
            })
            .expect("valid ray arithmetic")
            .expect("ray should hit the first box");
        assert_eq!(hit.body_id, 0);
        assert!((hit.distance - 3.5).abs() < 1.0e-6);
        assert!((hit.position_x - 3.5).abs() < 1.0e-6);
        assert_eq!(hit.normal_x, -1.0);
        assert_eq!(hit.normal_y, 0.0);
        assert_eq!(hit.normal_z, 0.0);
        assert!(simulation
            .intersect_ray(TnPhysicsRayQuery {
                from_x: 5.5,
                from_y: 0.0,
                from_z: 0.0,
                to_x: 7.0,
                to_y: 0.0,
                to_z: 0.0,
                collision_mask: 1,
                hit_from_inside: 0,
            })
            .expect("clear ray arithmetic")
            .is_none());
        assert!(simulation
            .intersect_ray(TnPhysicsRayQuery {
                from_x: 0.0,
                from_y: 20.0,
                from_z: 0.0,
                to_x: 10.0,
                to_y: 20.0,
                to_z: 0.0,
                collision_mask: 1,
                hit_from_inside: 0,
            })
            .expect("masked ray arithmetic")
            .is_none());

        let hits = simulation
            .intersect_shape(TnPhysicsShapeQueryOptions {
                shape_type: 1,
                shape_x: 50.0,
                shape_y: 0.0,
                shape_z: 0.0,
                position_x: 0.0,
                position_y: 0.0,
                position_z: 0.0,
                rotation_x: 0.0,
                rotation_y: 0.0,
                rotation_z: 0.0,
                rotation_w: 1.0,
                collision_mask: 1,
                max_results: 16,
            })
            .unwrap();
        assert_eq!(hits.len(), 16);
        let point_hits = simulation
            .intersect_point(4.0, 0.0, 0.0, 1, 16)
            .unwrap();
        assert_eq!(point_hits.len(), 1);
        assert_eq!(point_hits[0].body_id, 0);
    }

    #[test]
    fn native_shape_and_point_queries_report_misses_and_apply_masks() {
        let mut simulation = Simulation::new(TnPhysicsWorldOptions {
            gravity_x: 0.0,
            gravity_y: 0.0,
            gravity_z: 0.0,
        })
        .unwrap();
        assert!(simulation.add_body(fixed_box(0, 0.0, 0.0, 1)));
        assert!(simulation.step(1.0 / 60.0, &[]));

        let query = |position_x, position_y, position_z, collision_mask| {
            TnPhysicsShapeQueryOptions {
                shape_type: 1,
                shape_x: 0.5,
                shape_y: 0.0,
                shape_z: 0.0,
                position_x,
                position_y,
                position_z,
                rotation_x: 0.0,
                rotation_y: 0.0,
                rotation_z: 0.0,
                rotation_w: 1.0,
                collision_mask,
                max_results: 16,
            }
        };
        assert!(simulation
            .intersect_shape(query(100.0, 100.0, 100.0, 1))
            .unwrap()
            .is_empty());
        assert!(simulation
            .intersect_shape(query(0.0, 0.0, 0.0, 2))
            .unwrap()
            .is_empty());
        assert!(simulation
            .intersect_point(100.0, 100.0, 100.0, 1, 16)
            .unwrap()
            .is_empty());
        assert!(simulation
            .intersect_point(0.0, 0.0, 0.0, 2, 16)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn spatial_queries_see_attached_collider_after_immediate_teleport() {
        let mut simulation = Simulation::new(TnPhysicsWorldOptions {
            gravity_x: 0.0,
            gravity_y: 0.0,
            gravity_z: 0.0,
        })
        .unwrap();
        assert!(simulation.add_body(fixed_box(0, -4.0, 0.0, 1)));
        assert!(simulation.step(1.0 / 60.0, &[]));

        assert_eq!(
            simulation
                .intersect_point(-4.0, 0.0, 0.0, 1, 16)
                .unwrap()
                .len(),
            1
        );
        assert!(simulation.set_body_transform(0, 4.0, 0.0, 0.0));

        assert!(simulation
            .intersect_point(-4.0, 0.0, 0.0, 1, 16)
            .unwrap()
            .is_empty());
        let hits = simulation.intersect_point(4.0, 0.0, 0.0, 1, 16).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].body_id, 0);
    }

    #[test]
    fn accepts_nonzero_ray_with_underflowing_norm_and_rejects_exact_zero() {
        let mut simulation = Simulation::new(TnPhysicsWorldOptions {
            gravity_x: 0.0,
            gravity_y: 0.0,
            gravity_z: 0.0,
        })
        .unwrap();
        assert!(simulation.add_body(fixed_box(0, 0.0, 0.0, 1)));
        assert!(simulation.step(1.0 / 60.0, &[]));

        let short_length = 1.0e-30_f32;
        let short_hit = simulation
            .intersect_ray(TnPhysicsRayQuery {
                from_x: 0.0,
                from_y: 0.0,
                from_z: 0.0,
                to_x: short_length,
                to_y: 0.0,
                to_z: 0.0,
                collision_mask: 1,
                hit_from_inside: 1,
            })
            .expect("a nonzero short ray must have valid arithmetic")
            .expect("a nonzero short ray must reach the native query pipeline");
        assert_eq!(short_hit.body_id, 0);
        assert!(short_length > 0.0);
        assert!(
            simulation
                .intersect_ray(TnPhysicsRayQuery {
                    from_x: 0.0,
                    from_y: 0.0,
                    from_z: 0.0,
                    to_x: 0.0,
                    to_y: 0.0,
                    to_z: 0.0,
                    collision_mask: 1,
                    hit_from_inside: 0,
                })
                .is_err()
        );
    }

    #[test]
    fn a_ray_that_starts_inside_a_solid_follows_hit_from_inside() {
        let mut simulation = Simulation::new(TnPhysicsWorldOptions {
            gravity_x: 0.0,
            gravity_y: 0.0,
            gravity_z: 0.0,
        })
        .unwrap();
        assert!(simulation.add_body(fixed_box(0, 0.0, 0.0, 1)));
        assert!(simulation.add_body(fixed_box(1, 5.0, 0.0, 1)));
        assert!(simulation.step(1.0 / 60.0, &[]));
        let ray = |to_x: f32, hit_from_inside: u32| TnPhysicsRayQuery {
            from_x: 0.0,
            from_y: 0.0,
            from_z: 0.0,
            to_x,
            to_y: 0.0,
            to_z: 0.0,
            collision_mask: 1,
            hit_from_inside,
        };

        let next = simulation
            .intersect_ray(ray(10.0, 0))
            .expect("valid ray arithmetic")
            .expect("the default skips the box around the origin and hits the next one");
        assert_eq!(next.body_id, 1);
        assert!((next.distance - 4.5).abs() < 1.0e-6);
        assert_eq!(next.normal_x, -1.0);
        assert!(
            simulation
                .intersect_ray(ray(3.0, 0))
                .expect("valid ray arithmetic")
                .is_none(),
            "no real hit is a miss, never a zero-normal hit"
        );
        let inside = simulation
            .intersect_ray(ray(3.0, 1))
            .expect("valid ray arithmetic")
            .expect("hit_from_inside reports the box around the origin");
        assert_eq!(inside.body_id, 0);
        assert_eq!(inside.distance, 0.0);
        assert_eq!(
            (inside.normal_x, inside.normal_y, inside.normal_z),
            (0.0, 0.0, 0.0)
        );
    }

    #[test]
    fn rejects_finite_ray_endpoints_when_subtraction_is_unrepresentable() {
        let mut simulation = Simulation::new(TnPhysicsWorldOptions {
            gravity_x: 0.0,
            gravity_y: 0.0,
            gravity_z: 0.0,
        })
        .unwrap();
        let query = TnPhysicsRayQuery {
            from_x: -f32::MAX,
            from_y: 0.0,
            from_z: 0.0,
            to_x: f32::MAX,
            to_y: 0.0,
            to_z: 0.0,
            collision_mask: 1,
            hit_from_inside: 0,
        };
        assert!(matches!(
            simulation.intersect_ray(query),
            Err(RayQueryError::InvalidArithmetic)
        ));

        let mut output = TnPhysicsRayHit {
            body_id: 0,
            position_x: 0.0,
            position_y: 0.0,
            position_z: 0.0,
            normal_x: 0.0,
            normal_y: 0.0,
            normal_z: 0.0,
            distance: 0.0,
        };
        assert_eq!(
            tn_physics_intersect_ray(
                &mut simulation,
                &query,
                &mut output,
            ),
            -1
        );
    }

    #[test]
    fn arbitrary_body_ids_and_kinematic_bulk_input_are_supported() {
        let mut simulation = Simulation::new(TnPhysicsWorldOptions {
            gravity_x: 0.0,
            gravity_y: -9.81,
            gravity_z: 0.0,
        })
        .unwrap();
        assert!(simulation.add_body(TnPhysicsBodyOptions {
            id: 42,
            body_type: 2,
            shape_type: 1,
            position_x: 0.0,
            position_y: 1.0,
            position_z: 0.0,
            rotation_x: 0.0,
            rotation_y: 0.0,
            rotation_z: 0.0,
            rotation_w: 1.0,
            shape_x: 0.5,
            shape_y: 0.0,
            shape_z: 0.0,
            mass: 0.0,
            collision_layer: 1,
            collision_mask: u16::MAX.into(),
            sensor: false,
            continuous_collision: true,
        }));
        assert!(simulation.step(1.0 / 60.0, &[42.0, 2.0, 3.0, 4.0, 0.0, 0.0, 0.0, 1.0],));
        assert_eq!(
            simulation.bodies[simulation.entries[&42].body]
                .translation()
                .x,
            2.0
        );
    }

    #[test]
    fn sleep_states_are_bulk_read_and_removed_bodies_disappear() {
        let mut simulation = Simulation::new(TnPhysicsWorldOptions {
            gravity_x: 0.0,
            gravity_y: 0.0,
            gravity_z: 0.0,
        })
        .unwrap();
        let body = |id| TnPhysicsBodyOptions {
            id,
            body_type: 0,
            shape_type: 1,
            position_x: 0.0,
            position_y: 0.0,
            position_z: 0.0,
            rotation_x: 0.0,
            rotation_y: 0.0,
            rotation_z: 0.0,
            rotation_w: 1.0,
            shape_x: 0.5,
            shape_y: 0.0,
            shape_z: 0.0,
            mass: 1.0,
            collision_layer: 1,
            collision_mask: u16::MAX.into(),
            sensor: false,
            continuous_collision: true,
        };
        assert!(simulation.add_body(body(11)));
        assert!(simulation.add_body(body(29)));
        simulation.bodies[simulation.entries[&11].body].sleep();

        let mut too_small = [f32::NAN; 3];
        assert_eq!(
            tn_physics_read_body_sleep_states(&simulation, too_small.as_mut_ptr(), too_small.len(),),
            -1
        );
        assert!(too_small.iter().all(|value| value.is_nan()));

        let mut states = [f32::NAN; 4];
        assert_eq!(
            tn_physics_read_body_sleep_states(&simulation, states.as_mut_ptr(), states.len()),
            2
        );
        assert_eq!(states, [11.0, 1.0, 29.0, 0.0]);

        assert!(simulation.remove_body(11));
        let mut remaining = [f32::NAN; 2];
        assert_eq!(
            tn_physics_read_body_sleep_states(&simulation, remaining.as_mut_ptr(), remaining.len(),),
            1
        );
        assert_eq!(remaining, [29.0, 0.0]);
    }

    #[test]
    fn configured_character_reports_grounded_while_standing_still() {
        let mut simulation = Simulation::new(TnPhysicsWorldOptions {
            gravity_x: 0.0,
            gravity_y: 0.0,
            gravity_z: 0.0,
        })
        .unwrap();
        let body = |id, body_type, y, shape_x, shape_y, shape_z| TnPhysicsBodyOptions {
            id,
            body_type,
            shape_type: if body_type == 3 { 2 } else { 0 },
            position_x: 0.0,
            position_y: y,
            position_z: 0.0,
            rotation_x: 0.0,
            rotation_y: 0.0,
            rotation_z: 0.0,
            rotation_w: 1.0,
            shape_x,
            shape_y,
            shape_z,
            mass: 0.0,
            collision_layer: 1,
            collision_mask: u16::MAX.into(),
            sensor: false,
            continuous_collision: true,
        };
        assert!(simulation.add_body(body(1, 1, -0.1, 5.0, 0.1, 5.0)));
        assert!(simulation.add_body(body(2, 3, 0.5, 0.2, 0.3, 0.0)));
        assert!(simulation.configure_character(TnPhysicsCharacterOptions {
            id: 2,
            offset: 0.02,
            max_slope_climb_angle: std::f32::consts::FRAC_PI_4,
            autostep_enabled: true,
            autostep_max_height: 0.4,
            autostep_min_width: 0.2,
            autostep_include_dynamic_bodies: false,
            snap_to_ground_enabled: true,
            snap_to_ground: 0.1,
            one_way_layers: 2,
            pushes_dynamic_bodies: false,
        }));
        for _ in 0..30 {
            let y = simulation.bodies[simulation.entries[&2].body]
                .translation()
                .y;
            assert!(simulation.step(1.0 / 60.0, &[2.0, 0.0, y - 0.02, 0.0, 0.0, 0.0, 0.0, 1.0],));
        }
        let y = simulation.bodies[simulation.entries[&2].body]
            .translation()
            .y;
        assert!(simulation.step(1.0 / 60.0, &[2.0, 0.0, y, 0.0, 0.0, 0.0, 0.0, 1.0],));
        let character = simulation.characters[&2].clone();
        assert!(character.grounded);
        assert_eq!(character.ground_collider, Some(1));
    }

    #[test]
    fn character_stays_grounded_while_it_presses_a_push_block() {
        let mut simulation = Simulation::new(TnPhysicsWorldOptions {
            gravity_x: 0.0,
            gravity_y: 0.0,
            gravity_z: 0.0,
        })
        .unwrap();
        let body = |id, body_type, shape_type, [x, y, z]: [f32; 3], [sx, sy, sz]: [f32; 3]| {
            TnPhysicsBodyOptions {
                id,
                body_type,
                shape_type,
                position_x: x,
                position_y: y,
                position_z: z,
                rotation_x: 0.0,
                rotation_y: 0.0,
                rotation_z: 0.0,
                rotation_w: 1.0,
                shape_x: sx,
                shape_y: sy,
                shape_z: sz,
                mass: 0.0,
                collision_layer: 1,
                collision_mask: u16::MAX.into(),
                sensor: false,
                continuous_collision: true,
            }
        };
        assert!(simulation.add_body(body(1, 1, 0, [0.0, -0.1, 0.0], [5.0, 0.1, 2.0])));
        assert!(simulation.add_body(body(2, 3, 2, [0.0, 0.86, 0.36], [0.55, 0.3, 0.0])));
        assert!(simulation.add_body(body(3, 2, 0, [1.0, 0.5, 0.0], [0.5, 0.5, 0.5])));
        assert!(simulation.configure_character(TnPhysicsCharacterOptions {
            id: 2,
            offset: 0.01,
            max_slope_climb_angle: std::f32::consts::FRAC_PI_4,
            autostep_enabled: true,
            autostep_max_height: 0.3,
            autostep_min_width: 0.2,
            autostep_include_dynamic_bodies: false,
            snap_to_ground_enabled: true,
            snap_to_ground: 0.3,
            one_way_layers: 0,
            pushes_dynamic_bodies: false,
        }));
        let dt = 1.0 / 60.0;
        let mut velocity_y = 0.0f32;
        let mut block_x = 1.0f32;
        let mut airborne = Vec::new();
        for tick in 0..130 {
            let at = *simulation.bodies[simulation.entries[&2].body].translation();
            velocity_y -= 20.0 * dt;
            let push = if tick >= 30 { 2.5 * dt } else { 0.0 };
            // The block slides one metre away and stops, the way a pushed block does.
            if (50..100).contains(&tick) {
                block_x += 1.0 / 50.0;
            }
            assert!(simulation.step(
                dt,
                &[
                    2.0,
                    at.x + push,
                    at.y + velocity_y * dt,
                    at.z,
                    0.0,
                    0.0,
                    0.0,
                    1.0,
                    3.0,
                    block_x,
                    0.5,
                    0.0,
                    0.0,
                    0.0,
                    0.0,
                    1.0,
                ],
            ));
            let grounded = simulation.characters[&2].grounded;
            if grounded && velocity_y < 0.0 {
                velocity_y = 0.0;
            }
            if tick >= 50 && !grounded {
                airborne.push(tick);
            }
        }
        assert!(airborne.is_empty(), "airborne at ticks {airborne:?}");
        let at = *simulation.bodies[simulation.entries[&2].body].translation();
        assert!(at.x > 1.1, "the character followed the block, x = {}", at.x);
    }

    // --- collision event delivery -------------------------------------------------------
    //
    // The record contract is the one `tn_physics_drain_collision_events` copies out and
    // `packages/physics/src/plugin.ts` consumes: [leftId, rightId, started, 1], with the
    // smaller id first. Parity target is the web path, which drains Rapier's own event
    // queue (`packages/physics/src/simulation.ts:1181`) and drops events whose colliders
    // no longer resolve to a body.

    fn drain_events(simulation: &mut Simulation) -> Vec<[u32; EVENT_WIDTH]> {
        let mut buffer = [0u32; 4096];
        let count =
            tn_physics_drain_collision_events(simulation, buffer.as_mut_ptr(), buffer.len());
        assert!(count >= 0, "event drain rejected a sufficient buffer");
        (0..count as usize)
            .map(|index| {
                [
                    buffer[index * 4],
                    buffer[index * 4 + 1],
                    buffer[index * 4 + 2],
                    buffer[index * 4 + 3],
                ]
            })
            .collect()
    }

    #[test]
    fn collision_events_report_started_once_then_stopped_once() {
        let mut simulation = Simulation::new(TnPhysicsWorldOptions {
            gravity_x: 0.0,
            gravity_y: -9.81,
            gravity_z: 0.0,
        })
        .unwrap();
        assert!(simulation.add_body(fixed_box(0, 0.0, -0.5, 1)));
        assert!(simulation.add_body(TnPhysicsBodyOptions {
            id: 1,
            body_type: 0,
            shape_type: 0,
            position_x: 0.0,
            position_y: 2.0,
            position_z: 0.0,
            rotation_x: 0.0,
            rotation_y: 0.0,
            rotation_z: 0.0,
            rotation_w: 1.0,
            shape_x: 0.5,
            shape_y: 0.5,
            shape_z: 0.5,
            mass: 1.0,
            collision_layer: 1,
            collision_mask: u16::MAX.into(),
            sensor: false,
            continuous_collision: true,
        }));

        let mut started = Vec::new();
        for _ in 0..240 {
            assert!(simulation.step(1.0 / 60.0, &[]));
            started = drain_events(&mut simulation);
            if !started.is_empty() {
                break;
            }
        }
        assert_eq!(
            started,
            vec![[0, 1, 1, 1]],
            "a landing body must deliver exactly one started event, ids ascending"
        );

        // A resting body keeps its contact without re-emitting anything.
        for _ in 0..10 {
            assert!(simulation.step(1.0 / 60.0, &[]));
        }
        assert!(drain_events(&mut simulation).is_empty());

        // Then the body leaves the floor and the pair must deliver exactly one stop.
        assert_eq!(
            simulation.set_body_linear_velocity(1, 30.0, 20.0, 0.0),
            ActuationStatus::Ok
        );
        let mut stopped = Vec::new();
        for _ in 0..240 {
            assert!(simulation.step(1.0 / 60.0, &[]));
            stopped = drain_events(&mut simulation);
            if !stopped.is_empty() {
                break;
            }
        }
        assert_eq!(
            stopped,
            vec![[0, 1, 0, 1]],
            "the separating pair must deliver exactly one stopped event"
        );
        for _ in 0..60 {
            assert!(simulation.step(1.0 / 60.0, &[]));
        }
        assert!(drain_events(&mut simulation).is_empty());
    }

    #[test]
    fn sensor_overlap_reports_started_and_stopped() {
        // Kinematic-vs-fixed pairs sit outside Rapier's default ActiveCollisionTypes on both
        // the web and native paths (areas reconcile through the query path instead), so this
        // models the covered case: a kinematic sensor sweeping over a dynamic body.
        let mut simulation = Simulation::new(TnPhysicsWorldOptions {
            gravity_x: 0.0,
            gravity_y: 0.0,
            gravity_z: 0.0,
        })
        .unwrap();
        assert!(simulation.add_body(TnPhysicsBodyOptions {
            id: 0,
            body_type: 0,
            shape_type: 0,
            position_x: 0.0,
            position_y: 0.0,
            position_z: 0.0,
            rotation_x: 0.0,
            rotation_y: 0.0,
            rotation_z: 0.0,
            rotation_w: 1.0,
            shape_x: 0.5,
            shape_y: 0.5,
            shape_z: 0.5,
            mass: 1.0,
            collision_layer: 1,
            collision_mask: u16::MAX.into(),
            sensor: false,
            continuous_collision: true,
        }));
        assert!(simulation.add_body(TnPhysicsBodyOptions {
            id: 1,
            body_type: 2,
            shape_type: 0,
            position_x: 5.0,
            position_y: 0.0,
            position_z: 0.0,
            rotation_x: 0.0,
            rotation_y: 0.0,
            rotation_z: 0.0,
            rotation_w: 1.0,
            shape_x: 0.5,
            shape_y: 0.5,
            shape_z: 0.5,
            mass: 0.0,
            collision_layer: 1,
            collision_mask: u16::MAX.into(),
            sensor: true,
            continuous_collision: true,
        }));
        assert!(simulation.step(1.0 / 60.0, &[]));
        assert!(drain_events(&mut simulation).is_empty());

        // A pair born from a teleport is created on the step after the move (broadphase
        // latency), so the event lands one step behind the transform — identically on the
        // web path and under the old state poll. Delivery within a few steps, exactly once,
        // is the contract.
        assert!(simulation.set_body_transform(1, 0.1, 0.0, 0.0));
        let mut started = Vec::new();
        for _ in 0..3 {
            assert!(simulation.step(1.0 / 60.0, &[]));
            started = drain_events(&mut simulation);
            if !started.is_empty() {
                break;
            }
        }
        assert_eq!(
            started,
            vec![[0, 1, 1, 1]],
            "a sensor overlapping a dynamic body delivers one started event"
        );

        assert!(simulation.set_body_transform(1, 5.0, 0.0, 0.0));
        let mut stopped = Vec::new();
        for _ in 0..3 {
            assert!(simulation.step(1.0 / 60.0, &[]));
            stopped = drain_events(&mut simulation);
            if !stopped.is_empty() {
                break;
            }
        }
        assert_eq!(
            stopped,
            vec![[0, 1, 0, 1]],
            "a sensor leaving a dynamic body delivers one stopped event"
        );
    }

    #[test]
    fn events_for_removed_colliders_are_dropped() {
        let mut simulation = Simulation::new(TnPhysicsWorldOptions {
            gravity_x: 0.0,
            gravity_y: -9.81,
            gravity_z: 0.0,
        })
        .unwrap();
        assert!(simulation.add_body(fixed_box(0, 0.0, -0.5, 1)));
        assert!(simulation.add_body(TnPhysicsBodyOptions {
            id: 1,
            body_type: 0,
            shape_type: 0,
            position_x: 0.0,
            position_y: 2.0,
            position_z: 0.0,
            rotation_x: 0.0,
            rotation_y: 0.0,
            rotation_z: 0.0,
            rotation_w: 1.0,
            shape_x: 0.5,
            shape_y: 0.5,
            shape_z: 0.5,
            mass: 1.0,
            collision_layer: 1,
            collision_mask: u16::MAX.into(),
            sensor: false,
            continuous_collision: true,
        }));
        let mut landed = false;
        for _ in 0..240 {
            assert!(simulation.step(1.0 / 60.0, &[]));
            if !drain_events(&mut simulation).is_empty() {
                landed = true;
                break;
            }
        }
        assert!(landed, "the body must land before it is removed");

        // The web path maps events through `byCollider` and skips any event whose
        // collider no longer resolves to a body; removal must stay silent here too.
        assert!(simulation.remove_body(1));
        for _ in 0..5 {
            assert!(simulation.step(1.0 / 60.0, &[]));
            let events = drain_events(&mut simulation);
            for event in events {
                assert_ne!(event[0], 1);
                assert_ne!(event[1], 1);
            }
        }
    }

    #[test]
    fn contact_event_collection_scales_with_bodies_not_pairs() {
        // The event synthesis used to poll every body pair every step: O(n^2) narrow-phase
        // graph lookups regardless of what actually happened. Rapier's own events are
        // delivered per state transition, so steady-state per-step cost must not grow with
        // the square of the body count. n dynamic boxes rest on one floor, none touching
        // each other: n real contact pairs, zero transitions per settled step.
        let build = |count: usize| -> Simulation {
            let mut simulation = Simulation::new(TnPhysicsWorldOptions {
                gravity_x: 0.0,
                gravity_y: -9.81,
                gravity_z: 0.0,
            })
            .unwrap();
            assert!(simulation.add_body(TnPhysicsBodyOptions {
                id: 0,
                body_type: 1,
                shape_type: 0,
                position_x: 0.0,
                position_y: -0.5,
                position_z: 0.0,
                rotation_x: 0.0,
                rotation_y: 0.0,
                rotation_z: 0.0,
                rotation_w: 1.0,
                shape_x: count as f32,
                shape_y: 0.5,
                shape_z: 1.0,
                mass: 0.0,
                collision_layer: 1,
                collision_mask: u16::MAX.into(),
                sensor: false,
                continuous_collision: true,
            }));
            for index in 0..count {
                assert!(simulation.add_body(TnPhysicsBodyOptions {
                    id: index as u32 + 1,
                    body_type: 0,
                    shape_type: 0,
                    position_x: index as f32 * 1.5 - count as f32 * 0.75,
                    position_y: 2.0,
                    position_z: 0.0,
                    rotation_x: 0.0,
                    rotation_y: 0.0,
                    rotation_z: 0.0,
                    rotation_w: 1.0,
                    shape_x: 0.5,
                    shape_y: 0.5,
                    shape_z: 0.5,
                    mass: 1.0,
                    collision_layer: 1,
                    collision_mask: u16::MAX.into(),
                    sensor: false,
                    continuous_collision: true,
                }));
            }
            simulation
        };
        let settle_and_measure = |count: usize| -> u128 {
            let mut simulation = build(count);
            // Drop and settle: every box lands on the floor and emits its started event.
            let mut started_events = 0;
            for _ in 0..240 {
                assert!(simulation.step(1.0 / 60.0, &[]));
                started_events += drain_events(&mut simulation).len();
            }
            assert!(
                started_events >= count,
                "each of {count} boxes must deliver a started event, got {started_events}"
            );
            let mut best = u128::MAX;
            for _ in 0..3 {
                let start = std::time::Instant::now();
                let steps = 200;
                for _ in 0..steps {
                    assert!(simulation.step(1.0 / 60.0, &[]));
                    drain_events(&mut simulation);
                }
                best = best.min(start.elapsed().as_nanos() / steps);
            }
            best
        };
        let small = settle_and_measure(16);
        let large = settle_and_measure(128);
        let ratio = large as f64 / small as f64;
        println!(
            "contact-event scaling: n=16 {small} ns/step, n=128 {large} ns/step, ratio {ratio:.1}"
        );
        // The pairwise sweep measures ~60x here (8128+ pair lookups vs 120). Rapier's events
        // are proportional to state changes, so the ratio sits near the pipeline's own
        // growth (~8x for 8x the bodies). The bound is generous; the sweep fails it by 3x.
        assert!(
            ratio < 20.0,
            "per-step cost grew {ratio:.1}x for 8x the bodies: event synthesis is still polling pairs"
        );
    }

    #[test]
    fn area_mask_does_not_require_the_body_to_scan_the_area() {
        let mut simulation = Simulation::new(TnPhysicsWorldOptions {
            gravity_x: 0.0,
            gravity_y: 0.0,
            gravity_z: 0.0,
        })
        .unwrap();
        let body = |id, sensor, layer, mask| TnPhysicsBodyOptions {
            id,
            body_type: if sensor { 2 } else { 1 },
            shape_type: 0,
            position_x: 0.0,
            position_y: 0.0,
            position_z: 0.0,
            rotation_x: 0.0,
            rotation_y: 0.0,
            rotation_z: 0.0,
            rotation_w: 1.0,
            shape_x: if sensor { 1.0 } else { 0.5 },
            shape_y: if sensor { 1.0 } else { 0.5 },
            shape_z: if sensor { 1.0 } else { 0.5 },
            mass: 0.0,
            collision_layer: layer,
            collision_mask: mask,
            sensor,
            continuous_collision: true,
        };
        assert!(simulation.add_body(body(1, true, 8, 2)));
        assert!(simulation.add_body(body(2, false, 2, 4)));
        assert!(simulation.step(1.0 / 60.0, &[]));
        assert_eq!(simulation.area_intersections(), vec![[1, 2]]);
    }
    /// The car from `packages/physics/__tests__/vehicle-body.spec.ts`, in the same numbers: a
    /// 900 kg chassis on four 0.34 m wheels, front pair steering and rear pair driven.
    const CAR_RIDE: f32 = 0.3 + 0.34 + 0.15;

    fn car_wheel(x: f32, z: f32, steering: bool, traction: bool) -> [f32; VEHICLE_WHEEL_WIDTH] {
        [
            x, -0.15, z, // attachment point
            0.34,         // wheel radius
            0.3,          // suspension rest length
            100.0,        // suspension stiffness, mass-normalised
            2.3,          // damping compression
            4.4,          // damping relaxation
            10.5,         // friction slip
            0.3,          // max suspension travel
            f32::from(steering),
            f32::from(traction),
        ]
    }

    fn car_wheels() -> Vec<f32> {
        [
            car_wheel(-0.8, -1.2, true, false),
            car_wheel(0.8, -1.2, true, false),
            car_wheel(-0.8, 1.2, false, true),
            car_wheel(0.8, 1.2, false, true),
        ]
        .concat()
    }

    fn car_body(id: u32, y: f32) -> TnPhysicsBodyOptions {
        TnPhysicsBodyOptions {
            id,
            body_type: 0,
            shape_type: 0,
            position_x: 0.0,
            position_y: y,
            position_z: 0.0,
            rotation_x: 0.0,
            rotation_y: 0.0,
            rotation_z: 0.0,
            rotation_w: 1.0,
            shape_x: 0.8,
            shape_y: 0.25,
            shape_z: 1.8,
            mass: 900.0,
            collision_layer: 1,
            collision_mask: u16::MAX.into(),
            sensor: false,
            continuous_collision: false,
        }
    }

    /// The default `forwardAxis` is `-z`, whose axle is +x, so a positive engine force drives
    /// towards -z and a positive speed means the same thing.
    fn car_vehicle(id: u32, body_id: u32) -> TnPhysicsVehicleOptions {
        TnPhysicsVehicleOptions {
            id,
            body_id,
            forward_axis: 2,
            axle_x: 1.0,
            axle_y: 0.0,
            axle_z: 0.0,
            wheel_count: 4,
        }
    }

    fn car_on_a_floor() -> Simulation {
        let mut simulation = Simulation::new(TnPhysicsWorldOptions {
            gravity_x: 0.0,
            gravity_y: -9.81,
            gravity_z: 0.0,
        })
        .expect("the simulation is created");
        // A 0.5 m slab whose top face is at y = 0, exactly the floor the web spec builds, so the
        // strut it settles on is the same number both backends report.
        let mut floor = fixed_box(0, 0.0, -0.25, 1);
        floor.shape_x = 200.0;
        floor.shape_y = 0.25;
        floor.shape_z = 200.0;
        assert!(simulation.add_body(floor));
        assert!(simulation.add_body(car_body(1, CAR_RIDE + 0.05)));
        assert!(simulation.create_vehicle(car_vehicle(0, 1), &car_wheels()));
        simulation
    }

    fn vehicle_state(simulation: &Simulation) -> Vec<f32> {
        // Exactly what the JavaScript seam hands the C ABI: one speed float plus three per wheel.
        // Over-allocating here hid a stride mistake the desktop host reported as a short buffer.
        let mut output = vec![0.0; VEHICLE_SPEED_FLOATS + VEHICLE_WHEEL_STRIDE * 4];
        let count = simulation
            .write_vehicle_state(0, &mut output)
            .expect("the vehicle exists");
        assert_eq!(count, output.len(), "the read must fill exactly what it claims");
        output
    }

    #[test]
    fn a_vehicle_settles_on_its_suspension_with_every_wheel_loaded() {
        let mut simulation = car_on_a_floor();
        for _ in 0..300 {
            assert!(simulation.step(1.0 / 60.0, &[]));
        }

        let state = vehicle_state(&simulation);
        assert!(state[0].abs() < 0.01, "parked car read {}", state[0]);
        for wheel in 0..4 {
            let contact = state[VEHICLE_SPEED_FLOATS + VEHICLE_WHEEL_STRIDE * wheel];
            let length = state[VEHICLE_SPEED_FLOATS + VEHICLE_WHEEL_STRIDE * wheel + 1];
            assert_eq!(contact, 1.0, "wheel {wheel} is not on the ground");
            assert!(length > 0.0 && length < 0.3, "wheel {wheel} strut is {length}");
        }
        // Carried by the springs, not resting on its own collider: the floor top is at 0, and a
        // settled chassis rides a radius, a strut and half its own box above it.
        let y = simulation.bodies[simulation.entries[&1].body].translation().y;
        assert!(y > 0.7, "the chassis sank to {y}");
    }

    #[test]
    fn engine_force_drives_forward_along_the_signed_forward_axis() {
        let mut simulation = car_on_a_floor();
        assert!(simulation.set_vehicle_input(0, 4000.0, 0.0, 0.0));
        for _ in 0..180 {
            assert!(simulation.step(1.0 / 60.0, &[]));
        }

        let state = vehicle_state(&simulation);
        assert!(state[0] > 5.0, "three seconds of thrust reached {}", state[0]);
        let z = simulation.bodies[simulation.entries[&1].body].translation().z;
        assert!(z < -5.0, "the car drove to z {z} instead of -z");
    }

    #[test]
    fn braking_stops_the_car_from_its_running_speed() {
        let mut simulation = car_on_a_floor();
        assert!(simulation.set_vehicle_input(0, 4000.0, 0.0, 0.0));
        for _ in 0..120 {
            assert!(simulation.step(1.0 / 60.0, &[]));
        }
        let running = vehicle_state(&simulation)[0].abs();
        assert!(simulation.set_vehicle_input(0, 0.0, 60.0, 0.0));

        let mut seconds = 0.0;
        while vehicle_state(&simulation)[0].abs() > 0.2 && seconds < 3.0 {
            assert!(simulation.step(1.0 / 60.0, &[]));
            seconds += 1.0 / 60.0;
        }

        assert!(running > 5.0, "braking from {running}");
        assert!(seconds < 3.0, "braking took {seconds}s");
    }

    #[test]
    fn reset_moves_and_turns_the_car_and_removing_the_chassis_frees_the_vehicle() {
        let mut simulation = car_on_a_floor();
        for _ in 0..60 {
            assert!(simulation.step(1.0 / 60.0, &[]));
        }

        assert!(simulation.reset_vehicle(0, 10.0, CAR_RIDE, 40.0, std::f32::consts::PI));
        for _ in 0..10 {
            assert!(simulation.step(1.0 / 60.0, &[]));
        }
        let body = simulation.entries[&1].body;
        let translation = *simulation.bodies[body].translation();
        assert!((translation.x - 10.0).abs() < 0.01 && (translation.z - 40.0).abs() < 0.01);
        assert!(vehicle_state(&simulation)[0].abs() < 0.5);

        // Facing the other way, the same positive engine force is now +z.
        assert!(simulation.set_vehicle_input(0, 4000.0, 0.0, 0.0));
        for _ in 0..120 {
            assert!(simulation.step(1.0 / 60.0, &[]));
        }
        assert!(vehicle_state(&simulation)[0] > 5.0);
        assert!(simulation.bodies[body].translation().z > 41.0);

        assert!(simulation.remove_body(1));
        assert!(simulation.write_vehicle_state(0, &mut [0.0; 4]).is_none());
        assert!(simulation.step(1.0 / 60.0, &[]));
    }

    #[test]
    fn a_vehicle_is_refused_for_a_car_it_cannot_drive() {
        let mut simulation = car_on_a_floor();
        // A fixed chassis has nothing to drive, an empty wheel list has nothing to stand on, and
        // a zero-radius wheel divides the suspension term.
        let mut fixed = car_body(2, CAR_RIDE);
        fixed.body_type = 1;
        assert!(simulation.add_body(fixed));
        assert!(!simulation.create_vehicle(car_vehicle(1, 2), &car_wheels()));
        assert!(!simulation.create_vehicle(car_vehicle(1, 99), &car_wheels()));
        assert!(!simulation.create_vehicle(car_vehicle(1, 1), &[]));
        let mut wheels = car_wheels();
        wheels[3] = 0.0;
        assert!(!simulation.create_vehicle(car_vehicle(1, 1), &wheels));
        let mut sideways = car_vehicle(1, 1);
        sideways.forward_axis = 1;
        assert!(!simulation.create_vehicle(sideways, &car_wheels()));
        assert!(!simulation.set_vehicle_input(99, 0.0, 0.0, 0.0));
        assert!(!simulation.set_vehicle_input(0, f32::NAN, 0.0, 0.0));
        assert!(!simulation.reset_vehicle(99, 0.0, 0.0, 0.0, 0.0));
        assert!(!simulation.reset_vehicle(0, f32::NAN, 0.0, 0.0, 0.0));
    }
}
