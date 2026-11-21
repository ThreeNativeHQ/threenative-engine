import type { Material } from "three";

export const uniforms: { uTime: { value: number } };
export const materials: Record<string, Material>;

export class RNG {
  constructor(seed?: number);
  next(): number;
  range(min: number, max: number): number;
  int(min: number, max: number): number;
  seed(): number;
}
export function noise3(x: number, y: number, z: number, seed?: number): number;
