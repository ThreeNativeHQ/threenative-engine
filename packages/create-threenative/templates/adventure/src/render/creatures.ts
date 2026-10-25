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
  DoubleSide,
  Group,
  IcosahedronGeometry,
  type Material,
  Mesh,
  MeshStandardMaterial,
  OctahedronGeometry,
  SphereGeometry,
  TorusGeometry,
} from "three";
import { flat, glow, lit } from "./materials.js";
import { C } from "./palette.js";
import { surfaced } from "./surface.js";

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
  const stone = surfaced(C.wardenStone, "rock", { flat: true });
  const moss = lit(C.moss, { flat: true });
  const rune = glow(C.wardenRune, 1.2);
  const torso = part(new DodecahedronGeometry(0.85, 0), stone, 0, 1.25);
  torso.scale.set(1.2, 1, 1);
  body.add(torso);
  const head = part(new BoxGeometry(0.75, 0.5, 0.6), stone, 0, 2.15, 0.1);
  body.add(head);
  const runeOff = lit(0x2c3d44, { roughness: 0.4 });
  const core = part(new TorusGeometry(0.22, 0.06, 8, 20), runeOff, 0, 1.3, 0.78);
  body.add(core);
  // Moss grown over the old stone: a cap on the head and the shoulders, a drift down the back.
  const mossCap = (r: number, x: number, y: number, z: number): void => {
    const cap = part(new IcosahedronGeometry(r, 1), moss, x, y, z);
    cap.scale.y = 0.35;
    body.add(cap);
  };
  mossCap(0.42, 0.05, 2.42, 0.05);
  mossCap(0.5, 0, 1.95, -0.35);
  // Carved runes, faintly lit: two rings of strokes on the chest, a stroke down each arm.
  for (let i = 0; i < 6; i += 1) {
    const a = (i / 6) * Math.PI * 2;
    const stroke = part(
      new BoxGeometry(0.05, 0.16, 0.03),
      rune,
      Math.cos(a) * 0.4,
      1.3 + Math.sin(a) * 0.4,
      0.72,
    );
    stroke.rotation.z = a;
    body.add(stroke);
  }
  for (const side of [-1, 1]) {
    body.add(
      part(new BoxGeometry(0.12, 0.08, 0.04), glow(C.wardenRune, 3), 0.17 * side, 2.2, 0.41),
    );
    const arm = part(new BoxGeometry(0.42, 1.1, 0.5), stone, 1.15 * side, 1.1, 0);
    arm.rotation.z = 0.15 * side;
    body.add(arm);
    const stroke = part(new BoxGeometry(0.04, 0.7, 0.03), rune, 1.15 * side, 1.1, 0.26);
    stroke.rotation.z = 0.15 * side;
    body.add(stroke);
    mossCap(0.32, 1.2 * side, 1.7, 0);
    body.add(part(new CylinderGeometry(0.28, 0.34, 0.6, 7), stone, 0.45 * side, 0.3, 0));
  }
  // Dazed: a ring of stars wheels round its head while it can be cut.
  const daze = new Group();
  daze.position.set(0, 2.75, 0.1);
  daze.visible = false;
  body.add(daze);
  const star = glow(C.reticle, 6);
  for (let i = 0; i < 5; i += 1) {
    const a = (i / 5) * Math.PI * 2;
    const point = part(
      new OctahedronGeometry(0.11, 0),
      star,
      Math.cos(a) * 0.62,
      0,
      Math.sin(a) * 0.62,
    );
    point.scale.y = 1.6;
    daze.add(point);
  }
  const halo = part(new TorusGeometry(0.62, 0.025, 6, 32), glow(C.wardenRune, 3));
  halo.rotation.x = Math.PI / 2;
  daze.add(halo);
  let time = 0;
  return {
    group: root,
    update(dt, phase, t, flash): void {
      time += dt;
      body.position.y = phase === "charge" ? Math.abs(Math.sin(time * 14)) * 0.08 : 0;
      body.rotation.x = phase === "windup" ? -0.25 * t : phase === "charge" ? 0.22 : 0;
      body.rotation.z = phase === "stunned" ? Math.sin(time * 6) * 0.08 : 0;
      core.material = phase === "stunned" || flash > 0 ? glow(C.wardenRune, 6) : runeOff;
      daze.visible = phase === "stunned";
      daze.rotation.y = time * 3;
      daze.position.y = 2.75 + Math.sin(time * 5) * 0.06;
      if (phase === "dead") {
        body.position.y = -t * 2.6;
        body.rotation.z = t * 0.4;
      }
    },
  };
}

const membrane = new MeshStandardMaterial({
  color: C.flickerWing,
  roughness: 0.75,
  side: DoubleSide,
});

