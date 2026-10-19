import {
  BufferGeometry,
  type Camera,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Sphere,
  Vector3,
} from "three";
import {
  DISCRETE_LOD_DEFAULT_HYSTERESIS,
  type IModelLodController,
  biasedLodDistance,
  conservativeViewDepth,
  lodChainOf,
  registerModelLodController,
  selectLodLevel,
} from "./model-lod.js";

/** Shared with WorldCells: an instanced prop's projected error budget, in raster pixels. */
export const INSTANCED_LOD_MAX_PIXEL_ERROR = 4;

export interface IInstancedLodOptions {
  /** Baked-chain selection is automatic. `false` leaves detail to the caller. */
  readonly autoLod?: false | { readonly maxPixelError?: number; readonly hysteresis?: number };
  /** Authored distance levels win over the baked chain. Missing geometries report once at build. */
  readonly lods?: readonly {
    readonly distance: number;
    readonly geometry: BufferGeometry | undefined;
  }[];
}

/** Split a broad instance set along its measured longest axis; each leaf owns stable public slots. */
function spatialPartitions(mesh: InstancedMesh): number[][] {
  const limit = Math.ceil(Math.sqrt(mesh.count));
  const matrices = mesh.instanceMatrix.array;
  const groups: number[][] = [];
  const split = (indices: number[]): void => {
    if (indices.length <= limit) {
      groups.push(indices);
      return;
    }
    let axis = 12;
    let extent = -1;
    for (const component of [12, 13, 14]) {
      let min = Number.POSITIVE_INFINITY;
      let max = Number.NEGATIVE_INFINITY;
      for (const index of indices) {
        const value = matrices[index * 16 + component] as number;
        min = Math.min(min, value);
        max = Math.max(max, value);
      }
      if (max - min > extent) {
        extent = max - min;
        axis = component;
      }
    }
    indices.sort(
      (a, b) => (matrices[a * 16 + axis] as number) - (matrices[b * 16 + axis] as number),
    );
    const middle = Math.floor(indices.length / 2);
    split(indices.slice(0, middle));
    split(indices.slice(middle));
  };
  split(Array.from({ length: mesh.count }, (_, index) => index));
  return groups;
}

