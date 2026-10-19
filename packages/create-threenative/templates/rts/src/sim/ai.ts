/** Resource-constrained commanders. Only visible enemies enter tactical memory. */

import { supply } from "./economy.js";
import type { Game } from "./game.js";
import { RESOURCE_SITES, STARTS } from "./terrain.js";
import {
  type BuildingType,
  type EntityType,
  type ICommandTarget,
  type IEntity,
  type IOrderResult,
  type IPoint,
  type IResourceNode,
  type ISupply,
  TYPES,
  dist,
  seeded,
} from "./types.js";

export type CommanderState = "ESTABLISHING" | "DEFENDING" | "ATTACKING" | "REGROUPING" | "BUILDUP";

export interface ICommanderStats {
  trained: number;
  built: number;
  scouted: number;
  assaults: number;
  retreats: number;
  defenses: number;
  expansions: number;
  aircraft: number;
  garrisons: number;
}

export interface ICommanderMemory {
  id: number;
  type: EntityType;
  team: number;
  x: number;
  z: number;
  time: number;
  /** Set while the structure was seen this tick; the sweep drops everything else. */
  seen: boolean;
}

export interface IExpansion {
  x: number;
  z: number;
  workers: number[];
  started: number;
}

const PRODUCTION_RANK: Readonly<Record<string, number>> = { starport: 0, factory: 1, barracks: 2 };

/** The production buildings, by rank, counted so the per-tick query mints no mask array. */
const PRODUCES: Readonly<Record<string, boolean>> = {
  barracks: true,
  factory: true,
  starport: true,
};

/**
 * The commander's working lists, reused every tick.
 *
 * `update` runs on a 1.2 s clock, so this is not a per-frame budget — but a filter, a map and a
 * spread per list is forty-odd arrays a tick, and a tick lands inside an ordinary frame. These are
 * module-level, never handed to anything that keeps them: `game.command` copies the ids and the
 * point it is given before it returns, and every sort below orders a copy it re-reads by index.
 */
const _own: IEntity[] = [];
const _cores: IEntity[] = [];
const _workers: IEntity[] = [];
const _army: IEntity[] = [];
const _second: IEntity[] = [];
const _enemies: IEntity[] = [];
const _threat: IEntity[] = [];
const _structures: IEntity[] = [];
const _production: IEntity[] = [];
const _ids: number[] = [];
const _surviving: IEntity[] = [];
const _known: ICommanderMemory[] = [];
const _nodes: IResourceNode[] = [];
const _gasSites: IResourceNode[] = [];
const _bunkers: IEntity[] = [];
const _rangers: IEntity[] = [];
const _built: IEntity[] = [];
const _candidates: IEntity[] = [];
const _expanded: IEntity[] = [];
const _builders: IEntity[] = [];
const _searchSites = RESOURCE_SITES.slice(3);
/**
 * A one-element id list for the orders that reach a single unit. `Game.command` reads the ids and
 * copies what it needs before it returns, so one list serves every single-unit order.
 */
const _one: number[] = [0];

/** The scouting legs, module-level: the routes were two fresh arrays on every scout order. */
const SCOUT_ROUTES_1: readonly IPoint[] = [
  { x: 28, z: -42 },
  { x: 15, z: 2 },
  { x: -21, z: 31 },
  { x: -43, z: 47 },
];
const SCOUT_ROUTES_2: readonly IPoint[] = [
  { x: -52, z: -30 },
  { x: -56, z: 3 },
  { x: -46, z: 32 },
  { x: -53, z: 48 },
];

/** Fills `out` with the live own entities of `team`, in place. */
function collectOwn(game: Game, team: number, out: IEntity[]): IEntity[] {
  out.length = 0;
  const entities = game.entities;
  for (let i = 0; i < entities.length; i++) {
    const e = entities[i];
    if (e !== undefined && e.team === team && e.hp > 0) out.push(e);
  }
  return out;
}

/** Fills `out` with the mobile, ungarrisoned, non-worker entities of `team`, in place. */
function collectArmy(game: Game, team: number, out: IEntity[]): IEntity[] {
  out.length = 0;
  const entities = game.entities;
  for (let i = 0; i < entities.length; i++) {
    const e = entities[i];
    if (
      e !== undefined &&
      e.team === team &&
      e.hp > 0 &&
      !e.building &&
      e.type !== "worker" &&
      !e.garrisonId &&
      e.order.kind !== "garrison"
    ) {
      out.push(e);
    }
  }
  return out;
}

/** Counts the own entities of `type`, in place: `filter().length` was an array per question. */
function countType(game: Game, team: number, type: EntityType): number {
  let found = 0;
  const entities = game.entities;
  for (let i = 0; i < entities.length; i++) {
    const e = entities[i];
    if (e !== undefined && e.team === team && e.hp > 0 && e.type === type) found += 1;
  }
  return found;
}

