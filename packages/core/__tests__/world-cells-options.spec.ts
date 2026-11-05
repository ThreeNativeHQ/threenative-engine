/**
 * PRD-799 phase 1: the two instance-scoped answers `world-cells.ts` derives from a launch.
 *
 * The pure flag readers already have a spec (`world-gpu-flags.spec.ts`, PRD-798). What had none is
 * the resolution on top of them: `WorldCells.load` reads the option first, then the environment,
 * the query string and the global, and keeps the answer on the instance. This pins that order where
 * the instance shows it — `stats().lodFrom`, `stats().bundle.reason`, `stats().gpuScene.reason`, the
 * `mainGpuShare` validation, and the adaptive-loop switch — and pins `terrainReadinessInView`
 * answering for terrain inside the camera's view and nothing outside it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BoxGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  PerspectiveCamera,
} from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lodBias, setLodBias } from "../src/model-lod.js";
import type { IRendererLike } from "../src/renderer.js";
import { type IWorldCellsLoadOptions, type IWorldPackage, WorldCells } from "../src/world.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "world-v1");
const manifest = JSON.parse(
  readFileSync(path.join(fixture, "world.json"), "utf8"),
) as IWorldPackage;

const budgets = { bytes: 1_000_000_000, instances: 1_000_000, residentCells: 64 };
const surface = new MeshBasicMaterial();
const SPACING = 500;

interface IResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: Headers;
  arrayBuffer: () => Promise<ArrayBuffer>;
  json: () => Promise<unknown>;
}

function fileResponse(buffer: Buffer): IResponseLike {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    arrayBuffer: async () =>
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
    json: async () => JSON.parse(buffer.toString("utf8")),
  };
}

function stubFixtureFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown): Promise<IResponseLike> => {
      const url = String(input);
      if (url.endsWith("world.json"))
        return fileResponse(readFileSync(path.join(fixture, "world.json")));
      if (url.endsWith("placements.bin"))
        return fileResponse(readFileSync(path.join(fixture, "placements.bin")));
      if (url.endsWith("heightmap.u16"))
        return fileResponse(readFileSync(path.join(fixture, "terrain", "heightmap.u16")));
      return {
        ok: false,
        status: 404,
        headers: new Headers(),
        arrayBuffer: async () => new ArrayBuffer(0),
        json: async () => ({}),
      };
    }),
  );
}

function model(): Object3D {
  const group = new Group();
  group.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial()));
  return group;
}

async function flush(rounds = 12): Promise<void> {
  for (let round = 0; round < rounds; round += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
}

/** A world over the committed package, with the terrain ring on unless the case turns it off. */
async function load(options: Partial<IWorldCellsLoadOptions> = {}): Promise<WorldCells> {
  stubFixtureFetch();
  return WorldCells.load({
    budgets,
    follow: { position: { x: 96, z: 96 } },
    loadModel: async () => model(),
    ring: 1,
    surface,
    url: "/world/world.json",
    ...options,
  });
}

/** The launch surface every reader walks: environment, then query string, then global. */
const host = globalThis as Record<string, unknown>;
const ENV = process.env;
const FLAGS = [
  "TN_LOD_FROM_CAMERA",
  "TN_BUNDLES",
  "TN_GPU_SCENE",
  "TN_MAIN_GPU_SHARE",
  "TN_ADAPTIVE_LOD",
];
const GLOBALS = [
  "__tnLodFromCamera",
  "__tnBundles",
  "__tnGpuScene",
  "__tnMainGpuShare",
  "__tnAdaptiveLod",
];

function env(name: string, value: string | undefined): void {
  if (value === undefined) delete ENV[name];
  else ENV[name] = value;
}
function query(search: string | undefined): void {
  host.location = search === undefined ? undefined : { search };
}
function setGlobal(name: string, value: unknown): void {
  if (value === undefined) delete host[name];
  else host[name] = value;
}

/** The three names each switch is asked under, so a case names the switch rather than three strings. */
const LAUNCH = {
  adaptiveLod: {
    env: "TN_ADAPTIVE_LOD",
    global: "__tnAdaptiveLod",
    parameter: "tnAdaptiveLod",
  },
  bundles: { env: "TN_BUNDLES", global: "__tnBundles", parameter: "tnBundles" },
  lodFrom: { env: "TN_LOD_FROM_CAMERA", global: "__tnLodFromCamera", parameter: "tnLodFromCamera" },
} as const;

