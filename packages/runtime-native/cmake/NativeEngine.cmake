# Native engine targets that need a GPU backend (PRD-499, PRD-573 slice 5). Included from
# CMakeLists.txt only when `-DTN_ENGINE_ONLY=ON`, after the WebGPU and SDL dependencies are found and
# before any JS engine is configured, so nothing here can see a VM target or VM headers. The default
# (legacy) configure never includes it and defines no engine target.
# Every engine target is C++20 whatever MYSTRAL_USE_V8 selects for the legacy host, and every one is
# EXCLUDE_FROM_ALL with the `native-engine` ctest label.

include(${CMAKE_CURRENT_LIST_DIR}/NativeEngineCore.cmake)

# Host services: the GPU context and presentation owner with no scripting state. The legacy
# runtime compiles the same sources, so both hosts share their configuration and pacing path.
# TN_ENGINE_HOST_SERVICES switches on the two engine-only behaviours in context.cpp (full-resolution
# GPU timestamps and the queue release); the legacy host compiles the file without it.
add_library(tn_host_services STATIC src/webgpu/context.cpp src/webgpu/presentation.cpp src/utils/stb_impl.cpp)
tn_native_engine_target(tn_host_services)
target_compile_definitions(tn_host_services PRIVATE TN_ENGINE_HOST_SERVICES)
target_include_directories(tn_host_services PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_include_directories(tn_host_services PRIVATE ${THIRD_PARTY_DIR}/stb)
if(TARGET dawn::webgpu)
    target_link_libraries(tn_host_services PUBLIC dawn::webgpu)
    # These are the same Dawn platform dependencies the legacy host links below its engine-only
    # early return. Engine consumers must carry them too, without linking the scripting host.
    if(APPLE)
        target_link_libraries(tn_host_services PUBLIC "-framework Metal" "-framework QuartzCore"
            "-framework IOKit" "-framework IOSurface")
    elseif(WIN32)
        target_link_libraries(tn_host_services PUBLIC d3d12 dxgi dxguid)
        if(MSVC)
            target_link_libraries(tn_host_services PUBLIC OneCoreUap.lib)
        endif()
    endif()
elseif(TARGET wgpu::wgpu)
    target_link_libraries(tn_host_services PUBLIC wgpu::wgpu)
endif()
if(SDL3_STATIC_TARGET)
    target_link_libraries(tn_host_services PRIVATE ${SDL3_STATIC_TARGET})
elseif(SDL3_LIBRARY)
    target_link_libraries(tn_host_services PRIVATE ${SDL3_LIBRARY})
    target_include_directories(tn_host_services PRIVATE ${SDL3_INCLUDE_DIR})
endif()

# The same pacing checks must link with the JS-free host, not only the legacy bindings.
if(NOT MYSTRAL_PLATFORM STREQUAL "android" AND NOT MYSTRAL_PLATFORM STREQUAL "ios")
    add_executable(tn-native-engine-pacing-test EXCLUDE_FROM_ALL tests/presentation_pacing_test.cpp)
    tn_native_engine_target(tn-native-engine-pacing-test)
    target_link_libraries(tn-native-engine-pacing-test PRIVATE tn_host_services)
    add_test(NAME native_engine_pacing COMMAND tn-native-engine-pacing-test)
    set_tests_properties(native_engine_pacing PROPERTIES LABELS "native-engine" TIMEOUT 30)
    set_property(GLOBAL APPEND PROPERTY TN_NATIVE_ENGINE_TEST_TARGETS tn-native-engine-pacing-test)
endif()

# Renderer: native-owned GPU resources over the same WebGPU backend the host uses.
add_library(tn_engine_renderer STATIC ${TN_ENGINE_RENDERER_SOURCES})
tn_native_engine_target(tn_engine_renderer)
target_link_libraries(tn_engine_renderer PUBLIC tn_engine_foundation tn_engine_assets tn_engine_shader tn_engine_scene
    tn_engine_animation tn_engine_vsm tn_engine_graph tn_engine_probes tn_host_services)
if(TARGET dawn::webgpu)
    target_link_libraries(tn_engine_renderer PUBLIC dawn::webgpu)
elseif(TARGET wgpu::wgpu)
    target_link_libraries(tn_engine_renderer PUBLIC wgpu::wgpu)
endif()
target_include_directories(tn_engine_renderer PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include)

if(NOT MYSTRAL_PLATFORM STREQUAL "ios" AND NOT MYSTRAL_PLATFORM STREQUAL "android")
    # Gate E: clear, submit and read back 300 headless frames with no JS engine linked.
    add_executable(tn-native-engine-gate-e EXCLUDE_FROM_ALL tests/native-engine/gate_e_driver.cpp)
    target_link_libraries(tn-native-engine-gate-e PRIVATE tn_host_services)
    tn_native_engine_target(tn-native-engine-gate-e)
    set_property(GLOBAL APPEND PROPERTY TN_NATIVE_ENGINE_TEST_TARGETS tn-native-engine-gate-e)
    add_test(NAME native_engine_gate_e COMMAND $<TARGET_FILE:tn-native-engine-gate-e>)
    set_tests_properties(native_engine_gate_e PROPERTIES LABELS "native-engine")
    if(TN_ENGINE_SANITIZE)
        # GPU drivers keep allocations alive past exit, so this driver judges memory errors and
        # undefined behaviour, not leaks.
        set_tests_properties(native_engine_gate_e PROPERTIES
            LABELS "native-engine;native-sanitizer"
            ENVIRONMENT "ASAN_OPTIONS=detect_leaks=0:abort_on_error=1;UBSAN_OPTIONS=halt_on_error=1:print_stacktrace=1")
    endif()
endif()

get_directory_property(tn_tests_before_gpu TESTS)
if(NOT MYSTRAL_PLATFORM STREQUAL "ios" AND NOT MYSTRAL_PLATFORM STREQUAL "android")
    tn_native_engine_test(tn-native-engine-gpu-resources-test tests/native-engine/gpu_resources_test.cpp
        native_engine_gpu_upload_readback=upload_readback
        native_engine_gpu_deferred_destroy=deferred_destroy
        native_engine_gpu_async_only=async_only
        native_engine_gpu_thread_ordering=gpu_thread_ordering
        native_engine_lifetime_deferred_gpu=lifetime_deferred_gpu
        native_engine_gpu_batched_submits=batched_submits)
    target_link_libraries(tn-native-engine-gpu-resources-test PRIVATE tn_engine_renderer tn_host_services)
    # A real window, so the ctest runs it under the repository's private Xvfb with SDL's dummy audio.
    add_executable(tn-native-engine-presentation-test EXCLUDE_FROM_ALL tests/native-engine/presentation_test.cpp)
    target_link_libraries(tn-native-engine-presentation-test PRIVATE tn_engine_renderer tn_host_services ${SDL3_STATIC_TARGET})
    target_include_directories(tn-native-engine-presentation-test PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine)
    tn_native_engine_target(tn-native-engine-presentation-test)
    add_test(NAME native_engine_present_resize
        COMMAND sh ${CMAKE_CURRENT_SOURCE_DIR}/../../scripts/xvfb.sh $<TARGET_FILE:tn-native-engine-presentation-test> resizes)
    set_tests_properties(native_engine_present_resize PROPERTIES LABELS "native-engine"
        ENVIRONMENT "SDL_AUDIODRIVER=dummy;SDL_VIDEODRIVER=x11;ASAN_OPTIONS=detect_leaks=0:abort_on_error=1;UBSAN_OPTIONS=halt_on_error=1:print_stacktrace=1")
    set_property(GLOBAL APPEND PROPERTY TN_NATIVE_ENGINE_TEST_TARGETS tn-native-engine-presentation-test)

    # The same corpus validates through the backend's own compiler: Tint on Dawn, naga on wgpu-native.
    if(TARGET dawn::webgpu)
        set(tn_shader_validator native_engine_shader_emit_tint)
    else()
        set(tn_shader_validator native_engine_shader_emit_naga)
    endif()
    tn_native_engine_test(tn-native-engine-shader-emit-test tests/native-engine/shader_emit_test.cpp
        ${tn_shader_validator}=validates
        native_engine_shader_emit_stable=stable
        native_engine_shader_emit_position_invariant=position_invariant
        native_engine_shader_emit_shared_once=shared_once)
    target_link_libraries(tn-native-engine-shader-emit-test PRIVATE tn_engine_shader tn_host_services)
    tn_native_engine_test(tn-native-engine-frame-gpu-timer-test tests/native-engine/frame_gpu_timer_test.cpp
        native_engine_frame_gpu_timer_full_stream=full_stream
        native_engine_frame_gpu_timer_owner_frame_restores=owner_frame_restores)
    target_link_libraries(tn-native-engine-frame-gpu-timer-test PRIVATE tn_engine_renderer)
    tn_native_engine_test(tn-native-engine-reflection-capture-test tests/native-engine/reflection_capture_test.cpp
        native_engine_reflection_capture=validation)
    target_link_libraries(tn-native-engine-reflection-capture-test PRIVATE tn_engine_renderer)
    tn_native_engine_test(tn-native-engine-renderer-test tests/native-engine/renderer_test.cpp
        native_engine_renderer_resize_readback=resize_readback
        native_engine_renderer_camera_turn_records=camera_turn_records
        native_engine_renderer_emissive_target=emissive_target
        native_engine_renderer_aux_targets_one_pass=aux_targets_one_pass
        native_engine_renderer_aux_targets_alpha_tested=aux_targets_alpha_tested
        native_engine_renderer_denoise_face_normal=denoise_face_normal
        native_engine_renderer_emissive_validation=emissive_validation
        native_engine_renderer_output_ramp=output_ramp
        native_engine_renderer_lit_reference=lit_reference
        native_engine_renderer_lambert_reference=lambert_reference
        native_engine_renderer_phong_reference=phong_reference
        native_engine_renderer_physical_reference=physical_reference
        native_engine_renderer_alpha_transparency=alpha_transparency
        native_engine_renderer_alpha_hash_coverage=alpha_hash_coverage
        native_engine_renderer_alpha_hash_shadow_coverage=alpha_hash_shadow_coverage
        native_engine_renderer_alpha_test=alpha_test
        native_engine_renderer_mipmaps_share_one_submit=mipmaps_share_one_submit
        native_engine_traa_alpha=traa_alpha
        native_engine_traa_reset_seed=traa_reset_seed
        native_engine_traa_camera_velocity=traa_camera_velocity
        native_engine_traa_skinned_velocity=traa_skinned_velocity
        native_engine_renderer_frame_delta_skips_compiles=frame_delta_skips_compiles
        native_engine_traa_feeds_the_chain=traa_feeds_the_chain
        native_engine_velocity_needs_traa=velocity_needs_traa
        native_engine_traa_replaces_multisampling=traa_replaces_multisampling
        native_engine_traa_converges_edges=traa_converges_edges
        native_engine_traa_late_resolve=traa_late_resolve
        native_engine_traa_ghosting=traa_ghosting
        native_engine_traa_camera_pan=traa_camera_pan
        native_engine_traa_rejection=traa_rejection
        native_engine_sibling_reads_the_live_scene=sibling_reads_the_live_scene
        native_engine_renderer_output_screen_size=output_screen_size)
    target_link_libraries(tn-native-engine-renderer-test PRIVATE tn_engine_renderer tn_host_services)

    # A texture's retirement reaches every renderer that caches it, and a probe capture waits for a
    # scene environment's frame-pumped PMREM before it reads a face; startup warm-up bakes it with no frame.
    tn_native_engine_test(tn-native-engine-renderer-lifetime-test tests/native-engine/renderer_lifetime_test.cpp
        native_engine_renderer_shared_retired_sweep=shared_retired_sweep
        native_engine_probe_capture_environment=probe_capture_environment
        native_engine_probe_capture_callback_camera=probe_capture_callback_camera
        native_engine_database_environment_warmup=database_environment_warmup)
    target_link_libraries(tn-native-engine-renderer-lifetime-test PRIVATE tn_engine_renderer tn_host_services)
    if(TN_ENGINE_SANITIZE)
        # Like Gate E, exercise ASan/UBSan without judging the GPU driver's exit allocations.
        set_tests_properties(native_engine_traa_alpha PROPERTIES
            LABELS "native-engine;native-sanitizer"
            ENVIRONMENT "ASAN_OPTIONS=detect_leaks=0:abort_on_error=1;UBSAN_OPTIONS=halt_on_error=1:print_stacktrace=1")
    endif()
    if(TARGET dawn::webgpu)
        add_test(NAME native_engine_traa_validation COMMAND tn-native-engine-renderer-test traa_validation)
        set_tests_properties(native_engine_traa_validation PROPERTIES LABELS "native-engine")
        add_test(NAME native_engine_traa_projection_reference COMMAND sh -c
            "\"$1\" traa_validation > \"$3\" && node \"$2\" --projection < \"$3\"" --
            $<TARGET_FILE:tn-native-engine-renderer-test>
            ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/traa_reference_test.mjs
            ${CMAKE_CURRENT_BINARY_DIR}/traa-projections.txt)
        set_tests_properties(native_engine_traa_projection_reference PROPERTIES LABELS "native-engine")
    endif()
    target_compile_definitions(tn-native-engine-renderer-test PRIVATE
        TN_GOLDENS_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../three-native/tests/compatibility/goldens/0.185.1")

    # The fixture driver with a GPU: it answers render fixtures' `render` lines (PRD-514).
    add_executable(tn-native-engine-render-driver EXCLUDE_FROM_ALL tests/native-engine/fixture/render_main.cpp)
    target_link_libraries(tn-native-engine-render-driver PRIVATE tn_fixture_driver tn_engine_renderer tn_host_services tn_engine_abi
        tn_engine_particles)
    tn_native_engine_target(tn-native-engine-render-driver)
    set_property(GLOBAL APPEND PROPERTY TN_NATIVE_ENGINE_TEST_TARGETS tn-native-engine-render-driver)
    # Every render fixture through the render driver against its browser golden frame (PRD-514,
    # PRD-512): tone mapping ramps, the lit sphere, the five materials, transparency and alphaTest.
    find_program(TN_PNPM_EXECUTABLE pnpm)
    if(TN_PNPM_EXECUTABLE)
        # The five standard materials' fixtures in one case (PRD-514): Basic (alpha-test), Standard
        # (lit-render), Lambert, Phong, Physical, and their property fixtures.
        foreach(render_case "render_tonemap:tonemap-ramp-*" "render_lit:lit-render*" "render_lambert:materials-lambert"
                "render_phong:materials-phong" "render_physical:materials-physical*"
                "standard_materials_fixtures:alpha-test,lit-render*,materials-*"
                "render_alpha:alpha-*" "render_lights:lights-*" "render_shadows:shadows-*"
                "render_vsm:vsm-cut"
                "traa_history:traa-history" "history_cut:history-cut"
                "render_particles:particles-sprite,fluid-particles"
                "render_skinned:skinned-*" "render_morph:morph-*" "render_gltf:gltf-model-*"
                "render_post_addons:tsl-post-ao,tsl-post-ao-raw,tsl-post-bloom,tsl-post-smaa,tsl-post-template-high,tsl-post-live-parameters,tsl-post-uniform-write"
                "render_data_textures:textures-data-*" "render_lines:lines-*" "render_materialx:materialx-*"
                "render_pmrem:pmrem-*" "render_screen_uv:screen-uv" "render_texture_object:texture-object"
                "render_tsl_texture:tsl-texture-object" "render_viewport:viewport-textures,tsl-viewport-*" "render_instanced_geometry:tsl-instanced-geometry"
                "render_storage_attribute:storage-attribute" "render_batched:batched-mesh"
                "render_reflector:reflector-*" "render_tsl_stage:tsl-stage-*,tsl-normal-world-*,tsl-view-geometry-*,tsl-transform-normal-*")
            string(REPLACE ":" ";" render_pair "${render_case}")
            list(GET render_pair 0 render_name)
            list(GET render_pair 1 render_glob)
            add_test(NAME native_engine_${render_name}
                COMMAND ${TN_PNPM_EXECUTABLE} --filter @threenative/three-native exec tsx tests/compatibility/run-native.ts
                    --driver $<TARGET_FILE:tn-native-engine-render-driver> --renders --only "${render_glob}"
                    --out ${CMAKE_CURRENT_BINARY_DIR}/${render_name}.json)
            set_tests_properties(native_engine_${render_name} PROPERTIES LABELS "native-engine")
        endforeach()
        add_test(NAME native_engine_render_vsm_open
            COMMAND ${TN_PNPM_EXECUTABLE} --filter @threenative/three-native exec tsx tests/compatibility/run-native.ts
                --driver $<TARGET_FILE:tn-native-engine-render-driver> --renders --only "vsm-basic,vsm-deformation"
                --out ${CMAKE_CURRENT_BINARY_DIR}/render_vsm_open.json)
        set_tests_properties(native_engine_render_vsm_open PROPERTIES LABELS "native-engine")
    endif()

    # PRD-526: a GTAO post pass over a box on a plane. The renderer draws the "normal" target it
    # reads (r185's MRT normalView); the render driver refuses the graph without it.
    find_program(TN_POST_NORMAL_NODE node)
    if(TN_POST_NORMAL_NODE)
        add_test(NAME native_engine_post_normal_pass
            COMMAND ${TN_POST_NORMAL_NODE} --import tsx tests/native-engine/post-normal-pass.ts
                $<TARGET_FILE:tn-native-engine-render-driver> ${CMAKE_CURRENT_BINARY_DIR}
            WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR})
        set_tests_properties(native_engine_post_normal_pass PROPERTIES LABELS "native-engine" TIMEOUT 180)
    endif()

    # PRD-613: the render thread's frame order, run with the encode half on a second thread.
    tn_native_engine_test(tn-native-engine-render-thread-order-test tests/native-engine/render_thread_order_test.cpp
        native_engine_render_thread_order=order
        native_engine_render_thread_uniform_order=uniform_node
        native_engine_render_thread_reflection_order=reflection_order
        native_engine_render_thread_baton=baton)
    target_link_libraries(tn-native-engine-render-thread-order-test PRIVATE tn_engine_renderer tn_host_services)

    tn_native_engine_test(tn-native-engine-compute-test tests/native-engine/compute_test.cpp
        native_engine_compute_readback=readback)
    target_link_libraries(tn-native-engine-compute-test PRIVATE tn_engine_renderer tn_host_services)

    tn_native_engine_test(tn-native-engine-update-scaling-test tests/native-engine/update_scaling_test.cpp
        native_engine_update_warm_batches=warm_batches)
    target_link_libraries(tn-native-engine-update-scaling-test PRIVATE tn_engine_renderer tn_host_services)
    # The 4k to 64k scaling limit (large <= small * 18) is a performance target, not a correctness
    # check: F records it red ("scaling still behind"). It keeps its own label, `tn-perf`, so
    # `ctest -L native-engine` judges correctness and `ctest -L tn-perf` reports the open target.
    add_test(NAME native_engine_update_scaling COMMAND tn-native-engine-update-scaling-test scaling)
    set_tests_properties(native_engine_update_scaling PROPERTIES LABELS "tn-perf" TIMEOUT 300)

    tn_native_engine_test(tn-native-engine-render-database-test tests/native-engine/render_database_test.cpp
        native_engine_gpu_joint_production=gpu_joint_production
        native_engine_uniform_batch_preparation=uniform_batch_preparation
        native_engine_content_identical_geometry_batches=content_identical_geometry_batches
        native_engine_multi_material_groups=multi_material_groups
        native_engine_renderer_scene_lit=lit_scene
        native_engine_renderer_present_direct=present_direct
        native_engine_renderer_invariant_scope=invariant_scope
        native_engine_renderer_instance_counts=instance_counts
        native_engine_renderer_flat_lane_equivalence=flat_lane_equivalence
        native_engine_directional_target=directional_target
        native_engine_directional_target_outside_scene=directional_target_outside_scene
        native_engine_scene_fog_node=scene_fog_node
        native_engine_lit_mesh_without_normals=lit_mesh_without_normals
        native_engine_renderer_invalidation=invalidation
        native_engine_renderer_scene_alpha=alpha_scene
        native_engine_standard_materials_unsupported=material_unsupported
        native_engine_renderer_shader_invalid=shader_invalid
        native_engine_renderer_time_uniform=time_uniform
        native_engine_renderer_steady_state=steady_state
        native_engine_renderer_normal_pass_is_not_tallied=normal_pass_is_not_tallied
        native_engine_renderer_gtao_screen_reach=gtao_screen_reach
        native_engine_renderer_color_write_masks_the_draw=color_write_masks_the_draw
        native_engine_renderer_steady_cache_invalidation=steady_cache_invalidation
        native_engine_render_target=render_target
        native_engine_float_render_target=float_render_target_keeps_float32
        native_engine_float_render_target_half=float_render_target_falls_back_to_half
        native_engine_renderer_updates=updates
        native_engine_renderer_multi_camera_layers=multi_camera_layers
        native_engine_renderer_callback=render_callback
        native_engine_renderer_instanced=instanced
        native_engine_batched_vs_unbatched=batched_vs_unbatched
        native_engine_skinned_batched_vs_unbatched=skinned_crowd
        native_engine_skinned_decline_cadence=skinned_decline_cadence
        native_engine_skinned_projecting_cadence=skinned_projecting_cadence
        native_engine_skinned_normalized_weights=skinned_normalized_weights
        native_engine_normal_map_tilt=normal_map_tilt
        native_engine_renderer_gpu_mipmaps=gpu_mipmaps
        native_engine_renderer_msaa_edges=msaa_edges
        native_engine_unsupported_map_slot=unsupported_map_slot
        native_engine_env_map_slot_is_read=env_map_slot_is_read
        native_engine_converted_copies_swept=converted_copies_swept
        native_engine_gpu_timer_covers_shadows=gpu_timer_covers_shadows
        native_engine_gpu_timer_covers_offscreen=gpu_timer_covers_offscreen
        native_engine_gpu_timer_splits_the_gather=gpu_timer_splits_the_gather
        native_engine_renderer_overlay_over_frame=overlay_over_frame
        native_engine_gpu_timer_is_opt_in=gpu_timer_is_opt_in
        native_engine_shadow_camera_layers=shadow_camera_layers
        native_engine_flat_shading_needs_no_normals=flat_shading_needs_no_normals
        native_engine_renderer_map_sampleability_changes=map_sampleability_changes
        native_engine_renderer_batch_caches_stay_put=batch_caches_stay_put
        native_engine_renderer_frustum_culling=frustum_culling
        native_engine_renderer_shadow_caster_frustum_culling=shadow_caster_frustum_culling
        native_engine_masked_shadow=masked_shadow
        native_engine_leaf_receiver=leaf_receiver
        native_engine_shadow_noise_frame=shadow_noise_frame
        native_engine_foliage_transmission=foliage_transmission
        native_engine_rough_diffuse=rough_diffuse
        native_engine_point_shadow_cube_faces=point_shadow_cube_faces
        native_engine_lamp_source_radius=lamp_source_radius
        native_engine_lamp_source_radius_wall=lamp_source_radius_wall
        native_engine_lamp_source_radius_crate=lamp_source_radius_crate
        native_engine_contact_shadow_foot=contact_shadow_foot
        native_engine_virtual_sun_contact_foot=virtual_sun_contact_foot
        native_engine_virtual_sun_room_seam=virtual_sun_room_seam
        native_engine_virtual_sun_pixel_floor=virtual_sun_pixel_floor
        native_engine_virtual_sun_lod_rung=virtual_sun_lod_rung
        native_engine_virtual_sun_level_sizes=virtual_sun_level_sizes
        native_engine_virtual_sun_auto_map_size=virtual_sun_auto_map_size
        native_engine_lamp_cache=lamp_cache
        native_engine_lamp_atlas=lamp_atlas
        native_engine_gpu_timer_splits_lamp_shadows=gpu_timer_splits_lamp_shadows
        native_engine_renderer_shadow_lights_follow_hierarchy=shadow_lights_follow_hierarchy
        native_engine_renderer_records_survive_siblings=records_survive_siblings
        native_engine_renderer_steady_frame_hashes_no_record=steady_frame_hashes_no_record
        native_engine_renderer_nested_record_cache=nested_record_cache
        native_engine_renderer_frustum_record_retention=frustum_record_retention
        native_engine_renderer_world_sphere_measured_once=world_sphere_measured_once
        native_engine_renderer_reflection_reuse=reflection_reuse
        native_engine_renderer_depth_node_sets_fragment_depth=depth_node_sets_fragment_depth
        native_engine_renderer_depth_node_reaches_every_material_program=depth_node_reaches_every_material_program)
    # The skinned cases drive the player's SkinnedCrowd scene.
    target_link_libraries(tn-native-engine-render-database-test PRIVATE tn_engine_renderer tn_host_services tn_engine_player)
    target_compile_definitions(tn-native-engine-render-database-test PRIVATE
        TN_GOLDENS_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../three-native/tests/compatibility/goldens/0.185.1"
        TN_NATIVE_LIT_OUT="${CMAKE_CURRENT_BINARY_DIR}/native-lit-render.rgba")
    # PRD-634: the sun filter's edge widens with the caster gap as the browser's penumbraUv model says.
    tn_native_engine_test(tn-native-engine-vsm-source-angle-test tests/native-engine/vsm/vsm_source_angle_gpu_test.cpp
        native_engine_vsm_source_angle_gap=gap_widening
        native_engine_vsm_source_angle_ray_test=ray_test_gap)
    target_link_libraries(tn-native-engine-vsm-source-angle-test PRIVATE tn_engine_renderer tn_host_services)

    # PRD-520 phase 2 and PRD-528 phase 1: cooked-package loads for a world (failure codes, cancel
    # against in-flight GPU use, teardown) and render ids within one tick.
    add_library(tn_engine_world_admission STATIC src/engine/world/admission/package_loads.cpp)
    tn_native_engine_target(tn_engine_world_admission)
    target_link_libraries(tn_engine_world_admission PUBLIC tn_engine_renderer tn_engine_world tn_engine_assets)
    tn_native_engine_test(tn-native-engine-package-loads-test tests/native-engine/world/package_loads_test.cpp
        native_engine_admission_failure=failure native_engine_admission_cancel=cancel
        native_engine_loop_async_cancel=teardown)
    target_link_libraries(tn-native-engine-package-loads-test PRIVATE tn_engine_world_admission tn_host_services)
    tn_native_engine_test(tn-native-engine-render-ids-test tests/native-engine/loop/render_ids_test.cpp
        native_engine_loop_render_ids=render_ids)
    target_link_libraries(tn-native-engine-render-ids-test PRIVATE tn_engine_renderer tn_engine_world tn_host_services)

    # PRD-517 phase 1: an animated material property reaches the next render through its version.
    tn_native_engine_test(tn-native-engine-animation-material-revision-test tests/native-engine/animation/material_revision_test.cpp
        native_engine_animation_material_revision=material_revision)
    target_link_libraries(tn-native-engine-animation-material-revision-test PRIVATE tn_engine_renderer tn_engine_animation tn_host_services)

    # PRD-516 phase 3: ticks, not renders, evaluate the schedule's mixers.
    tn_native_engine_test(tn-native-engine-animation-schedule-render-test tests/native-engine/animation/schedule_render_test.cpp
        native_engine_animation_tick_vs_render=tick_vs_render)
    target_link_libraries(tn-native-engine-animation-schedule-render-test PRIVATE tn_engine_renderer tn_engine_animation tn_engine_world tn_host_services)

    tn_native_engine_test(tn-native-engine-renderer-caches-test tests/native-engine/renderer_caches_test.cpp
        native_engine_renderer_geometry_cache=geometry
        native_engine_renderer_pipeline_cache=pipelines
        native_engine_renderer_sibling_pipelines=sibling_pipelines
        native_engine_renderer_sibling_texture_change=sibling_texture_change
        native_engine_renderer_pipeline_compile_async=compile_before_render
        native_engine_renderer_init_texture=init_texture
        native_engine_renderer_recent_bind_groups=recent_bind_groups
        native_engine_renderer_line_depth_bias=line_depth_bias)
    target_link_libraries(tn-native-engine-renderer-caches-test PRIVATE tn_engine_renderer tn_host_services)
    if(CMAKE_SYSTEM_NAME STREQUAL "Linux" AND MYSTRAL_USE_DAWN)
        target_compile_definitions(tn-native-engine-renderer-caches-test PRIVATE TN_TEST_PIPELINE_WORKERS)
        target_link_options(tn-native-engine-renderer-caches-test PRIVATE "-Wl,--wrap=wgpuDeviceCreateRenderPipeline")
        foreach(case failed_ticket synchronous_adoption shutdown_queue nonstandard_exception)
            add_test(NAME native_engine_renderer_pipeline_${case} COMMAND tn-native-engine-renderer-caches-test ${case})
            set_tests_properties(native_engine_renderer_pipeline_${case} PROPERTIES LABELS "native-engine" TIMEOUT 10)
        endforeach()
    endif()

    tn_native_engine_test(tn-native-engine-package-load-test tests/native-engine/package_load_test.cpp
        native_engine_cooked_package_load=load)
    target_link_libraries(tn-native-engine-package-load-test PRIVATE tn_engine_renderer tn_host_services)

    tn_native_engine_test(tn-native-engine-shader-package-test tests/native-engine/shader_package_test.cpp
        native_engine_shader_layouts=layouts
        native_engine_shader_variants_gpu=variants
        native_engine_shader_package_version=version)
    target_link_libraries(tn-native-engine-shader-package-test PRIVATE tn_engine_shader tn_engine_renderer tn_host_services)

    if(TARGET dawn::webgpu)
        tn_native_engine_test(tn-native-engine-device-loss-test tests/native-engine/device_loss_test.cpp
            native_engine_device_loss_recover=recover
            native_engine_device_stale_handle=stale_handle
            native_engine_device_no_adapter=no_adapter)
        target_link_libraries(tn-native-engine-device-loss-test PRIVATE tn_engine_renderer tn_host_services)
    else()
        # Measured 2026-10-04: wgpu-native 25 never delivers the device-lost callback for
        # wgpuDeviceDestroy, so the engine gets no loss signal to recover from.
        foreach(name native_engine_device_loss_recover native_engine_device_stale_handle native_engine_device_no_adapter)
            tn_register_blocked_test(${name} "wgpu-native 25 delivers no device-lost callback on wgpuDeviceDestroy")
        endforeach()
    endif()
    if(TN_ENGINE_SANITIZE)
        # These own a real device, whose driver keeps allocations past exit: judged for memory
        # errors and undefined behaviour, not leaks. CPU-only engine tests keep leak checking.
        # Every test this block registered is one of them, except the Xvfb window test, which sets
        # its own environment above.
        get_directory_property(tn_tests_after_gpu TESTS)
        set(tn_gpu_tests ${tn_tests_after_gpu})
        list(REMOVE_ITEM tn_gpu_tests ${tn_tests_before_gpu} native_engine_present_resize)
        set_tests_properties(${tn_gpu_tests} PROPERTIES
            ENVIRONMENT "ASAN_OPTIONS=detect_leaks=0:abort_on_error=1;UBSAN_OPTIONS=halt_on_error=1:print_stacktrace=1")
    endif()
endif()

find_program(TN_NODE_EXECUTABLE node)
find_program(TN_PNPM_EXECUTABLE pnpm)
add_executable(tn-native-engine-template-post-packages EXCLUDE_FROM_ALL tests/native-engine/template_post_packages.cpp)
tn_native_engine_target(tn-native-engine-template-post-packages)
target_link_libraries(tn-native-engine-template-post-packages PRIVATE tn_engine_shader tn_engine_graph)
set_property(GLOBAL APPEND PROPERTY TN_NATIVE_ENGINE_TEST_TARGETS tn-native-engine-template-post-packages)
file(GLOB TN_TEMPLATE_TINT_CANDIDATES "${CMAKE_CURRENT_SOURCE_DIR}/third_party/dawn/*/bin/tint")
find_program(TN_TEMPLATE_TINT tint HINTS ${TN_TEMPLATE_TINT_CANDIDATES})
if(NOT TN_TEMPLATE_TINT AND TN_TEMPLATE_TINT_CANDIDATES)
    list(GET TN_TEMPLATE_TINT_CANDIDATES 0 TN_TEMPLATE_TINT)
endif()
if(TN_NODE_EXECUTABLE AND TN_TEMPLATE_TINT)
    add_test(NAME native_engine_template_post_packages
        COMMAND ${TN_NODE_EXECUTABLE} --import tsx tests/native-engine/template-post-packages.ts
            $<TARGET_FILE:tn-native-engine-template-post-packages> ${TN_TEMPLATE_TINT} ${CMAKE_CURRENT_BINARY_DIR}
        WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR})
    # The starter's `grade` (a .cube LUT) and `grain` lower like every other stage: the sweep covers all templates.
    set_tests_properties(native_engine_template_post_packages PROPERTIES LABELS "native-engine" TIMEOUT 180)
    add_test(NAME native_engine_template_post_starter
        COMMAND ${TN_NODE_EXECUTABLE} --import tsx tests/native-engine/template-post-packages.ts
            $<TARGET_FILE:tn-native-engine-template-post-packages> ${TN_TEMPLATE_TINT} ${CMAKE_CURRENT_BINARY_DIR}
        WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR})
    set_tests_properties(native_engine_template_post_starter PROPERTIES LABELS "native-engine" TIMEOUT 180
        ENVIRONMENT "TN_POST_ONLY=starter")
    foreach(effect GTAONode DenoiseNode SMAANode FnNode TextureLevel RTTNode BloomNode SharpenNode Lut3DNode)
        add_test(NAME native_engine_post_${effect}
            COMMAND ${CMAKE_COMMAND} -E env TN_POST_LOWERING=${effect}
                ${TN_NODE_EXECUTABLE} --import tsx tests/native-engine/template-post-packages.ts
                $<TARGET_FILE:tn-native-engine-template-post-packages> ${TN_TEMPLATE_TINT} ${CMAKE_CURRENT_BINARY_DIR}
            WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR})
        set_tests_properties(native_engine_post_${effect} PROPERTIES LABELS "native-engine" TIMEOUT 180)
    endforeach()
