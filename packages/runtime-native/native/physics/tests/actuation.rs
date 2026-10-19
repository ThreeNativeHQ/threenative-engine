use std::collections::BTreeMap;

use threenative_native_physics::{
    tn_physics_add_body, tn_physics_apply_body_force, tn_physics_apply_body_force_at_point,
    tn_physics_apply_body_impulse,
    tn_physics_configure_character, tn_physics_create, tn_physics_destroy,
    tn_physics_read_body_linear_velocity, tn_physics_read_body_sleep_states,
    tn_physics_read_visible_transforms, tn_physics_set_body_linear_velocity, tn_physics_step,
    TnPhysicsBodyOptions, TnPhysicsCharacterOptions, TnPhysicsVector3, TnPhysicsWorldOptions,
};

const TRANSFORM_WIDTH: usize = 8;
const ACTUATION_OK: i32 = 1;
const ACTUATION_UNKNOWN_BODY: i32 = 0;
const ACTUATION_NOT_DYNAMIC: i32 = -1;
const ACTUATION_NON_FINITE: i32 = -2;

fn world(gravity_y: f32) -> *mut threenative_native_physics::Simulation {
    tn_physics_create(&TnPhysicsWorldOptions {
        gravity_x: 0.0,
        gravity_y,
        gravity_z: 0.0,
    })
}

fn body(
    id: u32,
    body_type: u32,
    shape_type: u32,
    x: f32,
    y: f32,
    shape_x: f32,
    shape_y: f32,
    shape_z: f32,
    mass: f32,
) -> TnPhysicsBodyOptions {
    TnPhysicsBodyOptions {
        id,
        body_type,
        shape_type,
        position_x: x,
        position_y: y,
        position_z: 0.0,
        rotation_x: 0.0,
        rotation_y: 0.0,
        rotation_z: 0.0,
        rotation_w: 1.0,
        shape_x,
        shape_y,
        shape_z,
        mass,
        collision_layer: 1,
        collision_mask: u16::MAX.into(),
        sensor: false,
        continuous_collision: true,
    }
}

fn body_with_groups(
    mut options: TnPhysicsBodyOptions,
    collision_layer: u32,
    collision_mask: u32,
) -> TnPhysicsBodyOptions {
    options.collision_layer = collision_layer;
    options.collision_mask = collision_mask;
    options
}

fn positions(
    simulation: *const threenative_native_physics::Simulation,
    body_count: usize,
) -> BTreeMap<u32, [f32; 3]> {
    let mut output = vec![0.0; body_count * TRANSFORM_WIDTH];
    let count = tn_physics_read_visible_transforms(simulation, output.as_mut_ptr(), output.len());
    assert_eq!(count, body_count as i32);
    (0..count as usize)
        .map(|index| {
            let offset = index * TRANSFORM_WIDTH;
            (
                output[offset] as u32,
                [output[offset + 1], output[offset + 2], output[offset + 3]],
            )
        })
        .collect()
}

#[test]
fn impulse_moves_a_dynamic_body_from_rest() {
    let simulation = world(0.0);
    assert!(!simulation.is_null());
    assert!(tn_physics_add_body(
        simulation,
        &body(7, 0, 0, 0.0, 0.0, 0.5, 0.5, 0.5, 1.0),
    ));

    let start = positions(simulation, 1)[&7][0];
    let mut velocity = TnPhysicsVector3::default();
    assert_eq!(
        tn_physics_read_body_linear_velocity(simulation, 7, &mut velocity),
        ACTUATION_OK
    );
    assert_eq!([velocity.x, velocity.y, velocity.z], [0.0, 0.0, 0.0]);

    assert_eq!(
        tn_physics_apply_body_impulse(simulation, 7, 2.0, 0.0, 0.0),
        ACTUATION_OK
    );
    assert_eq!(
        tn_physics_read_body_linear_velocity(simulation, 7, &mut velocity),
        ACTUATION_OK
    );
    assert!(
        velocity.x > 0.0,
        "impulse did not change velocity: x={}",
        velocity.x
    );
    assert!(tn_physics_step(simulation, 1.0 / 60.0, std::ptr::null(), 0));
    let end = positions(simulation, 1)[&7][0];
    assert!(
        end > start,
        "impulse did not move the body: start={start}, end={end}"
    );

    tn_physics_destroy(simulation);
}

