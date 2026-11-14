// Regenerates packages/assets/__tests__/fixtures/foliage-conifer.glb.
//   node packages/assets/__tests__/fixtures/foliage-conifer.mjs
// The geometry is the engine's own procedural vegetation bake (an Arbor spruce, PRD-884). The committed
// GLB predates it and came from the EZ Tree exporter this script used before; regenerating writes an
// Arbor spruce, so refresh `gltf_reference.json` and the specs that read the fixture's counts with it.
// The leaf material is then re-authored as the shape a real tree pack ships: `BLEND` with the alpha in
// the base-colour texture, not the exporter's placeholder `MASK`, because that is the case PRD-458 §4
// is about.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import { bakeVegetation } from "@threenative/procedural-vegetation";
import { PNG } from "pngjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SIZE = 64;

/** A needle card: opaque along the middle, transparent at the edges, so a silhouette is visible. */
function needleAlpha() {
  const png = new PNG({ width: SIZE, height: SIZE });
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const edge = Math.min(x, SIZE - 1 - x, y, SIZE - 1 - y) / ((SIZE - 1) / 6);
      const i = (SIZE * y + x) * 4;
      png.data[i] = 96;
      png.data[i + 1] = 128;
      png.data[i + 2] = 64;
      png.data[i + 3] = Math.round(Math.max(0, Math.min(1, edge)) * 255);
    }
  }
  return PNG.sync.write(png);
}

const scratch = await mkdtemp(path.join(tmpdir(), "tn-conifer-"));
try {
  const [baked] = await bakeVegetation({ lods: [1], out: scratch, preset: "spruce", seed: 42 });
  const source = await new NodeIO().read(baked.path);
  const needles = source
    .getRoot()
    .listMaterials()
    .find((material) => material.getName() === "foliage");
  if (needles === undefined) throw new Error("The baked tree has no foliage material.");
  const texture = source
    .createTexture("needle-alpha")
    .setImage(needleAlpha())
    .setMimeType("image/png");
  needles.setBaseColorTexture(texture).setAlphaMode("BLEND").setDoubleSided(true);
  const out = path.join(here, "foliage-conifer.glb");
  const glb = await new NodeIO().writeBinary(source);
  await writeFile(out, glb);
  console.log(`${out} bytes=${glb.byteLength} triangles=${baked.triangles}`);
} finally {
  await rm(scratch, { force: true, recursive: true });
}
