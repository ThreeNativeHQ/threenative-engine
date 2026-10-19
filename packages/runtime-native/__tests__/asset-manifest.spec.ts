/**
 * One packaging selector for every target.
 *
 * Copying only what the build named broke real games: `public/` holds hand-placed runtime files
 * the manifest never names (Ogg audio, GLBs, the Basis transcoder), and dropping those breaks
 * play. So the selector keeps the manifest's own outputs, keeps what no cook produced, and
 * drops what a previous cook produced and this one did not — an orphan digest output is the one
 * shape a stale bake leaves behind, and it is the shape that quietly ships forever. This proves
 * all three packagers stage through that one rule and that the web outDir loses the orphan too.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTempDirSync } from "../../../test-support/temp-dir.js";

// @ts-expect-error -- plain ESM with no type declarations.
import { selectManifestAssets } from "../scripts/asset-manifest.mjs";
// @ts-expect-error -- plain ESM with no type declarations.
import { stageAndroidAssets } from "../scripts/package-android.mjs";
// @ts-expect-error -- plain ESM with no type declarations.
import { stageDesktopFiles } from "../scripts/package-desktop.mjs";
// @ts-expect-error -- plain ESM with no type declarations.
import { stageIosAssets } from "../scripts/package-ios.mjs";
// @ts-expect-error -- plain ESM with no type declarations.
import { minimalGlb } from "../tests/fixtures/minimal-glb.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
  vi.restoreAllMocks();
});

function fixture() {
  const root = makeTempDirSync("threenative-manifest-assets-");
  roots.push(root);
  const assets = join(root, "public");
  mkdirSync(join(assets, "hand"), { recursive: true });
  writeFileSync(join(assets, "a.1234abcd.png"), "png");
  writeFileSync(join(assets, "a.99999999.png"), "old");
  // A cook output no current bake declares: an orphan. Nothing loads it; it must not ship.
  writeFileSync(join(assets, "c.deadbeef.png"), "orphan cook output");
  // A hand-placed file no cook produced: real game content, and it ships.
  writeFileSync(join(assets, "hand/level.json"), "{}");
  writeFileSync(join(assets, "b.glb"), minimalGlb());
  writeFileSync(join(assets, "a.png.orig"), "stray");
  writeFileSync(join(assets, ".DS_Store"), "junk");
  writeFileSync(
    join(assets, "assets.manifest.json"),
    JSON.stringify({
      version: 1,
      entries: {
        "a.png": { output: "a.1234abcd.png", kind: "texture" },
        "b.glb": { output: "b.glb", kind: "model" },
      },
    }),
  );
  return { assets, root };
}

describe("the asset selector drops what this cook did not produce", () => {
  it("keeps the declared and hand-placed files, drops the orphan, and prints both skips", () => {
    const { assets } = fixture();
    const lines: string[] = [];
    const selected = selectManifestAssets(assets, { log: (line: string) => lines.push(line) });
    assert.deepEqual(selected.selected, [
      "a.1234abcd.png",
      "assets.manifest.json",
      "b.glb",
      "hand/level.json",
    ]);
    assert.deepEqual(selected.dropped, [
      ".DS_Store",
      "a.99999999.png",
      "a.png.orig",
      "c.deadbeef.png",
    ]);
    // Two unmanaged files ship: the manifest itself and `hand/level.json`, which is 2 bytes.
    assert.equal(selected.unmanagedFiles, 2);
    assert.equal(selected.unmanagedBytes, statSync(join(assets, "assets.manifest.json")).size + 2);
    assert.deepEqual(lines, [
      "ThreeNative packaging: skipped .DS_Store (editor leftover)",
      "ThreeNative packaging: skipped a.99999999.png (cook output this build does not declare, superseded by a.1234abcd.png)",
      "ThreeNative packaging: skipped a.png.orig (editor leftover)",
      "ThreeNative packaging: skipped c.deadbeef.png (cook output this build does not declare)",
      "ThreeNative packaging: 2 unmanaged file(s), 122 bytes, are not declared by assets.manifest.json.",
    ]);
  });

  it("keeps a manifest-declared auxiliary output the entry does not own as its own path", () => {
    const root = makeTempDirSync("threenative-manifest-auxiliary-");
    roots.push(root);
    const assets = join(root, "public");
    mkdirSync(assets, { recursive: true });
    writeFileSync(join(assets, "hero.11111111.glb"), minimalGlb());
    writeFileSync(join(assets, "hero.22222222.png"), "shared image");
    writeFileSync(
      join(assets, "assets.manifest.json"),
      JSON.stringify({
        version: 1,
        entries: {
          "hero.fbx": {
            output: "hero.11111111.glb",
            kind: "model",
            lightmaps: [{ output: "hero.22222222.png", bytes: 13 }],
          },
        },
      }),
    );
    const selected = selectManifestAssets(assets, { log: () => {} });
    assert.deepEqual(selected.selected, [
      "assets.manifest.json",
      "hero.11111111.glb",
      "hero.22222222.png",
    ]);
    assert.deepEqual(selected.dropped, []);
  });

  it("fails closed when a named file is missing from disk", () => {
    const { assets } = fixture();
    rmSync(join(assets, "b.glb"));
    expect(() => selectManifestAssets(assets, { log: () => {} })).toThrow(
      /TN_ASSETS_MANIFEST_MISSING/u,
    );
    expect(() => selectManifestAssets(assets, { log: () => {} })).toThrow(/b\.glb/u);
  });

  it("without a manifest skips only the editor junk and keeps digest-shaped files", () => {
    const root = makeTempDirSync("threenative-manifest-assets-bare-");
    roots.push(root);
    const assets = join(root, "public");
    mkdirSync(assets, { recursive: true });
    writeFileSync(join(assets, "a.99999999.png"), "digest-shaped");
    writeFileSync(join(assets, "b.glb"), minimalGlb());
    writeFileSync(join(assets, "x.png.orig"), "stray");
    writeFileSync(join(assets, ".DS_Store"), "junk");
    const lines: string[] = [];
    const selected = selectManifestAssets(assets, { log: (line: string) => lines.push(line) });
    assert.deepEqual(selected.selected, ["a.99999999.png", "b.glb"]);
    assert.deepEqual(lines, [
      "ThreeNative packaging: skipped .DS_Store (editor leftover)",
      "ThreeNative packaging: skipped x.png.orig (editor leftover)",
    ]);
  });

  it("stages a hand-placed file no cook produces, whatever its extension", () => {
    // PRD-492 filed this as "the desktop packager drops every undeclared public/ file", from a
    // `TN_GRADE_TABLE grade.cube: File read error` on the starter's desktop run. It does not: the
    // selector's rule 3 keeps what no cook produced, so a colour table — an extension no asset
    // pipeline emits — stages on every native target exactly like the level JSON above. What was
    // actually missing was the file: that run's scaffold had no `public/grade.cube` in it. The
    // guard stands so the next report of this shape is checked here first.
    const root = makeTempDirSync("threenative-manifest-undeclared-");
    roots.push(root);
    const assets = join(root, "public");
    mkdirSync(assets, { recursive: true });
    writeFileSync(join(assets, "grade.cube"), "LUT_3D_SIZE 2\n0 0 0\n");
    writeFileSync(join(assets, "b.glb"), minimalGlb());
    writeFileSync(
      join(assets, "assets.manifest.json"),
      JSON.stringify({ version: 1, entries: { "b.glb": { output: "b.glb", kind: "model" } } }),
    );
    const bundle = join(root, "bundle.js");
    writeFileSync(bundle, "export default 1;");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const desktop = join(root, "desktop");
    const android = join(root, "android");
    const ios = join(root, "ios");
    mkdirSync(desktop, { recursive: true });
    mkdirSync(ios, { recursive: true });
    stageDesktopFiles(bundle, assets, desktop);
    stageAndroidAssets(assets, android);
    stageIosAssets(assets, ios);
    for (const destination of [desktop, android, ios]) {
      assert.equal(
        existsSync(join(destination, "grade.cube")),
        true,
        `${destination} colour table`,
      );
    }
  });

  it("Android, desktop and iOS staging all drop the orphan and keep the rest", () => {
    const { assets, root } = fixture();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const android = join(root, "android");
    const desktop = join(root, "desktop");
    const ios = join(root, "ios");
    mkdirSync(desktop, { recursive: true });
    mkdirSync(ios, { recursive: true });
    const bundle = join(root, "bundle.js");
    writeFileSync(bundle, "export default 1;");
    const expected = ["a.1234abcd.png", "assets.manifest.json", "b.glb", "hand/level.json"];
    assert.deepEqual(stageAndroidAssets(assets, android), expected);
    stageDesktopFiles(bundle, assets, desktop);
    assert.deepEqual(stageIosAssets(assets, ios), expected);
    for (const destination of [android, desktop, ios]) {
      assert.equal(existsSync(join(destination, "c.deadbeef.png")), false, `${destination} orphan`);
      assert.equal(existsSync(join(destination, "a.99999999.png")), false, `${destination} stale`);
      assert.equal(existsSync(join(destination, "a.png.orig")), false, `${destination} junk`);
      assert.equal(
        existsSync(join(destination, "hand/level.json")),
        true,
        `${destination} managed`,
      );
      assert.equal(existsSync(join(destination, "b.glb")), true, `${destination} declared`);
    }
    assert.ok(
      spy.mock.calls.some(([line]) =>
        String(line).includes("skipped a.png.orig (editor leftover)"),
      ),
      "the stray path must be printed",
    );
  });
});
