import { describe, expect, it } from "vitest";
import { parseHeadersFile } from "../load-bench.js";

describe("load-bench _headers parser", () => {
  it("applies every matching rule's headers, with * matching any run", () => {
    const rules = parseHeadersFile(
      "/*\n  Cross-Origin-Opener-Policy: same-origin\n/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n",
    );
    const matched = (path: string) =>
      rules.filter((rule) => rule.pattern.test(path)).flatMap((rule) => rule.headers);
    expect(matched("/assets/index-abc.js")).toEqual([
      ["Cross-Origin-Opener-Policy", "same-origin"],
      ["Cache-Control", "public, max-age=31536000, immutable"],
    ]);
    expect(matched("/index.html")).toEqual([["Cross-Origin-Opener-Policy", "same-origin"]]);
  });

  it("fails on a header line with no path line above it", () => {
    expect(() => parseHeadersFile("  Cache-Control: no-cache\n")).toThrow("TN_LOAD_BENCH_HEADERS");
  });
});
