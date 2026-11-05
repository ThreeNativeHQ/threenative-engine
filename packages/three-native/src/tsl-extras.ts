import { unsupportedExport } from "./refused.js";

/** The engine TSL functions and inputs the extras compose, read at call time (some are lazy getters). */
interface IExtrasTsl {
  readonly cameraFar: IFogNode;
  readonly cameraNear: IFogNode;
  readonly clamp: (value: unknown, low: number, high: number) => unknown;
  readonly float: (value: number) => IFogNode;
  readonly linearDepth: () => IFogNode;
  // quality-allow: three's TSL export name.
  // biome-ignore lint/style/useNamingConvention: three's TSL export name.
  readonly mx_noise_float: (position: unknown) => IFogNode;
  readonly vec3: (value: unknown) => IFogNode;
  readonly vec2: (
    x: unknown,
    y?: unknown,
  ) => IFogNode & { readonly x: IFogNode; readonly y: IFogNode };
  readonly cos: (value: unknown) => IFogNode;
  readonly sin: (value: unknown) => IFogNode;
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
    // r187's mx_fractal_noise_float(position, octaves, lacunarity, diminish, amplitude)
    // (materialx/MaterialXNoise.js): the octave sum of amplitude * perlin(p), amplitude *= diminish and
    // p *= lacunarity per octave, over p as a vec3. The octave count is a number here, so the loop is
    // unrolled; a node count refuses by name.
    // quality-allow: three's TSL export name.
    // biome-ignore lint/style/useNamingConvention: three's TSL export name.
    mx_fractal_noise_float: (
      position: unknown,
      octaves: unknown = 3,
      lacunarity: number | IFogNode = 2,
      diminish: number | IFogNode = 0.5,
      amplitude: number | IFogNode = 1,
    ) => {
      if (typeof octaves !== "number" || !Number.isInteger(octaves) || octaves < 0 || octaves > 16)
        throw new Error(
          "TN_NATIVE_FRACTAL_OCTAVES: mx_fractal_noise_float needs an integer octave count 0..16 on the native engine",
        );
      const node = (value: number | IFogNode) =>
        typeof value === "number" ? tsl.float(value) : value;
      let p = tsl.vec3(position);
      let weight = tsl.float(1);
      let sum = tsl.float(0);
      for (let octave = 0; octave < octaves; octave += 1) {
        sum = sum.add(weight.mul(tsl.mx_noise_float(p)));
        weight = weight.mul(node(diminish));
        p = p.mul(node(lacunarity));
      }
      return sum.mul(node(amplitude));
    },
    // r187's rotateUV(uv, rotation, center = vec2(0.5)) (utils/UVUtils.js): rotate(uv - center, rotation) + center,
    // where RotateNode turns a vec2 by mat2(cos, sin, -sin, cos).
    rotateUV: (uv: unknown, rotation: unknown, center: unknown = tsl.vec2(0.5, 0.5)) => {
      const p = tsl.vec2(uv).sub(center) as IFogNode & {
        readonly x: IFogNode;
        readonly y: IFogNode;
      };
      const c = tsl.cos(rotation);
      const s = tsl.sin(rotation);
      return tsl.vec2(c.mul(p.x).sub(s.mul(p.y)), s.mul(p.x).add(c.mul(p.y))).add(center);
    },
    // context() and velocity: the context that carries the previous-frame velocity, and that accessor.
    // The native engine has neither, so they refuse at use, by name.
    context: unsupportedExport("context"),
    velocity: unsupportedExport("velocity"),
  };
}
