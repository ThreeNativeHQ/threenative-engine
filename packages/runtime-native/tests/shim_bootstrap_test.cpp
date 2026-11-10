// Runtime::create must install every JavaScript shim the host ships, in an order that lets the
// later ones use the earlier ones. This boots a headless Runtime and probes the resulting globals
// from game JavaScript, so a shim that is renamed, dropped from the bootstrap or evaluated in the
// wrong order fails here. Source text is never read.
//
// shim -> probe: fetch-polyfill (fetch, Headers, Request, Response, AbortController, TextEncoder),
// streams-polyfill (ReadableStream, WritableStream, TransformStream), url-worker-polyfill (URL,
// URLSearchParams, Worker), event-constructors-setup (Event, KeyboardEvent, PointerEvent),
// storage-polyfill (localStorage, sessionStorage), create-element-setup (a canvas element),
// scheduler-yield (scheduler.yield, reachable as self.scheduler).
// The host also exposes the playtest mailbox (`__THREENATIVE_NATIVE__.playtest`), whose `network`
// is the fetch shim's observation reader.
//
// `--callback-retention` stores a JavaScript callback in each host registry that keeps one beyond
// the native call that received it (setTimeout, setInterval, document event listeners), churns the heap so V8 collects, and expects every callback to run with its captured
// state intact. A registry that kept a borrowed local handle would read a freed object here.
//
// `--worker-rollback` sets THREENATIVE_NATIVE_WORKER_ROLLBACK=1 before boot and expects `Worker`
// to refuse with NotSupportedError and TN_NATIVE_WORKER_ROLLBACK_ACTIVE.

#include "mystral/runtime.h"

#include <chrono>
#include <cstdlib>
#include <iostream>
#include <string>
#include <thread>

namespace {

constexpr int kCompletionExitCode = 42;

constexpr const char* kScript = R"JS((() => {
  const missing = [];
  const need = (name) => { if (typeof globalThis[name] !== "function") missing.push(name); };
  [
    "fetch", "Headers", "Request", "Response", "AbortController", "TextEncoder", "TextDecoder",
    "ReadableStream", "WritableStream", "TransformStream",
    "URL", "URLSearchParams", "Worker",
    "Event", "KeyboardEvent", "PointerEvent",
  ].forEach(need);
  for (const name of ["localStorage", "sessionStorage"]) {
    const storage = globalThis[name];
    if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function") {
      missing.push(name);
    }
  }
  const canvas = typeof document === "object" ? document.createElement("canvas") : null;
  if (!canvas || String(canvas.tagName).toLowerCase() !== "canvas" || typeof canvas.toDataURL !== "function") {
    missing.push("document.createElement(canvas)");
  }
  // scheduler-yield: three probes `self.scheduler`, so both names must reach one object.
  if (typeof globalThis.scheduler !== "object" || typeof scheduler.yield !== "function" ||
      globalThis.self.scheduler !== scheduler) {
    missing.push("scheduler.yield");
  }
  const mailbox = globalThis.__THREENATIVE_NATIVE__ && __THREENATIVE_NATIVE__.playtest;
  if (!mailbox || mailbox.network !== fetch.network ||
      typeof mailbox.receive !== "function" || typeof mailbox.respond !== "function") {
    missing.push("__THREENATIVE_NATIVE__.playtest");
  }
  if (missing.length === 0) {
    // The shims must also work together: Request reads a URL, Event carries its type.
    const request = new Request("https://example.test/a?b=1");
    if (new URL(request.url).searchParams.get("b") !== "1") missing.push("Request+URL");
    if (new KeyboardEvent("keydown", { key: "a" }).key !== "a") missing.push("KeyboardEvent.key");
  }
  if (missing.length > 0) console.log("missing shims: " + missing.join(", "));
  process.exit(missing.length === 0 ? 42 : 1);
})())JS";

constexpr const char* kRollbackScript = R"JS((() => {
  let observed = null;
  try {
    new Worker(URL.createObjectURL(new Blob(["postMessage(1);"])));
  } catch (error) {
    observed = error;
  }
  const refused = globalThis.__tnNativeWorkerRollbackActive === true && observed !== null &&
    observed.name === "NotSupportedError" &&
    String(observed.message).includes("TN_NATIVE_WORKER_ROLLBACK_ACTIVE");
  if (!refused) console.log("worker rollback not refused: " + (observed && observed.message));
  process.exit(refused ? 42 : 1);
})())JS";

constexpr const char* kRetentionScript = R"JS((() => {
  const seen = { timeout: 0, interval: 0, listener: 0 };
  const token = () => ({ payload: new Array(64).fill(7) });
  const intact = (t) => t.payload.length === 64 && t.payload.every((v) => v === 7);
  let broken = false;
  const check = (t) => { if (!intact(t)) broken = true; };

  const timeoutToken = token();
  setTimeout(() => { check(timeoutToken); seen.timeout += 1; }, 2);
  const intervalToken = token();
  const intervalId = setInterval(() => {
    check(intervalToken);
    seen.interval += 1;
    if (seen.interval === 2) clearInterval(intervalId);
  }, 1);
  const listenerToken = token();
  document.addEventListener("tnRetention", () => { check(listenerToken); seen.listener += 1; });

  // Churn the heap so every scavenge and mark-compact has run before the callbacks fire.
  let sink = [];
  for (let round = 0; round < 40; round++) {
    sink = [];
    for (let i = 0; i < 20000; i++) sink.push({ i, text: "garbage" + i });
  }
  document.dispatchEvent(new Event("tnRetention"));

  const finish = () => {
    const done = seen.timeout === 1 && seen.interval === 2 && seen.listener === 1;
    if (!done || broken) console.log("callback retention failed: " + JSON.stringify(seen) + " broken=" + broken);
    process.exit(done && !broken ? 42 : 1);
  };
  setTimeout(finish, 300);
})())JS";

}  // namespace

int main(int argc, char** argv) {
    const bool rollback = argc > 1 && std::string(argv[1]) == "--worker-rollback";
    const bool retention = argc > 1 && std::string(argv[1]) == "--callback-retention";
    // MSVC has no setenv; the runtime reads this variable on both platforms, so it is set the way
    // player/v8_main.cpp sets TN_PLAYER_WIDTH.
    if (rollback) {
#if defined(_WIN32)
        _putenv_s("THREENATIVE_NATIVE_WORKER_ROLLBACK", "1");
#else
        setenv("THREENATIVE_NATIVE_WORKER_ROLLBACK", "1", 1);
#endif
    }

    mystral::RuntimeConfig config;
    config.width = 1;
    config.height = 1;
    config.noSdl = true;

    auto runtime = mystral::Runtime::create(config);
    if (!runtime) {
        std::cerr << "could not create headless native runtime\n";
        return 1;
    }
    if (!runtime->evalScript(rollback ? kRollbackScript : retention ? kRetentionScript : kScript, "shim_bootstrap_test.js")) {
        std::cerr << "could not run the shim probe\n";
        return 1;
    }

    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (runtime->pollEvents()) {
        if (runtime->getExitCode() != 0) break;
        if (std::chrono::steady_clock::now() >= deadline) break;
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }

    if (runtime->getExitCode() != kCompletionExitCode) {
        std::cerr << "native shim bootstrap contract failed with exit " << runtime->getExitCode()
                  << '\n';
        return 1;
    }
    std::cout << (rollback    ? "native worker rollback contract passed\n"
                  : retention ? "native callback retention contract passed\n"
                              : "native shim bootstrap contract passed\n");
    return 0;
}
