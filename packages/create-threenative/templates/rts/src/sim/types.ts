/**
 * The rules table and the shape of everything the simulation owns: units, buildings, resource
 * nodes, banks and orders. Pure data — no renderer, no DOM, no canvas.
 */

export type UnitType =
  | "worker"
  | "ranger"
  | "tank"
  | "hover"
  | "fighter"
  | "bomber"
  | "flak"
  | "medic";

export type BuildingType =
  | "core"
  | "barracks"
  | "factory"
  | "relay"
  | "refinery"
  | "turret"
  | "starport"
  | "bunker"
  | "antiair";

export type EntityType = UnitType | BuildingType;
export type TargetMask = "ground" | "air";
export type ResourceKind = "ore" | "gas";

export interface IPoint {
  x: number;
  z: number;
}

export interface IUnitDef {
  name: string;
  role: string;
  hp: number;
  r: number;
  sight: number;
  ore: number;
  gas: number;
  time: number;
  building?: boolean;
  air?: boolean;
  altitude?: number;
  speed?: number;
  range?: number;
  damage?: number;
  airDamage?: number;
  rate?: number;
  targets?: readonly TargetMask[];
  splash?: number;
  shot?: string;
  heal?: number;
  healRange?: number;
  supply?: number;
  cap?: number;
  producer?: BuildingType;
  trains?: readonly EntityType[];
  requires?: BuildingType;
  capacity?: number;
}

