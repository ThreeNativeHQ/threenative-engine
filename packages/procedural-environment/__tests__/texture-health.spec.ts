import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { bakeVegetation, vegetationPresets } from "../src/index.js";

/** Presets with no leaf, blade or frond: wood, stone and the leafless saguaro. */
const NO_FOLIAGE = new Set(["log", "stump", "twig", "branch", "rock", "saguaro"]);

/**
 * Presets that keep Arbor's drawn leaf card, each because no CC0 scan fits its card. Keep it short:
 * a new scan family removes its rows, and a row whose preset now wears a scan fails below.
 */
const DRAWN: Readonly<Record<string, string>> = {
  ginkgo: "no fan-shaped ginkgo leaf scan on Poly Haven or ambientCG",
  coconut: "no pinnate palm frond scan",
  fanpalm: "no palm fan leaf scan",
  banana: "no banana leaf scan",
  joshua: "no yucca dagger rosette scan",
  daisy: "no flower-head scan",
  poppy: "no flower-head scan",
  marigold: "no flower-head scan",
  elephantear: "no arrowhead leaf scan",
};

interface IGltf {
  materials: { name: string; pbrMetallicRoughness?: { baseColorTexture?: { index: number } } }[];
  meshes: { primitives: { material: number }[] }[];
}

async function materials(file: string): Promise<IGltf["materials"]> {
  const bytes = await readFile(file);
  const gltf = JSON.parse(
    bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString("utf8"),
  ) as IGltf;
  return (gltf.meshes[0]?.primitives ?? []).map((p) => gltf.materials[p.material] ?? { name: "" });
}

describe("texture health: every leaf, blade and frond wears a texture, scanned where a scan fits", () => {
  it("finds no foliage without a baseColorTexture and no drawn leaf card where a scan exists", async () => {
    const out = await makeTempDir("tn-texture-health-");
    const rows: { id: string; textured: boolean; scanned: boolean; drawn: boolean }[] = [];
    for (const { id } of vegetationPresets().filter((p) => !NO_FOLIAGE.has(p.id))) {
      const [baked] = await bakeVegetation({ out, preset: id, lods: [2] });
      const foliage = (await materials(baked?.path ?? "")).find((m) => m.name === "foliage");
      rows.push({
        drawn: DRAWN[id] !== undefined,
        id,
        scanned: baked?.leafScan !== undefined,
        textured: foliage?.pbrMetallicRoughness?.baseColorTexture !== undefined,
      });
    }
    const ids = (keep: (row: (typeof rows)[number]) => boolean) =>
      rows.filter(keep).map((row) => row.id);
    expect({
      // (a) a leaf, blade or frond with no texture at all
      untextured: ids((row) => !row.textured),
      // (b) Arbor's drawn card where a scan exists
      drawn: ids((row) => !row.scanned && !row.drawn),
      // an allowlist row whose preset now wears a scan
      stale: ids((row) => row.scanned && row.drawn),
    }).toEqual({ untextured: [], drawn: [], stale: [] });
  }, 240_000);

  it('keeps the drawn leaf card with textures: "generated"', async () => {
    const out = await makeTempDir("tn-texture-health-gen-");
    const [oak] = await bakeVegetation({ out, preset: "oak", lods: [2], textures: "generated" });
    expect(oak?.leafScan).toBeUndefined();
  });
});
