// Generated for you. This is ordinary Three.js — edit or delete it freely.
// ThreeNative does not read this file.
//
// What stands on the battlefield and never moves: a sandstone mesa on every rock the simulation
// paths around, a ring of them along the map edge, rubble, scrub grass, the bridge over the big pool
// and the depots beside each base. Each family is one instanced mesh or one merged mesh, so the
// whole scatter is a handful of draws. Placement reads the simulation's own obstacles, so what you
// see is what a unit walks around.
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DodecahedronGeometry,
  DoubleSide,
  Float32BufferAttribute,
  InstancedMesh,
  type Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
} from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { Game } from "../sim/game.js";
import {
  HALF,
  RESOURCE_SITES,
  STARTS,
  WORLD,
  terrainHeight,
  terrainNoise,
  waterBlocked,
} from "../sim/terrain.js";
import { seeded } from "../sim/types.js";
import { ROAD_PATHS, padAt, sedimentTexture, segmentDistance } from "./ground.js";
import { legacyColor } from "./palette.js";

const standard = (
  color: number | Color,
  extra: ConstructorParameters<typeof MeshStandardMaterial>[0] = {},
) =>
  new MeshStandardMaterial({
    color: typeof color === "number" ? legacyColor(color) : color,
    roughness: 0.87,
    metalness: 0.08,
    ...extra,
  });

/** A ten-sided column with a jagged rim and sandstone bands in its vertex colour. */
function mesaGeometry(): BufferGeometry {
  const geometry = new CylinderGeometry(0.75, 1, 1, 10, 4, false);
  const position = geometry.getAttribute("position");
  const colors = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const angle = Math.atan2(z, x);
    const f = 1 + 0.13 * Math.sin(angle * 5 + 1) + 0.07 * Math.sin(angle * 3 + y * 15);
    position.setX(i, x * f);
    position.setZ(i, z * f);
    const band = 0.66 + (y + 0.5) * 0.25 + (Math.sin(y * 38) > 0.2 ? 0.06 : 0);
    colors.set([band, band * 0.91, band * 0.74], i * 3);
  }
  geometry.setAttribute("color", new BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  return geometry.toNonIndexed();
}

/** Five crossed blades, 0.75 m to 1 m tall: one tuft of scrub. */
function tuftGeometry(): BufferGeometry {
  const blades: number[] = [];
  for (let k = 0; k < 5; k++) {
    const a = k * 2.4;
    const dx = Math.cos(a) * 0.25;
    const dz = Math.sin(a) * 0.25;
    blades.push(-dx, 0, -dz, dx, 0, dz, dx * 0.2, 0.75 + k * 0.07, dz * 0.2);
  }
  const tuft = new BufferGeometry().setAttribute("position", new Float32BufferAttribute(blades, 3));
  tuft.computeVertexNormals();
  return tuft;
}

export interface IEnvironment {
  readonly root: Object3D;
  readonly stats: { readonly mesas: number; readonly rubble: number; readonly grass: number };
}

