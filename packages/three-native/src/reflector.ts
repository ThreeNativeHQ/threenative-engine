// Ported from three.js r185 (three@0.185.1). The MIT License, Copyright © 2010-2026 three.js authors.
/**
 * three's TSL `reflector(parameters)` over an engine back end, for both: the browser-JS one and the
 * V8 facade. The engine draws the mirrored pass itself, before the frame that samples it, so the
 * node it returns carries upstream's parameters and `target`, but no JS `updateBefore`.
 *
 * Two differences are structural. The engine keeps one virtual camera per reflector, where three
 * keeps one per scene camera, so `getVirtualCamera(camera)` returns it for every camera. And a
 * function assigned over `getVirtualCamera` (WaterSurface3D sets the reflection's layers that way)
 * runs once, at assignment, against that camera, since the engine never calls back into JS for it.
 * `updateBefore` cannot be read or replaced: a game that wraps it would otherwise run no code at all.
 */

/** ReflectorNode's parameters, as upstream reads them. */
export interface IReflectorParameters {
  readonly target?: object;
  readonly resolutionScale?: number;
  /** @deprecated r180 name of resolutionScale. */
  readonly resolution?: number;
  readonly generateMipmaps?: boolean;
  readonly bounces?: boolean;
  readonly depth?: boolean;
  readonly samples?: number;
}

/** The engine classes the reflector builds its target and virtual camera from. */
export interface IReflectorClasses {
  // quality-allow: three's PascalCase class name passed in engine constructor map.
  // biome-ignore lint/style/useNamingConvention: three's class name, so a back end passes its class map.
  readonly Object3D: new () => object;
  // quality-allow: three's PascalCase class name passed in engine constructor map.
  // biome-ignore lint/style/useNamingConvention: see Object3D.
  readonly PerspectiveCamera: new () => object;
}

type NativeReflector = (...args: unknown[]) => object;

const UPDATE_HOOK =
  "TN_NATIVE_REFLECTOR_UPDATE_HOOK: the engine draws the reflection pass natively; updateBefore cannot be read or replaced";

/** Returns three's `reflector` over the engine's TSL `reflector(target, camera, ...)` call. */
export function defineReflector(native: NativeReflector, classes: IReflectorClasses) {
  return function reflector(parameters: IReflectorParameters = {}): object {
    const target = parameters.target ?? new classes.Object3D();
    const resolutionScale = parameters.resolutionScale ?? parameters.resolution ?? 1;
    const { generateMipmaps = false, bounces = true, depth = false, samples = 0 } = parameters;
    const camera = new classes.PerspectiveCamera();
    const node = native(
      target,
      camera,
      resolutionScale,
      bounces ? 1 : 0,
      generateMipmaps ? 1 : 0,
      depth ? 1 : 0,
      samples,
    );
    let getVirtualCamera: (camera?: object) => object = () => camera;
    const base = {
      target,
      resolutionScale,
      generateMipmaps,
      bounces,
      depth,
      samples,
      get getVirtualCamera() {
        return getVirtualCamera;
      },
      set getVirtualCamera(wrapper: (camera?: object) => object) {
        getVirtualCamera = wrapper;
        wrapper();
      },
      get updateBefore(): never {
        throw new Error(UPDATE_HOOK);
      },
      set updateBefore(_hook: unknown) {
        throw new Error(UPDATE_HOOK);
      },
      dispose() {},
    };
    Object.defineProperties(node, {
      target: { value: target, enumerable: true },
      reflector: { value: base, enumerable: true },
      _reflectorBaseNode: { value: base },
    });
    return node;
  };
}
