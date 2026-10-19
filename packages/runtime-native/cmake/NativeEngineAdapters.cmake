# Game-runtime adapters (PRD-531, PRD-573 slice 6): above the engine, never below it. Included only by
# `-DTN_ENGINE_ONLY=ON -DTN_ENGINE_PLAYER=ON -DMYSTRAL_USE_V8=ON`, after V8 is configured; nothing in
# NativeEngine*.cmake may link these targets. Every executable is EXCLUDE_FROM_ALL and the aggregate
# `tn-native-engine-v8` builds them, so the default (legacy) configure defines none of it.

if(NOT TARGET v8::v8 OR NOT MYSTRAL_USE_V8 OR MYSTRAL_PLATFORM STREQUAL "ios" OR MYSTRAL_PLATFORM STREQUAL "android")
    message(FATAL_ERROR "TN_ENGINE_PLAYER needs a desktop V8 (-DMYSTRAL_USE_V8=ON and third_party/v8 from scripts/download-deps.mjs)")
endif()

# three@0.185.1's math sources as one embedded script (PRD-573 v1.11 step 4a), run at the end of Adapter::install
# when JS math is on. The workspace root installs esbuild only when something there depends on it; runtime-native
# always does. Without esbuild the adapter builds, and turning JS math on fails by name at install.
find_program(TN_ESBUILD esbuild NO_DEFAULT_PATH
    HINTS ${CMAKE_CURRENT_SOURCE_DIR}/../../node_modules/.bin ${CMAKE_CURRENT_SOURCE_DIR}/node_modules/.bin)
