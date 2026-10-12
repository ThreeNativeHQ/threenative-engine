import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { loadPlaytestScenario } from "../../packages/playtest/src/scenario.js";
import { makeTempDir } from "../../test-support/temp-dir.js";

const project = "examples/prd476-fluid-particles";
test("measures predictor displacement independently of final velocity without consuming the baseline", async () => {
  const scenario = await loadPlaytestScenario(project, "playtests/fluid-collision.playtest.json");
  expect(scenario.warmupFrames).toBe(0);
  expect(scenario.assert?.resources).toContainEqual({
    id: "FluidCollision",
    path: "diagonalDistance",
    gte: 0.29999,
    lte: 0.30001,
  });
  expect(scenario.assert?.resources).toContainEqual({
    id: "FluidCollision",
    path: "diagonalDirectionPassed",
    equals: 1,
  });
  const fixture = await readFile(`${project}/src/collision-proof.ts`, "utf8");
  expect(fixture).toContain("diagonalDistance: 0");
  expect(fixture).toContain("diagonalDirectionPassed: 0");
});

import { PNG } from "pngjs";
import { requiredPlaytestCapabilities } from "../../packages/playtest/src/assertion-schema.js";
import { PLAYTEST_PROTOCOL_LIMITS } from "../../packages/playtest/src/protocol.js";
import {
  ANDROID_TRANSPORT_CAPABILITIES,
  type IBridgeTransport,
  connectPlaytestBridgeTransport,
} from "../../packages/playtest/src/runner/index.js";
import { validatePlaytestScenario } from "../../packages/playtest/src/scenario.js";
import {
  assertNativeFluidCapture,
  assertNativeFluidPixels,
  assertNativeFluidResponses,
  nativeFluidFailureDetails,
  nativeFluidScenario,
} from "../verify-fluid-collision-native.js";

function report() {
  return {
    pass: true,
    runtime: "native",
    target: "desktop",
    diagnostics: [],
    assertionResults: [{ id: "resource.FluidCollision.collisionPassed", pass: true }],
    observations: {
      runtimeDiagnosticsBefore: { recentRuntimeErrors: [] },
      runtimeDiagnostics: { recentRuntimeErrors: [] },
      console: [],
      hud: {},
      network: [],
      resources: {
        FluidCollision: {
          before: { measuredSteps: 0, totalSteps: 1 },
          after: { measuredSteps: 1, totalSteps: 2, gateClosed: true },
        },
        FluidGPU: {
          before: { completedScopes: 1, errors: 0 },
          after: { completedScopes: 2, errors: 0 },
        },
        FluidAdapter: { before: { description: "llvmpipe" }, after: { description: "llvmpipe" } },
      },
    },
  } satisfies Parameters<typeof assertNativeFluidCapture>[0];
}
const nativeConsole = [{ type: "log", text: "TN_NATIVE_SMOKE_FIRST_FRAME" }];
const collisionId = "resource.FluidCollision.collisionPassed";

test("accepts observed native provenance without fabricating a capture record", () => {
  expect(() => assertNativeFluidCapture(report(), nativeConsole)).not.toThrow();
  for (const mutation of [
    { runtime: "browser" },
    { target: "web" },
    { observations: undefined },
    { assertionResults: [] },
    ...[
      undefined,
      {},
      { before: { completedScopes: 0, errors: 0 }, after: { completedScopes: 2, errors: 0 } },
      { before: { completedScopes: 1, errors: 0 }, after: { completedScopes: 2, errors: 1 } },
    ].map((FluidGPU) => ({
      observations: {
        ...report().observations,
        resources: { ...report().observations.resources, FluidGPU },
      },
    })),
  ])
    expect(() =>
      assertNativeFluidCapture(
        { ...report(), ...mutation } as Parameters<typeof assertNativeFluidCapture>[0],
        nativeConsole,
      ),
    ).toThrow();
});

