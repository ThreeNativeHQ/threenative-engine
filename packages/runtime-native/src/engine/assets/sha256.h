#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

namespace tn::engine::assets {

using Sha256Digest = std::array<uint8_t, 32>;

/** FIPS 180-4 SHA-256 of a byte range; verifies cooked package entries before they are used. */
Sha256Digest sha256(const uint8_t* data, size_t size);

}  // namespace tn::engine::assets
