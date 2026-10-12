/**
 * The render half of the reference: one captured frame per render fixture, from a real adapter.
 *
 * This is the browser-reference capture path, not a second harness. One private Xvfb, one headed
 * Chromium, the same Vulkan flags the conformance lane and `--browser-recipe webgpu` use, and the
 * same element screenshot of `#c`. Headless Chromium cannot capture WebGPU here, so on Linux the
 * run belongs under `sh scripts/xvfb.sh`:
 *
 *   sh scripts/xvfb.sh pnpm --filter @threenative/three-native test:reference
 *
 * `three/webgpu` is served from its own build directory rather than bundled: the build is two
 * files with one relative import, so the page loads it as an ordinary ES module over 127.0.0.1
 * (a secure context, which a `file://` page is not).
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import type { Browser } from "@playwright/test";

import {
  type IAdapterInfo,
  type IFixture,
  REPO_ROOT,
  TONE_MAPPING_CONSTANTS,
} from "../../src/fixture-format.js";

const { buildSync, transformSync } = createRequire(
  path.join(REPO_ROOT, "packages/runtime-native/package.json"),
)("esbuild");

/**
 * The flags `--browser-recipe webgpu` passes, named in `packages/playtest/src/runner/browser.ts`.
 *
 * Without the Vulkan feature Chromium never reaches the driver on Linux and serves WebGPU from
 * SwiftShader: the adapter answers, nothing errors, and the golden is a CPU rasteriser's frame.
 */
export const WEBGPU_BROWSER_ARGS = [
  "--ozone-platform=x11",
  "--enable-unsafe-webgpu",
  "--disable-gpu-sandbox",
  "--ignore-gpu-blocklist",
  "--enable-features=Vulkan",
];

/** Every field is searched: which one carries the giveaway depends on the platform. */
export const SOFTWARE_ADAPTER =
  /swiftshader|llvmpipe|lavapipe|softwarerasterizer|software adapter|basic render/i;

const PAGE_FILE = path.join(import.meta.dirname, "render", "render-fixture-page.js");
const OUTPUT_COLOR_SPACE_CONSTANTS = { srgb: "SRGBColorSpace", linear: "LinearSRGBColorSpace" };
export const CAPTURE_TIMEOUT_MS = 90_000;

export interface IRenderCapture {
  /** The PNG bytes exactly as the browser encoded them. */
  readonly png: Buffer;
  readonly pngSha256: string;
  readonly width: number;
  readonly height: number;
  readonly adapter: IAdapterInfo;
}

interface IPageOutcome {
  readonly adapter?: IAdapterInfo;
  readonly error?: string;
}

export interface IRenderCaptureOptions {
  /** Record a software adapter's frame instead of refusing it. Off by default: it is not a GPU. */
  readonly allowSoftware: boolean;
}

/** The `three/webgpu` build directory, resolved from the package that links the catalog copy. */
export function threeBuildDir(): string {
  const require = createRequire(path.join(REPO_ROOT, "packages", "runtime-native", "package.json"));
  return path.dirname(require.resolve("three/webgpu"));
}

/** Everything the page needs, and nothing it could use to change the fixture it is given. */
function requestOf(fixture: IFixture): Record<string, unknown> {
  const render = fixture.render;
  if (render === undefined) throw new Error(`TN_FIXTURE_RENDER_MISSING: ${fixture.name}`);
  return {
    fixture: { ops: fixture.ops },
    ...(fixture.name === "traa-history" && process.env.TN_TRAA_DUMP ? { traaDump: true } : {}),
    scene: render.scene,
    camera: render.camera,
    width: render.width,
    height: render.height,
    toneMappingConstant: TONE_MAPPING_CONSTANTS[render.toneMapping],
    toneMappingExposure: render.toneMappingExposure ?? 1,
    shadowMap: render.shadowMap === true,
    shadowMapType: render.shadowMapType ?? "PCFShadowMap",
    outputColorSpaceConstant:
      OUTPUT_COLOR_SPACE_CONSTANTS[render.outputColorSpace ?? "srgb"] ??
      OUTPUT_COLOR_SPACE_CONSTANTS.srgb,
  };
}

function page(request: Record<string, unknown>): string {
  const width = request.width;
  const height = request.height;
  return [
    '<!doctype html><meta charset="utf-8">',
    "<style>html,body{margin:0;background:#000}canvas{display:block}</style>",
    `<canvas id="c" width="${String(width)}" height="${String(height)}"></canvas>`,
    '<script type="importmap">{"imports":{"three":"/build/three.webgpu.js","three/webgpu":"/build/three.webgpu.js","three/tsl":"/build/three.tsl.js"}}</script>',
    '<script type="module">',
    'import { reportOutcome } from "/render-fixture-page.js";',
    `reportOutcome(${JSON.stringify(request)});`,
    "</script>",
  ].join("");
}

