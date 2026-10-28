/**
 * The waste counters' own mechanism: one relaxed increment per counted call into a running total that
 * prints nothing, laid out so the web back end can read its low word in place (PRD #574 lane "waste").
 *
 * Compiled and run with the host C++ compiler rather than the engine test binary: the header is
 * deliberately dependency-free, so this proves the arithmetic and the line without a Dawn/V8 build.
 * What this cannot prove is a call site being wired; the engine-cost playtest row does that.
 */

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { makeTempDirSync } from "../../../test-support/temp-dir.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const SOURCE = `
#include "engine/foundation/waste_counters.h"

#include <cstdio>
#include <cstring>

int main() {
    using namespace tn::engine::waste;
    for (int i = 0; i < 300; ++i) count(counters().shareCalls);
    count(counters().shareHits);
    count(counters().contentClassCalls);
    count(counters().bufferAllocs);
    // The web back end reads each counter's low word in place, as little-endian bytes.
    uint32_t low = 0;
    std::memcpy(&low, &counters().shareCalls, sizeof low);
    std::printf("share=%llu low=%u hits=%llu classOf=%llu buffers=%llu textures=%llu\\n",
                static_cast<unsigned long long>(counters().shareCalls.load()), low,
                static_cast<unsigned long long>(counters().shareHits.load()),
                static_cast<unsigned long long>(counters().contentClassCalls.load()),
                static_cast<unsigned long long>(counters().bufferAllocs.load()),
                static_cast<unsigned long long>(counters().textureAllocs.load()));
    return 0;
}
`;

/** Compiles and runs the snippet above; its stdout lines, in order. */
function run(): string[] {
  const dir = makeTempDirSync("tn-waste-");
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
  it("keeps running totals that print nothing and read in place", () => {
    // A total, not a window: core differences two reads per frame (TN_FRAME_BUDGET.counters.engine).
    expect(run()).toEqual(["share=300 low=300 hits=1 classOf=1 buffers=1 textures=0"]);
  });
});
