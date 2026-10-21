// Generated for you. This is ordinary Three.js — edit or delete it freely.
//
// The dressing on and beside the route: trees, bushes, flowers, a post-and-rope fence, and the
// vines under a floating island. Each one is a `Group` of primitives taking a scale and an RNG, so
// the same call site reads differently every time — and every one of them is pure decoration: none
// of it collides, because `buildStaticColliders` is handed a predicate and only walkable geometry
// passes it.
import {
  type BufferGeometry,
  ConeGeometry,
  CylinderGeometry,
  Group,
  type Material,
  Mesh,
  SphereGeometry,
} from "three";
import { toon } from "./materials.js";
import { C } from "./palette.js";

function mesh(geometry: BufferGeometry, material: Material): Mesh {
  const m = new Mesh(geometry, material);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** Stacked-cone conifer. */
export function pineTree(scale = 1, rng: () => number = Math.random): Group {
  const group = new Group();
  const trunk = mesh(new CylinderGeometry(0.13, 0.18, 0.7, 6), toon(C.woodDark));
  trunk.position.y = 0.35;
  group.add(trunk);
  for (let i = 0; i < 3; i += 1) {
    const cone = mesh(
      new ConeGeometry(0.72 - i * 0.17, 0.95, 8),
      toon(i % 2 ? C.grassDark : C.grass),
    );
    cone.position.y = 0.75 + i * 0.55;
    cone.rotation.y = rng() * Math.PI;
    group.add(cone);
  }
  group.scale.setScalar(scale);
  return group;
}

/** Round broadleaf tree with a clustered canopy. */
export function roundTree(scale = 1, rng: () => number = Math.random): Group {
  const group = new Group();
  const trunk = mesh(new CylinderGeometry(0.16, 0.24, 1, 6), toon(C.woodDark));
  trunk.position.y = 0.5;
  group.add(trunk);
  for (let i = 0; i < 5; i += 1) {
    const ball = mesh(
      new SphereGeometry(0.5 + rng() * 0.35, 10, 8),
      toon(i % 2 ? C.grass : C.grassDark),
    );
    ball.position.set((rng() - 0.5) * 0.9, 1.5 + (rng() - 0.5) * 0.5, (rng() - 0.5) * 0.9);
    group.add(ball);
  }
  group.scale.setScalar(scale);
  return group;
}

export function bush(scale = 1, rng: () => number = Math.random): Group {
  const group = new Group();
  for (let i = 0; i < 4; i += 1) {
    const r = 0.22 + rng() * 0.2;
    const ball = mesh(new SphereGeometry(r, 8, 6), toon(i % 2 ? C.grass : C.grassDark));
    ball.position.set((rng() - 0.5) * 0.6, r * 0.7, (rng() - 0.5) * 0.5);
    group.add(ball);
  }
  group.scale.setScalar(scale);
  return group;
}

export function flower(color = 0xff8fb0): Group {
  const group = new Group();
  const stem = mesh(new CylinderGeometry(0.015, 0.02, 0.22, 4), toon(C.grassDark));
  stem.position.y = 0.11;
  group.add(stem);
  for (let i = 0; i < 5; i += 1) {
    const petal = mesh(new SphereGeometry(0.05, 6, 4), toon(color));
    const a = (i / 5) * Math.PI * 2;
    petal.position.set(Math.cos(a) * 0.06, 0.24, Math.sin(a) * 0.06);
    group.add(petal);
  }
  const core = mesh(new SphereGeometry(0.04, 6, 4), toon(C.gold));
  core.position.y = 0.25;
  group.add(core);
  return group;
}

/** Wooden post-and-rope fence running along +X. */
export function fence(length: number, posts = 4): Group {
  const group = new Group();
  const step = length / (posts - 1);
  for (let i = 0; i < posts; i += 1) {
    const post = mesh(new CylinderGeometry(0.09, 0.11, 1, 6), toon(C.woodPost));
    post.position.set(i * step, 0.5, 0);
    group.add(post);
    if (i >= posts - 1) continue;
    for (const [height, sag] of [
      [0.78, 0.06],
      [0.45, 0.05],
    ] as const) {
      const rail = mesh(new CylinderGeometry(0.035, 0.035, step, 5), toon(C.rope));
      rail.rotation.z = Math.PI / 2;
      rail.position.set(i * step + step / 2, height - sag, 0);
      group.add(rail);
    }
  }
  return group;
}

/** Vine strands hanging off a ledge and a floating island. */
export function vines(count = 4, rng: () => number = Math.random): Group {
  const group = new Group();
  for (let i = 0; i < count; i += 1) {
    const length = 0.8 + rng() * 1.6;
    const strand = mesh(new CylinderGeometry(0.035, 0.03, length, 4), toon(C.grassDark));
    strand.position.set((rng() - 0.5) * 1.6, -length / 2, (rng() - 0.5) * 0.3);
    group.add(strand);
    for (let leaf = 0; leaf < 3; leaf += 1) {
      const pad = mesh(new SphereGeometry(0.11, 6, 4), toon(C.grass));
      pad.scale.set(1, 0.4, 0.7);
      pad.position.set(
        strand.position.x + (rng() - 0.5) * 0.2,
        -length * (0.2 + leaf * 0.3),
        strand.position.z,
      );
      group.add(pad);
    }
  }
  return group;
}

/** Waves the goal cloth without a texture: a sine along its own x. */
export function swayFlag(cloth: Mesh, time: number): void {
  const position = cloth.geometry.getAttribute("position");
  if (position === undefined) return;
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    position.setZ(i, Math.sin(time * 6 + x * 3) * 0.12 * (x + 0.9));
  }
  position.needsUpdate = true;
}
