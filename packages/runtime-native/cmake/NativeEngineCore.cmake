# Portable native engine core (PRD-499): targets with no platform API, GPU or VM, and their CPU
# tests. A host build includes it through NativeEngine.cmake; an Emscripten or `TN_ENGINE_CORE_ONLY`
# build includes it alone, which is the guard that the core stays Wasm-safe (owner decision 4).
#
# PRD-573 slice 2b lands foundation, scene, animation and the binding registry. Every target here is
# `EXCLUDE_FROM_ALL`, so the legacy build never compiles any of it.

option(TN_ENGINE_SANITIZE "Build the native engine targets under ASan and UBSan" OFF)
option(TN_ENGINE_TSAN "Build the native engine targets under ThreadSanitizer (a separate build: TSan excludes ASan)" OFF)
option(TN_ENGINE_FUZZ "Build the native engine libFuzzer targets (clang only)" OFF)
function(tn_native_engine_target target)
    set_target_properties(${target} PROPERTIES CXX_STANDARD 20 CXX_STANDARD_REQUIRED ON POSITION_INDEPENDENT_CODE ON)
    if(EMSCRIPTEN)
        set_target_properties(${target} PROPERTIES INTERPROCEDURAL_OPTIMIZATION_RELEASE ON)
        target_compile_options(${target} PRIVATE -msimd128)
        target_link_options(${target} PRIVATE -msimd128)
    endif()
    # PRD-501 §6.3: the engine targets are compared against a JavaScript oracle in binary64, so the
    # compiler must not fuse a multiply and an add into one rounded FMA. No fast-math anywhere.
    if(NOT MSVC)
        target_compile_options(${target} PRIVATE -ffp-contract=off)
    endif()
    if(TN_ENGINE_SANITIZE)
        target_compile_options(${target} PRIVATE -fsanitize=address,undefined -fno-sanitize-recover=undefined -fno-omit-frame-pointer)
        target_link_options(${target} PRIVATE -fsanitize=address,undefined)
    endif()
    if(TN_ENGINE_TSAN)
        target_compile_options(${target} PRIVATE -fsanitize=thread -fno-omit-frame-pointer)
        target_link_options(${target} PRIVATE -fsanitize=thread)
    endif()
    set_property(GLOBAL APPEND PROPERTY TN_NATIVE_ENGINE_TARGETS ${target})
    if(TN_ENGINE_FUZZ)
        # Coverage counters in the engine code itself, or libFuzzer only sees its own harness.
        target_compile_options(${target} PRIVATE -fsanitize=fuzzer-no-link)
    endif()
    if(EMSCRIPTEN)
        # Owner decision 4: the core runs on a growing Wasm heap, never a fixed one.
        target_link_options(${target} PRIVATE -sALLOW_MEMORY_GROWTH=1)
    endif()
endfunction()

# Foundation: handles and math. Portable C++20 with no platform API, so the same sources
# compile for the browser port.
add_library(tn_engine_foundation STATIC
    src/engine/foundation/handles.cpp
    src/engine/foundation/buffers.cpp
    src/engine/foundation/reachability.cpp
    src/engine/foundation/members.cpp
    src/engine/foundation/math/Vector.cpp
    src/engine/foundation/math/Matrix.cpp
    src/engine/foundation/math/Quaternion.cpp
    src/engine/foundation/math/Euler.cpp
    src/engine/foundation/math/Color.cpp
    src/engine/foundation/math/Primitives.cpp
    src/engine/foundation/math/ieee754.cpp)
tn_native_engine_target(tn_engine_foundation)
target_include_directories(tn_engine_foundation PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src)

