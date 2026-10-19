#pragma once
// Test drivers may wait for GPU readback; the engine only stages the copy buffers.
#include "engine/renderer/post/traa.h"
#include <bit>
#include <chrono>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <stdexcept>
#include <thread>

namespace tn::fixture {
inline void dumpFile(const std::filesystem::path& path, const std::string& bytes) {
    std::ofstream file(path, std::ios::binary);
    file.write(bytes.data(), std::streamsize(bytes.size()));
    file.close();
    if (!file) throw std::runtime_error("TN_TRAA_DUMP_WRITE_FAILED: " + path.string());
}

inline void finishTraaDump(engine::TraaPass& pass, WGPUInstance instance,
                           const std::filesystem::path& directory, bool captured = false) {
    auto* debugDump_ = pass.debugDump();
    if (!debugDump_) return;
    std::filesystem::create_directories(directory);
    const auto width_ = debugDump_->width, height_ = debugDump_->height;
    const std::string prefix = "frame-" + std::to_string(debugDump_->frame);
    for (const auto& texture : debugDump_->pending) {
        struct Map { bool done = false; WGPUMapAsyncStatus status{}; };
        auto mapped = std::make_shared<Map>();
        WGPUBufferMapCallbackInfo info{};
        info.mode = WGPUCallbackMode_AllowProcessEvents;
        info.userdata1 = new std::shared_ptr<Map>(mapped);
        info.callback = [](WGPUMapAsyncStatus status, WGPUStringView, void* userdata, void*) {
            std::unique_ptr<std::shared_ptr<Map>> request(static_cast<std::shared_ptr<Map>*>(userdata));
            (*request)->status = status; (*request)->done = true;
        };
        wgpuBufferMapAsync(texture.buffer, WGPUMapMode_Read, 0, texture.size, info);
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
        while (!mapped->done && std::chrono::steady_clock::now() < deadline) {
            wgpuInstanceProcessEvents(instance);
            if (!mapped->done) std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
        if (!mapped->done || mapped->status != WGPUMapAsyncStatus_Success) {
            wgpuBufferUnmap(texture.buffer);
            throw std::runtime_error("TN_TRAA_DUMP_MAP_FAILED: " + texture.name);
        }
        const auto* bytes = static_cast<const uint8_t*>(wgpuBufferGetConstMappedRange(texture.buffer, 0, texture.size));
        if (!bytes) throw std::runtime_error("TN_TRAA_DUMP_MAP_EMPTY: " + texture.name);
        std::string floats; floats.reserve(size_t(width_) * height_ * 16);
        for (uint32_t y = 0; y < height_; ++y) for (uint32_t x = 0; x < width_ * 4; ++x) {
            const auto offset = size_t(y) * texture.pitch + x * 2;
            const uint16_t half = uint16_t(bytes[offset]) | (uint16_t(bytes[offset + 1]) << 8);
            const uint32_t exponent = (half >> 10) & 31, mantissa = half & 1023;
            float value = exponent == 0 ? std::ldexp(float(mantissa), -24)
                        : exponent == 31 ? (mantissa ? NAN : INFINITY)
                                         : std::ldexp(float(1024 + mantissa), int(exponent) - 25);
            if (half & 0x8000) value = -value;
            const uint32_t bits = std::bit_cast<uint32_t>(value);
            for (int byte = 0; byte < 4; ++byte) floats.push_back(char((bits >> (byte * 8)) & 255));
        }
        wgpuBufferUnmap(texture.buffer);
        const auto file = directory / (prefix + "-" + texture.name);
        dumpFile(file.string() + ".bin", floats);
        dumpFile(file.string() + ".json", "{\"width\":" + std::to_string(width_) +
            ",\"height\":" + std::to_string(height_) +
            ",\"channels\":4,\"dtype\":\"float32\",\"byteOrder\":\"little\",\"origin\":\"top-left\",\"sourceType\":\"rgba16float\"}\n");
    }
    if (!debugDump_->pending.empty()) {
        dumpFile(directory / (prefix + ".json"), debugDump_->metadata);
        for (const auto& texture : debugDump_->pending) wgpuBufferRelease(texture.buffer);
        debugDump_->pending.clear();
    }
    if (captured) dumpFile(directory / "capture.json", debugDump_->metadata);
}

} // namespace tn::fixture