/**
 * A Flicker: a dusk-violet bat with tall ears and two lamp eyes. Its origin is its body's centre
 * (it flies). The tell before a swoop: it rises, spreads its wings wide and holds them, shivers,
 * and its eyes burn red. Swooping, the wings fold back.
 */
export function createFlicker(): ICreatureRig {
  const root = new Group();
  const body = new Group();
  root.add(body);
  const fur = lit(C.flickerFur, { flat: true });
  const ball = part(new IcosahedronGeometry(0.22, 1), fur);
  ball.scale.set(1, 0.9, 1.1);
  body.add(ball);
  body.add(part(new SphereGeometry(0.13, 8, 6), lit(C.flickerBelly), 0, -0.05, 0.12));
  const calm = glow(C.eyeGlow, 3);
  const angry = glow(C.flickerTell, 8);
  const eyes: Mesh[] = [];
  const wings: Group[] = [];
  for (const side of [-1, 1]) {
    const ear = part(new ConeGeometry(0.07, 0.22, 4), fur, 0.1 * side, 0.22, 0.02);
    ear.rotation.z = -0.3 * side;
    body.add(ear);
    const eye = part(new SphereGeometry(0.045, 8, 6), calm, 0.08 * side, 0.05, 0.19);
    eyes.push(eye);
    body.add(eye);
    const fang = part(new ConeGeometry(0.02, 0.06, 4), lit(C.thorn), 0.04 * side, -0.08, 0.2);
    fang.rotation.x = Math.PI;
    body.add(fang);
    // A wing: a scalloped half-disc fan on a pivot at the shoulder.
    const wing = new Group();
    wing.position.set(0.14 * side, 0.04, 0);
    body.add(wing);
    const sheet = new Mesh(new CircleGeometry(0.5, 5, 0, Math.PI), membrane);
    sheet.rotation.x = -Math.PI / 2;
    sheet.rotation.z = side > 0 ? -Math.PI / 2 : Math.PI / 2;
    sheet.position.x = 0.02 * side;
    sheet.castShadow = true;
    wing.add(sheet);
    wings.push(wing);
  }
  let time = 0;
  return {
    group: root,
    update(dt, phase, t, flash): void {
      time += dt;
      let flap = Math.sin(time * 18) * 0.7;
      let fold = 0;
      body.position.set(0, Math.sin(time * 4) * 0.05, 0);
      body.rotation.set(0, 0, 0);
      for (const eye of eyes) eye.material = phase === "telegraph" ? angry : calm;
      if (phase === "telegraph") {
        // Wings spread wide and held, a shiver, the eyes red: the swoop is coming.
        flap = -0.25 + Math.sin(time * 60) * 0.05;
        body.position.x = Math.sin(time * 70) * 0.025;
        body.rotation.x = -0.35 * t;
      } else if (phase === "swoop") {
        fold = 1;
        body.rotation.x = 0.5;
      } else if (phase === "hurt") {
        body.rotation.set(t * Math.PI * 4, 0, 0.6);
      } else if (phase === "dead") {
        body.rotation.set(t * 6, 0, t * 3);
        body.scale.setScalar(Math.max(0.01, 1 - t));
      }
      for (const [i, wing] of wings.entries()) {
        const side = i === 0 ? -1 : 1;
        wing.rotation.set(0, -fold * 0.9 * side, flap * side * (1 - fold * 0.7));
      }
      ball.material = flash > 0 ? glow(0xffffff, 2) : fur;
    },
  };
}

/**
 * A Thornback: a squat shelled crawler whose whole front is a thorn-studded plate. Its rump is
 * bare, with a soft glowing sac: the one place a cut lands. The tell before its lunge: it rears
 * its plate up and the thorns stand out.
 */