# Scene graph, transforms and cameras (PRD-508 phases 1-2): Object3D, the node classes and the two
# projection cameras, on the ported math classes. Portable, so it joins the Wasm core.
add_library(tn_engine_scene STATIC src/engine/scene/object3d.cpp src/engine/scene/camera.cpp
    src/engine/scene/nodes.cpp src/engine/scene/raycaster.cpp src/engine/scene/geometry.cpp src/engine/scene/geometries.cpp src/engine/scene/curves.cpp src/engine/scene/shape_utils.cpp
    src/engine/scene/material.cpp src/engine/scene/lights.cpp src/engine/scene/static_transform.cpp
    src/engine/scene/projected_cull.cpp)
tn_native_engine_target(tn_engine_scene)
target_link_libraries(tn_engine_scene PUBLIC tn_engine_foundation)
target_include_directories(tn_engine_scene PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src ${CMAKE_CURRENT_SOURCE_DIR}/include)

# Animation is a renderer/binding dependency, including in the browser-only build.
add_library(tn_engine_animation STATIC src/engine/animation/interpolant.cpp src/engine/animation/property_binding.cpp
    src/engine/animation/mixer.cpp src/engine/animation/schedule.cpp
    src/engine/animation/skinning/skeleton.cpp src/engine/animation/skinning/palette.cpp)
tn_native_engine_target(tn_engine_animation)
target_link_libraries(tn_engine_animation PUBLIC tn_engine_scene)
target_include_directories(tn_engine_animation PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src)

# One executable per test file; each ctest names a case inside it.
function(tn_native_engine_test target source)
    add_executable(${target} EXCLUDE_FROM_ALL ${source})
    target_link_libraries(${target} PRIVATE tn_engine_foundation)
    target_include_directories(${target} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine)
    tn_native_engine_target(${target})
    foreach(case IN LISTS ARGN)
        string(REPLACE "=" ";" pair "${case}")
        list(GET pair 0 test_name)
        list(GET pair 1 case_name)
        # Naming the target (not its file) lets ctest prepend a cross-compiling emulator: node for Wasm.
        add_test(NAME ${test_name} COMMAND ${target} ${case_name})
        set_tests_properties(${test_name} PROPERTIES LABELS "native-engine")
        if(TN_ENGINE_SANITIZE)
            set_tests_properties(${test_name} PROPERTIES LABELS "native-engine;native-sanitizer")
        endif()
    endforeach()
    set_property(GLOBAL APPEND PROPERTY TN_NATIVE_ENGINE_TEST_TARGETS ${target})
endfunction()

# libFuzzer targets need clang; `TN_ENGINE_FUZZ=ON` with a clang toolchain builds them.
if(TN_ENGINE_FUZZ)
    add_executable(native_engine_fuzz_buffers EXCLUDE_FROM_ALL tests/native-engine/fuzz_buffers.cpp)
    target_link_libraries(native_engine_fuzz_buffers PRIVATE tn_engine_foundation)
    target_compile_options(native_engine_fuzz_buffers PRIVATE -fsanitize=fuzzer,address,undefined)
    target_link_options(native_engine_fuzz_buffers PRIVATE -fsanitize=fuzzer,address,undefined)
    set_target_properties(native_engine_fuzz_buffers PROPERTIES CXX_STANDARD 20)
endif()

tn_native_engine_test(tn-native-engine-handles-test tests/native-engine/handles_test.cpp
    native_engine_handles_generation=generation
    native_engine_handles_identity=identity)

tn_native_engine_test(tn-native-engine-buffers-test tests/native-engine/buffers_test.cpp
    native_engine_buffers_range=range
    native_engine_buffers_lease=lease
    native_engine_buffers_views=views
    native_engine_buffer_view_regrowth=view_regrowth
    native_engine_buffers_writes=writes
    native_engine_buffers_deferred=deferred
    native_engine_buffers_lazy_zero=lazy_zero)

tn_native_engine_test(tn-native-engine-lifetime-test tests/native-engine/lifetime_test.cpp
    native_engine_lifetime_detach=detach
    native_engine_lifetime_shared=shared
    native_engine_lifetime_cycles=cycles
    native_engine_lifetime_callback_cycle=callback_cycle
    native_engine_lifetime_soak=soak
    native_engine_reclaim_single_thread=single_thread)

