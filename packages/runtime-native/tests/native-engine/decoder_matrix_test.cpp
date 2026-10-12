// PRD-515 phase 3: the decoder matrix. Every asset format a package can carry is qualified or refused
// on this target, and printed as one row. No decoder is qualified on any target yet, so the compressed
// formats are refused everywhere with the product's codes; the same test runs in the desktop, Wasm
// and Android builds, which is what keeps the refusals in force on mobile. Qualifying a decoder means
// adding it to targetDecoders() and moving its row here, with its own proof.
#include "check.h"
#include "engine/assets/package.h"
#include "package_writer.h"

#include <cstdio>
#include <string>

using namespace tn::engine::assets;

namespace {

const char* targetName() {
#if defined(__ANDROID__)
    return "android";
#elif defined(__EMSCRIPTEN__)
    return "wasm";
#elif defined(__APPLE__)
    return "apple";
#elif defined(_WIN32)
    return "windows";
#else
    return "linux";
#endif
}

void matrix() {
    struct Row {
        const char* format;
        uint16_t kind;
        uint32_t decoders;
        const char* expected;  // empty: qualified
    };
    const Row rows[] = {
        {"buffer (raw bytes)", 1, 0, ""},
        {"texture (RGBA8)", 2, 0, ""},
        {"meshopt geometry", 1, kDecoderMeshopt, "TN_NATIVE_MESH_COMPRESSION_UNSUPPORTED"},
        {"draco geometry", 1, kDecoderDraco, "TN_NATIVE_MESH_COMPRESSION_UNSUPPORTED"},
        {"ktx2/basis texture", 2, kDecoderKtx2, "TN_NATIVE_KTX2_UNSUPPORTED"},
    };
    CHECK(targetDecoders() == 0);  // nothing is qualified yet; a new decoder must update this matrix
    for (const Row& row : rows) {
        std::vector<uint8_t> texture;
        tn::test::put(texture, 1, 4);
        tn::test::put(texture, 1, 4);
        tn::test::put(texture, 18, 4);
        for (int i = 0; i < 4; ++i) texture.push_back(uint8_t(i));
        const auto file = tn::test::writePackage({{"entry", row.kind, row.decoders, row.kind == 2 ? texture : std::vector<uint8_t>(16, 7), 16, {}}});
        Package package;
        PackageError error;
        CHECK(parsePackage(file, package, error));
        const bool qualified = verifyPackage(package, targetDecoders(), error);
        std::printf("decoder-matrix %s %-20s %s\n", targetName(), row.format, qualified ? "qualified" : error.code.c_str());
        if (row.expected[0] == '\0') {
            CHECK(qualified);
        } else {
            CHECK(!qualified && error.code == row.expected);
        }
    }
}

}  // namespace

TN_TEST_MAIN({"matrix", matrix})
