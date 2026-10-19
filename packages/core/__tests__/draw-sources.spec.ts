import { describe, expect, it } from "vitest";
import { FRAME_BUDGET_MARKER, FrameBudget, type IFrameBudgetWindow } from "../src/frame-budget.js";
import {
  MAIN_DRAW_SOURCES,
  type MainDrawSource,
  RenderPassBudget,
} from "../src/render-pass-budget.js";

/**
 * A drawn mesh carrying exactly the two `userData` fields the classifier reads, set the way the
 * systems that own them set them: a dressed GPU-scene key, a mesh inside the world's `BundleGroup`,
 * a terrain tile level, a whole-map impostor aggregate, and a mesh no world system claimed.
 */
interface IFakeMesh {
  readonly name: string;
  readonly userData: { readonly tnBundled?: boolean; readonly tnDrawSource?: string };
}

function mesh(name: string, userData: IFakeMesh["userData"] = {}): IFakeMesh {
  return { name, userData };
}

/** One render call's own work: its objects, then the nested calls three would make inside it. */
interface IFakeScene {
  readonly name: string;
  readonly nested?: readonly IFakeScene[];
  readonly objects: readonly IFakeMesh[];
  /**
   * Draws submitted with no object behind them, which is what a standalone `WebGLRenderer` reports:
   * its `info.update` takes a vertex count where WebGPU's takes the drawn object.
   */
  readonly unnamed?: number;
}

/**
 * A renderer shaped like the seam `RenderPassBudget` wraps: `info.update` is three's per-draw
 * counter, and it increments the aggregate the pass split is read from, so a draw the attribution
 * misses would show as a hole in the sum rather than as two separate wrong numbers.
 */
interface IFakeRenderer {
  info: {
    render: { calls: number; drawCalls: number; triangles: number };
    update(object: unknown, count: number, instanceCount: number): void;
  };
  render(scene: IFakeScene, camera: object): void;
}

function fakeRenderer(): IFakeRenderer {
  const raw: IFakeRenderer = {
    info: {
      render: { calls: 0, drawCalls: 0, triangles: 0 },
      update(this: IFakeRenderer["info"], object: unknown, count: number, instanceCount: number) {
        this.render.drawCalls += 1;
        this.render.triangles += (count * instanceCount) / 3;
      },
    },
    render(scene: IFakeScene, _camera: object): void {
      for (const object of scene.objects) raw.info.update(object, 3, 1);
      for (let index = 0; index < (scene.unnamed ?? 0); index += 1) raw.info.update(index, 3, 1);
      for (const child of scene.nested ?? []) raw.render(child, {});
    },
  };
  return raw;
}

const SHADOW: IFakeScene = {
  name: "Shadow Map [ Sun ]",
  objects: [
    mesh("shadow:tree:0", { tnDrawSource: "gpuScene" }),
    mesh("shadow:tree:1", { tnDrawSource: "gpuScene" }),
    mesh("shadow:tree:2", { tnDrawSource: "gpuScene" }),
    mesh("shadow:hero"),
    mesh("shadow:water"),
    mesh("shadow:sky"),
  ],
};

/** A dress with no bundles: 3 GPU-scene keys, 5 terrain meshes, 1 impostor aggregate, 3 untagged. */
const BUNDLES_OFF: IFakeScene = {
  name: "",
  nested: [SHADOW],
  objects: [
    mesh("tree:0", { tnDrawSource: "gpuScene" }),
    mesh("tree:1", { tnDrawSource: "gpuScene" }),
    mesh("tree:2", { tnDrawSource: "gpuScene" }),
    mesh("tn-terrain:0", { tnDrawSource: "terrain" }),
    mesh("tn-terrain:1", { tnDrawSource: "terrain" }),
    mesh("tn-terrain:2", { tnDrawSource: "terrain" }),
    // A stitch bridge and a merged block: the terrain source counts every mesh it draws with.
    mesh("tn-bridge:0,1", { tnDrawSource: "terrain" }),
    mesh("tn-terrain-block:0", { tnDrawSource: "terrain" }),
    mesh("tn-far:tree", { tnDrawSource: "proxies" }),
    mesh("hero"),
    mesh("water"),
    mesh("sky"),
  ],
};

/** The same world with bundles on: two meshes sit in the `BundleGroup`, one of them also dressed. */
const BUNDLES_ON: IFakeScene = {
  ...BUNDLES_OFF,
  objects: [
    mesh("tree:0", { tnBundled: true, tnDrawSource: "gpuScene" }),
    mesh("tree:1", { tnDrawSource: "gpuScene" }),
    mesh("tree:2", { tnBundled: true }),
    ...BUNDLES_OFF.objects.slice(3),
  ],
};

/**
 * Drives `frames` presented frames through both meters exactly as `Game` wires them: the pass
 * recorder reads what the renderer submitted, and the frame budget folds those passes into its own
 * window. Returns the window's reported pass record.
 */
function drivePasses(frames: number, scene: IFakeScene, reportEvery = frames): IFrameBudgetWindow {
  const lines: string[] = [];
  const budget = new FrameBudget({ report: (line) => lines.push(line), reportEvery });
  const renderer = fakeRenderer();
  const passes = RenderPassBudget.install(renderer);
  let now = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    budget.beginFrame(frame * 16, now);
    budget.markSimulationEnd(now + 4, 2);
    budget.addRender(6);
    passes?.beginFrame();
    renderer.render(scene, {});
    budget.addRenderPasses(passes?.passes() ?? []);
    now += 16;
    budget.endFrame(now);
  }
  if (lines.length !== 1)
    throw new Error(`Expected one reported window, got ${String(lines.length)}.`);
  return JSON.parse((lines[0] ?? "").slice(`${FRAME_BUDGET_MARKER}:`.length)) as IFrameBudgetWindow;
}