tn_native_engine_test(tn-native-engine-members-test tests/native-engine/members_test.cpp
    native_engine_alias_identity=identity
    native_engine_alias_growth=growth)

# PRD-508 phase 3: the geometry edges a JS caller reaches that no fixture states.
tn_native_engine_test(tn-native-engine-geometry-edges-test tests/native-engine/geometry_edges_test.cpp
    native_engine_geometry_reads_leave_writes=reads_leave_writes
    native_engine_geometry_merge_from=merge_from
    native_engine_geometry_from_doubles=from_doubles_matches_set_raw
    native_engine_geometry_float_items=float_items_match_elements
    native_engine_geometry_js_numbers=js_numbers
    native_engine_geometry_typed_writes=typed_writes
    native_engine_geometry_normalized=normalized
    native_engine_geometry_out_of_range=out_of_range
    native_engine_geometry_nan_bounds=nan_bounds)
target_link_libraries(tn-native-engine-geometry-edges-test PRIVATE tn_engine_scene)

# PRD-508 phase 1: hierarchy, re-parenting, events and member identity.
tn_native_engine_test(tn-native-engine-scene-test tests/native-engine/scene_hierarchy_test.cpp
    native_engine_scene_hierarchy=hierarchy
    native_engine_scene_alias=alias
    native_engine_scene_revision=revision
    native_engine_scene_hierarchy_upstream=upstream
    native_engine_scene_rotation_sync=rotation_sync
    native_engine_scene_teardown=teardown
    native_engine_scene_batched_mesh=batched_mesh)
# The alias case drives the fixture driver's Store as well, which is the other implementor of it.
target_link_libraries(tn-native-engine-scene-test PRIVATE tn_engine_scene tn_fixture_driver)

# PRD-501: the ported V8 fdlibm answers V8's own bits, so a platform libm one bit off fails here.
tn_native_engine_test(tn-native-engine-ieee754-test tests/native-engine/ieee754_test.cpp
    native_engine_ieee754=bits)

# The engine's binding registry for the math and scene classes: one model the fixture driver (and,
# from slice 3, the C ABI) share.
add_library(tn_engine_bindings STATIC src/engine/abi/bindings_math.cpp src/engine/abi/bindings_mathutils.cpp
    src/engine/abi/bindings_scene.cpp src/engine/abi/bindings_geometry.cpp src/engine/abi/bindings_material.cpp)
tn_native_engine_target(tn_engine_bindings)
target_link_libraries(tn_engine_bindings PUBLIC tn_engine_foundation tn_engine_scene tn_engine_animation)
if(EMSCRIPTEN)
    # Bindings report an unsupported member by exception and the ABI catches it at the boundary;
    # engine algorithms never throw. Both sides need Wasm exception handling.
    target_compile_options(tn_engine_bindings PUBLIC -fwasm-exceptions)
    target_link_options(tn_engine_bindings PUBLIC -fwasm-exceptions)
endif()

# PRD-531 phase 1: the registry printed as JSON, the truth of what is natively implemented and
# bound. `--check` compares the output with the committed catalog snapshot and fails on drift.
add_executable(tn-native-engine-registry-dump EXCLUDE_FROM_ALL tests/native-engine/registry_dump.cpp)
target_link_libraries(tn-native-engine-registry-dump PRIVATE tn_engine_bindings)
target_include_directories(tn-native-engine-registry-dump PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine)
tn_native_engine_target(tn-native-engine-registry-dump)
set_property(GLOBAL APPEND PROPERTY TN_NATIVE_ENGINE_TEST_TARGETS tn-native-engine-registry-dump)
if(NOT EMSCRIPTEN)
    add_test(NAME native_engine_registry_snapshot
        COMMAND tn-native-engine-registry-dump --check
            ${CMAKE_CURRENT_SOURCE_DIR}/../three-native/api/native-registry.json)
    set_tests_properties(native_engine_registry_snapshot PROPERTIES LABELS "native-engine")
