// three's curves, ported from three@0.185.1. Transcendentals go through the engine's V8 fdlibm port,
// so every point matches the browser bit for bit.

#include "engine/scene/curves.h"

#include "engine/foundation/math/Matrix.h"
#include "engine/foundation/math/ieee754.h"

#include <algorithm>
#include <cfloat>
#include <cmath>
#include <stdexcept>
#include <utility>

namespace tn::engine {

// ---------------------------------------------------------------------------------- Curve

template <class V>
V CurveT<V>::getPointAt(double u) const { return getPoint(getUtoTmapping(u)); }

template <class V>
std::vector<V> CurveT<V>::getPoints(double divisions) const {
    std::vector<V> points;
    for (double d = 0; d <= divisions; d += 1) points.push_back(getPoint(d / divisions));
    return points;
}

template <class V>
std::vector<V> CurveT<V>::getSpacedPoints(double divisions) const {
    std::vector<V> points;
    for (double d = 0; d <= divisions; d += 1) points.push_back(getPointAt(d / divisions));
    return points;
}

template <class V>
double CurveT<V>::getLength() const { return getLengths().back(); }

template <class V>
const std::vector<double>& CurveT<V>::getLengths(double divisions) const {
    if (!cacheArcLengths_.empty() && static_cast<double>(cacheArcLengths_.size()) == divisions + 1 && !needsUpdate)
        return cacheArcLengths_;
    needsUpdate = false;
    std::vector<double> cache{0};
    V last = getPoint(0);
    double sum = 0;
    for (double p = 1; p <= divisions; p += 1) {
        const V current = getPoint(p / divisions);
        sum += current.distanceTo(last);
        cache.push_back(sum);
        last = current;
    }
    cacheArcLengths_ = std::move(cache);
    return cacheArcLengths_;
}

template <class V>
void CurveT<V>::updateArcLengths() {
    needsUpdate = true;
    (void)getLengths();
}

template <class V>
double CurveT<V>::getUtoTmapping(double u, double distance) const {
    const std::vector<double>& arcLengths = getLengths();
    const auto il = static_cast<long long>(arcLengths.size());
    const double targetArcLength = distance != 0 && !std::isnan(distance) ? distance : u * arcLengths[il - 1];
    long long low = 0;
    long long high = il - 1;
    while (low <= high) {
        const long long i = low + (high - low) / 2;
        const double comparison = arcLengths[i] - targetArcLength;
        if (comparison < 0) {
            low = i + 1;
        } else if (comparison > 0) {
            high = i - 1;
        } else {
            high = i;
            break;
        }
    }
    const long long i = high;
    if (arcLengths[i] == targetArcLength) return static_cast<double>(i) / static_cast<double>(il - 1);
    const double lengthBefore = arcLengths[i];
    const double lengthAfter = arcLengths[i + 1];
    const double segmentFraction = (targetArcLength - lengthBefore) / (lengthAfter - lengthBefore);
    return (static_cast<double>(i) + segmentFraction) / static_cast<double>(il - 1);
}

template <class V>
V CurveT<V>::getTangent(double t) const {
    constexpr double delta = 0.0001;
    const double t1 = std::max(t - delta, 0.0);
    const double t2 = std::min(t + delta, 1.0);
    V tangent = getPoint(t2);
    tangent.sub(getPoint(t1)).normalize();
    return tangent;
}

template <class V>
V CurveT<V>::getTangentAt(double u) const { return getTangent(getUtoTmapping(u)); }

template class CurveT<Vector2>;
template class CurveT<Vector3>;

FrenetFrames computeFrenetFrames(const Curve& curve, double segments, bool closed) {
    FrenetFrames frames;
    std::vector<Vector3>& tangents = frames.tangents;
    std::vector<Vector3>& normals = frames.normals;
    std::vector<Vector3>& binormals = frames.binormals;
    for (double i = 0; i <= segments; i += 1) tangents.push_back(curve.getTangentAt(i / segments));
    normals.emplace_back();
    binormals.emplace_back();
    Vector3 normal;
    Vector3 vec;
    Matrix4 mat;
    double min = DBL_MAX;
    const double tx = std::abs(tangents[0].x);
    const double ty = std::abs(tangents[0].y);
    const double tz = std::abs(tangents[0].z);
    if (tx <= min) {
        min = tx;
        normal.set(1, 0, 0);
    }
    if (ty <= min) {
        min = ty;
        normal.set(0, 1, 0);
    }
    if (tz <= min) normal.set(0, 0, 1);
    vec.crossVectors(tangents[0], normal).normalize();
    normals[0].crossVectors(tangents[0], vec);
    binormals[0].crossVectors(tangents[0], normals[0]);
    for (size_t i = 1; i < tangents.size(); ++i) {
        normals.push_back(normals[i - 1]);
        binormals.push_back(binormals[i - 1]);
        vec.crossVectors(tangents[i - 1], tangents[i]);
        if (vec.length() > DBL_EPSILON) {
            vec.normalize();
            const double theta = ieee754::acos(std::clamp(tangents[i - 1].dot(tangents[i]), -1.0, 1.0));
            normals[i].applyMatrix4(mat.makeRotationAxis(vec, theta));
        }
        binormals[i].crossVectors(tangents[i], normals[i]);
    }
    if (closed) {
        const size_t last = tangents.size() - 1;
        double theta = ieee754::acos(std::clamp(normals[0].dot(normals[last]), -1.0, 1.0));
        theta /= segments;
        if (tangents[0].dot(vec.crossVectors(normals[0], normals[last])) > 0) theta = -theta;
        for (size_t i = 1; i <= last; ++i) {
            normals[i].applyMatrix4(mat.makeRotationAxis(tangents[i], theta * static_cast<double>(i)));
            binormals[i].crossVectors(tangents[i], normals[i]);
        }
    }
    return frames;
}

// ------------------------------------------------------------------------------- CatmullRom

CatmullRomCurve3::CatmullRomCurve3(std::vector<std::shared_ptr<Vector3>> points, bool closed,
                                   std::string curveType, double tension)
    : points(std::move(points)), closed(closed), curveType(std::move(curveType)), tension(tension) {
    type = "CatmullRomCurve3";
}

namespace {

/** three's CubicPoly: c0 + c1 t + c2 t^2 + c3 t^3. */
struct CubicPoly {
    double c0 = 0, c1 = 0, c2 = 0, c3 = 0;
    void init(double x0, double x1, double t0, double t1) {
        c0 = x0;
        c1 = t0;
        c2 = -3 * x0 + 3 * x1 - 2 * t0 - t1;
        c3 = 2 * x0 - 2 * x1 + t0 + t1;
    }
    void initCatmullRom(double x0, double x1, double x2, double x3, double tension) {
        init(x1, x2, tension * (x2 - x0), tension * (x3 - x1));
    }
    void initNonuniformCatmullRom(double x0, double x1, double x2, double x3, double dt0, double dt1,
                                  double dt2) {
        double t1 = (x1 - x0) / dt0 - (x2 - x0) / (dt0 + dt1) + (x2 - x1) / dt1;
        double t2 = (x2 - x1) / dt1 - (x3 - x1) / (dt1 + dt2) + (x3 - x2) / dt2;
        t1 *= dt1;
        t2 *= dt1;
        init(x1, x2, t1, t2);
    }
    [[nodiscard]] double calc(double t) const {
        const double t2 = t * t;
        const double t3 = t2 * t;
        return c0 + c1 * t + c2 * t2 + c3 * t3;
    }
};

// three's Interpolations.js.
double catmullRom(double t, double p0, double p1, double p2, double p3) {
    const double v0 = (p2 - p0) * 0.5;
    const double v1 = (p3 - p1) * 0.5;
    const double t2 = t * t;
    const double t3 = t * t2;
    return (2 * p1 - 2 * p2 + v0 + v1) * t3 + (-3 * p1 + 3 * p2 - 2 * v0 - v1) * t2 + v0 * t + p1;
}

double quadraticBezier(double t, double p0, double p1, double p2) {
    const double k = 1 - t;
    return k * k * p0 + 2 * (1 - t) * t * p1 + t * t * p2;
}

double cubicBezier(double t, double p0, double p1, double p2, double p3) {
    const double k = 1 - t;
    return k * k * k * p0 + 3 * k * k * t * p1 + 3 * (1 - t) * t * t * p2 + t * t * t * p3;
}

}  // namespace

Vector3 CatmullRomCurve3::getPoint(double t) const {
    const auto l = static_cast<double>(points.size());
    const double p = (l - (closed ? 0 : 1)) * t;
    double intPoint = std::floor(p);
    double weight = p - intPoint;
    if (closed) {
        intPoint += intPoint > 0 ? 0 : (std::floor(std::abs(intPoint) / l) + 1) * l;
    } else if (weight == 0 && intPoint == l - 1) {
        intPoint = l - 2;
        weight = 1;
    }
    const auto at = [&](double index) -> const Vector3& {
        return *points[static_cast<size_t>(std::fmod(index, l))];
    };
    Vector3 p0;
    Vector3 p3;
    if (closed || intPoint > 0) {
        p0 = at(intPoint - 1);
    } else {
        p0.subVectors(*points[0], *points[1]).add(*points[0]);
    }
    const Vector3& p1 = at(intPoint);
    const Vector3& p2 = at(intPoint + 1);
    if (closed || intPoint + 2 < l) {
        p3 = at(intPoint + 2);
    } else {
        p3.subVectors(*points[points.size() - 1], *points[points.size() - 2]).add(*points[points.size() - 1]);
    }
    CubicPoly px, py, pz;
    if (curveType == "centripetal" || curveType == "chordal") {
        const double pow = curveType == "chordal" ? 0.5 : 0.25;
        double dt0 = ieee754::pow(p0.distanceToSquared(p1), pow);
        double dt1 = ieee754::pow(p1.distanceToSquared(p2), pow);
        double dt2 = ieee754::pow(p2.distanceToSquared(p3), pow);
        if (dt1 < 1e-4) dt1 = 1.0;
        if (dt0 < 1e-4) dt0 = dt1;
        if (dt2 < 1e-4) dt2 = dt1;
        px.initNonuniformCatmullRom(p0.x, p1.x, p2.x, p3.x, dt0, dt1, dt2);
        py.initNonuniformCatmullRom(p0.y, p1.y, p2.y, p3.y, dt0, dt1, dt2);
        pz.initNonuniformCatmullRom(p0.z, p1.z, p2.z, p3.z, dt0, dt1, dt2);
    } else if (curveType == "catmullrom") {
        px.initCatmullRom(p0.x, p1.x, p2.x, p3.x, tension);
        py.initCatmullRom(p0.y, p1.y, p2.y, p3.y, tension);
        pz.initCatmullRom(p0.z, p1.z, p2.z, p3.z, tension);
    }
    return {px.calc(weight), py.calc(weight), pz.calc(weight)};
}

// ------------------------------------------------------------------------------- 2D segments

Vector2 LineCurve::getPoint(double t) const {
    if (t == 1) return v2;
    Vector2 point = v2;
    point.sub(v1).multiplyScalar(t).add(v1);
    return point;
}

Vector2 LineCurve::getTangent(double) const {
    Vector2 tangent;
    tangent.subVectors(v2, v1).normalize();
    return tangent;
}

Vector2 QuadraticBezierCurve::getPoint(double t) const {
    return {quadraticBezier(t, v0.x, v1.x, v2.x), quadraticBezier(t, v0.y, v1.y, v2.y)};
}

Vector2 CubicBezierCurve::getPoint(double t) const {
    return {cubicBezier(t, v0.x, v1.x, v2.x, v3.x), cubicBezier(t, v0.y, v1.y, v2.y, v3.y)};
}

Vector2 EllipseCurve::getPoint(double t) const {
    constexpr double twoPi = 6.283185307179586;
    double deltaAngle = aEndAngle - aStartAngle;
    const bool samePoints = std::abs(deltaAngle) < DBL_EPSILON;
    while (deltaAngle < 0) deltaAngle += twoPi;
    while (deltaAngle > twoPi) deltaAngle -= twoPi;
    if (deltaAngle < DBL_EPSILON) deltaAngle = samePoints ? 0 : twoPi;
    if (aClockwise && !samePoints) deltaAngle = deltaAngle == twoPi ? -twoPi : deltaAngle - twoPi;
    const double angle = aStartAngle + t * deltaAngle;
    double x = aX + xRadius * ieee754::cos(angle);
    double y = aY + yRadius * ieee754::sin(angle);
    if (aRotation != 0) {
        const double cos = ieee754::cos(aRotation);
        const double sin = ieee754::sin(aRotation);
        const double tx = x - aX;
        const double ty = y - aY;
        x = tx * cos - ty * sin + aX;
        y = tx * sin + ty * cos + aY;
    }
    return {x, y};
}

Vector2 SplineCurve::getPoint(double t) const {
    const auto n = static_cast<double>(points.size());
    const double p = (n - 1) * t;
    const double intPoint = std::floor(p);
    const double weight = p - intPoint;
    const auto at = [&](double i) -> const Vector2& { return points[static_cast<size_t>(i)]; };
    const Vector2& p0 = at(intPoint == 0 ? intPoint : intPoint - 1);
    const Vector2& p1 = at(intPoint);
    const Vector2& p2 = at(intPoint > n - 2 ? n - 1 : intPoint + 1);
    const Vector2& p3 = at(intPoint > n - 3 ? n - 1 : intPoint + 2);
    return {catmullRom(weight, p0.x, p1.x, p2.x, p3.x), catmullRom(weight, p0.y, p1.y, p2.y, p3.y)};
}

// --------------------------------------------------------------------------- Path and Shape

Path::Path(const std::vector<Vector2>& points) {
    type = "Path";
    setFromPoints(points);
}

Vector2 Path::getPoint(double t) const {
    const double d = t * getLength();
    const std::vector<double>& curveLengths = getCurveLengths();
    for (size_t i = 0; i < curveLengths.size(); ++i) {
        if (curveLengths[i] >= d) {
            const double diff = curveLengths[i] - d;
            const Curve2& curve = *curves[i];
            const double segmentLength = curve.getLength();
            const double u = segmentLength == 0 ? 0 : 1 - diff / segmentLength;
            return curve.getPointAt(u);
        }
    }
    // three answers null here, and every caller then fails on it.
    throw std::out_of_range("TN_PATH_POINT_OUT_OF_RANGE: t is past the path's length");
}

double Path::getLength() const { return getCurveLengths().back(); }

void Path::updateArcLengths() {
    needsUpdate = true;
    cacheLengths_.clear();
    (void)getCurveLengths();
}

const std::vector<double>& Path::getCurveLengths() const {
    if (!cacheLengths_.empty() && cacheLengths_.size() == curves.size()) return cacheLengths_;
    std::vector<double> lengths;
    double sums = 0;
    for (const auto& curve : curves) {
        sums += curve->getLength();
        lengths.push_back(sums);
    }
    cacheLengths_ = std::move(lengths);
    return cacheLengths_;
}

std::vector<Vector2> Path::getSpacedPoints(double divisions) const {
    std::vector<Vector2> points;
    for (double i = 0; i <= divisions; i += 1) points.push_back(getPoint(i / divisions));
    if (autoClose) points.push_back(points[0]);
    return points;
}

std::vector<Vector2> Path::getPoints(double divisions) const {
    std::vector<Vector2> points;
    for (const auto& curve : curves) {
        double resolution = divisions;
        if (dynamic_cast<const EllipseCurve*>(curve.get())) resolution = divisions * 2;
        else if (dynamic_cast<const LineCurve*>(curve.get())) resolution = 1;
        else if (const auto* spline = dynamic_cast<const SplineCurve*>(curve.get()))
            resolution = divisions * static_cast<double>(spline->points.size());
        for (const Vector2& point : curve->getPoints(resolution)) {
            if (!points.empty() && points.back().equals(point)) continue;  // three's `last`
            points.push_back(point);
        }
    }
    if (autoClose && points.size() > 1 && !points.back().equals(points[0])) points.push_back(points[0]);
    return points;
}

Path& Path::closePath() {
    const Vector2 startPoint = curves[0]->getPoint(0);
    const Vector2 endPoint = curves.back()->getPoint(1);
    if (!startPoint.equals(endPoint)) curves.push_back(std::make_shared<LineCurve>(endPoint, startPoint));
    return *this;
}

Path& Path::setFromPoints(const std::vector<Vector2>& points) {
    moveTo(points[0].x, points[0].y);
    for (size_t i = 1; i < points.size(); ++i) lineTo(points[i].x, points[i].y);
    return *this;
}

Path& Path::moveTo(double x, double y) {
    currentPoint.set(x, y);
    return *this;
}

Path& Path::lineTo(double x, double y) {
    curves.push_back(std::make_shared<LineCurve>(currentPoint, Vector2(x, y)));
    currentPoint.set(x, y);
    return *this;
}

Path& Path::quadraticCurveTo(double aCPx, double aCPy, double aX, double aY) {
    curves.push_back(std::make_shared<QuadraticBezierCurve>(currentPoint, Vector2(aCPx, aCPy), Vector2(aX, aY)));
    currentPoint.set(aX, aY);
    return *this;
}

Path& Path::bezierCurveTo(double aCP1x, double aCP1y, double aCP2x, double aCP2y, double aX, double aY) {
    curves.push_back(std::make_shared<CubicBezierCurve>(currentPoint, Vector2(aCP1x, aCP1y), Vector2(aCP2x, aCP2y),
                                                        Vector2(aX, aY)));
    currentPoint.set(aX, aY);
    return *this;
}

Path& Path::splineThru(const std::vector<Vector2>& pts) {
    std::vector<Vector2> npts{currentPoint};
    npts.insert(npts.end(), pts.begin(), pts.end());
    curves.push_back(std::make_shared<SplineCurve>(std::move(npts)));
    currentPoint.copy(pts.back());
    return *this;
}

Path& Path::arc(double aX, double aY, double aRadius, double aStartAngle, double aEndAngle, bool aClockwise) {
    return absarc(aX + currentPoint.x, aY + currentPoint.y, aRadius, aStartAngle, aEndAngle, aClockwise);
}

Path& Path::absarc(double aX, double aY, double aRadius, double aStartAngle, double aEndAngle, bool aClockwise) {
    return absellipse(aX, aY, aRadius, aRadius, aStartAngle, aEndAngle, aClockwise, 0);
}

Path& Path::ellipse(double aX, double aY, double xRadius, double yRadius, double aStartAngle, double aEndAngle,
                    bool aClockwise, double aRotation) {
    return absellipse(aX + currentPoint.x, aY + currentPoint.y, xRadius, yRadius, aStartAngle, aEndAngle, aClockwise,
                      aRotation);
}

Path& Path::absellipse(double aX, double aY, double xRadius, double yRadius, double aStartAngle, double aEndAngle,
                       bool aClockwise, double aRotation) {
    auto curve = std::make_shared<EllipseCurve>(aX, aY, xRadius, yRadius, aStartAngle, aEndAngle, aClockwise, aRotation);
    if (!curves.empty()) {
        const Vector2 firstPoint = curve->getPoint(0);
        if (!firstPoint.equals(currentPoint)) lineTo(firstPoint.x, firstPoint.y);
    }
    curves.push_back(curve);
    currentPoint.copy(curve->getPoint(1));
    return *this;
}

std::vector<std::vector<Vector2>> Shape::extractHoles(double divisions) const {
    std::vector<std::vector<Vector2>> holesPts;
    for (const auto& hole : holes) holesPts.push_back(hole->getPoints(divisions));
    return holesPts;
}

}  // namespace tn::engine
