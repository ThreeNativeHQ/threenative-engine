// Generated for you. This is ordinary Three.js — edit or delete it freely.
// ThreeNative does not read this file.
//
// Every model in the game is built here from boxes, cylinders, cones and icosahedra: no file to
// download, no licence to carry, and a tower is one function you can read top to bottom. The rules
// of the look are three: a body in the neutral greens, one accent in the thing's own colour, and a
// silhouette that says what it does — a twin barrel is a Sentry, a tilted tube is a Mortar, a
// stack of rings is an Arc coil, two canisters are a Cryo.
import {
  BoxGeometry,
  BufferGeometry,
  ConeGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  PlaneGeometry,
  PointLight,
  Quaternion,
  RingGeometry,
  TorusGeometry,
  Vector3,
} from "three";
import type { EnemyKind, TowerKind } from "../balance.js";
import {
  accentMaterial,
  blackMaterial,
  bodyMaterial,
  darkMaterial,
  enemyMaterial,
  glowMaterial,
  metalMaterial,
  padMarkMaterial,
  padMaterial,
  pineDarkMaterial,
  pineMaterial,
  reactorMaterial,
  roadEdgeMaterial,
  roadInlayMaterial,
  roadMaterial,
  rockMaterial,
  shrubMaterial,
  slabBaseMaterial,
  slabMidMaterial,
  slabTopMaterial,
  tableMaterial,
  trunkMaterial,
} from "./materials.js";
import { palette } from "./palette.js";

type Material = Mesh["material"];

function part(
  geometry: BufferGeometry,
  material: Material,
  position: readonly [number, number, number],
  options: { cast?: boolean; receive?: boolean } = {},
): Mesh {
  const mesh = new Mesh(geometry, material);
  mesh.position.set(position[0], position[1], position[2]);
  mesh.castShadow = options.cast ?? true;
  mesh.receiveShadow = options.receive ?? true;
  return mesh;
}

/** The playable slab: three layers of moss and earth, standing on a dark table that meets the fog. */
export function terrain(width = 38, depth = 25): Group {
  const group = new Group();
  group.name = "terrain";
  group.add(
    part(new BoxGeometry(width, 0.3, depth), slabTopMaterial, [0, -0.15, 0], { cast: false }),
    part(new BoxGeometry(width + 0.6, 0.45, depth + 0.6), slabMidMaterial, [0, -0.525, 0], {
      cast: false,
    }),
    part(new BoxGeometry(width + 1.2, 0.7, depth + 1.2), slabBaseMaterial, [0, -1.1, 0], {
      cast: false,
    }),
  );
  const table = part(
    new PlaneGeometry(600, 600).rotateX(-Math.PI / 2),
    tableMaterial,
    [0, -1.73, 0],
    { cast: false },
  );
  table.name = "table";
  group.add(table);
  return group;
}

/**
 * A flat ribbon following `points`, offset sideways by `offset` and `width` wide. One ribbon is
 * the road, one is the border under it, two thin ones are the inlay lines: all read from the same
 * curve the enemies walk, so the road can never disagree with the path.
 */
