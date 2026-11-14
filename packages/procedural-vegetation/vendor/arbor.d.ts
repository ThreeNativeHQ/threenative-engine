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
  readonly id: string;
  readonly name: string;
  readonly latin?: string;
  readonly kind: string;
  readonly bark: string;
  readonly noBark?: boolean;
}
declare const Arbor: {
  readonly PRESETS: Record<string, IArborPreset>;
  generate(preset: string | IArborPreset, opts?: { seed?: number; lod?: number }): IArborTree;
  barkTexture(id: string): IArborTexture;
  leafTexture(
    preset: string | IArborPreset,
    opts?: { size?: number; createCanvas?: (w: number, h: number) => unknown },
  ): { readonly width: number; readonly height: number; readonly data: Uint8Array };
  toGLB(
    tree: IArborTree,
    png?: { bark?: Uint8Array; barkNormal?: Uint8Array; leaf?: Uint8Array },
  ): Uint8Array;
};
export default Arbor;
