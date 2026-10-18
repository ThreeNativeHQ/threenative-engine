import {
  Box3,
  type BufferGeometry,
  type Camera,
  Color,
  type CoordinateSystem,
  type Material,
  type Matrix4,
  Mesh,
  NoBlending,
  NoColorSpace,
  OrthographicCamera,
  SRGBColorSpace,
  Scene,
  Sphere,
  type Texture,
  Vector3,
} from "three";
import { diffuseColor, float, mrt, normalWorld, positionView, vec4 } from "three/tsl";
import {
  LinearFilter,
  LinearMipmapLinearFilter,
  type MRTNode,
  MeshBasicNodeMaterial,
  MeshPhysicalNodeMaterial,
  MeshStandardNodeMaterial,
  type NodeMaterial,
  RGBAFormat,
  RenderTarget,
  UnsignedByteType,
} from "three/webgpu";
import { mipAlphaTestNode } from "./foliage-alpha.js";

/**
 * The marker the integration and its playtests key on. Kept here rather than repeated as a literal
 * so the next slice's report line uses one spelling.
 */
export const WORLD_IMPOSTOR_MARKER = "TN_WORLD_IMPOSTOR";

/** Views per atlas row and column: a full-sphere octahedral grid, so `N*N` layers. */
export const IMPOSTOR_VIEW_GRID = 4;
/** Layers the atlas holds: one per view. */
export const IMPOSTOR_VIEWS = IMPOSTOR_VIEW_GRID * IMPOSTOR_VIEW_GRID;
/**
 * Frame edge in texels. Fixed, not derived: the texel rule the prior draft claimed cancelled its
 * own `pixelsPerUnit` and only ever returned a power of two. An honest fixed frame plus the
 * caller's finite atlas budget beats a false adaptive claim.
 */
export const IMPOSTOR_FRAME_PIXELS = 128;

/** One drawable part of one asset level, as the world builds it. Structural, so a stub is the same. */
export interface IImpostorPart {
  readonly geometry: BufferGeometry;
  /** The mesh transform relative to the model root, composed into every instance matrix. */
  readonly local: Matrix4;
  readonly material: Material;
}

/** A signed one for a component, with zero read as positive so the fold is deterministic. */
function signNotZero(value: number): number {
  return value >= 0 ? 1 : -1;
}

/**
 * Centre direction of one grid point of a `grid`x`grid` full-sphere octahedral map.
 *
 * Endpoints, not cell centres: point `ix` runs `u = 2*ix/(N-1) - 1` so the grid's corners are the
 * octahedron's corners and the grid's shared edges are continuous. The last octant folds behind the
 * sphere with `(1-|v|, 1-|u|)`, which is what makes the same grid cover both hemispheres.
 */
export function octahedralViewOf(ix: number, iy: number, grid = IMPOSTOR_VIEW_GRID): Vector3 {
  const u = (2 * ix) / (grid - 1) - 1;
  const v = (2 * iy) / (grid - 1) - 1;
  const z = 1 - Math.abs(u) - Math.abs(v);
  if (z < 0) {
    const x = (1 - Math.abs(v)) * signNotZero(u);
    const y = (1 - Math.abs(u)) * signNotZero(v);
    return new Vector3(x, y, z).normalize();
  }
  return new Vector3(u, v, z).normalize();
}

/** The whole view table, in layer order: index `iy * grid + ix`. */
export const VIEW_DIRECTIONS: readonly Vector3[] = buildViewDirections();

function buildViewDirections(): readonly Vector3[] {
  const out: Vector3[] = [];
  for (let iy = 0; iy < IMPOSTOR_VIEW_GRID; iy += 1)
    for (let ix = 0; ix < IMPOSTOR_VIEW_GRID; ix += 1) out.push(octahedralViewOf(ix, iy));
  return out;
}

