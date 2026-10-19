import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterEach, expect, test, vi } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { inspectFrame } from "../src/capture.js";
import { evaluateRichPlaytestAssertions } from "../src/assertion-evaluators.js";
import { main } from "../src/runner/cli.js";
import { validatePlaytestScenario } from "../src/scenario.js";
import type { IPlaytestReport } from "../src/report.js";

const metrics = { mean: 127.5, p1: 2, p50: 127, p99: 253, clipFraction: 1 / 256, blackFraction: 1 / 256 };
const bounds = { mean: { min: 60, max: 140 }, p99: { min: 150 }, p1: { max: 40 }, clipFraction: { max: 0.005 }, blackFraction: { max: 0.25 } };
function scenario(tone: unknown) {
  return validatePlaytestScenario({ name: "tone", schemaVersion: 1, steps: [{ label: "landed", waitTicks: 1 }], assert: { tone } }, "tone.json");
}
function evaluate(tone: unknown, observed: unknown) {
  return evaluateRichPlaytestAssertions({ scenario: scenario(tone), report: { observations: { console: [], hud: {}, network: [], resources: {}, tone: observed } } as unknown as IPlaytestReport });
}
afterEach(() => { vi.restoreAllMocks(); process.exitCode = undefined; });

test("tone bounds load in the assertion dictionary and validate named steps", () => {
  expect(scenario([{ atStep: "landed", ...bounds }]).assert?.tone).toEqual([{ atStep: "landed", ...bounds }]);
  expect(() => scenario([{ atStep: "typo", mean: { min: 1 } }])).toThrow("names step label 'typo'");
});

test.each([
  [[], "at least one"], [[{}], "at least one metric bound"], [[{ atStep: "landed" }], "at least one metric bound"],
  [[{ mean: {} }], "min or max"], [[{ mean: { min: "60" } }], "assert.tone[0].mean.min"],
  [[{ mean: { min: Number.NaN } }], "assert.tone[0].mean.min"], [[{ mean: { max: Number.POSITIVE_INFINITY } }], "assert.tone[0].mean.max"],
  [[{ mean: { min: -1 } }], "assert.tone[0].mean.min"], [[{ p99: { max: 256 } }], "assert.tone[0].p99.max"],
  [[{ clipFraction: { max: 1.1 } }], "assert.tone[0].clipFraction.max"], [[{ blackFraction: { min: -0.1 } }], "assert.tone[0].blackFraction.min"],
  [[{ mean: { min: 10, max: 9 } }], "min must not exceed max"], [[{ mean: { maximum: 90 } }], "maximum"],
  [[{ mean: null }], "mean"], [[{ atStep: 0, mean: { min: 1 } }], "atStep"], [{ mean: { min: 1 } }, "array"],
])("malformed tone bounds fail at load: %j", (input, message) => { expect(() => scenario(input)).toThrow(message); });

test.each([undefined, [], [null], [{ code: "TN_TONE", label: "after.png", ...metrics }]])("missing named capture fails closed: %j", (observed) => {
  const result = evaluate([{ atStep: "landed", ...bounds }], observed);
  expect(result.assertions).toContainEqual(expect.objectContaining({ id: "tone.0.observed", pass: false }));
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "TN_PLAYTEST_TONE_UNOBSERVED", message: expect.stringContaining("landed") }));
});

test("every inclusive bound is evaluated and failures name measured and required values", () => {
  const frame = { code: "TN_TONE", label: "landed.png", atStep: "landed", ...metrics };
  const result = evaluate([{ atStep: "landed", ...bounds }], [frame]);
  expect(result.assertions.filter(({ id }) => id.startsWith("tone."))).toHaveLength(5);
  expect(result.assertions.every(({ pass }) => pass)).toBe(true);
  const dark = evaluate([{ atStep: "landed", ...bounds }], [{ ...frame, mean: 31.875, p99: 63 }]);
  expect(dark.assertions.find(({ id }) => id === "tone.0.mean")?.pass).toBe(false);
  expect(dark.assertions.find(({ id }) => id === "tone.0.p99")?.pass).toBe(false);
  expect(dark.diagnostics.map(({ message }) => message).join(" ")).toMatch(/31\.875.*60/);
  expect(dark.diagnostics.map(({ message }) => message).join(" ")).toMatch(/63.*150/);
});

