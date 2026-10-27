#pragma once

#include <cstdint>
#include <cstdio>

/**
 * Per-frame counts of engine work that a scene can make the renderer repeat without needing it
 * (PRD #574, lane "waste"): geometry content classification, the ABI's handle sharing, and GPU
 * buffer/texture creation.
 *
 * Why it is a counter and not a profile: each of these is a few hundred nanoseconds inside a Wasm
 * frame, so a sampling profile puts the cost between symbols. The question they answer is the one a
 * fix must answer — how many times per frame is it done, and how many of those times did the input
 * actually move — which a count answers exactly and for free (one increment per call).
 *
 * A count of zero where the work runs is a bug in the counter, never an optimisation: the line
 * prints the frames it summed, so a reader divides by it rather than assuming a window.
 *
 * The line is `TN_WASTE:{...}` on stdout, printed once per `kReportFrames` drawn frames by
 * `frame()`. Nothing reads it in the engine; it is a diagnostic a harness parses.
 */
namespace tn::engine::waste {

struct Counters {
    /** Every `projection::contentClassOf` call: one per mesh per prepare, before its cache check. */
    uint64_t contentClassCalls = 0;
    /** Calls that had to recompute `contentVersionKey` for their geometry (an epoch or version miss). */
    uint64_t contentVersionKeys = 0;
    /** Calls that reached `detail::classify` (a hash and a byte compare against the class). */
    uint64_t classifies = 0;
    /** Every `HandleStore::share` call: one per member read that answers an engine-owned object. */
    uint64_t shareCalls = 0;
    /** Share calls that answered a handle the caller already holds (no allocation, no new slot). */
    uint64_t shareHits = 0;
    /** Share calls that minted a handle (a new slot, a class name, an ownership record). */
    uint64_t shareMints = 0;
    /** `GpuResources::createBuffer` calls. */
    uint64_t bufferAllocs = 0;
    /** `GpuResources::createTexture` calls. */
    uint64_t textureAllocs = 0;
};

/** Drawn frames summed per printed line. */
inline constexpr uint32_t kReportFrames = 300;

inline Counters& counters() {
    static Counters value;
    return value;
}

inline uint32_t& frames() {
    static uint32_t value = 0;
    return value;
}

/**
 * One drawn frame has ended. Prints the window's totals every `kReportFrames` frames and starts a
 * new one, so a steady run produces a series and never a single cumulative number a reader has to
 * difference by hand.
 */
inline void frame() {
    if (++frames() < kReportFrames) return;
    const Counters& c = counters();
    std::fprintf(stdout,
                 "TN_WASTE:{\"frames\":%u,\"contentClassOf\":%llu,\"contentVersionKeys\":%llu,"
                 "\"classify\":%llu,\"share\":%llu,\"shareHits\":%llu,\"shareMints\":%llu,"
                 "\"buffers\":%llu,\"textures\":%llu}\n",
                 frames(), static_cast<unsigned long long>(c.contentClassCalls),
                 static_cast<unsigned long long>(c.contentVersionKeys),
                 static_cast<unsigned long long>(c.classifies),
                 static_cast<unsigned long long>(c.shareCalls),
                 static_cast<unsigned long long>(c.shareHits),
                 static_cast<unsigned long long>(c.shareMints),
                 static_cast<unsigned long long>(c.bufferAllocs),
                 static_cast<unsigned long long>(c.textureAllocs));
    counters() = Counters{};
    frames() = 0;
}

}  // namespace tn::engine::waste
