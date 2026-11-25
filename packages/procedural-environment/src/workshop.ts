import { readFile } from "node:fs/promises";
import { loadImage } from "@napi-rs/canvas";
import {
  BoxGeometry,
  CatmullRomCurve3,
  Color,
  CylinderGeometry,
  Group,
  LatheGeometry,
  MeshStandardMaterial,
  Object3D,
  RepeatWrapping,
  SRGBColorSpace,
  Texture,
  TorusGeometry,
  TubeGeometry,
  Vector2,
  Vector3,
} from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { RNG } from "../vendor/stylized-biome-kit/core.js";
import { StaticKitMesh, type XYZ } from "./static-kit-mesh.js";

export interface IBakeWorkshopOptions {
  readonly module: string;
  readonly out: string;
  /** Unsigned 32-bit seed for paint and wood tone. */
  readonly seed?: number;
  /** Six-digit CSS hex color for painted parts, bedding and upholstery. */
  readonly accent?: string;
  /** Uniform scale from 0.5 to 2. Use the same scale across an arrangement. */
  readonly scale?: number;
  /** Width in metres before scale for selected work surfaces and furniture. */
  readonly width?: number;
  /** Swivel chair seat height in metres for the chair or office workstation. */
  readonly height?: number;
  /** Bake the supported drawers, doors or lids in their open pose. */
  readonly open?: boolean;
  /** Sofa or lounge seats (2 or 3), or dining set chairs (4 or 6). */
  readonly seats?: number;
  /** Usable bookcase shelf levels, including the bottom shelf (3–5). */
  readonly shelves?: number;
}

export const workshopAccent = "#4d7779";
export const workshopModules = [
  { id: "workbench", name: "Modern workbench", category: "Work surfaces" },
  { id: "stool", name: "Workshop stool", category: "Seating" },
  { id: "drawer", name: "Three-drawer cabinet", category: "Storage" },
  { id: "shelf", name: "Wall-mounted workshop shelf", category: "Storage" },
  { id: "locker", name: "Hinged storage locker", category: "Storage" },
  { id: "bed", name: "Single bed with timber frame", category: "Beds" },
  { id: "station", name: "Assembled workshop workstation", category: "Arrangements" },
  { id: "sofa", name: "Upholstered sofa", category: "Lounge" },
  { id: "armchair", name: "Upholstered armchair", category: "Lounge" },
  { id: "coffee-table", name: "Two-tier coffee table", category: "Lounge" },
  { id: "media-console", name: "Hinged media console", category: "Lounge" },
  { id: "lounge", name: "Assembled lounge furniture", category: "Arrangements" },
  { id: "dining-table", name: "Timber dining table", category: "Dining" },
  { id: "dining-chair", name: "Slat-back dining chair", category: "Dining" },
  { id: "dining-bench", name: "Two-seat dining bench", category: "Dining" },
  { id: "dining-set", name: "Assembled dining furniture", category: "Arrangements" },
  { id: "kitchen-prep", name: "Kitchen prep cabinet", category: "Kitchen" },
  { id: "kitchen-sink", name: "Kitchen sink cabinet", category: "Kitchen" },
  { id: "kitchen-cooktop", name: "Kitchen cooktop cabinet", category: "Kitchen" },
  { id: "kitchen-run", name: "Assembled kitchen run", category: "Arrangements" },
  { id: "bath-vanity", name: "Vessel sink vanity", category: "Bathroom" },
  { id: "bath-tub", name: "Freestanding bathtub", category: "Bathroom" },
  { id: "bath-toilet", name: "Close-coupled toilet", category: "Bathroom" },
  { id: "office-desk", name: "Timber office desk", category: "Office" },
  { id: "office-chair", name: "Rolling swivel chair", category: "Office" },
  { id: "office-monitor", name: "Desktop monitor", category: "Office" },
  { id: "office-set", name: "Assembled office workstation", category: "Arrangements" },
  { id: "bookcase", name: "Open timber bookcase", category: "Storage" },
  { id: "wardrobe", name: "Double-door wardrobe", category: "Storage" },
  { id: "trunk", name: "Hinged storage trunk", category: "Storage" },
] as const;

type Module = (typeof workshopModules)[number]["id"];
type Finish = "wood" | "accent" | "dark" | "linen" | "steel" | "insert" | "ceramic" | "screen";
type Palette = Record<Finish, MeshStandardMaterial>;
type Part = StaticKitMesh<Finish>;

const workbenchWidth = { min: 1.2, max: 2.4, default: 1.65 };
const shelfWidth = { min: 0.7, max: 1.8, default: 1.05 };
const coffeeWidth = { min: 0.72, max: 1.5, default: 1.08 };
const diningWidth = { min: 1.4, max: 2.4, default: 1.68 };
const kitchenBay = 0.6;
const kitchenWidth = { min: kitchenBay, max: 2 * kitchenBay, default: kitchenBay };
const officeWidth = { min: 0.95, max: 1.8, default: 1.32 };
const chairHeight = { min: 0.42, max: 0.57, default: 0.47 };
export const workshopWidths: Partial<Record<Module, typeof workbenchWidth>> = {
  workbench: workbenchWidth,
  station: workbenchWidth,
  shelf: shelfWidth,
  "coffee-table": coffeeWidth,
  "dining-table": diningWidth,
  "dining-set": diningWidth,
  "dining-bench": { min: 0.92, max: 1.65, default: 1.16 },
  "kitchen-prep": kitchenWidth,
  "kitchen-run": kitchenWidth,
  "bath-vanity": { min: 0.64, max: 1.2, default: 0.78 },
  "bath-tub": { min: 1.4, max: 1.9, default: 1.65 },
  "office-desk": officeWidth,
  "office-set": officeWidth,
  bookcase: { min: 0.7, max: 1.38, default: 1.04 },
  wardrobe: { min: 0.9, max: 1.6, default: 1.18 },
  trunk: { min: 0.66, max: 1.35, default: 0.98 },
};
export const workshopHeights: Partial<Record<Module, typeof chairHeight>> = {
  "office-chair": chairHeight,
  "office-set": chairHeight,
};
export const workshopOpeningModules = [
  "drawer",
  "locker",
  "media-console",
  "kitchen-prep",
  "kitchen-sink",
  "kitchen-cooktop",
  "kitchen-run",
  "bath-toilet",
  "wardrobe",
  "trunk",
];
export const workshopShelfCount = { min: 3, max: 5, default: 4 };
const loungeSeats = { min: 2, max: 3, default: 3 };
const diningSeats = { min: 4, max: 6, default: 4 };
export const workshopSeatCounts: Partial<Record<Module, typeof loungeSeats>> = {
  sofa: loungeSeats,
  lounge: loungeSeats,
  "dining-set": diningSeats,
};

const worktop = 0.92;
const drawerY = [0.104, 0.302, 0.5];
const drawerFloor = 0.027;
const lockerFloor = 0.12;
const lockerShelf = 1.28;

interface IVeneer {
  color: Texture;
  normal: Texture;
}

