/**
 * Engine parity guard: one scaffolded template, one pose, both engines. The template is captured
 * once on `engine: "threejs"` and once on `engine: "threenative"`, and the two frames are compared
 * as 4x4 tile means of luminance and RGB (the engine-load-test metric). The score is the largest
 * tile delta, so one wrong region cannot hide in a global mean.
 *
 * Calibrated 2026-10-17 on the 13 templates, nvidia, 1904x960: run-to-run noise <= 0.006, the
 * matching templates 0.002-0.097, the real gaps 0.167 (racing's missing sun target), 0.49 and 0.85.
 *
 * Usage: tsx scripts/engine-parity.ts --project <scaffold> --template <name> --out <dir>
 * Exit 0 parity or a listed known gap, 1 a parity failure, 2 a capture that never happened.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

export const ENGINE_PARITY_THRESHOLD = 0.12;
export const ENGINES = ["threejs", "threenative"] as const;

/** Templates whose engines still differ, each with the open box that tracks it. A gap that closes fails until it leaves this list. */
// Empty since 2026-10-17: sailing (fc56ef24d, lit mesh without normals) and action-rpg (5bb12e56c, NaN launch cone) closed.
export const KNOWN_GAPS: Readonly<Record<string, string>> = {};

const POSE = {
  name: "engine-parity-pose",
  schemaVersion: 1,
  target: "web",
  viewport: { width: 960, height: 540 },
  warmupFrames: 30,
  artifacts: { screenshots: "before-after" },
  steps: [{ kind: "wait", label: "pose", waitTicks: 300, screenshot: "pose", release: true }],
  assert: {
    visual: [{ region: { x: 0, y: 0, width: 960, height: 540, minNonblankPixelRatio: 0.01 } }],
  },
};

/** Luminance and RGB means of a 4x4 tile grid, each in 0..1. */
export function tileMeans(image: PNG): number[] {
  const out: number[] = [];
  for (let i = 0; i < 16; i++) {
    const x0 = Math.floor(((i % 4) * image.width) / 4);
    const x1 = Math.floor((((i % 4) + 1) * image.width) / 4);
    const y0 = Math.floor((Math.floor(i / 4) * image.height) / 4);
    const y1 = Math.floor(((Math.floor(i / 4) + 1) * image.height) / 4);
    const sums = [0, 0, 0];
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++)
        for (let c = 0; c < 3; c++)
          sums[c] = (sums[c] as number) + (image.data[(y * image.width + x) * 4 + c] as number);
    const n = (x1 - x0) * (y1 - y0) * 255;
    const [r, g, b] = sums.map((sum) => sum / n) as [number, number, number];
    out.push(0.2126 * r + 0.7152 * g + 0.0722 * b, r, g, b);
  }
  return out;
}

