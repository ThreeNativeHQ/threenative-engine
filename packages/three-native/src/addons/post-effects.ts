/**
 * three/addons/tsl/display's GTAO, Denoise, SMAA and Bloom as the engine's live effects, for both
 * back ends (PRD-540; moved from the V8 player's core-addons.mjs). Each returns the effect's node; its
 * scalar uniforms read and write the native effect (`ao(...).radius.value`) through the node's
 * `__effect(name[, value])`, which the back end routes to tslEffectParameter.
 */

import { GPU_STAGES, gpuStageId } from "../gpu-stages.js";

interface IEffectNode {
  __effect(name: string, value?: number): number;
  getTextureNode?: () => IEffectNode;
}

type Effect = (...args: unknown[]) => IEffectNode;

/** The back end's TSL functions the effects are built by (the shared table's "ao", "bloom", ...). */
export interface IEffectTsl {
  readonly ao: Effect;
  readonly ssr: Effect;
  readonly denoise: Effect;
  readonly smaa: Effect;
  readonly bloom: Effect;
  readonly traa: Effect;
  readonly film: Effect;
  readonly lut3D: Effect;
}

function uniforms(node: IEffectNode, names: readonly string[]): IEffectNode {
  for (const name of names)
    Object.defineProperty(node, name, {
      configurable: true,
      value: Object.freeze({
        get value() {
          return node.__effect(name);
        },
        set value(value: number) {
          node.__effect(name, value);
        },
      }),
    });
  return node;
}

/** `node.gpuStage = "SSGI"` makes the effect's pass report its GPU time under that stage (gpu-stages.ts). */
function stageLabel(node: IEffectNode): IEffectNode {
  return Object.defineProperty(node, "gpuStage", {
    configurable: true,
    get: () => GPU_STAGES[node.__effect("stage") - 1],
    set: (name: string) => {
      node.__effect("stage", gpuStageId(name));
    },
  });
}

const SSR_REFUSED_DEFAULTS: Readonly<Record<string, unknown>> = {
  stochastic: false,
  envImportanceSampling: false,
  environmentNode: null,
  diffuseNode: null,
};

function validateSsrOptions(options: Record<string, unknown>): void {
  if (options === null || typeof options !== "object")
    throw new TypeError("TN_NATIVE_SSR_OPTIONS: expected an options object");
  for (const [name, value] of Object.entries(options)) {
    if (["camera", "metalnessNode", "roughnessNode"].includes(name)) continue;
    if (["reflectNonMetals", "binaryRefine"].includes(name)) {
      if (typeof value !== "boolean")
        throw new TypeError(`TN_NATIVE_SSR_OPTIONS: ${name} must be boolean`);
      continue;
    }
    if (Object.hasOwn(SSR_REFUSED_DEFAULTS, name) && value === SSR_REFUSED_DEFAULTS[name]) continue;
    throw new Error(`TN_NATIVE_SSR_UNSUPPORTED: ${name}`);
  }
}

