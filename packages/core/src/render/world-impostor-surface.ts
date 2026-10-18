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
  const columns = [...(Reflect.get(builder, "nodes") as Iterable<Node>)].filter((node) => {
    const value = Reflect.get(node, "value");
    return (
      value?.isInstancedInterleavedBuffer === true &&
      value.array === attribute.array &&
      Reflect.get(node, "bufferStride") === 16
    );
  });
  if (columns.length === 4) {
    columns.sort((a, b) => Reflect.get(a, "bufferOffset") - Reflect.get(b, "bufferOffset"));
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
  const object = builder.object;
  const attribute = (object as { instanceMatrix?: InstancedBufferAttribute }).instanceMatrix;
  const instance =
    attribute === undefined ? identityMat4() : instanceMatrixNode(attribute, builder);
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
    const cull = options.cull === true;
    const name = `WorldImpostorSurface${surfaceId}`;
    surfaceId += 1;
    const relVarying = varyingProperty("vec3", `${name}Rel`);
    const dirVarying = varyingProperty("vec3", `${name}Dir`);

    const positionNode = Fn((_inputs: unknown, builder: NodeBuilder) => {
      const object = builder.object;
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
      const rel = basis.right.mul(corner.x).add(basis.up.mul(corner.y)).mul(radiusUniform);
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
  const object = builder.object;
  const attribute = (object as { instanceMatrix?: InstancedBufferAttribute }).instanceMatrix;
  return attribute === undefined ? identityMat4() : instanceMatrixNode(attribute, builder);
}

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
  const uvs: Node<"vec2">[] = [];
  const colors: Node<"vec4">[] = [];
  const normals: Node<"vec4">[] = [];
  for (let index = 0; index < 3; index += 1) {
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
    // surface. One march step per baked texel, eight refinements.
    const hit = Fn(() => {
      const found = float(0).toVar();
      const hitUv = vec2(2).toVar();
      const previousGap = float(0).toVar();
      const previousAlpha = float(0).toVar();
      const previousT = radiusUniform.toVar();
      Loop({ start: 0, end: atlas.pixels + 1, type: "int" }, ({ i }) => {
        const t = float(1).sub(float(i).div(atlas.pixels).mul(2)).mul(radiusUniform);
        const point = relVarying.add(ray.mul(t));
        const sampleUv = vec2(dot(point, basis.right), dot(point, basis.up).negate())
          .div(radiusUniform)
          .mul(0.5)
          .add(0.5);
        const c = colorMap.depth(layer).sample(sampleUv).level(float(0)).toVar();
        const n = normalMap.depth(layer).sample(sampleUv).level(float(0)).toVar();
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
            Loop({ start: 0, end: 8, type: "int" }, () => {
              const mid = front.add(back).mul(0.5).toVar();
              const p = relVarying.add(ray.mul(mid));
              const u = vec2(dot(p, basis.right), dot(p, basis.up).negate())
                .div(radiusUniform)
                .mul(0.5)
                .add(0.5);
              const mc = colorMap.depth(layer).sample(u).level(float(0)).toVar();
              const mn = normalMap.depth(layer).sample(u).level(float(0)).toVar();
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
            const hc = colorMap.depth(layer).sample(u).level(float(0)).toVar();
            const hn = normalMap.depth(layer).sample(u).level(float(0)).toVar();
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
      return vec3(hitUv, found);
    })();
    uvs.push(hit.xy);
    colors.push(colorMap.depth(layer).sample(hit.xy).mul(hit.z).toVar() as Node<"vec4">);
    normals.push(normalMap.depth(layer).sample(hit.xy).mul(hit.z).toVar() as Node<"vec4">);
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
  const distance = (spatial ? length(origin.sub(eye)) : length(origin.xz.sub(eye.xz))).mul(
    distanceBias,
  );
  const random = fract(sin(dot(origin.xz, vec2(12.9898, 78.233))).mul(43758.5453));
  const noise = fract(sin(dot(floor(screenCoordinate.xy), vec2(12.9898, 78.233))).mul(43758.5453));
  // CPU-admitted batches publish the levels their instance currently has beside its matrix. During
  // a queued refilter, an old level outside that set remains whole until the replacement is swapped.
  // LOD indices are categorical; interpolating 2 below 2 can clip an otherwise whole tree.
  const published = publishedRanges
    ? varying(attribute("tnPublishedLodRange", "vec2") as Node<"vec2">).setInterpolation("flat")
    : undefined;
  let mask = float(1).greaterThan(0);
  for (let gate = 1; gate < distances.length; gate++) {
    const at = distances[gate] as number;
    const span = Math.min(
      at * width,
      (at - (distances[gate - 1] as number)) * width,
      ((distances[gate + 1] ?? Number.POSITIVE_INFINITY) - at) * width,
    );
    const mix = distance.sub(at).div(span).add(0.5).add(random.sub(0.5).mul(0.5)).clamp(0, 1);
    if (published === undefined) {
      if (gate === level) mask = mask.and(noise.lessThan(mix));
      if (gate === level + 1) mask = mask.and(noise.greaterThanEqual(mix));
    } else {
      if (gate === level)
        mask = mask.and(
          select(published.x.lessThan(level), noise.lessThan(mix), float(1).greaterThan(0)),
        );
      if (gate === level + 1)
        mask = mask.and(
          select(
            published.y.greaterThan(level),
            noise.greaterThanEqual(mix),
            float(1).greaterThan(0),
          ),
        );
    }
  }
  material.maskNode = material.maskNode ? (material.maskNode as Node<"bool">).and(mask) : mask;
  material.maskShadowNode = material.maskShadowNode
    ? (material.maskShadowNode as Node<"bool">).and(mask)
    : mask;
  if (publishedRanges) material.userData.tnPublishedLodRange = true;
  return material;
}
