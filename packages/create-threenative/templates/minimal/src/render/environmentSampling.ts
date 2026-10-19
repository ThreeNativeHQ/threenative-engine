// Generated for you. A bounded source-radiance estimate, never a material/BRDF measurement.
import {
  FloatType,
  LinearSRGBColorSpace,
  NoToneMapping,
  RGBAFormat,
  RenderTarget,
  type Scene,
  type ToneMapping,
} from "three";
import { texture, uv } from "three/tsl";
import { MeshBasicNodeMaterial, QuadMesh, type WebGPURenderer } from "three/webgpu";
import { type IEnvironmentMeasurement, measureEnvironment } from "./environmentContribution.js";
import { sampledRadiance } from "./environmentRadiance.js";
import { cacheEnvironmentSample, cachedEnvironmentSample } from "./environmentSampleCache.js";
import {
  type IEnvironmentSourceSnapshot,
  captureEnvironmentSnapshot,
  environmentSnapshotCurrent,
  samplingSourceSupported,
} from "./environmentSnapshot.js";
import {
  type IMaterialLightingEnvironment,
  isWebGLFallbackRenderer,
  materialLightingEnabled,
} from "./quality.js";
export interface IEnvironmentSample extends IEnvironmentSourceSnapshot {
  readonly measurement: IEnvironmentMeasurement;
}
/** Editable bound on asynchronous readback, independent of the engine startup deadline. */
const ENVIRONMENT_READBACK_TIMEOUT_MS = 1000;
const WIDTH = 64;
const HEIGHT = 32;
/** Call from the scene's awaited load(), after its actual environment is bound. */
export async function sampleEnvironment(
  renderer: unknown,
  scene: Scene,
  environment: IMaterialLightingEnvironment,
): Promise<IEnvironmentSample> {
  const snapshot = captureEnvironmentSnapshot(scene);
  const { source, intensity } = snapshot;
  const result = (measurement: IEnvironmentMeasurement): IEnvironmentSample => ({
    ...snapshot,
    measurement,
  });
  const unknown = (reason: string): IEnvironmentSample =>
    result({ status: "unknown", meanRadiance: null, meanRGB: null, reason });
  if (!materialLightingEnabled("high", environment) || isWebGLFallbackRenderer(renderer))
    return unknown("Environment GPU sampling is unqualified on this platform/renderer.");
  if (source === null) return result(measureEnvironment(scene, WIDTH * HEIGHT));
  if (!samplingSourceSupported(source))
    return unknown("Environment mapping/color-space is not qualified for the bounded GPU sample.");
  if (!Number.isFinite(intensity) || intensity < 0)
    return unknown("Environment intensity must be finite and nonnegative.");
  if (!samplingRendererSupported(renderer))
    return unknown("Raw Three.js renderer lacks the qualified sampling/readback methods.");
  const raw = renderer as WebGPURenderer;
  const cached = cachedEnvironmentSample(raw, scene);
  if (cached !== undefined) return cached;
  let state: {
    target: ReturnType<WebGPURenderer["getRenderTarget"]>;
    face: number;
    mip: number;
    toneMapping: ToneMapping;
    colorSpace: string;
    autoClear: boolean;
  };
  try {
    state = {
      target: raw.getRenderTarget(),
      face: raw.getActiveCubeFace(),
      mip: raw.getActiveMipmapLevel(),
      toneMapping: raw.toneMapping,
      colorSpace: raw.outputColorSpace,
      autoClear: raw.autoClear,
    };
  } catch {
    return unknown("Raw renderer state could not be saved; GPU sample skipped.");
  }
  const target = new RenderTarget(WIDTH, HEIGHT, {
    type: FloatType,
    format: RGBAFormat,
    depthBuffer: false,
    stencilBuffer: false,
  });
  target.texture.colorSpace = LinearSRGBColorSpace;
  const material = new MeshBasicNodeMaterial();
  material.toneMapped = false;
  material.colorNode = texture(source, uv()).rgb;
  const quad = new QuadMesh(material);
  let pendingReadback: Promise<unknown> | undefined;
  let readbackSettled = false;
  let cleaned = false;
  function cleanup(): void {
    if (cleaned) return;
    cleaned = true;
    try {
      material.dispose();
    } finally {
      target.dispose();
    }
    // QuadMesh geometry is shared and borrowed.
  }
  try {
    try {
      raw.toneMapping = NoToneMapping;
      raw.outputColorSpace = LinearSRGBColorSpace;
      raw.autoClear = true;
      raw.setRenderTarget(target, 0, 0);
      quad.render(raw);
      pendingReadback = Promise.resolve(
        raw.readRenderTargetPixelsAsync(target, 0, 0, WIDTH, HEIGHT),
      ).then(
        (value) => {
          readbackSettled = true;
          return value;
        },
        (error) => {
          readbackSettled = true;
          throw error;
        },
      );
    } finally {
      // No async gap while the shared renderer points at our scratch target.
      try {
        raw.setRenderTarget(state.target, state.face, state.mip);
      } finally {
        raw.toneMapping = state.toneMapping;
        raw.outputColorSpace = state.colorSpace;
        raw.autoClear = state.autoClear;
      }
    }
    const outcome = await waitForReadback(pendingReadback);
    if (outcome.timedOut)
      return unknown(
        `Environment GPU readback exceeded ${ENVIRONMENT_READBACK_TIMEOUT_MS} ms budget; scratch resources retained until readback settles.`,
      );
    const samples = outcome.samples;
    if (!environmentSnapshotCurrent(scene, snapshot))
      return unknown(
        "Environment source/content/interpretation changed while GPU readback was pending; sample refused.",
      );
    const sampled = result(sampledRadiance(samples, intensity));
    cacheEnvironmentSample(raw, scene, sampled);
    return sampled;
  } catch (error) {
    return unknown(`Environment GPU sample/readback unavailable: ${String(error)}`);
  } finally {
    finishSampleCleanup(pendingReadback, readbackSettled, cleanup);
  }
}

async function waitForReadback(
  readback: Promise<unknown>,
): Promise<{ timedOut: true } | { timedOut: false; samples: unknown }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      readback.then((samples) => ({ timedOut: false as const, samples })),
      new Promise<{ timedOut: true }>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), ENVIRONMENT_READBACK_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function samplingRendererSupported(renderer: unknown): renderer is WebGPURenderer {
  return (
    renderer !== null &&
    typeof renderer === "object" &&
    Reflect.get(renderer, "isWebGPURenderer") === true &&
    [
      "render",
      "getRenderTarget",
      "getActiveCubeFace",
      "getActiveMipmapLevel",
      "setRenderTarget",
      "readRenderTargetPixelsAsync",
    ].every((name) => typeof Reflect.get(renderer, name) === "function")
  );
}

function finishSampleCleanup(
  readback: Promise<unknown> | undefined,
  settled: boolean,
  cleanup: () => void,
): void {
  // Timeout permits startup, but GPU work may still reference the target/material.
  if (readback !== undefined && !settled) void readback.then(cleanup, cleanup);
  else cleanup();
}
