import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSpawnGate } from "../src/starter.js";

type GateHost = Parameters<typeof createSpawnGate>[0];

const WITNESS = {
  phase: "props",
  stage: "bucket",
  bucket: "canopy",
  added: 3,
  total: 12,
  buildStartedAt: 0,
  phaseStartedAt: 0,
  lastProgressAt: 0,
};

function host(phase = "loading") {
  const set = vi.fn();
  const hold = vi.fn();
  const ctx = { state: { set }, startup: { phase, hold } } as unknown as GateHost;
  return { ctx, set, hold };
}

function options(overrides: Partial<Parameters<typeof createSpawnGate>[1]> = {}) {
  return {
    world: "forest",
    progress: () => 0.5,
    witness: () => WITNESS,
    released: () => false,
    ...overrides,
  };
}

describe("the spawn gate", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("holds the loading screen on the gate's own promise while the scene is loading", () => {
    const { ctx, hold } = host();
    const gate = createSpawnGate(ctx, options());
    gate.hold();
    expect(hold).toHaveBeenCalledWith("strata-spawn", gate.promise, 120_000, expect.any(Function));
    expect(gate.ready).toBe(false);
  });

  it("does not hold a screen that already reached ready", () => {
    const { ctx, hold } = host("ready");
    createSpawnGate(ctx, options()).hold();
    expect(hold).not.toHaveBeenCalled();
  });

  it("publishes the landed region, releases the screen and reports the world ready", async () => {
    const { ctx, set } = host();
    const gate = createSpawnGate(ctx, options());
    gate.land({ requiredCells: 9, loadedCells: 9 });
    await expect(gate.promise).resolves.toBeUndefined();
    expect(gate.ready).toBe(true);
    expect(gate.cells).toEqual({ required: 9, loaded: 9 });
    // A landing writes no state: the scene publishes `worldReady` from `gate.ready` itself, and only
    // a failure has a line of its own to leave.
    expect(set).not.toHaveBeenCalled();
  });

  it("fails by name, once, with the witness of where preparation stood", async () => {
    const { ctx, set } = host();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const gate = createSpawnGate(ctx, options());
    const reason = new Error("props stalled");
    gate.fail(reason);
    gate.fail(new Error("second failure"));
    await expect(gate.promise).rejects.toThrow("props stalled");
    expect(logged).toHaveBeenCalledOnce();
    const line = logged.mock.calls[0]?.[0] as string;
    expect(line).toMatch(/^TN_STRATA_SPAWN_FAILURE /u);
    expect(JSON.parse(line.slice("TN_STRATA_SPAWN_FAILURE ".length))).toMatchObject({
      reason: "props stalled",
      world: "forest",
      stage: "props",
      bucket: "canopy",
      added: 3,
      total: 12,
    });
    expect(set).toHaveBeenLastCalledWith({ worldReady: false, loadingError: "props stalled" });
    expect(gate.error).toBe("props stalled");
  });

  it("fails with the admission line when the deadline passes first", async () => {
    const { ctx } = host();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const gate = createSpawnGate(ctx, options());
    const failure = expect(gate.promise).rejects.toThrow(/spawn admission exceeded 120000 ms/u);
    vi.advanceTimersByTime(120_000);
    await failure;
    expect(logged).toHaveBeenCalledOnce();
    // The deadline is taken at entry and never extended: a late join cannot revive the spawn.
    vi.advanceTimersByTime(120_000);
    expect(logged).toHaveBeenCalledOnce();
  });

  it("refuses a join that lands after the scene released its world", async () => {
    let released = false;
    const { ctx, set } = host();
    const gate = createSpawnGate(ctx, options({ released: () => released }));
    released = true;
    gate.land({ requiredCells: 9, loadedCells: 1 });
    expect(gate.ready).toBe(false);
    expect(gate.cells).toEqual({ required: 0, loaded: 0 });
    expect(set).not.toHaveBeenCalledWith(expect.objectContaining({ worldReady: true }));
  });

  it("fails a join taken past the deadline without waiting on it", async () => {
    const { ctx } = host();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const gate = createSpawnGate(ctx, options());
    const failure = expect(gate.promise).rejects.toThrow(/spawn admission exceeded/u);
    vi.advanceTimersByTime(120_001);
    const join = vi.fn(async () => ({ requiredCells: 9, loadedCells: 9 }));
    gate.watch(join);
    expect(join).not.toHaveBeenCalled();
    await failure;
  });

  it("lands a join under the deadline once it resolves", async () => {
    const { ctx } = host();
    const gate = createSpawnGate(ctx, options());
    gate.watch(async () => ({ requiredCells: 9, loadedCells: 7 }));
    await expect(gate.promise).resolves.toBeUndefined();
    expect(gate.cells).toEqual({ required: 9, loaded: 7 });
  });
});