else()
    # Fail closed: a row nobody ran is a row nobody proved.
    add_test(NAME native_engine_template_post_packages COMMAND ${CMAKE_COMMAND} -E false)
    set_tests_properties(native_engine_template_post_packages PROPERTIES LABELS "native-engine")
endif()

# PRD-527 phase 1: GPUParticles3D's mechanism (two vec3 storage buffers, start once, process per
# render while emitting); tsl_compute_test runs it and the PRD-513 instance grid against programs.js
# recorded in Chromium's WebGPU (compute_reference.json).
add_library(tn_engine_particles STATIC src/engine/world/particles/gpu_particles.cpp
    src/engine/world/fluids/fluid_field.cpp
    src/engine/world/fluids/fluid_particles.cpp)
tn_native_engine_target(tn_engine_particles)
target_link_libraries(tn_engine_particles PUBLIC tn_engine_renderer tn_engine_shader)
if(NOT MYSTRAL_PLATFORM STREQUAL "ios" AND NOT MYSTRAL_PLATFORM STREQUAL "android")
    tn_native_engine_test(tn-native-engine-tsl-compute-test tests/native-engine/tsl-compute/tsl_compute_test.cpp
        native_engine_compute_instance_grid=instance_grid
        native_engine_particles_lifetime=particles_lifetime
        native_engine_fluid_particles=fluid_particles
        native_engine_fluid_particles_ir=fluid_particles_ir
        native_engine_fluid_field=fluid_field
        native_engine_fluid_ir=fluid_ir)
    target_link_libraries(tn-native-engine-tsl-compute-test PRIVATE tn_engine_particles tn_host_services)
    target_compile_definitions(tn-native-engine-tsl-compute-test PRIVATE
        TN_COMPUTE_REFERENCE="${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/tsl-compute/compute_reference.json")
    if(TN_ENGINE_SANITIZE)
        set_tests_properties(native_engine_compute_instance_grid native_engine_particles_lifetime native_engine_fluid_field native_engine_fluid_particles PROPERTIES
            ENVIRONMENT "ASAN_OPTIONS=detect_leaks=0:abort_on_error=1;UBSAN_OPTIONS=halt_on_error=1:print_stacktrace=1")
    endif()
