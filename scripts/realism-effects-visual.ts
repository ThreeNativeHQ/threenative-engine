import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "@playwright/test";
import {
  WEBGPU_BROWSER_ARGS,
  softwareAdapterName,
} from "../packages/playtest/src/runner/browser.js";
import {
  compareCaptures,
  inspectCapture,
} from "../packages/runtime-native/conformance/metrics.mjs";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCENE = path.join(
  REPO_ROOT,
  "packages/runtime-native/conformance/scenes/shared/realism-effects-visual-variants.js",
);
const ESBUILD = path.join(
  REPO_ROOT,
  "node_modules/.bin",
  process.platform === "win32" ? "esbuild.cmd" : "esbuild",
);
const DEFAULT_OUT = path.join(REPO_ROOT, "artifacts/realism-effects/visual-variants");
const VARIANTS = ["off", "default", "changed"] as const;
const MIN_CHANGED_PIXEL_RATIO = 0.001;
const MIN_PERCEPTUAL_DELTA_E = 0.05;

export const REALISM_EFFECT_VISUAL_VARIANTS = [
  {
    changedConstant: "LENS_DISTORTION_K1",
    effect: "LensDistortionEffect",
    id: "lens-distortion",
  },
  {
    changedConstant: "SPARKLE_THRESHOLD",
    effect: "SparkleEffect",
    id: "sparkle",
  },
  {
    changedConstant: "GRADUAL_BACKGROUND_STRENGTH",
    effect: "GradualBackgroundEffect",
    id: "gradual-background",
  },
] as const;

type Variant = (typeof VARIANTS)[number];

export interface IVisualVariantComparisons {
  readonly defaultToChanged: ReturnType<typeof compareCaptures>;
  readonly offToDefault: ReturnType<typeof compareCaptures>;
}

export function assertVisualVariantComparisons(
  effect: string,
  captures: Readonly<Record<Variant, Buffer>>,
): IVisualVariantComparisons {
  for (const variant of VARIANTS) {
    inspectCapture(captures[variant]);
  }
  const offToDefault = compareCaptures(captures.off, captures.default);
  const defaultToChanged = compareCaptures(captures.default, captures.changed);
  assertMeaningfulDifference(`${effect} off/default`, offToDefault);
  assertMeaningfulDifference(`${effect} default/changed`, defaultToChanged);
  return { defaultToChanged, offToDefault };
}

function assertMeaningfulDifference(
  label: string,
  comparison: ReturnType<typeof compareCaptures>,
): void {
  if (
    comparison.pixelMismatchRatio < MIN_CHANGED_PIXEL_RATIO ||
    comparison.perceptualDeltaE < MIN_PERCEPTUAL_DELTA_E
  ) {
    throw new Error(
      `TN_REALISM_EFFECT_VISUAL_UNCHANGED:${label}: ` +
        `pixelMismatchRatio=${comparison.pixelMismatchRatio.toFixed(6)} ` +
        `perceptualDeltaE=${comparison.perceptualDeltaE.toFixed(4)}`,
    );
  }
}

function entrySource(): string {
  return `import { startScene } from ${JSON.stringify(SCENE)};
const query = new URLSearchParams(location.search);
globalThis.__TN_REALISM_EFFECT__ = query.get("effect");
globalThis.__TN_REALISM_EFFECT_VARIANT__ = query.get("variant");
const canvas = document.getElementById("c");
if (!(canvas instanceof HTMLCanvasElement)) throw new Error("realism-effects visual canvas is missing");
await startScene(canvas, { width: canvas.width, height: canvas.height });
globalThis.__TN_REALISM_VISUAL_READY__ = true;
`;
}

async function bundleEntry(directory: string): Promise<string> {
  const entry = path.join(directory, "entry.js");
  const output = path.join(directory, "bundle.js");
  await writeFile(entry, entrySource(), "utf8");
  await execFileAsync(
    ESBUILD,
    [
      entry,
      "--bundle",
      "--format=esm",
      "--platform=browser",
      `--outfile=${output}`,
      `--define:import.meta.env={"BASE_URL":"/","DEV":false,"MODE":"production","PROD":true,"SSR":false}`,
    ],
    { cwd: REPO_ROOT, maxBuffer: 32 * 1024 * 1024 },
  );
  return output;
}

