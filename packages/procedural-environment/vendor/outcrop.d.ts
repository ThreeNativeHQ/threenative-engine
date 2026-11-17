import type { BufferGeometry, Object3D } from "three";

/** The slice of Outcrop (rockgen.js) the bake calls; the full API is in outcrop.js. */
export interface IOutcropForm {
  readonly label: string;
  readonly size: readonly [number, number, number];
  readonly tileable?: boolean;
  readonly altitude?: number;
}
export interface IOutcropBiome {
  readonly label: string;
  readonly traits: Readonly<Record<string, number>>;
  readonly surface: Readonly<Record<string, string | number>>;
}
export interface IOutcropOptions {
  readonly form: string;
  readonly biome: string;
  readonly seed: number;
  readonly detail: number;
  readonly size?: readonly [number, number, number];
  readonly traits?: Readonly<Record<string, number>>;
  readonly surface?: Readonly<Record<string, string | number>>;
}
declare class RockGenerator {
  geometry(options: IOutcropOptions): BufferGeometry;
}
declare const Outcrop: {
  readonly RockGenerator: typeof RockGenerator;
  readonly FORMS: Readonly<Record<string, IOutcropForm>>;
  readonly BIOMES: Readonly<Record<string, IOutcropBiome>>;
  readonly DEFAULT_TRAITS: Readonly<Record<string, number>>;
  readonly DEFAULT_SURFACE: Readonly<Record<string, string | number>>;
  /** A binary glTF of every mesh under `root`: POSITION, NORMAL and COLOR_0, one `rock` material. */
  exportGLB(root: Object3D): ArrayBuffer;
};
export default Outcrop;
