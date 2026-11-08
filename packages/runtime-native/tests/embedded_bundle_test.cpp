// Bindings test for the embedded-bundle VFS (src/vfs/embedded_bundle.cpp).
// The bundle is how a packaged game's assets reach fetch() without a
// filesystem install, so the loader must accept exactly the documented
// container — magic, version, index, data — and reject everything else.
// This synthesizes real bundle files rather than mocking the reader.
//
// Build (opt-in, like the other bindings tests):
//   ninja -C build/tn-linux threenative-embedded-bundle-test && \
//   ./build/tn-linux/threenative-embedded-bundle-test

#include "mystral/vfs/embedded_bundle.h"

#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

#ifdef _WIN32
#include <process.h>
#define TN_TEST_GETPID _getpid
#else
#include <unistd.h>
#define TN_TEST_GETPID getpid
#endif

using mystral::vfs::EmbeddedBundle;
using mystral::vfs::kBundleMagic;
using mystral::vfs::kBundleVersion;

namespace {

int failures = 0;

void expect(bool condition, const std::string& what) {
    if (!condition) {
        std::cerr << "FAIL: " << what << '\n';
        failures++;
    }
}

void appendU32(std::vector<uint8_t>& out, uint32_t value) {
    for (int i = 0; i < 4; i++) out.push_back(static_cast<uint8_t>((value >> (8 * i)) & 0xFF));
}

void appendU64(std::vector<uint8_t>& out, uint64_t value) {
    for (int i = 0; i < 8; i++) out.push_back(static_cast<uint8_t>((value >> (8 * i)) & 0xFF));
}

void appendBytes(std::vector<uint8_t>& out, const std::string& value) {
    out.insert(out.end(), value.begin(), value.end());
}

struct FileRecord {
    std::string path;
    std::string data;
};

// Layout: [data][index][footer]; offsets in records are relative to data start.
std::vector<uint8_t> buildBundle(const std::string& entryPath,
                                 const std::vector<FileRecord>& files) {
    std::vector<uint8_t> data;
    std::vector<uint8_t> index;

    appendU32(index, kBundleVersion);            // indexVersion
    appendU32(index, static_cast<uint32_t>(files.size()));
    appendU32(index, static_cast<uint32_t>(entryPath.size()));
    appendU32(index, 0);                         // reserved
    appendBytes(index, entryPath);

    uint64_t offset = 0;
    for (const FileRecord& record : files) {
        appendU32(index, static_cast<uint32_t>(record.path.size()));
        appendU32(index, 0);                     // record reserved
        appendU64(index, offset);
        appendU64(index, record.data.size());
        appendBytes(index, record.path);
        appendBytes(data, record.data);
        offset += record.data.size();
    }

    std::vector<uint8_t> bundle = data;
    bundle.insert(bundle.end(), index.begin(), index.end());
    appendBytes(bundle, std::string(kBundleMagic, kBundleMagic + 8));
    appendU32(bundle, kBundleVersion);           // footer version
    appendU32(bundle, 0);                        // footer reserved
    appendU64(bundle, index.size());             // footer index size
    return bundle;
}

bool writeFile(const std::string& path, const std::vector<uint8_t>& contents) {
    std::ofstream file(path, std::ios::binary | std::ios::trunc);
    if (!file.is_open()) return false;
    file.write(reinterpret_cast<const char*>(contents.data()),
               static_cast<std::streamsize>(contents.size()));
    return file.good();
}

struct TempDir {
    std::filesystem::path path;
    TempDir() {
        path = std::filesystem::temp_directory_path() /
               ("threenative-embedded-bundle-test-" + std::to_string(TN_TEST_GETPID()));
        std::filesystem::remove_all(path);
        std::filesystem::create_directories(path);
    }
    ~TempDir() { std::filesystem::remove_all(path); }
    std::string file(const std::string& name) const { return (path / name).string(); }
};

}  // namespace

