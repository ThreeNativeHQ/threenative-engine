import {
  type BufferGeometry,
  type InstancedMesh,
  type Material,
  Matrix4,
  type Mesh,
  Object3D,
} from "three";
import {
  ancestorAssetProvenance,
  readAssetProvenance,
  writeAssetProvenance,
} from "./asset-provenance.js";
import type { IInstancedLodOptions } from "./instanced-batch-lod.js";
import { type IInstancedPlacement, InstancedBatch, composePlacement } from "./instanced-batch.js";
import { baseGeometryOf } from "./model-lod.js";
import { meshSections } from "./world-model-sections.js";

/** Default XZ spatial cell edge length, in metres, used to bucket instanced models for culling. */
export const INSTANCED_MODEL_DEFAULT_CELL_SIZE = 48;

export interface IInstancedModelOptions {
  /** Loaded model hierarchy whose static meshes are instanced. Required. */
  readonly source: Object3D;
  /**
   * XZ cell edge length in metres used to bucket placements so frustum culling skips distant
   * cells, or `false` to place every copy into one batch per material section. Default `48`.
   */
  readonly cellSize?: number | false;
  /** Forwarded to every underlying {@link InstancedBatch}. Default inherits automatic LOD selection. */
  readonly autoLod?: IInstancedLodOptions["autoLod"];
  /** Leaves matching static meshes out of the instanced model (for example moving sub-parts). */
  readonly skip?: (mesh: Mesh) => boolean;
}

export interface IInstancedModelBuildOptions {
  /** Passed through to every built `InstancedMesh`. Default `false`, as in Three.js. */
  readonly castShadow?: boolean;
  /** Name prefix applied to built `InstancedMesh` objects. */
  readonly name?: string;
  /** Added as parent of every built `InstancedMesh` when supplied. */
  readonly parent?: Object3D;
  /** Passed through to every built `InstancedMesh`. Default `false`, as in Three.js. */
  readonly receiveShadow?: boolean;
}

interface IModelPartTemplate {
  readonly geometry: BufferGeometry;
  readonly material: Material;
  readonly label: string;
  readonly localMatrices: Matrix4[];
  readonly provenance: string[];
}

function validateCellSize(cellSize: number | false | undefined): number | false {
  if (cellSize === undefined) return INSTANCED_MODEL_DEFAULT_CELL_SIZE;
  if (cellSize === false) return false;
  if (typeof cellSize !== "number" || !Number.isFinite(cellSize) || cellSize <= 0)
    throw new Error("InstancedModel.cellSize must be a positive finite number or false.");
  return cellSize;
}

function validateAutoLod(autoLod: IInstancedLodOptions["autoLod"]): void {
  if (autoLod === undefined || autoLod === false) return;
  if (autoLod === null || typeof autoLod !== "object")
    throw new Error("InstancedModel.autoLod must be false or selection options.");
  if (
    autoLod.maxPixelError !== undefined &&
    (!Number.isFinite(autoLod.maxPixelError) || autoLod.maxPixelError <= 0)
  )
    throw new Error("InstancedModel.autoLod requires positive maxPixelError.");
  if (
    autoLod.hysteresis !== undefined &&
    (!Number.isFinite(autoLod.hysteresis) || autoLod.hysteresis < 0 || autoLod.hysteresis >= 1)
  )
    throw new Error("InstancedModel.autoLod requires hysteresis in [0, 1).");
}

function extractLocalMatrices(
  mesh: Mesh & { isInstancedMesh?: boolean },
  toRoot: Matrix4,
): Matrix4[] {
  const baseMatrix = new Matrix4().multiplyMatrices(toRoot, mesh.matrixWorld);
  if (mesh.isInstancedMesh !== true) return [baseMatrix];
  const instanced = mesh as InstancedMesh;
  const matrices: Matrix4[] = [];
  const slot = new Matrix4();
  for (let index = 0; index < instanced.count; index += 1) {
    instanced.getMatrixAt(index, slot);
    matrices.push(new Matrix4().multiplyMatrices(baseMatrix, slot));
  }
  return matrices;
}

function sectionCloneKey(start: number, count: number): string {
  return `${start}:${count}`;
}

function isStaticMesh(
  mesh: Mesh & { isMesh?: boolean; isSkinnedMesh?: boolean },
  skip: ((mesh: Mesh) => boolean) | undefined,
): boolean {
  return mesh.isMesh === true && mesh.isSkinnedMesh !== true && skip?.(mesh) !== true;
}

