#pragma once
#include "engine/assets/package.h"
#include "engine/renderer/probes/volume.h"

namespace tn::engine::assets {
// Buffer entry `probes/<name>`, little endian: TNPV, version=1, six f64 bounds,
// three f64 density, three u32 resolution, u32 coefficient count, u32 cubemapSize/bounces/maxItems, f64
// budget/capture/project/copy/repack costs, then RGB L2 f32s.
std::vector<uint8_t> cookProbeVolumePayload(const probes::ProbeVolume& volume);
bool loadProbeVolume(std::span<const uint8_t> packageBytes, std::string_view name, probes::ProbeVolume& out,
                     PackageError& error);
} // namespace tn::engine::assets
