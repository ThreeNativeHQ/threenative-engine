import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Mesh, PerspectiveCamera, Scene, Vector2, Vector3 } from "three";
import Info from "three/src/renderers/common/Info.js";
import { afterEach, expect, it, vi } from "vitest";
import * as fixtureCore from "../../core/dist/index.js";
import { createAssetLoader } from "../../core/src/assets.js";
import { baseGeometryOf, updateModelLods } from "../../core/src/model-lod.js";
import { ScenePicker } from "../../core/src/picking.js";
import { evaluateRichPlaytestAssertions } from "../../playtest/src/assertion-evaluators.js";
import { screenshotObservations } from "../../playtest/src/runner/steps.js";
import { loadPlaytestScenario } from "../../playtest/src/scenario.js";
import { DecalField, bulletHoleTexture } from "../templates/shooter/src/render/decals.js";
import { createDecalFixture, observeResidency } from "./fixtures/bounded-decals/game.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("requires stable completed render intervals rather than simulated ticks for residency", () => {
  const previous = { renderCalls: 10, stableFrames: 0, geometries: -1, textures: -1, bytes: -1 };
  const current = { renderCalls: 10, geometries: 258, textures: 4, bytes: 6500000 };
  for (let tick = 0; tick < 90; tick += 1) observeResidency(previous, current, true);
  expect(previous.stableFrames).toBe(0);
  for (const calls of [14, 18, 22]) {
    current.renderCalls = calls;
    observeResidency(previous, current, true);
  }
  expect(previous.stableFrames).toBe(3); // One observation per interval, not four internal passes.
  current.renderCalls = 26;
  current.geometries += 1;
  current.bytes += 576;
  observeResidency(previous, current, true);
  expect(previous.stableFrames).toBe(1);
  observeResidency(previous, current, false);
  expect(previous.stableFrames).toBe(0);
  expect(() => observeResidency(previous, { ...current, bytes: Number.NaN }, true)).toThrow(
    /residency/i,
  );
});

it.each([0, 255, 256])(
  "observes the real fixture render before Three resets counters, requiring 256 draws (%i)",
  async (draws) => {
    const expectedGeneration = draws >= 256 ? 1 : 0;
    let config: Parameters<typeof fixtureCore.defineGame>[0] | undefined;
    vi.spyOn(fixtureCore, "defineGame").mockImplementation((value) => {
      config = value;
      return {} as never;
    });
    createDecalFixture();
    const Room = config?.scenes.room;
    if (Room === undefined) throw new Error("Missing actual fixture scene");
    const room = new Room();
    const glb = await readFile(
      new URL("./fixtures/bounded-decals/public/receiver.glb", import.meta.url),
    );
    const manifest = await readFile(
      new URL("./fixtures/bounded-decals/public/assets.manifest.json", import.meta.url),
      "utf8",
    );
    vi.stubGlobal("fetch", async (url: string) =>
      url.endsWith("assets.manifest.json")
        ? new Response(manifest, { headers: { "content-type": "application/json" } })
        : new Response(glb, { headers: { "content-type": "model/gltf-binary" } }),
    );
    const scene = new Scene();
    const camera = new PerspectiveCamera(48, 16 / 9, 0.1, 100);
    const info = new Info();
    Object.assign(info.memory, { geometries: 259, textures: 4, total: 6500000 });
    const state: Record<string, unknown> = {};
    const picker = new ScenePicker({
      camera,
      pointer: () => new Vector2(),
      scene,
      viewport: {} as never,
    });
    const ctx = {
      assets: fixtureCore.createAssetLoader({ basePath: "https://fixture.invalid" }),
      camera,
      scene,
      add: (object: Mesh) => scene.add(object),
      entities: { add: () => {} },
      input: { justPressed: () => false },
      raycast: picker.raycast.bind(picker),
      renderer: { raw: { info } },
      state: { set: (value: Record<string, unknown>) => Object.assign(state, value) },
    } as unknown as fixtureCore.ICtx;
    vi.spyOn(console, "info").mockImplementation(() => {});
    await room.load(ctx);
    const update = room.enter(ctx);
    if (typeof update !== "function") throw new Error("Missing actual fixture update");
    try {
      camera.updateMatrixWorld(true);
      fixtureCore.updateModelLods(scene, camera, 540);
      update(ctx, 0); // The actual post-LOD hit must exist before residency can qualify.
      expect(state.lodHit).toBe(true);
      const receiver = scene.children.find((object) => object instanceof Mesh);
      if (!(receiver instanceof Mesh)) throw new Error("Missing actual receiver");
      info.render.calls = 1;
      for (let draw = 0; draw < 256; draw += 1) info.update(receiver, 6, 1);
      for (let tick = 0; tick < 10; tick += 1) update(ctx, 0);
      expect(state.stableResidencyFrames).toBe(0); // Live counters alone are not a world snapshot.
      for (let interval = 1; interval <= 3; interval += 1) {
        info.reset();
        info.render.calls += 1;
        for (let draw = 0; draw < draws; draw += 1) info.update(receiver, 6, 1);
        room.render(ctx); // The framework invokes this only after this ordinary world render.
        expect(state.residencyGeneration).toBe(0); // Do not publish before the next update.
        info.reset(); // The native RAF ordering can erase per-frame draws before that update.
        expect(info.render.drawCalls).toBe(0);
        expect(info.render.calls).toBe(interval + 1);
        for (let tick = 0; tick < 10; tick += 1) update(ctx, 0);
        expect(state.stableResidencyFrames).toBe(expectedGeneration * interval);
        room.render(ctx); // A repeated hook without another render call cannot add an interval.
        update(ctx, 0);
        expect(state.stableResidencyFrames).toBe(expectedGeneration * interval);
      }
      expect(state.maxDrawCalls).toBe(draws);
      expect(state.residencyGeneration).toBe(expectedGeneration);
      expect(state.residencySamples).toBe(expectedGeneration);
    } finally {
      room.exit(ctx);
      picker.dispose();
    }
  },
);

