import {
  BufferAttribute,
  type BufferGeometry,
  Color,
  CylinderGeometry,
  Group,
  IcosahedronGeometry,
  Mesh,
  MeshBasicMaterial,
  PointLight,
  Quaternion,
  Vector3,
} from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  RNG,
  facet,
  materials,
  noise3,
  uniforms,
  weld,
} from "../../vendor/stylized-biome-kit/core.js";

export type XYZ = [number, number, number];

export const THEME_NAMES = ["Ancient Ruins", "Ice Dungeon", "Lava Depths"] as const;
export const THEME_BIOMES = ["forest", "tundra", "volcanic"] as const;

// Kit tones (vendor/stylized-biome-kit/palettes.js): ROCK alpine, snow and a basalt take on desert.
const PALETTES = [
  {
    stone: 0xa2a8b6,
    joint: 0x6e7488,
    growth: 0x78c644,
    wood: 0x6b4433,
    iron: 0x6a5a50,
    cloth: 0xc0453a,
    fire: 0xff962c,
    pale: 0xf4ca82,
  },
  {
    stone: 0xc2d2ea,
    joint: 0x90a6d0,
    growth: 0xffffff,
    wood: 0x5a4a52,
    iron: 0x6a7fa6,
    cloth: 0x3f6fc4,
    fire: 0x51bcff,
    pale: 0xd0efff,
  },
  {
    stone: 0x7a5560,
    joint: 0x3a2f3d,
    growth: 0xe0603a,
    wood: 0x6e4a30,
    iron: 0x4d3a44,
    cloth: 0xc0452a,
    fire: 0xff5a19,
    pale: 0xffcb61,
  },
] as const;

const glow = new MeshBasicMaterial({ name: "Dungeon glow", vertexColors: true, toneMapped: false });
glow.onBeforeCompile = (shader) => {
  shader.uniforms.uDungeonTime = uniforms.uTime;
  shader.vertexShader = shader.vertexShader
    .replace(
      "#include <common>",
      `#include <common>
uniform float uDungeonTime;
attribute vec3 dungeonFlame;
varying float vFlamePhase;`,
    )
    .replace(
      "#include <begin_vertex>",
      `#include <begin_vertex>
float relativeHeight = max(0.0, position.y - dungeonFlame.x);
float sway = min(relativeHeight, dungeonFlame.y);
vFlamePhase = dungeonFlame.z;
float beat = uDungeonTime * 9.2 + vFlamePhase;
transformed.x += sway * (0.08 * sin(beat + relativeHeight * 10.2) + 0.04 * cos(beat * 1.61));
transformed.z += sway * 0.07 * sin(beat * 0.83 - relativeHeight * 4.8);
transformed.y += sway * (0.13 * cos(beat * 0.68) + 0.035 * sin(beat * 2.6));`,
    );
  shader.fragmentShader = shader.fragmentShader
    .replace(
      "#include <common>",
      "#include <common>\nuniform float uDungeonTime;\nvarying float vFlamePhase;",
    )
    .replace(
      "#include <color_fragment>",
      "#include <color_fragment>\ndiffuseColor.rgb *= 0.89 + 0.06 * sin(uDungeonTime * 9.1 + vFlamePhase) + 0.05 * cos(uDungeonTime * 13.7 - vFlamePhase);",
    );
};
/** Solid pieces share the biome kit's painted material, so the dungeon reads as the same collection. */
const finishes = { solid: materials.solid, glow };
export const dungeonMaterials = { dungeonGlow: glow };

type Finish = keyof typeof finishes | "metal";
type FireShape = [base: number, maxSway: number];

export class DungeonMesh {
  readonly rng: RNG;
  readonly palette: (typeof PALETTES)[number];
  readonly parts: Record<keyof typeof finishes, BufferGeometry[]> = { solid: [], glow: [] };
  readonly lights: PointLight[] = [];

  constructor(
    readonly seed: number,
    readonly theme: number,
  ) {
    this.rng = new RNG(seed);
    this.palette = PALETTES[theme] ?? PALETTES[0];
  }

