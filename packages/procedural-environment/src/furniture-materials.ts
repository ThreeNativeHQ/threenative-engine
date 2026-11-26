import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { loadImage } from "@napi-rs/canvas";
import sharp from "sharp";
import {
  type Group,
  type Mesh,
  type MeshStandardMaterial,
  type MeshStandardMaterialParameters,
  RepeatWrapping,
  SRGBColorSpace,
  Texture,
  Vector2,
} from "three";

export const woodFinishes = {
  "cherry-veneer": "Cherry veneer",
  "rough-wood": "Rough wood",
  solid: "Solid color",
} as const;
export type WoodFinish = keyof typeof woodFinishes;
export const defaultWoodFinish: WoodFinish = "cherry-veneer";

export interface IProceduralMaterialOverride {
  readonly color?: string;
  readonly roughness?: number;
  readonly metalness?: number;
  readonly normalStrength?: number;
  /** Encoded PNG, JPEG or WebP. Use null to clear an inherited map. */
  readonly map?: Uint8Array | null;
  /** OpenGL (+Y) tangent-space map. */
  readonly normalMap?: Uint8Array | null;
  /** Roughness is read from the green channel. */
  readonly roughnessMap?: Uint8Array | null;
  /** Metalness is read from the blue channel. */
  readonly metalnessMap?: Uint8Array | null;
}

export interface IFurnitureWoodMaps {
  readonly color: Texture;
  readonly normal: Texture;
}

async function texture(bytes: Buffer, color: boolean, name: string): Promise<Texture> {
  const map = new Texture(await loadImage(bytes));
  map.name = name;
  map.wrapS = map.wrapT = RepeatWrapping;
  if (color) map.colorSpace = SRGBColorSpace;
  return map;
}

export async function resolveWoodFinish(finish = defaultWoodFinish): Promise<{
  maps?: IFurnitureWoodMaps;
  suffix: string;
}> {
  if (typeof finish !== "string" || !Object.hasOwn(woodFinishes, finish)) {
    throw new Error(
      `Unknown woodFinish "${finish}". Choose ${Object.keys(woodFinishes).join(", ")}.`,
    );
  }
  const suffix = finish === defaultWoodFinish ? "" : `-${finish}`;
  if (finish === "solid") return { suffix };
  const file = finish.replaceAll("-", "_");
  const load = async (kind: "color" | "normal") =>
    texture(
      await readFile(new URL(`../scans/${file}-${kind}.webp`, import.meta.url)),
      kind === "color",
      `${woodFinishes[finish]} ${kind}`,
    );
  const [color, normal] = await Promise.all([load("color"), load("normal")]);
  return { maps: { color, normal }, suffix };
}

export type MaterialParams = ReadonlyMap<string, MeshStandardMaterialParameters>;
type MapKey = "map" | "normalMap" | "roughnessMap" | "metalnessMap";

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

async function customTexture(value: unknown, key: MapKey, label: string) {
  if (!(value instanceof Uint8Array) || value.length === 0 || value.length > 16 * 1024 * 1024) {
    throw new Error(`${label} requires an encoded image up to 16 MiB or null`);
  }
  const bytes = Buffer.from(value);
  try {
    const image = sharp(bytes, { limitInputPixels: 4096 * 4096 });
    const { format, pages = 1 } = await image.metadata();
    if (!["png", "jpeg", "webp"].includes(format ?? "") || pages !== 1) {
      throw new Error("Expected a single PNG, JPEG or WebP image");
    }
    const prepared = await image
      .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();
    return {
      map: await texture(prepared, key === "map", label),
      digest: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (error) {
    throw new Error(`${label} is not a supported PNG, JPEG or WebP texture`, { cause: error });
  }
}

function materialFactor(value: unknown, max: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max) {
    throw new Error(`${label} must be between 0 and ${max}`);
  }
  return value;
}

async function prepareSlot(slot: string, value: unknown) {
  if (!isRecord(value)) throw new Error(`materials.${slot} must be an object`);
  const params: MeshStandardMaterialParameters = {};
  const identity: Record<string, string | number | null> = {};
  for (const key of Object.keys(value).sort()) {
    const prop = value[key];
    const label = `materials.${slot}.${key}`;
    if (prop === undefined) continue;
    switch (key) {
      case "color":
        if (typeof prop !== "string" || !/^#[\da-f]{6}$/iu.test(prop)) {
          throw new Error(`${label} must be a six-digit hex color`);
        }
        params.color = identity.color = prop.toLowerCase();
        break;
      case "roughness":
      case "metalness":
        params[key] = identity[key] = materialFactor(prop, 1, label);
        break;
      case "normalStrength": {
        const strength = materialFactor(prop, 2, label);
        params.normalScale = new Vector2(strength, strength);
        identity[key] = strength;
        break;
      }
      case "map":
      case "normalMap":
      case "roughnessMap":
      case "metalnessMap": {
        const result = prop === null ? null : await customTexture(prop, key, label);
        params[key] = result?.map ?? null;
        identity[key] = result?.digest ?? null;
        break;
      }
      default:
        throw new Error(`Unknown material property ${label}`);
    }
  }
  return { params, identity };
}

export async function prepareMaterialOverrides(overrides?: object): Promise<{
  slots: MaterialParams;
  suffix: string;
}> {
  const slots = new Map<string, MeshStandardMaterialParameters>();
  if (overrides === undefined) return { slots, suffix: "" };
  if (!isRecord(overrides)) throw new Error("materials must be a map of material slots");
  const identity: [string, object][] = [];
  for (const slot of Object.keys(overrides).sort()) {
    const spec = overrides[slot];
    if (spec === undefined) continue;
    const prepared = await prepareSlot(slot, spec);
    if (Object.keys(prepared.identity).length === 0) continue;
    slots.set(slot, prepared.params);
    identity.push([slot, prepared.identity]);
  }
  const hash = createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 16);
  return { slots, suffix: slots.size === 0 ? "" : `-m${hash}` };
}

export function applyMaterialOverrides(
  group: Group,
  palette: Record<string, MeshStandardMaterial>,
  overrides?: MaterialParams,
): void {
  if (!overrides?.size) return;
  const used = new Set<unknown>();
  group.traverse((node) => {
    const mesh = node as Mesh;
    if (mesh.isMesh) used.add(mesh.material);
  });
  for (const [slot, props] of overrides) {
    const surface = Object.hasOwn(palette, slot) ? palette[slot] : undefined;
    if (!surface || !used.has(surface)) {
      const supported = Object.keys(palette).filter((key) => used.has(palette[key]));
      throw new Error(
        `${group.name} has no material slot "${slot}". Choose ${supported.join(", ")}.`,
      );
    }
    surface.setValues(props);
  }
}
