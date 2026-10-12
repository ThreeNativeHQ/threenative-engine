#pragma once

#include <cstdint>
#include <memory>
#include <unordered_map>

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
    };
    GpuResources& gpu_;
    std::unordered_map<const BufferStore*, Entry> entries_;
    Stats stats_;
};

}  // namespace tn::engine