endif()

# PRD-526 phase 1: the render chain's ordering and per-stage decisions as a pure CPU plan. The
# library builds no GPU resources and links nothing heavy; `native_engine_chain_reference_current`
# keeps the committed table equal to what chain.ts produces today.
add_library(tn_engine_chain STATIC src/engine/renderer/chain/plan.cpp)
tn_native_engine_target(tn_engine_chain)
target_include_directories(tn_engine_chain PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src)
tn_native_engine_test(tn-native-engine-chain-test tests/native-engine/chain/chain_order_test.cpp
    native_engine_chain_order=chain_order native_engine_chain_unsupported=chain_unsupported)
target_link_libraries(tn-native-engine-chain-test PRIVATE tn_engine_chain)
target_include_directories(tn-native-engine-chain-test PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/chain)
if(TN_PNPM_EXECUTABLE)
    add_test(NAME native_engine_chain_reference_current
        COMMAND ${TN_PNPM_EXECUTABLE} --workspace-root exec tsx
            packages/runtime-native/tests/native-engine/chain/chain-reference.ts --check
        WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/../..)
    set_tests_properties(native_engine_chain_reference_current PROPERTIES LABELS "native-engine")
else()
    message(WARNING "pnpm not found: native_engine_chain_reference_current is not registered")