/**
 * Project a unit direction onto the octahedral square in `[-1, 1]^2`, folding the back hemisphere.
 * This is the exact inverse of {@link octahedralViewOf}'s decode, so the bake's view table and the
 * next slice's sampler share one frame basis by construction.
 */
function encodeOctahedral(direction: Vector3): { readonly x: number; readonly y: number } {
  const d = direction.clone().normalize();
  const sum = Math.abs(d.x) + Math.abs(d.y) + Math.abs(d.z);
  if (!(sum > 0)) return { x: 0, y: 0 };
  const px = d.x / sum;
  const py = d.y / sum;
  if (d.z >= 0) return { x: px, y: py };
  return {
    x: (1 - Math.abs(py)) * signNotZero(px),
    y: (1 - Math.abs(px)) * signNotZero(py),
  };
}

/** A blend over three view layers, as integer layer indices and normalized weights. */
export interface IViewBlend {
  readonly nearest: readonly [number, number, number];
  readonly weights: readonly [number, number, number];
}

/**
 * The three octahedral grid corners around `direction`, and their non-negative weights summing to
 * one.
 *
 * Pure arithmetic over the shared encode, so the next surface's TSL sampler and this test read the
 * same grid. The shared-edge tie always lands the lower cell's `fx+fy<=1` branch, which keeps the
 * blend continuous across every cell boundary and never produces the degenerate all-zero set the
 * prior dot-product draft returned when three directions were tied.
 */
export function impostorViewWeights(direction: Vector3): IViewBlend {
  const grid = IMPOSTOR_VIEW_GRID;
  const p = encodeOctahedral(direction);
  const gx = (p.x * 0.5 + 0.5) * (grid - 1);
  const gy = (p.y * 0.5 + 0.5) * (grid - 1);
  const cx = Math.min(grid - 2, Math.max(0, Math.floor(gx)));
  const cy = Math.min(grid - 2, Math.max(0, Math.floor(gy)));
  const fx = gx - cx;
  const fy = gy - cy;
  const layer = (ix: number, iy: number) => iy * grid + ix;
  if (fx + fy <= 1) {
    return {
      nearest: [layer(cx, cy), layer(cx + 1, cy), layer(cx, cy + 1)] as const,
      weights: [1 - fx - fy, fx, fy] as const,
    };
  }
  // Same corners in the same `11, 01, 10` order the mailbox fix names; the weight beside each
  // corner is the barycentric one, so `01 = (cx, cy+1)` takes `1-fx` and `10 = (cx+1, cy)` takes
  // `1-fy`. Reconstructing the grid coordinate from these weights is what the test checks.
  return {
    nearest: [layer(cx + 1, cy + 1), layer(cx, cy + 1), layer(cx + 1, cy)] as const,
    weights: [fx + fy - 1, 1 - fx, 1 - fy] as const,
  };
}

/** The source bounds of every transformed part, as a centre and a radius. */
export function impostorBounds(parts: readonly IImpostorPart[]): {
  readonly center: Vector3;
  readonly radius: number;
} {
  const whole = new Box3();
  whole.makeEmpty();
  const localBox = new Box3();
  let any = false;
  for (const part of parts) {
    const geometry = part.geometry;
    if (geometry.boundingBox === null) geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    if (box === null) continue;
    // `Box3.applyMatrix4` transforms all eight corners, so a rotated part's world AABB is its true
    // extrema — reading only `min`/`max` through the matrix, as the prior draft did, is not.
    localBox.copy(box).applyMatrix4(part.local);
    whole.union(localBox);
    any = true;
  }
  if (!any) return { center: new Vector3(), radius: 0.5 };
  const center = whole.getCenter(new Vector3());
  const radius = whole.getBoundingSphere(new Sphere()).radius;
  return { center, radius: radius > 0 ? radius : 0.5 };
}

/** The exact byte cost of a mip chain of `levels` RGBA8 levels at `pixels` square and `depth` deep. */
function mipChainBytes(pixels: number, depth: number, levels: number): number {
  let bytes = 0;
  for (let level = 0; level < levels; level += 1) {
    const edge = Math.max(1, pixels >> level);
    bytes += edge * edge * depth * 4;
  }
  return bytes;
}

