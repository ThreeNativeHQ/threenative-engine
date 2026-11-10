import {
  Box3,
  BufferGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Float32BufferAttribute,
  type InstancedBufferAttribute,
  InstancedInterleavedBuffer,
  type Material,
  Sphere,
  Vector3,
} from "three";
import {
  Break,
  Fn,
  If,
  Loop,
  abs,
  attribute,
  cameraPosition,
  cameraProjectionMatrix,
  cameraViewMatrix,
  clamp,
  cross,
  dFdx,
  dFdy,
  dot,
  element,
  float,
  floor,
  fract,
  instanceIndex,
  instancedBufferAttribute,
  instancedDynamicBufferAttribute,
  length,
  log2,
  mat3,
  mat4,
  max,
  min,
  modelWorldMatrix,
  normalize,
  positionGeometry,
  screenCoordinate,
  select,
  sin,
  storage,
  texture,
  transformNormal,
  uniform,
  varying,
  varyingProperty,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import * as threeTsl from "three/tsl";
import {
  EventNode,
  MeshBasicNodeMaterial,
  MeshPhysicalNodeMaterial,
  MeshStandardNodeMaterial,
  type Node,
  type NodeBuilder,
  type NodeMaterial,
} from "three/webgpu";
import { IMPOSTOR_VIEW_GRID, type WorldImpostorAtlas } from "./world-impostor.js";

type InstanceMatrixFn = () => Node<"mat4">;
/**
 * The owned engine's drawn-instance matrix, identity for a plain mesh. The engine compiles a node
 * material once per variant, so a `Fn` cannot read `builder.object`; the web engine hands the node over
 * in `__tnTsl`, the V8 player as a `three/tsl` name. Upstream three has neither and keeps the builder
 * path below. Read through `Reflect` so a bundler does not resolve a name upstream does not export.
 */
const engineInstanceMatrix = (Reflect.get(threeTsl, "instanceMatrix") ??
  (Reflect.get(threeTsl, "__tnTsl") as Record<string, unknown> | undefined)?.instanceMatrix) as
  | InstanceMatrixFn
  | undefined;

/** The surface reconstructs alpha-covered ray/depth crossings in the three neighboring views. */
export const IMPOSTOR_SURFACE_PARALLAX = true;

/** Mip compensation for the impostor cutout, the scattered-foliage constant: 0.25 drops needles. */
export const IMPOSTOR_MIP_ALPHA_SCALE = 0.75;

/** The alpha cutoff a source part gets when it authored none; the same 0.5 the scatter path uses. */
const DEFAULT_ALPHA_TEST = 0.5;
/** The positive alpha number the shadow pass copies; see the material setup in `WorldImpostorSurface`. */
const IMPOSTOR_SHADOW_ALPHA_FLOOR = 1e-4;

/**
 * The per-instance view-distance attribute a far aggregate writes: one float per placement, the
 * asset's own `cullDistance(maxDistance)` or `Infinity` when it authored none. One shared surface
 * per atlas reads it so two canonical ids over one atlas key keep their own cutoffs instead of the
 * first member's, and the value is static, so the attribute is uploaded once and never per frame.
 */
export const IMPOSTOR_FAR_CULL_ATTRIBUTE = "tnFarCull";

/** The node classes a GLB surface converts to, exactly as foliage-alpha.ts. */
const NODE_CLASSES: ReadonlyMap<string, new () => NodeMaterial> = new Map<
  string,
  new () => NodeMaterial
>([
  ["MeshBasicMaterial", MeshBasicNodeMaterial],
  ["MeshPhysicalMaterial", MeshPhysicalNodeMaterial],
  ["MeshStandardMaterial", MeshStandardNodeMaterial],
]);

/** Never carried from the source onto its node twin, exactly as foliage-alpha.ts. */
const UNSYNCED = new Set(["_listeners", "id", "uuid", "version"]);

/**
 * Maps a source material authored against the source geometry's UVs. Every one of them refers to a
 * UV layout the two-triangle quad does not have, so each is cleared and albedo/normals come only
 * from the baked atlas.
 *
 * The whole family is here, not the classic set: a physical source's `transmissionMap`, `thicknessMap`
 * and specular/iridescence pair are sampled the same way three samples `map` — through
 * `attribute("uv")` — and a quad with no `uv` at all makes every one of them a
 * `Vertex attribute "uv" not found on geometry` warning on every build of that material, for a sample
 * the sampler was already returning as zero.
 */
const GEOMETRY_MAPS = [
  "map",
  "normalMap",
  "roughnessMap",
  "metalnessMap",
  "alphaMap",
  "aoMap",
  "emissiveMap",
  "bumpMap",
  "displacementMap",
  "lightMap",
  "specularMap",
  "clearcoatMap",
  "clearcoatNormalMap",
  "clearcoatRoughnessMap",
  "sheenColorMap",
  "sheenRoughnessMap",
  "iridescenceMap",
  "anisotropyMap",
  "iridescenceThicknessMap",
  "specularColorMap",
  "specularIntensityMap",
  "thicknessMap",
  "transmissionMap",
] as const;

/**
 * The node twins of those maps: a source's surface nodes describe its own mesh (a crown's ao and
 * emissive sample its texture through `attribute("uv")`), which the quad does not have. Its scalar
 * roughness and metalness stay; colour, normal, coverage and the cutout are the atlas's own nodes.
 */
const SURFACE_NODES = [
  "aoNode",
  "emissiveNode",
  "roughnessNode",
  "metalnessNode",
  "maskNode",
] as const;

/** One `mat4` node per CPU instance-matrix attribute, derived once and kept live with its source. */
const INSTANCE_COLUMNS = new WeakMap<InstancedBufferAttribute, InstancedInterleavedBuffer>();

/** The options one impostor surface is built with. Colour and normals come from the atlas. */
export interface IImpostorSurfaceOptions {
  /** The completed bake. Borrowed: this surface never disposes it. */
  readonly atlas: WorldImpostorAtlas;
  /** The baked bounds' centre in asset-local space; see `impostorBounds`. */
  readonly center: Vector3;
  /** The baked bounds' radius in asset-local space. */
  readonly radius: number;
  /**
   * The baked box's half size per asset-local axis (`impostorBounds`). With it the quad fits the
   * box's projection instead of the bounding sphere: a spruce is a quarter of its sphere's square,
   * and every fragment outside it ran the whole lit shader only to be discarded. Omitted, the quad
   * is the sphere's square.
   */
  readonly halfExtents?: Vector3;
  /** The dominant source material; its class, roughness and metalness set the lit surface. */
  readonly source: Material;
  /** The source's own cutoff, or the scatter default. Kept positive for the shadow alpha caster. */
  readonly alphaTest?: number;
  readonly mipScale?: number;
  /**
   * When `true`, this surface is a whole-map far aggregate: the view-distance gate is read per
   * instance from {@link IMPOSTOR_FAR_CULL_ATTRIBUTE} instead of a uniform, so two canonical assets
   * over the same atlas key each honour their own authored `cullDistance(maxDistance)` rather than
   * borrowing the first member's value. It is a main-pass gate only — an orthographic (shadow)
   * camera never culls through it — so a far caster still reaches the virtual-shadow levels.
   */
  readonly cull?: boolean;
}

/** A signed one for a component, with zero read as positive so the fold is deterministic. */
function signNotZeroNode(value: Node<"float">): Node<"float"> {
  return select(value.greaterThanEqual(0), float(1), float(-1));
}

/** The baker's stable-up rule as a node: world-up, or `+Z` at the poles so the cross never dies. */
function frameBasisNode(direction: Node<"vec3">): {
  readonly right: Node<"vec3">;
  readonly up: Node<"vec3">;
} {
  const hint = select(abs(direction.y).greaterThan(0.999), vec3(0, 0, 1), vec3(0, 1, 0));
  const right = normalize(cross(hint, direction));
  const up = normalize(cross(direction, right));
  return { right, up };
}

/** `octahedralViewOf` as a node: endpoints, then the last octant folded behind the sphere. */
function octahedralViewNode(
  ix: Node<"float">,
  iy: Node<"float">,
  grid = IMPOSTOR_VIEW_GRID,
): Node<"vec3"> {
  const n1 = float(grid - 1);
  const u = ix.mul(2).div(n1).sub(1);
  const v = iy.mul(2).div(n1).sub(1);
  const z = float(1).sub(abs(u)).sub(abs(v));
  const folded = vec3(
    float(1).sub(abs(v)).mul(signNotZeroNode(u)),
    float(1).sub(abs(u)).mul(signNotZeroNode(v)),
    z,
  );
  return normalize(select(z.lessThan(0), folded, vec3(u, v, z)));
}

/** `encodeOctahedral` as a node: project a unit direction onto the folded octahedral square. */
function encodeOctahedralNode(direction: Node<"vec3">): Node<"vec2"> {
  const d = normalize(direction);
  const sum = abs(d.x).add(abs(d.y)).add(abs(d.z));
  const px = d.x.div(sum);
  const py = d.y.div(sum);
  const foldedX = float(1).sub(abs(py)).mul(signNotZeroNode(px));
  const foldedY = float(1).sub(abs(px)).mul(signNotZeroNode(py));
  const front = d.z.greaterThanEqual(0);
  return vec2(select(front, px, foldedX), select(front, py, foldedY));
}

/** Golus's mip-aware cutoff, read from the actual atlas UV derivatives of the sampled frames. */
function mipThresholdNode(
  uvs: readonly Node<"vec2">[],
  pixels: number,
  cutoff: number,
  mipScale: number,
): Node<"float"> {
  const size = vec2(pixels, pixels);
  let footprint: Node<"float"> | undefined;
  for (const uv of uvs) {
    const frame = max(length(dFdx(uv).mul(size)), length(dFdy(uv).mul(size)));
    footprint = footprint === undefined ? frame : max(footprint, frame);
  }
  const scale = float(1).add(max(log2(footprint as Node<"float">), float(0)).mul(mipScale));
  return float(cutoff).div(scale);
}

/** The projection's `[3][3]`: zero for perspective, one for orthographic (a shadow camera too). */
function orthographicNode(): Node<"bool"> {
  const column = element(cameraProjectionMatrix as never, 3) as Node<"vec4">;
  return column.w.greaterThan(0.5) as Node<"bool">;
}

/** `mat3` of a `mat4` node; the 0.185 typings only accept the conversion overload directly. */
function asMat3(matrix: Node<"mat4">): Node<"mat3"> {
  // quality-allow: three types `mat4` and `mat3` nodes as unrelated, so both casts cross via `unknown`.
  return mat3(matrix as unknown as Node<"mat3">) as unknown as Node<"mat3">;
}

/**
 * Copy a source instance attribute's ranges and version onto the interleaved buffer a node path
 * derived from it. Without this the derived buffer keeps its first upload and a matrix updated after
 * the first frame never reaches the GPU — `Instance.js` performs the same copy per frame.
 */
export function syncInstanceRanges(
  source: InstancedBufferAttribute,
  derived: InstancedInterleavedBuffer,
): void {
  derived.clearUpdateRanges();
  derived.updateRanges.push(...source.updateRanges);
  if (source.version !== derived.version) derived.version = source.version;
}

/**
 * The event that runs {@link syncInstanceRanges} for one instance attribute: once per frame, the
 * type three's own `Instance.js` sync uses (`OnFrameUpdate`, not re-exported, so built directly).
 * Never OBJECT: world batches are `static`, and three skips a settled static object's OBJECT
 * updates, so an OBJECT sync never ran and the GPU kept the batch's first, zeroed upload.
 */
export function instanceSyncEvent(
  source: InstancedBufferAttribute,
  derived: InstancedInterleavedBuffer,
): EventNode {
  return new EventNode(EventNode.FRAME as ConstructorParameters<typeof EventNode>[0], () =>
    syncInstanceRanges(source, derived),
  );
}

/**
 * The per-instance matrix as a `mat4` node, choosing the path by the attribute three installed.
 *
 * Standard instancing already built the column nodes: reuse those exact nodes and its upload
 * synchronization. Only a custom vertex path without them needs the fallback below.
 * A `StorageInstancedBufferAttribute` is read through `storage(...).element(instanceIndex)`, which
 * is the same seam three's own `Instance.js` uses and which includes the indirect draw's
 * `firstInstance`. A plain CPU `InstancedBufferAttribute` cannot require storage support, so it is
 * read as the same four `instancedBufferAttribute` columns of an `InstancedInterleavedBuffer` over
 * its own array, and a per-frame update copies the attribute's ranges and version onto that
 * derived buffer exactly as `Instance.js` does — a derived buffer nobody re-uploads draws a stale
 * pose. See {@link instanceSyncEvent}.
 */
function instanceMatrixNode(
  attribute: InstancedBufferAttribute,
  builder: NodeBuilder,
): Node<"mat4"> {
  // Reuse Three's actual column nodes: a second interleaved buffer consumes four more locations.
  // Three 0.187 (048e6bea2) builds each column as a `BufferAttributeNode` over an
  // `InterleavedBufferAttribute` view of the matrix; older Three nodes held an
  // `InstancedInterleavedBuffer` over the same array. Both carry that matrix, so both are reused.
  // On a real renderer r187 binds the matrix per object instead (`referenceAttribute`), and only
  // those columns follow the drawn object: a build is shared by every mesh of the program, and
  // `SharedBatch#resize` swaps a mesh's buffer, so a column over the build-time array draws another
  // mesh's or a 64-record buffer past its end, which invalidates the whole recorded bundle.
  const columns = [...(Reflect.get(builder, "nodes") as Iterable<Node>)].filter((node) => {
    if (Reflect.get(node, "isReferenceBufferAttributeNode") === true)
      return Reflect.get(node, "referenceNode")?.property === "instanceMatrix";
    const value = Reflect.get(node, "value");
    if (value?.isInterleavedBufferAttribute === true) return value.data === attribute;
    return (
      value?.isInstancedInterleavedBuffer === true &&
      value.array === attribute.array &&
      Reflect.get(node, "bufferStride") === 16
    );
  });
  if (columns.length === 4) {
    const offsetOf = (node: Node): number => {
      const value = Reflect.get(node, "value");
      return (
        (value?.isInterleavedBufferAttribute === true
          ? value.offset
          : Reflect.get(node, "bufferOffset")) ?? 0
      );
    };
    columns.sort((a, b) => offsetOf(a) - offsetOf(b));
    return mat4(...(columns as [Node<"vec4">, Node<"vec4">, Node<"vec4">, Node<"vec4">]));
  }
  const count = Math.max(attribute.count, 1);
  if (
    (attribute as { isStorageInstancedBufferAttribute?: boolean })
      .isStorageInstancedBufferAttribute === true
  )
    return storage(attribute as never, "mat4", count).element(instanceIndex) as Node<"mat4">;
  let interleaved = INSTANCE_COLUMNS.get(attribute);
  if (interleaved === undefined) {
    interleaved = new InstancedInterleavedBuffer(attribute.array, 16, 1);
    INSTANCE_COLUMNS.set(attribute, interleaved);
  }
  const bufferFn =
    attribute.usage === DynamicDrawUsage
      ? instancedDynamicBufferAttribute
      : instancedBufferAttribute;
  const ownColumns = [
    bufferFn(interleaved, "vec4", 16, 0),
    bufferFn(interleaved, "vec4", 16, 4),
    bufferFn(interleaved, "vec4", 16, 8),
    bufferFn(interleaved, "vec4", 16, 12),
  ];
  instanceSyncEvent(attribute, interleaved).toStack();
  return mat4(
    ownColumns[0] as Node<"vec4">,
    ownColumns[1] as Node<"vec4">,
    ownColumns[2] as Node<"vec4">,
    ownColumns[3] as Node<"vec4">,
  ) as Node<"mat4">;
}

/** `cameraViewMatrix * modelWorldMatrix * instanceMatrix`: asset-space to view-space per instance. */
function instanceViewMatrixNode(builder: NodeBuilder): Node<"mat4"> {
  const instance = userInstanceMatrix(builder);
  return cameraViewMatrix.mul(modelWorldMatrix).mul(instance) as Node<"mat4">;
}

/** A `mat4` identity node for a plain, non-instanced mesh. */
function identityMat4(): Node<"mat4"> {
  return mat4(
    vec4(1, 0, 0, 0),
    vec4(0, 1, 0, 0),
    vec4(0, 0, 1, 0),
    vec4(0, 0, 0, 1),
  ) as Node<"mat4">;
}

/** A node twin retaining the source material's authored values and shader nodes. */
function cloneLitMaterial(source: Material): NodeMaterial {
  if (Reflect.get(source, "isNodeMaterial") === true) {
    const twin = (source as NodeMaterial).clone();
    // NodeMaterial.copy skips the inherited alphaTest accessor and its private backing value.
    twin.alphaTest = source.alphaTest;
    return twin;
  }
  const nodeClass = NODE_CLASSES.get(source.type);
  if (nodeClass === undefined)
    throw new Error(`WorldImpostorSurface cannot convert material type '${source.type}'.`);
  const twin = new nodeClass();
  for (const key in source)
    if (!UNSYNCED.has(key)) Reflect.set(twin, key, Reflect.get(source, key));
  return twin;
}

/**
 * The final LOD of one baked asset: a two-triangle, camera-facing quad that samples and blends the
 * octahedral atlas the baker produced.
 *
 * The quad stays lit and carries the source's own scalar surface values. Albedo and normals are the
 * baked ones, unpremultiplied by their coverage before shading; the source's UV maps are cleared
 * because none of them describe the quad's UVs. The cutout is a mip-aware threshold so the
 * blended coverage survives distance, while `alphaTest` stays a positive number for the
 * virtual-shadow caster contract.
 */
export class WorldImpostorSurface {
  readonly geometry: BufferGeometry;
  readonly material: NodeMaterial;
  /** Two triangles, always: the shape is the point of the final LOD. */
  readonly quads = 1;
  /** Whether this surface reads the per-instance far cull attribute; see the option. */
  readonly cull: boolean;
  #disposed = false;

  constructor(options: IImpostorSurfaceOptions) {
    const atlas = options.atlas;
    const radius = Math.max(options.radius, 1e-4);
    const cutoff = Math.max(
      options.alphaTest ??
        (options.source.alphaTest > 0 ? options.source.alphaTest : DEFAULT_ALPHA_TEST),
      1e-4,
    );
    const mipScale = options.mipScale ?? IMPOSTOR_MIP_ALPHA_SCALE;
    const center = options.center.clone();
    if (atlas.color.image === null && atlas.normal.image === null)
      throw new Error("WorldImpostorSurface requires a baked atlas.");
    const material = cloneLitMaterial(options.source);
    for (const key of GEOMETRY_MAPS) Reflect.set(material, key, null);
    for (const key of SURFACE_NODES) Reflect.set(material, key, null);
    // Albedo and coverage are baked into the atlas; a vertex-colour attribute the quad does not
    // have, an opacity multiplier or an opacity node would apply the source's own colour and
    // coverage a second time on top of the baked one.
    material.vertexColors = false;
    material.opacity = 1;
    material.opacityNode = null;
    material.transparent = false;
    material.depthWrite = true;
    material.depthTest = true;
    material.side = DoubleSide;
    // A positive number, never the cutoff: three's shadow pass copies this number as its own cutoff
    // and ignores `alphaTestNode`, and a shadow-map texel is metres wide, so the blended coverage it
    // reads is far below the authored 0.5 everywhere and every fragment would be discarded. The
    // discard that matters runs through `maskShadowNode` below, with the same mip-aware threshold the
    // main pass uses; this floor only drops empty space.
    material.alphaTest = IMPOSTOR_SHADOW_ALPHA_FLOOR;
    material.userData = { ...material.userData, tnWholeAssetImpostor: true };
    material.needsUpdate = true;

    const centerUniform = uniform(center);
    const radiusUniform = uniform(radius);
    const halfUniform =
      options.halfExtents === undefined ? undefined : uniform(options.halfExtents.clone());
    const cull = options.cull === true;
    const name = `WorldImpostorSurface${surfaceId}`;
    surfaceId += 1;
    const relVarying = varyingProperty("vec3", `${name}Rel`);
    const dirVarying = varyingProperty("vec3", `${name}Dir`);

    const positionNode = Fn((_inputs: unknown, builder: NodeBuilder) => {
      const instance = userInstanceMatrix(builder);
      const view = cameraViewMatrix.mul(modelWorldMatrix).mul(instance);
      const centerView = view.mul(vec4(centerUniform, 1)).xyz;
      // The authored cull contract in `world-gpu-scene.ts` `cullAndSelect` measures horizontal
      // world-XZ distance from the camera, not Euclidean view distance: an elevated camera would
      // otherwise cull trees still in range horizontally. The centre is the same
      // `modelWorldMatrix * instance * center` the contract stores as `placement.centre`.
      const centerWorld = modelWorldMatrix.mul(instance).mul(vec4(centerUniform, 1)).xyz;
      const farDistance = length(
        vec2(centerWorld.x.sub(cameraPosition.x), centerWorld.z.sub(cameraPosition.z)),
      );
      // Perspective looks from the instance centre toward the eye; orthographic (and therefore a
      // shadow camera) is a fixed forward, so one surface serves the main and shadow passes.
      const eyeView = select(orthographicNode(), vec3(0, 0, 1), normalize(centerView.negate()));
      const dAsset = normalize(asMat3(view).inverse().mul(eyeView));
      const basis = frameBasisNode(dAsset);
      const corner = positionGeometry.xy;
      // `impostorQuadExtents` on the GPU: the box's footprint circle across, its projection on `up`
      // down, each with the slack a neighbouring frame's blend reaches, never past the sphere.
      const extent = halfUniform
        ? vec2(
            min(radiusUniform, length(halfUniform.xz).mul(QUAD_ACROSS_SLACK)),
            min(
              radiusUniform,
              abs(basis.up.x)
                .mul(halfUniform.x)
                .add(abs(basis.up.y).mul(halfUniform.y))
                .add(abs(basis.up.z).mul(halfUniform.z))
                .mul(QUAD_UP_SLACK),
            ),
          )
        : vec2(radiusUniform, radiusUniform);
      const rel = basis.right.mul(corner.x.mul(extent.x)).add(basis.up.mul(corner.y.mul(extent.y)));
      // A main-pass horizontal-distance gate: when the instance centre is past the asset's own cull
      // the quad collapses to a point, which the rasteriser drops. The cull is a per-instance
      // attribute, so one surface serves every canonical asset over this atlas each at its own
      // authored distance. An orthographic camera (a shadow level) is exempt, so the far half still
      // casts.
      const gated = cull
        ? rel.mul(
            select(
              orthographicNode(),
              float(1),
              select(
                farDistance.lessThanEqual(
                  attribute(IMPOSTOR_FAR_CULL_ATTRIBUTE, "float") as Node<"float">,
                ),
                float(1),
                float(0),
              ),
            ),
          )
        : rel;
      relVarying.assign(gated);
      dirVarying.assign(
        select(orthographicNode(), dAsset, asMat3(view).inverse().mul(centerView.negate())),
      );
      return instance.mul(vec4(centerUniform.add(gated), 1)).xyz;
    })();

    const fragment = buildFragmentNodes(
      atlas,
      centerUniform,
      radiusUniform,
      cutoff,
      mipScale,
      relVarying,
      dirVarying,
    );
    material.colorNode = vec4(fragment.albedo, fragment.coverage);
    material.alphaTestNode = fragment.threshold;
    material.maskShadowNode = fragment.coverage.greaterThan(fragment.threshold);
    material.normalNode = Fn((_inputs: unknown, builder: NodeBuilder) =>
      transformNormal(fragment.normalAsset, instanceViewMatrixNode(builder)),
    )();
    material.positionNode = positionNode;
    // A source's shadow position (a wind-swept crown casts its rest pose) would bypass the billboard
    // above in the shadow draw: the quad must cast through its own positionNode.
    material.castShadowPositionNode = null;

    const geometry = new BufferGeometry();
    geometry.setAttribute(
      "position",
      new Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3),
    );
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    // Authored, not measured: the vertex shader relocates every corner per instance, so the literal
    // quad bounds cannot bound the draw. The baked sphere is the conservative shape to cull against.
    geometry.boundingBox = new Box3(
      center.clone().subScalar(radius),
      center.clone().addScalar(radius),
    );
    geometry.boundingSphere = new Sphere(center.clone(), radius);
    this.geometry = geometry;
    this.material = material;
    this.cull = cull;
    // Readable metadata for diagnostics and tests: a far surface reads the per-instance cull
    // attribute, so a shared-atlas cohort cannot silently borrow a member's maximum.
    if (cull) material.userData.tnFarCull = IMPOSTOR_FAR_CULL_ATTRIBUTE;
  }

  /** Dispose the owned geometry and the material twin; the borrowed atlas is never touched. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.geometry.dispose();
    this.material.dispose();
  }
}

let surfaceId = 0;

/** The attribute node for the position pass; a plain `Mesh` falls back to the identity. */
function userInstanceMatrix(builder: NodeBuilder): Node<"mat4"> {
  if (engineInstanceMatrix !== undefined) return engineInstanceMatrix();
  const object = builder.object;
  const attribute = (object as { instanceMatrix?: InstancedBufferAttribute }).instanceMatrix;
  return attribute === undefined ? identityMat4() : instanceMatrixNode(attribute, builder);
}

/**
 * A random in [0, 1) that stays with its instance, as UE 5.8.3's PerInstanceRandom: hashed from the
 * instance's world origin, never from its draw slot. WorldCells repacks instances on every refilter,
 * main-pass cull and LOD switch, so `instanceIndex` names another tree from one frame to the next; a
 * wind phase hashed from it re-rolled each crown about every 0.7 s of a walk and snapped its top by a
 * median 0.37 m. Parts of one placement share its translation, so its bark and needles read one value.
 *
 * @situation a per-instance random number that stays with each streamed placement as WorldCells repacks
 * @situation replace instanceIndex in a WorldCells part material, which WorldCells refuses
 * @example const phase = instanceRandom().mul(6.2831);
 */
export function instanceRandom(): Node<"float"> {
  return Fn((_inputs: unknown, builder: NodeBuilder) => {
    const origin = userInstanceMatrix(builder).mul(vec4(0, 0, 0, 1)).xyz;
    // Quantised like `worldLodMaterial`'s origin, so float rounding in a rewritten matrix keeps the hash.
    const snapped = floor(origin.mul(16).add(0.5)).div(16);
    return fract(sin(dot(snapped.xz, vec2(12.9898, 78.233))).mul(43758.5453));
  })() as Node<"float">;
}

/** Coarse ray-march steps across an impostor's depth; see `buildFragmentNodes`. */
export const IMPOSTOR_MARCH_STEPS = 32;
/** Bisection steps per crossing: 32 x 1024 places a hit as finely as 128 texel steps x 256 did. */
export const IMPOSTOR_BISECTION_STEPS = 10;

interface IFragmentNodes {
  readonly albedo: Node<"vec3">;
  readonly coverage: Node<"float">;
  readonly normalAsset: Node<"vec3">;
  readonly threshold: Node<"float">;
}

/** Build the fragment graph once and hand the same node objects to colour, normal and alpha test. */
function buildFragmentNodes(
  atlas: WorldImpostorAtlas,
  centerUniform: Node<"vec3">,
  radiusUniform: Node<"float">,
  cutoff: number,
  mipScale: number,
  relVarying: Node<"vec3">,
  dirVarying: Node<"vec3">,
): IFragmentNodes {
  void centerUniform;
  const grid = IMPOSTOR_VIEW_GRID;
  const n2 = float(grid - 2);
  const p = encodeOctahedralNode(dirVarying);
  const gx = p.x
    .mul(0.5)
    .add(0.5)
    .mul(float(grid - 1));
  const gy = p.y
    .mul(0.5)
    .add(0.5)
    .mul(float(grid - 1));
  const cx = clamp(floor(gx), float(0), n2);
  const cy = clamp(floor(gy), float(0), n2);
  const fx = gx.sub(cx);
  const fy = gy.sub(cy);
  const useLower = fx.add(fy).lessThanEqual(1);

  const cellX = [
    select(useLower, cx, cx.add(1)),
    select(useLower, cx.add(1), cx),
    select(useLower, cx, cx.add(1)),
  ];
  const cellY = [
    select(useLower, cy, cy.add(1)),
    select(useLower, cy, cy.add(1)),
    select(useLower, cy.add(1), cy),
  ];
  const weights = [
    select(useLower, float(1).sub(fx).sub(fy), fx.add(fy).sub(1)),
    select(useLower, fx, float(1).sub(fx)),
    select(useLower, fy, float(1).sub(fy)),
  ];

  const colorMap = texture(atlas.color);
  const normalMap = texture(atlas.normal);
  const steps = Math.min(atlas.pixels, IMPOSTOR_MARCH_STEPS);
  const uvs: Node<"vec2">[] = [];
  const colors: Node<"vec4">[] = [];
  const normals: Node<"vec4">[] = [];
  // One march, on the frame the blend weighs most; the other two read the same surface point from
  // their own view. Three marches were the far band's cost (PRD-866 AC-3).
  const [wa, wb, wc] = weights as [Node<"float">, Node<"float">, Node<"float">];
  const pickA = wa.greaterThanEqual(wb).and(wa.greaterThanEqual(wc));
  const pickB = wb.greaterThanEqual(wc);
  const [xa, xb, xc] = cellX as [Node<"float">, Node<"float">, Node<"float">];
  const [ya, yb, yc] = cellY as [Node<"float">, Node<"float">, Node<"float">];
  cellX.push(select(pickA, xa, select(pickB, xb, xc)));
  cellY.push(select(pickA, ya, select(pickB, yb, yc)));
  let marched: Node<"vec4"> | undefined;
  for (let index = 3; index < 4; index += 1) {
    const direction = octahedralViewNode(
      cellX[index] as Node<"float">,
      cellY[index] as Node<"float">,
      grid,
    );
    const basis = frameBasisNode(direction);
    // Row 0 of a three render target is the top of the frame the bake drew, so `up` runs toward v=0;
    // see `impostorFrameUv`.
    const ray = normalize(select(orthographicNode(), dirVarying, dirVarying.sub(relVarying)));
    const layer = (cellY[index] as Node<"float">)
      .mul(grid)
      .add(cellX[index] as Node<"float">)
      .toInt();
    // Positive baked coverage owns ray/depth geometry; the authored cutoff is applied once by the
    // final mip-aware fragment threshold. Alpha holes and depth jumps cannot create an interior
    // surface. A march step every four baked texels at most, ten refinements: one step per texel
    // was ~770 atlas reads a fragment over three frames, 26 ms of a 42 ms walking frame with 383 fir
    // impostors on screen, and two more bisection steps keep each crossing as precise as before.
    // March on the mip the fragment's own footprint resolves: mip 0 under a far tree a few pixels
    // wide reads scattered texels on every step and thrashes the texture cache (24 ms of a 48 ms
    // walking frame on 53k far trees). Depth is coverage-premultiplied, so a mip keeps its meaning.
    // Taken here, in uniform control flow, because derivatives inside the loop are undefined.
    const footUv = vec2(dot(relVarying, basis.right), dot(relVarying, basis.up).negate())
      .div(radiusUniform)
      .mul(0.5)
      .add(0.5);
    const marchLevel = max(
      log2(max(length(dFdx(footUv).mul(atlas.pixels)), length(dFdy(footUv).mul(atlas.pixels)))),
      float(0),
    ).toVar();
    const hit = Fn(() => {
      const found = float(0).toVar();
      const hitUv = vec2(2).toVar();
      const hitT = float(0).toVar();
      const previousGap = float(0).toVar();
      const previousAlpha = float(0).toVar();
      const previousT = radiusUniform.toVar();
      Loop({ start: 0, end: steps + 1, type: "int" }, ({ i }) => {
        const t = float(1).sub(float(i).div(steps).mul(2)).mul(radiusUniform);
        const point = relVarying.add(ray.mul(t));
        const sampleUv = vec2(dot(point, basis.right), dot(point, basis.up).negate())
          .div(radiusUniform)
          .mul(0.5)
          .add(0.5);
        const c = colorMap.depth(layer).sample(sampleUv).level(marchLevel).toVar();
        const n = normalMap.depth(layer).sample(sampleUv).level(marchLevel).toVar();
        const depth = float(1)
          .sub(
            float(1)
              .sub(n.a)
              .div(max(c.a, float(0.001)))
              .mul(2),
          )
          .mul(radiusUniform);
        const gap = dot(point, direction).sub(depth).toVar();
        If(
          found
            .equal(0)
            .and(previousAlpha.greaterThan(0))
            .and(c.a.greaterThan(0))
            .and(previousGap.greaterThan(0))
            .and(gap.lessThanEqual(0)),
          () => {
            const front = previousT.toVar();
            const back = t.toVar();
            const valid = float(1).toVar();
            Loop({ start: 0, end: IMPOSTOR_BISECTION_STEPS, type: "int" }, () => {
              const mid = front.add(back).mul(0.5).toVar();
              const p = relVarying.add(ray.mul(mid));
              const u = vec2(dot(p, basis.right), dot(p, basis.up).negate())
                .div(radiusUniform)
                .mul(0.5)
                .add(0.5);
              const mc = colorMap.depth(layer).sample(u).level(marchLevel).toVar();
              const mn = normalMap.depth(layer).sample(u).level(marchLevel).toVar();
              const md = float(1)
                .sub(
                  float(1)
                    .sub(mn.a)
                    .div(max(mc.a, float(0.001)))
                    .mul(2),
                )
                .mul(radiusUniform);
              const mg = dot(p, direction).sub(md);
              If(mc.a.lessThanEqual(0), () => {
                valid.assign(0);
              });
              If(mg.greaterThan(0), () => {
                front.assign(mid);
              }).Else(() => {
                back.assign(mid);
              });
            });
            const p = relVarying.add(ray.mul(front.add(back).mul(0.5)));
            const u = vec2(dot(p, basis.right), dot(p, basis.up).negate())
              .div(radiusUniform)
              .mul(0.5)
              .add(0.5);
            const hc = colorMap.depth(layer).sample(u).level(marchLevel).toVar();
            const hn = normalMap.depth(layer).sample(u).level(marchLevel).toVar();
            const hd = float(1)
              .sub(
                float(1)
                  .sub(hn.a)
                  .div(max(hc.a, float(0.001)))
                  .mul(2),
              )
              .mul(radiusUniform);
            If(
              valid
                .equal(1)
                .and(hc.a.greaterThan(0))
                .and(
                  abs(dot(p, direction).sub(hd)).lessThanEqual(
                    radiusUniform.mul(2 / 255).div(max(hc.a, float(0.001))),
                  ),
                ),
              () => {
                hitUv.assign(u);
                hitT.assign(front.add(back).mul(0.5));
                found.assign(1);
              },
            );
          },
        );
        previousGap.assign(gap);
        previousAlpha.assign(c.a);
        previousT.assign(t);
        // The first valid crossing owns the result; later samples cannot change it.
        If(found.equal(1), () => {
          Break();
        });
      });
      return vec4(hitUv, found, hitT);
    })();
    marched = hit;
  }

  const surface = marched as Node<"vec4">;
  const rayOut = normalize(select(orthographicNode(), dirVarying, dirVarying.sub(relVarying)));
  const hitPoint = relVarying.add(rayOut.mul(surface.w));
  for (let index = 0; index < 3; index += 1) {
    const basis = frameBasisNode(
      octahedralViewNode(cellX[index] as Node<"float">, cellY[index] as Node<"float">, grid),
    );
    const layer = (cellY[index] as Node<"float">)
      .mul(grid)
      .add(cellX[index] as Node<"float">)
      .toInt();
    const uv = vec2(dot(hitPoint, basis.right), dot(hitPoint, basis.up).negate())
      .div(radiusUniform)
      .mul(0.5)
      .add(0.5);
    uvs.push(uv);
    colors.push(colorMap.depth(layer).sample(uv).mul(surface.z).toVar() as Node<"vec4">);
    normals.push(normalMap.depth(layer).sample(uv).mul(surface.z).toVar() as Node<"vec4">);
  }

  const [w0, w1, w2] = weights as [Node<"float">, Node<"float">, Node<"float">];
  const [c0, c1, c2] = colors as [Node<"vec4">, Node<"vec4">, Node<"vec4">];
  const [n0, n1, n2v] = normals as [Node<"vec4">, Node<"vec4">, Node<"vec4">];
  const coverage = c0.a.mul(w0).add(c1.a.mul(w1)).add(c2.a.mul(w2));
  const safe = max(coverage, float(1e-4));
  const albedo = c0.rgb.mul(w0).add(c1.rgb.mul(w1)).add(c2.rgb.mul(w2)).div(safe);
  const encodedNormal = n0.rgb.mul(w0).add(n1.rgb.mul(w1)).add(n2v.rgb.mul(w2)).div(safe);
  const normalAsset = normalize(encodedNormal.mul(2).sub(1));
  return {
    albedo,
    coverage,
    normalAsset,
    threshold: mipThresholdNode(uvs, atlas.pixels, cutoff, mipScale),
  };
}

/**
 * Slack on the fitted quad. Across: a frame blended in from a neighbouring azimuth reprojects the
 * footprint up to `1 / cos(45 deg)` wider, but its weight there is small, so a quarter covers it.
 * Down: elevation neighbours shift the projection a little. Both stay inside the sphere's square.
 */
const QUAD_ACROSS_SLACK = 1.25;
const QUAD_UP_SLACK = 1.1;

/**
 * The quad's half width and half height for a view `direction` (asset space, toward the eye), as
 * the surface's vertex shader computes them: the box footprint's circle across (any azimuth), the
 * box's projection on the frame's `up` down, each with its slack and capped by the sphere radius.
 */
export function impostorQuadExtents(
  direction: Vector3,
  halfExtents: Vector3,
  radius: number,
): { readonly across: number; readonly up: number } {
  const { up } = impostorFrameBasis(direction);
  return {
    across: Math.min(radius, Math.hypot(halfExtents.x, halfExtents.z) * QUAD_ACROSS_SLACK),
    up: Math.min(
      radius,
      (Math.abs(up.x) * halfExtents.x +
        Math.abs(up.y) * halfExtents.y +
        Math.abs(up.z) * halfExtents.z) *
        QUAD_UP_SLACK,
    ),
  };
}

/**
 * The frame basis the baker's orthographic camera actually built for `direction`: the three
 * endpoints of a view's own `lookAt`, so the sampler's projection and the bake share one basis.
 */
export function impostorFrameBasis(direction: Vector3): {
  readonly right: Vector3;
  readonly up: Vector3;
} {
  const d = direction.clone().normalize();
  const hint = Math.abs(d.y) > 0.999 ? new Vector3(0, 0, 1) : new Vector3(0, 1, 0);
  const right = new Vector3().crossVectors(hint, d).normalize();
  const up = new Vector3().crossVectors(d, right).normalize();
  return { right, up };
}

/**
 * The UV a baked frame gives one asset-local offset, as the surface shader projects it.
 *
 * `v` runs downward: a three render target's row 0 is the top of the frame its camera drew (WebGPU
 * samples it unflipped, and WebGL's render-target flip lands the same place), so the GL-style
 * `0.5 + y/2` reads the frame upside down.
 */
export function impostorFrameUv(
  relative: Vector3,
  basis: { readonly right: Vector3; readonly up: Vector3 },
  radius: number,
): { readonly u: number; readonly v: number } {
  return {
    u: (relative.dot(basis.right) / radius) * 0.5 + 0.5,
    v: 0.5 - (relative.dot(basis.up) / radius) * 0.5,
  };
}

/**
 * How long a published level change fades, in seconds: UE 5.8.3 `lod.TemporalLag`
 * (Engine/Source/Runtime/Engine/Private/SceneManagement.cpp:28-32).
 */
export const LOD_TEMPORAL_LAG = 0.5;

/**
 * UE 5.8.3's temporal LOD state (Engine/Source/Runtime/Engine/Private/SceneManagement.cpp:113-140):
 * two lagged view origins and the blend between them. LOD is chosen at both and cross-faded by
 * `alpha`, so a placement crossing a gate fades over one `lag` window and none stays mid-fade while
 * the viewer stands still.
 */
export interface ITemporalLod {
  readonly from: Vector3;
  readonly to: Vector3;
  fromTime: number;
  toTime: number;
  alpha: number;
}

/** Advance {@link ITemporalLod} to `now` seconds with the view at `eye`, as UE's UpdateTemporalLODTransition. */
export function advanceTemporalLod(
  state: ITemporalLod,
  eye: Vector3,
  now: number,
  lag = LOD_TEMPORAL_LAG,
): void {
  if (!Number.isFinite(state.toTime) || now < state.toTime) {
    state.from.copy(eye);
    state.to.copy(eye);
    state.fromTime = now;
    state.toTime = now;
  } else if (state.toTime < now - lag) {
    if (state.fromTime < state.toTime) {
      state.from.copy(state.to);
      state.fromTime = state.toTime;
    }
    state.to.copy(eye);
    state.toTime = now;
  }
  const window = state.toTime - state.fromTime;
  state.alpha = window > 0 ? Math.min(1, Math.max(0, (now - lag - state.fromTime) / window)) : 1;
}

/** Complementary LOD masks over the caller's distance bands, shared by colour and shadow passes. */
export function worldLodMaterial(
  source: Material,
  local: import("three").Matrix4,
  distances: readonly number[],
  level: number,
  width: number,
  eye: Node<"vec3">,
  distanceBias: Node<"float">,
  spatial: boolean,
  publishedRanges = false,
  clock?: Node<"float">,
  temporal?: {
    readonly from: Node<"vec3">;
    readonly to: Node<"vec3">;
    readonly alpha: Node<"float">;
  },
  shadowFloor = 0,
): NodeMaterial {
  const material = cloneLitMaterial(source);
  const inverse = uniform(local.clone().invert());
  const root = Fn(
    (_inputs: unknown, builder: NodeBuilder) =>
      userInstanceMatrix(builder)
        .mul(inverse)
        .mul(vec4(0, 0, 0, 1)).xyz,
  )();
  // Quantise recovered roots so part-local float rounding cannot change the instance hash.
  const origin = varying(floor(root.mul(16).add(0.5)).div(16));
  const distanceTo = (at: Node<"vec3">) =>
    (spatial ? length(origin.sub(at)) : length(origin.xz.sub(at.xz))).mul(distanceBias);
  const distance = distanceTo(eye);
  const random = fract(sin(dot(origin.xz, vec2(12.9898, 78.233))).mul(43758.5453));
  const noise = fract(sin(dot(floor(screenCoordinate.xy), vec2(12.9898, 78.233))).mul(43758.5453));
  // CPU-admitted batches publish the levels their instance currently has beside its matrix. During
  // a queued refilter, an old level outside that set remains whole until the replacement is swapped.
  // LOD indices are categorical; interpolating 2 below 2 can clip an otherwise whole tree.
  // `.zw` is the fade a swap stamped: the level the record was whole at (-1: none) and when.
  const published = publishedRanges
    ? varying(attribute("tnPublishedLodRange", "vec4") as Node<"vec4">).setInterpolation("flat")
    : undefined;
  // The level and the gate distances are uniforms, not constants, so every level of an asset (and
  // every asset with as many gates) is one shader program and one pipeline, as an Unreal material
  // instance shares its parent's shader. Baked, each level was a first-time program that compiled in
  // the frame it first came into view: 14 ms of CPU and a 50 ms frame in a 360-degree turn.
  const lod = uniform(level);
  const gates = distances.map((at) => uniform(at));
  const always = float(1).greaterThan(0);
  // `mixAt(gate)` is how far past the gate this placement is, 0..1; pixels with noise below it draw
  // the coarser level.
  const levelMask = (
    mixAt: (at: Node<"float">, span: Node<"float">) => Node<"float">,
    first = 1,
  ) => {
    let mask = always;
    for (let gate = first; gate < distances.length; gate++) {
      const at = gates[gate] as Node<"float">;
      let span = at.mul(width).min(at.sub(gates[gate - 1] as Node<"float">).mul(width));
      if (gate + 1 < distances.length)
        span = span.min((gates[gate + 1] as Node<"float">).sub(at).mul(width));
      const mix = mixAt(at, span);
      // `gate === level` fades this level in past the gate; `gate === level + 1` fades it out.
      const fadeIn =
        published === undefined
          ? noise.lessThan(mix)
          : select(published.x.lessThan(lod), noise.lessThan(mix), always);
      const fadeOut =
        published === undefined
          ? noise.greaterThanEqual(mix)
          : select(published.y.greaterThan(lod), noise.greaterThanEqual(mix), always);
      mask = mask.and(lod.notEqual(gate).or(fadeIn)).and(lod.notEqual(gate - 1).or(fadeOut));
    }
    return mask;
  };
  const rampAt = (at: Node<"float">, span: Node<"float">) =>
    distance.sub(at).div(span).add(0.5).add(random.sub(0.5).mul(0.5)).clamp(0, 1);
  const mask = levelMask(rampAt);
  // `shadowFloor`: finer placements cast in the floor level's shape (`castLevelOf`), so the floor's
  // shadow covers every distance under its outer gate and a finer level casts nothing.
  const shadow =
    shadowFloor > 0
      ? lod.greaterThanEqual(shadowFloor).and(levelMask(rampAt, shadowFloor + 1))
      : mask;
  // Temporal: the gate is hard in space and the colour pass blends the level seen from the older
  // eye into the level seen from the newer one, as UE's instanced foliage does.
  const past = (eyeAt: Node<"vec3">, at: Node<"float">) =>
    select(distanceTo(eyeAt).greaterThan(at), float(1), float(0));
  const crossFaded =
    temporal === undefined
      ? mask
      : levelMask((at) =>
          past(temporal.from, at)
            .mul(float(1).sub(temporal.alpha))
            .add(past(temporal.to, at).mul(temporal.alpha)),
        );
  // A refilter that lands late turns a whole tree into a dithered pair in one frame. The colour pass
  // keeps the old whole level on a shrinking share of pixels for `LOD_TEMPORAL_LAG`, as UE fades
  // every LOD change in time; the shares stay complementary, so no pixel holds both or neither.
  // Shadows take the new answer at once: a cached shadow page must not keep a frame of the fade.
  let colour = crossFaded;
  if (published !== undefined && clock !== undefined) {
    const progress = clock.sub(published.w).div(LOD_TEMPORAL_LAG);
    const blend = fract(
      sin(dot(floor(screenCoordinate.xy), vec2(39.3468, 11.1353))).mul(24634.6345),
    );
    const holdOld = published.z.greaterThanEqual(0).and(blend.greaterThanEqual(progress));
    colour = select(holdOld, published.z.sub(lod).abs().lessThan(0.5), crossFaded);
  }
  material.maskNode = material.maskNode ? (material.maskNode as Node<"bool">).and(colour) : colour;
  material.maskShadowNode = material.maskShadowNode
    ? (material.maskShadowNode as Node<"bool">).and(shadow)
    : shadow;
  if (publishedRanges) material.userData.tnPublishedLodRange = true;
  return material;
}
