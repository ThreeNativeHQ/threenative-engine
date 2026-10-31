#pragma once

// three@0.187.0's PMREM sampling (nodes/pmrem/PMREMNode.js:336, nodes/pmrem/PMREMUtils.js:19), shared
// by the standard programs' environment lighting and TSL's pmremTexture. The PMREM is a cube render
// target with one mip per roughness step; it is sampled as a cube, not through a cubeUV atlas.
// Defined in standard.cpp.

#include "engine/shader/ir.h"

#include <string_view>

namespace tn::engine::shader {

/**
 * `cubeTexture.sample(materialEnvRotation * direction).level(roughnessToMip(roughness, maxLod))`:
 * a cube sample of the PMREM bound as `texture` along `direction` (already rotated by the caller),
 * at three's roughness ramp over the `<prefix>MaxMip` uniform (the PMREM's last mip, as
 * PMREMNode.updateFromTexture reads `texture.mipmaps.length - 1`).
 */
ExprId pmremSample(Program& p, uint32_t texture, ExprId direction, ExprId roughness, std::string_view prefix = "pmrem");

}  // namespace tn::engine::shader