export const TYPES: Record<EntityType, IUnitDef> = {
  worker: {
    name: "Surveyor",
    role: "Utility drone",
    hp: 65,
    speed: 6.1,
    range: 2.1,
    damage: 4,
    rate: 1,
    r: 0.68,
    sight: 15,
    ore: 50,
    gas: 0,
    supply: 1,
    time: 6,
    producer: "core",
  },
  ranger: {
    name: "Vanguard",
    role: "Assault infantry",
    hp: 100,
    speed: 5,
    range: 8.5,
    damage: 12,
    rate: 0.78,
    targets: ["ground", "air"],
    r: 0.66,
    sight: 17,
    ore: 75,
    gas: 0,
    supply: 1,
    time: 7,
    producer: "barracks",
  },
  tank: {
    name: "Bastion",
    role: "Siege crawler",
    hp: 320,
    speed: 3.25,
    range: 13,
    damage: 52,
    rate: 2.2,
    r: 1.22,
    sight: 19,
    ore: 160,
    gas: 60,
    supply: 3,
    time: 13,
    producer: "factory",
    splash: 2.4,
    shot: "shell",
  },
  hover: {
    name: "Spectre",
    role: "Strike skimmer",
    hp: 155,
    speed: 7.4,
    range: 9.5,
    damage: 18,
    rate: 0.72,
    r: 0.94,
    sight: 21,
    ore: 120,
    gas: 40,
    supply: 2,
    time: 10,
    producer: "factory",
  },
  core: {
    name: "Command Core",
    role: "Headquarters",
    hp: 1800,
    building: true,
    r: 4.9,
    sight: 23,
    ore: 400,
    gas: 0,
    time: 35,
    cap: 18,
    trains: ["worker"],
  },
  barracks: {
    name: "Barracks",
    role: "Infantry production",
    hp: 850,
    building: true,
    r: 3.5,
    sight: 18,
    ore: 150,
    gas: 0,
    time: 16,
    trains: ["ranger", "medic"],
  },
  factory: {
    name: "War Foundry",
    role: "Vehicle production",
    hp: 1000,
    building: true,
    r: 4,
    sight: 18,
    ore: 225,
    gas: 50,
    time: 23,
    trains: ["tank", "hover", "flak"],
  },
  relay: {
    name: "Supply Relay",
    role: "Adds 12 supply",
    hp: 420,
    building: true,
    r: 2.2,
    sight: 17,
    ore: 100,
    gas: 0,
    time: 12,
    cap: 12,
  },
  refinery: {
    name: "Extractor",
    role: "Gas harvesting site",
    hp: 600,
    building: true,
    r: 2.65,
    sight: 17,
    ore: 100,
    gas: 0,
    time: 13,
  },
  turret: {
    name: "Sentinel",
    role: "Automated defense",
    hp: 550,
    building: true,
    r: 1.9,
    sight: 18,
    range: 12,
    damage: 20,
    rate: 0.85,
    ore: 125,
    gas: 25,
    time: 14,
  },
  fighter: {
    name: "Raptor",
    role: "Air superiority fighter",
    hp: 190,
    speed: 10.5,
    range: 9.5,
    damage: 17,
    airDamage: 30,
    rate: 0.8,
    r: 1.3,
    sight: 25,
    ore: 150,
    gas: 75,
    supply: 3,
    time: 14,
    producer: "starport",
    air: true,
    altitude: 7.5,
    targets: ["air", "ground"],
    shot: "missile",
  },
  bomber: {
    name: "Aurora",
    role: "Ground-attack bomber",
    hp: 330,
    speed: 6.4,
    range: 12,
    damage: 65,
    rate: 2.5,
    r: 1.7,
    sight: 23,
    ore: 225,
    gas: 125,
    supply: 4,
    time: 20,
    producer: "starport",
    air: true,
    altitude: 9,
    targets: ["ground"],
    splash: 3.6,
    shot: "bomb",
  },
  flak: {
    name: "Warden",
    role: "Mobile anti-air missiles",
    hp: 210,
    speed: 4.7,
    range: 14,
    damage: 28,
    rate: 0.85,
    r: 1,
    sight: 21,
    ore: 120,
    gas: 50,
    supply: 2,
    time: 11,
    producer: "factory",
    targets: ["air"],
    shot: "missile",
  },
  medic: {
    name: "Mender",
    role: "Ground-unit repair support",
    hp: 105,
    speed: 5.5,
    range: 0,
    damage: 0,
    heal: 14,
    healRange: 6,
    rate: 1,
    r: 0.72,
    sight: 17,
    ore: 100,
    gas: 25,
    supply: 2,
    time: 9,
    producer: "barracks",
  },
  starport: {
    name: "Skyport",
    role: "Aircraft production · needs War Foundry",
    hp: 1100,
    building: true,
    r: 4.6,
    sight: 22,
    ore: 250,
    gas: 100,
    time: 27,
    trains: ["fighter", "bomber"],
    requires: "factory",
  },
  bunker: {
    name: "Citadel Bunker",
    role: "Garrison for 4 Vanguards",
    hp: 950,
    building: true,
    r: 3.1,
    sight: 19,
    ore: 150,
    gas: 0,
    time: 18,
    capacity: 4,
    range: 12.5,
    damage: 0,
    rate: 0.8,
    targets: ["ground", "air"],
  },
  antiair: {
    name: "Skyguard",
    role: "Long-range air defense",
    hp: 620,
    building: true,
    r: 2.1,
    sight: 23,
    ore: 150,
    gas: 40,
    time: 16,
    range: 18,
    damage: 40,
    rate: 1.1,
    targets: ["air"],
    shot: "missile",
  },
};

/** The simulation advances in whole 0.05 s ticks, the original's fixed step. */
export const SIM_STEP = 0.05;

export const COMMAND_KINDS: readonly string[] = [
  "gather",
  "attack",
  "stop",
  "hold",
  "move",
  "attackMove",
  "garrison",
  "heal",
  "follow",
  "repair",
];

export type Order =
  | { kind: "idle" }
  | { kind: "hold" }
  | { kind: "move"; x: number; z: number }
  | { kind: "attackMove"; x: number; z: number }
  | { kind: "attack"; id: number }
  | { kind: "gather"; id: number; phase: "out" | "return" }
  | { kind: "construct"; id: number }
  | { kind: "garrison"; id: number }
  | { kind: "garrisoned"; id: number }
  | { kind: "heal"; id: number }
  | { kind: "follow"; id: number }
  | { kind: "repair"; id: number };

