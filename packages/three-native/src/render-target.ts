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

/** Bytes a pixel in the rows `read` returns: a FloatType target is RGBA32Float, any other RGBA16Float. */
export function targetTexelBytes(type: number): number {
  return type === FLOAT_TYPE ? 16 : 8;
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
  /**
   * Draws `root` through `camera` into `target`; throws the engine's refusal. `layer` is the array layer
   * of a target made with `depth`, `attachment` the index into its `textures` (three's `count`).
   */
  draw(target: unknown, root: unknown, camera: unknown, layer?: number, attachment?: number): void;
  /** The region's rows in the target's format (see targetTexelBytes), top row first. */
  read(target: unknown, x: number, y: number, width: number, height: number): Promise<Uint8Array>;
}

interface ILayeredTarget {
  readonly depth?: number;
  readonly textures?: ReadonlyArray<{ readonly name?: string }>;
}

interface IMrtMaterial {
  mrtNode?: { readonly isMRTNode?: boolean; readonly outputs?: Readonly<Record<string, unknown>> };
  outputNode?: unknown;
}

/**
 * three's MRT into a target made with `count`: each attachment receives the material's `mrtNode` output
 * named like that texture (three's MRTNode matches outputs to `target.textures[i].name`). The engine
 * draws one attachment at a time, so each draw sets the material's `outputNode` to that output and puts
 * the material's own back afterwards. Attachment 0 with no output of its name draws the material's
 * colour, as three's `output` does; any other attachment with no output is refused by name.
 * ponytail: one draw per attachment; one pass with several colour targets when a hot path needs MRT.
 */
function drawAttachments(
  root: unknown,
  textures: ReadonlyArray<{ readonly name?: string }>,
  draw: (attachment: number) => void,
): void {
  const materials: IMrtMaterial[] = [];
  (root as { traverse?(visit: (object: unknown) => void): void }).traverse?.((object) => {
    const material = (object as { material?: IMrtMaterial | IMrtMaterial[] }).material;
    for (const entry of Array.isArray(material) ? material : material ? [material] : [])
      if (entry.mrtNode?.isMRTNode === true && !materials.includes(entry)) materials.push(entry);
  });
  const previous = materials.map((material) => material.outputNode ?? null);
  try {
    textures.forEach((texture, attachment) => {
      const name = texture.name ?? "";
      for (const material of materials) {
        const outputs = material.mrtNode?.outputs ?? {};
        if (Object.hasOwn(outputs, name)) material.outputNode = outputs[name];
        else if (attachment === 0) material.outputNode = previous[materials.indexOf(material)];
        else
          throw new Error(
            `TN_NATIVE_MRT_UNSUPPORTED: the material's mrtNode has no '${name}' output for attachment ${attachment}`,
          );
      }
      draw(attachment);
    });
  } finally {
    materials.forEach((material, index) => {
      if (material.outputNode !== previous[index]) material.outputNode = previous[index];
    });
  }
}

/**
 * Adds three's setRenderTarget, getRenderTarget, getActiveCubeFace, getActiveMipmapLevel, getMRT, setMRT,
 * initRenderTarget and readRenderTargetPixelsAsync to a renderer facade's prototype, and routes its
 * render() into the current target. `engineOf(renderer)` reaches the engine for that renderer.
 */
export function defineRenderTargets(
  prototype: { render(scene: unknown, camera: unknown): void },
  engineOf: (renderer: object) => IRenderTargetEngine,
): void {
  const targets = new WeakMap<object, { target: unknown; layer: number }>();
  const mrts = new WeakMap<object, unknown>();
  const render = prototype.render;
  Object.assign(prototype, {
    setRenderTarget(
      this: object,
      target: unknown = null,
      activeCubeFace = 0,
      activeMipmapLevel = 0,
    ): void {
      // A target made with `depth` takes the layer where three's cube face goes (three's layered draw).
      const depth = (target as ILayeredTarget | null)?.depth ?? 1;
      if (activeMipmapLevel !== 0 || !(activeCubeFace >= 0 && activeCubeFace < depth))
        throw new Error(
          `TN_NATIVE_RENDER_TARGET_UNSUPPORTED: layer ${activeCubeFace} of a ${depth}-layer target or mip level ${activeMipmapLevel} is not drawn natively`,
        );
      targets.set(this, { target, layer: activeCubeFace });
    },
    getRenderTarget(this: object): unknown {
      return targets.get(this)?.target ?? null;
    },
    getActiveCubeFace(this: object): number {
      return targets.get(this)?.layer ?? 0;
    },
    getActiveMipmapLevel(): number {
      return 0;
    },
    /** three's renderer MRT. The engine's frame pass takes its MRT from pass().setMRT; this only holds it. */
    getMRT(this: object): unknown {
      return mrts.get(this) ?? null;
    },
    setMRT(this: object, mrt: unknown): object {
      mrts.set(this, mrt ?? null);
      return this;
    },
    /** three's initRenderTarget: the engine allocates a target's textures at its first draw or sample. */
    initRenderTarget(): void {},
    render(this: object, scene: unknown, camera: unknown): void {
      const current = targets.get(this);
      const target = current?.target;
      if (target === null || target === undefined) return render.call(this, scene, camera);
      const engine = engineOf(this);
      const textures = (target as ILayeredTarget).textures;
      if (textures === undefined || (textures.length <= 1 && current?.layer === 0))
        return engine.draw(target, scene, camera);
      drawAttachments(scene, textures, (attachment) =>
        engine.draw(target, scene, camera, current?.layer ?? 0, attachment),
      );
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
