#pragma once

#include <cstdint>
#include <memory>
#include <unordered_map>
#include <utility>
#include <vector>

#include "engine/foundation/buffers.h"
#include "engine/renderer/gpu_resources.h"

namespace tn::engine {

/**
 * GPU copies of attribute stores (PRD-514). A store is uploaded once, then again only when its
 * BufferAttribute version moves — and then only its update ranges when it has any, which is three's
 * contract. An unchanged frame uploads nothing.
 */
class GeometryCache {
public:
    explicit GeometryCache(GpuResources& gpu) : gpu_(gpu) {}

    /**
     * The GPU buffer for a store, uploaded or refreshed as its version requires; the update ranges
     * it consumed are cleared, as three's renderer does. Usage is a WGPUBufferUsage.
     */
    Handle sync(BufferStore& store, uint32_t usage);
    /**
     * What encode needs of a synced store, read from the cache and never from the store: the
     * render thread (PRD-613) encodes while JavaScript may still write the store. Throws for a
     * store this frame's sync pass did not reach.
     */
    struct Resolved {
        Handle buffer;
        uint64_t bytes = 0;  // the store's byteLength at its last sync
        Scalar scalar = Scalar::F32;
    };
    Resolved resolved(const BufferStore& store) const;
    /** Drops a store's GPU copy (deferred until the GPU is done with it). */
    void forget(const BufferStore& store);
    /**
     * Drops the GPU copies of shared-owned stores that no longer exist or that a geometry's
     * `dispose()` released; the renderer calls it per frame.
     */
    void sweep();

    struct Stats {
        uint64_t fullUploads = 0;
        uint64_t rangeUploads = 0;
        uint64_t bytesUploaded = 0;
        /** Sweeps that walked the entries; one with no store released since the last is skipped. */
        uint64_t sweeps = 0;
    };
    const Stats& stats() const { return stats_; }
    /** GPU copies held; the renderer-updates test bounds it. */
    size_t entries() const { return entries_.size(); }

private:
    void upload(Handle buffer, const BufferStore& store, uint64_t offset, uint64_t size);
    struct Entry {
        Handle buffer;
        uint64_t byteLength = 0;
        uint32_t version = 0;
        uint64_t epoch = 0;
        // The store's owner when it is shared-owned: an expired one is a released store, whose
        // address a new store may now hold. Stores outside a shared_ptr are never swept.
        std::weak_ptr<const BufferStore> owner;
        bool tracked = false;
        uint32_t releases = 0;  // the store's gpuReleases() when this copy was made
        uint64_t bytes = 0;     // the store's byteLength() at its last sync (unpadded)
        Scalar scalar = Scalar::F32;
    };
    GpuResources& gpu_;
    uint64_t sweptAt_ = ~uint64_t{0};  // BufferStore::released() at the last sweep
    std::unordered_map<const BufferStore*, Entry> entries_;
    std::vector<std::pair<uint64_t, uint64_t>> spans_;  // sync's byte ranges, kept to reuse its storage
    Stats stats_;
};

}  // namespace tn::engine
