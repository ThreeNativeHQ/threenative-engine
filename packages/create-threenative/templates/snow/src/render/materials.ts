// Generated for you. This file owns every surface the snow kit draws apart from the snow itself
// (`snowSurface.ts`): change the forest, the explorer's kit or the test bodies entirely from here.
import { LineBasicMaterial, MeshStandardMaterial } from "three";
import { palette } from "./palette.js";

const matte = (color: number, roughness = 0.92, metalness = 0) =>
  new MeshStandardMaterial({ color, metalness, roughness });

export function createMaterials() {
  return {
    trunk: matte(0x5c514a, 1),
    needles: matte(palette.floor, 0.94),
    /** Snow lying on boughs and rock tops: a touch greyer than the field so it reads as separate. */
    bough: matte(0xe2edf3, 0.91),
    rock: matte(0x717d86, 0.94),
    stem: new LineBasicMaterial({ color: 0x877f70, opacity: 0.7, transparent: true }),
    ridge: new MeshStandardMaterial({ roughness: 1, vertexColors: true }),
    coat: matte(palette.accent, 0.86),
    seam: matte(0x995124, 0.98),
    pants: matte(0x35454d, 0.94),
    gaiter: matte(0x25373e, 0.9),
    boot: matte(0x66523c, 0.91),
    rubber: matte(0x25313a, 0.97),
    fur: matte(0xdad7c8, 1),
    skin: matte(0xbc947c, 0.85),
    lens: matte(0x263d47, 0.13, 0.5),
    metal: matte(0xb0b8b5, 0.34, 0.6),
    snowCap: matte(0xe9f1f5, 0.92),
    /** The ball: a slick, dark sphere, so its track reads against white powder. */
    ball: matte(0x2b4352, 0.35, 0.1),
    crate: matte(0x8a6a4a, 0.82),
    log: matte(0x6e5b48, 0.9),
  };
}

export type SnowMaterials = ReturnType<typeof createMaterials>;