endif()

# PRD-519: discrete LOD selection and its per-frame decision as pure CPU functions. It links the
# scene classes for Camera and Object3D but owns no GPU resource; `native_engine_model_lod_reference_current`
# keeps the committed table equal to what model-lod.ts produces today.
add_library(tn_engine_lod STATIC src/engine/renderer/lod/model_lod.cpp)
tn_native_engine_target(tn_engine_lod)
target_link_libraries(tn_engine_lod PUBLIC tn_engine_scene)
target_include_directories(tn_engine_lod PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src)
tn_native_engine_test(tn-native-engine-model-lod-test tests/native-engine/lod/model_lod_test.cpp
    native_engine_model_lod=model_lod)
target_link_libraries(tn-native-engine-model-lod-test PRIVATE tn_engine_lod)
target_include_directories(tn-native-engine-model-lod-test PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/lod)
if(TN_PNPM_EXECUTABLE)
    add_test(NAME native_engine_model_lod_reference_current
        COMMAND ${TN_PNPM_EXECUTABLE} --workspace-root exec tsx
            packages/runtime-native/tests/native-engine/lod/model-lod-reference.ts --check
        WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/../..)
    set_tests_properties(native_engine_model_lod_reference_current PROPERTIES LABELS "native-engine")
else()
    message(WARNING "pnpm not found: native_engine_model_lod_reference_current is not registered")
