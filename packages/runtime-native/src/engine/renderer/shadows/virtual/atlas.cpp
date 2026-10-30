#include "atlas.h"
#include "engine/foundation/waste_counters.h"

#include "engine/foundation/waste_counters.h"

#include <algorithm>
#include <cmath>

namespace tn::engine::shadows {
namespace {
double at(const std::vector<double>& values, int level) { return values[std::min<int>(level, values.size() - 1)]; }
}

std::optional<PageAtlas> PageAtlas::create(const AtlasOptions& options, std::string& error) {
    const auto badSize = [&](int size) { return size <= 0 || size > 4096 || options.pageTexels <= 0 || size % options.pageTexels; };
    if (badSize(options.mapSize) || std::any_of(options.levelMapSizes.begin(), options.levelMapSizes.end(), badSize) ||
        options.border < 1 || options.border > 64 ||
        options.staticAfterFrames <= 0 || options.moverMapSize < 1 || options.moverMapSize > 4096 ||
        !std::isfinite(options.expensiveRefreshShare) || options.expensiveRefreshShare <= 0 || options.expensiveRefreshShare > 1 ||
        !std::isfinite(options.minCasterTexels) || options.minCasterTexels < 0 ||
        options.invalidationDelay.empty() || std::any_of(options.invalidationDelay.begin(), options.invalidationDelay.end(),
            [](double v) { return !std::isfinite(v) || v < 0; }) || options.clipExtents.size() > 8 || options.selectionGuard.empty() || options.refreshStep.empty() ||
        !std::isfinite(options.lightDistance) || options.lightDistance <= 1 ||
        !std::isfinite(options.depthRange) || options.depthRange <= 0 ||
        !std::isfinite(options.minWindowAspect) || options.minWindowAspect <= 0 || options.minWindowAspect > 1) {
        error = "TN_VIRTUAL_SHADOW_INVALID: atlas/depth configuration";
        return std::nullopt;
    }
    PageAtlas out;
    out.options_ = options;
    std::vector<double> guards;
    for (int i = 0; i < int(options.clipExtents.size()); ++i) {
        const double guard = at(options.selectionGuard, i), step = at(options.refreshStep, i);
        if (!std::isfinite(guard) || guard <= 0 || guard > 1 || !std::isfinite(step) || step < 0 || step >= guard) {
            error = "TN_VIRTUAL_SHADOW_INVALID: selectionGuard/refreshStep";
            return std::nullopt;
        }
        guards.push_back(guard - step);
    }
    out.clipmap_ = DirectionalClipmap::create({{0, 1, 0}, options.clipExtents, options.mapSize, guards, options.refreshStep, options.minWindowAspect, options.levelMapSizes, options.pageTexels}, error);
    if (!out.clipmap_) return std::nullopt;
    const int count = out.pageCount();
    if (count > 4096) { error = "TN_VIRTUAL_SHADOW_INVALID: page capacity"; return std::nullopt; }
    out.pool_ = PhysicalPagePool::create(count, error);
    const int span = (options.moverMapSize + 2 * options.border + out.stride() - 1) / out.stride();
    out.slotsPerAxis_ = packedSide(count, int(options.clipExtents.size()), span);
    out.staticRows_ = (count + out.slotsPerAxis_ - 1) / out.slotsPerAxis_;
    out.levels_.resize(options.clipExtents.size());
    return out;
}

int packedSide(int count, int levels, int span) {
    // The levels' mover maps sit in rows of whole slots under the static pages, so one square holds
    // both: the smallest square whose static rows plus mover rows fit in its side.
    for (int side = int(std::ceil(std::sqrt(count))); ; ++side) {
        const int perRow = side / span;
        if (perRow == 0) continue;
        if ((count + side - 1) / side + span * ((levels + perRow - 1) / perRow) <= side) return side;
    }
}

std::vector<int> clipmapMapSizes(const AtlasOptions& options, double tanHalfFov, double viewportWidth, int maxEdge) {
    const auto& extents = options.clipExtents;
    const int levels = int(extents.size()), page = options.pageTexels;
    const int stride = page + 2 * options.border, span = (options.moverMapSize + 2 * options.border + stride - 1) / stride;
    const auto guard = [&](int l) { return at(options.selectionGuard, l) - at(options.refreshStep, l); };
    std::vector<double> inner;
    for (int l = 0; l < levels; ++l)
        inner.push_back(l == 0 ? guard(0) * extents[0] * (levels > 1 ? extents[0] / extents[1] : 0.5) : guard(l - 1) * extents[std::size_t(l - 1)]);
    for (double bias = options.resolutionLodBias; ; bias += 0.25) {
        std::vector<int> sizes;
        int pages = 0;
        for (int l = 0; l < levels; ++l) {
            const double pixel = 2 * inner[std::size_t(l)] * tanHalfFov / viewportWidth;
            const int texels = int(std::ceil(2 * extents[std::size_t(l)] / (std::pow(2.0, 1 + bias) * pixel) / page)) * page;
            sizes.push_back(std::clamp(texels, page, 4096));
            pages += (sizes.back() / page) * (sizes.back() / page);
        }
        const bool smallest = std::all_of(sizes.begin(), sizes.end(), [&](int n) { return n == page; });
        if (smallest || (pages <= options.maxPhysicalPages && packedSide(pages, levels, span) * stride <= maxEdge)) return sizes;
    }
}

void PageAtlas::invalidateAll() { for (auto& level : levels_) { level.dirty = true; level.dirtyAll = true; } }

void PageAtlas::invalidate(const Box3& bounds, bool urgent) {
    for (auto& level : levels_) {
        if (!level.mapped) continue;
        const auto u = projectBounds(bounds, clipmap_->basisU());
        auto v = projectBounds(bounds, clipmap_->basisV());
        v.low /= clipmap_->vScale(); v.high /= clipmap_->vScale();  // the window's `v` counts pages in its height
        const double lowU = level.window.minX * level.window.pageWorldSize;
        const double lowV = level.window.minY * level.window.pageWorldSize;
        if (u.low <= lowU + 2 * level.window.extent && u.high >= lowU &&
            v.low <= lowV + 2 * level.window.extent && v.high >= lowV) { level.dirty = true; level.urgent |= urgent;
            for (const auto& page : level.pages) if (overlaps(page, bounds)) level.dirtySlots.insert(page.slot); }
    }
}

bool PageAtlas::overlaps(const AtlasPage& page, const Box3& bounds) const {
    const auto u = projectBounds(bounds, page.axisU), v = projectBounds(bounds, page.axisV);
    return u.low <= page.highU && u.high >= page.lowU && v.low <= page.highV && v.high >= page.lowV;
}

void PageAtlas::pageRange(int level, const Box3& bounds, int& x0, int& x1, int& y0, int& y1) const {
    x0 = y0 = 1;  // an empty range is `x1 < x0`, never a page 0
    x1 = y1 = 0;
    if (level < 0 || level >= int(levels_.size())) return;
    const auto& pages = levels_[std::size_t(level)].pages;
    if (pages.empty()) return;  // not mapped this frame: no page can be reached
    // `update` lays a level's pages y-major from its (0,0) cell, and every page of a level shares the level's
    // axes and cell size. A page's rect is `overlaps`' rect exactly, so the range is read off page 0's own
    // numbers: page x spans [lowU + x*cell, highU + x*cell], the border padding included on both edges.
    const AtlasPage& first = pages.front();
    const double cellU = options_.pageTexels * levels_[std::size_t(level)].window.pageWorldSize;
    if (!(cellU > 0) || !std::isfinite(cellU)) return;
    const double cellV = cellU * clipmap_->vScale();
    // ponytail: 1e-6 of a cell of slack, so a box whose edge lands on a cell boundary rounds into both cells.
    const auto span = [](double low, double high, double pageLow, double pageHigh, double cell, int& from, int& to) {
        const double slop = 1e-6 * cell;
        from = int(std::ceil((low - slop - pageHigh) / cell));
        to = int(std::floor((high + slop - pageLow) / cell));
    };
    const auto u = projectBounds(bounds, first.axisU), v = projectBounds(bounds, first.axisV);
    span(u.low, u.high, first.lowU, first.highU, cellU, x0, x1);
    span(v.low, v.high, first.lowV, first.highV, cellV, y0, y1);
    const int last = tiles(level) - 1;
    x0 = std::max(x0, 0); x1 = std::min(x1, last);
    y0 = std::max(y0, 0); y1 = std::min(y1, last);
    if (x1 < x0 || y1 < y0) { x0 = y0 = 1; x1 = y1 = 0; }
}

std::vector<AtlasPage> PageAtlas::update(const Vector3& eye, const Vector3& towards, bool cameraCut, const std::vector<Box3>& casters, double deltaSeconds) {
    Vector3 direction = towards;
    direction.normalize();
    // A cut requests fresh windows, but deferred levels retain their rendered matrices/pages,
    // as VirtualShadowNode does. Protect them until their own replacement is rendered.
    cameraCut = cameraCut || (started_ && previousEye_.distanceTo(eye) > options_.clipExtents.front());
    const bool changed = !started_ || !direction.equals(direction_);
    if (changed) {
        std::string error;
        std::vector<double> guards;
        for (int i = 0; i < int(levels_.size()); ++i) guards.push_back(at(options_.selectionGuard, i) - at(options_.refreshStep, i));
        clipmap_ = DirectionalClipmap::create({direction, options_.clipExtents, options_.mapSize, guards, options_.refreshStep, options_.minWindowAspect, options_.levelMapSizes, options_.pageTexels}, error);
        // The renderer validates the direction before entering this CPU plan.
        if (!clipmap_) return {};
        pool_ = PhysicalPagePool::create(pageCount(), error);
        for (auto& level : levels_) level = Level{};
    }
    if (cameraCut) invalidateAll();
    if (changed || cameraCut) nextLevel_ = 0;
    direction_ = direction;
    previousEye_ = eye;
    started_ = true;
    if (std::isfinite(deltaSeconds) && deltaSeconds > 0) frameSeconds_ = deltaSeconds;
    now_ += frameSeconds_;
    for (int l = 0; l < int(levels_.size()); ++l) clipmap_->setRefreshStep(l, refreshStep(l));
    const auto& windows = clipmap_->updateCenter(eye, !changed && !cameraCut);
    // A page's identity packs 24 signed bits per axis (`pageId`); a window outside that range would give two
    // pages one id, and a protected id then guards the wrong tile. Grant nothing instead (TN_VIRTUAL_SHADOW_INVALID
    // reasons live in the caller): a level with no page draws no shadow, where an aliased id evicts one still in use.
    for (const ClipWindow& window : windows)
        if (window.minX < -kPageAxisLimit || window.maxX > kPageAxisLimit || window.minY < -kPageAxisLimit ||
            window.maxY > kPageAxisLimit) return {};
    const auto center = clipmap_->project(eye);
    ++frame_;
    std::vector<AtlasPage> pages;
    // Protect all held levels until their own replacement has been rendered.
    std::unordered_set<uint64_t> protectedIds;
    for (int l = 0; l < int(levels_.size()); ++l) if (levels_[l].mapped)
        for (int y = 0; y < tiles(l); ++y) for (int x = 0; x < tiles(l); ++x)
            protectedIds.insert(pageId(l, levels_[l].window.minX + x * options_.pageTexels,
                                       levels_[l].window.minY + y * options_.pageTexels));
    // The shipped TS node requests an entire granted clip window (its prototype's sparse
    // receiver-feedback path is not used by virtual-shadow.ts). Tile that same request into
    // physical pages; cached levels are neither cleared nor rendered.
    // One ordinary grant; urgent mover evictions cannot leave a detached old shadow behind.
    bool granted = false;
    const int startLevel = nextLevel_;
    for (int offset = 0; offset < int(levels_.size()); ++offset) {
        const int l = (startLevel + offset) % int(levels_.size());
        auto& level = levels_[l];
        const auto& window = windows[l];
        const bool moved = !level.mapped || level.window.minX != window.minX || level.window.minY != window.minY;
        const double gpuDelay = options_.adaptiveRefresh ? level.costMs / (1000 * options_.expensiveRefreshShare) : 0;
        const bool matured = level.dirty && (level.urgent || now_ - level.lastRender >= std::max(at(options_.invalidationDelay, l), gpuDelay));
        if ((!moved && !matured) || (granted && !level.urgent)) continue;
        if (level.mapped) for (int y = 0; y < tiles(l); ++y) for (int x = 0; x < tiles(l); ++x)
            protectedIds.erase(pageId(l, level.window.minX + x * options_.pageTexels, level.window.minY + y * options_.pageTexels));
        const Matrix4 oldMatrix = level.matrix;
        bool partial = !moved && level.mapped && !level.dirtyAll && options_.partialRedraw;
        // A pan keeps the pages the window still covers (UE 5.8.3 clipmap panning): a page key names a
        // fixed world rect, so its slot stays valid while the depth mapping and page size hold.
        const bool panning = moved && level.mapped && !level.dirtyAll && options_.partialRedraw;
        const double oldDepthOrigin = level.centerW + level.eye, oldNear = level.near, oldFar = level.far;
        const double oldPageWorldSize = level.window.pageWorldSize;
        const std::set<int> oldSlots(level.slots.begin(), level.slots.end());
        level.window = window;
        level.centerW = center.w;
        const double cu = (window.minX + mapSize(l) / 2.0) * window.pageWorldSize;
        const double cv = (window.minY + mapSize(l) / 2.0) * window.pageWorldSize;
        // `v` counts pages along the window's height: `vScale` metres of V each, so a texel along V is
        // `vScale` times its width and covers the same floor area a low sun stretches it over.
        const double vScale = clipmap_->vScale();
        Vector3 target = clipmap_->basisU(); target.multiplyScalar(cu);
        target.addScaledVector(clipmap_->basisV(), cv * vScale).addScaledVector(clipmap_->basisW(), center.w);
        if (!level.mapped) {
            level.eye = options_.lightDistance;
            level.near = 1;
            level.far = options_.lightDistance + options_.depthRange;
        }
        // virtual-shadow.ts #deriveDepth: sideways overlap, sphere depth for props, box height
        // for masses wider than the window; a low sun or empty set keeps the last fitted span.
        if (options_.autoDepth && direction.y >= 0.05) {
            double low = INFINITY, high = -INFINITY;
            const double side = window.extent * std::sqrt(2.0);
            const double heightReach = window.extent * (std::abs(clipmap_->basisU().y) + std::abs(clipmap_->basisV().y));
            for (const Box3& box : casters) {
                if (box.isEmpty()) continue;
                Vector3 delta; delta.addVectors(box.min, box.max).multiplyScalar(0.5).sub(target);
                const double radius = box.min.distanceTo(box.max) * 0.5;
                if (std::abs(delta.dot(clipmap_->basisU())) > side + radius ||
                    std::abs(delta.dot(clipmap_->basisV())) > side + radius) continue;
                if (radius > window.extent) {
                    low = std::min(low, (box.min.y - target.y - heightReach) / direction.y);
                    high = std::max(high, (box.max.y - target.y + heightReach) / direction.y);
                } else {
                    low = std::min(low, delta.dot(direction) - radius);
                    high = std::max(high, delta.dot(direction) + radius);
                }
            }
            if (std::isfinite(low) && high > low) {
                level.near = std::max(1.0, (high - low) * 0.02);
                level.eye = high + level.near;
                level.far = level.near + high - low;
            }
        }
        Vector3 from = target; from.addScaledVector(clipmap_->basisW(), level.eye);
        Matrix4 world; world.lookAt(from, target, Vector3(0, 1, 0)); world.setPosition(from);
        level.view = world; level.view.invert();
        Matrix4 projection;
        projection.makeOrthographic(-window.extent, window.extent, window.extent * vScale, -window.extent * vScale,
                                    level.near, level.far, CoordinateSystem::WebGPU);
        level.projection = projection;
        level.matrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 1, 0, 0, 0, 0, 1);
        level.matrix.multiply(projection).multiply(level.view);
        partial = partial && oldMatrix.elements == level.matrix.elements;
        const bool pan = panning && level.centerW + level.eye == oldDepthOrigin && level.near == oldNear &&
                         level.far == oldFar && window.pageWorldSize == oldPageWorldSize;
        level.slots.clear();
        level.pages.clear();
        auto& counts = waste::counters();
        waste::debugAdd(counts.shadowRefreshes);
        waste::debugAdd(!moved ? counts.shadowRefreshInvalidation : pan ? counts.shadowRefreshPan : counts.shadowRefreshRebuild);
        const std::size_t pagesBefore = pages.size();
        for (int y = 0; y < tiles(l); ++y) for (int x = 0; x < tiles(l); ++x) {
            const uint64_t id = pageId(l, window.minX + x * options_.pageTexels, window.minY + y * options_.pageTexels);
            const auto allocation = pool_->allocate(id, frame_, false, protectedIds);
            if (!allocation) { level.mapped = false; writeTable(); return {}; }
            if (allocation->hasEvicted) waste::debugAdd(counts.shadowPageEvictions);
            protectedIds.insert(id);
            level.slots.push_back(allocation->entry.slot);
            const double texel = window.pageWorldSize, pad = options_.border * texel;
            const double texelV = texel * vScale, padV = options_.border * texelV;
            const double left = -window.extent + x * options_.pageTexels * texel;
            const double bottom = -window.extent * vScale + y * options_.pageTexels * texelV;
            AtlasPage page; page.level = l; page.x = x; page.y = y; page.slot = allocation->entry.slot; page.view = level.view;
            page.projection.makeOrthographic(left - pad, left + options_.pageTexels * texel + pad,
                bottom + options_.pageTexels * texelV + padV, bottom - padV,
                level.near, level.far, CoordinateSystem::WebGPU);
            page.axisU.set(world.elements[0], world.elements[1], world.elements[2]);
            page.axisV.set(world.elements[4], world.elements[5], world.elements[6]);
            const double cameraU = target.dot(page.axisU), cameraV = target.dot(page.axisV);
            page.lowU = cameraU + left - pad; page.highU = cameraU + left + options_.pageTexels * texel + pad;
            page.lowV = cameraV + bottom - padV; page.highV = cameraV + bottom + options_.pageTexels * texelV + padV;
            level.pages.push_back(page);
            const bool kept = partial || (pan && allocation->reused && oldSlots.count(page.slot));
            if (!kept || level.dirtySlots.count(page.slot)) pages.push_back(page);
        }
        waste::debugAdd(counts.shadowPagesRefreshed, pages.size() - pagesBefore);
        level.mapped = true;
        level.dirty = false;
        level.dirtyAll = false; level.dirtySlots.clear();
        level.urgent = false;
        level.lastRender = now_;
        for (auto& [key, motion] : motion_) motion.settling &= ~(1u << l);
        granted = true;
        nextLevel_ = (l + 1) % int(levels_.size());
    }
    writeTable();
    return pages;
}

