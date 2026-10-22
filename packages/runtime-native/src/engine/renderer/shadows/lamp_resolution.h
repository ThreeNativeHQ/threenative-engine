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

}  // namespace tn::engine::shadows
