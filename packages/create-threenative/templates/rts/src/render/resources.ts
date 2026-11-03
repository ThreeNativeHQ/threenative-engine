// Generated for you. This is ordinary Three.js — edit or delete it freely.
//
// The two things worth walking to: an ore field and a gas vent. Both are instanced and both are
// cut by the same fog of war as the terrain — a vent nobody has scouted is not on the map, and an
// ore field visibly shortens as the Surveyors empty it, so the economy is legible from the field
// alone without opening a panel.
import {
  ConeGeometry,
  CylinderGeometry,
  IcosahedronGeometry,
  InstancedMesh,
  MeshStandardMaterial,
  Object3D,
} from "three";
import type { Game } from "../sim/game.js";
import { HALF, RESOURCE_SITES, terrainHeight } from "../sim/terrain.js";

/** Seven crystals per ore node, as authored: the multiplier is what makes a field read as one
 * deposit rather than as seven unrelated props. */
const CRYSTALS = 7;
const ROCKS = 5;
const CRYSTAL_HEIGHT = [1.05, 1.6, 2.15, 2.7, 3.25] as const;

const _dummy = new Object3D();

export interface IResources {
  readonly root: Object3D;
  readonly sync: (game: Game) => void;
  readonly dispose: () => void;
}

export function createResources(): IResources {
  const root = new Object3D();
  const sites = RESOURCE_SITES.length;
  // AstraCraft's unit cone, scaled 0.46-0.74 wide, in its two crystal materials: one crystal in
  // three is the pale, less metallic one that catches the sun (PRD-765 judge round 2).
  const cone = new ConeGeometry(1, 1, 5);
  const crystal = (color: number, emissive: number, metalness: number, roughness: number) =>
    new InstancedMesh(
      cone,
      new MeshStandardMaterial({ color, emissive, emissiveIntensity: 1.5, metalness, roughness }),
      sites * CRYSTALS,
    );
  const crystals = crystal(0x38a5c5, 0x065572, 0.5, 0.2);
  const pale = crystal(0x8ae5f1, 0x166984, 0.25, 0.21);
  const vents = new InstancedMesh(
    new CylinderGeometry(2.5, 2.7, 0.35, 6),
    new MeshStandardMaterial({ color: 0x314b39, roughness: 0.9 }),
    sites,
  );
  const rubble = new InstancedMesh(
    new IcosahedronGeometry(0.7, 0),
    new MeshStandardMaterial({ color: 0x6b7050, roughness: 1 }),
    sites * ROCKS,
  );
  // Listed once: the sync below walks this every frame, and a literal here is an array a frame.
  const meshes = [crystals, pale, vents, rubble];
  for (const mesh of meshes) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.count = 0;
    root.add(mesh);
  }
  return {
    root,
    sync: (game) => {
      let dark = 0;
      let light = 0;
      let vent = 0;
      let rock = 0;
      for (const node of game.nodes) {
        if (node.amount <= 0 || !scouted(game, node.x, node.z)) continue;
        const ground = terrainHeight(node.x, node.z);
        if (node.kind === "ore") {
          // A field that has been half mined is half as tall, which is the whole readout.
          const left = 0.4 + 0.6 * Math.min(1, node.amount / 2100);
          for (let index = 0; index < CRYSTALS; index += 1) {
            const angle = 0.15 + (index / CRYSTALS) * Math.PI * 1.8;
            // Within 1.25 m of the node, as AstraCraft packs them: one deposit, not a ring of spikes.
            const spread = (1.25 * (1 + (index % 3))) / 3;
            const height = (CRYSTAL_HEIGHT[index % CRYSTAL_HEIGHT.length] ?? 1) * left;
            _dummy.position.set(
              node.x + Math.cos(angle) * spread,
              ground + height * 0.47,
              node.z + Math.sin(angle) * spread,
            );
            _dummy.rotation.set(((index % 5) - 2) * 0.08, angle, ((index % 3) - 1) * 0.16);
            _dummy.scale.set(0.46 + (index % 3) * 0.14, height, 0.5 + (index % 2) * 0.2);
            _dummy.updateMatrix();
            if (index % 3 === 0) pale.setMatrixAt(light++, _dummy.matrix);
            else crystals.setMatrixAt(dark++, _dummy.matrix);
          }
        } else {
          _dummy.position.set(node.x, ground + 0.18, node.z);
          _dummy.rotation.set(0, node.x * 0.1, 0);
          _dummy.scale.set(1, 1, 1);
          _dummy.updateMatrix();
          vents.setMatrixAt(vent, _dummy.matrix);
          vent += 1;
          for (let index = 0; index < ROCKS; index += 1) {
            const angle = (index / ROCKS) * Math.PI * 2;
            _dummy.position.set(
              node.x + Math.cos(angle) * 2,
              ground + 0.3,
              node.z + Math.sin(angle) * 2,
            );
            _dummy.rotation.set(angle, angle * 1.7, 0);
            _dummy.scale.setScalar(0.85 + (index % 3) * 0.18);
            _dummy.updateMatrix();
            rubble.setMatrixAt(rock, _dummy.matrix);
            rock += 1;
          }
        }
      }
      crystals.count = dark;
      pale.count = light;
      vents.count = vent;
      rubble.count = rock;
      for (const mesh of meshes) {
        // No bound: every batch is `frustumCulled = false`, so nothing reads one.
        mesh.instanceMatrix.needsUpdate = true;
      }
    },
    dispose: () => {
      for (const mesh of meshes) {
        mesh.geometry.dispose();
        (mesh.material as MeshStandardMaterial).dispose();
      }
    },
  };
}

/** Whether the cell has ever been seen: the fog of war applies to the map, not just the armies. */
function scouted(game: Game, x: number, z: number): boolean {
  const ix = Math.floor((x + HALF) / game.cell);
  const iz = Math.floor((z + HALF) / game.cell);
  if (ix < 0 || iz < 0 || ix >= game.gridSize || iz >= game.gridSize) return false;
  return game.explored[iz * game.gridSize + ix] === 1;
}
