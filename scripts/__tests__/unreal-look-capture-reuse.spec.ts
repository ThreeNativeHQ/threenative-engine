import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDirSync } from "../../test-support/temp-dir.js";
import { frameworkStamp } from "../unreal-look/capture-threenative.js";

let root: string;
afterEach(() => rmSync(root, { recursive: true, force: true }));

function repo(): string {
  root = makeTempDirSync("tn-reuse-");
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args]);
  git("init", "-q");
  mkdirSync(path.join(root, "packages/core/src"), { recursive: true });
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  writeFileSync(path.join(root, "packages/core/src/a.ts"), "export const a = 1;\n");
  writeFileSync(path.join(root, "scripts/s.ts"), "1\n");
  writeFileSync(path.join(root, "engine.wasm"), "wasm");
  git("add", "packages", "scripts");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
  return root;
}

describe("a reused capture scaffold is packed again when the framework changed (--reuse)", () => {
  const stamp = () => frameworkStamp(root, ["packages/core"], [path.join(root, "engine.wasm")]);

  it("keeps the stamp for an unchanged framework and for edits outside it", () => {
    repo();
    const before = stamp();
    expect(stamp()).toBe(before);
    writeFileSync(path.join(root, "scripts/s.ts"), "2\n");
    expect(stamp()).toBe(before);
  });

  it("changes the stamp for an uncommitted edit, an untracked file, a commit, and a rebuilt engine", () => {
    repo();
    const seen = new Set([stamp()]);
    writeFileSync(path.join(root, "packages/core/src/a.ts"), "export const a = 2;\n");
    seen.add(stamp());
    writeFileSync(path.join(root, "packages/core/src/b.ts"), "export const b = 1;\n");
    seen.add(stamp());
    execFileSync("git", ["-C", root, "add", "packages"]);
    execFileSync("git", [
      "-C",
      root,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-qm",
      "b",
    ]);
    seen.add(stamp());
    utimesSync(path.join(root, "engine.wasm"), new Date(), new Date(Date.now() + 5000));
    seen.add(stamp());
    expect(seen.size).toBe(5);
  });
});
