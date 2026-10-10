# Portable native engine core (PRD-499): targets with no platform API, GPU or VM, and their CPU
# tests. The host build includes it through NativeEngine.cmake; an Emscripten build includes it
# alone, which is the guard that the core stays Wasm-safe (owner decision 4).

option(TN_ENGINE_SANITIZE "Build the native engine targets under ASan and UBSan" OFF)
option(TN_ENGINE_TSAN "Build the native engine targets under ThreadSanitizer (a separate build: TSan excludes ASan)" OFF)
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

# The N03 C ABI over the foundation: version handshake, contexts, generational object handles.
add_library(tn_engine_abi STATIC src/engine/abi/abi.cpp src/engine/abi/identity.cpp src/engine/abi/tsl_call.cpp)
tn_native_engine_target(tn_engine_abi)
target_link_libraries(tn_engine_abi PUBLIC tn_engine_foundation tn_engine_bindings tn_engine_shader)
target_include_directories(tn_engine_abi PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include)

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

# The projected-size camera cull (PRD-519), ported from packages/core/src/render-camera-cull.ts over
# the scene graph: it hides the renderables this camera cannot resolve. Portable, so it joins the
# Wasm core.
add_library(tn_engine_visibility STATIC src/engine/renderer/visibility/camera_cull.cpp)
tn_native_engine_target(tn_engine_visibility)
target_link_libraries(tn_engine_visibility PUBLIC tn_engine_scene)
target_include_directories(tn_engine_visibility PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src)

# Virtual shadow page logic (PRD-524 phase 1), ported from
# packages/core/src/render/virtual-shadow-pages.ts: the pages a frame requests from receiver
# feedback, the bounded LRU physical page pool, and the pages a moving caster invalidates. Portable,
# so it joins the Wasm core.
add_library(tn_engine_vsm STATIC src/engine/renderer/shadows/virtual/pages.cpp
    src/engine/renderer/shadows/virtual/atlas.cpp)
tn_native_engine_target(tn_engine_vsm)
target_link_libraries(tn_engine_vsm PUBLIC tn_engine_foundation)
target_include_directories(tn_engine_vsm PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src)

# Shader IR (N08): typed, hash-consed expressions and ordered effects. Portable like foundation.
add_library(tn_engine_shader STATIC src/engine/shader/ir.cpp src/engine/shader/wgsl.cpp src/engine/shader/package.cpp
    src/engine/shader/standard.cpp src/engine/shader/tonemap.cpp src/engine/shader/output.cpp
    src/engine/shader/graph/graph.cpp src/engine/shader/graph/serialized.cpp src/engine/shader/graph/post_effects.cpp
    src/engine/shader/graph/smaa_tables.cpp src/engine/shader/sprite.cpp)
tn_native_engine_target(tn_engine_shader)
target_include_directories(tn_engine_shader PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src ${CMAKE_CURRENT_SOURCE_DIR}/include
    PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/third_party/stb)
# stb_image is third-party C in a C++ unit: its own warnings are not this engine's.
set_source_files_properties(src/engine/shader/graph/smaa_tables.cpp PROPERTIES COMPILE_OPTIONS "-w")

# Render graph (N14a): pass ordering, transient aliasing and temporal history. Pure CPU logic.
add_library(tn_engine_graph STATIC src/engine/renderer/graph/render_graph.cpp src/engine/renderer/graph/history.cpp)
tn_native_engine_target(tn_engine_graph)
target_include_directories(tn_engine_graph PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src)

# Cooked asset packages (N10): the TNPK reader and its hash gate. Untrusted input, portable.
add_library(tn_engine_assets STATIC src/engine/assets/sha256.cpp src/engine/assets/package.cpp)
tn_native_engine_target(tn_engine_assets)
target_include_directories(tn_engine_assets PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src)

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

