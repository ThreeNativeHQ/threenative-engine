// The state of the climber, and the few helpers every movement module shares. No engine imports:
// the whole simulation is plain numbers so it runs the same on every target and under any test.
import { ceilingAt, floorAt, SOLID, waterAt } from "../level.js";
import {
  ANGLE,
  BODY_HEIGHT,
  BODY_RADIUS,
  LEAN_CAP,
  LEAN_RATE,
  SECTOR,
  TURN_INCREMENT,
  TURN_UNDO,
} from "../tuning.js";

export type LaraState =
  | "idle"
  | "walk"
  | "run"
  | "back"
  | "compress"
  | "jump"
  | "fall"
  | "hang"
  | "shimmy"
  | "climb"
  | "pickup"
  | "surface"
  | "swim"
  | "glide"
  | "tread"
  | "dead";

/** What the player holds this update. Edges are latched by the caller until an update consumes them. */
export interface IInput {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  /** Walk key: slow, and it never steps off an edge. */
  walk: boolean;
  /** Action key: held to grab a ledge or to take an item. */
  action: boolean;
  jump: boolean;
  jumpEdge: boolean;
}

/** A hang, or a climb that follows one: the wall she faces and the ledge top. */
export interface IHang {
  /** Cardinal facing, 0..3: +z, +x, -z, -x. */
  dir: number;
  /** Ledge top, units. */
  top: number;
  /** Where a climb started, so the pull-up can blend from there to the top. */
  fromX: number;
  fromZ: number;
  fromY: number;
}

export interface IBody {
  state: LaraState;
  x: number;
  z: number;
  /** Feet height on land and in the air; body centre height while swimming. */
  y: number;
  yaw: number;
  pitch: number;
  /** Signed turn rate in angle units per update, and the lean it mirrors into. */
  turn: number;
  lean: number;
  /** Forward ground or air speed, units per update (signed: negative is backwards). */
  speed: number;
  /** Vertical speed, units per update, positive downward. */
  vy: number;
  /** Swim speed in the card's own "fall speed" units. */
  swimSpeed: number;
  health: number;
  air: number;
  /** A state's own countdown, in updates. */
  timer: number;
  /** Updates the dive key has been held at the surface. */
  dive: number;
  hang: IHang | undefined;
  /** Why she died: "", "fall", "drown", "blade". */
  cause: string;
  /** Updates of blade invulnerability left. */
  invulnerable: number;
  /** Set for one update when something worth a message happened. */
  note: string;
  relic: boolean;
  /** Pickup bookkeeping: the phase and the target. */
  pickup: "" | "walk" | "grab";
  /** The last landing: the vertical speed she arrived with and the health it cost. */
  landingSpeed: number;
  fallDamage: number;
}

export function createBody(x: number, z: number, y: number, yaw: number): IBody {
  return {
    state: "idle",
    x,
    z,
    y,
    yaw,
    pitch: 0,
    turn: 0,
    lean: 0,
    speed: 0,
    vy: 0,
    swimSpeed: 0,
    health: 1000,
    air: 1800,
    timer: 0,
    dive: 0,
    hang: undefined,
    cause: "",
    invulnerable: 0,
    note: "",
    relic: false,
    pickup: "",
    landingSpeed: 0,
    fallDamage: 0,
  };
}

/** The unit vector of a facing in the (x, z) plane: yaw 0 faces +z. */
export function forward(yaw: number): { x: number; z: number } {
  return { x: Math.sin(yaw), z: Math.cos(yaw) };
}

/** Right-hand vector of a yaw (facing north, right is east). */
export function rightOf(yaw: number): { x: number; z: number } {
  return { x: -Math.cos(yaw), z: Math.sin(yaw) };
}

/** The cardinal direction, 0..3, nearest a yaw, and how far the yaw is from it. */
export function nearestCardinal(yaw: number): { dir: number; off: number } {
  const quarter = Math.PI / 2;
  const turns = Math.round(yaw / quarter);
  return { dir: ((turns % 4) + 4) % 4, off: Math.abs(yaw - turns * quarter) };
}

/** Unit vector of a cardinal: 0 +z, 1 +x, 2 -z, 3 -x. */
export function cardinal(dir: number): { x: number; z: number } {
  const unit = forward((dir * Math.PI) / 2);
  // Exact -1, 0 and 1: a stray 1e-16 would turn a north wall into an east one.
  return { x: Math.round(unit.x), z: Math.round(unit.z) };
}

export function addTurn(body: IBody, left: boolean, right: boolean, cap: number): void {
  // Left is the negative rate. A held direction builds the rate by the increment and clamps it at
  // the cap; letting go decays it by the undo amount (run-steering card, land.c:216, :115).
  if (left && !right) body.turn = Math.max(body.turn - TURN_INCREMENT, -cap);
  else if (right && !left) body.turn = Math.min(body.turn + TURN_INCREMENT, cap);
  else body.turn = Math.sign(body.turn) * Math.max(0, Math.abs(body.turn) - TURN_UNDO);
  // The same turn mirrors into a sideways lean, clamped on its own (card: leanRate, leanCap).
  if (body.turn === 0)
    body.lean = Math.sign(body.lean) * Math.max(0, Math.abs(body.lean) - LEAN_RATE);
  else
    body.lean = Math.max(
      -LEAN_CAP,
      Math.min(LEAN_CAP, body.lean + Math.sign(body.turn) * LEAN_RATE),
    );
  // The rate is added to the yaw once per update. A right turn lowers the yaw: yaw 0 faces +z,
  // and the right hand of a north facing (yaw pi) is east (yaw pi/2).
  body.yaw -= body.turn * ANGLE;
}

/** True when her body fits at a point with its feet at `feet`: a step at most, headroom enough. */
export function passable(x: number, z: number, feet: number, step: number): boolean {
  const floor = floorAt(x, z);
  if (floor >= SOLID || floor - feet > step) return false;
  return ceilingAt(x, z) - Math.max(floor, feet) >= BODY_HEIGHT;
}

/** The cell index of a coordinate, and the boundary a cardinal step crosses. */
export function cellOf(value: number): number {
  return Math.floor(value / SECTOR);
}

export function waterDepthAt(x: number, z: number): number {
  const plane = waterAt(x, z);
  return plane === undefined ? 0 : plane - floorAt(x, z);
}

export { BODY_RADIUS };
