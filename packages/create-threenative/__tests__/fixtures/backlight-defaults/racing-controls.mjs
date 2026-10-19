// Actual generated racing controls; no source/gameplay/renderer hooks or fixed-tick advancement.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  parseStandalonePlaytestArgs,
  withBrowserCapture,
} from "../../../../playtest/dist/runner/index.js";
const base = resolve("artifacts/backlight-defaults/racing-controls1");
await mkdir(base, { recursive: true });
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
for (const arm of ["before", "after"]) {
  const project = resolve(`artifacts/backlight-defaults/template-matrix2/racing-${arm}`);
  const output = resolve(base, arm);
  const stages = [];
  const config = parseStandalonePlaytestArgs([
    "--project",
    project,
    "--scenario",
    resolve("packages/create-threenative/__tests__/fixtures/backlight-defaults/cost.playtest.json"),
    "--url",
    "http://127.0.0.1:5196/",
    "--port",
    "5196",
    "--server-command",
    `node ${resolve(project, "node_modules/vite/bin/vite.js")} --host 127.0.0.1 --port 5196 --strictPort > ${resolve(base, `${arm}-server.log`)} 2>&1`,
    "--timeout",
    "60000",
    "--artifacts",
    output,
    ...flags.flatMap((f) => ["--browser-arg", f]),
  ]);
  await withBrowserCapture(config, async (session) => {
    assert.equal(session.provenance.adapter.vendor, "nvidia");
    assert.equal(session.provenance.adapter.architecture, "turing");
    assert.equal(session.provenance.rendererKind, "webgpu");
    let originalClock;
    let presentations = 0;
    const present = async (count) => {
      await session.page.evaluate(async (count) => {
        for (let i = 0; i < count; i++)
          await new Promise((resolve) => requestAnimationFrame(resolve));
      }, count);
      presentations += count;
    };
    const capture = async (label) => {
      const snapshot = await session.bridge.sample({
        include: ["components", "state", "scene", "runtimeObservations", "renderChain"],
        label,
      });
      if (originalClock === undefined) originalClock = snapshot.clock;
      else assert.deepEqual(snapshot.clock, originalClock, "Presentation wait changed fixed pose");
      const raw = await session.page.evaluate(async () => {
        const { default: game } = await import("/src/game.ts");
        const scene = game.ctx.scene;
        const raw = game.ctx.renderer.raw;
        const lights = [];
        const materials = [];
        scene.traverse((object) => {
          if (object.isLight)
            lights.push({
              name: object.name,
              type: object.type,
              color: object.color.toArray(),
              intensity: object.intensity,
              castShadow: object.castShadow,
              shadowReady: Boolean(object.shadow?.map),
              shadowTexture: object.shadow?.map?.texture?.uuid,
            });
          if (object.isMesh)
            for (const m of Array.isArray(object.material) ? object.material : [object.material])
              materials.push({
                name: m.name,
                type: m.type,
                node: m.isNodeMaterial === true,
                receiveShadow: object.receiveShadow,
                castShadow: object.castShadow,
              });
        });
        return {
          environment: scene.environment
            ? {
                uuid: scene.environment.uuid,
                version: scene.environment.version,
                intensity: scene.environmentIntensity,
              }
            : null,
          shadowMap: { enabled: raw.shadowMap.enabled, type: raw.shadowMap.type },
          width: raw.domElement.width,
          height: raw.domElement.height,
          samples: raw.samples,
          lights,
          materials,
        };
      });
      await session.screenshot(label);
      stages.push({ label, explicitPresentationWaits: presentations, snapshot, raw });
      await writeFile(
        resolve(output, "controls.json"),
        JSON.stringify(
          {
            arm,
            provenance: session.provenance,
            scope:
              "explicit RAF waits, screenshots and bridge observation can also present; fixed gameplay clock unchanged; no compileComplete inference",
            stages,
          },
          null,
          2,
        ),
      );
    };
    await capture("initial");
    await present(20);
    await capture("after-20-presentations");
    if (arm === "after") {
      await session.page.evaluate(async () => {
        const { default: game } = await import("/src/game.ts");
        const controller = game.ctx.entities.get("material-lighting");
        if (!controller) throw Error("Missing material controller");
        controller.controls.rimGain = 0;
        controller.report();
      });
      await present(2);
      await capture("rim-zero");
      await session.page.evaluate(async () => {
        const { default: game } = await import("/src/game.ts");
        game.ctx.entities.get("material-lighting").setEnabled(false);
      });
      await present(2);
      await capture("convention-disabled");
    }
  });
  console.log(`${arm} racing controls PASS`);
}
