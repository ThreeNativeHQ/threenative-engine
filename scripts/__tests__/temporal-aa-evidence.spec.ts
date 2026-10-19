import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { IPlaytestReport } from "../../packages/playtest/src/report.js";
import { makeTempDir } from "../../test-support/temp-dir.js";
import {
  requireTemporalRenderEvidence,
  writeTemporalMotionSummary,
} from "../temporal-aa-evidence.js";

function report(): Pick<IPlaytestReport, "capture" | "diagnostics"> & { pass: boolean } {
  return {
    capture: {
      adapter: { architecture: "swiftshader", vendor: "google" },
      browserArgs: [],
      captureMethod: "page.screenshot",
      rendererKind: "webgpu",
      target: "web",
      viewport: { width: 1280, height: 720 },
    },
    diagnostics: [],
    pass: true,
  };
}
describe("temporal render evidence", () => {
  it("accepts honest software correctness evidence with adapter provenance", () => {
    expect(() => requireTemporalRenderEvidence(report(), "temporal")).not.toThrow();
  });
  it("rejects software device loss even when the runner reports pass", () => {
    const result = report();
    result.diagnostics.push({
      code: "TN_PLAYTEST_SOFTWARE_DEVICE_LOST",
      message: "This lane is not render evidence",
      severity: "warning",
    });
    expect(() => requireTemporalRenderEvidence(result, "temporal")).toThrow(/device loss/);
  });
  it("reports startup errors before the consequent missing screenshot provenance", () => {
    const result = report();
    Reflect.deleteProperty(result, "capture");
    result.diagnostics.push({
      code: "TN_PLAYTEST_BRIDGE_MISSING",
      message: "Startup failed",
      severity: "error",
    });
    expect(() => requireTemporalRenderEvidence(result, "temporal")).toThrow(/error diagnostics/);
  });
  it("rejects unrelated error diagnostics, absent adapter identity and failed reports", () => {
    const error = report();
    error.diagnostics.push({
      code: "TN_PLAYTEST_CONSOLE_ERROR",
      severity: "error",
      message: "Shader failed",
    });
    expect(() => requireTemporalRenderEvidence(error, "temporal")).toThrow(/error diagnostics/);
    const absent = report();
    if (absent.capture) absent.capture.adapter = {};
    expect(() => requireTemporalRenderEvidence(absent, "temporal")).toThrow(/adapter/);
    const failed = report();
    failed.pass = false;
    expect(() => requireTemporalRenderEvidence(failed, "temporal")).toThrow();
  });
});

describe("temporal motion summary", () => {
  it.each([true, false])(
    "retains an unqualified artifact for missing checks (equivalence=%s)",
    async (authoredLinearEquivalent) => {
      const directory = await makeTempDir("temporal-summary-");
      const filename = path.join(directory, "summary.json");
      const measurement = { authoredLinearEquivalent, checks: {}, results: { retained: true } };
      try {
        const error = await writeTemporalMotionSummary(filename, measurement).then(
          () => null,
          (error: Error) => error,
        );
        expect(JSON.parse(await readFile(filename, "utf8"))).toEqual({
          ...measurement,
          pass: false,
        });
        expect(error?.message).toContain(
          authoredLinearEquivalent
            ? "Missing temporal quality checks"
            : "Authored-linear equivalence failed",
        );
        expect(error?.message).toContain(filename);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
  it.each([true, false])(
    "retains failed equivalence evidence before rejecting cubic interpretation (quality=%s)",
    async (qualityPass) => {
      const directory = await makeTempDir("temporal-summary-");
      const filename = path.join(directory, "summary.json");
      const measurement = {
        authoredLinearEquivalent: false,
        checks: { edgeImprovement: qualityPass },
        results: { temporal: { edgeError: 0.05 }, "resolve-cubic": { edgeError: 0.04 } },
      };
      try {
        const error = await writeTemporalMotionSummary(filename, measurement).then(
          () => null,
          (error: Error) => error,
        );
        expect(JSON.parse(await readFile(filename, "utf8"))).toEqual({
          ...measurement,
          pass: false,
        });
        expect(error?.message).toContain("Authored-linear equivalence failed");
        expect(error?.message).toContain("cubic interpretation is invalid");
        expect(error?.message).toContain(filename);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
  it.each([true, false])(
    "preserves the original quality gate (quality=%s)",
    async (qualityPass) => {
      const directory = await makeTempDir("temporal-summary-");
      const filename = path.join(directory, "summary.json");
      try {
        const result = writeTemporalMotionSummary(filename, {
          authoredLinearEquivalent: true,
          checks: { edgeImprovement: qualityPass },
        });
        if (qualityPass) await expect(result).resolves.toBeUndefined();
        else await expect(result).rejects.toThrow("Temporal motion quality remains unqualified");
        expect(JSON.parse(await readFile(filename, "utf8")).pass).toBe(qualityPass);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
