import { makeTempDir } from "../../../test-support/temp-dir.js";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { main } from "../src/runner/cli.js";

// A weak model finished a "passing" game with two lint errors it never ran (wm-platformer-2,
// 2026-11-13): an installed project's typecheck and lint gate every scenario run.
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true });
});

async function project(scripts: Record<string, string>, workspace = false): Promise<string> {
  const root = await makeTempDir("tn-playtest-check-");
  roots.push(root);
  if (workspace) await writeFile(join(root, "pnpm-workspace.yaml"), "packages: []\n");
  const game = join(root, "game");
  await mkdir(game);
  await writeFile(join(game, "package.json"), JSON.stringify({ name: "game", private: true, scripts }));
  return game;
}

async function run(argv: readonly string[]): Promise<{ code: number; errors: string }> {
  const errors: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    errors.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    return { code: await main([...argv, "--scenario", "missing.playtest.json"]), errors: errors.join("") };
  } finally {
    process.stderr.write = write;
  }
}

test("a failing lint script fails the run before any scenario, naming the error", async () => {
  const game = await project({ typecheck: "exit 0", lint: "echo src/a.ts no-restricted-syntax && exit 1" });
  const { code, errors } = await run(["--project", game]);
  expect(code).toBe(1);
  expect(errors).toContain("TN_PLAYTEST_CHECK_FAILED");
  expect(errors).toContain("src/a.ts no-restricted-syntax");
});

test("--skip-check skips the scripts and says so; a workspace project keeps its own gates", async () => {
  const failing = { lint: "exit 1" };
  const skipped = await run(["--project", await project(failing), "--skip-check"]);
  expect(skipped.errors).toContain("TN_PLAYTEST_CHECK_SKIPPED");
  expect(skipped.errors).not.toContain("TN_PLAYTEST_CHECK_FAILED");
  const inWorkspace = await run(["--project", await project(failing, true)]);
  expect(inWorkspace.errors).not.toContain("TN_PLAYTEST_CHECK_FAILED");
});