std::pair<int, int> PageAtlas::moverOrigin(int level) const {
    const int span = (options_.moverMapSize + 2 * options_.border + stride() - 1) / stride(), perRow = slotsPerAxis_ / span;
    return {level % perRow * span * stride(), (staticRows_ + level / perRow * span) * stride()};
}

bool PageAtlas::isMover(uint64_t key) const {
    const auto it = motion_.find(key);
    return it != motion_.end() && (it->second.moving || it->second.settling != 0);
}

bool PageAtlas::drawsStatic(uint64_t key) const {
    const auto it = motion_.find(key);
    return it == motion_.end() || !it->second.moving;
}

void PageAtlas::updateCasters(const std::vector<CasterState>& casters) {
    std::set<uint64_t> present;
    for (const auto& caster : casters) {
        present.insert(caster.key);
        auto [it, inserted] = motion_.try_emplace(caster.key);
        auto& m = it->second;
        const bool changed = !inserted && (caster.world.elements != m.caster.world.elements || caster.signature != m.caster.signature);
        const bool moving = caster.tracked || (!caster.pinned && caster.automatic && (caster.deforming || changed));
        if (moving) {
            waste::meterAdd(waste::counters().castersMoving);
            if (!m.moving && !inserted) invalidate(m.caster.bounds, true);
            m.moving = true; m.quiet = 0; m.settling = 0;
        } else if (m.moving && (caster.pinned || ++m.quiet > options_.staticAfterFrames)) {
            // UE 5.8.3 VirtualShadowMapCacheManager.cpp:1810: static once the age exceeds the threshold.
            m.moving = false;
            m.settling = 0;
            for (int l = 0; l < int(levels_.size()); ++l)
                if (levels_[l].mapped && std::any_of(levels_[l].pages.begin(), levels_[l].pages.end(),
                    [&](const auto& page) { return overlaps(page, caster.bounds); })) m.settling |= 1u << l;
            invalidate(caster.bounds);
        } else if (inserted) invalidate(caster.bounds);
        m.caster = caster;
    }
    for (auto it = motion_.begin(); it != motion_.end();) {
        if (present.count(it->first)) { ++it; continue; }
        if (!it->second.moving) invalidate(it->second.caster.bounds);
        it = motion_.erase(it);
    }
}

