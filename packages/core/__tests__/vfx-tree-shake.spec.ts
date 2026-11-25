import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { describe, expect, it } from "vitest";
import * as presets from "../src/vfx/presets.js";

const VFX_ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/vfx/index.ts");

/** The layer ids each recipe writes: unique strings that only that recipe's data carries. */
function layerIds(recipe: (position: presets.ArchiveVec3) => presets.ArchiveLayer[]): string[] {
  return recipe([0, 0, 0]).map((layer) => layer.id.replace(/-\d+$/u, ""));
}

describe("@threenative/core/vfx tree shaking", () => {
  it("ships only the imported effect's recipe", () => {
    const result = buildSync({
      stdin: {
        contents: `export { createHealingAura } from ${JSON.stringify(VFX_ENTRY)};`,
        resolveDir: path.dirname(VFX_ENTRY),
        loader: "ts",
      },
      bundle: true,
      external: ["three", "three/*"],
      format: "esm",
      platform: "neutral",
      treeShaking: true,
      write: false,
    });
    const output = result.outputFiles[0]?.text ?? "";
    for (const id of layerIds(presets.healingAuraLayers)) expect(output).toContain(id);

    const others = Object.entries(presets).filter(
      ([name, value]) =>
        name.endsWith("Layers") && name !== "healingAuraLayers" && typeof value === "function",
    );
    expect(others).toHaveLength(45);
    const leaked = others.flatMap(([name, recipe]) =>
      layerIds(recipe as Parameters<typeof layerIds>[0])
        .filter((id) => output.includes(`"${id}`) || output.includes(`\`${id}`))
        .map((id) => `${name}:${id}`),
    );
    expect(leaked).toEqual([]);
  });
});
