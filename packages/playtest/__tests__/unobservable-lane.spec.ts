// PRD-265 — the runner never grades a lane it cannot observe.
//
// Three sites inverted the harness's founding rule in the same shape: a default that asserts, a
// transport that cannot observe, and a report that passes anyway. Each test below is the negative
// control the PRD names — delete the guard it exercises and the test goes green on evidence that
// was never produced.
import { describe, expect, it, vi } from "vitest";
import {
  resolveDiagnosticsPolicy,
  UNOBSERVABLE_NETWORK_REASON,
} from "../src/assertion-report.js";
import { setupApplication } from "../src/runner/setup-confirmation.js";
import { runStep } from "../src/runner/steps.js";
import { applyScenarioSetup } from "../src/runner/setup.js";
import type { IPlaytestScenario, IPlaytestSetupRecord } from "../src/index.js";

describe("1. the default diagnostics policy on a lane with no network observer", () => {
  it("should assert the network channel on the browser lane, where it is observable", () => {
    expect(resolveDiagnosticsPolicy(undefined, "browser").noNetworkErrors).toBe(true);
    expect(resolveDiagnosticsPolicy(undefined, "browser").networkErrorsOptOutReason).toBeUndefined();
  });

  it("should waive it on device lanes without an observer, and say why in the policy the report prints", () => {
    for (const target of ["android", "ios"]) {
      const policy = resolveDiagnosticsPolicy(undefined, target);
      // The mutation the PRD names: revert the default-on-device handling and this flips to true,
      // which is then compared against `network: []` and reported as a passing row.
      expect(policy.noNetworkErrors).toBe(false);
      expect(policy.networkErrorsOptOutReason).toBe(UNOBSERVABLE_NETWORK_REASON);
      // The channels a device lane genuinely observes are untouched.
      expect(policy.noConsoleErrors).toBe(true);
      expect(policy.noRuntimeDiagnostics).toBe(true);
    }
  });

  it("asserts the observed desktop network channel by default", () => {
    expect(resolveDiagnosticsPolicy(undefined, "desktop").noNetworkErrors).toBe(true);
    expect(resolveDiagnosticsPolicy(undefined, "desktop").networkErrorsOptOutReason).toBeUndefined();
  });

  it("should treat `diagnostics: {}` exactly as an absent block", () => {
    expect(resolveDiagnosticsPolicy({}, "android").noNetworkErrors).toBe(false);
  });

  it("should never overwrite what a scenario spelled out", () => {
    // An explicit `true` on a device lane is a scenario asking for something the target cannot do.
    // It stays true here so androidRunner's unsupportedAssertion still fails it by name, rather
    // than being quietly turned into a waiver.
    expect(resolveDiagnosticsPolicy({ noNetworkErrors: true }, "android").noNetworkErrors).toBe(true);
    const declared = resolveDiagnosticsPolicy(
      { noNetworkErrors: false, networkErrorsOptOutReason: "the scenario's own reason" },
      "android",
    );
    expect(declared.networkErrorsOptOutReason).toBe("the scenario's own reason");
  });
});

describe("2. tick steps against a bridge that cannot tick", () => {
  function pageDouble(): { page: unknown; waited: number[] } {
    const waited: number[] = [];
    const page = {
      evaluate: async (_callback: unknown, frames?: unknown) => {
        if (typeof frames === "number") waited.push(frames);
      },
      keyboard: { down: async () => undefined, up: async () => undefined },
      mouse: { down: async () => undefined, move: async () => undefined, up: async () => undefined },
    };
    return { page, waited };
  }

  const noFixedStep = {
    description: { capabilities: ["entity.observe"], protocolVersion: 1 },
    sample: async () => ({ clock: { mode: "raf" as const, tick: 0 } }),
  };

  it("should refuse to substitute display frames for the ticks the step asked for", async () => {
    const { page } = pageDouble();
    await expect(
      runStep(
        page as never,
        noFixedStep as never,
        { label: "hold-forward", press: "KeyW", holdTicks: 30, release: true } as never,
        { height: 360, width: 640 },
        undefined,
        [],
        { heldKeys: new Set(), pointerButtons: 0, pointers: new Map() },
        undefined,
        true,
      ),
    ).rejects.toMatchObject({
      diagnostic: expect.objectContaining({
        code: "TN_PLAYTEST_UNSUPPORTED_ON_TARGET",
        message: expect.stringContaining("counts 30 fixed-step tick(s)"),
      }),
    });
  });

  it("should leave a step authored in frames alone, because frames are what it says", async () => {
    const { page, waited } = pageDouble();
    await runStep(
      page as never,
      noFixedStep as never,
      { label: "hold-forward", press: "KeyW", holdFrames: 3, release: true } as never,
      { height: 360, width: 640 },
      undefined,
      [],
      { heldKeys: new Set(), pointerButtons: 0, pointers: new Map() },
      undefined,
      true,
    );
    // The mutation: delete the guard and the tick case above lands here too, waiting on display
    // refresh while the report still says it counted ticks.
    expect(waited).toContain(3);
  });
});

describe("3. setup evidence distinguishes what was asked from what was confirmed", () => {
  const requested: IPlaytestSetupRecord[] = [
    { entity: "player", kind: "spawn", value: { x: 1, z: 2 } },
    { entity: "beacon", kind: "place", value: { at: { x: 0, y: 0, z: 0 } } },
  ];

  it("should mark a bridge that only resolves as evidence from the throw contract", () => {
    expect(setupApplication([...requested], undefined)).toEqual({
      applied: requested,
      confirmedBy: "throw-contract",
      requested,
    });
  });

  it("should mark a bridge that names what it applied as a read-back", () => {
    expect(
      setupApplication([...requested], { entities: ["player", "beacon"], resources: [] }),
    ).toEqual({ applied: requested, confirmedBy: "read-back", requested });
  });

  it("should fail on a bridge that resolves while skipping an entry", () => {
    // The mutation: make the bridge-double swallow an entry. Before the read-back the runner
    // reported `applied === requested` and the run passed.
    expect(() => setupApplication([...requested], { entities: ["player"] })).toThrow(
      /did not confirm place 'beacon'/u,
    );
  });

  it("should reach that failure through the real runner entry point", async () => {
    const scenario = {
      name: "swallowing-bridge",
      schemaVersion: 1,
      setup: { place: [{ at: { x: 3, y: 0, z: 4 }, entity: "beacon" }] },
      steps: [],
      subject: "player",
      target: "web",
      viewport: { height: 360, width: 640 },
    } as unknown as IPlaytestScenario;
    const bridge = {
      // Resolves, applies nothing, names nothing it applied.
      applySetup: vi.fn(async () => ({ entities: [] })),
      sample: vi.fn(async () => ({ clock: { mode: "fixed-step" as const, tick: 0 } })),
    };
    await expect(
      applyScenarioSetup(bridge as never, scenario),
    ).rejects.toMatchObject({
      diagnostic: expect.objectContaining({ code: "TN_PLAYTEST_SETUP_UNAPPLIED" }),
    });
    expect(bridge.applySetup).toHaveBeenCalledTimes(1);
  });
});
