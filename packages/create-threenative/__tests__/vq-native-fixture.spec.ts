import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { compileAssets } from "@threenative/assets";
import { createAssetLoader } from "@threenative/core";
import {
  AnimationClip,
  Group,
  PerspectiveCamera,
  QuaternionKeyframeTrack,
  Scene,
  Texture,
  type Group as ThreeGroup,
} from "three";
import { describe, expect, it, test, vi } from "vitest";
import {
  MODEL_NAMES,
  generateNativeAssetFixture,
  inspectFixtureModel,
} from "../../../examples/abyss-framework/vq-assets/generate.js";
import { AssetScene } from "../../../examples/abyss-framework/vq-assets/src/game.js";
import config from "../../../examples/abyss-framework/vq-assets/threenative.config.js";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { assertNativeAssetsCompatible } from "../src/build.js";
import { loadConfig } from "../src/config.js";

/** One glb with the shape the fixture's models have: a node the player can find and a turn clip. */
function fixtureModel(name: string): { scene: Group; animations: AnimationClip[] } {
  const scene = new Group();
  scene.name = name;
  const node = new Group();
  node.name = `${name}-animated`;
  scene.add(node);
  const turn = new AnimationClip("turn", 2, [
    new QuaternionKeyframeTrack(
      `${node.name}.quaternion`,
      [0, 1, 2],
      [0, 0, 0, 1, 0, Math.sin(0.3), 0, Math.cos(0.3), 0, 0, 0, 1],
    ),
  ]);
  return { scene, animations: [turn] };
}

type Owned = { geometries: number; textures: number };

/**
 * One enter against a stand-in context: `press` is the key the lifecycle scenario's step delivers,
 * and `tally` is what the renderer's live counts would report for the frame being drawn.
 */
