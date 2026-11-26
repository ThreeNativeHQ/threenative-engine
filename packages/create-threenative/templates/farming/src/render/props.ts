// Generated for you. Every prop on the farm is a few primitives: no asset.
//
// Tools, the carried crop and the tile highlight live here. The farmer's rig is the combat
// mannequin; `dress` paints it.
import {
  BoxGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type Object3D,
  PlaneGeometry,
  SphereGeometry,
  TorusGeometry,
} from "three";
import { CROPS, CROP_IDS, type CropId } from "../farm/crops.js";
import type { ToolId } from "../farm/tools.js";

/** The farmer's work clothes: blue overalls, so the figure reads against green grass and brown soil. */
export const farmerMaterial = new MeshStandardMaterial({ color: 0x3f6aa8, roughness: 0.6 });

const wood = new MeshStandardMaterial({ color: 0x8b5a2b, roughness: 0.75 });
const iron = new MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.6, roughness: 0.4 });
const tin = new MeshStandardMaterial({ color: 0x5b86b8, metalness: 0.4, roughness: 0.45 });

function part(
  group: Group,
  geometry: BoxGeometry | CylinderGeometry | TorusGeometry,
  material: MeshStandardMaterial,
  at: readonly [number, number, number],
  rotate: readonly [number, number, number] = [0, 0, 0],
): void {
  const mesh = new Mesh(geometry, material);
  mesh.position.set(...at);
  mesh.rotation.set(...rotate);
  mesh.castShadow = true;
  group.add(mesh);
}

/** Each tool has its grip at the origin and its length along +Y, so one hand pose holds them all. */
function createTool(id: ToolId): Group {
  const tool = new Group();
  tool.name = id;
  if (id === "hoe") {
    part(tool, new CylinderGeometry(0.025, 0.025, 1.1, 8), wood, [0, 0.35, 0]);
    part(tool, new BoxGeometry(0.2, 0.025, 0.13), iron, [0, 0.9, 0.06], [0.5, 0, 0]);
  } else if (id === "hammer") {
    part(tool, new CylinderGeometry(0.03, 0.03, 0.75, 8), wood, [0, 0.2, 0]);
    part(tool, new BoxGeometry(0.3, 0.13, 0.13), iron, [0, 0.6, 0]);
  } else if (id === "sickle") {
    part(tool, new CylinderGeometry(0.025, 0.025, 0.3, 8), wood, [0, 0.05, 0]);
    part(
      tool,
      new TorusGeometry(0.17, 0.012, 6, 14, Math.PI * 1.1),
      iron,
      [0, 0.3, 0.12],
      [0, 0, 0.4],
    );
  } else {
    part(tool, new BoxGeometry(0.26, 0.22, 0.2), tin, [0, 0.12, 0]);
    part(tool, new CylinderGeometry(0.025, 0.04, 0.34, 8), tin, [0.2, 0.26, 0], [0, 0, -0.9]);
    part(tool, new TorusGeometry(0.1, 0.012, 6, 12, Math.PI), tin, [-0.04, 0.24, 0]);
  }
  return tool;
}

export interface IToolRack {
  /** Parent this to the hand bone. */
  readonly holder: Group;
  /** Show one tool, or none (seeds and an empty hand). */
  readonly show: (tool: ToolId | undefined) => void;
}

export function createToolRack(): IToolRack {
  const holder = new Group();
  holder.name = "tool-rack";
  const tools = new Map<ToolId, Group>();
  for (const id of ["hoe", "can", "sickle", "hammer"] as const) {
    const tool = createTool(id);
    tool.visible = false;
    tools.set(id, tool);
    holder.add(tool);
  }
  return {
    holder,
    show: (tool) => {
      for (const [id, group] of tools) group.visible = id === tool;
    },
  };
}

/** The crop the farmer carries overhead: one fruit per crop, one shown at a time. */
export function createCarried(): {
  readonly root: Group;
  readonly show: (crop: CropId | undefined) => void;
} {
  const root = new Group();
  root.name = "carried-crop";
  const fruit = new Map<CropId, Mesh>();
  for (const id of CROP_IDS) {
    const mesh = new Mesh(
      new SphereGeometry(0.22, 14, 10),
      new MeshStandardMaterial({ color: CROPS[id].color, roughness: 0.5 }),
    );
    mesh.castShadow = true;
    mesh.visible = false;
    fruit.set(id, mesh);
    root.add(mesh);
  }
  root.visible = false;
  return {
    root,
    show: (crop) => {
      root.visible = crop !== undefined;
      for (const [id, mesh] of fruit) mesh.visible = id === crop;
    },
  };
}

/** The tile under the farmer's tool: a flat square that turns amber when the tool has nothing to do. */
export function createHighlight(size: number): {
  readonly mesh: Mesh;
  readonly set: (ok: boolean) => void;
} {
  const material = new MeshBasicMaterial({
    color: 0xffffff,
    depthWrite: false,
    opacity: 0.32,
    side: DoubleSide,
    transparent: true,
  });
  const mesh = new Mesh(new PlaneGeometry(size - 0.1, size - 0.1).rotateX(-Math.PI / 2), material);
  mesh.name = "tile-highlight";
  mesh.position.y = 0.19;
  mesh.renderOrder = 2;
  return {
    mesh,
    set: (ok) => {
      material.color.setHex(ok ? 0xfff3b0 : 0xff9a7a);
    },
  };
}

/** Swap the skin material on a cloned rig. Only skinned meshes change: a held prop keeps its own. */
export function dress(rig: Object3D, material: MeshStandardMaterial): void {
  rig.traverse((object) => {
    const mesh = object as { isSkinnedMesh?: boolean; material?: unknown };
    if (mesh.isSkinnedMesh === true) mesh.material = material;
  });
}
