import { PerspectiveCamera, Scene, type Vector2, type WebGLRenderer } from "three";
import { expect, test, vi } from "vitest";
import type { Page } from "playwright";
import { waitFrames, waitWarmupFrames } from "../src/runner/steps.js";

import { installThreePlaytestBridge } from "../src/three/bridge.js";
import { validatePlaytestScenario } from "../src/scenario/schema-validate.js";
import { PlaytestBridgeError } from "../src/runner/bridgeClient.js";
import { playtestDiagnostic } from "../src/diagnostics.js";
import { waitForStartupReady, type IStartupReadySource } from "../src/runner/startupReady.js";
import type { IPlaytestBridgeReady, IPlaytestStartupObservation } from "../src/protocol.js";

// The defect these cover: a fixed-step runner advances ticks as fast as the machine allows, so
// a scenario finished during a launch that had not. `starter-look` then read flagSteps 0 before
// and 0 after — the cloth had never been dispatched, because the game holds compute behind its
// loading layer — and failed TN_PLAYTEST_RESOURCE_ASSERTION_FAILED on a workstation and in CI.

const renderer = {
  getDrawingBufferSize(target: Vector2) {
    return target.set(1280, 720);
  },
} as WebGLRenderer;

function source(
  capabilities: readonly string[],
  readings: readonly (IPlaytestStartupObservation | undefined)[],
): IStartupReadySource & { calls: number } {
  let index = 0;
  return {
    calls: 0,
    description: { capabilities },
    readiness(): Promise<IPlaytestBridgeReady> {
      const startup = readings[Math.min(index, readings.length - 1)];
      index += 1;
      this.calls = index;
      return Promise.resolve(startup === undefined ? { ready: true } : { ready: true, startup });
    },
  };
}

const collapsing = { phase: "collapsing", progress: 0 } as const;
const ready = { phase: "ready", progress: 1 } as const;

test("holds until the application reports its world is safe to observe", async () => {
  const bridge = source(["runtime.startup"], [collapsing, collapsing, collapsing, ready]);
  let pumped = 0;
  const observed = await waitForStartupReady({
    bridge,
    pump: async () => {
      pumped += 1;
    },
  });
  expect(observed).toEqual({ rule: "sustained-frames", startup: ready });
  // Three not-ready readings, so three frames were pumped rather than the baseline being taken
  // against a game that had not finished loading.
  expect(pumped).toBe(3);
});

test("holds past readiness until the UI cover has lifted, where the game reports it", async () => {
  // Hosted CI's puzzle and starter pause runs pressed Tab at tick 600 while the loading cover still
  // hid the HUD (the hand-off waits for frames to leave a software GPU), so the pause button did
  // not exist and the player walked on. A player cannot press a button the cover still hides.
  const covered = { ...ready, revealed: false };
  const revealed = { ...ready, revealed: true };
  const bridge = source(["runtime.startup"], [collapsing, covered, covered, revealed]);
  let pumped = 0;
  const observed = await waitForStartupReady({
    bridge,
    pump: async () => {
      pumped += 1;
    },
  });
  expect(observed).toEqual({ rule: "sustained-frames", startup: revealed });
  expect(pumped).toBe(3);
});

test("a game that never finishes starting fails with it named, never silently observed", async () => {
  let clock = 0;
  await expect(
    waitForStartupReady({
      bridge: source(["runtime.startup"], [collapsing]),
      now: () => clock,
      pump: async () => {
        clock += 100;
      },
      timeoutMs: 250,
    }),
  ).rejects.toMatchObject({ diagnostic: { code: "TN_PLAYTEST_STARTUP_NOT_READY" } });
});

test("an application that reports no startup at all is not waited on", async () => {
  const bridge = source([], [undefined]);
  // A plain Three.js page has no startup phase to report; the harness runs against those by
  // design, so the wait has to be invisible to them rather than a new requirement.
  await expect(waitForStartupReady({ bridge, pump: async () => undefined })).resolves.toBeUndefined();
  expect(bridge.calls).toBe(0);
});

test("advertising runtime.startup and then reporting none is malformed, not 'still loading'", async () => {
  await expect(
    waitForStartupReady({ bridge: source(["runtime.startup"], [undefined]), pump: async () => undefined }),
  ).rejects.toBeInstanceOf(PlaytestBridgeError);
});

