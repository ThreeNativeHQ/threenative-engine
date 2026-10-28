const SCENE_WARNING = "TN_SCENE_WARNING";
/** three-native's bridge census: a property read again and again in one frame across JS to Wasm. */
const BRIDGE_WARNING = "TN_BRIDGE_WARNING";
const PROJECTION = "TN_RENDER_PROJECTION:";

interface IProjectionLine {
  readonly cause?: { readonly code?: string; readonly hint?: string };
  readonly projecting?: boolean;
  readonly reason?: string;
  readonly reasonCode?: string;
  readonly sourceRenderables?: number;
}

/**
 * The engine's own performance warnings, read off the console: each `TN_SCENE_WARNING` and
 * `TN_BRIDGE_WARNING` line, and each
 * `TN_RENDER_PROJECTION` line that declined to project. A run with one is not a pass.
 *
 * Two declines are not defects: `reasonCode: "disabled"` is the game's named `renderer.projection:
 * false` opt-out, and `belowMeshFloor` is the engine's own verdict that the scene has too few
 * batchable meshes for a mirror to pay (it is also the line printed at startup and on dispose).
 * A kart with 85 renderables printed it at the end of a run. A projection line that does not parse
 * fails closed, since it may be a decline.
 * Each finding is the marker text plus, for a decline, the `cause` code and its hint.
 */
export function perfWarnings(consoleLines: readonly string[]): string[] {
  const found: string[] = [];
  for (const line of consoleLines) {
    if (typeof line !== "string") continue;
    for (const marker of [SCENE_WARNING, BRIDGE_WARNING]) {
      const warning = line.indexOf(marker);
      if (warning !== -1) found.push(line.slice(warning).trim());
    }
    const at = line.indexOf(PROJECTION);
    if (at === -1) continue;
    const text = line.slice(at).trim();
    let report: IProjectionLine;
    try {
      report = JSON.parse(line.slice(at + PROJECTION.length)) as IProjectionLine;
    } catch {
      found.push(`${text} (unreadable)`);
      continue;
    }
    if (report.projecting !== false || report.reasonCode === "disabled") continue;
    if (report.reasonCode === "belowMeshFloor") continue;
    const cause = report.cause === undefined ? "" : ` [cause ${report.cause.code ?? "?"}: ${report.cause.hint ?? "no hint"}]`;
    found.push(`${text}${cause}`);
  }
  return found;
}