void PageAtlas::appendMoverPages(std::vector<AtlasPage>& pages) const {
    if (std::none_of(motion_.begin(), motion_.end(), [](const auto& entry) {
        return entry.second.moving || entry.second.settling;
    })) return;
    for (int l = 0; l < int(levels_.size()); ++l) {
        const auto& level = levels_[l];
        if (!level.mapped) continue;
        AtlasPage p; p.level = l; p.mover = true; p.view = level.view; p.projection = level.projection;
        const double extent = options_.clipExtents[l], pad = 2 * extent * options_.border / options_.moverMapSize;
        const double vScale = clipmap_->vScale();
        p.projection.makeOrthographic(-extent-pad, extent+pad, (extent+pad) * vScale, -(extent+pad) * vScale,
                                     level.near, level.far, CoordinateSystem::WebGPU);
        pages.push_back(p);
    }
}

void PageAtlas::recordCost(int l, double ms, double delta) {
    if (l < 0 || l >= int(levels_.size()) || !std::isfinite(ms) || ms < 0) return;
    if (std::isfinite(delta) && delta > 0) frameSeconds_ = delta;
    auto& level = levels_[l];
    if (++level.costReadings <= 2) return; // Compilation and uploads are not steady-state cost.
    level.costMs = level.costMs == 0 ? ms : (level.costMs + ms) * 0.5;
    const double budget = options_.expensiveRefreshShare * std::min(frameSeconds_ * 1000, 1000.0 / 60);
    if (options_.adaptiveCasterGate && l == 0) {
        if (level.costMs > budget) level.gateScale = std::min(8.0, level.gateScale * 1.5);
        else if (level.costMs < budget * 0.5) level.gateScale = std::max(1.0, level.gateScale * 0.5);
    }
}

