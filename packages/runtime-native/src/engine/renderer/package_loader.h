#pragma once

#include <string>
#include <vector>

#include "engine/assets/package.h"
#include "engine/renderer/gpu_resources.h"

namespace tn::engine {

/** TNPK v1 wire codes, independent of the backend's WGPUTextureFormat enum. */
inline WGPUTextureFormat packageTextureFormat(uint32_t wire) {
    switch (wire) {
    case 18: // packages/assets writer (wgpu-native's original numbering)
    case 22: // legacy Dawn-cooked fixtures
        return WGPUTextureFormat_RGBA8Unorm;
    case 19:
    case 23:
        return WGPUTextureFormat_RGBA8UnormSrgb;
    default:
        return WGPUTextureFormat_Undefined;
    }
}

/** One verified package entry made resident on the GPU. */
struct LoadedEntry {
    std::string name;
    Handle resource;
};

/**
 * Uploads a package that already passed verifyPackage (PRD-515 phase 2): Buffer entries become
 * GPU buffers, Texture entries GPU textures. Other kinds are left to their owners (scene, mesh,
 * material loaders). Fails closed: a malformed texture header or an upload refusal stops the load.
 */
bool loadPackage(const assets::Package& package, GpuResources& gpu, std::vector<LoadedEntry>& out, assets::PackageError& error);

/** One entry of `loadPackage`, so a caller can admit a package entry by entry; other kinds load nothing. */
bool loadEntry(const assets::Package& package, const assets::PackageEntry& entry, GpuResources& gpu,
               std::vector<LoadedEntry>& out, assets::PackageError& error);

}  // namespace tn::engine
