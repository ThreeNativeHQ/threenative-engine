// PRD-729 Phase 2: preload of a cooked asset tree, from the first `ctx.assets` call to GPU-ready.
//
// The probe page loads every corpus entry through core's own `createAssetLoader` and `loadAll`,
// puts each model and texture in one scene, compiles it, renders one frame and waits for the GPU
// queue. That is GPU-ready: core uploads a texture on first render, not on load. The clock starts
// after `renderer.init()`, so the probe's own script and device start-up are not counted.
// Chromium runs headed with the playtest harness's WebGPU flags; a software adapter is refused.
import { createReadStream, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CORE = resolve(ROOT, "packages/core");

/** The 40 Mbps down / 20 ms network the PRD-496 probe used. */
export const THROTTLED = { latency: 20, downloadThroughput: 40e6 / 8, uploadThroughput: 20e6 / 8 };

const ENTRY = `
import { createAssetLoader, loadAll } from "./dist/index.js";
import { Mesh, MeshBasicMaterial, PerspectiveCamera, PlaneGeometry, Scene, WebGPURenderer } from "three/webgpu";
const fail = (error) => { window.__probe = { error: String(error?.stack ?? error) }; };
try {
  const entries = await (await fetch("/probe.json", { cache: "no-store" })).json();
  const adapter = await navigator.gpu?.requestAdapter();
  const info = adapter?.info ?? {};
  const renderer = new WebGPURenderer({ antialias: false });
  renderer.setSize(640, 360);
  document.body.append(renderer.domElement);
  await renderer.init();
  const assets = createAssetLoader({ basePath: "/", renderer });
  const scene = new Scene();
  const camera = new PerspectiveCamera(60, 16 / 9, 0.1, 1000);
  camera.position.set(0, 2, 8);
  const t0 = performance.now();
  await loadAll(entries, async (entry) => {
    if (entry.kind === "model") {
      const model = await assets.model(entry.path);
      scene.add(model.scene ?? model);
    } else if (entry.kind === "texture") {
      const map = await assets.texture(entry.path);
      scene.add(new Mesh(new PlaneGeometry(), new MeshBasicMaterial({ map })));
    } else if (entry.kind === "audio") await assets.audio(entry.path);
  });
  const loadedMs = performance.now() - t0;
  await renderer.compileAsync(scene, camera);
  renderer.render(scene, camera);
  await renderer.backend.device.queue.onSubmittedWorkDone();
  window.__probe = {
    loadedMs,
    readyMs: performance.now() - t0,
    adapter: { vendor: info.vendor ?? "", architecture: info.architecture ?? "", device: info.device ?? "", description: info.description ?? "" },
  };
} catch (error) { fail(error); }
`;

const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".ktx2": "image/ktx2",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

/** Bundle the probe page into `dir` once: core and three resolve from packages/core. */
async function writeProbePage(dir, entries) {
  const tsup = createRequire(resolve(ROOT, "packages/assets/package.json")).resolve("tsup");
  const { build } = await import(pathToFileURL(createRequire(tsup).resolve("esbuild")).href);
  await build({
    stdin: { contents: ENTRY, resolveDir: CORE, loader: "js" },
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    outfile: join(dir, "probe.js"),
    logLevel: "error",
  });
  writeFileSync(join(dir, "probe.json"), JSON.stringify(entries));
  writeFileSync(
    join(dir, "probe.html"),
    '<!doctype html><meta charset="utf-8"><body style="margin:0"><script type="module" src="/probe.js"></script>',
  );
}

/** Serve the cooked output first, then the project root, so an uncooked source still resolves. */
function serveStatic(roots) {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    const file = roots
      .map((root) => join(root, path))
      .find((candidate) => statSync(candidate, { throwIfNoEntry: false })?.isFile());
    if (file === undefined) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
    });
    createReadStream(file).pipe(res);
  });
  return new Promise((done) =>
    server.listen(0, "127.0.0.1", () => done({ server, port: server.address().port })),
  );
}

export const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** One cold page load: a fresh context, the cache off, the network shaped when asked. */
async function sampleOnce(browser, port, network, softwareAdapterName) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    if (network !== undefined)
      await cdp.send("Network.emulateNetworkConditions", { offline: false, ...network });
    await page.goto(`http://127.0.0.1:${port}/probe.html`);
    const handle = await page.waitForFunction(() => window.__probe, undefined, {
      timeout: 180_000,
    });
    const result = await handle.jsonValue();
    if (result.error !== undefined) throw new Error(`preload probe failed: ${result.error}`);
    const software = softwareAdapterName(result.adapter);
    if (software !== undefined) throw new Error(`refusing software WebGPU adapter: ${software}`);
    return result;
  } finally {
    await context.close();
  }
}

/**
 * Median preload of each project over `runs` cold page loads. With several projects the runs
 * alternate (ABAB, then BABA) in one browser, so host load and warm-up land on every arm alike.
 * Throws on a software adapter, a probe error or a run that never reaches GPU-ready.
 */
export async function measurePreload(projects, entries, { runs = 5, network } = {}) {
  const { chromium } = await import("@playwright/test");
  const { WEBGPU_BROWSER_ARGS, resolveBrowserArguments, softwareAdapterName } = await import(
    pathToFileURL(resolve(ROOT, "packages/playtest/dist/runner/index.js")).href
  );
  const servers = [];
  const browser = await chromium.launch({
    headless: false,
    args: resolveBrowserArguments(WEBGPU_BROWSER_ARGS),
  });
  try {
    for (const project of projects) {
      await writeProbePage(join(project, "public"), entries);
      servers.push(await serveStatic([join(project, "public"), project]));
    }
    const samples = projects.map(() => []);
    for (let run = 0; run < runs; run += 1) {
      const order = projects.map((_, index) => index);
      if (run % 2 === 1) order.reverse();
      for (const index of order)
        samples[index].push(
          await sampleOnce(browser, servers[index].port, network, softwareAdapterName),
        );
    }
    return samples.map((list) => ({
      readyMs: Math.round(median(list.map((s) => s.readyMs))),
      loadedMs: Math.round(median(list.map((s) => s.loadedMs))),
      samplesMs: list.map((s) => Math.round(s.readyMs)),
      adapter: list[0].adapter,
    }));
  } finally {
    await browser.close();
    for (const { server } of servers) server.close();
  }
}
