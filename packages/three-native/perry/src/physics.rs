//! Bulk scratch packets over the shipping physics C ABI. No second simulation implementation.
use threenative_native_physics::*;

extern "C" {
    fn js_typed_array_masked_window_data_ptr(value: f64) -> i64;
    fn js_typed_array_length(header: *const u8) -> i32;
    fn js_native_buffer_data_ptr(value: f64) -> *const u8;
    fn js_native_buffer_byte_len(value: f64) -> usize;
}

// The pinned Perry runtime resolves owning arrays and ArrayBuffer/native-arena views.
#[no_mangle]
pub unsafe extern "C" fn js_tnp_physics_copy(
    value: f64,
    pointer: i64,
    count: i64,
    kind: i32,
    to_native: i32,
) -> i32 {
    if count < 0 || (count > 0 && pointer == 0) {
        return 1;
    }
    // Perry represents Uint8Array as a BufferHeader, including offset ArrayBuffer views.
    let buffer = if kind == 1 { js_native_buffer_data_ptr(value) } else { std::ptr::null() };
    let data = if !buffer.is_null() {
        if count as usize > js_native_buffer_byte_len(value) { return 1; }
        buffer as i64
    } else {
        let data = js_typed_array_masked_window_data_ptr(value);
        if data == 0 { return 1; }
        let header = (value.to_bits() & 0x0000_FFFF_FFFF_FFFF) as *const u8;
        // TypedArrayHeader's kind byte belongs to Perry's pinned 0.5 ABI.
        if !matches!(kind, 1 | 5 | 6 | 7)
            || *header.add(8) != kind as u8
            || count > js_typed_array_length(header) as i64
        { return 1; }
        data
    };
    let bytes = count as usize * match kind { 1 => 1, 7 => 8, _ => 4 };
    if bytes == 0 {
        return 0;
    }
    let (source, target) = if to_native != 0 {
        (data, pointer)
    } else {
        (pointer, data)
    };
    std::ptr::copy_nonoverlapping(source as *const u8, target as *mut u8, bytes);
    0
}

#[no_mangle]
pub extern "C" fn js_tnp_physics_version() -> i64 {
    tn_physics_version() as i64
}

