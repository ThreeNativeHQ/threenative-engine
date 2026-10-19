cmake_minimum_required(VERSION 3.20)

# The version is read from package.json, never typed here.
#
# It was typed here, and it drifted: release v0.1.14 shipped a binary whose launch log read
# `Version: 0.1.13`, because package.json was bumped and this line was not. Nothing failed —
# the consumer proof reported a version skew it could not explain, and ten releases were built
# and deleted before anyone traced it to two numbers that had to be edited together.
#
# MYSTRAL_VERSION compiles into getVersion(), so this single source is what the binary reports.
file(READ "${CMAKE_CURRENT_SOURCE_DIR}/package.json" MYSTRAL_PACKAGE_JSON)
string(JSON MYSTRAL_PACKAGE_VERSION GET "${MYSTRAL_PACKAGE_JSON}" version)
if(NOT MYSTRAL_PACKAGE_VERSION MATCHES "^[0-9]+\\.[0-9]+\\.[0-9]+")
    message(FATAL_ERROR
        "TN_NATIVE_VERSION_UNREADABLE: package.json version '${MYSTRAL_PACKAGE_VERSION}' is not "
        "a three-part version. Refusing to build a runtime that would misreport its version.")
endif()

project(MystralNativeRuntime VERSION ${MYSTRAL_PACKAGE_VERSION} LANGUAGES C CXX)

# The browser port builds only the portable engine core (PRD-499, owner decision 4): no host
# services, no GPU backend, no JS engine. Its CPU tests run under node through ctest.
# The portable engine core alone: Wasm, and any cross toolchain (an Android NDK build that runs the
# fixture driver on a device) that needs no host services, SDL or JS engine.
option(TN_ENGINE_CORE_ONLY "Configure only the portable native-engine core" OFF)
if(EMSCRIPTEN OR TN_ENGINE_CORE_ONLY)
    enable_testing()
    if(EMSCRIPTEN)
        # This package is "type": "module"; Emscripten emits CommonJS, and the nearest package.json wins.
        file(WRITE "${CMAKE_BINARY_DIR}/package.json" "{\"type\": \"commonjs\"}\n")
    endif()
    include(cmake/NativeEngineCore.cmake)
    return()
endif()
enable_testing()

function(tn_register_contract_test target)
    if(target STREQUAL "threenative-webgpu-bindings-reentrancy-test")
        set(TN_BEHAVIOR_CONTRACT "webgpu")
        set(TN_BEHAVIOR_PROOFS "public-binding-surface,call-trace,async-observation,whole-table-verification,wrapper-rollback")
    elseif(target STREQUAL "threenative-bindings-creation-test")
        set(TN_BEHAVIOR_CONTRACT "creation")
        set(TN_BEHAVIOR_PROOFS "creation-refusal")
    elseif(target STREQUAL "threenative-command-encoder-class-table-test")
        set(TN_BEHAVIOR_CONTRACT "command-encoder")
        set(TN_BEHAVIOR_PROOFS "command-encoder-class-table")
    elseif(target STREQUAL "threenative-render-pass-class-table-test")
        set(TN_BEHAVIOR_CONTRACT "render-pass")
        set(TN_BEHAVIOR_PROOFS "render-pass-class-table")
    endif()
    if(DEFINED TN_BEHAVIOR_CONTRACT)
        find_program(TN_PNPM_EXECUTABLE pnpm REQUIRED)
        add_test(NAME ${target}
            COMMAND ${CMAKE_COMMAND} -E env
                "TN_NATIVE_BEHAVIOR_EXECUTABLE=$<TARGET_FILE:${target}>"
                "TN_NATIVE_BEHAVIOR_CONTRACT=${TN_BEHAVIOR_CONTRACT}"
                "TN_NATIVE_BEHAVIOR_PROOFS=${TN_BEHAVIOR_PROOFS}"
                ${TN_PNPM_EXECUTABLE} exec vitest run --config vitest.config.ts
                    tests/webgpu-bindings-contract.test.mjs)
        set_tests_properties(${target} PROPERTIES
            LABELS "native-contract;native-behavior"
            WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}")
    else()
        add_test(NAME ${target} COMMAND $<TARGET_FILE:${target}> ${ARGN})
        set_tests_properties(${target} PROPERTIES LABELS "native-contract")
    endif()
    set_property(GLOBAL APPEND PROPERTY TN_NATIVE_CONTRACT_TARGETS ${target})
endfunction()

function(tn_register_blocked_test name reason)
    add_test(NAME ${name} COMMAND ${CMAKE_COMMAND} -E echo "BLOCKED: ${reason}")
    set_tests_properties(${name} PROPERTIES DISABLED TRUE LABELS "native-contract;blocked")
endfunction()

function(tn_mark_sanitizer_contract_test target)
    set_property(TEST ${target} APPEND PROPERTY LABELS "native-sanitizer")
    set_property(GLOBAL APPEND PROPERTY TN_NATIVE_SANITIZER_TARGETS ${target})
endfunction()

if(APPLE)
    enable_language(OBJCXX)
endif()

# Windows: Use /MT (static CRT) for all builds
# Both Skia and Dawn (from library-builder) are built with /MT static CRT.
# The CI workflow passes -DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded for all Windows builds.

# ============================================================================
# Options
# ============================================================================

# JS Engine (choose one)
option(MYSTRAL_USE_V8 "Use V8 JavaScript engine" OFF)
option(MYSTRAL_USE_JSC "Use JavaScriptCore engine" OFF)
option(MYSTRAL_USE_QUICKJS "Use QuickJS engine" ON)  # Default - simplest to start
option(MYSTRAL_USE_SWC "Enable SWC TypeScript transpiler" ON)

# V8 requires C++20, so use that if V8 is enabled, otherwise C++17
# Must be after option() definitions so MYSTRAL_USE_V8 is properly set
if(MYSTRAL_USE_V8)
    set(CMAKE_CXX_STANDARD 20)
    message(STATUS "V8 enabled - using C++20")
    # MSVC needs explicit flag for C++20 in CMAKE_CXX_FLAGS
    # (add_compile_options can be overridden by vcpkg toolchain)
    if(MSVC)
        set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} /std:c++20")
    endif()
else()
    set(CMAKE_CXX_STANDARD 17)
    message(STATUS "V8 disabled - using C++17")
endif()
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# WebGPU Implementation (choose one)
option(MYSTRAL_USE_DAWN "Use Dawn WebGPU implementation" ON)  # Default - best compatibility
option(MYSTRAL_USE_WGPU "Use wgpu-native WebGPU implementation" OFF)  # Alternative - has iOS support
set(THREENATIVE_WGPU_ROOT "" CACHE PATH "Override the platform wgpu-native dependency root")
set(MYSTRAL_WEBGPU_BACKEND "auto" CACHE STRING "WebGPU backend selection; Android accepts dawn or wgpu")
set_property(CACHE MYSTRAL_WEBGPU_BACKEND PROPERTY STRINGS auto dawn wgpu)
if(NOT MYSTRAL_WEBGPU_BACKEND STREQUAL "auto" AND
   NOT MYSTRAL_WEBGPU_BACKEND STREQUAL "dawn" AND
   NOT MYSTRAL_WEBGPU_BACKEND STREQUAL "wgpu")
    message(FATAL_ERROR
        "TN_WEBGPU_BACKEND_INVALID: MYSTRAL_WEBGPU_BACKEND must be auto, dawn, or wgpu")
endif()
if(MYSTRAL_WEBGPU_BACKEND STREQUAL "dawn" AND NOT ANDROID)
    message(FATAL_ERROR
        "TN_DAWN_ANDROID_ONLY: MYSTRAL_WEBGPU_BACKEND=dawn is an Android arm64 spike")
endif()
if(MYSTRAL_WEBGPU_BACKEND STREQUAL "dawn")
    set(MYSTRAL_USE_DAWN ON)
    set(MYSTRAL_USE_WGPU OFF)
elseif(MYSTRAL_WEBGPU_BACKEND STREQUAL "wgpu")
    set(MYSTRAL_USE_DAWN OFF)
    set(MYSTRAL_USE_WGPU ON)
endif()

# Ray Tracing (optional - hardware RT via DXR/Vulkan/Metal)
option(MYSTRAL_USE_RAYTRACING "Enable hardware ray tracing support" OFF)

# ============================================================================
# ThreeNative public feature flags
# ============================================================================
# These fork-facing switches are intentionally layered over the existing
# Mystral internals for the first native-runtime milestones. They make the
# public build contract stable without destructively renaming the upstream
# implementation before platform/conformance gates are in place.
option(TN_ENABLE_CANVAS2D "Enable Canvas2D/Skia compatibility surface" ON)
option(TN_ENABLE_VIDEO "Enable video capture/encoding surfaces" OFF)
option(TN_ENABLE_RAYTRACING "Enable optional ray tracing backends" OFF)
option(TN_ENABLE_WEBTRANSPORT "Enable WebTransport/QUIC support when dependencies exist" ON)
option(TN_REQUIRE_WEBTRANSPORT "Require WebTransport dependencies during configure" OFF)
option(TN_ENABLE_NATIVE_GLTF "Enable deprecated native C++ GLTF path (must remain OFF; use Three.js GLTFLoader)" OFF)
option(TN_ENABLE_DRACO "Enable native Draco decoder when dependencies exist" OFF)
option(TN_ENABLE_DEBUG_SERVER "Enable debug-server control surface" OFF)
option(TN_ENABLE_NATIVE_PHYSICS "Enable the ThreeNative native Rapier ABI" OFF)
option(TN_ENABLE_METAHUMAN "Enable the OpenRigLogic MetaHuman facial rig ABI" OFF)
# The desktop UI layer: a transparent web view over the game surface, behind a C ABI.
# Off by default and desktop-only — Android has its own host in Java, iOS has one in Swift, and a
# game whose ui.renderer is "native" must link none of it.
option(TN_ENABLE_UI_OVERLAY "Enable the ThreeNative desktop UI overlay" OFF)
# The other UI backend: the same `src/ui/` laid out and rasterised on the CPU by
# `native/css-ui`, with no web view, no GTK and no webkit2gtk anywhere on the path. Off by default
# and separate from `TN_ENABLE_UI_OVERLAY` because the two are independent: a host may want both
# (a game picks one at runtime) or neither (a game whose UI renderer is `native` links none of it),
# and the option that turns on a browser must not be the option that turns on the no-browser lane.
option(TN_ENABLE_CSS_UI "Enable the ThreeNative desktop CSS UI backend (CPU rasteriser, no WebView)" OFF)
option(TN_ANDROID_VSYNC "Use FIFO presentation in the Android runtime" ON)
option(TN_WEBGPU_UPLOAD_STAGING "Stage queue.writeBuffer calls into mapped blocks flushed at queue boundaries (wgpu-native builds)" ON)
set(TN_WEBGPU_DESIRED_FRAME_LATENCY "0" CACHE STRING "Chain desiredMaximumFrameLatency into the surface configuration (wgpu-native builds); 0 keeps the backend default of 2")
option(TN_WEBGPU_GPU_DRAIN_PROFILE "Block after present to measure remaining GPU work (diagnostic builds only)" OFF)
option(TN_ANDROID_JS_PROFILE "Profile Android JavaScript render bindings" OFF)
option(TN_ANDROID_JS_PROFILE_BUSY_LOOP "Add a negative-control busy loop to profiled bindings" OFF)
# The V8 CPU profiler behind `--cpu-prof` and TN_JS_CPU_PROFILE. On by default for a desktop build
# so a user can name a hot function without installing a system profiler (PRD-444); off for a
# shipping mobile build, where the Android profiling build keeps its own opt-in above.
if(ANDROID OR CMAKE_SYSTEM_NAME STREQUAL "iOS")
    set(TN_JS_PROFILE_DEFAULT OFF)
else()
    set(TN_JS_PROFILE_DEFAULT ON)
endif()
option(TN_JS_PROFILE "Compile the V8 CPU profiler into this build" ${TN_JS_PROFILE_DEFAULT})
option(TN_ENABLE_COVERAGE "Instrument native targets for source-based coverage" OFF)
option(TN_ENABLE_SANITIZERS "Instrument native targets with AddressSanitizer and UBSan" OFF)
option(TN_ENABLE_CLANG_TIDY "Run clang-tidy over ThreeNative native sources" OFF)
# PRD-226 ablation arms. Measurement builds only — a build with either flag ON renders the wrong
# picture by construction and must never ship. Asserted absent from every shipped preset.
option(TN_ABLATE_BACKEND "PRD-226 arm A2: no-op the hot backend command entry points, keeping JS, trampoline and argument parsing intact" OFF)
# PRD-393 arm: the UI composite's upload and quad disappear, and nothing else does. The frame is
# still structurally valid and still presents; it simply carries no UI. This is the "quad disabled"
# arm AC-6's interleaved pairs are measured against — without it the phase's p95 could be
# attributing something other than the compositing, and there would be no way to tell.
option(TN_ABLATE_UI_COMPOSITE "PRD-393 arm: skip the native UI upload and quad, keeping the phase measurement" OFF)
set(THREENATIVE_PHYSICS_LIBRARY "" CACHE FILEPATH "Prebuilt ThreeNative native physics static library")

if(TN_ENABLE_NATIVE_GLTF)
    message(FATAL_ERROR
        "TN_ENABLE_NATIVE_GLTF was removed; load assets with Three.js GLTFLoader instead")
endif()
if(TN_ENABLE_DRACO)
    message(FATAL_ERROR
        "TN_ENABLE_DRACO was removed; use the Three.js DracoLoader/Worker path instead")
endif()

if(TN_ANDROID_JS_PROFILE_BUSY_LOOP AND NOT TN_ANDROID_JS_PROFILE)
    message(FATAL_ERROR "Android JS profiling controls require TN_ANDROID_JS_PROFILE=ON")
endif()

if(TN_ENABLE_COVERAGE)
    if(NOT CMAKE_CXX_COMPILER_ID MATCHES "Clang")
        message(FATAL_ERROR
            "TN_ENABLE_COVERAGE requires clang source-based coverage; configure with clang/clang++")
    endif()
    add_compile_options(-fprofile-instr-generate -fcoverage-mapping)
    add_link_options(-fprofile-instr-generate)
endif()

