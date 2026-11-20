import type { Group } from "three";

export interface IStylizedScene {
  group: Group;
  view: { pos: [number, number, number]; target: [number, number, number] };
  env: {
    skyTop: number;
    horizon: number;
    fog: [number, number, number];
    sun: { dir: [number, number, number]; color: number; intensity: number };
    hemi: { sky: number; ground: number; intensity: number };
    shadow: number;
  };
}
export const SCENES: Record<string, (options?: { seed?: number }) => IStylizedScene>;