/**
 * Standing in for "an order that carries no target": a unit hands this back when it arrives, runs
 * out of work, or loses what it was ordered to, and that happens on ordinary steps. One shared
 * record for all of them, because only `gather` orders are ever written to in place (see
 * `harvest`), and an `idle` order has nothing to write.
 */
export const IDLE_ORDER: Order = { kind: "idle" };

export interface IQueueItem {
  id: number;
  type: EntityType;
  progress: number;
}

export interface IResourceNode {
  id: number;
  kind: ResourceKind;
  x: number;
  z: number;
  r: number;
  amount: number;
  site: number;
}

export interface IObstacle {
  x: number;
  z: number;
  r: number;
  kind: string;
}

export interface IBank {
  ore: number;
  gas: number;
}

export interface IPlayer {
  team: number;
  name: string;
  resources: IBank;
  gathered: IBank;
  spent: IBank;
  eliminated: boolean;
  visible: Uint8Array;
  explored: Uint8Array;
}

export interface IInteractionGoal {
  point: IPoint | null;
  range: number;
  retryAt: number;
  revision: number;
  targetId: number;
}

/** A unit, a building or an unbuilt construction site — the same record, as in every faction. */
export interface IEntity extends IPoint {
  id: number;
  type: EntityType;
  team: number;
  air: boolean;
  altitude: number;
  garrisonId: number | null;
  garrison: number[];
  builderId: number | null;
  workPoint: IPoint;
  constructionStarted: boolean;
  createdAt: number;
  resumeOrder: Order;
  weldClock: number;
  working: boolean;
  hp: number;
  maxHp: number;
  building: boolean;
  r: number;
  built: boolean;
  progress: number;
  angle: number;
  order: Order;
  orders: Order[];
  /**
   * Every order record this entity's `order` and `orders` have ever held, kept after both drop
   * them. A group order replaces the order of every unit in the selection, so a plain literal is one
   * object per unit per order — and ordering is what an ordinary frame is full of. Each record is
   * taken from here and rewritten in place, so a unit's own current order and its own queued orders
   * never share one: `orders` may hold up to 20 of them at once, all readable at the same time.
   */
  orderPool: Order[];
  queue: IQueueItem[];
  /**
   * Every queue record this building's `queue` has ever held, kept after it drops them. The queue
   * holds up to six at once and a shift moves the rest down, so a push takes the one record no entry
   * of the queue is reading rather than the next one along.
   */
  queuePool: IQueueItem[];
  /** A bunker's own weapon profile, filled in place: `engage` holds one while it asks again. */
  profile?: IUnitDef;
  rally: IPoint | null;
  cooldown: number;
  carry: number;
  carryKind: ResourceKind | null;
  harvestTimer: number;
  path: IPoint[];
  pathClock: number;
  pathGoal: IPoint | null;
  pathEnd: IPoint | null;
  pathAdjusted: boolean;
  /** The entity's own destination scratch, so `travelEntity` mints no point per call. */
  goalPoint: IPoint;
  /** `pathGoal`'s storage and `pathEnd`'s, kept apart from `goalPoint` so a replan's copy sticks. */
  pathGoalPoint: IPoint;
  pathEndPoint: IPoint;
  /**
   * Every point `path` has ever held, kept after the path drops them. A route's length changes on
   * every replan, so an array that only grows to fit allocates a waypoint each time it gets longer.
   */
  pathPool: IPoint[];
  /** `interactionGoal`'s point, owned here because a retarget rewrites it in place. */
  interactionPoint: IPoint;
  pathRevision: number;
  moving: boolean;
  interactionGoal: IInteractionGoal;
  targetId: number | null;
  healTargetId: number | null;
  healFxClock: number;
  repairClock: number;
  flash: number;
  hitFlash: number;
  lastDamaged: number;
  exitRevision: number;
  nextExitAttempt: number;
}

export interface ISupply {
  used: number;
  cap: number;
}

/**
 * One event record. Every field the rules emit is declared, so a reused slot is a record with the
 * same shape as a fresh one and a consumer reading `event.name` gets `undefined`, not a leftover
 * from whatever the slot held before.
 */
