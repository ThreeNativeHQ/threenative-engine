import { PerspectiveCamera, Scene, type Vector2 } from "three";
import { installThreePlaytestBridge } from "../src/three/bridge.js";
import { describe, expect, it, vi } from "vitest";
import type { Page } from "playwright";
import { completionWindowEnvironment, completionWindowLabel, measureCompletionWindow, runStep } from "../src/runner/steps.js";
import type { IPlaytestBridgeClient } from "../src/runner/bridgeClient.js";

describe("steps fixed-step accounting", () => {
  it("advances the requested number of fixed-step ticks", async () => {
    const advances: number[] = [];
    const bridge = {
      advance: vi.fn(async (ticks: number) => {
        advances.push(ticks);
        return { clock: { mode: "fixed-step", tick: 0 }, ticks };
      }),
      description: {
        capabilities: ["runtime.fixedStep"],
        limits: {},
        name: "test-bridge",
        protocolVersion: "0.1.0",
      },
      sample: vi.fn(async () => ({ clock: { mode: "fixed-step", tick: 0 }, diagnostics: [] })),
    } as unknown as IPlaytestBridgeClient;

    const page = { evaluate: vi.fn(async () => undefined) } as unknown as Page;

    await runStep(
      page,
      bridge,
      { kind: "wait", release: false, waitTicks: 25 },
      { height: 100, width: 100 },
      undefined,
      [],
      { heldKeys: new Set(), pointerButtons: 0, pointers: new Map() },
      undefined,
      false,
    );

    expect(advances.reduce((total, ticks) => total + ticks, 0)).toBe(25);
  });
});

it("uses an opted-in completion window without injecting simulation ticks", async () => {
  const advance = vi.fn(async () => ({}));
  const window = vi.fn(async () => undefined);
  const bridge = { advance, description: { capabilities: ["runtime.fixedStep"] } } as unknown as IPlaytestBridgeClient;
  await runStep({ evaluate: vi.fn(async () => undefined) } as unknown as Page, bridge, { kind: "wait", waitTicks: 1000, release: false },
    { height: 100, width: 100 }, undefined, [],
    { heldKeys: new Set(), pointerButtons: 0, pointers: new Map() }, undefined, false,
    undefined, false, undefined, window);
  expect(window).toHaveBeenCalledOnce();
  expect(advance).not.toHaveBeenCalled();
});

const completionRows = () => Array.from({ length: 351 }, (_, index) => ({ sequence: index + 1, completedAtMs: index * 20 }));
const completionSnapshot = () => ({ clock: { mode: "wall-clock" }, epoch: 1, valid: true, dropped: 0,
  source: "present-return", timebase: "steady-clock-ms", samples: completionRows() });

