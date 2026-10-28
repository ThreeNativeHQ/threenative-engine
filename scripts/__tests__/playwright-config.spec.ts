import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

import { acquireHotReloadProjectLock } from "../../test-support/hot-reload-lock.js";
import {
  packageSourcesMatch,
  selectHotReloadServerProject,
} from "../../test-support/hot-reload-project.js";
import {
  contactShadowCoverage,
  dominantColorCoverage,
  findLargestColorObject,
} from "../../test-support/starter-look-image.js";
import { makeTempDir } from "../../test-support/temp-dir.js";
import {
  assertAdapterInfo,
  assertWebGpuCaptureProvenance,
  waitForWebGpuProjectReady,
} from "../../test-support/webgpu-provenance.js";

const repo = path.resolve(import.meta.dirname, "../..");

describe("root Playwright lane contracts", () => {
  it("isolates the connected warm crate from coastal colour distractors", () => {
    const image = new PNG({ height: 80, width: 120 });
    paint(image, { bottom: 34, left: 44, right: 65, top: 20 }, [190, 90, 40]);
    paint(image, { bottom: 43, left: 48, right: 62, top: 39 }, [180, 82, 38]);
    paint(image, { bottom: 20, left: 100, right: 115, top: 10 }, [220, 120, 50]);

    expect(
      findLargestColorObject(
        image,
        { bottom: 70, left: 0, right: 120, top: 0 },
        (red, green, blue) => red > 130 && red > green * 1.2 && red > blue * 1.35,
      ),
    ).toEqual({ bounds: { bottom: 42, left: 44, right: 64, top: 20 }, count: 350 });
  });

  it("measures contact shadows relative to the surrounding floor", () => {
    const image = new PNG({ height: 80, width: 120 });
    paint(image, { bottom: 80, left: 0, right: 120, top: 0 }, [170, 170, 170]);
    paint(image, { bottom: 58, left: 40, right: 62, top: 48 }, [70, 70, 70]);
    const bounds = { bottom: 47, left: 42, right: 60, top: 20 };

    expect(contactShadowCoverage(image, bounds)).toBeGreaterThan(0.02);

    paint(image, { bottom: 80, left: 0, right: 120, top: 0 }, [45, 45, 45]);
    expect(contactShadowCoverage(image, bounds)).toBe(0);
  });

  it("identifies a canvas that stayed on one background colour behind HUD pixels", () => {
    const image = new PNG({ height: 100, width: 100 });
    paint(image, { bottom: 100, left: 0, right: 100, top: 0 }, [12, 82, 110]);
    paint(image, { bottom: 52, left: 20, right: 80, top: 50 }, [230, 190, 130]);

    expect(dominantColorCoverage(image, { bottom: 100, left: 0, right: 100, top: 0 })).toBe(0.988);
  });

  it("runs adapter provenance setup in both browser and benchmark configs", async () => {
    const [browser, benchmark] = await Promise.all([
      readFile(path.join(repo, "playwright.config.ts"), "utf8"),
      readFile(path.join(repo, "benchmark.playwright.config.ts"), "utf8"),
    ]);

    expect(browser).toContain('globalSetup: "./test-support/root-playwright-setup.ts"');
    expect(benchmark).toContain('globalSetup: "./test-support/benchmark-playwright-setup.ts"');
  });

  it("runs the benchmark browser headed on a display, where SwiftShader keeps its device", async () => {
    // Headless Chromium destroys the WebGPU device at the first canvas present on SwiftShader.
    const { default: benchmark } = await import("../../benchmark.playwright.config.js");
    const workflow = await readFile(path.join(repo, ".github/workflows/ci.yml"), "utf8");

    expect(benchmark.use?.headless).toBe(false);
    expect(workflow).toContain(
      "run: sh scripts/xvfb.sh pnpm exec playwright test --config=benchmark.playwright.config.ts",
    );
  });

  it("allows the CI software adapter for the starter-look smoke runner", async () => {
    const browser = await readFile(path.join(repo, "playwright.config.ts"), "utf8");
    const start = browser.indexOf("async function runStarterLookScenario");
    const end = browser.indexOf("async function assertStarterScreenshot");

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(browser.slice(start, end)).toContain('"--allow-software"');
  });

  it("rejects a cached scaffold when a package source moves but keeps its basename", () => {
    const sourcePath = "/tmp/packages-a/threenative-core-0.1.0.tgz";
    const movedSourcePath = "/tmp/packages-b/threenative-core-0.1.0.tgz";
    const localSources = { "@threenative/core": sourcePath };

    expect(
      packageSourcesMatch(localSources, { "@threenative/core": `file:${movedSourcePath}` }),
    ).toBe(false);
    expect(packageSourcesMatch(localSources, { "@threenative/core": `file:${sourcePath}` })).toBe(
      true,
    );
  });

  it("keeps the server on the project exported by the config that launched it", () => {
    expect(selectHotReloadServerProject("/tmp/original/starter", "/tmp/retry/starter")).toBe(
      "/tmp/original/starter",
    );
  });

  it("fails closed when adapter.info is absent", () => {
    expect(() => assertAdapterInfo(undefined, [], "root browser")).toThrow(/adapter evidence/i);
  });

  it("fails closed when adapter.info identifies software WebGPU", () => {
    expect(() =>
      assertAdapterInfo({ architecture: "swiftshader", vendor: "google" }, [], "root browser"),
    ).toThrow(/software adapter/i);
  });

  it("accepts software WebGPU only when the CI fallback is explicit", () => {
    expect(() =>
      assertAdapterInfo({ architecture: "swiftshader", vendor: "google" }, [], "root browser", {
        allowSoftwareAdapter: true,
      }),
    ).not.toThrow();
  });

  it("fails closed when the adapter explicitly reports a fallback", () => {
    expect(() =>
      assertAdapterInfo(
        { architecture: "turing", isFallbackAdapter: true, vendor: "nvidia" },
        [],
        "benchmark",
      ),
    ).toThrow(/software adapter/i);
  });

  it("accepts a named hardware adapter as capture provenance", () => {
    expect(
      assertAdapterInfo(
        { architecture: "turing", vendor: "nvidia" },
        ["--enable-unsafe-webgpu"],
        "benchmark",
      ),
    ).toEqual({
      adapter: { architecture: "turing", vendor: "nvidia" },
      browserArgs: ["--enable-unsafe-webgpu"],
      captureMethod: "page.screenshot",
      rendererKind: "webgpu",
      target: "benchmark",
    });
  });

  it("reads adapter.info through the browser page before asserting provenance", async () => {
    let evaluations = 0;
    const page = {
      evaluate: async () => {
        evaluations += 1;
        return {
          adapter: { architecture: "turing", vendor: "nvidia" },
          rendererKind: "webgpu",
        };
      },
    } as never;

    await expect(assertWebGpuCaptureProvenance(page, [], "root browser")).resolves.toMatchObject({
      rendererKind: "webgpu",
    });
    expect(evaluations).toBe(1);
  });

  it("rejects adapter evidence when the canvas is WebGL or has no renderer context", async () => {
    for (const rendererKind of ["webgl", undefined] as const) {
      const page = {
        evaluate: async () => ({
          adapter: { architecture: "turing", vendor: "nvidia" },
          rendererKind,
        }),
      } as never;

      await expect(assertWebGpuCaptureProvenance(page, [], "root browser")).rejects.toThrow(
        /renderer kind/i,
      );
    }
  });

  it("boots deferred root pages before reading their WebGPU canvas", async () => {
    const calls: string[] = [];
    const page = {
      locator: () => ({
        click: async () => {
          calls.push("click");
        },
        count: async () => 1,
      }),
      waitForFunction: async () => {
        calls.push("context");
      },
      waitForSelector: async () => {
        calls.push("canvas");
      },
    } as never;

    await waitForWebGpuProjectReady(page);

    expect(calls).toEqual(["click", "canvas", "context"]);
  });
});

