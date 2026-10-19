#include "engine/foundation/math/Color.h"

#include "engine/foundation/math/MathUtils.h"
#include "engine/foundation/math/Matrix.h"
#include "engine/foundation/math/Vector.h"
#include "engine/foundation/math/ieee754.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string_view>

namespace tn::engine {

namespace {

/** three's CSS colour keywords (Color.NAMES), copied from the pinned reference. */
constexpr struct {
    const char* name;
    uint32_t hex;
} COLOR_KEYWORDS[] = {
    {"aliceblue", 0xF0F8FF}, {"antiquewhite", 0xFAEBD7}, {"aqua", 0x00FFFF},
    {"aquamarine", 0x7FFFD4}, {"azure", 0xF0FFFF}, {"beige", 0xF5F5DC},
    {"bisque", 0xFFE4C4}, {"black", 0x000000}, {"blanchedalmond", 0xFFEBCD},
    {"blue", 0x0000FF}, {"blueviolet", 0x8A2BE2}, {"brown", 0xA52A2A},
    {"burlywood", 0xDEB887}, {"cadetblue", 0x5F9EA0}, {"chartreuse", 0x7FFF00},
    {"chocolate", 0xD2691E}, {"coral", 0xFF7F50}, {"cornflowerblue", 0x6495ED},
    {"cornsilk", 0xFFF8DC}, {"crimson", 0xDC143C}, {"cyan", 0x00FFFF},
    {"darkblue", 0x00008B}, {"darkcyan", 0x008B8B}, {"darkgoldenrod", 0xB8860B},
    {"darkgray", 0xA9A9A9}, {"darkgreen", 0x006400}, {"darkgrey", 0xA9A9A9},
    {"darkkhaki", 0xBDB76B}, {"darkmagenta", 0x8B008B}, {"darkolivegreen", 0x556B2F},
    {"darkorange", 0xFF8C00}, {"darkorchid", 0x9932CC}, {"darkred", 0x8B0000},
    {"darksalmon", 0xE9967A}, {"darkseagreen", 0x8FBC8F}, {"darkslateblue", 0x483D8B},
    {"darkslategray", 0x2F4F4F}, {"darkslategrey", 0x2F4F4F}, {"darkturquoise", 0x00CED1},
    {"darkviolet", 0x9400D3}, {"deeppink", 0xFF1493}, {"deepskyblue", 0x00BFFF},
    {"dimgray", 0x696969}, {"dimgrey", 0x696969}, {"dodgerblue", 0x1E90FF},
    {"firebrick", 0xB22222}, {"floralwhite", 0xFFFAF0}, {"forestgreen", 0x228B22},
    {"fuchsia", 0xFF00FF}, {"gainsboro", 0xDCDCDC}, {"ghostwhite", 0xF8F8FF},
    {"gold", 0xFFD700}, {"goldenrod", 0xDAA520}, {"gray", 0x808080},
    {"green", 0x008000}, {"greenyellow", 0xADFF2F}, {"grey", 0x808080},
    {"honeydew", 0xF0FFF0}, {"hotpink", 0xFF69B4}, {"indianred", 0xCD5C5C},
    {"indigo", 0x4B0082}, {"ivory", 0xFFFFF0}, {"khaki", 0xF0E68C},
    {"lavender", 0xE6E6FA}, {"lavenderblush", 0xFFF0F5}, {"lawngreen", 0x7CFC00},
    {"lemonchiffon", 0xFFFACD}, {"lightblue", 0xADD8E6}, {"lightcoral", 0xF08080},
    {"lightcyan", 0xE0FFFF}, {"lightgoldenrodyellow", 0xFAFAD2}, {"lightgray", 0xD3D3D3},
    {"lightgreen", 0x90EE90}, {"lightgrey", 0xD3D3D3}, {"lightpink", 0xFFB6C1},
    {"lightsalmon", 0xFFA07A}, {"lightseagreen", 0x20B2AA}, {"lightskyblue", 0x87CEFA},
    {"lightslategray", 0x778899}, {"lightslategrey", 0x778899}, {"lightsteelblue", 0xB0C4DE},
    {"lightyellow", 0xFFFFE0}, {"lime", 0x00FF00}, {"limegreen", 0x32CD32},
    {"linen", 0xFAF0E6}, {"magenta", 0xFF00FF}, {"maroon", 0x800000},
    {"mediumaquamarine", 0x66CDAA}, {"mediumblue", 0x0000CD}, {"mediumorchid", 0xBA55D3},
    {"mediumpurple", 0x9370DB}, {"mediumseagreen", 0x3CB371}, {"mediumslateblue", 0x7B68EE},
    {"mediumspringgreen", 0x00FA9A}, {"mediumturquoise", 0x48D1CC}, {"mediumvioletred", 0xC71585},
    {"midnightblue", 0x191970}, {"mintcream", 0xF5FFFA}, {"mistyrose", 0xFFE4E1},
    {"moccasin", 0xFFE4B5}, {"navajowhite", 0xFFDEAD}, {"navy", 0x000080},
    {"oldlace", 0xFDF5E6}, {"olive", 0x808000}, {"olivedrab", 0x6B8E23},
    {"orange", 0xFFA500}, {"orangered", 0xFF4500}, {"orchid", 0xDA70D6},
    {"palegoldenrod", 0xEEE8AA}, {"palegreen", 0x98FB98}, {"paleturquoise", 0xAFEEEE},
    {"palevioletred", 0xDB7093}, {"papayawhip", 0xFFEFD5}, {"peachpuff", 0xFFDAB9},
    {"peru", 0xCD853F}, {"pink", 0xFFC0CB}, {"plum", 0xDDA0DD},
    {"powderblue", 0xB0E0E6}, {"purple", 0x800080}, {"rebeccapurple", 0x663399},
    {"red", 0xFF0000}, {"rosybrown", 0xBC8F8F}, {"royalblue", 0x4169E1},
    {"saddlebrown", 0x8B4513}, {"salmon", 0xFA8072}, {"sandybrown", 0xF4A460},
    {"seagreen", 0x2E8B57}, {"seashell", 0xFFF5EE}, {"sienna", 0xA0522D},
    {"silver", 0xC0C0C0}, {"skyblue", 0x87CEEB}, {"slateblue", 0x6A5ACD},
    {"slategray", 0x708090}, {"slategrey", 0x708090}, {"snow", 0xFFFAFA},
    {"springgreen", 0x00FF7F}, {"steelblue", 0x4682B4}, {"tan", 0xD2B48C},
    {"teal", 0x008080}, {"thistle", 0xD8BFD8}, {"tomato", 0xFF6347},
    {"turquoise", 0x40E0D0}, {"violet", 0xEE82EE}, {"wheat", 0xF5DEB3},
    {"white", 0xFFFFFF}, {"whitesmoke", 0xF5F5F5}, {"yellow", 0xFFFF00},
    {"yellowgreen", 0x9ACD32},
};

bool iequals(const char* left, const char* right) {
    for (; *left != '\0' && *right != '\0'; ++left, ++right) {
        const char a = (*left >= 'A' && *left <= 'Z') ? static_cast<char>(*left + 32) : *left;
        const char b = (*right >= 'A' && *right <= 'Z') ? static_cast<char>(*right + 32) : *right;
        if (a != b) return false;
    }
    return *left == *right;
}

/** three's `hue2rgb`: the six-band helper, with its `1 / 6` and `2 / 3` bands,
 * which are binary64 fractions here and integer division in C++ if they are left bare. */
double hue2rgb(double p, double q, double t) {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1.0 / 6.0) return p + (q - p) * 6 * t;
    if (t < 1.0 / 2.0) return q;
    if (t < 2.0 / 3.0) return p + (q - p) * 6 * (2.0 / 3.0 - t);
    return p;
}

/** ColorManagement.convert for the two spaces this port knows; they share the Rec.709 primaries. */
void colorSpaceToWorking(Color& color, ColorSpace from) {
    if (from == ColorSpace::SRGB) color.copySRGBToLinear(color);
}

void workingToColorSpace(Color& color, ColorSpace to) {
    if (to == ColorSpace::SRGB) color.copyLinearToSRGB(color);
}

/** Reads one CSS number run, advancing past it. Returns the number, or NaN when there is none. */
double scanNumber(const char*& cursor) {
    while (*cursor == ' ' || *cursor == '\t') ++cursor;
    const char* start = cursor;
    while ((*cursor >= '0' && *cursor <= '9') || *cursor == '.' || *cursor == '-' || *cursor == '+')
        ++cursor;
    return start == cursor ? QUIET_NAN : std::strtod(start, nullptr);
}

/** Skips the `%` of a CSS percentage, if it is there. */
bool scanPercent(const char*& cursor) {
    while (*cursor == ' ' || *cursor == '\t') ++cursor;
    if (*cursor != '%') return false;
    ++cursor;
    return true;
}

/** three's component separator is a comma; anything else means the style is not this model. */
bool expectComma(const char*& cursor) {
    while (*cursor == ' ' || *cursor == '\t') ++cursor;
    if (*cursor != ',') return false;
    ++cursor;
    return true;
}

/** True at the closing paren. */
bool atEnd(const char* cursor) {
    while (*cursor == ' ' || *cursor == '\t') ++cursor;
    return *cursor == '\0' || *cursor == ')';
}

/**
 * three's optional alpha component: `\d*\u005c.?\d+` before the closing paren. It parses,
 * it is warned about when it is below one, and this port ignores it exactly as three does.
 */
bool skipAlpha(const char*& cursor) {
    const char* mark = cursor;
    if (!expectComma(cursor)) return true;
    while (*cursor == ' ' || *cursor == '\t') ++cursor;
    const char* start = cursor;
    while (*cursor >= '0' && *cursor <= '9') ++cursor;
    if (*cursor == '.') {
        ++cursor;
        start = cursor;
        while (*cursor >= '0' && *cursor <= '9') ++cursor;
        if (start == cursor) {
            cursor = mark;
            return false;
        }
    }
    if (start == cursor) {
        cursor = mark;
        return false;
    }
    return atEnd(cursor);
}

/**
 * A component three writes as `\d+`: digits and nothing else, so `rgb(300,-20,0)` is not a
 * colour at all and the reference leaves the colour untouched.
 */
double scanUnsigned(const char*& cursor) {
    const char* start = cursor;
    while (*cursor >= '0' && *cursor <= '9') ++cursor;
    return start == cursor ? QUIET_NAN : std::strtod(start, nullptr);
}

}  // namespace

