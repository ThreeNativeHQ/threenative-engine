import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";

test.setTimeout(120_000);

interface HotDiagnostics {
  reloads: number;
  entities: number;
  sceneObjects: number;
  canvases: number;
  audio: {
    paused: number;
    pooled: number;
    queued: number;
    unsupported: readonly string[];
    voices: number;
  };
  physics: number | null;
}

interface RuntimeSnapshot {
  diagnostics: HotDiagnostics;
  playerX: number;
  score: number;
  navigationEntries: number;
}

interface JumpObservation {
  flightTicks: number;
  peakRise: number;
}

const repoRoot = path.resolve(import.meta.dirname, "../..");
const hotReloadProjectFile = path.join(
  tmpdir(),
  `threenative-hot-reload-${path.basename(repoRoot)}.path`,
);
/**
 * The project the server is actually serving, read when the test runs rather than when this module
 * is imported. The config creates a fresh scaffold whenever the recorded one is missing or its
 * installed packages have moved, and writes the new path — so a value captured at import time can
 * name a previous run's directory. Editing a file in a project nobody is serving produces exactly
 * this spec's failure: a healthy game that hot-reloads zero times.
 */
async function resolveServedProject(): Promise<string | undefined> {
  const fromEnvironment = process.env.THREENATIVE_HOT_RELOAD_PROJECT;
  if (fromEnvironment !== undefined) return fromEnvironment;
  const shared = (await readFile(hotReloadProjectFile, "utf8").catch(() => "")).trim();
  return shared.length > 0 ? shared : undefined;
}

async function runtimeSnapshot(page: import("@playwright/test").Page): Promise<RuntimeSnapshot> {
  return page.evaluate(() => {
    const tools = (
      window as Window & {
        __THREENATIVE__?: {
          hot?: () => HotDiagnostics;
          snapshot?: () => Record<string, { position?: number[] }>;
        };
      }
    ).__THREENATIVE__;
    const diagnostics = tools?.hot?.();
    const player = tools?.snapshot?.().player?.position;
    const scoreLabel = [...document.querySelectorAll("div")].find(
      (element) => element.textContent?.trim() === "score",
    );
    if (diagnostics === undefined || player?.[0] === undefined)
      throw new Error("Hot reload diagnostics did not expose the player.");
    return {
      diagnostics,
      navigationEntries: performance.getEntriesByType("navigation").length,
      playerX: player[0],
      score: Number(scoreLabel?.nextElementSibling?.textContent ?? Number.NaN),
    };
  });
}

async function heapSize(page: import("@playwright/test").Page): Promise<number> {
  const client = await page.context().newCDPSession(page);
  await client.send("Performance.enable");
  await client.send("HeapProfiler.collectGarbage");
  const metrics = await client.send("Performance.getMetrics");
  const heap = metrics.metrics.find(({ name }) => name === "JSHeapUsedSize")?.value;
  if (heap === undefined || !Number.isFinite(heap))
    throw new Error("JSHeapUsedSize was not reported.");
  return heap;
}

async function advanceFixedTicks(
  page: import("@playwright/test").Page,
  ticks: number,
): Promise<void> {
  await page.evaluate(async (tickCount) => {
    const advance = (
      window as Window & {
        __THREENATIVE_PLAYTEST_BRIDGE__?: { advance?: (ticks: number) => Promise<unknown> };
      }
    ).__THREENATIVE_PLAYTEST_BRIDGE__?.advance;
    if (advance === undefined) throw new Error("Fixed-step playtest bridge was not observable.");
    await advance(tickCount);
  }, ticks);
}

async function waitForGrounded(page: import("@playwright/test").Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const player = (
        window as Window & {
          __THREENATIVE__?: { snapshot?: () => Record<string, { grounded?: boolean }> };
        }
      ).__THREENATIVE__?.snapshot?.().player;
      return player?.grounded === true;
    },
    undefined,
    // Ninety seconds, not ten: GitHub's runners serve WebGPU from SwiftShader, and a CPU
    // rasteriser renders the frames this landing depends on one to two orders of magnitude slower.
    { timeout: 90_000 },
  );
}