export class CommanderAI {
  readonly team: number;
  private readonly rng: () => number;
  private clock: number;
  state: CommanderState = "ESTABLISHING";
  private nextAttack: number;
  private lastOrders: number;
  private lastThreat: number;
  private scoutId: number | null = null;
  private scoutLeg = 0;
  private nextScout: number;
  force: number[] = [];
  private initialForce = 0;
  /**
   * The order result this commander's own orders report into. The commander reads `ok` and `count`
   * immediately and keeps neither, so it hands `command` a record it already has rather than
   * letting each order mint one. `Game.command` still returns a fresh result to anyone who does not
   * pass one, which is every other caller in the game.
   */
  private readonly result: IOrderResult = { ok: false, count: 0 };
  /**
   * The order target the repair orders name. `command` reads the id before it returns and the record
   * is never kept, so one is enough for every structure this commander patches.
   */
  private readonly targetPoint: ICommandTarget = { id: 0 };
  target: (IPoint & { team: number }) | null = null;
  /** The commander's rally point, rewritten in place: every tick hands it out. */
  private readonly rally: IPoint = { x: 0, z: 0 };
  /** The commander's own supply answer, held across the calls that ask for it again. */
  private readonly supply: ISupply = { used: 0, cap: 0 };
  expansion: IExpansion | null = null;
  private memory = new Map<number, ICommanderMemory>();
  private airThreatUntil = 0;
  private airTechAt: number;
  private searchLeg = 0;
  readonly stats: ICommanderStats = {
    trained: 0,
    built: 0,
    scouted: 0,
    assaults: 0,
    retreats: 0,
    defenses: 0,
    expansions: 0,
    aircraft: 0,
    garrisons: 0,
  };

  constructor(team: number, seed = 1, random?: () => number) {
    this.team = team;
    this.rng = random ?? seeded(seed);
    this.clock = team * 0.27;
    this.nextAttack = team === 1 ? 90 : 115;
    this.lastOrders = -100;
    this.lastThreat = -100;
    this.nextScout = 12 + team * 5;
    this.airTechAt = team === 1 ? 100 : 78;
  }

