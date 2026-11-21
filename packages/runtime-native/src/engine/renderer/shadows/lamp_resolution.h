#pragma once

// PRD-650 Phase 1: the size of a lamp's shadow map follows the pixels it covers, by Unreal 5.8.3's
// local-light rule (clean-room port, no code copied):
//   - footprint: a camera pixel's radius at the receiver's depth, projected into the lamp's map and
//     counted in mip-0 texels of a 16384² virtual map
//     (Engine/Shaders/Private/VirtualShadowMaps/VirtualShadowMapProjectionCommon.ush:96-120);
//   - mip: floor(log2(footprint) + light bias + global bias), clamped to 0..7
//     (Engine/Shaders/Shared/VirtualShadowMapDefinitions.h:178-183);
//   - light bias: 0 for a still lamp and 1 for a moving one at Epic, lerped by a mobility factor that
//     falls from 1 to 0 over the 10 frames after the lamp last moved
//     (Engine/Config/BaseScalability.ini:260-261; Shadows/ShadowSceneRenderer.cpp:275-281;
//     Shadows/ShadowScene.cpp:20-25,199-217);
//   - over budget: one global bias raised for every lamp, never past what the pool needs
//     (VirtualShadowMaps/VirtualShadowMapCacheManager.cpp:183-187,696-721: load factor 0.85).
// A dense map holds every texel of its mip, so the finest mip any lit receiver asks for sizes it.

#include "engine/foundation/math/Matrix.h"
#include "engine/foundation/math/Primitives.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <vector>