double PageAtlas::refreshStep(int l) const {
    const double base = at(options_.refreshStep, l);
    if (!options_.adaptiveRefresh) return base;
    const double budget = options_.expensiveRefreshShare * std::min(frameSeconds_ * 1000, 1000.0 / 60);
    const double margin = std::max(base, 1 - (at(options_.selectionGuard, l) - base) - 1.0 / mapSize(l));
    return std::min(base * std::max(1.0, levels_[l].costMs / budget), margin);
}

double PageAtlas::casterGate(int l) const {
    return options_.minCasterTexels * 2 * options_.clipExtents[l] / mapSize(l) * levels_[l].gateScale;
}

Vector3 PageAtlas::viewFocus(const Vector3& eye, const Vector3& forward, double far,
                            double extent, const std::vector<Box3>& receivers) {
    if (forward.y >= 0) return eye;
    double height = -INFINITY;
    for (const auto& box : receivers)
        if (eye.x >= box.min.x && eye.x <= box.max.x && eye.z >= box.min.z && eye.z <= box.max.z)
            height = std::max(height, box.max.y);
    if (!std::isfinite(height) || eye.y - height <= extent) return eye;
    const double distance = std::min((height - eye.y) / forward.y, far);
    Vector3 focus = eye;
    if (distance > 0) focus.addScaledVector(forward, distance);
    return focus;
}