test("invalid metrics cannot satisfy even an unrelated bound", () => {
  const result = evaluate([{ mean: { min: 0 } }], [{ code: "TN_TONE", label: "after.png", ...metrics, p99: Number.NaN }]);
  expect(result.assertions.find(({ id }) => id === "tone.0.observed")?.pass).toBe(false);
});

test("CLI and assertions use identical six numbers, with an unweighted frame average", async () => {
  const directory = await makeTempDir("tone-cli-");
  const ramp = new PNG({ width: 256, height: 1 });
  for (let i = 0; i < 256; i += 1) ramp.data.set([i, i, i, 255], i * 4);
  const black = new PNG({ width: 1, height: 1 }); black.data.set([0, 0, 0, 255]);
  const path = join(directory, "ramp.png"); const darkPath = join(directory, "black.png");
  await writeFile(path, PNG.sync.write(ramp)); await writeFile(darkPath, PNG.sync.write(black));
  const output: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((text) => { output.push(String(text)); return true; });
  expect(await main(["tone", path, darkPath])).toBe(0);
  const rows = output.join("").trim().split("\n").map((line) => line.split("\t"));
  expect(rows[0]).toEqual(["frame", "mean", "p1", "p50", "p99", "clip%", "black%"]);
  expect(rows[1]).toEqual([path, "127.50", "2.00", "127.00", "253.00", "0.39", "0.39"]);
  expect(rows[3]).toEqual(["average", "63.75", "1.00", "63.50", "126.50", "0.20", "50.20"]);
  const tone = inspectFrame(await readFile(path)).tone!;
  const result = evaluate([Object.fromEntries(Object.entries(tone).map(([key, value]) => [key, { min: value, max: value }]))], [{ code: "TN_TONE", label: "after.png", ...tone }]);
  expect(result.assertions.filter(({ id }) => id.startsWith("tone.")).map(({ details }) => details?.observed)).toEqual(Object.values(tone));
  expect(result.assertions.every(({ pass }) => pass)).toBe(true);
});

test.each([[], ["--typo"], ["does-not-exist.png"]])("CLI refuses invalid inputs %j", async (...args) => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true); vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  expect(await main(["tone", ...args])).toBe(2);
});

test("tone-only scenarios stay out of the frame-less template lane", async () => {
  const root = await makeTempDir("tone-classifier-"); await mkdir(join(root, "playtests"));
  await writeFile(join(root, "playtests/tone.playtest.json"), JSON.stringify({ assert: { tone: [{ mean: { min: 1 } }] }, artifacts: { screenshots: false } }));
  await writeFile(join(root, "playtests/state.playtest.json"), JSON.stringify({ assert: { diagnostics: {} }, artifacts: { screenshots: false } }));
  const result = spawnSync(process.execPath, ["scripts/non-visual-scenarios.mjs", root], { encoding: "utf8" });
  expect(result.status).toBe(0); expect(result.stdout.trim()).toBe("playtests/state.playtest.json"); expect(result.stderr).toContain("tone.playtest.json");
});


test("the real-render exposure scenario loads named and final frame bounds", async () => {
  const source = JSON.parse(await readFile("examples/abyss-framework/playtests/tone.playtest.json", "utf8"));
  const loaded = validatePlaytestScenario(source, "tone.playtest.json");
  expect(loaded.assert?.tone).toHaveLength(2);
  expect(loaded.assert?.tone?.[0]?.atStep).toBe("rendered");
  expect(loaded.assert?.tone?.[0]?.mean?.min).toBeGreaterThan(0);
});
