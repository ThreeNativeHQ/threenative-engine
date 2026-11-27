/**
 * Node-side helpers for `scripts/bake-<name>.mjs`: build a procedural model in three.js, merge it
 * by material, ground it, and write one self-contained `.glb` stamped `tnOrigin: "procedural"`.
 *
 * Every bake script used to re-author the same 90 to 150 lines (a `FileReader` polyfill, the
 * `GLTFExporter` extras, material factories, a merge, a grounding check). Import this instead.
 * Nothing here decides how the model looks: the geometry, colours and finishes are the script's.
 */
import {
  Box3,
  type BufferGeometry,
  type ColorRepresentation,
  Group,
  type Material,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  Vector3,
} from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { mergeByMaterial } from "./merge-parts.js";

export { mergeByMaterial };

export interface IPbrMaterialOptions {
  readonly metalness?: number;
  readonly name?: string;
  readonly roughness?: number;
}

/**
 * A plain PBR material (`MeshStandardMaterial`). Give each distinct finish its own `name`: the name
 * is the glTF material name and `inspect` lists it.
 * @requires import { createPbrMaterial } from "@threenative/core/bake"
 * @situation bake a procedural model to a glb: make a painted, metal or rubber material for a part
 * @alias bake material, glb material factory, standard material
 * @example const paint = createPbrMaterial(0xcc2222, { name: "paint", metalness: 0.6, roughness: 0.3 });
 */
export function createPbrMaterial(
  color: ColorRepresentation,
  options: IPbrMaterialOptions = {},
): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color,
    metalness: options.metalness ?? 0,
    name: options.name ?? "",
    roughness: options.roughness ?? 0.7,
  });
}

/**
 * A glowing material: the colour is emitted at `intensity`, with the surface itself dark so it
 * reads as a light source (a lamp, a screen, a neon strip).
 * @requires import { createEmissiveMaterial } from "@threenative/core/bake"
 * @situation bake a procedural model to a glb: make a lamp, neon strip, window or screen glow
 * @alias bake emissive, glow material, neon material
 * @example const neon = createEmissiveMaterial(0x33ffee, 2, { name: "neon" });
 */
export function createEmissiveMaterial(
  color: ColorRepresentation,
  intensity = 1,
  options: IPbrMaterialOptions = {},
): MeshStandardMaterial {
  const material = createPbrMaterial(0x000000, { roughness: 0.4, ...options });
  material.emissive.set(color);
  material.emissiveIntensity = intensity;
  return material;
}

export interface IPartPlacement {
  readonly name?: string;
  readonly position?: readonly [number, number, number];
  /** Euler angles in radians, XYZ order. */
  readonly rotation?: readonly [number, number, number];
  readonly scale?: number | readonly [number, number, number];
}

/**
 * Add one primitive to a model: geometry, material and where it sits. Returns the mesh.
 * @requires import { addPart } from "@threenative/core/bake"
 * @situation bake a procedural model to a glb: place a box, cylinder or sphere part on the model
 * @alias bake add part, place mesh part
 * @example addPart(root, new BoxGeometry(2, 0.5, 4), paint, { position: [0, 0.5, 0], name: "body" });
 */
export function addPart(
  parent: Object3D,
  geometry: BufferGeometry,
  material: Material,
  placement: IPartPlacement = {},
): Mesh {
  const mesh = new Mesh(geometry, material);
  if (placement.name !== undefined) mesh.name = placement.name;
  if (placement.position) mesh.position.set(...placement.position);
  if (placement.rotation) mesh.rotation.set(...placement.rotation);
  const scale = placement.scale;
  if (typeof scale === "number") mesh.scale.setScalar(scale);
  else if (scale) mesh.scale.set(...scale);
  parent.add(mesh);
  return mesh;
}

/**
 * Strip a donor model (a downloaded or Blender-exported scene) of its materials, textures and
 * vertex colours and put one `material` on every mesh, so the script paints it. Mutates and
 * returns `root`.
 * @requires import { prepareDonorWithoutMaterials } from "@threenative/core/bake"
 * @situation bake a procedural model to a glb: reuse a donor glb's shape without its textures or materials
 * @alias donor model, strip materials, repaint imported glb
 * @example prepareDonorWithoutMaterials(donor.scene, createPbrMaterial(0x888888, { name: "base" }));
 */
export function prepareDonorWithoutMaterials<T extends Object3D>(root: T, material: Material): T {
  root.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    for (const old of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (old !== material) old.dispose();
    }
    mesh.material = material;
    mesh.geometry.deleteAttribute("color");
  });
  return root;
}

