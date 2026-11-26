import {
  Box3,
  Color,
  CylinderGeometry,
  ExtrudeGeometry,
  type Group,
  LatheGeometry,
  MeshStandardMaterial,
  Shape,
  TorusGeometry,
  Vector2,
} from "three";
import { RNG } from "../vendor/stylized-biome-kit/core.js";
import type { IStaticKitMaterialOptions } from "./static-kit-materials.js";
import { StaticKitMesh } from "./static-kit-mesh.js";

export interface IBakePickupOptions extends IStaticKitMaterialOptions<Finish> {
  readonly module: string;
  readonly out: string;
  /** Unsigned 32-bit seed for finish variation. Default 1. */
  readonly seed?: number;
  /** Six-digit CSS hex color for the pickup's colored details. */
  readonly accent?: string;
  /** Uniform scale multiplier from 0.5 to 2. Default 1. */
  readonly scale?: number;
  /** Face-up ground pose for the keycard, shield, vault key and wrench. Default "upright". */
  readonly pose?: "upright" | "flat";
}

export const pickupAccent = "#238b82";
export const pickupModules = [
  { id: "medkit", name: "Pickup medkit", category: "Recovery" },
  { id: "potion", name: "Pickup potion bottle", category: "Recovery" },
  { id: "keycard", name: "Pickup access keycard", category: "Access" },
  { id: "shield", name: "Pickup shield", category: "Equipment" },
  { id: "vault-key", name: "Pickup vault key", category: "Access" },
  { id: "scroll", name: "Pickup parchment scroll", category: "Equipment" },
  { id: "repair-tool", name: "Pickup repair wrench", category: "Equipment" },
] as const;
export const flatPickupModules = ["keycard", "shield", "vault-key", "repair-tool"];

type Module = (typeof pickupModules)[number]["id"];
type Finish = "body" | "accent" | "dark" | "metal" | "gold" | "paper" | "wood" | "ink";
type Prop = StaticKitMesh<Finish>;
type Point = [number, number];

function materials(accent: string, seed: number): Record<Finish, MeshStandardMaterial> {
  const paint = (name: string, color: number | Color, roughness = 0.57, metalness = 0) =>
    new MeshStandardMaterial({ name, color, roughness, metalness });
  const rng = new RNG(seed);
  const tone = rng.range(0.91, 1);
  return {
    body: paint("Pickup ivory shell", new Color(0xf7eee1).multiplyScalar(tone)),
    accent: paint("Pickup accent", new Color(accent), 0.42),
    dark: paint("Pickup graphite", new Color(0x26384b).multiplyScalar(tone)),
    metal: paint("Pickup steel", new Color(0x829aad).multiplyScalar(tone), 0.37, 0.52),
    gold: paint("Pickup brass", new Color(0xe5ae55).multiplyScalar(tone), 0.38, 0.4),
    paper: paint("Pickup parchment", new Color(0xe7c893).multiplyScalar(tone), 0.95),
    wood: paint("Pickup dark wood", 0x684130, 0.82),
    ink: paint("Pickup ink", 0x7c523f, 0.95),
  };
}

function plate(mesh: Prop, finish: Finish, outline: Point[], depth: number, front = 0): void {
  const shape = new Shape(outline.map(([x, y]) => new Vector2(x, y)));
  const geometry = new ExtrudeGeometry(shape, { depth, bevelEnabled: false });
  mesh.add(finish, geometry.translate(0, 0, front - depth / 2));
}

