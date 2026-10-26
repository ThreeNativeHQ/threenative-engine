import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { PNG } from "pngjs";
import { expect, test } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { inspectFrame } from "../src/capture.js";
import { PLAYTEST_PROTOCOL_LIMITS, PLAYTEST_PROTOCOL_VERSION } from "../src/protocol.js";
import { runDevicePlaytest } from "../src/runner/androidRunner.js";
import { runNeedsPixels } from "../src/runner/captureEnvironment.js";
import { preflightDisplay } from "../src/runner/runner-support.js";
import { validatePlaytestScenario } from "../src/scenario.js";
import type { IDevicePlaytestTransport } from "../src/runner/deviceTransport.js";

test("tone qualification uses the built runner for browser callback serialization", async () => {
  const verifier = await readFile(new URL("../../../scripts/verify-tone-exposure.ts", import.meta.url), "utf8");
  expect(verifier).toContain('from "../packages/playtest/dist/runner/index.js"');
  expect(verifier).not.toMatch(/from ["'][^"']*\/src\/runner\//);
});

test("tone fixture supplies a favicon without an unrelated network request", async () => {
  const html = await readFile(new URL("../../../examples/abyss-framework/tone.html", import.meta.url), "utf8");
  expect(html).toMatch(/<link\s+rel="icon"\s+href="data:,"/);
});

const png = new PNG({ width: 256, height: 1 });
for (let value = 0; value < 256; value += 1) png.data.set([value, value, value, 255], value * 4);
const pixels = PNG.sync.write(png);
const darkPng = new PNG({ width: 256, height: 1 });
for (let value = 0; value < 256; value += 1) {
  const shade = Math.round(value / 4);
  darkPng.data.set([shade, shade, shade, 255], value * 4);
}
const darkPixels = PNG.sync.write(darkPng);

async function run(target: "android" | "desktop" | "ios", assert: unknown, screenshots: false | "after" = false, earlyAfter = false) {
  const projectPath = await makeTempDir("tone-runner-");
  await writeFile(join(projectPath, "tone.json"), JSON.stringify({ schemaVersion: 1, name: "tone", assert, artifacts: { screenshots }, steps: earlyAfter ? [{ screenshot: "after", waitTicks: 1 }, { waitTicks: 1 }] : [{ label: "landed", waitTicks: 1 }] }));
  let tick = 0;
  const captured: string[] = [];
  // Only the external transport is substituted; the real runner, decoder, evaluator and
  // artifact writers execute end to end. These fixture pixels are not GPU screenshot proof.
  const transport: IDevicePlaytestTransport = {
    capabilities: ["browser.screenshot", "browser.console", "runtime.diagnostics"],
    start: async () => undefined, close: async () => undefined, waitForBridge: async () => true,
    call: async <T>(method: string, argument?: unknown): Promise<T> => {
      if (method === "describe") return { protocolVersion: PLAYTEST_PROTOCOL_VERSION, capabilities: ["runtime.network", "runtime.fixedStep", "runtime.diagnostics"], limits: PLAYTEST_PROTOCOL_LIMITS, name: "tone-fixture" } as T;
      if (method === "ready") return { ready: true } as T;
      if (method === "advance") { tick += argument as number; return undefined as T; }
      if (method === "sample") return { clock: { mode: "fixed-step", tick }, diagnostics: [], entities: [], resources: {}, network: { requests: 0, entries: [] } } as T;
      throw new Error(`Unexpected transport operation ${method}`);
    },
  };
  const report = await runDevicePlaytest({ projectPath, scenarioPath: "tone.json", artifactDirectory: join(projectPath, "artifacts"), target, url: "http://127.0.0.1:5173", timeoutMs: 1000, trace: false, headless: true, captureArtifactScreenshots: false }, {
    name: target, processName: "tone-fixture", transport,
    mailboxPaths: { request: "request", response: "response" },
    driver: {
      prepare: async () => undefined, stop: async () => undefined, isAlive: async () => true, captureConsole: async () => [],
      screenshot: async (path) => { captured.push(basename(path)); await writeFile(path, earlyAfter && captured.length > 1 ? darkPixels : pixels); },
    },
  });
  return { report, captured, projectPath };
}

test.each(["android", "desktop", "ios"] as const)("%s final tone uses the final pixels when an earlier step is named after", async (target) => {
  const { report, captured, projectPath } = await run(target, { tone: [{ mean: { min: 100 } }] }, false, true);
  expect(captured).toEqual(["after.png", "after.png"]);
  const finalTone = inspectFrame(await readFile(join(projectPath, "artifacts/after.png"))).tone;
  expect(finalTone?.mean).toBe(32);
  expect(report.pass).toBe(false);
  expect(report.assertionResults).toContainEqual(expect.objectContaining({ id: "tone.0.mean", pass: false, details: expect.objectContaining({ observed: finalTone?.mean }) }));
});

test.each(["android", "desktop", "ios"] as const)("%s captures requested tone despite disabled convenience screenshots", async (target) => {
  const { report, captured } = await run(target, { tone: [{ atStep: "landed", mean: { min: 100 } }, { p99: { min: 200 } }] });
  expect(report.pass).toBe(true);
  expect(captured).toEqual(["tone-0.png", "after.png"]);
  expect(report.observations?.tone).toEqual([
    { code: "TN_TONE", label: "tone-0.png", atStep: "landed", ...inspectFrame(pixels).tone },
    { code: "TN_TONE", label: "after.png", ...inspectFrame(pixels).tone },
  ]);
});

test.each(["android", "desktop", "ios"] as const)("%s measures a regional tone assertion at a named step", async (target) => {
  // The device runner kept only the whole-frame tone, so a region at a step stayed unobserved
  // (TN_PLAYTEST_TONE_UNOBSERVED) on the starter's desktop consumer run.
  const region = { x: 128, y: 0, width: 128, height: 1 };
  const { report } = await run(target, { tone: [{ atStep: "landed", region, mean: { min: 150 } }] });
  expect(report.pass).toBe(true);
  expect(report.assertionResults).toContainEqual(expect.objectContaining({ id: "tone.0.mean", pass: true }));
  expect(report.observations?.tone).toContainEqual(expect.objectContaining({ code: "TN_TONE", atStep: "landed", assertionIndex: 0, region }));
});

test("ordinary captures retain tone even without tone assertions", async () => {
  const { report } = await run("desktop", { diagnostics: {} }, "after");
  expect(report.observations?.tone).toEqual([{ code: "TN_TONE", label: "after.png", ...inspectFrame(pixels).tone }]);
});

test("browser tone-only assertions require a pixel lane", () => {
  const scenario = validatePlaytestScenario({ schemaVersion: 1, name: "tone", steps: [{ waitTicks: 1 }], artifacts: { screenshots: false }, assert: { tone: [{ mean: { min: 1 } }] } }, "tone.json");
  const config = { headless: true, captureArtifactScreenshots: false };
  expect(runNeedsPixels(config as never, scenario)).toBe(true);
  expect(preflightDisplay(config as never, scenario, {}, "linux")?.code).toBe("TN_PLAYTEST_HEADLESS_WEBGPU");
});
