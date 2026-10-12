#pragma once

#include "engine/shader/ir.h"

namespace tn::engine::shader {

/** The catalogued tonemapping operators, as three@0.185.1's ToneMappingFunctions.js defines them. */
enum class ToneMapping : uint8_t { Linear, Reinhard, Cineon, ACESFilmic, AgX, Neutral };

/** Applies one operator to a linear vec3 colour with a scalar exposure; returns a vec3. */
ExprId toneMap(Program& p, ToneMapping mapping, ExprId color, ExprId exposure);

}  // namespace tn::engine::shader
