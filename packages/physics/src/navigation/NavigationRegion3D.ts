import { NavMesh, NavMeshQuery } from "recast-navigation";
import { generateSoloNavMesh } from "recast-navigation/generators";
import { type BufferGeometry, type Object3D, Vector3 } from "three";
import type { INavigationContext } from "./index.js";

export interface INavigationRegion3DOptions {
  readonly navigation: INavigationContext;
  readonly meshes: readonly Object3D[];
  readonly cellSize?: number;
  readonly cellHeight?: number;
  readonly agentRadius?: number;
  readonly agentHeight?: number;
  readonly agentMaxClimb?: number;
  readonly agentMaxSlope?: number;
}

const DEFAULTS = {
  agentHeight: 1.4,
  agentMaxClimb: 0.35,
  agentMaxSlope: 45,
  agentRadius: 0.35,
  cellHeight: 0.1,
  cellSize: 0.1,
} as const;

interface IGeometryData {
  readonly indices: number[];
  readonly positions: number[];
}

function finitePositive(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`NavigationRegion3D ${name} must be finite and positive.`);
  return value;
}

function finiteNonNegative(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`NavigationRegion3D ${name} must be finite and non-negative.`);
  return value;
}

function collectGeometry(meshes: readonly Object3D[]): IGeometryData {
  const positions: number[] = [];
  const indices: number[] = [];
  const vertex = new Vector3();
  for (const root of meshes) {
    root.updateWorldMatrix(true, true);
    root.traverse((object) => {
      if (object.type !== "Mesh" || !("geometry" in object)) return;
      const mesh = object as Object3D & { geometry: BufferGeometry };
      const attribute = mesh.geometry.getAttribute("position");
      if (attribute === undefined) return;
      const base = positions.length / 3;
      for (let index = 0; index < attribute.count; index += 1) {
        vertex.fromBufferAttribute(attribute, index).applyMatrix4(object.matrixWorld);
        positions.push(vertex.x, vertex.y, vertex.z);
      }
      const index = mesh.geometry.getIndex();
      if (index !== null) {
        for (let offset = 0; offset < index.count; offset += 1)
          indices.push(base + index.getX(offset));
      } else {
        if (attribute.count % 3 !== 0)
          throw new Error("NavigationRegion3D requires triangle indices.");
        for (let offset = 0; offset < attribute.count; offset += 1) indices.push(base + offset);
      }
    });
  }
  if (indices.length === 0) throw new Error("NavigationRegion3D requires at least one triangle.");
  return { indices, positions };
}

function emptyNavigationMesh(): { readonly navMesh: NavMesh; readonly query: NavMeshQuery } {
  const navMesh = new NavMesh();
  const query = new NavMeshQuery(navMesh, { maxNodes: 4096 });
  query.defaultQueryHalfExtents = { x: 2, y: 4, z: 2 };
  return { navMesh, query };
}

export class NavigationRegion3D {
  readonly navigation: INavigationContext;
  readonly meshes: readonly Object3D[];
  navigationMesh: NavMesh;
  #options: INavigationRegion3DOptions;
  #enabled = true;
  #disposed = false;

  constructor(options: INavigationRegion3DOptions) {
    if (options.navigation === undefined)
      throw new Error("NavigationRegion3D requires a navigation context.");
    this.navigation = options.navigation;
    this.meshes = options.meshes;
    this.#options = options;
    this.navigationMesh = this.bakeNavigationMesh();
    this.navigation.regions.add(this);
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  set enabled(value: boolean) {
    this.#enabled = value;
  }

  bakeNavigationMesh(): NavMesh {
    if (this.#disposed) throw new Error("NavigationRegion3D cannot bake after dispose.");
    if (this.navigation.agents.size > 0 || this.navigation.obstacles.size > 0)
      throw new Error("NavigationRegion3D cannot bake while navigation agents or obstacles exist.");

    const cellSize = finitePositive("cellSize", this.#options.cellSize ?? DEFAULTS.cellSize);
    const cellHeight = finitePositive(
      "cellHeight",
      this.#options.cellHeight ?? DEFAULTS.cellHeight,
    );
    const agentRadius = finiteNonNegative(
      "agentRadius",
      this.#options.agentRadius ?? DEFAULTS.agentRadius,
    );
    const agentHeight = finitePositive(
      "agentHeight",
      this.#options.agentHeight ?? DEFAULTS.agentHeight,
    );
    const agentMaxClimb = finiteNonNegative(
      "agentMaxClimb",
      this.#options.agentMaxClimb ?? DEFAULTS.agentMaxClimb,
    );
    const agentMaxSlope = this.#options.agentMaxSlope ?? DEFAULTS.agentMaxSlope;
    if (!Number.isFinite(agentMaxSlope) || agentMaxSlope < 0 || agentMaxSlope >= 90)
      throw new Error("NavigationRegion3D agentMaxSlope must be finite and between 0 and 90.");

    const geometry = collectGeometry(this.meshes);
    const result = generateSoloNavMesh(geometry.positions, geometry.indices, {
      cs: cellSize,
      ch: cellHeight,
      walkableHeight: Math.max(3, Math.ceil(agentHeight / cellHeight)),
      walkableClimb: Math.floor(agentMaxClimb / cellHeight),
      walkableRadius: Math.floor(agentRadius / cellSize),
      walkableSlopeAngle: agentMaxSlope,
    });
    if (!result.success)
      throw new Error(`NavigationRegion3D could not bake a navmesh: ${result.error}`);

    const previousQuery = this.navigation.query;
    const previousMesh = this.navigation.navMesh;
    const nextQuery = new NavMeshQuery(result.navMesh, { maxNodes: 4096 });
    nextQuery.defaultQueryHalfExtents = { x: 2, y: 4, z: 2 };
    this.navigation.query = nextQuery;
    this.navigation.navMesh = result.navMesh;
    this.navigationMesh = result.navMesh;
    // Queries are owned by no region, so the superseded one always dies here; the superseded
    // mesh may still belong to another live region, whose own dispose() frees it — destroying
    // it here too was a double-free that corrupted the WASM heap ("memory access out of
    // bounds") on any scene with two regions.
    previousQuery.destroy();
    const supersededElsewhere = [...this.navigation.regions].some(
      (region) => region !== this && region.navigationMesh === previousMesh,
    );
    if (!supersededElsewhere) previousMesh.destroy();
    return result.navMesh;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.navigation.regions.delete(this);
    if (this.navigation.navMesh === this.navigationMesh) {
      // Agents and obstacles are context-wide and belong to the active mesh. A superseded
      // region being disposed must release only its own bake, or it destroys the agents walking
      // on the region that replaced it.
      for (const obstacle of [...this.navigation.obstacles]) obstacle.dispose();
      for (const agent of [...this.navigation.agents]) agent.dispose();
      this.navigation.crowd?.destroy();
      this.navigation.crowd = undefined;
      this.navigation.query.destroy();
      this.navigation.navMesh.destroy();
      const empty = emptyNavigationMesh();
      this.navigation.query = empty.query;
      this.navigation.navMesh = empty.navMesh;
    } else {
      this.navigationMesh.destroy();
    }
  }
}