test("the three bridge advertises and reports startup only when the application supplies it", async () => {
  const scene = new Scene();
  const camera = new PerspectiveCamera(60, 16 / 9, 0.1, 100);
  const silent = installThreePlaytestBridge({ camera, renderer, scene });
  expect((await silent.bridge.describe()).capabilities).not.toContain("runtime.startup");
  expect(silent.bridge.ready()).toEqual({ ready: true });
  silent.dispose();

  let phase: IPlaytestStartupObservation["phase"] = "collapsing";
  const reporting = installThreePlaytestBridge({
    camera,
    renderer,
    scene,
    startup: () => ({ phase, progress: phase === "ready" ? 1 : 0 }),
  });
  expect((await reporting.bridge.describe()).capabilities).toContain("runtime.startup");
  expect(reporting.bridge.ready()).toEqual({ ready: true, startup: collapsing });
  phase = "ready";
  expect(reporting.bridge.ready()).toEqual({ ready: true, startup: ready });
  reporting.dispose();
});

test("a scenario whose subject is the launch can opt out, and the field is validated", () => {
  const base = {
    name: "loading-screen",
    schemaVersion: 1,
    steps: [{ kind: "wait", waitTicks: 1 }],
    target: "web",
    viewport: { height: 360, width: 640 },
    warmupFrames: 0,
  };
  // Default is to wait: an absent field must never read as "skip the wait".
  expect(validatePlaytestScenario(base, "s.json").awaitStartup).toBeUndefined();
  expect(validatePlaytestScenario({ ...base, awaitStartup: false }, "s.json").awaitStartup).toBe(false);
  // Fails closed rather than coercing a typo into an opt-out.
  expect(() => validatePlaytestScenario({ ...base, awaitStartup: "no" }, "s.json")).toThrow();
});


test("a bridge too busy to answer is still starting, not broken", async () => {
  // `ready` carries the protocol operation timeout, and this wait is the one caller that makes
  // that call while first-use work is compiling — the moment the page's main thread is most
  // likely to block past it. Observed for real: "Bridge operation 'ready' exceeded 5000ms".
  const timeout = new PlaytestBridgeError(
    playtestDiagnostic("TN_PLAYTEST_OPERATION_TIMEOUT", "Bridge operation 'ready' exceeded 5000ms.", "x"),
  );
  let call = 0;
  const bridge: IStartupReadySource = {
    description: { capabilities: ["runtime.startup"] },
    readiness: () => {
      call += 1;
      if (call <= 2) return Promise.reject(timeout);
      return Promise.resolve({ ready: true, startup: ready });
    },
  };
  let pumped = 0;
  await expect(
    waitForStartupReady({
      bridge,
      pump: async () => {
        pumped += 1;
      },
    }),
  ).resolves.toEqual({ rule: "sustained-frames", startup: ready });
  expect(pumped).toBe(2);
});

test("a startup frame that times out while compiling is retried within the readiness deadline", async () => {
  const timeout = new PlaytestBridgeError(
    playtestDiagnostic("TN_PLAYTEST_OPERATION_TIMEOUT", "Device mailbox operation '110' exceeded 20250ms.", "x"),
  );
  const bridge = source(["runtime.startup"], [collapsing, ready]);
  let pumps = 0;
  await expect(waitForStartupReady({
    bridge,
    pump: async () => {
      pumps += 1;
      if (pumps === 1) throw timeout;
    },
  })).resolves.toEqual({ rule: "sustained-frames", startup: ready });
  expect(pumps).toBe(2);
});

test("a bridge that only ever times out still fails, by name", async () => {
  let clock = 0;
  const timeout = new PlaytestBridgeError(
    playtestDiagnostic("TN_PLAYTEST_OPERATION_TIMEOUT", "Bridge operation 'ready' exceeded 5000ms.", "x"),
  );
  await expect(
    waitForStartupReady({
      bridge: {
        description: { capabilities: ["runtime.startup"] },
        readiness: () => Promise.reject(timeout),
      },
      now: () => clock,
      pump: async () => {
        clock += 100;
      },
      timeoutMs: 250,
    }),
  ).rejects.toMatchObject({ diagnostic: { code: "TN_PLAYTEST_STARTUP_NOT_READY" } });
});

