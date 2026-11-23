/**
 * PRD-910 AC-2: the Unreal 5.8.3 reference record exists for all eight phases, with its spread
 * over 3 runs. Rebuilt by `pnpm exec tsx tools/unreal-reference/character-dynamics/reference.ts`.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const PHASES = ["settle", "jog", "jogTurn", "sprint", "hardStop", "jump", "snapTurn", "teleport"];
const METRICS = [
  "hemOffset",
  "hemTrail",
  "maxStretch",
  "bodyPenetration",
  // PRD-912 AC-3: the ponytail on stock AnimNode_SpringBone.
  "hairTipOffset",
  "hairStretch",
  "hairInsideHead",
];

// PRD-912 AC-3: the ponytail on stock FAnimNode_AnimDynamics in chain mode, and two named-override arms.
const DYNAMICS_ARMS = ["stock", "swing", "swingWorld"];
const HAIR_METRICS = ["hairTipOffset", "hairStretch", "hairInsideHead"];

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
) as {
  unreal: string;
  runs: number;
  phases: Record<string, Record<string, ISpread>>;
  hairAnimDynamics?: { arm?: Record<string, Record<string, Record<string, ISpread>>> };
};

function expectSpread(spread: ISpread | undefined, label: string) {
  expect(spread, `${label} missing`).toBeDefined();
  const { mean, min, max, runs } = spread as ISpread;
  for (const value of [mean, min, max, ...runs])
    expect(Number.isFinite(value), `${label} non-finite`).toBe(true);
  expect(runs).toHaveLength(3);
  expect(min).toBe(Math.min(...runs));
  expect(max).toBe(Math.max(...runs));
  expect(mean).toBeCloseTo(runs.reduce((a, b) => a + b, 0) / 3, 12);
}

describe("Unreal character-dynamics reference", () => {
  it("names the Unreal version and holds three runs", () => {
    expect(record.unreal).toMatch(/^5\.8\.3/);
    expect(record.runs).toBe(3);
  });

  it.each(PHASES)("%s has every metric as a finite spread over 3 runs", (phase) => {
    const metrics = record.phases[phase];
    expect(metrics, `phase ${phase} missing`).toBeDefined();
    for (const metric of METRICS) expectSpread(metrics?.[metric], `${phase}.${metric}`);
  });

  it.each(DYNAMICS_ARMS)(
    "the AnimDynamics %s arm has every hair metric for every phase as a spread over 3 runs",
    (arm) => {
      const phases = record.hairAnimDynamics?.arm?.[arm];
      expect(phases, `hairAnimDynamics.arm.${arm} missing`).toBeDefined();
      expect(Object.keys(phases ?? {}).sort()).toEqual([...PHASES].sort());
      for (const phase of PHASES)
        for (const metric of HAIR_METRICS)
          expectSpread(phases?.[phase]?.[metric], `${arm}.${phase}.${metric}`);
      // Measured from the tip's spot at the end of settle, as the SpringBone block.
      expect(phases?.settle?.hairTipOffset?.max).toBe(0);
      for (const phase of ["jog", "sprint", "hardStop", "snapTurn"])
        expect(phases?.[phase]?.hairTipOffset?.min, `${arm}.${phase}`).toBeGreaterThan(0.005);
    },
  );

  // A cape at rest that stretches is fighting a collider that overlaps its rest pose (the stock
  // spine_03 capsule held 34 rest vertices and stretched the settled cape 253%).
  it.each(["settle", "teleport"])("%s, a cape at rest, stretches under 20%%", (phase) => {
    expect(record.phases[phase]?.maxStretch?.max).toBeLessThan(0.2);
  });

  // The tip offset is measured from the tip's spot at the end of settle, so settle itself is 0;
  // a ponytail that never leaves that spot in a moving phase is not simulated.
  it("the ponytail rests in settle and swings in the moving phases", () => {
    expect(record.phases.settle?.hairTipOffset?.max).toBe(0);
    for (const phase of ["jog", "sprint", "hardStop", "snapTurn"])
      expect(record.phases[phase]?.hairTipOffset?.min, phase).toBeGreaterThan(0.005);
  });

  it("has no phase the script does not run", () => {
    expect(Object.keys(record.phases).sort()).toEqual([...PHASES].sort());
  });
});
