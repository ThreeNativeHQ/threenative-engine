#pragma once

// The CPU bookkeeping for virtual shadow pages, ported from
// packages/core/src/render/virtual-shadow-pages.ts (PRD-524 phase 1). None of it knows a GPU exists:
// stable virtual page addresses and a bounded LRU physical page pool, camera-centred clip windows in
// a light-space basis, the pages a frame requests from receiver feedback, and the pages a moving
// caster invalidates.
//
// Engine code never throws. A malformed constructor argument is refused by a named code from a
// `create` factory returning `std::nullopt`. JavaScript semantics are kept where C++ differs, and
// every such site says so in a comment:
//   - `Math.round` ties toward +Infinity (`jsRound`), not away from zero;
//   - `Math.min`/`Math.max` poison on NaN and respect signed zero (`jsMin`/`jsMax`);
//   - a page key is a string, compared byte for byte, and a Map's insertion order is kept;
//   - every division is binary64; no integer division is used.

#include <cstddef>
#include <cstdint>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <vector>

#include "engine/foundation/math/Primitives.h"
#include "engine/foundation/math/Vector.h"

namespace tn::engine::shadows {

/** The reference's EPSILON, keeping a bounds' max edge just inside its own page. */
inline constexpr double kPageEpsilon = 1e-9;

/** Bounds within this distance on every axis are the same bounds, so nothing is dirtied. */
inline constexpr double kBoundsEpsilon = 1e-6;

/** Refusal codes (engine code never throws). */
inline constexpr std::string_view kPageKeyCode = "TN_SHADOWS_PAGE_KEY";
inline constexpr std::string_view kPoolCapacityCode = "TN_SHADOWS_POOL_CAPACITY";
inline constexpr std::string_view kClipmapDirectionCode = "TN_SHADOWS_CLIPMAP_DIRECTION";
inline constexpr std::string_view kClipmapExtentsCode = "TN_SHADOWS_CLIPMAP_EXTENTS";
inline constexpr std::string_view kClipmapPagesCode = "TN_SHADOWS_CLIPMAP_PAGES";
inline constexpr std::string_view kClipmapGuardCode = "TN_SHADOWS_CLIPMAP_GUARD";
inline constexpr std::string_view kClipmapRefreshCode = "TN_SHADOWS_CLIPMAP_REFRESH";
inline constexpr std::string_view kGuardBandCode = "TN_SHADOWS_GUARD_BAND";

/** A page's signed integer coordinates within one clip level, plus the reference's string key. */
struct PageAddress {
    int level = 0;
    int x = 0;
    int y = 0;
    std::string key;
};

/** The string key of a virtual page: `level:x:y`. Negative coordinates keep their sign. */
std::string makePageKey(int level, int x, int y);

/** Parses a canonical key; returns false (never a throw) for anything else. */
bool parsePageKey(std::string_view key, PageAddress& out);

/** A point in the light-space basis: `u` and `v` across the light, `w` toward it. */
struct LightSpacePoint {
    double u = 0;
    double v = 0;
    double w = 0;
};

// ---------------------------------------------------------------------------------------------
// PhysicalPagePool
// ---------------------------------------------------------------------------------------------

/** One resident physical page. `slot` is the atlas layer that holds it. */
struct PhysicalPageEntry {
    std::string key;
    int slot = 0;
    bool pinned = false;
    bool dirty = true;
    uint64_t generation = 0;
    double lastUsedFrame = 0;
};

/** The result of one allocation: the entry (a value copy), and what was evicted to make room. */
struct PhysicalPageAllocation {
    PhysicalPageEntry entry;
    bool reused = false;
    bool hasEvicted = false;
    std::string evictedKey;
};

/**
 * A bounded set of physical page slots with deterministic least-recently-used eviction.
 *
 * Pinned entries and entries in `protectedKeys` are never evicted; when nothing else can go,
 * `allocate` returns `std::nullopt` and counts an overflow rather than silently reusing a page.
 */
class PhysicalPagePool {
  public:
    /** Builds the pool, or refuses a capacity that is not a positive integer. */
    static std::optional<PhysicalPagePool> create(int capacity, std::string& error);