endif()

# PRD-516: three's animation system, starting with its interpolants.
tn_native_engine_test(tn-native-engine-animation-interpolants-test tests/native-engine/animation/interpolants_test.cpp
    native_engine_animation_interpolants=interpolants)
target_link_libraries(tn-native-engine-animation-interpolants-test PRIVATE tn_engine_animation)
target_include_directories(tn-native-engine-animation-interpolants-test PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/animation)
tn_native_engine_test(tn-native-engine-animation-binding-test tests/native-engine/animation/property_binding_test.cpp
    native_engine_animation_binding_parse=parse native_engine_animation_binding=binding
    native_engine_animation_binding_released=released)
target_link_libraries(tn-native-engine-animation-binding-test PRIVATE tn_engine_animation)
target_include_directories(tn-native-engine-animation-binding-test PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/animation)
tn_native_engine_test(tn-native-engine-animation-mixer-test tests/native-engine/animation/mixer_test.cpp
    native_engine_animation_mixer=mixer native_engine_animation_events=events)
target_link_libraries(tn-native-engine-animation-mixer-test PRIVATE tn_engine_animation)
target_include_directories(tn-native-engine-animation-mixer-test PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/animation)
# PRD-517: property tracks on materials, lights, cameras and visibility.
tn_native_engine_test(tn-native-engine-animation-property-tracks-test tests/native-engine/animation/property_tracks_test.cpp
    native_engine_animation_property_tracks=property_tracks)
target_link_libraries(tn-native-engine-animation-property-tracks-test PRIVATE tn_engine_animation)
target_include_directories(tn-native-engine-animation-property-tracks-test PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/animation)
tn_native_engine_test(tn-native-engine-animation-schedule-test tests/native-engine/animation/schedule_test.cpp
    native_engine_animation_explicit_update=explicit_update)
target_link_libraries(tn-native-engine-animation-schedule-test PRIVATE tn_engine_animation)

# PRD-518 phase 1: the recorded Bone/Skeleton poses reproduce over the native port.
tn_native_engine_test(tn-native-engine-animation-skeleton-test tests/native-engine/animation/skeleton_test.cpp
    native_engine_skeleton_pose=skeleton_pose
    native_engine_skeleton_clone_bounds=clone_bounds)
target_link_libraries(tn-native-engine-animation-skeleton-test PRIVATE tn_engine_animation)
target_include_directories(tn-native-engine-animation-skeleton-test PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/animation)
# PRD-518 phases 2-3: the recorded SkinnedBatch CPU state reproduces over the native palette.
tn_native_engine_test(tn-native-engine-animation-skinned-palette-test tests/native-engine/animation/skinned_palette_test.cpp
    native_engine_skinned_slot_reuse=slot_reuse
    native_engine_skinned_pose_history=pose_history
    native_engine_skinned_update_frequency=update_frequency)
target_link_libraries(tn-native-engine-animation-skinned-palette-test PRIVATE tn_engine_animation)
target_include_directories(tn-native-engine-animation-skinned-palette-test PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/animation)

# PRD-531 raycasting and LOD: real three, binary64 oracle tables (CPU only).
if(NOT EMSCRIPTEN)
    tn_native_engine_test(tn-native-engine-raycast-test tests/native-engine/scene/raycast_test.cpp
        native_engine_raycaster=raycaster native_engine_lod=lod)
    target_link_libraries(tn-native-engine-raycast-test PRIVATE tn_engine_scene)
    target_compile_definitions(tn-native-engine-raycast-test PRIVATE
        TN_RAYCASTER_REFERENCE="${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/scene/raycaster_reference.json"
        TN_LOD_REFERENCE="${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/scene/lod_reference.json")
    find_program(TN_RAYCAST_NODE node REQUIRED)
    foreach(kind raycaster lod)
        add_test(NAME native_engine_${kind}_reference_current
            COMMAND ${TN_RAYCAST_NODE} --import tsx
                packages/runtime-native/tests/native-engine/scene/raycast-reference.ts --check --${kind}
            WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/../..)
        set_tests_properties(native_engine_${kind}_reference_current PROPERTIES LABELS "native-engine")
    endforeach()