if(TN_ENABLE_SANITIZERS)
    if(MSVC OR NOT CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
        message(FATAL_ERROR
            "TN_ENABLE_SANITIZERS requires a Clang or GCC desktop toolchain")
    endif()
endif()

if(TN_ENABLE_CLANG_TIDY)
    find_program(TN_CLANG_TIDY_EXECUTABLE NAMES clang-tidy REQUIRED)
    set(CMAKE_CXX_CLANG_TIDY
        "${TN_CLANG_TIDY_EXECUTABLE};--config-file=${CMAKE_CURRENT_SOURCE_DIR}/.clang-tidy")
endif()

# Native GLTF is deliberately not mapped to any implementation. AGENTS.md marks
# the C++ GLTF loader deprecated; ThreeNative GLTF conformance uses JavaScript
# Three.js GLTFLoader paths only.
set(MYSTRAL_USE_RAYTRACING ${TN_ENABLE_RAYTRACING} CACHE BOOL "Enable hardware ray tracing support" FORCE)
add_compile_definitions(
    TN_ENABLE_CANVAS2D=$<BOOL:${TN_ENABLE_CANVAS2D}>
    TN_ENABLE_VIDEO=$<BOOL:${TN_ENABLE_VIDEO}>
    TN_ENABLE_WEBTRANSPORT=$<BOOL:${TN_ENABLE_WEBTRANSPORT}>
    TN_ENABLE_NATIVE_GLTF=$<BOOL:${TN_ENABLE_NATIVE_GLTF}>
    TN_ENABLE_DEBUG_SERVER=$<BOOL:${TN_ENABLE_DEBUG_SERVER}>
    TN_ENABLE_NATIVE_PHYSICS=$<BOOL:${TN_ENABLE_NATIVE_PHYSICS}>
    TN_ENABLE_METAHUMAN=$<BOOL:${TN_ENABLE_METAHUMAN}>
    TN_ENABLE_UI_OVERLAY=$<BOOL:${TN_ENABLE_UI_OVERLAY}>
    TN_ENABLE_CSS_UI=$<BOOL:${TN_ENABLE_CSS_UI}>
    TN_ANDROID_VSYNC=$<BOOL:${TN_ANDROID_VSYNC}>
    TN_WEBGPU_UPLOAD_STAGING=$<BOOL:${TN_WEBGPU_UPLOAD_STAGING}>
    TN_WEBGPU_DESIRED_FRAME_LATENCY=${TN_WEBGPU_DESIRED_FRAME_LATENCY}
    TN_WEBGPU_GPU_DRAIN_PROFILE=$<BOOL:${TN_WEBGPU_GPU_DRAIN_PROFILE}>
    TN_ANDROID_JS_PROFILE=$<BOOL:${TN_ANDROID_JS_PROFILE}>
    TN_ANDROID_JS_PROFILE_BUSY_LOOP=$<BOOL:${TN_ANDROID_JS_PROFILE_BUSY_LOOP}>
    TN_JS_PROFILE=$<BOOL:${TN_JS_PROFILE}>
    TN_ABLATE_BACKEND=$<BOOL:${TN_ABLATE_BACKEND}>
    TN_ABLATE_UI_COMPOSITE=$<BOOL:${TN_ABLATE_UI_COMPOSITE}>
)

if(TN_ABLATE_BACKEND)
    message(WARNING
        "TN_ABLATE_BACKEND is ON: this is a PRD-226 measurement build. It renders an incorrect "
        "picture by construction and must not be shipped or used for any visual gate.")
endif()

if(TN_ABLATE_UI_COMPOSITE)
    message(WARNING
        "TN_ABLATE_UI_COMPOSITE is ON: this is a PRD-393 measurement build. It draws no UI at all "
        "and must not be shipped or used for any visual gate.")
endif()

# ============================================================================
# Platform Detection
# ============================================================================

if(APPLE)
    if(CMAKE_SYSTEM_NAME STREQUAL "iOS")
        set(MYSTRAL_PLATFORM "ios")
        set(MYSTRAL_USE_V8 OFF)
        set(MYSTRAL_USE_JSC ON)      # JSC is free on iOS
        set(MYSTRAL_USE_QUICKJS OFF)
        set(MYSTRAL_USE_DAWN OFF)
        set(MYSTRAL_USE_WGPU ON)     # Dawn doesn't support iOS
    else()
        set(MYSTRAL_PLATFORM "macos")
    endif()
elseif(WIN32)
    set(MYSTRAL_PLATFORM "windows")
elseif(ANDROID)
    set(MYSTRAL_PLATFORM "android")
    # Android defaults to V8, decided by the product owner on 2026-08-16 (PRD-130) on PRD-118's
    # measurement: 115.64 ms of script per frame under QuickJS against 5.25 ms under V8, at 16,384
    # moving cubes on a Pixel 8. QuickJS was the default while nothing had measured its cost; it now
    # has one, and it was the only JIT-less engine ThreeNative shipped on a platform anyone plays on.
    #
    # `-DMYSTRAL_USE_QUICKJS=ON` is the documented rollback and stays supported. The choice is still
    # a default and not a law: forcing an engine here is what once made an explicit
    # -DMYSTRAL_USE_V8=ON be accepted on the command line, silently ignored, and reported back as
    # QuickJS, so an explicit request always wins.
    #
    # Three places state this default — here, `android/app/build.gradle.kts`, and the `tn-android`
    # CMake preset. They must agree; a preset contradicting this block is how the flag came to work
    # on one machine only.
    if(NOT MYSTRAL_USE_QUICKJS AND NOT MYSTRAL_USE_JSC)
        set(MYSTRAL_USE_V8 ON)
    else()
        set(MYSTRAL_USE_V8 OFF)
    endif()
    # wgpu-native remains the Android product default. Dawn is a named PRD-329 spike and only
    # takes this branch when the caller explicitly passes MYSTRAL_WEBGPU_BACKEND=dawn.
    if(MYSTRAL_WEBGPU_BACKEND STREQUAL "auto")
        set(MYSTRAL_USE_DAWN OFF)
        set(MYSTRAL_USE_WGPU ON)
    endif()
elseif(UNIX)
    set(MYSTRAL_PLATFORM "linux")
endif()

message(STATUS "Mystral Platform: ${MYSTRAL_PLATFORM}")
message(STATUS "JS Engine: V8=${MYSTRAL_USE_V8} JSC=${MYSTRAL_USE_JSC} QuickJS=${MYSTRAL_USE_QUICKJS}")
message(STATUS "WebGPU: Dawn=${MYSTRAL_USE_DAWN} wgpu=${MYSTRAL_USE_WGPU}")

# ============================================================================
# Third Party Dependencies
# ============================================================================

set(THIRD_PARTY_DIR ${CMAKE_CURRENT_SOURCE_DIR}/third_party)
set(THREENATIVE_DAWN_ANDROID_ROOT "${THIRD_PARTY_DIR}/dawn-android" CACHE PATH
    "Extracted Dawn Android arm64 spike root containing include/ and lib/")

if(TN_REQUIRE_WEBTRANSPORT AND NOT TN_ENABLE_WEBTRANSPORT)
    message(FATAL_ERROR
        "TN_WEBTRANSPORT_REQUIRED: WebTransport is disabled for platform '${MYSTRAL_PLATFORM}'. "
        "Expected quiche artifacts under '${THIRD_PARTY_DIR}'; enable "
        "TN_ENABLE_WEBTRANSPORT.")
endif()

# SDL3 - Build from source as static library for single-binary distribution
# iOS builds against upstream 3.4.16 (sdl3-ios), whose SDLUIKitSceneDelegate owns the
# UIWindowScene lifecycle; every other platform stays on 3.2.30 (sdl3) with Android Java/AAR.
if(MYSTRAL_PLATFORM STREQUAL "ios")
    set(SDL3_DIR ${THIRD_PARTY_DIR}/sdl3-ios)
else()
    set(SDL3_DIR ${THIRD_PARTY_DIR}/sdl3)
endif()
set(SDL3_FOUND OFF)

# Find SDL3 source directory (SDL3-{version}/)
file(GLOB SDL3_SOURCE_DIRS ${SDL3_DIR}/SDL3-*)
if(SDL3_SOURCE_DIRS)
    list(GET SDL3_SOURCE_DIRS 0 SDL3_SOURCE_DIR)
    if(EXISTS ${SDL3_SOURCE_DIR}/CMakeLists.txt)
        message(STATUS "Building SDL3 from source: ${SDL3_SOURCE_DIR}")

        # Configure SDL3 build options - static library only
        set(SDL_SHARED OFF CACHE BOOL "" FORCE)
        set(SDL_STATIC ON CACHE BOOL "" FORCE)
        set(SDL_TEST OFF CACHE BOOL "" FORCE)
        set(SDL_TESTS OFF CACHE BOOL "" FORCE)

        # Disable features we don't need to speed up build
        set(SDL_RENDER OFF CACHE BOOL "" FORCE)

        # Add SDL3 as a subdirectory
        add_subdirectory(${SDL3_SOURCE_DIR} ${CMAKE_BINARY_DIR}/sdl3-build EXCLUDE_FROM_ALL)

        # Native executables are PIE on Linux. SDL's static archive otherwise leaves its
        # non-PIC .eh_frame relocations for the linker; Ubuntu's GCC 13/binutils rejects the
        # SDL_appid.c member when mystral-tools pulls it in. SDL_uclibc contributes objects to the
        # same archive, so keep both static producers position independent.
        if(TARGET SDL3-static)
            # The desktop tray symbol rewrite uses objcopy, which requires non-LTO objects.
            set_property(TARGET SDL3-static PROPERTY INTERPROCEDURAL_OPTIMIZATION FALSE)
            set_target_properties(SDL3-static PROPERTIES POSITION_INDEPENDENT_CODE ON)
        endif()
        if(TARGET SDL_uclibc)
            set_target_properties(SDL_uclibc PROPERTIES POSITION_INDEPENDENT_CODE ON)
        endif()

        # SDL3 creates SDL3::SDL3-static target
        if(TARGET SDL3::SDL3-static)
            set(SDL3_FOUND ON)
            set(SDL3_STATIC_TARGET SDL3::SDL3-static)
            message(STATUS "SDL3 static library target: SDL3::SDL3-static")
        elseif(TARGET SDL3-static)
            set(SDL3_FOUND ON)
            set(SDL3_STATIC_TARGET SDL3-static)
            message(STATUS "SDL3 static library target: SDL3-static")
        else()
            message(WARNING "SDL3 static target not found after add_subdirectory")
        endif()
    else()
        message(WARNING "SDL3 CMakeLists.txt not found in ${SDL3_SOURCE_DIR}")
    endif()
else()
    # Fallback: Check for pre-built SDL3 (Android AAR, etc.)
    if(ANDROID)
        set(SDL3_ANDROID_DIR ${THIRD_PARTY_DIR}/sdl3-android)
        if(EXISTS ${SDL3_ANDROID_DIR}/extracted)
            set(SDL3_EXTRACTED_DIR ${SDL3_ANDROID_DIR}/extracted)
            if(ANDROID_ABI STREQUAL "arm64-v8a")
                set(SDL3_ANDROID_ABI "arm64-v8a")
            elseif(ANDROID_ABI STREQUAL "armeabi-v7a")
                set(SDL3_ANDROID_ABI "armeabi-v7a")
            elseif(ANDROID_ABI STREQUAL "x86_64")
                set(SDL3_ANDROID_ABI "x86_64")
            elseif(ANDROID_ABI STREQUAL "x86")
                set(SDL3_ANDROID_ABI "x86")
            else()
                set(SDL3_ANDROID_ABI "arm64-v8a")
            endif()
            set(SDL3_PREFAB_HEADERS ${SDL3_EXTRACTED_DIR}/prefab/modules/SDL3-Headers)
            set(SDL3_PREFAB_LIB ${SDL3_EXTRACTED_DIR}/prefab/modules/SDL3-shared)
            if(EXISTS ${SDL3_PREFAB_LIB}/libs/android.${SDL3_ANDROID_ABI}/libSDL3.so)
                set(SDL3_LIBRARY ${SDL3_PREFAB_LIB}/libs/android.${SDL3_ANDROID_ABI}/libSDL3.so)
                set(SDL3_INCLUDE_DIR ${SDL3_PREFAB_HEADERS}/include)
                set(SDL3_FOUND ON)
                message(STATUS "Found SDL3 for Android: ${SDL3_LIBRARY}")
            endif()
        endif()
    endif()
endif()

if(NOT SDL3_FOUND)
    message(WARNING "SDL3 not found. Run 'node scripts/download-deps.mjs' first.")
endif()

# wgpu-native
if(MYSTRAL_USE_WGPU)
    # Platform-specific wgpu-native directories
    if(THREENATIVE_WGPU_ROOT)
        set(WGPU_DIR ${THREENATIVE_WGPU_ROOT})
        if(MYSTRAL_PLATFORM STREQUAL "android")
            if(ANDROID_ABI STREQUAL "arm64-v8a")
                set(WGPU_TARGET_DIR ${WGPU_DIR}/aarch64)
            elseif(ANDROID_ABI STREQUAL "x86_64")
                set(WGPU_TARGET_DIR ${WGPU_DIR}/x86_64)
            else()
                set(WGPU_TARGET_DIR ${WGPU_DIR}/aarch64)
            endif()
        else()
            set(WGPU_TARGET_DIR ${WGPU_DIR})
        endif()
        message(STATUS "Using overridden wgpu-native root: ${WGPU_DIR}")
    elseif(MYSTRAL_PLATFORM STREQUAL "ios")
        set(WGPU_DIR ${THIRD_PARTY_DIR}/wgpu-ios)
        # Determine target subdirectory based on CMAKE_OSX_SYSROOT
        if(CMAKE_OSX_SYSROOT MATCHES "simulator")
            if(CMAKE_OSX_ARCHITECTURES STREQUAL "x86_64")
                set(WGPU_TARGET_DIR ${WGPU_DIR}/simulatorX64)
            else()
                set(WGPU_TARGET_DIR ${WGPU_DIR}/simulatorArm64)
            endif()
        else()
            set(WGPU_TARGET_DIR ${WGPU_DIR}/device)
        endif()
    elseif(MYSTRAL_PLATFORM STREQUAL "android")
        set(WGPU_DIR ${THIRD_PARTY_DIR}/wgpu-android)
        # Determine target subdirectory based on ANDROID_ABI
        if(ANDROID_ABI STREQUAL "arm64-v8a")
            set(WGPU_TARGET_DIR ${WGPU_DIR}/aarch64)
        elseif(ANDROID_ABI STREQUAL "x86_64")
            set(WGPU_TARGET_DIR ${WGPU_DIR}/x86_64)
        else()
            # Default to aarch64 (most common on modern Android)
            set(WGPU_TARGET_DIR ${WGPU_DIR}/aarch64)
        endif()
    else()
        set(WGPU_DIR ${THIRD_PARTY_DIR}/wgpu)
        set(WGPU_TARGET_DIR ${WGPU_DIR})
    endif()

    if(EXISTS ${WGPU_TARGET_DIR})
        # wgpu-native provides libwgpu_native.a (Unix) or wgpu_native.dll.lib (Windows)
        # Structure: wgpu/lib/libwgpu_native.a, wgpu/include/webgpu/webgpu.h
        # Prefer static library to avoid runtime linking issues
        if(WIN32)
            # Windows uses .dll.lib or .lib extension
            if(EXISTS ${WGPU_TARGET_DIR}/lib/wgpu_native.dll.lib)
                set(WGPU_LIBRARY ${WGPU_TARGET_DIR}/lib/wgpu_native.dll.lib)
            elseif(EXISTS ${WGPU_TARGET_DIR}/lib/wgpu_native.lib)
                set(WGPU_LIBRARY ${WGPU_TARGET_DIR}/lib/wgpu_native.lib)
            endif()
        else()
            # Unix uses .a for static
            if(EXISTS ${WGPU_TARGET_DIR}/lib/libwgpu_native.a)
                set(WGPU_LIBRARY ${WGPU_TARGET_DIR}/lib/libwgpu_native.a)
            else()
                find_library(WGPU_LIBRARY
                    NAMES wgpu_native
                    PATHS ${WGPU_TARGET_DIR}/lib
                    NO_DEFAULT_PATH
                )
            endif()
        endif()
        # Headers are in include/webgpu/ and include/wgpu/
        if(EXISTS ${WGPU_TARGET_DIR}/include)
            set(WGPU_INCLUDE_DIR ${WGPU_TARGET_DIR}/include)
        endif()

        if(WGPU_LIBRARY AND WGPU_INCLUDE_DIR)
            if(WIN32)
                add_library(wgpu::wgpu SHARED IMPORTED)
            else()
                add_library(wgpu::wgpu STATIC IMPORTED)
            endif()
            set_target_properties(wgpu::wgpu PROPERTIES
                IMPORTED_LOCATION ${WGPU_LIBRARY}
                INTERFACE_INCLUDE_DIRECTORIES ${WGPU_INCLUDE_DIR}
            )
            if(WIN32)
                # Windows needs the DLL at runtime
                set_target_properties(wgpu::wgpu PROPERTIES
                    IMPORTED_IMPLIB ${WGPU_LIBRARY}
                )
            endif()
            add_compile_definitions(MYSTRAL_WEBGPU_WGPU)
            set(MYSTRAL_WEBGPU_BACKEND_SET ON)
            # PRD-368. The pipeline cache C API exists only in the maintained patch
            # (`patches/wgpu-native@25.0.2.2.patch`, installed by
            # `download-deps.mjs --rebuild-wgpu-cache-api`). A stock prebuilt declares none of it,
            # so the host's cache path is compiled from what the installed header actually carries
            # rather than from the backend name — otherwise an ordinary `pnpm native:build` stops
            # compiling the moment this repository learns about the cache.
            set(MYSTRAL_WGPU_PIPELINE_CACHE OFF)
            if(EXISTS ${WGPU_INCLUDE_DIR}/webgpu/wgpu.h)
                file(READ ${WGPU_INCLUDE_DIR}/webgpu/wgpu.h WGPU_NATIVE_HEADER_TEXT)
                string(FIND "${WGPU_NATIVE_HEADER_TEXT}" "wgpuDeviceCreatePipelineCache"
                    WGPU_PIPELINE_CACHE_DECLARED_AT)
                unset(WGPU_NATIVE_HEADER_TEXT)
                if(NOT WGPU_PIPELINE_CACHE_DECLARED_AT EQUAL -1)
                    set(MYSTRAL_WGPU_PIPELINE_CACHE ON)
                    add_compile_definitions(MYSTRAL_WGPU_PIPELINE_CACHE)
                endif()
            endif()
            message(STATUS "Found wgpu-native: ${WGPU_LIBRARY}")
            message(STATUS "wgpu-native includes: ${WGPU_INCLUDE_DIR}")
            message(STATUS "wgpu-native pipeline cache API: ${MYSTRAL_WGPU_PIPELINE_CACHE}")
        else()
            message(WARNING "wgpu-native not found:")
            message(WARNING "  Library: ${WGPU_LIBRARY}")
            message(WARNING "  Include: ${WGPU_INCLUDE_DIR}")
        endif()
    else()
        if(MYSTRAL_PLATFORM STREQUAL "ios")
            message(WARNING "wgpu-native iOS not found. Run 'node scripts/download-deps.mjs --only wgpu-ios' first.")
        else()
            message(WARNING "wgpu-native not found. Run 'npm run deps:download:wgpu' first.")
        endif()
    endif()
endif()

# Dawn WebGPU Implementation
# Windows: Uses dawn_combined.lib from Skia build (library-builder), built with /MT static CRT
#          and full D3D11/D3D12 WebGPU implementation (not just proc stubs)
# Other platforms: Uses official Dawn releases from https://github.com/google/dawn/releases
if(MYSTRAL_USE_DAWN)
    set(DAWN_FOUND OFF)

    if(WIN32)
        # Windows: Look for dawn_combined.lib in the Skia build directory
        # The skia-win-static dependency from library-builder includes Dawn with full
        # D3D11/D3D12 backends, built with /MT static CRT to match Skia

        # Set up Skia paths early since Dawn depends on them
        # (normally defined later in the CMakeLists, but needed here for Dawn detection)
        set(SKIA_DIR ${THIRD_PARTY_DIR}/skia)
        set(SKIA_TARGET_DIR ${SKIA_DIR})
        set(SKIA_PLATFORM_DIR "win-gpu")
        set(SKIA_LIB_SUBDIR "x64")

        if(EXISTS ${SKIA_TARGET_DIR})
            # dawn_combined.lib is in the same directory as skia.lib
            set(DAWN_LIB_PATH ${SKIA_TARGET_DIR}/build/${SKIA_PLATFORM_DIR}/lib/Release/${SKIA_LIB_SUBDIR}/dawn_combined.lib)
            message(STATUS "Looking for Dawn combined library at: ${DAWN_LIB_PATH}")

            if(EXISTS ${DAWN_LIB_PATH})
                set(DAWN_LIBRARY ${DAWN_LIB_PATH})
                # Dawn headers in Skia build are split across two locations:
                # 1. build/include/third_party/externals/dawn/include/webgpu/webgpu.h (wrapper)
                # 2. build/include/dawn/webgpu.h (actual definitions)
                # The wrapper includes "dawn/webgpu.h", so we need both paths
                set(DAWN_INCLUDE_DIR
                    ${SKIA_TARGET_DIR}/build/include/third_party/externals/dawn/include
                    ${SKIA_TARGET_DIR}/build/include
                )
                set(DAWN_FOUND ON)
                message(STATUS "Found Dawn combined library from Skia build")
                message(STATUS "Dawn includes: ${DAWN_INCLUDE_DIR}")
            endif()
        endif()

        # Fallback: Try official Dawn releases on Windows if Skia-bundled Dawn not found
        if(NOT DAWN_FOUND)
            set(DAWN_DIR ${THIRD_PARTY_DIR}/dawn)
            if(EXISTS ${DAWN_DIR})
                file(GLOB DAWN_SUBDIRS ${DAWN_DIR}/Dawn-*-Release)
                if(DAWN_SUBDIRS)
                    list(GET DAWN_SUBDIRS 0 DAWN_ACTUAL_DIR)
                    message(STATUS "Found Dawn release directory: ${DAWN_ACTUAL_DIR}")

                    # Windows Dawn release uses webgpu_dawn.lib
                    if(EXISTS ${DAWN_ACTUAL_DIR}/lib/webgpu_dawn.lib)
                        set(DAWN_LIBRARY ${DAWN_ACTUAL_DIR}/lib/webgpu_dawn.lib)
                        set(DAWN_INCLUDE_DIR ${DAWN_ACTUAL_DIR}/include)
                        set(DAWN_FOUND ON)
                        message(STATUS "Found Dawn: ${DAWN_LIBRARY}")
                        message(STATUS "Dawn includes: ${DAWN_INCLUDE_DIR}")
                    endif()
                endif()
            endif()
        endif()

        if(NOT DAWN_FOUND)
            message(WARNING "Dawn not found. Run 'node scripts/download-deps.mjs --only dawn' first.")
        endif()
    elseif(ANDROID)
        if(NOT ANDROID_ABI STREQUAL "arm64-v8a" AND
           NOT CMAKE_ANDROID_ARCH_ABI STREQUAL "arm64-v8a")
            message(FATAL_ERROR
                "TN_DAWN_ANDROID_ABI_UNSUPPORTED: Dawn-on-Android spike only supports arm64-v8a")
        endif()
        set(TN_DAWN_ANDROID_ARCHIVE_NAME
            "Dawn-d14ae3d97ad74100e9f382efef5e9c0872ddbeb2-android-arm64-v8a-Release.tar.gz")
        set(TN_DAWN_ANDROID_ARCHIVE
            "${THREENATIVE_DAWN_ANDROID_ROOT}/${TN_DAWN_ANDROID_ARCHIVE_NAME}")
        if(NOT EXISTS "${TN_DAWN_ANDROID_ARCHIVE}")
            message(FATAL_ERROR
                "TN_DAWN_ANDROID_ARCHIVE_MISSING: ${TN_DAWN_ANDROID_ARCHIVE}; build Dawn d14ae3d97ad74100e9f382efef5e9c0872ddbeb2 for arm64-v8a and place the archive beside its extracted include/ and lib/ directories")
        endif()
        set(DAWN_INCLUDE_DIR "${THREENATIVE_DAWN_ANDROID_ROOT}/include")
        if(EXISTS "${THREENATIVE_DAWN_ANDROID_ROOT}/lib/libwebgpu_dawn.a")
            set(DAWN_LIBRARY "${THREENATIVE_DAWN_ANDROID_ROOT}/lib/libwebgpu_dawn.a")
        elseif(EXISTS "${THREENATIVE_DAWN_ANDROID_ROOT}/lib/libdawn.a")
            set(DAWN_LIBRARY "${THREENATIVE_DAWN_ANDROID_ROOT}/lib/libdawn.a")
        endif()
        if(NOT EXISTS "${DAWN_INCLUDE_DIR}" OR NOT DAWN_LIBRARY)
            message(FATAL_ERROR
                "TN_DAWN_ANDROID_ARTIFACT_MISSING: ${THREENATIVE_DAWN_ANDROID_ROOT} must contain include/ and lib/libwebgpu_dawn.a (or lib/libdawn.a) for arm64-v8a")
        endif()
        set(DAWN_FOUND ON)
        message(STATUS "Found Dawn Android arm64 spike: ${DAWN_LIBRARY}")
    else()
        # Non-Windows: Use official Dawn releases
        set(DAWN_DIR ${THIRD_PARTY_DIR}/dawn)
        if(EXISTS ${DAWN_DIR})
            # Find the platform-specific subdirectory (contains commit hash in name)
            file(GLOB DAWN_SUBDIRS ${DAWN_DIR}/Dawn-*-Release)
            if(DAWN_SUBDIRS)
                list(GET DAWN_SUBDIRS 0 DAWN_ACTUAL_DIR)
                message(STATUS "Found Dawn release directory: ${DAWN_ACTUAL_DIR}")

                # Debug: List what's in the lib directory (try both lib and lib64)
                file(GLOB DAWN_LIB_FILES ${DAWN_ACTUAL_DIR}/lib/*)
                file(GLOB DAWN_LIB64_FILES ${DAWN_ACTUAL_DIR}/lib64/*)
                message(STATUS "Dawn lib directory contents: ${DAWN_LIB_FILES}")
                message(STATUS "Dawn lib64 directory contents: ${DAWN_LIB64_FILES}")

                # Find library - try static first, then shared
                set(DAWN_LIB_NAMES "libwebgpu_dawn.a" "libdawn.a" "libwebgpu_dawn.so" "libdawn.so")
                # Linux uses lib64, macOS uses lib
                set(DAWN_LIB_DIRS "lib64" "lib")

                foreach(LIB_DIR ${DAWN_LIB_DIRS})
                    foreach(LIB_NAME ${DAWN_LIB_NAMES})
                        if(EXISTS ${DAWN_ACTUAL_DIR}/${LIB_DIR}/${LIB_NAME})
                            set(DAWN_LIBRARY ${DAWN_ACTUAL_DIR}/${LIB_DIR}/${LIB_NAME})
                            message(STATUS "Found Dawn library: ${LIB_DIR}/${LIB_NAME}")
                            break()
                        endif()
                    endforeach()
                    if(DAWN_LIBRARY)
                        break()
                    endif()
                endforeach()

                # Fallback: use find_library
                if(NOT DAWN_LIBRARY)
                    find_library(DAWN_LIBRARY
                        NAMES webgpu_dawn dawn
                        PATHS ${DAWN_ACTUAL_DIR}/lib ${DAWN_ACTUAL_DIR}/lib64
                        NO_DEFAULT_PATH
                    )
                endif()

                # Find headers
                if(EXISTS ${DAWN_ACTUAL_DIR}/include)
                    set(DAWN_INCLUDE_DIR ${DAWN_ACTUAL_DIR}/include)
                endif()

                if(DAWN_LIBRARY AND DAWN_INCLUDE_DIR)
                    set(DAWN_FOUND ON)
                endif()
            else()
                message(WARNING "Dawn release directory not found in ${DAWN_DIR}")
                message(WARNING "Run 'node scripts/download-deps.mjs --only dawn' first.")
            endif()
        endif()
    endif()

    if(DAWN_FOUND)
        add_library(dawn::webgpu STATIC IMPORTED)
        set_target_properties(dawn::webgpu PROPERTIES
            IMPORTED_LOCATION "${DAWN_LIBRARY}"
            INTERFACE_INCLUDE_DIRECTORIES "${DAWN_INCLUDE_DIR}"
        )
        # Only define MYSTRAL_WEBGPU_DAWN if wgpu-native wasn't already set up
        # (can't have both WebGPU backends active)
        if(NOT MYSTRAL_WEBGPU_BACKEND_SET)
            add_compile_definitions(MYSTRAL_WEBGPU_DAWN)
            set(MYSTRAL_WEBGPU_BACKEND_SET ON)
            message(STATUS "Using Dawn as WebGPU backend")
        else()
            message(STATUS "Dawn found but wgpu-native already configured as WebGPU backend")
        endif()
        message(STATUS "Found Dawn: ${DAWN_LIBRARY}")
        message(STATUS "Dawn includes: ${DAWN_INCLUDE_DIR}")
    else()
        message(WARNING "Dawn library or headers not found")
        if(WIN32)
            message(WARNING "  Run 'node scripts/download-deps.mjs --only skia-win-static'")
        else()
            message(WARNING "  Run 'node scripts/download-deps.mjs --only dawn'")
        endif()
    endif()
endif()

# The prebuilt Rust Rapier world. The engine's PhysicsSync and the V8 player link it, so it is defined
# before the engine targets; the legacy host adds its binding source where it assembles its own.
if(TN_ENABLE_NATIVE_PHYSICS)
    if(NOT THREENATIVE_PHYSICS_LIBRARY)
        if(ANDROID_ABI STREQUAL "arm64-v8a")
            set(THREENATIVE_PHYSICS_TARGET "aarch64-linux-android")
        elseif(ANDROID_ABI STREQUAL "x86_64")
            set(THREENATIVE_PHYSICS_TARGET "x86_64-linux-android")
        elseif(CMAKE_SYSTEM_NAME STREQUAL "iOS" AND CMAKE_OSX_SYSROOT MATCHES "simulator")
            set(THREENATIVE_PHYSICS_TARGET "aarch64-apple-ios-sim")
        elseif(CMAKE_SYSTEM_NAME STREQUAL "iOS")
            set(THREENATIVE_PHYSICS_TARGET "aarch64-apple-ios")
        else()
            message(FATAL_ERROR "Native physics has no prebuilt target for this platform/architecture")
        endif()
        set(THREENATIVE_PHYSICS_LIBRARY
            "${CMAKE_CURRENT_SOURCE_DIR}/.runtime/physics-target/${THREENATIVE_PHYSICS_TARGET}/release/libthreenative_native_physics.a"
        )
    endif()
    if(NOT EXISTS "${THREENATIVE_PHYSICS_LIBRARY}")
        message(FATAL_ERROR
            "Native physics artifact is missing: ${THREENATIVE_PHYSICS_LIBRARY}. "
            "Run node scripts/build-native-physics.mjs with --android, --ios-simulator, "
            "or --ios-device as appropriate, or supply -DTHREENATIVE_PHYSICS_LIBRARY."
        )
    endif()
    add_library(threenative-native-physics STATIC IMPORTED)
    set_target_properties(threenative-native-physics PROPERTIES
        IMPORTED_LOCATION "${THREENATIVE_PHYSICS_LIBRARY}"
    )
endif()

# The JS-free native engine (PRD-573): its GPU-backed targets are configured only on request, so the
# default (legacy) configure defines no engine target. The portable CPU core has its own switch,
# TN_ENGINE_CORE_ONLY, near the top of this file.
option(TN_ENGINE_ONLY "Configure only the JS-free native engine targets" OFF)
# The V8 player and adapter (PRD-573 slice 6) are JS artifacts above the engine. They are configured
# only by `-DTN_ENGINE_ONLY=ON -DTN_ENGINE_PLAYER=ON -DMYSTRAL_USE_V8=ON -DMYSTRAL_USE_QUICKJS=OFF`:
# the configure then continues far enough to define V8 and the runtime scripts, includes
# cmake/NativeEngineAdapters.cmake and stops, so the legacy host is never defined.
option(TN_ENGINE_PLAYER "With TN_ENGINE_ONLY, also configure the V8 engine player (needs MYSTRAL_USE_V8)" OFF)
if(TN_ENGINE_ONLY)
    include(cmake/NativeEngine.cmake)
    if(NOT TN_ENGINE_PLAYER)
        message(STATUS "TN_ENGINE_ONLY: native engine targets only, no scripting configured")
        return()
    endif()
    message(STATUS "TN_ENGINE_ONLY + TN_ENGINE_PLAYER: native engine targets and the V8 player")
endif()

# QuickJS-NG (actively maintained fork with MSVC/Windows support)
if(MYSTRAL_USE_QUICKJS)
    set(QUICKJS_DIR ${THIRD_PARTY_DIR}/quickjs)
    if(EXISTS ${QUICKJS_DIR})
        # Try to find in subdirectory first (GitHub archives extract with version dir)
        file(GLOB QUICKJS_SUBDIRS ${QUICKJS_DIR}/quickjs-*)
        if(QUICKJS_SUBDIRS)
            list(GET QUICKJS_SUBDIRS 0 QUICKJS_ACTUAL_DIR)
        else()
            set(QUICKJS_ACTUAL_DIR ${QUICKJS_DIR})
        endif()

        # QuickJS is just source files - compile them
        # Note: quickjs-ng integrates libbf into quickjs.c, and adds dtoa.c for number conversion
        file(GLOB QUICKJS_SOURCES
            ${QUICKJS_ACTUAL_DIR}/quickjs.c
            ${QUICKJS_ACTUAL_DIR}/cutils.c
            ${QUICKJS_ACTUAL_DIR}/dtoa.c
            ${QUICKJS_ACTUAL_DIR}/libregexp.c
            ${QUICKJS_ACTUAL_DIR}/libunicode.c
        )
        if(QUICKJS_SOURCES)
            add_library(quickjs STATIC ${QUICKJS_SOURCES})
            # Use SYSTEM to prevent QuickJS's "version" file from shadowing C++ <version>
            target_include_directories(quickjs SYSTEM PUBLIC ${QUICKJS_ACTUAL_DIR})
            target_compile_definitions(quickjs PRIVATE
                CONFIG_VERSION="0.11.0"
                CONFIG_BIGNUM
            )
            # Suppress warnings in third-party code
            if(MSVC)
                target_compile_options(quickjs PRIVATE /W0)
                # Enable C11 for MSVC - required for C11 atomics used by QuickJS
                target_compile_options(quickjs PRIVATE /std:c11)
                # WIN32_LEAN_AND_MEAN prevents winsock.h from being included
                # via windows.h, avoiding conflicts with winsock2.h
                target_compile_definitions(quickjs PRIVATE WIN32_LEAN_AND_MEAN)
            else()
                target_compile_options(quickjs PRIVATE -w)
            endif()
            add_compile_definitions(MYSTRAL_JS_QUICKJS)
            message(STATUS "Found QuickJS-NG in ${QUICKJS_ACTUAL_DIR}")
        else()
            message(WARNING "QuickJS-NG sources not found in ${QUICKJS_ACTUAL_DIR}")
        endif()
    else()
        message(WARNING "QuickJS-NG not found. Run 'npm run deps:download' first.")
    endif()
endif()

# V8
# Prebuilts from kuoruan/libv8: https://github.com/kuoruan/libv8/releases
# See docs/V8_PREBUILTS.md for fork/update information
if(MYSTRAL_USE_V8)
    set(V8_DIR "${THIRD_PARTY_DIR}/v8" CACHE PATH "Desktop V8 headers and monolith")
    # Android ships a shared `libv8android.so` rather than the desktop monolith archive, and it
    # lives beside the desktop one so a host build and a device build can coexist in one checkout.
    # Without this the arm64 link pulls in the x86_64 archive and fails object by object.
    if(ANDROID AND EXISTS ${THIRD_PARTY_DIR}/v8-android)
        set(V8_DIR ${THIRD_PARTY_DIR}/v8-android)
        # Per-ABI: gradle builds arm64-v8a and x86_64 in the same invocation, so a single library
        # path would hand one of them the other's architecture and fail object by object.
        if(CMAKE_ANDROID_ARCH_ABI)
            set(V8_ANDROID_ABI ${CMAKE_ANDROID_ARCH_ABI})
        else()
            set(V8_ANDROID_ABI ${ANDROID_ABI})
        endif()
        set(V8_LIBRARY ${V8_DIR}/lib/${V8_ANDROID_ABI}/libv8android.so)
        set(V8_INCLUDE_DIR ${V8_DIR}/include)
        add_library(v8::v8 SHARED IMPORTED)
        set_target_properties(v8::v8 PROPERTIES
            IMPORTED_LOCATION ${V8_LIBRARY}
            INTERFACE_INCLUDE_DIRECTORIES ${V8_INCLUDE_DIR}
        )
        # The Android V8 is built with pointer compression, and V8 aborts at `Initialize` when the
        # embedder disagrees: "Embedder-vs-V8 build configuration mismatch. On embedder side pointer
        # compression is DISABLED while on V8 side it's ENABLED." These have to match the library,
        # not the host's preference. `V8_COMPRESS_POINTERS_IN_SHARED_CAGE` is the default cage layout
        # for the arm64 build.
        add_compile_definitions(V8_COMPRESS_POINTERS V8_COMPRESS_POINTERS_IN_SHARED_CAGE)
        # The guard the engine sources are compiled behind. It lives in the desktop branch below,
        # which this one bypasses: without it `v8_engine.cpp` compiles to an empty object, the
        # factory finds no engine, and the runtime reports "Failed to create JavaScript engine"
        # while the APK still contains a perfectly good libv8android.so.
        add_compile_definitions(MYSTRAL_JS_V8)
        set(V8_FOUND TRUE)
        message(STATUS "V8 (Android ${V8_ANDROID_ABI}): ${V8_LIBRARY}")
    elseif(EXISTS ${V8_DIR})
        # kuoruan/libv8 structure: v8/include/, v8/lib/
        # Library is libv8_monolith.a (macOS/Linux) or v8_monolith.lib (Windows)
        if(WIN32)
            set(V8_LIB_NAME "v8_monolith.lib")
        else()
            set(V8_LIB_NAME "libv8_monolith.a")
        endif()

        # Find the library (kuoruan/libv8 puts it at root, not in lib/)
        if(EXISTS ${V8_DIR}/${V8_LIB_NAME})
            set(V8_LIBRARY ${V8_DIR}/${V8_LIB_NAME})
        elseif(EXISTS ${V8_DIR}/lib/${V8_LIB_NAME})
            set(V8_LIBRARY ${V8_DIR}/lib/${V8_LIB_NAME})
        else()
            find_library(V8_LIBRARY
                NAMES v8_monolith
                PATHS ${V8_DIR} ${V8_DIR}/lib
                NO_DEFAULT_PATH
            )
        endif()

        # Find headers
        # kuoruan/libv8 puts headers in include/ on Linux/macOS, but at root on Windows
        if(EXISTS ${V8_DIR}/include)
            set(V8_INCLUDE_DIR ${V8_DIR}/include)
        elseif(EXISTS ${V8_DIR}/v8.h)
            # Windows: headers are at root level
            set(V8_INCLUDE_DIR ${V8_DIR})
        endif()

        if(V8_LIBRARY AND V8_INCLUDE_DIR)
            add_library(v8::v8 STATIC IMPORTED)
            set_target_properties(v8::v8 PROPERTIES
                IMPORTED_LOCATION ${V8_LIBRARY}
                INTERFACE_INCLUDE_DIRECTORIES ${V8_INCLUDE_DIR}
            )
            add_compile_definitions(MYSTRAL_JS_V8)
            message(STATUS "Found V8: ${V8_LIBRARY}")
            message(STATUS "V8 includes: ${V8_INCLUDE_DIR}")

            # V8 requires additional system libraries
            if(APPLE)
                # V8 on macOS needs these frameworks
                find_library(COREFOUNDATION_FRAMEWORK CoreFoundation)
            elseif(ANDROID)
                # Same bionic story as the runtime's own link line: pthread and dl live in libc,
                # and Android matches `UNIX`, so it has to be answered first.
                set(V8_SYSTEM_LIBS "")
            elseif(UNIX)
                # V8 on Linux needs pthread and dl
                set(V8_SYSTEM_LIBS pthread dl)
                if(CMAKE_SYSTEM_NAME STREQUAL "Linux" AND CMAKE_SYSTEM_PROCESSOR MATCHES "^(aarch64|arm64)$")
                    list(APPEND V8_SYSTEM_LIBS atomic)
                endif()
            elseif(WIN32)
                # V8 on Windows needs these
                set(V8_SYSTEM_LIBS winmm dbghelp shlwapi)
            endif()
        else()
            message(WARNING "V8 not found:")
            message(WARNING "  Library: ${V8_LIBRARY}")
            message(WARNING "  Include: ${V8_INCLUDE_DIR}")
            message(WARNING "Run 'node scripts/download-deps.mjs --only v8' first.")
        endif()
    else()
        message(WARNING "V8 not found. Run 'node scripts/download-deps.mjs --only v8' first.")
    endif()
endif()

# JavaScriptCore (macOS/iOS)
if(MYSTRAL_USE_JSC)
    if(APPLE)
        find_library(JAVASCRIPTCORE_FRAMEWORK JavaScriptCore)
        if(JAVASCRIPTCORE_FRAMEWORK)
            add_compile_definitions(MYSTRAL_JS_JSC)
            message(STATUS "Found JavaScriptCore: ${JAVASCRIPTCORE_FRAMEWORK}")
        endif()
    else()
        message(WARNING "JavaScriptCore is only available on Apple platforms")
    endif()
endif()

# libwebp (for WebP image decoding and animated WebP video recording)
# Note: webp prebuilts are only available for desktop platforms (macOS, Linux, Windows)
# iOS/Android cross-compilation would need webp built from source, which we skip for now
set(WEBP_DIR ${THIRD_PARTY_DIR}/webp)
if(ANDROID)
    # WebP prebuilts ship for desktop only, and games embed WebP textures in glTF
    # (EXT_texture_webp) — a runtime without decode support prints "WebP format
    # support: NO" at boot and GLTFLoader then drops every model texture, which
    # renders as untextured white meshes (docs/bugs/android-ktx2-unsupported-2026-08-23.md
    # records the sibling KTX2 failure; this is its texture cousin). Build the
    # upstream source with the cross toolchain; provisioned by
    # 'node scripts/download-deps.mjs --only webp-source'. The source tree is the
    # extracted libwebp-<version>/ inside third_party/webp-source/ (its own
    # destination, because the downloader's skip-if-exists guard is per directory).
    set(WEBP_SOURCE_ROOT ${THIRD_PARTY_DIR}/webp-source)
    file(GLOB WEBP_SOURCE_CANDIDATES ${WEBP_SOURCE_ROOT}/libwebp-*)
    set(WEBP_SOURCE_DIR "")
    foreach(WEBP_CANDIDATE ${WEBP_SOURCE_CANDIDATES})
        if(EXISTS ${WEBP_CANDIDATE}/CMakeLists.txt AND NOT EXISTS ${WEBP_CANDIDATE}/lib)
            set(WEBP_SOURCE_DIR ${WEBP_CANDIDATE})
            break()
        endif()
    endforeach()
    if(WEBP_SOURCE_DIR)
        message(STATUS "Building libwebp from source: ${WEBP_SOURCE_DIR}")
        set(WEBP_BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
        set(WEBP_LINK_STATIC ON CACHE BOOL "" FORCE)
        set(WEBP_ENABLE_SIMD ON CACHE BOOL "" FORCE)
        foreach(WEBP_TOOL WEBP_BUILD_ANIM_UTILS WEBP_BUILD_CWEBP WEBP_BUILD_DWEBP
                          WEBP_BUILD_GIF2WEBP WEBP_BUILD_IMG2WEBP WEBP_BUILD_VWEBP
                          WEBP_BUILD_WEBPINFO WEBP_BUILD_LIBWEBPMUX WEBP_BUILD_EXTRAS)
            set(${WEBP_TOOL} OFF CACHE BOOL "" FORCE)
        endforeach()
        add_subdirectory(${WEBP_SOURCE_DIR} ${CMAKE_BINARY_DIR}/libwebp-build EXCLUDE_FROM_ALL)
        # The dependency link block below keys on these target names; alias the
        # upstream targets so desktop and Android share one linkage path.
        add_library(webp::webp ALIAS webp)
        if(TARGET sharpyuv)
            add_library(webp::sharpyuv ALIAS sharpyuv)
        endif()
        add_compile_definitions(MYSTRAL_HAS_WEBP)
    else()
        message(STATUS "libwebp not found - WebP texture support disabled. Run 'node scripts/download-deps.mjs --only webp-source' to enable.")
    endif()
elseif(EXISTS ${WEBP_DIR} AND NOT IOS)
    # libwebp prebuilt structure: webp/libwebp-{version}-{platform}/lib/libwebp.a
    file(GLOB WEBP_SUBDIRS ${WEBP_DIR}/libwebp-*)
    if(WEBP_SUBDIRS)
        list(GET WEBP_SUBDIRS 0 WEBP_ACTUAL_DIR)
        message(STATUS "Found libwebp directory: ${WEBP_ACTUAL_DIR}")

        # Find library
        if(WIN32)
            find_library(WEBP_LIBRARY
                NAMES webp libwebp
                PATHS ${WEBP_ACTUAL_DIR}/lib
                NO_DEFAULT_PATH
            )
            find_library(WEBP_MUX_LIBRARY
                NAMES webpmux libwebpmux
                PATHS ${WEBP_ACTUAL_DIR}/lib
                NO_DEFAULT_PATH
            )
            find_library(WEBP_SHARPYUV_LIBRARY
                NAMES sharpyuv libsharpyuv
                PATHS ${WEBP_ACTUAL_DIR}/lib
                NO_DEFAULT_PATH
            )
        else()
            # Prefer static library
            if(EXISTS ${WEBP_ACTUAL_DIR}/lib/libwebp.a)
                set(WEBP_LIBRARY ${WEBP_ACTUAL_DIR}/lib/libwebp.a)
            else()
                find_library(WEBP_LIBRARY
                    NAMES webp
                    PATHS ${WEBP_ACTUAL_DIR}/lib
                    NO_DEFAULT_PATH
                )
            endif()
            # Find libwebpmux for animated WebP encoding
            if(EXISTS ${WEBP_ACTUAL_DIR}/lib/libwebpmux.a)
                set(WEBP_MUX_LIBRARY ${WEBP_ACTUAL_DIR}/lib/libwebpmux.a)
            endif()
            # Find libsharpyuv (required by libwebp for YUV conversion)
            if(EXISTS ${WEBP_ACTUAL_DIR}/lib/libsharpyuv.a)
                set(WEBP_SHARPYUV_LIBRARY ${WEBP_ACTUAL_DIR}/lib/libsharpyuv.a)
            endif()
        endif()

        # Find headers
        if(EXISTS ${WEBP_ACTUAL_DIR}/include)
            set(WEBP_INCLUDE_DIR ${WEBP_ACTUAL_DIR}/include)
        endif()

        if(WEBP_LIBRARY AND WEBP_INCLUDE_DIR)
            add_library(webp::webp STATIC IMPORTED)
            set_target_properties(webp::webp PROPERTIES
                IMPORTED_LOCATION ${WEBP_LIBRARY}
                INTERFACE_INCLUDE_DIRECTORIES ${WEBP_INCLUDE_DIR}
            )
            add_compile_definitions(MYSTRAL_HAS_WEBP)
            message(STATUS "Found libwebp: ${WEBP_LIBRARY}")
            message(STATUS "libwebp includes: ${WEBP_INCLUDE_DIR}")

            # Add webpmux target for animated WebP encoding
            if(WEBP_MUX_LIBRARY)
                add_library(webp::mux STATIC IMPORTED)
                set_target_properties(webp::mux PROPERTIES
                    IMPORTED_LOCATION ${WEBP_MUX_LIBRARY}
                    INTERFACE_INCLUDE_DIRECTORIES ${WEBP_INCLUDE_DIR}
                )
                add_compile_definitions(MYSTRAL_HAS_WEBP_MUX)
                message(STATUS "Found libwebpmux: ${WEBP_MUX_LIBRARY}")
            endif()

            # Add sharpyuv target (dependency for webp encoding)
            if(WEBP_SHARPYUV_LIBRARY)
                add_library(webp::sharpyuv STATIC IMPORTED)
                set_target_properties(webp::sharpyuv PROPERTIES
                    IMPORTED_LOCATION ${WEBP_SHARPYUV_LIBRARY}
                )
                message(STATUS "Found libsharpyuv: ${WEBP_SHARPYUV_LIBRARY}")
            endif()
        else()
            message(WARNING "libwebp library or headers not found:")
            message(WARNING "  Library: ${WEBP_LIBRARY}")
            message(WARNING "  Include: ${WEBP_INCLUDE_DIR}")
        endif()
    else()
        message(WARNING "libwebp subdirectory not found in ${WEBP_DIR}")
    endif()
else()
    message(STATUS "libwebp not found - WebP texture support disabled. Run 'node scripts/download-deps.mjs --only webp' to enable.")
endif()

# Skia (for Canvas 2D implementation)
# All platforms now use olilarkin/skia-builder: https://github.com/olilarkin/skia-builder/releases
# Structure: skia/build/include/include/core/...
#            skia/build/{platform}-gpu/lib/Release/{arch}/libskia.a
# TN_SKIA_BLOCK_BEGIN
if(ANDROID AND TN_ENABLE_CANVAS2D)
    # Android Skia is staged per ABI; never select the host Linux archive for an Android build.
    if(CMAKE_ANDROID_ARCH_ABI)
        set(SKIA_ANDROID_ABI "${CMAKE_ANDROID_ARCH_ABI}")
    else()
        set(SKIA_ANDROID_ABI "${ANDROID_ABI}")
    endif()
    if(NOT SKIA_ANDROID_ABI)
        message(FATAL_ERROR
            "TN_SKIA_ANDROID_ABI_MISSING: Android Canvas2D requires CMAKE_ANDROID_ARCH_ABI or ANDROID_ABI")
    endif()
    set(SKIA_ANDROID_ROOT "${THIRD_PARTY_DIR}/skia-android")
    set(SKIA_INCLUDE_DIR "${SKIA_ANDROID_ROOT}/build/include")
    set(SKIA_ANDROID_LIB_DIR "${SKIA_ANDROID_ROOT}/build/android/lib/Release/${SKIA_ANDROID_ABI}")
    if(NOT EXISTS "${SKIA_INCLUDE_DIR}/include/core/SkCanvas.h"
       OR NOT EXISTS "${SKIA_INCLUDE_DIR}/include/ports/SkFontMgr_android.h"
       OR NOT EXISTS "${SKIA_INCLUDE_DIR}/include/ports/SkFontScanner_FreeType.h")
        message(FATAL_ERROR
            "TN_SKIA_ANDROID_HEADERS_MISSING: ${SKIA_INCLUDE_DIR} must contain SkCanvas, Android font, "
            "and FreeType scanner headers for ${SKIA_ANDROID_ABI}")
    endif()
    set(SKIA_ANDROID_REQUIRED_ARCHIVES
        libskia.a libfreetype2.a libpng.a libzlib.a libexpat.a libskcms.a libwuffs.a libcpu-features.a)
    set(SKIA_ANDROID_MISSING_ARCHIVES "")
    foreach(SKIA_ANDROID_ARCHIVE IN LISTS SKIA_ANDROID_REQUIRED_ARCHIVES)
        if(NOT EXISTS "${SKIA_ANDROID_LIB_DIR}/${SKIA_ANDROID_ARCHIVE}")
            list(APPEND SKIA_ANDROID_MISSING_ARCHIVES "${SKIA_ANDROID_ARCHIVE}")
        endif()
    endforeach()
    if(SKIA_ANDROID_MISSING_ARCHIVES)
        message(FATAL_ERROR
            "TN_SKIA_ANDROID_ARCHIVE_MISSING: ${SKIA_ANDROID_LIB_DIR} is missing "
            "${SKIA_ANDROID_MISSING_ARCHIVES} for ${SKIA_ANDROID_ABI}")
    endif()
    set(SKIA_LIBRARY "${SKIA_ANDROID_LIB_DIR}/libskia.a")
    set(SKIA_ANDROID_EXTRA_LIBS "")
    foreach(SKIA_ANDROID_ARCHIVE IN LISTS SKIA_ANDROID_REQUIRED_ARCHIVES)
        if(NOT SKIA_ANDROID_ARCHIVE STREQUAL "libskia.a")
            list(APPEND SKIA_ANDROID_EXTRA_LIBS "${SKIA_ANDROID_LIB_DIR}/${SKIA_ANDROID_ARCHIVE}")
        endif()
    endforeach()
    # CMake 3.20 has no LINK_GROUP generator expression. Raw GNU/Clang linker items are accepted
    # by that minimum and keep every cyclic archive, including libskia.a, inside one group.
    add_library(skia::skia INTERFACE IMPORTED)
    set_target_properties(skia::skia PROPERTIES
        INTERFACE_INCLUDE_DIRECTORIES "${SKIA_INCLUDE_DIR}"
        INTERFACE_LINK_LIBRARIES "-Wl,--start-group;${SKIA_LIBRARY};${SKIA_ANDROID_EXTRA_LIBS};-Wl,--end-group"
    )
    add_compile_definitions(MYSTRAL_HAS_SKIA)
    message(STATUS "Found Skia Android ${SKIA_ANDROID_ABI}: ${SKIA_LIBRARY}")
else()
if(MYSTRAL_PLATFORM STREQUAL "ios")
    set(SKIA_DIR ${THIRD_PARTY_DIR}/skia-ios)
    # iOS Skia structure: skia-ios/{device,simulator}/build/...
    if(CMAKE_OSX_SYSROOT MATCHES "simulator")
        set(SKIA_TARGET_DIR ${SKIA_DIR}/simulator)
        if(CMAKE_OSX_ARCHITECTURES STREQUAL "x86_64")
            set(SKIA_LIB_SUBDIR "simulator-x86_64")
        else()
            set(SKIA_LIB_SUBDIR "simulator-arm64")
        endif()
        set(SKIA_PLATFORM_DIR "ios-gpu")
    else()
        set(SKIA_TARGET_DIR ${SKIA_DIR}/device)
        set(SKIA_LIB_SUBDIR "device-arm64")
        set(SKIA_PLATFORM_DIR "ios-gpu")
    endif()
else()
    set(SKIA_DIR ${THIRD_PARTY_DIR}/skia)
    set(SKIA_TARGET_DIR ${SKIA_DIR})

    # Determine platform directory and architecture
    if(WIN32)
        set(SKIA_PLATFORM_DIR "win-gpu")
        set(SKIA_LIB_SUBDIR "x64")
    elseif(APPLE)
        set(SKIA_PLATFORM_DIR "mac-gpu")
        if(CMAKE_SYSTEM_PROCESSOR STREQUAL "arm64" OR CMAKE_OSX_ARCHITECTURES MATCHES "arm64")
            set(SKIA_LIB_SUBDIR "arm64")
        else()
            set(SKIA_LIB_SUBDIR "x86_64")
        endif()
    else()
        set(SKIA_PLATFORM_DIR "linux-gpu")
        if(CMAKE_SYSTEM_PROCESSOR MATCHES "aarch64|arm64")
            set(SKIA_LIB_SUBDIR "arm64")
        else()
            set(SKIA_LIB_SUBDIR "x64")
        endif()
    endif()
endif()

# Linux arm64 ships an arm64 Skia prebuilt (library-builder chrome/m145), so a build that asked
# for Canvas2D and cannot find it is a missing dependency, not a host that never had Canvas2D.
# Disabling it there made the arm64 desktop artifact quietly differ from every other platform.
if(TN_ENABLE_CANVAS2D AND MYSTRAL_PLATFORM STREQUAL "linux"
   AND CMAKE_SYSTEM_PROCESSOR MATCHES "aarch64|arm64")
    set(TN_SKIA_ARM64_REQUIRED ON)
endif()

if(TN_ENABLE_CANVAS2D AND EXISTS ${SKIA_TARGET_DIR})
    message(STATUS "Found Skia directory: ${SKIA_TARGET_DIR}")

    # olilarkin/skia-builder structure (used for all platforms now)
    # Headers: build/include/include/core/...
    # Library: build/{platform}-gpu/lib/Release/{arch}/libskia.a
    if(EXISTS ${SKIA_TARGET_DIR}/build/include/include)
        set(SKIA_INCLUDE_DIR ${SKIA_TARGET_DIR}/build/include)
    endif()

    # Find library
    if(WIN32)
        set(SKIA_LIB_PATH ${SKIA_TARGET_DIR}/build/${SKIA_PLATFORM_DIR}/lib/Release/${SKIA_LIB_SUBDIR}/skia.lib)
    else()
        set(SKIA_LIB_PATH ${SKIA_TARGET_DIR}/build/${SKIA_PLATFORM_DIR}/lib/Release/${SKIA_LIB_SUBDIR}/libskia.a)
    endif()

    if(EXISTS ${SKIA_LIB_PATH})
        set(SKIA_LIBRARY ${SKIA_LIB_PATH})
    endif()

    if(SKIA_LIBRARY AND SKIA_INCLUDE_DIR)
        add_library(skia::skia STATIC IMPORTED)
        set_target_properties(skia::skia PROPERTIES
            IMPORTED_LOCATION ${SKIA_LIBRARY}
            INTERFACE_INCLUDE_DIRECTORIES ${SKIA_INCLUDE_DIR}
        )
        add_compile_definitions(MYSTRAL_HAS_SKIA)
        message(STATUS "Found Skia: ${SKIA_LIBRARY}")
        message(STATUS "Skia includes: ${SKIA_INCLUDE_DIR}")
    else()
        if(TN_SKIA_ARM64_REQUIRED)
            message(FATAL_ERROR
                "TN_SKIA_ARM64_MISSING: Canvas2D was requested on arm64 but Skia is incomplete.\n"
                "  Library: ${SKIA_LIB_PATH}\n"
                "  Include: ${SKIA_INCLUDE_DIR}\n"
                "  Run 'node scripts/download-deps.mjs --only skia' on an arm64 host, or configure with -DTN_ENABLE_CANVAS2D=OFF to drop the surface deliberately.")
        endif()
        message(WARNING "Skia library or headers not found:")
        message(WARNING "  Library: ${SKIA_LIB_PATH}")
        message(WARNING "  Include: ${SKIA_INCLUDE_DIR}")
    endif()
else()
    if(NOT TN_ENABLE_CANVAS2D)
        message(STATUS "Skia disabled because TN_ENABLE_CANVAS2D=OFF")
    endif()
    if(TN_SKIA_ARM64_REQUIRED)
        message(FATAL_ERROR
            "TN_SKIA_ARM64_MISSING: Canvas2D was requested on arm64 but no Skia was found at ${SKIA_TARGET_DIR}.\n"
            "  Run 'node scripts/download-deps.mjs --only skia' on an arm64 host, or configure with -DTN_ENABLE_CANVAS2D=OFF to drop the surface deliberately.")
    endif()
    if(MYSTRAL_PLATFORM STREQUAL "ios")
        message(STATUS "Skia iOS not found - Canvas 2D support disabled. Run 'node scripts/download-deps.mjs --only skia-ios' to enable.")
    else()
        message(STATUS "Skia not found - Canvas 2D support disabled. Run 'node scripts/download-deps.mjs --only skia' to enable.")
    endif()
endif()
endif()
# TN_SKIA_BLOCK_END

# SWC (TypeScript transpiler)
# Prebuilt layout: swc/include/swc.h and swc/lib/libswc.a (or swc.lib on Windows)
set(SWC_DIR ${THIRD_PARTY_DIR}/swc)
if(MYSTRAL_USE_SWC AND EXISTS ${SWC_DIR} AND NOT IOS AND NOT ANDROID)
    if(EXISTS ${SWC_DIR}/include)
        set(SWC_INCLUDE_DIR ${SWC_DIR}/include)
    endif()

    if(WIN32)
        set(SWC_LIB_PATH ${SWC_DIR}/lib/swc.lib)
    else()
        set(SWC_LIB_PATH ${SWC_DIR}/lib/libswc.a)
    endif()

    if(EXISTS ${SWC_LIB_PATH})
        set(SWC_LIBRARY ${SWC_LIB_PATH})
    else()
        find_library(SWC_LIBRARY
            NAMES swc libswc
            PATHS ${SWC_DIR}/lib ${SWC_DIR}
            NO_DEFAULT_PATH
        )
    endif()

    if(SWC_LIBRARY AND SWC_INCLUDE_DIR)
        add_library(swc::swc STATIC IMPORTED)
        set_target_properties(swc::swc PROPERTIES
            IMPORTED_LOCATION ${SWC_LIBRARY}
            INTERFACE_INCLUDE_DIRECTORIES ${SWC_INCLUDE_DIR}
        )
        add_compile_definitions(MYSTRAL_HAS_SWC)
        message(STATUS "Found SWC: ${SWC_LIBRARY}")
        message(STATUS "SWC includes: ${SWC_INCLUDE_DIR}")
    else()
        message(WARNING "SWC library or headers not found:")
        message(WARNING "  Library: ${SWC_LIBRARY}")
        message(WARNING "  Include: ${SWC_INCLUDE_DIR}")
    endif()
else()
    if(MYSTRAL_USE_SWC)
        message(STATUS "SWC not found - TypeScript transpiling disabled. Run 'node scripts/download-deps.mjs --only swc' to enable.")
    endif()
endif()

# libuv (async I/O library for non-blocking network, file, and timer operations)
# Prebuilt layout: libuv/include/uv.h, libuv/include/uv/*.h, libuv/libuv.a (or libuv.lib)
# Note: libuv is only used on desktop platforms; iOS/Android use platform-native async APIs
set(LIBUV_DIR ${THIRD_PARTY_DIR}/libuv)
set(LIBUV_SOURCE_DIR ${THIRD_PARTY_DIR}/libuv-src/libuv-1.51.0)
# Two reasons to build libuv from the pinned 1.51.0 source rather than link the prebuilt:
#   1. AddressSanitizer cannot instrument inside the prebuilt libuv.a, so a write-after-free on
#      libuv's own closing list - the exact defect PRD-177 and PRD-184 exist to prove - is invisible
#      to the lane that exists to catch it.
#   2. No prebuilt exists for every target: Linux arm64 publishes only an x64 libuv.a, and
#      download-deps.mjs fetches the arch-independent libuv-source there instead.
# The prebuilt stays first choice whenever it exists, so x64/macOS/Windows linking is unchanged.
set(LIBUV_SOURCE_AVAILABLE FALSE)
if(EXISTS ${LIBUV_SOURCE_DIR}/CMakeLists.txt AND NOT IOS AND NOT ANDROID)
    set(LIBUV_SOURCE_AVAILABLE TRUE)
endif()
if(LIBUV_SOURCE_AVAILABLE AND (TN_ENABLE_SANITIZERS OR NOT EXISTS ${LIBUV_DIR}))
    set(LIBUV_BUILD_SHARED OFF CACHE BOOL "libuv static when built from source" FORCE)
    set(LIBUV_BUILD_TESTS OFF CACHE BOOL "libuv tests are not ours to run" FORCE)
    set(LIBUV_BUILD_BENCH OFF CACHE BOOL "libuv benchmarks are not ours to run" FORCE)
    # libuv's own CMakeLists defines the libuv::libuv alias over its selected library; with
    # LIBUV_BUILD_SHARED OFF that is the static uv_a. Do not re-alias it here.
    add_subdirectory(${LIBUV_SOURCE_DIR} ${CMAKE_BINARY_DIR}/libuv-src EXCLUDE_FROM_ALL)
    if(TARGET libuv::libuv)
        add_compile_definitions(MYSTRAL_HAS_LIBUV)
        if(UNIX AND NOT APPLE)
            set(LIBUV_SYSTEM_LIBS pthread dl)
        endif()
        message(STATUS "libuv: source build (${LIBUV_SOURCE_DIR})")
    else()
        message(FATAL_ERROR
            "libuv source at ${LIBUV_SOURCE_DIR} defined no libuv::libuv target; the build must "
            "not fall back to the prebuilt and silently lose async I/O (or sanitizer coverage)")
    endif()
elseif(EXISTS ${LIBUV_DIR} AND NOT IOS AND NOT ANDROID)
    # Headers are directly in include/
    if(EXISTS ${LIBUV_DIR}/include)
        set(LIBUV_INCLUDE_DIR ${LIBUV_DIR}/include)
    endif()

    # Library is at root level (from library-builder output)
    if(WIN32)
        set(LIBUV_LIB_PATH ${LIBUV_DIR}/libuv.lib)
    else()
        set(LIBUV_LIB_PATH ${LIBUV_DIR}/libuv.a)
    endif()

    if(EXISTS ${LIBUV_LIB_PATH})
        set(LIBUV_LIBRARY ${LIBUV_LIB_PATH})
    else()
        find_library(LIBUV_LIBRARY
            NAMES uv libuv
            PATHS ${LIBUV_DIR} ${LIBUV_DIR}/lib
            NO_DEFAULT_PATH
        )
    endif()

    if(LIBUV_LIBRARY AND LIBUV_INCLUDE_DIR)
        add_library(libuv::libuv STATIC IMPORTED)
        set_target_properties(libuv::libuv PROPERTIES
            IMPORTED_LOCATION ${LIBUV_LIBRARY}
            INTERFACE_INCLUDE_DIRECTORIES ${LIBUV_INCLUDE_DIR}
        )
        add_compile_definitions(MYSTRAL_HAS_LIBUV)
        message(STATUS "Found libuv: ${LIBUV_LIBRARY}")
        message(STATUS "libuv includes: ${LIBUV_INCLUDE_DIR}")

        # libuv requires additional system libraries on each platform
        if(WIN32)
            # Windows: network, system, and debug libraries
            # dbghelp is required for uv_kill stack trace functionality
            set(LIBUV_SYSTEM_LIBS iphlpapi psapi userenv ws2_32 dbghelp)
        elseif(UNIX AND NOT APPLE)
            # Linux: pthread and dl
            set(LIBUV_SYSTEM_LIBS pthread dl)
        endif()
    else()
        message(WARNING "libuv library or headers not found:")
        message(WARNING "  Library: ${LIBUV_LIB_PATH}")
        message(WARNING "  Include: ${LIBUV_INCLUDE_DIR}")
    endif()
else()
    message(STATUS "libuv not found - async I/O disabled. Run 'node scripts/download-deps.mjs --only libuv' to enable.")
endif()

# ============================================================================
# quiche (QUIC + HTTP/3, for the WebTransport API)
# ============================================================================
# quiche is a Rust library exposing a C API. The static library (libquiche.a /
# quiche.lib + patched quiche.h, BoringSSL bundled) is built by
# mystralengine/library-builder and downloaded as a prebuilt by
# download-deps.mjs (like libuv/swc) — the engine repo never compiles
# Rust/BoringSSL itself. WebTransport is disabled (stubbed) if the library is
# not present, so the build still succeeds without it.
#
# WebTransport drives its QUIC UDP socket + timers directly on the runtime poll
# loop with raw non-blocking sockets (no libuv), so it is enabled on desktop AND
# mobile. download-deps.mjs lays prebuilts out per platform/variant:
#   desktop : quiche/{include/quiche.h, libquiche.a|quiche.lib}
#   iOS     : quiche-ios/<device|simulatorArm64|simulatorX64>/{include, libquiche.a}
#   Android : quiche-android/<aarch64|armv7|x86_64>/{include, libquiche.a}
# (arm64 iOS simulator is not yet shipped — see docs/realtimecommunication.md.)
option(MYSTRAL_USE_QUICHE "Enable QUIC/HTTP3 WebTransport via quiche" ON)
if(NOT TN_ENABLE_WEBTRANSPORT)
    set(MYSTRAL_USE_QUICHE OFF CACHE BOOL "Enable QUIC/HTTP3 WebTransport via quiche" FORCE)
endif()
if(MYSTRAL_USE_QUICHE)
    # Select the prebuilt directory for this target.
    if(IOS)
        if(CMAKE_OSX_SYSROOT MATCHES "[Ss]imulator")
            if(CMAKE_OSX_ARCHITECTURES MATCHES "x86_64")
                set(QUICHE_DIR ${THIRD_PARTY_DIR}/quiche-ios/simulatorX64)
            else()
                set(QUICHE_DIR ${THIRD_PARTY_DIR}/quiche-ios/simulatorArm64)
            endif()
        else()
            set(QUICHE_DIR ${THIRD_PARTY_DIR}/quiche-ios/device)
        endif()
    elseif(ANDROID)
        if(CMAKE_ANDROID_ARCH_ABI STREQUAL "arm64-v8a" OR ANDROID_ABI STREQUAL "arm64-v8a")
            set(QUICHE_DIR ${THIRD_PARTY_DIR}/quiche-android/aarch64)
        elseif(CMAKE_ANDROID_ARCH_ABI STREQUAL "armeabi-v7a" OR ANDROID_ABI STREQUAL "armeabi-v7a")
            set(QUICHE_DIR ${THIRD_PARTY_DIR}/quiche-android/armv7)
        else()
            set(QUICHE_DIR ${THIRD_PARTY_DIR}/quiche-android/x86_64)
        endif()
    else()
        set(QUICHE_DIR ${THIRD_PARTY_DIR}/quiche)
    endif()

    set(QUICHE_INCLUDE_DIR ${QUICHE_DIR}/include)
    if(WIN32)
        set(QUICHE_LIB_PATH ${QUICHE_DIR}/quiche.lib)
    else()
        set(QUICHE_LIB_PATH ${QUICHE_DIR}/libquiche.a)
    endif()

    if(EXISTS ${QUICHE_LIB_PATH} AND EXISTS ${QUICHE_INCLUDE_DIR}/quiche.h)
        add_library(quiche::quiche STATIC IMPORTED)
        set_target_properties(quiche::quiche PROPERTIES
            IMPORTED_LOCATION ${QUICHE_LIB_PATH}
            INTERFACE_INCLUDE_DIRECTORIES ${QUICHE_INCLUDE_DIR}
        )
        add_compile_definitions(MYSTRAL_HAS_QUICHE)
        message(STATUS "Found quiche: ${QUICHE_LIB_PATH}")
        message(STATUS "quiche includes: ${QUICHE_INCLUDE_DIR}")
    else()
        if(TN_REQUIRE_WEBTRANSPORT)
            message(FATAL_ERROR
                "TN_WEBTRANSPORT_REQUIRED: quiche artifact is missing for platform "
                "'${MYSTRAL_PLATFORM}'. Expected library '${QUICHE_LIB_PATH}' and header "
                "'${QUICHE_INCLUDE_DIR}/quiche.h'. Run the dependency download for this target.")
        endif()
        message(STATUS "quiche not found at ${QUICHE_LIB_PATH} - WebTransport disabled (stub).")
        message(STATUS "  Run 'node scripts/download-deps.mjs --only quiche' (desktop) or '--ios' / '--android' (mobile) to enable.")
    endif()
elseif(TN_REQUIRE_WEBTRANSPORT)
    message(FATAL_ERROR
        "TN_WEBTRANSPORT_REQUIRED: quiche is disabled for platform '${MYSTRAL_PLATFORM}'. "
        "Expected quiche artifacts under '${THIRD_PARTY_DIR}' for this target; enable MYSTRAL_USE_QUICHE and "
        "TN_ENABLE_WEBTRANSPORT.")
endif()

# Ray Tracing (optional - hardware RT via DXR/Vulkan/Metal)
# For now, this only adds the C++ infrastructure and JS bindings.
# Actual backend implementations (DXR, Vulkan RT, Metal RT) will be added in Wave 3-4.
if(MYSTRAL_USE_RAYTRACING)
    add_compile_definitions(MYSTRAL_HAS_RAYTRACING)
    message(STATUS "Ray tracing support enabled")

    # Find Vulkan for Vulkan RT backend
    if(NOT WIN32 OR MYSTRAL_USE_VULKAN_RT)
        find_package(Vulkan QUIET)
        if(Vulkan_FOUND)
            add_compile_definitions(MYSTRAL_HAS_VULKAN_RT)
            message(STATUS "Found Vulkan: ${Vulkan_LIBRARY}")
            message(STATUS "Vulkan includes: ${Vulkan_INCLUDE_DIR}")
        else()
            # Try to find Vulkan SDK manually
            if(DEFINED ENV{VULKAN_SDK})
                set(VULKAN_SDK $ENV{VULKAN_SDK})
                if(WIN32)
                    set(Vulkan_LIBRARY "${VULKAN_SDK}/Lib/vulkan-1.lib")
                else()
                    set(Vulkan_LIBRARY "${VULKAN_SDK}/lib/libvulkan.so")
                    if(NOT EXISTS ${Vulkan_LIBRARY})
                        set(Vulkan_LIBRARY "${VULKAN_SDK}/lib/libvulkan.dylib")
                    endif()
                endif()
                set(Vulkan_INCLUDE_DIR "${VULKAN_SDK}/include")

                if(EXISTS ${Vulkan_LIBRARY} AND EXISTS ${Vulkan_INCLUDE_DIR})
                    set(Vulkan_FOUND TRUE)
                    add_compile_definitions(MYSTRAL_HAS_VULKAN_RT)
                    message(STATUS "Found Vulkan SDK: ${VULKAN_SDK}")
                endif()
            endif()
        endif()

        if(NOT Vulkan_FOUND)
            message(STATUS "Vulkan not found - Vulkan RT backend disabled")
            message(STATUS "  Set VULKAN_SDK environment variable or install Vulkan SDK")
        endif()
    endif()

    # Metal RT backend (Apple Silicon with macOS 13+)
    # Metal 3 ray tracing requires Apple Silicon (M1/M2/M3) - Intel Macs not supported
    if(APPLE AND NOT MYSTRAL_PLATFORM STREQUAL "ios")
        # Check for macOS 13+ (Ventura) at runtime; always enable compilation on macOS
        add_compile_definitions(MYSTRAL_HAS_METAL_RT)
        set(METAL_RT_ENABLED TRUE)
        message(STATUS "Metal RT backend enabled (Apple Silicon with macOS 13+ required at runtime)")
    endif()
endif()

# ============================================================================
# Main Library
# ============================================================================

set(TN_RUNTIME_SCRIPT_DIR "${CMAKE_CURRENT_SOURCE_DIR}/src/runtime-scripts")
set(TN_RUNTIME_SCRIPT_NAMES
    storage-polyfill
    fetch-polyfill
    streams-polyfill
    url-worker-polyfill
    create-element-setup
    event-constructors-setup
    scheduler-yield
    image-support-init
    onload-trigger
    install-async-pipelines
    frame-op-stream
    image-bitmap-polyfill
    webtransport-polyfill
    webtransport-stub
    install-async-audio-decode
    audio-context-constructor
    audio-source-properties
    audio-gain-param
    audio-param
    audio-panner-properties
    canvas2d-properties
)
set(TN_RUNTIME_SCRIPT_FILES)
foreach(TN_RUNTIME_SCRIPT_NAME IN LISTS TN_RUNTIME_SCRIPT_NAMES)
    list(APPEND TN_RUNTIME_SCRIPT_FILES
        "${TN_RUNTIME_SCRIPT_DIR}/${TN_RUNTIME_SCRIPT_NAME}.js"
    )
endforeach()
set(TN_RUNTIME_SCRIPT_HEADER "${CMAKE_CURRENT_BINARY_DIR}/generated/runtime_scripts.h")
add_custom_command(
    OUTPUT "${TN_RUNTIME_SCRIPT_HEADER}"
    COMMAND ${CMAKE_COMMAND}
        "-DOUTPUT=${TN_RUNTIME_SCRIPT_HEADER}"
        "-DSOURCE_DIR=${TN_RUNTIME_SCRIPT_DIR}"
        "-DSCRIPT_NAMES=${TN_RUNTIME_SCRIPT_NAMES}"
        -P "${CMAKE_CURRENT_SOURCE_DIR}/cmake/EmbedRuntimeScripts.cmake"
    DEPENDS
        "${CMAKE_CURRENT_SOURCE_DIR}/cmake/EmbedRuntimeScripts.cmake"
        ${TN_RUNTIME_SCRIPT_FILES}
    VERBATIM
)
add_custom_target(threenative-runtime-scripts DEPENDS "${TN_RUNTIME_SCRIPT_HEADER}")

if(TN_ENGINE_ONLY AND TN_ENGINE_PLAYER)
    include(cmake/NativeEngineAdapters.cmake)
    return()
endif()

# Android requires shared library for JNI/SDL loading
set(MYSTRAL_SOURCES
    src/runtime.cpp
    src/screenshot_gate.cpp
    src/workers/worker_registry.cpp
    src/workers/worker_thread.cpp
    src/js/engine_factory.cpp
    src/js/module_resolver.cpp
    src/js/module_system.cpp
    src/js/ts_transpiler.cpp
    src/webgpu/bindings.cpp
    src/webgpu/async_image_decode.cpp
    src/webgpu/bindings_canvas2d_composite.cpp
    src/webgpu/bindings_commands.cpp
    src/webgpu/bindings_frame_stream.cpp
    src/webgpu/bindings_pipelines.cpp
    src/webgpu/bindings_pipeline_cache.cpp
    src/webgpu/pipeline_cache.cpp
    src/webgpu/bindings_presentation.cpp
    src/webgpu/presentation.cpp
    src/webgpu/bindings_ui_composite.cpp
    src/webgpu/bindings_resources.cpp
    src/webgpu/bindings_screenshot.cpp
    src/webgpu/registration_table.cpp
    src/webgpu/wrapper_factories.cpp
    src/webgpu/checked_handle.cpp
    src/webgpu/context.cpp
    src/platform/window.cpp
    src/platform/input.cpp
    src/platform/crash_handlers.cpp
    src/platform/lifecycle.cpp
    src/platform/ui_overlay.cpp
    src/utils/stb_impl.cpp
    src/http/http_client.cpp
    src/http/async_http_client.cpp
    src/webtransport/webtransport.cpp
    src/fs/async_file.cpp
    src/fs/file_watcher.cpp
    src/audio/audio_context.cpp
    src/audio/audio_bindings.cpp
    src/audio/async_audio_decode.cpp
    src/audio/vorbis_impl.c
    src/vfs/embedded_bundle.cpp
    src/storage/local_storage.cpp
    src/async/event_loop.cpp
)

if(TN_ENABLE_NATIVE_PHYSICS)
    list(APPEND MYSTRAL_SOURCES src/physics/native_bindings.cpp)
endif()

if(TN_ENABLE_METAHUMAN)
    # OpenRigLogic is reconstructed as pinned source by
    # `node scripts/download-deps.mjs --only openriglogic`, which extracts GitHub's
    # commit archive as `OpenRigLogic-<revision>`. Read the revision back out of that
    # directory name instead of carrying a second copy of the pin: the version string the
    # binding reports is then the revision that was actually compiled.
    file(GLOB THREENATIVE_OPENRIGLOGIC_ROOTS
        "${THIRD_PARTY_DIR}/openriglogic/OpenRigLogic-*")
    list(LENGTH THREENATIVE_OPENRIGLOGIC_ROOTS THREENATIVE_OPENRIGLOGIC_ROOT_COUNT)
    if(NOT THREENATIVE_OPENRIGLOGIC_ROOT_COUNT EQUAL 1)
        message(FATAL_ERROR
            "TN_ENABLE_METAHUMAN needs exactly one OpenRigLogic source tree under "
            "'${THIRD_PARTY_DIR}/openriglogic' (found ${THREENATIVE_OPENRIGLOGIC_ROOT_COUNT}). "
            "Run node scripts/download-deps.mjs --only openriglogic.")
    endif()
    list(GET THREENATIVE_OPENRIGLOGIC_ROOTS 0 OPENRIGLOGIC_SOURCE_DIR)
    if(NOT EXISTS "${OPENRIGLOGIC_SOURCE_DIR}/CMakeLists.txt")
        message(FATAL_ERROR
            "OpenRigLogic source at ${OPENRIGLOGIC_SOURCE_DIR} has no CMakeLists.txt. "
            "Re-run node scripts/download-deps.mjs --only openriglogic --force.")
    endif()
    # CMake's regex has no interval quantifier, so the revision is split and measured rather
    # than matched with {40}.
    get_filename_component(OPENRIGLOGIC_SOURCE_NAME "${OPENRIGLOGIC_SOURCE_DIR}" NAME)
    string(REGEX REPLACE "^OpenRigLogic-" "" THREENATIVE_OPENRIGLOGIC_COMMIT
        "${OPENRIGLOGIC_SOURCE_NAME}")
    string(LENGTH "${THREENATIVE_OPENRIGLOGIC_COMMIT}" THREENATIVE_OPENRIGLOGIC_REVISION_LENGTH)
    if(NOT THREENATIVE_OPENRIGLOGIC_REVISION_LENGTH EQUAL 40 OR
       NOT THREENATIVE_OPENRIGLOGIC_COMMIT MATCHES "^[0-9a-f]+$")
        message(FATAL_ERROR
            "OpenRigLogic source directory ${OPENRIGLOGIC_SOURCE_DIR} does not carry a 40-hex "
            "revision, so the ABI version string could not name the pin that was built.")
    endif()
    # Scalar, no SIMD, no test/benchmark/example trees: the shared ABI in
    # packages/metahuman/cpp fixes that configuration because the committed reference
    # vectors and the browser WASM build were produced with it.
    set(RL_BUILD_WITH_AVX OFF CACHE BOOL "" FORCE)
    set(RL_AUTODETECT_AVX OFF CACHE BOOL "" FORCE)
    set(RL_BUILD_TESTS OFF CACHE BOOL "" FORCE)
    set(RL_BUILD_BENCHMARKS OFF CACHE BOOL "" FORCE)
    set(RL_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
    set(RL_LIBRARY_TYPE STATIC CACHE STRING "" FORCE)
    # The generated version/export headers are committed upstream; regenerating them would
    # write into a tree this build does not own.
    set(READ_ONLY_SOURCE_TREE ON CACHE BOOL "" FORCE)
    add_subdirectory("${OPENRIGLOGIC_SOURCE_DIR}"
        "${CMAKE_CURRENT_BINARY_DIR}/openriglogic" EXCLUDE_FROM_ALL)
    if(NOT TARGET riglogic4)
        message(FATAL_ERROR
            "OpenRigLogic at ${OPENRIGLOGIC_SOURCE_DIR} defined no riglogic4 target; the "
            "facial rig cannot be built.")
    endif()
    # C++17, the standard packages/metahuman/scripts/build-native-tools.mjs compiles the same
    # translation unit with, whatever this host's own CMAKE_CXX_STANDARD is.
    set_target_properties(riglogic4 PROPERTIES CXX_STANDARD 17)
    add_library(threenative-native-metahuman STATIC
        "${CMAKE_CURRENT_SOURCE_DIR}/../metahuman/cpp/tn_riglogic.cpp")
    set_target_properties(threenative-native-metahuman PROPERTIES CXX_STANDARD 17)
    target_compile_definitions(threenative-native-metahuman PUBLIC
        THREENATIVE_OPENRIGLOGIC_COMMIT="${THREENATIVE_OPENRIGLOGIC_COMMIT}")
    target_include_directories(threenative-native-metahuman PUBLIC
        "${CMAKE_CURRENT_SOURCE_DIR}/../metahuman/cpp")
    target_link_libraries(threenative-native-metahuman PUBLIC riglogic4)
    list(APPEND MYSTRAL_SOURCES src/metahuman/native_bindings.cpp)
endif()

if(TN_ENABLE_UI_OVERLAY)
    if(NOT THREENATIVE_UI_OVERLAY_LIBRARY)
        # MSVC names a static library `.lib`; every other desktop toolchain we build with names it
        # `lib*.a`. Guessing `.a` on Windows is the check that never matches the artifact the
        # build script just produced.
        if(WIN32)
            set(_tn_ui_overlay_name "threenative_ui_overlay.lib")
        else()
            set(_tn_ui_overlay_name "libthreenative_ui_overlay.a")
        endif()
        set(THREENATIVE_UI_OVERLAY_LIBRARY
            "${CMAKE_CURRENT_SOURCE_DIR}/native/ui-overlay/target/release/${_tn_ui_overlay_name}"
        )
    endif()
    if(NOT EXISTS "${THREENATIVE_UI_OVERLAY_LIBRARY}")
        message(FATAL_ERROR
            "UI overlay artifact is missing: ${THREENATIVE_UI_OVERLAY_LIBRARY}. "
            "Run node scripts/build-native-ui-overlay.mjs, or supply -DTHREENATIVE_UI_OVERLAY_LIBRARY."
        )
    endif()
    add_library(threenative-ui-overlay STATIC IMPORTED)
    set_target_properties(threenative-ui-overlay PROPERTIES
        IMPORTED_LOCATION "${THREENATIVE_UI_OVERLAY_LIBRARY}"
    )
endif()

if(TN_ENABLE_CSS_UI)
    if(NOT THREENATIVE_CSS_UI_LIBRARY)
        # The same naming rule as the overlay above: MSVC writes `.lib`, every other desktop
        # toolchain this host is built with writes `lib*.a`.
        if(WIN32)
            set(_tn_css_ui_name "threenative_css_ui.lib")
        else()
            set(_tn_css_ui_name "libthreenative_css_ui.a")
        endif()
        # Android cross-builds land in cargo's per-triple directory, one per ABI
        # (`scripts/build-native-css-ui.mjs --target <triple>`), like native physics.
        if(ANDROID_ABI STREQUAL "arm64-v8a")
            set(_tn_css_ui_dir "aarch64-linux-android/release")
        elseif(ANDROID_ABI STREQUAL "x86_64")
            set(_tn_css_ui_dir "x86_64-linux-android/release")
        elseif(ANDROID)
            message(FATAL_ERROR "The CSS UI has no Android target for ABI ${ANDROID_ABI}")
        else()
            set(_tn_css_ui_dir "release")
        endif()
        set(THREENATIVE_CSS_UI_LIBRARY
            "${CMAKE_CURRENT_SOURCE_DIR}/native/css-ui/target/${_tn_css_ui_dir}/${_tn_css_ui_name}"
        )
    endif()
    if(NOT EXISTS "${THREENATIVE_CSS_UI_LIBRARY}")
        message(FATAL_ERROR
            "CSS UI artifact is missing: ${THREENATIVE_CSS_UI_LIBRARY}. "
            "Run node scripts/build-native-css-ui.mjs, or supply -DTHREENATIVE_CSS_UI_LIBRARY."
        )
    endif()
    add_library(threenative-css-ui STATIC IMPORTED)
    set_target_properties(threenative-css-ui PROPERTIES
        IMPORTED_LOCATION "${THREENATIVE_CSS_UI_LIBRARY}"
    )
endif()

# Canvas2D sources provide no-Skia stubs when MYSTRAL_HAS_SKIA is absent.
# Keep them linked even when TN_ENABLE_CANVAS2D=OFF because WebGPU bindings expose
# browser-shaped canvas methods that reference these symbols.
list(APPEND MYSTRAL_SOURCES
    src/canvas/canvas2d.cpp
    src/canvas/canvas2d_bindings.cpp
)

if(TN_ENABLE_DEBUG_SERVER)
    list(APPEND MYSTRAL_SOURCES src/debug/debug_server.cpp)
endif()

if(TN_ENABLE_VIDEO)
    list(APPEND MYSTRAL_SOURCES
        src/video/async_capture.cpp
        src/video/video_recorder.cpp
        src/video/gpu_readback_recorder.cpp
    )
endif()

# The common factory and JavaScript bindings are always built so every native preset exposes the
# same honest unavailable surface. Hardware backends remain opt-in and conditional below.
list(APPEND MYSTRAL_SOURCES
    src/raytracing/rt_common.cpp
    src/raytracing/bindings.cpp
)

if(MYSTRAL_USE_RAYTRACING)
    # Add Vulkan RT backend if Vulkan is available
    if(Vulkan_FOUND)
        list(APPEND MYSTRAL_SOURCES
            src/raytracing/vulkan_rt.cpp
        )
    endif()

    # Add Metal RT backend on Apple platforms
    if(METAL_RT_ENABLED)
        list(APPEND MYSTRAL_SOURCES
            src/raytracing/metal_rt.mm
        )
    endif()

    # Add DXR backend on Windows
    if(WIN32)
        list(APPEND MYSTRAL_SOURCES
            src/raytracing/dxr_rt.cpp
        )
        add_compile_definitions(MYSTRAL_HAS_DXR)
        message(STATUS "DXR ray tracing backend enabled")
    endif()
endif()

if(ANDROID)
    add_library(mystral-runtime SHARED ${MYSTRAL_SOURCES})
    # Android 15 and later can run with 16 KB memory pages, and a shared library whose LOAD
    # segments are aligned to the older 4 KB cannot be loaded there at all. The system says so
    # ahead of time, on a device still running 4 KB pages, with a modal "Android App
    # Compatibility" dialog over the game naming each offending library — which covers the whole
    # screen, so a blind `adb shell screencap` captures the dialog rather than the frame.
    #
    # NDK 27 does not pass this by default; NDK 28 does. Setting it here rather than waiting for
    # the toolchain keeps the alignment a property of this build.
    target_link_options(mystral-runtime PRIVATE "LINKER:-z,max-page-size=16384")
else()
    add_library(mystral-runtime STATIC ${MYSTRAL_SOURCES})
endif()

target_include_directories(mystral-runtime PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)

target_include_directories(mystral-runtime PRIVATE
    ${THIRD_PARTY_DIR}/stb
    "${CMAKE_CURRENT_BINARY_DIR}/generated"
)
add_dependencies(mystral-runtime threenative-runtime-scripts)

# Pass build configuration to source code
# Determine JS engine name
if(MYSTRAL_USE_V8)
    set(MYSTRAL_JS_ENGINE_NAME "v8")
elseif(MYSTRAL_USE_JSC)
    set(MYSTRAL_JS_ENGINE_NAME "jsc")
else()
    set(MYSTRAL_JS_ENGINE_NAME "quickjs")
endif()

# Determine WebGPU backend name
if(MYSTRAL_USE_DAWN)
    set(MYSTRAL_WEBGPU_NAME "dawn")
else()
    set(MYSTRAL_WEBGPU_NAME "wgpu-native")
endif()

target_compile_definitions(mystral-runtime PUBLIC
    MYSTRAL_VERSION="${PROJECT_VERSION}"
    MYSTRAL_JS_ENGINE="${MYSTRAL_JS_ENGINE_NAME}"
    MYSTRAL_WEBGPU_BACKEND="${MYSTRAL_WEBGPU_NAME}"
)

include(cmake/PipelineCacheIdentity.cmake)

if(TN_ENABLE_CSS_UI)
    # Pure Rust with no system dependency, so this is the whole link: no framework, no `pkg-config`
    # package, nothing a system needs installing. That is the reason this backend exists.
    target_link_libraries(mystral-runtime PRIVATE threenative-css-ui)
endif()

if(TN_ENABLE_UI_OVERLAY)
    target_link_libraries(mystral-runtime PRIVATE threenative-ui-overlay)
    if(APPLE)
        # The Rust staticlib reaches the system WebKit and AppKit, which the C++ link has to name
        # because the Rust build leaves framework symbols unresolved.
        target_link_libraries(mystral-runtime PRIVATE
            "-framework WebKit"
            "-framework AppKit"
            "-framework Foundation"
            "-framework CoreFoundation"
        )
    elseif(WIN32)
        # WebView2 is reached through `WebView2Loader`, whose import library `webview2-com-sys`
        # copies into its OUT_DIR rather than publishing. Find it in the crate's build output and
        # name it, plus the Win32 libraries a wry/WebView2 staticlib leaves unresolved.
        file(GLOB TN_WEBVIEW2LOADER_DIRS
            "${CMAKE_CURRENT_SOURCE_DIR}/native/ui-overlay/target/release/build/webview2-com-sys-*/out/x64"
        )
        find_path(TN_WEBVIEW2LOADER_DIR NAMES WebView2LoaderStatic.lib
            PATHS ${TN_WEBVIEW2LOADER_DIRS})
        if(NOT TN_WEBVIEW2LOADER_DIR)
            message(FATAL_ERROR
                "WebView2LoaderStatic.lib was not found under native/ui-overlay/target. "
                "Build the overlay with scripts/build-native-ui-overlay.mjs before configuring."
            )
        endif()
        # The full path, PUBLIC so it reaches the `mystral` executable: a PRIVATE link directory
        # on a static library never propagates, and the exe is where the import library is
        # actually consumed.
        target_link_libraries(mystral-runtime PUBLIC
            "${TN_WEBVIEW2LOADER_DIR}/WebView2LoaderStatic.lib"
            user32 gdi32 ole32 oleaut32 advapi32 shell32 shlwapi userenv ntdll
        )
    else()
        # webkit2gtk and its GTK stack come from the system, the same way the game's SDL does.
        find_package(PkgConfig REQUIRED)
        pkg_check_modules(TN_WEBKITGTK REQUIRED IMPORTED_TARGET webkit2gtk-4.1)
        target_link_libraries(mystral-runtime PRIVATE PkgConfig::TN_WEBKITGTK)
    endif()
endif()

if(UNIX AND NOT APPLE AND NOT ANDROID)
    # `window.cpp` paints the window's X background with the game's `bootSplash.backgroundColor`
    # before the first GPU present, which is two direct Xlib calls. SDL reaches X11 through its own
    # dynamic loading and publishes no such API, so the link has to name X11 itself.
    find_package(X11 REQUIRED)
    target_link_libraries(mystral-runtime PRIVATE X11::X11)
endif()


if(TN_ENABLE_NATIVE_PHYSICS)
    target_link_libraries(mystral-runtime PRIVATE threenative-native-physics)
    # Both native physics and Android wgpu-native are Rust staticlibs and therefore carry
    # the same Rust runtime symbols. They are built with the same pinned NDK/toolchain;
    # keep one definition at the final shared-library link.
    if(ANDROID AND MYSTRAL_USE_WGPU)
        target_link_options(mystral-runtime PRIVATE "LINKER:--allow-multiple-definition")
    endif()
endif()

if(TN_ENABLE_METAHUMAN)
    target_link_libraries(mystral-runtime PRIVATE threenative-native-metahuman)
endif()

# Platform-specific sources
if(APPLE)
    target_sources(mystral-runtime PRIVATE
        src/platform/surface_metal.mm
        src/video/screen_capture_kit.mm
    )
    if(MYSTRAL_USE_JSC)
        target_sources(mystral-runtime PRIVATE src/js/jsc_engine.mm)
        target_link_libraries(mystral-runtime PRIVATE ${JAVASCRIPTCORE_FRAMEWORK})
    endif()
    # ScreenCaptureKit for video recording (macOS 12.3+)
    # Note: Framework is weakly linked for backward compatibility with older macOS
    if(NOT MYSTRAL_PLATFORM STREQUAL "ios")
        target_link_libraries(mystral-runtime PRIVATE
            "-weak_framework ScreenCaptureKit"
            "-framework AVFoundation"
            "-framework CoreMedia"
            "-framework CoreVideo"
        )
    endif()
elseif(WIN32)
    target_link_libraries(mystral-runtime PRIVATE
        d3d11.lib
        dxgi.lib
    )
    if(TN_ENABLE_VIDEO)
        target_sources(mystral-runtime PRIVATE
            src/video/windows_graphics_capture.cpp
            src/video/windows_graphics_capture_impl.cpp
        )
        # Windows.Graphics.Capture uses C++/WinRT, plus Media Foundation for H.264.
        target_link_libraries(mystral-runtime PRIVATE
            mfplat.lib
            mfuuid.lib
            mfreadwrite.lib
            RuntimeObject.lib
        )
        # C++/WinRT's coroutines. `/await` is the pre-C++20 mode and selects
        # `<experimental/coroutine>`, which under `/std:c++20` static-asserts with "Standard C++
        # coroutines are available by default in C++20 or later" — so passing it alongside C++20
        # failed `windows_graphics_capture_impl.cpp`, and with it every target that links
        # `mystral-runtime`. C++20 needs no flag at all.
        if(MSVC AND CMAKE_CXX_STANDARD LESS 20)
            target_compile_options(mystral-runtime PRIVATE /await)
        endif()
    endif()
elseif(ANDROID)
    target_sources(mystral-runtime PRIVATE
        src/platform/surface_android.cpp
        src/platform/android_main.cpp
    )
endif()

find_program(TN_NODE_EXECUTABLE node REQUIRED)
execute_process(
    COMMAND "${TN_NODE_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/scripts/check-source-list.mjs"
    WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}"
    RESULT_VARIABLE TN_SOURCE_LIST_RESULT
    OUTPUT_VARIABLE TN_SOURCE_LIST_OUTPUT
    ERROR_VARIABLE TN_SOURCE_LIST_ERROR
    OUTPUT_STRIP_TRAILING_WHITESPACE
    ERROR_STRIP_TRAILING_WHITESPACE
)
if(NOT TN_SOURCE_LIST_RESULT EQUAL 0)
    message(FATAL_ERROR
        "TN_NATIVE_SOURCE_LIST_FAILED: ${TN_SOURCE_LIST_OUTPUT}${TN_SOURCE_LIST_ERROR}")
