import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

import { makeTempDirSync } from "../../test-support/temp-dir.js";
import { MEAN_FLOOR, TILE_FLOOR, compareRuns } from "../midway-bench/parity.js";

// The cockpit and takeoff frames of real Midway runs at 320x180: legacy (three.js) twice, the native
// engine with every cockpit material merged into one (the uuid bug), and the fixed native engine.
const FIXTURES = path.join(import.meta.dirname, "fixtures", "midway-bench");
const run = (name: string) => path.join(FIXTURES, name);
const FRAMES = { takeoff: "takeoff.png.png", cockpit: "cockpit.png.png" };
const legacy = [run("legacy-a"), run("legacy-b")];

describe("Midway frame parity", () => {
  it("passes the fixed native run: takeoff and cockpit match legacy", () => {
    const report = compareRuns(run("fixed-native"), legacy, FRAMES);
    expect(report.pass).toBe(true);
    for (const frame of Object.values(report.frames)) {
      expect(frame.nativeWorstTile).toBeGreaterThanOrEqual(TILE_FLOOR);
      expect(Math.min(...frame.nativeMeanSsim)).toBeGreaterThanOrEqual(MEAN_FLOOR);
    }
  });

  it("flags the broken native cockpit and still passes its takeoff", () => {
    const report = compareRuns(run("broken-native"), legacy, FRAMES);
    expect(report.pass).toBe(false);
    expect(report.frames.takeoff?.pass).toBe(true);
    expect(report.frames.cockpit?.pass).toBe(false);
    expect(report.frames.cockpit?.nativeWorstTile).toBeLessThan(TILE_FLOOR);
  });

  it("fails closed: one legacy run, a missing frame, a size mismatch and an unstable reference", () => {
    expect(() => compareRuns(run("fixed-native"), [run("legacy-a")], FRAMES)).toThrow(
      "TN_MIDWAY_PARITY_REFERENCES",
    );
    const missing = compareRuns(run("fixed-native"), legacy, { after: "after.png" });
    expect(missing.pass).toBe(false);
    expect(missing.frames.after?.error).toContain("TN_MIDWAY_PARITY_MISSING");

    const png = (width: number, height: number, shade: (x: number, y: number) => number) => {
      const image = new PNG({ width, height });
      for (let y = 0; y < height; y += 1)
        for (let x = 0; x < width; x += 1) {
          const at = (y * width + x) * 4;
          image.data.fill(shade(x, y), at, at + 3);
          image.data[at + 3] = 255;
        }
      return PNG.sync.write(image);
    };
    const make = (name: string, bytes: Buffer) => {
      const dir = path.join(makeTempDirSync("midway-parity-"), name);
      return { dir, write: () => writeFileSync(path.join(dir, "frame.png"), bytes) };
    };
    const stripes = (x: number, y: number) => (((x >> 2) + (y >> 2)) % 2 === 0 ? 40 : 220);
    const base = png(64, 64, stripes);
    const runs = [
      make("a", base),
      make(
        "b",
        png(64, 64, (x, y) => 255 - stripes(x, y)),
      ),
      make("n", png(32, 32, stripes)),
    ];
    for (const r of runs) {
      mkdirSync(r.dir, { recursive: true });
      r.write();
    }
    const [a, b, n] = runs.map((r) => r.dir) as [string, string, string];
    // A native frame of another size is -1, never a pass.
    expect(compareRuns(n, [a, a], { f: "frame.png" }).frames.f?.pass).toBe(false);
    // Two legacy runs that disagree make the reference itself the failure, even for a perfect copy.
    const unstable = compareRuns(a, [a, b], { f: "frame.png" });
    expect(unstable.frames.f?.legacySpreadWorstTile[0]).toBeLessThan(TILE_FLOOR);
    expect(unstable.pass).toBe(false);
  });
});
