import { describe, expect, it } from "vitest";

import { PLAYTEST_BRIDGE_GLOBAL } from "../src/protocol.js";
import {
  PENDING_BRIDGE_OPERATIONS_GLOBAL,
  PlaywrightTransport,
} from "../src/runner/bridgeClient.js";

describe("PlaywrightTransport", () => {
  it("uses the runner timeout for bridge operations", async () => {
    const page = {
      evaluate: () => new Promise(() => {}),
    };
    const transport = new PlaywrightTransport(page as never, 5);

    await expect(transport.call("advance", 1)).rejects.toThrow(
      "Bridge operation 'advance' exceeded 5ms.",
    );
  });

  it("keeps a pending bridge promise reachable in the page until it settles", async () => {
    const host = globalThis as Record<string, unknown>;
    let settle: (value: unknown) => void = () => undefined;
    const pending = new Promise<unknown>((resolve) => {
      settle = resolve;
    });
    const page = {
      evaluate: (evaluated: (input: unknown) => unknown, argument: unknown) => {
        host[PLAYTEST_BRIDGE_GLOBAL] = { applySetup: () => pending };
        const result = evaluated(argument) as Promise<unknown>;
        // Chromium's Runtime.awaitPromise holds the awaited promise weakly: a major GC while the
        // call waits on the engine reports "Resulting promise was garbage collected" unless the
        // page itself still reaches it. This is that check, made deterministic.
        const reached = host[PENDING_BRIDGE_OPERATIONS_GLOBAL] as Set<unknown> | undefined;
        if (!reached?.has(result)) {
          return Promise.reject(new Error("Resulting promise was garbage collected."));
        }
        settle("applied");
        return Promise.resolve(result);
      },
    };
    const transport = new PlaywrightTransport(page as never);

    await expect(transport.call("applySetup", {})).resolves.toBe("applied");
    expect((host[PENDING_BRIDGE_OPERATIONS_GLOBAL] as Set<unknown>).size).toBe(0);
    delete host[PLAYTEST_BRIDGE_GLOBAL];
  });
});
