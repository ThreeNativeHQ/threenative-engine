/**
 * PRD-799 phase 1: the adaptive LOD bias loop had no spec of its own.
 *
 * The loop is `#adaptLodBias(renderer)` inside `update`, and every input it reads is observable
 * from outside the class: the clock is `admissionNow`, the renderer surface is `gpuMainMs()` and
 * `targetFps()`, and the answer is the shared multiplier `lodBias()` reports from `model-lod.ts`.
 * So this pins the step cadence, the rise and decay factors, the band between them, the bounds, and
 * the two gates that hold a rise: the prewarm a loading screen is still waiting on, and a window
 * with no fresh GPU sample. The loop reads the prewarm at the top of the frame, so the ring is
 * drained over the committed `world-v1` package before the clock steps.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, type Object3D } from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lodBias, setLodBias } from "../src/model-lod.js";
import type { IRendererLike } from "../src/renderer.js";
import { LOD_BIAS_MARKER, WorldCells } from "../src/world-cells.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "world-v1");

/** The loop's own constants, restated here so a change to them is a change to this spec. */
const STEP_MS = 500;
const RISE = 1.08;
const DECAY = 0.95;
const MAX = 2.5;
const FPS = 60;
const FRAME_MS = 1000 / FPS;
const AFFORDABLE_MS = 0.5 * FRAME_MS;
/** The band: decay below `0.6 x` the affordable share, rise above it, hold between. */
const OVER_BUDGET_MS = 0.9 * FRAME_MS;
const UNDER_BUDGET_MS = 0.2 * FRAME_MS;
const IN_BAND_MS = 0.4 * FRAME_MS;

const budgets = { bytes: 1_000_000_000, instances: 1_000_000, residentCells: 64 };
const surface = new MeshBasicMaterial();

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

/** The renderer surface the loop reads: the smoothed main-pass GPU time and the frame it is a share of. */
function stubRenderer(
  gpuMs: () => number | undefined,
  fps: number | undefined = FPS,
): IRendererLike {
  return { gpuMainMs: gpuMs, targetFps: () => fps } as unknown as IRendererLike;
}

