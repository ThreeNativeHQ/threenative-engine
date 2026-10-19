use threenative_native_physics::{
    Simulation, TnPhysicsBodyOptions, TnPhysicsWorldOptions, tn_physics_add_body,
    tn_physics_add_heightfield_body, tn_physics_create, tn_physics_destroy,
    tn_physics_read_body_sleep_states, tn_physics_read_contacts,
    tn_physics_read_visible_transforms, tn_physics_set_heightfield_shape, tn_physics_step,
};

const CONTACT_WIDTH: usize = 8;
const TRANSFORM_WIDTH: usize = 8;
const SAMPLES: u32 = 33;
const SIZE: f32 = 6.0;
const STEP: f32 = 1.0 / 60.0;
const SURFACE: u32 = 0;
const BALL: u32 = 1;

fn options(id: u32, body_type: u32, shape_type: u32, y: f32, radius: f32) -> TnPhysicsBodyOptions {
    TnPhysicsBodyOptions {
        id,
        body_type,
        shape_type,
        position_x: 0.0,
        position_y: y,
        position_z: 0.0,
        rotation_x: 0.0,
        rotation_y: 0.0,
        rotation_z: 0.0,
        rotation_w: 1.0,
        shape_x: radius,
        shape_y: 0.0,
        shape_z: 0.0,
        mass: if body_type == 0 { 10.0 } else { 0.0 },
        collision_layer: 1,
        collision_mask: u16::MAX.into(),
        sensor: false,
        continuous_collision: true,
    }
}

/// A flat heightfield at `height`, `SAMPLES` x `SAMPLES`, in the web backend's column-major order.
fn surface(height: f32) -> Vec<f32> {
    vec![height; (SAMPLES * SAMPLES) as usize]
}

fn set_surface(simulation: *mut Simulation, id: u32, heights: &[f32], rows: u32) -> bool {
    tn_physics_set_heightfield_shape(
        simulation,
        id,
        heights.as_ptr(),
        heights.len() as u32,
        rows,
        SAMPLES,
        SIZE,
        1.0,
        SIZE,
    )
}

fn ball_height(simulation: *mut Simulation) -> f32 {
    let mut transforms = [0.0f32; TRANSFORM_WIDTH * 4];
    let count =
        tn_physics_read_visible_transforms(simulation, transforms.as_mut_ptr(), transforms.len());
    (0..count as usize)
        .find(|index| transforms[index * TRANSFORM_WIDTH] as u32 == BALL)
        .map(|index| transforms[index * TRANSFORM_WIDTH + 2])
        .expect("the ball reports a transform")
}

fn ball_sleeping(simulation: *mut Simulation) -> bool {
    let mut states = [0.0f32; 8];
    let count = tn_physics_read_body_sleep_states(simulation, states.as_mut_ptr(), states.len());
    (0..count as usize)
        .any(|index| states[index * 2] as u32 == BALL && states[index * 2 + 1] == 1.0)
}

fn read(simulation: *mut Simulation, output: &mut [f32]) -> i32 {
    let candidates = [BALL];
    tn_physics_read_contacts(
        simulation,
        SURFACE,
        candidates.as_ptr(),
        candidates.len(),
        output.as_mut_ptr(),
        output.len(),
    )
}

fn step(simulation: *mut Simulation, steps: usize) {
    for _ in 0..steps {
        assert!(tn_physics_step(simulation, STEP, std::ptr::null(), 0));
    }
}

#[test]
fn reads_solved_support_and_refreshes_the_surface_in_place() {
    let simulation = tn_physics_create(&TnPhysicsWorldOptions {
        gravity_x: 0.0,
        gravity_y: -9.81,
        gravity_z: 0.0,
    });
    let heights = surface(0.28);
    assert!(tn_physics_add_heightfield_body(
        simulation,
        &options(SURFACE, 1, 0, 0.0, 0.0),
        heights.as_ptr(),
        heights.len() as u32,
        SAMPLES,
        SAMPLES,
        SIZE,
        1.0,
        SIZE,
    ));
    assert!(tn_physics_add_body(
        simulation,
        &options(BALL, 0, 1, 1.0, 0.25)
    ));

    // Airborne: no solved contact exists yet.
    step(simulation, 10);
    let mut output = [0.0f32; CONTACT_WIDTH * 16];
    assert_eq!(read(simulation, &mut output), 0);

    step(simulation, 60);
    let found = read(simulation, &mut output);
    assert!(found > 0, "a resting ball has solved support");
    let mut impulse = 0.0;
    for record in output.chunks_exact(CONTACT_WIDTH).take(found as usize) {
        assert_eq!(record[0] as u32, BALL);
        assert!(
            record[5] > 0.9,
            "the surface pushes up on the ball: {record:?}"
        );
        assert!(
            (record[2] - 0.28).abs() < 0.02,
            "contact lies on the surface: {record:?}"
        );
        impulse += record[7];
    }
    // The summed impulse over a step carries roughly the ball's weight.
    let load = impulse / STEP;
    assert!(load > 98.1 * 0.5 && load < 98.1 * 2.0, "load {load}");
    assert!((ball_height(simulation) - 0.53).abs() < 0.01);

    // A buffer too small is told the count instead of losing contacts silently.
    assert_eq!(read(simulation, &mut []), found);
    // An unknown target fails closed.
    let candidates = [BALL];
    assert_eq!(
        tn_physics_read_contacts(
            simulation,
            99,
            candidates.as_ptr(),
            1,
            output.as_mut_ptr(),
            output.len()
        ),
        -1
    );

    // At rest the ball sleeps and reports nothing: its stored impulses are not this step's.
    let mut slept = false;
    for _ in 0..600 {
        step(simulation, 1);
        if ball_sleeping(simulation) {
            slept = true;
            break;
        }
    }
    assert!(slept, "a ball resting on flat surface falls asleep");
    assert_eq!(read(simulation, &mut output), 0);

    // Lower the surface in place: same body, and the sleeping ball wakes and follows it down.
    let lowered = surface(0.1);
    assert!(set_surface(simulation, SURFACE, &lowered, SAMPLES));
    step(simulation, 120);
    assert!(
        (ball_height(simulation) - 0.35).abs() < 0.01,
        "ball {}",
        ball_height(simulation)
    );
    assert!(read(simulation, &mut output) > 0 || ball_sleeping(simulation));

    // Malformed refreshes are refused rather than half-applied.
    assert!(!set_surface(simulation, SURFACE, &lowered, SAMPLES + 1));
    assert!(!set_surface(simulation, 42, &lowered, SAMPLES));
    let mut broken = lowered.clone();
    broken[5] = f32::NAN;
    assert!(!set_surface(simulation, SURFACE, &broken, SAMPLES));
    assert!((ball_height(simulation) - 0.35).abs() < 0.01);
    tn_physics_destroy(simulation);
}
