import { expect, test } from "vitest";
import {
  assertFluidCapture,
  fluidConsumerFailureDiagnostics,
  fluidConsumerFailureEvidence,
} from "../fluid-collision-proof.js";

const clean = {
  pass: true,
  diagnostics: [],
  capture: {
    rendererKind: "webgpu",
    adapter: { vendor: "google", architecture: "swiftshader" },
  },
  assertionResults: [{ id: "resources.collision", pass: true }],
};

test("retains the exact consumer timeout operation and budget without raw messages", () => {
  expect(
    fluidConsumerFailureDiagnostics([
      {
        code: "TN_PLAYTEST_OPERATION_TIMEOUT",
        message: "Bridge operation 'advance' exceeded 365000ms.",
      },
    ]),
  ).toEqual([{ code: "TN_PLAYTEST_OPERATION_TIMEOUT", operation: "advance", timeoutMs: 365000 }]);
});

test("consumer diagnostic projection rejects private text and malformed timeout metadata", () => {
  const output = fluidConsumerFailureDiagnostics([
    { code: "PRIVATE_TOKEN", message: "/home/private user@example.test" },
    {
      code: "TN_PLAYTEST_OPERATION_TIMEOUT",
      message: "Bridge operation 'private-secret' exceeded 12ms.",
    },
    { code: "TN_PLAYTEST_OPERATION_TIMEOUT", message: "Bridge operation 'advance' exceeded 0ms." },
  ]);
  expect(output).toEqual([
    { code: "UNRECOGNIZED_DIAGNOSTIC" },
    { code: "TN_PLAYTEST_OPERATION_TIMEOUT" },
    { code: "TN_PLAYTEST_OPERATION_TIMEOUT" },
  ]);
  expect(JSON.stringify(output)).not.toMatch(/private|secret|@|home/iu);
  expect(fluidConsumerFailureDiagnostics(undefined)).toBeNull();
});

test("accepts a clean, identified WebGPU collision proof", () => {
  expect(() => assertFluidCapture(clean)).not.toThrow();
});

test("rejects missing assertions, failed assertions, and failed runs", () => {
  expect(() => assertFluidCapture({ ...clean, assertionResults: [] })).toThrow("assertions");
  expect(() => assertFluidCapture({ ...clean, assertionResults: [{ pass: false }] })).toThrow(
    "assertions",
  );
  expect(() => assertFluidCapture({ ...clean, pass: false })).toThrow("failed");
});

test("rejects a downgraded software-device loss and unrelated diagnostics", () => {
  for (const code of ["TN_PLAYTEST_SOFTWARE_DEVICE_LOST", "TN_PLAYTEST_CONSOLE_ERROR"]) {
    expect(() => assertFluidCapture({ ...clean, diagnostics: [{ code }] })).toThrow(code);
  }
});

test("requires actual WebGPU and a nonempty adapter identity", () => {
  expect(() => assertFluidCapture({ ...clean, capture: undefined })).toThrow("WebGPU");
  expect(() => assertFluidCapture({ ...clean, capture: { rendererKind: "webgl2" } })).toThrow(
    "WebGPU",
  );
  expect(() =>
    assertFluidCapture({ ...clean, capture: { rendererKind: "webgpu", adapter: {} } }),
  ).toThrow("adapter");
});

const collisionId = "resource.FluidCollision.collisionPassed";
const gateDisabled = {
  ...clean,
  pass: false,
  diagnostics: [{ code: "TN_PLAYTEST_RESOURCE_ASSERTION_FAILED" }],
  assertionResults: [
    { id: collisionId, pass: false },
    { id: "finite", pass: true },
  ],
};

test("accepts only the expected collision failure when the gate is disabled", () => {
  expect(() => assertFluidCapture(gateDisabled, collisionId)).not.toThrow();
  expect(() => assertFluidCapture(clean, collisionId)).toThrow();
  expect(() => assertFluidCapture({ ...gateDisabled, diagnostics: [] }, collisionId)).toThrow();
});

test("negative control cannot conceal another assertion or device loss", () => {
  expect(() =>
    assertFluidCapture(
      {
        ...gateDisabled,
        assertionResults: [...gateDisabled.assertionResults, { id: "finite", pass: false }],
      },
      collisionId,
    ),
  ).toThrow();
  expect(() =>
    assertFluidCapture(
      {
        ...gateDisabled,
        diagnostics: [...gateDisabled.diagnostics, { code: "TN_PLAYTEST_SOFTWARE_DEVICE_LOST" }],
      },
      collisionId,
    ),
  ).toThrow("TN_PLAYTEST_SOFTWARE_DEVICE_LOST");
});

test("consumer failure evidence retains actual loss text and sanitized thrown error", () => {
  const error = new Error(
    "failed /home/private/game at https://private.test/?token=abc user@example.test",
  );
  const evidence = fluidConsumerFailureEvidence(
    {
      capture: clean.capture,
      observations: {
        console: [
          {
            type: "error",
            source: "browser-console",
            text: "TN_DEVICE_LOST: The GPU device was lost (unknown): GPU process crashed",
          },
          {
            type: "warning",
            source: "browser-console",
            text: "A valid external Instance reference no longer exists.",
          },
          {
            type: "log",
            source: "browser-console",
            text: "private-secret user@example.test /home/private/game",
          },
        ],
      },
      assertionResults: [{ id: "resource.GameState.count", pass: false }],
    },
    error,
  );
  expect(evidence.reportReturned).toBe(true);
  expect(evidence.consoleAvailable).toBe(true);
  expect(evidence.lossConsole.map(({ text }) => text)).toEqual([
    "TN_DEVICE_LOST: The GPU device was lost (unknown): GPU process crashed",
    "A valid external Instance reference no longer exists.",
  ]);
  expect(evidence.thrownError?.name).toBe("Error");
  expect(JSON.stringify(evidence)).not.toMatch(
    /private-secret|private.test|user@example|home\/private/u,
  );
  expect(evidence.assertions).toEqual([{ id: "resource.GameState.count", pass: false }]);
});

test("consumer failure evidence names absent report and console without fabricating a loss", () => {
  const beforeReport = fluidConsumerFailureEvidence(undefined, new Error("browser launch failed"));
  expect(beforeReport.reportReturned).toBe(false);
  expect(beforeReport.consoleAvailable).toBe(false);
  expect(beforeReport.lossConsole).toEqual([]);
  expect(beforeReport.adapter).toBeNull();
  const emptyReport = fluidConsumerFailureEvidence({ observations: { console: [] } }, undefined);
  expect(emptyReport.reportReturned).toBe(true);
  expect(emptyReport.consoleAvailable).toBe(true);
  expect(emptyReport.lossConsole).toEqual([]);
  expect(emptyReport.thrownError).toBeNull();
});

test("consumer failure evidence redacts bearer credentials, quoted secrets and path forms", () => {
  const error = new Error(
    'Authorization: Bearer abc-credential\npassword="quoted secret words"\ntoken=plain-token /secret C:/private/file C:\\private\\file ./relative/private ../private/file',
  );
  const evidence = JSON.stringify(fluidConsumerFailureEvidence(undefined, error));
  expect(evidence).not.toMatch(
    /abc-credential|quoted secret words|plain-token|\/secret|private|relative/u,
  );
  expect(evidence).toContain("redacted");
});
