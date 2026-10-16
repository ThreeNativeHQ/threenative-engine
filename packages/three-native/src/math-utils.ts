/**
 * The rest of three r185's number-only `MathUtils` (MIT), verbatim, for the Wasm web back end. The
 * engine binds clamp, lerp, degToRad and euclideanModulo (its registry is the catalog's supported
 * set), and a game written against three calls the others by name (`MathUtils.damp`), so they sit
 * beside the engine class as plain JS and add no engine call.
 */
let seed = 1234567;
const lerp = (x: number, y: number, t: number): number => (1 - t) * x + t * y;
const euclideanModulo = (n: number, m: number): number => ((n % m) + m) % m;

export const mathUtilsExtras = {
  // quality-allow: three's MathUtils constant names.
  // biome-ignore lint/style/useNamingConvention: three's constant names.
  DEG2RAD: Math.PI / 180,
  // quality-allow: three's MathUtils constant names.
  // biome-ignore lint/style/useNamingConvention: three's constant names.
  RAD2DEG: 180 / Math.PI,
  mapLinear: (x: number, a1: number, a2: number, b1: number, b2: number): number =>
    b1 + ((x - a1) * (b2 - b1)) / (a2 - a1),
  inverseLerp: (x: number, y: number, value: number): number =>
    x !== y ? (value - x) / (y - x) : 0,
  damp: (x: number, y: number, lambda: number, dt: number): number =>
    lerp(x, y, 1 - Math.exp(-lambda * dt)),
  pingpong: (x: number, length = 1): number =>
    length - Math.abs(euclideanModulo(x, length * 2) - length),
  smoothstep(x: number, min: number, max: number): number {
    if (x <= min) return 0;
    if (x >= max) return 1;
    const t = (x - min) / (max - min);
    return t * t * (3 - 2 * t);
  },
  smootherstep(x: number, min: number, max: number): number {
    if (x <= min) return 0;
    if (x >= max) return 1;
    const t = (x - min) / (max - min);
    return t * t * t * (t * (t * 6 - 15) + 10);
  },
  randInt: (low: number, high: number): number =>
    low + Math.floor(Math.random() * (high - low + 1)),
  randFloat: (low: number, high: number): number => low + Math.random() * (high - low),
  randFloatSpread: (range: number): number => range * (0.5 - Math.random()),
  seededRandom(s?: number): number {
    if (s !== undefined) seed = s;
    // Mulberry32 generator
    seed += 0x6d2b79f5;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  },
  radToDeg: (radians: number): number => radians * (180 / Math.PI),
  isPowerOfTwo: (value: number): boolean => (value & (value - 1)) === 0 && value !== 0,
  ceilPowerOfTwo: (value: number): number => 2 ** Math.ceil(Math.log(value) / Math.LN2),
  floorPowerOfTwo: (value: number): number => 2 ** Math.floor(Math.log(value) / Math.LN2),
};

/** The engine's MathUtils class with the extras on each instance, which is how three's namespace binds. */
export function withMathUtilsExtras(MathUtils: new () => object): new () => object {
  return class extends MathUtils {
    constructor() {
      super();
      Object.assign(this, mathUtilsExtras);
    }
  };
}