export function ribbon(
  points: readonly Vector3[],
  width: number,
  y: number,
  material: Material,
  offset = 0,
): Mesh {
  const positions: number[] = [];
  const indices: number[] = [];
  const tangent = new Vector3();
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const next = points[Math.min(index + 1, points.length - 1)];
    const previous = points[Math.max(index - 1, 0)];
    if (point === undefined || next === undefined || previous === undefined) continue;
    tangent.subVectors(next, previous).setY(0).normalize();
    const nx = -tangent.z;
    const nz = tangent.x;
    const centre = offset;
    positions.push(
      point.x + nx * (centre - width / 2),
      y,
      point.z + nz * (centre - width / 2),
      point.x + nx * (centre + width / 2),
      y,
      point.z + nz * (centre + width / 2),
    );
    if (index > 0) {
      const a = (index - 1) * 2;
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const mesh = new Mesh(geometry, material);
  mesh.receiveShadow = true;
  return mesh;
}

/** The whole road, drawn from the curve the enemies walk. */
export function road(points: readonly Vector3[]): Group {
  const group = new Group();
  group.name = "road";
  group.add(
    ribbon(points, 2.65, 0.02, roadEdgeMaterial),
    ribbon(points, 2.14, 0.04, roadMaterial),
    ribbon(points, 0.07, 0.055, roadInlayMaterial, -0.86),
    ribbon(points, 0.07, 0.055, roadInlayMaterial, 0.86),
  );
  return group;
}

/**
 * Every build pad at once: octagonal plates with a warm "+", as three instanced draws instead of
 * forty-eight. A pad is an invitation to build, so it stays visible from across the board.
 */
export function pads(places: readonly (readonly [number, number])[]): Group {
  const group = new Group();
  group.name = "pads";
  const plate = new InstancedMesh(
    new CylinderGeometry(0.95, 1.05, 0.14, 8).rotateY(Math.PI / 8).translate(0, 0.07, 0),
    padMaterial,
    places.length,
  );
  const bar = new InstancedMesh(
    new BoxGeometry(0.62, 0.05, 0.13).translate(0, 0.16, 0),
    padMarkMaterial,
    places.length,
  );
  const cross = new InstancedMesh(
    new BoxGeometry(0.13, 0.05, 0.62).translate(0, 0.16, 0),
    padMarkMaterial,
    places.length,
  );
  const matrix = new Matrix4();
  for (const [index, [x, z]] of places.entries()) {
    matrix.makeTranslation(x, 0, z);
    plate.setMatrixAt(index, matrix);
    bar.setMatrixAt(index, matrix);
    cross.setMatrixAt(index, matrix);
  }
  plate.castShadow = plate.receiveShadow = true;
  bar.receiveShadow = cross.receiveShadow = true;
  group.add(plate, bar, cross);
  return group;
}

export interface ITowerModel {
  readonly group: Group;
  /** Turns to face a target; its local +z is the way it shoots. */
  readonly head: Group;
  /** Where a shot leaves, in the head's own space. */
  readonly muzzle: Vector3;
}

/** One tower of `kind` at `level`: MK.II adds a collar and side plates, MK.III a second collar. */
export function tower(kind: TowerKind, level: number): ITowerModel {
  const accent = accentMaterial(kind);
  const group = new Group();
  group.add(
    part(new CylinderGeometry(0.88, 1.0, 0.22, 8), darkMaterial, [0, 0.11, 0]),
    part(new CylinderGeometry(0.5, 0.62, 0.7, 8), bodyMaterial, [0, 0.57, 0]),
  );
  for (const [x, z] of [
    [-0.72, -0.72],
    [0.72, -0.72],
    [-0.72, 0.72],
    [0.72, 0.72],
  ] as const)
    group.add(part(new BoxGeometry(0.2, 0.3, 0.2), metalMaterial, [x, 0.3, z]));
  if (level >= 2) {
    const collar = part(new TorusGeometry(0.55, 0.06, 6, 14), accent, [0, 0.86, 0]);
    collar.rotation.x = Math.PI / 2;
    group.add(
      collar,
      part(new BoxGeometry(0.14, 0.4, 0.5), metalMaterial, [-0.62, 0.55, 0]),
      part(new BoxGeometry(0.14, 0.4, 0.5), metalMaterial, [0.62, 0.55, 0]),
    );
  }
  if (level >= 3) {
    const crown = part(new TorusGeometry(0.42, 0.05, 6, 14), accent, [0, 0.96, 0]);
    crown.rotation.x = Math.PI / 2;
    group.add(crown);
  }
  for (let pip = 0; pip < level; pip += 1)
    group.add(
      part(
        new BoxGeometry(0.13, 0.13, 0.13),
        padMarkMaterial,
        [(pip - (level - 1) / 2) * 0.24, 0.2, 0.98],
        {
          cast: false,
        },
      ),
    );

  const head = new Group();
  head.position.y = 1.05;
  const muzzle = new Vector3(0, 0.2, 0.7);
  if (kind === "sentry") {
    head.add(
      part(new BoxGeometry(0.62, 0.32, 0.72), accent, [0, 0.16, 0]),
      part(new BoxGeometry(0.11, 0.11, 0.78), metalMaterial, [-0.15, 0.2, 0.62]),
      part(new BoxGeometry(0.11, 0.11, 0.78), metalMaterial, [0.15, 0.2, 0.62]),
    );
    muzzle.set(0, 0.2, 1.05);
  } else if (kind === "mortar") {
    const barrel = part(new CylinderGeometry(0.2, 0.26, 0.95, 8), metalMaterial, [0, 0.35, 0.28]);
    barrel.rotation.x = Math.PI / 2 - 0.95;
    const lip = part(new CylinderGeometry(0.27, 0.27, 0.14, 8), accent, [0, 0.66, 0.6]);
    lip.rotation.x = Math.PI / 2 - 0.95;
    head.add(
      part(new BoxGeometry(0.14, 0.5, 0.62), accent, [-0.3, 0.22, 0]),
      part(new BoxGeometry(0.14, 0.5, 0.62), accent, [0.3, 0.22, 0]),
      barrel,
      lip,
    );
    muzzle.set(0, 0.7, 0.66);
  } else if (kind === "arc") {
    for (const [radius, y] of [
      [0.36, 0.12],
      [0.3, 0.32],
      [0.24, 0.5],
    ] as const) {
      const ring = part(new TorusGeometry(radius, 0.055, 6, 14), accent, [0, y, 0]);
      ring.rotation.x = Math.PI / 2;
      head.add(ring);
    }
    const orb = part(
      new IcosahedronGeometry(0.2, 0),
      glowMaterial(palette.towers.arc),
      [0, 0.78, 0],
      {
        cast: false,
      },
    );
    orb.name = "orb";
    head.add(part(new CylinderGeometry(0.1, 0.1, 0.7, 6), metalMaterial, [0, 0.35, 0]), orb);
    muzzle.set(0, 0.78, 0);
  } else {
    head.add(
      part(new CylinderGeometry(0.19, 0.19, 0.72, 8), accent, [-0.22, 0.34, 0]),
      part(new CylinderGeometry(0.19, 0.19, 0.72, 8), accent, [0.22, 0.34, 0]),
      part(new BoxGeometry(0.62, 0.12, 0.34), metalMaterial, [0, 0.72, 0]),
    );
    const nozzle = part(new ConeGeometry(0.16, 0.42, 8), metalMaterial, [0, 0.42, 0.42]);
    nozzle.rotation.x = Math.PI / 2;
    head.add(nozzle);
    muzzle.set(0, 0.42, 0.66);
  }
  group.add(head);
  return { group, head, muzzle };
}

export interface IEnemyModel {
  readonly group: Group;
  /** The walking parts, swung against each other while it moves. Empty for tracked hulls. */
  readonly legs: readonly Mesh[];
}

/** An enemy of `kind`, one metre-ish tall before the game scales it by its definition. */
export function enemy(kind: EnemyKind): IEnemyModel {
  const shell = enemyMaterial(kind);
  const group = new Group();
  const legs: Mesh[] = [];
  if (kind === "skitter" || kind === "runner") {
    group.add(
      part(new IcosahedronGeometry(0.4, 0), shell, [0, 0.55, 0]),
      part(new BoxGeometry(0.62, 0.16, 0.72), darkMaterial, [0, 0.8, 0]),
      part(new IcosahedronGeometry(0.09, 0), glowMaterial(palette.enemies[kind]), [0, 0.6, 0.42], {
        cast: false,
      }),
    );
    for (const [x, z] of [
      [-0.3, -0.24],
      [0.3, -0.24],
      [-0.3, 0.24],
      [0.3, 0.24],
    ] as const) {
      const leg = part(new BoxGeometry(0.1, 0.5, 0.1), blackMaterial, [x, 0.25, z]);
      legs.push(leg);
      group.add(leg);
    }
  } else {
    group.add(
      part(new BoxGeometry(1.0, 0.42, 1.4), shell, [0, 0.4, 0]),
      part(new BoxGeometry(0.26, 0.36, 1.5), blackMaterial, [-0.62, 0.3, 0]),
      part(new BoxGeometry(0.26, 0.36, 1.5), blackMaterial, [0.62, 0.3, 0]),
      part(new CylinderGeometry(0.4, 0.46, 0.3, 8), darkMaterial, [0, 0.76, -0.05]),
      part(new BoxGeometry(0.16, 0.16, 0.8), metalMaterial, [0, 0.8, 0.55]),
    );
    if (kind === "titan") {
      group.add(
        part(new BoxGeometry(0.14, 0.14, 0.7), metalMaterial, [-0.3, 0.86, 0.5]),
        part(new BoxGeometry(0.14, 0.14, 0.7), metalMaterial, [0.3, 0.86, 0.5]),
        part(
          new IcosahedronGeometry(0.28, 0),
          glowMaterial(palette.enemies.titan),
          [0, 1.1, -0.1],
          {
            cast: false,
          },
        ),
      );
    }
  }
  return { group, legs };
}

/** The thing being defended: a stepped plinth, four arms with cold tips, and a spinning core. */
export function reactor(): Group {
  const group = new Group();
  group.name = "reactor";
  group.add(
    part(new CylinderGeometry(1.7, 1.9, 0.3, 10), darkMaterial, [0, 0.15, 0]),
    part(new CylinderGeometry(1.35, 1.5, 0.28, 10), metalMaterial, [0, 0.44, 0]),
    part(new CylinderGeometry(0.5, 0.7, 0.9, 8), bodyMaterial, [0, 1.0, 0]),
  );
  for (let arm = 0; arm < 4; arm += 1) {
    const angle = (arm / 4) * Math.PI * 2 + Math.PI / 4;
    const x = Math.cos(angle) * 1.05;
    const z = Math.sin(angle) * 1.05;
    const pylon = part(new BoxGeometry(0.2, 1.3, 0.2), darkMaterial, [x, 0.9, z]);
    pylon.rotation.y = -angle;
    group.add(
      pylon,
      part(
        new IcosahedronGeometry(0.15, 0),
        glowMaterial(palette.model.reactorGlow),
        [x, 1.62, z],
        {
          cast: false,
        },
      ),
    );
  }
  const core = part(new IcosahedronGeometry(0.55, 1), reactorMaterial, [0, 1.95, 0], {
    cast: false,
  });
  core.name = "core";
  const ring = part(
    new TorusGeometry(0.85, 0.05, 6, 24),
    glowMaterial(palette.model.reactorGlow, 0.9),
    [0, 1.95, 0],
    {
      cast: false,
    },
  );
  ring.name = "ring";
  ring.rotation.x = Math.PI / 2.4;
  const light = new PointLight(palette.model.reactor, 8, 14, 1.6);
  light.position.set(0, 2.1, 0);
  group.add(core, ring, light);
  return group;
}

/** Seeded, so the same forest grows on every machine. Same generator Bastion used. */
export function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function scatter(
  geometry: BufferGeometry,
  material: Material,
  placements: readonly { x: number; y: number; z: number; scale: number; turn: number }[],
): InstancedMesh {
  const mesh = new InstancedMesh(geometry, material, placements.length);
  const matrix = new Matrix4();
  const rotation = new Quaternion();
  const up = new Vector3(0, 1, 0);
  for (const [index, place] of placements.entries()) {
    rotation.setFromAxisAngle(up, place.turn);
    matrix.compose(
      new Vector3(place.x, place.y, place.z),
      rotation,
      new Vector3(place.scale, place.scale, place.scale),
    );
    mesh.setMatrixAt(index, matrix);
  }
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * Pines, rocks and shrubs on the slab, kept off the road and the pads. Three instanced draws for
 * a hundred and thirty trees: decoration must cost the frame nothing.
 */
export function decor(
  keepClear: readonly (readonly [number, number, number])[],
  seed = 47021,
  count = 130,
): Group {
  const random = lcg(seed);
  const group = new Group();
  group.name = "decor";
  const trees: { x: number; y: number; z: number; scale: number; turn: number }[] = [];
  const rocks: typeof trees = [];
  const shrubs: typeof trees = [];
  let attempts = 0;
  while (trees.length + rocks.length + shrubs.length < count && attempts < count * 40) {
    attempts += 1;
    const x = (random() * 2 - 1) * 18.4;
    const z = (random() * 2 - 1) * 12.1;
    const kind = random();
    const scale = 0.55 + random() * 0.55;
    // A ring of forest around the arena, and only the odd tree inside it: the board is for playing.
    const edge = Math.max(Math.abs(x) / 18.4, Math.abs(z) / 12.1);
    if (edge < 0.78 && random() > 0.06) continue;
    const clear = keepClear.every(([cx, cz, radius]) => Math.hypot(x - cx, z - cz) > radius);
    if (!clear) continue;
    const place = { scale, turn: random() * Math.PI * 2, x, y: 0, z };
    if (kind < 0.72) trees.push(place);
    else if (kind < 0.88) rocks.push({ ...place, scale: scale * 0.7 });
    else shrubs.push({ ...place, scale: scale * 0.8 });
  }
  const pines = scatter(new ConeGeometry(0.72, 1.7, 7).translate(0, 1.25, 0), pineMaterial, trees);
  const crowns = scatter(
    new ConeGeometry(0.5, 1.2, 7).translate(0, 2.05, 0),
    pineDarkMaterial,
    trees,
  );
  const trunks = scatter(
    new CylinderGeometry(0.1, 0.14, 0.5, 6).translate(0, 0.25, 0),
    trunkMaterial,
    trees,
  );
  group.add(
    pines,
    crowns,
    trunks,
    scatter(new IcosahedronGeometry(0.5, 0).translate(0, 0.2, 0), rockMaterial, rocks),
    scatter(new IcosahedronGeometry(0.34, 0).translate(0, 0.16, 0), shrubMaterial, shrubs),
  );
  return group;
}

/** The outline of a range circle: thin, whatever the radius. */
export function rangeGeometry(radius: number): RingGeometry {
  return new RingGeometry(Math.max(0.01, radius - 0.07), Math.max(0.02, radius), 72).rotateX(
    -Math.PI / 2,
  );
}

/** A flat ring on the ground: a tower's range while it is hovered or selected. */
export function rangeRing(radius: number): Mesh {
  const ring = new Mesh(rangeGeometry(radius), glowMaterial(palette.accent, 0.55));
  ring.position.y = 0.09;
  ring.renderOrder = 2;
  return ring;
}

/** A see-through tower for the placement preview. */
export function ghostTower(kind: TowerKind): Group {
  const { group } = tower(kind, 1);
  const material = new MeshBasicMaterial({
    color: palette.towers[kind],
    depthWrite: false,
    opacity: 0.4,
    toneMapped: false,
    transparent: true,
  });
  group.traverse((object: Object3D) => {
    if (object instanceof Mesh) {
      object.material = material;
      object.castShadow = false;
      object.receiveShadow = false;
    }
  });
  return group;
}

export interface IHealthBar {
  readonly group: Group;
  readonly fill: Mesh;
  readonly fillMaterial: MeshBasicMaterial;
}

/** A health bar that faces the camera: an empty track and a fill scaled from its left edge. */
export function healthBar(width: number): IHealthBar {
  const group = new Group();
  const track = new Mesh(
    new PlaneGeometry(width + 0.08, 0.2),
    new MeshBasicMaterial({
      color: palette.effects.barEmpty,
      depthWrite: false,
      opacity: 0.8,
      transparent: true,
    }),
  );
  const fillMaterial = new MeshBasicMaterial({
    color: palette.effects.barFull,
    depthWrite: false,
    toneMapped: false,
  });
  const fill = new Mesh(new PlaneGeometry(width, 0.13).translate(width / 2, 0, 0), fillMaterial);
  fill.position.set(-width / 2, 0, 0.005);
  track.renderOrder = 3;
  fill.renderOrder = 4;
  group.add(track, fill);
  return { fill, fillMaterial, group };
}
