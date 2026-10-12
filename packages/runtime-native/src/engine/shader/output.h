#pragma once

#include <optional>

#include "engine/shader/ir.h"
#include "engine/shader/position_node.h"
#include "engine/shader/tonemap.h"

namespace tn::engine::shader {

/** sRGBTransferOETF from three's ColorSpaceFunctions: linear vec3 to sRGB-encoded vec3. */
ExprId srgbTransferOetf(Program& p, ExprId linear);

struct OutputPrograms {
    Program vertex{Stage::Vertex};
    Program fragment{Stage::Fragment};
};

/**
 * three's renderOutput (WebGPURenderer, r185): unpremultiply the scene's linear HDR colour, tone map
 * with `toneMappingExposure`, encode to the output colour space, then premultiply again. One
 * full-screen triangle: attribute "position" (vec2, clip space), texture "scene", uniform
 * "toneMappingExposure" (only when tone mapping).
 */
OutputPrograms buildOutput(std::optional<ToneMapping> toneMapping, bool srgb, const PostNode* post = nullptr);
OutputPrograms buildOutput(std::optional<ToneMapping> toneMapping, bool srgb, const PostNode* post, bool outputTransform);

}  // namespace tn::engine::shader