export function parityScore(a: PNG, b: PNG): number {
  if (a.width !== b.width || a.height !== b.height)
    throw new Error(`TN_ENGINE_PARITY_SIZE: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  const left = tileMeans(a);
  const right = tileMeans(b);
  return Math.max(...left.map((value, i) => Math.abs(value - (right[i] as number))));
}

/** The verdict for one template's score. A known gap passes; a known gap that closed fails until it is delisted. */
export function verdict(
  template: string,
  score: number,
  gaps: Readonly<Record<string, string>> = KNOWN_GAPS,
): { ok: boolean; message: string } {
  const gap = gaps[template];
  const within = score <= ENGINE_PARITY_THRESHOLD;
  const value = `${template}: score ${score.toFixed(3)} (threshold ${ENGINE_PARITY_THRESHOLD})`;
  if (gap === undefined)
    return within
      ? { ok: true, message: `${value}: the engines match` }
      : { ok: false, message: `TN_ENGINE_PARITY: ${value}: threenative differs from threejs` };
  return within
    ? {
        ok: false,
        message: `TN_ENGINE_PARITY_GAP_CLOSED: ${value}: remove ${template} from KNOWN_GAPS`,
      }
    : { ok: true, message: `${value}: known gap (${gap})` };
}

/** The config source with its default export re-exported under one engine; works for any export shape and overrides a pin. */
export function withEngine(source: string, engine: (typeof ENGINES)[number]): string {
  const matches = source.match(/^export\s+default\s+/gmu) ?? [];
  if (matches.length !== 1)
    throw new Error(
      "TN_ENGINE_PARITY_CONFIG: expected exactly one `export default` in threenative.config.ts",
    );
  return `${source.replace(/^export\s+default\s+/mu, "const __engineParityBase = ")}\nexport default { ...__engineParityBase, engine: "${engine}" };\n`;
}

/** Two frames side by side, threejs left, for the reviewer. */
export function sideBySide(a: PNG, b: PNG): PNG {
  const gap = 16;
  const out = new PNG({ width: a.width + gap + b.width, height: Math.max(a.height, b.height) });
  out.data.fill(24);
  PNG.bitblt(a, out, 0, 0, a.width, a.height, 0, 0);
  PNG.bitblt(b, out, 0, 0, b.width, b.height, a.width + gap, 0);
  return out;
}

function posePng(dir: string): string {
  const files = (function walk(d: string): string[] {
    return readdirSync(d).flatMap((f) => {
      const p = path.join(d, f);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
  })(dir).filter((f) => f.endsWith(".png") && path.basename(f).includes("pose"));
  const file = files.sort().at(-1);
  if (file === undefined) throw new Error(`TN_ENGINE_PARITY_CAPTURE: no pose frame in ${dir}`);
  return file;
}

function main(argv: string[]): number {
  const arg = (name: string): string => {
    const value = argv[argv.indexOf(name) + 1];
    if (!argv.includes(name) || value === undefined) throw new Error(`missing ${name}`);
    return value;
  };
  const project = path.resolve(arg("--project"));
  const template = arg("--template");
  const out = path.resolve(arg("--out"));
  mkdirSync(out, { recursive: true });
  const scenario = path.join(out, "pose.playtest.json");
  writeFileSync(scenario, JSON.stringify(POSE, null, 2));
  const configFile = path.join(project, "threenative.config.ts");
  const original = readFileSync(configFile, "utf8");
  const frames: PNG[] = [];
  try {
    for (const engine of ENGINES) {
      writeFileSync(configFile, withEngine(original, engine));
      const artifacts = path.join(out, engine);
      try {
        execFileSync(
          "pnpm",
          [
            "--dir",
            project,
            "exec",
            "threenative-playtest",
            "--scenario",
            scenario,
            "--browser-recipe",
            "webgpu",
            "--headed",
            "--artifacts",
            artifacts,
            "--timeout",
            "120000",
            "--server-timeout",
            "120000",
            "--server-command",
            "pnpm dev --host 127.0.0.1 --port $PORT --strictPort",
          ],
          { stdio: "inherit" },
        );
      } catch (error) {
        // A known gap may fail on its own arm (action-rpg's threejs console errors); anything else may not.
        if (KNOWN_GAPS[template] === undefined) {
          console.error(
            `TN_ENGINE_PARITY_CAPTURE: ${template} on ${engine} failed: ${String(error)}`,
          );
          return 2;
        }
      }
      frames.push(PNG.sync.read(readFileSync(posePng(artifacts))));
    }
  } finally {
    writeFileSync(configFile, original);
  }
  const [threejs, threenative] = frames as [PNG, PNG];
  writeFileSync(
    path.join(out, "side-by-side.png"),
    PNG.sync.write(sideBySide(threejs, threenative)),
  );
  const score = parityScore(threejs, threenative);
  const result = verdict(template, score);
  writeFileSync(
    path.join(out, "result.json"),
    `${JSON.stringify({ template, score, ...result }, null, 2)}\n`,
  );
  (result.ok ? console.info : console.error)(result.message);
  return result.ok ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2));
