import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { PNG } from "pngjs";

import type { IPlaytestObservationSnapshot, IPlaytestScenario } from "../src/index.js";
import { sampleElementVisibility, sampleHud } from "../src/runner/sampling.js";
import {
  entityRotation,
  isRuntimeReadout,
  movementDuration,
  movementRate,
  normalizedRuntimeDiagnostics,
  observedMovementEntities,
  observedMovementSample,
  pairObservations,
  positiveFiniteDelta,
  readCaptureProvenance,
  resourceObservations,
} from "../src/runner/observationSampling.js";
import type { IMovementSampleInterval } from "../src/runner/shared.js";

function snapshot(
  position: [number, number, number] | undefined,
  clock: IPlaytestObservationSnapshot["clock"] = { mode: "fixed-step", tick: 0 },
  extra: Partial<IPlaytestObservationSnapshot> = {},
): IPlaytestObservationSnapshot {
  return {
    clock,
    entities: [{ id: "player", transform: position === undefined ? undefined : { position, rotation: [0, 0, 0, 1] }, visible: true }],
    ...extra,
  };
}

function interval(
  before: IPlaytestObservationSnapshot,
  after: IPlaytestObservationSnapshot,
  inputDriven: boolean,
): IMovementSampleInterval {
  return { after, before, inputDriven };
}

function installGlobal(name: string, value: unknown): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, value, writable: true });
  return () => {
    if (descriptor === undefined) delete (globalThis as Record<string, unknown>)[name];
    else Object.defineProperty(globalThis, name, descriptor);
  };
}

function installVisibilitySamplingMock(
  target: unknown,
  topmost: (pointerEventsForced: boolean) => unknown,
): { restore: () => void; restoreWindow: () => void } {
  let forcedPointerEvents = false;
  let isolationActive = false;
  let styleCount = 0;
  const pointerEventsStyle = { remove: () => { forcedPointerEvents = false; } };
  const isolationStyle = { remove: () => { isolationActive = false; } };
  const probe = {
    remove: () => undefined,
    removeAttribute: () => undefined,
    setAttribute: () => undefined,
  };
  const restore = installGlobal("document", {
    createElement: (tagName: string) => {
      if (tagName === "style") return styleCount++ === 0 ? pointerEventsStyle : isolationStyle;
      return probe;
    },
    elementFromPoint: () => topmost(forcedPointerEvents),
    getElementById: () => target,
    head: {
      appendChild: (element: unknown) => {
        if (element === pointerEventsStyle) forcedPointerEvents = true;
        if (element === isolationStyle) isolationActive = true;
      },
    },
  });
  const restoreWindow = installGlobal("window", {
    getComputedStyle: (element: unknown) => ({
      display: "block",
      opacity: "1",
      visibility: element === probe && isolationActive ? "hidden" : "visible",
    }),
    innerHeight: 720,
    innerWidth: 1280,
  });
  return { restore, restoreWindow };
}

function brightScreenshot(): Buffer {
  const png = new PNG({ height: 4, width: 4 });
  png.data.fill(255);
  return PNG.sync.write(png);
}

function targetPaintScreenshot(hidden: boolean): Buffer {
  const png = new PNG({ height: 4, width: 4 });
  png.data.fill(255);
  if (!hidden) {
    png.data[0] = 0;
    png.data[1] = 0;
    png.data[2] = 0;
  }
  return PNG.sync.write(png);
}

function changingBackgroundScreenshot(value: number): Buffer {
  const png = new PNG({ height: 4, width: 4 });
  for (let offset = 0; offset < png.data.length; offset += 4) {
    png.data[offset] = value;
    png.data[offset + 1] = value;
    png.data[offset + 2] = value;
    png.data[offset + 3] = 255;
  }
  return PNG.sync.write(png);
}

function transparentScreenshot(): Buffer {
  const png = new PNG({ height: 4, width: 4 });
  png.data.fill(0);
  return PNG.sync.write(png);
}

const visibilityFixtureClip = { height: 80, width: 80, x: 0, y: 0 };

async function installVisibilityFixture(page: Page, options: { csp: boolean; paintedTarget: boolean }): Promise<void> {
  const csp = options.csp
    ? `<meta http-equiv="Content-Security-Policy" content="style-src 'nonce-allowed'">`
    : "";
  const nonce = options.csp ? ` nonce="allowed"` : "";
  const paintedTarget = options.paintedTarget ? `<span id="target-paint"></span>` : "";
  await page.setContent(`<!doctype html>${csp}
    <style${nonce}>
      html, body { margin: 0; padding: 0; }
      #background { position: absolute; inset: 0; }
      #target { position: absolute; left: 0; top: 0; width: 80px; height: 80px; z-index: 1; }
      #target-paint { display: block; width: 40px; height: 80px; background: rgb(240, 40, 40); }
    </style>
    <canvas id="background" width="160" height="120"></canvas>
    <div id="target">${paintedTarget}</div>`);
  await page.evaluate(() => {
    const canvas = document.getElementById("background") as HTMLCanvasElement | null;
    const context = canvas?.getContext("2d");
    if (canvas === null || context === null || context === undefined) throw new Error("visibility fixture has no 2D context");
    context.fillStyle = "rgb(17, 34, 51)";
    context.fillRect(0, 0, canvas.width, canvas.height);
  });
}

async function installImportantNonTargetFixture(page: Page): Promise<void> {
  await page.setContent(`<!doctype html>
    <style>
      html, body { margin: 0; padding: 0; }
      #background { position: absolute; inset: 0; }
      #target { position: absolute; left: 0; top: 0; width: 80px; height: 80px; z-index: 1; }
      #control {
        position: absolute;
        left: 0;
        top: 0;
        width: 20px;
        height: 80px;
        z-index: 2;
        background: rgb(240, 40, 40);
        visibility: visible !important;
      }
    </style>
    <canvas id="background" width="160" height="120"></canvas>
    <div id="target"></div>
    <div id="control" style="outline: 1px solid rgb(1, 2, 3);"></div>`);
  await page.evaluate(() => {
    const canvas = document.getElementById("background") as HTMLCanvasElement | null;
    const context = canvas?.getContext("2d");
    if (canvas === null || context === null || context === undefined) throw new Error("visibility fixture has no 2D context");
    context.fillStyle = "rgb(17, 34, 51)";
    context.fillRect(0, 0, canvas.width, canvas.height);
  });
}

