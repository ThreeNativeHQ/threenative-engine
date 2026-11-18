import type { BufferGeometry, MeshStandardMaterial, Object3D, Texture } from "three";

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
  /** A lighting suggestion for viewers: skyTop, skyHorizon, ground, sun, elevation, azimuth, water. */
  readonly environment?: Readonly<Record<string, string | number | null>>;
}
export interface IOutcropOptions {
  readonly form: string;
  readonly biome: string;
  readonly seed: number;
  readonly detail: number;
  readonly size?: readonly [number, number, number];
  readonly traits?: Readonly<Record<string, number>>;
  readonly surface?: Readonly<Record<string, string | number>>;
  readonly offset?: readonly [number, number, number];
}
/** A generated map: RGBA8, row 0 at the bottom (a three DataTexture). */
export interface IOutcropMap {
  readonly image: { readonly data: Uint8Array; readonly width: number; readonly height: number };
}
declare class RockGenerator {
  geometry(options: IOutcropOptions): BufferGeometry;
  /** The shared triplanar material for a recipe (`geometry.userData.recipe`): its maps and tile. */
  materialFor(recipe: unknown): {
    readonly userData: {
      readonly uniforms: {
        readonly tRockDetail: { readonly value: IOutcropMap };
        readonly tRockNormal: { readonly value: IOutcropMap };
        readonly uTile: { readonly value: number };
      };
    };
  };
}
declare const Outcrop: {
  readonly RockGenerator: typeof RockGenerator;
  readonly FORMS: Readonly<Record<string, IOutcropForm>>;
  readonly BIOMES: Readonly<Record<string, IOutcropBiome>>;
  readonly DEFAULT_TRAITS: Readonly<Record<string, number>>;
  readonly DEFAULT_SURFACE: Readonly<Record<string, string | number>>;
  /** The page's look: three-scale triplanar maps, cover settling by height; reads aRock, aCover, aWet. */
  createRockMaterial(options: {
    textures: { detail: Texture; normal: Texture };
    tile?: number;
  }): MeshStandardMaterial;
  /** A binary glTF of every mesh under `root`: POSITION, NORMAL and COLOR_0, one `rock` material. */
  exportGLB(root: Object3D): ArrayBuffer;
};
export default Outcrop;
