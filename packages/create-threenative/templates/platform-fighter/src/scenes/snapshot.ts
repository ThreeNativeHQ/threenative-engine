import { STEP, shieldScale } from "../sim/constants.js";
import type { Match } from "../sim/match.js";
import type { IFighter } from "../sim/types.js";
import type { FighterState, GameState } from "../state.js";

export const round = (value: number, scale = 100): number => Math.round(value * scale) / scale;

export function fighterState(f: IFighter, match: Match): FighterState {
  const stats = match.stats[f.id];
  return {
    ...stats,
    charge: f.attack?.charge ?? 0,
    fastFalling: f.fastFalling ? 1 : 0,
    grounded: f.floor === undefined ? 0 : 1,
    intangible: f.invuln > 0 ? 1 : 0,
    jumps: f.jumps,
    ledge: f.ledge,
    mode: f.mode,
    peakY: round(f.peakY),
    percent: round(f.percent, 10),
    phase: f.mode === "attack" ? (f.attack?.phase ?? "") : "",
    shield: round(f.shield, 10),
    shieldSize: round(shieldScale(f.shield)),
    stocks: f.stocks,
    vx: round(f.vx),
    vy: round(f.vy),
    weight: f.weight,
    x: round(f.x),
    y: round(f.y),
  };
}

/** The published state of a whole match: what the HUD draws and the playtests read. */
export function matchState(
  match: Match,
  extra: { camera: GameState["camera"]; cpuDummy: boolean; message: string },
): Omit<GameState, "paused" | "uiReady"> {
  return {
    camera: extra.camera,
    cpu: fighterState(match.fighters.cpu, match),
    cpuDummy: extra.cpuDummy ? 1 : 0,
    last: {
      ...match.last,
      damage: round(match.last.damage),
      knockback: round(match.last.knockback, 10),
      percentAfter: round(match.last.percentAfter, 10),
    },
    message: extra.message,
    p1: fighterState(match.fighters.p1, match),
    phase: match.winner === undefined ? "playing" : match.winner === "p1" ? "won" : "lost",
    time: round(match.frame * STEP, 10),
  };
}
