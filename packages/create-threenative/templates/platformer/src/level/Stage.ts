import {
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  DodecahedronGeometry,
  Group,
  Mesh,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from "three";
import { crate, goalFlag, questionBlock } from "../render/blocks.js";
import { rockBox, toon } from "../render/materials.js";
import { C } from "../render/palette.js";
import { bush, fence, flower, pineTree, roundTree, swayFlag, vines } from "../render/props.js";
import { airship, castle, cliff, windmill } from "../render/scenery.js";
import { waterfall } from "../render/waterfall.js";

/** Deterministic, so the route is the same course every run. */
export function makeRng(seed = 90210): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export interface IStage {
  /** The one root to add to the scene and hand to `buildStaticColliders`. */
  readonly group: Group;
  /** Where a fall puts the fox back: one point per walkable stretch, in route order. */
  readonly checkpoints: Vector3[];
  readonly goalX: number;
  readonly spawn: Vector3;
  update(dt: number, time: number): void;
}

/**
 * The route, in three acts: a mesa and a rope bridge, rising islands, then the high meadow and
 * the goal. Ninety-seven metres end to end, and every metre of it is authored here.
 *
 * Walkable geometry is tagged `userData.solid` and nothing else is, so the engine's
 * `buildStaticColliders` gets exactly the surfaces the fox can stand on out of a root that also
 * holds several thousand decorative meshes. Everything else — foliage, trees, the castle, the
 * airship — is silhouette that costs no collision query.
 *
 * Two more tags, read by the scene's merge: `userData.moving` on a subtree that animates, and
 * `userData.faceted` on a uv-less polyhedron. Both are the reason a mesh stays its own draw
 * instead of joining a material bucket.
 */
/** Where the fox starts the route, at its waist. */
export const STAGE_SPAWN: Readonly<Vector3> = new Vector3(-5, 1.2, 0);

export function buildStage(rng: () => number): IStage {
  const group = new Group();
  const checkpoints: Vector3[] = [];
  const updaters: ((dt: number, time: number) => void)[] = [];
  const goalX = 92;
  const spawn = STAGE_SPAWN.clone();

  const solid = (mesh: Mesh): Mesh => {
    mesh.userData.solid = true;
    mesh.receiveShadow = true;
    return mesh;
  };
  const attach = (child: Mesh | Group): void => {
    group.add(child);
  };

  /** A rock block with a grass cap. `top` is the walkable surface height. */
  const ground = (options: {
    x0: number;
    x1: number;
    top: number;
    z0?: number;
    z1?: number;
    depth?: number;
  }): void => {
    const { x0, x1, top } = options;
    const z0 = options.z0 ?? -7;
    const z1 = options.z1 ?? 6;
    const depth = options.depth ?? 16;
    const width = x1 - x0;
    const depthZ = z1 - z0;
    const cx = (x0 + x1) / 2;
    const cz = (z0 + z1) / 2;
    const chunk = new Group();

    const cap = solid(
      new Mesh(
        rockBox(width + 0.25, 0.6, depthZ + 0.25, rng, 0.12),
        toon(C.grass, { vertexColors: true }),
      ),
    );
    cap.position.set(cx, top - 0.3, cz);
    cap.castShadow = true;
    chunk.add(cap);
    // The dirt band right under the turf is what makes a cliff edge read as a cliff.
    const dirt = new Mesh(new BoxGeometry(width + 0.12, 0.5, depthZ + 0.12), toon(C.dirt));
    dirt.position.set(cx, top - 0.82, cz);
    chunk.add(dirt);
    grassSkirt(chunk, x0, x1, z0, z1, top - 0.6, rng);
    scatterFoliage(chunk, x0, x1, z0, z1, top, rng);

    // The rock body is NOT solid. Only the walkable cap is, and that is a deliberate correction:
    // a collider for the whole 16 m block turns every gap in the route into a 16 m wall the fox
    // slides down and gets caught on the lip of — it walked up the face of the far side instead of
    // falling into the chasm at x=30. The cap is the surface; the rock below it is scenery.
    const body = new Mesh(
      rockBox(width, depth, depthZ, rng, 0.22),
      toon(C.rock, { flat: true, vertexColors: true }),
    );
    body.position.set(cx, top - 0.6 - depth / 2, cz);
    body.castShadow = true;
    chunk.add(body);
    // Strata bands and boulders break up the big rock face.
    for (let i = 0; i < 3; i += 1) {
      const y = top - 2 - i * 2.1;
      if (y < top - 0.6 - depth) break;
      const band = new Mesh(
        rockBox(width * 0.99, 0.5 + rng() * 0.3, depthZ + 0.1, rng, 0.16),
        toon(i % 2 ? C.rockDark : C.rockLight, { flat: true, vertexColors: true }),
      );
      band.position.set(cx, y, cz);
      chunk.add(band);
    }
    for (let i = 0; i < Math.max(3, Math.floor(width / 3)); i += 1) {
      const boulder = new Mesh(
        new DodecahedronGeometry(0.5 + rng() * 0.9),
        toon(rng() < 0.5 ? C.rockDark : C.rockLight, { flat: true }),
      );
      // A polyhedron carries no uv, and a bucket whose pieces disagree about their attributes is
      // a bucket the merge refuses. Faceted stones stay out of it; they are 6 per block.
      boulder.userData.faceted = true;
      boulder.position.set(
        x0 + rng() * width,
        top - 1.4 - rng() * (depth - 2),
        z1 - 0.2 + rng() * 0.6,
      );
      boulder.rotation.set(rng() * 3, rng() * 3, rng() * 3);
      boulder.castShadow = true;
      chunk.add(boulder);
    }
    for (let i = 0; i < Math.max(2, Math.floor(width / 5)); i += 1) {
      const moss = new Mesh(new SphereGeometry(0.55 + rng() * 0.5, 8, 6), toon(C.moss));
      moss.scale.set(1.4, 0.5, 0.6);
      moss.position.set(x0 + 1 + rng() * (width - 2), top - 1.15 - rng() * 1.2, z1 + 0.05);
      chunk.add(moss);
    }
    attach(chunk);
    checkpoints.push(new Vector3(x0 + 1.5, top + 1.2, 0));
  };

  /** A floating island: grass disc on a rock spike. The disc is the whole landing. */
  const island = (
    x: number,
    y: number,
    z: number,
    radius: number,
    depth: number,
    tree: boolean,
  ): void => {
    const chunk = new Group();
    const cap = solid(
      new Mesh(new CylinderGeometry(radius, radius * 0.97, 0.5, 12), toon(C.grass)),
    );
    cap.position.y = -0.25;
    cap.castShadow = true;
    chunk.add(cap);
    const rim = new Mesh(new TorusGeometry(radius * 0.99, 0.24, 6, 14), toon(C.grass));
    rim.rotation.x = Math.PI / 2;
    rim.position.y = -0.42;
    chunk.add(rim);
    const spike = new Mesh(
      new ConeGeometry(radius * 0.95, depth, 10),
      toon(C.rock, { flat: true }),
    );
    // ConeGeometry points up; flip it so the spike hangs point-down under the disc.
    spike.rotation.x = Math.PI;
    spike.position.y = -0.5 - depth / 2;
    chunk.add(spike);
    const underSpike = new Mesh(
      new ConeGeometry(radius * 0.6, depth * 0.7, 8),
      toon(C.rockDark, { flat: true }),
    );
    underSpike.position.set(radius * 0.25, -0.5 - depth * 0.6, -radius * 0.2);
    underSpike.rotation.set(Math.PI, 0, 0.25);
    chunk.add(underSpike);
    const tendrils = vines(3, rng);
    tendrils.position.set(radius * 0.4, -0.6, radius * 0.5);
    chunk.add(tendrils);
    if (tree) {
      const trunk = rng() < 0.5 ? pineTree(0.9 + rng() * 0.4, rng) : roundTree(0.8, rng);
      trunk.position.set((rng() - 0.5) * radius * 0.6, 0, -radius * 0.3);
      chunk.add(trunk);
    }
    for (let i = 0; i < 3; i += 1) {
      const bloom = flower([0xff8fb0, 0xffe066, 0xffffff][i] ?? 0xffffff);
      bloom.position.set((rng() - 0.5) * radius * 1.2, 0, (rng() - 0.5) * radius * 1.2);
      chunk.add(bloom);
    }
    chunk.position.set(x, y, z);
    attach(chunk);
    checkpoints.push(new Vector3(x, y + 1.2, z));
  };

  /** Plank bridge with rope rails. One solid deck under the planks is the whole collider. */
  const bridge = (x0: number, x1: number, top: number, width: number): void => {
    const chunk = new Group();
    const span = x1 - x0;
    // The planks are the walkable surface, so they are what collides: a separate invisible deck box
    // would put the fox's feet a quarter of a metre inside the boards it is standing on.
    const planks = Math.round(span / 1.1);
    for (let i = 0; i < planks; i += 1) {
      const plank = solid(
        new Mesh(
          new BoxGeometry((span / planks) * 0.94, 0.26, width),
          toon(i % 3 === 0 ? C.woodDark : C.wood),
        ),
      );
      plank.position.set(x0 + (i + 0.5) * (span / planks), top - 0.13, 0);
      plank.rotation.x = (rng() - 0.5) * 0.02;
      plank.castShadow = true;
      chunk.add(plank);
    }
    for (const side of [-1, 1]) {
      const beam = new Mesh(new BoxGeometry(span, 0.3, 0.35), toon(C.woodDark));
      beam.position.set((x0 + x1) / 2, top - 0.6, side * (width / 2 - 0.35));
      chunk.add(beam);
    }
    const posts = Math.max(3, Math.round(span / 4.5));
    for (let i = 0; i <= posts; i += 1) {
      const px = x0 + (span * i) / posts;
      for (const side of [-1, 1]) {
        const post = new Mesh(new CylinderGeometry(0.16, 0.19, 1.9, 8), toon(C.woodPost));
        post.position.set(px, top + 0.55, side * (width / 2 - 0.15));
        const capTop = new Mesh(new CylinderGeometry(0.2, 0.2, 0.14, 8), toon(C.woodDark));
        capTop.position.set(px, top + 1.55, side * (width / 2 - 0.15));
        chunk.add(post, capTop);
        if (i >= posts) continue;
        const segment = span / posts;
        for (const [height, radius] of [
          [1.15, 0.05],
          [0.65, 0.045],
        ] as const) {
          const rope = new Mesh(new CylinderGeometry(radius, radius, segment, 6), toon(C.rope));
          rope.rotation.z = Math.PI / 2;
          rope.position.set(px + segment / 2, top + height - 0.08, side * (width / 2 - 0.15));
          chunk.add(rope);
        }
      }
    }
    attach(chunk);
    checkpoints.push(new Vector3(x0 + 1, top + 1.2, 0));
  };

  // --- act 1: the mesa, the rope bridge, the meadow ------------------------
  ground({ x0: -20, x1: -7, top: 0 });
  bridge(-7, 10, 0, 5.4);
  ground({ x0: 10, x1: 30, top: 0 });
  // --- act 2: the rising islands ------------------------------------------
  ground({ x0: 34, x1: 41, top: 1.5, z0: -5, z1: 5, depth: 14 });
  island(45.5, 3.2, 1.2, 2.4, 3.5, true);
  island(50.5, 4.8, -1.4, 2.1, 3.5, false);
  island(55, 6.2, 1, 2.6, 3.5, true);
  // --- act 3: the high meadow, the second bridge, the goal ----------------
  ground({ x0: 59, x1: 74, top: 3, depth: 18 });
  bridge(74, 82, 3, 5);
  ground({ x0: 82, x1: 97, top: 3, depth: 20 });

  for (const [x, z, scale] of [
    [13, -5.4, 1.1],
    [17.5, -5.8, 0.9],
    [27, -5.2, 1.2],
    [62, -5.6, 1.1],
    [70, -5.4, 1.3],
    [86, -5.6, 1.2],
    [93, -5, 1],
  ] as const) {
    const tree = rng() < 0.5 ? pineTree(scale * 1.3, rng) : roundTree(scale * 1.2, rng);
    tree.position.set(x, x < 32 ? 0 : 3, z);
    attach(tree);
  }
  for (const [x, top, length] of [
    [19, 0, 7],
    [63, 3, 8],
  ] as const) {
    const rail = fence(length, 5);
    rail.position.set(x, top, -6.2);
    attach(rail);
  }
  for (const [x, y, z, size] of [
    [27.6, 0, 3.2, 1.1],
    [28.8, 0, 3.2, 1.1],
    [27.6, 1.1, 3.2, 1.1],
    [88, 3, 3.4, 1.2],
  ] as const) {
    const box = crate(size);
    box.box.userData.solid = true;
    box.group.position.set(x, y + size / 2, z);
    attach(box.group);
  }
  // The '?' block floats 3.6 m up and bobs; a static collider cannot follow a bob, so it is
  // decoration and the star above it is the reward.
  const block = questionBlock(1.2);
  block.group.userData.moving = true;
  block.group.position.set(24, 3.6, 2.6);
  attach(block.group);
  updaters.push((_dt, time) => {
    block.group.position.y = 3.6 + Math.sin(time * 2) * 0.08;
  });
  const flag = goalFlag();
  flag.group.userData.moving = true;
  flag.group.position.set(goalX, 3, 0);
  attach(flag.group);
  updaters.push((_dt, time) => swayFlag(flag.cloth, time));

  // --- the world behind the route ----------------------------------------
  const tops: number[] = [];
  const backdrop = [
    [4, -16, -46, 26, 24, 14],
    [40, -14, -54, 30, 28, 16],
    [78, -16, -48, 26, 26, 14],
    [-30, -18, -42, 20, 22, 12],
    [108, -18, -56, 28, 28, 16],
    [22, -22, -72, 34, 30, 18],
    [92, -24, -80, 30, 32, 18],
  ] as const;
  for (const [i, cliffRow] of backdrop.entries()) {
    const [x, y, z, w, h, d] = cliffRow;
    const face = cliff(w, h, d, rng);
    face.position.set(x, y, z);
    attach(face);
    // `cliff` is centred on its origin and carries its grass cap 0.7 m above the box. Everything
    // that stands on it, hangs from it or is measured against it goes from this height; anchoring
    // to `y + h` left the trees, falls, castle and windmill 12 m above the rock they belong to.
    const top = y + h / 2 + 0.7;
    tops.push(top);
    // Half the cliffs carry water. These are 50 m behind the route: at that distance a fifth one
    // is a smear, and each is two dozen transparent draws that the near cliffs hide anyway.
    if (i % 2 === 0) {
      const fall = waterfall(3 + rng() * 3, h * 0.85);
      fall.group.userData.moving = true;
      fall.group.position.set(x + (rng() - 0.5) * w * 0.5, top - 0.5, z + d / 2 + 0.2);
      attach(fall.group);
      updaters.push((dt) => fall.update(dt));
    }
    for (let i = 0; i < 4; i += 1) {
      const tree = rng() < 0.6 ? pineTree(1.6 + rng() * 1.2, rng) : roundTree(1.5 + rng(), rng);
      tree.position.set(x + (rng() - 0.5) * w * 0.85, top, z + (rng() - 0.5) * d * 0.5);
      attach(tree);
    }
  }
  for (let i = 0; i < 10; i += 1) {
    const distant = new Group();
    const radius = 2 + rng() * 5;
    distant.add(new Mesh(new CylinderGeometry(radius, radius * 0.95, 1.2, 8), toon(C.grass)));
    const spike = new Mesh(
      new ConeGeometry(radius * 0.9, radius * 2.2, 8),
      toon(C.rock, { flat: true }),
    );
    spike.rotation.x = Math.PI;
    spike.position.y = -0.6 - radius * 1.1;
    distant.add(spike);
    for (let t = 0; t < 3; t += 1) {
      const tree =
        rng() < 0.5 ? pineTree(0.8 + rng() * 0.8, rng) : roundTree(0.7 + rng() * 0.6, rng);
      tree.position.set((rng() - 0.5) * radius, 0.6, (rng() - 0.5) * radius);
      distant.add(tree);
    }
    distant.position.set(-40 + rng() * 190, 4 + rng() * 28, -45 - rng() * 90);
    attach(distant);
  }
  const keep = castle(rng);
  keep.position.set(22, tops[5] ?? 0, -72);
  keep.scale.setScalar(1.7);
  attach(keep);
  const mill = windmill();
  mill.group.userData.moving = true;
  mill.group.position.set(74, tops[2] ?? 0, -48);
  mill.group.scale.setScalar(1.9);
  attach(mill.group);
  updaters.push((dt) => mill.spin(dt));
  const ship = airship();
  ship.userData.moving = true;
  ship.position.set(-10, 34, -52);
  ship.scale.setScalar(2.2);
  attach(ship);
  updaters.push((dt, time) => {
    ship.position.x += dt * 1.4;
    ship.position.y += Math.sin(time * 0.4) * dt * 1.5;
    if (ship.position.x > 190) ship.position.x = -60;
  });

  checkpoints.sort((a, b) => a.x - b.x);
  return {
    checkpoints,
    goalX,
    group,
    spawn,
    update(dt: number, time: number): void {
      for (const step of updaters) step(dt, time);
    },
  };
}

/** Scalloped grass tufts along the top edge of a block. */
function grassSkirt(
  parent: Group,
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  y: number,
  rng: () => number,
): void {
  const material = toon(C.grass);
  for (const [fromX, fromZ, toX, toZ] of [
    [x0, z1, x1, z1],
    [x0, z0, x1, z0],
    [x0, z0, x0, z1],
    [x1, z0, x1, z1],
  ] as const) {
    const length = Math.hypot(toX - fromX, toZ - fromZ);
    const count = Math.max(2, Math.round(length / 0.85));
    for (let i = 0; i <= count; i += 1) {
      const t = i / count;
      const tuft = new Mesh(new SphereGeometry(0.42 + rng() * 0.18, 8, 6), material);
      tuft.position.set(
        fromX + (toX - fromX) * t,
        y + 0.12 - rng() * 0.25,
        fromZ + (toZ - fromZ) * t,
      );
      tuft.scale.set(1, 0.75, 1);
      tuft.castShadow = true;
      parent.add(tuft);
    }
  }
}

/** Bushes, flowers and grass blades scattered on top of a block. */
function scatterFoliage(
  parent: Group,
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  top: number,
  rng: () => number,
): void {
  const petals = [0xff8fb0, 0xffe066, 0xffffff, 0xc78fff];
  for (let i = 0; i < Math.floor((x1 - x0) * 0.7); i += 1) {
    const x = x0 + 1 + rng() * (x1 - x0 - 2);
    const back = rng() < 0.75;
    const z = back ? z0 + 0.6 + rng() * (z1 - z0) * 0.35 : z1 - (z1 - z0) * 0.25 - rng() * 0.5;
    const roll = rng();
    let prop: Group;
    if (roll < 0.3) prop = bush(0.6 + rng() * 0.5, rng);
    else if (roll < 0.75) prop = flower(petals[Math.floor(rng() * petals.length)] ?? 0xffffff);
    else {
      prop = new Group();
      for (let blade = 0; blade < 4; blade += 1) {
        const tuft = new Mesh(new ConeGeometry(0.06, 0.4 + rng() * 0.3, 4), toon(C.grassLight));
        tuft.position.set((rng() - 0.5) * 0.35, 0.2, (rng() - 0.5) * 0.35);
        tuft.rotation.z = (rng() - 0.5) * 0.5;
        prop.add(tuft);
      }
    }
    prop.position.set(x, top, z);
    parent.add(prop);
  }
}
