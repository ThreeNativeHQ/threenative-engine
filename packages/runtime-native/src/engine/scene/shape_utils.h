#pragma once

// three's ShapeUtils and the earcut it triangulates with: three@0.185.1 src/extras/ShapeUtils.js and
// src/extras/lib/earcut.js (mapbox/earcut 3.0.2), ported operation for operation so the triangle
// order matches three's.

#include "engine/foundation/math/Vector.h"

#include <array>
#include <cstdint>
#include <vector>

namespace tn::engine {

/** mapbox/earcut: flat 2D coordinates, the index where each hole starts; triangle vertex indices. */
std::vector<uint32_t> earcut(const std::vector<double>& data, const std::vector<uint32_t>& holeIndices);

namespace ShapeUtils {

double area(const std::vector<Vector2>& contour);
bool isClockWise(const std::vector<Vector2>& pts);
/** Drops a repeated closing point from `contour` and each hole first, as three does in place. */
std::vector<std::array<uint32_t, 3>> triangulateShape(std::vector<Vector2>& contour,
                                                      std::vector<std::vector<Vector2>>& holes);

}  // namespace ShapeUtils

}  // namespace tn::engine
