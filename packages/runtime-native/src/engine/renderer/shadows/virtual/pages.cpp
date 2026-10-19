#include "engine/renderer/shadows/virtual/pages.h"

#include "engine/foundation/math/MathUtils.h"

#include <algorithm>
#include <array>
#include <charconv>
#include <cmath>
#include <limits>

namespace tn::engine::shadows {

namespace {

/** `a·b`, in the reference's exact operation order (`((x+x)+(x))`, no fused multiply-add). */
inline double dot(const Vector3& a, const Vector3& b) { return a.x * b.x + a.y * b.y + a.z * b.z; }

/** The reference's `cross`, same component order. */
inline Vector3 cross(const Vector3& a, const Vector3& b) {
    return {a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x};
}

/** Normalises into `out`; false when the length is at or below EPSILON, matching `normalize`. */
inline bool normalize(const Vector3& in, Vector3& out) {
    const double magnitude = std::sqrt(dot(in, in));
    if (magnitude <= kPageEpsilon)
        return false;
    out = {in.x / magnitude, in.y / magnitude, in.z / magnitude};
    return true;
}

/** The eight corners of a box, the same order `cornersOfBounds` walks. */
std::array<Vector3, 8> cornersOfBounds(const Box3& bounds) {
    std::array<Vector3, 8> corners{};
    std::size_t i = 0;
    for (const double x : {bounds.min.x, bounds.max.x})
        for (const double y : {bounds.min.y, bounds.max.y})
            for (const double z : {bounds.min.z, bounds.max.z})
                corners[i++] = {x, y, z};
    return corners;
}

/** A box's centre first, then its corners: `boundsSamplePoints`. */
std::vector<Vector3> boundsSamplePoints(const Box3& bounds) {
    const Vector3 centre{(bounds.min.x + bounds.max.x) * 0.5, (bounds.min.y + bounds.max.y) * 0.5,
                         (bounds.min.z + bounds.max.z) * 0.5};
    std::vector<Vector3> points;
    points.reserve(9);
    points.push_back(centre);
    for (const Vector3& corner : cornersOfBounds(bounds))
        points.push_back(corner);
    return points;
}

bool parseInteger(std::string_view text, int& value) {
    if (text.empty())
        return false;
    long long parsed = 0;
    const auto result = std::from_chars(text.data(), text.data() + text.size(), parsed);
    if (result.ec != std::errc() || result.ptr != text.data() + text.size())
        return false;
    if (parsed < std::numeric_limits<int>::min() || parsed > std::numeric_limits<int>::max())
        return false;
    value = static_cast<int>(parsed);
    return true;
}

} // namespace

std::string makePageKey(int level, int x, int y) {
    return std::to_string(level) + ":" + std::to_string(x) + ":" + std::to_string(y);
}

bool parsePageKey(std::string_view key, PageAddress& out) {
    // Only the canonical form this module writes is accepted; JavaScript's Number() accepts more
    // spellings (" 3 ", "3.0", "0x3"), but no key this module produces needs them.
    const std::size_t first = key.find(':');
    if (first == std::string_view::npos)
        return false;
    const std::size_t second = key.find(':', first + 1);
    if (second == std::string_view::npos)
        return false;
    if (key.find(':', second + 1) != std::string_view::npos)
        return false;
    int level = 0;
    int x = 0;
    int y = 0;
    if (!parseInteger(key.substr(0, first), level))
        return false;
    if (!parseInteger(key.substr(first + 1, second - first - 1), x))
        return false;
    if (!parseInteger(key.substr(second + 1), y))
        return false;
    out = {level, x, y, std::string(key)};
    return true;
}

// -------------------------------------------------------------------------------------------
// PhysicalPagePool
// -------------------------------------------------------------------------------------------

std::optional<PhysicalPagePool> PhysicalPagePool::create(int capacity, std::string& error) {
    if (capacity <= 0) {
        error.assign(kPoolCapacityCode);
        return std::nullopt;
    }
    PhysicalPagePool pool;
    pool.capacity_ = capacity;
    pool.freeSlots_.resize(static_cast<std::size_t>(capacity));
    for (int slot = 0; slot < capacity; ++slot)
        pool.freeSlots_[static_cast<std::size_t>(slot)] = slot;
    return pool;
}

const PhysicalPageEntry* PhysicalPagePool::get(const std::string& key) const {
    const auto found = resident_.find(key);
    return found == resident_.end() ? nullptr : &found->second;
}

std::vector<PhysicalPageEntry> PhysicalPagePool::entries() const {
    std::vector<PhysicalPageEntry> result;
    result.reserve(resident_.size());
    for (const auto& [key, entry] : resident_)
        result.push_back(entry);
    std::sort(result.begin(), result.end(),
              [](const PhysicalPageEntry& a, const PhysicalPageEntry& b) { return a.slot < b.slot; });
    return result;
}

std::optional<PhysicalPageAllocation> PhysicalPagePool::allocate(const std::string& key, double frame, bool pinned,
                                                                 const std::set<std::string>& protectedKeys) {
    const auto resident = resident_.find(key);
    if (resident != resident_.end()) {
        resident->second.lastUsedFrame = frame;
        resident->second.pinned = resident->second.pinned || pinned;
        return PhysicalPageAllocation{resident->second, true, false, {}};
    }

    int slot = 0;
    std::string evictedKey;
    bool hasEvicted = false;
    if (freeSlots_.empty()) {
        // The least recently used unpinned, unprotected page; a slot tie breaks toward the lower
        // slot, exactly as the reference's `(lastUsedFrame, slot)` sort does.
        const std::vector<PhysicalPageEntry> all = entries();
        const PhysicalPageEntry* candidate = nullptr;
        for (const PhysicalPageEntry& entry : all) {
            if (entry.pinned || protectedKeys.count(entry.key) != 0)
                continue;
            if (candidate == nullptr || entry.lastUsedFrame < candidate->lastUsedFrame ||
                (entry.lastUsedFrame == candidate->lastUsedFrame && entry.slot < candidate->slot))
                candidate = &entry;
        }
        if (candidate == nullptr) {
            overflow_ += 1;
            return std::nullopt;
        }
        slot = candidate->slot;
        evictedKey = candidate->key;
        hasEvicted = true;
        resident_.erase(candidate->key);
        evictions_ += 1;
    } else {
        slot = freeSlots_.front();
        freeSlots_.erase(freeSlots_.begin());
    }

    generation_ += 1;
    const PhysicalPageEntry entry{key, slot, pinned, true, generation_, frame};
    resident_[key] = entry;
    return PhysicalPageAllocation{entry, false, hasEvicted, evictedKey};
}

// -------------------------------------------------------------------------------------------
// DirectionalClipmap
// -------------------------------------------------------------------------------------------

std::optional<DirectionalClipmap> DirectionalClipmap::create(const DirectionalClipmapOptions& options,
                                                             std::string& error) {
    if (!std::isfinite(options.direction.x) || !std::isfinite(options.direction.y) ||
        !std::isfinite(options.direction.z)) {
        error.assign(kClipmapDirectionCode);
        return std::nullopt;
    }
    Vector3 w;
    if (!normalize(options.direction, w)) {
        error.assign(kClipmapDirectionCode);
        return std::nullopt;
    }
    if (options.pagesPerAxis <= 0) {
        error.assign(kClipmapPagesCode);
        return std::nullopt;
    }
    if (options.clipExtents.empty()) {
        error.assign(kClipmapExtentsCode);
        return std::nullopt;
    }
    for (const double extent : options.clipExtents) {
        if (!std::isfinite(extent) || extent <= 0) {
            error.assign(kClipmapExtentsCode);
            return std::nullopt;
        }
    }
    for (std::size_t level = 1; level < options.clipExtents.size(); ++level) {
        if (options.clipExtents[level] <= options.clipExtents[level - 1]) {
            error.assign(kClipmapExtentsCode);
            return std::nullopt;
        }
    }
    if (options.selectionGuard.empty() || options.refreshStep.empty()) {
        error.assign(kClipmapGuardCode);
        return std::nullopt;
    }
    for (const double guard : options.selectionGuard) {
        if (!(std::isfinite(guard) && guard > 0 && guard <= 1)) {
            error.assign(kClipmapGuardCode);
            return std::nullopt;
        }
    }
    for (const double step : options.refreshStep) {
        if (!(std::isfinite(step) && step >= 0 && step < 1)) {
            error.assign(kClipmapRefreshCode);
            return std::nullopt;
        }
    }
    for (std::size_t level = 0; level < options.selectionGuard.size(); ++level) {
        if (level < options.refreshStep.size() && options.refreshStep[level] >= options.selectionGuard[level]) {
            error.assign(kClipmapRefreshCode);
            return std::nullopt;
        }
    }

    DirectionalClipmap clipmap;
    clipmap.clipExtents_ = options.clipExtents;
    clipmap.pagesPerAxis_ = options.pagesPerAxis;
    clipmap.levelCount_ = static_cast<int>(options.clipExtents.size());
    clipmap.selectionGuard_ = options.selectionGuard;
    clipmap.refreshStep_.resize(static_cast<std::size_t>(clipmap.levelCount_));
    for (int level = 0; level < clipmap.levelCount_; ++level)
        clipmap.refreshStep_[static_cast<std::size_t>(level)] = clipmap.perLevel(options.refreshStep, level);
    clipmap.basisW_ = w;
    clipmap.basisU_ = {1, 0, 0};
    clipmap.basisV_ = {0, 0, 1};
    // The reference's `setDirection` body, with the windows empty on first build.
    const Vector3 reference = std::abs(clipmap.basisW_.y) > 0.95 ? Vector3{0, 0, 1} : Vector3{0, 1, 0};
    Vector3 u;
    Vector3 v;
    normalize(cross(clipmap.basisW_, reference), u);
    normalize(cross(clipmap.basisW_, u), v);
    clipmap.basisU_ = u;
    clipmap.basisV_ = v;
    clipmap.updateCenter(clipmap.centerWorld_);
    return clipmap;
}

LightSpacePoint DirectionalClipmap::project(const Vector3& worldPoint) const {
    return {dot(worldPoint, basisU_), dot(worldPoint, basisV_), dot(worldPoint, basisW_)};
}

const std::vector<ClipWindow>& DirectionalClipmap::updateCenter(const Vector3& worldPoint) {
    const LightSpacePoint previousCenter = centerLight_;
    centerWorld_ = worldPoint;
    centerLight_ = project(worldPoint);
    const int halfPages = static_cast<int>(std::floor(static_cast<double>(pagesPerAxis_) / 2.0));
    const std::vector<ClipWindow> previous = windows_;
    windows_.clear();
    windows_.reserve(static_cast<std::size_t>(levelCount_));
    for (int level = 0; level < levelCount_; ++level) {
        const double extent = clipExtents_[static_cast<std::size_t>(level)];
        const double pageWorldSize = (extent * 2.0) / static_cast<double>(pagesPerAxis_);
        const double step = perLevel(refreshStep_, level);
        // `Math.Round` ties toward +Infinity; `jsRound` keeps that. `step === 0` keeps the old
        // one-page floor addressing.
        const int refreshPages =
            step == 0 ? 1 : static_cast<int>(jsMax(1.0, jsRound((step * extent) / pageWorldSize) - 1.0));
        const ClipWindow* previousWindow =
            level < static_cast<int>(previous.size()) ? &previous[static_cast<std::size_t>(level)] : nullptr;
        const int minX = static_cast<int>(std::floor(centerLight_.u / pageWorldSize)) - halfPages;
        const int minY = static_cast<int>(std::floor(centerLight_.v / pageWorldSize)) - halfPages;
        if (previousWindow != nullptr &&
            ((centerLight_.u == previousCenter.u && centerLight_.v == previousCenter.v) ||
             (jsMax(std::abs(minX - previousWindow->minX), std::abs(minY - previousWindow->minY)) < refreshPages &&
              jsMax(std::abs(centerLight_.u - (previousWindow->minX + halfPages) * pageWorldSize),
                    std::abs(centerLight_.v - (previousWindow->minY + halfPages) * pageWorldSize)) <
                  refreshPages * pageWorldSize))) {
            ClipWindow kept = *previousWindow;
            kept.refreshPages = refreshPages;
            windows_.push_back(kept);
            continue;
        }
        ClipWindow window;
        window.level = level;
        window.extent = extent;
        window.pageWorldSize = pageWorldSize;
        window.refreshPages = refreshPages;
        window.minX = minX;
        window.minY = minY;
        window.maxX = minX + pagesPerAxis_;
        window.maxY = minY + pagesPerAxis_;
        windows_.push_back(window);
    }
    return windows_;
}

const ClipWindow& DirectionalClipmap::windowAt(int level) const {
    static const ClipWindow empty{};
    if (level < 0 || level >= static_cast<int>(windows_.size()))
        return empty;
    return windows_[static_cast<std::size_t>(level)];
}

bool DirectionalClipmap::containsPage(int level, int x, int y) const {
    if (level < 0 || level >= static_cast<int>(windows_.size()))
        return false;
    const ClipWindow& window = windows_[static_cast<std::size_t>(level)];
    return x >= window.minX && x < window.maxX && y >= window.minY && y < window.maxY;
}

PageAddress DirectionalClipmap::worldToPage(const Vector3& worldPoint, int level) const {
    const ClipWindow& window = windowAt(level);
    const LightSpacePoint projected = project(worldPoint);
    const int x = static_cast<int>(std::floor(projected.u / window.pageWorldSize));
    const int y = static_cast<int>(std::floor(projected.v / window.pageWorldSize));
    return {level, x, y, makePageKey(level, x, y)};
}

int DirectionalClipmap::selectLevel(const Vector3& worldPoint) const {
    const LightSpacePoint projected = project(worldPoint);
    const double distance = jsMax(std::abs(projected.u - centerLight_.u), std::abs(projected.v - centerLight_.v));
    for (int level = 0; level < levelCount_; ++level) {
        if (distance <= clipExtents_[static_cast<std::size_t>(level)] * perLevel(selectionGuard_, level))
            return level;
    }
    return levelCount_ - 1;
}

PageRange DirectionalClipmap::boundsToPageRange(const Box3& bounds, int level) const {
    const ClipWindow& window = windowAt(level);
    double minU = std::numeric_limits<double>::infinity();
    double maxU = -std::numeric_limits<double>::infinity();
    double minV = std::numeric_limits<double>::infinity();
    double maxV = -std::numeric_limits<double>::infinity();
    for (const Vector3& corner : cornersOfBounds(bounds)) {
        const LightSpacePoint projected = project(corner);
        minU = jsMin(minU, projected.u);
        maxU = jsMax(maxU, projected.u);
        minV = jsMin(minV, projected.v);
        maxV = jsMax(maxV, projected.v);
    }
    const double pageSize = window.pageWorldSize;
    return {
        static_cast<int>(std::floor(minU / pageSize)), static_cast<int>(std::floor((maxU - kPageEpsilon) / pageSize)),
        static_cast<int>(std::floor(minV / pageSize)), static_cast<int>(std::floor((maxV - kPageEpsilon) / pageSize))};
}

std::vector<std::string> DirectionalClipmap::boundsToPageKeys(const Box3& bounds, int level) const {
    const PageRange range = boundsToPageRange(bounds, level);
    std::vector<std::string> keys;
    for (int x = range.minX; x <= range.maxX; ++x)
        for (int y = range.minY; y <= range.maxY; ++y)
            keys.push_back(makePageKey(level, x, y));
    return keys;
}

std::vector<PageAddress> DirectionalClipmap::windowPages(int level) const {
    const ClipWindow& window = windowAt(level);
    std::vector<PageAddress> pages;
    pages.reserve(static_cast<std::size_t>(window.maxX - window.minX) *
                  static_cast<std::size_t>(window.maxY - window.minY));
    for (int x = window.minX; x < window.maxX; ++x)
        for (int y = window.minY; y < window.maxY; ++y)
            pages.push_back({level, x, y, makePageKey(level, x, y)});
    return pages;
}

ProjectedRange projectBounds(const Box3& bounds, const Vector3& axis) {
    const double halfX = (bounds.max.x - bounds.min.x) / 2;
    const double halfY = (bounds.max.y - bounds.min.y) / 2;
    const double halfZ = (bounds.max.z - bounds.min.z) / 2;
    const double centreX = (bounds.max.x + bounds.min.x) / 2;
    const double centreY = (bounds.max.y + bounds.min.y) / 2;
    const double centreZ = (bounds.max.z + bounds.min.z) / 2;
    const double reach = std::abs(axis.x) * halfX + std::abs(axis.y) * halfY + std::abs(axis.z) * halfZ;
    const double middle = centreX * axis.x + centreY * axis.y + centreZ * axis.z;
    return {middle - reach, middle + reach};
}

// -------------------------------------------------------------------------------------------
// ReceiverDemandPass
// -------------------------------------------------------------------------------------------

std::optional<ReceiverDemandPass> ReceiverDemandPass::create(int guardBand, std::string& error) {
    if (guardBand < 0) {
        error.assign(kGuardBandCode);
        return std::nullopt;
    }
    ReceiverDemandPass pass;
    pass.guardBand_ = guardBand;
    return pass;
}

std::vector<PageRequest> ReceiverDemandPass::collect(const ReceiverDemandInput& input,
                                                     const DirectionalClipmap& clipmap) const {
    std::vector<PageRequest> requests;
    std::map<std::string, std::size_t> index;
    const LightSpacePoint cameraLight = clipmap.project(input.cameraPosition);

    const auto addRequest = [&](const PageAddress& address, bool pinned, double priority) {
        if (!clipmap.containsPage(address.level, address.x, address.y))
            return;
        const auto found = index.find(address.key);
        if (found == index.end()) {
            index.emplace(address.key, requests.size());
            requests.push_back(PageRequest{address, pinned, priority});
            return;
        }
        PageRequest& existing = requests[found->second];
        existing.pinned = existing.pinned || pinned;
        existing.priority = jsMin(existing.priority, priority);
    };

    const auto addPoint = [&](const Vector3& point) {
        const int level = clipmap.selectLevel(point);
        const PageAddress page = clipmap.worldToPage(point, level);
        const LightSpacePoint projected = clipmap.project(point);
        const double du = projected.u - cameraLight.u;
        const double dv = projected.v - cameraLight.v;
        const double basePriority = du * du + dv * dv;
        for (int dx = -guardBand_; dx <= guardBand_; ++dx) {
            for (int dy = -guardBand_; dy <= guardBand_; ++dy) {
                const PageAddress address{level, page.x + dx, page.y + dy,
                                          makePageKey(level, page.x + dx, page.y + dy)};
                addRequest(address, false, basePriority + (dx * dx + dy * dy) * 0.001);
            }
        }
    };

    for (const Vector3& point : input.receiverPoints)
        addPoint(point);
    for (const Box3& bounds : input.visibleBounds)
        for (const Vector3& point : boundsSamplePoints(bounds))
            addPoint(point);
    for (const PageAddress& page : clipmap.windowPages(clipmap.levelCount() - 1))
        addRequest(page, true, -1.0);

    // Pinned first, then the fine level nearest the camera. The x/y tiebreak makes the order total,
    // so the reference's stable sort and this one agree on every distinct key.
    std::sort(requests.begin(), requests.end(), [](const PageRequest& a, const PageRequest& b) {
        if (a.pinned != b.pinned)
            return a.pinned;
        if (a.address.level != b.address.level)
            return a.address.level < b.address.level;
        if (a.priority != b.priority)
            return a.priority < b.priority;
        if (a.address.x != b.address.x)
            return a.address.x < b.address.x;
        return a.address.y < b.address.y;
    });
    return requests;
}

// -------------------------------------------------------------------------------------------
// ShadowInvalidationTracker
// -------------------------------------------------------------------------------------------

bool boundsEqual(const Box3& a, const Box3& b) {
    return std::abs(a.min.x - b.min.x) <= kBoundsEpsilon && std::abs(a.max.x - b.max.x) <= kBoundsEpsilon &&
           std::abs(a.min.y - b.min.y) <= kBoundsEpsilon && std::abs(a.max.y - b.max.y) <= kBoundsEpsilon &&
           std::abs(a.min.z - b.min.z) <= kBoundsEpsilon && std::abs(a.max.z - b.max.z) <= kBoundsEpsilon;
}

void ShadowInvalidationTracker::invalidateBounds(const Box3& bounds) {
    for (int level = 0; level < clipmap_->levelCount(); ++level) {
        for (const std::string& key : clipmap_->boundsToPageKeys(bounds, level))
            invalidated_.insert(key);
    }
}

bool ShadowInvalidationTracker::update(const std::string& id, const Box3& bounds) {
    const auto previous = tracked_.find(id);
    if (previous != tracked_.end() && boundsEqual(previous->second, bounds))
        return false;
    if (previous != tracked_.end())
        invalidateBounds(previous->second);
    invalidateBounds(bounds);
    tracked_[id] = bounds;
    return true;
}

bool ShadowInvalidationTracker::remove(const std::string& id) {
    const auto found = tracked_.find(id);
    if (found == tracked_.end())
        return false;
    invalidateBounds(found->second);
    tracked_.erase(found);
    return true;
}

std::vector<std::string> ShadowInvalidationTracker::consumeInvalidatedKeys() {
    std::vector<std::string> keys(invalidated_.begin(), invalidated_.end());
    invalidated_.clear();
    return keys;
}

} // namespace tn::engine::shadows
