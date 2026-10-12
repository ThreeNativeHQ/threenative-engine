#pragma once

#include <array>
#include <cstdint>
#include <unordered_map>
#include <unordered_set>

namespace tn::engine::graph {

/** TRAANode r185: 32 Halton offsets, clearViewOffset wraps at length - 1. */
std::array<double, 2> traaJitter(uint64_t frame);

/**
 * Temporal history as a first-class resource (PRD-523 phase 2). Per view: a generation that a cut
 * or a resize invalidates, so the next read gets the defined reset input rather than another
 * frame's pixels. Per object: the previous world matrix for motion vectors, seeded from the
 * object's own state when it is new, reuses a skeleton another object drove, or changes LOD.
 * Several render calls in one tick get distinct ids; history advances once per presented view.
 */
class HistoryTracker {
public:
    using ViewId = uint32_t;
    using ObjectId = uint64_t;
    using Matrix = std::array<double, 16>;

    /** A unique id for this render call; `presented` marks the view as presented this frame. */
    uint64_t beginRender(ViewId view, bool presented);
    void cameraCut(ViewId view);
    void resize(ViewId view, uint32_t width, uint32_t height);
    /** False after a cut, a resize or before the first presented frame: read the reset input. */
    bool historyValid(ViewId view) const;
    uint32_t generation(ViewId view) const;
    /** Advances each view presented this frame exactly once, however many times it rendered. */
    void endFrame();

    /** Records an object's state this frame and returns the matrix to use as its previous frame. */
    const Matrix& objectFrame(ObjectId object, const Matrix& world, uint32_t skeleton, uint32_t lod);

    uint64_t frame() const { return frame_; }

private:
    struct View {
        uint32_t generation = 0;
        bool valid = false;
        bool presentedThisFrame = false;
        uint32_t width = 0;
        uint32_t height = 0;
    };
    struct Object {
        Matrix previous{};
        Matrix current{};
        uint32_t skeleton = 0;
        uint32_t lod = 0;
    };
    std::unordered_map<ViewId, View> views_;
    std::unordered_map<ObjectId, Object> objects_;
    std::unordered_map<uint32_t, ObjectId> skeletonOwner_;  // skeleton -> object that drove it last
    uint64_t nextRender_ = 1;
    uint64_t frame_ = 0;
};

}  // namespace tn::engine::graph
