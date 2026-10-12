#include "atlas.h"

#include <algorithm>
#include <cmath>

namespace tn::engine::shadows {
namespace {
double at(const std::vector<double>& values, int level) { return values[std::min<int>(level, values.size() - 1)]; }
}

std::optional<PageAtlas> PageAtlas::create(const AtlasOptions& options, std::string& error) {
    const std::pair<const char*, bool> unsupported[] = {
        {"automatic depth (supply lightDistance and depthRange)", options.lightDistance == 0 || options.depthRange == 0},
        {"adaptiveRefresh", options.adaptiveRefresh}, {"adaptiveCasterGate", options.adaptiveCasterGate},
        {"followViewFocus", options.followViewFocus}, {"shadowLodBias", options.shadowLodBias},
        {"minCasterTexels", options.minCasterTexels != 0},
        {"invalidationDelay", options.invalidationDelay.empty() || std::any_of(options.invalidationDelay.begin(), options.invalidationDelay.end(), [](double v) { return v != 0; })}};
    for (const auto& [name, active] : unsupported) if (active) {
        error = "TN_VIRTUAL_SHADOW_UNSUPPORTED: " + std::string(name); return std::nullopt;
    }
    if (options.mapSize <= 0 || options.mapSize > 4096 || options.pageTexels <= 0 ||
        options.mapSize % options.pageTexels || options.border < 1 || options.border > 64 ||
        options.clipExtents.size() > 8 || options.selectionGuard.empty() || options.refreshStep.empty() ||
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

void PageAtlas::invalidateAll() { for (auto& level : levels_) level.dirty = true; }

void PageAtlas::invalidate(const Box3& bounds) {
    for (auto& level : levels_) {
        if (!level.mapped) continue;
        const auto u = projectBounds(bounds, clipmap_->basisU()), v = projectBounds(bounds, clipmap_->basisV());
        const double lowU = level.window.minX * level.window.pageWorldSize;
        const double lowV = level.window.minY * level.window.pageWorldSize;
        if (u.low <= lowU + 2 * level.window.extent && u.high >= lowU &&
            v.low <= lowV + 2 * level.window.extent && v.high >= lowV) level.dirty = true;
    }
}

bool PageAtlas::overlaps(const AtlasPage& page, const Box3& bounds) const {
    const auto u = projectBounds(bounds, page.axisU), v = projectBounds(bounds, page.axisV);
    return u.low <= page.highU && u.high >= page.lowU && v.low <= page.highV && v.high >= page.lowV;
}

std::vector<AtlasPage> PageAtlas::update(const Vector3& eye, const Vector3& towards, bool cameraCut) {
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
    direction_ = direction;
    previousEye_ = eye;
    started_ = true;
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
    for (int l = 0; l < int(levels_.size()); ++l) {
        auto& level = levels_[l];
        const auto& window = windows[l];
        if (level.mapped && !level.dirty && level.window.minX == window.minX && level.window.minY == window.minY) continue;
        if (level.mapped) for (int y = 0; y < tiles(); ++y) for (int x = 0; x < tiles(); ++x)
            protectedKeys.erase(makePageKey(l, level.window.minX + x * options_.pageTexels, level.window.minY + y * options_.pageTexels));
        level.window = window;
        level.centerW = center.w;
        const double cu = (window.minX + options_.mapSize / 2.0) * window.pageWorldSize;
        const double cv = (window.minY + options_.mapSize / 2.0) * window.pageWorldSize;
        Vector3 target = clipmap_->basisU(); target.multiplyScalar(cu);
        target.addScaledVector(clipmap_->basisV(), cv).addScaledVector(clipmap_->basisW(), center.w);
        Vector3 from = target; from.addScaledVector(clipmap_->basisW(), options_.lightDistance);
        Matrix4 world; world.lookAt(from, target, Vector3(0, 1, 0)); world.setPosition(from);
        level.view = world; level.view.invert();
        Matrix4 projection;
        projection.makeOrthographic(-window.extent, window.extent, window.extent, -window.extent,
                                    1, options_.lightDistance + options_.depthRange, CoordinateSystem::WebGPU);
        level.matrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 1, 0, 0, 0, 0, 1);
        level.matrix.multiply(projection).multiply(level.view);
        level.slots.clear();
        for (int y = 0; y < tiles(); ++y) for (int x = 0; x < tiles(); ++x) {
            const std::string key = makePageKey(l, window.minX + x * options_.pageTexels, window.minY + y * options_.pageTexels);
            const auto allocation = pool_->allocate(key, frame_, false, protectedKeys);
            if (!allocation) { level.mapped = false; writeTable(); return {}; }
            protectedKeys.insert(key);
            level.slots.push_back(allocation->entry.slot);
            const double texel = window.pageWorldSize, pad = options_.border * texel;
            const double left = -window.extent + x * options_.pageTexels * texel;
            const double bottom = -window.extent + y * options_.pageTexels * texel;
            AtlasPage page{l, x, y, allocation->entry.slot, level.view};
            page.projection.makeOrthographic(left - pad, left + options_.pageTexels * texel + pad,
                bottom + options_.pageTexels * texel + pad, bottom - pad,
                1, options_.lightDistance + options_.depthRange, CoordinateSystem::WebGPU);
            page.axisU.set(world.elements[0], world.elements[1], world.elements[2]);
            page.axisV.set(world.elements[4], world.elements[5], world.elements[6]);
            const double cameraU = target.dot(page.axisU), cameraV = target.dot(page.axisV);
            page.lowU = cameraU + left - pad; page.highU = cameraU + left + options_.pageTexels * texel + pad;
            page.lowV = cameraV + bottom - pad; page.highV = cameraV + bottom + options_.pageTexels * texel + pad;
            pages.push_back(page);
        }
        level.mapped = true;
        level.dirty = false;
        break;
    }
    writeTable();
    return pages;
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
        out[18] = float(options_.clipExtents[l]); out[19] = float(at(options_.selectionGuard, l));
        const Vector3 axes[] = {clipmap_->basisU(), clipmap_->basisV(), clipmap_->basisW()};
        for (int i = 0; i < 3; ++i) { out[20 + 4*i] = float(axes[i].x); out[21 + 4*i] = float(axes[i].y); out[22 + 4*i] = float(axes[i].z); }
        out[23] = float(options_.mapSize); out[27] = float(tiles());
        out[31] = float(options_.lightDistance + options_.depthRange - 1);
        out[32] = float(options_.pageTexels); out[33] = float(options_.border);
        out[34] = float(edge()); out[35] = level.mapped ? 1 : 0;
        if (!level.mapped) continue;
        for (int y = 0; y < tiles(); ++y) for (int x = 0; x < tiles(); ++x) {
            const auto [px, py] = origin(level.slots[y * tiles() + x]);
            float* entry = table_.data() + (header + l * tiles() * tiles() + (tiles() - 1 - y) * tiles() + x) * 4;
            entry[0] = float(px); entry[1] = float(py); entry[2] = 1; entry[3] = options_.receiverPlaneBias ? 1 : 0;
        }
    }
}
} // namespace tn::engine::shadows
