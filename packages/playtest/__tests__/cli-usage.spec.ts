import { makeTempDir } from "../../../test-support/temp-dir.js";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

import { main } from "../src/runner/cli.js";
import { CaptureLockTimeoutError } from "../src/runner/captureLock.js";
import { formatUsage, PLAYTEST_FLAGS } from "../src/runner/config.js";

const { runStandalonePlaytests } = vi.hoisted(() => ({ runStandalonePlaytests: vi.fn() }));

vi.mock("../src/runner/runner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runner/runner.js")>();
  return { ...actual, runStandalonePlaytests };
});

afterEach(() => {
  process.exitCode = undefined;
  runStandalonePlaytests.mockReset();
});

test("--help exits 0 and documents every validated flag", async () => {
  const output: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  let exitCode: number;
  try {
    exitCode = await main(["--help"]);
  } finally {
    process.stdout.write = originalWrite;
  }
  const stdout = output.join("");

  expect(exitCode).toBe(0);
  expect(stdout).toContain("init");
  expect(stdout).toContain("Exit codes:");
  for (const [flag, details] of Object.entries(PLAYTEST_FLAGS)) {
    expect(stdout).toContain(flag);
    expect(stdout).toContain(`default: ${details.default}`);
  }
  expect(stdout).toBe(formatUsage());
});

async function scenarioArguments(): Promise<string[]> {
  const project = await makeTempDir("playtest-cli-batch-");
  await writeFile(join(project, "one.playtest.json"), "{}");
  await writeFile(join(project, "two.playtest.json"), "{}");
  return ["--project", project, "--scenario", "*.playtest.json"];
}

function report(pass: boolean, diagnostics: Array<{ code: string }> = []) {
  return { assertionResults: [{ id: "movement", pass }], diagnostics, pass };
}

test("batch CLI verdict preserves the worst assertion exit code", async () => {
  runStandalonePlaytests.mockResolvedValueOnce([report(false), report(true)]);
  process.exitCode = 0;

  const exitCode = await main(await scenarioArguments());

  expect(exitCode).toBe(1);
  expect(process.exitCode).toBe(1);
});

test("batch CLI verdict preserves the framebuffer-window exit code", async () => {
  runStandalonePlaytests.mockResolvedValueOnce([
    report(true),
    report(false, [{ code: "TN_PLAYTEST_FRAMEBUFFER_WINDOW_NOT_REACHED" }]),
  ]);
  process.exitCode = 0;

  const exitCode = await main(await scenarioArguments());

  expect(exitCode).toBe(2);
  expect(process.exitCode).toBe(2);
});

test("CLI keeps capture-lock timeout at exit 75", async () => {
  runStandalonePlaytests.mockRejectedValueOnce(new CaptureLockTimeoutError("pid 7", 2, 500));
  const errors: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    errors.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  process.exitCode = 0;
  try {
    const exitCode = await main(await scenarioArguments());
    expect(exitCode).toBe(75);
    expect(process.exitCode).toBe(75);
  } finally {
    process.stderr.write = originalWrite;
  }
  expect(errors.join("")).toContain("NOT a test failure");
});

test("CLI includes the original callsite when report serialization throws", async () => {
  function serializeEvidence(): never {
    throw new RangeError("Invalid string length while serializing report");
  }
  runStandalonePlaytests.mockResolvedValueOnce([{
    ...report(true),
    evidence: { toJSON: serializeEvidence },
  }]);
  const errors: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    errors.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  let exitCode: number;
  try {
    exitCode = await main(await scenarioArguments());
  } finally {
    process.stderr.write = originalWrite;
  }

  const diagnostic = JSON.parse(errors.join("")) as { diagnostics: Array<{ code: string; message: string }> };
  expect(exitCode).toBe(2);
  expect(diagnostic.diagnostics[0]?.code).toBe("TN_PLAYTEST_RUNNER_FAILED");
  expect(diagnostic.diagnostics[0]?.message).toContain("Invalid string length while serializing report");
  expect(diagnostic.diagnostics[0]?.message).toContain("serializeEvidence");
});