endif()

# PRD-519: InstancedBatch's own decisions, ported from packages/core/src/instanced-batch.ts and
# instanced-batch-lod.ts: which placements a batch holds, the mesh it builds or refuses, and the
# render partition and LOD level every placement draws at. It reuses the LOD selection above and
# creates no GPU resource, so it links the scene classes and nothing else;
# `native_engine_batching_eligibility_reference_current` keeps the committed table equal to what the
# core module decides today, one step per case of instanced-batch.spec.ts.
add_library(tn_engine_batch STATIC src/engine/renderer/projection/instanced_batch.cpp)
tn_native_engine_target(tn_engine_batch)
target_link_libraries(tn_engine_batch PUBLIC tn_engine_lod)
target_include_directories(tn_engine_batch PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src)
tn_native_engine_test(tn-native-engine-instanced-batch-test tests/native-engine/projection/instanced_batch_test.cpp
    native_engine_batching_eligibility=batching_eligibility)
target_link_libraries(tn-native-engine-instanced-batch-test PRIVATE tn_engine_batch)
target_include_directories(tn-native-engine-instanced-batch-test PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/projection)
if(TN_PNPM_EXECUTABLE)
    add_test(NAME native_engine_batching_eligibility_reference_current
        COMMAND ${TN_PNPM_EXECUTABLE} --workspace-root exec tsx
            packages/runtime-native/tests/native-engine/projection/instanced-batch-reference.ts --check
        WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/../..)
    set_tests_properties(native_engine_batching_eligibility_reference_current PROPERTIES LABELS "native-engine")