endif()

# PRD-508 phase 2: the native OrthographicCamera's projection matrix and its inverse, bit-for-bit
# against the pinned three (ortho_projection_reference.json): zoom, asymmetric frusta, view offsets,
# both renderer coordinate systems and reversed depth. The test reads its table from disk, which a
# Wasm test under node cannot; the camera itself compiles the same there.
if(NOT EMSCRIPTEN)
    tn_native_engine_test(tn-native-engine-ortho-projection-test tests/native-engine/projection/ortho_projection_test.cpp
        native_engine_ortho_projection=ortho_projection)
    target_link_libraries(tn-native-engine-ortho-projection-test PRIVATE tn_engine_scene)
    target_compile_definitions(tn-native-engine-ortho-projection-test PRIVATE
        TN_ORTHO_PROJECTION_REFERENCE="${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/projection/ortho_projection_reference.json")
endif()

# PRD-531: three's `MathUtils` functions and the constants the minimal template imports, bit-exact
# against the pinned three (mathutils_reference.json). The test drives the binding registry, so it
# proves the bound surface, and reads its table from disk, which a Wasm test under node cannot.
if(NOT EMSCRIPTEN)
    tn_native_engine_test(tn-native-engine-mathutils-test tests/native-engine/mathutils/mathutils_test.cpp
        native_engine_mathutils=mathutils)
    target_link_libraries(tn-native-engine-mathutils-test PRIVATE tn_engine_bindings)
    target_include_directories(tn-native-engine-mathutils-test PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src)
    target_compile_definitions(tn-native-engine-mathutils-test PRIVATE
        TN_MATHUTILS_REFERENCE="${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/mathutils/mathutils_reference.json")
endif()

# PRD-519 phase 2: frozen static subtrees, against packages/core/src/static-transform.ts.
tn_native_engine_test(tn-native-engine-static-transform-test tests/native-engine/scene/static_transform_test.cpp
    native_engine_static_transform=static_transform)
target_link_libraries(tn-native-engine-static-transform-test PRIVATE tn_engine_scene)
target_include_directories(tn-native-engine-static-transform-test PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/scene)

# The engine's JSON reader and writer (header-only), against JSON.parse, JSON.stringify and
# Number::toString.
tn_native_engine_test(tn-native-engine-json-test tests/native-engine/json/json_test.cpp
    native_engine_json=corpus native_engine_json_limits=limits)
target_include_directories(tn-native-engine-json-test PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src
    ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/json)

# The native side of the differential fixture runner (PRD-498): run-native.ts spawns the driver.
add_library(tn_fixture_driver STATIC tests/native-engine/fixture/driver.cpp)
tn_native_engine_target(tn_fixture_driver)
target_include_directories(tn_fixture_driver PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine)
target_link_libraries(tn_fixture_driver PUBLIC tn_engine_foundation tn_engine_bindings)
if(EMSCRIPTEN)
    # The driver (a test tool) reports unsupported fixtures by exception; engine code never throws.
    target_compile_options(tn_fixture_driver PUBLIC -fwasm-exceptions)
    target_link_options(tn_fixture_driver PUBLIC -fwasm-exceptions)
endif()
add_executable(tn-native-engine-fixture-driver tests/native-engine/fixture/main.cpp)
target_link_libraries(tn-native-engine-fixture-driver PRIVATE tn_fixture_driver)
tn_native_engine_target(tn-native-engine-fixture-driver)
# The differential ctests run it, so every test aggregate rebuilds it.
set_property(GLOBAL APPEND PROPERTY TN_NATIVE_ENGINE_TEST_TARGETS tn-native-engine-fixture-driver)
tn_native_engine_test(tn-native-engine-fixture-protocol-test tests/native-engine/fixture_driver_test.cpp
    native_engine_fixture_protocol=protocol native_engine_fixture_node_materials=node_materials
    native_engine_fixture_light_targets=light_targets)
