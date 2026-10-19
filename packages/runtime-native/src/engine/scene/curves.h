#pragma once

// three's curves, ported from three@0.185.1 src/extras/core/{Curve,CurvePath,Path,Shape}.js and
// src/extras/curves/*.js: Curve over Vector3 (CatmullRomCurve3) and over Vector2 (the segments a
// Path is drawn from). Transcendentals go through the engine's V8 fdlibm port, so every point
// matches the browser bit for bit.

#include "engine/foundation/math/Vector.h"

#include <memory>
#include <string>
#include <vector>

namespace tn::engine {

template <class V>
class CurveT {
public:
    virtual ~CurveT() = default;
    [[nodiscard]] virtual V getPoint(double t) const = 0;
    [[nodiscard]] virtual V getPointAt(double u) const;
    [[nodiscard]] virtual std::vector<V> getPoints(double divisions = 5) const;
    [[nodiscard]] virtual std::vector<V> getSpacedPoints(double divisions = 5) const;
    [[nodiscard]] virtual double getLength() const;
    /** The cumulative arc lengths, cached as three caches them (same divisions, no needsUpdate). */
    [[nodiscard]] const std::vector<double>& getLengths(double divisions) const;
    [[nodiscard]] const std::vector<double>& getLengths() const { return getLengths(arcLengthDivisions); }
    virtual void updateArcLengths();
    /** `distance` is three's optional target arc length; 0 (falsy in three) maps `u` instead. */
    [[nodiscard]] double getUtoTmapping(double u, double distance = 0) const;
    [[nodiscard]] virtual V getTangent(double t) const;
    [[nodiscard]] virtual V getTangentAt(double u) const;

    std::string type = "Curve";
    double arcLengthDivisions = 200;
    mutable bool needsUpdate = false;

private:
    mutable std::vector<double> cacheArcLengths_;
};

using Curve = CurveT<Vector3>;
using Curve2 = CurveT<Vector2>;

struct FrenetFrames {
    std::vector<Vector3> tangents;
    std::vector<Vector3> normals;
    std::vector<Vector3> binormals;
};

/** three's Curve.computeFrenetFrames, for the 3D curves it is defined on. */
[[nodiscard]] FrenetFrames computeFrenetFrames(const Curve& curve, double segments, bool closed = false);

class CatmullRomCurve3 final : public Curve {
public:
    /** The points are the caller's own Vector3s, shared as three keeps the array it is handed. */
    CatmullRomCurve3(std::vector<std::shared_ptr<Vector3>> points, bool closed, std::string curveType,
                     double tension);
    [[nodiscard]] Vector3 getPoint(double t) const override;

    std::vector<std::shared_ptr<Vector3>> points;
    bool closed = false;
    std::string curveType = "centripetal";
    double tension = 0.5;
};

// ------------------------------------------------------------------------------- 2D segments

class LineCurve final : public Curve2 {
public:
    LineCurve(Vector2 v1, Vector2 v2) : v1(v1), v2(v2) { type = "LineCurve"; }
    [[nodiscard]] Vector2 getPoint(double t) const override;
    [[nodiscard]] Vector2 getPointAt(double u) const override { return getPoint(u); }
    [[nodiscard]] Vector2 getTangent(double t) const override;
    [[nodiscard]] Vector2 getTangentAt(double u) const override { return getTangent(u); }
    Vector2 v1, v2;
};

class QuadraticBezierCurve final : public Curve2 {
public:
    QuadraticBezierCurve(Vector2 v0, Vector2 v1, Vector2 v2) : v0(v0), v1(v1), v2(v2) { type = "QuadraticBezierCurve"; }
    [[nodiscard]] Vector2 getPoint(double t) const override;
    Vector2 v0, v1, v2;
};

class CubicBezierCurve final : public Curve2 {
public:
    CubicBezierCurve(Vector2 v0, Vector2 v1, Vector2 v2, Vector2 v3) : v0(v0), v1(v1), v2(v2), v3(v3) {
        type = "CubicBezierCurve";
    }
    [[nodiscard]] Vector2 getPoint(double t) const override;
    Vector2 v0, v1, v2, v3;
};

class EllipseCurve final : public Curve2 {
public:
    EllipseCurve(double aX, double aY, double xRadius, double yRadius, double aStartAngle, double aEndAngle,
                 bool aClockwise, double aRotation)
        : aX(aX), aY(aY), xRadius(xRadius), yRadius(yRadius), aStartAngle(aStartAngle), aEndAngle(aEndAngle),
          aClockwise(aClockwise), aRotation(aRotation) {
        type = "EllipseCurve";
    }
    [[nodiscard]] Vector2 getPoint(double t) const override;
    double aX, aY, xRadius, yRadius, aStartAngle, aEndAngle;
    bool aClockwise;
    double aRotation;
};

class SplineCurve final : public Curve2 {
public:
    explicit SplineCurve(std::vector<Vector2> points) : points(std::move(points)) { type = "SplineCurve"; }
    [[nodiscard]] Vector2 getPoint(double t) const override;
    std::vector<Vector2> points;
};

// --------------------------------------------------------------------------- Path and Shape

/** three's CurvePath of 2D segments and the Path drawing commands on it. */
class Path : public Curve2 {
public:
    Path() { type = "Path"; }
    explicit Path(const std::vector<Vector2>& points);
    [[nodiscard]] Vector2 getPoint(double t) const override;
    [[nodiscard]] double getLength() const override;
    void updateArcLengths() override;
    [[nodiscard]] const std::vector<double>& getCurveLengths() const;
    [[nodiscard]] std::vector<Vector2> getSpacedPoints(double divisions = 40) const override;
    [[nodiscard]] std::vector<Vector2> getPoints(double divisions = 12) const override;
    Path& closePath();

    Path& setFromPoints(const std::vector<Vector2>& points);
    Path& moveTo(double x, double y);
    Path& lineTo(double x, double y);
    Path& quadraticCurveTo(double aCPx, double aCPy, double aX, double aY);
    Path& bezierCurveTo(double aCP1x, double aCP1y, double aCP2x, double aCP2y, double aX, double aY);
    Path& splineThru(const std::vector<Vector2>& pts);
    Path& arc(double aX, double aY, double aRadius, double aStartAngle, double aEndAngle, bool aClockwise);
    Path& absarc(double aX, double aY, double aRadius, double aStartAngle, double aEndAngle, bool aClockwise);
    Path& ellipse(double aX, double aY, double xRadius, double yRadius, double aStartAngle, double aEndAngle,
                  bool aClockwise, double aRotation);
    Path& absellipse(double aX, double aY, double xRadius, double yRadius, double aStartAngle, double aEndAngle,
                     bool aClockwise, double aRotation);

    std::vector<std::shared_ptr<Curve2>> curves;
    bool autoClose = false;
    Vector2 currentPoint;

private:
    mutable std::vector<double> cacheLengths_;
};

class Shape final : public Path {
public:
    Shape() { type = "Shape"; }
    explicit Shape(const std::vector<Vector2>& points) : Path(points) { type = "Shape"; }
    /** three's extractPoints: the outline and each hole at `divisions`. */
    [[nodiscard]] std::vector<Vector2> extractShape(double divisions) const { return getPoints(divisions); }
    [[nodiscard]] std::vector<std::vector<Vector2>> extractHoles(double divisions) const;

    /** The caller's own paths, as three keeps the array a game pushes holes into. */
    std::vector<std::shared_ptr<Path>> holes;
};

}  // namespace tn::engine
