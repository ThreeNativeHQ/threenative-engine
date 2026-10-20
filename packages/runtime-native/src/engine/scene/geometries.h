#pragma once

// The built-in geometry generators, ported from three@0.185.1 src/geometries/*.js. Every position,
// normal and uv array is a Float32BufferAttribute: three computes in binary64 and stores the float
// rounding, and so does this port. `parameters` carries the constructor arguments as JSON because a
// fixture reads the geometry's `parameters` object.

#include "engine/scene/curves.h"
#include "engine/scene/geometry.h"

#include <memory>
#include <optional>
#include <vector>

namespace tn::engine {

std::shared_ptr<BufferGeometry> makePlaneGeometry(double width = 1, double height = 1,
                                                  double widthSegments = 1, double heightSegments = 1);
std::shared_ptr<BufferGeometry> makeBoxGeometry(double width = 1, double height = 1, double depth = 1,
                                                double widthSegments = 1, double heightSegments = 1,
                                                double depthSegments = 1);
std::shared_ptr<BufferGeometry> makeSphereGeometry(double radius = 1, double widthSegments = 32,
                                                   double heightSegments = 16, double phiStart = 0,
                                                   double phiLength = 6.283185307179586,
                                                   double thetaStart = 0,
                                                   double thetaLength = 3.141592653589793);
std::shared_ptr<BufferGeometry> makeCylinderGeometry(double radiusTop = 1, double radiusBottom = 1,
                                                     double height = 1, double radialSegments = 32,
                                                     double heightSegments = 1, bool openEnded = false,
                                                     double thetaStart = 0,
                                                     double thetaLength = 6.283185307179586);
std::shared_ptr<BufferGeometry> makeConeGeometry(double radius = 1, double height = 1,
                                                 double radialSegments = 32, double heightSegments = 1,
                                                 bool openEnded = false, double thetaStart = 0,
                                                 double thetaLength = 6.283185307179586);
std::shared_ptr<BufferGeometry> makeCircleGeometry(double radius = 1, double segments = 32,
                                                   double thetaStart = 0,
                                                   double thetaLength = 6.283185307179586);
std::shared_ptr<BufferGeometry> makeIcosahedronGeometry(double radius = 1, double detail = 0);
std::shared_ptr<BufferGeometry> makeOctahedronGeometry(double radius = 1, double detail = 0);
std::shared_ptr<BufferGeometry> makeDodecahedronGeometry(double radius = 1, double detail = 0);
std::shared_ptr<BufferGeometry> makePolyhedronGeometry(const std::vector<double>& vertices,
                                                       const std::vector<uint32_t>& indices,
                                                       double radius = 1, double detail = 0);
std::shared_ptr<BufferGeometry> makeCapsuleGeometry(double radius = 1, double height = 1,
                                                    double capSegments = 4, double radialSegments = 8,
                                                    double heightSegments = 1);
std::shared_ptr<BufferGeometry> makeTorusGeometry(double radius = 1, double tube = 0.4,
                                                  double radialSegments = 12, double tubularSegments = 48,
                                                  double arc = 6.283185307179586, double thetaStart = 0,
                                                  double thetaLength = 6.283185307179586);
std::shared_ptr<BufferGeometry> makeTorusKnotGeometry(double radius = 1, double tube = 0.4,
                                                      double tubularSegments = 64, double radialSegments = 8,
                                                      double p = 2, double q = 3);
std::shared_ptr<BufferGeometry> makeRingGeometry(double innerRadius = 0.5, double outerRadius = 1,
                                                 double thetaSegments = 32, double phiSegments = 1,
                                                 double thetaStart = 0,
                                                 double thetaLength = 6.283185307179586);
/** three/addons RoundedBoxGeometry(width, height, depth, segments, radius). */
std::shared_ptr<BufferGeometry> makeRoundedBoxGeometry(double width = 1, double height = 1, double depth = 1,
                                                       double segments = 2, double radius = 0.1);

/** `points` is the profile, at least two of them; three's own default profile is the caller's. */
std::shared_ptr<BufferGeometry> makeLatheGeometry(const std::vector<Vector2>& points, double segments = 12,
                                                  double phiStart = 0,
                                                  double phiLength = 6.283185307179586);

std::shared_ptr<BufferGeometry> makeTubeGeometry(const Curve& path, double tubularSegments = 64,
                                                 double radius = 1, double radialSegments = 8,
                                                 bool closed = false);

/** One shape, or (`asArray`) an array of them with one group each, as three's ShapeGeometry. */
std::shared_ptr<BufferGeometry> makeShapeGeometry(const std::vector<std::shared_ptr<Shape>>& shapes, bool asArray,
                                                  double curveSegments = 12);

/** three's ExtrudeGeometry options; an empty one takes three's default. extrudePath and UVGenerator are not carried. */
struct ExtrudeOptions {
    std::optional<double> curveSegments, steps, depth, bevelThickness, bevelSize, bevelOffset, bevelSegments;
    std::optional<bool> bevelEnabled;
};

std::shared_ptr<BufferGeometry> makeExtrudeGeometry(const std::vector<std::shared_ptr<Shape>>& shapes,
                                                    const ExtrudeOptions& options);

}  // namespace tn::engine