function medkit(mesh: Prop): void {
  mesh.block("dark", [0.52, 0.08, 0.29], [0, 0.04, 0], 0.035);
  mesh.block("body", [0.49, 0.29, 0.27], [0, 0.208, 0], 0.055);
  mesh.block("accent", [0.5, 0.043, 0.278], [0, 0.277, 0], 0.021);
  mesh.block("dark", [0.23, 0.036, 0.05], [0, 0.422, 0], 0.012);
  for (const x of [-0.099, 0.099]) mesh.block("dark", [0.042, 0.072, 0.052], [x, 0.373, 0], 0.011);
  const cross: Point[] = [
    [-0.015, -0.052],
    [0.015, -0.052],
    [0.015, -0.014],
    [0.051, -0.014],
    [0.051, 0.014],
    [0.015, 0.014],
    [0.015, 0.052],
    [-0.015, 0.052],
    [-0.015, 0.014],
    [-0.051, 0.014],
    [-0.051, -0.014],
    [-0.015, -0.014],
  ];
  const stamp = new ExtrudeGeometry(new Shape(cross.map(([x, y]) => new Vector2(x, y))), {
    depth: 0.008,
    bevelEnabled: false,
  });
  for (const side of [-1, 1]) {
    mesh.block("dark", [0.146, 0.13, 0.022], [0, 0.183, side * 0.141], 0.014);
    mesh.add(
      "body",
      stamp
        .clone()
        .rotateY(side === 1 ? 0 : Math.PI)
        .translate(0, 0.183, side * 0.149),
    );
  }
  mesh.block("dark", [0.118, 0.014, 0.086], [0, 0.354, 0.068], 0.006);
  mesh.add(
    "body",
    stamp
      .scale(0.71, 0.71, 0.62)
      .rotateX(-Math.PI / 2)
      .translate(0, 0.36, 0.068),
  );
}

function potion(mesh: Prop): void {
  const profile = [
    [0, 0],
    [0.109, 0],
    [0.155, 0.049],
    [0.168, 0.136],
    [0.142, 0.214],
    [0.074, 0.279],
    [0.073, 0.32],
    [0.059, 0.32],
    [0, 0.32],
  ].map(([x, y]) => new Vector2(x, y));
  mesh.add("accent", new LatheGeometry(profile, 20));
  mesh.add("gold", new CylinderGeometry(0.084, 0.077, 0.038, 16).translate(0, 0.32, 0));
  mesh.add("wood", new CylinderGeometry(0.06, 0.067, 0.058, 12).translate(0, 0.356, 0));
  // The paper follows the same radial profile as the bottle's belly.
  const label = [
    new Vector2(0.155 + (0.013 * (0.104 - 0.049)) / (0.136 - 0.049) + 0.003, 0.104),
    new Vector2(0.171, 0.136),
    new Vector2(0.168 - (0.026 * (0.172 - 0.136)) / (0.214 - 0.136) + 0.003, 0.172),
  ];
  mesh.add("paper", new LatheGeometry(label, 20));
}

function keycard(mesh: Prop): void {
  plate(
    mesh,
    "dark",
    [
      [-0.226, 0],
      [0.224, 0],
      [0.251, 0.026],
      [0.251, 0.244],
      [0.197, 0.296],
      [-0.224, 0.296],
      [-0.251, 0.269],
      [-0.251, 0.026],
    ],
    0.036,
  );
  plate(
    mesh,
    "accent",
    [
      [-0.21, 0.195],
      [0.228, 0.195],
      [0.228, 0.235],
      [0.19, 0.271],
      [-0.21, 0.271],
    ],
    0.01,
    0.021,
  );
  mesh.block("gold", [0.117, 0.089, 0.011], [-0.112, 0.119, 0.022], 0.009);
  for (const x of [-0.139, -0.112, -0.085])
    mesh.block("dark", [0.006, 0.056, 0.004], [x, 0.119, 0.029], 0.002);
  mesh.block("body", [0.125, 0.018, 0.008], [0.099, 0.13, 0.021], 0.003);
  mesh.block("accent", [0.084, 0.014, 0.008], [0.078, 0.085, 0.021], 0.003);
  mesh.block("metal", [0.35, 0.051, 0.008], [-0.015, 0.219, -0.02], 0.004);
}

function shield(mesh: Prop): void {
  const shape: Point[] = [
    [0, 0],
    [0.21, 0.15],
    [0.282, 0.288],
    [0.282, 0.536],
    [0.205, 0.561],
    [-0.205, 0.561],
    [-0.282, 0.536],
    [-0.282, 0.288],
    [-0.21, 0.15],
  ];
  plate(mesh, "metal", shape, 0.071);
  plate(
    mesh,
    "accent",
    shape.map(([x, y]) => [x * 0.85, y * 0.85 + 0.048]),
    0.018,
    0.04,
  );
  plate(
    mesh,
    "body",
    [
      [0, 0.189],
      [0.126, 0.343],
      [0, 0.47],
      [-0.126, 0.343],
    ],
    0.013,
    0.052,
  );
  plate(
    mesh,
    "dark",
    [
      [0, 0.232],
      [0.083, 0.343],
      [0, 0.428],
      [-0.083, 0.343],
    ],
    0.01,
    0.061,
  );
  for (const x of [-0.103, 0.103])
    mesh.block("wood", [0.055, 0.199, 0.053], [x, 0.332, -0.052], 0.021);
}

