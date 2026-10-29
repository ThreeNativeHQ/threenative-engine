#pragma once

#include <atomic>
#include <cstdint>

/**
 * Running counts of engine work that a scene can make the renderer repeat without needing it
 * (PRD #574, lane "waste"): geometry content classification, the ABI's handle sharing, and GPU
 * buffer/texture creation.
 *
 * Why it is a counter and not a profile: each of these is a few hundred nanoseconds inside a Wasm
 * frame, so a sampling profile puts the cost between symbols. The question they answer is the one a
 * fix must answer — how many times per frame is it done, and how many of those times did the input
 * actually move — which a count answers exactly and for free (one relaxed increment per call).
 *
 * The totals only grow and nothing prints them: the web back end reads them in place through the
 * Object3D getter `__engineCounters` (abi/bindings_scene.cpp), and core puts each frame's difference
 * into `TN_FRAME_BUDGET.counters.engine`. Relaxed atomics cost what a plain add costs and stay
 * correct if an asset loader creates GPU buffers off the game thread.
 */
namespace tn::engine::waste {

#define TN_DEBUG_COUNTERS(X) \
    X(gateAttempts) X(gateDeclinedCapacity) X(gateDeclinedAge) \
    X(bufferCreatedBytes) X(textureCreatedBytes) X(bufferFreedBytes) X(textureFreedBytes) \
    X(bufferUploadBytes) X(textureUploadBytes) X(bindGroups) X(pipelineCompiles) \
    X(sceneDirtyMarks) X(sceneVisits) X(sceneAdds) X(sceneRemoves) X(queueSubmits) \
    X(readbackMaps) X(readbackBytes) X(timestampResolves) X(timestampSamplesDelivered) X(gpuTimestampUnrequestedSamples) \
    X(velocityCandidates) X(velocitySkipped) X(temporalActiveFrames) X(temporalInvalidFrames) X(temporalRejectedPixels) \
    X(temporalClampedPixels) X(temporalMeasuredPixels) X(pipelineCreateMicros) \
    X(queueCallbackMicros) X(queueDeliveryMicros) X(queueCallbacks) \
    X(handleCreates) X(handleReleases) X(attributeUploadBytes) X(uniformUploadBytes) \
    X(renderFrames) X(renderDraws) X(shadowDraws) X(auxPasses) X(cullCandidates) X(culledObjects)

struct Counters {
#define TN_DECLARE_COUNTER(name) std::atomic<uint64_t> name{0};
    TN_DEBUG_COUNTERS(TN_DECLARE_COUNTER)
#undef TN_DECLARE_COUNTER
    /** Every `projection::contentClassOf` call: one per mesh per prepare, before its cache check. */
    std::atomic<uint64_t> contentClassCalls{0};
    /** Calls that had to recompute `contentVersionKey` for their geometry (an epoch or version miss). */
    std::atomic<uint64_t> contentVersionKeys{0};
    /** Calls that reached `detail::classify` (a hash and a byte compare against the class). */
    std::atomic<uint64_t> classifies{0};
    /** Every `HandleStore::share` call: one per member read that answers an engine-owned object. */
    std::atomic<uint64_t> shareCalls{0};
    /** Share calls that answered a handle the caller already holds (no allocation, no new slot). */
    std::atomic<uint64_t> shareHits{0};
    /** Share calls that minted a handle (a new slot, a class name, an ownership record). */
    std::atomic<uint64_t> shareMints{0};
    /** `GpuResources::createBuffer` calls. */
    std::atomic<uint64_t> bufferAllocs{0};
    /** `GpuResources::createTexture` calls. */
    std::atomic<uint64_t> textureAllocs{0};
    /**
     * String compares `Renderer::putMaterialNodes` made resolving a material uniform by name: one per
     * hash hit, where a field is a value the draw binds. The per-field scan it replaced compared the
     * names of every field of every stage of every draw of every frame, 59% of the shooter's frame memcmp
     * time (#574); a spec bounds this so a name compare per field cannot come back.
     */
    std::atomic<uint64_t> uniformNameCompares{0};
};

static_assert(std::atomic<uint64_t>::is_always_lock_free, "the web back end reads the counters' bytes in place");

inline Counters& counters() {
    static Counters value;
    return value;
}

inline std::atomic<bool>& debugEnabled() { static std::atomic<bool> enabled{false}; return enabled; }
inline void setDebugEnabled(bool enabled) { debugEnabled().store(enabled, std::memory_order_relaxed); }
inline void debugAdd(std::atomic<uint64_t>& counter, uint64_t value = 1) {
    if (debugEnabled().load(std::memory_order_relaxed)) counter.fetch_add(value, std::memory_order_relaxed);
}

inline void count(std::atomic<uint64_t>& counter) { counter.fetch_add(1, std::memory_order_relaxed); }

}  // namespace tn::engine::waste