async function evaluateCapturedPixels(
  scenarioName: string,
  captureName: string,
  run = "36989297734",
) {
  const fixture = fileURLToPath(new URL("./fixtures/bounded-decals/", import.meta.url));
  const loaded = await loadPlaytestScenario(fixture, `${scenarioName}.playtest.json`);
  const scenario = { ...loaded, assert: { visual: loaded.assert?.visual } };
  const png = await readFile(
    new URL(`../../../docs/verification/vq11-decals-${run}/${captureName}.png`, import.meta.url),
  );
  return evaluateRichPlaytestAssertions({
    scenario,
    report: {
      diagnostics: [],
      distance: 0,
      entity: "",
      expectMoved: false,
      frames: 1,
      trivialityOptOuts: [],
      observations: {
        console: [],
        hud: {},
        network: [],
        resources: {},
        visual: screenshotObservations(undefined, png, scenario),
      },
    },
  }).assertions;
}

it("rejects fully hidden decals as intermediate fade evidence despite nonblank receivers", async () => {
  const assertions = await evaluateCapturedPixels("fading", "hidden-decals", "36991562324");
  expect(assertions.filter(({ pass }) => !pass).map(({ id }) => id)).toEqual([
    "visual.3.region.darkPixels",
    "visual.4.region.darkPixels",
  ]);
});

it("rejects a real screenshot missing the right receiver despite a nonblank lit scene", async () => {
  const assertions = await evaluateCapturedPixels("static", "teardown");
  expect(assertions.find(({ id }) => id === "visual.0.region")?.pass).toBe(true);
  expect(assertions.filter(({ pass }) => !pass).map(({ id }) => id)).toEqual([
    "visual.2.region.maxDarkPixels",
  ]);
});

it.each(["static", "motion", "teardown", "restart"])(
  "recognizes visible marks inside the %s receiver regions of actual hosted captures",
  async (name) => {
    const assertions = await evaluateCapturedPixels(name, name === "restart" ? "static" : name);
    expect(assertions.filter(({ id }) => id.endsWith(".region.darkPixels"))).toHaveLength(
      name === "teardown" ? 1 : 2,
    );
    expect(assertions.every(({ pass }) => pass)).toBe(true);
  },
);

it("projects real framework hits onto the fixture's authored surface after actual LOD selection", async () => {
  const glb = await readFile(
    new URL("./fixtures/bounded-decals/public/receiver.glb", import.meta.url),
  );
  const manifest = await readFile(
    new URL("./fixtures/bounded-decals/public/assets.manifest.json", import.meta.url),
    "utf8",
  );
  vi.stubGlobal("fetch", async (url: string) =>
    url.endsWith("assets.manifest.json")
      ? new Response(manifest, { headers: { "content-type": "application/json" } })
      : new Response(glb, { headers: { "content-type": "model/gltf-binary" } }),
  );
  const loader = createAssetLoader({ basePath: "https://fixture.invalid" });
  const loaded = await loader.model<{ scene: Scene }>("receiver.glb");
  const receiver = loaded.scene.getObjectByProperty("isMesh", true);
  if (!(receiver instanceof Mesh)) throw new Error("Fixture mesh missing");
  const base = baseGeometryOf(receiver);
  expect(base.index?.count).toBe(384);
  const root = new Scene();
  root.add(receiver);
  const camera = new PerspectiveCamera(48, 16 / 9, 0.1, 100);
  camera.position.set(0, 0, 12);
  camera.updateMatrixWorld(true);
  root.updateMatrixWorld(true);
  expect(updateModelLods(root, camera, 540)).toBe(2);
  expect(receiver.geometry).not.toBe(base);
  expect(baseGeometryOf(receiver)).toBe(base);
  const picker = new ScenePicker({
    camera,
    pointer: () => new Vector2(),
    scene: root,
    viewport: {} as never,
  });
  const hit = picker.raycast({
    origin: new Vector3(1, 1, 2),
    direction: new Vector3(0, 0, -1),
    targets: receiver,
  });
  expect(hit?.object).toBe(receiver);
  expect(hit?.point.toArray()).toEqual([1, 1, 0]);
  const map = bulletHoleTexture(8);
  const field = new DecalField(root, {
    countPerVariant: 1,
    size: 0.2,
    offset: 0.01,
    map,
    tints: { impact: 0xffffff },
  });
  if (hit?.face === null || hit?.face === undefined) throw new Error("Fixture hit normal missing");
  expect(
    field.project(receiver, baseGeometryOf(receiver), hit.point, hit.face.normal, "impact", {
      depth: 0.1,
    }),
  ).toBe(true);
  const mark = receiver.children[0];
  if (!(mark instanceof Mesh)) throw new Error("Fixture mark missing");
  const projected = mark.geometry;
  camera.position.z = 0.3;
  camera.updateMatrixWorld(true);
  expect(updateModelLods(root, camera, 540)).toBe(128);
  expect(receiver.geometry).toBe(base);
  expect(mark.geometry).toBe(projected);
  expect(
    picker
      .raycast({
        origin: new Vector3(1, 1, 2),
        direction: new Vector3(0, 0, -1),
        targets: receiver,
        exclude: receiver.children,
      })
      ?.point.toArray(),
  ).toEqual([1, 1, 0]);
  field.dispose();
  map.dispose();
  picker.dispose();
});
