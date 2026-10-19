// Imported models: a registered GLB becomes placeable props.
//
// The editor addon validates and measures a file and keeps a palette entry; what the model looks
// like is this game's: it keeps the materials the file was authored with, and it is placed through
// the same instanced props every starter shape uses. A file's own lights and cameras are never
// read, because only meshes are taken from it, so they cannot light the world or move the view.
import type { IAssetLoader } from "@threenative/core";
import type { IProjectAsset } from "@threenative/terrain/editor";
import {
  Box3,
  type BufferGeometry,
  type Group,
  type Material,
  Matrix4,
  type Mesh,
  Vector3,
} from "three";
import { type IPropPart, PROP_ASSETS } from "./props.js";

export interface IImportedStatus {
  readonly id: string;
  readonly status: "loading" | "ready" | "failed";
  readonly sha256: string;
  readonly error?: string;
  readonly triangles: number;
  /** Measured from the geometry actually placed, in metres, after the scale and pivot adjustment. */
  readonly bounds?: { min: number[]; max: number[] };
  readonly parts: number;
}

interface IEntry {
  asset: IProjectAsset;
  status: IImportedStatus["status"];
  error?: string;
  parts: IPropPart[];
  load: Promise<void>;
}

/** The adjustment as one matrix: model units to metres, then the pivot onto the placement point. */
function adjustment(box: Box3, asset: IProjectAsset): Matrix4 {
  const scale = asset.adjust?.scale ?? 1;
  const scaled = box.clone().applyMatrix4(new Matrix4().makeScale(scale, scale, scale));
  const centre = scaled.getCenter(new Vector3());
  const pivot = asset.adjust?.pivot ?? "base";
  const shift =
    pivot === "origin"
      ? new Vector3()
      : new Vector3(-centre.x, pivot === "base" ? -scaled.min.y : -centre.y, -centre.z);
  return new Matrix4()
    .makeTranslation(shift.x, shift.y, shift.z)
    .multiply(new Matrix4().makeScale(scale, scale, scale));
}

/**
 * Keep the prop registry equal to the project's registered models.
 *
 * `parts` is the editor's own variant map and `PROP_ASSETS` is the palette the scatter tool offers;
 * a ready model writes one variant into both, and a removed or replaced one takes its entries away.
 * A model that fails to load keeps whatever it had, and reports why by name.
 */
export function createImportedModels(
  assets: IAssetLoader,
  parts: Map<string, IPropPart[]>,
  urlOf: (asset: IProjectAsset) => string,
) {
  const entries = new Map<string, IEntry>();

  function drop(id: string): void {
    const entry = entries.get(id);
    for (const part of entry?.parts ?? []) part.geometry.dispose();
    parts.delete(`${id}:0`);
    Reflect.deleteProperty(PROP_ASSETS, id);
    entries.delete(id);
  }

  async function load(entry: IEntry): Promise<void> {
    try {
      const gltf = await assets.model<{ scene?: Group }>(urlOf(entry.asset));
      if (entries.get(entry.asset.id) !== entry) return; // removed while loading
      if (!gltf.scene) throw new Error("the file has no scene");
      gltf.scene.updateMatrixWorld(true);
      const found: { geometry: BufferGeometry; material: Material }[] = [];
      gltf.scene.traverse((object) => {
        const mesh = object as Mesh;
        if (!mesh.isMesh) return;
        const geometry = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
        if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
        const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
        if (material) found.push({ geometry, material });
      });
      if (!found.length) throw new Error("the file has no mesh to place");
      const box = new Box3();
      for (const { geometry } of found) {
        geometry.computeBoundingBox();
        if (geometry.boundingBox) box.union(geometry.boundingBox);
      }
      const matrix = adjustment(box, entry.asset);
      // The part that reaches the ground is the first, because grounding measures it, and it is the
      // body the selection handles centre on; every other part rides along with the same pose.
      const placed = found
        .map(({ geometry, material }) => {
          geometry.applyMatrix4(matrix);
          geometry.computeBoundingBox();
          return { geometry, material, low: geometry.boundingBox?.min.y ?? 0 };
        })
        .sort((a, b) => a.low - b.low);
      const next: IPropPart[] = placed.map(({ geometry, material }, index) => ({
        geometry,
        material,
        role: index === 0 ? "stone" : "crown",
        variant: 0,
      }));
      for (const part of entry.parts) part.geometry.dispose();
      entry.parts = next;
      parts.set(`${entry.asset.id}:0`, next);
      PROP_ASSETS[entry.asset.id] = 1;
      entry.status = "ready";
      entry.error = undefined;
    } catch (error) {
      entry.status = "failed";
      entry.error = `${entry.asset.id}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  return {
    /** Start loading what is new or changed and drop what the document no longer lists. */
    sync(list: readonly IProjectAsset[]): void {
      const models = list.filter((asset) => asset.kind === "model");
      for (const id of [...entries.keys()]) if (!models.some((asset) => asset.id === id)) drop(id);
      for (const asset of models) {
        const known = entries.get(asset.id);
        if (
          known &&
          known.asset.sha256 === asset.sha256 &&
          JSON.stringify(known.asset.adjust) === JSON.stringify(asset.adjust)
        )
          continue;
        // A replaced or re-scaled model loads again from its own hash-named URL; what it had stays
        // placeable until the new one is ready, and keeps its parts if the new one fails.
        const entry: IEntry = known
          ? Object.assign(known, { asset, status: "loading" as const })
          : { asset, status: "loading", parts: [], load: Promise.resolve() };
        entries.set(asset.id, entry);
        entry.load = load(entry);
      }
    },
    ready: async (): Promise<void> => {
      await Promise.all([...entries.values()].map((entry) => entry.load));
    },
    status(): IImportedStatus[] {
      return [...entries.values()].map((entry) => {
        const box = new Box3();
        let triangles = 0;
        for (const part of entry.parts) {
          part.geometry.computeBoundingBox();
          if (part.geometry.boundingBox) box.union(part.geometry.boundingBox);
          triangles +=
            (part.geometry.index?.count ?? part.geometry.getAttribute("position").count) / 3;
        }
        return {
          id: entry.asset.id,
          status: entry.status,
          sha256: entry.asset.sha256,
          ...(entry.error ? { error: entry.error } : {}),
          triangles,
          ...(box.isEmpty() ? {} : { bounds: { min: box.min.toArray(), max: box.max.toArray() } }),
          parts: entry.parts.length,
        };
      });
    },
    /** The reason the last attempt for one id failed, if it did. */
    failure(id: string): string | undefined {
      return entries.get(id)?.error;
    },
    dispose(): void {
      for (const id of [...entries.keys()]) drop(id);
    },
  };
}
