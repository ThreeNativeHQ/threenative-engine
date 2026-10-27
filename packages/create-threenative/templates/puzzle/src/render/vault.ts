// The room. Ordinary Three.js — ThreeNative does not read this file, and nothing here imports a
// framework package, which is what keeps `src/render/` portable.
//
// It returns the geometry *and* a plain list of the boxes that should be solid. The scene turns
// those into physics bodies; this file never touches physics, so the look can be rebuilt without
// disturbing what the warden can walk into.
import {
  BoxGeometry,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  PointLight,
} from "three";
import {
  LANTERN,
  bannerMaterial,
  floorMaterial,
  floorSeamMaterial,
  lanternMaterial,
  sealRimMaterial,
  timberLightMaterial,
  timberMaterial,
  wallBaseMaterial,
  wallMaterial,
} from "./materials.js";
import { palette } from "./palette.js";
import { block } from "./shapes.js";

/** Interior half-extents. The warden and every crate live inside this box. */
export const VAULT = {
  halfX: 5.5,
  halfZ: 3.8,
  wallHeight: 1.9,
  wallThickness: 0.6,
} as const;

/** The way out: a seal set into the flagstones at the far corner. */
// Pushed into the corner and away from the pile. A seal within a metre of the crate field is
// tripped by the opening drop itself: a crate toppling off the stack slid to (1.91, -1.45) and
// won the run before the warden moved.
export const SEAL = { half: 1.35, x: 4.0, z: -2.4 } as const;

/** An axis-aligned solid box, in world space, for the scene to hand to the physics backend. */
export interface ISolidBox {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly width: number;
  readonly height: number;
  readonly depth: number;
}

export interface IVaultRoom {
  readonly object: Group;
  readonly solids: readonly ISolidBox[];
  /** The seal's own group, so the scene can pulse it and a scenario can ask if it is on screen. */
  readonly seal: Object3D;
  readonly setSealLit: (lit: boolean) => void;
}