test("an error that is not a timeout is never swallowed", async () => {
  const boom = new Error("bridge exploded");
  await expect(
    waitForStartupReady({
      bridge: {
        description: { capabilities: ["runtime.startup"] },
        readiness: () => Promise.reject(boom),
      },
      pump: async () => undefined,
    }),
  ).rejects.toBe(boom);
});

// A software lane is still a lane where the game's own launch work must have run: a game that
// builds its world on `whenReady()` — the puzzle's crate pile is one — is only observable after
// `phase` reaches "ready". The declaration relaxes nothing about *when* the run observes; it only
// labels the result, because a CPU rasteriser reaches readiness on the bounded frame window
// rather than on five sustained in-budget frames.
const collapsingCompiled = { compileSettled: true, phase: "collapsing", progress: 0 } as const;
const collapsingCompiling = { compileSettled: false, phase: "collapsing", progress: 0 } as const;

test("a declared software adapter still waits for the world, not just compile settlement", async () => {
  const bridge = source(["runtime.startup"], [collapsingCompiling, collapsingCompiled, ready]);
  let pumped = 0;
  await expect(
    waitForStartupReady({
      bridge,
      declaredSoftware: true,
      pump: async () => {
        pumped += 1;
      },
    }),
  ).resolves.toEqual({ rule: "compile-settled", startup: ready });
  // Two frames past the compile-settled reading: the world wait was not skipped on a software lane.
  expect(pumped).toBe(2);
});

test("compile settlement that never becomes ready fails closed, software lane or not", async () => {
  let clock = 0;
  // Compilation settles and the phase never leaves it: the run must fail rather than observe a
  // game whose own launch work is still pending. This is the half the old relaxation lost.
  await expect(
    waitForStartupReady({
      declaredSoftware: true,
      bridge: source(["runtime.startup"], [collapsingCompiled]),
      now: () => clock,
      pump: async () => {
        clock += 100;
      },
      timeoutMs: 250,
    }),
  ).rejects.toMatchObject({ diagnostic: { code: "TN_PLAYTEST_STARTUP_NOT_READY" } });
});

test("without the operator's declaration, readiness is reported as the sustained-frames rule", async () => {
  const bridge = source(["runtime.startup"], [collapsingCompiled, ready]);
  await expect(
    waitForStartupReady({ bridge, pump: async () => undefined }),
  ).resolves.toEqual({ rule: "sustained-frames", startup: ready });
});

test("a software lane is labelled compile-settled even when readiness arrives at once", async () => {
  const bridge = source(["runtime.startup"], [ready]);
  await expect(
    waitForStartupReady({ bridge, declaredSoftware: true, pump: async () => undefined }),
  ).resolves.toEqual({ rule: "compile-settled", startup: ready });
});

test("yields to teardown instead of polling to its own deadline", async () => {
  // The orphan gate kills a run on purpose and then asserts the browser profile is gone. With a
  // 180s deadline and a poll that treats a busy bridge as "still starting", a signal arriving
  // mid-wait left this loop running for minutes while the teardown behind it waited — observed in
  // CI as "before 1, after 3 ... no process holds these directories".
  let tearingDown = false;
  let polls = 0;
  const bridge = {
    description: { capabilities: ["runtime.startup"] },
    readiness: async () => {
      polls += 1;
      if (polls === 2) tearingDown = true;
      return { startup: { phase: "collapsing", compileSettled: false } } as never;
    },
  };
  await expect(
    waitForStartupReady({
      aborted: () => tearingDown,
      bridge: bridge as never,
      pump: async () => undefined,
      timeoutMs: 180_000,
    }),
  ).rejects.toMatchObject({ diagnostic: { code: "TN_PLAYTEST_STARTUP_ABORTED" } });
  expect(polls).toBeLessThanOrEqual(2);
});