endif()

# JS engine linkage
if(MYSTRAL_USE_QUICKJS AND TARGET quickjs)
    target_sources(mystral-runtime PRIVATE src/js/quickjs_engine.cpp)
    target_link_libraries(mystral-runtime PRIVATE quickjs)
endif()

if(MYSTRAL_USE_V8 AND TARGET v8::v8)
    target_sources(mystral-runtime PRIVATE src/js/v8_engine.cpp)
    # V8 requires C++20 - force it at target level for MSVC
    # MSVC needs /Zc:__cplusplus to report the correct __cplusplus value
    # (V8 checks __cplusplus <= 201703L which fails without this flag)
    if(MSVC)
        target_compile_options(mystral-runtime PRIVATE /std:c++20 /Zc:__cplusplus)
    else()
        target_compile_features(mystral-runtime PRIVATE cxx_std_20)
    endif()
    # On macOS with Dawn, V8 is linked specially in the Dawn section with -force_load
    # to handle Abseil symbol conflicts. Skip normal linking here but keep include dirs.
    if(APPLE AND MYSTRAL_USE_DAWN)
        # Only add include directories, actual linking happens in Dawn section
        target_include_directories(mystral-runtime PRIVATE ${V8_INCLUDE_DIR})
    else()
        target_link_libraries(mystral-runtime PRIVATE v8::v8)
    endif()
    if(APPLE)
        target_link_libraries(mystral-runtime PRIVATE ${COREFOUNDATION_FRAMEWORK})
    elseif(V8_SYSTEM_LIBS)
        target_link_libraries(mystral-runtime PRIVATE ${V8_SYSTEM_LIBS})
    endif()
