#include "engine/player/mailbox.h"

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <system_error>

// The PNG writer lives in src/utils/stb_impl.cpp, compiled into tn_host_services.
extern "C" int stbi_write_png(const char* filename, int w, int h, int comp, const void* data, int stride);

namespace tn::engine::player {

namespace {

namespace fs = std::filesystem;

/** Reads a whole file. Empty when it does not exist, is over `limit`, or cannot be read. */
std::string readFile(const std::string& path, std::size_t limit) {
    std::ifstream input(path, std::ios::binary | std::ios::ate);
    if (!input.is_open())
        return {};
    const std::streamoff size = input.tellg();
    if (size < 0 || static_cast<std::size_t>(size) > limit)
        return {};
    std::string payload(static_cast<std::size_t>(size), '\0');
    input.seekg(0);
    input.read(payload.data(), size);
    return payload;
}

/** `.tmp` then rename, so a reader never sees a half-written frame. */
bool writeFile(const std::string& path, const std::string& payload) {
    const std::string temporary = path + ".tmp";
    std::ofstream output(temporary, std::ios::binary | std::ios::trunc);
    if (!output.is_open())
        return false;
    output.write(payload.data(), static_cast<std::streamsize>(payload.size()));
    output.close();
    std::error_code ignored;
    fs::remove(path, ignored);
    fs::rename(temporary, path, ignored);
    return !ignored;
}

}  // namespace

std::string Mailbox::rootFromEnvironment() {
    const char* root = std::getenv("TN_PLAYTEST_MAILBOX_ROOT");
    return root == nullptr ? std::string() : std::string(root);
}

Mailbox::Mailbox(std::string root) {
    if (root.empty())
        return;
    // The runner creates the root, and names its three files exactly as the legacy host does.
    requestPath_ = (fs::path(root) / "tn-playtest-request.json").string();
    responsePath_ = (fs::path(root) / "tn-playtest-response.json").string();
    screenshotRequestPath_ = (fs::path(root) / "tn-playtest-screenshot-request.txt").string();
}

bool Mailbox::announceReady() {
    if (responsePath_.empty() || announced_)
        return false;
    // device.ts answers the handshake with exactly this frame; the runner deletes it again.
    announced_ = writeFile(responsePath_, R"({"id":"ready","result":null})");
    return announced_;
}

bool Mailbox::poll(inspect::Endpoint& endpoint) {
    std::error_code ignored;
    std::string frame = std::move(deferred_);
    deferred_.clear();
    if (frame.empty()) {
        if (requestPath_.empty() || !fs::exists(requestPath_, ignored))
            return false;
        // The request is consumed by deleting it, so the runner's next write is never read twice.
        frame = readFile(requestPath_, inspect::Endpoint::kMaxPayloadBytes);
        fs::remove(requestPath_, ignored);
        if (frame.empty())
            return false;
    }
    // The runner waits for this id's answer before it writes another request, so holding one is safe.
    const std::string response = endpoint.handle(frame);
    if (response.empty()) {
        deferred_ = std::move(frame);
        return false;
    }
    return writeFile(responsePath_, response);
}

bool Mailbox::screenshotRequested() {
    if (screenshotRequestPath_.empty())
        return false;
    if (!screenshotPath_.empty())
        return !answered_;
    std::error_code ignored;
    if (!fs::exists(screenshotRequestPath_, ignored))
        return false;
    // Deleting the request file is the pickup signal the runner watches for (desktop.ts).
    const std::string destination = readFile(screenshotRequestPath_, 4096);
    fs::remove(screenshotRequestPath_, ignored);
    if (destination.empty())
        return false;
    screenshotPath_ = destination;
    answered_ = false;
    return true;
}

bool Mailbox::answerScreenshot(std::span<const uint8_t> frame, uint32_t width, uint32_t height) {
    if (screenshotPath_.empty() || answered_)
        return false;
    const std::size_t expected = static_cast<std::size_t>(width) * height * 4;
    if (frame.size() < expected)
        return false; // the readback is still in flight; answer on the next frame
    if (stbi_write_png(screenshotPath_.c_str(), static_cast<int>(width), static_cast<int>(height), 4, frame.data(),
                       static_cast<int>(width) * 4) == 0)
        std::printf("[Playtest] Native screenshot request failed: %s\n", screenshotPath_.c_str());
    screenshotPath_.clear();
    answered_ = true;
    return true;
}

}  // namespace tn::engine::player