#pragma once

// The scalar helpers where JS and C++ disagree (three@0.185.1 src/math/MathUtils.js). Every rule
// here exists because the reference spells it differently from the obvious C++ spelling, and the
// differential fixtures compare binary64 bits.

#include <cmath>
#include <limits>
#include <numbers>

namespace tn::engine {

/** `Math.PI`. std::numbers::pi_v is the same binary64 value JS holds. */
inline constexpr double PI = std::numbers::pi_v<double>;

inline constexpr double QUIET_NAN = std::numeric_limits<double>::quiet_NaN();

/** `Math.min`: a NaN operand poisons the result and `Math.min(+0, -0)` is -0. std::min does neither. */
inline double jsMin(double a, double b) {
    if (std::isnan(a) || std::isnan(b)) return QUIET_NAN;
    if (a == b) return std::signbit(b) ? b : a;
    return a < b ? a : b;
}

/** `Math.max`: a NaN operand poisons the result and `Math.max(+0, -0)` is +0. */
inline double jsMax(double a, double b) {
    if (std::isnan(a) || std::isnan(b)) return QUIET_NAN;
    if (a == b) return std::signbit(a) ? b : a;
    return a > b ? a : b;
}

/** three's `clamp`: `Math.max(min, Math.min(max, value))`, so a NaN survives the whole trip. */
inline double clamp(double value, double lo, double hi) { return jsMax(lo, jsMin(hi, value)); }

/** three's `euclideanModulo`: `((n % m) + m) % m` over fmod, which never answers negative for m > 0. */
inline double euclideanModulo(double n, double m) { return std::fmod(std::fmod(n, m) + m, m); }

/** three's `lerp`: `(1 - t) * x + t * y`, in that order, so a t of 1 is not exactly y. */
inline double lerp(double x, double y, double t) { return (1 - t) * x + t * y; }

/** three's `DEG2RAD`, one binary64 value; `degToRad` multiplies by it, it does not divide by 180. */
inline constexpr double DEG2RAD = PI / 180.0;

/** three's `degToRad`: `degrees * DEG2RAD`, so the product rounds once, by the pinned constant. */
inline double degToRad(double degrees) { return degrees * DEG2RAD; }

/**
 * `Math.round`: ties go toward +Infinity (`Math.round(-1.5)` is -1), and a zero result keeps the
 * input's sign (`Math.round(-0.5)` is -0). std::round rounds halves away from zero and loses that.
 */
inline double jsRound(double x) {
    const double floor = std::floor(x);
    const double rounded = (x - floor >= 0.5) ? floor + 1 : floor;
    return rounded == 0 && x < 0 ? -0.0 : rounded;
}

/** `value || 1`, the guard three uses before dividing by a length: zero and NaN both answer 1. */
inline double orOne(double value) { return value == 0 || std::isnan(value) ? 1 : value; }

/** The coordinate systems three's projection math distinguishes (three's 2000 and 2001 constants). */
enum class CoordinateSystem : int { WebGL = 2000, WebGPU = 2001 };

}  // namespace tn::engine