    [[nodiscard]] int capacity() const { return capacity_; }
    [[nodiscard]] std::size_t size() const { return resident_.size(); }
    [[nodiscard]] uint32_t evictions() const { return evictions_; }
    [[nodiscard]] uint32_t overflow() const { return overflow_; }

    [[nodiscard]] bool has(const std::string& key) const { return resident_.count(key) != 0; }

    [[nodiscard]] const PhysicalPageEntry* get(const std::string& key) const;

    /** Resident entries ordered by slot, as the reference's `entries()`. */
    [[nodiscard]] std::vector<PhysicalPageEntry> entries() const;

    /**
     * Allocates `key`, or returns `std::nullopt` when every candidate is pinned or protected.
     * `frame` is a JavaScript number and stays binary64.
     */
    std::optional<PhysicalPageAllocation> allocate(const std::string& key, double frame, bool pinned = false,
                                                   const std::set<std::string>& protectedKeys = {});

  private:
    PhysicalPagePool() = default;

    int capacity_ = 0;
    uint32_t evictions_ = 0;
    uint32_t overflow_ = 0;
    uint64_t generation_ = 0;
    std::map<std::string, PhysicalPageEntry> resident_;
    std::vector<int> freeSlots_;
};

// ---------------------------------------------------------------------------------------------
// DirectionalClipmap
// ---------------------------------------------------------------------------------------------

/** One clip level's window of `pagesPerAxis²` virtual pages around the centre. */
struct ClipWindow {
    int level = 0;
    double extent = 0;
    double pageWorldSize = 0;
    /** Whole pages the window trails its followed centre by before it moves and re-renders. */
    int refreshPages = 1;
    int minX = 0;
    int minY = 0;
    int maxX = 0;
    int maxY = 0;
};

/** The clipmap configuration, mirrors of the reference's option object. */
struct DirectionalClipmapOptions {
    /** Unit-free direction *toward* the source; normalised by `create`. */
    Vector3 direction;
    /** Half-width of each level's window in world units, finest first. */
    std::vector<double> clipExtents;
    int pagesPerAxis = 0;
    /**
     * Fraction of an extent inside which a point selects that level, `(0, 1]`. One value for every
     * level, or one per level finest first, the last entry standing in for the rest.
     */
    std::vector<double> selectionGuard{0.9};
    /** Like `selectionGuard`, in `[0, 1)`; default 0.125. */
    std::vector<double> refreshStep{0.125};
};

/** Inclusive integer page range an axis-aligned box covers on one level. */
struct PageRange {
    int minX = 0;
    int maxX = 0;
    int minY = 0;
    int maxY = 0;
};

/**
 * Camera-centred clip windows in a light-space basis, snapped to whole pages.
 *
 * The basis is right-handed (`U × V = W`); a page camera placed along `+W` with `up = V` then
 * renders screen X = `V × W` = `+U`, the axis the sampler reads the atlas along.
 */
class DirectionalClipmap {
  public:
    /** Builds the clipmap, or refuses malformed extents, guards or steps by a named code. */
    static std::optional<DirectionalClipmap> create(const DirectionalClipmapOptions& options, std::string& error);

    [[nodiscard]] const std::vector<double>& clipExtents() const { return clipExtents_; }
    [[nodiscard]] int levelCount() const { return levelCount_; }
    [[nodiscard]] const Vector3& basisU() const { return basisU_; }
    [[nodiscard]] const Vector3& basisV() const { return basisV_; }
    [[nodiscard]] const Vector3& basisW() const { return basisW_; }

    [[nodiscard]] LightSpacePoint project(const Vector3& worldPoint) const;

    /** Re-snaps every level's window around `worldPoint`; returns the current windows. */
    const std::vector<ClipWindow>& updateCenter(const Vector3& worldPoint);

    [[nodiscard]] bool containsPage(int level, int x, int y) const;

    /** The page `worldPoint` falls in on `level`; `level` must be valid (from `selectLevel`). */
    [[nodiscard]] PageAddress worldToPage(const Vector3& worldPoint, int level) const;

    /** The finest level whose guarded extent contains the point, else the coarsest. */
    [[nodiscard]] int selectLevel(const Vector3& worldPoint) const;

