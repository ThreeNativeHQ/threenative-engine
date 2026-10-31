#pragma once

#include "pages.h"
#include <cmath>
#include <memory>
#include "engine/foundation/math/Matrix.h"

namespace tn::engine { class BufferGeometry; }

namespace tn::engine::shadows {

/** A caster's AutoLOD chain as a shadow level draws it: the derived rungs (rung 0 is the caster's own
 *  geometry and is not listed) and each rung's geometric error in the geometry's local units. */
struct ShadowLodChain {
    std::vector<std::shared_ptr<BufferGeometry>> rungs;
    std::vector<double> errors;
};

/**
 * The rung (1 to n, 0 for none) a level draws for a caster: the coarsest whose error at `scale` times
 * the geometry's size stays within `budget` (a texel of the level, times `shadowLodTexels`), and never
 * one finer than `shown`, the rung the main pass draws. A rung with more error than a texel is a facet
 * on the shadow's edge.
 */
inline int shadowLodRung(const std::vector<double>& errors, int shown, double budget, double scale) {
    for (int rung = int(errors.size()); rung > shown; --rung)
        if (errors[std::size_t(rung - 1)] * scale <= budget) return rung;
    return 0;
}

// Camera-centred cached depth pages and independently refreshed mover maps.
struct AtlasControl {
    std::set<uint64_t> pinned, tracked;
    std::vector<Box3> regions;
    std::map<uint64_t, ShadowLodChain> lods;
    bool invalidateAll = false;
};
struct AtlasOptions {
    std::shared_ptr<AtlasControl> control = std::make_shared<AtlasControl>();
    std::vector<double> clipExtents{16, 48, 144};
    int mapSize = 512, pageTexels = 128, border = 2;
    /** Texels per edge of each level, finest first, the last standing in for the rest; empty: `mapSize`. */
    std::vector<int> levelMapSizes;
    /** The renderer sets `levelMapSizes` by Unreal's texel rule (clipmapMapSizes) on the camera that reads them. */
    bool autoMapSize = false;
    /** `r.Shadow.Virtual.ResolutionLodBiasDirectional`, in stops, for the rule. */
    double resolutionLodBias = 0;
    /** The rule's budget in pages of `pageTexels²` over all levels (Unreal Epic's MaxPhysicalPages). */
    int maxPhysicalPages = 4096;
    std::vector<double> selectionGuard{0.9}, refreshStep{0.125};
    bool autoDepth = false;
    double lightDistance = 200, depthRange = 400;
    double minCasterTexels = 0;
    int staticAfterFrames = 30, moverMapSize = 256;
    double expensiveRefreshShare = 0.25;
    std::vector<double> invalidationDelay{0};
    bool adaptiveRefresh = false, adaptiveCasterGate = false, followViewFocus = false, shadowLodBias = false;
    /** The error, in texels of a level, a coarser AutoLOD rung may have there; infinity draws the coarsest rung. */
    double shadowLodTexels = 1;
    bool receiverPlaneBias = true, partialRedraw = true;
    /** See DirectionalClipmapOptions::minAspect; core passes its own default (0.25), this keeps tests square. */
    double minWindowAspect = 1;
};

struct AtlasPage {
    int level = 0, x = 0, y = 0, slot = 0;
    bool mover = false;
    Matrix4 view, projection;
    Vector3 axisU, axisV;
    double lowU = 0, highU = 0, lowV = 0, highV = 0;
};

struct CasterState {
    uint64_t key = 0;
    Box3 bounds;
    Matrix4 world;
    std::string signature;
    bool deforming = false, tracked = false, pinned = false, automatic = true;
};

/** CPU page table and atlas math; the GPU only executes this plan. */
class PageAtlas {
public:
    static std::optional<PageAtlas> create(const AtlasOptions& options, std::string& error);
    // One clip level per frame, retaining deferred maps as VirtualShadowNode does. Cuts start
    // finest first; subsequent grants rotate so continuously dirty levels cannot starve.
    std::vector<AtlasPage> update(const Vector3& eye, const Vector3& direction, bool cameraCut = false,
                                  const std::vector<Box3>& casters = {}, double deltaSeconds = 1.0 / 60);
    void invalidate(const Box3& bounds, bool urgent = false);
    void updateCasters(const std::vector<CasterState>& casters);
    bool isMover(uint64_t key) const;
    bool drawsStatic(uint64_t key) const;
    void appendMoverPages(std::vector<AtlasPage>& pages) const;
    std::pair<int, int> moverOrigin(int level) const;
    void recordCost(int level, double milliseconds, double frameSeconds);
    double refreshStep(int level) const;
    double casterGate(int level) const;
    static Vector3 viewFocus(const Vector3& eye, const Vector3& forward, double far,
                            double extent, const std::vector<Box3>& receivers);
    void invalidateAll();
    /** True once every level's window is mapped: the depth pages a shadow resolve samples exist. A cut, a
     *  direction change or a failed allocation leaves a level unmapped, so this is false until it is granted. */
    bool initialized() const {
        for (const Level& level : levels_)
            if (!level.mapped) return false;
        return true;
    }
    const AtlasOptions& options() const { return options_; }
    const DirectionalClipmap& clipmap() const { return *clipmap_; }
    const std::vector<float>& table() const { return table_; }
    int mapSize(int level) const {
        return options_.levelMapSizes.empty() ? options_.mapSize
            : options_.levelMapSizes[std::min<std::size_t>(std::size_t(level), options_.levelMapSizes.size() - 1)];
    }
    int tiles(int level) const { return mapSize(level) / options_.pageTexels; }
    /** The table entry of `level`'s first page, counted from the end of the level headers. */
    int pageBase(int level) const { int base = 0; for (int l = 0; l < level; ++l) base += tiles(l) * tiles(l); return base; }
    int pageCount() const { return pageBase(int(options_.clipExtents.size())); }
    int stride() const { return options_.pageTexels + 2 * options_.border; }
    int edge() const { return slotsPerAxis_ * stride(); }
    std::pair<int, int> origin(int slot) const { return {slot % slotsPerAxis_ * stride(), slot / slotsPerAxis_ * stride()}; }
    bool overlaps(const AtlasPage& page, const Box3& bounds) const;
    /**
     * The inverse of `overlaps`: the pages of `level` a caster's bounds can reach, as inclusive page indices,
     * clamped to the level's `tiles() - 1`. A page the scan would take is always in the range (the page rects
     * overlap by the border texels, and the range is padded), so indexing by it drops no shadow. An empty range
     * (`high < low`) means no page of the level: the box is outside its window, or the level is not mapped.
     */
    void pageRange(int level, const Box3& bounds, int& x0, int& x1, int& y0, int& y1) const;

private:
    struct Level {
        ClipWindow window;
        double centerW = 0, eye = 200, near = 1, far = 600;
        bool mapped = false, dirty = false, urgent = false;
        double lastRender = -INFINITY, costMs = 0, gateScale = 1;
        int costReadings = 0;
        Matrix4 projection;
        bool dirtyAll = false;
        std::set<int> dirtySlots;
        std::vector<AtlasPage> pages;
        Matrix4 view, matrix;
        std::vector<int> slots;
    };
    struct Motion {
        CasterState caster;
        int quiet = 0;
        bool moving = false;
        uint32_t settling = 0;
    };
    std::map<uint64_t, Motion> motion_;
    void writeTable();
    AtlasOptions options_;
    std::optional<DirectionalClipmap> clipmap_;
    std::optional<PhysicalPagePool> pool_;
    std::vector<Level> levels_;
    std::vector<float> table_;
    Vector3 direction_, previousEye_;
    bool started_ = false;
    int slotsPerAxis_ = 0, staticRows_ = 0, nextLevel_ = 0;
    double frame_ = 0, now_ = 0, frameSeconds_ = 1.0 / 60;
};

/** The smallest square side, in slots, that holds `count` page slots above one mover map per level. */
int packedSide(int count, int levels, int span);

/**
 * Unreal's texel-per-pixel rule (core `clipmapMapSizes`): texels per edge of each level, so that a
 * receiver at the nearest distance a level serves sees a texel of `2^(1 + bias)` of its own pixels
 * (UE 5.8.3: Engine/Source/Runtime/Renderer/Private/VirtualShadowMaps/VirtualShadowMapClipmap.cpp:245-254,
 * :363, :452; Engine/Shaders/Private/VirtualShadowMaps/VirtualShadowMapPageMarking.ush:35-39). Past the
 * page budget, or past `maxEdge` for the packed atlas, the bias rises a quarter stop at a time, as
 * Unreal's pool does (VirtualShadowMapCacheManager.cpp:703-717). Guards are selection guard minus step.
 */
std::vector<int> clipmapMapSizes(const AtlasOptions& options, double tanHalfFov, double viewportWidth, int maxEdge);

} // namespace tn::engine::shadows
