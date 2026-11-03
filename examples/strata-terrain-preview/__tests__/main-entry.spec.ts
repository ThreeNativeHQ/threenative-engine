import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

// `start()` already reports its failure by name through onLaunchFailure; the entry point must not
// add an "Uncaught (in promise)" on top of it.
it("leaves a rejected game.start() to the launch-failure report (audit STRATA-16)", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  vi.stubGlobal("location", { search: "" });
  const ready = vi.fn();
  vi.doMock("../src/launchFailure.js", () => ({ showLaunchFailures: () => ({ ready }) }));
  vi.doMock("../src/game.js", () => ({
    default: {
      state: { setState: vi.fn() },
      resumeScene: vi.fn(),
      start: () => Promise.reject(new Error("The game failed to start: device lost")),
    },
  }));
  try {
    await import("../src/main.js");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(unhandled).toEqual([]);
    expect(ready).not.toHaveBeenCalled();
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
