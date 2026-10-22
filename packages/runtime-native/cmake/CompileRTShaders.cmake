# CompileRTShaders.cmake
#
# CMake script to compile GLSL ray tracing shaders to SPIR-V
# and generate the embedded header file.
#
# Usage:
#   cmake -P cmake/CompileRTShaders.cmake
#
# Or during build via add_custom_command (see CMakeLists.txt)
#
# Requirements:
#   - glslangValidator (from Vulkan SDK or LunarG SDK)

cmake_minimum_required(VERSION 3.20)

# Find glslangValidator
find_program(GLSLANG_VALIDATOR
    NAMES glslangValidator
    PATHS
        $ENV{VULKAN_SDK}/bin
        $ENV{VK_SDK_PATH}/bin
        /usr/bin
        /usr/local/bin
    NO_DEFAULT_PATH
)

if(NOT GLSLANG_VALIDATOR)
    find_program(GLSLANG_VALIDATOR glslangValidator)
endif()

if(NOT GLSLANG_VALIDATOR)
    message(FATAL_ERROR "glslangValidator not found. Install Vulkan SDK or set VULKAN_SDK environment variable.")
endif()

message(STATUS "Using glslangValidator: ${GLSLANG_VALIDATOR}")

# Shader source directory
set(SHADER_DIR "${CMAKE_CURRENT_LIST_DIR}/../src/raytracing/shaders")

# Input shaders
set(RAYGEN_SHADER "${SHADER_DIR}/raygen.rgen")
set(MISS_SHADER "${SHADER_DIR}/miss.rmiss")
set(CLOSESTHIT_SHADER "${SHADER_DIR}/closesthit.rchit")
set(PROBE_TRACE_SHADER "${SHADER_DIR}/probe_trace.comp")

# Output SPIR-V files
set(RAYGEN_SPV "${SHADER_DIR}/raygen.spv")
set(MISS_SPV "${SHADER_DIR}/miss.spv")
set(CLOSESTHIT_SPV "${SHADER_DIR}/closesthit.spv")
set(PROBE_TRACE_SPV "${SHADER_DIR}/probe_trace.spv")

# Output header file
set(OUTPUT_HEADER "${SHADER_DIR}/rt_shaders_spirv.h")
set(PROBE_TRACE_HEADER "${SHADER_DIR}/probe_trace_spirv.h")

# Compile raygen shader
message(STATUS "Compiling raygen.rgen...")
execute_process(
    COMMAND ${GLSLANG_VALIDATOR}
        -V
        --target-env vulkan1.2
        -S rgen
        ${RAYGEN_SHADER}
        -o ${RAYGEN_SPV}
    RESULT_VARIABLE RESULT
    OUTPUT_VARIABLE OUTPUT
    ERROR_VARIABLE ERROR
)
if(NOT RESULT EQUAL 0)
    message(FATAL_ERROR "Failed to compile raygen.rgen:\n${ERROR}")
endif()

# Compile miss shader
message(STATUS "Compiling miss.rmiss...")
execute_process(
    COMMAND ${GLSLANG_VALIDATOR}
        -V
        --target-env vulkan1.2
        -S rmiss
        ${MISS_SHADER}
        -o ${MISS_SPV}
    RESULT_VARIABLE RESULT
    OUTPUT_VARIABLE OUTPUT
    ERROR_VARIABLE ERROR
)
if(NOT RESULT EQUAL 0)
    message(FATAL_ERROR "Failed to compile miss.rmiss:\n${ERROR}")
endif()

# Compile closest hit shader
message(STATUS "Compiling closesthit.rchit...")
execute_process(
    COMMAND ${GLSLANG_VALIDATOR}
        -V
        --target-env vulkan1.2
        -S rchit
        ${CLOSESTHIT_SHADER}
        -o ${CLOSESTHIT_SPV}
    RESULT_VARIABLE RESULT
    OUTPUT_VARIABLE OUTPUT
    ERROR_VARIABLE ERROR
)
if(NOT RESULT EQUAL 0)
    message(FATAL_ERROR "Failed to compile closesthit.rchit:\n${ERROR}")
endif()

# Compile the ray batch kernel (a ray query compute shader, needs VK_KHR_ray_query)
message(STATUS "Compiling probe_trace.comp...")
execute_process(
    COMMAND ${GLSLANG_VALIDATOR}
        -V
        --target-env vulkan1.2
        -S comp
        ${PROBE_TRACE_SHADER}
        -o ${PROBE_TRACE_SPV}
    RESULT_VARIABLE RESULT
    OUTPUT_VARIABLE OUTPUT
    ERROR_VARIABLE ERROR
)
if(NOT RESULT EQUAL 0)
    message(FATAL_ERROR "Failed to compile probe_trace.comp:\n${ERROR}")
endif()

# Read SPIR-V files and convert to C arrays
message(STATUS "Generating rt_shaders_spirv.h...")

file(READ ${RAYGEN_SPV} RAYGEN_DATA HEX)
file(READ ${MISS_SPV} MISS_DATA HEX)
file(READ ${CLOSESTHIT_SPV} CLOSESTHIT_DATA HEX)

