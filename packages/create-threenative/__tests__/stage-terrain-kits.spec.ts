import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";

const run = promisify(execFile);
const script = fileURLToPath(new URL("../scripts/stage-terrain-kits.mjs", import.meta.url));

const terrain = fileURLToPath(new URL("../../terrain", import.meta.url));
const KITS = ["alpine", "coastal", "desert", "tundra"];
/** The file the cook copies into a world's `sky.hdr`, as the kit names it. */
const SKY = "hdri/kloofendal_48d_partly_cloudy_1k.hdr";

/**
 * A tree holding this script beside real kit sources: the terrain package is a fake `kit.js` whose
 * only exports are the ones the script reads, and the asset table is a copy the test may edit.
 */
async function fixture(prefix: string, sky: string): Promise<string> {
  const root = await makeTempDir(prefix);
  const copy = path.join(root, "create-threenative", "scripts", "stage-terrain-kits.mjs");
  await mkdir(path.dirname(copy), { recursive: true });
  await mkdir(path.join(root, "terrain", "dist"), { recursive: true });
  await mkdir(path.join(root, "terrain", "starter-assets"), { recursive: true });
  await copyFile(script, copy);
  await writeFile(
    path.join(root, "terrain", "dist", "kit.js"),
    `export const DEFAULT_SKY_HDRI = ${JSON.stringify(sky)};\n` +
      `export const starterAssetsDir = async () => ${JSON.stringify(path.join(root, "terrain", "starter-assets"))};\n`,
  );
  for (const kit of KITS) {
    const dir = path.join(root, "terrain", "starter", kit);
    const real = path.join(terrain, "starter", kit);
    await mkdir(dir, { recursive: true });
    for (const file of await readdir(real))
      await symlink(path.join(real, file), path.join(dir, file));
  }
  await copyFile(
    path.join(terrain, "starter-assets", "credits.json"),
    path.join(root, "terrain", "starter-assets", "credits.json"),
  );
  return root;
}

const stagedCredits = (root: string): Promise<string> =>
  readFile(
    path.join(root, "create-threenative", "template-assets", "terrain", "alpine", "credits.json"),
    "utf8",
  );

describe("stage-terrain-kits", () => {
  it("names the missing terrain build instead of a module resolution error (audit STRATA-08)", async () => {
    // A cold tree: the sibling terrain package has no dist/.
    const root = await makeTempDir("stage-kits-cold-");
    const copy = path.join(root, "create-threenative", "scripts", "stage-terrain-kits.mjs");
    await mkdir(path.dirname(copy), { recursive: true });
    await mkdir(path.join(root, "terrain"), { recursive: true });
    await copyFile(script, copy);
    const failure = await run(process.execPath, [copy]).then(
      () => undefined,
      (error: { stderr: string }) => error,
    );
    expect(failure?.stderr).toContain("TN_TERRAIN_STAGE_MISSING_BUILD");
    expect(failure?.stderr).toContain("pnpm --filter @threenative/terrain build");
  });

  it("credits the sky the cook copies, under the cook's own name (audit STRATA-09)", async () => {
    // The kits' bakes name no sky: the cook copies `DEFAULT_SKY_HDRI` into `sky.hdr` (PRD-892), so
    // the credits follow that constant instead of parsing a call the kits no longer make.
    const root = await fixture("stage-kits-sky-", SKY);
    await run(process.execPath, [
      path.join(root, "create-threenative", "scripts", "stage-terrain-kits.mjs"),
    ]);
    const credits = JSON.parse(await stagedCredits(root)) as {
      files: { file: string; license?: string; sha256?: string }[];
    };
    const record = credits.files.find((entry) => entry.file === SKY);
    // The sky record carries its own provenance; no set is copied with it.
    expect(record).toMatchObject({
      asset: expect.any(String),
      license: "CC0",
      sha256: expect.any(String),
    });
  });

  it("fails closed when the asset table does not record that sky (audit STRATA-09)", async () => {
    const root = await fixture("stage-kits-nosky-", SKY);
    const table = JSON.parse(
      await readFile(path.join(root, "terrain", "starter-assets", "credits.json"), "utf8"),
    ) as { files: { file: string }[] };
    await writeFile(
      path.join(root, "terrain", "starter-assets", "credits.json"),
      JSON.stringify({ ...table, files: table.files.filter((entry) => entry.file !== SKY) }),
    );
    const failure = await run(process.execPath, [
      path.join(root, "create-threenative", "scripts", "stage-terrain-kits.mjs"),
    ]).then(
      () => undefined,
      (error: { stderr: string }) => error,
    );
    expect(failure?.stderr).toContain("TN_TERRAIN_STAGE_METADATA");
    expect(failure?.stderr).toContain(SKY);
  });
});
