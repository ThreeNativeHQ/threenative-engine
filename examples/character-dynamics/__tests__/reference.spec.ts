/**
 * PRD-910 AC-2: the Unreal 5.8.3 reference record exists for all eight phases, with its spread
 * over 3 runs. Rebuilt by `pnpm exec tsx tools/unreal-reference/character-dynamics/reference.ts`.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const PHASES = ["settle", "jog", "jogTurn", "sprint", "hardStop", "jump", "snapTurn", "teleport"];
const METRICS = ["hemOffset", "hemTrail", "maxStretch", "bodyPenetration"];

interface ISpread {
  mean: number;
  min: number;
  max: number;
  runs: number[];
}

const record = JSON.parse(
  readFileSync(
    new URL("../../../tools/unreal-reference/character-dynamics/reference.json", import.meta.url),
    "utf8",
  ),
) as { unreal: string; runs: number; phases: Record<string, Record<string, ISpread>> };

describe("Unreal character-dynamics reference", () => {
  it("names the Unreal version and holds three runs", () => {
    expect(record.unreal).toMatch(/^5\.8\.3/);
    expect(record.runs).toBe(3);
  });

  it.each(PHASES)("%s has every metric as a finite spread over 3 runs", (phase) => {
    const metrics = record.phases[phase];
    expect(metrics, `phase ${phase} missing`).toBeDefined();
    for (const metric of METRICS) {
      const spread = metrics?.[metric];
      expect(spread, `${phase}.${metric} missing`).toBeDefined();
      const { mean, min, max, runs } = spread as ISpread;
      for (const value of [mean, min, max, ...runs])
        expect(Number.isFinite(value), `${phase}.${metric} non-finite`).toBe(true);
      expect(runs).toHaveLength(3);
      expect(min).toBe(Math.min(...runs));
      expect(max).toBe(Math.max(...runs));
      expect(mean).toBeCloseTo(runs.reduce((a, b) => a + b, 0) / 3, 12);
    }
  });

  // A cape at rest that stretches is fighting a collider that overlaps its rest pose (the stock
  // spine_03 capsule held 34 rest vertices and stretched the settled cape 253%).
  it.each(["settle", "teleport"])("%s, a cape at rest, stretches under 20%%", (phase) => {
    expect(record.phases[phase]?.maxStretch?.max).toBeLessThan(0.2);
  });

  it("has no phase the script does not run", () => {
    expect(Object.keys(record.phases).sort()).toEqual([...PHASES].sort());
  });
});