async function installFlexVisibilityFixture(page: Page): Promise<void> {
  await page.setContent(`<!doctype html>
    <style>
      html, body { width: 160px; height: 120px; margin: 0; padding: 0; }
      body { display: flex; align-items: flex-start; justify-content: flex-end; }
      #target { flex: 0 0 80px; width: 80px; height: 80px; }
      #target-paint { display: block; width: 80px; height: 80px; background: rgb(240, 40, 40); }
      body > span { flex: 0 0 80px; width: 80px; height: 80px; }
    </style>
    <div id="target"><span id="target-paint"></span></div>`);
}

function pngPixel(screenshot: Buffer, x: number, y: number): [number, number, number, number] {
  const png = PNG.sync.read(screenshot);
  const offset = (y * png.width + x) * 4;
  return [png.data[offset] ?? 0, png.data[offset + 1] ?? 0, png.data[offset + 2] ?? 0, png.data[offset + 3] ?? 0];
}

async function captureVisibilityScreenshots(
  page: Page,
  onScreenshotPending?: () => Promise<void>,
): Promise<{ page: Page; screenshotOptions: Array<Parameters<Page["screenshot"]>[0]>; screenshots: Buffer[] }> {
  const screenshots: Buffer[] = [];
  const screenshotOptions: Array<Parameters<Page["screenshot"]>[0]> = [];
  const observedPage = new Proxy(page, {
    get(target, property) {
      if (property === "screenshot") {
        return async (options: Parameters<Page["screenshot"]>[0]) => {
          screenshotOptions.push(options);
          const screenshotPromise = target.screenshot(options);
          await onScreenshotPending?.();
          const screenshot = await screenshotPromise;
          screenshots.push(screenshot);
          return screenshot;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Page;
  return { page: observedPage, screenshotOptions, screenshots };
}

function capturedScreenshot(
  observed: Awaited<ReturnType<typeof captureVisibilityScreenshots>>,
  index = 0,
): Buffer {
  const screenshot = observed.screenshots[index];
  if (screenshot === undefined) throw new Error(`missing captured screenshot ${index}`);
  return screenshot;
}

async function temporaryVisibilityArtifacts(page: Page): Promise<{ markers: number; styles: number }> {
  return page.evaluate(() => {
    const elements = [...document.querySelectorAll("*")];
    return {
      markers: elements.filter((element) => element.getAttributeNames().some((name) => name.startsWith("data-threenative-visibility-"))).length,
      styles: [...document.querySelectorAll("style")].filter((style) => style.textContent?.includes("threenativePlaytestVisibilityIsolation") === true).length,
    };
  });
}

async function expectPendingVisibilityMutationToReject(page: Page, mutate: () => Promise<void>): Promise<void> {
  const observed = await captureVisibilityScreenshots(page, mutate);
  await expect(sampleElementVisibility(observed.page, { id: "target" })).rejects.toMatchObject({
    diagnostic: { code: "TN_PLAYTEST_OBSERVATION_UNAVAILABLE" },
  });
  expect(observed.screenshots).toHaveLength(1);
  await expect(temporaryVisibilityArtifacts(page)).resolves.toEqual({ markers: 0, styles: 0 });
}

function writeIsolationOwnedSameValue({ property, targetName }: { property: string; targetName: string }): void {
  const target = targetName === "control" ? document.getElementById("control") : document.documentElement;
  if (target === null) throw new Error("visibility fixture has no direct-setter target");
  const style = (target as HTMLElement).style as unknown as Record<string, string>;
  const propertyName = property === "background-color"
    ? "backgroundColor"
    : property === "background-image" ? "backgroundImage" : "visibility";
  style[propertyName] = style[propertyName] ?? "";
}

describe("playtest sampling", () => {
  test("samples HUD values by id and selector without dropping absent nodes", async () => {
    const score = { getAttribute: () => "7", textContent: " Score " };
    const button = { getAttribute: () => "not numeric", textContent: " Start " };
    const restore = installGlobal("document", {
      getElementById: (id: string) => id === "score" ? score : null,
      querySelector: (selector: string) => selector === ".start" ? button : null,
    });
    try {
      const page = {
        evaluate: async (callback: (assertions: unknown) => unknown, assertions: unknown) => callback(assertions),
      } as unknown as Page;
      await expect(sampleHud(page, [])).resolves.toEqual({});
      await expect(sampleHud(page, [{ id: "score" }, { id: "start", path: ".start" }, { id: "missing" }])).resolves.toEqual({
        score: 7,
        start: { ".start": "not numeric" },
      });
    } finally {
      restore();
    }
  });

  test("samples a HUD node only when its rendered box is on top of the page", async () => {
    let targetHidden = false;
    const error = {
      contains: () => false,
      getAttribute: () => null,
      getBoundingClientRect: () => ({ bottom: 720, height: 720, left: 0, right: 1280, top: 0, width: 1280 }),
      parentElement: null,
      removeAttribute: (name: string) => {
        if (name === "style") targetHidden = false;
      },
      setAttribute: () => undefined,
      style: {
        setProperty: (name: string, value: string) => {
          if (name === "opacity" && value === "0") targetHidden = true;
        },
      },
      textContent: " TN_TEST: boot failed ",
    };
    const { restore, restoreWindow } = installVisibilitySamplingMock(error, () => error);
    try {
      const page = {
        evaluate: async (callback: (assertions: unknown) => unknown, assertions: unknown) => callback(assertions),
        screenshot: async () => targetPaintScreenshot(targetHidden),
      } as unknown as Page;
      await expect(sampleHud(page, [{ id: "error", textIncludes: "TN_TEST", visible: true }])).resolves.toEqual({
        error: { text: "TN_TEST: boot failed", visible: true },
      });
    } finally {
      restoreWindow();
      restore();
    }
  });

  test("fails closed for invalid selectors, zero-sized boxes, and fully offscreen boxes", async () => {
    const page = {
      evaluate: async (callback: (argument: unknown) => unknown, argument: unknown) => callback(argument),
    } as unknown as Page;
    const restoreInvalidSelectorDocument = installGlobal("document", {
      querySelector: () => {
        throw new Error("invalid selector");
      },
    });
    try {
      await expect(sampleElementVisibility(page, { selector: "[" })).resolves.toEqual({ rendered: false });
    } finally {
      restoreInvalidSelectorDocument();
    }

    const zeroSizedNode = { getBoundingClientRect: () => ({ bottom: 10, height: 0, left: 0, right: 10, top: 0, width: 10 }) };
    const restoreZeroDocument = installGlobal("document", { getElementById: () => zeroSizedNode });
    try {
      await expect(sampleElementVisibility(page, { id: "zero" })).resolves.toEqual({ rendered: false });
    } finally {
      restoreZeroDocument();
    }

    const offscreenNode = { getBoundingClientRect: () => ({ bottom: 20, height: 20, left: 200, right: 220, top: 0, width: 20 }), parentElement: null };
    const restoreOffscreenDocument = installGlobal("document", { getElementById: () => offscreenNode });
    const restoreOffscreenWindow = installGlobal("window", {
      getComputedStyle: () => ({ display: "block", opacity: "1", visibility: "visible" }),
      innerHeight: 100,
      innerWidth: 100,
    });
    try {
      await expect(sampleElementVisibility(page, { id: "offscreen" })).resolves.toEqual({
        bounds: { height: 20, width: 20, x: 200, y: 0 },
        rendered: false,
      });
    } finally {
      restoreOffscreenWindow();
      restoreOffscreenDocument();
    }
  });

  test("samples painted HUD content when the node is noninteractive", async () => {
    const canvas = {};
    let targetHidden = false;
    const error = {
      contains: () => false,
      getAttribute: () => null,
      getBoundingClientRect: () => ({ bottom: 80, height: 80, left: 0, right: 200, top: 0, width: 200 }),
      parentElement: null,
      removeAttribute: (name: string) => {
        if (name === "style") targetHidden = false;
      },
      setAttribute: () => undefined,
      style: {
        setProperty: (name: string, value: string) => {
          if (name === "opacity" && value === "0") targetHidden = true;
        },
      },
      textContent: " TN_TEST: visible ",
    };
    const { restore, restoreWindow } = installVisibilitySamplingMock(error, (forcedPointerEvents) => forcedPointerEvents ? error : canvas);
    try {
      const page = {
        evaluate: async (callback: (assertions: unknown) => unknown, assertions: unknown) => callback(assertions),
        screenshot: async () => targetPaintScreenshot(targetHidden),
      } as unknown as Page;
      await expect(sampleHud(page, [{ id: "error", visible: true }])).resolves.toEqual({
        error: { text: "TN_TEST: visible", visible: true },
      });
    } finally {
      restoreWindow();
      restore();
    }
  });

  test("rejects transparent content over a light page background when the target adds no paint", async () => {
    const canvas = {};
    let targetHidden = false;
    const target = {
      contains: () => false,
      getAttribute: () => null,
      getBoundingClientRect: () => ({ bottom: 80, height: 80, left: 0, right: 200, top: 0, width: 200 }),
      parentElement: null,
      removeAttribute: (name: string) => {
        if (name === "style") targetHidden = false;
      },
      setAttribute: () => undefined,
      style: {
        setProperty: (name: string, value: string) => {
          if (name === "opacity" && value === "0") targetHidden = true;
        },
      },
    };
    const { restore, restoreWindow } = installVisibilitySamplingMock(target, (forcedPointerEvents) => forcedPointerEvents ? target : canvas);
    const clips: unknown[] = [];
    try {
      const page = {
        evaluate: async (callback: (argument: unknown) => unknown, argument: unknown) => callback(argument),
        screenshot: async (options?: { clip?: unknown; omitBackground?: boolean }) => {
          clips.push(options?.clip);
          return options?.omitBackground === true ? transparentScreenshot() : brightScreenshot();
        },
      } as unknown as Page;
      await expect(sampleElementVisibility(page, { id: "transparent" })).resolves.toEqual({
        bounds: { height: 80, width: 200, x: 0, y: 0 },
        rendered: false,
      });
      expect(clips).toHaveLength(1);
      expect(targetHidden).toBe(false);
    } finally {
      restoreWindow();
      restore();
    }
  });

  test("rejects a transparent target when only the background changes between captures", async () => {
    const canvas = {};
    let targetHidden = false;
    let styleAttribute: string | null = "color: red; opacity: 0.5;";
    const target = {
      contains: () => false,
      getAttribute: (name: string) => name === "style" ? styleAttribute : null,
      getBoundingClientRect: () => ({ bottom: 80, height: 80, left: 0, right: 200, top: 0, width: 200 }),
      parentElement: null,
      removeAttribute: (name: string) => {
        if (name === "style") styleAttribute = null;
      },
      setAttribute: (name: string, value: string) => {
        if (name === "style") styleAttribute = value;
      },
      style: {
        setProperty: (name: string, value: string) => {
          if (name === "opacity" && value === "0") targetHidden = true;
        },
      },
    };
    const { restore, restoreWindow } = installVisibilitySamplingMock(target, (forcedPointerEvents) => forcedPointerEvents ? target : canvas);
    const clips: unknown[] = [];
    const screenshotOptions: Array<{ clip?: unknown; omitBackground?: boolean }> = [];
    let screenshotCount = 0;
    try {
      const page = {
        evaluate: async (callback: (argument: unknown) => unknown, argument: unknown) => callback(argument),
        screenshot: async (options?: { clip?: unknown; omitBackground?: boolean }) => {
          clips.push(options?.clip);
          screenshotOptions.push(options ?? {});
          screenshotCount += 1;
          return options?.omitBackground === true
            ? transparentScreenshot()
            : changingBackgroundScreenshot(screenshotCount === 1 ? 32 : 224);
        },
      } as unknown as Page;
      await expect(sampleElementVisibility(page, { id: "transparent" })).resolves.toEqual({
        bounds: { height: 80, width: 200, x: 0, y: 0 },
        rendered: false,
      });
      expect(clips).toHaveLength(1);
      expect(screenshotOptions).toEqual([{ clip: { height: 80, width: 200, x: 0, y: 0 }, omitBackground: true }]);
      expect(targetHidden).toBe(false);
      expect(styleAttribute).toBe("color: red; opacity: 0.5;");
    } finally {
      restoreWindow();
      restore();
    }
  });

  test("rejects HUD content hidden by an opaque noninteractive overlay", async () => {
    const error = {
      contains: () => false,
      getAttribute: () => null,
      getBoundingClientRect: () => ({ bottom: 720, height: 720, left: 0, right: 1280, top: 0, width: 1280 }),
      parentElement: null,
      textContent: " TN_TEST: boot failed ",
    };
    const overlay = {};
    let forcedPointerEvents = false;
    const pointerEventsStyle = { remove: () => { forcedPointerEvents = false; } };
    const restore = installGlobal("document", {
      createElement: () => pointerEventsStyle,
      elementFromPoint: () => forcedPointerEvents ? overlay : error,
      getElementById: () => error,
      head: { appendChild: () => { forcedPointerEvents = true; } },
    });
    const restoreWindow = installGlobal("window", {
      getComputedStyle: () => ({ display: "block", opacity: "1", visibility: "visible" }),
      innerHeight: 720,
      innerWidth: 1280,
    });
    try {
      const page = {
        evaluate: async (callback: (assertions: unknown) => unknown, assertions: unknown) => callback(assertions),
        screenshot: async () => brightScreenshot(),
      } as unknown as Page;
      await expect(sampleHud(page, [{ id: "error", visible: true }])).resolves.toEqual({
        error: { text: "TN_TEST: boot failed", visible: false },
      });
    } finally {
      restoreWindow();
      restore();
    }
  });

  test("rejects a HUD node with zero computed opacity even when its box is topmost", async () => {
    const error = {
      contains: () => false,
      getAttribute: () => null,
      getBoundingClientRect: () => ({ bottom: 80, height: 80, left: 0, right: 200, top: 0, width: 200 }),
      textContent: " TN_TEST: transparent ",
    };
    const restore = installGlobal("document", {
      elementFromPoint: () => error,
      getElementById: () => error,
    });
    const restoreWindow = installGlobal("window", {
      getComputedStyle: () => ({ display: "block", opacity: "0", visibility: "visible" }),
      innerHeight: 720,
      innerWidth: 1280,
    });
    try {
      const page = {
        evaluate: async (callback: (assertions: unknown) => unknown, assertions: unknown) => callback(assertions),
      } as unknown as Page;
      await expect(sampleHud(page, [{ id: "error", visible: true }])).resolves.toEqual({
        error: { text: "TN_TEST: transparent", visible: false },
      });
    } finally {
      restoreWindow();
      restore();
    }
  });

  test("rejects a HUD node whose rendered ancestry is display none", async () => {
    const parent = { parentElement: null };
    const error = {
      contains: () => false,
      getAttribute: () => null,
      getBoundingClientRect: () => ({ bottom: 80, height: 80, left: 0, right: 200, top: 0, width: 200 }),
      parentElement: parent,
      textContent: " TN_TEST: hidden ",
    };
    const restore = installGlobal("document", {
      elementFromPoint: () => error,
      getElementById: () => error,
    });
    const restoreWindow = installGlobal("window", {
      getComputedStyle: (element: unknown) => element === parent
        ? { display: "none", opacity: "1", visibility: "visible" }
        : { display: "block", opacity: "1", visibility: "visible" },
      innerHeight: 720,
      innerWidth: 1280,
    });
    try {
      const page = {
        evaluate: async (callback: (assertions: unknown) => unknown, assertions: unknown) => callback(assertions),
      } as unknown as Page;
      await expect(sampleHud(page, [{ id: "error", visible: true }])).resolves.toEqual({
        error: { text: "TN_TEST: hidden", visible: false },
      });
    } finally {
      restoreWindow();
      restore();
    }
  });

  test("pairs observations and retains only movement with a stationary input-off baseline", () => {
    expect(pairObservations({ score: 1, beforeOnly: true }, { score: 2, afterOnly: true })).toEqual({
      score: { after: 2, before: 1 },
      beforeOnly: { before: true },
      afterOnly: { after: true },
    });

    const stationary = interval(
      snapshot([0, 0, 0], { mode: "fixed-step", tick: 0 }),
      snapshot([0, 0, 0], { mode: "fixed-step", tick: 1 }),
      false,
    );
    const moved = interval(
      snapshot([0, 0, 0], { mode: "fixed-step", tick: 1 }),
      snapshot([2, 0, 0], { mode: "fixed-step", tick: 3 }),
      true,
    );
    expect(observedMovementSample([stationary, moved])).toMatchObject({ distance: 2, entity: "player", contrast: 1 });
    expect(observedMovementSample([moved])).toBeUndefined();
    expect(observedMovementSample([
      interval(snapshot(undefined), snapshot([1, 0, 0]), true),
      stationary,
    ])).toBeUndefined();
  });

  test("filters entity movement and computes rates across clock modes", () => {
    const before = snapshot([0, 0, 0], { mode: "fixed-step", tick: 0 }, {
      entities: [
        { id: "player", transform: { position: [0, 0, 0] }, visible: true },
        { id: "hidden", transform: { position: [0, 0, 0] }, visible: false },
        { id: "missing", visible: true },
      ],
    });
    const after = snapshot([1, 0, 0], { mode: "fixed-step", tick: 2 }, {
      entities: [
        { id: "player", transform: { position: [1, 0, 0] }, visible: true },
        { id: "hidden", transform: { position: [1, 0, 0] }, visible: false },
        { id: "new", transform: { position: [1, 0, 0] }, visible: true },
      ],
    });
    expect(observedMovementEntities(before, after)).toEqual([{ distance: 1, id: "player" }]);
    expect(movementRate(interval(before, after, true), "player")).toBe(0.5);
    expect(movementRate(interval(before, after, true), "new")).toBeUndefined();
    expect(movementDuration(interval(before, after, true))).toBe(2);
    expect(movementDuration(interval(
      snapshot([0, 0, 0], { mode: "render-frame", timeMs: 10 }),
      snapshot([0, 0, 0], { mode: "render-frame", timeMs: 30 }),
      true,
    ))).toBe(20);
    expect(movementDuration(interval(
      snapshot([0, 0, 0], { mode: "wall-clock", timeMs: 10 }),
      snapshot([0, 0, 0], { mode: "wall-clock", timeMs: 30 }),
      true,
    ))).toBe(20);
    expect(movementDuration(interval(
      snapshot([0, 0, 0], { mode: "fixed-step", tick: 0 }),
      snapshot([0, 0, 0], { mode: "render-frame", timeMs: 1 }),
      true,
    ))).toBeUndefined();
    expect(positiveFiniteDelta(undefined, 1)).toBeUndefined();
    expect(positiveFiniteDelta(Number.NaN, 1)).toBeUndefined();
    expect(positiveFiniteDelta(1, 1)).toBeUndefined();
    expect(positiveFiniteDelta(2, 1)).toBeUndefined();
    expect(positiveFiniteDelta(Number.MAX_VALUE, -Number.MAX_VALUE)).toBeUndefined();
    expect(positiveFiniteDelta(1, 2)).toBe(1);
    expect(entityRotation(after, "ghost")).toBeUndefined();
    expect(entityRotation({ ...after, entities: [{ id: "player", transform: { rotation: [0, 1, 0, 0] } }] }, "player")).toEqual([0, 1, 0, 0]);
  });

  test("pairs resource snapshots and classifies only unambiguous runtime readouts", () => {
    expect(resourceObservations(snapshot(undefined, undefined, { resources: { state: { score: 1 } } }), snapshot(undefined, undefined, { resources: { other: 2 } }))).toEqual({
      state: { after: undefined, before: { score: 1 } },
      other: { after: 2, before: undefined },
    });
    expect(isRuntimeReadout(null)).toBe(false);
    expect(isRuntimeReadout([])).toBe(false);
    expect(isRuntimeReadout({ label: "fps", value: 60 })).toBe(true);
    expect(isRuntimeReadout({ label: "ready", value: false })).toBe(true);
    expect(isRuntimeReadout({ label: "state", value: { name: "run" } })).toBe(false);
    expect(isRuntimeReadout({ label: "error", value: 1, severity: "error" })).toBe(false);
    expect(isRuntimeReadout({ label: "error", value: 1, error: "bad" })).toBe(false);
    expect(isRuntimeReadout({ label: "error", value: 1, type: "assert" })).toBe(false);
    expect(isRuntimeReadout({ value: 1 })).toBe(false);
  });

  test("normalizes diagnostics and converts entity pixel bounds into scene evidence", () => {
    const scenario = { viewport: { height: 100, width: 200 } } as IPlaytestScenario;
    const normalized = normalizedRuntimeDiagnostics(
      {
        ...snapshot([0, 0, 0], undefined, {
          diagnostics: [{ label: "fps", value: 60 }, { message: "bad" }],
          entities: [
            { bounds: { height: 20, width: 30, x: 5, y: 10 }, id: "player", visible: true },
            { id: "empty", visible: false },
          ],
        }),
      },
      scenario,
      [
        { source: "browser-console", text: "ignored", type: "error" },
        { source: "page-error", text: "page failed", type: "error" },
        { source: "unhandled-rejection", text: "rejected", type: "unhandledrejection" },
      ],
    );
    expect(normalized.runtimeReadouts).toEqual([{ label: "fps", value: 60 }]);
    expect(normalized.recentRuntimeErrors).toEqual([
      { message: "bad" },
      { source: "page-error", text: "page failed", type: "error" },
    ]);
    expect(normalized.scene.renderedEntities).toEqual([
      { id: "player", projectedBounds: { max: [-0.65, 0.8], min: [-0.95, 0.4] }, visible: true },
      { id: "empty", projectedBounds: undefined, visible: false },
    ]);
  });

  test("reads WebGPU and WebGL capture provenance, including missing metadata failures", async () => {
    const canvas = {
      getAttribute: (name: string) => name === "data-engine" ? "webgpu" : null,
      getContext: () => null,
    };
    const restoreDocument = installGlobal("document", { querySelector: () => canvas });
    const restoreNavigator = installGlobal("navigator", {
      gpu: {
        requestAdapter: async () => ({
          features: new Set(["texture-compression-bc"]),
          info: { architecture: "arch", description: "GPU", device: "dev", vendor: "vendor" },
          limits: { maxBindGroups: 4, maxStorageBufferBindingSize: Number.NaN, maxTextureDimension2D: 8192 },
        }),
      },
    });
    try {
      const page = { evaluate: async (callback: () => unknown) => callback() } as unknown as Page;
      const provenance = await readCaptureProvenance(page, { browserArgs: ["--headless"] } as never, {
        target: "web",
        viewport: { height: 720, width: 1280 },
      } as never);
      expect(provenance).toMatchObject({
        adapter: {
          architecture: "arch",
          "limit.maxBindGroups": "4",
          "limit.maxTextureDimension2D": "8192",
          vendor: "vendor",
        },
        rendererKind: "webgpu",
        target: "web",
      });
      expect(provenance.browserArgs).toEqual(["--headless"]);
    } finally {
      restoreNavigator();
      restoreDocument();
    }

    const restoreEmptyDocument = installGlobal("document", { querySelector: () => null });
    const restoreNoNavigator = installGlobal("navigator", {});
    try {
      const page = { evaluate: async (callback: () => unknown) => callback() } as unknown as Page;
      await expect(readCaptureProvenance(page, {} as never, { target: "web", viewport: { height: 100, width: 200 } } as never)).rejects.toMatchObject({
        diagnostic: { code: "TN_PLAYTEST_CAPTURE_PROVENANCE_MISSING" },
      });
    } finally {
      restoreNoNavigator();
      restoreEmptyDocument();
    }
  });

  test("uses legacy WebGPU adapter info and WebGL debug renderer metadata", async () => {
    const restoreDocument = installGlobal("document", {
        querySelector: () => ({
          getAttribute: () => "",
          getContext: (kind: string) => kind === "webgpu" ? null : {
          // biome-ignore lint/style/useNamingConvention: mirrors the browser WebGL constant
          "RENDERER": 1,
          // biome-ignore lint/style/useNamingConvention: mirrors the browser WebGL constant
          "VENDOR": 2,
          getExtension: () => ({
            // biome-ignore lint/style/useNamingConvention: mirrors the browser WebGL constant
            "UNMASKED_RENDERER_WEBGL": 3,
            // biome-ignore lint/style/useNamingConvention: mirrors the browser WebGL constant
            "UNMASKED_VENDOR_WEBGL": 4,
          }),
          getParameter: (key: number) => key === 3 ? "Renderer" : key === 4 ? "Vendor" : "fallback",
        },
      }),
    });
    const restoreNavigator = installGlobal("navigator", {
      gpu: {
        requestAdapter: async () => ({
          info: {},
          requestAdapterInfo: async () => ({ description: "legacy" }),
        }),
      },
    });
    try {
      const page = { evaluate: async (callback: () => unknown) => callback() } as unknown as Page;
      const provenance = await readCaptureProvenance(page, {} as never, { target: "web", viewport: { height: 100, width: 200 } } as never);
      expect(provenance).toMatchObject({ adapter: { renderer: "Renderer", vendor: "Vendor" }, rendererKind: "webgl" });
    } finally {
      restoreNavigator();
      restoreDocument();
    }
  });

  // `engine: "threejs"` renders through three's WebGLRenderer in a worker: the page canvas carries
  // only three's bare `three.js r<n>` tag and throws on every getContext, because the worker owns
  // it (wm-platformer-2, 2026-11-13). The WebGL implementation is the page's, so a fresh canvas
  // describes the same adapter.
  test("reads a worker-owned three.js WebGL canvas as webgl with the page's WebGL adapter", async () => {
    const owned = () => {
      throw new Error("InvalidStateError: the canvas has been transferred to an OffscreenCanvas");
    };
    const restoreDocument = installGlobal("document", {
      querySelector: () => ({ getAttribute: () => "three.js r187", getContext: owned }),
      createElement: () => ({
        getContext: (kind: string) => kind !== "webgl2" ? null : {
          // biome-ignore lint/style/useNamingConvention: mirrors the browser WebGL constant
          "RENDERER": 1,
          // biome-ignore lint/style/useNamingConvention: mirrors the browser WebGL constant
          "VENDOR": 2,
          getExtension: () => null,
          getParameter: (key: number) => key === 1 ? "ANGLE (Intel)" : "Google Inc.",
        },
      }),
    });
    const restoreNavigator = installGlobal("navigator", {});
    try {
      const page = { evaluate: async (callback: () => unknown) => callback() } as unknown as Page;
      await expect(readCaptureProvenance(page, {} as never, { target: "web", viewport: { height: 100, width: 200 } } as never)).resolves.toMatchObject({
        adapter: { renderer: "ANGLE (Intel)", vendor: "Google Inc." },
        rendererKind: "webgl",
      });
    } finally {
      restoreNavigator();
      restoreDocument();
    }
  });

  test("uses an unmarked WebGPU context and fails when adapter discovery rejects", async () => {
    const unmarkedCanvas = {
      getAttribute: () => null,
      getContext: (kind: string) => kind === "webgpu" ? {} : null,
    };
    const restoreDocument = installGlobal("document", { querySelector: () => unmarkedCanvas });
    const restoreNavigator = installGlobal("navigator", {
      gpu: {
        requestAdapter: async () => ({ info: { vendor: "unmarked-vendor" }, features: [] }),
      },
    });
    try {
      const page = { evaluate: async (callback: () => unknown) => callback() } as unknown as Page;
      await expect(readCaptureProvenance(page, {} as never, { target: "web", viewport: { height: 100, width: 200 } } as never)).resolves.toMatchObject({
        adapter: { vendor: "unmarked-vendor" },
        rendererKind: "webgpu",
      });
    } finally {
      restoreNavigator();
      restoreDocument();
    }

    const markedCanvas = {
      getAttribute: (name: string) => name === "data-engine" ? "webgpu" : null,
      getContext: () => null,
    };
    const restoreRejectedDocument = installGlobal("document", { querySelector: () => markedCanvas });
    const restoreRejectedNavigator = installGlobal("navigator", {
      gpu: {
        requestAdapter: async () => {
          throw new Error("adapter unavailable");
        },
      },
    });
    try {
      const page = { evaluate: async (callback: () => unknown) => callback() } as unknown as Page;
      await expect(readCaptureProvenance(page, {} as never, { target: "web", viewport: { height: 100, width: 200 } } as never)).rejects.toMatchObject({
        diagnostic: { code: "TN_PLAYTEST_CAPTURE_PROVENANCE_MISSING" },
      });
    } finally {
      restoreRejectedNavigator();
      restoreRejectedDocument();
    }
  });
});

describe("browser-backed DOM visibility isolation", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser.close();
  });

  test("diagnoses when CSP blocks isolation over a painted target", async () => {
    const page = await browser.newPage({ viewport: { height: 120, width: 160 } });
    try {
      await installVisibilityFixture(page, { csp: true, paintedTarget: true });
      const blockedStyleState = await page.evaluate(() => {
        const style = document.createElement("style");
        style.textContent = "#target { visibility: hidden !important; }";
        document.head.appendChild(style);
        const target = document.getElementById("target");
        if (target === null) throw new Error("visibility fixture has no target");
        const visibility = getComputedStyle(target).visibility;
        style.remove();
        return visibility;
      });
      expect(blockedStyleState).toBe("visible");

      const backgroundScreenshot = await page.screenshot({ clip: visibilityFixtureClip, omitBackground: true });
      expect(pngPixel(backgroundScreenshot, 20, 20)).toEqual([240, 40, 40, 255]);
      expect(pngPixel(backgroundScreenshot, 60, 20)).toEqual([17, 34, 51, 255]);
      await page.evaluate(() => {
        const canvas = document.getElementById("background") as HTMLCanvasElement | null;
        const context = canvas?.getContext("2d");
        if (canvas === null || context === null || context === undefined) throw new Error("visibility fixture has no 2D context");
        context.fillStyle = "rgb(68, 85, 102)";
        context.fillRect(0, 0, canvas.width, canvas.height);
      });
      const changedBackgroundScreenshot = await page.screenshot({ clip: visibilityFixtureClip, omitBackground: true });
      expect(pngPixel(changedBackgroundScreenshot, 20, 20)).toEqual([240, 40, 40, 255]);
      expect(pngPixel(changedBackgroundScreenshot, 60, 20)).toEqual([68, 85, 102, 255]);

      const observed = await captureVisibilityScreenshots(page);
      await expect(sampleHud(observed.page, [{ id: "target", visible: false }])).rejects.toMatchObject({
        diagnostic: { code: "TN_PLAYTEST_OBSERVATION_UNAVAILABLE" },
      });
      expect(observed.screenshots).toHaveLength(0);
      await expect(temporaryVisibilityArtifacts(page)).resolves.toEqual({ markers: 0, styles: 0 });
    } finally {
      await page.close();
    }
  });

  test("fails closed and cleans isolation when the screenshot throws", async () => {
    const page = await browser.newPage({ viewport: { height: 120, width: 160 } });
    try {
      await installVisibilityFixture(page, { csp: false, paintedTarget: true });
      const throwingPage = new Proxy(page, {
        get(target, property) {
          if (property === "screenshot") return async () => { throw new Error("capture failed"); };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as Page;

      await expect(sampleElementVisibility(throwingPage, { id: "target" })).rejects.toMatchObject({
        diagnostic: { code: "TN_PLAYTEST_OBSERVATION_UNAVAILABLE" },
      });
      await expect(temporaryVisibilityArtifacts(page)).resolves.toEqual({ markers: 0, styles: 0 });
    } finally {
      await page.close();
    }
  });

  test("does not report paint from a non-target with higher-specificity important visibility", async () => {
    const page = await browser.newPage({ viewport: { height: 120, width: 160 } });
    try {
      await installImportantNonTargetFixture(page);
      const originalControlStyle = await page.evaluate(() => document.getElementById("control")?.style.cssText);
      const observed = await captureVisibilityScreenshots(page);
      await expect(sampleElementVisibility(observed.page, { id: "target" })).resolves.toEqual({
        bounds: { height: 80, width: 80, x: 0, y: 0 },
        rendered: false,
      });
      expect(observed.screenshots).toHaveLength(1);
      expect(pngPixel(capturedScreenshot(observed), 10, 20)).toEqual([0, 0, 0, 0]);
      expect(await page.evaluate(() => document.getElementById("control")?.style.cssText)).toBe(originalControlStyle);
      await expect(temporaryVisibilityArtifacts(page)).resolves.toEqual({ markers: 0, styles: 0 });
    } finally {
      await page.close();
    }
  });

  test("fails closed when a visible important non-target is inserted while screenshot is pending", async () => {
    const page = await browser.newPage({ viewport: { height: 120, width: 160 } });
    try {
      await installVisibilityFixture(page, { csp: false, paintedTarget: false });
      const observed = await captureVisibilityScreenshots(page, async () => {
        await page.evaluate(() => {
          const control = document.createElement("div");
          control.id = "pending-control";
          control.style.cssText = [
            "position: absolute",
            "left: 0",
            "top: 0",
            "width: 20px",
            "height: 80px",
            "z-index: 2",
            "background: rgb(240, 40, 40)",
            "visibility: visible !important",
          ].join("; ");
          document.body.appendChild(control);
        });
      });
      await expect(sampleElementVisibility(observed.page, { id: "target" })).rejects.toMatchObject({
        diagnostic: { code: "TN_PLAYTEST_OBSERVATION_UNAVAILABLE" },
      });
      expect(observed.screenshots).toHaveLength(1);
      const screenshot = observed.screenshots[0];
      if (screenshot === undefined) throw new Error("visibility regression captured no screenshot");
      expect(pngPixel(screenshot, 10, 20)).toEqual([240, 40, 40, 255]);
      await expect(temporaryVisibilityArtifacts(page)).resolves.toEqual({ markers: 0, styles: 0 });
    } finally {
      await page.close();
    }
  });

  test("fails closed when a visible important non-target replaces an element while screenshot is pending", async () => {
    const page = await browser.newPage({ viewport: { height: 120, width: 160 } });
    try {
      await installImportantNonTargetFixture(page);
      const observed = await captureVisibilityScreenshots(page, async () => {
        await page.evaluate(() => {
          const control = document.getElementById("control");
          if (control === null) throw new Error("visibility fixture has no control");
          const replacement = document.createElement("div");
          replacement.style.cssText = [
            "position: absolute",
            "left: 0",
            "top: 0",
            "width: 20px",
            "height: 80px",
            "z-index: 2",
            "background: rgb(240, 40, 40)",
            "visibility: visible !important",
          ].join("; ");
          control.replaceWith(replacement);
        });
      });
      await expect(sampleElementVisibility(observed.page, { id: "target" })).rejects.toMatchObject({
        diagnostic: { code: "TN_PLAYTEST_OBSERVATION_UNAVAILABLE" },
      });
      expect(observed.screenshots).toHaveLength(1);
      const screenshot = observed.screenshots[0];
      if (screenshot === undefined) throw new Error("visibility regression captured no screenshot");
      expect(pngPixel(screenshot, 10, 20)).toEqual([240, 40, 40, 255]);
      await expect(temporaryVisibilityArtifacts(page)).resolves.toEqual({ markers: 0, styles: 0 });
    } finally {
      await page.close();
    }
  });

  test("preserves an unrelated inline update made while screenshot is pending", async () => {
    const page = await browser.newPage({ viewport: { height: 120, width: 160 } });
    try {
      await installImportantNonTargetFixture(page);
      const observed = await captureVisibilityScreenshots(page, async () => {
        await page.evaluate(() => {
          document.getElementById("control")?.style.setProperty("color", "rgb(4, 5, 6)");
        });
      });
      await expect(sampleElementVisibility(observed.page, { id: "target" })).resolves.toEqual({
        bounds: { height: 80, width: 80, x: 0, y: 0 },
        rendered: false,
      });
      await expect(page.evaluate(() => document.getElementById("control")?.style.getPropertyValue("color"))).resolves.toBe("rgb(4, 5, 6)");
      await expect(temporaryVisibilityArtifacts(page)).resolves.toEqual({ markers: 0, styles: 0 });
    } finally {
      await page.close();
    }
  });

  test("preserves an unrelated direct inline update made while screenshot is pending", async () => {
    const page = await browser.newPage({ viewport: { height: 120, width: 160 } });
    try {
      await installImportantNonTargetFixture(page);
      const observed = await captureVisibilityScreenshots(page, async () => {
        await page.evaluate(() => {
          const control = document.getElementById("control");
          if (control === null) throw new Error("visibility fixture has no control");
          control.style.color = "rgb(4, 5, 6)";
        });
      });
      await expect(sampleElementVisibility(observed.page, { id: "target" })).resolves.toEqual({
        bounds: { height: 80, width: 80, x: 0, y: 0 },
        rendered: false,
      });
      await expect(page.evaluate(() => document.getElementById("control")?.style.color)).resolves.toBe("rgb(4, 5, 6)");
      await expect(temporaryVisibilityArtifacts(page)).resolves.toEqual({ markers: 0, styles: 0 });
    } finally {
      await page.close();
    }
  });

  test("fails closed when an isolation-owned inline update occurs while screenshot is pending", async () => {
    const page = await browser.newPage({ viewport: { height: 120, width: 160 } });
    try {
      await installImportantNonTargetFixture(page);
      const observed = await captureVisibilityScreenshots(page, async () => {
        await page.evaluate(() => {
          const control = document.getElementById("control");
          if (control === null) throw new Error("visibility fixture has no control");
          control.style.setProperty("visibility", "visible");
        });
      });
      await expect(sampleElementVisibility(observed.page, { id: "target" })).rejects.toMatchObject({
        diagnostic: { code: "TN_PLAYTEST_OBSERVATION_UNAVAILABLE" },
      });
      expect(observed.screenshots).toHaveLength(1);
      const screenshot = observed.screenshots[0];
      if (screenshot === undefined) throw new Error("visibility regression captured no screenshot");
      expect(pngPixel(screenshot, 10, 20)).toEqual([240, 40, 40, 255]);
      await expect(page.evaluate(() => {
        const control = document.getElementById("control");
        return {
          priority: control?.style.getPropertyPriority("visibility"),
          value: control?.style.getPropertyValue("visibility"),
        };
      })).resolves.toEqual({ priority: "", value: "visible" });
      await expect(temporaryVisibilityArtifacts(page)).resolves.toEqual({ markers: 0, styles: 0 });
    } finally {
      await page.close();
    }
  });

  test("fails closed when an isolation-owned same-value write occurs while screenshot is pending", async () => {
    const page = await browser.newPage({ viewport: { height: 120, width: 160 } });
    try {
      await installImportantNonTargetFixture(page);
      const observed = await captureVisibilityScreenshots(page, async () => {
        await page.evaluate(() => {
          const control = document.getElementById("control");
          if (control === null) throw new Error("visibility fixture has no control");
          control.style.setProperty("visibility", "hidden", "important");
        });
      });
      await expect(sampleElementVisibility(observed.page, { id: "target" })).rejects.toMatchObject({
        diagnostic: { code: "TN_PLAYTEST_OBSERVATION_UNAVAILABLE" },
      });
      expect(observed.screenshots).toHaveLength(1);
      await expect(page.evaluate(() => {
        const control = document.getElementById("control");
        return {
          priority: control?.style.getPropertyPriority("visibility"),
          value: control?.style.getPropertyValue("visibility"),
        };
      })).resolves.toEqual({ priority: "important", value: "hidden" });
      await expect(temporaryVisibilityArtifacts(page)).resolves.toEqual({ markers: 0, styles: 0 });
    } finally {
      await page.close();
    }
  });

  test("preserves an isolation-owned value changed away and back while screenshot is pending", async () => {
    const page = await browser.newPage({ viewport: { height: 120, width: 160 } });
    try {
      await installImportantNonTargetFixture(page);
      const observed = await captureVisibilityScreenshots(page, async () => {
        await page.evaluate(() => {
          const control = document.getElementById("control");
          if (control === null) throw new Error("visibility fixture has no control");
          control.style.setProperty("visibility", "visible", "important");
          control.style.setProperty("visibility", "hidden", "important");
        });
      });
      await expect(sampleElementVisibility(observed.page, { id: "target" })).rejects.toMatchObject({
        diagnostic: { code: "TN_PLAYTEST_OBSERVATION_UNAVAILABLE" },
      });
      expect(observed.screenshots).toHaveLength(1);
      await expect(page.evaluate(() => {
        const control = document.getElementById("control");
        return {
          priority: control?.style.getPropertyPriority("visibility"),
          value: control?.style.getPropertyValue("visibility"),
        };
      })).resolves.toEqual({ priority: "important", value: "hidden" });
      await expect(temporaryVisibilityArtifacts(page)).resolves.toEqual({ markers: 0, styles: 0 });
    } finally {
      await page.close();
    }
  });

  test.each([
    ["visibility", "control"],
    ["background-color", "documentElement"],
    ["background-image", "documentElement"],
  ])("fails closed for an isolation-owned same-value %s direct setter", async (property, targetName) => {
    const page = await browser.newPage({ viewport: { height: 120, width: 160 } });
    try {
      await installImportantNonTargetFixture(page);
      await expectPendingVisibilityMutationToReject(page, async () => {
        await page.evaluate(writeIsolationOwnedSameValue, { property, targetName });
      });
    } finally {
      await page.close();
    }
  });

  test("fails closed when an isolation-owned cssText write occurs while screenshot is pending", async () => {
    const page = await browser.newPage({ viewport: { height: 120, width: 160 } });
    try {
      await installImportantNonTargetFixture(page);
      await expectPendingVisibilityMutationToReject(page, async () => {
        await page.evaluate(() => {
          const control = document.getElementById("control");
          if (control === null) throw new Error("visibility fixture has no control");
          const cssText = control.style.cssText;
          control.style.cssText = cssText;
        });
      });
    } finally {
      await page.close();
    }
  });

  test("fails closed when an isolation-owned style-attribute write occurs while screenshot is pending", async () => {
    const page = await browser.newPage({ viewport: { height: 120, width: 160 } });
    try {
      await installImportantNonTargetFixture(page);
      await expectPendingVisibilityMutationToReject(page, async () => {
        await page.evaluate(() => {
          const control = document.getElementById("control");
          if (control === null) throw new Error("visibility fixture has no control");
          const style = control.getAttribute("style");
          if (style === null) throw new Error("visibility fixture has no style attribute");
          control.setAttribute("style", style);
        });
      });
    } finally {
      await page.close();
    }
  });

  test("keeps a flex target's bounds and capture stable while probing isolation", async () => {
    const page = await browser.newPage({ viewport: { height: 120, width: 160 } });
    try {
      await installFlexVisibilityFixture(page);
      const initialBounds = await page.evaluate(() => {
        const rect = document.getElementById("target")?.getBoundingClientRect();
        if (rect === undefined) throw new Error("visibility fixture has no target bounds");
        return { height: rect.height, width: rect.width, x: rect.left, y: rect.top };
      });
      expect(initialBounds).toEqual({ height: 80, width: 80, x: 80, y: 0 });

      const observed = await captureVisibilityScreenshots(page);
      await expect(sampleElementVisibility(observed.page, { id: "target" })).resolves.toEqual({
        bounds: initialBounds,
        rendered: true,
      });
      expect(observed.screenshotOptions).toEqual([{ clip: { ...initialBounds }, omitBackground: true }]);
      expect(pngPixel(capturedScreenshot(observed), 40, 40)).toEqual([240, 40, 40, 255]);
      await expect(page.evaluate(() => {
        const rect = document.getElementById("target")?.getBoundingClientRect();
        if (rect === undefined) throw new Error("visibility fixture has no target bounds after sampling");
        return { height: rect.height, width: rect.width, x: rect.left, y: rect.top };
      })).resolves.toEqual(initialBounds);
      await expect(temporaryVisibilityArtifacts(page)).resolves.toEqual({ markers: 0, styles: 0 });
    } finally {
      await page.close();
    }
  });

  test("captures a painted target after isolation removes the background", async () => {
    const page = await browser.newPage({ viewport: { height: 120, width: 160 } });
    try {
      await installVisibilityFixture(page, { csp: false, paintedTarget: true });
      const observed = await captureVisibilityScreenshots(page);
      await expect(sampleElementVisibility(observed.page, { id: "target" })).resolves.toEqual({
        bounds: { height: 80, width: 80, x: 0, y: 0 },
        rendered: true,
      });
      expect(observed.screenshots).toHaveLength(1);
      expect(pngPixel(capturedScreenshot(observed), 20, 20)).toEqual([240, 40, 40, 255]);
      expect(pngPixel(capturedScreenshot(observed), 60, 20)).toEqual([0, 0, 0, 0]);
      await expect(temporaryVisibilityArtifacts(page)).resolves.toEqual({ markers: 0, styles: 0 });
    } finally {
      await page.close();
    }
  });
});
