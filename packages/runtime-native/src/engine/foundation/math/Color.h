#pragma once

// Color, ported from three@0.185.1 src/math/Color.js, including the colour-space conversion
// three's ColorManagement does (src/math/ColorManagement.js). The working space is linear-sRGB, so
// `setHex`, `setStyle` and `getHex` convert through the sRGB transfer function in both directions and
// a stored r/g/b is always linear.
//
// Not ported: `getStyle` (its non-sRGB branch is a CSS `toFixed(3)`, which is presentation text and
// not scalar math), `toJSON`/`fromJSON` (JSON text belongs to the binding layer), and
// `fromBufferAttribute` (a BufferAttribute, PRD-504). `ColorManagement`'s matrix conversion between
// primaries is not reachable from these two spaces, which share the Rec.709 primaries.

#include <array>
#include <cstdint>
#include <string>

namespace tn::engine {

class Matrix3;
class Vector3;

/** The colour spaces this port knows. three's `workingColorSpace` is linear-sRGB. */
enum class ColorSpace { LinearSRGB, SRGB };

/** `SRGBToLinear`: three's piecewise sRGB decode, with its exact coefficients. */
double srgbToLinear(double c);

/** `LinearToSRGB`: three's piecewise sRGB encode, with its exact exponents. */
double linearToSrgb(double c);

/** The CSS colour keyword table, as three spells it (`Color.NAMES`). Empty when the name is unknown. */
bool colorNameHex(const char* name, uint32_t& hex);

/** An HSL triple in three's 0..1 ranges, which is what `getHSL` fills. */
struct IColorHsl {
    double h = 0;
    double s = 0;
    double l = 0;
};

class Color {
public:
    double r = 1;
    double g = 1;
    double b = 1;

    Color() = default;
    Color(double r, double g, double b) { setRGB(r, g, b); }

    /** `new Color(undefined)` leaves the reference's white; this constructor pair spells both. */
    Color& setRGB(double r, double g, double b, ColorSpace colorSpace = ColorSpace::LinearSRGB);
    Color& setScalar(double scalar);
    Color& setHex(double hex, ColorSpace colorSpace = ColorSpace::SRGB);
    Color& setHSL(double h, double s, double l, ColorSpace colorSpace = ColorSpace::LinearSRGB);
    /** Accepts `#rgb`, `#rrggbb`, `rgb()`, `rgba()`, `hsl()`, `hsla()` and the CSS keywords. */
    Color& setStyle(const char* style, ColorSpace colorSpace = ColorSpace::SRGB);
    Color& setColorName(const char* style, ColorSpace colorSpace = ColorSpace::SRGB);
    [[nodiscard]] Color clone() const { return *this; }
    Color& copy(const Color& color);
    Color& copySRGBToLinear(const Color& color);
    Color& copyLinearToSRGB(const Color& color);
    Color& convertSRGBToLinear();
    Color& convertLinearToSRGB();
    [[nodiscard]] double getHex(ColorSpace colorSpace = ColorSpace::SRGB) const;
    /** `"NaN"` for a non-finite colour: see Color.cpp, where three's own answer is that too. */
    [[nodiscard]] std::string getHexString(ColorSpace colorSpace = ColorSpace::SRGB) const;
    [[nodiscard]] IColorHsl getHSL(ColorSpace colorSpace = ColorSpace::LinearSRGB) const;
    [[nodiscard]] std::array<double, 3> getRGB(ColorSpace colorSpace = ColorSpace::LinearSRGB) const;
    Color& offsetHSL(double h, double s, double l);
    Color& add(const Color& color);
    Color& addColors(const Color& color1, const Color& color2);
    Color& addScalar(double s);
    Color& sub(const Color& color);
    Color& multiply(const Color& color);
    Color& multiplyScalar(double s);
    Color& lerp(const Color& color, double alpha);
    Color& lerpColors(const Color& color1, const Color& color2, double alpha);
    Color& lerpHSL(const Color& color, double alpha);
    Color& setFromVector3(const Vector3& v);
    Color& applyMatrix3(const Matrix3& m);
    [[nodiscard]] bool equals(const Color& c) const;
    Color& fromArray(const double* array, int offset = 0);
    [[nodiscard]] std::array<double, 3> toArray() const { return {r, g, b}; }
};

}  // namespace tn::engine
