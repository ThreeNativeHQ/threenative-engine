import { describe, expect, it } from "vitest";
import { FrameBudget } from "../src/frame-budget.js";
import {
  FRAME_PASS_KINDS,
  type IRenderPassSample,
  RenderPassBudget,
  shadowRedrawGpuMs,
} from "../src/render-pass-budget.js";

/**
 * A renderer whose `render` adds its own submission to `info.render` and then, like three's own
 * nested passes, calls itself for each nested scene. `info.render` is never reset here: the whole
 * point is that a nested render shares the aggregate, so attribution has to subtract the children.
 */
interface IFakeScene {
  readonly name: string;
  readonly nested?: readonly IFakeScene[];
  readonly submissions: { readonly draws: number; readonly triangles: number };
}

interface IFakeRenderer {
  info: { render: { calls: number; drawCalls: number; triangles: number } };
  render(scene: IFakeScene, camera: object): void;
}

function fakeRenderer(): IFakeRenderer {
  const raw: IFakeRenderer = {
    info: { render: { calls: 0, drawCalls: 0, triangles: 0 } },
    render(this: IFakeRenderer, scene: IFakeScene, _camera: object): void {
      this.info.render.drawCalls += scene.submissions.draws;
      this.info.render.triangles += scene.submissions.triangles;
      for (const child of scene.nested ?? []) this.render(child, {});
    },
  };
  return raw;
}

/**
 * A renderer with three's timestamp pool: one uid allocated per render call, resolved later. The
 * test decides which uids resolve, so a pass that was recorded but never read back is reproducible.
 * Each top-level render call advances the frame, so the same renderer serves a two-frame sequence;
 * the nested calls a frame makes all carry that frame's number.
 */
function timestampRenderer(startFrame: number): {
  readonly pool: {
    readonly queryOffsets: Map<string, number>;
    readonly timestamps: Map<string, number>;
  };
  readonly raw: Parameters<typeof RenderPassBudget.install>[0];
} {
  const pool = {
    queryOffsets: new Map<string, number>(),
    timestamps: new Map<string, number>(),
  };
  let allocation = 0;
  let frame = startFrame;
  let depth = 0;
  const raw = {
    backend: { timestampQueryPool: { render: pool } },
    info: { render: { calls: 0, drawCalls: 0, triangles: 0 } },
    render(scene: IFakeScene, _camera: object): void {
      const outermost = depth === 0;
      depth += 1;
      try {
        for (const child of scene.nested ?? []) raw.render(child, {});
        allocation += 1;
        pool.queryOffsets.set(`r:0:${allocation}:f${frame}`, pool.queryOffsets.size * 2);
        raw.info.render.drawCalls += scene.submissions.draws;
        raw.info.render.triangles += scene.submissions.triangles;
      } finally {
        depth -= 1;
        if (outermost) frame += 1;
      }
    },
  };
  return { pool, raw: raw as unknown as Parameters<typeof RenderPassBudget.install>[0] };
}

const MAIN: IFakeScene = { name: "", submissions: { draws: 0, triangles: 0 } };
const SHADOW: IFakeScene = {
  name: "Shadow Map [ Sun ]",
  submissions: { draws: 4, triangles: 40 },
};
const REFLECTION: IFakeScene = {
  name: "Scene [ Reflector ]",
  submissions: { draws: 6, triangles: 60 },
};

function passesOf(budget: RenderPassBudget): readonly IRenderPassSample[] {
  return budget.passes();
}

