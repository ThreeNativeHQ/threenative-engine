// Run with <out dir> (the starter art's `alpine_flora/`); needs @threenative/procedural-vegetation.
// Bakes the alpine stand's conifers once into GLBs the species pack (`render/props/pack.ts`) draws:
// Norway spruce (Picea abies) is the tree of the Kleine Scheidegg slopes, with black spruce for
// variety (the conifer bake-off winner, PRD-892). The same preset, seed, form and level always write
// the same bytes.
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bakeVegetation } from "@threenative/procedural-vegetation";

const out = process.argv[2];
if (!out) throw new Error("bake-flora: pass the output folder, e.g. starter-assets/alpine_flora");

/**
 * Norway spruce at the tree line is a dense, narrow cone to its tip. Arbor's stock spray is a
 * torso-sized card, which reads as a fern leaf: the form halves the card, doubles the count, packs
 * more whorls toward the leader and shortens the branches so the crown narrows.
 */
const SPRUCE_FORM = {
  levels: [{ kids: 104 }, { len: 0.25 }],
  leaves: [{ count: 56, size: [0.62, 0.38] }],
};
const BLACKSPRUCE_FORM = { leaves: [{ count: 22, size: [0.46, 0.33] }] };

/** [file, preset, seed, form]: each writes `<file>-near.glb` (lod 1) and `<file>-mid.glb` (lod 2). */
const ROWS = [
  ["spruce-a", "spruce", 1, SPRUCE_FORM],
  ["spruce-b", "spruce", 2, SPRUCE_FORM],
  ["spruce-c", "spruce", 3, SPRUCE_FORM],
  ["blackspruce-a", "blackspruce", 1, BLACKSPRUCE_FORM],
  ["blackspruce-b", "blackspruce", 2, BLACKSPRUCE_FORM],
];
const SUFFIX = { 1: "-near", 2: "-mid" };

await mkdir(out, { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), "alpine-flora-"));
try {
  for (const [file, preset, seed, form] of ROWS) {
    for (const level of await bakeVegetation({ preset, seed, form, lods: [1, 2], out: scratch })) {
      const name = `${file}${SUFFIX[level.lod]}.glb`;
      await cp(level.path, join(out, name));
      const height = (level.bounds.max[1] - level.bounds.min[1]).toFixed(1);
      console.log(
        `${name}  ${preset}@${seed} lod${level.lod}  ${level.triangles} triangles  ${height} m`,
      );
    }
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
