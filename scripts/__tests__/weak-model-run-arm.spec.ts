import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(".claude/skills/weak-model-benchmark/scripts/run-arm.sh");
const hasUserSystemd = spawnSync("systemctl", ["--user", "is-system-running"]).status !== null;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("run-arm.sh", () => {
  let root = "";
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  // A capped or finished arm left its agent, vite and Xvfb running, and the sealed proof then ran
  // beside them (wm-platformer-2, 2026-11-13). The arm is over only when its whole scope is gone.
  it.skipIf(!hasUserSystemd)("stops every process the arm started before it returns", () => {
    root = mkdtempSync(path.join(tmpdir(), "run-arm-"));
    const pidFile = path.join(root, "child.pid");
    mkdirSync(path.join(root, "leanpi", "bin"), { recursive: true });
    mkdirSync(path.join(root, "leanpi", "dist", "permissions"), { recursive: true });
    writeFileSync(path.join(root, "leanpi", "package.json"), "{}");
    writeFileSync(
      path.join(root, "leanpi", "dist", "permissions", "trust.js"),
      "export const grantTrust = () => ({ trusted: true });\n",
    );
    const stub = path.join(root, "leanpi", "bin", "leanpi");
    writeFileSync(stub, `#!/bin/sh\nsleep 300 &\necho $! > ${pidFile}\n`);
    chmodSync(stub, 0o755);
    mkdirSync(path.join(root, "xdg", "leanpi"), { recursive: true });
    writeFileSync(path.join(root, "xdg", "leanpi", "leanpi.config.yaml"), "{}\n");
    mkdirSync(path.join(root, "game"));
    writeFileSync(path.join(root, "game", "package.json"), "{}");

    spawnSync("bash", [SCRIPT, path.join(root, "game"), path.join(root, "out")], {
      env: {
        ...process.env,
        PATH: `${path.join(root, "leanpi", "bin")}:${process.env.PATH}`,
        ...Object.fromEntries([["WM_XDG", path.join(root, "xdg")]]),
      },
      encoding: "utf8",
    });

    const child = Number(readFileSync(pidFile, "utf8"));
    const left = alive(child);
    if (left) execFileSync("kill", [String(child)]);
    expect(left).toBe(false);
  });
});
