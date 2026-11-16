/**
 * PRD-806 E03: a reused `KIT_ARTIFACTS` must not feed the kit summary a previous run's artifacts.
 *
 * The artefact guards were left in place when the wipe they guard was dropped, so a second run into
 * the same directory kept the old `capture.json` and PNGs. `prepareArtifacts` owns the pair: it
 * refuses a path that would delete a source checkout, then empties the directory it may write.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

const verifierUrl = new URL("../scripts/verify/verify-starter-kit.mjs", import.meta.url).href;

it("empties a reused artifact directory so the summary reads this run's capture", async () => {
  const { prepareArtifacts } = await import(verifierUrl);
  expect(prepareArtifacts).toBeTypeOf("function");
  if (typeof prepareArtifacts !== "function") return;

  const base = mkdtempSync(join(tmpdir(), "prd806-artifacts-"));
  try {
    const game = join(base, "game");
    const artifacts = join(base, "artifacts");
    mkdirSync(join(artifacts, "views"), { recursive: true });
    writeFileSync(join(artifacts, "capture.json"), '{"rendererKind":"stale"}');
    writeFileSync(join(artifacts, "views/edge.png"), "stale");

    prepareArtifacts(artifacts, game);

    expect(existsSync(artifacts), "the directory the playtest writes into survives").toBe(true);
    expect(readdirSync(artifacts), "nothing from the previous run is left to be read").toEqual([]);
  } finally {
    rmSync(base, { force: true, recursive: true });
  }
});

it("refuses an artifact directory inside the kept game instead of emptying it", async () => {
  const { prepareArtifacts } = await import(verifierUrl);
  expect(prepareArtifacts).toBeTypeOf("function");
  if (typeof prepareArtifacts !== "function") return;

  const base = mkdtempSync(join(tmpdir(), "prd806-guard-"));
  try {
    const game = join(base, "game");
    mkdirSync(join(game, "src"), { recursive: true });
    writeFileSync(join(game, "src/game.ts"), "sentinel");

    expect(() => prepareArtifacts(join(game, "artifacts"), game)).toThrow(
      "artifact output must stay outside the kept game",
    );
    expect(readdirSync(join(game, "src")), "the guard fires before anything is removed").toEqual([
      "game.ts",
    ]);
  } finally {
    rmSync(base, { force: true, recursive: true });
  }
});

it("refuses to pack a package whose src is newer than its dist", async () => {
  const { staleBuild } = await import(verifierUrl);
  const root = mkdtempSync(join(tmpdir(), "tn-stale-build-"));
  try {
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "src", "a.ts"), "export {};");
    writeFileSync(join(root, "dist", "a.js"), "export {};");
    utimesSync(join(root, "dist", "a.js"), new Date(2026, 0, 2), new Date(2026, 0, 2));
    utimesSync(join(root, "src", "a.ts"), new Date(2026, 0, 1), new Date(2026, 0, 1));
    expect(staleBuild(root)).toBeUndefined();
    utimesSync(join(root, "src", "a.ts"), new Date(2026, 0, 3), new Date(2026, 0, 3));
    expect(staleBuild(root)).toMatch(/src\/ is newer than dist\//);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
