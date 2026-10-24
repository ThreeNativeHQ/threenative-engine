// Generated for you. This is ordinary Three.js — edit or delete it freely.
//
// Everything the hero collects or stomps, from primitives: a coin, a red gem, a Sunseed and the
// three walkers (a "bumblet", a hopper and a thornback). Each is a `Group` whose origin is its base or its centre as named below,
// so the entity that owns it only ever moves and spins the group.
import {
  ConeGeometry,
  CylinderGeometry,
  Group,
  IcosahedronGeometry,
  Mesh,
  OctahedronGeometry,
  SphereGeometry,
  TorusGeometry,
} from "three";
import { flat, lit } from "./materials.js";
import { C } from "./palette.js";

function shadowed(mesh: Mesh): Mesh {
  mesh.castShadow = true;
  return mesh;
}

/** A spinning coin, origin at its centre. */
export function coinModel(): Group {
  const group = new Group();
  const disc = shadowed(
    new Mesh(
      new CylinderGeometry(0.34, 0.34, 0.08, 18),
      // Low metalness: a metal coin takes its colour from what it reflects, and over a lawn that
      // turns gold olive. The glow keeps it saturated whatever the meter does.
      lit(C.gold, { metalness: 0.15, roughness: 0.35, emissive: 0.3 }),
    ),
  );
  disc.rotation.x = Math.PI / 2;
  group.add(disc);
  group.add(
    new Mesh(
      new TorusGeometry(0.34, 0.05, 6, 18),
      lit(C.goldDark, { metalness: 0.15, roughness: 0.4, emissive: 0.2 }),
    ),
  );
  return group;
}

/** A red gem, origin at its centre. */
export function gemModel(): Group {
  const group = new Group();
  const body = shadowed(
    new Mesh(
      new OctahedronGeometry(0.42),
      lit(C.gem, { flat: true, roughness: 0.25, emissive: 0.25 }),
    ),
  );
  body.scale.set(1.2, 1.7, 1.2);
  group.add(body);
  return group;
}

/** A Sunseed: a glowing seed with two leaves, origin at its centre. */
export function seedModel(): Group {
  const group = new Group();
  const seed = shadowed(
    new Mesh(
      new IcosahedronGeometry(0.62, 1),
      lit(C.seed, { flat: true, roughness: 0.3, emissive: 0.6 }),
    ),
  );
  seed.scale.set(0.85, 1.1, 0.85);
  group.add(seed);
  for (const side of [-1, 1]) {
    const leaf = shadowed(new Mesh(new SphereGeometry(0.32, 10, 6), lit(C.leaf)));
    leaf.scale.set(1, 0.18, 0.5);
    leaf.position.set(0.35 * side, 0.72, 0);
    leaf.rotation.z = 0.5 * side;
    group.add(leaf);
  }
  const halo = new Mesh(new TorusGeometry(0.95, 0.04, 6, 32), flat(C.seed, { opacity: 0.55 }));
  group.add(halo);
  return group;
}

/** The walker: a round purple bumblet on two stubby feet, origin at its feet, facing -Z. */
export function walkerModel(): Group {
  const group = new Group();
  const body = shadowed(
    new Mesh(new SphereGeometry(0.55, 20, 14), lit(C.walker, { roughness: 0.6 })),
  );
  body.position.y = 0.62;
  body.scale.set(1, 0.85, 1);
  group.add(body);
  const belly = new Mesh(new SphereGeometry(0.38, 14, 10), lit(C.walkerBelly));
  belly.position.set(0, 0.5, -0.3);
  belly.scale.set(1, 0.8, 0.5);
  group.add(belly);
  for (const side of [-1, 1]) {
    const eye = new Mesh(new SphereGeometry(0.11, 10, 8), flat(C.white));
    eye.position.set(0.19 * side, 0.82, -0.44);
    group.add(eye);
    const pupil = new Mesh(new SphereGeometry(0.055, 8, 6), flat(C.ink));
    pupil.position.set(0.19 * side, 0.8, -0.53);
    group.add(pupil);
    const horn = shadowed(new Mesh(new ConeGeometry(0.08, 0.28, 8), lit(C.walkerBelly)));
    horn.position.set(0.28 * side, 1.12, -0.05);
    horn.rotation.z = -0.4 * side;
    group.add(horn);
    const foot = shadowed(new Mesh(new SphereGeometry(0.17, 10, 8), lit(C.boots)));
    foot.position.set(0.26 * side, 0.12, -0.06);
    foot.scale.set(1, 0.7, 1.3);
    foot.name = side < 0 ? "footL" : "footR";
    group.add(foot);
  }
  return group;
}