  update(game: Game, dt: number): void {
    this.clock -= dt;
    if (this.clock > 0 || game.paused || game.result || game.players[this.team]?.eliminated) return;
    this.clock = 1.2;
    const team = this.team;
    const own = collectOwn(game, team, _own);
    const cores = _cores;
    const workers = _workers;
    const structures = _structures;
    cores.length = 0;
    workers.length = 0;
    structures.length = 0;
    let base: IEntity | undefined;
    for (let i = 0; i < own.length; i++) {
      const e = own[i];
      if (e === undefined) continue;
      if (e.building) structures.push(e);
      else if (e.type === "worker") workers.push(e);
      if (e.type === "core") {
        cores.push(e);
        if (e.built && !base) base = e;
      }
    }
    if (!base) base = cores[0];
    if (!base) return;
    let army = collectArmy(game, team, _army);
    const enemies = _enemies;
    enemies.length = 0;
    const entities = game.entities;
    for (let i = 0; i < entities.length; i++) {
      const e = entities[i];
      if (
        e !== undefined &&
        e.team !== team &&
        e.hp > 0 &&
        !e.garrisonId &&
        game.visibleAt(e.x, e.z, team)
      ) {
        enemies.push(e);
      }
    }
    let airSeen = false;
    for (let i = 0; i < enemies.length; i++) {
      if (enemies[i]?.air) airSeen = true;
    }
    if (airSeen) this.airThreatUntil = game.time + 90;
    for (let i = 0; i < enemies.length; i++) {
      const enemy = enemies[i];
      if (enemy === undefined || !enemy.building) continue;
      // Known enemy buildings are one record each, rewritten in place: `Map.set` with a fresh
      // literal allocated an object per visible structure per tick for data that had not changed.
      // A record is minted when a structure is first seen, which is an event like any other.
      const known = this.memory.get(enemy.id);
      if (known) {
        known.type = enemy.type;
        known.team = enemy.team;
        known.x = enemy.x;
        known.z = enemy.z;
        known.time = game.time;
        known.seen = true;
      } else {
        this.memory.set(enemy.id, {
          id: enemy.id,
          type: enemy.type,
          team: enemy.team,
          x: enemy.x,
          z: enemy.z,
          time: game.time,
          seen: true,
        });
      }
    }
    for (const [id, known] of this.memory) {
      if (known.seen) {
        known.seen = false;
        continue;
      }
      if (game.visibleAt(known.x, known.z, team)) this.memory.delete(id);
    }
    const rally = this.rallyPoint(base);
    const threat = _threat;
    threat.length = 0;
    for (let i = 0; i < enemies.length; i++) {
      const enemy = enemies[i];
      if (enemy === undefined) continue;
      if (!TYPES[enemy.type].damage || enemy.type === "worker") continue;
      let near = false;
      for (let c = 0; c < cores.length; c++) {
        const core = cores[c];
        if (core !== undefined && dist(core, enemy) < 34) {
          near = true;
          break;
        }
      }
      if (near) threat.push(enemy);
    }
    this.economy(game, own, cores, base, workers, army, rally, threat.length > 0);
    // Economy can reserve infantry as defenders. Never overwrite those orders.
    army = collectArmy(game, team, _army);
    if (threat.length) {
      this.lastThreat = game.time;
      if (this.state !== "DEFENDING") {
        this.stats.defenses++;
        this.lastOrders = -100;
      }
      this.state = "DEFENDING";
      if (game.time - this.lastOrders > 3.5) {
        let closest: IEntity | undefined;
        let best = Number.POSITIVE_INFINITY;
        for (let i = 0; i < threat.length; i++) {
          const e = threat[i];
          if (e === undefined) continue;
          const d = dist(e, base);
          if (d < best) {
            best = d;
            closest = e;
          }
        }
        if (closest) {
          game.command(this.ids(army, _ids), "attackMove", closest, team, false, this.result);
        }
        this.lastOrders = game.time;
      }
      return;
    }
    if (this.state === "DEFENDING" && game.time - this.lastThreat > 9) {
      this.regroup(game, army, rally);
    }
    if (this.state === "ATTACKING") {
      this.attack(game, army, rally, enemies);
      return;
    }
    if (this.state === "REGROUPING" && game.time < this.nextAttack) return;
    this.state = "BUILDUP";
    this.scout(game, army, base, rally, enemies);
    if (game.time >= this.nextAttack && army.length >= 9) {
      const preferred = team === 1 ? 0 : 1;
      let target: (typeof STARTS)[number] | undefined;
      let best = Number.POSITIVE_INFINITY;
      for (const start of STARTS) {
        if (start.team === team || game.players[start.team]?.eliminated) continue;
        const value = dist(base, start) * (start.team === preferred ? 0.65 : 1);
        if (value < best) {
          best = value;
          target = start;
        }
      }
      if (!target) return;
      const force = _second;
      force.length = 0;
      for (let i = 0; i < army.length; i++) {
        const e = army[i];
        if (e !== undefined && e.id !== this.scoutId) force.push(e);
      }
      // The scout stays home with the first of the rest: the assault never takes every unit, so
      // the base keeps a defender. Starting at 1 is the `.slice(1)` this loop replaced.
      this.force.length = 0;
      for (let i = 1; i < force.length; i++) {
        const e = force[i];
        if (e !== undefined) this.force.push(e.id);
      }
      force.length = this.force.length;
      this.initialForce = force.length;
      // The assault's target is state the commander keeps, so it gets its own object once.
      this.target = { x: target.x, z: target.z, team: target.team };
      game.command(this.force, "attackMove", this.target, team, false, this.result);
      this.state = "ATTACKING";
      this.lastOrders = game.time;
      this.nextAttack = game.time + 85;
      this.stats.assaults++;
      game.emit("assault", {
        team,
        name: game.players[team]?.name ?? "",
        count: force.length,
        targetTeam: target.team,
        x: base.x,
        z: base.z,
      });
      return;
    }
    const idle = _candidates;
    idle.length = 0;
    for (let i = 0; i < army.length; i++) {
      const e = army[i];
      if (e !== undefined && e.id !== this.scoutId && e.order.kind === "idle") idle.push(e);
    }
    if (idle.length) {
      game.command(this.ids(idle, _ids), "attackMove", rally, team, false, this.result);
    }
  }

