#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

namespace mystral {
namespace vfs {

struct BundleFileInfo {
    uint64_t offset = 0;
    uint64_t size = 0;
};

class EmbeddedBundle {
public:
    static std::unique_ptr<EmbeddedBundle> loadFromExecutable();
    static std::unique_ptr<EmbeddedBundle> loadFromPath(const std::string& path);

    const std::string& entryPath() const;
    const BundleFileInfo* findFile(const std::string& path) const;
    bool readFile(const std::string& path, std::vector<uint8_t>& out) const;

private:
    std::string exePath_;
    std::string entryPath_;
    uint64_t bundleStart_ = 0;
    std::unordered_map<std::string, BundleFileInfo> files_;
};

bool readEmbeddedFile(const std::string& path, std::vector<uint8_t>& out);
bool hasEmbeddedBundle();
std::string getEmbeddedEntryPath();
std::string normalizeBundlePath(const std::string& path);

/** Where a game's files live for a platform, for the paths `fetch` and file reads receive. */
enum class FetchPathPlatform { Desktop, Android, Ios };

/**
 * Maps the path a game passes to `fetch` onto the packaged bundle path.
 *
 * Android serves the game directory from the APK, so a non-`file://` path becomes `game/<path>`
 * (already-prefixed paths are kept). iOS runs from the game directory, so a leading-slash path
 * becomes relative to it. Desktop and every `file://` URL keep the path as given, minus the scheme.
 */
std::string resolveFetchPath(std::string path, FetchPathPlatform platform);
std::string getExecutablePath();

constexpr uint32_t kBundleVersion = 1;
constexpr size_t kBundleMagicSize = 8;
extern const char kBundleMagic[kBundleMagicSize];

}  // namespace vfs
}  // namespace mystral