export interface IGameEvent {
  type: string;
  time: number;
  id: number;
  unitId: number;
  workerId: number;
  builderId: number;
  targetId: number;
  team: number;
  name: string;
  count: number;
  targetTeam: number;
  x: number;
  z: number;
  y: number;
  tx: number;
  tz: number;
  ty: number;
  height: number;
  altitude: number;
  building: boolean;
  repair: boolean;
  destruction: boolean;
  unit: string;
  typeName: string;
  style: string;
  result: string;
  reason: string;
  refund: number;
}

/**
 * The fields `Game.emit` copies, in the order the rules set them. A caller-owned payload is copied
 * into the queue slot field by field, and the same list is walked backwards to clear the slot first,
 * so a record never shows a value from the event that used it. `type` and `time` are set by `emit`
 * itself and are not in this list.
 */
export const EVENT_FIELDS = [
  "id",
  "unitId",
  "workerId",
  "builderId",
  "targetId",
  "team",
  "name",
  "count",
  "targetTeam",
  "x",
  "z",
  "y",
  "tx",
  "tz",
  "ty",
  "height",
  "altitude",
  "building",
  "repair",
  "destruction",
  "unit",
  "typeName",
  "style",
  "result",
  "reason",
  "refund",
] as const satisfies readonly (keyof IGameEvent)[];

export type IResult = "victory" | "defeat" | null;

export interface ICommandTarget {
  id?: number;
  x?: number;
  z?: number;
}

export interface IOrderResult {
  ok: boolean;
  message?: string;
  id?: number;
  builderId?: number;
  count?: number;
}

export const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));

/** `sqrt` rather than `Math.hypot`: on the XZ plane the two agree to well under a micrometre, and
 *  `hypot` hands back a fresh boxed double on every call — which is the hottest path in the match. */
export const dist = (a: IPoint, b: IPoint): number => planeDistance(a.x, a.z, b.x, b.z);

/** The same distance from four numbers, for the callers that hold coordinates and not a point. */
export const planeDistance = (ax: number, az: number, bx: number, bz: number): number => {
  const dx = ax - bx;
  const dz = az - bz;
  return Math.sqrt(dx * dx + dz * dz);
};

/** mulberry32: the world's one seeded stream. Injected as `() => number` so a match is replayable. */
export function seeded(seed = 17): () => number {
  let s = seed;
  return () => {
    s |= 0;
    // eslint-disable-next-line no-restricted-syntax -- Replays depend on this exact mulberry32 stream; the engine's seeded RNG is an LCG, so swapping it changes every recorded match.
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Spreads `n` points in a grid centred on the order's click, so a group arrives without stacking.
 *
 * `into` is the caller's retained point array, grown here to fit: a group order runs for every unit
 * in the selection, and `out.push({...})` was one array plus one object per unit per order. Nothing
 * keeps a formation point — `Game.command` reads each one's two numbers and copies them into the
 * order — so one store per call site is enough, and the store outlives the order that filled it.
 * Only the first `n` entries are written or read, so the store is free to stay at its longest.
 */
export function formation(
  n: number,
  x: number,
  z: number,
  spacing = 1.9,
  into: IPoint[] = [],
): IPoint[] {
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  for (let i = 0; i < n; i++) {
    const count = Math.min(cols, n - Math.floor(i / cols) * cols);
    let point = into[i];
    if (point === undefined) {
      point = { x: 0, z: 0 };
      into[i] = point;
    }
    point.x = x + ((i % cols) - (count - 1) / 2) * spacing;
    point.z = z + (Math.floor(i / cols) - (rows - 1) / 2) * spacing;
  }
  // The store keeps its longest length rather than shrinking to this order's: a group order for
  // twenty units followed by one for eight used to leave eight points, so the next twenty re-minted
  // twelve of them, and a group order is ordinary play. The caller reads only the `n` it asked for,
  // which is what `n` is for.
  if (into.length < n) into.length = n;
  return into;
}