export interface IExportProceduralGlbOptions {
  /** Shift the model up or down so its lowest point is y = 0. Default true. */
  readonly groundToZero?: boolean;
  /** Merge meshes that share a material into one. Default true. */
  readonly merge?: boolean;
  /** Written to the GLB as `asset.extras.tnPrompt`: what this model is. */
  readonly prompt: string;
  /** Refuse a model whose longest axis is outside `[min, max]` metres. A non-finite or empty bound always throws. */
  readonly validateBounds?: { readonly max?: number; readonly min?: number };
}

export interface IProceduralGlbReceipt {
  /** Draw groups (meshes) in the written file. */
  readonly drawGroups: number;
  readonly bytes: number;
  readonly materials: readonly string[];
  /** Lowest point in metres; 0 when grounded. */
  readonly minY: number;
  readonly path: string;
  readonly size: readonly [number, number, number];
  readonly triangles: number;
}

/** three's `GLTFExporter` reads its Blob through `FileReader`, which Node lacks. */
function ensureFileReader(): void {
  if (Reflect.has(globalThis, "FileReader")) return;
  Reflect.set(
    globalThis,
    "FileReader",
    class {
      result: ArrayBuffer | null = null;
      onloadend: (() => void) | null = null;
      readAsArrayBuffer(blob: Blob): void {
        void blob.arrayBuffer().then((buffer) => {
          this.result = buffer;
          this.onloadend?.();
        });
      }
    },
  );
}

function countTriangles(geometry: BufferGeometry): number {
  return Math.floor((geometry.index?.count ?? geometry.getAttribute("position")?.count ?? 0) / 3);
}

/**
 * Merge, ground, check and write a procedural model as a self-contained binary `.glb` whose
 * `asset.extras` carry `tnOrigin: "procedural"` and `tnPrompt`. Returns what it wrote.
 * @requires import { exportProceduralGlb } from "@threenative/core/bake"
 * @situation bake a procedural model to a glb under assets/ with a node script (scripts/bake-name.mjs)
 * @alias bake script, export glb, GLTFExporter, FileReader polyfill, tnOrigin procedural, ground to zero
 * @constraint node only (it writes a file); the model's look, colours and geometry come from the script
 * @example const receipt = await exportProceduralGlb(root, "assets/lamp.glb", { prompt: "street lamp" });
 */
export async function exportProceduralGlb(
  root: Object3D,
  outPath: string,
  options: IExportProceduralGlbOptions,
): Promise<IProceduralGlbReceipt> {
  ensureFileReader();
  const scene = new Group();
  scene.name = root.name;
  if (options.merge === false) scene.add(root);
  else for (const mesh of mergeByMaterial(root, { label: options.prompt })) scene.add(mesh);
  scene.updateMatrixWorld(true);
  const box = new Box3().setFromObject(scene);
  const size = box.getSize(new Vector3());
  if (box.isEmpty() || ![size.x, size.y, size.z, box.min.y].every(Number.isFinite)) {
    throw new Error(`exportProceduralGlb(${options.prompt}): the model has no finite bounds.`);
  }
  const longest = Math.max(size.x, size.y, size.z);
  const { max, min } = options.validateBounds ?? {};
  if ((max !== undefined && longest > max) || (min !== undefined && longest < min)) {
    throw new Error(
      `exportProceduralGlb(${options.prompt}): longest axis ${longest.toFixed(3)} m is outside [${min ?? 0}, ${max ?? "inf"}].`,
    );
  }
  if (options.groundToZero !== false) {
    scene.position.y -= box.min.y;
    scene.updateMatrixWorld(true);
  }
  const grounded = new Box3().setFromObject(scene);
  const meshes: Mesh[] = [];
  const materials = new Set<string>();
  let triangles = 0;
  scene.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    meshes.push(mesh);
    triangles += countTriangles(mesh.geometry);
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      materials.add(material.name || "(unnamed)");
    }
  });
  const exporter = new GLTFExporter();
  exporter.register((writer) => ({
    afterParse() {
      // `json` is the writer's document; three's typings leave it out.
      const { json } = writer as unknown as {
        json: { asset: { extras?: Record<string, unknown> } };
      };
      json.asset.extras = { tnOrigin: "procedural", tnPrompt: options.prompt };
    },
    name: "ThreeNativeProceduralOrigin",
  }));
  const glb = (await exporter.parseAsync(scene, { binary: true })) as ArrayBuffer;
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, new Uint8Array(glb));
  return {
    bytes: glb.byteLength,
    drawGroups: meshes.length,
    materials: [...materials],
    minY: Math.abs(grounded.min.y) < 1e-6 ? 0 : grounded.min.y,
    path: outPath,
    size: [size.x, size.y, size.z],
    triangles,
  };
}