async function startServer(
  bundle: string,
): Promise<{ readonly close: () => Promise<void>; readonly url: string }> {
  const server = createServer(async (request, response) => {
    await serve(request, response, bundle);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Visual server has no address.");
  return {
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
    url: `http://127.0.0.1:${address.port}/`,
  };
}

async function serve(
  request: IncomingMessage,
  response: ServerResponse,
  bundle: string,
): Promise<void> {
  if (request.url === "/bundle.js") {
    response.writeHead(200, { "content-type": "text/javascript" });
    response.end(await readFile(bundle));
    return;
  }
  response.writeHead(200, { "content-type": "text/html" });
  response.end(
    '<!doctype html><meta charset="utf-8"><style>html,body{margin:0;width:640px;height:360px;overflow:hidden}canvas{display:block}</style>' +
      '<canvas id="c" width="640" height="360"></canvas><script type="module" src="/bundle.js"></script>',
  );
}

async function readAdapterInfo(
  page: Awaited<ReturnType<Awaited<ReturnType<typeof chromium.launch>>["newPage"]>>,
): Promise<Record<string, string>> {
  const info = await page.evaluate(async () => {
    const gpuNavigator = navigator as Navigator & {
      gpu?: { requestAdapter(): Promise<{ info?: Record<string, unknown> } | null> };
    };
    const adapter = await gpuNavigator.gpu?.requestAdapter();
    const raw = adapter?.info;
    return Object.fromEntries(
      (["architecture", "description", "device", "vendor"] as const).flatMap((key) => {
        const value = raw?.[key];
        return typeof value === "string" && value.trim() !== "" ? [[key, value]] : [];
      }),
    );
  });
  if (Object.keys(info).length === 0) throw new Error("TN_REALISM_EFFECT_VISUAL_ADAPTER_MISSING");
  const software = softwareAdapterName(info);
  if (software !== undefined)
    throw new Error(`TN_REALISM_EFFECT_VISUAL_SOFTWARE_ADAPTER:${software}`);
  return info;
}

async function captureVariant(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  url: string,
  effect: string,
  variant: Variant,
): Promise<{ readonly adapter: Record<string, string>; readonly image: Buffer }> {
  const page = await browser.newPage({ viewport: { height: 360, width: 640 } });
  try {
    await page.goto(`${url}?effect=${encodeURIComponent(effect)}&variant=${variant}`, {
      waitUntil: "domcontentloaded",
    });
    const adapter = await readAdapterInfo(page);
    await page.waitForFunction(
      () =>
        (globalThis as typeof globalThis & { __TN_REALISM_VISUAL_READY__?: boolean })
          .__TN_REALISM_VISUAL_READY__ === true,
      undefined,
      {
        timeout: 60_000,
      },
    );
    await page.evaluate(async () => {
      for (let frame = 0; frame < 30; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    });
    const image = await page.screenshot({ type: "png" });
    return { adapter, image };
  } finally {
    await page.close();
  }
}

function outputPaths(out: string): { readonly directory: string; readonly report: string } {
  return out.endsWith(".json")
    ? { directory: path.dirname(out), report: out }
    : { directory: out, report: path.join(out, "report.json") };
}

function serialiseReport(report: unknown): string {
  return `${JSON.stringify(report, null, 2).replace(
    /"variants": \[\n\s+"off",\n\s+"default",\n\s+"changed"\n\s+\]/gu,
    '"variants": ["off", "default", "changed"]',
  )}\n`;
}

export async function runRealismEffectsVisual(out = DEFAULT_OUT): Promise<unknown> {
  const paths = outputPaths(out);
  await mkdir(paths.directory, { recursive: true });
  const temporary = await mkdtemp(path.join(paths.directory, ".bundle-"));
  let server: { readonly close: () => Promise<void>; readonly url: string } | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const bundle = await bundleEntry(temporary);
    server = await startServer(bundle);
    browser = await chromium.launch({
      args: [...WEBGPU_BROWSER_ARGS],
      headless: false,
      timeout: 30_000,
    });
    const rows = [];
    for (const effect of REALISM_EFFECT_VISUAL_VARIANTS) {
      const captures = {} as Record<Variant, Buffer>;
      let adapter: Record<string, string> | undefined;
      for (const variant of VARIANTS) {
        const capture = await captureVariant(browser, server.url, effect.effect, variant);
        adapter = capture.adapter;
        captures[variant] = capture.image;
        await writeFile(path.join(paths.directory, `${effect.id}-${variant}.png`), capture.image);
      }
      const comparisons = assertVisualVariantComparisons(effect.effect, captures);
      rows.push({
        adapter,
        changedConstant: effect.changedConstant,
        comparisons,
        effect: effect.effect,
        id: effect.id,
        variants: [...VARIANTS],
      });
    }
    const report = {
      generatedAt: new Date().toISOString(),
      rows,
      schemaVersion: "0.1.0",
      source: "browser-webgpu-visual-variants",
    };
    await writeFile(paths.report, serialiseReport(report), "utf8");
    return report;
  } finally {
    await browser?.close();
    await server?.close();
    await rm(temporary, { force: true, recursive: true });
  }
}

function argumentValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const out = argumentValue(process.argv.slice(2), "--out") ?? DEFAULT_OUT;
  runRealismEffectsVisual(out)
    .then((report) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`))
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    });
}
