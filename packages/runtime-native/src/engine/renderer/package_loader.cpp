#include "package_loader.h"

#include <cstring>

namespace tn::engine {

namespace {

uint32_t u32(const uint8_t* p) {
    return uint32_t{p[0]} | (uint32_t{p[1]} << 8) | (uint32_t{p[2]} << 16) | (uint32_t{p[3]} << 24);
}

bool fail(assets::PackageError& error, const std::string& name, const char* why) {
    error = assets::PackageError{"TN_PACKAGE_ENTRY", "entry '" + name + "': " + why};
    return false;
}

}  // namespace

bool loadPackage(const assets::Package& package, GpuResources& gpu, std::vector<LoadedEntry>& out,
                 assets::PackageError& error) {
    for (const assets::PackageEntry& e : package.entries)
        if (!loadEntry(package, e, gpu, out, error)) return false;
    return true;
}

bool loadEntry(const assets::Package& package, const assets::PackageEntry& e, GpuResources& gpu,
               std::vector<LoadedEntry>& out, assets::PackageError& error) {
    {
        const auto data = package.data(e);
        if (e.kind == static_cast<uint16_t>(assets::EntryKind::Buffer)) {
            // uploadSize 0 is CPU data a decoder reads (audio, .hdr): it never becomes a GPU buffer.
            if (e.uploadSize == 0) return true;
            if (data.empty() || data.size() % 4 != 0) return fail(error, e.name, "buffer size is not a multiple of 4");
            const Handle buffer = gpu.createBuffer(data.size(), WGPUBufferUsage_CopyDst | WGPUBufferUsage_CopySrc |
                                                                    WGPUBufferUsage_Vertex | WGPUBufferUsage_Index);
            if (buffer.type == 0 || gpu.writeBuffer(buffer, 0, data.data(), data.size()) != GpuStatus::Ok) {
                return fail(error, e.name, "buffer upload refused");
            }
            out.push_back({e.name, buffer});
        } else if (e.kind == static_cast<uint16_t>(assets::EntryKind::Texture)) {
            if (data.size() < 12) return fail(error, e.name, "texture header truncated");
            const uint32_t width = u32(data.data()), height = u32(data.data() + 4);
            const WGPUTextureFormat format = packageTextureFormat(u32(data.data() + 8));
            if (format == WGPUTextureFormat_Undefined) {
                return fail(error, e.name, "texture format is not RGBA8 (format v1)");
            }
            if (width == 0 || height == 0 || width > 16384 || height > 16384 ||
                data.size() - 12 != uint64_t{width} * height * 4) {
                return fail(error, e.name, "texture size does not match its pixels");
            }
            const Handle texture = gpu.createTexture(width, height, format,
                                                     WGPUTextureUsage_CopyDst | WGPUTextureUsage_CopySrc |
                                                         WGPUTextureUsage_TextureBinding);
            if (texture.type == 0 || gpu.writeTexture(texture, data.data() + 12, data.size() - 12) != GpuStatus::Ok) {
                return fail(error, e.name, "texture upload refused");
            }
            out.push_back({e.name, texture});
        }
    }
    return true;
}

}  // namespace tn::engine