/** One material group of `base` as a draw-range clone, shared across meshes that reuse `base`. */
function sectionSlice(
  base: BufferGeometry,
  group: { readonly start: number; readonly count: number } | undefined,
  splitCache: Map<BufferGeometry, Map<string, BufferGeometry>>,
  provenance: readonly string[],
): BufferGeometry | undefined {
  // A single-material mesh shares its base geometry, so a baked AutoLOD chain stays active.
  if (group === undefined) return base;
  const start = Math.max(group.start, base.drawRange.start);
  const end = Math.min(group.start + group.count, base.drawRange.start + base.drawRange.count);
  const count = Math.max(0, end - start);
  if (count === 0) return undefined;
  let ranges = splitCache.get(base);
  if (ranges === undefined) {
    ranges = new Map();
    splitCache.set(base, ranges);
  }
  const rangeKey = sectionCloneKey(start, count);
  let slice = ranges.get(rangeKey);
  if (slice === undefined) {
    slice = base.clone();
    slice.clearGroups();
    slice.setDrawRange(start, count);
    // `BufferGeometry.copy` shares `userData`; detach it so the stamp never lands on the source.
    slice.userData = { ...slice.userData };
    writeAssetProvenance(slice.userData, provenance);
    ranges.set(rangeKey, slice);
  }
  return slice;
}

function collectModelParts(
  source: Object3D,
  skip: ((mesh: Mesh) => boolean) | undefined,
): IModelPartTemplate[] {
  source.updateMatrixWorld(true);
  const toRoot = new Matrix4().copy(source.matrixWorld).invert();
  const byPair = new Map<BufferGeometry, Map<Material, IModelPartTemplate>>();
  const splitCache = new Map<BufferGeometry, Map<string, BufferGeometry>>();

  const registerPart = (
    geometry: BufferGeometry,
    material: Material,
    label: string,
    localMatrices: readonly Matrix4[],
    provenance: readonly string[],
  ): void => {
    let forMaterial = byPair.get(geometry);
    if (forMaterial === undefined) {
      forMaterial = new Map();
      byPair.set(geometry, forMaterial);
    }
    let template = forMaterial.get(material);
    if (template === undefined) {
      template = {
        geometry,
        material,
        label,
        localMatrices: [],
        provenance: [],
      };
      forMaterial.set(material, template);
    }
    for (const matrix of localMatrices) template.localMatrices.push(matrix);
    for (const path of provenance)
      if (!template.provenance.includes(path)) template.provenance.push(path);
  };

  source.traverse((object) => {
    const renderable = object as Mesh & {
      isMesh?: boolean;
      isSkinnedMesh?: boolean;
      isInstancedMesh?: boolean;
    };
    if (!isStaticMesh(renderable, skip)) return;
    const localMatrices = extractLocalMatrices(renderable, toRoot);
    if (localMatrices.length === 0) return;
    const baseGeometry = baseGeometryOf(renderable);
    const provenance = [
      ...readAssetProvenance(baseGeometry.userData),
      ...ancestorAssetProvenance(renderable),
    ];
    for (const section of meshSections(renderable)) {
      if (section.material === undefined || section.material === null) continue;
      const geometry = sectionSlice(baseGeometry, section.group, splitCache, provenance);
      if (geometry === undefined) continue;
      registerPart(
        geometry,
        section.material,
        renderable.name || section.material.name,
        localMatrices,
        provenance,
      );
    }
  });

  const templates: IModelPartTemplate[] = [];
  for (const forMaterial of byPair.values()) {
    for (const template of forMaterial.values()) templates.push(template);
  }
  return templates;
}

function partName(
  prefix: string | undefined,
  cellKey: string,
  label: string,
  partIndex: number,
): string | undefined {
  if (prefix === undefined) return undefined;
  const suffix = label ? `${label}#${partIndex}` : `part${partIndex}`;
  return cellKey === "" ? `${prefix}:${suffix}` : `${prefix}:cell(${cellKey}):${suffix}`;
}

function stampPartProvenance(mesh: InstancedMesh, provenance: readonly string[]): void {
  if (provenance.length === 0) return;
  for (const target of [mesh, ...mesh.children]) {
    writeAssetProvenance(target.userData, [...readAssetProvenance(target.userData), ...provenance]);
  }
}

/**
 * Instances a multi-mesh, multi-material static model across many world placements with
 * automatic XZ spatial cell bucketing, AutoLOD chain preservation and asset provenance survival.
 *
 * Unlike `InstancedBatch`, which draws one `(geometry, material)` shape, an imported `.glb`
 * hierarchy carries multiple child meshes, local node transforms and material sections. Without
 * a multi-part wrapper, callers must either rebuild the hierarchy traversal, bake child matrices,
 * slice multi-material groups, bucket into spatial cells for frustum culling and propagate
 * `GEOMETRY_ASSET_KEY` provenance on every call site, or spawn hundreds of full `clone()`s.
 *
 * `InstancedModel` decides no appearance and builds standard `InstancedBatch` meshes on the
 * model's own geometries and materials.
 */
