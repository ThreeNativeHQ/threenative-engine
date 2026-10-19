import { PNG } from "pngjs";
import { expect, test } from "vitest";
import { inspectFrame, collectRegionalTone } from "../src/capture.js";
import { validatePlaytestScenario } from "../src/scenario.js";
import { evaluateRichPlaytestAssertions } from "../src/assertion-evaluators.js";
import type { IPlaytestReport } from "../src/report.js";
const left = { x: 0, y: 0, width: 2, height: 2 };
const right = { x: 2, y: 0, width: 2, height: 2 };
function png() {
  const image = new PNG({ width: 4, height: 2 });
  for (let y = 0; y < 2; y++)
    for (let x = 0; x < 4; x++) {
      const v = x < 2 ? 40 : 200;
      image.data.set([v, v, v, x === 0 && y === 0 ? 0 : 255], (y * 4 + x) * 4);
    }
  return PNG.sync.write(image);
}
function scenario(tone: unknown) {
  return validatePlaytestScenario(
    {
      name: "regions",
      schemaVersion: 1,
      steps: [{ label: "landed", waitTicks: 1 }],
      assert: { tone },
    },
    "regions.json",
  );
}
function evaluate(tone: unknown, observed: unknown) {
  return evaluateRichPlaytestAssertions({
    scenario: scenario(tone),
    report: {
      observations: { console: [], hud: {}, network: [], resources: {}, tone: observed },
    } as unknown as IPlaytestReport,
  });
}
test("physical regions use exact pixels and exclude transparent pixels", () => {
  const assertions = scenario([
    { region: left, mean: { min: 40, max: 40 } },
    { region: right, p99: { min: 200 } },
  ]).assert!.tone!;
  const rows = collectRegionalTone(png(), assertions, "after.png");
  expect(rows.map((r) => r.mean)).toEqual([40, 200]);
  expect(rows[0]).toMatchObject({ assertionIndex: 0, region: left, p99: 40 });
  expect(evaluate(assertions, rows).assertions.every((r) => r.pass)).toBe(true);
});
test.each([
  { ...left, x: -1 },
  { ...left, x: 0.5 },
  { ...left, width: 0 },
  { ...left, height: Number.MAX_SAFE_INTEGER + 1 },
  { ...left, y: "0" },
  { ...left, extra: 1 },
])("rejects malformed region %j", (region) => {
  expect(() => scenario([{ region, mean: { min: 1 } }])).toThrow();
});
test.each([
  { region: right, metric: "typo", minDelta: 1 },
  { region: right, metric: "p99", minDelta: Number.POSITIVE_INFINITY },
  { region: right, metric: "p99", minDelta: 256 },
])("rejects malformed compare %j", (compare) => {
  expect(() => scenario([{ region: left, compare }])).toThrow();
});
test("out-of-bounds and transparent regions fail without substituting whole-frame metrics", () => {
  const assertions = scenario([
    { region: { ...left, x: 4 }, mean: { min: 0 } },
    { region: { x: 0, y: 0, width: 1, height: 1 }, mean: { min: 0 } },
  ]).assert!.tone!;
  const rows = collectRegionalTone(png(), assertions, "after.png");
  expect(rows.every((r) => r.error)).toBe(true);
  expect(
    evaluate(assertions, rows)
      .assertions.filter((r) => r.id.startsWith("tone."))
      .every((r) => !r.pass),
  ).toBe(true);
});
test("same capture comparison uses primary minus reference and mutation fails", () => {
  const assertions = scenario([
    { region: right, compare: { region: left, metric: "p99", minDelta: 160 } },
  ]).assert!.tone!;
  const rows = collectRegionalTone(png(), assertions, "after.png");
  expect(rows[0]!.reference).toMatchObject({ region: left, metrics: { p99: 40 } });
  expect(evaluate(assertions, rows).assertions.every((r) => r.pass)).toBe(true);
  expect(
    evaluate(
      [{ region: right, compare: { region: left, metric: "p99", minDelta: 161 } }],
      rows,
    ).assertions.some((r) => !r.pass),
  ).toBe(true);
});
test("step selection, assertion identity, and absent native regions fail closed", () => {
  const assertions = scenario([{ atStep: "landed", region: right, p99: { min: 200 } }]).assert!
    .tone!;
  expect(collectRegionalTone(png(), assertions, "after.png")).toEqual([]);
  const rows = collectRegionalTone(png(), assertions, "step.png", "landed");
  expect(evaluate(assertions, rows).assertions.every((r) => r.pass)).toBe(true);
  expect(
    evaluate(
      assertions,
      rows.map((r) => ({ ...r, assertionIndex: 1 })),
    ).assertions.some((r) => !r.pass),
  ).toBe(true);
  expect(
    evaluate(assertions, [
      { code: "TN_TONE", label: "step.png", atStep: "landed", ...inspectFrame(png()).tone },
    ]).assertions.some((r) => !r.pass),
  ).toBe(true);
});
test("legacy whole-frame evaluation ignores later regional rows", () => {
  const whole = { code: "TN_TONE", label: "after.png", ...inspectFrame(png()).tone };
  const rows = collectRegionalTone(
    png(),
    scenario([{ region: left, mean: { min: 0 } }]).assert!.tone!,
    "after.png",
  );
  expect(
    evaluate([{ mean: { min: whole.mean!, max: whole.mean! } }], [whole, ...rows]).assertions.every(
      (r) => r.pass,
    ),
  ).toBe(true);
  expect(
    collectRegionalTone(png(), scenario([{ mean: { min: 0 } }]).assert!.tone!, "after.png"),
  ).toEqual([]);
});

