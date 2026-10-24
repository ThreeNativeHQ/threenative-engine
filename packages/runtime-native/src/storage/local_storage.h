/**
 * LocalStorage - File-backed key-value storage
 *
 * Provides a browser-compatible localStorage implementation backed by a JSON
 * file on disk. Each game directory gets a separate storage file, keyed by
 * the current working directory name.
 *
 * Storage paths:
 *   macOS:   ~/Library/Application Support/Mystral/storage/
 *   Linux:   ~/.local/share/mystral/storage/
 *   Windows: %APPDATA%\Mystral\storage\
 *   Android: <app internal files>/mystral/storage/  (app-scoped; the process can write nowhere else)
 */

#pragma once

#include <string>
#include <map>
#include <vector>

namespace mystral {
namespace storage {

class LocalStorage {
public:
    LocalStorage() = default;
    ~LocalStorage();

    /**
     * Initialize storage from a JSON file on disk.
     * Creates directories and file if they don't exist.
     * @param filePath Absolute path to the JSON storage file
     */
    void init(const std::string& filePath);

    /**
     * Get a value by key.
     * @return The value string, or empty string if not found.
     *         Use has() to distinguish missing keys from empty values.
     */
    std::string getItem(const std::string& key) const;

    /**
     * Check if a key exists.
     */
    bool has(const std::string& key) const;

    /**
     * Set a key-value pair in memory. The runtime flushes dirty storage at a host boundary.
     */
    void setItem(const std::string& key, const std::string& value);

    /**
     * Remove a key in memory. The runtime flushes dirty storage at a host boundary.
     */
    void removeItem(const std::string& key);

    /**
     * Remove all keys in memory. The runtime flushes dirty storage at a host boundary.
     */
    void clear();

    /**
     * Get the key at a given index (insertion order).
     * @return The key string, or empty string if index out of range.
     */
    std::string key(int index) const;

    /**
     * Get the number of stored keys.
     */
    int length() const;

    /**
     * Get all keys in insertion order.
     */
    const std::vector<std::string>& keys() const;

    /**
     * Get the platform-specific base storage directory.
     *   macOS:   ~/Library/Application Support/Mystral/storage/
     *   Linux:   ~/.local/share/mystral/storage/
     *   Android: <app internal files>/mystral/storage/
     *   Windows: %APPDATA%\Mystral\storage\
     */
    static std::string getStorageDirectory();

    /**
     * Which platform's convention a storage root follows.
     *
     * Named rather than compiled-in so the resolution can be tested for every platform from any
     * one of them. The Android arm existed only inside an `#ifdef` until PRD-218, which meant the
     * bug it now fixes — an app-unwritable `/data/.local/share/mystral/storage`, reported as
     * initialised — could not be caught by any test that did not run on a phone.
     */
    enum class Platform { Android, Windows, Apple, Posix };

    /**
     * The environment a storage root is derived from. A null field means the platform did not
     * provide that value.
     */
    struct Environment {
        /** Android: the app's internal files directory. The only writable root an app has. */
        const char* androidInternalPath = nullptr;
        /** Windows: `%APPDATA%`. */
        const char* appData = nullptr;
        /** POSIX and Apple: `$HOME`, or the passwd entry when the variable is unset. */
        const char* home = nullptr;
        /** Linux: `$XDG_DATA_HOME`, preferred over `home` when set. */
        const char* xdgDataHome = nullptr;
    };

    /**
     * Resolve the storage root for one platform from one environment. Pure: no getenv, no syscall.
     */
    static std::string resolveStorageDirectory(Platform platform, const Environment& environment);

    /**
     * Derive a safe filename from an identifier string (e.g., cwd stem).
     * Replaces non-alphanumeric characters with underscores.
     */
    static std::string deriveStorageFilename(const std::string& identifier);

    /**
     * Derive a storage filename from a game's entry path.
     *
     * The directory basename alone collides for two games whose folders are both named `game`.
     * The canonical entry path is hashed into the filename instead, so each game and each entry
     * file in one directory owns separate saved progress, while the readable basename stays in
     * front for a human looking at the storage directory.
     */
    static std::string deriveStorageFilenameForEntry(const std::string& entryPath);

    /**
     * Copy a save from the pre-namespacing filename to its identity-derived name, once.
     * Returns true when a migration copy was made. Never overwrites an existing destination.
     */
    static bool migrateStorageFile(const std::string& legacyPath, const std::string& path);

    /**
     * Resolve the save file for a game in `storageDir` and migrate its pre-namespacing save.
     * `entryIdentity` is the game's entry path; empty falls back to the working directory's name.
     * The legacy save was named after the working directory's basename alone.
     */
    static std::string prepareStorageFile(const std::string& storageDir,
                                          const std::string& entryIdentity,
                                          const std::string& workingDirectory);

    /** Flush pending changes at a runtime boundary. Safe to call when storage is clean. */
    void flushIfDirty();

private:
    void load();
    bool flush();

    std::string filePath_;
    std::map<std::string, std::string> data_;
    std::vector<std::string> insertionOrder_;
    bool dirty_ = false;
};

}  // namespace storage
}  // namespace mystral
