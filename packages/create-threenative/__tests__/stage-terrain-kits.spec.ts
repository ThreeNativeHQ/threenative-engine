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

  it("reads the sky HDRI from a bake call in any layout (audit STRATA-09)", async () => {
    const root = await makeTempDir("stage-kits-format-");
    const copy = path.join(root, "create-threenative", "scripts", "stage-terrain-kits.mjs");
    await mkdir(path.dirname(copy), { recursive: true });
    await mkdir(path.join(root, "terrain", "dist"), { recursive: true });
    await copyFile(script, copy);
    await writeFile(
      path.join(root, "terrain", "dist", "kit.js"),
      `export const starterAssetsDir = async () => ${JSON.stringify(path.join(terrain, "starter-assets"))};\n`,
    );
    for (const kit of KITS) {
      const dir = path.join(root, "terrain", "starter", kit);
      const real = path.join(terrain, "starter", kit);
      await mkdir(dir, { recursive: true });
      for (const file of (await readdir(real)).filter((name) => name !== "bake.mjs"))
        await symlink(path.join(real, file), path.join(dir, file));
      // The same call as the real bake, with the sky on the call line and no trailing comma.
      const bake = (await readFile(path.join(real, "bake.mjs"), "utf8")).replace(
        /\{\n\s*(sky: "[^"]+"),\n/u,
        "{ $1 ",
      );
      expect(bake).toMatch(/\{ sky: "[^"]+" /u);
      await writeFile(path.join(dir, "bake.mjs"), bake);
    }
    await run(process.execPath, [copy]);
    const credits = JSON.parse(
      await readFile(
        path.join(
          root,
          "create-threenative",
          "template-assets",
          "terrain",
          "alpine",
          "credits.json",
        ),
        "utf8",
      ),
    );
    expect(credits.files.some((entry: { file: string }) => entry.file.startsWith("hdri/"))).toBe(
      true,
    );
  });
});