  add(
    shape: BufferGeometry,
    color: number,
    finish: Finish = "solid",
    wear = 0.22,
    moss = 0,
    fire?: FireShape,
  ): void {
    if (finish === "glow") {
      this.addGlow(shape, color, fire);
      return;
    }
    // The kit's low-poly finish: flat facets plus an `edge` attribute for the worn-edge line.
    const soup = shape.index ? shape.toNonIndexed() : shape;
    const geometry = facet(weld(soup));
    soup.dispose();
    shape.dispose();
    const positions = geometry.getAttribute("position");
    const normals = geometry.getAttribute("normal");
    const count = positions.count;
    const shade = new Color(color).multiplyScalar(this.rng.range(1 - wear * 0.4, 1 + wear * 0.4));
    const light = shade.clone().lerp(new Color(0xffffff), 0.18);
    const dark = shade.clone().multiplyScalar(0.72);
    const growth = new Color(this.palette.growth);
    const rock = color === this.palette.stone ? 1 : color === this.palette.wood ? 0.5 : 0;
    const k = (this.rng.seed() % 97) / 9.7;
    const rim = finish === "metal" ? 0 : 0.035;
    const vertex = new Color();
    const colors = new Float32Array(count * 3);
    const surf = new Float32Array(count * 4);
    const cap = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      const x = positions.getX(i);
      const y = positions.getY(i);
      const z = positions.getZ(i);
      const ny = normals.getY(i);
      // Same recipe as the kit's shadeRock: lit tops, darker undersides, one tint per facet.
      vertex
        .copy(shade)
        .lerp(light, Math.max(0, ny) * 0.6)
        .lerp(dark, Math.max(0, -ny) * 0.5);
      const h =
        Math.sin(
          Math.round(normals.getX(i) * 40) * 12.9898 +
            Math.round(ny * 40) * 78.233 +
            Math.round(normals.getZ(i) * 40) * 37.719,
        ) * 43758.5453;
      vertex.multiplyScalar(0.96 + 0.08 * (h - Math.floor(h)));
      vertex.toArray(colors, i * 3);
      surf.set([rock, 0, k, rim], i * 4);
      const lichen = noise3(x * 2.6, y * 2.8, z * 3.1, this.seed);
      const mask = moss * Math.max(0, lichen + 0.25) * (0.4 + 0.8 * Math.max(0, ny)); // tops carry the cap
      cap.set([growth.r, growth.g, growth.b, Math.min(1, mask)], i * 4);
    }
    geometry.setAttribute("color", new BufferAttribute(colors, 3));
    geometry.setAttribute("surf", new BufferAttribute(surf, 4));
    geometry.setAttribute("cap", new BufferAttribute(cap, 4));
    this.parts.solid.push(geometry);
  }

  private addGlow(shape: BufferGeometry, color: number, fire?: FireShape): void {
    const geometry = shape.index ? shape.toNonIndexed() : shape;
    if (geometry !== shape) shape.dispose();
    geometry.clearGroups();
    geometry.deleteAttribute("uv");
    const count = geometry.getAttribute("position").count;
    const colors = new Float32Array(count * 3);
    const tint = new Color(color);
    for (let i = 0; i < count; i++) tint.toArray(colors, i * 3);
    const move = new Float32Array(count * 3);
    if (fire) {
      const phase = this.rng.range(0, 2 * Math.PI);
      for (let i = 0; i < count; i++) move.set([fire[0], fire[1], phase], i * 3);
    }
    geometry.setAttribute("color", new BufferAttribute(colors, 3));
    geometry.setAttribute("dungeonFlame", new BufferAttribute(move, 3));
    this.parts.glow.push(geometry);
  }

  block(
    center: XYZ,
    [w, h, d]: XYZ,
    color: number,
    finish: Finish = "solid",
    bevel = 0.026,
    yaw = 0,
  ): void {
    const shape = new RoundedBoxGeometry(w, h, d, 1, bevel);
    if (yaw) shape.rotateY(yaw);
    shape.translate(...center);
    this.add(shape, color, finish);
  }

  stone(center: XYZ, [w, h, d]: XYZ, moss = 0.45, bevel = 0.05, yaw = 0, pitch = 0): void {
    const shape = new RoundedBoxGeometry(w, h, d, 1, Math.min(bevel, w * 0.22, h * 0.22, d * 0.22));
    const positions = shape.getAttribute("position");
    const grit = this.rng.seed();
    for (let i = 0; i < positions.count; i++) {
      const x = positions.getX(i);
      const y = positions.getY(i);
      const z = positions.getZ(i);
      const chip = Math.max(0, noise3(x * 9, y * 12, z * 11, grit) + 0.08) * 0.13;
      positions.setXYZ(i, x * (1 - chip), y * (1 - chip), z * (1 - chip));
    }
    if (pitch) shape.rotateX(pitch);
    if (yaw) shape.rotateY(yaw);
    shape.translate(...center);
    this.add(shape, this.palette.stone, "solid", 0.31, moss);
  }

  rod(
    start: XYZ,
    end: XYZ,
    r: number,
    color: number,
    finish: Finish = "solid",
    tip = r,
    sides = 8,
    fire?: FireShape,
  ): void {
    const a = new Vector3(...start);
    const b = new Vector3(...end);
    const direction = b.clone().sub(a);
    const shape = new CylinderGeometry(tip, r, direction.length(), sides, 1);
    shape.applyQuaternion(
      new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), direction.normalize()),
    );
    shape.translate(...a.lerp(b, 0.5).toArray());
    this.add(shape, color, finish, finish === "glow" ? 0.02 : 0.13, 0, fire);
  }

  gem(center: XYZ, scale: XYZ, color: number, finish: Finish = "solid", detail = 0, yaw = 0): void {
    const shape = new IcosahedronGeometry(1, detail);
    shape
      .scale(...scale)
      .rotateY(yaw)
      .translate(...center);
    this.add(shape, color, finish, 0.16);
  }

  fireLight(position: XYZ, intensity: number): void {
    const lamp = new PointLight(this.palette.fire, intensity, Math.sqrt(intensity) * 2.05, 2);
    lamp.name = "Dungeon fire light";
    lamp.position.set(...position);
    lamp.userData.fire = { intensity, phase: this.rng.range(0, 2 * Math.PI) };
    this.lights.push(lamp);
  }

  finish(id: string): Group {
    const group = new Group();
    group.name = `dungeon-${id}`;
    for (const key of Object.keys(finishes) as (keyof typeof finishes)[]) {
      const parts = this.parts[key];
      if (!parts.length) continue;
      const merged = mergeGeometries(parts);
      if (!merged) throw new Error(`Could not merge ${id} ${key} geometry`);
      const mesh = new Mesh(merged, finishes[key]);
      mesh.name = `${group.name}:${key}`;
      mesh.castShadow = key !== "glow";
      mesh.receiveShadow = key !== "glow";
      group.add(mesh);
      for (const part of parts) part.dispose();
    }
    if (this.lights.length) group.add(...this.lights);
    return group;
  }
}

export type DungeonPart = (model: DungeonMesh) => void;
