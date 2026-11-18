export interface IArborPart {
  readonly position: Float32Array;
  readonly normal: Float32Array;
  readonly uv: Float32Array;
  readonly color: Float32Array;
  readonly wind: Float32Array;
  readonly index: Uint32Array;
}
export interface IArborTree {
  readonly preset: { readonly id: string; readonly name: string; readonly bark: string };
  readonly bark: IArborPart;
  readonly leaves: IArborPart;
  readonly bounds: {
    readonly min: [number, number, number];
    readonly max: [number, number, number];
  };
  readonly triangles: number;
}
export interface IArborTexture {
  readonly width: number;
  readonly height: number;
  readonly color: Uint8Array;
  readonly normal: Uint8Array;
}
export interface IArborPreset {
  readonly [key: string]: unknown;
  readonly id: string;
  readonly name: string;
  readonly latin?: string;
  readonly kind: string;
  readonly bark: string;
  readonly noBark?: boolean;
  readonly tex?: {
    readonly grid: readonly [number, number];
    readonly cells?: readonly Record<string, unknown>[];
  };
  readonly leaves?: readonly {
    readonly [key: string]: unknown;
    readonly cells?: readonly number[];
  }[];
  readonly levels?: readonly Record<string, unknown>[];
}
/** Arbor's random stream: `R()` is 0 to 1, `R.range(a, b)` a to b. */
export interface IArborRandom {
  (): number;
  range(a: number, b: number): number;
}
/** A painter that draws a leaf or a whole atlas cell itself, or returns false to keep Arbor's. */
export interface IArborLeafHook {
  leaf?(
    ctx: unknown,
    cell: Record<string, unknown>,
    R: IArborRandom,
    x: number,
    y: number,
    angle: number,
    length: number,
  ): boolean;
  cell?(ctx: unknown, cell: Record<string, unknown>, R: IArborRandom, aspect: number): boolean;
}
declare const Arbor: {
  readonly PRESETS: Record<string, IArborPreset>;
  generate(preset: string | IArborPreset, opts?: { seed?: number; lod?: number }): IArborTree;
  barkTexture(id: string): IArborTexture;
  leafTexture(
    preset: string | IArborPreset,
    opts?: {
      size?: number;
      createCanvas?: (w: number, h: number) => unknown;
      hook?: IArborLeafHook;
    },
  ): { readonly width: number; readonly height: number; readonly data: Uint8Array };
  toGLB(
    tree: IArborTree,
    png?: { bark?: Uint8Array; barkNormal?: Uint8Array; leaf?: Uint8Array },
  ): Uint8Array;
};
export default Arbor;