/**
 * What the game was actually doing when the landing never came. A timeout that reports only its
 * own duration cannot be diagnosed from a CI log — the frame is in a temp directory and the runner
 * is not a machine anyone can log into — and 90 seconds elapsing says the player is not merely
 * slow. This reads the same snapshot the wait polls, so the failure names the state it saw.
 */
async function describePlayerState(page: import("@playwright/test").Page): Promise<string> {
  return page
    .evaluate(() => {
      const tools = (
        window as Window & {
          __THREENATIVE__?: {
            hot?: () => unknown;
            snapshot?: () => Record<string, unknown>;
          };
        }
      ).__THREENATIVE__;
      if (tools === undefined) return "window.__THREENATIVE__ is absent";
      let diagnostics: unknown;
      try {
        diagnostics = tools.hot?.();
      } catch (error) {
        diagnostics = `hot() threw: ${String(error)}`;
      }
      let snapshot: Record<string, unknown> | string;
      try {
        snapshot = tools.snapshot?.() ?? "snapshot() returned nothing";
      } catch (error) {
        snapshot = `snapshot() threw: ${String(error)}`;
      }
      const entities = typeof snapshot === "string" ? [] : Object.keys(snapshot);
      const player = typeof snapshot === "string" ? undefined : snapshot.player;
      return JSON.stringify({ diagnostics, entities, player });
    })
    .catch((error: unknown) => `the page could not be read: ${String(error)}`);
}

async function jumpObservation(page: import("@playwright/test").Page): Promise<JumpObservation> {
  await waitForGrounded(page);
  await page.evaluate(async () => {
    const advance = (
      window as Window & {
        __THREENATIVE_PLAYTEST_BRIDGE__?: { advance?: (ticks: number) => Promise<unknown> };
      }
    ).__THREENATIVE_PLAYTEST_BRIDGE__?.advance;
    if (advance === undefined) throw new Error("Fixed-step playtest bridge was not observable.");
    await advance(1);
  });
  await page.keyboard.down("Space");
  try {
    return await page.evaluate(async () => {
      type PlayerSnapshot = { grounded?: boolean; position?: number[] };
      const host = window as Window & {
        __THREENATIVE__?: { snapshot?: () => Record<string, PlayerSnapshot> };
        __THREENATIVE_PLAYTEST_BRIDGE__?: {
          advance?: (ticks: number) => Promise<unknown>;
        };
      };
      const snapshot = host.__THREENATIVE__?.snapshot;
      const advance = host.__THREENATIVE_PLAYTEST_BRIDGE__?.advance;
      if (snapshot === undefined || advance === undefined) {
        throw new Error("Fixed-step playtest bridge was not observable.");
      }
      const player = (): { grounded: boolean; y: number } => {
        const state = snapshot().player;
        const y = state?.position?.[1];
        if (state?.grounded === undefined || y === undefined) {
          throw new Error("Player grounded state and Y were not observable.");
        }
        return { grounded: state.grounded, y };
      };
      const start = player();
      if (!start.grounded) throw new Error("Player was not grounded before the jump.");
      let peakY = start.y;
      let airborneTicks = 0;
      for (let tick = 1; tick <= 120; tick += 1) {
        await advance(1);
        const current = player();
        peakY = Math.max(peakY, current.y);
        if (!current.grounded) {
          airborneTicks += 1;
          continue;
        }
        if (airborneTicks > 0) {
          return {
            flightTicks: tick,
            peakRise: peakY - start.y,
          };
        }
      }
      throw new Error("Player did not complete a fixed-step jump arc.");
    });
  } finally {
    await page.keyboard.up("Space");
  }
}