/**
 * A world whose main pass draws `count` meshes from one system alone, so the split either names that
 * system or says nothing at all: a tag the classifier does not know lands in `other`, which is the
 * answer this exists to rule out.
 */
function only(source: MainDrawSource, count: number): IFakeScene {
  return {
    name: "",
    objects: Array.from({ length: count }, (_, index) =>
      mesh(`${source}:${String(index)}`, { tnDrawSource: source }),
    ),
  };
}

describe("main-pass draws by source", () => {
  it("counts every source and sums to the pass's own draws", () => {
    const window = drivePasses(4, BUNDLES_OFF);
    const main = window.passes?.main;
    const bySource = main?.drawsBySource;

    expect(main?.draws.p50).toBe(12);
    // Every source the fixture draws from, at the count it draws from it. A source no frame drew is
    // absent rather than zero, so the split also says which origins are not in this pass at all.
    expect(Object.keys(bySource ?? {}).sort()).toEqual(["gpuScene", "other", "proxies", "terrain"]);
    expect(bySource?.gpuScene?.p50).toBe(3);
    expect(bySource?.terrain?.p50).toBe(5);
    expect(bySource?.proxies?.p50).toBe(1);
    expect(bySource?.other?.p50).toBe(3);
    // The claim the split exists for: the per-frame counts add up to the pass the frame budget
    // already reported, so no draw is counted twice or left out.
    const summed = Object.values(bySource ?? {}).reduce(
      (total, series) => total + (series?.p50 ?? 0),
      0,
    );
    expect(summed).toBe(main?.draws.p50);
  });

  it("counts a hand-placed chunk's meshes under chunks, not under other", () => {
    // The measure this split was extended for: on the map-walk `other` was the largest source left,
    // and a hand-placed chunk was one draw per material inside it, indistinguishable from a prop.
    const window = drivePasses(2, only("chunks", 9));
    const bySource = window.passes?.main?.drawsBySource;

    expect(bySource?.chunks?.p50).toBe(9);
    expect(bySource?.other).toBeUndefined();
  });

  it("counts an instanced prop batch the GPU scene never dressed under instanced", () => {
    // A renderer with no compute, or a world with `gpuScene: false`: the main mesh still draws, one
    // draw per key, and that per-draw path is exactly what this has to name.
    const window = drivePasses(2, only("instanced", 34));
    const bySource = window.passes?.main?.drawsBySource;

    expect(bySource?.instanced?.p50).toBe(34);
    expect(bySource?.other).toBeUndefined();
  });

  it("counts the daylight rig's sky box under sky", () => {
    const window = drivePasses(2, only("sky", 1));
    const bySource = window.passes?.main?.drawsBySource;

    expect(bySource?.sky?.p50).toBe(1);
    expect(bySource?.other).toBeUndefined();
  });

  it("counts a bundled mesh once, under the bundle, whatever else it is tagged", () => {
    const window = drivePasses(2, BUNDLES_ON);
    const main = window.passes?.main;

    // `tree:0` is both a dressed GPU-scene key and a child of the BundleGroup; the bundle wins,
    // because a bundled mesh is not submitted per object at all.
    expect(main?.drawsBySource?.bundles?.p50).toBe(2);
    expect(main?.drawsBySource?.gpuScene?.p50).toBe(1);
    expect(main?.draws.p50).toBe(12);
  });

  it("leaves a nested pass's draws out of the main pass's split", () => {
    const window = drivePasses(2, BUNDLES_OFF);

    expect(window.passes?.shadow?.draws.p50).toBe(6);
    expect(window.passes?.shadow?.drawsBySource).toBeUndefined();
  });

  it("drops the split rather than guessing when a draw names no object", () => {
    // One draw three could not attribute: the split would be a partial answer, so the window
    // reports no split at all rather than an `other` that absorbed an unclassifiable draw.
    const window = drivePasses(1, { ...BUNDLES_OFF, unnamed: 1 });
    const main = window.passes?.main;

    expect(main?.draws.p50).toBe(13);
    expect(main?.drawsBySource).toBeUndefined();
  });

  it("counts a mesh tagged with a source this build does not know as other", () => {
    const window = drivePasses(1, {
      ...BUNDLES_OFF,
      objects: [...BUNDLES_OFF.objects, mesh("future", { tnDrawSource: "nanite" })],
    });
    const main = window.passes?.main;

    expect(main?.draws.p50).toBe(13);
    expect(main?.drawsBySource?.other?.p50).toBe(4);
  });

  it("reports no split for a renderer whose info counts no draw it can name", () => {
    // A renderer with no `update` at all: the pass record still reads, and the window says the split
    // is absent rather than reporting every draw as `other`.
    const renderer = {
      info: { render: { drawCalls: 0, triangles: 0 } },
      render(this: { info: { render: { drawCalls: number; triangles: number } } }): void {
        this.info.render.drawCalls += 1;
      },
    };
    const budget = new FrameBudget({ report: () => undefined, reportEvery: 10 });
    const passes = RenderPassBudget.install(renderer);
    budget.beginFrame(0, 0);
    budget.markSimulationEnd(1, 1);
    budget.addRender(1);
    passes?.beginFrame();
    renderer.render();
    budget.addRenderPasses(passes?.passes() ?? []);
    budget.endFrame(16);

    expect(budget.window().passes?.main?.draws.p50).toBe(1);
    expect(budget.window().passes?.main?.drawsBySource).toBeUndefined();
  });
});
