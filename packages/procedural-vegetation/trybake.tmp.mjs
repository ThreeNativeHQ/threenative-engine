// Scratch experiment: Arbor geometry with Poly Haven textures and conifer-scale needle cards.
import Arbor from "./vendor/arbor.js";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
const [out, spec] = [process.argv[2], JSON.parse(process.argv[3])];
mkdirSync(out, { recursive: true });
const png = async (file) => {
  const img = await loadImage(readFileSync(file));
  const c = createCanvas(img.width, img.height); c.getContext("2d").drawImage(img, 0, 0);
  return c.encodeSync("png");
};
for (const t of spec) {
  const base = Arbor.PRESETS[t.preset];
  const preset = { ...base, id: `${t.preset}x`, leaves: base.leaves.map((l) => ({ ...l, size: l.size.map((s) => s * t.leafScale), count: Math.round(l.count * t.countScale) })),
    ...(t.levels ? { levels: base.levels.map((l, i) => ({ ...l, ...(t.levels[i] ?? {}) })) } : {}),
    ...(t.colA ? { tex: { ...base.tex, cells: base.tex.cells.map((c) => ({ ...c, colA: t.colA, colB: t.colB })) } } : {}) };
  const leaf = t.leaf ? await png(t.leaf) : (() => { const l = Arbor.leafTexture(preset, { createCanvas }); const c = createCanvas(l.width, l.height); const x = c.getContext("2d"); const d = x.createImageData(l.width, l.height); d.data.set(l.data); x.putImageData(d, 0, 0); return c.encodeSync("png"); })();
  const textures = { bark: await png(t.bark), ...(t.barkNormal ? { barkNormal: await png(t.barkNormal) } : {}), leaf };
  for (const lod of [1, 2]) {
    const tree = Arbor.generate(preset, { seed: t.seed, lod });
    writeFileSync(`${out}/${t.name}-lod${lod}.glb`, Arbor.toGLB(tree, textures));
    if (lod === 1) console.log(JSON.stringify({ name: t.name, bounds: tree.bounds, tris: tree.triangles }));
  }
}