void PageAtlas::writeTable() {
    // Nine vec4s per level followed by a row-major page table. Page rows are flipped here rather
    // than in the sampler: the light-space V axis is up; WebGPU texture Y is down.
    const int header = int(levels_.size()) * 9;
    table_.assign((header + pageCount()) * 4, 0);
    for (int l = 0; l < int(levels_.size()); ++l) {
        const auto& level = levels_[l];
        float* out = table_.data() + l * 36;
        for (int i = 0; i < 16; ++i) out[i] = float(level.matrix.elements[i]);
        out[16] = float((level.window.minX + mapSize(l) / 2.0) * level.window.pageWorldSize);
        out[17] = float((level.window.minY + mapSize(l) / 2.0) * level.window.pageWorldSize);
        out[18] = float(options_.clipExtents[l]); out[19] = float(at(options_.selectionGuard, l) - at(options_.refreshStep, l));
        // The V row is the axis whose dot product is `v`: the unit V over the window's height ratio, so the
        // shader's window distance reads pages along the height. Its length is 1 / vScale.
        Vector3 axisV = clipmap_->basisV(); axisV.multiplyScalar(1 / clipmap_->vScale());
        const Vector3 axes[] = {clipmap_->basisU(), axisV, clipmap_->basisW()};
        for (int i = 0; i < 3; ++i) { out[20 + 4*i] = float(axes[i].x); out[21 + 4*i] = float(axes[i].y); out[22 + 4*i] = float(axes[i].z); }
        out[23] = float(mapSize(l)); out[27] = float(tiles(l));
        out[31] = float(level.far - level.near);
        out[32] = float(options_.pageTexels); out[33] = float(options_.border);
        out[34] = float(edge()); out[35] = level.mapped ? 1 : 0;
        if (!level.mapped) continue;
        const int n = tiles(l);
        for (int y = 0; y < n; ++y) for (int x = 0; x < n; ++x) {
            const auto [px, py] = origin(level.slots[y * n + x]);
            float* entry = table_.data() + (header + pageBase(l) + (n - 1 - y) * n + x) * 4;
            entry[0] = float(px); entry[1] = float(py); entry[2] = 1; entry[3] = options_.receiverPlaneBias ? 1 : 0;
        }
    }
    // One vec4 per level: mover viewport origin, resolution, active. Same held camera/depth.
    for (int l = 0; l < int(levels_.size()); ++l) {
        const auto [x, y] = moverOrigin(l);
        const bool active = levels_[l].mapped && std::any_of(motion_.begin(), motion_.end(), [](const auto& e) {
            return e.second.moving || e.second.settling;
        });
        table_.insert(table_.end(), {float(x + options_.border), float(y + options_.border), float(options_.moverMapSize), active ? 1.0f : 0.0f});
    }
}
} // namespace tn::engine::shadows
