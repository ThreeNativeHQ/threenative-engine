import type { FullConfig, Page } from "@playwright/test";

import { softwareAdapterName } from "../packages/playtest/src/runner/browser.js";

const ADAPTER_IDENTITY_KEYS = ["architecture", "description", "device", "vendor"] as const;

export interface IPlaywrightCaptureProvenance {
  readonly adapter: Record<string, string>;
  readonly browserArgs: readonly string[];
  readonly captureMethod: "page.screenshot";
  readonly rendererKind: "webgpu";
  readonly target: string;
}

export interface IWebGpuCaptureObservation {
  readonly adapter: Record<string, unknown>;
  readonly rendererKind: "webgpu" | "webgl" | undefined;
}

export interface IWebGpuProvenanceOptions {
  readonly allowSoftwareAdapter?: boolean;
}

/** Convert the browser's adapter.info object into the stable provenance fields used by captures. */
export function assertAdapterInfo(
  info: Readonly<Record<string, unknown>> | undefined,
  browserArgs: readonly string[],
  target: string,
  options: IWebGpuProvenanceOptions = {},
): IPlaywrightCaptureProvenance {
  if (info === undefined) {
    throw new Error(`WebGPU adapter evidence missing for ${target}: adapter.info was unavailable.`);
  }
  const adapter = Object.fromEntries(
    ADAPTER_IDENTITY_KEYS.flatMap((key) => {
      const value = info[key];
      return typeof value === "string" && value.trim().length > 0 ? [[key, value]] : [];
    }),
  );
  if (Object.keys(adapter).length === 0) {
    throw new Error(`WebGPU adapter evidence missing for ${target}: adapter.info had no identity.`);
  }
  if (
    options.allowSoftwareAdapter !== true &&
    (info.isFallbackAdapter === true || info.isFallbackAdapter === "true")
  ) {
    throw new Error(`WebGPU lane ${target} selected a software adapter (fallback).`);
  }
  const software = softwareAdapterName(adapter);
  if (software !== undefined && options.allowSoftwareAdapter !== true) {
    throw new Error(`WebGPU lane ${target} selected a software adapter: '${software}'.`);
  }
  return {
    adapter,
    browserArgs: [...browserArgs],
    captureMethod: "page.screenshot",
    rendererKind: "webgpu",
    target,
  };
}

export async function readWebGpuAdapterInfo(
  page: Pick<Page, "evaluate">,
): Promise<IWebGpuCaptureObservation | undefined> {
  return page.evaluate(async () => {
    const adapterIdentityKeys = ["architecture", "description", "device", "vendor"] as const;
    type Adapter = {
      info?: Partial<
        Record<"architecture" | "description" | "device" | "vendor" | "isFallbackAdapter", unknown>
      >;
      isFallbackAdapter?: boolean;
    };

    function rendererKind(canvas: HTMLCanvasElement | null): "webgpu" | "webgl" | undefined {
      if (canvas === null) return undefined;
      const hasContext = (kind: string): boolean => {
        try {
          return canvas.getContext(kind) !== null;
        } catch {
          return false;
        }
      };
      if (hasContext("webgpu")) return "webgpu";
      if (hasContext("webgl2") || hasContext("webgl")) return "webgl";
      return undefined;
    }

    function adapterFields(
      info: NonNullable<Adapter["info"]>,
      adapter: Adapter,
    ): Record<string, unknown> {
      const fallback = info.isFallbackAdapter ?? adapter.isFallbackAdapter;
      return Object.fromEntries([
        ...adapterIdentityKeys.flatMap((key) => {
          const value = info[key];
          return value === undefined ? [] : [[key, value]];
        }),
        ...(fallback === undefined ? [] : [["isFallbackAdapter", fallback]]),
      ]);
    }

    const gpu = (
      globalThis.navigator as Navigator & {
        gpu?: { requestAdapter(): Promise<Adapter | null> };
      }
    ).gpu;
    if (gpu === undefined) return undefined;
    const adapter = await gpu.requestAdapter().catch(() => null);
    const info = adapter?.info;
    if (adapter === null || info === undefined || typeof info !== "object" || Array.isArray(info))
      return undefined;
    return {
      adapter: adapterFields(info, adapter),
      rendererKind: rendererKind(document.querySelector("canvas")),
    };
  });
}

export async function assertWebGpuCaptureProvenance(
  page: Pick<Page, "evaluate">,
  browserArgs: readonly string[],
  target: string,
  options: IWebGpuProvenanceOptions = {},
): Promise<IPlaywrightCaptureProvenance> {
  const observation = await readWebGpuAdapterInfo(page);
  if (observation?.rendererKind !== "webgpu") {
    throw new Error(
      `WebGPU renderer kind evidence missing for ${target}: observed ${observation?.rendererKind ?? "none"}.`,
    );
  }
  return assertAdapterInfo(observation.adapter, browserArgs, target, options);
}