/**
 * The octahedral atlas: every view of one asset, albedo and coverage in one array, the baked
 * object-space normal and stored ortho depth in another.
 *
 * One atlas is one asset's whole far representation. Nothing here decides appearance: the colour is
 * whatever the asset's own surface drew and the normal is the geometry's own. Both attachments carry
 * a full mip chain so the next surface can compensate the cutout cutoff by mip level.
 */
export class WorldImpostorAtlas {
  readonly target: RenderTarget;
  readonly pixels: number;
  readonly bytes: number;
  readonly #color: Texture;
  readonly #normal: Texture;

  constructor(pixels: number) {
    if (!Number.isInteger(pixels) || pixels <= 0) {
      throw new Error(`WorldImpostorAtlas pixels must be a positive integer, received ${pixels}.`);
    }
    this.pixels = pixels;
    this.target = new RenderTarget(pixels, pixels, {
      count: 2,
      depth: IMPOSTOR_VIEWS,
      format: RGBAFormat,
      type: UnsignedByteType,
      generateMipmaps: true,
      magFilter: LinearFilter,
      minFilter: LinearMipmapLinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
    });
    this.#color = this.target.textures[0] as Texture;
    this.#normal = this.target.textures[1] as Texture;
    // MRT keys are looked up by name on the target's textures, so the names have to be the ones the
    // bake's `mrt()` node uses; see `getTextureIndex` in three's MRTNode.
    this.#color.name = "output";
    this.#normal.name = "normal";
    this.#color.colorSpace = SRGBColorSpace;
    this.#normal.colorSpace = NoColorSpace;
    const levels = Math.floor(Math.log2(Math.max(1, pixels))) + 1;
    this.bytes = 2 * mipChainBytes(pixels, IMPOSTOR_VIEWS, levels);
  }

  get color(): Texture {
    return this.#color;
  }

  get normal(): Texture {
    return this.#normal;
  }

  dispose(): void {
    this.target.dispose();
  }
}

/**
 * The raw three renderer seam the bake needs: layered targets, MRT, clear state and render-target
 * initialisation. Structural, so a stub in a test is the same input. `render` is three's own and
 * `initRenderTarget` is three's public `Renderer.initRenderTarget`, which allocates the target's
 * textures — and their mip levels when `generateMipmaps` is set — without drawing.
 */
export interface IImpostorRawRenderer {
  readonly coordinateSystem?: CoordinateSystem;
  render(scene: Scene, camera: Camera): void;
  setRenderTarget(target: unknown, activeCubeFace?: number, activeMipmapLevel?: number): void;
  getRenderTarget?(): unknown;
  getActiveCubeFace?(): number;
  getActiveMipmapLevel?(): number;
  getMRT?(): unknown;
  setMRT?(mrt: unknown): unknown;
  xr?: { enabled: boolean };
  autoClear?: boolean;
  getClearAlpha?(): number;
  setClearAlpha?(alpha: number): void;
  /**
   * Three's public `Renderer.getClearColor(target)` requires a `Color` target; the baker passes a
   * fresh one and clones the result, so the renderer's own object is never mutated.
   */
  getClearColor?(target: Color): unknown;
  setClearColor?(color: unknown, alpha?: number): void;
  /** Three's public `Renderer.initRenderTarget`: allocate a target's textures, allocate mip levels. */
  initRenderTarget(target: RenderTarget): void;
}

const NODE_CLASSES: ReadonlyMap<string, new () => NodeMaterial> = new Map<
  string,
  new () => NodeMaterial
>([
  ["MeshBasicMaterial", MeshBasicNodeMaterial],
  ["MeshPhysicalMaterial", MeshPhysicalNodeMaterial],
  ["MeshStandardMaterial", MeshStandardNodeMaterial],
]);

