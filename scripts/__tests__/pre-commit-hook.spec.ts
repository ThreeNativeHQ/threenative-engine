import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../test-support/temp-dir.js";

const repo = path.resolve(import.meta.dirname, "../..");

describe("pre-commit hook", () => {
  it("should run in the committing worktree when core.hooksPath points at another checkout", async () => {
    const root = await makeTempDir("pre-commit-hook-");
    // The hook file lives in a different checkout, as an absolute core.hooksPath shared by worktrees makes it.
    const hooks = path.join(root, "main", "githooks");
    const work = path.join(root, "work");
    const bin = path.join(root, "bin");
    const trace = path.join(root, "trace.log");
    await mkdir(hooks, { recursive: true });
    await mkdir(bin, { recursive: true });
    await copyFile(path.join(repo, "githooks", "pre-commit"), path.join(hooks, "pre-commit"));
    await writeFile(
      path.join(bin, "pnpm"),
      `#!/bin/sh\nprintf '%s %s\\n' "$(pwd)" "$*" >> "${trace}"\n`,
    );
    await chmod(path.join(bin, "pnpm"), 0o755);

    const research = "docs/PRDs/Unreal/research";
    const files = [
      "README.md",
      "docs/PRDs/x/PRD-1-a.md",
      `${research}/unreal-visuals-and-performance-feature-map.html`,
      `${research}/unreal-port-status.svg`,
      `${research}/unreal-port-progress.svg`,
      `${research}/port-history.json`,
      "node_modules/.bin/tsx",
    ];
    for (const file of files) {
      await mkdir(path.dirname(path.join(work, file)), { recursive: true });
      await writeFile(path.join(work, file), "x\n");
    }
    await chmod(path.join(work, "node_modules/.bin/tsx"), 0o755);
    const git = (...args: string[]) => spawnSync("git", args, { cwd: work, encoding: "utf8" });
    git("init", "-q");
    git("add", "--", "docs/PRDs/x/PRD-1-a.md");

    const result = spawnSync(path.join(hooks, "pre-commit"), [], {
      cwd: work,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        TN_SKIP_CAPABILITY_SYNC: "",
      },
    });
    const calls = await readFile(trace, "utf8").catch(() => "");
    await rm(root, { force: true, recursive: true });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(calls).toContain(`${work} --silent unreal:status`);
  });
});