/** Serves the page, the in-page module and the two `three/webgpu` build files from one origin. */
async function withServer(
  fixtures: ReadonlyMap<string, IFixture>,
  fn: (origin: string) => Promise<void>,
): Promise<void> {
  const build = threeBuildDir();
  const served = new Map<string, [string, string | Buffer]>([
    ["/render-fixture-page.js", ["text/javascript", readFileSync(PAGE_FILE, "utf8")]],
    [
      "/tsl-programs.js",
      [
        "text/javascript",
        readFileSync(path.join(path.dirname(PAGE_FILE), "tsl-programs.js"), "utf8"),
      ],
    ],
  ]);
  for (const name of ["three.webgpu.js", "three.core.js", "three.tsl.js"])
    served.set(`/build/${name}`, ["text/javascript", readFileSync(path.join(build, name), "utf8")]);
  // The pinned three's SkeletonUtils addon, which imports "three" through the page's import map.
  served.set("/addons/SkeletonUtils.js", [
    "text/javascript",
    readFileSync(path.join(build, "../examples/jsm/utils/SkeletonUtils.js"), "utf8"),
  ]);
  for (const name of ["particles", "fluid-particles", "gpu-readback"]) {
    const source = transformSync(
      readFileSync(path.join(REPO_ROOT, "packages/core/src", `${name}.ts`), "utf8"),
      { loader: "ts" },
    );
    served.set(`/core/${name}.js`, ["text/javascript", source.code]);
  }
  if ([...fixtures.values()].some((fixture) => fixture.name.startsWith("vsm-"))) {
    const virtual = buildSync({
      entryPoints: [path.join(REPO_ROOT, "packages/core/src/render/virtual-shadow.ts")],
      bundle: true,
      format: "esm",
      platform: "browser",
      external: ["three", "three/*"],
      write: false,
    });
    served.set("/core/virtual-shadow.js", ["text/javascript", virtual.outputFiles[0].text]);
  }
  if (
    [...fixtures.values()].some(
      (fixture) => fixture.name === "probes" || fixture.name.startsWith("probes-"),
    )
  ) {
    const probes = buildSync({
      entryPoints: [path.join(REPO_ROOT, "packages/core/src/render/probe-volume.ts")],
      bundle: true,
      format: "esm",
      platform: "browser",
      external: ["three", "three/*"],
      write: false,
    });
    served.set("/core/probe-volume.js", ["text/javascript", probes.outputFiles[0].text]);
  }
  // GLTFLoader and the two helpers it imports, resolving `three` through the page's import map; and
  // every glTF a fixture loads, from the repository.
  for (const addon of [
    "loaders/GLTFLoader.js",
    "tsl/display/TRAANode.js",
    "tsl/display/GTAONode.js",
    "tsl/display/DenoiseNode.js",
    "tsl/display/BloomNode.js",
    "tsl/display/SMAANode.js",
    "math/SimplexNoise.js",
    "utils/BufferGeometryUtils.js",
    "utils/SkeletonUtils.js",
  ])
    served.set(`/addons/${addon}`, [
      "text/javascript",
      readFileSync(path.join(build, "..", "examples", "jsm", addon), "utf8"),
    ]);
  for (const fixture of fixtures.values())
    for (const op of fixture.ops)
      if (op.op === "gltf")
        served.set(`/files/${op.file}`, [
          "model/gltf-binary",
          readFileSync(path.join(REPO_ROOT, op.file)),
        ]);
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const fixture = fixtures.get(url.searchParams.get("fixture") ?? "");
    const file =
      url.pathname === "/"
        ? fixture === undefined
          ? undefined
          : (["text/html", page(requestOf(fixture))] as [string, string])
        : served.get(url.pathname);
    if (file === undefined) {
      response.writeHead(404);
      response.end("not found");
      return;
    }
    response.writeHead(200, { "content-type": file[0] });
    response.end(file[1]);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("TN_FIXTURE_RENDER_NO_PORT: the capture server bound no TCP port");
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/** Waits for the page's own report, or fails closed: a frame nobody reported is not a frame. */
function reported(pageOutcome: Promise<IPageOutcome>, fixture: string): Promise<IPageOutcome> {
  return Promise.race([
    pageOutcome,
    new Promise<IPageOutcome>((_, reject) => {
      setTimeout(
        () =>
          reject(
            new Error(
              `TN_FIXTURE_RENDER_TIMEOUT: ${fixture} drew no frame within ${String(CAPTURE_TIMEOUT_MS / 1000)}s`,
            ),
          ),
        CAPTURE_TIMEOUT_MS,
      ).unref();
    }),
  ]);
}

/** One fixture's frame: open its page, wait for its own report, screenshot the canvas it drew. */
async function captureOne(
  browser: Browser,
  origin: string,
  fixture: IFixture,
  options: IRenderCaptureOptions,
): Promise<IRenderCapture> {
  const request = requestOf(fixture);
  const width = request.width as number;
  const height = request.height as number;
  const tab = await browser.newPage({ viewport: { width, height } });
  const pageErrors: string[] = [];
  tab.on("pageerror", (error) => pageErrors.push(error.message));
  let settle: ((outcome: IPageOutcome) => void) | null = null;
  // The page can finish before `goto` returns, so the report has a home before it opens.
  const pageOutcome = new Promise<IPageOutcome>((resolve) => {
    settle = resolve;
  });
  await tab.exposeFunction("__tnRenderDone", (outcome: IPageOutcome) => settle?.(outcome));
  if (fixture.name === "traa-history" && process.env.TN_TRAA_DUMP) {
    const directory = path.resolve(process.env.TN_TRAA_DUMP);
    mkdirSync(directory, { recursive: true });
    await tab.exposeFunction(
      "__tnTraaDump",
      (name: string, metadata: Record<string, unknown>, values?: number[]) => {
        if (!/^(capture|frame-\d+(?:-(beauty|velocity|history|resolved))?)$/.test(name))
          throw new Error(`TN_TRAA_DUMP_NAME_INVALID: ${name}`);
        if (values !== undefined) {
          const { width, height, channels } = metadata;
          if (
            typeof width !== "number" ||
            typeof height !== "number" ||
            channels !== 4 ||
            values.length !== width * height * channels
          )
            throw new Error(`TN_TRAA_DUMP_SIZE_INVALID: ${name}`);
          const bytes = Buffer.alloc(values.length * 4);
          values.forEach((value, i) => bytes.writeFloatLE(value, i * 4));
          writeFileSync(path.join(directory, `${name}.bin`), bytes);
        }
        writeFileSync(
          path.join(directory, `${name}.json`),
          `${JSON.stringify(metadata, null, 2)}\n`,
        );
      },
    );
  }
  try {
    await tab.goto(`${origin}/?fixture=${encodeURIComponent(fixture.name)}`, {
      waitUntil: "domcontentloaded",
    });
    const outcome = await reported(pageOutcome, fixture.name);
    if (outcome.error !== undefined)
      throw new Error(`TN_FIXTURE_RENDER_FAILED: ${fixture.name}\n${outcome.error}`);
    if (pageErrors.length > 0)
      throw new Error(`TN_FIXTURE_RENDER_FAILED: ${fixture.name} raised ${pageErrors.join("; ")}`);
    const adapter = outcome.adapter;
    if (adapter === undefined)
      throw new Error(`TN_FIXTURE_RENDER_NO_ADAPTER: ${fixture.name} reported no adapter`);
    const named = JSON.stringify(adapter);
    if (!options.allowSoftware && SOFTWARE_ADAPTER.test(named))
      throw new Error(
        `TN_FIXTURE_RENDER_SOFTWARE_ADAPTER: ${fixture.name} was drawn by ${named}, a software adapter; pass --allow-software to record it anyway`,
      );
    const png = await tab.locator("#c").screenshot({ timeout: CAPTURE_TIMEOUT_MS });
    return {
      png,
      pngSha256: createHash("sha256").update(png).digest("hex"),
      width,
      height,
      adapter,
    };
  } finally {
    await tab.close();
  }
}

/** Shared headed WebGPU launcher for compatibility fixtures and the AOT corpus reference. */
export async function launchReferenceBrowser(): Promise<Browser> {
  if (process.platform === "linux" && process.env.DISPLAY === undefined)
    throw new Error(
      "TN_FIXTURE_RENDER_NO_DISPLAY: a render golden needs a WebGPU adapter; run `sh scripts/xvfb.sh pnpm --filter @threenative/three-native test:reference` on Linux",
    );
  let chromium: typeof import("@playwright/test")["chromium"];
  try {
    ({ chromium } = await import("@playwright/test"));
  } catch (error) {
    throw new Error(
      `TN_FIXTURE_RENDER_NO_PLAYWRIGHT: install @playwright/test and its Chromium (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  return chromium.launch({ headless: false, timeout: 30_000, args: [...WEBGPU_BROWSER_ARGS] });
}

/** Every render fixture's frame; missing or failed observations throw rather than record a golden. */
export async function captureRenderFixtures(
  fixtures: readonly IFixture[],
  options: IRenderCaptureOptions,
): Promise<ReadonlyMap<string, IRenderCapture>> {
  const captures = new Map<string, IRenderCapture>();
  if (fixtures.length === 0) return captures;

  const requested = new Map(fixtures.map((fixture) => [fixture.name, fixture]));
  await withServer(requested, async (origin) => {
    const browser = await launchReferenceBrowser();
    try {
      for (const fixture of fixtures)
        captures.set(fixture.name, await captureOne(browser, origin, fixture, options));
    } finally {
      await browser.close();
    }
  });
  return captures;
}