double srgbToLinear(double c) {
    return (c < 0.04045) ? c * 0.0773993808
                         : ieee754::pow(c * 0.9478672986 + 0.0521327014, 2.4);
}

double linearToSrgb(double c) {
    return (c < 0.0031308) ? c * 12.92 : 1.055 * (ieee754::pow(c, 0.41666)) - 0.055;
}

bool colorNameHex(const char* name, uint32_t& hex) {
    for (const auto& entry : COLOR_KEYWORDS) {
        if (iequals(name, entry.name)) {
            hex = entry.hex;
            return true;
        }
    }
    return false;
}

Color& Color::setRGB(double r, double g, double b, ColorSpace colorSpace) {
    this->r = r;
    this->g = g;
    this->b = b;
    colorSpaceToWorking(*this, colorSpace);
    return *this;
}

Color& Color::setScalar(double scalar) {
    r = scalar;
    g = scalar;
    b = scalar;
    return *this;
}

Color& Color::setHex(double hex, ColorSpace colorSpace) {
    // JS shifts the 32-bit pattern, so only the low 32 bits of a 0xRRGGBB integer are read.
    const auto bits = static_cast<uint32_t>(static_cast<int64_t>(std::floor(hex)));
    r = static_cast<double>((bits >> 16) & 255u) / 255;
    g = static_cast<double>((bits >> 8) & 255u) / 255;
    b = static_cast<double>(bits & 255u) / 255;
    colorSpaceToWorking(*this, colorSpace);
    return *this;
}

