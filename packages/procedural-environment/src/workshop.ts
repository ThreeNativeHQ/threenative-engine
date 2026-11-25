import { readFile } from "node:fs/promises";
import { loadImage } from "@napi-rs/canvas";
import {
  BoxGeometry,
  Color,
  type Group,
  MeshStandardMaterial,
  Object3D,
  RepeatWrapping,
  SRGBColorSpace,
  Texture,
  Vector2,
} from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { RNG } from "../vendor/stylized-biome-kit/core.js";
import { StaticKitMesh, type XYZ } from "./static-kit-mesh.js";

export interface IBakeWorkshopOptions {
  readonly module: string;
  readonly out: string;
  /** Unsigned 32-bit seed for paint and wood tone. */
  readonly seed?: number;
  /** Six-digit CSS hex color for painted parts and bedding. */
  readonly accent?: string;
  /** Uniform scale from 0.5 to 2. Use the same scale across an arrangement. */
  readonly scale?: number;
  /** Workbench, workstation or wall shelf width in metres before scale. */
  readonly width?: number;
  /** Bake the top drawer pulled out or the locker door swung outward. Default false. */
  readonly open?: boolean;
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
] as const;

type Module = (typeof workshopModules)[number]["id"];
type Finish = "wood" | "accent" | "dark" | "linen" | "steel" | "insert";
type Palette = Record<Finish, MeshStandardMaterial>;
type Part = StaticKitMesh<Finish>;

const workbenchWidth = { min: 1.2, max: 2.4, default: 1.65 };
const shelfWidth = { min: 0.7, max: 1.8, default: 1.05 };
export const workshopWidths: Partial<Record<Module, typeof workbenchWidth>> = {
  workbench: workbenchWidth,
  station: workbenchWidth,
  shelf: shelfWidth,
};
export const workshopOpeningModules = ["drawer", "locker"];

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
  };
}

function anchor(group: Group, name: string, position: XYZ): void {
  const marker = new Object3D();
  marker.name = name;
  marker.position.set(...position);
  group.add(marker);
}

function timber(mesh: Part, size: XYZ, center: XYZ, bevel = 0.021): void {
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
    uv.setXY(i, (nx > nz && !top ? z : x) + 0.43, (top ? z : y) + 0.36);
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

export function buildWorkshop(
  id: Module,
  options: Required<Pick<IBakeWorkshopOptions, "seed" | "accent" | "scale">> &
    Pick<IBakeWorkshopOptions, "width" | "open">,
  veneer?: IVeneer,
): Group {
  const palette = materials(options.seed, options.accent, veneer);
  const width = options.width ?? workshopWidths[id]?.default ?? workbenchWidth.default;
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
  };
  const group = builders[id]();
  group.name = `workshop-${id}`;
  group.scale.setScalar(options.scale);
  return group;
}