/** Every launch source cleared, so one case cannot see what the previous one asked. */
function clearLaunch(): void {
  for (const flag of FLAGS) env(flag, undefined);
  for (const name of GLOBALS) setGlobal(name, undefined);
  query(undefined);
}

function askedOff(switchName: keyof typeof LAUNCH, via: "env" | "query" | "global"): void {
  const names = LAUNCH[switchName];
  if (via === "env") env(names.env, "0");
  if (via === "query") query(`?${names.parameter}=0`);
  if (via === "global") setGlobal(names.global, 0);
}

function askedOn(switchName: keyof typeof LAUNCH, via: "env" | "query" | "global"): void {
  const names = LAUNCH[switchName];
  if (via === "env") env(names.env, "1");
  if (via === "query") query(`?${names.parameter}=1`);
  if (via === "global") setGlobal(names.global, 1);
}

beforeEach(() => {
  setLodBias(1);
});

afterEach(() => {
  for (const flag of FLAGS) env(flag, undefined);
  for (const name of GLOBALS) setGlobal(name, undefined);
  query(undefined);
  setLodBias(1);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("WorldCells option resolution", () => {
  it("grades levels from the camera unless the launch or the option says otherwise", async () => {
    const cases: Array<{
      readonly ask: () => void;
      readonly expected: "camera" | "follow";
      readonly why: string;
    }> = [
      { ask: () => undefined, expected: "camera", why: "the default" },
      { ask: () => askedOff("lodFrom", "env"), expected: "follow", why: "TN_LOD_FROM_CAMERA=0" },
      { ask: () => askedOff("lodFrom", "query"), expected: "follow", why: "?tnLodFromCamera=0" },
      {
        ask: () => askedOff("lodFrom", "global"),
        expected: "follow",
        why: "__tnLodFromCamera = 0",
      },
      // Only an off answer counts: a launch that says "on" is the default.
      { ask: () => askedOn("lodFrom", "env"), expected: "camera", why: "TN_LOD_FROM_CAMERA=1" },
    ];
    for (const { ask, expected, why } of cases) {
      clearLaunch();
      ask();
      const world = await load();
      try {
        expect(world.stats().lodFrom, why).toBe(expected);
      } finally {
        world.dispose();
      }
    }

    // The environment is read before the query string, which is read before the global.
    clearLaunch();
    askedOff("lodFrom", "env");
    askedOn("lodFrom", "query");
    askedOn("lodFrom", "global");
    const world = await load();
    try {
      expect(world.stats().lodFrom).toBe("follow");
    } finally {
      world.dispose();
    }
  });

  it("lets the option win over every launch source", async () => {
    clearLaunch();
    askedOff("lodFrom", "env");
    const world = await load({ lodFrom: "camera" });
    try {
      expect(world.stats().lodFrom).toBe("camera");
    } finally {
      world.dispose();
    }

    clearLaunch();
    askedOn("bundles", "env");
    const bundles = await load({ bundles: false });
    try {
      expect(bundles.stats().bundle.reason).toBe("option");
    } finally {
      bundles.dispose();
    }
  });

  it("names who decided the draw bundles: the option, the launch, or nobody", async () => {
    const cases: Array<{ readonly ask: () => void; readonly reason: string }> = [
      { ask: () => undefined, reason: "default" },
      { ask: () => askedOff("bundles", "env"), reason: "launch" },
      { ask: () => askedOff("bundles", "query"), reason: "launch" },
      { ask: () => askedOff("bundles", "global"), reason: "launch" },
    ];
    for (const { ask, reason } of cases) {
      clearLaunch();
      ask();
      const world = await load();
      try {
        expect(world.stats().bundle.reason).toBe(reason);
      } finally {
        world.dispose();
      }
    }
  });

  it("reports an option that turned the GPU scene off as the option, never as a launch", async () => {
    clearLaunch();
    setGlobal("__tnGpuScene", 1);
    const world = await load({ gpuScene: false });
    try {
      // The first frame with a renderer is the one that answers; before it the scene is unattached.
      world.update({} as IRendererLike);
      expect(world.stats().gpuScene.reason).toBe("option-off");
    } finally {
      world.dispose();
    }
  });

  it("reads mainGpuShare from the option, then the launch, and refuses a share outside (0, 1]", async () => {
    // The launch value is invalid; the option is not, so the option is the one that was read.
    clearLaunch();
    env("TN_MAIN_GPU_SHARE", "2");
    const optioned = await load({ mainGpuShare: 0.25 });
    optioned.dispose();
    // With no option the same launch value is the answer, and it fails closed.
    await expect(load()).rejects.toThrow("mainGpuShare must be a number in (0, 1]");
    env("TN_MAIN_GPU_SHARE", undefined);
    // The query string and the global are the same switch, so they refuse the same way.
    query("?tnMainGpuShare=0");
    await expect(load()).rejects.toThrow("mainGpuShare must be a number in (0, 1]");
    query(undefined);
    setGlobal("__tnMainGpuShare", 1.5);
    await expect(load()).rejects.toThrow("mainGpuShare must be a number in (0, 1]");
    setGlobal("__tnMainGpuShare", 0.5);
    (await load()).dispose();
  });

  it("refuses an impostorFar value the option does not name", async () => {
    clearLaunch();
    await expect(
      load({ impostorFar: "sometimes" as unknown as IWorldCellsLoadOptions["impostorFar"] }),
    ).rejects.toThrow('impostorFar must be "ring" or "always"');
  });

  it("resolves the share before the impostor option, so an invalid share is the error reported", async () => {
    clearLaunch();
    // Both are invalid. The constructor resolved `mainGpuShare` ahead of `impostorFar` before the
    // split, so the share's error is the one a game sees; a reorder would silently change that.
    await expect(
      load({
        impostorFar: "sometimes" as unknown as IWorldCellsLoadOptions["impostorFar"],
        mainGpuShare: 5,
      }),
    ).rejects.toThrow("mainGpuShare must be a number in (0, 1]");
  });

  it("turns the adaptive LOD bias off from the launch, unless the option turns it back on", async () => {
    clearLaunch();
    setGlobal("__tnAdaptiveLod", 0);
    const over = {
      gpuMainMs: () => 15,
      targetFps: () => 60,
    } as unknown as IRendererLike;
    // A launch that asks for the off switch holds the multiplier at 1 on an over-budget frame.
    const off = await load({ admissionNow: () => SPACING, terrain: false });
    try {
      new Group().add(off);
      await flush();
      off.update(over);
      off.update(over);
      expect(lodBias()).toBe(1);
    } finally {
      off.dispose();
    }
    // The option is read before the launch, so an explicit `true` runs the loop again.
    let clock = 0;
    const on = await load({ adaptiveLod: true, admissionNow: () => clock, terrain: false });
    try {
      new Group().add(on);
      await flush();
      for (let frame = 0; frame < 3; frame += 1) {
        clock += 500;
        on.update(over);
      }
      expect(lodBias()).toBeGreaterThan(1);
    } finally {
      on.dispose();
    }
  });
});

describe("WorldCells terrain readiness in view", () => {
  it("counts the terrain tiles the camera sees and answers zero for the ones behind it", async () => {
    const world = await load();
    const at = { x: 96, z: 96 };
    const height = manifest.terrain.heightMax;
    const camera = new PerspectiveCamera(60, 1, 0.1, 4000);
    try {
      // Above the ring, looking down: the tiles under the camera are in the frustum.
      camera.position.set(at.x, height + 50, at.z);
      camera.rotation.set(-Math.PI / 2, 0, 0);
      camera.updateMatrixWorld(true);
      const below = world.terrainReadinessInView(camera);
      expect(below.required).toBeGreaterThan(0);
      expect(below.loaded).toBeLessThanOrEqual(below.required);

      // The same point, looking up: no terrain bounds intersect the frustum.
      camera.rotation.set(Math.PI / 2, 0, 0);
      camera.updateMatrixWorld(true);
      expect(world.terrainReadinessInView(camera)).toEqual({ required: 0, loaded: 0 });

      // A tile is admitted as the world updates, and an in-view count loads completely.
      camera.rotation.set(-Math.PI / 2, 0, 0);
      camera.updateMatrixWorld(true);
      for (let frame = 0; frame < 200; frame += 1) {
        world.update();
        await flush(2);
        if (world.terrainReadinessInView(camera).loaded === below.required) break;
      }
      expect(world.terrainReadinessInView(camera)).toEqual({
        loaded: below.required,
        required: below.required,
      });
    } finally {
      world.dispose();
    }
  });
});