set(TN_MATH_DIR ${CMAKE_CURRENT_BINARY_DIR}/tn_math)
set(TN_MATH_HEADER ${TN_MATH_DIR}/tn_math_script.h)
if(TN_ESBUILD)
    file(GLOB TN_MATH_THREE_SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/node_modules/three/src/math/*.js)
    add_custom_command(OUTPUT ${TN_MATH_DIR}/tn_math.js
        COMMAND ${CMAKE_COMMAND} -E make_directory ${TN_MATH_DIR}
        COMMAND ${TN_ESBUILD} ${CMAKE_CURRENT_SOURCE_DIR}/src/adapters/v8/math/entry.js --bundle --minify --format=iife
            --platform=neutral --target=es2022 --log-level=error --outfile=${TN_MATH_DIR}/tn_math.js
        DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/src/adapters/v8/math/entry.js ${TN_MATH_THREE_SOURCES}
        COMMENT "Bundling three's math for the V8 adapter")
    add_custom_command(OUTPUT ${TN_MATH_HEADER}
        COMMAND ${CMAKE_COMMAND} -DOUTPUT=${TN_MATH_HEADER} -DSOURCE_DIR=${TN_MATH_DIR} -DSCRIPT_NAMES=tn_math
            -P ${CMAKE_CURRENT_SOURCE_DIR}/cmake/EmbedRuntimeScripts.cmake
        DEPENDS ${TN_MATH_DIR}/tn_math.js ${CMAKE_CURRENT_SOURCE_DIR}/cmake/EmbedRuntimeScripts.cmake
        COMMENT "Embedding three's math script")
endif()

add_library(tn_adapter_v8 STATIC src/adapters/v8/adapter.cpp src/adapters/v8/math_bridge.cpp src/adapters/v8/tsl.cpp)
if(TN_ESBUILD)
    target_sources(tn_adapter_v8 PRIVATE ${TN_MATH_HEADER})
    target_include_directories(tn_adapter_v8 PRIVATE ${TN_MATH_DIR})
    target_compile_definitions(tn_adapter_v8 PRIVATE TN_JS_MATH_EMBEDDED=1)
endif()
# Not tn_native_engine_target: an adapter is not an engine target, and the graph check would
# rightly fail on its V8 link.
set_target_properties(tn_adapter_v8 PROPERTIES CXX_STANDARD 20 CXX_STANDARD_REQUIRED ON POSITION_INDEPENDENT_CODE ON)
target_include_directories(tn_adapter_v8 PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src)
target_link_libraries(tn_adapter_v8 PUBLIC tn_engine_abi tn_engine_bindings tn_engine_shader v8::v8 ${V8_SYSTEM_LIBS})

# Dawn and the V8 monolith both carry Abseil, as for mystral-runtime: the same version's duplicate
# definitions are folded rather than refused.
function(tn_adapter_v8_executable target)
    set_target_properties(${target} PROPERTIES CXX_STANDARD 20 CXX_STANDARD_REQUIRED ON)
    if(NOT APPLE AND NOT WIN32)
        target_link_options(${target} PRIVATE "LINKER:--allow-multiple-definition")
    elseif(APPLE)
        # ld64 has no --allow-multiple-definition: V8 and Dawn both carry Abseil, and native physics
        # and SWC both carry the Rust runtime (release run 39247695392). Same recipe as
        # mystral-runtime: load V8 whole first and dead-strip the unused duplicates.
        get_target_property(_tn_v8_location v8::v8 IMPORTED_LOCATION)
        target_link_libraries(${target} PRIVATE "-Wl,-force_load,${_tn_v8_location}")
        target_link_options(${target} PRIVATE "-Wl,-dead_strip")
    elseif(MSVC)
        # Same as mystral-runtime: the prebuilt Rust and Abseil archives carry overlapping symbols,
        # and Rust std (native physics, SWC) imports from these system libraries, ntdll included.
        target_link_options(${target} PRIVATE "/FORCE:MULTIPLE")
        target_link_libraries(${target} PRIVATE ws2_32 advapi32 crypt32 bcrypt userenv ntdll)
    endif()
    set_property(GLOBAL APPEND PROPERTY TN_NATIVE_ENGINE_V8_TARGETS ${target})
endfunction()

add_executable(tn-native-engine-v8-test EXCLUDE_FROM_ALL tests/native-engine/v8_adapter_test.cpp)
target_link_libraries(tn-native-engine-v8-test PRIVATE tn_adapter_v8)
target_include_directories(tn-native-engine-v8-test PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine)
tn_adapter_v8_executable(tn-native-engine-v8-test)
foreach(case template_material template_bounds template_ranges handles fast_paths structure_stamp crossing_histogram collect_visits native_matrix_world native_projection_report unsupported gc_release runtime_churn crossing_bench scene raycaster_lod object_raycast catalog_coverage callback_cycle wrapper_lifetime tsl_api uniform_value fog_node node_material_fragment node_materials skeletal attribute_arrays geometry_lifecycle material_slots js_math js_math_views js_math_members)
    add_test(NAME native_engine_v8_${case} COMMAND tn-native-engine-v8-test ${case})
    set_tests_properties(native_engine_v8_${case} PROPERTIES LABELS "native-engine")
endforeach()

# PRD-531 slice 2: the upstream corpus authored in JS through the native lazy graph.
add_executable(tn-native-engine-tsl-js EXCLUDE_FROM_ALL tests/native-engine/tsl-corpus/tsl_js.cpp)
target_link_libraries(tn-native-engine-tsl-js PRIVATE tn_adapter_v8)
target_compile_definitions(tn-native-engine-tsl-js PRIVATE
    TN_TSL_CORPUS="${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/tsl-corpus/corpus.js")
tn_adapter_v8_executable(tn-native-engine-tsl-js)
if(TN_PNPM_EXECUTABLE AND TN_NODE_EXECUTABLE)
    add_test(NAME native_engine_tsl_js
        COMMAND ${TN_NODE_EXECUTABLE} tests/native-engine/differential.mjs --suite tsl-ir
            --native $<TARGET_FILE:tn-native-engine-tsl-js>
        WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR})
    set_tests_properties(native_engine_tsl_js PROPERTIES LABELS "native-engine")
endif()

# CP1's game host (PRD-534): a workload script on V8 through the adapter (native-v8), its C++ twin
# (--cpp, native-cpp) or the C++ skinned crowd (--crowd, PRD-533), drawn through the native renderer
# and measured per frame.
add_executable(tn-native-engine-host EXCLUDE_FROM_ALL src/adapters/v8/host_main.cpp
    src/engine/player/skinned_crowd.cpp)
target_link_libraries(tn-native-engine-host PRIVATE tn_adapter_v8 tn_engine_renderer tn_host_services
    tn_engine_animation)
tn_adapter_v8_executable(tn-native-engine-host)

# PRD-531 phase 3: the desktop player with a game bundle on V8. It reuses the JS-free player's
# window/loop/render/mailbox path (tn_engine_player), so only the game side differs. It links the
# adapter, so it is a JS artifact and never a tn_native_engine_target:
#   node packages/playtest/dist/runner/cli.js <scenario> --target desktop \
#     --executable <build>/tn-native-engine-player-v8 --host-arg <game>.js
# The minimal template is the cold-agent proof (scenarios/native-engine-minimal-v8.playtest.json): bundle it with
#   node scripts/bundle-native-engine.mjs --engine native --game-runtime v8 --entry <template>/src/game.ts \
#     --out <dir>/game.js --assets <template> --asset-source packages/create-threenative/template-assets/assets
# which cooks into the template's public/ (remove those untracked outputs afterwards), then run the scenario.
add_executable(tn-native-engine-player-v8 EXCLUDE_FROM_ALL src/engine/player/v8_main.cpp)
target_link_libraries(tn-native-engine-player-v8 PRIVATE tn_adapter_v8 tn_engine_player tn_engine_assets)
if(TARGET tn_engine_gltf)
    target_link_libraries(tn-native-engine-player-v8 PRIVATE tn_engine_gltf)
    target_compile_definitions(tn-native-engine-player-v8 PRIVATE TN_PLAYER_NATIVE_GLTF=1)
endif()
# Reuse the host's V8 service bindings (modules, timers, fetch of local files) in the player's own
# isolate. These VM sources stay above the JS-free engine; no legacy renderer is linked.
add_library(tn_player_v8_services STATIC src/js/v8_engine.cpp src/js/module_system.cpp
    src/js/module_resolver.cpp src/js/ts_transpiler.cpp src/vfs/embedded_bundle.cpp)
target_include_directories(tn_player_v8_services PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_compile_definitions(tn_player_v8_services PRIVATE MYSTRAL_JS_V8=1)
target_link_libraries(tn_player_v8_services PUBLIC v8::v8 ${V8_SYSTEM_LIBS})
if(TARGET swc::swc)
    target_link_libraries(tn_player_v8_services PRIVATE swc::swc)
endif()
set_target_properties(tn_player_v8_services PROPERTIES CXX_STANDARD 20 CXX_STANDARD_REQUIRED ON)
target_link_libraries(tn-native-engine-player-v8 PRIVATE tn_player_v8_services)
# WebAudio for three's audio classes: the legacy host's SDL output and worker decode.
target_sources(tn_player_v8_services PRIVATE src/audio/audio_context.cpp src/audio/audio_bindings.cpp
    src/audio/async_audio_decode.cpp src/audio/vorbis_impl.c)
target_include_directories(tn_player_v8_services PRIVATE ${THIRD_PARTY_DIR}/stb
    ${CMAKE_CURRENT_BINARY_DIR}/generated)
# The legacy host's Skia 2D canvas, so a game's procedural textures draw (document.createElement("canvas")).
target_sources(tn_player_v8_services PRIVATE src/canvas/canvas2d.cpp src/canvas/canvas2d_bindings.cpp)
if(TARGET skia::skia)
    target_link_libraries(tn_player_v8_services PRIVATE skia::skia)
    if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
        find_package(Fontconfig REQUIRED)
        find_package(Freetype REQUIRED)
        target_link_libraries(tn_player_v8_services PRIVATE Fontconfig::Fontconfig Freetype::Freetype)
    endif()
    target_compile_definitions(tn-native-engine-player-v8 PRIVATE TN_PLAYER_CANVAS2D=1)
endif()
add_dependencies(tn_player_v8_services threenative-runtime-scripts)
target_link_libraries(tn_player_v8_services PUBLIC tn_engine_player)
if(TN_ENABLE_NATIVE_PHYSICS AND TARGET threenative-native-physics)
    target_sources(tn_player_v8_services PRIVATE src/physics/native_bindings.cpp)
    target_link_libraries(tn_player_v8_services PUBLIC threenative-native-physics)
    target_compile_definitions(tn-native-engine-player-v8 PRIVATE TN_PLAYER_NATIVE_PHYSICS=1)
endif()
tn_adapter_v8_executable(tn-native-engine-player-v8)
if(TN_NODE_EXECUTABLE)
    set(TN_PLAYER_IMPORTS_MODE)
    if(NOT TN_ENABLE_NATIVE_PHYSICS OR NOT TARGET tn_engine_gltf)
        set(TN_PLAYER_IMPORTS_MODE --imports-only)
    endif()
    add_test(NAME native_engine_player_imports
        COMMAND ${TN_NODE_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/player-imports.mjs
            $<TARGET_FILE:tn-native-engine-player-v8> ${TN_PLAYER_IMPORTS_MODE})
    set_tests_properties(native_engine_player_imports PROPERTIES LABELS "native-engine")
    add_test(NAME native_engine_player_gc
        COMMAND ${TN_NODE_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/player-gc.mjs
            $<TARGET_FILE:tn-native-engine-player-v8>)
    set_tests_properties(native_engine_player_gc PROPERTIES LABELS "native-engine")
endif()

# Both CP1 arms on a small L4: 64 cubes + the ground + the output pass, 66 draws in each.
set(TN_L4_SOURCE ${CMAKE_CURRENT_SOURCE_DIR}/../../examples/engine-load-test/native-engine/l4-workload.ts)
set(TN_L4_SCRIPT ${CMAKE_CURRENT_BINARY_DIR}/l4-workload.js)
if(TN_ESBUILD)
    # The 64-object workload batches into one instanced draw (plus output). Frustum culling is the
    # renderer's default, so the orbiting camera keeps 42 of the 64 cubes at the last frame:
    # 507 triangles = 42 x 12 + 3. Both arms must agree on it, which is what proves they draw the same scene.
    add_test(NAME native_engine_host_v8
        COMMAND sh -c "${TN_ESBUILD} ${TN_L4_SOURCE} --bundle --format=iife --platform=neutral --log-level=error --outfile=${TN_L4_SCRIPT} && $<TARGET_FILE:tn-native-engine-host> ${TN_L4_SCRIPT} --objects 64 --frames 10 --warmup 2 2>/dev/null")
    add_test(NAME native_engine_host_cpp
        COMMAND sh -c "$<TARGET_FILE:tn-native-engine-host> --cpp --objects 64 --frames 10 --warmup 2 2>/dev/null")
    # PRD-533: the crowd workload, 64 rigs x 552 triangles + the ground's 2 + the output pass's 1,
    # and the report states the rigs it counted from the scene (35,328 triangles over 64 objects).
    add_test(NAME native_engine_host_crowd
        COMMAND sh -c "$<TARGET_FILE:tn-native-engine-host> --crowd --frames 5 --warmup 2 2>/dev/null")
    set_tests_properties(native_engine_host_crowd PROPERTIES LABELS "native-engine"
        PASS_REGULAR_EXPRESSION "\"workload\": \"skinned-crowd\",[\r\n ]+\"objects\": 64,[\r\n ]+\"presentedObjects\": 64,[\r\n ]+\"sceneTriangles\": 35328,.*\"draws\": 3,[\r\n ]+\"triangles\": 35331,")
    set_tests_properties(native_engine_host_v8 native_engine_host_cpp PROPERTIES
        LABELS "native-engine" PASS_REGULAR_EXPRESSION "\"draws\": 3,[\r\n ]+\"triangles\": 507,")
    # PRD-530: startup checks the artifact identity manifest; a matching one runs, one built
    # against another engine ABI is refused before any engine or game code.
    set(TN_IDENTITY ${CMAKE_CURRENT_BINARY_DIR}/identity.txt)
    add_test(NAME native_engine_host_identity_accept
        COMMAND sh -c "$<TARGET_FILE:tn-native-engine-identity> --write ${TN_IDENTITY} --backend dawn && $<TARGET_FILE:tn-native-engine-host> --cpp --objects 8 --frames 2 --warmup 1 --identity ${TN_IDENTITY} 2>&1")
    add_test(NAME native_engine_host_identity_refuse
        COMMAND sh -c "$<TARGET_FILE:tn-native-engine-identity> --write ${TN_IDENTITY}.bad --backend dawn && sed -i 's/^engine-abi .*/engine-abi 999/' ${TN_IDENTITY}.bad && $<TARGET_FILE:tn-native-engine-host> --cpp --objects 8 --frames 2 --warmup 1 --identity ${TN_IDENTITY}.bad 2>&1; echo exit=$?")
    set_tests_properties(native_engine_host_identity_accept PROPERTIES LABELS "native-engine" PASS_REGULAR_EXPRESSION "\"draws\": 3,[\r\n ]+\"triangles\": 87,")
    set_tests_properties(native_engine_host_identity_refuse PROPERTIES LABELS "native-engine"
        PASS_REGULAR_EXPRESSION "TN_ARTIFACT_VERSION_MISMATCH: TN_DIAG_ENGINE_ABI_MISMATCH[^\n]*\nexit=3")
    # An unreadable `--v8-snapshot` is refused before V8 starts. The accepted path needs the
    # platform's own blob, which only the Android lane (slice 9) provides.
    add_test(NAME native_engine_host_snapshot_refuse
        COMMAND sh -c "$<TARGET_FILE:tn-native-engine-host> ${TN_L4_SCRIPT} --v8-snapshot ${CMAKE_CURRENT_BINARY_DIR}/no-such-snapshot.bin --frames 1 2>&1; echo exit=$?")
    # A mistyped flag and a missing workload are refused by name before any device or V8 starts.
    add_test(NAME native_engine_host_args_refuse
        COMMAND sh -c "$<TARGET_FILE:tn-native-engine-host> --no-such-flag 2>&1; echo exit=$?; $<TARGET_FILE:tn-native-engine-host> 2>&1; echo exit=$?")
    set_tests_properties(native_engine_host_args_refuse PROPERTIES LABELS "native-engine"
        PASS_REGULAR_EXPRESSION "TN_HOST_ARGS: unknown argument --no-such-flag\nexit=2\nTN_HOST_ARGS: a workload script, --cpp or --crowd\nexit=2")
    set_tests_properties(native_engine_host_snapshot_refuse PROPERTIES LABELS "native-engine"
        PASS_REGULAR_EXPRESSION "TN_HOST_SCRIPT: cannot read the V8 snapshot [^\n]*no-such-snapshot.bin\n.*exit=1")
endif()

# The differential fixtures through V8 (PRD-531 phase 2): the same corpus and goldens as the C++
# driver, every op run as JS against the adapter's classes.
add_executable(tn-native-engine-v8-fixture-driver EXCLUDE_FROM_ALL tests/native-engine/v8_fixture_driver.cpp)
target_link_libraries(tn-native-engine-v8-fixture-driver PRIVATE tn_adapter_v8)
tn_adapter_v8_executable(tn-native-engine-v8-fixture-driver)
if(TN_PNPM_EXECUTABLE)
    add_test(NAME native_engine_v8_scene_fixtures
        COMMAND ${TN_PNPM_EXECUTABLE} --filter @threenative/three-native exec tsx tests/compatibility/run-native.ts
            --driver $<TARGET_FILE:tn-native-engine-v8-fixture-driver> --only "scene-*"
            --out ${CMAKE_CURRENT_BINARY_DIR}/v8_scene.json)
    # Math through JS: two rows stay blocked by the C ABI's Frustum.planes, an array of member
    # objects the binding Value cannot carry yet. Every other math row passes through V8; a new
    # blocked row changes the line and any FAIL row fails the test.
    add_test(NAME native_engine_v8_math_fixtures
        COMMAND ${TN_PNPM_EXECUTABLE} --filter @threenative/three-native exec tsx tests/compatibility/run-native.ts
            --driver $<TARGET_FILE:tn-native-engine-v8-fixture-driver> --only "math-*" --allow-blocked
            --out ${CMAKE_CURRENT_BINARY_DIR}/v8_math.json)
    set_tests_properties(native_engine_v8_math_fixtures PROPERTIES
        PASS_REGULAR_EXPRESSION "ALLOWED_BLOCKED math-core-constructors, math-primitives-frustum\n"
        FAIL_REGULAR_EXPRESSION "(^|\n)FAIL ")
    set_tests_properties(native_engine_v8_scene_fixtures native_engine_v8_math_fixtures PROPERTIES LABELS "native-engine")
    # The native Shape, ShapeGeometry and ExtrudeGeometry through JS, options objects included.
    add_test(NAME native_engine_v8_shape_fixtures
        COMMAND ${TN_PNPM_EXECUTABLE} --filter @threenative/three-native exec tsx tests/compatibility/run-native.ts
            --driver $<TARGET_FILE:tn-native-engine-v8-fixture-driver> --only "shapes-*"
            --out ${CMAKE_CURRENT_BINARY_DIR}/v8_shapes.json)
    set_tests_properties(native_engine_v8_shape_fixtures PROPERTIES LABELS "native-engine")
endif()

# Midway's texture slice through V8: HalfFloatType DataTextures and `image.data` re-sends.
add_executable(tn-native-engine-v8-textures-test EXCLUDE_FROM_ALL tests/native-engine/v8_textures_test.cpp)
target_link_libraries(tn-native-engine-v8-textures-test PRIVATE tn_adapter_v8)
target_include_directories(tn-native-engine-v8-textures-test PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine)
tn_adapter_v8_executable(tn-native-engine-v8-textures-test)
add_test(NAME native_engine_v8_textures_half_float COMMAND tn-native-engine-v8-textures-test half_float)
set_tests_properties(native_engine_v8_textures_half_float PROPERTIES LABELS "native-engine")
if(TN_NODE_EXECUTABLE)
    # The same slice through the bundler, the V8 facade and the player (CPU only).
    add_test(NAME native_engine_player_textures
        COMMAND ${TN_NODE_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/player-textures.mjs
            $<TARGET_FILE:tn-native-engine-player-v8>)
    set_tests_properties(native_engine_player_textures PROPERTIES LABELS "native-engine")
    # Without a playtest runner the player's clock follows real time (headless GPU, no window).
    add_test(NAME native_engine_player_free_run
        COMMAND ${TN_NODE_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/player-free-run.mjs
            $<TARGET_FILE:tn-native-engine-player-v8>)
    set_tests_properties(native_engine_player_free_run PROPERTIES LABELS "native-engine")
    # PRD-610: a slow free-running frame runs its frame callbacks once per drawn frame, not once per catch-up tick.
    add_test(NAME native_engine_player_frame_per_present
        COMMAND ${TN_NODE_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/player-frame-per-present.mjs
            $<TARGET_FILE:tn-native-engine-player-v8>)
    set_tests_properties(native_engine_player_frame_per_present PROPERTIES LABELS "native-engine")
    # PRD-610: the game thread owns one physical core; every other player thread runs off it (Linux desktop).
    if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
        add_test(NAME native_engine_player_thread_placement
            COMMAND ${TN_NODE_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/player-thread-placement.mjs
                $<TARGET_FILE:tn-native-engine-player-v8>)
        set_tests_properties(native_engine_player_thread_placement PROPERTIES LABELS "native-engine")
    endif()
    # PRD-554: a game's web HUD is drawn over the player's frame and takes a press (needs the opt-in overlay
    # build, -DTN_ENGINE_PLAYER_UI_OVERLAY=ON, and the built playtest runner; it starts its own Xvfb).
    if(TN_ENGINE_PLAYER_UI_OVERLAY)
        add_test(NAME native_engine_player_ui_overlay
            COMMAND ${TN_NODE_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/player-ui-overlay.mjs
                $<TARGET_FILE:tn-native-engine-player-v8>)
        set_tests_properties(native_engine_player_ui_overlay PROPERTIES LABELS "native-engine" TIMEOUT 300)
    endif()
    # A person's keys, mouse and wheel reach the game: real X11 events (xdotool, XTEST) on the player's window under
    # its own Xvfb, not the playtest mailbox. The second run has the web HUD overlay attached.
    find_program(TN_XDOTOOL xdotool)
    if(TN_XDOTOOL AND CMAKE_SYSTEM_NAME STREQUAL "Linux")
        add_test(NAME native_engine_player_real_input
            COMMAND ${TN_NODE_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/player-real-input.mjs
                $<TARGET_FILE:tn-native-engine-player-v8>)
        set_tests_properties(native_engine_player_real_input PROPERTIES LABELS "native-engine" TIMEOUT 300)
        if(TN_ENGINE_PLAYER_UI_OVERLAY)
            add_test(NAME native_engine_player_real_input_ui
                COMMAND ${TN_NODE_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/player-real-input.mjs
                    $<TARGET_FILE:tn-native-engine-player-v8> --ui)
            set_tests_properties(native_engine_player_real_input_ui PROPERTIES LABELS "native-engine" TIMEOUT 300)
        endif()
    endif()
    add_test(NAME native_engine_player_async_bridge
        COMMAND ${TN_NODE_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/player-async-bridge.mjs
            $<TARGET_FILE:tn-native-engine-player-v8>)
    set_tests_properties(native_engine_player_async_bridge PROPERTIES LABELS "native-engine")
    # A compileAsync continuation that compiles again settles every promise (Midway's boot crashed the player here).
    add_test(NAME native_engine_player_compile_reentry
        COMMAND ${TN_NODE_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/player-compile-reentry.mjs
            $<TARGET_FILE:tn-native-engine-player-v8>)
    set_tests_properties(native_engine_player_compile_reentry PROPERTIES LABELS "native-engine")
    # A game's 2D canvas draws into a CanvasTexture (Midway's gun steel was flat near-white without it).
    add_test(NAME native_engine_player_canvas2d
        COMMAND ${TN_NODE_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/player-canvas2d.mjs
            $<TARGET_FILE:tn-native-engine-player-v8>)
    set_tests_properties(native_engine_player_canvas2d PROPERTIES LABELS "native-engine")
    # A decal canvas copied into a texture canvas with drawImage keeps its text (Midway's NO STEP placards).
    add_test(NAME native_engine_player_canvas_decal
        COMMAND ${TN_NODE_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/player-canvas-decal.mjs
            $<TARGET_FILE:tn-native-engine-player-v8>)
    set_tests_properties(native_engine_player_canvas_decal PROPERTIES LABELS "native-engine")
    add_test(NAME native_engine_player_window_title
        COMMAND ${TN_NODE_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/player-window-title.mjs
            $<TARGET_FILE:tn-native-engine-player-v8>)
    set_tests_properties(native_engine_player_window_title PROPERTIES LABELS "native-engine")
    # PRD-551: QuadMesh into RenderTargets and readRenderTargetPixelsAsync on the real player (headless GPU).
    add_test(NAME native_engine_player_render_target
        COMMAND ${TN_NODE_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/player-render-target.mjs
            $<TARGET_FILE:tn-native-engine-player-v8>)
    set_tests_properties(native_engine_player_render_target PROPERTIES LABELS "native-engine")
    # A render-target read settles from the GPU event drain; its continuation must run with the isolate entered.
    add_test(NAME native_engine_player_read_target_osr
        COMMAND ${TN_NODE_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/player-read-target-osr.mjs
            $<TARGET_FILE:tn-native-engine-player-v8>)
    set_tests_properties(native_engine_player_read_target_osr PROPERTIES LABELS "native-engine")
    # PRD-547: uniform and constant values through the player's TSL (shared with Wasm).
    add_test(NAME native_engine_player_tsl_values
        COMMAND ${TN_NODE_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/player-tsl-values.mjs
            $<TARGET_FILE:tn-native-engine-player-v8>)
    set_tests_properties(native_engine_player_tsl_values PROPERTIES LABELS "native-engine")
    # PRD-620: TSL compute on the player (storage, dispatch order, exact readback and atomics, render read).
    add_test(NAME native_engine_player_compute
        COMMAND ${TN_NODE_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/player-compute.mjs
            $<TARGET_FILE:tn-native-engine-player-v8>)
    set_tests_properties(native_engine_player_compute PROPERTIES LABELS "native-engine" TIMEOUT 120)
    # PRD-620 phase 3: the operators SoftBody3D needs (ElseIf, object-form Loop, comparisons, bool logic, conversions).
    add_test(NAME native_engine_player_compute_ops
        COMMAND ${TN_NODE_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/player-compute-ops.mjs
            $<TARGET_FILE:tn-native-engine-player-v8>)
    set_tests_properties(native_engine_player_compute_ops PROPERTIES LABELS "native-engine" TIMEOUT 120)
    # PRD-548: BufferGeometryUtils over engine geometry on the player, three r185 in Node as the oracle.
    add_test(NAME native_engine_player_geometry_utils
        COMMAND ${TN_NODE_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/player-geometry-utils.mjs
            $<TARGET_FILE:tn-native-engine-player-v8>)
    set_tests_properties(native_engine_player_geometry_utils PROPERTIES LABELS "native-engine")
    # PRD-552: an engine BatchedMesh on the player, read back from a render target.
    add_test(NAME native_engine_player_batched_mesh
        COMMAND ${TN_NODE_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/player-batched-mesh.mjs
            $<TARGET_FILE:tn-native-engine-player-v8>)
    set_tests_properties(native_engine_player_batched_mesh PROPERTIES LABELS "native-engine")
    # PRD-573 v1.11: a settled R2 frame of 1,024 cubes costs at most 3.5 crossings per cube. Red until step 3 (host
    # projection) landed, green since: 10.26 per cube at step 0, 0.01 with the mirror gone.
    add_test(NAME native_engine_player_crossing_budget
        COMMAND ${TN_NODE_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/player-crossing-budget.mjs
            $<TARGET_FILE:tn-native-engine-player-v8>)
    set_tests_properties(native_engine_player_crossing_budget PROPERTIES LABELS "native-engine" TIMEOUT 300)
    # PRD-573 v1.11 step 3: core's projection with the host seam against core's JS mirror (`renderer.projection: "js"`),
    # both drawn by the player into a render target and compared pixel by pixel, and their draw lists on the player's frame.
    add_test(NAME native_engine_player_host_projection
        COMMAND ${TN_NODE_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tests/native-engine/player-host-projection.mjs
            $<TARGET_FILE:tn-native-engine-player-v8>)
    set_tests_properties(native_engine_player_host_projection PROPERTIES LABELS "native-engine" TIMEOUT 300)
endif()

# One target builds every V8 artifact: `cmake --build <dir> --target tn-native-engine-v8`.
get_property(tn_native_engine_v8_targets GLOBAL PROPERTY TN_NATIVE_ENGINE_V8_TARGETS)
add_custom_target(tn-native-engine-v8 DEPENDS ${tn_native_engine_v8_targets})
add_dependencies(tn-native-engine-tests tn-native-engine-v8)
