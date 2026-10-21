/**
 * `tsx scripts/unreal-look/curve.ts --layer L1 --out <dir>` — the tone curve alone (PRD-632).
 *
 * Reads each Unreal EXR cell (scene-linear, tone curve off, exposure applied), maps it through the
 * harness's `filmicToneMap`, encodes sRGB and writes `<out>/<layer>/<layer>_<sun>_<pose>.png`.
 * Compare that folder with the Unreal PNGs:
 *   pnpm unreal-look:compare --layer L1 --threenative <dir>
 * Both arms hold the same light and the same exposure, so every residual is the curve.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { register } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PNG } from "pngjs";
import { decode } from "./compare.js";

const REFERENCE = path.resolve(import.meta.dirname, "../../tools/unreal-reference");
// The overlay imports `three`, which only the packages install: resolve it from core, as vitest does.
const core = pathToFileURL(path.resolve(import.meta.dirname, "../../packages/core/package.json"));
register(
  `data:text/javascript,${encodeURIComponent(
    `export const resolve = (s, c, n) => n(s, /^three(\\/|$)/.test(s) ? { ...c, parentURL: ${JSON.stringify(core.href)} } : c);`,
  )}`,
);
const { FILMIC_CURVE, filmicToneMap } = await import("./scaffold/render/tonemap.js");

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const encode = (v: number): number =>
  Math.round(
    255 * Math.min(1, Math.max(0, v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055)),
  );

const layer = flag("--layer") ?? "L1";
// `--gamut <n>` overrides the curve's Expand Gamut amount, to test one parameter of the curve alone.
const curve = {
  ...FILMIC_CURVE,
  ...(flag("--gamut") ? { expandGamut: Number(flag("--gamut")) } : {}),
};
const unreal = path.resolve(flag("--unreal") ?? path.join(REFERENCE, "captures/unreal"));
const out = path.resolve(flag("--out") ?? path.join(REFERENCE, "captures/curve", layer));
const poses = JSON.parse(readFileSync(path.join(REFERENCE, "poses.json"), "utf8")) as {
  suns: { name: string }[];
  poses: { name: string }[];
};
await mkdir(path.join(out, layer), { recursive: true });
let cells = 0;
for (const sun of poses.suns)
  for (const pose of poses.poses) {
    const name = `${layer}_${sun.name}_${pose.name}`;
    const source = path.join(unreal, layer, `${name}.exr`);
    if (!existsSync(source)) throw new Error(`TN_UNREAL_LOOK_MISSING_CELL: ${source}`);
    const exr = decode(readFileSync(source), "exr");
    const png = new PNG({ width: exr.width, height: exr.height });
    for (let i = 0; i < exr.width * exr.height; i++) {
      const at = i * exr.channels;
      const [r, g, b] = filmicToneMap(
        [exr.data[at] ?? 0, exr.data[at + 1] ?? 0, exr.data[at + 2] ?? 0],
        1,
        curve,
      );
      png.data[i * 4] = encode(r);
      png.data[i * 4 + 1] = encode(g);
      png.data[i * 4 + 2] = encode(b);
      png.data[i * 4 + 3] = 255;
    }
    await writeFile(path.join(out, layer, `${name}.png`), PNG.sync.write(png));
    cells += 1;
  }
console.info(`TN_UNREAL_LOOK curve layer=${layer} cells=${cells} out=${out}`);
