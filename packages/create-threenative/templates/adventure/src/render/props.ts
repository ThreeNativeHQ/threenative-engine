// Generated for you. This is ordinary Three.js — edit or delete it freely.
//
// Every prop in the vale and the Hollow, from primitives: chests, doors, the grate, the push
// block, the floor switch, the signposts, the lantern-keeper's hut, the pitcher-plant lantern,
// torches, the heart vessel and Wren's companion orb (the vale's planting is `foliage.ts`). Each
// builder returns a group with its origin on the floor; the level files place them.
import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  type BufferGeometry,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  LatheGeometry,
  type Material,
  Mesh,
  PointLight,
  SphereGeometry,
  Sprite,
  TorusGeometry,
  Vector2,
} from "three";
import { float, smoothstep, uv, vec3, vec4 } from "three/tsl";
import { SpriteNodeMaterial } from "three/webgpu";
import { mossBark } from "./foliage.js";
import { glow, lit, mottle } from "./materials.js";
import { C, palette } from "./palette.js";

function part(geometry: BufferGeometry, material: Material, x = 0, y = 0, z = 0): Mesh {
  const mesh = new Mesh(geometry, material);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

export interface IChestRig {
  readonly group: Group;
  /** 0 closed, 1 open. */
  setOpen(amount: number): void;
}

/** A banded wooden chest. The lid pivots on its back edge. */
export function createChest(): IChestRig {
  const group = new Group();
  const wood = lit(C.wood);
  const band = lit(palette.accent, { metalness: 0.7, roughness: 0.4 });
  group.add(part(new BoxGeometry(0.9, 0.5, 0.6), wood, 0, 0.25));
  for (const x of [-0.32, 0.32]) group.add(part(new BoxGeometry(0.07, 0.52, 0.62), band, x, 0.26));
  const lid = new Group();
  lid.position.set(0, 0.5, -0.3);
  group.add(lid);
  const top = part(new CylinderGeometry(0.3, 0.3, 0.9, 12, 1, false, 0, Math.PI), wood, 0, 0, 0.3);
  top.rotation.z = Math.PI / 2;
  lid.add(top);
  lid.add(part(new BoxGeometry(0.12, 0.14, 0.05), band, 0, 0.02, 0.62));
  return {
    group,
    setOpen(amount: number): void {
      lid.rotation.x = -amount * 1.9;
    },
  };
}

/** A heavy door in a stone frame. `locked` adds the brass lock plate. Slides down to open. */
export function createDoor(width: number, height: number, locked: boolean): Group {
  const group = new Group();
  const plank = lit(C.woodDark);
  group.add(part(new BoxGeometry(width, height, 0.22), plank, 0, height / 2));
  for (const y of [0.4, height - 0.4])
    group.add(part(new BoxGeometry(width, 0.12, 0.26), lit(C.iron, { metalness: 0.7 }), 0, y));
  if (locked) {
    group.add(
      part(
        new BoxGeometry(0.42, 0.5, 0.3),
        lit(palette.accent, { metalness: 0.8, roughness: 0.35 }),
        0,
        1.2,
      ),
    );
    group.add(part(new CylinderGeometry(0.05, 0.05, 0.32, 8), lit(C.eye), 0, 1.15));
  }
  return group;
}

/** An iron grate: vertical bars and two rails. Rises into the lintel to open. */
export function createGrate(width: number, height: number): Group {
  const group = new Group();
  const iron = lit(C.iron, { metalness: 0.8, roughness: 0.45 });
  const bars = Math.round(width / 0.32);
  for (let i = 0; i <= bars; i += 1)
    group.add(
      part(
        new CylinderGeometry(0.04, 0.04, height, 6),
        iron,
        -width / 2 + (i * width) / bars,
        height / 2,
      ),
    );
  for (const y of [0.3, height - 0.3])
    group.add(part(new BoxGeometry(width, 0.1, 0.1), iron, 0, y));
  return group;
}

/** The 1 m push block: cut stone with a moss cap and a carved lantern glyph. */
export function createBlock(rng: () => number): Group {
  const group = new Group();
  group.add(
    part(
      mottle(new BoxGeometry(0.98, 0.98, 0.98, 2, 2, 2), 0.2, rng),
      lit(C.stoneDark, { flat: true, vertexColors: true }),
      0,
      0.49,
    ),
  );
  group.add(part(new BoxGeometry(1, 0.08, 1), lit(C.moss), 0, 0.99));
  for (const [x, z] of [
    [0, 0.5],
    [0, -0.5],
  ] as const)
    group.add(part(new BoxGeometry(0.3, 0.3, 0.02), glow(palette.accent, 1.2), x, 0.5, z));
  return group;
}

/** The floor switch: a stone plate in a brass ring. `pressed` sinks it and lights the ring. */
export function createSwitchPlate(): { readonly group: Group; setPressed(pressed: boolean): void } {
  const group = new Group();
  const ring = part(
    new CylinderGeometry(0.62, 0.62, 0.04, 20),
    lit(C.brass, { metalness: 0.7, roughness: 0.4 }),
    0,
    0.02,
  );
  const plate = part(new CylinderGeometry(0.5, 0.5, 0.1, 20), lit(C.stoneDark), 0, 0.06);
  group.add(ring, plate);
  return {
    group,
    setPressed(pressed: boolean): void {
      plate.position.y = pressed ? 0.025 : 0.06;
      ring.material = pressed
        ? glow(palette.accent, 2)
        : lit(C.brass, { metalness: 0.7, roughness: 0.4 });
    },
  };
}

/** A signpost: a rough post, a plank with a pointed end, hand-lettered strokes and a moss cap. */
export function createSign(): Group {
  const group = new Group();
  group.add(
    part(new CylinderGeometry(0.06, 0.08, 1.35, 6), lit(C.woodDark, { detail: true }), 0, 0.67),
  );
  group.add(part(new SphereGeometry(0.09, 6, 4), lit(C.forestMoss), 0, 1.36));
  const board = new Group();
  board.position.set(0, 1.1, 0.07);
  board.rotation.z = 0.04;
  group.add(board);
  board.add(part(new BoxGeometry(0.9, 0.4, 0.06), lit(C.wood, { detail: true })));
  const tip = part(new CylinderGeometry(0.2, 0.2, 0.06, 3), lit(C.wood, { detail: true }), 0.5);
  tip.rotation.set(Math.PI / 2, 0, Math.PI / 2);
  board.add(tip);
  // The lettering: two lines of short brush strokes, as if painted by hand.
  const ink = lit(0x2a1d14, { roughness: 1 });
  for (let row = 0; row < 2; row += 1)
    for (let i = 0; i < 7 - row * 2; i += 1) {
      const tall = (i * 7 + row * 3) % 4 === 0;
      const stroke = part(
        new BoxGeometry(0.035, tall ? 0.11 : 0.07, 0.01),
        ink,
        -0.34 + i * 0.1,
        0.08 - row * 0.15,
        0.035,
      );
      stroke.rotation.z = ((i * 5 + row) % 3) * 0.35 - 0.35;
      board.add(stroke);
    }
  return group;
}

/**
 * The lantern-keeper's hut: a hollow tree-stump house with ridged, mossy walls, a round door in a
 * wooden ring, a lit round window, a shaggy thatched roof with moss on its crown, and lanterns
 * hanging from the eaves that cast one warm light. The door faces +Z.
 */
export function createHut(): { readonly group: Group; readonly lanterns: number } {
  const group = new Group();
  group.name = "hut";
  // The trunk-house: a lathe, ridged like bark and coloured by `mossBark`.
  const profile = [
    [2.65, -0.4],
    [2.45, 0.05],
    [2.12, 0.55],
    [1.98, 1.4],
    [1.92, 2.3],
    [1.8, 2.95],
    [0.1, 3.05],
  ].map(([r, y]) => new Vector2(r, y));
  const body = new LatheGeometry(profile, 20).toNonIndexed();
  const position = body.attributes.position;
  if (position !== undefined) {
    for (let i = 0; i < position.count; i += 1) {
      const x = position.getX(i);
      const z = position.getZ(i);
      const y = position.getY(i);
      const a = Math.atan2(z, x);
      const k = 1 + 0.06 * Math.sin(a * 7 + y * 1.7) + 0.03 * Math.sin(a * 13 - y * 3);
      position.setXYZ(i, x * k, y, z * k);
    }
  }
  const walls = new Mesh(mossBark(body, 0.8), lit(0xffffff, { detail: true, vertexColors: true }));
  walls.castShadow = true;
  walls.receiveShadow = true;
  group.add(walls);
  // The round door, its ring and a brass knob; a round window to its right.
  group.add(part(new CircleGeometry(0.72, 18), lit(C.hutDoor, { detail: true }), 0, 0.85, 2.06));
  group.add(part(new TorusGeometry(0.76, 0.09, 6, 20), lit(C.woodDark), 0, 0.85, 2.06));
  group.add(
    part(
      new SphereGeometry(0.05, 6, 4),
      lit(C.brass, { metalness: 0.7, roughness: 0.4 }),
      0.42,
      0.8,
      2.12,
    ),
  );
  const window = part(new CircleGeometry(0.26, 12), glow(C.lanternGlow, 3));
  window.position.set(Math.sin(0.75) * 1.97, 1.95, Math.cos(0.75) * 1.97);
  window.rotation.y = 0.75;
  group.add(window);
  // The thatch: an open cone with a ragged hem, straw streaked dark, moss on its crown.
  const roof = new ConeGeometry(3.15, 2.6, 24, 5, true).toNonIndexed();
  const rp = roof.attributes.position;
  const count = rp?.count ?? 0;
  const colour = new Float32Array(count * 3);
  const straw = new Color(C.thatch);
  const dark = new Color(C.thatchDark);
  const moss = new Color(C.forestMoss);
  const c = new Color();
  for (let i = 0; i < count && rp !== undefined; i += 1) {
    const x = rp.getX(i);
    const z = rp.getZ(i);
    const y = rp.getY(i);
    const a = Math.atan2(z, x);
    const hem = y < -1.2 ? -0.12 - 0.14 * Math.abs(Math.sin(a * 11)) : 0;
    const sag = 1 + 0.04 * Math.sin(a * 5);
    rp.setXYZ(i, x * sag, y + hem, z * sag);
    c.copy(straw).lerp(dark, 0.5 + 0.5 * Math.sin(a * 41 + y * 3));
    c.lerp(moss, Math.max(0, (y - 0.2) / 1.1) * (0.6 + 0.4 * Math.sin(a * 3)));
    colour.set([c.r, c.g, c.b], i * 3);
  }
  roof.setAttribute("color", new BufferAttribute(colour, 3));
  roof.computeVertexNormals();
  group.add(
    part(roof, lit(0xffffff, { detail: true, doubleSided: true, vertexColors: true }), 0, 4.05),
  );
  group.add(part(new SphereGeometry(0.42, 8, 5), lit(C.forestMoss, { detail: true }), 0, 5.2));
  // Lanterns on cords under the eaves, and the one warm light they share.
  const angles = [-0.7, 0.05, 0.75];
  const iron = lit(C.iron, { metalness: 0.6 });
  for (const a of angles) {
    const lantern = new Group();
    lantern.position.set(Math.sin(a) * 2.75, 0, Math.cos(a) * 2.75);
    lantern.add(part(new CylinderGeometry(0.008, 0.008, 0.6, 3), iron, 0, 2.85));
    lantern.add(part(new CylinderGeometry(0.1, 0.12, 0.22, 6, 1, true), iron, 0, 2.42));
    lantern.add(part(new ConeGeometry(0.13, 0.1, 6), iron, 0, 2.57));
    lantern.add(part(new SphereGeometry(0.08, 8, 6), glow(C.lanternGlow, 9), 0, 2.42));
    group.add(lantern);
  }
  const light = new PointLight(C.lanternGlow, 9, 9, 2);
  light.position.set(0, 2.2, 3.1);
  group.add(light);
  return { group, lanterns: angles.length };
}

/** A glowing orange pitcher plant hung from a crooked stick: a lantern grown, not made. */
export function createPitcherLantern(): Group {
  const group = new Group();
  const stick = part(
    new CylinderGeometry(0.03, 0.045, 1.7, 5),
    lit(C.woodDark, { detail: true }),
    0,
    0.85,
  );
  stick.rotation.z = 0.06;
  group.add(stick);
  const arm = part(new CylinderGeometry(0.02, 0.025, 0.38, 4), lit(C.woodDark), -0.18, 1.62);
  arm.rotation.z = Math.PI / 2 - 0.3;
  group.add(arm);
  const cup = new LatheGeometry(
    [
      [0.02, 0],
      [0.1, 0.05],
      [0.13, 0.15],
      [0.11, 0.26],
      [0.075, 0.32],
      [0.11, 0.38],
    ].map(([r, y]) => new Vector2(r, y)),
    10,
  );
  group.add(part(cup, glow(C.pitcher, 3.5), -0.34, 1.12));
  const lid = part(new ConeGeometry(0.13, 0.05, 6), lit(C.broadleaf), -0.31, 1.55);
  lid.rotation.z = -0.5;
  group.add(lid);
  group.add(part(new CylinderGeometry(0.01, 0.01, 0.12, 3), lit(C.broadleaf), -0.34, 1.53));
  const light = new PointLight(C.pitcher, 2.5, 4, 2);
  light.position.set(-0.34, 1.25, 0);
  group.add(light);
  return group;
}

/**
 * Wren's companion: a small orb of soft white-blue light with a halo and a light of its own. It is
 * an original design, a wisp: no wings, no face. `scenes/Play.ts` flies it and trails its sparks.
 */
export function createCompanion(): { readonly group: Group; readonly light: PointLight } {
  const group = new Group();
  group.name = "companion";
  group.add(part(new SphereGeometry(0.07, 10, 8), glow(C.orb, 3)));
  const halo = new SpriteNodeMaterial({
    blending: AdditiveBlending,
    depthWrite: false,
    transparent: true,
  });
  const mask = float(1).sub(smoothstep(0, 0.5, uv().sub(0.5).length()));
  const tint = new Color(C.orb);
  halo.colorNode = vec4(vec3(tint.r, tint.g, tint.b).mul(2.2), mask.mul(mask).mul(0.7));
  const sprite = new Sprite(halo);
  sprite.scale.setScalar(0.28);
  group.add(sprite);
  const light = new PointLight(C.orb, 1.2, 4.5, 2);
  group.add(light);
  return { group, light };
}

/** A wall torch: a bracket and a flame that is its own light source. */
export function createTorch(): Group {
  const group = new Group();
  group.add(
    part(new CylinderGeometry(0.04, 0.06, 0.4, 6), lit(C.iron, { metalness: 0.6 }), 0, 0, 0),
  );
  group.add(part(new SphereGeometry(0.1, 8, 6), glow(C.ember, 10), 0, 0.27, 0));
  group.add(part(new ConeGeometry(0.07, 0.22, 6), glow(C.lamp, 12), 0, 0.4, 0));
  return group;
}

/** The heart vessel: a faceted red crystal heart that spins and bobs. */
export function createHeartVessel(): Group {
  const group = new Group();
  const crystal = glow(C.heart, 2.5);
  for (const side of [-1, 1])
    group.add(part(new SphereGeometry(0.2, 10, 8), crystal, 0.13 * side, 0.12, 0));
  const point = part(new ConeGeometry(0.31, 0.42, 4), crystal, 0, -0.14, 0);
  point.rotation.x = Math.PI;
  point.rotation.y = Math.PI / 4;
  group.add(point);
  return group;
}

/** The small key: brass bow and bit. */
export function createKey(): Group {
  const group = new Group();
  const brass = glow(palette.accent, 1.5);
  group.add(part(new CylinderGeometry(0.1, 0.1, 0.04, 12), brass, 0, 0.3));
  group.add(part(new BoxGeometry(0.04, 0.32, 0.04), brass, 0, 0.1));
  group.add(part(new BoxGeometry(0.1, 0.05, 0.04), brass, 0.05, -0.03));
  return group;
}