async function waitForHotReload(
  page: import("@playwright/test").Page,
  expected: number,
): Promise<void> {
  // Each HMR round trip is vite rebuilding the module, the page re-running it, and the game
  // rebuilding its scene — then this waits for the player to be grounded again, which needs
  // rendered frames. Fifteen seconds is a machine with a GPU; CI serves WebGPU from SwiftShader
  // and does all of that an order of magnitude slower, ten times over.
  //
  // `>=`, not `===`. One write does not always produce exactly one reload: vite can see a single
  // save twice and rebuild twice. An equality poll then waits for a number the counter has
  // already passed and burns the full 90 seconds on a page that reloaded correctly —
  //   Error: HMR reload 7 was not observed within 90 seconds: {"diagnostics":{"reloads":8,...}}
  // which is a green run reported as a red one.
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const ready = await page
      .evaluate((reloads) => {
        try {
          const tools = (
            window as Window & {
              __THREENATIVE__?: {
                hot?: () => HotDiagnostics;
                snapshot?: () => Record<string, { grounded?: boolean; position?: number[] }>;
              };
            }
          ).__THREENATIVE__;
          const diagnostics = tools?.hot?.();
          const player = tools?.snapshot?.().player;
          // The updated game boots again, and its HUD reads nothing until that startup's cover
          // lifts (PRD-748): the score is back on screen only then.
          const scoreLabel = [...document.querySelectorAll("div")].find(
            (element) => element.textContent?.trim() === "score",
          );
          return (
            scoreLabel?.nextElementSibling !== null &&
            scoreLabel?.nextElementSibling !== undefined &&
            diagnostics !== undefined &&
            diagnostics.reloads >= reloads &&
            diagnostics.canvases === 1 &&
            diagnostics.physics !== null &&
            player?.position?.[0] !== undefined &&
            player.grounded === true
          );
        } catch {
          return false;
        }
      }, expected)
      .catch(() => false);
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `HMR reload ${expected} was not observed within 90 seconds: ${await describePlayerState(page)}`,
  );
}

test.afterAll(async () => {
  await rm(hotReloadProjectFile, { force: true });
});