/** Properties that must not carry from the source onto its node twin, exactly as foliage-alpha.ts. */
const UNSYNCED = new Set(["_listeners", "id", "uuid", "version"]);

/**
 * How much of the mip chain's alpha loss one mip level is compensated by when the bake captures a
 * cutout. The scatter path draws the same cards with 0.75 (`SCATTER_MIP_ALPHA_SCALE`), and the bake
 * has to keep at least what that path keeps, or a tree's impostor holds less than the tree it
 * replaces. Measured on Machinefall: the pine atlas alpha coverage went from 3.7% to 13.5%.
 */
export const IMPOSTOR_BAKE_MIP_ALPHA_SCALE = 0.75;

/** A node twin of a source material: its class, every value it authored, by reference. */
function cloneNodeMaterial(source: Material): NodeMaterial {
  if (Reflect.get(source, "isNodeMaterial") === true) return (source as NodeMaterial).clone();
  const nodeClass = NODE_CLASSES.get(source.type);
  if (nodeClass === undefined) {
    throw new Error(`WorldImpostorBaker cannot convert material type '${source.type}' to nodes.`);
  }
  const twin = new nodeClass();
  for (const key in source)
    if (!UNSYNCED.has(key)) Reflect.set(twin, key, Reflect.get(source, key));
  return twin;
}

/**
 * The capture material for one source part: the source's own albedo and normal, written to the two
 * attachments unlit.
 *
 * `NoBlending` is deliberate. The alpha test's `discard` already carves the silhouette, so the
 * coverage is not at risk of disappearing. What `builder.isOpaque()` costs is the fractional
 * coverage on soft cutout edges: it forces `diffuseColor.a = 1` on every surviving fragment.
 * NoBlending keeps `isOpaque()` false so the surviving alpha is written, and replaces instead of
 * compositing, which is the honest answer for one nearest surface per view.
 *
 * `normalWorld` is the current name of the node the mailbox calls `transformedNormalWorld`; in the
 * installed three the deprecated symbol returns it verbatim. It derives from the material's own
 * `setupNormal`, so the authored normal map travels into the second attachment.
 */
function captureMaterial(source: Material, alphaTest: number, depthScale: number): NodeMaterial {
  const material = cloneNodeMaterial(source);
  const coverage = diffuseColor.a;
  const encodedNormal = normalWorld.mul(0.5).add(0.5).mul(coverage);
  // Secondary MRT attachments clear to alpha one; clear contributes zero depth numerator.
  const depth = float(1).sub(positionView.z.mul(-depthScale).mul(coverage));
  material.mrtNode = mrt({
    output: vec4(diffuseColor.rgb.mul(coverage), coverage),
    normal: vec4(encodedNormal, depth),
  }) as MRTNode;
  material.transparent = false;
  material.blending = NoBlending;
  material.alphaTest = alphaTest;
  // The same mip-aware cutoff the scatter cutout draws with. The 128 px frame minifies a needle card
  // by many mips, and a plain discard at `alphaTest` deletes every needle: the atlas kept the trunk
  // and nothing else. `alphaTest` stays the authored number for readers that only take a number.
  const node = mipAlphaTestNode(source, alphaTest, IMPOSTOR_BAKE_MIP_ALPHA_SCALE);
  if (node !== undefined) material.alphaTestNode = node;
  material.depthWrite = true;
  material.depthTest = true;
  material.toneMapped = false;
  material.needsUpdate = true;
  return material;
}

/**
 * An orthographic camera taking in a sphere of `radius` at `center`, facing `-Z` in object space.
 *
 * `up` is the shared frame's vertical: world-up except at the poles, where it flips to `+Z` so the
 * cross product never degenerates. The next slice's sampler must derive the same basis from the
 * same direction.
 */