export async function loadWorkshopVeneer(): Promise<IVeneer> {
  const load = async (map: "color" | "normal") => {
    const bytes = await readFile(new URL(`../scans/cherry_veneer-${map}.webp`, import.meta.url));
    const texture = new Texture(await loadImage(bytes));
    texture.name = `Cherry veneer ${map}`;
    texture.wrapS = texture.wrapT = RepeatWrapping;
    return texture;
  };
  const [color, normal] = await Promise.all([load("color"), load("normal")]);
  color.colorSpace = SRGBColorSpace;
  return { color, normal };
}

function materials(seed: number, accent: string, veneer?: IVeneer): Palette {
  const rng = new RNG(seed);
  const tone = rng.range(0.88, 1);
  const paint = new Color(accent).multiplyScalar(rng.range(0.94, 1.04));
  const finish = (name: string, color: Color | number, roughness = 0.64, metalness = 0) =>
    new MeshStandardMaterial({ name, color, roughness, metalness });
  const wood = finish(
    "Workshop cherry veneer",
    new Color(veneer ? 0xfff8ec : 0xd3a676).multiplyScalar(tone),
    0.66,
  );
  if (veneer) {
    wood.map = veneer.color;
    wood.normalMap = veneer.normal;
    wood.normalScale = new Vector2(0.5, 0.5);
  }
  return {
    wood,
    accent: finish("Workshop painted finish", paint, 0.62, 0.08),
    dark: finish("Workshop structural steel", 0x293438, 0.61, 0.2),
    linen: finish("Workshop light linen", 0xf2eee4, 0.86),
    steel: finish("Workshop handle metal", 0xb8c6c3, 0.42, 0.4),
    insert: finish("Workshop accent inset", paint.clone().multiplyScalar(0.67), 0.77),
    ceramic: finish("Workshop glazed ceramic", 0xf4f0e9, 0.29),
    screen: finish("Workshop matte display", 0x15232d, 0.72),
  };
}

function anchor(group: Group, name: string, position: XYZ, yaw = 0): void {
  const marker = new Object3D();
  marker.name = name;
  marker.position.set(...position);
  marker.rotation.y = yaw;
  group.add(marker);
}

function timber(
  mesh: Part,
  size: XYZ,
  center: XYZ,
  bevel = 0.021,
  grain: "horizontal" | "vertical" = "horizontal",
): void {
  const geometry = new RoundedBoxGeometry(...size, 1, bevel);
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const uv = geometry.getAttribute("uv");
  for (let i = 0; i < uv.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const nx = Math.abs(normal.getX(i));
    const ny = Math.abs(normal.getY(i));
    const nz = Math.abs(normal.getZ(i));
    const top = ny >= nx && ny >= nz;
    const horizontal = nx > nz && !top ? z : x;
    if (grain === "vertical" && !top) uv.setXY(i, y + 0.43, 0.36 - horizontal);
    else uv.setXY(i, horizontal + 0.43, (top ? z : y) + 0.36);
  }
  mesh.add("wood", geometry.translate(...center));
}

function drawerBay(width: number): XYZ {
  return [-width / 2 + 0.33, 0, 0.025];
}

function stoolBay(): XYZ {
  return [0.2, 0, 0.28];
}

function workbench(palette: Palette, width: number): Group {
  const mesh = new StaticKitMesh<Finish>();
  const supportX = width / 2 - 0.074;
  timber(mesh, [width, 0.078, 0.691], [0, worktop - 0.039, 0], 0.025);
  mesh.block("accent", [width - 0.116, 0.065, 0.066], [0, 0.816, -0.282], 0.014);
  mesh.block("dark", [width - 0.14, 0.06, 0.049], [0, 0.213, -0.291], 0.013);
  for (const x of [-supportX, supportX]) {
    mesh.block("accent", [0.061, 0.072, 0.56], [x, 0.819, 0], 0.014);
    for (const z of [-0.272, 0.272]) {
      mesh.block("accent", [0.052, 0.83, 0.052], [x, 0.428, z], 0.013);
      mesh.block("dark", [0.068, 0.048, 0.068], [x, 0.024, z], 0.014);
    }
    mesh.block("dark", [0.045, 0.06, 0.531], [x, 0.221, 0], 0.014);
  }
  const group = mesh.finish("workbench", palette);
  anchor(group, "worktop", [0, worktop, 0]);
  anchor(group, "workbench-drawer-bay", drawerBay(width));
  anchor(group, "workbench-stool-bay", stoolBay());
  return group;
}

function stool(palette: Palette): Group {
  const mesh = new StaticKitMesh<Finish>();
  timber(mesh, [0.424, 0.063, 0.404], [0, 0.4665, 0], 0.03);
  for (const side of [-1, 1]) {
    mesh.block("dark", [0.039, 0.045, 0.294], [side * 0.154, 0.176, 0], 0.012);
    mesh.block("accent", [0.323, 0.034, 0.036], [0, 0.207, side * 0.143], 0.012);
    for (const end of [-1, 1]) {
      const tireX = side * 0.172;
      const tireZ = end * 0.161;
      mesh.block("dark", [0.054, 0.035, 0.052], [tireX, 0.0175, tireZ], 0.014);
      mesh.add(
        "accent",
        new BoxGeometry(0.038, 0.433, 0.038)
          .rotateX(-end * 0.102)
          .rotateZ(side * 0.122)
          .translate(side * 0.148, 0.229, end * 0.139),
      );
    }
  }
  const group = mesh.finish("stool", palette);
  anchor(group, "stool-seat", [0, 0.498, 0]);
  return group;
}

function handle(mesh: Part, x: number, y: number, z: number): void {
  for (const dx of [-0.043, 0.043]) {
    mesh.block("dark", [0.023, 0.027, 0.035], [x + dx, y, z + 0.011], 0.006);
  }
  mesh.block("steel", [0.101, 0.023, 0.021], [x, y, z + 0.025], 0.008);
}

function drawer(palette: Palette, open: boolean): Group {
  const body = new StaticKitMesh<Finish>();
  body.block("dark", [0.376, 0.068, 0.494], [0, 0.034, -0.008], 0.02);
  body.block("accent", [0.41, 0.62, 0.03], [0, 0.381, -0.259], 0.015);
  for (const x of [-0.188, 0.188]) {
    body.block("accent", [0.034, 0.629, 0.535], [x, 0.3815, -0.006], 0.014);
  }
  timber(body, [0.407, 0.049, 0.553], [0, 0.714, -0.003]);
  const group = body.finish("drawer-unit", palette);
  for (const [index, y] of drawerY.entries()) {
    const tray = new StaticKitMesh<Finish>();
    tray.block("insert", [0.332, 0.184, 0.044], [0, 0.093, 0.255], 0.021);
    timber(tray, [0.308, 0.022, 0.447], [0, drawerFloor - 0.011, 0.006], 0.0055);
    for (const x of [-0.155, 0.155]) {
      tray.block("accent", [0.018, 0.09, 0.469], [x, 0.061, 0.009], 0.006);
    }
    tray.block("accent", [0.311, 0.09, 0.021], [0, 0.061, -0.218], 0.006);
    handle(tray, 0, 0.1, 0.275);
    const child = tray.finish(`drawer-${index + 1}`, palette);
    child.position.set(0, y, open && index === 2 ? 0.26 : 0);
    if (index === 2) anchor(child, "drawer-content", [0, drawerFloor, 0.123]);
    group.add(child);
  }
  return group;
}

