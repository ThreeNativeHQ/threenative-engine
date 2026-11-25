import { Color, CylinderGeometry, type Group, MeshStandardMaterial, Object3D } from "three";
import { RNG } from "../vendor/stylized-biome-kit/core.js";
import { StaticKitMesh, type XYZ } from "./static-kit-mesh.js";

export interface IBakeLogisticsOptions {
  readonly module: string;
  readonly out: string;
  /** Unsigned 32-bit seed for the paint and wood finishes. */
  readonly seed?: number;
  /** Six-digit CSS hex color for the painted parts. */
  readonly accent?: string;
  /** Uniform scale from 0.5 to 2. Use matching scales for interacting parts. */
  readonly scale?: number;
  /** Rack only. Number of shelf levels from 2 to 4. Default 3. */
  readonly shelves?: number;
  /** Container only. Bake the doors swung outwards. Default false. */
  readonly open?: boolean;
}

export const logisticsAccent = "#317d83";
export const logisticsShelfCount = { min: 2, max: 4, default: 3 };
export const logisticsModules = [
  { id: "pallet", name: "Timber cargo pallet", category: "Cargo" },
  { id: "tote", name: "Stackable industrial cargo tote", category: "Cargo" },
  { id: "rack", name: "Warehouse pallet rack", category: "Storage" },
  { id: "jack", name: "Manual pallet jack", category: "Handling" },
  { id: "container", name: "Walk-in shipping container", category: "Storage" },
  { id: "loaded-pallet", name: "Loaded pallet with cargo totes", category: "Cargo" },
] as const;

type Module = (typeof logisticsModules)[number]["id"];
type Finish =
  | "wood"
  | "lightWood"
  | "base"
  | "accent"
  | "lightPaint"
  | "safety"
  | "steel"
  | "rubber";
type Part = StaticKitMesh<Finish>;
type Palette = Record<Finish, MeshStandardMaterial>;

const palletDepth = 1.04;
const palletTop = 0.17;
const forkX = 0.28;
const toteTop = 0.43;
const loadX = 0.3;
const threshold = 0.17;
const containerFront = 2.99;

function materials(seed: number, accent: string): Palette {
  const rng = new RNG(seed);
  const wood = new Color(0x795134).multiplyScalar(rng.range(0.87, 1.13));
  const paint = new Color(accent).multiplyScalar(rng.range(0.91, 1.06));
  const finish = (name: string, color: Color | number, metalness = 0, roughness = 0.72) =>
    new MeshStandardMaterial({ name, color, metalness, roughness });
  return {
    wood: finish("Cargo timber", wood),
    lightWood: finish("Cargo light timber", wood.clone().multiplyScalar(1.35)),
    base: finish("Cargo frame", 0x293740, 0.2),
    accent: finish("Cargo paint", paint, 0.15, 0.56),
    lightPaint: finish("Cargo raised paint", paint.clone().multiplyScalar(1.21), 0.13, 0.55),
    safety: finish("Cargo safety paint", 0xe5a242),
    steel: finish("Cargo lock and fittings", 0xa7b5b4, 0.36, 0.45),
    rubber: finish("Cargo wheels", 0x171f27, 0, 0.89),
  };
}

function anchor(group: Group, name: string, position: XYZ, yaw = 0): void {
  const marker = new Object3D();
  marker.name = name;
  marker.position.set(...position);
  marker.rotation.y = yaw;
  group.add(marker);
}

function pallet(palette: Palette): Group {
  const mesh = new StaticKitMesh<Finish>();
  for (const x of [-0.52, 0, 0.52]) {
    for (const z of [-0.39, 0, 0.39]) {
      mesh.block("wood", [0.18, 0.083, 0.23], [x, 0.0745, z], 0.013);
    }
    mesh.block("wood", [0.18, 0.033, palletDepth], [x, 0.0165, 0], 0.009);
    mesh.block("wood", [0.18, 0.025, palletDepth], [x, 0.1285, 0], 0.009);
  }
  for (const z of [-0.422, -0.21, 0, 0.21, 0.422]) {
    mesh.block("lightWood", [1.24, 0.032, 0.183], [0, palletTop - 0.016, z], 0.009);
    for (const x of [-0.52, 0.52]) {
      mesh.block("wood", [0.024, 0.004, 0.025], [x, palletTop - 0.001, z], 0.004);
    }
  }
  const group = mesh.finish("pallet", palette);
  anchor(group, "pallet-fork-rear", [0, 0, -palletDepth / 2]);
  anchor(group, "pallet-fork-front", [0, 0, palletDepth / 2], Math.PI);
  anchor(group, "pallet-load-left", [-loadX, palletTop, 0]);
  anchor(group, "pallet-load-right", [loadX, palletTop, 0]);
  return group;
}