/** Boot pages that create their renderer only after an initial interaction. */
export async function waitForWebGpuProjectReady(
  page: Pick<Page, "locator" | "waitForFunction" | "waitForSelector">,
): Promise<void> {
  const startButton = page.locator("#startBtn");
  if ((await startButton.count()) > 0) await startButton.click({ timeout: 30_000 });
  await page.waitForSelector("canvas", { state: "visible", timeout: 30_000 });
  await page.waitForFunction(
    () => {
      const canvas = document.querySelector("canvas");
      if (canvas === null) return false;
      try {
        return canvas.getContext("webgpu") !== null;
      } catch {
        return false;
      }
    },
    undefined,
    { timeout: 30_000 },
  );
}

/** Verify every configured Playwright project against the real browser adapter before its tests run. */
export async function verifyWebGpuProjects(
  config: Pick<FullConfig, "projects">,
  browserArgs: readonly string[],
  lane: string,
  options: IWebGpuProvenanceOptions = {},
): Promise<void> {
  const projects = config.projects.flatMap(({ name, use }) => {
    const baseURL = use.baseURL;
    return typeof baseURL === "string" ? [{ name, baseURL }] : [];
  });
  if (projects.length === 0)
    throw new Error(`WebGPU provenance has no base URL in the ${lane} lane.`);
  const { chromium } = await import("@playwright/test");
  // Headless Chromium serves WebGPU from SwiftShader whatever the flags say, so a sweep that
  // launches headless can only ever observe a software adapter — and then this lane rejects it
  // off CI, where software is not tolerated. That made `pnpm test:browser` fail for every
  // developer on their own machine, including one with an RTX 2080 and a real display, which is
  // how a browser spec that had never worked went unnoticed. Launch headed wherever there is a
  // display to launch into; the playtest runner already treats a display as the thing that
  // separates a real adapter from a rasteriser.
  const hasDisplay =
    process.platform !== "linux" ||
    process.env.DISPLAY !== undefined ||
    process.env.WAYLAND_DISPLAY !== undefined;
  const browser = await chromium.launch({ args: [...browserArgs], headless: !hasDisplay });
  try {
    for (const project of projects) {
      const page = await browser.newPage();
      try {
        const response = await page.goto(project.baseURL, {
          timeout: 30_000,
          waitUntil: "domcontentloaded",
        });
        if (response === null || !response.ok()) {
          throw new Error(
            `WebGPU provenance could not load ${project.baseURL} for ${lane}/${project.name}.`,
          );
        }
        await waitForWebGpuProjectReady(page);
        // A CPU rasteriser can fail to bring the renderer up at all. On GitHub's runners
        // SwiftShader rejects a 720-byte `mappedAtCreation` buffer that Three's WebGPURenderer
        // creates — "createBuffer failed, size (720) is too large for the implementation" — so the
        // canvas never gets a WebGPU context and the provenance check reports `observed none`.
        // That is the machine, not the framework: the same lane brings the renderer up on this
        // repository's RTX 2080. Where software adapters are already tolerated, record the project
        // as unexecuted with the adapter named. Never a pass, never silent, and never on hardware.
        const preflight = await readWebGpuAdapterInfo(page);
        if (preflight?.rendererKind !== "webgpu" && options.allowSoftwareAdapter === true) {
          const identity = Object.fromEntries(
            Object.entries(preflight?.adapter ?? {}).flatMap(([key, value]) =>
              typeof value === "string" ? [[key, value]] : [],
            ),
          );
          const adapterName = softwareAdapterName(identity);
          if (adapterName !== undefined) {
            process.stdout.write(
              `[webgpu-provenance] TN_WEBGPU_PROVENANCE_UNEXECUTED ${JSON.stringify({
                adapter: identity,
                observedRendererKind: preflight?.rendererKind ?? "none",
                reason: `the ${adapterName} rasteriser never brought the WebGPU renderer up, so this project did not execute here`,
                target: `${lane}/${project.name}`,
              })}\n`,
            );
            continue;
          }
        }
        const provenance = await assertWebGpuCaptureProvenance(
          page,
          browserArgs,
          `${lane}/${project.name}`,
          options,
        );
        const screenshot = await page.screenshot({ animations: "disabled" });
        if (screenshot.byteLength === 0) {
          throw new Error(`WebGPU provenance capture was empty for ${lane}/${project.name}.`);
        }
        process.stdout.write(`[webgpu-provenance] ${JSON.stringify(provenance)}\n`);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
}