describe("application completion windows", () => {
  it("requires explicit opt-in and one final deterministic desktop/browser WAIT", () => {
    const scenario = { steps: [{ kind: "wait" as const, label: "pose", waitTicks: 1000, release: false }] };
    expect(completionWindowLabel(scenario, "desktop", false, "pose")).toBe("pose");
    expect(completionWindowLabel(scenario, "desktop", false, undefined)).toBeUndefined();
    for (const target of ["android", "ios"]) expect(() => completionWindowLabel(scenario, target, false, "pose")).toThrow();
    expect(() => completionWindowLabel(scenario, "browser", true, "pose")).toThrow();
    expect(() => completionWindowLabel({ steps: [...scenario.steps, { kind: "wait", label: "later", release: false }] }, "desktop", false, "pose")).toThrow();
  });
  it("retains only complete post-warm intervals over authoritative five-second endpoints", async () => {
    const mode = vi.fn(async (mode: string) => ({ mode, tick: 42, epoch: 1 }));
    const release = vi.fn(async () => undefined);
    const report = await measureCompletionWindow("pose", mode, async () => completionSnapshot(), release);
    expect(report).toMatchObject({ startTick: 42, startMs: 2000, endMs: 7000, durationMs: 5000,
      intervalCount: 250, completionIntervalP50Ms: 20, metric: "application-completion-interval" });
    expect(report.samples).toHaveLength(251);
    expect(mode.mock.calls.map(([mode]) => mode)).toEqual(["wall-clock", "fixed-step"]);
    expect(release).toHaveBeenCalledOnce();
  });
  it.each(["missing", "mode", "truncated", "invalid", "timestamp", "gap", "insufficient-count"])("fails closed on %s and restores controls", async (fault) => {
    const value = completionSnapshot();
    if (fault === "mode") value.clock.mode = "fixed-step";
    if (fault === "truncated") value.dropped = 1;
    if (fault === "invalid") value.valid = false;
    if (fault === "timestamp") value.samples[1]!.completedAtMs = Number.NaN;
    if (fault === "gap") value.samples[1]!.sequence = 10;
    if (fault === "insufficient-count") value.samples = Array.from({ length: 9 }, (_, i) => ({ sequence: i + 1, completedAtMs: i * 1000 }));
    const mode = vi.fn(async (mode: string) => ({ mode, tick: 42, epoch: 1 }));
    const release = vi.fn(async () => undefined);
    await expect(measureCompletionWindow("pose", mode, async () => fault === "missing" ? {} : value, release)).rejects.toThrow("TN_PLAYTEST_COMPLETION_WINDOW_FAILED");
    expect(mode).toHaveBeenLastCalledWith("fixed-step");
    expect(release).toHaveBeenCalledOnce();
  });
  it.each([undefined, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])("rejects invalid negotiated epoch %s", async (epoch) => {
    const poll = vi.fn(async () => completionSnapshot());
    const release = vi.fn(async () => undefined);
    await expect(measureCompletionWindow("pose", async mode => ({ mode, tick: 42, epoch }), poll, release)).rejects.toThrow("clock negotiation unavailable");
    expect(poll).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });
  it("rejects a reset after negotiation before the first poll", async () => {
    const release = vi.fn(async () => undefined);
    const mode = vi.fn(async (mode: string) => ({ mode, tick: 42, epoch: 1 }));
    await expect(measureCompletionWindow("pose", mode, async () => ({ ...completionSnapshot(), epoch: 2 }), release)).rejects.toThrow("epoch/source changed");
    expect(mode).toHaveBeenLastCalledWith("fixed-step");
    expect(release).toHaveBeenCalledOnce();
  });
  it("rejects an epoch change between polls", async () => {
    let poll = 0;
    await expect(measureCompletionWindow("pose", async mode => ({ mode, tick: 0, epoch: 1 }), async () => ({
      ...completionSnapshot(), epoch: ++poll, samples: [{ sequence: poll, completedAtMs: poll * 20 }],
    }), async () => undefined)).rejects.toThrow("epoch/source changed");
  });
  it("bounds missing duration coverage and releases inputs even if mode restoration fails", async () => {
    vi.useFakeTimers();
    try {
      const release = vi.fn(async () => undefined);
      const mode = vi.fn(async (mode: string) => {
        if (mode === "fixed-step") throw new Error("restore failed");
        return { mode, tick: 0, epoch: 1 };
      });
      const result = expect(measureCompletionWindow("pose", mode, async () => ({ ...completionSnapshot(), samples: [] }), release)).rejects.toThrow("cleanup failed");
      await vi.advanceTimersByTimeAsync(10100);
      await result;
      expect(release).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
});

it("bounds a stalled producer poll and preserves its failure through cleanup", async () => {
  vi.useFakeTimers();
  try {
    const release = vi.fn(async () => undefined);
    const result = expect(measureCompletionWindow("pose", async mode => ({ mode, tick: 0, epoch: 1 }),
      () => new Promise(() => undefined), release)).rejects.toThrow("operation timeout");
    await vi.advanceTimersByTimeAsync(10050);
    await result;
    expect(release).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});

it("requires explicit display/uncapped admission settings without claiming qualification", () => {
  vi.stubEnv("TN_PLAYER_VSYNC", "0"); vi.stubEnv("TN_PLAYTEST_HOST_DISPLAY", "1"); vi.stubEnv("DISPLAY", ":synthetic");
  try {
    expect(completionWindowEnvironment("desktop", false)).toBe(":synthetic");
    expect(() => completionWindowEnvironment("browser", true)).toThrow("headed browser");
    vi.stubEnv("TN_PLAYER_VSYNC", "1");
    expect(() => completionWindowEnvironment("desktop", false)).toThrow("VSYNC=0");
    if (process.platform === "linux") {
      vi.stubEnv("TN_PLAYTEST_HOST_DISPLAY", "0");
      expect(() => completionWindowEnvironment("browser", false)).toThrow("session display");
      vi.stubEnv("TN_PLAYTEST_HOST_DISPLAY", "1"); vi.stubEnv("DISPLAY", "");
      expect(() => completionWindowEnvironment("browser", false)).toThrow("session display");
    }
  } finally { vi.unstubAllEnvs(); }
});

it("accepts ring eviction when every completion has already been ingested", async () => {
  let count = 0;
  const report = await measureCompletionWindow("fast-pose", async mode => ({ mode, tick: 0, epoch: 1 }), async () => {
    count += 1000;
    return { ...completionSnapshot(), dropped: Math.max(0, count - 2048),
      samples: Array.from({ length: Math.min(count, 2048) }, (_, index) => {
        const sequence = Math.max(1, count - 2047) + index;
        return { sequence, completedAtMs: (sequence - 1) * 2 };
      }) };
  }, async () => undefined);
  expect(report.intervalCount).toBe(2500);
  expect(report.completionIntervalP50Ms).toBe(2);
  expect(report.dropped).toEqual({ min: 0, max: 1952 });
});

it("rejects a missed-poll gap despite valid ring eviction metadata", async () => {
  let poll = 0;
  await expect(measureCompletionWindow("gap", async mode => ({ mode, tick: 0, epoch: 1 }), async () => ({
    ...completionSnapshot(), dropped: poll++ === 0 ? 0 : 10,
    samples: [{ sequence: poll === 1 ? 1 : 12, completedAtMs: poll * 20 }],
  }), async () => undefined)).rejects.toThrow("completion gap");
});

it("consumes the installed Three bridge series shape and retains full camera observations", async () => {
  const camera = new PerspectiveCamera(); camera.position.set(1, 2, 3);
  const options = { camera, scene: new Scene(), clockMode: "fixed-step" as "fixed-step" | "wall-clock", tick: () => 42,
    fixedStep: () => undefined, renderer: { getDrawingBufferSize: (target: Vector2) => target.set(640, 360) },
    runtimeDiagnosticsSeries: () => completionRows().map(sample => ({ ...sample, frameMs: 999 })),
    resources: { read: () => ({ state: { mode: "flight", airborne: true } }) } };
  const installation = installThreePlaytestBridge(options);
  try {
    const setupSnapshot = await installation.bridge.sample({ entities: [], include: ["scene", "resources"], resources: ["state"] });
    expect(setupSnapshot.scene?.camera?.position).toEqual([1, 2, 3]);
    const report = await measureCompletionWindow("bridge", async mode => { options.clockMode = mode; return { mode, tick: 42, epoch: 1 }; }, async () => {
      const snapshot = await installation.bridge.sample({ entities: [], include: ["runtimeDiagnosticsSeries"] });
      return { ...completionSnapshot(), clock: snapshot.clock, source: "render-callback-return", timebase: "performance-now-ms", samples: snapshot.runtimeDiagnosticsSeries };
    }, async () => undefined);
    expect(report.completionIntervalP50Ms).toBe(20);
    expect(report.samples[0]).not.toHaveProperty("frameMs");
  } finally { installation.dispose(); }
});