else()
    message(WARNING "pnpm not found: native_engine_batching_eligibility_reference_current is not registered")
endif()

# PRD-521: the GPU-driven main pass's per-placement CPU oracle, ported from
# packages/core/src/world-gpu-scene.ts (`cullAndSelect`, `cullAndSelectShadow`, `levelAtGates`,
# `drawableLevel`, `liveKeyInstances`). It links the LOD bias and the foundation but owns no GPU
# resource; `native_engine_world_gpu_scene_reference_current` keeps the committed table equal to what
# the core module produces today.
add_library(tn_engine_gpu_scene STATIC src/engine/world/gpu_scene/gpu_scene.cpp)
tn_native_engine_target(tn_engine_gpu_scene)
target_link_libraries(tn_engine_gpu_scene PUBLIC tn_engine_lod tn_engine_foundation)
target_include_directories(tn_engine_gpu_scene PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src)
tn_native_engine_test(tn-native-engine-world-gpu-scene-test tests/native-engine/world/gpu_scene_test.cpp
    native_engine_world_gpu_scene=gpu_scene)
target_link_libraries(tn-native-engine-world-gpu-scene-test PRIVATE tn_engine_gpu_scene)
target_include_directories(tn-native-engine-world-gpu-scene-test PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/world)
if(TN_PNPM_EXECUTABLE)
    foreach(world_reference "world_gpu_scene:gpu-scene-reference" "world_cells:world-cells-reference")
        string(REPLACE ":" ";" world_reference_pair "${world_reference}")
        list(GET world_reference_pair 0 world_reference_name)
        list(GET world_reference_pair 1 world_reference_script)
        add_test(NAME native_engine_${world_reference_name}_reference_current
            COMMAND ${TN_PNPM_EXECUTABLE} --workspace-root exec tsx
                packages/runtime-native/tests/native-engine/world/${world_reference_script}.ts --check
            WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/../..)
        # Both are stale against develop's core (see NativeEngineCore.cmake): the regenerated gpu_scene
        # table differs from the port at 1 of 38 steps (scene 1 step 21), and world-cells-reference.ts
        # refuses a develop spec it does not account for (world-cells-admission.spec.ts, "reports
        # completed spawn coverage separately from reserved cells and distant work").
        set_tests_properties(native_engine_${world_reference_name}_reference_current PROPERTIES LABELS "tn-known-red")
    endforeach()