export function impostorViewCamera(
  center: Vector3,
  radius: number,
  direction: Vector3,
  into = new OrthographicCamera(),
): OrthographicCamera {
  into.left = -radius;
  into.right = radius;
  into.top = radius;
  into.bottom = -radius;
  into.near = 0;
  into.far = 2 * radius;
  into.position.copy(center).addScaledVector(direction, radius);
  const up = Math.abs(direction.y) > 0.999 ? new Vector3(0, 0, 1) : new Vector3(0, 1, 0);
  into.up.copy(up);
  into.lookAt(center);
  into.updateProjectionMatrix();
  into.updateMatrixWorld(true);
  return into;
}

/** Clone a renderer's clear colour so the baker's restore does not depend on the renderer's copy. */
function cloneClearColor(value: unknown): unknown {
  if (value === undefined || value === null) return value;
  const clone = (value as { clone?: () => unknown }).clone;
  return typeof clone === "function" ? clone.call(value) : value;
}

/** One in-flight atlas bake: one asset's parts staged at the model root, captured one view per step. */
export interface IPendingImpostorBake {
  readonly asset: string;
  readonly atlas: WorldImpostorAtlas;
  readonly scene: Scene;
  readonly camera: OrthographicCamera;
  readonly center: Vector3;
  readonly radius: number;
  /** Owned material twins, disposed with the bake; the source materials are never touched. */
  readonly materials: readonly Material[];
  view: number;
}

/** The options one bake is started with. Colour and normal come from the source, never from here. */
export interface IImpostorBakeOptions {
  readonly pixels?: number;
  /** The alpha cutoff that carve's the silhouette; the source's own when it authored one. */
  readonly alphaTest?: number;
}

/**
 * One render-phase slice of an atlas bake, saving and restoring every piece of renderer state the
 * capture touches.
 *
 * The state save/restore follows `probe-volume.ts`'s capture seam: target, face, mip, MRT, clear
 * alpha, clear colour, autoClear and XR are read before the capture and written back in `finally`,
 * so a bake that throws leaves the next real frame exactly as it found the renderer. The mip chain
 * is allocated on the first view and regenerated once after the last, never per view.
 */
export class WorldImpostorBaker {
  #pending: IPendingImpostorBake | undefined;
  #disposed = false;

  get pending(): IPendingImpostorBake | undefined {
    return this.#pending;
  }

  get baking(): boolean {
    return this.#pending !== undefined;
  }