function tote(palette: Palette): Group {
  const mesh = new StaticKitMesh<Finish>();
  mesh.block("base", [0.505, 0.055, 0.84], [0, 0.0275, 0], 0.022);
  mesh.block("accent", [0.522, 0.31, 0.868], [0, 0.207, 0], 0.041);
  mesh.block("base", [0.546, 0.037, 0.888], [0, 0.359, 0], 0.016);
  mesh.block("lightPaint", [0.556, 0.064, 0.908], [0, toteTop - 0.032, 0], 0.025);
  for (const side of [-1, 1]) {
    mesh.block("base", [0.198, 0.064, 0.02], [0, 0.293, side * 0.436], 0.014);
    mesh.block("lightPaint", [0.15, 0.018, 0.024], [0, 0.326, side * 0.443], 0.006);
    mesh.block("safety", [0.096, 0.034, 0.019], [0.118, 0.215, side * 0.436], 0.005);
    for (const z of [-0.29, -0.14, 0.14, 0.29]) {
      mesh.block("lightPaint", [0.027, 0.2, 0.058], [side * 0.26, 0.204, z], 0.009);
    }
  }
  const group = mesh.finish("cargo-tote", palette);
  anchor(group, "tote-stack", [0, toteTop, 0]);
  return group;
}

function rack(palette: Palette, count: number): Group {
  const mesh = new StaticKitMesh<Finish>();
  const shelfY = (i: number) => 0.19 + i * 0.72;
  const height = shelfY(count - 1) + 0.19;
  for (const x of [-0.735, 0.735]) {
    for (const z of [-0.562, 0.562]) {
      mesh.block("base", [0.183, 0.051, 0.165], [x, 0.0255, z], 0.021);
      mesh.block("accent", [0.085, height, 0.09], [x, height / 2, z], 0.018);
      mesh.block("base", [0.079, 0.038, 0.084], [x, height - 0.001, z], 0.015);
    }
    for (let i = 0; i < count; i++) {
      mesh.block("accent", [0.066, 0.105, 1.15], [x, shelfY(i) - 0.061, 0], 0.014);
    }
  }
  const rise = height - 0.18;
  mesh.block(
    "base",
    [0.055, Math.hypot(rise, 1.44), 0.048],
    [0, height / 2, -0.603],
    0.013,
    -Math.atan2(1.44, rise),
  );
  for (let i = 0; i < count; i++) {
    const y = shelfY(i);
    mesh.block("wood", [1.41, 0.044, 1.115], [0, y - 0.022, 0], 0.013);
    for (const z of [-0.56, 0.56]) {
      mesh.block("safety", [1.45, 0.089, 0.081], [0, y - 0.058, z], 0.012);
    }
    for (const x of [-0.62, 0.62]) {
      mesh.block("steel", [0.058, 0.037, 0.012], [x, y - 0.053, 0.604], 0.006);
    }
  }
  const group = mesh.finish("rack", palette);
  for (let i = 0; i < count; i++) anchor(group, `rack-shelf-${i + 1}`, [0, shelfY(i), 0]);
  return group;
}

function wheel(mesh: Part, position: XYZ, radius: number, thickness: number): void {
  mesh.add(
    "rubber",
    new CylinderGeometry(radius, radius, thickness, 16).rotateZ(Math.PI / 2).translate(...position),
  );
  mesh.add(
    "steel",
    new CylinderGeometry(radius * 0.46, radius * 0.46, thickness + 0.012, 12)
      .rotateZ(Math.PI / 2)
      .translate(...position),
  );
}

function jack(palette: Palette): Group {
  const mesh = new StaticKitMesh<Finish>();
  mesh.block("accent", [0.63, 0.15, 0.31], [0, 0.147, -0.505], 0.045);
  mesh.block("base", [0.26, 0.157, 0.185], [0, 0.267, -0.597], 0.026);
  for (const x of [-0.195, 0.195]) wheel(mesh, [x, 0.091, -0.608], 0.091, 0.082);
  const group = mesh.finish("jack-chassis", palette);

  const forks = new StaticKitMesh<Finish>();
  for (const x of [-forkX, forkX]) {
    forks.block("accent", [0.161, 0.065, 1.02], [x, 0.0705, 0.133], 0.029);
    forks.block("safety", [0.125, 0.015, 0.094], [x, 0.102, 0.565], 0.006);
    wheel(forks, [x, 0.044, 0.498], 0.041, 0.089);
  }
  const forkAssembly = forks.finish("jack-forks", palette);
  anchor(forkAssembly, "jack-fork-entry", [0, 0, -0.363]);
  group.add(forkAssembly);

  const grip = new StaticKitMesh<Finish>();
  grip.add(
    "steel",
    new CylinderGeometry(0.028, 0.028, 0.78, 10).rotateX(-0.39).translate(0, 0.365, -0.15),
  );
  for (const x of [-0.134, 0.134]) {
    grip.block("base", [0.045, 0.19, 0.038], [x, 0.778, -0.321], 0.014);
  }
  grip.block("base", [0.298, 0.047, 0.048], [0, 0.867, -0.328], 0.019);
  grip.block("base", [0.298, 0.049, 0.047], [0, 0.699, -0.301], 0.017);
  grip.block("steel", [0.054, 0.05, 0.066], [0.126, 0.793, -0.313], 0.011);
  grip.block("safety", [0.122, 0.032, 0.024], [0.071, 0.772, -0.312], 0.008, 0.4);
  const handle = grip.finish("jack-handle", palette);
  handle.position.set(0, 0.321, -0.61);
  group.add(handle);
  return group;
}