test("comparison requires a primary region and a complete reference", () => {
  expect(() => scenario([{ compare: { region: left, metric: "mean", minDelta: 1 } }])).toThrow(
    "requires region",
  );
  expect(() => scenario([{ region: right, compare: { region: left, metric: "mean" } }])).toThrow(
    "minDelta",
  );
  const assertions = scenario([
    { region: right, compare: { region: left, metric: "mean", minDelta: 1 } },
  ]).assert!.tone!;
  const rows = collectRegionalTone(png(), assertions, "after.png");
  expect(
    evaluate(
      assertions,
      rows.map((r) => ({ ...r, reference: undefined })),
    ).assertions.some((r) => !r.pass),
  ).toBe(true);
  expect(
    evaluate(
      assertions,
      rows.map((r) => ({ ...r, reference: { region: right, metrics: r.reference!.metrics } })),
    ).assertions.some((r) => !r.pass),
  ).toBe(true);
});
test("a translucent pixel counts once, with no alpha weighting or implicit mask", () => {
  const image = new PNG({ width: 2, height: 1 });
  image.data.set([0, 0, 0, 1, 255, 255, 255, 255]);
  const assertions = scenario([
    {
      region: { x: 0, y: 0, width: 2, height: 1 },
      mean: { min: 127.5, max: 127.5 },
      blackFraction: { min: 0.5 },
      clipFraction: { min: 0.5 },
    },
  ]).assert!.tone!;
  const rows = collectRegionalTone(PNG.sync.write(image), assertions, "after.png");
  expect(evaluate(assertions, rows).assertions.every((r) => r.pass)).toBe(true);
});

test("known quadrants preserve top-left physical coordinates", () => {
  const image = new PNG({ width: 4, height: 4 });
  for (let y = 0; y < 4; y++)
    for (let x = 0; x < 4; x++) {
      const v = (y < 2 ? 0 : 100) + (x < 2 ? 20 : 60);
      image.data.set([v, v, v, 255], (y * 4 + x) * 4);
    }
  const regions = [
    { x: 0, y: 0, width: 2, height: 2 },
    { x: 2, y: 0, width: 2, height: 2 },
    { x: 0, y: 2, width: 2, height: 2 },
    { x: 2, y: 2, width: 2, height: 2 },
  ];
  const assertions = scenario(regions.map((region) => ({ region, mean: { min: 0 } }))).assert!
    .tone!;
  expect(
    collectRegionalTone(PNG.sync.write(image), assertions, "after.png").map((row) => row.mean),
  ).toEqual([20, 60, 120, 160]);
});
test("an out-of-bounds reference fails rather than comparing against zero", () => {
  const assertions = scenario([
    { region: right, compare: { region: { ...left, y: 2 }, metric: "p99", minDelta: 1 } },
  ]).assert!.tone!;
  const rows = collectRegionalTone(png(), assertions, "after.png");
  expect(rows[0]!.reference?.error).toBeDefined();
  expect(
    evaluate(assertions, rows).assertions.find((row) => row.id === "tone.0.observed")?.pass,
  ).toBe(false);
});

test.each(["primary", "reference"])(
  "null %s region observation fails closed without throwing",
  (part) => {
    const assertions = scenario([
      { region: right, compare: { region: left, metric: "p99", minDelta: 1 } },
    ]).assert!.tone!;
    const rows = collectRegionalTone(png(), assertions, "after.png");
    const malformed = rows.map((row) =>
      part === "primary"
        ? { ...row, region: null }
        : { ...row, reference: { ...row.reference, region: null } },
    );
    expect(() => evaluate(assertions, malformed)).not.toThrow();
    expect(
      evaluate(assertions, malformed).assertions.find((row) => row.id === "tone.0.observed")?.pass,
    ).toBe(false);
  },
);
test("regional named step after cannot collide with terminal after.png", () => {
  const loaded = validatePlaytestScenario(
    {
      name: "collision",
      schemaVersion: 1,
      steps: [{ label: "after", waitTicks: 1 }],
      assert: {
        tone: [
          { atStep: "after", region: right, p99: { min: 200 } },
          { region: left, p99: { max: 40 } },
        ],
      },
    },
    "collision.json",
  );
  const rows = [
    ...collectRegionalTone(png(), loaded.assert!.tone!, "after.png", "after"),
    ...collectRegionalTone(png(), loaded.assert!.tone!, "after.png"),
  ];
  const result = evaluateRichPlaytestAssertions({
    scenario: loaded,
    report: {
      observations: { console: [], hud: {}, network: [], resources: {}, tone: rows },
    } as unknown as IPlaytestReport,
  });
  expect(result.assertions.every((row) => row.pass)).toBe(true);
});

test("legacy exported tone observation keeps required numeric metrics", () => {
  const legacy: import("../src/tone.js").IPlaytestToneObservation = {
    code: "TN_TONE",
    label: "after.png",
    mean: 1,
    p1: 1,
    p50: 1,
    p99: 1,
    clipFraction: 0,
    blackFraction: 0,
  };
  expect(legacy.mean.toFixed(2)).toBe("1.00");
  // @ts-expect-error A whole-frame observation must still supply every metric.
  const missing: import("../src/tone.js").IPlaytestToneObservation = {
    code: "TN_TONE",
    label: "after.png",
  };
  void missing;
});
