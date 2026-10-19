#include "check.h"
#include "engine/assets/package.h"
#include "package_writer.h"

#include <cstring>
#include <string>

using namespace tn::engine::assets;
using tn::test::EntrySpec;
using tn::test::writePackage;

namespace {

std::string hex(const Sha256Digest& d) {
    static const char* digits = "0123456789abcdef";
    std::string out;
    for (uint8_t b : d) out += {digits[b >> 4], digits[b & 15]};
    return out;
}

std::vector<uint8_t> bytes(const char* s) { return std::vector<uint8_t>(s, s + std::strlen(s)); }

std::vector<EntrySpec> sample() {
    return {{"geometry/box", 1, 0, bytes("vertex data, 24 bytes ok"), 24, {}},
            {"textures/albedo", 2, kDecoderMeshopt, std::vector<uint8_t>(4096, 0x7f), 4096, {}},
            {"scenes/main", 6, 0, bytes("{scene}"), 0, {0, 1}}};
}

void sha() {
    // FIPS 180-4 vectors: empty, "abc", and the two-block 448-bit message.
    CHECK(hex(sha256(nullptr, 0)) == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    const auto abc = bytes("abc");
    CHECK(hex(sha256(abc.data(), abc.size())) == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const auto two = bytes("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq");
    CHECK(hex(sha256(two.data(), two.size())) == "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
}

void load() {
    const auto file = writePackage(sample());
    Package package;
    PackageError error;
    CHECK(parsePackage(file, package, error));
    CHECK(package.entries.size() == 3);
    CHECK(verifyPackage(package, kDecoderMeshopt, error));
    const auto data = package.data(package.entries[0]);
    CHECK(std::string(data.begin(), data.end()) == "vertex data, 24 bytes ok");
    CHECK(package.entries[2].dependencies.size() == 2 && package.entries[2].dependencies[1] == 1);
    CHECK(package.entries[1].uploadSize == 4096);
}

void reject() {
    auto expect = [](std::vector<uint8_t> file, const char* code, uint32_t decoders = kDecoderMeshopt) {
        Package package;
        PackageError error;
        const bool ok = parsePackage(file, package, error) && verifyPackage(package, decoders, error);
        if (ok || error.code != code) std::fprintf(stderr, "want %s, got %s (%s)\n", code, error.code.c_str(), error.detail.c_str());
        CHECK(!ok && error.code == code);
    };
    const auto good = writePackage(sample());

    expect(writePackage(sample(), 2), "TN_PACKAGE_VERSION");
    auto magic = good;
    magic[0] = 'X';
    expect(magic, "TN_PACKAGE_MAGIC");
    expect(std::vector<uint8_t>(good.begin(), good.begin() + 20), "TN_PACKAGE_TRUNCATED");
    expect(std::vector<uint8_t>(good.begin(), good.begin() + 60), "TN_PACKAGE_TRUNCATED");

    auto tampered = good;
    tampered.back() ^= 1;  // one bit of the last entry's data
    expect(tampered, "TN_PACKAGE_HASH");

    expect(good, "TN_NATIVE_MESH_COMPRESSION_UNSUPPORTED", 0);  // the texture needs meshopt; this target has none

    auto deps = sample();
    deps[2].dependencies = {7};
    expect(writePackage(deps), "TN_PACKAGE_DEPENDENCY");
    deps[2].dependencies = {2};  // itself
    expect(writePackage(deps), "TN_PACKAGE_DEPENDENCY");

    // The first entry's offset field sits at 24 + 2 + name + 2 + 4.
    const size_t offsetField = 24 + 2 + std::strlen("geometry/box") + 2 + 4;
    auto outside = good;
    std::memset(&outside[offsetField], 0xff, 8);  // offset 2^64 - 1
    expect(outside, "TN_PACKAGE_RANGE");
    auto wrap = good;
    std::memset(&wrap[offsetField + 8], 0xff, 8);  // size 2^64 - 1: offset + size wraps
    expect(wrap, "TN_PACKAGE_RANGE");
    auto inTable = good;
    std::memset(&inTable[offsetField], 0, 8);  // data claimed inside the header
    expect(inTable, "TN_PACKAGE_RANGE");

    auto count = good;
    std::memset(&count[8], 0xff, 4);  // 4 billion entries in a few hundred bytes
    expect(count, "TN_PACKAGE_TRUNCATED");
}

}  // namespace

TN_TEST_MAIN({"sha256", sha}, {"load", load}, {"reject", reject})
