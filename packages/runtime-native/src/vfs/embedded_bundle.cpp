#include "mystral/vfs/embedded_bundle.h"

#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>

#ifdef _WIN32
#include <windows.h>
#elif defined(__APPLE__)
#include <mach-o/dyld.h>
#include <unistd.h>
#elif defined(__linux__)
#include <limits.h>
#include <unistd.h>
#endif

namespace mystral {
namespace vfs {

namespace {

constexpr size_t kFooterSize = kBundleMagicSize + sizeof(uint32_t) + sizeof(uint32_t) + sizeof(uint64_t);

bool readFileRange(const std::string& path, uint64_t offset, uint64_t size, std::vector<uint8_t>& out) {
    std::ifstream file(path, std::ios::binary);
    if (!file.is_open()) {
        return false;
    }
    file.seekg(0, std::ios::end);
    uint64_t fileSize = static_cast<uint64_t>(file.tellg());
    if (offset + size > fileSize) {
        return false;
    }
    file.seekg(static_cast<std::streamoff>(offset), std::ios::beg);
    out.resize(static_cast<size_t>(size));
    file.read(reinterpret_cast<char*>(out.data()), static_cast<std::streamsize>(size));
    return static_cast<uint64_t>(file.gcount()) == size;
}

bool readU32(const std::vector<uint8_t>& data, size_t& cursor, uint32_t& out) {
    if (cursor + 4 > data.size()) {
        return false;
    }
    out = static_cast<uint32_t>(data[cursor]) |
          (static_cast<uint32_t>(data[cursor + 1]) << 8) |
          (static_cast<uint32_t>(data[cursor + 2]) << 16) |
          (static_cast<uint32_t>(data[cursor + 3]) << 24);
    cursor += 4;
    return true;
}

bool readU64(const std::vector<uint8_t>& data, size_t& cursor, uint64_t& out) {
    if (cursor + 8 > data.size()) {
        return false;
    }
    out = static_cast<uint64_t>(data[cursor]) |
          (static_cast<uint64_t>(data[cursor + 1]) << 8) |
          (static_cast<uint64_t>(data[cursor + 2]) << 16) |
          (static_cast<uint64_t>(data[cursor + 3]) << 24) |
          (static_cast<uint64_t>(data[cursor + 4]) << 32) |
          (static_cast<uint64_t>(data[cursor + 5]) << 40) |
          (static_cast<uint64_t>(data[cursor + 6]) << 48) |
          (static_cast<uint64_t>(data[cursor + 7]) << 56);
    cursor += 8;
    return true;
}

std::unique_ptr<EmbeddedBundle> findExternalBundle() {
    // Check environment variable override
    const char* envBundle = std::getenv("MYSTRAL_BUNDLE");
    if (envBundle && envBundle[0] != '\0') {
        auto bundle = EmbeddedBundle::loadFromPath(envBundle);
        if (bundle) {
            std::cout << "[VFS] Loaded bundle from MYSTRAL_BUNDLE: " << envBundle << std::endl;
            return bundle;
        }
    }

    // Get executable directory
    std::string exePath = getExecutablePath();
    if (exePath.empty()) {
        return nullptr;
    }
    std::filesystem::path exeDir = std::filesystem::path(exePath).parent_path();

    // Search next to executable: game.bundle
    std::filesystem::path localBundle = exeDir / "game.bundle";
    if (std::filesystem::exists(localBundle)) {
        auto bundle = EmbeddedBundle::loadFromPath(localBundle.string());
        if (bundle) {
            std::cout << "[VFS] Loaded bundle: " << localBundle << std::endl;
            return bundle;
        }
    }

#ifdef __APPLE__
    // macOS: check ../Resources/game.bundle (for .app bundles)
    std::filesystem::path resourcesBundle = exeDir / ".." / "Resources" / "game.bundle";
    resourcesBundle = resourcesBundle.lexically_normal();
    if (std::filesystem::exists(resourcesBundle)) {
        auto bundle = EmbeddedBundle::loadFromPath(resourcesBundle.string());
        if (bundle) {
            std::cout << "[VFS] Loaded bundle from .app Resources: " << resourcesBundle << std::endl;
            return bundle;
        }
    }
#endif

    return nullptr;
}

EmbeddedBundle* sharedBundle() {
    static std::unique_ptr<EmbeddedBundle> bundle;
    static bool loaded = false;
    if (!loaded) {
        // Try appended data first (compiled binary)
        bundle = EmbeddedBundle::loadFromExecutable();
        // Fall back to external bundle file
        if (!bundle) {
            bundle = findExternalBundle();
        }
        loaded = true;
    }
    return bundle.get();
}

}  // namespace

const char kBundleMagic[kBundleMagicSize] = { 'M', 'Y', 'S', 'B', 'N', 'D', 'L', '1' };

std::string normalizeBundlePath(const std::string& path) {
    std::string normalized = path;
    if (normalized.rfind("file://", 0) == 0) {
        normalized = normalized.substr(7);
    }

    std::replace(normalized.begin(), normalized.end(), '\\', '/');

    while (normalized.rfind("./", 0) == 0) {
        normalized = normalized.substr(2);
    }

    std::filesystem::path cleaned = std::filesystem::path(normalized).lexically_normal();
    normalized = cleaned.generic_string();

    if (normalized == ".") {
        normalized.clear();
    }

    if (!normalized.empty() && normalized.front() == '/') {
        normalized.erase(0, 1);
    }

    return normalized;
}

std::string resolveFetchPath(std::string path, FetchPathPlatform platform) {
    const bool fileUrl = path.rfind("file://", 0) == 0;
    if (fileUrl) {
        path = path.substr(7);
    }
    if (platform == FetchPathPlatform::Android && !fileUrl) {
        const std::string normalized = normalizeBundlePath(path);
        if (normalized.rfind("game/", 0) == 0) return normalized;
        return "game/" + normalized;
    }
    if (platform == FetchPathPlatform::Ios && !fileUrl && !path.empty() && path.front() == '/') {
        return normalizeBundlePath(path);
    }
    return path;
}

std::string getExecutablePath() {
#ifdef _WIN32
    char buffer[MAX_PATH] = {};
    DWORD size = GetModuleFileNameA(nullptr, buffer, MAX_PATH);
    if (size == 0 || size == MAX_PATH) {
        return {};
    }
    return std::string(buffer, size);
#elif defined(__APPLE__)
    uint32_t size = 0;
    _NSGetExecutablePath(nullptr, &size);
    if (size == 0) {
        return {};
    }
    std::string path(size, '\0');
    if (_NSGetExecutablePath(path.data(), &size) != 0) {
        return {};
    }
    return std::filesystem::path(path.c_str()).lexically_normal().string();
#elif defined(__linux__)
    char buffer[PATH_MAX] = {};
    ssize_t size = readlink("/proc/self/exe", buffer, sizeof(buffer) - 1);
    if (size <= 0) {
        return {};
    }
    buffer[size] = '\0';
    return std::string(buffer);
#else
    return {};
#endif
}

std::unique_ptr<EmbeddedBundle> EmbeddedBundle::loadFromExecutable() {
    std::string exePath = getExecutablePath();
    if (exePath.empty()) {
        return nullptr;
    }
    return loadFromPath(exePath);
}

std::unique_ptr<EmbeddedBundle> EmbeddedBundle::loadFromPath(const std::string& path) {
    std::ifstream file(path, std::ios::binary);
    if (!file.is_open()) {
        return nullptr;
    }

    file.seekg(0, std::ios::end);
    uint64_t fileSize = static_cast<uint64_t>(file.tellg());
    if (fileSize <= kFooterSize) {
        return nullptr;
    }

    file.seekg(static_cast<std::streamoff>(fileSize - kFooterSize), std::ios::beg);
    std::vector<uint8_t> footer(kFooterSize);
    file.read(reinterpret_cast<char*>(footer.data()), static_cast<std::streamsize>(footer.size()));
    if (!file.good()) {
        return nullptr;
    }

    if (std::memcmp(footer.data(), kBundleMagic, kBundleMagicSize) != 0) {
        return nullptr;
    }

    size_t cursor = kBundleMagicSize;
    uint32_t version = 0;
    uint32_t reserved = 0;
    uint64_t indexSize = 0;
    if (!readU32(footer, cursor, version) || !readU32(footer, cursor, reserved) ||
        !readU64(footer, cursor, indexSize)) {
        return nullptr;
    }

    if (version != kBundleVersion || indexSize == 0 || indexSize > fileSize - kFooterSize) {
        return nullptr;
    }

    uint64_t indexStart = fileSize - kFooterSize - indexSize;
    if (indexStart >= fileSize) {
        return nullptr;
    }

    file.seekg(static_cast<std::streamoff>(indexStart), std::ios::beg);
    std::vector<uint8_t> index(static_cast<size_t>(indexSize));
    file.read(reinterpret_cast<char*>(index.data()), static_cast<std::streamsize>(index.size()));
    if (!file.good()) {
        return nullptr;
    }

    cursor = 0;
    uint32_t indexVersion = 0;
    uint32_t fileCount = 0;
    uint32_t entryPathSize = 0;
    uint32_t indexReserved = 0;
    if (!readU32(index, cursor, indexVersion) ||
        !readU32(index, cursor, fileCount) ||
        !readU32(index, cursor, entryPathSize) ||
        !readU32(index, cursor, indexReserved)) {
        return nullptr;
    }

    if (indexVersion != kBundleVersion) {
        return nullptr;
    }

    if (cursor + entryPathSize > index.size()) {
        return nullptr;
    }

    std::string entryPath(reinterpret_cast<const char*>(index.data() + cursor), entryPathSize);
    cursor += entryPathSize;

    auto bundle = std::make_unique<EmbeddedBundle>();
    bundle->exePath_ = path;
    bundle->entryPath_ = normalizeBundlePath(entryPath);

    uint64_t dataSize = 0;
    for (uint32_t i = 0; i < fileCount; ++i) {
        uint32_t pathSize = 0;
        uint32_t recordReserved = 0;
        uint64_t offset = 0;
        uint64_t size = 0;
        if (!readU32(index, cursor, pathSize) ||
            !readU32(index, cursor, recordReserved) ||
            !readU64(index, cursor, offset) ||
            !readU64(index, cursor, size)) {
            return nullptr;
        }

        if (cursor + pathSize > index.size()) {
            return nullptr;
        }

        std::string pathName(reinterpret_cast<const char*>(index.data() + cursor), pathSize);
        cursor += pathSize;

        std::string normalized = normalizeBundlePath(pathName);
        if (!normalized.empty()) {
            bundle->files_[normalized] = { offset, size };
        }

        if (offset + size > dataSize) {
            dataSize = offset + size;
        }
    }

    if (dataSize > indexStart) {
        return nullptr;
    }

    bundle->bundleStart_ = indexStart - dataSize;
    return bundle;
}

const std::string& EmbeddedBundle::entryPath() const {
    return entryPath_;
}

const BundleFileInfo* EmbeddedBundle::findFile(const std::string& path) const {
    std::string normalized = normalizeBundlePath(path);
    auto it = files_.find(normalized);
    if (it == files_.end()) {
        return nullptr;
    }
    return &it->second;
}

bool EmbeddedBundle::readFile(const std::string& path, std::vector<uint8_t>& out) const {
    const BundleFileInfo* info = findFile(path);
    if (!info) {
        return false;
    }
    return readFileRange(exePath_, bundleStart_ + info->offset, info->size, out);
}

bool readEmbeddedFile(const std::string& path, std::vector<uint8_t>& out) {
    EmbeddedBundle* bundle = sharedBundle();
    if (!bundle) {
        return false;
    }
    return bundle->readFile(path, out);
}

bool hasEmbeddedBundle() {
    return sharedBundle() != nullptr;
}

std::string getEmbeddedEntryPath() {
    EmbeddedBundle* bundle = sharedBundle();
    if (!bundle) {
        return {};
    }
    return bundle->entryPath();
}

}  // namespace vfs
}  // namespace mystral
