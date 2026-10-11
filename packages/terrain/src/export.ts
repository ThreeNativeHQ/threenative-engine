import {
  type BufferGeometry,
  Camera,
  Group,
  Light,
  Material,
  type Matrix4,
  Mesh,
  MeshStandardMaterial,
  NoColorSpace,
  type Object3D,
  Quaternion,
  RGBAFormat,
  SRGBColorSpace,
  Source,
  TangentSpaceNormalMap,
  type Texture,
  UnsignedByteType,
  Vector3,
} from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import type { ITerrainState } from "./core/types.js";

export interface IWorldGLBInput {
  readonly revision: string;
  readonly snapshotTime: number;
  readonly state: ITerrainState;
  /** The committed canonical terrain with caller-baked UV albedo/normal/roughness/AO. */
  readonly terrain: Mesh;
  /**
   * Actual static models by asset id. A placement resolves through `models` first and this second,
   * so a caller can hand one asset two genuinely different models without renaming the asset. The
   * geometries may still be shared instances; the encoder references one buffer view per attribute,
   * so per-placement models cost nodes rather than bytes.
   */
  readonly assets?: ReadonlyMap<string, Object3D>;
  /** Per-placement models keyed by durable placement id; the resolved model when both are supplied. */
  readonly models?: ReadonlyMap<string, Object3D>;
  /** Final placement-root matrices after the game's model-bound grounding. Keys are durable IDs. */
  readonly transforms: ReadonlyMap<string, Matrix4>;
  /** Every resolved water body/ribbon, baked at snapshotTime with no stale simulation copy. */
  readonly water?: readonly { id: string; object: Object3D; time: number; staleFrames: number }[];
}

export interface IWorldGLBExport {
  readonly name: "world.glb";
  readonly mime: "model/gltf-binary";
  readonly bytes: Uint8Array;
  readonly report: {
    revision: string;
    resolution: number;
    snapshotTime: number;
    placementIds: string[];
    waterIds: string[];
    /** Standard GLB carries no running atmosphere, lights, fog, exposure or post chain. */
    receivingGameSupplies: string[];
  };
}

function geometry(value: BufferGeometry, name: string): void {
  const position = value.getAttribute("position");
  if (!position || position.count === 0) throw new Error(`${name}: missing geometry`);
  for (const key of ["position", "normal", "uv"]) {
    const attribute = value.getAttribute(key);
    const size = key === "uv" ? 2 : 3;
    if (!attribute || attribute.count !== position.count || attribute.itemSize !== size)
      throw new Error(`${name}: missing/malformed ${key}`);
    for (let i = 0; i < attribute.count; i++)
      for (let c = 0; c < size; c++)
        if (!Number.isFinite(attribute.getComponent(i, c)))
          throw new Error(`${name}: nonfinite ${key}`);
  }
  if (value.index)
    for (const index of value.index.array)
      if (!Number.isInteger(index) || index < 0 || index >= position.count)
        throw new Error(`${name}: invalid triangle index`);
  if ((value.index?.count ?? position.count) % 3 !== 0)
    throw new Error(`${name}: incomplete triangles`);
  if (Object.keys(value.morphAttributes).length > 0)
    throw new Error(`${name}: morph deformation must be baked first`);
}

function image(texture: Texture, name: string, colour: boolean): void {
  if (Reflect.get(texture, "isCompressedTexture"))
    throw new Error(`${name}: compressed images must be decoded before portable export`);
  if (texture.type !== UnsignedByteType)
    throw new Error(`${name}: bake HDR/float PBR maps into portable byte images first`);
  const source = texture.image as
    | { width?: number; height?: number; data?: Uint8Array | Uint8ClampedArray }
    | undefined;
  if (
    !source ||
    !Number.isInteger(source.width) ||
    !Number.isInteger(source.height) ||
    (source.width ?? 0) <= 0 ||
    (source.height ?? 0) <= 0 ||
    (source.width ?? 0) * (source.height ?? 0) > 16_777_216
  )
    throw new Error(`${name}: missing or oversized image (maximum 16 megapixels)`);
  if (
    source.data &&
    (texture.format !== RGBAFormat ||
      !(source.data instanceof Uint8Array || source.data instanceof Uint8ClampedArray) ||
      source.data.length !== (source.width ?? 0) * (source.height ?? 0) * 4)
  )
    throw new Error(`${name}: portable data images require complete byte RGBA pixels`);
  if (texture.colorSpace !== (colour ? SRGBColorSpace : NoColorSpace))
    throw new Error(`${name}: expected ${colour ? "sRGB colour" : "linear data"}`);
}

