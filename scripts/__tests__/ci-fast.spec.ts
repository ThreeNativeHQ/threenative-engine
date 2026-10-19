import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../test-support/temp-dir.js";

const repo = path.resolve(import.meta.dirname, "../..");
const hook = path.join(repo, "githooks", "pre-push");

async function runHook(failCommand?: string): Promise<{
  readonly output: string;
  readonly status: number | null;
  readonly trace: readonly string[];
}> {
  const root = await makeTempDir("ci-fast-recorder-");
  const bin = path.join(root, "bin");
  const traceFile = path.join(root, "trace.log");
  const logs = path.join(root, "logs");
  await mkdir(bin, { recursive: true });
  await writeFile(
    path.join(bin, "pnpm"),
    [
      "#!/bin/sh",
      'printf \'%s\\n\' "$*" >> "$TN_CI_FAST_TRACE"',
      'if [ "${TN_CI_FAST_FAIL:-}" = "$1" ]; then exit 17; fi',
      "exit 0",
      "",
    ].join("\n"),
  );
  await chmod(path.join(bin, "pnpm"), 0o755);
  const result = spawnSync(hook, [], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      TN_CI_FAST_FAIL: failCommand ?? "",
      TN_CI_FAST_LOGS: logs,
      TN_CI_FAST_TRACE: traceFile,
    },
  });
  const trace = (await readFile(traceFile, "utf8").catch(() => ""))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  await rm(root, { force: true, recursive: true });
  return {
    output: `${result.stdout}\n${result.stderr}`,
    status: result.status,
    trace,
  };
}

describe("ci-fast bounded hook", () => {
  it("should run bounded checks when the pre-push hook executes", async () => {
    const result = await runHook();
    expect(result.status, result.output).toBe(0);
    // Stages run in parallel, so the trace order is not fixed.
    expect([...result.trace].sort()).toEqual([
      "check:docs",
      expect.stringContaining("exec vitest run"),
      "lint",
      "sync:agents --check",
    ]);
    expect(result.trace.join("\n")).not.toMatch(/typecheck|budgets/u);
  });

  it("should fail the hook when lint fails", async () => {
    const result = await runHook("lint");
    expect(result.status, result.output).not.toBe(0);
    expect(result.trace).toContain("lint");
  });

  it("should not invoke build, typecheck or budgets when fast checks run", async () => {
    const source = await readFile(path.join(repo, "scripts", "ci-fast.sh"), "utf8");
    expect(source).not.toMatch(/add\s+typecheck/u);
    expect(source).not.toMatch(/add\s+budgets/u);
    expect(source).not.toContain("pnpm build");
  });
});