target_link_libraries(tn-native-engine-fixture-protocol-test PRIVATE tn_fixture_driver)

# PRD-501 phases 1 and 2 and PRD-508 phase 2: the ported math and scene classes against the pinned
# three, one ctest per fixture prefix. Each case is the differential runner over its prefix and the
# host driver; a mismatch and a blocked row both fail it, because a row nobody ran is a row nobody
# proved. Emscripten needs node and the host-built driver, which an Emscripten build has neither of.
if(NOT EMSCRIPTEN)
    find_program(TN_PNPM_EXECUTABLE pnpm)
    if(TN_PNPM_EXECUTABLE)
        foreach(math_case "math_core:math-core-*" "math_edges:math-edges-*" "math_euler:math-euler-*" "math_primitives:math-primitives-*" "scene_transforms:scene-transforms-*" "scene_cameras:scene-cameras-*" "scene_object_bounds:scene-object-bounds-*" "geometry:geometry-*" "geometry_derived:geometry-derived-*" "material_props:materials-props-*" "light_props:lights-props-*")
            string(REPLACE ":" ";" math_pair "${math_case}")
            list(GET math_pair 0 math_name)
            list(GET math_pair 1 math_glob)
            add_test(NAME native_engine_${math_name}
                COMMAND ${TN_PNPM_EXECUTABLE} --filter @threenative/three-native exec tsx
                    tests/compatibility/run-native.ts
                    --driver $<TARGET_FILE:tn-native-engine-fixture-driver>
                    --only "${math_glob}"
                    --out ${CMAKE_CURRENT_BINARY_DIR}/${math_name}.json)
            set_tests_properties(native_engine_${math_name} PROPERTIES LABELS "native-engine")
        endforeach()
        # Each committed table is what the pinned three (or the core module it mirrors) produces today.
        foreach(reference
                "animation_reference_current:packages/three-native/tests/animation/animation-reference.ts"
                "static_transform_reference_current:packages/runtime-native/tests/native-engine/scene/static-transform-reference.ts"
                "ortho_projection_reference_current:packages/runtime-native/tests/native-engine/projection/ortho_projection-reference.ts"
                "mathutils_reference_current:packages/runtime-native/tests/native-engine/mathutils/mathutils-reference.ts"
                "skeleton_reference_current:packages/runtime-native/tests/native-engine/animation/skeleton-reference.ts"
                "skinned_palette_reference_current:packages/runtime-native/tests/native-engine/animation/skinned-palette-reference.ts"
                "json_reference_current:packages/runtime-native/tests/native-engine/json/json-reference.ts")
            string(REPLACE ":" ";" reference_pair "${reference}")
            list(GET reference_pair 0 reference_name)
            list(GET reference_pair 1 reference_script)
            add_test(NAME native_engine_${reference_name}
                COMMAND ${TN_PNPM_EXECUTABLE} --workspace-root exec tsx ${reference_script} --check
                WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/../..)
            set_tests_properties(native_engine_${reference_name} PROPERTIES LABELS "native-engine")
        endforeach()
        unset(math_case)
        unset(math_pair)
        unset(reference)
        unset(reference_pair)
    else()
        message(WARNING "pnpm not found: the native_engine_math_* and native_engine_scene_* fixture cases are not registered")
    endif()
endif()

# The math fixture cases spawn the driver, so the aggregate target has to build it too.
get_property(tn_native_engine_core_test_targets GLOBAL PROPERTY TN_NATIVE_ENGINE_TEST_TARGETS)
add_custom_target(tn-native-engine-core-tests DEPENDS ${tn_native_engine_core_test_targets}
    tn-native-engine-fixture-driver)