function material(value: Material, name: string, terrain = false): void {
  const label = `${name}: ${value.name || value.type}`;
  if (
    !(value instanceof MeshStandardMaterial) ||
    Reflect.get(value, "isNodeMaterial") ||
    Reflect.get(value, "isMeshPhysicalMaterial") ||
    value.onBeforeCompile !== Material.prototype.onBeforeCompile
  )
    throw new Error(`${label}: unsupported unbaked material`);
  for (const role of ["displacementMap", "bumpMap", "lightMap"] as const)
    if (value[role]) throw new Error(`${label}: bake ${role} into the portable surface first`);
  if (
    value.normalMap &&
    (value.normalMapType !== TangentSpaceNormalMap ||
      Math.abs(value.normalScale.x) !== Math.abs(value.normalScale.y))
  )
    throw new Error(
      `${label}: bake object-space/anisotropic normal maps into a portable tangent-space map first`,
    );
  if (value.alphaMap) throw new Error(`${label}: bake alphaMap into the colour image first`);
  if (
    ![
      ...value.color.toArray(),
      ...value.emissive.toArray(),
      value.emissiveIntensity,
      value.normalScale.x,
      value.normalScale.y,
      value.opacity,
      value.alphaTest,
      value.roughness,
      value.metalness,
    ].every(Number.isFinite) ||
    [value.opacity, value.alphaTest, value.roughness, value.metalness].some((v) => v < 0 || v > 1)
  )
    throw new Error(`${label}: invalid PBR factors`);
  for (const role of [
    "map",
    "normalMap",
    "roughnessMap",
    "aoMap",
    "metalnessMap",
    "emissiveMap",
  ] as const) {
    const texture = value[role];
    if (!texture && terrain && ["map", "normalMap", "roughnessMap", "aoMap"].includes(role))
      throw new Error(
        `${label}: baked ${role} required; vertex colours alone are not the full-world surface`,
      );
    if (texture) image(texture, `${label}.${role}`, role === "map" || role === "emissiveMap");
  }
}

function staticModel(source: Object3D, name: string, terrain = false): Object3D {
  let count = 0;
  source.traverseVisible((object) => {
    if (object instanceof Mesh) {
      if (Reflect.get(object, "isSkinnedMesh") || Reflect.get(object, "isInstancedMesh"))
        throw new Error(
          `${name}/${object.name}: resolve skinning/instancing into static meshes first`,
        );
      count++;
      geometry(object.geometry, `${name}/${object.name}`);
      for (const value of Array.isArray(object.material) ? object.material : [object.material])
        material(value, `${name}/${object.name}`, terrain);
    } else if (
      !["Object3D", "Group", "Scene"].includes(object.type) &&
      !(object instanceof Camera) &&
      !(object instanceof Light)
    ) {
      throw new Error(`${name}/${object.name}: unsupported ${object.type}`);
    }
    if (
      ![
        ...object.position.toArray(),
        ...object.quaternion.toArray(),
        ...object.scale.toArray(),
        ...object.matrix.elements,
      ].every(Number.isFinite)
    )
      throw new Error(`${name}/${object.name}: nonfinite transform`);
  });
  if (!count) throw new Error(`${name}: no static meshes`);
  const copy = source.clone(true);
  const excluded: Object3D[] = [];
  copy.traverse((object) => {
    object.userData = {};
    if (object instanceof Camera || object instanceof Light) excluded.push(object);
  });
  for (const object of excluded) object.removeFromParent();
  return copy;
}

/**
 * Export a committed evaluated world using ordinary glTF 2.0 nodes and embedded PBR images.
 * @requires npm i -D @threenative/terrain
 * @situation export terrain, resolved models and final manual placement transforms as a portable GLB
 * @situation export the whole terrain world as one glb for another three.js project
 * @constraint browser authoring (FileReader/canvas); caller supplies all appearance and coherent baked water; root and /three remain headless
 * @example const output = await exportWorldGLB({ revision, snapshotTime: 0, state, terrain, assets, transforms });
 * @override actual static models, final matrices and baked PBR maps are supplied by the game
 */
