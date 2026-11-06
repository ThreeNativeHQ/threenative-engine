/**
 * three's render-target surface on the renderer, shared by both back ends (PRD-551): which target a
 * renderer draws into, the cube-face and mip refusals, and readRenderTargetPixelsAsync's typed array.
 * The engine draws a target and reads it back as RGBA16Float rows (top row first); each back end
 * supplies those two calls, so the renderer facades differ only in how they reach the engine.
 */

const HALF_FLOAT_TYPE = 1016; // three's HalfFloatType
const FLOAT_TYPE = 1015; // three's FloatType
const RG_FORMAT = 1030; // three's RGFormat

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

/** Bytes a pixel in the rows `read` returns: float32 channels for FloatType, else half; two for RGFormat, else four. */
export function targetTexelBytes(type: number, format?: number): number {
  return (type === FLOAT_TYPE ? 4 : 2) * (format === RG_FORMAT ? 2 : 4);
}

/**
 * The engine's rows as three's readRenderTargetPixelsAsync types them for the target's texture type:
 * the half bits as a Uint16Array (HalfFloatType), the float32 values as stored (FloatType), or bytes
 * (UnsignedByteType, each channel clamped to [0, 1] and rounded, as an RGBA8 target stores it).
 */
export function pixelsOfType(
  bytes: Uint8Array,
  type: number,
): Uint8Array | Uint16Array | Float32Array {
  const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  if (type === FLOAT_TYPE) return new Float32Array(copy);
  const halves = new Uint16Array(copy);
  if (type === HALF_FLOAT_TYPE) return halves;
  return Uint8Array.from(halves, (bits) =>
    Math.round(Math.min(1, Math.max(0, halfToFloat(bits))) * 255),
  );
}

/** The engine's two calls for a back end's render targets. */
export interface IRenderTargetEngine {
  /** Draws `root` through `camera` into `target` (over its contents when the renderer's autoClear is false); throws the engine's refusal. */
  draw(target: unknown, root: unknown, camera: unknown): void;
  /** Clears `target`'s colour (to the renderer's clear colour) and/or depth. */
  clear(target: unknown, color: boolean, depth: boolean): void;
  /**
   * The region's rows in the target's format (see targetTexelBytes), top row first, of colour
   * attachment `textureIndex` (three's index into `target.textures`).
   */
  read(
    target: unknown,
    x: number,
    y: number,
    width: number,
    height: number,
    textureIndex?: number,
  ): Promise<Uint8Array>;
}

/**
 * Adds three's setRenderTarget, getRenderTarget, getActiveCubeFace, getActiveMipmapLevel, clear,
 * clearColor, clearDepth, clearStencil and readRenderTargetPixelsAsync to a renderer facade's prototype,
 * and routes its render() into the current target. `engineOf(renderer)` reaches the engine for that renderer.
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
    // ponytail: on the canvas clear() is a no-op, because the canvas render clears every frame. A target has no stencil.
    clear(this: object, color = true, depth = true): void {
      const target = targets.get(this);
      if (target !== null && target !== undefined) engineOf(this).clear(target, color, depth);
    },
    clearColor(this: { clear(color: boolean, depth: boolean): void }): void {
      this.clear(true, false);
    },
    clearDepth(this: { clear(color: boolean, depth: boolean): void }): void {
      this.clear(false, true);
    },
    clearStencil(): void {},
    async readRenderTargetPixelsAsync(
      this: object,
      target: IRenderTargetLike,
      x: number,
      y: number,
      width: number,
      height: number,
      textureIndex = 0,
      faceIndex = 0,
    ): Promise<Uint8Array | Uint16Array | Float32Array> {
      if (faceIndex !== 0)
        throw new Error(
          "TN_NATIVE_RENDER_TARGET_UNSUPPORTED: a cube face other than 0 is not read natively",
        );
      const bytes = await engineOf(this).read(target, x, y, width, height, textureIndex);
      // The engine crops tightly, and so does three 0.187.0 (copyTextureToBuffer removes the row
      // padding), so the array a game reads has the same tight stride on both back ends.
      return pixelsOfType(bytes, target.texture.type);
    },
  });
}