else()
    message(WARNING "pnpm not found: the world gpu_scene and cells reference_current tests are not registered")
endif()

# PRD-519 phase 3: the GPU cull and LOD kernel (clear, cull, clamp), built in the shader IR from
# world-gpu-scene.ts's kernels; the test runs it on a real device against the CPU oracle above.
add_library(tn_engine_gpu_scene_kernel STATIC src/engine/world/gpu_scene/cull_kernel.cpp)
tn_native_engine_target(tn_engine_gpu_scene_kernel)
target_link_libraries(tn_engine_gpu_scene_kernel PUBLIC tn_engine_gpu_scene tn_engine_shader)
if(NOT MYSTRAL_PLATFORM STREQUAL "ios" AND NOT MYSTRAL_PLATFORM STREQUAL "android")
    tn_native_engine_test(tn-native-engine-gpu-scene-kernel-test tests/native-engine/world/gpu_scene_kernel_test.cpp
        native_engine_gpu_scene_select=gpu_scene_select)
    target_link_libraries(tn-native-engine-gpu-scene-kernel-test PRIVATE tn_engine_gpu_scene_kernel tn_engine_renderer tn_host_services)
    target_include_directories(tn-native-engine-gpu-scene-kernel-test PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/world)
    if(TN_ENGINE_SANITIZE)
        # A real device's driver keeps allocations past exit (see the GPU tests above).
        set_tests_properties(native_engine_gpu_scene_select PROPERTIES
            ENVIRONMENT "ASAN_OPTIONS=detect_leaks=0:abort_on_error=1;UBSAN_OPTIONS=halt_on_error=1:print_stacktrace=1")
    endif()
endif()

if(NOT MYSTRAL_PLATFORM STREQUAL "ios" AND NOT MYSTRAL_PLATFORM STREQUAL "android")
    # PRD-529 phase 2: the desktop player the playtest runner drives with --target desktop. The
    # mailbox, the inspect-demo game and the window/loop (run.cpp) are library code so the scenarios
    # can name them and a second, V8-linked player (NativeEngineAdapters.cmake) can reuse the loop;
    # the executable names its game. It reaches no JS engine: inspect-js-free.mjs proves it. The loop
    # links SDL, never a VM. Neither player is part of the default build (EXCLUDE_FROM_ALL).
    add_library(tn_engine_player STATIC src/engine/player/mailbox.cpp src/engine/player/demo.cpp
        src/engine/player/run.cpp src/engine/player/skinned_crowd.cpp src/engine/player/world_walk.cpp
        src/platform/ui_overlay.cpp src/platform/input.cpp)
    tn_native_engine_target(tn_engine_player)
    # The UI seam is shared with the legacy host; the CSS backend is never linked here. The web view is
    # opt-in (a game with ui.renderer "web" draws its HUD through it), so the default graph stays JS- and
    # web-view-free.
    option(TN_ENGINE_PLAYER_UI_OVERLAY "Link the desktop web-view UI overlay into the engine players (Linux; needs node scripts/build-native-ui-overlay.mjs and webkit2gtk-4.1)" OFF)
    if(TN_ENGINE_PLAYER_UI_OVERLAY)
        include(cmake/NativeEnginePlayerUiOverlay.cmake)
    else()
        target_compile_definitions(tn_engine_player PRIVATE TN_ENABLE_UI_OVERLAY=0 TN_ENABLE_CSS_UI=0)
    endif()
    target_link_libraries(tn_engine_player PUBLIC tn_engine_inspect tn_engine_scene tn_engine_world
        tn_engine_renderer tn_host_services tn_engine_world_admission)
    target_include_directories(tn_engine_player PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src
        ${CMAKE_CURRENT_SOURCE_DIR}/include)
    if(SDL3_STATIC_TARGET)
        target_link_libraries(tn_engine_player PUBLIC ${SDL3_STATIC_TARGET})
    elseif(SDL3_LIBRARY)
        target_link_libraries(tn_engine_player PUBLIC ${SDL3_LIBRARY})
        target_include_directories(tn_engine_player PUBLIC ${SDL3_INCLUDE_DIR})
    endif()
    add_executable(tn-native-engine-player EXCLUDE_FROM_ALL src/engine/player/main.cpp)
    tn_native_engine_target(tn-native-engine-player)
    target_link_libraries(tn-native-engine-player PRIVATE tn_engine_player)
    target_compile_definitions(tn-native-engine-player PRIVATE
        TN_WORLD_WALK_FIXTURE="${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/world/walk")
    if(MSVC)
        # PE files have no MSVC symbol table; keep the link's symbols for inspect-js-free.mjs.
        target_link_options(tn-native-engine-player PRIVATE "/MAP:$<TARGET_FILE_DIR:tn-native-engine-player>/tn-native-engine-player.map")
    endif()
    set_property(GLOBAL APPEND PROPERTY TN_NATIVE_ENGINE_TEST_TARGETS tn-native-engine-player)

    tn_native_engine_test(tn-native-engine-world-walk-test tests/native-engine/world/world_walk_test.cpp
        native_engine_world_walk_fixture=world_walk_fixture)
    target_link_libraries(tn-native-engine-world-walk-test PRIVATE tn_engine_player)
    target_compile_definitions(tn-native-engine-world-walk-test PRIVATE
        TN_WORLD_WALK_FIXTURE="${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/world/walk")
    if(TARGET dawn::webgpu AND CMAKE_SYSTEM_NAME STREQUAL "Linux")
        target_compile_definitions(tn-native-engine-world-walk-test PRIVATE TN_WORLD_CPU_NULL=1)
        foreach(api InstanceCreateSurface InstanceRequestAdapter SurfaceRelease SurfacePresent
                    SurfaceGetCurrentTexture SurfaceUnconfigure TextureCreateView TextureRelease TextureViewRelease)
            target_link_options(tn-native-engine-world-walk-test PRIVATE "-Wl,--wrap=wgpu${api}")
        endforeach()
        add_test(NAME native_engine_world_cycles_cpu COMMAND tn-native-engine-world-walk-test world_walk_cycles_cpu)
        add_test(NAME native_engine_surface_lifetime_cpu COMMAND tn-native-engine-world-walk-test surface_lifetime_cpu)
        set_tests_properties(native_engine_world_cycles_cpu native_engine_surface_lifetime_cpu PROPERTIES LABELS "native-engine"
            ENVIRONMENT "ASAN_OPTIONS=detect_leaks=1:abort_on_error=1;LSAN_OPTIONS=suppressions=${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/lsan-dawn-null.supp;UBSAN_OPTIONS=halt_on_error=1:print_stacktrace=1")
    endif()
    tn_native_engine_test(tn-native-engine-frame-metrics-test tests/native-engine/world/frame_metrics_test.cpp
        native_engine_player_frame_timing_fields=frame_timing_fields
        native_engine_player_thread_cpu_ignores_sleep=thread_cpu_ignores_sleep
        native_engine_player_wall_clock_moves=wall_clock_moves)
    target_link_libraries(tn-native-engine-frame-metrics-test PRIVATE tn_engine_player)
    tn_native_engine_test(tn-native-engine-skinned-crowd-test tests/native-engine/animation/skinned_crowd_test.cpp
        native_engine_skinned_crowd_cpu=crowd_cpu)
    target_link_libraries(tn-native-engine-skinned-crowd-test PRIVATE tn_engine_player)
