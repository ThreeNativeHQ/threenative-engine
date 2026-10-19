#pragma once

// A test-side writer of the TNPK v1 format (src/engine/assets/package.h), byte for byte what
// packages/assets emits. Tests build valid packages with it and then damage them on purpose.
#include "engine/assets/package.h"

#include <string>
#include <vector>

namespace tn::test {

struct EntrySpec {
    std::string name;
    uint16_t kind = 1;
    uint32_t decoders = 0;
    std::vector<uint8_t> data;
    uint64_t uploadSize = 0;
    std::vector<uint32_t> dependencies;
};

inline void put(std::vector<uint8_t>& out, uint64_t value, int bytes) {
    for (int i = 0; i < bytes; ++i) out.push_back(static_cast<uint8_t>(value >> (8 * i)));
}

inline std::vector<uint8_t> writePackage(const std::vector<EntrySpec>& entries, uint32_t version = 1) {
    std::vector<uint8_t> table;
    size_t tableSize = 0;
    for (const EntrySpec& e : entries) tableSize += 2 + e.name.size() + 2 + 4 + 8 + 8 + 8 + 32 + 4 + 4 * e.dependencies.size();
    uint64_t offset = tn::engine::assets::kPackageHeaderSize + tableSize;
    for (const EntrySpec& e : entries) {
        put(table, e.name.size(), 2);
        table.insert(table.end(), e.name.begin(), e.name.end());
        put(table, e.kind, 2);
        put(table, e.decoders, 4);
        put(table, offset, 8);
        put(table, e.data.size(), 8);
        put(table, e.uploadSize, 8);
        const auto hash = tn::engine::assets::sha256(e.data.data(), e.data.size());
        table.insert(table.end(), hash.begin(), hash.end());
        put(table, e.dependencies.size(), 4);
        for (uint32_t d : e.dependencies) put(table, d, 4);
        offset += e.data.size();
    }
    std::vector<uint8_t> out{'T', 'N', 'P', 'K'};
    put(out, version, 4);
    put(out, entries.size(), 4);
    put(out, 0, 4);
    put(out, table.size(), 8);
    out.insert(out.end(), table.begin(), table.end());
    for (const EntrySpec& e : entries) out.insert(out.end(), e.data.begin(), e.data.end());
    return out;
}

}  // namespace tn::test
