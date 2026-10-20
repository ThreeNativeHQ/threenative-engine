#include "atlas.h"

#include <algorithm>
#include <cmath>

namespace tn::engine::shadows {
namespace {
double at(const std::vector<double>& values, int level) { return values[std::min<int>(level, values.size() - 1)]; }
}

std::optional<PageAtlas> PageAtlas::create(const AtlasOptions& options, std::string& error) {
    if (options.mapSize <= 0 || options.mapSize > 4096 || options.pageTexels <= 0 ||
        options.mapSize % options.pageTexels || options.border < 1 || options.border > 64 ||
        options.staticAfterFrames <= 0 || options.moverMapSize < 1 || options.moverMapSize > 4096 ||
        !std::isfinite(options.expensiveRefreshShare) || options.expensiveRefreshShare <= 0 || options.expensiveRefreshShare > 1 ||
        !std::isfinite(options.minCasterTexels) || options.minCasterTexels < 0 ||
        options.invalidationDelay.empty() || std::any_of(options.invalidationDelay.begin(), options.invalidationDelay.end(),
            [](double v) { return !std::isfinite(v) || v < 0; }) || options.clipExtents.size() > 8 || options.selectionGuard.empty() || options.refreshStep.empty() ||
        !std::isfinite(options.lightDistance) || options.lightDistance <= 1 ||
        !std::isfinite(options.depthRange) || options.depthRange <= 0) {
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
    out.clipmap_ = DirectionalClipmap::create({{0, 1, 0}, options.clipExtents, options.mapSize, guards, options.refreshStep}, error);
    if (!out.clipmap_) return std::nullopt;
    const int count = out.tiles() * out.tiles() * int(options.clipExtents.size());
    if (count > 4096) { error = "TN_VIRTUAL_SHADOW_INVALID: page capacity"; return std::nullopt; }
    out.pool_ = PhysicalPagePool::create(count, error);
    out.slotsPerAxis_ = int(std::ceil(std::sqrt(count)));
    out.levels_.resize(options.clipExtents.size());
    return out;
}

void PageAtlas::invalidateAll() { for (auto& level : levels_) { level.dirty = true; level.dirtyAll = true; } }

void PageAtlas::invalidate(const Box3& bounds, bool urgent) {
    for (auto& level : levels_) {
        if (!level.mapped) continue;
        const auto u = projectBounds(bounds, clipmap_->basisU()), v = projectBounds(bounds, clipmap_->basisV());
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
        clipmap_ = DirectionalClipmap::create({direction, options_.clipExtents, options_.mapSize, guards, options_.refreshStep}, error);
        // The renderer validates the direction before entering this CPU plan.
        if (!clipmap_) return {};
        pool_ = PhysicalPagePool::create(tiles() * tiles() * int(levels_.size()), error);
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
    const auto& windows = clipmap_->updateCenter(eye);
    const auto center = clipmap_->project(eye);
    ++frame_;
    std::vector<AtlasPage> pages;
    // Protect all held levels until their own replacement has been rendered.
    std::set<std::string> protectedKeys;
    for (int l = 0; l < int(levels_.size()); ++l) if (levels_[l].mapped)
        for (int y = 0; y < tiles(); ++y) for (int x = 0; x < tiles(); ++x)
            protectedKeys.insert(makePageKey(l, levels_[l].window.minX + x * options_.pageTexels,
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
        if (level.mapped) for (int y = 0; y < tiles(); ++y) for (int x = 0; x < tiles(); ++x)
            protectedKeys.erase(makePageKey(l, level.window.minX + x * options_.pageTexels, level.window.minY + y * options_.pageTexels));
        const Matrix4 oldMatrix = level.matrix;
        bool partial = !moved && level.mapped && !level.dirtyAll && options_.partialRedraw;
        level.window = window;
        level.centerW = center.w;
        const double cu = (window.minX + options_.mapSize / 2.0) * window.pageWorldSize;
        const double cv = (window.minY + options_.mapSize / 2.0) * window.pageWorldSize;
        Vector3 target = clipmap_->basisU(); target.multiplyScalar(cu);
        target.addScaledVector(clipmap_->basisV(), cv).addScaledVector(clipmap_->basisW(), center.w);
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
        projection.makeOrthographic(-window.extent, window.extent, window.extent, -window.extent,
                                    level.near, level.far, CoordinateSystem::WebGPU);
        level.projection = projection;
        level.matrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 1, 0, 0, 0, 0, 1);
        level.matrix.multiply(projection).multiply(level.view);
        partial = partial && oldMatrix.elements == level.matrix.elements;
        level.slots.clear();
        level.pages.clear();
        for (int y = 0; y < tiles(); ++y) for (int x = 0; x < tiles(); ++x) {
            const std::string key = makePageKey(l, window.minX + x * options_.pageTexels, window.minY + y * options_.pageTexels);
            const auto allocation = pool_->allocate(key, frame_, false, protectedKeys);
            if (!allocation) { level.mapped = false; writeTable(); return {}; }
            protectedKeys.insert(key);
            level.slots.push_back(allocation->entry.slot);
            const double texel = window.pageWorldSize, pad = options_.border * texel;
            const double left = -window.extent + x * options_.pageTexels * texel;
            const double bottom = -window.extent + y * options_.pageTexels * texel;
            AtlasPage page; page.level = l; page.x = x; page.y = y; page.slot = allocation->entry.slot; page.view = level.view;
            page.projection.makeOrthographic(left - pad, left + options_.pageTexels * texel + pad,
                bottom + options_.pageTexels * texel + pad, bottom - pad,
                level.near, level.far, CoordinateSystem::WebGPU);
            page.axisU.set(world.elements[0], world.elements[1], world.elements[2]);
            page.axisV.set(world.elements[4], world.elements[5], world.elements[6]);
            const double cameraU = target.dot(page.axisU), cameraV = target.dot(page.axisV);
            page.lowU = cameraU + left - pad; page.highU = cameraU + left + options_.pageTexels * texel + pad;
            page.lowV = cameraV + bottom - pad; page.highV = cameraV + bottom + options_.pageTexels * texel + pad;
            level.pages.push_back(page);
            if (!partial || level.dirtySlots.count(page.slot)) pages.push_back(page);
        }
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
    return {0, staticEdge() + level * (options_.moverMapSize + 2 * options_.border)};
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
            if (!m.moving && !inserted) invalidate(m.caster.bounds, true);
            m.moving = true; m.quiet = 0; m.settling = 0;
        } else if (m.moving && (caster.pinned || ++m.quiet >= options_.staticAfterFrames)) {
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
        p.projection.makeOrthographic(-extent-pad, extent+pad, extent+pad, -extent-pad,
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
    const double margin = std::max(base, 1 - (at(options_.selectionGuard, l) - base) - 1.0 / options_.mapSize);
    return std::min(base * std::max(1.0, levels_[l].costMs / budget), margin);
}

double PageAtlas::casterGate(int l) const {
    return options_.minCasterTexels * 2 * options_.clipExtents[l] / options_.mapSize * levels_[l].gateScale;
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
    table_.assign((header + int(levels_.size()) * tiles() * tiles()) * 4, 0);
    for (int l = 0; l < int(levels_.size()); ++l) {
        const auto& level = levels_[l];
        float* out = table_.data() + l * 36;
        for (int i = 0; i < 16; ++i) out[i] = float(level.matrix.elements[i]);
        out[16] = float((level.window.minX + options_.mapSize / 2.0) * level.window.pageWorldSize);
        out[17] = float((level.window.minY + options_.mapSize / 2.0) * level.window.pageWorldSize);
        out[18] = float(options_.clipExtents[l]); out[19] = float(at(options_.selectionGuard, l) - at(options_.refreshStep, l));
        const Vector3 axes[] = {clipmap_->basisU(), clipmap_->basisV(), clipmap_->basisW()};
        for (int i = 0; i < 3; ++i) { out[20 + 4*i] = float(axes[i].x); out[21 + 4*i] = float(axes[i].y); out[22 + 4*i] = float(axes[i].z); }
        out[23] = float(options_.mapSize); out[27] = float(tiles());
        out[31] = float(level.far - level.near);
        out[32] = float(options_.pageTexels); out[33] = float(options_.border);
        out[34] = float(edge()); out[35] = level.mapped ? 1 : 0;
        if (!level.mapped) continue;
        for (int y = 0; y < tiles(); ++y) for (int x = 0; x < tiles(); ++x) {
            const auto [px, py] = origin(level.slots[y * tiles() + x]);
            float* entry = table_.data() + (header + l * tiles() * tiles() + (tiles() - 1 - y) * tiles() + x) * 4;
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
