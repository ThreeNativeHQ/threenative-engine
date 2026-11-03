import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { makeTempDirSync } from "../../test-support/temp-dir.js";

const script = path.join(import.meta.dirname, "../non-visual-scenarios.mjs");
const list = (root: string, ...args: string[]) =>
  spawnSync("node", [script, root, ...args], { encoding: "utf8" });

it("leaves long scenarios of a trimmed kit to the nightly, and only on a board", () => {
  const root = makeTempDirSync("non-visual-");
  try {
    mkdirSync(path.join(root, "playtests"));
    const write = (name: string, scenario: object) =>
      writeFileSync(
        path.join(root, "playtests", `${name}.playtest.json`),
        JSON.stringify(scenario),
      );
    write("short", { warmupFrames: 10, steps: [{ holdTicks: 489 }] });
    write("long", { warmupFrames: 10, steps: [{ holdTicks: 90 }, { waitTicks: 400 }] });

    const all = ["playtests/long.playtest.json", "playtests/short.playtest.json"].join("\n");
    expect(list(root).stdout).toBe(all);
    expect(list(root, "--board", "minimal").stdout).toBe(all);
    const board = list(root, "--board", "shooter");
    expect(board.stdout).toBe("playtests/short.playtest.json");
    expect(board.stderr).toContain("1 left to the nightly (long.playtest.json)");
    expect(list(root, "--board").status).toBe(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("fails closed when a trimmed kit would keep no scenario", () => {
  const root = makeTempDirSync("non-visual-");
  try {
    mkdirSync(path.join(root, "playtests"));
    writeFileSync(
      path.join(root, "playtests/long.playtest.json"),
      JSON.stringify({ steps: [{ waitTicks: 500 }] }),
    );
    expect(list(root, "--board", "rain").status).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
