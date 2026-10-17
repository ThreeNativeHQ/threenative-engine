import { describe, expect, it, vi } from "vitest";
import type { Page } from "playwright";
import { runStep } from "../src/runner/steps.js";
import type { IPlaytestBridgeClient } from "../src/runner/bridgeClient.js";

describe("fixed-step request scheduling", () => {
  it("submits one tick per bridge request while retaining the 10-tick sample cadence", async () => {
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
      sample: vi.fn(async () => ({
        clock: { mode: "fixed-step", tick: 0 },
        diagnostics: [],
        entities: [{ id: "player", transform: { position: [0, 0, 0] } }],
      })),
    } as unknown as IPlaytestBridgeClient;

    const page = {} as unknown as Page;

    await runStep(
      page,
      bridge,
      { kind: "wait", release: false, waitTicks: 25 },
      { height: 100, width: 100 },
      "player",
      [],
      { heldKeys: new Set(), pointerButtons: 0, pointers: new Map() },
      undefined,
      false,
    );

    expect(advances).toEqual(Array.from({ length: 25 }, () => 1));
    expect(advances.reduce((total, ticks) => total + ticks, 0)).toBe(25);
    expect(bridge.sample).toHaveBeenCalledTimes(3);
  });
});