export function createVaultRoom(): IVaultRoom {
  const root = new Group();
  root.name = "vault-room";
  const solids: ISolidBox[] = [];

  const outerX = VAULT.halfX + VAULT.wallThickness;
  const outerZ = VAULT.halfZ + VAULT.wallThickness;

  // --- floor -----------------------------------------------------------------------------
  const floor = block(outerX * 2, 0.6, outerZ * 2, floorMaterial, {
    castShadow: false,
    radius: 0.05,
  });
  floor.position.y = -0.3;
  root.add(floor);
  solids.push({ depth: outerZ * 2, height: 0.6, width: outerX * 2, x: 0, y: -0.3, z: 0 });

  // Flagstone seams. Thin dark inlays rather than a texture: at this camera distance four lines
  // per axis is all the eye reads anyway, and a CanvasTexture samples black under WebGPURenderer.
  const seamGeometry = new BoxGeometry(1, 0.02, 1);
  for (let index = -2; index <= 2; index += 1) {
    // Shadowless: an inlay two centimetres proud of the floor casts nothing the eye can find, and
    // the shadow pass would pay for a second draw of every one of them.
    const alongZ = new Mesh(seamGeometry, floorSeamMaterial);
    alongZ.scale.set(0.09, 1, outerZ * 2);
    alongZ.position.set(index * 2.35, 0.005, 0);
    alongZ.receiveShadow = false;
    alongZ.castShadow = false;
    root.add(alongZ);
    const alongX = new Mesh(seamGeometry, floorSeamMaterial);
    alongX.scale.set(outerX * 2, 1, 0.09);
    alongX.position.set(0, 0.005, index * 1.95);
    alongX.castShadow = false;
    root.add(alongX);
  }

  // --- walls -----------------------------------------------------------------------------
  // Four sides, each built from a dark plinth, a plaster band the lanterns light, and a timber
  // rail that overhangs both. The plinth is what the crates actually touch.
  const wallSpans: readonly {
    readonly length: number;
    readonly axis: "x" | "z";
    readonly sign: 1 | -1;
  }[] = [
    { axis: "z", length: outerX * 2, sign: -1 },
    { axis: "z", length: outerX * 2, sign: 1 },
    { axis: "x", length: outerZ * 2, sign: -1 },
    { axis: "x", length: outerZ * 2, sign: 1 },
  ];
  for (const span of wallSpans) {
    const alongX = span.axis === "z";
    const centre = alongX
      ? { x: 0, z: span.sign * (VAULT.halfZ + VAULT.wallThickness / 2) }
      : { x: span.sign * (VAULT.halfX + VAULT.wallThickness / 2), z: 0 };
    const size = (width: number, depth: number) => (alongX ? [width, depth] : [depth, width]);

    // The wall nearest the lens is cut down to a kerb. The camera looks over it, so a full wall
    // stands between the lens and the warden (a small figure, chest at about 0.45 m) whenever she
    // walks along it, and it hides any crate shoved against it: `camera-sees-subject` found that.
    // The portrait loses only the band of plaster along the bottom of the frame.
    const nearest = span.axis === "z" && span.sign === 1;
    const plasterHeight = nearest ? 0.34 : 1.14;
    const railHeight = nearest ? 0 : 0.34;

    const [plinthW, plinthD] = size(span.length, VAULT.wallThickness);
    const plinth = block(plinthW as number, 0.46, plinthD as number, wallBaseMaterial, {
      radius: 0.06,
    });
    plinth.position.set(centre.x, 0.23, centre.z);
    root.add(plinth);

    const [plasterW, plasterD] = size(span.length, VAULT.wallThickness * 0.86);
    const plaster = block(plasterW as number, plasterHeight, plasterD as number, wallMaterial, {
      radius: 0.05,
    });
    plaster.position.set(centre.x, 0.46 + plasterHeight / 2, centre.z);
    root.add(plaster);

    if (railHeight > 0) {
      const [railW, railD] = size(span.length, VAULT.wallThickness * 1.16);
      const rail = block(railW as number, railHeight, railD as number, timberMaterial, { radius: 0.07 });
      rail.position.set(centre.x, 0.46 + plasterHeight + railHeight / 2, centre.z);
      root.add(rail);
    }

    solids.push({
      depth: alongX ? VAULT.wallThickness : outerZ * 2,
      height: VAULT.wallHeight * 2,
      width: alongX ? outerX * 2 : VAULT.wallThickness,
      x: centre.x,
      y: VAULT.wallHeight,
      z: centre.z,
    });
  }

  // --- pillars ---------------------------------------------------------------------------
  // Corners and mid-spans, each with a lighter diamond inset turned 45 degrees on its face. The
  // insets are the only small detail in the room and they are what stops the walls reading flat.
  const pillarSpots: readonly { readonly x: number; readonly z: number }[] = [
    { x: -outerX + 0.42, z: -outerZ + 0.42 },
    { x: outerX - 0.42, z: -outerZ + 0.42 },
    { x: -outerX + 0.42, z: outerZ - 0.42 },
    { x: outerX - 0.42, z: outerZ - 0.42 },
    { x: -2.6, z: -outerZ + 0.3 },
    { x: 1.6, z: -outerZ + 0.3 },
    { x: -outerX + 0.3, z: 0.6 },
    { x: outerX - 0.3, z: 0.9 },
  ];
  for (const spot of pillarSpots) {
    const pillar = block(0.9, 2.24, 0.9, timberMaterial, { radius: 0.09 });
    pillar.position.set(spot.x, 1.12, spot.z);
    root.add(pillar);
    for (const height of [0.62, 1.62]) {
      // One segment and no shadow: at 0.3 m across and behind a crate pile, a three-segment
      // rounded box with a shadow-casting draw each is 32 meshes and 32 extra shadow draws for a
      // chamfer nobody resolves.
      const inset = block(0.3, 0.3, 0.3, timberLightMaterial, {
        castShadow: false,
        radius: 0.05,
        segments: 1,
      });
      inset.rotation.set(0, Math.PI / 4, Math.PI / 4);
      inset.scale.set(1, 1, 0.5);
      inset.position.set(spot.x, height, spot.z + 0.44);
      root.add(inset);
      const side = inset.clone();
      side.rotation.set(Math.PI / 4, 0, Math.PI / 4);
      side.scale.set(0.5, 1, 1);
      side.position.set(spot.x + 0.44, height, spot.z);
      root.add(side);
    }
  }

  // --- lanterns --------------------------------------------------------------------------
  // The room's warm half. Each is a housing, a flame, and a point light whose reach is
  // deliberately short: the pool of light on the plaster is the effect, not fill. The third one
  // is on the west wall because the warden starts under it, and a character the player cannot
  // find on the first screen is a worse problem than a slightly uneven room.
  const lanterns: readonly { readonly x: number; readonly z: number; readonly facing: 0 | 1 }[] = [
    { facing: 0, x: -3.4, z: -VAULT.halfZ + 0.16 },
    { facing: 0, x: -0.4, z: -VAULT.halfZ + 0.16 },
    { facing: 1, x: -VAULT.halfX + 0.16, z: 1.9 },
  ];
  for (const lantern of lanterns) {
    const out = lantern.facing === 0 ? { x: 0, z: 1 } : { x: 1, z: 0 };
    const bracket = block(0.16, 0.5, 0.16, timberMaterial, { radius: 0.04 });
    bracket.position.set(lantern.x - out.x * 0.1, 1.62, lantern.z - out.z * 0.1);
    root.add(bracket);
    const housing = block(0.34, 0.46, 0.34, timberMaterial, { radius: 0.06 });
    housing.position.set(lantern.x, 1.28, lantern.z);
    root.add(housing);
    const flame = block(0.22, 0.3, 0.22, lanternMaterial, { castShadow: false, radius: 0.05 });
    flame.position.set(lantern.x, 1.28, lantern.z);
    root.add(flame);
    const light = new PointLight(LANTERN, 8, 7.5, 1.9);
    light.position.set(lantern.x + out.x * 0.3, 1.3, lantern.z + out.z * 0.3);
    root.add(light);
  }

  // --- banners ---------------------------------------------------------------------------
  for (const z of [-0.9, 1.5]) {
    const pole = block(0.7, 0.1, 0.1, timberLightMaterial, { castShadow: false, radius: 0.04 });
    pole.position.set(VAULT.halfX - 0.06, 1.5, z);
    pole.rotation.y = Math.PI / 2;
    root.add(pole);
    const cloth = block(0.04, 0.86, 0.44, bannerMaterial, { castShadow: false, radius: 0.02 });
    cloth.position.set(VAULT.halfX - 0.06, 1.05, z);
    root.add(cloth);
    const tail = block(0.04, 0.2, 0.44, bannerMaterial, { castShadow: false, radius: 0.02 });
    tail.position.set(VAULT.halfX - 0.06, 0.55, z);
    tail.rotation.x = Math.PI / 4;
    root.add(tail);
  }

  // --- the seal --------------------------------------------------------------------------
  const seal = new Group();
  seal.name = "vault-seal";
  seal.position.set(SEAL.x, 0, SEAL.z);
  const rimSpan = SEAL.half * 2 + 0.26;
  for (const [dx, dz] of [
    [0, -1],
    [0, 1],
    [-1, 0],
    [1, 0],
  ] as const) {
    const alongX = dz !== 0;
    const kerb = block(alongX ? rimSpan : 0.26, 0.15, alongX ? 0.26 : rimSpan, sealRimMaterial, {
      radius: 0.05,
    });
    kerb.position.set(dx * (SEAL.half + 0.13), 0.075, dz * (SEAL.half + 0.13));
    seal.add(kerb);
  }
  // Concentric squares, drawn as FRAMES with dark floor showing between them. Three filled nested
  // plates read as one soft gradient; four thin bars per ring read as an inlay, and the gaps are
  // what make the rings legible at all.
  const glowMaterials: MeshBasicMaterial[] = [];
  const plate = new Mesh(
    new BoxGeometry(SEAL.half * 2, 0.02, SEAL.half * 2),
    new MeshBasicMaterial({ color: new Color(palette.accent).multiplyScalar(0.2) }),
  );
  plate.position.y = 0.012;
  seal.add(plate);
  const rings: readonly {
    readonly bar: number;
    readonly brightness: number;
    readonly span: number;
  }[] = [
    { bar: 0.11, brightness: 0.4, span: SEAL.half * 1.82 },
    { bar: 0.1, brightness: 0.58, span: SEAL.half * 1.24 },
    { bar: 0.09, brightness: 0.76, span: SEAL.half * 0.68 },
  ];
  rings.forEach((ring, index) => {
    const material = new MeshBasicMaterial({
      color: new Color(palette.accent).multiplyScalar(ring.brightness),
    });
    glowMaterials.push(material);
    for (const [dx, dz] of [
      [0, -1],
      [0, 1],
      [-1, 0],
      [1, 0],
    ] as const) {
      const alongX = dz !== 0;
      const bar = new Mesh(
        new BoxGeometry(alongX ? ring.span : ring.bar, 0.02, alongX ? ring.bar : ring.span),
        material,
      );
      bar.position.set(
        (dx * (ring.span - ring.bar)) / 2,
        0.024 + index * 0.004,
        (dz * (ring.span - ring.bar)) / 2,
      );
      seal.add(bar);
    }
  });
  // The core the rings surround: the brightest thing in the room, and the only part that blooms.
  const coreMaterial = new MeshBasicMaterial({
    color: new Color(palette.accent).multiplyScalar(0.95),
  });
  glowMaterials.push(coreMaterial);
  const core = new Mesh(new BoxGeometry(SEAL.half * 0.42, 0.02, SEAL.half * 0.42), coreMaterial);
  core.position.y = 0.04;
  seal.add(core);
  // The one light in the room that is not a lantern. The seal is the destination, and a run's
  // destination should be findable from the far corner without moving a lantern for it.
  const sealLight = new PointLight(palette.accent, 9, 13, 1.6);
  sealLight.position.set(0, 1.3, 0);
  seal.add(sealLight);
  root.add(seal);

  const baseBrightness = [...rings.map((ring) => ring.brightness), 1.05];
  const setSealLit = (lit: boolean): void => {
    const scale = lit ? 1.9 : 1;
    glowMaterials.forEach((material, index) => {
      material.color
        .copy(new Color(palette.accent))
        .multiplyScalar((baseBrightness[index] ?? 1) * scale);
    });
    sealLight.intensity = lit ? 22 : 9;
  };

  return { object: root, seal, setSealLit, solids };
}
