use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::CStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;
use threenative_native_physics::{
    Simulation, TnPhysicsBodyOptions, TnPhysicsCharacterOptions, TnPhysicsWorldOptions,
    tn_physics_add_body, tn_physics_configure_character, tn_physics_create, tn_physics_destroy,
    tn_physics_drain_collision_events, tn_physics_read_area_intersections,
    tn_physics_read_character_states, tn_physics_read_visible_transforms, tn_physics_remove_body,
    tn_physics_set_body_transform, tn_physics_step, tn_physics_version,
};

const TRANSFORM_WIDTH: usize = 8;
const EVENT_WIDTH: usize = 4;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Versions {
    web: String,
    rust: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Body {
    id: u32,
    name: String,
    #[serde(rename = "type")]
    body_type: String,
    shape: String,
    shape_size: [f32; 3],
    position: [f32; 3],
    mass: f32,
    collision_layer: u32,
    collision_mask: u32,
    sensor: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Character {
    body_id: u32,
    offset: f32,
    max_slope_climb_angle: f32,
    autostep: [f32; 3],
    snap_to_ground: f32,
    one_way_layers: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Motion {
    body_id: u32,
    start_step: usize,
    end_step: usize,
    delta: [f32; 3],
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Scenario {
    schema_version: u32,
    expected_rapier_versions: Versions,
    gravity: [f32; 3],
    delta_time: f32,
    steps: usize,
    remove_at_step: usize,
    remove_body_id: u32,
    teleport_at_step: usize,
    teleport_body_id: u32,
    teleport_position: [f32; 3],
    bodies: Vec<Body>,
    character: Character,
    motions: Vec<Motion>,
    checkpoints: Vec<usize>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Freshness {
    state_present: bool,
    area_count: i32,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TeleportState {
    before_grounded: bool,
    after_grounded: bool,
    before_ground_collider: Option<u32>,
    after_ground_collider: Option<u32>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BufferBytes {
    event: usize,
    area: usize,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScenarioCoverage {
    one_way_passed_upward: bool,
    platform_grounded_observed: bool,
    area_excluded_character: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct FeetOnFloor {
    grounded: bool,
    ground_collider: Option<u32>,
    ground_normal: [f32; 3],
    position: [f32; 3],
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Observation {
    arm: String,
    rapier_version: String,
    scenario_sha256: String,
    body_count: usize,
    resting_position: [f32; 3],
    character_displacement: [f32; 3],
    grounded: bool,
    ground_collider: Option<u32>,
    ground_normal: [f32; 3],
    area_membership: Vec<u32>,
    area_membership_snapshots: Vec<String>,
    collision_event_set: Vec<String>,
    collision_event_sequence: Vec<String>,
    remove_stopped_event_count: usize,
    freshness_before_visible: Freshness,
    teleport_state: TeleportState,
    validation_outcomes: BTreeMap<String, String>,
    average_step_nanoseconds: f64,
    quadratic_buffer_bytes: BufferBytes,
    scenario_coverage: ScenarioCoverage,
    feet_on_floor: FeetOnFloor,
    /// Every visible transform record after each checkpoint step and after the last step; the
    /// committed native table that the web Wasm build is checked against (PRD-899).
    #[serde(skip)]
    checkpoint_transforms: Vec<TransformCheckpoint>,
}

#[derive(Clone, Deserialize, Serialize, PartialEq)]
struct TransformCheckpoint {
    step: usize,
    transforms: Vec<[f32; TRANSFORM_WIDTH]>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TransformTable {
    scenario_sha256: String,
    rapier_version: String,
    tolerance: f32,
    checkpoints: Vec<TransformCheckpoint>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Comparison {
    scenario_sha256: String,
    web_version: String,
    rust_version: String,
    resting_position_max_axis_delta: f32,
    character_displacement_max_axis_delta: f32,
    grounded_mismatch: u32,
    ground_collider_mismatch: u32,
    ground_normal_max_axis_delta: f32,
    area_membership_symmetric_difference: usize,
    collision_event_symmetric_difference: usize,
    collision_event_sequence_mismatch: u32,
    validation_outcome_mismatches: usize,
    remove_stopped_event_count_delta: usize,
    teleport_grounded_mismatch: u32,
    average_step_nanoseconds_delta: f64,
    scenario_coverage_mismatches: usize,
    feet_on_floor_grounded_mismatch: u32,
    feet_on_floor_ground_collider_mismatch: u32,
    feet_on_floor_normal_max_axis_delta: f32,
    feet_on_floor_position_max_axis_delta: f32,
}

fn fixture_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../physics/__tests__/fixtures/physics-parity.scenario.json")
}

fn artifact_path(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join(name)
}

fn body_type(value: &str) -> u32 {
    match value {
        "dynamic" => 0,
        "fixed" => 1,
        "kinematic" => 2,
        "character" => 3,
        other => panic!("unknown fixture body type {other}"),
    }
}

fn shape_type(value: &str) -> u32 {
    match value {
        "box" => 0,
        "sphere" => 1,
        "capsule" => 2,
        other => panic!("unknown fixture shape {other}"),
    }
}

fn positions(simulation: *const Simulation, capacity: usize) -> BTreeMap<u32, [f32; 3]> {
    let mut output = vec![0.0; capacity * TRANSFORM_WIDTH];
    let count = tn_physics_read_visible_transforms(simulation, output.as_mut_ptr(), output.len());
    assert!(
        count >= 0,
        "shipping Simulation rejected its parity transform buffer"
    );
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

fn transform_records(
    simulation: *const Simulation,
    capacity: usize,
) -> Vec<[f32; TRANSFORM_WIDTH]> {
    let mut output = vec![0.0; capacity * TRANSFORM_WIDTH];
    let count = tn_physics_read_visible_transforms(simulation, output.as_mut_ptr(), output.len());
    assert!(
        count >= 0,
        "shipping Simulation rejected its parity transform buffer"
    );
    output[..count as usize * TRANSFORM_WIDTH]
        .chunks_exact(TRANSFORM_WIDTH)
        .map(|record| record.try_into().expect("chunks_exact yields full records"))
        .collect()
}

fn character_state(
    simulation: *const Simulation,
    body_id: u32,
) -> Option<(bool, Option<u32>, [f32; 3])> {
    let mut output = [0.0; 6];
    let count = tn_physics_read_character_states(simulation, output.as_mut_ptr(), output.len());
    assert!(
        count >= 0,
        "shipping Simulation rejected its parity character buffer"
    );
    (0..count as usize).find_map(|index| {
        let offset = index * 6;
        (output[offset] as u32 == body_id).then(|| {
            (
                output[offset + 1] == 1.0,
                (output[offset + 2] >= 0.0).then_some(output[offset + 2] as u32),
                [output[offset + 3], output[offset + 4], output[offset + 5]],
            )
        })
    })
}

fn area_membership(simulation: *const Simulation, area_id: u32) -> Vec<u32> {
    let mut output = [0_u32; 128];
    let count = tn_physics_read_area_intersections(simulation, output.as_mut_ptr(), output.len());
    assert!(
        count >= 0,
        "shipping Simulation rejected its parity area buffer"
    );
    let mut result = (0..count as usize)
        .filter_map(|index| {
            let offset = index * 2;
            (output[offset] == area_id).then_some(output[offset + 1])
        })
        .collect::<Vec<_>>();
    result.sort_unstable();
    result
}

fn drain_events(simulation: *mut Simulation, body_count: usize) -> Vec<String> {
    let mut output = vec![0_u32; body_count * body_count * EVENT_WIDTH];
    let count = tn_physics_drain_collision_events(simulation, output.as_mut_ptr(), output.len());
    assert!(
        count >= 0,
        "shipping Simulation rejected its parity event buffer"
    );
    (0..count as usize)
        .map(|index| {
            let offset = index * EVENT_WIDTH;
            let left = output[offset].min(output[offset + 1]);
            let right = output[offset].max(output[offset + 1]);
            format!("{left}-{right}-{}", output[offset + 2])
        })
        .collect()
}

fn feet_on_floor_subject() -> FeetOnFloor {
    let simulation = tn_physics_create(&TnPhysicsWorldOptions {
        gravity_x: 0.0,
        gravity_y: -9.81,
        gravity_z: 0.0,
    });
    assert!(!simulation.is_null());
    assert!(tn_physics_add_body(
        simulation,
        &TnPhysicsBodyOptions {
            id: 0,
            body_type: 1,
            shape_type: 0,
            position_x: 0.0,
            position_y: -0.1,
            position_z: 0.0,
            rotation_x: 0.0,
            rotation_y: 0.0,
            rotation_z: 0.0,
            rotation_w: 1.0,
            shape_x: 5.0,
            shape_y: 0.1,
            shape_z: 2.0,
            mass: 0.0,
            collision_layer: 1,
            collision_mask: u16::MAX.into(),
            sensor: false,
            continuous_collision: false,
        }
    ));
    assert!(tn_physics_add_body(
        simulation,
        &TnPhysicsBodyOptions {
            id: 1,
            body_type: 3,
            shape_type: 2,
            position_x: 0.0,
            position_y: 0.5,
            position_z: 0.0,
            rotation_x: 0.0,
            rotation_y: 0.0,
            rotation_z: 0.0,
            rotation_w: 1.0,
            shape_x: 0.2,
            shape_y: 0.3,
            shape_z: 0.0,
            mass: 0.0,
            collision_layer: 1,
            collision_mask: u16::MAX.into(),
            sensor: false,
            continuous_collision: false,
        }
    ));
    assert!(tn_physics_configure_character(
        simulation,
        &TnPhysicsCharacterOptions {
            id: 1,
            offset: 0.01,
            max_slope_climb_angle: std::f32::consts::FRAC_PI_4,
            autostep_enabled: false,
            autostep_max_height: 0.0,
            autostep_min_width: 0.0,
            autostep_include_dynamic_bodies: false,
            snap_to_ground_enabled: false,
            snap_to_ground: 0.0,
            one_way_layers: 0,
            pushes_dynamic_bodies: false,
        }
    ));

    let mut y = 0.5;
    let mut velocity_y = 0.0;
    for _ in 0..30 {
        velocity_y += -9.81 / 60.0;
        y += velocity_y / 60.0;
        let input = [1.0, 0.0, y, 0.0, 0.0, 0.0, 0.0, 1.0];
        assert!(tn_physics_step(simulation, 1.0 / 60.0, input.as_ptr(), 1));
        y = positions(simulation, 2)[&1][1];
        if character_state(simulation, 1).is_some_and(|state| state.0) && velocity_y < 0.0 {
            velocity_y = 0.0;
        }
    }
    let state = character_state(simulation, 1).expect("feet-on-floor state must exist");
    let position = positions(simulation, 2)[&1];
    tn_physics_destroy(simulation);
    FeetOnFloor {
        grounded: state.0,
        ground_collider: state.1,
        ground_normal: state.2,
        position,
    }
}

#[test]
fn preserves_repeated_area_crossing_edges_in_order() {
    let simulation = tn_physics_create(&TnPhysicsWorldOptions {
        gravity_x: 0.0,
        gravity_y: 0.0,
        gravity_z: 0.0,
    });
    assert!(!simulation.is_null());
    assert!(tn_physics_add_body(
        simulation,
        &TnPhysicsBodyOptions {
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
            shape_x: 1.0,
            shape_y: 1.0,
            shape_z: 1.0,
            mass: 0.0,
            collision_layer: 1,
            collision_mask: u16::MAX.into(),
            sensor: true,
            continuous_collision: true,
        },
    ));
    assert!(tn_physics_add_body(
        simulation,
        &TnPhysicsBodyOptions {
            id: 1,
            body_type: 2,
            shape_type: 0,
            position_x: -3.0,
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
            sensor: false,
            continuous_collision: true,
        },
    ));

    let mut was_inside = false;
    let mut edges = Vec::new();
    for position_x in [0.0, 3.0, 0.0, 3.0] {
        let input = [1.0, position_x, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0];
        assert!(tn_physics_step(
            simulation,
            1.0 / 60.0,
            input.as_ptr(),
            1,
        ));
        let is_inside = area_membership(simulation, 0).contains(&1);
        match (was_inside, is_inside) {
            (false, true) => edges.push("entered"),
            (true, false) => edges.push("exited"),
            _ => {}
        }
        was_inside = is_inside;
    }
    tn_physics_destroy(simulation);

    assert_eq!(edges, ["entered", "exited", "entered", "exited"]);
}

fn validation_outcomes(scenario: &Scenario) -> BTreeMap<String, String> {
    let options = TnPhysicsWorldOptions {
        gravity_x: scenario.gravity[0],
        gravity_y: scenario.gravity[1],
        gravity_z: scenario.gravity[2],
    };
    let simulation = tn_physics_create(&options);
    assert!(!simulation.is_null());
    let body = TnPhysicsBodyOptions {
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
        shape_x: 1.0,
        shape_y: 1.0,
        shape_z: 1.0,
        mass: 0.0,
        collision_layer: 1,
        collision_mask: 65535,
        sensor: false,
        continuous_collision: true,
    };
    assert!(tn_physics_add_body(simulation, &body));
    let unknown = [999.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0];
    let mut outcomes = BTreeMap::new();
    outcomes.insert(
        "nonFiniteDelta".into(),
        if tn_physics_step(simulation, f32::NAN, std::ptr::null(), 0) {
            "accepted"
        } else {
            "rejected"
        }
        .into(),
    );
    outcomes.insert(
        "float64Input".into(),
        "NOT REPRODUCIBLE ON THIS HOST".into(),
    );
    outcomes.insert(
        "oversizedKinematicCount".into(),
        "NOT REPRODUCIBLE ON THIS HOST".into(),
    );
    outcomes.insert(
        "unknownKinematicId".into(),
        if tn_physics_step(simulation, scenario.delta_time, unknown.as_ptr(), 1) {
            "accepted"
        } else {
            "rejected"
        }
        .into(),
    );
    outcomes.insert(
        "unknownRemoveBody".into(),
        if tn_physics_remove_body(simulation, 999) {
            "accepted"
        } else {
            "rejected"
        }
        .into(),
    );
    let mut undersized = [];
    outcomes.insert(
        "undersizedRenderBuffer".into(),
        if tn_physics_read_visible_transforms(simulation, undersized.as_mut_ptr(), 0) >= 0 {
            "accepted"
        } else {
            "rejected"
        }
        .into(),
    );
    tn_physics_destroy(simulation);
    outcomes
}

fn run_scenario(scenario: &Scenario, sha: &str, version: &str) -> Observation {
    let options = TnPhysicsWorldOptions {
        gravity_x: scenario.gravity[0],
        gravity_y: scenario.gravity[1],
        gravity_z: scenario.gravity[2],
    };
    let simulation = tn_physics_create(&options);
    assert!(!simulation.is_null(), "shipping Simulation must construct");
    for body in &scenario.bodies {
        let options = TnPhysicsBodyOptions {
            id: body.id,
            body_type: body_type(&body.body_type),
            shape_type: shape_type(&body.shape),
            position_x: body.position[0],
            position_y: body.position[1],
            position_z: body.position[2],
            rotation_x: 0.0,
            rotation_y: 0.0,
            rotation_z: 0.0,
            rotation_w: 1.0,
            shape_x: body.shape_size[0],
            shape_y: body.shape_size[1],
            shape_z: body.shape_size[2],
            mass: body.mass,
            collision_layer: body.collision_layer,
            collision_mask: body.collision_mask,
            sensor: body.sensor,
            continuous_collision: true,
        };
        assert!(
            tn_physics_add_body(simulation, &options),
            "{} must be accepted",
            body.name
        );
    }
    let character = &scenario.character;
    let character_options = TnPhysicsCharacterOptions {
        id: character.body_id,
        offset: character.offset,
        max_slope_climb_angle: character.max_slope_climb_angle,
        autostep_enabled: true,
        autostep_max_height: character.autostep[0],
        autostep_min_width: character.autostep[1],
        autostep_include_dynamic_bodies: character.autostep[2] == 1.0,
        snap_to_ground_enabled: true,
        snap_to_ground: character.snap_to_ground,
        one_way_layers: character.one_way_layers,
        pushes_dynamic_bodies: false,
    };
    assert!(tn_physics_configure_character(
        simulation,
        &character_options
    ));

    let initial = positions(simulation, scenario.bodies.len());
    let initial_character = initial[&character.body_id];
    let mut all_events = BTreeSet::new();
    let mut all_event_sequence = Vec::new();
    let mut area_snapshots = Vec::new();
    let mut freshness = Freshness {
        state_present: false,
        area_count: -1,
    };
    let mut remove_stopped_event_count = 0;
    let mut teleport_state = TeleportState {
        before_grounded: false,
        after_grounded: false,
        before_ground_collider: None,
        after_ground_collider: None,
    };
    let mut elapsed_nanos = 0_u128;
    let mut character_max_y = initial_character[1];
    let mut platform_grounded_observed = false;
    let mut checkpoint_transforms = Vec::new();

    for step in 0..scenario.steps {
        if step == scenario.remove_at_step {
            assert!(tn_physics_remove_body(simulation, scenario.remove_body_id));
            let removal_events = drain_events(simulation, scenario.bodies.len());
            remove_stopped_event_count = removal_events
                .iter()
                .filter(|event| {
                    event.contains(&format!("-{}-", scenario.remove_body_id))
                        && event.ends_with("-0")
                })
                .count();
            all_event_sequence.extend(removal_events.iter().cloned());
            all_events.extend(removal_events);
        }
        if step == scenario.teleport_at_step {
            let before = character_state(simulation, scenario.teleport_body_id);
            assert!(tn_physics_set_body_transform(
                simulation,
                scenario.teleport_body_id,
                scenario.teleport_position[0],
                scenario.teleport_position[1],
                scenario.teleport_position[2],
            ));
            let after = character_state(simulation, scenario.teleport_body_id);
            teleport_state = TeleportState {
                before_grounded: before.is_some_and(|state| state.0),
                before_ground_collider: before.and_then(|state| state.1),
                after_grounded: after.is_some_and(|state| state.0),
                after_ground_collider: after.and_then(|state| state.1),
            };
        }

        let current = positions(simulation, scenario.bodies.len());
        let active = scenario
            .motions
            .iter()
            .filter(|motion| step >= motion.start_step && step < motion.end_step)
            .collect::<Vec<_>>();
        let mut input = Vec::with_capacity(active.len() * TRANSFORM_WIDTH);
        for motion in active {
            let position = current
                .get(&motion.body_id)
                .unwrap_or_else(|| panic!("motion references missing body {}", motion.body_id));
            input.extend_from_slice(&[
                motion.body_id as f32,
                position[0] + motion.delta[0],
                position[1] + motion.delta[1],
                position[2] + motion.delta[2],
                0.0,
                0.0,
                0.0,
                1.0,
            ]);
        }
        let started = Instant::now();
        assert!(tn_physics_step(
            simulation,
            scenario.delta_time,
            input.as_ptr(),
            input.len() / TRANSFORM_WIDTH,
        ));
        elapsed_nanos += started.elapsed().as_nanos();

        if step == 0 {
            freshness = Freshness {
                state_present: character_state(simulation, character.body_id).is_some(),
                area_count: area_membership(simulation, 5).len() as i32,
            };
        }
        if let Some(position) = positions(simulation, scenario.bodies.len()).get(&character.body_id)
        {
            character_max_y = character_max_y.max(position[1]);
        }
        if character_state(simulation, character.body_id)
            .is_some_and(|state| state.0 && state.1 == Some(2))
        {
            platform_grounded_observed = true;
        }
        let step_events = drain_events(simulation, scenario.bodies.len());
        all_event_sequence.extend(step_events.iter().cloned());
        all_events.extend(step_events);
        if scenario.checkpoints.contains(&step) {
            checkpoint_transforms.push(TransformCheckpoint {
                step,
                transforms: transform_records(simulation, scenario.bodies.len()),
            });
            area_snapshots.push(
                area_membership(simulation, 5)
                    .iter()
                    .map(u32::to_string)
                    .collect::<Vec<_>>()
                    .join(","),
            );
        }
    }

    checkpoint_transforms.push(TransformCheckpoint {
        step: scenario.steps,
        transforms: transform_records(simulation, scenario.bodies.len()),
    });
    let final_positions = positions(simulation, scenario.bodies.len());
    let resting_position = final_positions[&1];
    let final_character = final_positions[&character.body_id];
    let state = character_state(simulation, character.body_id).expect("character state must exist");
    let area_membership = area_membership(simulation, 5);
    let observation = Observation {
        arm: "rust".into(),
        rapier_version: version.into(),
        scenario_sha256: sha.into(),
        body_count: scenario.bodies.len(),
        resting_position,
        character_displacement: [
            final_character[0] - initial_character[0],
            final_character[1] - initial_character[1],
            final_character[2] - initial_character[2],
        ],
        grounded: state.0,
        ground_collider: state.1,
        ground_normal: state.2,
        area_membership: area_membership.clone(),
        area_membership_snapshots: area_snapshots,
        collision_event_set: all_events.into_iter().collect(),
        collision_event_sequence: all_event_sequence,
        remove_stopped_event_count,
        freshness_before_visible: freshness,
        teleport_state,
        validation_outcomes: validation_outcomes(scenario),
        average_step_nanoseconds: elapsed_nanos as f64 / scenario.steps as f64,
        quadratic_buffer_bytes: BufferBytes {
            event: scenario.bodies.len() * scenario.bodies.len() * EVENT_WIDTH * size_of::<u32>(),
            area: scenario.bodies.len() * scenario.bodies.len() * 2 * size_of::<u32>(),
        },
        scenario_coverage: ScenarioCoverage {
            one_way_passed_upward: character_max_y > 1.23,
            platform_grounded_observed,
            area_excluded_character: !area_membership.contains(&character.body_id),
        },
        feet_on_floor: feet_on_floor_subject(),
        checkpoint_transforms,
    };
    tn_physics_destroy(simulation);
    observation
}

fn max_axis_delta(left: &[f32; 3], right: &[f32; 3]) -> f32 {
    left.iter()
        .zip(right)
        .map(|(left, right)| (left - right).abs())
        .fold(0.0, f32::max)
}

fn vector_distance(left: &[f32; 3], right: &[f32; 3]) -> f32 {
    left.iter()
        .zip(right)
        .map(|(left, right)| (left - right).powi(2))
        .sum::<f32>()
        .sqrt()
}

fn symmetric_difference(left: &[String], right: &[String]) -> usize {
    let left = left.iter().collect::<BTreeSet<_>>();
    let right = right.iter().collect::<BTreeSet<_>>();
    left.symmetric_difference(&right).count()
}

fn transform_table_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../physics/__tests__/fixtures/physics-parity.native-transforms.json")
}

/// The committed native transform table (PRD-899): the web Wasm build of this crate must step the
/// shared scenario to these records (`tests/physics-web-parity.test.mjs`). This test keeps the
/// table equal to the native build; `TN_PHYSICS_WRITE_TRANSFORM_TABLE=1` rewrites it.
#[test]
fn matches_the_committed_native_transform_table() {
    let fixture_bytes = fs::read(fixture_path()).expect("shared parity scenario must exist");
    let scenario: Scenario =
        serde_json::from_slice(&fixture_bytes).expect("shared parity scenario must be valid JSON");
    let sha = format!("{:x}", Sha256::digest(&fixture_bytes));
    let version = unsafe { CStr::from_ptr(tn_physics_version()) }
        .to_str()
        .expect("native Rapier version must be UTF-8");
    let observed = run_scenario(&scenario, &sha, version).checkpoint_transforms;
    assert_eq!(observed.len(), scenario.checkpoints.len() + 1);
    if std::env::var_os("TN_PHYSICS_WRITE_TRANSFORM_TABLE").is_some() {
        let table = TransformTable {
            scenario_sha256: sha.clone(),
            rapier_version: version.into(),
            tolerance: 0.02,
            checkpoints: observed.clone(),
        };
        let mut rendered = serde_json::to_string_pretty(&table).expect("table must serialize");
        rendered.push('\n');
        fs::write(transform_table_path(), rendered).expect("transform table must be writable");
    }
    let table: TransformTable = serde_json::from_slice(
        &fs::read(transform_table_path()).expect("committed native transform table must exist"),
    )
    .expect("native transform table must be valid JSON");
    assert_eq!(
        table.scenario_sha256, sha,
        "the scenario changed: rewrite the transform table"
    );
    assert_eq!(table.rapier_version, version);
    assert_eq!(table.checkpoints.len(), observed.len());
    for (expected, actual) in table.checkpoints.iter().zip(&observed) {
        assert_eq!(expected.step, actual.step);
        assert_eq!(
            expected.transforms.len(),
            actual.transforms.len(),
            "step {}",
            actual.step
        );
        for (left, right) in expected.transforms.iter().zip(&actual.transforms) {
            assert_eq!(left[0], right[0], "step {} body order", actual.step);
            let delta = left[1..]
                .iter()
                .zip(&right[1..])
                .map(|(l, r)| (l - r).abs())
                .fold(0.0, f32::max);
            assert!(
                delta <= table.tolerance,
                "step {} body {}: {delta}",
                actual.step,
                left[0]
            );
        }
    }
}

#[test]
fn measures_the_shipping_simulation_against_the_web_artifact() {
    let fixture_bytes = fs::read(fixture_path()).expect("shared parity scenario must exist");
    let scenario: Scenario =
        serde_json::from_slice(&fixture_bytes).expect("shared parity scenario must be valid JSON");
    assert_eq!(scenario.schema_version, 1);
    let sha = format!("{:x}", Sha256::digest(&fixture_bytes));
    let version = unsafe { CStr::from_ptr(tn_physics_version()) }
        .to_str()
        .expect("native Rapier version must be UTF-8");
    assert_eq!(version, scenario.expected_rapier_versions.rust);
    assert_ne!(version, scenario.expected_rapier_versions.web);

    let web: Observation = serde_json::from_slice(
        &fs::read(artifact_path("parity-web.json"))
            .expect("run the web parity arm before the Rust parity arm"),
    )
    .expect("web parity observation must be valid JSON");
    assert_eq!(web.arm, "web");
    assert_eq!(web.scenario_sha256, sha);
    assert_eq!(web.rapier_version, scenario.expected_rapier_versions.web);

    let rust = run_scenario(&scenario, &sha, version);
    assert_eq!(
        rust.area_membership_snapshots.len(),
        scenario.checkpoints.len()
    );
    assert!(rust.resting_position.iter().all(|value| value.is_finite()));
    assert!(
        rust.character_displacement
            .iter()
            .all(|value| value.is_finite())
    );
    assert!(rust.average_step_nanoseconds.is_finite());
    assert_eq!(rust.validation_outcomes.len(), 6);
    fs::write(
        artifact_path("parity-rust.json"),
        serde_json::to_vec_pretty(&rust).expect("Rust observation must serialize"),
    )
    .expect("Rust observation artifact must be writable");

    let web_area = web.area_membership.iter().collect::<BTreeSet<_>>();
    let rust_area = rust.area_membership.iter().collect::<BTreeSet<_>>();
    let comparison = Comparison {
        scenario_sha256: sha,
        web_version: web.rapier_version.clone(),
        rust_version: rust.rapier_version.clone(),
        resting_position_max_axis_delta: max_axis_delta(
            &web.resting_position,
            &rust.resting_position,
        ),
        character_displacement_max_axis_delta: max_axis_delta(
            &web.character_displacement,
            &rust.character_displacement,
        ),
        grounded_mismatch: u32::from(web.grounded != rust.grounded),
        ground_collider_mismatch: u32::from(web.ground_collider != rust.ground_collider),
        ground_normal_max_axis_delta: max_axis_delta(&web.ground_normal, &rust.ground_normal),
        area_membership_symmetric_difference: web_area.symmetric_difference(&rust_area).count(),
        collision_event_symmetric_difference: symmetric_difference(
            &web.collision_event_set,
            &rust.collision_event_set,
        ),
        collision_event_sequence_mismatch: u32::from(
            web.collision_event_sequence != rust.collision_event_sequence,
        ),
        validation_outcome_mismatches: web
            .validation_outcomes
            .iter()
            .filter(|(name, outcome)| rust.validation_outcomes.get(*name) != Some(*outcome))
            .count(),
        remove_stopped_event_count_delta: web
            .remove_stopped_event_count
            .abs_diff(rust.remove_stopped_event_count),
        teleport_grounded_mismatch: u32::from(
            web.teleport_state.after_grounded != rust.teleport_state.after_grounded,
        ),
        average_step_nanoseconds_delta: rust.average_step_nanoseconds
            - web.average_step_nanoseconds,
        scenario_coverage_mismatches: [
            web.scenario_coverage.one_way_passed_upward
                != rust.scenario_coverage.one_way_passed_upward,
            web.scenario_coverage.platform_grounded_observed
                != rust.scenario_coverage.platform_grounded_observed,
            web.scenario_coverage.area_excluded_character
                != rust.scenario_coverage.area_excluded_character,
        ]
        .into_iter()
        .filter(|mismatch| *mismatch)
        .count(),
        feet_on_floor_grounded_mismatch: u32::from(
            web.feet_on_floor.grounded != rust.feet_on_floor.grounded,
        ),
        feet_on_floor_ground_collider_mismatch: u32::from(
            web.feet_on_floor.ground_collider != rust.feet_on_floor.ground_collider,
        ),
        feet_on_floor_normal_max_axis_delta: max_axis_delta(
            &web.feet_on_floor.ground_normal,
            &rust.feet_on_floor.ground_normal,
        ),
        feet_on_floor_position_max_axis_delta: max_axis_delta(
            &web.feet_on_floor.position,
            &rust.feet_on_floor.position,
        ),
    };
    let rendered = serde_json::to_string_pretty(&comparison).expect("comparison must serialize");
    fs::write(artifact_path("parity-comparison.json"), &rendered)
        .expect("comparison artifact must be writable");
    println!("TN_PHYSICS_PARITY_COMPARISON={rendered}");

    assert!(
        comparison.resting_position_max_axis_delta <= 0.02,
        "resting position exceeded the 0.02 per-axis tolerance: {}",
        comparison.resting_position_max_axis_delta
    );
    let displacement_delta =
        vector_distance(&web.character_displacement, &rust.character_displacement);
    assert!(
        displacement_delta <= 0.05,
        "character displacement exceeded the 0.05 cumulative tolerance: {displacement_delta}"
    );
    assert_eq!(
        (rust.grounded, rust.ground_collider),
        (web.grounded, web.ground_collider),
        "grounded and groundCollider must agree exactly"
    );
    assert!(
        comparison.ground_normal_max_axis_delta <= 0.02,
        "ground normal exceeded the 0.02 per-axis tolerance: {}",
        comparison.ground_normal_max_axis_delta
    );
    assert_eq!(
        (
            web.feet_on_floor.grounded,
            web.feet_on_floor.ground_collider,
        ),
        (
            rust.feet_on_floor.grounded,
            rust.feet_on_floor.ground_collider,
        ),
        "character.spec feet-on-floor grounded state must agree exactly"
    );
    assert!(
        comparison.feet_on_floor_normal_max_axis_delta <= 0.02,
        "feet-on-floor ground normal exceeded the 0.02 per-axis tolerance: {}",
        comparison.feet_on_floor_normal_max_axis_delta
    );
    assert!(
        comparison.feet_on_floor_position_max_axis_delta <= 0.02,
        "feet-on-floor position exceeded the 0.02 per-axis tolerance: {}",
        comparison.feet_on_floor_position_max_axis_delta
    );
    assert_eq!(rust_area, web_area, "area membership must agree exactly");
    assert_eq!(
        comparison.collision_event_symmetric_difference, 0,
        "collision event membership must agree exactly"
    );
    assert_eq!(
        comparison.collision_event_sequence_mismatch, 0,
        "collision event order must agree exactly"
    );
    assert_eq!(
        rust.remove_stopped_event_count, web.remove_stopped_event_count,
        "mid-overlap removal event counts must agree exactly"
    );
    assert_eq!(
        comparison.scenario_coverage_mismatches, 0,
        "both arms must exercise the same one-way, platform, and area controls"
    );
    assert_eq!(
        (
            web.freshness_before_visible.state_present,
            web.freshness_before_visible.area_count,
        ),
        (true, 2),
        "the web arm must expose the measured post-step state before a visible read"
    );
    assert_eq!(
        (
            rust.freshness_before_visible.state_present,
            rust.freshness_before_visible.area_count,
        ),
        (
            web.freshness_before_visible.state_present,
            web.freshness_before_visible.area_count,
        ),
        "raw Rust character state and area membership must be fresh after step"
    );

    // Phase 0 measured D4 red. Keep the mismatch explicit until Phase 3 aligns teleport state.
    assert_eq!(
        (
            rust.teleport_state.after_grounded,
            rust.teleport_state.after_ground_collider,
        ),
        (
            web.teleport_state.after_grounded,
            web.teleport_state.after_ground_collider,
        ),
        "D4: setBodyTransform must have identical character-state side effects"
    );
}