function enterOnce(options: { press: () => boolean; tally: () => Owned | undefined }) {
  const assets = createAssetLoader({
    model: async (url) => fixtureModel(url.replace(/^.*\//u, "").replace(/\.glb$/u, "")),
    texture: async () => new Texture(),
  });
  const scene = new Scene();
  const published: Record<string, number> = {};
  const left: string[] = [];
  const ctx = {
    assets,
    camera: new PerspectiveCamera(),
    add: (object: ThreeGroup) => scene.add(object),
    goto: async (name: string) => {
      left.push(name);
    },
    input: {
      justPressed: (action: string) => action === "lifecycle" && options.press(),
    },
    renderer: {
      get info() {
        return { memory: options.tally() };
      },
    },
    scene,
    state: { set: (values: Record<string, number>) => Object.assign(published, values) },
  } as unknown as Parameters<AssetScene["enter"]>[0];
  return { ctx, left, published };
}

/**
 * The fixture's own leave/re-enter sequence, entered `enters` times in one process. The module is
 * re-imported per run because the lifetime ledger that counts the enters is module scope — that is
 * the whole reason only a value outliving the scene can count its own re-entries.
 */
async function runLifecycle(options: {
  enters: number;
  press: (enter: number) => boolean;
  tally: (enter: number, drawn: number) => Owned | undefined;
}): Promise<Array<Record<string, number | boolean>>> {
  vi.resetModules();
  const { AssetScene: Scene_ } = await import(
    "../../../examples/abyss-framework/vq-assets/src/game.js"
  );
  const observed: Array<Record<string, number | boolean>> = [];
  for (let enter = 1; enter <= options.enters; enter += 1) {
    let drawn = 0;
    const { ctx, left, published } = enterOnce({
      press: () => options.press(enter),
      tally: () => options.tally(enter, drawn++),
    });
    const assetScene = new Scene_();
    await assetScene.load(ctx);
    const frame = assetScene.enter(ctx);
    if (typeof frame !== "function") throw new Error("enter() returned no frame function");
    for (let tick = 0; tick < 900 && left.length === 0; tick += 1) frame(ctx, 1 / 60);
    observed.push({ ...published, left: left.length > 0 });
  }
  return observed;
}

test("real Meshopt and Draco inputs retain decoded geometry, images and animation through the decoder-free cook", async () => {
  const cwd = await makeTempDir("vq01-fixture-");
  const source = path.join(cwd, config.assets.source);
  const ktx2 = await generateNativeAssetFixture(source);
  await writeFile(path.join(cwd, "package.json"), '{"name":"vq-fixture","type":"module"}');
  await writeFile(
    path.join(cwd, "threenative.config.ts"),
    `export default ${JSON.stringify(config)};`,
  );
  const before = await Promise.all(
    MODEL_NAMES.map((name) => inspectFixtureModel(path.join(source, `${name}.glb`))),
  );
  expect(before[0]?.extensions).toContain("EXT_meshopt_compression");
  expect(before[1]?.extensions).toContain("KHR_draco_mesh_compression");
  await compileAssets({
    cwd,
    config: config.assets,
    platform: "desktop",
    runtimeDecoders: { ktx2: false, meshopt: false },
    runtimeIdentity: "test:quickjs",
  });
  const output = path.join(cwd, config.assets.output);
  const manifest = JSON.parse(await readFile(path.join(output, "assets.manifest.json"), "utf8"));
  for (const [index, name] of MODEL_NAMES.entries()) {
    const original = before[index];
    if (!original) throw new Error("Missing source measurement");
    const cooked = await inspectFixtureModel(
      path.join(output, manifest.entries[`${name}.glb`].output),
    );
    expect(cooked.extensions).not.toContain("EXT_meshopt_compression");
    expect(cooked.extensions).not.toContain("KHR_draco_mesh_compression");
    expect(cooked.triangles).toBe(original.triangles);
    expect(cooked.positions).toEqual(original.positions);
    expect(cooked.animation).toEqual(original.animation);
    expect(cooked.images.map((image) => image.data)).toEqual(
      original.images.map((image) => image.data),
    );
  }
  expect(manifest.entries["checker.png"].output).toMatch(/\.png$/u);
  await expect(
    assertNativeAssetsCompatible(cwd, "desktop", await loadConfig(cwd)),
  ).resolves.toBeUndefined();
  await writeFile(path.join(source, "authored.ktx2"), ktx2);
  await compileAssets({
    cwd,
    config: config.assets,
    platform: "desktop",
    runtimeDecoders: { ktx2: false, meshopt: false },
    runtimeIdentity: "test:quickjs",
  });
  await expect(assertNativeAssetsCompatible(cwd, "desktop", await loadConfig(cwd))).rejects.toThrow(
    /TN_NATIVE_KTX2_UNSUPPORTED.*authored.ktx2/u,
  );
});

test("fixture exit disposes its configured PNG clone and cached original exactly once", async () => {
  const original = new Texture();
  const assets = createAssetLoader({
    model: async () => ({ scene: new Group(), animations: [] }),
    texture: async () => original,
  });
  const scene = new AssetScene();
  const ctx = { assets } as Parameters<AssetScene["load"]>[0];
  const dispose = vi.spyOn(Texture.prototype, "dispose");
  try {
    await scene.load(ctx);
    scene.exit(ctx);
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(new Set(dispose.mock.contexts).size).toBe(2);
    expect(dispose.mock.contexts).toContain(original);
    scene.exit(ctx);
    expect(dispose).toHaveBeenCalledTimes(2);
  } finally {
    dispose.mockRestore();
    assets.clear();
  }
});

describe("the fixture's leave/re-enter cycle", () => {
  /** Six geometries and three sampled textures: the fixture's own live set, already uploaded. */
  const steady = (): Owned => ({ geometries: 6, textures: 3 });

  it("stays in its scene unless the lifecycle scenario asks it to leave", async () => {
    const observed = await runLifecycle({ enters: 4, press: () => false, tally: steady });

    expect(observed.map((entry) => entry.left)).toEqual([false, false, false, false]);
    expect(observed.map((entry) => entry.frames)).toEqual([900, 900, 900, 900]);
  });

  it("leaves and re-enters once the lifecycle scenario presses its key", async () => {
    const observed = await runLifecycle({ enters: 4, press: () => true, tally: steady });

    expect(observed.map((entry) => entry.entries)).toEqual([1, 2, 3, 4]);
    // Three leaves, then the fourth enter stays: one load plus three leave/re-enter cycles.
    expect(observed.map((entry) => entry.left)).toEqual([true, true, true, false]);
  });

  it("reads an enter only once its tally has settled, so a climbing upload is not a leak", async () => {
    // `info.memory` counts what the backend has initialised, which lands over several frames: a
    // baseline read on the first measured frame is smaller than the scene's own live set, and the
    // next enter's larger sample then reads as growth it never had.
    const climbing = (enter: number, drawn: number): Owned => ({
      geometries: Math.min(6, enter === 1 ? 1 + drawn / 20 : 6),
      textures: 3,
    });
    const observed = await runLifecycle({
      enters: 4,
      press: (enter) => enter >= 2,
      tally: climbing,
    });

    expect(observed[3]?.geometryGrowth).toBe(0);
    expect(observed[3]?.textureGrowth).toBe(0);
    expect(observed[3]?.ownedGeometries).toBe(6);
  });

  it("still reports growth when a later enter leaves more live than the first", async () => {
    // The half that keeps the measurement honest: a measurement that never reports growth would
    // pass the case above by refusing to measure at all.
    const leaking = (enter: number): Owned => ({ geometries: 2 * enter, textures: enter });
    const observed = await runLifecycle({
      enters: 4,
      press: (enter) => enter >= 2,
      tally: leaking,
    });

    expect(observed[3]?.geometryGrowth).toBe(6);
    expect(observed[3]?.textureGrowth).toBe(3);
  });
});
