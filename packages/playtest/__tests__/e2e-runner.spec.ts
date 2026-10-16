import { makeTempDir } from "../../../test-support/temp-dir.js";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";

import { exitCodeForReport } from "../src/runner/cli.js";
import { yawPitchToQuaternion } from "../src/scenario/orientation.js";
import { runStandalonePlaytest } from "../src/runner/runner.js";
import type { IStandalonePlaytestReport } from "../src/runner/runner.js";

// End-to-end verdict tests. Every other suite in this package checks a part in
// isolation; these drive the real runner against a real browser and assert the
// only thing a playtest harness is actually trusted for: `pass` is true when the
// application works and false when it does not.
//
// The distinction that matters here is a false NEGATIVE — reporting pass on an
// app that is broken, or on a run where nothing was ever observed. A harness
// that cannot fail is worse than no harness, because CI treats it as evidence.

const fixtureDirectory = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

let server: Server;
let origin: string;
let fixtureHtml: string;

beforeAll(async () => {
  fixtureHtml = await readFile(join(fixtureDirectory, "app.html"), "utf8");
  server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(fixtureHtml);
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Fixture server has no port.");
  origin = `http://127.0.0.1:${address.port}`;
});

async function unusedPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((ready) => probe.listen(0, "127.0.0.1", ready));
  const address = probe.address();
  if (address === null || typeof address === "string") throw new Error("Port probe has no port.");
  await new Promise<void>((closed) => probe.close(() => closed()));
  return address.port;
}

afterAll(async () => {
  await new Promise<void>((closed) => server.close(() => closed()));
});

async function run(
  mode: string,
  assert: unknown,
  managedServer?: { command: string; cwd: string; timeoutMs: number },
  steps: Array<Record<string, unknown>> = [
    { holdFrames: 30, press: "KeyW", release: true },
  ],
): Promise<IStandalonePlaytestReport> {
  const projectPath = await makeTempDir("playtest-e2e-");
  await writeFile(
    join(projectPath, "scenario.json"),
    JSON.stringify({
      artifacts: { screenshots: false },
      assert,
      name: `e2e-${mode}`,
      schemaVersion: 1,
      steps,
      subject: "player",
      target: "web",
      viewport: { height: 360, width: 640 },
      warmupFrames: 2,
    }),
  );
  return runStandalonePlaytest({
    artifactDirectory: join(projectPath, "artifacts"),
    headless: true,
    projectPath,
    scenarioPath: "scenario.json",
    timeoutMs: 15_000,
    trace: false,
    url: `${origin}/?mode=${mode}`,
    ...(managedServer === undefined ? {} : { server: managedServer }),
  });
}

test("labelled physics samples reach settled assertion evaluation", async () => {
  const report = await run(
    "physics",
    { settled: [{ atStep: "settled", entity: "player", minBodies: 1 }] },
    undefined,
    [{ label: "settled", release: true, waitTicks: 2 }],
  );

  expect(report.assertionResults).toContainEqual(
    expect.objectContaining({ id: "settled.player", pass: true }),
  );
  expect(report.observations?.physicsDebugSeries?.map(({ label }) => label)).toEqual(["settled"]);
  expect(report.pass).toBe(true);
}, 60_000);

test("legacy frame aliases advance a fixed-step bridge", async () => {
  const report = await run(
    "physics",
    { diagnostics: { noRuntimeDiagnostics: true } },
    undefined,
    [{ holdFrames: 8, press: "KeyW", release: true }],
  );

  expect(report.pass).toBe(true);
  const beforeTick = report.before?.tick;
  const afterTick = report.after?.tick;
  if (beforeTick === undefined || afterTick === undefined) {
    throw new Error("Fixed-step hold report did not include before/after bridge ticks.");
  }
  expect(afterTick - beforeTick).toBe(8);
}, 60_000);

test("legacy wait frame alias advances a fixed-step bridge", async () => {
  const report = await run(
    "physics",
    { diagnostics: { noRuntimeDiagnostics: true } },
    undefined,
    [{ waitFrames: 8, release: true }],
  );

  expect(report.pass).toBe(true);
  const beforeTick = report.before?.tick;
  const afterTick = report.after?.tick;
  if (beforeTick === undefined || afterTick === undefined) {
    throw new Error("Fixed-step wait report did not include before/after bridge ticks.");
  }
  expect(afterTick - beforeTick).toBe(8);
}, 60_000);

const MOVES = { movement: { entity: "player", minDistance: 0.5 } };

