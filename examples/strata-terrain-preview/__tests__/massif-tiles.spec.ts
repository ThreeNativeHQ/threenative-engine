import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { liftMassif } from "@threenative/terrain";
import { describe, expect, it } from "vitest";

// PRD-866 Phase 1: whole surveyed mountains, foot to foot, at 4 m. A real mountain's edge is not a
// flat plain (the PRD's first bar, a perimeter 90th percentile under 80 m, fails on every probed
// peak: valleys climb to cols), so the bar is the relief that stands above the perimeter membrane
// `liftMassif` removes, with the summit well inside the tile.
describe.each(["longs", "teton", "maroon"])("massif tile %s", (name) => {
  const meta = JSON.parse(
    readFileSync(new URL(`../scripts/dem/massif-${name}.json`, import.meta.url), "utf8"),
  ) as {
    resolution: number;
    size: number;
    spacing: number;
    elevationOffset: number;
    sha256: string;
  };
  const bytes = readFileSync(new URL(`../scripts/dem/massif-${name}.bin`, import.meta.url));
  const raw = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  const heights = Float32Array.from(raw, (dm) => meta.elevationOffset + dm / 10);
  const n = meta.resolution;

  it("is the cut its metadata names, at 4 m or finer over 3 km or more", () => {
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(meta.sha256);
    expect(raw.length).toBe(n * n);
    expect(meta.spacing).toBeLessThanOrEqual(4);
    expect(meta.size).toBeGreaterThanOrEqual(3000);
    expect(raw.reduce((max, dm) => Math.max(max, dm), 0) / 10).toBeGreaterThanOrEqual(700);
  });

  it("holds the whole mountain: 600 m or more above its perimeter, the summit inside", () => {
    const lifted = liftMassif({ id: name, size: meta.size, resolution: n, heights });
    let summit = 0;
    for (let i = 1; i < lifted.length; i++)
      if ((lifted[i] as number) > (lifted[summit] as number)) summit = i;
    expect(lifted[summit]).toBeGreaterThanOrEqual(600);
    const row = Math.floor(summit / n) / (n - 1);
    const column = (summit % n) / (n - 1);
    expect(Math.max(Math.abs(row - 0.5), Math.abs(column - 0.5))).toBeLessThan(0.25);
    for (let i = 0; i < n; i++)
      for (const at of [i, (n - 1) * n + i, i * n, i * n + n - 1])
        expect(Math.abs(lifted[at] as number)).toBeLessThan(0.01);
  });
});
