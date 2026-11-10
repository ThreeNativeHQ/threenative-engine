import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, rmdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDirSync } from "../../../test-support/temp-dir.js";

/**
 * Several agent lanes work in this repository at once, and every one of them can be driving a
 * Playwright browser. The orphan gate reads the whole machine's process table, so its ownership
 * rule is the only thing separating "this run leaked a browser" from "a neighbour is working".
 *
 * A rule that matched `playwright_chromiumdev_profile-` anywhere on the machine reported another
 * lane's live browsers as this run's orphans: a red on a clean tree, cleared by nothing the diff
 * could change. These drive the rule directly against decoys so both halves stay proven — the
 * neighbour is ignored, and this run's own leak is still caught.
 */

const script = path.resolve("packages/playtest/__tests__/orphan-cleanup.sh");
const started: ReturnType<typeof spawn>[] = [];

/**
 * A stand-in for a browser: a process whose command line carries the profile path under test. The
 * gate matches on argv, so what the process actually does is irrelevant, and a decoy keeps the
 * check off a real browser launch.
 */
function startDecoy(profileDirectory: string): number {
  const child = spawn(
    process.execPath,
    ["-e", "setTimeout(() => {}, 60_000)", "--", `--user-data-dir=${profileDirectory}`],
    { stdio: "ignore" },
  );
  started.push(child);
  if (child.pid === undefined) throw new Error("decoy process did not start");
  return child.pid;
}

function listOrphans(suiteRoot: string, baselinePids: readonly number[]): string {
  const baselineFile = path.join(suiteRoot, "baseline-pids");
  writeFileSync(baselineFile, `${baselinePids.join("\n")}\n`);
  return execFileSync("bash", [script, "--list-orphans", baselineFile, "45999"], {
    encoding: "utf8",
    env: { ...process.env, TN_SUITE_TMPDIR: suiteRoot },
  });
}

function makeSuiteRoot(): string {
  return makeTempDirSync("tn-orphan-ownership.");
}

/** The gate polls to a deadline; a decoy has to be visible to `ps` before the rule is asked. */
async function waitForProcess(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const listing = execFileSync("ps", ["-eo", "pid="], { encoding: "utf8" });
    if (listing.split(/\s+/u).includes(String(pid))) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`decoy ${pid} never appeared in the process table`);
}

afterEach(() => {
  for (const child of started.splice(0)) child.kill("SIGKILL");
});

describe("orphan ownership", () => {
  it("ignores a browser profile that belongs to another lane on the same machine", async () => {
    const suiteRoot = makeSuiteRoot();
    const neighbourRoot = makeSuiteRoot();
    const neighbour = startDecoy(path.join(neighbourRoot, "playwright_chromiumdev_profile-abc123"));
    await waitForProcess(neighbour);

    expect(listOrphans(suiteRoot, [])).not.toContain(String(neighbour));
  });

  it("still reports a browser profile left behind inside this run's own namespace", async () => {
    const suiteRoot = makeSuiteRoot();
    const own = startDecoy(path.join(suiteRoot, "playwright_chromiumdev_profile-def456"));
    await waitForProcess(own);

    expect(listOrphans(suiteRoot, [])).toContain(String(own));
  });

  it("does not claim a runner started from a different worktree", async () => {
    const suiteRoot = makeSuiteRoot();
    const neighbour = spawn(
      process.execPath,
      [
        "-e",
        "setTimeout(() => {}, 60_000)",
        "--",
        "--marker=/somewhere/else/.claude/worktrees/lane/packages/playtest/dist/runner/cli.js",
      ],
      { stdio: "ignore" },
    );
    started.push(neighbour);
    if (neighbour.pid === undefined) throw new Error("decoy process did not start");
    await waitForProcess(neighbour.pid);

    expect(listOrphans(suiteRoot, [])).not.toContain(String(neighbour.pid));
  });
});

describe("temporary namespace ownership", () => {
  it("does not read the shared suite namespace when it runs the browser itself", async () => {
    const source = await readFile(script, "utf8");
    // The browser run is the one mode that must not adopt `TN_SUITE_TMPDIR`: `pnpm -r` runs it
    // beside two sibling package tests in that shared directory.
    expect(source).toContain('if [[ -z "${1:-}" ]]; then\n  suite_temp_root=""\nfi');
  });

  it("passes a suite whose temporary directory count went down", () => {
    const suiteRoot = makeSuiteRoot();
    mkdirSync(path.join(suiteRoot, "left-over-by-a-sibling"));
    const marker = path.join(suiteRoot, "marker");

    const run = (mode: string) =>
      execFileSync("bash", [script, mode, marker], {
        encoding: "utf8",
        env: { ...process.env, TN_SUITE_TMPDIR: suiteRoot },
      });

    run("--suite-start");
    rmdirSync(path.join(suiteRoot, "left-over-by-a-sibling"));

    expect(() => run("--suite-finish")).not.toThrow();
  });

  // CI 2026-11-10 (#643): every test passed and the gate still failed, before 1 after 2, because
  // a test's async cleanup was still removing its directory when the last package finished.
  it("waits for a late cleanup before it calls a suite leak", () => {
    const suiteRoot = makeSuiteRoot();
    const marker = path.join(suiteRoot, "marker");
    const env = { ...process.env, TN_SUITE_TMPDIR: suiteRoot, TN_ORPHAN_SETTLE_SECONDS: "5" };
    execFileSync("bash", [script, "--suite-start", marker], { encoding: "utf8", env });
    const late = path.join(suiteRoot, "cleaned-up-late");
    mkdirSync(late);

    expect(() =>
      execFileSync(
        "bash",
        ["-c", '( sleep 1; rmdir "$1" ) & bash "$2" --suite-finish "$3"', "_", late, script, marker],
        { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] },
      ),
    ).not.toThrow();
  });

  it("still fails a suite whose temporary directory count went up", () => {
    const suiteRoot = makeSuiteRoot();
    const marker = path.join(suiteRoot, "marker");

    const run = (mode: string) =>
      execFileSync("bash", [script, mode, marker], {
        encoding: "utf8",
        env: { ...process.env, TN_SUITE_TMPDIR: suiteRoot, TN_ORPHAN_SETTLE_SECONDS: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });

    run("--suite-start");
    mkdirSync(path.join(suiteRoot, "stranded"));

    // The failure names the directory that stayed, so the next leak points at its owner.
    expect(() => run("--suite-finish")).toThrow(/stranded/u);
  });
});