test("preserves starter state and stays flat across ten real HMR updates", async ({ page }) => {
  const project = await resolveServedProject();
  if (project === undefined) throw new Error("THREENATIVE_HOT_RELOAD_PROJECT was not exported.");
  // An edit only reaches the running game if this is the directory the dev server is serving. A
  // missing entry point here means the recorded path is another run's, and that is worth failing
  // on by name rather than discovering as a reload that never arrives.
  const entryPoint = path.join(project, "src/entities/Player.ts");
  if (!existsSync(entryPoint))
    throw new Error(
      `the recorded hot-reload project has no ${entryPoint}; it is not the served one.`,
    );
  const errors: string[] = [];
  const expectedWebGpuBackendErrors = [
    "Instance dropped in popErrorScope",
    /Failed to execute 'createBuffer' on 'GPUDevice': createBuffer failed, size \(\d+\) is too large for the implementation when mappedAtCreation == true/u,
    // A hot update disposes the renderer while three.js still has a timestamp-query readback in
    // flight, and the pending mapAsync rejects because the buffer it was mapping went away. That
    // is what tearing a scene down mid-frame looks like from the backend, and it is the same class
    // as the two above: noise from the layer underneath, not a fault in the reload this test is
    // proving. It only became visible once the reload started working at all.
    /Error resolving queries: AbortError: Failed to execute 'mapAsync' on 'GPUBuffer': Buffer was unmapped before mapping was resolved/u,
  ] as const;
  const isExpectedWebGpuBackendError = (message: string): boolean =>
    expectedWebGpuBackendErrors.some((expected) =>
      typeof expected === "string" ? expected === message : expected.test(message),
    );
  page.on("console", (entry) => {
    if (entry.type() === "error" && !isExpectedWebGpuBackendError(entry.text())) {
      errors.push(entry.text());
    }
  });
  page.on("pageerror", (error) => {
    if (!isExpectedWebGpuBackendError(error.message)) errors.push(error.message);
  });
  // The page-thread entry; the config's baseURL says why.
  await page.goto("/main.html");
  await page.waitForFunction(() => {
    try {
      const diagnostics = (
        window as Window & { __THREENATIVE__?: { hot?: () => HotDiagnostics } }
      ).__THREENATIVE__?.hot?.();
      return diagnostics?.canvases === 1 && diagnostics.physics !== null;
    } catch {
      return false;
    }
  });

  // The starter boots straight into play (`start: "play"` in game.ts, since 739f2436), so there
  // is no name to type and no `begin` to click — this waited 120 s for a placeholder that the
  // menu deletion removed. Wait for the play scene's entities instead, which is what the menu
  // steps were really establishing. Nothing here waits on a renderer, which is why it works on
  // a CPU rasteriser.
  await page.waitForFunction(() => {
    const tools = (window as Window & { __THREENATIVE__?: { hot?: () => { entities: number } } })
      .__THREENATIVE__;
    try {
      return (tools?.hot?.().entities ?? 0) > 0;
    } catch {
      return false;
    }
  });
  try {
    await waitForGrounded(page);
  } catch (error) {
    throw new Error(
      `the player never became grounded: ${await describePlayerState(page)}\n${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  await page.keyboard.down("ArrowRight");
  try {
    await advanceFixedTicks(page, 150);
    await page.waitForFunction(
      () => {
        const scoreLabel = [...document.querySelectorAll("div")].find(
          (element) => element.textContent?.trim() === "score",
        );
        return Number(scoreLabel?.nextElementSibling?.textContent ?? Number.NaN) > 0;
      },
      undefined,
      { timeout: 12_000 },
    );
  } finally {
    await page.keyboard.up("ArrowRight");
  }
  const before = await runtimeSnapshot(page);
  expect(before.score).toBeGreaterThan(0);
  const jumpBefore = await jumpObservation(page);
  expect(jumpBefore.peakRise).toBeGreaterThan(0.5);
  const heapBefore = await heapSize(page);
  const playerFile = path.join(project, "src/entities/Player.ts");
  const original = await readFile(playerFile, "utf8");
  const jumpPattern = /const JUMP_SPEED = (?<expression>[^;]+);/u;
  const jumpExpression = original.match(jumpPattern)?.groups?.expression;
  if (jumpExpression === undefined) throw new Error("Starter jump constant was not found.");

  try {
    // Count what the page reports rather than assuming one reload per write, for the same reason
    // the wait uses `>=`: vite can rebuild twice for a single save. What this has to prove is that
    // every edit reached the running game and that the scene stayed flat across all ten — not that
    // vite's rebuild count matched the loop counter.
    let observedReloads = 0;
    for (let reload = 1; reload <= 10; reload += 1) {
      await writeFile(
        playerFile,
        original.replace(
          jumpPattern,
          `const JUMP_SPEED = (${jumpExpression}) + (Number.isFinite(${reload}) ? 0 : 1);`,
        ),
      );
      await waitForHotReload(page, observedReloads + 1);
      const after = await runtimeSnapshot(page);
      expect(
        after.diagnostics.reloads,
        `edit ${reload} did not reach the running game`,
      ).toBeGreaterThan(observedReloads);
      observedReloads = after.diagnostics.reloads;
      expect(after.diagnostics.canvases).toBe(1);
      expect(after.diagnostics.sceneObjects).toBe(before.diagnostics.sceneObjects);
      expect(after.diagnostics.entities).toBe(before.diagnostics.entities);
      expect(after.diagnostics.physics).toBe(before.diagnostics.physics);
      expect(after.diagnostics.audio).toEqual({
        cues: {},
        paused: 0,
        pooled: 0,
        queued: 0,
        recentCues: [],
        unsupported: [],
        voices: 0,
      });
      expect(after.score).toBeGreaterThanOrEqual(before.score);
      expect(Math.abs(after.playerX - before.playerX)).toBeLessThan(0.25);
    }
    const after = await runtimeSnapshot(page);
    // `>=`, for the reason the loop above already counts observed reloads instead of assuming one
    // per save: vite can rebuild twice for a single write, and on 2026-09-03 it did — run
    // 33775501232 failed here with `Expected: 10, Received: 11` while every edit had reached the
    // running game and every flatness assertion in the loop had passed. Asserting vite's rebuild
    // count is asserting something this test was explicitly rewritten not to depend on. What has
    // to hold is that all ten edits landed, and the loop proves that per iteration with
    // `toBeGreaterThan(observedReloads)`.
    expect(after.diagnostics.reloads).toBeGreaterThanOrEqual(10);
    expect(after.navigationEntries).toBe(1);
    const jumpAfter = await jumpObservation(page);
    expect(jumpAfter.flightTicks).toBe(jumpBefore.flightTicks);
    expect(jumpAfter.peakRise).toBeCloseTo(jumpBefore.peakRise, 5);
    expect(await heapSize(page)).toBeLessThanOrEqual(
      Math.max(heapBefore * 1.5, heapBefore + 10_000_000),
    );
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    await writeFile(playerFile, original);
  }
});
