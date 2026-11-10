// Async image decode completions must follow the lifetime of the Runtime that queued them.
//
// `__decodeImageDataAsync(bytes, callback)` decodes on a worker pool and delivers the result from
// `AsyncImageDecoder::drain()` on the owning thread. The decoder is a process-wide singleton, so a
// completion can outlive the Runtime (and its JavaScript engine) that queued it. This drives the
// real bindings through a headless Runtime:
//   - normal: a decode completes and the callback sees the image size and no error;
//   - teardown: decodes are queued, the Runtime is destroyed before they drain, a second Runtime
//     is created in the same process and polled, and no completion reaches a destroyed engine.
// A crash, a hang or a late callback in the second Runtime fails the run.

#include "mystral/runtime.h"

#include <chrono>
#include <iostream>
#include <memory>
#include <string>
#include <thread>

namespace {

constexpr int kCompletionExitCode = 42;

// A 1x1 RGBA PNG.
constexpr const char* kQueueDecodes = R"JS(
  globalThis.__tnPng = new Uint8Array([
    137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,8,6,0,0,0,31,21,196,137,0,0,0,
    13,73,68,65,84,120,156,99,248,207,192,240,31,0,5,0,1,255,137,153,61,29,0,0,0,0,73,69,78,68,
    174,66,96,130]);
  globalThis.__tnFirstRuntimeCompletions = 0;
  for (let i = 0; i < 8; i++) {
    __decodeImageDataAsync(__tnPng.buffer.slice(0), () => { globalThis.__tnFirstRuntimeCompletions++; });
  }
)JS";

constexpr const char* kNormal = R"JS((() => {
  __decodeImageDataAsync(new Uint8Array([
    137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,8,6,0,0,0,31,21,196,137,0,0,0,
    13,73,68,65,84,120,156,99,248,207,192,240,31,0,5,0,1,255,137,153,61,29,0,0,0,0,73,69,78,68,
    174,66,96,130]).buffer, (image, error) => {
      process.exit(error === null && image.width === 1 && image.height === 1 ? 42 : 1);
    });
})())JS";

bool pump(mystral::Runtime& runtime, int exitCode, int seconds) {
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(seconds);
    while (runtime.pollEvents()) {
        if (runtime.getExitCode() == exitCode) return true;
        if (std::chrono::steady_clock::now() >= deadline) return false;
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    return runtime.getExitCode() == exitCode;
}

std::unique_ptr<mystral::Runtime> headless() {
    mystral::RuntimeConfig config;
    config.width = 1;
    config.height = 1;
    config.noSdl = true;
    return mystral::Runtime::create(config);
}

}  // namespace

int main() {
    {
        auto runtime = headless();
        if (!runtime || !runtime->evalScript(kNormal, "image_decode_normal.js")) {
            std::cerr << "could not start the normal decode probe\n";
            return 1;
        }
        if (!pump(*runtime, kCompletionExitCode, 10)) {
            std::cerr << "async image decode never delivered its completion\n";
            return 1;
        }
    }
    for (int round = 0; round < 5; round++) {
        {
            auto first = headless();
            if (!first || !first->evalScript(kQueueDecodes, "image_decode_queue.js")) {
                std::cerr << "could not queue decodes\n";
                return 1;
            }
            // Destroyed here with decodes in flight or completed-but-undelivered.
        }
        auto second = headless();
        if (!second || !second->evalScript("setTimeout(() => process.exit(42), 50);",
                                           "image_decode_second.js")) {
            std::cerr << "could not start the second runtime\n";
            return 1;
        }
        if (!pump(*second, kCompletionExitCode, 10)) {
            std::cerr << "second runtime did not finish after the first was destroyed\n";
            return 1;
        }
    }
    std::cout << "native image decode teardown contract passed\n";
    return 0;
}