endif()

# SDL3 linkage - prefer static target for single-binary distribution
if(SDL3_STATIC_TARGET)
    target_link_libraries(mystral-runtime PRIVATE ${SDL3_STATIC_TARGET})
    message(STATUS "Linking SDL3 statically via ${SDL3_STATIC_TARGET}")
elseif(TARGET SDL3::SDL3-static)
    target_link_libraries(mystral-runtime PRIVATE SDL3::SDL3-static)
elseif(TARGET SDL3::SDL3)
    target_link_libraries(mystral-runtime PRIVATE SDL3::SDL3)
elseif(SDL3_LIBRARY)
    target_link_libraries(mystral-runtime PRIVATE ${SDL3_LIBRARY})
    target_include_directories(mystral-runtime PRIVATE ${SDL3_INCLUDE_DIR})
endif()

# WebGPU linkage
if(MYSTRAL_USE_WGPU AND TARGET wgpu::wgpu)
    # wgpu-native is a Rust library. If SWC (also Rust) is enabled, they share
    # Rust runtime symbols. On macOS, use -force_load on wgpu to ensure its symbols
    # are used first, then swc's duplicates will be ignored.
    if(APPLE AND TARGET swc::swc)
        get_target_property(WGPU_LOCATION wgpu::wgpu IMPORTED_LOCATION)
        get_target_property(WGPU_INCLUDES wgpu::wgpu INTERFACE_INCLUDE_DIRECTORIES)
        target_include_directories(mystral-runtime PRIVATE ${WGPU_INCLUDES})
        target_link_libraries(mystral-runtime PRIVATE
            "-Wl,-force_load,${WGPU_LOCATION}"
        )
        target_link_options(mystral-runtime PUBLIC "-Wl,-dead_strip")
    else()
        target_link_libraries(mystral-runtime PRIVATE wgpu::wgpu)
    endif()