# PRD-515 phase 1: glTF/GLB to a native scene in GLTFLoader's shape. cgltf (provisioned by
# download-deps) only parses; the corpus test reads the repository's glTF files from disk.
set(TN_CGLTF_DIR ${CMAKE_CURRENT_SOURCE_DIR}/third_party/cgltf)
# PRD-540: the web host loads models through this same loader, so it builds for Wasm too.
if(EXISTS ${TN_CGLTF_DIR}/cgltf.h)
    add_library(tn_engine_gltf STATIC src/engine/assets/gltf/loader.cpp src/engine/assets/gltf/cgltf_impl.cpp
        src/engine/assets/gltf/image_decode.cpp)
    tn_native_engine_target(tn_engine_gltf)
    target_link_libraries(tn_engine_gltf PUBLIC tn_engine_scene tn_engine_animation tn_engine_foundation)
    target_include_directories(tn_engine_gltf PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src
        PRIVATE ${TN_CGLTF_DIR} ${CMAKE_CURRENT_SOURCE_DIR}/third_party/stb)
    # cgltf is third-party C in a C++ unit: its own warnings are not this engine's.
    set_source_files_properties(src/engine/assets/gltf/cgltf_impl.cpp src/engine/assets/gltf/image_decode.cpp
        PROPERTIES COMPILE_OPTIONS "-w")
    # EXT_texture_webp: libwebp built from the pinned `webp-source` (download-deps.mjs), one build
    # for desktop, Android and iOS. Without the source the extension stays refused by name.
    file(GLOB TN_WEBP_SOURCE_CANDIDATES ${CMAKE_CURRENT_SOURCE_DIR}/third_party/webp-source/libwebp-*)
    set(TN_WEBP_SOURCE_DIR "")
    foreach(candidate ${TN_WEBP_SOURCE_CANDIDATES})
        if(EXISTS ${candidate}/CMakeLists.txt)
            set(TN_WEBP_SOURCE_DIR ${candidate})
        endif()
    endforeach()
    if(TN_WEBP_SOURCE_DIR)
        if(NOT TARGET webp)
            set(WEBP_BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
            set(WEBP_LINK_STATIC ON CACHE BOOL "" FORCE)
            foreach(tool WEBP_BUILD_ANIM_UTILS WEBP_BUILD_CWEBP WEBP_BUILD_DWEBP WEBP_BUILD_GIF2WEBP
                    WEBP_BUILD_IMG2WEBP WEBP_BUILD_VWEBP WEBP_BUILD_WEBPINFO WEBP_BUILD_LIBWEBPMUX WEBP_BUILD_EXTRAS)
                set(${tool} OFF CACHE BOOL "" FORCE)
            endforeach()
            add_subdirectory(${TN_WEBP_SOURCE_DIR} ${CMAKE_BINARY_DIR}/libwebp-build EXCLUDE_FROM_ALL)
        endif()
        target_link_libraries(tn_engine_gltf PRIVATE webp)
        target_compile_definitions(tn_engine_gltf PRIVATE TN_ENGINE_WEBP=1)
    else()
        message(STATUS "webp-source not found: the native glTF loader refuses EXT_texture_webp. Run 'node scripts/download-deps.mjs --only webp-source'.")
    endif()
    tn_native_engine_test(tn-native-engine-gltf-hierarchy-test tests/native-engine/assets/gltf_hierarchy_test.cpp
        native_engine_gltf_hierarchy=hierarchy)
    target_link_libraries(tn-native-engine-gltf-hierarchy-test PRIVATE tn_engine_gltf)
    find_program(TN_PNPM_EXECUTABLE pnpm)
    target_compile_definitions(tn-native-engine-gltf-hierarchy-test PRIVATE
        TN_GLTF_REFERENCE="${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/assets/gltf_reference.json"
        TN_REPO_ROOT="${CMAKE_CURRENT_SOURCE_DIR}/../..")
    if(TN_PNPM_EXECUTABLE)
        add_test(NAME native_engine_gltf_reference_current
            COMMAND ${TN_PNPM_EXECUTABLE} --workspace-root exec tsx
                packages/runtime-native/tests/native-engine/assets/gltf-reference.ts --check
            WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/../..)
        set_tests_properties(native_engine_gltf_reference_current PROPERTIES LABELS "native-engine")
    endif()
    # PRD-515 phase 3: the glTF and TNPK readers under a budgeted, deterministic mutation run from
    # seed files (fuzz_driver.cpp), so the ASan/UBSan lane fuzzes them without a libFuzzer toolchain.
    # TN_FUZZ_ITERATIONS sets the budget (20000 by default).
    set(TN_REPO ${CMAKE_CURRENT_SOURCE_DIR}/../..)
    add_executable(tn-native-engine-fuzz-gltf EXCLUDE_FROM_ALL tests/native-engine/fuzz_gltf.cpp
        tests/native-engine/fuzz_driver.cpp)
    target_link_libraries(tn-native-engine-fuzz-gltf PRIVATE tn_engine_gltf)
    add_executable(tn-native-engine-fuzz-package EXCLUDE_FROM_ALL tests/native-engine/fuzz_package.cpp
        tests/native-engine/fuzz_driver.cpp)
    target_link_libraries(tn-native-engine-fuzz-package PRIVATE tn_engine_assets)
    foreach(fuzz_target tn-native-engine-fuzz-gltf tn-native-engine-fuzz-package)
        tn_native_engine_target(${fuzz_target})
        set_property(GLOBAL APPEND PROPERTY TN_NATIVE_ENGINE_TEST_TARGETS ${fuzz_target})
    endforeach()
    add_test(NAME native_engine_asset_fuzz_gltf COMMAND tn-native-engine-fuzz-gltf
        ${TN_REPO}/packages/create-threenative/templates/starter/assets/native-proof.glb
        ${TN_REPO}/packages/core/__tests__/fixtures/world-v1/assets/rock.glb
        ${TN_REPO}/examples/csg-doorway/assets/doorway.glb
        ${TN_REPO}/packages/create-threenative/__tests__/fixtures/bounded-decals/public/receiver.glb
        ${TN_REPO}/test-support/fixtures/skinned-character.glb
        ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/assets/fuzz-seeds/skinned-character.gltf
        ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/assets/fuzz-seeds/doorway.gltf)
    add_test(NAME native_engine_asset_fuzz_package COMMAND tn-native-engine-fuzz-package
        ${TN_REPO}/packages/assets/__tests__/fixtures/reference.tnpk)
    foreach(fuzz_test native_engine_asset_fuzz_gltf native_engine_asset_fuzz_package)
        set_tests_properties(${fuzz_test} PROPERTIES LABELS "native-engine;native-sanitizer"
            ENVIRONMENT "ASAN_OPTIONS=abort_on_error=1;UBSAN_OPTIONS=halt_on_error=1:print_stacktrace=1")
    endforeach()
else()
    message(STATUS "cgltf not provisioned (or Emscripten): the native glTF loader is not built")
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

tn_native_engine_test(tn-native-engine-shader-ir-test tests/native-engine/shader_ir_test.cpp
    native_engine_tsl_ir_order=order
    native_engine_tsl_ir_types=types
    native_engine_tsl_unsupported=unsupported)
target_link_libraries(tn-native-engine-shader-ir-test PRIVATE tn_engine_shader)

tn_native_engine_test(tn-native-engine-material-test tests/native-engine/material_test.cpp
    native_engine_material_unsupported=unsupported
    native_engine_material_standard_builds=builds
    native_engine_fog_math=fog
    native_engine_material_node_key=node_key
    native_engine_material_bloom_passes=bloom_passes)
target_link_libraries(tn-native-engine-material-test PRIVATE tn_engine_shader)

tn_native_engine_test(tn-native-engine-members-test tests/native-engine/members_test.cpp
    native_engine_alias_identity=identity
    native_engine_alias_growth=growth)

tn_native_engine_test(tn-native-engine-tonemap-test tests/native-engine/tonemap_test.cpp
    native_engine_tonemap_operators=operators)
target_link_libraries(tn-native-engine-tonemap-test PRIVATE tn_engine_shader)

tn_native_engine_test(tn-native-engine-package-test tests/native-engine/package_test.cpp
    native_engine_package_sha256=sha256
    native_engine_cooked_package_parse=load
    native_engine_cooked_package_reject=reject)
target_link_libraries(tn-native-engine-package-test PRIVATE tn_engine_assets)
# PRD-515: every format qualified or refused on this target, mobile and Wasm included.
tn_native_engine_test(tn-native-engine-decoder-matrix-test tests/native-engine/decoder_matrix_test.cpp
    native_engine_decoder_matrix=matrix)
target_link_libraries(tn-native-engine-decoder-matrix-test PRIVATE tn_engine_assets)

tn_native_engine_test(tn-native-engine-render-graph-test tests/native-engine/render_graph_test.cpp
    native_engine_render_graph_order=order
    native_engine_render_graph_aliasing=aliasing
    native_engine_render_graph_diagnostics=diagnostics
    native_engine_history_cut_resize=cut_resize
    native_engine_history_objects=objects
    native_engine_history_multi_render=multi_render)
target_link_libraries(tn-native-engine-render-graph-test PRIVATE tn_engine_graph)
if(NOT EMSCRIPTEN)
    add_test(NAME native_engine_traa_jitter_reference COMMAND sh -c
        "\"$1\" jitter_dump | node \"$2\"" --
        $<TARGET_FILE:tn-native-engine-render-graph-test>
        ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/traa_reference_test.mjs)
    set_tests_properties(native_engine_traa_jitter_reference PROPERTIES LABELS "native-engine")
endif()

tn_native_engine_test(tn-native-engine-abi-test tests/native-engine/abi_test.cpp
    native_engine_abi_version=version
    native_engine_abi_handles=handles
    native_engine_abi_generic=generic
    native_engine_abi_scene=scene
    native_engine_abi_lifetime=lifetime
    native_engine_unsupported_member=unsupported_member
    native_engine_abi_material=material
    native_engine_abi_light=light
    native_engine_abi_callbacks=callbacks
    native_engine_abi_color_set=color_set
    native_engine_abi_children=children
    native_engine_abi_tsl_call=tsl_call
    native_engine_abi_tsl_uniform_value=tsl_uniform_value
    native_engine_abi_tsl_statements=tsl_statements
    native_engine_abi_tsl_effect_parameter=tsl_effect_parameter
    native_engine_abi_mixer_time_field=mixer_time_field
    native_engine_abi_visible_field=visible_field
    native_engine_abi_layers_field=layers_field
    native_engine_abi_walk_parents=walk_parents
    native_engine_abi_property_bind=property_bind
    native_engine_abi_euler_order_field=euler_order_field
    native_engine_abi_object_addresses=object_addresses
    native_engine_abi_geometry_shapes=geometry_shapes
    native_engine_abi_typed_bytes=typed_bytes
    native_engine_abi_data_texture_bytes=data_texture_bytes
    native_engine_abi_attribute_view_writes=attribute_view_writes
    native_engine_abi_attribute_defer=attribute_defer)
target_link_libraries(tn-native-engine-abi-test PRIVATE tn_engine_abi)

# PRD-508 phase 3: the geometry edges a JS caller reaches that no fixture states.
tn_native_engine_test(tn-native-engine-geometry-edges-test tests/native-engine/geometry_edges_test.cpp
    native_engine_geometry_reads_leave_writes=reads_leave_writes
    native_engine_geometry_from_doubles=from_doubles_matches_set_raw
    native_engine_geometry_float_items=float_items_match_elements
    native_engine_geometry_js_numbers=js_numbers
    native_engine_geometry_typed_writes=typed_writes
    native_engine_geometry_normalized=normalized
    native_engine_geometry_out_of_range=out_of_range
    native_engine_geometry_nan_bounds=nan_bounds)
target_link_libraries(tn-native-engine-geometry-edges-test PRIVATE tn_engine_scene)

# PRD-519: every recorded RenderCameraCull report reproduces over the native scene graph.
tn_native_engine_test(tn-native-engine-visibility-camera-cull-test tests/native-engine/visibility/camera_cull_test.cpp
    native_engine_camera_cull=camera_cull)
target_link_libraries(tn-native-engine-visibility-camera-cull-test PRIVATE tn_engine_visibility)
target_include_directories(tn-native-engine-visibility-camera-cull-test PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/visibility)

# PRD-524 phase 1: the recorded page requests, allocations, evictions and invalidations reproduce
# over the native port.
tn_native_engine_test(tn-native-engine-vsm-test tests/native-engine/vsm/vsm_pages_test.cpp
    native_engine_vsm_pages=pages
    native_engine_vsm_invalidation=invalidation)
target_link_libraries(tn-native-engine-vsm-test PRIVATE tn_engine_vsm)
target_include_directories(tn-native-engine-vsm-test PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/vsm)
tn_native_engine_test(tn-native-engine-vsm-atlas-test tests/native-engine/vsm/vsm_atlas_test.cpp
    native_engine_vsm_atlas=atlas
    native_engine_vsm_sampling=sampling)
target_link_libraries(tn-native-engine-vsm-atlas-test PRIVATE tn_engine_vsm tn_engine_shader)

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

# The header compiles as strict C11 and a C program links against the ABI.
add_executable(tn-native-engine-abi-c11 EXCLUDE_FROM_ALL tests/native-engine/abi_c11.c)
target_link_libraries(tn-native-engine-abi-c11 PRIVATE tn_engine_abi)
tn_native_engine_target(tn-native-engine-abi-c11)
set_target_properties(tn-native-engine-abi-c11 PROPERTIES C_STANDARD 11 C_STANDARD_REQUIRED ON C_EXTENSIONS OFF
    LINKER_LANGUAGE CXX)
if(NOT MSVC)
    target_compile_options(tn-native-engine-abi-c11 PRIVATE -Wall -Wextra -Werror -pedantic)
endif()
add_test(NAME native_engine_abi_c11 COMMAND tn-native-engine-abi-c11)
set_tests_properties(native_engine_abi_c11 PROPERTIES LABELS "native-engine")
set_property(GLOBAL APPEND PROPERTY TN_NATIVE_ENGINE_TEST_TARGETS tn-native-engine-abi-c11)

# The native side of the differential fixture runner (PRD-498): run-native.ts spawns the driver.
# The engine's binding registry for the math and scene classes: one model the fixture driver and the
# C ABI share.
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

# PRD-525: probe capture projection, convergence and cooked volumes share the portable CPU core.
add_library(tn_engine_probes STATIC src/engine/renderer/probes/schedule.cpp
    src/engine/renderer/probes/volume.cpp src/engine/assets/probe_volume.cpp)
tn_native_engine_target(tn_engine_probes)
target_link_libraries(tn_engine_probes PUBLIC tn_engine_foundation tn_engine_assets)
target_include_directories(tn_engine_probes PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src)

# The renderer's sources, shared by the native build (NativeEngine.cmake, over the host's WebGPU
# backend) and the browser build below.
set(TN_ENGINE_RENDERER_SOURCES src/engine/renderer/gpu_resources.cpp src/engine/renderer/device_state.cpp
    src/engine/renderer/presentation.cpp src/engine/renderer/package_loader.cpp
    src/engine/renderer/geometry_cache.cpp src/engine/renderer/pipeline_cache.cpp src/engine/renderer/renderer.cpp
    src/engine/renderer/render_database.cpp src/engine/renderer/compute.cpp
    src/engine/renderer/post/traa.cpp src/engine/renderer/post/effects.cpp src/engine/renderer/probes/capture.cpp
    src/engine/renderer/render_target_pass.cpp)
if(EMSCRIPTEN)
    # PRD-532: the same renderer over the browser's WebGPU through Dawn's emdawnwebgpu port, whose
    # webgpu.h is Dawn's. No host services: nothing here may assume a native driver.
    add_library(tn_engine_renderer STATIC ${TN_ENGINE_RENDERER_SOURCES})
    tn_native_engine_target(tn_engine_renderer)
    target_link_libraries(tn_engine_renderer PUBLIC tn_engine_foundation tn_engine_assets tn_engine_shader tn_engine_scene
        tn_engine_animation tn_engine_vsm tn_engine_graph tn_engine_probes)
    target_compile_definitions(tn_engine_renderer PUBLIC MYSTRAL_WEBGPU_DAWN)
    target_compile_options(tn_engine_renderer PUBLIC --use-port=emdawnwebgpu)
    target_link_options(tn_engine_renderer PUBLIC --use-port=emdawnwebgpu)
    target_include_directories(tn_engine_renderer PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include)
    add_executable(tn-native-engine-wasm-renderer-link tests/native-engine/wasm/renderer_link.cpp)
    target_link_libraries(tn-native-engine-wasm-renderer-link PRIVATE tn_engine_renderer)
    target_include_directories(tn-native-engine-wasm-renderer-link PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include)
    tn_native_engine_target(tn-native-engine-wasm-renderer-link)
    # The browser boot page (PRD-532): async init, memory growth, callback delivery, no threads.
    add_executable(tn-native-engine-wasm-boot tests/native-engine/wasm/boot.cpp)
    target_link_libraries(tn-native-engine-wasm-boot PRIVATE tn_engine_renderer)
    target_include_directories(tn-native-engine-wasm-boot PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include)
    target_link_options(tn-native-engine-wasm-boot PRIVATE -sENVIRONMENT=web -sALLOW_MEMORY_GROWTH=1)
    tn_native_engine_target(tn-native-engine-wasm-boot)
    configure_file(tests/native-engine/wasm/boot.html ${CMAKE_CURRENT_BINARY_DIR}/native-core-boot.html COPYONLY)
endif()
if(EMSCRIPTEN)
    # The C ABI as a module for the browser-JS back end (PRD-532); it runs under node as well.
    add_executable(tn-native-engine-abi-module tests/native-engine/wasm/abi_module.cpp)
    target_link_libraries(tn-native-engine-abi-module PRIVATE tn_engine_abi)
    tn_native_engine_target(tn-native-engine-abi-module)
    target_link_options(tn-native-engine-abi-module PRIVATE --no-entry -sMODULARIZE=1 -sEXPORT_NAME=createTnAbi
        -sENVIRONMENT=node,web -sALLOW_MEMORY_GROWTH=1 -sALLOW_TABLE_GROWTH=1
        "-sEXPORTED_FUNCTIONS=_tn_engine_version,_tn_context_create,_tn_context_destroy,_tn_type_id,_tn_object_release,_tn_object_engine_references,_tn_construct,_tn_invoke,_tn_get,_tn_set,_tn_set_callback,_tn_diagnostic_release,_tnw_attribute_view,_tnw_attribute_view_release,_tnw_attribute_defer,_tnw_fire_before_render,_tnw_tsl_dump,_tn_tsl_call,_tn_tsl_release,_tn_tsl_set,_tn_tsl_set_uniform,_tn_tsl_effect_parameter,_malloc,_free"
        "-sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPU32,HEAPF64,UTF8ToString,stringToUTF8,lengthBytesUTF8,addFunction")
    target_include_directories(tn-native-engine-abi-module PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src)
    find_program(TN_PNPM_EXECUTABLE pnpm)
    if(TN_PNPM_EXECUTABLE)
        add_test(NAME native_engine_wasm_browser_backend
            COMMAND ${TN_PNPM_EXECUTABLE} --filter @threenative/three-native exec tsx tests/browser-backend-smoke.ts
                $<TARGET_FILE:tn-native-engine-abi-module>)
        set_tests_properties(native_engine_wasm_browser_backend PROPERTIES LABELS "native-engine"
            PASS_REGULAR_EXPRESSION "TN_BROWSER_BACKEND_OK")
        # PRD-540: wrappers keep their JS state while the engine references them; a detached subtree goes.
        add_test(NAME native_engine_wasm_browser_gc
            COMMAND ${TN_PNPM_EXECUTABLE} --filter @threenative/three-native exec tsx --expose-gc tests/browser-backend-gc.ts
                $<TARGET_FILE:tn-native-engine-abi-module>)
        set_tests_properties(native_engine_wasm_browser_gc PROPERTIES LABELS "native-engine"
            PASS_REGULAR_EXPRESSION "TN_BROWSER_GC_OK")
        # PRD-540: the JS TSL corpus V8 passes (native_engine_tsl_js), on the Wasm back end.
        add_test(NAME native_engine_wasm_tsl_js
            COMMAND ${TN_PNPM_EXECUTABLE} exec node tests/native-engine/differential.mjs --suite tsl-ir
                --wasm $<TARGET_FILE:tn-native-engine-abi-module>
            WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR})
        set_tests_properties(native_engine_wasm_tsl_js PROPERTIES LABELS "native-engine")
    endif()
