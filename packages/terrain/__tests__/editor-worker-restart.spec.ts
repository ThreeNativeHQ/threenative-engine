import { afterEach, describe, expect, it, vi } from "vitest";
import { build, cancelBuild, dispatch, newWorker } from "../src/editor/app/evaluation.js";
import type { EditorSession, IEvaluationRequest } from "../src/editor/app/session.js";
import type { EditorWorkerReply } from "../src/editor/worker.js";
import { Terrain, bakeMesh } from "../src/index.js";

class FakeWorker {
  static instances: FakeWorker[] = [];
  jobs: IEvaluationRequest[] = [];
  terminated = false;
  onmessage?: (event: MessageEvent<EditorWorkerReply>) => Promise<void>;
  onerror?: (event: ErrorEvent) => void;
  constructor() {
    FakeWorker.instances.push(this);
  }
  postMessage(job: IEvaluationRequest) {
    if (this.terminated) throw new Error("Worker already terminated");
    this.jobs.push(job);
  }
  terminate() {
    this.terminated = true;
  }
  async reply() {
    const job = this.jobs.at(-1);
    if (!job) throw Error("No evaluation requested");
    const state = Terrain.fromJSON(job.recipe).evaluate({ resolution: job.resolution });
    await this.onmessage?.({
      data: { id: job.id, type: "evaluated", state, normal: bakeMesh(state).normals, ms: 1 },
    } as MessageEvent<EditorWorkerReply>);
    return state;
  }
}
function session() {
  const controls = new Map<string, { textContent: string; value: string }>();
  vi.stubGlobal("document", {
    getElementById: (id: string) => {
      if (!controls.has(id)) controls.set(id, { textContent: "", value: "17" });
      return controls.get(id);
    },
    querySelectorAll: () => [],
  });
  vi.stubGlobal("Worker", FakeWorker);
  FakeWorker.instances = [];
  const c = {
    disposed: false,
    terrain: new Terrain({ size: 32, resolution: 17, seed: 73 }),
    sequence: 0,
    workerBusy: false,
    evaluationRequests: 0,
    worker: null,
    pending: null,
    revision: "saved",
    view: { update: vi.fn((state) => state) },
    saveQueue: { hasLocalIntent: () => false },
    setBusy: vi.fn(),
    toast: vi.fn(),
    onEvaluated: vi.fn(),
    attempt: (fn: () => unknown) => fn(),
    workerURL: () => new URL("http://localhost/worker.js"),
  } as unknown as EditorSession;
  c.newWorker = () => newWorker(c);
  c.dispatch = () => dispatch(c);
  return c;
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("editor worker restart", () => {
  it("terminates a crashed worker and rebuilds the next edit on a new worker", async () => {
    vi.useFakeTimers();
    const c = session();
    build(c);
    await vi.advanceTimersByTimeAsync(35);
    const first = FakeWorker.instances[0];
    expect(c.workerBusy).toBe(true);
    first?.onerror?.({
      message: "worker crashed",
      preventDefault: vi.fn(),
    } as unknown as ErrorEvent);
    expect(first?.terminated).toBe(true);
    expect(c.worker).toBeNull();
    c.terrain.sculpt({ points: [[0, 0]], radius: 4, strength: 1 });
    build(c);
    await vi.advanceTimersByTimeAsync(35);
    const second = FakeWorker.instances[1];
    expect(second).toBeDefined();
    const evaluated = await second?.reply();
    expect(c.state).toBe(evaluated);
    expect(c.workerBusy).toBe(false);
    expect(c.onEvaluated).toHaveBeenCalledOnce();
    expect(c.toast).toHaveBeenCalledWith(expect.stringContaining("worker crashed"));
  });

  it("cancels mid-build and ignores the terminated worker's late reply after the next edit", async () => {
    vi.useFakeTimers();
    const c = session();
    build(c);
    await vi.advanceTimersByTimeAsync(35);
    const first = FakeWorker.instances[0];
    cancelBuild(c);
    expect(first?.terminated).toBe(true);
    c.terrain.sculpt({ points: [[0, 0]], radius: 4, strength: 1 });
    build(c);
    await vi.advanceTimersByTimeAsync(35);
    const second = FakeWorker.instances[1];
    await first?.reply();
    expect(c.workerBusy).toBe(true);
    expect(c.onEvaluated).not.toHaveBeenCalled();
    const evaluated = await second?.reply();
    expect(c.state).toBe(evaluated);
    expect(c.onEvaluated).toHaveBeenCalledOnce();
  });
  it("restarts immediately with the latest request queued during a crash", async () => {
    vi.useFakeTimers();
    const c = session();
    build(c);
    await vi.advanceTimersByTimeAsync(35);
    c.terrain.sculpt({ id: "newest", points: [[0, 0]], radius: 4, strength: 1 });
    build(c);
    FakeWorker.instances[0]?.onerror?.({
      message: "crash",
      preventDefault: vi.fn(),
    } as unknown as ErrorEvent);
    const next = FakeWorker.instances[1];
    expect(next?.jobs[0]?.recipe.layers.map((layer) => layer.id)).toEqual(["newest"]);
    expect(c.workerBusy).toBe(true);
    await next?.reply();
    expect(c.workerBusy).toBe(false);
    expect(c.onEvaluated).toHaveBeenCalledOnce();
  });

  it("drops a worker that cannot accept a message and lets the next edit rebuild", async () => {
    vi.useFakeTimers();
    const c = session();
    build(c);
    await vi.advanceTimersByTimeAsync(35);
    const first = FakeWorker.instances[0];
    await first?.reply();
    first?.terminate();
    build(c);
    await vi.advanceTimersByTimeAsync(35);
    expect(c.worker).toBeNull();
    c.terrain.sculpt({ points: [[0, 0]], radius: 4, strength: 1 });
    build(c);
    await vi.advanceTimersByTimeAsync(35);
    const evaluated = await FakeWorker.instances[1]?.reply();
    expect(c.state).toBe(evaluated);
    expect(c.workerBusy).toBe(false);
  });
});