describe("render pass budget", () => {
  it("should attribute each nested render to its innermost active call", () => {
    const raw = fakeRenderer();
    const budget = RenderPassBudget.install(raw);
    expect(budget).toBeDefined();

    budget?.beginFrame();
    raw.render(
      { ...MAIN, submissions: { draws: 10, triangles: 100 }, nested: [SHADOW, REFLECTION] },
      {},
    );
    const passes = passesOf(budget as RenderPassBudget);
    const byKind = Object.fromEntries(passes.map((pass) => [pass.kind, pass]));

    // The aggregate at world-render end is main+shadow+reflection combined.
    expect(raw.info.render.drawCalls).toBe(20);
    expect(raw.info.render.triangles).toBe(200);
    expect(byKind.main).toMatchObject({ draws: 10, triangles: 100 });
    expect(byKind.shadow).toMatchObject({ draws: 4, triangles: 40 });
    expect(byKind.reflection).toMatchObject({ draws: 6, triangles: 60 });
    expect(passes.reduce((sum, pass) => sum + pass.draws, 0)).toBe(20);
  });

  it("should read the WebGL2 fallback's calls counter", () => {
    // WebGL2 reports `calls` rather than WebGPU's `drawCalls`.
    const fallback = {
      info: { render: { calls: 0, triangles: 0 } },
      render(
        this: { info: { render: { calls: number; triangles: number } } },
        scene: IFakeScene,
      ): void {
        this.info.render.calls += scene.submissions.draws;
        this.info.render.triangles += scene.submissions.triangles;
      },
    };
    const budget = RenderPassBudget.install(fallback);
    expect(budget).toBeDefined();
    budget?.beginFrame();
    fallback.render({ ...MAIN, submissions: { draws: 3, triangles: 30 } });
    expect(passesOf(budget as RenderPassBudget)).toMatchObject([
      { draws: 3, kind: "main", triangles: 30 },
    ]);
  });

  it("should clear the frame's passes on beginFrame and name the known kinds", () => {
    expect(FRAME_PASS_KINDS).toEqual(["main", "shadow", "reflection", "nested"]);
    const raw = fakeRenderer();
    const budget = RenderPassBudget.install(raw) as RenderPassBudget;
    budget.beginFrame();
    raw.render({ ...MAIN, submissions: { draws: 1, triangles: 1 } }, {});
    expect(passesOf(budget)).toHaveLength(1);
    budget.beginFrame();
    expect(passesOf(budget)).toHaveLength(0);
  });

  it("should refuse to install on a renderer that cannot count its own submissions", () => {
    const raw = { render: (): void => undefined } as unknown as Parameters<
      typeof RenderPassBudget.install
    >[0];
    expect(RenderPassBudget.install(raw)).toBeUndefined();
  });

  it("attributes resolved per-pass GPU time to main and shadow, not the parent", () => {
    // Three allocates one timestamp uid per render pass at `beginRenderPass`, and renders shadow
    // passes before the colour pass, so the nested render's uid lands first. The pool is three's
    // own shape: `queryOffsets` is allocation order, `timestamps` fills in on the async resolve.
    const pool = {
      queryOffsets: new Map<string, number>(),
      timestamps: new Map<string, number>(),
    };
    const frame = 7;
    let allocation = 0;
    const calls = { value: 0 };
    interface IFakeGpuRenderer {
      backend: {
        timestampQueryPool: {
          render: { queryOffsets: Map<string, number>; timestamps: Map<string, number> };
        };
      };
      info: { render: { calls: number; drawCalls: number; triangles: number } };
      render(scene: IFakeScene, camera: object): void;
    }
    const raw: IFakeGpuRenderer = {
      backend: { timestampQueryPool: { render: pool } },
      info: { render: { calls: 0, drawCalls: 0, triangles: 0 } },
      render: (scene: IFakeScene, _camera: object): void => {
        for (const child of scene.nested ?? []) raw.render(child, {});
        allocation += 1;
        pool.queryOffsets.set(
          `r:${calls.value}:${allocation}:f${frame}`,
          pool.queryOffsets.size * 2,
        );
        raw.info.render.drawCalls += scene.submissions.draws;
        raw.info.render.triangles += scene.submissions.triangles;
      },
    };
    const budget = RenderPassBudget.install(raw) as RenderPassBudget;
    budget.beginFrame();
    raw.render({ ...MAIN, submissions: { draws: 10, triangles: 100 }, nested: [SHADOW] }, {});
    // Nothing resolves until three's pool has been read back.
    expect(budget.nextGpuFrame()).toBeUndefined();
    const uids = [...pool.queryOffsets.keys()];
    expect(uids).toHaveLength(2);
    const [shadowUid, mainUid] = uids;
    if (shadowUid === undefined || mainUid === undefined)
      throw new Error("fake backend allocated fewer than two timestamp uids");
    pool.timestamps.set(shadowUid, 2.25); // nested shadow, allocated first
    pool.timestamps.set(mainUid, 5.5); // main
    // Main must not absorb the shadow's pass: the split is 5.5 and 2.25, not 7.75 and 0, and the
    // frame's own cost is both of them rather than the one number three's resolve returns.
    expect(budget.nextGpuFrame()).toEqual({
      frame,
      main: 5.5,
      shadow: 2.25,
      shadowPasses: 1,
      total: 7.75,
    });
    // One reading per frame: the same frame is not handed out twice.
    expect(budget.nextGpuFrame()).toBeUndefined();
  });

  it("leaves the frame absent until its recorded shadow pass resolves, never a partial total", () => {
    // The defect: a shadow pass is recorded but its uid never lands in `timestamps`, and the reading
    // forwarded `total: 5.5` — only the main pass — as the frame's cost. A partial sum is not a whole
    // frame; the frame stays absent, and the next call retries it rather than consuming it.
    const { pool, raw } = timestampRenderer(7);
    const budget = RenderPassBudget.install(raw) as RenderPassBudget;
    budget.beginFrame();
    raw.render({ ...MAIN, submissions: { draws: 10, triangles: 100 }, nested: [SHADOW] }, {});
    const uids = [...pool.queryOffsets.keys()];
    const [shadowUid, mainUid] = uids;
    if (shadowUid === undefined || mainUid === undefined)
      throw new Error("fake backend allocated fewer than two timestamp uids");
    pool.timestamps.set(mainUid, 5.5); // only the main pass resolved; shadow is still in flight
    expect(budget.nextGpuFrame()).toBeUndefined();
    // The frame was not consumed: once the shadow lands, the whole frame is handed out.
    expect(shadowRedrawGpuMs(raw)).toBeUndefined();
    pool.timestamps.set(shadowUid, 2.25);
    expect(budget.nextGpuFrame()).toEqual({
      frame: 7,
      main: 5.5,
      shadow: 2.25,
      shadowPasses: 1,
      total: 7.75,
    });
    // The whole frame is also the shadow node's price for a redraw on this renderer.
    expect(shadowRedrawGpuMs(raw)).toBe(2.25);
  });

  it("skips a permanently missing older frame and delivers a newer whole frame at once", () => {
    // The ordering contract is skip-unresolved: an older frame whose shadow never resolves must not
    // block the whole frames behind it. Frame 7 records a shadow that never lands; frame 8 is whole,
    // so frame 8 is delivered at once. Once the cursor has moved past frame 7, the older frame is
    // intentionally omitted — a missing reading, never a zeroed partial.
    const { pool, raw } = timestampRenderer(7);
    const budget = RenderPassBudget.install(raw) as RenderPassBudget;
    budget.beginFrame();
    raw.render({ ...MAIN, submissions: { draws: 10, triangles: 100 }, nested: [SHADOW] }, {});
    const missingUids = [...pool.queryOffsets.keys()];
    budget.beginFrame();
    raw.render({ ...MAIN, submissions: { draws: 10, triangles: 100 } }, {});
    const wholeUids = [...pool.queryOffsets.keys()].slice(missingUids.length);
    const [wholeMainUid] = wholeUids;
    if (wholeMainUid === undefined) throw new Error("fake backend allocated no second-frame uid");
    pool.timestamps.set(wholeMainUid, 5.5);
    // Frame 7's shadow never resolved, but frame 8 is complete and must not wait for it.
    expect(budget.nextGpuFrame()).toEqual({
      frame: 8,
      main: 5.5,
      shadow: 0,
      shadowPasses: 0,
      total: 5.5,
    });
    // Frame 7 resolving later cannot be delivered: the newer frame already moved the cursor past it.
    for (const uid of missingUids) pool.timestamps.set(uid, 1);
    expect(budget.nextGpuFrame()).toBeUndefined();
  });

  it("keeps a frame out until every nested pass resolves, then reports the whole total", () => {
    // `total` is the whole frame, so a still-resolving reflection — neither main nor shadow, but
    // part of the frame — must hold the frame back exactly as a stalled shadow does. Once it lands,
    // `total` is all three passes, and the FrameBudget subtracts main and shadow to leave it as
    // `other`.
    const { pool, raw } = timestampRenderer(9);
    const budget = RenderPassBudget.install(raw) as RenderPassBudget;
    budget.beginFrame();
    raw.render(
      { ...MAIN, submissions: { draws: 10, triangles: 100 }, nested: [SHADOW, REFLECTION] },
      {},
    );
    const uids = [...pool.queryOffsets.keys()];
    const [shadowUid, reflectionUid, mainUid] = uids;
    if (shadowUid === undefined || reflectionUid === undefined || mainUid === undefined)
      throw new Error("fake backend allocated fewer than three timestamp uids");
    pool.timestamps.set(mainUid, 5.5);
    pool.timestamps.set(shadowUid, 2.25);
    expect(budget.nextGpuFrame()).toBeUndefined(); // the reflection is still in flight
    pool.timestamps.set(reflectionUid, 1.25);
    expect(budget.nextGpuFrame()).toEqual({
      frame: 9,
      main: 5.5,
      shadow: 2.25,
      shadowPasses: 1,
      total: 9,
    });
    // `other` is the reflection: the whole total minus the two known kinds.
    expect(9 - 5.5 - 2.25).toBeCloseTo(1.25, 5);
  });

  it("reports a zero shadow bucket when the frame drew no shadow pass", () => {
    // A frame that drew no shadow genuinely spent 0 ms on shadow: a known zero, not an absence. Its
    // `shadowPasses` record is 0, so a consumer can tell it from a render that resolved to 0 ms.
    const { pool, raw } = timestampRenderer(8);
    const budget = RenderPassBudget.install(raw) as RenderPassBudget;
    budget.beginFrame();
    raw.render({ ...MAIN, submissions: { draws: 10, triangles: 100 } }, {});
    const [mainUid] = [...pool.queryOffsets.keys()];
    if (mainUid === undefined) throw new Error("fake backend allocated no timestamp uid");
    pool.timestamps.set(mainUid, 5.5);
    expect(budget.nextGpuFrame()).toEqual({
      frame: 8,
      main: 5.5,
      shadow: 0,
      shadowPasses: 0,
      total: 5.5,
    });
  });

  it("reports the GPU-selected main-pass triangles beside the CPU capacity figure", () => {
    // Three adds `instanceCount * (count / 3)` per draw, and for an indirect batch `count` is the
    // merged geometry's capacity, not what the GPU selected -- so a streamed world reads as hundreds
    // of millions of triangles for a few hundred thousand drawn. The window already carries the
    // honest number as `mainGpuTriangles`; a reader who only has the pass record cannot see which
    // of the two they are holding, so the GPU figure belongs beside the CPU one in the pass too.
    const raw = fakeRenderer();
    const passBudget = RenderPassBudget.install(raw) as RenderPassBudget;
    const budget = new FrameBudget({
      readGpuTally: () => ({ instances: 12_000, triangles: 402_000 }),
      report: () => undefined,
      reportEvery: 1000,
    });
    let now = 0;
    for (let frame = 0; frame < 4; frame += 1) {
      now += 16.7;
      budget.beginFrame(now, now);
      passBudget.beginFrame();
      raw.render({ ...MAIN, submissions: { draws: 30, triangles: 338_000_000 } }, {});
      budget.addRenderPasses(passBudget.passes());
      budget.markSimulationEnd(now, 1);
      budget.endFrame(now + 1);
    }

    const main = budget.window().passes?.main;
    expect(main?.triangles.p50).toBe(338_000_000);
    expect(main?.gpuTriangles).toBe(402_000);
  });
});
