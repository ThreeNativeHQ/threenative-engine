import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { makeTempDir } from "../../test-support/temp-dir.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const binaryAssetExtensions = new Set([
  ".ttf",
  ".otf",
  ".woff",
  ".woff2",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".glb",
  ".wasm",
  ".mp3",
  ".wav",
  ".ogg",
  ".mp4",
]);

function sourceHygiene(root: string) {
  const files = execFileSync(
    "git",
    ["-C", root, "ls-files", "packages/*/src/**", "examples/*/src/**", "scripts/**/*.ts"],
    { encoding: "utf8" },
  )
    .split("\n")
    .filter(
      (file) => file.length > 0 && !binaryAssetExtensions.has(path.extname(file).toLowerCase()),
    );
  return {
    files,
    bad: files.filter((file) => readFileSync(path.join(root, file), "utf8").includes("\0")),
  };
}

/**
 * A NUL byte inside shipped source survives the bundler, and the native host reads scripts
 * through a C-string boundary — so a game bundle truncates at the byte and V8 reports an
 * unrelated "Unexpected end of input" (PRD-222 loop, 2026-08-25: `385fd50e` shipped one inside
 * `packages/core/src/projection-plan.ts`; desktop-native bundles failed to load while minified
 * Android bundles masked it by rewriting the literal). Web never notices, so this stays red on
 * native only unless something scans for it.
 *
 * The scan walks `git ls-files` rather than the working tree so generated and untracked trees
 * cannot flake it, and names every offending file, which is what a red needs.
 */
describe("shipped sources contain no NUL bytes", () => {
  test("every tracked text source under packages, examples and scripts is NUL-free", () => {
    const { files, bad } = sourceHygiene(repoRoot);
    expect(files.length).toBeGreaterThan(100);

    // The working tree is what bundles build from, so that is what the scan reads — a fix
    // goes green as soon as the byte is gone, not only once it is committed.
    expect(bad).toEqual([]);
  });

  test("accepts binary UI assets while still rejecting a NUL inside TypeScript", async () => {
    const root = await makeTempDir("threenative-source-hygiene-");
    execFileSync("git", ["-C", root, "init", "--quiet"]);
    const source = "examples/control/src/ui.ts";
    const font = "examples/control/src/ui/font.ttf";
    const image = "examples/control/src/ui/image.png";
    mkdirSync(path.join(root, "examples/control/src/ui"), { recursive: true });
    writeFileSync(path.join(root, source), "export const value = 'a\0b';");
    writeFileSync(path.join(root, font), Buffer.from([0, 1, 2]));
    writeFileSync(path.join(root, image), Buffer.from([137, 80, 78, 71, 0]));
    execFileSync("git", ["-C", root, "add", "examples"]);
    expect(sourceHygiene(root)).toEqual({ files: [source], bad: [source] });
    writeFileSync(path.join(root, source), "export const value = 'a\\0b';");
    expect(sourceHygiene(root)).toEqual({ files: [source], bad: [] });
  });
});
