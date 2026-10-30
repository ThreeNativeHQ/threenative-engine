#pragma once

#include <atomic>
#include <cstdint>
#include <cstring>

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

// The shadow* refresh counters name why a virtual shadow level redrew (PRD-773): `shadowRefreshes` grants split into
// `Pan` (the window moved and kept its pages), `Rebuild` (first map, camera cut, depth or size change) and
// `Invalidation` (a caster changed under a window that stayed put); `shadowPagesRefreshed` pages were drawn for them,
// `shadowPageEvictions` pages were evicted to make room, and the static page rows drew `shadowPageInstances` instances
// in `shadowPageRows` rows. With `tnDebug=1` they land in TN_FRAME_BUDGET.counters.engine, one frame's difference each.
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
    X(renderFrames) X(renderDraws) X(shadowDraws) X(auxPasses) X(cullCandidates) X(culledObjects) \
    X(shadowRefreshes) X(shadowRefreshPan) X(shadowRefreshRebuild) X(shadowRefreshInvalidation) \
    X(shadowPagesRefreshed) X(shadowPageEvictions) X(shadowPageRows) X(shadowPageInstances)

struct Counters {
    std::atomic<uint64_t> gcPauses{0}, gcPauseMicros{0};  // V8-only: Wasm does not expose unobserved GC.
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
    /**
     * A material program's per-draw probes (perDrawFragment, perDrawVertex, readsViewport,
     * readsPostTexture) evaluated: one per draw per pass per frame before FM3, none on a steady frame
     * after. They are pure functions of the program's stage modules, which never change once it is built,
     * so a frame that draws a program it already built must add none.
     */
    std::atomic<uint64_t> programProbeScans{0};
    /**
     * `Texture::renderTarget` weak_ptr locks taken resolving a material texture: one per draw per frame
     * before FM3, one per sampled texture that has a live render target after. A lock is an atomic
     * acquire and release, and a texture without a target answers from its own record.
     */
    std::atomic<uint64_t> textureTargetLocks{0};
    /**
     * Evaluations of a draw's share of the frame's light, camera and scene uniforms: one per draw before
     * FM2's per-program frame slab, one per program per frame after it. A frame that draws k slots from
     * one program evaluates its light and camera fields once; a count that grows with the draws means the
     * per-draw write came back, which is what tests/native-engine/render_database_test.cpp's
     * frame_slab_is_per_program fails on.
     */
    std::atomic<uint64_t> uniformFrameConstantEvaluations{0};
    /**
     * Candidates a shadow page's caster selection visited: one per (page, draw) pair the selection had to
     * judge before it decided. The selection used to read the whole draw list once per page — pages x casters
     * pairs per light per frame — and only 0.47% of them produced a draw; a per-page index of the casters whose
     * bounds can reach the page must keep this at the casters per level plus their rows, never pages x casters,
     * which is what tests/native-engine/render_database_test.cpp's virtual_shadow_page_jobs fails on.
     */
    std::atomic<uint64_t> shadowPageSelectionProbes{0};
    /**
     * Descents into a light's caster bookkeeping keyed by `DrawItem::key`: one per `count`/`at` of the two maps
     * `renderPrepared` rebuilt every frame, in the state pass and in either page-selection path. FS11 made that
     * bookkeeping a flat array indexed by the draw's position, so a frame owns no such container and adds none; a
     * new per-draw map of casters must count itself here or
     * tests/native-engine/render_database_test.cpp's virtual_shadow_page_jobs stops seeing it.
     */
    std::atomic<uint64_t> shadowCasterMapProbes{0};
    /**
     * Page keys formatted as strings (`makePageKey`) on the shadow atlas' own path: one per protected tile, per
     * granted page and per page-pool lookup before FS12. A page's identity is three integers, so an atlas frame
     * formats none; what tests/native-engine/vsm/vsm_atlas_test.cpp's pan_keeps_pages fails on.
     */
    std::atomic<uint64_t> shadowPageKeyStrings{0};
    /**
     * Resident entries the page pool's eviction scan visited: one per candidate it judged. A frame that evicts
     * judges at most the pool's capacity, so a scan that grew past it (or one per page) is a regression the unit
     * tests bound: tests/native-engine/vsm/vsm_pages_test.cpp's eviction_allocation.
     */
    std::atomic<uint64_t> shadowPageEvictionCandidates{0};
};

static_assert(std::atomic<uint64_t>::is_always_lock_free, "the web back end reads the counters' bytes in place");

inline Counters& counters() {
    static Counters value;
    return value;
}

inline bool debugFlagEnabled(const char* value) { return value && std::strcmp(value, "1") == 0; }

inline std::atomic<bool>& debugEnabled() { static std::atomic<bool> enabled{false}; return enabled; }
inline void setDebugEnabled(bool enabled) { debugEnabled().store(enabled, std::memory_order_relaxed); }
inline void debugAdd(std::atomic<uint64_t>& counter, uint64_t value = 1) {
    if (debugEnabled().load(std::memory_order_relaxed)) counter.fetch_add(value, std::memory_order_relaxed);
}

inline void count(std::atomic<uint64_t>& counter) { counter.fetch_add(1, std::memory_order_relaxed); }

}  // namespace tn::engine::waste