/** Attach to the engine's existing LOD tracker; the returned mesh retains every public instance slot. */
export function attachInstancedLod(mesh: InstancedMesh, options: IInstancedLodOptions): void {
  if (
    options.autoLod !== undefined &&
    options.autoLod !== false &&
    (options.autoLod === null || typeof options.autoLod !== "object")
  )
    throw new Error("InstancedBatch.autoLod must be false or selection options.");
  const policy = options.autoLod === false ? undefined : options.autoLod;
  const budget = policy?.maxPixelError ?? INSTANCED_LOD_MAX_PIXEL_ERROR;
  const hysteresis = policy?.hysteresis ?? DISCRETE_LOD_DEFAULT_HYSTERESIS;
  if (
    !Number.isFinite(budget) ||
    budget <= 0 ||
    !Number.isFinite(hysteresis) ||
    hysteresis < 0 ||
    hysteresis >= 1
  )
    throw new Error(
      "InstancedBatch.autoLod requires positive maxPixelError and hysteresis in [0, 1).",
    );
  if (options.autoLod === false && options.lods === undefined) return;
  const chain = lodChainOf(mesh.geometry);
  const levels = [mesh.geometry];
  const distances = [0];
  if (options.lods !== undefined) {
    let previous = 0;
    let failed = 0;
    for (const rung of options.lods) {
      if (!Number.isFinite(rung.distance) || rung.distance <= previous)
        throw new Error("InstancedBatch.lods distances must be positive and strictly increasing.");
      previous = rung.distance;
      if (
        rung.geometry === undefined ||
        (rung.geometry.index?.count ?? rung.geometry.getAttribute("position")?.count ?? 0) < 3
      ) {
        failed += 1;
        continue;
      }
      levels.push(rung.geometry);
      distances.push(rung.distance);
    }
    if (failed > 0)
      console.warn(
        `TN_INSTANCED_LOD_FAILED: '${mesh.name || "unnamed"}' skipped ${failed} unavailable authored levels; ${levels.length} usable levels remain.`,
      );
  } else if (chain !== undefined) {
    levels.splice(0, 1, ...chain.levels);
  }
  if (levels.length < 2) {
    const triangles =
      (mesh.geometry.index?.count ?? mesh.geometry.getAttribute("position")?.count ?? 0) / 3;
    if (options.lods === undefined && triangles * mesh.count > 1_000_000)
      console.warn(
        `TN_INSTANCED_LOD_UNAVAILABLE: '${mesh.name || "unnamed"}' draws ${Math.floor(triangles * mesh.count)} triangles without a baked AutoLOD chain; cook the model or supply lods.`,
      );
    return;
  }
  const base = levels[0] as BufferGeometry;
  // Preparation may replace a normal/UV attribute after cloning; index-only rungs share its final streams.
  if (options.lods === undefined)
    for (const level of levels)
      for (const [name, attribute] of Object.entries(base.attributes))
        level.setAttribute(name, attribute);
  base.computeBoundingSphere();
  const local = base.boundingSphere?.clone() ?? new Sphere();
  // A zero-range carrier keeps original matrices/indices queryable without drawing them twice.
  // Children draw the partitions; they share the game's geometries and never own their disposal.
  const carrier = new BufferGeometry();
  for (const [name, attribute] of Object.entries(base.attributes))
    carrier.setAttribute(name, attribute);
  carrier.boundingBox = base.boundingBox;
  carrier.boundingSphere = base.boundingSphere;
  carrier.setIndex([]);
  carrier.setDrawRange(0, 0);
  mesh.geometry = carrier;
  const groups = spatialPartitions(mesh);
  const spareCapacity = mesh.instanceMatrix.count - mesh.count;
  const partitionOf = new Uint32Array(mesh.instanceMatrix.count);
  groups.forEach((indices, partition) => {
    for (const index of indices) partitionOf[index] = partition;
  });
  const states = new Uint16Array(mesh.instanceMatrix.count);
  const cameraPosition = new Vector3();
  const matrix = new Matrix4();
  const world = new Matrix4();
  const sphere = new Sphere();
  let children: InstancedMesh[] = [];
  let triangles = 0;
  function ensureChildren(): void {
    if (children.length > 0) return;
    children = groups.flatMap((indices, partition) =>
      levels.map((geometry, index) => {
        const child = new InstancedMesh(
          geometry,
          mesh.material,
          indices.length + (partition === 0 ? spareCapacity : 0),
        );
        child.name = `${mesh.name || "unnamed"}:cell${partition}:lod${index}`;
        child.count = 0;
        child.castShadow = mesh.castShadow;
        child.receiveShadow = mesh.receiveShadow;
        child.layers.mask = mesh.layers.mask;
        // Zero-count partitions stay visible: projection keys must not churn as detail changes.
        child.visible = true;
        child.frustumCulled = true;
        child.raycast = (): void => {}; // Render partitions have no public placement identity.
        mesh.add(child);
        return child;
      }),
    );
    mesh.geometry = carrier;
  }
  const controller: IModelLodController = {
    base,
    get triangles() {
      return triangles;
    },
    update(camera: Camera, viewportHeight: number): void {
      ensureChildren();
      triangles = 0;
      mesh.updateWorldMatrix(true, false);
      camera.getWorldPosition(cameraPosition);
      for (const child of children) {
        child.count = 0;
        child.material = mesh.material;
        child.layers.mask = mesh.layers.mask;
        child.castShadow = mesh.castShadow;
        child.receiveShadow = mesh.receiveShadow;
        child.matrixWorld.copy(mesh.matrixWorld);
      }
      for (let index = 0; index < mesh.count; index += 1) {
        mesh.getMatrixAt(index, matrix);
        world.multiplyMatrices(mesh.matrixWorld, matrix);
        sphere.copy(local).applyMatrix4(world);
        const view = conservativeViewDepth(
          camera,
          sphere.center,
          sphere.radius,
          (camera as Camera & { near?: number }).near ?? 0,
        );
        let level = 0;
        if (options.lods !== undefined) {
          const distance = biasedLodDistance(cameraPosition.distanceTo(sphere.center));
          while (level + 1 < distances.length && distance >= (distances[level + 1] as number))
            level += 1;
        } else if (chain !== undefined) {
          // Project local error at world scale without copying the chain's errors per placement.
          const scale = world.getMaxScaleOnAxis();
          level = selectLodLevel(
            chain.errors,
            states[index] ?? 0,
            budget / Math.max(scale, Number.EPSILON),
            hysteresis,
            [
              {
                camera,
                viewportHeight,
                depth: biasedLodDistance(view.depth),
                degenerate: view.degenerate,
              },
            ],
          );
        }
        states[index] = level;
        const child = children[
          (partitionOf[index] as number) * levels.length + level
        ] as InstancedMesh;
        child.setMatrixAt(child.count, matrix);
        if (mesh.instanceColor !== null) {
          const color =
            child.instanceColor ??
            new InstancedBufferAttribute(new Float32Array(child.instanceMatrix.count * 3), 3);
          child.instanceColor = color;
          for (let component = 0; component < 3; component += 1)
            color.array[child.count * 3 + component] = mesh.instanceColor.array[
              index * 3 + component
            ] as number;
          color.needsUpdate = true;
        }
        child.count += 1;
      }
      for (const child of children) {
        child.instanceMatrix.needsUpdate = true;
        if (child.count > 0) child.computeBoundingSphere();
        triangles +=
          ((child.geometry.index?.count ?? child.geometry.getAttribute("position")?.count ?? 0) /
            3) *
          child.count;
      }
    },
    release(): void {
      for (const child of children) {
        mesh.remove(child);
        child.dispose();
      }
      children = [];
      mesh.geometry = base;
      triangles = 0;
    },
  };
  const raycast = mesh.raycast.bind(mesh);
  mesh.raycast = (raycaster, intersects): void => {
    const geometry = mesh.geometry;
    mesh.geometry = base;
    try {
      raycast(raycaster, intersects);
    } finally {
      mesh.geometry = geometry;
    }
  };
  registerModelLodController(mesh, controller);
  ensureChildren();
  mesh.addEventListener("dispose", () => controller.release());
}