endif()

if(MYSTRAL_USE_DAWN AND TARGET dawn::webgpu)
    # Dawn and V8 both include Abseil library, causing duplicate symbol errors.
    # On macOS, we need to handle the link order and flags carefully.
    if(APPLE AND MYSTRAL_USE_V8)
        # Use -force_load for V8 to ensure its Abseil symbols are loaded first,
        # then link Dawn normally. The linker will use the first definition.
        # We also suppress the deprecated -ld_classic warning and use -dead_strip
        # to remove unused duplicate symbols.
        get_target_property(V8_LOCATION v8::v8 IMPORTED_LOCATION)
        target_link_libraries(mystral-runtime PRIVATE
            "-Wl,-force_load,${V8_LOCATION}"
        )
        # Link Dawn after V8 - its duplicate symbols will be ignored
        target_link_libraries(mystral-runtime PRIVATE dawn::webgpu)
        target_link_options(mystral-runtime PUBLIC "-Wl,-dead_strip")
    else()
        target_link_libraries(mystral-runtime PRIVATE dawn::webgpu)
    endif()

    # Dawn requires additional dependencies
    if(APPLE)
        target_link_libraries(mystral-runtime PRIVATE
            "-framework IOKit"
            "-framework IOSurface"
        )
    elseif(WIN32)
        # Dawn D3D11/D3D12 SharedFence uses CompareObjectHandles from kernelbase.
        if(MSVC)
            target_link_libraries(mystral-runtime PUBLIC OneCoreUap.lib)
        else()
            target_link_libraries(mystral-runtime PUBLIC api-ms-win-core-handle-l1-1-0)
        endif()
        # Prebuilt Rust and Abseil archives carry overlapping runtime symbols.
        if(MSVC)
            target_link_options(mystral-runtime PUBLIC "/FORCE:MULTIPLE")
        else()
            target_link_options(mystral-runtime PUBLIC "-Wl,--allow-multiple-definition")
        endif()
    elseif(UNIX)
        # Dawn and V8 both include Abseil library, causing multiple definition errors.
        # Allow multiple definitions to resolve this conflict.
        if(MYSTRAL_USE_V8)
            target_link_options(mystral-runtime PUBLIC "-Wl,--allow-multiple-definition")
        endif()
    endif()
    # Note: Linux Dawn builds require Ubuntu 24.04+ (GCC 13+) for proper libstdc++ ABI