  /** Stage one asset's parts into a private scene and allocate its atlas. */
  begin(
    asset: string,
    parts: readonly IImpostorPart[],
    options: IImpostorBakeOptions = {},
  ): IPendingImpostorBake {
    if (this.#disposed) throw new Error("WorldImpostorBaker.begin called after dispose().");
    if (this.#pending !== undefined)
      throw new Error(
        `WorldImpostorBaker.begin: an atlas bake for '${this.#pending.asset}' is already in flight.`,
      );
    if (parts.length === 0) throw new Error("WorldImpostorBaker.begin requires at least one part.");
    const bounds = impostorBounds(parts);
    const radius = Math.max(bounds.radius, 1e-4);
    const atlas = new WorldImpostorAtlas(options.pixels ?? IMPOSTOR_FRAME_PIXELS);
    const materials: Material[] = [];
    try {
      const scene = new Scene();
      scene.matrixWorldAutoUpdate = false;
      const depthScale = 1 / (2 * radius);
      for (const part of parts) {
        const alphaTest =
          part.material.alphaTest > 0 ? part.material.alphaTest : (options.alphaTest ?? 0.5);
        const material = captureMaterial(part.material, alphaTest, depthScale);
        materials.push(material);
        const mesh = new Mesh(part.geometry, material);
        mesh.matrixAutoUpdate = false;
        mesh.matrix.copy(part.local);
        mesh.matrixWorld.copy(part.local);
        scene.add(mesh);
      }
      const pending: IPendingImpostorBake = {
        asset,
        atlas,
        camera: new OrthographicCamera(),
        center: bounds.center,
        materials,
        radius,
        scene,
        view: 0,
      };
      this.#pending = pending;
      return pending;
    } catch (error) {
      atlas.dispose();
      for (const material of materials) material.dispose();
      throw error;
    }
  }

  /**
   * Capture one view, or finish the bake when the last view is written.
   *
   * Returns the completed atlas on the final call, or `undefined` while views remain. A throw
   * releases the partial atlas and the owned material twins, then rethrows: the caller's source
   * geometry and materials are never disposed here.
   */
  step(renderer: IImpostorRawRenderer): WorldImpostorAtlas | undefined {
    if (this.#disposed) throw new Error("WorldImpostorBaker.step called after dispose().");
    const pending = this.#pending;
    if (pending === undefined) return undefined;
    try {
      this.#captureView(renderer, pending, pending.view);
    } catch (error) {
      this.abort();
      throw error;
    }
    pending.view += 1;
    if (pending.view < IMPOSTOR_VIEWS) return undefined;
    const atlas = pending.atlas;
    this.#pending = undefined;
    for (const material of pending.materials) material.dispose();
    return atlas;
  }

  #captureView(renderer: IImpostorRawRenderer, pending: IPendingImpostorBake, view: number): void {
    const atlas = pending.atlas;
    const color = atlas.color;
    const normal = atlas.normal;
    const previousTarget = renderer.getRenderTarget?.() ?? null;
    const previousFace = renderer.getActiveCubeFace?.() ?? 0;
    const previousMip = renderer.getActiveMipmapLevel?.() ?? 0;
    const previousMrt = renderer.getMRT?.() ?? null;
    const previousXr = renderer.xr?.enabled;
    const previousAutoClear = renderer.autoClear;
    const previousClearAlpha = renderer.getClearAlpha?.();
    const previousClearColor = cloneClearColor(renderer.getClearColor?.(new Color()));
    const last = view === IMPOSTOR_VIEWS - 1;
    // The camera's projection convention follows the renderer's before the projection is built.
    if (renderer.coordinateSystem !== undefined)
      pending.camera.coordinateSystem = renderer.coordinateSystem;
    const direction = VIEW_DIRECTIONS[view] as Vector3;
    impostorViewCamera(pending.center, pending.radius, direction, pending.camera);
    // Allocate the mip chain once through the public seam, then leave generation off for the first
    // fifteen passes and on for the final one, where three's own finishRender generates every layer.
    if (view === 0) {
      color.generateMipmaps = true;
      normal.generateMipmaps = true;
      renderer.initRenderTarget(atlas.target);
    }
    color.generateMipmaps = last;
    normal.generateMipmaps = last;
    try {
      if (renderer.xr !== undefined) renderer.xr.enabled = false;
      renderer.autoClear = true;
      renderer.setMRT?.(null);
      renderer.setClearAlpha?.(0);
      renderer.setClearColor?.(0x000000, 0);
      renderer.setRenderTarget(atlas.target, view, 0);
      renderer.render(pending.scene, pending.camera);
    } finally {
      renderer.setRenderTarget(previousTarget, previousFace, previousMip);
      renderer.setMRT?.(previousMrt);
      if (renderer.xr !== undefined && previousXr !== undefined) renderer.xr.enabled = previousXr;
      renderer.autoClear = previousAutoClear;
      if (previousClearAlpha !== undefined) renderer.setClearAlpha?.(previousClearAlpha);
      if (previousClearColor !== undefined)
        renderer.setClearColor?.(previousClearColor, previousClearAlpha);
      color.generateMipmaps = true;
      normal.generateMipmaps = true;
    }
  }

  /** Dispose a partial bake's atlas and material twins; idempotent. */
  abort(): void {
    const pending = this.#pending;
    this.#pending = undefined;
    if (pending === undefined) return;
    pending.atlas.dispose();
    for (const material of pending.materials) material.dispose();
  }

  /** Abort and close the baker; idempotent. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.abort();
  }
}
