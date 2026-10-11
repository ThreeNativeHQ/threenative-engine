import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

import { makeTempDir } from "../../../test-support/temp-dir.js";

import { NativeEntryKind, readNativePackageManifest } from "../../assets/src/native-package.js";
import { cookNativeEngineAssets } from "../scripts/bundle-native-engine.mjs";

describe("cookNativeEngineAssets", () => {
  it("cooks the project's assets into the package the native player reads beside its bundle", async () => {
    const project = await makeTempDir("tn-native-engine-assets-");
    await mkdir(path.join(project, "assets"));
    const image = new PNG({ height: 2, width: 2 });
    image.data.fill(255);
    await writeFile(path.join(project, "assets", "tile.png"), PNG.sync.write(image));
    await writeFile(
      path.join(project, "threenative.config.ts"),
      'export default { assets: { models: "none", textures: "none" } };\n',
    );
    const outfile = path.join(project, "out", "game.js");

    const written = await cookNativeEngineAssets({ outfile, project });

    expect(written).toBe(path.join(project, "out", "native", "assets.tnpk"));
    const manifest = readNativePackageManifest(await readFile(written));
    expect(manifest.entries.map((entry) => [entry.name, entry.kind])).toEqual([
      ["tile.png", NativeEntryKind.Texture],
    ]);
  });

  it("cooks an explicit asset source when the project keeps none of its own", async () => {
    // A bare template gets its assets only when scaffolded; the Perry bench reads them in place.
    const project = await makeTempDir("tn-native-engine-assets-");
    const shared = await makeTempDir("tn-native-engine-shared-");
    const image = new PNG({ height: 2, width: 2 });
    image.data.fill(255);
    await writeFile(path.join(shared, "tile.png"), PNG.sync.write(image));
    await writeFile(
      path.join(project, "threenative.config.ts"),
      'export default { assets: { models: "none", textures: "none" } };\n',
    );

    const written = await cookNativeEngineAssets({
      outfile: path.join(project, "out", "game.js"),
      project,
      source: shared,
    });

    const manifest = readNativePackageManifest(await readFile(written));
    expect(manifest.entries.map((entry) => entry.name)).toEqual(["tile.png"]);
  });
});