async function flush(rounds = 12): Promise<void> {
  for (let round = 0; round < rounds; round += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
}

interface IWorldUnderTest {
  readonly world: WorldCells;
  /** Advance the injected clock; the loop's cadence and the first marker line read it. */
  advance(ms: number): void;
}

/**
 * A world over the committed package, in a parent so its prewarm can settle, on an injected clock.
 *
 * The admission budget is unbounded so a ring drains in a frame: what this spec measures is the LOD
 * bias, and paying admission time for it would only make the clock's step cadence imprecise.
 */
async function makeWorld(
  options: { readonly adaptiveLod?: boolean } = {},
): Promise<IWorldUnderTest> {
  stubFixtureFetch();
  let clock = 0;
  const world = await WorldCells.load({
    ...(options.adaptiveLod === undefined ? {} : { adaptiveLod: options.adaptiveLod }),
    admissionBudgetMs: Number.POSITIVE_INFINITY,
    admissionNow: () => clock,
    budgets,
    follow: { position: { x: 96, z: 96 } },
    freshMeshesPerUpdate: Number.MAX_SAFE_INTEGER,
    gpuScene: false,
    loadModel: async () => model(),
    ring: 0,
    surface,
    terrain: false,
    url: "/world/world.json",
  });
  new Group().add(world);
  return {
    advance: (ms) => {
      clock += ms;
    },
    world,
  };
}

/**
 * Update until no build and no prewarm is owed, which is the gate the rise waits on.
 *
 * The clock does not move here, so every step of this drain is the same step of the bias loop.
 */
async function drain(world: WorldCells, limit = 2000): Promise<void> {
  for (let frame = 0; frame < limit; frame += 1) {
    world.update();
    await flush(4);
    const stats = world.stats();
    if (
      stats.admission.backlog === 0 &&
      stats.admission.deferred === 0 &&
      stats.pendingPrewarm === 0
    )
      return;
  }
  throw new Error(`WorldCells still owed ${String(world.stats().pendingPrewarm)} prewarm.`);
}

/** One step of the loop on the renderer's reading, `STEP_MS` after the last one. */
function step(clock: IWorldUnderTest, renderer: IRendererLike): void {
  clock.advance(STEP_MS);
  clock.world.update(renderer);
}

/** The `TN_LOD_BIAS` lines the loop printed since the spy was armed. */
function markerLines(lines: string[]): string[] {
  return lines.filter((line) => line.startsWith(`${LOD_BIAS_MARKER} `));
}

beforeEach(() => {
  // The multiplier is module-global and shared with every other world in this process.
  setLodBias(1);
});

afterEach(() => {
  setLodBias(1);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("WorldCells adaptive LOD bias", () => {
  it("holds while the prewarm is owed, then raises by LOD_BIAS_RISE once per step", async () => {
    const underTest = await makeWorld();
    const { world } = underTest;
    const renderer = stubRenderer(() => OVER_BUDGET_MS);
    try {
      // A fresh world has minted but not drawn its prewarm, which is the loading screen's gate.
      world.update(renderer);
      await flush();
      world.update(renderer);
      expect(world.stats().pendingPrewarm).toBeGreaterThan(0);
      step(underTest, renderer);
      expect(lodBias()).toBe(1);

      await drain(world);
      expect(world.stats().pendingPrewarm).toBe(0);
      // The gate opened on a drained ring, so the same over-budget reading now rises.
      step(underTest, renderer);
      expect(lodBias()).toBeCloseTo(RISE, 12);
      step(underTest, renderer);
      expect(lodBias()).toBeCloseTo(RISE * RISE, 12);
    } finally {
      world.dispose();
    }
  });

  it("clamps a runaway at LOD_BIAS_MAX and decays comfortably under budget back to 1", async () => {
    const underTest = await makeWorld();
    const { world } = underTest;
    const over = stubRenderer(() => OVER_BUDGET_MS);
    const under = stubRenderer(() => UNDER_BUDGET_MS);
    try {
      await drain(world);
      for (let count = 0; count < 40; count += 1) step(underTest, over);
      expect(lodBias()).toBe(MAX);

      // Between the decay share and the budget the bias holds: the band that stops an oscillation.
      const inBand = stubRenderer(() => IN_BAND_MS);
      for (let count = 0; count < 10; count += 1) step(underTest, inBand);
      expect(lodBias()).toBe(MAX);

      step(underTest, under);
      expect(lodBias()).toBeCloseTo(MAX * DECAY, 12);
      for (let count = 0; count < 200; count += 1) step(underTest, under);
      // The floor is the authored chain's own selection, so the decay stops there rather than below.
      expect(lodBias()).toBe(1);
    } finally {
      world.dispose();
    }
  });

  it("takes one step per cadence and holds on a window with no fresh GPU sample", async () => {
    const underTest = await makeWorld();
    const { world } = underTest;
    let gpuMs: number | undefined = OVER_BUDGET_MS;
    const renderer = stubRenderer(() => gpuMs);
    try {
      await drain(world);
      // Inside the cadence the loop does not run: 499 ms after the last step is the same step.
      world.update(renderer);
      const first = lodBias();
      underTest.advance(STEP_MS - 1);
      world.update(renderer);
      expect(lodBias()).toBe(first);

      // No sample is not a reading of zero: the bias holds, and the next sample steps at once.
      gpuMs = undefined;
      for (let count = 0; count < 5; count += 1) step(underTest, renderer);
      expect(lodBias()).toBe(first);
      gpuMs = OVER_BUDGET_MS;
      step(underTest, renderer);
      expect(lodBias()).toBeCloseTo(first * RISE, 12);
    } finally {
      world.dispose();
    }
  });

  it("prints at most one TN_LOD_BIAS line per second while it moves the bias", async () => {
    const underTest = await makeWorld();
    const { world } = underTest;
    const lines: string[] = [];
    const info = vi.spyOn(console, "info").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    try {
      await drain(world);
      const over = stubRenderer(() => OVER_BUDGET_MS);
      world.update(over);
      lines.length = 0;
      // Three steps 500 ms apart: the first and the third are a second apart.
      for (let count = 0; count < 3; count += 1) step(underTest, over);
      const printed = markerLines(lines);
      expect(printed).toHaveLength(2);
      expect(printed[0]).toMatch(
        new RegExp(
          `^${LOD_BIAS_MARKER} bias=\\d+\\.\\d{3} gpuMs=${OVER_BUDGET_MS.toFixed(2)} budgetMs=${AFFORDABLE_MS.toFixed(2)} tris=n/a$`,
          "u",
        ),
      );
      expect(info).toHaveBeenCalled();
    } finally {
      world.dispose();
    }
  });

  it("pins the multiplier at 1 when adaptiveLod is off", async () => {
    const underTest = await makeWorld({ adaptiveLod: false });
    const { world } = underTest;
    try {
      await drain(world);
      for (let count = 0; count < 10; count += 1)
        step(
          underTest,
          stubRenderer(() => OVER_BUDGET_MS),
        );
      expect(lodBias()).toBe(1);
    } finally {
      world.dispose();
    }
  });
});