function shelf(palette: Palette, width: number): Group {
  const mesh = new StaticKitMesh<Finish>();
  timber(mesh, [width, 0.067, 0.396], [0, 0.2385, 0.007], 0.022);
  for (const x of [-width / 2 + 0.133, width / 2 - 0.133]) {
    mesh.block("accent", [0.085, 0.215, 0.041], [x, 0.1075, -0.1745], 0.012);
    mesh.block("dark", [0.062, 0.035, 0.326], [x, 0.193, -0.008], 0.012);
    mesh.add(
      "accent",
      new BoxGeometry(0.041, 0.303, 0.034).rotateX(1.045).translate(x, 0.116, -0.023),
    );
    mesh.block("steel", [0.024, 0.024, 0.014], [x, 0.035, -0.149], 0.005);
  }
  const group = mesh.finish("wall-shelf", palette);
  anchor(group, "shelf-wall", [0, 0.192, -0.195]);
  anchor(group, "shelf-surface", [0, 0.272, 0]);
  return group;
}

function locker(palette: Palette, open: boolean): Group {
  const mesh = new StaticKitMesh<Finish>();
  mesh.block("dark", [0.572, 0.084, 0.505], [0, 0.042, 0], 0.021);
  mesh.block("accent", [0.61, 0.077, 0.544], [0, 1.789, 0], 0.025);
  mesh.block("accent", [0.606, 1.685, 0.034], [0, 0.9095, -0.26], 0.016);
  for (const x of [-0.287, 0.287]) {
    mesh.block("accent", [0.04, 1.677, 0.523], [x, 0.9135, 0.007], 0.014);
  }
  timber(mesh, [0.535, 0.042, 0.489], [0, lockerFloor - 0.021, -0.006], 0.01);
  timber(mesh, [0.535, 0.035, 0.489], [0, lockerShelf - 0.0175, -0.006], 0.008);
  mesh.block("steel", [0.493, 0.028, 0.029], [0, 1.178, -0.14], 0.006);
  const group = mesh.finish("locker-body", palette);
  anchor(group, "locker-floor", [0, lockerFloor, 0]);
  anchor(group, "locker-shelf", [0, lockerShelf, 0]);

  const panel = new StaticKitMesh<Finish>();
  panel.block("accent", [0.557, 1.644, 0.06], [0.2785, 0.822, 0], 0.026);
  panel.block("insert", [0.429, 1.448, 0.018], [0.279, 0.82, 0.034], 0.024);
  for (const y of [0.222, 0.264, 0.306, 1.345, 1.387, 1.429]) {
    panel.block("dark", [0.238, 0.018, 0.013], [0.279, y, 0.045], 0.004);
  }
  panel.block("linen", [0.118, 0.069, 0.018], [0.26, 1.053, 0.047], 0.005);
  handle(panel, 0.417, 0.879, 0.046);
  for (const y of [0.238, 1.421])
    panel.block("steel", [0.053, 0.091, 0.045], [0.005, y, 0.023], 0.012);
  const door = panel.finish("locker-door", palette);
  door.position.set(-0.278, 0.097, 0.266);
  door.rotation.y = open ? -Math.PI * 0.59 : 0;
  group.add(door);
  return group;
}

function bed(palette: Palette): Group {
  const mesh = new StaticKitMesh<Finish>();
  for (const x of [-0.435, 0.435]) {
    mesh.block("dark", [0.109, 0.194, 0.113], [x, 0.097, 0.867], 0.018);
    timber(mesh, [0.083, 0.14, 2.028], [x, 0.255, 0], 0.018);
    mesh.block("dark", [0.098, 0.849, 0.105], [x, 0.4245, -0.981], 0.019);
  }
  timber(mesh, [0.922, 0.526, 0.067], [0, 0.563, -0.963], 0.029);
  timber(mesh, [0.85, 0.102, 0.072], [0, 0.241, 0.979], 0.013);
  mesh.block("linen", [0.925, 0.199, 1.974], [0, 0.393, 0.023], 0.062);
  mesh.block("accent", [0.923, 0.082, 1.37], [0, 0.499, 0.319], 0.039);
  mesh.block("insert", [0.887, 0.029, 0.127], [0, 0.544, -0.294], 0.014);
  mesh.block("linen", [0.61, 0.113, 0.361], [0, 0.536, -0.661], 0.05);
  const group = mesh.finish("single-bed", palette);
  anchor(group, "bed-sleep", [0, 0.54, 0.205]);
  return group;
}

const cushionPitch = 0.58;
const seatHeight = 0.485;

function sofa(palette: Palette, count: number): Group {
  const mesh = new StaticKitMesh<Finish>();
  const chair = count === 1;
  const arm = chair ? 0.15 : 0.13;
  const width = cushionPitch * count + arm * 2;
  for (const x of [-width / 2 + arm / 2, width / 2 - arm / 2]) {
    for (const z of [-0.294, 0.316]) {
      timber(mesh, [0.075, 0.146, 0.073], [x, 0.073, z], 0.009);
    }
    mesh.block("accent", [arm, 0.308, 0.755], [x, 0.471, 0.023], 0.059);
  }
  timber(mesh, [width - 0.046, 0.077, 0.742], [0, 0.169, 0.006], 0.025);
  mesh.block("insert", [width - 0.018, 0.188, 0.792], [0, 0.285, 0.014], 0.055);
  mesh.add(
    "insert",
    new RoundedBoxGeometry(width - 0.045, 0.55, 0.162, 2, 0.057)
      .rotateX(-0.14)
      .translate(0, 0.566, -0.309),
  );
  for (let i = 0; i < count; i++) {
    const x = (i - (count - 1) / 2) * cushionPitch;
    mesh.block("accent", [0.568, 0.124, 0.546], [x, seatHeight - 0.062, 0.107], 0.046);
    mesh.add(
      "accent",
      new RoundedBoxGeometry(0.561, 0.395, 0.151, 2, 0.058)
        .rotateX(-0.16)
        .translate(x, 0.624, -0.214),
    );
  }
  const group = mesh.finish(chair ? "lounge-armchair" : "lounge-sofa", palette);
  for (let i = 0; i < count; i++) {
    anchor(group, chair ? "armchair-seat" : `seat-${i + 1}`, [
      (i - (count - 1) / 2) * cushionPitch,
      seatHeight,
      0.13,
    ]);
  }
  return group;
}

function coffeeTable(palette: Palette, width: number): Group {
  const mesh = new StaticKitMesh<Finish>();
  for (const x of [-width / 2 + 0.09, width / 2 - 0.09]) {
    for (const z of [-0.207, 0.207]) {
      timber(mesh, [0.065, 0.36, 0.065], [x, 0.18, z], 0.012);
    }
    mesh.block("insert", [0.045, 0.065, 0.44], [x, 0.319, 0], 0.008);
  }
  for (const z of [-0.207, 0.207]) {
    mesh.block("insert", [width - 0.18, 0.065, 0.041], [0, 0.319, z], 0.008);
  }
  timber(mesh, [width, 0.06, 0.575], [0, 0.375, 0], 0.027);
  timber(mesh, [width - 0.125, 0.036, 0.477], [0, 0.152, 0], 0.015);
  const group = mesh.finish("lounge-table", palette);
  anchor(group, "coffee-surface", [0, 0.405, 0]);
  anchor(group, "coffee-shelf", [0, 0.17, 0]);
  return group;
}

