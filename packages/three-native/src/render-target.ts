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

/** A cube or 3D target's 2D layer target and its layer count (see defineLayeredTargets). */
const layered = new WeakMap<object, { readonly layer: object; readonly layers: number }>();

interface IViewportLike {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

/** A layered target draws whole layers: a partial viewport or a scissor is refused, not ignored. */
function assertWholeLayer(target: {
  readonly width: number;
  readonly height: number;
  readonly viewport: IViewportLike;
  readonly scissorTest: boolean;
}): void {
  const { viewport } = target;
  if (
    target.scissorTest ||
    viewport.x !== 0 ||
    viewport.y !== 0 ||
    viewport.z !== target.width ||
    viewport.w !== target.height
  )
    throw new Error(
      "TN_NATIVE_RENDER_TARGET_UNSUPPORTED: a cube or 3D target draws whole layers natively (full viewport, no scissor)",
    );
}
/** The layered textures each renderer has created on the GPU (three's initTexture before the first copy). */
const initialized = new WeakMap<object, WeakSet<object>>();

interface ILayeredRenderer {
  initTexture(texture: unknown): void;
  copyTextureToTexture(
    source: unknown,
    destination: unknown,
    srcRegion: IRegionLike | null,
    dstPosition: IPositionLike | null,
  ): void;
}

/** Copies a layered target's layer target into its texture at `face` (a cube face or a 3D slice). */
function copyLayer(
  renderer: object,
  target: { readonly texture: object },
  layer: object,
  face: number,
): void {
  const gpu = renderer as ILayeredRenderer;
  const created = initialized.get(renderer) ?? new WeakSet<object>();
  initialized.set(renderer, created);
  if (!created.has(target.texture)) {
    gpu.initTexture(target.texture);
    created.add(target.texture);
  }
  const texture = (layer as { readonly texture: object }).texture;
  gpu.copyTextureToTexture(texture, target.texture, null, { x: 0, y: 0, z: face });
}

/**
 * Adds three's setRenderTarget, getRenderTarget, getActiveCubeFace, getActiveMipmapLevel, clear,
 * clearColor, clearDepth, clearStencil and readRenderTargetPixelsAsync to a renderer facade's prototype,
 * and routes its render() into the current target. `engineOf(renderer)` reaches the engine for that renderer.
 * A cube face or 3D slice (`activeCubeFace`) draws into the target's 2D layer target, then is copied into
 * its texture at that layer.
 * ponytail: one layer copy per draw; render into a layer view when a profile shows cube or volume
 * captures cost.
 */
export function defineRenderTargets(
  prototype: { render(scene: unknown, camera: unknown): void },
  engineOf: (renderer: object) => IRenderTargetEngine,
): void {
  const targets = new WeakMap<object, unknown>();
  const faces = new WeakMap<object, number>();
  const render = prototype.render;
  Object.assign(prototype, {
    // three's WebGPURenderer works in WebGPU clip space (z in [0, 1]); CubeCamera orients its faces by it.
    coordinateSystem: 2001,
    setRenderTarget(
      this: object,
      target: unknown = null,
      activeCubeFace = 0,
      activeMipmapLevel = 0,
    ): void {
      const layers =
        typeof target === "object" && target !== null ? layered.get(target)?.layers : undefined;
      if (activeMipmapLevel !== 0)
        throw new Error(
          "TN_NATIVE_RENDER_TARGET_UNSUPPORTED: a mip level other than 0 is not drawn natively",
        );
      if (activeCubeFace !== 0 && layers === undefined)
        throw new Error(
          "TN_NATIVE_RENDER_TARGET_UNSUPPORTED: a layer other than 0 needs a CubeRenderTarget or RenderTarget3D",
        );
      if (
        layers !== undefined &&
        !(Number.isInteger(activeCubeFace) && activeCubeFace >= 0 && activeCubeFace < layers)
      )
        throw new RangeError(
          `TN_NATIVE_RENDER_TARGET_LAYER: layer ${activeCubeFace} is outside 0 to ${layers - 1}`,
        );
      targets.set(this, target);
      faces.set(this, activeCubeFace);
    },
    getRenderTarget(this: object): unknown {
      return targets.get(this) ?? null;
    },
    getActiveCubeFace(this: object): number {
      return faces.get(this) ?? 0;
    },
    getActiveMipmapLevel(): number {
      return 0;
    },
    render(this: object, scene: unknown, camera: unknown): void {
      const target = targets.get(this);
      const layer = target ? layered.get(target)?.layer : undefined;
      if (target === null || target === undefined) render.call(this, scene, camera);
      else if (layer === undefined) engineOf(this).draw(target, scene, camera);
      else {
        assertWholeLayer(target as Parameters<typeof assertWholeLayer>[0]);
        engineOf(this).draw(layer, scene, camera);
        copyLayer(this, target as { texture: object }, layer, faces.get(this) ?? 0);
      }
    },
    // ponytail: on the canvas clear() is a no-op, because the canvas render clears every frame. A target has no stencil.
    clear(this: object, color = true, depth = true): void {
      const target = targets.get(this);
      if (target === null || target === undefined) return;
      const layer = layered.get(target as object)?.layer;
      engineOf(this).clear(layer ?? target, color, depth);
      if (layer !== undefined && color)
        copyLayer(this, target as { texture: object }, layer, faces.get(this) ?? 0);
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
      if (faceIndex !== 0 || layered.has(target))
        throw new Error(
          "TN_NATIVE_RENDER_TARGET_UNSUPPORTED: a cube or 3D target is not read natively",
        );
      const bytes = await engineOf(this).read(target, x, y, width, height, textureIndex);
      // The engine crops tightly, and so does three 0.187.0 (copyTextureToBuffer removes the row
      // padding), so the array a game reads has the same tight stride on both back ends.
      return pixelsOfType(bytes, target.texture.type);
    },
  });
}

/** three's Box2 and Box3 as a texture copy reads them: a region by its corners. */
export interface IRegionLike {
  readonly isBox3?: boolean;
  readonly min: { readonly x: number; readonly y: number; readonly z?: number };
  readonly max: { readonly x: number; readonly y: number; readonly z?: number };
}

/** A Vector2 or Vector3: the destination origin of a texture copy, z the array layer. */
export interface IPositionLike {
  readonly x: number;
  readonly y: number;
  readonly z?: number;
}

/**
 * three's copyTextureToTexture arguments as both back ends' engine call takes them: the source origin and extent
 * (a negative width takes the source's image size), the destination origin (z the array layer), and the two levels.
 */
export function textureCopyArguments(
  srcRegion: IRegionLike | null,
  dstPosition: IPositionLike | null,
  srcLevel: number,
  dstLevel: number,
): [number, number, number, number, number, number, number, number, number, number, number] {
  const { min, max } = srcRegion ?? {};
  // A Box2 has no z: its depth is one layer, a Box3's its own.
  const size =
    min && max ? [max.x - min.x, max.y - min.y, (max.z ?? 1) - (min.z ?? 0)] : [-1, -1, 1];
  return [
    min?.x ?? 0,
    min?.y ?? 0,
    min?.z ?? 0,
    size[0] as number,
    size[1] as number,
    srcRegion?.isBox3 ? (size[2] as number) : 1,
    dstPosition?.x ?? 0,
    dstPosition?.y ?? 0,
    dstPosition?.z ?? 0,
    srcLevel,
    dstLevel,
  ];
}

type Constructor = new (...args: never[]) => object;

interface IObject3DLike {
  readonly children: readonly object[];
  readonly layers: { mask: number };
  parent: object | null;
  add(object: object): void;
  remove(object: object): void;
  updateMatrixWorld(force?: boolean): void;
}

interface ICubeFaceCamera {
  readonly layers: { mask: number };
  readonly up: { set(x: number, y: number, z: number): void };
  lookAt(x: number, y: number, z: number): void;
  updateMatrixWorld(force?: boolean): void;
}

interface IRendererLike {
  coordinateSystem?: number;
  autoClear?: boolean;
  reversedDepthBuffer?: boolean;
  xr?: { enabled: boolean };
  getRenderTarget(): unknown;
  getActiveCubeFace(): number;
  getActiveMipmapLevel(): number;
  setRenderTarget(target: unknown, activeCubeFace?: number, activeMipmapLevel?: number): void;
  render(scene: unknown, camera: unknown): void;
  clearDepth(): void;
}

interface ITargetTexture {
  type: number;
  minFilter: number;
  magFilter: number;
  generateMipmaps: boolean;
  isRenderTargetTexture?: boolean;
  needsPMREMUpdate?: boolean;
  mipmapsAutoUpdate?: boolean;
  dispose(): void;
}

interface ITargetOptions {
  readonly type?: number;
  readonly minFilter?: number;
  readonly magFilter?: number;
  readonly generateMipmaps?: boolean;
  readonly [option: string]: unknown;
}

const LINEAR_FILTER = 1006; // three's LinearFilter
const UNSIGNED_BYTE_TYPE = 1009; // three's UnsignedByteType
const WEBGL_COORDINATES = 2000; // three's WebGLCoordinateSystem
const WEBGPU_COORDINATES = 2001; // three's WebGPUCoordinateSystem

/** RenderTarget._setTextureOptions (three r187 core/RenderTarget.js): the options a target's texture takes. */
function setTextureOptions(texture: ITargetTexture, options: ITargetOptions): void {
  texture.type = options.type ?? UNSIGNED_BYTE_TYPE;
  texture.minFilter = options.minFilter ?? LINEAR_FILTER;
  texture.magFilter = options.magFilter ?? LINEAR_FILTER;
  texture.generateMipmaps = options.generateMipmaps ?? false;
  texture.isRenderTargetTexture = true;
}

/**
 * three r187's CubeRenderTarget, RenderTarget3D and CubeCamera over the engine classes, shared by both back
 * ends (PRD-854). Each target draws a layer into a 2D engine RenderTarget of the same options, which the
 * renderer copies into the texture at that layer (defineRenderTargets): a CubeTexture of six faces, or a
 * Data3DTexture of `depth` slices. CubeCamera is three's own, over the engine Object3D and PerspectiveCamera.
 */
export function defineLayeredTargets(
  classes: Readonly<
    Record<
      | "RenderTarget"
      | "CubeTexture"
      | "Data3DTexture"
      | "Object3D"
      | "PerspectiveCamera"
      | "Vector4",
      Constructor
    >
  >,
) {
  const Vector4 = classes.Vector4 as new (
    x: number,
    y: number,
    z: number,
    w: number,
  ) => IViewportLike;
  const RenderTarget = classes.RenderTarget as new (
    width: number,
    height: number,
    options: ITargetOptions,
  ) => { setSize(width: number, height: number): void; dispose(): void };
  const CubeTexture = classes.CubeTexture as new (images: readonly object[]) => ITargetTexture;
  const Data3DTexture = classes.Data3DTexture as new (
    data: null,
    width: number,
    height: number,
    depth: number,
  ) => ITargetTexture;
  const Object3D = classes.Object3D as new () => IObject3DLike;
  const PerspectiveCamera = classes.PerspectiveCamera as new (
    fov: number,
    aspect: number,
    near: number,
    far: number,
  ) => ICubeFaceCamera;

  /** three's CubeRenderTarget(size, options): six square faces, each drawn with `setRenderTarget(target, face)`. */
  class CubeRenderTarget {
    readonly isRenderTarget = true;
    readonly isWebGLCubeRenderTarget = true;
    readonly isCubeRenderTarget = true;
    width: number;
    height: number;
    readonly depth = 1;
    readonly texture: ITargetTexture;
    readonly viewport: IViewportLike;
    readonly scissor: IViewportLike;
    scissorTest = false;
    readonly #layer: ReturnType<typeof layerTarget>;

    constructor(size = 1, options: ITargetOptions = {}) {
      this.width = this.height = size;
      this.viewport = new Vector4(0, 0, size, size);
      this.scissor = new Vector4(0, 0, size, size);
      const image = { width: size, height: size, depth: 1 };
      this.texture = new CubeTexture([image, image, image, image, image, image]);
      setTextureOptions(this.texture, options);
      this.#layer = layerTarget(this, size, size, 6, options);
    }

    setSize(width: number, height: number): void {
      if (width !== this.width || height !== this.height)
        throw new Error(
          "TN_NATIVE_RENDER_TARGET_UNSUPPORTED: a CubeRenderTarget keeps its size natively",
        );
    }

    fromEquirectangularTexture(): never {
      throw new Error(
        "TN_NATIVE_UNSUPPORTED_CUBERENDERTARGET: fromEquirectangularTexture is not available natively; set the equirectangular texture as the scene background",
      );
    }

    dispose(): void {
      this.#layer.dispose();
      this.texture.dispose();
    }
  }

  /** three's RenderTarget3D(width, height, depth, options): `depth` slices, each drawn with `setRenderTarget(target, slice)`. */
  class RenderTarget3D {
    readonly isRenderTarget = true;
    readonly isRenderTarget3D = true;
    width: number;
    height: number;
    readonly depth: number;
    readonly texture: ITargetTexture;
    readonly viewport: IViewportLike;
    readonly scissor: IViewportLike;
    scissorTest = false;
    readonly #layer: ReturnType<typeof layerTarget>;

    constructor(width = 1, height = 1, depth = 1, options: ITargetOptions = {}) {
      this.width = width;
      this.height = height;
      this.viewport = new Vector4(0, 0, width, height);
      this.scissor = new Vector4(0, 0, width, height);
      this.depth = depth;
      this.texture = new Data3DTexture(null, width, height, depth);
      setTextureOptions(this.texture, options);
      this.#layer = layerTarget(this, width, height, depth, options);
    }

    setSize(width: number, height: number, depth = this.depth): void {
      if (width !== this.width || height !== this.height || depth !== this.depth)
        throw new Error(
          "TN_NATIVE_RENDER_TARGET_UNSUPPORTED: a RenderTarget3D keeps its size natively",
        );
    }

    dispose(): void {
      this.#layer.dispose();
      this.texture.dispose();
    }
  }

  function layerTarget(
    target: object,
    width: number,
    height: number,
    layers: number,
    options: ITargetOptions,
  ) {
    const layer = new RenderTarget(width, height, { ...options, generateMipmaps: false });
    layered.set(target, { layer, layers });
    return layer;
  }

  const fov = -90; // negative fov to not invert the faces (three's CubeCamera)
  const aspect = 1;

  /** three r187's CubeCamera (cameras/CubeCamera.js), ported as written. */
  class CubeCamera extends Object3D {
    readonly type = "CubeCamera";
    renderTarget: CubeRenderTarget;
    coordinateSystem: number | null = null;
    activeMipmapLevel = 0;

    constructor(near: number, far: number, renderTarget: CubeRenderTarget) {
      super();
      this.renderTarget = renderTarget;
      for (let face = 0; face < 6; face += 1) {
        const camera = new PerspectiveCamera(fov, aspect, near, far);
        // three shares the CubeCamera's Layers with each face; an engine camera owns its Layers, so the mask is
        // copied here and again on update().
        camera.layers.mask = this.layers.mask;
        this.add(camera);
      }
    }

    updateCoordinateSystem(): void {
      const coordinateSystem = this.coordinateSystem;
      const cameras = this.children.concat() as ICubeFaceCamera[];
      const [cameraPX, cameraNX, cameraPY, cameraNY, cameraPZ, cameraNZ] = cameras as [
        ICubeFaceCamera,
        ICubeFaceCamera,
        ICubeFaceCamera,
        ICubeFaceCamera,
        ICubeFaceCamera,
        ICubeFaceCamera,
      ];
      for (const camera of cameras) this.remove(camera as object);
      if (coordinateSystem === WEBGL_COORDINATES) {
        cameraPX.up.set(0, 1, 0);
        cameraPX.lookAt(1, 0, 0);
        cameraNX.up.set(0, 1, 0);
        cameraNX.lookAt(-1, 0, 0);
        cameraPY.up.set(0, 0, -1);
        cameraPY.lookAt(0, 1, 0);
        cameraNY.up.set(0, 0, 1);
        cameraNY.lookAt(0, -1, 0);
        cameraPZ.up.set(0, 1, 0);
        cameraPZ.lookAt(0, 0, 1);
        cameraNZ.up.set(0, 1, 0);
        cameraNZ.lookAt(0, 0, -1);
      } else if (coordinateSystem === WEBGPU_COORDINATES) {
        cameraPX.up.set(0, -1, 0);
        cameraPX.lookAt(-1, 0, 0);
        cameraNX.up.set(0, -1, 0);
        cameraNX.lookAt(1, 0, 0);
        cameraPY.up.set(0, 0, 1);
        cameraPY.lookAt(0, 1, 0);
        cameraNY.up.set(0, 0, -1);
        cameraNY.lookAt(0, -1, 0);
        cameraPZ.up.set(0, -1, 0);
        cameraPZ.lookAt(0, 0, 1);
        cameraNZ.up.set(0, -1, 0);
        cameraNZ.lookAt(0, 0, -1);
      } else {
        throw new Error(
          `THREE.CubeCamera.updateCoordinateSystem(): Invalid coordinate system: ${coordinateSystem}`,
        );
      }
      for (const camera of cameras) {
        this.add(camera as object);
        camera.updateMatrixWorld();
      }
    }

    update(renderer: IRendererLike, scene: unknown): void {
      if (this.parent === null) this.updateMatrixWorld();
      const { renderTarget, activeMipmapLevel } = this;
      if (this.coordinateSystem !== renderer.coordinateSystem) {
        this.coordinateSystem = renderer.coordinateSystem ?? null;
        this.updateCoordinateSystem();
      }
      const cameras = this.children;
      for (const camera of cameras as readonly ICubeFaceCamera[])
        camera.layers.mask = this.layers.mask;
      const currentRenderTarget = renderer.getRenderTarget();
      const currentActiveCubeFace = renderer.getActiveCubeFace();
      const currentActiveMipmapLevel = renderer.getActiveMipmapLevel();
      const currentXrEnabled = renderer.xr?.enabled;
      if (renderer.xr !== undefined) renderer.xr.enabled = false;
      const reversedDepthBuffer = renderer.reversedDepthBuffer === true;
      for (let face = 0; face < 6; face += 1) {
        renderer.setRenderTarget(renderTarget, face, activeMipmapLevel);
        if (reversedDepthBuffer && renderer.autoClear === false) renderer.clearDepth();
        renderer.render(scene, cameras[face]);
      }
      renderer.setRenderTarget(
        currentRenderTarget,
        currentActiveCubeFace,
        currentActiveMipmapLevel,
      );
      if (renderer.xr !== undefined && currentXrEnabled !== undefined)
        renderer.xr.enabled = currentXrEnabled;
      renderTarget.texture.needsPMREMUpdate = true;
    }
  }

  return { CubeRenderTarget, RenderTarget3D, CubeCamera };
}