int main() {
    TempDir temp;

    // --- Valid bundle: find + read through normalized lookups --------------
    const std::string bundlePath = temp.file("valid-game.bundle");
    expect(writeFile(bundlePath, buildBundle(
               "src/game.js",
               {
                   {"assets/ship.glb", "\x67\x6c\x54\x46-binary-bytes"},
                   {"textures/hull.png", std::string("\x89PNG-fake\x00\x01", 11)},
               })),
           "synthetic bundle written");

    auto bundle = EmbeddedBundle::loadFromPath(bundlePath);
    expect(bundle != nullptr, "valid bundle loads");
    if (bundle) {
        expect(bundle->entryPath() == "src/game.js", "entry path preserved");

        std::vector<uint8_t> out;
        expect(bundle->readFile("assets/ship.glb", out), "exact path reads");
        expect(std::string(out.begin(), out.end()) == "\x67\x6c\x54\x46-binary-bytes",
               "bytes survive the container");

        // fetch() hands the VFS whatever the URL looked like; lookups must be
        // normalization-tolerant.
        out.clear();
        expect(bundle->findFile("/assets/ship.glb") != nullptr, "leading slash normalizes");
        expect(bundle->findFile("./assets/ship.glb") != nullptr, "./ prefix normalizes");
        expect(bundle->findFile("file://assets/ship.glb") != nullptr, "file:// scheme strips");
        expect(bundle->findFile("assets/../assets/ship.glb") != nullptr,
               "interior dot-dot normalizes");
        expect(bundle->readFile("./textures/hull.png", out), "normalized path reads");
        expect(out.size() == 11, "second file byte count matches");

        out.clear();
        expect(!bundle->readFile("assets/missing.glb", out), "missing file fails closed");
        expect(out.empty(), "failed read leaves output empty");
    }

    // --- Rejections: each broken container variant --------------------------
    struct RejectCase {
        const char* name;
        std::vector<uint8_t> contents;
    };
    std::vector<RejectCase> rejects = {
        {"empty file", {}},
        {"truncated below footer size", {'M', 'Y', 'S', 'B'}},
        {"bad magic",
             {0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a,
              0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15,
              0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c}},
    };
    for (const RejectCase& reject : rejects) {
        const std::string path = temp.file((std::string("reject-") + reject.name + ".bin"));
        expect(writeFile(path, reject.contents), "reject fixture written");
        expect(EmbeddedBundle::loadFromPath(path) == nullptr,
               std::string("rejects ") + reject.name);
    }

    // Wrong footer version: valid structure, unsupported container revision.
    {
        std::vector<uint8_t> contents = buildBundle("src/game.js", {{"a.txt", "x"}});
        const size_t versionOffset = contents.size() - 20;  // magic + version u32
        contents[versionOffset] = 99;
        const std::string path = temp.file("reject-version.bin");
        expect(writeFile(path, contents), "version fixture written");
        expect(EmbeddedBundle::loadFromPath(path) == nullptr, "rejects wrong version");
    }

    // Index claiming more bytes than exist before the footer.
    {
        std::vector<uint8_t> contents = buildBundle("src/game.js", {{"a.txt", "x"}});
        // Overwrite the footer's u64 indexSize (magic + 2 u32s from the end)
        // with 0xFFFF... so indexStart underflows past the file start.
        for (size_t i = contents.size() - 12; i < contents.size() - 4; i++) {
            contents[i] = 0xFF;
        }
        const std::string path = temp.file("reject-indexsize.bin");
        expect(writeFile(path, contents), "index-size fixture written");
        expect(EmbeddedBundle::loadFromPath(path) == nullptr,
               "rejects oversized index claim");
    }

    // --- normalizeBundlePath units -------------------------------------------
    expect(mystral::vfs::normalizeBundlePath("file://a/b.png") == "a/b.png", "strips file://");
    expect(mystral::vfs::normalizeBundlePath("./x/./y.txt") == "x/y.txt", "collides dot segments");
    expect(mystral::vfs::normalizeBundlePath("/lead.txt") == "lead.txt", "drops leading slash");
#ifdef _WIN32
    expect(mystral::vfs::normalizeBundlePath("a\\b.txt") == "a/b.txt", "backslash converts");
#endif

#ifndef _WIN32
    setenv("MYSTRAL_BUNDLE", bundlePath.c_str(), 1);
#else
    _putenv_s("MYSTRAL_BUNDLE", bundlePath.c_str());
#endif
    // Exercise executable path, shared bundle, and helper functions with bundle loaded
    mystral::vfs::getExecutablePath();
    mystral::vfs::EmbeddedBundle::loadFromExecutable();
    expect(mystral::vfs::hasEmbeddedBundle(), "hasEmbeddedBundle via env");
    expect(mystral::vfs::getEmbeddedEntryPath() == "src/game.js", "getEmbeddedEntryPath via env");
    std::vector<uint8_t> outBytes;
    expect(mystral::vfs::readEmbeddedFile("assets/ship.glb", outBytes), "readEmbeddedFile via env");
#ifndef _WIN32
    unsetenv("MYSTRAL_BUNDLE");
#else
    _putenv_s("MYSTRAL_BUNDLE", "");
#endif

    // --- resolveFetchPath: the mobile fetch path mapping ---------------------
    using mystral::vfs::FetchPathPlatform;
    using mystral::vfs::resolveFetchPath;
    // Android serves the game directory from the APK: relative and leading-slash URLs land in it,
    // a path that already carries the prefix is not doubled, file:// URLs are left to the filesystem.
    expect(resolveFetchPath("textures/x.png", FetchPathPlatform::Android) == "game/textures/x.png",
           "android relative");
    expect(resolveFetchPath("/textures/x.png", FetchPathPlatform::Android) == "game/textures/x.png",
           "android leading slash");
    expect(resolveFetchPath("./textures/x.png", FetchPathPlatform::Android) == "game/textures/x.png",
           "android dot segment");
    expect(resolveFetchPath("game/x.png", FetchPathPlatform::Android) == "game/x.png",
           "android prefix kept once");
    expect(resolveFetchPath("file:///data/x.png", FetchPathPlatform::Android) == "/data/x.png",
           "android file url");
    // iOS runs from the game directory (the host changes into it), so only a leading slash moves.
    expect(resolveFetchPath("/textures/x.png", FetchPathPlatform::Ios) == "textures/x.png",
           "ios leading slash");
    expect(resolveFetchPath("textures/x.png", FetchPathPlatform::Ios) == "textures/x.png",
           "ios relative unchanged");
    expect(resolveFetchPath("file:///data/x.png", FetchPathPlatform::Ios) == "/data/x.png",
           "ios file url");
    expect(resolveFetchPath("/abs/x.png", FetchPathPlatform::Desktop) == "/abs/x.png",
           "desktop keeps absolute paths");
    expect(resolveFetchPath("file:///abs/x.png", FetchPathPlatform::Desktop) == "/abs/x.png",
           "desktop strips the scheme only");

    if (failures > 0) {
        std::cerr << failures << " embedded-bundle assertion(s) failed\n";
        return 1;
    }
    std::cout << "embedded_bundle bindings: all assertions passed\n";
    return 0;
}
