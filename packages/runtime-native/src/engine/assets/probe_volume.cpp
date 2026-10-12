#include "engine/assets/probe_volume.h"
#include <algorithm>
#include <bit>
#include <cmath>
#include <limits>

namespace tn::engine::assets {
namespace {
void append(std::vector<uint8_t>& bytes, uint64_t value, size_t count) {
    for (size_t i = 0; i < count; ++i)
        bytes.push_back(uint8_t(value >> (8 * i)));
}
uint64_t read(std::span<const uint8_t> bytes, size_t offset, size_t count) {
    uint64_t value = 0;
    for (size_t i = 0; i < count; ++i)
        value |= uint64_t(bytes[offset + i]) << (8 * i);
    return value;
}
} // namespace
std::vector<uint8_t> cookProbeVolumePayload(const probes::ProbeVolume& volume) {
    if (!volume.ready() || volume.pending())
        return {};
    std::vector<uint8_t> bytes = {'T', 'N', 'P', 'V'};
    append(bytes, 1, 4);
    const auto& d = volume.description();
    for (double value : d.boundsMin)
        append(bytes, std::bit_cast<uint64_t>(value), 8);
    for (double value : d.boundsMax)
        append(bytes, std::bit_cast<uint64_t>(value), 8);
    for (double value : d.density)
        append(bytes, std::bit_cast<uint64_t>(value), 8);
    for (uint32_t value : volume.placement().resolution)
        append(bytes, value, 4);
    append(bytes, volume.coefficients().size(), 4);
    const auto& options = volume.scheduleOptions();
    append(bytes, volume.cubemapSize(), 4);
    append(bytes, options.bounces, 4);
    append(bytes, options.maxWorkItemsPerFrame, 4);
    for (double value :
         {options.bakeBudgetMs, options.costs.capture, options.costs.project, options.costs.copy, options.costs.repack})
        append(bytes, std::bit_cast<uint64_t>(value), 8);
    for (float value : volume.coefficients())
        append(bytes, std::bit_cast<uint32_t>(value), 4);
    return bytes;
}
bool loadProbeVolume(std::span<const uint8_t> bytes, std::string_view name, probes::ProbeVolume& out,
                     PackageError& error) {
    Package package;
    if (!parsePackage(bytes, package, error) || !verifyPackage(package, targetDecoders(), error))
        return false;
    const std::string path = "probes/" + std::string(name);
    const PackageEntry* entry = nullptr;
    for (const auto& candidate : package.entries)
        if (candidate.name == path) {
            if (entry) {
                error = {"TN_PROBES_PAYLOAD", "duplicate probe entry"};
                return false;
            }
            entry = &candidate;
        }
    if (!entry || entry->kind != uint16_t(EntryKind::Buffer)) {
        error = {"TN_PROBES_PAYLOAD", "missing probe Buffer"};
        return false;
    }
    auto data = package.data(*entry);
    if (data.size() < 148 || !std::equal(data.begin(), data.begin() + 4, "TNPV") || read(data, 4, 4) != 1) {
        error = {"TN_PROBES_PAYLOAD", "invalid header"};
        return false;
    }
    probes::ProbeVolumeDescription d;
    d.hasMaxTextureDimension3D = true;
    d.maxTextureDimension3D = 2048;
    size_t offset = 8;
    for (double* values : {d.boundsMin, d.boundsMax, d.density})
        for (int a = 0; a < 3; ++a) {
            values[a] = std::bit_cast<double>(read(data, offset, 8));
            offset += 8;
        }
    probes::ProbePlacement placement;
    std::string reason;
    if (!probes::place(d, placement, reason)) {
        error = {"TN_PROBES_PAYLOAD", reason};
        return false;
    }
    for (uint32_t value : placement.resolution) {
        if (value != read(data, offset, 4)) {
            error = {"TN_PROBES_PAYLOAD", "resolution mismatch"};
            return false;
        }
        offset += 4;
    }
    const uint64_t count = read(data, offset, 4);
    offset += 4;
    const uint32_t size = uint32_t(read(data, offset, 4));
    offset += 4;
    probes::ProbeScheduleOptions options;
    options.bounces = uint32_t(read(data, offset, 4));
    offset += 4;
    options.maxWorkItemsPerFrame = uint32_t(read(data, offset, 4));
    offset += 4;
    for (double* value : {&options.bakeBudgetMs, &options.costs.capture, &options.costs.project, &options.costs.copy,
                          &options.costs.repack}) {
        *value = std::bit_cast<double>(read(data, offset, 8));
        offset += 8;
    }
    if (count != placement.probeCount * 27 || count > (data.size() - offset) / 4 || offset + count * 4 != data.size()) {
        error = {"TN_PROBES_PAYLOAD", "coefficient range mismatch"};
        return false;
    }
    // Validate the entire payload before any externally visible volume is replaced.
    for (uint64_t i = 0; i < count; ++i)
        if (!std::isfinite(std::bit_cast<float>(uint32_t(read(data, offset + size_t(i) * 4, 4))))) {
            error = {"TN_PROBES_PAYLOAD", "non-finite coefficient"};
            return false;
        }
    probes::ProbeVolume volume;
    if (!probes::ProbeVolume::create(d, options, size, volume, reason)) {
        error = {"TN_PROBES_PAYLOAD", reason};
        return false;
    }
    for (uint32_t probe = 0; probe < volume.placement().probeCount; ++probe) {
        probes::ProbeCoefficients c;
        for (float& value : c) {
            value = std::bit_cast<float>(uint32_t(read(data, offset, 4)));
            offset += 4;
        }
        if (!volume.writeProbe(probe, c, reason)) {
            error = {"TN_PROBES_PAYLOAD", reason};
            return false;
        }
    }
    out = std::move(volume);
    return true;
}
} // namespace tn::engine::assets
