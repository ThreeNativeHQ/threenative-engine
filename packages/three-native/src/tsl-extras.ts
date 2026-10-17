import { unsupportedExport } from "./refused.js";

/** The engine TSL functions and inputs the extras compose, read at call time (some are lazy getters). */
interface IExtrasTsl {
  readonly cameraFar: IFogNode;
  readonly cameraNear: IFogNode;
  readonly clamp: (value: unknown, low: number, high: number) => unknown;
  readonly float: (value: number) => IFogNode;
  readonly linearDepth: () => IFogNode;
  readonly vec4: (color: unknown, factor: unknown) => IFogNode;
}

interface IFogNode {
  add(value: unknown): IFogNode;
  exp(): IFogNode;
  mul(value: unknown): IFogNode;
  negate(): IFogNode;
  oneMinus(): IFogNode;
  sub(value: unknown): IFogNode;
}

/**
 * The r185 `three/tsl` exports that are plain JS over the engine's TSL functions, for both back ends
 * (the V8 player's core-tsl.mjs and the Wasm web module): `saturate`, `densityFogFactor`, `fog`, and
 * the two exports the engine refuses by name.
 */
export function defineTslExtras(tsl: IExtrasTsl) {
  return {
    // r185's saturate(x) is clamp(x, 0, 1).
    saturate: (value: unknown) => tsl.clamp(value, 0, 1),
    // r185's densityFogFactor (nodes/fog/Fog.js): 1 - exp(-density^2 * viewZ^2). The fragment's view-space
    // depth is the one linearDepth() encodes, so -positionView.z = near + linearDepth() * (far - near).
    densityFogFactor: (density: number | IFogNode) => {
      const viewZ = tsl.cameraNear.add(tsl.linearDepth().mul(tsl.cameraFar.sub(tsl.cameraNear)));
      const d = typeof density === "number" ? tsl.float(density) : density;
      return d.mul(d).mul(viewZ).mul(viewZ).negate().exp().oneMinus();
    },
    // r185's fog(color, factor) composes the finished fragment (`output.rgb`), which a native material graph
    // cannot read. The engine mixes it in itself: fog() is the engine node vec4(color, factor) that
    // `scene.fogNode` holds, and the engine's setupFog mixes the colour by the factor in place of `scene.fog`.
    fog: (color: unknown, factor: unknown) => {
      const node = tsl.vec4(color, typeof factor === "number" ? tsl.float(factor) : factor);
      Object.defineProperty(node, "isFogNode", { value: true });
      return node;
    },
    // context() and velocity: the context that carries the previous-frame velocity, and that accessor.
    // The native engine has neither, so they refuse at use, by name.
    context: unsupportedExport("context"),
    velocity: unsupportedExport("velocity"),
  };
}
