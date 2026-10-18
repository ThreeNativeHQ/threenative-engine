import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { describe, expect, it, vi } from "vitest";
import {
  ENGINE_PARITY_THRESHOLD,
  KNOWN_GAPS,
  observedFixedStepSeconds,
  parityScore,
  sameFixedStepPose,
  sideBySide,
  verdict,
  withBrowserWatchdogArtifact,
  withEngine,
} from "../engine-parity.js";

function frame(width: number, height: number, paint: (x: number, y: number) => number): PNG {
  const image = new PNG({ width, height });
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const v = paint(x, y);
      image.data[i] = v;
      image.data[i + 1] = v;
      image.data[i + 2] = v;
      image.data[i + 3] = 255;
    }
  return image;
}

describe("engine parity guard", () => {
  it("persists Chromium watchdog evidence when a capture fails, then rethrows that failure", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "engine-parity-watchdog-"));
    let histogramRequests = 0;
    const cdp = {
      send: async () => {
        histogramRequests++;
        return histogramRequests === 1
          ? { histograms: [] }
          : {
              histograms: [
                {
                  name: "GPU.WatchdogThread.Event",
                  sum: 2,
                  count: 1,
                  buckets: [{ low: 1, high: 2, count: 1 }],
                },
              ],
            };
      },
      detach: async () => undefined,
    };
    const page = {
      context: () => ({
        browser: () => ({
          version: () => "Chromium 151.0.0.0",
          newBrowserCDPSession: async () => cdp,
        }),
      }),
    } as never;
    const failure = new Error("screenshot failed");
    try {
      await expect(
        withBrowserWatchdogArtifact(page, path.join(directory, "watchdog.json"), async () => {
          throw failure;
        }),
      ).rejects.toBe(failure);
      const artifact = JSON.parse(readFileSync(path.join(directory, "watchdog.json"), "utf8"));
      expect(artifact).toMatchObject({
        browserVersion: "Chromium 151.0.0.0",
        query: "GPU.WatchdogThread.Event",
        status: "watchdog-kill-confirmed",
        samples: [
          { response: { histograms: [] } },
          { response: { histograms: [{ name: "GPU.WatchdogThread.Event", sum: 2, count: 1 }] } },
        ],
      });
      expect(histogramRequests).toBe(2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("records unavailable or empty CDP data as inconclusive without masking the capture failure", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "engine-parity-watchdog-"));
    const failure = new Error("diagnostic capture failed");
    const cases = [
      {
        label: "unavailable",
        open: async () => {
          throw new Error("CDP unavailable");
        },
      },
      {
        label: "empty",
        open: async () => ({
          send: async () => ({ histograms: [] }),
          detach: async () => undefined,
        }),
      },
    ];
    try {
      for (const item of cases) {
        const page = {
          context: () => ({
            browser: () => ({
              version: () => "Chromium 151.0.0.0",
              newBrowserCDPSession: item.open,
            }),
          }),
        } as never;
        const artifactPath = path.join(directory, `${item.label}.json`);
        await expect(
          withBrowserWatchdogArtifact(page, artifactPath, async () => {
            throw failure;
          }),
        ).rejects.toBe(failure);
        const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
        expect(artifact.status).toBe("inconclusive");
        expect(artifact.browserVersion).toBe("Chromium 151.0.0.0");
        expect(artifact).not.toHaveProperty("watchdogDetected");
        if (item.label === "unavailable") expect(artifact.reason).toContain("CDP unavailable");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("bounds delayed CDP attach and detaches a session that arrives after cleanup", async () => {
    vi.useFakeTimers();
    const directory = mkdtempSync(path.join(tmpdir(), "engine-parity-watchdog-"));
    let resolveSession!: (session: { detach: () => Promise<void> }) => void;
    let detached = false;
    const pendingSession = new Promise<{ detach: () => Promise<void> }>((resolve) => {
      resolveSession = resolve;
    });
    const page = {
      context: () => ({
        browser: () => ({
          version: () => "Chromium 151.0.0.0",
          newBrowserCDPSession: () => pendingSession,
        }),
      }),
    } as never;
    const failure = new Error("capture failed during browser teardown");
    try {
      const capture = withBrowserWatchdogArtifact(
        page,
        path.join(directory, "watchdog.json"),
        async () => {
          throw failure;
        },
      );
      const preservedCaptureError = expect(capture).rejects.toBe(failure);
      await vi.advanceTimersByTimeAsync(900);
      await preservedCaptureError;
      const artifact = JSON.parse(readFileSync(path.join(directory, "watchdog.json"), "utf8"));
      expect(artifact.status).toBe("inconclusive");
      expect(artifact.reason).toContain("deadline elapsed");

      resolveSession({
        detach: () => {
          detached = true;
          return new Promise(() => undefined);
        },
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(detached).toBe(true);
    } finally {
      vi.useRealTimers();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("measures the pose interval from the bridge's fixed-step clock", () => {
    // This is the public sample clock emitted by a fixed-step Three bridge: no resources clock
    // is required for the elapsed simulation interval.
    const before = { mode: "fixed-step" as const, tick: 60 };
    const after = { mode: "fixed-step" as const, tick: 360 };
    expect(observedFixedStepSeconds(before, after)).toBe(5);
    expect(observedFixedStepSeconds(before, { ...after, tick: Number.NaN })).toBeNull();
    expect(observedFixedStepSeconds(before, { mode: "wall-clock", tick: 360 })).toBeNull();
    expect(observedFixedStepSeconds(before, { mode: "fixed-step" })).toBeNull();
  });

  it("rejects equal intervals that end at different observed scene ticks", () => {
    const firstBefore = { mode: "fixed-step" as const, tick: 60 };
    const firstAfter = { mode: "fixed-step" as const, tick: 360 };
    const secondBefore = { mode: "fixed-step" as const, tick: 120 };
    const secondAfter = { mode: "fixed-step" as const, tick: 420 };
    expect(observedFixedStepSeconds(firstBefore, firstAfter)).toBe(5);
    expect(observedFixedStepSeconds(secondBefore, secondAfter)).toBe(5);
    expect(sameFixedStepPose(firstAfter, secondAfter)).toBe(false);
    expect(sameFixedStepPose(firstAfter, { ...firstAfter })).toBe(true);
  });

  it("passes matching frames and fails sailing's measured brightness gap", () => {
    const threejs = frame(64, 32, () => 137);
    expect(
      parityScore(
        threejs,
        frame(64, 32, () => 139),
      ),
    ).toBeLessThan(ENGINE_PARITY_THRESHOLD);
    // Sailing 2026-10-17: mean 137 on threejs, 225 on threenative.
    expect(
      parityScore(
        threejs,
        frame(64, 32, () => 225),
      ),
    ).toBeGreaterThan(ENGINE_PARITY_THRESHOLD);
  });

  it("fails one wrong tile that a global mean would hide", () => {
    const threejs = frame(64, 64, () => 100);
    // A missing object in one corner tile: 1/16 of the frame, under 2% of the global mean.
    const threenative = frame(64, 64, (x, y) => (x < 16 && y < 16 ? 0 : 100));
    expect(parityScore(threejs, threenative)).toBeGreaterThan(ENGINE_PARITY_THRESHOLD);
  });

  it("refuses frames of different sizes", () => {
    expect(() =>
      parityScore(
        frame(8, 8, () => 0),
        frame(8, 4, () => 0),
      ),
    ).toThrow("TN_ENGINE_PARITY_SIZE");
  });

  it("passes a known gap and fails it once it closes, so the list cannot go stale", () => {
    const gaps = { sailing: "tracked elsewhere" };
    expect(verdict("sailing", 0.85, gaps).ok).toBe(true);
    expect(verdict("sailing", 0.01, gaps)).toMatchObject({ ok: false });
    expect(verdict("sailing", 0.01, gaps).message).toContain("TN_ENGINE_PARITY_GAP_CLOSED");
    expect(verdict("sailing", 0.85, KNOWN_GAPS).ok).toBe(false);
    expect(verdict("starter", 0.2).message).toContain("TN_ENGINE_PARITY:");
    expect(verdict("starter", 0.05).ok).toBe(true);
  });

  it("re-exports the config under one engine, overriding a pin, for any export shape", () => {
    const template =
      'const config = {\n  engine: "threejs",\n  app: {},\n};\n\nexport default config;\n';
    expect(withEngine(template, "threenative")).toBe(
      'const config = {\n  engine: "threejs",\n  app: {},\n};\n\nconst __engineParityBase = config;\n' +
        '\nexport default { ...__engineParityBase, engine: "threenative" };\n',
    );
    expect(withEngine("export default defineConfig({ app: {} });\n", "threejs")).toContain(
      "const __engineParityBase = defineConfig({ app: {} });",
    );
    expect(() => withEngine("module.exports = {};", "threejs")).toThrow("TN_ENGINE_PARITY_CONFIG");
  });

  it("lays the two frames side by side", () => {
    const out = sideBySide(
      frame(4, 3, () => 0),
      frame(5, 2, () => 255),
    );
    expect([out.width, out.height]).toEqual([4 + 16 + 5, 3]);
  });
});