export async function exportWorldGLB(input: IWorldGLBInput): Promise<IWorldGLBExport> {
  const { state } = input;
  if (!/^[a-f0-9]{64}$/.test(input.revision) || !Number.isFinite(input.snapshotTime))
    throw new Error("World export requires a content revision and finite snapshot time");
  const positions = input.terrain.geometry.getAttribute("position");
  const n = state.resolution;
  if (
    !positions ||
    positions.count !== n * n ||
    state.height.length !== n * n ||
    !Number.isFinite(state.size) ||
    state.size <= 0 ||
    n < 2
  )
    throw new Error("World export terrain does not match the evaluated grid");
  if (
    !input.terrain.matrix.equals(input.terrain.matrix.clone().identity()) ||
    input.terrain.position.lengthSq() !== 0 ||
    input.terrain.scale.toArray().some((v) => v !== 1) ||
    input.terrain.quaternion.toArray().some((v, i) => v !== (i === 3 ? 1 : 0))
  )
    throw new Error("World export terrain must retain the canonical metre frame");
  for (let i = 0; i < positions.count; i++) {
    const expected = [
      Math.fround(-state.size / 2 + ((i % n) * state.size) / (n - 1)),
      state.height[i],
      Math.fround(-state.size / 2 + (Math.floor(i / n) * state.size) / (n - 1)),
    ];
    if (
      [positions.getX(i), positions.getY(i), positions.getZ(i)].some(
        (value, c) => value !== expected[c],
      )
    )
      throw new Error(`World export terrain vertex ${i} differs from the committed state`);
  }
  const root = new Group();
  root.name = "terrain-world";
  root.userData = {
    terrainRevision: input.revision,
    units: "metres",
    up: "Y",
    snapshotTime: input.snapshotTime,
    resolution: n,
  };
  const terrain = staticModel(input.terrain, "terrain", true);
  terrain.name = "terrain";
  root.add(terrain);
  const ids = new Set<string>();
  for (const placement of state.instances) {
    if (ids.has(placement.id)) throw new Error(`Duplicate placement '${placement.id}'`);
    ids.add(placement.id);
    // A per-placement model wins over the asset's shared one: two variants of one tree are the same
    // asset id, and a receiving game has to be able to see that they are not the same model.
    const asset = input.models?.get(placement.id) ?? input.assets?.get(placement.asset);
    if (!asset) throw new Error(`Unresolved placement asset '${placement.asset}'`);
    const matrix = input.transforms.get(placement.id);
    if (
      !matrix ||
      !matrix.elements.every((value) => Number.isFinite(Math.fround(value))) ||
      !Number.isFinite(matrix.determinant()) ||
      matrix.determinant() <= 0 ||
      matrix.elements.some((v, i) => [3, 7, 11, 15].includes(i) && v !== (i === 15 ? 1 : 0))
    )
      throw new Error(`Invalid/missing final transform '${placement.id}'`);
    const position = new Vector3();
    const quaternion = new Quaternion();
    const scale = new Vector3();
    matrix.decompose(position, quaternion, scale);
    if (Math.min(scale.x, scale.y, scale.z) <= 0)
      throw new Error(`Nonpositive placement scale '${placement.id}'`);
    const recomposed = matrix.clone().compose(position, quaternion, scale);
    if (
      matrix.elements.some(
        (value, index) =>
          Math.abs(value - (recomposed.elements[index] ?? Number.NaN)) >
          1e-6 * Math.max(1, Math.abs(value)),
      )
    )
      throw new Error(`Placement transform '${placement.id}' contains unsupported shear`);
    const node = new Group();
    node.name = placement.id;
    node.matrix.copy(matrix);
    node.matrixAutoUpdate = false;
    node.userData = {
      placementId: placement.id,
      assetId: placement.asset,
      grounding: placement.transform?.grounding ?? true,
    };
    node.add(staticModel(asset, `asset:${placement.asset}`));
    root.add(node);
  }
  for (const id of input.transforms.keys())
    if (!ids.has(id)) throw new Error(`Unmatched export transform '${id}'`);
  const waterIds = new Set([
    ...state.waters.map((water) => water.id),
    ...state.rivers.map((river) => river.id),
  ]);
  const snapshots = new Map<string, NonNullable<IWorldGLBInput["water"]>[number]>();
  for (const water of input.water ?? []) {
    if (!waterIds.has(water.id) || snapshots.has(water.id))
      throw new Error(`Unexpected/duplicate water '${water.id}'`);
    snapshots.set(water.id, water);
  }
  for (const id of waterIds) {
    const water = snapshots.get(id);
    if (!water) throw new Error(`Water '${id}' requires a baked snapshot`);
    if (water.staleFrames !== 0) throw new Error(`Water '${id}' has a stale/unresolved snapshot`);
    if (water.time !== input.snapshotTime)
      throw new Error(`Water '${id}' snapshot time differs from requested time`);
    const copy = staticModel(water.object, `water:${id}`);
    copy.name = `water:${id}`;
    root.add(copy);
  }
  if (typeof FileReader === "undefined" || typeof document === "undefined")
    throw new Error("exportWorldGLB needs browser authoring FileReader/canvas");
  // Freeze shared resources once before asynchronous encoding; live edits cannot mix revisions.
  const geometries = new Map<BufferGeometry, BufferGeometry>();
  const materials = new Map<Material, Material>();
  const textures = new Map<Texture, Texture>();
  function freezeTexture(source: Texture): Texture {
    const found = textures.get(source);
    if (found) return found;
    const copy = source.clone();
    copy.userData = {};
    const image = source.image as {
      width: number;
      height: number;
      data?: Uint8Array | Uint8ClampedArray;
    };
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("World export image snapshot canvas unavailable");
    if (image.data)
      context.putImageData(
        new ImageData(new Uint8ClampedArray(image.data), image.width, image.height),
        0,
        0,
      );
    else context.drawImage(source.image as CanvasImageSource, 0, 0);
    copy.source = new Source(canvas);
    textures.set(source, copy);
    return copy;
  }
  function freezeMaterial(source: Material): Material {
    const found = materials.get(source);
    if (found) return found;
    const copy = source.clone();
    copy.userData = {};
    if (copy instanceof MeshStandardMaterial && source instanceof MeshStandardMaterial)
      for (const role of [
        "map",
        "normalMap",
        "roughnessMap",
        "aoMap",
        "metalnessMap",
        "emissiveMap",
      ] as const)
        if (source[role]) copy[role] = freezeTexture(source[role]);
    materials.set(source, copy);
    return copy;
  }
  let binary: ArrayBuffer | { [key: string]: unknown };
  try {
    root.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      const copy: BufferGeometry = geometries.get(object.geometry) ?? object.geometry.clone();
      geometries.set(object.geometry, copy);
      object.geometry = copy;
      object.material = Array.isArray(object.material)
        ? object.material.map(freezeMaterial)
        : freezeMaterial(object.material);
    });
    root.updateMatrixWorld(true);
    binary = await new GLTFExporter().parseAsync(root, {
      binary: true,
      onlyVisible: true,
      includeCustomExtensions: false,
    });
  } finally {
    for (const value of geometries.values()) value.dispose();
    for (const value of materials.values()) value.dispose();
    for (const value of textures.values()) value.dispose();
  }
  if (!(binary instanceof ArrayBuffer)) throw new Error("GLTFExporter did not return a GLB");
  const header = new DataView(binary);
  if (
    header.getUint32(0, true) !== 0x46546c67 ||
    header.getUint32(4, true) !== 2 ||
    header.getUint32(8, true) !== binary.byteLength ||
    header.getUint32(16, true) !== 0x4e4f534a
  )
    throw new Error("GLTFExporter returned a malformed GLB");
  const json = JSON.parse(
    new TextDecoder().decode(new Uint8Array(binary, 20, header.getUint32(12, true))),
  ) as { images?: { uri?: string }[]; buffers?: { uri?: string }[]; extensionsRequired?: string[] };
  if (
    [...(json.images ?? []), ...(json.buffers ?? [])].some((resource) => resource.uri) ||
    json.extensionsRequired?.some((name) => !name.startsWith("KHR_"))
  )
    throw new Error("World GLB contains an external resource or nonportable required extension");
  return {
    name: "world.glb",
    mime: "model/gltf-binary",
    bytes: new Uint8Array(binary),
    report: {
      revision: input.revision,
      resolution: n,
      snapshotTime: input.snapshotTime,
      placementIds: [...ids],
      waterIds: [...waterIds],
      receivingGameSupplies: [
        "lighting",
        "sky/environment",
        "fog",
        "exposure",
        "post-processing",
        "live water/wind",
      ],
    },
  };
}
