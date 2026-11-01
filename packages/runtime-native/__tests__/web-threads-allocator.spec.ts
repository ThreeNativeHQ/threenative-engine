/**
 * The threaded web engine links mimalloc. Emscripten's default dlmalloc takes one global lock, and the job pool's
 * workers allocate while the main thread does. In a fair uncapped stress-lab window (FB1, 2026-10-30) mimalloc cut
 * the CPU frame p50 from 14.75 to 13.76 ms and from 14.65 to 13.73 ms, both pairs.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const cmake = readFileSync(new URL("../cmake/NativeEngineCore.cmake", import.meta.url), "utf8");

describe("threaded web engine allocator", () => {
  it("links mimalloc on the threads target", () => {
    const threads = cmake.match(
      /OUTPUT_NAME tn-native-engine-web-threads\)([\s\S]*?)\n\s*else\(\)/,
    );
    expect(threads?.[1]).toMatch(
      /target_link_options\(tn-native-engine-web PRIVATE [^)]*-sMALLOC=mimalloc/,
    );
  });
});