function paint(
  image: PNG,
  area: { bottom: number; left: number; right: number; top: number },
  [red, green, blue]: [number, number, number],
): void {
  for (let y = area.top; y < area.bottom; y += 1) {
    for (let x = area.left; x < area.right; x += 1) {
      const index = (y * image.width + x) * 4;
      image.data[index] = red;
      image.data[index + 1] = green;
      image.data[index + 2] = blue;
      image.data[index + 3] = 255;
    }
  }
}

describe("hot-reload project lock recovery", () => {
  it("recovers a lock whose recorded owner is dead and old", async () => {
    const root = await makeTempDir("playwright-hot-lock-stale-");
    const lockPath = path.join(root, "project.lock");
    const now = 100_000;
    await writeFile(lockPath, JSON.stringify({ pid: 41_001, startedAt: now - 10_000 }));

    const lease = await acquireHotReloadProjectLock({
      isProcessAlive: () => false,
      lockPath,
      now: () => now,
      pollMs: 1,
      pid: 41_002,
      staleAfterMs: 1_000,
      timeoutMs: 100,
    });
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toEqual({ pid: 41_002, startedAt: now });
    await lease.release();
  });

  it("waits for a live owner instead of taking its lock", async () => {
    const root = await makeTempDir("playwright-hot-lock-live-");
    const lockPath = path.join(root, "project.lock");
    const owner = { pid: 41_003, startedAt: Date.now() - 10_000 };
    await writeFile(lockPath, JSON.stringify(owner));

    await expect(
      acquireHotReloadProjectLock({
        isProcessAlive: (pid) => pid === owner.pid,
        lockPath,
        pollMs: 1,
        pid: 41_004,
        staleAfterMs: 1_000,
        timeoutMs: 20,
      }),
    ).rejects.toThrow(/timed out/i);
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toEqual(owner);
  });
});