    [[nodiscard]] PageRange boundsToPageRange(const Box3& bounds, int level) const;

    /** Every page key the box covers on `level`, x ascending then y, as `boundsToPageKeys`. */
    [[nodiscard]] std::vector<std::string> boundsToPageKeys(const Box3& bounds, int level) const;

    /** Every page in one level's current window, x ascending then y. */
    [[nodiscard]] std::vector<PageAddress> windowPages(int level) const;

  private:
    DirectionalClipmap() = default;

    /** The per-level entry of a scalar-or-array option, the last entry standing in. */
    [[nodiscard]] double perLevel(const std::vector<double>& values, int level) const {
        const int last = static_cast<int>(values.size()) - 1;
        return values[static_cast<std::size_t>(level < last ? level : last)];
    }
    [[nodiscard]] const ClipWindow& windowAt(int level) const;

    std::vector<double> clipExtents_;
    int pagesPerAxis_ = 0;
    std::vector<double> refreshStep_;
    std::vector<double> selectionGuard_;
    int levelCount_ = 0;
    Vector3 basisU_{1, 0, 0};
    Vector3 basisV_{0, 0, 1};
    Vector3 basisW_{0, 1, 0};
    Vector3 centerWorld_;
    LightSpacePoint centerLight_;
    std::vector<ClipWindow> windows_;
};

/** The exact interval a world AABB spans along one light-space basis axis. */
struct ProjectedRange {
    double low = 0;
    double high = 0;
};

ProjectedRange projectBounds(const Box3& bounds, const Vector3& axis);

// ---------------------------------------------------------------------------------------------
// ReceiverDemandPass
// ---------------------------------------------------------------------------------------------

/** One page a frame asks for. */
struct PageRequest {
    PageAddress address;
    bool pinned = false;
    double priority = 0;
};

/** The frame's inputs: where the camera is, and the points and bounds it can see. */
struct ReceiverDemandInput {
    Vector3 cameraPosition;
    std::vector<Vector3> receiverPoints;
    std::vector<Box3> visibleBounds;
};

/**
 * Turn the points a frame can see into page requests: each point selects its finest level,
 * requests its page and a guard band around it, and the coarsest window is pinned in full so
 * every fragment has a page to fall back to.
 */
class ReceiverDemandPass {
  public:
    /** Builds the pass, or refuses a guard band that is not a non-negative integer. */
    static std::optional<ReceiverDemandPass> create(int guardBand, std::string& error);

    [[nodiscard]] int guardBand() const { return guardBand_; }

    /** Collects and orders this frame's requests, as the reference's `collect`. */
    [[nodiscard]] std::vector<PageRequest> collect(const ReceiverDemandInput& input,
                                                   const DirectionalClipmap& clipmap) const;

  private:
    ReceiverDemandPass() = default;
    int guardBand_ = 0;
};

// ---------------------------------------------------------------------------------------------
// ShadowInvalidationTracker
// ---------------------------------------------------------------------------------------------

/** True when two boxes agree within `kBoundsEpsilon` on every axis. */
bool boundsEqual(const Box3& a, const Box3& b);

/**
 * Remembers each tracked caster's last bounds and dirties every page the old and new bounds
 * cover on every level when they change. Unchanged bounds dirty nothing.
 */
class ShadowInvalidationTracker {
  public:
    explicit ShadowInvalidationTracker(const DirectionalClipmap& clipmap) : clipmap_(&clipmap) {}

    [[nodiscard]] std::size_t trackedCount() const { return tracked_.size(); }
    [[nodiscard]] bool has(const std::string& id) const { return tracked_.count(id) != 0; }

    /** Records a caster's current bounds; returns true when pages were dirtied. */
    bool update(const std::string& id, const Box3& bounds);

    /** Drops a caster, dirtying the pages its previous bounds covered. */
    bool remove(const std::string& id);

    /** The pending invalidated keys, in sorted order, and clears the pending set. */
    std::vector<std::string> consumeInvalidatedKeys();

  private:
    void invalidateBounds(const Box3& bounds);

    const DirectionalClipmap* clipmap_ = nullptr;
    std::map<std::string, Box3> tracked_;
    std::set<std::string> invalidated_;
};

} // namespace tn::engine::shadows