#[test]
fn force_accumulates_motion_over_steps() {
    let simulation = world(0.0);
    assert!(!simulation.is_null());
    assert!(tn_physics_add_body(
        simulation,
        &body(7, 0, 0, 0.0, 0.0, 0.5, 0.5, 0.5, 1.0),
    ));

    let start = positions(simulation, 1)[&7][0];
    for _ in 0..30 {
        assert_eq!(
            tn_physics_apply_body_force(simulation, 7, 20.0, 0.0, 0.0),
            ACTUATION_OK
        );
        assert!(tn_physics_step(simulation, 1.0 / 60.0, std::ptr::null(), 0));
    }
    let end = positions(simulation, 1)[&7][0];
    let velocity = linear_velocity(simulation, 7);
    assert!(
        end - start > 0.5,
        "force did not move the body enough: start={start}, end={end}"
    );
    assert!(
        velocity[0] > 0.0,
        "force did not accumulate velocity: x={}",
        velocity[0]
    );

    tn_physics_destroy(simulation);
}

#[test]
fn force_at_point_produces_angular_motion() {
    let simulation = world(0.0);
    assert!(!simulation.is_null());
    assert!(tn_physics_add_body(
        simulation,
        &body(7, 0, 0, 0.0, 0.0, 0.5, 0.5, 0.5, 1.0),
    ));

    assert_eq!(
        tn_physics_apply_body_force_at_point(simulation, 7, 0.0, 20.0, 0.0, 1.0, 0.0, 0.0),
        ACTUATION_OK
    );
    assert!(tn_physics_step(simulation, 1.0 / 60.0, std::ptr::null(), 0));

    let mut transform = vec![0.0; TRANSFORM_WIDTH];
    assert_eq!(
        tn_physics_read_visible_transforms(simulation, transform.as_mut_ptr(), transform.len()),
        1
    );
    assert!(
        transform[6].abs() > 1e-6,
        "off-center force did not rotate the body: qz={}",
        transform[6]
    );

    tn_physics_destroy(simulation);
}

/// Angle between the rotations of two transform records (id, position xyz, quaternion xyzw).
fn turned(a: &[f32], b: &[f32]) -> f32 {
    let dot = (a[4] * b[4] + a[5] * b[5] + a[6] * b[6] + a[7] * b[7])
        .abs()
        .min(1.0);
    2.0 * dot.acos()
}

#[test]
fn force_at_point_torque_lasts_one_step() {
    let simulation = world(0.0);
    assert!(!simulation.is_null());
    assert!(tn_physics_add_body(
        simulation,
        &body(7, 0, 0, 0.0, 0.0, 0.5, 0.5, 0.5, 1.0),
    ));
    assert_eq!(
        tn_physics_apply_body_force_at_point(simulation, 7, 0.0, 20.0, 0.0, 1.0, 0.0, 0.0),
        ACTUATION_OK
    );
    let mut previous = vec![0.0; TRANSFORM_WIDTH];
    let mut current = vec![0.0; TRANSFORM_WIDTH];
    let mut spins = Vec::new();
    for _ in 0..12 {
        previous.copy_from_slice(&current);
        assert!(tn_physics_step(simulation, 1.0 / 60.0, std::ptr::null(), 0));
        tn_physics_read_visible_transforms(simulation, current.as_mut_ptr(), current.len());
        spins.push(turned(&previous, &current));
    }
    // One step of torque leaves a constant spin; a torque the backend kept would spin it up.
    let early = spins[2];
    let late = spins[11];
    assert!(early > 1e-4, "off-centre force did not spin the body: {early}");
    assert!(
        (late - early).abs() < early * 0.05,
        "torque lingered past its step: spin went {early} -> {late}"
    );
    tn_physics_destroy(simulation);
}