function mediaConsole(palette: Palette, open: boolean): Group {
  const mesh = new StaticKitMesh<Finish>();
  timber(mesh, [1.66, 0.06, 0.507], [0, 0.52, 0], 0.024);
  timber(mesh, [1.625, 0.058, 0.476], [0, 0.155, -0.003], 0.016);
  mesh.block("insert", [1.603, 0.307, 0.03], [0, 0.337, -0.237], 0.008);
  timber(mesh, [0.59, 0.034, 0.42], [0, 0.318, -0.003], 0.009);
  for (const side of [-1, 1]) {
    const x = side * 0.79;
    timber(mesh, [0.043, 0.314, 0.46], [x, 0.337, -0.003], 0.012);
    timber(mesh, [0.034, 0.314, 0.426], [side * 0.305, 0.337, -0.016], 0.009);
    for (const z of [-0.166, 0.162]) {
      mesh.block("dark", [0.059, 0.137, 0.061], [side * 0.716, 0.0685, z], 0.01);
    }
  }
  const group = mesh.finish("console-body", palette);
  anchor(group, "console-top", [0, 0.55, 0]);
  anchor(group, "console-shelf", [0, 0.335, 0]);
  for (const side of [-1, 1]) {
    const panel = new StaticKitMesh<Finish>();
    timber(panel, [0.458, 0.282, 0.035], [-side * 0.229, 0, 0], 0.012);
    panel.block("accent", [0.397, 0.226, 0.014], [-side * 0.229, 0, 0.018], 0.012);
    handle(panel, -side * 0.362, 0.064, 0.026);
    const door = panel.finish(side < 0 ? "console-door-left" : "console-door-right", palette);
    door.position.set(side * 0.776, 0.338, 0.229);
    door.rotation.y = open ? side * Math.PI * 0.6 : 0;
    group.add(door);
  }
  return group;
}

function lounge(palette: Palette, seats: number): Group {
  const group = new Group();
  const couch = sofa(palette, seats);
  couch.position.z = -0.56;
  const chair = sofa(palette, 1);
  chair.rotation.y = -Math.PI / 2;
  chair.position.set((seats * cushionPitch) / 2 + 0.73, 0, 0.43);
  const table = coffeeTable(palette, coffeeWidth.default);
  table.position.z = 0.55;
  group.add(couch, chair, table);
  return group;
}

const diningDepth = 0.84;
const diningSeatHeight = 0.46;

function diningTable(palette: Palette, width: number): Group {
  const mesh = new StaticKitMesh<Finish>();
  const span = width - 0.224;
  timber(mesh, [width, 0.052, diningDepth], [0, 0.724, 0], 0.023);
  for (const x of [-span / 2, span / 2]) {
    for (const z of [-0.325, 0.325]) {
      timber(mesh, [0.065, 0.705, 0.065], [x, 0.3525, z], 0.007, "vertical");
    }
    mesh.block("insert", [0.045, 0.062, 0.65], [x, 0.674, 0], 0.01);
  }
  for (const z of [-0.325, 0.325]) {
    mesh.block("insert", [span, 0.062, 0.045], [0, 0.674, z], 0.01);
  }
  const group = mesh.finish("dining-table", palette);
  anchor(group, "dining-top", [0, 0.75, 0]);
  return group;
}

function diningChair(palette: Palette): Group {
  const mesh = new StaticKitMesh<Finish>();
  for (const x of [-0.175, 0.175]) {
    timber(mesh, [0.043, 0.42, 0.044], [x, 0.21, 0.159], 0.006, "vertical");
    timber(mesh, [0.052, 0.817, 0.057], [x, 0.4085, -0.178], 0.01, "vertical");
    mesh.block("insert", [0.031, 0.044, 0.333], [x, 0.392, -0.005], 0.008);
  }
  for (const y of [0.679, 0.776]) {
    timber(mesh, [0.347, 0.067, 0.032], [0, y, -0.179], 0.014);
  }
  timber(mesh, [0.419, 0.046, 0.418], [0, 0.415, 0], 0.019);
  mesh.block("accent", [0.398, 0.048, 0.388], [0, 0.436, 0.009], 0.022);
  return mesh.finish("dining-chair", palette);
}

function diningBench(palette: Palette, width: number): Group {
  const mesh = new StaticKitMesh<Finish>();
  const span = width - 0.18;
  for (const x of [-span / 2, span / 2]) {
    for (const z of [-0.145, 0.145]) {
      timber(mesh, [0.059, 0.405, 0.059], [x, 0.2025, z], 0.008, "vertical");
    }
    mesh.block("insert", [0.049, 0.057, 0.29], [x, 0.371, 0], 0.01);
  }
  for (const z of [-0.145, 0.145]) {
    mesh.block("insert", [span, 0.057, 0.043], [0, 0.371, z], 0.01);
  }
  timber(mesh, [width, 0.045, 0.408], [0, 0.4215, 0], 0.02);
  mesh.block("accent", [width - 0.066, 0.042, 0.374], [0, 0.439, 0], 0.021);
  const group = mesh.finish("dining-bench", palette);
  anchor(group, "bench-seat-left", [-width / 4, diningSeatHeight, 0]);
  anchor(group, "bench-seat-right", [width / 4, diningSeatHeight, 0]);
  return group;
}

function diningSet(palette: Palette, width: number, seats: number): Group {
  const group = new Group().add(diningTable(palette, width));
  const chairModel = diningChair(palette);
  const row = Math.min(width / 4, width / 2 - 0.41);
  const side = diningDepth / 2 + 0.128;
  const end = width / 2 + 0.128;
  const places: [x: number, z: number, yaw: number][] = [
    [-row, -side, 0],
    [row, -side, 0],
    [row, side, Math.PI],
    [-row, side, Math.PI],
    [-end, 0, Math.PI / 2],
    [end, 0, -Math.PI / 2],
  ];
  for (const [i, [x, z, yaw]] of places.slice(0, seats).entries()) {
    const chair = chairModel.clone();
    chair.name = `dining-chair-${i + 1}`;
    chair.position.set(x, 0, z);
    chair.rotation.y = yaw;
    anchor(chair, `dining-seat-${i + 1}`, [0, diningSeatHeight, 0]);
    group.add(chair);
  }
  return group;
}

const counterTop = 0.91;
const counterDepth = 0.65;
const counterThickness = 0.047;
const kitchenSections = ["prep", "sink", "cooktop"] as const;
type KitchenSection = (typeof kitchenSections)[number];

function curvedFaucet(mesh: Part, y: number, z: number): void {
  mesh.add("steel", new CylinderGeometry(0.031, 0.035, 0.026, 16).translate(0, y + 0.011, z));
  const profile = [
    new Vector3(0, y + 0.015, z),
    new Vector3(0, y + 0.134, z),
    new Vector3(0, y + 0.207, z + 0.033),
    new Vector3(0, y + 0.201, z + 0.117),
    new Vector3(0, y + 0.151, z + 0.159),
  ];
  mesh.add("steel", new TubeGeometry(new CatmullRomCurve3(profile), 16, 0.014, 8));
  mesh.block("steel", [0.079, 0.014, 0.021], [0.029, y + 0.05, z], 0.006);
}

