/**
 * The threaded web engine links dlmalloc. mimalloc (FB1, 2026-10-30) cut the CPU frame p50 by 4% to 7% on the stress
 * lab, but over emmalloc it did not reuse freed multi-MB blocks: one Strata world peaked at 2.6-2.9 GB of the 4 GB
 * heap, and the desert switch then froze the page or crashed it (2026-11-05). dlmalloc holds forest, coastal, alpine
 * and desert in one page at 1.3 GB.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const cmake = readFileSync(new URL("../cmake/NativeEngineCore.cmake", import.meta.url), "utf8");

describe("threaded web engine allocator", () => {
  it("links dlmalloc on the threads target", () => {
    const threads = cmake.match(
      /OUTPUT_NAME tn-native-engine-web-threads\)([\s\S]*?)\n\s*else\(\)/,
    );
    expect(threads?.[1]).toMatch(
      /target_link_options\(tn-native-engine-web PRIVATE [^)]*-sMALLOC=dlmalloc/,
    );
  });
});
