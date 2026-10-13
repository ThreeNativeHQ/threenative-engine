#pragma once

#include <array>
#include <cstdint>
#include <random>
#include <string>

namespace tn::engine {

/** three's MathUtils.generateUUID: an RFC 4122 version 4 id. Identity of an object lives natively. */
inline std::string generateUuid() {
    static thread_local std::mt19937 random(std::random_device{}());
    constexpr char hex[] = "0123456789abcdef";
    std::array<uint8_t, 16> bytes{};
    for (size_t i = 0; i < bytes.size(); i += 4) {
        const uint32_t value = random();
        for (size_t j = 0; j < 4; ++j) bytes[i + j] = static_cast<uint8_t>(value >> (8 * j));
    }
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    std::string uuid;
    for (size_t i = 0; i < bytes.size(); ++i) {
        if (i == 4 || i == 6 || i == 8 || i == 10) uuid += '-';
        uuid += hex[bytes[i] >> 4]; uuid += hex[bytes[i] & 15];
    }
    return uuid;
}

}  // namespace tn::engine