// Packet fields are f64 so pointers and uint32 masks survive the Perry number boundary.
// All variable-length input/output remains in the caller's reusable native scratch buffers.
#[no_mangle]
pub unsafe extern "C" fn js_tnp_physics_call(
    op: i32,
    world: i64,
    packet: i64,
    input: i64,
    count: i64,
    output: i64,
    capacity: i64,
    auxiliary: i64,
    auxiliary_count: i64,
) -> i64 {
    if packet == 0 || count < 0 || capacity < 0 || auxiliary_count < 0 {
        return -1;
    }
    let p = &*(packet as *const [f64; 32]);
    let s = world as *mut Simulation;
    let floats = input as *const f32;
    let out = output as *mut f32;
    let n = count as usize;
    let cap = capacity as usize;
    match op {
        0 => tn_physics_create(&TnPhysicsWorldOptions {
            gravity_x: p[0] as f32,
            gravity_y: p[1] as f32,
            gravity_z: p[2] as f32,
        }) as i64,
        1 => {
            let body = TnPhysicsBodyOptions {
                id: p[0] as u32,
                body_type: p[1] as u32,
                shape_type: p[2] as u32,
                position_x: p[3] as f32,
                position_y: p[4] as f32,
                position_z: p[5] as f32,
                rotation_x: p[6] as f32,
                rotation_y: p[7] as f32,
                rotation_z: p[8] as f32,
                rotation_w: p[9] as f32,
                shape_x: p[10] as f32,
                shape_y: p[11] as f32,
                shape_z: p[12] as f32,
                mass: p[13] as f32,
                collision_layer: p[14] as u32,
                collision_mask: p[15] as u32,
                sensor: p[16] != 0.0,
                continuous_collision: p[17] != 0.0,
            };
            (match body.shape_type {
                3 => tn_physics_add_trimesh_body(
                    s,
                    &body,
                    floats,
                    n as u32,
                    auxiliary as *const u32,
                    auxiliary_count as u32,
                ),
                4 => tn_physics_add_heightfield_body(
                    s,
                    &body,
                    floats,
                    n as u32,
                    p[18] as u32,
                    p[19] as u32,
                    p[20] as f32,
                    p[21] as f32,
                    p[22] as f32,
                ),
                _ => tn_physics_add_body(s, &body),
            }) as i64
        }
        2 => {
            tn_physics_remove_body(s, p[0] as u32);
            1
        }
        3 => tn_physics_configure_character(
            s,
            &TnPhysicsCharacterOptions {
                id: p[0] as u32,
                offset: p[1] as f32,
                max_slope_climb_angle: p[2] as f32,
                autostep_enabled: p[3] != 0.0,
                autostep_max_height: p[4] as f32,
                autostep_min_width: p[5] as f32,
                autostep_include_dynamic_bodies: p[6] != 0.0,
                snap_to_ground_enabled: p[7] != 0.0,
                snap_to_ground: p[8] as f32,
                one_way_layers: p[9] as u32,
                pushes_dynamic_bodies: p[10] != 0.0,
            },
        ) as i64,
        4 => tn_physics_step(s, p[0] as f32, floats, n) as i64,
        5 => tn_physics_read_visible_transforms(s, out, cap) as i64,
        6 => tn_physics_read_body_sleep_states(s, out, cap) as i64,
        7 => tn_physics_read_character_states(s, out, cap) as i64,
        8 => tn_physics_read_area_intersections(s, output as *mut u32, cap) as i64,
        9 => tn_physics_drain_collision_events(s, output as *mut u32, cap) as i64,
        10 => {
            tn_physics_destroy(s);
            1
        }
        11 => {
            if cap < 8 || out.is_null() {
                return -1;
            }
            let query = TnPhysicsRayQuery {
                from_x: p[0] as f32,
                from_y: p[1] as f32,
                from_z: p[2] as f32,
                to_x: p[3] as f32,
                to_y: p[4] as f32,
                to_z: p[5] as f32,
                collision_mask: p[6] as u32,
            };
            let mut hit = std::mem::MaybeUninit::<TnPhysicsRayHit>::uninit();
            let status = tn_physics_intersect_ray(s, &query, hit.as_mut_ptr());
            if status == 1 {
                let hit = hit.assume_init();
                let values = [
                    hit.body_id as f32,
                    hit.position_x,
                    hit.position_y,
                    hit.position_z,
                    hit.normal_x,
                    hit.normal_y,
                    hit.normal_z,
                    hit.distance,
                ];
                std::ptr::copy_nonoverlapping(values.as_ptr(), out, 8);
            }
            status as i64
        }
        12 | 13 => {
            if cap % 4 != 0 || (cap > 0 && out.is_null()) {
                return -1;
            }
            let mut hits = vec![
                TnPhysicsQueryHit {
                    body_id: 0,
                    position_x: 0.0,
                    position_y: 0.0,
                    position_z: 0.0
                };
                cap / 4
            ];
            let status = if op == 12 {
                tn_physics_intersect_shape(
                    s,
                    &TnPhysicsShapeQueryOptions {
                        shape_type: p[0] as u32,
                        shape_x: p[1] as f32,
                        shape_y: p[2] as f32,
                        shape_z: p[3] as f32,
                        position_x: p[4] as f32,
                        position_y: p[5] as f32,
                        position_z: p[6] as f32,
                        rotation_x: p[7] as f32,
                        rotation_y: p[8] as f32,
                        rotation_z: p[9] as f32,
                        rotation_w: p[10] as f32,
                        collision_mask: p[11] as u32,
                        max_results: p[12] as u32,
                    },
                    hits.as_mut_ptr(),
                    hits.len(),
                )
            } else {
                tn_physics_intersect_point(
                    s,
                    p[0] as f32,
                    p[1] as f32,
                    p[2] as f32,
                    p[3] as u32,
                    p[4] as u32,
                    hits.as_mut_ptr(),
                    hits.len(),
                )
            };
            if status > 0 {
                for (index, hit) in hits.iter().take(status as usize).enumerate() {
                    let values = [
                        hit.body_id as f32,
                        hit.position_x,
                        hit.position_y,
                        hit.position_z,
                    ];
                    std::ptr::copy_nonoverlapping(values.as_ptr(), out.add(index * 4), 4);
                }
            }
            status as i64
        }
        14 => tn_physics_set_body_transform(s, p[0] as u32, p[1] as f32, p[2] as f32, p[3] as f32)
            as i64,
        15 => tn_physics_apply_body_impulse(s, p[0] as u32, p[1] as f32, p[2] as f32, p[3] as f32)
            as i64,
        16 => tn_physics_apply_body_force(s, p[0] as u32, p[1] as f32, p[2] as f32, p[3] as f32)
            as i64,
        17 => tn_physics_set_body_linear_velocity(
            s,
            p[0] as u32,
            p[1] as f32,
            p[2] as f32,
            p[3] as f32,
        ) as i64,
        18 => {
            if cap < 3 || out.is_null() {
                return -1;
            }
            let mut velocity = TnPhysicsVector3::default();
            let status = tn_physics_read_body_linear_velocity(s, p[0] as u32, &mut velocity);
            if status == 1 {
                std::ptr::copy_nonoverlapping(
                    [velocity.x, velocity.y, velocity.z].as_ptr(),
                    out,
                    3,
                );
            }
            status as i64
        }
        19 => tn_physics_apply_body_force_at_point(
            s,
            p[0] as u32,
            p[1] as f32,
            p[2] as f32,
            p[3] as f32,
            p[4] as f32,
            p[5] as f32,
            p[6] as f32,
        ) as i64,
        20 => tn_physics_read_contacts(s, p[0] as u32, input as *const u32, n, out, cap) as i64,
        21 => tn_physics_set_heightfield_shape(
            s,
            p[0] as u32,
            floats,
            n as u32,
            p[1] as u32,
            p[2] as u32,
            p[3] as f32,
            p[4] as f32,
            p[5] as f32,
        ) as i64,
        _ => -1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shipping_abi_body_step_and_ray_records() {
        unsafe {
            let mut packet = [0.0f64; 32];
            packet[1] = -9.81;
            let p = packet.as_mut_ptr() as i64;
            let world = js_tnp_physics_call(0, 0, p, 0, 0, 0, 0, 0, 0);
            assert_ne!(world, 0);
            // Fixed box with half extents 1 and identity rotation.
            packet[0] = 7.0;
            packet[1] = 1.0;
            packet[2] = 0.0;
            packet[9] = 1.0;
            packet[10] = 1.0;
            packet[11] = 1.0;
            packet[12] = 1.0;
            packet[14] = 1.0;
            packet[15] = 65535.0;
            assert_eq!(js_tnp_physics_call(1, world, p, 0, 0, 0, 0, 0, 0), 1);
            packet[0] = 1.0 / 60.0;
            let p = packet.as_mut_ptr() as i64;
            assert_eq!(js_tnp_physics_call(4, world, p, 0, 0, 0, 0, 0, 0), 1);
            let mut output = [0.0f32; 8];
            assert_eq!(
                js_tnp_physics_call(5, world, p, 0, 0, output.as_mut_ptr() as i64, 8, 0, 0),
                1
            );
            assert_eq!(output, [7.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0]);
            packet = [0.0; 32];
            packet[1] = 5.0;
            packet[4] = -5.0;
            packet[6] = 65535.0;
            let p = packet.as_mut_ptr() as i64;
            assert_eq!(
                js_tnp_physics_call(11, world, p, 0, 0, output.as_mut_ptr() as i64, 8, 0, 0),
                1
            );
            assert_eq!(output, [7.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 4.0]);
            assert_eq!(js_tnp_physics_call(10, world, p, 0, 0, 0, 0, 0, 0), 1);
        }
    }
}