export function createThornback(): ICreatureRig {
  const root = new Group();
  const body = new Group();
  root.add(body, blob(0.75));
  const shell = lit(C.thornShell, { flat: true });
  const thorn = lit(C.thorn, { flat: true });
  const dome = part(
    new SphereGeometry(0.62, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2),
    shell,
    0,
    0.22,
    -0.05,
  );
  dome.scale.set(1, 0.85, 1.25);
  body.add(dome);
  body.add(part(new CylinderGeometry(0.5, 0.55, 0.22, 12), lit(C.thornBelly), 0, 0.18, -0.05));
  // The front plate, tilted back a little, its thorns pointing at whatever it faces.
  const plate = new Group();
  plate.position.set(0, 0.42, 0.68);
  plate.rotation.x = -0.25;
  body.add(plate);
  const board = part(new CylinderGeometry(0.52, 0.52, 0.14, 7), shell);
  board.rotation.x = Math.PI / 2;
  plate.add(board);
  const spikes = new Group();
  body.add(spikes);
  for (let i = 0; i < 7; i += 1) {
    const a = (i / 7) * Math.PI * 2;
    const spike = part(
      new ConeGeometry(0.06, 0.3, 5),
      thorn,
      Math.cos(a) * 0.32,
      Math.sin(a) * 0.32,
      0.15,
    );
    spike.rotation.x = Math.PI / 2;
    plate.add(spike);
  }
  const horn = part(new ConeGeometry(0.08, 0.4, 5), thorn, 0, 0, 0.2);
  horn.rotation.x = Math.PI / 2;
  plate.add(horn);
  for (let i = 0; i < 9; i += 1) {
    const a = (i / 9) * Math.PI * 2;
    const spike = part(
      new ConeGeometry(0.05, 0.32, 5),
      thorn,
      Math.cos(a) * 0.35,
      0.62 + Math.abs(Math.sin(a)) * 0.05,
      Math.sin(a) * 0.5 - 0.05,
    );
    spike.rotation.set(Math.sin(a) * 0.5, 0, -Math.cos(a) * 0.5);
    spikes.add(spike);
  }
  const calm = glow(C.eyeGlow, 3);
  const angry = glow(C.flickerTell, 8);
  const eyes = [-1, 1].map((side) => {
    const eye = part(new SphereGeometry(0.05, 8, 6), calm, 0.16 * side, 0.2, 0.72);
    body.add(eye);
    return eye;
  });
  // The weak spot on the rump: a soft sac that glows brighter while it recovers after a lunge.
  const sac = part(new SphereGeometry(0.2, 12, 10), glow(C.thornWeak, 1.2), 0, 0.38, -0.78);
  body.add(sac);
  const legs: Mesh[] = [];
  for (let i = 0; i < 6; i += 1) {
    const side = i % 2 === 0 ? -1 : 1;
    const leg = part(
      new CylinderGeometry(0.05, 0.035, 0.3, 6),
      thorn,
      0.52 * side,
      0.12,
      0.35 - Math.floor(i / 2) * 0.4,
    );
    leg.rotation.z = 0.6 * side;
    body.add(leg);
    legs.push(leg);
  }
  let time = 0;
  return {
    group: root,
    update(dt, phase, t, flash): void {
      time += dt;
      const walking = phase === "stalk" || phase === "lunge";
      const pace = phase === "lunge" ? 30 : 12;
      for (const [i, leg] of legs.entries())
        leg.rotation.x = walking ? Math.sin(time * pace + i * 1.6) * 0.5 : 0;
      body.position.y = walking ? Math.abs(Math.sin(time * pace)) * 0.03 : 0;
      body.rotation.set(0, 0, 0);
      spikes.scale.setScalar(1);
      for (const eye of eyes) eye.material = phase === "telegraph" ? angry : calm;
      sac.material = glow(C.thornWeak, phase === "recover" ? 4 + Math.sin(time * 10) * 1.5 : 1.2);
      if (phase === "telegraph") {
        body.rotation.x = -0.4 * Math.min(1, t * 1.5);
        spikes.scale.setScalar(1 + 0.35 * t);
        body.position.x = Math.sin(time * 50) * 0.02;
      } else if (phase === "lunge") body.rotation.x = 0.12;
      else if (phase === "hurt") body.rotation.z = Math.sin(t * 30) * 0.12;
      else if (phase === "dead") {
        body.rotation.z = Math.min(1, t * 2) * Math.PI;
        body.position.y = Math.min(1, t * 2) * 0.5;
      }
      dome.material = flash > 0 ? glow(0xffffff, 2) : shell;
    },
  };
}

/** A straw practice dummy on a post: something to lock onto and swing at in the clearing. */
export function createDummy(): ICreatureRig {
  const root = new Group();
  const body = new Group();
  root.add(body, blob(0.3));
  const post = surfaced(C.woodDark, "planks");
  body.add(part(new CylinderGeometry(0.05, 0.06, 1.5, 6), post, 0, 0.75));
  const straw = lit(C.straw);
  body.add(part(new CylinderGeometry(0.22, 0.2, 0.6, 10), straw, 0, 1.15));
  body.add(part(new SphereGeometry(0.17, 10, 8), straw, 0, 1.62));
  const bar = part(new CylinderGeometry(0.04, 0.04, 0.9, 6), post, 0, 1.3);
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

/**
 * The lock-on marker: a gold three-sided arrow pointing down, drawn over everything. Its origin is
 * the arrow's tip, so `LockOn` places the tip above the target's head; it spins about Y, so its
 * outline reads from any side.
 */
export function createReticle(): Group {
  const reticle = new Group();
  const arrow = new Mesh(
    new ConeGeometry(0.2, 0.42, 3),
    flat(C.reticle, 0.95, { depthTest: false }),
  );
  arrow.rotation.x = Math.PI;
  arrow.position.y = 0.21;
  arrow.renderOrder = 20;
  reticle.add(arrow);
  reticle.visible = false;
  return reticle;
}