export class InstancedModel {
  readonly #parts: readonly IModelPartTemplate[];
  readonly #cellSize: number | false;
  readonly #autoLod: IInstancedLodOptions["autoLod"];
  readonly #placements: Matrix4[] = [];
  readonly #scratch = new Object3D();
  readonly #instanceMatrix = new Matrix4();
  #meshes: InstancedMesh[] = [];
  #built = false;

  constructor(options: IInstancedModelOptions) {
    if (options === undefined || options === null)
      throw new Error("InstancedModel requires source options.");
    if (!(options.source instanceof Object3D))
      throw new Error("InstancedModel.source must be an Object3D.");
    this.#cellSize = validateCellSize(options.cellSize);
    validateAutoLod(options.autoLod);
    this.#autoLod = options.autoLod;
    this.#parts = collectModelParts(options.source, options.skip);
    if (this.#parts.length === 0)
      throw new Error("InstancedModel.source contains no static meshes to instance.");
  }

  /** How many model placements have been recorded so far. */
  get count(): number {
    return this.#placements.length;
  }

  /** Built `InstancedMesh` batches after {@link build}, or empty before it. */
  get meshes(): readonly InstancedMesh[] {
    return this.#meshes;
  }

  /**
   * Records one model placement from a caller-composed matrix and returns its placement index.
   *
   * The matrix is cloned, so the caller may reuse a single scratch `Matrix4` across calls.
   */
  add(matrix: Matrix4): number {
    this.#assertOpen("add");
    if (!(matrix instanceof Matrix4)) throw new Error("InstancedModel.add requires a Matrix4.");
    if (matrix.elements.some((value) => !Number.isFinite(value)))
      throw new Error("InstancedModel.add matrix must contain finite numbers.");
    this.#placements.push(matrix.clone());
    return this.#placements.length - 1;
  }

  /** Records one model placement from position, scale and Euler rotation, and returns its index. */
  place(placement: IInstancedPlacement): number {
    this.#assertOpen("place");
    this.#placements.push(composePlacement(placement, "InstancedModel", this.#scratch));
    return this.#placements.length - 1;
  }

  /**
   * Turns every recorded placement into spatially bucketed `InstancedMesh` batches — one per
   * active `(cell, geometry, material)` part — preserving child transforms, AutoLOD chains and
   * asset provenance stamps. Returns an empty array when nothing was placed.
   */
  build(options: IInstancedModelBuildOptions = {}): InstancedMesh[] {
    if (this.#built)
      throw new Error("InstancedModel.build was already called; the instance count is fixed.");
    this.#built = true;
    if (this.#placements.length === 0) return [];
    const buckets = this.#bucketPlacements();
    const built: InstancedMesh[] = [];
    for (const [cellKey, placements] of buckets) {
      this.#parts.forEach((part, partIndex) => {
        const batch = new InstancedBatch({
          geometry: part.geometry,
          material: part.material,
          ...(this.#autoLod !== undefined ? { autoLod: this.#autoLod } : {}),
        });
        for (const placement of placements) {
          for (const local of part.localMatrices) {
            this.#instanceMatrix.multiplyMatrices(placement, local);
            batch.add(this.#instanceMatrix);
          }
        }
        const mesh = batch.build({
          castShadow: options.castShadow,
          name: partName(options.name, cellKey, part.label, partIndex),
          parent: options.parent,
          receiveShadow: options.receiveShadow,
        });
        if (mesh === undefined) return;
        stampPartProvenance(mesh, part.provenance);
        built.push(mesh);
      });
    }
    this.#meshes = built;
    return [...built];
  }

  #bucketPlacements(): Map<string, Matrix4[]> {
    const buckets = new Map<string, Matrix4[]>();
    const cellSize = this.#cellSize;
    for (const matrix of this.#placements) {
      const key =
        cellSize === false
          ? ""
          : `${Math.floor((matrix.elements[12] as number) / cellSize)},${Math.floor(
              (matrix.elements[14] as number) / cellSize,
            )}`;
      let bucket = buckets.get(key);
      if (bucket === undefined) {
        bucket = [];
        buckets.set(key, bucket);
      }
      bucket.push(matrix);
    }
    return buckets;
  }

  #assertOpen(method: string): void {
    if (this.#built)
      throw new Error(
        `InstancedModel.${method} after build(): instance counts are fixed once built.`,
      );
  }
}
