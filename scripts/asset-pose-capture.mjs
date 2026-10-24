// PRD-729 visual judge input: the same animated pose of the same model from two cooked trees.
//
// Usage: node scripts/asset-pose-capture.mjs <outDir> <label=publicDir>... [--models a.glb,b.glb] [--runs 2]
//
// Each arm is a cooked `public/` directory. The page loads each model through core's
// `createAssetLoader`, plays a clip in three's `AnimationMixer` at fixed fractions of its length,
// frames the model, and renders. The label is burned in large. A PNG hash per pose says at once
// whether two arms drew the same pixels. Chromium runs headed with the playtest WebGPU flags and
// a software adapter is refused.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { serveStatic, writeProbePage } from "./asset-preload-probe.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FRACTIONS = [0.2, 0.5, 0.8];

const ENTRY = `
import { createAssetLoader } from "./dist/index.js";
import { AmbientLight, Box3, DirectionalLight, PerspectiveCamera, Scene, Vector3, AnimationMixer, WebGPURenderer } from "three/webgpu";
const fail = (error) => { window.__pose = { error: String(error?.stack ?? error) }; };
try {
  const { models, label } = await (await fetch("/probe.json", { cache: "no-store" })).json();
  const adapter = await navigator.gpu?.requestAdapter();
  const info = adapter?.info ?? {};
  const renderer = new WebGPURenderer({ antialias: false });
  renderer.setSize(640, 640);
  document.body.append(renderer.domElement);
  const tag = document.createElement("div");
  tag.textContent = label;
  tag.style.cssText = "position:absolute;left:12px;top:8px;font:700 72px sans-serif;color:#ff0;text-shadow:0 0 6px #000,0 0 6px #000";
  document.body.append(tag);
  await renderer.init();
  const assets = createAssetLoader({ basePath: "/", renderer });
  const scene = new Scene();
  scene.add(new AmbientLight(0xffffff, 1.2));
  const sun = new DirectionalLight(0xffffff, 2.5);
  sun.position.set(3, 6, 4);
  scene.add(sun);
  const camera = new PerspectiveCamera(40, 1, 0.01, 1000);
  const loaded = [];
  for (const path of models) {
    const gltf = await assets.model(path);
    loaded.push({ path, gltf, mixer: new AnimationMixer(gltf.scene) });
  }
  window.__poses = loaded.flatMap((entry, model) =>
    (entry.gltf.animations ?? []).map((clip, index) => ({ model, index, name: clip.name, duration: clip.duration })));
  window.__show = async (model, index, fraction) => {
    for (const other of loaded) { scene.remove(other.gltf.scene); other.mixer.stopAllAction(); }
    const entry = loaded[model];
    scene.add(entry.gltf.scene);
    const clip = entry.gltf.animations[index];
    entry.mixer.clipAction(clip).play();
    entry.mixer.setTime(clip.duration * fraction);
    entry.gltf.scene.updateMatrixWorld(true);
    const box = new Box3().setFromObject(entry.gltf.scene);
    const size = box.getSize(new Vector3()), center = box.getCenter(new Vector3());
    const far = Math.max(size.x, size.y, size.z) * 1.8 + 0.5;
    camera.position.set(center.x + far * 0.4, center.y + size.y * 0.1, center.z + far);
    camera.lookAt(center);
    await renderer.compileAsync(scene, camera);
    renderer.render(scene, camera);
    await renderer.backend.device.queue.onSubmittedWorkDone();
  };
  window.__pose = { ready: true, adapter: { vendor: info.vendor ?? "", architecture: info.architecture ?? "", device: info.device ?? "", description: info.description ?? "" } };
} catch (error) { fail(error); }
`;

/** Capture every pose of every model for one arm and one run. */
async function captureArm(browser, softwareAdapterName, arm, models, dir, run) {
  const publicDir = resolve(arm.dir);
  await writeProbePage(publicDir, { models, label: arm.label }, ENTRY);
  const { server, port } = await serveStatic([publicDir]);
  const context = await browser.newContext({ viewport: { width: 640, height: 640 } });
  try {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/probe.html`);
    const handle = await page.waitForFunction(() => window.__pose, undefined, { timeout: 180_000 });
    const state = await handle.jsonValue();
    if (state.error !== undefined) throw new Error(`pose page failed: ${state.error}`);
    const software = softwareAdapterName(state.adapter);
    if (software !== undefined) throw new Error(`refusing software WebGPU adapter: ${software}`);
    const clips = await page.evaluate(() => window.__poses);
    const shots = [];
    for (const clip of clips) {
      for (const fraction of FRACTIONS) {
        await page.evaluate((args) => window.__show(...args), [clip.model, clip.index, fraction]);
        const png = await page.screenshot();
        const name = `${arm.label}-run${run}-${models[clip.model].replace(/\W+/g, "_")}-${clip.index}-${Math.round(fraction * 100)}.png`;
        writeFileSync(join(dir, name), png);
        shots.push({
          name,
          clip: clip.name,
          fraction,
          sha: createHash("sha256").update(png).digest("hex").slice(0, 16),
        });
      }
    }
    return { adapter: state.adapter, shots };
  } finally {
    await context.close();
    server.close();
  }
}

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : args.splice(at, 2)[1];
};
const models = flag("--models", "mannequin-combat.glb,player-viewmodel.glb").split(",");
const runs = Number(flag("--runs", "2"));
const [out, ...armSpecs] = args;
if (out === undefined || armSpecs.length < 2) {
  console.error(
    "usage: asset-pose-capture.mjs <outDir> <label=publicDir> <label=publicDir> [--models a.glb,b.glb] [--runs 2]",
  );
  process.exit(2);
}
mkdirSync(out, { recursive: true });
const arms = armSpecs.map((spec) => ({ label: spec.split("=")[0], dir: spec.split("=")[1] }));
const { chromium } = await import("@playwright/test");
const { WEBGPU_BROWSER_ARGS, resolveBrowserArguments, softwareAdapterName } = await import(
  pathToFileURL(resolve(ROOT, "packages/playtest/dist/runner/index.js")).href
);
const browser = await chromium.launch({
  headless: false,
  args: resolveBrowserArguments(WEBGPU_BROWSER_ARGS),
});
try {
  const report = { arms: {} };
  for (let run = 1; run <= runs; run += 1)
    for (const arm of arms) {
      const result = await captureArm(browser, softwareAdapterName, arm, models, out, run);
      report.arms[arm.label] = [...(report.arms[arm.label] ?? []), result];
    }
  writeFileSync(join(out, "poses.json"), JSON.stringify(report, null, 1));
  const [a, b] = arms.map((arm) => report.arms[arm.label][0].shots);
  const same = a.filter((shot, i) => shot.sha === b[i]?.sha).length;
  console.log(
    `poses per arm ${a.length}; first run, pixel-identical between ${arms[0].label} and ${arms[1].label}: ${same}/${a.length}`,
  );
  console.log(`adapter ${JSON.stringify(report.arms[arms[0].label][0].adapter)}`);
} finally {
  await browser.close();
}