Color& Color::setHSL(double h, double s, double l, ColorSpace colorSpace) {
    // h, s and l ranges are in 0.0 - 1.0
    h = euclideanModulo(h, 1);
    s = clamp(s, 0, 1);
    l = clamp(l, 0, 1);
    if (s == 0) {
        r = g = b = l;
    } else {
        const double p = l <= 0.5 ? l * (1 + s) : l + s - (l * s);
        const double q = (2 * l) - p;
        r = hue2rgb(q, p, h + 1.0 / 3.0);
        g = hue2rgb(q, p, h);
        b = hue2rgb(q, p, h - 1.0 / 3.0);
    }
    colorSpaceToWorking(*this, colorSpace);
    return *this;
}

Color& Color::setColorName(const char* style, ColorSpace colorSpace) {
    uint32_t hex = 0;
    if (colorNameHex(style, hex)) return setHex(static_cast<double>(hex), colorSpace);
    return *this;
}

Color& Color::setStyle(const char* style, ColorSpace colorSpace) {
    // #rgb and #rrggbb
    if (style[0] == '#') {
        const char* digits = style + 1;
        size_t length = 0;
        while (digits[length] != '\0') ++length;
        auto hexDigit = [](char c) -> int {
            if (c >= '0' && c <= '9') return c - '0';
            if (c >= 'a' && c <= 'f') return c - 'a' + 10;
            if (c >= 'A' && c <= 'F') return c - 'A' + 10;
            return -1;
        };
        if (length == 3) {
            const int dr = hexDigit(digits[0]), dg = hexDigit(digits[1]), db = hexDigit(digits[2]);
            if (dr >= 0 && dg >= 0 && db >= 0)
                return setRGB(dr / 15.0, dg / 15.0, db / 15.0, colorSpace);
            return *this;
        }
        if (length == 6) {
            uint32_t value = 0;
            for (size_t i = 0; i < 6; ++i) {
                const int digit = hexDigit(digits[i]);
                if (digit < 0) return *this;
                value = value * 16 + static_cast<uint32_t>(digit);
            }
            return setHex(static_cast<double>(value), colorSpace);
        }
        return *this;
    }
    // rgb(...), rgba(...), hsl(...) and hsla(...); three warns about an alpha and ignores it.
    const char* open = std::strchr(style, '(');
    if (open != nullptr) {
        const std::string_view name(style, open - style);
        const char* cursor = open + 1;
        if (name == "rgb" || name == "rgba") {
            const double first = scanUnsigned(cursor);
            const bool percent = scanPercent(cursor);
            if (!expectComma(cursor)) return *this;
            const double second = scanUnsigned(cursor);
            if (percent != scanPercent(cursor)) return *this;
            if (!expectComma(cursor)) return *this;
            const double third = scanUnsigned(cursor);
            if (percent != scanPercent(cursor)) return *this;
            if (std::isnan(first) || std::isnan(second) || std::isnan(third)) return *this;
            if (!skipAlpha(cursor)) return *this;
            // three's two rgb forms: 0..255 integers, or 0..100 percentages.
            if (percent) return setRGB(jsMin(100, first) / 100, jsMin(100, second) / 100,
                                      jsMin(100, third) / 100, colorSpace);
            return setRGB(jsMin(255, std::trunc(first)) / 255, jsMin(255, std::trunc(second)) / 255,
                          jsMin(255, std::trunc(third)) / 255, colorSpace);
        }
        if (name == "hsl" || name == "hsla") {
            const double h = scanNumber(cursor);
            if (!expectComma(cursor)) return *this;
            const double s = scanNumber(cursor);
            // three's hsl regex carries a `%` after both the saturation and the lightness.
            if (!scanPercent(cursor)) return *this;
            if (!expectComma(cursor)) return *this;
            const double l = scanNumber(cursor);
            if (!scanPercent(cursor)) return *this;
            if (std::isnan(h) || std::isnan(s) || std::isnan(l)) return *this;
            if (!skipAlpha(cursor)) return *this;
            return setHSL(h / 360, s / 100, l / 100, colorSpace);
        }
        return *this;
    }
    return setColorName(style, colorSpace);
}

