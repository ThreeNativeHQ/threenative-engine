import { ACESFilmicToneMapping, AgXToneMapping, NeutralToneMapping, NoToneMapping } from "three";
import {
  COLOR_GRADE,
  FILMIC_CURVE,
  type IColorGrade,
  type IFilmicCurve,
  installFilmicToneMapping,
} from "./filmic-tone-mapping.js";

/** `filmic` is a fresh Unreal 5.8.3 project's curve and the default; the rest are the named overrides. */
export type RendererToneMapping = "filmic" | "aces" | "agx" | "neutral" | "none";

/** The named overrides, in the order an error message lists them. `filmic` is handled apart. */
const THREE_MODE: Record<Exclude<RendererToneMapping, "filmic">, number> = {
  aces: ACESFilmicToneMapping,
  agx: AgXToneMapping,
  neutral: NeutralToneMapping,
  none: NoToneMapping,
};

/** One list of tone curves, so a caller's validation cannot disagree with what is installed. */
export const RENDERER_TONE_MAPPINGS: readonly RendererToneMapping[] = [
  "filmic",
  ...(Object.keys(THREE_MODE) as (keyof typeof THREE_MODE)[]),
];

export function isRendererToneMapping(value: unknown): value is RendererToneMapping {
  return RENDERER_TONE_MAPPINGS.includes(value as RendererToneMapping);
}

/**
 * The game's own curve and grade, for the one mode that reads them. A game that supplies neither
 * gets Unreal's defaults, which is what a fresh project ships.
 */
export interface IFilmicToneMappingOptions {
  readonly curve?: Partial<IFilmicCurve>;
  readonly grade?: IColorGrade;
}

/**
 * Puts `mode` on a WebGPU renderer. `filmic` registers Unreal's curve as three's custom tone
 * mapping; a renderer without a node library cannot run it, keeps ACES and says so (`TN_TONEMAP`).
 * An unknown mode throws rather than quietly becoming the default.
 *
 * Inside the framework this is the only writer of `renderer.toneMapping`: the renderer's own default
 * and `WorldEnvironment` both call it, so a scene cannot pick a curve its renderer disagrees with.
 * The Unreal-look capture harness under `scripts/unreal-look/scaffold/` keeps its own copy because
 * it is a generated arm of that experiment, not framework code.
 */
export function applyRendererToneMapping(
  raw: unknown,
  mode: RendererToneMapping,
  report: (line: string) => void,
  filmic: IFilmicToneMappingOptions = {},
): number {
  const target = raw as { toneMapping?: number };
  if (mode !== "filmic") {
    const three = THREE_MODE[mode];
    if (three === undefined)
      throw new Error(
        `Unknown toneMapping '${String(mode)}'. Use one of: ${RENDERER_TONE_MAPPINGS.join(", ")}.`,
      );
    target.toneMapping = three;
    return three;
  }
  const installed = installFilmicToneMapping(
    raw,
    { ...FILMIC_CURVE, ...filmic.curve },
    filmic.grade ?? COLOR_GRADE,
  );
  if (installed !== undefined) {
    target.toneMapping = installed;
    return installed;
  }
  report(
    `TN_TONEMAP ${JSON.stringify({ requested: "filmic", applied: "aces", reason: "renderer:no-node-library" })}`,
  );
  target.toneMapping = ACESFilmicToneMapping;
  return ACESFilmicToneMapping;
}
