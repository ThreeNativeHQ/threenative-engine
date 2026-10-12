#pragma once

#include <cstddef>
#include <memory>
#include <span>
#include <vector>

namespace tn::engine::animation {

/** three's interpolation modes a keyframe track creates its interpolant from. */
enum class Interpolation { Discrete, Linear, Smooth, QuaternionLinear };

/** three's cubic endings: ZeroCurvatureEnding, ZeroSlopeEnding, WrapAroundEnding. */
enum class Ending { ZeroCurvature, ZeroSlope, WrapAround };

/** three's interpolant `settings`: an action shares one object across all its interpolants. */
struct InterpolantSettings {
    Ending endingStart = Ending::ZeroCurvature;
    Ending endingEnd = Ending::ZeroCurvature;
};

/** Quaternion.slerpFlat: reads both sources before writing `dst`, so `dst` may alias either. */
void slerpFlat(double* dst, const double* src0, const double* src1, double t);
/** Quaternion.multiplyQuaternionsFlat, same aliasing rule. */
void multiplyQuaternionsFlat(double* dst, const double* src0, const double* src1);

/**
 * three's Interpolant with its four subclasses (PRD-516): the same interval search with its cached
 * index, the same binary64 arithmetic and V8's own acos and sin. Times and values are the track's
 * arrays as doubles (a Float32Array element read in JavaScript is exactly that double); they must
 * outlive the interpolant. The result goes to the interpolant's own buffer, rounded to float32 like
 * the Float32Array a track's interpolant writes, until `setResultBuffer` points it at a mixer's
 * Float64Array region, as AnimationMixer does.
 */
class Interpolant {
  public:
    Interpolant(Interpolation kind, std::span<const double> times, std::span<const double> values,
                std::size_t valueSize);
    Interpolant(const Interpolant&) = delete;
    Interpolant& operator=(const Interpolant&) = delete;

    /** The value at `t`, in the result buffer (three's `evaluate`). */
    std::span<const double> evaluate(double t);

    /** three's `resultBuffer = binding.buffer`: writes go to `buffer` unrounded from now on. */
    void setResultBuffer(double* buffer) {
        result_ = buffer;
        float32_ = false;
    }

    /** The cubic endings, shared like three's `settings` object; read when the interval changes. */
    std::shared_ptr<const InterpolantSettings> settings = std::make_shared<InterpolantSettings>();

  private:
    std::span<const double> copySampleValue(std::size_t index);
    void intervalChanged(std::size_t i1, double t0, double t1);
    std::span<const double> interpolate(std::size_t i1, double t0, double t, double t1);
    void store(std::size_t i, double value) {
        result_[i] = float32_ ? static_cast<double>(static_cast<float>(value)) : value;
    }

    Interpolation kind_;
    std::span<const double> times_;
    std::span<const double> values_;
    std::size_t valueSize_;
    std::vector<double> own_;
    double* result_;
    bool float32_ = true;
    std::size_t cachedIndex_ = 0;
    // CubicInterpolant's per-interval state, -0 until the first interval like three's.
    double weightPrev_ = -0.0, weightNext_ = -0.0;
    std::size_t offsetPrev_ = 0, offsetNext_ = 0;
};

} // namespace tn::engine::animation
