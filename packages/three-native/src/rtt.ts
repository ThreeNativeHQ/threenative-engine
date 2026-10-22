import { gpuStageId } from "./gpu-stages.js";

/** RTTNode's mutable target and quad over the engine's scheduled fullscreen pass. */
interface IRttNode {
  __effect(name: string, value?: number): number;
  __rtt(target: unknown, quad: unknown): unknown;
}
interface IRttQuad {
  material: unknown;
  name: string;
  render(renderer: unknown): void;
}
export interface IRttClasses {
  // quality-allow: three's class name, so a back end passes its class map.
  // biome-ignore lint/style/useNamingConvention: three's class name, so a back end passes its class map.
  NodeMaterial: new () => { name: string; needsUpdate: boolean; fragmentNode: unknown };
  // quality-allow: three's class name, so a back end passes its class map.
  // biome-ignore lint/style/useNamingConvention: three's class name, so a back end passes its class map.
  QuadMesh: new (
    ...args: never[]
  ) => object;
  // quality-allow: three's class name, so a back end passes its class map.
  // biome-ignore lint/style/useNamingConvention: three's class name, so a back end passes its class map.
  RenderTarget: new (
    width: number,
    height: number,
    options: Record<string, unknown>,
  ) => {
    texture: unknown;
    width: number;
    height: number;
    setSize(w: number, h: number): void;
    dispose(): void;
  };
}
function validateOptions(options: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(options)) {
    if (key === "type" && value === 1016) continue;
    if (key === "depthBuffer" && value === false) continue;
    // Not a RenderTarget option: the GPU stage the pass reports its time under (gpu-stages.ts).
    if (key === "gpuStage") {
      gpuStageId(value);
      continue;
    }
    if ((key === "minFilter" || key === "magFilter") && (value === 1003 || value === 1006))
      continue;
    throw new TypeError(`TN_TSL_RTT_OPTION: unsupported ${key}=${value}`);
  }
}
export function defineRtt(make: (...args: unknown[]) => IRttNode, classes?: IRttClasses) {
  return (
    source: unknown,
    width: number | null = null,
    height: number | null = null,
    options: Record<string, unknown> = { type: 1016 },
  ) => {
    validateOptions(options);
    if (!classes)
      throw new TypeError("TN_RTT_CLASSES: engine material, quad and target classes are required");
    const node = make(
      source,
      width ?? 0,
      height ?? 0,
      options.minFilter ?? 1006,
      options.magFilter ?? 1006,
    );
    const material = new classes.NodeMaterial();
    material.fragmentNode = source;
    const quad = new classes.QuadMesh(material as never) as IRttQuad;
    if (options.gpuStage !== undefined) node.__effect("stage", gpuStageId(options.gpuStage));
    const { minFilter = 1006, magFilter = 1006, gpuStage: _stage, ...targetOptions } = options;
    const target = new classes.RenderTarget(width ?? 1, height ?? 1, targetOptions);
    Object.assign(target.texture as object, { minFilter, magFilter });
    node.__rtt(target, quad);
    let version = 0;
    const parameter = (name: string) => ({
      get: () => node.__effect(name),
      set: (value: number) => node.__effect(name, value),
    });
    const setSize = (w: number, h: number) => {
      const scale = node.__effect("resolutionScale");
      if (![w, h].every((v) => Number.isFinite(v) && v >= 0 && v <= 16384))
        throw new TypeError("TN_RTT_SIZE: expected finite dimensions in [0, 16384]");
      target.setSize(Math.floor(w * scale), Math.floor(h * scale));
      node.__effect("textureNeedsUpdate", 1);
    };
    return Object.defineProperties(node, {
      version: { get: () => version },
      needsUpdate: {
        set: (value: boolean) => {
          if (value === true) ++version;
        },
      },
      _quadMesh: { value: quad },
      setup: {
        value: () => {
          const current = quad.material as InstanceType<IRttClasses["NodeMaterial"]>;
          current.name = "RTT";
          current.needsUpdate = true;
          return node;
        },
      },
      updateBefore: {
        value: ({
          renderer,
        }: {
          renderer: {
            getRenderTarget(): unknown;
            setRenderTarget(target: unknown): void;
            getDrawingBufferSize(target: unknown): { width: number; height: number };
          };
        }) => {
          if (!node.__effect("textureNeedsUpdate") && !node.__effect("autoUpdate")) return;
          node.__effect("textureNeedsUpdate", 0);
          if (node.__effect("width") === 0) {
            const size = renderer.getDrawingBufferSize({
              set(w: number, h: number) {
                return { width: w, height: h };
              },
            });
            const scale = node.__effect("resolutionScale");
            if (
              Math.floor(size.width * scale) !== target.width ||
              Math.floor(size.height * scale) !== target.height
            )
              setSize(size.width, size.height);
          }
          const current = quad.material as InstanceType<IRttClasses["NodeMaterial"]>;
          if (current.fragmentNode !== source) current.fragmentNode = source;
          node.__rtt(target, quad);
          quad.name = "RTT";
          const previous = renderer.getRenderTarget();
          renderer.setRenderTarget(target);
          try {
            quad.render(renderer);
          } finally {
            renderer.setRenderTarget(previous);
          }
        },
      },
      isRTTNode: { value: true },
      autoResize: { get: () => node.__effect("width") === 0 },
      renderTarget: { value: target },
      value: { value: target.texture },
      width: parameter("width"),
      height: parameter("height"),
      autoUpdate: {
        get: () => !!node.__effect("autoUpdate"),
        set: (v: boolean) => node.__effect("autoUpdate", Number(v)),
      },
      textureNeedsUpdate: {
        get: () => !!node.__effect("textureNeedsUpdate"),
        set: (v: boolean) => node.__effect("textureNeedsUpdate", Number(v)),
      },
      setResolutionScale: {
        value: (scale: number) => {
          node.__effect("resolutionScale", scale);
          if (width !== null) setSize(node.__effect("width"), node.__effect("height"));
          return node;
        },
      },
      getResolutionScale: { value: () => node.__effect("resolutionScale") },
      setSize: { value: setSize },
    });
  };
}
