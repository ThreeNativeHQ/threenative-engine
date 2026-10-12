#include "package.h"

#include <cstring>

namespace tn::engine::assets {

namespace {

// A bounds-checked little-endian cursor: every read is refused rather than run past the end.
struct Reader {
    std::span<const uint8_t> bytes;
    size_t at = 0;
    bool ok = true;

    bool need(size_t n) {
        if (!ok || n > bytes.size() || at > bytes.size() - n) ok = false;
        return ok;
    }
    template <typename T>
    T read() {
        T value{};
        if (!need(sizeof(T))) return value;
        for (size_t i = 0; i < sizeof(T); ++i) value |= static_cast<T>(T{bytes[at + i]} << (8 * i));
        at += sizeof(T);
        return value;
    }
    void raw(void* out, size_t n) {
        if (!need(n)) return;
        std::memcpy(out, bytes.data() + at, n);
        at += n;
    }
};

bool fail(PackageError& error, const char* code, std::string detail) {
    error = PackageError{code, std::move(detail)};
    return false;
}

std::string hex(const Sha256Digest& d) {
    static const char* digits = "0123456789abcdef";
    std::string out;
    for (uint8_t b : d) {
        out += digits[b >> 4];
        out += digits[b & 15];
    }
    return out;
}

}  // namespace

bool parsePackage(std::span<const uint8_t> bytes, Package& out, PackageError& error) {
    out = Package{};
    out.bytes = bytes;
    if (bytes.size() < kPackageHeaderSize) return fail(error, "TN_PACKAGE_TRUNCATED", "shorter than the 24-byte header");
    if (std::memcmp(bytes.data(), "TNPK", 4) != 0) return fail(error, "TN_PACKAGE_MAGIC", "not a TNPK package");
    Reader r{bytes, 4};
    out.version = r.read<uint32_t>();
    // Refused before anything else is trusted: another revision may lay out its table differently.
    if (out.version != kPackageFormatVersion) {
        return fail(error, "TN_PACKAGE_VERSION",
                    "format " + std::to_string(out.version) + ", the engine reads " + std::to_string(kPackageFormatVersion));
    }
    const uint32_t count = r.read<uint32_t>();
    r.read<uint32_t>();  // reserved
    const uint64_t tableSize = r.read<uint64_t>();
    if (tableSize > bytes.size() - kPackageHeaderSize) {
        return fail(error, "TN_PACKAGE_TRUNCATED", "entry table runs past the end");
    }
    const uint64_t tableEnd = kPackageHeaderSize + tableSize;
    Reader table{bytes.first(static_cast<size_t>(tableEnd)), kPackageHeaderSize};
    // An entry needs at least 68 bytes, so a count the table cannot hold is refused before any allocation.
    if (count > tableSize / 68) return fail(error, "TN_PACKAGE_TRUNCATED", "entry count exceeds the table");
    out.entries.reserve(count);
    for (uint32_t i = 0; i < count; ++i) {
        PackageEntry e;
        const uint16_t nameLength = table.read<uint16_t>();
        if (!table.need(nameLength)) break;
        e.name.assign(reinterpret_cast<const char*>(bytes.data() + table.at), nameLength);
        table.at += nameLength;
        e.kind = table.read<uint16_t>();
        e.decoders = table.read<uint32_t>();
        e.offset = table.read<uint64_t>();
        e.size = table.read<uint64_t>();
        e.uploadSize = table.read<uint64_t>();
        table.raw(e.hash.data(), e.hash.size());
        const uint32_t deps = table.read<uint32_t>();
        if (!table.ok || deps > (tableEnd - table.at) / 4) {
            return fail(error, "TN_PACKAGE_TRUNCATED", "entry " + std::to_string(i) + " runs past the table");
        }
        for (uint32_t d = 0; d < deps; ++d) e.dependencies.push_back(table.read<uint32_t>());
        // Data lives after the table and inside the file; subtraction, never offset + size, so it cannot wrap.
        if (e.offset < tableEnd || e.offset > bytes.size() || e.size > bytes.size() - e.offset) {
            return fail(error, "TN_PACKAGE_RANGE", "entry '" + e.name + "' data is outside the package");
        }
        out.entries.push_back(std::move(e));
    }
    if (!table.ok) return fail(error, "TN_PACKAGE_TRUNCATED", "the entry table ends mid-entry");
    for (const PackageEntry& e : out.entries) {
        for (uint32_t d : e.dependencies) {
            if (d >= out.entries.size() || &out.entries[d] == &e) {
                return fail(error, "TN_PACKAGE_DEPENDENCY", "entry '" + e.name + "' depends on " + std::to_string(d));
            }
        }
    }
    return true;
}

uint32_t targetDecoders() { return 0; }  // none qualified yet, on any target

bool verifyPackage(const Package& package, uint32_t availableDecoders, PackageError& error) {
    for (const PackageEntry& e : package.entries) {
        const uint32_t missing = e.decoders & ~availableDecoders;
        if (missing) {
            const char* code = (missing & kDecoderKtx2)                       ? "TN_NATIVE_KTX2_UNSUPPORTED"
                               : (missing & (kDecoderMeshopt | kDecoderDraco)) ? "TN_NATIVE_MESH_COMPRESSION_UNSUPPORTED"
                                                                               : "TN_PACKAGE_DECODER";
            return fail(error, code,
                        "entry '" + e.name + "' needs decoder bits " + std::to_string(missing) + " this target lacks");
        }
        const std::span<const uint8_t> data = package.data(e);
        const Sha256Digest actual = sha256(data.data(), data.size());
        if (actual != e.hash) {
            return fail(error, "TN_PACKAGE_HASH", "entry '" + e.name + "' is " + hex(actual) + ", the manifest says " + hex(e.hash));
        }
    }
    return true;
}

}  // namespace tn::engine::assets