// A host that has exited is a crash, not a slow launch. Folding its bridge timeouts into "still
// loading" spent the whole 180s deadline and then blamed the game's loading gate: PR #122's
// hosted Windows collector reported `Application startup stayed 'unreadable, the bridge kept
// timing out' for 180000ms` with no word about the process that was no longer there.
test("a host that exited during startup is named as a crash, not a slow loading gate", async () => {
  let clock = 0;
  const timeout = new PlaytestBridgeError(
    playtestDiagnostic("TN_PLAYTEST_OPERATION_TIMEOUT", "Bridge operation 'ready' exceeded 5000ms.", "x"),
  );
  let pumped = 0;
  await expect(
    waitForStartupReady({
      bridge: {
        description: { capabilities: ["runtime.startup"] },
        readiness: () => Promise.reject(timeout),
      },
      hostAlive: async () => false,
      now: () => clock,
      pump: async () => {
        clock += 100;
        pumped += 1;
      },
      timeoutMs: 600_000,
    }),
  ).rejects.toMatchObject({ diagnostic: { code: "TN_PLAYTEST_STARTUP_HOST_EXITED" } });
  // Named on the first unreadable poll, not after the deadline it would otherwise have burned.
  expect(pumped).toBe(0);
});

test("a host that is alive keeps the wait on its deadline", async () => {
  let clock = 0;
  const timeout = new PlaytestBridgeError(
    playtestDiagnostic("TN_PLAYTEST_OPERATION_TIMEOUT", "Bridge operation 'ready' exceeded 5000ms.", "x"),
  );
  await expect(
    waitForStartupReady({
      bridge: {
        description: { capabilities: ["runtime.startup"] },
        readiness: () => Promise.reject(timeout),
      },
      hostAlive: async () => true,
      now: () => clock,
      pump: async () => {
        clock += 100;
      },
      timeoutMs: 250,
    }),
  ).rejects.toMatchObject({ diagnostic: { code: "TN_PLAYTEST_STARTUP_NOT_READY" } });
});

// A driver that cannot answer must not manufacture a crash: an undefined reading leaves the
// wait exactly as it was.
test("an unreadable liveness probe never invents a crash", async () => {
  const bridge = source(["runtime.startup"], [collapsing, ready]);
  await expect(
    waitForStartupReady({
      bridge,
      hostAlive: async () => undefined,
      pump: async () => undefined,
    }),
  ).resolves.toEqual({ rule: "sustained-frames", startup: ready });
});

test("startup frame timeouts consume the remaining deadline without resetting it", async () => {
  let clock = 0;
  const budgets: Array<number | undefined> = [];
  const timeout = new PlaytestBridgeError(playtestDiagnostic("TN_PLAYTEST_OPERATION_TIMEOUT", "RAF stalled", "Check rendering"));
  await expect(waitForStartupReady({
    bridge: source(["runtime.startup"], [collapsing]),
    now: () => clock,
    timeoutMs: 200,
    pump: async (remainingMs) => {
      budgets.push(remainingMs);
      clock += 50;
      throw timeout;
    },
  })).rejects.toMatchObject({ diagnostic: { code: "TN_PLAYTEST_STARTUP_NOT_READY" } });
  expect(budgets).toEqual([200, 150, 100, 50]);
  expect(clock).toBe(200);
});


test("warmup does not spend the readiness allowance", async () => {
  let clock = 0;
  const budgets: Array<number | undefined> = [];
  await expect(waitForStartupReady({
    bridge: source(["runtime.startup"], [collapsing, collapsing, ready]),
    now: () => clock,
    timeoutMs: 200,
    warmup: async () => {
      clock += 300;
    },
    pump: async (remainingMs) => {
      budgets.push(remainingMs);
      clock += 50;
    },
  })).resolves.toEqual({ rule: "sustained-frames", startup: ready });
  expect(budgets).toEqual([200, 150]);
  expect(clock).toBe(400);
});

