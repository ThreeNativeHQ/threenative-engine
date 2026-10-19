import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// A diagnostic that prescribes bare `xvfb-run` talks an agent into a false red: xvfb-run's
// failing-cleanup kill replaces the command's own exit status (see scripts/xvfb.sh). Root
// docs and the doctor prescribe `sh scripts/xvfb.sh <cmd>` instead; this guard keeps every
// harness source saying the same thing.
const scannedTrees = ["packages/playtest/src", "packages/runtime-native/src"];

// Records that quote the old advice to analyse it sit outside the scanned trees by design.
// An allowlist entry inside a scanned tree would silently exempt it, so the disjointness is
// asserted below rather than trusted.
const allowedXvfbRunMentions = ["docs/"];

// A mention is fine when its sentence carries the warning; an instruction to run it is not.
// The warning wraps, so read the sentence around the mention rather than the line.
const warningCarried = /\bnot\b|\bnever\b|rather than|replaces a successful/i;

const sourceName = /\.(ts|tsx|js|mjs|cpp|h|mm)$/;

async function collectSourceFiles(tree: string): Promise<string[]> {
  const entries = await readdir(join(repoRoot, tree), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = `${tree}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === "dist" || entry.name === "node_modules") continue;
      files.push(...(await collectSourceFiles(path)));
    } else if (sourceName.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

async function collectConformanceSources(): Promise<string[]> {
  const directory = join(repoRoot, "packages/runtime-native/conformance");
  const names = (await readdir(directory)).filter((name) => name.endsWith(".mjs"));
  if (names.length === 0) {
    throw new Error("no .mjs sources found under packages/runtime-native/conformance");
  }
  return names.map((name) => `packages/runtime-native/conformance/${name}`);
}

test("fails when a diagnostic prescribes xvfb-run", async () => {
  for (const allowed of allowedXvfbRunMentions) {
    expect(
      scannedTrees.some((tree) => allowed.startsWith(`${tree}/`)),
      `allowlist entry ${allowed} must stay outside the scanned trees`,
    ).toBe(false);
  }

  const sources = [
    ...(await Promise.all(scannedTrees.map(async (tree) => {
      const files = await collectSourceFiles(tree);
      // Fail closed: a renamed or emptied tree must fail here, not scan to zero silently.
      if (files.length === 0) throw new Error(`no source files found under ${tree}`);
      return files;
    }))).flat(),
    ...(await collectConformanceSources()),
    "scripts/profile-native-cpu.ts",
  ];
  // Anchors proving the walk really reached the places advice is emitted from.
  expect(sources).toContain("packages/playtest/src/runner/doctor.ts");
  expect(sources).toContain("scripts/profile-native-cpu.ts");

  const offenders: string[] = [];
  for (const source of sources) {
    const text = await readFile(join(repoRoot, source), "utf8");
    const lines = text.split("\n");
    lines.forEach((line, index) => {
      if (!line.includes("xvfb-run")) return;
      if (allowedXvfbRunMentions.some((allowed) => source === allowed || source.startsWith(allowed))) return;
      const sentence = lines.slice(Math.max(0, index - 3), index + 4).join(" ");
      if (!warningCarried.test(sentence)) offenders.push(`${source}:${index + 1}`);
    });
  }
  expect(offenders).toEqual([]);
});
