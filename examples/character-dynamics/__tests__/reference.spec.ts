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
const CAPE_METRICS = ["hemOffset", "hemTrail", "maxStretch", "bodyPenetration"];

// PRD-912 AC-3: stock SpringBone chains with named option overrides (rotation, displacement limit).
const SPRING_ARMS = ["rotate", "limitHalf", "limitFull", "rotateLimitHalf", "rotateLimitFull"];

interface ISpread {
  mean: number;
  min: number;
  max: number;
  runs: number[];
}

/** AC-3 perturbation: [unperturbed, perturbed 1, 2, 3], spread = max - min. */
interface IPerturbed {
  unperturbed: number;
  min: number;
  max: number;
  spread: number;
  runs: number[];
}
type PhaseMetrics<T> = Record<string, Record<string, T>>;

const record = JSON.parse(
  readFileSync(
    new URL("../../../tools/unreal-reference/character-dynamics/reference.json", import.meta.url),
    "utf8",
  ),
) as {
  unreal: string;
  runs: number;
  phases: Record<string, Record<string, ISpread>>;
  hairAnimDynamics?: { arm?: Record<string, PhaseMetrics<ISpread>> };
  hairSpringBoneRotate?: { arm?: Record<string, PhaseMetrics<ISpread>> };
  perturbation?: {
    offsetsCm: number[];
    cape: PhaseMetrics<IPerturbed>;
    springBone: PhaseMetrics<IPerturbed>;
    animDynamics: Record<string, PhaseMetrics<IPerturbed>>;
    springBoneRotate: Record<string, PhaseMetrics<IPerturbed>>;
  };
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

function expectPerturbed(cell: IPerturbed | undefined, label: string) {
  expect(cell, `${label} missing`).toBeDefined();
  const { unperturbed, min, max, spread, runs } = cell as IPerturbed;
  for (const value of [unperturbed, min, max, spread, ...runs])
    expect(Number.isFinite(value), `${label} non-finite`).toBe(true);
  expect(runs, `${label} runs`).toHaveLength(4);
  expect(unperturbed).toBe(runs[0]);
  expect(min).toBe(Math.min(...runs));
  expect(max).toBe(Math.max(...runs));
  expect(spread).toBe(max - min);
}

/** Every phase and metric is a perturbed spread, and the unperturbed run is the committed value. */
function expectPerturbedBlock(
  block: PhaseMetrics<IPerturbed> | undefined,
  committed: PhaseMetrics<ISpread> | undefined,
  metrics: string[],
  label: string,
) {
  expect(block, `perturbation.${label} missing`).toBeDefined();
  expect(Object.keys(block ?? {}).sort()).toEqual([...PHASES].sort());
  for (const phase of PHASES)
    for (const metric of metrics) {
      const cell = block?.[phase]?.[metric];
      expectPerturbed(cell, `${label}.${phase}.${metric}`);
      expect(cell?.unperturbed, `${label}.${phase}.${metric} is the committed run`).toBe(
        committed?.[phase]?.[metric]?.runs[0],
      );
    }
}

/** The largest spread over a block: how far the float-level start change moved it. */
function widest(block: PhaseMetrics<IPerturbed> | undefined, metrics: string[]) {
  return Math.max(
    ...PHASES.flatMap((phase) => metrics.map((metric) => block?.[phase]?.[metric]?.spread ?? 0)),
  );
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

  it.each(SPRING_ARMS)(
    "the SpringBone option arm %s has every hair metric for every phase as a spread over 3 runs",
    (arm) => {
      const phases = record.hairSpringBoneRotate?.arm?.[arm];
      expect(phases, `hairSpringBoneRotate.arm.${arm} missing`).toBeDefined();
      expect(Object.keys(phases ?? {}).sort()).toEqual([...PHASES].sort());
      for (const phase of PHASES)
        for (const metric of HAIR_METRICS)
          expectSpread(phases?.[phase]?.[metric], `${arm}.${phase}.${metric}`);
      expect(phases?.settle?.hairTipOffset?.max).toBe(0);
      for (const phase of ["jog", "sprint", "hardStop", "snapTurn"])
        expect(phases?.[phase]?.hairTipOffset?.min, `${arm}.${phase}`).toBeGreaterThan(0.005);
    },
  );

  // AC-3 perturbation spread: the 3-run spread above is 0 because the engines are deterministic. The
  // honest spread is the sensitivity to a float-level change of the start (runs 1-3 start 1e-4, 2e-4
  // and 3e-4 cm off).
  describe("perturbation spread", () => {
    const perturbation = record.perturbation;

    it("names the three offsets", () => {
      expect(perturbation?.offsetsCm).toEqual([1e-4, 2e-4, 3e-4]);
    });

    it("the cape: every cell is [unperturbed, 3 perturbed] and the unperturbed run is the committed one", () => {
      expectPerturbedBlock(perturbation?.cape, record.phases, CAPE_METRICS, "cape");
    });

    it("the SpringBone chain: every cell is [unperturbed, 3 perturbed] and the unperturbed run is the committed one", () => {
      expectPerturbedBlock(perturbation?.springBone, record.phases, HAIR_METRICS, "springBone");
    });

    it.each(DYNAMICS_ARMS)("the AnimDynamics %s arm", (arm) => {
      expectPerturbedBlock(
        perturbation?.animDynamics?.[arm],
        record.hairAnimDynamics?.arm?.[arm],
        HAIR_METRICS,
        `animDynamics.${arm}`,
      );
    });

    it.each(SPRING_ARMS)("the SpringBone option arm %s", (arm) => {
      expectPerturbedBlock(
        perturbation?.springBoneRotate?.[arm],
        record.hairSpringBoneRotate?.arm?.[arm],
        HAIR_METRICS,
        `springBoneRotate.${arm}`,
      );
    });

    // A spread of 0 everywhere would mean the perturbation never reached the simulation.
    it("the perturbed cape runs differ from the unperturbed run", () => {
      expect(widest(perturbation?.cape, CAPE_METRICS)).toBeGreaterThan(0);
      // The late phases are the sensitive ones: the cape is chaotic at the float level.
      expect(perturbation?.cape?.snapTurn?.maxStretch?.spread).toBeGreaterThan(0);
      expect(perturbation?.cape?.jump?.hemTrail?.spread).toBeGreaterThan(0);
    });

    it.each(["swing", "swingWorld"])("the perturbed AnimDynamics %s runs differ", (arm) => {
      expect(widest(perturbation?.animDynamics?.[arm], HAIR_METRICS)).toBeGreaterThan(0);
    });

    it.each(["limitHalf", "limitFull", "rotateLimitHalf", "rotateLimitFull"])(
      "the perturbed SpringBone %s runs differ",
      (arm) => {
        expect(widest(perturbation?.springBoneRotate?.[arm], HAIR_METRICS)).toBeGreaterThan(0);
      },
    );
  });

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