endif()

# PRD-528 boxes 53/54: native Rapier stepped by the engine's FixedStepClock, with every body's
# transform written into the native scene graph. The world is the prebuilt Rust Rapier library, so
# this target exists only where the host build has it and reaches no JS engine.
# `native_engine_rapier_sync` replays the shared parity scenario against the TypeScript-driven
# path's recorded transforms, and `native_engine_rapier_sync_reference_current` keeps the committed
# table equal to what packages/physics produces today.
if(TN_ENABLE_NATIVE_PHYSICS AND TARGET threenative-native-physics)
    add_library(tn_engine_physics_sync STATIC src/engine/world/physics_sync.cpp)
    tn_native_engine_target(tn_engine_physics_sync)
    target_link_libraries(tn_engine_physics_sync PUBLIC tn_engine_world tn_engine_scene
        threenative-native-physics)
    target_include_directories(tn_engine_physics_sync PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src
        ${CMAKE_CURRENT_SOURCE_DIR}/include)
    tn_native_engine_test(tn-native-engine-physics-sync-test tests/native-engine/world/physics_sync_test.cpp
        native_engine_rapier_sync=sync native_engine_rapier_events=events)
    target_link_libraries(tn-native-engine-physics-sync-test PRIVATE tn_engine_physics_sync)
    target_include_directories(tn-native-engine-physics-sync-test PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/world)
    target_compile_definitions(tn-native-engine-physics-sync-test PRIVATE
        TN_PHYSICS_SYNC_SCENARIO="${CMAKE_CURRENT_SOURCE_DIR}/../../packages/physics/__tests__/fixtures/physics-parity.scenario.json"
        TN_PHYSICS_SYNC_REFERENCE="${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/world/physics_sync_reference.json")
    if(TN_PNPM_EXECUTABLE)
        add_test(NAME native_engine_rapier_sync_reference_current
            COMMAND ${TN_PNPM_EXECUTABLE} --workspace-root exec tsx
                packages/runtime-native/tests/native-engine/world/physics-sync-reference.ts --check
            WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/../..)
        set_tests_properties(native_engine_rapier_sync_reference_current PROPERTIES LABELS "native-engine")
    endif()
else()
    message(STATUS "native physics target absent: the engine PhysicsSync and its test are not built")
endif()

get_property(tn_native_engine_test_targets GLOBAL PROPERTY TN_NATIVE_ENGINE_TEST_TARGETS)
add_custom_target(tn-native-engine-tests DEPENDS ${tn_native_engine_test_targets})

# The engine target graph, recorded once every target in the project exists, so the ctest below can
# prove no engine target reaches a JS engine, a web view or the scripting host.
function(tn_native_engine_collect_links target out)
    set(seen ${${out}})
    foreach(property LINK_LIBRARIES INTERFACE_LINK_LIBRARIES)
        get_target_property(links ${target} ${property})
        if(NOT links)
            continue()
        endif()
        foreach(link IN LISTS links)
            string(REGEX REPLACE "^\\$<LINK_ONLY:(.*)>$" "\\1" link "${link}")
            if(link IN_LIST seen)
                continue()
            endif()
            list(APPEND seen "${link}")
            if(TARGET ${link})
                get_target_property(location ${link} IMPORTED_LOCATION)
                if(location)
                    list(APPEND seen "${location}")
                endif()
                tn_native_engine_collect_links(${link} seen)
            endif()
        endforeach()
    endforeach()
    set(${out} ${seen} PARENT_SCOPE)
endfunction()

function(tn_native_engine_write_graph)
    get_property(targets GLOBAL PROPERTY TN_NATIVE_ENGINE_TARGETS)
    set(report "")
    foreach(target IN LISTS targets)
        get_target_property(standard ${target} CXX_STANDARD)
        set(links "")
        tn_native_engine_collect_links(${target} links)
        string(APPEND report "${target}|${standard}|${links}\n")
    endforeach()
    file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/native-engine-target-graph.txt" "${report}")
endfunction()
cmake_language(DEFER DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR} CALL tn_native_engine_write_graph)

add_test(NAME native_engine_target_graph
    COMMAND ${CMAKE_COMMAND}
        -DGRAPH=${CMAKE_CURRENT_BINARY_DIR}/native-engine-target-graph.txt
        -P ${CMAKE_CURRENT_SOURCE_DIR}/cmake/CheckNativeEngineGraph.cmake)
set_tests_properties(native_engine_target_graph PROPERTIES LABELS "native-engine")

add_test(NAME native_engine_no_blocking_waits
    COMMAND ${CMAKE_COMMAND} -DENGINE_SOURCE_DIR=${CMAKE_CURRENT_SOURCE_DIR}/src/engine
        -P ${CMAKE_CURRENT_SOURCE_DIR}/cmake/CheckNoBlockingWaits.cmake)
set_tests_properties(native_engine_no_blocking_waits PROPERTIES LABELS "native-engine")