Color& Color::copy(const Color& color) {
    r = color.r;
    g = color.g;
    b = color.b;
    return *this;
}

Color& Color::copySRGBToLinear(const Color& color) {
    r = srgbToLinear(color.r);
    g = srgbToLinear(color.g);
    b = srgbToLinear(color.b);
    return *this;
}

Color& Color::copyLinearToSRGB(const Color& color) {
    r = linearToSrgb(color.r);
    g = linearToSrgb(color.g);
    b = linearToSrgb(color.b);
    return *this;
}

Color& Color::convertSRGBToLinear() { return copySRGBToLinear(*this); }

Color& Color::convertLinearToSRGB() { return copyLinearToSRGB(*this); }

double Color::getHex(ColorSpace colorSpace) const {
    Color scratch(*this);
    workingToColorSpace(scratch, colorSpace);
    return jsRound(clamp(scratch.r * 255, 0, 255)) * 65536 +
           jsRound(clamp(scratch.g * 255, 0, 255)) * 256 +
           jsRound(clamp(scratch.b * 255, 0, 255));
}

std::string Color::getHexString(ColorSpace colorSpace) const {
    const double hex = getHex(colorSpace);
    // A non-finite colour has no six-digit spelling; three slices its "NaN" text, this says "NaN".
    if (!(hex >= 0) || hex > 0xFFFFFF) return "NaN";
    char buffer[8];
    std::snprintf(buffer, sizeof buffer, "%06x", static_cast<unsigned>(hex));
    return buffer;
}

