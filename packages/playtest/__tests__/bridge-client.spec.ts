import { expect, test } from "vitest";
import {
  PLAYTEST_PROTOCOL_LIMITS,
  PLAYTEST_PROTOCOL_VERSION,
  PLAYTEST_STARTUP_COMPILE_BUDGET_MS,
  type IPlaytestBridgeDescription,
} from "../src/protocol.js";
import {
  advanceTimeoutMs,
  bridgeWaitTimeoutMs,
  connectPlaytestBridgeTransport,
  type IBridgeTransport,
} from "../src/runner/bridgeClient.js";
import type { IPlaytestScenario } from "../src/scenario.js";


test("advance is budgeted by the ticks it was asked for, not by a fixed round trip", () => {
  // `starter-game-over` advances 600 ticks in one call and exceeded the 5s operation timeout on a
  // two-core CI runner, reported as TN_PLAYTEST_OPERATION_TIMEOUT — which reads as a hung page
  // rather than a slow one. Every other bridge method is a request and a reply; advance runs the
  // game loop N times before replying, so its bound has to grow with N.
  const base = PLAYTEST_PROTOCOL_LIMITS.operationTimeoutMs + PLAYTEST_STARTUP_COMPILE_BUDGET_MS;
  expect(advanceTimeoutMs(0)).toBe(base);
  // warmupFrames advances before the startup wait, so the shortest advance is the one most likely
  // to overlap first-use compilation. 10 ticks exceeded 7500ms on a two-core runner.
  expect(advanceTimeoutMs(10)).toBeGreaterThan(7_500);
  expect(advanceTimeoutMs(600)).toBeGreaterThan(60_000);
  expect(advanceTimeoutMs(600)).toBeGreaterThan(advanceTimeoutMs(300));
  // A malformed count must not produce a shorter budget than the round trip alone.
  expect(advanceTimeoutMs(Number.NaN)).toBe(base);
  expect(advanceTimeoutMs(-5)).toBe(base);
});

test("waiting for the bridge is budgeted by startup, not by a round trip", () => {
  // `starter-assets` reported TN_PLAYTEST_BRIDGE_MISSING with `frames: 0` on a software-rendered
  // two-core runner. The bridge is installed during application startup, so bounding that wait
  // with `operationTimeoutMs` asks first-use compilation to fit inside one request and reply —
  // the same mistake `advance` had, in the same direction.
  expect(bridgeWaitTimeoutMs()).toBe(
    PLAYTEST_PROTOCOL_LIMITS.operationTimeoutMs + PLAYTEST_STARTUP_COMPILE_BUDGET_MS,
  );
  expect(bridgeWaitTimeoutMs()).toBeGreaterThan(PLAYTEST_PROTOCOL_LIMITS.operationTimeoutMs);

  // A caller's own operation budget is honoured and still gets the startup allowance on top.
  expect(bridgeWaitTimeoutMs(1_000)).toBe(1_000 + PLAYTEST_STARTUP_COMPILE_BUDGET_MS);
});

test("the bridge handshake is budgeted by startup, not by one round trip", async () => {
  // `tower-defense` failed with "Bridge operation 'ready' exceeded 15000ms" at `frames: 0`: the CLI's
  // own page-operation default *is* the first-use compile bound, so a slow software-GPU shader
  // compile had to finish inside a request and a reply. describe/ready are answered while the page
  // is still booting, exactly like the bridge wait, and are the third call this file already had to
  // grow for the same reason.
  const timeouts = new Map<string, number>();
  const description: IPlaytestBridgeDescription = {
    capabilities: [],
    limits: PLAYTEST_PROTOCOL_LIMITS,
    name: "handshake-budget-fixture",
    protocolVersion: PLAYTEST_PROTOCOL_VERSION,
  };
  const transport: IBridgeTransport = {
    capabilities: [],
    async call<T>(method: string, _argument?: unknown, timeoutMs?: number): Promise<T> {
      timeouts.set(method, timeoutMs ?? PLAYTEST_PROTOCOL_LIMITS.operationTimeoutMs);
      if (method === "describe") return description as T;
      if (method === "ready") return { ready: true } as T;
      return undefined as T;
    },
    async close(): Promise<void> {},
    async waitForBridge(): Promise<boolean> {
      return true;
    },
  };
  const scenario: IPlaytestScenario = {
    artifacts: { screenshots: false },
    name: "handshake budget",
    schemaVersion: 1,
    steps: [{ release: true, waitTicks: 1 }],
    target: "web",
    viewport: { height: 180, width: 320 },
    warmupFrames: 0,
  };

  const client = await connectPlaytestBridgeTransport(transport, scenario);
  if (client === undefined) throw new Error("Expected a connected transport.");

  expect(timeouts.get("describe")).toBeGreaterThan(PLAYTEST_STARTUP_COMPILE_BUDGET_MS);
  expect(timeouts.get("ready")).toBeGreaterThan(PLAYTEST_STARTUP_COMPILE_BUDGET_MS);
});
