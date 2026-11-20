import {
  BufferAttribute,
  type BufferGeometry,
  Color,
  CylinderGeometry,
  Group,
  IcosahedronGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PointLight,
  Quaternion,
  Vector3,
} from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { RNG, noise3, uniforms } from "../../vendor/stylized-biome-kit/core.js";
import { dungeonFinish } from "./finish.js";

export type XYZ = [number, number, number];

export const THEME_NAMES = ["Ancient Ruins", "Ice Dungeon", "Lava Depths"] as const;
export const THEME_BIOMES = ["forest", "tundra", "volcanic"] as const;

const PALETTES = [
  {
    stone: 0x706b62,
    joint: 0x3e3932,
    growth: 0x575e2d,
    wood: 0x714928,
    iron: 0x44424a,
    cloth: 0x8c3025,
    fire: 0xff962c,
    pale: 0xf4ca82,
  },
  {
    stone: 0x627994,
    joint: 0x33485f,
    growth: 0x9dcfe9,
    wood: 0x53525b,
    iron: 0x556375,
    cloth: 0x344b87,
    fire: 0x51bcff,
    pale: 0xd0efff,
  },
  {
    stone: 0x514549,
    joint: 0x292125,
    growth: 0x89382b,
    wood: 0x653f31,
    iron: 0x49383d,
    cloth: 0x8e321e,
    fire: 0xff5a19,
    pale: 0xffcb61,
  },
] as const;

const solid = new MeshStandardMaterial({
  name: "Dungeon painted surfaces",
  vertexColors: true,
  roughness: 0.78,
});
const metal = new MeshStandardMaterial({
  name: "Dungeon worn metal",
  vertexColors: true,
  roughness: 0.48,
  metalness: 0.4,
});
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
dungeonFinish(solid);
dungeonFinish(metal);
const finishes = { solid, metal, glow };
export const dungeonMaterials = { dungeonSolid: solid, dungeonMetal: metal, dungeonGlow: glow };

type Finish = keyof typeof finishes;
type FireShape = [base: number, maxSway: number];

export class DungeonMesh {
  readonly rng: RNG;
  readonly palette: (typeof PALETTES)[number];
  readonly parts: Record<Finish, BufferGeometry[]> = { solid: [], metal: [], glow: [] };
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
    const geometry = shape.index ? shape.toNonIndexed() : shape;
    if (geometry !== shape) shape.dispose();
    geometry.clearGroups();
    geometry.deleteAttribute("uv");
    const positions = geometry.getAttribute("position");
    const shade = new Color(color).multiplyScalar(this.rng.range(1 - wear, 1 + wear));
    const mossColor = new Color(this.palette.growth);
    const vertex = new Color();
    const colors = new Float32Array(positions.count * 3);
    const surface = new Float32Array(positions.count * 2);
    const kind = color === this.palette.wood ? 1 : color === this.palette.cloth ? 2 : 0;
    const materialPhase = this.rng.range(-25, 25);
    const phase = this.rng.seed();
    for (let i = 0; i < positions.count; i++) {
      const x = positions.getX(i);
      const y = positions.getY(i);
      const z = positions.getZ(i);
      const grain = noise3(x * 17, y * 18, z * 19, phase);
      const lichen = noise3(x * 2.6, y * 2.8, z * 3.1, this.seed);
      vertex.copy(shade).multiplyScalar(1 + grain * wear * 1.2);
      vertex.lerp(mossColor, Math.max(0, lichen + 0.42) * moss * 0.72);
      vertex.toArray(colors, i * 3);
      surface[i * 2] = kind;
      surface[i * 2 + 1] = materialPhase;
    }
    geometry.setAttribute("color", new BufferAttribute(colors, 3));
    geometry.setAttribute("dungeonSurface", new BufferAttribute(surface, 2));
    if (finish === "glow") {
      const move = new Float32Array(positions.count * 3);
      if (fire) {
        const phase = this.rng.range(0, 2 * Math.PI);
        for (let i = 0; i < positions.count; i++) {
          move[i * 3] = fire[0];
          move[i * 3 + 1] = fire[1];
          move[i * 3 + 2] = phase;
        }
      }
      geometry.setAttribute("dungeonFlame", new BufferAttribute(move, 3));
    }
    this.parts[finish].push(geometry);
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
    for (const key of Object.keys(finishes) as Finish[]) {
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