function containerDoor(palette: Palette, side: -1 | 1, open: boolean): Group {
  const mesh = new StaticKitMesh<Finish>();
  const width = 1.146;
  const middle = (-side * width) / 2;
  mesh.block("accent", [width, 2.2, 0.083], [middle, 1.1, 0], 0.021);
  for (const y of [0.055, 2.145]) {
    mesh.block("base", [width - 0.019, 0.077, 0.055], [middle, y, 0.035], 0.014);
  }
  for (const dx of [-0.276, 0.276]) {
    mesh.block("lightPaint", [0.079, 1.93, 0.027], [middle + dx, 1.1, 0.047], 0.01);
  }
  const latch = -side * 0.82;
  mesh.block("steel", [0.035, 2.002, 0.035], [latch, 1.1, 0.068], 0.009);
  for (const y of [0.195, 1.01, 2.01]) {
    mesh.block("base", [0.102, 0.05, 0.056], [latch, y, 0.075], 0.011);
  }
  mesh.block("steel", [0.225, 0.032, 0.033], [latch + side * 0.1, 1.012, 0.109], 0.006);
  mesh.block("safety", [0.164, 0.11, 0.016], [middle + side * 0.17, 0.84, 0.046], 0.005);
  const group = mesh.finish(side < 0 ? "container-door-left" : "container-door-right", palette);
  group.position.set(side * 1.16, threshold + 0.022, containerFront);
  group.rotation.y = open ? side * (Math.PI * 0.62) : 0;
  return group;
}

function container(palette: Palette, open: boolean): Group {
  const mesh = new StaticKitMesh<Finish>();
  mesh.block("base", [2.43, 0.15, 6.07], [0, 0.075, 0], 0.024);
  mesh.block("wood", [2.32, 0.04, 5.88], [0, threshold - 0.02, 0], 0.014);
  mesh.block("accent", [2.43, 0.11, 6.05], [0, 2.499, 0], 0.025);
  for (const x of [-1.126, 1.126]) {
    mesh.block("lightPaint", [0.083, 0.028, 5.82], [x, 2.558, 0], 0.009);
  }
  for (let rib = -6; rib <= 6; rib++) {
    mesh.block("lightPaint", [2.17, 0.026, 0.11], [0, 2.557, rib * 0.402], 0.009);
  }
  mesh.block("accent", [2.415, 2.362, 0.095], [0, 1.28, -2.985], 0.023);
  for (const side of [-1, 1]) {
    const x = side * 1.172;
    mesh.block("accent", [0.084, 2.36, 5.98], [x, 1.285, 0], 0.022);
    for (const end of [-1, 1]) {
      mesh.block("base", [0.137, 2.54, 0.143], [side * 1.172, 1.27, end * 2.96], 0.025);
      mesh.block("steel", [0.154, 0.138, 0.159], [side * 1.18, 2.487, end * 2.96], 0.02);
    }
    for (let i = 0; i < 25; i++) {
      mesh.block(
        "lightPaint",
        [0.052, 2.16, 0.108],
        [x + side * 0.043, 1.292, (i - 12) * 0.229],
        0.015,
      );
    }
  }
  mesh.block("base", [2.36, 0.113, 0.137], [0, 2.464, containerFront], 0.018);
  for (const x of [-0.84, -0.42, 0, 0.42, 0.84]) {
    mesh.block("lightPaint", [0.087, 2.2, 0.026], [x, 1.285, -3.036], 0.01);
  }
  const group = mesh.finish("container-shell", palette);
  group.add(containerDoor(palette, -1, open), containerDoor(palette, 1, open));
  anchor(group, "container-deck", [0, threshold, 1.86]);
  return group;
}

export function buildLogistics(
  id: Module,
  options: Required<Pick<IBakeLogisticsOptions, "seed" | "accent" | "scale">> &
    Pick<IBakeLogisticsOptions, "shelves" | "open">,
): Group {
  const palette = materials(options.seed, options.accent);
  const builders = {
    pallet: () => pallet(palette),
    tote: () => tote(palette),
    rack: () => rack(palette, options.shelves ?? logisticsShelfCount.default),
    jack: () => jack(palette),
    container: () => container(palette, options.open ?? false),
    "loaded-pallet": () => {
      const group = pallet(palette);
      for (const x of [-loadX, loadX]) {
        const cargo = tote(palette);
        cargo.position.set(x, palletTop, 0);
        group.add(cargo);
      }
      return group;
    },
  };
  const group = builders[id]();
  group.name = `logistics-${id}`;
  group.scale.setScalar(options.scale);
  return group;
}
