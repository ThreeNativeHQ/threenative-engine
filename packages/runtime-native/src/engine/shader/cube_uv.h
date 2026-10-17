#pragma once

// three's PMREM cubeUV sampling (nodes/pmrem/PMREMUtils.js textureCubeUV), shared by the standard
// programs' environment lighting and TSL's pmremTexture. Defined in standard.cpp.

#include "engine/shader/ir.h"

#include <string_view>

namespace tn::engine::shader {

/**
 * textureCubeUV(texture, direction, roughness) over a cubeUV PMREM bound as `texture`; the layout
 * uniforms are `<prefix>TexelWidth`, `<prefix>TexelHeight` and `<prefix>MaxMip`.
 */
ExprId pmremSample(Program& p, uint32_t texture, ExprId direction, ExprId roughness, std::string_view prefix = "pmrem");

}  // namespace tn::engine::shader
