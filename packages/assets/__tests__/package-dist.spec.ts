import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { buildFixtureGlb } from "../../../test-support/generate-fixture-model.js";

type AssetsDist = { readonly modelPass: typeof import("../src/index.js").modelPass };

/**
 * The published package must keep its glTF-Transform graph private. `extensions` and
 * `functions` accept a range for `core`; a consumer that also installs a newer CLI can otherwise
 * make those helpers inspect properties from a different `core` instance than the document reader.
 */
describe("packed @threenative/assets", () => {
  it("should ship the package-owned Basis encoder and its modification notice", async () => {
    const manifest = JSON.parse(
      await readFile(path.resolve("packages/assets/package.json"), "utf8"),
    ) as { dependencies?: Record<string, string>; files?: string[] };
    expect(manifest.dependencies?.["ktx2-encoder"]).toBeUndefined();
    expect(manifest.files).toContain("THIRD_PARTY_NOTICES.md");
    expect(manifest.files).toContain("LICENSES");
    await expect(
      readFile(path.resolve("packages/assets/dist/basis_encoder.wasm")),
    ).resolves.not.toHaveLength(0);
    await expect(
      readFile(path.resolve("packages/assets/THIRD_PARTY_NOTICES.md"), "utf8"),
    ).resolves.toContain("raised from 12 to 16 Mi texels");
    await expect(
      readFile(path.resolve("packages/assets/LICENSES/Basis-Universal-Apache-2.0.txt"), "utf8"),
    ).resolves.toContain("Apache License");
  });

  it("should bundle glTF-Transform and run the model pass from the packed output", async () => {
    const dist = new URL("../dist/index.js", import.meta.url);
    const source = await readFile(dist, "utf8");

    expect(source).not.toMatch(
      /^\s*import .* from ['"]@gltf-transform\/(?:core|extensions|functions)['"];?$/mu,
    );

    const { modelPass } = (await import(pathToFileURL(dist.pathname).href)) as AssetsDist;
    const result = await modelPass({
      textures: { overrides: [{ slot: "normalTexture", codec: "uastc" }] },
    }).apply(Buffer.from(await buildFixtureGlb()), "character.glb");

    expect(Buffer.isBuffer(result)).toBe(false);
    if (Buffer.isBuffer(result)) return;
    expect(result.entry?.extensions).toEqual(
      expect.arrayContaining(["EXT_meshopt_compression", "KHR_texture_basisu"]),
    );
  });

  // The registry cannot resolve an unpublished package, so a published one that names it cannot be
  // installed at all:
  //
  //   ERR_PNPM_FETCH_404 GET https://registry.npmjs.org/@threenative/blender-bridge: Not Found
  //   This error happened while installing the dependencies of @threenative/assets@0.3.0
  //
  // which killed `pnpm dlx --package <assets tarball>` and every scaffold with it. The Blender
  // bridge is inlined and its scripts are copied into `dist/`, exactly as `@threenative/core`
  // carries the blender server, so this package declares no runtime dependency on it.
  it("should carry the Blender scripts rather than depending on the server package", async () => {
    const manifest = JSON.parse(
      await readFile(path.resolve("packages/assets/package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(manifest.dependencies?.["@threenative/blender-bridge"]).toBeUndefined();
    expect(manifest.devDependencies?.["@threenative/blender-bridge"]).toBe("workspace:*");

    const copied = path.resolve("packages/assets/dist/blender-gpl");
    const script = await readFile(path.join(copied, "convert.py"), "utf8");
    // The GPL boundary travels with the copy.
    expect(script).toContain("SPDX-License-Identifier: GPL-2.0-or-later");
    await expect(readFile(path.join(copied, "LICENSE.GPL"), "utf8")).resolves.toContain(
      "GNU GENERAL PUBLIC LICENSE",
    );
    for (const recipe of ["decimate.py", "unwrap.py", "bake_ao.py", "retarget.py", "_common.py"]) {
      await expect(
        readFile(path.join(copied, "recipes", recipe), "utf8"),
        recipe,
      ).resolves.toContain("SPDX-License-Identifier: GPL-2.0-or-later");
    }

    // And the bridge is inlined, not imported: a bare specifier here would fail at runtime in a
    // published install even though nothing declares it.
    const bundle = await readFile(path.resolve("packages/assets/dist/index.js"), "utf8");
    expect(bundle).not.toMatch(/from\s*["']@threenative\/blender-bridge/u);
  });
});