endif()

if(EMSCRIPTEN)
    # PRD-532 box 62: catalog-authored JS scenes and cooked packages on a WebGPU canvas.
    add_executable(tn-native-engine-wasm-browser tests/native-engine/wasm/browser.cpp
        tests/native-engine/wasm/abi_module.cpp)
    target_link_libraries(tn-native-engine-wasm-browser PRIVATE tn_engine_abi tn_engine_renderer)
    target_include_directories(tn-native-engine-wasm-browser PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include)
    tn_native_engine_target(tn-native-engine-wasm-browser)
    target_link_options(tn-native-engine-wasm-browser PRIVATE --no-entry -sMODULARIZE=1
        --profiling-funcs
        -sASSERTIONS=0 -sSAFE_HEAP=0 -sEXPORT_NAME=createTnBrowser -sENVIRONMENT=node,web -sALLOW_MEMORY_GROWTH=1 -sALLOW_TABLE_GROWTH=1
        "-sEXPORTED_FUNCTIONS=_tn_engine_version,_tn_context_create,_tn_context_destroy,_tn_type_id,_tn_object_release,_tn_object_engine_references,_tn_construct,_tn_invoke,_tn_get,_tn_set,_tn_set_callback,_tn_diagnostic_release,_tnw_attribute_view,_tnw_attribute_view_release,_tnw_attribute_defer,_tnw_fire_before_render,_tnw_init,_tnw_render,_tnw_verify_package,_tnw_load_package,_tnw_bench_init,_tnw_bench_step,_tnw_bulk_transforms,_tnw_bench_stats,_tnw_bench_prepare,_malloc,_free"
        "-sEXPORTED_RUNTIME_METHODS=wasmMemory,HEAPU8,HEAPU32,HEAPF64,UTF8ToString,stringToUTF8,lengthBytesUTF8,addFunction")
    # PRD-540: the product browser host a web game gets under `engine: "native"`. It is an ES
    # module beside its .wasm in the package's build/web/ directory, where createWebEnginePlugin finds it.
    add_executable(tn-native-engine-web src/engine/wasm/web_host.cpp)
    target_link_libraries(tn-native-engine-web PRIVATE tn_engine_abi tn_engine_renderer)
    if(TARGET tn_engine_gltf)
        target_link_libraries(tn-native-engine-web PRIVATE tn_engine_gltf)
        target_compile_definitions(tn-native-engine-web PRIVATE TN_WEB_GLTF=1)
    endif()
    target_include_directories(tn-native-engine-web PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include)
    tn_native_engine_target(tn-native-engine-web)
    # `pnpm profile:wasm-page` names Wasm functions only in a module linked with their names.
    option(TN_WEB_PROFILING_FUNCS "Keep Wasm function names in the web host, for profiling" OFF)
    if(TN_WEB_PROFILING_FUNCS)
        target_link_options(tn-native-engine-web PRIVATE --profiling-funcs)
    endif()
    set_target_properties(tn-native-engine-web PROPERTIES SUFFIX ".mjs"
        RUNTIME_OUTPUT_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/build/web)
    target_link_options(tn-native-engine-web PRIVATE --no-entry -sMODULARIZE=1 -sEXPORT_ES6=1
        # The whole 32-bit address space: a game the size of Midway (161 MB of GLBs, decoded on the
        # engine side) ran past emscripten's 2 GB default maximum and failed with std::bad_alloc.
        -sASSERTIONS=0 -sEXPORT_NAME=createTnWeb -sENVIRONMENT=web -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=4GB -sALLOW_TABLE_GROWTH=1
        "-sEXPORTED_FUNCTIONS=_tn_engine_version,_tn_context_create,_tn_context_destroy,_tn_type_id,_tn_object_release,_tn_object_engine_references,_tn_construct,_tn_invoke,_tn_get,_tn_set,_tn_set_callback,_tn_diagnostic_release,_tnw_attribute_view,_tnw_attribute_view_release,_tnw_attribute_defer,_tnw_web_init,_tnw_web_set_samples,_tnw_web_poll,_tnw_web_error,_tnw_web_adapter,_tnw_web_resize,_tnw_web_render,_tnw_web_compile,_tnw_web_compile_poll,_tnw_web_init_texture,_tnw_web_frame,_tn_tsl_call,_tn_tsl_release,_tn_tsl_set,_tn_tsl_set_uniform,_tn_tsl_effect_parameter,_tnw_web_set_post,_malloc,_free,_tnw_web_renderer_state,_tnw_web_load_gltf,_tnw_web_load_error,_tnw_web_render_target,_tnw_web_read_target,_tnw_web_read_target_take,_tnw_web_gpu_timer,_tnw_web_texture_image"
        "-sEXPORTED_RUNTIME_METHODS=wasmMemory,HEAPU8,HEAPU32,HEAPF64,UTF8ToString,stringToUTF8,lengthBytesUTF8,addFunction,specialHTMLTargets")
    find_program(TN_WASM_NODE node REQUIRED)
    configure_file(tests/native-engine/wasm/assets.html ${CMAKE_CURRENT_BINARY_DIR}/native-core-assets.html COPYONLY)
    add_custom_target(tn-native-engine-wasm-assets
        COMMAND ${TN_WASM_NODE} --import tsx tests/native-engine/wasm/assets-bundle.ts ${CMAKE_CURRENT_BINARY_DIR}
        WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}
        DEPENDS tn-native-engine-wasm-browser
        COMMENT "Bundle the catalog browser adapter and cook TNPK geometry (no upstream three.js)")
    # PRD-533: the warm-cache update scaling case as Wasm under node, the CPU screen for the engine's
    # per-object cost with V8's code generator and no browser or GPU. It never touches the device.
    add_executable(tn-native-engine-wasm-update-screen EXCLUDE_FROM_ALL tests/native-engine/update_scaling_test.cpp)
    target_link_libraries(tn-native-engine-wasm-update-screen PRIVATE tn_engine_renderer)
    target_include_directories(tn-native-engine-wasm-update-screen PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include)
    tn_native_engine_target(tn-native-engine-wasm-update-screen)
    target_link_options(tn-native-engine-wasm-update-screen PRIVATE -sENVIRONMENT=node -sALLOW_MEMORY_GROWTH=1
        --profiling-funcs -sWARN_ON_UNDEFINED_SYMBOLS=0 -sERROR_ON_UNDEFINED_SYMBOLS=0 -sASSERTIONS=0 -sEXIT_RUNTIME=1
        --pre-js ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/wasm/update_screen_pre.js)
    # The browser preset builds this renderer/ABI slice; the full Wasm CPU lane remains unchanged.
    option(TN_ENGINE_WASM_BROWSER_ONLY "Configure the browser renderer and ABI slice only" OFF)
    if(TN_ENGINE_WASM_BROWSER_ONLY)
        return()
    endif()
