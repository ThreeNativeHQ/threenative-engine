#include "engine/animation/interpolant.h"

#include <cmath>
#include <cstddef>
#include <limits>

#include "engine/foundation/math/ieee754.h"

namespace tn::engine::animation {

namespace {
constexpr double kUndefined = std::numeric_limits<double>::quiet_NaN(); // compares false, as undefined does
}

void slerpFlat(double* dst, const double* src0, const double* src1, double t) {
    double x0 = src0[0], y0 = src0[1], z0 = src0[2], w0 = src0[3];
    double x1 = src1[0], y1 = src1[1], z1 = src1[2], w1 = src1[3];
    if (w0 != w1 || x0 != x1 || y0 != y1 || z0 != z1) {
        double dot = x0 * x1 + y0 * y1 + z0 * z1 + w0 * w1;
        if (dot < 0) {
            x1 = -x1;
            y1 = -y1;
            z1 = -z1;
            w1 = -w1;
            dot = -dot;
        }
        double s = 1 - t;
        if (dot < 0.9995) {
            const double theta = ieee754::acos(dot);
            const double sin = ieee754::sin(theta);
            s = ieee754::sin(s * theta) / sin;
            t = ieee754::sin(t * theta) / sin;
            x0 = x0 * s + x1 * t;
            y0 = y0 * s + y1 * t;
            z0 = z0 * s + z1 * t;
            w0 = w0 * s + w1 * t;
        } else {
            x0 = x0 * s + x1 * t;
            y0 = y0 * s + y1 * t;
            z0 = z0 * s + z1 * t;
            w0 = w0 * s + w1 * t;
            const double f = 1 / std::sqrt(x0 * x0 + y0 * y0 + z0 * z0 + w0 * w0);
            x0 *= f;
            y0 *= f;
            z0 *= f;
            w0 *= f;
        }
    }
    dst[0] = x0;
    dst[1] = y0;
    dst[2] = z0;
    dst[3] = w0;
}

void multiplyQuaternionsFlat(double* dst, const double* src0, const double* src1) {
    const double x0 = src0[0], y0 = src0[1], z0 = src0[2], w0 = src0[3];
    const double x1 = src1[0], y1 = src1[1], z1 = src1[2], w1 = src1[3];
    dst[0] = x0 * w1 + w0 * x1 + y0 * z1 - z0 * y1;
    dst[1] = y0 * w1 + w0 * y1 + z0 * x1 - x0 * z1;
    dst[2] = z0 * w1 + w0 * z1 + x0 * y1 - y0 * x1;
    dst[3] = w0 * w1 - x0 * x1 - y0 * y1 - z0 * z1;
}

Interpolant::Interpolant(Interpolation kind, std::span<const double> times, std::span<const double> values,
                         std::size_t valueSize)
    : kind_(kind), times_(times), values_(values), valueSize_(valueSize), own_(valueSize, 0.0), result_(own_.data()) {}

// three's Interpolant.evaluate, label for label: `goto` stands for its labelled breaks. Invariant:
// t1 is pp[i1] and t0 is pp[i1 - 1], with an index outside the array reading as undefined.
std::span<const double> Interpolant::evaluate(double t) {
    const auto n = static_cast<std::ptrdiff_t>(times_.size());
    if (n == 0)
        return {result_, valueSize_}; // a track refuses an empty time array before it creates one
    const auto pp = [&](std::ptrdiff_t i) { return i >= 0 && i < n ? times_[i] : kUndefined; };
    const auto undefinedAt = [&](std::ptrdiff_t i) { return i < 0 || i >= n; };
    auto i1 = static_cast<std::ptrdiff_t>(cachedIndex_);
    double t1 = pp(i1), t0 = pp(i1 - 1);
    std::ptrdiff_t right = 0;

    if (!(t < t1)) { // forward_scan
        for (const std::ptrdiff_t giveUpAt = i1 + 2;;) {
            if (undefinedAt(i1)) {
                if (t < t0)
                    goto backward_scan; // break forward_scan
                cachedIndex_ = static_cast<std::size_t>(n);
                return copySampleValue(static_cast<std::size_t>(n - 1));
            }
            if (i1 == giveUpAt)
                break;
            t0 = t1;
            t1 = pp(++i1);
            if (t < t1)
                goto seek_done; // break seek
        }
        right = n;
        goto binary_search; // break linear_scan
    }
backward_scan:
    if (!(t >= t0)) {
        const double t1global = pp(1);
        if (t < t1global) {
            i1 = 2; // + 1, using the scan for the details
            t0 = t1global;
        }
        for (const std::ptrdiff_t giveUpAt = i1 - 2;;) {
            if (undefinedAt(i1 - 1)) {
                cachedIndex_ = 0;
                return copySampleValue(0);
            }
            if (i1 == giveUpAt)
                break;
            t1 = t0;
            t0 = pp(--i1 - 1);
            if (t >= t0)
                goto seek_done; // break seek
        }
        right = i1;
        i1 = 0;
        goto binary_search; // break linear_scan
    }
    goto interval_valid; // break validate_interval

binary_search:
    while (i1 < right) {
        const std::ptrdiff_t mid = (i1 + right) >> 1;
        if (t < pp(mid))
            right = mid;
        else
            i1 = mid + 1;
    }
    t1 = pp(i1);
    t0 = pp(i1 - 1);
    if (undefinedAt(i1 - 1)) {
        cachedIndex_ = 0;
        return copySampleValue(0);
    }
    if (undefinedAt(i1)) {
        cachedIndex_ = static_cast<std::size_t>(n);
        return copySampleValue(static_cast<std::size_t>(n - 1));
    }
seek_done:
    cachedIndex_ = static_cast<std::size_t>(i1);
    intervalChanged(static_cast<std::size_t>(i1), t0, t1);
interval_valid:
    return interpolate(static_cast<std::size_t>(i1), t0, t, t1);
}

std::span<const double> Interpolant::copySampleValue(std::size_t index) {
    const std::size_t offset = index * valueSize_;
    for (std::size_t i = 0; i != valueSize_; ++i)
        store(i, values_[offset + i]);
    return {result_, valueSize_};
}

// CubicInterpolant.intervalChanged_; the other interpolants keep no per-interval state.
void Interpolant::intervalChanged(std::size_t i1, double t0, double t1) {
    if (kind_ != Interpolation::Smooth)
        return;
    const auto n = static_cast<std::ptrdiff_t>(times_.size());
    const auto pp = [&](std::ptrdiff_t i) { return i >= 0 && i < n ? times_[i] : kUndefined; };
    auto iPrev = static_cast<std::ptrdiff_t>(i1) - 2, iNext = static_cast<std::ptrdiff_t>(i1) + 1;
    double tPrev = pp(iPrev), tNext = pp(iNext);
    if (iPrev < 0) {
        switch (settings->endingStart) {
        case Ending::ZeroSlope:
            iPrev = static_cast<std::ptrdiff_t>(i1);
            tPrev = 2 * t0 - t1;
            break;
        case Ending::WrapAround:
            iPrev = n - 2;
            tPrev = t0 + pp(iPrev) - pp(iPrev + 1);
            break;
        case Ending::ZeroCurvature:
            iPrev = static_cast<std::ptrdiff_t>(i1);
            tPrev = t1;
        }
    }
    if (iNext >= n) {
        switch (settings->endingEnd) {
        case Ending::ZeroSlope:
            iNext = static_cast<std::ptrdiff_t>(i1);
            tNext = 2 * t1 - t0;
            break;
        case Ending::WrapAround:
            iNext = 1;
            tNext = t1 + pp(1) - pp(0);
            break;
        case Ending::ZeroCurvature:
            iNext = static_cast<std::ptrdiff_t>(i1) - 1;
            tNext = t0;
        }
    }
    const double halfDt = (t1 - t0) * 0.5;
    weightPrev_ = halfDt / (t0 - tPrev);
    weightNext_ = halfDt / (tNext - t1);
    offsetPrev_ = static_cast<std::size_t>(iPrev) * valueSize_;
    offsetNext_ = static_cast<std::size_t>(iNext) * valueSize_;
}

std::span<const double> Interpolant::interpolate(std::size_t i1, double t0, double t, double t1) {
    const std::size_t stride = valueSize_, o1 = i1 * stride, o0 = o1 - stride;
    const std::span<const double> v = values_;
    switch (kind_) {
    case Interpolation::Discrete:
        return copySampleValue(i1 - 1);
    case Interpolation::Linear: {
        const double weight1 = (t - t0) / (t1 - t0), weight0 = 1 - weight1;
        for (std::size_t i = 0; i != stride; ++i)
            store(i, v[o0 + i] * weight0 + v[o1 + i] * weight1);
        break;
    }
    case Interpolation::Smooth: {
        const double wP = weightPrev_, wN = weightNext_;
        const double p = (t - t0) / (t1 - t0), pp = p * p, ppp = pp * p;
        const double sP = -wP * ppp + 2 * wP * pp - wP * p;
        const double s0 = (1 + wP) * ppp + (-1.5 - 2 * wP) * pp + (-0.5 + wP) * p + 1;
        const double s1 = (-1 - wN) * ppp + (1.5 + wN) * pp + 0.5 * p;
        const double sN = wN * ppp - wN * pp;
        for (std::size_t i = 0; i != stride; ++i)
            store(i, sP * v[offsetPrev_ + i] + s0 * v[o0 + i] + s1 * v[o1 + i] + sN * v[offsetNext_ + i]);
        break;
    }
    case Interpolation::QuaternionLinear: {
        const double alpha = (t - t0) / (t1 - t0);
        // three passes dstOffset 0 on every pass, as a quaternion track's value is one quaternion.
        for (std::size_t offset = o1, end = o1 + stride; offset != end; offset += 4) {
            double q[4];
            slerpFlat(q, &v[offset - stride], &v[offset], alpha);
            for (std::size_t i = 0; i != 4; ++i)
                store(i, q[i]);
        }
        break;
    }
    }
    return {result_, valueSize_};
}

} // namespace tn::engine::animation
