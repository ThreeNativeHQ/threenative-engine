/**
 * The waste counters' own mechanism: one increment per counted call, a window that sums `kReportFrames`
 * drawn frames, and a line that resets what it printed (PRD #574 lane "waste").
 *
 * Compiled and run with the host C++ compiler rather than the engine test binary: the header is
 * deliberately dependency-free, so this proves the arithmetic and the line without a Dawn/V8 build.
 * What this cannot prove is a call site being wired; the shooter's `TN_WASTE:` line does that
 * (counters.md, lane scratch).
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const SOURCE = `
#include "engine/foundation/waste_counters.h"

#include <cstdio>

int main() {
    using namespace tn::engine::waste;
    for (uint32_t i = 0; i < kReportFrames - 1; ++i) {
        ++counters().shareCalls;
        frame();
    }
    std::printf("before=%llu\\n", static_cast<unsigned long long>(counters().shareCalls));
    ++counters().shareCalls;
    ++counters().shareHits;
    ++counters().contentClassCalls;
    ++counters().bufferAllocs;
    frame();
    std::printf("after=%llu\\n", static_cast<unsigned long long>(counters().shareCalls));
    return 0;
}
`;

/** Compiles and runs the snippet above; its stdout lines, in order. */
function run(): string[] {
    const dir = mkdtempSync(path.join(tmpdir(), "tn-waste-"));
    const source = path.join(dir, "counter.cpp");
    const binary = path.join(dir, "counter");
    writeFileSync(source, SOURCE);
    execFileSync(process.env.CXX ?? "c++", [
      "-std=c++20",
      "-I",
      path.join(ROOT, "src"),
      "-o",
      binary,
      source,
    ]);
    return execFileSync(binary, { encoding: "utf8" }).trim().split("\n");
}

describe("engine waste counters", () => {
  it("sums a window and resets it, printing the frames it summed", () => {
    const lines = run();
    expect(lines[0]).toBe(`before=${299}`);
    const line = lines.find((entry) => entry.startsWith("TN_WASTE:"));
    expect(line).toBeDefined();
    // The frame that closed the window is the one the printed line belongs to.
    const window = JSON.parse((line as string).slice("TN_WASTE:".length)) as Record<string, number>;
    expect(window).toEqual({
      frames: 300,
      contentClassOf: 1,
      contentVersionKeys: 0,
      classify: 0,
      share: 300,
      shareHits: 1,
      shareMints: 0,
      buffers: 1,
      textures: 0,
    });
    expect(lines.at(-1)).toBe("after=0");
  });
});