endif()

# wgpu-native and SWC are both Rust staticlibs, and each carries its own `rust_eh_personality`.
# The `mystral` executable already names that pairing and already opts out of the error for it; the
# runtime did not, so anything else linking the runtime in a wgpu build directory failed with
#   libswc.a(std-...rcgu.o): in function `rust_eh_personality':
#   multiple definition of `rust_eh_personality';
#   libwgpu_native.a(std-...rcgu.o): first defined here
# That is why "contract tests only link in build/tn-linux" was true, and it made wgpu-native — the
# backend Android ships — the one backend no contract test could be run against. PUBLIC so every
# consumer inherits it rather than each target restating it.
# The desktop UI overlay is a Rust staticlib too, so it collides with wgpu-native the same way
# whenever SWC is absent (the Linux arm64 QuickJS + wgpu host builds no SWC).
if(MYSTRAL_USE_WGPU AND (SWC_LIBRARY OR TN_ENABLE_UI_OVERLAY) AND UNIX AND NOT APPLE)
    target_link_options(mystral-runtime PUBLIC "-Wl,--allow-multiple-definition")
endif()

# Platform libraries
if(APPLE)
    target_link_libraries(mystral-runtime PRIVATE
        "-framework Metal"
        "-framework QuartzCore"
    )
    if(MYSTRAL_PLATFORM STREQUAL "ios")
        target_link_libraries(mystral-runtime PRIVATE
            "-framework UIKit"
            "-framework Foundation"
        )
    else()
        target_link_libraries(mystral-runtime PRIVATE
            "-framework Cocoa"
        )
    endif()
elseif(WIN32)
    target_link_libraries(mystral-runtime PRIVATE
        d3d12
        dxgi
        dxguid
    )
elseif(ANDROID)
    # Android NDK libraries
    target_link_libraries(mystral-runtime PRIVATE
        android        # ANativeWindow, AAssetManager
        log            # __android_log_print
        GLESv3         # OpenGL ES (required by wgpu-native)
        EGL            # EGL (required by wgpu-native)
    )
endif()

# HTTP client dependencies (libcurl + zlib)
# Note: These must be PUBLIC because mystral-runtime is a static library
# and the final executables need these dependencies to link correctly on Linux
# On iOS/Android, HTTP is handled by the OS (NSURLSession / HttpURLConnection)
if(MYSTRAL_PLATFORM STREQUAL "ios")
    # iOS uses Foundation/NSURLSession for HTTP
    add_compile_definitions(MYSTRAL_HTTP_FOUNDATION)
elseif(MYSTRAL_PLATFORM STREQUAL "android")
    # Android uses Java HttpURLConnection via JNI
    add_compile_definitions(MYSTRAL_HTTP_ANDROID)
else()
    # Desktop platforms use libcurl
    find_package(CURL REQUIRED)
    find_package(ZLIB REQUIRED)
    target_link_libraries(mystral-runtime PUBLIC CURL::libcurl ZLIB::ZLIB)
    message(STATUS "Found CURL: ${CURL_LIBRARIES}")
    message(STATUS "Found ZLIB: ${ZLIB_LIBRARIES}")
endif()

# libwebp linkage (optional - for WebP texture support and video recording)
# Note: Link order matters on Linux! The GNU linker processes libraries left-to-right.
# Libraries that USE symbols must come BEFORE libraries that PROVIDE those symbols.
# Dependency chain: webpmux -> webp -> sharpyuv
# So the correct order is: webpmux, webp, sharpyuv (reverse of dependency direction)
if(TARGET webp::webp)
    # Link webpmux first (depends on webp)
    if(TARGET webp::mux)
        target_link_libraries(mystral-runtime PRIVATE webp::mux)
    endif()
    # Link webp core (depends on sharpyuv)
    target_link_libraries(mystral-runtime PRIVATE webp::webp)
    # Link sharpyuv last (provides SharpYuv* symbols used by webp)
    if(TARGET webp::sharpyuv)
        target_link_libraries(mystral-runtime PRIVATE webp::sharpyuv)
    endif()
endif()

# Skia linkage (optional - for Canvas 2D support)
if(TARGET skia::skia)
    target_link_libraries(mystral-runtime PRIVATE skia::skia)
    if(CMAKE_SYSTEM_NAME STREQUAL "Linux" AND NOT ANDROID)
        find_package(Fontconfig REQUIRED)
        find_package(Freetype REQUIRED)
        target_link_libraries(mystral-runtime PRIVATE Fontconfig::Fontconfig Freetype::Freetype)
    endif()
endif()

# SWC linkage (TypeScript transpiler)
if(TARGET swc::swc)
    # Must be PUBLIC so dependents of the static runtime link SWC too.
    target_link_libraries(mystral-runtime PUBLIC swc::swc)
    # SWC (Rust) on Windows needs these system libraries
    if(WIN32)
        target_link_libraries(mystral-runtime PUBLIC userenv ntdll)
    endif()
endif()

# libuv linkage (async I/O - non-blocking HTTP, file I/O, timers)
if(TARGET libuv::libuv)
    target_link_libraries(mystral-runtime PUBLIC libuv::libuv)
    # libuv requires platform-specific system libraries
    if(LIBUV_SYSTEM_LIBS)
        target_link_libraries(mystral-runtime PUBLIC ${LIBUV_SYSTEM_LIBS})
    endif()
endif()

# quiche linkage (QUIC/HTTP3 for WebTransport). The static lib bundles BoringSSL;
# the Rust staticlib additionally needs a few platform system libraries.
if(TARGET quiche::quiche)
    target_link_libraries(mystral-runtime PUBLIC quiche::quiche)
    if(APPLE)
        target_link_libraries(mystral-runtime PUBLIC
            "-framework Security"
            "-framework CoreFoundation"
            "-framework SystemConfiguration")
    elseif(WIN32)
        # Sockets (WebTransport UDP) + system libs required by BoringSSL on Windows.
        target_link_libraries(mystral-runtime PUBLIC ws2_32 advapi32 crypt32 bcrypt userenv ntdll)
    elseif(ANDROID)
        # bionic folds pthread and dl into libc, so there is no `-lpthread` for the linker to find.
        # Android matches `UNIX` in CMake, so it has to be answered before that branch.
        target_link_libraries(mystral-runtime PUBLIC m)
    elseif(UNIX)
        target_link_libraries(mystral-runtime PUBLIC pthread dl m)
    endif()
endif()

# Vulkan linkage (for Vulkan RT backend)
if(MYSTRAL_USE_RAYTRACING AND Vulkan_FOUND)
    target_include_directories(mystral-runtime PRIVATE ${Vulkan_INCLUDE_DIR})
    target_link_libraries(mystral-runtime PRIVATE ${Vulkan_LIBRARY})
endif()

# DXR linkage (for DXR RT backend on Windows)
if(MYSTRAL_USE_RAYTRACING AND WIN32)
    # DXR requires D3D12 (already linked above) and dxcompiler for runtime shader compilation
    # dxcompiler.dll ships with Windows 10 1903+ and is in the DirectX SDK
    target_link_libraries(mystral-runtime PRIVATE dxcompiler.lib)
endif()

# ============================================================================
# CLI Executable (desktop only)
# ============================================================================

