#pragma once

// The CPU state of `SkinnedBatch`, ported from packages/core/src/projection-skinned.ts (PRD-518
// phases 2-3). Every compatible rig is one slot in a shared palette of world-space bone matrices;
// the material, geometry and GPU buffer are the renderer's, not this class's.
//
// The rules are the TS ones, bit for bit: `write` folds the bind matrix per bone, or the whole
// world fold first in detached mode; `multiply` multiplies in binary64 and stores into the palette
// as float32 (or into the bind scratch as float64); a hidden or released slot holds zero matrices,
// so its triangles collapse; and `skeleton.update` runs once per skeleton per frame however many
// passes write it. The previous palette is seeded on spawn, restart and slot reuse so velocity is
// never computed against a stale or foreign pose.
//
// Not ported, and why:
//   - the material twin, the instanced geometry, the storage-buffer attributes and the draw: they
//     are renderer concerns (PRD-514/519).
//   - `dispose`: nothing here owns a GPU resource.
//   - `begin`'s material sync and dirty upload: no material, no upload.
//
// Engine code never throws.

#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>
#include <unordered_map>
#include <vector>

#include "engine/animation/skinning/skeleton.h"

namespace tn::engine {

/**
 * True when `elements` is a rotation times a positive uniform scale plus a translation — the only
 * world transform whose fold into the bone palette leaves normals exactly where stock skinning's
 * normal matrix puts them. Ported verbatim from the TS.
 */
bool isSimilarityTransform(const double* elements);

/** `out[o..o+16] = a[ao..ao+16] × b[bo..bo+16]`, column-major, the bottom row trusted. */
void multiplyAffine(const float* a, std::size_t ao, const double* b, std::size_t bo, float* out,
                    std::size_t o);
void multiplyAffine(const double* a, std::size_t ao, const float* b, std::size_t bo, float* out,
                    std::size_t o);
void multiplyAffine(const double* a, std::size_t ao, const double* b, std::size_t bo, double* out,
                    std::size_t o);

/** One skinned palette: `capacity × bones` world-space matrices, and last frame's for velocity. */
class SkinnedPalette {
  public:
    SkinnedPalette(std::uint32_t bones, std::uint32_t capacity, bool velocity);
    SkinnedPalette(const SkinnedPalette&) = delete;
    SkinnedPalette& operator=(const SkinnedPalette&) = delete;

    /** Claims a slot for `rig`, or nullopt when the batch is full. */
    std::optional<std::uint32_t> claim(const Object3D* rig);
    /** Returns a rig's slot to the free list with a collapsed pose, so it draws nothing. */
    void release(const Object3D* rig);
    /** Collapses one slot for this frame; a hidden rig keeps its slot. */
    void hide(std::uint32_t slot);
    /** Marks a slot whose history must restart from its next pose. */
    void restart(std::uint32_t slot);
    /** Writes one rig's world-space palette; the render database may supply an already updated skeleton. */
    void write(std::uint32_t slot, SkinnedMesh& rig, bool updateSkeleton = true);

    /** Starts one frame: the frame's history becomes last frame's pose. */
    void begin();
    /** Ends one frame: fresh slots get history equal to their pose. */
    void end();

    /** This frame's world-space bone matrices, `capacity × bones` of them in slot order. */
    [[nodiscard]] std::span<const float> palette() const { return current_; }
    /** Contiguous storage borrowed by a render draw; the palette owns its lifetime. */
    [[nodiscard]] const std::vector<float>& matrices() const { return current_; }
    /** Last frame's palette, present only while velocity was asked for. */
    [[nodiscard]] std::span<const float> history() const {
        return velocity_ ? std::span<const float>(previous_) : std::span<const float>();
    }

    [[nodiscard]] std::uint32_t used() const { return used_; }
    /** How many times `write` ran. */
    [[nodiscard]] std::uint32_t writes() const { return writes_; }
    /** How many times `write` called `skeleton.update` (once per skeleton per frame). */
    [[nodiscard]] std::uint32_t skeletonUpdates() const { return skeletonUpdates_; }
    [[nodiscard]] const std::vector<std::uint32_t>& free() const { return free_; }
    [[nodiscard]] std::uint32_t bones() const { return bones_; }
    [[nodiscard]] std::uint32_t capacity() const { return capacity_; }

  private:
    std::uint32_t bones_;
    std::uint32_t capacity_;
    bool velocity_;
    std::uint32_t used_ = 0;
    std::uint32_t writes_ = 0;
    std::uint32_t skeletonUpdates_ = 0;
    std::uint64_t frame_ = 0;
    std::vector<float> current_;
    std::vector<float> previous_;
    std::vector<std::uint32_t> free_;
    /** Slots whose history must equal their first pose rather than a previous owner's. */
    std::vector<std::uint32_t> fresh_;
    std::unordered_map<const Object3D*, std::uint32_t> instances_;
    std::unordered_map<const Skeleton*, std::uint64_t> updated_;
    std::vector<double> bindScratch_ = std::vector<double>(16, 0.0);
};

}  // namespace tn::engine
