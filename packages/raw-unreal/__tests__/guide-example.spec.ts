import { readFile } from "node:fs/promises";
import { decompress as oodle } from "ooz-wasm";
import { DefaultLoadingManager, Mesh } from "three";
import { describe, expect, it } from "vitest";

import { UAssetLoader } from "../src/index.js";

/**
 * `docs/guides/unreal-assets.md` tells a reader to hand three.js's shared loading manager to
 * `UAssetLoader`. That line is run here, from the guide's own text, because `guide-imports.spec.ts`
 * cannot judge it: `DefaultLoadingManager` is a real export, so an import check passes while
 * `new DefaultLoadingManager()` still throws. The real shared instance stands in, because
 * `new <a real instance>` is the failure this catches and a plain object would not be one.
 */
const guide = await readFile(
  new URL("../../../docs/guides/unreal-assets.md", import.meta.url),
  "utf8",
);
const written = [...guide.matchAll(/new\s+UAssetLoader\([^)]*\)/gu)].map((match) => match[0]);
const shared = written.filter((line) => line.includes("DefaultLoadingManager"));

describe("the Unreal guide's loader example", () => {
  it("passes the shared manager as a value, never as a class", () => {
    expect(shared).toEqual(["new UAssetLoader(DefaultLoadingManager)"]);
  });

  it("runs that line and parses the committed fixture through it", async () => {
    const loader = new Function("DefaultLoadingManager", "UAssetLoader", `return ${shared[0]}`)(
      DefaultLoadingManager,
      UAssetLoader,
    ) as UAssetLoader;
    expect(loader.manager).toBe(DefaultLoadingManager);

    // The fixture is an Oodle-compressed UE5 package, so the codec is injected the way the guide's
    // codec table says to inject one.
    loader.options.parse = { oodle };
    const object = loader.parse(
      new Uint8Array(await readFile(new URL("../fixtures/SM_cube.uasset", import.meta.url))),
    );
    expect(object).toBeInstanceOf(Mesh);
    expect(object.name).toBe("SM_cube");
  });
});