endif()

# PRD-506: a compiled TypeScript closure called by the engine, through the native-TypeScript corpus
# runner against this build's archives. The archives must link with a plain C++ driver, so not under
# sanitizers, and the pinned compiler targets the host, so not for Wasm or a cross build.
if(NOT EMSCRIPTEN AND NOT TN_ENGINE_CORE_ONLY AND NOT TN_ENGINE_SANITIZE)
    find_program(TN_NODE_EXECUTABLE node)
    if(TN_NODE_EXECUTABLE)
        add_test(NAME native_engine_aot_callback
            COMMAND ${TN_NODE_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/../../tools/native-typescript/run-corpus.mjs
                --native --case aot-callback)
        set_tests_properties(native_engine_aot_callback PROPERTIES
            LABELS "native-engine;native-typescript"
            ENVIRONMENT "TN_NATIVE_ENGINE_BUILD=${CMAKE_BINARY_DIR}"
            PASS_REGULAR_EXPRESSION "aot-callback +- +PASS")
    endif()
endif()

# PRD-530: the artifact identity manifest, its checks and the tool a packager runs.
tn_native_engine_test(tn-native-engine-identity-test tests/native-engine/identity_test.cpp
    native_engine_artifact_identity=identity)
target_link_libraries(tn-native-engine-identity-test PRIVATE tn_engine_abi)
add_executable(tn-native-engine-identity EXCLUDE_FROM_ALL tests/native-engine/identity_tool.cpp)
target_link_libraries(tn-native-engine-identity PRIVATE tn_engine_abi)
tn_native_engine_target(tn-native-engine-identity)
set_property(GLOBAL APPEND PROPERTY TN_NATIVE_ENGINE_TEST_TARGETS tn-native-engine-identity)

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
# PRD-517: property tracks on materials, lights, cameras and visibility.
tn_native_engine_test(tn-native-engine-animation-property-tracks-test tests/native-engine/animation/property_tracks_test.cpp
    native_engine_animation_property_tracks=property_tracks)
target_link_libraries(tn-native-engine-animation-property-tracks-test PRIVATE tn_engine_animation)
target_include_directories(tn-native-engine-animation-property-tracks-test PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/animation)
tn_native_engine_test(tn-native-engine-animation-schedule-test tests/native-engine/animation/schedule_test.cpp
    native_engine_animation_explicit_update=explicit_update)
target_link_libraries(tn-native-engine-animation-schedule-test PRIVATE tn_engine_animation)
target_include_directories(tn-native-engine-animation-mixer-test PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/animation)
# PRD-519 phase 1 / PRD-518 phase 2: the render projection's batching decisions (header-only
# engine/renderer/projection/plan.h) against the real SceneRenderProjection. The test reads its JSON
# table from disk, which a Wasm test under node cannot; the header compiles the same there.
if(NOT EMSCRIPTEN)
    tn_native_engine_test(tn-native-engine-projection-plan-test tests/native-engine/projection/plan_test.cpp
        native_engine_projection_plan=plan)
    # PRD-519 box 32 names the projection-*.spec.ts verdicts beside instanced-batch.spec.ts.
    add_test(NAME native_engine_batching_eligibility_projection COMMAND tn-native-engine-projection-plan-test plan)
    set_tests_properties(native_engine_batching_eligibility_projection PROPERTIES LABELS "native-engine")
    target_link_libraries(tn-native-engine-projection-plan-test PRIVATE tn_engine_animation)
    target_include_directories(tn-native-engine-projection-plan-test PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src)
    target_compile_definitions(tn-native-engine-projection-plan-test PRIVATE
        TN_PROJECTION_REFERENCE="${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/projection/projection_reference.json")
endif()

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

# PRD-528 phase 1, PRD-521 phase 3: the fixed-step clock and the world height buffer, ported from
# packages/core/src/loop.ts, world-heightmap.ts and world.ts. PRD-521 box 38 adds the tile admission,
# LOD and collider decisions ported from packages/core/src/world-tiles.ts.
add_library(tn_engine_world STATIC src/engine/world/loop/fixed_step.cpp
    src/engine/world/terrain/heights.cpp src/engine/world/tiles/terrain_tiles.cpp
    src/engine/world/cells/world_cells.cpp
    src/engine/world/events/completion_queue.cpp
    src/engine/world/package/world_package.cpp)
tn_native_engine_target(tn_engine_world)
target_link_libraries(tn_engine_world PUBLIC tn_engine_foundation)
target_include_directories(tn_engine_world PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src)
tn_native_engine_test(tn-native-engine-loop-fixed-step-test tests/native-engine/loop/fixed_step_test.cpp
    native_engine_loop_fixed_step=fixed_step)
target_link_libraries(tn-native-engine-loop-fixed-step-test PRIVATE tn_engine_world)
target_include_directories(tn-native-engine-loop-fixed-step-test PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/loop)
tn_native_engine_test(tn-native-engine-world-heights-test tests/native-engine/world/heights_test.cpp
    native_engine_world_heights=heights)
target_link_libraries(tn-native-engine-world-heights-test PRIVATE tn_engine_world)
target_include_directories(tn-native-engine-world-heights-test PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/world)
# PRD-521 box 38: which tiles a follow admits under the caps, which it defers or evicts, the level
# each resident tile may show, and which tiles carry a collider body. The port owns no GPU resource;
# `native_engine_world_tiles_reference_current` keeps the committed table equal to what the core
# module produces today.
tn_native_engine_test(tn-native-engine-world-tiles-test tests/native-engine/world/world_tiles_test.cpp
    native_engine_world_tiles=world_tiles)
target_link_libraries(tn-native-engine-world-tiles-test PRIVATE tn_engine_world)
target_include_directories(tn-native-engine-world-tiles-test PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/world)
find_program(TN_PNPM_TILES_EXECUTABLE pnpm)
if(TN_PNPM_TILES_EXECUTABLE)
    add_test(NAME native_engine_world_tiles_reference_current
        COMMAND ${TN_PNPM_TILES_EXECUTABLE} --workspace-root exec tsx
            packages/runtime-native/tests/native-engine/world/world-tiles-reference.ts --check
        WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/../..)
    set_tests_properties(native_engine_world_tiles_reference_current PROPERTIES LABELS "native-engine")
else()
    message(WARNING "pnpm not found: native_engine_world_tiles_reference_current is not registered")
endif()
# PRD-521 box 37: residency, bounded admission, chunk groups and chain LOD decisions.
# The test reads its JSON table from disk, which a Wasm test under node cannot; the library still
# builds for Wasm.
find_program(TN_WORLD_NODE_EXECUTABLE node)
if(NOT EMSCRIPTEN)
    tn_native_engine_test(tn-native-engine-world-cells-test tests/native-engine/world/world_cells_test.cpp
        native_engine_world_cells=world_cells native_engine_admission_budget=admission_budget)
    target_link_libraries(tn-native-engine-world-cells-test PRIVATE tn_engine_world tn_engine_assets)
    target_compile_definitions(tn-native-engine-world-cells-test PRIVATE
        TN_WORLD_CELLS_REFERENCE="${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/world/world_cells_reference.json")
    if(MSVC)
        target_link_options(tn-native-engine-world-cells-test PRIVATE "/MAP:$<TARGET_FILE_DIR:tn-native-engine-world-cells-test>/tn-native-engine-world-cells-test.map")
    endif()
    # Inspect the real CPU world fixture and its static native closure, not a synthetic empty
    # executable or the unrelated player. PRD-522's desktop walk is not implemented yet.
    if(TN_WORLD_NODE_EXECUTABLE)
        add_test(NAME native_engine_strict_artifact_inspect
            COMMAND ${TN_WORLD_NODE_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/scripts/inspect-js-free.mjs
                --binary $<TARGET_FILE:tn-native-engine-world-cells-test> --native-world)
        set_tests_properties(native_engine_strict_artifact_inspect PROPERTIES LABELS "native-engine")
    endif()
endif()
if(TN_PNPM_TILES_EXECUTABLE)
    add_test(NAME native_engine_world_cells_reference_current
        COMMAND ${TN_WORLD_NODE_EXECUTABLE} --import tsx
            packages/runtime-native/tests/native-engine/world/world-cells-reference.ts --check
        WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/../..)
    set_tests_properties(native_engine_world_cells_reference_current PROPERTIES LABELS "native-engine")
else()
    message(WARNING "pnpm not found: native_engine_world_cells_reference_current is not registered")
endif()
# PRD-521 phase 1: the ported world.json validator and cellPlacements against world-package.ts.
tn_native_engine_test(tn-native-engine-world-package-test tests/native-engine/world/world_package_test.cpp
    native_engine_world_package=world_package)
target_link_libraries(tn-native-engine-world-package-test PRIVATE tn_engine_world)
target_include_directories(tn-native-engine-world-package-test PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/world)
# PRD-520 phase 1: completions from worker threads, drained on the game thread; also under TSan
# (TN_ENGINE_TSAN). Emscripten builds the queue but has no threads to post from here.
if(NOT EMSCRIPTEN)
    find_package(Threads REQUIRED)
    tn_native_engine_test(tn-native-engine-event-queue-test tests/native-engine/world/event_queue_test.cpp
        native_engine_event_queue=event_queue native_engine_event_queue_teardown=teardown)
    target_link_libraries(tn-native-engine-event-queue-test PRIVATE tn_engine_world Threads::Threads)
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

# PRD-529 phase 1: the playtest device protocol on the native engine.
add_library(tn_engine_inspect STATIC src/engine/inspect/endpoint.cpp)
tn_native_engine_target(tn_engine_inspect)
target_link_libraries(tn_engine_inspect PUBLIC tn_engine_scene)
target_include_directories(tn_engine_inspect PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src)
tn_native_engine_test(tn-native-engine-inspect-test tests/native-engine/inspect/inspect_test.cpp
    native_engine_inspect_protocol=protocol native_engine_inspect_input_tick=input_tick)
target_link_libraries(tn-native-engine-inspect-test PRIVATE tn_engine_inspect tn_engine_world)
target_include_directories(tn-native-engine-inspect-test PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/inspect)

add_library(tn_fixture_driver STATIC tests/native-engine/fixture/driver.cpp)
tn_native_engine_target(tn_fixture_driver)
target_include_directories(tn_fixture_driver PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine)
if(TARGET tn_engine_gltf)
    # The `gltf` fixture op loads a repository file through the native loader.
    target_link_libraries(tn_fixture_driver PUBLIC tn_engine_gltf)
    target_compile_definitions(tn_fixture_driver PRIVATE TN_FIXTURE_GLTF=1)
endif()
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
        # PRD-516: the committed interpolant table is what the pinned three produces today.
        add_test(NAME native_engine_animation_reference_current
            COMMAND ${TN_PNPM_EXECUTABLE} --workspace-root exec tsx
                packages/three-native/tests/animation/animation-reference.ts --check
            WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/../..)
        set_tests_properties(native_engine_animation_reference_current PROPERTIES LABELS "native-engine")
        # PRD-528 phase 1: the committed fixed-step table is what loop.ts produces today.
        add_test(NAME native_engine_loop_reference_current
            COMMAND ${TN_PNPM_EXECUTABLE} --workspace-root exec tsx
                packages/runtime-native/tests/native-engine/loop/loop-reference.ts --check
            WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/../..)
        set_tests_properties(native_engine_loop_reference_current PROPERTIES LABELS "native-engine")
        add_test(NAME native_engine_static_transform_reference_current
            COMMAND ${TN_PNPM_EXECUTABLE} --workspace-root exec tsx
                packages/runtime-native/tests/native-engine/scene/static-transform-reference.ts --check
            WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/../..)
        set_tests_properties(native_engine_static_transform_reference_current PROPERTIES LABELS "native-engine")
        # PRD-519 phase 1: the committed projection table is what SceneRenderProjection decides today.
        add_test(NAME native_engine_projection_plan_reference_current
            COMMAND ${TN_PNPM_EXECUTABLE} --workspace-root exec tsx
                packages/runtime-native/tests/native-engine/projection/projection-reference.ts --check
            WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/../..)
        set_tests_properties(native_engine_projection_plan_reference_current PROPERTIES LABELS "native-engine")
        # The committed orthographic camera table is what the pinned three produces today.
        add_test(NAME native_engine_ortho_projection_reference_current
            COMMAND ${TN_PNPM_EXECUTABLE} --workspace-root exec tsx
                packages/runtime-native/tests/native-engine/projection/ortho_projection-reference.ts --check
            WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/../..)
        set_tests_properties(native_engine_ortho_projection_reference_current PROPERTIES LABELS "native-engine")
        # PRD-531: the committed MathUtils table is what the pinned three produces today.
        add_test(NAME native_engine_mathutils_reference_current
            COMMAND ${TN_PNPM_EXECUTABLE} --workspace-root exec tsx
                packages/runtime-native/tests/native-engine/mathutils/mathutils-reference.ts --check
            WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/../..)
        set_tests_properties(native_engine_mathutils_reference_current PROPERTIES LABELS "native-engine")
        # PRD-518 phase 1: the committed skeleton table is what the pinned three's Bone/Skeleton produce.
        add_test(NAME native_engine_skeleton_reference_current
            COMMAND ${TN_PNPM_EXECUTABLE} --workspace-root exec tsx
                packages/runtime-native/tests/native-engine/animation/skeleton-reference.ts --check
            WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/../..)
        set_tests_properties(native_engine_skeleton_reference_current PROPERTIES LABELS "native-engine")
        # PRD-518 phases 2-3: the committed palette table is what the pinned SkinnedBatch produces.
        add_test(NAME native_engine_skinned_palette_reference_current
            COMMAND ${TN_PNPM_EXECUTABLE} --workspace-root exec tsx
                packages/runtime-native/tests/native-engine/animation/skinned-palette-reference.ts --check
            WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/../..)
        set_tests_properties(native_engine_skinned_palette_reference_current PROPERTIES LABELS "native-engine")
        add_test(NAME native_engine_json_reference_current
            COMMAND ${TN_PNPM_EXECUTABLE} --workspace-root exec tsx
                packages/runtime-native/tests/native-engine/json/json-reference.ts --check
            WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/../..)
        set_tests_properties(native_engine_json_reference_current PROPERTIES LABELS "native-engine")
        add_test(NAME native_engine_inspect_methods_current
            COMMAND ${TN_PNPM_EXECUTABLE} --workspace-root exec tsx
                packages/runtime-native/tests/native-engine/inspect/protocol-methods.ts --check
            WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/../..)
        set_tests_properties(native_engine_inspect_methods_current PROPERTIES LABELS "native-engine")
        # PRD-521 phase 3: the committed height table is what world-heightmap.ts and world.ts produce.
        add_test(NAME native_engine_world_heights_reference_current
            COMMAND ${TN_PNPM_EXECUTABLE} --workspace-root exec tsx
                packages/runtime-native/tests/native-engine/world/heights-reference.ts --check
            WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/../..)
        set_tests_properties(native_engine_world_heights_reference_current PROPERTIES LABELS "native-engine")
        # PRD-521 phase 1: the committed world.json table is what world-package.ts produces today.
        add_test(NAME native_engine_world_package_reference_current
            COMMAND ${TN_PNPM_EXECUTABLE} --workspace-root exec tsx
                packages/runtime-native/tests/native-engine/world/world-package-reference.ts --check
            WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/../..)
        set_tests_properties(native_engine_world_package_reference_current PROPERTIES LABELS "native-engine")
        # PRD-519: the committed camera-cull table is what render-camera-cull.ts produces today.
        add_test(NAME native_engine_camera_cull_reference_current
            COMMAND ${TN_PNPM_EXECUTABLE} --workspace-root exec tsx
                packages/runtime-native/tests/native-engine/visibility/camera-cull-reference.ts --check
            WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/../..)
        set_tests_properties(native_engine_camera_cull_reference_current PROPERTIES LABELS "native-engine")
        # PRD-524 phase 1: the committed VSM table is what virtual-shadow-pages.ts produces today.
        add_test(NAME native_engine_vsm_reference_current
            COMMAND ${TN_PNPM_EXECUTABLE} --workspace-root exec tsx
                packages/runtime-native/tests/native-engine/vsm/vsm-reference.ts --check
            WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/../..)
        set_tests_properties(native_engine_vsm_reference_current PROPERTIES LABELS "native-engine")
        unset(math_case)
        unset(math_pair)
    else()
        message(WARNING "pnpm not found: the native_engine_math_* and native_engine_scene_* fixture cases are not registered")
    endif()
endif()

# The math fixture cases spawn the driver, so the aggregate target has to build it too.
get_property(tn_native_engine_core_test_targets GLOBAL PROPERTY TN_NATIVE_ENGINE_TEST_TARGETS)
add_custom_target(tn-native-engine-core-tests DEPENDS ${tn_native_engine_core_test_targets}
    tn-native-engine-fixture-driver)
