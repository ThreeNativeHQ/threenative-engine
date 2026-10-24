// Generated for you. This is ordinary Three.js — edit or delete it freely.
//
// The vale's hostiles, from primitives. Each returns its root (feet at y = 0, facing +Z) and the
// one function that poses it, so the entity files never know a joint layout.
import {
  BoxGeometry,
  type BufferGeometry,
  CircleGeometry,
  ConeGeometry,
  CylinderGeometry,
  DodecahedronGeometry,
  Group,
  IcosahedronGeometry,
  type Material,
  Mesh,
  SphereGeometry,
  TorusGeometry,
} from "three";
import { flat, glow, lit } from "./materials.js";
import { C } from "./palette.js";

export interface ICreatureRig {
  readonly group: Group;
  /** `phase` is the creature's own state; `t` is 0..1 through it; `flash` > 0 right after a hit. */
  update(dt: number, phase: string, t: number, flash: number): void;
}

function part(geometry: BufferGeometry, material: Material, x = 0, y = 0, z = 0): Mesh {
  const mesh = new Mesh(geometry, material);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function blob(radius: number): Mesh {
  const shadow = new Mesh(new CircleGeometry(radius, 16), flat(0x0b1408, 0.3));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.015;
  shadow.renderOrder = 2;
  return shadow;
}

/** A Mossling: a hopping moss ball with a leaf crest and two lamp-bright eyes. */
export function createMossling(): ICreatureRig {
  const root = new Group();
  const body = new Group();
  root.add(body, blob(0.36));
  const ball = part(new IcosahedronGeometry(0.36, 2), lit(C.mossBody, { flat: true }), 0, 0.36);
  body.add(ball);
  body.add(part(new SphereGeometry(0.24, 10, 8), lit(C.mossBelly), 0, 0.3, 0.17));
  for (const side of [-1, 1]) {
    body.add(part(new SphereGeometry(0.06, 8, 6), glow(C.eyeGlow, 3), 0.12 * side, 0.46, 0.3));
    const leaf = part(new ConeGeometry(0.08, 0.32, 5), lit(C.leafLight), 0.07 * side, 0.78, -0.02);
    leaf.rotation.z = -0.5 * side;
    body.add(leaf);
  }
  let time = 0;
  return {
    group: root,
    update(dt, phase, t, flash): void {
      time += dt;
      const hop =
        phase === "chase" ? Math.abs(Math.sin(time * 9)) : Math.abs(Math.sin(time * 3)) * 0.3;
      body.position.y = hop * 0.22;
      const squash = phase === "windup" ? 1 - t * 0.3 : phase === "strike" ? 1.25 : 1 - hop * 0.08;
      body.scale.set(1 / Math.sqrt(squash), squash, 1 / Math.sqrt(squash));
      body.rotation.x = phase === "strike" ? 0.5 : 0;
      ball.material = flash > 0 ? glow(0xffffff, 2) : lit(C.mossBody, { flat: true });
      if (phase === "dead") {
        body.scale.setScalar(Math.max(0.01, 1 - t));
        body.position.y = 0;
      }
    },
  };
}

/** The Stone Warden: a squat stone guardian with a rune core that glows while it is stunned. */
export function createWarden(): ICreatureRig {
  const root = new Group();
  const body = new Group();
  root.add(body, blob(1));
  const stone = lit(C.wardenStone, { flat: true });
  const torso = part(new DodecahedronGeometry(0.85, 0), stone, 0, 1.25);
  torso.scale.set(1.2, 1, 1);
  body.add(torso);
  const head = part(new BoxGeometry(0.75, 0.5, 0.6), stone, 0, 2.15, 0.1);
  body.add(head);
  const runeOff = lit(0x2c3d44, { roughness: 0.4 });
  const core = part(new TorusGeometry(0.22, 0.06, 8, 20), runeOff, 0, 1.3, 0.78);
  body.add(core);
  for (const side of [-1, 1]) {
    body.add(
      part(new BoxGeometry(0.12, 0.08, 0.04), glow(C.wardenRune, 3), 0.17 * side, 2.2, 0.41),
    );
    const arm = part(new BoxGeometry(0.42, 1.1, 0.5), stone, 1.15 * side, 1.1, 0);
    arm.rotation.z = 0.15 * side;
    body.add(arm);
    body.add(part(new CylinderGeometry(0.28, 0.34, 0.6, 7), stone, 0.45 * side, 0.3, 0));
  }
  let time = 0;
  return {
    group: root,
    update(dt, phase, t, flash): void {
      time += dt;
      body.position.y = phase === "charge" ? Math.abs(Math.sin(time * 14)) * 0.08 : 0;
      body.rotation.x = phase === "windup" ? -0.25 * t : phase === "charge" ? 0.22 : 0;
      body.rotation.z = phase === "stunned" ? Math.sin(time * 6) * 0.08 : 0;
      core.material = phase === "stunned" || flash > 0 ? glow(C.wardenRune, 6) : runeOff;
      if (phase === "dead") {
        body.position.y = -t * 2.6;
        body.rotation.z = t * 0.4;
      }
    },
  };
}

/** A straw practice dummy on a post: something to lock onto and swing at in the clearing. */
export function createDummy(): ICreatureRig {
  const root = new Group();
  const body = new Group();
  root.add(body, blob(0.3));
  body.add(part(new CylinderGeometry(0.05, 0.06, 1.5, 6), lit(C.woodDark), 0, 0.75));
  const straw = lit(C.straw);
  body.add(part(new CylinderGeometry(0.22, 0.2, 0.6, 10), straw, 0, 1.15));
  body.add(part(new SphereGeometry(0.17, 10, 8), straw, 0, 1.62));
  const bar = part(new CylinderGeometry(0.04, 0.04, 0.9, 6), lit(C.woodDark), 0, 1.3);
  bar.rotation.z = Math.PI / 2;
  body.add(bar);
  return {
    group: root,
    update(_dt, phase, t, flash): void {
      body.rotation.z = flash > 0 ? Math.sin(flash * 30) * 0.15 : 0;
      if (phase === "dead") body.rotation.x = -t * 1.4;
    },
  };
}

/** The lock-on reticle: a gold ring and four pips, drawn over everything. Billboarded by `LockOn`. */
export function createReticle(): Group {
  const reticle = new Group();
  const material = flat(C.reticle, 0.9, { depthTest: false });
  const ring = new Mesh(new TorusGeometry(0.42, 0.03, 6, 32), material);
  ring.renderOrder = 20;
  reticle.add(ring);
  for (let i = 0; i < 4; i += 1) {
    const pip = new Mesh(new ConeGeometry(0.07, 0.16, 3), material);
    const a = (i / 4) * Math.PI * 2;
    pip.position.set(Math.cos(a) * 0.58, Math.sin(a) * 0.58, 0);
    pip.rotation.z = a + Math.PI / 2;
    pip.renderOrder = 20;
    reticle.add(pip);
  }
  reticle.visible = false;
  return reticle;
}
