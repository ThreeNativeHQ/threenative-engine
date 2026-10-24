import { Color, type Material, type Texture, Vector2 } from "three";

/**
 * Material identity by content, so a streamed world can share one surface — and one shader —
 * between every asset that carries "the same" material. This module compares what a material draws
 * with; it constructs nothing and decides no appearance: the canonical surface is still the first
 * material the game's package handed over.
 */
const TEXTURE_SLOTS = [
  "map",
  "normalMap",
  "roughnessMap",
  "metalnessMap",
  "aoMap",
  "emissiveMap",
  "alphaMap",
] as const;

function textureKey(texture: Texture | null | undefined): string {
  if (texture === null || texture === undefined) return "-";
  const image = texture.image as { width?: number; height?: number } | undefined;
  const mips = (texture as { mipmaps?: readonly { data?: { byteLength?: number } }[] }).mipmaps;
  return `${texture.name}:${String(image?.width ?? 0)}x${String(image?.height ?? 0)}:${String(mips?.[0]?.data?.byteLength ?? 0)}:${texture.flipY ? 1 : 0}`;
}

/**
 * What a material draws, as a key: its class, every parameter that changes the shader or the
 * look, and each texture slot's image. Two GLBs that carry "the same" bark load two Material
 * objects with two Texture objects over the same image, and three builds a shader per material:
 * 569 material instances in one 2 km world were 36 materials, and their first-draw builds were
 * 42 % of every streaming hitch. Keyed on content, the second asset reuses the first's surface.
 * ponytail: an image is identified by name + size + first-mip bytes, which the loader keeps; a
 * content hash of the pixels is the upgrade if two different images ever collide on all three.
 */
export function materialKey(material: Material): string {
  const fields = material as Material & Record<string, unknown>;
  const num = (value: unknown): string => (typeof value === "number" ? value.toFixed(4) : "-");
  const color = (value: unknown): string => (value instanceof Color ? value.getHexString() : "-");
  const vec = (value: unknown): string =>
    value instanceof Vector2 ? `${value.x},${value.y}` : "-";
  const textures: string[] = [];
  for (const slot of TEXTURE_SLOTS) textures.push(textureKey(fields[slot] as Texture | undefined));
  return [
    material.type,
    material.transparent ? 1 : 0,
    num(material.alphaTest),
    material.alphaHash ? 1 : 0,
    material.side,
    material.vertexColors ? 1 : 0,
    num(material.opacity),
    material.depthWrite ? 1 : 0,
    color(fields.color),
    color(fields.emissive),
    num(fields.emissiveIntensity),
    num(fields.roughness),
    num(fields.metalness),
    vec(fields.normalScale),
    fields.flatShading === true ? 1 : 0,
    ...textures,
  ].join("|");
}