namespace tn::engine::shadows {

inline constexpr double kLampVirtualResolution = 16384;  // VSM_VIRTUAL_MAX_RESOLUTION_XY: 128 pages of 128
inline constexpr int kLampMaxMip = 7;                     // VSM_MAX_MIP_LEVELS - 1: 128 texels
inline constexpr int kLampActiveFrames = 10;              // r.Shadow.Scene.LightActiveFrameCount
inline constexpr double kLampMovingBias = 1;              // r.Shadow.Virtual.ResolutionLodBiasLocalMoving at Epic
// r.Shadow.Virtual.MaxPhysicalPages at Epic (BaseScalability.ini:257) of 128² texels, times
// r.Shadow.Virtual.DynamicRes.MaxPagePoolLoadFactor. Unreal's pool also holds the sun's pages; the
// sun has its own atlas here, so the lamps share the whole pool.
inline constexpr double kLampTexelBudget = 4096.0 * 128 * 128 * 0.85;

/** Unreal's footprint, in mip-0 texels, for one receiver point. Inputs are positive depths. */
inline double lampFootprint(double cameraDepthScale, double screenRadius, double shadowP00, double shadowDepth) {
    return cameraDepthScale * screenRadius * shadowP00 / shadowDepth * 2 * kLampVirtualResolution;
}

/** The mobility factor `frames` after the lamp last moved: 1 on the frame it moved, 0 from frame 10. */
inline double lampMobility(int64_t framesSinceMove) {
    return 1 - std::clamp(double(framesSinceMove) / kLampActiveFrames, 0.0, 1.0);
}

struct LampDemand {
    double footprint = 0;  // the smallest footprint over the lamp's lit, visible receivers; 0 = none seen
    double mobility = 0;
    bool cube = false;     // six faces of the size
    int minMip = 0;        // the finest mip the device can hold
};

inline int lampMip(const LampDemand& lamp, double globalBias) {
    if (!(lamp.footprint > 0)) return kLampMaxMip;  // no visible receiver marks a page: the coarsest map
    const double level = std::log2(lamp.footprint) + kLampMovingBias * lamp.mobility + globalBias;
    return std::clamp(int(std::floor(std::max(level, 0.0))), lamp.minMip, kLampMaxMip);
}

inline uint32_t lampMipSize(int mip) { return uint32_t(kLampVirtualResolution) >> mip; }

/**
 * Each lamp's map size. Over the budget, the global bias rises to the next value at which a lamp
 * steps one mip coarser, until the maps fit or every lamp holds its coarsest mip. So the lamp whose
 * footprint sits nearest its next coarser mip steps first, and a bias of 1 halves every map.
 */
inline std::vector<uint32_t> lampMapSizes(const std::vector<LampDemand>& lamps, double texelBudget = kLampTexelBudget) {
    double bias = 0;
    std::vector<int> mips(lamps.size());
    for (;;) {
        double texels = 0, next = INFINITY;
        for (std::size_t i = 0; i < lamps.size(); ++i) {
            mips[i] = lampMip(lamps[i], bias);
            const double size = lampMipSize(mips[i]);
            texels += size * size * (lamps[i].cube ? 6 : 1);
            if (mips[i] < kLampMaxMip && lamps[i].footprint > 0)
                next = std::min(next, mips[i] + 1 - std::log2(lamps[i].footprint) - kLampMovingBias * lamps[i].mobility);
        }
        if (texels <= texelBudget || !std::isfinite(next)) break;
        bias = std::max(next, std::nextafter(bias, INFINITY));
    }
    std::vector<uint32_t> sizes(lamps.size());
    for (std::size_t i = 0; i < lamps.size(); ++i) sizes[i] = lampMipSize(mips[i]);
    return sizes;
}

/** Exact affine Arvo AABB transform, falling back to 8-corner projection for projective matrices. */
inline Box3 affineTransformBox(const Box3& src, const Matrix4& mat) {
    const auto& me = mat.elements;
    if (me[3] == 0.0 && me[7] == 0.0 && me[11] == 0.0 && me[15] == 1.0) {
        const double cx = 0.5 * (src.min.x + src.max.x);
        const double cy = 0.5 * (src.min.y + src.max.y);
        const double cz = 0.5 * (src.min.z + src.max.z);
        const double hx = 0.5 * (src.max.x - src.min.x);
        const double hy = 0.5 * (src.max.y - src.min.y);
        const double hz = 0.5 * (src.max.z - src.min.z);
        const double wx = me[0] * cx + me[4] * cy + me[8] * cz + me[12];
        const double wy = me[1] * cx + me[5] * cy + me[9] * cz + me[13];
        const double wz = me[2] * cx + me[6] * cy + me[10] * cz + me[14];
        const double ex = std::abs(me[0]) * hx + std::abs(me[4]) * hy + std::abs(me[8]) * hz;
        const double ey = std::abs(me[1]) * hx + std::abs(me[5]) * hy + std::abs(me[9]) * hz;
        const double ez = std::abs(me[2]) * hx + std::abs(me[6]) * hy + std::abs(me[10]) * hz;
        Box3 out;
        out.min.set(wx - ex, wy - ey, wz - ez);
        out.max.set(wx + ex, wy + ey, wz + ez);
        return out;
    }
    Box3 out = src;
    out.applyMatrix4(mat);
    return out;
}

/**
 * Computes minimum lamp pixel footprint across a receiver box's 5x5x5 sample grid + nearest point to eye,
 * using linear/affine stepping and box lower-bound early rejection to match full Matrix4 evaluation without
 * per-point matrix multiplications.
 */
inline void accumulateLampBoxFootprint(const Box3& box, const Vector3& eye, const Vector3& at, const Vector3& axis,
                                       bool isSpot, bool cube, double lightDistance, double coneCos,
                                       double shadowNear, double shadowP00, double p11, double p15, double screenRadius,
                                       const Matrix4& view, const Matrix4& viewProjection, const Matrix4& shadowView,
                                       double& footprint) {
    const auto& v = view.elements;
    const auto& vp = viewProjection.elements;
    const auto& sv = shadowView.elements;
    const double distSqMax = lightDistance > 0 ? lightDistance * lightDistance : INFINITY;

    const auto visitPoint = [&](const Vector3& point) {
        const double clipW = vp[3] * point.x + vp[7] * point.y + vp[11] * point.z + vp[15];
        if (!(clipW > 0)) return;
        const double clipX = vp[0] * point.x + vp[4] * point.y + vp[8] * point.z + vp[12];
        if (std::abs(clipX) > clipW) return;
        const double clipY = vp[1] * point.x + vp[5] * point.y + vp[9] * point.z + vp[13];
        if (std::abs(clipY) > clipW) return;
        const double clipZ = vp[2] * point.x + vp[6] * point.y + vp[10] * point.z + vp[14];
        if (clipZ < 0 || clipZ > clipW) return;
        const double ox = point.x - at.x, oy = point.y - at.y, oz = point.z - at.z;
        const double reachSq = ox * ox + oy * oy + oz * oz;
        if (reachSq == 0 || (lightDistance > 0 && reachSq > distSqMax)) return;
        if (isSpot) {
            const double reach = std::sqrt(reachSq);
            if (ox * axis.x + oy * axis.y + oz * axis.z < coneCos * reach) return;
        }
        const double shadowDepth = cube ? std::max({std::abs(ox), std::abs(oy), std::abs(oz)})
                                        : -Vector3(point).applyMatrix4(shadowView).z;
        if (!(shadowDepth > shadowNear)) return;
        const double sceneDepth = -Vector3(point).applyMatrix4(view).z;
        footprint = std::min(footprint, lampFootprint(sceneDepth * p11 + p15, screenRadius, shadowP00, shadowDepth));
    };

    const bool viewAffine = v[3] == 0.0 && v[7] == 0.0 && v[11] == 0.0 && v[15] == 1.0;
    const bool shadowAffine = cube || (sv[3] == 0.0 && sv[7] == 0.0 && sv[11] == 0.0 && sv[15] == 1.0);
    if (!viewAffine || !shadowAffine) {
        for (int x = 0; x < 5; ++x)
            for (int y = 0; y < 5; ++y)
                for (int z = 0; z < 5; ++z)
                    visitPoint(Vector3(box.min.x + (box.max.x - box.min.x) * x / 4,
                                       box.min.y + (box.max.y - box.min.y) * y / 4,
                                       box.min.z + (box.max.z - box.min.z) * z / 4));
        Vector3 nearest;
        box.clampPoint(eye, nearest);
        visitPoint(nearest);
        return;
    }

    const double vz0 = -v[2], vz1 = -v[6], vz2 = -v[10], vz3 = -v[14];
    const double c0 = p11 * vz0, c1 = p11 * vz1, c2 = p11 * vz2;
    const double minCamScale = std::max(0.0,
        (c0 >= 0 ? box.min.x : box.max.x) * c0 +
        (c1 >= 0 ? box.min.y : box.max.y) * c1 +
        (c2 >= 0 ? box.min.z : box.max.z) * c2 +
        p11 * vz3 + p15);

    const double sz0 = -sv[2], sz1 = -sv[6], sz2 = -sv[10], sz3 = -sv[14];
    double maxShadowDepth;
    if (cube) {
        maxShadowDepth = std::max({
            std::max(std::abs(box.min.x - at.x), std::abs(box.max.x - at.x)),
            std::max(std::abs(box.min.y - at.y), std::abs(box.max.y - at.y)),
            std::max(std::abs(box.min.z - at.z), std::abs(box.max.z - at.z)),
        });
        if (lightDistance > 0 && maxShadowDepth > lightDistance) maxShadowDepth = lightDistance;
    } else {
        maxShadowDepth =
            (sz0 >= 0 ? box.max.x : box.min.x) * sz0 +
            (sz1 >= 0 ? box.max.y : box.min.y) * sz1 +
            (sz2 >= 0 ? box.max.z : box.min.z) * sz2 + sz3;
    }
    if (!(maxShadowDepth > shadowNear)) return;

    const double boxLowerBound = minCamScale > 0
        ? lampFootprint(minCamScale, screenRadius, shadowP00, maxShadowDepth)
        : 0.0;
    if (std::isfinite(footprint) && minCamScale > 0 && boxLowerBound >= footprint) return;

    Vector3 nearest;
    box.clampPoint(eye, nearest);
    visitPoint(nearest);
    if (std::isfinite(footprint) && minCamScale > 0 && boxLowerBound >= footprint) return;

    const double dx = (box.max.x - box.min.x) * 0.25;
    const double dy = (box.max.y - box.min.y) * 0.25;
    const double dz = (box.max.z - box.min.z) * 0.25;

    const double bx = box.min.x, by = box.min.y, bz = box.min.z;
    const double oxBase = bx - at.x, oyBase = by - at.y, ozBase = bz - at.z;
    const double clipXBase = vp[0] * bx + vp[4] * by + vp[8] * bz + vp[12];
    const double clipYBase = vp[1] * bx + vp[5] * by + vp[9] * bz + vp[13];
    const double clipZBase = vp[2] * bx + vp[6] * by + vp[10] * bz + vp[14];
    const double clipWBase = vp[3] * bx + vp[7] * by + vp[11] * bz + vp[15];
    const double sceneBase = vz0 * bx + vz1 * by + vz2 * bz + vz3;
    const double shadowBase = cube ? 0.0 : (sz0 * bx + sz1 * by + sz2 * bz + sz3);

    const double dcxX = vp[0] * dx, dcxY = vp[4] * dy, dcxZ = vp[8] * dz;
    const double dcyX = vp[1] * dx, dcyY = vp[5] * dy, dcyZ = vp[9] * dz;
    const double dczX = vp[2] * dx, dczY = vp[6] * dy, dczZ = vp[10] * dz;
    const double dcwX = vp[3] * dx, dcwY = vp[7] * dy, dcwZ = vp[11] * dz;
    const double dsX = vz0 * dx, dsY = vz1 * dy, dsZ = vz2 * dz;
    const double dshX = sz0 * dx, dshY = sz1 * dy, dshZ = sz2 * dz;
    const double dotBase = isSpot ? (oxBase * axis.x + oyBase * axis.y + ozBase * axis.z) : 0.0;
    const double ddX = dx * axis.x, ddY = dy * axis.y, ddZ = dz * axis.z;

    for (int xi = 0; xi < 5; ++xi) {
        const double ox = oxBase + xi * dx;
        const double cx1 = clipXBase + xi * dcxX;
        const double cy1 = clipYBase + xi * dcyX;
        const double cz1 = clipZBase + xi * dczX;
        const double cw1 = clipWBase + xi * dcwX;
        const double sc1 = sceneBase + xi * dsX;
        const double sh1 = shadowBase + xi * dshX;
        const double d1 = dotBase + xi * ddX;
        for (int yi = 0; yi < 5; ++yi) {
            const double oy = oyBase + yi * dy;
            const double cx2 = cx1 + yi * dcxY;
            const double cy2 = cy1 + yi * dcyY;
            const double cz2 = cz1 + yi * dczY;
            const double cw2 = cw1 + yi * dcwY;
            const double sc2 = sc1 + yi * dsY;
            const double sh2 = sh1 + yi * dshY;
            const double d2 = d1 + yi * ddY;
            for (int zi = 0; zi < 5; ++zi) {
                const double cw = cw2 + zi * dcwZ;
                if (!(cw > 0)) continue;
                const double cx = cx2 + zi * dcxZ;
                if (std::abs(cx) > cw) continue;
                const double cy = cy2 + zi * dcyZ;
                if (std::abs(cy) > cw) continue;
                const double cz = cz2 + zi * dczZ;
                if (cz < 0 || cz > cw) continue;
                const double oz = ozBase + zi * dz;
                const double reachSq = ox * ox + oy * oy + oz * oz;
                if (reachSq == 0 || (lightDistance > 0 && reachSq > distSqMax)) continue;
                if (isSpot) {
                    const double reach = std::sqrt(reachSq);
                    if (d2 + zi * ddZ < coneCos * reach) continue;
                }
                const double shadowDepth = cube
                    ? std::max({std::abs(ox), std::abs(oy), std::abs(oz)})
                    : (sh2 + zi * dshZ);
                if (!(shadowDepth > shadowNear)) continue;
                const double sceneDepth = sc2 + zi * dsZ;
                footprint = std::min(footprint, lampFootprint(sceneDepth * p11 + p15, screenRadius, shadowP00, shadowDepth));
            }
        }
    }
}

}  // namespace tn::engine::shadows
