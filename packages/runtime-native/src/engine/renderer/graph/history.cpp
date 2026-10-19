#include "history.h"

namespace tn::engine::graph {

std::array<double, 2> traaJitter(uint64_t frame) {
    const auto halton = [](uint32_t index, uint32_t base) {
        double fraction = 1, result = 0;
        while (index > 0) { fraction /= base; result += fraction * (index % base); index /= base; }
        return result;
    };
    const auto index = uint32_t(frame % 31) + 1;
    return {halton(index, 2) - 0.5, halton(index, 3) - 0.5};
}


uint64_t HistoryTracker::beginRender(ViewId view, bool presented) {
    View& v = views_[view];
    v.presentedThisFrame = v.presentedThisFrame || presented;
    return nextRender_++;
}

void HistoryTracker::cameraCut(ViewId view) {
    View& v = views_[view];
    v.valid = false;
    ++v.generation;
}

void HistoryTracker::resize(ViewId view, uint32_t width, uint32_t height) {
    View& v = views_[view];
    if (v.width == width && v.height == height) return;
    v.width = width;
    v.height = height;
    v.valid = false;
    ++v.generation;
}

bool HistoryTracker::historyValid(ViewId view) const {
    const auto it = views_.find(view);
    return it != views_.end() && it->second.valid;
}

uint32_t HistoryTracker::generation(ViewId view) const {
    const auto it = views_.find(view);
    return it == views_.end() ? 0 : it->second.generation;
}

void HistoryTracker::endFrame() {
    for (auto& [id, v] : views_) {
        // The frame just presented becomes the next frame's history; an unpresented view keeps
        // whatever it had (an offscreen render call does not age a presented view's history).
        if (v.presentedThisFrame) v.valid = true;
        v.presentedThisFrame = false;
    }
    ++frame_;
}

const HistoryTracker::Matrix& HistoryTracker::objectFrame(ObjectId object, const Matrix& world, uint32_t skeleton,
                                                           uint32_t lod) {
    const auto [it, isNew] = objects_.try_emplace(object);
    Object& o = it->second;
    bool seed = isNew || o.lod != lod;
    if (skeleton != 0) {
        const auto owner = skeletonOwner_.find(skeleton);
        // A skeleton another object drove last carries that object's motion, not this one's.
        if (owner != skeletonOwner_.end() && owner->second != object) seed = true;
        if (o.skeleton != skeleton) seed = true;
        skeletonOwner_[skeleton] = object;
    }
    o.previous = seed ? world : o.current;
    o.current = world;
    o.skeleton = skeleton;
    o.lod = lod;
    return o.previous;
}

}  // namespace tn::engine::graph