function kitchenSink(mesh: Part): void {
  const holeWidth = 0.408;
  const holeFront = 0.221;
  const holeBack = -0.121;
  const halfDepth = counterDepth / 2;
  const topY = counterTop - counterThickness / 2;
  for (const side of [-1, 1]) {
    const rail = (kitchenBay - holeWidth) / 2;
    mesh.block(
      "linen",
      [rail, counterThickness, counterDepth],
      [(side * (kitchenBay - rail)) / 2, topY, 0],
      0.01,
    );
    mesh.block("steel", [0.023, 0.131, 0.34], [side * 0.193, 0.8395, 0.05], 0.009);
  }
  for (const [start, end] of [
    [-halfDepth, holeBack],
    [holeFront, halfDepth],
  ] as const) {
    mesh.block(
      "linen",
      [holeWidth, counterThickness, end - start],
      [0, topY, (end + start) / 2],
      0.01,
    );
  }
  for (const z of [-0.109, 0.209]) {
    mesh.block("steel", [0.408, 0.131, 0.026], [0, 0.8395, z], 0.009);
  }
  mesh.block("steel", [0.401, 0.027, 0.334], [0, 0.7615, 0.05], 0.015);
  mesh.add("dark", new CylinderGeometry(0.023, 0.023, 0.004, 16).translate(0, 0.777, 0.04));
  curvedFaucet(mesh, counterTop, -0.23);
}

const cooktopBurners: [x: number, z: number, radius: number][] = [
  [-0.112, 0.063, 0.081],
  [0.112, 0.063, 0.072],
  [-0.112, -0.111, 0.064],
  [0.112, -0.111, 0.075],
];

function kitchenCooktop(mesh: Part): void {
  mesh.block("dark", [0.49, 0.018, 0.465], [0, 0.917, -0.004], 0.008);
  for (const [i, [x, z, r]] of cooktopBurners.entries()) {
    mesh.add(
      "steel",
      new TorusGeometry(r, 0.003, 6, 20).rotateX(-Math.PI / 2).translate(x, 0.927, z),
    );
    mesh.add(
      "steel",
      new CylinderGeometry(0.013, 0.016, 0.011, 12).translate((i - 1.5) * 0.052, 0.928, 0.18),
    );
  }
}

function kitchenCabinet(
  palette: Palette,
  section: KitchenSection,
  width: number,
  open: boolean,
): Group {
  const mesh = new StaticKitMesh<Finish>();
  mesh.block("dark", [width - 0.07, 0.102, 0.48], [0, 0.051, -0.025], 0.007);
  timber(mesh, [width - 0.008, 0.043, 0.564], [0, 0.116, -0.028], 0.008);
  mesh.block("insert", [width - 0.017, 0.737, 0.032], [0, 0.493, -0.307], 0.005);
  for (const side of [-1, 1]) {
    timber(
      mesh,
      [0.042, 0.745, 0.579],
      [side * (width / 2 - 0.028), 0.49, -0.016],
      0.006,
      "vertical",
    );
  }
  timber(mesh, [width - 0.079, 0.031, 0.518], [0, 0.3735, -0.018], 0.008);
  mesh.block("accent", [width - 0.01, 0.058, 0.039], [0, 0.835, 0.249], 0.008);
  if (section === "sink") kitchenSink(mesh);
  else
    mesh.block(
      "linen",
      [width, counterThickness, counterDepth],
      [0, counterTop - counterThickness / 2, 0],
      0.012,
    );
  if (section === "cooktop") kitchenCooktop(mesh);
  const group = mesh.finish(`kitchen-${section}`, palette);
  anchor(group, `${section}-join-left`, [-width / 2, counterTop, 0], -Math.PI / 2);
  anchor(group, `${section}-join-right`, [width / 2, counterTop, 0], Math.PI / 2);
  anchor(group, `${section}-shelf`, [0, 0.389, 0]);
  if (section === "prep") anchor(group, "prep-surface", [0, counterTop, 0]);
  if (section === "sink") {
    anchor(group, "sink-basin", [0.08, 0.775, 0.08]);
    anchor(group, "sink-faucet", [0, 1.053, -0.071]);
  }
  if (section === "cooktop") {
    for (const [i, [x, z]] of cooktopBurners.entries()) {
      anchor(group, `cooktop-burner-${i + 1}`, [x, 0.926, z]);
    }
  }
  const hingeInset = 0.06;
  const panelWidth = width / 2 - hingeInset - 0.003;
  for (const side of [-1, 1]) {
    const panel = new StaticKitMesh<Finish>();
    timber(panel, [panelWidth, 0.665, 0.036], [(-side * panelWidth) / 2, 0, 0], 0.013, "vertical");
    panel.block(
      "accent",
      [panelWidth - 0.037, 0.604, 0.014],
      [(-side * panelWidth) / 2, 0, 0.019],
      0.014,
    );
    panel.add(
      "steel",
      new CylinderGeometry(0.016, 0.012, 0.021, 12)
        .rotateX(Math.PI / 2)
        .translate(-side * (panelWidth - 0.048), 0.205, 0.035),
    );
    const door = panel.finish(`${section}-door-${side < 0 ? "left" : "right"}`, palette);
    door.position.set(side * (width / 2 - hingeInset), 0.47, 0.278);
    door.rotation.y = open ? side * Math.PI * 0.49 : 0;
    group.add(door);
  }
  return group;
}

function kitchenRun(palette: Palette, prepWidth: number, open: boolean): Group {
  const group = new Group();
  let edge = -prepWidth / 2 - kitchenBay;
  for (const section of kitchenSections) {
    const width = section === "prep" ? prepWidth : kitchenBay;
    const cabinet = kitchenCabinet(palette, section, width, open);
    cabinet.position.x = edge + width / 2;
    group.add(cabinet);
    edge += width;
  }
  return group;
}

function oval(
  mesh: Part,
  finish: Finish,
  profile: readonly [radius: number, height: number][],
  radiusX: number,
  radiusZ: number,
  center: XYZ,
): void {
  mesh.add(
    finish,
    new LatheGeometry(
      profile.map(([r, y]) => new Vector2(r, y)),
      36,
    )
      .scale(radiusX, 1, radiusZ)
      .translate(...center),
  );
}