#[test]
fn linear_velocity_round_trips_independently() {
    let simulation = world(0.0);
    assert!(!simulation.is_null());
    assert!(tn_physics_add_body(
        simulation,
        &body(7, 0, 0, 0.0, 0.0, 0.5, 0.5, 0.5, 1.0),
    ));

    assert_eq!(
        tn_physics_set_body_linear_velocity(simulation, 7, 4.0, -2.0, 1.0),
        ACTUATION_OK
    );
    assert_eq!(linear_velocity(simulation, 7), [4.0, -2.0, 1.0]);

    tn_physics_destroy(simulation);
}

#[test]
fn actuation_wakes_a_sleeping_dynamic_body() {
    let simulation = world(0.0);
    assert!(!simulation.is_null());
    assert!(tn_physics_add_body(
        simulation,
        &body(7, 0, 0, 0.0, 0.0, 0.5, 0.5, 0.5, 1.0),
    ));

    for _ in 0..240 {
        assert!(tn_physics_step(simulation, 1.0 / 60.0, std::ptr::null(), 0));
    }
    assert_eq!(sleep_state(simulation, 7), 1.0);
    let start = positions(simulation, 1)[&7][0];

    assert_eq!(
        tn_physics_apply_body_impulse(simulation, 7, 8.0, 0.0, 0.0),
        ACTUATION_OK
    );
    assert_eq!(sleep_state(simulation, 7), 0.0);
    for _ in 0..30 {
        assert!(tn_physics_step(simulation, 1.0 / 60.0, std::ptr::null(), 0));
    }
    let end = positions(simulation, 1)[&7][0];
    assert!(
        end > start,
        "woken body did not move: start={start}, end={end}"
    );

    tn_physics_destroy(simulation);
}

#[test]
fn actuation_returns_fail_closed_status_codes() {
    let simulation = world(0.0);
    assert!(!simulation.is_null());
    assert!(tn_physics_add_body(
        simulation,
        &body(7, 0, 0, 0.0, 0.0, 0.5, 0.5, 0.5, 1.0),
    ));
    assert!(tn_physics_add_body(
        simulation,
        &body(8, 1, 0, 3.0, 0.0, 0.5, 0.5, 0.5, 0.0),
    ));

    assert_eq!(
        tn_physics_apply_body_impulse(simulation, 8, 1.0, 0.0, 0.0),
        ACTUATION_NOT_DYNAMIC
    );
    assert_eq!(
        tn_physics_apply_body_force(simulation, 99, 1.0, 0.0, 0.0),
        ACTUATION_UNKNOWN_BODY
    );
    assert_eq!(
        tn_physics_set_body_linear_velocity(simulation, 7, f32::NAN, 0.0, 0.0),
        ACTUATION_NON_FINITE
    );

    tn_physics_destroy(simulation);
}

fn linear_velocity(simulation: *const threenative_native_physics::Simulation, id: u32) -> [f32; 3] {
    let mut velocity = TnPhysicsVector3::default();
    assert_eq!(
        tn_physics_read_body_linear_velocity(simulation, id, &mut velocity),
        ACTUATION_OK
    );
    [velocity.x, velocity.y, velocity.z]
}

fn sleep_state(simulation: *const threenative_native_physics::Simulation, id: u32) -> f32 {
    let mut output = [0.0; 2];
    assert_eq!(
        tn_physics_read_body_sleep_states(simulation, output.as_mut_ptr(), output.len()),
        1
    );
    assert_eq!(output[0], id as f32);
    output[1]
}