export function definePostEffects(tsl: IEffectTsl) {
  return {
    ssr(
      color: unknown,
      depth: unknown,
      normal: unknown,
      options: Record<string, unknown> = {},
    ): IEffectNode {
      validateSsrOptions(options);
      const camera =
        options.camera ?? (color as { passNode?: { camera?: unknown } } | null)?.passNode?.camera;
      if (camera == null) throw new Error("TN_NATIVE_SSR_CAMERA: ssr() requires a camera");
      const node = uniforms(
        tsl.ssr(color, depth, normal, options.metalnessNode ?? null, options.roughnessNode ?? null),
        [
          "maxDistance",
          "thickness",
          "opacity",
          "quality",
          "intensity",
          "maxLuminance",
          "blurQuality",
        ],
      );
      // r185 uses a number for blurQuality; also accept the uniform spelling used by native callers.
      const blurQuality = Object.getOwnPropertyDescriptor(node, "blurQuality")?.value;
      Object.defineProperty(node, "blurQuality", {
        configurable: true,
        get: () => blurQuality,
        set: (value: number) => node.__effect("blurQuality", value),
      });
      for (const name of ["reflectNonMetals", "binaryRefine"]) {
        node.__effect(name, Number(options[name] ?? false));
        Object.defineProperty(node, name, {
          configurable: true,
          get: () => node.__effect(name) !== 0,
          set: (value: boolean) => node.__effect(name, Number(value)),
        });
      }
      Object.defineProperty(node, "resolutionScale", {
        configurable: true,
        get: () => node.__effect("resolutionScale"),
        set: (value: number) => node.__effect("resolutionScale", value),
      });
      for (const [name, value] of Object.entries({
        ...SSR_REFUSED_DEFAULTS,
        historyTexture: null,
        velocityTexture: null,
        screenEdgeFadeBlack: false,
      }))
        Object.defineProperty(node, name, {
          configurable: true,
          get: () => value,
          set: () => {
            throw new Error(`TN_NATIVE_SSR_UNSUPPORTED: ${name}`);
          },
        });
      for (const name of ["setHistory", "setEnvMap"])
        Object.defineProperty(node, name, {
          value: () => {
            throw new Error(`TN_NATIVE_SSR_UNSUPPORTED: ${name}`);
          },
        });
      node.getTextureNode = () => node;
      return node;
    },
    film: (input: unknown, intensity?: unknown, uv?: unknown): IEffectNode =>
      tsl.film(input, intensity, uv),
    lut3D: (input: unknown, lut: unknown, size: number, intensity: unknown): IEffectNode =>
      uniforms(tsl.lut3D(input, lut, size, intensity), ["size"]),
    traa(input: unknown, depth: unknown, velocity: unknown, camera: unknown): IEffectNode {
      const node = tsl.traa(input, depth, velocity, camera);
      const viewCamera = camera as {
        updateProjectionMatrix(): void;
        projectionMatrix: { elements: readonly number[] };
        setViewOffset(w: number, h: number, x: number, y: number, vw: number, vh: number): void;
        clearViewOffset(): void;
      };
      let jitterIndex = 0;
      const halton = (start: number, base: number): number => {
        let index = start;
        let fraction = 1;
        let result = 0;
        while (index > 0) {
          fraction /= base;
          result += fraction * (index % base);
          index = Math.floor(index / base);
        }
        return result;
      };
      const setViewOffset = (width: number, height: number) => {
        if (![width, height].every((v) => Number.isFinite(v) && v > 0))
          throw new TypeError("TN_NATIVE_TRAA_SIZE: expected positive finite dimensions");
        viewCamera.updateProjectionMatrix();
        viewCamera.projectionMatrix.elements.forEach((value, i) =>
          node.__effect(`projection${i}`, value),
        );
        viewCamera.setViewOffset(
          width,
          height,
          halton(jitterIndex + 1, 2) - 0.5,
          halton(jitterIndex + 1, 3) - 0.5,
          width,
          height,
        );
        node.__effect("viewOffset", 1);
      };
      const clearViewOffset = () => {
        viewCamera.clearViewOffset();
        node.__effect("viewOffset", 0);
        jitterIndex = (jitterIndex + 1) % 31;
      };
      Object.defineProperties(node, {
        setViewOffset: { value: setViewOffset, configurable: true },
        clearViewOffset: { value: clearViewOffset, configurable: true },
        setup: {
          configurable: true,
          value: (builder: {
            context: { renderPipeline?: { context: Record<string, unknown> } };
            renderer: { getDrawingBufferSize(target: unknown): { width: number; height: number } };
          }) => {
            const pipeline = builder.context.renderPipeline;
            if (pipeline) {
              pipeline.context.onBeforeRenderPipeline = () => {
                const size = builder.renderer.getDrawingBufferSize({
                  set(width: number, height: number) {
                    return { width, height };
                  },
                });
                setViewOffset(size.width, size.height);
              };
              pipeline.context.onAfterRenderPipeline = clearViewOffset;
            }
            // The engine already lowers the resolve graph and exposes its output as this node.
            return node;
          },
        },
      });
      for (const name of [
        "depthThreshold",
        "edgeDepthDiff",
        "maxVelocityLength",
        "useSubpixelCorrection",
      ])
        Object.defineProperty(node, name, {
          configurable: true,
          get: () =>
            name === "useSubpixelCorrection" ? node.__effect(name) !== 0 : node.__effect(name),
          set: (value: number | boolean) => node.__effect(name, Number(value)),
        });
      return node;
    },
    ao(depthNode: unknown, normalNode: unknown, camera: unknown): IEffectNode {
      const node = uniforms(tsl.ao(depthNode, normalNode ?? null, camera), [
        "radius",
        "reachPx",
        "thickness",
        "distanceExponent",
        "distanceFallOff",
        "scale",
        "samples",
      ]);
      Object.defineProperty(node, "resolutionScale", {
        configurable: true,
        get() {
          return node.__effect("resolutionScale");
        },
        set(value: number) {
          node.__effect("resolutionScale", value);
        },
      });
      node.getTextureNode = () => node;
      return node;
    },
    denoise: (
      node: unknown,
      depthNode: unknown,
      normalNode: unknown,
      camera: unknown,
    ): IEffectNode =>
      stageLabel(
        uniforms(tsl.denoise(node, depthNode, normalNode ?? null, camera), [
          "lumaPhi",
          "depthPhi",
          "normalPhi",
          "radius",
          "index",
        ]),
      ),
    smaa: (node: unknown): IEffectNode => tsl.smaa(node),
    bloom: (node: unknown, strength?: number, radius?: number, threshold?: number): IEffectNode =>
      uniforms(tsl.bloom(node, strength, radius, threshold), [
        "strength",
        "radius",
        "threshold",
        "smoothWidth",
      ]),
  };
}
