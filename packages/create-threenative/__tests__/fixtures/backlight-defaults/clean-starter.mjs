import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import {
  parseStandalonePlaytestArgs,
  withBrowserCapture,
} from "../../../../playtest/dist/runner/index.js";
import { PerspectiveCamera } from "../../../node_modules/three/build/three.module.js";
const flags = [
  "--ozone-platform=x11",
  "--enable-unsafe-webgpu",
  "--disable-gpu-sandbox",
  "--ignore-gpu-blocklist",
  "--enable-features=Vulkan",
  "--use-angle=vulkan",
  "--use-vulkan=native",
  "--disable-vulkan-fallback-to-gl-for-testing",
];

const arm = process.argv[2];
assert.ok(["before", "after"].includes(arm));
const port = arm === "before" ? 5194 : 5195;
const out = `artifacts/backlight-defaults/clean-starter-${arm}-capture${process.argv[3] ?? "2"}`;
const config = parseStandalonePlaytestArgs([
  "--scenario",
  "packages/create-threenative/__tests__/fixtures/backlight-defaults/cost.playtest.json",
  "--url",
  `http://127.0.0.1:${port}/`,
  "--timeout",
  "60000",
  "--artifacts",
  out,
  ...flags.flatMap((flag) => ["--browser-arg", flag]),
]);
await withBrowserCapture(config, async (session) => {
  const snapshot = await session.bridge.sample({
    include: ["components", "renderChain", "runtimeObservations", "state", "scene"],
    label: "clean-default-starter-ready",
  });
  assert.equal(session.provenance.adapter.vendor, "nvidia");
  assert.equal(session.provenance.adapter.architecture, "turing");
  await mkdir(out, { recursive: true });
  await writeFile(
    `${out}/snapshot.json`,
    JSON.stringify({ arm, provenance: session.provenance, snapshot }, null, 2),
  );
  await session.screenshot("default-starter-ready");
  const camera = new PerspectiveCamera();
  camera.position.set(-6, 1.45, -2.7);
  camera.lookAt(-2, 1.25, 0);
  const requested = { position: camera.position.toArray(), rotation: camera.quaternion.toArray() };
  await session.bridge.applySetup({ entities: [{ entity: "camera.main", transform: requested }] });
  await session.page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  const backlit = await session.bridge.sample({
    include: ["components", "renderChain", "state", "scene"],
    label: "clean-default-starter-backlit-camera",
  });
  const observed = backlit.entities.find((row) => row.id === "camera.main").transform;
  assert.deepEqual(observed.position, requested.position);
  assert.deepEqual(observed.rotation, requested.rotation);
  assert.deepEqual(
    backlit.clock,
    snapshot.clock,
    "Camera placement must not advance character/content pose.",
  );
  await writeFile(
    `${out}/backlit-snapshot.json`,
    JSON.stringify({ arm, requested, provenance: session.provenance, snapshot: backlit }, null, 2),
  );
  await session.screenshot("backlit-starter-camera");
  if (arm === "after") {
    const restart = await session.page.evaluate(async () => {
      const { default: game } = await import("/src/game.ts");
      const raw = game.ctx.renderer.raw;
      const source = game.ctx.scene.environment;
      const original = raw.readRenderTargetPixelsAsync;
      let readbacks = 0;
      raw.readRenderTargetPixelsAsync = function (...args) {
        readbacks++;
        return original.apply(this, args);
      };
      const start = performance.now();
      try {
        await game.goto("play");
        return {
          readbacks,
          elapsedMs: performance.now() - start,
          sameSource: game.ctx.scene.environment === source,
          backendWebGL: raw.backend.isWebGLBackend === true,
        };
      } finally {
        raw.readRenderTargetPixelsAsync = original;
      }
    });
    assert.equal(restart.sameSource, true);
    assert.equal(restart.readbacks, 0);
    assert.equal(restart.backendWebGL, false);
    const cached = await session.bridge.sample({
      include: ["components"],
      label: "cached-restart",
    });
    assert.equal(cached.components["material-lighting"].status, "measured");
    await writeFile(
      `${out}/cached-restart.json`,
      JSON.stringify(
        { restart, materialLighting: cached.components["material-lighting"] },
        null,
        2,
      ),
    );
  }
  console.log(
    JSON.stringify({
      arm,
      provenance: session.provenance,
      clock: snapshot.clock,
      performance: snapshot.performance,
    }),
  );
});