  /** The ids of `list`, in the shared buffer: `command` copies them before it returns. */
  private ids(list: IEntity[], out: number[]): number[] {
    out.length = 0;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e !== undefined) out.push(e.id);
    }
    return out;
  }

  /** Push to the next known building, or sweep to an unexplored expansion site. */
  private attack(game: Game, army: IEntity[], rally: IPoint, enemies: IEntity[]): void {
    const target = this.target;
    if (!target) return;
    const surviving = _surviving;
    surviving.length = 0;
    for (let i = 0; i < this.force.length; i++) {
      const e = game.get(this.force[i] ?? -1);
      if (e && !e.garrisonId && e.order.kind !== "garrison") surviving.push(e);
    }
    let health = 0;
    for (let i = 0; i < surviving.length; i++) {
      const e = surviving[i];
      if (e !== undefined) health += e.hp / e.maxHp;
    }
    health /= Math.max(1, surviving.length);
    if (
      surviving.length < Math.max(3, this.initialForce * 0.45) ||
      health < 0.36 ||
      game.players[target.team]?.eliminated
    ) {
      this.regroup(game, army, rally);
      return;
    }
    if (game.time - this.lastOrders <= 16) return;
    const known = _known;
    known.length = 0;
    for (const entry of this.memory.values()) {
      if (entry.team === target.team) known.push(entry);
    }
    // Ranked in place: cores first, then the nearest. A stable selection scan over the same list,
    // because `toSorted` was a copy and the sort comparator was a closure per tick.
    let best: ICommanderMemory | undefined;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let i = 0; i < known.length; i++) {
      const entry = known[i];
      if (entry === undefined) continue;
      // The old comparator was `Number(b.core) - Number(a.core) || dist(a) - dist(b)`, sorted
      // ascending, so a core outranks anything nearer. Minimising the score has to make a core the
      // *smaller* one, or the offset ranks cores last and the army walks at the nearest shed.
      const score = (entry.type === "core" ? -1_000_000 : 0) + dist(entry, target);
      if (score < bestScore) {
        bestScore = score;
        best = entry;
      }
    }
    let goal: IPoint = best ?? target;
    if (!best) {
      let close = false;
      for (let i = 0; i < surviving.length; i++) {
        const e = surviving[i];
        if (e !== undefined && dist(e, goal) < 18) {
          close = true;
          break;
        }
      }
      let enemyBuilding = false;
      for (let i = 0; i < enemies.length; i++) {
        const e = enemies[i];
        if (e !== undefined && e.team === target.team && e.building) {
          enemyBuilding = true;
          break;
        }
      }
      if (close && !enemyBuilding) {
        const next = _searchSites[this.searchLeg++ % _searchSites.length];
        if (next) {
          goal = { x: next.baseX, z: next.baseZ };
        }
      }
    }
    game.command(this.ids(surviving, _ids), "attackMove", goal, this.team, false, this.result);
    this.lastOrders = game.time;
  }

  /** The rally point is the commander's own, rewritten in place each tick. */
  private rallyPoint(base: IEntity): IPoint {
    const d = Math.hypot(base.x, base.z) || 1;
    const rally = this.rally;
    rally.x = base.x - (base.x / d) * 18;
    rally.z = base.z - (base.z / d) * 18;
    return rally;
  }

  private regroup(game: Game, army: IEntity[], rally: IPoint): void {
    const free = _candidates;
    free.length = 0;
    for (let i = 0; i < army.length; i++) {
      const e = army[i];
      if (e !== undefined && !e.garrisonId && e.order.kind !== "garrison") free.push(e);
    }
    game.command(this.ids(free, _ids), "move", rally, this.team, false, this.result);
    this.state = "REGROUPING";
    this.nextAttack = Math.max(game.time + 30, this.nextAttack);
    this.stats.retreats++;
    this.force.length = 0;
    this.scoutId = null;
  }

  private tryBuild(
    game: Game,
    type: BuildingType,
    x: number,
    z: number,
    builderId: number | null = null,
  ): boolean {
    if (!game.canAfford(type, this.team)) return false;
    let freeWorker = false;
    const entities = game.entities;
    for (let i = 0; i < entities.length; i++) {
      const e = entities[i];
      if (
        e !== undefined &&
        e.team === this.team &&
        e.type === "worker" &&
        e.order.kind !== "construct"
      ) {
        freeWorker = true;
        break;
      }
    }
    if (!freeWorker) return false;
    const p = game.findBuildSpot(type, x, z, this.team);
    if (!p) return false;
    const result = game.build(type, p.x, p.z, this.team, builderId);
    if (result.ok) this.stats.built++;
    return result.ok;
  }

  private trainUnit(game: Game, building: IEntity | undefined, type: EntityType): boolean {
    if (!building || !game.train(building.id, type, this.team, this.result).ok) return false;
    this.stats.trained++;
    if (TYPES[type].air) this.stats.aircraft++;
    return true;
  }

  private aircraftChoice(
    own: IEntity[],
    queued: (type: EntityType) => number,
    airThreat: boolean,
  ): EntityType {
    let fighters = queued("fighter");
    let bombers = queued("bomber");
    for (let i = 0; i < own.length; i++) {
      const u = own[i];
      if (u === undefined) continue;
      if (u.type === "fighter") fighters += 1;
      else if (u.type === "bomber") bombers += 1;
    }
    const escorts = Math.max(
      this.team === 2 ? 2 : 1,
      airThreat ? 3 : 0,
      Math.ceil((bombers + 1) * (this.team === 2 ? 1.5 : 1)),
    );
    return fighters < escorts ? "fighter" : "bomber";
  }

  private economy(
    game: Game,
    own: IEntity[],
    cores: IEntity[],
    base: IEntity,
    workers: IEntity[],
    army: IEntity[],
    rally: IPoint,
    underAttack: boolean,
  ): void {
    const team = this.team;
    const bank = game.players[team]?.resources;
    if (!bank) return;
    // The commander's own supply record: `economy` reads `banks` after the calls below, and those
    // ask for supply themselves.
    const banks = this.supply;
    supply(game, team, banks);
    const structures = _structures;
    const count = (type: EntityType): number => {
      let found = 0;
      for (let i = 0; i < structures.length; i++) {
        if (structures[i]?.type === type) found += 1;
      }
      return found;
    };
    const queued = (type: EntityType): number => {
      let waiting = 0;
      for (let i = 0; i < structures.length; i++) {
        const queue = structures[i]?.queue;
        if (!queue) continue;
        for (let q = 0; q < queue.length; q++) {
          if (queue[q]?.type === type) waiting += 1;
        }
      }
      return waiting;
    };
    const anyStructure = (type: EntityType, built: boolean): boolean => {
      for (let i = 0; i < structures.length; i++) {
        const e = structures[i];
        if (e !== undefined && e.type === type && e.built === built) return true;
      }
      return false;
    };
    const airThreat = this.airThreatUntil > game.time;
    if (banks.cap - banks.used < 6 && banks.cap < 120 && !anyStructure("relay", false)) {
      this.tryBuild(game, "relay", base.x - 11, base.z + 6);
    }
    if (!count("refinery")) {
      // The nearest live gas node, selected in place: `filter().sort()[0]` copied the whole node
      // list and allocated a comparator every tick to take its first element.
      let gas: IResourceNode | undefined;
      let best = Number.POSITIVE_INFINITY;
      const nodes = game.nodes;
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (n === undefined || n.kind !== "gas" || n.amount <= 0) continue;
        const d = dist(n, base);
        if (d < best) {
          best = d;
          gas = n;
        }
      }
      if (gas) this.tryBuild(game, "refinery", gas.x, gas.z);
    }
    if (!count("barracks")) this.tryBuild(game, "barracks", base.x + 13, base.z - 3);
    if (!count("factory") && game.time > 18)
      this.tryBuild(game, "factory", base.x + 3, base.z + 12);
    // Respond only to air actually seen by this faction, not hidden entity data.
    if (airThreat && count("antiair") < 2 && bank.ore >= TYPES.antiair.ore) {
      this.tryBuild(game, "antiair", rally.x + 5, rally.z - 3);
    }
    const airTech =
      game.time > this.airTechAt && !count("starport") && anyStructure("factory", true);
    if (airTech) this.tryBuild(game, "starport", base.x - 2, base.z + 16);
    if (game.time > 75 && count("barracks") < (team === 1 ? 2 : 1) && bank.ore > 400 && !airTech) {
      this.tryBuild(game, "barracks", base.x + 19, base.z + 10);
    }
    if (game.time > 65 && !count("bunker") && bank.ore > 290 && !airTech) {
      this.tryBuild(game, "bunker", rally.x - 3, rally.z - 3);
    }
    if (game.time > 160 && !count("antiair") && bank.ore > 320) {
      this.tryBuild(game, "antiair", base.x - 10, base.z + 13);
    }
    if (underAttack && count("turret") < 2 && bank.ore > 300 && !airThreat) {
      this.tryBuild(game, "turret", rally.x, rally.z);
    }
    if (workers.length + queued("worker") < Math.min(22, 15 + 3 * (cores.length - 1))) {
      for (let i = 0; i < cores.length; i++) {
        const c = cores[i];
        if (c === undefined || !c.built || c.queue.length !== 0) continue;
        if (this.trainUnit(game, c, "worker")) break;
      }
    }
    this.assignWorkers(game, workers, structures, cores);
    this.assignGarrisons(game, structures, army, underAttack);
    let damaged: IEntity | undefined;
    for (let i = 0; i < structures.length; i++) {
      const b = structures[i];
      if (b?.built && b.hp < b.maxHp * 0.7) {
        damaged = b;
        break;
      }
    }
    if (damaged && bank.ore > 120) {
      let onRepair = false;
      for (let i = 0; i < workers.length; i++) {
        if (workers[i]?.order.kind === "repair") {
          onRepair = true;
          break;
        }
      }
      if (!onRepair) {
        let worker: IEntity | undefined;
        let best = Number.POSITIVE_INFINITY;
        for (let i = 0; i < workers.length; i++) {
          const w = workers[i];
          if (w === undefined) continue;
          if (w.order.kind !== "gather" && w.order.kind !== "idle") continue;
          const d = dist(w, damaged);
          if (d < best) {
            best = d;
            worker = w;
          }
        }
        if (worker) {
          this.targetPoint.id = damaged.id;
          _one[0] = worker.id;
          game.command(_one, "repair", this.targetPoint, team, false, this.result);
        }
      }
    }
    const reserve =
      !underAttack && game.time > 250 && cores.length < 2 && army.length >= 12 ? 430 : 0;
    this.expand(game, base, cores, workers, army, underAttack, reserve);
    // Production buildings, ranked in place by the same selection scan the sort used: a copy and
    // a comparator per tick to order at most three buildings.
    const production = _production;
    production.length = 0;
    for (let i = 0; i < structures.length; i++) {
      const b = structures[i];
      if (b?.built && PRODUCES[b.type]) production.push(b);
    }
    for (let i = 0; i < production.length; i++) {
      for (let j = i + 1; j < production.length; j++) {
        const left = production[i];
        const right = production[j];
        if (left === undefined || right === undefined) continue;
        if ((PRODUCTION_RANK[right.type] ?? 0) < (PRODUCTION_RANK[left.type] ?? 0)) {
          production[i] = right;
          production[j] = left;
        }
      }
    }
    for (const building of production) {
      building.rally = rally;
      if (building.queue.length >= 2 || army.length >= 40) continue;
      let type: EntityType = "ranger";
      if (building.type === "starport") {
        type = this.aircraftChoice(own, queued, airThreat);
      } else if (building.type === "factory") {
        let tanks = 0;
        let hovers = 0;
        let flaks = 0;
        for (let i = 0; i < army.length; i++) {
          const e = army[i];
          if (e?.type === "tank") tanks += 1;
          else if (e?.type === "hover") hovers += 1;
        }
        for (let i = 0; i < own.length; i++) {
          if (own[i]?.type === "flak") flaks += 1;
        }
        type =
          airThreat && flaks + queued("flak") < 3
            ? "flak"
            : team === 2
              ? hovers < tanks * 2 + 3
                ? "hover"
                : "tank"
              : tanks < hovers + 3
                ? "tank"
                : "hover";
      } else if (
        game.time > 75 &&
        army.length >= 7 &&
        this.countType(army, "medic") + queued("medic") < Math.ceil(army.length / 12)
      ) {
        type = "medic";
      }
      const factoryReserve = !count("factory") && game.time > 12 ? TYPES.factory.ore : 0;
      const airReserve = airTech ? TYPES.starport.ore : 0;
      const idleSkyport = building.type !== "starport" && this.hasIdle(structures, "starport");
      const aircraft = idleSkyport ? TYPES[this.aircraftChoice(own, queued, airThreat)] : null;
      const aircraftReserve = aircraft?.ore ?? 0;
      const gasReserve = Math.max(airTech ? TYPES.starport.gas : 0, aircraft?.gas ?? 0);
      const preferred: EntityType = team === 2 ? "hover" : "tank";
      const freeFactory = anyStructure("factory", true);
      let preferredCount = 0;
      let freeFactoryQueue = 0;
      for (let i = 0; i < army.length; i++) {
        if (army[i]?.type === preferred) preferredCount += 1;
      }
      for (let i = 0; i < structures.length; i++) {
        const s = structures[i];
        if (s !== undefined && s.type === "factory" && s.built && s.queue.length === 0) {
          freeFactoryQueue += 1;
        }
      }
      const vehicleReserve =
        building.type === "barracks" &&
        preferredCount < 3 &&
        freeFactory &&
        freeFactoryQueue > 0 &&
        bank.gas >= TYPES[preferred].gas
          ? TYPES[preferred].ore
          : 0;
      if (
        bank.ore >=
          TYPES[type].ore +
            Math.max(reserve, factoryReserve, vehicleReserve, airReserve, aircraftReserve) &&
        bank.gas >= TYPES[type].gas + gasReserve
      ) {
        this.trainUnit(game, building, type);
      }
    }
  }

  /** Counts `type` in `list`, in place. */
  private countType(list: IEntity[], type: EntityType): number {
    let found = 0;
    for (let i = 0; i < list.length; i++) {
      if (list[i]?.type === type) found += 1;
    }
    return found;
  }

  /** A built structure of `type` with nothing queued. */
  private hasIdle(list: IEntity[], type: EntityType): boolean {
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e !== undefined && e.type === type && e.built && e.queue.length === 0) return true;
    }
    return false;
  }

  private assignWorkers(
    game: Game,
    workers: IEntity[],
    structures: IEntity[],
    cores: IEntity[],
  ): void {
    // Gas first, then ore, both collected into the shared node list: the filter here ran once per
    // worker and the per-worker ore filter ran once per worker again.
    const gasSites = _gasSites;
    gasSites.length = 0;
    const nodes = _nodes;
    nodes.length = 0;
    const pool = game.nodes;
    const expansion = this.expansion;
    for (let i = 0; i < pool.length; i++) {
      const n = pool[i];
      if (n === undefined || n.amount <= 0) continue;
      if (n.kind === "gas") {
        for (let s = 0; s < structures.length; s++) {
          const b = structures[s];
          if (b !== undefined && b.type === "refinery" && b.built && dist(b, n) < 3) {
            gasSites.push(n);
            break;
          }
        }
        continue;
      }
      if (n.kind !== "ore") continue;
      for (let c = 0; c < cores.length; c++) {
        const core = cores[c];
        if (core?.built && dist(core, n) < 35) {
          nodes.push(n);
          break;
        }
      }
    }
    for (let i = 0; i < workers.length; i++) {
      const worker = workers[i];
      if (worker === undefined) continue;
      if (
        expansion?.workers.includes(worker.id) === true ||
        worker.order.kind === "construct" ||
        worker.order.kind === "repair"
      )
        continue;
      // Counted per worker, not hoisted: the command at the bottom of the loop puts this worker on
      // gas, so a count taken once would send every idle worker to the refinery.
      let gasWorkers = 0;
      for (let g = 0; g < workers.length; g++) {
        const w = workers[g];
        if (w?.order.kind === "gather" && game.node(w.order.id)?.kind === "gas") gasWorkers += 1;
      }
      const useGas = gasSites.length > 0 && gasWorkers < 4;
      if (
        worker.order.kind !== "idle" &&
        !(
          gasWorkers < 4 &&
          worker.order.kind === "gather" &&
          game.node(worker.order.id)?.kind === "ore" &&
          worker.id % 3 === 0
        )
      ) {
        continue;
      }
      const candidates = useGas ? gasSites : nodes;
      if (!candidates.length) continue;
      // Nearest node, with the workers already claiming it priced in: the same ranking the sort
      // produced, chosen in one pass instead of sorting a list per worker.
      let nearest: IResourceNode | undefined;
      let best = Number.POSITIVE_INFINITY;
      for (let c = 0; c < candidates.length; c++) {
        const n = candidates[c];
        if (n === undefined) continue;
        let claiming = 0;
        for (let w = 0; w < workers.length; w++) {
          const other = workers[w];
          if (
            other !== undefined &&
            (other.order.kind === "gather" ||
              other.order.kind === "repair" ||
              other.order.kind === "construct") &&
            other.order.id === n.id
          ) {
            claiming += 1;
          }
        }
        const score = dist(n, worker) + claiming * 4;
        if (score < best) {
          best = score;
          nearest = n;
        }
      }
      if (nearest) {
        this.targetPoint.id = nearest.id;
        _one[0] = worker.id;
        game.command(_one, "gather", this.targetPoint, this.team, false, this.result);
      }
    }
  }

  private assignGarrisons(
    game: Game,
    structures: IEntity[],
    army: IEntity[],
    underAttack: boolean,
  ): void {
    const bunkers = _bunkers;
    bunkers.length = 0;
    for (let i = 0; i < structures.length; i++) {
      const b = structures[i];
      if (b !== undefined && b.type === "bunker" && b.built) bunkers.push(b);
    }
    for (const bunker of bunkers) {
      let incoming = 0;
      const entities = game.entities;
      for (let i = 0; i < entities.length; i++) {
        const e = entities[i];
        if (e?.team === this.team && e.order.kind === "garrison" && e.order.id === bunker.id) {
          incoming += 1;
        }
      }
      const needed = (underAttack ? 4 : 2) - bunker.garrison.length - incoming;
      if (needed <= 0) continue;
      const units = _rangers;
      units.length = 0;
      for (let i = 0; i < army.length; i++) {
        const e = army[i];
        if (e === undefined || e.type !== "ranger" || e.order.kind === "garrison") continue;
        if (dist(e, bunker) >= 28) continue;
        if (this.state === "ATTACKING" && this.force.includes(e.id)) continue;
        units.push(e);
      }
      // The `needed` nearest rangers, picked in place instead of sorting and slicing the army.
      const taken = _built;
      taken.length = 0;
      for (let pick = 0; pick < needed && units.length > 0; pick++) {
        let bestIndex = 0;
        let best = Number.POSITIVE_INFINITY;
        for (let i = 0; i < units.length; i++) {
          const d = dist(units[i] ?? bunker, bunker);
          if (d < best) {
            best = d;
            bestIndex = i;
          }
        }
        const chosen = units[bestIndex];
        if (chosen !== undefined) taken.push(chosen);
        units.splice(bestIndex, 1);
      }
      if (
        taken.length &&
        game.command(
          this.ids(taken, _ids),
          "garrison",
          { id: bunker.id },
          this.team,
          false,
          this.result,
        ).ok
      ) {
        this.stats.garrisons += taken.length;
      }
    }
  }

  private expand(
    game: Game,
    base: IEntity,
    cores: IEntity[],
    workers: IEntity[],
    army: IEntity[],
    underAttack: boolean,
    reserve: number,
  ): void {
    if (cores.length > 1) {
      this.expansion = null;
      return;
    }
    if (underAttack || !reserve || workers.length < 10) return;
    if (!this.expansion && (game.players[this.team]?.resources.ore ?? 0) > 420) {
      // The nearest expansion site with no known enemy core on it, selected in one pass: the
      // `slice().filter().sort()` chain copied the site list, the memory list and the comparator
      // every tick to take its first element.
      let site: (typeof _searchSites)[number] | undefined;
      let best = Number.POSITIVE_INFINITY;
      for (const candidate of _searchSites) {
        let contested = false;
        for (const entry of this.memory.values()) {
          if (
            entry.type === "core" &&
            Math.hypot(entry.x - candidate.baseX, entry.z - candidate.baseZ) < 25
          ) {
            contested = true;
            break;
          }
        }
        if (contested) continue;
        const d = Math.hypot(candidate.baseX - base.x, candidate.baseZ - base.z);
        if (d < best) {
          best = d;
          site = candidate;
        }
      }
      const chosen = _expanded;
      chosen.length = 0;
      for (let i = 0; i < workers.length && chosen.length < 2; i++) {
        const w = workers[i];
        if (w === undefined) continue;
        const order = w.order;
        if (order.kind === "construct" || order.kind === "repair") continue;
        if (order.kind === "gather" && game.node(order.id)?.kind === "gas") continue;
        chosen.push(w);
      }
      if (!site || !chosen.length) return;
      // The expansion is state this commander keeps until it lands, so it gets its own records.
      const escorts = chosen.map((w) => w.id);
      this.expansion = { x: site.baseX, z: site.baseZ, workers: escorts, started: game.time };
      game.command(this.expansion.workers, "move", this.expansion, this.team, false, this.result);
    }
    const expansion = this.expansion;
    if (!expansion) return;
    const builders = _builders;
    builders.length = 0;
    for (let i = 0; i < expansion.workers.length; i++) {
      const w = game.get(expansion.workers[i] ?? -1);
      if (w && w.order.kind !== "construct") builders.push(w);
    }
    if (!builders.length || game.time - expansion.started > 100) {
      this.expansion = null;
      return;
    }
    let ready: IEntity | undefined;
    for (let i = 0; i < builders.length; i++) {
      const w = builders[i];
      if (w !== undefined && dist(w, expansion) < 11) {
        ready = w;
        break;
      }
    }
    if (
      ready &&
      game.canAfford("core", this.team) &&
      this.tryBuild(game, "core", expansion.x, expansion.z, ready.id)
    ) {
      this.stats.expansions++;
      // Do not stop the Surveyor now bound to the new core. Other escorts may mine.
      for (const worker of builders) {
        if (worker.id !== ready.id) _one[0] = worker.id;
        game.command(_one, "stop", {}, this.team, false, this.result);
      }
      this.expansion = null;
    }
  }

  private scout(
    game: Game,
    army: IEntity[],
    base: IEntity,
    rally: IPoint,
    enemies: IEntity[],
  ): void {
    if (game.time < this.nextScout) return;
    let scout = this.scoutId === null ? undefined : game.get(this.scoutId);
    if (!scout || scout.garrisonId || scout.order.kind === "garrison") {
      // A fighter, else a hover, else the last unit that can shoot: three scans of the army
      // instead of a `find`/`find`/`filter().at()` chain and the array it copied.
      let picked: IEntity | undefined;
      for (let i = 0; i < army.length; i++) {
        const e = army[i];
        if (e?.type === "fighter") {
          picked = e;
          break;
        }
      }
      if (!picked) {
        for (let i = 0; i < army.length; i++) {
          const e = army[i];
          if (e?.type === "hover") {
            picked = e;
            break;
          }
        }
      }
      if (!picked) {
        for (let i = army.length - 1; i >= 0; i--) {
          const e = army[i];
          if (e !== undefined && TYPES[e.type].damage) {
            picked = e;
            break;
          }
        }
      }
      scout = picked;
      if (!scout || army.length < 5) return;
      this.scoutId = scout.id;
    }
    let danger = false;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (
        e !== undefined &&
        game.canAttack(e, scout) &&
        dist(e, scout) < (TYPES[e.type].range ?? 0) + 5
      ) {
        danger = true;
        break;
      }
    }
    if (danger || scout.hp < scout.maxHp * 0.5) {
      _one[0] = scout.id;
      game.command(_one, "move", rally, this.team, false, this.result);
      this.scoutId = null;
      this.nextScout = game.time + 24;
      return;
    }
    if (scout.order.kind === "idle" || this.scoutLeg === 0) {
      // The scouting legs, module-level: the routes used to be a fresh pair of arrays per call.
      const routes = this.team === 1 ? SCOUT_ROUTES_1 : SCOUT_ROUTES_2;
      const point = routes[this.scoutLeg % routes.length];
      if (!point) return;
      _one[0] = scout.id;
      game.command(_one, "move", point, this.team, false, this.result);
      this.scoutLeg++;
      this.stats.scouted++;
    }
  }
}
