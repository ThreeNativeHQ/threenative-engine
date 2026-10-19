#pragma once

// The scalar constants the minimal template imports from `three` (PRD-531), with three r185's exact
// values (three@0.185.1 src/constants.js). The JS-facing numbers and colour-space strings travel to
// a game unchanged, so an off-by-one here is a tone curve or a shadow filter that silently differs.

#include <cstddef>

namespace tn::engine {

/** three's `ToneMapping` constants. `NoToneMapping` and `LinearToneMapping` are 0 and 1. */
inline constexpr int ACESFilmicToneMapping = 4;
inline constexpr int AgXToneMapping = 6;
inline constexpr int NeutralToneMapping = 7;

/** three's `ShadowMapType::PCFSoftShadowMap`; `PCFShadowMap` is 1, `VSMShadowMap` is 3. */
inline constexpr int PCFSoftShadowMap = 2;

/** three's colour spaces are strings: `NoColorSpace` is empty, `LinearSRGBColorSpace` is linear. */
inline constexpr const char* NoColorSpace = "";
inline constexpr const char* LinearSRGBColorSpace = "srgb-linear";

/** Every three constant the engine honours, as each language back end installs it and the registry
 *  dump lists it; the catalog marks exactly these `supported`. A string constant has `text`. */
struct ThreeConstant {
    const char* name;
    double number;
    const char* text;  // text != nullptr => string constant
};

inline constexpr ThreeConstant kThreeConstants[] = {
    {"ACESFilmicToneMapping", ACESFilmicToneMapping, nullptr},
    {"AdditiveBlending", 2.0, nullptr},
    {"AgXToneMapping", AgXToneMapping, nullptr},
    {"AttachedBindMode", 0.0, "attached"},
    {"BackSide", 1.0, nullptr},
    {"ClampToEdgeWrapping", 1001.0, nullptr},
    {"DoubleSide", 2.0, nullptr},
    {"DynamicDrawUsage", 35048.0, nullptr},
    {"EquirectangularReflectionMapping", 303.0, nullptr},
    {"FloatType", 1015.0, nullptr},
    {"FrontSide", 0.0, nullptr},
    {"HalfFloatType", 1016.0, nullptr},
    {"LinearFilter", 1006.0, nullptr},
    {"LinearMipmapLinearFilter", 1008.0, nullptr},
    {"LinearSRGBColorSpace", 0.0, LinearSRGBColorSpace},
    {"LoopOnce", 2200.0, nullptr},
    {"LoopPingPong", 2202.0, nullptr},
    {"LoopRepeat", 2201.0, nullptr},
    {"NearestFilter", 1003.0, nullptr},
    {"NeutralToneMapping", NeutralToneMapping, nullptr},
    {"NoBlending", 0.0, nullptr},
    {"NoColorSpace", 0.0, NoColorSpace},
    {"NoToneMapping", 0.0, nullptr},
    {"NormalBlending", 1.0, nullptr},
    {"PCFShadowMap", 1.0, nullptr},
    {"PCFSoftShadowMap", PCFSoftShadowMap, nullptr},
    {"RepeatWrapping", 1000.0, nullptr},
    {"RGBAFormat", 1023.0, nullptr},
    {"SRGBColorSpace", 0.0, "srgb"},
    {"StaticDrawUsage", 35044.0, nullptr},
    {"UnsignedByteType", 1009.0, nullptr},
};

}  // namespace tn::engine
