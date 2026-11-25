#pragma once

#include <array>
#include <bit>
#include <cctype>
#include <cstdint>
#include <cstring>
#include <span>
#include <string>
#include <string_view>

namespace tn::engine::shader {

/**
 * Shared per-view uniform block (@group(2) @binding(0) vu: ViewUniforms, PRD-913 Phase 2).
 * Byte offsets are shared identically between WGSL emission and Renderer's C++ slice writer so
 * per-draw uniform blocks carry only object/material data and camera turns rewrite zero per-draw slots.
 */
namespace view_uniforms {

inline constexpr uint32_t kViewMatrix = 0;               // mat4x4<f32> (64)
inline constexpr uint32_t kProjectionMatrix = 64;        // mat4x4<f32> (64)
inline constexpr uint32_t kViewNormalMatrix = 128;       // mat3x3<f32> (48)
inline constexpr uint32_t kCameraWorldMatrix = 176;      // mat4x4<f32> (64)
inline constexpr uint32_t kCameraProjectionMatrix = 240; // mat4x4<f32> (64)
inline constexpr uint32_t kUnjitteredProjection = 304;   // mat4x4<f32> (64)
inline constexpr uint32_t kPreviousProjection = 368;     // mat4x4<f32> (64)
inline constexpr uint32_t kPreviousView = 432;           // mat4x4<f32> (64)
inline constexpr uint32_t kCameraPosition = 496;         // vec3<f32> (12)
inline constexpr uint32_t kCameraNear = 508;             // f32 (4)
inline constexpr uint32_t kHemisphereDirection = 512;    // vec3<f32> (12)
inline constexpr uint32_t kCameraFar = 524;              // f32 (4)
inline constexpr uint32_t kHemisphereSky = 528;          // vec3<f32> (12)
inline constexpr uint32_t kShadowNoiseFrame = 540;       // f32 (4)
inline constexpr uint32_t kHemisphereGround = 544;       // vec3<f32> (12)
inline constexpr uint32_t kViewMipBias = 556;            // f32 (4)
inline constexpr uint32_t kAmbient = 560;                // vec3<f32> (12)
inline constexpr uint32_t kScreenSize = 576;             // vec2<f32> (8)
inline constexpr uint32_t kHeaderBytes = 592;

inline constexpr uint32_t kLightShadowMatrix = 0;        // mat4x4<f32> (64)
inline constexpr uint32_t kLightColor = 64;              // vec3<f32> (12)
inline constexpr uint32_t kLightDistance = 76;           // f32 (4)
inline constexpr uint32_t kLightDirection = 80;          // vec3<f32> (12)
inline constexpr uint32_t kLightDecay = 92;              // f32 (4)
inline constexpr uint32_t kLightAxis = 96;               // vec3<f32> (12)
inline constexpr uint32_t kLightSourceRadius = 108;      // f32 (4)
inline constexpr uint32_t kLightPosition = 112;          // vec3<f32> (12)
inline constexpr uint32_t kLightConeCos = 124;           // f32 (4)
inline constexpr uint32_t kLightShadowSourceRadius = 128;// vec4<f32> (16)
inline constexpr uint32_t kLightShadowMapSize = 144;     // vec2<f32> (8)
inline constexpr uint32_t kLightPenumbraCos = 152;       // f32 (4)
inline constexpr uint32_t kLightShadowBias = 156;        // f32 (4)
inline constexpr uint32_t kLightShadowNormalBias = 160;  // f32 (4)
inline constexpr uint32_t kLightShadowRadius = 164;      // f32 (4)
inline constexpr uint32_t kLightShadowIntensity = 168;   // f32 (4)
inline constexpr uint32_t kLightShadowNear = 172;        // f32 (4)
inline constexpr uint32_t kLightShadowFar = 176;         // f32 (4)
inline constexpr uint32_t kLightShadowPenumbraScale = 180;// f32 (4)
inline constexpr uint32_t kLightBytes = 192;

static_assert(kHeaderBytes % 16 == 0);
static_assert(kLightBytes % 16 == 0);

inline bool isHeaderField(std::string_view name) {
    for (const std::string_view field : {
             "viewMatrix", "projectionMatrix", "viewNormalMatrix", "cameraWorldMatrix",
             "cameraProjectionMatrix", "unjitteredProjection", "previousProjection", "previousView",
             "cameraPosition", "cameraNear", "hemisphereDirection", "cameraFar", "hemisphereSky",
             "shadowNoiseFrame", "hemisphereGround", "viewMipBias", "ambient", "screenSize"}) {
        if (name == field) return true;
    }
    return false;
}

inline bool parseLightField(std::string_view name, uint32_t& index, std::string_view& suffix) {
    if (!name.starts_with("light")) return false;
    std::size_t at = 5;
    while (at < name.size() && std::isdigit(static_cast<unsigned char>(name[at]))) ++at;
    if (at == 5 || at == name.size()) return false;
    uint32_t parsed = 0;
    for (std::size_t i = 5; i < at; ++i) parsed = parsed * 10u + static_cast<uint32_t>(name[i] - '0');
    const std::string_view tail = name.substr(at);
    for (const std::string_view field : {
             "ShadowMatrix", "Color", "Distance", "Direction", "Decay", "Axis", "SourceRadius",
             "Position", "ConeCos", "ShadowSourceRadius", "ShadowMapSize", "PenumbraCos",
             "ShadowBias", "ShadowNormalBias", "ShadowRadius", "ShadowIntensity", "ShadowNear",
             "ShadowFar", "ShadowPenumbraScale"}) {
        if (tail == field) {
            index = parsed;
            suffix = tail;
            return true;
        }
    }
    return false;
}

inline void writeScalars(std::span<uint8_t> block, uint32_t offset, std::span<const double> values) {
    for (std::size_t i = 0; i < values.size(); ++i) {
        const uint32_t word = std::bit_cast<uint32_t>(static_cast<float>(values[i]));
        std::memcpy(block.data() + offset + i * 4, &word, 4);
    }
}

inline void writeMat3(std::span<uint8_t> block, uint32_t offset, const std::array<double, 9>& m) {
    for (uint32_t col = 0; col < 3; ++col) {
        for (uint32_t row = 0; row < 3; ++row) {
            const uint32_t word = std::bit_cast<uint32_t>(static_cast<float>(m[col * 3 + row]));
            std::memcpy(block.data() + offset + col * 16 + row * 4, &word, 4);
        }
    }
}

inline std::string emitWgsl(uint32_t lightCount) {
    std::string out;
    if (lightCount > 0) {
        out +=
            "struct ViewLight {\n"
            "  f_ShadowMatrix: mat4x4<f32>,\n"
            "  f_Color: vec3<f32>,\n"
            "  f_Distance: f32,\n"
            "  f_Direction: vec3<f32>,\n"
            "  f_Decay: f32,\n"
            "  f_Axis: vec3<f32>,\n"
            "  f_SourceRadius: f32,\n"
            "  f_Position: vec3<f32>,\n"
            "  f_ConeCos: f32,\n"
            "  f_ShadowSourceRadius: vec4<f32>,\n"
            "  f_ShadowMapSize: vec2<f32>,\n"
            "  f_PenumbraCos: f32,\n"
            "  f_ShadowBias: f32,\n"
            "  f_ShadowNormalBias: f32,\n"
            "  f_ShadowRadius: f32,\n"
            "  f_ShadowIntensity: f32,\n"
            "  f_ShadowNear: f32,\n"
            "  f_ShadowFar: f32,\n"
            "  f_ShadowPenumbraScale: f32,\n"
            "  _pad: vec2<f32>,\n"
            "}\n";
    }
    out +=
        "struct ViewUniforms {\n"
        "  f_viewMatrix: mat4x4<f32>,\n"
        "  f_projectionMatrix: mat4x4<f32>,\n"
        "  f_viewNormalMatrix: mat3x3<f32>,\n"
        "  f_cameraWorldMatrix: mat4x4<f32>,\n"
        "  f_cameraProjectionMatrix: mat4x4<f32>,\n"
        "  f_unjitteredProjection: mat4x4<f32>,\n"
        "  f_previousProjection: mat4x4<f32>,\n"
        "  f_previousView: mat4x4<f32>,\n"
        "  f_cameraPosition: vec3<f32>,\n"
        "  f_cameraNear: f32,\n"
        "  f_hemisphereDirection: vec3<f32>,\n"
        "  f_cameraFar: f32,\n"
        "  f_hemisphereSky: vec3<f32>,\n"
        "  f_shadowNoiseFrame: f32,\n"
        "  f_hemisphereGround: vec3<f32>,\n"
        "  f_viewMipBias: f32,\n"
        "  f_ambient: vec3<f32>,\n"
        "  _viewPad0: f32,\n"
        "  f_screenSize: vec2<f32>,\n"
        "  _viewPad1: vec2<f32>,\n";
    if (lightCount > 0) out += "  lights: array<ViewLight, " + std::to_string(lightCount) + ">,\n";
    out += "}\n@group(2) @binding(0) var<uniform> vu: ViewUniforms;\n";
    return out;
}

}  // namespace view_uniforms
}  // namespace tn::engine::shader