test("CLI includes the original callsite when an async runner operation rejects", async () => {
  async function failAsyncRunnerOperation(): Promise<never> {
    throw new Error("async settlement operation failed");
  }
  const failure = await failAsyncRunnerOperation().catch((error: unknown) => error);
  runStandalonePlaytests.mockRejectedValueOnce(failure);
  const errors: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    errors.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  let exitCode: number;
  try {
    exitCode = await main(await scenarioArguments());
  } finally {
    process.stderr.write = originalWrite;
  }

  const diagnostic = JSON.parse(errors.join("")) as { diagnostics: Array<{ code: string; message: string }> };
  expect(exitCode).toBe(2);
  expect(diagnostic.diagnostics[0]?.code).toBe("TN_PLAYTEST_RUNNER_FAILED");
  expect(diagnostic.diagnostics[0]?.message).toContain("async settlement operation failed");
  expect(diagnostic.diagnostics[0]?.message).toContain("failAsyncRunnerOperation");
});

async function runCapturing(args: string[]): Promise<{ exitCode: number; stdout: string }> {
  const output: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    return { exitCode: await main(args), stdout: output.join("") };
  } finally {
    process.stdout.write = originalWrite;
  }
}

function bigReport(pass: boolean) {
  return {
    ...report(pass, [
      { code: "TN_WARN", message: "same", severity: "warning" },
      { code: "TN_WARN", message: "same", severity: "warning" },
    ]),
    after: { frame: 9, position: [1, 2, 3] },
    artifactDirectory: "/tmp/artifacts",
    frames: 9,
    movementDelta: [1, 0, 0],
    observations: { console: [], resources: { score: { after: { points: 3 } } }, blob: "x".repeat(200_000) },
    scenario: "big",
  };
}

test("--summary prints a compact verdict, --out keeps the full report, exit code is kept", async () => {
  runStandalonePlaytests.mockResolvedValueOnce([bigReport(false)]);
  const outFile = join(await makeTempDir("playtest-cli-out-"), "full.json");

  const { exitCode, stdout } = await runCapturing([...await scenarioArguments(), "--summary", "--out", outFile]);

  expect(exitCode).toBe(1);
  expect(Buffer.byteLength(stdout)).toBeLessThan(4096);
  const summary = JSON.parse(stdout) as { out: string; pass: boolean; scenarios: Array<Record<string, any>> };
  expect(summary.pass).toBe(false);
  expect(summary.out).toBe(outFile);
  expect(summary.scenarios[0]).toMatchObject({
    artifactDirectory: "/tmp/artifacts",
    diagnosticDetails: [{ code: "TN_WARN", count: 2, message: "same" }],
    failed: ["movement"],
    finalState: { after: { frame: 9 }, resources: { score: '{"points":3}' } },
    movementDelta: [1, 0, 0],
  });
  const full = JSON.parse(await readFile(outFile, "utf8")) as { observations: { blob: string } };
  expect(full.observations.blob).toHaveLength(200_000);
});

test("--no-observations drops observations from stdout and --out, exit code is kept", async () => {
  runStandalonePlaytests.mockResolvedValueOnce([bigReport(true)]);
  const outFile = join(await makeTempDir("playtest-cli-out-"), "slim.json");

  const { exitCode, stdout } = await runCapturing([...await scenarioArguments(), "--no-observations", "--out", outFile]);

  expect(exitCode).toBe(0);
  expect(stdout).not.toContain("observations");
  expect(await readFile(outFile, "utf8")).not.toContain("observations");
});

test("without the new flags stdout stays the full report", async () => {
  runStandalonePlaytests.mockResolvedValueOnce([bigReport(true)]);
  const { stdout } = await runCapturing(await scenarioArguments());
  expect(JSON.parse(stdout)).toMatchObject({ observations: { blob: "x".repeat(200_000) } });
});
