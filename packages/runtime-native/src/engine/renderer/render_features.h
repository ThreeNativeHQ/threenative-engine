#pragma once

#include <stdexcept>

namespace tn::engine {

/**
 * PRD-840: the render choices that differ by host, as one value the host passes at construction, not an `#ifdef`.
 * Each field is one choice; the renderer and the database read them through `features()`.
 */
struct RenderFeatures {
    /** PRD-754: the shadow passes replay recorded bundles, and each opaque draw keeps a uniform slot. */
    bool stablePasses = true;
    /** PRD-754: with stable passes, the main, aux and velocity passes replay retained rows in state order, so
     *  opaque draws sort by state, not by depth. Off by default (owner, 2026-10-28): it swaps exactly coplanar winners. */
    bool stableRows = false;
    /** PRD-754: a batch keeps one slot (store, colours, cache, material) and its draw key while its group lives. */
    bool batchSlotReuse = true;
    /** A re-recorded main bundle names its cause (order, offsets) from per-draw hashes, else only "other". */
    bool recordCauseHashes = true;

    constexpr bool operator==(const RenderFeatures&) const = default;

    /** The desktop, Android and iOS hosts' choices. */
    static constexpr RenderFeatures native() { return {}; }
    /** The web host's choices (Decision 2026-11-08): depth-first opaque order, a batch takes the next slot each frame,
     *  no stable passes and no cause hashes. The shooter's web camera turn recorded no less with stable passes (PRD-754). */
    static constexpr RenderFeatures web() { return {false, false, false, false}; }
};

/**
 * A build may pin the features (CMake defines `TN_RENDER_FEATURES_PIN_WEB` for the web engine): `features()` then returns
 * this constant, each choice folds at compile time, and the code a choice turns off leaves the binary (the web engine's
 * 4 MiB budget). An unpinned build reads the value its host passed.
 */
#ifdef TN_RENDER_FEATURES_PIN_WEB
inline constexpr bool kRenderFeaturesPinned = true;
inline constexpr RenderFeatures kBuildRenderFeatures = RenderFeatures::web();
#else
inline constexpr bool kRenderFeaturesPinned = false;
inline constexpr RenderFeatures kBuildRenderFeatures = RenderFeatures::native();
#endif

/** The value a renderer or a database holds; fails closed when a host asks a pinned build for other features. */
inline RenderFeatures checkedRenderFeatures(RenderFeatures features) {
    if (kRenderFeaturesPinned && !(features == kBuildRenderFeatures))
        throw std::invalid_argument("TN_RENDER_FEATURES_PINNED: this build pins its render features; pass kBuildRenderFeatures");
    return features;
}

/** The features to draw with: the pin, a constant, where the build pins, else the held value. */
constexpr const RenderFeatures& effectiveRenderFeatures(const RenderFeatures& held) {
    if constexpr (kRenderFeaturesPinned) return kBuildRenderFeatures;
    else return held;
}

}  // namespace tn::engine