if(NOT MYSTRAL_PLATFORM STREQUAL "ios" AND NOT MYSTRAL_PLATFORM STREQUAL "android")
    add_executable(mystral
        src/cli/main.cpp
        src/cli/tool_dispatch.cpp
    )
    # SDL3's Linux tray loads GTK at run time and keeps two of its entry points in same-named
    # globals — `g_object_ref` and `g_object_ref_sink`, as pointers in BSS. Statically linked, those
    # common symbols satisfy the UI overlay's own references to the real GObject functions, and
    # `gtk_init` then calls a null pointer. SDL globs its tray sources with no option to decline
    # them and `third_party/` is reconstructed by `download-deps` rather than patched, so the two
    # names are rewritten in the one object file that defines them, after SDL builds and before
    # anything links against it. SDL's tray keeps working: it refers to them by the same names
    # inside that object, and the rename moves both the definitions and the references together.
    if(TN_ENABLE_UI_OVERLAY AND UNIX AND NOT APPLE)
        find_program(TN_OBJCOPY NAMES objcopy llvm-objcopy)
        if(NOT TN_OBJCOPY)
            message(FATAL_ERROR
                "objcopy is required to build the desktop UI overlay: SDL3's tray defines "
                "g_object_ref and g_object_ref_sink as globals that would shadow GObject's."
            )
        endif()
        # One ordered step, not PRE_LINK on `mystral`: the rewrite edits libSDL3.a in place, and a
        # PRE_LINK hook ran while `mystral-tools` and the contract tests linked that same archive in
        # parallel ("libSDL3.a: error adding symbols: no more archived files"). A custom target that
        # depends on SDL and that `mystral-runtime` depends on puts every executable linking the
        # runtime after the rewrite. `add_custom_command(TARGET)` cannot reach SDL's own target (it
        # lives in SDL's subdirectory), so the stamp tracks SDL's archive instead and re-applies the
        # rename whenever SDL is rebuilt; the stamp is touched last so an unchanged SDL skips it.
        # The working directory is made at configure time: a command cannot create the directory
        # its shell has to enter first.
        file(MAKE_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/tn-sdl-tray")
        set(TN_SDL_TRAY_STAMP "${CMAKE_CURRENT_BINARY_DIR}/tn-sdl-tray/renamed.stamp")
        add_custom_command(OUTPUT "${TN_SDL_TRAY_STAMP}"
            COMMAND "${CMAKE_AR}" x "$<TARGET_FILE:SDL3-static>" SDL_tray.c.o
            COMMAND "${TN_OBJCOPY}"
                --redefine-sym g_object_ref=tn_sdl_tray_g_object_ref
                --redefine-sym g_object_ref_sink=tn_sdl_tray_g_object_ref_sink
                SDL_tray.c.o SDL_tray.c.o
            COMMAND "${CMAKE_AR}" r "$<TARGET_FILE:SDL3-static>" SDL_tray.c.o
            COMMAND "${CMAKE_COMMAND}" -E touch "${TN_SDL_TRAY_STAMP}"
            DEPENDS SDL3-static
            WORKING_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/tn-sdl-tray"
            COMMENT "Renaming SDL3 tray's GObject globals so the UI overlay's GTK calls survive"
            VERBATIM
        )
        add_custom_target(tn-sdl-tray-rename DEPENDS "${TN_SDL_TRAY_STAMP}")
        add_dependencies(mystral-runtime tn-sdl-tray-rename)
    endif()

    target_link_libraries(mystral PRIVATE mystral-runtime)

    # Linux desktop only: put every function and datum in its own section so the link can drop
    # what the runtime never reaches. Android already carries section GC; macOS and Windows keep
    # their own dead-code story, so this is scoped to Linux.
    if(CMAKE_SYSTEM_NAME STREQUAL "Linux" AND NOT ANDROID)
        target_compile_options(mystral-runtime PRIVATE -ffunction-sections -fdata-sections)
        target_link_options(mystral PRIVATE -Wl,--gc-sections)
    endif()

    # Build-time tools stay out of the runtime executable that gets copied into compiled games.
    # The runtime CLI preserves `mystral compile` and `mystral bake` by dispatching to this
    # sibling helper at build time.
    add_executable(mystral-tools
        src/cli/tools_main.cpp
        src/cli/bundler.cpp
        src/cli/lightmap.cpp
    )
    target_link_libraries(mystral-tools PRIVATE mystral-runtime)

    # The desktop conformance lane's multitouch injector. It is a separate program rather than
    # part of the runtime because it must run *beside* a game, not inside one: it creates a
    # virtual touchscreen the kernel then delivers to whatever window has focus. Linux only —
    # uinput is a Linux kernel interface, and the other desktop platforms keep their existing
    # disposition rather than being silently covered by this result.
    if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
        add_executable(threenative-uinput-touch tools/uinput_touch_device.c)
    endif()

    add_executable(threenative-audio-graph-test EXCLUDE_FROM_ALL tests/audio_graph_test.cpp)
    target_link_libraries(threenative-audio-graph-test PRIVATE mystral-runtime)

    add_executable(threenative-audio-decode-promise-test EXCLUDE_FROM_ALL
        tests/audio_decode_promise_test.cpp)
    target_link_libraries(threenative-audio-decode-promise-test PRIVATE mystral-runtime)

    # The Ogg proof runs on a genuine Ogg Vorbis file rather than on bytes the test writes: an
    # "OggS" header a test assembles proves nothing about a decoder. The path is compiled in so
    # the executable needs no working directory to find it.
    add_executable(threenative-audio-decode-ogg-test EXCLUDE_FROM_ALL
        tests/audio_decode_ogg_test.cpp)
    target_link_libraries(threenative-audio-decode-ogg-test PRIVATE mystral-runtime)
    target_compile_definitions(threenative-audio-decode-ogg-test PRIVATE
        THREENATIVE_OGG_FIXTURE="${CMAKE_CURRENT_SOURCE_DIR}/tests/fixtures/pickup.ogg")

    add_executable(threenative-physics-actuation-bindings-test EXCLUDE_FROM_ALL
        tests/physics_actuation_bindings_test.cpp)
    target_link_libraries(threenative-physics-actuation-bindings-test PRIVATE mystral-runtime)

    if(TN_ENABLE_METAHUMAN)
        # The synthetic DNA and its reference vectors live in the package that owns the ABI
        # contract; the path is compiled in so the executable needs no working directory.
        add_executable(threenative-metahuman-bindings-test EXCLUDE_FROM_ALL
            tests/metahuman_bindings_test.cpp)
        target_link_libraries(threenative-metahuman-bindings-test PRIVATE mystral-runtime)
        target_include_directories(threenative-metahuman-bindings-test PRIVATE
            "${CMAKE_CURRENT_SOURCE_DIR}/src")
        target_compile_definitions(threenative-metahuman-bindings-test PRIVATE
            THREENATIVE_METAHUMAN_DNA="${CMAKE_CURRENT_SOURCE_DIR}/../metahuman/fixtures/synthetic.dna"
            THREENATIVE_METAHUMAN_VECTORS="${CMAKE_CURRENT_SOURCE_DIR}/../metahuman/fixtures/synthetic.vectors.json"
            THREENATIVE_METAHUMAN_REFERENCE="${CMAKE_CURRENT_SOURCE_DIR}/../metahuman/fixtures/synthetic.reference.json")
    endif()

    add_executable(threenative-dom-dispatch-lifetime-test EXCLUDE_FROM_ALL
        tests/dom_dispatch_lifetime_test.cpp)
    target_link_libraries(threenative-dom-dispatch-lifetime-test PRIVATE mystral-runtime)
    add_executable(threenative-worker-production-test EXCLUDE_FROM_ALL
        tests/worker_production_test.cpp)
    target_link_libraries(threenative-worker-production-test PRIVATE mystral-runtime)
    add_executable(threenative-canvas2d-dirty-test EXCLUDE_FROM_ALL
        tests/canvas2d_dirty_tracking_test.cpp)
    target_link_libraries(threenative-canvas2d-dirty-test PRIVATE mystral-runtime)

    add_executable(threenative-input-restart-test EXCLUDE_FROM_ALL
        tests/input_restart_test.cpp)
    target_link_libraries(threenative-input-restart-test PRIVATE mystral-runtime)

    add_executable(threenative-shutdown-lifetime-test EXCLUDE_FROM_ALL
        tests/shutdown_lifetime_test.cpp)
    target_link_libraries(threenative-shutdown-lifetime-test PRIVATE mystral-runtime)

    add_executable(threenative-bindings-creation-test EXCLUDE_FROM_ALL
        tests/bindings_creation_test.cpp)
    target_link_libraries(threenative-bindings-creation-test PRIVATE mystral-runtime)

    add_executable(threenative-device-pixel-ratio-test EXCLUDE_FROM_ALL
        tests/device_pixel_ratio_test.cpp)
    target_link_libraries(threenative-device-pixel-ratio-test PRIVATE mystral-runtime)

    # The `native-css` UI backend, as a contract on the host's own seam. Declared in every
    # configure, like the physics and MetaHuman bindings tests, so `verify-native-contracts.mjs`
    # can discover it: what it asserts depends on the option, and a lane with the backend absent
    # gets the refusal path rather than a target that cannot be built.
    add_executable(threenative-css-ui-overlay-test EXCLUDE_FROM_ALL
        tests/css_ui_overlay_test.cpp)
    target_link_libraries(threenative-css-ui-overlay-test PRIVATE mystral-runtime)

    add_executable(threenative-async-pipeline-thread-test EXCLUDE_FROM_ALL
        tests/async_pipeline_thread_test.cpp)
    target_link_libraries(threenative-async-pipeline-thread-test PRIVATE mystral-runtime)
    # This test calls the backend's async pipeline entry directly, so it needs the WebGPU header.
    # `mystral-runtime` links the backend PRIVATE, so its include directories do not propagate.
    #
    # It deliberately does NOT name the backend as a link dependency the way the rg11b10 oracle
    # does. That target puts Dawn ahead of the runtime for a Windows proc-table reason; doing the
    # same here puts `libwgpu_native.a` ahead of `libswc.a` on Linux, and both are Rust staticlibs
    # carrying their own `rust_eh_personality`:
    #   multiple definition of `rust_eh_personality'
    # The runtime already links the backend, so the entry points arrive without the reordering.
    if(MYSTRAL_USE_DAWN)
        target_include_directories(threenative-async-pipeline-thread-test PRIVATE
            ${DAWN_INCLUDE_DIR})
    elseif(MYSTRAL_USE_WGPU AND TARGET wgpu::wgpu)
        target_include_directories(threenative-async-pipeline-thread-test PRIVATE
            ${WGPU_INCLUDE_DIR})
    endif()

    add_executable(threenative-pipeline-cache-test EXCLUDE_FROM_ALL
        tests/pipeline_cache_test.cpp src/webgpu/pipeline_cache.cpp)

    add_executable(threenative-pipeline-cache-api-test EXCLUDE_FROM_ALL
        tests/pipeline_cache_api_test.cpp)
    target_link_libraries(threenative-pipeline-cache-api-test PRIVATE mystral-runtime)

    # Separate scope: Lavapipe only serializes a Vulkan header. This target proves actual
    # device/storage/lifetime behavior, NOT compiled-data population or cache benefit.
    # The strict API target above retains its >emptyBytes requirement unchanged.
    add_executable(threenative-pipeline-cache-lifecycle-test EXCLUDE_FROM_ALL
        tests/pipeline_cache_api_test.cpp)
    target_link_libraries(threenative-pipeline-cache-lifecycle-test PRIVATE mystral-runtime)
    target_compile_definitions(threenative-pipeline-cache-lifecycle-test PRIVATE
        TN_PIPELINE_CACHE_ENVELOPE_LIFECYCLE_ONLY=1)
    if(MYSTRAL_WGPU_PIPELINE_CACHE)
        target_compile_definitions(threenative-pipeline-cache-lifecycle-test PRIVATE
            MYSTRAL_WGPU_PIPELINE_CACHE=1)
        target_include_directories(threenative-pipeline-cache-lifecycle-test PRIVATE ${WGPU_INCLUDE_DIR})
    endif()

    # Same include-only rule as the async entry test above: the runtime already links the
    # backend, so naming it again reorders `libwgpu_native.a` ahead of `libswc.a` and collides
    # on `rust_eh_personality`. The patched `wgpu.h` cache declarations arrive via includes.
    if(MYSTRAL_USE_DAWN)
        target_include_directories(threenative-pipeline-cache-api-test PRIVATE
            ${DAWN_INCLUDE_DIR})
        target_include_directories(threenative-pipeline-cache-lifecycle-test PRIVATE ${DAWN_INCLUDE_DIR})
    elseif(MYSTRAL_USE_WGPU AND TARGET wgpu::wgpu)
        target_include_directories(threenative-pipeline-cache-api-test PRIVATE
            ${WGPU_INCLUDE_DIR})
        target_include_directories(threenative-pipeline-cache-lifecycle-test PRIVATE ${WGPU_INCLUDE_DIR})
    endif()

    add_executable(threenative-stall-budget-hitch-test EXCLUDE_FROM_ALL
        tests/stall_budget_hitch_test.cpp)
    target_link_libraries(threenative-stall-budget-hitch-test PRIVATE mystral-runtime)

    set(TN_EXPOSURE_FIXTURE "${CMAKE_CURRENT_SOURCE_DIR}/../create-threenative/__tests__/fixtures/auto-exposure")
    set(TN_EXPOSURE_BUNDLE "${CMAKE_CURRENT_BINARY_DIR}/generated/exposure-graph.js")
    add_custom_command(OUTPUT "${TN_EXPOSURE_BUNDLE}"
        COMMAND "${TN_NODE_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/scripts/bundle.mjs"
            --project "${CMAKE_CURRENT_SOURCE_DIR}/../create-threenative"
            --entry "__tests__/fixtures/auto-exposure/native-contract.ts"
            --target desktop --output "${TN_EXPOSURE_BUNDLE}"
        DEPENDS "${TN_EXPOSURE_FIXTURE}/native-contract.ts"
            "${CMAKE_CURRENT_SOURCE_DIR}/../create-threenative/template-assets/autoExposure.ts"
            "${CMAKE_CURRENT_SOURCE_DIR}/../create-threenative/template-assets/exposureGraph.ts"
            "${CMAKE_CURRENT_SOURCE_DIR}/../create-threenative/template-assets/exposureReadback.ts"
            "${CMAKE_CURRENT_SOURCE_DIR}/../create-threenative/template-assets/exposure.ts"
            "${CMAKE_CURRENT_SOURCE_DIR}/scripts/bundle.mjs"
            "${CMAKE_CURRENT_SOURCE_DIR}/../../pnpm-lock.yaml")
    add_executable(threenative-exposure-graph-test EXCLUDE_FROM_ALL
        tests/exposure_graph_test.cpp "${TN_EXPOSURE_BUNDLE}")
    target_link_libraries(threenative-exposure-graph-test PRIVATE mystral-runtime)
    target_compile_definitions(threenative-exposure-graph-test PRIVATE
        TN_EXPOSURE_GRAPH_BUNDLE="${TN_EXPOSURE_BUNDLE}")
    if(MYSTRAL_USE_DAWN)
        target_include_directories(threenative-exposure-graph-test PRIVATE ${DAWN_INCLUDE_DIR})
    elseif(MYSTRAL_USE_WGPU AND TARGET wgpu::wgpu)
        get_target_property(TN_EXPOSURE_WGPU_INCLUDES wgpu::wgpu INTERFACE_INCLUDE_DIRECTORIES)
        target_include_directories(threenative-exposure-graph-test PRIVATE ${TN_EXPOSURE_WGPU_INCLUDES})
    endif()

    add_executable(threenative-transient-attachments-test EXCLUDE_FROM_ALL
        tests/transient_attachments_test.cpp)
    target_link_libraries(threenative-transient-attachments-test PRIVATE mystral-runtime)
    if(MYSTRAL_USE_DAWN)
        target_include_directories(threenative-transient-attachments-test PRIVATE ${DAWN_INCLUDE_DIR})
    elseif(MYSTRAL_USE_WGPU AND TARGET wgpu::wgpu)
        target_include_directories(threenative-transient-attachments-test PRIVATE ${WGPU_INCLUDE_DIR})
    endif()

    add_executable(threenative-timestamp-query-test EXCLUDE_FROM_ALL
        tests/timestamp_query_test.cpp)
    target_link_libraries(threenative-timestamp-query-test PRIVATE mystral-runtime)

    add_executable(threenative-timer-delivery-test EXCLUDE_FROM_ALL
        tests/timer_delivery_test.cpp)
    target_link_libraries(threenative-timer-delivery-test PRIVATE mystral-runtime)

    add_executable(threenative-timer-engine-first-test EXCLUDE_FROM_ALL
        tests/timer_delivery_test.cpp)
    target_compile_definitions(threenative-timer-engine-first-test PRIVATE
        TN_TIMER_ENGINE_FIRST_TEST)
    target_link_libraries(threenative-timer-engine-first-test PRIVATE mystral-runtime)

    # WebTransport contracts. The wire test includes webtransport.cpp textually
    # because its helpers live in an anonymous namespace; it links quiche alone
    # — mystral-runtime already defines the same TU, and linking both would
    # duplicate every symbol. Both targets require quiche: without it the stub
    # installs a different script and has nothing to assert.
    if(TARGET quiche::quiche)
        add_executable(threenative-webtransport-wire-test EXCLUDE_FROM_ALL
            tests/webtransport_wire_test.cpp)
        target_include_directories(threenative-webtransport-wire-test PRIVATE
            ${CMAKE_CURRENT_SOURCE_DIR}/include
            ${CMAKE_CURRENT_BINARY_DIR}/generated)
        add_dependencies(threenative-webtransport-wire-test threenative-runtime-scripts)
        target_link_libraries(threenative-webtransport-wire-test PRIVATE quiche::quiche)
        if(WIN32)
            # quiche reads the Windows certificate store, so whoever links it needs the import
            # libraries for it. `mystral-runtime` links these PUBLIC and the surface test inherits
            # them through it; this target links quiche directly and has to name them itself, or
            # the link fails on __imp_CertOpenSystemStoreA and its neighbours.
            target_link_libraries(threenative-webtransport-wire-test PRIVATE
                ws2_32 advapi32 crypt32 bcrypt userenv ntdll)
        endif()
        tn_register_contract_test(threenative-webtransport-wire-test)

        add_executable(threenative-webtransport-surface-test EXCLUDE_FROM_ALL
            tests/webtransport_surface_test.cpp)
        target_link_libraries(threenative-webtransport-surface-test PRIVATE mystral-runtime)
        tn_register_contract_test(threenative-webtransport-surface-test)
    else()
        # Both targets are written down whether or not this machine downloaded quiche, and the
        # coverage lane discovers them by reading this file. Registering the reason keeps a
        # configure without quiche accounted for instead of silently short of two targets, the
        # same contract `tn_register_blocked_test` already carries for the video recorder.
        tn_register_blocked_test(threenative-webtransport-wire-test "quiche not found")
        tn_register_blocked_test(threenative-webtransport-surface-test "quiche not found")
    endif()

    add_executable(threenative-webgpu-bindings-reentrancy-test EXCLUDE_FROM_ALL
        tests/webgpu_bindings_reentrancy_test.cpp)
    target_link_libraries(threenative-webgpu-bindings-reentrancy-test PRIVATE mystral-runtime)
    if(TARGET skia::skia)
        target_link_libraries(threenative-webgpu-bindings-reentrancy-test PRIVATE skia::skia)
    endif()

    add_executable(threenative-handle-lifetime-test EXCLUDE_FROM_ALL
        tests/handle_lifetime_test.cpp)
    target_link_libraries(threenative-handle-lifetime-test PRIVATE mystral-runtime)
    add_executable(threenative-rt-handle-allocation-test EXCLUDE_FROM_ALL
        tests/rt_handle_allocation_test.cpp)
    target_include_directories(threenative-rt-handle-allocation-test PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/src)
    add_executable(threenative-js-engine-contract-test EXCLUDE_FROM_ALL
        tests/js_engine_contract_test.cpp)
    target_link_libraries(threenative-js-engine-contract-test PRIVATE mystral-runtime)
    add_executable(threenative-command-encoder-class-table-test EXCLUDE_FROM_ALL
        tests/command_encoder_class_table_test.cpp)
    target_link_libraries(threenative-command-encoder-class-table-test PRIVATE mystral-runtime)
    add_executable(threenative-render-pass-class-table-test EXCLUDE_FROM_ALL
        tests/render_pass_class_table_test.cpp)
    target_link_libraries(threenative-render-pass-class-table-test PRIVATE mystral-runtime)
    add_executable(threenative-frame-op-stream-replay-test EXCLUDE_FROM_ALL
        tests/frame_op_stream_replay_test.cpp)
    target_link_libraries(threenative-frame-op-stream-replay-test PRIVATE mystral-runtime)
    # The capture gate is self-contained on purpose: the ordering contract needs no display,
    # no GPU and no runtime to prove, so the test compiles the gate alone.
    add_executable(threenative-screenshot-capture-gate-test EXCLUDE_FROM_ALL
        tests/screenshot_capture_gate_test.cpp
        src/screenshot_gate.cpp)
    target_include_directories(threenative-screenshot-capture-gate-test PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/include)
    add_executable(threenative-shader-module-metadata-test EXCLUDE_FROM_ALL
        tests/shader_module_metadata_test.cpp)
    target_link_libraries(threenative-shader-module-metadata-test PRIVATE mystral-runtime)
    if(TN_ENABLE_VIDEO)
        add_executable(threenative-video-recorder-state-test EXCLUDE_FROM_ALL
            tests/video_recorder_state_test.cpp)
        target_link_libraries(threenative-video-recorder-state-test PRIVATE mystral-runtime)
    endif()
    if(MYSTRAL_USE_DAWN)
        target_include_directories(threenative-webgpu-bindings-reentrancy-test PRIVATE
            ${DAWN_INCLUDE_DIR})
        target_include_directories(threenative-shader-module-metadata-test PRIVATE
            ${DAWN_INCLUDE_DIR})
        target_include_directories(threenative-command-encoder-class-table-test PRIVATE
            ${DAWN_INCLUDE_DIR})
        target_include_directories(threenative-render-pass-class-table-test PRIVATE
            ${DAWN_INCLUDE_DIR})
        target_include_directories(threenative-frame-op-stream-replay-test PRIVATE
            ${DAWN_INCLUDE_DIR})
    elseif(MYSTRAL_USE_WGPU AND TARGET wgpu::wgpu)
        get_target_property(WGPU_TEST_INCLUDES wgpu::wgpu INTERFACE_INCLUDE_DIRECTORIES)
        target_include_directories(threenative-webgpu-bindings-reentrancy-test PRIVATE
            ${WGPU_TEST_INCLUDES})
        target_include_directories(threenative-shader-module-metadata-test PRIVATE
            ${WGPU_TEST_INCLUDES})
        target_include_directories(threenative-command-encoder-class-table-test PRIVATE
            ${WGPU_TEST_INCLUDES})
        target_include_directories(threenative-render-pass-class-table-test PRIVATE
            ${WGPU_TEST_INCLUDES})
        target_include_directories(threenative-frame-op-stream-replay-test PRIVATE
            ${WGPU_TEST_INCLUDES})
    endif()

    # POSIX only: the test drives `sigaction` and `siginfo_t` directly, and MSVC provides
    # neither. The Windows host installs a different crash handler, so this contract does not
    # exist there rather than being skipped; `verify-native-contracts.mjs` records the same
    # platform list, because it fails closed on a contract with no target.
    if(NOT WIN32)
        add_executable(threenative-crash-handler-policy-test EXCLUDE_FROM_ALL
            tests/crash_handler_policy_test.cpp)
        target_link_libraries(threenative-crash-handler-policy-test PRIVATE mystral-runtime)
    endif()

    add_executable(threenative-wgpu-null-handle-test EXCLUDE_FROM_ALL
        tests/wgpu_null_handle_test.cpp)
    target_link_libraries(threenative-wgpu-null-handle-test PRIVATE mystral-runtime)

    add_executable(threenative-surface-format-selection-test EXCLUDE_FROM_ALL
        tests/surface_format_selection_test.cpp)
    target_include_directories(threenative-surface-format-selection-test PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/src)
    target_link_libraries(threenative-surface-format-selection-test PRIVATE mystral-runtime)

    # localStorage is the persistence contract behind the JS storagePolyfill;
    # this proves the file-backed backend without a display or engine. The
    # header is internal to src/, so only this test gets that include dir.
    add_executable(threenative-local-storage-test EXCLUDE_FROM_ALL
        tests/local_storage_test.cpp)
    target_include_directories(threenative-local-storage-test PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/src)
    target_link_libraries(threenative-local-storage-test PRIVATE mystral-runtime)
    if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
        target_compile_definitions(threenative-local-storage-test PRIVATE
            TN_TEST_WRAP_STORAGE_SYNC=1)
        target_link_options(threenative-local-storage-test PRIVATE
            "-Wl,--wrap=fsync"
            "-Wl,--wrap=close")
    endif()

    # Same lane for the embedded-bundle VFS: synthesizes real container files
    # and proves the loader accepts the documented format and rejects damage.
    add_executable(threenative-embedded-bundle-test EXCLUDE_FROM_ALL
        tests/embedded_bundle_test.cpp)
    target_link_libraries(threenative-embedded-bundle-test PRIVATE mystral-runtime)
    # The negative control calls the real WebGPU C API with a NULL handle, so it needs the same
    # backend headers the bindings use. mystral-runtime links these PRIVATE.
    if(TARGET dawn::webgpu)
        target_link_libraries(threenative-wgpu-null-handle-test PRIVATE dawn::webgpu)
        target_link_libraries(threenative-surface-format-selection-test PRIVATE dawn::webgpu)
    elseif(TARGET wgpu::wgpu)
        target_link_libraries(threenative-wgpu-null-handle-test PRIVATE wgpu::wgpu)
        target_link_libraries(threenative-surface-format-selection-test PRIVATE wgpu::wgpu)
    endif()

    # rg11b10ufloat-renderable: the feature behind three's SSGI target format. The oracle
    # is raw Dawn called directly — wgpuAdapterHasFeature on an instance this test owns —
    # which is what makes a bindings refusal a red rather than an unexecuted skip.
    add_executable(threenative-rg11b10-renderable-test EXCLUDE_FROM_ALL
        tests/rg11b10_renderable_test.cpp)
    # Dawn first, then the runtime. This test calls `wgpuCreateInstance` itself — it is the oracle
    # that makes a hidden feature distinguishable from an absent one — and on Windows it got Dawn's
    # stub proc table instead: "the null wgpuCreateInstance from dawn_proc was called which always
    # returns nullptr". CMake propagates a static library's PRIVATE link dependencies to whoever
    # links it, so `mystral-runtime` was bringing its own Dawn entry points in ahead of the
    # implementation this target names, and the linker took the first definition it saw.
    if(TARGET dawn::webgpu)
        target_link_libraries(threenative-rg11b10-renderable-test PRIVATE dawn::webgpu)
    elseif(TARGET wgpu::wgpu)
        target_link_libraries(threenative-rg11b10-renderable-test PRIVATE wgpu::wgpu)
    endif()
    target_link_libraries(threenative-rg11b10-renderable-test PRIVATE mystral-runtime)

    add_executable(threenative-lifecycle-policy-test EXCLUDE_FROM_ALL
        tests/lifecycle_policy_test.cpp)
    target_link_libraries(threenative-lifecycle-policy-test PRIVATE mystral-runtime)

    # PRD-399. Drives the real presentation-pacing owner with the same feed the Android
    # Choreographer callback calls, so the display-aligned scheduling and the lifecycle unblock are
    # exercised without a device.
    add_executable(threenative-presentation-pacing-test EXCLUDE_FROM_ALL
        tests/presentation_pacing_test.cpp)
    target_link_libraries(threenative-presentation-pacing-test PRIVATE mystral-runtime)
    # It includes `../src/webgpu/bindings_presentation.h`, whose state header needs the backend
    # header; `mystral-runtime` links the backend PRIVATE, so its includes do not propagate.
    if(MYSTRAL_USE_DAWN)
        target_include_directories(threenative-presentation-pacing-test PRIVATE ${DAWN_INCLUDE_DIR})
    elseif(MYSTRAL_USE_WGPU AND TARGET wgpu::wgpu)
        target_include_directories(threenative-presentation-pacing-test PRIVATE ${WGPU_TEST_INCLUDES})
    endif()

    add_executable(threenative-webgpu-comprehensive-test EXCLUDE_FROM_ALL
        tests/webgpu_comprehensive_test.cpp)
    target_link_libraries(threenative-webgpu-comprehensive-test PRIVATE mystral-runtime)
    add_executable(threenative-canvas-presentation-test EXCLUDE_FROM_ALL
        tests/canvas_presentation_test.cpp)
    target_link_libraries(threenative-canvas-presentation-test PRIVATE mystral-runtime)
    add_executable(threenative-surface-texture-status-test EXCLUDE_FROM_ALL
        tests/surface_texture_status_test.cpp)
    target_link_libraries(threenative-surface-texture-status-test PRIVATE mystral-runtime)
    if(MYSTRAL_USE_DAWN)
        target_include_directories(threenative-webgpu-comprehensive-test PRIVATE ${DAWN_INCLUDE_DIR})
        target_include_directories(threenative-surface-texture-status-test PRIVATE ${DAWN_INCLUDE_DIR})
        target_include_directories(threenative-canvas-presentation-test PRIVATE ${DAWN_INCLUDE_DIR})
    elseif(MYSTRAL_USE_WGPU AND TARGET wgpu::wgpu)
        target_include_directories(threenative-webgpu-comprehensive-test PRIVATE ${WGPU_TEST_INCLUDES})
        target_include_directories(threenative-surface-texture-status-test PRIVATE ${WGPU_TEST_INCLUDES})
        target_include_directories(threenative-canvas-presentation-test PRIVATE ${WGPU_TEST_INCLUDES})
    endif()
    tn_register_contract_test(threenative-surface-texture-status-test)
    tn_register_contract_test(threenative-canvas-presentation-test)

    add_executable(threenative-js-module-comprehensive-test EXCLUDE_FROM_ALL
        tests/js_module_comprehensive_test.cpp)
    target_link_libraries(threenative-js-module-comprehensive-test PRIVATE mystral-runtime)

    add_executable(threenative-runtime-platform-comprehensive-test EXCLUDE_FROM_ALL
        tests/runtime_platform_comprehensive_test.cpp)
    target_link_libraries(threenative-runtime-platform-comprehensive-test PRIVATE mystral-runtime)

    add_executable(threenative-canvas-audio-comprehensive-test EXCLUDE_FROM_ALL
        tests/canvas_audio_comprehensive_test.cpp)
    target_link_libraries(threenative-canvas-audio-comprehensive-test PRIVATE mystral-runtime)

    add_executable(threenative-cli-network-fs-test EXCLUDE_FROM_ALL
        tests/cli_network_fs_test.cpp
        src/cli/tools_main.cpp
        src/cli/bundler.cpp
        src/cli/lightmap.cpp
        src/cli/tool_dispatch.cpp
    )
    target_compile_definitions(threenative-cli-network-fs-test PRIVATE
        MYSTRAL_TOOLS_NO_MAIN=1)
    target_link_libraries(threenative-cli-network-fs-test PRIVATE mystral-runtime)
    # The generated runtime_scripts.h, so this test can install the same embedded polyfills the
    # runtime does. webtransport::initBindings reads globalThis.__wtDispatch, and the WebTransport
    # polyfill installs nothing without Web Streams, so a bare engine fails it.
    target_include_directories(threenative-cli-network-fs-test PRIVATE
        "${CMAKE_CURRENT_BINARY_DIR}/generated")
    add_dependencies(threenative-cli-network-fs-test threenative-runtime-scripts)
    if(TARGET webp::mux)
        target_include_directories(threenative-cli-network-fs-test PRIVATE ${WEBP_INCLUDE_DIR})
    endif()
    if(SDL3_STATIC_TARGET)
        target_link_libraries(threenative-cli-network-fs-test PRIVATE ${SDL3_STATIC_TARGET})
    elseif(TARGET SDL3::SDL3-static)
        target_link_libraries(threenative-cli-network-fs-test PRIVATE SDL3::SDL3-static)
    elseif(SDL3_INCLUDE_DIR)
        target_include_directories(threenative-cli-network-fs-test PRIVATE ${SDL3_INCLUDE_DIR})
    endif()
    if(SDL3_STATIC_TARGET)
        target_link_libraries(threenative-runtime-platform-comprehensive-test PRIVATE ${SDL3_STATIC_TARGET})
    elseif(TARGET SDL3::SDL3-static)
        target_link_libraries(threenative-runtime-platform-comprehensive-test PRIVATE SDL3::SDL3-static)
    endif()
    # This test includes <SDL3/SDL.h> directly. `mystral-runtime` links SDL3 PRIVATE, so its
    # include directories do not propagate to a consumer, and the target compiled everywhere SDL3
    # happened to be on the default search path and nowhere else. On the hosted macOS and Windows
    # runners it is not, so every native lane failed at
    #   lifecycle_policy_test.cpp:23:10: fatal error: 'SDL3/SDL.h' file not found
    # while `native:build` itself succeeded — the runtime does not need the header, only this test
    # does. Ask SDL3 for its interface includes explicitly rather than inheriting them by luck.
    if(SDL3_STATIC_TARGET)
        target_link_libraries(threenative-lifecycle-policy-test PRIVATE ${SDL3_STATIC_TARGET})
    elseif(TARGET SDL3::SDL3-static)
        target_link_libraries(threenative-lifecycle-policy-test PRIVATE SDL3::SDL3-static)
    endif()
    if(MYSTRAL_USE_DAWN)
        target_include_directories(threenative-lifecycle-policy-test PRIVATE
            ${DAWN_INCLUDE_DIR})
    elseif(MYSTRAL_USE_WGPU AND TARGET wgpu::wgpu)
        target_include_directories(threenative-lifecycle-policy-test PRIVATE
            ${WGPU_TEST_INCLUDES})
    endif()

    tn_register_contract_test(threenative-audio-decode-ogg-test)
    tn_register_contract_test(threenative-audio-decode-promise-test)
    tn_register_contract_test(threenative-audio-graph-test)
    tn_register_contract_test(threenative-bindings-creation-test)
    tn_register_contract_test(threenative-canvas2d-dirty-test)
    tn_register_contract_test(threenative-command-encoder-class-table-test)
    if(NOT WIN32)
        tn_register_contract_test(threenative-crash-handler-policy-test)
    endif()
    tn_register_contract_test(threenative-css-ui-overlay-test)
    tn_register_contract_test(threenative-device-pixel-ratio-test)
    tn_register_contract_test(threenative-dom-dispatch-lifetime-test)
    tn_register_contract_test(threenative-worker-production-test)
    tn_register_contract_test(threenative-embedded-bundle-test)
    tn_register_contract_test(threenative-frame-op-stream-replay-test)
    tn_register_contract_test(threenative-handle-lifetime-test v8)
    tn_register_contract_test(threenative-input-restart-test)
    tn_register_contract_test(threenative-js-engine-contract-test)
    tn_register_contract_test(threenative-lifecycle-policy-test)
    tn_register_contract_test(threenative-local-storage-test)
    if(TN_ENABLE_NATIVE_PHYSICS)
        tn_register_contract_test(threenative-physics-actuation-bindings-test)
    else()
        tn_register_blocked_test(threenative-physics-actuation-bindings-test
            "TN_ENABLE_NATIVE_PHYSICS=OFF")
    endif()
    if(TN_ENABLE_METAHUMAN)
        tn_register_contract_test(threenative-metahuman-bindings-test)
    else()
        tn_register_blocked_test(threenative-metahuman-bindings-test
            "TN_ENABLE_METAHUMAN=OFF")
    endif()
    tn_register_contract_test(threenative-render-pass-class-table-test)
    tn_register_contract_test(threenative-rt-handle-allocation-test)
    tn_register_contract_test(threenative-screenshot-capture-gate-test)
    tn_register_contract_test(threenative-shader-module-metadata-test)
    tn_register_contract_test(threenative-shutdown-lifetime-test http)
    file(MAKE_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/ctest-shutdown-lifetime")
    add_test(NAME threenative-shutdown-lifetime-test-timer-watch
        COMMAND $<TARGET_FILE:threenative-shutdown-lifetime-test>
            timer-watch "${CMAKE_CURRENT_BINARY_DIR}/ctest-shutdown-lifetime")
    set_tests_properties(threenative-shutdown-lifetime-test-timer-watch
        PROPERTIES LABELS "native-contract")
    tn_register_contract_test(threenative-timer-delivery-test)
    tn_register_contract_test(threenative-timer-engine-first-test)
    tn_register_contract_test(threenative-async-pipeline-thread-test)
    tn_register_contract_test(threenative-pipeline-cache-api-test)
    tn_register_contract_test(threenative-pipeline-cache-lifecycle-test)
    tn_register_contract_test(threenative-pipeline-cache-test)
    tn_register_contract_test(threenative-stall-budget-hitch-test)
    tn_register_contract_test(threenative-transient-attachments-test)
    add_test(NAME threenative-transient-attachments-test-feature-off
        COMMAND $<TARGET_FILE:threenative-transient-attachments-test> --feature-off)
    add_test(NAME threenative-transient-attachments-test-direct
        COMMAND $<TARGET_FILE:threenative-transient-attachments-test> --direct)
    set_tests_properties(threenative-transient-attachments-test-feature-off
        threenative-transient-attachments-test-direct PROPERTIES LABELS "native-contract")
    tn_register_contract_test(threenative-timestamp-query-test)
    tn_register_contract_test(threenative-exposure-graph-test)
    add_test(NAME threenative-exposure-graph-test-validation-negative
        COMMAND $<TARGET_FILE:threenative-exposure-graph-test> --inject-validation)
    set_tests_properties(threenative-exposure-graph-test-validation-negative
        PROPERTIES LABELS "native-contract")
    if(TN_ENABLE_VIDEO)
        tn_register_contract_test(threenative-video-recorder-state-test)
    else()
        tn_register_blocked_test(threenative-video-recorder-state-test "TN_ENABLE_VIDEO=OFF")
    endif()
    tn_register_contract_test(threenative-webgpu-bindings-reentrancy-test)
    tn_register_contract_test(threenative-rg11b10-renderable-test)
    tn_register_contract_test(threenative-wgpu-null-handle-test)
    tn_register_contract_test(threenative-surface-format-selection-test)
    tn_register_contract_test(threenative-presentation-pacing-test)
    tn_register_contract_test(threenative-webgpu-comprehensive-test)
    tn_register_contract_test(threenative-js-module-comprehensive-test)
    tn_register_contract_test(threenative-runtime-platform-comprehensive-test)
    tn_register_contract_test(threenative-canvas-audio-comprehensive-test)
    tn_register_contract_test(threenative-cli-network-fs-test)
    tn_mark_sanitizer_contract_test(threenative-bindings-creation-test)
    tn_mark_sanitizer_contract_test(threenative-dom-dispatch-lifetime-test)
    tn_mark_sanitizer_contract_test(threenative-frame-op-stream-replay-test)
    tn_mark_sanitizer_contract_test(threenative-handle-lifetime-test)
    if(TN_ENABLE_METAHUMAN)
        # The facial rig is the one contract that parses untrusted bytes into the C ABI, so it runs
        # instrumented too: a leak or a bad free in the DNA reader is invisible without it.
        tn_mark_sanitizer_contract_test(threenative-metahuman-bindings-test)
    endif()
    tn_mark_sanitizer_contract_test(threenative-shutdown-lifetime-test)
    tn_mark_sanitizer_contract_test(threenative-webgpu-bindings-reentrancy-test)
    get_property(TN_NATIVE_SANITIZER_TARGETS GLOBAL PROPERTY TN_NATIVE_SANITIZER_TARGETS)
    if(TN_ENABLE_SANITIZERS)
        # V8 and Skia are prebuilt without exported RTTI. UBSan's vptr check alone requires those
        # unavailable typeinfo symbols; all other address and undefined-behaviour checks stay on.
        set(TN_SANITIZER_COMPILE_OPTIONS
            -fsanitize=address,undefined -fno-sanitize=vptr -fno-omit-frame-pointer)
        set(TN_SANITIZER_LINK_OPTIONS -fsanitize=address,undefined -fno-sanitize=vptr)
        target_compile_options(mystral-runtime PRIVATE ${TN_SANITIZER_COMPILE_OPTIONS})
        foreach(target IN LISTS TN_NATIVE_SANITIZER_TARGETS)
            target_compile_options(${target} PRIVATE ${TN_SANITIZER_COMPILE_OPTIONS})
            target_link_options(${target} PRIVATE ${TN_SANITIZER_LINK_OPTIONS})
        endforeach()
    endif()
    get_property(TN_NATIVE_CONTRACT_TARGETS GLOBAL PROPERTY TN_NATIVE_CONTRACT_TARGETS)
    add_custom_target(threenative-native-tests DEPENDS ${TN_NATIVE_CONTRACT_TARGETS})
    add_custom_target(threenative-native-sanitizer-tests DEPENDS ${TN_NATIVE_SANITIZER_TARGETS})

    # Add webp include directories and definitions for video recording
    if(TARGET webp::mux)
        target_include_directories(mystral PRIVATE ${WEBP_INCLUDE_DIR})
        target_compile_definitions(mystral PRIVATE MYSTRAL_HAS_WEBP_MUX)
    endif()

    # Add SDL3 include directories for input injection
    if(TARGET SDL3::SDL3 OR TARGET SDL3::SDL3-static)
        target_link_libraries(mystral PRIVATE $<IF:$<TARGET_EXISTS:SDL3::SDL3-static>,SDL3::SDL3-static,SDL3::SDL3>)
    elseif(SDL3_INCLUDE_DIR)
        target_include_directories(mystral PRIVATE ${SDL3_INCLUDE_DIR})
    endif()

    # macOS: Set rpath for redistributable binary
    # The binary will look for SDL3.framework next to the executable
    if(APPLE)
        set_target_properties(mystral PROPERTIES
            MACOSX_RPATH ON
            # Use install rpath even in build output (for redistribution)
            BUILD_WITH_INSTALL_RPATH ON
            INSTALL_RPATH "@executable_path"
        )
    endif()

    # On Linux, the GNU linker needs help finding zlib (curl's transitive dependency).
    # Use --copy-dt-needed-entries to pull in dependencies from shared libraries.
    # Also allow multiple definitions because wgpu-native and swc both contain Rust runtime symbols.
    if(UNIX AND NOT APPLE)
        target_link_options(mystral-runtime INTERFACE
            "LINKER:--copy-dt-needed-entries"
            "LINKER:--allow-multiple-definition"
        )
    endif()

    # Install CLI to bin directory
    install(TARGETS mystral mystral-tools
        RUNTIME DESTINATION bin
    )

endif()

# iOS app target. The JavaScript proof remains the exact import-free bundle built from
# examples/native-smoke; the app is only a root-linked native host around that source.
if(MYSTRAL_PLATFORM STREQUAL "ios")
    set(THREENATIVE_IOS_PROOF_BUNDLE
        "${CMAKE_CURRENT_SOURCE_DIR}/../../examples/native-smoke/dist/native-smoke.js"
        CACHE FILEPATH "Import-free ThreeNative smoke bundle embedded in the iOS app")
    if(NOT EXISTS "${THREENATIVE_IOS_PROOF_BUNDLE}")
        message(FATAL_ERROR
            "iOS proof bundle missing at ${THREENATIVE_IOS_PROOF_BUNDLE}. Run pnpm --filter threenative-native-smoke build first.")
    endif()
    add_executable(threenative-ios MACOSX_BUNDLE
        ios/main.mm
        # The UI layer, whose contract is the same one Android and desktop implement. UNPROVEN:
        # this repository has no macOS host, so no part of it has been compiled or run.
        ios/ui_overlay_ios.mm
        "${THREENATIVE_IOS_PROOF_BUNDLE}"
    )
    set_source_files_properties("${THREENATIVE_IOS_PROOF_BUNDLE}" PROPERTIES
        MACOSX_PACKAGE_LOCATION Resources
    )
    set_target_properties(threenative-ios PROPERTIES
        MACOSX_BUNDLE_INFO_PLIST "${CMAKE_CURRENT_SOURCE_DIR}/ios/Info.plist"
        XCODE_ATTRIBUTE_PRODUCT_BUNDLE_IDENTIFIER "dev.threenative.runtime"
        XCODE_ATTRIBUTE_TARGETED_DEVICE_FAMILY "1,2"
    )
    target_link_libraries(threenative-ios PRIVATE mystral-runtime "-framework WebKit")
    if(SDL3_STATIC_TARGET)
        target_link_libraries(threenative-ios PRIVATE ${SDL3_STATIC_TARGET})
    elseif(TARGET SDL3::SDL3-static)
        target_link_libraries(threenative-ios PRIVATE SDL3::SDL3-static)
    endif()
endif()

# ============================================================================
# Install
# ============================================================================

install(TARGETS mystral-runtime
    ARCHIVE DESTINATION lib
    LIBRARY DESTINATION lib
)

install(DIRECTORY include/mystral
    DESTINATION include
)