test("warmup is one wait whose budget grows with its frames", async () => {
  vi.useFakeTimers();
  try {
    let result: unknown = "pending";
    const slow = { evaluate: () => new Promise((resolve) => setTimeout(resolve, 39_000)) } as unknown as Page;
    const pending = waitWarmupFrames(slow, 3).then(() => { result = "done"; }, (error) => { result = error; });
    await vi.advanceTimersByTimeAsync(39_000);
    await pending;
    expect(result).toBe("done");
    const hung = { evaluate: () => new Promise(() => {}) } as unknown as Page;
    result = "pending";
    const stalled = waitWarmupFrames(hung, 3).then(() => { result = "done"; }, (error) => { result = error; });
    await vi.advanceTimersByTimeAsync(74_999);
    expect(result).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toMatchObject({ diagnostic: { code: "TN_PLAYTEST_OPERATION_TIMEOUT" } });
    await stalled;
  } finally {
    vi.useRealTimers();
  }
});

test("a hung readiness read is Node-bounded by the shared startup allowance", async () => {
  vi.useFakeTimers();
  try {
    let result: unknown = "pending";
    const bridge = source(["runtime.startup"], [ready]);
    bridge.readiness = () => new Promise(() => {});
    const pending = waitForStartupReady({
      bridge,
      timeoutMs: 100,
      warmup: async () => undefined,
      pump: async () => { throw new Error("hung phase cannot pump"); },
    }).then(value => { result = value; }, error => { result = error; });
    await vi.advanceTimersByTimeAsync(99);
    expect(result).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toMatchObject({ diagnostic: { code: "TN_PLAYTEST_STARTUP_NOT_READY" } });
    await pending;
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test.each(["success", "warmup-error", "readiness-error"] as const)("the shared startup timer clears after %s", async (outcome) => {
  vi.useFakeTimers();
  try {
    const sentinel = new Error(outcome);
    const bridge = source(["runtime.startup"], [ready]);
    if (outcome === "readiness-error") bridge.readiness = async () => { throw sentinel; };
    const pending = waitForStartupReady({
      bridge,
      timeoutMs: 100,
      warmup: async () => { if (outcome === "warmup-error") throw sentinel; },
      pump: async () => undefined,
    });
    if (outcome === "success") await expect(pending).resolves.toEqual({ rule: "sustained-frames", startup: ready });
    else await expect(pending).rejects.toBe(sentinel);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test("without runtime.startup warmup keeps its original operation deadline", async () => {
  vi.useFakeTimers();
  try {
    let result: unknown = "pending";
    const page = { evaluate: () => new Promise(() => {}) } as unknown as Page;
    const bridge = source([], [undefined]);
    const pending = waitForStartupReady({
      bridge,
      timeoutMs: 100,
      warmup: () => waitFrames(page, 10),
      pump: async () => { throw new Error("unsupported startup must not pump"); },
    }).then(value => { result = value; }, error => { result = error; });
    await vi.advanceTimersByTimeAsync(22_499);
    expect(result).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toMatchObject({ diagnostic: { code: "TN_PLAYTEST_OPERATION_TIMEOUT" } });
    await pending;
    expect(bridge.calls).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test.each(["collapsing", "busy"] as const)("late %s readiness cannot resume startup work after the Node deadline", async (late) => {
  vi.useFakeTimers();
  try {
    let release: (value: IPlaytestBridgeReady) => void = () => undefined;
    let fail: (error: Error) => void = () => undefined;
    let reads = 0;
    let pumps = 0;
    let hostChecks = 0;
    const pending = waitForStartupReady({
      bridge: {
        description: { capabilities: ["runtime.startup"] },
        readiness: () => {
          reads += 1;
          return new Promise((resolve, reject) => { release = resolve; fail = reject; });
        },
      },
      now: () => 0,
      timeoutMs: 100,
      hostAlive: async () => { hostChecks += 1; return true; },
      pump: () => { pumps += 1; return new Promise(() => {}); },
    });
    const failed = expect(pending).rejects.toMatchObject({ diagnostic: { code: "TN_PLAYTEST_STARTUP_NOT_READY" } });
    await vi.advanceTimersByTimeAsync(100);
    await failed;
    if (late === "collapsing") release({ ready: true, startup: collapsing });
    else fail(new PlaytestBridgeError(playtestDiagnostic("TN_PLAYTEST_OPERATION_TIMEOUT", "late timeout", "x")));
    await vi.advanceTimersByTimeAsync(0);
    expect({ reads, pumps, hostChecks }).toEqual({ reads: 1, pumps: 0, hostChecks: 0 });
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

