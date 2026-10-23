import { ACESFilmicToneMapping, AgXToneMapping, NeutralToneMapping, NoToneMapping } from "three";
import { installFilmicToneMapping } from "./filmic-tone-mapping.js";

/** `filmic` is a fresh Unreal 5.8.3 project's curve and the default; the rest are the named overrides. */
export type RendererToneMapping = "filmic" | "aces" | "agx" | "neutral" | "none";

const THREE_MODE: Record<Exclude<RendererToneMapping, "filmic">, number> = {
  aces: ACESFilmicToneMapping,
  agx: AgXToneMapping,
  neutral: NeutralToneMapping,
  none: NoToneMapping,
};

/**
 * Puts `mode` on a WebGPU renderer. `filmic` registers Unreal's curve as three's custom tone
 * mapping; a renderer without a node library cannot run it, keeps ACES and says so
 * (`TN_TONEMAP`). An unknown mode throws rather than quietly becoming the default.
 */
export function applyRendererToneMapping(
  raw: unknown,
  mode: RendererToneMapping,
  report: (line: string) => void,
): number {
  const target = raw as { toneMapping?: number };
  if (mode !== "filmic") {
    const three = THREE_MODE[mode];
    if (three === undefined)
      throw new Error(
        `Unknown toneMapping '${String(mode)}'. Use one of: filmic, ${Object.keys(THREE_MODE).join(", ")}.`,
      );
    target.toneMapping = three;
    return three;
  }
  const installed = installFilmicToneMapping(raw);
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
