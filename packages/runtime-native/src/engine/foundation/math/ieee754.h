// Copyright 2016 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.
//
// The functions declared here are V8's own fdlibm port (src/base/ieee754.cc at V8 11.3.244, the
// V8 in node 20.19.6). three runs on V8, so the reference math class is these algorithms, not the
// platform libm: glibc differs from V8 by up to 1 ulp on a few percent of arguments, and one
// differing bit inside a rotation is 32 ulps of cancellation in the caller's result. Using these
// makes the native math bit-identical to the browser and identical on every platform.

#pragma once

namespace tn::engine::ieee754 {

/** Returns the arc sine of |x|, the value whose sine is |x|. NaN outside [-1, 1]. */
double asin(double x);

/** Returns the arc cosine of |x|, the value whose cosine is |x|. NaN outside [-1, 1]. */
double acos(double x);

/** Returns atan(|y/x|), with the signs of both arguments selecting the quadrant. */
double atan2(double y, double x);

/** Returns the arc tangent of |x|, the value whose tangent is |x|. */
double atan(double x);

/** Returns the cosine of |x| in radians. */
double cos(double x);

/** Returns the sine of |x| in radians. */
double sin(double x);

/** Both results, bit-identical to sin/cos, with one shared argument reduction. */
void sincos(double x, double& sine, double& cosine);

/** Returns the tangent of |x| in radians; NaN (with a signal) at an infinity. */
double tan(double x);

/**
 * Returns |x| to the power of |y|.
 *
 * The result for a base of 1 or -1 and an exponent of +/-Infinity differs from IEEE 754-2008.
 * The historical ECMAScript behavior, which the reference follows, is preserved.
 */
double pow(double x, double y);

}  // namespace tn::engine::ieee754