IColorHsl Color::getHSL(ColorSpace colorSpace) const {
    // h, s and l ranges are in 0.0 - 1.0
    Color scratch(*this);
    workingToColorSpace(scratch, colorSpace);
    const double cr = scratch.r, cg = scratch.g, cb = scratch.b;
    const double max = jsMax(cr, jsMax(cg, cb));
    const double min = jsMin(cr, jsMin(cg, cb));
    double hue = 0, saturation = 0;
    const double lightness = (min + max) / 2.0;
    if (min == max) {
        hue = 0;
        saturation = 0;
    } else {
        const double delta = max - min;
        saturation = lightness <= 0.5 ? delta / (max + min) : delta / (2 - max - min);
        if (max == cr) {
            hue = (cg - cb) / delta + (cg < cb ? 6 : 0);
        } else if (max == cg) {
            hue = (cb - cr) / delta + 2;
        } else {
            hue = (cr - cg) / delta + 4;
        }
        hue /= 6;
    }
    return IColorHsl{hue, saturation, lightness};
}

std::array<double, 3> Color::getRGB(ColorSpace colorSpace) const {
    Color scratch(*this);
    workingToColorSpace(scratch, colorSpace);
    return {scratch.r, scratch.g, scratch.b};
}

Color& Color::offsetHSL(double h, double s, double l) {
    const IColorHsl hsl = getHSL();
    return setHSL(hsl.h + h, hsl.s + s, hsl.l + l);
}

Color& Color::add(const Color& color) {
    r += color.r;
    g += color.g;
    b += color.b;
    return *this;
}

Color& Color::addColors(const Color& color1, const Color& color2) {
    r = color1.r + color2.r;
    g = color1.g + color2.g;
    b = color1.b + color2.b;
    return *this;
}

Color& Color::addScalar(double s) {
    r += s;
    g += s;
    b += s;
    return *this;
}

Color& Color::sub(const Color& color) {
    r = jsMax(0, r - color.r);
    g = jsMax(0, g - color.g);
    b = jsMax(0, b - color.b);
    return *this;
}

Color& Color::multiply(const Color& color) {
    r *= color.r;
    g *= color.g;
    b *= color.b;
    return *this;
}

Color& Color::multiplyScalar(double s) {
    r *= s;
    g *= s;
    b *= s;
    return *this;
}

Color& Color::lerp(const Color& color, double alpha) {
    r += (color.r - r) * alpha;
    g += (color.g - g) * alpha;
    b += (color.b - b) * alpha;
    return *this;
}

Color& Color::lerpColors(const Color& color1, const Color& color2, double alpha) {
    r = color1.r + (color2.r - color1.r) * alpha;
    g = color1.g + (color2.g - color1.g) * alpha;
    b = color1.b + (color2.b - color1.b) * alpha;
    return *this;
}

Color& Color::lerpHSL(const Color& color, double alpha) {
    const IColorHsl a = getHSL();
    const IColorHsl b = color.getHSL();
    const double h = tn::engine::lerp(a.h, b.h, alpha);
    const double s = tn::engine::lerp(a.s, b.s, alpha);
    const double l = tn::engine::lerp(a.l, b.l, alpha);
    return setHSL(h, s, l);
}

Color& Color::setFromVector3(const Vector3& v) {
    r = v.x;
    g = v.y;
    b = v.z;
    return *this;
}

Color& Color::applyMatrix3(const Matrix3& m) {
    const double cr = r, cg = g, cb = b;
    const double* e = m.elements.data();
    r = e[0] * cr + e[3] * cg + e[6] * cb;
    g = e[1] * cr + e[4] * cg + e[7] * cb;
    b = e[2] * cr + e[5] * cg + e[8] * cb;
    return *this;
}

bool Color::equals(const Color& c) const { return c.r == r && c.g == g && c.b == b; }

Color& Color::fromArray(const double* array, int offset) {
    r = array[offset];
    g = array[offset + 1];
    b = array[offset + 2];
    return *this;
}

}  // namespace tn::engine
