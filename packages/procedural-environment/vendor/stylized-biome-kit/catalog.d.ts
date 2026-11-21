import type { Object3D } from "three";

export const BIOMES: Record<string, string>;
export interface IStylizedCatalogEntry {
  id: string;
  name: string;
  biome: string;
  fn: string;
  variants: Record<string, unknown>[];
}
export const CATALOG: IStylizedCatalogEntry[];
export function build(
  entry: IStylizedCatalogEntry,
  variant: number,
  overrides?: Record<string, unknown>,
): Object3D;