function bathVanity(palette: Palette, width: number): Group {
  const mesh = new StaticKitMesh<Finish>();
  const top = 0.813;
  for (const x of [-width / 2 + 0.057, width / 2 - 0.057]) {
    for (const z of [-0.199, 0.199]) {
      timber(mesh, [0.058, 0.77, 0.06], [x, 0.385, z], 0.009, "vertical");
    }
    mesh.block("insert", [0.035, 0.107, 0.4], [x, 0.727, 0], 0.009);
  }
  for (const z of [-0.199, 0.199]) {
    mesh.block("accent", [width - 0.114, 0.107, 0.033], [0, 0.727, z], 0.01);
  }
  timber(mesh, [width - 0.092, 0.036, 0.452], [0, 0.206, 0], 0.014);
  mesh.block("ceramic", [width, 0.052, 0.54], [0, top - 0.026, 0], 0.02);
  oval(
    mesh,
    "ceramic",
    [
      [0, 0],
      [0.73, 0],
      [0.82, 0.011],
      [0.98, 0.085],
      [1, 0.103],
      [0.98, 0.123],
      [0.88, 0.129],
      [0.84, 0.116],
      [0.71, 0.043],
      [0.59, 0.024],
      [0, 0.024],
    ],
    0.233,
    0.151,
    [0, top, 0.04],
  );
  mesh.add("steel", new CylinderGeometry(0.021, 0.02, 0.004, 16).translate(0, top + 0.025, 0.055));
  curvedFaucet(mesh, top, -0.208);
  const group = mesh.finish("bath-vanity", palette);
  anchor(group, "vanity-basin", [0.035, top + 0.024, 0.06]);
  anchor(group, "vanity-faucet", [0, top + 0.144, -0.049]);
  anchor(group, "vanity-shelf", [0, 0.224, 0]);
  anchor(group, "vanity-wall", [0, top, -0.27]);
  return group;
}

function bathTub(palette: Palette, width: number): Group {
  const mesh = new StaticKitMesh<Finish>();
  oval(
    mesh,
    "accent",
    [
      [0, 0],
      [0.61, 0],
      [0.64, 0.028],
      [0.8, 0.095],
      [0.92, 0.27],
      [0.985, 0.466],
      [0.99, 0.523],
    ],
    width / 2,
    0.386,
    [0, 0, 0],
  );
  oval(
    mesh,
    "ceramic",
    [
      [0.99, 0.523],
      [1, 0.535],
      [0.99, 0.55],
      [0.94, 0.559],
      [0.89, 0.551],
      [0.875, 0.515],
      [0.82, 0.35],
      [0.74, 0.18],
      [0.57, 0.114],
      [0.37, 0.1],
      [0, 0.1],
    ],
    width / 2,
    0.386,
    [0, 0, 0],
  );
  const drainX = width * 0.15;
  mesh.add("steel", new CylinderGeometry(0.034, 0.034, 0.006, 20).translate(drainX, 0.103, 0));
  mesh.add("dark", new CylinderGeometry(0.022, 0.022, 0.003, 20).translate(drainX, 0.106, 0));
  const group = mesh.finish("bath-tub", palette);
  anchor(group, "tub-bottom", [0, 0.1, 0]);
  anchor(group, "tub-drain", [drainX, 0.1075, 0]);

  const mount: XYZ = [0, 0, -0.445];
  const tap = new StaticKitMesh<Finish>();
  tap.add("steel", new CylinderGeometry(0.049, 0.055, 0.025, 16).translate(0, 0.0125, 0));
  tap.add("steel", new CylinderGeometry(0.023, 0.027, 0.552, 16).translate(0, 0.293, 0));
  curvedFaucet(tap, 0.555, 0);
  const fixture = tap.finish("tub-faucet", palette);
  fixture.position.set(...mount);
  anchor(fixture, "tub-spout", [0, 0.698, 0.159]);
  anchor(group, "tub-filler", mount);
  group.add(fixture);
  return group;
}

function bathToilet(palette: Palette, open: boolean): Group {
  const body = new StaticKitMesh<Finish>();
  oval(
    body,
    "ceramic",
    [
      [0, 0],
      [0.58, 0],
      [0.6, 0.025],
      [0.54, 0.13],
      [0.56, 0.215],
      [0.78, 0.3],
      [0.94, 0.37],
      [1, 0.425],
      [1, 0.444],
      [0.95, 0.452],
      [0.81, 0.452],
      [0.78, 0.438],
      [0.72, 0.383],
      [0.62, 0.32],
      [0.38, 0.29],
      [0, 0.29],
    ],
    0.196,
    0.268,
    [0, 0, 0.095],
  );
  body.block("ceramic", [0.258, 0.201, 0.168], [0, 0.375, -0.139], 0.044);
  body.block("ceramic", [0.359, 0.331, 0.182], [0, 0.615, -0.227], 0.04);
  body.block("ceramic", [0.376, 0.035, 0.197], [0, 0.781, -0.227], 0.016);
  body.add("steel", new CylinderGeometry(0.022, 0.023, 0.01, 16).translate(0, 0.803, -0.227));
  for (const x of [-0.09, 0.09]) {
    body.add(
      "steel",
      new CylinderGeometry(0.014, 0.014, 0.039, 14)
        .rotateZ(Math.PI / 2)
        .translate(x, 0.463, -0.115),
    );
  }
  const group = body.finish("bath-toilet", palette);
  anchor(group, "toilet-flush", [0, 0.808, -0.227]);

  const seatMesh = new StaticKitMesh<Finish>();
  oval(
    seatMesh,
    "ceramic",
    [
      [0.79, 0.006],
      [0.94, 0.006],
      [0.977, 0.012],
      [0.971, 0.023],
      [0.934, 0.03],
      [0.807, 0.03],
      [0.78, 0.021],
      [0.79, 0.006],
    ],
    0.196,
    0.268,
    [0, 0, 0.21],
  );
  const seat = seatMesh.finish("toilet-seat", palette);
  seat.position.set(0, 0.446, -0.115);
  anchor(seat, "toilet-sit", [0, 0.03, 0.235]);

  const lidMesh = new StaticKitMesh<Finish>();
  oval(
    lidMesh,
    "accent",
    [
      [0, 0],
      [0.92, 0],
      [0.971, 0.006],
      [0.982, 0.015],
      [0.96, 0.023],
      [0.9, 0.027],
      [0, 0.027],
    ],
    0.196,
    0.268,
    [0, 0, 0.21],
  );
  const lid = lidMesh.finish("toilet-lid", palette);
  lid.position.set(0, 0.475, -0.115);
  lid.rotation.x = open ? -Math.PI * 0.5 : 0;
  group.add(seat, lid);
  return group;
}

const officeDeskTop = 0.747;
const deskMonitorMount: XYZ = [0, officeDeskTop, -0.12];

function officeDesk(palette: Palette, width: number): Group {
  const mesh = new StaticKitMesh<Finish>();
  const legSpan = width - 0.19;
  for (const x of [-legSpan / 2, legSpan / 2]) {
    mesh.block("dark", [0.094, 0.046, 0.55], [x, 0.023, 0.006], 0.02);
    mesh.block("dark", [0.063, 0.677, 0.082], [x, 0.3675, -0.105], 0.018);
    mesh.block("dark", [0.11, 0.038, 0.484], [x, 0.674, -0.009], 0.015);
  }
  mesh.block("insert", [legSpan, 0.183, 0.029], [0, 0.595, -0.237], 0.019);
  timber(mesh, [width, 0.058, 0.648], [0, officeDeskTop - 0.029, 0], 0.022);
  const grommetX = width / 2 - 0.12;
  mesh.add(
    "dark",
    new CylinderGeometry(0.023, 0.023, 0.004, 16).translate(
      grommetX,
      officeDeskTop + 0.001,
      -0.232,
    ),
  );
  const group = mesh.finish("office-desk", palette);
  anchor(group, "desk-surface", [0, officeDeskTop, 0]);
  anchor(group, "desk-monitor", deskMonitorMount);
  anchor(group, "desk-keyboard", [0, officeDeskTop, 0.157]);
  anchor(group, "desk-cable", [grommetX, officeDeskTop + 0.003, -0.232]);
  return group;
}

