/** A GeoBuilder's vertex arrays: position, normal, colour (linear RGB), uv and sway per vertex. */
export interface IForestKitMesh {
  readonly pos: number[];
  readonly nor: number[];
  readonly col: number[];
  readonly uv: number[];
  readonly wind: number[];
  readonly idx: number[];
}

export interface IForestKitPreset {
  readonly name: string;
  /** `debris` is wood and stone on the floor, `cover` is a plant. */
  readonly kind: "debris" | "cover";
  /** The GLB primitive: `bark` is opaque, `leaves` is alpha-masked and double-sided. */
  readonly part: "bark" | "leaves";
  generate(options: { seed: number; lod: number }): IForestKitMesh;
}

declare const ForestKit: {
  readonly PRESETS: Record<string, IForestKitPreset>;
};
export default ForestKit;