fn character_displacement(pushes_dynamic_bodies: bool) -> f32 {
    let simulation = world(0.0);
    assert!(!simulation.is_null());
    assert!(tn_physics_add_body(
        simulation,
        &body(0, 1, 0, 0.0, -0.5, 20.0, 0.5, 20.0, 0.0),
    ));
    assert!(tn_physics_add_body(
        simulation,
        &body(1, 0, 0, 1.2, 0.5, 0.5, 0.5, 0.5, 1.0),
    ));
    assert!(tn_physics_add_body(
        simulation,
        &body(2, 3, 2, -0.5, 0.5, 0.3, 0.3, 0.0, 0.0),
    ));
    assert!(tn_physics_configure_character(
        simulation,
        &TnPhysicsCharacterOptions {
            id: 2,
            offset: 0.01,
            max_slope_climb_angle: std::f32::consts::FRAC_PI_4,
            autostep_enabled: false,
            autostep_max_height: 0.0,
            autostep_min_width: 0.0,
            autostep_include_dynamic_bodies: false,
            snap_to_ground_enabled: false,
            snap_to_ground: 0.0,
            one_way_layers: 0,
            pushes_dynamic_bodies,
        },
    ));

    let start = positions(simulation, 3)[&1][0];
    for _ in 0..90 {
        let current = positions(simulation, 3)[&2];
        let input = [
            2.0,
            current[0] + 2.4 / 60.0,
            current[1],
            current[2],
            0.0,
            0.0,
            0.0,
            1.0,
        ];
        assert!(tn_physics_step(simulation, 1.0 / 60.0, input.as_ptr(), 1));
    }
    let displacement = positions(simulation, 3)[&1][0] - start;
    tn_physics_destroy(simulation);
    displacement
}

#[test]
fn character_pushes_dynamic_bodies_only_when_enabled() {
    let pushed = character_displacement(true);
    let ignored = character_displacement(false);

    assert!(
        pushed > 0.1,
        "expected a pushed crate, displacement={pushed}"
    );
    // This must be an absolute no-push control: a ratio assertion can pass after both paths break.
    assert!(
        ignored.abs() < 0.01,
        "disabled push still moved the crate: enabled={pushed}, disabled={ignored}"
    );
}

#[test]
fn character_push_respects_collision_groups() {
    let simulation = world(0.0);
    assert!(!simulation.is_null());
    assert!(tn_physics_add_body(
        simulation,
        &body_with_groups(
            body(1, 0, 0, 2.2, 0.5, 0.5, 0.5, 0.5, 1.0),
            2,
            1,
        ),
    ));
    assert!(tn_physics_add_body(
        simulation,
        &body_with_groups(
            body(3, 0, 0, 1.2, 0.5, 0.5, 0.5, 0.5, 1.0),
            4,
            1,
        ),
    ));
    assert!(tn_physics_add_body(
        simulation,
        &body_with_groups(
            body(2, 3, 2, -0.5, 0.5, 0.3, 0.3, 0.0, 0.0),
            1,
            2,
        ),
    ));
    assert!(tn_physics_configure_character(
        simulation,
        &TnPhysicsCharacterOptions {
            id: 2,
            offset: 0.01,
            max_slope_climb_angle: std::f32::consts::FRAC_PI_4,
            autostep_enabled: false,
            autostep_max_height: 0.0,
            autostep_min_width: 0.0,
            autostep_include_dynamic_bodies: false,
            snap_to_ground_enabled: false,
            snap_to_ground: 0.0,
            one_way_layers: 0,
            pushes_dynamic_bodies: true,
        },
    ));

    let start = positions(simulation, 3);
    for _ in 0..90 {
        let current = positions(simulation, 3)[&2];
        let input = [
            2.0,
            current[0] + 2.4 / 60.0,
            current[1],
            current[2],
            0.0,
            0.0,
            0.0,
            1.0,
        ];
        assert!(tn_physics_step(simulation, 1.0 / 60.0, input.as_ptr(), 1));
    }
    let end = positions(simulation, 3);
    let included_displacement = end[&1][0] - start[&1][0];
    let excluded_displacement = end[&3][0] - start[&3][0];
    assert!(
        included_displacement > 0.1,
        "expected an included crate to move: displacement={included_displacement}"
    );
    assert!(
        excluded_displacement.abs() < 0.01,
        "excluded crate moved: displacement={excluded_displacement}"
    );

    tn_physics_destroy(simulation);
}
