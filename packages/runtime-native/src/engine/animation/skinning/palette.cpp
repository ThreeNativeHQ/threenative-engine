// SkinnedPalette (PRD-518 phases 2-3): the CPU state of `SkinnedBatch` from
// packages/core/src/projection-skinned.ts, method for method, over the ported Skeleton and
// SkinnedMesh. The multiply order is the TS one, -ffp-contract=off keeps it from being fused, and
// every store rounds exactly where the TS store rounds: the palette is float32, the bind scratch
// float64. Nothing here touches a material, a GPU buffer or a draw, and no path throws.

#include "engine/animation/skinning/palette.h"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>

namespace tn::engine {
namespace {

template <typename A, typename B, typename O>
void multiplyImpl(const A* a, std::size_t ao, const B* b, std::size_t bo, O* out, std::size_t o) {
    const double a00 = a[ao];
    const double a10 = a[ao + 1];
    const double a20 = a[ao + 2];
    const double a01 = a[ao + 4];
    const double a11 = a[ao + 5];
    const double a21 = a[ao + 6];
    const double a02 = a[ao + 8];
    const double a12 = a[ao + 9];
    const double a22 = a[ao + 10];
    const double a03 = a[ao + 12];
    const double a13 = a[ao + 13];
    const double a23 = a[ao + 14];
    // Affine only: the bottom row of every matrix here is (0, 0, 0, 1), which three guarantees for
    // bone and world matrices built from position/quaternion/scale.
    for (int column = 0; column < 4; column += 1) {
        const double b0 = b[bo + static_cast<std::size_t>(column) * 4];
        const double b1 = b[bo + static_cast<std::size_t>(column) * 4 + 1];
        const double b2 = b[bo + static_cast<std::size_t>(column) * 4 + 2];
        const double b3 = b[bo + static_cast<std::size_t>(column) * 4 + 3];
        const std::size_t at = o + static_cast<std::size_t>(column) * 4;
        out[at] = static_cast<O>(a00 * b0 + a01 * b1 + a02 * b2 + a03 * b3);
        out[at + 1] = static_cast<O>(a10 * b0 + a11 * b1 + a12 * b2 + a13 * b3);
        out[at + 2] = static_cast<O>(a20 * b0 + a21 * b1 + a22 * b2 + a23 * b3);
        out[at + 3] = static_cast<O>(b3);
    }
}

bool isIdentity(const double* elements) {
    for (int index = 0; index < 16; index += 1) {
        if (elements[index] != (index % 5 == 0 ? 1.0 : 0.0)) return false;
    }
    return true;
}

}  // namespace

bool isSimilarityTransform(const double* elements) {
    const double x0 = elements[0];
    const double x1 = elements[1];
    const double x2 = elements[2];
    const double y0 = elements[4];
    const double y1 = elements[5];
    const double y2 = elements[6];
    const double z0 = elements[8];
    const double z1 = elements[9];
    const double z2 = elements[10];
    const double xx = x0 * x0 + x1 * x1 + x2 * x2;
    const double yy = y0 * y0 + y1 * y1 + y2 * y2;
    const double zz = z0 * z0 + z1 * z1 + z2 * z2;
    if (!(xx > 1e-16)) return false;
    const double tolerance = xx * 1e-5;
    if (std::abs(yy - xx) > tolerance || std::abs(zz - xx) > tolerance) return false;
    if (std::abs(x0 * y0 + x1 * y1 + x2 * y2) > tolerance) return false;
    if (std::abs(x0 * z0 + x1 * z1 + x2 * z2) > tolerance) return false;
    if (std::abs(y0 * z0 + y1 * z1 + y2 * z2) > tolerance) return false;
    // Positive determinant: a mirrored rig would draw inside-out under the source's face culling.
    const double determinant =
        x0 * (y1 * z2 - y2 * z1) - y0 * (x1 * z2 - x2 * z1) + z0 * (x1 * y2 - x2 * y1);
    return determinant > 0 && elements[3] == 0 && elements[7] == 0 && elements[11] == 0;
}

void multiplyAffine(const float* a, std::size_t ao, const double* b, std::size_t bo, float* out,
                    std::size_t o) {
    multiplyImpl(a, ao, b, bo, out, o);
}
void multiplyAffine(const double* a, std::size_t ao, const float* b, std::size_t bo, float* out,
                    std::size_t o) {
    multiplyImpl(a, ao, b, bo, out, o);
}
void multiplyAffine(const double* a, std::size_t ao, const double* b, std::size_t bo, double* out,
                    std::size_t o) {
    multiplyImpl(a, ao, b, bo, out, o);
}

SkinnedPalette::SkinnedPalette(std::uint32_t bones, std::uint32_t capacity, bool velocity)
    : bones_(bones), capacity_(capacity), velocity_(velocity) {
    const std::size_t floats = static_cast<std::size_t>(capacity) * bones * 16;
    current_.assign(floats, 0.0f);
    if (velocity) previous_.assign(floats, 0.0f);
}

std::optional<std::uint32_t> SkinnedPalette::claim(const Object3D* rig) {
    const auto found = instances_.find(rig);
    if (found != instances_.end()) return found->second;
    std::uint32_t slot;
    if (!free_.empty()) {
        slot = free_.back();
        free_.pop_back();
    } else {
        if (used_ >= capacity_) return std::nullopt;
        slot = used_;
        used_ += 1;
    }
    instances_[rig] = slot;
    fresh_.push_back(slot);
    return slot;
}

void SkinnedPalette::release(const Object3D* rig) {
    const auto found = instances_.find(rig);
    if (found == instances_.end()) return;
    const std::uint32_t slot = found->second;
    instances_.erase(found);
    hide(slot);
    free_.push_back(slot);
}

void SkinnedPalette::hide(std::uint32_t slot) {
    const std::size_t stride = static_cast<std::size_t>(bones_) * 16;
    const std::size_t begin = static_cast<std::size_t>(slot) * stride;
    std::fill(current_.begin() + static_cast<std::ptrdiff_t>(begin),
              current_.begin() + static_cast<std::ptrdiff_t>(begin + stride), 0.0f);
    if (velocity_)
        std::fill(previous_.begin() + static_cast<std::ptrdiff_t>(begin),
                  previous_.begin() + static_cast<std::ptrdiff_t>(begin + stride), 0.0f);
}

void SkinnedPalette::restart(std::uint32_t slot) { fresh_.push_back(slot); }

void SkinnedPalette::write(std::uint32_t slot, SkinnedMesh& rig, bool updateSkeleton) {
    Skeleton* skeleton = rig.skeleton.get();
    if (skeleton == nullptr) return;
    // `#updated.get(skeleton) !== this.#frame`: a skeleton never seen is not "updated at frame 0".
    if (const auto seen = updated_.find(skeleton);
        updateSkeleton && (seen == updated_.end() || seen->second != frame_)) {
        skeleton->update();
        updated_[skeleton] = frame_;
        skeletonUpdates_ += 1;
    }
    writes_ += 1;

    const std::vector<float>& bones = skeleton->boneMatrices;
    const double* bind = rig.bindMatrix.elements.data();
    const bool bindIsIdentity = isIdentity(bind);
    const bool detached = !rig.attached;
    double* prefix = bindScratch_.data();
    if (detached)
        multiplyAffine(rig.matrixWorld.elements.data(), 0, rig.bindMatrixInverse.elements.data(), 0,
                       prefix, 0);

    const std::size_t offset = static_cast<std::size_t>(slot) * bones_ * 16;
    // The common case is one contiguous copy: `skeleton.update` has already written this rig's bone
    // matrices in palette order, and an identity bind matrix leaves them unchanged.
    if (bindIsIdentity) {
        std::copy(bones.begin(), bones.end(), current_.begin() + static_cast<std::ptrdiff_t>(offset));
    } else {
        for (std::uint32_t bone = 0; bone < bones_; bone += 1) {
            multiplyAffine(bones.data(), static_cast<std::size_t>(bone) * 16, bind, 0,
                           current_.data(), offset + static_cast<std::size_t>(bone) * 16);
        }
    }
    if (detached) {
        for (std::uint32_t bone = 0; bone < bones_; bone += 1) {
            const std::size_t at = offset + static_cast<std::size_t>(bone) * 16;
            // In place is safe: each right-hand column is read before it is written.
            multiplyAffine(prefix, 0, current_.data(), at, current_.data(), at);
        }
    }
}

void SkinnedPalette::begin() {
    frame_ += 1;
    if (velocity_) previous_ = current_;
}

void SkinnedPalette::end() {
    if (velocity_) {
        const std::size_t stride = static_cast<std::size_t>(bones_) * 16;
        for (const std::uint32_t slot : fresh_) {
            const std::size_t at = static_cast<std::size_t>(slot) * stride;
            std::copy(current_.begin() + static_cast<std::ptrdiff_t>(at),
                      current_.begin() + static_cast<std::ptrdiff_t>(at + stride),
                      previous_.begin() + static_cast<std::ptrdiff_t>(at));
        }
    }
    fresh_.clear();
}

}  // namespace tn::engine
