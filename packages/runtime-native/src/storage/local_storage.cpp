#include "local_storage.h"

#include <fstream>
#include <sstream>
#include <filesystem>
#include <iostream>
#include <algorithm>
#include <cctype>
#include <cstdint>
#include <cstdio>

#ifdef _WIN32
#include <windows.h>
#include <shlobj.h>
#else
#include <cerrno>
#include <cstring>
#include <fcntl.h>
#include <unistd.h>
#include <pwd.h>
#endif

#ifdef __ANDROID__
#include <SDL3/SDL.h>
#endif

namespace mystral {
namespace storage {

// ============================================================================
// Minimal JSON helpers for flat {string: string} objects
// ============================================================================

static std::string jsonEscape(const std::string& s) {
    std::string out;
    out.reserve(s.size() + 8);
    for (char c : s) {
        switch (c) {
            case '"':  out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\b': out += "\\b";  break;
            case '\f': out += "\\f";  break;
            case '\n': out += "\\n";  break;
            case '\r': out += "\\r";  break;
            case '\t': out += "\\t";  break;
            default:   out += c;      break;
        }
    }
    return out;
}

static std::string jsonUnescape(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (size_t i = 0; i < s.size(); i++) {
        if (s[i] == '\\' && i + 1 < s.size()) {
            i++;
            switch (s[i]) {
                case '"':  out += '"';  break;
                case '\\': out += '\\'; break;
                case 'b':  out += '\b'; break;
                case 'f':  out += '\f'; break;
                case 'n':  out += '\n'; break;
                case 'r':  out += '\r'; break;
                case 't':  out += '\t'; break;
                default:   out += '\\'; out += s[i]; break;
            }
        } else {
            out += s[i];
        }
    }
    return out;
}

// Parse a JSON string token starting after the opening quote.
// Returns the parsed string and advances pos past the closing quote.
static std::string parseJsonString(const std::string& json, size_t& pos) {
    std::string result;
    while (pos < json.size()) {
        char c = json[pos++];
        if (c == '"') {
            return jsonUnescape(result);
        }
        if (c == '\\' && pos < json.size()) {
            result += c;
            result += json[pos++];
        } else {
            result += c;
        }
    }
    return result;  // Unterminated string
}

static void skipWhitespace(const std::string& json, size_t& pos) {
    while (pos < json.size() && std::isspace(static_cast<unsigned char>(json[pos]))) {
        pos++;
    }
}

// Parse a flat JSON object { "key": "value", ... } preserving insertion order.
static bool parseJsonObject(const std::string& json,
                            std::map<std::string, std::string>& data,
                            std::vector<std::string>& order) {
    size_t pos = 0;
    skipWhitespace(json, pos);

    if (pos >= json.size() || json[pos] != '{') return false;
    pos++;  // skip '{'

    skipWhitespace(json, pos);
    if (pos < json.size() && json[pos] == '}') return true;  // empty object

    while (pos < json.size()) {
        skipWhitespace(json, pos);
        if (pos >= json.size() || json[pos] != '"') return false;
        pos++;  // skip opening quote
        std::string key = parseJsonString(json, pos);

        skipWhitespace(json, pos);
        if (pos >= json.size() || json[pos] != ':') return false;
        pos++;  // skip ':'

        skipWhitespace(json, pos);
        if (pos >= json.size() || json[pos] != '"') return false;
        pos++;  // skip opening quote
        std::string value = parseJsonString(json, pos);

        // A repeated key collapses to one entry whose order slot is the first
        // occurrence — matching both JSON object semantics and the JS-side Map
        // the storagePolyfill exposes, so keys().size() always equals length().
        const bool inserted = data.emplace(key, value).second;
        if (!inserted) data[key] = value;  // last duplicate wins
        if (inserted) order.push_back(key);

        skipWhitespace(json, pos);
        if (pos < json.size() && json[pos] == ',') {
            pos++;  // skip ','
        } else if (pos < json.size() && json[pos] == '}') {
            break;
        } else {
            break;  // Malformed, but we got what we could
        }
    }
    return true;
}

static std::string toJson(const std::map<std::string, std::string>& data,
                          const std::vector<std::string>& order) {
    std::string out = "{\n";
    bool first = true;
    for (const auto& key : order) {
        auto it = data.find(key);
        if (it == data.end()) continue;
        if (!first) out += ",\n";
        out += "  \"" + jsonEscape(it->first) + "\": \"" + jsonEscape(it->second) + "\"";
        first = false;
    }
    if (!data.empty()) out += "\n";
    out += "}\n";
    return out;
}

// ============================================================================
// Platform storage directory
// ============================================================================

std::string LocalStorage::resolveStorageDirectory(Platform platform,
                                                  const Environment& environment) {
    switch (platform) {
        case Platform::Android: {
            // Android: the app's own internal files directory, which is the only place the process
            // can write. Android sets no HOME and no XDG_DATA_HOME, so this used to fall through
            // to the POSIX arm below, where `getpwuid()->pw_dir` is the literal string "/data" — a
            // system-owned directory an app cannot create under. Every launch logged
            // `[Storage] Failed to create directory "/data/.local/share/mystral/storage":
            // Permission denied` and then reported localStorage as initialised at a path that did
            // not exist, so a game's saved settings vanished silently between runs. PRD-218.
            //
            // Fail soft, not into the system tree: with no app path the process's own working
            // directory is at least writable, and `init` logs where the file landed.
            const bool usable =
                environment.androidInternalPath != nullptr && environment.androidInternalPath[0] != '\0';
            return (usable ? std::string(environment.androidInternalPath) : std::string(".")) +
                   "/mystral/storage";
        }
        case Platform::Windows: {
            // Windows: %APPDATA%\Mystral\storage
            const bool usable = environment.appData != nullptr && environment.appData[0] != '\0';
            return (usable ? std::string(environment.appData) : std::string(".")) +
                   "\\Mystral\\storage";
        }
        case Platform::Apple: {
            // macOS: ~/Library/Application Support/Mystral/storage
            const char* home = environment.home != nullptr ? environment.home : ".";
            return std::string(home) + "/Library/Application Support/Mystral/storage";
        }
        case Platform::Posix:
        default: {
            // Linux: $XDG_DATA_HOME/mystral/storage, else ~/.local/share/mystral/storage
            if (environment.xdgDataHome != nullptr && environment.xdgDataHome[0] != '\0') {
                return std::string(environment.xdgDataHome) + "/mystral/storage";
            }
            const char* home = environment.home != nullptr ? environment.home : ".";
            return std::string(home) + "/.local/share/mystral/storage";
        }
    }
}

std::string LocalStorage::getStorageDirectory() {
    Environment environment;

#if defined(__ANDROID__)
    // SDL owns this answer because it already holds the Java activity; asking it costs no JNI here
    // and keeps one path for both JavaScript engines.
    environment.androidInternalPath = SDL_GetAndroidInternalStoragePath();
    return resolveStorageDirectory(Platform::Android, environment);
#elif defined(_WIN32)
    char* appdata = nullptr;
    size_t len = 0;
    const bool haveAppData = _dupenv_s(&appdata, &len, "APPDATA") == 0 && appdata;
    environment.appData = haveAppData ? appdata : nullptr;
    const std::string resolved = resolveStorageDirectory(Platform::Windows, environment);
    if (haveAppData) free(appdata);
    return resolved;
#else
    const char* home = getenv("HOME");
    if (!home) {
        struct passwd* pw = getpwuid(getuid());
        home = pw ? pw->pw_dir : ".";
    }
    environment.home = home;
#if defined(__APPLE__)
    return resolveStorageDirectory(Platform::Apple, environment);
#else
    environment.xdgDataHome = getenv("XDG_DATA_HOME");
    return resolveStorageDirectory(Platform::Posix, environment);
#endif
#endif
}

std::string LocalStorage::deriveStorageFilename(const std::string& identifier) {
    std::string safe;
    safe.reserve(identifier.size());
    for (char c : identifier) {
        if (std::isalnum(static_cast<unsigned char>(c)) || c == '-' || c == '_') {
            safe += c;
        } else {
            safe += '_';
        }
    }
    if (safe.empty()) safe = "default";
    return safe + ".json";
}

namespace {

/** FNV-1a 64: stable across compilers and library versions, unlike `std::hash`. */
std::uint64_t stableIdentityHash(const std::string& value) {
    std::uint64_t hash = 1469598103934665603ULL;
    for (unsigned char byte : value) {
        hash ^= byte;
        hash *= 1099511628211ULL;
    }
    return hash;
}

}  // namespace

std::string LocalStorage::deriveStorageFilenameForEntry(const std::string& entryPath) {
    if (entryPath.empty()) return "default.json";
    const std::filesystem::path path(entryPath);
    std::error_code ec;
    const std::filesystem::path canonical = std::filesystem::weakly_canonical(path, ec);
    const std::string identity =
        ec ? path.lexically_normal().string() : canonical.string();
    std::string base = path.stem().string();
    if (base.empty() || base == "." || base == "..") base = path.filename().string();
    if (base.empty() || base == "." || base == "..") base = "default";
    std::string filename = deriveStorageFilename(base);
    filename.resize(filename.size() - 5);  // strip ".json"
    char suffix[17];
    std::snprintf(suffix, sizeof(suffix), "%016llx",
                  static_cast<unsigned long long>(stableIdentityHash(identity)));
    return filename + "-" + suffix + ".json";
}

bool LocalStorage::migrateStorageFile(const std::string& legacyPath, const std::string& path) {
    if (legacyPath == path) return false;
    std::error_code ec;
    if (std::filesystem::exists(path, ec)) return false;
    if (!std::filesystem::exists(legacyPath, ec)) return false;
    std::filesystem::copy_file(legacyPath, path, std::filesystem::copy_options::none, ec);
    return !ec;
}

std::string LocalStorage::prepareStorageFile(const std::string& storageDir,
                                             const std::string& entryIdentity,
                                             const std::string& workingDirectory) {
    const std::string cwdStem = std::filesystem::path(workingDirectory).filename().string();
    const std::string identity = entryIdentity.empty() ? cwdStem : entryIdentity;
    const std::string path = storageDir + "/" + deriveStorageFilenameForEntry(identity);
    // Before namespacing, the save was named after the working directory alone.
    const std::string legacyPath = storageDir + "/" + deriveStorageFilename(cwdStem);
    if (migrateStorageFile(legacyPath, path)) {
        std::cout << "[Mystral] migrated localStorage from " << legacyPath << std::endl;
    }
    return path;
}

// ============================================================================
// LocalStorage implementation
// ============================================================================

LocalStorage::~LocalStorage() {
    flushIfDirty();
}

void LocalStorage::init(const std::string& filePath) {
    flushIfDirty();
    filePath_ = filePath;

    // Create parent directories if they don't exist
    std::filesystem::path p(filePath_);
    auto parentDir = p.parent_path();
    if (!parentDir.empty()) {
        std::error_code ec;
        std::filesystem::create_directories(parentDir, ec);
        if (ec) {
            std::cerr << "[Storage] Failed to create directory " << parentDir << ": " << ec.message() << std::endl;
        }
    }

    load();
}

void LocalStorage::load() {
    data_.clear();
    insertionOrder_.clear();
    dirty_ = false;

    std::ifstream file(filePath_);
    if (!file.is_open()) {
        // File doesn't exist yet - that's fine, start empty
        return;
    }

    std::stringstream ss;
    ss << file.rdbuf();
    std::string content = ss.str();
    file.close();

    if (content.empty()) return;

    if (!parseJsonObject(content, data_, insertionOrder_)) {
        std::cerr << "[Storage] Warning: Failed to parse " << filePath_ << ", starting fresh" << std::endl;
        data_.clear();
        insertionOrder_.clear();
    }

    std::cout << "[Storage] Loaded " << data_.size() << " entries from " << filePath_ << std::endl;
}

bool LocalStorage::flush() {
    if (filePath_.empty()) return false;

    std::string json = toJson(data_, insertionOrder_);

    // Atomic write: write to .tmp then rename
    std::string tmpPath = filePath_ + ".tmp";
    {
        std::ofstream file(tmpPath, std::ios::trunc);
        if (!file.is_open()) {
            std::cerr << "[Storage] Failed to write to " << tmpPath << std::endl;
            std::remove(tmpPath.c_str());
            return false;
        }
        file << json;
        file.flush();
        if (!file) {
            std::cerr << "[Storage] Failed to flush " << tmpPath << std::endl;
            file.close();
            std::remove(tmpPath.c_str());
            return false;
        }
    }

#ifdef _WIN32
    if (!MoveFileExA(tmpPath.c_str(), filePath_.c_str(),
                    MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
        std::cerr << "[Storage] Failed to atomically replace " << filePath_ << std::endl;
        std::remove(tmpPath.c_str());
        return false;
    }
#else
    const int syncFd = ::open(tmpPath.c_str(), O_WRONLY);
    if (syncFd == -1) {
        const int openError = errno;
        std::cerr << "[Storage] Failed to open " << tmpPath
                  << " for synchronization: " << std::strerror(openError) << std::endl;
        std::remove(tmpPath.c_str());
        return false;
    }

    const int syncResult = ::fsync(syncFd);
    const int syncError = syncResult == 0 ? 0 : errno;
    const int closeResult = ::close(syncFd);
    const int closeError = closeResult == 0 ? 0 : errno;
    if (syncResult != 0) {
        std::cerr << "[Storage] Failed to synchronize " << tmpPath
                  << ": " << std::strerror(syncError) << std::endl;
        std::remove(tmpPath.c_str());
        return false;
    }
    if (closeResult != 0) {
        std::cerr << "[Storage] Failed to close " << tmpPath
                  << " after synchronization: " << std::strerror(closeError) << std::endl;
        std::remove(tmpPath.c_str());
        return false;
    }

    std::error_code ec;
    std::filesystem::rename(tmpPath, filePath_, ec);
    if (ec) {
        std::cerr << "[Storage] Failed to rename " << tmpPath << " -> " << filePath_ << ": " << ec.message() << std::endl;
        std::remove(tmpPath.c_str());
        return false;
    }

    const std::filesystem::path parentPath = std::filesystem::path(filePath_).parent_path();
    const std::string directoryPath = parentPath.empty() ? "." : parentPath.string();
    const int directoryFd = ::open(directoryPath.c_str(), O_RDONLY);
    if (directoryFd == -1) {
        const int openError = errno;
        std::cerr << "[Storage] Failed to open containing directory " << directoryPath
                  << " for synchronization: " << std::strerror(openError) << std::endl;
        return false;
    }

    const int directorySyncResult = ::fsync(directoryFd);
    const int directorySyncError = directorySyncResult == 0 ? 0 : errno;
    const int directoryCloseResult = ::close(directoryFd);
    const int directoryCloseError = directoryCloseResult == 0 ? 0 : errno;
    if (directorySyncResult != 0) {
        std::cerr << "[Storage] Failed to synchronize containing directory " << directoryPath
                  << ": " << std::strerror(directorySyncError) << std::endl;
        return false;
    }
    if (directoryCloseResult != 0) {
        std::cerr << "[Storage] Failed to close containing directory " << directoryPath
                  << " after synchronization: " << std::strerror(directoryCloseError) << std::endl;
        return false;
    }
#endif
    return true;
}

void LocalStorage::flushIfDirty() {
    if (dirty_ && flush())
        dirty_ = false;
}

std::string LocalStorage::getItem(const std::string& key) const {
    auto it = data_.find(key);
    if (it != data_.end()) {
        return it->second;
    }
    return "";
}

bool LocalStorage::has(const std::string& key) const {
    return data_.find(key) != data_.end();
}

void LocalStorage::setItem(const std::string& key, const std::string& value) {
    const auto it = data_.find(key);
    if (it == data_.end()) {
        insertionOrder_.push_back(key);
        data_[key] = value;
        dirty_ = true;
    } else if (it->second != value) {
        it->second = value;
        dirty_ = true;
    }
}

void LocalStorage::removeItem(const std::string& key) {
    if (data_.erase(key) > 0) {
        insertionOrder_.erase(
            std::remove(insertionOrder_.begin(), insertionOrder_.end(), key),
            insertionOrder_.end()
        );
        dirty_ = true;
    }
}

void LocalStorage::clear() {
    if (!data_.empty()) {
        data_.clear();
        insertionOrder_.clear();
        dirty_ = true;
    }
}

std::string LocalStorage::key(int index) const {
    if (index >= 0 && index < static_cast<int>(insertionOrder_.size())) {
        return insertionOrder_[index];
    }
    return "";
}

int LocalStorage::length() const {
    return static_cast<int>(data_.size());
}

const std::vector<std::string>& LocalStorage::keys() const {
    return insertionOrder_;
}

}  // namespace storage
}  // namespace mystral