export function createEnvironment(game: Game): IEnvironment {
  const root = new Object3D();
  const rng = seeded(1241);
  const dummy = new Object3D();

  // Sandstone: two smaller boulders beside every obstacle, and a wall of them along the map edge.
  const mesas: [number, number, number, number][] = [];
  for (const o of game.obstacles) {
    mesas.push([o.x, o.z, o.r * 0.95, o.r * (1.1 + rng() * 0.7)]);
    for (let i = 0; i < 2; i++) {
      const a = rng() * 6.28;
      mesas.push([
        o.x + Math.cos(a) * o.r * 0.6,
        o.z + Math.sin(a) * o.r * 0.6,
        o.r * 0.42,
        o.r * 0.65,
      ]);
    }
  }
  for (let i = 0; i < 112; i++) {
    const side = i % 4;
    const u = -HALF + Math.floor(i / 4) * 8.2;
    const x = side < 2 ? u : side === 2 ? -HALF : HALF;
    const z = side < 2 ? (side === 0 ? -HALF : HALF) : u;
    mesas.push([x, z, 3.7 + rng() * 3, 6 + rng() * 9]);
  }
  const rock = new InstancedMesh(
    mesaGeometry(),
    standard(0xd1cbbb, {
      map: sedimentTexture(),
      vertexColors: true,
      flatShading: true,
      roughness: 0.99,
    }),
    mesas.length,
  );
  mesas.forEach(([x, z, r, h], i) => {
    dummy.position.set(x, terrainHeight(x, z, false) + h * 0.32, z);
    dummy.rotation.set((rng() - 0.5) * 0.14, rng() * 6.28, (rng() - 0.5) * 0.13);
    dummy.scale.set(r, h, r * (0.7 + rng() * 0.3));
    dummy.updateMatrix();
    rock.setMatrixAt(i, dummy.matrix);
  });
  rock.castShadow = true;
  rock.receiveShadow = true;
  root.add(rock);

  // Loose stones on open ground, flattened so they read as scree rather than as balls.
  const stones: [number, number, number][] = [];
  for (let i = 0; i < 1500; i++) {
    const x = rng() * WORLD - HALF;
    const z = rng() * WORLD - HALF;
    if (padAt(x, z) || waterBlocked(x, z) || game.blocked(x, z, 0.5)) continue;
    stones.push([x, z, 0.12 + rng() * 0.38]);
  }
  const rubble = new InstancedMesh(
    new DodecahedronGeometry(1),
    standard(0x918d70, { flatShading: true }),
    stones.length,
  );
  stones.forEach(([x, z, r], i) => {
    dummy.position.set(x, terrainHeight(x, z) + r * 0.2, z);
    dummy.rotation.set(rng(), rng() * 6, rng());
    dummy.scale.set(r, r * 0.5, r * 0.8);
    dummy.updateMatrix();
    rubble.setMatrixAt(i, dummy.matrix);
  });
  rubble.receiveShadow = true;
  root.add(rubble);

  // Scrub grass in patches, off the aprons and the roads. Each tuft carries its own tint.
  const tufts: [number, number, number][] = [];
  for (let i = 0; i < 4300; i++) {
    const x = rng() * WORLD - HALF;
    const z = rng() * WORLD - HALF;
    if (padAt(x, z) || game.blocked(x, z, 0.4)) continue;
    if (
      ROAD_PATHS.some((path) =>
        path.some((b, j) => j > 0 && segmentDistance(x, z, path[j - 1] ?? b, b) < 3.9),
      )
    )
      continue;
    if (terrainNoise(x * 0.08 + 32, z * 0.08 + 4) < 0.43) continue;
    tufts.push([x, z, 0.55 + rng()]);
  }
  // Three tints of olive, one draw each: per-instance colour is not on every engine path.
  const shades = [0.5, 0.55, 0.6].map((lightness) => {
    const tint = new Color().setHSL(0.19, 0.25, lightness).multiply(legacyColor(0x8f9764));
    const mesh = new InstancedMesh(
      tuftGeometry(),
      standard(tint, { side: DoubleSide, roughness: 1 }),
      tufts.length,
    );
    mesh.count = 0;
    mesh.receiveShadow = true;
    return mesh;
  });
  for (const [x, z, s] of tufts) {
    const mesh = shades[Math.floor(rng() * shades.length)] ?? shades[0];
    if (mesh === undefined) continue;
    dummy.position.set(x, terrainHeight(x, z), z);
    dummy.rotation.set(0, rng() * 6.28, 0);
    dummy.scale.set(s, s, s);
    dummy.updateMatrix();
    mesh.setMatrixAt(mesh.count, dummy.matrix);
    mesh.count += 1;
  }
  root.add(...shades);

  root.add(...props());
  return { root, stats: { mesas: mesas.length, rubble: stones.length, grass: tufts.length } };
}

/** The bridge, its rails and lamps, the depots by each base and each expansion: one mesh per material. */
function props(): Mesh[] {
  const dark = standard(0x283b40);
  const steel = standard(0x728384);
  const stripe = standard(0xc8ab62);
  const lamp = new MeshBasicMaterial({ color: legacyColor(0x86efea) });
  const parts = new Map<Material, BufferGeometry[]>();
  const box = (
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
    material: Material,
  ): void => {
    const list = parts.get(material) ?? [];
    list.push(new BoxGeometry(sx, sy, sz).translate(x, y, z));
    parts.set(material, list);
  };
  box(-12, 0.63, -20, 43, 0.5, 6.7, dark);
  box(-12, 0.91, -20, 42.4, 0.12, 6.4, steel);
  for (let x = -32; x < 10; x += 2.2) {
    box(x, 0.992, -20, 0.07, 0.05, 6.2, dark);
    for (const z of [-23.15, -16.85]) {
      box(x, 1.52, z, 0.18, 1.05, 0.18, dark);
      box(x, 2.08, z, 0.24, 0.12, 0.24, lamp);
    }
  }
  for (const z of [-23.18, -16.82]) {
    box(-12, 1.92, z, 43, 0.14, 0.18, steel);
    box(-12, 1.1, z, 43, 0.1, 0.14, stripe);
  }
  const depot = (x: number, z: number): void => {
    const h = terrainHeight(x, z);
    box(x, h + 0.55, z, 1.5, 1.1, 1.3, dark);
    box(x, h + 1.12, z, 1.54, 0.11, 1.34, steel);
    box(x, h + 0.5, z + 0.66, 1, 0.14, 0.03, stripe);
  };
  for (const site of RESOURCE_SITES.slice(3)) depot(site.baseX + 8, site.baseZ + 7);
  for (const start of STARTS) {
    const beacon = new MeshBasicMaterial({ color: legacyColor(start.color) });
    for (const [dx, dz] of [
      [-22, -21],
      [22, -21],
      [-22, 21],
      [22, 21],
    ] as const) {
      const h = terrainHeight(start.x + dx, start.z + dz);
      box(start.x + dx, h + 0.46, start.z + dz, 0.6, 0.9, 0.6, dark);
      box(start.x + dx, h + 0.96, start.z + dz, 0.62, 0.12, 0.62, beacon);
    }
    for (let i = 0; i < 4; i++)
      depot(start.x + 19 + (i % 2) * 1.8, start.z + 15 + Math.floor(i / 2) * 2);
  }
  return [...parts].map(([material, geometries]) => {
    const merged = mergeGeometries(geometries);
    for (const geometry of geometries) geometry.dispose();
    const mesh = new Mesh(merged, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  });
}