/** Two eyes, white with a pupil, either side of the snout; `y`/`z` place them, `size` the white. */
function eyes(group: Group, x: number, y: number, z: number, size: number): void {
  for (const side of [-1, 1]) {
    const eye = new Mesh(new SphereGeometry(size, 10, 8), flat(C.white));
    eye.position.set(x * side, y, z);
    group.add(eye);
    const pupil = new Mesh(new SphereGeometry(size * 0.5, 8, 6), flat(C.ink));
    pupil.position.set(x * side, y - size * 0.1, z - size * 0.8);
    group.add(pupil);
  }
}

/** The hopper: a lime, frog-round bouncer on two long feet, eyes on top, origin at its feet. */
export function hopperModel(): Group {
  const group = new Group();
  const body = shadowed(
    new Mesh(new SphereGeometry(0.5, 18, 12), lit(C.hopper, { roughness: 0.5 })),
  );
  body.position.y = 0.5;
  body.scale.set(1.05, 0.82, 1);
  group.add(body);
  const belly = new Mesh(new SphereGeometry(0.34, 14, 10), lit(C.hopperBelly));
  belly.position.set(0, 0.4, -0.28);
  belly.scale.set(1, 0.8, 0.5);
  group.add(belly);
  eyes(group, 0.2, 0.92, -0.18, 0.15);
  for (const side of [-1, 1]) {
    const foot = shadowed(new Mesh(new SphereGeometry(0.16, 10, 8), lit(C.hopperBelly)));
    foot.position.set(0.32 * side, 0.08, -0.12);
    foot.scale.set(0.9, 0.5, 1.9);
    group.add(foot);
  }
  return group;
}

/**
 * The thornback: a low rust shell bristling with dark spikes, a sand-coloured head poking out the
 * front, origin at its feet. The spikes are the group named `spikes`, which its telegraph raises.
 */
export function thornbackModel(): Group {
  const group = new Group();
  const shell = shadowed(
    new Mesh(
      new SphereGeometry(0.72, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2),
      lit(C.thornShell, { flat: true, roughness: 0.55 }),
    ),
  );
  shell.position.y = 0.22;
  shell.scale.set(1, 0.85, 1.1);
  group.add(shell);
  const skirt = new Mesh(new CylinderGeometry(0.74, 0.7, 0.2, 18), lit(C.thornBelly));
  skirt.position.y = 0.14;
  group.add(skirt);
  const spikes = new Group();
  spikes.name = "spikes";
  spikes.position.y = 0.22;
  const spike = new ConeGeometry(0.09, 0.42, 6);
  for (let i = 0; i < 9; i += 1) {
    // One on top, then a ring of eight leaning out.
    const tip = shadowed(new Mesh(spike, lit(C.spike, { flat: true })));
    const angle = (i / 8) * Math.PI * 2;
    const lean = i === 8 ? 0 : 0.75;
    tip.position.set(
      Math.sin(angle) * lean * 0.6,
      i === 8 ? 0.72 : 0.5,
      Math.cos(angle) * lean * 0.66,
    );
    tip.rotation.set(Math.cos(angle) * lean, 0, -Math.sin(angle) * lean);
    spikes.add(tip);
  }
  group.add(spikes);
  const head = shadowed(new Mesh(new SphereGeometry(0.27, 14, 10), lit(C.thornBelly)));
  head.position.set(0, 0.36, -0.78);
  group.add(head);
  eyes(group, 0.12, 0.46, -0.98, 0.075);
  for (const side of [-1, 1]) {
    for (const end of [-1, 1]) {
      const foot = shadowed(new Mesh(new SphereGeometry(0.13, 8, 6), lit(C.thornBelly)));
      foot.position.set(0.5 * side, 0.08, 0.42 * end);
      foot.scale.set(1, 0.7, 1.2);
      group.add(foot);
    }
  }
  return group;
}
