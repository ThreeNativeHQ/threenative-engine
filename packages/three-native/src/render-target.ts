/**
 * three's render-target surface on the renderer, shared by both back ends (PRD-551): which target a
 * renderer draws into, the cube-face and mip refusals, and readRenderTargetPixelsAsync's typed array.
 * The engine draws a target and reads it back as RGBA16Float rows (top row first); each back end
 * supplies those two calls, so the renderer facades differ only in how they reach the engine.
 */

const HALF_FLOAT_TYPE = 1016; // three's HalfFloatType
const FLOAT_TYPE = 1015; // three's FloatType

interface IRenderTargetLike {
  readonly texture: { readonly type: number };
}

/** IEEE binary16 bits to a number. */
function halfToFloat(bits: number): number {
  const exponent = (bits >> 10) & 31;
  const mantissa = bits & 1023;
  const magnitude =
    exponent === 0
      ? mantissa * 2 ** -24
      : exponent === 31
        ? mantissa === 0
          ? Number.POSITIVE_INFINITY
          : Number.NaN
        : (mantissa + 1024) * 2 ** (exponent - 25);
  return bits & 0x8000 ? -magnitude : magnitude;
}

/**
 * RGBA16Float rows as three's readRenderTargetPixelsAsync types them for the target's texture type:
 * the half bits as a Uint16Array (HalfFloatType), floats (FloatType), or bytes (UnsignedByteType,
 * each channel clamped to [0, 1] and rounded, as an RGBA8 target stores it).
 */
export function pixelsOfType(
  bytes: Uint8Array,
  type: number,
): Uint8Array | Uint16Array | Float32Array {
  const halves = new Uint16Array(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
  if (type === HALF_FLOAT_TYPE) return halves;
  if (type === FLOAT_TYPE) return Float32Array.from(halves, halfToFloat);
  return Uint8Array.from(halves, (bits) =>
    Math.round(Math.min(1, Math.max(0, halfToFloat(bits))) * 255),
  );
}

/** The engine's two calls for a back end's render targets. */
export interface IRenderTargetEngine {
  /** Draws `root` through `camera` into `target`; throws the engine's refusal. */
  draw(target: unknown, root: unknown, camera: unknown): void;
  /** The region's RGBA16Float rows, top row first. */
  read(target: unknown, x: number, y: number, width: number, height: number): Promise<Uint8Array>;
}

/**
 * Adds three's setRenderTarget, getRenderTarget, getActiveCubeFace, getActiveMipmapLevel and
 * readRenderTargetPixelsAsync to a renderer facade's prototype, and routes its render() into the
 * current target. `engineOf(renderer)` reaches the engine for that renderer.
 */
export function defineRenderTargets(
  prototype: { render(scene: unknown, camera: unknown): void },
  engineOf: (renderer: object) => IRenderTargetEngine,
): void {
  const targets = new WeakMap<object, unknown>();
  const render = prototype.render;
  Object.assign(prototype, {
    setRenderTarget(
      this: object,
      target: unknown = null,
      activeCubeFace = 0,
      activeMipmapLevel = 0,
    ): void {
      if (activeCubeFace !== 0 || activeMipmapLevel !== 0)
        throw new Error(
          "TN_NATIVE_RENDER_TARGET_UNSUPPORTED: a cube face or mip level other than 0 is not drawn natively",
        );
      targets.set(this, target);
    },
    getRenderTarget(this: object): unknown {
      return targets.get(this) ?? null;
    },
    getActiveCubeFace(): number {
      return 0;
    },
    getActiveMipmapLevel(): number {
      return 0;
    },
    render(this: object, scene: unknown, camera: unknown): void {
      const target = targets.get(this);
      if (target === null || target === undefined) render.call(this, scene, camera);
      else engineOf(this).draw(target, scene, camera);
    },
    async readRenderTargetPixelsAsync(
      this: object,
      target: IRenderTargetLike,
      x: number,
      y: number,
      width: number,
      height: number,
    ): Promise<Uint8Array | Uint16Array | Float32Array> {
      const bytes = await engineOf(this).read(target, x, y, width, height);
      return pixelsOfType(bytes, target.texture.type);
    },
  });
}