function vaultKey(mesh: Prop): void {
  mesh.add("gold", new TorusGeometry(0.116, 0.029, 8, 20).translate(0, 0.435, 0));
  mesh.block("gold", [0.082, 0.349, 0.062], [0, 0.181, 0], 0.018);
  mesh.block("accent", [0.11, 0.069, 0.079], [0, 0.317, 0], 0.018);
  mesh.block("gold", [0.116, 0.048, 0.06], [0.042, 0.024, 0], 0.008);
  mesh.block("gold", [0.087, 0.042, 0.06], [0.039, 0.087, 0], 0.008);
  mesh.block("dark", [0.029, 0.135, 0.012], [0, 0.186, 0.031], 0.005);
}

function scroll(mesh: Prop): void {
  mesh.block("paper", [0.46, 0.022, 0.38], [0, 0.085, 0], 0.009);
  for (const z of [-0.201, 0.201]) {
    mesh.add(
      "paper",
      new CylinderGeometry(0.064, 0.064, 0.49, 12).rotateZ(Math.PI / 2).translate(0, 0.064, z),
    );
    for (const x of [-0.261, 0.261])
      mesh.add(
        "wood",
        new CylinderGeometry(0.039, 0.039, 0.049, 10).rotateZ(Math.PI / 2).translate(x, 0.064, z),
      );
  }
  for (const [z, width] of [
    [-0.101, 0.217],
    [-0.052, 0.178],
    [-0.008, 0.247],
    [0.038, 0.158],
  ] as const)
    mesh.block("ink", [width, 0.005, 0.011], [-0.043, 0.098, z], 0.002);
  mesh.add("accent", new CylinderGeometry(0.048, 0.042, 0.017, 12).translate(0.14, 0.106, 0.092));
  mesh.add("gold", new CylinderGeometry(0.021, 0.021, 0.008, 8).translate(0.14, 0.116, 0.092));
}

function repairTool(mesh: Prop): void {
  plate(
    mesh,
    "metal",
    [
      [-0.048, 0],
      [0.046, 0],
      [0.066, 0.035],
      [0.066, 0.31],
      [0.158, 0.409],
      [0.151, 0.515],
      [0.092, 0.58],
      [0.072, 0.548],
      [0.076, 0.471],
      [0.031, 0.422],
      [-0.033, 0.422],
      [-0.076, 0.471],
      [-0.074, 0.548],
      [-0.097, 0.58],
      [-0.151, 0.516],
      [-0.165, 0.409],
      [-0.069, 0.3],
      [-0.069, 0.035],
    ],
    0.056,
  );
  mesh.block("dark", [0.112, 0.239, 0.081], [0, 0.151, 0], 0.02);
  for (const z of [-0.043, 0.043]) {
    mesh.block("accent", [0.078, 0.112, 0.012], [0, 0.149, z], 0.007);
    mesh.block("gold", [0.073, 0.029, 0.012], [0, 0.23, z], 0.006);
  }
}

const shapes = {
  medkit,
  potion,
  keycard,
  shield,
  "vault-key": vaultKey,
  scroll,
  "repair-tool": repairTool,
};

export function buildPickup(
  id: Module,
  {
    seed,
    accent,
    scale,
    pose,
  }: { seed: number; accent: string; scale: number; pose: "upright" | "flat" },
): Group {
  const mesh = new StaticKitMesh<Finish>();
  shapes[id](mesh);
  const group = mesh.finish(`pickup-${id}`, materials(accent, seed));
  group.scale.setScalar(scale);
  if (pose === "flat") {
    group.rotation.x = -Math.PI / 2;
    const bounds = new Box3().setFromObject(group);
    group.position.set(0, -bounds.min.y, -(bounds.min.z + bounds.max.z) / 2);
  }
  return group;
}