function officeChair(palette: Palette, height: number): Group {
  const base = new StaticKitMesh<Finish>();
  const swivelY = height - 0.065;
  base.add("dark", new CylinderGeometry(0.061, 0.066, 0.132, 18).translate(0, 0.132, 0));
  base.add(
    "steel",
    new CylinderGeometry(0.024, 0.024, swivelY - 0.181, 18).translate(0, (swivelY + 0.169) / 2, 0),
  );
  for (let i = 0; i < 5; i++) {
    const yaw = (2 * Math.PI * i) / 5;
    base.add(
      "dark",
      new RoundedBoxGeometry(0.049, 0.047, 0.244, 1, 0.014).translate(0, 0.085, 0.146).rotateY(yaw),
    );
    base.add("dark", new BoxGeometry(0.058, 0.048, 0.056).translate(0, 0.055, 0.258).rotateY(yaw));
    for (const x of [-0.023, 0.023]) {
      base.add(
        "dark",
        new CylinderGeometry(0.035, 0.035, 0.022, 16)
          .rotateZ(Math.PI / 2)
          .translate(x, 0.035, 0.258)
          .rotateY(yaw),
      );
    }
  }

  const seat = new StaticKitMesh<Finish>();
  seat.block("dark", [0.425, 0.042, 0.415], [0, -0.025, 0.013], 0.02);
  seat.block("accent", [0.48, 0.102, 0.455], [0, 0.014, 0.017], 0.037);
  seat.add(
    "dark",
    new RoundedBoxGeometry(0.09, 0.322, 0.052, 1, 0.022).rotateX(-0.15).translate(0, 0.139, -0.2),
  );
  seat.add(
    "insert",
    new RoundedBoxGeometry(0.447, 0.387, 0.084, 2, 0.04).rotateX(-0.15).translate(0, 0.284, -0.225),
  );
  seat.add(
    "accent",
    new RoundedBoxGeometry(0.408, 0.344, 0.059, 2, 0.025).rotateX(-0.15).translate(0, 0.286, -0.18),
  );
  seat.block("steel", [0.103, 0.021, 0.029], [0.178, -0.034, 0.04], 0.007);
  const swivel = seat.finish("chair-swivel", palette);
  swivel.position.y = swivelY;
  anchor(swivel, "chair-seat", [0, 0.065, 0.025]);
  const group = base.finish("office-chair", palette);
  group.add(swivel);
  return group;
}

function officeMonitor(palette: Palette): Group {
  const stand = new StaticKitMesh<Finish>();
  stand.block("dark", [0.275, 0.023, 0.23], [0, 0.0115, 0.005], 0.012);
  stand.block("steel", [0.045, 0.27, 0.056], [0, 0.148, -0.085], 0.018);
  stand.add(
    "dark",
    new CylinderGeometry(0.023, 0.023, 0.073, 16).rotateZ(Math.PI / 2).translate(0, 0.277, -0.073),
  );
  const panel = new StaticKitMesh<Finish>();
  panel.block("dark", [0.518, 0.315, 0.047], [0, -0.006, 0], 0.021);
  panel.block("screen", [0.48, 0.27, 0.011], [0, 0, 0.0305], 0.008);
  panel.add(
    "accent",
    new CylinderGeometry(0.006, 0.006, 0.003, 12)
      .rotateX(Math.PI / 2)
      .translate(0.222, -0.148, 0.024),
  );
  const head = panel.finish("monitor-panel", palette);
  head.position.set(0, 0.277, -0.054);
  head.rotation.x = -0.09;
  anchor(head, "monitor-display", [0, 0, 0.036]);
  anchor(head, "monitor-screen-top-left", [-0.24, 0.135, 0.036]);
  anchor(head, "monitor-screen-bottom-right", [0.24, -0.135, 0.036]);
  const group = stand.finish("office-monitor", palette);
  group.add(head);
  return group;
}

function officeSet(palette: Palette, width: number, height: number): Group {
  const chair = officeChair(palette, height);
  chair.position.z = 0.49;
  chair.rotation.y = Math.PI;
  const monitor = officeMonitor(palette);
  monitor.position.set(...deskMonitorMount);
  return new Group().add(officeDesk(palette, width), monitor, chair);
}

function bookcase(palette: Palette, width: number, shelves: number): Group {
  const mesh = new StaticKitMesh<Finish>();
  const height = 1.81;
  const bottom = 0.13;
  const interior = width - 0.064;
  const pitch = (height - 0.054 - bottom) / shelves;
  mesh.block("insert", [width - 0.074, 0.108, 0.303], [0, 0.054, -0.009], 0.011);
  mesh.block("accent", [interior, height - 0.097, 0.023], [0, 0.904, -0.16], 0.007);
  for (const x of [-width / 2 + 0.017, width / 2 - 0.017]) {
    timber(mesh, [0.034, height - 0.042, 0.337], [x, 0.884, 0], 0.008, "vertical");
  }
  timber(mesh, [width, 0.044, 0.344], [0, height - 0.022, 0], 0.015);
  for (let level = 0; level < shelves; level++) {
    const y = bottom + level * pitch;
    timber(mesh, [interior, 0.031, 0.313], [0, y - 0.0155, 0.003], 0.008);
  }
  const group = mesh.finish("bookcase", palette);
  for (let level = 0; level < shelves; level++) {
    anchor(group, `bookcase-shelf-${level + 1}`, [0, bottom + level * pitch, 0.008]);
  }
  anchor(group, "bookcase-wall", [0, 1.73, -0.172], Math.PI);
  return group;
}