test("rejects consumed baselines, wrong steps, wrong variants and missing actual adapter identity", () => {
  const clean = report();
  const mutations: Record<string, { before: unknown; after: unknown }>[] = [
    {
      FluidCollision: {
        before: { measuredSteps: 1, totalSteps: 2 },
        after: { measuredSteps: 1, totalSteps: 2, gateClosed: true },
      },
    },
    {
      FluidCollision: {
        before: { measuredSteps: 0, totalSteps: 1 },
        after: { measuredSteps: 2, totalSteps: 3, gateClosed: true },
      },
    },
    {
      FluidCollision: {
        before: { measuredSteps: 0, totalSteps: 1 },
        after: { measuredSteps: 1, totalSteps: 2, gateClosed: false },
      },
    },
    { FluidAdapter: { before: {}, after: {} } },
    { FluidAdapter: { before: { description: "unknown" }, after: { description: "unknown" } } },
    {
      FluidAdapter: {
        before: { features: "timestamp-query" },
        after: { features: "timestamp-query" },
      },
    },
    { FluidAdapter: { before: { description: "other" }, after: { description: "llvmpipe" } } },
  ];
  for (const mutation of mutations)
    expect(() =>
      assertNativeFluidCapture(
        {
          ...clean,
          observations: {
            ...clean.observations,
            resources: { ...clean.observations?.resources, ...mutation },
          },
        } as Parameters<typeof assertNativeFluidCapture>[0],
        nativeConsole,
      ),
    ).toThrow();
});

test("rejects every extra diagnostic and native host error even when the gate is intentionally absent", () => {
  const clean = report();
  const missing = {
    ...clean,
    pass: false,
    diagnostics: [
      {
        code: "TN_PLAYTEST_RESOURCE_ASSERTION_FAILED",
        severity: "error",
        message: "collision failed",
      },
    ],
    assertionResults: [{ id: collisionId, pass: false }],
    observations: {
      ...clean.observations,
      resources: {
        ...clean.observations?.resources,
        FluidCollision: {
          before: { measuredSteps: 0, totalSteps: 1 },
          after: { measuredSteps: 1, totalSteps: 2, gateClosed: false },
        },
      },
    },
  } as Parameters<typeof assertNativeFluidCapture>[0];
  expect(() => assertNativeFluidCapture(missing, nativeConsole, collisionId)).not.toThrow();
  for (const consoleInput of [
    undefined,
    [],
    [{ type: "log", text: "no marker" }],
    [...nativeConsole, { type: "error", text: "unknown failure" }],
    [...nativeConsole, { type: "log", text: "[WebGPU] Device error (Validation): bad buffer" }],
    [...nativeConsole, { type: "log", text: "device was lost" }],
  ])
    expect(() => assertNativeFluidCapture(missing, consoleInput, collisionId)).toThrow();
  expect(() =>
    assertNativeFluidCapture(
      {
        ...missing,
        diagnostics: [
          ...missing.diagnostics,
          { code: "TN_PLAYTEST_SOFTWARE_DEVICE_LOST", severity: "warning", message: "lost" },
        ],
      },
      nativeConsole,
      collisionId,
    ),
  ).toThrow();
});