# Convert hex string to C array format
# Input: hex string like "0723020300010500..."
# Output: C array like "0x07230203, 0x00010500, ..."
function(hex_to_c_array HEX_STRING OUTPUT_VAR)
    string(LENGTH "${HEX_STRING}" HEX_LEN)
    set(RESULT "")
    set(COUNT 0)
    math(EXPR NUM_DWORDS "${HEX_LEN} / 8")

    while(COUNT LESS NUM_DWORDS)
        math(EXPR OFFSET "${COUNT} * 8")
        string(SUBSTRING "${HEX_STRING}" ${OFFSET} 8 DWORD)

        # Reverse byte order (SPIR-V is little-endian)
        string(SUBSTRING "${DWORD}" 6 2 B0)
        string(SUBSTRING "${DWORD}" 4 2 B1)
        string(SUBSTRING "${DWORD}" 2 2 B2)
        string(SUBSTRING "${DWORD}" 0 2 B3)

        if(RESULT)
            string(APPEND RESULT ", ")
        endif()

        # Add newline every 8 dwords for readability
        math(EXPR MOD "${COUNT} % 8")
        if(MOD EQUAL 0 AND COUNT GREATER 0)
            string(APPEND RESULT "\n    ")
        endif()

        string(APPEND RESULT "0x${B0}${B1}${B2}${B3}")
        math(EXPR COUNT "${COUNT} + 1")
    endwhile()

    set(${OUTPUT_VAR} "${RESULT}" PARENT_SCOPE)
endfunction()

hex_to_c_array("${RAYGEN_DATA}" RAYGEN_ARRAY)
hex_to_c_array("${MISS_DATA}" MISS_ARRAY)
hex_to_c_array("${CLOSESTHIT_DATA}" CLOSESTHIT_ARRAY)

file(READ ${PROBE_TRACE_SPV} PROBE_TRACE_DATA HEX)
hex_to_c_array("${PROBE_TRACE_DATA}" PROBE_TRACE_ARRAY)

# Count dwords
string(LENGTH "${RAYGEN_DATA}" RAYGEN_LEN)
string(LENGTH "${MISS_DATA}" MISS_LEN)
string(LENGTH "${CLOSESTHIT_DATA}" CLOSESTHIT_LEN)
math(EXPR RAYGEN_SIZE "${RAYGEN_LEN} / 8")
math(EXPR MISS_SIZE "${MISS_LEN} / 8")
math(EXPR CLOSESTHIT_SIZE "${CLOSESTHIT_LEN} / 8")
string(LENGTH "${PROBE_TRACE_DATA}" PROBE_TRACE_LEN)
math(EXPR PROBE_TRACE_SIZE "${PROBE_TRACE_LEN} / 8")

# Generate header file
file(WRITE ${OUTPUT_HEADER} "/**
 * Pre-compiled SPIR-V shaders for Vulkan Ray Tracing
 *
 * AUTO-GENERATED FILE - DO NOT EDIT
 * Generated by cmake/CompileRTShaders.cmake
 *
 * Source shaders:
 *   - raygen.rgen
 *   - miss.rmiss
 *   - closesthit.rchit
 */

#pragma once

#include <cstddef>
#include <cstdint>

// ============================================================================
// Ray Generation Shader (${RAYGEN_SIZE} dwords)
// ============================================================================

static const uint32_t raygen_spirv[] = {
    ${RAYGEN_ARRAY}
};
static const size_t raygen_spirv_size = ${RAYGEN_SIZE};

// ============================================================================
// Miss Shader (${MISS_SIZE} dwords)
// ============================================================================

static const uint32_t miss_spirv[] = {
    ${MISS_ARRAY}
};
static const size_t miss_spirv_size = ${MISS_SIZE};

// ============================================================================
// Closest Hit Shader (${CLOSESTHIT_SIZE} dwords)
// ============================================================================

static const uint32_t closesthit_spirv[] = {
    ${CLOSESTHIT_ARRAY}
};
static const size_t closesthit_spirv_size = ${CLOSESTHIT_SIZE};
")

# The ray batch kernel has its own header: it needs VK_KHR_ray_query, the camera shaders above need
# VK_KHR_ray_tracing_pipeline, and a device can lack either.
file(WRITE ${PROBE_TRACE_HEADER} "/**
 * Pre-compiled SPIR-V for the ray batch kernel (probe_trace.comp, a ray query compute shader)
 *
 * AUTO-GENERATED FILE - DO NOT EDIT
 * Generated by cmake/CompileRTShaders.cmake
 */

#pragma once

#include <cstddef>
#include <cstdint>

// ============================================================================
// Ray Batch Kernel (${PROBE_TRACE_SIZE} dwords)
// ============================================================================

static const uint32_t probe_trace_spirv[] = {
    ${PROBE_TRACE_ARRAY}
};
static const size_t probe_trace_spirv_size = ${PROBE_TRACE_SIZE};
")

message(STATUS "Generated ${OUTPUT_HEADER}")
message(STATUS "  raygen:     ${RAYGEN_SIZE} dwords")
message(STATUS "  miss:       ${MISS_SIZE} dwords")
message(STATUS "  closesthit: ${CLOSESTHIT_SIZE} dwords")
message(STATUS "Generated ${PROBE_TRACE_HEADER}")
message(STATUS "  probe_trace: ${PROBE_TRACE_SIZE} dwords")

# Clean up temporary SPIR-V files
file(REMOVE ${RAYGEN_SPV} ${MISS_SPV} ${CLOSESTHIT_SPV} ${PROBE_TRACE_SPV})

message(STATUS "Shader compilation complete!")