function wardrobe(palette: Palette, width: number, open: boolean): Group {
  const mesh = new StaticKitMesh<Finish>();
  const interior = width - 0.078;
  const floorY = 0.143;
  const shelfY = 1.677;
  const railY = 1.516;
  const doorY = 0.14;
  const hingeX = width / 2 - 0.009;
  const hingeZ = 0.294;
  const hingeHeights = [0.235, 1.49];
  mesh.block("insert", [width - 0.047, 0.12, 0.49], [0, 0.06, 0], 0.016);
  timber(mesh, [width, 0.048, 0.568], [0, 1.928, 0], 0.015);
  mesh.block("accent", [interior, 1.785, 0.027], [0, 1.013, -0.253], 0.008);
  for (const side of [-1, 1]) {
    timber(mesh, [0.04, 1.817, 0.54], [side * (width / 2 - 0.02), 1.0, 0], 0.01, "vertical");
    for (const height of hingeHeights) {
      const y = doorY + height;
      mesh.block("dark", [0.035, 0.046, 0.043], [side * (hingeX - 0.009), y, hingeZ - 0.017]);
      mesh.add(
        "steel",
        new CylinderGeometry(0.013, 0.013, 0.064, 12).translate(side * hingeX, y, hingeZ),
      );
    }
  }
  for (const y of [floorY, shelfY]) {
    timber(mesh, [interior, 0.034, 0.495], [0, y - 0.017, 0.0075], 0.008);
  }
  mesh.add(
    "steel",
    new CylinderGeometry(0.014, 0.014, interior, 16)
      .rotateZ(Math.PI / 2)
      .translate(0, railY, 0.042),
  );
  const group = mesh.finish("wardrobe", palette);
  anchor(group, "wardrobe-floor", [0, floorY, 0.035]);
  anchor(group, "wardrobe-shelf", [0, shelfY, 0.035]);
  anchor(group, "wardrobe-hanger-rail", [0, railY + 0.014, 0.042]);

  for (const side of [-1, 1]) {
    const panel = new StaticKitMesh<Finish>();
    const span = width / 2 - 0.012;
    const center = (-side * span) / 2;
    const rail = 0.063;
    const height = 1.755;
    panel.block("insert", [span - 0.108, height - 0.11, 0.021], [center, height / 2, 0], 0.008);
    for (const x of [(-side * rail) / 2, -side * (span - rail / 2)]) {
      timber(panel, [rail, height, 0.038], [x, height / 2, 0], 0.009, "vertical");
    }
    for (const y of [rail / 2, height - rail / 2]) {
      timber(panel, [span - 2 * rail + 0.002, rail, 0.037], [center, y, 0], 0.008);
    }
    for (const y of hingeHeights) {
      panel.block("steel", [0.049, 0.033, 0.02], [-side * 0.02, y, -0.012], 0.006);
    }
    const handleX = -side * (span - 0.031);
    for (const y of [0.915, 1.015]) {
      panel.block("dark", [0.027, 0.022, 0.038], [handleX, y, 0.034], 0.006);
    }
    panel.block("dark", [0.015, 0.127, 0.018], [handleX, 0.965, 0.054], 0.007);
    const door = panel.finish(side < 0 ? "wardrobe-door-left" : "wardrobe-door-right", palette);
    door.position.set(side * hingeX, doorY, hingeZ);
    door.rotation.y = open ? side * Math.PI * 0.59 : 0;
    group.add(door);
  }
  return group;
}

function trunk(palette: Palette, width: number, open: boolean): Group {
  const body = new StaticKitMesh<Finish>();
  const half = width / 2;
  const rim = 0.442;
  const floorY = 0.092;
  body.block("dark", [width - 0.037, 0.067, 0.477], [0, 0.0335, 0], 0.012);
  timber(body, [width - 0.052, 0.036, 0.461], [0, floorY - 0.018, 0], 0.008);
  for (const z of [-0.237, 0.237]) {
    timber(body, [width - 0.052, 0.371, 0.038], [0, rim - 0.1855, z], 0.008);
  }
  for (const side of [-1, 1]) {
    const x = side * (half - 0.024);
    timber(body, [0.042, 0.371, 0.499], [x, rim - 0.1855, 0], 0.009);
    for (const z of [-0.238, 0.238]) {
      body.block("insert", [0.064, 0.371, 0.055], [x, rim - 0.1855, z], 0.008);
    }
    for (const z of [-0.056, 0.056]) {
      body.block("dark", [0.029, 0.062, 0.033], [side * (half - 0.011), 0.29, z], 0.007);
    }
    body.block("steel", [0.022, 0.019, 0.128], [side * (half + 0.005), 0.29, 0], 0.008);
  }
  body.block("dark", [0.086, 0.083, 0.033], [0, 0.385, 0.259], 0.01);
  body.block("steel", [0.034, 0.038, 0.015], [0, 0.382, 0.279], 0.005);
  const group = body.finish("trunk", palette);
  anchor(group, "trunk-content", [0, floorY, 0]);
  anchor(group, "trunk-latch", [0, 0.382, 0.287]);

  const cover = new StaticKitMesh<Finish>();
  timber(cover, [width + 0.017, 0.051, 0.521], [0, 0.0255, 0.2535], 0.016);
  for (const x of [-(half - 0.101), half - 0.101]) {
    cover.block("insert", [0.074, 0.014, 0.489], [x, 0.052, 0.2535], 0.004);
    cover.block("insert", [0.074, 0.044, 0.017], [x, 0.028, 0.512], 0.004);
    cover.add(
      "dark",
      new CylinderGeometry(0.014, 0.014, 0.083, 16).rotateZ(Math.PI / 2).translate(x, 0, -0.004),
    );
  }
  cover.block("dark", [0.075, 0.036, 0.018], [0, 0.013, 0.52], 0.007);
  const lid = cover.finish("trunk-lid", palette);
  lid.position.set(0, rim + 0.003, -0.253);
  lid.rotation.x = open ? -Math.PI * 0.56 : 0;
  group.add(lid);
  return group;
}

export function buildWorkshop(
  id: Module,
  options: Required<Pick<IBakeWorkshopOptions, "seed" | "accent" | "scale">> &
    Pick<IBakeWorkshopOptions, "width" | "height" | "open" | "seats" | "shelves">,
  veneer?: IVeneer,
): Group {
  const palette = materials(options.seed, options.accent, veneer);
  const width = options.width ?? workshopWidths[id]?.default ?? workbenchWidth.default;
  const height = options.height ?? chairHeight.default;
  const seats = options.seats ?? workshopSeatCounts[id]?.default ?? loungeSeats.default;
  const builders = {
    workbench: () => workbench(palette, width),
    stool: () => stool(palette),
    drawer: () => drawer(palette, options.open ?? false),
    shelf: () => shelf(palette, width),
    locker: () => locker(palette, options.open ?? false),
    bed: () => bed(palette),
    station: () => {
      const desk = workbench(palette, width);
      const seat = stool(palette);
      seat.position.set(...stoolBay());
      const storage = drawer(palette, false);
      storage.position.set(...drawerBay(width));
      desk.add(seat, storage);
      return desk;
    },
    sofa: () => sofa(palette, seats),
    armchair: () => sofa(palette, 1),
    "coffee-table": () => coffeeTable(palette, width),
    "media-console": () => mediaConsole(palette, options.open ?? false),
    lounge: () => lounge(palette, seats),
    "dining-table": () => diningTable(palette, width),
    "dining-chair": () => {
      const chair = diningChair(palette);
      anchor(chair, "dining-seat", [0, diningSeatHeight, 0]);
      return chair;
    },
    "dining-bench": () => diningBench(palette, width),
    "dining-set": () => diningSet(palette, width, seats),
    "kitchen-prep": () => kitchenCabinet(palette, "prep", width, options.open ?? false),
    "kitchen-sink": () => kitchenCabinet(palette, "sink", kitchenBay, options.open ?? false),
    "kitchen-cooktop": () => kitchenCabinet(palette, "cooktop", kitchenBay, options.open ?? false),
    "kitchen-run": () => kitchenRun(palette, width, options.open ?? false),
    "bath-vanity": () => bathVanity(palette, width),
    "bath-tub": () => bathTub(palette, width),
    "bath-toilet": () => bathToilet(palette, options.open ?? false),
    "office-desk": () => officeDesk(palette, width),
    "office-chair": () => officeChair(palette, height),
    "office-monitor": () => officeMonitor(palette),
    "office-set": () => officeSet(palette, width, height),
    bookcase: () => bookcase(palette, width, options.shelves ?? workshopShelfCount.default),
    wardrobe: () => wardrobe(palette, width, options.open ?? false),
    trunk: () => trunk(palette, width, options.open ?? false),
  };
  const group = builders[id]();
  group.name = `workshop-${id}`;
  group.scale.setScalar(options.scale);
  return group;
}