test("preserves numerical predicates and passes native preflight while diagnostics and pixels are checked externally", async () => {
  const authored = await loadPlaytestScenario(project, "playtests/fluid-collision.playtest.json");
  const native = nativeFluidScenario(authored);
  expect(native.assert?.resources).toEqual(authored.assert?.resources);
  expect(native.warmupFrames).toBe(0);
  expect(native.artifacts?.screenshots).toBe("before-after");
  expect(native.assert?.diagnostics).toBeUndefined();
  expect(native.assert?.visual).toBeUndefined();
  expect(requiredPlaytestCapabilities(native, "desktop")).not.toContain("browser.network");
  expect(validatePlaytestScenario(native, "native-fluid").target).toBe("desktop");
  const directory = await makeTempDir("fluid-native-scenario-");
  try {
    const filename = path.join(directory, "native.playtest.json");
    await writeFile(filename, JSON.stringify(native));
    const roundTrip = await loadPlaytestScenario(project, filename);
    expect(roundTrip.assert?.resources).toEqual(authored.assert?.resources);
    expect(roundTrip.target).toBe("desktop");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  expect(() => nativeFluidScenario({ ...authored, warmupFrames: 1 })).toThrow("baseline");
  expect(() => nativeFluidScenario({ ...authored, assert: {} })).toThrow("predicates");
  const transport: IBridgeTransport = {
    capabilities: ANDROID_TRANSPORT_CAPABILITIES,
    waitForBridge: async () => true,
    close: async () => {},
    async call<T>(method: string): Promise<T> {
      if (method === "describe")
        return {
          capabilities: [
            "runtime.network",
            "runtime.resources",
            "runtime.fixedStep",
            "runtime.diagnostics",
          ],
          limits: PLAYTEST_PROTOCOL_LIMITS,
          name: "@threenative/playtest/three",
          protocolVersion: 1,
        } as T;
      if (method === "ready") return { ready: true } as T;
      throw new Error(`Unexpected preflight method ${method}`);
    },
  };
  await expect(
    connectPlaytestBridgeTransport(transport, native, 1000, "desktop"),
  ).resolves.toBeDefined();
});

test("applies the exact authored pixel threshold to both native PNG dimensions", async () => {
  const authored = await loadPlaytestScenario(project, "playtests/fluid-collision.playtest.json");
  // Synthetic validator-only input. It is never published as runtime screenshot evidence.
  const png = new PNG({ width: authored.viewport.width, height: authored.viewport.height });
  expect(() => assertNativeFluidPixels(PNG.sync.write(png), authored)).toThrow("nonblank");
  const threshold = authored.assert?.visual?.[0]?.region?.minNonblankPixelRatio;
  if (threshold === undefined) throw new Error("Missing authored threshold");
  const minimumPixels = Math.ceil(png.width * png.height * threshold);
  for (let pixel = 0; pixel < minimumPixels - 1; pixel++)
    png.data.fill(255, pixel * 4, pixel * 4 + 4);
  expect(() => assertNativeFluidPixels(PNG.sync.write(png), authored)).toThrow("nonblank");
  png.data.fill(255, (minimumPixels - 1) * 4, minimumPixels * 4);
  expect(() => assertNativeFluidPixels(PNG.sync.write(png), authored)).not.toThrow();
  expect(() =>
    assertNativeFluidPixels(PNG.sync.write(new PNG({ width: 1, height: 1 })), authored),
  ).toThrow("width");
  expect(() => assertNativeFluidPixels(Buffer.from("not png"), authored)).toThrow();
});

function responses() {
  return {
    observations: [
      {
        method: "describe",
        result: { capabilities: ["runtime.fixedStep", "runtime.resources", "runtime.diagnostics"] },
      },
      { method: "ready", result: { ready: true } },
      {
        method: "sample",
        result: {
          diagnostics: [],
          resources: {
            FluidCollision: report().observations.resources.FluidCollision.before,
            FluidGPU: report().observations.resources.FluidGPU.before,
          },
        },
      },
      {
        method: "sample",
        result: {
          diagnostics: [],
          resources: {
            FluidCollision: report().observations.resources.FluidCollision.after,
            FluidGPU: report().observations.resources.FluidGPU.after,
          },
        },
      },
    ].map(({ method, result }, index) => ({
      method,
      order: index + 1,
      requestId: String(index + 1),
      body: JSON.stringify({ id: String(index + 1), result }),
    })),
  };
}

test("requires raw native diagnostics capability and samples even when normalized diagnostics look clean", () => {
  const clean = responses();
  expect(() => assertNativeFluidResponses(clean, report())).not.toThrow();
  for (const invalid of [
    undefined,
    {},
    { observations: [] },
    { observations: clean.observations.filter(({ method }) => method !== "describe") },
    { observations: clean.observations.filter(({ method }) => method !== "ready") },
    { observations: clean.observations.slice(0, -1) },
    { observations: [...clean.observations].reverse() },
    { observations: clean.observations.map((entry) => ({ ...entry, requestId: "wrong-id" })) },
    { observations: clean.observations.map((entry) => ({ ...entry, body: "invalid-json" })) },
    ...["missing-capability", "missing-raw", "raw-error", "wrong-snapshot", "not-ready"].map(
      (mutation) => ({
        observations: clean.observations.map((entry) => {
          const body = JSON.parse(entry.body);
          if (mutation === "missing-capability" && entry.method === "describe")
            body.result.capabilities = ["runtime.resources", "runtime.fixedStep"];
          if (mutation === "missing-raw" && entry.method === "sample")
            body.result.diagnostics = undefined;
          if (mutation === "raw-error" && entry.method === "sample")
            body.result.diagnostics = [{ severity: "error", code: "GPU_ERROR" }];
          if (mutation === "wrong-snapshot" && entry.method === "sample")
            body.result.resources.FluidCollision = { measuredSteps: 1, totalSteps: 2 };
          if (mutation === "not-ready" && entry.method === "ready") body.result.ready = false;
          return { ...entry, body: JSON.stringify(body) };
        }),
      }),
    ),
  ])
    expect(() => assertNativeFluidResponses(invalid, report())).toThrow();
});

test("native failure evidence preserves the timeout and original gate without leaking host text", () => {
  const failed = {
    pass: false,
    diagnostics: [
      {
        code: "TN_PLAYTEST_BRIDGE_MISSING",
        message: "Desktop application did not expose a playtest bridge.",
      },
    ],
  };
  const result = nativeFluidFailureDetails(
    failed,
    [
      { type: "log", text: "home=/home/private-person token=very-secret-token host=private-host" },
      {
        type: "error",
        text: "TN_NATIVE_START_FAILED:Cannot read properties of undefined (reading 'size'); /home/private-person/game.js token=very-secret-token https://private-host/x?key=123 email=private@example.test",
      },
      {
        type: "log",
        text: "[WebGPU] Device error (Validation): invalid buffer at C:\\Users\\PrivateName\\game.js",
      },
    ],
    120000,
  );
  expect(result.startupTimeoutMs).toBe(120000);
  expect(result.diagnostics).toEqual(["TN_PLAYTEST_BRIDGE_MISSING"]);
  expect(result.hostDiagnosticChannel).toBe("observed");
  expect(result.hostErrors?.length).toBe(2);
  expect(result.hostErrors?.[0]?.message).toContain("Cannot read properties of undefined");
  const published = JSON.stringify(result);
  for (const privateText of [
    "private-person",
    "very-secret-token",
    "private-host",
    "private@example.test",
    "PrivateName",
    "/home/",
    "C:",
  ])
    expect(published).not.toContain(privateText);
  expect(published).not.toContain("token=");
});

test("missing or malformed native console is not reported as a clean observed channel", () => {
  const failed = { pass: false, diagnostics: [{ code: "TN_PLAYTEST_BRIDGE_MISSING" }] };
  for (const missing of [undefined, null, [], {}, [{ type: "error" }]]) {
    const result = nativeFluidFailureDetails(failed, missing, 120000);
    expect(result.hostDiagnosticChannel).toBe("unavailable");
    expect(result.hostErrors).toBeUndefined();
    expect(result.diagnostics).toEqual(["TN_PLAYTEST_BRIDGE_MISSING"]);
  }
});

test("pre-report verifier failures retain distinct bounded identities without leaking error text", () => {
  for (const [message, diagnostic] of [
    ["Xvfb did not report a display within 10000ms.", "XVFB_DISPLAY_TIMEOUT"],
    ["Desktop playtest did not produce a report.", "PLAYTEST_REPORT_MISSING"],
    ["/home/private-person/game.js token=very-secret-token", "UNCLASSIFIED_VERIFIER_ERROR"],
    [
      "Xvfb did not report a display within 10000ms. token=very-secret-token",
      "UNCLASSIFIED_VERIFIER_ERROR",
    ],
  ]) {
    const result = nativeFluidFailureDetails(undefined, undefined, 120000, new Error(message));
    expect(result).toMatchObject({
      startupTimeoutMs: 120000,
      reportDiagnosticChannel: "unavailable",
      hostDiagnosticChannel: "unavailable",
      verifierDiagnostic: diagnostic,
    });
    expect(result.diagnostics).toBeUndefined();
    expect(result.hostErrors).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/private-person|very-secret-token|\/home\//u);
  }
  expect(nativeFluidFailureDetails(undefined, undefined, 120000)).not.toHaveProperty(
    "verifierDiagnostic",
  );
  for (const error of [null, "private-person very-secret-token", { message: "private-person" }]) {
    const result = nativeFluidFailureDetails(undefined, undefined, 120000, error);
    expect(result.verifierDiagnostic).toBe("UNCLASSIFIED_VERIFIER_ERROR");
    expect(JSON.stringify(result)).not.toMatch(/private-person|very-secret-token/u);
  }
});

test("native failure publication is bounded and contains only known technical tokens", () => {
  const input = Array.from({ length: 100 }, (_, index) => ({
    type: "error",
    text: `ReferenceError privateValue${index} private host credential is not defined ${"secret ".repeat(200)}`,
  }));
  const result = nativeFluidFailureDetails(
    { pass: false, diagnostics: [{ code: "PRIVATE_SECRET_CODE" }] },
    input,
    120000,
  );
  expect(result.diagnostics).toEqual(["UNRECOGNIZED_DIAGNOSTIC"]);
  expect(result.hostErrors?.length).toBeLessThanOrEqual(16);
  expect(result.hostErrors?.every(({ message }) => message.length <= 240)).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(/private|credential|secret/iu);
});

test("native variant failure provenance resets before attempting its bundle", async () => {
  const source = await readFile("scripts/verify-fluid-collision-native.ts", "utf8");
  const loop = source.indexOf('for (const variant of ["gate", "gate-disabled"]');
  const reset = source.indexOf("lastBundleSha256 = undefined;", loop);
  const build = source.indexOf("execFileSync(", loop);
  expect(loop).toBeGreaterThan(0);
  expect(reset).toBeGreaterThan(loop);
  expect(reset).toBeLessThan(build);
});
