#pragma once

#include "pages.h"
#include "engine/foundation/math/Matrix.h"

namespace tn::engine::shadows {

// Rendering configuration uses VirtualShadowNode's units and names. The caller supplies the
// explicit depth override; automatic depth/focus, adaptive gates, movers and custom filters are
// not part of this rendering slice (TN_VIRTUAL_SHADOW_UNSUPPORTED at the configuration boundary).
struct AtlasOptions {
    std::vector<double> clipExtents{16, 48, 144};
    int mapSize = 512, pageTexels = 128, border = 2;
    std::vector<double> selectionGuard{0.9}, refreshStep{0.125};
    // Explicit depth override, as in VirtualShadowNode. Zero refuses automatic depth rather
    // than silently replacing its scene-derived span with a constant.
    double lightDistance = 0, depthRange = 0;
    double minCasterTexels = 0;
    std::vector<double> invalidationDelay{0};
    bool adaptiveRefresh = false, adaptiveCasterGate = false, followViewFocus = false, shadowLodBias = false;
    bool receiverPlaneBias = true;
};

struct AtlasPage {
    int level = 0, x = 0, y = 0, slot = 0;
    Matrix4 view, projection;
    Vector3 axisU, axisV;
    double lowU = 0, highU = 0, lowV = 0, highV = 0;
};

/** CPU page table and atlas math; the GPU only executes this plan. */
class PageAtlas {
public:
    static std::optional<PageAtlas> create(const AtlasOptions& options, std::string& error);
    // One clip level per frame, finest first, as VirtualShadowNode. A cut reseeds that level
    // immediately; deferred levels keep their own sampling matrices and protected pages.
    std::vector<AtlasPage> update(const Vector3& eye, const Vector3& direction, bool cameraCut = false);
    void invalidate(const Box3& bounds);
    void invalidateAll();
    const AtlasOptions& options() const { return options_; }
    const std::vector<float>& table() const { return table_; }
    int tiles() const { return options_.mapSize / options_.pageTexels; }
    int stride() const { return options_.pageTexels + 2 * options_.border; }
    int edge() const { return slotsPerAxis_ * stride(); }
    std::pair<int, int> origin(int slot) const { return {slot % slotsPerAxis_ * stride(), slot / slotsPerAxis_ * stride()}; }
    bool overlaps(const AtlasPage& page, const Box3& bounds) const;

private:
    struct Level {
        ClipWindow window;
        double centerW = 0;
        bool mapped = false, dirty = false;
        Matrix4 view, matrix;
        std::vector<int> slots;
    };
    void writeTable();
    AtlasOptions options_;
    std::optional<DirectionalClipmap> clipmap_;
    std::optional<PhysicalPagePool> pool_;
    std::vector<Level> levels_;
    std::vector<float> table_;
    Vector3 direction_, previousEye_;
    bool started_ = false;
    int slotsPerAxis_ = 0;
    double frame_ = 0;
};

} // namespace tn::engine::shadows