test("true negative: a working application passes and reports the distance it measured", async () => {
  const report = await run("good", MOVES);

  expect(report.pass).toBe(true);
  expect(report.distance).toBeGreaterThan(0.5);
  expect(report.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
  expect(report.assertionResults?.map(({ id, pass }) => ({ id, pass }))).toEqual([
    { id: "diagnostics", pass: true },
    { id: "movement.distance", pass: true },
  ]);
}, 60_000);

test("true positive: an application that ignores input fails with a movement diagnostic", async () => {
  const report = await run("broken", MOVES);

  expect(report.pass).toBe(false);
  expect(report.distance).toBe(0);
  expect(report.assertionResults?.find(({ id }) => id === "movement.distance")?.pass).toBe(false);
  expect(report.diagnostics.map(({ code }) => code)).toContain("TN_PLAYTEST_MOVEMENT_ASSERTION_FAILED");
}, 60_000);

test("true positive: movement without input is not accepted as a working control scheme", async () => {
  // `drift` moves on its own, so a minDistance assertion alone would pass it. The
  // maxDistance bound is what separates "responded to input" from "was already
  // moving", and it must fire.
  const report = await run("drift", { movement: { entity: "player", maxDistance: 0.2 } });

  expect(report.pass).toBe(false);
  expect(report.assertionResults?.find(({ id }) => id === "movement.maxDistance")?.pass).toBe(false);
}, 60_000);

test("true positive: a bridge that returns no observations fails instead of passing vacuously", async () => {
  // The worst failure mode: the run completes, the browser is green, and nothing
  // was ever measured. `distance` defaults to 0 and the verdict must follow it.
  const report = await run("silent-drop", MOVES);

  expect(report.pass).toBe(false);
  expect(report.before).toBeUndefined();
  expect(report.after).toBeUndefined();
}, 60_000);

test("true positive: a scenario that asserts nothing does not report pass", async () => {
  // The application here is the working one. The run still has to fail: `pass` is
  // computed with `.every()`, which is true over an empty list, so an empty verdict
  // would be indistinguishable in CI from a fully verified feature.
  const report = await run("good", {});

  expect(report.pass).toBe(false);
  expect(report.assertionResults).toEqual([
    {
      details: {
        consoleErrors: 0,
        networkErrors: 0,
        policy: { noConsoleErrors: true, noNetworkErrors: true, noRuntimeDiagnostics: true },
        runtimeDiagnostics: 0,
      },
      id: "diagnostics",
      pass: true,
    },
    { details: { reason: "no-evaluated-assertions" }, id: "scenario.assertions", pass: false },
  ]);
  expect(report.diagnostics.map(({ code }) => code)).toContain("TN_PLAYTEST_SCENARIO_NO_ASSERTIONS");
}, 60_000);

test("true positive: a missing bridge fails the run rather than skipping the assertion", async () => {
  const report = await run("no-bridge", MOVES);

  expect(report.pass).toBe(false);
  expect(report.diagnostics.map(({ code }) => code)).toContain("TN_PLAYTEST_BRIDGE_MISSING");
}, 60_000);

test("a page that throws while booting names the throw beside the missing bridge", async () => {
  // A throw at module scope stops the game before it installs its bridge. The run used to end on a
  // bare bridge-missing (or a 30 s `describe` timeout) while the cause sat in the collected page errors.
  const report = await run("no-bridge-error", MOVES);

  const missing = report.diagnostics.find(({ code }) => code === "TN_PLAYTEST_BRIDGE_MISSING");
  expect(report.pass).toBe(false);
  expect(missing?.message).toContain("transport-only-boom");
}, 60_000);

test("managed server mode rejects an already occupied URL", async () => {
  const report = await run("good", MOVES, {
    command: `${JSON.stringify(process.execPath)} -e "process.exit(9)"`,
    cwd: fixtureDirectory,
    timeoutMs: 1_000,
  });

  expect(report.pass).toBe(false);
  expect(report.diagnostics).toContainEqual(
    expect.objectContaining({ code: "TN_PLAYTEST_SERVER_FAILED" }),
  );
  expect(report.diagnostics[0]?.message).toContain("already in use");
}, 60_000);

test("managed server teardown releases the URL before the next run", async () => {
  const projectPath = await makeTempDir("playtest-managed-server-");
  const port = await unusedPort();
  const scenario = {
    artifacts: { screenshots: false },
    assert: MOVES,
    name: "managed-server-restart",
    schemaVersion: 1,
    steps: [{ holdFrames: 30, press: "KeyW", release: true }],
    subject: "player",
    target: "web",
    viewport: { height: 360, width: 640 },
    warmupFrames: 2,
  };
  await writeFile(join(projectPath, "scenario.json"), JSON.stringify(scenario));
  await writeFile(
    join(projectPath, "server.mjs"),
    `import { createServer } from "node:http";
import { readFileSync } from "node:fs";
const html = readFileSync(new URL("./app.html", import.meta.url));
createServer((_request, response) => response.end(html)).listen(${port}, "127.0.0.1");\n`,
  );
  const runManaged = () =>
    runStandalonePlaytest({
      artifactDirectory: join(projectPath, "artifacts"),
      headless: true,
      projectPath,
      scenarioPath: "scenario.json",
      server: { command: `${JSON.stringify(process.execPath)} server.mjs`, cwd: projectPath, timeoutMs: 5_000 },
      timeoutMs: 15_000,
      trace: false,
      url: `http://127.0.0.1:${port}/?mode=good`,
    });
  await writeFile(join(projectPath, "app.html"), fixtureHtml.replace("</body>", '<script>console.log("managed-instance-1")</script></body>'));
  expect((await runManaged()).pass).toBe(true);
  await writeFile(join(projectPath, "app.html"), fixtureHtml.replace("</body>", '<script>console.log("managed-instance-2")</script></body>'));

  const second = await runManaged();

  expect(second.pass).toBe(true);
  expect(second.observations?.console.map(({ text }) => text)).toContain("managed-instance-2");
}, 60_000);

test("transport-only browser errors reach runtime diagnostics without a bridge", async () => {
  const report = await run("no-bridge-error", {
    diagnostics: {
      noConsoleErrors: false,
      consoleErrorsOptOutReason: "This test isolates the transport page error from the console policy.",
      noRuntimeDiagnostics: true,
    },
  });

  expect(report.assertionResults, JSON.stringify(report.diagnostics)).toContainEqual({
    details: {
      consoleErrors: 1,
      networkErrors: 0,
      policy: {
        consoleErrorsOptOutReason: "This test isolates the transport page error from the console policy.",
        noConsoleErrors: false,
        noNetworkErrors: true,
        noRuntimeDiagnostics: true,
      },
      runtimeDiagnostics: 1,
    },
    id: "diagnostics",
    pass: false,
  });
  expect(report.diagnostics.map(({ code }) => code)).toContain("TN_PLAYTEST_RUNTIME_DIAGNOSTIC");
  expect(report.diagnostics.map(({ code }) => code)).not.toContain("TN_PLAYTEST_BRIDGE_MISSING");
  expect(exitCodeForReport(report)).toBe(1);
}, 60_000);

test("true positive: a bridge that reports itself unready fails with its own reason", async () => {
  const report = await run("not-ready", MOVES);

  expect(report.pass).toBe(false);
  expect(report.diagnostics.map(({ code }) => code)).toContain("TN_PLAYTEST_BRIDGE_NOT_READY");
  expect(report.diagnostics[0]?.message).toMatch(/scene still loading/u);
}, 60_000);

test("true positive: an incompatible protocol version fails instead of being interpreted", async () => {
  const report = await run("wrong-protocol", MOVES);

  expect(report.pass).toBe(false);
  expect(report.diagnostics.map(({ code }) => code)).toContain("TN_PLAYTEST_BRIDGE_INCOMPATIBLE");
}, 60_000);

test("browser args reach the launched chromium", async () => {
  // A WebGPU target needs --enable-unsafe-webgpu to start at all, and there was no
  // way to reach chromium.launch from the config. Asserted through a flag with an
  // observable effect, since WebGPU itself is unavailable in this environment.
  const projectPath = await makeTempDir("playtest-e2e-args-");
  await writeFile(
    join(projectPath, "scenario.json"),
    JSON.stringify({
      artifacts: { screenshots: false },
      assert: MOVES,
      name: "e2e-args",
      schemaVersion: 1,
      steps: [{ holdFrames: 30, press: "KeyW", release: true }],
      subject: "player",
      target: "web",
      viewport: { height: 360, width: 640 },
      warmupFrames: 2,
    }),
  );

  const report = await runStandalonePlaytest({
    artifactDirectory: join(projectPath, "artifacts"),
    browserArgs: ["--user-agent=playtest-arg-probe"],
    headless: true,
    projectPath,
    scenarioPath: "scenario.json",
    timeoutMs: 15_000,
    trace: false,
    url: `${origin}/?mode=good&report=ua`,
  });

  // The fixture echoes its user agent; only the launch flag can set it.
  expect(report.observations?.console.map(({ text }) => text)).toContain("playtest-ua:playtest-arg-probe");
  expect(report.pass).toBe(true);
}, 60_000);

test("normalized pointer coordinates reach the declared viewport position", async () => {
  const projectPath = await makeTempDir("playtest-e2e-pointer-");
  await writeFile(
    join(projectPath, "scenario.json"),
    JSON.stringify({
      artifacts: { screenshots: false },
      assert: { movement: { entity: "player", maxDistance: 0.2 } },
      name: "e2e-pointer",
      schemaVersion: 1,
      steps: [{ kind: "input", pointerPosition: { x: 0.7, y: 0.5 }, waitFrames: 1, release: true }],
      subject: "player",
      target: "web",
      viewport: { height: 360, width: 640 },
      warmupFrames: 2,
    }),
  );

  const report = await runStandalonePlaytest({
    artifactDirectory: join(projectPath, "artifacts"),
    headless: true,
    projectPath,
    scenarioPath: "scenario.json",
    timeoutMs: 15_000,
    trace: false,
    url: `${origin}/?mode=good`,
  });

  expect(report.pass).toBe(true);
  expect(report.observations?.console.map(({ text }) => text)).toContain("playtest-pointer:448,180");
}, 60_000);

test("setup positions the entity before the run so movement is measured from it", async () => {
  const projectPath = await makeTempDir("playtest-e2e-setup-");
  await writeFile(
    join(projectPath, "scenario.json"),
    JSON.stringify({
      artifacts: { screenshots: false },
      assert: MOVES,
      name: "e2e-setup",
      schemaVersion: 1,
      setup: { entities: [{ entity: "player", position: [0, 0, 10] }] },
      steps: [{ holdFrames: 30, press: "KeyW", release: true }],
      subject: "player",
      target: "web",
      viewport: { height: 360, width: 640 },
      warmupFrames: 2,
    }),
  );

  const report = await runStandalonePlaytest({
    artifactDirectory: join(projectPath, "artifacts"),
    headless: true,
    projectPath,
    scenarioPath: "scenario.json",
    timeoutMs: 15_000,
    trace: false,
    url: `${origin}/?mode=good`,
  });

  expect(report.before?.position[2]).toBeGreaterThanOrEqual(10);
  expect(report.pass).toBe(true);
}, 60_000);

test("setup.spawn and aim, then an aimAt step, steer the subject over the wire", async () => {
  const projectPath = await makeTempDir("playtest-e2e-spawn-aim-");
  await writeFile(
    join(projectPath, "scenario.json"),
    JSON.stringify({
      artifacts: { screenshots: false },
      assert: { diagnostics: { runtimeReady: true } },
      name: "e2e-spawn-aim",
      schemaVersion: 1,
      setup: {
        aim: { pitch: 0, yaw: Math.PI / 2 },
        spawn: { x: 3, z: 7 },
      },
      // Frames, not ticks. The fixture page advertises `runtime.fixedStep` only in physics mode,
      // so these steps had no fixed step to count and were quietly waiting on display refresh —
      // the substitution steps.ts now refuses.
      steps: [
        { kind: "aimAt", label: "aim-northwest", target: { x: -5, z: 0 }, waitFrames: 2 },
        { release: true, waitFrames: 1 },
      ],
      subject: "player",
      target: "web",
      viewport: { height: 360, width: 640 },
      warmupFrames: 2,
    }),
  );

  const report = await runStandalonePlaytest({
    artifactDirectory: join(projectPath, "artifacts"),
    headless: true,
    projectPath,
    scenarioPath: "scenario.json",
    timeoutMs: 15_000,
    trace: false,
    url: `${origin}/?mode=good`,
  });

  expect(report.pass).toBe(true);
  expect(report.setup?.requested.map(({ kind }) => kind)).toEqual(["spawn", "aim"]);
  // The spawn applied before the first sample; the absent y preserved the game's own height.
  expect(report.before?.position).toEqual([3, 0, 7]);
  // The aimAt step aimed at (-5, 0) from the spawned (3, 7), computed from the sampled position.
  expect(report.after?.rotation).toEqual(yawPitchToQuaternion(Math.atan2(8, 7), 0));
}, 60_000);

test("a placement the game cannot resolve fails with a named setup diagnostic", async () => {
  const projectPath = await makeTempDir("playtest-e2e-setup-miss-");
  await writeFile(
    join(projectPath, "scenario.json"),
    JSON.stringify({
      artifacts: { screenshots: false },
      assert: { diagnostics: { runtimeReady: true } },
      name: "e2e-setup-miss",
      schemaVersion: 1,
      setup: {
        place: [{ at: { x: 1, y: 0, z: 1 }, entity: "sentry", facing: { yaw: 0 }, frozen: true }],
      },
      steps: [{ release: true, waitTicks: 1 }],
      subject: "player",
      target: "web",
      viewport: { height: 360, width: 640 },
      warmupFrames: 2,
    }),
  );

  const report = await runStandalonePlaytest({
    artifactDirectory: join(projectPath, "artifacts"),
    headless: true,
    projectPath,
    scenarioPath: "scenario.json",
    timeoutMs: 15_000,
    trace: false,
    url: `${origin}/?mode=good`,
  });

  expect(report.pass).toBe(false);
  const diagnostic = report.diagnostics.find(({ code }) => code === "TN_PLAYTEST_SETUP_UNAPPLIED");
  expect(diagnostic?.message).toContain("sentry");
  expect(report.setup?.applied).toEqual([]);
  expect(report.setup?.requested).toHaveLength(1);
}, 60_000);
