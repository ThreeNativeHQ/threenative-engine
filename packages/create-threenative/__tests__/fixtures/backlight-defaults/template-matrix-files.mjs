import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
export async function command(bin, args, directory, log) {
  await mkdir(resolve(log, ".."), { recursive: true });
  const child = spawn(bin, args, { cwd: directory, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (data) => {
    output += data;
  });
  child.stderr.on("data", (data) => {
    output += data;
  });
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  await writeFile(log, output);
  assert.equal(code, 0, `${bin} failed; see ${log}`);
}
export async function fingerprint(root) {
  const rows = [];
  async function walk(dir) {
    for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (
        [
          "node_modules",
          ".git",
          "dist",
          ".vite",
          ".agents",
          ".claude",
          ".codex",
          "tools",
          "scripts",
          "playtests",
        ].includes(e.name)
      )
        continue;
      const p = resolve(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile())
        rows.push([
          relative(root, p),
          createHash("sha256")
            .update(await readFile(p))
            .digest("hex"),
        ]);
    }
  }
  await walk(root);
  return {
    sha256: createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
    files: rows,
    excluded:
      "dependencies/build outputs and authoring tooling; runtime source/config/assets retained",
  };
}

export const admitted = [
  "minimal",
  "starter",
  "platformer",
  "runner",
  "shooter",
  "racing",
  "action-rpg",
  "rts",
  "tower-defense",
  "puzzle",
  "sailing",
  "snow",
];
