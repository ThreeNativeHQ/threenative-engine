// Generated for you. The forest, rocks, grass stems and the far ridge are this game's look.
// Everything here is ordinary Three.js built from code; nothing is loaded.
import {
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  LineSegments,
  Mesh,
  Object3D,
  PlaneGeometry,
  SphereGeometry,
  Vector3,
} from "three";
import { terrainHeight } from "../terrain.js";
import type { SnowMaterials } from "./materials.js";

/** A round obstacle the explorer walks around: centre and radius on the ground plane. */
export interface IObstacle {
  readonly x: number;
  readonly z: number;
  readonly radius: number;
  readonly height: number;
}

function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const smoothstep = (edge0: number, edge1: number, value: number) => {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/** Glade-edge pines by hand, then a ring of forest further out. `[x, z, height]`. */
function treePlacements(random: () => number): Array<[number, number, number]> {
  const trees: Array<[number, number, number]> = [
    [-9, -6, 6.3],
    [9, -5, 7.5],
    [-11.5, 4, 8.2],
    [10.5, 8, 6.4],
    [-7, -14, 7.8],
    [4, -17, 9],
    [-17, -4, 6],
    [16, -9, 9],
  ];
  for (let index = 0; index < 80; index += 1) {
    const angle = random() * Math.PI * 2;
    const radius = 20 + random() * 52;
    trees.push([Math.sin(angle) * radius, Math.cos(angle) * radius, 4.5 + random() * 6.7]);
  }
  return trees;
}

/** Pines within this radius cast shadows; the shadow map only covers the glade anyway. */
const SHADOW_RADIUS = 26;

function forest(materials: SnowMaterials, random: () => number, obstacles: IObstacle[]): Group {
  const placements = treePlacements(random);
  const levels = 15;
  const trunkGeometry = new CylinderGeometry(0.07, 0.14, 1, 9);
  const branchGeometry = new ConeGeometry(1, 1, 7, 1);
  const boughGeometry = new SphereGeometry(1, 6, 4);
  // Two batches: the trees round the glade cast shadows, the far forest does not. One batch of
  // every bough would put the whole forest — most of a million triangles — into the shadow pass.
  const batches = [true, false].map((near) => {
    const count = placements.filter(([x, z]) => Math.hypot(x, z) < SHADOW_RADIUS === near).length;
    const capacity = count * levels * 6;
    return {
      boughs: new InstancedMesh(boughGeometry, materials.bough, capacity),
      branches: new InstancedMesh(branchGeometry, materials.needles, capacity),
      count: 0,
      near,
      trees: 0,
      trunks: new InstancedMesh(trunkGeometry, materials.trunk, count),
    };
  });
  const dummy = new Object3D();
  const up = new Vector3(0, 1, 0);
  const direction = new Vector3();
  placements.forEach(([x, z, height], tree) => {
    const batch = batches[Math.hypot(x, z) < SHADOW_RADIUS ? 0 : 1];
    if (batch === undefined) return;
    const root = terrainHeight(x, z);
    const scale = height / 7;
    dummy.position.set(x, root + height * 0.48, z);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(scale, height, scale);
    dummy.updateMatrix();
    batch.trunks.setMatrixAt(batch.trees, dummy.matrix);
    batch.trees += 1;
    if (Math.hypot(x, z) < 20) obstacles.push({ height, radius: 0.23 * scale, x, z });
    for (let level = 0; level < levels; level += 1) {
      const t = level / levels;
      const y = root + 0.75 + t * (height - 0.65);
      const radius = (1 - t) * height * 0.23 + 0.055;
      // A far tree keeps every tier, so its silhouette holds, with fewer and wider boughs per tier.
      const around = level > 12 || !batch.near ? 4 : 6;
      for (let index = 0; index < around; index += 1) {
        const angle = (index / around) * Math.PI * 2 + level * 0.72 + tree * 1.37;
        const reach = radius * (0.8 + random() * 0.3) * (batch.near ? 1 : 1.2);
        const dx = Math.cos(angle);
        const dz = Math.sin(angle);
        dummy.position.set(x + dx * reach * 0.53, y - 0.06, z + dz * reach * 0.53);
        dummy.quaternion.setFromUnitVectors(up, direction.set(dx, -0.2, dz).normalize());
        dummy.scale.set(reach * 0.27, reach * 1.5, reach * 0.3);
        dummy.updateMatrix();
        batch.branches.setMatrixAt(batch.count, dummy.matrix);
        dummy.position.set(x + dx * reach * 0.54, y + 0.11 * scale, z + dz * reach * 0.54);
        dummy.rotation.set(0, -angle, 0);
        dummy.scale.set(reach * 0.78, 0.13 * scale + reach * 0.09, reach * 0.32);
        dummy.updateMatrix();
        batch.boughs.setMatrixAt(batch.count, dummy.matrix);
        batch.count += 1;
      }
    }
  });
  const group = new Group();
  for (const batch of batches) {
    batch.branches.count = batch.count;
    batch.boughs.count = batch.count;
    for (const mesh of [batch.trunks, batch.branches, batch.boughs]) {
      mesh.castShadow = batch.near;
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      group.add(mesh);
    }
  }
  return group;
}

const ROCKS: ReadonlyArray<[number, number, number]> = [
  [-5, 7, 1.15],
  [-6.7, 7.8, 0.55],
  [7, -8, 1.25],
  [7.8, -7, 0.45],
  [10, 1, 1.4],
  [-10, -3, 0.85],
  [-3, -10.5, 0.6],
  [3, 10, 0.55],
];

function rocks(materials: SnowMaterials, obstacles: IObstacle[]): Group {
  const group = new Group();
  ROCKS.forEach(([x, z, radius], index) => {
    const geometry = new SphereGeometry(1, 15, 11);
    const position = geometry.getAttribute("position");
    for (let vertex = 0; vertex < position.count; vertex += 1) {
      const px = position.getX(vertex);
      const py = position.getY(vertex);
      const pz = position.getZ(vertex);
      const bump = 1 + 0.085 * Math.sin(px * 13 + py * 8) + 0.065 * Math.sin(pz * 15 + index);
      position.setXYZ(vertex, px * bump, py * bump, pz * bump);
    }
    geometry.computeVertexNormals();
    const y = terrainHeight(x, z) + radius * 0.25;
    const rock = new Mesh(geometry, materials.rock);
    rock.position.set(x, y, z);
    rock.scale.set(radius, radius * 0.7, radius * 0.82);
    rock.rotation.y = index * 1.7;
    const cap = new Mesh(geometry, materials.bough);
    cap.position.set(x, y + radius * 0.39, z);
    cap.scale.set(radius * 0.98, radius * 0.36, radius * 0.84);
    cap.rotation.y = rock.rotation.y;
    for (const mesh of [rock, cap]) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    obstacles.push({ height: radius * 1.1, radius: radius * 0.9, x, z });
  });
  return group;
}

/** Bare stems poking through the powder near the rocks show how deep the snow is. */
function stems(materials: SnowMaterials, random: () => number, depth: number): LineSegments {
  const points: number[] = [];
  for (let index = 0; index < 140; index += 1) {
    const [rx, rz, radius] = ROCKS[index % ROCKS.length] as [number, number, number];
    const angle = random() * Math.PI * 2;
    const distance = radius + random() * 0.9;
    const x = rx + Math.cos(angle) * distance;
    const z = rz + Math.sin(angle) * distance;
    const y = terrainHeight(x, z) + depth - 0.03;
    const height = 0.14 + random() * 0.36;
    points.push(x, y, z, x + (random() - 0.5) * 0.15, y + height, z + (random() - 0.5) * 0.15);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(points, 3));
  return new LineSegments(geometry, materials.stem);
}

/** A continuous ridgeline behind the forest rather than repeated cone mountains. */
function ridge(materials: SnowMaterials): Mesh {
  const geometry = new PlaneGeometry(240, 80, 240, 90);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, 0, -91);
  const position = geometry.getAttribute("position");
  for (let index = 0; index < position.count; index += 1) {
    const x = position.getX(index);
    const z = position.getZ(index);
    const v = (z + 131) / 80;
    const peaks =
      18 + 10 * Math.sin(x * 0.047 + 1) + 7 * Math.sin(x * 0.1 - 1) + 5 * Math.cos(x * 0.19);
    const envelope = Math.sin(Math.max(0, Math.min(1, v)) * Math.PI) ** 1.65;
    const ridges =
      Math.abs(Math.sin(x * 0.31 + z * 0.27)) * 2.2 + Math.sin(x * 0.82 - z * 0.51) * 0.75;
    position.setY(index, -1 + envelope * (peaks + ridges));
  }
  geometry.computeVertexNormals();
  const normal = geometry.getAttribute("normal");
  const colors: number[] = [];
  const snowy = new Color(0xdce6ed);
  const rockFace = new Color(0x536571);
  const colour = new Color();
  for (let index = 0; index < position.count; index += 1) {
    const exposed = smoothstep(0.5, 0.88, 1 - normal.getY(index)) * 0.66;
    const variation = 0.9 + 0.1 * Math.sin(position.getX(index) * 1.7 + position.getZ(index));
    colour.copy(snowy).lerp(rockFace, exposed).multiplyScalar(variation);
    colors.push(colour.r, colour.g, colour.b);
  }
  geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
  return new Mesh(geometry, materials.ridge);
}

/** Builds the scenery and reports the obstacles in it, so collision follows what is drawn. */
export function createScenery(
  materials: SnowMaterials,
  depth: number,
): { readonly root: Group; readonly obstacles: readonly IObstacle[] } {
  const random = seededRandom(224);
  const obstacles: IObstacle[] = [];
  const root = new Group();
  root.add(forest(materials, random, obstacles), rocks(materials, obstacles));
  root.add(stems(materials, random, depth), ridge(materials));
  return { obstacles, root };
}
